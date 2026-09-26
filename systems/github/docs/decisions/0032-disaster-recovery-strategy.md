---
status: accepted
date: 2026-09-26
---

# ADR-0032: 災害復旧は、AZ を 3 つの複製で、リージョンを大阪の S3 へのバックアップと Aurora Global Database で守る

## Context

非機能要件は次のとおり。

- NFR-008（AZ の障害）：RPO 0、RTO 5 分
- NFR-009（リージョンの障害）：RPO 15 分、RTO 4 時間（S1）

守るべきデータは 2 種類ある。

- Git のリポジトリ（正本は Git。[ADR-0005](0005-git-as-source-of-truth.md)）。S1 で論理量 30 TB。
- メタデータ（正本は Aurora）。

Slack は、DB を Aurora Global Database（大阪は headless）で複製し、アプリは切り替えのときに Terraform で作るパイロットライトにした（[Slack の infrastructure.md](../../../slack/docs/architecture/infrastructure.md) の 5.2 節）。GitHub では、Git のリポジトリをどう大阪へ持つかが加わる。

AWS の仕様で確かめたこと：

- S3 Replication Time Control は、大半のオブジェクトを数秒で、99.9% を 15 分以内に複製する（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)）。
- S3 は、3 つ以上の AZ に保存し、耐久性の設計値は 99.999999999%（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonS3/latest/userguide/DataDurability.html)）。
- Aurora Global Database の性質（複製の遅延は通常 1 秒未満、headless の二次クラスタ）は、Slack で確かめたもの（[Slack の infrastructure.md](../../../slack/docs/architecture/infrastructure.md) の 5.2 節）。

## Options

リージョンの障害への Git の備え：

1. **大阪の S3 へ、リポジトリごとの差分のバックアップを直接書く。** 切り替えのときに、優先度の順に復元する
2. **大阪に、ストレージのノードを常に置き、全リポジトリの非同期の複製（4 つ目）を持つ**
3. **東京の S3 にバックアップを書き、大阪へ S3 のレプリケーションで送る**

## Decision

AZ の障害は、[ADR-0003](0003-replicated-git-storage.md) の 3 つの複製（AZ ごとに 1 つ）と Aurora のマルチ AZ で守る。push は 2 つの合意で成功を返すので、1 つの AZ を失っても、成功を返した push は失われず、読み書きが続く（RPO 0）。

リージョンの障害は、S1 では 1 を採用する。

- **Git のバックアップ。** push の Event を受けた Worker が、リポジトリごとに最大 5 分まとめて、差分の `git bundle` と ref の一覧を大阪のバケットに書く。目標の遅れは p99 10 分、12 分でアラート。定期的に完全なバンドルを作り直す。詳細は [infrastructure.md](../architecture/infrastructure.md) の 5.1 節。
- **DB。** Aurora Global Database（大阪は headless）。Slack と同じ。
- **切り替え。** 大阪に、ストレージのノード、Git フロントエンド、Web・API、Worker を Terraform で作り、Git をバックアップから復元する。
- **RTO 4 時間の範囲を、次のように定める。**
  - 4 時間以内：Web・API・DB と、直近 7 日に push か fetch のあったリポジトリ（約 20%）の読み書き。
  - 24 時間以内：残りのリポジトリ。アクセスされたものから先に戻し、それまでは「復元中」を返す。
  - 落とすもの：Actions（東京の回復を待つか、別の計画作業で大阪に作る）、コード検索（作り直す）。
  - **この範囲で NFR-009 を満たすとみなしてよいかは、PM の確認が要る。** 認められなければ、S1 から 2 を採る（大阪にストレージのノードを 14 台前後常に置くので、月に数万ドル増える。[infrastructure.md](../architecture/infrastructure.md) の 9 節）。
    - 2026-09-26 に、この範囲を NFR-009 の定義とすることを既定案として決めた（[architecture/README.md](../architecture/README.md) の 3 節・6 節）。
- **DB と Git の食い違い。** 切り替えの後、DB（RPO 1 秒未満）が Git（RPO 最大 15 分）にないコミットを指しうる。Git を正として DB の写しを作り直し（ADR-0005）、push の Event の記録から失った push を列挙して、利用者に再 push を頼む。
- 2 は、RTO を短くできるが、S1 で大阪に 14 台前後のストレージのノードを常に置くことになる。S2 で、活発なリポジトリだけを対象に採る（[infrastructure.md](../architecture/infrastructure.md) の 5.2 節）。
- 3 は、レプリケーションの遅れ（99.9% を 15 分以内）に、バックアップの遅れが加わり、RPO 15 分を守れない。大阪に直接書けば、遅れはバックアップの Worker だけになる。

大阪で `i8g` が使えるかは **未検証**。使えなければ、`i7i`・`i4i`、または EBS（gp3）を付けた汎用のインスタンスで復元する（[ADR-0031](0031-storage-nodes-on-instance-store.md) の選択肢 2）。Terraform のモジュールは、両方の構成を変数で選べるようにする。

## Consequences

- 良くなること：
  - 平常時の大阪の費用は、S3 の保存（約 45 TB）と Aurora の二次クラスタのストレージだけで済む。
  - バックアップは、ソフトウェアの誤りで 3 つの複製がそろって壊れたときの最後の砦にもなる。
- 引き受けるコスト：
  - リージョンの障害では、最大 15 分の push を失いうる。NFR-002（成功を返した push は失われない）は、リージョンの障害では守れない。この例外を、利用規約と SLA の文面に反映する（PM）。
  - 全リポジトリの復元に 24 時間かかる見込み。多くの利用者にとって、半日以上使えないリポジトリが出る。
  - 東京から大阪への書き込みの転送の費用がかかる（量は push の差分なので小さい）。

## Confirmation

- 毎日：無作為の 1,000 リポジトリを、prod の隔離した環境へバックアップから復元し、ref の一覧とチェックサムが本番と一致する。
- バックアップの遅れ（p99）を SLI として監視する（[observability.md](../architecture/observability.md) の 5.1 節）。
- 四半期：staging で、全体（staging の規模）の大阪への切り替えを行い、7 日のアクティブなリポジトリが 4 時間以内に戻ることを計測する。結果を [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の記録に残す。
- 年 1 回：prod のバックアップから、大阪に S1 の 20% 相当を復元し、復元の速さ（[capacity.md](../architecture/capacity.md) の 2.8 節）を計測する。

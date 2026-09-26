---
status: accepted
date: 2026-09-26
---

# ADR-0029: 災害復旧は、物理クラスタごとの Aurora Global Database と大阪のパイロットライトで行う

## Context

非機能要件は次の 2 つである（[architecture/README.md](../architecture/README.md) の 3 節）。

- NFR-008（AZ の障害）：RPO 0、RTO 5 分以内
- NFR-009（リージョンの障害）：RPO 15 分以内、RTO 4 時間以内

Slack の設計は、同じ目標に対し、東京を主、大阪を災害復旧の先にし、S1 から Aurora Global Database（大阪の二次はインスタンスを持たない headless）を使うと決めた（Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) の 5 節）。Notion では、物理クラスタが段階ごとに増え（[ADR-0028](0028-zero-downtime-resharding.md)）、クライアントにオフラインの待ち行列がある点が違う。

## Options

1. **物理クラスタごとに Aurora Global Database を持ち、大阪の二次は S1・S2 で headless にする（パイロットライト）**
2. 大阪へのスナップショットのコピーだけで復旧する（バックアップと復元）
3. 大阪にも常時アプリを動かす（ウォームスタンバイ）

## Decision

1 を採用する。

- **AZ の障害（NFR-008）** は、Aurora のクラスタの中のフェイルオーバーで満たす。ストレージは 3 AZ に複製され、コミット済みのデータは失わない。writer と別の AZ に reader を常に置く。
- **リージョンの障害（NFR-009）** は、Global Database の二次を昇格して満たす。
  - Global Database の RPO は通常、秒の単位である。計画外のフェイルオーバーでは、その時点の複製の遅延ぶんを失いうる。計画的な切り替え（switchover）なら RPO 0（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)）。
  - headless の二次へ切り替える前に、インスタンスを足す必要がある（同上）。
  - 2 リージョンの構成では、AWS は `rds.global_db_rpo` を二次の側で既定値のままにすることを勧めている（同上）。S1〜S2 では設定せず、`AuroraGlobalDBRPOLag` を監視して、15 分に近づく前に呼び出す。
- **すべての物理クラスタ（`global` を含む）** に二次を付ける。再シャーディングで作るクラスタも、切り替えの前に二次を付ける（[ADR-0028](0028-zero-downtime-resharding.md) の段 0）。
- **複数のクラスタの時点はそろわない。** クラスタごとに複製の遅延が違うので、昇格した後のクラスタどうしの時点はずれる。1 つのトランザクションは 1 つのシャードで閉じ（[ADR-0003](0003-workspace-sharding.md)）、ワークスペースをまたぐ処理は非同期のジョブなので、シャードどうしのずれはジョブの再実行で補う。`global` とシャードのずれ（新しいワークスペースの作成など）は、復旧後の突合で直す（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）。
- **クライアントの待ち行列が、失ったデータの一部を補う。** クライアントは、サーバーが確定したと返すまで、トランザクションをローカルに持つ（[ADR-0005](0005-transactions-as-unit-of-change.md)）。確定を受け取った後に失われたものは戻らない。確定済みのトランザクションをクライアントが一定期間保持し、切り替え後にサーバーの `seq` と比べて再送できるかは、[collaboration.md](../architecture/collaboration.md) で決める。
- 2 は、スナップショットのコピーの頻度の下限のため、RPO 15 分を守れない（Slack と同じ判断）。
- 3 は、S3 で検討する。利用者の近くのリージョンでも動かす構成（[infrastructure.md](../architecture/infrastructure.md) の 11 節）とあわせて決める。

### 段階ごと

| 段階 | 戦略 | 大阪に常にあるもの |
| --- | --- | --- |
| S1 | パイロットライト | Global Database の二次（headless、物理 1 つ）、ECR・S3・Secrets Manager の複製、KMS のマルチリージョンキー、空の VPC |
| S2 | パイロットライト。各物理クラスタの二次は headless。`global` の二次だけ reader を 1 台置く | 同上。物理クラスタの数だけ二次がある |
| S3 | ウォームスタンバイか、複数のリージョンでの常時稼働（未決定） | [infrastructure.md](../architecture/infrastructure.md) の 11 節 |

## Consequences

- 良くなること：
  - 物理クラスタが増えても、同じ手順を繰り返すだけで済む。
  - headless の二次は、ストレージの料金だけで済む。
- 引き受けるコスト：
  - 物理クラスタの数だけ、インスタンスの追加と昇格の作業がある。S2（数十のクラスタ）では、手順を並列に自動化しないと RTO 4 時間を守れない。
  - 昇格の後、クラスタどうしの時点のずれを突合する作業が要る。
  - 論理レプリケーションのスロット（CDC、再シャーディング）は、リージョンの切り替えの後に作り直す前提にする（AWS のドキュメントは、切り替えの後のスロットの管理を別に案内している）。

## Confirmation

- 四半期に 1 回、PITR の復元訓練を行う。年に 1 回、staging で大阪への切り替えを最後まで行い、RTO を計測する（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）。
- S2 に入る前に、複数の物理クラスタの同時の昇格を自動化し、staging で RTO 4 時間に収まることを確かめる。
- 全物理クラスタに `AuroraGlobalDBRPOLag` のアラームがあることを、Terraform のポリシー検査で確かめる。

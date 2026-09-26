---
status: accepted
date: 2026-09-26
---

# ADR-0028: 物理クラスタの分割は、論理レプリケーションと影の読み取りで、無停止で行う

## Context

S1 は物理クラスタ 1 つに 480 の論理シャードを置く（[ADR-0003](0003-workspace-sharding.md)、[ADR-0027](0027-shard-router.md)）。S2 で物理を増やすとき、論理シャードの束を別のクラスタへ移す。NFR-007（月間 99.9%）のもとで、長い停止は取れない。

本家は、2 回の大きな移行をした。

- 最初のシャーディング（モノリスから 32 の物理 DB へ）：監査ログによる二重書き込み、バックフィル（96 CPU で約 3 日）、影の読み取りでの照合を経て、5 分の計画停止で切り替えた（[Herding elephants](https://www.notion.com/blog/sharding-postgres-at-notion)）。
- 再シャーディング（32 から 96 へ。1 台あたりのスキーマを 15 から 5 に）：PostgreSQL の論理レプリケーションを使い、既存の DB ごとに 3 つのパブリケーション（それぞれ 5 スキーマ）を作った。索引を作らずに初期コピーをし、後で作ることで、同期を 3 日から 12 時間に縮めた。影の読み取り（最大 5 行の結果を返す問い合わせを抽出し、1 秒の遅延の後に比べる）でほぼ 100% の一致を確かめ、利用者には短い「保存中」の表示しか見えない切り替えを行った（[The Great Re-shard](https://www.notion.com/blog/the-great-re-shard)）。

## Options

1. **PostgreSQL の論理レプリケーション（パブリケーションとサブスクリプション）で移す**
2. アプリの二重書き込みとバックフィルで移す（本家の最初の移行）
3. Aurora のクローンかスナップショットから新しいクラスタを作り、不要なスキーマを消す
4. AWS DMS で移す

## Decision

1 を採用する。

- Aurora PostgreSQL は論理レプリケーションに対応する。クラスタのパラメーターグループで `rds.logical_replication = 1` にし、writer の再起動で有効になる（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.Logical.Configure.html)）。再起動を後で取らないよう、S1 の最初から有効にしておく（データレイクの CDC でも使う。[ADR-0030](0030-cdc-data-lake.md)）。
- 2 は、アプリのすべての書き込みの経路に二重書き込みを入れることになり、漏れがあれば静かにずれる。
- 3 は、クローンの時点から切り替えまでの差分を追う手段が別に要る。初期コピーを速くする手段としては検討に値するが、クローンとサブスクリプションの組み合わせの手順は **未検証**。
- 4 は、管理の対象が増え、スキーマの束を単位にした切り替えとフェンス（[ADR-0027](0027-shard-router.md)）を自分で組む点は 1 と変わらない。

### 手順

移す単位は「移行の群れ」とする。1 つの群れは、移動先の 1 つのクラスタへ行く論理シャードの束である（例：物理 1 → 4 なら、120 シャードの束が 3 つ動く）。

| 段 | やること | 戻せるか |
| --- | --- | --- |
| 0. 準備 | マイグレーションを凍結する（DDL は複製されない。[PostgreSQL の文書](https://www.postgresql.org/docs/18/logical-replication-restrictions.html)）。移動先のクラスタを Terraform で作り、Global Database の二次（[ADR-0029](0029-disaster-recovery.md)）も付ける。スキーマを主キーだけで作る（二次索引は作らない） | いつでも戻せる |
| 1. 初期コピー | 移動元で、群れのスキーマのパブリケーションを作る。移動先で、`copy_data = true` のサブスクリプションを作る。コピーが終わったら、二次索引を `CONCURRENTLY` で作る | いつでも戻せる（サブスクリプションを消す） |
| 2. 追従 | 複製の遅延を監視する。`VACUUM ANALYZE` を移動先で行う | 同上 |
| 3. 照合 | 行数とチェックサム（テーブルごと、`workspace_id` の範囲ごと）を比べる。API で影の読み取りを行う（下記） | 同上 |
| 4. 切り替え | 群れを 8〜16 シャードずつに分け、順に切り替える（下記） | 切り替えたシャードは、逆向きの複製で戻せる |
| 5. 観察 | 7 日間、移動元を逆向きの複製で最新に保つ | 戻せる |
| 6. 片付け | 逆向きのサブスクリプションとパブリケーション、移動元のスキーマを消す。マイグレーションの凍結を解く | 戻せない |

- パブリケーションは `FOR TABLES IN SCHEMA` で作れ、後から作ったテーブルも含まれる（[PostgreSQL の文書](https://www.postgresql.org/docs/18/sql-createpublication.html)）。ただしこの句はスーパーユーザーを要し、Aurora の `rds_superuser` で使えるかは **未検証**。使えなければ、テーブルを列挙した `FOR TABLE` で作る（段 0 でマイグレーションを凍結するので、テーブルの一覧は変わらない）。
- シーケンスは複製されない（同じ文書）。シャードの中のテーブルは UUIDv7 とページごとの連番の行（[ADR-0005](0005-transactions-as-unit-of-change.md)）を使い、シーケンスに頼らない。例外（outbox の `BIGSERIAL` など）は、切り替えの前に移動先のシーケンスを移動元の最大値より先へ進める。
- 論理レプリケーションのスロットは、使わないまま残すと VACUUM が古い行を消せなくなる（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.Logical.Configure.html)）。スロットの遅延を監視し、中止したら必ず消す。Aurora の writer のフェイルオーバーでスロットが保たれるかは **未検証**。保たれない前提で、フェイルオーバーが起きたら段 1 からやり直す。

### 影の読み取り（照合）

- API は、移行中の群れのワークスペースへの読み取りのうち 1% を抽出し、同じ問い合わせを移動先にも投げる。結果が小さい（5 行以下）問い合わせだけを対象にする（本家と同じ）。
- 移動先への問い合わせは 1 秒遅らせ、複製の遅延による偽の不一致を減らす。不一致は、比べた時点の複製の遅延とあわせて記録する。
- 影の読み取りの結果は利用者に返さず、失敗しても利用者の応答に影響させない。
- 1 日以上、遅延で説明できない不一致が 0 件であることを、段 4 へ進む条件にする。

### 切り替え（1 回あたり 8〜16 シャード）

1. `shard_map` の状態を `frozen` にする。ルーターは、その論理シャードへの書き込みを最大 10 秒待たせる。クライアントは未確定のトランザクションを持ち続け、「保存中」の表示になる（[ADR-0005](0005-transactions-as-unit-of-change.md)）。
2. 移動元のスキーマから `app` ロールの書き込み権限を外す（フェンス）。実行中のトランザクションが終わるのを待つ（`lock_timeout` の範囲）。
3. 移動元の現在の WAL の位置まで、移動先が追いついたことを確かめる。
4. 移動先のシーケンスを進め、逆向き（移動先 → 移動元）のパブリケーションとサブスクリプションを作る（`copy_data = false`）。
5. `shard_map` を移動先・`active` に更新し、`version` を上げる。各タスクに再読み込みを通知する。
6. 各タスクの `shard_map` の版がそろったことを確かめる。1〜5 が 10 秒を超えたら、手順を止めて 1 の前へ戻す（フェンスを外し、`active` に戻す）。

戻すときは、同じ手順を逆向きに行う。段 6 の前なら、移動元は逆向きの複製で最新なので、データを失わない。

### 移動に伴うほかの作業

- Relay の担当（論理シャードのリース）を、移動先のクラスタの Relay に移す（[collaboration.md](../architecture/collaboration.md)）。
- データレイクの CDC の取り込み元を、移動先のクラスタに足す（[ADR-0030](0030-cdc-data-lake.md)）。
- 検索の索引とファイルは、ワークスペースの ID をキーにしているので移さない。

> 2026-09-27 の注記：未検証の 3 点を確かめた。
> - **フェイルオーバーでのスロット（解消）**：Aurora の writer のフェイルオーバーの後は、論理レプリケーションのスロットを作り直す必要がある。PostgreSQL 17 のフェイルオーバースロット（`sync_replication_slots`）は Aurora では使えない（[AWS Database Blog](https://aws.amazon.com/blogs/database/migrate-amazon-aurora-postgresql-across-major-versions-with-active-debezium-cdc-connectors-using-native-logical-replication/)、2026-09-27 に確認。User Guide には記述がない）。「保たれない前提で、段 1 からやり直す」は変えない。
> - **クローンからの初期コピー（解消）**：AWS は、移動元でパブリケーションとスロットを作ってからクローンし、クローンで `aurora_volume_logical_start_lsn()` を読み、`copy_data = false`・`create_slot = false` のサブスクリプションを `pg_replication_origin_advance` でその位置へ進める手順を示している（[Using logical replication to perform a major version upgrade](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.MajorVersionUpgrade.html)、2026-09-27 に確認）。そこで、段 1 の初期コピーを速くする手段として、この手順を選べるものにする。クローンには全スキーマが入るので、移動先で群れに属さないスキーマを消す。使う版の Aurora で `aurora_volume_logical_start_lsn()` が使えるか（文書の版の一覧は 15.2 まで）は、E9 の `reshard-drill-staging` で確かめる。
> - **`FOR TABLES IN SCHEMA` と `rds_superuser`（未検証のまま）**：PostgreSQL では、この句と `FOR ALL TABLES` はスーパーユーザーを要する（[CREATE PUBLICATION](https://www.postgresql.org/docs/18/sql-createpublication.html)、2026-09-27 に確認）。AWS は `rds_superuser` の利用者が `FOR ALL TABLES` を使う手順を示している（上の文書）が、`FOR TABLES IN SCHEMA` についての記述はない。staging で確かめ、使えなければ `FOR TABLE` で列挙する（決定のとおり）。

## Consequences

- 良くなること：
  - アプリのコードを変えずに、物理を増やせる。
  - 利用者に見えるのは、切り替えの数秒の「保存中」だけにできる。
  - 群れの単位で、途中で止め、戻せる。
- 引き受けるコスト：
  - 移行の間（数日〜数週）、マイグレーションを凍結する。機能の開発はフラグの裏で続けられるが、スキーマの変更は待つ。
  - 移行の間、移動元の writer に論理デコードの負荷がかかる。移行は、負荷の低い時期と時間帯に行う。
  - 手順が長い。runbook と自動化（`reshard` のワークフロー）を、S2 に入る前に staging で訓練する。

## Confirmation

- S2 に入る前に、staging で「物理 1 → 2」を行い、次を確かめる。
  - 切り替え中も k6 で編集を続け、確定したトランザクションが 1 件も失われない（NFR-004）。
  - 1 回の切り替えで、書き込みを待たせた時間が 10 秒以内に収まる。
  - 影の読み取りの不一致が、遅延で説明できるもの以外 0 件である。
  - 切り替えた後に戻す手順で、データが一致する。
- 移行の各段の記録（時刻、遅延、照合の結果）を、変更の記録に残す。

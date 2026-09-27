---
status: accepted
date: 2026-09-27
---

# ADR-0047: Router は、タスクごとの生存の記録と、ファイルごとの割り当ての記録を分けて持つ。手放しの記録、回復のジョブ、削除済みの割り当てで、ADR-0024 の前提を満たす

## Context

[ADR-0005](0005-tenancy-and-document-routing.md) は、Router がファイルごとに `(owner_server_id, lease_expires_at, epoch)` を持ち、Document Server が期限 10 秒のリースを 3 秒ごとに延ばす例を示した。[ADR-0024](0024-journal-items-and-fencing.md) は、Router に次の 3 つを求めた。

- **きれいに手放した記録**：チェックポイントを書いて手放したファイルと、手放さずに落ちたファイルを見分ける。
- **回復のジョブ**：手放さずに落ちたファイルを 5 分以内に割り当てて回復させ、チェックポイントを書かせる。ジャーナルの TTL（書いた時点から 30 日）で、チェックポイントより後の項目が消える前に拾う。1 日を超えて残るものはアラーム。
- **削除済みの割り当て**：完全な削除のジョブが、どの Document Server もそのファイルを持てないようにする（[file-storage-and-history.md](../architecture/file-storage-and-history.md) の 11.2 節）。

ファイルごとのリースを 3 秒ごとに延ばすと、書き込みは開いたファイルの数に比例する。S1 の 1 万ファイルで毎秒約 3,300 件、S3 の 100 万ファイルで毎秒約 33 万件になる（[architecture/README.md](../architecture/README.md) の 3 節）。リースの表をグローバルテーブルにすると、大阪にも同じ数の書き込みが複製される。1 つの Document Server が落ちると、その数千のファイルのリースが同時に切れる点は、どの形でも同じである。

## Options

1. **タスクごとの生存の記録（延ばす）と、ファイルごとの割り当ての記録（割り当てと手放しのときだけ書く）に分ける**
2. **ADR-0005 の例のとおり、ファイルごとのリースを延ばす**
3. **Valkey にリースを置く**

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 5 節。

- **`ds_liveness`**（DynamoDB、リージョンごとの表。グローバルテーブルにしない）：Document Server のタスクごとに 1 項目。`task_id`、`incarnation`（起動ごとの乱数）、`pool`、`az`、`addr`、`state`（`active`・`draining`）、`expires_at_ms`、負荷（ファイルの数、メモリの使用と予算、接続の数）。2 秒ごとに延ばし、期限は 10 秒。
- **`file_leases`**（DynamoDB、グローバルテーブル）：ファイルごとに 1 項目。`state`（`owned`・`handoff`・`released`・`deleted`）、`owner_task`、`owner_incarnation`、`epoch`、`region_gen`（[ADR-0048](0048-osaka-dr-with-journal-generations.md)）、`released_seq`、`released_at`、`assigned_at`。
  - 持ち主が有効なのは、`state = owned` で、`ds_liveness` の `(owner_task, owner_incarnation)` の項目が期限の内にあるときだけ。
  - 割り当ては、`epoch` を条件にした `UpdateItem` で `epoch + 1` にする。新しい持ち主は、その `epoch` でジャーナルのフェンスを上げる（ADR-0024）。フェンスが最後の防御であることは変わらない。
- **手放しの記録**：
  - `released`：チェックポイントを `durable_seq` まで書いてから手放した（接続が 0 になって 10 分。file-storage-and-history.md の 6.5 節）。`released_seq` にその `seq` を書く。
  - `handoff`：ジャーナルを書き切ってから、ドレインで次の持ち主へ渡す（[ADR-0046](0046-multiplayer-compute-on-fargate-with-drain.md)）。Router はすぐに次の持ち主を割り当てる。
  - どちらでもない `owned` のまま持ち主の生存が切れたものが「手放さずに落ちた」ファイルである。
- **回復のジョブ**（Router の中のループ）：
  - 30 秒ごとに `ds_liveness` を読み、期限の切れたタスクを見つける。GSI `by_owner`（`owner_task` をキーにした疎な索引。`owned`・`handoff` の間だけ値を持つ）で、そのタスクのファイルを集める。
  - 2 分たっても誰も開かず割り当てられないファイルを、回復だけの割り当て（`recover_then_release`）で Document Server に渡す。Document Server は回復し、チェックポイントを書き、`released` にする。目標は落ちてから 5 分以内。
  - 毎日の見張り：`by_owner` を全部読み、生存の切れた持ち主のファイルが 1 日を超えて残れば、アラームを出す（[observability.md](../architecture/observability.md) の 6 節）。
- **削除済み**：完全な削除のジョブは `state = deleted`、`epoch` を最大値にする。Router は `deleted` のファイルを割り当てず、Gateway に `gone` を返す（Gateway は `Kick(file_deleted)`）。回復のジョブも `deleted` を扱わない。`deleted` の項目は TTL で 400 日後に消す。
- **Router はリースの延長の経路にいない。** Document Server が `ds_liveness` を直接延ばす。Router が止まると新しく開けなくなるが、開いているファイルは続く。
- **自分から止まる**：Document Server は、`ds_liveness` を 8 秒延ばせなければ、全ファイルの受け付けを止め、`Kick(owner_changed)` を送って状態を捨てる。
- **キャッシュ**：持ち主の対応は Valkey に 30 秒、Gateway のプロセスの中にファイルごとに持つ。接続の失敗で取り直す。
- 2 を採らない理由：上の Context の書き込みの量。大阪への複製の費用も同じだけかかる。
- 3 を採らない理由：Valkey は Multi-AZ でも非同期の複製で、フェイルオーバーで最後の書き込みを失いうる。持ち主の正本には、条件付きの書き込みの持続性が要る（ADR-0005）。

## Consequences

- 良くなること：
  - 延ばす書き込みが、タスクの数（数十〜数千）に比例するだけになる。
  - 手放しの種類が記録に残り、回復のジョブが「落ちたもの」だけを拾える。
  - 削除したファイルを、どの経路でも開けない。
- 引き受けるコスト：
  - ADR-0005 の「ファイルごとのリース」を、「タスクの生存＋割り当て」に読み替える。README と ADR-0005 の書き換えは統合の工程で行う。
  - 生存の判定に、2 つの表を読む（割り当ての記録と生存の記録）。Router の中でキャッシュする。
  - 時計のずれに備え、期限の後に 2 秒の猶予を置いてから割り当てる（NFR-007 の 15 秒の中に収める）。

## Confirmation

- 性質ベーステスト：任意のタスクの停止・遅延・時計のずれ・ドレインの列で、ジャーナルに書けるのは各時点で 1 つの持ち主だけ（PROP-FS-007 と組み合わせる）。
- 障害注入：Document Server を止め、誰も開かないファイルが 5 分以内に `released` になる。
- 結合テスト：`deleted` のファイルを開こうとすると `Kick(file_deleted)`。回復のジョブも割り当てない。
- 監視：生存の切れた持ち主の割り当ての数と、その最古の経過時間（1 日で警告）。

---
status: accepted
date: 2026-10-09
---

# ADR-0021: commit の操作は `create`・`update`・`move`・`delete`・`undelete` の 5 つ。ファイルの削除は `base_rev` と `base_node_ver`、フォルダーの削除は `base_seq`（読み終えた番号の後に子孫が変わっていない）を条件にする。フォルダーの削除と `undelete` は根の 1 行だけを変え、子孫は祖先で決まる。1 つの commit の置き場所の変化は、`name_key` を仮の値にしてから最後の値にする 2 段で当てる。ジャーナルに、利用者に返さない `purge` の操作を足す

## Context

[ADR-0005](0005-namespace-journal-and-cursors.md) は、1 回の commit を 1 名前空間への最大 1,000 の操作とし、全部が通るか通らないかにした。[ADR-0006](0006-sync-conflict-model.md) は、中身の変更を `base_rev`、移動・名前の変更・削除を `base_node_ver`、作成を「その名前がまだない」で条件にした。[ADR-0008](0008-node-identity-and-names.md) は、移動を 1 行の変更にし、`(ns_id, parent_id, name_key)` を一意にした。

詳細を決めると、次の穴がある。

- **削除が後の変更を巻き込む**：端末 A が中身を変えて r2 にした後、r1 を見ていた端末 B の削除が `base_node_ver` だけで通る（中身の変更は `node_ver` を上げない）。決定表の 4（削除と変更なら変更を残す）に反する。
- **フォルダーの削除と中への追加**：サーバーが、削除する端末の見ていなかった子孫の変化を見分けられない（決定表の 8・9）。
- **大きなフォルダーの削除**：10 万の子孫の行を 1 つのトランザクションで書くと、名前空間のロックを長く持つ。
- **名前の入れ替え**：A↔B の入れ替えを 1 つの commit で送っても、操作を順に当てると途中で一意の索引を破る。PostgreSQL の部分の一意の索引は、検査を遅らせられない。
- **保持の期限の削除**：[ADR-0005](0005-namespace-journal-and-cursors.md) は保持の期限での削除もジャーナルに載せると決めたが、木を変えない行の消去を表す操作がない。

## Options

削除の条件：

1. **ファイルは `base_rev`＋`base_node_ver`、フォルダーは `base_seq` の後の子孫の変化なし**
2. `base_node_ver` だけ（ADR-0006 の文言のまま）

フォルダーの削除の書き方：

- a. **根の 1 行だけを変え、子孫は祖先で決める**
- b. 子孫のすべての行に `deleted_at` を書く

入れ替え：

- x. **2 段（仮の `name_key` → 最後の値）**
- y. 操作の順序をクライアントに任せ、入れ替えは 3 回の commit にさせる

## Decision

1・a・x を採用する。詳細は [metadata-and-journal.md](../architecture/metadata-and-journal.md) の 4・5 節。

- 操作は `create`・`update`・`move`・`delete`・`undelete`（ファイルだけ）。
- 条件と 409 の理由は、[metadata-and-journal.md](../architecture/metadata-and-journal.md) の 4.2 節の表のとおり。フォルダーの削除は、その名前空間の `seq > base_seq` の行の `node_id` の祖先をたどり、削除するフォルダーに当たれば `subtree_changed`。10,000 行を超えたら `subtree_changed` として読み直させる。
- フォルダーの削除と復元の `undelete` は根の 1 行の `deleted_at`・`node_ver`・`deleted_reason` だけを変え、ジャーナルに根の 1 行を書く。子孫が見えるかは、祖先の削除で決まる。読む側は根の `delete` で子孫も消えたとみなす。フォルダーの `undelete` は公開の commit に出さず、復元の操作だけが使う。
- 1 つの commit の中で動くノードは、1 段目で `name_key` を `'\x00' || node_id` にし、2 段目で最後の値にする。循環の検査は 2 段目の後に行う。
- ジャーナルの `op` に `purge` を足す。保持の期限・名前空間をまたぐ移動の後始末で行を消したことを表し、`list/continue` は返さない。これは [ADR-0005](0005-namespace-journal-and-cursors.md) の `op` の一覧への追加である。
- commit に冪等のキーを持たせない（[ADR-0010](0010-local-state-db-and-intent-log.md)）。

### 他の案を選ばなかった理由

- **2（`base_node_ver` だけ）**：上の「削除が後の変更を巻き込む」が起きる。中身は削除したファイルとして戻せるが、利用者に知らせずに最新の編集を消すことになる。
- **b（子孫に書く）**：10 万の子孫の削除で、10 万行の更新と名前空間のロックの長い保持になる。フォルダーの復元も 10 万行の更新になる。
- **y（3 回の commit）**：途中の状態（仮の名前）が他の端末に見え、途中で落ちると仮の名前が残る。

## Consequences

- 良くなること：
  - 削除が、見ていなかった変更を巻き込まない。決定表の 4・8・9 がサーバーの条件で見つかる。
  - フォルダーの削除と復元が、子孫の数によらず 1 行。
  - 名前の入れ替えと輪の形の移動を 1 つの commit で受けられる。
- 引き受けるコスト：
  - 見えているかの判断に祖先のたどりが要る（深さ 256 段まで）。commit の中でキャッシュし、一覧では行わない（[ADR-0023](0023-tree-listing-snapshot-and-journal-retention.md)）。
  - 祖先が削除された子孫の行が残る。保持の期限で `purge` する（[versions-and-recovery.md](../architecture/versions-and-recovery.md)）。
  - フォルダーの削除の直前に他の端末の変化があると 409 になり、計画し直しが増える。
  - [ADR-0006](0006-sync-conflict-model.md) の削除の条件の文言（`base_node_ver`）を、この ADR で広げた。

## Confirmation

- 表駆動テスト：DT-META-001（操作 × 条件 × 理由）。
- 性質ベーステスト：PROP-META-003（一意。入れ替えが通る）、PROP-META-004（削除が変更を巻き込まない）、PROP-META-006（循環なし）。
- 結合テスト：2 段の置き場所の間、一意の索引の違反が一度も起きない（入れ替え、輪、1,000 の操作）。
- シミュレーターの契約の試験：サーバーの模型と本物の `packages/committer` が、同じ操作の列に同じ結果を返す。

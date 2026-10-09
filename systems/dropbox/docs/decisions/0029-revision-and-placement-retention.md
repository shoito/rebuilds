---
status: accepted
date: 2026-10-09
---

# ADR-0029: 中身のリビジョンと置き場所のバージョン（`node_versions`）を、置き換えられた・削除された時刻からプランの保持の日数だけ持つ。今のリビジョンと見えているノードは期限で消さない。期限の処理は `packages/committer` を通して `purge` を書き、ブロックの参照を減らす。保持を短くするプランの変更は 30 日の猶予の後に効かせる

## Context

[architecture/README.md](../architecture/README.md) の 6 節は、バージョンの保持の期間を本家と同じ区分の既定（無料・個人の有料 30 日、チームの標準 180 日、チームの上位 365 日）にした。本家の区分は公式の資料で確かめた（[Version history overview](https://help.dropbox.com/delete-restore/version-history-overview)、2026-10-09 に確認）。数え始めは確かめられなかった（**未検証**）。

- 巻き戻しは、保持の期間の中の時点の木が要る（NFR-009）。ジャーナルは 90 日で落とす（[ADR-0023](0023-tree-listing-snapshot-and-journal-retention.md)）ので、365 日の時点の木を作れない。
- ブロックの参照は、リビジョンの保持の期限で減る（[ADR-0003](0003-dedupe-scope-and-privacy.md)、[ADR-0007](0007-block-storage-layout-on-s3.md)）。
- ジャーナルを通らない書き込みを作らない（[ADR-0005](0005-namespace-journal-and-cursors.md)）。
- 約束の文言、解約の後の消去、電子帳簿保存法への対応は**法務の確認待ち**（L6・L8）。

## Options

数え始め：

1. **置き換えられた・削除された時刻から**
2. 作られた時刻から

時点の木の元：

- a. **置き場所のバージョン（`node_versions`）を、保持の期間だけ別に持つ**
- b. ジャーナルを保持の期間（最大 365 日）だけ持ち、ジャーナルから作る
- c. 毎日、名前空間の木の写しを S3 に置く

## Decision

1 と a を採用する。詳細は [versions-and-recovery.md](../architecture/versions-and-recovery.md) の 4 節。

- `revisions` は `superseded_at`（ノードの削除ではその時の今のリビジョンに `deleted_at`）から、`node_versions` は `valid_to_at` から、削除したノードは `deleted_at`（祖先の削除で見えないものは祖先の `deleted_at`）から、プランの日数だけ持つ。
- `node_versions` は、`packages/committer` が置き場所かリビジョンを変えるたびに同じトランザクションで 1 行足し、前の行の終わりを埋める。
- 今のリビジョンと見えているノードの今のバージョンは、期限で消さない。`packages/committer` は今のリビジョンの `purge` を拒む。
- `lifecycle` の Worker が名前空間ごとに 1 日 1 回、1,000 件ずつ `packages/committer` で消し、`ns_block_refs` を減らし、ジャーナルに `purge` を書く（[ADR-0021](0021-committer-operations-and-conditions.md)）。
- 期間は名前空間の持ち主のテナントのプランで決める。上げたらすぐ、下げたら 30 日の猶予の後に効かせる。

### 他の案を選ばなかった理由

- **2（作られた時刻）**：長く使われた今のリビジョンの 1 つ前が、置き換えた直後に期限切れになり、戻せない。
- **b（ジャーナルを長く）**：時点 t の木を作るのに、名前空間の全期間のジャーナルを読む。分割の数が増え、差分の取得の索引も大きくなる。
- **c（毎日の写し）**：1 日より細かい時点に戻せない。25 億ノードの写しを毎日作る費用。

## Consequences

- 良くなること：
  - 保持の期間の中の任意の時点の木を、索引の範囲の読み出しで作れる。
  - ジャーナルの保持（カーソルのため）と、履歴の保持（復元のため）を分けて決められる。
  - 期限の処理もジャーナルに載り、ジャーナルの連続の監視が効く。
- 引き受けるコスト：
  - `node_versions` の行が、置き場所かリビジョンの変化ごとに増える。S1 で数十億行。月の分割と、capacity.md の見積もりが要る。
  - commit ごとに 1 行の追加と 1 行の更新が増える。
  - 保持の約束が法務の結論で変わりうる。期間を設定で持ち、短縮に猶予を持たせる。

## Confirmation

- 表駆動テスト：DT-VER-002（数え始め × プランの変更）。
- 性質ベーステスト：PROP-VER-005（保持の期間の中のリビジョンと今のリビジョンのブロックが `live`）。
- 結合テスト：`packages/committer` が今のリビジョンの `purge` を拒む。期限の処理がジャーナルに `purge` を書き、`ns_block_refs` を減らす。
- 本番：期限の処理の遅れ（7 日で警報）、ブロックの参照の監査（[ADR-0007](0007-block-storage-layout-on-s3.md)）。

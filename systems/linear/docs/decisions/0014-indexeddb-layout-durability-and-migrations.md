---
status: accepted
date: 2026-09-28
---

# ADR-0014: IndexedDB は outbox だけを `strict`、差分とブートストラップを `relaxed` で書く。outbox の行は確定の後 15 分残し、移行は store と索引を `onupgradeneeded` で、行を再開できる通常のトランザクションで行い、outbox は送る時に今の形へ変換する

## Context

[ADR-0005](0005-client-persistence-and-offline.md) で、ワークスペースごとの IndexedDB に、モデルの store、`_meta`、`_outbox`、`_partial_indexes`、`_rejected` を持ち、outbox を `durability: "strict"` で書き、差分のパケットを 1 つのトランザクションで保存し、移行で outbox を消さないと決めた。残る問いは次のとおり。

- 差分・ブートストラップ・遅延の読み込みの `durability`。Chrome 121 から既定が `relaxed` になり、Firefox・Safari も `relaxed` に近い既定である。`strict` は書き込みが遅い（[A change to the default durability mode in IndexedDB](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed)、2026-09-28 に確認。flush をしないことで追加の書き込みが 10 倍以上速くなったという計測がある）。
- outbox の行を消す時期。DR の切り替えで直近の確定が失われたとき、送り直す材料が要る（[ADR-0013](0013-sync-group-changes-retention-and-reset.md)）。
- 行の移行を、`onupgradeneeded` の中で行うか。`versionchange` のトランザクションの中では、同期の IndexedDB の操作しかできない。
- outbox の古い形の扱い。

MDN は、`strict` を「永続の保存に書けたことを確かめてからコミットとみなす」、`relaxed` を「OS に渡した時点でコミットとみなす」と説明する（[IDBDatabase.transaction()](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction)、2026-09-28 に確認）。

## Options

`durability`：

1. **outbox・脱退の消去・`_meta` の進みの記録だけ `strict`。差分・ブートストラップ・遅延の読み込みは `relaxed`**
2. すべて `strict`
3. すべてブラウザの既定

移行：

- a. **`onupgradeneeded` では store と索引だけ。行の移行は開いた後に、Web Locks で 1 つのタブに限り、2,000 行ずつ、`_meta.migration` の進みから再開できる形で行う**
- b. `onupgradeneeded` の中で行も移行する

outbox の形：

- x. **書き換えず、送る時に `upcast` の関数を順に当てる**
- y. 移行の時に今の形へ書き換える

## Decision

1・a・x を採用する。詳細は [client-store-and-offline.md](../architecture/client-store-and-offline.md) の 3〜6 節。

- store はモデルの名前で持つ（本家の解析のようなハッシュの名前にしない）。行に `_u`（`updated_sync_id`）と `_g`（同期グループ）を付け、`_g` に multiEntry の索引を張る。`_tombstones` と `_blobs` を足す。データベースの名前は `<brand>_<SHA-256(account_id:workspace_id) の base32 の先頭 20 文字>` にし、ワークスペースの名前を入れない。
- `relaxed` の書き込みが電源の喪失で失われても、IndexedDB のトランザクションの原子性で、手元の状態と `last_sync_id` がそろったまま前に戻るだけで、取り戻せる。`strict` と `relaxed` の間の永続の順序には頼らない。
- outbox の行の状態は `queued`・`sent`・`acked`・`done`。`done` は確定を差分で確かめたもので、15 分後に消す。
- 移行は a のとおり。`versionchange` を受けた古いタブは、まとめ中の outbox を書き終えてから閉じ、操作を止める。古いコードが新しいバージョンを開いたら（`VersionError`）、DB に触れない。
- outbox の変換の関数は 180 日分のバージョンを持つ。変換できない古い形は確認の一覧に出す。
- 2 を採らない理由：ブートストラップの一括の書き込みが遅くなり、NFR-003 を脅かす。取り戻せるデータに `strict` の費用を払う意味がない。
- 3 を採らない理由：outbox の保証がブラウザの既定に左右される。
- b を採らない理由：`versionchange` のトランザクションを長く持ち、他のタブを長く止める。途中で落ちると最初からになる。
- y を採らない理由：変換の誤りが見つかったとき、元の形がないので直せない。

## Consequences

- 良くなること：
  - 保証の起点（outbox の `strict` のコミット）を保ったまま、大きな書き込みを速くできる。
  - DR の後の送り直しの材料が手元に残る。
  - 長い移行も途中から再開でき、outbox の元の形が残る。
- 引き受けるコスト：
  - 電源の喪失の後、少し前の状態から取り戻す手間が増える。
  - 変換の関数を 180 日分保つ。
  - 移行の間、そのモデルの画面が使えないことがある。

## Confirmation

- 性質ベーステスト（[ADR-0010](0010-deterministic-sync-simulator.md)。模した IndexedDB で `relaxed` の直近のコミットを失わせる）：PROP-STORE-001（失わない）、PROP-STORE-002（原子性）、PROP-STORE-004（移行）。
- Playwright：オフラインのまま再起動、送信の途中で落ちる、古いバージョンの outbox を新しいバージョンで送る、の 3 つの場面（AGENTS.md）。
- CI：DB のバージョンを上げる PR に、移行の関数と、1 つ前のバージョンの outbox の変換のテストがなければ失敗させる（ADR-0005）。
- lint：`durability` を指定しない IndexedDB のトランザクションを、保存の層で禁止する。

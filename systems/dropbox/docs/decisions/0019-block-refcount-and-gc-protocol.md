---
status: accepted
date: 2026-10-09
---

# ADR-0019: 名前空間ごとの参照の行（`ns_block_refs`）が 0↔1 で変わるときだけ、ブロックの行の `ns_ref_count` を同じトランザクションで増減する。GC は `orphaned` から 7 日を過ぎ、ピンのないブロックを、`deleting` を DB に確定してから S3 で消し、その後に行を消す。`deleting` のブロックは commit で「送れ」、検証では「待て」にする

## Context

[ADR-0003](0003-dedupe-scope-and-privacy.md) は、名前空間ごとの参照 `ns_block_refs` を持ち、GC はテナントの全名前空間の参照の和が 0 のブロックだけを対象にすると決めた。[ADR-0007](0007-block-storage-layout-on-s3.md) は、状態を `live` → `orphaned` → `deleting` → 消す、猶予を 7 日、S3 のバージョニングで 30 日戻せる、と決めた。

決めることは次である。

- 「全名前空間の和が 0」をどう知るか。`ns_block_refs` は名前空間の表で、`packages/committer` は書き込み先の名前空間しか読めない（`app.ns_ids`）。
- よく使われるブロック（同じテンプレート、よくある小さなファイル）の行を、参照の増減のたびにロックしないこと。
- GC の削除と、同じブロックの新しいアップロードの写しが前後したときに、新しい写しを消さないこと。S3 の削除は DB のトランザクションの外にある。
- アップロードの途中（参照がまだない）のブロックを消さないこと（[ADR-0018](0018-upload-sessions-and-block-grants.md)）。

## Options

参照の和：

1. **`blocks.ns_ref_count`（参照する名前空間の数）を、`ns_block_refs` の行の作成と削除のときだけ増減する**
2. `blocks.ref_count`（全参照の和）を、リビジョンの作成・期限切れのたびに増減する
3. 和を持たず、GC が `ns_block_refs` をテナントの全体で数える

GC の削除の手順：

- a. **`deleting` を確定 → S3 の削除 → 行の削除。`deleting` の間、commit は「送れ」、検証は「待て」**
- b. 行のロックを持ったまま S3 を消し、同じトランザクションで行を消す
- c. S3 の特定のバージョン（VersionId）だけを消す

## Decision

1 と a を採用する。詳細は [block-storage.md](../architecture/block-storage.md) の 5 節。

- `ns_block_refs.ref_count` は名前空間の中の参照の数。行の作成で `blocks.ns_ref_count` を +1（`orphaned` なら `live` に戻す）、行の削除で −1（0 なら `orphaned`、`orphaned_at=now()`）。`blocks` はテナントの表で、トランザクションのテナントは書き込み先の名前空間の持ち主なので、RLS の中で書ける（[ADR-0004](0004-tenancy-namespaces-and-rls.md)）。
- ロックの順は、名前空間の行 → `ns_block_refs` → `blocks`（ハッシュの順）。
- 検証したばかりのブロックは `orphaned` で入れ、`pin_until` をアップロードの期限にする。
- GC の対象は `state='orphaned' AND orphaned_at < now()-7 日 AND (pin_until IS NULL OR pin_until < now())`。トランザクションで `ns_ref_count = 0` を確かめ直して `deleting` にして確定し、S3 の DeleteObjects で消し（削除のマーカー。古いバージョンは 30 日残る）、`block_gc_log` にバージョンを書いて行を消す。
- `deleting` のブロックは、commit の答えで `need`。`verify` は写さず 60 秒の遅れで待つ。`deleting` のまま 1 時間の行は GC がやり直す。
- 毎週、`ns_ref_count` を `ns_block_refs` から数え直して比べる。食い違いは SEV の候補で、GC を止める。

### 他の案を選ばなかった理由

- **2（全参照の和）**：同じブロックを参照するリビジョンの作成のたびに `blocks` の行をロックする。よく使われるブロックで、名前空間をまたいで書き込みが直列になる。
- **3（GC が数える）**：GC が全名前空間の行を読む専用の経路が要り、GC と commit の前後を行のロックで守れない。
- **b（ロックしたまま S3）**：DeleteObjects の一部が失敗すると、行が戻ってもオブジェクトは消えている。次の commit が `live` に戻すと、中身のないブロックを参照する。
- **c（バージョンだけを消す）**：古いバージョンが残らず、GC の誤りを S3 のバージョニングで戻せない（ADR-0007 の 30 日に反する）。

## Consequences

- 良くなること：
  - よく使われるブロックの行のロックは、名前空間が初めて参照するときと、最後に外すときだけになる。
  - GC と写しの前後で、新しい写しが削除のマーカーの下に埋もれない。
  - アップロードの途中のブロックがピンで守られる。
- 引き受けるコスト：
  - `ns_ref_count` の数え違いは、7 日の猶予の間に見つける必要がある（毎日の参照の監査、毎週の数え直し）。
  - `deleting` の短い間、同じブロックを送る利用者は待たされる。

## Confirmation

- 性質ベーステスト：PROP-BLK-001（参照のあるブロックを消さない）、PROP-BLK-002（`ns_ref_count` の一致）を、commit・期限切れ・GC・セッションの期限・テナントの削除を並行に流して確かめる。
- 結合テスト：GC の各段の途中の停止とやり直し、`deleting` の間の `verify` の待ち。
- 本番：参照の監査 0 件、数え直しの食い違い 0 件（[runbooks](../runbooks/README.md)）。

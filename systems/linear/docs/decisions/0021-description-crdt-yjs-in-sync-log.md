---
status: accepted
date: 2026-09-28
---

# ADR-0021: 本文の CRDT は Yjs と y-prosemirror。更新は 250ms ごとにまとめて `append` で送り、同期のログに `sync_id` の順で載せる。Worker がまとめた状態を作り、読み込みは読んだ時点までを合わせて返す

## Context

[ADR-0002](0002-sync-model.md) は、イシューの説明・コメントの本文・プロジェクトの説明を CRDT にし、更新（不透明なバイト列）を `append` で同期のログに載せると決め、部品と保存の形をこの領域に任せた。[ADR-0001](0001-platform-and-stack.md) は Yjs を第一の候補にした。[ADR-0014](0014-indexeddb-layout-durability-and-migrations.md) は手元の store の名前 `_doc_*` を予約した。

条件は次のとおり。

- 本家は、すべてのドキュメントとイシューの説明を複数の人が同時に編集できる（[Editor improvements](https://linear.app/changelog/2023-12-06-editor-improvements)、2023-12-06、2026-09-28 に確認）。本家の CRDT の部品は未検証。
- 長いオフライン（7 日。NFR-004）の編集も、失わずに合わせる。
- 本文はイシューごとに 1 つの文書で、ブロックの表をサーバーに持たない（Notion の題材との違い）。
- Writer はワークスペースの行のロックの中で書く（[ADR-0006](0006-transactions-writer-and-idempotency.md)）。ロックの中で大きな文書を読み込みたくない。
- `sync_actions` は 30 日で落とす（[ADR-0013](0013-sync-group-changes-retention-and-reset.md)）。

Yjs の文書の更新は、可換・結合的・冪等で、どの順で何回当てても同じ状態になる。`Y.mergeUpdates` は文書を読み込まずに更新をまとめるが、削除した中身のごみ集めはしない（[Document Updates](https://docs.yjs.dev/api/document-updates)、2026-09-28 に確認）。y-prosemirror は ProseMirror を同時編集にし、文書をスキーマに合うように保つ（[y-prosemirror](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror)、同）。

## Options

部品：

1. **Yjs（`Y.XmlFragment`）と y-prosemirror**
2. 自前の Fugue＋Peritext（Notion の題材の ADR-0010 と同じ）
3. Loro（WASM）
4. Automerge

サーバーでの保存：

- a. **`append` は `sync_actions` に載せ、Writer は大きさだけを数える。Worker が非同期でまとめた状態（`doc_states`）を作る。読み込みは、まとめた状態と後の `append` を合わせて返す**
- b. Writer が `append` のたびに状態へ合わせる
- c. `append` の列だけを持ち、まとめない

## Decision

1 と a を採用する。詳細は [editor-and-descriptions.md](../architecture/editor-and-descriptions.md) の 3・4 節。

- 本文は `IssueDescription` のモデル（`id` はイシューと同じ、`via` のグループ、`lazy`）の `crdt_doc` のフィールド。更新は Yjs の V1 の形。
- クライアントは打鍵ごとの更新を 250ms か入力の区切りまで貯め、`Y.mergeUpdates` で 1 つの `append` にする。
- Writer は、Yjs として読めること、1 つの更新 256 KiB、本文の状態 4 MiB、`can()` を確かめる。中身のスキーマは確かめない。
- Worker は、3 秒の静けさか 30 秒で、`Y.Doc` に読み込んでまとめ（ごみ集めを含む）、`text_plain`・メンション・バージョンを作る。保持のジョブは、まとめの済んでいない `append` を含むパーティションを落とさない。
- 遅延の読み込みは、1 つの読み取りのトランザクションで、まとめた状態と後の `append` を合わせて返す。Yjs の冪等性で、読み込みと差分の重なりと順序の揺れを気にしない。
- 手元は `_doc_state`（確定の状態）と `_doc_updates`（被覆のない本文への `append`。256 KiB を超えたら捨てる）。拒否された `append` は、確定の状態と残りの未確定から `Y.Doc` を作り直す。
- Yjs と y-prosemirror は `packages/doc` の中に閉じ、バージョンを固定する（`yjs` 13.6.33、`y-prosemirror` 1.3.7、2026-09-28 の npm の最新）。第三者の汎用の部品であり、題材の核（同期エンジン）ではない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)、AGENTS.md）。
- 2 を採らない理由：Notion は、ブロックの分割・結合で文字の ID と範囲の索引をサーバーの表で扱うために自前にした。この題材の本文は 1 つの文書で、サーバーは中身を解釈しない。リッチテキストの木（リスト、見出し、コード）と ProseMirror の束ねを自前で作る費用に見合わない。
- 3 を採らない理由：Fugue と書式の性質は Yjs より良いが、クライアントとサーバーの両方に WASM を持ち込む。ProseMirror との束ねの成熟度も Yjs に及ばない（本システムの評価）。`packages/doc` の差し替えの第一の候補として残す。
- 4 を採らない理由：リッチテキストの ProseMirror との束ねの選択肢が少ない（本システムの評価）。
- b を採らない理由：ワークスペースのロックの中で最大 4 MiB の文書を読み書きし、1 ワークスペースの書き込みの上限を下げる。
- c を採らない理由：本文を開くたびに長い列を読み、30 日の保持で古い更新が消えると本文が壊れる。

## Consequences

- 良くなること：
  - 本文の同時編集と長いオフラインの編集が、失われずに合わさる。
  - 本文の更新も同じ `sync_id` の列に載るので、欠けの検出・取り戻し・同期グループの絞り込みがそのまま効く。
  - Writer のロックの中の費用が、大きさの確かめだけで済む。
- 引き受けるコスト：
  - 中身をサーバーで検証できない。壊れていない悪い中身は、描く時に落とすだけになる。
  - Yjs の内部の形式に依存する。バージョンの更新では 1 つ前のバージョンの更新との互換を試験する必要がある。
  - まとめの Worker が止まると、保持のジョブも止まる。
  - 送りのまとめの 250ms は outbox の保証の外で、落ちると失う（組み立て中の文字は含まない）。

## Confirmation

- 性質ベーステスト：PROP-DOC-001（本文の収束）、PROP-DOC-002（失わない）、PROP-DOC-003（まとめの同値）。
- 結合テスト：保持のジョブが、まとめの済んでいない `append` のパーティションを落とさない。
- 互換の試験：`packages/doc` の Yjs のバージョンを上げる PR で、前のバージョンで作った更新と状態を、新しいバージョンで読み、同じ文書になる。
- lint：`packages/doc` の外から `yjs`・`y-prosemirror` を import することを禁止する。

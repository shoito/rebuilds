---
status: accepted
date: 2026-09-26
---

# ADR-0006: リッチテキストを、正規化したスパンの配列で持つ

## Context

ブロックのテキスト（`properties.title` など）は、装飾（太字、色、リンク）、メンション（人・ページ・日付）、インラインの数式を含む。この形は、エディタ、同時編集の統合、検索の索引、通知（メンションの抽出）、公開 API、インポートとエクスポートのすべてが読む。後から変えると、S3 で数千億になる行の書き換えになる。

本家の公開 API のリッチテキストは、`text`・`mention`・`equation` の要素の配列で、各要素が `annotations`（`bold`・`italic`・`strikethrough`・`underline`・`code`・`color`）と `plain_text`・`href` を持つ（[Rich text object](https://developers.notion.com/reference/rich-text)）。本家は同時編集のために、ブロックのテキストを RGA と Peritext を元にした CRDT でも持つ（[How Notion handles concurrent editing with CRDTs](https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts)）。

エージェントは、エディタのライブラリの JSON（ProseMirror の文書など）や HTML・Markdown をそのまま保存しがちである。

## Options

1. **HTML の文字列**
2. **Markdown の文字列**
3. **エディタのライブラリの JSON（ProseMirror の文書）**
4. **公開 API と同じ形（要素ごとに `annotations`・`plain_text`・`href` を全部持つ）**
5. **正規化したスパンの配列（テキスト＋真の装飾だけ。メンションと数式は 1 文字の atom）**

## Decision

5 を採用する。形と規則は [block-model.md](../architecture/block-model.md) の 4 節にある。

- 1 は、描画のたびに無害化が要り、XSS の攻撃面が大きい。メンションを構造として取り出せない。
- 2 は、色やメンションを表せず、方言が多い。エクスポートの形としてだけ使う。
- 3 は、保存の形がライブラリの版とスキーマに縛られる。サーバーや Worker が ProseMirror に依存する。
- 4 は、`plain_text` などの重複した値を全ブロックに持ち、値の食い違いが起きうる。公開 API の形は 5 から変換して返す（[api-and-integrations.md](../architecture/api-and-integrations.md)）。
- 5 は、平らな配列なので、同時編集の統合方式（CRDT でも操作の変換でも）の「確定した値」として扱いやすい。正規化すれば、同じ内容は同じ JSON になる。
- 位置は UTF-16 の単位で数え、メンションと数式は `‣`（U+2023）1 文字として数える。本家の内部の形もメンションに `‣` を使うと言われるが、公式の文書では確かめられなかった（未検証）。
- メンションはタイトルや名前を持たず、描画のたびに ID から引いて権限を判定する（ADR-0004）。

> 2026-09-27 の注記：本家の内部の形がメンションに `‣` を使うことは、2026-09-27 にも公式の文書で確かめられなかった（公開 API のリッチテキストは `mention` の要素で表し、`‣` は現れない）。未検証のまま残す。位置の数え方は本システムの決定で、本家の内部の形に依存しない。

## Consequences

- 良くなること：
  - 描画は React の要素の組み立てだけになり、HTML を扱わない。
  - メンションの抽出、検索の文字列、差分の判定が、配列の走査と値の比較で済む。
- 引き受けるコスト：
  - エディタの文書との変換（`packages/rich-text`）を持ち、双方向で値が変わらないことを試験する。
  - スパンの形に版を持たせ、新しい装飾やメンションの種類を足すときは、古いクライアントが未知のものを文字として描くようにする。
  - 同時編集の内部の状態（CRDT を選べば文字ごとの ID や削除の印）は、この形の外に、[collaboration.md](../architecture/collaboration.md) の決める形で別に持つ。

## Confirmation

- 性質ベーステスト：任意のスパンの配列について、正規化は冪等で、スパン → ProseMirror の文書 → スパンで値が変わらない。
- 性質ベーステスト：任意のスパンの配列の描画結果に、`<script>` などの実行可能な要素と、許可外のスキームの `href` が出ない。
- サーバーの検証：正規化されていない値、上限（[block-model.md](../architecture/block-model.md) の 10 節）を超える値を拒否する。

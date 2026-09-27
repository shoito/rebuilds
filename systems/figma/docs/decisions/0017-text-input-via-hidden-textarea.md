---
status: accepted
date: 2026-09-27
---

# ADR-0017: キャンバスの上のテキストの入力は、全ブラウザで隠した textarea で受ける。EditContext は Firefox・Safari の対応を待つ

## Context

テキストはエンジンが自分で整形して描く（[ADR-0015](0015-text-shaping-and-glyph-rendering.md)）。ブラウザの編集の部品（`contenteditable` など）の上に文字が見えるわけではないので、キーボードと IME の入力を別に受ける必要がある。[intent.md](../intent.md) は、IME での日本語の入力を MVP で扱い、重大な不具合を 4 週間で 0 件にすること（SC-5）を求め、`textarea` か EditContext かをこの領域で決め、E4 の前の PoC で確かめるとした。

事実（2026-09-27 に確認）：

- EditContext API は、任意の要素（`<canvas>` を含む）を編集の領域にし、OS の文字入力と IME を結び付ける。`textupdate`、文節の書式の `textformatupdate`、候補の窓の位置のための `characterboundsupdate` のイベントと、`updateControlBounds`・`updateSelectionBounds`・`updateCharacterBounds` を持つ（[MDN の EditContext API](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API)）。
- 仕様は W3C の Editor's Draft。EditContext の文字列は支援技術に見えないので、アクセシブルな DOM を別に持つよう求める（[EditContext API](https://w3c.github.io/edit-context/)）。
- 対応は Chrome・Edge 121 から。Firefox と Safari は未対応で、MDN は実験的とする（MDN の browser-compat-data の `api/EditContext.json`）。
- 本家がどちらを使うかは、公開されていない（未検証）。

## Options

1. **全ブラウザで隠した `textarea`**
2. Chromium では EditContext、Firefox・Safari では隠した `textarea`
3. 隠した `contenteditable`

## Decision

1 を採用する。詳細は [editor-and-tools.md](../architecture/editor-and-tools.md) の 9 節。

- テキストの編集を始めると、殻が隠した `textarea` にフォーカスを移す。
- `textarea` をカーソルの行の位置に置き、画面の上の文字の大きさに合わせる（IME の候補の窓をカーソルの近くに出すため）。`color`・`caret-color`・`background` を透明にして見えなくする。`opacity: 0` と `display: none` は使わない。
- `textarea` の中身は、カーソルのある段落（2,000 文字まで）と選択の範囲にする（再変換と文脈の変換のため）。
- `beforeinput` は既定の動作を止め、エンジンがテキストのモデルに当てる。組み立て中（`composition*`）の文字列は、エンジンが下線付きで描き、ドキュメントには書かない。`compositionend` で確定した文字列を 1 つの変更として当てる。
- 行の移動のキー（矢印、Home・End）は、エンジンが自分の行の組み立てで処理する。
- `isComposing` または `keyCode === 229` の `keydown` は、ショートカットにも移動にも使わない。
- 入力の橋渡しを 1 つのインターフェース（`TextInputBridge`）の裏に置き、EditContext の実装を後から足せるようにする。
- 2 を採らない理由：
  - 入力の経路が 2 つになり、IME × OS × ブラウザの確認の組み合わせが倍になる。SC-5 の確認の費用に見合わない。
  - Firefox・Safari の利用者には、どのみち `textarea` の経路が要る。先に 1 つの経路を固める方が、不具合を減らせる。
  - EditContext の仕様は Editor's Draft で、実験的な扱い。
- 3 を採らない理由：`contenteditable` は、ブラウザが中に要素を作り、選択と中身を勝手に変える。隠した領域の中身とエンジンのモデルの食い違いを直す費用が、`textarea` より大きい。
- EditContext は、Firefox と Safari の両方が対応した時点で、2 への切り替えを別の ADR で検討する。

## Consequences

- 良くなること：
  - すべてのブラウザで同じ経路になり、確認と修正を 1 つに集められる。
  - `textarea` は実際の文字を持つので、編集中の段落はスクリーンリーダーが読める。
- 引き受けるコスト：
  - 組み立て中の文節の区切りが分からず、全体に 1 本の下線を引く（本来の IME の表示より情報が少ない）。
  - 候補の窓の位置は `textarea` の位置に頼るので、行の途中のカーソルや縦長の行で、ずれることがある。
  - ブラウザごとの `compositionend` と `keydown` の順序の違い（**未検証**。E4 の前の `ime-textarea-poc` で記録する）を、自分で吸収する。
  - 見えなくし方が、IME とブラウザの組み合わせで効かないことがある（**未検証**。`ime-textarea-poc` で確かめる）。

## Confirmation

- PoC（E4 の前）：macOS（日本語入力、Google 日本語入力、ATOK）× Chrome・Safari・Firefox、Windows（Microsoft IME、Google 日本語入力）× Chrome・Edge・Firefox で、入力・変換・確定・再変換・候補の窓の位置・Enter の確定を記録する。
- 自動のテスト：Playwright で `composition*` の列を合成して流す（Chromium・Firefox・WebKit）。
- 性質ベーステスト：`textarea` の UTF-16 の位置と `text_content` の位置の変換が往復で一致する（PROP-EDIT-005）。
- 本番の計測：IME のイベントの順序の食い違いの件数、SC-5 の報告の件数。

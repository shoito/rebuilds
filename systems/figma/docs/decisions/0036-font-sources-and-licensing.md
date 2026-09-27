---
status: accepted
date: 2026-09-27
---

# ADR-0036: フォントの出どころは同梱のオープンなフォント・組織のフォント・端末のフォントの 3 つにし、サーバーの描画と PDF への埋め込みはライセンスの確かなものに限る

## Context

描画のエンジンは、フォントの読み込みと整形を自前で行い、ブラウザのテキストの描画を使わない（[ADR-0004](0004-gpu-rendering-in-wasm.md)）。そのため、エンジンはフォントのバイト列そのものを要る。ノードは、フォントを名前（`font_family`・`font_style`）で参照し、ファイルに埋め込まない（[document-model.md](../architecture/document-model.md) の 9.5 節）。

和文のフォントを MVP で扱う（[intent.md](../intent.md)）。和文のフォントは大きく、ライセンスの条件が厳しいものが多い。フォントのライセンス（サーバーでの描画、PDF・SVG への埋め込み、組織のフォントの配布、端末のフォントの読み取り）は法務の確認待ちである（[intent.md](../intent.md) の L1）。

本家の形（いずれも 2026-09-27 に確認）：

- Google Fonts と Apple のフォントが既定で使える。ブラウザで端末のフォントを使うには、常駐の補助のアプリ（font installer）を入れる。補助のアプリは本家のドメインからの接続だけを受ける。ChromeOS・Linux では端末のフォントを使えない（[Add a font to Figma](https://help.figma.com/hc/en-us/articles/360039956894-Add-a-font-to-Figma)）。
- Organization・Enterprise のプランで、組織・チームの管理者が .TTF・.OTF を上げられる。上げる人は、権利を持つことを確かめる（[Upload and manage shared fonts](https://help.figma.com/hc/en-us/articles/360039956774-Upload-and-manage-shared-fonts)）。

ブラウザには、利用者の許可のもとで端末のフォントの中身を読む Local Font Access API がある。対応は一部のブラウザに限られる（Chrome・Edge 103 から。Firefox・Safari は未対応。[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API) と browser-compat-data の `api/Window.json` の `queryLocalFonts`、2026-09-27 に確認）。

OpenType の `OS/2` の表の `fsType` は、フォントの埋め込みの許可を表す（0：インストール可能、2：制限付き、4：プレビューと印刷、8：編集可能。`0x0100`：サブセット不可、`0x0200`：ビットマップだけ。[OpenType の OS/2 の表](https://learn.microsoft.com/en-us/typography/opentype/spec/os2)、2026-09-27 に確認）。

## Options

端末のフォント：

1. **MVP では Chromium の Local Font Access API だけ。補助のアプリは後**
2. **MVP から補助のアプリ（本家と同じ）**
3. **端末のフォントを扱わない**

サーバーの描画と埋め込み：

- a. **同梱のフォントは使う。組織のフォントは法務の確認の後。端末のフォントは使わない（代わりのフォント）**
- b. **どのフォントも使う**（端末のフォントは、クライアントがサーバーへ上げる）

## Decision

1 と a を採用する。詳細は [export-and-assets.md](../architecture/export-and-assets.md) の 7 節。

- **同梱のフォント**：SIL OFL・Apache 2.0 で配られるフォントだけを同梱する。和文（Noto Sans JP など）を先に揃える。一覧とライセンスの文は開発リポジトリの `fonts/catalog.toml` に持つ。画面・サーバーの描画・PDF への埋め込み（サブセット）に使う。
- **組織のフォント**：組織・チームの管理者が .TTF・.OTF を上げる（本家と同じ）。上げる人の権利の確認を記録する。取り込みでは、Rust の解析器（fontations を候補）で表を検査し、`fsType` を記録する。
  - 組織のファイルを見られる人の画面に配る。ゲスト・リンクを知っている人への配布、サーバーの描画での利用、PDF への埋め込みは、L1 が決まるまで次の既定にし、該当の Story の spec を承認しない。
    - 配布：配る（配らないと、ファイルが正しく見えない）。
    - サーバーの描画：使う。
    - PDF：アウトライン化する。L1 の後は `fsType` が許すときだけサブセットを埋め込む。
- **端末のフォント**：MVP では Chromium の Local Font Access API で、利用者の許可のもとで読む。release フラグの裏に置き、L1 の後に出す。**バイト列はサーバーへ送らない。** 他の人の画面とサーバーの描画では代わりのフォントで描く。行の位置は保存された `derived_layout` で揃う。
- **補助のアプリ**は MVP の後に、別の ADR で決める。`localhost` で待ち受けるプログラムは、他のサイトからの接続、DNS の再バインド、他のローカルのプロセスへの守りが要り、配布・署名・更新の運用も増える。
- 2 を採らない理由：上の守りと運用を、MVP の前に持つことになる。Chromium の利用者が多い（**未検証**。日本の企業の管理された端末のブラウザの割合は、E2 の `client-frame-telemetry` で数える）なら、API で多くの利用者に届く。
- 3 を採らない理由：デザイナーは、ブランドのフォントを端末に入れて使う。組織のフォントだけでは、組織のプランでない利用者が困る。
- b を採らない理由：端末のフォントをサーバーへ上げることは、利用者の端末のライセンス（多くは 1 台・1 人）の外で、フォントを複製・配布することになりうる。

## Consequences

- 良くなること：
  - 同梱のフォントは、画面・サーバー・PDF で同じ見た目になり、ライセンスの問題がない。
  - 端末のフォントのバイト列が、端末の外へ出ない。
  - 法務の結論に合わせて、組織のフォントの扱いを変えられる（既定は安全側の PDF のアウトライン化）。
- 引き受けるコスト：
  - Firefox・Safari の利用者は、MVP で端末のフォントを使えない。
  - 端末のフォントを使ったファイルは、他の人の画面・サムネイル・API の画像で見た目が変わる。「フォントがありません」の表示と `substituted_fonts` で知らせる。
  - 和文のフォントの読み込みの時間とメモリ（NFR-003・004）。E2 の `bundled-font-catalog` で計測する。

## Confirmation

- 表駆動のテスト：`fsType` の値ごとに、PDF での埋め込みとアウトライン化が表のとおりになる。
- 結合テスト：端末のフォントを使ったテキストを含むファイルを開いて編集しても、フォントのバイト列を含む要求がサーバーへ送られない（ネットワークの記録で確かめる）。
- fuzzing：フォントの解析器。任意のバイト列で落ちない。
- 監査：同梱のフォントの一覧のすべての行に、ライセンスの文と出典がある（CI で検査）。

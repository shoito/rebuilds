# Web Client: Dropbox

Web の画面（SPA）の組み立てを決める。どの画面がどの領域の決定を使うか、アクセシビリティ、UI の言語と入力（IME）、名前と日時の表示を扱う。E7 の Story がこの文書を使う。

前提となる決定は次のとおり。この文書で新しく採った ADR はない（2026-10-10 に、各領域に散っていた Web の画面の決定をまとめ、アクセシビリティと言語を足した）。

- Web は React の SPA で、アップロードの分割は `sync-core` の WASM で、デスクトップ・モバイルと同じ規則にする（[ADR-0001](../decisions/0001-platform-and-stack.md)、[README.md](README.md) の 1.2 節）
- ノードは ID で指し、名前は NFC で持ち、一意は `name_key`（NFC＋case folding）で決める（[ADR-0008](../decisions/0008-node-identity-and-names.md)）
- フォルダーの ZIP は `export-builder` がサーバーで組み立てる。10,000 ファイル・20 GiB まで（[ADR-0054](../decisions/0054-server-assembled-downloads.md)）
- 利用者の中身は `<brand>usercontent.<domain>` からだけ返し、本体のドメインは厳しい CSP で守る（[security.md](security.md) の 4 節）
- 法務の確認待ち：L1（Web の画面の外部送信規律の公表、分析の計測）、L10（画面の見た目と操作を本家に寄せる範囲）

## 1. 範囲

- 扱う：
  - 画面と、その画面が使う領域の決定の対応
  - アクセシビリティ（WCAG 2.2 AA）
  - UI の言語、IME、名前・日時・大きさの表示
- 扱わない：
  - 権限の判定（[namespaces-and-sharing.md](namespaces-and-sharing.md)、`can()`）
  - 分割とアップロードの手順（[block-storage.md](block-storage.md)）
  - 資産の配布と、開いたままのタブの古い資産（[delivery.md](delivery.md) の 5.6 節）
  - RUM（[observability.md](observability.md) の 4.3 節）
  - 共有リンクを開いた人の画面の権限と上限（[shared-links.md](shared-links.md)）。見た目と操作の規則（3・4 節）は同じものを使う

## 2. 要件

| 要件 | 目標 | NFR |
| --- | --- | --- |
| 一覧の速さ | Web の一覧の表示 p95 1 秒 | NFR-001 |
| 漏れ | 読めない名前空間の名前・中身・有無が画面に出ない。名前・パス・検索の語を RUM に送らない | NFR-007、[observability.md](observability.md) の 4.3 節 |
| アクセシビリティ | 利用者の画面と共有リンクの画面が WCAG 2.2 AA を満たす | [quality.md](../quality.md) の 2.2 節 |
| IME | 変換の確定の `Enter` で、名前の変更・検索・フォルダーの作成を確定しない | [quality.md](../quality.md) の 1 節のリスク 10 |

## 3. 画面と使う決定

| 画面 | 使う決定 | Story |
| --- | --- | --- |
| 一覧、並べ替え、パンくず、選択 | 大きなフォルダーのページング（[ADR-0023](../decisions/0023-tree-listing-snapshot-and-journal-retention.md)） | `web-browse` |
| フォルダーごとのアップロード | `sync-core` の WASM の分割、再開（[block-storage.md](block-storage.md)）、名前の受け付け（[ADR-0008](../decisions/0008-node-identity-and-names.md)） | `web-upload-wasm` |
| ダウンロード、フォルダーの ZIP | [ADR-0054](../decisions/0054-server-assembled-downloads.md) | `web-download` |
| 共有フォルダー、共有リンク | [namespaces-and-sharing.md](namespaces-and-sharing.md)、[shared-links.md](shared-links.md) | `web-share-ui` |
| バージョン履歴、削除したファイル、巻き戻し | [versions-and-recovery.md](versions-and-recovery.md) | `web-restore-ui` |
| プレビュー、検索 | [previews-and-thumbnails.md](previews-and-thumbnails.md)、[search.md](search.md) | E9 の Story |
| 名前の変更・検索の入力 | 5 節 | `web-ime` |

## 4. アクセシビリティ

利用者の画面と共有リンクの画面を WCAG 2.2 AA に合わせる。デスクトップの UI も同じ React の部品を使うので、同じ規則に従う（[desktop-client.md](desktop-client.md) の 5 節）。

- **一覧**：ファイルの一覧は、行と列の意味を持つ表（`grid`）にし、名前・種類・大きさ・更新の日時・共有の状態を列として読み上げる。共有の状態や同期の状態を、アイコンの色だけで示さない（文の代わりのラベルを持つ）。
- **キー操作**：一覧の移動（矢印、Home・End）、選択（Space、Shift と Ctrl・Cmd での範囲と追加）、開く（Enter）、名前の変更（F2）、削除（Delete）をキーで行える。マウスの右クリックのメニューと同じ操作を、行のメニューのボタンからも出せる。
- **ドラッグ・アンド・ドロップの代わり**：移動とアップロードは、ドラッグのほかに「移動先を選ぶ」の対話とファイルの選択のボタンで行える（WCAG 2.2 の 2.5.7）。
- **進み具合と結果**：アップロード・ZIP の組み立て・復元・巻き戻しの進み具合と終わりを live region で知らせる。読み上げを埋めないよう、知らせは 10% ごとと終わりだけにする。失敗は、どのファイルが、なぜ、どうすればよいかを文で出す。
- **衝突と取り消せない操作**：競合のコピー、完全な削除、巻き戻しの確認の対話は、フォーカスを対話の中に閉じ、取り消せない操作の結果を文で示す。
- **プレビュー**：画像のプレビューには名前を代わりの文として持たせる。動画のプレビューは再生の操作をキーで行える。字幕の生成は持たない（[previews-and-thumbnails.md](previews-and-thumbnails.md) の範囲の外）。
- **色と動き**：コントラスト 4.5:1 以上。OS の「視差効果を減らす」の設定では、一覧の入れ替えの動きを止める。
- **試験**：[quality.md](../quality.md) の 2.2 節のアクセシビリティの行（axe を PR で、読み上げの手動を E7 のリリースの前に）。

## 5. 言語と入力

### 5.1 UI の言語

- UI の言語は日本語と英語。初めはブラウザーの言語で選び、どちらでもなければ英語。アカウントの設定で変えられる。デスクトップは OS の言語で選ぶ（[desktop-client.md](desktop-client.md) の 5.3 節）。
- 文言は ICU MessageFormat で持ち、件数の複数形と語順を言語ごとに書く（「3 件のファイル」と "3 files"）。文言を連結して文を作らない。
- 利用者の中身（ファイルの名前、フォルダーの名前、共有の相手の名前）は訳さない。

### 5.2 IME

- 名前の変更・フォルダーの作成・検索の入力は、変換の途中（`compositionstart` から `compositionend` まで、`isComposing`）の `Enter` を確定に使わない。Safari の `compositionend` の後の `keydown` の順序の違いも試験に入れる（[quality.md](../quality.md) の 1 節のリスク 10）。
- 検索の入力の語の送信は、変換の確定の後だけにする（変換の途中の文字で検索を投げない）。

### 5.3 名前の表示と受け付け

- 名前の正規化は画面で独自に行わない。受けた名前は NFC にしてから送り、重複の判定は `name_key` を返すサーバーに任せる（[ADR-0008](../decisions/0008-node-identity-and-names.md)。`packages/names` の TypeScript の実装は試験のベクトルを共有する。[delivery.md](delivery.md)）。
- 画面での名前の重複の警告（大文字小文字だけ、NFC と NFD の違いだけ）は、`packages/names` の `name_key` で出し、確定はサーバーの応答で決める。
- macOS のブラウザーから NFD の名前のファイルをアップロードしても、サーバーの名前は NFC になる。同期した macOS の端末の手元の名前の扱いは [file-system-integration.md](file-system-integration.md) の 7.2 節。
- 長い名前は中を省いて出す（拡張子を残す）。省いた名前でも、読み上げとツールチップに全体を出す。

### 5.4 日時と大きさ

- 日時は利用者の時刻帯（ブラウザーの時刻帯）で、UI の言語の形（`Intl.DateTimeFormat`）で出す。巻き戻しの時点の選択では、時刻帯を画面に書き、サーバーへは RFC 3339 の UTC で送る（[data-model.md](data-model.md) の規約）。
- 大きさは 2 の累乗の単位（KiB、MiB）で数え、表示の単位の書き方は UI の言語に合わせる。容量の数え方そのものは [namespaces-and-sharing.md](namespaces-and-sharing.md)。

## 6. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E7 | `web-a11y-baseline` | 4 節のキー操作・読み上げ・ドラッグの代わり、axe の PR の検査 |
| E7 | `web-i18n` | 5.1 節の UI の言語と ICU MessageFormat、5.4 節の日時と大きさ |
| E7 | `web-ime` | 5.2 節（既存の Story） |

## 7. 未解決の問い

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 一覧の並べ替えの順序（言語ごとの照合を使うか、大きなフォルダーのページングとどう合わせるか） | `web-browse` の spec（DB の照合順序は `"C"` のまま。[data-model.md](data-model.md)） |
| 日本語と英語の外の UI の言語 | MVP の後。PM が市場で決める |
| 画面の見た目と操作の寄せ方 | 法務の L10 |
| 分析の計測と外部送信規律の公表 | 法務の L1 |

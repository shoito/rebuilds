# Editor: Notion

Web クライアントとデスクトップアプリ、エディタの設計。ブロックとリッチテキストの形は [block-model.md](block-model.md)、同時編集の統合・配信・オフラインの統合は [collaboration.md](collaboration.md) にある。モバイルのネイティブアプリは作らない（[intent.md](../intent.md) の Non-goals）。

前提として、次の決定に従う。

| 決定 | クライアントへの影響 |
| --- | --- |
| [ADR-0002](../decisions/0002-everything-is-a-block.md) | 画面の単位はブロック。1 つのブロックを 1 つの React のコンポーネントで描く |
| [ADR-0004](../decisions/0004-inherited-page-permissions.md) | 読めないページ・同期ブロックは、サーバーが中身を返さない。クライアントは「アクセスできない」を出すだけで、判定を持たない |
| [ADR-0005](../decisions/0005-transactions-as-unit-of-change.md) | エディタの 1 つの動作を、1 つのトランザクションにする |
| [ADR-0006](../decisions/0006-rich-text-as-normalized-spans.md) | ブロックの中のテキストは、正規化したスパンの配列 |
| [ADR-0007](../decisions/0007-block-editor-with-per-block-prosemirror.md) | ブロックの層は自前で作り、ブロックの中のテキストの編集に ProseMirror を使う |
| [ADR-0008](../decisions/0008-sqlite-wasm-opfs-local-store.md) | ローカルの保存は SQLite（WASM）と OPFS |
| [ADR-0009](../decisions/0009-electron-desktop-shell.md) | デスクトップアプリは Electron で包む |
| [ADR-0032](../decisions/0032-desktop-uses-wasm-sqlite-in-s1.md) | S1 はデスクトップも Web と同じ WASM の SQLite（OPFS）。ネイティブの SQLite は S2 の候補 |
| Slack の [client.md](../../../slack/docs/architecture/client.md) | 対応ブラウザ、ルーター、デザインシステム、CSP、i18n、a11y の方針を引き継ぐ。違うところだけをこの文書に書く |

## 1. 対応環境

| 環境 | 対応 |
| --- | --- |
| Chrome / Edge / Firefox（デスクトップ） | 最新 2 メジャー（Firefox は ESR も） |
| Safari（macOS、iOS / iPadOS） | 17 以上。Slack の下限と同じ |
| デスクトップアプリ | macOS（直近 3 バージョン）、Windows 10 / 11（x64、arm64） |

- Safari 17 を下限にするのは、Slack と揃えることに加え、SQLite の `opfs-sahpool` が Safari 16.4 以上で動くためである（[sqlite.org の persistence の文書](https://sqlite.org/wasm/doc/trunk/persistence.md)）。
- デスクトップの Linux 版は MVP に含めない。本家の公式のダウンロードも Mac と Windows である（[Download Notion for desktop](https://www.notion.com/desktop)）。

## 2. アプリの骨格

### 2.1 構成

```
apps/web/
├── src/app/          # ルート、レイアウト、エラー境界
├── src/features/     # sidebar, page, database, search, comments, share, settings ...
├── src/editor/       # ブロックの層（4〜8 節）
│   ├── blocks/       # 種類ごとのブロックのコンポーネント
│   ├── inline/       # ブロックの中のテキストの編集（ProseMirror）
│   ├── selection/    # テキストの選択とブロックの選択
│   ├── commands/     # スラッシュコマンド、Markdown のショートカット、キー操作
│   └── clipboard/    # コピーと貼り付け
├── src/records/      # RecordStore、applyOperation（packages/ops を使う）
├── src/sync/         # 同期エンジン（SharedWorker でもタブでも動く）
├── src/storage/      # SQLite のワーカーとスキーマ
├── src/sw/           # Service Worker
└── src/i18n/
apps/desktop/         # Electron の main と preload（11 節）
packages/ops/         # 操作の定義と適用、不変条件の検査。サーバーと共有
packages/rich-text/   # スパンの正規化、ProseMirror の文書との変換、plain_text
packages/ui/          # デザインシステム（Slack と同じ作り）
```

- ルーターは TanStack Router、サーバーの状態のうちレコードでないもの（検索の結果、メンバーの候補、共有の設定の画面）は TanStack Query で持つ。Slack と同じ。
- `packages/ops` と `packages/rich-text` は、DOM と React に依存させない。サーバー・同期エンジン・エディタで同じコードを動かす。

### 2.2 ルート

| パス | 画面 |
| --- | --- |
| `/{workspace_slug}` | 最後に開いたページ、なければホーム |
| `/{workspace_slug}/{page_id}` | ページ。データベースの行もこれで開く |
| `/{workspace_slug}/{page_id}?p={row_page_id}` | データベースの上に行を横のパネルで開く |
| `/{workspace_slug}/{page_id}#{block_id}` | ブロックへのリンク。そのブロックまでスクロールし、一時的に強調する |
| `/{workspace_slug}/trash`、`/settings/...` | ゴミ箱、設定 |

- URL にタイトルを入れない（[block-model.md](block-model.md) の 6 節）。
- 読めないページと存在しないページは、同じ「見つかりません」を出す（ADR-0004）。

### 2.3 データの流れ

```
┌───────────── Tab (React) ─────────────┐         ┌──── SharedWorker ────┐
│ Block components                       │         │ Sync engine          │
│   └ useRecord(id)  ◀── RecordStore ◀───┼─────────┤  - WebSocket         │
│ Inline editors (ProseMirror, per block)│  Port   │  - page subscriptions│
│ Editor controller                      │────────▶│  - TransactionQueue  │
│   - selection, commands, undo          │         └─────────┬────────────┘
└───────────────────┬────────────────────┘                   │ query
                    │ query                                  ▼
                    └────────────────────────▶  SQLite worker (1 tab only)
                                                 OPFS (opfs-sahpool)
```

- 同期エンジンは Slack と同じく SharedWorker に置く。SQLite は、OPFS の同期アクセスが専用ワーカー（dedicated worker）でしか使えないため、選ばれた 1 つのタブの専用ワーカーに置く（[ADR-0008](../decisions/0008-sqlite-wasm-opfs-local-store.md)）。
- エディタの操作は、`packages/ops` の操作の列を作って Editor controller に渡す。controller は RecordStore に楽観的に当て、TransactionQueue に入れる。確定・当て直しは [collaboration.md](collaboration.md) に従う。

## 3. エディタの方式

[ADR-0007](../decisions/0007-block-editor-with-per-block-prosemirror.md) で選んだ。

- **ブロックの層は自前**：ページの木の描画、ブロックの選択、並べ替え、インデント、種類の変更、仮想化は、ブロックの木（RecordStore）を直接扱う React のコンポーネントで作る。
- **テキストの編集は ProseMirror**：テキストを持つブロック 1 つにつき、ProseMirror の `EditorView` を 1 つ置く。スキーマはスパンの形に合わせた最小のもの（段落 1 つ、テキスト、装飾、メンションと数式のインラインの atom）にする。
- **変換**：ProseMirror の文書とスパンの配列は、`packages/rich-text` の純関数で相互に変換する。ProseMirror の `Step` を、ブロックのテキストへの操作（位置は UTF-16）に変えて送る。
- 本家のエディタは、ブロックごとに `contenteditable` の要素を持つ自前の実装だと言われるが、公式の文書で確かめられなかった（未検証。2026-09-27 にも、本家の公式の文書には「テキストのエディタを作り直した」という更新の記録しか見つからなかった）。ブロックごとに編集の領域を分ける形は、本家に寄せたものである。

### 3.1 テキストの選択とブロックの選択

| 操作 | 結果 |
| --- | --- |
| 1 つのブロックの中でドラッグ・`Shift+矢印` | そのブロックの ProseMirror の中のテキストの選択 |
| ドラッグがブロックの外に出た、`Shift+↑/↓` でブロックの端を越えた | 通ったブロックを丸ごと選ぶ「ブロックの選択」に切り替える |
| `Esc` | 今のブロックを選ぶ（本家と同じ） |
| ブロックの選択中に `↑/↓`、`Shift+↑/↓` | 選ぶブロックを動かす・広げる |
| ブロックの選択中に `Delete`、`Cmd/Ctrl+C/X/D`、`Tab`、`Cmd/Ctrl+/` | 削除、コピー、切り取り、複製、インデント、種類の変更 |

- 複数のブロックにまたがる部分的なテキストの選択は、MVP では作らない。ブロックの選択に切り替える。本家は、デスクトップ（Firefox を除く）とモバイルで、ブロックをまたぐ部分的な選択を扱う（[Writing & editing basics](https://www.notion.com/help/writing-and-editing-basics)、2026-09-27 に確認）。MVP で作らないのは本家との差異である。
- ブロックの間のカーソルの移動（`↑` で上のブロックの同じ横位置へ）は、controller が ProseMirror の `coordsAtPos` と `posAtCoords` を使って行う。

### 3.2 構造を変えるキー操作

| キー | 動作 | 1 つのトランザクションに含める操作 |
| --- | --- | --- |
| `Enter` | ブロックを分割する。後ろ半分を新しいブロックにする | テキストの削除、新しいブロックの作成、親の `content` への挿入 |
| 行頭の `Backspace` | 前のブロックと結合する。子は前のブロックの子の末尾へ | テキストの挿入、`content` の移動、ブロックの削除 |
| `Tab` / `Shift+Tab` | インデント・戻す | 親の変更（移動） |
| `Cmd/Ctrl+Shift+↑/↓` | ブロックを上下へ動かす | 移動 |
| `Cmd/Ctrl+D` | 複製 | 部分木の作成（新しい ID） |

- 空のリストの項目で `Enter` を押すと、リストを抜けて `paragraph` にする。
- 日本語の変換（IME）の間は、これらを実行しない。`compositionstart`〜`compositionend` の間と、`isComposing` が真または `keyCode === 229` の `keydown` は無視する（Slack の client.md の 5.1 節と同じ判定）。
- 取り消し（`Cmd/Ctrl+Z`）は、ページごとに自分のトランザクションの逆の操作を積む。他の人の変更は取り消さない。同時編集と重なったときの逆の操作の作り方は [collaboration.md](collaboration.md) で決める。

## 4. 描画と巨大なページ

NFR-002（1,000 ブロックのページを、キャッシュなしで p75 1.5 秒、ローカルにあれば 300ms）を満たし、10 万ブロックまで開けるようにする。

### 4.1 読み込み

- ページを開いたら、まず RecordCache（SQLite）から読んで描く。同時に API の読み込みを始め、バージョンの新しいものだけを差し替える。本家は、遅い端末では SQLite と API の速い方を使う（[How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)）。これに倣う。
- API は、ページの中のブロックを文書の順（深さ優先）に区切って返す。最初の区切りは、画面の最初の表示に要る 100 ブロック程度にし、残りを続けて取る。本家の `loadPageChunk` にあたる（[The data model behind Notion's flexibility](https://www.notion.com/blog/data-model-behind-notion)、2026-09-27 に確認）。
- 描画は、最初の区切りが届いた時点で始める。読み込み中の後ろの部分は、高さの見積もりの分だけ場所を取っておく。

### 4.2 描画の段

| ページのブロックの数 | 描き方 |
| --- | --- |
| 2,000 まで | 全ブロックを DOM に置く。各ブロックに `content-visibility: auto` と `contain-intrinsic-size` を付け、画面の外のレイアウトと描画を省く |
| 2,000 を超える | 最上位のブロックを単位に、TanStack Virtual で画面とその前後だけを DOM に置く |

- `content-visibility` は Chrome 85、Firefox 125、Safari 18 から使える（[MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/css/properties/content-visibility.json)、2026-09-26 に確認）。Safari 17 では効かないが、表示は正しい。
- 2,000 までを全件の DOM にするのは、ブラウザのページ内の検索、印刷、スクリーンリーダーの読み上げが、そのまま効くようにするため。
- 仮想化したページでは、ブラウザのページ内検索が画面の外を見つけられない。`Cmd/Ctrl+F` を奪わず、ページのメニューに「ページ内を検索」を置く。
- 仮想化しても、フォーカスのあるブロック、選択の起点と終点、ドラッグ中のブロックは DOM から外さない。

### 4.3 ProseMirror の生成を遅らせる

1,000 個の `EditorView` を最初に作ると、NFR-002 に収まらない（見積もり。E3 の着手前に計測で確かめる）。

- テキストのブロックは、最初は、スパンの配列を React の要素として描く（静的な描画。ProseMirror を使わない）。
- 画面とその前後（`IntersectionObserver` で 1 画面分の余白）に入ったブロックから、`requestIdleCallback` で順に `EditorView` を作って差し替える。差し替えの前後で DOM の見た目は同じにする。
- `pointerdown`、キー操作によるフォーカスの移動、他の人のカーソルの表示が来たブロックは、その場で `EditorView` を作る。`pointerdown` の座標は、作った後に `posAtCoords` でカーソルの位置に直す。
- 画面から遠く離れた `EditorView` は破棄する（同時に 300 個まで）。
- 静的な描画と ProseMirror の描画は、同じ `packages/rich-text` の変換を通し、見た目の回帰テストで一致を確かめる。

## 5. スラッシュコマンド

- 行の中で `/` を打つと、メニューを出す。日本語入力の全角の `／` でも出す。`・`（macOS の日本語入力で `/` のキーが出す文字）では出さない（本家の日本語入力での振る舞いは未検証）。
- メニューは WAI-ARIA の combobox（入力はブロックのテキストのまま、候補は `listbox`、`aria-activedescendant`）で作る。`/` の後の文字で絞り込み、`↑/↓` で選び、`Enter` で実行、`Esc` か空白 2 回で閉じる。
- 候補の検索は、表示の言語の名前と英語の名前の両方に当てる（例：`/見出し` と `/h1` のどちらでも見出し 1）。
- 候補：3 節の種類への変換・挿入、ページ、メンション（人・ページ・日付）、インラインの数式、色、ブロックの操作（削除、複製、移動先）。
- 実行したら、`/` と絞り込みの文字を消す操作と、ブロックの挿入・変換の操作を、1 つのトランザクションにする。
- `Cmd/Ctrl+/` は、選んだブロックに対して同じメニューを「変換」の候補だけで出す（本家と同じ。[Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)）。

## 6. Markdown のショートカット

本家の Markdown 形式のショートカットに合わせる（[Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)）。

| 行頭で打つもの | 変換先 |
| --- | --- |
| `*`・`-`・`+` と空白 | `bulleted_list_item` |
| `1.`・`a.`・`i.` と空白 | `numbered_list_item` |
| `[]` と空白 | `to_do` |
| `>` と空白 | `toggle` |
| `"` と空白 | `quote` |
| `#`・`##`・`###` と空白 | `heading_1`〜`heading_3` |
| `` ``` `` | `code` |
| `---` | `divider` |

| 行の中で打つもの | 装飾 |
| --- | --- |
| `**文字**` | 太字 |
| `*文字*` | 斜体 |
| `` `文字` `` | コード |
| `~文字~` | 取り消し線 |
| `$$式$$` | インラインの数式（本家と同じ。[Math equations](https://www.notion.com/help/math-equations)、2026-09-27 に確認） |

- 変換は、変換の直後の `Backspace` で打った文字に戻せる（取り消しの 1 段）。
- IME の変換中は判定しない。変換を確定した文字は判定の対象にする（全角の `＃` や `＊` は対象外）。
- ProseMirror の `InputRule` で行の中の装飾を判定し、行頭の変換はブロックの層で判定する（変換はブロックの `type` の変更なので）。

## 7. ドラッグでの並べ替え

- 各ブロックの左に、ホバーで取っ手（`⋮⋮`）と `+`（下にブロックを追加）を出す。
- ドラッグは Pointer Events で自前に作る。HTML5 の Drag and Drop API は、見た目の制御と、仮想化したリストでの自動スクロールが難しいため使わない。OS からのファイルのドロップ（アップロード）だけ、`dragover` / `drop` を使う。
- 落とす位置は、ブロックの上半分・下半分で前後を決め、右へずらすと子として入れる。落とす位置に青い線を出す。
- 複数のブロックの選択中は、選んだブロックをまとめて動かす。
- サイドバーのページの上に落とすと、そのページの末尾へ移す。ページをまたぐ移動なので、移動先への編集の権限をサーバーが検査する。拒否されたら元に戻して知らせる。
- ドラッグの代わりに、取っ手のメニューの「上へ」「下へ」「移動先…」と、`Cmd/Ctrl+Shift+↑/↓` を用意する（WCAG 2.5.7）。

## 8. 貼り付けとコピー

### 8.1 貼り付け

| クリップボードの中身 | 扱い |
| --- | --- |
| このアプリのブロック（`text/html` に埋めた JSON） | ブロックとして解析し、新しい ID を振って挿入 |
| `text/html`（他のサイト・アプリ） | 許可リストでブロックとスパンに変換 |
| `text/plain` で Markdown と判定できる | Markdown を解析してブロックに変換 |
| `text/plain` | 改行ごとに `paragraph` |
| ファイル・画像 | アップロードして `image` / `file` |
| URL だけ | リンクとして貼る。メニューで「埋め込み」「メンション」に変えられる |

HTML の無害化の方針：

- HTML は `DOMParser` で解析する。`DOMParser` の文書ではスクリプトが実行されず、画像も読み込まれない。解析した木を、許可リストの要素（`p`、`h1`〜`h6`、`ul`、`ol`、`li`、`blockquote`、`pre`、`code`、`a`、`strong`、`b`、`em`、`i`、`u`、`s`、`del`、`img`、`hr`、`br`、`input[type=checkbox]`、`table` の中身のテキストなど）だけを見てブロックとスパンに写す。HTML を文字列のまま保存・描画することはしない（ADR-0006）。
- 許可リストにない要素は、中のテキストだけを残す。`script`、`style`、`iframe`、`object`、`template`、`svg`、`math` と、イベントの属性は中身ごと捨てる。
- `href` と `src` は、`http:` / `https:` / `mailto:` だけを残す。`javascript:`、`data:`、`vbscript:` は捨てる。外部の画像は `external` の `image` にし、表示は画像のプロキシ経由にする（[block-model.md](block-model.md) の 3 節）。
- このアプリのブロックの JSON も、他のサイトが同じ形を作れるので、信用しない。スキーマで検証し、ID を振り直し、ページのメンションと同期ブロックの参照は、貼り付ける人が元を読めるときだけ残す。読めなければ、メンションは文字に、同期ブロックの参照は元の中身の写しに変える。ワークスペースの違う参照も写しに変える（ADR-0003）。
- 大きな貼り付けは、1,000 ブロックごとのトランザクションに分ける（[block-model.md](block-model.md) の 10 節）。

### 8.2 コピー

- ブロックの選択をコピーしたら、`text/plain`（Markdown）、`text/html`（スパンから生成した HTML ＋このアプリのブロックの JSON を `data-` 属性に埋めたもの）の 2 つを書く。
- JSON には、ワークスペースの ID とブロックの値を入れる。権限で見えていない同期ブロックの中身は、画面に出ていないので含まない。

## 9. メンションと補完

| 入力 | 候補 | 取得元 |
| --- | --- | --- |
| `@`（全角の `＠` も） | 人、ページ、日付 | 人は最近の相手を先に出し `GET .../members?query=`。ページは検索の API（権限で絞った結果、[search.md](search.md)）。日付は入力の解釈 |
| `[[` | ページへのリンク、子ページの作成 | 検索の API |
| `+` | 子ページの作成、ページへのリンク | 同上（本家と同じ。[Keyboard shortcuts](https://www.notion.com/help/keyboard-shortcuts)、2026-09-27 に確認） |

- 日付は、「今日」「明日」「来週の金曜」「2026/10/1」と、英語の同じ表現を解釈する。解釈の結果は、アカウントのタイムゾーンで `date` のメンションにする。
- 候補の一覧は WAI-ARIA の combobox で作る。確定した候補は文字列でなく、スパンのメンション（ID）として入れる（ADR-0006）。
- 人のメンションの通知は、クライアントが送らない。サーバーが確定したトランザクションの前後のスパンを比べ、新しく入ったメンションから作る（[comments-and-notifications.md](comments-and-notifications.md)）。
- 描画では、メンションの先を ID で引き、読めないページは「アクセスできないページ」と出す（[block-model.md](block-model.md) の 4.4 節）。

## 10. ローカルの保存

[ADR-0008](../decisions/0008-sqlite-wasm-opfs-local-store.md) で選んだ。本家の Web 版の形に合わせる（[How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)）。

- `@sqlite.org/sqlite-wasm` の `opfs-sahpool` の VFS を使う。COOP / COEP のヘッダーが要らず、Safari 16.4 以上で動く。
- `opfs-sahpool` は同時に 1 つの接続しか持てない。各タブが専用ワーカーを持ち、Web Locks でロックを取った 1 つのタブのワーカーだけが SQLite を開く。他のタブの読み書きは、SharedWorker が、そのタブのワーカーへ回す。ロックを持つタブが閉じたら、次のタブがロックを取って開き直す。
- 本家は、複数のタブが同時に書いたことで、同じ ID で中身の違う行ができる破損を経験し、この 1 タブだけが書く形にした（同じ出典）。

| 表 | キー | 中身 |
| --- | --- | --- |
| `records` | `(record_type, workspace_id, id)` | 値、`version`、属するページ、ページの確定した `seq`、最後に使った時刻 |
| `transaction_queue` | `transaction_id` | 未確定のトランザクション、作った時刻、試行の回数、状態 |
| `offline_pages` | `(workspace_id, page_id)` | オフラインで使えるページ、最後に取得した時刻 |
| `offline_actions` | `(workspace_id, page_id, reason)` | オフラインに置く理由（本人の指定、お気に入り、親からの継承、最近開いた） |
| `text_states` | `(workspace_id, block_id, field)` | ブロックのテキストの CRDT の状態（[collaboration.md](collaboration.md) の 5 節） |
| `failed_changes` | `(workspace_id, id)` | 送れなかった変更（本人が入力したテキストと作ったブロック。30 日。[collaboration.md](collaboration.md) の 10.1 節） |
| `recent_pages` | `(workspace_id, page_id)` | 最近開いたページと時刻（クイック検索、検索の加点、オフラインの理由「最近開いた」） |
| `meta` | 固定 | スキーマのバージョン、総量、`device_id`、次の `tx_counter` |

列・索引の正は [data-model/client.md](data-model/client.md)。

- `offline_pages` と `offline_actions` は、本家の `offline_page`・`offline_action` の形に合わせた。理由を複数持ち、最後の理由がなくなったときだけページを外す（[How we made Notion available offline](https://www.notion.com/blog/how-we-made-notion-available-offline)）。オフラインのページの更新の取り方は [collaboration.md](collaboration.md) で決める。
- `records` は、オフラインのページの部分木と `transaction_queue` が参照するレコードを除いて、LRU で追い出す。総量は 500MB を目安にする（既定案）。
- データベースのファイルはアカウントごとに分ける。ログアウトしたら、そのアカウントのファイルを消す。
- OPFS が使えない、または開けない（プライベートブラウズなど）ときは、メモリだけで動く。オフラインの機能は使えないと画面に出す。IndexedDB の実装を別に持たない。
- プライベートブラウズでの OPFS は、ブラウザごとに違う（2026-09-27 に確認）。
  - Chrome のシークレットでは開けるが、メモリの上にあり、セッションの終わりに消える（[Chromium の FileSystem の README](https://chromium.googlesource.com/chromium/src/+/main/storage/browser/file_system/README.md)）。オフラインの機能は動くが、ウィンドウを閉じると未確定のトランザクションも消える。これは受け入れ、未確定のトランザクションがあるときは閉じる前に警告する。
  - Firefox のプライベートウィンドウでは `getDirectory()` が `SecurityError` になる（[MDN の getDirectory](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory)、[Bug 1975760](https://bugzilla.mozilla.org/show_bug.cgi?id=1975760)。対応は進行中）。
  - Safari のプライベートブラウズでは使えない（[The File System Access API with Origin Private File System](https://webkit.org/blog/12257/the-file-system-access-api-with-origin-private-file-system/)、2022 年の記事。より新しい公式の記述は見つからなかった）。
  - 実際の挙動は E4 の前の `opfs-poc` で各ブラウザの現行バージョンで確かめる。
- Safari は、ホーム画面に追加していないサイトのスクリプトが書いたデータを、操作のない 7 日の後に消す（[WebKit の Tracking Prevention](https://webkit.org/tracking-prevention/)）。Safari 17 の保存の方針は、File System（OPFS）も対象にし、操作のない期間による追い出しを含む（[Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)、2026-09-27 に確認）。OPFS も消えるものとして扱い、消えても API から取り直して動くようにする。未確定のトランザクションが消えうることは、オフラインの設定の画面で知らせる。

## 11. デスクトップアプリ

[ADR-0009](../decisions/0009-electron-desktop-shell.md) で Electron を選んだ。本家のデスクトップアプリも Electron で作られている（[Electron の公式サイト](https://www.electronjs.org/)の採用例、[10 years of Electron](https://www.electronjs.org/blog/10-years-of-electron)、2026-09-27 に確認）。

- レンダラーは Web のクライアントと同じ成果物を、アプリのオリジンから読み込む。ローカルの保存も Web と同じ SQLite（WASM、OPFS）を使う。本家のデスクトップは、親のプロセス 1 つがネイティブの SQLite に書く（[How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)）が、S1 は実装を 1 つにすることを優先する（[ADR-0032](../decisions/0032-desktop-uses-wasm-sqlite-in-s1.md)）。
- セキュリティの設定：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`。アプリのオリジン以外へのナビゲーションは止め、外部のリンクは既定のブラウザで開く。`preload` が `contextBridge` で出す API は、通知、バッジ、ディープリンク、自動更新、ウィンドウの操作だけにする。
- ディープリンク（`<brand>://`）で、ブラウザのリンクからアプリのページを開く。スキームの名前は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従って後で決める。
- 自動更新は、署名と公証（macOS）をした配布物を、段階的に出す（[delivery.md](delivery.md)）。Electron の新しいメジャーには、出てから 8 週以内に上げる。
- 複数のウィンドウは、Web の複数のタブと同じに扱う（SharedWorker と Web Locks がそのまま効く）。

## 12. アクセシビリティ（WCAG 2.2 AA）

Slack の client.md の 10 節の方針を引き継ぐ。エディタに固有のもの：

- **ページの構造**：ページのタイトルを `h1`、`heading_1`〜`heading_3` を `h2`〜`h4` として描く。リストは `ul` / `ol`、`to_do` のチェックは `role="checkbox"`、`toggle` と折りたためる見出しは `aria-expanded` を持つボタンにする。
- **編集の領域**：テキストのブロックの ProseMirror は `contenteditable` の `role="textbox"`（`aria-multiline`）で、`aria-label` にブロックの種類を入れる（例：「見出し 2」）。静的な描画のブロックも、フォーカスを受けたら即座に編集の領域にする（4.3 節）。
- **ブロックの選択**：ブロックの選択の状態を `aria-selected` と、`aria-live="polite"` の領域の「3 ブロックを選択」で伝える。
- **構造の変更の読み上げ**：種類の変更、移動、インデントを `aria-live` で短く伝える（例：「見出し 2 に変換」「1 つ上へ移動」）。
- **ドラッグの代替**：7 節のとおり、キー操作とメニューで同じことができる。
- **補完とメニュー**：スラッシュコマンド・メンションは combobox のパターン（5 節、9 節）。
- **その他**：`prefers-reduced-motion` でドラッグと強調のアニメーションを止める。他の人のカーソルの色だけで人を区別しない（名前の札を付ける）。
- 手動の確認は、VoiceOver（macOS / iOS）と NVDA で、見出し・リスト・ToDo の作成と移動を行う。

## 13. 国際化（ja / en）

- Slack と同じく、ICU MessageFormat と FormatJS（`react-intl`）で表示し、ja と en のキーの一致を CI で検査する。
- 日付のメンションの表示（「明日」「2026年10月1日」）と、相対時刻（「3 分前に編集」）は `Intl` で整形する。
- スラッシュコマンドの名前は翻訳し、英語の名前でも引けるようにする（5 節）。
- テキストの折り返しと禁則は、ブラウザに任せる。日本語の文中の `word-break` は `normal`、`line-break` は `strict` にする。
- ユーザーが書いた本文は翻訳しない。

## 14. セキュリティ

Slack の client.md の 8 節（CSP、Trusted Types、Cookie のセッション、依存関係）を引き継ぐ。違うところ：

| 項目 | 方針 |
| --- | --- |
| 本文の描画 | スパンを React の要素にして描く。`dangerouslySetInnerHTML`・`innerHTML` を使わない（lint）。ProseMirror の `toDOM` も要素の組み立てだけで、HTML の文字列を使わない |
| 数式 | KaTeX の出力は HTML の文字列なので、KaTeX の描画だけを 1 つの部品に閉じ込め、`trust: false`、`maxSize`、`maxExpand` を付ける。Trusted Types のポリシーを 1 つだけ許す |
| 埋め込み | `embed` は `sandbox` 付きの `iframe` にし、許可した提供元だけを直接埋め込む。それ以外はリンクのカードにする。一覧は E3 の `embed-block` の Story で決める（[security.md](security.md) の 3.5 節、17 節） |
| 貼り付け | 8.1 節の無害化 |
| CSP の `img-src` | ファイルの配信のドメインと画像のプロキシだけ。外部の画像を直接読まない |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

## 15. 性能の予算

| 項目 | 目標 | 測り方 |
| --- | --- | --- |
| 1,000 ブロックのページの表示（キャッシュなし） | p75 1.5 秒以内（NFR-002） | RUM、Playwright の計測 |
| 同（ローカルにあるとき） | p75 300ms 以内（NFR-002） | 同上 |
| 最初の区切りの API の応答 | p75 400ms 以内 | サーバーのメトリクス |
| 初回の JS（骨格＋エディタ） | 300KB 以内（gzip）。データベースのビュー、数式、コードのハイライトは遅延して読む | CI でビルドの大きさを検査 |
| 打鍵 → 描画 | p95 50ms 以内（1,000 ブロックのページで） | Playwright の計測 |
| INP | p75 200ms 以内 | RUM |
| `EditorView` の生成 | 1 個 2ms 以内、アイドルの 1 回の処理を 10ms 以内 | 計測 |
| 10 万ブロックのページ | 開いてからスクロールして末尾まで、長いタスク（50ms 超）が 1 秒あたり 1 回以下。JS ヒープ 500MB 以内 | Playwright（Chromium） |

- 数値は既定案で、E3 の着手前の計測（ProseMirror の生成の費用、`content-visibility` の効果）で見直す。

## 16. テスト

| レベル | 対象 | 道具 |
| --- | --- | --- |
| 単体 | スパンの正規化と変換、`applyOperation`、Markdown のショートカット、HTML の貼り付けの変換 | Vitest |
| 性質ベース | 任意の操作の列の後で、ページの木の不変条件（[block-model.md](block-model.md) の 5 節）が成り立つ。スパン → ProseMirror → スパンで値が変わらない。任意の HTML の貼り付けの結果に、実行可能な要素と許可外のスキームが出ない | fast-check |
| 部品 | IME、ブロックの間のカーソルの移動、ドラッグ、静的な描画と ProseMirror の描画の一致 | Vitest の browser mode（Chromium / Firefox / WebKit） |
| E2E | ページの作成と編集、スラッシュコマンド、並べ替え、貼り付け、同期ブロック、ゴミ箱と復元、1,000 ブロックのページの表示 | Playwright |
| 見た目の回帰・a11y | Slack と同じ | Playwright、`@axe-core/playwright` |

## 17. 決定と持ち越し

2026-09-26 に、本家に寄せる既定案で次のとおり決めた（[README.md](README.md) の「決定」）。

- ブロックの間にまたがる部分的なテキストの選択は、MVP に入れない（3.1 節。[roadmap.md](../roadmap.md) の「後回しにしたもの」）。
- デスクトップのローカルの保存は、S1 は Web と同じ WASM の SQLite（OPFS）にする。本家と同じネイティブの SQLite は S2 の候補にし、計測で決める（11 節、[ADR-0032](../decisions/0032-desktop-uses-wasm-sqlite-in-s1.md)）。
- 埋め込みは、許可した提供元（oEmbed の一覧）だけを直接埋め込み、それ以外はリンクのカードにする。一覧の中身は E3 の `embed-block` の Story で決める（[security.md](security.md) の 3.5 節）。

持ち越し：

- 仮想化する閾値（2,000 ブロック）と、ProseMirror の生成を遅らせる方式が NFR-002 に収まるか。E3 の着手前の PoC で計測する。

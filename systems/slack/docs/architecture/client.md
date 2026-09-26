# Client: Slack

Web クライアント（PWA）の設計。データ層・複数タブ・オフライン保存の選択は [ADR-0024](../decisions/0024-client-data-layer-and-offline.md) にある。ネイティブのモバイルアプリは作らない（[intent.md](../intent.md) の Non-goals）。

前提として、次の決定に従う。

| 決定 | クライアントへの影響 |
| --- | --- |
| [ADR-0001](../decisions/0001-per-channel-sequence.md) | 位置・順序・既読・差分取得をすべて `seq` で扱う。`created_at` で並べない |
| [ADR-0002](../decisions/0002-db-as-source-of-truth-with-outbox.md) | WebSocket は取りこぼす前提。欠損はクライアントが差分取得で埋める |
| [ADR-0006](../decisions/0006-message-body-ast.md) | 本文は AST。HTML を組み立てず、React の要素として描画する |
| [ADR-0008](../decisions/0008-hono-rpc-for-api-contract.md) | HTTP は `packages/api-client` だけを使う。WebSocket のイベントは `packages/contract` の Zod スキーマで検証する |
| [ADR-0009](../decisions/0009-pooled-tenancy-with-rls.md) | API のパスはすべて `/workspaces/{workspace_id}/...`。ローカルの保存もワークスペースで分ける |
| [ADR-0011](../decisions/0011-aws-container-platform.md) | 静的ファイルは S3＋CloudFront から配る |

## 1. 対応ブラウザ

| ブラウザ | 対応 | 備考 |
| --- | --- | --- |
| Chrome / Edge（デスクトップ） | 最新 2 メジャー | |
| Firefox（デスクトップ） | 最新 2 メジャー＋ESR | |
| Safari（macOS） | 17 以上 | |
| Safari（iOS / iPadOS） | 17 以上 | Web Push はホーム画面に追加した PWA のみ（16.4 以上） |
| Chrome（Android） | 最新 2 メジャー | SharedWorker がない版では、タブ単体で動く（3.4 節） |

下限は 13 節の決定（2026-09-26）による。本家 Slack と同じく、半年ごと（5 月・11 月）に見直す。下限を上げ下げしたら、この表と Playwright の対象を同時に変える。

## 2. アプリの骨格とルーティング

### 2.1 構成

```
apps/web/
├── src/app/          # ルート定義、レイアウト、エラー境界
├── src/features/     # channel, thread, composer, search, settings ... 機能ごと
├── src/sync/         # 同期エンジン（SharedWorker でもタブでも動く。React に依存しない）
├── src/storage/      # IndexedDB のスキーマとアクセス
├── src/sw/           # Service Worker
└── src/i18n/
packages/ui/          # デザインシステム（7 節）
```

- ルーターは TanStack Router を使う。パスとクエリの型を検査でき、TanStack Query と同じ作法でデータの先読み（loader）を書ける。
- `src/sync/` は React・DOM に依存させない。SharedWorker とタブの両方で同じコードを動かすため。

### 2.2 ルート

| パス | 画面 |
| --- | --- |
| `/` | 最後に開いたワークスペースへ転送。なければワークスペースの選択 |
| `/signin` など | 認証（[identity-and-access.md](identity-and-access.md)） |
| `/w/{workspace_id}` | そのワークスペースで最後に開いたチャンネルへ転送 |
| `/w/{workspace_id}/c/{channel_id}` | チャンネル（DM を含む） |
| `/w/{workspace_id}/c/{channel_id}/m/{seq}` | 指定したメッセージへ移動（4.4 節） |
| `/w/{workspace_id}/c/{channel_id}/t/{thread_root_id}` | チャンネル＋スレッドの右ペイン |
| `/w/{workspace_id}/search?q=` | 検索（[search.md](search.md)） |
| `/w/{workspace_id}/settings/...` | 個人・ワークスペースの設定 |

- URL に入れる ID は UUID と `seq` だけにする。チャンネル名や検索語以外の個人情報をクエリに入れない。
- 権限のないチャンネル・存在しないチャンネルは、API が 404 を返す（ADR-0005）。クライアントも両者を区別せず、同じ「見つかりません」画面を出す。

### 2.3 ワークスペースの切り替え

- 左端にワークスペースの一覧を置く（[ADR-0010](../decisions/0010-accounts-and-workspace-members.md) のアカウントが属するワークスペース）。
- 切り替えは URL の `workspace_id` を変えるだけにする。画面の状態・キャッシュ・同期の購読は、すべて `workspace_id` を含むキーで分ける。
- 開いているワークスペースだけが WebSocket で購読する。他のワークスペースの未読の有無は、切り替え画面を開いたときと一定間隔（例：60 秒）で取り直す。Web Push が来たら、そのワークスペースの印を即座に付ける。
- ワークスペースごとにメンバー ID・表示名・ロールが違う。画面の「自分」は常に、そのワークスペースのメンバーとして扱う。

## 3. データ層

### 3.1 全体像

```
┌────────── Tab (React) ──────────┐      ┌────── SharedWorker (1 per browser) ──────┐
│ TanStack Query                  │      │ Sync engine                              │
│  - channels, members, settings  │      │  - WebSocket (1 per open workspace)      │
│ Timeline store (per channel)    │◀────▶│  - per-channel seq, gap detection        │
│  - messages keyed by seq        │ Port │  - catch-up via api-client               │
│ Composer / drafts               │      │  - send queue (IndexedDB outbox)         │
└──────────────┬──────────────────┘      │  - writes read cache to IndexedDB        │
               │ read                    └───────────────┬──────────────────────────┘
               ▼                                         ▼
          IndexedDB  ◀───────────────────────────────────┘
               ▲
┌──────────────┴── Service Worker ─┐
│ precache app shell, Web Push     │
└──────────────────────────────────┘
```

### 3.2 何をどこに持つか

全面的な正規化ストアは作らない。メッセージだけを専用のストアで持ち、それ以外は TanStack Query に任せる。

| データ | 持ち場所 | 理由 |
| --- | --- | --- |
| ワークスペース・チャンネル一覧・メンバー・設定 | TanStack Query | 変化が少なく、取り直しで足りる。イベントを受けたら該当するクエリを無効化するか `setQueryData` で書き換える |
| チャンネルのメッセージ（タイムライン） | Timeline ストア | `seq` 順の適用・欠損の検知・編集と削除とリアクションの反映・楽観表示の差し替えを、1 か所で行う必要がある。無限クエリのページ単位の構造では、編集が別ページのメッセージを指すと扱いにくい |
| 未読数・メンション数 | TanStack Query（チャンネル一覧の一部） | [read-state-and-notifications.md](read-state-and-notifications.md) の値をそのまま出す。イベントで `last_seq` を更新する |
| 下書き・未送信のメッセージ | IndexedDB | 再読み込み・タブを閉じても残す |
| 画面の状態（開いているペインなど） | React の状態、URL | |

- メッセージの取得も TanStack Query の `queryFn` 経由で行い、再試行・重複排除・キャンセルは Query に任せる。取得した結果は Timeline ストアへ流し込み、画面は Timeline ストアを `useSyncExternalStore` で読む。
- メンバー（表示名・アイコン）は ID ごとの Query にし、メッセージの描画では ID から引く。メッセージにプロフィールを埋め込まない（表示名の変更を 1 か所で反映するため）。

### 3.3 Timeline ストア

チャンネルごとに、次を持つ。

| 項目 | 内容 |
| --- | --- |
| `messages` | `seq` → メッセージ。メモリに持つのは連続した 1 つの窓（最大 1,000 件） |
| `window` | 窓の最小・最大の `seq`、前後にまだあるか |
| `applied_seq` | イベントを適用し終えた最大の `seq` |
| `pending` | 送信中・送信失敗のメッセージ（`client_msg_id` → 本文） |
| `sync` | 同期の状態（3.5 節） |

- イベントは `seq` 順に 1 件ずつ適用する。`seq` が `applied_seq` 以下のイベントは捨てる（重複の除去）。
- 編集・削除・リアクションもチャンネルの `seq` を消費する（[data-model.md](data-model.md)）。対象のメッセージが窓の外なら、`applied_seq` だけを進める。
- メモリに持つチャンネルは最大 10 件（LRU）。追い出したチャンネルは、次に開いたときに IndexedDB から戻す。

### 3.4 複数タブ：SharedWorker に接続を 1 本だけ持たせる

同じブラウザで複数のタブを開いても、WebSocket はワークスペースごとに 1 本にする。同期エンジンを SharedWorker で動かし、タブは `MessagePort` でつながる（ADR-0024）。

- SharedWorker は、WebSocket・チャンネルごとの `applied_seq`・欠損の検知・差分取得・送信キュー・IndexedDB への書き込みを持つ。
- タブへは、`seq` の連続が保証されたイベントだけを渡す。タブは欠損を気にせず、順に適用すればよい。
- あるタブがチャンネルを開いたときは、先に IndexedDB または API から窓を読み、SharedWorker の現在の `applied_seq` までの差を受け取って追いつく。読み込み中に届いたイベントはタブ側でためておき、読み込み後に `seq` で重複を除いて適用する。
- 既読の更新（[read-state-and-notifications.md](read-state-and-notifications.md)）・下書きの変更・ログアウトも SharedWorker を経由して全タブに伝える。

SharedWorker が使えないとき（古い Chrome for Android、Android の WebView など）は、同じ同期エンジンをタブの中で動かす（タブ単体モード）。

- 各タブがそれぞれ WebSocket を持つ。接続数は増えるが、正しさは変わらない。
- 送信キューは、Web Locks（`navigator.locks`）でロックを取ったタブだけが処理する。
- タブ間の通知は `BroadcastChannel` で行う。

ブラウザの対応状況（2026-09-26 時点で確認）：

| API | Chrome | Firefox | Safari（macOS / iOS） | Chrome for Android | 出典 |
| --- | --- | --- | --- | --- | --- |
| SharedWorker | 5 | 29 | 16 以上 | 148 以上（caniuse は 152 と表示） | MDN browser-compat-data、caniuse |
| Web Locks | 69 | 96 | 15.4 | Chrome に準じる | MDN browser-compat-data |
| BroadcastChannel | 54 | 38 | 15.4 | Chrome に準じる | [MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/api/BroadcastChannel.json) |

- module 形式の SharedWorker（`type: 'module'`）：SharedWorker のコンストラクターの `type` オプションは Safari 15 から対応しており、SharedWorker が戻った Safari 16 以降では module 形式で動く（[MDN browser-compat-data の `SharedWorker`](https://github.com/mdn/browser-compat-data/blob/main/api/SharedWorker.json) の `options_type_parameter`、2026-09-26 に確認）。classic 形式への出力は要らない。

未検証の事項：

- iOS の PWA がバックグラウンドにある間、SharedWorker と WebSocket がどれだけ生き続けるか。WebKit・Apple の公式の文書に定めがなく、確かめられなかった。すぐ止まる前提で、フォアグラウンドに戻ったら全チャンネルを差分取得する設計にしておく。E4 の着手前に、実機（iPhone のホーム画面に追加した PWA）で、バックグラウンドに移ってから接続が切れるまでの時間を PoC で測る。

### 3.5 チャンネルごとの同期の状態

| 状態 | 意味 | 画面 |
| --- | --- | --- |
| `stale` | 最新である保証がない。IndexedDB のキャッシュを表示しているだけ、または切断中 | 上部に「最新ではない可能性があります」を控えめに出す。送信は受け付けてキューに入れる |
| `catching_up` | 差分取得中。届いたイベントはためておく | 窓の下端に読み込み中の表示 |
| `live` | `applied_seq` が連続していて、WebSocket でイベントを受けている | 通常 |

| 現在 | きっかけ | 動作 | 次 |
| --- | --- | --- | --- |
| `stale` | WebSocket が接続済みで、チャンネルを開いた | `GET .../events?after_seq=applied_seq` | `catching_up` |
| `catching_up` | 差分を最後まで取得した | ためたイベントのうち `applied_seq` より大きいものを適用 | `live` |
| `catching_up` | 差分が 1,000 件を超える | 窓を捨て、最新ページ（`GET .../messages`）を取り直し、`applied_seq` を最新にする | `live` |
| `catching_up` | 取得に失敗した | 指数バックオフ（1 秒から最大 30 秒、ゆらぎ付き）で再試行 | `catching_up` |
| `live` | `seq` が `applied_seq + 1` より大きいイベント | そのイベントをためる | `catching_up` |
| `live` | `seq` が `applied_seq` 以下のイベント | 捨てる | `live` |
| `live` / `catching_up` | WebSocket が切れた | 再接続を始める | `stale` |
| `stale` | 再接続した | 開いているチャンネルは差分取得。開いていないチャンネルは `last_seq` だけを更新し、次に開いたときに差分取得 | `catching_up` / `stale` |
| いずれか | チャンネルから外された（イベントまたは 404） | メモリと IndexedDB からチャンネルを消し、「見つかりません」を出す | — |

- 再接続のときに全チャンネルを一斉に差分取得しない。差分取得は開いているチャンネル（全タブの合計）に限り、ほかは未読の印に必要な `last_seq` だけを受け取る。これで再接続の集中（thundering herd）を抑える。
- 差分の件数の上限 1,000 は [realtime.md](realtime.md) の値に合わせる。上限の判定方法（件数か、API が返す印か）は realtime.md に従う。

### 3.6 送信キューと楽観表示

1. 送信時に `client_msg_id`（UUIDv7）を作り、IndexedDB の `outbox` に `{client_msg_id, workspace_id, channel_id, thread_root_id, body, created_at, attempts, state}` を書く。書き終えてから画面に「送信中」で出す。
2. SharedWorker が `outbox` をチャンネルごとの FIFO で処理する。1 チャンネルにつき同時に 1 件だけ送る。並べて送ると、到着順が入れ替わって `seq` の順が送った順とずれるため。
3. 結果ごとの扱い：

   | 結果 | 扱い |
   | --- | --- |
   | 201 / 200 | `outbox` から消し、`seq` 付きの正式なメッセージに差し替える |
   | ネットワークエラー、5xx、429 | `attempts` を増やし、指数バックオフで再送する。`client_msg_id` は変えない（REQ-MSG-002 により重複しない） |
   | 400 | 「送信失敗」にし、編集か破棄を求める。自動で再送しない |
   | 404 | 「送信失敗（チャンネルが見つかりません）」にする。後ろの同じチャンネルの送信も止める |
   | 401 | 再認証を求める。キューは残す |

4. 自分の投稿のイベントが POST の応答より先に届くことがある。`client_msg_id` が `pending` にあれば、イベントの側で差し替える。
5. 表示順：確定したメッセージは `seq` 順。`pending` は常に確定したメッセージの後ろに、作った順で並べる。
6. 再読み込みやブラウザの再起動のあと、作成から 10 分を超えた未送信は、自動では送らず「未送信」として残し、ユーザーの操作で再送する。時間が経ってから意図せず投稿されるのを避けるため。

編集・削除・リアクションは楽観的に反映し、失敗したら元に戻して通知する。これらはキューに入れず、オフラインの間は操作できないようにする。

### 3.7 オフラインの読み取りキャッシュ

IndexedDB に、次の単位で保存する。データベースはアカウントごとに分け（`slack:{account_id}`）、ストアのキーの先頭に `workspace_id` を置く。

| ストア | キー | 中身 |
| --- | --- | --- |
| `messages` | `[workspace_id, channel_id, seq]` | 最近開いたチャンネルの最新側のメッセージ |
| `channel_state` | `[workspace_id, channel_id]` | `applied_seq`、窓の範囲、最後に開いた時刻 |
| `outbox` | `client_msg_id` | 未送信のメッセージ |
| `drafts` | `[workspace_id, channel_id, thread_root_id]` | 下書き |
| `meta` | 固定 | スキーマの版、キャッシュの総量 |

- 保存するのは、ワークスペースごとに最近開いた 20 チャンネル、各チャンネルの最新側 200 件まで。
- 総量の上限は 50MB を目安とし、超えたら最後に開いた時刻が古いチャンネルから消す（LRU）。`outbox` と `drafts` は追い出しの対象にしない。
- 起動時はキャッシュを `stale` で即座に表示し、接続後に差分取得で追いつく。
- `navigator.storage.persist()` を、PWA としてインストールされたときに要求する。拒否されても動く。
- スキーマを変えるときは IndexedDB の版を上げる。移行が難しければ `messages` を捨てて取り直してよい（`outbox` と `drafts` は必ず移す）。
- ログアウト時は、そのアカウントのデータベースを消す（8 節）。ワークスペースから外されたら、そのワークスペースのデータを消す。

Safari の保存の扱い：

- Safari 17 以降は、オリジンあたりディスクの最大 60% まで使え、上限を超えるとユーザーの操作が古いオリジンから消される（WebKit の storage policy）。
- Safari の追跡防止（ITP）により、ユーザーの操作のない 7 日間の後に、スクリプトから書いたデータ（IndexedDB、LocalStorage、Service Worker の登録とキャッシュなど）が消える。ホーム画面に追加した Web アプリのオリジンは対象外（[WebKit の Tracking Prevention の文書](https://webkit.org/tracking-prevention/)、2026-09-26 に確認）。キャッシュが消えても最新ページの取り直しで動くようにする。未送信のメッセージが消えうることは、送信失敗と同じ扱いにはできないので、ドキュメントで注意する。

## 4. メッセージの一覧

### 4.1 仮想化

- TanStack Virtual で、画面に見えている行とその前後だけを描画する。行の高さは描画後に測る。
- 画像やリンクのプレビューは、読み込み前から縦横比の分だけ場所を取り、読み込み後の高さの変化を小さくする（[files.md](files.md) がサイズを返す前提）。
- 一覧の DOM は、同時に 150 行程度までにする。

### 4.2 スクロール位置の保持

- 最下部にいる間は、新しいメッセージが来たら最下部に追従する。最下部から離れているときは追従せず、「新しいメッセージ n 件」のボタンを出す。
- 上端に近づいたら前のページを読み込む（`before_seq`）。読み込み前に、見えている先頭の行の `seq` と画面上の位置を覚え、追加後に同じ位置へ戻す。
- CSS の `overflow-anchor` には頼らない。Safari が対応したのは 27 からで（MDN browser-compat-data）、対応ブラウザの下限（Safari 17）では使えないため。
- 窓の最大（1,000 件）を超えたら、見えている側と反対の端から捨てる。

### 4.3 未読の線

- チャンネルを開いた時点の `last_read_seq` を覚え、その直後に「ここから未読」の線を出す。開いている間は線を動かさない。
- 既読の更新は、最下部の行が見えていて、タブが表示中（`document.visibilityState === 'visible'`）でフォーカスがあるときに、1 秒の間隔を空けて `POST .../read {seq}` を送る。
- `Esc` でチャンネルを既読にし、線を消す。
- 未読が窓より前にある（未読が 1,000 件を超える）ときは、最新ページを出し、上部に「最初の未読へ移動」のボタンを出す。

### 4.4 指定したメッセージへの移動

- パーマリンク・検索結果・メンションの通知から `/m/{seq}` へ移動する。
- 窓の中にあればそこへスクロールし、行を一時的に強調する。窓の外なら、その `seq` の前後を取得して窓を作り直す。
- 前後の取得には、`seq` を中心にした取得（例：`around_seq`）か、`after_seq` での取得が要る。今の履歴 API（REQ-MSG-004）は `before_seq` しかないので、[messaging.md](messaging.md) で追加する必要がある。
- 作り直した窓は最新とつながっていない。下へスクロールして最新側を読み込むか、「最新へ移動」で最新ページに戻る。

## 5. 入力欄

### 5.1 エディター

- ProseMirror を直接使う。ProseMirror のスキーマを ADR-0006 の AST のノードに 1 対 1 で合わせ、エディターの文書から AST へ、AST から文書へを純関数で変換する。
- 貼り付けは、HTML を ProseMirror のスキーマで解析して AST にする。スキーマにない要素は捨てる。HTML をそのまま保持しない。
- 日本語の変換（IME）の確定の Enter で送信しない。`compositionstart`〜`compositionend` の間と、`isComposing` が真または `keyCode === 229` の `keydown` では送信しない。Safari では確定の Enter の `keydown` が `compositionend` の後に来ることがあるため、両方で判定する。
- `Enter` で送信、`Shift+Enter` で改行を既定にし、設定で逆にできるようにする。

### 5.2 補完

| 入力 | 候補 | 取得元 |
| --- | --- | --- |
| `@` | メンバー、`@channel` / `@here` | 最近のやり取りの相手を先に出し、`GET .../members?query=` で補う |
| `#` | チャンネル | チャンネル一覧（Query） |
| `:` | 絵文字 | 同梱の一覧 |

- WAI-ARIA の combobox のパターンで作る。上下で選択、`Enter` / `Tab` で確定、`Esc` で閉じる。
- 確定した候補は、文字列ではなく AST のメンションノード（`member_id`）として入れる。

### 5.3 下書き

- チャンネル・スレッドごとに、入力が止まって 500ms 後に IndexedDB の `drafts` へ保存する。
- 同じチャンネルを別のタブでも開いているとき、下書きの変更を SharedWorker 経由で伝える。両方で同時に書いた場合は後勝ちにする。
- サーバーへの下書きの保存（端末をまたぐ同期）は MVP に含めない。

## 6. Service Worker

- `vite-plugin-pwa`（Workbox）で、ビルドしたファイルを事前にキャッシュする。ナビゲーションには、キャッシュしたアプリの骨格（`index.html`）を返す。
- API の応答は Service Worker でキャッシュしない。メッセージのオフライン保存は IndexedDB だけにする（持ち場所を 1 つにするため）。
- CloudFront では、`index.html` と Service Worker のファイルを `no-cache`、ハッシュ付きのファイルを `immutable` にする（[infrastructure.md](infrastructure.md)）。
- 新しい版があれば「新しいバージョンがあります」を出し、ユーザーの操作で切り替える。API が古いクライアントを拒否したとき（契約の版の不一致）は、切り替えを強制する。版の伝え方は [realtime.md](realtime.md) と API の規約に従う。
- SharedWorker はスクリプトの URL で区別される。新しい版のタブは新しい SharedWorker を起動するので、古いタブが閉じるまで接続が 2 本になる。タブと SharedWorker の間のメッセージには版を付け、合わなければタブに再読み込みを促す。

### 6.1 Web Push の表示

- 購読の要求は、ユーザーがボタンを押したときだけ行う（iOS では必須）。iOS / iPadOS ではホーム画面に追加した PWA（manifest の `display` が `standalone` か `fullscreen`）で、16.4 以上のときだけ使える（WebKit のブログ）。
- `push` を受けたら必ず通知を表示する（`userVisibleOnly`）。表示しない push を続けると、ブラウザが購読を取り消しうる。
- そのチャンネルを表示中でフォーカスのあるタブがあれば、通知を短い表示にするか出さない判断は、サーバー側の抑止（[read-state-and-notifications.md](read-state-and-notifications.md)）を基本にし、クライアントでは重複を消すだけにする。
- 通知を押したら、既存のウィンドウを前に出して `/w/{workspace_id}/c/{channel_id}/m/{seq}` へ移動する。なければ新しく開く。
- アプリのアイコンのバッジは Badging API（`navigator.setAppBadge`）で出す。iOS 16.4 以上のホーム画面の PWA、macOS Sonoma 以上の Safari 17、Chrome 81 以上で使える。Firefox は対応していない（MDN browser-compat-data）。
- push の中身にどこまで本文を含めるかは [security.md](security.md) と read-state-and-notifications.md に従う。

## 7. デザインシステム

- `packages/ui` に置く。デザイントークン（色、余白、文字、角丸、影）を CSS 変数で定義し、ライト・ダークと高コントラストを切り替える。
- スタイルは CSS Modules で書く。実行時に `<style>` を差し込む CSS-in-JS は使わない（CSP の `style-src` を厳しく保つため、8 節）。
- アクセシブルな部品（メニュー、ダイアログ、combobox、リストボックス、ツールチップ）は React Aria を土台にする。フォーカスの管理、キーボード操作、スクリーンリーダーへの読み上げ、右から左の配置まで扱っており、自作より漏れが少ない。
- 部品ごとに Storybook のストーリーを作り、見た目の回帰テストと a11y の自動検査の対象にする（11 節）。

## 8. クライアントのセキュリティ

| 項目 | 方針 |
| --- | --- |
| 本文の描画 | AST を React の要素に変換して描く。`dangerouslySetInnerHTML`・`innerHTML`・`eval` を使わない（lint で禁止） |
| リンク | `http:` / `https:` / `mailto:` 以外のスキームは描画しない。外部リンクには `rel="noopener noreferrer"` を付ける |
| CSP | `default-src 'self'`、`script-src 'self'`（インラインなし）、`style-src 'self'`、`worker-src 'self'`、`connect-src 'self'`（API と WebSocket が同一オリジンの前提）、`img-src 'self' blob:` とファイル配信のドメイン、`frame-ancestors 'none'`。利用状況の計測を有効にしたワークスペースでだけ、GA の送信先を `script-src`・`connect-src`・`img-src` に加える（[ADR-0025](../decisions/0025-product-analytics-with-ga4.md)）、`object-src 'none'`、`base-uri 'none'`。CloudFront の応答ヘッダーで付ける |
| Trusted Types | `require-trusted-types-for 'script'` を付ける。対応していないブラウザでは無視される。対応は Chrome 83、Firefox 148、Safari 26 から（[MDN browser-compat-data](https://github.com/mdn/browser-compat-data/blob/main/http/headers/Content-Security-Policy.json)、2026-09-26 に確認）。これより古い版では効かないので、本文の描画の方針（上の行）を主な防御とする |
| 認証情報 | セッションは HttpOnly・Secure・SameSite の Cookie に置く。トークンを `localStorage`・IndexedDB・URL に置かない。WebSocket は、API から受け取った短命の 1 回限りのチケットで認証し、Gateway が `Origin` を検査する。Gateway は DB に触れないため、Cookie のセッションを直接は検証しない（[identity-and-access.md](identity-and-access.md)、[realtime.md](realtime.md)） |
| 利用状況の計測 | `packages/analytics` の型付きのイベントだけを GA に送る。本文・名前・ID を送らない。ワークスペースで無効なら gtag.js を読み込まない（[ADR-0025](../decisions/0025-product-analytics-with-ga4.md)） |
| ログアウト | 全タブに伝えて画面を閉じ、そのアカウントの IndexedDB を消し、Web Push の購読を解除し、SharedWorker の接続を閉じる |
| 共有端末 | オフラインのキャッシュには、プライベートチャンネルの本文も含まれる。「この端末に保存しない」設定を設けるかは未解決事項 |
| 依存関係 | lockfile を固定し、CI で既知の脆弱性を検査する（[security.md](security.md)） |

## 9. 国際化（ja / en）

- 文言は ICU MessageFormat で書き、FormatJS（`react-intl`）で表示する。複数形・性別・数の書式を翻訳者の側で扱えるようにする。
- 文言のキーは機能ごとのファイルに置き、CI で ja と en のキーの一致と、使われていないキーを検査する。
- 言語はアカウントの設定、なければ `navigator.language` から決める。日時・数は `Intl` で整形し、タイムゾーンはアカウントの設定に従う。
- 本文（ユーザーが書いたもの）は翻訳しない。

## 10. アクセシビリティ（WCAG 2.2 AA）

- **ランドマーク**：ワークスペースの一覧、サイドバー、メッセージ一覧、入力欄、スレッドを、それぞれランドマークにする。`F6` で順に移動する。
- **メッセージ一覧**：`role="feed"` 相当のパターンにし、各行を `article` にする。仮想化で全件を DOM に持たないため、`aria-setsize="-1"` と `aria-posinset`（`seq` から計算）を付ける。一覧の中は、上下の矢印で行を移動する（roving tabindex）。
- **新着の読み上げ**：開いているチャンネルの新着だけを、`aria-live="polite"` の領域で読み上げる。連続したときは 2 秒ごとに「新しいメッセージ 3 件」のようにまとめる。自分の投稿は読み上げない。設定で止められるようにする。
- **キーボード操作**：`Ctrl/Cmd+K` でチャンネルの切り替え、`Alt+↑/↓` で前後のチャンネル、`Esc` で既読、入力欄が空のときの `↑` で自分の直前の投稿を編集。単一キーのショートカットは作らない（2.1.4）。
- **WCAG 2.2 で加わった基準**：フォーカスが固定のヘッダー・入力欄に隠れない（2.4.11）。押せる対象は 24×24 CSS px 以上（2.5.8）。ドラッグでの並べ替えなどには、ボタンでの代替を用意する（2.5.7）。認証でパズルなどを求めない（3.3.8）。
- **その他**：400% の拡大で横スクロールが出ない（1.4.10）。`prefers-reduced-motion` で強調のアニメーションを止める。色だけで未読・メンションを表さない。

## 11. 性能の予算

| 項目 | 目標 | 測り方 |
| --- | --- | --- |
| 初回の JS（骨格） | 200KB 以内（gzip） | CI でビルドの大きさを検査。超えたら失敗 |
| 初回表示の LCP | p75 2.5 秒以内（中位の Android、4G 相当） | Lighthouse CI、本番の RUM |
| 2 回目以降の起動 → キャッシュのメッセージ表示 | p75 1 秒以内 | RUM |
| チャンネルの切り替え（キャッシュあり） | p75 100ms 以内で描画 | RUM、Playwright の計測 |
| チャンネルの切り替え（キャッシュなし） | p75 500ms 以内 | 同上。API は NFR-003 の範囲 |
| INP | p75 200ms 以内 | RUM |
| 入力欄の打鍵 → 描画 | 50ms 以内 | Playwright の計測 |
| イベントの適用 | 1 秒に 100 件を受けても、長いタスク（50ms 超）を出さない | 負荷をかけた E2E |
| メモリ | 1 万件をスクロールしたあとの JS ヒープ 150MB 以内。10 チャンネルを切り替えたあとも増え続けない | Playwright で `performance.measureUserAgentSpecificMemory`（Chromium のみ） |

RUM の指標の送り先と集計は [observability.md](observability.md) に従う。クライアントの欠損検知率（[quality.md](../quality.md) の 4.1 節）も、同期エンジンが送る。

## 12. テスト

| レベル | 対象 | 道具 |
| --- | --- | --- |
| 単体 | AST ↔ エディター文書の変換、Timeline ストアの適用、送信キューの状態遷移 | Vitest |
| 性質ベース | 同期エンジン：任意のイベント列（欠け・重複・順の入れ替わり・切断）と差分取得の応答に対し、最終的な窓が、サーバーの `seq` 順の列と一致する。AST の描画に実行可能な要素が出ない（ADR-0006） | fast-check |
| 部品 | 入力欄（IME、補完）、一覧（スクロール位置、未読の線）など、実ブラウザでないと確かめられないもの | Vitest の browser mode（Playwright で Chromium / Firefox / WebKit） |
| E2E | 下の表 | Playwright（Chromium / Firefox / WebKit） |
| 見た目の回帰 | `packages/ui` のストーリーと主要画面。ライト・ダーク、ja・en | Playwright の `toHaveScreenshot`。フォントと環境を固定したコンテナで撮る |
| a11y | 全ストーリーと主要画面 | `@axe-core/playwright`。違反 0 件を PR の条件にする |
| 手動 | VoiceOver（macOS / iOS）と NVDA での読み上げ、iOS 実機での Web Push | リリース前に確認 |

E2E の主なシナリオ：

| シナリオ | 確かめること |
| --- | --- |
| 2 人の会話 | 別のブラウザコンテキストの 2 人が交互に投稿し、両者が同じ順で見る |
| 同じ人の複数タブ | 3 タブを開いても WebSocket は 1 本。1 タブで送った投稿と既読が他のタブにも出る |
| 切断と再接続 | `context.setOffline` で切り、その間に他者が投稿し、戻したら欠けなく出る。1,000 件を超える差があれば最新ページに切り替わる |
| 送信中の再読み込み | 送信中に再読み込みしても、1 件だけ投稿される（REQ-MSG-002） |
| オフラインでの送信 | オフラインで送った投稿が、復帰後に送った順で投稿される |
| 指定したメッセージへの移動 | 窓の外の `seq` に移動し、行が強調される |
| 日本語入力 | 変換の確定の Enter で送信されない |
| 権限を失う | チャンネルから外されたら、画面とキャッシュから消える |

Playwright の WebKit は Safari そのものではない。SharedWorker のバックグラウンドでの寿命・Web Push・ホーム画面の PWA は、実機での手動確認とする。

## 13. 未解決事項

- 対応ブラウザの下限（Safari 17 でよいか）。
- 共有端末向けに「この端末に保存しない」設定を設けるか。
- 他のワークスペースの未読を、WebSocket なしでどこまで即座に出すか。
- `seq` を中心にした履歴の取得 API（4.4 節）の形。
- 大きなワークスペースでの補完：5,000 人のメンバーを手元に持つか、毎回問い合わせるか。

### 決定（2026-09-26、既定案）

- **対応ブラウザの下限は Safari 17（macOS・iOS / iPadOS）にする。** 本家のモバイルアプリの下限は iOS 17 以降で、PWA をモバイルアプリの代わりにする本システムでは、これに合わせる。本家の Web 版は Safari 26 以降と、より新しい版だけを対象にしているが、必要な API（SharedWorker は 16 以上）は 17 で揃うので、広い方を採る。Chrome・Edge・Firefox は 1 節の表のまま。本家と同じく、半年ごと（5 月・11 月）に下限を見直す（[System requirements for using Slack](https://slack.com/help/articles/115002037526-System-requirements-for-using-Slack)、2026-09-26 に確認）。
- 共有端末向けの「この端末に保存しない」設定は設けない。ログアウト時にそのアカウントの IndexedDB を消す（3.7 節）ことと、ワークスペースごとのセッションの最大有効期間（[identity-and-access.md](identity-and-access.md) の 3.2 節）で抑える。
- 他のワークスペースの未読は、2.3 節のとおりにする。WebSocket は開いているワークスペースだけ。他は、切り替え画面を開いたときと 60 秒ごとに `unreads-summary-api` で取り直し、Web Push が来たら即座に印を付ける。
- 5,000 人のワークスペースでも、メンバーを手元にすべては持たない。画面に出るメンバー（投稿者、メンションの相手）だけを必要なときに取り、IndexedDB にキャッシュする。補完は `GET .../members?query=` で問い合わせる（5.2 節）。本家も、メンバーとチャンネルのメンバーを遅延して読み込み、補完はサーバーに問い合わせる（[Flannel: An Application-Level Edge Cache to Make Slack Scale](https://slack.engineering/flannel-an-application-level-edge-cache-to-make-slack-scale/)）。
- 持ち越し：`seq` を中心にした履歴の取得 API（4.4 節）の形は、API の契約として人間がレビューする必要があるので、E3 の `jump-to-message` の spec で決める。

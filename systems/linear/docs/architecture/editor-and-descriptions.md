# Editor and Descriptions: Linear

イシューの説明（本文）とコメントのリッチテキスト、本文の同時編集の CRDT、同期のログへの載せ方、メンションと参照、添付ファイル、本文の範囲に付けるコメント（インラインのコメント）を決める。

前提となる決定は、基盤と部品（[ADR-0001](../decisions/0001-platform-and-stack.md)。本文の CRDT は Yjs を第一の候補）、同期のモデル（[ADR-0002](../decisions/0002-sync-model.md)。本文は `append` で載せる）、差分の形（[ADR-0007](../decisions/0007-sync-actions-and-range-proof-deltas.md)）、遅延の読み込み（[ADR-0012](../decisions/0012-lazy-loading-coverage-and-tombstones.md)）、手元の保存（[ADR-0014](../decisions/0014-indexeddb-layout-durability-and-migrations.md)。`_doc_*` の store をこの領域に予約）、オフラインの添付（[client-store-and-offline.md](client-store-and-offline.md) の 5.5 節）、派生の変更（[ADR-0025](../decisions/0025-derived-changes-in-writer.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0021](../decisions/0021-description-crdt-yjs-in-sync-log.md) | 本文の CRDT は Yjs（`Y.XmlFragment`）と ProseMirror の束ね（y-prosemirror）。更新は 250ms ごとにまとめて `append` の操作で送り、同期のログに他の変更と同じ `sync_id` の順で載せる。Worker が更新をまとめた状態を作り、遅延の読み込みは読んだ時点までをまとめた状態を返す。Yjs は `packages/doc` の中に閉じる |
| [0022](../decisions/0022-comments-anchors-mentions-attachments.md) | コメントの本文は CRDT にせず、ProseMirror の JSON を LWW で持つ（書くのは作った人だけ）。インラインのコメントは本文の中に印を書かず、Yjs の相対位置の組をコメントの行に持つ。メンションは ID で持ち、本文のメンションは Worker が抜き出して通知と購読にする。添付は S3 の署名付きの URL へクライアントが直接上げ、別のドメインから短い期限の署名付きの URL で配る |

## 1. 目的と範囲

- 扱う：
  - エディタの方式、文書のスキーマ（ノードと装飾）、Markdown のショートカット、スラッシュコマンド、貼り付け、Undo
  - 本文のモデル（`IssueDescription`）、CRDT の更新の送り方、サーバーでのまとめ、読み込み、手元の保存
  - 本文のバージョン（履歴）と戻し
  - コメント（`Comment`）、スレッド、解決、リアクション
  - インラインのコメントのアンカー
  - メンションと参照
  - 添付ファイル（`Attachment`）の上げ・配り・消去
- 扱わない：
  - 画面の全体、キーボードの仕組み、IME の共通の扱い（[client-app.md](client-app.md)）
  - 通知の配り方（[notifications-and-inbox.md](notifications-and-inbox.md)）
  - 本文の全文検索の索引（[search.md](search.md)）
  - プロジェクトの説明とドキュメント（cycles-and-projects の領域。同じ方式を使う）
  - 公開 API での本文の形（Markdown への変換。api-and-webhooks の領域）

## 2. 本家の形と、使う部品（確かめたこと）

いずれも 2026-09-28 に確認。

### 2.1 本家（公式）

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| エディタ | Markdown の多くの要素と、`Cmd/Ctrl+B`・`I`・`K` などのショートカット。`/` でスラッシュコマンド。YouTube・Loom・Figma の埋め込み。`:emoji-name:` | [Editor](https://linear.app/docs/editor) |
| メンション | `@` で利用者・イシュー・プロジェクト・日付・ドキュメント・PR を参照できる。利用者のメンションは、その人のインボックスへ通知し、イシューを購読させる。`@ENG-123` の貼り付けで参照になる | 同上 |
| 添付 | `/file`、`Cmd+Shift+U` で上げる。上限の大きさは書かれていない | 同上 |
| 同時編集 | すべてのドキュメントとイシューの説明を、複数の人が同時に編集できる | [Editor improvements](https://linear.app/changelog/2023-12-06-editor-improvements)（2023-12-06） |
| 本文の履歴 | コマンドメニューの「Issue description history」から前のバージョンに戻せる | [Edit issues](https://linear.app/docs/editing-issues) |
| コメント | スレッド、解決、リアクション。コメントを直せるのは作った人だけ。本文の範囲を選んで `Cmd+Option+M` でインラインのコメント | [Comments and reactions](https://linear.app/docs/comment-on-issues)、[Edit issues](https://linear.app/docs/editing-issues) |
| API での上げ | ファイルの種類・名前・大きさを渡して、署名付きの上げの URL と資産の URL を受け、`PUT` で上げる。API の利用者の上げは、CSP のためサーバーから行う | [How to upload a file to Linear](https://linear.app/developers/how-to-upload-a-file-to-linear) |
| メールの取り込み | メールからの作成は、添付を 25 MB まで | 検索の抜粋（Linear Docs）。本文は未確認 |

- 本家の本文の CRDT の部品（Yjs か自前か）と、インラインのコメントの保存の形は、公式の資料で確かめられなかった（**未検証**）。本文だけが CRDT であることは、講演の要約（第三者）による（[architecture/README.md](README.md) の 1.3 節）。
- 本家の UI で上げられるファイルの大きさの上限は**未検証**。

### 2.2 Yjs と y-prosemirror

| 性質 | 内容 | 出典 |
| --- | --- | --- |
| 更新の性質 | 文書の更新は可換・結合的・冪等で、どの順で何回当てても同じ状態になる | [Document Updates](https://docs.yjs.dev/api/document-updates) |
| まとめ | `Y.mergeUpdates` は、文書を読み込まずに更新をまとめ、重複を除く。ただし削除した中身のごみ集めはしない。大きさを減らすには `Y.Doc` に読み込む必要がある | 同上 |
| 差分 | `Y.encodeStateVector` と `Y.encodeStateAsUpdate(doc, sv)`・`Y.diffUpdate` で、相手にない分だけを作れる | 同上 |
| 相対位置 | 共有の型の中の要素に固定した位置。他の人の変更で動かない。消えた型を指すと `null` になる。`assoc` で前後どちらの要素に付くかを選ぶ | [Y.RelativePosition](https://docs.yjs.dev/api/relative-positions) |
| clientID | 文書ごとに自動で振る。セッションをまたいで使い回してはいけない | [Y.Doc](https://docs.yjs.dev/api/y.doc) |
| ProseMirror | y-prosemirror は ProseMirror を同時編集にし、共有の Undo も持つ。文書はスキーマに合うように保たれる。添字の位置は同時編集で正しく動かないので、コメントなどは相対位置で作ること | [y-prosemirror](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror) |
| バージョン | `yjs` 13.6.33、`y-prosemirror` 1.3.7（npm の最新。どちらも MIT） | npm のレジストリ |

## 3. エディタ

### 3.1 方式

- ProseMirror を使う。本文は y-prosemirror の `ySyncPlugin` で `Y.XmlFragment`（名前 `body`）と結ぶ。コメントの入力とテンプレート・下書きは、同じスキーマの ProseMirror を Yjs なしで使う。
- エディタと Yjs は `packages/doc` の中に閉じ、画面・同期の核・Writer からは `packages/doc` の API（`openDoc`、`applyUpdate`、`merge`、`toPlainText`、`toJSON`、`extractMentions`、`resolveAnchor`）だけを使う。部品の差し替え（ADR-0021 の代替案）に備える。
- ADR-0001 の方針（ProseMirror 系のエディタと Yjs）に従う。Notion の題材はブロックごとの ProseMirror と自前の Fugue にした（Notion の ADR-0007・0010）。この題材の本文はブロックの表を持たない 1 つの文書なので、文書全体を 1 つの CRDT にできる（ADR-0021）。

### 3.2 スキーマ（MVP）

| 種類 | ノード・装飾 |
| --- | --- |
| ブロック | 段落、見出し（1〜3）、箇条書き、番号付き、チェックリスト（`checked`）、引用、コード（`language`）、区切り線、画像（`attachment_id`、`alt`、`width`）、折りたたみ |
| インライン | メンション（`kind`: `user`・`issue`・`project`・`date`、`id` か `date`）、絵文字（Unicode）、改行 |
| 装飾 | 太字、斜体、打ち消し、下線、インラインのコード、リンク（`href`） |

- 表と埋め込み（YouTube・Loom・Figma）は MVP で持たない（本家との差異）。外部の `iframe` の安全の検討が要るため。
- リンクの `href` は `https:`・`http:`・`mailto:` と、本システムの内部の URL だけ。他は装飾を外す。
- y-prosemirror は、スキーマに合わない要素（知らないノード）を ProseMirror のノードにできないと、その要素を共有の Yjs の文書から消す（`createNodeFromYElement` の `catch` で `_item.delete`。[y-prosemirror 1.3.7 の sync-plugin.js](https://github.com/yjs/y-prosemirror/blob/master/src/plugins/sync-plugin.js)、2026-09-28 に確認）。消した更新は同期で全員に届くので、古いクライアントが 1 台開くだけで、新しいバージョンで作った中身が全員から消える。
- そこで、本文のスキーマにノード・装飾・属性を足すことを、破壊の変更として扱う（[data-model-and-schema.md](data-model-and-schema.md) の 6.2 節）。手順は次のとおり。
  1. 足すノードを読める（描ける）だけのバージョンを出す。作る操作はフラグ（`release.*`）の裏に置く。
  2. Gateway の `min_build` を、そのバージョンまで上げる（[ADR-0056](../decisions/0056-flags-client-distribution-and-min-build.md)）。古いバージョンは接続を切られ、差分を受けない。Sync API の本文の読み込み（4.4 節）も `build < min_build` を断る。
  3. フラグを開き、作れるようにする。
- 「表示できない要素」の置き物で描く方式は採らない（上のとおり、y-prosemirror が要素を消すため）。

> 2026-09-28 の注記：当初は「古いクライアントは知らないノードを置き物で描き、消さない。消えるかは E5 の前の PoC で確かめる」としていた。y-prosemirror のコードで消すことを確かめたので、ノードの追加を破壊の変更にし、`min_build` を先に上げる手順に替えた。PoC（`doc-schema-compat-poc`）は、この手順の試験（`doc-schema-compat`）に替えた。

### 3.3 入力の補助

| 入力 | 動作 |
| --- | --- |
| `# `・`## `・`### ` | 見出し |
| `- `・`* `、`1. `、`[] ` | 箇条書き、番号付き、チェックリスト |
| `> `、` ``` `、`---` | 引用、コード、区切り線 |
| `**x**`・`*x*`・`~x~`・`` `x` `` | 装飾 |
| `/` | スラッシュコマンド（見出し、リスト、コード、画像・ファイル、メンション、日付） |
| `@` | メンションの候補（6 節） |
| `:` の後に 2 文字 | 絵文字の候補 |
| `Cmd/Ctrl+B`・`I`・`U`・`K`・`E` | 太字、斜体、下線、リンク、インラインのコード |
| `Cmd/Ctrl+Shift+U` | ファイルを上げる |
| `Cmd/Ctrl+Option+M`（Windows は `Ctrl+Alt+M`） | 選んだ範囲にインラインのコメント（7 節） |

- 入力の規則（`# ` など）とエディタのショートカットは、IME の組み立ての途中では発火させない。ProseMirror の入力の規則は、組み立ての途中（`view.composing`）では評価せず、`compositionend` の後に 1 回評価する（[prosemirror-inputrules 1.5.1 の inputrules.ts](https://github.com/ProseMirror/prosemirror-inputrules/blob/master/src/inputrules.ts)、2026-09-28 に確認）。E5 の IME の確認では、確定の直後に規則が 1 回だけ動くことを確かめる。エディタの外のショートカットの抑止は [client-app.md](client-app.md) の 5.3 節。
- ショートカットの割り当てを本家にどこまで寄せるかは、法務の L8 の後に見直す。

### 3.4 貼り付け

- HTML の貼り付けは、ProseMirror の `DOMParser` でスキーマに合わせ、スキーマにない要素・属性・`style` を落とす。
- 平文の貼り付けは、Markdown として解析して、スキーマに変える（`markdown-it` を使う。第三者の汎用の部品）。
- 自分のイシューの URL、`ENG-123` の形の文字列は、メンション（`kind: issue`）に変える。解決は [data-model-and-schema.md](data-model-and-schema.md) の 5.4 節の `resolve`。
- 画像の貼り付けは、添付の上げ（8 節）をしてから画像のノードを入れる。上げの間は置き物を描く。
- 1 回の貼り付けで 256 KiB を超える更新は、複数のトランザクションに分ける（[sync-engine.md](sync-engine.md) の 4.3 節）。

### 3.5 Undo

- 本文の中の Undo は y-prosemirror の `yUndoPlugin`（自分の変更だけを戻す）。他の人の変更は戻さない。
- エディタの外の操作（状態の変更など）の Undo は、画面の Undo の列が持つ（[client-app.md](client-app.md) の 4.4 節）。本文にフォーカスがある間の `Cmd/Ctrl+Z` はエディタが受ける。

## 4. 本文のモデルと同期

ADR-0021。

### 4.1 モデル

```ts
model("IssueDescription", {
  groups: { rule: "via", from: "issue_id" },
  load: { strategy: "lazy" }, delete: { mode: "hard" },
  fields: {
    issue_id:   { type: "ref:Issue", conflict: "server_only", on_delete: "cascade", index: true },
    doc:        { type: "crdt_doc", conflict: "crdt" },
    text_len:   { type: "int", conflict: "server_only" },            // Worker が書く
    state_size: { type: "int", conflict: "server_only" },
  },
});
```

- `id` はイシューの `id` と同じにする。`create Issue` の派生で、Writer が空の本文の行を作る（ADR-0025）。クライアントは、イシューを作るトランザクションに本文の `append` を続けて入れてよい。
- `doc` は行の JSON に入れない。`update` の差分は `doc` を運ばず、本文の変更は `append` の差分だけで届く（[sync-engine.md](sync-engine.md) の 7.2 節）。

### 4.2 サーバーの保存

```sql
CREATE TABLE doc_states (
  workspace_id        uuid    NOT NULL,
  model               text    NOT NULL,   -- 'IssueDescription' など
  id                  uuid    NOT NULL,
  state               bytea   NOT NULL,   -- Y.encodeStateAsUpdate（V1）
  compacted_through   bigint  NOT NULL,   -- この sync_id までの append を含む
  state_size          integer NOT NULL,
  pending_bytes       integer NOT NULL DEFAULT 0,  -- まとめていない append の合計
  text_plain          text,               -- 検索と大きさの判定のため
  PRIMARY KEY (workspace_id, model, id)
);
```

- `append` の本体は `sync_actions` の `data`（base64）にある。Writer は `doc_states.pending_bytes` を足すだけで、`state` は書き換えない（ロックの中で大きな文書を読み込まないため）。
- **まとめ**（Worker）：`append` が来た文書を、最後の `append` から 3 秒、または最初のまとめていない `append` から 30 秒でまとめる。`state` と `compacted_through` の後の `append` を `Y.Doc` に読み込み（削除した中身のごみ集めのため）、`Y.encodeStateAsUpdate` で書き直す。同時に `text_plain`・メンション（6 節）・`text_len` を作る。同じ文書のまとめは 1 つずつ（SQS の FIFO のグループを文書の ID にする）。書き込みは `compacted_through` が進む時だけ（楽観の条件付きの `UPDATE`）。
- `text_len`・`state_size` の行の更新は、Worker のシステムのトランザクションで Writer を通す（差分で配る）。
- **ログの保持との関係**：保持のジョブ（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 8.1 節）は、`compacted_through` が落とすパーティションの最後の `sync_id` より小さい文書があれば、先にまとめを求め、終わるまでそのパーティションを落とさない。

### 4.3 送り方

- クライアントは、エディタの Yjs の更新（打鍵ごと）を 250ms、または入力の区切り（フォーカスを外す、画面を離れる）まで貯め、`Y.mergeUpdates` で 1 つにし、`{op: "append", m: "IssueDescription", id, v}` の 1 つのトランザクションにする。
- 貯める間の更新は、メモリーの `Y.Doc` には当たっている（画面は待たない）。outbox に入るまでの 250ms は ADR-0005 の保証の外で、落ちると失う。組み立て中の文字は Yjs に入らないので、この窓に入らない。
- Writer の検証（[sync-engine.md](sync-engine.md) の 5.3 節に加えて）：
  - 更新が Yjs の V1 の形として読める（`Y.decodeUpdate` が失敗しない）。読めなければ `invalid`。
  - 1 つの更新は 256 KiB まで。`state_size + pending_bytes + 更新` が 4 MiB を超えたら `too_large`。
  - `can(actor, "update", issue)`。
- 中身（スキーマに合うか）はサーバーで確かめない。CRDT の更新は合わさるので、途中で拒否すると他の更新と食い違うため（ADR-0002 が本文だけを CRDT にした理由）。スキーマに合わない中身は、描く時に y-prosemirror が落とし、Worker のテキストの抜き出しも無視する。

### 4.4 読み込み

- 被覆の鍵は `IssueDescription:id=<issue_id>`。イシューの `include` に入っている（[data-model-and-schema.md](data-model-and-schema.md) の 3.1 節）。
- Sync API は、1 つの読み取りのトランザクションで `doc_states` と `compacted_through` の後の `append` を読み、`Y.mergeUpdates` で 1 つにして、行の `state`（base64）と `_u`（読んだ時点の `sync_id`）として返す。まとめの遅れに関わらず、読んだ時点の全部を含む。
- 要求の `build` が `min_build` より古ければ、`426 upgrade_required` で断る（3.2 節。知らないノードを古いクライアントに渡さない）。
- クライアントは、受けた `state` を手元の状態に `Y.mergeUpdates` で合わせる。Yjs の更新は冪等なので、読み込みと差分の `append` が重なっても、順序が入れ替わっても、結果は同じ（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 6.3 節の `_u` の比べ方は、本文には要らない）。

### 4.5 手元の保存と画面

ADR-0014 が予約した `_doc_*` の名前で、次の store を持つ（構成の正本は [client-store-and-offline.md](client-store-and-offline.md) の 3.2 節）。

| store | キー | 中身 |
| --- | --- | --- |
| `_doc_state` | `[m, id]` | 確定した更新をまとめた状態（`state`）、`as_of`、最後に開いた時刻 |
| `_doc_updates` | `[m, id, s]` | 被覆のない文書に差分で届いた `append`（`s` は `sync_id`） |

- 差分の `append` の保存：`_doc_state` があれば、差分のパケットと同じ IndexedDB のトランザクションで `Y.mergeUpdates` して書き直す。なければ `_doc_updates` に積む。1 つの文書の `_doc_updates` が 256 KiB を超えたら、積んだものを捨てる（次に開いた時の読み込みが全部を含むので失わない）。
- 開いた時：`_doc_state` と `_doc_updates` を合わせ、outbox の未確定の `append` を当てた `Y.Doc` を作る。これが `view` である（[sync-engine.md](sync-engine.md) の 6.2 節の `append(u)` の当て方）。
- 確定の差分は、開いている `Y.Doc` にも当てる（冪等なので、自分の更新が戻ってきても変わらない）。
- **拒否**：`append` が拒否されたら、`_doc_state` と残りの未確定の `append` から `Y.Doc` を作り直す（Yjs の更新は取り消せないので、作り直す）。拒否された更新の平文を `_rejected` に残し、本人がコピーできるようにする。
- 退かし：`_doc_state` は M3（[client-store-and-offline.md](client-store-and-offline.md) の 7.1 節）で、70% の退かしの対象。未確定の `append` のある文書は退かさない。
- 開いていない本文は、Yjs に読み込まない。一覧の描画に本文は要らない（NFR-001 の対象外）。

### 4.6 clientID

- `Y.Doc` を作るたびに新しい clientID を振る（Yjs の既定）。同じ文書を 2 つのタブで開けば、別の clientID になる。
- outbox に残った前のセッションの `append` は、前の clientID の更新のままで送る。新しいセッションは同じ clientID を使わないので、Yjs の注意（使い回しの禁止）に反しない。

### 4.7 本文のバージョン

- Worker のまとめが、前のバージョンから 10 分以上経ち、`text_plain` が変わっていれば、`IssueDescriptionVersion`（`via` のグループ、`lazy`）を作る。中身は `state`、`text_plain`、`actor_ids`（その間に書いた人）、`at`（`created_at`）。1 つの本文で 100 バージョンか 90 日まで持つ。`state` は `bytes` の型で、差分に載せず、バージョンを ID で読み込んだ時だけ返す（最大 4 MiB で、Relay の 1 メッセージ 1 MiB に収まらないため）。`text_plain` はサーバーだけの列（[data-model/issues.md](data-model/issues.md)。2026-09-28 に決めた）。
- 戻す：画面はバージョンの `state` を別の `Y.Doc` に読み込み、ProseMirror の文書にし、今の本文をその内容に置き換える編集として当てる。結果は普通の `append` になる。戻しの間に他の人が書いた分は、置き換えの後に合わさる。
- バージョンを消す：`owner`・`admin` は、1 つのバージョンか、ある時刻より前の全部のバージョンを消せる（`delete IssueDescriptionVersion`。DT-PERM-003）。消したつもりの秘密（トークンの貼り付け）をバージョンから消すため。操作はワークスペースの監査に残す（[security.md](security.md) の 6 節）。今の本文の CRDT の状態（`doc_states`）には、ごみ集めの後は消した文字が残らない。security の領域の依頼を受けて、統合の工程で足した。

### 4.8 上限

| 項目 | 上限 |
| --- | --- |
| 1 つの `append` | 256 KiB（[sync-engine.md](sync-engine.md) の 4.3 節） |
| 本文の状態 | 4 MiB（まとめた後の大きさとまとめていない分の和） |
| 本文の文字 | 20 万字（Worker が `text_len` で見て、超えたら画面が警告し、次の `append` を `too_large` にする） |
| 画像のノード | 1 つの本文に 200 |
| 送りのまとめ | 250ms |
| バージョン | 100 バージョンか 90 日 |

## 5. コメント

ADR-0022。

### 5.1 モデル

```ts
model("Comment", {
  groups: { rule: "via", from: "issue_id" }, load: { strategy: "lazy" }, delete: { mode: "hard" },
  fields: {
    issue_id:    { type: "ref:Issue", conflict: "server_only", on_delete: "cascade", index: true },
    parent_id:   { type: "ref:Comment", conflict: "server_only", nullable: true, on_delete: "cascade", index: true },
    author_id:   { type: "ref:User", conflict: "server_only", nullable: true, on_delete: "nullify", import_writable: true },
    body:        { type: "json", conflict: "lww", schema: "RichTextDoc", max_bytes: 65536, pii: "content" },
    edited_at:   { type: "timestamp", conflict: "server_only", nullable: true },
    resolved_at: { type: "timestamp", conflict: "lww", nullable: true },
    resolved_by: { type: "ref:User", conflict: "server_only", nullable: true, on_delete: "nullify" },
    anchor:      { type: "json", conflict: "server_only", nullable: true, schema: "DescriptionAnchor" },
  },
});
model("Reaction", {
  groups: { rule: "via", from: "comment_id" }, load: { strategy: "lazy" }, delete: { mode: "hard" },
  fields: {
    comment_id: { type: "ref:Comment", conflict: "server_only", on_delete: "cascade", index: true },
    user_id:    { type: "ref:User", conflict: "server_only", on_delete: "cascade" },
    emoji:      { type: "string", conflict: "server_only", max: 64 },
  },
});
```

- `body` は ProseMirror の JSON（3.2 節のスキーマ）。Writer は `RichTextDoc` の JSON Schema と 64 KiB を確かめる。
- **CRDT にしない理由**：コメントを直せるのは作った人だけ（本家と同じ。`can()` の規則）。同時に書く人がいないので、LWW で失うのは同じ人の 2 台の端末の同時の編集だけである。コメントは数が多く、1 件ごとに Yjs の状態と読み込みを持つ費用に見合わない。これは ADR-0002 の競合の表の「本文」の行のうち、コメントの本文だけを変える決定で、ADR-0022 に書いた。
- スレッドは 1 段：`parent_id` はスレッドの最初のコメントだけを指す（返信への返信は、最初のコメントへの返信にする）。
- 解決はスレッドの最初のコメントの `resolved_at`。`resolved_by` は派生（ADR-0025）で書く。
- コメントの削除：返信のない コメントは `delete`。返信のあるスレッドの最初のコメントは、`body` を空にし「削除されたコメント」と示す（スレッドを残す）。
- リアクションは作るか消すかだけ。同じ `(comment_id, user_id, emoji)` は `already_exists`（画面に示さない）。
- コメントの作成は、イシューの `activity_at` を進め、Triage のスヌーズを外す（[issues-and-workflow.md](issues-and-workflow.md) の 3.3・10.2 節。派生）。

## 6. メンションと参照

ADR-0022。

- メンションは、インラインのノード `{kind, id}` で持つ。表示の文字（名前、`ENG-123`）は持たず、描く時に手元のモデルから作る（ADR-0020）。手元にないものは読み込み、見てよくないものは「非公開」、ないものは「不明」と描く。
- 候補（`@` の後）は、手元の M1・M2（利用者、チーム、イシューの識別子とタイトル、プロジェクト）から出す（[client-app.md](client-app.md) の 6 節の同じ照合の関数）。非公開のチームのイシューでは、そのチームのメンバーでない利用者を候補に出さない（本家と同じ。ADR-0004）。
- **コメントのメンション**：`create Comment`・`set body` の派生で、メンションされた利用者を `subscriber_ids` に足し、通知の元の事象を出す（ADR-0025。見てよい人だけ）。
- **本文のメンション**：本文は CRDT なので、Writer は `append` の中身を読まない。Worker のまとめ（4.2 節）が、前のまとめのメンションの集合と比べ、増えた利用者について、Writer のシステムのトランザクションで購読を足し、通知の元の事象を出す。遅れは、最後の `append` から 3 秒＋まとめの時間。サーバーだけの表 `doc_mentions`（`workspace_id, model, id, kind, target_id, first_sync_id`）に集合を持つ。
- 見てよくない人のメンションは、通知せず、購読させない。本文には ID が残るが、その人のクライアントには本文が届かない。
- イシューの参照（`kind: issue`）の逆向き（「このイシューを参照しているもの」）は MVP で持たない。

## 7. インラインのコメント

ADR-0022。

- 本文の範囲を選んでコメントを作ると、`Comment.anchor` に次を入れる。

```json
{ "doc": "IssueDescription", "start": "<base64 の Y.RelativePosition（assoc 0）>",
  "end": "<base64 の Y.RelativePosition（assoc -1）>", "quote": "選んだ文字（500 字まで）" }
```

- 相対位置は、選んだ範囲の最初の文字の後ろ側と、最後の文字の前側に付ける。範囲の外で文字を足しても、範囲は広がらない。
- **本文の中に印を書かない。** 強調の表示は、ProseMirror の装飾（decoration）として、`resolveAnchor` で今の位置に描く。本文の CRDT に書かないので、コメントの作成・解決・削除が本文の同時編集とぶつからない。コメントを見てよい人と本文を見てよい人は同じ（同じイシューのグループ）なので、別に持っても権限はずれない。
- 範囲の文字がすべて消されたら（`start` が `end` 以降に解決される、または解決が `null`）、アンカーを「外れた」として扱い、強調を消し、コメントの一覧に `quote` と一緒に出す。
- オフラインで書いた文字にアンカーを付けた場合、コメントのトランザクションは本文の `append` の後に outbox に入る。確定の順は outbox の順なので、他のクライアントはアンカーの前に文字を受ける。
- アンカーは作成の時だけ書き、変えない（`server_only`）。解決したスレッドの強調は描かない。

## 8. 添付ファイル

ADR-0022。

### 8.1 モデル

```ts
model("Attachment", {
  groups: { rule: "via", from: "issue_id" }, load: { strategy: "lazy" }, delete: { mode: "hard" },
  fields: {
    issue_id:     { type: "ref:Issue", conflict: "server_only", on_delete: "cascade", index: true },
    comment_id:   { type: "ref:Comment", conflict: "server_only", nullable: true, on_delete: "nullify" },
    uploader_id:  { type: "ref:User", conflict: "server_only", nullable: true, on_delete: "nullify" },
    name:         { type: "string", conflict: "lww", max: 255, pii: "content" },
    content_type: { type: "string", conflict: "server_only", max: 128 },
    size:         { type: "int", conflict: "server_only" },
    state:        { type: "enum<pending,ready,failed>", conflict: "server_only" },
    upload_ref:   { type: "string", conflict: "server_only", max: 1024, api: "internal" },
  },
});
```

### 8.2 上げ

```
Client                      Sync API                         S3（非公開のバケット）
  │ POST /files/uploads {workspace, issue_id, name, type, size, sha256}
  │───────────────────────▶│ can(actor, update, issue)、大きさ・種類の確かめ
  │                        │ key = ws/<workspace_id>/att/<attachment_id>/<乱数>
  │◀── {attachment_id, put_url（15 分）, headers, upload_ref（24 時間）}
  │ PUT put_url（Content-Type、Content-Length、x-amz-checksum-sha256 を署名に含める）──────▶│
  │ tx: create Attachment {id: attachment_id, upload_ref, name}（本文なら画像のノードも）
  ▼
Writer：upload_ref の HMAC（workspace・attachment_id・key・size・type・期限）を確かめ、state = pending で作る
Worker：S3 の HEAD で大きさと SHA-256 を確かめ → state = ready（合わなければ failed と、中身の削除）
```

- クライアントはブラウザから S3 へ直接上げる。本家の API の案内は「サーバーから上げる」だが、それは API の利用者の話で、本システムの Web のクライアントは自分の CSP の `connect-src` に上げ先を入れる。
- オフラインで付けたものは、`_blobs` に保存し、つながってから書き手のタブが上げの URL を取って上げる（[client-store-and-offline.md](client-store-and-offline.md) の 5.5 節）。`upload_ref` は上げの時に取るので、期限の 24 時間はオフラインの長さに影響されない。
- 1 ファイル 100 MiB（オンライン）。オフラインは 25 MiB・合計 200 MiB（client-store-and-offline の決定）。本家の上限は**未検証**で、これは本システムの値。
- 種類：画像（PNG・JPEG・GIF・WebP）、PDF、テキスト、動画（MP4・WebM）、その他は「ダウンロードだけ」として受ける。SVG・HTML は受けるが、常にダウンロードにする。
- 上げたが `create Attachment` に至らなかった中身は、S3 の上げの時に付けた `pending` のタグと、7 日で消すライフサイクルの規則で消す。`ready` にした時にタグを外す。

### 8.3 配り

- `GET https://<brand>.<domain>/files/<attachment_id>`：セッションで `can(actor, read, issue)` を確かめ、`https://<brand>usercontent.<domain>/...` の CloudFront の署名付きの URL（5 分）へ 302 で転送する。
- 別のドメインから配る。応答には `X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox`、画像・PDF・動画以外は `Content-Disposition: attachment` を付ける。本体のドメインのクッキーが届かず、上げた HTML やスクリプトが本体のドメインで動かない。
- 署名付きの URL は持っている人なら誰でも読めるので、期限を 5 分にし、画面では毎回 `/files/<id>` から取り直す。URL をログに書かない。
- 手元の保存：オフラインでの添付の表示は MVP で持たない（[client-store-and-offline.md](client-store-and-offline.md) の 9.4 節）。画像はブラウザの HTTP のキャッシュに任せ、`Cache-Control: private, max-age=300` にする。

### 8.4 消去

- `Attachment` の `delete` の後、Worker が 30 日後に S3 の中身を消す（その間は Undo と、ゴミ箱のイシューの戻しで使える）。
- イシューのゴミ箱の消去（[issues-and-workflow.md](issues-and-workflow.md) の 13 節）で、`cascade` で行が消え、同じ規則で中身が消える。
- ワークスペースの解約の中身の消去は security の領域。

## 9. 性能の予算

| 場面 | 目標 |
| --- | --- |
| 本文の 1 打鍵（2 万字の本文）から描画 | p95 16ms（1 フレーム） |
| 本文を開く（手元に `_doc_state` あり、2 万字） | p95 150ms（NFR-001 の対象外） |
| 本文を開く（手元になし） | p95 600ms（読み込みの往復を含む） |
| 他の人の打鍵が届くまで | 送りのまとめ 250ms ＋ NFR-002 の伝播（p99 1 秒） |
| まとめ（Worker、1 MiB の状態） | p95 200ms |

- 計測は [client-app.md](client-app.md) の 9 節の仕組みで行う。

## 10. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| まとめの Worker が遅れる・止まる | `pending_bytes` が増える。検索とメンションの通知が遅れる | 読み込みは `append` を合わせて返すので中身は正しい。`pending_bytes` の上限で `too_large` になる前に警告。保持のジョブがパーティションを落とさない |
| `append` が拒否された | 画面の文字が消える | 4.5 節の作り直しと、平文を `_rejected` に残す |
| 知らないノードを古いクライアントが受けた | 共有の文書から消える（y-prosemirror の振る舞い） | 3.2 節の手順で、古いクライアントに届く前に `min_build` で締め出す |
| 同じ人が 2 台でコメントを同時に直した | 後に確定した方が勝つ | 仕様（5.1 節）。上書きの記録の対象にしない |
| アンカーの文字が消えた | 強調が出ない | 7 節の「外れた」の表示 |
| S3 への上げが途中で切れた | `create Attachment` が送られない、または `pending` のまま | 送り直し。`pending` が 1 時間続けば Worker が `failed` にし、画面が上げ直しを促す |
| 署名付きの URL が漏れた | 5 分の間、誰でも読める | 期限、ログに書かない、`Referrer-Policy: no-referrer` |

## 11. セキュリティ

- 本文とコメントは、どちらも利用者の書いた中身（`pii: content`）。ログ・トレース・メトリクスには、大きさと ID だけを書く。
- 描画は ProseMirror のスキーマを通したものだけ。HTML をそのまま差し込まない。リンクの `href` を 3.2 節の規則で絞る。
- 本文の `append` は中身を検証できない（4.3 節）。悪意のある更新で本文を大きくすることは、大きさの上限で止める。壊れた更新（Yjs として読めない）は `invalid` で拒否し、ログに載せない。
- 本文のバージョン（4.7 節）には、消した文字も残る。消したつもりの秘密（トークンの貼り付け）はバージョンから見える。`owner`・`admin` はバージョンを消せる（4.7 節、DT-PERM-003）。
- 添付は別のドメインから、短い期限の署名付きの URL で配る（8.3 節）。上げの URL は、大きさ・種類・SHA-256 を署名に含め、別の中身を上げられないようにする。
- 非公開のチームの添付は、`/files/<id>` の `can()` で絞る。S3 と CloudFront はワークスペースのプレフィックスで分けるが、権限の判定はしない。
- メンションの候補と通知は、見てよい人に絞る（6 節）。

## 12. テスト

- 性質ベーステスト（[ADR-0010](../decisions/0010-deterministic-sync-simulator.md) のシミュレーター。`packages/doc` を本物で動かす）：
  - **PROP-DOC-001（本文の収束）**：任意の打鍵・オフライン・拒否・読み込み・差分の順序の入れ替わりの後、本文を開いた全クライアントの ProseMirror の文書が、サーバーの `doc_states` と後の `append` を合わせた文書と一致する。
  - **PROP-DOC-002（失わない）**：outbox にコミットした `append` の文字は、拒否されない限り、最終的な本文に（消されていなければ）残る。
  - **PROP-DOC-003（まとめの同値）**：任意の時点でまとめても、まとめた状態と後の `append` を合わせた文書は、まとめない場合と同じ。
  - **PROP-DOC-004（アンカー）**：任意の編集の列の後、アンカーの解決は、範囲の文字が 1 つでも残っていればその文字を含み、範囲の外の文字を含まない。すべて消えれば「外れた」になる。
  - **PROP-DOC-005（メンションの通知）**：本文とコメントのメンションで、見てよくない人に通知の事象が出ない。
- 例示テスト：3.3 節の入力の規則、3.4 節の貼り付けの落とし方（`script`、`style`、`javascript:` のリンク）。
- IME：[client-app.md](client-app.md) の 5.3 節の組み合わせ（OS × IME × ブラウザ）で、本文とコメントの入力、組み立て中の Enter、入力の規則の抑止を確かめる。
- 結合テスト：上げの URL の署名の外の大きさ・種類の `PUT` が S3 で拒否される。期限切れの `upload_ref` が拒否される。見てよくない人の `/files/<id>` が 404。
- 互換：3.2 節の手順の試験（`doc-schema-compat`）。(1) 1 つ前のバージョンのスキーマで新しいノードを含む本文を開くと、y-prosemirror がそのノードを消すことを回帰テストに残す（前提が変わったら気づく）。(2) `min_build` より古いクライアントは、Gateway でも Sync API の本文の読み込みでも、新しいノードを含む本文を受けない。(3) フラグを開く前に、新しいノードを作る操作がない。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E5 | `doc-package` | `packages/doc`（Yjs と y-prosemirror を閉じる API） |
| E5 | `doc-schema-compat` | 3.2 節のノードの追加の手順（読めるバージョン → `min_build` → 作成のフラグ）と、その試験 |
| E5 | `description-editor` | 3.2〜3.5 節のスキーマ、入力の補助、貼り付け、Undo |
| E5 | `description-append-sync` | 4.1・4.3 節の送り方と Writer の検証 |
| E5 | `doc-compaction-worker` | 4.2 節のまとめ、テキストの抜き出し、保持のジョブとの連携 |
| E5 | `description-lazy-load` | 4.4 節の読み込み（読んだ時点までを合わせる） |
| E5 | `doc-local-store` | 4.5 節の `_doc_state`・`_doc_updates`、拒否の作り直し（client-store-and-offline と共同） |
| E5 | `description-versions` | 4.7 節のバージョンと戻し |
| E5 | `comments-and-threads` | 5 節のコメント、スレッド、解決、削除 |
| E5 | `reactions` | 5.1 節のリアクション |
| E5 | `mentions` | 6 節の候補、描画、コメントの派生、本文の Worker の抜き出し |
| E5 | `inline-comments` | 7 節のアンカー、装飾、外れた表示 |
| E5 | `attachments-upload` | 8.2 節の上げ、`upload_ref`、Worker の確かめ |
| E5 | `attachments-serve` | 8.3 節の配り、別のドメイン、署名付きの URL |
| E5 | `doc-sim-props` | 12 節の PROP-DOC-001〜005 |
| E9 | `mention-notifications` | メンションの通知の事象（notifications-and-inbox と共同） |
| E12 | `attachment-storage-lifecycle` | 8.4 節の消去、`pending` のライフサイクル |

## 14. 未解決の問い

- 本文の CRDT を Yjs にするか、自前（Fugue＋Peritext。Notion の題材と同じ）にするか。
- コメントの本文も CRDT にするか。
- インラインのコメントの印を、本文の CRDT の中に書くか、コメントの行に持つか。
- 他の人のカーソルと「編集中」の表示を MVP に入れるか。
- 表と埋め込みを MVP に入れるか。
- 添付の大きさの上限。
- 添付のマルウェアの検査をするか。

### 決定

2026-09-28 の既定案。E5 の前の PoC で覆りうる。

- **本文の CRDT**：Yjs と y-prosemirror。`packages/doc` の中に閉じる（ADR-0021）。
- **送りのまとめ**：250ms（ADR-0021）。
- **サーバーのまとめ**：Worker が 3 秒の静けさか 30 秒で。読み込みは読んだ時点までを合わせて返す（ADR-0021）。
- **コメントの本文**：ProseMirror の JSON を LWW。ADR-0002 の表の「コメントの本文」を変える（ADR-0022）。
- **インラインのコメント**：本文に書かず、コメントの行に Yjs の相対位置の組を持つ（ADR-0022）。
- **カーソルと編集中の表示**：MVP で持たない。Gateway のプロトコル（ADR-0009）に一時の在席のメッセージがないため。
- **表と埋め込み**：MVP で持たない。
- **添付の上限**：1 ファイル 100 MiB。種類は 8.2 節。
- **マルウェアの検査**：MVP でしない。危ない種類は常にダウンロードにし、別のドメインから配る。
- **本文のバージョン**：10 分ごと、100 バージョンか 90 日。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Yjs の次の大きなバージョン（更新の形の互換） | バージョンを固定し、上げる時に 1 つ前のバージョンの更新との互換を試験してから ADR で決める |
| カーソルと在席の表示 | 試用の声。入れるなら Gateway のプロトコルに一時のメッセージを足す ADR（sync-engine の領域と共同） |
| 本文のバージョンに残る消した秘密の扱い | security の領域と法務の L5 |
| 本家の本文の CRDT の部品、添付の上限、インラインのコメントの保存の形 | 公式の資料で確かめられなかった（**未検証**のまま） |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- PROP-DOC-001〜005 を E5 のリリースの基準にする。
- IME の手動の確認表（本文とコメント）を、ブラウザの大きなバージョンの更新のたびに流す。
- 本番：`append` の拒否の率（`too_large`・`invalid`）。`invalid` が出たら、クライアントの Yjs のバージョンのずれを疑う。
- 本番：まとめの遅れ（最初のまとめていない `append` からの時間）の p95 と、`pending_bytes` の分布。
- 本番：メンションの通知の遅れ（`append` の確定から通知の事象まで）の p95 10 秒。
- 本番：添付の `failed` の率と、`pending` が 1 時間を超えた件数。

### runbooks

- `doc-compaction-lag.md`：まとめの遅れの確かめ方（SQS の滞留、大きな文書、Worker の失敗）と、保持のジョブの待ちの確認。
- `doc-corruption.md`：本文が開けない・描けない報告への対応（`doc_states` と `append` の取り出し、`packages/doc` での再生、バージョンからの戻し）。
- `attachment-url-leak.md`：署名付きの URL の漏えいの疑い（鍵の入れ替え、該当の中身の移動）。

### data-model（索引への追加の提案）

| 表・置き場所 | 中身 | 節 |
| --- | --- | --- |
| `issue_descriptions`（`IssueDescription`） | 本文の行（`text_len`、`state_size`） | 4.1 |
| `doc_states` | まとめた Yjs の状態、`compacted_through`、`pending_bytes`、`text_plain` | 4.2 |
| `sync_actions` の `append` | 本文の更新（base64） | 4.3 |
| `issue_description_versions`（`IssueDescriptionVersion`） | 本文のバージョン（`via`、`lazy`） | 4.7 |
| `comments`・`reactions` | コメント（LWW の JSON、アンカー）、リアクション | 5.1、7 |
| `doc_mentions`（サーバーだけ） | 本文のメンションの集合 | 6 |
| `attachments` | 添付の行と状態 | 8.1 |
| S3 `ws/<workspace_id>/att/…` | 添付の中身 | 8.2 |
| 手元の `_doc_state`・`_doc_updates` | 確定した本文の状態、被覆のない本文への `append` | 4.5 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Editor](https://linear.app/docs/editor)、[Edit issues](https://linear.app/docs/editing-issues)、[Comments and reactions](https://linear.app/docs/comment-on-issues)
- Linear Changelog, [Editor improvements](https://linear.app/changelog/2023-12-06-editor-improvements)（2023-12-06）
- Linear Developers, [How to upload a file to Linear](https://linear.app/developers/how-to-upload-a-file-to-linear)
- Yjs Docs, [Document Updates](https://docs.yjs.dev/api/document-updates)、[Y.RelativePosition](https://docs.yjs.dev/api/relative-positions)、[Y.Doc](https://docs.yjs.dev/api/y.doc)、[y-prosemirror](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror)
- npm, [yjs](https://www.npmjs.com/package/yjs)（13.6.33）、[y-prosemirror](https://www.npmjs.com/package/y-prosemirror)（1.3.7）

# Plugins: Figma

プラグイン（利用者が選んで動かす、第三者の JavaScript）の実行環境、API、UI、通信の制限、配布と審査。ウィジェットは後に回す。**MVP の後に作る**（[intent.md](../intent.md) の「MVP の後に扱う」）。

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0037](../decisions/0037-plugin-sandbox-quickjs-wasm.md) | プラグインのコードは、QuickJS を WASM にした専用のインスタンスで、メインスレッドで動かす。UI と通信は、別のオリジンの null origin の iframe に置く |
| [0038](../decisions/0038-plugin-api-and-capabilities.md) | プラグインの API は、動かした人の権限の中で動き、manifest で宣言した能力と通信先だけを許す。書き込みは通常の変更（ChangeSet）になる |
| [0039](../decisions/0039-plugin-distribution-and-review.md) | 組織の中のプラグインは審査なしで配り、公開のプラグインは審査する。すべての版を不変に保存し、停止のスイッチを持つ。ウィジェットは別の ADR |

## 1. 目的と範囲

- 扱う：プラグインの実行環境（サンドボックス）、API の面、UI の iframe、通信の制限、保存（`plugin_data`・端末の保存）、manifest、開発・配布・審査・停止、組織の管理者の統制。
- 扱わない：公開 REST API（[api-and-webhooks.md](api-and-webhooks.md)）、ウィジェット（13 節で方向だけ）、Dev Mode のコード生成のプラグイン（Dev Mode 相当が MVP の後のため）、有料のプラグインの課金。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） |
| --- | --- |
| 実行モデルの変遷 | iframe（null origin）を試したが、非同期の API が設計者に難しく、大きな文書の直列化に 14 秒かかった。Duktape を WASM にした解釈器も試した（遅い、ES5 だけ）。Realms の shim でメインスレッドに置く形を選び、UI は iframe に分けた。境界は約 500 行の membrane で守る（[How to build a plugin system on the web and also sleep well at night](https://www.figma.com/blog/how-we-built-the-figma-plugin-system/)、2019-08-22） |
| Realms の脆弱性 | Realms の shim に、サンドボックスの内と外のオブジェクトを取り違える脆弱性が複数見つかった。QuickJS（C の JavaScript の VM）を WASM にしたものに替えた。表現が違いすぎて取り違えが起きない。一部のプラグインは遅くなった。2019-09-14 に報告、09-25 に QuickJS を出して公開を再開、悪用の証拠はない（[An update on plugin security](https://www.figma.com/blog/an-update-on-plugin-security/)、2019-10-02） |
| 今の環境 | メインスレッドのサンドボックスで動く。ES2020 以降の構文と標準の組み込みはあるが、`fetch`・`setTimeout`・DOM などのブラウザの API はない。UI とブラウザの API は `showUI()` の iframe で使い、メインスレッドとはメッセージで話す（[How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/)） |
| 通信 | サンドボックスから `fetch` に似た API で通信できる。iframe は null origin なので、`Access-Control-Allow-Origin: *` の API だけを呼べる。manifest の `networkAccess.allowedDomains` に無い宛先は CSP で止める。`"*"` やローカルの宛先には `reasoning` が要る。iframe に Web サイトを出すと、そのサイトが読む外部の資源は制限されない（[Making Network Requests](https://developers.figma.com/docs/plugins/making-network-requests/)、[How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/)） |
| manifest | `name`・`id`・`api`・`main`・`ui`・`editorType`・`documentAccess: "dynamic-page"`・`networkAccess`・`permissions`（`currentuser`・`activeusers`・`fileusers`・`payments`・`teamlibrary`）・`capabilities` など（[Plugin Manifest](https://developers.figma.com/docs/plugins/manifest/)） |
| 審査 | 公開のプラグイン・ウィジェットは初回に審査があり、通常 5〜10 営業日（遅れがある）。承認の後の更新は審査しない（[Publish widgets to the Figma Community](https://help.figma.com/hc/en-us/articles/4410337103639-Publish-widgets-to-the-Figma-Community)。検索結果の要約で確認） |

いずれも 2026-09-27 に確認。

## 3. 脅威モデル

| 攻撃者 | 狙い | 守り |
| --- | --- | --- |
| 悪意のあるプラグインの作者 | 利用者のセッション（Cookie、トークン）を盗む、利用者として内部の API を呼ぶ | サンドボックスは DOM・`fetch`・Cookie を持たない（ADR-0037）。UI の iframe は別のオリジン（`plugin-ui.<brand>usercontent.<domain>`）で null origin |
| 同上 | 開いたファイルの中身を外へ送る | 避けられない（プラグインは読む権利を持って動く）。通信先を manifest で宣言させ、動かす前に見せ、CSP で止める。組織の管理者は、許可したプラグインだけに絞れる（ADR-0038・0039） |
| 同上 | 開いたファイル以外（他のファイル、組織の一覧）を読む | API はいま開いたファイルだけを扱う。内部の API は呼べない |
| 同上 | サンドボックスから逃げる | QuickJS の欠陥は WASM の線形メモリの中に閉じる。逃げるには、ホストの関数（membrane）の欠陥か、ブラウザの WASM の実装の欠陥が要る（ADR-0037） |
| 同上 | UI を止める、メモリを使い切る | 実行の時間とメモリの上限（4.3 節） |
| 同上 | 利用者をだます UI（偽のログイン画面） | UI の iframe の枠に、プラグインの名前と作者を常に出す。iframe はアプリの画面の上に重ねられない |
| 正規のプラグインの乗っ取り（作者のアカウント、依存のライブラリ） | 次の更新で悪意のあるコードを配る | 更新の自動の検査、権限の拡大の再審査、停止のスイッチ（ADR-0039） |

rebuilds の Cloudflare Workers は、多数のテナントの信頼できないコードをサーバーで動かすので、V8 の isolate に多層の防御を重ねた（[Cloudflare Workers の ADR-0002](../../../cloudflare-workers/docs/decisions/0002-isolation-model.md)）。プラグインは、利用者の端末で、その利用者が選んだコードを動かす。守る相手は他のテナントではなく、**同じタブの中の、利用者のセッションと他のデータ**である。そのため、境界は「プロセスとカーネル」ではなく「ホストの関数だけが外へ通じる WASM のインスタンス」と「別のオリジン」の 2 つにする。

## 4. 実行環境

ADR-0037。

### 4.1 構成

```
アプリのオリジン（app.<domain>）のメインスレッド
 ├─ UI の殻（React）
 ├─ エンジン（WASM。doc-model・描画）
 └─ プラグインのホスト（TypeScript）
      ├─ QuickJS の WASM のインスタンス（プラグインごとに 1 つ。別の WebAssembly.Memory）
      │    └─ プラグインの main のコード。グローバルは <brand> オブジェクトと console だけ
      └─ membrane：ハンドルの表、値の写し、ホストの関数（API の実装）
             │ エンジンの読み取り・変更の API を直接呼ぶ
             │
             │ postMessage（構造化複製）
             ▼
 iframe（plugin-ui.<brand>usercontent.<domain>、sandbox="allow-scripts allow-forms allow-popups"、null origin）
   ├─ プラグインの UI（HTML・JS）
   └─ 通信の中継（サンドボックスの fetch はここから出る）。CSP の connect-src = allowedDomains
```

- QuickJS は、`quickjs-emscripten` の WASM のビルド（quickjs-ng の変種を候補）を使う（[quickjs-emscripten](https://github.com/justjake/quickjs-emscripten)、2026-09-27 に確認）。ランタイムのメモリの上限（`setMemoryLimit`）、スタックの上限（`setMaxStackSize`）、割り込みの関数（`setInterruptHandler`）を持つ。
- **エンジンの WASM と QuickJS の WASM は、別のモジュール・別のメモリにする。** QuickJS の中の値は、ホストの関数を通らなければエンジンにもアプリの JavaScript にも届かない。
- プラグインを閉じたら、QuickJS のインスタンスを捨てる。プラグインの間で状態を共有しない。

### 4.2 membrane（境界）

- ノードは、QuickJS の中では **ハンドル**（プラグインの実行ごとの小さな整数）を持つ代理のオブジェクトとして見える。ホストの側のハンドルの表が、ハンドルを `NodeId` に対応させる。ホストの JavaScript のオブジェクトを QuickJS に渡さない。
- 値は写して渡す（数・文字列・配列・素のオブジェクト・`Uint8Array`）。関数は、プラグインが登録するコールバック（イベント）だけを受ける。ホストの関数を QuickJS の値として渡さない。
- 境界を越える値の大きさと深さに上限を持つ（1 回 16 MiB、深さ 64）。
- membrane のコードは 1 か所（`plugin-host/membrane`）に置き、小さく保つ（本家の約 500 行が目安）。変更には、コードオーナーのレビューと fuzzing を必須にする。

### 4.3 上限

| 項目 | 値 | 超えたら |
| --- | --- | --- |
| QuickJS のヒープ | 512 MiB | メモリ不足の例外。プラグインを止める |
| スタック | 1 MiB | 例外 |
| 1 回の同期の実行（メインスレッドを持つ時間） | 3 秒で警告の表示を予約し、10 秒で打ち切る | 割り込みの関数が打ち切る。「プラグインが応答しません」を出し、変更を 5.3 節の規則で扱う |
| main のコード | 5 MiB | 読み込みを拒否 |
| UI の HTML | 5 MiB | 同上 |
| 同時に動くプラグイン | 1 タブに 1 つ（UI を持つもの）＋ 閉じ待ちのもの | 前のプラグインを閉じるか確かめる |

- 同期の実行の間、画面は止まる（本家と同じ。メインスレッドで動くため）。長い処理は、`await` で区切るよう文書で案内する。区切ると、ホストは描画のフレームを挟む。
- 値はこの設計の決定。本家の上限は公開の資料にない（**未検証**。設計の判断には影響しない）。

### 4.4 ES の版

- quickjs-ng は、仕様に入った新しい ES の機能を追う方針で、test262 の結果を公開している。ただし `Intl` は大きさの理由で持たない見込みと書く（[quickjs-ng の ECMAScript Features](https://quickjs-ng.github.io/quickjs/es_features)、2026-09-27 に確認）。本家は「ES2020 以降」と説明し、組み込みの一覧に `Intl` を挙げていない（[How Plugins Run](https://developers.figma.com/docs/plugins/how-plugins-run/)、2026-09-27 に確認）。対応する版の範囲（ES2023 の大半を見込む）は **未検証**（E14 の `quickjs-sandbox-poc` で test262 の結果を確かめる）。
- `Intl`・`toLocaleString` の地域の書式は持たない。プラグインに要る場合は、ホストの `Intl` の結果を membrane の関数として渡すかを `quickjs-sandbox-poc` で決める。
- `eval`・`Function` は QuickJS の中では使える（外に出られないため）。

## 5. API

ADR-0038。

### 5.1 manifest

```
{
  "name": "…",                       // 最大 64 文字
  "id": "…",                          // 配布の時に振る。<brand> の中で一意
  "api": "1.0.0",                     // API の版（5.5 節）
  "main": "code.js",
  "ui": "ui.html",                    // 任意
  "editorType": ["design"],           // MVP の後のホワイトボードで "whiteboard" を足す
  "documentAccess": "dynamic-page",   // これだけを受ける（5.2 節）
  "networkAccess": {
    "allowedDomains": ["none"] | ["https://api.example.com", "*.example.com", "*"],
    "devAllowedDomains": ["http://localhost:3000"],
    "reasoning": "…"                  // "*" かローカルの宛先のとき必須
  },
  "permissions": ["currentuser", "activeusers"],
  "menu": [ … ], "parameters": [ … ], "relaunchButtons": [ … ]
}
```

- 形は本家に寄せる（2 節）。名前空間・グローバルの名前は `<brand>`（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家のプラグインがそのまま動くことは目標にしない。
- `networkAccess` は **必須**。無ければ公開できない。

### 5.2 文書の読み書き

| 面 | 内容 |
| --- | --- |
| 読み取り | `root`・`currentPage`・ノードの取得（ID・種類・名前での検索）、プロパティの読み取り。ページは開いたときにだけ読まれる（`loadPageAsync`）。まだ読んでいないページのノードに触ると例外（`dynamic-page`。ページ単位の読み込み、[document-model.md](document-model.md) の 8.2 節と合う） |
| 書き込み | ノードの作成・削除・移動、プロパティの設定、テキスト（フォントを読み込んでから）、画像（バイト列から。[export-and-assets.md](export-and-assets.md) の 6.2 節の正規化を通る） |
| 選択と表示 | 選択の読み書き、表示の範囲の移動、通知（toast） |
| 書き出し | `exportAsync`（クライアントの書き出し。[export-and-assets.md](export-and-assets.md) の 4.2 節） |
| 利用者 | `currentUser`（名前、アイコンの ID。メールアドレスは返さない。`currentuser` の権限）、`activeUsers`（`activeusers` の権限） |
| 保存 | `setPluginData`・`getPluginData`（5.4 節）、`clientStorage`（端末の保存。プラグインごと 5 MiB） |
| 実行の制御 | `showUI`・`ui.postMessage`・`closePlugin`・`on('selectionchange' など)` |

- API は、いま開いたファイルだけを扱う。他のファイル・チームのライブラリ（`teamlibrary`）・組織の一覧は、MVP の後の後に別の ADR で扱う。

### 5.3 書き込みと変更

- プラグインの書き込みは、エンジンの `doc-model` の変更（`ChangeSet`）になり、利用者の手の変更と同じ経路で Document Server へ送られる（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md)）。**同じ `validate` を通る**（[document-model.md](document-model.md) の 4.4 節）。閲覧だけの人がプラグインを動かすと、書き込みは例外になる（役割の検証）。
- 1 回の同期の実行の中の書き込みは、1 つの Undo の単位にまとめる。`await` で区切られたら、そこで `ChangeSet` を閉じる。
- 1 つの `ChangeSet` は 4 MiB 以下（[document-model.md](document-model.md) の 11 節）。超えたらホストが分ける。確定を待つ変更が 32 MiB を超えたら、ホストは次の `await` で確定を待ち、送る速さを抑える。
- 打ち切り（4.3 節）のとき：その実行で作った変更は、打ち切りまでのものを 1 つの Undo の単位として残し、利用者に「取り消す」を出す。途中の状態は不変条件を破らない（変更は 1 つずつ検証済み）。
- 変更に、どのプラグインが作ったかの印（`origin = Plugin { plugin_id, version_id }`。[document-model.md](document-model.md) の 7 節）を付け、ジャーナルに残す。版の履歴で「〇〇（プラグイン）による変更」と出す。

### 5.4 plugin_data

- `plugin_data`（[document-model.md](document-model.md) の 4.2 節、プロパティ 90、`Map<(PluginId, Key), Bytes>`、要素ごとに LWW）に保存する。
- プラグインは、自分の `PluginId` の要素だけを読み書きできる。ホストが鍵を付けるので、プラグインは他の `PluginId` を指定できない。
- 上限：鍵 100 バイト、値 100 KiB、1 ノード 1 プラグインで 1 MiB（この設計の値）。本家は 1 項目（プラグインの ID・鍵・値の合計）を 100 kB までにする（[setPluginData](https://developers.figma.com/docs/plugins/api/properties/nodes-setplugindata/)、2026-09-27 に確認）。1 ノードの合計の上限は本家の資料にない。
- 全プラグインが読める共有の名前空間（本家の `sharedPluginData` に相当）は、後で別の ADR で決める。

### 5.5 API の版

- `api` は semver。1.x の中は追加だけ。ホストは 1 つの実装で、古い 1.x のプラグインも動かす。
- API の型定義（TypeScript の `.d.ts`）は、プロパティの表（ADR-0006）から生成する部分と、手で書く部分に分ける。表の `public_plugin` の列が真のプロパティだけを API に出す（内部のプロパティ、`derived_layout` の書き込みを出さない）。

## 6. UI と通信

ADR-0037・0038。

### 6.1 UI の iframe

- `showUI(html, options)` で、ホストは `https://plugin-ui.<brand>usercontent.<domain>/frame` を `sandbox="allow-scripts allow-forms allow-popups"`（`allow-same-origin` を付けない）で開く。iframe は null origin になり、アプリのオリジンの Cookie・Storage に届かない。
- `/frame` は、固定の起動用のページを返す。応答のヘッダーの CSP は、ホストがプラグインの `allowedDomains` から作る（下の表）。起動用のページは、ホストから `postMessage` で受けた HTML を `document.open`・`write` で書く。応答のヘッダーの CSP は、書いた後の文書にも効く。
- `/frame` の CSP（例：`allowedDomains = ["https://api.example.com"]`）：

| 指令 | 値 |
| --- | --- |
| `default-src` | `'none'` |
| `script-src` | `'unsafe-inline' 'unsafe-eval' https://api.example.com` |
| `style-src` | `'unsafe-inline' https://api.example.com` |
| `img-src`・`font-src`・`media-src` | `data: blob: https://api.example.com` |
| `connect-src`・`frame-src` | `https://api.example.com` |
| `form-action` | `https://api.example.com` |
| `frame-ancestors` | `https://app.<domain>` |

- `["none"]` のときは、外部の宛先をすべて外す。`"*"` のときは `https:` にする（`http:` は開発中だけ）。
- 本家と同じく、iframe の中に開いた外部のサイトが読む資源は、この CSP では縛れない（2 節）。`frame-src` の宛先が、その先で何を読むかは、`reasoning` と審査で扱う。
- iframe の大きさ・位置はホストが決める。iframe の枠にプラグインの名前と作者を出す（3 節の偽の UI への守り）。

### 6.2 サンドボックスからの通信

- サンドボックスの `fetch` は、ホストの関数が、UI の iframe（UI が無ければ見えない iframe を開く）へ要求を渡し、iframe の `fetch` で送る。**アプリのオリジンからは送らない。** アプリのオリジンの CSP の `connect-src` を広げないため、また Cookie を付けないため。
- 送る前に、ホストでも宛先を `allowedDomains` と照らす（CSP との二重）。
- WebSocket は iframe の中からだけ（`connect-src` で縛る）。
- 開発中のプラグイン（10 節）は、`devAllowedDomains`（`localhost` を含む）を使える。公開したプラグインでは無視する。

## 7. 端末の保存

- `clientStorage` は、アプリのオリジンの IndexedDB に、`(user_id, plugin_id)` の名前空間で置く。ホストだけが読み書きし、プラグインには API として出す。上限 5 MiB。
- UI の iframe の `localStorage` は、null origin のため使えない（ブラウザの振る舞い）。文書で `clientStorage` を案内する。

## 8. 組織の管理者の統制

| 設定 | 既定 | 内容 |
| --- | --- | --- |
| プラグインを使える | 有効 | 無効にすると、組織のファイルでプラグインを動かせない |
| 公開のプラグイン | すべて許可 | 「許可したものだけ」にすると、管理者が一覧から選んだものだけ |
| 通信先の方針 | 制限しない | `"*"` のプラグインを禁止する、など |
| 組織の中のプラグイン | 管理者が公開 | 組織の中の配布（ADR-0039） |

- 判定は、プラグインを動かすときに API が返す「このファイルで動かせるプラグインの一覧」で行う。ホストはその一覧に無いプラグインを読み込まない。組織の方針はファイルを持つ組織のものを使う（ゲストが持ち込んだプラグインも、ファイルを持つ組織の方針に従う）。
- プラグインの実行を、監査ログに残す（プラグインの ID・版・ファイルの ID・利用者。中身は残さない）。

## 9. データの形

`plugins`・`plugin_versions` はテナントの外（`global`）に置く。組織の中のプラグインは、組織の `org_id` を持つ。

| 表 | 主な列 |
| --- | --- |
| `plugins` | `id`、`owner_kind`（`user`・`org`）、`owner_id`、`org_id`（組織の中のもの）、`visibility`（`private_dev`・`org`・`public`）、`name`、`status`（`active`・`suspended`・`removed`）、`created_at` |
| `plugin_versions` | `id`、`plugin_id`、`api_version`、`manifest`（JSON）、`bundle_sha256`、`ui_sha256`、`network_access`、`permissions`、`review_status`（`not_required`・`pending`・`approved`・`rejected`）、`published_at` |
| `plugin_reviews` | `id`、`plugin_version_id`、`kind`（`automated`・`manual`）、`result`、`findings`、`reviewer_id`、`created_at` |
| `org_plugin_policies`（テナントの中。RLS） | `org_id`、`plugins_enabled`、`public_mode`（`all`・`allowlist`）、`allow_wildcard_network`、`updated_by`、`updated_at` |
| `org_plugin_allowlist`（同上） | `org_id`、`plugin_id`、`pinned_version_id`（任意）、`approved_by`、`approved_at` |
| `plugin_blocklist` | `plugin_id`、`version_id`（任意）、`reason`、`created_by`、`created_at` |

- コードは S3 の `plugins/{plugin_id}/{version_id}/{sha256}` に不変で置き、`plugin-ui.<brand>usercontent.<domain>` と別のパス（`plugin-code`）から配る。ホストは読み込んだバイト列のハッシュを `plugin_versions` と照らす。

## 10. 開発・配布・審査

ADR-0039。

| 段階 | 誰が使えるか | 審査 |
| --- | --- | --- |
| 開発中（`private_dev`） | 作った本人だけ | なし。manifest と ZIP を上げると、本人の開発用の版になる。デスクトップアプリがないので、ローカルのディレクトリを直接読む形は MVP の後の後 |
| 組織の中（`org`） | 組織のメンバー | 本家の OAuth の private のアプリと同じく、審査なし（[api-and-webhooks.md](api-and-webhooks.md) の 3 節）。組織の管理者が公開を承認する |
| 公開（`public`） | 全員（組織の方針の許す範囲） | 初回は自動の検査＋人の審査。更新は自動の検査。権限・通信先が広がる更新は人の審査 |

- 自動の検査：manifest の検証、`networkAccess` の必須と `reasoning`、コードの大きさ、難読化の度合いの目安（ミニファイは許す）、既知の悪意のあるコードの署名、禁止の API の使い方（例：UI の iframe でのログイン画面に似た入力欄とパスワードの型）。
- 人の審査の目標：5 営業日（本家は 5〜10 営業日）。担当は Ops の配下の「プラットフォームの審査」（Slack の [ADR-0033](../../../slack/docs/decisions/0033-slack-aligned-platform-and-plan-decisions.md) と同じ置き方）。
- **停止のスイッチ**：`plugin_blocklist` に入れると、Realtime で全クライアントに配られ、動いているプラグインはホストが閉じ、以後読み込まない。目標は入れてから 5 分以内に全クライアントで止まる。
- 版は不変。利用者はいつも最新の承認済みの版を使う。組織の管理者は、許可リストで版を固定できる。

## 11. 障害のときの振る舞い

| 障害 | 起きること | 対応 |
| --- | --- | --- |
| プラグインの無限ループ | 画面が止まる | 10 秒で打ち切る（4.3 節） |
| メモリの使い切り | QuickJS の例外 | プラグインを止める。エンジンのメモリには影響しない（別のメモリ） |
| 大量の書き込み | Document Server への送信が詰まる | ホストが確定を待って送る速さを抑える（5.3 節）。1 つの `ChangeSet` は 4 MiB 以下 |
| 途中の打ち切り | 一部だけ変わる | 1 つの Undo の単位として残し、「取り消す」を出す |
| プラグインのコードの配信の障害 | 読み込めない | 端末のキャッシュ（ハッシュの一致を確かめたもの）で動かす |
| 停止のスイッチの配信の遅れ | 悪いプラグインが動き続ける | 起動時にも一覧を API で確かめる。Realtime が切れていても、5 分ごとに取り直す |
| QuickJS・membrane の脆弱性 | サンドボックスからの脱出 | 公開の審査を止め、停止のスイッチで全プラグインを止める ops フラグを持つ（本家の 2019 年の対応と同じ形。runbook） |

## 12. テスト

- 脱出のテストの集まり（CI）：QuickJS の中から、`window`・`document`・`fetch`・`XMLHttpRequest`・`WebAssembly`・Cookie・`localStorage`・エンジンのメモリに届かない。ホストの関数・オブジェクトの参照を得られない（`constructor` をたどる、`Proxy`、`Symbol`、エラーのスタックからの取り出しを含む）。
- membrane の fuzzing：任意の値（循環、巨大な配列、getter、`Proxy`）を境界に渡しても、ホストが落ちず、上限を超えない。
- UI の iframe：アプリのオリジンの Cookie・Storage に届かない。`allowedDomains` の外への `fetch`・`img`・`iframe` が CSP で止まる。`["none"]` で外部に何も送れない。
- 性質ベーステスト：
  - **PROP-PL-001**：任意の API の呼び出しの列で、プラグインの書き込みの結果は、同じ変更を利用者の手で行ったときと同じ `ChangeSet` になり、`validate` を通る。
  - **PROP-PL-002**：任意の `PluginId` の組で、あるプラグインは他のプラグインの `plugin_data` を読めない。
  - **PROP-PL-003**：閲覧だけの役割で、任意の書き込みの API が例外になり、文書が変わらない。
- 上限の表駆動のテスト：4.3 節の各上限の境界。
- 停止のスイッチの結合テスト：一覧に入れて 5 分以内に、動いているプラグインが閉じる。
- 性能：参照のプラグイン（1 万ノードを読み、1,000 ノードを書く）の所要時間を計測し、回帰を検知する。

## 13. ウィジェット（後）

ウィジェット（ファイルの中に置かれ、全員の画面に出る、コードで描く部品）は、プラグインの後に別の ADR で決める。方向だけを書く。

- 同じサンドボックス（ADR-0037）で動かす。
- ファイルを開いた全員の端末でコードが動く。プラグインと違い、利用者が選んで動かすのではない。そのため、描画のコードは通信を持たせず、通信は利用者が操作したとき（クリック）だけに限る。
- ウィジェットの状態は、ファイルのノードのプロパティとして持ち、マルチプレイヤーの経路で同期する。

## 14. Story の候補

プラグインは MVP の後の E14（[roadmap.md](../roadmap.md)）。MVP の中で準備しておくものを E1〜E12 の番号で書く。

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `plugin-data-property-reserve` | プロパティ 90 の予約と、表の `public_plugin` の列（document-model と合わせる） |
| E3 | `change-origin-tag` | `ChangeSet` の `origin` の印（document-model.md の 7 節に取り込んだ。multiplayer の同じ名前の Story と 1 つ） |
| E14 | `quickjs-sandbox-poc` | QuickJS の WASM のインスタンス、上限、割り込み、ES の版の確認、性能の計測 |
| E14 | `plugin-membrane` | ハンドルの表、値の写し、コールバック、fuzzing、脱出のテスト |
| E14 | `plugin-api-read` | 読み取りの API、`dynamic-page` |
| E14 | `plugin-api-write` | 書き込み、Undo の単位、送る速さの制御 |
| E14 | `plugin-ui-iframe` | `plugin-ui` のドメイン、起動用のページ、CSP の生成、メッセージ |
| E14 | `plugin-network-proxy` | サンドボックスの `fetch` の中継、宛先の照合 |
| E14 | `plugin-storage` | `plugin_data`、`clientStorage` |
| E14 | `plugin-dev-mode` | 開発中の版の読み込み、`devAllowedDomains`、コンソール |
| E14 | `plugin-org-distribution` | 組織の中の配布、管理者の統制（8 節） |
| E14 | `plugin-public-review` | 公開、自動の検査、人の審査の道具 |
| E14 | `plugin-kill-switch` | `plugin_blocklist` と Realtime での配信 |
| E14 | `plugin-types-codegen` | `.d.ts` の生成と API の版 |

## 15. 未解決の問い

### 決定（2026-09-27、既定案）

- **サンドボックスはメインスレッドの QuickJS の WASM**（ADR-0037）。Web Worker に置く案は、文書の読み取りが非同期か、`SharedArrayBuffer` と `Atomics.wait` による同期の呼び出し（cross-origin isolation が要る）になり、プロパティの読み取りごとの往復が重い。本家が iframe で失敗した点と同じ。
- **同期の実行の上限は 10 秒**（4.3 節）。本家の値は公開の資料にない（**未検証**。設計の判断には影響しない）。
- **サンドボックスの `fetch` は UI の iframe から送る**（6.2 節）。アプリのオリジンの CSP を広げない。
- **組織の中のプラグインは審査なし、公開は初回と権限の拡大で人の審査**（ADR-0039）。本家は承認後の更新を審査しないが、権限・通信先の拡大は審査する。乗っ取りの被害を抑えるため。
- **API はいま開いたファイルだけ**（5.2 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| quickjs-ng の ES の版、性能（本家は Realms より遅くなったと書く） | `quickjs-sandbox-poc` |
| 画面を止めずに長い処理を動かす方法（Worker と `Atomics` の案） | PoC の性能を見て、別の ADR |
| `sharedPluginData`、チームのライブラリの API | 利用者の声で、別の ADR |
| ウィジェット | 13 節の方向で、別の ADR |
| 有料のプラグイン | 範囲の外（決済の仕組みが要る）。PM |
| ShadowRealm が標準になったら、QuickJS より速い選択肢になるか | ShadowRealm は TC39 の Stage 2.7（[tc39/proposals](https://github.com/tc39/proposals)、2026-09-27 に確認）で、ブラウザの実装は MDN の browser-compat-data にない。Stage 4 になり主要なブラウザが出したら見直す |

## 16. quality.md・runbooks・data-model への項目

### quality.md

- 脱出のテストの集まり（12 節）を、プラグインのリリースの基準にする。失敗は 0。
- membrane の fuzzing の実行時間（PR ごとに 5 分、夜間に 1 時間）。
- 参照のプラグインの性能の回帰（12 節）。
- 停止のスイッチの到達の時間（5 分以内）。
- プラグインの公開の前に、外部の侵入試験を 1 回行う。

### runbooks

- `plugin-kill-switch.md`：悪意のあるプラグイン（または版）を `plugin_blocklist` に入れ、到達を確かめ、利用者と組織の管理者に知らせる手順。
- `plugin-sandbox-vulnerability.md`：QuickJS・membrane の脆弱性の報告を受けたとき、公開の審査を止め、全プラグインを止める ops フラグを入れ、修正の版を出し、再開する手順（本家の 2019 年の 11 日の対応を目安にする）。
- `plugin-review-queue.md`：審査の滞留のときの扱い。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `global.plugins`・`global.plugin_versions`・`global.plugin_reviews`・`global.plugin_blocklist` | 9 節 |
| Aurora `org_plugin_policies`・`org_plugin_allowlist` | 9 節（RLS） |
| S3 `plugins/{plugin_id}/{version_id}/{sha256}` | プラグインのコード（不変） |
| ドキュメントのプロパティ 90 `plugin_data` | [document-model.md](document-model.md) の 4.2 節（予約）。5.4 節の上限 |
| ジャーナル | `ChangeSet` の `origin`（document-model.md の 7 節、file-storage-and-history.md の 4.1 節に取り込んだ） |
| ブラウザの IndexedDB `plugin_client_storage` | `(user_id, plugin_id)` ごと 5 MiB |

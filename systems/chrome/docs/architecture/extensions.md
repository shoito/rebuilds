# Extensions: Chrome

拡張機能の基盤（Manifest V3 の互換、プロセスと隔離、権限、declarativeNetRequest、コンテンツスクリプト）と、拡張機能のストアのサービス（提出、審査、配布、停止）の設計。基盤の範囲は [ADR-0025](../decisions/0025-extension-platform-mv3.md)、ストアの審査は [ADR-0026](../decisions/0026-extension-store-review.md) に従う。

この文書の値（件数、時間）は初期値である。E7 の各変更の `spec.md` で要件にするときに確定する。

## 1. 対応の範囲

本家 Chrome の Manifest V3（以下 MV3）に互換の拡張機能を、手を加えずに動かすことを目標にする。互換の基準は、本家の拡張機能の文書（[developer.chrome.com/docs/extensions](https://developer.chrome.com/docs/extensions)）と、W3C の WebExtensions の Community Group・Working Group が進める共通の仕様（[w3c/webextensions](https://github.com/w3c/webextensions)）である。

| 区分 | 範囲 |
| --- | --- |
| マニフェスト | MV3 だけ。MV2 は読み込まない |
| 名前空間 | `browser.*`（WebExtensions の共通の名前）を正本にし、`chrome.*` を互換の別名として同じオブジェクトを指す（ADR-0025。リポジトリ共通の ADR-0006 の、この名前空間に限った例外） |
| MVP の API | `runtime`、`storage`（`local`・`sync`・`session`・`managed`）、`tabs`、`windows`、`scripting`、`declarativeNetRequest`、`webNavigation`、`webRequest`（観察だけ）、`alarms`、`action`、`contextMenus`、`commands`、`notifications`、`permissions`、`i18n`、`cookies`、`bookmarks`、`history`、`downloads`、`omnibox`、`offscreen`、`sidePanel`、`identity`（`launchWebAuthFlow` だけ）、`management`（自分の情報） |
| MVP の後 | `debugger`、`nativeMessaging`、`tabGroups`、`userScripts`、`declarativeContent`、`proxy`、`privacy`、`topSites`、`search` など |
| 提供しない | Google のサービスに結びつく API（`gcm`、`identity.getAuthToken` など）、`enterprise.*` のうち本家の管理基盤に依存するもの |

- API の実装の優先度は、ストアの拡張機能が使う API の頻度で決める。本家の Web Store の上位の拡張機能 500 件のマニフェストを集計し、E7 の最初の計画に使う（未検証：集計はまだ行っていない）。
- 本家の既知の仕様との違い（未対応の API、引数の差）は、`<brand>://extensions` と開発者向けの文書に一覧で公開する。

## 2. プロセスの構成と隔離

```
Browser プロセス
 ├─ 拡張機能の管理（インストール、権限、有効・無効、更新、停止の一覧）
 ├─ API の実装（tabs, storage, …）。呼び出し元の拡張機能 ID と権限をここで検査する
 │
 ├─ 拡張機能の Renderer（拡張機能ごと。オリジン <brand>-extension://<id>）
 │    service worker（背景の処理）、ポップアップ、オプション、サイドパネル、offscreen
 │
 └─ Web の Renderer（サイトごと）
      コンテンツスクリプト（拡張機能ごとの isolated world）
```

- **拡張機能ごとに 1 つのサイトとして扱う。** 拡張機能のオリジンは、サイトの隔離（[ADR-0003](../decisions/0003-multi-process-site-isolation.md)）で他のサイト・他の拡張機能と別の Renderer に置く。
- **背景の処理は service worker にする。** 本家と同じく、30 秒の無操作、1 つのイベントの処理が 5 分を超えたとき、`fetch()` の応答が 30 秒来ないときに止める（[The extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)）。イベントの受信と API の呼び出しで無操作の時間を延ばす。
- **Browser は、拡張機能の Renderer からの要求を、その Renderer に割り当てた拡張機能 ID と、その拡張機能の権限で検査する。** 要求に書かれた ID を信用しない（[process-model.md](process-model.md) と同じ規則）。
- **コンテンツスクリプトからの要求は、拡張機能のページより弱く扱う。** コンテンツスクリプトは Web の Renderer の中で動くため、その Renderer が侵害されると偽装できる。コンテンツスクリプトに直接許す API は、本家と同じく `runtime` のメッセージ・`storage`・`i18n` などに限り、他の API は拡張機能の service worker への送信を経由させる。
- 拡張機能のページの CSP は、本家の MV3 と同じく `script-src`・`object-src`・`worker-src` に `self`・`none`・`wasm-unsafe-eval` だけを許し、外部のコードの読み込みと `eval` を禁じる（[Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)）。

## 3. コンテンツスクリプトと isolated world

- コンテンツスクリプトは、ページの DOM を共有し、JavaScript の実行環境（グローバル、プロトタイプ）を分ける isolated world で動く。本家の定義では、isolated world は「ページからも他の拡張機能からも触れられない、専用の実行環境」である（[Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)）。
- 実装：V8 の同じ Isolate の中で、拡張機能ごとに別の Context を作り、DOM のラッパーのオブジェクトを Context ごとに持つ（[javascript-and-web-apis.md](javascript-and-web-apis.md) のバインディングで、world ごとのラッパーの表を持つ）。
- `world: "MAIN"` を指定したスクリプトは、ページの実行環境で動き、ページの CSP に従う。権限の検査は isolated world と同じ。
- 注入の時点（`document_start`・`document_end`・`document_idle`）と、`all_frames`・`match_origin_as_fallback` は本家に合わせる。
- コンテンツスクリプトの一致の判定は、Browser プロセスで、フレームのオリジンとホストの権限で行い、許可されたスクリプトだけを Renderer に渡す。

## 4. 権限の模型

### 4.1 権限の種類

| 種類 | 例 | インストール時の警告 | 実行時の許可 |
| --- | --- | --- | --- |
| API の権限 | `tabs`、`history`、`bookmarks`、`downloads` | 本家の警告の文言の表に合わせる | `optional_permissions` は `permissions.request()` で求める |
| ホストの権限 | `https://*.example.com/*`、`<all_urls>` | 「〜のサイトのデータの読み取りと変更」 | 利用者がサイトごとに制限できる（4.2） |
| `activeTab` | | 出さない | 利用者の操作（アクションのクリック、ショートカット）で、そのタブに一時的にホストの権限を与える |
| `declarativeNetRequest` 系 | 5 節 | `declarativeNetRequest` は出す。`declarativeNetRequestWithHostAccess` は出さない（ホストの権限が別に要る） | |

### 4.2 利用者によるサイトへのアクセスの制御

- 本家と同じく、ホストの権限を持つ拡張機能について、利用者が「クリックしたときだけ」「特定のサイトだけ」「すべてのサイト」を選べる。拡張機能の更新で新しい権限が増えたら、拡張機能を無効にし、利用者の承認を待つ。
- 企業のポリシーで、拡張機能が触れられないサイト（`runtime_blocked_hosts`）を決められる（8 節）。
- 内部ページ（`<brand>://`）、ストアのサイト、他の拡張機能のページには、ホストの権限があってもコンテンツスクリプトを注入させない。

### 4.3 シークレットモードと複数のプロファイル

- シークレットモードでは既定で無効。利用者が拡張機能ごとに許可する（[browser-ui.md](browser-ui.md) の 6.2 節）。
- `incognito` のマニフェストの値（`spanning`・`split`・`not_allowed`）に従う。

## 5. declarativeNetRequest（DNR）

MV3 で、拡張機能がネットワークの要求を遮断・書き換える唯一の手段。規則は宣言で、拡張機能は要求の中身を受け取らない。

### 5.1 上限

本家の上限に合わせる（[chrome.declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)、2026-09-26 に確認）。上限を本家より下げると、広告の遮断などの拡張機能がそのまま動かないため。

| 項目 | 値 |
| --- | --- |
| 静的な規則の保証（拡張機能ごと） | 30,000 |
| 静的な規則の全体の枠 | 保証を超える分は、全拡張機能で共有の枠から割り当てる（本家の API の文書には全体の枠の数値がない。以前の文書の値 300,000 を初期値にし、本家の実装の値を E7 で確かめる：**未検証**） |
| 静的な規則セットの数 / 同時に有効な数 | 100 / 50 |
| 動的な規則 / うち安全でない規則（遮断・転送・スキームの変更） | 30,000 / 5,000 |
| セッションの規則 / うち安全でない規則 | 5,000 / 5,000 |
| 正規表現の規則（種類ごと） | 1,000 |

### 5.2 評価の場所と方式

- 規則は、インストール時・更新時に Browser プロセスで検証し、索引の形式（URL の部分文字列の索引と、条件の表）に変換して、プロファイルのディレクトリに保存する。
- 照合は Network サービスで、要求ごとに行う（[networking.md](networking.md)）。Renderer では行わない。
- 評価の順序と優先度（`allow` > `allowAllRequests` > `block` > `upgradeScheme` > `redirect` > `modifyHeaders` の関係、拡張機能の間の順序）は本家の文書の定義に合わせる。
- 予算：要求 1 件あたりの照合は、有効な規則 10 万件で p99 0.1 ms 以内（基準の端末で。[observability.md](observability.md)）。
- 正規表現は、線形時間の実装（Rust の `regex`）を使い、規則の検証の時点で状態の数の上限を超えるものを拒む。

### 5.3 webRequest

- `webRequest` は観察だけを許し、要求を止めて書き換える `webRequestBlocking` は提供しない。
- 例外：本家と同じく、企業のポリシーで強制インストールした拡張機能には `webRequestBlocking` を許す（[Replace blocking web request listeners](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)）。この場合も、要求の処理の待ちの上限（初期値 1 秒）を超えたら、その拡張機能の判定を飛ばして進める。

## 6. パッケージ、署名、ID

- 形式：本家の CRX3 と同じ構造（ZIP に、開発者の署名とストアの署名を付けた入れ物）。拡張子とマジックの値は独自のものにする（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の CRX ファイルはそのまま読み込まない（ストアが再パッケージする。7.1）。
- 拡張機能 ID：開発者の公開鍵の SHA-256 の先頭 128 bit を `a`〜`p` の 32 文字で表す（本家と同じ形式。同じ鍵なら本家と同じ ID になり、`externally_connectable` などの設定を移しやすい）。
- 利用者の端末は、ストアの署名が正しいパッケージだけをインストールする。例外は、開発者モードでの展開した拡張機能の読み込みと、企業のポリシーで指定した更新の URL からのもの。

## 7. 拡張機能のストアのサービス

```
開発者 ─▶ 開発者のダッシュボード（アカウント・2 段階認証必須）
            │ 提出（パッケージ、掲載情報、権限の説明）
            ▼
        受付 ─▶ 自動の審査（静的解析・マルウェアの検査・動的解析・リスクの点数）
                    │
                    ├─ 低リスク ─────────────▶ 公開の判定
                    └─ 高リスク・要確認 ──▶ 人の審査 ─▶ 公開の判定
                                                     │
        ストアの Web ◀─ 掲載の DB ◀──────────────────┘
        更新の配信 ◀─ 署名済みのパッケージ（S3 + CDN）
        停止の一覧 ─▶ Safe Browsing のリストと同じ配信の経路（9 節）
```

- サービスは TypeScript（Hono）と AWS（[ADR-0001](../decisions/0001-languages-and-platform.md)）。構成は [infrastructure.md](infrastructure.md)。
- 開発者のアカウントは、同期と同じアカウントのサービス（[sync-and-accounts.md](sync-and-accounts.md)、[ADR-0028](../decisions/0028-account-service.md)）で認証し、公開にはパスキーか TOTP の 2 段階認証を必須にする（本家のストアも、公開と更新の前に 2 段階認証を求める。[2-Step Verification](https://developer.chrome.com/docs/webstore/program-policies/two-step-verification)）。

### 7.1 提出と自動の審査

本家は、自動と人の審査を組み合わせ、開発者の実績や利用者の数にかかわらず、すべての提出を同じ審査にかける。大半は数日で終わるが、数週間かかることもある。広いホストの権限や大量のコードは審査を長くし、難読化は禁止される（[Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process)）。本システムも同じ方針にする。

| 段 | 内容 |
| --- | --- |
| 形式の検査 | マニフェストの検証、MV3 であること、宣言していない権限の使用、DNR の規則の検証 |
| 遠隔のコードの検査 | 外部のスクリプトの読み込み、`eval`・`new Function`、文字列からのコードの生成、外部から取った設定でコードの経路を切り替える形。MV3 の「すべての処理をパッケージに含める」規則の違反 |
| 難読化の検査 | 難読化の検出（縮小化は許す）。ソースマップか元のソースの提出を求められるようにする |
| マルウェアの検査 | 既知のマルウェアの署名・ハッシュ、同梱のバイナリ（WASM を含む）の検査、既知の悪い拡張機能との類似度 |
| 動的解析 | 隔離した環境のブラウザで、拡張機能を入れて代表的なサイトを巡回し、ネットワークの宛先・Cookie とフォームへの接触・検索の設定の変更を記録する |
| 差分の検査（更新のとき） | 前の版との差分。権限の増加、コードの大きな変化、所有者の変更（開発者のアカウントの移転）の直後の更新 |

- 自動の審査の結果から、リスクの点数を付ける。要素：ホストの権限の広さ、機微な API（`cookies`・`webRequest`・`scripting`・`history`）、所有者の変更、新しい開発者、利用者の数、過去の違反。

### 7.2 人の審査

- 点数が閾値を超えたもの、自動の審査で疑いがあったもの、利用者の多い拡張機能（初期値 1 万人以上）の権限の増加は、人が審査する。
- 審査の担当者は、専用の端末と環境で動的解析の記録とコードを見る。判定（承認・却下・保留）と理由を記録し、却下は方針の条項を示して開発者に知らせる。
- 審査の目標時間（初期値）：自動だけ 1 時間以内、人の審査を含めて 3 営業日以内（p90）。

### 7.3 方針と措置

- ストアの方針（掲載の方針、プライバシーの方針、単一の目的、最小の権限、利用者のデータの扱い）は、本家の Program Policies の構造に倣って独自に書く（本文を写さない）。
- 措置は本家と同じ段階にする：却下（提出の時点）、警告（公開中の軽微な違反。対応の期限を 7〜30 日で付ける）、取り下げ（ストアからの削除）、重大な違反（マルウェア、審査の回避）は通知なしで取り下げ・停止の一覧に載せ、開発者のアカウントを停止する（[review process](https://developer.chrome.com/docs/webstore/review-process)）。
- 開発者は、ダッシュボードから異議を申し立てられる。異議は元の審査の担当者と別の担当者が見る。

### 7.4 更新の配信

- 端末は、インストール済みの拡張機能の更新を、ブラウザの更新と同じ配信のサービス（[update-and-release.md](update-and-release.md)）に、数時間ごと（初期値 5 時間）にまとめて問い合わせる。応答は署名付きの版の一覧で、パッケージは CDN から取る。
- 利用者の多い拡張機能（初期値 10 万人以上）の更新は、段階的に配る（1% → 10% → 100%）。その間にクラッシュ・通報・停止の判定があれば止める。
- 問い合わせに含めるのは、拡張機能 ID と版と、ブラウザの版・OS だけにする（[ADR-0005](../decisions/0005-privacy-first-services.md)）。利用者の数は、問い合わせの数から推定する（利用者を識別する値を送らない）。

## 8. 企業のポリシー

本家の `ExtensionSettings` と同じ意味のポリシーを持つ（[Chrome Enterprise のヘルプ](https://support.google.com/chrome/a/answer/9867568)）。

| `installation_mode` | 振る舞い |
| --- | --- |
| `force_installed` | 利用者の操作なしにインストールし、利用者は削除・無効化できない。`update_url` が必須 |
| `normal_installed` | 自動でインストールするが、利用者は無効にできる |
| `allowed` / `blocked` | 利用者によるインストールの許可・禁止。`*` で既定を決める |
| `removed` | インストール済みでも削除する |

- ほかに、`runtime_blocked_hosts`・`runtime_allowed_hosts`（拡張機能が触れられないサイト）、`install_sources`（ストア以外のインストール元）、`blocked_permissions` を持つ。
- 強制インストールの拡張機能は、自社の更新の URL から配れる（ストアを経由しない）。その場合、ストアの審査を受けないことを管理者の文書に明記する。
- 停止の一覧（9 節）の「マルウェア」は、ポリシーの強制インストールより優先する。「方針の違反」は、ポリシーで許可されていれば動かし続けられる。

## 9. 悪用への対応（停止の一覧）

- **停止の一覧**：拡張機能 ID（と版の範囲）と理由（`malware`・`policy_violation`・`potentially_unwanted`・`unpublished`）の一覧。Safe Browsing のリストと同じ配信の経路・同じ署名で届け、端末は同じ間隔で取る（NFR-009 の 30 分と同じ目標）。
- 本家も、マルウェアと判定した拡張機能を自動で無効にし、ストアから消えた拡張機能を安全確認（Safety Check）で知らせる。本システムも同じ振る舞いにする。

| 理由 | 端末での措置 | 利用者の再有効化 |
| --- | --- | --- |
| `malware` | 無効にする。拡張機能とそのデータは消さずに残す | できない。企業のポリシーでも上書きできない |
| `policy_violation` | 無効にし、理由を示す | できる（警告を出す） |
| `potentially_unwanted` | 無効にし、理由を示す | できる |
| `unpublished` | 動かし続け、安全確認で知らせる | ― |

- 一覧への追加は、ストアの審査の担当者（人）が、根拠（検査の結果、通報、外部の報告）を付けて行う。緊急時の手順は runbook（悪意のある拡張機能の取り下げ）に書く。
- 誤って停止したときは、一覧から消せば、端末は次の取得で再び有効にする（`malware` で無効にしたものも、データを残しているので戻せる）。
- 利用者の通報：`<brand>://extensions` とストアのページから通報でき、通報の数を人の審査の優先度に使う。

## 10. データの置き場所

| データ | 置き場所 |
| --- | --- |
| インストール済みの拡張機能、権限の承認、DNR の索引、`storage.local` | プロファイルのディレクトリ（端末） |
| `storage.sync` | 同期の拡張機能の設定の型（[sync-and-accounts.md](sync-and-accounts.md)。暗号化の対象） |
| 掲載の情報、版、審査の記録、開発者のアカウント | ストアのサービスの DB（[data-model.md](data-model.md)） |
| パッケージ | S3（版ごとに不変）、CDN |
| 停止の一覧 | Safe Browsing のリストの配信（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md)） |

## 11. リスクと未解決事項

- **互換の長い尾**：本家の API の細かな振る舞い（イベントの順序、エラーの文言）に依存する拡張機能がある。上位の拡張機能を自動で試験する（[build-and-test.md](build-and-test.md)）。
- **ストアの初期の品揃え**：本家のストアの拡張機能は、開発者が自分で提出しない限り使えない。開発者への働きかけと、提出の手間（本家の CRX・ZIP をそのまま受け付ける）で補う。
- **審査の人手**：人の審査の量が、提出の数に比例して増える。点数の閾値と、自動の審査の精度で調整する。
- **遠隔のコードの規則の回避**：本家でも、設定のデータでコードの経路を切り替える形で回避された例がある。動的解析と差分の検査で追う。

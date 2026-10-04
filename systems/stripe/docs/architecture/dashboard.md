# Dashboard: Stripe

加盟店の運用担当と開発者が使う Web 画面。決済・返金・Dispute・入金・残高の確認と操作、開発者向けの API キー・リクエストのログ・Event・Webhook の配信、チームの管理、レポートの書き出し。方針は [ADR-0028](../decisions/0028-dashboard-architecture.md) にある。

クライアントの作りは Slack の [client.md](../../../slack/docs/architecture/client.md) を引き継ぎ、決済に固有の事情だけを変える。本家の仕様は docs.stripe.com で 2026-09-26 に確認した。確認できなかったものは「未検証」と書く。

## 1. 原則

- **ダッシュボードは公開 API の利用者の 1 人。** 決済・返金・Dispute・Payout などの操作は、公開 API と同じハンドラー（検証・冪等・バージョン・監査）を通る。ダッシュボードだけの抜け道を作らない。本家も、ダッシュボードでの変更を API の要求としてログに残し、ログの「ソース」で区別できる（[API リクエストログ](https://docs.stripe.com/development/dashboard/request-logs)）。
- **権限の判定はサーバーで行う。** 画面は、ボタンを隠すために権限の一覧を使うだけ。ロールと権限の表の正本は [auth-and-keys.md](auth-and-keys.md) にある。
- **第三者のスクリプトを読み込まない。** 返金・入金先の変更・API キーの発行など、お金と秘密を動かす操作がある画面なので、XSS の攻撃面を増やさない。利用状況の計測は自前で行う（9 節、ADR-0028）。
- **お金の数字は台帳から出す。** 残高・入金額・手数料は [ledger.md](ledger.md) の API から取り、画面で足し算をしない。金額は `packages/money` の型で整形する（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **サンドボックスと本番を取り違えさせない。** 環境は URL に入れ、サンドボックスでは常に帯を出す（4 節）。サンドボックスの作りは [api.md](api.md) の 11 節と [ADR-0008](../decisions/0008-api-keys-and-dashboard-access.md) にある（test のクラスタの中の独立したアカウント）。

## 2. 画面の構成

本家のダッシュボードの主な区分に合わせる。

| 区分 | 画面 | 主な操作 |
| --- | --- | --- |
| ホーム | 今日と期間の売上（総額・純額）、成功率、次の入金、残高、要対応（期限の近い Dispute、失敗している Webhook） | — |
| 決済 | 決済の一覧・詳細、返金の一覧、Dispute の一覧・詳細 | キャプチャ、取り消し、返金（全額・一部）、Dispute の証拠の提出・受け入れ |
| 残高 | 残高（利用可能・保留中、通貨ごと）、残高の取引（balance transactions）、入金（Payout）の一覧・詳細 | 入金の予定の確認、手動の入金（ロールによる） |
| 顧客 | 顧客の一覧・詳細、保存した決済手段、銀行振込の顧客の残高 | 顧客の作成・編集 |
| レポート | 書き出し（決済、残高の取引、入金ごとの明細） | CSV の作成と取得 |
| 開発者 | API キー、リクエストのログ、Event、Webhook（エンドポイントと配信） | キーの作成・入れ替え・失効、エンドポイントの管理、Event の再送、テストイベント |
| 設定 | 事業者の情報、入金先の口座と入金の予定、決済手段、ブランド（[checkout.md](checkout.md) の 10 節）、メール（領収書、コンビニ払いの案内）、チーム、セキュリティ履歴、コンプライアンス | — |

### 2.1 ルート

- パスは本家に寄せ、アカウントの ID と環境を入れる（本家の `dashboard.stripe.com/acct_.../test/payments` の形）。ダッシュボードの API のパス（[auth-and-keys.md](auth-and-keys.md) の 1 節の `/api/accounts/{acct}/{live|test}/*`）と対応させる。

  | パス（`/{acct}` と `/{acct}/test` の下） | 画面 |
  | --- | --- |
  | `/` | ホーム |
  | `/payments`、`/payments/{pi_id}` | 決済の一覧・詳細 |
  | `/refunds`、`/disputes`、`/disputes/{du_id}` | 返金、Dispute |
  | `/balance`、`/balance/transactions`、`/payouts/{po_id}` | 残高、入金 |
  | `/customers`、`/customers/{cus_id}` | 顧客 |
  | `/reports` | レポート |
  | `/developers/apikeys`、`/developers/logs`、`/developers/events`、`/developers/webhooks/{we_id}` | 開発者 |
  | `/settings/...` | 設定 |

- `/{acct}/test/...` はサンドボックスを表す。サーバーは、live のクラスタで権限を決めてから、サンドボックスの `acct_` に切り替える（auth-and-keys.md の 8 節）。
- 1 人が複数のアカウント（加盟店）に属するときは、アカウントの切り替えを上部に置く。`/` は最後に開いたアカウントへ転送する。URL のアカウントのメンバーでなければ 404 にする（アカウントの存在を知らせない。auth-and-keys.md の 8 節）。

## 3. 主な画面の要点

### 3.1 決済の一覧と詳細

- 一覧はカーソルでページングする（公開 API の `starting_after` と同じ）。件数の総数は出さない（大きなアカウントで数えるコストが高いため）。
- 絞り込み：状態、決済手段（カード、コンビニ払い、銀行振込）、日付、金額の範囲、通貨、顧客、カードの下 4 桁、メールアドレス。ID（`pi_`、`ch_`、`cus_`）を貼ると、その詳細へ移る。
- 詳細には、状態の履歴（その決済の Event の時系列）、金額の内訳（手数料・純額は台帳から）、決済手段の表示用の情報、3D セキュアの結果、不正検知の判定（[fraud.md](fraud.md)）、関連する返金・Dispute、ログへのリンク（`request.id` から開発者のログへ）を出す。
- カード番号は表示しない。本体が持たないので、出しようがない（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。

### 3.2 返金

- 詳細から「返金」を押すと、金額（既定は残額）と理由（重複、不正、顧客の依頼）を選ぶダイアログを出す。確定の前に、金額・通貨・対象を太字で確かめさせる。
- ダイアログを開いた時点で冪等キーを作り、送信の再試行でも同じキーを使う。二重に押しても返金は 1 回（[ADR-0004](../decisions/0004-idempotency.md)）。
- コンビニ払いの返金は、顧客が口座情報を出すまで `requires_action` になる（[checkout.md](checkout.md) の 7.1 節）。画面では「顧客の口座情報の入力待ち（期限 45 日）」を出す。

### 3.3 Dispute

- 一覧は、証拠の提出期限（`evidence_details.due_by`）の近い順を既定にし、期限まで 3 日を切ったものを強調する。
- 詳細で、証拠（文書のファイル、配送の記録、顧客とのやりとり）を入力して提出する。下書きは保存でき、提出は 1 回だけ（提出後は変えられない。本家と同じ）。流れと規則は [disputes.md](disputes.md) にある。
- 「受け入れる」は、確認のダイアログを経て行う。

### 3.4 残高と入金

- 残高は、利用可能と保留中を通貨ごとに出す。入金の一覧は状態（予定、処理中、入金済み、失敗）で絞り込める。
- 入金の詳細には、その入金に含まれる残高の取引（決済・返金・手数料・Dispute）を出し、CSV で書き出せる（照合のため。[payouts-and-reconciliation.md](payouts-and-reconciliation.md)）。
- 入金先の口座の変更と、入金の予定の変更は、設定の画面で、Administrator 以上のロールと再認証を要する（本家でも Administrator の権限。[ユーザーの役割](https://docs.stripe.com/get-started/account/teams/roles)）。

## 4. サンドボックスと本番の切り替え

- 上部の切り替えで、同じパスの `/test` の有無を入れ替える。
- サンドボックスでは、画面の上部に色の付いた帯（「サンドボックスのデータを表示しています」）を常に出し、消せないようにする。
- ダッシュボードの API は、パスの `live` / `test` でクラスタを選ぶ（[ADR-0002](../decisions/0002-account-tenancy.md)、auth-and-keys.md の 8 節）。
- TanStack Query のキーには、アカウントの ID と環境を必ず含める。切り替えで、他方の環境のキャッシュを表示しない。
- MVP のサンドボックスは、アカウントごとに 1 つ。本家の一般のサンドボックスのように複数（最大 5 つ）を作れるようにするのは E11（[api.md](api.md) の 11 節）。その時点で、切り替えを「本番／サンドボックスの一覧」にする。

## 5. 開発者の区分

### 5.1 API キー

- キーの種類（公開・秘密・制限付き）と、発行・入れ替え・失効の規則は [auth-and-keys.md](auth-and-keys.md) にある。画面は次の本家の振る舞いに合わせる（[API キー](https://docs.stripe.com/keys)）。
  - 本番で利用者が作った秘密キー・制限付きキーは、作成の直後に 1 回だけ表示する。後から再表示できない。
  - サンドボックスのキーは、いつでも表示できる。
  - 入れ替えでは、旧いキーの失効を「今すぐ」から最大 7 日後まで選べる。
- キーの作成・表示・入れ替え・失効は、再認証（ステップアップ）を要し、監査ログに残す。
- 各キーから、そのキーでのリクエストのログへ移れる。

### 5.2 リクエストのログ

- 保持と中身は [auth-and-keys.md](auth-and-keys.md) の 9.2 節に従う。**MVP は要求のメタデータだけを 30 日持ち、本文は持たない。** 置き場所は `api_request_logs`（live・test の各クラスタ、日ごとのパーティション）。
- 本家は本文も見せ、GET の要求を 31 日、GET 以外（POST など）を 15 か月保持する（[Stripe サポート](https://support.stripe.com/questions/stripe-request-log-retention-period)、2026-09-26 に確認）。本文の保存と長い保持は、個人情報の保存の範囲の決定（auth-and-keys.md の 13 節）の後に足す（14 節の問い）。足すときは、本文を S3 に置き、31 日を過ぎたものは Athena の非同期の検索にする案を先に検討する（15 か月分の索引を Aurora に置くと、S1 でも数十億行になるため）。
- 一覧の絞り込み：日付、状態コード、メソッド、エンドポイント、API のバージョン、ソース（API / ダッシュボード）、エラーの種類・コード、IP アドレス、キー、冪等キーの有無、リソースの ID。
- 詳細：メタデータ（[api.md](api.md) の 12 節の項目）、所要時間、同じ `Request-Id` の Event（Event の `request.id` から引く）。
- 見られるのは、ログを見る権限のあるロール（本家では Administrator、Developer、Analyst、View Only など。表は auth-and-keys.md の 2.3 節）。

### 5.3 Event と Webhook

- Event の一覧・詳細（13 か月の要約、30 日の全体）、エンドポイントの管理、配信のログ、手動の再送は、[events-and-webhooks.md](events-and-webhooks.md) の 3.4 節・8 節のとおりにする。
- 署名の秘密の再表示は、再認証の後だけ（events-and-webhooks.md の 7.3 節）。
- **テストイベント**：サンドボックスで、種類（例：`payment_intent.succeeded`）を選んで「送る」と、テスト環境の API で実際にリソースを作って Event を起こす（本家の `stripe trigger` と同じ考え方。[Webhook](https://docs.stripe.com/webhooks)）。偽の Event を直接作らない。受け手の処理と、API の状態の取り直しを、実物で試せるようにするため。

## 6. チームと権限

- チームへの招待、ロールの割り当て、MFA（全員に必須）は [auth-and-keys.md](auth-and-keys.md) の 2〜4 節で決めている。ロールは本家の名前に合わせた Owner、Super Administrator、Administrator、IAM Administrator、Developer、Analyst、Dispute Analyst、Refund Analyst、Support Specialist、View Only で、権限の表の正本は auth-and-keys.md の 2.3 節（[ADR-0008](../decisions/0008-api-keys-and-dashboard-access.md)）。
- 画面の起動時の API（ブートストラップ）で、選んでいるアカウントでの利用者の権限の一覧（制限付きキーと共通の語彙。例：`refunds:write`、`api_keys:manage`、`team:manage`）を受け取る。ボタン・メニューの表示はこの一覧で決める。サーバーは、同じ権限を要求ごとに `authorize()` で判定する。
- 権限が変わったら、次の要求で 403 を受けた時点でブートストラップを取り直す。
- 「重要な操作」（auth-and-keys.md の 3.4 節：本番のキーの作成・表示・ローテーション、メンバーとロールの変更、入金先の口座の変更など）は、直近 5 分以内の再認証を要する。画面は 403 の `reauthentication_required` を受けたら、再認証のダイアログを出してから同じ要求（同じ冪等キー）を送り直す。Webhook の署名の秘密の表示も、この扱いに加える（[events-and-webhooks.md](events-and-webhooks.md) の 7.3 節）。

## 7. 監査と履歴

- セキュリティの履歴（ログイン、MFA、招待とロール、API キー、アクセスポリシー、入金先の口座、既定の API のバージョン）は、[auth-and-keys.md](auth-and-keys.md) の 9.1 節の `security_events` に残る。設定の「セキュリティの履歴」の画面は、これを一覧・絞り込み・CSV の書き出しで見せる。見られるロールも同節に従う。
- これに加えて、ダッシュボードから行ったお金を動かす操作（返金、手動の入金、Dispute の提出と受け入れ）と、Webhook のエンドポイントと署名の秘密の変更・表示を、監査ログに残す。書き方と保管は [security.md](security.md) が決める。
- 本家は、API キーの作成・表示・削除、招待、ロールの変更などを「アクティビティログ」として 6 か月保持し、API でも取れる（[アクティビティログ](https://docs.stripe.com/activity-logs)、2026-09-26 に確認）。本システムは DB に 1 年（画面で見られる期間）、アーカイブに 7 年保つ（auth-and-keys.md の 9.1 節、[security.md](security.md) の 13 節）。本家より長い。

## 8. レポートの書き出し

| レポート | 中身 | 元のデータ |
| --- | --- | --- |
| 決済 | 期間の決済の一覧（ID、日時、金額、手数料、純額、状態、決済手段、顧客） | Payments と台帳 |
| 残高の取引 | 期間の残高の増減（種類ごと、手数料を含む） | 台帳 |
| 入金ごとの明細 | 入金に含まれる残高の取引 | 台帳・Payouts |
| 返金・Dispute | 期間の一覧 | Payments・Disputes |

- 書き出しは非同期のジョブにする。要求を受けたら、ジョブを作って ID を返し、完了したら画面と（任意で）メールで知らせる。
- ファイルは CSV（UTF-8、BOM 付きを選べる。Excel で開く日本の利用者のため）。日時は既定で日本時間、金額は通貨の最小単位の整数と、整形した値の両方の列を持つ。
- ファイルは S3 に置き、取得は 15 分で失効する署名付き URL で行う。ファイルは 7 日で消す。
- 書き出しは「一括の書き出し」の権限を持つロールだけ（本家でも権限の対象）。書き出しは監査ログに残す。
- 1 回の書き出しは 100 万行まで。超えたら期間を分けるよう求める。

## 9. クライアントの作り

### 9.1 技術

Slack の client.md の選択を引き継ぐ。

| 項目 | 選択 | Slack との違い |
| --- | --- | --- |
| 骨格 | React、TanStack Router | 同じ |
| データ | TanStack Query | 同じ。Slack の Timeline ストア・SharedWorker・IndexedDB のキャッシュは作らない（リアルタイムの会話がないため） |
| API の呼び出し | `packages/api-client`（公開 API の OpenAPI から生成した型付きのクライアント）と、ダッシュボード専用の API の型付きのクライアント | Slack は Hono RPC。本システムの公開 API は `@hono/zod-openapi` で OpenAPI を出すので、そこから生成する |
| デザインシステム | `packages/ui`（CSS Modules、React Aria） | 同じ。表・日付の範囲・金額の入力の部品を足す |
| 言語 | FormatJS（ICU MessageFormat）、ja / en | 同じ |
| フラグ | 起動時の API で評価済みのフラグを受け取る | Slack の [ADR-0026](../../../slack/docs/decisions/0026-feature-flags.md) の方式。割り当ての単位はアカウント |

### 9.2 API の呼び方

- ダッシュボードの API は、ダッシュボードと同じオリジンの `/api/accounts/{acct}/{live|test}/*` に置く（[auth-and-keys.md](auth-and-keys.md) の 1 節）。セッション（HttpOnly の Cookie）で認証し、MFA・権限・テナントのコンテキストをそこで決める。
- そのうち、決済・返金・Dispute・Payout・顧客・Webhook のエンドポイントなど、公開 API にある操作は、`/api/accounts/{acct}/{live|test}/v1/...` として **公開 API と同じハンドラー** に渡す（検証・冪等・バージョンの変換・監査を共有する）。認証の段だけが API キーの代わりにセッションになる。API のバージョンは、ダッシュボードのビルドが固定する。
- 公開 API にないもの（チーム、リクエストのログの検索、配信のログ、レポート、ホームの集計、ブートストラップ）は、同じ接頭辞の下のダッシュボード専用のハンドラーに置く。これは公開の契約にしない。
- ダッシュボードからの要求は、リクエストのログに「ソース：ダッシュボード」と、操作した人の ID を付けて残す（本家と同じく、ソースで絞り込める）。
- 書き込みの要求には、すべて冪等キーを付ける（3.2 節）。
- 一覧は、画面にフォーカスが戻ったときと、60 秒ごとに取り直す。WebSocket は使わない。支払いの状態の変化を秒単位で見せる必要は、MVP ではない。

### 9.3 セキュリティ

| 項目 | 方針 |
| --- | --- |
| CSP | `default-src 'self'`、`script-src 'self'`（インラインなし）、`style-src 'self'`、`connect-src 'self'`、`img-src 'self'` とファイル配信のドメイン、`frame-src https://elements.<domain>`（ブランドの設定で Payment Element のプレビューを出すときだけ）、`frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'none'`、`require-trusted-types-for 'script'` |
| 描画 | `dangerouslySetInnerHTML` を lint で禁止する。加盟店・顧客が入力した文字列（説明、メタデータ、顧客の名前）は、テキストとして描く |
| セッション | Cookie は HttpOnly・Secure・SameSite=Lax。アイドル 12 時間・絶対 7 日（[auth-and-keys.md](auth-and-keys.md) の 3.3 節）。アイドルで切れる前に警告を出し、入力中のフォーム（Dispute の証拠の下書きなど）はサーバーに保存しておく |
| 計測 | 第三者の計測（GA4 など）は読み込まない。画面の利用の計測は、`packages/analytics` の型付きのイベントを自前の API へ送り、S3 と Athena で集計する（Slack の ADR-0025 の選択肢 2。ADR-0028） |
| エラーの報告 | 自前の RUM とエラーの収集（[observability.md](observability.md)）。第三者のエラー収集のスクリプトは使わない |

### 9.4 対応ブラウザ

Slack の client.md の 1 節と同じ（Chrome・Edge・Firefox の最新 2 メジャー、Safari 17 以上）。スマートフォンでは閲覧と主な操作（返金、Dispute の提出）ができるよう、幅に応じて配置を変える。ネイティブのアプリは作らない。

## 10. 言語とアクセシビリティ

- 言語は ja と en。利用者の設定、なければ `navigator.language` で決める。日時の既定は日本時間で、利用者の設定で変えられる。
- 金額は `Intl.NumberFormat` で通貨ごとに整形する。表では右寄せにし、等幅の数字（`font-variant-numeric: tabular-nums`）で揃える。
- WCAG 2.2 AA を満たす。Slack の client.md の 10 節の方針（ランドマーク、キーボード操作、24×24 px 以上の対象、400% の拡大）を引き継ぐ。表は `table` の要素で作り、並べ替えの状態を `aria-sort` で示す。返金などの確認のダイアログはフォーカスを閉じ込める。
- 検査は `@axe-core/playwright` で違反 0 件を PR の条件にする。

## 11. 性能の予算

| 項目 | 目標 | 測り方 |
| --- | --- | --- |
| 初回の JS（骨格） | 250 KB 以内（gzip） | CI でビルドの大きさを検査 |
| 初回表示の LCP | p75 2.5 秒以内（デスクトップ、一般的な回線） | Lighthouse CI、RUM |
| 一覧の表示（決済 25 件） | p75 1 秒以内 | RUM |
| 詳細の表示 | p75 800 ms 以内 | RUM |
| INP | p75 200 ms 以内 | RUM |
| リクエストのログの検索（30 日以内） | p95 2 秒以内 | RUM |

- 一覧の API は、索引に乗る絞り込みだけを受け付ける。索引に乗らない組み合わせ（例：金額の範囲と自由な文字列の同時の指定）は、書き出しに誘導する。

## 12. テスト

| レベル | 確かめること |
| --- | --- |
| 単体 | 金額の整形（JPY の 0 桁、USD の 2 桁）、権限の一覧からのボタンの表示 |
| 結合 | ダッシュボードからの返金が、公開 API と同じ検証・冪等・監査を通り、リクエストのログに「ソース：ダッシュボード」で残る |
| E2E（Playwright） | サンドボックスと本番の切り替えで、他方のデータが一瞬も出ない。返金のダイアログの二重送信で返金が 1 回。権限のないロールで返金のボタンが出ず、API も 403 を返す。テストイベントを送ると、エンドポイントの配信のログに出る |
| a11y・見た目 | `packages/ui` のストーリーと主要画面。ja・en、ライト・ダーク |

## 13. データモデル

ダッシュボードに固有の表だけを置く。決済・台帳などは各領域の文書にある。

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `report_runs` | `account_id`、`id`、`type`、`parameters`、`status`、`row_count`、`s3_key`、`expires_at`、`requested_by` | RLS |
| `dashboard_preferences` | `user_id`、`account_id`、`locale`、`timezone`、`saved_filters` | |

リクエストのログ（`api_request_logs`）とセキュリティの履歴（`audit_events` の `category = 'security'` の行、ビュー `security_events`）は [auth-and-keys.md](auth-and-keys.md) にある。環境は DB のクラスタで分かれる。列・索引の正本は [data-model/audit-and-operations.md](data-model/audit-and-operations.md)。

## 14. 決定と持ち越し（2026-09-26、既定案）

- **リクエストのログの本文と保持**：MVP はメタデータだけを 30 日（[auth-and-keys.md](auth-and-keys.md) の 13 節）。本文を持つかは、個人情報の整理（[intent.md](../intent.md) の「法務の確認待ち」）の後に決める。
- **ホームの集計**：前日までは日次の集計の表（`balance_daily_summaries`。[ledger.md](ledger.md) の 4.2 節の日次のジョブで BalanceTransaction から作る）を読み、当日の分だけを BalanceTransaction から足す。画面のたびに台帳の全件を集計しない。
- 持ち越し：複数のサンドボックスの切り替えの画面は E11 で作る。

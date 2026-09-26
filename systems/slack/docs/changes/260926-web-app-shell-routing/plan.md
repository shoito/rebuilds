# Plan: Web クライアントの骨格とルーティング

- Change: 260926-web-app-shell-routing
- Spec: [spec.md](spec.md)
- Status: approved

## 依存

| 依存先 | 必要なもの | 揃っていないとき |
| --- | --- | --- |
| `ci-pipeline` | `ci.yml`、`ci-gate`、`turbo.json` のタスク、ID の追跡の検査（`tools/spec-checks/`）。E2E・axe・Vitest の browser mode の段は ci-pipeline の範囲外で、**この変更で足す**（ci-pipeline の spec の「含めないもの」） | 手元の確認ループだけで進め、マージは `ci-gate` ができてから |
| [260926-post-and-list-messages](../260926-post-and-list-messages/plan.md) | モノレポの骨格、`packages/api-client`、開発用トークンの認証、`scripts/lib/decision-table.ts` | 着手できない（順序 1 の前提） |
| API の不足（spec の Open questions） | `GET /api/me/workspaces`、`GET /api/workspaces/{ws}/channels`、開発用のサインイン・サインアウト | 順序 3〜6 を止める。契約（`packages/api-client` のスナップショット）の変更として Dev の承認が要る |
| `feature-flags-appconfig` | `packages/flags` の型付きの定義と、REQ-FLAG-009 の一覧を作る関数、テストでの上書き（REQ-FLAG-010） | REQ-WEB-017 の順序 11 だけを後回しにする（`packages/flags` がなければ空の定義を置かず、順序 11 ごと延期する）。ブートストラップの API のルートはこの変更で作る（feature-flags-appconfig の範囲外） |
| `message-body-ast-v1` | 不要（web-channel-view が使う）。ただし `packages/ui` の骨格は、先に着手した側が作る（message-body-ast-v1 の Open questions） | — |

この変更は [260926-web-channel-view](../260926-web-channel-view/plan.md) より先に進める。

## Release flags

- この変更の振る舞いには release フラグを置かない。フラグの割り当ての単位はワークスペースで（ADR-0026）、ワークスペースを選ぶ前の骨格を隠せないため。E1 では本番の利用者がいない前提で、本番での Web の公開の時期は Ops と PM が決める（spec の Open questions）。
- REQ-WEB-017 は、フラグを「受け取る側」の仕組みである。チャンネルの中身の `release.web_channel_view` は web-channel-view の plan に書く。

## Files that change

パスは `systems/slack/` からの相対パス。

- `apps/web/package.json`、`apps/web/tsconfig.json`、`apps/web/vite.config.ts`（新規）：`define` でリリースの識別子、開発用の認証の有無をビルド時の定数にする。インラインのスクリプトを出さない設定
- `apps/web/index.html`（新規）：`<meta name="app-release">`、`<html lang>` の初期値。インラインのスクリプト・スタイルなし
- `apps/web/eslint.config.js`（新規）：`fetch`・`XMLHttpRequest`・`hono/client` の直接の使用、`dangerouslySetInnerHTML`、クエリのキーの直書きを禁止
- `apps/web/src/main.tsx`（新規）
- `apps/web/src/app/router.tsx`、`apps/web/src/app/routes/{root,index,signin,workspace,channel,not-found}.tsx`（新規）
- `apps/web/src/app/route-decision.ts`（新規）：DT-WEB-001、DT-WEB-002 の純関数
- `apps/web/src/app/next-param.ts`（新規）：DT-WEB-004
- `apps/web/src/app/auth/{session.ts,dev-signin.tsx,signin-placeholder.tsx}`（新規）：認証の口（spec の Design「認証の境界」）
- `apps/web/src/app/layout/{AppShell,WorkspaceSwitcher,ChannelSidebar}.tsx`（新規）
- `apps/web/src/app/screens/{NotFound,Forbidden,ErrorScreen,WorkspacePicker,Empty}.tsx`、`apps/web/src/app/ErrorBoundary.tsx`（新規）
- `apps/web/src/app/last-opened.ts`（新規）：「最後に開いた」の記憶
- `apps/web/src/api/{client.ts,query-keys.ts,classify-error.ts,retry.ts}`（新規）：`packages/api-client` の包み、DT-WEB-003
- `apps/web/src/flags/{bootstrap.ts,useFlag.ts}`（新規）
- `apps/web/src/release.ts`、`apps/web/src/report-error.ts`（新規）
- `apps/web/src/i18n/{index.tsx,locale.ts}`、`apps/web/src/i18n/messages/{ja,en}/shell.json`（新規）：DT-WEB-005
- `apps/web/src/a11y/{RouteAnnouncer.tsx,useDocumentTitle.ts,SkipLink.tsx}`（新規）
- `apps/web/test/*.test.ts`（新規）：単体・表駆動・性質
- `apps/web/test/browser/*.test.tsx`（新規）：Vitest の browser mode
- `apps/web/e2e/{shell,not-found,csp,a11y}.spec.ts`、`apps/web/playwright.config.ts`（新規）
- `apps/web/e2e/support/csp-server.ts`（新規）：本番のビルドを security.md の CSP 付きで配る
- `.github/workflows/ci.yml`（変更。リポジトリのルートからのパス）：`web-e2e` のジョブ（Docker Compose の API と DB、Playwright の Chromium、axe）を足し、`ci-gate` の `needs` に加える
- `turbo.json`（変更）：`test:browser`（Vitest の browser mode）、`test:e2e` のタスク
- `scripts/check-i18n-keys.ts`（新規）
- `scripts/check-web-bundle.ts`（新規）：本番のビルドに開発用のサインインの部品・経路の文字列がないこと、初回の JS の大きさ
- `packages/db/seed.ts`（変更）：E2E 用に、2 つのワークスペース、パブリック・プライベートのチャンネル、参加していないプライベートチャンネル、0 件のワークスペースのアカウント
- `packages/ui/`（新規、まだなければ。message-body-ast-v1 と先に着手した側が骨格を作る）：ボタン、リンクの一覧、エラーの枠の最小の部品
- `packages/contract/src/bootstrap.ts`（新規）、`apps/api/src/routes/bootstrap.ts`（新規）、`apps/api/src/app.ts`（変更）：ブートストラップの API（REQ-WEB-017）。`packages/api-client` のスナップショットの更新は Dev の承認が要る
- `apps/api/test/bootstrap.test.ts`（新規）：メンバーでなければ 404、`client: false` のフラグを含まない

## Order of work

- [ ] 1. `apps/web` の雛形、Vite・TanStack Router・TanStack Query・react-intl、lint の規則（REQ-WEB-013）
- [ ] 2. API の呼び出し口と応答の分類、再試行（REQ-WEB-012、REQ-WEB-013、DT-WEB-003）
- [ ] 3. 認証の口、開発用のサインイン、本番のビルドでの除去（REQ-WEB-004、REQ-WEB-005）※ API の不足が解消してから
- [ ] 4. ルートの定義と判定、`next` の検証（REQ-WEB-001、REQ-WEB-002、REQ-WEB-003、DT-WEB-001、DT-WEB-004、PROP-WEB-003）
- [ ] 5. ワークスペースの一覧・選択・切り替え、「最後に開いた」の記憶と転送（REQ-WEB-006、REQ-WEB-007、REQ-WEB-008、DT-WEB-002）
- [ ] 6. チャンネル一覧のサイドバー（REQ-WEB-010）
- [ ] 7. クエリのキーの規則とワークスペースごとの分離（REQ-WEB-009、PROP-WEB-002）
- [ ] 8. 「見つかりません」「アクセスできません」とエラーの画面、エラー境界（REQ-WEB-011、REQ-WEB-012、PROP-WEB-001）
- [ ] 9. リリースの識別子（REQ-WEB-018）
- [ ] 10. 国際化の土台と、キーの検査（REQ-WEB-015、DT-WEB-005）
- [ ] 11. ブートストラップの API とフラグの受け取り（REQ-WEB-017、PROP-WEB-004）※ `feature-flags-appconfig` の後
- [ ] 12. a11y の土台（REQ-WEB-016）
- [ ] 13. サインアウト（REQ-WEB-019）
- [ ] 14. CSP の E2E と、成果物の検査（REQ-WEB-014、REQ-WEB-004）
- [ ] 15. seed の追加と、`web-e2e` のジョブ・`test:browser` のタスクを CI に載せる（夜間の 3 エンジンの実行は E7）

1〜2、4、7〜10、12 は API の不足と関係なく進められる（API は MSW などではなく、`packages/api-client` の型に合わせたテスト用の偽物で単体テストする。E2E は実 API で行う）。

## Risks

- **API の不足**：`/api/me/workspaces`・チャンネル一覧・開発用のサインインがないと、E2E が書けない。契約の変更は Dev の承認が要るので、早めに起票する。
- **パスの接頭辞の不一致**（`/api` の有無）：`packages/api-client` の基準の URL を決めないと、同一オリジンの前提（CloudFront のパスの振り分け）と食い違う。
- **CSP とビルドの道具**：Vite・プラグイン・React Aria・TanStack の開発用の道具が、インラインのスクリプト・スタイルや `eval` を使うことがある。開発サーバーでは気づけないので、本番のビルドで CSP の E2E を必ず回す。Trusted Types（`require-trusted-types-for 'script'`）で壊れる依存がないかは 未検証。
- **「見つかりません」からの漏洩**：画面の文言は同じでも、ワークスペースの枠（名前）、`document.title`、読み込みの時間の差、転送の有無で区別できてしまいうる。PROP-WEB-001 はアクセシビリティツリーと DOM で比べるが、時間の差は対象にしない（API の側の関心事とする）。
- **フラグのちらつき**：フラグの取得の前に既定値で描くと、機能が一瞬出て消える。取得中は骨格の読み込み表示にする。3 秒の上限を超えたら既定値で描く。
- **本番のビルドへの開発用のサインインの混入**：ビルド時の定数の分岐が tree-shaking で消えないと、本番に開発用の画面が残る。成果物の検査（`scripts/check-web-bundle.ts`）で防ぐ。
- **既存の振る舞い**：新しいアプリなので、壊す既存の振る舞いはない。

## Proof

「Vitest（browser）」は Vitest の browser mode（Playwright のプロバイダ、Chromium・Firefox・WebKit）を指す。表駆動テストは `spec.md` の表を `scripts/lib/decision-table.ts` で読み込み、テスト名に `DT-WEB-00N #行` を含める。

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| 定義したパスと、未定義のパスの「見つかりません」 | REQ-WEB-001 | Playwright（Chromium）：各ルートを開いて画面を確かめる |
| 未認証の転送と `next` の付与、操作中の 401 | REQ-WEB-002 | Playwright：Cookie なしで開く、API のセッションを消してから操作する |
| サインイン後の転送先 | REQ-WEB-003 | Playwright：自サイトのパス、外部のオリジン |
| 開発用のサインインと、本番のビルドからの除去 | REQ-WEB-004 | Playwright（開発用のビルド）。`scripts/check-web-bundle.ts` が本番のビルドで通る |
| 認証情報を保存しない | REQ-WEB-005 | Playwright：サインイン後に全ストレージと URL を走査し、トークンの値がない |
| `/` と `/w/{ws}` の転送 | REQ-WEB-006、REQ-WEB-007 | Playwright：seed の各状態（記憶あり・外された・0 件） |
| 転送先の規則 | DT-WEB-002 | Vitest：表駆動（7 行 = 7 ケース） |
| ワークスペースの切り替えと戻る | REQ-WEB-008 | Playwright |
| 遅れて届いた応答を混ぜない | REQ-WEB-009 | Vitest（browser）：応答の遅延を制御できる偽の API で |
| 画面のデータは URL のワークスペースのものだけ | PROP-WEB-002 | fast-check ＋ Vitest（browser）：切り替え・戻る・応答の遅延と順序の任意の列を生成し、各時点で描画中の要素の `data-workspace-id` が URL と一致する（100 回）。lint：クエリのキーの直書きがない |
| サイドバーの一覧と失敗の表示 | REQ-WEB-010 | Vitest（browser）、Playwright |
| 「見つかりません」の画面 | REQ-WEB-011 | Playwright：存在しない・権限がない・別のワークスペース・形式が不正の 4 通り |
| 理由で区別できない | PROP-WEB-001 | Playwright：4 通りの画面のアクセシビリティツリー（`page.accessibility` 相当）と `document.title` と、ID を伏せた DOM のスナップショットが一致し、seed のチャンネル名・ワークスペース名を含まない。fast-check で ID の形を生成（形式が不正な文字列を含む、50 回） |
| API の応答の扱い | REQ-WEB-012 | Vitest（browser）：偽の API で 500・429 を返す。偽のタイマーで `Retry-After` を確かめる |
| 応答の分類と再試行 | DT-WEB-003 | Vitest：表駆動（8 行） |
| API の呼び出し口 | REQ-WEB-013 | lint が CI で通る。lint の規則そのものの単体テスト（違反の例が失敗する）。Vitest：呼び出し口が付けるヘッダーと `credentials` |
| CSP の違反がない | REQ-WEB-014 | Playwright（Chromium・Firefox・WebKit）：`e2e/support/csp-server.ts` で本番のビルドを配り、主要な操作の間の `securitypolicyviolation` が 0 件。`index.html` にインラインの `<script>`・`<style>`・`style=` がないことの検査 |
| 国際化の土台 | REQ-WEB-015 | Playwright：`locale` を `en-US`・`ja-JP` にして文言と `<html lang>`。`scripts/check-i18n-keys.ts` が CI で通り、キーの欠けで失敗する（検査の単体テスト） |
| 言語の決定 | DT-WEB-005 | Vitest：表駆動（3 行） |
| a11y の土台 | REQ-WEB-016 | `@axe-core/playwright`：5 画面 × ja・en で違反 0 件。Playwright：ルートの移動でのフォーカス・`document.title`・読み上げの領域 |
| ブートストラップの API、フラグの受け取り、失敗時の既定値 | REQ-WEB-017 | 結合テスト（Testcontainers）：メンバーは 200、非メンバー・別のワークスペースは 404、`client: false` を含まない。Vitest（browser）：偽のブートストラップの API（成功・503・3 秒超） |
| フラグは表示中のワークスペースのもの | PROP-WEB-004 | fast-check ＋ Vitest：切り替えとフラグの応答の任意の列（100 回） |
| リリースの識別子 | REQ-WEB-018 | Vitest：ヘッダーに付く。Vitest（browser）：エラー境界の画面と報告口に付き、スタックを出さない |
| サインアウト | REQ-WEB-019 | Playwright：サインアウト後に戻るで、キャッシュの名前が出ず転送される。`localStorage` の記憶が消える |
| ルートの判定 | DT-WEB-001 | Vitest：表駆動（10 行） |
| `next` の検証 | DT-WEB-004 | Vitest：表駆動（7 行） |
| 転送先は自サイトのパスだけ | PROP-WEB-003 | fast-check：任意の文字列と、`//`・`/\`・`%2F%2F`・制御文字・`javascript:` を混ぜた生成器（1,000 回） |
| 初回の JS の予算 | client.md の 11 節 | `scripts/check-web-bundle.ts`：骨格の初回の JS が gzip で 200KB 以内 |
| すべての ID がテストから参照されている | — | ID の追跡の検査が CI で通る |

# Roadmap: Slack

## 進め方の原則

- **最初に walking skeleton を通す。** E1 で、契約・DB・API・最小の Web 表示を端から端まで貫いてから、機能を広げる。
- **契約を先に固定する。** API とイベントの契約（`packages/contract` の Zod スキーマと、Hono RPC のクライアント型）は人間がレビューして確定し、エージェントは勝手に変えない。クライアント型のスナップショットで、CI が差分を検知する（ADR-0008）。
- **検証手段を先に作る。** 各変更の `plan.md` の Proof を先に書き、エージェントには「これを満たせ」という形で渡す。
- **1 変更 1 PR を目安に、差分を小さくする。** 並列に動くエージェント同士が同じファイルを触らないよう、パッケージ境界で変更を切る。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 Walking skeleton | 開発と運用の基盤、テナント分離を含む最小のデータモデル、投稿と履歴取得、最小の Web 表示 | 設計中 |
| E2 テナントと権限 | 認証、アカウントとメンバー、招待、ロール、権限の決定表 | 未着手 |
| E3 会話機能 | 編集・削除、スレッド、リアクション、メンション、リンクのプレビュー | 未着手 |
| E4 リアルタイム同期 | Relay、Gateway、差分取得、在席・入力中、クライアントの同期エンジン | 未着手 |
| E5 既読・通知 | 既読・未読、メンションのバッジ、Web Push、メール | 未着手 |
| E6 検索とファイル | 日本語全文検索、ファイルのアップロード・スキャン・配信 | 未着手 |
| E7 本番運用 | 負荷試験、SLO、災害復旧、セキュリティの基盤、リリースの仕組み、利用状況の計測 | 未着手 |
| E8 企業向け機能 | SSO・SCIM、監査ログ、保持ポリシー、リーガルホールド、エクスポート、削除 | 未着手 |
| E9 AI エージェント連携 | リモート MCP サーバー（読み取り → 書き込み） | 未着手 |
| E10 S2 への拡張 | Valkey の sharded pub/sub、巨大チャンネルの経路、OpenSearch への移行 | 未着手（S2 の判断の基準を満たしたら） |
| E11 S3 への拡張 | セル構成、大阪のウォームスタンバイ | 未着手（ADR-0023 は proposed） |

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する（[process.md](../../../docs/process.md) の「粒度」）。ここは計画であり、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。

### E1 Walking skeleton

| Story | 内容 |
| --- | --- |
| `terraform-foundation` | AWS の Organizations、アカウント、VPC、Terraform の状態のバケット、GitHub Actions の OIDC（ADR-0020） |
| `ci-pipeline` | PR の CI、merge queue、ID の追跡の検査、マイグレーションの lint（[delivery.md](architecture/delivery.md)） |
| `telemetry-package` | 計装の共通部品 `packages/telemetry`（ADR-0021） |
| `feature-flags-appconfig` | `packages/flags` と AppConfig。トランクベース開発の前提なので最初に作る（ADR-0026） |
| `post-and-list-messages` | 投稿と履歴取得、RLS を含む最初のマイグレーション（起票済み：[260926-post-and-list-messages](changes/260926-post-and-list-messages/)） |
| `message-body-ast-v1` | 本文の AST の Zod スキーマと `toPlainText`（ADR-0006） |
| `web-app-shell-routing` | アプリの骨格、ルーター、ワークスペースの切り替え |
| `web-channel-view` | チャンネルの仮想化された一覧 |

### E2 テナントと権限

| Story | 内容 |
| --- | --- |
| `auth-email-otp-and-oauth` | Better Auth、メールの OTP、Google・Microsoft |
| `sessions-and-device-list` | セッションの管理と端末の一覧、取り消し |
| `member-resolution-middleware` | アカウントからメンバーを解決し、`SET LOCAL` でテナントのコンテキストを設定する |
| `rls-migration-lint` | テナントテーブルの RLS の検査と、`search` スキーマの例外（ADR-0009、0027） |
| `authorization-decision-tables` | 権限の決定表（`DT-CHN-*`）と判定関数 |
| `email-invitations` | メールでの招待 |
| `mfa-totp-and-passkeys` | TOTP とパスキー |
| `bot-member-api-tokens` | ボット・エージェントのメンバーと、スコープ付きのトークン |
| `auth-rate-limits` | 認証と招待のレート制限、ロックアウト |
| `account-deletion` | アカウントの削除とメンバーの匿名化 |

### E3 会話機能

| Story | 内容 |
| --- | --- |
| `edit-message` | 編集 |
| `delete-message-tombstone` | 削除と墓標 |
| `thread-replies` | スレッドの返信（チャンネルの `seq` を消費する） |
| `thread-subscriptions` | スレッドの購読 |
| `reactions` | リアクション（`PUT` / `DELETE` で冪等） |
| `mentions-and-broadcast` | メンションと @channel / @here |
| `composer-prosemirror-ast` | 入力欄と AST の変換、IME |
| `mention-autocomplete` | @ / # / : の補完 |
| `jump-to-message` | 指定した `seq` への移動（`around_seq` の API を含む） |
| `link-unfurl` | 隔離した取得器でのリンクのプレビュー（ADR-0016） |
| `pins` | ピン留め（任意） |

### E4 リアルタイム同期

| Story | 内容 |
| --- | --- |
| `relay-partitioned-outbox` | outbox のパーティションと、Relay のリース（`trace_context` を含む） |
| `channel-events-catch-up` | `channel_events` と差分取得、`min_seq` |
| `realtime-ticket-auth` | WebSocket のチケットと `Origin` の検査 |
| `gateway-hello-ready` | 接続の確立と再開 |
| `gateway-subscription-aggregation` | ノード単位の購読の集約 |
| `gateway-backpressure` | 遅い受信者の扱い |
| `gateway-graceful-drain` | デプロイ時の接続の移し替え |
| `presence-ttl` | 在席 |
| `typing-indicator` | 入力中の表示 |
| `client-sync-engine` | クライアントの同期の状態遷移と差分取得 |
| `sharedworker-multitab` | 接続を SharedWorker に 1 本にまとめる |
| `send-queue-indexeddb` | 未送信のキューを IndexedDB に持つ |
| `offline-read-cache` | オフラインで読めるキャッシュ |

### E5 既読・通知

| Story | 内容 |
| --- | --- |
| `unread-divider-and-read` | 未読の線と既読の更新 |
| `thread-read-state` | スレッドの既読 |
| `mention-badges` | メンションのバッジ |
| `unreads-summary-api` | 表示していないワークスペースの未読の要約 |
| `notification-planner` | 通知の計画と分割 |
| `notification-prefs-dnd` | 通知の設定とおやすみモード |
| `web-push-vapid` | Service Worker、Web Push、バッジ |
| `email-digest-ses` | 遅らせて送るメール |

### E6 検索とファイル

| Story | 内容 |
| --- | --- |
| `search-pg-bigm` | 検索用のテーブルと関数、indexer（ADR-0027） |
| `search-query-parser` | `from:`・`in:`・日付などの構文 |
| `file-upload-presigned` | 署名付き PUT でのアップロード |
| `file-malware-scan` | GuardDuty でのスキャンと隔離 |
| `file-thumbnails` | サムネイルとプレビュー |
| `file-delivery-signed-url` | 権限の確認と、短命の署名付き URL での配信 |
| `file-deletion-and-quota` | 削除と、ワークスペースの容量の上限 |

### E7 本番運用

| Story | 内容 |
| --- | --- |
| `security-headers-csp` | CSP と各種ヘッダー |
| `waf-baseline` | WAF の基本設定 |
| `supply-chain-ci` | SBOM、来歴、Actions の SHA の固定 |
| `security-scanning` | SAST、依存の検査、DAST |
| `blue-green-deploy-pipeline` | api の blue/green、Gateway のローリング、prod の承認 |
| `slo-dashboards-burn-rate` | SLO のダッシュボードとバーンレートのアラート |
| `synthetic-canary` | 合成監視 |
| `rum-telemetry-endpoint` | 自前の RUM の受け口 |
| `log-pii-lint` | ログの個人情報の検査 |
| `capacity-load-tests` | [capacity.md](architecture/capacity.md) のモデルでの k6 試験（1 倍・2 倍、AZ の喪失、再接続の殺到、巨大チャンネル） |
| `dr-pilot-light-osaka` | 大阪の Global Database と、切り替えのワークフロー |
| `restore-drill` | 復元の訓練の自動化 |
| `product-analytics-ga4` | `packages/analytics`、同意、ワークスペースの設定（ADR-0025） |
| `client-perf-budget-ci` | 性能の予算の CI |
| `i18n-ja-en` | 日本語・英語 |
| `a11y-baseline` | アクセシビリティの基盤 |

### E8 企業向け機能

| Story | 内容 |
| --- | --- |
| `workspace-sso-oidc` | ワークスペースの SSO（OIDC） |
| `workspace-sso-saml` | ワークスペースの SSO（SAML） |
| `domain-verification-and-join` | ドメインの確認と参加 |
| `sso-enforcement-policy` | SSO の強制 |
| `audit-log-core` | 監査ログの記録 |
| `audit-log-archive` | アーカイブへの送出と改ざんの検知 |
| `audit-log-admin-view` | 管理者向けの閲覧 |
| `retention-policies` | 保持ポリシー |
| `legal-hold` | リーガルホールド |
| `workspace-export` | ワークスペースのエクスポート |
| `workspace-deletion` | ワークスペースの削除と消去 |
| `invite-links` | 招待リンク（S2） |
| `scim-users` | SCIM（S2） |

### E9 AI エージェント連携

| Story | 内容 |
| --- | --- |
| `mcp-authorization` | Better Auth の mcp・cimd プラグイン、同意の画面、ワークスペースの選択、トークンの管理画面 |
| `mcp-read-tools` | 読み取りと検索のツール |
| `mcp-workspace-policy` | 管理者の設定（利用の可否、許可するクライアント、書き込み） |
| `mcp-write-tools` | 投稿とリアクションのツール（読み取りの運用で問題がないことを確かめてから） |

### E10・E11 規模の拡張

| Story | 内容 |
| --- | --- |
| `valkey-sharded-pubsub` | Valkey のクラスタと sharded pub/sub（E10） |
| `large-channel-path` | 巨大チャンネルのファンアウトの経路（E10） |
| `search-opensearch-migration` | OpenSearch への二重書き込みと切り替え（E10） |
| `reconnect-storm-load-test` | 25 万接続での再接続の殺到の試験（E10） |
| `cell-routing` | ワークスペースとセルの対応表とルーティング（E11） |
| `workspace-cell-migration` | ワークスペースのセル間の移動（E11） |

各 Epic の品質面の重点と合否基準は、[quality.md](quality.md) の 5 節にある。

## エージェントに任せないこと

- **契約（API・イベント・スキーマ）の確定**：後から変えるコストがいちばん高い。
- **テナント分離と権限モデルの最終確認**：テストが通っていても、テストケースの漏れはエージェント自身では気づきにくい。
- **体験の良し悪し**：スクロール位置の保持、未読線の位置、入力中のラグなど、触らないとわからない品質。
- **負荷試験結果の解釈**：数字は出せるが、どこに投資するかはプロダクトの判断。

## 後回しにしたもの：AI 前提で作り直すなら

MVP の後に、製品体験として検討する。それぞれ、着手するときに `intent.md` から起票する。

- **「未読を全部読む」をやめる**：未読が溜まったチャンネルは、要約と「あなたに関係あるもの」の抽出を既定の表示にする。`seq` の範囲を指定して要約できるよう、差分取得 API をそのまま流用する。
- **スレッドを後から整理する**：流れてしまった議論を、AI が決定事項・未解決事項・担当者に構造化して、チャンネルに固定する。
- **検索を質問応答にする**：全文検索のインデックスに加えて、ベクトルインデックスを持つ。ただし権限フィルタは必ず検索の前段で適用する（ADR-0005）。
- **エージェントを第一級のメンバーにする**：Bot を特殊扱いせず、アカウントを持たないメンバーとして扱い（ADR-0010）、人間と同じ権限モデル・同じイベントストリームに載せる。

# Runbooks: Auth0

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みは [observability.md](../architecture/observability.md) にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md の 3.2・5.2 節と [ADR-0062](../decisions/0062-sli-and-synthetic-monitoring.md) は、これを計測・実装する側の記述である。

## 1. SLI と SLO

| SLI | SLO | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- |
| 認証の経路の可用性（[ADR-0005](../decisions/0005-authentication-path-availability.md) の定義のエンドポイント。本番のテナントの要求のうち、失敗でないものの割合。分類は ADR-0062：4xx と方針の 429（`<Brand>-RateLimit-Reason` 付き）は成功、過負荷・フェイルオーバーの 503、5xx、時間切れは失敗） | **月間 99.99%**（NFR-001、K1） | 速いバーンレートで呼び出し。エラーバジェットを使い切ったら修正以外のデプロイを止める | |
| 管理の経路の可用性（Management API の 5xx とタイムアウトでない割合） | **月間 99.9%**（NFR-004） | バーンレートで呼び出し（認証の経路と別に数える） | |
| ログインの処理時間（パスワードの送信から応答。外部の IdP・メール・Action の待ちを除く） | **p99 500ms**（NFR-002、K4） | 15 分続いたらチケット。30 分で呼び出し | |
| ログインの画面の表示（`/authorize` から画面） | **p99 300ms**（NFR-002） | 15 分続いたらチケット | |
| トークンの発行（`/oauth/token`、Signer を含む） | **p99 150ms**（NFR-003） | 15 分続いたらチケット。30 分で呼び出し | |
| Management API の処理時間（一覧・検索・ログを除く） | **p99 500ms**（NFR-004） | 1 時間続いたらチケット | |
| Signer の署名 | p99 10ms | 15 分続いたらチケット | |
| ログの反映（イベントから `/logs` の検索に出るまで） | **p95 30 秒**（NFR-010） | 15 分超でチケット | ○ |
| ログストリームの最初の送信 | **p95 60 秒**（NFR-010） | 15 分超でチケット。取りこぼしの日次の突き合わせで欠けがあれば呼び出し | ○ |
| 設定の反映（コミットから全タスク） | p99 5 秒、最大 15 秒（[ADR-0032](../decisions/0032-tenant-config-cache.md)） | 15 秒超で呼び出し | ○ |
| JWKS の書き出し（鍵の状態の変化から S3 へ） | 60 秒以内。CloudFront での確かめまで p95 2 分 | 60 秒超で呼び出し | |
| Back-Channel Logout の最初の送信 | p95 60 秒 | 15 分超でチケット | |
| メールの送信（`auth` の列：outbox から SES の受け付け） | p95 10 秒（`notify` の列は p95 5 分） | 送信の失敗 5%、または遅れの p95 5 分で呼び出し | |
| メールの到達性（合成。受信箱への到着） | p95 60 秒、迷惑メールのフォルダー 0 件 | 1 時間続けばチケット | ○ |
| ログインの成功率（全体・接続別・テナント別） | 目標なし。過去 4 週の同じ曜日・時間帯との差 | 全体で 5 ポイント以上の低下が 10 分続けば呼び出し。1 テナントだけならチケット | ○ |
| 誤ブロックの代わりの指標（既知の端末の Cookie を持つ要求の `block` の割合） | 0.1% 以下（K5） | 0.1% 超でチケット | ○ |
| DR の複製の遅延（`AuroraGlobalDBRPOLag`、主のクラスタ） | 10 秒以内 | 10 秒超が 5 分続けば呼び出し | |
| 秘密の出力の検出（ログ・トレース・エラーの本文。K6） | 0 件 | 1 件で呼び出し（SEV2 から） | ○ |
| KMS の `ThrottlingException` | 0 件 | 1 件で呼び出し | |

- SLO の窓は 30 日の移動の窓（SLA の報告は暦の月）。99.99% のエラーバジェットは約 4.3 分しかないので、合成監視（2 回続けて失敗）と症状のアラート（5 分間の認証の経路の失敗の率が 0.5% 超）も置く（[observability.md](../architecture/observability.md) の 5.1 節）。
- 対象は `environment = production` のテナントだけ。開発・ステージングのテナントは SLO の対象外。テナントごとの可用性も記録し、SLA の報告と大口のテナントのサポートに使う（SLO にはしない）。
- Actions を使うテナント（E13）も、Action の基盤の障害を除かずに数える（[extensibility.md](../architecture/extensibility.md) の 13 節）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分（NFR-005）、リージョンの障害は RPO 1 分・RTO 1 時間（NFR-006。S2 で RTO 15 分）。ログのクラスタの検索の RTO は 4 時間（書き込みは outbox に溜まる。[infrastructure.md](../architecture/infrastructure.md) の 6.3 節）。

## 2. テナント単位の上限

上限の値の正本は [management-api-and-rate-limiting.md](../architecture/management-api-and-rate-limiting.md) の 6 節。値は環境（本番・本番以外）で変え、プランで変えない（[ADR-0035](../decisions/0035-rate-limiting.md)）。緩和・引き締めは `rate_limit_overrides` で行い、Ops が承認してプラットフォームの監査に残す（手順は `rate-limit-override.md`）。

| 対象 | 上限（S1、本番） | 超えたとき |
| --- | --- | --- |
| 認証 API の全体（テナント） | 1 秒 100、バースト 100（本番以外 1 秒 25） | 429。`refresh_token` の交換だけは 120% まで通す |
| Management API の全体（テナント） | バースト 50、1 秒 16（本番以外 バースト 10、1 秒 2）。ダッシュボードに 1 秒 5 の予約の枠 | 429 `too_many_requests` |
| エッジ（WAF、IP） | ログイン・サインアップの送信 5 分に 300 で Challenge・1,000 で Block、`/oauth/token` と全体 5 分に 30,000 で Block、管理の経路 5 分に 10,000 | 403（WAF）か Challenge |
| Actions のテナントの同時実行（E13） | 本番 100、本番以外 10 | `temporarily_unavailable` |

- 大きな緩和（全体を 2 倍以上）は、容量（[capacity.md](../architecture/capacity.md)）を確かめてから承認する。大きなイベント（チケットの発売、テレビの放送）の前は、期限つきの上書きで受ける。
- 主要な指標に `tenant_id` のラベルを付ける（上位 200 件＋「その他」）。1 テナントが書き込みの 20% を超え続けたら、S2 の判断の材料にする（[infrastructure.md](../architecture/infrastructure.md) の 9 節）。

## 3. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- すべての新しい振る舞いは release フラグの裏に置き、**テナントを単位に**、社内のテナント → 開発・ステージングの環境のテナントの 100%（最低 7 日）→ 本番のテナントの 1%・10%・50%・100%（各段で最低 24 時間）の順に広げる（[ADR-0066](../decisions/0066-tenant-canary-release.md)）。
- ガード（ログインの成功率、`invalid_grant` の率、リフレッシュトークンの再利用の検知、5xx、秘密の出力）でフラグを自動で切る。
- デプロイの順は、マイグレーション（expand）→ relay・worker → mgmt（blue/green）→ auth（blue/green のカナリア 10% → 100%。ログインの成功率・`invalid_grant`・Signer の失敗もアラームに入れる）。
- **Signer は、他のサービスと別の日に本番へ出す**（[ADR-0065](../decisions/0065-security-sensitive-change-flow.md)）。1 AZ ずつのローリングで、KMS の読み込みの速さ（1 タスク 1 秒 500 回）を守る。
- `security:sensitive` の変更は、作成者と別の 2 人（Dev のテックリードとセキュリティの担当）の承認が要る。事後の確認の例外は使わない。認証を弱める方向の変更は、フラグの既定を旧い振る舞いにし、PM とセキュリティの担当が広げる。
- ロールバックはまずフラグで行う。次に 1 つ前のイメージ。マイグレーションは戻さない。セッション・Cookie・トランザクション・トークンの形の変更は、新旧を読めるコードを先に出す。
- 本番へのデプロイは Ops が承認する。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| アプリ（auth、mgmt、relay、worker） | 平日 10〜17 時 | 金曜 15 時以降、年末年始、テナントから知らされた大きなイベントの時間帯、エラーバジェットを使い切っている間、夜間の CI が 2 日続けて失敗している間（フラグの拡大も止める）、`main` の適合試験が赤の間 |
| Signer | 平日 10〜16 時。他のサービスのデプロイと別の日 | アプリと同じ |
| Terraform（`global/edge`、`regional/keys`、WAF） | 平日 10〜16 時。WAF の新しい Block は Count で 24 時間出してから | アプリと同じ |
| DR のフェイルバック（東京へ戻す switchover） | 計画作業として | 大きなイベントの日を避ける |

- 脆弱性の修正（Critical）は時間帯の制限を受けない。2 人の承認、適合試験、拒否の側のテストは省かない。
- 凍結の予定（年末年始、大きなイベントの日付）は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する。

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。できるまでは [incident-response.md](incident-response.md) の該当の節で対応する。アラートの条件は [observability.md](../architecture/observability.md) の 5.2 節。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。

| アラート | 手順 | 状態 | Story（[roadmap.md](../roadmap.md)） |
| --- | --- | --- | --- |
| 認証の経路の SLO の速いバーンレート、失敗の率（5 分で 0.5% 超）、合成監視の連続失敗、ログインの成功率の低下 | [incident-response.md](incident-response.md) | 作成済み | E3 `edge-sli-and-synthetics` |
| ハッシュの待ち行列の飽和、Signer の失敗、KMS のスロットリング・到達不能、重要なセキュリティの仕組みの停止、監査ログのハッシュの連鎖の検証の失敗 | [incident-response.md](incident-response.md)（「依存先の障害」） | 作成済み | E12 `slo-and-alert-tuning` |
| クレデンシャルスタッフィングの兆候 | [incident-response.md](incident-response.md) の「クレデンシャルスタッフィングの波」 | 作成済み | E8 `monitor-mode-and-notifications` |
| 秘密の出力の検出、秘密の走査の停止 | [incident-response.md](incident-response.md) の「秘密の出力」 | 作成済み | E1 `telemetry-package` |
| デプロイ中の自動ロールバック、デプロイの後の悪化、テナントのカナリアのガードの停止 | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み | E1 `feature-flags-tenant-canary` |
| 署名鍵の KMS の鍵の操作（キーポリシーの変更、Signer 以外の `Decrypt`）、テナントからの鍵の漏えいの報告、JWKS の書き出しの遅れ | [emergency-key-rotation.md](emergency-key-rotation.md)、[incident-response.md](incident-response.md) の「署名鍵の漏えいの疑い」 | 作成済み | E3 `emergency-key-rotation`、E12 `key-emergency-drills` |
| AZ・リージョンの障害、`AuroraGlobalDBRPOLag` の超過、大阪の待機の構成の異常、論理的な破損 | [disaster-recovery.md](disaster-recovery.md) | 作成済み | E12 `dr-drills` |
| outbox の最古の行が 30 秒超 | `relay-backlog.md` | E1 で作成 | E1 `outbox-and-relay` |
| KMS の障害（Signer・Auth を縮小しないことの確認、キャッシュにない鍵のテナントの一覧） | `kms-outage.md` | E1 で作成 | E1 `kms-key-hierarchy` |
| pepper の暗号文の喪失、pepper の漏えいの疑い（バージョンの切り替え） | `pepper-recovery.md` | E1 で作成 | E1 `pepper-bootstrap` |
| `main` の適合試験の失敗 | `conformance-regression.md`（切り分けと戻し方） | E1 で作成 | E1 `conformance-suite-ci` |
| 設定の反映の遅れ（15 秒超）、設定の組み立ての失敗 | `config-propagation-lag.md` | E2 で作成 | E2 `tenant-config-snapshot` |
| クライアントシークレットの漏えい（シークレットスキャンの通報、テナントの報告） | `leaked-client-secret.md`（失効、アプリの一時的な無効化、連絡） | E2 で作成 | E2 `app-registration-and-credentials` |
| テナントの停止と復元の依頼 | `tenant-suspend-and-restore.md` | E2 で作成 | E2 `tenant-lifecycle` |
| レート制限の計数の失敗（Valkey） | `ratelimit-backend-down.md`（近似の制限の確認） | E2 で作成 | E2 `mgmt-rate-limits` |
| 認可コードの再利用の急増 | `code-reuse-spike.md` | E3 で作成 | E3 `authorization-code-grant` |
| 特定のテナントの 429 の急増 | `rate-limit-spike.md` | E3 で作成 | E3 `auth-path-rate-limits` |
| JWKS の確かめの失敗（S3 と CloudFront の食い違い） | `jwks-publication-stale.md` | E3 で作成 | E3 `jwks-and-discovery-publishing` |
| Signer 全体の侵害の疑い | `signer-compromise.md`（全テナントの緊急のローテーションの順序） | E3 で作成 | E3 `emergency-key-rotation` |
| メールの送信の失敗・遅れ、SES のアカウントの審査・停止、コードが届かない問い合わせ | `email-delivery-failure.md`（予備のアカウント・大阪への切り替えを含む） | E4 で作成 | E4 `email-outbox-and-sender` |
| バウンス率・苦情率の警報、特定のメールの事業者での迷惑メール | `email-reputation.md` | E4 で作成 | E4 `email-deliverability-monitoring` |
| CSP の違反の急増、`invalid_transaction` の急増 | `login-page-anomaly.md`（リリースの誤りか攻撃か、Cookie の属性、エッジのキャッシュ） | E4 で作成 | E4 `identifier-and-password-screens` |
| テナントのテーマ・文言の誤りで画面が使えない、規約の新しいバージョンで再同意が大量に出た | `tenant-branding-rollback.md` | E4 で作成 | E4 `branding-and-locales` |
| リフレッシュトークンの再利用の急増 | `refresh-reuse-spike.md`（SDK の並行の誤検知と盗用の見分け） | E5 で作成 | E5 `refresh-token-grant` |
| Back-Channel Logout の待ち行列の滞留 | `backchannel-logout-backlog.md` | E5 で作成 | E5 `backchannel-logout-delivery` |
| テナント・ユーザーの全セッションの緊急の取り消し | `mass-session-revocation.md` | E5 で作成 | E5 `session-management-api` |
| Valkey の障害の後のセッションのキャッシュの確認 | `session-cache-inconsistency.md` | E5 で作成 | E5 `session-store-and-cookie` |
| ソーシャル接続の失敗（接続の種類別の成功率の低下）、IdP の仕様の変更 | `social-idp-outage.md` | E6 で作成 | E6 `social-common-client` |
| テナントの Apple の `.p8` の失効・漏えい | `apple-key-compromise.md`（`external_idp_keys` の入れ替え、キャッシュの破棄） | E6 で作成 | E6 `signer-external-idp-assertions` |
| 誤ったリンクの復旧の依頼 | `wrong-link-recovery.md` | E6 で作成 | E6 `account-linking-api` |
| MFA を失った利用者の回復（テナントの管理者向けの本人確認の雛形）、MFA の失敗率の急増、`webauthn.sign_count_regression` の急増、カスタムドメインの変更でパスキーが使えない | `mfa-recovery-and-anomalies.md` | E7 で作成 | E7 `authenticators-and-policy` |
| 誤ブロックの大量の発生（特定の携帯の回線、イベントの集中）、利用者からの「ブロックされた」の問い合わせ | `false-block-surge.md`（`monitor` への切り替え、一括の解除、閾値の見直し） | E8 で作成 | E8 `monitor-mode-and-notifications` |
| 漏えいしたパスワードの照合の時限切れ・飛ばした件数の増加、データの取り込みの失敗・バージョンが 45 日を超えて古い | `breached-password-check.md`（公式の range API の障害と、自前のホストの前のバージョンでの運転） | E8 で作成 | E8 `breached-password-on-login` |
| 大口のテナントの検索が reader を圧迫 | `search-overload.md`（検索の枠の一時的な引き下げ） | E9 で作成 | E9 `user-search-language` |
| 管理用のテナントのログインの失敗の急増 | `dashboard-break-glass.md`（非常用のトークンの発行、2 人の承認） | E9 で作成（E12 で訓練） | E9 `dashboard-token-and-roles`、E12 `break-glass-cli` |
| 管理用のテナントの設定の変更 | `admin-tenant-change.md`（IaC と 2 人のレビュー） | E1 で作成 | E1 `admin-tenant-iac` |
| ログの反映の遅れ（p95 30 秒を 15 分超） | `log-ingest-lag.md` | E10 で作成 | E10 `log-sli` |
| ログストリームの `disabled` の急増 | `log-stream-disabled.md` | E10 で作成 | E10 `log-stream-webhook` |
| ログのパーティションの作成・`DROP` の失敗 | `log-partition-maintenance.md` | E10 で作成 | E10 `log-retention-and-pseudonymization` |
| 証明書の更新の失敗（期限の 30 日前）、ドメインの `suspended`、`/.well-known` が別のテナントを返す | `custom-domain-incidents.md`（取り違えの疑いはドメインを止めて調べる） | E11 で作成 | E11 `custom-domain-monitoring` |
| ドメインの所有の争いの申し立て | `domain-ownership-dispute.md`（法務への連絡） | E11 で作成 | E11 `custom-domain-core` |
| 配信のテナントの上限への接近（8 割） | `edge-quota.md` | E11 で作成 | E11 `custom-domain-monitoring` |
| テナントの独自の送信ドメインの `degraded` | `sending-domain-degraded.md` | E11 で作成 | E11 `tenant-sending-domains` |
| シークレットスキャンのパートナーからの通知（本システムの接頭辞のトークンの公開） | `secret-leak.md` | E12 で作成 | E12 `secret-scanning-partner` |
| 期限を過ぎた運用者の権限 | `operator-access.md`（JIT の申請・承認・当番） | E12 で作成 | E12 `operator-access-jit` |
| 特定のテナントの上限の変更（緩和・引き締め）の申請 | `rate-limit-override.md` | E12 で作成 | E12 `rate-limit-overrides-and-review` |
| エンドユーザーからの削除・開示の請求（テナントへの案内、運用者が代わりに行う場合） | `data-subject-requests.md`（法務の L7 の後） | E12 で作成 | E12 `disclosure-api-and-l7` |
| Actions の基盤のスロットリング・エラーの急増 | `actions-platform-degraded.md`（`deny` のテナントへの影響、上限の引き上げ） | E13 で作成 | E13 `actions-invoker` |
| 悪性のパッケージの発見 | `actions-malicious-package.md`（該当のバージョンのテナントの特定と配備の停止） | E13 で作成 | E13 `actions-build` |
| 1 テナントの Action が同時実行を使い切る | `actions-tenant-runaway.md` | E13 で作成 | E13 `actions-invoker` |
| 誤ったメンバーシップの付与（自動の付与の設定の誤り） | `organization-membership-incident.md` | E14 で作成 | E14 `organization-connections` |
| LDAP のコネクタの全停止（接続の失敗の急増） | `ldap-connector-outage.md` | E14 で作成 | E14 `ldap-connector` |

### 4.1 領域との対応

各領域の文書に対して、運用で見る指標と手順の置き場所。

| 領域 | アラート・手順 |
| --- | --- |
| [authentication-flows.md](../architecture/authentication-flows.md) | 認証の経路の SLO、コードの再利用（`code-reuse-spike.md`）、リフレッシュの再利用（`refresh-reuse-spike.md`）、適合試験の失敗（`conformance-regression.md`） |
| [universal-login.md](../architecture/universal-login.md) | 画面の表示の p99、CSP の違反・`invalid_transaction`（`login-page-anomaly.md`）、テーマの誤り（`tenant-branding-rollback.md`） |
| [connections.md](../architecture/connections.md) | ソーシャル IdP（`social-idp-outage.md`）、Apple の鍵（`apple-key-compromise.md`） |
| [users-and-profiles.md](../architecture/users-and-profiles.md) | 誤ったリンク（`wrong-link-recovery.md`）、検索（`search-overload.md`）、請求（`data-subject-requests.md`） |
| [mfa-and-passkeys.md](../architecture/mfa-and-passkeys.md) | `mfa-recovery-and-anomalies.md` |
| [attack-protection.md](../architecture/attack-protection.md) | クレデンシャルスタッフィング（[incident-response.md](incident-response.md)）、誤ブロック（`false-block-surge.md`）、漏えいしたパスワード（`breached-password-check.md`） |
| [sessions-and-sso.md](../architecture/sessions-and-sso.md) | Back-Channel Logout（`backchannel-logout-backlog.md`）、一括の取り消し（`mass-session-revocation.md`）、キャッシュ（`session-cache-inconsistency.md`） |
| [tenants-and-applications.md](../architecture/tenants-and-applications.md) | 設定の反映（`config-propagation-lag.md`）、秘密の漏えい（`leaked-client-secret.md`）、停止（`tenant-suspend-and-restore.md`） |
| [management-api-and-rate-limiting.md](../architecture/management-api-and-rate-limiting.md) | 管理の経路の SLO、429（`rate-limit-spike.md`・`rate-limit-override.md`）、計数の失敗（`ratelimit-backend-down.md`） |
| [dashboard.md](../architecture/dashboard.md) | 非常用の経路（`dashboard-break-glass.md`）、管理用のテナント（`admin-tenant-change.md`） |
| [custom-domains.md](../architecture/custom-domains.md) | `custom-domain-incidents.md`、`domain-ownership-dispute.md`、`edge-quota.md` |
| [email-delivery.md](../architecture/email-delivery.md) | `email-delivery-failure.md`、`email-reputation.md`、`sending-domain-degraded.md` |
| [logs-and-streams.md](../architecture/logs-and-streams.md) | `log-ingest-lag.md`、`log-stream-disabled.md`、`log-partition-maintenance.md`、秘密の混入の疑い（[incident-response.md](incident-response.md) の「秘密の出力」） |
| [keys-and-secrets.md](../architecture/keys-and-secrets.md) | [emergency-key-rotation.md](emergency-key-rotation.md)、`signer-compromise.md`、`pepper-recovery.md`、`jwks-publication-stale.md`、`kms-outage.md` |
| [extensibility.md](../architecture/extensibility.md) | `actions-platform-degraded.md`、`actions-malicious-package.md`、`actions-tenant-runaway.md` |
| [organizations.md](../architecture/organizations.md) | `organization-membership-incident.md` |
| [security.md](../architecture/security.md) | [incident-response.md](incident-response.md)、`secret-leak.md`、`operator-access.md` |
| [infrastructure.md](../architecture/infrastructure.md)、[capacity.md](../architecture/capacity.md) | [disaster-recovery.md](disaster-recovery.md)、キャパシティの見直し（5 節） |
| [delivery.md](../architecture/delivery.md) | [deploy-and-rollback.md](deploy-and-rollback.md) |
| [observability.md](../architecture/observability.md) | アラートの条件の正本の実装側（5.2 節） |
| [data-model.md](../architecture/data-model.md) | 索引のみ。運用の対象は各領域の文書で扱う |

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| PITR からの復元訓練 | 四半期 | [disaster-recovery.md](disaster-recovery.md) の E |
| 計画外のフェイルオーバーと失った範囲のやり直しの訓練（staging） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の E（合格基準は [quality.md](../quality.md) の 2.4 節） |
| 本番の switchover（大阪でログインとトークンの発行を受けて戻す） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の E |
| 大阪の待機の構成の確認 | 月次（合成監視は 1 分ごと、plan の差分と KMS のレプリカは日次） | [disaster-recovery.md](disaster-recovery.md) の E、[infrastructure.md](../architecture/infrastructure.md) の 6.5 節 |
| KMS の鍵のレプリカからの復旧（staging） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の E |
| 1 テナントの緊急のローテーション（staging の監視用のテナント） | 四半期 | [emergency-key-rotation.md](emergency-key-rotation.md) の 4（[ADR-0046](../decisions/0046-signing-key-lifecycle.md)） |
| 全テナントの緊急のローテーション、KMS が使えないときの失効とキルスイッチ（staging） | 年 1 回 | [emergency-key-rotation.md](emergency-key-rotation.md) の 4 |
| pepper の復旧（Secrets Manager の秘密を消した状態からアーカイブで） | 四半期（staging） | `pepper-recovery.md`（E1、[ADR-0045](../decisions/0045-kms-key-hierarchy.md)） |
| 非常用の経路（管理用のテナントの接続を壊した状態から直す） | 年 2 回（staging） | `dashboard-break-glass.md`（[ADR-0037](../decisions/0037-break-glass-and-admin-roles.md)） |
| 縮退の表の障害の注入（Aurora の writer、Valkey、SQS、KMS、漏えいしたパスワードの range API） | 四半期（staging） | [ADR-0005](../decisions/0005-authentication-path-availability.md) の Confirmation |
| 管理の経路の全停止で認証の経路が続くことの確認 | 四半期（staging） | [ADR-0057](../decisions/0057-accounts-network-and-path-separation.md) の Confirmation |
| 東京の S3 のオリジンを止め、JWKS が大阪から返ることの確認 | 四半期 | [ADR-0058](../decisions/0058-edge-and-custom-domains.md) の Confirmation |
| K5 の模擬のクレデンシャルスタッフィング | 四半期（staging）と E8・E12 | [quality.md](../quality.md) の 2.2.1 節 |
| WAF の Challenge への切り替えの訓練 | 年 1 回（E12 から） | [incident-response.md](incident-response.md) の「クレデンシャルスタッフィングの波」 |
| 大阪の SES への切り替え、予備の SES のアカウントへの切り替えの確認 | 年 1 回（staging） | `email-delivery-failure.md`（E4） |
| 負荷試験（L1〜L3。大きなイベントの前は 2 倍を 1 時間） | 半年ごと、リリース前、大きな変更の後 | [capacity.md](../architecture/capacity.md) の 5・6 節 |
| キャパシティの見直し（ログイン/秒、トークン/秒、ハッシュの待ち行列、Signer の CPU、writer の CPU、KMS の使用率） | 月次（予測は四半期） | [capacity.md](../architecture/capacity.md) の 6 節 |
| 適合試験（`main` の全プロファイル） | 夜間 | [delivery.md](../architecture/delivery.md) の 4 節 |
| 秘密の走査の健全さ（合成の秘密） | 日次 | [observability.md](../architecture/observability.md) の 4.3 節 |
| 監査ログのハッシュの連鎖の検証 | 日次 | [ADR-0054](../decisions/0054-audit-log.md) |
| テナントの境界の監査 | 日次 | [quality.md](../quality.md) の 4.2 節 |
| カスタムドメインの TXT・CNAME・証明書の期限の確認 | 日次（ドメインごとに 24 時間） | [custom-domains.md](../architecture/custom-domains.md) の 3.2 節 |
| 漏えいしたパスワードのデータの取り込み（自前のホストの後） | 月次 | [attack-protection.md](../architecture/attack-protection.md) の 5.2 節 |
| 運用者のアクセスのレビュー、期限を過ぎた割り当ての確認 | 四半期（期限の確認は週次） | [ADR-0056](../decisions/0056-operator-access.md) |
| 合成監視の資格情報、CloudFront → ALB の秘密のヘッダーのローテーション | 90 日 | [observability.md](../architecture/observability.md) の 6 節、[security.md](../architecture/security.md) の 7 節 |
| インシデント対応の机上訓練（署名鍵の漏えいを想定） | 年 1 回 | [incident-response.md](incident-response.md) |
| 外部のペンテスト | E12 と、その後は年 1 回と大きな変更の後 | [security.md](../architecture/security.md) の 10 節 |
| Actions の隔離のテスト（本番の監視用のテナント） | 日次（E13 から） | [extensibility.md](../architecture/extensibility.md) の 10 節 |
| 訓練の記録の見直し（目標の未達を Intent へ） | 四半期 | 各 runbook の「訓練の記録」 |

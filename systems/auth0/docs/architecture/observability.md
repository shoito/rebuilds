# Observability: Auth0

ログ・メトリクス・トレース、認証の経路の SLI の計測、秘密を出さない計装、アラートと runbook の対応、合成監視。道具は他の題材（Slack の ADR-0021）を引き継ぐ：OpenTelemetry（ADOT）→ AMP・X-Ray・CloudWatch Logs、Grafana で横断。SLO の値とアラートの一覧の正本は Ops の [runbooks/README.md](../runbooks/README.md) に置き、ここにはそれを計測する仕組みを書く。テナントに見せる認証のイベントのログ（検索、ログストリーム）は [logs-and-streams.md](logs-and-streams.md) の領域で、ここは本システムの運用のためのテレメトリーである。

| 関連 | 決定 |
| --- | --- |
| [ADR-0061](../decisions/0061-secret-free-telemetry.md) | 秘密を出さない計装（型、Collector、アクセスログ、走査） |
| [ADR-0062](../decisions/0062-sli-and-synthetic-monitoring.md) | SLI の数え方と合成監視 |
| [ADR-0054](../decisions/0054-audit-log.md) | 監査ログ |
| [ADR-0005](../decisions/0005-authentication-path-availability.md) | 認証の経路の定義と縮退 |

## 1. 全体の流れ

```
 prod：auth / signer / mgmt / relay / worker / worker-egress
        │ OTLP（各タスクの ADOT Collector のサイドカー。属性の許可リストで落とす：ADR-0061 の (2)）
        ├─ traces  ─▶ X-Ray
        ├─ metrics ─▶ AMP
        └─ logs    ─▶ CloudWatch Logs ─▶ 走査の Lambda（秘密の形：4.3 節）
                                       └▶ Firehose ─▶ log-archive の S3（Object Lock）

 edge：CloudFront のリアルタイムのログ ─▶ Kinesis Data Streams ─▶ 集計の Lambda ─▶ AMP（SLI の正本：3.2 節）
       CloudFront の標準のログ（v2。クエリ文字列と Cookie を外す）─▶ log-archive
       WAF のログ（Block・Count だけ。伏せる設定）─▶ log-archive
 AWS：CloudTrail・Config ─▶ log-archive。KMS の操作のアラート（5.2 節）

 Grafana（shared）：AMP・CloudWatch・X-Ray を読む
 アラート：AMP のルール → Alertmanager → SNS → オンコール。AWS のリソースは CloudWatch アラーム → SNS
```

- **Signer のテレメトリーも同じ流れに乗る。** Signer から外へ出る経路は VPC エンドポイント（CloudWatch Logs、X-Ray）だけ（[ADR-0059](../decisions/0059-signer-isolation.md)）。Signer の Collector は、属性の許可リストをさらに狭くする（`tenant_id`、`kid`、`alg`、処理時間、結果だけ）。

## 2. 計装

- 計装は開発リポジトリの `packages/telemetry` に集め、ログのイベントの型と、スパンの属性の名前を定数で定義する（他の題材と同じ）。
- 共通の属性：`service.name`、`service.version`、`deployment.environment`、`cloud.region`、`cloud.availability_zone`、`tenant.id`（3.4 節の規則）、`tenant.environment`（`development`・`staging`・`production`）、`auth.path`（`auth`・`mgmt`）。
- ドメインのスパンを手で足す：テナントの解決、攻撃の防御の判定、Argon2id（待ち行列の待ちと計算を分ける）、Signer の呼び出し、接続の部品（ソーシャル IdP の呼び出しは外部の待ちとして別のスパン）、MFA の検証、outbox の書き込み。
- **外部の待ちを独立したスパンにする。** NFR-002 の「外部の IdP とメールの待ちを除く」処理時間は、`idp.call` のスパンを差し引いて求める。

### 2.1 秘密を出さない

[ADR-0061](../decisions/0061-secret-free-telemetry.md) の要点。4 か所で防ぐ。

| 層 | 仕組み |
| --- | --- |
| (1) アプリ | 秘密は `Secret<T>` の型（`toString`・`toJSON` は `[REDACTED]`）。ロガーは型付きのイベントだけを受ける。HTTP の自動計装は `url.full`・`url.query`・ヘッダーを付けず、`url.path` をルートの型にする。OAuth のエラーの本文は定型の文だけ |
| (2) Collector | 許可リストにない属性のキーを削除する |
| (3) AWS のアクセスログ | 認証の経路の ALB のアクセスログは無効。CloudFront のログからクエリ文字列と Cookie を外す。WAF のログはクエリ文字列・`Authorization`・`Cookie` を伏せる |
| (4) 走査 | 全ロググループを購読のフィルターで走査し、秘密の形を見つけたら呼び出す（4.3 節） |

出してよい識別子と、出さないもの：

| 出してよい | 出さない（運用のテレメトリー） |
| --- | --- |
| `tenant_id`、`client_id`、`user_id`、`connection_id`、`kid`、リフレッシュトークンの系列の ID、`session` の ID のハッシュの先頭 8 文字、要求の ID、グラントの種類、エラーのコード（`invalid_grant` など）、IP の /24 | パスワード、認可コード、アクセス・リフレッシュ・ID トークン、クライアントシークレット、`client_assertion`、`code_verifier`、TOTP の種とコード、メールの OTP、リカバリーコード、セッションの ID、署名の秘密鍵、pepper、メールアドレス、電話番号、完全な IP |

- メールアドレスと完全な IP は、テナントの認証のイベントのログ（logs-and-streams の領域）には入る。運用のテレメトリーには入れない。調査でユーザーを特定したいときは `user_id` で引く。

### 2.2 トレースの伝播

| 境界 | 運び方 |
| --- | --- |
| 利用者 → Auth・mgmt | 外部の `traceparent` を受け付けない（外部の値を信頼しない）。サーバーが始め、要求の ID と結びつける |
| Auth → Signer、mgmt → Signer | `traceparent` ヘッダー（相互 TLS の中） |
| Auth・mgmt → outbox → Relay → SQS → Worker | outbox の行の `trace_context` 列、SQS のメッセージの属性（他の題材と同じ） |
| ブラウザの画面の遷移（`/authorize` → `/u/login` → コールバック） | ログインのトランザクションの ID をスパンの属性にし、同じトランザクションの複数の要求を結ぶ（トランザクションの ID は秘密ではない。Cookie の値とは別の ID にする） |

### 2.3 サンプリング

- 先頭でのサンプリング。既定は 5%。エラーと、1 秒を超えた要求は、末尾のサンプリングで残す（Collector のゲートウェイで行う）。
- 合成監視のテナントと、Ops が一時的に指定したテナントは 100%。
- 捨てた要求でも、ログには `trace_id` と要求の ID を入れる。

## 3. メトリクスと SLI

### 3.1 種類

| 種類 | 対象 | 主な指標 |
| --- | --- | --- |
| RED | 全サービス | 要求数、エラー数、処理時間のヒストグラム（ルートの型ごと） |
| USE | Aurora、Valkey、ECS、SQS、ALB、NAT、KMS | 使用率、飽和（接続、ロック待ち、複製の遅延、キュー）、エラー、スロットリング |
| 認証 | auth | ログインの結果（成功・資格情報の誤り・ブロック・MFA の要求・エラー）、接続別の成功率、トークンの発行（グラント別）、`invalid_grant` の理由、リフレッシュトークンの再利用の検知の件数 |
| CPU の重い処理 | auth、signer | ハッシュの待ち行列の長さと待ち時間、ハッシュの計算時間、503 の件数（上限の超過）。署名の件数と時間（`alg` 別）、鍵のキャッシュのヒット率と KMS の `Decrypt` の件数 |
| 攻撃 | auth、WAF | WAF の Block・Challenge（ルール別）、攻撃の防御のブロック（種類別）、漏えいしたパスワードの検出、ログインの失敗の率（テナント別） |
| 配信 | relay、worker | outbox の遅れ、ログの反映の遅れ（NFR-010）、Back-Channel Logout の失敗、JWKS の書き出しの遅れ |

### 3.2 認証の経路の SLI

[ADR-0062](../decisions/0062-sli-and-synthetic-monitoring.md) の要点。**正本は CloudFront のリアルタイムのログから数えたもの。** サーバーの計測は原因を分けるために使う。

| SLI | 定義 | 計測 | 目標（案。正本は runbooks） |
| --- | --- | --- | --- |
| 認証の経路の可用性（NFR-001） | ADR-0005 の定義のエンドポイントへの、本番のテナントの要求のうち、失敗でないものの割合。分類は下の表 | エッジ（CloudFront のリアルタイムのログ → 集計） | 99.99%（30 日） |
| ログインの処理時間（NFR-002） | パスワードの送信から応答まで（外部の IdP・メールの待ちを除く） | auth の `login_submit_duration_seconds` から `idp.call` を引いたもの | p99 500ms |
| ログインの画面の表示（NFR-002） | `/authorize` からログインの画面の表示まで | auth と エッジ | p99 300ms |
| トークンの発行（NFR-003） | `/oauth/token` の処理時間（Signer を含む） | auth | p99 150ms |
| 管理の経路の可用性（NFR-004） | Management API の要求のうち、5xx とタイムアウトでないもの | エッジ | 99.9%（30 日） |
| 管理の経路の処理時間（NFR-004） | 一覧・検索・ログを除く Management API | mgmt | p99 500ms |
| ログの反映（NFR-010） | イベントから、ログの検索に出るまで | worker | p95 30 秒 |
| DR の複製の遅延 | `AuroraGlobalDBRPOLag` | CloudWatch | 10 秒以内（[infrastructure.md](infrastructure.md) の 6.3 節） |

応答の分類（ADR-0062）：

| 応答 | 可用性の数え方 |
| --- | --- |
| 2xx、3xx | 成功 |
| 400・401・403（OAuth のエラー、ログインの失敗、攻撃の防御・WAF のブロック） | 成功 |
| 429（テナントのレート制限、攻撃の防御。内部のヘッダーで理由が `policy`） | 成功 |
| 429・503（過負荷、ハッシュの同時実行の上限、writer のフェイルオーバー中。理由が `capacity`・`dependency`） | 失敗 |
| 5xx、オリジンのタイムアウト、CloudFront の 502・504 | 失敗 |
| 上限を超えた応答時間（`/oauth/token` 5 秒、ログインの送信 10 秒） | 失敗 |

- **ログインの失敗は、可用性を消費しない。** ただし、ログインの成功率が急に下がるのは、エラーにならない障害（照合の誤り、接続の障害）の兆候なので、平常との差で見る（3.3 節）。
- 本番のテナントだけを対象にする。`tenant.environment` はホスト名 → テナントの対応表で付ける。
- テナントごとの可用性も記録し、SLA の報告と大口のテナントのサポートに使う（SLO にはしない）。

### 3.3 平常との差で見る指標

固定のしきい値では見られないもの：

- **ログインの成功率**（全体、接続別、テナント別）：過去 4 週の同じ曜日・時間帯と比べる。全体で 5 ポイント以上の低下が 10 分続いたら呼び出す。1 テナントだけの低下はチケット（テナントの設定の変更か、そのテナントへの攻撃）。
- **ログインの試行の数**：全体で平常の 5 倍、または 1 テナントで平常の 20 倍かつ失敗の率が 80% を超えたら、クレデンシャルスタッフィングの波を疑う（[runbooks/incident-response.md](../runbooks/incident-response.md)）。
- **ソーシャル接続の成功率**（接続の種類別）：外部の IdP の障害の検知。
- **リフレッシュトークンの再利用の検知**：平常の 3 倍（クライアントの不具合か、ローテーションの誤り、トークンの盗用）。

### 3.4 テナントのラベル

他の題材と同じ規則にする。

- `tenant_id` は、上位 N 件（初期値 200）＋「その他」。付けるのは、要求数、エラー数、ログインの結果、トークンの発行、攻撃の防御のブロックだけ。
- `client_id`・`user_id` はラベルにしない（ログとトレースで引く）。
- 値の少ない属性（`grant_type`、`connection_strategy`、`outcome`、`error_code`、`alg`、`tenant.environment`）は常にラベルにする。

## 4. ログ

### 4.1 共通の形

1 行 1 JSON の構造化ログ。項目は許可リスト方式で、定義していない項目は出さない（ADR-0061）。

| 項目 | 内容 |
| --- | --- |
| `ts`、`level`、`event`、`service`、`version`、`env`、`region`、`az` | どこで、いつ、何の事象か（`event` は定数の型の名前） |
| `trace_id`、`span_id`、`request_id`、`login_tx_id` | 追跡 |
| `tenant_id`、`tenant_env` | テナント |
| `client_id`、`user_id`、`connection_id`、`grant_type`、`kid`、`rt_family_id` | 認証（識別子だけ） |
| `route`、`status`、`duration_ms`、`error_code`、`reason` | HTTP（`route` はルートの型。URL は出さない） |
| `ip_prefix`、`ua_family` | 端末（IP は /24、ユーザーエージェントは種類だけ） |

### 4.2 保持

| データ | すぐに使える場所 | 保管 |
| --- | --- | --- |
| アプリのログ | CloudWatch Logs 30 日 | log-archive 13 か月（[security.md](security.md) の 9 節） |
| CloudFront・WAF のログ | S3＋Athena 30 日 | log-archive 13 か月（WAF のログにクエリ文字列が残るなら 7 日。ADR-0061） |
| 監査ログ | Aurora 1 年 | log-archive 7 年（既定案。法務の L5） |
| CloudTrail、Config、VPC フローログ | S3＋Athena 90 日 | log-archive 13 か月 |
| メトリクス | AMP 150 日 | 保管しない |
| トレース | X-Ray 30 日 | 保管しない |

### 4.3 秘密の形の走査

- 全ロググループに購読のフィルターで走査の Lambda をつなぐ。探す形：
  - JWT（`eyJ` で始まり、`.` で区切った 3 つの Base64URL）
  - 本システムの接頭辞（`<brand>_rt_` などのリフレッシュトークン・シークレットの形。[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)）
  - PHC 形式のハッシュ（`$argon2id$`、`$2a$`・`$2b$`・`$2y$`）
  - JSON のキー `password`・`client_secret`・`code_verifier`・`refresh_token`・`otp` に値が付いたもの
  - PEM の秘密鍵の見出し（`PRIVATE KEY`）
- 見つけたら呼び出す（SEV2。ログの場所と件数だけを通知し、値は通知に入れない）。
- **走査が止まっていないことを確かめる。** 1 日 1 回、合成の秘密（本物ではない、形だけの値）を専用のロググループに書き、検出されることを確かめる。検出されなければ呼び出す。
- CloudWatch Logs のデータ保護ポリシーを補助として使う（メールアドレスなどの管理されたデータの識別子）。
- 漏れたものは [runbooks/incident-response.md](../runbooks/incident-response.md) の「秘密の出力」に従う。

### 4.4 アクセス

- アプリのログ（秘密と個人データを含まない）とメトリクスは、Ops と許可した Dev の常設の読み取り（[ADR-0056](../decisions/0056-operator-access.md)）。
- CloudFront・WAF のログ（IP の全体を含む）と監査ログは、期限つきの権限で読む。
- AI エージェントは本番のテレメトリーへの経路を持たない。

## 5. SLO とアラート

### 5.1 バーンレート

他の題材と同じマルチウィンドウのバーンレートを使う。NFR-001 の 99.99% は、30 日のエラーバジェットが約 4.3 分しかない。

| 重さ | 長い窓 | 短い窓 | バーンレート |
| --- | --- | --- | --- |
| 呼び出し | 1 時間 | 5 分 | 14.4 |
| 呼び出し | 6 時間 | 30 分 | 6 |
| チケット | 3 日 | 6 時間 | 1 |

- 99.99% では、バーンレートより、**合成監視と症状のアラート（5 分間の認証の経路の失敗の率が 0.5% を超える）が先に鳴る**ことが多い。両方を置く。
- すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する。他の題材と同じ）。

### 5.2 アラートの一覧と runbook

手順の列は、今ある runbook と、各 Epic で作る runbook を指す。個別の runbook ができるまでは [incident-response.md](../runbooks/incident-response.md) の該当の節で対応する。

| アラート | 条件 | 重さ | 手順 |
| --- | --- | --- | --- |
| 認証の経路の SLO の速いバーンレート | 5.1 節 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 認証の経路の失敗の率 | 5 分間で 0.5% を超える | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 合成監視の連続失敗 | 2 回続けて失敗（6 節） | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| ログインの成功率の低下 | 3.3 節 | 呼び出し（全体）・チケット（1 テナント） | [incident-response.md](../runbooks/incident-response.md) |
| クレデンシャルスタッフィングの兆候 | 3.3 節 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) の「クレデンシャルスタッフィングの波」 |
| ハッシュの待ち行列の飽和 | 503（`capacity`）が 1 分に 100 件を超える、または待ちの p99 が 200ms | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| Signer の失敗 | 署名の 5xx が 0.1% を超える、または Signer の健全なタスクが 1 AZ で 0 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| KMS のスロットリング・到達不能 | `ThrottlingException` が 1 件以上、または `Decrypt` の失敗が続く | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| **署名鍵の KMS の鍵の操作** | キーポリシーの変更、無効化、削除の予約、Signer 以外のプリンシパルの `Decrypt` の試み（CloudTrail） | 呼び出し（SEV2 から） | [incident-response.md](../runbooks/incident-response.md) の「署名鍵の漏えいの疑い」 |
| 秘密の出力の検出 | 4.3 節の走査で 1 件以上 | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) の「秘密の出力」 |
| 秘密の走査の停止 | 合成の秘密が検出されない | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| シークレットスキャンのパートナーからの通知 | 本システムの接頭辞のトークンの公開の検知 | 呼び出し（営業時間外も） | `secret-leak.md`（E12） |
| リフレッシュトークンの再利用の急増 | 3.3 節 | チケット（全体で 10 倍なら呼び出し） | `refresh-reuse-spike.md`（E5） |
| ソーシャル接続の失敗 | 接続の種類別に、成功率が 5 分間で平常の半分 | チケット（30 分で呼び出し） | `social-idp-outage.md`（E6） |
| メールの送信の失敗・遅れ | 送信の失敗が 5%、または送信の遅れの p95 が 5 分 | 呼び出し | `email-delivery-failure.md`（E4） |
| outbox の遅れ | 最古の行が 30 秒を超える | 呼び出し | `relay-backlog.md`（E1） |
| ログの反映の遅れ | NFR-010 の p95 30 秒を 15 分超える | チケット | `log-ingest-lag.md`（E10） |
| JWKS の書き出しの遅れ | 鍵の状態の変化から S3 への反映が 60 秒を超える | 呼び出し | [emergency-key-rotation.md](../runbooks/emergency-key-rotation.md) |
| DR の複製の遅延 | `AuroraGlobalDBRPOLag` が 10 秒を 5 分超える | 呼び出し | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 大阪の待機の構成の異常 | 大阪の合成監視の失敗、大阪の Signer の鍵の読み込みの失敗 | チケット（30 分で呼び出し） | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| デプロイ中の自動ロールバック、フラグのガード | [delivery.md](delivery.md) の 5.2・6 節 | 呼び出し | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| 監査ログのハッシュの連鎖の検証の失敗 | 日次のジョブ | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) |
| 期限を過ぎた運用者の権限 | 期限つきの権限の割り当てが残る | 呼び出し | `operator-access.md`（E12） |
| 重要なセキュリティの仕組みの失敗 | GuardDuty・CloudTrail・WAF のログ・走査の Lambda の停止 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |

呼び出しのアラートは、SLO か、セキュリティ（鍵、秘密、攻撃）の症状に限る。原因の側の指標（CPU など）はチケットとダッシュボードにとどめる。

## 6. 合成監視

CloudWatch Synthetics のカナリアを、大阪から東京へ実行する（大阪へ切り替えた後は、東京から大阪へ）。本番の監視用のテナント（`environment = production`）を使う。

| シナリオ | 頻度 |
| --- | --- |
| `/authorize` → パスワードのログイン → コードの交換 → userinfo | 1 分 |
| パスキーのログイン（仮想の認証器） | 5 分 |
| リフレッシュ（ローテーションを含む） | 1 分 |
| クライアントクレデンシャル | 1 分 |
| discovery・JWKS の取得と、発行した ID トークンの検証 | 1 分 |
| RP-Initiated Logout → Back-Channel Logout の受信（監視用の受け口） | 5 分 |
| カスタムドメインの監視用のテナントで、ログイン → 交換 | 1 分 |
| Management API（M2M のトークン → テナントの設定の取得） | 1 分 |
| 大阪の ALB へ直接（待機の構成の健全性） | 1 分 |

- 監視用のユーザーのパスワードと M2M のシークレットは、Secrets Manager に置き、90 日でローテーションする。本物の人の資格情報を使わない。
- 監視用のテナントは、攻撃の防御の対象から外さない（外すと防御の誤りに気づけない）。代わりに、監視の送信元 IP を WAF の許可リストに入れる（[infrastructure.md](infrastructure.md) の 4.3 節）。

## 7. ダッシュボード

| ダッシュボード | 主な中身 | 見る人 |
| --- | --- | --- |
| SLO | 3.2 節の SLI、バジェットの残り、バーンレート | 全員 |
| 認証 | ログインの結果、接続別の成功率、グラント別のトークンの発行、`invalid_grant` の理由、再利用の検知 | Ops、Dev |
| CPU の重い処理 | ハッシュの待ち行列、Signer の署名の時間、鍵のキャッシュ、KMS | Ops |
| 攻撃 | WAF のルール別の件数、攻撃の防御のブロック、テナント別の失敗の率の上位、ATP のラベル（使う場合） | Ops、セキュリティの担当 |
| 配信 | outbox、ログの反映、Back-Channel Logout、JWKS の書き出し | Ops |
| DR | 複製の遅延、大阪の待機の構成の健全性 | Ops |
| セキュリティ | 秘密の走査の結果、KMS の操作、運用者の権限の割り当て、監査ログの連鎖の検証 | Ops、セキュリティの担当 |

## 8. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | `packages/telemetry`（型付きのイベント、`Secret<T>`）、Collector の許可リスト、走査の Lambda と合成の秘密、ALB・CloudFront・WAF のログの設定、アラートと runbook の注釈の CI |
| E3 | エッジの SLI の集計（リアルタイムのログ）、合成監視（ログイン・リフレッシュ・クライアントクレデンシャル・JWKS） |
| E8 | 攻撃のダッシュボード、クレデンシャルスタッフィングの兆候のアラート |
| E10 | ログの反映の SLI |
| E12 | SLO の確定、アラートの調整、DR のダッシュボード |

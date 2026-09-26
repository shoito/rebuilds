# Logs and Streams: Auth0

テナントに見せる認証のイベントのログ（イベントの種類とコード、保存と検索、保持）と、ログストリーム（Webhook、Amazon EventBridge）の設計。決定は [ADR-0042](../decisions/0042-log-event-model-and-type-codes.md)（イベントの形と種類のコード）、[ADR-0043](../decisions/0043-log-storage-and-search.md)（保存・検索・保持）、[ADR-0044](../decisions/0044-log-stream-delivery.md)（ログストリームの配信）にある。

この文書のログは、テナントが見る「認証のイベント」である。本システムの運用のテレメトリーは [observability.md](observability.md)、管理の操作の監査ログは [ADR-0054](../decisions/0054-audit-log.md) にある。

本家の振る舞いは、2026-09-27 に auth0.com/docs、Management API の OpenAPI、本家が公開するログのスキーマ（[auth0/auth0-log-schemas](https://github.com/auth0/auth0-log-schemas)）で確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 認証のイベントの形、種類のコード、出す場所 | 何を「失敗」「ブロック」と判定するか（各領域） |
| 保存、検索（Management API の `/logs`）、保持、削除時の仮名化 | 管理の操作の監査ログ（ADR-0054）、運用のテレメトリー（observability） |
| ログストリーム：Webhook、EventBridge、フィルター、個人データの伏せ字、配信、Health、停止と再開 | 外向きの送信の網の構成（[infrastructure.md](infrastructure.md) の 2.3 節） |
| NFR-010（検索に出るまで p95 30 秒、ストリームの最初の送信 p95 60 秒、少なくとも 1 回） | 法務の論点（intent の L1・L3・L5） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 種類のコード | 短いコード。`s`（ログインの成功）、`f`・`fp`・`fu`（ログインの失敗）、`ss`・`fs`（サインアップ）、`seacft`・`feacft`（認可コードの交換）、`seccft`・`feccft`（クライアントクレデンシャル）、`sertft`・`fertft`（リフレッシュ）、`ferrt`（ローテーションしたリフレッシュトークンの交換の失敗。再利用の検知を含む）、`slo`・`flo`（ログアウト）、`scp`・`fcp`（パスワードの変更）、`sv`（メールの確認）、`limit_wc`・`limit_mu`（IP のブロック）、`pwd_leak`（漏えいしたパスワード）、`sapi`（Management API の書き込みの成功）、`mgmt_api_read`（秘密を返した GET）、`api_limit`、`depnote`、`w`（警告） | [auth0-log-schemas](https://github.com/auth0/auth0-log-schemas)、[Log Stream Filters](https://auth0.com/docs/customize/log-streams/event-filters) |
| 共通のフィールド | `log_id`、`date`、`type`、`description`、`client_id`、`client_name`、`connection`、`connection_id`、`strategy`、`strategy_type`、`ip`、`user_agent`、`user_id`、`user_name`、`hostname`、`organization_id`、`details` など | auth0-log-schemas（`s.schema.json`） |
| 秘密 | OTP、OTP の種、生体の情報、秘密鍵を出さない。アクセストークンを出さない。認可コードは一部だけ（`31XXXXX`） | [PII in Auth0 Logs](https://auth0.com/docs/deploy-monitor/logs/pii-in-logs) |
| 保持 | Starter 1 日、Essentials 5 日、Professional 10 日、Enterprise 30 日。リアルタイムではなく、索引に遅れがありうる | [Log Data Retention](https://auth0.com/docs/deploy-monitor/logs/log-data-retention) |
| 検索 | Lucene の部分集合。フィールドは大文字小文字を区別。フィールドのない語は `client_name`・`connection`・`description`・`ip`・`log_id` だけを探す。検索では 1,000 件まで。チェックポイントは上限なしで、`log_id` の順 | [Log Search Query Syntax](https://auth0.com/docs/deploy-monitor/logs/log-search-query-syntax)、[Retrieve Logs](https://auth0.com/docs/deploy-monitor/logs/retrieve-log-events-using-mgmt-api) |
| ストリームの種類 | 独自の Webhook、Amazon EventBridge、Azure Event Grid、Datadog、Splunk、Sumo Logic、Segment、Mixpanel など | [Log Streams](https://auth0.com/docs/customize/log-streams)、OpenAPI の `LogStream*` |
| 配信 | 少なくとも 1 回。順序は保証しない。1 件ごとに最大 3 回試し、失敗は Health に出し、解決するまで繰り返す。7 日続けて届かないと自動で止める。重要な経路や即時の判断に使わないよう勧める | Log Streams |
| 状態 | `active`、`paused`（利用者が止めた。ログは保持の期間の中で溜め、再開で送る）、`disabled`（連続の失敗で止めた。再開できる）。Health で直近 5 日の最近の 10 件のエラーを見せる | [Check Log Stream Health](https://auth0.com/docs/customize/log-streams/check-log-stream-health) |
| Webhook | HTTPS の URL（自己署名の証明書は不可）、任意の `Authorization`、`Content-Type`、形式（JSON Lines・JSON 配列・JSON オブジェクト）、カテゴリーのフィルター、開始の位置（保持の期間の中の日時） | [Custom Log Streams](https://auth0.com/docs/customize/log-streams/custom-log-streams)、OpenAPI の `LogStreamHttpSink` |
| EventBridge | 利用者の AWS のアカウント ID とリージョンを受け、パートナーのイベントソースを作る | OpenAPI の `LogStreamEventBridgeSink` |
| フィルター | カテゴリー（`auth.login.fail`、`auth.login.success`、`auth.token_exchange.fail`、`management.success`、`user.fail`、`system.notification`、`actions` など 20） | OpenAPI の `LogStreamFilterGroupNameEnum` |
| 個人データの伏せ字 | 名前・メール・電話・住所・ユーザー名のフィールドを、アスタリスクか xxHash にできる | Log Streams |
| 管理者の責任 | ストリームを有効にすると、送った情報の管理者（Controller）はテナント | Log Streams |

EventBridge の側では、パートナーのイベントソースを利用者のイベントバスに結び付けるまで、送ったイベントは捨てられる（[Receiving events from a SaaS partner](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-saas.html)、2026-09-27 に確認）。

## 3. イベント

### 3.1 形

```json
{
  "log_id": "01JQ3Z8K2M0C7F4X9A1B2C3D4E",
  "date": "2026-09-27T03:12:45.123Z",
  "type": "s",
  "description": "Successful login",
  "tenant_name": "example",
  "hostname": "example.jp.<brand>.<domain>",
  "client_id": "Xy12...",
  "client_name": "Example Web",
  "connection": "Username-Password",
  "connection_id": "con_...",
  "strategy": "database",
  "strategy_type": "database",
  "user_id": "usr_4Qz8kP2mX7vN1bR6tY3wLc",
  "user_name": "taro@example.com",
  "ip": "203.0.113.10",
  "user_agent": "Chrome 140.0.0 / Mac OS X 15.6",
  "organization_id": null,
  "details": { "prompts": [...], "session_id": null, "amr": ["pwd", "otp"] },
  "references": { "request_id": "...", "correlation_id": null, "transaction_id": "..." },
  "$event_schema": { "version": "1.0.0" }
}
```

- フィールドの名前と意味は本家の公開のスキーマに寄せる（[ADR-0042](../decisions/0042-log-event-model-and-type-codes.md)）。種類のコードも本家と同じ短いコードを使う（本家の名前を含む識別子ではないので、ADR-0006 に触れない）。
- `details` は種類ごとの Zod のスキーマで検証する。**許可リストのスキーマで、知らないフィールドを落とす。** 秘密（パスワード、コード、トークン、クライアントの秘密、TOTP の種、セッションの ID、メールの確認コード）はスキーマに存在しない（AGENTS.md、[ADR-0061](../decisions/0061-secret-free-telemetry.md)）。認可コードの一部の表示（本家の `31XXXXX`）も出さない。
- `details.session_id` はセッションの ID そのものではなく、セッションの公開の識別子（`sid` のクレームと同じ値）を入れる。
- `user_agent` は解析した短い形にする。元の文字列は持たない。
- `$event_schema.version` を持ち、足す変更だけをする（Management API の版と同じ規則。[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 3.5 節）。

### 3.2 MVP で出す種類

| カテゴリー（フィルター） | コード | 出す場所 |
| --- | --- | --- |
| `auth.login.success` | `s`（ログイン）、`ssa`（`prompt=none` の成功） | Universal Login、`/authorize` |
| `auth.login.fail` | `f`、`fp`（パスワードの誤り）、`fu`（利用者なし）、`fsa`（`prompt=none` の失敗） | 同上 |
| `auth.login.notification` | `w` | 同上 |
| `auth.signup.success`・`.fail` | `ss`、`fs` | データベース接続 |
| `auth.logout.success`・`.fail` | `slo`、`flo`、`oidc_backchannel_logout_succeeded`・`_failed` | `/oidc/logout`、Worker |
| `auth.token_exchange.success`・`.fail` | `seacft`・`feacft`、`seccft`・`feccft`、`sertft`・`fertft`、`ferrt`（再利用の検知）、`sede`・`fede`（デバイスコード）、`srrt`（リフレッシュトークンの失効） | `/oauth/token`、`/oauth/revoke` |
| `user.success`・`.fail`・`.notification` | `scp`・`fcp`（パスワードの変更）、`scpr`・`fcpr`（再設定の要求）、`sv`・`fv`（メールの確認）、`gd_enrollment_complete`・`gd_auth_succeed`・`gd_auth_failed`（MFA）、`du`（削除）、`limit_wc`・`limit_mu`（ブロック）、`signup_pwd_leak`・`pwd_leak`・`reset_pwd_leak`、攻撃の防御の独自のコード（`ap_*`。[attack-protection.md](attack-protection.md) の 8 節） | 各領域 |
| `management.success`・`.fail` | `sapi`、`fapi`、`mgmt_api_read`（秘密を返す GET だけ） | Management API |
| `system.notification` | `api_limit`、`api_limit_warning`、`depnote`、`sys_*`（本システムの保守の告知） | レート制限、版 |
| `actions`（E13） | `actions_execution_failed` | [extensibility.md](extensibility.md) |

- 本家のコードの意味は、本家の公開のスキーマの `description` で確かめた（`fp`・`fu`・`seccft`・`sertft`・`ferrt`・`limit_wc`・`limit_mu`・`pwd_leak`・`sapi`・`mgmt_api_read` など）。`sede`・`fede`・`srrt`・`scpr`・`fcpr` の意味は、名前から推したもので**未検証**。E10 で本家のスキーマの該当のファイルを確かめる。
- MFA の種類のコード（`gd_*`）は、本家の名前の由来（Guardian）はあるが、コードそのものは本家の名前を含まないので使う。
- `sapi`・`fapi` は、監査ログ（ADR-0054）と別に出す。監査ログが正本で、`sapi` は同じ操作をログストリームへ流すための写し。`details` に変更の差分を入れない（秘密の混入を避け、差分は監査ログで見る）。

### 3.3 生成

```
Auth / Management API / Worker
  │ 状態の変化と同じトランザクションで outbox に log_event を INSERT（状態の変化がない失敗は outbox だけ）
  ▼
Relay ─▶ SQS log-ingest（標準キュー）
  ▼
log-ingester（Worker。シャードごとに 1 つの書き手）
  │ 1. 種類ごとのスキーマで検証（落ちたら dead letter と警告。秘密の混入の疑いは破棄）
  │ 2. シャード = hash(tenant_id) mod 64。シャードの書き手が log_id を採番し、まとめて INSERT
  │ 3. 同じトランザクションで log_stream_notify（シャード、最大の log_id）を更新
  ▼
logs（ログの専用の Aurora のクラスタ。日ごとのパーティション）
  ├─▶ Management API の /logs（検索、チェックポイント）
  ├─▶ log-streamer（ストリームごとのカーソルで読んで送る。6 節）
  └─▶ Firehose ─▶ S3（Parquet。本システムの調査用。90 日）
```

- ログの失敗が、ログインを止めない（ADR-0005）。outbox に入れられないとき（writer の切り替え）は、ログインの結果を優先し、ログはタスクのメモリーの小さな送り待ちに入れて SQS へ直接送る（失いうる。件数を計る）。
- 失敗のログイン（`fp` など）は、DB の状態を変えないことが多い。そのときは outbox の INSERT だけの小さなトランザクションにする。攻撃の波で outbox が溢れないよう、攻撃の防御のブロック（`limit_wc` など）と同じ IP・ユーザーの失敗は、1 秒ごとにまとめて 1 件にし、`details.count` を付ける（本家の振る舞いは未検証）。

### 3.4 `log_id`

- **`log_id` は、取り込みの時点に、シャードの唯一の書き手が採番する。** `ingest_ms`（48 ビット）｜`shard`（8 ビット）｜シャードの中の連番（24 ビット）｜乱数（48 ビット）を Crockford base32 で 26 文字にする。
- 1 つのテナントは 1 つのシャードに属するので、テナントの中で `log_id` は **コミットの順に単調に増える**。書き手が 1 つなので、小さい `log_id` が後からコミットされることはない。
- これで、チェックポイント（Management API）とストリームのカーソルが「前へだけ、取りこぼしなし」で働く（[ADR-0042](../decisions/0042-log-event-model-and-type-codes.md)）。本家も、ログの順を生成の時刻ではなく `log_id` の順としている（2 節）。
- `date` はイベントの発生の時刻（要求の時刻）。`log_id` の順と `date` の順は一致しないことがある。文書に書く。
- シャードの書き手は、DB の advisory lock（シャードごと）を持つ Worker のタスク。タスクが落ちたら、他のタスクがロックを取って続ける。S1 のピーク 4,000 件/秒（[capacity.md](capacity.md)）で、1 シャード約 60 件/秒。

## 4. 保存と保持

### 4.1 置き場所

- **S1 は、ログの専用の Aurora PostgreSQL のクラスタに置く**（[ADR-0043](../decisions/0043-log-storage-and-search.md)）。主の Aurora（設定・ユーザー・セッション）と分け、ログの書き込みと検索が認証の経路の DB に及ばないようにする。
- 見積もり（[capacity.md](capacity.md)）：1 日 約 1 億件、約 50 GB、30 日で約 1.5 TB。日ごとのパーティション（`date` ではなく `log_id` の取り込みの日）。
- インデックス（すべて `tenant_id` が先頭）：`(tenant_id, log_id)`、`(tenant_id, user_id, log_id)`、`(tenant_id, type, log_id)`、`(tenant_id, client_id, log_id)`、`(tenant_id, ip, log_id)`、`(tenant_id, connection_id, log_id)`、`(tenant_id, organization_id, log_id)`。
- RLS をかける（ADR-0002）。
- **S2 で専用の基盤へ移す**（architecture README の 2 節）。候補は OpenSearch か ClickHouse。Management API の `/logs` の形は変えない。

### 4.2 保持

| 対象 | 期間 | 備考 |
| --- | --- | --- |
| テナントの検索（Management API、ダッシュボード、ストリームの開始の位置） | テナントの保持の日数（1・5・10・30 日。本家に合わせる。既定案） | プランの設計がまだないので、テナントの属性 `log_retention_days` に持つ。本番以外のテナントは 5 日 |
| ログの専用の Aurora | 31 日 | パーティションを `DROP`。テナントの日数は、問い合わせの条件で切る |
| 本システムの調査用（S3、Parquet） | 90 日（[security.md](security.md) の 9 節の既定案） | テナントには見せない。攻撃の調査と障害の解析だけ。ADR-0056 の期限つきの権限で読む |

- **期間はすべて既定案で、法務の確認（intent の L5）で確定する。** L5 の結論が出るまで、E10 のログの保持の spec を承認しない（intent）。
- ユーザーの削除のとき、そのユーザーのログの `user_name`・メールを含むフィールドを仮名（`deleted-user-<hash>`）に置き換える。`user_id` と IP は保持の期間まで残す（[ADR-0055](../decisions/0055-data-retention-and-deletion.md)）。S3 の Parquet は書き換えず、90 日で消えるのを削除の最終の期限とする（既定案。L1・L5 で確定）。
- テナントの削除のとき、そのテナントのログを 30 日の猶予の後に消す（ADR-0055）。

## 5. 検索（Management API）

| 引数 | 振る舞い |
| --- | --- |
| `q` | Lucene の部分集合（6 節の表のフィールド、`AND`・`OR`・`NOT`、括弧、句、`date:[a TO b]`、後方の `*`） |
| `page`・`per_page`・`include_totals`・`sort` | オフセット。1,000 件まで（本家と同じ）。`sort` は `date:-1`（既定）か `date:1` |
| `from`・`take` | チェックポイント。`from` は `log_id` か、前の応答の `next`。**他の引数を無視しない**（本家は無視する）。`q` と組み合わせられる。件数の上限なし |
| `fields`・`include_fields` | 返すフィールドを絞る |

**検索できるフィールド**（本家と同じ。大文字小文字を区別する）：`client_id`、`client_name`、`connection`、`connection_id`、`description`、`date`、`hostname`、`ip`、`log_id`、`organization_id`、`user_id`、`user_name`、`user_agent`、`strategy`、`strategy_type`、`type`。

**本家と違うところ**：

- フィールドのない語は、`log_id`・`ip`・`client_name`・`connection` の完全一致だけを探す。本家は `description` も探すが、S1 の Aurora で全文の検索の索引を持たないため外す。
- `description`・`user_agent` は、`description:"Wrong password"` のような句の完全一致と前方一致だけ。
- 1 回の検索は 5 秒の時限（reader）。超えたら 400 `query_too_broad` と、`user_id` や `date` の範囲で絞るよう案内する。

チェックポイントに `q` を許すのは、本家では「検索は 1,000 件まで」「チェックポイントは絞れない」の間の穴（大量の特定の種類のログを取り出せない）を、本家のコミュニティでも利用者が訴えているため（[community の例](https://community.auth0.com/t/fetch-more-than-1000-logs-with-a-filter-using-checkpoint-pagination/110104)、2026-09-27 に確認）。索引が `(tenant_id, type, log_id)` などで揃っているので、Aurora で安く返せる。

## 6. ログストリーム

### 6.1 登録

```
log_streams(tenant_id, id, name, type, status, filters[], pii_config, sink(暗号化), cursor_log_id,
            started_from, last_success_at, first_failure_at, created_at)
```

| 項目 | 規則 |
| --- | --- |
| 種類 | MVP：`http`（Webhook）、`eventbridge`。後で Datadog・Splunk など（E10 の後） |
| 1 テナントの本数 | 10（本家の上限は未検証。本システムの決定） |
| フィルター | 2 節のカテゴリー。空なら全件 |
| 個人データの伏せ字 | `mask`（アスタリスク）か `hash`。**`hash` は xxHash ではなく、ストリームごとの鍵の HMAC-SHA-256 にする**（本家は xxHash。非暗号の関数で、メールアドレスの辞書で元に戻せるため） |
| 開始の位置 | 作成時に、保持の期間の中の日時を選べる（本家と同じ）。既定は「今から」 |
| Webhook の宛先 | `https://` だけ。自己署名の証明書は不可（本家と同じ）。宛先の検査は 6.4 節 |
| Webhook の認証 | 任意の `Authorization` の値（本家と同じ）。加えて、本文に署名を付ける（6.3 節） |
| Webhook の形式 | `JSONLINES`（既定）、`JSONARRAY`、`JSONOBJECT`（1 件ずつ送る） |
| EventBridge | 利用者の AWS のアカウント ID、リージョン（MVP は `ap-northeast-1`・`ap-northeast-3`）。作成時にパートナーのイベントソース `aws.partner/<brand>.<domain>/<tenant>/<stream_id>` を作る |
| 秘密 | `Authorization` の値と署名の鍵は、エンベロープ暗号化で持つ（ADR-0004）。読み取りの API は返さない |

- **ストリームの作成・宛先の変更は step-up を要し**（[dashboard.md](dashboard.md) の 4.3 節）、監査ログに残す。ストリームは、テナントの全利用者の個人データを外へ出す経路なので、乗っ取られた管理者が宛先を変えることを最も警戒する。
- 作成・宛先の変更のたびに、テナントの `admin` 全員にメールで知らせる。

### 6.2 配信

[ADR-0044](../decisions/0044-log-stream-delivery.md)。**イベントごとの配信の記録を持たず、ストリームごとのカーソルで送る。**

```
log-streamer（Worker）
  1. log_stream_notify を見て、新しいログのあるテナントのストリームを取る（SQS の通知 ＋ 1 秒ごとの走査）
  2. ストリームのリース（Valkey か DB の行ロック、30 秒）を取る。1 つのストリームは同時に 1 つの送り手だけ
  3. logs から log_id > cursor を最大 100 件（または 1 MiB）読み、フィルターと伏せ字をかける
  4. 送る（Webhook は worker-egress、EventBridge は PutPartnerEvents）
  5. 2xx なら cursor を最後の log_id に進める（フィルターで落ちた分も含めて進める）
     失敗なら cursor を進めず、再試行の予定を決める
```

| 項目 | 値 |
| --- | --- |
| まとめ方 | 最大 100 件、1 MiB、または最初の 1 件から 1 秒 |
| 1 回の試行の時限 | 接続 3 秒、全体 10 秒 |
| 成功 | Webhook は 2xx。EventBridge は `FailedEntryCount` が 0（一部の失敗は、失敗した分からやり直す） |
| 再試行 | 同じまとまりを 3 回（1 秒、5 秒、30 秒の後）。3 回失敗したら Health に記録し、その後は 1 分・5 分・15 分・以後 1 時間ごとに試す（本家の「3 回試し、解決するまで繰り返す」に合わせる） |
| 自動の停止 | 最初の失敗から 7 日、一度も成功しなければ `disabled`（本家と同じ） |
| 受け取りを拒まれる 1 件 | 宛先の 4xx が同じまとまりで 24 時間続いたら、1 件ずつに分けて送り、それでも拒まれる 1 件を飛ばして Health に記録する（1 件でストリーム全体を止めないため） |
| 利用者の停止 | `paused`。カーソルは止まる。再開で、保持の期間の中のログを続きから送る（本家と同じ） |
| 保持の期間を過ぎた | カーソルが保持の期間より古くなったら、残っている最も古いログから再開し、`log_stream_gap` の警告を Health とテナントのログ（`w` ではなく `system.notification`）に出す |
| 公平さ | 1 つのストリームの送り手は 1 つ。遅い宛先は自分のストリームだけを遅らせる。Worker の同時実行はテナントごとに 5 本まで |
| 順序 | まとまりの中と、まとまりの間で `log_id` の順に送る。ただし再試行と `disabled` からの再開があるので、**契約としては順序を保証しない**（本家と同じ）。利用者には `log_id` で重複を捨ててもらう |
| 少なくとも 1 回 | カーソルは成功の後にだけ進む。送った後、カーソルを進める前に落ちると、同じまとまりをもう一度送る |

- NFR-010（最初の送信 p95 60 秒）：取り込み（p95 30 秒以内に検索に出る）＋ 通知（1 秒）＋ まとめ（1 秒）で満たす見込み。
- カーソル方式にしたので、1 件ごとの `deliveries` の表を持たない（Stripe の Webhook と違う）。ログは 1 日 1 億件で、ストリームの数を掛けた記録は持てない。

### 6.3 Webhook の要求

```
POST <url>
Content-Type: application/x-ndjson            （JSONLINES のとき。本家の Content-Type の設定も受ける）
Authorization: <テナントが登録した値>           （登録したときだけ）
<Brand>-Signature: t=1790400000,v1=<hex(HMAC-SHA256(key, t + "." + body))>
<Brand>-Stream-Id: <stream_id>
<Brand>-Delivery-Attempt: 1
User-Agent: <Brand>-LogStreams/1.0
```

- 署名の形は、Stripe の再構築の Webhook の署名（`<Brand>-Signature`）と同じ（[events-and-webhooks.md](../../../stripe/docs/architecture/events-and-webhooks.md) の 7 節）。本家の Webhook のログストリームは `Authorization` の値だけで、本文の署名を持たない（Custom Log Streams の頁の設定の一覧に署名がない）。本システムは署名を足す。`Authorization` の値は、宛先の側の記録に残りやすいので、署名で本文の改ざんとなりすましを検証できるようにする。
- 署名の鍵はストリームごと。作成とローテーションの時に 1 回だけ表示する。ローテーションは 24 時間、古い鍵と新しい鍵の両方で署名する（`v1=` を 2 つ並べる）。

### 6.4 外向きの送信

- Webhook は `worker-egress`（専用の NAT、本体の VPC エンドポイントと DB への経路なし）から送る（[infrastructure.md](infrastructure.md) の 2.3 節）。
- 宛先の検査：名前解決の後の IP が、プライベート・ループバック・リンクローカル（`169.254.0.0/16`、`fd00:ec2::254` を含む）・本システムの範囲なら送らない。リダイレクトを追わない。ポートは 443 だけ（本家の許すポートは未検証。本システムの決定）。
- 署名は VPC の中の Worker で行い、`worker-egress` には署名済みの要求だけを渡す（Stripe と同じ考え方）。
- EventBridge は VPC エンドポイントから `PutPartnerEvents` を呼ぶ（infrastructure の 2.3 節）。1 件 256 KB の上限（EventBridge の上限。未検証）を超えるログは、`details` を切り詰めて `details_truncated: true` を付ける。
- **EventBridge のパートナーになる手続き**（AWS の SaaS パートナーの登録）が要る。手続きの中身と期間は**未検証**。E10 の着手前に確かめる。登録が間に合わないときの代わりは、利用者のイベントバスへの `PutEvents`（アカウントをまたぐ。利用者がバスのリソースポリシーで本システムのアカウントを許す）にする。

## 7. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| SQS・Worker の停止 | outbox に溜まり、回復後に取り込む。検索とストリームが遅れる（ADR-0005）。ログインは止まらない |
| ログの Aurora の停止 | 取り込みが止まり、SQS に溜まる（保持 4 日）。検索は 503。ストリームは止まり、回復後にカーソルから続ける |
| シャードの書き手の停止 | 他のタスクが advisory lock を取って続ける。数十秒の遅れ |
| スキーマの検証の失敗 | dead letter に入れ、警告。秘密の混入の疑い（トークンの形）は、dead letter にも残さず破棄し、`secret_in_log_suspected` のアラート（ADR-0061） |
| Webhook の宛先の障害 | そのストリームだけが遅れる。7 日で `disabled` |
| EventBridge のイベントソースが結び付けられていない | EventBridge の側で捨てられる（2 節）。本システムからは成功に見える。ダッシュボードで、結び付けの手順を案内する |
| 攻撃の波 | 失敗のまとめ（3.3 節）で件数を抑える。それでも取り込みが遅れたら、`system.notification` の優先を下げ、`auth.*` を先に取り込む |

## 8. セキュリティ

- 秘密をログに入れない：許可リストのスキーマ（3.1 節）、CI での秘密の形の走査、本番での走査（ADR-0061）。
- テナントの分離：ログの Aurora にも RLS。ストリームの送り手は、ストリームの `tenant_id` のコンテキストでだけ読む。
- 他テナントの `log_id` を `from` に指定しても、そのテナントのログしか返らない（RLS）。
- ストリームの作成・宛先の変更は step-up と監査と管理者への通知（6.1 節）。
- 個人データの伏せ字の `hash` は、ストリームごとの鍵の HMAC（6.1 節）。
- SSRF の防御（6.4 節）。
- ストリームを有効にすると、送った個人データの扱いはテナントの責任になる（本家と同じ）。外国にある第三者への提供（宛先が国外）と、他人の通信の媒介の論点は、法務の確認待ち（intent の L1・L3）。**E10 のログストリームの spec は、L1・L3 の確認が済むまで承認しない**（intent）。
- `mgmt_api_read` は、秘密を返した GET（秘密のローテーションの応答など）だけに出す（本家と同じ）。

## 9. テスト

- 性質ベーステスト：任意の取り込みの順（複数の Worker、再試行、書き手の交代）について、1 つのテナントの `log_id` はコミットの順に単調に増え、チェックポイントとストリームのカーソルで読んだ列に抜けも重複もない（重複はストリームの再送でだけ起きる）。
- 性質ベーステスト：任意の送信の失敗の列（タイムアウト、5xx、送信の後の Worker の停止）について、ストリームの宛先が受け取った `log_id` の集合は、フィルターに合うログの集合を含む（少なくとも 1 回）。
- 性質ベーステスト：任意のイベントの `details` について、出力に秘密のフィールドの名前と、トークン・秘密の形（`<brand>_rt_`、JWT の形）が現れない。
- 表駆動テスト：種類のコード × カテゴリー（フィルター）、伏せ字 × フィールド。
- 表駆動テスト：検索の文法（許すもの・拒否するもの）。本家の文書の例を含める。
- 結合テスト：Webhook の宛先が 7 日失敗すると `disabled`、再開で続きから送る。`paused` の間のログを再開で送る。
- 結合テスト：宛先の検査（プライベートの IP、IMDS、リダイレクト、443 以外）。
- 結合テスト：ユーザーの削除で、ログのメールと名前が仮名になる。
- 負荷試験（E12）：4,000 件/秒の取り込みで、検索に出るまで p95 30 秒、ストリームの最初の送信 p95 60 秒（NFR-010）。

## 10. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0042](../decisions/0042-log-event-model-and-type-codes.md) | イベントの形と種類のコードは本家の公開のスキーマに寄せ、許可リストのスキーマで秘密を入れない。`log_id` はシャードの唯一の書き手が採番し、テナントの中でコミットの順に単調にする |
| [0043](../decisions/0043-log-storage-and-search.md) | S1 はログの専用の Aurora のクラスタに日ごとのパーティションで置き、本家の検索の部分集合を索引で返す。保持はテナントの属性（1〜30 日）で切り、調査用に S3 で 90 日 |
| [0044](../decisions/0044-log-stream-delivery.md) | ログストリームはストリームごとのカーソルで少なくとも 1 回送る。Webhook に本文の署名を足し、伏せ字の hash は HMAC にする。7 日の失敗で止める |

## 11. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | ログの専用の Aurora のクラスタ、日ごとのパーティション、RLS |
| E3 | 認可コード・クライアントクレデンシャル・リフレッシュの交換のログ（`seacft`・`seccft`・`sertft`・`ferrt` など） |
| E4 | ログイン・サインアップ・パスワードの再設定・メールの確認のログ |
| E8 | ブロック・漏えいしたパスワードのログと、失敗のまとめ |
| E10 | 取り込み（outbox → SQS → シャードの書き手、`log_id` の採番、スキーマの検証） |
| E10 | Management API の `/logs`（検索の文法、オフセット、チェックポイント、`q` との組み合わせ）、`/users/{id}/logs` |
| E10 | 保持（テナントの日数、パーティションの `DROP`）と、ユーザーの削除時の仮名化、S3 の調査用の保管 |
| E10 | ログストリーム：Webhook（カーソル、まとめ、再試行、署名、宛先の検査、Health、停止・再開・開始の位置） |
| E10 | ログストリーム：EventBridge（パートナーのイベントソース、または `PutEvents` の代わり） |
| E10 | フィルターと伏せ字、ストリームの作成の step-up と管理者への通知 |
| E9 | ログの検索とストリームの Health の画面 |
| E12 | 取り込みと配信の負荷試験（NFR-010）、ログの Aurora の停止の障害の注入 |

## 12. 未解決の問い

- 保持の日数を、プランで決めるか、テナントが選ぶか（プランの設計はまだない）。法務の L5 の結論。
- EventBridge の SaaS パートナーの登録の手続きと期間（未検証）。
- 本家のコードのうち、名前から推した意味（`sede`・`fede`・`srrt`・`scpr`・`fcpr`）の確認。
- 失敗のログのまとめ（3.3 節）を、本家がしているか（未検証）。まとめると、1 件ごとの試行を見たいテナントの期待と合わないか。
- S2 の専用の基盤（OpenSearch か ClickHouse）の選定。
- ログストリームの宛先の国外への送信を、テナントの設定だけで許してよいか（法務の L1・L6）。

### 決定

2026-09-27 の既定案。

- 保持の日数はテナントの属性 `log_retention_days`（1・5・10・30）に持ち、本番の既定を 30 日、本番以外を 5 日にする。プランの設計ができたら、プランから設定する。法務の L5 で上限が変わっても、属性の値を変えるだけで済む。
- EventBridge は、パートナーの登録を E10 の着手前に申請する。E10 の終わりに間に合わなければ、`PutEvents` の代わりの形で出し、登録の後にパートナーのイベントソースを足す。
- 失敗のまとめは、同じ IP × 同じユーザー × 同じ種類で 1 秒ごとにする。攻撃の波のとき以外は 1 件ずつに近い。
- S2 の基盤の選定は、E12 の負荷試験の後に行う。

## 13. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：ログへの秘密の混入（K6）。許可リストのスキーマ、性質ベーステスト、CI と本番の走査で見る。
- リスク：ストリームのカーソルの取りこぼし（少なくとも 1 回が破れる）。`log_id` の単調さとカーソルの性質ベーステスト。
- 本番での検証：合成監視のテナントにストリーム（本システムの受け口の Webhook）を持ち、ログインから受け口に届くまでの時間を 5 分ごとに測る（NFR-010）。取りこぼしを日次で突き合わせる。

**runbooks**

- `log-ingest-lag`：検索に出るまでの遅れが p95 30 秒を超えた。SQS の滞留、シャードの書き手、ログの Aurora を順に確かめる。
- `log-stream-disabled`：テナントのストリームが `disabled` になった件数の急増（本システムの egress の障害の疑い）。
- 秘密の混入の疑い（スキーマの検証で秘密の形を破棄した）：発生源の特定と修正。[runbooks/incident-response.md](../runbooks/incident-response.md) の「秘密の出力」で扱う。
- `log-partition-maintenance`：日ごとのパーティションの作成と `DROP` の失敗。
- SLI の追加の依頼（Ops へ）：`log_ingest_lag_seconds`（p95）、`log_stream_first_delivery_seconds`（p95）、`log_stream_status{status}`、dead letter の件数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `logs`（ログの専用のクラスタ） | `tenant_id`、`log_id`、`date`、`type`、`client_id`、`connection_id`、`user_id`、`user_name`、`ip`、`organization_id`、`hostname`、`description`、`user_agent`、`details`（jsonb）、`references` | RLS。取り込みの日ごとのパーティション。31 日で `DROP` |
| `log_shard_state` | `shard`、`last_log_id`、`updated_at` | RLS の外。書き手の採番の状態 |
| `log_stream_notify` | `shard`、`tenant_id`、`max_log_id` | RLS の外。送り手への通知 |
| `log_streams`（主の Aurora） | `tenant_id`、`id`、`name`、`type`、`status`、`filters`、`pii_config`、`sink_ciphertext`、`signing_key_ciphertext`、`cursor_log_id`、`started_from`、`last_success_at`、`first_failure_at`、`last_errors`（直近 10 件） | RLS |
| `tenants.log_retention_days` | 1・5・10・30 | [tenants-and-applications.md](tenants-and-applications.md) の `tenants` に足す列 |

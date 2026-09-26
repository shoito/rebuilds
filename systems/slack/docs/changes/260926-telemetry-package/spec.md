---
capability: observability
change: 260926-telemetry-package
epic: E1
status: approved
---

# Spec: 計装の共通部品 `packages/telemetry`

## 概要

すべてのサーバー（api、gateway、relay、workers）が使う計装の共通部品 `packages/telemetry` を作る（[ADR-0021](../../decisions/0021-observability-stack.md)、[observability.md](../../architecture/observability.md)）。この変更に含めるのは次のとおり。

- OpenTelemetry の Node.js SDK の初期化（リソース属性、自動計装、サンプリング、終了時の送出）
- 属性名の定数
- テナントのラベル（上位 N 件＋「その他」）によるカーディナリティの制御
- `workspace_id` を持ち、個人情報を出さない構造化ログ
- outbox・SQS・Valkey の封筒・WebSocket をまたぐトレース文脈の受け渡しの関数（呼び出すのは E4 以降の変更）
- リリースの識別子の属性（[delivery.md](../../architecture/delivery.md) の 3 節）

含めないもの：ADOT Collector のサイドカーと ECS のタスク定義（インフラの変更）、Web クライアントの計測と `POST /telemetry`（E7 の `rum-telemetry-endpoint`）、ダッシュボードとアラート（E7 の `slo-dashboards-burn-rate`）、ログの呼び出しの ESLint 規則（E7 の `log-pii-lint`）、outbox の `trace_context` 列の追加（E4 の `relay-partitioned-outbox`）。

この変更は、利用者から見える振る舞いを変えない。ここでの「システム」は `packages/telemetry` と、それを呼ぶサービスのプロセスを指す。

## ADDED Requirements

### REQ-OBS-001: 初期化とリソース属性

サービスのプロセスが起動したとき、システムは他のモジュールより先に OpenTelemetry の SDK を初期化し、すべてのトレースとメトリクスに次のリソース属性を付けなければならない：`service.name`、`service.version`（コンテナイメージの digest）、`deployment.environment`、`cloud.availability_zone`、`release.id`。

#### Scenario: api のスパンにリソース属性が付く

- Given 環境変数が `SERVICE_VERSION=sha256:ab12…`、`RELEASE_ID=2026-09-26-a1b2c3d`、`DEPLOY_ENV=staging` で、AZ が `ap-northeast-1a` のタスク
- When `service.name` を `api` として初期化し、HTTP リクエストを 1 件処理する
- Then 送出されたスパンのリソースに `service.name=api`、`service.version=sha256:ab12…`、`release.id=2026-09-26-a1b2c3d`、`deployment.environment=staging`、`cloud.availability_zone=ap-northeast-1a` がある

#### Scenario: 初期化より先に読み込まれたモジュール

- Given `pg` を初期化より先に import するサービス
- When そのサービスを、初期化の前読み込み（`--import`）なしで起動する
- Then 起動時に警告ログ（`msg`=`telemetry_initialized_late`）が 1 件出る

### REQ-OBS-002: リリースの識別子の欠落

`release.id` または `service.version` が設定されていない場合、システムは、`deployment.environment` が `staging` か `prod` なら起動を失敗させ、それ以外なら値を `dev` として起動しなければならない。

#### Scenario: prod で識別子がない

- Given `DEPLOY_ENV=prod` で、`RELEASE_ID` が未設定
- When サービスを起動する
- Then プロセスは 0 以外の終了コードで終わり、エラーログ（`msg`=`release_id_missing`）が出る

#### Scenario: ローカルで識別子がない

- Given `DEPLOY_ENV=local` で、`RELEASE_ID` が未設定
- When サービスを起動する
- Then 起動に成功し、スパンの `release.id` は `dev` である

### REQ-OBS-003: 属性名の定数

システムは、スパンの属性、メトリクスのラベル、ログの項目の名前を `packages/telemetry` の定数として定義し、それ以外の名前を型検査で拒否しなければならない。

#### Scenario: 定義にない属性名

- Given 定数に `workspace.id` はあるが `workspace_name` はない
- When サービスのコードが、`packages/telemetry` の属性設定の関数に `workspace_name` を渡す
- Then 型検査が失敗する

### REQ-OBS-004: 自動計装

システムは、HTTP の受信と送信、`pg`、AWS SDK（SQS を含む）の呼び出しを自動計装し、HTTP の受信のスパンにはルートのテンプレート（`http.route`、例：`/workspaces/:workspace_id/channels/:channel_id/messages`）を付けなければならない。具体的な ID を含む URL を `http.route` に入れてはならない。

#### Scenario: 投稿のリクエストのスパン

- Given 初期化済みの api と、実 DB（Testcontainers）
- When `POST /api/workspaces/W1/channels/C1/messages` を処理する（W1・C1 は UUID）
- Then HTTP の受信のスパンの子に `pg` のスパンがあり、受信のスパンの `http.route` は `/workspaces/:workspace_id/channels/:channel_id/messages` で、W1・C1 の値を含まない

### REQ-OBS-005: サンプリング

トレースを始めるとき、システムは DT-OBS-001 に従って記録するかを決めなければならない。記録しないリクエストでも、ログには `trace_id` を入れなければならない。

#### Scenario: 既定の割合

- Given 親のトレース文脈がない、`/health` 以外のリクエスト 10,000 件
- When 既定の設定（10%）で処理する
- Then 記録されたトレースは 800〜1,200 件で、すべてのリクエストのログに `trace_id` がある

#### Scenario: 常に記録するワークスペース

- Given 常に記録するワークスペースとして W_syn が設定されている
- When W_syn へのリクエストを 100 件処理する
- Then 100 件すべてのトレースが記録される

### REQ-OBS-006: テナントのラベル

テナントのラベルを付けるメトリクスを記録するとき、システムは DT-OBS-002 に従ってラベル `workspace` の値を決めなければならない。上位の集合は、各プロセスで直近 5 分の負荷の量から 60 秒ごとに計算し直し、N の既定値は 50 とし、設定で変えられなければならない。

#### Scenario: 上位 N 件とその他

- Given N = 2 で、直近 5 分の負荷の量が W1 = 900、W2 = 500、W3 = 100 のプロセス
- When 上位の集合を計算し直した後、W1・W2・W3 のリクエストを 1 件ずつ記録する
- Then ラベル `workspace` の値は、それぞれ `W1`、`W2`、`other` である

#### Scenario: 順位の入れ替わり

- Given 上の状態から、W3 の負荷が 5 分間で 2,000 に増えた
- When 次の再計算の後に W2・W3 のリクエストを記録する
- Then ラベルの値は、W2 が `other`、W3 が `W3` である

### REQ-OBS-007: 値の多いラベルの禁止

システムは、テナントのラベルを、許可したメトリクス（リクエスト数、エラー数、DB 時間、投稿数、接続数）にだけ付けられるようにし、処理時間のヒストグラムには付けられないようにしなければならない。`member_id`、`channel_id`、`message_id`、`seq` をメトリクスのラベルにできないようにしなければならない。

#### Scenario: ヒストグラムにテナントのラベルを付けようとする

- When サービスのコードが、処理時間のヒストグラムの記録に `workspace` のラベルを渡す
- Then 型検査が失敗する

#### Scenario: チャンネルの ID をラベルにしようとする

- When サービスのコードが、カウンターの記録に `channel_id` のラベルを渡す
- Then 型検査が失敗する

### REQ-OBS-008: 構造化ログの共通項目

ログを出すとき、システムは 1 行 1 JSON を stdout に出し、`ts`、`level`、`msg`、`service`、`version`、`release`、`env`、`az` を必ず含めなければならない。有効なトレース文脈があれば `trace_id` と `span_id` を、テナントのコンテキストがあれば `workspace_id` と `member_id` を、呼び出し側が渡さなくても含めなければならない。

#### Scenario: テナントのコンテキストの中のログ

- Given ワークスペース W1、メンバー M1 のテナントのコンテキストで処理中のリクエスト
- When ハンドラーが `logger.info("message_posted", { channel_id: C1, seq: 4 })` を呼ぶ
- Then 出力は 1 行の JSON で、`workspace_id`=W1、`member_id`=M1、`channel_id`=C1、`seq`=4、`trace_id`（32 桁の 16 進数）を含む

#### Scenario: テナントのコンテキストの外のログ

- When `/health` の処理でログを出す
- Then 出力に `workspace_id` と `member_id` の項目はない

### REQ-OBS-009: 個人情報を出さない

ログを出すとき、システムは DT-OBS-003 に従って各項目を扱い、許可リストにない項目を出してはならない。メッセージの本文、ファイル名、検索語、メールアドレス、表示名、トークン、Cookie、`Authorization` ヘッダー、IP アドレスは、どの項目名で渡されても出してはならない。

#### Scenario: 本文を渡してしまう

- When 型検査を回避して（`as any`）、`logger.info("message_posted", { body: "秘密の本文", channel_id: C1 })` を呼ぶ
- Then 出力に「秘密の本文」も `body` の項目もなく、`channel_id` は出る。`log_fields_dropped_total{field_class="unknown"}` が 1 増える

#### Scenario: エラーの中のメールアドレス

- When `pg` の一意制約違反のエラー（`detail` に `Key (email)=(a@example.com) already exists.` を含む）を `logger.error("db_error", { err })` で出す
- Then 出力の `err` には `name`、`code`（`23505`）、スタックの呼び出し位置だけがあり、`a@example.com` はどこにも現れない

### REQ-OBS-010: トレース文脈の受け渡し

非同期の境界をまたぐとき、システムは DT-OBS-004 に従って W3C Trace Context を運ぶ関数を提供しなければならない。複数の親を持つ処理（Relay のバッチ）では、各親をスパンリンクでつなぐ関数を提供しなければならない。

#### Scenario: outbox の行を経由する

- Given API のスパン（trace_id = T、sampled）の中
- When outbox 用の関数で `trace_context` の文字列を作り、Relay 側でその文字列から文脈を取り出して子のスパンを作る
- Then 子のスパンの trace_id は T で、親のスパン ID は API のスパンの ID である

#### Scenario: バッチの処理

- Given trace_id が T1、T2、T3 の outbox の行 3 件
- When Relay がバッチ用の関数で 1 つのスパンを作る
- Then そのスパンは T1〜T3 の 3 つへのリンクを持つ

#### Scenario: WebSocket の封筒

- Given trace_id = T、スパン ID = S の文脈
- When Gateway がクライアント向けの封筒の関数を呼ぶ
- Then 封筒の値は `{ trace_id: T }` だけで、S を含まない

### REQ-OBS-011: 不正なトレース文脈

受け取ったトレース文脈が W3C Trace Context の形式に合わない場合、システムはそれを捨てて新しいトレースを始め、例外を投げてはならない。

#### Scenario: 壊れた traceparent

- When `trace_context` が `00-xyz-1-01` の outbox の行を処理する
- Then 例外は出ず、処理のスパンは新しい trace_id を持つ

### REQ-OBS-012: 終了時の送出

プロセスが SIGTERM を受けたとき、システムは溜まっているスパンとメトリクスを、最大 5 秒以内に送出してから終了しなければならない。

#### Scenario: 停止の直前のスパン

- Given 送出の待ちにスパンが 10 件あるプロセス
- When SIGTERM を送る
- Then 5 秒以内にプロセスが終わり、10 件すべてが送出先（テストではメモリ上の受け手）に届く

### REQ-OBS-013: 計装の失敗を業務に広げない

送出先（Collector）に届かない、または計装の処理で例外が起きた場合、システムはリクエストの処理を続け、その結果（ステータスと本文）を変えてはならない。

#### Scenario: Collector が止まっている

- Given `OTEL_EXPORTER_OTLP_ENDPOINT` が応答しないアドレスを指している
- When 投稿のリクエストを処理する
- Then 応答は Collector が動いているときと同じステータスと本文で、送出の失敗は診断ログ（1 分に 1 件まで）にだけ出る

## Decision Tables

### DT-OBS-001: トレースを記録するか

上から順に評価し、最初に一致した行を採用する。

| # | ルート | 親のトレース文脈 | 常に記録するワークスペース | → 記録 |
| --- | --- | --- | --- | --- |
| 1 | `/health` | - | - | しない |
| 2 | それ以外 | あり（sampled） | - | する |
| 3 | それ以外 | あり（not sampled） | - | しない |
| 4 | それ以外 | なし | 該当する | する |
| 5 | それ以外 | なし | 該当しない | 既定の割合（10%）で、trace_id から決める |

- 「常に記録するワークスペース」は、合成監視のワークスペースと、Ops が一時的に指定したワークスペース。どこから読むかは、初期化の引数（判定の関数）で受け取る。

### DT-OBS-002: ラベル `workspace` の値

上から順に評価し、最初に一致した行を採用する。

| # | テナントのコンテキスト | 合成監視のワークスペース | 上位の集合に含まれる | → `workspace` の値 |
| --- | --- | --- | --- | --- |
| 1 | なし | - | - | `none` |
| 2 | あり | はい | - | `synthetic` |
| 3 | あり | いいえ | はい | その `workspace_id` |
| 4 | あり | いいえ | いいえ | `other` |

- 合成監視を別の値にするのは、業務のメトリクスの集計から除けるようにするため（[observability.md](../../architecture/observability.md) の 5.3 節）。

### DT-OBS-003: ログの項目の扱い

上から順に評価し、最初に一致した行を採用する。

| # | 項目名 | 値の型 | → 出力 | → 数えるもの |
| --- | --- | --- | --- | --- |
| 1 | 共通項目（`ts`、`level`、`service` など）を呼び出し側が渡した | - | 捨てる（共通項目は上書きさせない） | `field_class="reserved"` |
| 2 | `err` | Error | `name`、`code`、スタックの呼び出し位置だけに変換して出す。`message`・`detail` は出さない | - |
| 3 | 許可リストにある | 許可リストの型（文字列・数値・真偽値） | 出す。文字列はメールアドレス・`Bearer` トークン・JWT の形を `[redacted]` に置き換える | 置き換えたら `field_class="masked"` |
| 4 | 許可リストにある | それ以外（オブジェクト、配列など） | 捨てる | `field_class="type"` |
| 5 | 許可リストにない | - | 捨てる | `field_class="unknown"` |

- 許可リストは Design の表のとおり。本文・表示名などを受ける項目名は、許可リストに入れない。

### DT-OBS-004: 境界ごとのトレース文脈の運び方

各行が 1 つの関数に対応する。

| # | 境界 | 運ぶ場所 | → 運ぶもの |
| --- | --- | --- | --- |
| 1 | クライアント → API（HTTP） | `traceparent` ヘッダー | `traceparent`（自動計装が扱う） |
| 2 | API → Relay | outbox の行の `trace_context` 列 | `traceparent` の文字列 |
| 3 | Relay → Workers | SQS のメッセージ属性 `traceparent` | `traceparent` の文字列 |
| 4 | Relay → Gateway | Valkey に流すイベントの封筒の `trace_context` | `traceparent` の文字列 |
| 5 | Gateway → クライアント | WebSocket のイベントの封筒の `trace_id` | trace_id だけ（スパン ID を含めない） |

- `tracestate` と baggage は運ばない。

## Correctness Properties

### PROP-OBS-001: テナントのラベルの値の数は上限を超えない

任意のワークスペースの数と、任意の負荷の記録の列に対して、1 回の再計算の後に付けられる `workspace` のラベルの値のうち、ワークスペースの ID であるものは N 個以下である。

### PROP-OBS-002: ラベルをまとめても合計は保たれる

任意の記録の列に対して、1 つのメトリクスの `workspace` のラベルのすべての値にわたる合計は、記録した量の合計と一致する。

### PROP-OBS-003: ログに個人情報が出ない

任意の項目名と値（入れ子、循環参照、Error、メールアドレスやトークンの形を含む文字列）をロガーに渡しても、出力の JSON の項目名は許可リストと共通項目の和集合の部分集合であり、出力のどこにもメールアドレスの形の文字列と `Bearer` トークンの形の文字列が現れない。

### PROP-OBS-004: ログは常に 1 行の有効な JSON

任意の入力をロガーに渡しても、例外を投げず、出力はちょうど 1 行（改行を 1 つだけ末尾に持つ）の、`JSON.parse` できる文字列である。

### PROP-OBS-005: トレース文脈の往復

任意の有効なスパンの文脈（trace_id、スパン ID、sampled のフラグ）に対して、DT-OBS-004 の 2〜4 の関数で書き出してから取り出すと、trace_id、スパン ID、sampled のフラグが一致する。任意の文字列を取り出しの関数に渡しても、例外を投げない。

## Design

### パッケージの構成

| 入口 | 中身 | 使う場所 |
| --- | --- | --- |
| `packages/telemetry/register` | 前読み込み用。`node --import` で読み込み、SDK を初期化する | 各サービスの起動コマンド |
| `packages/telemetry` | ロガー、メトリクスの作成、テナントのコンテキスト、トレース文脈の関数 | サーバーのコード |
| `packages/telemetry/attributes` | 属性名の定数だけ（Node の API に依存しない） | サーバー、将来の Web クライアント |

### 属性名の定数

| 定数 | スパンの属性 | ログの項目 | メトリクスのラベル |
| --- | --- | --- | --- |
| `SERVICE_NAME` など リソース | `service.name`、`service.version`、`deployment.environment`、`cloud.availability_zone`、`release.id` | `service`、`version`、`env`、`az`、`release` | `service` |
| `WORKSPACE_ID` | `workspace.id` | `workspace_id` | `workspace`（DT-OBS-002 の値） |
| `MEMBER_ID` | `member.id` | `member_id` | 使わない |
| `CHANNEL_ID` | `channel.id` | `channel_id` | 使わない |
| `SEQ` | `message.seq` | `seq` | 使わない |
| `EVENT_TYPE` | `event.type` | `event` | `event_type` |
| `DELIVERED_CONNECTIONS` | `delivery.connections` | - | - |
| HTTP | `http.route` など（自動計装） | `request_id`、`route`、`status`、`duration_ms` | `route`、`method`、`status_class` |
| `PLAN` | - | - | `plan` |

- ログの許可リストは、上の表のログの項目と共通項目（`ts`、`level`、`msg`、`trace_id`、`span_id`、`err`）に限る。項目を足すときは、この表を変える（spec の変更）。
- `release.id` と `workspace.id` は独自の名前。OpenTelemetry の意味規約で `deployment.environment` が `deployment.environment.name` に改められているかは **未検証**。改められていれば、定数の値だけを変える。

### テナントのコンテキスト

- `AsyncLocalStorage` で `{ workspace_id, member_id }` を持つ。E1 の認証ミドルウェア（`apps/api/src/middleware/tenant.ts`）が `runWithTenant()` を呼ぶと、ロガーと現在のスパン（`workspace.id`、`member.id`）に反映される。
- 上位の集合の計算に使う負荷の量は、サービスごとに決める（api は DB 時間の ms、gateway は接続数）。`recordTenantLoad(workspace_id, amount)` で渡す。

### サンプリング

- 親に従うサンプラー（`ParentBasedSampler`）の root に、DT-OBS-001 の 1・4・5 行を判定する独自のサンプラーを置く。1 行目（`/health`）は、親の有無より先に判定するため、`ParentBasedSampler` の外側で包む。
- サンプリングの判定の時点で、HTTP の自動計装がパスの属性を渡すかは **未検証**。渡さなければ、HTTP の自動計装の `ignoreIncomingRequestHook`（`/health`）と、ルートのミドルウェアでの判定に分ける。
- 記録しないスパンでも、SDK は有効な trace_id を持つ文脈を作るので、ログに `trace_id` を入れられる（**未検証**。Proof の REQ-OBS-005 で確かめる）。

### ログ

- pino を土台にし、項目の整形を DT-OBS-003 の関数で行う。`console.*` はサービスのコードから使わない（lint は E7 の `log-pii-lint`）。
- `msg` は固定の短い識別子（`message_posted` など）にする。可変の値は項目で渡す。
- エラーの `message` を出さないのは、DB のエラーが値（メールアドレスなど）を含みうるため。調査には `code` とスタック、`trace_id` を使う。

### 外部の事実（未検証）

- ESM のサービスで、`--import` による前読み込みと自動計装（`pg`、`http`、AWS SDK）が働くか。
- X-Ray（CloudWatch の OTLP の受け口）が、W3C のランダムな trace_id をそのまま受け取るか。受け取らなければ、X-Ray 形式の ID の生成器（`AWSXRayIdGenerator`）を使う。
- ECS のタスクのメタデータから AZ を得るリソース検出器（`@opentelemetry/resource-detector-aws`）の API。
- Hono でマッチしたルートのテンプレートを得る API（`c.req.routePath`）。

## Open questions

- 上位の集合の順位を、1 つの負荷の量（api は DB 時間）で決めてよいか。リクエスト数だけが多いテナント（安い呼び出しの連打）は、DB 時間では上位に入らない。両方の上位 N/2 件の和集合にする案がある（Ops）。
- 外部のクライアントが付けた `traceparent` の sampled のフラグに従うと、クライアントが全件の記録を強制できる（費用の濫用）。クライアント → API の境界だけ、親のフラグを無視して DT-OBS-001 の 4・5 行で決め直すか（Ops、Dev）。
- Valkey のクライアントのライブラリ（ioredis・iovalkey など）が未定。決まった変更で自動計装を足す。
- エラーの `message` を出さない方針で、調査に困らないか。`AppError` のように、安全と分かっている文言だけを出す例外を設けるか（Ops）。

## 決定（2026-09-26、PM・QA、既定案）

上の Open questions は、次のとおり決めた。

- 上位の集合は、DB 時間とリクエスト数のそれぞれの上位 N 件の和集合にする。
- クライアントから API への境界では、`traceparent` の sampled のフラグに従わず、API の側で標本の採否を決める（親の trace_id は引き継ぐ）。
- Valkey のクライアントは `iovalkey`（ioredis 互換）を使う前提にする。自動計装は、それを入れる変更で足す。
- エラーの `message` は原則出さない。例外として、`AppError` の、安全と分かっている文言だけを出す。

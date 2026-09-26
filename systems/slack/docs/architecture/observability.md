# Observability: Slack

ログ、メトリクス、トレース、SLO の計測、合成監視、実ユーザー監視。道具の選定は [ADR-0021](../decisions/0021-observability-stack.md) にある。SLI と SLO の定義そのものは Ops の [runbooks/README.md](../runbooks/README.md) が正本で、ここにはそれを計測する仕組みを書く。

## 1. 全体の流れ

```
 api / gateway / relay / workers（OpenTelemetry SDK）
        │ OTLP
        ▼
 ADOT Collector（各タスクのサイドカー）
        ├─ traces  ─▶ X-Ray（CloudWatch の OTLP エンドポイント）
        ├─ metrics ─▶ Amazon Managed Service for Prometheus（環境ごとに 1 ワークスペース）
        └─ logs    ─▶ CloudWatch Logs（stdout の JSON を FireLens 経由で送る）

 Web クライアント ─▶ POST /telemetry（api）─▶ 同じ経路
 AWS のリソース（Aurora、Valkey、ALB、SQS）─▶ CloudWatch メトリクス

 Amazon Managed Grafana（shared アカウント）が、Prometheus・CloudWatch・X-Ray を横断して見る
 アラート：Prometheus のルール ─▶ Alertmanager ─▶ SNS ─▶ オンコールの通知
          CloudWatch アラーム   ─────────────────▶ SNS ─▶ オンコールの通知
```

## 2. 計装

- すべてのサービスで OpenTelemetry の Node.js SDK を使う。HTTP（Hono）、`pg`、Valkey のクライアント、AWS SDK（SQS）は自動計装を使い、ドメインの処理（投稿、`seq` の採番、ファンアウト）には手でスパンを足す。
- 計装のコードは `packages/telemetry` の 1 か所に置き、各サービスはそれを呼ぶだけにする。属性名はここで定数として定義する。
- 共通の属性：`service.name`、`service.version`（イメージの digest）、`deployment.environment`、`cloud.availability_zone`、`workspace.id`（3 節の規則で扱う）。

### 2.1 トレースの伝播

1 つの投稿を、API から全クライアントへの配信まで 1 つのトレースで追えるようにする。伝播には W3C Trace Context（`traceparent`）を使う。

| 境界 | 運び方 |
| --- | --- |
| クライアント → API（HTTP） | `traceparent` ヘッダー。クライアントが付けなければ API が始める |
| API → Relay（outbox の行） | outbox の行に `trace_context` 列（`traceparent` の文字列）を持たせ、同じトランザクションで書く。列の追加は [data-model.md](data-model.md) への変更として別途起票する |
| Relay → Workers（SQS） | メッセージ属性 `traceparent` |
| Relay → Gateway（Valkey Pub/Sub） | イベントの封筒（envelope）に `trace_context` を含める |
| Gateway → クライアント（WebSocket） | イベントの封筒に `trace_id` だけを含める。親のスパン ID は渡さない。クライアントが報告する遅延（6 節）を、サーバーのトレースと結び付けるため |

- Relay は複数の outbox の行をまとめて処理するので、Relay のスパンは各行のトレースに **スパンリンク** でつなぐ。
- Gateway は、配信先のクライアントごとにスパンを作らない。イベント 1 件・Gateway のタスク 1 台につき 1 スパンを作り、配信した接続数を属性に持たせる。

### 2.2 サンプリング

- 先頭でのサンプリング（親に従う）。既定は 10%、`/health` は 0%。
- 合成監視のワークスペース（5 節）と、Ops が一時的に指定したワークスペースは 100% にする。
- サンプリングで捨てたリクエストでも、ログには `trace_id` を入れる。失敗したリクエストは、トレースがなくてもログから追える。
- 末尾でのサンプリング（エラーと遅いものを全件残す）は、中央のコレクターが必要になるため、S2 で検討する。

## 3. メトリクス

### 3.1 種類

| 種類 | 対象 | 主な指標 |
| --- | --- | --- |
| RED | api、gateway、relay、workers | リクエスト（イベント）数、エラー数、処理時間のヒストグラム。ルートやイベント種別ごと |
| USE | Aurora、Valkey、ECS のタスク、SQS、ALB | 使用率（CPU、メモリ、接続数）、飽和（キューの長さ、待ち、レプリカ遅延）、エラー |
| 業務 | 全体 | 投稿数/秒、同時接続数、アクティブなワークスペース数、配信したイベント数/秒、検索数/秒、通知の送信数 |
| 配信の遅延 | relay、gateway | outbox の行の作成から Gateway の送信までの時間（`delivery_latency`、ヒストグラム）。SLO の計測に使う |
| 品質 | クライアント（6 節） | 欠損検知率、未読数の不一致率、再接続の回数 |

- 遅延はヒストグラムで持ち、パーセンタイルは Prometheus のクエリで出す。サービスの中で平均を計算しない。
- 配信の遅延は、サーバーの時計で測る（ECS のタスクは Amazon Time Sync Service で同期する）。クライアントの時計はずれるので、SLO には使わない。

### 3.2 テナントのラベルとカーディナリティ

`workspace_id` をそのままラベルにすると、系列の数がワークスペース数に比例して増える。次の規則で抑える。

- **上位 N 件＋「その他」。** 各タスクは直近 5 分の負荷（リクエスト数、DB 時間）で上位 N 件（初期値 50）のワークスペースを保ち、それ以外は `workspace="other"` にまとめる。N は `packages/telemetry` の設定で変えられる。
- **テナントのラベルを付けるのは、決めた指標だけ。** リクエスト数、エラー数、DB 時間、投稿数、接続数。処理時間のヒストグラムには付けない（バケット数 × テナント数になるため）。
- `plan`（料金プラン）のような値の少ない属性は、常にラベルにしてよい。
- `member_id`、`channel_id`、`message_id` は、メトリクスのラベルにしない。ログとトレースにだけ持たせる。
- 系列の数を監視し、環境ごとの上限（初期値 100 万系列）の 80% でアラートを出す。
- 特定のテナントを詳しく見るときは、ログとトレース（`workspace.id` を常に全件持つ）で調べる。

runbooks の「1 テナントが DB 時間の 30% を超え続けたら」のアラートは、この上位 N 件のメトリクスで判定する。

## 4. ログ

- **1 行 1 JSON の構造化ログ**を stdout に出す。共通の項目は次のとおり。

  | 項目 | 内容 |
  | --- | --- |
  | `ts`、`level`、`msg` | 時刻、レベル、要約 |
  | `service`、`version`、`env`、`az` | どこで出たか |
  | `trace_id`、`span_id` | トレースとの結び付け |
  | `workspace_id`、`member_id` | テナントのコンテキストがあれば必ず入れる |
  | `request_id`、`route`、`status`、`duration_ms` | HTTP のとき |
  | `event`、`channel_id`、`seq` | 配信・ジョブのとき |

- **個人情報を消す。** ロガーは許可リスト方式にし、定義していない項目は出さない。
  - メッセージの本文、ファイル名、検索語、メールアドレス、表示名、トークン、Cookie、`Authorization` ヘッダーは出さない。
  - ID（`workspace_id`、`member_id` など）は出してよい。それ自体は個人を特定しない。
  - IP アドレスは、セキュリティの監査ログ（[security.md](security.md)）にだけ残し、アプリのログには出さない。
  - CI で、ログの呼び出しに禁止された項目が渡されていないかを lint で検査する。本番でも、メールアドレスなどの形をしたものを CloudWatch Logs のデータ保護ポリシーでマスクする（二重の防御）。
- アプリのログと監査ログを分ける。監査ログ（誰が何をしたか）の設計は [security.md](security.md) にある。

## 5. SLO、アラート、合成監視

### 5.1 SLO のダッシュボード

runbooks の SLI ごとに、Grafana に次を並べたダッシュボードを持つ。

- 現在の SLI の値と SLO
- 28 日間のエラーバジェットの残り
- バーンレート（1 時間、6 時間、3 日）
- 上位テナントごとの内訳（3.2 の規則）

| SLI（runbooks） | 計測に使うメトリクス |
| --- | --- |
| 送信 → 表示の遅延 p99 | `delivery_latency` のうち 500ms 以内の割合（99% を目標とする比率の SLI として扱う） |
| 投稿 API の成功率 | 投稿のルートの 5xx 以外の割合。429 と 4xx は成功として数える |
| 欠損検知率 | クライアントが報告する `gap_detected` ÷ 受け取ったイベント数 |
| 未読数の不一致率 | クライアントが報告する突合の結果 |

### 5.2 マルチウィンドウのバーンレート・アラート

SLO の違反を早く、かつ誤報を少なく知るため、長い窓と短い窓の両方が条件を満たしたときに通知する。

| 重さ | 長い窓 | 短い窓 | バーンレート | 意味 | 通知先 |
| --- | --- | --- | --- | --- | --- |
| 呼び出し（page） | 1 時間 | 5 分 | 14.4 | 1 時間で月のバジェットの 2% を消費 | オンコール |
| 呼び出し（page） | 6 時間 | 30 分 | 6 | 6 時間で 5% を消費 | オンコール |
| チケット | 3 日 | 6 時間 | 1 | このペースで月のバジェットを使い切る | Ops のキュー |

- すべてのアラートは、対応する runbook の URL を注釈に持つ。runbook のないアラートは作らない（runbooks/README.md の 4 節に行を足す）。
- 呼び出しのアラートは、SLO か、ユーザーへの影響が確実な症状（全停止、テナント境界の監査の不一致）に限る。原因側の指標（CPU など）は、ダッシュボードとチケットにとどめる。

### 5.3 合成監視

[quality.md](../quality.md) の 4.2 のシナリオを、CloudWatch Synthetics のカナリアで実行する。

- prod の中の専用ワークスペースで、1 分ごとに「投稿 → 別のクライアントで WebSocket から受信 → 検索でヒット」を行う。
- 実行する場所は大阪リージョン。東京の外から見ることで、リージョンの入口の障害にも気づける。
- 段階ごとの時間（投稿、受信、検索への反映）をメトリクスとして記録し、2 回続けて失敗したら呼び出す。
- 合成監視のワークスペースは、業務のメトリクスと課金の集計から除く。

## 6. 実ユーザー監視（RUM）

クライアントの詳細は [client.md](client.md) にある。ここでは、送る指標と経路だけを決める。

- クライアントは、OpenTelemetry の Web SDK で計測し、`POST /workspaces/{ws}/telemetry` へまとめて送る。外部の RUM サービスへ直接は送らない（CSP を広げず、個人情報の扱いを API で一元化するため）。
- 利用状況の分析（機能の利用、ファネル、継続率）は RUM ではなく、GA で行う（[ADR-0025](../decisions/0025-product-analytics-with-ga4.md)）。GA は運用の監視やアラートには使わない。
- 送る指標：
  - Web Vitals（LCP、INP、CLS）、JavaScript のエラー
  - 最初のメッセージが表示されるまでの時間
  - WebSocket の再接続の回数と、つながるまでの時間
  - 欠損の検知（`seq` の飛び）と、差分取得の件数
  - 未読数の突合の結果
  - イベントを受け取ってから描画するまでの時間（`trace_id` 付き）
- API はこれを検証・間引きしてからメトリクスに変換する。1 クライアントあたりの送信量に上限を置く。

## 7. 保持期間とアクセス権

| データ | 保存先 | 保持 |
| --- | --- | --- |
| アプリのログ | CloudWatch Logs（各環境のアカウント） | prod 30 日、staging・dev 7 日 |
| 監査ログ | [security.md](security.md) で定める | [security.md](security.md) で定める |
| ALB・CloudFront・WAF のアクセスログ | S3（prod のアカウント） | 90 日 |
| CloudTrail、VPC フローログ | S3（log-archive、Object Lock） | 1 年 |
| メトリクス | Amazon Managed Service for Prometheus | 150 日（既定） |
| トレース | X-Ray | 30 日 |

- **本番のログは prod のアカウントから出さない**（[infrastructure.md](infrastructure.md) の 7 節）。Grafana は、prod のアカウントのロールを引き受けて読むだけにする。
- 本番のログとトレースを読めるのは、Ops と、Ops が許可した Dev（読み取り専用の権限セット）に限る。個人情報は 4 節の規則で出していないので、読み取り権限で調査できる。
- AI エージェントは、本番のログ・トレースへの経路を持たない。調査に使うときは、人間が取り出したものだけを渡す（[security.md](security.md)）。
- 本番のログへのクエリは CloudTrail に記録される。
- メトリクスとダッシュボードは、全ロールが読める。

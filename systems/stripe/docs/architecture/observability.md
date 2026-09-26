# Observability: Stripe

ログ、メトリクス、トレース、決済に固有の SLI の計測、PCI DSS のログの要件、アラート、合成監視。道具は Slack の [ADR-0021](../../../slack/docs/decisions/0021-observability-stack.md) を引き継ぐ（OpenTelemetry → AMP・X-Ray・CloudWatch Logs、Grafana で横断）。SLO の値とアラートの一覧の正本は Ops の [runbooks/README.md](../runbooks/README.md) にあり、ここにはそれを計測する仕組みを書く。

## 1. 全体の流れ

```
 本体（prod）：api / dashboard / checkout / relay / workers / webhook-* / connectors
 Webhook の egress VPC：webhook-egress（Lambda）
 CDE（cde-live・cde-test）：vault-ingest / vault-core / connector-gateway
        │ OTLP（各タスクの ADOT Collector のサイドカー）
        ├─ traces  ─▶ X-Ray（そのアカウントの中）
        ├─ metrics ─▶ AMP（環境ごと。CDE は CDE のアカウントの AMP）
        └─ logs    ─▶ CloudWatch Logs（そのアカウントの中）─▶ Firehose ─▶ log-archive の S3（Object Lock）
                                               └─▶ カード番号の走査（4.3 節）

 Grafana（shared）：本体の AMP・CloudWatch・X-Ray と、CDE の AMP（メトリクスだけ）を読む
 CDE のログとトレースは、CDE の期限つきの権限で、CDE のアカウントの中でだけ読む
 アラート：AMP のルール → Alertmanager → SNS → オンコール。AWS のリソースは CloudWatch アラーム → SNS
```

- **CDE のログとトレースを、CDE のアカウントの外に出さない。** カード番号を出さない規則（4 節）があっても、万一の混入が CDE の外に広がらないようにする。Grafana が CDE から読むのは、ラベルの値を決めたメトリクスだけにする。
- CDE のログを log-archive へ送るのは、PCI DSS の保存と改ざん防止（4.4 節）のため。log-archive の CDE 用のバケットは、PCI DSS の範囲に入れて運用する（[infrastructure.md](infrastructure.md) の 1 節）。

## 2. 計装

- 計装は `packages/telemetry` に集め、属性名を定数で定義する（Slack と同じ）。
- 共通の属性：`service.name`、`service.version`、`deployment.environment`、`cloud.region`、`cloud.availability_zone`、`livemode`（`true` / `false`）、`account.id`（3.3 節の規則）、`connector`（コネクタの名前）。
- ドメインのスパンを手で足す：冪等キーの確認、Fraud の判定、Vault の呼び出し、コネクタの呼び出し（試行ごと）、台帳の仕訳、outbox の書き込み。
- **コネクタの待ちを、独立したスパン（`connector.call`）にする。** NFR-002 の「コネクタの待ちを除いた処理時間」は、このスパンを差し引いて求める（3.2 節）。

### 2.1 トレースの伝播

| 境界 | 運び方 |
| --- | --- |
| 加盟店 → API | `traceparent` を受け付けない（外部の値を信頼しない）。API が始め、応答の `Request-Id` と結びつける |
| API → CDE（PrivateLink） | `traceparent` ヘッダー。CDE の側のスパンは CDE の X-Ray にだけ残る |
| CDE → 本体（SQS） | メッセージ属性 `traceparent` |
| API → outbox → Relay → SQS → Workers・webhook-sender → webhook-egress | outbox の行の `trace_context` 列、SQS のメッセージ属性（Slack と同じ） |

1 件の決済を、API の受け付けから Webhook の送信まで 1 つのトレースで追える。CDE の部分は、CDE の権限で CDE の X-Ray を見て、同じ `trace_id` でつなぐ。

### 2.2 サンプリング

- 先頭でのサンプリング。既定は 10%。お金を動かす要求（確定、キャプチャ、返金、Payout）は 100% にする。件数は多くない（S1 のピークで 500 件/秒）ので、全件を残して障害の調査に使う。
- 合成監視の加盟店と、Ops が一時的に指定した加盟店は 100%。
- サンプリングで捨てた要求でも、ログには `trace_id` と `request_id` を入れる。

## 3. メトリクスと SLI

### 3.1 種類

| 種類 | 対象 | 主な指標 |
| --- | --- | --- |
| RED | 全サービス | 要求数、エラー数、処理時間のヒストグラム（ルート・コネクタごと） |
| USE | Aurora、ECS、SQS、ALB、NAT、Network Firewall、KMS | 使用率、飽和（キュー、ロック待ち、複製の遅延）、エラー、スロットリング |
| 決済 | Payments、connector-gateway | オーソリの結果（承認・発行会社の拒否・技術的な失敗・結果不明）、3D セキュアの結果、確定の件数と金額 |
| お金 | Ledger、照合、Payout | 仕訳の件数、不一致の件数と経過日数、Payout の保留 |
| 配信 | relay、webhook-sender | outbox の遅れ、Webhook の最初の配信までの時間、失敗の率 |

- 金額のメトリクスは、通貨ごとの最小単位の整数の合計をカウンターで持つ。Prometheus の値は浮動小数点なので、**監視のためだけに使い、お金の正本にしない**（正本は台帳。[ADR-0003](../decisions/0003-double-entry-ledger.md)）。

### 3.2 決済に固有の SLI

| SLI | 定義 | 計測 | 目標（案。正本は runbooks） |
| --- | --- | --- | --- |
| 決済の API の可用性（NFR-001） | 決済の API（PaymentIntent・Refund・PaymentMethod）の要求のうち、5xx とタイムアウトでないものの割合。402（カードの拒否）と 4xx は成功として数える | ALB と api の `http.server` のメトリクス。合成監視で補う | 99.99%（30 日） |
| オーソリの技術的な成功率（コネクタ別） | コネクタへの試行のうち、承認か発行会社の拒否という「確定した結果」を得た割合。タイムアウト・接続の失敗・5xx・結果不明は失敗 | api の `connector_attempts_total{connector, outcome}`（試行の記録と同じ場所で数える） | 99.9%（コネクタごと） |
| オーソリの承認率（コネクタ別・ブランド別） | 確定した結果のうち、承認の割合 | 同上 | 目標ではなく、平常との差で見る（3.4 節） |
| 処理時間（コネクタの待ちを除く、NFR-002） | API の処理時間から、`connector.call` のスパンの時間を引いたもの | api が要求ごとに `api_internal_duration_seconds` のヒストグラムに記録する | p99 300ms 以内 |
| コネクタの応答時間 | `connector.call` の時間（コネクタ別） | connector-gateway のヒストグラム | SLO にしない。平常との差で見る |
| 結果不明の残り | 結果不明のままの試行の件数と、最古の経過時間 | workers の照会のキュー | 最古が 15 分以内 |
| コネクタの通知の反映 | 受信箱（`connector_inbox`）に記録してから、遷移関数で反映するまでの時間。未反映・保留の行の最古の経過時間 | workers の `connector_inbox_apply_latency_seconds` | p95 5 秒以内。保留が 24 時間を超えたら 1 件でもアラート（[ADR-0014](../decisions/0014-connector-inbox.md)） |
| Webhook の配信の遅れ（NFR-006） | Event の作成から、最初の配信の試行が終わるまでの時間 | webhook-sender の `webhook_first_attempt_latency_seconds` | p95 10 秒以内 |
| 照合の不一致（NFR-005） | 精算ファイル・銀行の明細と、台帳の突き合わせで合わない明細の件数（経過営業日ごと） | 照合のジョブのメトリクス `recon_breaks{source, age_bucket}` | T+2 営業日で 0 件 |
| 台帳の整合 | 日次の再計算の残高と集計の残高の差（口座の数） | 台帳の検査のジョブ | 0（1 件でも SEV2。[ADR-0003](../decisions/0003-double-entry-ledger.md)） |
| DR の複製の遅延 | `AuroraGlobalDBRPOLag`（live・Vault） | CloudWatch | 10 秒以内（[infrastructure.md](infrastructure.md) の 5.3 節） |

- **カードの拒否は、可用性を消費しない。** 拒否は発行会社の判断で、システムの失敗ではない。技術的な失敗（タイムアウト、接続の失敗）とは、`outcome` のラベルで分ける。分類の規則（アクワイアラの応答コード → `approved` / `declined` / `error` / `unknown`）は、コネクタごとの表として [payment-methods.md](payment-methods.md) に置く。
- **コネクタの障害は、API の可用性とオーソリの技術的な成功率の両方に出る。** 振り分け（[payment-methods.md](payment-methods.md)）で別のコネクタへ回せるなら、API の可用性は保たれ、コネクタ別の成功率だけが下がる。

### 3.3 テナントのラベル

Slack の observability.md の 3.2 節と同じ規則にする。

- `account_id` は、上位 N 件（初期値 100）＋「その他」。付けるのは、要求数、エラー数、確定の件数、オーソリの結果、Webhook の失敗の件数だけ。
- `connector`、`card_brand`、`payment_method_type`、`outcome`、`decline_category`（10 種程度にまとめた分類）は、値の少ない属性なので常にラベルにする。アクワイアラの生の応答コードはラベルにせず、ログに出す。
- `payment_intent_id`、`customer_id` はラベルにしない。

### 3.4 平常との差で見る指標

承認率とコネクタの応答時間は、加盟店の構成・時間帯・曜日で大きく変わるので、固定のしきい値にしない。

- 過去 4 週の同じ曜日・同じ時間帯の値を基準にし、コネクタ別・ブランド別に比べる。
- 承認率が基準から 10 ポイント以上下がり、15 分続いたら、呼び出す。1 つの加盟店だけの低下は、チケットにする（加盟店の側の問題か、不正の攻撃のことが多い）。
- 1 つの加盟店で、拒否の件数が急増したら、カードの有効性を試す攻撃（カードテスティング）を疑い、[fraud.md](fraud.md) の手順につなぐ。

## 4. ログと PCI DSS

### 4.1 共通の形

1 行 1 JSON の構造化ログ。項目は許可リスト方式で、定義していない項目は出さない（Slack と同じ）。

| 項目 | 内容 |
| --- | --- |
| `ts`、`level`、`msg`、`service`、`version`、`env`、`region`、`az` | どこで、いつ |
| `trace_id`、`span_id`、`request_id` | 追跡 |
| `account_id`、`livemode` | テナント |
| `payment_intent_id`、`attempt_id`、`connector`、`connector_reference`、`outcome`、`response_code` | 決済 |
| `route`、`status`、`duration_ms`、`internal_duration_ms` | HTTP |

### 4.2 カード番号をログに出さない

PCI DSS は、カード番号を平文で残す場所を厳しく限る。本体は、そもそもカード番号を受け取らない（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。それでも、次の多重の防御を置く。

1. **型で防ぐ。** CDE のコードでは、カード番号を専用の型（`Pan`）に入れ、`toString`・`toJSON` が伏せ字（先頭 6 桁と下 4 桁まで）を返すようにする。ロガーは `Pan` 型の値を受け取ったら、型検査で失敗させる。
2. **lint で防ぐ。** ロガーの呼び出しに、許可リスト外の項目と、要求の本文・ヘッダーの全体を渡すコードを CI で拒否する。セキュリティコード（CVC）は、CDE の中でも保存・ログのどちらにも出さない（オーソリの後に保存しない。PCI DSS 要件 3.3.1）。
3. **流れる途中で見つける。** 本体と CDE のすべてのロググループに、購読のフィルターで走査の処理（Lambda）をつなぎ、13〜19 桁の数字の列のうち、ブランドの先頭の番号と Luhn の検査を満たすものを探す。見つけたら、呼び出しのアラート（SEV2、カード番号の漏洩の疑い）を出す。ブランドのテスト用のカード番号は除く。
4. **CloudWatch Logs のデータ保護ポリシーでも伏せる。** 管理されたデータ識別子 `CreditCardNumber`・`CreditCardSecurityCode`・`CreditCardExpiration` を使う。ただし `CreditCardNumber` は、近くに `card` や `visa` などのキーワードがあるときだけ検出する（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/protect-sensitive-log-data-types-financial.html)）。キーワードのないカード番号を見逃すので、3 の走査を主にし、これは補助にする。
5. **S3 に置くファイルも調べる。** 加盟店が Dispute の証拠として上げる画像や PDF に、カード番号が写っていることがある。証拠のバケットを Amazon Macie で定期的に走査し、見つけたら加盟店に差し替えを求める（[disputes.md](disputes.md)）。

漏洩が見つかったら、[runbooks/incident-response.md](../runbooks/incident-response.md) の「カード番号の漏洩の疑い」に従う。ログの該当の行は、PCI DSS の手順（範囲の特定、消去の記録）に従って消し、消した記録を残す。

### 4.3 監査ログ（PCI DSS 要件 10）

アプリのログとは別に、監査ログを持つ。設計の詳細は [security.md](security.md) にあり、ここでは記録と保存の仕組みだけを書く。

| 記録する事象（要件 10.2.1 の抜粋） | どこで |
| --- | --- |
| カード会員データへの個人のアクセス | Vault の管理の操作、CDE の期限つきの権限の割り当て |
| 管理者の権限での操作 | CloudTrail（すべてのアカウント）、IAM Identity Center |
| 監査ログへのアクセス | log-archive の S3 のデータイベント、CloudWatch Logs のクエリ（CloudTrail） |
| 認証の失敗、認証の仕組みの変更 | IAM Identity Center、ダッシュボードのログイン（[auth-and-keys.md](auth-and-keys.md)） |
| 監査ログの開始・停止・一時停止 | CloudTrail・Config の変更（SCP で禁止したうえで、試みも記録する） |
| システムの部品の作成・削除 | CloudTrail |

- 各記録は、誰が、いつ、何を、成否、どこから、どの資源に、を持つ（要件 10.2.2）。
- 時刻は Amazon Time Sync Service に合わせる（要件 10.6）。
- 重要なセキュリティの仕組み（GuardDuty、CloudTrail、Network Firewall、ログの走査の処理、WAF）の停止や失敗を検知して、呼び出す（要件 10.7.2）。
- セキュリティの事象の確認は、GuardDuty・Security Hub の検出と、4.2 節の走査の結果を、自動の仕組みで毎日見る（要件 10.4.1・10.4.1.1）。人は、自動の仕組みが上げたものを毎営業日に確認する。

### 4.4 保持期間

**PCI DSS 要件 10.5.1：監査ログの履歴を少なくとも 12 か月保持し、直近の少なくとも 3 か月は、すぐに分析に使える状態にする。** これを、範囲内（CDE）と、接続先のアカウントのログに当てる。本体（prod）のログも、決済の調査（Dispute は数か月後に来る）のために同じ期間にそろえる。

| データ | すぐに使える場所（3 か月以上） | 保管（12 か月以上） |
| --- | --- | --- |
| CDE のアプリのログ | CloudWatch Logs（cde-live・cde-test）120 日 | log-archive の CDE 用のバケット（Object Lock のコンプライアンスモード）13 か月。Athena で検索する |
| 本体のアプリのログ | CloudWatch Logs（prod）120 日 | log-archive のバケット 13 か月 |
| 監査ログ、CloudTrail、Config、VPC フローログ、Network Firewall・WAF・ALB のログ | CloudWatch Logs または S3＋Athena で 120 日 | log-archive 13 か月 |
| メトリクス | AMP 150 日 | 保管しない（監査の対象ではない） |
| トレース | X-Ray 30 日 | 保管しない |

- 13 か月にするのは、12 か月の境目で監査の証跡が欠けないため。
- 「すぐに使える」は、Logs Insights か Athena で、その場で問い合わせられることとする。Glacier などの取り出しに時間がかかる層に置くのは、120 日を過ぎてからにする。
- **要件 10.5.1 の文言は、PCI SSC の原本の PDF を取得できず、二次資料（[KirkpatrickPrice](https://explore.kirkpatrickprice.com/videos/pci-v4-0-10-5-1-retain-audit-log-history-for-at-least-12-months)、[PCI DSS GUIDE](https://pcidssguide.com/what-are-the-pci-dss-log-retention-requirements/)）で確かめた（2026-09-26）。** 要件の番号（3.3.1、3.4.1、10.2.x、10.4.x、10.6、10.7.2 など）も同じ。**未検証**：E10 で、PCI SSC の文書ライブラリから v4.0.1 の原本を取得して照らし合わせる。

### 4.5 アクセス

- 本体のログは、Ops と、Ops が許可した Dev（読み取り専用）が読む。
- CDE のログは、CDE の期限つきの権限を得た Ops だけが読む。読んだこと自体が監査ログに残る。
- AI エージェントは、本番のログ・トレースへの経路を持たない。人が取り出したものを渡すときも、CDE のログは渡さない。

## 5. SLO、アラート

### 5.1 バーンレート

Slack と同じマルチウィンドウのバーンレートを使う。NFR-001 の 99.99% は、30 日のエラーバジェットが約 4.3 分しかない。

| 重さ | 長い窓 | 短い窓 | バーンレート | 意味 |
| --- | --- | --- | --- | --- |
| 呼び出し | 1 時間 | 5 分 | 14.4 | 1 時間で月のバジェットの 2%（約 5 秒ぶんの停止）を消費 |
| 呼び出し | 6 時間 | 30 分 | 6 | 6 時間で 5% を消費 |
| チケット | 3 日 | 6 時間 | 1 | このペースで月のバジェットを使い切る |

- 99.99% では、バーンレートのアラートより、**合成監視と症状のアラート（5 分間の API の 5xx の率が 1% を超える）のほうが先に鳴る**ことが多い。両方を置く。
- すべてのアラートは、対応する runbook の URL を注釈に持つ（Slack と同じ。CI で検査する）。

### 5.2 アラートの一覧

手順の列は、今ある runbook と、各 Epic で作る runbook（[runbooks/README.md](../runbooks/README.md) の 4 節）を指す。個別の runbook ができるまでは [incident-response.md](../runbooks/incident-response.md) の該当の節で対応する。

| アラート | 条件 | 重さ | 手順 |
| --- | --- | --- | --- |
| 決済の API の SLO の速いバーンレート | 5.1 節 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 合成監視の連続失敗 | 2 回続けて失敗（6 節） | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| コネクタの技術的な成功率の低下 | コネクタ別に 5 分間で 98% 未満 | 呼び出し | `connector-outage.md`（E3） |
| 承認率の低下 | 3.4 節 | 呼び出し（全体）・チケット（1 加盟店） | `connector-outage.md`（E3）。1 加盟店なら `fraud-spike.md`（E9） |
| 結果不明の滞留 | 最古が 15 分を超える、または件数が平常の 5 倍。24 時間を超えたものが 1 件でもあれば SEV2 | 呼び出し | `unknown-outcome-backlog.md`（E3） |
| 照合の不一致 | T+1 営業日で残る不一致が 1 件以上（チケット）、T+2 営業日で 1 件以上（呼び出し） | チケット → 呼び出し | `reconciliation-break.md`（E4） |
| 仮勘定の残高 | `suspense:*` の残高が 0 でない状態が 5 営業日続く | チケット | `suspense-balance.md`（E4） |
| 台帳の整合の検査の失敗 | 差が 1 口座以上（[ledger.md](ledger.md) の 4.2 節） | 呼び出し（SEV2） | `balance-drift.md`（E4） |
| 入金の失敗・返却 | `payout.failed` が平常の 3 倍、または `paid` の後の組戻し | チケット | `payout-failure.md`（E4） |
| 入金の着金の遅れ | `in_transit` のまま予定の着金日を 2 営業日過ぎた入金が 1 件以上 | 呼び出し | `payout-in-transit-delay.md`（E4） |
| カード番号の検出 | 4.2 節の走査で 1 件以上 | 呼び出し（SEV2 から） | `card-data-exposure.md`（E10）。それまでは [incident-response.md](../runbooks/incident-response.md) の「カード番号の漏洩の疑い」 |
| Webhook の配信の遅れ | 最初の配信の p95 が 10 秒を 15 分超える | チケット（30 分で呼び出し） | `webhook-delivery-backlog.md`（E5） |
| エンドポイントの一斉の無効化 | 自動で無効にしたエンドポイントが 1 時間に平常の 3 倍 | 呼び出し | `endpoint-mass-disable.md`（E5） |
| outbox の遅れ | 最古の行が 30 秒を超える | 呼び出し | `relay-backlog.md`（E1） |
| DR の複製の遅延 | `AuroraGlobalDBRPOLag` が 10 秒を 5 分超える | 呼び出し | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| デプロイ中の自動ロールバック、お金の不変条件のガード | [delivery.md](delivery.md) の 5 節 | 呼び出し | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| KMS のスロットリング | CDE の KMS の `ThrottlingException` が 1 件以上 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 鍵の削除の予約・無効化・キーポリシーの変更、ローテーションの失敗 | CloudTrail・AWS Config | 呼び出し | `key-rotation.md`（E10） |
| CDE の期限を過ぎた権限の割り当て | JIT の割り当てが期限（4 時間）を過ぎても残る | 呼び出し | `cde-access.md`（E10） |
| 不正の急増、カードテスティングの兆候 | [fraud.md](fraud.md) の 9 節 | 呼び出し | `fraud-spike.md`（E9） |
| API キーの漏洩の通知 | シークレットスキャンのパートナーからの通知 | 呼び出し（営業時間外も） | `api-key-leak.md`（E10） |
| 決済の経路の 429 | 決済の経路での 429 の率が 0.1% を超える（[rate-limiting.md](rate-limiting.md) の 7 節） | チケット | `rate-limit-override.md`（E10） |
| 重要なセキュリティの仕組みの失敗 | 4.3 節 | 呼び出し | `security-incident.md`（E10） |

呼び出しのアラートは、SLO か、お金・カード番号に関わる症状に限る。原因の側の指標（CPU など）はチケットとダッシュボードにとどめる。

## 6. 合成監視

CloudWatch Synthetics のカナリアを、大阪から東京へ（S3 ではリージョンを互いに）実行する。

| シナリオ | 環境 | 頻度 |
| --- | --- | --- |
| PaymentIntent の作成 → 確定（テスト用のカード）→ Webhook の受信 | test（模擬のアクワイアラ） | 1 分 |
| Checkout のページの表示と、テスト用のカードでの支払い | test | 5 分 |
| 社内の加盟店で、社内のカードの少額のオーソリ → 取り消し（void） | live（コネクタごと） | 5 分 |
| 社内の加盟店で、残高・台帳の照会 | live | 5 分 |

- live の合成監視の決済は、社内の加盟店のアカウントに閉じ、Payout と会計のレポートから除く。オーソリの取り消しで、実際の請求は起きない。手数料がかかるかは接続先の契約で確かめる。
- 合成監視の加盟店は、承認率などの業務の指標から除く。

## 7. ダッシュボード

| ダッシュボード | 主な中身 | 見る人 |
| --- | --- | --- |
| SLO | 3.2 節の SLI、バジェットの残り、バーンレート | 全員 |
| コネクタ | コネクタ別の技術的な成功率、承認率、応答時間の分布、結果不明、振り分けの状態 | Ops、Dev |
| お金 | 確定・返金・Dispute の件数と金額（通貨別）、台帳の検査、照合の不一致の経過日数、Payout の保留 | Ops、経理 |
| 配信 | outbox、Webhook の遅れと失敗、加盟店別の失敗の上位 | Ops |
| DR | Global Database の複製の遅延、大阪の待機の構成の健全性 | Ops |
| PCI | ログの走査の結果、CDE の権限の割り当て、セキュリティの仕組みの健全性 | Ops、セキュリティの担当 |

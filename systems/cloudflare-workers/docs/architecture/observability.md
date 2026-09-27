# Observability: Cloudflare Workers

基盤の運用の計測（ノード、isolate の集計、伝搬、ストレージ）、利用者向けのログとメトリクスとの分け方、合成監視、SLI と SLO、エラーの予算、アラートと runbook の対応、ダッシュボードとアクセスを決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0037](../decisions/0037-tail-sessions-and-tenant-logs.md) | 利用者の tail と保存するログ（ClickHouse） |
| [ADR-0039](../decisions/0039-usage-metering-pipeline.md) | 使用量は仕事をした部品が数え、束で東京へ送る |
| [ADR-0052](../decisions/0052-platform-telemetry-and-cardinality.md) | 運用のメトリクスはノード・リージョン・cordon までのラベルで AMP。関数ごとの値は呼び出しの記録から ClickHouse で集計する |
| [ADR-0053](../decisions/0053-slos-probes-and-burn-rate-alerts.md) | SLO は合成監視と実際の要求の両方で測り、リージョンごとのバーンレートで呼び出す。隔離・耐久性・取りこぼしは予算を持たない |

利用者向けのログ・tail・トレースの画面は [developer-tooling.md](developer-tooling.md) の 7・8 節、使用量の束は [limits-and-billing.md](limits-and-billing.md) の 5 節にある。各領域が「SLI の追加の依頼」として挙げたものを、この文書の 5 節の表にまとめた。

本家の振る舞いは、2026-09-27 に本家のブログで確かめた。

## 1. 全体の流れ

```
エッジのノード・DO のホスト
 ├─ ランタイム ─呼び出しの記録─▶ スーパーバイザー ─┬─▶ 使用量の送り手 ─▶ Kinesis（usage-<r>）─▶ 東京の集計（limits-and-billing）
 │                                                 ├─▶ Vector ─▶ Kinesis（logs-<r>）─▶ 東京の ClickHouse（tenant_logs、invocation_rollup_1m）
 │                                                 └─▶ tail の中継（見られている関数だけ）─▶ 東京の tail ハブ
 ├─ 各部品 ─メトリクス─▶ OTel Collector（ノード）─▶ AMP（cp-prod の運用のワークスペース）─▶ Grafana・Alertmanager
 ├─ 各部品 ─トレース（1% ＋ 5xx・遅い要求）─▶ Collector（末尾の標本）─▶ X-Ray
 ├─ 各部品 ─基盤のログ─▶ Vector ─▶ S3（Parquet、30 日）＋ CloudWatch Logs（警報の分、7 日）
 └─ スーパーバイザー ─セキュリティの事象─▶ security のアカウント（運用の画面に出さない）

probe のアカウント（5 リージョンの外と国内の ISP の地点）─合成の要求─▶ GA の IP ─▶ ……
                                                     └─ 結果 ─▶ AMP
```

- 利用者の画面・API（ログ、関数のメトリクス）は ClickHouse を読む。運用の画面は AMP を読む。課金は使用量の集計を読む。3 つは同じ呼び出しの記録から来る（[ADR-0052](../decisions/0052-platform-telemetry-and-cardinality.md)）。
- ノードは、テレメトリの経路が止まっても要求の処理を止めない。送り手はローカルの spool（使用量）とメモリの上限（ログ）を持ち、溢れたら古いものを捨てて数を記録する。

## 2. 基盤の計測

### 2.1 ノード

| 部品 | 主な指標 | ラベル |
| --- | --- | --- |
| 入口のプロキシ | 要求の数（結果ごと：関数、421、404、508、転送、断り）、TLS の握手の数と失敗（理由ごと）、基盤の遅延（受けてから関数に渡すまで、関数の応答から返すまで）のヒストグラム、証明書の LRU の当たり、SNI の先読みの数 | `region`・`az`・`node_id` |
| ホームへの転送 | 転送の率、断りの率（理由：CPU・メモリ・遅延）、転送の遅延 | 同上 |
| スーパーバイザー | ランタイムのプロセスの数と状態、再起動の数、OOM の数、監視のスレッドの心拍の途切れ、プロセスの入れ替えの完了、性能カウンターの読み出しの失敗 | ＋`cordon`・`runtime_version` |
| isolate の集計 | 温かい isolate の数、冷たい起動の数と時間のヒストグラム（コードあり・なし）、退避の数（理由ごと）、`exceededCpu`・`exceededMemory` の数、プロセスのメモリの使用率（soft・hard の段） | ＋`cordon` |
| 外向きのプロキシ | サブリクエストの数と結果、拒否の数（理由ごと。セキュリティの流れにも）、接続のプールの数、DNS の解決の失敗、KV の L1 の当たり | `region`・`az`・`node_id` |
| 受け手 | `applied_seq`、中継の先頭との差、束の CRC・`db_id` の失敗、取り直しの数、LMDB の使用率、最古の読み込みの年齢 | 同上 |
| コードのキャッシュ | 当たりの率、取得の遅延（中継・S3・東京）、取得の失敗 | 同上 |
| ホスト | CPU（ユーザー・システム・steal）、メモリ、gp3 の遅延、ネットワーク、PMU の読み出しの成否 | 同上 |

- `account_id`・`script_id`・`hostname` をラベルにしない（CI で検査）。関数ごとの値は ClickHouse で見る（2.3 節）。

### 2.2 伝搬とストレージ

| 対象 | 指標 | 出どころ |
| --- | --- | --- |
| 設定の伝搬 | 変更ごとの `committed_at` から全ノードの適用まで（p50・p99）、取りこぼし（60 秒で埋まらない抜け）、局所の遅れのノードの数、全体の古さ（中継の先頭の停止の時間）、採番していない outbox の数と最古の年齢 | 配信の元・中継（[deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 9.1 節） |
| デプロイの伝搬 | デプロイごとの全ノードの適用と中継のキャッシュの到着まで | 同上 |
| 本番の探りのデプロイ | 1 分ごとの合成のデプロイで、全リージョンで新しい版が応答するまで | probe |
| KV | 見えるまでの時間（リージョンの組ごと）、L1・L2 の当たり、古くても返す段の回数、429 の率、書き込みの遅延、版の戻り | [kv-store.md](kv-store.md) の 8 節 |
| オブジェクト | 操作ごとの遅延と 5xx、S3 の 503、STS のキャッシュ、CRR の遅れ、ライフサイクルの遅れ | [object-storage.md](object-storage.md) の 15 節 |
| Durable Objects | 確定の遅延、引き継ぎの数と時間、`unavailable` の数、`overloaded` の率、WAL の転送の遅れ、ログのノードのディスク、アラームの遅れ、カナリアの抜け | [durable-objects.md](durable-objects.md) の 17 節 |
| キュー・cron | 送信の遅延と失敗、配送の開始までの遅れ、バックログ、DLQ への移動、cron の起動の遅れと `missed` | [queues-and-cron.md](queues-and-cron.md) の 14 節 |
| DR の複製 | `AuroraGlobalDBRPOLag`、DynamoDB の `ReplicationLatency`、S3 の `ReplicationLatency`・`OperationsFailedReplication` | CloudWatch |
| 利用者のログの経路 | tail の到着の遅延、捨てたイベント、ログの取り込みの遅延、問い合わせの p95 | [developer-tooling.md](developer-tooling.md) の 16 節 |
| 使用量の経路 | 束の遅れ、突き合わせの差、spool で捨てた束、重複 | [limits-and-billing.md](limits-and-billing.md) の 16 節 |

### 2.3 関数ごとの値（ClickHouse）

- `invocation_rollup_1m`：`(account_id, script_id, version_id, region, outcome)` ごとの 1 分の件数、CPU 時間と壁時計の時間のヒストグラム、冷たい起動の数、サブリクエストの数。呼び出しの記録から集計する。
- 利用者の画面（要求・エラー・CPU 時間・遅延のメトリクス。intent の MVP）は、これを読む（[developer-tooling.md](developer-tooling.md) の 8 節の問い合わせのサービスと同じ `account_id` の条件と行の方針）。保持は 90 日（仮）。
- 運用者は、うるさい隣人（1 つの関数がノードの CPU を占める）の調べにだけ使う。関数の名前は運用の画面に出さず、ID で扱う。

### 2.4 セキュリティの事象

seccomp の違反、脱出の探りの失敗、隔離（`cq-quarantine`）の数、外向きの拒否の詳細、V8 の修正の遅れは、`security` のアカウントへ別に流す（[sandbox-and-security.md](sandbox-and-security.md) の 11 節）。運用の画面には件数だけを出す。

## 3. ログ

**利用者のログと基盤の観測を分ける**（2026-09-27、統合の工程で明示した）。

| | 利用者のログ・関数のメトリクス | 基盤の観測（運用） |
| --- | --- | --- |
| 持ち主の文書 | [developer-tooling.md](developer-tooling.md) の 7・8 節（tail、保存するログ、`tenant_logs`）と、この文書の 2.3 節（`invocation_rollup_1m`） | この文書（2〜9 節） |
| 中身 | 利用者の `console.log`・例外・`spans`（伏せた後）、関数ごとの件数・CPU・時間 | ノード・部品の指標、基盤のログ、トレース、合成監視、SLI |
| 置き場所 | ClickHouse（東京）、再送用の S3 | AMP、X-Ray、S3（Parquet）、CloudWatch Logs |
| 見る人 | 利用者（`account_id` の行の方針）。運用者は同意と 2 人の承認で 24 時間だけ | Ops・Dev（IAM Identity Center） |
| 利用者のデータ | 含む（伏せた後） | 含めない（`account_id`・`script_id`・ホスト名をラベルにしない。パスを残さない） |
| 保持 | 有料 7 日・無料 3 日、集計 90 日（仮） | 30 日・7 日 |
| 法務 | L2（通信の秘密）、L7 | L2（アクセスのログ）、L7 |

- 両方は同じ呼び出しの記録から来るが、経路（Kinesis の流れ）と保存を分ける。運用の画面から利用者のログを読まない。利用者の画面は AMP を読まない。
- 運用者が関数ごとの値を見るのは、うるさい隣人の調べで `invocation_rollup_1m` を ID で問い合わせるときだけで、監査ログに残す（9 節）。


| ログ | 中身 | 置き場所 | 保持 |
| --- | --- | --- | --- |
| 入口のアクセスのログ | `<Brand>-Ray`、時刻、ホスト名の ID、関数と版、結果、状態、時間、受けたノード・ホームのノード。**要求の本文、`Authorization`・`Cookie`、クエリの値を残さない** | S3（Parquet） | 30 日（法務の確認待ち。intent の L2） |
| 部品のログ | 構造化の JSON。エラー、状態の変化 | S3 ＋ CloudWatch Logs（警報に要る分） | 30 日・7 日 |
| 利用者のログ | 伏せた `console.log`、例外 | ClickHouse（developer-tooling） | 3・7 日 |
| 監査ログ | [security.md](security.md) の 6 節 | Aurora ＋ `log-archive` | 18 か月 |

- 利用者のドメインの名前やパスは利用者のデータを含みうる。運用のログでは、ホスト名は ID で、パスは残さない（ルートの ID だけ）。

## 4. ラベルと時系列の数

| 対象 | 見込み（S1） |
| --- | --- |
| ノード（エッジ 21、DO のホスト 15、他の群 約 40） | 約 80 |
| ノードあたりの時系列 | 約 5,000（部品 × 指標 × cordon × ヒストグラムの桶） |
| 合計 | 約 40 万 |

- AMP の上限（ワークスペースの有効な時系列の数）は既定 5,000 万（直近 30 分の使用で 200 万から自動で調整。引き上げは最大 15 億）。取り込みの速さは有効な時系列の 1/30 で最大 1 秒 1,666,666（[AMP quotas](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP_quotas.html)、2026-09-27 に確認）。S1 の約 40 万は十分に収まる。S3 の規模（数万のノード）では、ノードの単位のラベルを、リージョンの集計の記録の規則に置き換える。

## 5. 合成監視

[ADR-0053](../decisions/0053-slos-probes-and-burn-rate-alerts.md)。`probe` のアカウントから、利用者と同じ公開の経路（DNS → GA → NLB → ノード）を通る。

| 探り | 頻度 | 地点 | 見るもの |
| --- | --- | --- | --- |
| 最小の関数（固定の応答） | 10 秒 | 5 リージョンの外の VPC、国内の複数の ISP の外部の地点（提供元は E4 の `isp-vantage-probes` で選ぶ） | 可用性、TTFB、TLS の握手（NFR-003、K3） |
| 各 cordon の探りの関数 | 1 時間 | 各リージョンの各 cordon | 脱出の探り（sandbox-and-security の 9.1 節） |
| 合成のデプロイ | 1 分 | 東京の制御プレーンから | デプロイの伝搬（NFR-008） |
| KV の合成の書き込み・読み込み | 10 秒・1 秒 | 各リージョン | 見えるまでの時間（NFR-009） |
| オブジェクトの PUT の直後の GET・LIST | 1 分 | 各リージョンの関数と外の S3 のクライアント | 強い整合 |
| DO のカナリア（連番の書き込みと読み込み） | 1 秒 | 各リージョン | 抜け・戻り |
| キューの合成の生産者と消費者 | 10 秒 | 東京と各リージョン | 配送の遅れと抜け |
| 合成の cron | 1 分 | 東京 | 起動の遅れと抜け |
| 偽のシークレットを出す関数 | 1 時間 | 各リージョン | ログ・tail に平文が出ない |
| GA の IP への直接の要求（`ga-primary`・`ga-standby`） | 30 秒 | 外 | アクセラレーター自体の障害 |
| 既定のドメインの DNS | 1 分 | 外 | Route 53 の解決 |

- 合成監視の関数は `ci-internal` の cordon に置く（sandbox-and-security の 5.1 節）。利用者のデータを含まない。
- 合成監視は、テナントと同じ制限を受ける。制限に当たったら、それ自体を異常にする。

## 6. SLI と SLO

### 6.1 SLO（S1、30 日）

SLO の値の正本は [runbooks/README.md](../runbooks/README.md) の 1 節。この表は計測の側の記述で、値を変えるときは runbooks を先に変える。

| SLI | 定義 | SLO | NFR | 計測 |
| --- | --- | --- | --- | --- |
| 関数の実行の可用性 | リージョンごと・5 分ごとに、合成監視の成功の割合と、実際の要求のうちプラットフォームが原因の失敗でない割合の、悪い方 | 99.99% | NFR-004 | 5 節、入口のプロキシ |
| 基盤の遅延 | 入口のプロキシの基盤の遅延（受けてから関数に渡すまで＋応答を返すまで） | p50 2ms、p99 10ms | NFR-002 | 2.1 節 |
| 冷たい起動 | コードありの冷たい起動 p99、コードなし p99 | 5ms、50ms | NFR-001 | 2.1 節 |
| 国内の TTFB | 国内の ISP の地点からの最小の関数の TTFB p50 | 30ms | K3 | 5 節 |
| 制御プレーンの可用性 | 管理 API の要求のうち 5xx・タイムアウトでない割合 | 99.9% | NFR-004 | ALB、合成監視 |
| 設定の伝搬 | 変更ごとの全ノードの適用まで | p99 10 秒 | NFR-008 | 2.2 節 |
| デプロイの伝搬 | デプロイごとの全ノードの適用と中継のキャッシュまで | p99 30 秒 | NFR-008 | 2.2 節 |
| ストレージの読み込み | KV・オブジェクト・DO の読み込みの成功の割合 | 99.99% | NFR-004 | 各領域 |
| ストレージの書き込み | 同じく書き込み | 99.9% | NFR-004 | 各領域 |
| KV の見えるまでの時間 | リージョンの組ごと | p99 70 秒 | NFR-009 | kv-store の 8 節 |
| V8 の修正の遅れ | T+0 から全ノードの報告まで | 24 時間以内（100%） | NFR-007 | `v8_security_patches` |
| 隔離 | 脱出の探りの失敗、テナントをまたぐ到達 | 0 件 | NFR-006 | 5 節、sandbox-and-security |
| 耐久性 | DO のカナリアの抜け、KV の版の戻り、失われたキューの `msg_id` | 0 件 | NFR-010 | 各領域 |
| 伝搬の取りこぼし | 60 秒で埋まらない番号の抜け | 0 件 | NFR-008 | 2.2 節 |
| 監査の完全さ | 監査の鎖と WORM の写しの食い違い | 0 件 | — | security の 6 節 |

- **プラットフォームが原因の失敗**：`internalError`、`evicted`、ホームへの転送の失敗、ランタイムのプロセスの落ち、コードの取得の失敗、外向きのプロキシの停止による失敗。利用者のコードの例外・制限の超過・利用者のオリジンの失敗は含めない。分類の表は QA が確認する（[ADR-0053](../decisions/0053-slos-probes-and-burn-rate-alerts.md)）。
- SLA（利用者への約束と返金の条件）は、法務の確認の後にこの SLI から作る。

### 6.2 エラーの予算とバーンレート

99.99% の 30 日の予算は約 4.3 分（窓は [runbooks/README.md](../runbooks/README.md) の 1 節）。

| 重さ | 長い窓 | 短い窓 | バーンレート |
| --- | --- | --- | --- |
| 呼び出し | 1 時間 | 5 分 | 14.4 |
| 呼び出し | 6 時間 | 30 分 | 6 |
| チケット | 3 日 | 6 時間 | 1 |

- リージョンごとに計算する。全体の平均で薄めない。
- 予算を使い切ったリージョンでは、ランタイムの週 1 回の取り込みと AMI の入れ替えを止める（V8 の緊急の経路は止めない。[delivery.md](delivery.md) の 5 節）。
- 0 件の SLO（隔離、耐久性、取りこぼし、監査）は予算を持たない。1 件で呼び出す。

## 7. アラートと runbook

**アラートの一覧（名前、条件の初期値、重さ、手順、手順を作る Story）の正本は [runbooks/README.md](../runbooks/README.md) の 5.1 節** で、この文書には写さない（2026-09-27 に、ここの表を正本と食い違わないよう外した）。この節は、その一覧を実装する側の約束だけを書く。

- **規則の置き場所**：アラートの規則は AMP の記録の規則と Alertmanager の規則として、開発リポジトリの `infra/` に置く。規則の名前は runbooks/README.md の 5.1 節の手順の名前（`kv-staleness-slo-breach` など）に合わせる。
- **注釈**：すべての規則は `runbook_url`（runbooks/README.md の 5.1 節の手順、個別の手順ができるまでは [incident-response.md](../runbooks/incident-response.md) などの該当の節）と `severity`（`page`・`ticket`・`notify`）を持つ。CI で検査し、5.1 節の表にない規則と、表にあって規則のない行を、どちらも失敗にする。
- **経路**：`page` は当番の呼び出し、`ticket` は Ops のチケット、セキュリティの事象（seccomp の違反、脱出の探り、隔離の急増、ADK の復号の急増、break-glass）はセキュリティの当番へ送る（2.4 節）。
- **条件の元**：可用性のバーンレートは 6.2 節、伝搬は 2.2 節、ストレージは各領域の SLI（2.2 節の表）、DR の複製の遅れは CloudWatch の指標を AMP に取り込んで判定する。
- **予算を持たない指標**（隔離、耐久性、伝搬の取りこぼし、監査の食い違い）は、1 件で鳴る規則を持つことを CI で確かめる（[ADR-0053](../decisions/0053-slos-probes-and-burn-rate-alerts.md) の Confirmation）。

## 8. ダッシュボード

| 画面 | 中身 |
| --- | --- |
| 全体 | リージョンごとの可用性と予算の残り、要求の数、基盤の遅延、伝搬の p99、進行中の配信の波 |
| リージョン | ノードごとの CPU・メモリ・断り・冷たい起動、NLB の健全なターゲット、`drain` の状態 |
| ランタイムの配信 | 波ごとの関門の値（新旧の版の比べ）、`runtime_version` ごとの落ち・OOM・`exceededCpu` |
| 伝搬 | 変更ごとの伝搬、リージョンごとの最小の `applied_seq`、局所の遅れのノード、outbox |
| ストレージ | KV・オブジェクト・DO・キューの SLI |
| DR | 複製の遅れ（Aurora、DynamoDB、S3、DO の WAL） |
| 原価 | リージョンごとの計算・転送・DT-Premium の日次（Cost and Usage Report）、[capacity.md](capacity.md) の 8 節の単価の実測 |

## 9. アクセス

- 運用の画面（Grafana）は IAM Identity Center で入る。読み込みは Ops・Dev、セキュリティの事象の画面はセキュリティの担当だけ。
- 利用者の関数ごとの値（ClickHouse）への運用者の問い合わせは、関数の ID で行い、監査ログに残す。利用者のログの中身の閲覧は、同意と 2 人の承認（developer-tooling の 8.4 節）。
- エージェントには本番のテレメトリへの経路も与えない（[ADR-0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md)）。調査では、人が取り出した指標の値とログの抜き出し（利用者のデータを含まないもの）を渡す（[security.md](security.md) の 5 節）。

## 10. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0052](../decisions/0052-platform-telemetry-and-cardinality.md) | 運用のメトリクスは AMP、ラベルはノード・リージョン・cordon・部品・版まで。関数ごとの値は呼び出しの記録を ClickHouse で 1 分ごとに集計する。トレースは 1% と 5xx・遅い要求 |
| [0053](../decisions/0053-slos-probes-and-burn-rate-alerts.md) | SLI は合成監視と実際の要求のプラットフォームが原因の失敗の悪い方。リージョンごとのバーンレート。隔離・耐久性・取りこぼし・監査は 1 件で呼び出す |

## 11. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | AMP・Grafana・Alertmanager、ノードの OTel Collector、ラベルの禁止の CI の検査 |
| E1 | `probe` のアカウントと、5 リージョンの外からの最小の関数の合成監視 |
| E1 | 基盤のログの Vector → S3・CloudWatch Logs |
| E2 | スーパーバイザー・isolate の集計の指標 |
| E4 | 国内の ISP の外部の地点の選定と合成監視、TTFB の実測 |
| E4 | 入口のプロキシのプラットフォームが原因の失敗の分類と、可用性の SLI |
| E5 | 伝搬の SLI とダッシュボード、合成のデプロイ |
| E6 | `invocation_rollup_1m` と利用者のメトリクスの画面・API（developer-tooling と合わせて） |
| E12 | SLO の文書、SLA の草案（法務の確認の後）、全アラートの runbook の注釈 |

## 12. 未解決の問い

- 国内の ISP の外部の地点の提供元と費用。
- AMP の有効な時系列の上限と、S3 の規模でのリージョンの集計への切り替えの時期。→ 上限は既定 5,000 万（4 節）。切り替えの時期は S3 の前に決める。
- プラットフォームが原因の失敗の分類の境目（利用者のオリジンが遅いときのホームへの転送の失敗など）。
- 入口のアクセスのログの保持（30 日）と、通信の秘密（L2）。
- `invocation_rollup_1m` の保持（90 日は仮）。

### 決定

2026-09-27 の既定案。

- 国内の地点は E4 の前に 3 つ以上の ISP を選ぶ。選べるまで、東京・大阪の外の VPC の合成監視で代える（ISP の経路は測れない）。
- AMP の上限は既定 5,000 万と確かめた（4 節）。ノードあたり 5 万を超えないことを CI で見る。
- 分類の境目は、利用者のオリジン・利用者の関数の遅さに起因するものは含めない側に倒し、QA が表を承認する。
- アクセスのログは 30 日で作り、法務の確認で変える。
- `invocation_rollup_1m` は 90 日で始める。

## 13. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：SLI の分類の誤りで SLO が甘くなる。分類の表の QA の承認と、月次の合成監視と実際の要求の差の見直し。
- リスク：テレメトリの時系列の爆発で運用の画面が止まる。ラベルの禁止の CI の検査。
- リスク：運用のログに利用者のデータが出る。ログの項目の許可の一覧と、探りの関数での確認。
- 本番での検証：5 節の合成監視の全部を、6.1 節の SLO に結び付ける。

**runbooks/README.md**

- SLO の表：6.1 節。
- アラートと手順の表：runbooks/README.md の 5.1 節が正本（この文書の 7 節は実装の約束だけ）。
- 手順：[incident-response.md](../runbooks/incident-response.md)、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md)。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `invocation_rollup_1m`（ClickHouse） | `account_id`、`script_id`、`version_id`、`region`、`outcome`、`minute`、`count`、`cpu_us_hist`、`wall_ms_hist`、`cold_count`、`subrequests` | `account_id` の行の方針。90 日 |
| 運用のメトリクス（AMP） | 2 節の指標 | テナントのラベルなし |
| 入口のアクセスのログ（S3） | `access-logs/<region>/<date>/<hour>/*.parquet` | 30 日 |
| 基盤のログ（S3、CloudWatch Logs） | 部品ごと | 30 日・7 日 |
| 合成監視の結果（AMP） | `probe`・地点・対象ごと | |
| `slo_reports`（制御プレーン） | `period`、`region`、`sli`、`value`、`budget_remaining` | 月次の報告と SLA の元 |

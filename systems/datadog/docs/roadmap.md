# Roadmap: Datadog

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E4 と E7 の最小の部分で、エージェント → `intake-gateway` → MSK → インジェスター → S3 のブロック → クエリ → モニター → 通知を端から端まで貫き、1 つのホストの CPU の系列がグラフに出て、閾値を超えたらメールが届くところまで作ってから、機能を広げる。MSK の確定の後の 202、参照の実装との比べ、2 つの写しのバイトの一致、水位を待つ評価、FORCE RLS、自己監視の独立した経路は、最初から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E2 の前：MSK のブローカーの構成とパーティションの数、GB/秒あたりの費用（`msk-throughput-poc`）。
  - E3 の前：時系列のコーデックの比べ（`tsdb-codec-poc`）、インジェスターの系列あたりのメモリー（`ingester-memory-poc`）。
  - E5 の前：ブルームフィルターの誤検出の率と大きさ、日本語の 2-gram（`log-bloom-poc`）。
  - E6 の前：テールサンプリングの待ちとメモリー（`tail-sampling-memory-poc`）。
- **規則は 1 つのコードに。** コーデックとブロックは `crates/tsdb`、クエリの言語と IR は `crates/query-lang`、評価は `crates/monitor-eval`、セグメントは `crates/segstore`、データのアクセスの制限の付加は IR のコンパイラにだけ書く。
- **契約を先に固定する。** 取り込みの形式（内部の Protobuf、OTLP の対応）、系列の鍵の作り方、`codec_id`、ブロックとセグメントの形式、クエリの言語と IR の既定の意味、モニターの状態の遷移の決定表、キーの形式とヘッダー、Webhook の署名は、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L9）。下の表で「法務：L*」と書いた Story が当たる。
- **うるさい隣人を早く試す。** 負荷の生成器を E2 で作り、縮めた規模のうるさい隣人の場面を、E2 から夜間に流し続ける。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（Rust と TypeScript、参照の実装の枠）、Aurora と RLS、MSK、ECS（Fargate と EC2）、S3、フラグ、自己監視の独立した経路、監査ログ、大阪の骨格 | 設計中 |
| E2 取り込み | `intake-gateway`、取り込みのキー、OTLP と StatsD、受け付けの窓、割り当てと背圧、エージェント、負荷の生成器 | 未着手（前に MSK の PoC） |
| E3 時系列の保存 | 系列の鍵と索引、ヘッド、コーデック、ブロックの書き出しと写し、ロールアップ、合わせ、保持の層 | 未着手（前にコーデックとメモリーの PoC） |
| E4 メトリクスのクエリ | クエリの言語と IR、計画と扇形の展開、部分の集計、キャッシュ、分布とパーセンタイル、カーディナリティの上限とタグの選択 | 未着手（文法の確定は法務：L9） |
| E5 ログ | パイプライン、PII のマスク、索引の振り分け、セグメントとブルームフィルター、検索とファセット、ライブテール、アーカイブと再水和、ログから作るメトリクス | 未着手（前にブルームフィルターの PoC。PII の既定は法務：L1、索引は法務：L3、削除は法務：L5） |
| E6 トレース | スパンの取り込み、組み立て、テールサンプリング、トレースの保存と検索、サービスマップ、RED メトリクス、ログとの結び付け | 未着手（前にテールサンプリングの PoC） |
| E7 モニター | 評価のシャード、水位、状態の機械、データなし、マルチアラート、フラッピング、ミュートとダウンタイム、評価の記録と再生 | 未着手 |
| E8 通知と連携 | メール、チャット、汎用の Webhook、オンコールのサービス、本文の雛形、重ねない送信 | 未着手（通知の本文は法務：L2、メールは法務：L8） |
| E9 ダッシュボード | ウィジェット、テンプレートの変数、クエリの束ね、ライブの更新、共有 | 未着手（画面の寄せ方は法務：L9、画面の計測は法務：L3） |
| E10 SLO とインシデント | SLO、エラーバジェット、バーンレートのアラート、軽いインシデント管理 | 未着手 |
| E11 組織・権限・監査 | 組織、利用者、チーム、役割、SSO・SCIM、データのアクセスの制限、アプリケーションキー、監査ログ | 未着手（監査ログの保持は法務：L6） |
| E12 利用量の計測 | ホスト、カスタムメトリクス、ログ、スパンの計測、時間ごとの集計、画面と API、課金のシステムへの受け渡し | 未着手（表示の文言は法務：L7） |
| E13 本番の準備と GA の判定 | 負荷試験、うるさい隣人の試験、DR の訓練、自己監視の訓練、外部のペンテスト、GA の判定 | 未着手（GA の判定は法務：L1・L2・L5・L6・L7） |
| E14 RUM（MVP の後） | ブラウザ・モバイルの実ユーザーの計測 | 未着手（MVP の後。法務：L4） |
| E15 合成監視（MVP の後） | 外からの API・ブラウザの試験、監視の拠点 | 未着手（MVP の後） |
| E16 異常検知と予測（MVP の後） | 異常検知・予測・外れ値のモニター | 未着手（MVP の後） |
| E17 PromQL と Prometheus の取り込み（MVP の後） | PromQL を IR にコンパイル、remote write の受け口 | 未着手（MVP の後） |
| E18 アーカイブと履歴の拡張（MVP の後） | 利用者の S3 のバケットへのアーカイブ、1 時間より古いメトリクスの取り込み（バックフィルのブロック） | 未着手（MVP の後） |
| E19 海外のリージョン（MVP の後） | 組織をリージョンに固定する、リージョンごとのセル | 未着手（MVP の後。法務：L2） |

E1〜E13 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。領域の文書（[architecture/README.md](architecture/README.md) の 7 節）を書くときに、各領域の「Story の候補」で直す。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Datadog の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`crates/tsdb`・`query-lang`・`monitor-eval`・`segstore` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント（本番、検証、自己監視の別のアカウント）、SCP、VPC、egress の専用の経路（通知の送信）。データの所在の約束は法務：L2 |
| `edge-and-intake-endpoints` | NLB・CloudFront・WAF、ドメイン（`intake`・`otlp`・`api`・`app.<brand>.<domain>`）、TLS |
| `ecs-fargate-and-ec2-capacity` | Fargate のサービスと、EC2（NVMe）のキャパシティープロバイダー、AMI の更新の流れ（ADR-0001） |
| `terraform-root-modules` | ルートモジュールとポリシーの検査 |
| `aurora-rls-baseline` | 管理の DB の RLS、`SET LOCAL app.tenant_id`、RLS の検査、RLS の外の表と組織をまたぐ経路の許可リスト（ADR-0003） |
| `msk-cluster-baseline` | MSK のクラスタ、トピック、複製と `min.insync.replicas`、パーティションの組の割り当て、消費者の枠（ADR-0002） |
| `s3-buckets-baseline` | 保持の区分の接頭辞、ライフサイクル、バージョニング、SSE-KMS、大阪への CRR（ADR-0009） |
| `ci-pipeline-baseline` | PR の関門、Rust と TypeScript、参照の実装の比べの枠、試験のベクトル、ファジングの夜間、テストの緩和の検出、依存の禁止の一覧（ADR-0001） |
| `flags-appconfig` | `release.*`・`ops.*` のフラグ |
| `self-monitoring-baseline` | 自己監視の別のアカウント（大阪）の AMP・CloudWatch・Grafana（OSS、Fargate）、呼び出しの直接の連携、外からの見張り（`canary`）の骨格（[runbooks/README.md](runbooks/README.md) の 5 節） |
| `audit-log-table-and-archive` | 監査ログの表と、S3 の Object Lock への写し。保持は法務：L6 |
| `osaka-warm-standby` | 大阪の骨格、Aurora Global Database、CRR の遅れの監視 |

### E2 取り込み

| Story | 内容 |
| --- | --- |
| `msk-throughput-poc` | PoC：S1 のピークの 2 倍の書き込み、ブローカーの大きさ、パーティションの数、202 の p99、GB/秒あたりの費用 |
| `intake-keys` | 取り込みのキー（`<brand>_ik_`、チェックサム、ハッシュでの保存）、組織ごとの本数の上限、失効の伝わり 60 秒、シークレットスキャンへの登録の準備 |
| `intake-gateway-metrics` | メトリクスの API（JSON）、タグの正規化、系列の鍵、受け付けの窓、MSK の確定の後の 202（ADR-0002） |
| `otlp-receiver` | OTLP の gRPC・HTTP（メトリクス・ログ・トレース）、資源の属性とタグの対応 |
| `statsd-wire-format` | StatsD（タグの拡張）の解析（エージェントの中） |
| `tenant-quotas-and-backpressure` | 組織ごとのトークンバケット、割り当ての配り直し、429・503 と `Retry-After`、全体の溢れでの優先（ADR-0003） |
| `agent-core` | エージェントの骨格（設定、送信、ディスクの待ち行列、送り直し）、ホストのメトリクス |
| `agent-containers-and-k8s` | Docker・containerd・kubelet のメトリクス、DaemonSet、タグの自動の付与 |
| `agent-log-tailing` | ファイルとコンテナのログの追跡、位置の記録、複数行 |
| `agent-distribution` | パッケージ（deb・rpm・msi）、コンテナのイメージ、署名、更新の流れ |
| `load-generator` | 負荷の生成器と、縮めた規模のうるさい隣人の夜間の場面（quality.md の 2.2.1 節 E） |

### E3 時系列の保存

| Story | 内容 |
| --- | --- |
| `tsdb-codec-poc` | PoC：Gorilla の形と ALP などの比べ（1 点あたりのバイト、符号化と復号の速さ） |
| `ingester-memory-poc` | PoC：系列あたりのヘッドと索引のメモリー、有効な系列 1 億の必要量 |
| `codec-v1` | `codec_id` 1 のチャンク、試験のベクトル、ファジング（ADR-0004） |
| `series-index` | 系列の索引、転置の表、鍵の衝突の検出 |
| `ingester-head` | ヘッド、遅れのバッファー、同じ時刻の置き換え、MSK の読み出し、2 つの写し |
| `block-writer-and-manifest` | ブロックの形式、貸し出し、写しのバイトの比べ、S3 とカタログとオフセットの確定 |
| `rollups-1m-1h` | 1 分・1 時間のロールアップ、累積の指標の差への直し |
| `head-checkpoints` | ヘッドのチェックポイントと再起動、大阪への写し |
| `block-compaction-and-tiers` | 日のブロックへの合わせ、層の移し、保持の削除（ADR-0009） |
| `tsdb-reference-compare` | 参照の実装 `tsdb-ref` と比べの枠（quality.md の 2.2.1 節 A・B） |

### E4 メトリクスのクエリ

| Story | 内容 |
| --- | --- |
| `query-language-and-ir` | クエリの言語の構文解析、IR、既定の意味の決定表、WASM（ADR-0007）。文法の確定は法務：L9 |
| `query-planner-and-fanout` | 計画、時間とシャードへの扇形の展開、層の選び方、不完全の印 |
| `query-partial-aggregation` | 保存の側の絞り込みと部分の集計、合わせ |
| `query-functions-and-formulas` | 関数と式の最初の一覧 |
| `query-results-cache` | 閉じた時間の部分のキャッシュ、世代の番号での無効化 |
| `query-admission-and-fairness` | 費用の見積もり、組織ごとの並行の上限、重み付きの公平なキュー |
| `exponential-histograms` | 指数のヒストグラムの保存、合わせ、パーセンタイル（distributions-and-sketches の領域） |
| `cardinality-limits-and-overflow` | 有効な系列の上限、作成の速さの上限、溢れの系列、通知（ADR-0006） |
| `tag-selection` | 指標ごとのクエリに残すタグの選択 |
| `query-property-tests` | クエリの性質ベーステストと参照の実装 `query-ref`（quality.md の 2.2.1 節 C） |

### E5 ログ

| Story | 内容 |
| --- | --- |
| `log-bloom-poc` | PoC：ブルームフィルターの誤検出の率と大きさ、日本語の 2-gram の効き、検索の速さ |
| `log-intake` | ログの API と OTLP のログ、受け付けの窓（過去 18 時間）、大きさの上限 |
| `log-pipelines` | パイプラインの規則（JSON・テキストの解析、付け替え、型） |
| `pii-scrubbing` | PII のマスク（検出の種類、日本の番号の形式）、既定の規則。既定の有効化は法務：L1 |
| `log-index-routing` | 索引、除外のフィルター、サンプリングの率、1 日の上限 |
| `log-segments-and-catalog` | セグメントの形式、ブルームフィルター、カタログ、合わせ（ADR-0005） |
| `log-search-and-facets` | 検索の文法、ファセット、時間ごとの件数。中身を読む処理は法務：L3 |
| `live-tail` | `logs` のトピックからのライブテール（制限で絞る） |
| `log-archive-and-rehydration` | アーカイブと再水和 |
| `logs-to-metrics` | ログから作るメトリクス |
| `log-deletion-requests` | 削除の請求の受け付けと、セグメントの書き直しの枠。手段と期限は法務：L5 |

### E6 トレース

| Story | 内容 |
| --- | --- |
| `tail-sampling-memory-poc` | PoC：完成の待ちとメモリー、急増のときの溢れの扱い |
| `span-intake` | スパンの取り込み（OTLP）、`trace_id` でのパーティション、W3C Trace Context |
| `trace-assembler` | 組み立て、完成の判断、遅れたスパンの扱い |
| `tail-sampling-rules` | テールサンプリングの規則（エラー、遅いもの、まれなもの、予算の中の確率） |
| `trace-storage-and-search` | トレースのセグメント、ID での引き、属性の検索 |
| `red-metrics-from-spans` | RED メトリクス（すべてのスパン、重みつき） |
| `service-map` | サービスの間の辺の集計と画面 |
| `trace-log-correlation` | `trace_id` でのトレースとログの結び付け |

### E7 モニター

| Story | 内容 |
| --- | --- |
| `ingest-watermarks` | パーティションごとの水位、組織ごとの合わせ、水位の API（ADR-0008） |
| `monitor-definitions` | モニターの定義とバージョン、種類（メトリクス、ログ、APM、複合） |
| `evaluator-sharding` | 評価のシャード、リース、評価の時刻、同じ形のクエリのまとめ |
| `monitor-state-machine` | 状態の機械と決定表、データなし、グループの保持、回復の閾値、フラッピング |
| `transitions-and-outbox` | 遷移と通知の依頼の 1 トランザクションでの書き込み、重ねない鍵 |
| `evaluation-records-and-replay` | 入力の写し、状態のスナップショット、持ち主の交代、再生 |
| `mute-and-downtime` | ミュートとダウンタイム（予定、繰り返し） |
| `monitor-simulator` | 評価のシミュレーター（quality.md の 2.2.1 節 D） |

### E8 通知と連携

| Story | 内容 |
| --- | --- |
| `notifier-core` | チャネルごとの待ち行列、再試行、組織ごとの速さの上限、egress |
| `notification-templates` | 本文の雛形と変数。ログの抜粋を入れるかは法務：L2 |
| `email-notifications` | メールの通知。扱いは法務：L8 |
| `chat-webhooks` | Slack・Microsoft Teams の受信の Webhook |
| `generic-webhooks` | 汎用の Webhook、`<Brand>-Signature`（HMAC-SHA256） |
| `oncall-integrations` | オンコールのサービス（PagerDuty・Opsgenie など）への発報と解決の同期 |

### E9 ダッシュボード

| Story | 内容 |
| --- | --- |
| `dashboard-model` | ダッシュボードとウィジェットの定義、バージョン |
| `widgets-timeseries-and-more` | 時系列・数値・上位・表・ヒートマップ・ログの一覧。画面の寄せ方は法務：L9 |
| `template-variables` | テンプレートの変数 |
| `query-batching-and-live` | クエリの束ね、同じクエリのまとめ、ライブの更新 |
| `dashboard-sharing` | 組織の中の共有のリンク |
| `ui-analytics` | 本システムの画面の計測。外部送信規律は法務：L3 |

### E10 SLO とインシデント

| Story | 内容 |
| --- | --- |
| `slo-metric-and-monitor` | メトリクスとモニターの SLO、エラーバジェット |
| `burn-rate-alerts` | 複数の窓のバーンレートのアラート |
| `incidents-lite` | インシデントの宣言、重さ、担当、タイムライン、通知、振り返りの雛形 |

### E11 組織・権限・監査

| Story | 内容 |
| --- | --- |
| `orgs-users-teams` | 組織、利用者、チーム、招待 |
| `roles-and-permissions` | 役割（管理者・標準・読み取り）と独自の役割 |
| `sso-saml-oidc` | SAML・OIDC の SSO |
| `scim-provisioning` | SCIM の利用者とチームの同期 |
| `data-access-restrictions` | タグによるデータのアクセスの制限と、IR への付加 |
| `application-keys-and-service-accounts` | アプリケーションキー（`<brand>_ak_`、スコープ）、サービスのアカウント |
| `audit-trail` | 監査ログの画面と書き出し。保持は法務：L6 |
| `leak-path-tests` | 漏れの経路の表のテスト（quality.md の 2.2.1 節 G） |

### E12 利用量の計測

| Story | 内容 |
| --- | --- |
| `usage-metering-pipeline` | ゲートウェイとインジェスターの計測、`usage` のトピック、時間ごとの集計 |
| `custom-metrics-counting` | 時間ごとの異なる系列の数と月の平均 |
| `host-counting` | ホストの数え方（usage-and-billing の領域で決める） |
| `usage-ui-and-api` | 利用量の画面と API、上限への近づきの通知。文言は法務：L7 |
| `billing-export` | 課金のシステムへの受け渡し |
| `usage-reference-compare` | 参照の数え方との比べ（quality.md の 2.2.1 節 J） |

### E13 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `load-tests` | 取り込み・クエリ・評価の負荷試験（S1 のピークの 2 倍） |
| `noisy-neighbor-tests` | うるさい隣人の全場面（quality.md の 2.2.1 節 E） |
| `dr-failover-drill` | 大阪への切り替えの訓練、チェックポイントと CRR からの復元 |
| `self-monitoring-drill` | 本システムのモニターと通知を止めて、別のアカウントの経路から呼び出しが届く訓練 |
| `pentest-external` | 外部のペンテスト（取り込み、API、画面、データのアクセスの制限） |
| `slo-dashboards-alerts` | SLO とアラート（[runbooks/README.md](runbooks/README.md)） |
| `runbooks-e13` | 個別の手順の作成と確認 |
| `ga-readiness` | GA の判定。法務：L1・L2・L5・L6・L7 |

## エージェントに任せないこと

- **契約（取り込みの形式、系列の鍵、`codec_id`、ブロックとセグメントの形式、クエリの言語と IR の既定の意味、モニターの状態の遷移の決定表、キーの形式、Webhook の署名）の確定**：利用者のエージェント・データ・アラートに配った後に変えるコストが最も高い。
- **参照の実装・試験のベクトル・シミュレーターの性質の期待する値の変更**：QA が判断する。
- **カーディナリティの上限・割り当ての既定の値の変更、保持の期間の短縮、データの手動の削除**：Dev のテックリードと Ops が判断する。
- **セルの割り当ての変更、組織のセルの移し替え**：Ops が判断する。
- **大阪への切り替えの判断**：IC と Ops の責任者。
- **開示の請求・捜査機関からの照会への応答、利用者のデータの削除の請求の実行**：法務と Ops。
- **法務の判断**（L1〜L9）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、上限・構成・コーデックの採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E14〜E19 に入れなかったもの。着手するときに `intent.md` から起票する。

- **流れの中のモニターの評価**（[ADR-0008](decisions/0008-monitor-evaluation-model.md)。S2 で評価の量が足りなくなったら）。
- **電話・SMS の通知**（法務の L8）。
- **オンコールの当番の表**（MVP は外部のオンコールのサービスに渡す）。
- **組織ごとの暗号化の鍵（BYOK）**（[ADR-0009](decisions/0009-retention-tiers-on-s3.md)）。
- **S2 のセルの分け方と、大きな組織の専用のセル**（infrastructure の領域）。
- **プロファイリング、セキュリティの監視、データベースの監視**（intent.md）。

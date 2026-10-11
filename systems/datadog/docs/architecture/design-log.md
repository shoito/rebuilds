# Design log: Datadog

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-10-09：既定案

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも領域の文書の工程と E1〜E13 の PoC・試験で覆りうる。

- **データの面の言語**：Rust。Go より、ガベージコレクションの止まりがなく、系列あたりのメモリーを詰められ、SIMD の圧縮を書きやすい（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **取り込みのバス**：MSK。Kinesis は 1 シャードの上限と GB/秒の費用、自前の WAL は作る量で外した（[ADR-0002](../decisions/0002-intake-log-on-msk.md)）。
- **時系列の圧縮**：`codec_id` 1 は Gorilla の形（時刻の差分の差分、値の XOR）。文書と検証の例が多く、参照の実装と比べやすい。浮動小数点の別の圧縮（ALP など）は `tsdb-codec-poc` で比べ、良ければ `codec_id` 2 として足す（[ADR-0004](../decisions/0004-tsdb-storage-engine.md)）。
- **分布のスケッチ**：DDSketch ではなく、OpenTelemetry の指数のヒストグラム（底 2、最大 512 の区間、スケール 5 で相対誤差およそ 1.1%。最大と最小の比が 2^16（約 6.5 万倍。1ms〜1 分ほど）までを、スケール 5 のまま持てる。幅が広すぎればスケールを下げ、下げたことを結果に示す）を保存とクエリの形にする。OTLP の分布をそのまま受け、合わせるときはスケールを下げて揃える。本家の実装のライブラリは使わない（distributions-and-sketches の領域で ADR にする）。
- **ログの保存**：列指向とブルームフィルター。OpenSearch のような転置索引は、取り込みの GB あたりの索引の費用が重く、汎用の部品を核に据えることになる（[ADR-0005](../decisions/0005-log-storage-columnar-with-bloom.md)）。
- **トレースの SDK**：自前では持たず、OpenTelemetry の SDK を使う。W3C Trace Context の `traceparent` を正とし、`tracestate` の本システムの鍵は `<brand>`。
- **テールサンプリング**：完成の待ち 30 秒（最大 5 分）。規則の既定は、エラーのトレースをすべて、サービス・リソースごとに遅い上位 1%、まれな組を 1 秒 5 件、残りはテナントの予算の中の確率で採択（traces-and-sampling の領域）。
- **モニターの評価**：決まった時刻の評価（1 分ごと）。流れの中の評価は、S2 で評価の量が足りなくなったら別の ADR で足す（[ADR-0008](../decisions/0008-monitor-evaluation-model.md)）。
- **フラッピング**：回復の閾値（任意）、「N 回続けて」の条件（既定 1）、30 分に 6 回を超える遷移でフラッピングとし、通知を 1 回にまとめる（monitors-and-alerting の領域）。
- **インシデント管理**：MVP に軽いものを含める（宣言、重さ、担当、タイムライン、通知、振り返りの雛形）。オンコールの当番の表は持たず、外部のオンコールのサービスに渡す（slos-and-incidents の領域）。
- **RUM と合成監視**：MVP の後。RUM は法務の L4 の後。
- **アーカイブ**：本システムの S3（東京、Glacier Instant Retrieval）に 1 年。利用者のバケットは MVP の後（[ADR-0009](../decisions/0009-retention-tiers-on-s3.md)）。
- **自己監視**：別の AWS アカウントの AMP・CloudWatch と、外からの見張り（見張りの系列が出ること、見張りのモニターが鳴ること）で行う。本システムのモニターで本システムを呼び出さない（[runbooks/](../runbooks/README.md) の 5 節）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。

## 2026-10-09：統合

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。最初の設計の ADR は直接直し、決定を覆した・具体にしたところに日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

- **MSK の上での「1 回だけ」**（[ADR-0002](../decisions/0002-intake-log-on-msk.md) の注記）：領域の ADR で作り方が分かれていたので、1 つの方針に揃えた。
  - 取り込みは Kafka のトランザクションを使わない（[ADR-0011](../decisions/0011-intake-gateway-pipeline-and-watermark-ticks.md)）。一部の失敗は 503、メトリクスは後勝ちで冪等。
  - 出力が S3・Aurora の消費者は、出力とオフセットを同じ記録に、前の位置を条件に書く（ADR-0004、ADR-0005、[ADR-0020](../decisions/0020-block-flush-commit-and-replay.md)、[ADR-0040](../decisions/0040-trace-storage-and-id-lookup.md)、[ADR-0055](../decisions/0055-exactly-once-usage-aggregation-and-overage.md)）。
  - 出力が MSK のトピックの `log-processor` だけがトランザクションを使う（[ADR-0030](../decisions/0030-log-pipeline-execution-model.md)）。MSK の Express はトランザクションの設定とラックを意識した読み出しの設定（`replica.selector.class`）を持つことを AWS の資料で確かめた（[ADR-0060](../decisions/0060-msk-express-and-ec2-fleets.md) の注記）。残るのは S1 の量での遅れと費用で、`msk-throughput-poc` で測る。
  - 下流は出どころ（`src_partition`、`src_offset`）でも重複を除く。トランザクションが量に合わなければ、冪等のプロデューサーに切り替えても下流は変わらない。
- **RLS の外の表**：領域の文書が足した組織を持たない運用の表（`ingest_checkpoints`、`ingest_shard_leases`、`metric_block_verifications`、`eval_shard_leases`、`indexer_offsets`、`assembler_offsets`、`usage_offsets` と、保守の表）を、保守のスキーマ `maint` として [ADR-0003](../decisions/0003-tenancy-cells-and-isolation.md) の一覧に足した。
- **保持の区分と S3 の規則**（[ADR-0009](../decisions/0009-retention-tiers-on-s3.md) の注記）：区分に `h-3d`・`rehyd-<N>d`・`audit-<N>d`・`eval-30d`・`ckpt-24h` を足した。ライフサイクルと複製の規則は、キーの接頭辞ではなくオブジェクトのタグ（`class`、`tier=l0|l1`）で絞る（[ADR-0061](../decisions/0061-dr-stage-up-and-cell-expansion.md)）。合わせの前の小さなオブジェクト（`l0`）は大阪の Standard に 2 日。タグで絞った複製では削除マーカーが写らないので、保持の削除・削除の請求・解約の消去は大阪の写しも明示に消す（[ADR-0057](../decisions/0057-data-lifecycle-and-deletion-framework.md) の注記）。
- **層の一致**（[quality.md](../quality.md) の 2.2.1 節 C）：浮動小数点の合計は層で足す順序が違うので、`sum` は `差 ≤ 1e-12 × Σ|x_i|` を許容にした。`min`・`max`・`count`・最後の値は完全に一致のまま。同じ層の中は完全に一致のまま（同 B）。
- **本家との意図した違い**（1.4 節）：分布の数え方（1 系列 5、パーセンタイルで足さない）、StatsD の `h`・`ms` を分布に、公開のダッシュボードの共有を持たない、ダッシュボードを見る人の権限で描く、複合モニターのグループをタグの鍵と値の組で合わせる、トレースの保持 15 日の 1 つ、エージェントでスパンを間引かない、を足した。ログのモニターが索引に入ったログだけを見ることは、本家も同じと確かめたので「確かめたこと」に置いた。
- **足りなかった部品**：`derived-metrics-aggregator`（`fleet-derive`、`r7gd.2xlarge` × 3）、`live-tail`・`rehydrator`・`deletion-worker`・`limits-coordinator`（Fargate）を [infrastructure.md](infrastructure.md) の 3 節と [capacity.md](capacity.md) の 4・6 節に足した。`slo-calculator` は `monitor-evaluator` と同じバイナリで `fleet-eval` に載る（[ADR-0049](../decisions/0049-slo-computation-and-burn-rate.md)、[ADR-0060](../decisions/0060-msk-express-and-ec2-fleets.md) の注記）。月の原価は約 36.5 万から約 36.9 万 USD になった。
- **RED メトリクスの名前**：`<brand>.apm.*`（[ADR-0039](../decisions/0039-red-metrics-and-service-map-before-sampling.md)）に揃えた。usage-and-billing の `trace.*` を直した（[ADR-0054](../decisions/0054-metering-units-and-host-counting.md) の注記）。
- **ログの取り込みの原価**（PM の判断待ち。[usage-and-billing.md](usage-and-billing.md) の 9 節）：公開の価格での原価は 1 GB 0.100 USD で、最初の仮の予算 0.03 USD の約 3 倍。選択肢と 1 GB あたりの原価は次のとおり。
  - A. 予算を上げる：0.100（値段の下限 0.33）
  - B. 値段をアーカイブと分ける：取り込み 0.069＋アーカイブ 0.031
  - C. MSK の余裕を 2 倍から 1.5 倍へ（12 → 9 台）：0.094
  - D. アーカイブを DR から外す：0.080
  - E. 下げる手の全部：0.06〜0.07
  - **推奨の既定（仮）は A**。予算を 0.10 USD に上げ、MSK の余裕とアーカイブの DR は変えない。C は最大のリスク（取り込みの崩壊）の守りを削り、D は NFR-005 を変え、どちらも効きが小さい。**残る問い**：ログの取り込みの値段（粗利 70% なら 0.33 USD 以上）、アーカイブを別の単位にするか、アーカイブの DR を組織が選べる設定にするか。
- **カーディナリティの配り直し**：[ADR-0006](../decisions/0006-cardinality-policy.md) の「1 分ごとに配り直す」は、MSK の制御のレコードを同じオフセットで写しに届ける形に具体にした（[ADR-0017](../decisions/0017-cardinality-admission-via-control-records.md)。ADR-0006 の注記）。
- **セルの移し替え**：[ADR-0003](../decisions/0003-tenancy-cells-and-isolation.md) の「二重の書き込み」は、点の時刻の 1 時間の区切り `H` で書き込み先を分ける形に具体にした（[ADR-0053](../decisions/0053-child-orgs-and-tenant-cell-moves.md)。ADR-0003 の注記）。
- **TSDB への提案**：
  - ブロックの書き出しのずらし 0〜5 分を**採った**。閉じる条件を `H + 2 時間 10 分 + s_p`（`s_p` はパーティションのハッシュから）にし、写しと読み直しで変わらない（[ADR-0020](../decisions/0020-block-flush-commit-and-replay.md) の注記）。書き出しは区切りから 70〜75 分、ヘッドは最大 約 2 時間 15 分。
  - ヘッドの要約（オフセットで揃えた要約）を**採った**。5 分の区切りのオフセットで 2 つの写しが同じ値を作り、入れ替えの影の比べと写しの静かな食い違いの検出に使う（[tsdb-storage-engine.md](tsdb-storage-engine.md) の 6.7 節、[ADR-0065](../decisions/0065-stateful-rollout-with-replica-handoff.md) の注記）。系列の抜き取りの比べは置き換えず、足す。
- **自己監視**：Amazon Managed Grafana は大阪にないので、selfmon の Grafana は OSS を大阪の Fargate で動かす（AMP は大阪にある）。runbooks の 1 節に SLI「監査の読み出しの記録の欠け」「自己監視の経路の健全」「ヘッドの要約の一致」を足した。
- **名前の揃え**：アプリケーションキーの表は `application_keys`（列 `owner_type`）。自己監視の手順は `self-monitoring-path-failure.md`。エージェントの廃止は「下限より古いものも受けてヘッダーで知らせ、6 か月の予告の後に 426」（[ADR-0066](../decisions/0066-format-versioning-and-compatibility-windows.md)、[intake-and-agent.md](intake-and-agent.md) の 4.8 節）。
- **検証の工程での直し（2026-10-09）**：公式の資料を取得し直して、次を確かめ・直した。
  - 本家の評価の窓は 1 分〜48 時間（メトリクスは 1 か月）。5 分からと書いていたのを直した（intent、ADR-0008、monitors-and-alerting）。評価の頻度は 24 時間未満 1 分、48 時間未満 10 分、それ以上 30 分。
  - 本家のサイトは 9 つで AP1 は日本、API キーは組織ごとに既定 50 本、分布は組ごとに 5・パーセンタイルでさらに 5、Rust の時系列の保存の記事は 2025-08-04、Husky の記事は 2022-05-17（確認のみ）。
  - 本家の StatsD の `h`・`ms` はエージェントで平均・個数・中央値・95 パーセンタイル・最大に集計される（intake-and-agent の未検証を外した）。
  - MSK Express のトランザクションの設定とラックを意識した読み出しの設定（未検証を外した。量での遅れと費用は PoC）。
  - NLB の TLS のリスナーは ALPN の方針（`HTTP2Only`・`HTTP2Preferred` など）を持つ（未検証を外した。gRPC の端から端までは E1 で確かめる）。
  - S3 の複製はタグで絞れるが、タグの規則では削除マーカーが写らない（ADR-0057 の未検証を外し、明示の削除に改めた）。
  - Amazon Managed Grafana は大阪で提供されていない。AMP は大阪で提供されている。
  - `C7g`・`C7gd`・`R7gd`・`I4i` は大阪（ap-northeast-3）でも提供されている（AZ ごとの容量は未検証のまま）。
  - OpenTelemetry の `ot=th` の仕様（TraceState: Probability Sampling）は Development のまま。`R ≥ T` で採り、重みは `2^56 / (2^56 − T)`。
  - 電気通信事業法の外部送信規律の施行は 2023-06-16（確認のみ。結論は法務の L3・L4）。
- **品質と運用**：
  - 各領域の文書の「quality.md・runbooks・data-model への項目」を反映した。
  - [quality.md](../quality.md) に、漏れの経路の表の 6 行、負荷の場面 3 つ、状態を持つ部品の入れ替えの試験、DR の訓練の失った範囲、デッドマンスイッチの段 2・3 の訓練、判定基準 3 行、Epic の合否基準を足した。
  - runbooks の手順を、作ったもの（[incident-response.md](../runbooks/incident-response.md)、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md)、[self-monitoring-path-failure.md](../runbooks/self-monitoring-path-failure.md)、[noisy-neighbor.md](../runbooks/noisy-neighbor.md)）と計画のものに分けて一覧にした。
  - 表と置き場所の索引は [data-model.md](data-model.md)。
- **数値の正本**：
  - SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。
  - 上限は各 ADR と runbooks の 2 節。
  - 受け付けの窓は ADR-0004（メトリクス 過去 1 時間・未来 10 分）と ADR-0005（ログ 過去 18 時間）。ブロックは区切りから 70 分（`H + 2 時間 10 分`）＋ずらし 0〜5 分で閉じる（ADR-0020）。
  - 保持は [ADR-0009](../decisions/0009-retention-tiers-on-s3.md) と [security.md](security.md) の 5.1 節の `retention_policies`。
  - 負荷と費用のモデルは [capacity.md](capacity.md)、単価と単位あたりの原価は [infrastructure.md](infrastructure.md) の 9 節と出典。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-10-09：データモデル

データモデルの完全版を [data-model.md](data-model.md) と [data-model/](data-model/) に作り、形（表・列・キー・索引・分割・保持・ファイルのバイトの並び）の正本をそこへ移した。領域の文書の「data-model への項目」は提案の記録として残す。名前・列・置き場所の決まっていなかったところは、推奨の案で決めた（[data-model.md](data-model.md) の 7 節の D-1〜D-41）。ADR の決定は変えていない。主なものは次のとおり。

- **スキーマと RLS の外の表**：`public`（テナントの表 79 と、登録簿 `users`・`user_mfa_factors`・`sessions`・`tenant_cells`・`intake_keys_index`）と `maint`（15 表）。解約の消去の記録 `maint.tenant_purge_runs` を足した（組織の行を消した後も残す）。ADR-0003 に注記した。経路（X1〜X4）は増やしていない（D-1・D-27）。
- **列の名前の揃え**：セルは `cell_id`、カタログの状態は `active`・`superseded`・`deleting`・`deleted`、保持の区分は `class`（S3 のタグと同じ）、ブロックの種類は `kind`（D-2・D-5・D-6）。権限は `logs.data.delete`・`dashboards.read`・`dashboards.write`（D-24。ADR-0036・ADR-0048 に注記）。索引の 1 日の上限の鍵は `idxq:`（D-23。ADR-0032 に注記）。
- **冪等の鍵**：不変のファイルのカタログの ID は決まった入力の xxh3_128（D-3）。分割した表の主キーは分割の鍵を含める（D-4）。通知の依頼は `dedup_key`、送信の行の分割の鍵は依頼の作成の時刻（D-14）。
- **作らない表**：`metric_block_stats` は作らず、費用の見積もりはブロックの統計の区画を読む（D-7。ADR-0026 に注記）。`processor_batches` は S3 のオブジェクトで、バージョンの組が変わったときだけ書く（D-25）。
- **足した表**：`tenant_settings`（各領域の「足す列」を集めた）、`cardinality_limit_overrides`、`log_lookup_tables`、`outbox`、`maint.tenant_purge_runs`（D-9・D-16・D-27・D-34・D-37）。
- **組織のデータは `<cell>/<tenant_id>/` の下だけ**：評価のスナップショット、集め直しの段のチェックポイント、写しの食い違いの調べのキーを直した。S3 の区分に `config` を足した（D-39・D-40。ADR-0009 に注記）。
- **評価の主体**：`eval_principal_type`（`roles`・`team`・`service_account`）と、保存した時点の役割の写し（D-12）。ダウンタイムと複合の子はバージョンの行にし、再生で同じ定義を使う（D-13）。
- **保持**：`monitor_transitions` 90 日（D-11）、`slo_hourly` 92 日（90 日の窓の端の時の行。D-28）。
- **ファイルの形式**：リトルエンディアン、`TSB1` の頭・区画の表・末尾、`codec_id` 16 のチャンクは 65,535 バイトでも閉じる、`TSC1`・`LSEG`・`LTMB`・`tidx`・`THBF`・`EVR1` の頭（D-29・D-30）。読み手はファイルの頭の `tenant_id` を確かめる（D-31）。
- 直した領域の文書の一覧は [data-model.md](data-model.md) の 7 節にある。

持ち越し（法務、計測・PoC・選定・確認で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L9） | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた Story の spec を承認しない。PII のマスクの既定は L1、通知の本文のログの抜粋と国外の宛先は L2、ログの機械の読み取りは L3、削除の期限は L5、監査ログの保持は L6、SLA・超過の文言は L7、公開の共有と画面の寄せ方は L1・L2・L7・L9 |
| ログの取り込みの値段と単位、アーカイブの DR を選べる設定にするか | PM。E13 の `cost-baseline` の前（上の「ログの取り込みの原価」） |
| MSK のブローカーの構成、パーティションの数、Express のトランザクションとラックを意識した読み出しの量での遅れと費用 | E2 の前の `msk-throughput-poc` |
| 時系列のコーデックの比べ（Gorilla の形と ALP など）、`codec_id` 16 の大きさ | E3 の前の `tsdb-codec-poc` |
| インジェスターの系列あたりのメモリー、ヘッドの要約の CPU | E3 の前の `ingester-memory-poc` |
| ブルームフィルターの誤検出の率、日本語の 2-gram、アーカイブの圧縮の率 | E5 の前の `log-bloom-poc` |
| テールサンプリングの待ちとメモリー | E6 の前の `tail-sampling-memory-poc` |
| NLB の TLS のリスナーを通した gRPC の端から端まで | E1 の `edge-and-intake-endpoints`（**未検証**） |
| タグで絞った S3 の複製と保存クラス、大阪の明示の削除 | E1 の `s3-buckets-baseline`（実の S3 で確かめる） |
| 大阪で EC2 の群れを起こせる容量（AZ ごと、予約の要否） | E1 の `osaka-warm-standby`（**未検証**） |
| オンコールのサービスの選定と心拍の機能、大阪でのトレースの置き場所、AMP の保持と単価 | E1 の `self-monitoring-baseline`（**未検証**） |
| 未検証の単価（Aurora、ネットワーク、自己監視、S3 の要求の数、`r7gd.2xlarge`） | E13 の `cost-baseline` |
| 売りすぎの比（1.5 倍） | PM と Ops。E13 の後 |
| S2 のセルの分け方、カタログの Aurora の分け方 | S2 の前に別の ADR |
| `monitor_transitions` の量（90 日で 約 13 億行）と Aurora の容量、ブロックの統計の区画の範囲の GET の遅れ、ファイルの形式の大きさの効き | E3・E4・E5・E7 の PoC と負荷試験（[data-model.md](data-model.md) の 9 節） |
| 本家の振る舞いで未確認のもの（テールサンプリング、SLA、内部のクエリの計画、上限の超過の振る舞い、ログの取り込みのバイトの数え方、Webhook の署名と再試行、重なるデータセットの合わせ方、インシデントの状態） | 公式の資料で確かめられなかった。未検証のまま、本システムの値を使う |

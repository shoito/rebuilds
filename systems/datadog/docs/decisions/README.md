# Decisions: Datadog

Datadog の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 管理の面は共通の基盤（TypeScript・Hono、Aurora、Fargate）を引き継ぎ、データの面（取り込み、保存、クエリ、評価）とエージェントは Rust で書く。状態を持つデータの面は ECS の EC2（NVMe）で動かす | accepted |
| [0002](0002-intake-log-on-msk.md) | 取り込みのログに Amazon MSK を使い、MSK の確定の後に 202 を返す。信号ごとのトピック、テナントごとのパーティションの組、保持 24 時間。MSK はデータの面の WAL で、消費者は読み直しで同じ結果になるように作る | accepted |
| [0003](0003-tenancy-cells-and-isolation.md) | 組織をテナントにし、共有のセルに置く（大きな組織は専用のセル）。データの鍵の先頭に `tenant_id`、管理の DB は FORCE RLS。取り込み・保存・クエリ・評価の各段に、割り当て、シャッフルシャーディング、重み付きの公平なキューを置く | accepted |
| [0004](0004-tsdb-storage-engine.md) | 自前の TSDB：系列の鍵は 128 ビットのハッシュ、直近 2 時間をメモリーのヘッドに持ち、1 時間の不変のブロックを S3 に書く。`codec_id` 1 は時刻の差分の差分と値の XOR。ブロックの書き出しで 1 分・1 時間のロールアップ（合計・個数・最小・最大・最後、ヒストグラム）を作る。遅れの窓は 1 時間 | accepted |
| [0005](0005-log-storage-columnar-with-bloom.md) | ログとトレースは、転置索引ではなく、列指向のセグメントとブルームフィルター（語と日本語の 2-gram）で保存・検索する。セグメントは S3、カタログは Aurora。索引とアーカイブを分ける | accepted |
| [0006](0006-cardinality-policy.md) | 組織・指標ごとの有効な系列の上限と、新しい系列の作成の速さの上限を、インジェスターで強制する。超過は溢れの系列に数えて知らせる。組織は指標ごとに、クエリに残すタグを選べる | accepted |
| [0007](0007-query-language.md) | 自前のメトリクスのクエリの言語（`集計:指標{条件} by {タグ}`、関数、式）と、ログ・トレースの検索の文法を持ち、すべてを型付きの IR にコンパイルして 1 つのエンジンで実行する。PromQL は MVP の後 | accepted |
| [0008](0008-monitor-evaluation-model.md) | モニターは、シャードに分けた評価器が、決まった時刻に取り込みの水位を待ってクエリで評価する（流れの中の評価はしない）。グループごとの状態の機械で、遷移と入力の写しを残し、再生で同じ結果になる | accepted |
| [0009](0009-retention-tiers-on-s3.md) | 保持の層：ホット（メモリー・NVMe）、ウォーム（S3 Standard）、コールド（S3 Glacier Instant Retrieval のアーカイブ）。メトリクスは生 15 日・1 分 63 日・1 時間 15 か月。ログの索引は 3・7・15・30 日、アーカイブは 1 年。保持はブロック・セグメントの単位で消す | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

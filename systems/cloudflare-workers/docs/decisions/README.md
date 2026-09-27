# Decisions: Cloudflare Workers

Cloudflare Workers の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、各領域に割り当てた ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-runtime-build-vs-reuse.md) | エッジのランタイムは workerd を元にし、多数のテナントの層は Rust で作る | accepted |
| [0002](0002-isolation-model.md) | 多数のテナントの V8 isolate を共有のプロセスで動かし、多層の防御を重ねる | accepted |
| [0003](0003-edge-locations.md) | S1・S2 は AWS のリージョンのエッジのノードを anycast の IP の後ろに置き、S3 で自前の PoP に移る | accepted |
| [0004](0004-config-and-code-distribution.md) | 設定とコードは、順序付きの変更のログを全ノードの読み込み用の写しへ押し出して配る | accepted |
| [0005](0005-storage-consistency.md) | ストレージの一貫性は製品ごとに決め、利用者に明示する | accepted |
| [0006](0006-workerd-fork-and-upstream-tracking.md) | workerd は下流のリポジトリにパッチの列で持ち、上流の最新のタグを週 1 回取り込む | accepted |
| [0007](0007-isolate-lifecycle-and-dynamic-loading.md) | isolate は関数の版の鍵で再利用し、予備・シャード・先読みで温め、メモリの圧力で段階的に退避する | accepted |
| [0008](0008-bundle-format-and-compatibility-dates.md) | バンドルは ES モジュール・CommonJS・Wasm・データだけにし、互換の日付とフラグは上流の表をそのまま使う | accepted |
| [0009](0009-cpu-and-memory-metering.md) | CPU 時間はスレッドの CPU 時計と監視のスレッドで、メモリは isolate ごとの合計で測り、止める | accepted |
| [0010](0010-process-sandbox-and-egress-invariants.md) | ランタイムのプロセスは名前空間・seccomp・cgroup v2 の中で動かし、外への経路は外向きのプロキシだけにする | accepted |
| [0011](0011-cordon-tiers-and-placement.md) | cordon は 4 つの段階と隔離用・内部用に分け、設定の写しのアカウントの状態から配置する | accepted |
| [0012](0012-v8-24-hour-patch-pipeline.md) | V8 の Critical・High の修正は、常設の緊急の経路で 24 時間以内に全ノードへ届ける | accepted |
| [0013](0013-spectre-mitigations-and-dynamic-isolation.md) | 時計を止め、スレッドとネイティブのコードを禁じ、性能カウンターで疑わしい関数を隔離し、プロセスを毎日入れ替える | accepted |
| [0014](0014-wintertc-conformance-and-wpt.md) | ECMA-429 の全インターフェイスを持ち、セキュリティのための逸脱を一覧にし、WPT の部分集合を取り込みの門にする | accepted |
| [0015](0015-nodejs-compat-scope.md) | Node.js の互換は上流の組み込みの範囲に従い、TCP と DNS に依る接続は MVP でエラーにする | accepted |
| [0016](0016-request-brand-metadata.md) | 要求の属性は `request.<brand>` に置き、S1 で正しく出せる欄だけを埋める | accepted |
| [0017](0017-global-accelerator-and-regional-nlb.md) | 入口はデュアルスタックの Global Accelerator とリージョンごとの TCP の NLB にし、リージョンは健全性の検査で退かせる | accepted |
| [0018](0018-acme-certificates-and-sni.md) | 証明書は ACME で自前で発行し、リージョンのデータ鍵で包んで全ノードへ配る | accepted |
| [0019](0019-route-matching-and-home-node-forwarding.md) | ルートはホスト名の表と制限した文法で解決し、リージョンの中はランデブーハッシュでホームのノードへ 1 回だけ転送する | accepted |
| [0020](0020-pingora-ingress-and-egress-proxies.md) | 入口と外向きのプロキシは Pingora の上に別々のプロセスとして作り、外向きは専用のリゾルバーとアカウントごとの接続で出す | accepted |
| [0021](0021-versions-deployments-and-gradual-rollout.md) | 版は変えられないものにし、デプロイは 1〜2 の版と万分率の割合で、版の鍵により決定的に振り分ける | accepted |
| [0022](0022-sequenced-change-log-relays-and-lmdb.md) | 変更のログは 1 つの採番器が (エポック, 番号) で採番し、リージョンの中継を経てノードの LMDB へ唯一の書き手が適用する | accepted |
| [0023](0023-code-and-secret-distribution.md) | バンドルは版の確定の前に全リージョンの S3 へ置き、シークレットはリージョンの鍵で包んだアカウントの鍵で配る | accepted |
| [0024](0024-kv-central-store-dynamodb.md) | KV の正本は東京の DynamoDB に置き、4 KiB を超える値は S3 に置く。同じキーの書き込みは条件付きの書き込みで 1 秒に 1 回に制限する | accepted |
| [0025](0025-kv-two-tier-cache-and-staleness.md) | KV の読み込みはノードとリージョンの 2 段のキャッシュで返し、古さは正本から取った時刻で数える | accepted |
| [0026](0026-object-storage-s3-gateway-with-scoped-prefixes.md) | オブジェクトストレージは、S3 の共有のバケットの上に、バケットごとの接頭辞と要求ごとに絞った権限で S3 互換の層を作る | accepted |
| [0027](0027-object-public-access-and-presigned-urls.md) | 公開の配信はカスタムドメインと別の登録可能なドメインの開発用の URL で行い、署名付きの URL は S3 互換の口だけで受ける | accepted |
| [0028](0028-object-egress-pricing.md) | オブジェクトストレージの外向きの転送は無料にせず、原価を下回らない従量で課金する | accepted |
| [0029](0029-do-placement-and-directory.md) | Durable Objects の実体の場所は作成時に決めて変えない。名前の ID は東京の台帳で調停し、一意の ID は場所を ID に埋め込む | accepted |
| [0030](0030-do-leases-and-fencing.md) | 実体の持ち主はホストのリースと実体ごとのエポックで決め、複製の側でエポックを検査して古い持ち主の確定を拒む | accepted |
| [0031](0031-do-sqlite-replication-and-pitr.md) | SQLite の変更は持ち主と別の AZ の複製の 3 台のうち 2 台（2 つの AZ）で確定し、10 秒か 16 MiB ごとに S3 へ置いて 30 日の PITR を持つ | accepted |
| [0032](0032-do-alarms-hibernation-and-rpc.md) | WebSocket はランタイムの外の接続の保持役で持って休止を支え、アラームはリージョンの索引で起こし、呼び出しは RPC を基本にする | accepted |
| [0033](0033-queues-on-sqs-with-own-dispatcher.md) | キューの S1 の保存は SQS の標準のキューにし、配送は自前のディスパッチャーで行う | accepted |
| [0034](0034-cron-sharded-scheduler.md) | cron はシャードごとのリースを持つ東京のスケジューラーで起動し、予定の時刻ごとの記録で 2 重の起動を防ぐ | accepted |
| [0035](0035-cli-and-single-jsonc-config.md) | CLI は TypeScript で npm に配り、設定ファイルは `<brand>.jsonc` の 1 つの形にする | accepted |
| [0036](0036-local-dev-on-downstream-workerd.md) | ローカル開発は同梱の下流の workerd で動かし、ストレージは同じ workerd の中の模擬で模す | accepted |
| [0037](0037-tail-sessions-and-tenant-logs.md) | `tail` はセッションの印を変更のログで配って WebSocket で届け、保存するログは ClickHouse に置く。伏せる処理はノードで行う | accepted |
| [0038](0038-plan-limits-and-edge-enforcement.md) | 制限は計画ごとの表で持ち、要求ごとの制限はその場で、期間の枠と費用の上限はアカウントの状態で止める | accepted |
| [0039](0039-usage-metering-pipeline.md) | 使用量は仕事をした部品が数え、冪等の ID の束で東京へ送り、重複を捨てて集計する | accepted |
| [0040](0040-jpy-pricing-invoices-and-spend-controls.md) | 料金は円で原価を下回らない値にし、転送を課金する。月末締めの後払いで適格請求書を出し、前払いのクレジットは S1 で売らない | accepted |
| [0041](0041-management-api-shape.md) | 管理 API は `/v1` のパスの版で足す変更だけを入れ、冪等キー・不透明なカーソル・RFC 9457 のエラーを使う | accepted |
| [0042](0042-api-tokens-roles-and-audit-log.md) | API トークンは接頭辞とチェックサムの形でシークレットスキャンに載せ、ロールは 5 つに固定し、監査ログは変更と同じトランザクションで書く | accepted |
| [0043](0043-hosted-content-abuse-and-takedown.md) | ホストした内容の不正は複数の起点で見つけ、段にした措置で止め、通報は 1 つの事件の流れで扱う | accepted |
| [0044](0044-egress-abuse-controls.md) | 外向きの悪用は cordon ごとのアカウントの外向きの方針で抑え、`<Brand>-Worker` で送り元を必ず示す | accepted |
| [0045](0045-new-account-risk-scoring.md) | 新しいアカウントのリスクの点数を規則で出し、`c0-untrusted` の条件に足す。点数は信頼を下げる方にだけ働く | accepted |
| [0046](0046-control-plane-privilege-separation-and-operator-access.md) | 全ノードへ届く 3 つの権限（ランタイムの配布、設定のログ、鍵の復号）を別の役割とアカウントに分け、人の本番の権限は期限付き・2 人の承認にする | accepted |
| [0047](0047-kms-key-hierarchy.md) | 鍵は KMS の 3 層（制御プレーンの鍵、リージョンの鍵、アカウントの鍵）にし、制御プレーンの鍵だけをマルチリージョンにする | accepted |
| [0048](0048-audit-log-integrity-and-data-lifecycle.md) | 監査ログはハッシュの鎖と WORM の写しで改ざんを検知できるようにし、アカウントのデータは削除から 30 日の猶予の後に消し、写しは各保存の保持の期間で消える | accepted |
| [0049](0049-aws-accounts-and-network.md) | AWS のアカウントは制御プレーン、リージョンごとのエッジとストレージ、検証のフリート、security-lab、quarantine に分け、リージョンの間は Transit Gateway でつなぐ。ノードの外への通信は NAT ゲートウェイを通さない | accepted |
| [0050](0050-runtime-fleet-instance-types.md) | テナントのコードを動かすノードは、ゲストに性能カウンターを見せる Intel の c7i・m7i の大きさにし、自前の部品はすべて x86-64 で動かす | accepted |
| [0051](0051-disaster-recovery-and-honest-rpo.md) | 東京の全体の障害は、関数は自動の迂回、制御プレーンは Aurora の管理された切り替え、ストレージは製品ごとの手動の切り替えで大阪へ移す。RPO は製品ごとの実際の値で示す | accepted |
| [0052](0052-platform-telemetry-and-cardinality.md) | 基盤の運用のメトリクスはノード・リージョン・cordon までのラベルで AMP に置き、関数ごとの値は呼び出しの記録から ClickHouse で集計する | accepted |
| [0053](0053-slos-probes-and-burn-rate-alerts.md) | SLO は外からの合成監視と実際の要求の両方で測り、リージョンごとのバーンレートで呼び出す。隔離・耐久性・伝搬の取りこぼしは予算を持たず 1 件で呼び出す | accepted |
| [0054](0054-capacity-design-point-and-region-sizing.md) | エッジのノードの設計点は CPU 50% で 1 台 8,000 件/秒（c7i.24xlarge）とし、東京・大阪はそれぞれ単独で国内の全量を 1 つの AZ を失っても受けられる台数を持つ | accepted |
| [0055](0055-staged-runtime-rollout-by-cordon-and-region.md) | ランタイムは cordon とリージョンを軸にした波で、指標の関門を自動で判定して配り、ノードに 2 つの版を置いてプロセスの入れ替えで戻す。ノードの部品は AMI の入れ替えで配る | accepted |
| [0056](0056-platform-config-staging-and-flags.md) | 利用者の変更は速い経路で全ノードへ配り、基盤の設定とフラグはリージョン・cordon の範囲を付けて段階的に配る | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

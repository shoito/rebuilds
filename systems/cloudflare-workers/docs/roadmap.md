# Roadmap: Cloudflare Workers

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E5 の最小の版で、下流の workerd（制限の強制のパッチを含む）、スーパーバイザーと seccomp、1 つの cordon、GA → NLB → 入口のプロキシ、1 つのルート、outbox → 採番器 → 中継 → ノードの LMDB、CLI の `deploy` を端から端まで貫き、東京の 1 リージョンで 1 つの関数を公開の URL で動かしてから、機能を広げる。脱出のテスト、配信の性質ベーステスト、V8 の経路の空の実行は、E1〜E3 から本物の形で作る。後から足すと、隔離と伝搬の破れを見逃すため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する：PMU と PKU の実機の確認（E1 の最初。[ADR-0050](decisions/0050-runtime-fleet-instance-types.md)）、`workerLoader` でのテナントの動的な読み込みと空の isolate の予備（E2 の最初。[ADR-0001](decisions/0001-runtime-build-vs-reuse.md)、[ADR-0007](decisions/0007-isolate-lifecycle-and-dynamic-loading.md)）、V8 のサンドボックス・止めた時計の上流の既定（E3 の最初。[ADR-0010](decisions/0010-process-sandbox-and-egress-invariants.md)）、利用者の IP の保持（E4 の最初。[ADR-0017](decisions/0017-global-accelerator-and-regional-nlb.md)）、ClickHouse の自前とマネージドの比べ（E6。[ADR-0037](decisions/0037-tail-sessions-and-tenant-logs.md)）、DO の保存の層への確定の約束の差し込み（E9 の最初。[ADR-0031](decisions/0031-do-sqlite-replication-and-pitr.md)）。
- **隔離を先に固める。** E3（サンドボックスとセキュリティ）は、他の Epic の機能を本番に出す前の関門にする。`security:sensitive` の変更は、Dev のテックリードとセキュリティの担当の承認を要する（[AGENTS.md](../AGENTS.md)）。
- **契約を先に固定する。** 設定ファイルの JSON Schema、管理 API の OpenAPI、変更のログの束の形（Protocol Buffers）、器の種類、エラーの番号、ECMA-429 の逸脱の一覧、WPT の期待の一覧、制限の値、料金の単価は、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務・経理の確認待ちの Story は、spec を承認しない。** 設計と、法務・経理に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L7）。下の表で「法務：L*」と書いた Story が当たる。
- **1 変更 1 PR を目安に、差分を小さくする。** ランタイムの変更は波（W0〜W6）で、基盤の設定は段階で出す（[delivery.md](architecture/delivery.md) の 5・7 節）。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。Epic の中身の定義は [architecture/README.md](architecture/README.md) の 8 節。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤と PoC | AWS のアカウントと網、エッジのフリートと AMI、PMU・PKU の確認、ビルドと署名、鍵、監査の保管庫、観測の経路と合成監視の枠、管理 API の骨格・アカウント・ログイン・トークン・監査ログ | 設計中 |
| E2 ランタイムと Web API | workerd の下流のリポジトリと取り込み、制限の強制、テナントのローダー、isolate の予備と退避、互換の日付、ECMA-429 と WPT、`request.<brand>`、Node.js の互換 | 未着手（前に動的な読み込みの PoC） |
| E3 サンドボックスとセキュリティ | 名前空間・seccomp・cgroup、cordon、Spectre の対策と検知の実験、V8 の 24 時間の経路、脱出のテスト、ファズ、シークレットの暗号化、署名の検証 | 未着手（前に V8 のサンドボックスの確認） |
| E4 エッジの網とルーティング | GA と NLB、入口のプロキシ、証明書、ルート、ホームのノード、外向きのプロキシ、`drain`、オリジンへの転送 | 未着手（前に利用者の IP の確認。既定のサブドメインの公開は法務：L1・L2、迂回は L3） |
| E5 デプロイと設定の配信 | 版とデプロイ、段階的なデプロイ、ロールバック、変更のログと配信、スナップショット、伝搬の SLI、配信の制御役、基盤の器、フィーチャーフラグ | 未着手 |
| E6 開発者の道具とログ | CLI、設定ファイル、ローカル開発、tail、利用者のログ、関数のメトリクス、型、ダッシュボード、K4 | 未着手（tail とログの保存は法務：L2、CLI の配布は L6） |
| E7 KV | 正本、ゲートウェイ、2 段のキャッシュ、一覧、一貫性の計測、大阪への複製 | 未着手 |
| E8 オブジェクトストレージ | S3 互換のゲートウェイ、マルチパート、バインディング、ライフサイクル、公開の配信、署名付きの URL | 未着手（公開のバケットは法務：L1） |
| E9 Durable Objects | 台帳、ルーター、リースとフェンシング、ログのノード、PITR、アラーム、休止、Jepsen の形の試験 | 未着手（前に保存の層の PoC。配置は法務：L3） |
| E10 キューと cron | SQS とディスパッチャー、再試行と DLQ、pull、cron のスケジューラー | 未着手 |
| E11 制限と課金 | 制限の表、期間の枠と費用の上限、使用量の経路、円の料金、適格請求書、支払いと未払い | 未着手（請求書・前払い・海外の販売は法務・経理：L5） |
| E12 不正利用・運用と GA の準備 | Trust & Safety、監査の鎖と WORM、削除、報奨金、侵入試験、DR の訓練、SLO の文書、GA の判定 | 未着手（GA の判定は法務：L1〜L7） |
| E13 自前の IP と PoP（S2・S3） | BYOIP（S2）、自前の AS と PoP と BGP anycast（S3）、PoP の中の L4 の負荷分散、設定の配信の v2 の形 | 未着手（S2・S3） |
| E14 SQL のデータベース（S2） | DO の SQLite の上の D1 に相当するもの | 未着手（S2） |
| E15 AI の推論（S3） | GPU のフリート、モデルの配布、課金 | 未着手（S3） |
| E16 コンテナ（S2・S3） | microVM の隔離の境界の上のコンテナ | 未着手（S2・S3） |
| E17 ワークフロー（S2） | DO とキューの上の長時間の耐久の実行 | 未着手（S2） |

E1〜E12 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」から集めた。同じ中身の Story が 2 つの文書にあるものは 1 つにした（元の文書を括弧に書く）。

### E1 基盤と PoC

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[security.md](architecture/security.md)、[observability.md](architecture/observability.md)、[dashboard-and-api.md](architecture/dashboard-and-api.md)、[capacity.md](architecture/capacity.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | 開発リポジトリ（`<brand>-workerd`・`<brand>-edge`・`<brand>-control-plane`・`<brand>-cli`・`infra`）を作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS とルールセット（`patches/` はテックリードとセキュリティ）を置く（リポジトリ共通の ADR-0005、[delivery.md](architecture/delivery.md) の 2 節） |
| `instance-pmu-pku-check` | 確認：5 つのリージョンの c7i.24xlarge・c7i.12xlarge・m7i.12xlarge で PMU（LLC のミス、分岐の予測の失敗）と PKU が使えるか。AMD の型も確かめる（着手の最初。infrastructure・sandbox-and-security・capacity） |
| `org-accounts-scp` | Organizations、OU、SCP、アカウント（`edge-<r>`・`storage-<r>`・`verify-prod`・`security-lab`・`quarantine`・`probe`・`build-release`）の分離（infrastructure の 1 節、sandbox-and-security） |
| `network-vpc-tgw` | IPAM、エッジとストレージの VPC、セキュリティグループ、TGW とリージョンの間のピアリング、PrivateLink（infrastructure の 3 節、edge-network-and-routing） |
| `node-public-ip-egress` | ノードの公開の IPv4、外向きのプロキシだけが外へ出る縛り、`node_public_ips` の記録（[ADR-0049](decisions/0049-aws-accounts-and-network.md)） |
| `edge-node-ami` | Amazon Linux 2023 の最小の AMI、カーネルの設定、署名、起動の自己検査（PMU・PKU・IMDSv2・seccomp） |
| `asg-warm-pool` | AZ ごとの ASG、warm pool、ライフサイクルのフックでの退避。T8（2 分）の計測 |
| `fleet-support-nodes` | 中継・専用のリゾルバー・DO のホスト・ログのノードの群（infrastructure、durable-objects） |
| `regional-storage-infra` | DynamoDB の表（KV、DO、キュー・cron のリース）、Valkey、S3、Kinesis、SQS の Terraform（kv-store、durable-objects、queues-and-cron） |
| `code-buckets-and-relays` | 各リージョンの `<brand>-code-<r>` バケットと中継のインスタンス（deployment-and-config-distribution） |
| `kms-keys` | `cp-adk-wrap`・`cp-data`（マルチリージョン）、`edge-secrets-<r>`・`edge-tls-<r>`、`release-signing` と鍵のポリシー（security、deployment-and-config-distribution） |
| `aurora-global-database` | 制御プレーンの Aurora Global Database と大阪の待機 |
| `terraform-layout-ci` | Terraform の構成と CI の検査（複数のリージョンを 1 回で変えない、セキュリティグループ、Object Lock） |
| `build-release-and-signing` | `build-release` のアカウント、使い捨てのビルドの環境、Bazel のリモートキャッシュ、KMS の署名とノードでの検証（delivery の 4 節） |
| `weekly-ami-rollout` | 週 1 回の AMI の作成と、ASG のインスタンスの入れ替えの順（delivery の 6 節） |
| `operator-access` | IAM Identity Center の期限付きの権限、2 人の承認の申請の流れ、break-glass の資格情報の封と訓練（[ADR-0046](decisions/0046-control-plane-privilege-separation-and-operator-access.md)） |
| `log-archive-worm` | `log-archive` の Object Lock のバケット、CloudTrail の組織の証跡 |
| `default-domain-and-psl` | 既定のドメイン（`<brand>.<domain>`）と `<console-domain>` の取得、Route 53 のゾーン、CAA、PSL への申請（早めに出す）。Let's Encrypt の上限の引き上げと ZeroSSL の EAB（edge-network-and-routing） |
| `observability-stack` | AMP・Grafana・Alertmanager、ノードの OTel Collector、ラベルの禁止の CI、runbook の注釈の CI |
| `probe-synthetics` | `probe` のアカウントと、5 リージョンの外からの最小の関数の合成監視 |
| `platform-logs` | 基盤のログの Vector → S3・CloudWatch Logs（利用者のログと分ける） |
| `api-skeleton` | 管理 API の骨格（Hono、Zod、OpenAPI、RLS の文脈、RFC 9457、冪等の表）と、全テナントの表の RLS の CI（dashboard-and-api） |
| `accounts-members-roles` | アカウント・メンバー・招待・5 つのロールの表と API |
| `login-and-stepup` | ログイン（Better Auth、メールの OTP、GitHub、Google、パスキー）とステップアップの MFA |
| `api-tokens` | トークンの形、作成、検証、失効の印、スコープ、IP の絞り込み |
| `audit-events` | 監査ログの表（`prev_hash`・`row_hash` を含む）と、変更のハンドラーの共通の書き込み。全ての変更の API に監査の行の CI |
| `secret-scanning-partner` | `<brand>` の接頭辞の衝突の確認、GitHub のシークレットスキャンの登録と受け口 |
| `api-rate-limit` | Valkey の滑る窓、`RateLimit-*` のヘッダー |
| `signup-limits` | アカウントの作成の制限（1 人 3 つ）、メールの確認、既定のサブドメインの公開の条件（abuse-and-trust-safety、dashboard-and-api） |
| `runtime-memory-budget` | ランタイムのプロセスの cgroup のメモリの予算と、ノードの型ごとの isolate の数の見積もり（runtime-and-isolates、capacity） |
| `cp-dr-epoch-drill` | 制御プレーンの DR の切り替えの訓練に、エポックと補正を含める（deployment-and-config-distribution、infrastructure） |

### E2 ランタイムと Web API

設計：[runtime-and-isolates.md](architecture/runtime-and-isolates.md)、[web-apis-and-compat.md](architecture/web-apis-and-compat.md)、[ADR-0006](decisions/0006-workerd-fork-and-upstream-tracking.md)〜[ADR-0009](decisions/0009-cpu-and-memory-metering.md)、[ADR-0014](decisions/0014-wintertc-conformance-and-wpt.md)〜[ADR-0016](decisions/0016-request-brand-metadata.md)

| Story | 内容 |
| --- | --- |
| `dynamic-loading-poc` | PoC：公開版の workerd の `workerLoader` で、テナントのコードを動的に読み込み・降ろせるか、空の isolate を先に作れるか（着手の最初） |
| `workerd-patch-queue` | 下流のリポジトリ、パッチの列、`PATCHES.md`、毎日のパッチの当て直しの CI、パッチの行数の CI（runtime-and-isolates、delivery） |
| `weekly-upstream-intake` | 週 1 回の取り込みのジョブと、性能の退行の門（起動の p99 10%、CPU 時間の中央値 5%） |
| `isolate-limit-enforcer` | `IsolateLimitEnforcer` の実装（CPU 時間の監視のスレッド、メモリの計測、起動の時間）。キューの消費者の 5 分の上限を含む |
| `tenant-loader` | テナントのローダー（memfd でのバンドルの受け渡し、マニフェストの中だけの名前の解決） |
| `isolate-table-and-eviction` | スーパーバイザーの isolate の表、退避のスコアと soft・hard の閾値 |
| `warm-pool-and-code-cache` | 空の isolate の予備と V8 のコードのキャッシュ |
| `invocation-records` | 呼び出しの結果の記録とスーパーバイザーへの送信。`outcome` を課金の区分に合わせる（limits-and-billing） |
| `compat-date-validation` | 互換の日付の範囲の判定と、実験のフラグの拒否 |
| `ecma429-coverage` | ECMA-429 の対応の表と、WPT のディレクトリの対応付け（`wpt/coverage.md`）。実装の有無が分からなかった項目の確認 |
| `wpt-gate` | WPT の部分集合の CI（期待の一覧、逸脱の理由、門の 2 つの条件、20 分以内） |
| `brand-patch` | `request.<brand>`、`<brand>:` のモジュールの名前空間、`navigator.userAgent` |
| `webcrypto-limits` | PBKDF2 の反復の上限と、重いネイティブの API の一覧 |
| `nodejs-compat-scope` | Node.js の互換の範囲の確認（上流の版ごと）、`node:net`・`node:tls`・`node:dns` の失敗の形、`node:fs` の `/tmp` の寿命とメモリの数え方 |
| `internal-invoke-api` | キュー・cron の起動の内部の API と、CPU 時間の上限の表の適用（queues-and-cron） |
| `isolate-metrics` | スーパーバイザー・isolate の集計の指標（observability） |
| `load-test-t1-t4` | T1〜T4（設計点、isolate の数、冷たい起動、制限の超過の混在）。ADR-0054 の初期値を置き換える（capacity） |

### E3 サンドボックスとセキュリティ

設計：[sandbox-and-security.md](architecture/sandbox-and-security.md)、[security.md](architecture/security.md)、[ADR-0010](decisions/0010-process-sandbox-and-egress-invariants.md)〜[ADR-0013](decisions/0013-spectre-mitigations-and-dynamic-isolation.md)、[ADR-0046](decisions/0046-control-plane-privilege-separation-and-operator-access.md)〜[ADR-0047](decisions/0047-kms-key-hierarchy.md)

| Story | 内容 |
| --- | --- |
| `v8-sandbox-default-check` | 確認：上流の workerd の既定のビルドで V8 のサンドボックス・MPK・止めた時計が有効か。無効ならビルドの設定・パッチで有効にし、無効なビルドを CI で落とす（着手の最初） |
| `supervisor-process-launch` | スーパーバイザーのプロセスの起動の順（利用者の名前空間、pivot_root、capability、cgroup） |
| `seccomp-allowlist` | seccomp の許可リストと、テナントのコードの前の適用（workerd へのパッチ）。ステージングの監査のモード |
| `cordon-placement` | cordon の段階と配置、信頼を下げる変更の即時の反映。入力に `risk_level`・`abuse_hold`・`payment_failed` を含める（abuse-and-trust-safety、ADR-0011 の注記） |
| `pmu-sampling` | 性能カウンターの計測（スーパーバイザー）と、isolate への割り当ての輪のバッファ |
| `spectre-threshold-experiment` | 閾値を決める実験：既知の Spectre の概念実証と正当な重い処理の率の分布。ADR-0013 の改訂 |
| `quarantine-cordon` | `cq-quarantine` への移動と 24 時間での解除 |
| `daily-process-rotation` | プロセスの毎日の入れ替え（ずらし、ハッシュの種の変更） |
| `v8-emergency-pipeline` | V8 の修正の経路：検知のジョブ、修正の版の作成、署名、`scope.node_pct` の配信、2 回の承認（sandbox-and-security、delivery） |
| `v8-pipeline-drills` | 毎週の空の実行と、四半期の訓練の手順（runbooks） |
| `escape-test-suite` | 脱出のテストの集まり（CI、ステージング、本番の各 cordon の探りの関数） |
| `fuzzing-infra` | ファズの基盤（Fuzzilli、libFuzzer、cargo-fuzz、security-lab のアカウント） |
| `secret-encryption` | シークレットの暗号化（ADK・RSK）とスーパーバイザーでの復号、平文の漏れのテスト（deployment-and-config-distribution、security） |
| `key-rewrap-rotation` | RSK・RDK・ADK の包み直しのジョブと毎月の入れ替え。ジョブの役割を窓の中だけに限る監視 |
| `artifact-signature-verification` | ランタイムと AMI の署名、ノードでの署名の検証 |
| `reproducible-build-check` | C++・V8・Bazel のビルドの再現性の確認（security の 13 節の決定） |
| `do-host-sandbox` | DO の cordon とホストのプロセスのサンドボックス（VFS 経由のファイル）（durable-objects） |

### E4 エッジの網とルーティング

設計：[edge-network-and-routing.md](architecture/edge-network-and-routing.md)、[ADR-0017](decisions/0017-global-accelerator-and-regional-nlb.md)〜[ADR-0020](decisions/0020-pingora-ingress-and-egress-proxies.md)、[ADR-0044](decisions/0044-egress-abuse-controls.md)

| Story | 内容 |
| --- | --- |
| `client-ip-preservation-check` | 確認：GA → NLB → インスタンスで利用者の IPv4・IPv6 が保たれるか（着手の最初） |
| `global-accelerator` | アクセラレーター（本番と予備）、リスナー、エンドポイントグループ、`edge` のレコード（Terraform） |
| `ingress-proxy` | 入口のプロキシ（Pingora）：TLS の終端、SNI での証明書の選択、ヘッダーの削除と付与、上限 |
| `route-resolution` | ルートの解決（ホスト名の表、パターンの解析と検証、`DT-ROUTE-001`） |
| `home-node-forwarding` | ランデブーハッシュとホームのノードへの転送、断り、内部のポートの mTLS、SNI の先読み（runtime-and-isolates） |
| `region-members` | ノードの一覧（中継の心拍）の配信 |
| `healthz-and-node-drain` | `/healthz` の条件と、ノードの退避の手順 |
| `region-drain` | `drain` の印とリージョンの退かせ方、同時に 2 リージョンまでの制限 |
| `cert-manager-acme` | ACME の注文、DNS-01（Route 53）、HTTP-01（全リージョンの適用の待ち）、ARI、予備の発行局 |
| `tls-key-wrapping` | 鍵の包みと RDK、KMS の暗号化の文脈、ノードの RDK の開き方 |
| `custom-domains` | 所有の確認、ホスト名の状態機械、定期の再確認 |
| `origin-forwarding` | オリジンへの転送と `DT-ROUTE-002`（内部の経路、`<Brand>-Loop`）。**PM の確認事項**（intent の P1）。法務：L2 |
| `egress-proxy` | 外向きのプロキシ：呼び出しの ID の検査、数の強制、専用の再帰のリゾルバー、拒否の一覧、アカウントごとの接続のプール、`fetch`・WebSocket・リダイレクトの検査（sandbox-and-security、web-apis-and-compat） |
| `account-egress-policy` | cordon ごとの外向きの方針（ポートを含む）と `account_egress/` の上書き、送信元の記録の 90 日（abuse-and-trust-safety）。法務：L2 |
| `request-brand-values` | 入口のプロキシで `request.<brand>` の値を計算してランタイムへ渡す（TLS の欄、`colo`、ヘッダーとの一致）（web-apis-and-compat） |
| `geoip-provider` | 位置の表・AS の表の提供元の選定、ノードへの配布と検証（ライセンスは法務：L6 に近い確認） |
| `object-public-read-path` | カスタムドメインの公開の読み込みの経路と、リージョンのキャッシュと消去（object-storage） |
| `storage-api-accelerator` | ストレージの API の口の accelerator（ホームのリージョンだけを指す）（object-storage） |
| `isp-vantage-probes` | 国内の ISP の外部の地点の選定と合成監視、TTFB の実測で遅延の表を置き換える（observability、edge-network-and-routing） |
| `platform-failure-classification` | 入口のプロキシのプラットフォームが原因の失敗の分類と、可用性の SLI（QA が表を承認）（observability） |
| `transfer-metering` | 入口と外向きのプロキシの転送のバイト数の計測（limits-and-billing） |
| `ga-cost-check` | GA の DT-Premium の軸と、AZ をまたぐ転送の実際の量の確認（infrastructure） |
| `default-subdomain-publish` | 既定のサブドメインの公開の開始。法務：L1・L2 |
| `region-failover-policy` | リージョンの間の迂回と、国内の 2 リージョンの同時の `drain` の 2 人の承認。法務：L3 |
| `load-test-t5-t6-t9` | T5（東京から大阪への `drain`）、T6（AZ の喪失）、T9（外向きの接続のプール）（capacity） |

### E5 デプロイと設定の配信

設計：[deployment-and-config-distribution.md](architecture/deployment-and-config-distribution.md)、[delivery.md](architecture/delivery.md)、[ADR-0021](decisions/0021-versions-deployments-and-gradual-rollout.md)〜[ADR-0023](decisions/0023-code-and-secret-distribution.md)、[ADR-0055](decisions/0055-staged-runtime-rollout-by-cordon-and-region.md)・[ADR-0056](decisions/0056-platform-config-staging-and-flags.md)

| Story | 内容 |
| --- | --- |
| `versions-and-deployments` | `scripts`・`script_versions`（3 つの領域の列を 1 つにした定義。[data-model.md](architecture/data-model.md) の 3.2 節）・`deployments` の表と RLS、版の作成の API |
| `upload-verification-fleet` | アップロード時の検証のフリート（別のアカウント、1 回ごとに捨てる isolate）（runtime-and-isolates） |
| `bundle-multi-region-put` | バンドルの 5 リージョンへの同期の PUT と `pending_regions` の再試行 |
| `config-outbox-sequencer` | `config_outbox` と採番器（リース、`LISTEN/NOTIFY`、一括の変更の保留） |
| `distribution-origin` | 配信の元（gRPC のストリーム、直近 1 時間のメモリ） |
| `regional-relay` | リージョンの中継（7 日のログ、心拍、集計、バンドルのキャッシュと先読み） |
| `node-receiver` | ノードの受け手（番号の検査、取り直し、LMDB の書き込み、`mdb_reader_check`）。器の種類と `scope` の評価 |
| `snapshots-and-bootstrap` | スナップショットの作成と、新しいノードの立ち上げ（目標 2 分） |
| `gradual-deployments` | 段階的なデプロイ（万分率、版の鍵、上書きのヘッダー）、入口のプロキシでの版の選び方 |
| `rollback` | ロールバックと、戻せない条件の検査 |
| `version-retention-gc` | 版の保持（直近 100）と、バンドルの掃除のジョブ |
| `priority-containers` | 優先の印の器（証明書・ルート・ホスト名、`account_state`・`script_state` の措置）（edge-network-and-routing、abuse-and-trust-safety） |
| `platform-config-scope` | 基盤の器の `scope` と 2 人の承認、受け手の検証（delivery、security）。`region_key`・`account_egress` を基盤の器として配る |
| `rollout-controller` | 配信の制御役：波、関門の判定、自動の止めと戻し |
| `runtime-dual-version` | ランタイムの版の 2 つ置きと、プロセスの入れ替えでの戻し |
| `feature-flags` | `platform_flags` と古いフラグの CI の警告 |
| `propagation-sli` | 伝搬の SLI の計測（適用の番号の報告と集計）、ダッシュボード、1 分ごとの合成のデプロイ（observability） |
| `distribution-property-tests` | 性質ベーステスト（配信の正しさ、採番の順序、エポック）と障害の注入 |
| `propagation-volume-check` | 確認：S1 の変更の量と伝搬の時間の実測（着手の中ごろ） |
| `do-deploy-recreate` | デプロイのときの全実体の作り直しと、WebSocket を切る通知（durable-objects） |
| `version-config-metadata` | 版に `config_sha256`・`source_map_keys` を残す（developer-tooling） |
| `load-test-t7-t8` | T7（毎秒 100 の変更を 1 時間）、T8（新しいノード）（capacity） |

### E6 開発者の道具とログ

設計：[developer-tooling.md](architecture/developer-tooling.md)、[dashboard-and-api.md](architecture/dashboard-and-api.md)、[ADR-0035](decisions/0035-cli-and-single-jsonc-config.md)〜[ADR-0037](decisions/0037-tail-sessions-and-tenant-logs.md)

| Story | 内容 |
| --- | --- |
| `cli-skeleton` | CLI の骨格（コマンドの解析、出力の形、終了コード、更新の知らせ） |
| `cli-login` | `login`（PKCE とループバック、デバイスのフロー、キーチェーン）と、`oa`・`or` のトークン、系列の失効（dashboard-and-api） |
| `config-schema` | 設定ファイルの JSON Schema と Zod、環境の受け継ぎ、`check` |
| `bundling` | esbuild、unenv の polyfill、`request.cf` の lint、大きさの手元の検査（web-apis-and-compat） |
| `cli-deploy` | `deploy`・`versions`・`deployments`・`rollback`（冪等キー、伝搬の待ち、差の表示、`startup_time_ms`、`init` で互換の日付を当日に）（runtime-and-isolates、deployment-and-config-distribution） |
| `cli-secrets` | `secret put`・`bulk`（標準入力、`--version-only`） |
| `workerd-binary-distribution` | `@<brand>/workerd-*` のバイナリの配布と SHA-256 の照合、`THIRD_PARTY_NOTICES`。法務：L6 |
| `local-dev-server` | `dev`：開発サーバー、ライブリロード、`request.<brand>` の模擬、`/__scheduled` |
| `local-storage-sims` | 模擬のサービス（kv-sim、bucket-sim、queue-sim）と Durable Objects の手元の保存（PoC を最初に）。CLI の `kv`・`queues`・バケット・PITR の操作（kv-store、object-storage、queues-and-cron、durable-objects） |
| `remote-bindings` | 遠隔のバインディング（`remote-proxy`） |
| `prod-diff-warnings` | 本番との差の警告（宛先の拒否の範囲、CPU 時間、サブリクエストの数）と `--enforce-limits` |
| `types-generation` | `types` と `@<brand>/runtime-types` の生成・公開 |
| `tail` | セッションの API、印の器 `tail/`、ノードのイベントの作成と伏せる処理、リージョンの中継、東京のハブ、CLI とダッシュボードの表示。法務：L2 |
| `tenant-logs` | Vector、Kinesis、取り込み、ClickHouse（PoC で運用の形を決める）、問い合わせの API、ソースマップの戻し。法務：L2 |
| `invocation-traces` | 呼び出しのトレース（サブリクエストとバインディングの `spans`） |
| `function-metrics` | `invocation_rollup_1m` と利用者のメトリクスの画面・API（observability） |
| `support-log-access` | 運用者の期限付きのログの閲覧（2 人の承認、監査ログ） |
| `vitest-pool` | `@<brand>/vitest-pool`（後半） |
| `k4-e2e` | K4 の E2E の計測（毎週） |
| `dashboard-skeleton` | ダッシュボードの骨格（ルーター、生成したクライアント、i18n、a11y の検査、CSP） |
| `dashboard-script-pages` | 関数の画面（概要、版、段階的なデプロイ、ロールバック、設定、ログ） |
| `dashboard-resource-pages` | ストレージ・ドメイン・メンバー・トークン・監査ログの画面、アクセスキーの発行（object-storage）、ルート・カスタムドメインの設定と向き先の案内（edge-network-and-routing） |
| `compat-status-docs` | 互換の状況の表（Node.js の API、ECMA-429 の逸脱、WPT の通過率）の公開の文書（web-apis-and-compat） |
| `cli-weekly-release` | CLI の週 1 回の発行（provenance つき）（delivery） |

### E7 KV

設計：[kv-store.md](architecture/kv-store.md)、[ADR-0024](decisions/0024-kv-central-store-dynamodb.md)・[ADR-0025](decisions/0025-kv-two-tier-cache-and-staleness.md)

| Story | 内容 |
| --- | --- |
| `kv-entries-and-writer` | `kv_entries` の表と書き込みサービス（条件付きの書き込み、429、大きな値の S3） |
| `kv-gateway` | KV のゲートウェイ（リージョン）と、外向きのプロキシのバインディングの口 |
| `kv-l1-cache` | L1 のキャッシュ（外向きのプロキシのメモリ）と、`fetched_at` を引き継ぐ古さの判定 |
| `kv-l2-cache` | L2（Valkey）、版の比較のスクリプト、同時のミスの集約、先読み、古くても返す段 |
| `kv-list` | 一覧（16 区画の併合、暗号化した `cursor`） |
| `kv-expiry-and-gc` | 有効期限と墓石、掃除のキュー（S3 の古い本体） |
| `kv-consistency-checker` | 一貫性の計測（合成の書き込みと読み込み）と、有界の古さの検査器 |
| `kv-osaka-replica` | グローバルテーブルの大阪の複製と、`kv-region-failover` の訓練 |
| `kv-usage-metering` | 読み込み・書き込み・削除・一覧・保存の量の計測を使用量の集計へ流す（limits-and-billing） |
| `load-test-t10-kv` | T10 の KV の部分（読み込み 1 万件/秒）（capacity） |

### E8 オブジェクトストレージ

設計：[object-storage.md](architecture/object-storage.md)、[ADR-0026](decisions/0026-object-storage-s3-gateway-with-scoped-prefixes.md)〜[ADR-0028](decisions/0028-object-egress-pricing.md)

| Story | 内容 |
| --- | --- |
| `object-gateway-skeleton` | ゲートウェイの骨格：SigV4 の検証（ヘッダー、aws-chunked、署名付きの URL）と名前の変換 |
| `object-sts-sessions` | STS のセッションのキャッシュと、bucket_id の接頭辞に絞ったセッションのポリシー |
| `object-buckets` | バケットの操作（作成・削除・一覧・CORS）と、設定の配信（Aurora → ゲートウェイ・エッジのノード） |
| `object-operations` | オブジェクトの操作（Get・Put・Head・Delete・DeleteObjects・Copy・List）と条件付きの要求 |
| `object-multipart` | マルチパート（暗号化した `UploadId`、7 日の中止） |
| `object-binding` | バインディングの API と、外向きのプロキシの口 |
| `object-lifecycle` | ライフサイクルのジョブ（Inventory、規則の評価、削除・移動・中止）と `x-amz-expiration` |
| `object-linearizability` | 線形化可能性の検査（Jepsen の形）と、S3 の道具の互換の試験 |
| `object-osaka-crr` | 大阪への CRR と `object-region-failover` の訓練 |
| `object-public-buckets` | 公開のバケットと開発用の URL（`<brand>usercontent.<domain>`）、PSL への登録。法務：L1 |
| `object-usage-metering` | 保存・操作・転送の量の計測と集計（転送は公開の配信と S3 の API の口で数える）（limits-and-billing） |

### E9 Durable Objects

設計：[durable-objects.md](architecture/durable-objects.md)、[ADR-0029](decisions/0029-do-placement-and-directory.md)〜[ADR-0032](decisions/0032-do-alarms-hibernation-and-rpc.md)

| Story | 内容 |
| --- | --- |
| `do-storage-poc` | PoC：公開の workerd の Durable Objects と SQLite の保存を、自前の VFS と出力のゲートの確定の約束につなげられるか。機械をまたぐ RPC を運べるか（着手の最初） |
| `do-ids` | ID の形、名前空間の鍵、`idFromString` のタグの検証 |
| `do-directory` | 名前の台帳（東京の条件付きの作成、グローバルテーブルの複製、ルーターのキャッシュ）。法務：L3（配置） |
| `do-router` | DO のルーター（リージョンの決定、リージョンの間の転送、`NotOwner` の再送） |
| `do-placement-leases` | 配置のサービス、ホストのリース、割り当てとエポック |
| `do-log-nodes` | ログのノード（追記、`promised_epoch`、グループの fsync、`archived_lsn` での切り捨て） |
| `do-commit-and-output-gate` | 確定の規則（2 つの AZ）と、出力のゲートの確定の約束 |
| `do-wal-archive` | S3 への WAL の転送、スナップショット、復元 |
| `do-pitr` | PITR の API（ブックマーク、timeline、30 日の掃除） |
| `do-alarms` | アラームの索引とスケジューラー |
| `do-websocket-hibernation` | 接続の保持役と WebSocket の休止 |
| `do-jepsen` | 性質ベーステストと Jepsen の形の試験の環境（毎晩） |
| `do-jurisdiction-and-dr` | 管轄 `jp` と DR の写し、`do-region-evacuate` の訓練 |
| `do-usage-metering` | 要求の数、時間（休止を除く GB 秒）、SQLite の行の読み書き、保存の量の計測（limits-and-billing） |
| `load-test-t10-do` | T10 の DO の部分（2,000 件/秒）と、WAL の PUT の頻度の実測（capacity） |

### E10 キューと cron

設計：[queues-and-cron.md](architecture/queues-and-cron.md)、[ADR-0033](decisions/0033-queues-on-sqs-with-own-dispatcher.md)・[ADR-0034](decisions/0034-cron-sharded-scheduler.md)

| Story | 内容 |
| --- | --- |
| `queue-lifecycle` | キューの作成・削除（SQS のキューの作成、設定の配信） |
| `queue-producer` | キューのゲートウェイと生産者のバインディング（`send`・`sendBatch`、内容の種類、毎秒の上限） |
| `queue-dispatcher` | ディスパッチャー（シャードのリース、受信とバッチ、消費者の起動、確認と再試行）。消費者の CPU 5 分・壁時計 15 分 |
| `queue-concurrency` | 並行の数の自動の調整と、アカウントの上限 |
| `queue-dlq` | DLQ への移動と、上限で捨てたメッセージの記録 |
| `queue-pull-consumer` | pull の消費者の HTTP API |
| `cron-scheduler` | cron のスケジューラー（式の解析、シャードのリース、`cron_fires`、取りこぼしの規則） |
| `queue-cron-durability-tests` | 耐久性の試験（失われた `msg_id` の検査）と、cron の 2 重の起動の試験 |
| `cron-region-failover` | `cron-region-failover` の訓練 |
| `queue-cron-metering` | キューの操作（64 KiB ごと）と cron の起動の計量（limits-and-billing） |
| `queue-scale-check` | 確認：S1 の規模（数万のキュー）の作成と、空のポーリングの費用 |

### E11 制限と課金

設計：[limits-and-billing.md](architecture/limits-and-billing.md)、[ADR-0038](decisions/0038-plan-limits-and-edge-enforcement.md)〜[ADR-0040](decisions/0040-jpy-pricing-invoices-and-spend-controls.md)

| Story | 内容 |
| --- | --- |
| `plan-limits` | `plan_limits`・`account_limits` の表と、版の `limits` の上限の検査 |
| `quota-block-and-spend-cap` | アカウントの状態の `quota_block`・`spend_capped` の器と、入口のプロキシの 1027・1201（deployment-and-config-distribution、edge-network-and-routing） |
| `usage-sender` | ノードの使用量の送り手（spool、束、再送） |
| `usage-aggregator` | Kinesis と東京の集計（`usage_batches`、`usage_hourly`、`usage_daily_counters`） |
| `usage-raw-archive` | 生の束の S3 への保存と、再計算のジョブ |
| `usage-reconciliation` | 突き合わせ（入口の数と呼び出しの記録、サブリクエスト、AWS の請求）と探りのアカウント |
| `price-books-and-rating` | `price_books` と請求の計算（時間ごとの見込み、月の締め）。単価の確定（CPU 時間 7 円などの既定案。**PM の確認事項**） |
| `invoices` | 請求書（適格請求書の PDF と JSON、赤の請求書）。法務・経理：L5 |
| `payments` | 決済の代行の選定とカードの引き落とし、銀行振込の突き合わせ |
| `budget-alerts-and-spend-cap` | 予算の警告と費用の上限の画面と API |
| `delinquency` | 未払いの流れ（再試行、`c1-free` への引き下げ、計画の引き下げ、停止） |
| `promo-credits` | 販促のクレジットの台帳（`credit_grants`・`credit_ledger`）。法務：L5 |
| `cost-model-check` | 確認：原価の見積もり（K8 の式の実測、転送の上乗せの割合、各行の 1.3 倍） |
| `egress-billing` | GA のデータの転送の費用を使用量の集計に入れる。関数の応答を外向きの転送で課金する（capacity、edge-network-and-routing） |
| `log-count-billing` | ログの件数の計測と課金（developer-tooling） |
| `usage-dashboard` | ダッシュボードの使用量と今月の見込みの画面（dashboard-and-api） |
| `new-paid-account-caps` | 採掘の印のあるアカウントの支払いの確認、新しい有料のアカウントの一時の上限（abuse-and-trust-safety） |
| `jp-only-billing` | 請求先が日本のアカウントだけに有料の計画を売る（L5 の確認まで） |

### E12 不正利用・運用と GA の準備

設計：[abuse-and-trust-safety.md](architecture/abuse-and-trust-safety.md)、[security.md](architecture/security.md)、[observability.md](architecture/observability.md)、[infrastructure.md](architecture/infrastructure.md)、[ADR-0043](decisions/0043-hosted-content-abuse-and-takedown.md)〜[ADR-0045](decisions/0045-new-account-risk-scoring.md)、[ADR-0048](decisions/0048-audit-log-integrity-and-data-lifecycle.md)、[ADR-0051](decisions/0051-disaster-recovery-and-honest-rpo.md)

| Story | 内容 |
| --- | --- |
| `abuse-action-containers` | 措置の段の器（`script_state/`・`account_state` の `abuse_hold`）と、入口のプロキシの警告の頁・1203 |
| `trust-safety-console` | Trust & Safety の道具（事件の一覧、証拠の表示、措置の出し入れ、異議）と役割の権限 |
| `abuse-intake` | 通報の窓口（`abuse.<console-domain>` の Web の形、メールの取り込み、信頼できる通報者の API）。法務：L1 |
| `abuse-crawler` | 巡回（別の AWS アカウントのヘッドレスの Chromium、記録の保存） |
| `abuse-static-scan` | 静的な検査（印の規則、同じバンドルの検知） |
| `abuse-classifier` | 判定（規則と分類のモデル、閾値の評価の集まり） |
| `external-blocklists` | 外部の一覧の取り込み（15 分ごと。商用の条件の確認の後） |
| `protected-names` | 保護する名前の一覧と、名前の作成の検査 |
| `account-risk-scoring` | リスクの点数（印の取り込み、規則、`account_risk`、`account_state` への反映）。法務：L7（個人の情報） |
| `legal-requests` | 法務の窓口の記録（`legal_requests`、`legal_holds`、Object Lock のバケットへの書き出し）。法務：L4 |
| `transparency-report` | 透明性の報告の集計 |
| `default-domain-blocklist-monitor` | 既定のドメインの外部の一覧の監視の合成監視 |
| `platform-actions-in-audit` | 基盤の側の操作（停止、サポートの閲覧）を利用者の監査ログに載せる（dashboard-and-api） |
| `audit-export` | 監査ログの CSV の書き出し、18 か月の区画の削除 |
| `audit-chain-worm` | 監査の行のハッシュの鎖、WORM への写し、1 時間ごとの署名つきの要約、日次の突き合わせ |
| `account-deletion` | アカウントの削除の予約・戻し・30 日目の削除と ADK の廃棄。法務：L7 |
| `vulnerability-program` | security.txt、報奨金の制度（招待制 → 公開）、研究者用のノードの群、脆弱性の報奨の窓口の開始 |
| `subprocessor-list` | サブプロセッサーの一覧の頁と変更の通知。法務：L7 |
| `external-pentest` | 外部の侵入試験（L1〜L5 の全層、cordon、制御プレーン） |
| `tokyo-loss-drill` | 東京の全体の障害の訓練（staging。[quality.md](quality.md) の 2.4 節の基準） |
| `slo-docs-and-alerts` | SLO の文書、全アラートの runbook の注釈、SLA の草案（法務の確認の後） |
| `freeze-and-error-budget` | 凍結の期間と、エラーの予算での配信の停止（delivery） |
| `npm-publishing` | npm の発行の手順（CI の OIDC、2 人の承認）と、L6 の表示の確定（developer-tooling） |
| `contract-documents` | 利用規約、AUP、DPA、データの所在の説明（製品ごとの RPO の表を含む）。法務：L1〜L7 |
| `ga-readiness` | GA の判定（quality.md の 5 節の E12 の基準）。法務：L1〜L7 |

### E13 自前の IP と PoP（S2・S3）

設計：[infrastructure.md](architecture/infrastructure.md) の 8 節、[ADR-0003](decisions/0003-edge-locations.md)

| Story | 内容 |
| --- | --- |
| `byoip-ranges` | IP の範囲と AS 番号の取得、`ga-byoip`、apex の利用者への移行の連絡（S2） |
| `pop-l4-and-transit` | PoP の中の L4 の負荷分散（Unimog に当たるもの）と、PoP と AWS の間の経路（S3 の前に ADR） |
| `authoritative-dns` | 既定のドメインの自前の権威 DNS（S3 の前に検討） |
| `config-distribution-v2` | 設定の配信を、全データを持つレプリカと使うものだけを持つノードの形へ（ノードの LMDB が 10 GB を超える見込みで ADR） |
| `pop-request-fields` | 自前の PoP での `clientTcpRtt` などの欄を、意味を変えずに埋める |

### E14 SQL のデータベース（S2）

| Story | 内容 |
| --- | --- |
| `sql-db-design` | DO の SQLite の保存の上の SQL のデータベース（D1 に相当）の intent と ADR。読み込みの複製の古さの約束 |

### E15 AI の推論（S3）

| Story | 内容 |
| --- | --- |
| `ai-inference-design` | GPU のフリート、モデルの配布と署名、テナントの分離、課金の intent と ADR |

### E16 コンテナ（S2・S3）

| Story | 内容 |
| --- | --- |
| `containers-design` | microVM（Firecracker）の隔離の境界の上のコンテナの intent と ADR（[github の ADR-0023](../../github/docs/decisions/0023-firecracker-microvm-runners.md) を参考にする）。`c3-dedicated` の強化にも使う |

### E17 ワークフロー（S2）

| Story | 内容 |
| --- | --- |
| `workflows-design` | DO とキューの上の長時間の耐久の実行の intent と ADR |

## エージェントに任せないこと

- **契約（設定ファイルのスキーマ、OpenAPI、束の形、器の種類、エラーの番号、ECMA-429 の逸脱の一覧、WPT の期待の一覧、seccomp の許可リスト）の確定**：変えると互換と隔離に直接効く。
- **隔離の判断**：脱出のテストの類の削除、seccomp の許可の追加、cordon の条件、Spectre の検知の閾値。Dev のテックリードとセキュリティの担当が判断する。
- **V8 の緊急の経路の 2 回の承認、ランタイムの本番の最初の波（W1）の開始、基盤の器の作成と範囲の拡大**：人が承認する（[ADR-0012](decisions/0012-v8-24-hour-patch-pipeline.md)、[ADR-0055](decisions/0055-staged-runtime-rollout-by-cordon-and-region.md)、[ADR-0056](decisions/0056-platform-config-staging-and-flags.md)）。
- **東京の全体の障害の切り替え、DO のリージョンの退避、国内の 2 リージョンの同時の `drain`**：Ops の責任者と Dev のテックリード（[runbooks/disaster-recovery.md](runbooks/disaster-recovery.md)）。
- **価格の値（要求、CPU 時間、転送、ストレージ）と無料の枠**：PM。
- **不正利用の措置のうち人が決めるもの**（`suspend_account`、`terminate`、異議）と、捜査機関の照会：Trust & Safety と法務。
- **法務・経理の判断**（L1〜L7）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、設計点・台数・上限・退路（空の isolate の予備を諦める、IPv4 だけで始める）の採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E13〜E17 に入れなかったもの。着手するときに `intent.md` から起票する（[intent.md](intent.md) の「MVP の後の Epic で扱う」と、各領域の文書の持ち越し）。

- **S2 の規模**：12〜15 リージョン（Local Zones の利用は未検証）、KV の海外への読み込みの複製（[kv-store.md](architecture/kv-store.md) の 13 節）、Smart Placement に相当する配置、オブジェクトのホームのリージョンの選択、`eu` の管轄、生産者の近くのキューの保存（DO の上の自作への移行を含む。[ADR-0033](decisions/0033-queues-on-sqs-with-own-dispatcher.md)）、cron の起動のリージョンの分散。
- **国内の DR の台数の削減**：warm pool の実測（T8）で、片方のリージョンの待機の台数を減らせるか（[capacity.md](architecture/capacity.md) の 11 節）。
- **管轄 `jp` の DO の東京・大阪の同期の複製**（[ADR-0051](decisions/0051-disaster-recovery-and-honest-rpo.md)）、DO のリースの DynamoDB への依存の見直し（[ADR-0030](decisions/0030-do-leases-and-fencing.md)）。
- **Cache API、CDN としてのキャッシュ、WAF**、**静的なアセットの配信（Pages に相当）と画像の変換**、**TCP のソケット（`connect()`。25・465・587 は既定で拒否）**、**`node:dns`**、**メールの受信、ブラウザの実行、ベクトルの索引、分析のエンジン**（intent）。
- **HTTP/3**、**RSA の証明書**（[edge-network-and-routing.md](architecture/edge-network-and-routing.md) の 17 節）。
- **24 時間のキューの遅延**、**128 KiB を超えるメッセージ**（[queues-and-cron.md](architecture/queues-and-cron.md) の 13 節）。
- **オブジェクトの自前のメタデータの DB（8 KiB のメタデータ、バージョニング）**、**SSE-C・SSE-KMS**、**同じキーへの書き込みの 1 秒に 1 回の制限**、**外向きの転送の原価の削減（CloudFront など）**（[object-storage.md](architecture/object-storage.md) の 14 節）。
- **アカウントごとの鍵・BYOK**、**`c3-dedicated` のアカウントの単位の RSK**、**シークレットのサービスのアカウントの範囲ごとの分割**（[security.md](architecture/security.md) の 13 節）。
- **利用者が作るロール**、**監査ログのバケットへの書き出し**、**GitHub 以外のシークレットスキャン**（[dashboard-and-api.md](architecture/dashboard-and-api.md) の 14 節）。
- **Tail Workers と OTLP の書き出し**、**`spans` のキーの名前**（[developer-tooling.md](architecture/developer-tooling.md) の 15 節）。
- **`usage_hourly` の ClickHouse への移行**（Aurora の加算が詰まったとき。[data-model.md](architecture/data-model.md) の 4 節）。
- **入口のプロキシの無停止の再読み込みでの差し替え**（[delivery.md](architecture/delivery.md) の 14 節）。
- **MPK の自前の実装**（[sandbox-and-security.md](architecture/sandbox-and-security.md) の 14 節）。
- **児童の性的な搾取の内容の能動のハッシュの照合**、**巡回の送り元の多様化**（[abuse-and-trust-safety.md](architecture/abuse-and-trust-safety.md) の 17 節）。
- **前払いのクレジットの販売**（L5）、**海外の利用者への有料の計画**（L5）、**専用の契約の料金の形**（[limits-and-billing.md](architecture/limits-and-billing.md) の 15 節）。
- **送信元の IP の一覧の公開**（[edge-network-and-routing.md](architecture/edge-network-and-routing.md) の 17 節）。
- **自前でホストする版の配布**（上流の workerd が担う。intent）。

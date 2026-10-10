# Roadmap: Salesforce

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E3 で、組織の作成・ログイン・カスタムオブジェクトと項目の追加・メタデータのバージョンと部品のキャッシュ・レコードの保存（DML の手順の骨格）・問い合わせの言語から SQL・REST API・上限の計測を端から端まで貫いてから、機能を広げる。組織の分離（RLS と `shard_no`）、データ層を通らない SQL の禁止、上限の計測器、漏えいの経路の登録簿の CI は、E1 から本物の形で作る。後から足すと直せないため。
- **アクセスの判定は決定表と参照の評価器で確かめてから広げる。** 共有・FLS の判定を変える Story は、`DT-*` の表駆動テスト、参照の評価器との性質ベーステスト（`PROP-SHR-*` など）、`LEAK-*` の否定側のテストを通してからマージし、影の実行（[ADR-0063](decisions/0063-org-staged-release-and-shadow-evaluation.md)）を経て組織の単位で広げる（[quality.md](quality.md) の 2 節）。
- **上限は登録簿と試験を一緒に変える。** 上限を足す・変える Story は、先に [governor-limits.md](architecture/governor-limits.md) を直し、上限の試験（ちょうどで通り、1 つ超えたら巻き戻る）を同じ PR に入れる（[ADR-0061](decisions/0061-access-decision-and-limit-gates-in-ci.md)）。
- **契約を先に固定する。** 問い合わせの言語の文法、REST API の形とエラー、`<Brand>-Limit-Info`、変更のイベントの形、Webhook の署名、メタデータのパッケージの形式、決定表の列は、人間がレビューして確定する。エージェントは勝手に変えない。
- **`security:sensitive` の変更は 2 人の人が承認する**（[ADR-0062](decisions/0062-security-sensitive-change-flow.md)）。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」）。下の表で「法務：L*」と書いた Story が当たる。
- **1 変更 1 PR を目安に、差分を小さくする。** DML の手順・コンパイラの段・共有の判定に触れる変更は、他の変更と混ぜない。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・アカウントとネットワーク、主・`events`・`history` の Aurora と RLS と論理シャード、OpenSearch と Valkey、KMS と組織の DEK、CI（決定表・性質・上限・漏えいの経路の関門）、フラグと組織の段、可観測性と合成監視、outbox と Relay | 設計中 |
| E2 組織と利用者 | 組織の作成と削除、エディションとライセンス、利用者、Better Auth のログインと MFA、SSO、OAuth、組織のドメイン、Setup の画面の骨格、プロファイル | 未着手（SSO は法務：L2。利用規約は L1・L7） |
| E3 メタデータの実行基盤 | データ辞書、カスタムオブジェクトと項目、バージョンと部品のキャッシュ、records とピボット、DML の手順の骨格、ごみ箱、問い合わせの言語と計画、REST API、上限の計測と割り当て | 未着手 |
| E4 アクセス制御 | 権限セットと FLS、システムの権限、OWD・ロール・グループと閉包、共有ルール・手動の共有、再計算、参照の評価器、本番の標本の照合、影の実行 | 未着手 |
| E5 営業のオブジェクトと画面 | 取引先・取引先責任者・リードと変換・商談・活動、重複の規則と日本語の照合、レコードのページ、リストビュー、全文検索、メールの記録と送信 | 未着手（取引先責任者・リードは法務：L1。メールは L4） |
| E6 宣言的な自動化 | 数式、入力規則、フロー（保存の前・後、予定・非同期の経路、スケジュール、画面、イベント）、積み上げ集計、承認 | 未着手 |
| E7 レポートとダッシュボード | レポートの型、見る人の権限での集計、同期と非同期、ダッシュボードと部下の視点、定期の配信、エクスポート | 未着手 |
| E8 変更のイベントと連携 | 変更のイベントと再生、組織が定義するイベント、Webhook、外向きの呼び出し、prod-egress の送信の網 | 未着手（Webhook は法務：L2・L4） |
| E9 一括の API とインポート | 取り込みと問い合わせのジョブ、公平な順番、upsert、インポートのウィザード、照合での既存の更新 | 未着手 |
| E10 Sandbox とメタデータのデプロイ | Sandbox の種類と複製とマスキング、パッケージの形式、検証・適用・すばやいデプロイ・戻し、組織の間の送り受け | 未着手（データを含む Sandbox は法務：L3） |
| E11 監査 | 設定の変更の履歴とハッシュの鎖、ログインの履歴、項目の変更の履歴（`history` のクラスタ）、保持と消去、上限の Setup の画面 | 未着手（保持は法務：L5） |
| E12 本番の準備 | 負荷試験と上限・割り当ての値の確定、騒がしい隣人の試験、組織の移動、DR の訓練、外部のペンテスト、SLO の確定、GA の判定 | 未着手（GA の判定は法務：L1・L6・L7・L9・L10） |
| E13 利用者のコード（MVP の後） | TypeScript のトリガー、QuickJS-ng と Wasmtime の砂場（`code-runner`）、ホストの API、`tx.code_*` | 未着手（MVP の後） |
| E14 パッケージ（MVP の後） | 名前空間、署名、インストールとバージョンの上げ、`locked` の部品、名前空間ごとの上限の内訳 | 未着手（MVP の後。法務：L11） |
| E15 CPQ（MVP の後） | 商品・価格表・商談の商品、見積もりの構成と価格、見積もりの承認、見積書の出力 | 未着手（MVP の後） |
| E16 売上予測（MVP の後） | 予測の期間と分類、ロール階層での積み上げ、調整と履歴、予測のレポート | 未着手（MVP の後） |
| E17 AI（MVP の後） | スコアリング、要約、エージェント（本家の Einstein・Agentforce に相当） | 未着手（MVP の後。法務：L1・L2） |
| E18 テリトリーとチーム（MVP の後） | テリトリー管理（テリトリーの階層と割り当ての規則、共有の理由の追加）、商談チーム・取引先チームの細かな設定 | 未着手（MVP の後） |
| E19 複数の通貨と言語（MVP の後） | 複数の通貨と換算、日本語・英語以外の画面の言語 | 未着手（MVP の後） |

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Story の候補」から集めた。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

### E1 基盤

設計：[infrastructure.md](architecture/infrastructure.md)、[delivery.md](architecture/delivery.md)、[observability.md](architecture/observability.md)、[security.md](architecture/security.md)、[data-storage.md](architecture/data-storage.md)、[data-model.md](architecture/data-model.md)

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Salesforce の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、`.github/security-paths.yml` と CODEOWNERS を置く（リポジトリ共通の ADR-0005、[ADR-0062](decisions/0062-security-sensitive-change-flow.md)） |
| `terraform-accounts` | Organizations、management・security・log-archive・shared・edge・dev・staging・prod・prod-egress のアカウント、SCP、IAM Identity Center、`cells.yaml`（[ADR-0054](decisions/0054-accounts-network-and-service-separation.md)） |
| `log-archive-object-lock` | log-archive の監査の錨と外部の保管のバケット（Object Lock のコンプライアンスのモード）と、Worker の `PutObject` だけの権限（[ADR-0046](decisions/0046-setup-audit-trail-and-login-history.md)） |
| `prod-network` | prod の VPC（public・private・isolated）、VPC エンドポイント、Network Firewall、ALB と CloudFront の秘密のヘッダー |
| `aurora-main-and-rls` | 主の Aurora、256 の LIST 分割（13 表）、`FORCE ROW LEVEL SECURITY` と `SET LOCAL app.org_id`・`app.shard_no`、DB のロール（`app_runtime`・`app_worker`・`admin_cross_org`・`maint`）、パラメーター（[ADR-0005](decisions/0005-tenancy-and-governor-limits.md)、[ADR-0010](decisions/0010-record-tables-partitioning-and-pivots.md)） |
| `aurora-events-and-history` | `events` と `history` のクラスタ、日ごと・月ごとの分割、Global Database の副（[ADR-0033](decisions/0033-change-event-log-and-replay.md)、[ADR-0047](decisions/0047-field-history-tracking-and-retention.md) の注記） |
| `opensearch-and-valkey` | OpenSearch のドメイン（`r7g.2xlarge` × 6、VPC、暗号化、IAM、索引の別名）と Valkey（[capacity.md](architecture/capacity.md) の 7.1 節） |
| `ecs-services-skeleton` | `runtime`・`metadata`・`bulk`・`worker`・`cross-org-worker`・`relay`・`indexer` の ECS の骨格、タスクのロール、`admin_cross_org` の分離 |
| `kms-and-org-deks` | KMS の鍵（セル × 用途）、`org_keys` と DEK のライブラリ（AAD、5 分のキャッシュ）、秘密の型 `Secret<T>`（[ADR-0052](decisions/0052-key-hierarchy-and-per-org-data-keys.md)） |
| `org-resolution-entry` | ホスト名・トークンから DB を読む前に組織を決める入口、未知のホスト名の 404、`org_placements`・`shard_map` の解決（[ADR-0055](decisions/0055-shard-placement-and-stage-criteria.md)） |
| `outbox-and-relay` | outbox（`kind` の一覧。[data-storage.md](architecture/data-storage.md) の 3.5 節）と Relay（論理シャードごとの唯一の書き手、`replay_id`、重複の除き） |
| `ci-structural-gates` | PR の CI の構造の lint（コンパイラの外の SQL、`shard_no` の定数のない SQL、マイグレーションの外の DDL、OpenSearch の問い合わせの組み立ての関数、ログの型）、依存の lint（本家の SDK）、マイグレーションの検査（`org_id`・RLS・許可リスト） |
| `ci-decision-tables` | 決定表の読み取りの道具（`spec.md` の Markdown の表から行ごとのテスト）と、表の行とテストの数の検査。`DT-SHR-*`・`DT-AUTH-*`・`DT-EVT-001` などの枠 |
| `ci-property-harness` | 性質ベーステストの枠（fast-check、Testcontainers）。PR 1,000 通り、`security:sensitive` 1 万通り、夜間 10 万通り。参照の評価器の雛形 |
| `ci-limits-registry-sync` | 上限の登録簿（`packages/limits/registry.ts`）と governor-limits.md の 4.1・6 節の一致の検査、試験のない上限の検出、例外の一覧（[ADR-0061](decisions/0061-access-decision-and-limit-gates-in-ci.md)） |
| `ci-leak-register` | 漏えいの経路の登録簿（`LEAK-001`〜`030`）のテストの ID の参照の検査（[ADR-0051](decisions/0051-leak-path-register-and-threat-model.md)） |
| `security-sensitive-flow` | パスの規則、自動のラベル、2 人の必須のレビュー、PR のテンプレートの問い（[ADR-0062](decisions/0062-security-sensitive-change-flow.md)） |
| `nightly-ci-and-merge-queue` | 夜間の CI（性質 10 万通り、障害の注入、小さな負荷の回帰）と merge queue の必須の検査 |
| `flags-org-stages` | AppConfig のフラグ（組織の ID での評価、`internal`〜`all` の段、ガード）（[ADR-0063](decisions/0063-org-staged-release-and-shadow-evaluation.md)） |
| `telemetry-and-log-types` | ADOT・AMP・Grafana、ログの型と lint、出力の走査（秘密・個人データの形）、`application_name` の設定（[ADR-0058](decisions/0058-slis-and-per-org-resource-metrics.md)） |
| `per-org-usage-tables` | `org_db_time_minutes`・`org_request_minutes`・`org_worker_minutes`、1 分の桶、上位 50 のラベル |
| `synthetic-monitoring` | 監視の組織（東京と大阪）と、ログイン → 作成 → 読み → 問い合わせ → リストビュー → 検索 → 変更のイベント → 削除の 1 分ごとの合成監視 |
| `operator-jit-access` | 運用者の JIT のロール（`support-read`・`support-data`・break-glass）と IAM Identity Center（[ADR-0053](decisions/0053-operator-access-and-data-lifecycle.md)） |
| `osaka-warm-standby-skeleton` | 大阪の Global Database の副（主・`events`・`history`）、最小のタスク、空の OpenSearch と Valkey、KMS のレプリカ（[ADR-0057](decisions/0057-disaster-recovery-osaka-warm-standby.md)） |

### E2 組織と利用者

設計：[orgs-users-and-auth.md](architecture/orgs-users-and-auth.md)、[sharing-and-record-access.md](architecture/sharing-and-record-access.md) の 3 節、[ui-layouts-and-list-views.md](architecture/ui-layouts-and-list-views.md) の 7・8 節、[security.md](architecture/security.md) の 6・7 節

| Story | 内容 |
| --- | --- |
| `org-signup-and-create` | 申し込み、メールの確認、組織の作成（`shard_no`、種、最初の管理者、全部品の事前のコンパイル。30 秒以内）（法務：L1・L7 の利用規約） |
| `org-seed-standard-objects` | 標準オブジェクト（取引先、取引先責任者、リード、商談、活動、メール）のデータ辞書と、既定のフェーズ・リードの状態・ToDo の状態・レイアウト・リストビュー・レポートの型の種 |
| `editions-and-features` | エディションと機能の組、上げ下げ（使えなくなる設定を無効にする）。E2 の着手前に PM がエディションと価格を決める |
| `licenses-and-permset-license` | ライセンス（`full`・`platform`・`integration`）と `permission_sets.license` の上限 |
| `profiles-base-permsets` | プロファイル（既定値と基本の権限セット）と、利用者の作成での割り当て |
| `users-lifecycle` | 利用者の招待・作成・無効化・凍結・匿名化（`username` は全ての組織で一意） |
| `better-auth-login-mfa` | Better Auth のログイン（パスワード、MFA、パスキー、回復の番号）と `DT-AUTH-001`（[ADR-0044](decisions/0044-authentication-better-auth-sso-and-mfa.md)） |
| `privileged-passkeys` | 特権を持つ利用者（`modify_all_data`・`manage_users`・`customize_application`）のパスキーの必須（TOTP・回復の番号を断る、特権の付与でセッションを切って登録を求める）、`sso_bypass` の非常用の管理者のハードウェアのキー 2 つ（attestation の確かめ）、`DT-AUTH-001` の行 4・6・8、`PROP-AUTH-003`（ADR-0044 の注記） |
| `sessions-and-login-restrictions` | セッション（無操作の期限、絶対の期限、一覧と取り消し）、ログインの時間帯と IP |
| `org-sso-saml-oidc` | SSO（SAML・OIDC）、`federation_id`、JIT、`sso_bypass`、SSO の MFA の主張の確かめ（`amr`・`AuthnContextClassRef` の接続ごとの受け入れの一覧、既定で有効、理由を記録した時だけの無効化と監査・知らせ、主張がない時の 2 つ目の要素。`DT-AUTH-001` の行 5〜8）（法務：L2） |
| `oauth-clients-and-tokens` | OAuth のクライアント、認可コード＋PKCE、クライアントクレデンシャル、`token_routes`、画面の API をセッションの Cookie だけにする |
| `org-my-domain` | 組織のドメインと名前の変更の転送（90 日） |
| `login-history-ingest` | ログインの履歴（outbox から、`username_hash`、1 秒のまとめ） |
| `setup-shell-and-translations` | Setup の画面の骨格（JSON Schema からの汎用の編集の画面、要素ごとの楽観の鍵）と、日本語・英語のラベル（`md_translations`） |
| `report-folders` | レポートとダッシュボードのフォルダと、自分のフォルダ |
| `sandbox-org-kind` | Sandbox の組織（`kind`、`parent_org_id`、Sandbox の列、ドメイン）と、種類ごとの数と容量 |
| `support-access-grants` | サポートのアクセスの許可の Setup の画面と、サポートの道具の監査 |
| `org-deletion-and-purge` | 組織の削除（30 日の猶予、書き出し、7 日の消去、最後に DEK の破棄、`org_purge_overdue`）（法務：L7） |

### E3 メタデータの実行基盤

設計：[metadata-and-runtime.md](architecture/metadata-and-runtime.md)、[data-storage.md](architecture/data-storage.md)、[query-language-and-api.md](architecture/query-language-and-api.md)、[governor-limits.md](architecture/governor-limits.md)

| Story | 内容 |
| --- | --- |
| `data-dictionary` | データ辞書の表、オブジェクト・項目の作成・名前の変更（`field_no` の採番、`x_` の接頭辞）、`data_class`・`searchable`・`track_history`（[ADR-0006](decisions/0006-data-dictionary-and-field-lifecycle.md)） |
| `metadata-versioning` | バージョンを上げる 1 つのトランザクション、`md_changes`、今のバージョンの配布（Pub/Sub と 5 秒の読み直し） |
| `segmented-snapshot-cache` | 部品に分けたスナップショット（形のバージョンを含む鍵）、L1・L2・L3、部品の作成の重複の抑え（[ADR-0007](decisions/0007-segmented-metadata-snapshots.md)） |
| `records-and-pivots` | `records` の読み書きと `derivePivotRows`、差分でのピボットの書き込み、`COLLATE "C"` の前方一致 |
| `unique-and-external-id` | `record_unique_values`、外部 ID、`DUPLICATE_VALUE` |
| `relationships-and-long-texts` | `record_relationships`・`polymorphic_lookup`・関連リストの読み、長いテキストの別の表 |
| `pivot-poc` | ピボットの PoC：全項目か指定だけかの書き込みの増幅と問い合わせの速さ、trigram の索引 |
| `dml-order-skeleton` | DML の手順 0〜2・6・9〜12（フローなし）と 200 件の塊、部分の成功、手順 3a・3b・7a・7b・8 の差し込み口、承認のロックの確認の差し込み口（[ADR-0008](decisions/0008-dml-order-of-execution.md)） |
| `record-types-and-picklists` | レコードタイプと使える選択リストの値の検証（手順 2）、`attrs` |
| `layouts-compile` | レイアウトのメタデータと `layouts` の部品、既定の全項目のレイアウト |
| `recycle-bin-and-purge` | ごみ箱：削除、戻す（決定表）、確定と消去の Worker、ごみ箱を空にする（[ADR-0011](decisions/0011-recycle-bin-and-purge.md)） |
| `field-delete-and-conversion` | 項目の削除・復元・確定と消去、項目の型の変換（下見、写す、切り替え、中止、古い値の 15 日） |
| `consistency-checks` | 整合の検査（ピボット・参照・孤児）と、直す処理、`pivot_drift_repaired_total` |
| `query-parser-and-binding` | 問い合わせの言語のパーサー、AST、束縛・型の検査・FLS・共有の条件の付加（段 2〜5）（[ADR-0018](decisions/0018-record-query-language.md)） |
| `query-semantics-sql` | 3 値の論理、正規化した文字列、日付の関数（会計年度）、関係のたどり、集計の SQL の生成と評価器 |
| `query-stats-and-planner` | 統計の表、毎晩の標本、計画の候補（P0〜P3・P5）と閾値、実体化した CTE、途中の計画の変更、`NON_SELECTIVE_QUERY`（[ADR-0019](decisions/0019-selectivity-statistics-and-planning.md)） |
| `rest-api-skeleton` | REST API の骨格：レコードの CRUD、外部 ID の upsert、戻す、記述、エラーの形、`ETag`、OpenAPI の動的な生成（[ADR-0020](decisions/0020-rest-api-shape-and-versioning.md)） |
| `query-api-and-cursor` | 問い合わせの API と暗号化したキーセットのカーソル |
| `tx-limit-meter` | トランザクションの計測器（問い合わせ、行、DML、CPU の近似、メモリー、時間）、`LIMIT_EXCEEDED`、`<Brand>-Tx-Usage`（[ADR-0041](decisions/0041-limits-registry-and-counting-rules.md)） |
| `org-allocations` | API の割り当て（24 時間の移動の窓、110%、fail open、80%・100% の知らせ）、長い要求の同時実行（25）、`<Brand>-Limit-Info`・`/api/v1/limits`（[ADR-0042](decisions/0042-org-allocations-fair-queuing-and-limit-info.md)） |
| `field-history-hook` | 保存の手順 9 の差し込み口（最上位で 1 回、outbox へ） |
| `dml-spans-and-limit-logs` | DML の手順のスパンと、ログの `limits` の項目 |

### E4 アクセス制御

設計：[sharing-and-record-access.md](architecture/sharing-and-record-access.md)、[orgs-users-and-auth.md](architecture/orgs-users-and-auth.md) の 7 節、[delivery.md](architecture/delivery.md) の 6 節

| Story | 内容 |
| --- | --- |
| `permission-sets-and-fls` | 権限セット・グループ・割り当て（期限）、権限の依存の検査、権限の形のコンパイル、FLS をかける場所（読めない項目を存在しない項目と同じに）（[ADR-0013](decisions/0013-permission-sets-and-field-level-security.md)） |
| `system-permissions-and-delegation` | システムの権限の 25 と依存、`DT-AUTH-002`（部分集合の規則、最後の管理者）（[ADR-0045](decisions/0045-system-permissions-and-delegation.md)） |
| `owd-roles-groups-closure` | OWD と `grant_via_hierarchy`、ロールの木、グループの種類、閉包の表と同期の更新（[ADR-0014](decisions/0014-owd-roles-groups-and-closure.md)） |
| `sharing-predicate-compiler` | 問い合わせの時の条件（6.2 節）の生成と `DT-SHR-001`・`002` の表駆動テスト |
| `owner-rules` | 所有者の条件の共有ルール（メタデータだけ） |
| `criteria-rules-versioning` | レコードの条件の共有ルールとルールのバージョンのジョブ、切り替えの前の照合（[ADR-0016](decisions/0016-recalculation-rule-versions-and-skew.md)） |
| `manual-shares-api` | 手動の共有の API（`/shares`）と、所有者の変更での削除 |
| `closure-generations-and-defer` | 閉包の世代のジョブと、共有の計算の保留 |
| `reference-access-evaluator` | 参照の評価器と `PROP-SHR-001`〜`003`（[ADR-0017](decisions/0017-reference-access-evaluator.md)） |
| `access-oracle-sampling` | 本番の標本の照合、`access_oracle_mismatch_total`、呼び出し、アクセスの判定のダッシュボード |
| `activity-sharing` | 活動の共有（`DT-ACT-001`、DT-SHR-001 の行 3）と、多態の主の親での問い合わせの条件 |
| `layout-access-dt-ui` | `DT-UI-001`（FLS・水準・レイアウト）と、画面の保存での `readonly`・`required` |
| `team-view-intersection` | 部下の視点の共通部分（2 人の共有の条件の `AND`、2 つの権限の形の FLS の共通部分）のコンパイラの部品 |
| `search-access-dt` | `DT-SRCH-001` と `PROP-SRCH-001`・`002` |
| `shadow-evaluation` | 影の実行（標本、reader での実行、比べ、評価器での判定、`shadow_eval_results`）（[ADR-0063](decisions/0063-org-staged-release-and-shadow-evaluation.md)） |
| `e4-sharing-poc` | E4 の PoC：所有者の条件のルールの結合の速さ、`G_me` の読みの p99、100 万件・1,000 人のリストビュー、ルールの範囲の 1.5 秒（K6） |

### E5 営業のオブジェクトと画面

設計：[sales-objects.md](architecture/sales-objects.md)、[ui-layouts-and-list-views.md](architecture/ui-layouts-and-list-views.md)、[search.md](architecture/search.md)、[sharing-and-record-access.md](architecture/sharing-and-record-access.md) の 5.5・5.6 節

| Story | 内容 |
| --- | --- |
| `accounts-and-contacts` | 取引先・取引先責任者（カナ、法人番号、日本の住所）、取引先の親の循環の検査（法務：L1） |
| `leads-and-statuses` | リードと状態の値、変換済みのリードを読むだけにする規則（法務：L1） |
| `lead-conversion` | リードの変換の API、項目の対応の設定、変換の画面（[ADR-0021](decisions/0021-lead-conversion-and-activity-parents.md)） |
| `opportunities-and-stages` | 商談とフェーズの属性、`opportunity_history`、商談の取引先責任者の役割 |
| `activities-and-timeline` | ToDo・行動、`activity_relations`（50 件）、活動のタイムラインの画面 |
| `implicit-and-parent-sharing` | 親に連動（活動）、チーム、暗黙の親・子の共有と、ロールの `child_access`、関係をたどる読みの判定 |
| `japanese-normalization` | 日本語の正規化の関数と異体字の表（[ADR-0022](decisions/0022-duplicate-rules-and-japanese-matching.md)） |
| `matching-and-duplicate-rules` | 照合の規則・重複の規則、`record_match_keys` と `building` のジョブ、手順 5 の判定（`DT-DUP-001`）、`allow_duplicates`、重複の記録 |
| `record-page-api` | レコードのページの API と予算、関連リストの遅延の読み込み（[ADR-0023](decisions/0023-layouts-and-record-page-composition.md)） |
| `record-page-ui` | レコードのページの画面（React）、ハイライト、インライン編集と競合の自動の当て直し、最近見たもの |
| `list-views` | リストビューの定義（AST）、ビルダー、`scope`・`visibility`、コンパイル（`DT-LV-001`）、件数（1 万件で打ち切り）、索引の順の計画（[ADR-0024](decisions/0024-list-views-as-filter-ast.md)） |
| `composite-and-collections` | 複合の要求と collections |
| `search-analysis-poc` | 日本語の解析の PoC（kuromoji と Sudachi、2-gram）と評価のコーパス、1 文書の大きさと台数の計測（[ADR-0031](decisions/0031-search-index-and-japanese-analysis.md)） |
| `search-index-pipeline` | outbox から indexer（SQS、まとめ、外部のバージョン）、索引の形、作り直しと整合の検査 |
| `search-api-post-filter` | 検索の API と後の確かめ（固定の候補の束、束の全ての確かめ、1 ページの下限の時間。LEAK-012）、`more_may_exist`、強調、全体とオブジェクトの中の検索の画面、`search_floor_exceeded_ratio` と下限の値の決め直し（[ADR-0032](decisions/0032-search-permission-post-filter.md)） |
| `lookup-typeahead-and-degraded` | 参照の項目の候補（名前のピボットの前方一致＋OpenSearch）と、障害の時の `degraded` |
| `email-sending` | 1 通ずつのメールの送信、`email_opt_out`、SES と送信のドメインの確認、bounce と苦情（法務：L4） |
| `email-bcc-logging` | メールの記録（BCC の受信、差出人の検査、照合、未処理のメール）（法務：L1・L4） |
| `accessibility-baseline` | キーボードの操作、レイアウトのビルダーの代わりの操作、axe の関門 |

### E6 宣言的な自動化

設計：[automation-flows.md](architecture/automation-flows.md)、[metadata-and-runtime.md](architecture/metadata-and-runtime.md) の 7 節、[governor-limits.md](architecture/governor-limits.md) の 4 節

| Story | 内容 |
| --- | --- |
| `formula-language` | 数式の言語：パーサー、型の検査、分類、評価器、SQL の生成、評価器との一致の性質ベーステスト（[ADR-0009](decisions/0009-formula-language-and-evaluator.md)） |
| `formula-indexing-and-fls` | 数式の実体化（索引）と作り直し、数式の FLS と Setup の警告 |
| `validation-rules` | 入力規則（手順 4）：全ての規則の評価、最大 20 件のエラー、文言の差し込みの制限 |
| `flow-definition-and-activation` | フローの定義の形、バージョン、有効化の検査、`object` の部品のフローの呼び出しの表（[ADR-0025](decisions/0025-flow-definition-and-bulk-engine.md)） |
| `flow-interpreter-lockstep` | 解釈器：足並みの実行、まとめる要素、上限の数え方（足並みの 1 歩）、`fault` |
| `record-triggered-flows` | 保存の前（3a）・後（7b）のフロー、実行の順、条件、`DT-FLW-001`、`$Origin`（[ADR-0026](decisions/0026-record-triggered-flow-order-and-recursion.md)） |
| `scheduled-paths-and-async` | 予定の経路（行の書き込み、基準の項目の変更、条件の評価し直し）と非同期の経路（`flow_async_runs`） |
| `rollup-summaries` | 積み上げ集計：差分の直し（`DT-RUS-001`）、集計し直し、`rollup_stale`、`building`、整合の検査、FLS（[ADR-0027](decisions/0027-roll-up-summaries-incremental-with-reconciliation.md)） |
| `approval-processes` | 承認のプロセスの定義、申請・応答・取り消し・付け替え、ステートマシン（`DT-APR-001`）、ロック（`DT-APR-002`）、承認待ちの一覧（[ADR-0028](decisions/0028-approval-processes-and-record-locks.md)） |
| `scheduled-flows` | スケジュールのフロー（予定、塊、24 時間の上限、再開） |
| `screen-flows` | 画面のフロー（状態の保存と暗号化、戻る、期限）と、レイアウトの操作からの起動 |
| `flow-builder-and-debug` | フローのビルダー（画面）とデバッグ（巻き戻す実行、足跡の伏せ方） |
| `flow-limit-counting` | フローの要素の足並みの数え方、積み上げ集計の例外、`tx.outbound_calls`・`tx.emails` の計測 |
| `lead-conversion-flows` | 変換の途中の保存をフローが判断できる情報（`lead_conversions`）と、変換の保存の後のフローのテスト |

### E7 レポートとダッシュボード

設計：[reports-and-dashboards.md](architecture/reports-and-dashboards.md)

| Story | 内容 |
| --- | --- |
| `report-types` | 標準のレポートの型（`opportunity_history`、`<object>_field_history` を含む）の自動の作成と、カスタムのレポートの型、`report_types` の部品 |
| `report-definition` | レポートの定義（AST）、表形式・サマリー・マトリックス、条件、クロス条件、`row_limit` |
| `report-compile-and-fls` | 結ぶ全てのオブジェクトの共有の条件、`DT-RPT-001`、見えない親のグループの見出し（[ADR-0029](decisions/0029-report-execution-on-reader-per-viewer.md)） |
| `report-sync-async` | 同期の実行（reader、予算、`as_of`）と非同期（`DT-RPT-002`、Worker、S3 の結果、24 時間）、見る人ごとのキャッシュ、`report.*` の予算 |
| `field-history-report-join` | `<object>_field_history` のレポートの、主の reader と `history` の reader の ID の束での結び |
| `report-ui-and-charts` | レポートの画面、グラフ、表・グラフの共通の部品 |
| `dashboards` | ダッシュボードの部品・条件・並べ方、見る人の形、部下の視点（`DT-DSH-001`、`view_my_team_dashboards`）（[ADR-0030](decisions/0030-dashboards-viewer-intersection-and-subscriptions.md)） |
| `subscriptions-and-exports` | 定期の配信（受け取る人ごとの実行、散らし、本文）とエクスポート（`export_reports`、100 万行、監査） |
| `report-property-tests` | `PROP-RPT-001`・`002` と、経路ごとの否定側のテスト（LEAK-009・010・019・020） |

### E8 変更のイベントと連携

設計：[events-and-integrations.md](architecture/events-and-integrations.md)、[infrastructure.md](architecture/infrastructure.md) の 2.2 節

| Story | 内容 |
| --- | --- |
| `cdc-objects-and-channels` | 対象のオブジェクトの選択、チャンネル（オブジェクト・全て・カスタム）、割り当て `alloc.cdc_objects` |
| `event-stream-api` | 取り出しの API と SSE、開始の位置、410、3 日の分割の `DROP` |
| `event-subscription-authz` | `DT-EVT-001` と配信の FLS、権限の 60 秒の確かめ（[ADR-0034](decisions/0034-event-subscription-access-and-org-events.md)） |
| `gap-events` | 隙間のイベント（型の変換・整合の検査・消去） |
| `org-events` | 組織が定義するイベントの型、発行の API、`after_commit`・`immediate`、`publish_event` の要素 |
| `event-triggered-flows` | `event_triggered` のフローと、購読者のカーソル（[automation-flows.md](architecture/automation-flows.md) の 3.4 節） |
| `prod-egress-account` | prod-egress のアカウント（送信の VPC、NAT、Elastic IP、本番への経路なし）、`sender`、SQS の受け渡し（法務：L2） |
| `webhooks` | Webhook の宛先の登録、署名 `<Brand>-Signature`、宛先ごとのカーソルの配信、再試行、`disabled`、再送（[ADR-0035](decisions/0035-webhooks-outbound-calls-and-ssrf-guard.md)）（法務：L2・L4） |
| `outbound-calls-and-ssrf-guard` | 外向きの呼び出しの宛先、`call_webhook` の送信、宛先の検査（SSRF のテストの組） |
| `event-allocations` | 発行・配信の割り当て（`alloc.events_published`・`alloc.events_delivered`） |

### E9 一括の API とインポート

設計：[bulk-and-import.md](architecture/bulk-and-import.md)、[governor-limits.md](architecture/governor-limits.md) の 8 節

| Story | 内容 |
| --- | --- |
| `fair-queue-jobs` | `jobs` の表と組織の仮想時刻、class ごとの `org_cap` と重み（[ADR-0042](decisions/0042-org-allocations-fair-queuing-and-limit-info.md)） |
| `bulk-ingest-api` | 取り込みのジョブの API（作成、アップロード、状態、結果、中止、削除）（[ADR-0036](decisions/0036-bulk-jobs-chunking-and-partial-success.md)） |
| `bulk-split-and-process` | 分割（1 万行、親での並べ替え、鍵での振り分け）、部分の処理、`DT-BULK-001`、冪等な再開 |
| `bulk-upsert-and-parent-refs` | 外部 ID の upsert と、親の外部 ID での参照（200 件まとめた一意の値の引き） |
| `bulk-hard-delete` | 完全な削除のジョブ（`bulk_hard_delete`）と監査 |
| `bulk-query-jobs` | 問い合わせのジョブ（reader、範囲、locator、`bulk.query` の予算） |
| `import-wizard` | インポートのウィザード：文字コードの判定（UTF-8・CP932）、対応と対応の型、下見（[ADR-0037](decisions/0037-import-wizard-upsert-and-duplicate-matching.md)） |
| `import-match-update` | 照合の規則での既存の更新（`DT-IMP-001`）と、取り込みでの重複の判定 |
| `bulk-allocations-and-setup` | 一括の割り当て（24 時間の行、ジョブ、結果の大きさ）と、Setup の「一括のジョブ」の画面 |
| `bulk-low-priority-lanes` | 一括の分の索引・変更のイベントを低い優先の経路に入れる、足並みの実行の性能（200 件の塊） |

### E10 Sandbox とメタデータのデプロイ

設計：[sandboxes-and-deploy.md](architecture/sandboxes-and-deploy.md)

| Story | 内容 |
| --- | --- |
| `sandbox-metadata-only` | Sandbox の作成（`developer`・`developer_pro`）（[ADR-0038](decisions/0038-sandbox-types-and-masked-copy.md)） |
| `sandbox-data-copy` | データの複製（`partial` の標本、`full`）と参照の直し（法務：L3） |
| `sandbox-masking` | マスキング（偽の氏名の辞書、HMAC、形を保つ値）、分類の漏れの検出、`PROP-SBX-001`（法務：L3） |
| `sandbox-disable-integrations` | 連携・送信・スケジュールを止めて作る |
| `sandbox-refresh-and-delete` | 再作成と削除 |
| `package-format-and-retrieve` | パッケージの形式（YAML、JSON Schema、正規化）と書き出し（[ADR-0039](decisions/0039-metadata-package-format.md)） |
| `deploy-validate` | 検証（名前の解決、差分、仮のバージョンのコンパイル、データへの影響）（[ADR-0040](decisions/0040-deploy-validation-and-rollback.md)） |
| `deploy-apply` | 適用（ロックの外の行の作成、1 つのバージョン、後の仕事）、書き込みの止まりの計測 |
| `deploy-quick-and-rollback` | すばやいデプロイと戻し |
| `deploy-between-orgs` | 組織の間の送り受け（画面）と CLI |
| `deployable-components` | レイアウト・公開のリストビュー・翻訳・レポートの型・レポート・ダッシュボードをデプロイの対象に足す |

### E11 監査

設計：[audit-and-field-history.md](architecture/audit-and-field-history.md)、[security.md](architecture/security.md) の 7 節

| Story | 内容 |
| --- | --- |
| `audit-events-chain` | 監査のイベントの表、同じトランザクションの書き込み、`audit_pending`、`seq` とハッシュの鎖、毎日の錨（[ADR-0046](decisions/0046-setup-audit-trail-and-login-history.md)） |
| `audit-coverage` | 各領域の管理の操作の記録（メタデータ、権限、利用者、共有、認証、連携、デプロイ、データの大きな操作、ロックを越えた更新）と、管理の API の網羅の検査 |
| `audit-ui-export-verify` | 設定の変更の履歴の画面と API、書き出し、鎖の確かめの API |
| `audit-archive-and-key-destroy` | 外部の保管（組織の `audit` の DEK、Object Lock）と、組織の削除での鍵の破棄（法務：L5・L7） |
| `field-history-tracking` | 項目の変更の履歴の設定（20 項目）、outbox から `history` のクラスタへの写し、読みの API と関連リスト（[ADR-0047](decisions/0047-field-history-tracking-and-retention.md)） |
| `field-history-access` | 履歴の読みの共有と FLS（`DT-FH-002`、`PROP-FH-002`） |
| `retention-and-erasure` | 保持（分割の `DROP`）と値の消去（`erase_history_values`）、全ての `*_overdue` の計測（法務：L1・L5） |
| `admin-change-notifications` | 認証の設定・Webhook の宛先・`bypass` の選択の変更の監査と、組織の管理者全員への知らせ |
| `limits-setup-screens` | Setup の「組織の上限」と「上限に近い自動化」（名前空間の内訳は E14） |

### E12 本番の準備

設計：[capacity.md](architecture/capacity.md)、[infrastructure.md](architecture/infrastructure.md) の 6・7 節、[observability.md](architecture/observability.md)、[security.md](architecture/security.md) の 9 節、[runbooks/](runbooks/README.md)

| Story | 内容 |
| --- | --- |
| `load-model-k6` | capacity.md の 2 節の負荷のモデルで NFR-001〜005・010 を測り、係数を戻す（L1〜L8 の負荷の組。[quality.md](quality.md) の 2.4 節） |
| `limits-final-values` | 全ての上限の試験の網羅の確認と、上限・割り当ての値の確定（E12 の負荷試験の結果） |
| `noisy-neighbor-tests` | 騒がしい隣人の検知（AAS の標本、重い・漏れ）と、上限まで負荷をかけた組織での他の組織の p95（NFR-003、K4） |
| `sharing-recalc-load` | 100 万件でのルールの追加・ロールの移動の負荷試験（NFR-005、K6）、スキューの警告 |
| `bulk-and-events-load` | 100 万件の取り込み（NFR-010）と 1 日 4,300 万件のイベント、K8 の計測 |
| `deploy-stall-load` | 書き込みの止まり（NFR-004）と戻しの時間、`full` の複製の時間 |
| `rollup-parent-load` | 子の多い親の積み上げ集計（5 万件の集計し直しの p99） |
| `search-and-report-perf` | 検索・レポート・レコードのページ・リストビューの性能テスト、reader の台数 |
| `org-migration-tool` | 組織の移動の道具（論理レプリケーション、止め、照合、切り替え）と訓練（[ADR-0056](decisions/0056-org-migration-by-row-filtered-logical-replication.md)） |
| `dr-drills` | DR の訓練（staging の failover、本番の switchover）と失った範囲の取り出し（[ADR-0057](decisions/0057-disaster-recovery-osaka-warm-standby.md)） |
| `slo-and-alert-tuning` | SLO とエラーバジェットの呼び出し、アラートと runbook の対応の確認、未作成の runbook の作成 |
| `pentest-and-dast` | 外部のペンテスト（LEAK の登録簿を渡す。認証、権限の昇格、組織をまたぐ漏えい、SSRF）、DAST、GA の前のセキュリティのレビュー |
| `capacity-review-and-cost` | 係数の見直し、`fillfactor`・TOAST、コストのタグと組織ごとの配分 |
| `projections-s2-prep` | S2 の準備：射影の表（作成の runbook、同じトランザクションの書き込み、`stale`、計画の P4） |
| `ga-review` | GA の判定（[quality.md](quality.md) の 5 節の E12 の基準、法務の論点の確定）（法務：L1・L6・L7・L9・L10） |

### E13 利用者のコード（MVP の後）

設計：[extensibility.md](architecture/extensibility.md)、[ADR-0048](decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md)、[ADR-0049](decisions/0049-triggers-in-dml-order-and-platform-api.md)

| Story | 内容 |
| --- | --- |
| `code-engine-poc` | PoC：QuickJS-ng・StarlingMonkey の実体化の時間とメモリー、燃料と CPU 時間の換算の係数（着手の最初） |
| `code-runner` | `code-runner`（Wasmtime、決定的な設定、ソケット、健全性の検査）とタスク定義・IaC の検査 |
| `code-shell-host-api` | 殻（rquickjs）とホストの API（query・DML・addError・publish・callout・log） |
| `code-build-and-sdk` | TypeScript のビルド、バイトコードの保存、型の定義の配布（SDK） |
| `triggers-in-dml` | トリガーの位置（3b・7a・13、削除の前後）と再帰の規則（`DT-EXT-001`） |
| `code-limits` | `tx.code_*`・`code.*` の上限と計測、`tx.cpu_ms` への換算 |
| `code-run-context` | 実行の文脈（`user`・`system_with_sharing`）と承認・監査 |
| `code-debug-logs` | デバッグのログ（7 日）と Setup の画面 |
| `code-sandbox-pentest` | 外部のペンテスト（砂場の脱出、組織をまたぐ状態） |

### E14 パッケージ（MVP の後）

設計：[extensibility.md](architecture/extensibility.md) の 8 節、[ADR-0050](decisions/0050-packages-namespaces-and-code-isolation.md)、[sandboxes-and-deploy.md](architecture/sandboxes-and-deploy.md) の 5 節

| Story | 内容 |
| --- | --- |
| `namespaces-and-publisher-keys` | 名前空間の登録（予約語の表）、配布者の公開鍵、鍵の失効 |
| `package-manifest-and-signing` | `package.yaml` の追加の項目と JSON Schema、Ed25519 の署名、インストール先でのビルドのし直し |
| `package-install-and-upgrade` | インストール・バージョンの上げ（`locked` の部品、`DT-PKG-001`）・削除 |
| `namespace-limit-breakdown` | 名前空間ごとの上限の内訳（`tx_limit_peak_ratio{namespace}`、`<Brand>-Tx-Usage-Ns`、「上限に近い自動化」） |

### E15 以降（MVP の後）

着手するときに、intent から Epic を起票し、領域の文書と ADR を足す。範囲の目安だけを書く。

| Epic | 範囲の目安 | 前提 |
| --- | --- | --- |
| E15 CPQ | 商品・価格表・商談の商品（主従の従、積み上げ集計で `amount` を作る）、見積もりと明細、値引きの承認（承認のプロセス）、見積書の出力 | E6（積み上げ集計・承認）、E7 |
| E16 売上予測 | 予測の期間（会計年度）、`forecast_category` の積み上げ、ロール階層での集計（共有の閉包を使う）、上司の調整と履歴 | E4、E7、`opportunity_history` |
| E17 AI | リードのスコアリング、商談・活動の要約、エージェント。学習と推論に使うデータの範囲を、見る人の共有と FLS で絞る | 法務：L1・L2。E4 の判定を通す読みの API |
| E18 テリトリーとチーム | テリトリーの階層・割り当ての規則を、共有の理由（新しい `row_cause`）として足す。商談チーム・取引先チームの役割ごとの水準 | E4（決定表と参照の評価器の拡張） |
| E19 複数の通貨と言語 | 通貨の型の換算（日付の換算の表）、多言語のラベル | E3、E7 |

## エージェントに任せないこと

- **契約（問い合わせの言語の文法、REST API の形とエラー、変更のイベントの形、Webhook の署名、メタデータのパッケージの形式、決定表の列）の確定**：公開した後に変えるコストが最も高い。
- **`security:sensitive` の承認**：Dev のテックリードとセキュリティの担当の 2 人が行う（[ADR-0062](decisions/0062-security-sensitive-change-flow.md)）。
- **上限と割り当ての値の決定**：E12 の負荷試験の数字は出せるが、値の採否はプロダクトと Ops の判断。
- **参照の評価器の `over` の食い違いの時の、安全の設定をかける判断と組織への告知**：セキュリティの担当と Ops（[runbooks/incident-response.md](runbooks/incident-response.md)）。
- **法務の判断**（L1〜L11）。
- **エディションの分け方と価格**：E2 の着手前に PM が決める。

## 後回しにしたもの

MVP の後に検討する。着手するときに `intent.md` から起票する（[intent.md](intent.md) の「MVP の後の Epic で扱う」と Non-goals）。E13〜E19 に入れなかったもの。

- **独自の API（利用者のコードで REST の口を作る）とスケジュールで動く利用者のコード**：E13 の後（[extensibility.md](architecture/extensibility.md) の 14 節）。
- **共有も外す実行の文脈（本家の `without sharing` に相当）**：持たない。要望が多ければ、監査と承認を条件に別の ADR で検討する。
- **パッケージの公開の一覧（マーケットプレイス）、有料のライセンス、配布者の審査**：E14 の後（法務：L11）。
- **削除の前のフロー、入力規則を外すカスタムの権限（`$Permission`）、応答を待つ外向きの呼び出し**（[automation-flows.md](architecture/automation-flows.md) の 16 節）。
- **レポートの結合（複数のブロック）、サマリーの数式、バケット、履歴の傾向のレポート、分析用の写し（S2）**（[reports-and-dashboards.md](architecture/reports-and-dashboards.md) の 16 節）。
- **全員に同じ数字を見せるダッシュボードのためのスナップショットのフロー**（intent の「PM の確認済みの決定」）。
- **一括のメール、開封・リンクの計測**：法務の L4・L8 の後。
- **読みの操作（誰がどのレコードを見たか）の記録、項目の変更の履歴の長い保持**（[audit-and-field-history.md](architecture/audit-and-field-history.md) の 11 節）。
- **項目ごとの暗号化（本家の Shield に相当）、BYOK**（[security.md](architecture/security.md) の 14 節）。
- **代理のログイン、独自のドメイン**（[orgs-users-and-auth.md](architecture/orgs-users-and-auth.md) の 14 節）。
- **gRPC の購読、変更のイベントの 3 日を超える保持、共有で絞る変更のイベントの購読**（[events-and-integrations.md](architecture/events-and-integrations.md) の 13 節）。
- **Excel（xlsx）の取り込み、`insert` のジョブの冪等キー**（[bulk-and-import.md](architecture/bulk-and-import.md) の 13 節）。
- **本家のメタデータからの変換の道具**（intent の Non-goals。移行の Epic として扱う）。
- **Experience Cloud（ポータル）、Service Cloud、モバイルのネイティブアプリ、外部オブジェクト**（intent）。
- **S2 の構成**（主のクラスタの分割、Sandbox と試用の別のクラスタ、射影、専用の検索の索引）と **S3 のセル構成**（[infrastructure.md](architecture/infrastructure.md) の 5 節）。

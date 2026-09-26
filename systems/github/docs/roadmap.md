# Roadmap: GitHub

## 進め方の原則

- **最初に walking skeleton を通す。** E1 で、3 台の複製への push、clone、権限の最小の判定、最小の Web の表示を端から端まで貫いてから、機能を広げる。
- **壊れると致命的なものから検証の仕組みを作る。** 漏洩テスト・障害注入・Git の互換のマトリクスは、機能より先に用意する（[quality.md](quality.md) のリスク 1〜3）。
- **契約を先に固定する。** `.proto`（Git の層の RPC）、公開 API の OpenAPI、Webhook のペイロード、ワークフローの構文は、人間がレビューして確定し、エージェントは勝手に変えない。
- **本家に寄せ、名前は本家のものを使わない**（リポジトリ共通の [ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- **1 変更 1 PR を目安に、差分を小さくする。** Go（Git の層）と TypeScript（Web・API）の境界で変更を切る。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 Walking skeleton | 開発と運用の基盤、3 台のストレージのノードと状態を持たないフロントエンド、HTTPS・SSH の push と clone、最小の権限の判定と Web の表示 | 設計中 |
| E2 アカウントと権限 | ユーザー・Organization・チーム、5 つのロール、`can` と一括の判定、SSH の鍵、トークン、2FA | 未着手 |
| E3 Git の信頼性 | 3 相の合意、修復と再配置、保守、バックアップと復元、fork のネットワーク、LFS、パックのキャッシュと bundle-uri | 未着手 |
| E4 Pull Request とレビュー | 差分とマージの計算、レビュー、CODEOWNERS、ruleset、マージの方式、merge queue、自動マージ | 未着手 |
| E5 Issue と通知 | Issue・ラベル・マイルストーン・sub-issue、タイムライン、通知（Web とメール） | 未着手 |
| E6 検索 | コード検索（Zoekt）、Issue・PR・リポジトリの検索（OpenSearch）、権限の絞り込み | 未着手 |
| E7 API・Webhook・App | REST・GraphQL、App と OAuth アプリ、Webhook、レート制限、公式の SDK と CLI | 未着手 |
| E8 Actions | ワークフロー、スケジューリング、Firecracker の実行環境、シークレット、OIDC、ログ・成果物・キャッシュ | 未着手 |
| E9 本番運用 | 負荷試験、SLO、災害復旧、セキュリティの基盤、濫用対策、法務の手順、一般公開の準備 | 未着手 |
| E10 S2 への拡張 | Enterprise・`internal`・SAML SSO・SCIM、ストレージのノード数百台、大阪の非同期の複製、検索・Actions の分割 | 未着手（S2 の判断の基準を満たしたら。[infrastructure.md](architecture/infrastructure.md) の 8 節） |
| E11 S3 への拡張 | 複数のリージョン、ホームのリージョンと読み取りの複製 | 未着手（ADR-0034 は proposed） |

MVP は E1〜E9。

## Story

各 Story は、着手するときに開発リポジトリの `changes/YYMMDD-<slug>/` として起票する。ここは計画であり、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。

### E1 Walking skeleton

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | 開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md` を置く。本家の名前に代わる実際の名前（ブランド、ドメイン、接頭辞）を決める（ADR-0006） |
| `terraform-foundation` | アカウント（prod・staging・dev・actions-runners）、VPC、Terraform の状態、CI の OIDC（[infrastructure.md](architecture/infrastructure.md) の 1・2 節） |
| `github-project-setup` | ラベル・Issue Forms・Projects・同期のワークフロー（[project-management.md](../../../docs/project-management.md)） |
| `ci-pipeline` | PR の CI（Go・TypeScript・契約・追跡・本家の名前の検査）、merge queue（[delivery.md](architecture/delivery.md) の 2 節） |
| `feature-flags-appconfig` | release・ops・migration のフラグ |
| `telemetry-package` | Go と TypeScript の共通の属性の定義と計装（[observability.md](architecture/observability.md) の 2 節） |
| `rpc-contract-proto` | Git の層の RPC の `.proto` と、両言語のコードの生成（ADR-0001） |
| `gitd-minimal` | ストレージのノードのデーモン：`upload-pack`・`receive-pack` のストリーム、読み取りの RPC（ツリー・blob） |
| `storage-routing-tables` | `storage_nodes`・`repository_networks`・`network_replicas`・`repository_checksums` と、3 AZ への配置 |
| `git-frontend-https-ssh` | 状態を持たないフロントエンド：HTTPS（トークン）と SSH（公開鍵）、ルーティング（ADR-0004） |
| `push-three-replicas-minimal` | 3 つの複製への検疫と、合意の最小の実装（2 票で成功、DB の確定の後に応答） |
| `repository-create-and-clone` | リポジトリの作成、空の push、clone |
| `authz-minimal` | `can(actor, contents:read|write, repo)` の最小（持ち主と公開の種類）。Go からの `authz.Check` |
| `web-repo-browse-minimal` | SSR のリポジトリの最上位・ファイルの表示（ADR-0035） |
| `synthetic-canary-minimal` | clone・push の合成監視 |
| `fork-network-want-poc` | プロトコル v2 の広告していない `want` の PoC（[quality.md](quality.md) の LEAK-GIT-02） |
| `frontend-drain-poc` | NLB の登録解除と、EC2 起動タイプの停止猶予 15 分の PoC |

### E2 アカウントと権限

| Story | 内容 |
| --- | --- |
| `auth-better-auth` | パスワード（漏洩の検査）、パスキー、セッション（ADR-0019） |
| `two-factor-and-sudo` | TOTP・セキュリティキー・リカバリーコード、2FA の必須化、sudo モード |
| `owners-namespace-and-rename` | ユーザーと Organization の共通の名前空間、名前の変更と転送、名前の予約 |
| `organizations-and-memberships` | Organization、owner・member、招待、基本の権限 |
| `teams-and-closure` | チーム、入れ子、`team_closure`、秘密のチーム |
| `repository-roles-and-collaborators` | 5 つのロール、コラボレーター、外部のコラボレーター、招待（ADR-0018） |
| `authz-decision-tables` | `can` の判定の順序、決定表（5.3〜5.5）、404 と 403 の規則 |
| `authz-bulk-and-predicate` | `canMany`・`filterActorsCanRead`・`accessPredicate` と、`can` との一致の性質 |
| `permission-cache-epochs` | 世代の番号によるキャッシュと、剥奪の即時の反映 |
| `ssh-keys-and-deploy-keys` | 認証の鍵、デプロイキー、指紋の一意性 |
| `signing-keys-and-verification` | 署名の鍵（SSH・GPG）と、検証の記録の固定 |
| `personal-access-tokens` | 細粒度・クラシックの PAT、接頭辞＋チェックサム、期限の必須、取り消し 30 秒 |
| `org-token-policies` | クラシックの拒否、細粒度の承認、最長の期間 |
| `fork-permissions` | fork の規則（非公開の fork、上流のチームの権限、切り離し） |
| `user-and-org-blocks` | ブロック |
| `audit-log-core` | 管理の操作の監査ログ（ADR-0029） |

### E3 Git の信頼性

| Story | 内容 |
| --- | --- |
| `ref-update-consensus` | 3 相の手順、`version` の CAS、outbox の `refs.updated`（ADR-0006） |
| `ref-transaction-recovery` | `pending` の回収 |
| `consensus-fault-injection` | push の各段階の障害注入の基盤（PR の短縮版と夜間の完全版） |
| `replica-repair` | `out_of_sync` の修復、ノードの喪失の作り直し、優先度と帯域の上限 |
| `checksum-reconciliation` | 毎日のチェックサムの照合、週次の fsck |
| `node-drain-and-rebalance` | 退避、容量の平準化、AWS Health の予定のイベント（ADR-0031） |
| `storage-rolling-upgrade` | ストレージの列車（ADR-0033） |
| `git-maintenance-scheduler` | 幾何級数の repack、cruft、multi-pack index、commit-graph |
| `fork-network` | `network.git` と alternates、fork の作成、ネットワークへの移動（ADR-0007） |
| `network-split-on-visibility-change` | 公開の種類の変更でのネットワークの分割 |
| `fork-network-reachability-check` | 非公開のネットワークでの SHA の参照の到達可能性の検査の費用を測り、ADR を起票する |
| `push-checks` | push の検査（大きさ、fsck、予約した名前空間、LFS の pointer）と時間の予算 |
| `git-backup-osaka` | 大阪の S3 への増分・完全のバンドル（ADR-0032） |
| `daily-restore-check` | 毎日の 1,000 リポジトリの復元の確認 |
| `repository-delete-and-restore` | 論理削除、90 日の復元、消去、バックアップの例外（ADR-0030） |
| `lfs-batch-api` | LFS の batch API、presigned URL、verify、SSH の `git-lfs-authenticate`（ADR-0009） |
| `pack-objects-cache` | ノードのパックのキャッシュ（ADR-0008） |
| `bundle-uri-cdn` | 人気の公開リポジトリの bundle と CloudFront |
| `clone-rate-limits` | リポジトリごと・IP ごと・主体ごとの clone の制限 |
| `partial-and-shallow-clone` | filter の許可、promisor の fetch の上限 |
| `git-compat-matrix` | Git のクライアントの互換のマトリクス（PR と夜間） |
| `git-load-tests` | CloudFront 経由の数 GB の転送、`core.fsync`、`i8g` の性能、修復の速さ |
| `reftable-poc` | reftable の PoC |

### E4 Pull Request とレビュー

| Story | 内容 |
| --- | --- |
| `diff-and-merge-rpcs` | `FindMergeBase`・`CommitDiff`・`DiffStats`・`MergeTree`（ADR-0010） |
| `diff-cache` | SHA の組のキャッシュ（Valkey と S3） |
| `pull-request-create-and-refs` | PR の作成、`refs/pull/*`、fork をまたぐ PR |
| `pr-push-sync` | push の Event による PR の更新、タイムライン |
| `mergeability-worker` | マージ可能かの計算と間引き |
| `web-diff-view` | 差分の画面、仮想化、部分のハイドレーション |
| `reviews-and-comments` | レビューの状態、行・ファイルへのコメント、スレッドの解決 |
| `outdated-comments` | 古いコメントの付け直し |
| `suggested-changes` | 提案の適用とプラットフォームの署名 |
| `codeowners` | CODEOWNERS の解析とレビューの依頼 |
| `rulesets-core` | ruleset のモデル、評価関数、push とマージの両方での評価（ADR-0011） |
| `ruleset-decision-tables` | ruleset の決定表と fail closed の障害注入 |
| `required-status-checks` | 必須のチェック、送り手の指定、strict |
| `signed-commits-rule` | 署名の必須 |
| `merge-methods` | merge・squash・rebase、比較交換によるマージ |
| `update-branch` | 「ブランチの更新」 |
| `merge-queue` | 投機的なグループ、`<brand>-readonly-queue/`、`merge_group` の Event（ADR-0012） |
| `auto-merge` | 自動マージの予約と取り消し |
| `drafts` | 下書き |

### E5 Issue と通知

| Story | 内容 |
| --- | --- |
| `issues-core` | Issue の作成・編集・閉じる、共有の番号（ADR-0017） |
| `labels-and-milestones` | ラベル（既定のラベル）、マイルストーン |
| `assignees` | 担当者と、担当にできる人の規則 |
| `issue-timeline-and-references` | タイムライン、参照、閉じるキーワード、参照元の権限での絞り込み |
| `reactions` | リアクション |
| `issue-lock-and-pin` | ロック、ピン留め |
| `issue-types-and-sub-issues` | Issue の種類、sub-issue と進み具合 |
| `issue-transfer` | 移動とリダイレクト、非同期の上限の計測 |
| `issue-templates-and-forms` | `.<brand>/ISSUE_TEMPLATE/` のテンプレートとフォーム |
| `watch-and-thread-subscriptions` | watch、スレッドの購読、自動の watch |
| `notification-planner` | 受け手の決定、分割、`filterActorsCanRead` |
| `notification-inbox` | 受信箱、未読、既読、保持 |
| `notification-email` | メールの送信、ヘッダー、冪等性、上限とまとめ |
| `email-reply-ingest` | メールへの返信の取り込み |
| `email-bounce-handling` | バウンスと苦情 |

### E6 検索

| Story | 内容 |
| --- | --- |
| `code-search-zoekt-poc` | 1 万のリポジトリでの Zoekt の試作（差分のシャード、ID の集合の条件） |
| `code-indexer` | コードの索引の作成と増分（Go） |
| `code-search-router` | クエリの解析、権限の条件、ノードへの展開 |
| `search-permission-filter` | `accessPredicate` からの条件と、読み直し（ADR-0015） |
| `search-exclusions` | 権限の属性の変更の除外の表 |
| `issues-search-opensearch` | Issue・PR の索引と構文 |
| `repos-search` | リポジトリの検索 |
| `search-rate-limits` | 検索のレート制限 |

### E7 API・Webhook・App

| Story | 内容 |
| --- | --- |
| `public-api-foundation` | public-api のサービス、認証、エラー、ページング、`Idempotency-Key` |
| `rest-versioning` | `X-<Brand>-Api-Version` と版の変換（ADR-0021） |
| `openapi-contract` | OpenAPI の生成、`x-required-permissions`、破壊的変更の検査 |
| `graphql-foundation` | GraphQL のスキーマ、節点ごとの `can`、費用の計算 |
| `rest-resources-v1` | 初版の資源（3.4 節） |
| `rate-limits` | 主・副の制限と応答（11 節） |
| `github-apps` | App の登録、インストール、JWT、インストールのトークン（ADR-0020） |
| `app-manifest-flow` | マニフェストでの App の作成 |
| `app-user-tokens` | ユーザーのトークンとリフレッシュ |
| `oauth-apps` | OAuth アプリ、デバイスのフロー |
| `webhooks-delivery` | 振り分け、署名、送る直前の確認、隔離した egress（ADR-0022） |
| `webhook-retries-and-redelivery` | 自動の再試行と手動の再配信、回路遮断 |
| `checks-and-statuses` | check run・check suite・commit status |
| `token-leak-revocation` | 自社のトークンの走査と自動の失効、失効の API（security.md の 10 節） |
| `public-sdk-and-cli` | 公式の TypeScript の SDK と CLI（ADR-0006 で本家の SDK をそのまま使わないため） |

### E8 Actions

| Story | 内容 |
| --- | --- |
| `firecracker-host-poc` | metal のホスト、jailer、VM の起動の時間、1 ホストの VM の数（約 40 の検証） |
| `runner-fleet-manager` | ホストと待機中の VM の管理、ホストの設定の検査（ADR-0023） |
| `runner-agent-fork` | actions/runner の fork と、名前の置き換え |
| `broker-protocol` | long poll、割り当て、心拍、取り消し |
| `workflow-evaluator` | ワークフローの解釈、`on` の評価、再利用可能なワークフロー |
| `job-scheduler` | 依存、concurrency、持ち主ごとの上限と公平な順番（ADR-0024） |
| `secrets-service` | シークレットの保存と、ジョブの取得時の復号 |
| `fork-pr-policy` | fork の PR の方針と承認、`pull_request_target` の既定の遮断（ADR-0025） |
| `job-token-and-brand-token` | ジョブトークンと `<BRAND>_TOKEN` |
| `environments-and-reviews` | 環境の保護の規則 |
| `oidc-issuer` | OIDC の発行者（ADR-0026） |
| `logs-live-and-archive` | ログのライブ表示と確定 |
| `log-mask-double-check` | マスクの二重の確認の PoC と実装 |
| `artifacts-and-cache` | 成果物とキャッシュ（ADR-0027） |
| `self-hosted-runners` | セルフホストのランナーとグループ |
| `action-resolution-and-pinning` | アクションの解決、SHA の固定、ポリシー |
| `actions-abuse-detection` | 採掘の検知と停止 |
| `actions-usage-metering` | 分の記録 |
| `actions-isolation-drills` | 隔離の演習の自動化 |

### E9 本番運用

| Story | 内容 |
| --- | --- |
| `capacity-load-tests` | [capacity.md](architecture/capacity.md) のモデルの 1 倍・2 倍、clone の集中、ノード・AZ の喪失 |
| `slo-dashboards-burn-rate` | SLO のダッシュボードとバーンレートのアラート |
| `synthetic-permission-monitoring` | 権限の合成監視（5 分ごと） |
| `hot-repository-detection` | 上位のリポジトリの近似の計数とラベル |
| `dr-osaka-pilot-light` | 大阪の Global Database、切り替えのワークフロー、`i8g` の在庫の確認 |
| `dr-drills` | 大阪への切り替えの訓練と NFR-009 の計測 |
| `security-headers-csp` | CSP、Trusted Types、各種ヘッダー |
| `usercontent-domains-psl` | 利用者の内容のドメインと Public Suffix List の申請 |
| `image-proxy-and-render-iframe` | 画像のプロキシと描画の隔離の iframe |
| `waf-and-abuse-baseline` | WAF、新規アカウントの制限、通報 |
| `security-baseline-guardduty` | GuardDuty・Security Hub・AWS Config |
| `supply-chain-ci` | SBOM、来歴、Actions の SHA の固定 |
| `security-scanning` | SAST、依存の検査、DAST、Git の入力のファズ |
| `encryption-and-keys` | CMK の分け方、アプリ層の暗号化（ADR-0028） |
| `audit-log-archive` | 監査ログのアーカイブと改ざんの検知 |
| `data-deletion-jobs` | 消去のジョブ、アカウントの削除、名前の予約 |
| `bulk-token-revocation` | 一斉の失効と影響の範囲の特定 |
| `i18n-en-ja` | 英語・日本語の画面と訳の抜けの検査 |
| `a11y-baseline` | アクセシビリティの基盤 |
| `client-perf-budget-ci` | 性能の予算の CI と RUM |
| `legal-takedown-and-disclosure` | DMCA・発信者情報開示・制裁の手順 |
| `legal-review-before-launch` | DMCA の通知の公開、利用規約（リージョンの障害での push の喪失）の法務の確認 |
| `external-pentest` | 一般公開の前のペンテスト |
| `runbooks-completion` | [runbooks/README.md](runbooks/README.md) の 4 節の手順をそろえる |

### E10 S2 への拡張

| Story | 内容 |
| --- | --- |
| `enterprise-accounts` | Enterprise、`internal` のリポジトリ |
| `saml-sso` | Organization・Enterprise の SAML SSO と、資格情報の SSO の承認 |
| `scim-provisioning` | SCIM とチームの同期 |
| `org-email-domain-restriction` | 通知のメールのドメインの制限 |
| `enterprise-webhooks-and-api` | Enterprise の Webhook と API |
| `storage-scale-out` | ストレージのノード数百台、ルーティングの変更通知、`large` の群 |
| `osaka-async-replicas` | 活発なリポジトリの大阪の非同期の複製（RTO の短縮） |
| `notification-inbox-store` | 受信箱の保存先の見直し（DynamoDB を含む） |
| `code-search-blob-dedup` | blob の単位の重複の排除の判断 |
| `actions-scheduler-partitioning` | Scheduler の分割、入れ子の仮想化のあふれの受け皿、Docker の pull-through |

### E11 S3 への拡張

| Story | 内容 |
| --- | --- |
| `repository-home-region` | ホームのリージョンの割り当てと、読み取りの複製（ADR-0034） |
| `region-home-migration` | ネットワークの本拠の移動 |
| `global-identity-plane` | アカウントと資格情報のリージョンの外の面と、取り消しの全リージョンへの伝播 |
| `regional-actions-and-events` | リポジトリのリージョンでの Actions・Webhook の実行 |

各 Epic の品質面の重点と合否基準は、[quality.md](quality.md) の 5 節にある。

## エージェントに任せないこと

- **契約（`.proto`、公開 API、Webhook のペイロード、ワークフローの構文）の確定**：後から変えるコストがいちばん高い。
- **権限の判定関数と、複製の合意の最終確認**：テストが通っていても、ケースの漏れはエージェント自身では気づきにくい。Dev と QA のレビューを必須にする（[delivery.md](architecture/delivery.md) の 1 節）。
- **Git の本体の版の更新の判断**：ディスクの形式と互換に触れる。
- **本家の名前に代わる実際の名前の決定**（ADR-0006）：商標と登録の判断。
- **負荷試験・訓練の結果の解釈**：どこに投資するかはプロダクトの判断。

## 後回しにしたもの

MVP の後に、それぞれ着手するときに `intent.md` から起票する。

| 候補 | 内容 | メモ |
| --- | --- | --- |
| Packages | パッケージのレジストリ（コンテナ、npm など） | レジストリごとの互換が大きい。Actions の Docker の取得のキャッシュと合わせて考える |
| Pages | 静的サイトのホスティング | 利用者の内容のドメインの分離（ADR-0013）の上に作る |
| Advanced Security | push protection（最初の Story。他社の秘密情報の形式を含む）、秘密情報の走査の partner program、依存の脆弱性、コードの静的解析、リポジトリのセキュリティアドバイザリ | MVP では自社のトークンの走査と push の検査の枠だけを持つ（[security.md](architecture/security.md) の 10 節） |
| Discussions・Wiki・Projects | 共同作業の周辺。Issue のフィールド、利用者・コミットの検索もここで扱う | 通知・検索の権限の仕組みを流用する |
| Copilot に相当する AI の機能 | コードの補完・生成、PR の要約とレビューの補助、公開 API の上の MCP のサーバー | 権限は必ず依頼者の `can()` の範囲（[security.md](architecture/security.md) の 7 節）。MCP は公開 API の薄い層にする（[api-and-webhooks.md](architecture/api-and-webhooks.md) の 10 節） |
| 課金とプラン | Actions の分・LFS の容量の課金、プランごとの上限、`evaluate` の状態の扱い | MVP では記録だけを持つ |
| カスタムのリポジトリのロール、監査ログのアーカイブの延長 | 企業向けの機能 | E10 の後 |

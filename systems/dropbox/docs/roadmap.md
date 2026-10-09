# Roadmap: Dropbox

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E4 で、`packages/committer`・ジャーナル・ブロックの検証・`sync-core` の 3 つの木を端から端まで貫き、macOS の端末で保存したファイルが Windows の端末に届き、2 台の同時の編集が競合のコピーになるところまで作ってから、機能を広げる。決定的な同期のシミュレーター、分割と `name_key` の試験のベクトル、FORCE RLS、ジャーナルを通らない書き込みの禁止、GC の猶予は、E1〜E4 から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E2 の前：分割の母数と重複の率（`chunking-dedupe-poc`）、署名つき URL のチェックサムと一時のキーから正規のキーへの写し（`presigned-upload-poc`）。
  - E3 の前：1 名前空間の書き込みの上限（`namespace-write-throughput-poc`。1 秒 200 件）。
  - E5 の前：macOS の File Provider と Windows の Cloud Files API の振る舞いの差（`placeholder-platform-survey`）。
  - E9 の前：検索の基盤の大きさ（`search-sizing-poc`）。
- **規則は 1 つのコードに。** 計画と衝突は `sync-core` の `planner`、名前は `names`、分割は `chunker`、書き込みは `packages/committer`、権限は `packages/access` にだけ書く。
- **契約を先に固定する。** commit の形と条件、ジャーナルの行とカーソルの形、ブロックの番地と分割の規則（`chunker_version`）、`name_key`（`names_version`）、衝突の決定表、`can()` の決定表、公開 API の形、Webhook のヘッダーは、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L10）。下の表で「法務：L*」と書いた Story が当たる。
- **実の OS で早く確かめる。** CI の macOS と Windows の機械を E1 で用意し、ファイルシステムの端の場合の場面を E3 の終わりから流す。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（Rust と TypeScript、macOS と Windows の実機、シミュレーターの枠）、Aurora と RLS、`packages/committer` とジャーナルの骨格、S3 のバケット、フラグ、可観測性、監査ログ、大阪の骨格 | 設計中 |
| E2 ブロックの保存 | 分割（`chunker`）、ブロックの索引、署名つき URL、検証と写し、ダウンロードの組み立て、大きなファイル、GC と照合 | 未着手（前に分割と署名つき URL の PoC） |
| E3 メタデータとジャーナル | 名前空間、ノードとリビジョン、commit と条件、`name_key`、カーソルと `list/continue`、Notify | 未着手（前に書き込みの上限の PoC。ジャーナルの保持の確定は法務：L6） |
| E4 同期エンジン | `sync-core` の 3 つの木と計画、衝突の決定表、意図の記録、決定的な同期のシミュレーター | 未着手 |
| E5 デスクトップのクライアント | 監視、移動の検出、macOS の File Provider、Windows の Cloud Files API、選択型の同期、UI、配布と自動の更新 | 未着手（前にプレースホルダーの調査。画面の寄せ方は法務：L10） |
| E6 共有 | 共有フォルダー、チームのスペースとチームのフォルダー、`can()`、チームの外への共有の方針、共有リンク | 未着手（共有リンクの公開は法務：L1・L2・L5） |
| E7 Web の画面 | 一覧、アップロード（WASM の分割）、ダウンロード、共有、復元、IME | 未着手（画面の寄せ方は法務：L10、分析の計測は法務：L1） |
| E8 バージョンと復元 | バージョン履歴、削除したファイルの復元、巻き戻し、一斉の変更の検知、保持の期間 | 未着手（保持の約束は法務：L6・L8） |
| E9 プレビューと検索 | 隔離した変換、サムネイル、プレビュー、名前と本文の索引、日本語の検索 | 未着手（前に検索の PoC。中身を読む処理は法務：L1） |
| E10 モバイルとカメラのアップロード | iOS・Android のアプリ、一覧とプレビュー、オフラインの保存、カメラのアップロード、通知 | 未着手（モバイルの通知は法務：L4） |
| E11 公開 API と Webhook | REST API、OAuth 2.0、レート制限、カーソルと long-poll、Webhook | 未着手 |
| E12 アカウント・チーム・管理・監査 | 個人のアカウントとプラン、チーム、SSO・SCIM、管理の役割、端末の管理、監査ログ | 未着手（管理者のアクセスは法務：L7、監査ログの保持は法務：L3） |
| E13 本番の準備と GA の判定 | 負荷試験、DR の訓練、ブロックの戻しの訓練、復元の訓練、外部のペンテスト、GA の判定 | 未着手（GA の判定は法務：L2・L3・L4・L5・L6・L9） |
| E14 LAN 同期（MVP の後） | 同じネットワークの端末の間のブロックの直接の送受信、端末どうしの認証、チームの方針 | 未着手（MVP の後） |
| E15 OCR の検索（MVP の後） | 画像と走査した PDF の日本語の OCR、索引 | 未着手（MVP の後。法務：L1） |
| E16 鍵と暗号化の拡張（MVP の後） | 顧客の鍵（BYOK）、エンドツーエンドの暗号化のフォルダー | 未着手（MVP の後） |
| E17 Linux のクライアントと CLI（MVP の後） | Linux のデスクトップ、ヘッドレスの CLI | 未着手（MVP の後） |
| E18 他社からの移行（MVP の後） | 本家・他社のストレージからの一括の移行 | 未着手（MVP の後。他社の規約の確認が要る） |
| E19 海外のリージョン（MVP の後） | テナントをリージョンに固定する、S3 のセル | 未着手（MVP の後。法務：L5） |

E1〜E13 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。領域の文書（[architecture/README.md](architecture/README.md) の 7 節）の「Story の候補」を、統合の工程（2026-10-09）でここに反映した。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Dropbox の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`sync-core` の `planner`・`names`・`chunker`、`packages/committer`・`access`・`blocks` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント、SCP、VPC、egress の専用の経路（Webhook の送信）、変換のタスクのネットワークのない区画。データの所在の約束は法務：L5 |
| `edge-and-waf` | CloudFront、WAF、ドメイン（`www`・`api`・`notify.<brand>.<domain>`、`content.<brand>usercontent.<domain>`）。国外のエッジの扱いは法務：L5 |
| `ecs-services-skeleton` | API・Notify・Link・Auth・Relay・Worker のサービスとロール |
| `terraform-root-modules` | ルートモジュールとポリシーの検査 |
| `aurora-rls-baseline` | テナントと名前空間の RLS、`SET LOCAL app.ns_ids`、RLS の検査、RLS の外の表とテナントをまたぐ経路の許可リスト（ADR-0004） |
| `committer-and-journal-skeleton` | `packages/committer`、名前空間の `ns_seq`、`ns_journal`、outbox、ジャーナルを通らない書き込みの DB の権限での禁止（ADR-0005） |
| `s3-buckets-baseline` | `incoming`・`blocks`・`blocklists`・`previews`・`audit` のバケット、SSE-KMS、バージョニング、ライフサイクル、大阪への CRR、署名の役割の IAM（ADR-0007） |
| `ci-pipeline-baseline` | PR の関門、Rust と TypeScript、macOS と Windows の実機の機械、シミュレーターの枠、試験のベクトルの比べ、テストの緩和の検出、本番の依存の禁止の一覧（ADR-0001） |
| `flags-appconfig` | `release.*`・`ops.*` のフラグ |
| `otel-baseline` | ADOT、AMP、X-Ray、ログの形、名前・パスをログに出さない規則と走査 |
| `audit-log-table-and-archive` | 監査ログの表と、S3 の Object Lock への写し。保持は法務：L3・L6 |
| `osaka-warm-standby` | 大阪の骨格、Aurora Global Database、CRR の遅れの監視 |
| `ci-real-os-runners` | 実機の macOS・Windows の CI の機械と使い捨てのボリューム（delivery の 2.3 節） |
| `schema-migration-gates` | スキーマの変更の段と CI の比較（ADR-0053） |
| `kms-keys-and-secrets` | KMS の鍵、鍵の方針、秘密の回し方（ADR-0044） |
| `operator-access-baseline` | 運用者の JIT、人のロールの中身の拒否、名前を読めないビュー（security の 9 節） |

### E2 ブロックの保存

| Story | 内容 |
| --- | --- |
| `chunking-dedupe-poc` | PoC：分割の母数（1・4・16 MiB）での重複の率、ブロックの数、分割の速さ（ネイティブと WASM） |
| `presigned-upload-poc` | PoC：署名つき URL でのチェックサムの強制、一時のキーから正規のキーへの写しの速さと費用 |
| `chunker` | `sync-core` の分割とハッシュ、`chunker_version` 1、試験のベクトル（ADR-0002） |
| `block-index-and-verifier` | ブロックの索引、`block-verifier`（チェックサムの確かめ、写し、`live`）、署名つき URL の発行（ADR-0007） |
| `commit-need-blocks` | commit の答え（送らなくてよい・写す・送れ）と、読める名前空間の参照の照会（ADR-0003） |
| `ns-block-refs` | 名前空間ごとのブロックの参照の増減 |
| `block-download` | CloudFront の署名つき URL、クライアントの組み立て、ローカルのブロックの索引 |
| `large-file-upload-session` | 大きなファイルのアップロードのセッション、ブロックの一覧の S3 への置き方、再開 |
| `block-gc` | 参照 0 から 7 日の猶予、行のロックでの commit との並行、S3 のバージョニング |
| `block-scrubber-and-audit` | チェックサムの照合、参照の監査、S3 Inventory との突き合わせ |
| `dedupe-two-worlds-tests` | 重複排除の 2 つの世界の比べ（quality.md の 2.2.1 節 G） |
| `upload-admission` | アップロードの受け入れのトークンバケットと優先度（ADR-0051） |
| `upload-sli` | アップロードの SLI（observability の 3.2 節） |
| `chunker-version-negotiation` | `GET /v1/config` と `chunker_version` の切り替え（ADR-0053） |

### E3 メタデータとジャーナル

| Story | 内容 |
| --- | --- |
| `namespace-write-throughput-poc` | PoC：1 名前空間 1 秒 200 件の commit、ロックの待ちの p99 |
| `names-and-name-key` | `name_key`（Rust と TypeScript）、名前の受け付け、`names_version`、試験のベクトル（ADR-0008） |
| `nodes-and-revisions` | ノード・リビジョンの表、`node_ver`、一意の索引 |
| `commit-conditional-ops` | commit の操作（`create`・`update`・`move`・`delete`・`undelete`）と条件（`base_rev`・`base_node_ver`・ファイルの削除の `base_rev`・フォルダーの削除の `base_seq`・作成）、2 段の置き場所、循環の検査（ADR-0006、ADR-0021） |
| `list-folder-and-cursor` | 木の一覧（ページつき）、カーソル、`list/continue`、取り直し（ADR-0005） |
| `mount-unmount` | 名前空間を載せる・外す、番号 0 からの読み出し |
| `notify-gateway` | Notify の WebSocket、Valkey の pub/sub、合図 |
| `cross-namespace-move` | 名前空間をまたぐ移動とコピー（バッチの非同期の操作） |
| `journal-retention` | ジャーナルの分割と保持、`floor_seq`。保持は法務：L6 |
| `journal-diff-prop-tests` | 差分と全件の一致の性質（quality.md の 2.2.1 節 E） |
| `journal-tail-cache` | 購読の多い名前空間のジャーナルの末尾のキャッシュ（ADR-0051） |
| `path-resolution-cache` | パスの解決のキャッシュ（metadata-and-journal の 7.3 節） |
| `propagation-sli` | 受け渡しの遅れの SLI（ADR-0050） |

### E4 同期エンジン

| Story | 内容 |
| --- | --- |
| `sync-core-skeleton` | `sync-core` の制御のループ、I/O・時計・乱数の差し替え、ローカルの状態の DB |
| `three-trees-model` | Remote・Local・Synced の木、ノードの結び付け、仮の ID |
| `planner-and-conflict-table` | 計画と衝突の決定表（ADR-0006） |
| `intent-log-and-recovery` | 意図の記録とクラッシュからの再開 |
| `rescan-and-overflow` | 走査し直し、監視の溢れ、同期のフォルダーが見えないときの停止 |
| `mass-delete-guard` | 消しすぎの止めと利用者の確かめ |
| `conflicted-copy-naming` | 競合のコピーの名前（日本語・英語）。文言は法務：L10 |
| `sync-simulator` | 決定的な同期のシミュレーター、サーバーの模型、契約の試験（quality.md の 2.2.1 節 A） |
| `planner-randomized-tests` | 計画の層の乱択の試験と縮め |
| `transfer-scheduler` | 並行・優先度・帯域・再試行（sync-engine の 8 節） |

### E5 デスクトップのクライアント

| Story | 内容 |
| --- | --- |
| `placeholder-platform-survey` | 調査：File Provider と Cloud Files API の取り出し・追い出し・名前の制限・OS のバージョンの差 |
| `fs-observer-macos` | File Provider の拡張の呼び出しから Local を直す、項目の ID での移動の検出（FSEvents は使わない。ADR-0015） |
| `fs-watcher-windows` | ReadDirectoryChangesW、File ID、移動の検出 |
| `macos-file-provider` | File Provider の拡張（Swift）と `sync-core` の結び付け、オンラインのみのファイル |
| `windows-cloud-files` | Cloud Files API の同期のルート、プレースホルダー、取り出し |
| `name-mapping-and-unsyncable` | 手元の名前とサーバーの名前の対応、同期できない名前の表示（ADR-0008） |
| `selective-sync` | 選択型の同期 |
| `desktop-ui` | 状態の表示、設定、通知、帯域の制限、一時停止（Tauri） |
| `device-registration` | 端末の登録、遠隔の切り離し |
| `fs-edge-case-suite` | ファイルシステムの端の場合の場面と実機の CI（quality.md の 2.2.1 節 B） |
| `client-resource-bench` | 100 万ファイルの端末の計測（quality.md の 2.2.1 節 J） |
| `desktop-distribution` | 署名・公証、段階の配布、自動の更新 |
| `desktop-host-process` | ホストのプロセスの形、起動と停止（ADR-0013） |
| `save-pattern-detection` | アプリの保存のしかたの扱い（file-system-integration の 5 節） |
| `device-unlink-and-wipe` | 端末の側の切り離しと消去（ADR-0014）。消去は法務：L7 |
| `client-network-proxy` | プロキシ、TLS、ネットワークの変化 |
| `client-auto-update` | 自動の更新の受け取り |
| `client-telemetry` | 端末の匿名の計測（ADR-0050）。範囲は法務：L1 |
| `release-account-and-distribution` | `release` のアカウント、`dl.<brand>.<domain>`、署名の鍵の置き場所 |

### E6 共有

| Story | 内容 |
| --- | --- |
| `access-can` | `packages/access` の `can()` と決定表（ADR-0004） |
| `shared-folders` | 共有フォルダーの招待・参加・退出・役割、テナントをまたぐメンバー |
| `team-space-and-folders` | チームのスペース、チームのフォルダー、一部のメンバーだけのフォルダー |
| `external-sharing-policy` | チームの外への共有の方針と、変更の反映 |
| `quota-accounting` | 論理の容量の集計（共有フォルダーの数え方は namespaces-and-sharing の領域） |
| `shared-links` | 共有リンク（閲覧）、パスワード、期限、ダウンロードの禁止、無効化、アクセスの記録。公開は法務：L1・L2・L5 |
| `link-abuse-report` | 違法なコンテンツの通報の入口と送信防止の手順。法務：L2 |
| `leak-path-tests` | 漏れの経路の表の結合テスト（quality.md の 2.2.1 節 F） |
| `link-abuse-controls` | 共有リンクのレート制限・帯域・作成の上限（ADR-0028） |
| `ownership-transfer` | 持ち主の移し替え（ADR-0026） |
| `unmount-and-role-change-client` | 外された・閲覧に下がったときの手元の扱い（ADR-0011） |
| `usercontent-domain-headers` | 利用者の中身のドメインとヘッダー（security の 4 節） |
| `response-audit` | 応答の監査（observability の 5 節） |

### E7 Web の画面

| Story | 内容 |
| --- | --- |
| `web-browse` | 一覧、並べ替え、パンくず、選択 |
| `web-upload-wasm` | フォルダーごとのアップロード、`sync-core` の分割の WASM、再開 |
| `web-download` | ダウンロード、フォルダーの ZIP（`export-builder` で組み立てる。ADR-0054。10,000 ファイル・20 GiB まで） |
| `web-share-ui` | 共有フォルダーと共有リンクの画面 |
| `web-restore-ui` | バージョン履歴、削除したファイル、巻き戻しの画面 |
| `web-ime` | 名前の変更・検索の入力の IME |

### E8 バージョンと復元

| Story | 内容 |
| --- | --- |
| `revision-retention` | リビジョンの保持の期間とプラン、期限切れでの参照の減少。約束は法務：L6・L8 |
| `deleted-restore` | 削除したファイル・フォルダーの復元 |
| `namespace-rewind` | 名前空間の巻き戻し（時点の選び方、バッチの実行、さらに巻き戻せること） |
| `mass-change-detector` | 一斉の変更の検知と通知 |
| `restore-prop-tests` | 巻き戻しの性質（quality.md の 2.2.1 節 H） |
| `node-versions-history` | `node_versions` を `packages/committer` で書く（ADR-0029） |
| `version-history-restore` | ファイルのバージョンの一覧と復元 |

### E9 プレビューと検索

| Story | 内容 |
| --- | --- |
| `search-sizing-poc` | PoC：25 億ノードの名前の索引の大きさ、日本語の解析、更新の遅れ |
| `preview-sandbox` | ネットワークのない隔離したタスク、上限、ファジング（quality.md の 2.2.1 節 I）。中身を読む処理は法務：L1 |
| `thumbnails` | 画像・動画の最初の画面のサムネイル、キャッシュ |
| `document-previews` | PDF・Office の文書・テキストのプレビュー |
| `search-names` | 名前の索引と検索、`can()` での確かめ直し |
| `search-fulltext-team` | チームのプランの本文の索引。法務：L1 |
| `text-extraction` | 本文の抽出（隔離の変換）。法務：L1 |
| `search-reindex` | 検索の索引の作り直し |

### E10 モバイルとカメラのアップロード

| Story | 内容 |
| --- | --- |
| `mobile-core-bindings` | `sync-core` の UniFFI の結び付け（iOS・Android） |
| `mobile-browse-preview` | 一覧とプレビュー |
| `mobile-offline-files` | 指定したファイルのオフラインの保存 |
| `camera-upload` | 写真のライブラリの取り込み、重ねない、バックグラウンドの制約、回線の条件 |
| `mobile-notifications` | 共有・コメントなどの通知。法務：L4 |
| `mobile-background-upload-poc` | PoC：背景の送信の OS の振る舞いと、署名つき URL（15 分）が切れる頻度 |
| `mobile-release-pipeline` | モバイルのリリースの流れ（delivery の 5.5 節） |

### E11 公開 API と Webhook

| Story | 内容 |
| --- | --- |
| `public-api-v1` | REST API の形、エラー、ページング、条件つきの書き込み |
| `oauth-apps-and-scopes` | OAuth 2.0 のアプリ、スコープ、チームのアプリの許可 |
| `rate-limits` | レート制限 |
| `api-longpoll` | long-poll |
| `webhooks` | Webhook の登録の確かめ、`<Brand>-Signature`、再試行、停止 |
| `api-compat-replay` | 2 つ前までのクライアントの呼び出しの再生（ADR-0053） |
| `sdk-typescript-python` | 組み立てと分割を持つ公式の SDK |
| `files-export` | `files/export`・フォルダーの ZIP の組み立て（`export-builder`、ADR-0054） |

### E12 アカウント・チーム・管理・監査

| Story | 内容 |
| --- | --- |
| `personal-accounts-and-plans` | 個人のアカウント、プランと容量 |
| `teams-and-members` | チーム、メンバー、グループ、個人のアカウントからチームへの移り |
| `sso-saml-oidc` | SAML・OIDC の SSO |
| `scim-provisioning` | SCIM のメンバーとグループの同期 |
| `admin-roles` | 管理の役割、端末の管理 |
| `admin-member-access` | 管理者のメンバーのフォルダーへのアクセス。法務：L7 |
| `audit-log-ui-export` | 監査ログの画面と書き出し |
| `data-lifecycle` | 解約・アカウントの削除の後のデータとブロックの消去。保持は法務：L6 |
| `session-revocation` | 取り消しの伝わり方と Notify の切断（ADR-0041） |
| `step-up-auth` | 危ない操作の再認証 |
| `remote-unlink-and-wipe` | 切り離しと消去の状態の機械（ADR-0043） |
| `activity-events-pipeline` | ファイルの活動の事象（Firehose、Athena、欠けの照合） |
| `content-scanner-framework` | 中身の検査の枠、`content_scan_policy`、`scan_state`、`verified_sha256`（ADR-0046）。法務：L1・L2 |

### E13 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `load-tests` | commit、合図、ブロックの送受信、`list/continue`、プレビュー、索引 |
| `dr-failover-drill` | 大阪への切り替えの訓練、中身の待ちと端末からの送り直し、`epoch` の更新 |
| `block-restore-drill` | GC の誤りからの、S3 の古いバージョンでの戻しの訓練 |
| `rewind-drill` | 100 万ファイルの名前空間の巻き戻しの訓練（NFR-009） |
| `pentest-external` | 外部のペンテスト（共有リンク、プレビュー、API、クライアント） |
| `slo-dashboards-alerts` | SLO とアラート（[runbooks/README.md](runbooks/README.md)） |
| `runbooks-e13` | 個別の手順の作成と確認 |
| `ga-readiness` | GA の判定。法務：L2・L3・L4・L5・L6・L9 |
| `device-swarm` | 頭のない端末の群れ（capacity の 8 節） |
| `dr-failover-workflow` | 切り替えのワークフロー、`epoch`、`dr-content-check`（ADR-0048） |
| `dr-reset-slotting` | DR の後の取り直しの待ちの割り当て（ADR-0051） |
| `synthetic-devices` | 合成監視の端末（observability の 7 節） |
| `cost-baseline` | 層の割合と単価を請求の実績で置き換える |

### E15 OCR の検索（MVP の後）

| Story | 内容 |
| --- | --- |
| `ocr-evaluation` | OCR の誤りの率と費用の計測（ADR-0035） |

## エージェントに任せないこと

- **契約（commit の形と条件、ジャーナルとカーソルの形、`chunker_version`、`names_version`、衝突の決定表、`can()` の決定表、公開 API の形、Webhook のヘッダー）の確定**：クライアントと外部に配った後に変えるコストが最も高い。
- **シミュレーターの性質と、ファイルシステムの端の場合の期待する結果の変更**：QA が判断する。
- **GC の猶予・保持の期間の短縮、ブロックの消去の手動の実行**：Dev のテックリードと Ops が判断する。
- **データの直接の書き換え（ノード・リビジョン・ブロックの索引）**：Dev のテックリードと Ops が判断し、`packages/committer` を通す。
- **大阪への切り替えの判断、`epoch` の更新**：IC と Ops の責任者。
- **違法なコンテンツの通報への対応、開示の請求への応答**：法務と Ops。
- **法務の判断**（L1〜L10）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、上限・母数・退路の採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E14〜E19 に入れなかったもの。着手するときに `intent.md` から起票する。

- **電子署名、文書の共同編集、ファイルの依頼（他人からの受け取り）**（intent.md）。
- **編集の共有リンク、フォルダーの共有リンクの中への書き込み**（[architecture/README.md](architecture/README.md) の 6 節）。
- **小さなブロックのパック**（[ADR-0020](decisions/0020-small-block-packing-for-s2.md)。S2 の前の `small-block-pack-poc` で測って決める）。
- **S2 の構成**（名前空間の持ち主のテナントでのシャード、検索の分け方）と **S3 のセル構成**（infrastructure の領域）。
- **リーガルホールドと eDiscovery**（法務の L6 の結論で前に出しうる）。

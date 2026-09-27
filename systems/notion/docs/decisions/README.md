# Decisions: Notion

Notion の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 基盤は他の題材の決定を引き継ぐ | accepted |
| [0002](0002-everything-is-a-block.md) | すべてをブロックとして持つ | accepted |
| [0003](0003-workspace-sharding.md) | ワークスペースで RLS と論理シャードを決める | accepted |
| [0004](0004-inherited-page-permissions.md) | 権限はページの木を継承し、1 つの判定関数で決める | accepted |
| [0005](0005-transactions-as-unit-of-change.md) | 変更は操作をまとめたトランザクションで送り、サーバーで順序を確定する | accepted |
| [0006](0006-rich-text-as-normalized-spans.md) | リッチテキストを、正規化したスパンの配列で持つ | accepted |
| [0007](0007-block-editor-with-per-block-prosemirror.md) | ブロックの層は自前で作り、ブロックの中のテキストの編集に ProseMirror を使う | accepted |
| [0008](0008-sqlite-wasm-opfs-local-store.md) | ローカルの保存に SQLite（WASM）と OPFS を使い、書くタブを 1 つに限る | accepted |
| [0009](0009-electron-desktop-shell.md) | デスクトップアプリを Electron で包む | accepted |
| [0010](0010-text-crdt-with-server-ordered-structure.md) | テキストはブロックごとの CRDT（Fugue＋Peritext）で統合し、構造とプロパティはサーバーの順序で決める | accepted |
| [0011](0011-structural-and-property-conflict-rules.md) | 構造とプロパティの衝突は、サーバーの順序と決まった規則で解き、負けた変更を記録して本人に見せる | accepted |
| [0012](0012-child-order-by-sibling-anchors.md) | 子の並びは前後の兄弟をアンカーにした操作で表し、分数インデックスは使わない | accepted |
| [0013](0013-offline-availability-policy.md) | オフラインで使うページを理由ごとに記録して決め、Web とデスクトップで SQLite に保存する | accepted |
| [0014](0014-database-query-index.md) | データベースの問い合わせは、シャードの中の型付きの索引の表で行う | accepted |
| [0015](0015-formula-evaluation-model.md) | 数式は共通の評価器で解釈し、サーバーの値を正として実体化する | accepted |
| [0016](0016-relation-edges-as-single-source.md) | リレーションは 1 本の辺を正本にして、両側の値を導く | accepted |
| [0017](0017-rollups-over-readable-rows-only.md) | ロールアップとリレーションをたどる数式は、見る人が読める行だけで計算する | accepted |
| [0018](0018-permission-levels-and-inheritance.md) | 権限の水準を本家に合わせ、ACL は設定したページで継承を置き換える | accepted |
| [0019](0019-workspace-acl-version-cache.md) | 実効権限は、ワークスペースの権限の版（acl_version）をキーにキャッシュし、権限の変更と同じトランザクションで版を上げる | accepted |
| [0020](0020-published-pages-isolation.md) | 公開ページは別の登録可能ドメインで、専用の描画サービスから配り、既定で検索エンジンに載せない | accepted |
| [0021](0021-accounts-members-guests-and-teamspaces.md) | アカウントとメンバーを分け、ゲスト・連携もメンバーの行にし、チームスペースを最上位の暗黙の ACL にする | accepted |
| [0022](0022-trash-history-and-deletion-retention.md) | ゴミ箱は 30 日、完全に削除した後も 30 日戻せ、ページの履歴はプランの日数で消す。バックアップの期限を削除の最終的な期限にする | accepted |
| [0023](0023-search-engine-and-permission-filtering.md) | 検索は S1 から OpenSearch でページ単位に索引し、権限キーと読み直しの二重で権限を効かせる | accepted |
| [0024](0024-integration-access-model.md) | 公開 API は本家の形と日付の版に寄せ、連携は明示的に共有されたページだけを読む | accepted |
| [0025](0025-webhook-delivery.md) | Webhook は中身を含まない署名付きのイベントを、配送の時点の権限で、隔離した egress から送る | accepted |
| [0026](0026-remote-mcp-server.md) | AI エージェント向けに、利用者の委任で動くリモートの MCP サーバーを提供する | accepted |
| [0027](0027-shard-router.md) | 論理シャードを PostgreSQL のスキーマで持ち、アプリの中のルーターで物理クラスタへ振り分ける | accepted |
| [0028](0028-zero-downtime-resharding.md) | 物理クラスタの分割は、論理レプリケーションと影の読み取りで、無停止で行う | accepted |
| [0029](0029-disaster-recovery.md) | 災害復旧は、物理クラスタごとの Aurora Global Database と大阪のパイロットライトで行う | accepted |
| [0030](0030-cdc-data-lake.md) | S2 で、変更データの取り込み（CDC）によるデータレイクを S3 に作る | proposed |
| [0031](0031-migration-rollout-by-shard-groups.md) | スキーマの変更は、論理シャードの群れの順に expand / contract で当てる | accepted |
| [0032](0032-desktop-uses-wasm-sqlite-in-s1.md) | S1 のデスクトップも Web と同じ WASM の SQLite（OPFS）を使い、ネイティブの SQLite は S2 の候補にする | accepted |
| [0033](0033-transfer-private-pages-of-deactivated-members.md) | 無効化したメンバーのプライベートのページを、所有者が監査付きで別のメンバーへ移せるようにする（E10） | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

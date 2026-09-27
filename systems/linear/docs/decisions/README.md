# Decisions: Linear

Linear の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤の上に、同期エンジンを自前で作る。クライアントは TypeScript の SPA と Electron、手元の保存は IndexedDB | accepted |
| [0002](0002-sync-model.md) | ワークスペースごとに、サーバーが全順序を決める変更のログと単調な `sync_id` を持つ。クライアントは楽観的に当て、差分の上に載せ直す。競合はフィールドの型ごとの規則で解く | accepted |
| [0003](0003-bootstrap-and-partial-sync.md) | 小さなワークスペースは全体のブートストラップ、大きなワークスペースは部分のブートストラップと遅延の読み込み。差分は同期グループで絞って配る | accepted |
| [0004](0004-tenancy-and-permissions.md) | ワークスペースをテナントにし、FORCE RLS で分ける。チームを権限の範囲にし、非公開のチームは同期グループで差分から外す | accepted |
| [0005](0005-client-persistence-and-offline.md) | ワークスペースごとの IndexedDB に、モデルと、送る前に保存する outbox を持つ。スキーマの版ごとに移行し、outbox は移行で消さない | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

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
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

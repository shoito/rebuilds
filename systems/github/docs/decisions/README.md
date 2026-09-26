# Decisions: GitHub

GitHub の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 基盤は他の題材を引き継ぎ、Git の層だけ Go と Git の本体で作る | accepted |
| [0002](0002-repository-permission-model.md) | 権限はリポジトリの単位の判定関数に集約し、テナントの RLS は使わない | accepted |
| [0003](0003-replicated-git-storage.md) | リポジトリは、アプリケーションの層で 3 つのノードに複製する | accepted |
| [0004](0004-stateless-git-frontend.md) | Git の要求は、状態を持たないフロントエンドで受けて、複製へ振り分ける | accepted |
| [0005](0005-git-as-source-of-truth.md) | リポジトリの中身の正本は Git、メタデータの正本は DB にする | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

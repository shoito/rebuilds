# Decisions（リポジトリ共通）

このリポジトリ全体に関わる決定。題材ごとの決定は、各題材の `docs/decisions/` にある（例：[Slack](../../systems/slack/docs/decisions/README.md)）。書き方は [process.md](../process.md) の「決定の記録（ADR）」とテンプレート [adr.md](../templates/adr.md) に従う。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-adopt-ai-native-lifecycle.md) | AI-Native SDLC を骨格に、正本 spec と変更差分を分けて管理する | proposed |
| [0002](0002-trunk-based-development.md) | トランクベース開発を採る | accepted |
| [0003](0003-github-projects-for-planning.md) | 計画と進み具合は GitHub Projects で持ち、仕様の正本はリポジトリに置く | accepted |
| [0004](0004-agent-prs-via-github-app.md) | エージェントの PR は GitHub App から作り、人が承認する | accepted |
| [0005](0005-design-record-repository.md) | rebuilds を設計の記録に限定し、実装は題材ごとの開発リポジトリで行う | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。当面は ADR を追加・更新したら生成し直す。生成と差分の検査は、rebuilds の CI（これから用意する）で行う。開発リポジトリの `ci-pipeline` の対象ではない（手で編集する一覧は衝突しやすいため。[process.md](../process.md) の「衝突の防止」）。

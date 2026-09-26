# Decisions（リポジトリ共通）

このリポジトリ全体に関わる決定。題材ごとの決定は、各題材の `docs/decisions/` にある（例：[Slack](../../systems/slack/docs/decisions/README.md)）。書き方は [process.md](../process.md) の「決定の記録（ADR）」とテンプレート [adr.md](../templates/adr.md) に従う。

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-adopt-ai-native-lifecycle.md) | AI-Native SDLC を骨格に、正本 spec と変更差分を分けて管理する | proposed |
| [0002](0002-trunk-based-development.md) | トランクベース開発を採る | accepted |

この一覧は、各 ADR の frontmatter と見出しから生成したもの。当面は ADR を追加・更新したら生成し直す。E1 の `ci-pipeline` で、CI が生成と差分の検査を行うようにする（手で編集する一覧は衝突しやすいため。[process.md](../process.md) の「衝突の防止」）。

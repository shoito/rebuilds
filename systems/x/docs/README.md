# X の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は X の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと、法務の確認待ち | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、領域の計画 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、見える範囲の漏れの経路、fan-out とカウンターの性質、テスト計画 | QA |
| [roadmap.md](roadmap.md) | Epic と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLO、アラートと手順、リリース、訓練 | Ops |

領域ごとの設計は [architecture/](architecture/README.md) の 7 節に、表と置き場所の索引は [architecture/data-model.md](architecture/data-model.md) にある。

これから作る文書：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `runbooks/<slug>.md`（残り） | 個別の手順（[runbooks/](runbooks/README.md) の 4 節の「計画」） | Ops |
| `architecture/data-model/` | データモデルの完全版（ER 図、列の型と索引の正本） | Dev |
| `primer/index.html` | 前提知識の資料（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

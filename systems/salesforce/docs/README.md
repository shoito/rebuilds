# Salesforce の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Salesforce の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、領域の一覧 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [runbooks/](runbooks/README.md) | SLO、リリース、アラートと手順、訓練 | Ops |

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `quality.md` | 品質戦略。アクセス制御の決定表、共有の性質ベーステスト、上限の試験、テスト計画 | QA |
| `roadmap.md` | Epic と Story | PM |
| `architecture/` の領域の文書 | [architecture/README.md](architecture/README.md) の 7 節の一覧 | Dev |

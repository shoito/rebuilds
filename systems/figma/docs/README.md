# Figma の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Figma の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | なぜ作るか、MVP の範囲、守るべき振る舞い、やらないこと、成功の基準 | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、領域ごとの設計 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [architecture/data-model.md](architecture/data-model.md) | データモデルの正本（規約、ER 図、表の定義、DB の外の置き場所、プロパティの表）。領域ごとの定義は `architecture/data-model/` | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、テストのレベルと領域ごとの重点、本番での検証、Epic ごとの合否基準 | QA |
| [roadmap.md](roadmap.md) | Epic（E1〜E12 が MVP、E13〜E15 が MVP の後）と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLO、リリース、アラートと手順、訓練 | Ops |

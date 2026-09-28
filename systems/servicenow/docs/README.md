# ServiceNow の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は ServiceNow の再構築の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと、法務の確認待ち | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、ADR の一覧、リスクと統合の決定、領域の文書（データモデルの索引は [data-model.md](architecture/data-model.md)） | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、テストのレベルと領域ごとの重点、シフトライト、AI の eval、Epic ごとの合否基準 | QA |
| [roadmap.md](roadmap.md) | Epic（E1〜E12 と E13 以降）と Story、後回しにしたもの | PM |
| [runbooks/](runbooks/README.md) | SLO、アラートと手順、リリースの方針、訓練 | Ops |

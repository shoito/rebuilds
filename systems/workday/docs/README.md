# Workday の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Workday の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと、確認待ちの論点（L1〜L58） | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、主な決定、リスク、領域ごとの設計（7 節）、データモデルの索引（[data-model.md](architecture/data-model.md)） | Dev |
| [decisions/](decisions/README.md) | ADR の一覧（0001〜0063） | Dev |
| [quality.md](quality.md) | 品質のリスク、仕様のレビューの関門、テストのレベル、ゴールデンデータセットと並行稼働、本番での品質検証、AI の eval、Epic ごとの合否基準 | QA |
| [roadmap.md](roadmap.md) | Epic（E1〜E16）と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLO、アラートと手順、リリースの方針（規則表のリリースの暦、支給日の前の凍結）、訓練 | Ops |

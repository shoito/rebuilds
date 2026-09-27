# Uber の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Uber の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、日本での運営の形、MVP の範囲、守るべき振る舞い、法務の確認待ち（L1〜L9） | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、ADR の一覧、リスクと統合の決定、領域の一覧、Epic | Dev |
| [architecture/data-model.md](architecture/data-model.md) | データの置き場所の索引、位置の置き場所の一覧、統合した定義 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧（0001〜0043） | Dev |
| [quality.md](quality.md) | 品質目標とリスク、仕様レビューの関門、テストのレベルと領域ごとの重点、再生・影の関門、位置の漏洩のテスト、DR の訓練の基準、本番での品質検証、Epic ごとの合否基準 | QA |
| [roadmap.md](roadmap.md) | Epic（E1〜E12 が MVP、E13〜E15 が S2）と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLO、上限、リリースと凍結、アラートと手順、定期作業と訓練 | Ops |

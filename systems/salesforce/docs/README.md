# Salesforce の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Salesforce の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと、法務の確認待ち（L1〜L11） | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、領域の文書（22）、データモデルの索引 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧（0001〜0063） | Dev |
| [quality.md](quality.md) | 品質戦略。アクセスの判定の 4 段の確かめ、上限の試験、負荷試験、DR の訓練の合格基準、Epic ごとの合否基準 | QA |
| [roadmap.md](roadmap.md) | Epic（E1〜E19）と Story、後回しにしたもの | PM |
| [runbooks/](runbooks/README.md) | SLO、リリースとロールバックの方針、アラートと手順、訓練 | Ops |

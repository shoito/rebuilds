# ServiceNow の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は ServiceNow の再構築の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと、法務の確認待ち | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、領域の一覧と ADR の番号の範囲 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [runbooks/](runbooks/README.md) | SLO、リリース、アラートと手順、訓練（統合の工程で作る） | Ops |

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `quality.md` | 品質戦略、ACL の決定表・SLA の性質・ワークフローの耐久性・CMDB の調整のテスト、テスト計画 | QA |
| `roadmap.md` | Epic（E1〜E12 の草案は [architecture/](architecture/README.md) の 8 節）と Story | PM |

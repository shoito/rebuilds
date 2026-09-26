# Uber の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Uber の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、日本での運営の形、MVP の範囲、守るべき振る舞い、法務の確認待ち | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、領域の一覧 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [runbooks/](runbooks/README.md) | SLO、リリース、アラートと手順、訓練（これから書く） | Ops |

次の文書は、これから作る。

- `quality.md`（QA）：品質戦略、配車のシミュレーションと再生の試験、テスト計画
- `roadmap.md`（PM）：Epic と Story

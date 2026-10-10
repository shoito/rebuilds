# Shopify の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Shopify の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 問題、望む結果、MVP の範囲、守るべき振る舞い、成功の基準、利用者、制約、やらないこと、法務の確認待ち（L1〜L10）、出典 | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階（S1〜S3）、非機能要件、技術スタック、主な決定、統合の決定と未解決事項、領域の文書（22 本）とデータモデル（[data-model.md](architecture/data-model.md)）、Epic | Dev |
| [decisions/](decisions/README.md) | ADR の一覧（0001〜0076） | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、売り越し・注文の一回性・割引・税の端数の性質ベーステスト、フラッシュセールの負荷試験、テーマのエンジンのファジング、砂場の脱出の試験、性質と決定表の一覧、テスト計画 | QA |
| [roadmap.md](roadmap.md) | Epic と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLI と SLO、上限とフラグ、リリース、アラートと手順（核の 6 本と計画）、フラッシュセールの運用 | Ops |

2026-10-10 に統合と検証の工程を終えた（[architecture/README.md](architecture/README.md) の 6 節の「決定（2026-10-10、統合）」）。

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `runbooks/` の計画の手順 | [runbooks/README.md](runbooks/README.md) の 4 節の「計画」の手順 | Ops |
| [architecture/data-model/](architecture/data-model/) | 領域ごとの表の目録（列・制約・索引・分割・保持・量）と ER 図、Aurora の外の置き場所 | Dev |
| `primer/index.html` | 前提知識の資料（ポッドとセル、在庫の引き当て、チェックアウトのステートマシン、テンプレートの言語の安全、WebAssembly の燃料、GraphQL の費用の計算、インボイス制度の端数処理）（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

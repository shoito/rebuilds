# Shopify の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Shopify の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 問題、望む結果、MVP の範囲、守るべき振る舞い、成功の基準、利用者、制約、やらないこと、法務の確認待ち（L1〜L10）、出典 | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階（S1〜S3）、非機能要件、技術スタック、主な決定、リスク、領域の文書の計画（23 本）、Epic | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、売り越し・注文の一回性・割引・税の端数の性質ベーステスト、フラッシュセールの負荷試験、テーマのエンジンのファジング、砂場の脱出の試験、テスト計画 | QA |
| [roadmap.md](roadmap.md) | Epic と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLI と SLO、上限、リリース、アラートと手順、フラッシュセールの運用 | Ops |

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `architecture/` の領域の文書 | [architecture/README.md](architecture/README.md) の 7 節の計画にある 23 本 | Dev |
| `runbooks/` の個別の手順 | [runbooks/README.md](runbooks/README.md) の 4 節の一覧 | Ops |
| `primer/index.html` | 前提知識の資料（ポッドとセル、在庫の引き当て、チェックアウトの状態の機械、テンプレートの言語の安全、WebAssembly の燃料、GraphQL の費用の計算、インボイス制度の端数処理）（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

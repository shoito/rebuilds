# Mercari の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Mercari の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 問題、望む結果、MVP の範囲、守るべき振る舞い、成功の基準、利用者、制約、やらないこと、法務の確認待ち（L1〜L11）、出典 | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階（S1〜S3）、費用のモデル、非機能要件、技術スタック、主な決定、リスク、領域の文書の計画（22 本）、Epic | Dev |
| [decisions/](decisions/README.md) | ADR の一覧（0001〜0010） | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、二重の販売なし・台帳の釣り合い・振り替えの一回性の性質ベーステスト、状態の機械の期限の試験、配送の Webhook の競合の試験、偽ブランドの分類器の評価の集まり、人気の商品の負荷試験、テスト計画 | QA |
| [roadmap.md](roadmap.md) | Epic と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLI と SLO、上限とフラグ、リリース、アラートと手順、人気の商品と大型の企画の日の運用 | Ops |

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `architecture/` の領域の文書 | [architecture/README.md](architecture/README.md) の 7 節の計画にある 22 本 | Dev |
| `architecture/data-model/` | 領域ごとの表の目録と ER 図 | Dev |
| `runbooks/` の個別の手順 | [runbooks/README.md](runbooks/README.md) の 4 節の一覧 | Ops |
| `primer/index.html` | 前提知識の資料（C2C の預かりと複式簿記、一品の一回の購入、期限つきの状態の機械、日本語の検索と保存した検索の照合、匿名の配送、分類器と人の審査、資金決済法の 3 つの枠組み）（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

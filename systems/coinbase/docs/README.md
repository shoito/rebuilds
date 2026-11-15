# Coinbase の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Coinbase の再構築の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 問題、望む結果、MVP の範囲、守るべき振る舞い、成功の基準、利用者、制約、やらないこと、法務の確認待ち（L1〜L19）、PM の判断待ち（P1〜P14）、出典 | PM |
| [architecture/](architecture/README.md) | 全体像、本家の形と意図した違い、規模の段階（S1〜S3）、費用のモデル、非機能要件、技術スタック、主な決定、リスク、領域の文書（20 本）と ADR の番号の範囲、Epic | Dev |
| [architecture/design-log.md](architecture/design-log.md) | 工程ごとの「決定」の記録（既定案、統合） | Dev |
| [decisions/](decisions/README.md) | ADR の一覧（0001〜0075。どれも `proposed`） | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、残高の二重の使用なし・台帳の釣り合い・エンジンの決定性（再生）の性質ベーステスト、チェーンと銀行のシミュレーター、出金の方針の表、確認ループと eval | QA |
| [roadmap.md](roadmap.md) | 進め方の原則、walking skeleton、Epic と Story、Epic の依存の図、エージェントに任せないこと、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLI と SLO、上限とフラグ、リリース、アラートと手順、定期作業 | Ops |

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `architecture/data-model.md`・`architecture/data-model/` | データモデルの正本（工程 4） | Dev |
| `runbooks/` の計画の手順 | [runbooks/README.md](runbooks/README.md) の 4 節の「計画のもの」 | Ops |
| `primer/index.html` | 前提知識の資料（板と価格・時間の優先、sequencer と再生、ホット・コールドと署名の方針、チェーンの承認と巻き戻し、分別管理と照合、日本の暗号資産の法令の枠組み）（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

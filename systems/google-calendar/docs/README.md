# Google Calendar の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Google Calendar の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと、法務の確認待ち | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、主な決定（統合の決定と持ち越しを含む）、領域の文書 19 本 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、繰り返しの展開の参照との性質ベーステスト、tzdb の更新の試験、テスト計画 | QA |
| [roadmap.md](roadmap.md) | Epic と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLO、上限、リリースとロールバック、アラートと手順、定期作業。手順は incident-response・deploy-and-rollback・disaster-recovery・tzdb-update | Ops |
| [architecture/data-model.md](architecture/data-model.md) | 表と置き場所の索引（領域ごと）、テナントの外の表 | Dev |

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `runbooks/` の個別の手順 | [runbooks/README.md](runbooks/README.md) の 6 節の計画の runbook（作成済みは 4 つ） | Ops |
| データモデルの完全版 | ER 図、列の型と索引の正本、横断の不変条件（[architecture/README.md](architecture/README.md) の 6 節の持ち越し） | Dev |
| `primer/index.html` | 前提知識の資料（iCalendar、RRULE、tzdb、iTIP、CalDAV）（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

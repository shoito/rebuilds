# Airbnb の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Airbnb の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 問題、望む結果、MVP の範囲、守るべき振る舞い、成功の基準、利用者、制約、やらないこと、法務の確認待ち（L1〜L14）、出典 | PM |
| [architecture/](architecture/README.md) | 全体像、本家の形と意図した違い、規模の段階（S1〜S3）、費用のモデル、非機能要件、技術スタック、主な決定、リスク、統合の決定と残る未解決事項、領域の文書（25 本）、Epic | Dev |
| [architecture/data-model.md](architecture/data-model.md) | 表と置き場所の索引（クラスタごと・領域ごと）、Valkey の鍵、S3、SQS、AppConfig の値と `legal.*` の一覧 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧（0001〜0083。0013・0028 は欠番） | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、二重の予約なし（即時予約・リクエスト・iCal の取り込みをまたぐ）・180 泊の上限・返金の計算・レビューの同時の公開の性質ベーステスト、タイムゾーンと日付の境の試験、検索の鮮度の試験、繁忙期の負荷試験、領域ごとの性質と決定表の ID、テスト計画 | QA |
| [roadmap.md](roadmap.md) | Epic と Story、エージェントに任せないこと、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLI と SLO、上限とフラグ、リリース、アラートと手順（作った 7 本と計画）、繁忙期の運用、安全の事故への対応 | Ops |

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `architecture/data-model/` | 領域ごとの表の目録（列・キー・索引・RLS）と ER 図（データモデルの工程） | Dev |
| `runbooks/` の計画の手順 | [runbooks/README.md](runbooks/README.md) の 4 節の「計画のもの」 | Ops |
| `primer/index.html` | 前提知識の資料（泊の範囲と排他の制約、日付の範囲の検索、物件のタイムゾーン、iCalendar の同期の限界、預かりとチェックインの後の送金、複数の通貨、住宅宿泊事業法の 180 泊の数え方）（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

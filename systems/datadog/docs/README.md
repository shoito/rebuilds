# Datadog の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Datadog の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと、法務の確認待ち | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、主な決定、統合の決定、20 の領域の文書 | Dev |
| [architecture/data-model.md](architecture/data-model.md)、[architecture/data-model/](architecture/data-model/) | データモデルの正本：規約、ER 図、表の目録（列・キー・索引・CHECK・RLS・分割・保持・量）、ファイルの形式（ブロック・セグメント・チェックポイント・ID の索引）、MSK・S3・Valkey の形、横断の不変条件 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、圧縮とロールアップの参照との比べ、クエリの集計の性質、モニターの評価の再生、取り込みの負荷とうるさい隣人の試験、耐久性の確かめ、テスト計画 | QA |
| [roadmap.md](roadmap.md) | Epic と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLO、上限、リリース、アラートと手順、自己監視と循環の回避、作成済みの手順（インシデント、デプロイと戻し、災害復旧、自己監視の経路の停止、うるさい隣人） | Ops |

これから作る文書：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `runbooks/` の残りの手順 | [runbooks/README.md](runbooks/README.md) の 4 節の「予定」の手順 | Ops |
| `primer/index.html` | 前提知識の資料（時系列の圧縮、カーディナリティ、分布のスケッチ、テールサンプリング、バーンレートのアラート）（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

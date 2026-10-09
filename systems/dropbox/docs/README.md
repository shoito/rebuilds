# Dropbox の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Dropbox の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと、法務の確認待ち | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、主な決定、領域の文書の計画 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、決定的な同期のシミュレーター、ファイルシステムの端の場合の試験、耐久性の確かめ、テスト計画 | QA |
| [roadmap.md](roadmap.md) | Epic と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLO、上限、リリース、アラートと手順 | Ops |

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `architecture/` の領域の文書 | [architecture/README.md](architecture/README.md) の 7 節の計画にある 19 本 | Dev |
| `runbooks/` の個別の手順 | [runbooks/README.md](runbooks/README.md) の 4 節の一覧 | Ops |
| `primer/index.html` | 前提知識の資料（内容で区切る分割、3 つの木の同期、File Provider と Cloud Files API、Unicode の正規化）（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

# YouTube の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は YouTube の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 問題、MVP の範囲、守るべき振る舞い、成功の基準、利用者、制約、やらないこと、法務の確認待ち（L1〜L10）、出典 | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階（S1〜S3）、費用のモデル、非機能要件、技術スタック、主な決定、リスク、領域の文書の計画、Epic | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、黄金の動画の適合と VMAF、ABR のネットワークの記録での模擬、視聴回数の不正の試験、指紋の適合率と再現率、ライブの遅延の試験、耐久性の確かめ、テスト計画 | QA |
| [roadmap.md](roadmap.md) | Epic と Story、延期の一覧 | PM |
| [runbooks/](runbooks/README.md) | SLI と SLO、上限、リリース、アラートと手順、CDN の障害、急な人気（バイラル）への備え | Ops |

これから作る文書（まだない）：

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| `architecture/` の領域の文書 | [architecture/README.md](architecture/README.md) の 7 節の計画にある 22 本 | Dev |
| `runbooks/` の個別の手順 | [runbooks/README.md](runbooks/README.md) の 4 節の一覧 | Ops |
| `primer/index.html` | 前提知識の資料（コーデックとビットレートのラダー、VMAF、CMAF と HLS・DASH、ABR、CDN の多層のキャッシュ、LL-HLS、音声・映像の指紋）（[リポジトリ共通の ADR-0008](../../../docs/decisions/0008-primers-on-github-pages.md)） | Dev |

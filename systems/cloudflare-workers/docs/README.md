# Cloudflare Workers の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Cloudflare Workers の再構築の開発リポジトリで行う（[リポジトリ共通の ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、成功の基準、やらないこと | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、領域ごとの設計 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [quality.md](quality.md) | 品質戦略、リスク、テストのレベルと領域ごとの重点、本番での品質検証、Epic ごとの合否基準 | QA |
| [runbooks/](runbooks/README.md) | SLO、リリース（ランタイムの波、V8 の緊急の経路、基盤の設定の段階）、アラートと手順、訓練 | Ops |
| [roadmap.md](roadmap.md) | Epic（E1〜E12 が MVP、E13〜E17 が S2・S3）と Story、延期の一覧 | PM |

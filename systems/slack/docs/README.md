# Slack の設計ドキュメント

入口。このリポジトリには設計の文書だけを置き、実装は Slack の開発リポジトリで行う（[ADR-0005](../../../docs/decisions/0005-design-record-repository.md)）。何を作るかは intent、どう作るかは architecture、何をもって正しいとするかは quality と specs・changes、どう運用するかは runbooks にある。

| 文書 | 内容 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | 本質、MVP の範囲、守るべき振る舞い、やらないこと | PM |
| [architecture/](architecture/README.md) | 全体像、規模の段階、非機能要件、技術スタック、領域ごとの設計 | Dev |
| [decisions/](decisions/README.md) | ADR の一覧 | Dev |
| [quality.md](quality.md) | 品質戦略（シフトレフト、AI 自体の品質、本番での品質検証）、テスト計画 | QA |
| [runbooks/](runbooks/README.md) | SLO、テナント単位の上限、リリース、アラートと手順、訓練 | Ops |
| [roadmap.md](roadmap.md) | Epic と Story | PM |
| [specs/](specs/README.md) | 実装済みの振る舞いの正本。**開発リポジトリへ移す予定** | Dev（反映のみ） |
| [changes/](changes/README.md) | 進行中の変更。**開発リポジトリへ移す予定** | 変更ごと |

## 読む順序

1. [intent.md](intent.md)
2. [architecture/README.md](architecture/README.md) と [decisions/](decisions/README.md)
3. 作業する領域の [architecture/](architecture/README.md) の各ファイル
4. [quality.md](quality.md) と、作業する変更の `changes/<id>/`

進め方の共通の規則は [docs/process.md](../../../docs/process.md)、エージェント向けの規則は [AGENTS.md](../AGENTS.md) にある。

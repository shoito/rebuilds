# rebuilds

既存のソフトウェア・システム・SaaS を、**AI（コーディングエージェント）を主な作り手として再構築するなら、どう設計し、どう作るか** を記録し、実際に作るリポジトリ。

開発プロセスは Anthropic の [AI-Native SDLC Playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) の intent → spec → plan を骨格にしている。そこへ Kiro の EARS 記法と要件 ID、OpenSpec の正本／差分の分離、MADR 形式の ADR を組み合わせた。詳細は [docs/process.md](docs/process.md)、採用の理由は [ADR-0001](docs/decisions/0001-adopt-ai-native-lifecycle.md) にある。

## 題材

| 題材 | ジャンル | 主な論点 | 状態 |
| --- | --- | --- | --- |
| [Slack](systems/slack/) | チャット | リアルタイム配信、メッセージ順序、既読管理、検索 | 設計中 |
| Chrome | ブラウザ | レンダリングパイプライン、プロセス分離、サンドボックス | 未着手 |
| Notion | ドキュメント / DB | ブロックモデル、共同編集（CRDT/OT）、権限 | 未着手 |
| GitHub | Git ホスティング | Git ストレージ、PR / レビュー、CI 連携 | 未着手 |
| Stripe | 決済 | 冪等性、台帳（二重記入簿記）、Webhook 配信 | 未着手 |

## 構成

```
.
├── AGENTS.md                  # エージェント向けの共通ルール（CLAUDE.md は symlink）
├── .github/                   # CODEOWNERS、PR テンプレート
├── docs/
│   ├── process.md             # 開発プロセスの定義
│   ├── templates/             # 各成果物のテンプレート
│   └── decisions/             # リポジトリ横断の ADR
└── systems/<name>/
    ├── AGENTS.md              # 題材固有のルール
    ├── docs/
    │   ├── intent.md          # なぜ・何を作るか
    │   ├── architecture.md    # 横断的な設計
    │   ├── quality.md         # 品質戦略（QA）
    │   ├── roadmap.md         # Epic（PM）
    │   ├── runbooks/          # SLO、リリース、障害対応（Ops）
    │   ├── specs/             # 実装済みの振る舞いの正本
    │   ├── decisions/         # ADR
    │   └── changes/           # 進行中の変更（Story 単位）：spec.md（差分）＋ plan.md、任意で intent.md・quality.md
    └── <実装コード>
```

## 新しい題材の始め方

1. `systems/<name>/docs/` に、テンプレートから `intent.md` を作る。
2. `architecture.md`、`quality.md`、`roadmap.md`、`runbooks/README.md` を書き、主要な決定を ADR にする。
3. 最初の Epic の最初の変更を `changes/YYMMDD-<slug>/` に作り、`spec.md` と `plan.md` を書く。

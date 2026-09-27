# rebuilds

既存のソフトウェア・システム・SaaS を、**AI（コーディングエージェント）を主な作り手として再構築するなら、どう設計し、どう作るか** を記録するリポジトリ。

実際の開発は、題材ごとの開発リポジトリで行う（[ADR-0005](docs/decisions/0005-design-record-repository.md)）。

開発プロセスは Anthropic の [AI-Native SDLC Playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) の intent → spec → plan を骨格にしている。そこへ Kiro の EARS 記法と要件 ID、OpenSpec の正本／差分の分離、MADR 形式の ADR を組み合わせた。詳細は [docs/process.md](docs/process.md)、採用の理由は [ADR-0001](docs/decisions/0001-adopt-ai-native-lifecycle.md) にある。

## 題材

| 題材 | ジャンル | 主な論点 | 状態 |
| --- | --- | --- | --- |
| [Slack](systems/slack/) | チャット | リアルタイム配信、メッセージ順序、既読管理、検索 | 設計済み |
| [Stripe](systems/stripe/) | 決済 | 冪等性、台帳（二重記入簿記）、Webhook 配信、カード情報の隔離（PCI DSS） | 設計済み |
| [GitHub](systems/github/) | Git ホスティング | Git ストレージと複製、PR / レビュー、CI（Actions）、コード検索 | 設計済み |
| [Chrome](systems/chrome/) | ブラウザ | レンダリングパイプライン、プロセス分離、サンドボックス、更新と配信 | 設計済み |
| [Notion](systems/notion/) | ドキュメント / DB | ブロックモデル、共同編集（CRDT）、権限、シャーディング | 設計済み |
| [Auth0](systems/auth0/) | 認証基盤（CIAM） | OAuth / OIDC、MFA とパスキー、攻撃の防御、テナントの隔離 | 設計済み |
| [Figma](systems/figma/) | デザインツール | 中央の権威サーバーでの共同編集、WebGL / WASM での描画、巨大なドキュメント | 設計済み |
| [Kafka](systems/kafka/) | 分散ログ（マネージドのストリーミング） | パーティションと複製、exactly-once、階層型の保存 | 設計済み |
| [Zoom](systems/zoom/) | ビデオ会議 | WebRTC、SFU、帯域の推定、低遅延、録画 | 設計済み |
| [Uber](systems/uber/) | 配車のマーケットプレイス | マッチング、地理空間の索引、動的な料金、リアルタイムの位置 | 設計済み |
| Cloudflare Workers | エッジのサーバーレス | V8 isolate での隔離、グローバルな配信、エッジのストレージ | 設計中 |

「設計済み」は、intent・アーキテクチャ・ADR・quality・runbooks・roadmap がそろい、公式の資料での事実の確認と、文書の間の整合の見直しを終えた状態を指す。法務の確認待ちの事項と、PoC・計測で確かめる事項は、各題材の文書に残している。

## 構成

```
.
├── AGENTS.md                  # エージェント向けの共通ルール（CLAUDE.md は symlink）
├── .github/                   # CODEOWNERS、PR テンプレート
├── docs/
│   ├── process.md             # 開発プロセス（方法論）の定義
│   ├── project-management.md  # GitHub での回し方
│   ├── templates/             # 各成果物のテンプレート
│   └── decisions/             # リポジトリ共通の ADR
└── systems/<name>/            # 題材ごとの設計
    ├── AGENTS.md              # 題材固有のルール
    └── docs/
        ├── intent.md          # なぜ・何を作るか（PM）
        ├── architecture/      # 全体像と領域ごとの設計（Dev）
        ├── decisions/         # ADR（Dev）
        ├── quality.md         # 品質戦略（QA）
        ├── runbooks/          # SLO、リリース、障害対応（Ops）
        ├── roadmap.md         # Epic と Story（PM）
        ├── specs/             # 開発リポジトリへ移す予定（ADR-0005）
        └── changes/           # 開発リポジトリへ移す予定（ADR-0005）
```

実装のコード、`specs/`（正本）、`changes/`（変更ごとの spec・plan）、CI、IaC は、題材ごとの開発リポジトリに置く。

## 新しい題材の始め方

1. `systems/<name>/docs/` に、テンプレートから `intent.md` を作る。
2. `architecture/README.md`、`quality.md`、`roadmap.md`、`runbooks/README.md` を書き、主要な決定を ADR にする。
3. 開発リポジトリを作り、最初の Epic の最初の変更を、そこの `changes/YYMMDD-<slug>/` に作る。

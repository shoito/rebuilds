# 開発プロセス

このリポジトリで採用する AI-Native な開発ライフサイクルの定義。

骨格は Anthropic の [AI-Native SDLC Playbook](https://claude.com/blog/the-ai-native-sdlc-playbook) の 6 段（Plan → Design → Build → Test → Deploy → Maintain）で、原則「**各段は、次の段が読める成果物をコミットする**」に従う。そこへ次の 3 つを組み合わせる。

- Kiro の EARS 記法と、要件 ID による追跡
- OpenSpec の「正本 spec」と「変更ごとの差分」の分離
- MADR 形式の ADR

## 1. 成果物の全体像

```
systems/<name>/
├── AGENTS.md                  # この題材に固有のエージェント向けルール（CLAUDE.md は symlink）
├── docs/
│   ├── intent.md              # 製品レベルの Plan：なぜ作るか、本質、スコープ、制約
│   ├── architecture.md        # 横断的な設計：構成、データモデル、主要フロー、技術スタック
│   ├── quality.md             # 品質戦略：シフトレフト / シフトライト、テスト計画（QA が持つ）
│   ├── roadmap.md             # Epic の一覧と順序、変更フォルダへのリンク
│   ├── specs/<capability>/spec.md   # 正本：実装済みの振る舞い（要件＋設計）
│   ├── decisions/NNNN-<slug>.md     # ADR
│   └── changes/
│       ├── NNNN-<slug>/       # 進行中の変更（Story 単位）
│       │   ├── intent.md      # 任意：変更の動機が roadmap だけで伝わらないとき
│       │   ├── spec.md        # 正本への差分：ADDED / MODIFIED / REMOVED
│       │   └── plan.md        # Files / Order of work / Risks / Proof
│       └── archive/           # 完了した変更
└── <実装コード>
```

リポジトリ全体に関わる決定は、ルートの `docs/decisions/` に置く。

### Kiro との対応

Kiro の Spec-Driven Development に慣れている人向けの対応表。

| Kiro | このリポジトリ | 違い |
| --- | --- | --- |
| （なし） | `intent.md` | Kiro には spec の手前で「なぜ作るか」を合意する層がない。Anthropic Playbook の Plan 段にあたる |
| `.kiro/steering/product.md` | `docs/intent.md`（題材レベル） | 製品の目的・ユーザー・スコープ |
| `.kiro/steering/tech.md` | `docs/architecture.md` の技術スタック、`docs/decisions/` | 技術選定の理由は ADR として残す |
| `.kiro/steering/structure.md` | `AGENTS.md` | ディレクトリの責務、コマンド、禁止事項 |
| `.kiro/specs/<feature>/requirements.md` | `changes/NNNN-<slug>/spec.md` の Requirements | EARS と Given/When/Then は同じ。要件 ID を `REQ-<CAP>-NNN` 形式にし、差分（ADDED / MODIFIED / REMOVED）で書く |
| `.kiro/specs/<feature>/design.md` | `spec.md` の Design ＋ `docs/architecture.md` ＋ ADR | 変更に固有の設計だけを spec に書く。横断的な設計は architecture.md、選択の理由は ADR に分ける |
| design.md の Correctness Properties | `spec.md` の Correctness Properties（`PROP-*`） | 同じ考え方。性質ベーステストで検証する |
| `.kiro/specs/<feature>/tasks.md` | `plan.md` | Order of work が tasks.md にあたる。加えて Files that change、Risks、Proof を持つ |
| tasks.md の `_Requirements: 1.2_` | Order of work と Proof の要件 ID | 要件 ID をテスト名にも含め、CI で追跡を検査する |
| `bugfix.md` | 規模「小」の `plan.md` | Proof に回帰テストを書く。Kiro の「Unchanged Behavior」（直さないこと）の考え方は Risks に書く |
| `.kiro/specs/<feature>/` 一式（機能ごとに残り続ける） | `specs/<capability>/spec.md`（正本）＋ `changes/archive/` | Kiro は機能ごとの spec がそのまま残る。ここでは完了した差分を capability ごとの正本へ反映し、変更フォルダは履歴として archive に移す |
| （なし） | `quality.md` | QA が持つ品質戦略。Kiro には対応するものがない |

要するに、**spec.md は requirements.md ＋ design.md（のうち、その変更に固有の部分）**、**plan.md は tasks.md に Files・Risks・Proof を足したもの** にあたる。

## 2. 段と成果物

| 段 | 成果物 | 作り手 | 承認者 | 完了条件 |
| --- | --- | --- | --- | --- |
| Plan | `intent.md` | 起票者（Claude と壁打ちして作る） | プロダクトオーナー | 問題・望む結果・制約・未解決の問いが本人の言葉で書かれている |
| Design | `spec.md`（差分）、必要なら ADR | Claude（起票者が指示） | テックリード、**QA** | 要件がすべて ID と受け入れ基準を持つ。QA が受け入れ基準と正しさの性質をレビュー済み |
| Build | `plan.md`、コード | Claude（plan mode で計画 → 承認 → 実装） | エンジニア | 会話を見ていないエンジニアでも plan だけで実装できる |
| Test | テスト結果、eval 結果 | Claude（自分で確認ループを回す）、CI | QA | `plan.md` の Proof がすべて満たされている |
| Deploy | PR とレビュー指摘 | Claude（レビュー） | コードオーナー | `REVIEW.md` の方針で Important の指摘が 0 件 |
| Maintain | 新しい `intent.md` | 監視 → Claude が調査 | プロダクトオーナー | 指標が許容範囲を外れたら、調査結果が intent として起票される |

変更が完了したら、`spec.md` の差分を `specs/` の正本に反映し、変更フォルダを `changes/archive/` に移す。これを **アーカイブ** と呼ぶ。アーカイブは変更の最後の PR で行う。

## 3. 規模に応じた経路

すべての変更に全成果物を求めない。重さは変更の大きさで決める。

| 規模 | 例 | 必要な成果物 |
| --- | --- | --- |
| 軽微 | typo、依存の更新、振る舞いを変えない修正 | PR のみ |
| 小 | 既存の振る舞いのバグ修正 | `plan.md`（Proof に回帰テストを書く） |
| 標準 | Story 1 件の機能追加・変更 | `spec.md` ＋ `plan.md` |
| 大 | 新しい Epic、アーキテクチャに影響する変更 | `intent.md` ＋ `spec.md` ＋ `plan.md` ＋ ADR。`roadmap.md` も更新する |

## 4. 粒度

- **Epic** は `roadmap.md` の 1 行。Epic ごとにフォルダは作らない。
- **Story** は `changes/NNNN-<slug>/` の 1 フォルダ。1 PR から数セッションで終わる大きさにする。
- **Capability** は `specs/<capability>/` の 1 フォルダ。機能領域ごとの正本で、複数の Story から更新される。

## 5. 要件の書き方

### ID

| 種類 | 形式 | 例 |
| --- | --- | --- |
| 要件 | `REQ-<CAP>-NNN` | `REQ-MSG-001` |
| 正しさの性質 | `PROP-<CAP>-NNN` | `PROP-MSG-001` |
| 非機能要件 | `NFR-NNN` | `NFR-003` |
| ADR | `ADR-NNNN` | `ADR-0002` |

ID は一度振ったら再利用しない。削除した要件の ID は欠番にする。

### EARS 記法（日本語版）

| パターン | 形 |
| --- | --- |
| 常時 | システムは〈振る舞い〉しなければならない |
| イベント | 〈事象〉とき、システムは〈振る舞い〉しなければならない |
| 状態 | 〈状態〉の間、システムは〈振る舞い〉しなければならない |
| 望ましくない事象 | 〈異常〉場合、システムは〈振る舞い〉しなければならない |
| オプション | 〈機能〉が有効なとき、システムは〈振る舞い〉しなければならない |

各要件には Given / When / Then 形式のシナリオを 1 つ以上付ける。

### 正しさの性質

個々のシナリオとは別に、「どんな入力でも成り立つべきこと」を性質として書く（Kiro の Correctness Properties に相当）。性質は性質ベーステストで検証する。

> PROP-MSG-001：任意の投稿・切断・再送の列に対して、全クライアントが最終的に見るメッセージ列は、DB 上の `seq` 順の列と一致する。

## 6. 追跡

- `plan.md` のタスクと Proof には、対応する要件 ID を書く。
- テストの名前（`describe` / `it`）には要件 ID を含める。

  ```ts
  it("REQ-MSG-002: same client_msg_id returns the existing message", ...)
  ```

- CI で、`specs/` と進行中の `changes/` にあるすべての要件 ID がどこかのテストから参照されていることを検査する。

## 7. 決定の記録（ADR）

- 次のどれかに当たる決定は ADR にする。
  - 後から変えるコストが高いもの
  - 複数の選択肢を比べて選んだもの
  - エージェントが別の選択をしがちなもの
- 形式は `docs/templates/adr.md`（MADR を簡略化したもの）に従う。
- ADR は書き換えない。方針を変えるときは新しい ADR を書き、古いほうの状態を `superseded by ADR-NNNN` にする。

## 8. 品質

品質戦略は題材ごとに `quality.md` にまとめ、QA が持つ。変更ごとのテスト設計は、独立した文書にせず次の 2 か所に書く。

- `spec.md`：シナリオと正しさの性質
- `plan.md`：Proof（何を、どのテストで証明するか）

QA は Design 段の承認者として、受け入れ基準と性質をレビューする（シフトレフト）。本番での検証（シフトライト）は `quality.md` に定義し、Maintain 段で新しい intent を生む。

## 9. テンプレート

| 成果物 | テンプレート |
| --- | --- |
| `intent.md` | [templates/intent.md](templates/intent.md) |
| `architecture.md` | [templates/architecture.md](templates/architecture.md) |
| `quality.md` | [templates/quality.md](templates/quality.md) |
| `roadmap.md` | [templates/roadmap.md](templates/roadmap.md) |
| `spec.md`（正本・差分） | [templates/spec.md](templates/spec.md) |
| `plan.md` | [templates/plan.md](templates/plan.md) |
| ADR | [templates/adr.md](templates/adr.md) |

## 10. 参考

- Anthropic, [The AI-Native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook)（2026-08-21）
- Kiro, [Specs](https://kiro.dev/docs/specs/) / [Steering](https://kiro.dev/docs/steering/)
- Fission-AI, [OpenSpec](https://github.com/Fission-AI/OpenSpec)
- GitHub, [Spec Kit](https://github.com/github/spec-kit)
- AWS, [AI-DLC workflows](https://github.com/awslabs/aidlc-workflows)
- [MADR](https://adr.github.io/madr/)
- Birgitta Böckeler, [Understanding Spec-Driven-Development: Kiro, spec-kit, and Tessl](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)

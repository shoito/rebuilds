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
│   ├── architecture/          # 設計：README.md に全体像・規模・非機能要件・技術スタック、領域ごとに 1 ファイル
│   ├── quality.md             # 品質戦略：シフトレフト、本番での品質検証、テスト計画
│   ├── roadmap.md             # Epic の一覧と順序
│   ├── runbooks/              # 運用：SLO、アラート、リリースとロールバック、障害対応手順
│   ├── specs/<capability>/spec.md   # 正本：実装済みの振る舞い（要件＋設計）
│   ├── decisions/NNNN-<slug>.md     # ADR
│   └── changes/
│       ├── YYMMDD-<slug>/     # 進行中の変更（Story 単位）
│       │   ├── intent.md      # 任意：変更の動機が roadmap だけで伝わらないとき
│       │   ├── spec.md        # 正本への差分：ADDED / MODIFIED / REMOVED
│       │   ├── plan.md        # Files / Order of work / Risks / Proof
│       │   └── quality.md     # 任意：リスクの高い変更のテスト設計
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
| `.kiro/steering/tech.md` | `docs/architecture/README.md` の技術スタック、`docs/decisions/` | 技術選定の理由は ADR として残す |
| `.kiro/steering/structure.md` | `AGENTS.md` | ディレクトリの責務、コマンド、禁止事項 |
| `.kiro/specs/<feature>/requirements.md` | `changes/YYMMDD-<slug>/spec.md` の Requirements | EARS と Given/When/Then は同じ。要件 ID を `REQ-<CAP>-NNN` 形式にし、差分（ADDED / MODIFIED / REMOVED）で書く |
| `.kiro/specs/<feature>/design.md` | `spec.md` の Design ＋ `docs/architecture/` ＋ ADR | 変更に固有の設計だけを spec に書く。横断的な設計や領域の設計は architecture/、選択の理由は ADR に分ける |
| design.md の Correctness Properties | `spec.md` の Correctness Properties（`PROP-*`） | 同じ考え方。性質ベーステストで検証する |
| （なし） | `spec.md` の Decision Tables（`DT-*`） | 条件の組み合わせで結果が決まる規則を表で書き、表駆動テストで検証する |
| `.kiro/specs/<feature>/tasks.md` | `plan.md` | Order of work が tasks.md にあたる。加えて Files that change、Risks、Proof を持つ |
| tasks.md の `_Requirements: 1.2_` | Order of work と Proof の要件 ID | 要件 ID をテスト名にも含め、CI で追跡を検査する |
| `bugfix.md` | 規模「小」の `plan.md` | Proof に回帰テストを書く。Kiro の「Unchanged Behavior」（直さないこと）の考え方は Risks に書く |
| `.kiro/specs/<feature>/` 一式（機能ごとに残り続ける） | `specs/<capability>/spec.md`（正本）＋ `changes/archive/` | Kiro は機能ごとの spec がそのまま残る。ここでは完了した差分を capability ごとの正本へ反映し、変更フォルダは履歴として archive に移す |
| （なし） | `quality.md`（題材・変更） | QA が持つ品質戦略とテスト設計 |
| （なし） | `runbooks/` | Ops が持つ運用の文書 |

要するに、**spec.md は requirements.md ＋ design.md（のうち、その変更に固有の部分）**、**plan.md は tasks.md に Files・Risks・Proof を足したもの** にあたる。

## 2. ロールと持ち主

### ロール

| ロール | 責任 |
| --- | --- |
| PM | 何を、なぜ作るか。要件の最終判断 |
| Dev | どう作るか。設計・実装の最終判断（テックリードを含む） |
| QA | 何をもって正しいとするか。品質の判定 |
| Ops | 本番で動かし続けること。SLO、リリース、障害対応。題材にアプリの基盤があれば、配布型のアプリの審査も担う |
| エージェント | 草案の作成、実装、確認ループの実行、調査。**承認はしない** |

1 人が複数のロールを兼ねてよい。

### 文書の持ち主

持ち主はその文書の変更を承認する。持ち主以外が編集してよいが、持ち主の承認なしにはマージしない。GitHub では `.github/CODEOWNERS` で強制する。

| パス | 持ち主 | 備考 |
| --- | --- | --- |
| `docs/intent.md`、`docs/roadmap.md`、`changes/*/intent.md` | PM | |
| `docs/architecture/`、`docs/decisions/`、`changes/*/plan.md` | Dev | |
| `docs/quality.md`、`changes/*/quality.md` | QA | |
| `docs/runbooks/` | Ops | |
| `changes/*/spec.md` | **PM と QA の両方** | Design 節に大きな変更があれば Dev も |
| `specs/` | Dev | アーカイブの PR でのみ変更する。中身は承認済みの `spec.md` の反映なので、Dev は反映が正しいことだけを確認する |
| `AGENTS.md` | Dev | |

`CODEOWNERS` だけでは「複数ロールの全員の承認」を強制できない。`spec.md` の二重承認は、PR テンプレートのチェック項目と、承認者のロールを確かめる CI で担保する。

### 兼務と自己承認

- **同じ関門で、作成者と承認者は別の人にする。** Dev と QA を兼ねる人が、自分で書いた（またはエージェントに書かせた）`spec.md` を QA として承認してはならない。
- 人数が足りず別の人を立てられない場合は、承認を「AI レビュー＋作成者の承認」で行い、事後に別の人が確認する。事後確認は、Epic の完了時までに行う。
- エージェントが書いたものは「エージェントに指示した人」が書いたものとみなす。
- 個人のリポジトリでの具体的な運用（エージェントの PR は GitHub App から作り、人が承認する。人が自分で作った PR は管理者のバイパスでマージし、事後に確認する）は、[ADR-0004](decisions/0004-agent-prs-via-github-app.md) にある。

### 判断に迷ったときの確認先

実装中に `spec.md` や `plan.md` と合わないことが見つかったら、エージェントは作業を止め、次の相手に確認する。

| 食い違い | 確認先 |
| --- | --- |
| 要件（何を作るか）が現実に合わない、要件どうしが矛盾する | PM |
| 設計・技術的に実現できない、ADR に反する必要がある | Dev（テックリード） |
| 受け入れ基準・決定表・性質をテストとして書けない、判定できない | QA |
| 本番の制約（SLO、リリース手順、インフラ）に合わない | Ops |

## 3. 段と成果物

| 段 | 成果物 | 作り手 | 承認者 | 完了条件 |
| --- | --- | --- | --- | --- |
| Plan | `intent.md` | 起票者（Claude と壁打ちして作る） | PM | 問題・望む結果・制約・未解決の問いが本人の言葉で書かれている |
| Design | `spec.md`（差分）、必要なら ADR と `quality.md` | Claude（起票者が指示） | PM、QA（設計に大きな変更があれば Dev も） | 要件がすべて ID と受け入れ基準を持つ。QA が受け入れ基準・決定表・性質をレビュー済み。条件に当たる変更は `quality.md` がある |
| Build | `plan.md`、コード | Claude（plan mode で計画 → 承認 → 実装） | Dev | 会話を見ていない人でも plan だけで実装できる |
| Test | テスト結果、eval 結果 | Claude（自分で確認ループを回す）、CI | QA | `plan.md` の Proof がすべて満たされている |
| Deploy | PR とレビュー指摘、リリース | Claude（レビュー） | Dev（コードオーナー）、Ops（本番リリース） | `REVIEW.md` の方針で Important の指摘が 0 件。`runbooks/` のリリース手順に従っている |
| Maintain | 新しい `intent.md` | Ops が検知 → Claude が調査 | PM | 指標が許容範囲を外れたら、調査結果が intent として起票される |

変更が完了したら、`spec.md` の差分を `specs/` の正本に反映し、変更フォルダを `changes/archive/` に移す。これを **アーカイブ** と呼ぶ。アーカイブは変更の最後の PR で行う。変更に `quality.md` がある場合、その内容は正本の `specs/` へは反映しない。他の変更でも使える知見だけを、題材の `quality.md` へ反映する。

## 4. 規模に応じた経路

すべての変更に全成果物を求めない。重さは変更の大きさで決める。

| 規模 | 例 | 必要な成果物 |
| --- | --- | --- |
| 軽微 | typo、依存の更新、振る舞いを変えない修正 | PR のみ |
| 小 | 既存の振る舞いのバグ修正 | `plan.md`（Proof に回帰テストを書く） |
| 標準 | Story 1 件の機能追加・変更 | `spec.md` ＋ `plan.md` |
| 大 | 新しい Epic、アーキテクチャに影響する変更 | `intent.md` ＋ `spec.md` ＋ `plan.md` ＋ ADR ＋ `quality.md`。新しい Epic なら `roadmap.md` も更新する |

規模にかかわらず、「変更単位の quality.md を作る条件」に当たる変更には `quality.md` を加える。

## 4.1 ブランチと PR

- トランクベース開発を採る（[ADR-0002](decisions/0002-trunk-based-development.md)）。`main` だけを長く保ち、作業のブランチは 2 日以内を目安にマージする。
- ブランチ名は `<system>/<YYMMDD-slug>` にし、変更フォルダと対応させる。エージェントは、変更ごとに git worktree とブランチを 1 つずつ持つ。
- PR は squash でマージし、merge queue を通す。コミットメッセージは Conventional Commits に従う。
- 題材ごとの CI・デプロイ・リリースの流れは、各題材の `docs/architecture/`（Slack は `delivery.md`）に書く。

Issue・Projects・Actions での回し方（正本の分担、ラベル、項目、自動化）は [project-management.md](project-management.md) にある。

## 5. 粒度

- **Epic** は `roadmap.md` の 1 行。Epic ごとにフォルダは作らない。
- **Story** は `changes/YYMMDD-<slug>/` の 1 フォルダ。1 PR から数セッションで終わる大きさにする。
- **Capability** は `specs/<capability>/` の 1 フォルダ。機能領域ごとの正本で、複数の Story から更新される。

変更がどの Epic に属し、どの状態にあるかは、その変更の `spec.md` の frontmatter（`epic`、`status`）に書く。`roadmap.md` には変更の一覧を持たない。Epic ごとの変更の一覧は、frontmatter から集計して得る。

```sh
grep -l "^epic: E1" systems/slack/docs/changes/*/spec.md
```

## 6. 要件の書き方

### ID

| 種類 | 形式 | 例 |
| --- | --- | --- |
| 要件 | `REQ-<CAP>-NNN` | `REQ-MSG-001` |
| 正しさの性質 | `PROP-<CAP>-NNN` | `PROP-MSG-001` |
| 決定表 | `DT-<CAP>-NNN` | `DT-MSG-001` |
| 非機能要件 | `NFR-NNN` | `NFR-003` |
| ADR | `ADR-NNNN` | `ADR-0001` |

ID は一度振ったら再利用しない。削除した要件の ID は欠番にする。採番の衝突への対処は「衝突の防止」を参照。

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

### 決定表

複数の条件の組み合わせで結果が決まる規則（権限、状態遷移、料金計算など）は、シナリオを並べる代わりに決定表で書く。表にすると、条件の組み合わせの漏れと、条件どうしの優先順位（例：「非メンバー」かつ「本文が不正」のときにどちらのエラーを返すか）が明らかになる。

- 条件の列と結果の列を分け、どちらでもよい条件は `-` と書く。
- 行はすべての組み合わせを覆うようにする。上から順に評価し、最初に一致した行を採用する。
- テストは決定表を `spec.md` から直接読み込む、表駆動テストにする。表をテストコードに書き写すと、仕様とテストがずれるため。

### 使い分け

| 書き方 | 向いているもの | テスト |
| --- | --- | --- |
| シナリオ（Given / When / Then） | 代表的な具体例、ユーザーから見た流れ | 例示テスト |
| 決定表 | 条件の組み合わせで結果が決まる規則 | 表駆動テスト（各行が 1 ケース） |
| 正しさの性質 | どんな入力・順序・並行度でも成り立つべき不変条件 | 性質ベーステスト |

3 つとも「何が正しいか」を定める仕様なので、`spec.md` に書き、アーカイブ時に正本へ反映する。ジェネレーターの設計、試行回数、障害の注入方法といった「どう確かめるか」は、`plan.md` の Proof か、変更単位の `quality.md` に書く。

## 7. 追跡

- `plan.md` のタスクと Proof には、対応する要件 ID を書く。
- テストの名前（`describe` / `it`）には要件・性質・決定表の ID を含める。決定表のテストでは、行番号も含める（例：`DT-MSG-001 #3`）。

  ```ts
  it("REQ-MSG-002: same client_msg_id returns the existing message", ...)
  ```

- CI で、`specs/` と進行中の `changes/` にあるすべての ID（`REQ-*`・`PROP-*`・`DT-*`）がどこかのテストから参照されていることを検査する。

## 8. 衝突の防止

複数の人とエージェントが並行して作業するため、次の 3 種類の衝突を仕組みで防ぐ。

### 8.1 編集の集中

- 多くの人が頻繁に書き換える一覧を、手で管理しない。変更の一覧や状態は、各変更の frontmatter に書き、必要なときに集計する（「粒度」を参照）。
- 題材レベルの文書は、ロールごとに分ける（`quality.md` は QA、`runbooks/` は Ops）。1 つのファイルを複数のロールが日常的に編集する状態を作らない。

### 8.2 採番の衝突

- **変更フォルダ** は連番ではなく `YYMMDD-<slug>` で命名する（例：`260926-post-and-list-messages`）。日付と slug の組が衝突することはまれで、衝突したら slug を変える。
- **要件 ID・ADR 番号** は連番のまま使う。並行するブランチで同じ番号を採番しうるため、CI で `specs/`・進行中の `changes/`・`decisions/` 全体の重複を検査する。重複したら、後からマージする側が採番し直す。

### 8.3 仕様の意味の衝突

2 つの変更が同じ要件を同時に書き換えると、テキストとしては衝突しないまま、後からアーカイブした側が先の変更を上書きしてしまう。

- `MODIFIED` と `REMOVED` には、**変更前の本文**（正本からの写し）を書く。
- アーカイブ時に CI が、変更前の本文と、そのときの正本の本文を比べる。一致しなければ失敗させる（楽観ロック）。失敗したら、最新の正本をもとに差分を書き直し、PM と QA の承認を取り直す。
- 進行中の複数の変更が、同じ ID を `MODIFIED` または `REMOVED` にしていたら、CI で警告する。どちらを先に進めるかは PM が決める。

## 9. 決定の記録（ADR）

- 次のどれかに当たる決定は ADR にする。
  - 後から変えるコストが高いもの
  - 複数の選択肢を比べて選んだもの
  - エージェントが別の選択をしがちなもの
- 形式は `docs/templates/adr.md`（MADR を簡略化したもの）に従う。
- `proposed` の間は、同じ ADR を書き換えて最新化してよい。
- `accepted` になった ADR は書き換えない。方針を変えるときは新しい ADR を書き、古いほうの状態を `superseded by ADR-NNNN` にする。

## 10. 品質

品質に関する記述は、次の 2 層に分ける。

| 層 | 文書 | 持ち主 | 内容 |
| --- | --- | --- | --- |
| 題材 | `docs/quality.md` | QA | 品質戦略、リスク、テストのレベル構成、本番での品質検証、Epic ごとのテスト計画 |
| 変更 | `spec.md` | PM、QA | **何が正しいか**：シナリオ、決定表、正しさの性質 |
| 変更 | `plan.md` の Proof | Dev | **どう証明するか**：要件・性質ごとの証明方法 |
| 変更 | `quality.md`（任意） | QA（草案は Claude） | Proof の表に収まらないテスト設計の詳細 |

### 変更単位の quality.md を作る条件

次のいずれかに当たる変更で作る。当たるかどうかの判断は、Design 段で QA が行う。

- 題材の `quality.md` にあるリスク上位 3 件に触れる
- 新しい種類のテスト基盤（障害注入、負荷生成、新しいテストデータ生成など）が必要になる
- 規模が「大」である

中身は [templates/change-quality.md](templates/change-quality.md) に従う。

- テスト設計の詳細（性質ベーステストのジェネレーター、障害注入のシナリオ、負荷のモデル）。決定表そのものは仕様なので `spec.md` に書く
- テスト環境とテストデータ
- 合否の判定基準
- リリース後に見る品質の指標

### QA の関門

- QA は Design 段の承認者として、`spec.md` の受け入れ基準・決定表・性質と、変更単位の `quality.md` をレビューする（シフトレフト）。
- Test 段では、`plan.md` の Proof と変更単位の `quality.md` の合否基準をもとに判定する。
- 本番での品質検証（シフトライト）の方針は `quality.md` に書き、許容範囲を外れたら Maintain 段で新しい intent を起票する。

## 11. 運用（runbooks）

Ops は題材ごとに `docs/runbooks/` を持つ。

| ファイル | 内容 |
| --- | --- |
| `runbooks/README.md` | SLO と許容範囲、アラートと対応する手順の一覧、リリースとロールバックの方針 |
| `runbooks/<slug>.md` | 個別の手順（アラートへの対応、定期作業、障害訓練）。[templates/runbook.md](templates/runbook.md) に従う |

QA と Ops の境界は次のとおり。

- **Ops**：指標の定義と計測、SLO、アラート、リリース・ロールバックの手順、障害対応。
- **QA**：その指標を使って「品質として許容できるか」を判定する基準。本番での品質検証（合成監視のシナリオ、権限の監査など）の設計。

QA が品質の指標を新しく必要とするときは、`runbooks/README.md` への追加を Ops に依頼する。

## 12. テンプレート

| 成果物 | テンプレート |
| --- | --- |
| `intent.md` | [templates/intent.md](templates/intent.md) |
| `architecture/README.md` | [templates/architecture.md](templates/architecture.md)。領域ごとのファイルは、題材に合わせて自由に分ける |
| `quality.md`（題材） | [templates/quality.md](templates/quality.md) |
| `quality.md`（変更） | [templates/change-quality.md](templates/change-quality.md) |
| `roadmap.md` | [templates/roadmap.md](templates/roadmap.md) |
| `spec.md`（正本・差分） | [templates/spec.md](templates/spec.md) |
| `plan.md` | [templates/plan.md](templates/plan.md) |
| ADR | [templates/adr.md](templates/adr.md) |
| runbook | [templates/runbook.md](templates/runbook.md) |

## 13. 参考

- Anthropic, [The AI-Native SDLC playbook](https://claude.com/blog/the-ai-native-sdlc-playbook)（2026-08-21）
- Kiro, [Specs](https://kiro.dev/docs/specs/) / [Steering](https://kiro.dev/docs/steering/)
- Fission-AI, [OpenSpec](https://github.com/Fission-AI/OpenSpec)
- GitHub, [Spec Kit](https://github.com/github/spec-kit)
- AWS, [AI-DLC workflows](https://github.com/awslabs/aidlc-workflows)
- [MADR](https://adr.github.io/madr/)
- Birgitta Böckeler, [Understanding Spec-Driven-Development: Kiro, spec-kit, and Tessl](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)

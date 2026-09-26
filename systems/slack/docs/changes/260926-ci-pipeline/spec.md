---
capability: delivery
change: 260926-ci-pipeline
issue:
epic: E1
status: approved
---

# Spec: PR の CI、merge queue、仕様の追跡と衝突の検査

## 概要

[delivery.md](../../architecture/delivery.md) の 1 節（変更からマージまで）と 2.1 節（PR の CI）の骨格を作る。対象は次のとおり。

1. `main` のブランチの保護（ruleset）：直接の push の禁止、`CODEOWNERS` の承認、squash だけ、merge queue、必須のチェック
2. PR のタイトルの Conventional Commits の検査
3. pnpm と Turborepo の依存グラフによる、変更のあったパッケージとその依存元だけの実行。必須のチェックを 1 つ（`ci-gate`）にまとめる
4. [process.md](../../../../../docs/process.md) の 7・8 節の検査：ID の追跡、ID と ADR の番号の重複、アーカイブの楽観ロック、ADR の一覧の生成し直し
5. 後の Story が中身を入れる「フック」：マイグレーションの lint、契約のスナップショット、フラグの両方の状態でのテスト、インフラ（[260926-terraform-foundation](../260926-terraform-foundation/spec.md)）
6. 15 分の目標と、その計測

**含めないもの**（境界）：

| もの | 入れる Story |
| --- | --- |
| `main` へのマージ後のビルド（1 回だけ）、ECR への push、SBOM と来歴、dev → staging → prod の昇格 | E7 `blue-green-deploy-pipeline`、`supply-chain-ci`。アプリのデプロイ先（ECS）がまだないため、この変更で作っても検証できない |
| E2E（Playwright）、Web のバンドルの予算と axe | `web-app-shell-routing` 以降、E7 `client-perf-budget-ci`、`a11y-baseline` |
| SAST、依存の脆弱性、秘密情報の検査 | E7 `security-scanning`（ただし、この変更のワークフロー自体の安全性の検査は REQ-DLV-013 で入れる） |
| エージェントの eval | eval の課題集ができたとき（quality.md の 3 節） |
| 夜間の CI（delivery.md の 2.2 節） | E7 |
| `spec.md` の PM・QA の二重承認を CI で確かめること（process.md の 2 節） | Open questions |

上の段は、`ci-gate` の `needs` に足すだけで必須のチェックに加わる形にしておく（Design）。

関係する決定：リポジトリ共通の [ADR-0002](../../../../../docs/decisions/0002-trunk-based-development.md)、[ADR-0008](../../decisions/0008-hono-rpc-for-api-contract.md)、[ADR-0020](../../decisions/0020-infrastructure-as-code-with-terraform.md)、[ADR-0022](../../decisions/0022-zero-downtime-deploy-and-migrations.md)、[ADR-0026](../../decisions/0026-feature-flags.md)。

非機能要件への影響：なし（本番の振る舞いを変えない）。開発の流れの目標（15 分、merge queue の待ち時間）は REQ-DLV-012 で扱う。

## ADDED Requirements

### REQ-DLV-001: main の保護

システムは、`main` への変更を、merge queue を通った PR の squash だけに限らなければならない。具体的には、直接の push、force push、ブランチの削除を拒否し、マージには `CODEOWNERS` の承認 1 件以上と、必須のチェック `ci-gate` の成功を要求しなければならない。バイパスを許す主体は、リポジトリの管理者のロールだけとし、PR を通したマージに限らなければならない（[ADR-0004](../../../../../docs/decisions/0004-agent-prs-via-github-app.md)。バイパスしたマージは REQ-DLV-015 で検出する）。

#### Scenario: 直接の push

- Given リポジトリの管理者の権限を持つ利用者
- When `main` に直接 push する
- Then 拒否される

#### Scenario: CODEOWNERS の承認がない

- Given `ci-gate` が成功し、承認が 0 件の PR
- When merge queue に入れようとする
- Then 入れられない

#### Scenario: squash 以外

- Given 承認済みで `ci-gate` が成功した PR
- When merge commit、または rebase でマージしようとする
- Then その方法は選べない

### REQ-DLV-002: PR のタイトルの形式

PR が作られた・タイトルが変わったとき、システムは、PR のタイトル（squash のコミットメッセージになる）が次の形であることを検査し、違えば失敗しなければならない。

- `<type>(<scope>): <subject>`。`<type>` は `feat`・`fix`・`docs`・`refactor`・`perf`・`test`・`build`・`ci`・`chore`・`revert` のどれか。破壊的変更は `<type>(<scope>)!:` と書ける
- `<scope>` は `systems/` の下のディレクトリ名か `repo`
- タイトルに日本語（ひらがな・カタカナ・漢字）を含まない（コミットメッセージは英語。AGENTS.md）

#### Scenario: 正しいタイトル

- When PR のタイトルが `feat(slack): add message posting API`
- Then 検査は成功する

#### Scenario: scope がない

- When PR のタイトルが `feat: add message posting API`
- Then 検査は失敗し、正しい形の例を示す

#### Scenario: 日本語のタイトル

- When PR のタイトルが `docs(slack): 仕様を追加`
- Then 検査は失敗する

#### Scenario: 存在しない scope

- When PR のタイトルが `fix(discord): ...` で、`systems/discord/` がない
- Then 検査は失敗する

### REQ-DLV-003: 変更に関係する検査だけを実行する

PR の CI と merge queue の CI で、システムは、変更されたファイルから DT-DLV-001 で実行する検査を決め、pnpm のワークスペースの検査は、変更のあったパッケージと、それに（直接・間接に）依存するパッケージだけで実行しなければならない。変更の比較の起点は、PR では PR のベースのコミット、merge queue ではキューのベースのコミットとする。

#### Scenario: 末端のパッケージだけの変更

- Given `apps/api` が `packages/contract` に依存し、`packages/contract` を使うパッケージはほかにない
- When `apps/api/src/app.ts` だけを変える PR
- Then `apps/api` だけで型検査・lint・テストが走り、`packages/contract` のテストは走らない

#### Scenario: 依存されるパッケージの変更

- Given 同じ依存関係
- When `packages/contract/src/messages.ts` を変える PR
- Then `packages/contract` と `apps/api` の両方で検査が走る

#### Scenario: ルートの設定の変更

- When `systems/slack/pnpm-lock.yaml` を変える PR
- Then Slack の全パッケージで検査が走る

#### Scenario: 文書だけの変更

- When `systems/slack/docs/architecture/realtime.md` だけを変える PR
- Then Slack のパッケージの検査は走らず、仕様の検査（REQ-DLV-006〜010）だけが走る

### REQ-DLV-004: 必須のチェックは ci-gate の 1 つ

システムは、PR と merge queue のたびに、変更の内容にかかわらず `ci-gate` を必ず実行し、その結果を DT-DLV-002 で決めなければならない。個々の検査（型検査、テストなど）を、ruleset の必須のチェックに直接登録してはならない。

#### Scenario: 対象外の検査

- Given 文書だけを変える PR（Slack のパッケージの検査は対象外で、実行されない）
- When 仕様の検査が成功する
- Then `ci-gate` は成功し、PR はマージできる

#### Scenario: 1 つの検査の失敗

- Given 結合テストが 1 件失敗した PR
- When `ci-gate` が判定する
- Then `ci-gate` は失敗し、失敗した検査の名前を要約に出す

### REQ-DLV-005: merge queue でもう一度検査する

PR が merge queue に入ったとき、システムは、最新の `main`（とキューの前の PR）と合わせた状態で、PR と同じ検査をもう一度実行し、`ci-gate` が成功したものだけを `main` に入れなければならない。

#### Scenario: 並行する PR の ID の重複

- Given PR A と PR B が、それぞれ別の変更フォルダで `REQ-MSG-007` を ADDED に書き、単独ではどちらも CI が成功している
- When A、B の順に merge queue に入る
- Then A はマージされ、B は merge queue の CI で ID の重複（DT-DLV-004 #2）により失敗し、キューから外される

### REQ-DLV-006: ID の追跡

システムは、`systems/*/docs/specs/` と、アーカイブされていない `systems/*/docs/changes/*/spec.md` に定義されたすべての ID（`REQ-*`・`PROP-*`・`DT-*`）について、テストのファイルから参照されているかを検査し、DT-DLV-003 に従って結果を出さなければならない。

- 「定義」は、`###` の見出しの先頭に ID がある行とする（例：`### REQ-MSG-001: ...`）。
- 「参照」は、テストのファイル（Design の「テストのファイル」）の中に、その ID が単語の境界で現れることとする（`REQ-MSG-001` は `REQ-MSG-0010` に一致しない）。

#### Scenario: 実装済みの要件のテストがない

- Given `specs/messaging/spec.md` に `REQ-MSG-004` が定義され、どのテストのファイルにも `REQ-MSG-004` がない
- When CI が走る
- Then 追跡の検査は失敗し、`REQ-MSG-004` と定義のファイルを示す

#### Scenario: 着手前の変更

- Given `status: draft` の変更に `REQ-DLV-001` が定義され、テストがまだない
- When CI が走る
- Then 追跡の検査は成功し、未参照の ID の一覧を要約に出す

#### Scenario: 実装中の変更

- Given `status: in-progress` の変更の `REQ-MSG-005` がテストから参照されていない
- When CI が走る
- Then 追跡の検査は成功するが、警告として PR にコメントする

### REQ-DLV-007: 定義のない ID への参照

テストのファイル、または `plan.md` が、どこにも定義のない ID を参照している場合、システムは失敗しなければならない。ただし、アーカイブの `REMOVED` に記録された ID を参照するテストは、「削除済みの ID への参照」として失敗させなければならない。

#### Scenario: 打ち間違い

- Given テストの名前が `it("REQ-MSG-02: ...")`
- When CI が走る
- Then 失敗し、ファイルと行と、形式の誤り（3 桁でない）を示す

#### Scenario: plan.md の存在しない ID

- Given `plan.md` の Proof に `REQ-MSG-099` があり、どこにも定義がない
- When CI が走る
- Then 失敗する

### REQ-DLV-008: ID と ADR の番号の重複

システムは、ID の定義を DT-DLV-004 で検査し、失敗の行に当たれば失敗しなければならない。あわせて、次の場合も失敗しなければならない。

- ID の接頭辞（`MSG` など）が、その `spec.md` の frontmatter の `capability` に対応する接頭辞（`specs/README.md` の表）と一致しない
- 同じ `decisions/` のディレクトリの中で、2 つのファイルが同じ番号を持つ。または、ファイル名の番号と見出しの `ADR-NNNN` が一致しない

#### Scenario: 既存の ID の再利用

- Given `specs/messaging/spec.md` に `REQ-MSG-001` がある
- When 新しい変更が `REQ-MSG-001` を ADDED に書く
- Then 失敗し、既存の定義の場所を示す

#### Scenario: 接頭辞の誤り

- Given `capability: infrastructure` の `spec.md`
- When `REQ-DLV-020` を定義する
- Then 失敗する

#### Scenario: ADR の番号の重複

- Given `decisions/0034-a.md` がある
- When 別の PR が `decisions/0034-b.md` を足す
- Then 失敗する

### REQ-DLV-009: アーカイブの楽観ロック

変更のフォルダを `changes/archive/` に移す PR、または `specs/` を変える PR で、システムは DT-DLV-005 の検査を行わなければならない。変更前の本文（`Before`）は、PR の比較の起点のコミット（PR ではベース、merge queue ではキューのベース）にある正本と比べなければならない。

比べるときは、改行を LF にそろえ、行末の空白と、ブロックの末尾の空行だけを取り除く。それ以外の違い（全角と半角、句読点、空行の数）は、違いとして扱う。

#### Scenario: 先の変更が同じ要件を書き換えていた

- Given 正本の `REQ-MSG-004` を、変更 X と変更 Y がどちらも MODIFIED にしている。X が先にアーカイブされ、正本の `REQ-MSG-004` が X の After になった
- When Y をアーカイブする PR を出す
- Then 失敗し、Y の Before と、今の正本の本文の差分を示す

#### Scenario: 正しいアーカイブ

- Given 変更 Z（`status: done`）の MODIFIED の Before が、正本と一致する
- When Z をアーカイブし、正本に After を反映した PR を出す
- Then 検査は成功する

#### Scenario: アーカイブなしの正本の編集

- When 変更フォルダを移さずに `specs/messaging/spec.md` の文言だけを直す PR を出す
- Then 失敗する

### REQ-DLV-010: ADR の一覧の生成し直し

`docs/decisions/` または `systems/*/docs/decisions/` の ADR を変える PR で、システムは、各 `decisions/README.md` の一覧を ADR のファイルの frontmatter（`status`）と見出しから生成し直し、コミットされた一覧と違えば失敗しなければならない。

#### Scenario: 一覧の更新忘れ

- Given ADR-0034 を足し、`README.md` の一覧を更新していない PR
- When CI が走る
- Then 失敗し、生成し直すコマンドを示す

#### Scenario: 状態の変更

- Given ADR-0023 の frontmatter を `status: accepted` に変え、一覧も同じ内容で生成し直した PR
- When CI が走る
- Then 成功する

### REQ-DLV-011: 後の Story の検査のフック

システムは、DT-DLV-001 の「フック」の検査を、Turborepo のタスク（`lint:migrations`、`check:contract`、`test:flags`）として呼び出さなければならない。タスクを定義したパッケージがない場合は、何もせずに成功しなければならない。ただし、DT-DLV-001 で「タスクが必須」とされたパスが変わったのに、対応するタスクを定義したパッケージがない場合は、失敗しなければならない。

#### Scenario: まだ中身のないフック

- Given どのパッケージも `check:contract` を定義していない。`packages/contract/` もない
- When `apps/api` を変える PR
- Then 契約の検査は何もせずに成功する

#### Scenario: マイグレーションがあるのに lint がない

- Given `packages/db/migrations/0002_x.sql` を足す PR。どのパッケージも `lint:migrations` を定義していない
- When CI が走る
- Then 失敗し、「マイグレーションの lint のタスクがない」ことを示す

### REQ-DLV-012: 15 分の目標

システムは、PR の CI（`ci-gate` の完了まで）を 15 分以内に終えることを目標にし、その達成を計測しなければならない。直近 7 日の PR の `ci-gate` の所要時間の p90 が 15 分を超えたとき、システムは Dev のキュー（タイトル `ci-slow` の GitHub の Issue）に、遅いジョブの上位 5 件を含む Issue を作らなければならない。

#### Scenario: 目標の超過

- Given 直近 7 日の `ci-gate` の所要時間の p90 が 18 分
- When 週次の計測が走る
- Then `ci-slow` の Issue が 1 件作られる（開いたものが既にあればコメントする）

#### Scenario: 同じ PR の古い実行

- Given PR に新しいコミットが push された
- When 同じ PR の前の CI が実行中
- Then 前の CI は取り消され、所要時間の計測から除かれる

### REQ-DLV-013: ワークフローの安全性

`.github/workflows/` を変える PR で、システムは次のどれかに当たれば失敗しなければならない。

- actionlint のエラー
- リポジトリの外の Action を、40 桁のコミット SHA 以外（タグ、ブランチ）で参照している
- ワークフローの最上位に `permissions` がない、または `write-all` を使っている
- `pull_request_target` を使っている

#### Scenario: タグでの参照

- When `uses: actions/checkout@v4` を含む PR
- Then 失敗し、SHA で固定するよう示す

#### Scenario: 権限の既定がない

- When 最上位に `permissions` のないワークフローを足す PR
- Then 失敗する

### REQ-DLV-014: ruleset のドリフト

システムは、`main` の ruleset を `.github/rulesets/main.json` として管理し、毎日、GitHub の実際の設定と比べなければならない。違いがあれば、Issue を作らなければならない（開いたものが既にあればコメントする）。

#### Scenario: 画面での変更

- Given 管理者が GitHub の画面で、必須の承認の数を 0 にした
- When 翌日の比較が走る
- Then 違いの項目を含む Issue が作られる


### REQ-DLV-015: バイパスでマージした PR の検出

必須の承認を満たさずに、管理者のバイパスで `main` へマージされた PR があったとき、システムはその PR に `review:post-merge` のラベルを付け、週次のレポートの「事後の確認待ち」に載せなければならない。

#### Scenario: 管理者が自分の PR をバイパスでマージした

- Given `@shoito` が作った PR で、承認が 0 件
- When 管理者のバイパスで merge queue を通してマージする
- Then マージの後 10 分以内に、PR に `review:post-merge` が付く

#### Scenario: App が作った PR を人が承認してマージした

- Given GitHub App が作った PR を、`@shoito` が承認した
- When マージする
- Then `review:post-merge` は付かない

## Decision Tables

### DT-DLV-001: 変更されたパスと実行する検査

変更されたファイルごとに、上から順に評価し、最初に一致した行を採用する。PR で実行する検査は、ファイルごとの結果の和集合とする。「仕様の検査」（REQ-DLV-006〜010）と「タイトル」（REQ-DLV-002）は、この表にかかわらず毎回実行する。パスはリポジトリのルートからの相対パス。

| # | 変更されたパス | → Slack のパッケージの検査 | → フック | → そのほか |
| --- | --- | --- | --- | --- |
| 1 | `.github/workflows/**`、`.github/actions/**` | 全パッケージ | 全フック（全パッケージ） | ワークフローの安全性（REQ-DLV-013）。`infra-*.yml` ならインフラ（全ルートモジュール） |
| 2 | `.github/rulesets/**` | なし | なし | ruleset の JSON の検査 |
| 3 | `systems/slack/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml,turbo.json,tsconfig.base.json}` | 全パッケージ | 全フック（全パッケージ） | なし |
| 4 | `systems/slack/packages/db/migrations/**` | 変更のあったパッケージとその依存元 | `lint:migrations`（**タスクが必須**） | なし |
| 5 | `systems/slack/packages/{contract,api-client}/**` | 変更のあったパッケージとその依存元 | `check:contract`（**タスクが必須**） | なし |
| 6 | `systems/slack/{apps,packages}/**` | 変更のあったパッケージとその依存元 | 変更のあったパッケージとその依存元で、定義されているフック | なし |
| 7 | `systems/slack/infra/**` | なし | なし | インフラ（DT-INFRA-006） |
| 8 | `tools/**` | なし | なし | `tools/` のテスト |
| 9 | `AGENTS.md`、`systems/*/AGENTS.md`、`.claude/**` | なし | なし | エージェントの eval（フック。中身ができるまでは何もせずに成功） |
| 10 | それ以外（`docs/**`、`systems/*/docs/**` など） | なし | なし | なし |

- 「Slack のパッケージの検査」は、静的検査（型検査、lint、フォーマット）、単体・性質・表駆動のテスト、結合テストを指す。
- `test:flags` はタスクが必須ではない。フラグの両方の状態のテストが必須になる条件は、`feature-flags-appconfig` で MODIFIED として足す。

### DT-DLV-002: ci-gate の判定

`ci-gate` が依存する各ジョブの結果（`success`・`skipped`・`failure`・`cancelled`）と、そのジョブが DT-DLV-001 で対象になったかで判定する。上から順に評価し、最初に一致した行を採用する。

| # | 対象のジョブに `failure` がある | 対象のジョブに `cancelled` がある | 対象のジョブが `skipped` | 対象外のジョブが `success` 以外 | → `ci-gate` |
| --- | --- | --- | --- | --- | --- |
| 1 | はい | - | - | - | 失敗 |
| 2 | いいえ | はい | - | - | 失敗 |
| 3 | いいえ | いいえ | はい | - | 失敗（対象なのに実行されていない） |
| 4 | いいえ | いいえ | いいえ | - | 成功 |

- 「対象のジョブ」は、DT-DLV-001 で実行すると決まったジョブ。「対象外のジョブ」は `skipped` になるのが正しい。対象外のジョブの結果は判定に使わない（4 行）。
- 対象を決めるジョブ（`changes`）自体が失敗したら、すべてのジョブを対象として扱う（1 行か 3 行に当たる）。

### DT-DLV-003: ID の追跡の結果

ID ごとに評価する。上から順に評価し、最初に一致した行を採用する。1 件でも「失敗」があれば、検査は失敗する。

| # | 定義の場所 | 変更の `status` | テストからの参照 | → 結果 |
| --- | --- | --- | --- | --- |
| 1 | 変更の `REMOVED` | - | - | 対象外 |
| 2 | `specs/` | - | あり | 成功 |
| 3 | `specs/` | - | なし | 失敗 |
| 4 | 変更の `ADDED`・`MODIFIED` | `draft`・`approved` | - | 対象外（未参照の一覧を要約に出す） |
| 5 | 変更の `ADDED`・`MODIFIED` | `in-progress` | あり | 成功 |
| 6 | 変更の `ADDED`・`MODIFIED` | `in-progress` | なし | 警告（PR にコメント） |
| 7 | 変更の `ADDED`・`MODIFIED` | `done` | あり | 成功 |
| 8 | 変更の `ADDED`・`MODIFIED` | `done` | なし | 失敗 |
| 9 | 変更の `ADDED`・`MODIFIED` | 上記以外（不明な値、frontmatter がない） | - | 失敗 |

### DT-DLV-004: ID の定義の衝突

ID ごとに、`specs/` での定義の数（S）、アーカイブされていない変更の `ADDED` での定義の数（A）、同じく `MODIFIED`・`REMOVED` での参照の数（M）、アーカイブの `REMOVED` の記録の有無（R）を数える。上から順に評価し、最初に一致した行を採用する。

| # | S | A | M | R | → 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2 以上 | - | - | - | 失敗（正本の中での重複） |
| 2 | - | 2 以上 | - | - | 失敗（2 つの変更が同じ ID を追加） |
| 3 | 1 | 1 | - | - | 失敗（既存の ID の再利用） |
| 4 | - | 1 | - | あり | 失敗（欠番の再利用） |
| 5 | 0 | - | 1 以上 | - | 失敗（正本にない ID の変更・削除） |
| 6 | 1 | 0 | 2 以上 | - | 警告（複数の変更が同じ ID を変更。どちらを先に進めるかは PM が決める） |
| 7 | - | - | - | - | 成功 |

- 同じ変更の `spec.md` の中で、同じ ID の見出しが 2 回あれば、A または M を 2 と数える。

### DT-DLV-005: アーカイブの検査

PR ごとに評価する。上から順に評価し、最初に一致した行を採用する。

| # | `specs/` の変更 | 変更フォルダの `changes/archive/` への移動 | 移動した変更の `status` | `MODIFIED`・`REMOVED` の Before が、起点の正本と一致 | 正本の変更が、移動した変更の内容と一致（下記） | → 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | なし | なし | - | - | - | 対象外 |
| 2 | あり | なし | - | - | - | 失敗（アーカイブ以外での正本の編集） |
| 3 | - | あり | `done` 以外 | - | - | 失敗 |
| 4 | - | あり | `done` | いいえ（1 件でも） | - | 失敗（楽観ロック） |
| 5 | - | あり | `done` | はい | いいえ | 失敗（反映の誤り） |
| 6 | - | あり | `done` | はい | はい | 成功 |

「正本の変更が、移動した変更の内容と一致」は、次のすべてが成り立つこととする。

- `ADDED` の各 ID について、PR の後の正本のブロックが、`ADDED` の本文と一致する
- `MODIFIED` の各 ID について、PR の後の正本のブロックが、After と一致する
- `REMOVED` の各 ID が、PR の後の正本にない
- 移動した変更に現れない ID のブロックは、起点と PR の後で変わらない

「ブロック」は、ID の見出しから、次の同じ深さか浅い見出しの直前までとする。比べ方は REQ-DLV-009 の正規化に従う。

## Correctness Properties

### PROP-DLV-001: 影響を受けるパッケージを取りこぼさない

任意のワークスペースの依存グラフ（循環なし）と、任意の変更されたファイルの集合に対して、検査を実行するパッケージの集合は、「変更されたファイルを含むパッケージと、それに推移的に依存するすべてのパッケージ」を含む。DT-DLV-001 の 1・3 行に当たるファイルが含まれるときは、全パッケージである。

### PROP-DLV-002: 追跡の検査は、未参照の ID をちょうど報告する

任意の `spec.md` の集合（ID の定義と `status` を任意に含む）と、任意のテストのファイルの集合に対して、追跡の検査が失敗・警告として報告する ID の集合は、DT-DLV-003 で「失敗」「警告」になる ID の集合と一致する（過不足がない）。

### PROP-DLV-003: 重複の検査は、衝突をちょうど報告する

任意の `specs/`・変更・アーカイブの内容に対して、重複の検査が失敗として報告する ID の集合は、DT-DLV-004 の 1〜5 行に当たる ID の集合と一致する。検査の結果は、ファイルを読む順序によらない。

### PROP-DLV-004: 楽観ロックは、先の変更の上書きを通さない

任意の正本と、同じ ID を `MODIFIED` にする任意の 2 つの変更 X・Y に対して、X をアーカイブした後の正本を起点にすると、X の After と Y の Before が（正規化の後で）異なる限り、Y のアーカイブの検査は失敗する。

## Design

### 置き場所

| もの | パス（リポジトリのルートから） | 理由 |
| --- | --- | --- |
| ワークフロー | `.github/workflows/ci.yml`、`title.yml`、`ruleset-drift.yml`、`ci-duration.yml` | GitHub の規則 |
| ruleset | `.github/rulesets/main.json` | REQ-DLV-014 |
| 仕様の検査 | `tools/spec-checks/`（TypeScript、Vitest、pnpm の独立したパッケージ） | 検査の対象がリポジトリ全体（`docs/decisions/` と全題材）なので、題材の外に置く |
| Slack のワークスペース | `systems/slack/package.json`、`pnpm-workspace.yaml`、`turbo.json` | pnpm と Turborepo の設定。パッケージの中身は各 Story が作る |

### ci.yml のジョブ

```
changes ─┬─▶ slack-static ─┐
         ├─▶ slack-test ───┤
         ├─▶ slack-integration ┤
         ├─▶ slack-hooks（lint:migrations / check:contract / test:flags）┤
         ├─▶ infra（uses: ./.github/workflows/infra-pr.yml）┤
         ├─▶ workflow-lint ┤
         ├─▶ tools-test ───┤
         └─▶ spec-checks（常に）┤
                               ▼
                           ci-gate（if: always()）
```

- トリガーは `pull_request` と `merge_group`。`concurrency` を PR ごとにし、古い実行を取り消す（REQ-DLV-012）。
- `changes` は、DT-DLV-001 を実装した `tools/spec-checks/src/changes.ts` で、対象のジョブの一覧を出力する。起点は、`pull_request` なら `github.event.pull_request.base.sha`、`merge_group` なら `github.event.merge_group.base_sha`。
- Slack の各ジョブは `turbo run <tasks> --affected` を使い、`TURBO_SCM_BASE` に起点を渡す。Turborepo の `--affected` と `TURBO_SCM_BASE` の挙動（どの版から使えるか、グローバルな依存の扱い）は **未検証**。使えなければ、`turbo run --filter=...[<base>]` で同じことをする。
- キャッシュは、pnpm のストアと Turborepo のローカルのキャッシュを `actions/cache` で持つ。Turborepo のリモートキャッシュ（外部のサービス）は使わない（ビルドの成果物を社外に置かないため）。
- 結合テストは、GitHub のホスト型ランナーの Docker で Testcontainers を動かす。
- PR のタイトルの検査は、タイトルの編集でも走るよう `title.yml`（`pull_request` の `opened`・`edited`・`synchronize`）に分ける。merge queue では、`ci.yml` の `spec-checks` の中で、キューの PR 番号から PR のタイトルを API で読み直して同じ検査をする（merge queue のコミットメッセージが PR のタイトルになることは **未検証**）。
- ワークフローの権限は、最上位で `contents: read`。PR にコメントするジョブだけ `pull-requests: write`、Issue を作るジョブだけ `issues: write`、infra のジョブだけ `id-token: write`。
- この変更が作る Issue（REQ-DLV-012・014）のラベルは、[project-management.md](../../../../../docs/project-management.md) の 3・5 節に合わせる：Issue type は Task、ラベルは `area:delivery`・`source:alert`。`ci-slow` は `needs:dev`、ruleset のドリフトは `needs:ops`。

### ruleset（`.github/rulesets/main.json`）

| 規則 | 値 |
| --- | --- |
| 対象 | `main`（既定のブランチ） |
| バイパス | リポジトリの管理者のロールだけ（PR を通したマージに限る）。バイパスでマージした PR は REQ-DLV-015 で検出する（[ADR-0004](../../../../../docs/decisions/0004-agent-prs-via-github-app.md)） |
| 削除の制限、force push の禁止 | 有効 |
| PR の必須 | 有効。承認 1 件、`CODEOWNERS` の承認必須、push の後の承認の取り消し、会話の解決必須 |
| 許可するマージの方法 | squash のみ |
| 必須のチェック | `ci-gate`（GitHub Actions からのもの） |
| merge queue | 有効。squash、ビルドの同時実行 5、グループの大きさ 1〜5、チェックの待ち時間 30 分 |

ruleset の merge queue の規則の各項目の名前と値の範囲は **未検証**（GitHub の REST API の `rules` の `merge_queue` の型で確かめる）。

### テストのファイル（REQ-DLV-006 の「参照」を探す範囲）

`tools/spec-checks/config.json` に glob で持つ。初期値：

- `systems/*/{apps,packages}/**/*.{test,spec}.{ts,tsx}`、`systems/*/{apps,packages}/**/test/**/*.ts`
- `systems/*/e2e/**/*.ts`
- `systems/*/infra/**/*.tftest.hcl`、`systems/*/infra/**/*_test.rego`、`systems/*/infra/{tools,test}/**/*.test.ts`
- `tools/**/*.test.ts`

決定表の行ごとの網羅は、表駆動テストが `spec.md` から表を読み込んで各行を 1 ケースにすることで担保する（process.md の 6 節）。この検査は ID の単位で見る。

### ADR の一覧

- 各 `decisions/README.md` の一覧の表を、`<!-- adr-index:start -->` と `<!-- adr-index:end -->` で囲む。表の外の文章は生成しない。
- 列は、今の Slack の一覧に合わせて「ADR（ファイルへのリンク）」「決定（見出しから `ADR-NNNN: ` を除いたもの）」「状態（frontmatter の `status`）」。
- 生成は `pnpm --dir tools/spec-checks gen:adr-index`、検査は同じコマンドの `--check`。

## Open questions

- **1 人のリポジトリでの承認**：[ADR-0004](../../../../../docs/decisions/0004-agent-prs-via-github-app.md) で決めた。エージェントの PR は GitHub App から作り、`@shoito` が承認する。人が自分で作った PR は、管理者のバイパスでマージし、REQ-DLV-015 で検出して事後に確認する。
- **`spec.md` の二重承認の CI**：process.md の 2 節は「承認者のロールを確かめる CI」を求めているが、ロールとアカウントの対応の置き場所がない。この変更の範囲外にした。いつ、どの Story で入れるか（PM、QA）。
- **検査の道具をどこに置くか**：`tools/spec-checks/` をリポジトリのルートに置き、正本は Slack の `delivery` の capability に置いた。題材が増えたら、正本をリポジトリ共通に移すか（Dev）。
- **in-progress の変更の未参照を警告にとどめる**（DT-DLV-003 #6）。複数の PR に分けて実装する間に失敗させないためだが、`done` に変える PR で初めて失敗が出る。`plan.md` の Order of work の完了（チェックボックス）と突き合わせて、完了したタスクの ID だけを必須にするか（QA）。
- **ブランチ名**（`<system>/<YYMMDD-slug>`、ADR-0002）を検査するか。今は要件にしていない（Dev）。

## 決定（2026-09-26、PM・QA、既定案）

上の Open questions は、次のとおり決めた。

- `spec.md` の二重承認を確かめる CI は、Organization のチーム（`pm`・`qa`）と対応づけられる `github-project-setup` の後に、別の変更で入れる。それまでは PR テンプレートのチェック項目で確かめる。
- 検査の道具は `tools/spec-checks/` に置く。正本は、題材が 2 つになった時点でリポジトリ共通へ移す。
- `in-progress` の変更の未参照の ID は、警告にとどめる（DT-DLV-003 #6）。`done` にする PR で失敗させる。
- ブランチ名（`<system>/<YYMMDD-slug>`）は検査するが、失敗させずに警告にとどめる。

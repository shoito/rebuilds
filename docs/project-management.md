# プロジェクト管理（GitHub Projects）

[process.md](process.md) の段と成果物を、GitHub の Issue・Projects・Actions でどう回すか。主に、題材ごとの開発リポジトリに適用する（[ADR-0005](decisions/0005-design-record-repository.md)）。方針は [ADR-0003](decisions/0003-github-projects-for-planning.md) にある。

## 1. 正本の分担

同じ情報を 2 か所で手で管理しない（process.md の「衝突の防止」）。

| 情報 | 正本 | もう一方での扱い |
| --- | --- | --- |
| 仕様の中身（要件、決定表、性質、設計） | リポジトリ（`spec.md`、`architecture/`、ADR） | Issue には書かない。リンクだけ |
| 変更の状態（draft / approved / in-progress / done） | `spec.md` の frontmatter の `status` | Projects の **Stage** に Actions が写す |
| 承認（PM・QA・Dev・Ops） | PR のレビュー（`CODEOWNERS`） | Projects には写さない |
| 計画の属性（優先度、イテレーション、担当、期日、見積もり） | Projects | リポジトリには書かない |
| Epic と Story の階層 | Issue（親子） | `roadmap.md` には Epic の一覧と目的だけを残す |
| 議論、質問、判断の依頼 | Issue のコメント | 決まったことは、リポジトリの文書か ADR に書き戻す |
| リリースの進み具合（フラグの段階） | AppConfig | Projects の **Rollout** に Actions が写す |

## 2. 前提：アカウントの種類

- **題材ごとの開発リポジトリと Project は、GitHub の Organization の下に作る**（[ADR-0005](decisions/0005-design-record-repository.md)）。設計の記録の `shoito/rebuilds` は個人のリポジトリのまま置き、Organization へは移さない。この文書は、Organization に作る開発リポジトリを前提に書く。
- Organization を前提にする理由は 2 つある。
  - GitHub App は、個人アカウントの Projects を操作できない。fine-grained PAT も、個人アカウントの Projects に対応していない。個人アカウントのまま自動化するには、権限の広い classic PAT が要る（[community #156512](https://github.com/orgs/community/discussions/156512)）。
  - Issue types は、Organization でしか使えない。
- Issue の種類は Issue types で、親子は Sub-issues で表す。Projects では、組み込みの Type・Parent issue・Sub-issues progress の項目を使う。
- Organization の下に開発リポジトリを作るまでは、Projects の自動化を動かさない（設定の実装は、開発リポジトリを作った後に行う）。

## 3. Issue の種類

| 種類（Issue type） | 対応する成果物 | 親 | 作る人 | 閉じる条件 |
| --- | --- | --- | --- | --- |
| Intent | 起票時は Issue だけ。受理されたら `intent.md` か Epic・Story になる | なし | 誰でも（Maintain 段では Claude） | PM が受理（→ Epic か Story を作ってリンク）または却下 |
| Epic | `roadmap.md` の 1 行 | なし | PM | 子の Story がすべて閉じた |
| Story | `changes/YYMMDD-<slug>/` の 1 フォルダ | Epic | PM、Dev | 変更がアーカイブされた（`status: done`） |
| Bug | 規模「小」の `plan.md`（回帰テストを含む） | Epic（任意） | 誰でも | 修正がマージされた |
| Task | 成果物なし（規模「軽微」、運用の作業） | 任意 | 誰でも | 作業が終わった |
| Spike | 調査の結果（ADR の草案や、`intent.md` の Open questions への答え） | 任意 | Dev、QA | 結果を文書に書き戻した |

- Story と変更フォルダは 1 対 1 にする。変更の `spec.md` の frontmatter に `issue: <番号>` を書き、Issue の本文には変更フォルダへのリンクを書く。
- ADR には専用の Issue を作らない。ADR は PR で起票し、議論も PR で行う。

## 4. Issue のテンプレート（Issue Forms）

`.github/ISSUE_TEMPLATE/` に、種類ごとのフォームを置く。フォームで Issue type を自動で設定する。

| フォーム | 主な入力 |
| --- | --- |
| Intent | 題材（選択）、Problem、Proposed outcome、Affected users and systems、Constraints、Open questions（`intent.md` のテンプレートと同じ見出し） |
| Story | 題材、親の Epic、規模（軽微 / 小 / 標準 / 大）、概要、使うフラグの見込み |
| Bug | 題材、再現の手順、期待した振る舞い、実際の振る舞い、変えてはいけない振る舞い（Kiro の Unchanged Behavior）、関連する要件の ID |
| Spike | 問い、期限、結果を書き戻す文書 |

Epic は PM が roadmap の更新と一緒に作るので、フォームは置かない。

## 5. ラベル

ラベルは、Projects の項目にできない横断的な印だけに絞る。定義は `.github/labels.yml` に置き、Actions で同期する（手で作らない）。

| 接頭辞 | 値 | 用途 |
| --- | --- | --- |
| `system:` | `slack`、将来の題材 | 題材。フォームで付ける |
| `area:` | `identity`、`realtime`、`messaging`、`notifications`、`search`、`files`、`client`、`platform`、`mcp`、`infra`、`delivery`、`security` | 領域。`architecture/` の文書と対応させる |
| `needs:` | `pm`、`dev`、`qa`、`ops` | そのロールの判断が要る。process.md の「判断に迷ったときの確認先」と同じ区分。判断が済んだら外す |
| `risk:` | `high` | 変更単位の `quality.md` が要る（process.md の条件） |
| `agent:` | `ready`、`working`、`blocked` | エージェントに任せてよい / 作業中 / 人間の判断待ち（8 節） |
| `source:` | `incident`、`alert`、`security` | Maintain 段で自動で起票されたもの |
| `review:` | `post-merge` | 管理者のバイパスでマージされ、事後の確認を待っている PR（[ADR-0004](decisions/0004-agent-prs-via-github-app.md)） |

優先度・規模・状態はラベルにせず、Projects の項目で持つ。ラベルと項目の二重管理を避けるため。

## 6. Projects の項目（Fields）

1 つの Project（`rebuilds`）に、全題材の Issue と PR を集める。題材ごとの表示は、ビューの絞り込みで作る。

| 項目 | 種類 | 値 | 誰が変えるか |
| --- | --- | --- | --- |
| Status | 単一選択 | `Inbox` / `Backlog` / `Ready` / `In progress` / `In review` / `Blocked` / `Done` | 人（担当）。一部は組み込みのワークフロー（7.1 節） |
| Stage | 単一選択 | `Plan` / `Design` / `Build` / `Test` / `Deploy` / `Release` / `Maintain` | **Actions だけ**（`spec.md` の `status`、PR の状態、フラグの段階から写す） |
| System | 単一選択 | `slack` など | Actions（`system:` ラベルから） |
| Priority | 単一選択 | `P0` / `P1` / `P2` / `P3` | PM |
| Size | 単一選択 | `軽微` / `小` / `標準` / `大`（process.md の規模） | Story の作成者。Design の承認時に PM と Dev が確かめる |
| Estimate | 数値 | 見込みのセッション数（エージェントの作業の単位） | Dev |
| Iteration | イテレーション | 1 週間 | PM |
| Scale stage | 単一選択 | `S1` / `S2` / `S3` | PM（その Story が必要になる規模の段階） |
| Change | テキスト | `YYMMDD-<slug>` | Actions（変更フォルダの作成時） |
| Flag | テキスト | `release.<名前>` など | Actions（`plan.md` から） |
| Rollout | 単一選択 | `Off` / `Internal` / `5%` / `25%` / `100%` / `Removed` | Actions（AppConfig の変更から） |
| Target date | 日付 | — | PM（外部への約束があるものだけ） |
| Parent issue・Sub-issues progress | 組み込み | — | GitHub（使えれば） |

### 6.1 Status と Stage を分ける理由

- **Status** は「いま誰かが手を動かしているか」を表す。人が変える。
- **Stage** は「process.md のどの段にいるか」を表す。成果物から決まるので、Actions だけが変える。

こう分けると、人が Stage を書き換えて成果物と食い違うことがない。

### 6.2 Stage の決め方

| 条件 | Stage |
| --- | --- |
| Type が Intent で、受理される前 | `Plan` |
| Story で、変更フォルダがない、または `spec.md` が `draft` | `Design` |
| `spec.md` が `approved`、または `in-progress` | `Build` |
| Build の PR がすべてマージされ、staging で QA の受け入れを待っている | `Test` |
| prod へのデプロイを待っている、またはデプロイ中 | `Deploy` |
| フラグが `Internal`〜`100%` の途中 | `Release` |
| `spec.md` が `done`（アーカイブ済み）で、フラグが `Removed` かフラグなし | `Maintain`（Status は `Done`） |

## 7. 自動化

### 7.1 Projects の組み込みのワークフロー

| ワークフロー | 設定 |
| --- | --- |
| Auto-add | このリポジトリの Issue と PR を、Project に自動で加える |
| Item added | Status を `Inbox` にする |
| Item closed | Status を `Done` にする |
| Pull request merged | Status を `Done` にする（PR の項目） |
| Auto-archive | `Done` のまま 30 日たった項目を、ビューから外す |

### 7.2 GitHub Actions

| ワークフロー | きっかけ | すること |
| --- | --- | --- |
| `labels-sync` | `.github/labels.yml` の変更 | ラベルを定義に合わせる（ないものは作り、定義にないものは警告する） |
| `project-fields-sync` | Issue・PR の作成と更新、ラベルの変更 | `system:` のラベルから System を写す。種類は Issue type（組み込みの Type の項目）をそのまま使う。Story の Size が空なら `needs:pm` を付ける |
| `change-link` | 変更フォルダを追加・変更する PR | `spec.md` の frontmatter の `issue` を読み、Issue と PR をつなぐ。Change と Flag の項目を設定する。`issue` がない、または種類が Story でなければ失敗させる |
| `stage-sync` | `main` への push（`spec.md` の変更）、PR の状態の変化、デプロイの完了 | 6.2 節の規則で Stage を設定する |
| `rollout-sync` | AppConfig のデプロイの完了（EventBridge → `repository_dispatch`） | そのフラグを使う Story の Rollout を更新する。100% で 2 週間たったら、フラグの削除のタスクを起票する |
| `intent-from-incident` | インシデントの振り返りの PR のマージ、または監視からの `repository_dispatch` | Type が Intent で、`source:*` の付いた Issue を起票する（Maintain 段）。本文は Claude が調査結果から書く |
| `agent-dispatch` | `agent:ready` のラベルが付いた | Claude Code の GitHub Action で、Story の変更フォルダの草案か、実装の PR を作らせる（8 節） |
| `weekly-report` | 毎週月曜 | DORA の 4 指標（[delivery.md](../systems/slack/docs/architecture/delivery.md) の 7 節）、Stage ごとの滞留、7 日を超えたブランチ、期限切れのフラグ、`needs:*` の一覧を、Issue に投稿する |

- Projects の API（GraphQL）を呼ぶワークフローは、GitHub App のインストールのトークンで動かす。`GITHUB_TOKEN` では Organization の Project を更新できないため。App には Organization の Projects の読み書きの権限を付ける。
- ワークフローの定義は、他のコードと同じく PR でレビューする。`uses:` のアクションは、コミットの SHA で固定する（[security.md](../systems/slack/docs/architecture/security.md) の 8 節）。

## 8. AI エージェントの関わり方

| 場面 | エージェントがすること | しないこと |
| --- | --- | --- |
| Plan | Intent の Issue の壁打ちの相手。`intent.md` の草案を PR で出す | 受理・却下 |
| Design | `agent:ready` の Story について、変更フォルダ（`spec.md`・`plan.md`）の草案の PR を作る | `status: approved` への変更、承認 |
| Build | 承認済みの Story について、`plan.md` の順に実装の PR を作る。ブランチは `<system>/<YYMMDD-slug>`、worktree を分ける | マージ |
| 判断が要るとき | 作業を止め、`agent:blocked` と `needs:<ロール>` を付け、Issue に問いを書く | 自分で仕様を書き換えて進める |
| Maintain | 監視やインシデントから、Intent の Issue を起票する | 優先度を決める |

- エージェントは GitHub App のトークンで push し、PR を作る。App はレビューの承認とマージができない（[ADR-0004](decisions/0004-agent-prs-via-github-app.md)）。
- `agent:ready` を付けてよいのは、PM か Dev だけにする（ラベルを付けた人を Actions で確かめる）。
- エージェントが作った PR には `agent` の印（PR の作成者か、ラベル）が付き、DORA の指標とは別に「差し戻しなしでマージされた割合」を集計する（delivery.md の 7 節）。

## 9. ビュー

| ビュー | 形 | 絞り込み・並べ方 | 主に見る人 |
| --- | --- | --- | --- |
| 今週 | ボード（Status） | 今のイテレーション | 全員 |
| 段の流れ | ボード（Stage） | Type が Story、題材ごと | PM、Dev |
| Epic | 表 | Parent issue でまとめ、Sub-issues progress を出す | PM |
| ロードマップ | ロードマップ | Iteration と Target date、Epic ごと | PM |
| 判断待ち | 表 | `needs:*` があるもの、ロールでまとめる | 各ロール |
| エージェント | ボード | `agent:*` でまとめる | Dev |
| リリース | 表 | Stage が `Release`、Rollout でまとめる | PM、Ops |
| Maintain からの起票 | 表 | `source:*` | PM、Ops |

## 10. 流れの例（Story 1 件）

1. PM が Story の Issue を作る（フォーム）。親の Epic、Size、Priority、Iteration を決める。→ Stage `Design`
2. Dev が `agent:ready` を付ける。エージェントが変更フォルダの草案の PR を出す（frontmatter に `issue`）。→ `change-link` が Change と Flag を設定する
3. PM・QA が PR をレビューし、`status: approved` にしてマージする。→ Stage `Build`
4. エージェントが実装の PR を順に出し、Dev がレビューしてマージする。
5. staging で QA が受け入れる。→ Stage `Test` → Ops の承認でデプロイ → Stage `Deploy`
6. PM がフラグを広げる。→ `rollout-sync` が Rollout を更新 → Stage `Release`
7. 最後の PR で差分を正本へ反映し、アーカイブする（`status: done`）。フラグを消したら → Stage `Maintain`、Issue を閉じる → Status `Done`

## 11. 既存の文書への影響

- `roadmap.md` の Story の表は、Project の運用を始めたら Issue に移し、表を消して Project のビューへのリンクに置き換える。Epic の一覧と目的は `roadmap.md` に残す。
- `spec.md` のテンプレートの frontmatter に `issue` を加える（済み）。
- 設定の実装（ラベル、Issue Forms、ワークフロー、Project の作成）は、E1 の Story `github-project-setup` として起票する。

# Pull Requests: GitHub

Pull Request（以下 PR）、差分、マージ可能かの計算、レビュー、CODEOWNERS、ruleset、マージの方式、merge queue、自動マージ。本家 GitHub の振る舞いに寄せ、確かめた出典を各節に示す。確かめられなかったものは「未検証」と書く。

前提として、次の決定に従う。

| 決定 | PR への影響 |
| --- | --- |
| [ADR-0002](../decisions/0002-repository-permission-model.md) | PR の読み書き、レビュー、マージは、すべて `can(actor, action, resource)` を通す。fork をまたぐ PR では、base と head の両方のリポジトリを判定する |
| [ADR-0003](../decisions/0003-replicated-git-storage.md)、[ADR-0006](../decisions/0006-ref-update-consensus.md) | マージによる base の ref の更新も、push と同じく複製の合意を経てから成功とする |
| [ADR-0005](../decisions/0005-git-as-source-of-truth.md) | PR の head・base の SHA の DB の値は写し。push の Event を受けて、非同期に更新する |
| [ADR-0010](../decisions/0010-server-side-merge-and-diff.md) | 差分とマージは、ストレージの RPC で作業ツリーなしに計算し、SHA の組でキャッシュする |
| [ADR-0011](../decisions/0011-rulesets-as-single-protection-model.md) | ブランチの保護は ruleset に一本化し、1 つの評価関数で判定する |
| [ADR-0012](../decisions/0012-merge-queue-with-speculative-groups.md) | merge queue は、投機的なグループの ref を作り、検査を通ったものだけを取り込む |

## 1. PR のモデル

### 1.1 base と head

PR は「head の ref の変更を、base の ref に取り込む提案」である。

| 項目 | 内容 |
| --- | --- |
| `repo_id`（base のリポジトリ）、`base_ref` | 取り込み先。PR はこのリポジトリに属する（番号・権限・通知の単位）。API の `base.repo` |
| `head_repo_id`、`head_ref` | 取り込む元。同じリポジトリか、同じ fork のネットワークのリポジトリ |
| `base_sha`、`head_sha` | 最後に観測した SHA の写し（ADR-0005）。正本は Git の ref |
| `merge_base_sha` | `base_sha` と `head_sha` の merge base。差分の起点 |
| `number` | リポジトリの中で Issue と共有する連番（[issues.md](issues.md)） |
| `state` | `open`・`closed`・`merged`。`draft` は `open` の中のフラグ |
| `maintainer_can_modify` | fork からの PR で、base の書き込み権限を持つ人が head に push してよいか |

- **差分は三点（three-dot）で見せる。** `merge_base..head` の差分で、「PR が持ち込む変更」を表す。base が進んでも、PR の差分は変わらない。本家と同じ（[About comparing branches in pull requests](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/about-comparing-branches-in-pull-requests)）。
- **PR ごとに 2 つの ref を base のリポジトリに持つ。**
  - `refs/pull/{number}/head`：head の最新のコミット。head のリポジトリ（fork）が消されても、PR の履歴を読めるようにする。
  - `refs/pull/{number}/merge`：マージを試した結果のコミット（テストマージ）。マージできないときは作らない。base にも head にも入らない。本家の REST API の説明と同じ（[REST API: pulls](https://docs.github.com/en/rest/pulls/pulls)）。
  - どちらも利用者は push できない。ruleset の評価より前に、Git のフロントエンドが `refs/pull/` への push を拒否する。

### 1.2 fork をまたぐ PR

- head のリポジトリは、base と同じ fork のネットワークに属していなければならない。ネットワークはオブジェクトを共有するので（[git-storage.md](git-storage.md)）、head のコミットを base 側へ転送しなくても、ストレージの RPC で差分とマージを計算できる。
- PR を作れるのは、head のリポジトリを読めて、base のリポジトリを読める人。base に書き込み権限は要らない。
- head への書き込み（提案の適用、「ブランチの更新」）は、head のリポジトリの書き込み権限が要る。base の保守者は、`maintainer_can_modify` が真のときだけ head に書ける。
- **非公開の fork からの PR の head は、base を読める人にも見える。** 本家と同じく、PR を作った時点で head のコミットは base の `refs/pull/{number}/head` に写り、base を読める人に公開される。PR の作成画面で明示する。
- fork の CI は、base のシークレットを受け取らない（[actions.md](actions.md)）。本家の `pull_request` の Event と同じく、CI は `refs/pull/{number}/merge` を対象に走り、fork からの PR ではトークンが読み取り専用になる（[Events that trigger workflows](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows)）。

### 1.3 状態の遷移

```
          ┌── ready_for_review ──┐
 draft ◀──┤                      ├──▶ open ──merge──▶ merged
          └── converted_to_draft ┘     │  ▲
                                   close  reopen
                                       ▼  │
                                      closed
```

- `merged` は終端。`closed` は `reopen` できる。ただし head の ref が消えていたり、base に既に取り込まれていたりすると `reopen` できない。
- **下書き（draft）はマージできない。** CODEOWNERS へのレビューの依頼も、下書きの間は出さない（[About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)）。
- **base に head が既に含まれたら、`merged` にする。** 利用者が手元でマージして base に push した場合、push の Event の処理で「`head_sha` が base の新しい tip から到達できる」ことを検出し、その push をマージとして記録する。本家も、手元で作ったマージのコミットを保護されたブランチに push したとき、GitHub が作るマージと中身が一致すれば受け付けると書いており、手元のマージを PR のマージとして扱う前提がある（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、2026-09-26 に確認）。検出の条件そのものは文書にない（**未検証**。E4 で本家を観測して合わせる）。

## 2. push の後の更新（ADR-0005）

head または base の ref が動くと、ストレージが順序付きの Event（`repo_id`、`ref`、旧 SHA、新 SHA）を outbox に書く。PR の Worker がこれを読み、次を行う。

1. その ref を head か base に持つ open の PR を探す（`(head_repo_id, head_ref)` と `(repo_id, base_ref)` の索引）。
2. head が動いた PR：
   - `head_sha` と `refs/pull/{number}/head` を更新する。
   - タイムラインに push を記録する（「N 件のコミットを追加」、force push なら旧と新）。
   - 古いレビューのコメントの位置を付け直す（4.3 節）。
   - 古い承認を取り消す（ruleset の設定による。4.5 節）。
   - 自動マージを止める条件を調べる（9 節）。
   - `pull_request.synchronize` の Event を出す（11 節）。Actions と Webhook がこれで動く。
3. head か base が動いた PR：マージ可能かを「計算中」にし、再計算を積む（3.3 節）。
4. base が動いた PR：base に head が含まれたかを調べる（1.3 節）。

- 処理は `(repo_id, ref)` の順序を守る。同じ PR への更新は、PR の行のロックで直列にする。Event の SHA が DB の `head_sha` と同じなら何もしない（冪等）。
- 目標：push の成功から PR の画面に新しいコミットが出るまで p95 3 秒（ADR-0005 の「p95 数秒」を具体化する）。
- 画面は、DB の写しが古い可能性を前提にする。マージの実行では、必ず Git の ref の現在値で判定する（6.2 節）。

## 3. 差分とマージ可能かの計算（ADR-0010）

### 3.1 ストレージの RPC

計算はすべて Git のストレージの RPC で行う。アプリ層は作業ツリーを持たない。

| RPC | 中身 | Git の操作 |
| --- | --- | --- |
| `FindMergeBase(a, b)` | merge base | `git merge-base` |
| `CommitDiff(from, to, opts)` | ファイルごとの差分をストリームで返す。上限（3.4 節）で打ち切る | `git diff-tree`（rename の検出あり） |
| `DiffStats(from, to)` | 変更したファイルの一覧と行数だけ | `git diff-tree --numstat` |
| `MergeTree(base, head)` | マージの結果の tree と、衝突したファイル | `git merge-tree --write-tree` |
| `CreateMergeCommit` など | マージの方式ごとのコミットの作成（6 節） | `merge-tree` ＋ `commit-tree`、rebase は `git replay` |

- `git merge-tree --write-tree` は、作業ツリーにも index にも触れずにマージを行い、終了コード 0 なら衝突なし、1 なら衝突あり。衝突の判定は、tree の中身を探さず、終了コードと「Conflicted file info」で行う（[git-merge-tree](https://git-scm.com/docs/git-merge-tree)）。
- 本家は、libgit2 の独自の実装から `merge-ort` に移り、マージを平均 71 ms から 7.74 ms にした。rebase は `git replay` で行う（[Scaling merge-ort across GitHub](https://github.blog/engineering/infrastructure/scaling-merge-ort-across-github/)）。ここでも、Git の本体の `merge-ort` を使い、手元の `git merge` と結果を一致させる（ADR-0001）。
- 計算は、複製のうち読み取りの負荷が低いものに振り分ける（ADR-0004）。結果のオブジェクト（テストマージのコミット）を書くときは、書き込みの経路を通す。

### 3.2 SHA の組でキャッシュする

差分もマージの結果も、入力の SHA が決まれば結果が決まる。したがって、**キャッシュを無効化する必要がなく、追い出すだけでよい。**

| 結果 | キー | 置き場所 |
| --- | --- | --- |
| 差分（ファイルの一覧と行数） | `(network_id, merge_base_sha, head_sha, opts)` | ストレージのノードのローカルのキャッシュ＋共有のキャッシュ |
| ファイルごとの差分の本文 | 上のキー ＋ `path` | 同上 |
| マージ可能か | `(network_id, base_sha, head_sha)` | DB の `pull_request_merge_states`（下） |
| テストマージのコミット | 同上 | Git（`refs/pull/{number}/merge`） |

- `opts` は、空白の無視、rename の検出の有無など、結果を変える選択肢だけを含める。
- 共有のキャッシュの基盤（Valkey か S3 か）は [infrastructure.md](infrastructure.md) で決める。
- 権限の判定は、キャッシュの前に行う。キャッシュのキーはネットワーク単位だが、キャッシュからの読み取りは、判定を通った要求からだけにする（ADR-0002）。

### 3.3 マージ可能かの状態

本家は、PR を取得・作成・編集したときに裏でマージ可能かの計算を始め、終わるまで `mergeable` を `null` で返す（[REST API: pulls](https://docs.github.com/en/rest/pulls/pulls)）。同じ形にする。

| `mergeable` | 意味 |
| --- | --- |
| `null` | 計算中（DB の `(base_sha, head_sha)` に対応する結果がない） |
| `true` | 衝突なし。`merge_commit_sha` にテストマージのコミットを返す |
| `false` | 衝突あり。衝突したファイルの一覧を持つ |

- 計算は、push の Event（2 節）と、PR の画面・API の読み取りの両方から積む。同じキーの計算は、1 つにまとめる（キーごとの排他）。
- 1 回の計算の上限は 10 秒。超えたら `mergeable: false`、理由「計算できない」とし、画面では手元でのマージを案内する。本家は上限を公開していない（2026-09-26 に docs.github.com を確認。**未検証**。本システムの値とする）。
- base が頻繁に動くリポジトリ（モノレポ）では、base の push ごとに全 open の PR を計算し直すと重い。次のように抑える。
  - 画面か API で見られた PR、自動マージが有効な PR、merge queue に入っている PR を優先する。
  - それ以外は、最後の計算から一定時間（例：5 分）経つまで積まない。見られたときに計算する。
- `mergeable_state`（`clean`、`blocked`、`behind`、`dirty`、`unstable`、`draft`、`unknown`）は、マージ可能か（Git）と ruleset の評価（5 節）を合わせて、読み取りのときに組み立てる。保存しない。

### 3.4 差分の上限

本家の上限に揃える（[Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits#diff-limits)）。

| 上限 | 値 |
| --- | --- |
| PR 全体の差分 | 読み込める 20,000 行、または 1 MB |
| 1 ファイルの差分 | 読み込める 20,000 行、または 500 KB |
| 1 ファイルで最初に読み込む量 | 400 行、20 KB（それ以上は「差分を読み込む」で取る） |
| 差分に出すファイルの数 | 300 |
| 描画するファイル（画像・PDF など）の数 | 25 |
| 比較・PR の画面に出すコミットの数 | 250 |
| rebase でマージできるコミットの数 | 100 |

- 上限を超えたファイルは、ファイル名と行数だけを出し、差分の本文は出さない。上限はストレージの RPC で打ち切り、アプリ層に大きな差分を運ばない。
- `.gitattributes` で `linguist-generated` などを付けたファイルは、既定で畳む（本家と同じ）。
- 上限を超えても、マージ可能かの計算とマージは行える。上限は表示だけに掛かる。

## 4. レビュー

### 4.1 レビューの状態

本家の 3 種類の結論に、下書きと取り消しを加える（[About pull request reviews](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews)）。

| 状態 | 意味 |
| --- | --- |
| `PENDING` | 下書き。本人にだけ見える。コメントをまとめて出すために使う |
| `COMMENTED` | 承認も変更の依頼もしない意見 |
| `APPROVED` | マージしてよい |
| `CHANGES_REQUESTED` | 変更が要る |
| `DISMISSED` | `APPROVED`・`CHANGES_REQUESTED` が取り消された |

- レビューは提出時の `commit_id`（head の SHA）を持つ。
- **マージの判定に使うのは、レビュアーごとの最新の `APPROVED` か `CHANGES_REQUESTED` だけ。** `COMMENTED` は前の結論を上書きしない。
- 数に入る承認は、base のリポジトリに書き込み権限を持つ人のものだけ。判定はマージの判定の時点の権限で行う（権限を失った人の承認は数えない）。
- PR の作者は、自分の PR を承認できない。
- レビューを依頼できるのは、書き込みかトリアージの権限を持つ人。依頼される人は、読み取りの権限が要る（本家と同じ）。

### 4.2 コメント

| 種類 | 位置 |
| --- | --- |
| PR へのコメント | タイムライン（Issue のコメントと同じ。[issues.md](issues.md)） |
| 行へのコメント | `commit_id`、`path`、`side`（`LEFT`＝旧・`RIGHT`＝新）、`line`、複数行なら `start_line`・`start_side` |
| ファイルへのコメント | `commit_id`、`path`、`subject_type: file` |

- 行とファイルへのコメントは、スレッドにまとめる。スレッドは「解決済み」にできる。ruleset の「会話の解決を必須にする」は、未解決のスレッドの数で判定する。
- コメントの本文は Markdown で、描画は [web.md](web.md) の安全な描画の経路を通す。

### 4.3 古くなったコメント（outdated）

- head が動いたら、各スレッドの位置を新しい `head_sha` の差分へ付け直す。付け直しは、旧と新の差分の hunk を比べ、コメントの行を含む hunk が変わっていなければ、新しい行番号へ移す。
- 変わっていれば、そのスレッドを outdated にし、元の `commit_id` の差分で表示する。削除はしない。
- 付け直しは PR の Worker が非同期に行う。画面は付け直しの前でも、元の `commit_id` で正しく表示できる。
- 付け直しの規則は、本家が公開していない（2026-09-26 に確認。**未検証**）。本システムの規則とし、E4 で本家の画面を観測して差があれば合わせる。

### 4.4 提案（suggested changes）

- 行へのコメントの本文に ```` ```suggestion ```` のブロックを書くと、その行の置き換えの提案になる。
- 適用すると、head のブランチに 1 つのコミットを作る。複数の提案をまとめて適用しても 1 つのコミットになる。提案した人それぞれと適用した人が共同作者（`Co-authored-by`）になり、適用した人がコミッターになる（[Incorporating feedback in your pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/incorporating-feedback-in-your-pull-request)）。
- 適用できるのは、head に書き込める人（fork では `maintainer_can_modify` が真で、base に書き込み権限を持つ人を含む）。
- コミットはサーバーで作り（ストレージの RPC で tree を組み立てて `commit-tree`）、プラットフォームの鍵で署名する（6.3 節）。head の ref の更新は、期待する旧 SHA を指定した比較交換で行う。head が動いていたら失敗させ、画面で取り直しを促す。
- outdated の提案は適用できない。

### 4.5 取り消し（dismissal）

| きっかけ | 対象 | 条件 |
| --- | --- | --- |
| 手動 | 1 件の `APPROVED`・`CHANGES_REQUESTED` | base の管理者か maintain の権限。理由の記入を必須にする |
| 古い承認の取り消し | その PR の全 `APPROVED` | ruleset の「新しいコミットで古い承認を取り消す」が有効で、差分が変わったか、merge base が変わった |

- 本家は、新しい push、「ブランチの更新」、関係する PR が base に入ったことなどで差分が変わると、承認を古いものとして取り消す（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)）。
- ここでは、承認の時点の三点の差分の指紋（ファイルごとの blob の組のハッシュ）を承認に持たせ、head か base が動いたら指紋を計算し直し、違えば取り消す。加えて、merge base が変わったら、差分の中身が同じでも取り消す。本家は「merge base が承認の後に新しい変更を持ち込んだら古いものとして取り消し、merge base が変わったら再び承認されるまでマージできない」としている（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、2026-09-26 に確認）。以前の案（merge base が動くだけで差分が同じなら取り消さない）は、本家と違い、base から入った変更を承認なしに通しうるので改めた。
- 取り消しは、タイムラインと監査ログに残し、`pull_request_review.dismissed` の Event を出す。

## 5. CODEOWNERS と ruleset（ADR-0011）

### 5.1 CODEOWNERS

本家の規則に合わせる（[About code owners](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners)）。

- ファイルは `.<brand>/CODEOWNERS`、ルートの `CODEOWNERS`、`docs/CODEOWNERS` の順に探し、最初に見つかったものを使う。
- **PR の base のブランチの CODEOWNERS を使う。** head の変更で自分をオーナーから外しても効かない。
- 書式は gitignore に近いが、`!` の否定と `[ ]` の範囲は使えない。**後に書いた一致が優先する。**
- 上限は 3 MB。書式の誤った行は無視し、ファイルの画面で誤りを示す。
- オーナーは書き込み権限を持つ必要がある。チームは、見えるチームで、書き込み権限を持つ必要がある。条件を満たさないオーナーは無視する。
- 解析の結果は `(repo_id, base の CODEOWNERS の blob の SHA)` でキャッシュする。

PR の差分の各ファイルに対し、最後に一致したパターンのオーナーの集合を求める。

- 下書きでない PR が開いたとき、下書きから外れたとき、head が動いて新しいファイルが増えたときに、オーナーへレビューを依頼する。
- 「コードオーナーのレビューを必須にする」が有効なら、**オーナーの付いた各ファイルについて、そのファイルのオーナーの誰かの承認が要る。** オーナーが複数のパターンにまたがる場合も、ファイルごとに判定する。

### 5.2 ruleset のモデル

ブランチの保護は ruleset だけで表す。本家の旧来の「ブランチの保護の規則（branch protection rule）」は作らない（ADR-0011）。

| 項目 | 内容 |
| --- | --- |
| 持ち主 | リポジトリ、または Organization（対象のリポジトリを名前・属性で選ぶ） |
| 対象 | ブランチかタグ。ref の名前の fnmatch のパターンの包含・除外。既定のブランチの指定 |
| 状態 | `active`（強制）、`evaluate`（強制せず、違反を記録するだけ）、`disabled` |
| 規則 | 下の表 |
| バイパス | ロール（リポジトリの管理者、maintain、write、Organization の owner）、チーム、App。モードは「常に」か「PR 経由のときだけ」 |

本家では、1 つのブランチに複数の ruleset が同時に掛かり、優先順位はなく、規則は集約されて最も厳しいものが効く。上限はリポジトリあたり 75、Organization あたり 75（[About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)）。`evaluate` は本家では Enterprise の機能で、Rule Insights で違反を確かめられる（[Creating rulesets for a repository（Enterprise Cloud）](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)）。ここでは全プランで使えるようにする（新しい規則を安全に入れるため）。プランでの制限は PM の判断とする。

MVP で扱う規則（[Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)）：

| 規則 | 引数 | 評価する場所 |
| --- | --- | --- |
| 作成・更新・削除を制限する | なし | push、マージ |
| force push を禁止する | なし | push |
| 線形の履歴を必須にする | なし | push（マージのコミットを含む更新を拒否）、マージ（merge の方式を禁止） |
| 署名されたコミットを必須にする | なし | push、マージ |
| PR を必須にする | 承認の数（0–10）、古い承認の取り消し、コードオーナーのレビュー、最新の push の承認、会話の解決、許すマージの方式 | push（直接の push を拒否）、マージ |
| ステータスチェックを必須にする | チェックの名前と期待する送り手（App）、最新の base を必須にするか（strict） | マージ、merge queue |
| merge queue を必須にする | 8 節の設定 | マージ |

MVP の後に回す規則：デプロイの成功、コードスキャンの結果、コミットのメタデータ（メッセージ・作者のメール）、ファイルのパス・拡張子・大きさの制限。

### 5.3 評価の関数と評価の場所

規則の評価は 1 つの関数に集める。

```
evaluate(repo, ref, operation, actor, context) -> { allowed, violations[], bypassed_by? }
  operation: create | update | delete | force_update | merge(method) | enqueue
  context:   old_sha, new_sha, 追加されたコミット, PR（あれば）, チェックの結果
```

1. `ref` に一致する `active` と `evaluate` の ruleset を集める（リポジトリと Organization の両方）。
2. `active` の規則を集約する。数値は最大、真偽は OR、許すマージの方式は積集合、必須のチェックは和集合。
3. 各規則を評価し、違反を集める。
4. 違反があり、`actor` がいずれの違反した規則の ruleset でもバイパスを持つなら許す。バイパスは ruleset ごとに判定する。ある ruleset のバイパスで、別の ruleset の違反は許さない。
5. `evaluate` の ruleset の違反は、許否に使わず記録だけする。
6. バイパスで通ったら、監査ログに残す。

評価の場所は 2 つ。どちらも同じ関数を呼ぶ。

| 経路 | 呼ぶところ | 規則 |
| --- | --- | --- |
| git push | Git のフロントエンドが、ref の更新の合意の前に呼ぶ（本家の pre-receive に相当）。評価に要る Git の事実（fast-forward か、追加されたコミットの署名など）はフロントエンドが集めて渡す（[git-protocols.md](git-protocols.md)）。1 つの push で複数の ref があれば ref ごとに評価し、`--atomic` でない push では拒否した ref だけを `ng` にする | push の規則 |
| PR のマージ・merge queue | API がマージの前に呼び、ストレージの RPC の直前に Git の現在の SHA で再評価する | push の規則 ＋ PR の規則 |

- **判定の材料が読めないときは拒否する（fail closed）。** ruleset を DB から読めない、チェックの結果を読めない場合、保護の対象かどうかにかかわらず、その push とマージを拒否する。保護のない変更を通すより、書き込みを止める方を選ぶ（[intent.md](../intent.md) の「守るべき振る舞い」）。
- ruleset はリポジトリごとに版を持ち、Git のフロントエンドは版でキャッシュする。ruleset の変更は outbox で知らせ、キャッシュを捨てる。
- 拒否の理由は、push では `remote:` の行で、API では違反の一覧で返す。読み取り権限のある人は、有効な ruleset を見られる（本家と同じ）。

### 5.4 必須のステータスチェック

- チェックは、コミットの SHA に付く（外部の CI の commit status と、App の check run。[api-and-webhooks.md](api-and-webhooks.md)、[actions.md](actions.md)）。
- PR の判定では `head_sha` のチェックを見る。merge queue では、グループのコミットの SHA のチェックを見る（8 節）。
- 送り手を指定したチェックは、その App が送ったものだけを数える。名前の衝突によるなりすましを防ぐ。
- 成功とみなす結論は `success`・`neutral`・`skipped`。それ以外、または未報告は未成功。
- strict（最新の base を必須にする）では、base の tip が head から到達できることを要求する。満たさなければ `mergeable_state: behind` とし、「ブランチの更新」を案内する。本家では、strict で base の更新ごとに CI が要ることを代償としている（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)）。merge queue はこの代償を減らすための仕組み。

### 5.5 署名されたコミット

- push の評価では、ref の更新で新たに到達できるようになったコミット（旧 SHA から到達できないもの）の署名をすべて検証する。GPG・SSH の署名を扱い、登録された鍵と照合する（[identity-and-permissions.md](identity-and-permissions.md)）。
- 検証の結果は、コミットの SHA と鍵の状態の版でキャッシュする。
- サーバーが作るコミット（merge、squash、提案の適用、Web での編集）は、プラットフォームの鍵で署名する。本家も Web で作るコミットを署名し、squash の最後のコミットも署名する（[About commit signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)、[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)）。
- **rebase で作り直したコミットは署名しない。** 本家は、rebase のマージのコミットは利用者の鍵を持たないので署名できないとしている（同上）。本家に合わせ、署名の必須が掛かった base では rebase の方式を選べなくする。
- squash でも、PR の中に署名のないコミットがあると拒否される場合があると本家は述べている（同上）。本家は、テストのマージが持ち込む全てのコミット（head のコミットを含む）を検証し、署名のない head のコミットは、最後の squash のコミットを GitHub が署名する場合でも squash を妨げうるとしている（[About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)、2026-09-26 に確認）。ここでは、squash と merge は「base に新たに入るコミット」だけを検証の対象にする。merge の方式では head のコミットも base に入るので、それらの署名も要る。squash では、プラットフォームが署名した 1 つのコミットだけが入るので、PR の中のコミットの署名は問わない（**本家との違い**。base の履歴に入るコミットの署名を守るという規則の目的は満たし、外部の貢献者の署名のないコミットを squash で取り込めるようにする）。

## 6. マージ

### 6.1 方式

本家の 3 つの方式を持つ（[About pull request merges](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges)）。

| 方式 | 作るもの | 計算 |
| --- | --- | --- |
| merge | 親が base の tip と head の 2 つのマージのコミット | `merge-tree --write-tree` → `commit-tree -p base -p head` |
| squash | 親が base の tip 1 つのコミット。tree はマージの結果 | `merge-tree --write-tree` → `commit-tree -p base` |
| rebase | head の各コミットを base の上に載せ直した列。SHA は新しくなり、コミッターは更新され、もともと空のコミットは落とす | `git replay`。コミットは 100 件まで |

- リポジトリの設定で使える方式を選べる。ruleset の「許すマージの方式」と「線形の履歴」で、さらに絞る。
- squash のコミットのメッセージの既定値（PR のタイトルと番号、本文、コミットの一覧）はリポジトリで設定できる。共同作者の `Co-authored-by` を集める。

### 6.2 マージの手順

```
API ──(1) can(actor, write, base_repo)
    ──(2) evaluate(..., merge(method)) … DB の写しで事前判定
    ──(3) pull_request_merges に「開始」を記録（expected_base_sha, head_sha, method）
    ──(4) ストレージ RPC: MergePullRequest(base_ref, expected_base_sha, head_sha, method, message, signer)
              ├ Git の現在の base・head を読み、expected と違えば失敗（競合）
              ├ evaluate を現在の SHA で再評価（ADR-0011）
              ├ コミットを作り、署名する
              └ base の ref を比較交換で更新（複製の合意、ADR-0003・ADR-0006）→ outbox に ref の Event
    ──(5) PR を merged にし、merge_commit_sha を記録
```

- 正本は Git の ref の更新（4）。（5）の前に API が落ちても、ref の Event の処理（2 節の 4）が「base に head が含まれた」ことを検出し、（3）の記録と照合して `merged` にする。二重のマージは、（4）の比較交換で起こらない。
- 利用者の要求には `expected_head_sha` を付けられるようにする（本家の REST API の `sha` 引数に相当）。画面で見た head と違えば失敗させ、見ていないコミットのマージを防ぐ。
- マージの後、head のブランチの自動削除（リポジトリの設定）を行う。削除も ruleset を通す。

### 6.3 衝突の解決

- Web での衝突の解決（衝突したファイルを編集してコミットする）は、MVP では単純な衝突（テキストのファイル、rename を含まない）に限る。解決のコミットは head に作る（base を head にマージするコミット）。head が保護されていれば、新しいブランチを作らせる。本家も、Web で解決できるのは単純な行の競合だけで、解決は base 全体を head にマージし、head が保護されていれば新しいブランチを作る（[Resolving a merge conflict on GitHub](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/addressing-merge-conflicts/resolving-a-merge-conflict-on-github)、2026-09-26 に確認）。
- それ以外は、手元での解決を案内する。

## 7. 「ブランチの更新」

- head に base を取り込む。merge（base を head にマージ）か rebase を選べる。
- head への書き込み権限が要る。fork では `maintainer_can_modify` を見る。
- head の ref の更新は、比較交換で行い、head のリポジトリの ruleset を通す。

## 8. merge queue（ADR-0012）

### 8.1 振る舞い

本家の merge queue に合わせる（[Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)）。

- ruleset の「merge queue を必須にする」が掛かった base には、PR は直接マージできず、キューに入れる。
- キューに入れる条件：PR の規則（承認、コードオーナー、会話の解決、PR の head のチェック）を満たすこと。strict の「最新の base」は要求しない。キューがそれを代わりに保証する。
- キューは先入れ先出し。各 PR について、**base の最新と、キューで前にあるすべての PR と、その PR を合わせた一時的なブランチ**を作り、そこで必須のチェックを走らせる。
- 一時的なブランチは `<brand>-readonly-queue/{base}/pr-{number}-{head_sha}` の形の名前にし、利用者は push できない。名前の形は本家（`gh-readonly-queue/`）に合わせ、接頭辞だけを ADR-0006 で置き換える。外部の CI の設定は、接頭辞の置き換えで流用できる。
- CI には `merge_group`（`checks_requested`）の Event を送る。Actions のワークフローは `merge_group` を契機に持たないと、キューでチェックが走らない（[Events that trigger workflows](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows)）。
- 失敗した PR はキューから外し、それより後ろの一時的なブランチを、外した PR を除いて作り直して続ける。

### 8.2 設定

| 設定 | 範囲 | 意味 |
| --- | --- | --- |
| マージの方式 | merge・squash・rebase | キューの取り込みの方式 |
| 同時に作るグループの数（build concurrency） | 1–100 | 同時に送る `merge_group` の数の上限 |
| 1 回に取り込む PR の数の最小・最大 | 1–100 | グループの大きさ |
| 最小に満たないときの待ち時間 | 分 | 待っても増えなければ、小さなグループで取り込む |
| 失敗していないものだけ取り込む | 真偽 | 偽なら、グループの最後の PR のチェックが通れば、途中の失敗を許して取り込む |
| チェックの待ち時間の上限 | 分 | 超えたら失敗とみなす |

### 8.3 取り込み

- グループの一時的なブランチの tip は、キューの設定の方式で作った「取り込んだ後の base の姿」そのものである。チェックが通ったら、base の ref を **その SHA へ早送り（fast-forward）で比較交換** する。作り直さないので、検査した SHA と取り込む SHA が一致する。
- base が他の経路で動いていたら（バイパスの push など）、比較交換が失敗する。キューの全グループを作り直す。
- 取り込みのたびに、ruleset の push の規則を再評価する（5.3 節）。
- 状態とタイムライン：`enqueued`、`dequeued`（理由：失敗、手動、衝突、base の変更、タイムアウト）、`merged`。

### 8.4 状態の持ち方

- キューの状態（エントリ、グループ、グループの SHA）は DB を正本とし、base のブランチごとに 1 つの単一ライターの Worker（キーで排他する）が進める。
- 一時的なブランチの ref は Git に作り、グループを捨てたら消す（`merge_group.destroyed` を出す）。
- 詳細の状態遷移は ADR-0012。

## 9. 自動マージ

- 条件を満たしていない PR に、自動マージを予約できる。予約には書き込み権限が要る。方式とメッセージを予約時に決める。
- 条件（必須のレビューとチェック）を満たしたら、予約した人としてマージする。merge queue が必須の base では、キューに入れる。
- 次のときは予約を取り消す（本家と同じ。[Automatically merging a pull request](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)）。
  - 書き込み権限のない人が head に push した。
  - base のブランチが変わった。
- 予約した人が権限を失ったときも取り消す（本家の文書に記述がない。2026-09-26 に確認。**未検証**。予約した人としてマージするので、権限のない人のマージを避けるための本システムの規則）。
- 条件を満たしたかの判定は、チェックの結果、レビュー、push の Event を受けた PR の Worker が行う。判定のたびに 6.2 節の手順を通すので、事前判定が古くても誤ってマージしない。

## 10. 下書き

- 作成時に下書きにできる。下書きは「レビューの準備ができた」に変えられ、その逆もできる（作者と書き込み権限のある人）。
- 下書きの間は、マージ、自動マージの予約、キューへの追加ができない。コードオーナーへの依頼を出さない。
- CI は下書きでも走る（`pull_request` の Event は出る）。

## 11. 出す Event

Worker は outbox に次の Event を書き、通知・Webhook・Actions・検索の索引へ流す（[api-and-webhooks.md](api-and-webhooks.md)、[notifications.md](notifications.md)、[search.md](search.md)）。名前と action は本家の Webhook に合わせる。

| Event | action |
| --- | --- |
| `pull_request` | `opened`、`edited`、`closed`（`merged` を含む）、`reopened`、`synchronize`、`converted_to_draft`、`ready_for_review`、`review_requested`、`review_request_removed`、`assigned`、`unassigned`、`labeled`、`unlabeled`、`auto_merge_enabled`、`auto_merge_disabled`、`enqueued`、`dequeued` |
| `pull_request_review` | `submitted`、`edited`、`dismissed` |
| `pull_request_review_comment` | `created`、`edited`、`deleted` |
| `pull_request_review_thread` | `resolved`、`unresolved` |
| `merge_group` | `checks_requested`、`destroyed` |

- Event は PR ごとに順序を持つ（`pr_event_seq`）。受け手はこれで重複と順序を扱える。
- Event の配信先は、配信の時点で権限を判定し直す（ADR-0002）。
- 本家の `pull_request` の action は、上に加えて `milestoned`・`demilestoned`・`locked`・`unlocked`・`stacked` を持つ（[Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)、2026-09-26 に確認）。MVP で出すものは上の表に限り、残りは E7 の Webhook の拡充で足す。

## 12. 性能（NFR-004）

目標：PR の画面の表示 p95 1.5 秒以内（差分 1,000 行まで）。予算の内訳（サーバーの処理、キャッシュが効かない場合）：

| 段 | 予算（p95） |
| --- | --- |
| 認証・権限の判定・PR のメタデータ | 100 ms |
| 差分のファイルの一覧と行数（`DiffStats`） | 150 ms |
| 最初に見せる差分の本文（400 行×ファイル、合計 1,000 行） | 250 ms |
| 構文の色付け（キャッシュなし） | 150 ms |
| SSR とストリームの開始 | 150 ms |
| ネットワークとブラウザの描画（HPC まで） | 700 ms |

- マージ可能かとチェックの結果は、表示の経路に入れない。最後に分かっている値を出し、計算中なら「確認中」とし、後から更新する。
- 差分の本文は、最初の画面の範囲を先に送り、残りはストリームか遅延の読み込みにする（[web.md](web.md)）。
- ストレージの RPC の目標：`DiffStats` p95 100 ms、`MergeTree` p95 200 ms（中規模のリポジトリ）。キャッシュの命中率は 80% 以上を目安にする。
- 負荷の試験で、1,000 行と、上限の 20,000 行の差分の両方を測る。1,000 行を超える差分は NFR-004 の対象外だが、画面が固まらないこと（INP p75 200 ms 以内）を目標にする。

## 13. データ

主なテーブル（列の定義は [data-model/pull-requests.md](data-model/pull-requests.md) と [data-model/rulesets-and-checks.md](data-model/rulesets-and-checks.md)）。すべて `repo_id`（base のリポジトリ）を持ち、判定を経ない読み取りを lint で禁止する（ADR-0002）。

| テーブル | 中身 |
| --- | --- |
| `pull_requests` | 1.1 節の項目 |
| `pull_request_merge_states` | `(network_id, base_sha, head_sha)` → マージ可能か、衝突したファイル、テストマージの SHA |
| `pull_request_reviews` | 状態、`commit_id`、差分の指紋、取り消しの理由 |
| `review_threads`、`review_comments` | 位置、outdated、解決済み |
| `review_requests` | 依頼先（ユーザー・チーム）、コードオーナーによる依頼か |
| `rulesets`、`ruleset_rules`、`ruleset_bypass_actors`、`ruleset_evaluations` | ruleset と、`evaluate` の記録・バイパスの記録 |
| `pull_request_merges` | マージの開始・完了の記録（6.2 節） |
| `merge_queues`、`merge_queue_entries`、`merge_groups` | キューの状態（`merge_queues` は base のブランチごとのリース） |
| `auto_merge_requests` | 自動マージの予約 |
| `pull_request_events` | PR ごとの Event の順序 |

## 14. 未解決の問い

設計の中で出た問いと、その決定。計測・PoC で決めるものは「持ち越し」に置く。

### 決定（2026-09-26、既定案）

- **差分の共有のキャッシュ**：ファイルの一覧と行数は Valkey（TTL 付き、追い出しだけ）、ファイルごとの差分の本文は S3（`(network_id, merge_base_sha, head_sha, opts, path)` のキー、ライフサイクルで 30 日）に置く（[capacity.md](capacity.md) の 2.5 節と同じ）。
- **`evaluate` の状態**：MVP では全ての持ち主に開放する。MVP にプランの仕組みがないため。プランを入れるときに、本家に合わせて企業向けに限るかを見直す。
- **旧来のブランチの保護の API**（`/branches/{branch}/protection`）：提供しない。呼ばれたら `501` と ruleset の文書の URL を返す（ADR-0011 の一本化、ADR-0021 の未実装の扱い）。
- **古い承認の取り消し**（2026-09-26 の本家の確認による改訂）：差分の指紋が変わったときに加え、merge base が変わったときも取り消す（4.5 節）。本家に合わせ、base から入った変更を承認なしに通さない。
- **署名の必須と squash**：squash では PR の中のコミットの署名を問わない（5.5 節）。本家は署名のない head のコミットで squash を妨げうるが、base に入るのは署名したコミットだけなので、本家との違いとして受け入れる。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| マージ可能かの再計算を、base の push の頻度が高いリポジトリでどこまで間引くか（3.3 節） | E4 の `mergeability-worker` の既定（5 分）で始め、E9 の負荷試験で `merge-tree` の件数と遅延を測って直す |

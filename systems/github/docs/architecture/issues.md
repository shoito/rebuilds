# Issues: GitHub

Issue、ラベル、マイルストーン、担当者、sub-issue と Issue の種類、参照とタイムライン、リアクション、ロック、移動、ピン留め、テンプレートとフォーム。Pull Request に固有の部分（差分、レビュー、マージ）は [pull-requests.md](pull-requests.md) にある。通知は [notifications.md](notifications.md)、検索は [search.md](search.md) にある。

本家の振る舞いに寄せる。本家の文書で確かめられなかった点は「未検証」と書く。

## 1. Issue と Pull Request の関係、番号

- **Issue と Pull Request は、同じ表 `issues` の行として持つ。** Pull Request は、`issues` の行に `pull_requests` の行（1 対 1）が付いたもの。本家の REST API も「すべての Pull Request は Issue だが、すべての Issue が Pull Request ではない」としている（[REST API の Issues](https://docs.github.com/en/rest/issues/issues)）。コメント、ラベル、担当者、マイルストーン、リアクション、タイムライン、通知のスレッドを、両者で共有する。
- **番号は、リポジトリごとに 1 つの列を Issue と Pull Request で共有する**（`#1` が Issue なら、次の Pull Request は `#2`）。採番の方法は [ADR-0017](../decisions/0017-shared-issue-numbering.md)。
  - Issue を作るトランザクションの中で、`UPDATE repositories SET next_issue_number = next_issue_number + 1 WHERE id = :repo_id RETURNING next_issue_number - 1` で番号を得る。行ロックはコミットまでの短い間だけ。
  - 作成が失敗して巻き戻れば番号も戻るので、失敗による欠番は出ない。削除・移動による欠番は出る（本家と同じ）。
  - 番号は再利用しない。`(repo_id, number)` に一意制約を置く。
- リポジトリの名前の変更・持ち主の変更（リポジトリの移動）では、番号は変わらない。

## 2. 属性

| 属性 | 中身 | 規則 |
| --- | --- | --- |
| タイトル | 1 行 | 必須。最大 256 文字（本家は上限を公開していない。2026-09-26 に確認。**未検証**。本システムの値） |
| 本文・コメント | Markdown | 最大 65,536 文字（本家のエラーの文言に倣う。本家の文書にあるのは、メールの返信で作るコメントの上限 65,530 文字だけ。[Configuring notifications](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)、2026-09-26 に確認。**未検証**）。描画は隔離した環境で行う（[web.md](web.md)） |
| 状態 | `open` / `closed` | 閉じる理由 `state_reason`：`completed`、`not_planned`、`duplicate`。開き直すと `reopened`（[REST API の Issues](https://docs.github.com/en/rest/issues/issues)） |
| 担当者 | ユーザー | 最大 10 人（[担当者の文書](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users)） |
| ラベル | リポジトリのラベル | 3 節 |
| マイルストーン | リポジトリのマイルストーン | 0 か 1 つ |
| 種類（type） | Organization の Issue の種類 | 0 か 1 つ。Organization の持つリポジトリだけ（5 節） |
| ロック | 真偽と理由 | 8 節 |

- 本文とコメントの編集履歴を持つ（`user_content_edits`）。履歴は、本文を読める人に見える。
- 削除は、リポジトリの admin だけができる（[リポジトリのロール](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)）。削除は物理削除し、検索の文書と通知のスレッドも消す（[search.md](search.md)、[notifications.md](notifications.md)）。Pull Request は削除できない。

## 3. ラベル

- ラベルはリポジトリの単位で持つ：`labels (repo_id, id, name, color, description)`。名前はリポジトリの中で、大文字・小文字を区別せずに一意にする。
- 新しいリポジトリには、既定のラベルを作る。本家の既定は `accessibility`、`bug`、`documentation`、`duplicate`、`enhancement`、`good first issue`、`help wanted`、`invalid`、`question`、`wontfix` の 10 個で、本システムも同じにする（[Managing labels](https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels)、2026-09-26 に確認。以前の案は `accessibility` を欠いていた）。Organization は、新しいリポジトリの既定のラベルを差し替えられる。
- ラベルの削除は、付いている Issue から外す。タイムラインの過去の `labeled` イベントは、ラベルの名前と色の写しを持つので表示が壊れない。

## 4. マイルストーン

- `milestones (repo_id, id, number, title, description, due_on, state, closed_at)`。番号はリポジトリの中で別の列（Issue の番号とは共有しない）。
- 進み具合は、そのマイルストーンの Issue と Pull Request の、閉じた数 / 全体の数。`milestones` に `open_count`・`closed_count` を持ち、Issue の変更と同じトランザクションで更新する。

## 5. Issue の種類と sub-issue

### 5.1 Issue の種類

- Organization の単位で定義する：`issue_types (org_id, id, name, description, color, enabled)`。本家は 1 つの Organization に最大 25 種類、既定は `task`・`bug`・`feature`（[Issue の種類の管理](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/managing-issue-types-in-an-organization)）。
- 個人の持つリポジトリには種類がない。本家の種類は Organization で定め、リポジトリは Organization から引き継ぐ（[Issue types の REST API](https://docs.github.com/en/rest/repos/issue-types)、2026-09-26 に確認。個人のリポジトリに種類がないことの明記はないが、定める場所が Organization にしかない）。
- 種類の管理は Organization の owner。種類を無効にしても、付いている Issue からは外さず、新たに付けられなくする。

### 5.2 sub-issue

- `sub_issues (parent_issue_id, child_issue_id, position)`。子は親を 1 つだけ持つ。
- 本家の上限：1 つの親に子は 100 件、入れ子は 8 段まで。別のリポジトリの Issue も子にできる（[sub-issue の文書](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues)）。
- 追加の時に、循環（自分の祖先を子にする）を拒否する。祖先をたどるのは 8 段までなので、再帰の問い合わせで確かめられる。
- **権限**：親のリポジトリと子のリポジトリの両方で triage 以上を要る（本家の文書に要件の記述がない。2026-09-26 に確認。**未検証**。両側の表示が変わるので、両側で編集の権限を求める。E5 の spec の決定表で確定する）。
- **表示**：親の画面の子の一覧、子の画面の親の表示は、見る人が読めるリポジトリのものだけを出す。非公開のリポジトリの子の件数も、進み具合の分母に含めない（見る人ごとに数える）。これを怠ると、非公開の Issue の存在が漏れる。
- 進み具合（閉じた子 / 子の全体）は、見る人が全部の子を読める場合に限り、非正規化した値を使う。そうでなければ、その場で数える。

## 6. 参照とタイムライン

### 6.1 参照の書き方

本家の自動リンク（[自動リンクの文書](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls)）に合わせる。

| 書き方 | 意味 |
| --- | --- |
| `#26`、`<BRAND>-26` | 同じリポジトリの Issue・Pull Request |
| `owner/repo#26`、Issue の URL | 別のリポジトリの Issue・Pull Request |
| コミットの SHA（短縮を含む）、`owner/repo@sha` | コミット |
| `@user`、`@org/team` | メンション（[notifications.md](notifications.md)） |

- 本文・コメントの保存の後、Worker が参照を抜き出し、`issue_references (source_kind, source_id, source_repo_id, target_issue_id, created_at)` に書き、参照された側のタイムラインに `cross-referenced` のイベントを積む。本文の編集で参照が増えたときも積む。消えても、イベントは消さない（本家の文書に記述がない。**未検証**。E5 で本家を観測して合わせる）。
- `redirect.github.com` を使った参照は逆リンクを作らない、という本家の抜け道に相当するものは MVP では作らない。
- **閉じるキーワード**（`closes #10` など）による自動クローズは、Pull Request のマージの時に行う。詳細は [pull-requests.md](pull-requests.md)。

### 6.2 タイムライン

`issue_events (repo_id, issue_id, id, actor_id, event, payload, created_at)` に追記だけで積む。コメントとイベントを時刻の順に合わせて表示する。

| イベント | payload の例 |
| --- | --- |
| `labeled` / `unlabeled` | ラベルの名前と色の写し |
| `assigned` / `unassigned` | 担当者 |
| `milestoned` / `demilestoned` | マイルストーンのタイトルの写し |
| `renamed` | 旧と新のタイトル |
| `closed` / `reopened` | `state_reason`、閉じた Pull Request・コミット |
| `locked` / `unlocked` | 理由 |
| `pinned` / `unpinned` | |
| `transferred` | 元のリポジトリ |
| `cross-referenced` | 参照元の Issue・Pull Request |
| `referenced` | 参照したコミット |
| `sub_issue_added` / `sub_issue_removed` / `parent_issue_added` / `parent_issue_removed` | 相手の Issue |
| `issue_type_added` / `issue_type_changed` / `issue_type_removed` | 種類の名前の写し |

- **参照元の権限で絞る。** 公開のリポジトリの Issue が、非公開のリポジトリから参照されたとき、`cross-referenced` のイベントは、参照元を読める人にだけ見せる。タイムラインを返す経路は、イベントごとに参照元の `source_repo_id` を ADR-0002 の判定関数で確かめる（`canMany` で一括に判定する）。これは漏洩テストの対象にする。
- sub-issue のイベント、移動のイベントも同じく、相手のリポジトリを読める人にだけ中身を見せる。

## 7. リアクション

- 種類は 8 つ：`+1`、`-1`、`laugh`、`confused`、`heart`、`hooray`、`rocket`、`eyes`（[REST API の Reactions](https://docs.github.com/en/rest/reactions/reactions)）。
- `reactions (repo_id, subject_type, subject_id, user_id, content, created_at)`、一意は `(subject_type, subject_id, user_id, content)`。対象は Issue の本文とコメント（Pull Request のレビューのコメントを含む）。
- 種類ごとの件数を対象に非正規化して持ち、同じトランザクションで増減する。
- リアクションには通知を出さない。

## 8. ロック

- ロックできるのは、リポジトリで write 以上の人（[会話のロックの文書](https://docs.github.com/en/communities/moderating-comments-and-conversations/locking-conversations)、[リポジトリのロール](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)）。triage はロックできない。
- 理由は `off-topic`、`too heated`、`resolved`、`spam` から選べ、省略もできる（[REST API の Issues](https://docs.github.com/en/rest/issues/issues) の `lock_reason`）。
- ロックの間、write 以上の人だけがコメントの追加・非表示・削除をできる。リアクションは誰もできなくなる。
- メールの返信（[notifications.md](notifications.md) の 6 節）も、この規則で拒否する。

## 9. 移動（transfer）

本家の規則（[Issue の移動の文書](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/transferring-an-issue-to-another-repository)）に合わせる。

- 両方のリポジトリで write 以上が要る。
- 同じ持ち主（ユーザーか Organization）のリポジトリの間だけ。
- 非公開のリポジトリから公開のリポジトリへは移せない。
- Pull Request は移せない。
- コメントと担当者は保つ。ラベルは名前で、マイルストーンは名前と期限で、移動先のものに対応させる。対応しないものは外す。
- 移動先で新しい番号を振る。元の `(repo_id, number)` は `issue_redirects` に残し、元の URL・API はリダイレクトする。元の番号は欠番になる。
- 同じトランザクションで：`issues.repo_id` と `number` を書き換え、子の表の `repo_id` を書き換え、`transferred` のイベントを積み、outbox に `issue.transferred` を書く。子の表の行数が多い Issue（例：コメント 1 万件）は、トランザクションが長くなる。上限を超えるものは、非同期の移動（移動中の状態を持つ）にする。上限の値は負荷試験で決める。
- 検索の文書は、元の文書を消し、新しい文書を作る。同じリポジトリの持ち主の中の移動なので、公開の種類の変化は「公開 → 公開」「非公開 → 非公開」「公開 → 非公開」だけになる。最後の場合は、検索の除外の表（[search.md](search.md) の 4.3 節）に、その Issue の行を同じトランザクションで書く。
- 通知のスレッドの購読は、移動先へ引き継ぐ。移動先を読めない購読者の購読は外す。

## 10. ピン留め

- 1 つのリポジトリに最大 3 件（[ピン留めの文書](https://docs.github.com/en/issues/tracking-your-work-with-issues/administering-issues/pinning-an-issue-to-your-repository)）。
- 必要な権限は write 以上とする（本家の文書・ロールの表に行がない（2026-09-26 に確認。**未検証**）。2026-09-26 に既定案として決めた）。
- `pinned_issues (repo_id, issue_id, position)`。4 件目は 422 で拒否する。

## 11. テンプレートとフォーム

- 置き場所は、デフォルトブランチの `.<brand>/ISSUE_TEMPLATE/` の `*.md`（テンプレート）と `*.yml`（フォーム）、設定は `.<brand>/ISSUE_TEMPLATE/config.yml`（`blank_issues_enabled`、`contact_links`）。リポジトリに有効なテンプレートか設定が 1 つもなければ、Organization の公開の `.<brand>` リポジトリのものを使う。1 つでもあれば、Organization のものは使わない（本家の既定のコミュニティ健全性ファイルと同じ。[Creating a default community health file](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file)、2026-09-26 に確認）。
- 読み出しは Git のストレージの RPC で行い、デフォルトブランチのコミットの SHA をキーにキャッシュする（[ADR-0005](../decisions/0005-git-as-source-of-truth.md)。Git が正本）。
- フォームの要素は `markdown`、`input`、`textarea`、`dropdown`、`checkboxes`。必須の検証はサーバーでも行い、送信時に Markdown の本文に変換して保存する（保存するのは変換後の本文だけ）。
- テンプレートに書いたラベル・担当者・種類は、作成者に triage の権限がなくても付ける（リポジトリの持ち主の設定とみなす。本家の文書に記述がない。**未検証**）。存在しないラベル・担当できない人は黙って捨てる（本家も、存在しないラベルは付けない。[Syntax for issue forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)、2026-09-26 に確認）。
- YAML の解析は、大きさ（例：64 KiB）と要素の数に上限を置く。不正なら、そのテンプレートを一覧に出さず、リポジトリの admin に画面で警告する。

## 12. 権限の規則

判定は [ADR-0002](../decisions/0002-repository-permission-model.md) の `can(actor, action, resource)` に集約する。action の語彙（`issues:read`・`issues:write` など）とロールの決定表は [identity-and-permissions.md](identity-and-permissions.md) の 5 節にあり、この表はその Issue の部分を細かくしたもの。本家のリポジトリのロールの表（[リポジトリのロール](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)）に合わせた。ロールの詳細は [identity-and-permissions.md](identity-and-permissions.md)。

| 操作 | 必要なもの |
| --- | --- |
| 読む（本文、コメント、タイムライン） | リポジトリの read |
| 作る、コメントする、リアクションする | リポジトリの read（公開のリポジトリはログインしていれば誰でも）。Issue の機能が無効なら不可。ブロックされた人は不可 |
| 自分の Issue を閉じる・開き直す、自分のコメントを編集・削除する | 作成者本人（read） |
| ラベル・マイルストーン・種類を付ける・外す、すべての Issue を閉じる・開き直す・担当させる、重複の印 | triage 以上 |
| ラベル・マイルストーンの作成・編集・削除 | write 以上 |
| ロック | write 以上（8 節） |
| 移動 | write 以上（両方のリポジトリ。9 節） |
| ピン留め | write 以上（本家の表に行がない。**未検証**。10 節） |
| 他人のコメントの編集・削除・非表示 | write 以上 |
| Issue の削除 | admin |

- 権限の足りない人が作成時にラベル・担当者・マイルストーン・種類を渡したら、黙って捨てる（本家の REST API と同じ。[REST API の Issues](https://docs.github.com/en/rest/issues/issues)）。
- 担当にできる人：本人、その Issue にコメントした人、write 以上の人、Organization のメンバーで read 以上の人（[担当者の文書](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/assigning-issues-and-pull-requests-to-other-github-users)）。
- Issue の表はすべて `repo_id` を持ち、判定を経ない読み取りを lint で禁止する（ADR-0002）。

## 13. 濫用の対策

- 作成の上限は、本家の二次レート制限（内容を作る要求は 1 分に 80 件、1 時間に 500 件まで。[REST API のレート制限](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)）に合わせ、Web と API で共有する。値の管理は [api-and-webhooks.md](api-and-webhooks.md)。
- 1 つの Issue のコメントは、上限（例：2,500 件）を超えたら新しいコメントを拒否する（本設計の値。本家は上限を公開していない。2026-09-26 に確認。**未検証**）。
- 本文のメンションは、1 つの本文で通知の対象にする人数を 50 人までにする（[notifications.md](notifications.md) の 3 節）。

## 14. イベントの発行

Issue の変更は、同じトランザクションで outbox に書く。受け手は通知（[notifications.md](notifications.md)）、検索の索引（[search.md](search.md)）、Webhook（[api-and-webhooks.md](api-and-webhooks.md)）。

| outbox の種類 | 主な受け手 |
| --- | --- |
| `issue.opened` / `issue.edited` / `issue.closed` / `issue.reopened` / `issue.deleted` / `issue.transferred` | 通知、検索、Webhook |
| `issue_comment.created` / `edited` / `deleted` | 通知、検索、Webhook |
| `issue.labeled` / `assigned` / `milestoned` / `typed` / `locked` / `pinned` と、その逆 | 検索、Webhook（`assigned` は通知も） |
| `sub_issue.added` / `removed` | 検索、Webhook |

outbox から SQS への受け渡しは、[notifications.md](notifications.md) の 2 節と同じ仕組みを使う。

## 15. テスト

- 番号：同じリポジトリで並行に Issue と Pull Request を作っても、番号が重複せず、失敗した作成で欠番が出ない（性質ベーステスト）。
- 権限の決定表：12 節の各行を、ロール × 操作の表駆動テストにする。
- 漏洩テスト：非公開のリポジトリからの参照、非公開の sub-issue、移動の元が、読めない人のタイムライン・件数・進み具合に出ない。
- 移動：ラベル・マイルストーンの対応、リダイレクト、公開 → 非公開の拒否。
- テンプレート：不正な YAML、大きすぎるフォーム、存在しないラベル。

## 16. 未解決の問い

設計の中で出た問いと、その決定。計測・PoC で決めるものは「持ち越し」に置く。

### 決定（2026-09-26、既定案）

- ピン留めは write 以上、sub-issue の追加・削除は親と子の両方のリポジトリで triage 以上（5.2、10 節）。本家の文書で確かめられないので、E5 の spec の決定表で確定し、本家の振る舞いを観測できたら合わせる。
- Issue のフィールド（本家の Issue fields や Projects のカスタムフィールド）は、MVP の後の候補（Projects と一緒に扱う。[roadmap.md](../roadmap.md) の「後回しにしたもの」）。
- **既定のラベル**（2026-09-26 の本家の確認による改訂）：本家と同じ 10 個（`accessibility` を加えた）にする（3 節）。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 移動を非同期にする上限の値（9 節） | E5 の `issue-transfer` で、コメントの数ごとのトランザクションの時間を測って決める |

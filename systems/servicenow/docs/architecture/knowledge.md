# Knowledge: ServiceNow

ナレッジの記事と版、ナレッジベースとカテゴリ、レビューと公開の流れ、公開の範囲、問題からの既知のエラーの記事、評価とフィードバック、ポータルでの自己解決（申請をやめた割合）の計測を決める。

前提の決定は、承認を 1 回だけ反映すること（[ADR-0016](../decisions/0016-approvals.md)）、フローを版付きで動かすこと（[ADR-0014](../decisions/0014-flow-dsl-and-versioning.md)）、ACL の条件を SQL の述語にコンパイルできる式に限り、検索を含むすべての出口で同じ判定を使うこと（[ADR-0012](../decisions/0012-acl-enforcement-at-every-exit.md)）、テナントの HTML を描かないこと（[intent.md](../intent.md) の Non-goals）である。既知のエラーの印は [itsm-processes.md](itsm-processes.md) の 7.2 節で決めた。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0031](../decisions/0031-knowledge-articles-versions-and-publishing.md) | 記事は、変わらない記事の行と、版の行で持つ。1 つの記事に、公開中の版は高々 1 つ、編集中の版も高々 1 つ。版はレビューに出した時点で本文を固定し、公開の後は変えない。公開はナレッジベースごとの方針（即時か承認か）で、組み込みのフローの承認を通す。本文は制限付きの Markdown だけにする |
| [0032](../decisions/0032-knowledge-feedback-and-deflection.md) | 評価は利用者・版ごとに 1 件（上書き）にし、旗（要見直し）は理由を必須にして記事の持ち主のグループへのタスクにまとめる。自己解決は、ポータルのセッションの事象の記録から、明示の「解決した」と、記事を見た後に申請を出さなかったことの 2 つで数える。事象の記録は仮名のセッションで持つ |

この文書の決定表・性質は設計の草案である。ID は E9 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：ナレッジベース、カテゴリ、記事と版、編集の排他、レビューと公開の状態、承認の方針、公開の予定と有効の期限、廃止、公開の範囲（読める人・書ける人）、既知のエラーの記事、評価・旗・フィードバックのタスク、閲覧の数、自己解決の事象と指標。
- 扱わない：全文検索の索引と日本語の解析器（`search.md`。この文書は「索引に入れてよい版」と ACL の約束だけを書く）、ポータルの画面（`portal-and-ui.md`）、多言語の翻訳の版（持ち越し）、匿名の閲覧（MVP はログインを必須にする。[access-control.md](access-control.md) の 14 節）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| 記事の状態 | 下書き、レビュー、公開、廃止。版は「廃止の予定」「取り消し」の状態も持つ | 検索の結果の抜粋と二次の資料。公式の本文は未検証 |
| 公開の流れ | 即時の公開と、ナレッジベースの管理者の承認を経る公開の 2 つの既定の流れがある。却下されると下書きに戻る | コミュニティの記事（[Knowledge - Approval Publish workflow](https://www.servicenow.com/community/developer-forum/knowledge-approval-publish-workflow-articles-gets-stuck-in-draft/m-p/2467884)）。未検証 |
| 版 | 版の番号は「主.副」。公開前の編集は副（0.01 ずつ）、公開で主の番号が上がる。公開済みの記事を編集すると、新しい下書きの版ができる（チェックアウト） | コミュニティの記事と KB の抜粋（[Versioning in Knowledge Management – FAQ KB0713200](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0713200)）。公式の本文（[Article versioning](https://www.servicenow.com/docs/bundle/yokohama-servicenow-platform/page/product/knowledge-management/concept/article-versioning.html)）は検索の結果で存在だけ確認。未検証 |
| 評価とフィードバック | 「役に立ったか（はい・いいえ）」と 1〜5 の星。旗（要見直し）は理由のコメントが必須で、持ち主のグループへのフィードバックのタスクになる。役に立たない・低い星でタスクを作る設定がある | コミュニティの記事（[Knowledge Feedback Tasks](https://www.servicenow.com/community/developer-forum/knowledge-feedback-tasks-are-created-when-article-is-flagged-or/m-p/2618219) など）。未検証 |
| 既知のエラーの記事 | 問題の原因と回避策から、1 回の操作で既知のエラーの記事を作る | 検索の結果の抜粋（[Problem Management data sheet](https://www.servicenow.com/content/dam/servicenow-assets/public/en-us/doc-type/resource-center/data-sheet/problem-management-data-sheet.pdf)）。本文は未検証 |
| 自己解決の計測 | ポータルの報告のフォームで、入力に合う記事を示し、記事の閲覧・クリックを計測の表に残す | [KB0712999](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0712999)（検索の結果の抜粋）。未検証 |

- 本家の版の番号の形（主.副）は採らない（3.2 節）。本家のテーブルの名前、状態の値は写さない。
- ITIL 4 のナレッジ管理のプラクティスの原典は確かめていない（未検証）。この文書の業務の流れは実務の一般的な形である。

## 3. 記事と版（[ADR-0031](../decisions/0031-knowledge-articles-versions-and-publishing.md)）

### 3.1 表

| 表 | 列 |
| --- | --- |
| `kb_base` | `tenant_id`、`id`、`stable_key`、`name`、`owner_group_id`、`publish_policy`（`instant` / `approval`）、`retire_policy`（`instant` / `approval`）、`readers_audience_id`、`contributors_audience_id`、`self_approval_allowed`（既定 偽）、`review_interval_days`（既定 365）、`active` |
| `kb_category` | `tenant_id`、`id`、`kb_base_id`、`parent_id`（深さ 4）、`name`、`order` |
| `kb_article` | `tenant_id`、`id`、`number`（接頭辞 `KB`）、`kb_base_id`、`category_id`、`owner_group_id`、`author_id`、`published_version_id`、`draft_version_id`、`state`（導出。3.4 節）、`audience_id`（任意。ナレッジベースより狭くするだけ）、`kind`（`general` / `known_error` / `how_to`）、`source_task_id`（問題など）、`valid_to`、`next_review_at`、`view_count`、`helpful_yes`、`helpful_no`、`rating_sum`、`rating_count`、`version` |
| `kb_article_version` | `tenant_id`、`id`、`article_id`、`version_no`、`state`（3.3 節）、`title`、`body`（制限付きの Markdown）、`keywords`、`language`（`ja` / `en`）、`content_hash`、`checked_out_by`、`checked_out_at`、`submitted_at`、`published_at`、`published_by`、`retired_at`、`approval_set_id`、`change_note` |

- `kb_article` は記事の同一性（番号、評価の合計、ナレッジベース）を持ち、`kb_article_version` が本文を持つ。
- **1 つの記事に、公開中の版は高々 1 つ、編集中（`draft`・`review`）の版も高々 1 つ。** 部分一意索引で守る：`(tenant_id, article_id) WHERE state = 'published'`、`(tenant_id, article_id) WHERE state IN ('draft', 'review')`。
- 番号は記事ごとに 1 つ（版で変えない）。依頼者や担当者が「KB0001234 を見て」と伝える番号を安定させる。

### 3.2 版の番号

- 版は `version_no`（1, 2, 3 …）の整数だけにする。下書きの保存ごとに番号を上げない（下書きの中の変更は監査の履歴に残る）。
- 本家の「主.副」は採らない。副の番号は公開前の保存の回数を示すが、監査の履歴で同じことが分かり、利用者には「今の公開は何版目か」だけが要るためである。

### 3.3 版の状態（DT-KB-001）

| # | 前 | 後 | 操作 | 主体・条件 | 効果 |
| --- | --- | --- | --- | --- | --- |
| 1 | - | `draft` | `create`・`checkout` | 書ける人（`contributors_audience` に合う、または `knowledge_admin`）。`checkout` は公開中の版から本文を写し、記事に編集中の版がないとき | `checked_out_by = 主体`、`draft_version_id` |
| 2 | `draft` | `draft` | `edit` | `checked_out_by = 主体`、または `knowledge_admin`（奪うときは前の人に知らせる） | 本文の更新 |
| 3 | `draft` | `review` | `submit` | 本文とタイトルが空でない。`publish_policy = approval` | 本文を固定（`content_hash`）、承認の依頼（4 節） |
| 4 | `draft` | `published` | `publish` | `publish_policy = instant`、主体が書ける人 | 5 行と同じ公開の効果 |
| 5 | `review` | `published` | system（承認の決着が `approved`） | 版の `content_hash` が承認の依頼の時と同じ | 前の公開の版を `outdated`、`published_version_id` を付け替え、`draft_version_id` を空、索引への反映（outbox） |
| 6 | `review` | `draft` | system（承認の却下）・`withdraw`（著者） | - | 承認を取り消す（`withdraw` のとき） |
| 7 | `published` | `pending_retirement` | `retire` | `retire_policy = approval`、`knowledge_admin` か持ち主のグループ | 承認の依頼 |
| 8 | `published`・`pending_retirement` | `retired` | `retire`（`instant`）・system（承認の決着・`valid_to` のタイマー） | - | `published_version_id` を空、索引から外す |
| 9 | `draft` | `cancelled` | `discard` | 著者か `knowledge_admin` | `draft_version_id` を空 |
| 10 | `outdated`・`retired`・`cancelled` | どれも | - | - | 変わらない。前の版を戻すときは、その本文から新しい `draft` を作る（`checkout` の元に選べる） |
| 11 | そのほか | | | | 422 `invalid_transition` |

- **`review` の版の本文は変えない。** 承認者が見た本文と公開する本文を同じにするため、5 行で `content_hash` を確かめる。直すときは `withdraw` で `draft` に戻す。
- 公開の版の本文は変えない（誤字も新しい版で直す）。ただし `knowledge_admin` の「軽微な修正」（`minor_fix`）は、公開中の版から新しい版を作って即時に公開する操作を 1 回で行う（承認の方針を飛ばすので、監査の履歴に理由を残す）。MVP に入れるかは E9 で決める（12 節）。

### 3.4 記事の状態（導出）

| 条件 | `kb_article.state` |
| --- | --- |
| `published_version_id` あり | `published` |
| なし、公開した版が 1 つ以上ある（すべて `retired`・`outdated`） | `retired` |
| なし、公開した版がない | `draft` |

### 3.5 本文

- 本文は制限付きの Markdown にする：見出し、段落、箇条書き、番号付きの箇条書き、表、コードのブロック、引用、太字・斜体、リンク（`https:` と、テナントの中の記事・カタログの品目へのリンクだけ）、画像（記事の添付ファイルだけ）。**HTML を受けない。** 描くときは許可の一覧のタグだけの HTML に変換し、サニタイズの後に出す。
- 本家からの移行で HTML の記事を取り込むときは、取り込みの道具で Markdown に変換する。変換できない要素（スクリプト、iframe、スタイル）は捨て、捨てたことを取り込みの結果に残す。
- 1 版の本文は 256 KB まで、添付は 1 記事 20 ファイル・各 25 MB まで。

## 4. 公開の流れ（[ADR-0031](../decisions/0031-knowledge-articles-versions-and-publishing.md)）

- `publish_policy = approval` の公開は、組み込みのフロー `kb_publish_approval` で行う：`ask_approval`（承認者：ナレッジベースの `owner_group_id` のメンバー、規則 `any`、期限 7 日、期限切れは `escalate` → 却下）。
- **著者の本人の承認は既定で禁止する**（[ADR-0016](../decisions/0016-approvals.md) の本人の承認の禁止）。`self_approval_allowed = true` のナレッジベース（小さなチームの内部の手順など）だけで外せる。著者が承認者のグループにいるときは、その人の承認の行を作らない。
- 廃止の承認（`retire_policy = approval`）も同じフローの形で行う。
- 承認のテーブル（`kb_article_version`）は `requires_explicit_approval` にしない。期限切れの自動の承認は選べるが、組み込みのフローでは使わない（ナレッジの誤りは変更ほど重くないが、既定は安全な側にする）。

### 4.1 有効の期限と見直し

- `valid_to`（任意）の時刻に、廃止のタイマー（`run_step`、組み込みのフロー）を登録する。発火で 8 行の `retire` を行う（承認の方針を通さない。期限は公開の時に承認されたもの）。
- `next_review_at = published_at + review_interval_days`。日次のジョブが、見直しの時期の来た記事ごとに、持ち主のグループへ見直しのタスク（`kb_feedback_task`、`reason = periodic_review`）を 1 件作る（開いているものがあれば作らない）。

## 5. 既知のエラーの記事

- 問題の `known_error = true`（[itsm-processes.md](itsm-processes.md) の 7.2 節）の後、担当者の操作 `publish_known_error_article` で、`kind = known_error` の記事の `draft` を作る。本文の雛形：症状（問題の短い説明と説明）、影響を受けるサービス・CI、回避策（`workaround`）、原因（`cause_notes`、空なら「調査中」）、状況（問題の状態）。
- 記事は `source_task_id` で問題を指す。公開の流れは、記事のナレッジベースの方針に従う（既知のエラーのための専用のナレッジベースを既定で 1 つ作る。`publish_policy = approval`、持ち主は `problem_manager` のグループ）。
- 問題の `workaround`・`cause_notes`・状態が変わったら、記事の持ち主のグループに「記事の更新の候補」を知らせる。**自動で新しい版の草案を作らない。** 編集中の版があるとき（部分一意索引）にぶつかるのを避け、人が本文を確かめてから公開するためである。
- 問題が `closed`（恒久の対策の後）になったら、記事の持ち主のグループに見直しのタスクを作る（廃止か、「解決済み」への書き換えか）。

## 6. 公開の範囲

- 読める人：ナレッジベースの `readers_audience_id` に合い、記事に `audience_id` があればそれにも合う人。`audience` の意味は [service-catalog-and-requests.md](service-catalog-and-requests.md) の 6.1 節と同じ（除くが勝つ、含むが空なら誰も読めない）。
- 読めるのは `published` の版だけ（`requester`）。`draft`・`review`・`outdated`・`retired` の版は、書ける人、承認者（自分の承認の対象の版）、`knowledge_admin` だけ。
- ACL の組み込みの規則として書き（`kb_article`・`kb_article_version` の `read` の `allow_if`）、条件は主体の属性と記事の列だけで SQL の述語にコンパイルできる（[ADR-0012](../decisions/0012-acl-enforcement-at-every-exit.md)）。リスト・件数・検索・通知の出口は、同じ述語を使う（[access-control.md](access-control.md) の 6.2 節）。
- 検索の索引（`search.md`）には、公開中の版だけを入れ、索引の文書に `kb_base_id`・`audience_id` を持たせる。索引で絞った後に、返す直前に判定の関数で確かめ直す（DT-ACL-003 の 9 行）。
- 内部だけの記事（担当者向けの手順）は、`readers_audience` を `agent` のロールに限ったナレッジベースに置く。

## 7. 評価・フィードバック・自己解決（[ADR-0032](../decisions/0032-knowledge-feedback-and-deflection.md)）

### 7.1 評価

| 表 | 列 |
| --- | --- |
| `kb_rating` | `tenant_id`、`article_id`、`version_id`、`user_id`、`helpful`（真偽・空）、`stars`（1〜5・空）、`updated_at`。一意 `(tenant_id, version_id, user_id)` |
| `kb_flag` | `tenant_id`、`id`、`article_id`、`version_id`、`user_id`、`reason`（`outdated` / `incorrect` / `unclear` / `broken_link` / `other`）、`comment`（必須、2,000 文字まで）、`task_id`、`created_at` |
| `kb_feedback_task` | `task` の子のクラス。`article_id`、`reason`（`flag` / `low_rating` / `periodic_review` / `source_changed`）、`flag_count` |

- 評価は利用者・版ごとに 1 件で、送り直しは上書きする（`INSERT … ON CONFLICT DO UPDATE`）。記事の `helpful_yes`・`helpful_no`・`rating_sum`・`rating_count` は、同じトランザクションで差分を足す（上書きのときは前の値を引いて新しい値を足す）。
- 新しい版を公開しても、前の版の評価は記事の合計に残す。版ごとの評価は `kb_rating` から集計できる。

DT-KB-002（フィードバックのタスク）：

| # | 事象 | 記事に開いている `kb_feedback_task`（同じ `reason` の系統） | 結果 |
| --- | --- | --- | --- |
| 1 | 旗 | なし | タスクを作る（持ち主のグループ、`flag_count = 1`）、旗の `task_id` |
| 2 | 旗 | あり | 既存のタスクに旗を足す（`flag_count += 1`、作業メモに旗の理由） |
| 3 | 評価（役に立たない、または星 1・2） | なし、かつ公開の版の直近 30 日の「役に立たない」の割合 ≥ 50% かつ件数 ≥ 5 | `low_rating` のタスクを作る |
| 4 | 評価（同上） | あり | 何もしない |
| 5 | そのほかの評価 | - | 何もしない |

- 1 件の低い評価ごとにタスクを作らない（本家には 1 件でタスクを作る設定がある。2 節）。持ち主のグループのタスクが、少数の評価で溢れるのを避ける。旗は理由が必須で、明確な指摘なので 1 件でタスクにする。
- 同じ利用者の同じ版への旗は、1 日に 1 件まで。

### 7.2 閲覧の数

- 閲覧は、ポータル・作業の画面で記事を開いた事象（7.3 節）から、非同期に集計して `view_count` に足す（1 利用者・1 記事で 1 時間に 1 回まで数える）。閲覧のたびに記事の行を更新しない（人気の記事の行の書き込みの集中を避ける）。

### 7.3 自己解決の事象

| 事象 | 中身 |
| --- | --- |
| `portal.search` | 検索の語の長さ・結果の件数（語そのものは保存しない。7.4 節） |
| `kb.suggested` | フォームの入力の途中に出した候補の記事の ID の一覧 |
| `kb.viewed` | 記事の ID、どこから（検索・候補・リンク） |
| `kb.resolved` | 記事の「これで解決した」の押下 |
| `form.started` | 品目の ID（報告のフォームなど） |
| `form.submitted` | 品目の ID、作ったレコードの ID |

- 事象は `portal_event(tenant_id, session_id, seq, kind, item_id?, article_id?, at)` に書く。`session_id` はポータルのセッションごとに作る乱数で、利用者の ID を入れない（7.4 節）。事象は日ごとのパーティションで 90 日保つ。
- 書き込みは、画面から一括で送り（最大 50 件・5 秒ごと）、`(session_id, seq)` の一意で重複を捨てる。

### 7.4 自己解決の数え方（DT-KB-003）

`form.started` の各セッション × 品目の組を「機会」とし、その後 30 分の事象で判定する。

| # | 30 分の中の事象 | 判定 |
| --- | --- | --- |
| 1 | `kb.resolved` あり | 明示の自己解決（`explicit`） |
| 2 | `form.submitted` あり | 自己解決でない（`submitted`） |
| 3 | `kb.viewed`（`kb.suggested` の記事、またはフォームの開始の後の検索から）あり、`form.submitted` なし | 推定の自己解決（`implied`） |
| 4 | どれもなし | 離脱（`abandoned`） |

- 1 は 2 より先に評価する（解決したと押した後に、別の件で申請することがある）。表の順は `spec.md` で確定する。
- 指標：自己解決の率 ＝（`explicit` ＋ `implied`）÷ 機会。`explicit` だけの率も並べて出す（`implied` は過大に見積もりうるため）。K8 は計測できることを求め、目標の値は E9 で決める（[intent.md](../intent.md)）。
- 判定は、セッションの事象の集合から決まる純粋な関数にする（事象の到着の順によらない。PROP-KB-004）。日次のジョブで、前日までの機会を判定し、品目・記事ごとの集計の表 `deflection_daily` に書く。
- **個人の追跡をしない。** 事象に利用者の ID と検索の語を入れない。記事の評価（7.1 節）は利用者の ID を持つが、自己解決の指標とは結び付けない。検索の語の分析（よく検索されるのに記事がない語）は `search.md` で、語を集計した形でだけ持つ（持ち越し）。

## 8. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 同じ記事の 2 人の同時の `checkout` | 部分一意索引で後のほうが 409 `draft_exists`（誰が編集中かを返す） |
| 承認の決着と著者の `withdraw` が同時 | 版の行の版の番号で、先にコミットしたほうが効く。`withdraw` が先なら承認の決着は何もしない |
| 公開の直後の索引への反映の遅れ | 公開は DB で確定する。検索に出るまで数秒遅れる。記事の番号での直接の表示は即時 |
| `valid_to` のタイマーと手での新しい版の公開が同時 | 公開の版が変わっていれば、タイマーは版の条件で何もしない（新しい版は新しい `valid_to` を持つ） |
| 事象の送信の失敗 | 画面が再送する（`seq` で重複を捨てる）。失われた事象は指標の誤差として受け入れる |
| 評価の合計と `kb_rating` のずれ | 日次の突き合わせのジョブで直し、ずれの件数を記録する |

## 9. セキュリティ

- 本文は制限付きの Markdown だけで、描く前にサニタイズする（3.5 節）。外へのリンクは `rel="noopener noreferrer"`、`https:` だけ。
- 画像は記事の添付だけで、署名付き URL（5 分）で出す（[access-control.md](access-control.md) の 6.2 節の 15 行）。記事を読めない人には添付も出さない。
- 読める範囲は ACL の述語で、検索・通知を含むすべての出口で同じ（6 節）。内部の記事が検索の候補（ポータルのフォーム）に出ないことを、出口ごとの試験で確かめる。
- 旗のコメントは利用者の入力で、持ち主のグループだけが読む。表示のときはエスケープする。
- 自己解決の事象は仮名のセッションで、利用者の ID と検索の語を持たない（7.4 節）。
- 既知のエラーの記事は、問題の内部の情報（作業メモ、担当者）を写さない。雛形は 5 節の項目だけ。

## 10. テスト

### 10.1 決定表

- DT-KB-001（版の状態）、DT-KB-002（フィードバックのタスク）、DT-KB-003（自己解決の判定）と否定の表を、`spec.md` から読む表駆動テストにする。

### 10.2 性質ベーステスト（fast-check）

- **PROP-KB-001（版の数）**：任意の操作の列（並行を含む）で、どの時点でも、1 つの記事の `published` の版は高々 1 つ、`draft`・`review` の版も高々 1 つ。
- **PROP-KB-002（承認した本文を公開する）**：任意の編集・提出・取り下げ・承認の列で、`published` になった版の `content_hash` は、その版の承認の依頼の時の `content_hash` と同じ。
- **PROP-KB-003（読める範囲）**：任意の記事・版・`audience` と主体で、主体が読める版は `published` で、ナレッジベースと記事の `audience` の両方に合うものだけ（リスト・件数・検索の出口）。
- **PROP-KB-004（自己解決の判定の決定性）**：任意のセッションの事象の集合で、到着の順と重複（同じ `seq` の再送）によらず、DT-KB-003 の判定は同じ。
- **PROP-KB-005（評価の合計）**：任意の評価の送信・上書きの列（並行を含む）の後で、記事の `helpful_yes`・`helpful_no`・`rating_sum`・`rating_count` は `kb_rating` の集計と一致する。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E9 | `kb-bases-and-categories` | 3.1 節の `kb_base`・`kb_category`、`audience` |
| E9 | `kb-articles-and-versions` | 3.1〜3.4 節、DT-KB-001（PROP-KB-001） |
| E9 | `kb-markdown-rendering` | 3.5 節、サニタイズ、本家の HTML からの変換の道具 |
| E9 | `kb-publish-approval` | 4 節、組み込みのフロー（PROP-KB-002） |
| E9 | `kb-validity-and-review` | 4.1 節 |
| E9 | `kb-read-acl` | 6 節（PROP-KB-003。access-control・search と一緒に） |
| E9 | `kb-ratings-and-flags` | 7.1・7.2 節、DT-KB-002（PROP-KB-005） |
| E9 | `portal-deflection-events` | 7.3 節（portal-and-ui と一緒に） |
| E9 | `deflection-metrics` | 7.4 節、DT-KB-003（PROP-KB-004） |
| E9 | `known-error-articles` | 5 節（itsm-processes と一緒に。記事の基盤ができた後） |
| E9 | `catalog-form-kb-suggestions` | 品目の入力の途中の候補の記事（service-catalog-and-requests の 7 節と一緒に。ナレッジの検索ができた後） |
| E11 | `kb-reports` | 閲覧・評価・自己解決の率のダッシュボード（reports と一緒に） |

## 12. 未解決の問い

### 決定（2026-09-28、既定案）

- **記事の行と版の行に分け、公開中と編集中の版をそれぞれ高々 1 つにする**（3.1 節、ADR-0031）。
- **版の番号は整数だけにし、主.副の形を採らない**（3.2 節）。
- **レビューに出した版の本文を固定し、承認した本文だけを公開する**（3.3 節）。
- **本文は制限付きの Markdown だけ**（3.5 節）。
- **著者の本人の承認を既定で禁止する**（4 節）。
- **問題の変更で記事の草案を自動で作らず、持ち主に知らせる**（5 節）。
- **低い評価は割合と件数のしきい値でタスクにし、旗は 1 件でタスクにする**（7.1 節、ADR-0032）。
- **自己解決は明示と推定を分けて数え、推定は記事の閲覧の後 30 分に申請がないこと**（7.4 節）。
- **自己解決の事象に利用者の ID と検索の語を入れない**（7.4 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 多言語の記事（日本語と英語の版の組） | E9 の後。翻訳の版のモデルを別の変更で |
| `knowledge_admin` の軽微な修正の即時の公開 | E9 の利用者の調査で（3.3 節） |
| 匿名の閲覧（社外への公開） | MVP の後。公開のポータルと一緒に |
| 自己解決の目標の値と、推定の判定の時間（30 分） | E9 の計測（K8） |
| 検索の語の分析（記事のない語） | `search.md` で、集計の形で |
| 本家の既定の値（旗・低い評価のタスクの作り方、版の番号） | 本家の公式の本文で確かめられたら 2 節を直す |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 自己解決の率（明示・推定、品目別）と、その推移（K8）。
- 公開の承認の滞留（`review` の日数）と、期限切れの割合。
- 見直しの時期を過ぎた公開の記事の件数。
- 旗・低い評価のタスクの件数と、解決までの時間。
- 読める範囲の漏れの試験の結果（内部の記事が依頼者の検索・候補に出ない。K6）。
- 評価の合計の突き合わせのずれの件数（常に 0 が目標）。

### runbooks

- `kb-article-wrongly-published.md`：誤った記事・内部の情報を含む記事を公開したときの止め方（即時の廃止、索引からの削除の確かめ、見た人の範囲の調べ方）。
- `kb-approval-backlog.md`：公開の承認の滞留の解き方（承認者の付け替え、引き上げ）。
- `deflection-job-failure.md`：自己解決の集計のジョブの失敗と、やり直し（判定は冪等）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `kb_base`、`kb_category` | 3.1 節。メタデータ |
| Aurora `kb_article`、`kb_article_version` | 3.1 節。部分一意索引 2 つ。監査の対象 |
| Aurora `kb_rating`、`kb_flag` | 7.1 節 |
| Aurora `task`（クラス `kb_feedback_task`） | 7.1 節 |
| Aurora `portal_event`（日ごとのパーティション、90 日） | 7.3 節。`(tenant_id, session_id, seq)` 一意 |
| Aurora `deflection_daily` | 7.4 節。品目・記事・日ごとの集計 |
| OpenSearch 記事の索引 | 公開中の版だけ。`kb_base_id`・`audience_id` を持つ（`search.md`） |

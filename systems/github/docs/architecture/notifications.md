# Notifications: GitHub

通知の購読、受け手の決定、配信（Web の受信箱、メール）、メールへの返信。受け手の決定と配信の流れは [ADR-0016](../decisions/0016-notification-fanout.md) で決めた。Worker の土台（outbox → SQS）は Slack の [ADR-0014](../../../slack/docs/decisions/0014-sqs-worker-queues-and-notification-delivery.md) と同じ考え方を取る。

本家の振る舞いに寄せる。本家の文書で確かめられなかった点は「未検証」と書く。モバイルの push は MVP の範囲外（GitHub Mobile に相当するものを作らない）。

## 1. 用語

| 用語 | 意味 |
| --- | --- |
| スレッド | 通知の単位。Issue、Pull Request、リリース、ワークフローの実行（Actions） |
| 購読 | 人とスレッドの関係（`subscribed` か `ignored`） |
| watch | 人とリポジトリの関係（watch の水準） |
| 理由（reason） | その人に通知が届いた理由。1 つの通知に 1 つ |
| 受信箱 | Web の通知の一覧。1 人 1 スレッドにつき 1 行 |

## 2. 購読のモデル

### 2.1 リポジトリの watch

本家の watch の設定（[通知の設定](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications)）に合わせる。

| 水準 | 届くもの |
| --- | --- |
| Participating and @mentions（既定） | 参加しているスレッドと、メンションだけ |
| All Activity | リポジトリのすべてのスレッドの新しい活動 |
| Custom | 参加・メンションに加え、選んだ種類（Issue、Pull Request、リリース）の活動 |
| Ignore | 何も届けない |

- `repo_watches (user_id, repo_id, level, custom_events, created_at)`。行がなければ既定の水準。
- 自動の watch：自分の個人のアカウントで作ったリポジトリは自動で watch する。push の権限を持つリポジトリ（fork を除く）を自動で watch する設定を持つ（[通知について](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/about-notifications)）。後者は既定で有効にする（本家の設定の画面の既定に合わせる。2026-09-26 の決定）。チームに入ったときに、チームのリポジトリを自動で watch することはしない（本家の「チームの自動の watch」は、チームの告知の購読であり、リポジトリの watch ではないため）。
- Ignore の人には、メンションでも届けない（画面の文言「Never be notified」に合わせる。本家の文書は「完全に無視する」とだけ書き、メンションの扱いを個別に述べていない。2026-09-26 に確認。**未検証**。E5 で本家を観測して合わせる）。
- Security alerts と Discussions の種類は、その機能が MVP にないので持たない。

### 2.2 スレッドの購読

- `thread_subscriptions (user_id, thread_id, state, reason, created_at)`。`state` は `subscribed` か `ignored`。
- 次のときに自動で `subscribed` にする（本家の「参加」の定義。[通知について](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/about-notifications)）。すでに `ignored` なら変えない。
  - Issue・Pull Request を開いた
  - コメントした
  - メンションされた
  - 担当になった
  - レビューを求められた
  - 状態を変えた（閉じた、マージした）
- 手で購読したもの（`manual`）、手で購読をやめたもの（`ignored`）を持つ。`ignored` のスレッドには、その後にメンションされるか参加するまで届けない（REST API の `ignored` の説明。[REST API の通知](https://docs.github.com/en/rest/activity/notifications)）。本設計では、メンション・参加で `ignored` を `subscribed` に戻す。

### 2.3 理由

本家の REST API の `reason`（[REST API の通知](https://docs.github.com/en/rest/activity/notifications)）のうち、MVP の機能に対応するものを持つ。1 つのイベントで 1 人に複数の理由が当たるときは、上の行を優先する（優先の順は本設計のもの）。本家の `reason` はスレッドごとに 1 つで、最新の通知の理由に替わるが、一度 `mention` になったら `mention` のまま残る（[REST API の通知](https://docs.github.com/en/rest/activity/notifications)、2026-09-26 に確認）。複数の理由が同時に当たるときの順は公開されていない（**未検証**）。本設計も、スレッドの `reason` は `mention` を保つ規則を本家に合わせる。

| 優先 | reason | 条件 | 区分 |
| --- | --- | --- | --- |
| 1 | `review_requested` | 本人か、本人の属するチームにレビューが求められた | 参加 |
| 2 | `assign` | 担当になった | 参加 |
| 3 | `mention` | 本人がメンションされた | 参加 |
| 4 | `team_mention` | 本人の属するチームがメンションされた | 参加 |
| 5 | `author` | スレッドを作った | 参加 |
| 6 | `comment` | スレッドにコメントした | 参加 |
| 7 | `state_change` | スレッドの状態を変えた | 参加 |
| 8 | `manual` | 手で購読した | 参加 |
| 9 | `ci_activity` | 本人が起こしたワークフローの実行が終わった（[actions.md](actions.md)） | 参加 |
| 10 | `subscribed` | リポジトリを watch している | watch |

「参加」と「watch」の区分は、配信の経路の設定（5 節）で使う。

## 3. 受け手の決定

1 つのイベント（例：`issue_comment.created`）について、受け手の候補を次の和集合で作り、除外を引く。

```
候補 = スレッドの subscribed の人
     ∪ 新たにメンション・担当・レビュー依頼された人（この時に購読も作る）
     ∪ リポジトリを All Activity で watch している人
     ∪ リポジトリを Custom で watch していて、種類が合う人
除外 = 行為者本人（「自分の更新」を受け取る設定の人は、メールだけ残す。5 節）
     ∪ スレッドを ignored にしている人
     ∪ リポジトリを Ignore にしている人
     ∪ 行為者をブロックしている人（ブロックした人の行為による通知は届けない。2026-09-26 の決定）
     ∪ リポジトリを読めない人（下の「権限の確かめ直し」）
```

- **メンションの解決**：`@user` は、その人がリポジトリを読めるときだけ受け手にする。読めない人をメンションしても通知せず、購読も作らない。`@org/team` は、チームのメンバーのうちリポジトリを読める人に展開する。1 つの本文で受け手にするメンションは 50 人まで（本設計の値。本家は上限を公開していない。2026-09-26 に確認。**未検証**）。チームのメンションは、メンバーの数をこれに数えない。
- **権限の確かめ直し**：受け手の全員について、配信の直前に ADR-0002 の判定関数で `can(user, issues:read, thread)`（Pull Request は `pull_requests:read`、リリースと Actions は `contents:read`・`actions:read`）を確かめる。数千人を 1 人ずつ判定しないよう、「1 つのリポジトリ × 多数の利用者」の一括の判定 `filterActorsCanRead(actors, action, resource)`（[identity-and-permissions.md](identity-and-permissions.md) の 5.1 節）を使う。1,000 人ごとの分割（4 節）の単位で呼ぶ。イベントから処理までの間に外された人には送らない。
- **行為者が Bot・App** の場合も、行為者本人は除く。

## 4. パイプライン

```
API ─tx─▶ outbox ─▶ Relay ─▶ SQS notify-events ─▶ planner（受け手の決定）
                                                     │ 受け手が 1,000 人を超えたら分割
                                                     ├──▶ SQS notify-fanout ─▶ planner（分割の続き）
                                                     ├──▶ 受信箱の upsert（Aurora）
                                                     └──▶ SQS notify-email ─▶ メールの送信 ─▶ SES
SES の受信 ─▶ S3 ＋ SNS ─▶ SQS inbound-email ─▶ 返信の取り込み ─▶ コメントの作成（通常の API の経路）
SES のイベント（バウンス・苦情）─▶ SNS ─▶ SQS email-feedback ─▶ アドレスの状態の更新
```

- Relay、SQS の標準キュー、デッドレターキュー（`maxReceiveCount` = 5）、「メッセージには ID だけを入れ、本体は Worker が DB から読む」は Slack の ADR-0014 と同じ。
- **planner** は、イベントの本体と候補を DB（reader）から読み、3 節の規則で受け手と理由を決め、受け手ごとに 5 節の設定で経路を決める。
- **分割**：受け手が 1,000 人を超えるとき（人気のリポジトリのリリース、All Activity の watch が多いリポジトリ）は、受け手の ID の範囲で分けて `notify-fanout` に積む。`notify-fanout` を別のキューにして、大人数の通知が、レビュー依頼やメンションを待たせないようにする。
- **受信箱の書き込み** は、1,000 人ごとに 1 つの `INSERT ... ON CONFLICT` でまとめて書く（6 節）。
- **メール** は 1 受け手 1 ジョブにする。本家は通知を遅らせずに 1 件ずつメールにする（一般の通知のまとめのメールは、本家の文書にない。[Configuring notifications](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)、2026-09-26 に確認）。本設計も遅らせずに送り、7 節の上限を超えたときだけまとめる。

### 4.1 遅延の目標

| 区間 | 目標（S1） |
| --- | --- |
| イベント → 受信箱に見える | p95 10 秒以内 |
| イベント → SES に渡す（メール） | p95 30 秒以内（上限でまとめたものを除く） |

NFR-011（[README.md](README.md) の 3 節）は、Web の受信箱 p95 30 秒以内、メール（SES に渡すまで）p95 5 分以内とした（2026-09-26 の決定）。上の表は、NFR-011 に余裕を持たせた設計の目標である。

## 5. 経路の設定

本家は「参加」と「watch」のそれぞれで、Web とメールを選ばせる（[通知の設定](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications)）。

| 設定 | 値 | 既定（本設計） |
| --- | --- | --- |
| 参加の通知 | Web / メール（両方可） | 両方 |
| watch の通知 | Web / メール（両方可） | Web だけ |
| Actions の通知 | Web / メール、失敗だけか | Web とメール、失敗だけ |
| メールで受け取る活動 | Issue・Pull Request のコメント / レビュー / Pull Request への push / 自分の更新 | 自分の更新以外 |
| 既定のメールアドレス | 検証済みのアドレス | 主のアドレス |
| Organization ごとの宛先 | Organization ごとに検証済みのアドレス | なし |

- `user_notification_prefs` と `user_org_email_routes (user_id, org_id, email_id)` に置く。
- **Organization のドメインの制限**（E10。本家でも企業向けの機能なので、MVP には含めない。2026-09-26 の決定）：Organization がメールの宛先を承認したドメインに制限していたら、そのドメインの検証済みのアドレスがない人には、その Organization のリポジトリのメールを送らない（本家の機能。[通知の設定](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications)）。Web の受信箱には届ける。
- 経路の決定は、表駆動テストで確かめる（決定表として spec に取り込む）。

## 6. 受信箱

### 6.1 保存

```sql
CREATE TABLE notification_inbox (
  user_id bigint, thread_id bigint, repo_id bigint,
  subject_type text, reason text,
  unread boolean, saved boolean, done boolean,
  last_event_id bigint,           -- 最後に反映したイベント（バージョン）
  updated_at timestamptz, last_read_at timestamptz,
  PRIMARY KEY (user_id, thread_id)
) PARTITION BY HASH (user_id);    -- 64 分割
CREATE INDEX ON notification_inbox (user_id, done, updated_at DESC);
```

- 1 人 1 スレッドに 1 行。新しいイベントで `reason`・`updated_at` を更新し、`unread = true`、`done = false` に戻す（Done にしたスレッドも、新しい活動で受信箱に戻る）。
- 書き込みは `last_event_id` を比べ、古いイベントで新しい状態を上書きしない。SQS の重複と順序の入れ替わりに耐える。
- 保持：Saved でない通知は 3 か月、Saved は無期限（[通知について](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/about-notifications)）。毎日のジョブで、`updated_at` が 3 か月より古く Saved でない行を消す。
- S1 はメタデータの Aurora に置く。書き込みの量（1 件のコメント × watch の数）がメタデータの writer を圧迫したら、通知だけの Aurora のクラスタに分ける。S2 で DynamoDB へ移すかは未解決の問い。

### 6.2 読み出し

- 一覧は `(user_id, done, updated_at DESC)` でキーセットのページングを行う。
- **一覧を返す前に、行の `repo_id` の集合を判定関数（`canMany`）で一括に確かめ、読めないリポジトリの行は返さない。** 権限を失ったリポジトリの通知が、題名だけでも残らないようにする。落とした行は、次の掃除のジョブで消す。
- 題名などの表示は、通知の行ではなく、スレッド（Issue など）を通常の経路で読んで作る（通知の行に本文の写しを持たない）。
- REST API は、本家に合わせて `Last-Modified` と `X-Poll-Interval`（既定 60 秒）を返し、変化がなければ 304 を返す（[REST API の通知](https://docs.github.com/en/rest/activity/notifications)）。
- 未読の件数は、`unread AND NOT done` の件数を数える。上限（例：1,000 件以上は「999+」）を置いて、数える費用を抑える。

## 7. メール

### 7.1 送信

- SES（東京リージョン）で送る。1 イベント × 1 受け手で 1 通。本文は HTML とプレーンテキストの両方（本家と同じ）。
- 送る直前に、もう一度確かめる：受け手がリポジトリを読めるか、コメント・Issue が削除されていないか、宛先のアドレスが停止されていないか（7.4 節）。外れたら送らない。
- 冪等性：`notification_deliveries (user_id, event_id, channel, state)` に主キーを置き、行を作れたときだけ送る。SES に渡した後、記録の前に落ちると 2 通送りうる。これは許容し、`Message-ID` をイベントと受け手から決めて、メールの側で同じ通知と分かるようにする。

### 7.2 ヘッダー

本家（[メールの通知のヘッダー](https://docs.github.com/en/subscriptions-and-notifications/reference/email-notification-headers)）に合わせる。ドメインは本設計のもの（以下 `example.dev`）。

| ヘッダー | 中身 |
| --- | --- |
| `From` | `行為者の表示名 <notifications@example.dev>` |
| `To` | `owner/repo <repo@noreply.example.dev>` |
| `Cc` | 理由を表すアドレス（`mention@noreply.example.dev` など） |
| `Reply-To` | 返信用のアドレス（7.3 節） |
| `List-Id` | `OWNER/REPOSITORY <REPOSITORY.OWNER.example.dev>` |
| `X-<Brand>-Reason` | 理由（本家の `X-<Brand>-Reason` に相当。名前は ADR-0006） |
| `Message-ID` / `In-Reply-To` / `References` | スレッドごとに固定の ID を親にし、メールソフトで 1 つの会話にまとまるようにする |
| `List-Unsubscribe`、`List-Unsubscribe-Post` | ワンクリックでそのスレッドの購読をやめる（`ignored` にする） |

- 本家は、メールを開いたら Web の通知を既読にする仕組み（`notifications@` からの画像の読み込み）を持つ（[通知の設定](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications)）。本設計でも、受け手ごとに署名した URL の 1×1 の画像で既読にする。署名には有効期限を付け、URL から利用者やリポジトリが分からないようにする。

### 7.3 メールへの返信

本家は、返信をコメントとして投稿する。`reply-to` のアドレスがスレッドとアカウントを表し、パスワードを再設定するまで有効である。署名と `>` の引用は取り除き、メールアドレスは `***@***.***` に置き換え、添付は取り込まず、コメントは最大 65,530 文字（[通知の設定](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications)）。これに合わせる。

- **アドレス**：`reply+<token>@reply.example.dev`。`token` は `(user_id, thread_id, credential_generation)` を、サーバーの鍵で MAC したもの（形式は本設計のもの。本家は形式を公開していない）。`credential_generation` はパスワードの再設定で増やすので、再設定で古いアドレスが無効になる。本家も、返信先のアドレスはスレッドとアカウントを表し、パスワードを再設定するまで有効だとしている（[Configuring notifications](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications)、2026-09-26 に確認）。鍵は Secrets Manager に置き、2 つの鍵を並行して受け付けて入れ替える。
- **受信**：SES の受信（東京リージョンで使える。[SES のエンドポイント](https://docs.aws.amazon.com/general/latest/gr/ses.html)）で `reply.example.dev` の MX を受け、本文を S3 に置き、SNS から SQS `inbound-email` に通知する。
- **取り込み**の手順：
  1. トークンを検証し、利用者とスレッドを得る。無効なら捨てる（送り主に返事をしない。後方散乱を避ける）。
  2. SES の受信の判定で、SPF か DKIM が通っていて、`From` のアドレスがその利用者の検証済みのアドレスであることを確かめる（本設計の追加の守り。転送されたメールのトークンの悪用を防ぐ。本家が行うかは文書にない。**未検証**。本家に寄せる対象ではなく、この設計の判断とする）。
  3. 判定関数で、利用者がそのスレッドにコメントできるかを確かめる（リポジトリの read、ロック、ブロック、Issue の機能の有無）。
  4. 本文を取り出す：プレーンテキストの部分を優先し、引用と署名を取り除き、メールアドレスを置き換え、65,530 文字で切る。空なら捨てる。
  5. 通常のコメントの作成の経路（API と同じ関数）で投稿する。`Message-ID` を冪等のキーにし、同じメールで 2 回投稿しない。
- 失敗した取り込み（権限なし、空）は記録だけする。利用者にはメールで知らせない（後方散乱を避ける。2026-09-26 の決定）。
- 受信のメールは、処理の後 7 日で S3 から消す。

### 7.4 バウンスと苦情

- SES のイベント（バウンス、苦情、配送）を SNS 経由で `email-feedback` に受け取る。
- ハードバウンス：そのアドレスを `bouncing` にし、送信を止める。Web で利用者に知らせ、アドレスを確かめ直したら戻す。
- ソフトバウンス：72 時間に 3 回で、24 時間止める（本設計の値）。
- 苦情：そのアドレスへの通知のメールを止め、設定の画面で知らせる。
- SES のアカウント単位の抑制リストも使う。
- 監視：SES はバウンス率 5% 以上で審査、10% 以上で送信の停止がありうる。苦情率は 0.1% 以上で審査、0.5% 以上で停止がありうる（[SES の審査の FAQ](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html)）。バウンス率 2%・苦情率 0.05% でアラートを出す（runbooks の「メールのバウンス」）。
- 通知のメールと、アカウントのメール（パスワードの再設定など）は、SES の構成セットと送信元のサブドメインを分け、通知の評判の悪化がアカウントのメールに及ばないようにする。

## 8. 上限とまとめ

| 対象 | 上限（S1 の初期値。本設計の値） | 超えたとき |
| --- | --- | --- |
| 1 受け手のメール | 1 分に 20 通、1 時間に 200 通 | その時間の残りの通知を、スレッドごとに 1 通の「N 件の更新」にまとめて、枠が空いたときに送る |
| 1 受け手・1 スレッドのメール | 1 分に 5 通 | まとめる |
| 1 リポジトリの fan-out | 1 イベントの受け手 10 万人 | 超えた分は受信箱だけにし、メールを送らない。runbooks に記録する |
| 1 行為者が生む通知 | 1 時間に 5 万件の受け手 | 超えたら遅らせ、濫用の検知（[security.md](security.md)）に回す |
| SES の送信レート | アカウントのクォータの 80% | 全体で遅らせる |

- 計数は Valkey のトークンバケットで行う。Valkey が使えないときは、制限なしで送る（Slack と同じく、通知を止めない方に倒す）。
- まとめのメールも、7.1 節の直前の確かめ直しを行う。

## 9. 失敗の扱い

Slack の [read-state-and-notifications.md](../../../slack/docs/architecture/read-state-and-notifications.md) の 10 節と同じ（可視性タイムアウト、デッドレターキュー、redrive、SES のスロットリングの再試行）。加えて：

| 失敗 | 扱い |
| --- | --- |
| 権限の判定関数が使えない | 送らずに再試行する（読めるか分からない人に送らない。取りこぼしより漏洩を避ける） |
| 受信箱の書き込みが遅れる | `notify-events` と `notify-fanout` の最古のメッセージの経過時間でアラートを出す |
| 返信の取り込みの失敗 | `inbound-email` のデッドレターキューへ。S3 の原本から再処理できる |

## 10. 監視する指標

- 各キューの可視メッセージ数、最古のメッセージの経過時間、デッドレターキューの件数
- イベントから受信箱・SES までの遅延（理由ごと）
- 受け手ごとの権限の確かめ直しで落とした件数（多ければ購読の掃除の漏れを疑う）
- SES のバウンス率・苦情率、停止中のアドレスの数
- 返信の取り込みの成功・拒否の件数（理由ごと）

## 11. テスト

- 漏洩テスト：リポジトリから外された人、読めない人へのメンション、非公開になったリポジトリの購読者に、受信箱・メールのどちらも届かない。受信箱の一覧に、読めないリポジトリの行が出ない。
- 性質ベーステスト：任意の重複・順序の入れ替わりを含むイベントの列で、受信箱の最終の状態が、最後のイベントを反映したものと一致する。1 イベントで 1 人に送るメールは最大 1 通。
- 決定表：受け手の決定（3 節）と経路（5 節）。
- 返信：トークンの改ざん、パスワードの再設定の後の古いトークン、`From` の不一致、ロックされたスレッド、引用と署名の除去。
- 障害注入：SQS・SES の失敗の後、通知が失われず、重複が許容の範囲に収まる。

## 12. 未解決の問い

設計の中で出た問いと、その決定。計測・PoC で決めるものは「持ち越し」に置く。

### 決定（2026-09-26、既定案）

- 通知の遅延を NFR-011 にした（4.1 節。Web の受信箱 p95 30 秒、メール p95 5 分）。
- 自動の watch：push の権限を得たリポジトリは既定で自動の watch、チームに入っただけでは watch しない（2.1 節）。
- ブロックした人の行為による通知は届けない（3 節）。
- 返信の取り込みの失敗は、利用者に知らせない（7.3 節）。
- Organization のメールのドメインの制限は E10（5 節）。
- **スレッドの `reason`**（2026-09-26 の本家の確認による追加）：本家と同じく、スレッドの `reason` は最新の通知の理由に替わるが、一度 `mention` になったら `mention` のまま残す（2.3 節）。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 受信箱の保存先を DynamoDB に移すか（6.1 節） | E10。S1 の受信箱の書き込みの量と、Aurora の writer への負荷を測って決める |

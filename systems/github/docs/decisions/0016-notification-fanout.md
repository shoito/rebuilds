---
status: accepted
date: 2026-09-26
---

# ADR-0016: 通知は、スレッドの購読とリポジトリの watch から受け手を決め、outbox → SQS の多段で配り、送る直前に権限を確かめ直す

## Context

Issue・Pull Request・リリース・ワークフローの実行の活動を、Web の受信箱とメールで知らせる（[intent.md](../intent.md)）。本家の通知には次の性質がある（[通知について](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/about-notifications)、[通知の設定](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github/setting-up-notifications/configuring-notifications)）。

- 受け手は、スレッドへの参加（作成、コメント、メンション、担当、レビュー依頼、状態の変更）と、リポジトリの watch（参加とメンションだけ／すべて／種類を選ぶ／無視）で決まる。
- 受信箱は、1 人 1 スレッドに 1 行で、新しい活動で未読に戻る。
- メールは活動ごとに送り、返信するとコメントになる。

人気のリポジトリでは、1 件のリリースやコメントが数万人への通知になる。非公開のリポジトリの内容は、権限を失った人に通知で漏れてはならない（intent.md）。Slack は同じ問題を、outbox → SQS の標準キューと、多段の冪等な処理で解いた（[Slack の ADR-0014](../../../slack/docs/decisions/0014-sqs-worker-queues-and-notification-delivery.md)）。

## Options

1. **イベントのたびに、購読と watch から受け手を決め（書き込みの時の fan-out）、受信箱に 1 人 1 スレッドの行を upsert する。outbox → SQS の多段で処理する**
2. 受信箱を持たず、読み出しの時に、購読と watch とイベントの記録から組み立てる（読み出しの時の fan-out）
3. 1 つの Worker が、受け手の決定から送信まで 1 回で行う

## Decision

1 を採用する。詳細は [notifications.md](../architecture/notifications.md) にある。

- **購読のモデル**：`repo_watches`（watch の水準）と `thread_subscriptions`（`subscribed` / `ignored`、理由）。参加すると自動で購読する。理由は本家の REST API の `reason` の語彙を使い、1 人 1 イベントで 1 つに決める。
- **パイプライン**：outbox → Relay → SQS `notify-events` → planner。受け手が 1,000 人を超えたら `notify-fanout` に分ける。受信箱は 1,000 人ごとにまとめて upsert する。メールは 1 受け手 1 ジョブで SES に渡す。
- **権限の確かめ直し**：受け手の決定のときと、メールを送る直前の 2 回、判定関数で読めるかを確かめる。受信箱の一覧を返すときも、`repo_id` を一括に判定し、読めないリポジトリの行を返さない。判定関数が使えないときは、送らずに再試行する（漏洩より遅れを選ぶ）。
- **冪等性**：受信箱はイベントの版（`last_event_id`）で古い更新を捨てる。メールは `(user_id, event_id, channel)` の記録を先に作れたときだけ送る。
- **メールへの返信**：返信用のアドレスに、利用者・スレッド・資格情報の世代を MAC したトークンを入れる。SES の受信 → S3 → SQS で取り込み、トークン・送信元の認証・`From` の一致・コメントの権限を確かめて、通常のコメントの作成の経路で投稿する。
- **上限**：受け手ごとのメールの数、1 イベントの fan-out の数に上限を置き、超えたらまとめるか、受信箱だけにする。
- 2 を採らない理由：本家の受信箱の振る舞い（Done、Saved、未読の件数、3 か月の保持）を、読み出しの時に組み立てると、読み出しが重くなり、件数の数え方も難しい。書き込みの量は、分割とまとめ書きで抑える。
- 3 を採らない理由：Slack の ADR-0014 と同じ。数万人分が可視性タイムアウトの中で終わらず、途中の失敗で全員分をやり直すことになる。

## Consequences

- 良くなること：
  - 受信箱の読み出しが、1 人の行を読むだけで済む。
  - 大人数の通知と、レビュー依頼・メンションの遅れが分かれる。
  - 権限を失った人へ、受信箱・メールのどちらでも内容が届かない。
- 悪くなること、引き受けるコスト：
  - 受信箱の書き込みが「活動 × 受け手」に比例する。メタデータの Aurora の writer を圧迫したら、通知だけのクラスタに分ける（S2 で DynamoDB への移行を検討する）。
  - 全ての段を冪等にし、重複と順序の入れ替わりのテストを持つ必要がある。
  - SES の評判（バウンス率・苦情率）の管理と、受信のメールの処理を運用する。

## Confirmation

- 性質ベーステスト：任意の重複・順序の入れ替わりを含むイベントの列で、受信箱の最終の状態が最後のイベントを反映したものと一致し、1 イベントで 1 人に送るメールは最大 1 通。
- 決定表：受け手の決定と、経路の設定（[notifications.md](../architecture/notifications.md) の 3 節と 5 節）。
- 漏洩テスト：リポジトリから外された人、読めない人へのメンション、非公開になったリポジトリの watch の人に、受信箱・メールのどちらも届かない。
- 返信のテスト：トークンの改ざん、パスワードの再設定の後の古いトークン、`From` の不一致、ロックされたスレッド。
- 運用：各キューの最古のメッセージの経過時間、デッドレターキューの件数、SES のバウンス率・苦情率でアラートを出す。

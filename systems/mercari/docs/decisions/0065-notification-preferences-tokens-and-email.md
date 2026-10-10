---
status: accepted
date: 2026-10-10
---

# ADR-0065: 通知の設定は（利用者、種類のまとまり、経路）の行で持ち、行がなければ既定値で決める。`security` は切れず、`transactional` はプッシュかメールの少なくとも 1 つを残す。端末のトークンは `identity` の `devices` が正本で、`notifier` は Valkey の写しを読む。メールは Amazon SES で、取引と案内を別のサブドメインと構成のセットに分ける

## Context

- 利用者は、いいね・値下げ・保存した検索・案内を、経路（プッシュ、メール）ごとに切りたい。本家は、取引関連をプッシュかメールのどちらかで必ず受けさせ、事務局の個別の連絡は切れない（[ヘルプの記事 239](https://help.jp.mercari.com/guide/articles/239/)、2026-10-10 に確認）。
- 端末とトークンは、ログイン・端末の取り消し・乗っ取りの対応と同じ時に変わる（[accounts-and-devices.md](../architecture/accounts-and-devices.md)）。2 か所で持つと、取り消した端末に通知が届く。
- 案内のメールの苦情の率が高くなると、同じ送り元の取引のメールまで届きにくくなる。
- 案内のメールの同意と表示の扱いは法令の判断が要る（特定電子メール法。**法務の確認待ち**。[intent.md](../intent.md) の L に当たる番号がない）。

## Options

設定：

1. **（利用者、まとまり、経路）の行と既定値。行のないものは既定**
2. 利用者ごとに全種類の設定を 1 つの JSON で持つ
3. 端末ごとに設定を持つ

トークン：

- a. **`identity` の `devices` が正本。`notifier` は写しを読む**
- b. `notifier` が自分でトークンの表を持つ

メール：

- x. **SES。取引・安全と案内でサブドメインと構成のセットを分ける**
- y. SES の 1 つのドメイン
- z. 外部のメールの配信の事業者

## Decision

1、a、x を採用する。詳細は [notifications.md](../architecture/notifications.md) の 7・8 節。

- `notification_prefs`（content、本人の FORCE RLS）に（`user_id`、`group`、`channel`）→ 値、静かな時間、時間帯、案内の同意の日時を持つ。既定値は種類の一覧（[ADR-0063](0063-notification-kinds-lanes-and-payload.md)）にあり、既定を変えても利用者の行は変えない。
- `security` は切れない。`transactional` は、プッシュとメールの両方を切る更新を 422 で拒む。`announcement` は同意の日時がある利用者だけに送る。
- トークンの正本は core の `devices`（`identity` が書く）。`identity` は `device.*` の事象を outbox に書き、`notifier` は Valkey の `ntf:devices:{user_id}`（期限 24 時間）を読む。APNs の 410・FCM の `UNREGISTERED` で `notifier-send` が `identity` の API でトークンを無効にする。
- 送る先は、直近 180 日に起動し、OS の通知の許可がある端末だけ。
- メールは SES：取引と安全は `mail.<brand>.<domain>`、案内は `news.<brand>.<domain>`。構成のセットを分け、SPF・DKIM・DMARC を置く（DMARC は 4 週の報告の後に `p=reject`）。送り返しと苦情は `email_suppressions` に入れて止める。

### 他の案を選ばなかった理由

- **2（JSON）**：種類を足すたびに全利用者の JSON の移し替えか、読み出しの時の補いが要る。既定値の変更が、行のない人にだけ効く形を作りにくい。
- **3（端末ごと）**：同じ人の 2 台目の端末で設定がずれ、取引の通知が一方で切れたままになる。
- **b（`notifier` がトークンを持つ）**：ログアウト・取り消し・乗っ取りの対応で 2 か所を消す必要があり、消し忘れた端末に `security` の通知が届く。
- **y（1 つのドメイン）**：案内の苦情の率が、取引のメールの届き方に響く。
- **z（外部の配信の事業者）**：個人のデータの渡し先が増える。S1 の量は SES で足りる。

## Consequences

- 良くなること：
  - 設定の既定値を、行のない利用者にだけ変えられる。
  - 取り消した端末に通知が届かない。
  - 案内の評判が、取引の通知のメールに響かない。
- 引き受けるコスト：
  - Valkey の写しが遅れる間（数秒）、取り消した端末に送りうる。`identity` は取り消しの時に写しを同期で消す。
  - 2 つのサブドメインの DNS と評判を見張る。

## Confirmation

- 表駆動テスト：設定の更新の検査（`security` を切れない、`transactional` の両方を切れない）。
- 結合テスト：端末の取り消しの後、その端末へのプッシュの依頼が 0（`push-sim`）。
- 本番：SES の送り返し・苦情の率（[observability.md](../architecture/observability.md) の 4 節）。

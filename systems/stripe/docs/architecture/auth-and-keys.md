# Auth and keys: Stripe

加盟店のアカウント、ダッシュボードの利用者とロール、ダッシュボードのログイン、API キー、権限、テナントのコンテキストの設計。方針は [ADR-0008](../decisions/0008-api-keys-and-dashboard-access.md)、テナントの分け方は [ADR-0002](../decisions/0002-account-tenancy.md) にある。ログインの実装は Slack の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)（Better Auth）と [identity-and-access.md](../../../slack/docs/architecture/identity-and-access.md) を引き継ぎ、決済に固有の点だけを変える。

本家 Stripe の振る舞いは、2026-09-26 に docs.stripe.com で確かめた。確かめられなかったものは「未検証」と書く。この文書の決定表は設計の草案で、ID は E2 の各変更の `spec.md` に移すときに振る。

## 1. 全体像

```
                ┌──────── テナントの外（live のクラスタの auth スキーマ）───────┐
ブラウザ ──────▶│ /api/auth/*  Better Auth                                      │
（ダッシュボード）│   users, auth_identities, sessions, passkeys, two_factors      │
                └───────────────────────┬──────────────────────────────────────┘
                                        │ session → user_id
                ┌───────────────────────▼──────────────────────────────────────┐
ブラウザ ──────▶│ api.<domain>/v1（ダッシュボードのセッション＋CSRF。dashboard.md）│
                │   1. MFA を満たしたセッションか                                │
                │   2. 選んでいるアカウントの account_members → ロール → 権限     │
                │   3. 環境のクラスタを選び SET LOCAL app.account_id             │
                └───────────────────────┬──────────────────────────────────────┘
加盟店のサーバー ─▶ api.<domain>/v1 ─────┤ API キー → (account_id, 環境, 権限)
                                        ▼
                         packages/domain（サービス関数）→ authorize() → DB（RLS）
```

- **認証はテナントの外、認可はテナントの中。** Slack と同じ分け方にする。人（利用者）は `users` で 1 回だけ認証し、アカウントの中ではメンバーとしてロールを持つ。
- **API キーは人に結び付けない。** キーはアカウントと環境に属する。作った人が辞めても、キーは動き続ける（本家と同じ）。
- **ダッシュボードと API は、同じ `authorize()` を通る。** 主体（ダッシュボードのメンバーか API キーか）から権限の集合を求め、操作に必要な権限と比べる。判定を面ごとに書かない（Slack の ADR-0005 と同じ考え方）。

## 2. アカウントと利用者

### 2.1 本家の仕組み（確かめたこと）

- 1 つのログインで、複数のアカウントに入れる。アカウントには利用者（チームメンバー）を招き、ロールを割り当てる。1 人に複数のロールを付けると、権限は和になる（[User roles](https://docs.stripe.com/get-started/account/teams/roles)）。
- アカウントの所有者（Account Owner）は 1 人で、アカウントの閉鎖と所有者の移転ができる。
- 2 段階認証は、本家が一部の利用者に求め、管理者がチーム全員に必須にできる（[Require two-step authentication for your team](https://support.stripe.com/questions/require-two-step-authentication-for-your-team)）。

### 2.2 モデル

| テーブル | 場所 | 中身 |
| --- | --- | --- |
| `users` | live のクラスタ、`auth` スキーマ（RLS の外） | メールアドレス、確認済みか、表示名。Better Auth の `user` モデル |
| `accounts` | live と test の各クラスタ | 加盟店のアカウント（`acct_`）。サンドボックスは test のクラスタの `accounts` の行で、`parent_account_id` で本番のアカウントを指す（[api.md](api.md) の 11 節） |
| `account_members` | live のクラスタ（テナントテーブル） | `account_id`、`user_id`、ロールの配列、招待者、参加日時、無効化の日時 |
| `account_owners` | 同上 | 所有者の `user_id`（アカウントに 1 行） |
| `invitations` | 同上 | 招待先のメールアドレス、ロール、トークンのハッシュ、期限（7 日） |
| `sandbox_access` | 同上 | サンドボックスへの入り方（E11。11.2 節） |

列・制約・索引の正本は [data-model/accounts-and-keys.md](data-model/accounts-and-keys.md)。

- メンバーとロールは live のクラスタだけに置き、サンドボックスでも同じ行を見る。ダッシュボードでサンドボックスを開くときは、live のクラスタで権限を決めてから、test のクラスタに `SET LOCAL app.account_id = <サンドボックスの acct>` で入る。
- `users` からテナントのデータを参照しない。テナントのデータは `user_id` だけを持つ（Slack の ADR-0010 と同じ）。

### 2.3 ロール

MVP は、本家のロールのうち、Connect・Identity・Terminal・Tax・Issuing などの範囲外の製品に属さないものを持つ。名前と SSO のロール ID は本家に合わせる。

| ロール | 主な権限 | 本家の SSO のロール ID |
| --- | --- | --- |
| Owner | すべて。アカウントの閉鎖、所有者の移転 | （所有者は別の概念） |
| Super Administrator | Administrator のすべて＋Super Administrator の付与、サンドボックスの作成・削除 | `super_admin` |
| Administrator | 所有者の移転と入金先の既定の口座の削除以外のすべて。メンバーの招待、API キーの管理を含む | `admin` |
| IAM Administrator | メンバーの招待・変更・削除だけ。Administrator 以上は付与できない | `iam_admin` |
| Developer | API キーの作成・閲覧・削除、ログと Event、決済・返金、設定の閲覧と大半の変更。メンバーの管理と入金先の口座の変更はできない | `developer` |
| Analyst | 決済・返金・Dispute・入金の実行、レポート。API キーと設定の変更はできない | `analyst` |
| Dispute Analyst | Dispute の閲覧と証拠の提出だけ | `dispute_analyst` |
| Refund Analyst | 決済の閲覧と返金だけ | `refund_analyst` |
| Support Specialist | 返金、Dispute、Customer の編集。入金と設定の変更はできない | `support_specialist` |
| View Only | 閲覧とレポートの出力だけ | `view_only` |

- 各ロールは、6 節の権限の集合と、ダッシュボードだけの権限（`team:manage`、`api_keys:manage`、`bank_accounts:manage`、`payout_schedule:manage`、`account_settings:manage`、`sandboxes:manage`）の組で定義する。定義はコードの表に置き、表駆動テストで固定する。
- 本家は、招待できるロール（Administrator 以上、IAM Administrator）の利用者が乗っ取られると、攻撃者が自分の配下の利用者を招けると注意している。そのため、ロールの付与と招待を「重要な操作」（4.2 節）にする。
- 独自のロール（権限を選んで作るロール）は MVP では持たない。

## 3. ダッシュボードのログイン

Slack の方式（Better Auth を自前でホストし、パスワードを持たない）を引き継ぐ。違いは **MFA を全員に必須にする** ことと、セッションを短くすることである。お金を動かせる画面なので、本家よりも強くする（本家は MFA を管理者の選択で必須にする）。

### 3.1 手段

| 手段 | 扱い |
| --- | --- |
| メールの OTP（6 桁、10 分、5 回まで） | 1 つ目の要素。Slack と同じ |
| Google（OIDC） | 1 つ目の要素 |
| パスキー（WebAuthn） | それだけで 2 要素を満たす |
| TOTP（認証アプリ） | 2 つ目の要素 |
| バックアップコード（10 個、1 回限り） | 2 つ目の要素の代わり |
| パスワード、SMS、マジックリンク | 持たない。Slack の identity-and-access.md の 2.1 節・4 節と同じ理由 |
| SAML・OIDC のシングルサインオン | E11。本家もダッシュボードの SSO を持つ（ロールに SSO のロール ID がある） |

### 3.2 MFA を必須にする

- **初回のログインで、パスキーか TOTP の登録を終えるまで、ダッシュボードに入れない。** 登録の画面以外の API は 403（`mfa_enrollment_required`）。
- セッションに `auth_context`（`amr`：`otp`・`oidc`・`passkey`・`totp`・`backup_code`）を持ち、ダッシュボードの API のミドルウェアで「パスキー」か「1 つ目の要素＋TOTP かバックアップコード」を満たすかを確かめる。
- Better Auth の `twoFactor` は、既定ではメールとパスワードなどの資格情報によるサインインにしか 2 要素目を求めない。OTP・ソーシャル・パスキーのサインインには求めない（Slack の identity-and-access.md の 3.2 節で 2026-09-26 に確認）。**そのため、MFA の必須は Better Auth に任せず、上のミドルウェアで自前で検査する。**
- MFA の要素をすべて失ったときの回復は、サポートによる本人確認とし、自動の回復経路は作らない。手順は runbook の `mfa-recovery.md`（E2 で作る。[runbooks/README.md](../runbooks/README.md)）に置く。

### 3.3 セッション

| 項目 | 値 | Slack との違い |
| --- | --- | --- |
| Cookie | `__Secure-session`、`HttpOnly`、`Secure`、`SameSite=Lax`、`Domain` なし | 同じ |
| アイドルタイムアウト | 12 時間 | Slack は 14 日。お金を動かせるので短くする |
| 絶対タイムアウト | 7 日 | Slack は 90 日 |
| 重要な操作の再認証 | 直近 5 分以内に 2 要素目を通したこと（4.2 節） | Slack は 10 分、再認証の要素を問わない |
| 正本 | Aurora の `sessions`。Valkey を使うなら `storeSessionInDatabase: true` | 同じ |

- 本家のダッシュボードのセッションの長さは公開されていない。値は本システムの決定として、上の表で確定する（13 節）。
- セッションの一覧と取り消し、ログアウト、CSRF の防御（`SameSite`・`Origin` の検査・JSON だけを受ける）は、Slack の identity-and-access.md の 3.3・3.4・10 節と同じにする。

### 3.4 重要な操作

次の操作は、4.2 節の再認証を要し、監査ログ（9 節）に残し、アカウントの Owner と Administrator にメールで知らせる。

- 本番の秘密キー・制限付きキーの作成、表示、ローテーション、期限切れ
- アクセスポリシーの作成・変更・キーへの適用
- Webhook の署名のシークレットの表示（[events-and-webhooks.md](events-and-webhooks.md)）
- メンバーの招待、ロールの変更、メンバーの削除、所有者の移転
- 入金先の口座の追加・変更、入金のスケジュールの変更
- MFA の要素の削除、自分のセッションの一括の取り消し

本家も、秘密キーの作成で、メールか SMS の確認コードを求める（[API keys](https://docs.stripe.com/keys)）。

## 4. 招待とメンバー

- 招待は、メールアドレスとロールを指定して送る。受けた人はログイン（なければ作成）し、MFA を登録してから参加する。
- 招待できるのは Owner、Super Administrator、Administrator、IAM Administrator。自分より強いロールは付与できない（Super Administrator は Super Administrator だけが付与できる。本家と同じ）。
- メンバーの削除は、そのメンバーのダッシュボードのセッションを、そのアカウントについて即時に無効にする。**API キーは消さない**（キーは人に属さない）。本家は、キーに触れられた人が辞めたらキーをローテーションするよう勧めている（[API keys](https://docs.stripe.com/keys)）。本システムは、削除の画面で「この人が表示した本番のキー」の一覧を出し、ローテーションを促す（表示の記録は 9 節の監査ログから引く）。

## 5. API キー

### 5.1 本家の仕組み（確かめたこと）

[API keys](https://docs.stripe.com/keys)、[Restricted API keys](https://docs.stripe.com/keys/restricted-api-keys)、[Best practices for managing secret API keys](https://docs.stripe.com/keys-best-practices) による。

| 項目 | 本家 |
| --- | --- |
| 種類 | 公開可能キー `pk_`（公開してよい。PaymentMethod の作成など限られた操作）、秘密キー `sk_`（すべての API）、制限付きキー `rk_`（リソースごとに None・Read・Write）。環境で `_test_` / `_live_` |
| 推奨 | 新しい用途には制限付きキーを使い、秘密キーから移ることを勧めている。サービスごとに 1 つの制限付きキーを勧める |
| 表示 | 本番で自分で作った秘密キー・制限付きキーは、作成時に 1 回だけ表示する。サンドボックスのキーは常に表示できる。公開可能キーは常に表示される |
| ローテーション | ダッシュボードで「ローテーション」すると代わりのキーを出し、古いキーの期限を「今すぐ」か指定の時刻にする。古いキーと新しいキーが両方動く猶予は最大 7 日 |
| 期限切れ | 秘密キー・制限付きキーは即時に期限切れにできる。公開可能キーは期限切れにできない |
| アクセスポリシー | キーごとに、IP アドレス（IPv4・CIDR）か、詳細な条件（ASN、国、匿名 VPN・公開プロキシ・住宅向けプロキシ・Tor の遮断。AND で組む）を付けられる。違反した要求は遮断し、通知する。旧来の「IP の制限」は置き換えられた |
| 使われないキー | 180 日以上、送金（transfers）・入金（payouts）の作成・入金先の更新に使われていないキーは、それらの操作を制限されることがある。ダッシュボードで戻せる |
| 漏洩 | 本家がキーの漏洩を検知すると、通知してローテーションを求め、先に無効にすることもある |
| 要求のログ | キーごとに要求のログを見られる |
| エージェントのキー | 制限付きキーに「自律エージェント用」の印を付けると、入金・返金・設定の変更などに承認のルールがかかる |

### 5.2 本システムのキー

| 種類 | 形式 | 権限 | 保存 | 表示 |
| --- | --- | --- | --- | --- |
| 公開可能キー | `<brand>_pk_{live\|test}_{本体}` | 5.4 節の操作だけ | 値をそのまま（公開してよい） | 常に |
| 秘密キー | `<brand>_sk_{live\|test}_{本体}` | すべての API | 本番：秘密の SHA-256 だけ。サンドボックス：KMS で暗号化 | 本番は作成時に 1 回だけ。サンドボックスは常に |
| 制限付きキー | `<brand>_rk_{live\|test}_{本体}` | 6 節の権限の集合 | 同上 | 同上 |

- `{本体}` は、キーの ID（`rak_` の 128 ビット）と秘密（256 ビット）を base62 にしてつないだ固定長の文字列。検証は、キーの ID で行を引き、秘密のハッシュを定数時間で比べる（Slack の identity-and-access.md の 9 節と同じ方式）。
- キーの判別は接頭辞で行い、`_live_` なら live のクラスタ、`_test_` なら test のクラスタの `api_keys` を引く（ADR-0002）。
- 接頭辞の先頭の `<brand>_` は、本家の `sk_live_` などとの衝突を避けるためのもの（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。実際の名前は開発リポジトリの作成時に決め、他の既知のサービスの接頭辞と重ならないことを確かめる。
- 本家は、Stripe が作った本番の秘密キーを後から表示できるが、本システムは本番の秘密キー・制限付きキーを **すべて作成時の 1 回だけ** 表示する。本番の秘密を復号できる形で持たないため。
- アカウントの作成時に、本番とサンドボックスそれぞれに、公開可能キー 1 つと秘密キー 1 つを作る（本家と同じ）。本番の秘密キーは、最初に表示した時点で 1 回だけ表示したものとみなす。
- 秘密キーは本家と同じく残すが、ダッシュボードでは制限付きキーを先に勧める。

```
api_keys（live・test の各クラスタ。テナントテーブル）
  id (rak_), account_id, kind (publishable | secret | restricted),
  name, note, secret_hash, secret_ciphertext (test のみ),
  permissions (jsonb, restricted のみ), access_policy_id,
  created_by_user_id, created_at, expires_at, expired_at,
  last_used_at, rolled_from_key_id, money_movement_restricted_at
```

### 5.3 ローテーションと期限切れ

| 操作 | 振る舞い |
| --- | --- |
| ローテーション | 同じ種類・名前・権限・アクセスポリシーで新しいキーを作り、古いキーに `expires_at` を付ける。期限は「今すぐ」「1 時間」「24 時間」「3 日」「7 日」から選ぶ（上限 7 日と「今すぐ」は本家と同じ。[API keys](https://docs.stripe.com/keys)、2026-09-27 に確認。途中の刻みは文書になく**未検証**。本家の画面で確かめる） |
| 予約のローテーション | 将来の時刻にローテーションを予約できる（本家も予約できる）。予約の時刻に新しいキーを作り、Owner と Administrator に知らせる |
| 期限切れ | 秘密キー・制限付きキーを即時に無効にする。公開可能キーはローテーションだけ（本家と同じ） |
| 公開可能キーのローテーション | 同じ。古いキーは最大 7 日動く |

- 期限の過ぎたキーの要求は 401（`api_key_expired`）。
- 期限切れの判定は、キーの検証のたびに `expires_at` と比べる。キャッシュ（5.6 節）の有効期間より長く古いキーが動かないよう、期限の 60 秒前からはキャッシュしない。
- ローテーションの猶予の間、古いキーの利用を「最終使用日時」と要求のログで見せ、0 になったことを確かめてから期限を早められるようにする（本家の勧めと同じ）。

### 5.4 公開可能キーで許す操作

- Vault へのカード番号の送信と PaymentMethod の作成（[card-vault.md](card-vault.md)）
- `client_secret` を添えた PaymentIntent の取得・確定（[payments.md](payments.md)）
- Checkout のセッションの読み取り（[checkout.md](checkout.md)）

それ以外は 401（`secret_key_required`。本家の [Error codes](https://docs.stripe.com/error-codes) にある名前）。公開可能キーの経路だけ CORS を許し、要求元のオリジンを記録する。

### 5.5 使われないキーの制限

- 本番のキーが 180 日以上、入金（Payout）の作成と入金先の作成・更新に使われていなければ、それらの操作を 403 にする（本家と同じ。本家の対象は送金・入金・入金先の更新で、決済の作成は含まない。[API keys](https://docs.stripe.com/keys)、2026-09-27 に確認。送金は Connect がないので対象外）。決済の作成、読み取り、返金は止めない。
- ダッシュボードで、Administrator 以上が再認証して戻せる。戻す操作は監査ログに残す。
- 日次のジョブで判定し、制限する 14 日前に知らせる。本家が事前に知らせるという記述は、文書にもサポートの記事にもない（2026-09-27 に確認）。事前の通知は本システムの決定とする。

### 5.6 検証の経路と性能

- キーの検証の結果（アカウント、環境、種類、権限、アクセスポリシー、期限）は、api のタスクのメモリに 30 秒キャッシュする。期限切れとローテーションの「今すぐ」は、Valkey の pub/sub で各タスクのキャッシュを消す。pub/sub が失われても 30 秒で反映する。
- 最終使用日時の書き込みは、キーごとに 1 分に 1 回までにまとめる。
- 検証の失敗は、IP ごとに数えて止める（[rate-limiting.md](rate-limiting.md) の 4.1 節）。

## 6. 権限（制限付きキー）

### 6.1 権限の単位

- 権限は「リソース × None・Read・Write」。Write は Read を含む（本家と同じ）。
- `GET` は Read、`POST`・`DELETE` は Write を要する（本家の対応と同じ）。例外（`POST .../search` のような読み取りの `POST`）は OpenAPI の `x-permission` で上書きする。
- 各エンドポイントの必要な権限は OpenAPI の `x-permission` に持ち、CI で「すべてのエンドポイントに `x-permission` がある」ことを検査する。

| リソース | 含むもの |
| --- | --- |
| `customers` | Customer |
| `payment_methods` | PaymentMethod（本体はトークンだけ。ADR-0005） |
| `payment_intents` | PaymentIntent、確定・キャプチャ・取り消し |
| `charges` | Charge（[payments.md](payments.md) で持つ場合） |
| `refunds` | Refund |
| `disputes` | Dispute、証拠の提出 |
| `balance` | 残高、残高の取引（Read のみ） |
| `payouts` | Payout |
| `events` | Event（Read のみ） |
| `webhook_endpoints` | Webhook のエンドポイント |
| `checkout_sessions` | Checkout のセッション |
| `files` | ファイル（Dispute の証拠） |

- 一覧は E3〜E6 の各 Story で、リソースを加えるときに更新する。権限の名前は `payment_intents:write` の形で、ダッシュボードのロールと共通の語彙にする。

### 6.2 判定

| # | 主体 | 必要な権限 | 主体の権限 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 公開可能キー | 5.4 節の操作 | - | 許す |
| 2 | 公開可能キー | それ以外 | - | 401 `secret_key_required` |
| 3 | 秘密キー | ダッシュボードだけの権限 | - | 403（API にない操作） |
| 4 | 秘密キー | それ以外 | - | 許す |
| 5 | 制限付きキー | X:Read | X が Read か Write | 許す |
| 6 | 制限付きキー | X:Write | X が Write | 許す |
| 7 | 制限付きキー | X:* | それ以外 | 403。`message` に必要な権限の名前を書く（本家も必要な権限を応答に書く） |

- 制限付きキーの権限の不足は、本家では「無効な要求のエラー」として返る（[Restricted API keys](https://docs.stripe.com/keys/restricted-api-keys)）。本システムは `type: invalid_request_error`、状態コード 403、`code: insufficient_permissions` にする。状態コード 403 は本家と同じ（[Errors](https://docs.stripe.com/api/errors)、2026-09-27 に確認）。本家の `code` の値は Error codes の一覧になく、**未検証**（サンドボックスで権限のない制限付きキーで呼んで確かめる）。
- `expand` の展開先にも Read を要する（[api.md](api.md) の 4.2 節）。
- 権限は作成後に編集できる（本家と同じ）。編集は監査ログに残し、5.6 節のキャッシュを消す。

### 6.3 エージェント用のキー（E11）

- 本家の「自律エージェント用」の印に倣い、制限付きキーに `agent` の印を付けられるようにする。印のあるキーの入金・返金・設定の変更は、ダッシュボードでの人の承認を待つ（承認の待ちの間は、操作を `pending_approval` の状態で受け付ける）。MVP では持たない。

## 7. アクセスポリシー

- ポリシーは `access_policies`（`account_id`、`id`、`name`、`ip_ranges`、`created_by_user_id`、`created_at`。live・test の各クラスタのテナントテーブル）に持ち、`api_keys.access_policy_id` から指す。
- キーごとに 1 つのアクセスポリシーを付けられる。MVP は IP アドレス（IPv4 と CIDR、1 つのポリシーに 50 件まで）だけ。ASN・国・匿名化の手段による詳細な条件は E11。
- 1 つのポリシーを複数のキーに付けられ、ポリシーの変更は、付いているすべてのキーに即時に効く（本家と同じ）。
- 判定は、ALB が付ける `X-Forwarded-For` の最後の値（CloudFront の後ろでは CloudFront が見た送信元）で行う。信頼する経路の数を構成で固定し、利用者が付けた `X-Forwarded-For` を信じない。
- 違反した要求は 403 にし、`code` は `api_key_access_policy_violation`（本システムの名前。本家の文書は「ブロックして通知する」とだけ書き、状態コードと `code` は**未検証**（2026-09-27 に確認）。サンドボックスでポリシー外の IP から呼んで確かめる）。
- 違反はキーごとに 1 時間に 1 回まで、Owner と Administrator に知らせる。
- 本家は、すべての本番のキーにアクセスポリシーを付けることを勧めている。ダッシュボードで、ポリシーのない本番のキーに警告を出す。
- IPv6 からの要求は、IPv4 だけのポリシーでは拒否する。

## 8. テナントのコンテキスト

ADR-0002 の `SET LOCAL app.account_id` を、主体ごとに次のように決める。

| 主体 | アカウント | 環境（クラスタ） |
| --- | --- | --- |
| API キー | キーの行の `account_id` | キーの接頭辞 |
| ダッシュボード | セッションの「選んでいるアカウント」（[dashboard.md](dashboard.md) の 2.1 節）。`account_members` にセッションの利用者の有効な行があること | 要求に付けたテスト環境の指定（同 4 節）。テストなら、テスト環境（サンドボックス）の `acct_` に切り替える |
| Worker（SQS のジョブ） | ジョブの本文の `account_id` と `livemode` | 同左 |

- キーの行の検索は、RLS の前に行う必要があるので、`SECURITY DEFINER` 関数 `auth_resolve_api_key(key_id)` だけで行う。関数は `account_id`・種類・権限・ポリシー・期限だけを返す（Slack の `auth_resolve_api_token` と同じ）。
- トランザクションごとに `SET LOCAL` し、接続を使い回すときに値が残らないようにする（ADR-0002）。
- 選んでいるアカウントに `account_members` の行がなければ 404（アカウントの存在を知らせない）。

## 9. 監査

### 9.1 セキュリティの履歴

本家の「セキュリティの履歴（security history）」に相当する。監査ログ `audit_events` の `category = 'security'` の行として残し（ビュー `security_events` で読む。[data-model/audit-and-operations.md](data-model/audit-and-operations.md) の 2.2 節）、Owner・Administrator・Developer・View Only などが見られる（本家も View Only が監査ログを見られる）。

- ログインの成功・失敗、MFA の登録・削除、セッションの取り消し
- 招待、ロールの変更、メンバーの削除、所有者の移転
- API キーの作成・表示・ローテーション・期限切れ・権限の編集・使われないキーの制限と解除
- アクセスポリシーの作成・変更・適用、違反
- 入金先の口座の変更、既定の API の版の変更
- サポートによる MFA の回復

各行は、行為者（`user_id` か `rak_`）、IP、User-Agent、対象、変更の前後（秘密の値を含めない）を持つ。`security_events` は監査ログ（`audit_events`、[ADR-0023](../decisions/0023-audit-log.md)）の一部として扱い、保持も同じにする：DB に 1 年（ダッシュボードで見られる期間）、アーカイブに 7 年（[security.md](security.md) の 13 節）。

### 9.2 要求のログ

- 本家の Workbench の要求のログに相当する。キーごと・エンドポイントごと・状態コードごとに、直近の要求を加盟店が見られる。
- MVP は、要求のメタデータ（[api.md](api.md) の 12 節の項目）だけを 30 日持つ。本文は持たない。本家は本文も見せるが、本文にはカード以外の個人情報（メールアドレス、住所）が入り、保存の範囲と期間の決定が要る（13 節）。
- 置き場所は、日ごとのパーティションのテーブル `api_request_logs`（live・test の各クラスタ）。api のタスクから SQS にまとめて送り、Worker が一括で書く。決済の要求の経路で DB への同期の書き込みを増やさない。

## 10. 漏洩への対処

- キーの形は接頭辞を持つので、ソースコードのリポジトリの走査で検知できる。本家は漏洩を検知すると通知し、先に無効にすることもある。
- 本システムは、GitHub のシークレットスキャンのパートナープログラムに、キーの形と通知先を登録する（E10）。通知を受けたら、本番のキーは Owner と Administrator に知らせ、24 時間以内にローテーションされなければ期限切れにする。サンドボックスのキーは即時に期限切れにする。手順は runbook の `api-key-leak.md`（E10 で作る）に置く。
- 接頭辞は本家と重ならない `<brand>_` 付きにした（5.2 節）ので、本家のキーとして誤って通報されない。登録の前に、他の既知のサービスの接頭辞と重ならないことを確かめる（リポジトリ共通の ADR-0006）。

## 11. 段階ごとの変化

| 項目 | S1 | S2 | S3（セル） |
| --- | --- | --- | --- |
| 認証の置き場所 | api のサービスに同居。`users` などは live のクラスタの `auth` スキーマ | ダッシュボードの認証を別の ECS サービスに分ける | セルの外の「アイデンティティ面」。Slack の identity-and-access.md の 13 節と同じ |
| API キーの検証 | 各クラスタの `api_keys` | 同じ | セルの外に、キーの ID → アカウント・セルの索引を置き、ルーターがセルを決める。検証そのものはセルの中の `api_keys` で行う |
| SSO | なし | E11 で SAML・OIDC | アイデンティティ面に置く |
| 詳細なアクセスポリシー、追加のサンドボックス、エージェントのキー | なし | E11 | 同じ |

## 12. テスト

- 表駆動テスト：2.3 節のロールと権限の表、6.2 節の判定の表、3.2 節の MFA の条件。
- 性質ベーステスト：任意のキーと操作で、制限付きキーが許される操作は、同じアカウントの秘密キーで許される操作の部分集合である。任意の 2 アカウントで、一方のキーで他方のオブジェクトが読めない（ADR-0002）。
- 結合テスト：ローテーションの猶予の間は新旧のキーが両方動き、期限の後は古いキーが 401。アクセスポリシーの外の IP からの要求が 403。MFA を満たさないセッションがダッシュボードの API で 403。
- 秘密の扱い：本番のキーの秘密が、ログ・DB（`secret_hash` 以外）・応答（作成時以外）に出ないことを、ログの走査で確かめる。

## 13. 決定と持ち越し（2026-09-26、既定案）

- **キーの接頭辞**：`<brand>_{pk|sk|rk}_{live|test}_`（5.2 節）。ADR-0002・0008 の表記を改めた。
- **要求のログの本文**：MVP では持たない（メタデータだけ 30 日。9.2 節）。本文を持つかは、個人情報の取得・委託の整理（[intent.md](../intent.md) の「法務の確認待ち」）の後に決める。
- **ダッシュボードのセッション**：アイドル 12 時間・絶対 7 日（3.3 節）で確定する。本家の値は公開されていないので、本システムの決定とする。
- **独自のロール**：MVP では持たない。E11 の候補にする。
- 持ち越し：本家のアクセスポリシーの違反と、制限付きキーの権限不足の、状態コードと `code` の実際の値。E2 の `restricted-keys` と `access-policies` の Story で、本家のサンドボックスで確かめて揃える。

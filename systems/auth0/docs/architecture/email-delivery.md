# Email delivery: Auth0

エンドユーザーへのメールの送信（確認、再設定、OTP、通知）、テンプレート、送信ドメインの認証（SPF・DKIM・DMARC）、テナントの独自の送信ドメインと送信事業者、到達性の監視。

| 関連 | 決定 |
| --- | --- |
| [ADR-0040](../decisions/0040-email-sending-platform.md) | Amazon SES（東京）から、テナントごとの SES のテナントと送信ドメインの認証を付けて送る。認証のメールは優先の列で送る |
| [ADR-0041](../decisions/0041-email-templates-and-tenant-providers.md) | テンプレートは自動でエスケープする制限した Liquid。リンクは本システムが作る。テナントの送信事業者は SMTP と SES（クロスアカウント）に限る |
| [ADR-0005](../decisions/0005-authentication-path-availability.md) | 送信は outbox → SQS → Worker。認証の経路は送信を待たない |
| [ADR-0004](../decisions/0004-credential-storage.md) | テナントの SMTP の資格情報はエンベロープ暗号化 |
| [ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) | 送るか送らないかで、画面の応答と時間を変えない |
| [ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md) | メールのリンクのホスト名は、登録したホスト名から作る |

メールを送る理由（サインアップ、再設定）は [connections.md](connections.md)、メールの OTP は [mfa-and-passkeys.md](mfa-and-passkeys.md)、送信のログは logs-and-streams の領域にある。

## 1. 目的と範囲

- 目的：確認・再設定・OTP のメールを、速く、迷惑メールにならずに、テナントの名前で届ける。1 つのテナントの濫用や誤りが、他のテナントの送信を止めない。
- 範囲：送信の経路と列、SES のテナントと識別子、共有の送信ドメイン、テナントの独自の送信ドメイン、テンプレートと描画、テナントの送信事業者、バウンスと苦情と抑止、到達性の監視。
- 範囲の外：マーケティングのメール（本システムは送らない）、SMS（MVP の後）、本システムからテナントの管理者への運用の連絡（dashboard の領域。同じ経路を使うが、テンプレートは本システムのもの）。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 項目 | 本家 | 本システム |
| --- | --- | --- |
| 組み込みの送信 | 試験用。1 分 10 通、送信元は固定、テンプレートを変えられない（[Configure External SMTP Email Providers](https://auth0.com/docs/customize/email/smtp-email-providers)） | 本番でも使える共有の送信（上限あり。4 節） |
| テナントの送信事業者 | SES、Azure Communication Services、Mandrill、Microsoft 365、Resend、SendGrid、SparkPost、Mailgun、SMTP、Actions による独自（同上） | SMTP と SES（クロスアカウント）（[ADR-0041](../decisions/0041-email-templates-and-tenant-providers.md)） |
| テンプレート | 11 種。Liquid。送信元・件名・本文・リンクの有効期間（既定 432,000 秒）・戻り先（[Email Templates](https://auth0.com/docs/customize/email/email-templates)、[Customize Email Templates](https://auth0.com/docs/customize/email/email-templates/customize-email-templates)） | 11 種（3 節。ADR-0041 の 9 種に `already_registered`・`email_changed` を足した。`already_registered` はテナントのテンプレートの対象外）。制限した Liquid。戻り先は登録済みの URL だけ |
| カスタムドメイン | メールのリンクはカスタムドメインを使う（[Custom Domains](https://auth0.com/docs/customize/custom-domains)）。複数のときはヘッダーで選び、なければ既定のドメイン（[Multiple Custom Domains](https://auth0.com/docs/customize/custom-domains/multiple-custom-domains)） | 同じ（[ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md)） |

## 3. メールの種類

| 種類 | 送る時 | 列 | 本文の秘密 | 期限切れで捨てる |
| --- | --- | --- | --- | --- |
| `verify_email_code` | verify-first のサインアップ、メールの入力（ソーシャル） | `auth` | 6 桁のコード | 7 分半（コードの 15 分の半分） |
| `already_registered` | verify-first で既存のアドレス | `auth` | なし | 7 分半 |
| `verify_email_link` | 即時のサインアップ、API での作成、アドレスの変更 | `notify` | リンク | リンクの期限 |
| `reset_password_link` | 再設定の要求 | `auth` | リンク | リンクの期限の半分 |
| `mfa_otp` | メールの OTP（[mfa-and-passkeys.md](mfa-and-passkeys.md)） | `auth` | 6 桁のコード | コードの期限の半分 |
| `password_changed` | 変更・再設定の完了 | `notify` | なし | 24 時間 |
| `email_changed` | アドレスの変更（古いアドレスへ） | `notify` | なし | 24 時間 |
| `blocked_account` | 攻撃の防御のブロック（attack-protection） | `notify` | 解除のリンク | リンクの期限 |
| `breached_password` | 漏えいしたパスワードの検知 | `notify` | なし | 24 時間 |
| `welcome` | サインアップの完了（テナントが有効にしたとき） | `notify` | なし | 24 時間 |
| `invitation` | 招待（E14） | `notify` | リンク | リンクの期限 |

- `already_registered` の本文は、本システムの既定の文言に限る（テナントのテンプレートの対象外）。列挙の防止の文言の誤りを避けるため。

## 4. 送信の経路

```
Auth / Management API（業務のトランザクション）
   │ INSERT email_outbox（種類、宛先、テンプレートの変数。秘密の値は暗号化）
   ▼
Relay ─▶ SQS: email-auth（優先）／ email-notify
          ▼
Worker（送信）
   ├ 抑止の確認（email_suppressions）、期限の確認（過ぎたら捨てる）
   ├ テンプレートの描画（テナントのバージョン、言語）
   ├ 送信元の決定（独自のドメインが verified か → そうでなければ共有）
   └ 送信：本システムの SES（SES のテナント、設定セット）か、テナントの事業者（別のタスクの群）
          ▼
SES の送信の結果 ─ 設定セット ─▶ EventBridge ─▶ Worker（結果）─▶ email_messages の状態、ログ、抑止
```

- `email_outbox` の秘密の値（コード、リンクのトークン）は、エンベロープ暗号化で持ち、送信の後すぐに消す。`email_messages`（送信の記録）には本文を保存しない。
- 冪等：`email_outbox.id` を SES のメッセージのタグに入れ、Worker の再試行で同じメールを 2 回送らない（SES の受け付けの応答を受け取れなかった場合は、2 回届くことを許す。コードは同じ値なので害は小さい）。
- 送信の上限（テナントごと）：

| 環境 | 共有の送信ドメイン | 独自の送信ドメイン | 同じ宛先 |
| --- | --- | --- | --- |
| 本番 | 1 日 1 万通 | SES のアカウントの上限の中で、テナントの契約の値 | 1 時間に 20 通 |
| 開発・ステージング | 1 日 500 通 | 同じ | 1 日 10 通 |

- 上限に達したら、`auth` の列のメールも送らない（その時の画面の応答は変えない）。ダッシュボードとログで知らせる。

## 5. 送信ドメインと認証

### 5.1 共有の送信ドメイン

| レコード | 値 |
| --- | --- |
| 送信元 | `no-reply@mail.jp.<brand>.<domain>`（表示名はテナントの名前） |
| DKIM | Easy DKIM の 3 つの CNAME（2048 ビット）。大阪の SES の識別子にも別の CNAME |
| MAIL FROM | `bounce.mail.jp.<brand>.<domain>`：`MX 10 feedback-smtp.ap-northeast-1.amazonses.com`、`TXT "v=spf1 include:amazonses.com -all"` |
| DMARC | `_dmarc.mail.jp.<brand>.<domain>`：`v=DMARC1; p=reject; adkim=s; aspf=s; rua=mailto:<集計の受け口>` |

- 出典：[Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html)、[Custom MAIL FROM domain](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)（2026-09-27 に確認）。
- DMARC の集計の報告を受けて、日次で整合の失敗を見る。

### 5.2 テナントの独自の送信ドメイン（E11）

状態：

```
 registered ──(SES の識別子の作成)──▶ pending_dns ──(DKIM SUCCESS)──▶ verified
     ▲                                     │ 72 時間で未確認                │ DKIM が失敗に変わる
     │                                     ▼                                ▼
     └─────────── 再試行 ────────────── failed ◀──────────────────── degraded（共有のドメインで送る）
```

- テナントに示すレコード：Easy DKIM の CNAME 3 つ（東京）と 3 つ（大阪）、MAIL FROM の MX と TXT（`send.<テナントのドメイン>` などのサブドメイン）、DMARC の推奨（最初は `p=none` で集計を見て、`quarantine`・`reject` へ）。
- 送信元のアドレスは、`verified` のドメインのものだけ。表示名は自由（改行と制御文字は拒否）。
- `verified` の間も 24 時間ごとに状態を確かめ、`degraded` になったら共有のドメインへ戻して送り、テナントへ通知する。
- 1 テナントの独自の送信ドメインは S1 で 1 つ。
- Apple の非公開の中継（Hide My Email）へ送るテナントは、送信ドメインを Apple に登録し、SPF か DKIM で認証する必要がある（[Configuring your environment for Sign in with Apple](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple)、2026-09-27 に確認）。共有の送信ドメインは本システムの Apple の開発者のアカウントの登録ではなく、テナントの Apple のチームへの登録が要るので、ダッシュボードで手順を案内する（テナントが共有のドメインを自分の Apple のチームに登録できるかは未検証）。

### 5.3 メールの事業者の要件

- Gmail：すべての送信者に SPF か DKIM。1 日 5,000 通を超える送信者に、SPF・DKIM・DMARC、整合、迷惑メールの率 0.3% 未満（[Email sender guidelines](https://support.google.com/a/answer/81126)、2026-09-27 に確認）。共有の送信ドメインは、全テナントの合計で 5,000 通を超える前提で、最初から満たす。
- 本システムのメールはトランザクションのメールなので、ワンクリックの配信停止（RFC 8058）は付けない。`welcome` だけはテナントの判断でマーケティングに近くなりうるので、テンプレートの注意書きで示す。
- 国内の携帯の事業者（docomo・au・SoftBank）のメールの受信の条件と、国内の送信ドメイン認証の導入の手引きの要点は未検証。E4 の着手前に確かめる。

## 6. テンプレート

[ADR-0041](../decisions/0041-email-templates-and-tenant-providers.md) のとおり。表：

```sql
CREATE TABLE email_templates (
  tenant_id     uuid        NOT NULL,
  kind          text        NOT NULL,   -- verify_email_code | reset_password_link | ...
  locale        text        NOT NULL,   -- 'ja' | 'en'
  enabled       boolean     NOT NULL DEFAULT true,
  from_name     text,
  from_address  text,                   -- must belong to a verified sending domain
  reply_to      text,
  subject       text        NOT NULL,   -- <= 200 chars
  body_html     text        NOT NULL,   -- <= 100 KB
  body_text     text,
  version       integer     NOT NULL,
  updated_by    text        NOT NULL,   -- admin tenant sub (member_user_id, data-model.md 2.4)
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, kind, locale)
);
```

- 本システムの既定のテンプレート（`ja`・`en`）はコードに持つ。テナントの行がなければ既定を使う。
- 件名に日本語を使うときは RFC 2047 で符号化する（ライブラリに任せる）。本文は UTF-8。
- 本文の HTML は、描画の後に、スクリプト・`on*` 属性・`javascript:`・`data:` の URL・外部の CSS の読み込みを取り除く。画像は `https:` だけ。
- 保存の時に、試験の変数で描いて、上限（50 ms・256 KB）と構文を確かめる。
- 言語：トランザクションの言語、なければユーザーの `locale`、なければテナントの既定。

## 7. テナントの送信事業者

```sql
CREATE TABLE email_providers (
  tenant_id       uuid        NOT NULL PRIMARY KEY,
  kind            text        NOT NULL,   -- platform_ses | smtp | ses_cross_account
  smtp_host       text,
  smtp_port       integer,                -- 465 | 587
  smtp_username   text,
  secret_ct       bytea,                  -- SMTP password, envelope-encrypted (ADR-0004)
  secret_key_ver  integer,                -- tenant_data_keys.version
  role_arn        text,                   -- ses_cross_account
  external_id     text,
  fallback_to_platform boolean NOT NULL DEFAULT false,
  status          text        NOT NULL,   -- active | failing | disabled
  updated_at      timestamptz NOT NULL
);
```

- 保存の時に、接続の試験（SMTP の `EHLO` と認証、SES の `GetAccount`）を行う。宛先のアドレスの SSRF の検査は ADR-0041 のとおり。
- 失敗の扱い：接続・認証の失敗、5xx が 15 分続いたら `failing` にし、ダッシュボード・メール・ログで知らせる。`fallback_to_platform` が真なら、共有の送信で送る。

## 8. バウンス・苦情・抑止

```sql
CREATE TABLE email_messages (          -- one row per send attempt; no body
  tenant_id     uuid        NOT NULL,
  id            uuid        NOT NULL,   -- = email_outbox.id
  kind          text        NOT NULL,
  to_hash       bytea       NOT NULL,   -- HMAC of the normalized address (search by address in the dashboard)
  provider      text        NOT NULL,
  provider_message_id text,
  status        text        NOT NULL,   -- queued | sent | delivered | bounced | complained | dropped_expired | dropped_suppressed | dropped_quota | failed
  status_detail text,                   -- bounce type/subtype, SMTP code (no address)
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE email_suppressions (
  tenant_id     uuid        NOT NULL,
  address_hash  bytea       NOT NULL,
  reason        text        NOT NULL,   -- hard_bounce | complaint | apple_relay_disabled | manual
  created_at    timestamptz NOT NULL,
  expires_at    timestamptz,            -- null = until removed
  PRIMARY KEY (tenant_id, address_hash)
);
```

- ハードバウンスと苦情は、SES のテナントの抑止リストと `email_suppressions` の両方に入る。ソフトバウンスは入れない（SES が再試行する）。
- Gmail は苦情を SES に返さない（[Suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)、2026-09-27 に確認）。Gmail の迷惑メールの率は、Postmaster Tools で共有の送信ドメインを見る。
- テナントの管理者は、ダッシュボードで抑止を解除できる（監査ログに残る）。エンドユーザーには抑止の有無を示さない。
- `email_messages` の保持は 30 日（ログの保持の結論 L5 で見直す）。

## 9. 到達性の監視

| SLI | 目標 | 測り方 |
| --- | --- | --- |
| `auth` の列：outbox から SES の受け付け | p95 10 秒以内 | Worker の計測 |
| `notify` の列：同上 | p95 5 分以内 | 同上 |
| 受信箱への到着（合成） | p95 60 秒以内、迷惑メールのフォルダー 0 件 | 監視用のテナントから、Gmail・Outlook.com・国内の携帯の事業者のメールの試験の受信箱へ 1 時間ごと |
| アカウントのバウンス率 | 2% 未満（警告）、3% で重大 | SES の指標。審査は 5%、停止は 10%（[Enforcement FAQ](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html)） |
| アカウントの苦情率 | 0.05% 未満（警告）、0.08% で重大 | 同上。審査は 0.1%、停止は 0.5% |
| テナントごとの SES のテナントの停止 | 件数を監視 | SES のテナントの評判のポリシー |

- テナントのダッシュボードには、送信の件数・配信・バウンス・苦情・抑止・期限切れで捨てた件数を出す。

## 10. 障害時の振る舞い

| 障害 | 振る舞い |
| --- | --- |
| SES（東京）の障害・スロットリング | Worker が指数的な待ちで再試行。期限の過ぎたメールは捨てる。15 分続いたら、大阪の SES へ切り替える（共有の送信ドメインと、大阪の DKIM が確認済みの独自のドメイン） |
| SES のアカウントの審査・停止 | 全テナントの送信が止まる最悪の事態。9 節の警報で手前で止める。停止されたら、大阪の別のアカウント（予備。S1 から用意）へ切り替える（runbook） |
| SES のテナントの停止 | そのテナントだけ止まる。ダッシュボードとメールで知らせる |
| テナントの SMTP の障害 | そのテナントだけ止まる（7 節） |
| SQS・Worker の停止 | outbox に残り、回復後に送る。期限の過ぎたものは捨てる |
| テンプレートの描画の失敗 | 本システムの既定のテンプレートで送り、テナントに知らせる |

- メールの OTP しか持たないユーザーの MFA は、送信の障害で失敗する（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。

## 11. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| アカウントの列挙（送る・送らない、抑止） | 画面の応答と時間は送信の有無に依らない。送信は非同期 |
| ホストのヘッダーの注入によるリンクの偽装 | リンクは登録したホスト名から（[ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md)） |
| テンプレートからの XSS・任意のリンク・オープンリダイレクト | 自動のエスケープ、変数の許可リスト、リンクは本システムが作る、戻り先は登録済みの URL だけ |
| 乗っ取られた管理者によるフィッシングのメールの送信 | テンプレートの変更の全管理者への通知、監査ログ、送信の上限 |
| 送信の濫用（サインアップのメール爆撃） | 同じ宛先の上限、サインアップの速度の上限、ボットの検知（attack-protection） |
| 共有の送信ドメインの評判の毀損 | 1 日の上限、SES のテナントでの分離、テナントの自動の停止 |
| 他人のドメインのなりすまし（独自の送信ドメイン） | DKIM の確認の済んだドメインだけ。SES のテナントに紐づける |
| SMTP の設定での SSRF | 解決の後のアドレスの検査 |
| 秘密（コード、リンク）の漏れ | outbox で暗号化し、送信の後に消す。送信の記録に本文を残さない。ログに出さない（AGENTS.md） |

## 12. テスト

### 12.1 決定表：送信元の決定

| # | テナントの送信事業者 | 独自の送信ドメイン | `fallback_to_platform` | 事業者の状態 | 送信 |
| --- | --- | --- | --- | --- | --- |
| 1 | `platform_ses` | なし | — | — | 共有の送信ドメイン |
| 2 | `platform_ses` | `verified` | — | — | 独自のドメイン（本システムの SES） |
| 3 | `platform_ses` | `degraded` | — | — | 共有の送信ドメイン、テナントへ通知 |
| 4 | `smtp` | — | 偽 | `active` | テナントの SMTP |
| 5 | `smtp` | — | 偽 | `failing` | 送らない（`failed`）、テナントへ通知 |
| 6 | `smtp` | — | 真 | `failing` | 共有の送信ドメイン |
| 7 | 任意 | 任意 | 任意 | 宛先が抑止中 | 送らない（`dropped_suppressed`） |
| 8 | 任意 | 任意 | 任意 | 期限が過ぎた | 送らない（`dropped_expired`） |

### 12.2 性質ベーステスト（fast-check）

テスト名には要件 ID を含める（開発リポジトリで採番する）。

- 任意のテンプレートの変数の値（任意の Unicode、HTML、Liquid の構文の断片）で、描いた HTML にスクリプトとして実行されうる要素・属性がなく、変数の値が Liquid として再評価されない。
- 任意のテンプレートの本文で、描いたメールのリンクの `href` は `https:` だけで、本システムが作った `url` のホスト名はテナントの登録したホスト名のどれか。
- 任意の送信の列（再試行、重複の配信、順序の入れ替えを含む）で、1 つの `email_outbox.id` の最終の状態は 1 つに決まり、`email_messages` の状態の遷移は許された向きだけ。
- 任意の 2 テナントで、一方の送信事業者・送信ドメイン・抑止リストが他方の送信に使われない。

### 12.3 その他

- 結合テスト（SES の模擬、SMTP の模擬のサーバー）：12.1 の各行。
- 結合テスト：`notify` の列の滞留の中でも `auth` の列が p95 10 秒以内。
- 合成監視（9 節）を GA の前から回す。
- 訓練（staging）：SES（東京）への到達を止め、大阪へ切り替わる。

## 13. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0040](../decisions/0040-email-sending-platform.md) | メールは Amazon SES（東京）から、テナントごとの SES のテナントと送信ドメインの認証を付けて送り、認証のメールを優先の列で送る | accepted |
| [0041](../decisions/0041-email-templates-and-tenant-providers.md) | メールのテンプレートは自動でエスケープする制限した Liquid で書かせ、リンクは本システムが作る。テナントの送信事業者は SMTP と SES（クロスアカウント）に限る | accepted |

## 14. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | SES のアカウント（東京・大阪、予備のアカウント）、本番の利用の申請、共有の送信ドメインの DKIM・MAIL FROM・DMARC を Terraform で |
| E4 | `email_outbox`、2 つの列、送信の Worker、期限切れの破棄、冪等 |
| E4 | 既定のテンプレート（`ja`・`en`）と描画（LiquidJS の制限の設定） |
| E4 | SES のテナントの作成（テナントの作成と同時）と、送信の上限 |
| E4 | 送信の結果の受信（EventBridge）、`email_messages`、抑止 |
| E4 | 合成監視（受信箱への到着）と、バウンス率・苦情率の警報 |
| E7 | メールの OTP の送信（mfa-and-passkeys と一緒に） |
| E6 | Apple の `email-disabled` の通知での抑止 |
| E8 | 同じ宛先・サインアップのメールの速度の上限（attack-protection と一緒に） |
| E9 | ダッシュボードのテンプレートの編集・プレビュー・試験の送信、送信の記録と抑止の画面 |
| E10 | 送信のイベントのログとログストリーム（logs-and-streams と一緒に） |
| E11 | テナントの独自の送信ドメイン（状態、DNS の案内、日次の確認、`degraded`） |
| E11 | テナントの送信事業者（SMTP、SES のクロスアカウント、接続の試験、SSRF の検査） |
| E12 | 大阪の SES への切り替えの訓練、予備のアカウントへの切り替えの手順の確認 |
| E14 | 招待のメール |

E2・E3・E5・E13 には、この領域の Story はない。

## 15. 品質・運用・データへの引き継ぎ

- [quality.md](../quality.md) に入れる候補：
  - リスク：メールの到達性（上位のリスク。サインアップと再設定が止まる）。9 節の合成監視を GA の基準にする。
  - 12.2 のテンプレートの描画の性質ベーステストを E4 の必須のテストにする。
  - 本番での検証：種類ごとの送信から配信までの時間、バウンス・苦情の率、期限切れで捨てた件数、サインアップのコードの入力の完了の率（届いていない兆し）を日次で見る。
- [runbooks/](../runbooks/README.md) に入れる候補：
  - バウンス率・苦情率の警報：原因のテナントの特定と送信の停止、SES のテナントの状態の確認。
  - SES のアカウントの審査・停止：AWS への連絡、予備のアカウントへの切り替え、テナントへの告知。
  - SES（東京）の障害での大阪への切り替えと、戻し。
  - 特定のメールの事業者（Gmail、携帯の事業者）で迷惑メールに入る・届かない：DMARC の集計、Postmaster Tools、送信の内容の確認。
  - テナントの独自の送信ドメインの `degraded`（DNS の誤り）の問い合わせへの案内。
  - エンドユーザーからの「コードが届かない」の問い合わせ：`email_messages` の状態の確認の手順（アドレスの HMAC で引く）。
- [data-model.md](data-model.md) の索引に入れる候補：`email_outbox`、`email_messages`、`email_suppressions`、`email_templates`、`email_providers`、`sending_domains`（この領域が持つ）。

## 16. 未解決の問い

- メールの送信の代行が、電気通信事業法の「他人の通信の媒介」に当たり、届出が要るか（[intent.md](../intent.md) の L3）。E4 のメールの送信の Story は、結論まで承認しない。
- SES（AWS）にエンドユーザーのメールアドレスと本文を渡すことの扱い（L1、L6）。東京・大阪で閉じる前提。
- 国内の携帯の事業者のメールの受信の条件と、国内の送信ドメイン認証の手引き（未検証）。
- 共有の送信ドメインを、Apple の非公開の中継に対してどう登録するか（テナントの Apple のチームへの登録が要るか。未検証）。

### 決定（2026-09-27、既定案）

- **送信事業者**：Amazon SES（東京、DR は大阪）。本家と違い、本番でも共有の送信を使える（上限あり）。
- **共有の送信ドメインの上限**：本番のテナントで 1 日 1 万通。
- **テナントの送信事業者**：SMTP と SES のクロスアカウントだけ。失敗しても共有の送信へ切り替えない（テナントが選べる）。
- **テンプレートの戻り先**：登録済みの URL だけ（本家の `Redirect To` の任意の URL は受けない）。
- **送信の記録の保持**：30 日、本文なし。
- **期限切れのメール**：コードの有効期間の半分を過ぎたら送らない。

### 決定（2026-09-27、推奨案で確定）

- **SES のテナント・識別子の上限（リージョンに 1 万）**：S2 の前（本番 3 万テナント）に、AWS へ上限の引き上げを申請する。
- **予備の SES のアカウントの暖機**：少量の定常の送信を回す。到達性の合成監視のメールを、予備のアカウントからも毎日送る（E1）。
- **Apple の非公開の中継**：共有の送信ドメインは、テナントに自分の Apple のチームへ登録してもらい、ダッシュボードで手順を案内する（5.2 節）。登録できるかは E6 で確かめる（未検証）。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 共有の送信の 1 日の上限の値 | 1 日 1 万通で始める。E12 の後に本番の分布で見直す（計測） |

## References

- Auth0 Docs: [Configure External SMTP Email Providers](https://auth0.com/docs/customize/email/smtp-email-providers)、[Email Templates](https://auth0.com/docs/customize/email/email-templates)、[Customize Email Templates](https://auth0.com/docs/customize/email/email-templates/customize-email-templates)（2026-09-27 に確認）
- AWS: [Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)、[Managing sending quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)、[Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html)、[Custom MAIL FROM domain](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)、[Enforcement FAQ](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html)、[Suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)、[Event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html)、[Tenant management](https://docs.aws.amazon.com/ses/latest/dg/tenants.html)、[SES endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html)（2026-09-27 に確認）
- Google: [Email sender guidelines](https://support.google.com/a/answer/81126)（2026-09-27 に確認）
- Apple: [Configuring your environment for Sign in with Apple](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple)（2026-09-27 に確認）
- NIST: [SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)（メールを out-of-band の認証に使わない。確認のコードはこの禁止の対象外。2026-09-27 に確認）
- IETF: [RFC 7489 DMARC](https://www.rfc-editor.org/rfc/rfc7489)、[RFC 8058 One-Click Unsubscribe](https://www.rfc-editor.org/rfc/rfc8058)

---
status: accepted
date: 2026-09-27
---

# ADR-0040: メールは Amazon SES（東京）から、テナントごとの SES のテナントと送信ドメインの認証を付けて送り、認証のメールを優先の列で送る

## Context

本システムが送るメールは、サインアップの確認、パスワードの再設定、メールの OTP（MFA）、パスワードの変更の通知、ブロックの通知、漏えいしたパスワードの通知、招待（E14）である。どれも、届かないとサインアップ・再設定・ログインが止まる（[architecture/README.md](../architecture/README.md) の 6 節「メールの到達性」）。送信事業者の候補は SES が第一で、E4 の前に決める（[intent.md](../intent.md)）。

本家 Auth0 の振る舞い（2026-09-27 に確認）：

- 組み込みの送信は試験用で、1 分に 10 通まで、送信元は固定、テンプレートを変えられない。本番では外部の送信事業者（Amazon SES、Azure Communication Services、Mandrill、Microsoft 365、Resend、SendGrid、SparkPost、Mailgun、SMTP、Actions による独自の事業者）を設定するよう求める（[Configure External SMTP Email Providers](https://auth0.com/docs/customize/email/smtp-email-providers)）。
- つまり本家は、本番のメールの到達性をテナントの送信事業者に任せている。

SES の事実（2026-09-27 に確認）：

- サンドボックスでは確認済みの宛先にしか送れず、24 時間 200 通、毎秒 1 通。本番の利用の申請が要る。上限は 24 時間の送信数と毎秒の送信数で、リージョンごと、宛先の数で数える（[Request production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)、[Managing sending quotas](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)）。
- Easy DKIM は 3 つの CNAME で、鍵は既定で 2048 ビット。独自の MAIL FROM のドメイン（送受信に使わないサブドメイン、MX 1 つと SPF の TXT）で、SPF の整合（DMARC）が取れる（[Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html)、[Custom MAIL FROM domain](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)）。
- バウンス率 5% 以上で審査、10% 以上で送信の停止がありうる。苦情率 0.1% 以上で審査、0.5% 以上で停止がありうる（[Enforcement FAQ](https://docs.aws.amazon.com/ses/latest/dg/faqs-enforcement.html)）。
- 2025 年 8 月に、SES のアカウントの中に「テナント」を作り、識別子・設定セット・テンプレート・評判の指標を分け、評判のポリシーでテナントだけを自動で止められるようになった。テナントは既定でリージョンに 1 万（[Tenant management](https://docs.aws.amazon.com/ses/latest/dg/tenants.html)、[What's New 2025-08](https://aws.amazon.com/about-aws/whats-new/2025/08/amazon-ses-tenant-isolation-automated-reputation-policies)、[SES quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html)）。
- 送信の結果（配信、バウンス、苦情、遅延など）を、設定セットごとに EventBridge・SNS へ出せる。アカウントの抑止リストは、ハードバウンスと苦情を登録する。Gmail は苦情の情報を SES に返さない（[Event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html)、[Suppression list](https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html)）。
- 東京（ap-northeast-1）と大阪（ap-northeast-3）の両方に SES がある（[SES endpoints](https://docs.aws.amazon.com/general/latest/gr/ses.html)）。

Gmail は、すべての送信者に SPF か DKIM を、1 日 5,000 通を超える送信者に SPF・DKIM・DMARC と整合、迷惑メールの率 0.3% 未満を求める（[Email sender guidelines](https://support.google.com/a/answer/81126)、2026-09-27 に確認）。

## Options

1. **本システムが SES（東京）で送る。テナントごとに SES のテナントを作り、評判を分ける。送信元は、本システムの共有の送信ドメインか、テナントが認証した独自のドメイン**
2. 本家と同じく、本番ではテナントの送信事業者を必須にする
3. 外部の送信事業者（SendGrid など）を本システムの送信に使う

## Decision

1 を採用する。テナントの送信事業者の持ち込みは [ADR-0041](0041-email-templates-and-tenant-providers.md) で、選べる形にする。

### 送信の経路

- 送信の要求は、業務のトランザクションと同じ DB のトランザクションで `email_outbox` に書く。Relay が SQS へ移し、Worker が SES の API（v2）で送る。認証の経路は SES を待たない（[ADR-0005](0005-authentication-path-availability.md)）。
- **列を 2 つにする。** `auth`（確認のコード、再設定、MFA の OTP）と `notify`（変更の通知、ブロック、漏えいの通知、招待）。`auth` の列を優先し、`notify` の滞留が `auth` を遅らせない。
- 目標：`auth` の列は、outbox への書き込みから SES の受け付けまで p95 10 秒以内。`notify` は p95 5 分以内。
- 期限の過ぎた要求は送らない：OTP と確認のコードは、コードの有効期間の半分を過ぎたら送らずに捨てる（届いた時には使えないため）。
- Worker は、SES の 429（毎秒の上限）と 5xx を、指数的な待ちで再試行する。

### 送信ドメイン

- **共有の送信ドメイン**：`mail.jp.<brand>.<domain>` から `no-reply@mail.jp.<brand>.<domain>` で送る。Easy DKIM（2048 ビット）、独自の MAIL FROM（`bounce.mail.jp.<brand>.<domain>`）、DMARC は `p=reject`（整合は SPF と DKIM の両方）。表示名はテナントの名前にできる。
- **テナントの独自の送信ドメイン**（E11）：テナントが `example.co.jp` などを登録すると、本システムが SES の識別子を作り、Easy DKIM の 3 つの CNAME と、MAIL FROM の MX・TXT、DMARC の推奨の値を示す。DKIM が `SUCCESS` になるまで、そのドメインでは送らない（共有のドメインで送る）。
  - DKIM が後で失敗に変わったら（CNAME の削除など）、共有のドメインに戻して送り、テナントに通知する。
  - 識別子は SES のテナントに紐づけ、他のテナントが同じドメインを使えないようにする。
- 本番のテナントで、共有の送信ドメインから送れる量に上限を置く（1 日 1 万通。値は E4 の前に見直す）。上限を超えるテナントには、独自のドメインを求める。共有のドメインの評判を、1 つのテナントが下げないため。

### 評判と抑止

- **テナントごとに SES のテナントを作る。** 評判のポリシーは Standard。本番のテナントの SES のテナントが自動で止められたら、その本番のテナントのメールだけが止まり、他のテナントとアカウント全体は続く。
- 開発・ステージングのテナントは、1 日の送信を 500 通までに限る。宛先は、その日の送信の中で同じアドレスに 10 通まで。
- バウンス（ハード）と苦情は、SES のテナントの抑止リストに入れ、`email_suppressions` にも写す（ダッシュボードで見せ、テナントの管理者が解除できる）。抑止中のアドレスには送らない。**抑止を理由に、サインアップ・再設定の画面の応答を変えない**（列挙の防止。[ADR-0015](0015-database-connection-password-and-enumeration.md)）。
- 送信の結果は、設定セットから EventBridge を経て Worker が受け、`email_messages` の状態と、テナントのログ（logs-and-streams の領域）に反映する。
- アカウント全体のバウンス率 2%・苦情率 0.05% を警告、3%・0.08% を重大の警報にする（SES の審査の値より手前）。

### 大阪

- 大阪の SES にも同じ識別子を作っておく（DKIM は別の鍵、DNS に大阪用の CNAME も置いてもらう）。リージョンの切り替えのときは、Worker が大阪の SES で送る。テナントの独自のドメインは、大阪の DKIM の確認も済んだものだけを大阪で使い、済んでいなければ共有のドメインで送る。
- 2 は、試すだけのテナントが送信事業者の契約を求められ、組み込みの速さ（K3）を下げる。日本の中小の事業者が送信ドメインの認証を自分で整えるのは負担が大きい。
- 3 は、国外の事業者にメールアドレスと本文（OTP を含む）を渡すことになり、法務の L1 の論点が増える。

## Consequences

- 良くなること：
  - テナントの設定なしで、SPF・DKIM・DMARC の整ったメールを送れる。
  - 1 つのテナントの濫用が、他のテナントとアカウント全体の送信を止めない。
- 引き受けるコスト：
  - メールの送信の代行が、電気通信事業法の「他人の通信の媒介」に当たるかは未確認（[intent.md](../intent.md) の L3）。結論が出るまで、E4 のメールの送信の Story を承認しない。
  - SES のテナントと識別子の上限（リージョンに 1 万）を、S2（本番 3 万）の前に引き上げる必要がある。
  - OTP を含む本文が、SES（AWS）を通る。送信の記録（`email_messages`）には本文を保存しない。

## Confirmation

- 結合テスト（SES の模擬）：`notify` の列に 10 万件を積んだ状態で、`auth` の列の送信が p95 10 秒以内に出る。
- 結合テスト：抑止中のアドレスで再設定を要求しても、画面の応答と時間が、抑止されていないアドレスと同じ。
- 訓練（staging）：SES のテナントを止めた状態で、他のテナントのメールが送られる。
- 合成監視：監視用のテナントから、主要なメールの事業者（Gmail、Outlook.com、国内の携帯の事業者のメール）の試験の受信箱へ 1 時間ごとに送り、受信までの時間と、迷惑メールのフォルダーに入ったかを測る（到達性の SLI）。

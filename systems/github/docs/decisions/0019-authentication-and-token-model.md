---
status: accepted
date: 2026-09-26
---

# ADR-0019: Web のログインは Better Auth、プログラムからのアクセスは細粒度のトークンを既定にする

## Context

GitHub には、人が Web でログインする経路と、プログラム（Git のクライアント、CLI、CI、App、AI エージェント）がトークンや SSH の鍵で入る経路がある。後者が要求の大半を占め、漏洩したときの被害も大きい。

本家は、パスワード・パスキー・2FA でログインし、プログラムからはクラシックの PAT（スコープが粗く、入れるすべてのリポジトリに効く）と、細粒度の PAT（1 つの持ち主・選んだリポジトリ・権限ごと）を使う。本家は細粒度を推奨しているが、細粒度には「1 つの持ち主だけ」「メンバーでない公開のリポジトリに書けない」などの制約が残る（[Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)、2026-09-26 に確認）。

## Options

### Web のログイン

A. Better Auth を自前でホストする（Slack の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md) と同じ）
B. マネージドの IdP（Cognito など）

### トークン

1. **細粒度の PAT を既定にし、クラシックの PAT も互換のために残す。すべてに期限を必須にする**
2. 細粒度の PAT だけにする
3. 本家と同じ（クラシックは無期限も可）

## Decision

A と 1 を採用する。詳細は [identity-and-permissions.md](../architecture/identity-and-permissions.md) の 3 節、[api-and-webhooks.md](../architecture/api-and-webhooks.md) の 6 節にある。

### Web のログイン

- Better Auth で、パスワード（漏洩済みのものは拒否）、パスキー、2FA（TOTP、セキュリティキー、リカバリーコード）、セッションを扱う。SMS の 2FA は持たない。
- 使い方の規則は Slack の ADR-0012 と同じにする：Better Auth は「だれか」だけを持つ。`organization` プラグインは使わない（Organization・チーム・ロールは自前のテーブルと `can()` で持つ）。公開するエンドポイントを許可したものだけにする。版を完全に固定する。
- 2FA の必須化は、本家の条件（Organization の owner、App の持ち主、リリースの作成者など）に寄せ、45 日の登録期間と 7 日の猶予を置く（[About mandatory 2FA](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/about-mandatory-two-factor-authentication)、2026-09-26 に確認）。
- Git の HTTPS は、アカウントのパスワードを受け付けず、トークンだけを受け付ける（本家と同じ）。
- B は、Slack の ADR-0012 と同じ理由（アカウント数に比例する費用、組織モデルとの二重管理）で採らない。

### トークン

- **トークンの作成の画面と API の既定を、細粒度の PAT にする。** クラシックの PAT は、細粒度でできないこと（複数の持ち主にまたがる、fork 先への PR の作成）のために残す。Organization は、クラシックの PAT を拒否でき、細粒度の PAT に承認を求められる（既定で承認を要する）。
- **すべての PAT に期限を必須にする（最長 366 日）。** 本家はクラシックの無期限を許すが、AI エージェントがトークンを大量に作る時代に、失効しないトークンを増やさない（本家との違い）。
- **トークンの形式は、本家と同じく「接頭辞 ＋ 乱数 ＋ CRC32 のチェックサム」**（[token formats](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/)、2026-09-26 に確認）。接頭辞は本家と衝突させない。DB にはハッシュだけを置く。
- 公開のリポジトリへの push や、本家の secret scanning partner program で見つかったトークンは、自動で失効させる。
- 2 は、細粒度の制約のために、fork を使った貢献の流れを API で自動化できなくなる。
- 3 は、失効しない強いトークンが残り続ける。

## Consequences

- 良くなること：
  - 新しく作られるトークンの大半が、1 つの持ち主・選んだリポジトリ・必要な権限だけに絞られ、期限を持つ。漏洩の被害の範囲が小さい。
  - 細粒度の PAT と App が同じ権限の語彙を使うので、`can()` の上限の表が 1 つで済む。
- 引き受けるコスト：
  - トークンの種類が 2 つ（PAT）＋ App・OAuth・ジョブのトークンと多く、それぞれの上限を `can()` で正しく扱う必要がある。
  - 期限の必須化は、本家の無期限のクラシックの PAT に慣れた利用者の CI を、期限の切れで止めうる。期限の 7 日前と当日にメールで知らせる。
  - Better Auth の版の更新のたびに、認証の結合テストを通す運用が要る。

## Confirmation

- 表駆動テスト：identity-and-permissions.md の 5.4・5.5 節（資格情報の上限）。
- 結合テスト：Git の HTTPS でパスワードを拒否する。期限切れ・取り消し済み・チェックサムの誤ったトークンを拒否する（取り消しは 30 秒以内）。Organization の方針（クラシックの拒否、承認待ち）が、公開の資源の読み取りを止めない。
- lint：トークンの平文を DB・ログに書く経路を禁止する（ログの秘密のマスクを CI で検査する）。

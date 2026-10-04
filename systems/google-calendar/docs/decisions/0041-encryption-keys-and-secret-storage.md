---
status: accepted
date: 2026-10-04
---

# ADR-0041: 保存時の暗号化は、データの種類ごとの KMS の鍵（マルチリージョン）で行い、テナントごとの鍵と予定の項目の暗号化は持たない。本システムの秘密は、受け取って照らすだけのもの（アプリ用のパスワード、トークン、ICS の秘密のアドレス）を SHA-256 の照合の値で、平文が要るもの（Webhook の署名の秘密、同期のトークンの鍵、VAPID の鍵）を封筒の暗号化で持ち、平文で DB に置かない

## Context

本システムが持つデータには、性質の違うものがある。

- **予定の中身**：タイトル、場所、説明、参加者のメールアドレス。量が多く、検索（`pg_bigm`）・`redact()`・展開の索引が平文を読む。
- **外から来た生のデータ**：iMIP の受信の生のメール（S3）、ICS の取り込みの元のファイル。本文に第三者の個人データを含む。
- **監査ログ**：改ざんされてはならない。
- **本システムの秘密**：
  - CalDAV のアプリ用のパスワード（[architecture/README.md](../architecture/README.md) の 6 節。OS の標準のカレンダーが Basic 認証で 15 分ごとに送る）
  - ICS の秘密のアドレスの鍵（URL を知る人はだれでも予定を読める）
  - Webhook の署名の秘密（`<Brand>-Signature`）、OAuth のクライアントの秘密
  - 同期のトークンの HMAC の鍵（[ADR-0005](0005-change-log-and-sync-tokens.md)）
  - Web Push の VAPID の秘密鍵（RFC 8292）
  - iMIP の受け口の `token`（[ADR-0015](0015-imip-addressing-and-trust.md)）

CalDAV の資格情報の窃取は、脅威モデルの主な項目である（[security.md](../architecture/security.md) の 3 節）。アプリ用のパスワードは、CalDAV の読み出し（S1 で 2,000 件/秒）のたびに確かめる。遅いハッシュ（argon2id など）を要求ごとに使うと、CPU を大きく使う。

DR の大阪で、同じ鍵で読めなければならない（NFR-007）。

## Options

保存時の暗号化：

1. **データの種類ごとの KMS の鍵（マルチリージョン）。テナントごとの鍵は持たない**
2. テナントごとの KMS の鍵（組織が自分の鍵を持てる形を含む）
3. 予定の項目をアプリの層で暗号化する

秘密：

- a. **受け取って照らすだけの高いエントロピーの秘密は、SHA-256 の照合の値で持つ。送るとき・署名するときに平文が要る秘密だけ、封筒の暗号化で持つ**
- b. すべての秘密を遅いハッシュで持つ
- c. すべての秘密を封筒の暗号化で持つ

## Decision

1 と a を採用する。

### 鍵の配置

| 鍵（エイリアス） | 守るもの | 使えるロール | 置き場所 |
| --- | --- | --- | --- |
| `aurora-data` | Aurora のクラスタ（保存時の暗号化）、スナップショット | RDS のサービス | prod、マルチリージョンの鍵（東京が主、大阪にレプリカ） |
| `s3-imip-raw` | iMIP の受信の生のメール（S3 の SSE-KMS の既定の暗号化） | SES の受信（`GenerateDataKey`）、`imip-inbound`（`Decrypt`） | prod、東京と大阪にそれぞれ |
| `s3-ingest` | ICS の取り込みの元のファイル、ICS の書き出しのファイル | `api`、`worker-*` の該当のもの | prod |
| `s3-assets` | Web の資産、tzdata のゾーンのデータ（公開。SSE-S3 でよい） | — | prod |
| `app-secrets` | 封筒の暗号化の鍵の鍵（下の表） | 秘密ごとに決めたロールだけ（キーポリシーの暗号化のコンテキストで絞る） | prod、マルチリージョン |
| `audit-archive` | log-archive の監査ログの写し | log-archive の書き込みのロール | log-archive のアカウント |
| `backup-vault` | AWS Backup の保管庫 | Backup のサービス | prod と大阪 |

- マルチリージョンの鍵は、大阪のレプリカを先に作る（[infrastructure.md](../architecture/infrastructure.md) の 6 節）。
- SES の受信の S3 の保存は、SES の「メッセージの暗号化」（S3 の暗号化のクライアントでの暗号化）を使わず、バケットの既定の SSE-KMS（`s3-imip-raw`）を使う。SES の暗号化は、取り出しに S3 の暗号化のクライアントが要り、その SDK は Java と Ruby だけが挙がっているため（[Deliver to S3 bucket action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html)、2026-10-04 に確認）。同じ文書は、バケットの暗号化に自分の KMS の鍵を使うときは、エイリアスではなく完全な ARN を指定するよう求めている。
- 鍵の削除の予約・無効化は、break-glass のロール以外に SCP で禁じる（他の題材と同じ）。

### 秘密の持ち方

| 秘密 | 形 | 持ち方 | もう一度見せるか |
| --- | --- | --- | --- |
| CalDAV のアプリ用のパスワード | `<brand>_ap_` ＋ 乱数（[ADR-0035](0035-accounts-auth-library-and-credentials.md) の形） | SHA-256 の照合の値（ADR-0035）。確かめた結果を Valkey に 60 秒持つ（鍵は照合の値。停止から 60 秒以内に効かなくする [accounts-and-orgs.md](../architecture/accounts-and-orgs.md) の要件に合わせる） | 見せない（作ったときだけ） |
| OAuth のアクセストークン・更新のトークン、API の鍵 | 接頭辞つきの乱数（ADR-0035） | 同上 | 見せない |
| ICS の秘密のアドレスの `token` | 160 ビットの乱数（[ADR-0025](0025-ics-subscriptions-both-directions.md)） | SHA-256 の照合の値だけ | 見せない（作り直す） |
| Webhook の署名の秘密、OAuth のクライアントの秘密 | 256 ビットの乱数 | 封筒の暗号化（送るとき・確かめるときに平文が要る） | Webhook の秘密は作ったときだけ。作り直せる |
| 同期のトークンの HMAC の鍵 | 256 ビット | Secrets Manager。90 日ごとに替え、前の鍵は 30 日（トークンの有効の期間）残す | — |
| VAPID の秘密鍵 | P-256 | `app-secrets` で包んで保存（大阪へレプリカ）。入れ替えの手順は reminders-and-notifications の領域（[reminders-and-notifications.md](../architecture/reminders-and-notifications.md)） | — |
| iMIP の受け口の `token` | 128 ビット | 照合の値（`imip_addresses.token_hash`） | 予定の ORGANIZER として送るので、送るたびに封筒の暗号化から作る |

- 高いエントロピーの秘密（120 ビット以上の乱数）には、遅いハッシュもペッパーも要らない。SHA-256 の照合の値から秘密を総当たりで求めることはできない。ログインはパスワードを持たない（ADR-0035）。
- 接頭辞（`<brand>_ap_` など）は、公開のリポジトリでの秘密の検出（シークレットスキャン）に載せる。
- ログ・トレース・エラーの報告に、秘密と ICS の秘密のアドレスの経路を出さない（[observability.md](../architecture/observability.md) の 2 節）。

### 持たないもの

- **テナントごとの鍵**：S1 で 30 万の個人のテナントがあり、鍵の数と KMS の要求の数が重い。組織が自分の鍵を持つ形（BYOK）は、大口の契約の求めが出たら別の ADR で決める。
- **予定の項目のアプリの層の暗号化**：検索・`redact()`・展開の索引が平文を読む。守りは RLS（[ADR-0004](0004-tenancy-and-rls.md)）と保存時の暗号化と、運用者の JIT（[security.md](../architecture/security.md) の 8 節）で行う。

### 他の案を選ばなかった理由

- **2（テナントごとの鍵）**：上のとおり。暗号の消去（鍵を消してテナントのデータを読めなくする）の利点はあるが、バックアップの 35 日の期限で同じことができる（[ADR-0042](0042-audit-log-and-data-lifecycle.md)）。
- **3（項目の暗号化）**：上のとおり。
- **b（遅いハッシュ）**：CalDAV の 2,000 件/秒で、1 回 50ms の argon2id なら 100 vCPU を使う。キャッシュしても、15 分ごとのポーリングで当たりの率が低い。
- **c（すべて封筒の暗号化）**：照合のたびに復号が要り、DB とアプリの鍵が同時に漏れれば、すべての秘密が平文になる。

## Consequences

- 良くなること：
  - 鍵の数が少なく、DR の大阪でも同じ鍵で読める。
  - CalDAV の毎回の認証が安い（SHA-256 1 回か、Valkey の 1 回の読み出し）。
  - DB の漏えいだけでは、アプリ用のパスワード・トークンを使えない。
- 引き受けるコスト：
  - テナントごとの暗号の消去ができない。解約したテナントは、行の削除とバックアップの期限で消す。
  - ICS の秘密のアドレスは、もう一度見せられない。忘れたら作り直す（[ADR-0025](0025-ics-subscriptions-both-directions.md) と同じ）。

## Confirmation

- Terraform のポリシーの検査：上の表の鍵の `kms:Decrypt` を、表のロール以外に与えない。マルチリージョンの鍵に大阪のレプリカがある。
- CI：秘密の列（`*_hash`・`*_ciphertext` 以外の名前で秘密を持つ列）を作るマイグレーションを拒否する（列の名前と型の許可リスト）。
- 結合テスト：アプリ用のパスワード・ICS の秘密のアドレスを DB から読んでも照合の値しかないこと、停止の後 60 秒で Valkey の照合の結果の写しが使われなくなること。
- 本番：秘密の形の走査（ログ）、シークレットスキャンの通知を呼び出しにつなぐ（[observability.md](../architecture/observability.md) の 5 節）。

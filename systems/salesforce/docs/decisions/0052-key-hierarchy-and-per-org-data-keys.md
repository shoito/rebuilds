---
status: accepted
date: 2026-09-28
---

# ADR-0052: KMS の鍵はセルと用途ごとに持ち、組織ごとのデータキーで S3 の組織のファイルとアプリの秘密を暗号化する。レコードは DB の保存時の暗号化だけにし、組織の削除は鍵の破棄で仕上げる

詳細は [security.md](../architecture/security.md) の 5 節。

## Context

各領域は「組織のデータキーで暗号化する」と書いた（一括の結果、レポートの非同期の結果、監査の外部の保管、画面のフローの状態、カーソル）。鍵の階層は security の領域で決めるとされた（[events-and-integrations.md](../architecture/events-and-integrations.md)、[sandboxes-and-deploy.md](../architecture/sandboxes-and-deploy.md)、[orgs-users-and-auth.md](../architecture/orgs-users-and-auth.md)）。

- 組織は S1 で 5,000、S3 で 50 万ある。AWS KMS の顧客管理の鍵の既定の上限は、アカウントとリージョンごとに 100,000（引き上げを申請できる）（[AWS KMS resource quotas](https://docs.aws.amazon.com/kms/latest/developerguide/resource-limits.html)、2026-09-28 に確認）。
- 監査の外部の保管は Object Lock で期限まで消せない。組織の削除では、鍵の破棄で読めなくする（[ADR-0046](0046-setup-audit-trail-and-login-history.md)）。
- レコードの値をアプリで暗号化すると、ピボットの索引・一意・並べ替え・集計ができない。

本家は、組織ごとの tenant secret と本家の master secret（KDF の種）から、HSM の上の PBKDF2 でデータの暗号化の鍵を導き、導いた鍵を保存しない。組織が自分の鍵を持ち込む方式や、鍵の導出を使わない方式もある（[Behind the Scenes: The Shield Platform Encryption Process for Tenant Secrets](https://help.salesforce.com/s/articleView?id=xcloud.security_pe_encryption_process.htm&type=5)、2026-09-28 に確認。本家は master secret を primary secret と呼び替えた）。本家の Hyperforce は、組織ごとの暗号の鍵を持つと説明する（[Hyperforce](https://www.salesforce.com/platform/public-cloud-infrastructure/)、2026-09-28 に確認）。鍵の置き方の細部は公開されていない。

## Options

1. **KMS の鍵はセル × 用途で持つ。組織ごとのデータキー（DEK）を KMS の `GenerateDataKey` で作り、包んだ形で DB に持つ。S3 の組織のファイルとアプリの秘密は DEK で暗号化する。レコードは Aurora の保存時の暗号化（セルの鍵）だけ**
2. 組織ごとに KMS の鍵を 1 つ持つ
3. 全てをセルの鍵 1 つで暗号化する

## Decision

1 を採用する。

- KMS の鍵（顧客管理、マルチリージョンの鍵で大阪に写す）：`aurora`（主のクラスタ・`events` のクラスタの保存時の暗号化）、`s3-org`（組織の DEK を包む）、`app-secrets`（Webhook・外向きの呼び出し・OAuth のクライアントの秘密の DEK を包む）、`cursor`（カーソルの鍵を包む）、`audit-archive`（監査のアカウントの鍵。組織の監査の DEK を包む）、`backup`（AWS Backup の保管庫）。
  > 2026-09-28 の注記：`aurora` の鍵は、項目の変更の履歴の `history` のクラスタ（[ADR-0047](0047-field-history-tracking-and-retention.md) の注記）の保存時の暗号化にも使う。
- 組織の DEK：`org_keys(org_id, purpose, key_version, wrapped_dek, state, created_at, destroyed_at)`。`purpose` は `files`（S3 の一括・レポート・エクスポート・添付）、`audit`（外部の保管）、`secrets`（組織の秘密）。暗号は AES-256-GCM、AAD に `org_id`・`purpose`・対象の ID を入れ、別の組織の暗号文を差し込めないようにする。
- DEK は 1 年ごとに新しいバージョンを作る。古いバージョンは、それで暗号化したものが消えるまで残す。平文の DEK は Runtime・Worker のプロセスの中に 5 分だけ置く。
- レコード（`records`・ピボット・共有の表・履歴）はアプリで暗号化しない。Aurora の保存時の暗号化と、RLS と、データ層の外からの SQL の禁止で守る。項目ごとの暗号化（本家の Shield に相当）は MVP の後の課題にする。
- 組織の削除：行と S3 のファイルを消した後（[ADR-0043](0043-orgs-editions-licenses-and-users.md) の 7 日）、全ての `org_keys` の `wrapped_dek` を消し、`destroyed_at` を残す。Object Lock の監査の保管と、S3 のバージョンの残りは、鍵がないので読めない。Aurora のバックアップ（35 日）の中の行は、バックアップの期限で消える（[ADR-0053](0053-operator-access-and-data-lifecycle.md)）。
- 2 は、S3 で 50 万の鍵になり、既定の上限を超え、鍵の費用（東京で顧客管理の鍵のバージョン 1 つにつき月 1 USD）が組織の数に比例する。既定の上限はリージョンで 10 万鍵（[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/awskms/current/ap-northeast-1/index.json)、[AWS KMS の resource quotas](https://docs.aws.amazon.com/kms/latest/developerguide/resource-limits.html)、2026-09-28 に確認）。3 は、組織の単位で暗号学的に消せない。

## Consequences

- 良くなること：
  - 組織の数に依らず、KMS の鍵の数が一定。
  - 組織の削除を、消せない保管（Object Lock）を含めて鍵の破棄で仕上げられる。
  - 別の組織の暗号文の差し込みを AAD で防ぐ。
- 引き受けるコスト：
  - レコードは組織ごとの鍵で守られない。DB の特権の侵害は、全組織のレコードに及ぶ。運用者のアクセスの統制（ADR-0053）と監査で抑える。
  - 組織が自分の鍵を持ち込む方式（BYOK）がない。大口の組織の要望は、専用のセルと、セルの鍵を組織の管理にする形で MVP の後に検討する。
  - DEK の包みを解く KMS の呼び出しが、プロセスの起動と 5 分ごとに要る。

## Confirmation

- 結合テスト：別の組織の `org_id` の AAD で、暗号文が復号できない。
- 結合テスト：組織の削除の後、その組織の S3 のオブジェクト（監査の保管を含む）が、全てのロールで復号できない。
- IaC の検査：KMS の鍵の削除の予約と、キーポリシーの変更を、break-glass のロール以外に許さない（SCP）。
- lint：S3 の組織のファイルへの書き込みを、暗号化のライブラリの外で行うことを禁止する。

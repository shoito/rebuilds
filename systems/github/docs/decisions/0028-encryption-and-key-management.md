---
status: accepted
date: 2026-09-26
---

# ADR-0028: 通信はすべて TLS、保存時は KMS の鍵をデータの種類ごとに分け、最も価値の高い秘密情報だけアプリ層で暗号化する

> 識別子（ヘッダー・接頭辞・ドメイン・環境変数・パスの名前）は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に合わせて `<Brand>`・`<brand>`・`<BRAND>` の置き換え用の名前にした（2026-09-26）。本家の名前は、出典の説明としてだけ書く。

## Context

GitHub の保存するデータは、性質の違う 3 つの層に分かれる。

- **Git の中身**：ストレージのノードのローカルのディスクに、3 つの複製として置く（[ADR-0003](0003-replicated-git-storage.md)）。量が最も多く、読み書きの速さが要る。
- **メタデータと添付**：Aurora、S3、検索のクラスタ、SQS。
- **少数だが価値の高い秘密情報**：Actions のシークレット、Webhook の秘密、OAuth のアプリのクライアントの秘密、TOTP の種、SSH のホスト鍵、コミットの署名鍵、利用者のトークン。1 件の漏洩が、利用者の本番環境（Actions のシークレットはクラウドの認証情報であることが多い）に直結する。

暗号化の設定のいくつかは、作った後に変えられない（Aurora のクラスタの暗号化、EBS のボリュームの鍵）。最初のリソースを作る前に決める。

本家は、GitHub.com のソースコードを暗号化されたディスクに置いている（[Git data encryption at rest](https://github.blog/changelog/2019-05-22-git-data-encryption-at-rest/)）。鍵の管理の詳細は公開されていない（未検証）。Actions のシークレットは、API に送る前にリポジトリ・Organization ごとの公開鍵で libsodium の sealed box で暗号化させる（[Encrypting secrets for the REST API](https://docs.github.com/en/rest/guides/encrypting-secrets-for-the-rest-api)）。

## Options

1. **AWS の既定の暗号化に任せる**
2. **データの種類ごとに KMS のカスタマー管理キー（CMK）を分けて全ストレージで使い、価値の高い秘密情報だけアプリ層のエンベロープ暗号化を重ねる。トークンはハッシュだけを保存する**
3. 2 に加えて、**リポジトリ・Organization ごとの鍵で Git の中身もアプリ層で暗号化する**

## Decision

2 を採用する。Slack の ADR-0017 を土台にし、Git に固有の部分を加える。

- 1 は、鍵の利用の記録（CloudTrail）とキーポリシーによる利用者の限定がなく、スナップショットの持ち出しに弱い。
- 3 は、Git の本体がディスクの平文を前提に動く（パック、`mmap`、`git` のコマンド）。暗号化するファイルシステムを自前で挟むことになり、性能と運用（fsck、修復）を大きく損なう。企業向けの鍵の要求は、後で 2 の上に足す。

### 転送中

- 外部：TLS 1.2 以上、HSTS（`includeSubDomains; preload`）。SSH は本家と同じ鍵交換・暗号の方式に揃え、古い方式（`ssh-dss`、SHA-1 の署名）を受け付けない（具体的な一覧は [git-protocols.md](../architecture/git-protocols.md)）。
- 内部：ALB から先も TLS。Git ストレージの RPC は mTLS にし、証明書で呼び出し元のサービスを限定する。Aurora は `rds.force_ssl`。

### 保存時

| 対象 | 方式 | 鍵 |
| --- | --- | --- |
| Git ストレージ（インスタンスストアの NVMe） | ハードウェアの XTS-AES-256。無効にできない。鍵はデバイスごとに作られ、インスタンスの停止・終了で消える（[AWS: SSD instance store volumes](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ssd-instance-store.html)） | Nitro が管理 |
| Git ストレージ（EBS を使う場合） | EBS の暗号化 | `git` |
| Git のバックアップ（S3） | SSE-KMS、バケットキー | `git-backup` |
| LFS、リリースの成果物、添付、アバター | SSE-KMS | `objects` |
| Actions のログ・成果物・キャッシュ | SSE-KMS | `actions`（Actions のアカウントに置く） |
| Aurora | クラスタ、スナップショット | `db` |
| 検索のクラスタ | 保存時の暗号化 | `search` |
| SQS、CloudWatch Logs、監査ログのアーカイブ | SSE-KMS | `queue`、`logs`、`audit` |
| Secrets Manager | — | `secrets` |

- ストレージのノードはインスタンスストアを使う（ADR-0031、[infrastructure.md](../architecture/infrastructure.md)）。インスタンスストアでは CMK を使えない。代わりに、インスタンスを終えれば鍵ごと消えるので、ノードの廃棄でデータが確実に読めなくなる。EBS の行は、災害復旧で EBS 付きのインスタンスに代えるとき（ADR-0032）のためにある。
- CMK は自動のローテーション（年 1 回）、削除の待機は 30 日、削除の予約はアラートにする。
- 災害復旧（大阪）で復号できるよう、`db`・`git-backup`・`objects`・`secrets`・`app-secrets` はマルチリージョンキーにする。

### アプリ層の暗号化（エンベロープ）

対象は、Actions のシークレット、Actions のシークレットの libsodium の秘密鍵、Webhook の秘密、OAuth のアプリ・App のクライアントの秘密と App の秘密鍵、TOTP の種。

- 行ごとにデータキーを作り、CMK `app-secrets` で包んで同じ行に置く。
- `app-secrets` の `Decrypt` を許すのは、その値を使うサービス（Actions のシークレットの配布、Webhook の送信器、認証）のロールだけ。Web・API の一般のロールには許さない。Aurora のスナップショットや `db` の鍵だけでは平文を得られない。
- Actions のシークレットは、API では本家と同じく sealed box で受ける。平文にするのは、ジョブの配置の時の Actions の Secrets service の中だけ（ADR-0025、[actions.md](../architecture/actions.md) の 6 節）。

### ハッシュで持つもの

- 利用者のトークン（PAT、OAuth、App、`<BRAND>_TOKEN` 相当）：本家と同じ接頭辞＋チェックサムの形式で発行し、DB には SHA-256 だけを置く。漏洩の走査と、失効の API（[security.md](../architecture/security.md) の 10 節）は、この形式に頼る。
- パスワード：Argon2id。

### 署名の鍵

- SSH のホスト鍵：種類（Ed25519、ECDSA、RSA）ごとに Secrets Manager に置き、単独で入れ替えられるようにする。本家は 2023 年に RSA だけを入れ替えた（[We updated our RSA SSH host key](https://github.blog/news-insights/company-news/we-updated-our-rsa-ssh-host-key/)）。
- Web の操作によるコミットの署名、監査ログのダイジェストの署名：KMS の非対称キーで署名し、秘密鍵をプロセスに出さない。コミットの署名の形式（OpenPGP・SSH）への組み立ては [pull-requests.md](../architecture/pull-requests.md) で決める。

### 将来：顧客の鍵

企業顧客が自分の鍵を求めたら、次の順で進め、新しい ADR を書く。

1. Organization ごとのデータキーを、メタデータ（Issue・PR の本文）と S3 のオブジェクトに入れる。
2. Git のストレージは、Organization のリポジトリを専用の暗号化ボリューム（EBS と顧客の CMK）を持つノードの群に置く。リポジトリの単位の暗号化はしない。

## Consequences

- 良くなること：
  - 鍵の利用が CloudTrail に残り、キーポリシーで利用者を限定できる。
  - 最も価値の高い秘密情報は、DB の読み取り権限だけでは読めない。
  - トークンの漏洩を、形式で検知して失効できる。
  - Git の読み書きの経路に、アプリ層の暗号化の費用を持ち込まない。
- 引き受けるコスト：
  - インスタンスストアを使うと、Git の中身の鍵は顧客の管理にも KMS の記録にも入らない。企業顧客への説明が要る。
  - Secrets service と KMS が、Actions の起動の経路に入る。可用性を Actions と同じ水準で持つ。
  - ストレージのノードに入れる運用者は、平文の Git の中身を読める。break-glass と監査で守る。

## Confirmation

- IaC の検査：CMK 以外で暗号化された（または暗号化されていない）S3・Aurora・EBS・SQS・ログ・検索のクラスタがあれば失敗させる。
- AWS Config で本番の逸脱を検知する。
- 結合テスト：Web・API の一般のロールで `app-secrets` の `Decrypt` が拒否される。
- テスト：トークンの表・監査ログ・アプリのログに、トークンの平文が現れない。
- ホスト鍵の入れ替えを、ステージングで四半期に 1 回演習する（runbook の `host-key-rotation`）。

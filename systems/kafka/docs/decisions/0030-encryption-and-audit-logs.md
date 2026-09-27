---
status: accepted
date: 2026-09-27
---

# ADR-0030: 保存時は物理クラスタごとの KMS のキーで暗号化し、BYOK は Dedicated だけにする。監査ログは CloudEvents の形で S3 と索引に置く

## Context

テナントのトピックには、個人データを含みうるレコードが入る（intent.md の L4）。通信と保存の暗号化の単位と、監査ログの対象・形・保持を決める。

事実（いずれも 2026-09-27 に確認）：

- EBS の既定の暗号化はリージョンの設定で、既定のキーは AWS 管理の `aws/ebs`。顧客管理のキーに変えられる。既存のボリュームのキーは後から変えられない（[Encryption by default](https://docs.aws.amazon.com/ebs/latest/userguide/encryption-by-default.html)）。
- S3 Bucket Keys は、SSE-KMS の KMS への要求を最大 99% 減らす。暗号化の文脈はバケットの ARN になる（[S3 Bucket Keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html)）。
- KMS の対称の暗号の操作は、東京で 20,000 回/秒をアカウントとリージョンで共有する（[KMS request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)）。
- Confluent Cloud は、すべてのクラスタを既定で暗号化し、BYOK を Dedicated・Enterprise・Freight で提供する。キーは作成時に選び、変えられない（[BYOK overview](https://docs.confluent.io/cloud/current/security/encrypt/byok/overview.html)）。
- Confluent Cloud の監査ログは、組織ごとの独立したクラスタのトピックに CloudEvents 1.0 の形で出し、保持は 7 日。Basic は対象外（[Audit log concepts](https://docs.confluent.io/cloud/current/monitoring/audit-logging/cloud-audit-log-concepts.html)）。

## Options

保存時の暗号化のキー：

1. **物理クラスタごとの顧客管理のキー（CMK）。BYOK は Dedicated（S2）だけ**
2. AWS 管理のキー（`aws/ebs`、SSE-S3）
3. テナントごとのキー（共有の物理クラスタでも）

監査ログ：

- A. **ブローカーと制御面の事象を、CloudEvents の形で S3（改ざんできない保管）と、テナントが検索できる索引（90 日）に置く。組織ごとのトピックへの配信は S2**
- B. Confluent と同じく、組織ごとの監査ログのトピックだけ（S1 から）
- C. 監査ログを持たず、制御面の操作の記録だけ

## Decision

1 と A を採用する。詳細は [security-and-acls.md](../architecture/security-and-acls.md) の 6・8 節にある。

- **通信**：テナント向けは TLS 1.2 以上（1.3 を優先）、SASL_SSL のリスナーだけ。ブローカーの間とエージェントは mTLS。平文のリスナーを作らない。
- **保存時**：EBS と S3（SSE-KMS＋Bucket Keys）を、物理クラスタごとの CMK で暗号化する。キーのポリシーはその物理クラスタのノードの役割に絞る。物理クラスタの廃止では、キーの削除を予約する。
- **BYOK**：S2 の Dedicated だけ。利用者の KMS のキーを EBS と S3 に使い、作成時に決めて変えない。
- **監査ログの対象**：組織の操作、管理 API の変更、Kafka のプロトコルでの管理の操作（トピック・ACL・設定・レコードの削除・グループの削除）、認証の失敗と認可の拒否（分ごとにまとめる。Standard）、運用者のアクセス。produce・fetch の許可は対象にしない。秘密とレコードの中身を入れない。
- **経路**：ブローカーは内部のトピック `__<brand>_audit` に書き、エージェントが Firehose で S3 へ送る。S3 は Object Lock（1 年）。制御面の索引に 90 日置き、`GET /v1/audit-events` とコンソールで見せる。
- **形**：CloudEvents 1.0 の JSON。`type` は `<brand>.audit.v1.<分類>.<事象>`（名前は開発リポジトリで決める）。

2 を選ばない理由：キーのポリシーで物理クラスタごとに使い手を絞れず、廃止した物理クラスタのデータを暗号の上で消す手段がない。

3 を選ばない理由：共有の物理クラスタでは、EBS のボリュームを複数のテナントが使うので、ローカルのログをテナントごとのキーで分けられない。S3 だけを分けると、KMS の呼び出しとキーの数が増え、得るもの（部分的な暗号の上の削除）が小さい。

B を選ばない理由：S1 から組織ごとの監査ログのクラスタを作ると、テナントの数だけ論理クラスタが増える。多くのテナントは、コンソールでの検索で足りる。S2 で足す。

C を選ばない理由：認証の失敗・ACL の変更・トピックの削除を追えないと、事故の調査と、テナントへの説明ができない。

## Consequences

- 良くなること：
  - 物理クラスタごとに、キーの使い手と廃止の手順が閉じる。
  - 監査ログを全層でコンソールから検索でき、Basic も管理の操作を追える。
- 引き受けるコスト：
  - CMK の数と、KMS の要求の上限を管理する。Bucket Keys を必ず有効にする。
  - 監査ログの経路（内部のトピック、エージェント、Firehose、索引）を自前で保ち、抜けを監視する。
  - 監査ログに利用者のメールアドレスと IP が入り、個人データの保持の説明が要る（法務の確認待ち、L4）。

## Confirmation

- 設定の検査（CI の Terraform の検査）：EBS のボリュームと S3 のバケットが、物理クラスタの CMK で暗号化され、Bucket Keys が有効。平文のリスナーの設定がない。
- 結合テスト：TLS 1.1 と平文の接続が拒否される。
- 監査ログ：対象の操作をすべて行うテストで、索引に全件が載り、秘密とレコードが含まれない。ブローカーの記録の数と送った数が一致する。

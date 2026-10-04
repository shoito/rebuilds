---
status: accepted
date: 2026-09-27
---

# ADR-0045: KMS の鍵を用途ごとに 4 つに分け、暗号化の文脈とキーポリシーで使える主体を限る

詳細は [keys-and-secrets.md](../architecture/keys-and-secrets.md) の 3 節・4 節。

## Context

[ADR-0003](0003-token-formats-and-signing-keys.md) は署名の秘密鍵を KMS の対称鍵でエンベロープ暗号化すると決め、[ADR-0004](0004-credential-storage.md) は、戻す必要のある秘密をテナントごとのデータキーで暗号化し、pepper を KMS でエンベロープ暗号化すると決めた。鍵をいくつ持ち、誰が使えるかは、この領域に任されている。

AWS KMS（2026-09-27 に確認。[Rotate AWS KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)）：

- 顧客管理の対称鍵は、自動のローテーション（既定 365 日）ができる。古い素材は鍵を消すまで残り、古い暗号文を復号できる。
- マルチリージョンの鍵では、ローテーションは primary で設定し、replica へ複製される。
- 対称鍵の暗号の操作の上限は、東京で 1 秒 20,000 回（[ADR-0003](0003-token-formats-and-signing-keys.md)）。

pepper や署名鍵の KMS の鍵を失うと、全ユーザーのパスワードの照合か、全テナントの署名ができなくなる。

## Options

1. **用途ごとに 4 つの鍵（署名鍵、資格情報、pepper、保存）。テナントごとにはデータキーを分ける。暗号化の文脈を必須にする**
2. 1 つの KMS の鍵をすべての用途に使う
3. テナントごとに KMS の鍵を作る

## Decision

1 を採用する。

| KMS の鍵 | 包むもの | 使える主体 | 暗号化の文脈 |
| --- | --- | --- | --- |
| `<brand>-signing-keys` | 署名鍵ごとの DEK、外部 IdP の鍵（接続ごと。[ADR-0047](0047-signer-api-and-jwks-publishing.md)）ごとの DEK | Signer のタスクのロールだけ（`GenerateDataKey`・`Decrypt`） | `purpose=signing-key`、`tenant_id`、`kid`。外部 IdP の鍵は `purpose=external-idp-key`、`tenant_id`、`connection_id` |
| `<brand>-credentials` | テナント × バージョンの DEK | Auth・Management API・Worker（`Decrypt`）、Management API（`GenerateDataKey`） | `purpose=tenant-dek`、`tenant_id`、`version` |
| `<brand>-pepper` | pepper（バージョンごと） | Auth・Management API（`Decrypt`） | `purpose=pepper`、`version` |
| `<brand>-data` | Aurora・S3・SQS・Secrets Manager の保存 | 各 AWS のサービス（`kms:ViaService`） | サービスが付ける |

- どれもマルチリージョンの鍵（primary は東京、replica は大阪）。自動のローテーション 365 日を有効にする。
- キーポリシーの条件で、暗号化の文脈の `purpose` が違う復号を拒否する。
- 人と break-glass のロールに、署名鍵と pepper の鍵の `Decrypt` を与えない（[ADR-0056](0056-operator-access.md)）。
- `ScheduleKeyDeletion`・`DisableKey` を SCP で拒否し、例外は 2 人の承認の期限つきのロールだけ。キーポリシーの変更と削除の予約を即時に通知する。
- pepper は `GenerateDataKey` で作り、暗号文を Secrets Manager（大阪へ複製）と log-archive の S3（Object Lock）に置く。平文は保存しない。
- 2 は、1 つの主体の権限の誤りで、すべての秘密が復号できる。
- 3 は、S1 で 1 万、S3 で 100 万の KMS の鍵になり、費用と管理の量が見合わない（[ADR-0003](0003-token-formats-and-signing-keys.md) の A と同じ理由）。

## Consequences

- 良くなること：
  - 1 つのロールが乗っ取られても、復号できる秘密の範囲が用途で限られる。
  - CloudTrail に、どのテナントの何の復号かが残る。
- 引き受けるコスト：
  - KMS の鍵の数と、キーポリシーの管理が増える。
  - テナントの DEK のローテーションと、古いバージョンの書き直しのジョブが要る。

## Confirmation

- IAM の静的検査（Terraform の CI）と週次の監査：各鍵の `Decrypt`・`GenerateDataKey` を持つ主体が、上の表のとおり。
- 結合テスト：`purpose` の違う暗号化の文脈での復号が拒否される。
- 訓練（四半期、staging）：pepper の Secrets Manager の秘密を消した状態から、アーカイブの暗号文で復旧できる。

---
status: accepted
date: 2026-10-10
---

# ADR-0066: 鍵はポッドごと・用途ごとの KMS の鍵に分ける。買い手の個人のデータの列と事業者の決済の提供者などの認証の情報は、ポッドの DB に KMS の封筒の暗号（AES-256-GCM、データの鍵はポッド・月ごと、AAD にショップと行）で置き、Secrets Manager はシステムの秘密だけに使う。完全一致の検索はショップごとに派生した鍵の HMAC の索引で行う

## Context

- 買い手の氏名・住所・電話・メールは、チェックアウト・注文・顧客の行にある（[cart-and-checkout.md](../architecture/cart-and-checkout.md) の 10 節は「暗号化した列」を security の領域に任せた）。DB のスナップショットや読み出しの写しの漏えいで、平文が出ないようにしたい。
- 管理画面は、メール・電話で顧客を探す（[merchant-admin-and-staff.md](../architecture/merchant-admin-and-staff.md) の 6.1 節）。
- [ADR-0006](0006-payments-via-providers.md) は、事業者ごとの提供者の認証の情報を Secrets Manager の参照で持つとした。S1 で 5 万ショップ、S3 で 500 万ショップの秘密を Secrets Manager に置くと、秘密ごとの月額の課金と、取得の API の速さが問題になる（[Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/)、単価は**未検証**）。
- ポッドは障害の範囲の単位で、ショップはポッドの間を移る（[ADR-0002](0002-pods-and-shop-placement.md)）。
- ショップごとの暗号化の鍵は MVP の後（[roadmap.md](../roadmap.md) の延期の一覧）。

## Options

1. **ポッド・用途ごとの KMS の鍵、列の封筒の暗号（データの鍵はポッド・月ごと）、HMAC の索引。事業者の認証の情報も同じ封筒の暗号で DB に**
2. 保存の暗号（Aurora の KMS）だけ
3. ショップごとの KMS の鍵

## Decision

1 を採用する。詳細は [security.md](../architecture/security.md) の 5 節。

- KMS の鍵：`kms-pod-<id>-storage`、`kms-pod-<id>-pii`、`kms-pod-<id>-secrets`、全体の `kms-global-storage`・`kms-identity`、署名の `kms-sign-identity`・`kms-sign-functions`（ECC P-256）、`kms-archive`。東京と大阪の複数のリージョンの鍵にする。
- 列の暗号：AES-256-GCM、`v1|<key_id>|<nonce>|<ciphertext>`、AAD は `shop_id`・表・列・行の ID。データの鍵はポッド・月ごとに作り、包んだものを `data_keys` に置く。平文の鍵はタスクのメモリーに 1 時間まで。
- 完全一致の検索：正規化した値の HMAC-SHA256。鍵はポッドの索引の鍵から HKDF でショップごとに派生する。
- 事業者の提供者・運送会社の認証の情報は、`kms-pod-<id>-secrets` の封筒の暗号でポッドの DB に置く。Secrets Manager はシステムの秘密（全体の DB の資格情報、許可証の HMAC の鍵、提供者のプラットフォームの鍵）だけ。[ADR-0006](0006-payments-via-providers.md) の「Secrets Manager の参照で持つ」をこれに置き換える。
- 移し替えでは、`shop-mover` が元の鍵で復号し先の鍵で暗号化し直し、HMAC の索引を作り直す（[ADR-0012](0012-shop-mover-logical-decoding-and-cutover.md)）。`pii`・`secrets` の Decrypt はアプリのタスクのロールと `shop-mover` だけに与え、人のロールに与えない。
- 少ない回数の署名（入場の主張、導入の JWT、関数の機械語）は KMS の非対称の鍵で署名する。多い回数の HMAC（許可証）は、メモリー・KeyValueStore に置く鍵を 7 日で入れ替える（[ADR-0025](0025-queue-pass-tokens.md)）。

### 他の案を選ばなかった理由

- **2（保存の暗号だけ）**：DB に接続できる者（break-glass、乗っ取ったアプリのタスク以外の経路）に平文が見える。読み出しの写し・スナップショットの共有の誤りで平文が出る。
- **3（ショップごとの KMS の鍵）**：S1 で 5 万の鍵の月額と、KMS の要求の速さの上限が問題になる。MVP の後に、顧客の持つ鍵として検討する。

## Consequences

- 良くなること：
  - DB の写しやスナップショットだけでは、買い手の個人のデータと事業者の認証の情報が読めない。
  - 他のショップの行への暗号文の写し替えを、AAD で検出できる。
- 引き受けるコスト：
  - 暗号化した列で、部分一致・並べ替えの検索ができない。
  - 移し替えに、暗号化し直しの段が加わる。
  - データの鍵の管理（月ごとの作成、古い鍵の保持、入れ替え）を持つ。

## Confirmation

- 性質ベーステスト：PROP-SEC-002（AAD の結び付き）、PROP-SEC-003（ショップごとの HMAC）。
- IaC の検査：人のロールに `pii`・`secrets` の鍵の Decrypt がない。鍵の削除の予約が SCP で禁止されている。
- lint：D1 の列を平文の型で読み書きするコードを禁止する（暗号の型を通す）。

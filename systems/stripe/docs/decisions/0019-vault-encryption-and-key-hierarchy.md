---
status: accepted
date: 2026-09-26
---

# ADR-0019: カード番号は CDE 専用の KMS の鍵でエンベロープ暗号化し、鍵の操作を役割ごとに分ける

## Context

ADR-0005 で、カード番号（PAN）を CDE（別の AWS アカウント）に閉じ込め、CDE 専用の KMS の鍵で暗号化すると決めた。残っているのは次の点である。

- どの仕組みで暗号化するか（KMS、AWS Payment Cryptography、CloudHSM）。
- 鍵の階層、ローテーション、同じカードを見分ける指紋の作り方。
- 誰が暗号化でき、誰が復号できるか。

PCI DSS は、保存した PAN を読めない形にし（要件 3.5.1）、鍵を文書にした手順で管理し（要件 3.6・3.7）、オーソリ後にセキュリティコード（CVC）を残さないことを求める（要件 3.3.1）。本家は、PAN を AES-256 で暗号化し、復号の鍵を別のマシンに置き、内部のサーバーが平文を取得できない構成をとる（[Stripe のセキュリティ](https://docs.stripe.com/security)）。

暗号化の方式は、保存したデータの形を決めるので、Vault の最初の実装の前に決める。

## Options

1. **KMS の対称 CMK で DEK を包むエンベロープ暗号化**。指紋は KMS の HMAC 鍵
2. **AWS Payment Cryptography** で PAN を暗号化する
3. **CloudHSM** に鍵を置き、アプリが PKCS#11 で暗号化する
4. トークン化の外部サービス（ADR-0005 で不採用）

## Decision

1 を採用する。詳細は [card-vault.md](../architecture/card-vault.md) の 4・5 節にある。

- **鍵の階層**：`cde-pan`（KMS の対称 CMK、マルチリージョン）→ DEK（AES-256、1 時間または 100 万件ごとに新しくする）→ PAN（AES-256-GCM）。
- **役割ごとに鍵の操作を分ける。**

  | 役割 | `cde-pan` | `cde-fp` | `cde-sad` |
  | --- | --- | --- | --- |
  | Vault Ingress | `GenerateDataKey` のみ | `GenerateMac` のみ | 暗号化 |
  | Vault Core（本体からの照会・消去） | なし | なし | なし |
  | Connector Gateway | `Decrypt` のみ | なし | 復号 |
  | 消去の Worker | なし | なし | なし |

  入口の役割は復号できないので、入口が破られても保存済みの PAN を読めない。
- **CVC** は `cde-sad` で暗号化して ElastiCache に TTL 30 分で置き、最初のオーソリで取り出すと同時に消す。
- **指紋**は KMS の HMAC 鍵（`cde-fp`）で作る。加盟店向けは `account_id` を含めて加盟店ごとに変え、内部向け（不正検知）は加盟店をまたいで同じにする。
- **ローテーション**：CMK は KMS の自動ローテーション（365 日）。旧い鍵素材は KMS が保持し、復号に自動で使う（[Rotate AWS KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html)）。HMAC 鍵は自動で回せないので、2 年ごとに新しい鍵で全件の指紋を計算し直して切り替える。漏洩の疑いでは `ReEncrypt` で DEK を包み直す。
- **理由**：
  - KMS の HSM は FIPS 140-3 Security Level 3 の認定を受けており、平文の鍵を誰も取り出せない。AWS は、Level 3 のために CloudHSM を使っていた利用者が KMS だけで足りるとしている（[AWS のブログ](https://aws.amazon.com/blogs/security/aws-kms-now-fips-140-2-level-3-what-does-this-mean-for-you/)）。
  - IAM のポリシーで操作を役割ごとに分けられ、すべての利用が CloudTrail に残る。
  - 2 の AWS Payment Cryptography は、PIN、CVV の生成・検証、TR-31/TR-34 による鍵の交換など、決済の暗号の処理のための管理サービスで、PCI PIN・P2PE・PCI DSS の規則に合わせて設計されている（[What is AWS Payment Cryptography?](https://docs.aws.amazon.com/payment-cryptography/latest/userguide/what-is.html)）。汎用の暗号化もできるが、PAN の保管のために使う利点は KMS より小さい。**アクワイアラが TR-31 などの鍵の交換や PAN の暗号化を求めたときに、Connector Gateway で使う。**
  - 3 の CloudHSM は、クラスタの運用、鍵のバックアップ、可用性の設計を自分で持つことになり、小さなチームには重い。

## Consequences

- 良くなること：
  - 復号できるのが Connector Gateway だけになり、PAN の平文が現れる場所が 1 つになる。
  - 鍵の素材を人が扱う場面がなく、鍵の管理の手順（要件 3.6・3.7）が短くなる。
  - DR（大阪）でも、マルチリージョンキーで同じ暗号文を復号できる。
- 引き受けるコスト：
  - 復号のたびに KMS を呼ぶと遅延と費用が増えるので、DEK を 5 分キャッシュする。キャッシュの間は、キーポリシーでの失効が遅れて効く。
  - HMAC 鍵の入れ替えは全件の計算し直しになり、本体の指紋の更新も伴う。
  - 本体に指紋と BIN・下 4 桁を置く扱いは、QSA の確認が要る（未検証）。
  - DEK のキャッシュは、AWS Encryption SDK（JavaScript）の caching CMM で行う（2026-09-28 の注記）。

## Confirmation

- IAM のポリシーの静的検査：Vault Ingress のロールに `kms:Decrypt`、Connector Gateway のロールに `kms:GenerateDataKey` がないこと。
- 結合テスト：Vault Ingress の資格情報で PAN の暗号文の復号が失敗する。
- 結合テスト：オーソリの後に、CVC が ElastiCache に残っていない。TTL を過ぎた CVC が取り出せない。
- AWS Config：`cde-*` の鍵の自動ローテーションが有効で、削除の予約がない。
- 鍵のローテーションと `ReEncrypt` の手順を、ステージングで年 1 回実行する（runbook の `key-rotation`）。

> 2026-09-27 の注記：AWS Encryption SDK for JavaScript は、データキーのキャッシュ（caching CMM。Node.js では `NodeCachingMaterialsManager`）を持つ。Node.js では `plaintextLength` を渡さないとキャッシュされない。Node.js 版は 4.1 以降で Hierarchical keyring（ブランチキーを DynamoDB に置く）も使える（[データキーのキャッシュ](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/implement-caching.html)、[Hierarchical keyring](https://docs.aws.amazon.com/encryption-sdk/latest/developer-guide/use-hierarchical-keyring.html)。2026-09-27 に確認）。SDK の対応状況の「未検証」はこれで解消した。自前で書く必要はなく、実装の `plan.md` では caching CMM と Hierarchical keyring のどちらを使うかを決める。

> 2026-09-28 の注記：DEK のキャッシュは caching CMM（`NodeCachingMaterialsManager`）で行う。Hierarchical keyring は MVP では使わない。
> - 理由：caching CMM は、決定の「DEK を 5 分キャッシュする」をそのまま表せる。Hierarchical keyring は、ブランチキーを置く DynamoDB を CDE に足すことになり、PCI DSS の範囲の部品が増える。
> - 暗号化では `plaintextLength` を必ず渡す（渡さないとキャッシュされない）。キャッシュの上限は、時間 5 分に加えて、1 つの DEK で暗号化する件数でも区切る。値は E10 の負荷試験で KMS の呼び出しの数を見て決める。
> - KMS の上限に近づいたとき（[capacity.md](../architecture/capacity.md) の 2.4 節）は、Hierarchical keyring を新しい ADR で検討する。

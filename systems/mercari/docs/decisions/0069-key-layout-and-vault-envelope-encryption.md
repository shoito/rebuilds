---
status: accepted
date: 2026-10-10
---

# ADR-0069: KMS の鍵を用途ごとに分ける。住所の金庫と口座は、利用者ごとのデータの鍵（AES-256-GCM）を用途の KMS の鍵で包み、行ごとに追加の認証データを付ける。暗号化の文脈に用途と利用者を入れ、復号の権限は持ち主のサービスの役割だけに置き、人の役割に置かない。消去は利用者の鍵の破棄で行う。金庫の鍵は複数のリージョンの鍵にする

## Context

- 住所・氏名・電話番号は `shipping` の金庫に封筒の暗号化で置き、復号は `shipping` の役割だけとした（[ADR-0006](0006-shipping-orchestration-via-carriers.md)）。鍵の粒度、交換、消去の方法、大阪での扱いは決めていない。
- 口座の番号、本人の連絡先（電話番号、メール、生年月日）、本人確認の結果も、同じく持ち主のサービスだけが平文を見るべきデータである。
- 退会では住所を確実に消したい。Aurora のバックアップに暗号文が残る（[ADR-0068](0068-account-deletion-and-minors.md)）。
- 内部の者の覗き（[security.md](../architecture/security.md) の 3.7 節）を、権限の設計で止めたい。
- リージョンの障害で大阪へ移っても、配送の受け付け（住所の復号）と振込（口座の復号）を続ける（NFR-011）。
- KMS の要求の料金は 1 万件あたり 0.03 USD（AWS Price List、2026-10-10 に確認。[Gmail の capacity.md](../../../gmail/docs/architecture/capacity.md) の出典と同じ値）。行ごとに KMS を呼ぶと、S3 で 1 日数百万件の配送の受け付けで数が増える。

## Options

1. **用途ごとの KMS の鍵 → 利用者ごとのデータの鍵 → 行の暗号。暗号化の文脈と役割で復号を絞る**
2. 行ごとに KMS で直接暗号化する（4 KB 以下の平文）
3. 用途ごとの 1 つのデータの鍵で全利用者の行を暗号化する
4. 利用者ごとに KMS の鍵を作る

## Decision

1 を採用する。詳細は [security.md](../architecture/security.md) の 5 節。

- KMS の鍵：`kms-core`・`kms-ledger`・`kms-content`（保存時の暗号化）、`kms-vault-address`（`shipping`）、`kms-vault-bank`（`payouts`）、`kms-identity-pii`（`identity`）、`kms-kyc`（`identity` の本人確認の Worker）、`kms-audit`、`kms-lake`、`kms-secrets`、`kms-ops-exports`。
- 利用者の鍵：利用者ごと・金庫ごとに 256 ビット。`vault_keys` に包んだ形で置く。行は AES-256-GCM、nonce は行ごとの乱数、追加の認証データは（金庫、利用者、行、列の組のバージョン）。
- 鍵の政策：`kms:Decrypt` に `kms:EncryptionContext:purpose` と利用者の ID の文脈を求める。持ち主のサービスのタスクの役割にだけ付け、Identity Center の人の権限のセット（break-glass を含む）に付けない。plan のポリシー検査で拒む。
- 平文の利用者の鍵は、持ち主のサービスのタスクのメモリーに 5 分・1 万件だけ置く。ディスクと Valkey に置かない。本番のタスクに ECS Exec を許さない。
- 消去：包んだ鍵の行を消す。Aurora の自動のバックアップ（35 日）の後に、完全に読めなくなる。
- 大阪：`kms-vault-*`・`kms-identity-pii`・`kms-kyc` を複数のリージョンの鍵にし、大阪の持ち主のサービスの役割にだけ復号の権限を置く。
- 引くための値は HMAC（`phone_hmac`・`email_hmac`・`bank_account_hmac`）。HMAC の鍵は Secrets Manager。

### 他の案を選ばなかった理由

- **2（行ごとに KMS）**：配送の受け付け・運用の画面・振込のたびに KMS を呼び、遅れと料金が増える。消去は行を消すしかなく、バックアップの暗号文は KMS の鍵が生きている限り読める。
- **3（1 つのデータの鍵）**：1 人の退会で鍵を破棄できない。鍵の漏えいで全利用者が読める。
- **4（利用者ごとの KMS の鍵）**：数千万の KMS の鍵は、料金（鍵 1 つ月 1 USD）と上限で成り立たない。

> 2026-10-10 の注記：データモデルの工程で、T&S の証拠と審査の資料（`ts-docs`・`cases`）を包む KMS の鍵 `kms-ts` を足した（[data-model.md](../architecture/data-model.md) の 7 節）。鍵の階層と、人の役割に復号の権限を置かない規則は変えていない。

## Consequences

- 良くなること：
  - 1 つのサービスの侵害で読めるのは、その用途の、直近 5 分に扱った利用者の行に限られる。
  - 退会の消去が、鍵の行の削除 1 回で確かになる。
  - 人の役割は、どの経路でも金庫の平文を得られない。運用者が見るには、持ち主のサービスの「見せる」操作を通る（[ADR-0070](0070-operator-access-vault-reveal-and-audit.md)）。
- 引き受けるコスト：
  - 利用者の鍵の交換は全行の再暗号化になる。KMS の鍵の年の交換で包み直すだけにし、利用者の鍵は漏えいのときだけ替える。
  - バックアップからの復元で、破棄した鍵の行が戻りうる。復元の手順に、`destroyed_at` のある利用者の鍵を再び消す段を入れる。

## Confirmation

- 性質ベーステスト：写した暗号文は復号できない（PROP-SEC-001）。破棄した利用者の行はどの役割でも復号できない（PROP-SEC-002）。
- plan のポリシー検査：復号の権限が持ち主のサービスの役割にだけある。
- DR の訓練：大阪で配送の受け付けと振込の復号ができる。

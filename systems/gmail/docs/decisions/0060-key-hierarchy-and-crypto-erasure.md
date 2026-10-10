---
status: accepted
date: 2026-10-10
---

# ADR-0060: 鍵は 4 段にする：KMS の用途ごとの鍵 → テナントの根の鍵（TRK。KMS で包んで directory に置く。KMS の鍵をテナントごとには作らない）→ テナントの日ごとの KEK（TRK で包む）→ blob の鍵・索引の鍵（KEK で包む）。ADR-0030 の「KMS のテナントの鍵」は TRK を指す。平文の TRK と KEK は鍵を扱う部品の専用のタスクのメモリーにだけ置き、ダンプと覗きの経路を閉じる。テナントの消去は TRK の破棄で、保留・保全・`archived` のアカウントがある間は破棄しない。日ごとの KEK は、包んだ鍵が 0 になってから破棄する

詳細は [security.md](../architecture/security.md) の 5 節。

## Context

- [ADR-0030](0030-blob-format-v1-and-envelope-keys.md) は、blob の鍵をテナントの日ごとの KEK で包み、KEK を「KMS のテナントの鍵」で包むとした。平文の KEK を `mailstore` のメモリーに 1 時間置く守りは、この領域で決めるとした。
- S1 のテナントは 100 万（個人は 1 人 1 テナント。[ADR-0007](0007-tenancy-accounts-orgs-and-rls.md)）。KMS の鍵は 1 つ月 1 USD（ap-northeast-1、AWS Price List の `awskms`、2026-09-11 の公開分、2026-10-10 に確認）で、テナントごとに作ると月 100 万 USD になり、S1 の仮の予算（アカウントあたり月 0.15 USD）を超える。
- テナントの消去（解約）は、そのテナントの鍵の破棄で行う（[ADR-0003](0003-message-storage-layout-and-dedupe.md)）。保留の対象は、利用者の削除・解約の後も読めなければならない（[ADR-0053](0053-retention-rules-holds-and-preservation.md)）。
- 検索のセグメントは「アカウントの索引の鍵」で暗号化する（[ADR-0037](0037-segment-format-and-query-execution.md)）。directory の一部の列は C3（外のアドレス、表示の名前）を持つ。

## Options

1. **KMS の用途ごとの鍵の下に、テナントの根の鍵（TRK）を KMS で包んで置く**
2. KMS の鍵をテナントごとに作る
3. KMS の鍵の下に、日ごとの KEK を直接置く（テナントの根の鍵なし）

## Decision

1 を採用する。

- 段：KMS の `tenant-root` の鍵（用途・リージョンごと）→ TRK（テナントごと、`GenerateDataKey`、`tenant_keys`）→ 日ごとの KEK（テナント × 書き込みのあった日、TRK で AES-KW、`tenant_keks`）→ blob の鍵・アカウントの索引の鍵（KEK で AES-KW）。列の暗号化の鍵は TRK から HKDF で導く。
- KMS の `Decrypt` は TRK の解きだけで、テナントごとに 1 時間キャッシュする。`Decrypt` を許すのは `mailstore`・`search-indexer`・`search-node`・`ediscovery-exporter`・`accounts` のタスクのロールだけ。人のロールは鍵の方針で拒む。
- 鍵を扱うタスク：コアダンプの禁止、`mlock` と `zeroize`、ECS Exec の無効、EC2 の SSM のセッションの禁止、解析・描画の処理と同じプロセスにしない。
- 破棄：blob の鍵は参照 0 から 1 時間（[ADR-0031](0031-blob-references-gc-and-quota.md)）。日ごとの KEK は包んだ鍵の数が 0 で、日が過ぎたとき。TRK はテナントの消去（解約の 30 日、個人のアカウントの消去の 7 日の後）で、`holds`・`preserved_messages`・`archived` のアカウントがあれば `erasure_blocked` にして止める。
- 漏えいの疑い：テナントの TRK を新しくし、KEK を包み直す（blob を書き直さない）。
- BYOK は MVP の後。その組織の TRK を組織の KMS の鍵で包む形で足す。

### 他の案を選ばなかった理由

- **2**：鍵の費用がテナントの数に比例して予算を超える。KMS の鍵の数の上限の引き上げも要る。
- **3**：テナントの消去で、そのテナントの日ごとの KEK をすべて探して消すことになる。バックアップの中の KEK を一度に読めなくできない。列の暗号化の鍵の置き場所がない。

## Consequences

- 良くなること：
  - KMS の費用と呼び出しがテナントの数・配送の数に比例しない。
  - テナントの消去が 1 つの行の破棄で済み、バックアップの中も読めなくなる。
  - 保留と消去の衝突を、破棄の前の 1 か所の確かめで止められる。
- 引き受けるコスト：
  - 平文の TRK が鍵を扱う部品のメモリーに 1 時間ある。KMS だけで守る形より、部品の侵害の影響が大きい。
  - `tenant_keys` を失うと全テナントが読めない。Aurora の耐久性とバックアップ、大阪への写しに頼る。
  - ADR-0030 の文の読み替え（「KMS のテナントの鍵」＝ TRK）を、読む人が知る必要がある。

## Confirmation

- 性質ベーステスト：PROP-SEC-001（保留のあるテナントの TRK を破棄しない）、PROP-SEC-002（KEK の破棄の条件）。
- IAM の静的な検査：PROP-SEC-004（人のロールに `tenant-root` の `Decrypt` がない）。
- 設定の検査：鍵を扱うタスクの `enableExecuteCommand=false` とコアダンプの禁止。
- 監視：KMS の呼び出しの数（テナントの数に比例し、配送の数に比例しないこと）。

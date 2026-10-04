---
status: accepted
date: 2026-10-04
---

# ADR-0051: KMS の鍵をデータの種類ごとに分け、電話番号・メールアドレス・生年月日・IP アドレスはアプリの層でも封筒の暗号化をし、検索は鍵付きの HMAC の列で行う

## Context

- 本システムは、電話番号・メールアドレス（登録と OTP）、生年月日（年齢。法務の L5）、ログインと投稿の時の IP アドレス（発信者情報の開示。法務の L2）を持つ。どれも漏れたときの影響が大きい。
- DB の保存の暗号化（KMS）は、DB のスナップショットや、DB に届く権限を持つ者からは守らない。
- 運用者・T&S の読み出しは理由を必須にして監査する（[ADR-0004](0004-single-tenant-and-visibility.md)、[ADR-0052](0052-audit-and-operator-access.md)）。
- DM の中身の保存の暗号化は MVP で KMS による（[architecture/README.md](../architecture/README.md) の 6 節の決定）。形は direct-messages の領域で決める。

## Options

1. **鍵をデータの種類ごとに分け、個人の連絡先・生年月日・IP はアプリの層の封筒の暗号化と、検索用の HMAC の列を持つ**
2. DB と S3 の保存の暗号化だけ（1 つの鍵）
3. 個人データを別の保管の仕組み（トークン化のサービス）に出す

## Decision

1 を採用する。詳細は [security.md](../architecture/security.md) の 5 節。

- 鍵（マルチリージョンの鍵、大阪に複製）：`aurora`、`pii`、`pii-logs`、`dm-content`、`media`、`lake`、`audit`、`secrets`、`stream`、`cache`、`ts-evidence`（通報の証拠の写しと、メディアの隔離の置き場。T&S と法務のロールだけ）。鍵ごとに使えるロールを決め、Terraform のポリシー検査で強制する。
- 項目の暗号化：AES-256-GCM。データキーは KMS で作り、1 時間ごとに作り直してタスクのメモリーにだけ置く。暗号文と包んだデータキーを同じ列（`*_ct`）に持つ。
- 等しさの検索（重複の判定、ログイン）は、正規化した値の HMAC-SHA256 の列（`contact_hmac`）で行う。HMAC の鍵は `kid` で 2 つ並べて入れ替える。
- 投稿の時の IP は投稿の行に持たず、`post_origin_logs` に `pii-logs` の鍵で持つ。
- 鍵の削除の予約と無効化は、break-glass 以外に SCP で禁止する。
- 2 を採らない理由：DB に届く権限か、スナップショットだけで、連絡先と IP が読める。
- 3 を採らない理由：部品と運用が増える。S1 の量では、同じ DB の中の封筒の暗号化で足りる。

## Consequences

- 良くなること：
  - DB のスナップショットだけでは連絡先と IP を読めない。鍵の利用が CloudTrail に残る。
  - 鍵ごとに使えるロールを狭められる（`post` は IP を書けるが読めない）。
- 引き受けるコスト：
  - 部分の一致の検索（電話番号の前方の一致など）ができない。
  - KMS の要求の量（データキーのキャッシュで抑える。[capacity.md](../architecture/capacity.md) の 6 節）。
  - HMAC の鍵の入れ替えの書き直しのジョブ。

## Confirmation

- 結合テスト：封筒の暗号化の往復、HMAC での重複の判定、鍵の入れ替えの後の読み出し。
- Terraform のポリシー検査：`pii`・`pii-logs`・`dm-content` の `kms:Decrypt` を決めたロール以外に与えない。
- マイグレーションの検査：連絡先・生年月日・IP の平文の列を作らない。

## 注記

> 2026-10-04 の注記：統合の工程で、`ts-evidence` の鍵を足した。通報の証拠の写し（[trust-and-safety.md](../architecture/trust-and-safety.md) の 6.1 節、[direct-messages.md](../architecture/direct-messages.md) の 10 節）と、措置したメディアの隔離の置き場（[media.md](../architecture/media.md) の 8.4 節）が別の鍵を求めていたため。

---
status: accepted
date: 2026-10-10
---

# ADR-0030: blob の形式 v1 は、頭（形式のバージョン、blob の ID、元の大きさ、SHA-256、フレームの表）と 256 KiB ごとの zstd（水準 3、辞書なし）のフレームから成り、フレームごとに AES-256-GCM（nonce はフレームの番号、AAD は blob の ID・番号・形式のバージョン）で暗号化する。blob の鍵はテナントの KEK（日ごとに作り KMS で包む）で AES-KW により包んで目録に持つ。パックは暗号文をそのまま写す

詳細は [message-parsing-and-storage.md](../architecture/message-parsing-and-storage.md) の 7 節。

## Context

- [ADR-0003](0003-message-storage-layout-and-dedupe.md) は、zstd の 256 KiB のフレーム、フレームの索引、blob ごとのデータの鍵（テナントの鍵で包む）、1 日後のパックを決めた。バイトの並び、nonce の決め方、鍵の包み方、パックで鍵が要るかは決めていない。
- S1 で 1 日 6,000 万通を書く。blob ごとに KMS を呼ぶと、1 日 6,000 万回の呼び出しになり、費用と KMS の要求の上限に当たる。
- `blob-packer` がすべてのテナントの鍵を開けられると、1 つの部品の権限が全員の中身に及ぶ。
- 形式は一度書いたら、すべての将来のバージョンで読める必要がある（試験のベクトルで固定する）。

## Options

鍵：

1. **テナントの KEK を日ごとに作って KMS で包み、blob の鍵は KEK で手元で包む**
2. blob ごとに KMS の `GenerateDataKey` を呼ぶ
3. テナントの鍵で直接フレームを暗号化する（blob ごとの鍵を持たない）

パック：

- a. **暗号文をそのまま写す（鍵を持たない）**
- b. 復号して、より高い水準で圧縮し直してから暗号化する

## Decision

1 と a を採用する。

- 形式 v1：`magic "MBLB"`、`format_version = 1`、`blob_id`、`orig_len`、`orig_sha256`、`frame_size = 262144`、`frame_count`、フレームの表（暗号文の長さ、圧縮の有無）、頭のタグ。フレームは `AES-256-GCM(blob_key, nonce = 0^8 || u32(i), aad = blob_id || u32(i) || version)`。
- 圧縮は zstd の水準 3、辞書なし。0.9 倍より縮まないフレームは生のまま。
- テナントの KEK は日ごとに作り、KMS のテナントの鍵（TRK。下の注記）で包んで directory に持つ。`mailstore` は平文の KEK を 1 時間メモリーに置く。blob の鍵は AES-KW（RFC 3394）で包み、`blob_wrapped_keys` にテナントごとに持つ。
- `blob-packer` は暗号文を写し、目録の場所を書き換えるだけで、鍵に触れない。

> 2026-10-10 の注記：この ADR の「KMS のテナントの鍵」は、[ADR-0060](0060-key-hierarchy-and-crypto-erasure.md) の 4 段の鍵の TRK（テナントの根の鍵）を指す。KMS の鍵はテナントごとに作らない（100 万のテナントで月 100 万 USD になるため）。段は、KMS の用途ごとの鍵 → TRK（KMS で包んで `tenant_keys`）→ 日ごとの KEK（TRK で AES-KW、`tenant_keks`）→ blob の鍵（KEK で AES-KW）。平文の TRK・KEK のメモリーの守りは ADR-0060 と [security.md](../architecture/security.md) の 5 節にある。

### 他の案を選ばなかった理由

- **2**：KMS の呼び出しが受け付けの数に比例し、費用と上限と遅れが配送の道に入る。
- **3**：鍵の破棄が blob の単位でできず、[ADR-0003](0003-message-storage-layout-and-dedupe.md) の消去を満たせない。
- **b**：パックの部品が全テナントの鍵を開ける権限を持つ。CPU の費用も増える。

## Consequences

- 良くなること：
  - KMS の呼び出しがテナントと日の数で済む。
  - 範囲の読み出し（IMAP の部分、添付）で、要るフレームだけを読める。
  - パックの部品は中身を読めない。
- 引き受けるコスト：
  - 平文の KEK が `mailstore` のメモリーに 1 時間ある。メモリーの読み出しへの守り（ダンプの禁止、専用のタスク）を security.md で決める。
  - パックで圧縮の水準を上げる余地を捨てる。
  - 包んだ鍵が Aurora のバックアップに残る間は、暗号での消去が完全でない（法務の L6）。

## Confirmation

- 試験のベクトル：形式 v1 の blob とパックを固定し、以後のすべてのバージョンで読めて同じバイトになる。頭やフレームを 1 ビット変えたら読み出しが失敗する。
- lint：`blob-packer` の依存に鍵を開く関数を入れない。IAM で `blob-packer` に KMS の権限を与えない。
- 計測：`blob-pack-poc` で、水準 3 の CPU と圧縮の比、フレームの範囲の読み出しの遅れを測る。

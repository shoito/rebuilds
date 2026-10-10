---
status: accepted
date: 2026-10-10
---

# ADR-0019: レンディションの fMP4 は `init` とセグメントを連ねた 1 つのファイルにし、索引 `SIX1`（32 バイトの頭と 1 セグメント 16 バイト）を別に置く。URL は `/v/{video_id}/{gen}/{rendition}/{seq}.m4s` で中身を変えず、作り直しは世代を上げる

## Context

- [ADR-0004](0004-cmaf-packaging-and-drm-scope.md) は、レンディションごとに 1 つのファイルとセグメントの索引を置き、CDN にはセグメントの URL で見せ、`origin-cache` が範囲の読み出しに直すと決めた。`fast_encode` の段は全段で置き換え、古いファイルは 24 時間の後に消す。索引の形と URL の形は決めていない。
- `origin-cache` は、外れのたびに索引を引く。索引は小さく、固定の幅で、二分探索なしに引けるのがよい。
- CDN はセグメントを 1 年キャッシュする（[ADR-0005](0005-cdn-and-origin-strategy.md)）。同じ URL の中身が変わると、古い中身が配られ続ける。
- 段の追加（全段、AV1）で、配っている URL を変えたくない（ADR-0004）。

## Options

索引：

1. **自前の固定の幅のバイナリ（`SIX1`）**
2. fMP4 の `sidx` の箱をファイルの中に置く
3. JSON

作り直し：

- a. **世代（`gen`）を URL に入れ、作り直しで上げる**
- b. 同じ URL のまま上書きし、CDN を無効にする

## Decision

1 と a を採用する。詳細は [packaging-and-drm.md](../architecture/packaging-and-drm.md) の 4 節。

- 1 セグメント 1 フラグメント（`styp`・`moof`・`mdat`）。`tfdt` は動画の先頭からの通しの時刻。映像の時間の尺は 90,000、音声は 48,000。
- 索引 `SIX1`：頭 32 バイト（magic、version、flags、timescale、seg_count、init_size、total_size）、項目 16 バイト（offset 48 ビット、size、duration、flags）。12 時間の動画で約 173 KB。
- URL：`/v/{video_id}/{gen}/{rendition}/init.mp4`・`{seq}.m4s`。`rendition` は段の中身から決まる名前（`h1080-c24`、暗号化は `-cbcs`）。前に署名の `/t/{token}` が付く（[ADR-0025](0025-edge-token-signing-and-cache-keys.md)）。
- 世代：`fast_package` は 1、全段は 2。AV1 は同じ世代にレンディションを足す。新しい `ladder_version` の作り直しは世代を上げる。古い世代は 24 時間の後に消す。
- 書き手はファイルを置いてから索引を置く。索引がファイルより先に見えることはない。

### 他の案を選ばなかった理由

- **2（`sidx`）**：索引を読むのに、ファイルの先頭の範囲の読み出しが要る。12 時間の動画では `sidx` が大きく、オリジンの外れのたびの読み出しが増える。ライブの追記とも合わない。
- **3（JSON）**：大きく、解析の費用がかかる。
- **b（上書き）**：CDN と端末のキャッシュに古い中身が残る。無効化の完了の時間は保証されない（X の題材の調べ：[X の media.md](../../../x/docs/architecture/media.md) の 2 節）。

## Consequences

- 良くなること：
  - `origin-cache` は索引を 1 回の計算で引け、外れは S3 の範囲の GET 1 回になる。
  - URL の中身が変わらないので、CDN を長くキャッシュできる。
- 引き受けるコスト：
  - 世代の切り替えのたびに、マニフェストのキャッシュを無効にする。
  - 古い世代の 24 時間の保存。

## Confirmation

- 性質ベーステスト：PROP-PKG-001（索引の範囲が完全なフラグメントで、時刻が続く）、PROP-PKG-004（URL の中身が変わらない）。
- 試験のベクトル：`SIX1` の頭と項目の黄金のバイト。

---
status: accepted
date: 2026-10-10
---

# ADR-0054: 禁止のハッシュの一覧は、審査員が措置で確かめた写真の pHash と dHash を、範囲と `block` の可否つきで登録する。同期の検査は一覧をメモリーに持ち、8 ビットずつ 8 つの帯の索引で距離 7 以下を必ず引く。両方の距離 0 かつ `block` 可の登録だけが `block`、pHash の距離 1〜6 は `hold` の信号にする

詳細は [trust-and-safety.md](../architecture/trust-and-safety.md) の 5.3 節。

## Context

- 同期の検査は「禁止のハッシュ（措置した写真の知覚ハッシュ）」との一致を見る（[ADR-0009](0009-trust-and-safety-pipeline-boundary.md)）。規則だけで `block` してよいのは完全な一致まで。
- 写真は pHash と dHash の 64 ビットを持つ（[ADR-0012](0012-photo-pipeline-and-perceptual-hashes.md)）。再圧縮で数ビット変わる。
- 同期の検査は p95 2 秒。一覧は S1 で 100 万件までを見込む。
- 誤った登録（売り手の部屋の写真など）は、無関係の出品を止める。

## Options

1. **審査員が選んで登録。メモリーの 8 つの帯の索引。両方の距離 0 で `block`、近いは信号**
2. 措置した出品の写真を全部自動で登録する
3. 一覧を OpenSearch に置き、同期の検査で引く

## Decision

1 を採用する。

- `ts_photo_blocklist`：`phash`、`dhash`、`scope`（`global`・`brand:{id}`）、`block_allowed`、`source_action_id`、`state`。登録は措置（`photo_blocklist_add`）として審査員が行い、`block_allowed` は写真そのものが証拠になる場合だけ選ぶ。
- 引き方：pHash を 8 つの 8 ビットの帯に分けた索引をメモリーに持つ。鳩の巣で距離 7 以下を必ず引き、pHash と dHash の距離を数える。1 枚 0.3ms 前後の見込み。
- 結果：両方の距離 0 かつ `block_allowed` かつ範囲に当たれば `block`（完全な一致）。pHash の距離 1〜6 は `photo_blocklist_near` の信号（規則で `hold`）。
- 更新は事象で全タスクに配り、1 分ごとにバージョンを確かめる。異議が認められた措置のもとの登録は取り消す。
- 100 万件を超えたら帯を 16 に分け直す。

### 他の案を選ばなかった理由

- **2（全部を自動）**：背景・部屋・よくある構図の写真が入り、正しい出品を止める。
- **3（OpenSearch）**：同期の検査に外部の呼び出しが増え、検索の障害で出品が止まる。100 万件はメモリーに収まる。

## Consequences

- 良くなること：同じ写真の再出品を公開の前に止められる。近い写真も審査に回せる。
- 引き受けるコスト：審査員の登録の手間。両方の距離 0 でも別の写真である確率は 0 でない（生成した写真の集まりで測る）。

## Confirmation

- PROP-TS-007（距離 6 以下を必ず引く。全件の比べとの一致）、PROP-TS-002（`block` は完全な一致だけ）。
- `counterfeit-classifier-poc` の歪みの集まりで、距離の閾値と誤一致の率を測る。

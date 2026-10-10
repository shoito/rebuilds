---
status: accepted
date: 2026-10-10
---

# ADR-0025: エッジのトークンをパスの頭（`/t/{kid}.{exp}.{caps}.{rg}.{sig}/`）に置き、エッジの関数が確かめてから取り除いてキャッシュの鍵にする。HMAC の鍵は KeyValueStore に 2 つ並べて置き、セグメントは 1 年、VOD のマニフェストは 1 時間キャッシュする

## Context

- [ADR-0005](0005-cdn-and-origin-strategy.md) は、セグメントとマニフェストを短い期限（6 時間、ライブは配信の間）の署名つきの URL か cookie で配り、公開の動画はエッジで署名を確かめてオリジンへ通さず、鍵を 2 つ並べて回すと決めた。
- マニフェストは能力の組ごとに CDN で共有する（[ADR-0020](0020-manifest-generation-and-capability-classes.md)）。マニフェストの本文に視聴者ごとの値を入れられない。
- HLS・DASH のセグメントの URI を相対のパスにすると、問い合わせの文字列の署名はセグメントに引き継がれない。cookie は、ネイティブのプレイヤーやテレビで扱いが揃わず、配信のドメインをまたぐと送られない。
- CloudFront の既定の署名つきの URL は、公開鍵の署名と問い合わせの文字列の形で、上の相対のパスの問題がある。
- KeyValueStore は関数あたり 1 つ、5 MB まで（[Quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、2026-10-10 に確認）。

## Options

1. **パスの頭にトークンを置き、エッジの関数で確かめて URI から取り除く（HMAC、鍵は KeyValueStore）**
2. 問い合わせの文字列のトークンを、マニフェストの各 URI に書き込む
3. 署名つきの cookie
4. CloudFront の既定の署名つきの URL

## Decision

1 を採用する。詳細は [cdn-and-delivery.md](../architecture/cdn-and-delivery.md) の 5 節。

- 形：`/t/{kid}.{exp}.{caps}.{rg}.{sig}/`。`sig` は `HMAC-SHA256(key[kid], video_id | caps | rg | exp)` の先頭 128 ビットの base64url。`video_id` はパスから取る。
- エッジの関数：期限、署名、拒否の鍵 `b:{video_id}`、地域、`/m/` のパスの `caps` の一致を確かめ、`/t/...` を取り除いた URI をキャッシュの鍵にする。問い合わせの文字列は、ライブの `_HLS_msn`・`_HLS_part` のほかは鍵に入れない。
- 鍵：`k:{kid}` を KeyValueStore に今と次の 2 つ置き、30 日ごとに回す。拒否の鍵（[ADR-0027](0027-takedown-deny-list-within-60s.md)）と同じ置き場を使う。
- 期限：VOD のセグメントと `init` はエッジ 1 年、VOD のマニフェストは 1 時間、ライブのプレイリストは部分の長さ、エッジの関数の 403 はキャッシュしない。
- `origin-cache` は応答に cache tag `v:{video_id}` を付け、措置と世代の切り替えで無効にする。

### 他の案を選ばなかった理由

- **2（問い合わせの文字列を書き込む）**：マニフェストが視聴者ごとになり、CDN で共有できない。
- **3（cookie）**：ネイティブのプレイヤーとテレビで扱いが揃わない。
- **4（既定の署名つきの URL）**：問い合わせの文字列の形で、相対のパスのセグメントに引き継がれない。

## Consequences

- 良くなること：
  - マニフェストとセグメントを全視聴者で共有したまま、エッジでトークンを確かめられる。
  - 鍵と拒否の一覧を、関数のデプロイなしに更新できる。
- 引き受けるコスト：
  - すべての視聴者の要求でエッジの関数が動く（費用は [cdn-and-delivery.md](../architecture/cdn-and-delivery.md) の 9 節）。
  - HMAC の秘密の鍵がエッジにある。漏れたら鍵を外して出し直す。
  - トークンは視聴者を識別しない。視聴者ごとの制御は再生のトークン（[ADR-0023](0023-playback-token-and-qoe-metrics.md)）と `playable()` で行う。

## Confirmation

- 性質ベーステスト：PROP-CDN-001（正しいトークンだけを通す）、PROP-CDN-002（キャッシュの鍵からトークンが消える）。
- 結合テスト：ステージングのディストリビューションで、相対のパスのセグメントにトークンが引き継がれ、2 人の視聴者の同じセグメントがエッジで 1 回だけオリジンに来る。

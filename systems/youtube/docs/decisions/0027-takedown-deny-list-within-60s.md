---
status: accepted
date: 2026-10-10
---

# ADR-0027: 措置は outbox から `delivery-blocker` が、KeyValueStore の拒否の鍵、`playable()` の写し、`origin-cache` の拒否の集まり、cache tag の無効化の 4 つを並べて効かせる。拒否の鍵は 7 日で外し、決定から新しい配信の 403 まで p99 30 秒、上限 60 秒にする

## Context

- [ADR-0005](0005-cdn-and-origin-strategy.md) は、措置・削除・ブロックの決定の記録の後に outbox で `delivery_block` を出し、エッジの関数と KeyValueStore の拒否の一覧で 403 を返し、CDN の無効化と `playable()` での停止を同時に行い、決定から 60 秒以内に止めると決めた（NFR-014）。
- セグメントはエッジに 1 年キャッシュされる（[ADR-0025](0025-edge-token-signing-and-cache-keys.md)）。トークンを持つ視聴者は、措置の後もキャッシュのセグメントを取れる。
- CloudFront の無効化は、完了までの時間が文書に書かれていない（**未検証**）。KeyValueStore の更新が全エッジに伝わる時間も、公式の文書に数値がない（AWS のブログは数秒と書く。**未検証**）。
- KeyValueStore は 5 MB で、HMAC の鍵と同じ置き場を使う（関数あたり 1 つ）。拒否の鍵を永く置き続けると溢れる。
- 異議で措置を取り消したら、すぐに戻したい（copyright-claims-and-disputes の領域）。

## Options

1. **4 つの経路（拒否の鍵、`playable()` の写し、`origin-cache`、cache tag の無効化）を並べ、拒否の鍵は期限つきにする**
2. 無効化だけに頼る
3. 拒否の鍵を永く置き、他の経路を持たない

## Decision

1 を採用する。詳細は [cdn-and-delivery.md](../architecture/cdn-and-delivery.md) の 10 節。

- 措置の記録と outbox の `delivery_block` を同じトランザクションで書く。outbox の行がない措置は、配信を止めない。
- `delivery-blocker`（管理の面）が並べて行う：KeyValueStore に `b:{video_id}` を置く、`playable()` の写しを `blocked` にする、SNS で `origin-cache` の拒否の集まりに足す、`#v:{video_id}` の無効化を出す。各段の時刻を `delivery_blocks` に書く。
- KeyValueStore の更新が失敗したら、10 秒ごとに 5 回やり直し、60 秒を超えたら Ops を呼んでパスの無効化を足す。
- `b:` は 7 日で外す。それまでにエッジのトークン（最長 6 時間）は切れ、`playable()` は新しいトークンを出さず、`origin-cache` は拒否を続ける。置き場の 80% に達したら寿命を 24 時間に縮める。
- エッジの関数の 403 はキャッシュしない。取り消しでは `b:`・写し・`origin-cache` の拒否を外すだけで、すぐに戻る。
- 目標：決定から新しい配信の 403 まで p99 30 秒、上限 60 秒。見張りの措置で毎日測る。

### 他の案を選ばなかった理由

- **2（無効化だけ）**：完了の時間が保証されない。無効化の後もトークンを持つ視聴者がオリジンから取り直せる。
- **3（永く置く）**：5 MB の置き場が溢れる。`origin-cache` と `playable()` の拒否がないと、7 日の後に外せない。

## Consequences

- 良くなること：
  - 無効化の完了の時間に頼らず、60 秒を守れる。
  - 取り消しがすぐに効く。
- 引き受けるコスト：
  - 4 つの経路の進みを記録し、見張る。
  - 置き場の容量で、1 日の措置の数に上限がある（約 5,000 件/日で寿命を縮める）。

## Confirmation

- 性質ベーステスト：PROP-CDN-003（未解除の措置は、拒否の鍵か、`origin-cache` と `playable()` の拒否の両方にある）。
- 合成監視：見張りの動画に毎日措置をかけ、エッジの 403 までの時間を測る（[quality.md](../quality.md) の 2.2.1 節 I）。
- `delivery-block-list` で、KeyValueStore の伝わる速さと無効化の完了の時間を測り、この ADR の値を見直す。

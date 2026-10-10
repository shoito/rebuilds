---
status: accepted
date: 2026-10-10
---

# ADR-0030: LL-HLS は `PART-TARGET` 0.5（端数のあるフレームレートは 0.501）、`PART-HOLD-BACK` 1.5、`HOLD-BACK` 6、`CAN-SKIP-UNTIL` 12 にする。プレイリストと部分は `live-origin` がメモリーの直近 60 秒から返し、要求の保留は最大 6 秒、配信ごとに 2 つの AZ に写しを持つ

## Context

- [ADR-0006](0006-live-ingest-and-latency.md) は、低遅延を LL-HLS（部分 0.5 秒、セグメント 2 秒、要求の保留のリロード、プリロードのヒント）で p95 6 秒にし、DASH は低遅延の CMAF にすると決めた。値は `ll-hls-poc` で確かめる。
- 草案（draft-pantos-hls-rfc8216bis-22、2026-10-10 に確認）は、`PART-HOLD-BACK` を `PART-TARGET` の 2 倍以上（3 倍以上が望ましい）、`HOLD-BACK` を Target Duration の 3 倍以上、`CAN-SKIP-UNTIL` を 6 倍以上とし、部分の長さを `PART-TARGET` 以下・85% 以上とする。要求の保留は 3 Target Duration を超えて返せなければ 503。
- 29.97 fps では 15 フレームが 0.5005 秒で、0.5 を超える。
- 要求の保留は、部分ができるまで要求を持ち続ける部品が要る。S3 にはできない。
- 12 時間の DVR のプレイリストは約 21,600 セグメントで、毎回全部を送ると重い。

## Options

1. **自前の `live-origin`（メモリーの直近 60 秒、2 つの AZ の写し）。値は草案の推奨の下限に合わせる**
2. S3 とマニフェストの生成で保留なしに返す（プレイヤーは短い間隔で取り直す）
3. マネージドのライブのパッケージのサービス

## Decision

1 を採用する。詳細は [live-streaming.md](../architecture/live-streaming.md) の 6.3〜6.7 節。

- `EXT-X-TARGETDURATION:2`、`PART-TARGET` 0.5（端数のあるフレームレートは 0.501）、`PART-HOLD-BACK` 1.5（3 倍）、`HOLD-BACK` 6、`CAN-BLOCK-RELOAD=YES`、`CAN-SKIP-UNTIL=12`、次の部分の `EXT-X-PRELOAD-HINT`。部分は端から 3 セグメント残す。
- `live-origin`（Rust）は配信ごとに直近 60 秒の部分・セグメント・プレイリストをメモリーに持ち、変換器が主と写しの 2 つのノード（別の AZ）へ送る。
- 要求の保留は最大 6 秒で、超えたら 503。2 つ先より先の要求は 400。60 秒より古いセグメントは DVR の S3 から `origin-cache` 経由で返す。
- CDN のキャッシュの鍵に `_HLS_msn`・`_HLS_part` を残し、同じ保留の要求をエッジと Origin Shield で合わせる。
- 遅延の予算は p50 約 3.2 秒・p95 約 5.8 秒（同 6.4 節）。
- 要求の量と費用（低遅延の視聴者 1 人で 6 件/秒、1 視聴時間の要求の費用が転送と同じくらい）は `ll-hls-poc` で測り、超えるなら部分を 1 秒にする ADR を起票する。

### 他の案を選ばなかった理由

- **2（保留なし）**：プレイヤーの取り直しの間隔だけ遅れ、要求も増える。p95 6 秒に届かない。
- **3（マネージドのサービス）**：ライブのパッケージは題材の核の範囲（ADR-0001 の MediaPackage を使わない方針）で、遅延の予算を自分で制御できない。

## Consequences

- 良くなること：
  - 部分ができた瞬間に保留の要求へ返せ、遅延の予算を本システムの側で 1.4 秒に抑える。
  - オリジンへの要求が視聴者の数によらない（配信 × 段の数）。
- 引き受けるコスト：
  - 状態を持つ `live-origin` を運用する（AZ の写し）。
  - 低遅延のモードのエッジの要求の量と費用が大きい（ディストリビューションの上限の引き上げが要る）。

## Confirmation

- 性質ベーステスト：PROP-LIVE-003（保留の応答の規則）。
- 遅延の試験：時刻の焼き込みの見張りの配信で p50 4 秒・p95 6 秒（[quality.md](../quality.md) の 2.2.1 節 E）。
- `ll-hls-poc`：端末（AVPlayer、MSE、Media3）と CDN での保留の振る舞い、要求の数と費用、`EXT-X-VERSION` の値。

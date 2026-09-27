---
status: accepted
date: 2026-09-27
---

# ADR-0010: Media Node は vCPU−2 個の mediasoup の worker を持ち、worker ごとの WebRtcServer で固定のポートを共有し、会議を worker の間で pipeToRouter でつなぐ

## Context

[ADR-0001](0001-platform-and-stack.md) は、Media Node を EC2 の上の mediasoup v3 で作り、CPU のコアごとに worker を動かし、会議を `pipeToRouter` で広げると決めた。この領域では、1 台の中の配置を決める。

mediasoup の資料で確かめたこと（いずれも 2026-09-27 に確認）：

- worker は 1 つの CPU のコアで動く子プロセスで、worker の数はコアの数を超えないようにする。1 つの worker は 500 程度の consumer を扱う（[Scalability](https://mediasoup.org/documentation/v3/scalability/)）。
- `router.pipeToRouter()` は、別の worker の router へ producer をつなぐ。同じ worker の router どうしでは `keepId: true` のとき失敗する（[API](https://mediasoup.org/documentation/v3/mediasoup/api/)）。
- WebRtcServer は worker ごとに作り、1 つのポートを多数の WebRtcTransport で共有できる。使わなければ、transport ごとに worker のポートの範囲（既定 10000〜59999）から 1 つずつ開ける（同上）。

100 人の会議で 1 人が 25 本の映像を受けると、映像の consumer だけで 2,500 になり、1 つの worker に収まらない。

## Options

ポート：

1. **worker ごとに WebRtcServer を 1 つ置き、UDP・TCP の固定のポートで待つ**
2. **transport ごとにポートを開ける（mediasoup の既定）**

会議の置き方：

- a. **参加者ごとに「家の worker」を決め、送り手の producer を受け手の worker へ必要な分だけ pipe でつなぐ**
- b. **会議を 1 つの worker に収め、収まらなければ参加を断る**
- c. **送り手の worker と受け手の worker を分ける（送り手を 1 つの worker に集め、受け手の worker へ全部を pipe でつなぐ）**

## Decision

1 と a を採用する。詳細は [media-server-sfu.md](../architecture/media-server-sfu.md) の 3・4 節。

- 1 台に 1 つの Node Agent（Node.js、TypeScript）と、vCPU−2 個の worker を置く。worker は CPU のコアに固定する。残りの 2 は Node Agent とカーネルの網の処理に残す。
- worker ごとに WebRtcServer を 1 つ置き、UDP と TCP の 20000＋worker の番号で待つ。台の中のメディアのポートは 20000〜20255 に収まる。
- 会議は worker ごとに router を持つ。router の `mediaCodecs` は、全 Node で同じにする。
  - > 2026-09-27 の注記：100 人を超える会議では、音声の consumer を送り手ごとに作らず、受け手ごとに 3 つの音声の枠の consumer だけを持つ（[ADR-0057](0057-audio-slots-for-large-meetings.md)）。worker あたりの consumer の上限（400）の見積もりは、100 人以下の会議では変わらない。
- 参加者の send と recv の transport は、同じ「家の worker」に置く。家の worker は、会議が使う worker のうち consumer の少ないもの。上限（400 consumer）に近ければ worker を足す。
- 受け手の家の worker に送り手の producer がなければ `pipeToRouter` でつなぎ、受け手がいなくなって 30 秒で閉じる。
- Node Agent は、mediasoup の API を、自前の Media Node の制御の API（mTLS、`epoch` 付き）の内側だけで呼ぶ。
- 2 を採らない理由：参加者の数だけ UDP のポートを開けることになり、社内のファイアウォールで開けてもらう範囲が広すぎる（[network-traversal.md](../architecture/network-traversal.md) の 7 節）。
- b を採らない理由：100 人の会議（S1 の上限）が 1 つの worker に収まらない。
- c を採らない理由：送り手の worker に音声・映像の受信が集中する。受け手の worker へ、見られていない producer まで運ぶことになる。

## Consequences

- 良くなること：
  - 参加者が増えても、開けるポートの数が変わらない。顧客のファイアウォールの規則が短くなる。
  - 会議の大きさに合わせて、使う worker の数が増える。
- 引き受けるコスト：
  - 同じ WebRtcServer のポートを多数の参加者が使うので、そのポートへの UDP の洪水は、その worker の全参加者に効く。
  - pipe の分だけ、worker の間のコピーが増える。
  - worker の数（vCPU−2）と consumer の上限（400）は、負荷試験の前の仮の値である（**未検証**。E7 の `load-l0-l2` の L0 で決める）。

## Confirmation

- 負荷試験（E7）：100 人の会議を 1 台に置いたとき、転送の遅れが p99 10ms 以内で、ENA の `*_allowance_exceeded` が増えない。
- Terraform の検査：Media Node のセキュリティグループのメディアのポートの範囲が 20000〜20255 だけ。
- レビュー：Node Agent の外から mediasoup の API を呼んでいない。

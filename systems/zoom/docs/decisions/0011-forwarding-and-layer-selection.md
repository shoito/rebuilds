---
status: accepted
date: 2026-09-27
---

# ADR-0011: 何を誰に送るかは Meeting Actor が決め、帯域の中での層は Media Node が選ぶ。音声は受け手ごとに最大 3 本にし、キーフレームの要求はまとめる

## Context

[ADR-0002](0002-media-topology.md) は、受け手ごとに帯域と表示の大きさに合わせて層を選び、大きな会議では声の大きい数人の音声だけを転送すると決めた。[ADR-0005](0005-meeting-state-and-signaling.md) は、「誰の映像をどの層で誰に送るか」を Meeting Actor の状態に含めた。

- 帯域は 1 秒の中でも変わる。Actor を通して層を変えると、シグナリングの往復の分だけ遅れ、NFR-009（5 秒以内に層を落とす）の余裕が減る。
- mediasoup は、受け手の transport ごとに帯域を推定し、consumer の優先度（`setPriority`）と上限（`setPreferredLayers`）に従って層を配る（[mediasoup の設計](https://mediasoup.org/documentation/v3/mediasoup/design/)、[API](https://mediasoup.org/documentation/v3/mediasoup/api/)、2026-09-27 に確認）。
- mediasoup は 1 つの producer への PLI・FIR を 1 秒に 1 回に絞るが、多くの受け手の要求で送り手の送出が 2〜3 倍になりうる（[Scalability](https://mediasoup.org/documentation/v3/scalability/)、2026-09-27 に確認）。`keyFrameRequestDelay` で間隔を広げられる。
- mediasoup の consumer は 1 つの producer に結び付く。「上位 3 人の音声」を送るには、consumer を止めたり再開したりする必要があり、その間に話し始めが落ちる。

## Options

1. **Actor が購読・上限・優先度を決め、Media Node（mediasoup）が帯域の中で層を選ぶ**
2. **Actor が帯域の報告を受けて、層を 1 つずつ決める**
3. **Media Node がすべて決める（Actor は購読だけを渡す）**

音声：

- a. **受け手ごとに最大 3 本（上位＋主な話者＋直近 1.5 秒）。下りが 150 kbps 未満なら 2 本**
- b. **ミュートでない人が 10 人以下ならすべて送り、超えたら a と同じ**
- c. **常にすべて**

## Decision

1 と a を採用する。詳細は [media-server-sfu.md](../architecture/media-server-sfu.md) の 5〜7 節。

- Actor は、受け手ごとの購読の集合（見える 25 本まで）、空間・時間の層の上限（表示の大きさから）、優先度を決め、`subscriptions.apply` で Node に送る。上限と優先度の表は [ADR-0019](0019-bandwidth-estimation-and-layer-allocation.md) に従う。
- Media Node は、mediasoup の帯域の推定の中で、上限までの層を優先度の順に配る。Actor は帯域ごとの層の変化に関わらない。
- 誰も見ていない層（受ける consumer が 5 秒 0）は、Node が Actor に知らせ、Actor が送り手に `media.layers.hint` で符号化を止めさせる。
- 音声は a。切り替えには 1.5 秒の保持を入れる。下りが 150 kbps 未満の受け手の 2 本は、[ADR-0019](0019-bandwidth-estimation-and-layer-allocation.md) の音声の枠に合わせる。
  - > 2026-09-27 の注記：a の実装（受け手ごとに全員の音声の consumer を作り、上位 3 人以外を止める）は、音声の consumer が人数の 2 乗で増える（300 人で約 9 万、1,000 人で約 100 万）。100 人を超える会議では、同じ選び方の結果を、受け手ごとの 3 つの音声の枠へ話者を付け替える転送器で届ける（[ADR-0057](0057-audio-slots-for-large-meetings.md)）。100 人以下の会議（S1）は a のまま。
- キーフレームの要求は、`keyFrameRequestDelay` をカメラ 1,000ms、画面共有 2,000ms にしてまとめる。新しい参加者の consumer の再開は、話者と共有を先にし、残りを 100ms ずつずらす。
- 2 を採らない理由：層の変化のたびにシグナリングを往復し、Actor の負荷と遅れが増える。
- 3 を採らない理由：表示の大きさ・ピン留め・画面共有は、会議の状態（Actor）にある。Node が会議の状態を持つことになる（ADR-0005 の選択肢 3 と同じ問題）。
- b を採らない理由：受け手の下りに載る音声の本数が、会議の人数で変わり、下りの音声の枠（ADR-0019）を見積もれない。少人数の会議では a でもほぼ全員の声が届く。
- c を採らない理由：大きな会議で、雑音を出すミュートでない人が多いと、全員の下りと Node の負荷が増える。

## Consequences

- 良くなること：
  - 帯域の変化への追従は Node の中で閉じ、シグナリングの遅れの影響を受けない。
  - 誰も見ていない層を符号化しないので、送り手の上りと CPU が減る。
- 引き受けるコスト：
  - mediasoup の層の割り当ての振る舞い（音声を先に守るか、層の切り替えの速さ）に依存する。E4 で確かめる（**未検証**）。
  - 切り替えで、話し始めの 250〜500ms が落ちうる。4 人以上が同時に話すと、4 人目以降の声が届かない（**未検証**。聞いた人の評価で確かめる）。
  - キーフレームの間隔を広げると、新しい受け手の最初の映像が最大 1〜2 秒遅れる。

## Confirmation

- 回線の劣化の試験：3 人の会議で 1 人の下りを 500 kbps に絞ると、その人だけ低い層を受ける。下りが半分になったら 5 秒以内に層が下がり、1 秒以上の停止がない（NFR-009）。
- 性質ベーステスト：PROP-SFU-001（受け手ごとの映像の consumer は 25 以下で、共有を必ず含む）、PROP-SFU-002（層の上限を超えない）。
- 負荷試験：100 人の会議で 1 人が入ったとき、既存の送り手の送出の増え方が、キーフレームの分で 2 倍を超えない。

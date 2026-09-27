---
status: accepted
date: 2026-09-27
---

# ADR-0012: Media Assignment Service は資源の使用率の最大で点を付けて無作為の 2 台から選び、1 台に収まらない会議は PipeTransport で 1 ホップにつなぐ

## Context

[ADR-0005](0005-meeting-state-and-signaling.md) は、Media Assignment Service が Node の負荷と参加者の位置で会議の置き場所を選び、大きな会議は途中で Node を足すと決めた。[ADR-0002](0002-media-topology.md) は、Node の間の中継を 1 ホップだけにし、先の Node の受け手が要る層だけを送ると決めた。

- 1 台の上限は、CPU、送出の帯域、PPS、ENA の接続の追跡などのどれかで決まる。EC2 は PPS の上限を公表していない（[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、2026-09-27 に確認）。上限を超えた分は捨てられる。
- 負荷の報告には遅れがある。最も空いた 1 台を選ぶと、報告の間に同じ台へ会議が集まる（power of two choices の考え方。Mitzenmacher「The Power of Two Choices in Randomized Load Balancing」、2001）。
- mediasoup の `pipeToRouter` は同じ台の中の router をつなぐ。台の間は `createPipeTransport` を両側で作って `connect` する。pipe の consumer は、producer のすべての流れ（simulcast の全部の層）を運ぶ（[API](https://mediasoup.org/documentation/v3/mediasoup/api/)、2026-09-27 に確認）。

## Options

選び方：

1. **資源ごとの使用率の最大を点にし、閾値の下の Node から無作為の 2 台を選んで低い方**
2. **最も点の低い 1 台**
3. **会議の ID のハッシュで固定の Node**

台の間のつなぎ方：

- a. **送り手の Node から受け手の Node へ直接（必要な組だけ）**
- b. **主の Node を中心にした星形**
- c. **木（Node を多段に中継）**

## Decision

1 と a を採用する。詳細は [media-server-sfu.md](../architecture/media-server-sfu.md) の 8 節。

- Node は 1 秒ごとに負荷（worker ごとの CPU、consumer、送出の bps・pps、ENA の `*_allowance_exceeded` の増分）を報告する。
- 点は `max(cpu, egress_bps, pps, consumers)` のそれぞれの上限に対する割合。ENA の上限を直近 1 分に超えた Node は点を 1.0 にする。
- 点が 0.7 未満の Node から無作為に 2 台を選び、低い方に置く。予定の人数の分を仮に予約する。別の AZ の予備の Node を 1 台決めておく（[ADR-0013](0013-media-node-failover-and-reattach.md)）。
- S1 は 1 会議を 1 台に収める。
- S2 から、1 台に収まらない会議は別の Node に広げる。台の間は PipeTransport（SRTP と RTX を有効、VPC の中のプライベート IP）でつなぐ。送り手の Node から受け手の Node へ直接つなぎ、中継は 1 ホップだけにする。
- pipe は producer のすべての層を運ぶ。リージョンの中では受け入れる。「要る層だけ」は S3 のリージョンの間の設計で解く。
- 2 を採らない理由：報告の遅れの間に、同じ台に会議が集まる。
- 3 を採らない理由：Node の追加と障害で、会議の置き場所が大きく動く。負荷を見ない。
- b を採らない理由：従の Node の間が 2 ホップになり、ADR-0002 の「1 ホップだけ」に反する。
- c を採らない理由：段の分だけ遅れる。S3 の 1,000 人の会議でも、Node の数は数十に収まる見込みで、直接つなげる。

## Consequences

- 良くなること：
  - 負荷の報告の遅れがあっても、会議が特定の台に集まりにくい。
  - ENA の上限を超えた Node に新しい会議を置かない。
- 引き受けるコスト：
  - 台の間で使われない層まで運ぶ。リージョンの中の転送の量が増える（S2）。
  - 会議の Node の数が増えると、組の数は Node の数の 2 乗で増える。
  - 資源ごとの上限の値は、負荷試験で決めるまで仮の値である。

## Confirmation

- 負荷試験（E10）：2 つの Node にまたがる会議で、Node をまたぐ参加者どうしの遅れの増加が p95 30ms 以内（ADR-0002 の Confirmation）。
- シミュレーション：負荷の報告を 1 秒遅らせ、1 秒に 100 会議を作っても、Node の点の最大と平均の差が 0.2 以内に収まる。
- 結合テスト：ENA の上限を超えたと報告した Node に、新しい会議が置かれない。

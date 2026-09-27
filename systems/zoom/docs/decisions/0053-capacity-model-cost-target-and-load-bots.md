---
status: accepted
date: 2026-09-27
---

# ADR-0053: 容量は consumer と pps と送出の 3 つで見積もり、1 台の上限は負荷試験で決める。K8 は参加者・分あたり S1 で 0.20 円、S2 で 0.07 円を目標にする。負荷試験は Pion の軽いボットと少数の実ブラウザで行う

## Context

intent.md の K8 は「参加者・分あたりの配信の費用を、capacity.md で決める目標以内に保つ」とし、目標の値を決めていない。[architecture/README.md](../architecture/README.md) の 2 節は、帯域を参加者 1 人あたり下り 1.5 Mbps・上り 0.8 Mbps と置き、S1 のピークの送出を約 45 Gbps と見込んだ（起票の時点。後に容量の前提を 2.5 Mbps・75 Gbps に直した。下の注記）。

1 台の Media Node の上限は、公開の情報では決められない。

- mediasoup の 1 つの worker は、おおむね 500 を超える consumer を扱える（[Scalability](https://mediasoup.org/documentation/v3/scalability/)、2026-09-27 に確認）。設計は 400 を上限に置いた（[ADR-0010](0010-media-node-process-layout.md)）。
- EC2 はインスタンスの種類ごとの PPS の上限を公表していない（[ENA の性能の指標](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html)、2026-09-27 に確認）。

費用の大半はインターネットへの転送である。[capacity.md](../architecture/capacity.md) の 6 節の見積もりで、S1 を AWS の表の料金で動かすと、メディアの配信だけで参加者・分あたり約 0.18 円（1 USD = 150 円の仮定。制御の側を含めると約 0.19 円）になる。国内のコロケーションなら、約 3 分の 1 の見込み（**未検証**。E12 の `edge-evaluation` で確かめる）。

負荷試験に、実際のブラウザを数千から数万動かすのは重い。ブラウザは映像を符号化・復号するので、1 人あたり 1 vCPU 前後を使う（**未検証**。E7 の `loadbot-pion` で実ブラウザの見張りを動かして測る）。

## Options

1 台の上限：

1. **consumer、pps、送出の bps、CPU の 4 つの上限を負荷試験で求め、点の計算（[ADR-0012](0012-media-assignment-and-cascading.md)）に入れる。それまでは consumer（worker あたり 400）で見積もる**
2. 送出の bps だけで見積もる

K8：

- a. **メディアの配信の費用（インターネットへの転送、Media Node、TURN、DDoS の防御）÷ 参加者・分。S1 で 0.20 円、S2 で 0.07 円以下**
- b. 目標を置かず、費用を記録するだけ

負荷試験のボット：

- x. **Go の Pion で作る軽いボット（符号化済みの映像と音声を流し、受けたものは復号しない）を主にし、Playwright の実ブラウザを 2% 混ぜて品質を測る**
- y. すべて実ブラウザ
- z. mediasoup-client を Node.js で動かす（aiortc の handler）

## Decision

1、a、x を採用する。詳細は [capacity.md](../architecture/capacity.md)。

- **1 台の上限**：c8gn.16xlarge で、`consumer_limit` 24,800（62 worker × 400）、`cpu_limit` worker ごとに 70%、`egress_limit`・`pps_limit` は E7 で決める。E7 の前の仮の値は、`egress_limit` 20 Gbps、`pps_limit` は ENA の超過が出始めた値の 70%。
- **S1 の台数**：consumer で見積もり、ピークで 27 台（東京、AZ ごとに 9 台）。1 つの AZ を失っても残りでピークを受けられる数にする。
- **K8 の目標**（2026-09-27 に推奨案で確定）：
  - 定義：（インターネットへの転送 ＋ Media Node ＋ TURN ＋ TURN と Media Node の間の転送 ＋ DDoS の防御）の月の費用 ÷ 月の参加者・分。制御の側、録画、字幕は含めない（別に見る）。
  - S1：0.20 円以下。AWS の表の料金で、平均の下り 1.5 Mbps が保てれば届く。平均の下りが 2 Mbps を超えると届かない。
    - > 2026-09-27 の注記：容量（台数、送出、transit、クォータ）は、参加者 1 人の下り 2.5 Mbps を前提に見積もる。1.5 Mbps は期待の平均として残し、E2 のベータで測って置き換える（[architecture/README.md](../architecture/README.md) の 2 節）。2.5 Mbps のとき、AWS の表の料金の K8 は約 0.28 円で、S1 の目標に届かない（[capacity.md](../architecture/capacity.md) の 6 節）。目標の値は変えない。
    - > 2026-09-27 の注記：S1 の目標（0.20 円）を AWS のまま容量の前提（2.5 Mbps）で満たす道はない。満たすのは、下りの平均が 1.5 Mbps 前後に収まるか、Edge（[ADR-0050](0050-disaster-recovery-and-edge-migration.md)）か AWS との料金の合意で転送の単価が下がるときだけで、達成は Edge の判断（運用の体制の判断の点を含む）に掛かる。目標の値は残す。
    - > 2026-09-27 の注記：推奨案で確定した。S1 0.20 円、S2 0.07 円の目標を保つ。S1 を AWS の下り 2.5 Mbps で動かすと届かないことは受け入れる。閾値（4 週続けて 10 Gbps）で Edge の構築を始める道を採る（[ADR-0050](0050-disaster-recovery-and-edge-migration.md)）。
  - S2：0.07 円以下。AWS の表の料金では届かない。コロケーション（[ADR-0050](0050-disaster-recovery-and-edge-migration.md)）か、AWS との料金の合意が要る。
  - 毎月、実際の請求と送ったバイトの数から計算し、目標を 2 か月続けて超えたら、Ops が PM と Dev に報告する。
- **ボット**：
  - 送り手のボット：VP8 の simulcast 3 本（合成の映像を libvpx で符号化したもの）と、Opus（公開のデータセットの音声を符号化したもの、話す・黙るの型を持つ）を、RTP のまま流す。シグナリングは本システムのプロトコル（JSON Schema から型を作る）に従う。
  - 受け手のボット：復号しない。RTCP（RR、transport-cc、NACK、PLI）をブラウザと同じように返す（Pion の interceptor）。受けたパケットの数と遅れを数える。
  - 品質の見張り：会議の 2% に、Playwright の Chrome を入れ、`mos_est`・フリーズ・glass-to-glass を測る（[ADR-0054](0054-network-impairment-lab.md)）。
  - ボットは `media-lab` のアカウントの同じリージョンの EC2 で動かし、Media Node の公開の IP へ送る（インターネットゲートウェイを通る経路を試すため）。
- 2 を採らない理由：S1 の平均の会議（6 人）では、送出が 1 台 3〜4 Gbps のうちに consumer と CPU が上限に来る見込みで、帯域だけでは台数を過小に見積もる。
- b を採らない理由：費用の大半を決める判断（Edge へ移す時期）の基準がなくなる。
- y を採らない理由：3 万人の負荷に、数万 vCPU が要る。
- z を採らない理由：aiortc（Python）は 1 プロセスあたりの処理が重く、数千のボットに向かない見込み（比べては測っていない。採らない案なので確かめない）。

## Consequences

- 良くなること：
  - 1 台の上限と台数、費用の目標が、測れる数で結び付く。
  - 数万人の負荷を、数百 vCPU 程度のボットで作れる見込み（**未検証**。E7 の `loadbot-pion` で 1 台のボットの数を測る）。
- 引き受けるコスト：
  - 試験の道具に Go が加わる（本番のコードには加えない）。
  - ボットは符号器の振る舞い（GCC に合わせたビットレートの変化）を真似しない。帯域の追従の試験は、実ブラウザの回線の劣化の試験で行う。
  - K8 の S2 の目標は、今の AWS の表の料金では届かないと分かったうえで置く。

## Confirmation

- 負荷試験（E7）：c8gn.16xlarge で、会議の大きさの組（2、6、25、100 人）を増やし、ENA の `*_allowance_exceeded` が 0 のまま、転送の遅れの p99 が 10ms 以内、実ブラウザの `mos_est` が 4.0 以上に収まる最大の参加者の数を求め、4 つの上限の値を [capacity.md](../architecture/capacity.md) に書く。
- 負荷試験（E12、GA の前）：S1 のピーク（3 万人、5,000 会議）の 1.2 倍で 2 時間、SLO（[ADR-0052](0052-media-slis-and-mos-estimation.md)）を満たす。
- 毎月：K8 の実績を計算し、ダッシュボードに出す。

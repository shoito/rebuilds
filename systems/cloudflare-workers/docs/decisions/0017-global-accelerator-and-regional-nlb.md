---
status: accepted
date: 2026-09-27
---

# ADR-0017: 入口はデュアルスタックの Global Accelerator とリージョンごとの TCP の NLB にし、リージョンは健全性の検査で退かせる

詳細は [edge-network-and-routing.md](../architecture/edge-network-and-routing.md) の 5 節と 9 節。

## Context

[ADR-0003](0003-edge-locations.md) は、S1・S2 の入口を Global Accelerator の anycast の IP → 各リージョンの NLB → エッジのノードにし、TLS はノードで終端すると決めた。その具体（アクセラレーターの型と数、リスナー、NLB の設定、アフィニティ、リージョンの退かせ方）を決める。

Global Accelerator の事実（2026-09-27 に確認）：

- 標準のアクセラレーターは静的な anycast の IPv4 を 2 つ、デュアルスタックでは IPv6 も 2 つ持つ。TCP を AWS の edge で終端する。アイドルのタイムアウトは TCP 340 秒で、確立済みの接続はエンドポイントが不健全になってもタイムアウトまで元へ流れる（[How AWS Global Accelerator works](https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html)）。
- 不健全なグループの代わりに近い 3 つのグループまで探し、なければ最寄りのグループへ送る（fail open）。迂回ではダイヤル 0 のグループも候補になる（[How failover works](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoints-endpoint-weights.unhealthy-endpoints.html)）。
- トラフィックダイヤルは新しい接続にだけ効く（[Traffic dials](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoint-groups-traffic-dial.html)）。API は us-west-2 でだけ呼べる（[Quotas](https://docs.aws.amazon.com/global-accelerator/latest/dg/limits-global-accelerator.html)）。
- 利用者の IP を保つのは、セキュリティグループを持つ NLB の TCP・UDP のリスナーだけ。デュアルスタックのアクセラレーターには、IP を保つエンドポイントしか足せない。既存の IPv4 のアクセラレーターを NLB のままデュアルスタックへ上げられない。NLB のゾーンをまたぐ振り分けは切ることを勧める（[Endpoint requirements](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-endpoints-caveats.html)）。
- クライアントのアフィニティの既定は 5 つ組のハッシュ。Source IP は送信元の IP で同じグループへ送る（[Client affinity](https://docs.aws.amazon.com/global-accelerator/latest/dg/about-listeners-client-affinity.html)）。
- カスタムルーティングのアクセラレーターは IPv4 だけで、健全性の検査と迂回がない（How AWS Global Accelerator works）。
- 料金はアクセラレーター 1 つ 0.025 ドル／時と DT-Premium（[Pricing](https://aws.amazon.com/global-accelerator/pricing/)）。

## Options

1. **デュアルスタックの標準のアクセラレーター（本番＋予備）→ リージョンごとの TCP の NLB（IP を保つ）→ ノード。退かせる操作は健全性の検査で行う**
2. IPv4 だけの標準のアクセラレーターで始め、IPv6 は後で足す
3. カスタムルーティングのアクセラレーターで、要求をホームのノードへ直接送る
4. NLB の TLS のリスナーで TLS を終端し、ノードは平文の HTTP を受ける

## Decision

1 を採用する。

- アクセラレーターは `ga-primary` と `ga-standby` の 2 つ。どちらもデュアルスタックで、同じ NLB を向く。`edge.<brand>.<domain>` の A・AAAA を書き換えて予備へ移れるようにする。
- リスナーは TCP の 1 つ（ポート 80 と 443）。リスナーを 1 つにして、エンドポイントグループを最大 42 のリージョンに向けられるようにする。クライアントのアフィニティは None。
- エンドポイントはリージョンごとの NLB 1 つ。NLB はデュアルスタック、セキュリティグループあり、TCP のリスナー、ゾーンをまたがない、利用者の IP を保つ。
- **リージョンを退かせる主な手段は、健全性の検査。** 設定の写しの `region_flags/<r>.drain` で、そのリージョンの全ノードの `/healthz` を 503 にし、GA に迂回させる。GA の API（us-west-2）に依存しない。同時に退かせるのは 2 リージョンまで（fail open を避ける）。
- トラフィックダイヤルは、計画の作業（新しいリージョンの段階的な流し込み）にだけ使う。
- 健全性の検査は、ノードの局所の故障だけで落とす。制御プレーンや配信の停止では落とさない。
- HTTP/3 と BYOIP は S1 で使わない。BYOIP は S2 で、自前の IPv4 の範囲を 2 つ用意して両方の IPv4 を自前にする。
- 2 を採らない理由：IPv4 のアクセラレーターは、NLB のエンドポイントのままデュアルスタックへ上げられない。後で上げると IP が変わり、apex を A で向けた利用者に影響する。
- 3 を採らない理由：IPv4 だけで、健全性の検査と迂回がない。HTTP のホスト名で行き先を決められない（L4 の IP とポートの組で決まる）。ホームのノードへの寄せは、ノードの間の転送（ADR-0019）で行う。
- 4 を採らない理由：TLS のリスナーでは利用者の IP を保てず、証明書を ACM で数万枚持つことになる。SNI の先読み、`request.<brand>` の TLS の欄（ADR-0016）も作れない。

## Consequences

- 良くなること：
  - 最初から IPv6 を持ち、後から IP を変えずに済む。
  - リージョンを退かせる操作が、データプレーンだけで完結する。
  - アクセラレーター自体の障害に、DNS の 1 レコードで備えられる。
- 引き受けるコスト：
  - 予備のアクセラレーターの固定の料金（約 18 ドル／月）。
  - 健全性の検査での迂回は、NLB の検知（約 20 秒）と GA の反映の時間がかかり、ダイヤルより粗い。
  - apex を A・AAAA で向けた利用者は、予備への切り替えと S3 の IPv6 の変更に追従しない。
  - 利用者の IP の保持（とくに IPv6）は、この組み合わせで未検証。E4 の最初に確かめ、保たれなければこの ADR を改訂する。

## Confirmation

- 結合テスト（E4）：GA → NLB → ノードで、IPv4 と IPv6 の利用者の IP が `<Brand>-Connecting-IP` に入る。
- 障害の訓練（四半期）：`drain` で 1 リージョンを退かせ、新しい接続の迂回までの時間と失敗の割合を計測する。3 つ目の `drain` を中継が拒むことを確かめる。
- 障害の訓練（半期）：`edge` を予備へ切り替え、既定のドメインが応答することを確かめる。
- レビュー：`/healthz` の条件に、制御プレーン・配信・リージョンのサービスの状態を足す変更を拒む。

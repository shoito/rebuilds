---
status: accepted
date: 2026-09-27
---

# ADR-0003: S1・S2 は AWS のリージョンのエッジのノードを anycast の IP の後ろに置き、S3 で自前の PoP に移る

## Context

関数を利用者の近くで動かすには、利用者を近い拠点へ導き、拠点が落ちたら別の拠点へ迂回させる仕組みが要る。

本家は、100 か国以上の 348 都市の拠点で同じ IP を anycast で広告し、インターネットの利用者の 95% が 50ms 以内にいるとしている（[Cloudflare Global Network](https://www.cloudflare.com/network/)、2026-09-27 に確認）。拠点の中では、L4 の負荷分散（Unimog。XDP で 4 つ組をハッシュし、機械の負荷で振り分けを調整する）で機械に接続を配る（[Unimog](https://blog.cloudflare.com/unimog-cloudflares-edge-load-balancer/)、2026-09-27 に確認）。

この題材は、rebuilds の共通の基盤（AWS）の上で始める。自前の PoP には、IP の範囲、AS 番号、コロケーション、回線、機材の調達と運用が要り、MVP の規模に合わない。

AWS で使えるものは次のとおり（2026-09-27 に確認）。

- **リージョン**：39 のリージョン、124 の AZ。Local Zones と Wavelength Zones が合わせて 79（[AWS Global Infrastructure](https://aws.amazon.com/about-aws/global-infrastructure/)）。日本は東京と大阪。
- **Global Accelerator**：2 つの静的な anycast の IPv4（デュアルスタックで IPv6 も 2 つ）を AWS の edge から広告する。TCP を edge で終端し、AWS のバックボーンでリージョンの NLB・ALB・EC2 へ届ける。エンドポイントの健全性で新しい接続を迂回させ、トラフィックダイヤルと重みで割合を変えられる。自前の IP の範囲（BYOIP、IPv4 だけ）も使える（[How AWS Global Accelerator works](https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html)）。
- **CloudFront**：100 以上の都市の 750 以上の PoP と 15 のリージョンのキャッシュ（[CloudFront features](https://aws.amazon.com/cloudfront/features/)）。ただし、PoP で動かせるコードは CloudFront Functions（ES 5.1、コード 10KB、メモリ 2MB、ネットワークなし）だけで、Lambda@Edge（Node.js・Python）はリージョンのキャッシュで動く（[Choosing between CloudFront Functions and Lambda@Edge](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-choosing.html)）。どちらも自前のランタイムを動かせない。

## Options

1. **Global Accelerator の anycast の IP → 各リージョンの NLB → EC2 のエッジのノード。** TLS と HTTP はノードで終端する
2. **CloudFront を前に置き、各リージョンのエッジのノードをオリジンにする。** TLS は CloudFront の PoP で終端する
3. **Route 53 の遅延に基づく DNS で、各リージョンの NLB へ導く**（anycast を使わない）
4. **最初から自前の PoP と BGP anycast で作る**

## Decision

S1・S2 は 1 を採用し、S3 で 4 に移る。

- **S1 は 5 リージョン。** 東京・大阪で国内を賄い、海外は 3 リージョン（シンガポール・オレゴン・フランクフルトを第一の候補にする。E1 の着手前に決める）。S2 で 12〜15 リージョンに広げる。
- **入口は Global Accelerator の標準のアクセラレーター。** 利用者の IP を保つ設定の NLB をエンドポイントにする。リージョンの障害は、健全性の検査で新しい接続を別のリージョンへ迂回させる。確立済みの接続は、アイドルのタイムアウト（TCP で 340 秒）まで元のエンドポイントに残る（同上の資料）。具体は [ADR-0017](0017-global-accelerator-and-regional-nlb.md)。
- **同時に退かせるリージョンは 2 つまで。** GA は、不健全なグループの代わりに近い 3 つのグループまで探し、健全なものがなければ最寄りのグループへ送る（fail open）。S1 の 5 リージョンで 3 つ以上を退かせると、この fail open に入る。退かせる印（`drain`）は、中継が 3 つ目を拒む（ADR-0017）。
- **TLS と HTTP は、エッジのノードの入口のプロキシで終端する。** 既定のドメイン（`*.<brand>.<domain>`）とカスタムドメインの証明書を、自分たちで ACME で発行して配る。これにより、WebSocket、HTTP のヘッダー（`<Brand>-Connecting-IP` など）、ルートの解決、段階的なデプロイを自分たちで制御できる。
- **カスタムドメインは CNAME を基本にする。** 利用者は `<something>.<brand>.<domain>` へ CNAME を向ける。apex のドメインのための A レコードは、アクセラレーターの静的な IP を指す。
- **S2 で自前の IP の範囲（BYOIP）に移る。** S3 で自前の PoP に移るとき、apex のドメインの A レコードを変えずに済むようにする。BYOIP は IPv4 だけなので、アクセラレーターは最初からデュアルスタックにし、S2 で両方の IPv4 を自前の範囲にする（ADR-0017）。
- **S3 で自前の PoP と BGP anycast に移る。** 自前の AS 番号で自前の IP の範囲を各 PoP から広告し、PoP の中は L4 の負荷分散で機械に配る。AWS のリージョンは、ストレージの中央・制御プレーン・PoP のない地域の受け皿に使う。移行の手順は [infrastructure.md](../architecture/infrastructure.md) の 8 節。
- 2 を採らない理由：
  - CloudFront の PoP では自前のランタイムを動かせない。関数はリージョンで動くので、「PoP の数」の利点は TLS の終端とキャッシュに限られる。
  - TLS を CloudFront で終端すると、カスタムドメインの証明書の数（S1 で数万）を CloudFront の側で管理することになる。標準の配信は 1 つの証明書と 100 の別名まで、配信はアカウントに 500、多数のテナントの配信は 20 でテナントは 1 万まで（どれも既定。引き上げられる）、ACM の証明書は既定で 2,500 枚（[CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、[ACM quotas](https://docs.aws.amazon.com/acm/latest/userguide/acm-limits.html)、2026-09-27 に確認）。数万のホスト名は、引き上げを重ねる前提になる。
  - CloudFront とオリジンの 2 段のプロキシで、WebSocket の長い接続と、利用者の IP・ヘッダーの扱いが複雑になる。
  - 静的なオブジェクトの公開の配信のキャッシュとしては、MVP の後に検討する余地を残す。
- 3 を採らない理由：DNS の TTL とリゾルバのキャッシュのため、リージョンの障害の迂回が遅い（分の単位の見込み。採らない案なので測らない）。利用者のリゾルバの位置と、利用者の実際の位置がずれる。
- 4 を採らない理由：MVP の規模に対して、調達と運用の固定費が大きすぎる。日本の利用者を先にするなら、東京・大阪のリージョンで近さを得られる。

**遅延と範囲の率直な比較**（往復の数での比較と地域ごとの見積もりは [edge-network-and-routing.md](../architecture/edge-network-and-routing.md) の 11 節。値は見積もりで未検証。E4 の `isp-vantage-probes` の実測で置き換える）：

| 観点 | 本家 | S1（この設計） |
| --- | --- | --- |
| 関数が動く拠点 | 348 都市（上の資料） | 5 リージョン |
| TCP を受ける場所 | 各拠点 | AWS の edge（Global Accelerator は 53 か国・95 都市の 130 の PoP。[Features](https://aws.amazon.com/global-accelerator/features/)、2026-09-27 に確認） |
| TLS の握手の往復 | 最寄りの拠点まで | TCP は AWS の edge で受けるが、TLS と HTTP はリージョンのノードまで往復する |
| 新しい接続の TTFB（関数の処理を除く） | 約 3 × `r_pop`（最寄りの拠点との往復） | 約 3 × `r_edge` ＋ 2 × `r_bb`（edge とリージョンの間の往復が 2 回分乗る）。接続を使い回すと差は `r_bb` の 1 回分 |
| 日本の利用者 | 国内の複数の都市 | 東京・大阪の周辺は本家に近い（TTFB 20〜35ms の見込み）。NFR-003（RTT p50 15ms）と K3（TTFB p50 30ms）は満たせる見込み（未検証。E4 の `isp-vantage-probes` で計測）。札幌・福岡・那覇は往復 2 回分の `r_bb` で本家より遅い（40〜90ms の見込み） |
| 南米・アフリカ・中東・オセアニアの利用者 | 近くの拠点 | 最寄りのリージョンまで遠く、TTFB は本家の 10 倍以上（200〜430ms）になりうる（見積もり。未検証。E4 の `isp-vantage-probes` で海外の地点も測る） |

Deno Deploy は、拠点を 35 から 6 に減らした。多くのアプリが 1 つのリージョンの DB を使い、全拠点での実行が生きなかったためとしている（[Reports of Deno's Demise…](https://deno.com/blog/greatly-exaggerated)、2025-05-20、2026-09-27 に確認）。この題材も、拠点の数よりデータの近さを先に考え、S1 を少ないリージョンで始める根拠の 1 つにする。

## Consequences

- 良くなること：
  - 自前の網を持たずに、anycast の静的な IP と、リージョンの障害の自動の迂回が得られる。
  - TLS と HTTP を自分たちで終端するので、自前の PoP に移っても、入口のプロキシの設計を変えずに済む。
  - 国内の利用者には、本家に近い遅延を出せる見込みがある。
- 引き受けるコスト：
  - 海外の利用者の遅延は、本家より大きい。これを料金と説明（「日本に強いエッジ」）で受け入れる。
  - Global Accelerator の料金（固定の時間の料金とデータの転送の料金）が、転送の量に応じて増える。S1 の DT-Premium は月に約 5,700 ドルの見込み（価格表の API の単価と、リージョンの割合の仮定から。[infrastructure.md](../architecture/infrastructure.md) の 10.2 節）。
  - Global Accelerator は AWS の単一の制御に依存する。アクセラレーター自体の障害には、予備のアクセラレーター（`ga-standby`）へ DNS の 1 レコードで切り替えて備える（ADR-0017、runbook の `accelerator-failover`）。
  - fail open を避けるため、同時に退かせるリージョンは 2 つまでに限る。3 つ目の障害は、退かせずに受ける。
  - S3 の自前の PoP への移行は、大きな工事になる。BYOIP を S2 で始め、IP を変えずに移れる準備をしておく。

## Confirmation

- 合成監視：国内の複数の ISP と、各海外のリージョンの近くから、最小の関数の TTFB と TLS の握手の時間を計測し、NFR-003 と intent の K3 を確かめる。
- 障害の訓練：1 リージョンのエンドポイントを外し、新しい接続が別のリージョンへ迂回するまでの時間と、失敗した要求の割合を計測する（四半期ごと）。
- 設計のレビュー：関数の実行、TLS の終端、証明書の保管を、CloudFront などの AWS の edge のサービスに依存させる変更は、この ADR を更新してからにする。

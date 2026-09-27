---
status: accepted
date: 2026-09-27
---

# ADR-0044: 入口は NLB（AZ をまたがない）＋ Envoy の SNI の振り分けにし、ブローカーのホスト名に AZ ID を入れて同じ AZ の経路を保つ

詳細は [infrastructure.md](../architecture/infrastructure.md) の 5・6 節。

## Context

- 入口は NLB と SNI のプロキシ（Envoy）で、プロキシは TLS を終端しない（[architecture/README.md](../architecture/README.md) の 1 節、[ADR-0001](0001-upstream-brokers-and-stack.md)）。Kora も SNI のプロキシで振り分け、接続の制限をプロキシで掛ける（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 3.1 節）。
- fetch-from-follower で AZ をまたぐ読み取りをなくすには、クライアントからブローカーまでの経路が同じ AZ に留まる必要がある（[ADR-0013](0013-fetch-from-follower.md)、replication-and-durability の持ち越し）。
- NLB は既定で、ノードの AZ の中のターゲットにだけ送る（cross-zone は無効）。NLB は AZ ごとに 1 つの IP を持つ（[Network Load Balancers](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/network-load-balancers.html)、2026-09-27 に確認）。
- Route 53 のワイルドカードは一番左のラベルだけに置ける。`*.example.com` はその下の全ての階層に答える。ACM のワイルドカードの証明書は 1 階層だけを守る（[DNS domain name format](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DomainNameFormat.html)、2026-09-27 に確認）。
- multi-tenancy-and-quotas の領域は、ブローカーのホスト名を `b<broker-id>-<lc-id>.<region>.<brand>.<domain>` とした。これではホスト名から AZ が分からず、DNS はどの AZ の NLB の IP も返しうる。クライアントとブローカーが同じ AZ でも、NLB の別の AZ のノードを通りうる。
- Envoy の `sni_dynamic_forward_proxy` は alpha で、本番向けではない。`tcp_proxy` は、接続ごとに上流のクラスタを filter state（`envoy.tcp_proxy.cluster`）で決められ、必要なときに取りに行くクラスタ（on-demand CDS）の計数を持つ（[SNI dynamic forward proxy](https://www.envoyproxy.io/docs/envoy/latest/configuration/listeners/network_filters/sni_dynamic_forward_proxy_filter)、[TCP proxy](https://www.envoyproxy.io/docs/envoy/latest/configuration/listeners/network_filters/tcp_proxy_filter)、2026-09-27 に確認）。
- NLB の処理のバイトは、TCP で 1 GB/時が 1 NLCU（東京で $0.006）。新しい接続 800/秒、同時の接続 10 万のうち最も大きい次元で課金する（[ELB pricing](https://aws.amazon.com/elasticloadbalancing/pricing/)、AWS Price List API、2026-09-27 に確認）。

## Options

ホスト名と DNS：

1. **ブローカーのホスト名に AZ ID のラベルを入れる：`b<broker-id>-<lc-id>.<az-id>.<region>.<brand>.<domain>`。`*.<az-id>.<region>…` を、その AZ の NLB の EIP に向ける**
2. ホスト名は今のまま。NLB の cross-zone を有効にする
3. 論理クラスタ × ブローカーごとに DNS の記録を作る

振り分け：

- A. **`sni_cluster` と `tcp_proxy` の on-demand CDS。上流の解決は、データ面の xDS のサーバー（sni-router）が行う**
- B. 論理クラスタ × ブローカーごとの filter chain を xDS で配る
- C. `sni_dynamic_forward_proxy`

入口：

- X. **S1 は NLB を置く。処理のバイトの費用が NFR-010 を超えたら、Envoy に EIP を直接付ける形を再評価する**
- Y. NLB を置かず、最初から Envoy に EIP を付けて DNS で散らす

## Decision

1、A、X を採用する。

- ブートストラップは `<lc-id>.<region>.<brand>.<domain>:9092`（NLB の全ての AZ）。ブローカーは 1 の形。これは multi-tenancy-and-quotas の 4.4 節のホスト名を改める。
- NLB：インターネット向け、AZ ごとに EIP、cross-zone 無効、TCP:9092、ターゲットは Envoy の Pod（IP）、Proxy Protocol v2、アイドルのタイムアウトは 610 秒（ブローカーの `connections.max.idle.ms` の 600 秒より長く）。
- Envoy：AZ ごとに置き、同じ AZ のブローカーにだけ送る（ブートストラップも同じ AZ のブローカーを選ぶ）。TLS を終端しない。論理クラスタごとの IP の許可リストは RBAC のネットワークフィルター（Proxy Protocol の送信元 IP）で掛ける。
- sni-router（Go、go-control-plane）：論理クラスタ → 物理クラスタの対応を internal-api から取り、ディスクに写しを持つ。ブローカーの居場所は、各 EKS の EndpointSlice を直接見る。制御面が止まっても、既存の論理クラスタの経路は変わらない。
- 証明書：ACM の書き出せる公開の証明書 1 枚に、`*.<region>` と `*.<az-id>.<region>`（3 つ）を載せる。198 日で、ブローカーの Secret へ配る。期限の 30 日前と 7 日前に知らせる。
- 2 を選ばない理由：NLB のノードからターゲットへの AZ をまたぐ転送が、1 GB あたり $0.02（送信と受信で各 $0.01）増える。fetch-from-follower の効果を消す。
- 3 を選ばない理由：論理クラスタの作成に DNS の反映を待つことになり、SC-3 を圧迫する。S2 で記録が数十万になる。
- B を選ばない理由：S1 で 1 AZ あたり約 1 万の filter chain になり、更新のたびに Envoy の設定が大きく変わる。A が PoC で動かないときの代わりにする。
- C を選ばない理由：alpha で、本番向けでない。
- Y を選ばない理由：NLB の健全性の確認、AZ の切り離し（zonal shift）、Envoy の入れ替えの排出（deregistration）を自前の DNS で作ることになる。S1 の流量では NLB の費用は小さい。

## Consequences

- 良くなること：
  - クライアントが `client.rack` を設定すれば、読み取りはクライアントの AZ の NLB・Envoy・ブローカーだけを通る。
  - 1 つの AZ の NLB・Envoy の障害は、その AZ のブローカー宛ての経路だけに留まる。
- 引き受けるコスト：
  - ブローカーは TLS の送信元を Envoy の IP としか見ない。送信元 IP による制限と監査ログの IP は Envoy で持ち、アクセスログを接続で突き合わせる（security-and-acls の 3.6 節・8 節の前提を改める）。
  - NLB の処理のバイトの費用（書き込み 1 GB あたり約 $0.024、読み取り 3 倍のとき）が、はじめ NFR-010 の見積もりに入っていなかった。統合の工程で NFR-010 に含め、目標を設計点で $0.11 以下に改めた（[capacity.md](../architecture/capacity.md) の 8 節、[architecture/README.md](../architecture/README.md) の 3 節）。
  - `tcp_proxy` の on-demand CDS（`on_demand.odcds_config`）と `sni_cluster` のフィルターは、どちらも本家の文書にある（[TcpProxy](https://www.envoyproxy.io/docs/envoy/latest/api-v3/extensions/filters/network/tcp_proxy/v3/tcp_proxy.proto)、[Upstream Cluster from SNI](https://www.envoyproxy.io/docs/envoy/latest/configuration/listeners/network_filters/sni_cluster_filter)、2026-09-27 に確認）。組み合わせて動くことと、クラスタの数が増えたときの Envoy のメモリーは未検証。E1 の `edge-poc` で確かめ、だめなら B に替える。
  - 証明書に載せる名前が増える（大阪を足すと 8 つ）。

## Confirmation

- 結合テスト：`client.rack` を設定したコンシューマーの fetch の経路（NLB のノード、Envoy、ブローカー）が同じ AZ ID にある。Envoy の「AZ をまたいで送った接続の数」が 0。
- 結合テスト：sni-router を止めても、既存の論理クラスタの接続が続く。制御面を止めても、ブローカーの Pod を入れ替えた後に接続できる。
- 合成監視：AZ ごとのホスト名で、証明書の検証と接続ができる。

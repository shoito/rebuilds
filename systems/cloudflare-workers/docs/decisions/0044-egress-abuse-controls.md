---
status: accepted
date: 2026-09-27
---

# ADR-0044: 外向きの悪用は cordon ごとのアカウントの外向きの方針で抑え、`<Brand>-Worker` で送り元を必ず示す

詳細は [abuse-and-trust-safety.md](../architecture/abuse-and-trust-safety.md) の 7 節と 11 節。

## Context

利用者のコードの外への通信は、すべて外向きのプロキシを通る（[ADR-0010](0010-process-sandbox-and-egress-invariants.md)、[ADR-0020](0020-pingora-ingress-and-egress-proxies.md)）。外向きのプロキシは、サブリクエストの数・同時の接続の数を強制し、`<Brand>-Worker` を付け、NAT の IP と `<Brand>-Ray` を結び付けて記録すると決めている（[edge-network-and-routing.md](../architecture/edge-network-and-routing.md) の 10.3 節）。宛先のポートは S1 で 80・443 と 1024〜65535、25 は拒否で、値は abuse-and-trust-safety で見直すとした。

外向きの悪用には、暗号資産の採掘の中継への接続、開いたプロキシ・VPN の中継、HTTP の大量の送信、攻撃の中継がある。本家の規約は、採掘のソフトウェアと大量の攻撃を禁じる（[Service-Specific Terms: Developer Platform](https://www.cloudflare.com/service-specific-terms-developer-platform/)、2026-09-27 に確認）。

ノードの間で数を同期すると、要求の処理の経路に依存が増える（[ADR-0004](0004-config-and-code-distribution.md)）。通信の中身の検査は、通信の秘密の上の扱いが法務の確認待ち（[intent.md](../intent.md) の L2）。

## Options

1. **cordon ごとのアカウントの外向きの方針（同じ宛先 IP への速さ、宛先のホストの数、帯域、ポート）をノードごとに強制し、採掘・プロキシは静的な印と件数・宛先の形で見つける**
2. 全アカウント共通の制限だけにし、悪用は通報で見つける
3. 外向きの通信の中身（本文）を検査して判定する

## Decision

1 を採用する。

- 方針はノードごとの値で、`c0-untrusted` を最も厳しく、`c2-paid` を緩くする（値は既定案。E12 で本番の分布から直す）。ポートは、無料の cordon で 80・443（`c1-free` は 8080・8443 も）に狭め、有料は edge-network-and-routing の既定のまま。
- 方針は cordon から既定を決め、事件の対応での個別の上書きを `account_egress/` の器で優先の印で配る。
- 超えたら、その `fetch` を失敗させて数え、10 分続いたら `flag` にする。
- 全ノードを合わせた 1 つの宛先 IP への量は、集計で見る（1 分 10 万要求を超えたら `flag`）。
- 採掘は、静的な印（Wasm・JavaScript）と既知の採掘の中継の宛先で自動で止め、CPU の形だけのときは人が見る。性能カウンターの Spectre の検知（[ADR-0013](0013-spectre-mitigations-and-dynamic-isolation.md)）の閾値は混ぜない。
- プロキシ・VPN の中継は、静的な印、宛先の数、WebSocket の長い中継で見つける。禁止の線引きは法務（L4）に出す。
- `connect()`（TCP のソケット）を足すときは、25・465・587 を既定で拒否することを前提にする。
- `<Brand>-Worker` の値は、サブリクエストを出したコードの関数の既定のホスト名（`<worker>.<account>.<brand>.<domain>`）。既定のサブドメインが無効でも、cron・キュー・Durable Objects からでも同じ。利用者が付けた同じ名前のヘッダーは上書きする。内部の経路には付けない。
- 送信元の記録（NAT の IP、時刻、ポート、`<Brand>-Ray`、関数、宛先）を 90 日持つ（L2 の確認で直す）。
- 2 を採らない理由：新しい無料のアカウントから、1 つのノードで大量の攻撃を出せる。通報が届く前に被害が出る。
- 3 を採らない理由：通信の中身の検査は L2 の論点が大きく、正当な利用者の通信も読むことになる。件数と宛先の形で多くを抑えられる。

## Consequences

- 良くなること：
  - 1 つの新しいアカウントが 1 つのノードから出せる量に上限がある。
  - 受け手が、ヘッダーと IP・時刻から関数を特定して通報できる。
  - 要求の処理の経路に同期の依存を足さない。
- 引き受けるコスト：
  - ノードごとの値なので、全ノードの合計は抑えきれない（集計と通報で補う）。
  - 正当な利用（多数の宛先を呼ぶクローラー、Webhook の配信）が無料の cordon で制限に当たりうる。個別の上書きで扱う。
  - 無料の cordon のポートを edge-network-and-routing の既定より狭める（その領域の持ち主の確認が要る）。

## Confirmation

- 結合テスト：各 cordon の値ちょうどで通り、超えると `fetch` が失敗し数えられる。`<Brand>-Worker` が上書きされ、cron・Durable Objects からも付き、内部の経路には付かない。
- 表駆動テスト：採掘・プロキシの既知の印の一致で、期待の措置になる。
- 本番の指標：外向きの制限に当たった数の cordon ごとの分布と、正当な利用からの問い合わせの数。

## 注記（2026-09-27、統合の工程）

- **送信元の IP**：上の「NAT の IP」は、[ADR-0049](0049-aws-accounts-and-network.md) でノードの公開の IPv4 に改めた。ノードは NAT ゲートウェイを通さず、外向きのプロキシだけが自分の公開の IPv4 で外へ出る。送信元の記録の欄は `nat_ip` でなく `egress_ip` にし、`node_public_ips`（ノード・IP・付け外しの時刻）と結び付けて通報を調べる（[edge-network-and-routing.md](../architecture/edge-network-and-routing.md) の 10.3 節、[data-model.md](../architecture/data-model.md) の 12 節）。
- **無料の cordon のポート**：この ADR の狭い既定（`c0-untrusted` は 80・443、`c1-free` は 80・443・8080・8443、有料は 80・443・1024〜65535、25 は全 cordon で拒否）を採り、edge-network-and-routing の 10.3 節の既定をこれに揃えた。
- **`account_egress` の配り方**：アカウントごとの器だが、外向きの方針（基盤の不変条件）を上書きするので、利用者の器の速い経路でなく、基盤の器と同じ段階と 2 人の承認で配る。制限を厳しくする上書き（事件の対応）は、セキュリティの修正として段の待ちを 5 分に縮められる（[ADR-0056](0056-platform-config-staging-and-flags.md)、[data-model.md](../architecture/data-model.md) の 8 節）。

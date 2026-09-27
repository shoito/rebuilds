---
status: accepted
date: 2026-09-27
---

# ADR-0026: クォータは本家の仕組みで掛けられるものは本家で、掛けられないものは小さなパッチで、テナントの単位に掛ける

詳細は [multi-tenancy-and-quotas.md](../architecture/multi-tenancy-and-quotas.md) の 5・6 節。

## Context

- 本家のクォータは、帯域（`producer_byte_rate`・`consumer_byte_rate`。KIP-13）、要求の処理時間（`request_percentage`。KIP-124）、IP の単位の接続の作成の頻度（KIP-612）、コントローラーの変更の頻度（`controller_mutation_rate`。KIP-599）。値はブローカーごとで、超えると `throttle_time_ms` の応答で遅らせる。差し込み口 `ClientQuotaCallback` は `PRODUCE`・`FETCH`・`REQUEST`・`CONTROLLER_MUTATION` の 4 種類を扱う（[Design: Quotas](https://kafka.apache.org/43/design/design/)、[ClientQuotaCallback.java](https://github.com/apache/kafka/blob/trunk/clients/src/main/java/org/apache/kafka/server/quota/ClientQuotaCallback.java)、2026-09-27 に確認）。
- Kora は、帯域、CPU、接続の数と試みの頻度、メモリーを使う振る舞い、パーティションの作成・削除に、テナントの単位のクォータを掛ける（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 5.2 節）。
- Confluent Cloud の Standard は、eCKU あたり書き込み 25 MB/秒・読み取り 75 MB/秒・パーティション 250・接続 1,000・接続の試み毎秒 50・要求毎秒 1,500、最大 10 eCKU（[Cluster types](https://docs.confluent.io/cloud/current/clusters/cluster-types.html)、2026-09-27 に確認）。
- [ADR-0004](0004-logical-clusters-on-shared-physical-clusters.md) は、クォータの種類を Kora と同じにし、本家の仕組みを使うとした。

## Options

1. **本家の `ClientQuotaCallback` で掛けられる 4 種類は本家で掛け、接続の数・接続の試み・パーティションの数・InitProducerId・`transactional.id`・グループの数・圧縮のトピックの大きさは、パッチとデータ面のエージェントで掛ける**
2. 本家の 4 種類だけを掛ける
3. SNI のプロキシ（Envoy）で接続の数と試みを数える

## Decision

1 を採用する。

- `ClientQuotaCallback` のタグは `{tenant: lc-id}` だけにし、テナントのすべての主体とクライアントで 1 つのクォータを共有する。
- 帯域と要求の処理時間は、使用量に応じてブローカーに配る（[ADR-0027](0027-dynamic-quota-coordinator-and-backpressure.md)）。パーティションの作成・削除の頻度は静的な値。
- 帯域・頻度を超えたら遅らせる（throttle）。数の上限（パーティション、グループ、`transactional.id`）を超えたら断る。
- 層ごとの初期値（すべて未検証。E7 の `noisy-neighbor-suite` の負荷試験で見直す）：

| 項目 | Basic | Standard（1 CU あたり、最大 10 CU） |
| --- | --- | --- |
| 書き込み・読み取り | 25・75 MB/秒 | 25・75 MB/秒 |
| 要求の処理時間 | 100% | 75% |
| パーティション | 500 | 250 |
| パーティションの作成・削除 | 毎秒 1 | 毎秒 2（CU によらない） |
| 接続・接続の試み | 500・毎秒 50 | 1,000・毎秒 50 |
| `transactional.id`・InitProducerId・グループ | 1,000・毎秒 10・1,000 | 10,000・毎秒 100・10,000（CU によらない） |
| 圧縮のトピックの大きさ | 50 GiB | 100 GiB |

- CU の正式な定義は metrics-and-billing の領域で決める。この表は仮の定義として使う。
- 上限を緩める例外は、論理クラスタの単位の上書きだけで行い、監査ログに残す。
- 2 を選ばない理由：接続の嵐、パーティションの乱発、PID の乱発は、ブローカーとコントローラーのメモリーを食い、他のテナントに及ぶ。Kora もこれらを掛けている。
- 3 を選ばない理由：Envoy の SNI ごとの接続の上限は、テナントごとに設定の塊（filter chain）を作る必要があり、1,000 以上のテナントで扱いにくい。Envoy の `local_ratelimit` の network のフィルターも、フィルターの鎖ごとの 1 つのバケットで、SNI や送信元ごとには数えない（[Local rate limit](https://www.envoyproxy.io/docs/envoy/latest/configuration/listeners/network_filters/local_rate_limit_filter)、2026-09-27 に確認）。ブローカーは TLS を終端して SNI を知るので、ブローカーで数える方が 1 か所で済む。

## Consequences

- 良くなること：
  - 帯域・CPU・コントローラーのクォータは本家の throttle の振る舞いのまま、クライアントに伝わる。
  - Kora と同じ範囲の資源を、テナントの単位で守れる。
- 引き受けるコスト：
  - パッチ（P4〜P7）が増える。
  - 数の上限で断るときのエラーは、本家にない理由で返すので、差分テストの「許された違い」に載せる。
  - 値の多くは未検証で、E7 の負荷試験（`noisy-neighbor-suite`）の結果で動く。

## Confirmation

- うるさい隣人の試験（[multi-tenancy-and-quotas.md](../architecture/multi-tenancy-and-quotas.md) の 11.3 節の N1〜N10）が通る。
- 性質ベーステスト：任意の要求の列で、テナントの数の上限（パーティション、グループ、`transactional.id`）を、許した誤差を超えて超えない。
- 結合テスト：CU の変更が 1 分以内にブローカーのクォータに反映される（NFR-007）。

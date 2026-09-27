---
status: accepted
date: 2026-09-27
---

# ADR-0013: fetch-from-follower は本家の `RackAwareReplicaSelector` で有効にし、クライアントの `client.rack` に任せる

詳細は [replication-and-durability.md](../architecture/replication-and-durability.md) の 6 節。

## Context

[ADR-0002](0002-replicated-log-with-tiered-storage.md) は、コンシューマーを同じ AZ の複製から読ませ、AZ をまたぐ読み取りの転送をなくすと決めた（NFR-010 の見積もりの前提）。

事実（2026-09-27 に確認）：

- KIP-392（2.4）は、ブローカーの `replica.selector.class` と、クライアントの `client.rack` で、近い複製から読ませる。本家の `RackAwareReplicaSelector` は rack が一致する複製のうち最も追いついたものを選ぶ。フォロワーは高水位までを返し、遅れていれば `OFFSET_NOT_AVAILABLE` を返す。高水位の伝わりの分、遅延が増えうる（[KIP-392](https://cwiki.apache.org/confluence/display/KAFKA/KIP-392%3A+Allow+consumers+to+fetch+from+closest+replica)）。
- Kora も、十分に追いついた同じ AZ のフォロワーから読ませる（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.2.2 節）。

## Options

1. **本家の `RackAwareReplicaSelector`。クライアントが `client.rack` に AZ ID を設定する**
2. **自前の ReplicaSelector。接続の経路（プロキシの AZ、クライアントの IP）から AZ を推定する**
3. **fetch-from-follower を使わない**

## Decision

1 を採用する。

- `broker.rack` と同じ AZ ID を、コンソールと文書で見せ、各クライアントの設定の例を示す。
- `client.rack` を設定しないクライアントは、リーダーから読む（本家の振る舞い）。
- 2 は、クライアントからブローカーまでの経路の設計（NLB と SNI のプロキシ）が決まるまで、推定の正しさを確かめられない。経路の設計の後に再評価する。
- 3 は、NFR-010 の見積もりで、読み取り 3 倍の Standard のトピックに、AZ をまたぐ転送の費用が大きく乗る。

## Consequences

- 良くなること：
  - 本家のままで、差し込み口のコードを書かない。
  - クライアントが設定すれば、読み取りの AZ をまたぐ転送を減らせる。
- 引き受けるコスト：
  - 効果はクライアントの設定と、ネットワークの経路に依る。設定しない利用者には効かない。
  - フォロワーから読むと、端から端の遅延が少し増えうる。NFR-004 を有無の両方で測る。

## Confirmation

- 結合テスト：`client.rack` を設定したコンシューマーが、同じ AZ のフォロワーから読む。フォロワーが遅れたら、再試行の後に読める。
- 性能のテスト：端から端の遅延の p99 を、有無で比べる。
- 監視：同じ AZ の複製から読んだバイトの割合。

---
status: accepted
date: 2026-09-27
---

# ADR-0016: 再配置は同じ AZ の中で 1 つずつ行い、退役は cordon から始め、劣化したブローカーは降格する

詳細は [metadata-and-control.md](../architecture/metadata-and-control.md) の 4・5 節。

## Context

ブローカーの追加・退役・負荷の偏り・ディスクの逼迫で、パーティションを動かす必要がある。耐久性の不変条件として、全てのパーティションの 3 つの複製は異なる 3 つの AZ にある（[ADR-0012](0012-durability-settings-and-elr.md)）。

事実（2026-09-27 に確認）：

- KIP-1066（4.3）の `cordoned.log.dirs` は、cordon したディレクトリに新しいパーティションを置かせない。既存は動き続ける。退役の前に cordon して移すための仕組みである（[KIP-1066](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1066%3A+Mechanism+to+cordon+brokers+and+log+directories)）。
- Kora は、ディスクとネットワークの偏りを再均衡の引き金にし、拡張では負荷への寄与の大きい複製から動かし、劣化したブローカーからリーダーを外す（降格）（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.3・4.5 節）。
- Cruise Control は Kora の Self-Balancing の元になった。本体の最新の版（3.0.4）は本家 3.5 に対して作られ、`main` は 4.3.1 に上げてある（[cruise-control-for-kafka/cruise-control](https://github.com/cruise-control-for-kafka/cruise-control)）。Strimzi 1.2 は Cruise Control 2.5.146 を同梱し、本家 4.3.1 の KRaft の物理クラスタで KafkaRebalance を支える（[Strimzi の文書](https://strimzi.io/docs/operators/latest/deploying.html)。いずれも 2026-09-27 に確認）。4.3 で動くかではなく、下の目標を Cruise Control の目標で表せるかを E9 の `rebalance-planner` で確かめる。

## Options

実行の単位：

1. **複製の集合を一度に目標へ変える（本家の再配置の道具の既定の使い方）**
2. **1 回に複製 1 つを、外す複製と同じ AZ のブローカーへ入れ替える**

計画：

- A. **Cruise Control**
- B. **自前の小さな計画器（必須の目標とディスク・ネットワークの偏りだけ）**

## Decision

2 を採用し、計画は A を候補に E9 の PoC で決め、使えなければ B にする。

- 実行はデータ面のエージェントが `AlterPartitionReassignments` で行う。どの時点でも 3 つの AZ に複製がある。
- throttle は 1 ブローカーあたり 100 MB/秒、同時数は 1 ブローカーあたり 10、物理クラスタで 100 パーティション（仮）。2 時間進まない再配置は取り消して人を呼ぶ。
- 退役：cordon（`cordoned.log.dirs=*`）→ 降格 → 同じ AZ へ移す → 複製 0 の確認 → 正しい停止 → UnregisterBroker → ボリュームの削除。
- 降格：複製の順序だけを入れ替えて優先リーダーを変え、`ElectLeaders`（PREFERRED）で選び直す。同時に降格するのは物理クラスタで 1 台まで。
- cordon と降格の状態は、制御面の望ましい状態に持つ。
- 1 は、途中で 2 つの複製が同じ AZ に寄る、または複数の複製が同時に追いつきを待つ時点があり、AZ の不変条件と ISR の余裕が崩れうる。

## Consequences

- 良くなること：
  - 再配置の途中でも、1 つの AZ の喪失で書き込みを失わない。
  - 退役と拡張の手順が、本家の仕組み（cordon、再配置、優先リーダー）だけで組める。
- 引き受けるコスト：
  - 1 つずつなので、大きな再均衡は時間がかかる。階層型の保存で動かす量を減らして補う（NFR-007 を E9 で測る）。
  - Cruise Control が使えなければ、計画器を自前で保守する。

## Confirmation

- 性質ベーステスト：任意の再配置・cordon・退役・降格の列で、どの時点でも 3 つの AZ に複製があり、cordon したブローカーに新しい複製がない。
- 障害注入：再配置の途中で関わるブローカーを止めても、成功を返した書き込みを失わない。
- 監視：再配置の経過時間、cordon のブローカーの数と期間、降格の回数。

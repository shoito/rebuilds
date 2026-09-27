---
status: accepted
date: 2026-09-27
---

# ADR-0012: 複製 3・AZ ID の rack・`min.insync.replicas=2`・unclean な選出の禁止・ELR を固定し、アプリの fsync はしない

詳細は [replication-and-durability.md](../architecture/replication-and-durability.md) の 3〜5 節。

## Context

[ADR-0002](0002-replicated-log-with-tiered-storage.md) は、複製 3、AZ ごとに 1 つ、`min.insync.replicas=2`、unclean な選出の禁止を決めた。この領域では、これを本家の設定の単位に落とし、ELR とフラッシュの扱いを決める。

事実（2026-09-27 に確認）：

- 本家の既定は `min.insync.replicas` 1、`default.replication.factor` 1（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)）。
- ELR（KIP-966）は、ISR の外でも高水位までを持つ複製をリーダーの候補に残し、不正な停止をした複製を ISR と ELR から外す。高水位は ISR が `min.insync.replicas` 以上のときだけ進む。4.1 で新しいクラスタの既定。有効にすると `min.insync.replicas` はクラスタの単位でだけ設定できる（[KIP-966](https://cwiki.apache.org/confluence/display/KAFKA/KIP-966%3A+Eligible+Leader+Replicas)、[Eligible Leader Replicas](https://kafka.apache.org/41/operations/eligible-leader-replicas/)）。
- Jepsen は、ISR がリーダー 1 つに縮んだまま成功を返す設計で、書き込みを失うことを示した（[Call me maybe: Kafka](https://aphyr.com/posts/293-call-me-maybe-kafka)、2013）。また、`acks=all` が fsync の前に成功を返すことを指摘した（[Jepsen: Redpanda 21.10.1](https://jepsen.io/analyses/redpanda-21.10.1)）。
- 本家は、アプリの fsync をせず、耐久性を複製に任せることを勧める（[Hardware and OS](https://kafka.apache.org/43/operations/hardware-and-os/)）。
- AZ の名前は、アカウントごとに物理の AZ への対応が違う。AZ ID はどのアカウントでも同じ（[AZ IDs](https://docs.aws.amazon.com/ram/latest/userguide/working-with-az-ids.html)）。

## Options

ELR：

1. **ELR を有効にする**
2. **ELR を無効のままにする**

フラッシュ：

- A. **アプリの fsync をしない（本家の既定）**
- B. **成功を返す前に fsync する（`flush.messages=1` など）**

## Decision

1 と A を採用する。

- `default.replication.factor=3`、クラスタの `min.insync.replicas=2`、`unclean.leader.election.enable=false`、`eligible.leader.replicas.version=1`、`broker.rack` は AZ ID。内部のトピックも複製 3・`min.insync.replicas` 2 にする。
- テナントは、これらを同じ値でしか指定できない（[ADR-0007](0007-topic-config-allowlist.md)）。
- 2 は、不正な停止で末尾を失った複製が最後の ISR としてリーダーになり、他の複製を切り詰めさせる危険を残す。
- B は、全ての書き込みでディスクの同期を待つので、produce の遅延（NFR-003）とスループットが大きく落ちる。3 つの AZ の複製があれば、同時にメモリーを失う条件は、2 つ以上の AZ の同時の障害に限られる。
- A の残りの危険（2 つ以上の AZ で、ディスクに書く前に同時に中身を失う）は引き受け、NFR-001 の説明と利用者の文書に書く。
- AZ の喪失の後、残りの 2 つの AZ に 3 つ目の複製を作らない。3 つの AZ の不変条件を保つ。

## Consequences

- 良くなること：
  - 1 つの AZ の喪失でも、1 つの複製の不正な停止でも、成功を返した書き込みを失わない。
  - 本家の実績のある設定の組み合わせで、耐久性が得られる。
- 引き受けるコスト：
  - ISR が 2 未満の間は、`acks=all` の書き込みが失敗し、`acks=1` の書き込みもコンシューマーに見えない。可用性より耐久性を優先する。
  - 2 つ以上の AZ の同時の電源の喪失では、同期していない末尾を失いうる。

## Confirmation

- 設定のテスト：テナントの API で、これらの設定を他の値にできない。
- Jepsen の形：1 つの AZ の孤立、不正な停止と他の複製の停止の重ね合わせで、`lost-write` が 0 件（[ADR-0014](0014-durability-audit-and-fault-injection.md)）。
- 監査：AUD-5（設定と AZ の配置）を毎日照合する。

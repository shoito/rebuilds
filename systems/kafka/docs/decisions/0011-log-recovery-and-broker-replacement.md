---
status: accepted
date: 2026-09-27
---

# ADR-0011: 不正な停止の後は本家の回復と ELR に任せて回復の時間を 5 分に抑え、ボリュームを失ったら空で複製し直す

詳細は [broker-and-log-storage.md](../architecture/broker-and-log-storage.md) の 6 節。

## Context

事実（2026-09-27 に確認）：

- 本家は起動時に、新しいセグメントのバッチの CRC と長さを確かめ、壊れたところで切り詰める（[Log](https://kafka.apache.org/43/implementation/log/)）。回復の並行度は `num.recovery.threads.per.data.dir`（既定 2）。
- 本家はアプリからの fsync を既定で行わず、失ったものは複製から戻ると考える（[Hardware and OS](https://kafka.apache.org/43/operations/hardware-and-os/)）。Jepsen は、`acks=all` が fsync の前に成功を返すことを、ノードの喪失での喪失の危険として指摘した（[Jepsen: Redpanda 21.10.1](https://jepsen.io/analyses/redpanda-21.10.1)）。
- KIP-966 の ELR では、ブローカーが `PreviousBrokerEpoch` で不正な停止を知らせ、コントローラーがそのブローカーを ISR と ELR から外す。これで、末尾を失った複製が最後の ISR としてリーダーになり、他を切り詰めさせる事故を防ぐ（[KIP-966](https://cwiki.apache.org/confluence/display/KAFKA/KIP-966%3A+Eligible+Leader+Replicas)）。ELR は 4.1 で新しいクラスタの既定になった（[Eligible Leader Replicas](https://kafka.apache.org/41/operations/eligible-leader-replicas/)）。
- KIP-1023（4.3、既定は無効）は、空のフォロワーを S3 に上がった最後のオフセットから複製させる（[KIP-1023](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1023%3A+Follower+fetch+from+tiered+offset)）。
- Kora は、ブローカーの再起動の重い部分としてログの回復を最適化した（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.7 節）。

## Options

回復：

1. **本家の回復のまま。回復の時間は成り行き**
2. **本家の回復に、定期のフラッシュを足して回復の起点を進め、回復の時間を抑える**
3. **不正な停止のたびに、ローカルを捨てて空で複製し直す**

ボリュームの喪失：

- A. **同じブローカーの ID で空のボリュームで起動し、本家の複製で戻す（KIP-1023 は検証の後に有効）**
- B. **新しいブローカーの ID で足し、再配置で移す**

## Decision

2 と A を採用する。2 の定期のフラッシュの値は E1 の PoC で確定する。

- 目標：不正な停止からの回復を p99 5 分以内にする。
- 既定案は `log.flush.scheduler.interval.ms=60000`、`log.flush.interval.ms=300000`。produce の遅延（NFR-003）への影響が大きければ、値を緩め、3 を runbook の手段として残す。
- `num.recovery.threads.per.data.dir` はノードの vCPU の数にする。
- ELR を有効にする（[ADR-0012](0012-durability-settings-and-elr.md)）。これが、不正な停止での「最後に残った複製」の喪失への主な守りである。
- 1 は、5.2 節の例で最悪 10 分を超え、その間、複製が 2 つの状態が続く。
- 3 は、ブローカー全体の複製し直しで、AZ をまたぐ転送と時間がかかる。常の手段にしない。
- B は、配置を変えるので、再配置の判断と時間が要る。A は配置を変えずに戻せる。
- KIP-1023 は、E3・E4 で Jepsen の形のテストと性能のテストを通すまで無効にする。

## Consequences

- 良くなること：
  - 回復の時間に上限ができ、複製が 2 つの時間が短くなる。
  - 不正な停止での喪失を、ELR で防ぐ。
- 引き受けるコスト：
  - 定期のフラッシュで、ディスクの I/O が少し増える。
  - 本家の既定と違う設定を持つので、本家の版の更新のたびに、フラッシュの振る舞いの変化を確かめる。

## Confirmation

- 障害の注入：書き込みの途中でノードごと止め、再起動の後に `acks=all` の成功のレコードが全て読める。回復の時間を測る。
- Jepsen の形：不正な停止と、他の複製の停止を重ねても、ELR で喪失が出ない。
- 監視：回復の時間、回復で読み直した量、ISR と ELR の大きさ。

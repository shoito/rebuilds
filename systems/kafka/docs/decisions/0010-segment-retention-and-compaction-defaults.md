---
status: accepted
date: 2026-09-27
---

# ADR-0010: セグメントは 256 MiB・1 時間で切り替え、圧縮は資源を絞って増やし、圧縮のトピックのローカルの量に上限を掛ける

詳細は [broker-and-log-storage.md](../architecture/broker-and-log-storage.md) の 3・4 節。

## Context

事実（2026-09-27 に確認）：

- 本家の既定は `log.segment.bytes` 1 GiB、`log.roll.hours` 168、`log.cleaner.threads` 1、`log.cleaner.dedupe.buffer.size` 128 MiB、`log.retention.check.interval.ms` 5 分（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)）。
- 階層型の保存は閉じたセグメントだけを S3 に上げ、上げ終わるまでローカルを消さない。圧縮のトピックに対応しない（[Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/)）。
- S1 では、データ面の大阪への写しは、S3 に上がったセグメントだけ（[architecture/README.md](../architecture/README.md) の NFR-009）。
- Kora は、保持の時間の誤った変更と、`log-start-offset` の更新の競合による早すぎる削除を報告している（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の表 1）。

## Options

セグメント：

1. **本家の既定（1 GiB、7 日）**
2. **256 MiB、1 時間（テナントは範囲の中で変えられる）**
3. **64 MiB、10 分**

圧縮のトピック：

- A. **上限なし**
- B. **論理クラスタごとに、圧縮のトピックのローカルの量の上限を掛ける**

## Decision

2 と B を採用する。

- 1 は、書き込みの少ないパーティションのセグメントが最長 7 日閉じず、S3 と大阪の写しに上がらない。書き込みの多いパーティションも、1 GiB の単位でしかローカルが減らない。
- 3 は、ファイルの数と mmap と S3 の PUT が増える。1 時間で NFR-009 の説明（S1 で失いうる範囲）を短く保てる。
- 切り替えの揺らぎ（`log.roll.jitter.ms`）を 5 分にし、上げの集中を避ける。
- 圧縮：スレッド 4、重複の除去のバッファ 512 MiB、I/O 100 MiB/秒（PoC で確定）。
- B の上限の値と掛け方は multi-tenancy-and-quotas の領域で決める。この領域の提案は Standard の CU あたり 100 GiB（複製の前。未検証）。
- 保持と `log-start-offset` の前進は、耐久性の監査の対象にする（[ADR-0014](0014-durability-audit-and-fault-injection.md)）。

## Consequences

- 良くなること：
  - ローカルのディスクと、S3・大阪に上がるまでの遅れが小さくなる。
  - 圧縮のトピックでディスクが溢れる危険を、テナントの単位で抑えられる。
- 引き受けるコスト：
  - ファイル記述子と mmap の上限を上げる（OS の設定）。
  - 圧縮のトピックを多く使うテナント（Kafka Streams の状態の大きいもの）は、上限に当たりうる。

## Confirmation

- 差分テスト：本家との違いは `segment.bytes` と `segment.ms` の既定だけ（[ADR-0007](0007-topic-config-allowlist.md)）。
- 性質ベーステスト：任意の保持の設定と時間の経過で、保持の条件より先に消さない。
- 監視：最も古い、上げていない閉じたセグメントの経過時間。クリーナーの最終の実行からの時間。

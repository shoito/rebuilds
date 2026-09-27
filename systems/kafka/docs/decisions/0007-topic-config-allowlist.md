---
status: accepted
date: 2026-09-27
---

# ADR-0007: トピックの設定は許可リストで絞り、耐久性の設定は同じ値の指定だけを通す

詳細は [protocol-and-compatibility.md](../architecture/protocol-and-compatibility.md) の 5 節と [broker-and-log-storage.md](../architecture/broker-and-log-storage.md) の 3 節。

## Context

テナントは CreateTopics・AlterConfigs・IncrementalAlterConfigs でトピックの設定を変えられる。耐久性の既定値（`replication.factor=3`、`min.insync.replicas=2`、`unclean.leader.election.enable=false`）はテナントに変えさせない（[ADR-0002](0002-replicated-log-with-tiered-storage.md)、[AGENTS.md](../../AGENTS.md)）。

事実（2026-09-27 に確認）：

- 本家のトピックの設定は 30 余り。既定は `segment.bytes` 1 GiB、`segment.ms` 7 日、`retention.ms` 7 日、`min.insync.replicas` 1 など（[Topic Configs](https://kafka.apache.org/43/configuration/topic-configs/)）。
- 本家は `CreateTopicPolicy`・`AlterConfigPolicy` の差し込み口を持つ。拒否すると `POLICY_VIOLATION` になる。
- 階層型の保存は、閉じたセグメントだけを上げる。圧縮（compact）のトピックには対応しない（[Tiered Storage](https://kafka.apache.org/43/operations/tiered-storage/)）。
- Kafka Streams などは、内部のトピックを作るときに `replication.factor` や `min.insync.replicas` を明示することがある。

## Options

1. **許可リスト。** 表にある設定だけを、範囲の中で通す。耐久性の設定は、固定の値と同じ指定だけを通す
2. **拒否リスト。** 危険な設定だけを拒否し、他は通す
3. **耐久性の設定を、指定されても黙って固定の値に置き換える**

## Decision

1 を採用する。

- 表にない設定は `POLICY_VIOLATION`。本家の新しい版で増えた設定は、表に足すまで拒否される（安全な側）。
- `replication.factor` は `-1` か `3`、`min.insync.replicas` は `2`、`unclean.leader.election.enable` は `false` の指定だけを通す。既存のアプリが同じ値を明示しても動く。
- 階層型の保存、フラッシュ、索引、スロットルの設定は、運用だけが変える。
- 本家の既定と変えるのは、`segment.bytes`（256 MiB、範囲 64 MiB〜1 GiB）と `segment.ms`（1 時間、範囲 10 分〜7 日）。階層型の保存に上げる単位が閉じたセグメントなので、ローカルのディスクの量と、S3 に上がるまでの遅れ（大阪への写しの RPO に効く。NFR-009）を小さくするため。
- `max.message.bytes` の上限は 8 MiB（Basic は 2 MiB）。
- 2 は、本家の新しい設定を、気づかないまま開放する。
- 3 は、指定した値と実際の値が食い違い、利用者の予想（`min.insync.replicas=3` を指定したのに 2 になる）を黙って裏切る。

## Consequences

- 良くなること：
  - 耐久性の設定が、どの経路でも変わらない。
  - 本家の版の更新で、設定が勝手に開放されない。
- 引き受けるコスト：
  - 許可リストにない正当な設定を使うアプリが動かない。利用者の文書に一覧を書き、要望で足す。
  - セグメントを小さくすると、ファイルの数と索引の mmap が増える。ブローカーの OS の上限を上げる（[broker-and-log-storage.md](../architecture/broker-and-log-storage.md) の 2 節）。

## Confirmation

- 表駆動テスト：表の各行 × 範囲の内・境界・外で、3 つの API の結果が表に一致する。
- 性質ベーステスト：任意の設定の API の列の後、全てのトピックの耐久性の設定が固定の値のまま。
- CI：本家のトピックの設定の一覧と表を比べ、表にない設定があれば知らせる。

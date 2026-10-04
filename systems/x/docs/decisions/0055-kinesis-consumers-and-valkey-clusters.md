---
status: accepted
date: 2026-10-04
---

# ADR-0055: Kinesis の消費者は自前の TypeScript の読み手にし、遅れに厳しい消費者は拡張ファンアウトで読む。シャードの担当と位置は Aurora に持つ。Valkey は用途で 4 つのクラスタに分ける

## Context

- [ADR-0005](0005-event-log-and-outbox.md) は、出来事のログを Kinesis Data Streams にし、消費の部品（KCL か自前の読み手か）を infrastructure の領域に任せた。
- `posts` の流れには 9 つ前後の消費者がいる（fan-out、作者の最近の投稿、通知、カウンター、検索、写しの後始末、T&S、トレンド、データレイク）。
- Kinesis の共有の読み出しは、1 シャードあたり 1 秒 5 回・2 MB/秒を全部の消費者で分け合う。拡張ファンアウトは、消費者ごとに 1 シャード 2 MB/秒で、1 つの流れに 20 まで（オンデマンドの Standard）（[Quotas and limits](https://docs.aws.amazon.com/streams/latest/dev/service-sizes-and-limits.html)、2026-10-04 に確認）。
- KCL は Java の実装で、Node.js からは別のプロセス（MultiLangDaemon）を通すことになる。
- Valkey には、タイムラインの写し、投稿の状態と閲覧者の集合、カウンター、セッションとレート制限、pub/sub を置く。写しの喪失の影響と負荷の形が違う。

## Options

消費者：

1. **自前の読み手（`packages/stream-consumer`）。遅れに厳しい消費者は拡張ファンアウト、他は共有の読み出し。担当と位置は Aurora**
2. KCL（MultiLangDaemon）
3. Lambda のイベントソースの対応付け

Valkey：

- a. **用途で 4 つのクラスタ（`vk-timeline`、`vk-cache`、`vk-counters`、`vk-edge`）**
- b. 1 つの大きなクラスタ

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 5・6 節。

- 拡張ファンアウトで読むのは、NFR-002・NFR-008・NFR-009 に関わる消費者（`fanout-router`、`author-recent`、`notification-builder`、`counter-aggregator`、`search-indexer`、`timeline-maint`、`ts-stream`）。1 つの流れで最大 7 で、上限 20 の中。
- 担当は `stream_leases`（期限 20 秒、5 秒ごとに延ばす、`FOR UPDATE SKIP LOCKED`）。子のシャードは親のシャードを読み終えてから読む。
- 位置：DB に書く消費者は結果と同じトランザクション、Valkey に書く消費者は結果と同じ `MULTI`（ADR-0005）、SQS に仕事を作る消費者は仕事を作った後。
- Valkey：`vk-timeline`（写し、`ar:`、`pl:`）、`vk-cache`（投稿の状態、閲覧者の集合、特徴）、`vk-counters`（数と位置）、`vk-edge`（セッション、トークン、レート制限、pub/sub）。写しの 2 つは `volatile-lru`、数と edge は `noeviction`。
- 2 を採らない理由：Java のプロセスを各タスクに同居させ、TypeScript との間の通信の手順を運用することになる。位置の保存を結果と同じトランザクションにできない。
- 3 を採らない理由：Valkey と Aurora の接続を同時の実行の数だけ持つ。結果と位置を同じ原子の書き込みにできない。
- b を採らない理由：fan-out の書き込みの殺到が、セッションの確かめとレート制限を遅らせる。写しの喪失の訓練を、用途ごとに分けて行えない。

## Consequences

- 良くなること：
  - 消費者が独立に遅れ、`posts` の流れの消費者を増やしても fan-out が遅れない。
  - 位置と結果の原子性を、消費者ごとの書き込み先に合わせて保てる。
  - 写しの喪失の影響が、用途ごとに閉じる。
- 引き受けるコスト：
  - 自前の読み手の正しさ（担当の奪い合い、シャードの分割・統合の順序）を試験で確かめる必要がある。
  - 拡張ファンアウトの費用（消費者×シャードの時間と読んだ量）。
  - Valkey のクラスタが 4 つになり、運用の対象が増える。

## Confirmation

- 性質ベーステスト：PROP-INFRA-001（シャードの分割・統合と再起動で、同じ鍵の出来事を確定の順に処理する）。
- 結合テスト：2 タスクでの担当の奪い合いと期限切れ、位置と結果の原子性。
- 障害の注入：各 Valkey のクラスタの喪失。

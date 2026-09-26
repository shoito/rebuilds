---
status: accepted
date: 2026-09-26
---

# ADR-0003: リアルタイム配信のバスに Redis Pub/Sub を使う

## Context

Relay から Gateway へ、チャンネル単位でイベントを配る仕組みが必要。ADR-0002 により、このバスは失われてもよい。

## Options

1. Redis Pub/Sub
2. NATS
3. Kafka

## Decision

1 を採用する。MVP の規模（同時接続 5 万）では十分で、永続化が不要な用途に合う。Redis はキャッシュなど他の用途にも使える。

## Consequences

- 良くなること：運用するコンポーネントが増えない。
- 引き受けるコスト：購読しているチャンネル数やメッセージ量がさらに大きくなると、NATS などへの移行が必要になりうる。

## Confirmation

- 負荷試験で NFR-002（送信 → 表示 p99 500ms）を満たすことを確認する。

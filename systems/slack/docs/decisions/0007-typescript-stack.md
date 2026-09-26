---
status: accepted
date: 2026-09-26
---

# ADR-0007: TypeScript で統一した技術スタックを使う

## Context

実装の大部分を AI エージェントが担う。エージェントがフロント・API・Gateway の境界をまたいでも整合を保てることと、検証を高速に回せることを重視する。

## Options

1. TypeScript で統一する（Hono、React、Drizzle）
2. バックエンドを Go、フロントを TypeScript にする
3. バックエンドを Elixir（Phoenix Channels）にする

## Decision

1 を採用する。

- API 契約（Zod スキーマ）から型を生成し、フロント・API・Gateway で共有できる。
- 学習データが多く、エージェントの出力品質が安定する。
- 3 はリアルタイム処理に強いが、エージェントが扱うにはエコシステムが小さい。2 は性能で勝るが、MVP 規模では差が出にくい。

## Consequences

- 良くなること：型が契約として働き、境界のずれを型検査で検出できる。
- 引き受けるコスト：Gateway の接続あたりのメモリ効率は Go や Elixir に劣る。負荷試験の結果しだいで、Gateway だけ置き換える余地を残す。

## Confirmation

- CI で、型検査と、契約から生成したコードの差分検査を行う。

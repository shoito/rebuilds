---
status: accepted
date: 2026-09-26
---

# ADR-0004: 検索は PostgreSQL＋pg_bigm で始める

## Context

メッセージの全文検索が必要で、日本語にも対応しなければならない。

## Options

1. 最初から OpenSearch を使う
2. PostgreSQL＋pg_bigm で始め、規模に応じて OpenSearch へ移る

## Decision

2 を採用する。運用するコンポーネントを減らす。インデックスの更新を Worker に分けておけば、後から移行できる。

## Consequences

- 良くなること：MVP の構成が単純になる。
- 引き受けるコスト：大規模ワークスペースでは検索性能が足りなくなりうる。関連度順の並べ替えが弱い。

## Confirmation

- 検索の結合テストに日本語のケース（部分一致、ひらがな・カタカナ混在）を含める。

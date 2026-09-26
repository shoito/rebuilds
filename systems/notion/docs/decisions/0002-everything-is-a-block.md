---
status: accepted
date: 2026-09-26
---

# ADR-0002: すべてをブロックとして持つ

## Context

Notion では、段落・見出し・画像・ページ・データベースの行のすべてが「ブロック」である。ブロックは、親と、子の並び順を持ち、木を作る。本家もこの形で持つ（[Herding elephants](https://www.notion.com/blog/sharding-postgres-at-notion)）。

## Options

1. **すべてをブロックとして、1 つの表（と種類ごとの属性）で持つ**
2. **ページ、段落、データベースの行を、種類ごとの別の表で持つ**

## Decision

1 を採用する。詳細は [block-model.md](../architecture/block-model.md) にある。

- ブロックは、`id`（UUIDv7）、`workspace_id`、`type`、`properties`（種類ごとの属性。JSON）、`parent_id`、`content`（子の ID の並び）、作成・更新の情報を持つ。
- ページはブロックの一種で、データベースの行はページである（本家と同じ）。
- 権限・同期・履歴・検索は、ブロックの単位で同じ仕組みを使う。
- 2 は、ブロックの種類を変える操作（段落を見出しに、行をページに）や、種類をまたぐ移動が、表をまたぐ処理になる。

## Consequences

- 良くなること：
  - 種類を増やしても、同期・権限・履歴の仕組みを作り直さなくてよい。
- 引き受けるコスト：
  - 1 つの表が非常に大きくなる（S3 で数千億行）。ワークスペースで分割する（[ADR-0003](0003-workspace-sharding.md)）。
  - データベースの問い合わせ（プロパティでの絞り込み）は、ブロックの表だけでは遅い。問い合わせ用の索引を別に持つ（[databases.md](../architecture/databases.md)）。

## Confirmation

- 性質ベーステスト：任意の操作の列の後で、ブロックの木が木である（循環がなく、各ブロックの親は 1 つで、親の `content` にだけ現れる）。

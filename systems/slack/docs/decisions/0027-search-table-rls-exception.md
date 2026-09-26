---
status: accepted
date: 2026-09-26
---

# ADR-0027: 検索用のテーブルだけ RLS を外し、関数を経由してしか読めないようにする

[ADR-0009](0009-pooled-tenancy-with-rls.md) の「全テナントテーブルで RLS を有効にする」の例外を定める。

## Context

S1 の検索は、PostgreSQL と pg_bigm で行う（[ADR-0004](0004-postgres-fulltext-search-first.md)）。

ところが、PostgreSQL は RLS のあるテーブルで、leakproof でない演算子を含む条件にインデックスを使わない。`LIKE` は leakproof でないため、RLS を有効にしたままでは pg_bigm の GIN インデックスが効かず、ワークスペースの全行を走査することになる（[search.md](../architecture/search.md) の 4.1 節）。

演算子を leakproof にするには superuser の権限が要り、Aurora では行えない見込みである（未検証）。

## Options

1. **RLS を有効にしたまま、全行を走査する**
2. **検索用のテーブルだけ RLS を外す。** `app` ロールには権限を与えず、`SECURITY DEFINER` の関数を経由してしか読み書きできないようにする
3. **S1 から OpenSearch を使う**

## Decision

2 を採用する。

- 1 は、5,000 人規模のワークスペースで、検索の目標（p95 1 秒）を守れない。
- 3 は、テナントの分離を OpenSearch 側の条件で行うことになり、運用する部品も増える。S2 の移行計画（search.md の 5 節）で扱う。

### 例外の範囲と、代わりの守り

| 項目 | 規則 |
| --- | --- |
| 対象 | `search` スキーマのテーブル（`search.message_docs`）だけ。他のテーブルには広げない |
| 直接のアクセス | `app` ロールに `search` スキーマのテーブルへの権限を与えない |
| 読み出し | `search.find_messages(...)`（`SECURITY DEFINER`、所有者は `search_owner`）だけ。クエリの形は固定で、引数は値だけ受け取る |
| テナントの条件 | 関数の中で、`workspace_id = current_setting('app.workspace_id')::uuid` と、読めるチャンネルの条件を必ず付ける |
| 書き込み | `search.upsert_docs(...)` だけ。indexer が使う |
| 返す値 | `message_id` の一覧だけ。本文は API が RLS の下で読み直す |
| `search_owner` | `BYPASSRLS` を持たない。関数の中で参照する `channel_members` などには、RLS がかかったまま |

最後の 2 つの規則によって、関数に誤りがあっても、別のテナントの本文は返らない（多層防御）。

## Consequences

- 良くなること：S1 で、pg_bigm のインデックスを使った検索ができる。
- 引き受けるコスト：
  - テナントの分離が、DB の RLS ではなく、関数の実装に依存する部分ができる。関数の変更は、Dev（テックリード）と QA のレビューを必須にする。
  - マイグレーションの lint に、例外の規則を足す必要がある。

## Confirmation

- マイグレーションの lint：
  - `search` スキーマだけを RLS の検査の例外にする。
  - `app` ロールへの `search` スキーマの権限の付与を禁止する。
- 性質ベーステスト（PROP-WS-001 の検索版）：任意の 2 テナントと任意の検索語で、`search.find_messages` が他方のテナントの `message_id` を返さない。
- 結合テスト：`app` ロールで `search.message_docs` を直接 SELECT すると、権限のエラーになる。
- Aurora の実行計画で、GIN インデックスが使われることを確かめる（E6）。

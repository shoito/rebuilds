---
status: accepted
date: 2026-09-27
---

# ADR-0032: MVP の名前の検索は Aurora の中で行う。組織の行を部分一致で絞り、候補を読めうる資源の集合で絞り、判定関数で読み直す

## Context

MVP の検索は、ファイルの名前での検索である（[intent.md](../intent.md) の MVP）。ファイル・プロジェクト・チーム・人の名前を、読めるものだけ出す（NFR-010）。

本家は OpenSearch を使い、前処理で利用者が読めるファイルの情報から filter を作り、後処理で結果の権限を確かめる（[The search for speed in Figma](https://www.figma.com/blog/the-search-for-speed-in-figma-opensearch/)、2024-10-10、2026-09-27 に確認）。

rebuilds の先例：

- Slack は、S1 を PostgreSQL＋pg_bigm にし、RLS の下で `LIKE` が索引を使えないので、検索用の表だけ RLS を外して関数から読んだ（[Slack の ADR-0004](../../../slack/docs/decisions/0004-postgres-fulltext-search-first.md)、[Slack の ADR-0027](../../../slack/docs/decisions/0027-search-table-rls-exception.md)）。
- Notion は、本文の量が大きいので S1 から OpenSearch にした（[Notion の ADR-0023](../../../notion/docs/decisions/0023-search-engine-and-permission-filtering.md)）。

Figma の MVP の対象は名前だけで、1 組織で最大数十万件、1 件あたり数十文字である。

## Options

1. **Aurora の中で、`org_id` の索引で組織の行に絞り、正規化した名前を部分一致で走査する**
2. **Aurora＋pg_bigm。検索用の表だけ RLS を外す**（Slack の形）
3. **S1 から OpenSearch**（Notion と本家の形）

権限：

- a. **候補を「読めうる資源の集合」（判定関数の上位集合）で絞り、判定関数で読み直す**
- b. **判定関数を SQL で書き直し、SQL だけで決める**

## Decision

1 と a を採用する。詳細は [search.md](../architecture/search.md) の 3 節。

- 名前は `normalizeForSearch`（NFKC、小文字化、空白の整理）した列に持ち、`LIKE '%語%'` で探す。RLS はそのまま。
- 候補の段は、`readableScopes`（役割を持つチーム・プロジェクト・ファイル、一般アクセスが `org` のプロジェクト・ファイル）で絞る。上位集合なので、判定関数で読めるものを落とさない。候補は 500 件まで。
  - > 2026-09-27 の注記：チームへの参加で中身の候補を広げていたのを、役割を持つチームに改めた。チームの参加と一般アクセスは中身に届かないと決めたため（ADR-0029 の注記）。
- 結果は、判定関数と RLS の下で読み直した行から作る。合計の件数は返さない。
- 最大の組織が 20 万ファイルを超えるか、p95 が 500ms を超えたら、2 へ移る。
- 2 を採らない理由：S1 の件数では、索引なしの走査で目標に収まる見込みで、RLS の例外（テナントの分離を関数の実装に頼る部分）を増やす理由がない。
- 3 を採らない理由：名前だけのために、索引の同期・再作成・運用の部品を 1 つ増やす。中身の検索（[ADR-0033](0033-content-search-from-checkpoints.md)）で OpenSearch を入れるときに、名前も載せるか決める。
- b を採らない理由：本家が苦しんだ、判定の規則の 2 か所での食い違い（[ADR-0030](0030-single-policy-engine-and-signed-capabilities.md)）を、SQL で持ち込む。

## Consequences

- 良くなること：
  - 部品を増やさず、RLS の例外も作らない。
  - 権限の最終の判断は、判定関数の 1 か所に残る。
- 引き受けるコスト：
  - 組織が大きくなると走査が重くなる。切り替えの基準を計測する。
  - 関連度の並べ替えは単純（前方一致を先、次に更新の新しい順）。
  - 候補の段の規則（`readableScopes`）が判定関数の上位集合であることを、テストで守り続ける必要がある。

## Confirmation

- 性質ベーステスト：結果のすべてを判定関数で読める。判定関数で読めて名前が一致するものは、候補の段に入る。
- 性質ベーステスト：任意の 2 組織で、一方の文脈の検索が他方の資源を返さない。
- 負荷テスト：10 万ファイルの組織で p95 500ms。

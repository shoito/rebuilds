---
status: accepted
date: 2026-09-26
---

# ADR-0014: データベースの問い合わせは、シャードの中の型付きの索引の表で行う

## Context

データベースのビューは、プロパティでの絞り込み・並べ替え・グループ化を行う。行は 25 万まであり（本家の上限。[Optimize database performance](https://www.notion.com/help/optimize-database-load-times-and-performance)）、1 万行のビューを p95 1 秒で出す必要がある（NFR-003）。行はブロックで、値は `properties`（JSON）にある（[ADR-0002](0002-everything-is-a-block.md)）。ブロックの表だけでは、プロパティでの絞り込みが遅い。また、行を追加した直後のビューに、その行が出ている必要がある。

## Options

1. **ワークスペースのシャードの中に、型付きの索引の表（行ごと・プロパティの値ごとの行）を持ち、変更と同じ DB のトランザクションで更新する**
2. **ブロックの `properties`（JSONB）に、GIN や式の索引を張る**
3. **別の問い合わせ用のストア（OpenSearch や列指向の DB）へ、非同期に写す**
4. **行をすべてクライアントへ送り、クライアントで絞り込む**

## Decision

1 を採用する。詳細は [databases.md](../architecture/databases.md) の 3 節にある。

- `dbx_row` と `dbx_value`（`v_text`・`v_num`・`v_ts`・`v_bool`・`v_ref` の型付きの列）を持ち、型ごとの B-tree と、テキストの「含む」のための trigram の索引を張る。
- 押し下げられる条件と並べ替えは SQL にし、残りは TypeScript の参照実装の評価器で判定する。評価器は、クライアントのオフラインの問い合わせとテストのオラクルにも使う。
- 押し下げられない並べ替えの結果は `query_id` で 15 分キャッシュしてページ送りする（本家の Views API と同じ形。[Working with views](https://developers.notion.com/guides/data-apis/working-with-views)）。
- 行は `data_source` の `content` に並べず、索引の表で列挙する。ADR-0002 の不変条件は、行については「親の `data_source` がちょうど 1 つ」と読み替える。
- 2 は、データソースごと・プロパティごとの式の索引を動的に作れず（データソースは数百万）、JSON の中の値の型が混ざる。
- 3 は、写しの遅れで、書いた直後のビューに行が出ない。権限の判定も写しの側に二重に持つことになる。S3 で、再構築できる写しとして検討する。
- 4 は、10 万行を超えるデータベースで読み込みが重い。本家も 2022 年に全体の読み込みをやめた（[Notion 2.16](https://www.notion.com/releases/2022-04-14)）。

> 2026-09-27 の注記：表の名前を複数形に揃えた（[data-model.md](../architecture/data-model.md) の冒頭の規約）。この ADR の `dbx_row`・`dbx_value` は `dbx_rows`・`dbx_values` と読む。`data_source` はレコードの種類の名前で、表は `data_sources`。

## Consequences

- 良くなること：
  - 自分の書き込みの直後に、その変更を含むビューを返せる。
  - シャードと RLS（[ADR-0003](0003-workspace-sharding.md)）にそのまま乗り、S2 の物理の分散にも一緒に乗る。
- 引き受けるコスト：
  - 書き込みの増幅。1 行の変更で、変わったプロパティの数だけ `dbx_value` を書く。
  - 索引の表は正本の写しなので、ずれを検出して作り直す整合の検査のジョブを運用する。
  - EAV の形なので、複数のプロパティの条件の組み合わせは、SQL の結合か評価器での判定になり、条件によっては遅い。

## Confirmation

- 性質ベーステスト：任意のスキーマ・行・ビューの設定で、索引の表を使った問い合わせの結果（順序を含む）が、全行を評価器で判定した結果と一致する。
- 整合の検査：本番で、ブロックの `properties` と `dbx_value` の差分を定期的に数え、0 を保つ。
- 性能テスト：1 万行のビューで p95 1 秒、25 万行で押し下げられる条件なら p95 2 秒。

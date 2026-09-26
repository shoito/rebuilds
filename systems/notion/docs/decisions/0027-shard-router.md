---
status: accepted
date: 2026-09-26
---

# ADR-0027: 論理シャードを PostgreSQL のスキーマで持ち、アプリの中のルーターで物理クラスタへ振り分ける

## Context

[ADR-0003](0003-workspace-sharding.md) で、ワークスペースの ID で 480 の論理シャードに分け、論理シャードを物理のクラスタに割り当てる表を持つと決めた。S1 は物理 1 つである。まだ決めていないことが 3 つある。

- 論理シャードを、DB の中で何として表すか
- ワークスペースの ID から論理シャードを決める関数
- 接続の振り分けを、どこで行うか（アプリか、プロキシか）

本家は、論理シャードを Postgres のスキーマ（`schema001.block` のような形）で表し、1 つの物理 DB に 15 のスキーマを置いた。振り分けはアプリの層で行い、Postgres のパーティションは使っていない（[Herding elephants](https://www.notion.com/blog/sharding-postgres-at-notion)）。

## Options

表し方：

1. **論理シャードごとに PostgreSQL のスキーマを 1 つ作る**（`shard000`〜`shard479`。各スキーマに同じテーブルの一式）
2. 1 つのスキーマのテーブルに `logical_shard` 列を足し、宣言的パーティションで分ける
3. 論理シャードを表さず、物理を分けるときに行を `workspace_id` の条件で選んで移す

振り分けの場所：

A. **アプリの中のライブラリ**（`packages/shard-router`）
B. 接続のプロキシ（PgBouncer など）の設定で振り分ける

## Decision

1 と A を採用する。

### 論理シャードの決め方

- `logical_shard = (workspace_id の末尾 64 ビットを符号なし整数とみなした値) mod 480`。
  - ワークスペースの ID は UUIDv7 で、末尾 64 ビットは乱数部（variant の 2 ビットを除く）なので、偏りなく散る。ハッシュのライブラリが要らず、TypeScript・SQL・Spark のどこでも同じ値を計算できる。
  - ワークスペースの ID は、必ずサーバーで生成する。クライアントやインポートの入力から受け取らない（偏った ID で 1 つのシャードに寄せられるのを防ぐ）。
- この関数と 480 という数は、一度決めたら変えない。変えるなら、全データの移動を伴う新しい ADR にする。
- 作成時に計算した値を、`global.workspaces.logical_shard` にも保存する。ルーターは計算した値と保存した値が違えば、処理を止めてエラーにする（取り違えの検出）。

### DB の中の形

- 物理クラスタの中に、論理シャードのスキーマ `shard000`〜`shard479` と、シャードに分けないテーブルのスキーマ `global` を置く。S1 は 1 つのクラスタにすべてを置く。
- ブロックの表から外部キーでたどれるテーブルは、すべてシャードのスキーマに置く（本家と同じ方針。[Herding elephants](https://www.notion.com/blog/sharding-postgres-at-notion)）。テーブルの一覧は [data-model.md](../architecture/data-model.md)。
- `global` には、ワークスペースをまたぐもの（アカウント、ワークスペースの一覧と所在、シャードの割り当ての表）だけを置く。S2 で `global` を独立した小さなクラスタに移す。
- シャードのスキーマの中でも、RLS と `workspace_id` を含む複合キーは [ADR-0003](0003-workspace-sharding.md) のとおり持つ。1 つの論理シャードに多数のワークスペースが同居するため。

### ルーター

```
withWorkspaceTx(workspace_id, mode, fn)
  1. logical_shard を計算する
  2. shard_map（キャッシュ）で物理クラスタと状態を引く
  3. 物理クラスタの接続プール（writer か reader）から接続を取る
  4. BEGIN; SET LOCAL search_path = shard042; SET LOCAL app.workspace_id = …
  5. fn を実行し、COMMIT
```

- `app` ロールの既定の `search_path` は空にする。ルーターを通らないクエリは、テーブルが見つからずに失敗する。
- 1 つのトランザクションで、2 つのワークスペース・2 つのシャードに触れない（[ADR-0003](0003-workspace-sharding.md)）。ルーターの API がそれを表せない形にする。
- `global.shard_map (logical_shard, cluster_id, state, version)` が割り当ての正本である。各タスクは 10 秒ごとと、フェンス（下記）によるエラーを受けたときに読み直す。
- 状態は `active`（通常）、`frozen`（移動の切り替え中。書き込みを最大 10 秒待たせる）、`fenced`（移動元。書き込みを拒否する）の 3 つ。
- **古いキャッシュで移動元へ書かないよう、DB の側でも止める（フェンス）。** 移動元のスキーマから `app` ロールの書き込み権限を外す。古い割り当てで書いたタスクは権限エラーを受け、`shard_map` を読み直して移動先へやり直す。
- 接続のプールは物理クラスタごとに持つ。論理シャードごとには持たない。プロキシは置かない（RDS Proxy を使わない理由は Slack の [capacity.md](../../../slack/docs/architecture/capacity.md) の 2.2 節と同じ）。

### 選ばなかった理由

- 2 は、スキーマの変更が親の表で一度に効くため、論理シャードごとに順にマイグレーションを当てること（[ADR-0031](0031-migration-rollout-by-shard-groups.md)）と、スキーマ単位のフェンスができない。
- 3 は、分けるたびに行の条件で移す範囲を決め直すことになり、移動の単位が毎回変わる。
- B は、割り当ての変更をプロキシの設定の反映とそろえる必要があり、本家もその再設定に手間をかけた（[The Great Re-shard](https://www.notion.com/blog/the-great-re-shard)）。アプリで持てば、フェンスと再試行を 1 か所で扱える。

## Consequences

- 良くなること：
  - 物理を分けるとき、スキーマの束を単位に移せる（[ADR-0028](0028-zero-downtime-resharding.md)）。
  - 1 つの論理シャードの問題（重い、壊れた）を、スキーマの単位で調べ、止め、復元できる。
- 引き受けるコスト：
  - テーブルの数が 480 倍になる（スキーマの数 × テーブルの数）。カタログが大きくなり、`pg_dump` や VACUUM の対象が増える。
  - マイグレーションを 480 回当てる必要がある（[ADR-0031](0031-migration-rollout-by-shard-groups.md)）。
  - 1 つのワークスペースは 1 つの論理シャードに収まる前提のまま。論理シャード 1 つの負荷が物理 1 台を超える場合は、ここでは解けない（[capacity.md](../architecture/capacity.md) の 4 節）。

## Confirmation

- lint：シャードのテーブルを、スキーマ名付きで参照するコードを禁止する（ルーターを経由させる）。`global` のテーブルへのアクセスは、専用のモジュールに限る。
- 性質ベーステスト：任意のワークスペースの ID で、TypeScript と SQL の論理シャードの計算が一致する。
- 結合テスト：`search_path` を設定しない接続で、シャードのテーブルが読めない。フェンスしたスキーマへの書き込みが拒否され、ルーターが読み直して成功する。
- 監視：論理シャードごとの行数と負荷の分布を見て、偏りを検出する（[observability.md](../architecture/observability.md)）。

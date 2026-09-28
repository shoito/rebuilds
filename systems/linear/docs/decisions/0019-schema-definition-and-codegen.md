---
status: accepted
date: 2026-09-28
---

# ADR-0019: モデルは TypeScript の宣言で 1 か所に書き、DB・共有のパッケージ・クライアントの構成・GraphQL の型を生成する。欠けた規則は生成で失敗させ、破壊の変更は広げてから縮める

## Context

この題材は数十種のモデルを、サーバー（Aurora、Writer、Sync API、Gateway）とクライアント（オブジェクトプール、IndexedDB、M2 の索引）で同じ意味で扱う。先に決めた ADR が、モデルの定義（スキーマ）に次のことを求めている。

- フィールドごとの競合の種類。欠ければ生成を失敗させる（[ADR-0002](0002-sync-model.md)、[ADR-0008](0008-conflict-rules-and-fractional-keys.md)）。
- モデルごとの読み込みの方針と、同期グループの規則。規則のないモデルは生成を失敗させる（[ADR-0003](0003-bootstrap-and-partial-sync.md)、[ADR-0004](0004-tenancy-and-permissions.md)）。
- 被覆の鍵と `include`（[ADR-0012](0012-lazy-loading-coverage-and-tombstones.md)）。
- `schema_version`・`schema_hash` と、上げ忘れの検査（[ADR-0014](0014-indexeddb-layout-durability-and-migrations.md)）。
- 1 つ前の版のクライアントを 30 日受ける（[ADR-0005](0005-client-persistence-and-offline.md)）。

第三者の解析によれば、本家はクライアントの `ModelRegistry` にモデルとプロパティのメタデータを持ち、そこからスキーマのハッシュを計算する（[wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine)、2026-09-28 に確認。本家の保証ではない）。本家が定義から DB を生成しているかは未検証。

## Options

定義の置き場所：

1. **TypeScript の宣言（`model()`）を正本にし、生成器で各所のコードを作る**
2. 独自の DSL（別のファイル形式）を正本にする
3. DB のマイグレーション（SQL）を正本にし、そこから型を作る
4. 各所で手で書き、突き合わせのテストで一致を確かめる

変更の扱い：

- a. **生成器が前のリリースと比べて互換・破壊に分け、破壊は広げてから縮める 2 段を強制する**
- b. 分類せず、レビューで判断する

## Decision

1 と a を採用する。詳細は [data-model-and-schema.md](../architecture/data-model-and-schema.md) の 3〜6 節。

- 定義は `packages/schema` の TypeScript の宣言に書く。任意の関数は書かせず、`groups` の規則と `partial` の条件は名前の付いた部品から選ぶ。SQL とクライアントのコードの両方に訳すため。
- フィールドは `type`・`conflict` が必須。`ref` は `on_delete`、`order` は `order_scope`、`string` と `set` は `max` が必須。モデルは `groups`・`load`・`delete` が必須。型と `conflict` の組み合わせは表で決め、表の外は失敗させる。
- 生成するもの：DB の望む形（RLS のポリシーと同期の列を含む）、`packages/model`（型、Zod、`applyOp`、`groupsOf`、`via` の逆向きの表）、IndexedDB の構成と M2 の列と `schema_version`・`schema_hash`、被覆の鍵の生成と検証、GraphQL の型（`api: public` だけ）。
- マイグレーションは生成器が下書きし、人がレビューする。CI は、全マイグレーションを当てた DB と望む形を比べて、ずれを失敗させる。
- 変更の分類：任意のフィールド・モデル・列挙の値・索引の追加は互換。フィールドの削除・改名、型や `conflict` の変更は破壊。破壊は「広げる（新しいフィールドを足し、Writer が両方を書く）→ 移る（クライアントと `upcast`）→ 縮める（古い `schema_hash` が互換の一覧から外れた 30 日の後）」で行う。`conflict` を同じフィールドのまま変えない。
- 古いクライアントは、知らないフィールドを捨てずに保存し、知らない列挙の値を「不明」と描き、知らないモデルの差分を当てずに `last_sync_id` だけ進める。
- 2 を採らない理由：構文解析、エディタの補完、エラーの位置の表示を自前で作る費用に見合わない。TypeScript の宣言なら型の検査と補完がそのまま効く。
- 3 を採らない理由：SQL には競合の種類・同期グループ・読み込みの方針を書く場所がなく、クライアントの構成を導けない。
- 4 を採らない理由：規則の置き場所が散り、ADR-0008 が避けた「クライアントとサーバーで規則がずれる」状態を作る。
- b を採らない理由：破壊の変更の見落としは、古いクライアントの outbox が送れない（NFR-004 の喪失に近い）形で現れる。機械で分けられるものは機械で止める。

## Consequences

- 良くなること：
  - 新しいフィールドやモデルで、競合の種類・同期グループ・読み込みの方針を書き忘れない。
  - サーバーとクライアントが同じ生成のコードを使い、`applyOp` と検証がずれない。
  - 古いクライアントを壊す変更を、PR の段階で止められる。
- 引き受けるコスト：
  - 生成器そのものの保守。生成器の誤りは全体に広がるので、生成器にも性質ベーステストを付ける。
  - 破壊の変更が 3 段・30 日以上かかる。
  - マイグレーションのレビューが人の手間として残る。

## Confirmation

- CI：[data-model-and-schema.md](../architecture/data-model-and-schema.md) の 4.1 節の検査（統合の工程で 14 項目に広げた）。わざと誤った定義で各行が失敗することを例示テストで確かめる。
- CI：全マイグレーションを当てた DB と望む形の比較。
- 性質ベーステスト：PROP-SCHEMA-001（往復）、PROP-SCHEMA-002（古いクライアントの許容）。
- リリースの前：1 つ前の版の生成のコードを持つクライアントとの往復の試験。

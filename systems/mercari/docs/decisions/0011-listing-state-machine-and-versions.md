---
status: accepted
date: 2026-10-10
---

# ADR-0011: 出品の状態を 9 つにし、遷移は `transitionListing()` だけが書く。取引に伴う遷移も取引の同じトランザクションの中でこの関数を呼ぶ。買い手に見える変更のたびに `version` を 1 上げ、再出品は新しい出品を作る

詳細は [listings-and-photos.md](../architecture/listings-and-photos.md) の 4 節。

## Context

- 出品の状態は、売り手の操作（下書き、公開、停止、削除）、取引（購入、取り消し、完了）、T&S（保留、措置、異議）の 3 つの主体から変わる。
- 二重の販売を防ぐ購入の条件つきの更新（`status = 'on_sale' AND version = $2 AND price = $3`）は、出品の状態とバージョンに依る（[ADR-0002](0002-transaction-state-machine-and-single-purchase.md)）。
- 取引が取り消されたとき、措置した出品を販売中に戻してはならない（ADR-0002）。
- 公開の前に分類器を待つ規則があり、その間の状態が要る（[ADR-0009](0009-trust-and-safety-pipeline-boundary.md)）。
- 検索の索引は、出品のバージョンを外部のバージョンにする（[ADR-0008](0008-search-engine-and-index.md)）。

## Options

1. **明示の状態（`draft`・`screening`・`on_sale`・`paused`・`trading`・`sold`・`under_review`・`removed`・`deleted`）と 1 つの遷移の関数・決定表**
2. 状態の列を減らし、`is_paused`・`is_held`・`is_removed` などの印の組で表す
3. 各サービスが自分の関わる列を直接更新する

## Decision

1 を採用する。

- 遷移は `packages/listings` の `transitionListing(listing_id, event, actor, expected_version)` だけが書く。行を `FOR UPDATE` で取り、決定表 DT-LST-001 で次の状態を決め、`listing_events` に行を足し、outbox を書く。
- `purchaseListing` と取引の遷移の関数は、core の同じトランザクションの中でこの関数を呼ぶ。ADR-0002 の条件つきの更新は、この関数の `on_sale → trading` の実装である。
- 取引の取り消しは、発送の前なら `on_sale`、発送の後なら `paused` に戻す（[ADR-0027](0027-cancellation-rules-and-listing-restoration.md)）。出品が `removed` なら戻さない。
- T&S の理由の遷移（`hold`・`remove`・`restore`）は、`moderation_action_id` を必ず持つ。
- `under_review` は戻り先 `resume_to` を持つ。`removed` から戻るのは異議が認められたときだけで、`paused` に戻す。
- `version` は、状態・価格・題名・説明・写真・カテゴリ・ブランド・状態の段・配送の変更で 1 上げる。いいねの数では上げない。
- 再出品は、元を写した新しい出品（新しい ID、`relisted_from`）を下書きで作る。

### 他の案を選ばなかった理由

- **2（印の組）**：組み合わせの数が増え、「保留かつ取引中」のような意味のない組が表せてしまう。決定表で全行を試しにくい。
- **3（各サービスが直接）**：措置した出品を取引の取り消しで戻す誤りを、1 か所で防げない。

## Consequences

- 良くなること：出品の状態の誤りを 1 つの決定表で試せる。購入・措置・取引の取り消しの競合が、行のロックと `expected_version` で決まる。
- 引き受けるコスト：取引のサービスが `packages/listings` の関数に依る（同じ core のクラスタなので許す）。core を S3 で分けるときも、出品と取引は同じ分け先に置く（ADR-0002 の結果と同じ）。

## Confirmation

- DT-LST-001 の全行の表駆動テスト。
- PROP-LST-001〜003（並行の事象の列で、遷移が決定表だけを通り、`trading` と進行中の取引が 1 対 1、`removed` は戻らない）。
- 依存の lint：`listings` の `status` の列を `transitionListing` の外で更新するコードを拒む。

---
status: accepted
date: 2026-10-10
---

# ADR-0026: 人気の出品の購入は、Valkey の出品の写しの確かめ → 先着の印 → DB の順に絞る。印は取引の取り消しで比べて消す。Valkey がないときは出品ごと・タスクごとの同時実行 4 と `lock_timeout` 200ms で DB を守る。勝った試行だけが残高を引き当てる

## Context

- [ADR-0002](0002-transaction-state-machine-and-single-purchase.md) は、DB の条件つきの更新と部分一意の索引を正本にし、Valkey の先着の印（15 秒）を前に置くと決めた。印は取引の作成で消さない、とした。
- S1 で、人気の 1 出品に出品の直後の 1 秒に 5,000 件の購入が来る（[architecture/README.md](../architecture/README.md) の 2 節）。負けの応答は p99 200ms（NFR-002）。
- 印だけでは、取引ができた後も 15 秒の間、全員が `SET NX` を試し、印の持ち主が誰かを毎回確かめる。
- 決済が失敗して出品が販売中に戻っても、印が 15 秒残ると、その間は誰も買えない。
- 売上金・ポイントで払う試行が、負けるまでに ledger で残高を引き当てると、負けた数千の試行が ledger を叩く。

## Options

1. **写し（状態・バージョン・価格）を先に読み、販売中のときだけ印を試す。印の持ち主だけが ledger と DB に進む。取り消しで印を比べて消す**
2. 印だけで絞る（ADR-0002 の形のまま）
3. 出品ごとの待ち行列で直列にする

## Decision

1 を採用する。手順と例は [transactions-and-state-machine.md](../architecture/transactions-and-state-machine.md) の 5 節。

- Valkey の `listing:{id}:snap`（状態、バージョン、価格）を読み、`on_sale` でなければ即座に 409。写しは outbox で 60 秒以内に直り、購入のコミットの後には `transactions` が直接書く（失ってよい）。
- `on_sale` なら `SET purchase:{id} <attempt_id> NX PX 15000`。取れなければ 409 `in_progress`。
- 印の持ち主だけが、売上金・ポイントの引き当て（ledger）と、DB の条件つきの更新に進む。
- 取引が `cancelled`・`payment_expired` になったら、コミットの後に印を「値が自分の試行の ID のときだけ消す」。取引の作成では消さない（ADR-0002 のとおり）。
- Valkey が使えないときは、写しと印を飛ばし、`transactions` のタスクの中の出品ごとのセマフォ（4。100ms 待てなければ 409 `busy`）を通す。購入のトランザクションは `lock_timeout` 200ms、`statement_timeout` 2 秒。
- 負けた試行は DB に行を書かない。同じ冪等キーの再送は、同じ判定をもう一度する。

### 他の案を選ばなかった理由

- **2**：売れた後の 15 秒、全員が印を試す。決済の失敗の後、12 秒ほど買えない。
- **3**：ADR-0002 で外した理由（平時の遅れ、負けの応答の遅さ）と同じ。

## Consequences

- 良くなること：
  - DB と ledger に届くのは、Valkey が生きている間は 1 出品 1 件だけになる。
  - 決済の失敗の後、すぐに 2 回目の取り合いに入れる。
- 引き受けるコスト：
  - 写しの古さ（最大 60 秒）の間、`trading` の出品を `on_sale` と読むことがある。そのときは印か DB で負けるだけで、正しさは変わらない。
  - 写しの古さで `on_sale` の出品を `trading` と読むと、買える出品に 409 を返す。購入の取り消しの後は `transactions` が写しを直接書くので、窓は短い。

## Confirmation

- 負荷試験：5,000 件/秒の 1 出品で、DB に届く購入が 1 件（Valkey あり）、48 件以下（Valkey なし、タスク 12）。二重の販売 0。負けの応答 p99 200ms（なしは 1 秒）。
- `hot-listing-purchase-poc` で、セマフォの値と `lock_timeout` を測って記録する。
- 性質ベーステスト PROP-TXN-001（Valkey の有無を切り替える）。

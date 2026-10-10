# Runbook: 売り越しの疑い・決済済みで注文なし・重複の注文

- Owner: Ops
- 対応するアラート: `inventory-mismatch`（在庫の照合の不一致。page、SEV1 の候補）、`payment-order-mismatch`（決済済みで注文も返金もない 15 分超。page、SEV2 から）、重複の注文の試み（SEV1 の候補）、CHECK の違反の急増（SEV2 の候補）
- 最終確認日: 2026-10-10

仕組みは [inventory-and-reservations.md](../architecture/inventory-and-reservations.md) の 10 節（照合 R1〜R4）、[cart-and-checkout.md](../architecture/cart-and-checkout.md) の 7・8 節（DT-CHK-001、照合の処理）、[payments-integration.md](../architecture/payments-integration.md) の 10 節（日次の突き合わせ P1〜P4）。正しさの見張りは [observability.md](../architecture/observability.md) の 5 節。

## 症状

- 在庫の照合：R1（不変条件 `on_hand = Σ(available + reserved + committed) + unavailable`）、R2（`Σcommitted` と未配送の注文の行）が合わない（page）。R3・R4 は ticket。
- 決済と注文：提供者で成功し、成功から 15 分を超えて `completed` でも `refunded` でもないチェックアウトがある。
- 同じチェックアウトから 2 つ目の注文の作成の試み（一意の制約で止まった数）が急に増えた。

## 影響

- 売り越し：事業者が持たない数を売る。謝罪と返金、信用の損失（NFR-004、K1）。
- 決済済みで注文なし：買い手が払ったのに注文がない（NFR-006、K2）。
- どちらも、エラーにならずに残る。早く止めるほど、影響の数が少ない。

## 確認

1. `reconcile_findings` で、ショップ・品目（またはチェックアウト）・数・理由のコードを見る。個人のデータは出ない。
2. 在庫：該当の品目の枠の行・拠点の行・`reservations`・`inventory_movements` を、照合の同じスナップショットの時刻で読む（break-glass ではなく、照合の作業のやり直しの機能で）。直近の変更（デプロイ、枠の直し・まとめ、移し替え、一括の調整）を確かめる。
3. 決済：該当の試行の `payment_attempts`・`payment_webhook_inbox`・`payment_inquiries`・`checkout_events` を見る。照合の処理（`checkout-reconciler`）が動いているか、提供者の照会の API が答えているかを確かめる。

## 対処

### 売り越しの疑い（R1・R2）

1. 該当の品目の販売を止める（`ops.inventory_item_sales_enabled`）。セールの品目なら受け入れを 0 にする（[flash-sale-operations.md](flash-sale-operations.md)）。
2. 同じポッドの他の品目にも出ているか（照合を全品目でやり直す）。複数なら、直近のデプロイを戻す（[deploy-and-rollback.md](deploy-and-rollback.md)）。
3. 実際に売り越したか（`committed` が `on_hand − unavailable` を超えたか）を数える。超えていれば SEV1 にし、事業者に知らせる（注文の取り消しは事業者の判断。本システムは候補の注文を示す）。
4. 原因が分かってから、調整の操作（理由 `reconciliation_fix`）で数を直す。手で表を書き換えない。直す作業は Ops と事業者の依頼の確認で行う（エージェントに任せない）。
5. 照合をやり直して 0 を確かめ、販売を開ける。

### 決済済みで注文なし

1. 照合の処理が止まっていれば、処理を戻す（ECS の `workers`、ポッドの照合の同時実行の上限 20 の詰まり）。
2. 提供者の照会の API の障害なら、照会の予定どおり続ける（誤って失敗にしない）。24 時間で別の page。
3. 照合の処理が `completeCheckout` を呼んでも閉じない行は、DT-CHK-001 のどの行に当たるかを確かめる。行 5・9（取り消しか返金）なら、返金の処理（`refund-worker`）の状態を見る。
4. 手で返金するのは最後の手段（Ops と事業者の依頼の確認）。同じ冪等キーを使い、別のキーで送り直さない。
5. 東京から大阪への切り替えの後なら、[disaster-recovery.md](disaster-recovery.md) の 7 の照合の手順に従う。

### 重複の注文の試みの急増

1. 一意の制約で止まっているので、二重の注文はない。経路（リダイレクトの戻り、Webhook、照合）の重なりが増えた原因を調べる（提供者の Webhook の再送の嵐、照合の間隔の誤り）。
2. 実際に 2 つの注文がある（一意の制約が効いていない）なら SEV1。ショップのチェックアウトを止め、Dev のテックリードを呼ぶ。

## エスカレーション

- 実際の売り越し・二重の注文：SEV1。IC、Dev のテックリード、PM、事業者。
- 提供者の側の不一致（日次の突き合わせの P2・P3）：提供者に問い合わせる。
- 金額の不一致（行 5）：セキュリティの事象として記録し、セキュリティの担当に知らせる。

## 事後

- 影響の数（売り越した数、返金した件数、閉じるまでの時間）を ID と数だけで記録する。
- 原因を `changes/` に起票し、性質ベーステストの生成器に場面を足す（[quality.md](../quality.md) の 2.2.1 節 A・B）。縮めたシードを回帰テストに残す。

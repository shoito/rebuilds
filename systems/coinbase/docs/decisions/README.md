# Decisions: Coinbase

Coinbase の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

0001〜0011 は最初の設計の起票で、どれも `proposed`（人の承認を待つ）。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、マッチングだけを Rust で EC2 に置く | proposed |
| [0002](0002-sequencer-and-event-journal.md) | 板ごとの sequencer が順序を決め、MSK の記録を板の正本にする | proposed |
| [0003](0003-matching-rules-and-self-trade-prevention.md) | 価格・時間の優先と自己約定の防止を engine-core にだけ書く | proposed |
| [0004](0004-order-entry-holds-and-idempotency.md) | 注文は sequencer の前に台帳で拘束し、client_order_id で冪等にする | proposed |
| [0005](0005-ledger-balances-and-trade-settlement.md) | 台帳を引き継ぎ、資産ごとの釣り合いと拘束と約定の記帳を足す | proposed |
| [0006](0006-wallet-tiers-and-cold-ratio.md) | ウォレットを 3 段にし、ネットワークにつながる額の上限を legal.* で持つ | proposed |
| [0007](0007-signing-service-and-key-custody.md) | 署名の方針を自前で持ち、鍵を別のアカウントの署名の境界に閉じる | proposed |
| [0008](0008-withdrawal-pipeline-and-approvals.md) | 出金をステートマシンにし、許可した宛先と額による承認だけで署名する | proposed |
| [0009](0009-deposits-confirmations-and-own-nodes.md) | 入金は自前のノード 2 台で確かめ、閾値の後に記帳する | proposed |
| [0010](0010-brokerage-quotes-and-inventory.md) | 販売所は板を通らない期限つきの提示にし、MVP ではヘッジしない | proposed |
| [0011](0011-external-providers-boundary.md) | 外部の提供者をアダプターの後ろに置き、障害の間は止める側に倒す | proposed |
<!-- adr-index:end -->

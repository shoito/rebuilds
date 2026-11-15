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
| [0012](0012-engine-io-encoding-and-ticks.md) | エンジンの入出力を固定の符号化にし、時刻を Tick で進める | proposed |
| [0013](0013-instrument-config-versioning.md) | 銘柄の設定をバージョンつきにし、sequencer の入力でだけ変える | proposed |
| [0014](0014-output-hash-chain-and-snapshots.md) | 出力の要約を SHA-256 の連鎖にし、スナップショットの点を seq で決める | proposed |
| [0015](0015-shadow-engine-failover.md) | 写しのエンジンを書き手の候補にし、持ち主の記録と fencing で替える | proposed |
| [0017](0017-order-row-states-across-clusters.md) | 注文の行を core に先に書き、拘束は ledger に冪等キーで書く | proposed |
| [0018](0018-cancel-idempotency-and-early-cancel.md) | 取り消しを冪等にし、注文より先に届いた取り消しを板で覚える | proposed |
| [0019](0019-account-trading-restrictions.md) | 口座の取引の制限を理由ごとの行で持ち、板の入力で止めを閉じる | proposed |
| [0020](0020-rate-limit-tiers-and-cancel-budget.md) | 速さの上限を 3 つの段の GCRA で持ち、取り消しを別に数える | proposed |
| [0021](0021-market-data-feed-and-book-seq.md) | 配信を出力の記録から作り、エンジンの book_seq で取りこぼしを見る | proposed |
| [0022](0022-candles-from-sequencer-time.md) | ローソク足を sequencer の時刻で作り、日の足を日本時間で切る | proposed |
| [0023](0023-daily-volume-publication.md) | 日々の売買高を約定の記録から作り、台帳と照合してから公表する | proposed |
| [0024](0024-brokerage-mid-price-and-spread.md) | 販売所の中の価格とスプレッドを bp の整数の式にし、止める条件を表にする | proposed |
| [0025](0025-brokerage-inventory-target-and-replenishment.md) | 販売所の在庫を目標と上限で持ち、MVP の補充は承認つきの受け入れにする | proposed |
| [0026](0026-brokerage-price-display.md) | 販売所の画面に買いと売りの価格とスプレッドを並べて示す | proposed |
| [0027](0027-fee-schedules-and-rounding.md) | 手数料はバージョンつきの表と ppm の整数で持ち、切り捨てる | proposed |
| [0028](0028-statements-and-annual-report-source.md) | 明細は仕訳の射影にし、年間の報告書の計算の方法を legal.* で持つ | proposed |
| [0029](0029-hold-kinds-and-withdrawal-restrictions.md) | 拘束に種類を足し、出金だけの制限を拘束と別の行で持つ | proposed |
| [0031](0031-point-in-time-reconciliation-with-in-flight.md) | 台帳とチェーンは同じ高さで比べ、途中の項目を一覧で説明する | proposed |
| [0032](0032-house-share-settlement.md) | 本システムの持ち分の精算は、不足の向きを 1 時間で、余りを毎日行う | proposed |
| [0033](0033-trust-amount-method-and-daily-top-up.md) | 信託すべき額は方式の型で持ち、毎営業日に不足だけを自動で依頼する | proposed |
| [0034](0034-cold-key-quorum-and-locations.md) | コールドの鍵を 3-of-5 に分け、3 か所に置く | proposed |
| [0035](0035-signing-policy-bundle-and-decision-table.md) | 署名の方針を決定表の束にし、2 人の承認の署名で出す | proposed |
| [0036](0036-approver-keys-and-approval-payload.md) | 承認者の鍵を専用の機器に置き、承認は取引の中身に署名する | proposed |
| [0037](0037-transfer-routes-and-warm-target.md) | 移し替えの経路を固定し、ウォームの目標を 2% に置く | proposed |
| [0039](0039-deposit-state-machine-and-withdrawal-lock.md) | 入金をステートマシンにし、出金に使える閾値まで口座の出金を止める | proposed |
| [0040](0040-deposit-address-issuance-and-verification.md) | 入金のアドレスを利用者ごとに固定し、境界の中で導き直して確かめる | proposed |
| [0041](0041-eth-deposit-detection-and-sweep.md) | ETH の入金を内部の送金まで見つけ、条件で集め直す | proposed |
| [0042](0042-withdrawal-transition-table.md) | 出金の遷移の決定表を確定し、取り消しと期限を足す | proposed |
| [0043](0043-one-transaction-per-withdrawal-and-fee-table.md) | 1 つの出金を 1 つの取引で送り、手数料は資産ごとの表にする | proposed |
| [0044](0044-stuck-transaction-replacement.md) | 詰まった取引は時間と回数を決めて置き換え、作り直しを確かめで縛る | proposed |
| [0045](0045-allowlist-registration-recorded-in-boundary.md) | 宛先の登録を署名の境界に記録し、待ち時間を境界で数える | proposed |
| [0046](0046-two-node-agreement-and-external-watch.md) | 2 台が一致する高さを合意の頭とし、外部と ID を比べる | proposed |
| [0047](0047-fee-estimation-and-broadcast-paths.md) | 手数料は 2 台の高いほうで見積もり、全ノードへ同じ取引を流す | proposed |
| [0048](0048-node-client-diversity-and-upgrades.md) | ETH の 2 組は違う種類のクライアントにし、1 台ずつ更新する | proposed |
| [0049](0049-virtual-accounts-and-name-matching.md) | 日本円の入金は利用者ごとの口座番号で受け、名義を正規化して照らす | proposed |
| [0050](0050-fiat-withdrawals-idempotency-and-inquiry.md) | 日本円の出金は依頼の番号で冪等にし、結果の不明は照会で決める | proposed |
| [0052](0052-account-lifecycle-levels-and-restrictions.md) | 口座の寿命・確認の水準・制限を分け、使える機能を 1 つの表で決める | proposed |
| [0053](0053-sign-in-step-up-cooldown-and-api-keys.md) | ログインはパスキー第一、認証の変更の後 72 時間は出金を止める | proposed |
| [0054](0054-kyc-vault-purpose-api-and-retention.md) | kyc-vault は目的の関数だけで読み、画像を持たず、期限で鍵を破棄する | proposed |
| [0055](0055-screening-rule-table-and-human-reject.md) | スクリーニングは規則の表で判定し、拒むのは人だけにする | proposed |
| [0056](0056-sanctions-name-matching-inside-vault.md) | 制裁の名前の照合を金庫の中で行い、一覧の更新ごとに全件を照らす | proposed |
| [0057](0057-travel-rule-notification-and-receipt.md) | トラベルルールは署名の前に通知し、受け取りは入金に結び付ける | proposed |
| [0058](0058-transaction-monitoring-and-str-cases.md) | 取引の監視は宣言の規則で警告を出し、届出は 2 人で承認する | proposed |
| [0059](0059-surveillance-detectors-over-journals.md) | 監視の検出器を記録の上の決定的な関数にし、閾値を承認つきの表に置く | proposed |
| [0060](0060-surveillance-cases-actions-and-records.md) | 兆しを案件にまとめ、措置は提案者と別の責任者が承認する | proposed |
| [0061](0061-staff-trading-and-material-information.md) | 役職員の取引を登録した口座に限り、重要な情報の台帳で止める | proposed |
| [0062](0062-legal-config-catalog-and-approval.md) | legal.* の値をカタログで持ち、承認の記録なしに本番で効かせない | proposed |
| [0063](0063-regulatory-regime-switch.md) | 法令の型を legal.regime で持ち、用語・報告・規律を表で切り替える | proposed |
| [0064](0064-regulatory-report-exports.md) | 報告は基準の時刻から作り直せる書き出しにし、提出は人が行う | proposed |
| [0065](0065-operator-access-and-cs-view-scope.md) | CS の画面は伏せた項目だけを出し、金庫を見る操作を分ける | proposed |
| [0066](0066-automatic-withdrawal-tripwires.md) | 侵害の兆しで出金を自動で止め、開けるのは 2 人にする | proposed |
| [0068](0068-correctness-monitors-and-independent-watch.md) | 正しさの見張りを別のアカウントの独立の経路で持つ | proposed |
| [0069](0069-telemetry-schema-without-secrets.md) | 秘密と個人のデータを含まない計測の型を 1 か所で決める | proposed |
| [0070](0070-trading-path-provisioned-for-peak.md) | 取引の経路は急変の最大を常設で持ち、自動の拡大に頼らない | proposed |
| [0071](0071-aws-accounts-network-and-egress.md) | アカウントを用途と鍵の境界で分け、外への経路を 3 つに分ける | proposed |
| [0072](0072-matching-placement-across-azs.md) | 板の本番と写しを AZ に分け、板ごとに本番の AZ を互い違いにする | proposed |
| [0073](0073-osaka-dr-and-market-restart.md) | 大阪で入力の記録を追い続け、再生の終わりを正として板を再開する | proposed |
| [0074](0074-engine-swap-in-planned-halt-window.md) | エンジンを写しで先に確かめ、予定した板の停止の時間に入れ替える | proposed |
| [0075](0075-signed-config-bundles-for-policies-and-rules.md) | 方針と規則の表を、承認者が署名した設定の束として出す | proposed |
<!-- adr-index:end -->

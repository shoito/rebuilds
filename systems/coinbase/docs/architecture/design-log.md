# Design log: Coinbase

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。どれも `proposed` の ADR に基づく草案で、ロールの持ち主（Dev・PM・QA・Ops・法務）の承認を待つ。

## 2026-11-15：既定案

最初の設計（工程 1）で、判断が要るところは推奨の既定案で進め、次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。

- **板の順序**：板ごとに 1 つの sequencer が入力に `seq` と時刻を付け、Amazon MSK に書けてから受け付ける。エンジンは記録から作り直せる決定的な写しで、写しのエンジンの要約で決定性を常に確かめる（[ADR-0002](../decisions/0002-sequencer-and-event-journal.md)）。
- **約定の規則**：価格・時間の優先、板の注文の価格での約定。自己約定の防止の既定は本家の `dc` でなく `cancel_newest`（[ADR-0003](../decisions/0003-matching-rules-and-self-trade-prevention.md)）。
- **注文の拘束**：sequencer の前に台帳で拘束を書き、`client_order_id` で冪等にする（[ADR-0004](../decisions/0004-order-entry-holds-and-idempotency.md)）。
- **台帳**：Stripe とメルカリの複式簿記を引き継ぎ、資産ごとの釣り合いと約定ごとに 1 回の記帳を足す。手数料は受け取る資産から引く（[ADR-0005](../decisions/0005-ledger-balances-and-trade-settlement.md)）。
- **ウォレット**：ホット・ウォーム・コールドの 3 段。ホットの自動の署名は利用者の暗号資産の 1% まで。ネットワークにつながる額の上限は `legal.hot_ratio_max`（[ADR-0006](../decisions/0006-wallet-tiers-and-cold-ratio.md)）。
- **署名**：方針と依頼の流れは自前、鍵は別のアカウントの署名の境界に閉じ、境界の中で方針と承認を確かめ直す（[ADR-0007](../decisions/0007-signing-service-and-key-custody.md)）。
- **出金**：ステートマシン、許可の一覧の宛先だけ（待ち 24 時間。P4）、額による承認の段、結果が分からない取引は作り直さない（[ADR-0008](../decisions/0008-withdrawal-pipeline-and-approvals.md)）。
- **入金**：自前のノード 2 台で確かめ、BTC は 3 承認で記帳・6 承認で出金に使える、ETH は確定で記帳（[ADR-0009](../decisions/0009-deposits-confirmations-and-own-nodes.md)）。
- **販売所**：板を通らない期限つきの提示、受け入れは 1 つのトランザクション、MVP はヘッジしない（[ADR-0010](../decisions/0010-brokerage-quotes-and-inventory.md)）。
- **提供者**：eKYC・銀行・チェーン分析・トラベルルール・参照の価格はアダプターの後ろ。障害の間は止める側に倒す（[ADR-0011](../decisions/0011-external-providers-boundary.md)）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。

## 2026-11-15：統合

領域の文書（工程 2、21 本、ADR-0012〜0075）の間の食い違いを、統合の工程で次のとおり解いた。既存の ADR は、決定を変えるところに `2026-11-15 の注記（統合）` を足した（ADR-0047 は注記に合わせて本文も直した）。どれも Dev（テックリード）か PM の承認を待つ。

- **入金の成熟の前の出金の止め**（D1。[ADR-0029](../decisions/0029-hold-kinds-and-withdrawal-restrictions.md)・[ADR-0009](../decisions/0009-deposits-confirmations-and-own-nodes.md)・[ADR-0050](../decisions/0050-fiat-withdrawals-idempotency-and-inquiry.md) の注記）：BTC の 6 承認の前は、[ADR-0039](../decisions/0039-deposit-state-machine-and-withdrawal-lock.md) のとおり口座の全部の出金（暗号資産と日本円）を `held` の前で待たせる。`withdrawal_restrictions` に `scope`（`account`・`asset`）を足し、`deposit_maturity` は `scope = account` の 1 行にした。ADR-0050 の円換算を引く式はやめた。売った日本円や、その日本円で買った ETH での持ち出しも閉じる。[ledger-and-balances.md](ledger-and-balances.md)・[fiat-and-banking.md](fiat-and-banking.md)・[withdrawals.md](withdrawals.md)・[deposits.md](deposits.md) を合わせた。
- **拘束に手数料の上限を足さない**（D2。[ADR-0004](../decisions/0004-order-entry-holds-and-idempotency.md)・[ADR-0005](../decisions/0005-ledger-balances-and-trade-settlement.md)・[ADR-0027](../decisions/0027-fee-schedules-and-rounding.md) の注記）：手数料は買い手は受け取る暗号資産、売り手は受け取る日本円から引くので、買いの拘束は `floor(価格 × 数量)` だけにした。成行の金額の指定は指定の金額の全部をエンジンの代金の上限にする。PROP-LED-003 は「0 ≤ 手数料 ≤ 受け取る額」に改めた。README・order-entry-and-risk・ledger-and-balances・matching-engine・infrastructure・observability の例の数字を直した。
- **認証の変更の後の 72 時間**（D3。[ADR-0008](../decisions/0008-withdrawal-pipeline-and-approvals.md) の注記、[ADR-0045](../decisions/0045-allowlist-registration-recorded-in-boundary.md)）：パスワードは持たないので、契機は [ADR-0053](../decisions/0053-sign-in-step-up-cooldown-and-api-keys.md) のパスキーの追加・TOTP の再設定・メール・電話番号の変更・回復にした。
- **ノードの遅れ**（D4）：食い違いではない。2 ブロック・1 エポックは SLO（目標）、3 ブロック・2 エポックは記帳を止める閾値（ADR-0009 の注記、[chain-nodes-and-confirmations.md](chain-nodes-and-confirmations.md) の 2 節）。
- **放送の経路**（D5。[ADR-0047](../decisions/0047-fee-estimation-and-broadcast-paths.md) の注記と本文、ADR-0009 の注記）：署名の境界はノードへの経路を持たない（[ADR-0071](../decisions/0071-aws-accounts-network-and-egress.md)）。侵害の時にコールドへ逃がす取引も境界の中で署名して普段の出力の経路で渡し、`wallet-orchestrator` が流す。README の 1.2 節の図から境界 → ノードの線を外した。
- **ウォレットの間の移し替えの承認**（D6。[ADR-0037](../decisions/0037-transfer-routes-and-warm-target.md) の注記、題材の [AGENTS.md](../../AGENTS.md)）：コールドへ入る移し替え（目標を超えた分）は自動、ウォームとコールドから出る移し替えは 2 人以上の承認、と書き分けた。
- **出金の遷移**（D7。ADR-0008 の注記）：遷移の全部は [ADR-0042](../decisions/0042-withdrawal-transition-table.md) の DT-WD を正とする。
- **NFR-008 の除外**（D8）：「承認とコンプライアンスの待ちを除く」に揃えた（README の 3 節、withdrawals、custody-and-keys）。
- **拘束の照合**（D9）：NFR-004 を `source_type` ごとの比べで書き直し、販売所の受け入れの項を外した（1 つのトランザクションで記帳し、拘束を残さない。ADR-0010）。intent の同じ記述は intent の持ち主が直す。
- **手数料の見積もりの持ち主**（D10）：ノードからの見積もりは chain-nodes-and-confirmations、利用者の出金の手数料の表と引き上げの判断は withdrawals（README の 7 節）。
- **税の書類**（D11）：利用者への年間の報告書は ledger-and-balances、税務署への提出は regulatory-compliance-japan（README の 7 節）。
- **`kyc-vault` の中身**（D12。AGENTS.md）：公的個人認証の確かめの結果を置き、個人番号は受け取らない（集めるかは法務の L10）。
- **本番の見張り**（D13）：取引の見張りは注文と取り消しだけで約定させない（仮装売買の形を避ける。法務の L7）。入出金の見張りは本番で最小の額を本システムの見張りのウォレットとの間で動かす（PM の判断待ち P13）。[observability.md](observability.md) の 4.5 節を既定の案にした。quality.md は quality の持ち主が直す。
- **口座の制限の表**（D14。[ADR-0019](../decisions/0019-account-trading-restrictions.md) の注記）：`account_restrictions` は kyc-and-accounts の 1 つの表（[ADR-0052](../decisions/0052-account-lifecycle-levels-and-restrictions.md) の列の形）にし、取引の理由（`kyc_incomplete` など）は `reason_code` の値として足す。理由ごとの扱いは理由の表 `restriction_reasons` で持つ。
- **販売所の 2 つの規則**（D15。[ADR-0010](../decisions/0010-brokerage-quotes-and-inventory.md) の注記）：1% の比べは提示の時の中の価格と受け入れの時の中の価格（[ADR-0024](../decisions/0024-brokerage-mid-price-and-spread.md) と同じ）。スプレッドを広げるのは在庫の偏りを増やす向き（brokerage-quotes の式と同じ）。
- **注文の行の正本**（D16）：README の 1.3 節 A の 2 を、core の `orders` が正本、ledger は拘束の行と仕訳を冪等キーで書く、に直した（[ADR-0017](../decisions/0017-order-row-states-across-clusters.md)）。
- **持ち主の記録の更新の失敗**（D17。[ADR-0072](../decisions/0072-matching-placement-across-azs.md) の注記）：[ADR-0002](../decisions/0002-sequencer-and-event-journal.md) の fencing と食い違わない。板ごとに 1 つの `transactional.id`、新しい持ち主は fencing の後に記録の末尾を読む、commit の後に受け付けを返す、の 3 つで、更新に失敗した古い持ち主が書き続けても入力は失われず重ならない。fail closed にはしない。「2 つ目の書き手は生まれない」は言い過ぎなので注記で直した。
- **費用の幅**（D18）：README の 2.1 節の約 8 万 USD（±50%）は残し、[capacity.md](capacity.md) の内訳の和 約 5.5 万 USD との差は未検証の項目で、`cost-baseline` で確かめると書いた。
- **手順の名前**（D19）：`order-intake-degraded` は `order-entry-degraded`、`market-data-lag` は `market-data-degraded`、`signing-policy-release` は `signing-policy-rollout` に揃えた。
- **署名の方針の切り替え**（[ADR-0035](../decisions/0035-signing-policy-bundle-and-decision-table.md) の注記）：「切り替えの間は 2 つの束を最大 1 時間有効にしてよい」をやめ、[delivery.md](delivery.md) の 4.9 節（自動の署名を止め、手続き中の依頼を待ってから切り替え、猶予を持たない）に揃えた。値を緩める変更の 24 時間の待ちは変えない。
- **ネットワークにつながる額の分子**（[ADR-0006](../decisions/0006-wallet-tiers-and-cold-ratio.md) の注記）：ホット ＋ ウォーム ＋ 集め直しの前の ETH の入金のアドレスの残高にした（入金のアドレスの鍵はオンライン）。[custody-and-keys.md](custody-and-keys.md) の 4 節を合わせた。
- **ETH の集め直しの手数料**（ADR-0009 の注記）：ETH 本体はアドレス自身の残高から払う。本システムが手数料を送るのはトークンを扱うときだけ（[ADR-0041](../decisions/0041-eth-deposit-detection-and-sweep.md)）。
- **名前の揃え**：
  - 入金の仕訳の型：deposits の `deposit_credit` を、ledger-and-balances の `crypto_deposit` に揃えた。
  - `legal.*` の鍵：`legal.daily_volume_publication` を ADR-0023 の `legal.daily_volume_definition` に揃え、領域の文書が足した `legal.kyc_record_fields`・`legal.kyc_reverify_on_method_sunset`・`legal.travel_rule_threshold_jpy`・`legal.travel_rule_self_hosted_proof`・`legal.brokerage_display`・`legal.cost_basis_method` を [regulatory-compliance-japan.md](regulatory-compliance-japan.md) の 4.2 節のカタログに足した。
  - 法務と PM の番号：領域の文書の仮の番号を intent の番号にした（法務の L15〜L19、PM の P5〜P14）。
  - Story の Epic：`order-load-generator` を roadmap に合わせて E9 に置いた（capacity）。
- **本家との意図した違い**（README の 1.4 節）：取引所の置き場所、エンジンの冗長、板の全部の差分の配信、個人の宛先の許可の一覧と待ち時間、手数料の段、手数料を取る資産の行を足した。
- **事実の確かめ**：板と約定の優先・約定の価格・自己約定の防止・注文の状態、配信の通し番号、`level2` と `level2_batch`、置き場所と配備、INTX の帳簿の 24 時間を、公式の資料で読み直して確かめた（2026-11-15）。報道だけの項目（2026 年 5 月の停止、2025 年の漏えい）と個人向けの許可の一覧は**未検証**のままにした。

残したもの（次の工程で決める）：

- 口座の制限の理由のコードの名前（`takeover_suspected` と `takeover_lock`、取引の `frozen` と `sanctions_match`・`legal_order`）を 1 つの一覧にそろえる（データモデルの工程）。
- 署名の方針の宛先の種類 `house_hot`・`house_warm`・`house_cold`（利用者用のウォレットの段）と `house_wallet`（本システムの財産）の名前の取り違えやすさ（ADR-0035 の注記。データモデルの工程）。
- 入金のアドレスの残高を台帳で `wallet:hot:ETH` の中に持つか、別の口座にするか（[deposits.md](deposits.md) の 14 節。ledger-and-balances の領域）。

## 2026-11-15：データモデル

工程 4 で、領域の文書（21 本）の data-model の項目と ADR から、[data-model.md](data-model.md) と [data-model/](data-model/) の 14 のファイル（Aurora の 125 表、署名の境界の記録 6、`watch` の DynamoDB 2）を書いた。統合の工程の結論（D1・D2・D9・D14 など）をそのまま形にし、統合で残した名前を次のとおり揃えた。どれも Dev（テックリード）の承認を待つ。領域の文書と ADR の本文は持ち主が直す（data-model.md の 10 節の G1〜G14）。

- **口座の制限の理由**（統合の残り。N1）：[accounts-and-kyc.md](data-model/accounts-and-kyc.md) の `restriction_reasons` を 1 つの一覧にした。`takeover_suspected` は `takeover_lock` に揃え、ADR-0019 の `frozen` は `kind = frozen` の `sanctions_match`・`legal_order`・`deceased` に分けた。`kyc_incomplete` と `closing` は制限の行にせず、寿命の状態で表す。`trading_suspended` は残し、DT-KYC-001 の `restricted` の行との違い（売りも止め、板の注文を取り消す）を理由の表の列で持つ。
- **署名の方針の宛先の種類**（統合の残り。N2）：データモデルでは `tier_hot`・`tier_warm`・`tier_cold` と `house_wallet`。`wallets` の持ち主の列は台帳と同じ `property_class`（`user`・`house`）。
- **名前**：`account_id` は利用者の口座、台帳の口座は `ledger_account_id`（N3）。板は `btc_jpy`（N4）。自己約定の組は `self_trade_group_id`（N8）。AML の案件の事象は `compliance_case_events`（N9）。
- **手数料の表は 1 つ**（N5）：`withdrawal_fee_tables` を `fee_schedules`（core、`crypto_withdrawal`）にまとめ、最小の出金の額を `min_amount` にした。
- **仕訳の型**（N6）：`deposit_reversal_hold` は `hold`（`source_type = reorg`）。`fiat_withdrawal_return` を型の一覧に入れた。
- **残高の行を 2 つに分けた**（N7）：利用者の `balances` と、照合と在庫のための `ledger_balances`。`fee_revenue:*` は約定ごとに更新しない（capacity の行の数を変えない）。
- **冪等キーの表**：`journals` の月の分割と全期間の一意を両立させるため、分割しない `idempotency_keys` を ledger に置いた（ADR-0001 の ledger の「冪等キー」）。同じ理由で `orders` は S1 では分割しない。
- **出金の制限は 1 つの表**（N10）：`withdrawal_restrictions` の `scope`、`deposit_maturity` は `scope = account`（D1 のまま）。口座の制限・出金の待ちとは別の表。
- **見つけた食い違い**：精算の `to_user`（本システムのウォレット → 利用者用のホット。ADR-0032）を ADR-0037 と DT-POL が許さない（G1）。データモデルはこの経路を持たず、custody-and-keys と segregation-and-reconciliation の持ち主に委ねた。

残したもの：署名の境界の記録の器、`kyc-vault` の人ごとの鍵の表、日本円の出金の `returned` の仕訳の型、販売所の提示の量、`orders` の分け方、入金のアドレスの残高の台帳での置き方（[data-model.md](data-model.md) の 9 節）。

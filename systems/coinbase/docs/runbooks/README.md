# Runbooks: Coinbase

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節にある。SLI の計測とアラートの条件の実装は [observability.md](../architecture/observability.md) にある。**SLO の値とアラートの一覧の正本はこの文書** で、値を変えるときは、この文書を先に変える。

この題材は、利用者の資産を預かり、取引させる。止まれば、利用者は売り買いも出し入れもできない。しかし、方針の外の署名、二重の出金、不公正な約定、台帳とチェーンの食い違いは、止まるより悪い。**迷ったら止める**（板は `halted`、出金は `ops.withdrawals_enabled.<asset>` を切る）。止めるのは当番が一人でできる。開けるのは 2 人の承認を要する。

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| 取引所の可用性 | 注文・取り消しの要求のうち、5xx・時間切れでないもの（残高の不足・価格の帯の外・板の停止の 4xx は除く）（NLB、`trading-api`） | **月間 99.95%**（NFR-010） | 1 時間のバーンレート 14.4 倍・6 時間で 6 倍で呼び出し、3 日で 1 倍でチケット。エラーバジェットを使い切ったら、修正以外のデプロイを止める | |
| 注文の受け付けの速さ | 注文の受け付けが 20ms 以内（`trading-api` の受信から受け付けの応答まで） | **p99 20ms**（NFR-001） | p99 が 100ms を 5 分超えたら呼び出し | |
| 板の配信の速さ | 入力の記録への書き込みから配信の送り出しまで 50ms 以内 | **p99 50ms**（NFR-002） | p99 が 500ms を 5 分超えたら呼び出し | |
| 販売所の可用性 | 提示と受け入れの要求のうち、5xx・時間切れでないもの（参照の価格の不一致で提示を止めた時間は別に数える） | **月間 99.95%**（NFR-010） | バーンレート | |
| 入出金の受け付けの可用性 | 入出金の依頼の要求のうち、5xx・時間切れでないもの | **月間 99.9%**（NFR-010） | バーンレート | |
| エンジンの決定性 | 写しのエンジンとの要約の一致（入力ごと）。日次の全部の再生の一致 | **食い違い 0**（NFR-003、K3） | 1 件で呼び出し（SEV1 の候補）。両方の板を止める | ○ |
| 入力の番号 | エンジンが処理した `seq` の連続（抜け・重なり・古い epoch） | **0**（NFR-013） | 1 件でエンジンが板を止め、呼び出し | ○ |
| 使える残高 | 負の `available` | **0**（NFR-004、K2） | 1 件で呼び出し（SEV1 の候補）。その口座の注文と出金を止める | ○ |
| 拘束と注文 | 拘束の和と必要額の和の照合の不一致（5 分ごと） | **0**（NFR-004） | 1 件でチケット、10 件で呼び出し | ○ |
| 約定の記帳 | 約定から記帳まで 1 秒以内。重複 0、1 分を超える欠け 0 | **p99 1 秒**（NFR-005） | 重複は 1 件で呼び出し（SEV1 の候補）。欠けは 1 件でチケット、p99 が 10 秒を超えたら呼び出し | ○ |
| 台帳とウォレット | 台帳とチェーンの残高の説明のつかない差（ホット・ウォームは 1 時間ごと、コールドは毎日） | **0**（NFR-006、K4） | 暗号資産の説明のつかない減りは 1 件で呼び出し（SEV1 の候補）。増えは翌営業日までにチケット | ○ |
| 台帳と銀行・信託 | 翌営業日を過ぎた説明のつかない差 | **0 円**（NFR-006） | 1 件でチケット（財務） | ○ |
| ネットワークにつながる額 | 割合が `legal.hot_ratio_max` 以下の時間（10 分ごと） | **超え 0 分**（NFR-007） | 超えたら呼び出し。移し替え以外のホットとウォームの署名を止める | ○ |
| 方針の外の署名 | 署名の境界の拒否のうち、オンラインの側が通した依頼（2 か所の判定の食い違い） | **0**（NFR-014） | 1 件で呼び出し（SEV1）。[hot-wallet-compromise.md](hot-wallet-compromise.md) | ○ |
| 出金の速さ | ホットで払える出金の依頼から放送まで 30 分以内（承認とコンプライアンスの待ちを除く） | **p95 30 分**（NFR-008、K10） | p95 が 2 時間を超えたらチケット | |
| 入金の反映 | 閾値に届いてから記帳まで 5 分以内 | **p95 5 分**（NFR-009） | p95 が 30 分を超えたらチケット。記帳の停止は 15 分で呼び出し | |
| ノードの遅れ | 自前のノードの頭と外部の見張りの差 | **BTC 2 ブロック、ETH 1 エポック以内**（目標） | 超えたらチケット。BTC 3 ブロック・ETH 2 エポック以上の遅れは、目標の外ではなく入金の記帳を止める閾値で（[ADR-0009](../decisions/0009-deposits-confirmations-and-own-nodes.md)）、止めたら呼び出し（[chain-reorg.md](chain-reorg.md)） | |
| 正しさの見張りの心拍 | ○の SLI ごとの `watch` への心拍の途絶（[ADR-0068](../decisions/0068-correctness-monitors-and-independent-watch.md)） | **確かめられていない時間 0 分** | 5 分届かなければ `watch` が呼び出し（SEV2）。その SLI を緑として扱わない（[watch-heartbeat-lost.md](watch-heartbeat-lost.md)） | ○ |
| 写しのエンジンの欠け | 切り替えの後、写しのない板の時間（[ADR-0072](../decisions/0072-matching-placement-across-azs.md)） | **15 分以内** | 15 分を超えたらチケット。60 分で IC が取り消しだけにするかを判断（[engine-failover.md](engine-failover.md)） | |
| 大阪への写しの遅れ | 東京の入力の最後の `seq` と `match-osaka-1` が追った `seq` の差（時間）（[ADR-0073](../decisions/0073-osaka-dr-and-market-restart.md)） | **1 秒**（目標） | 10 秒を 5 分超えたら呼び出し（[disaster-recovery.md](disaster-recovery.md)） | |
| 時計のずれ | マッチングの EC2 の Time Sync との差（chrony）（ADR-0072） | **1ms 以内** | 1ms を超えたらチケット、100ms を超えたら呼び出し、その板の sequencer を待機へ移す（[clock-drift.md](clock-drift.md)） | |

- SLO の窓は 30 日の移動の窓（報告は暦の月）。エラーバジェットを使い切ったら、信頼性の作業を機能より先にする。デプロイの前に残りを確かめる。
- **数えないもの**：残高の不足、価格の帯の外、板の停止の間の拒否、速さの上限の 429、ボットとして拒んだ要求、予定した板の停止の時間。ただし率の急な上がりは、本システムの食い違いの兆候として見る。見張りの口座は SLO の計算から除き、別に見る。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う（[quality.md](../quality.md) の 4.1 節）。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は、板の再開まで RTO 5 分（写しのエンジン）。リージョンの障害は、板を止めてから大阪で再開する RTO 4 時間、台帳の RPO 1 分（NFR-011）。
- 本家のサービスの SLA は、公式の資料で確かめなかった（**未検証**）。
- 「出金の速さ」の除外（承認とコンプライアンスの待ち）は、[architecture/README.md](../architecture/README.md) の NFR-008 と同じ定義にする。

### 1.1 SLI の候補

工程 2 の領域の文書が足した候補。値は本システムの値で、Story の spec で計測の場所と合わせて確かめてから上の表へ移す。

| SLI の候補 | 目標 | 外れたときの扱い（案） | 出典 |
| --- | --- | --- | --- |
| 出金の止めの待ち（BTC の 3〜6 承認の間） | p95 60 分 | チケット | [deposits.md](../architecture/deposits.md) |
| 合意の頭の遅れ（ブロックの到着から 2 台の合意まで） | 30 秒 | チケット | [chain-nodes-and-confirmations.md](../architecture/chain-nodes-and-confirmations.md) |
| ノードのディスクの使用率 | 値は `node-ops-poc` で決める | チケット（[node-upgrade.md](node-upgrade.md) の計画作業へ） | 同上 |
| `compliance_review` の待ち | 営業時間の 4 時間（PM の判断待ち） | 超えた件数でチケット | [aml-and-travel-rule.md](../architecture/aml-and-travel-rule.md) |
| スクリーニングの判定の速さ | p95 10 秒 | チケット。提供者の障害なら [provider-outage.md](provider-outage.md) | 同上 |
| `waiting_funds` の滞留、`approving` の 3 営業日の期限切れ | 滞留の時間、件数 0 | チケット（[hot-ratio-breach.md](hot-ratio-breach.md)、[cold-ceremony.md](cold-ceremony.md)） | [withdrawals.md](../architecture/withdrawals.md) |
| 口座の制限の反映 | p99 5 秒 | 呼び出し（制限の後に注文・出金が通りうる） | [kyc-and-accounts.md](../architecture/kyc-and-accounts.md) |
| 本人確認の結果から水準の反映まで | p95 10 秒 | チケット | 同上 |
| 不公正取引の兆しの遅れ | p95 5 分 | チケット | [market-surveillance.md](../architecture/market-surveillance.md) |
| 監視の日次の再生の見落とし | 0 | 1 件でチケット（コンプライアンス） | 同上 |
| 自動の停止（tripwire）の兆しから止まるまで | 30 秒 | 超えたら呼び出し | [security.md](../architecture/security.md) |
| CS の参照の上限に当たった件数、監査の写しの遅れ | 件数、遅れ | チケット（セキュリティ） | 同上 |
| 写しのエンジンの遅れ（書き手の `InputDigest` から写しの計算まで） | p99 100ms | 5 秒を超えたらチケット | [ADR-0015](../decisions/0015-shadow-engine-failover.md) |

## 2. 上限と容量のパラメーター

値の正本は、各 ADR と、工程 2 の領域の文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 価格の帯 | 指値は参照の価格の上下 10%、成行は 5%。1 分で 15% 動いたら取り消しだけ | [ADR-0003](../decisions/0003-matching-rules-and-self-trade-prevention.md) | — （銘柄の設定。sequencer を通す変更で、Dev と Ops の 2 人の承認） |
| 再開の取り消しだけの時間 | 5 分 | 同上 | 伸ばすだけ |
| 送り直しと取り消し | `pending_submit` 10 秒で送り直し、60 秒で取り消し | [ADR-0004](../decisions/0004-order-entry-holds-and-idempotency.md) | — |
| スナップショット | 10 万入力ごと、停止のたび | [ADR-0002](../decisions/0002-sequencer-and-event-journal.md) | — |
| ホットの目標と累計 | 利用者の暗号資産の 1%。自動の署名の 24 時間の累計はホットの目標の 50% | [ADR-0006](../decisions/0006-wallet-tiers-and-cold-ratio.md)、[ADR-0007](../decisions/0007-signing-service-and-key-custody.md) | — （署名の方針。セキュリティと財務の 2 人の承認） |
| ネットワークにつながる額の上限 | `legal.hot_ratio_max`（本番は法務の L2 の後に有効） | [ADR-0006](../decisions/0006-wallet-tiers-and-cold-ratio.md) | — （`legal.*`。法務・財務の承認） |
| 出金の承認の段 | 100 万円まで自動、1,000 万円まで 1 人、超えて 2 人 | [ADR-0008](../decisions/0008-withdrawal-pipeline-and-approvals.md) | — （署名の方針） |
| 宛先の待ち時間 | 24 時間（PM の判断待ち P4）。認証の情報の変更の後 72 時間は出金を受けない | 同上 | — |
| 入金の閾値 | BTC 3 承認で記帳・6 承認で出金に使える。ETH は確定 | [ADR-0009](../decisions/0009-deposits-confirmations-and-own-nodes.md) | — （資産の設定。Dev・セキュリティの承認） |
| 販売所の提示 | 期限 10 秒。中の価格の 2 つの差 2% で止める。受け入れの時の差 1% で拒む | [ADR-0010](../decisions/0010-brokerage-quotes-and-inventory.md) | スプレッドの基本の幅（広げるだけ） |
| 販売所のスプレッドと在庫 | 基本の幅 BTC 100 bp・ETH 150 bp、上限 500 bp。在庫の目標 BTC 5 億円・ETH 2 億円、上限はその 2 倍。評価の損失 24 時間で 3,000 万円で全部の提示を止める | [ADR-0024](../decisions/0024-brokerage-mid-price-and-spread.md)、[ADR-0025](../decisions/0025-brokerage-inventory-target-and-replenishment.md) | 基本の幅（広げるだけ）。在庫の補充と処分は [brokerage-inventory-replenish.md](brokerage-inventory-replenish.md) |
| 速さの上限 | `app` 注文 5/秒（瞬間 10）、`api_standard` 15/秒（30）、`api_mm` 200/秒（400。PM の P1 まで使わない）。板ごとの新しい注文の全体 5,000 件/秒。取り消しは全体の上限にかけない | [ADR-0020](../decisions/0020-rate-limit-tiers-and-cancel-budget.md) | 期限つきの一時の引き上げ（Ops と PM の 2 人の承認。[rate-limit-override.md](rate-limit-override.md)） |
| 1 注文の最大の数量 | BTC 100、ETH 1,000 | [ADR-0013](../decisions/0013-instrument-config-versioning.md) | — （銘柄の設定） |
| 写しのエンジン | 持ち主の記録の期限 5 秒（更新 1 秒）。切り替えの後の写しの回復 15 分 | [ADR-0015](../decisions/0015-shadow-engine-failover.md)、[ADR-0072](../decisions/0072-matching-placement-across-azs.md) | — |
| ウォームの目標 | 利用者の暗号資産の 2%。最小の移し替えは目標の 10% | [ADR-0037](../decisions/0037-transfer-routes-and-warm-target.md) | — （署名の方針） |
| 口座の自動の署名の累計 | 24 時間で 300 万円。超えた依頼は承認に回る | [custody-and-keys.md](../architecture/custody-and-keys.md) の 6.2 節 | — （署名の方針） |
| 承認の期限、緩める変更の待ち | 承認は 30 分（求めてから 3 営業日で `rejected`）。方針を緩める変更は 24 時間後に有効 | [ADR-0036](../decisions/0036-approver-keys-and-approval-payload.md)、[ADR-0035](../decisions/0035-signing-policy-bundle-and-decision-table.md)、[ADR-0042](../decisions/0042-withdrawal-transition-table.md) | — |
| 出金の置き換えと手続き中の数 | 詰まりの判定 BTC 6 ブロック・ETH 25 ブロック、置き換え 5 回まで。1 口座の手続き中の出金は資産ごとに 10 件 | [ADR-0044](../decisions/0044-stuck-transaction-replacement.md)、[withdrawals.md](../architecture/withdrawals.md) | — |
| CS の参照 | 担当者ごとに 1 日 80 口座、1 時間 30 件で知らせ | [ADR-0065](../decisions/0065-operator-access-and-cs-view-scope.md) | — （実績で見直す） |
| 本システムの持ち分の精算 | 利用者の財産の不足の向きは 1 時間ごと、累計が円換算 1,000 万円で即時。余りの向きは毎日 | [ADR-0032](../decisions/0032-house-share-settlement.md) | — （法務の L2・L3 の後に見直す） |
| 板の取引 | — | — | `ops.trading_enabled.<pair>`（止めるだけ。止めると板は `halted`） |
| 販売所 | — | — | `ops.brokerage_enabled.<asset>`（止めるだけ） |
| 暗号資産の出金 | — | — | `ops.withdrawals_enabled.<asset>`（止めるだけ。`signing` の前の出金を止める） |
| 暗号資産の入金の記帳 | — | — | `ops.deposit_crediting_enabled.<asset>`（止めるだけ。検出と追跡は続ける） |
| 日本円の出金 | — | — | `ops.fiat_withdrawals_enabled`（止めるだけ） |
| ホットの自動の署名 | — | — | `ops.hot_auto_signing_enabled.<asset>`（止めるだけ。止めると全部の出金が承認に回る） |
| 口座の回復の自動の受け付け | — | — | `ops.account_recovery_auto_enabled`（止めるだけ。止めると回復を人の確かめに回す。[kyc-and-accounts.md](../architecture/kyc-and-accounts.md)） |

- `ops.*` を開ける（止めたものを戻す）操作は、作成者と別の 2 人の承認を要する（AGENTS.md）。

## 3. リリースとロールバック

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。未完成の振る舞いは `release.*` のフラグの裏に置く。`release.*` は 100% の後 30 日で消す。
- **約定の規則・仕訳の型・署名の方針をフラグにしない。** コードと、バージョンの付いた設定として出し、本番の比べと照合の指標で見る。
- **エンジンの入れ替え**：`engine-core` の変更は、まず写しのエンジンだけに入れ、本番の入力で 24 時間、要約が一致することを確かめる（出力の形を変えない変更に限る）。その後、予定した板の停止の時間（平日の早朝、既定 10 分）に、本番のエンジンを入れ替える。出力の形を変える変更は、記録の形のバージョンを上げ、再生の道具が両方を読めることを先に出す。
  - 入れ替えは、停止の入力の後に sequencer を通した入れ替えの入力（`engine_build_change`、ビルドの ID と記録の形のバージョン）を送って行う。この `seq` から後を新しいビルドで処理し、日次の再生も同じ `seq` でビルドを切り替える（[ADR-0074](../decisions/0074-engine-swap-in-planned-halt-window.md)）。
  - 停止の時間の中で `cancel_only` に入れなければ、板を止めたままにして IC を立てる。取引中にしない。前のビルドで再開してから原因を調べる（[engine-swap.md](engine-swap.md)）。
- **署名の方針と署名の境界**：方針の新しいバージョンは、2 人の承認の署名つきの束で境界に入れる（[ADR-0075](../decisions/0075-signed-config-bundles-for-policies-and-rules.md)）。切り替えは、ホットの自動の署名を止め、前のバージョンで判定した手続き中の依頼が片付くのを待ってから新しいバージョンを有効にする。新旧を並べて使う猶予の期間は置かない（[signing-policy-rollout.md](signing-policy-rollout.md)）。境界の部品の入れ替えも、ホットの自動の署名を止めてから行い、`custody-nonprod` の試験と、本番の見張りのウォレットへの試験の出金を通してから 2 人の承認で開ける。
- **`legal.*` は別の手順。** `legal.*` の値の変更は、法務・財務の承認の記録を添えて、平日の昼に Ops が適用する。適用の前後で照合とウォレットの割合を回す。
- **段階のデプロイ**（Fargate のサービス）：検証 → 見張りの口座だけ → 本番の 5% → 25% → 100%。各段で 30 分、自動のロールバックの条件を見る。
- **自動のロールバックの条件**：受け付けの 5xx と p99、拘束の照合の不一致、約定の記帳の重複と遅れ、使える残高の負、方針の判定の食い違い、入金の記帳の停止、販売所の受け入れの 5xx。
- **デプロイの順**：マイグレーション（広げる段だけ）→ Worker（`relay`、`ledger-poster`、`reconcilers`）→ ドメインのサービス（`ledger` は最後に単独で）→ API の層 → Web の資産。エンジンと sequencer と署名の境界は別の日の別の手順。アプリは週 1 回の列車でストアに出す。
- **ロールバック**：まずフラグで戻す。次に 1 つ前のイメージ（マイグレーションは広げる段だけなので、前のバージョンが今の DB で動く）。エンジンは、板を止めてから前のビルドに戻し、最後のスナップショットと記録から再生して要約が一致することを確かめてから再開する。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| 口座、通知、運用の画面、アプリの資産 | 平日 10〜17 時 | 金曜 15 時以降、日本の祝日の前日、年末年始、エラーバジェットを使い切っている間 |
| 注文の受付、台帳、販売所、入出金 | 平日 10〜15 時 | 同上。加えて、相場の大きな変動の間（参照の価格が 1 時間で 10% 以上動いたとき）、月末と月初の 2 営業日 |
| エンジンと sequencer | 予定した板の停止の時間（平日の早朝） | 同上 |
| 署名の境界と方針 | 平日 10〜15 時。セキュリティと Ops の承認 | 同上。コールドの儀式の当日 |
| Terraform（ネットワーク、DB、MSK、ノード） | 平日 10〜16 時。Ops の承認 | 同上 |

- 上の時間帯と凍結は本システムの既定である。本家の運用の値ではない。

## 4. アラートと手順

手順の文書は [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。工程 1 で共通の 3 本とこの題材に固有の 4 本を作り、工程 3 で領域の文書が求めた手順を足した。残りは計画で、「作る Story」の列の [roadmap.md](../roadmap.md) の Story の完了の条件に含める（E16 の `runbooks-e16` でまとめて確かめる）。同じ中身の手順の名前は 1 つにまとめた（`order-intake-degraded` は `order-entry-degraded.md`、`market-data-lag` は `market-data-degraded.md`、`signing-policy-release` は `signing-policy-rollout.md`）。

**共通**

| アラート（重さ） | 手順 |
| --- | --- |
| すべての障害の一般の手順、SEV の決め方、連絡 | [incident-response.md](incident-response.md) |
| デプロイ中の自動ロールバック、手のロールバック | [deploy-and-rollback.md](deploy-and-rollback.md) |
| Aurora Global Database の遅延、MSK・ノードの AZ の障害、リージョンの障害、大阪への写しの遅れ（10 秒を 5 分、page） | [disaster-recovery.md](disaster-recovery.md) |
| 正しさの見張りの心拍の途絶（5 分、page、SEV2） | [watch-heartbeat-lost.md](watch-heartbeat-lost.md) |
| 時計のずれ（1ms でチケット、100ms で page） | [clock-drift.md](clock-drift.md) |

**取引所と販売所**

| アラート（重さ） | 手順 |
| --- | --- |
| 写しのエンジンとの要約の食い違い、入力の番号の抜け、相場の急変での取り消しだけ、日次の再生の食い違い、スナップショットのハッシュの不一致（page） | [market-halt.md](market-halt.md) |
| 書き手のエンジンの停止で切り替えが 5 分で終わらない（page）、切り替えの後の写しの欠け（15 分でチケット、60 分で IC） | [engine-failover.md](engine-failover.md) |
| エンジンの入れ替え（計画作業）、停止の時間の中で終わらない（page） | [engine-swap.md](engine-swap.md) |
| 受け付けの p99 が 100ms を 5 分超え、MSK の遅れ、残高の行のロック待ちの急増（page） | [order-entry-degraded.md](order-entry-degraded.md) |
| マーケットメイカーの段の一時の引き上げの申請（作業） | [rate-limit-override.md](rate-limit-override.md) |
| 配信の p99 が 500ms を 5 分超え、接続の急増、再接続の嵐（page） | [market-data-degraded.md](market-data-degraded.md) |
| 日々の売買高の公表の前の照合の不一致（チケット、財務とコンプライアンス） | [daily-volume-mismatch.md](daily-volume-mismatch.md) |
| 販売所の提示の停止（理由のコードごと）、評価の損失の上限（page） | [brokerage-quotes-halted.md](brokerage-quotes-halted.md) |
| 販売所の在庫の補充と処分（作業、財務） | [brokerage-inventory-replenish.md](brokerage-inventory-replenish.md) |

**台帳、照合、日本円**

| アラート（重さ） | 手順 |
| --- | --- |
| 台帳とウォレット・銀行・信託の照合の差、約定の記帳の重複・欠け、手数料の表のバージョンが見つからない | [ledger-reconciliation-mismatch.md](ledger-reconciliation-mismatch.md) |
| 日次の締めの検査の破れ（仕訳・全体の釣り合いは SEV1 の候補、残高の行・拘束の行・型の規則は SEV2。page） | [ledger-daily-close-failure.md](ledger-daily-close-failure.md) |
| 利用者の財産の不足が閾値（1,000 万円）か 1 時間を超えた（page） | [house-settlement-stuck.md](house-settlement-stuck.md) |
| 日本円の着金の名義の `review` が翌営業日を超えた（チケット） | [fiat-deposit-review-backlog.md](fiat-deposit-review-backlog.md) |
| 銀行の API の障害、出金の結果の不明の急増、信託銀行の接続の障害 | [bank-outage.md](bank-outage.md) |

**ウォレット、入出金、チェーン**

| アラート（重さ） | 手順 |
| --- | --- |
| 方針の外の署名、異常な出金の急増、ホットの残高の説明のつかない減り、入金のアドレスの検証の食い違い（page、SEV1） | [hot-wallet-compromise.md](hot-wallet-compromise.md) |
| 自動の停止（tripwire）の後の確かめと開け方 | [tripwire-reopen.md](tripwire-reopen.md) |
| 記帳の後の巻き戻り、ノードの分かれ、ノードの遅れでの記帳の停止、2 台がそろって外部の見張りと違う、ETH の確定の停止（page） | [chain-reorg.md](chain-reorg.md) |
| ノードのクライアントの更新、ハードフォークの前の更新（計画作業） | [node-upgrade.md](node-upgrade.md) |
| ネットワークにつながる額の 80% の警告と超え（page） | [hot-ratio-breach.md](hot-ratio-breach.md) |
| コールドの儀式（定期・臨時、保持者の交代） | [cold-ceremony.md](cold-ceremony.md) |
| 署名の方針の束・承認者の一覧・本システムのウォレットの許可の一覧の変更と取り下げ | [signing-policy-rollout.md](signing-policy-rollout.md) |
| 承認者の鍵の紛失・盗難の届け | [approver-key-lost.md](approver-key-lost.md) |
| 鍵の保管の場所の喪失・侵害の疑い（SEV1） | [key-site-loss.md](key-site-loss.md) |
| 置き換えの 5 回の超え、詰まりの判定の急増、`signing` の滞留 | [stuck-withdrawals.md](stuck-withdrawals.md) |
| 手数料の見積もりの中央値が利用者の手数料の表を超えた（チケット、財務） | [withdrawal-fee-review.md](withdrawal-fee-review.md) |
| 持ち主の分からない受け取り・未対応のトークンの到着が 7 日を超えた（チケット） | [unattributed-receipts.md](unattributed-receipts.md) |

**口座、AML、セキュリティ、法令**

| アラート（重さ） | 手順 |
| --- | --- |
| 乗っ取りの兆しの急増、「これは私ではない」・回復の急増、宛先の登録・取り消しの急増、72 時間の止めに当たる依頼の急増 | [account-takeover.md](account-takeover.md) |
| 口座の制限の解除（作業、2 人の承認） | [account-restriction-release.md](account-restriction-release.md) |
| 個人のデータの漏れの疑い、CS の参照の兆し、`app` のログでのアドレス・API キーの形の検出（page、SEV1 の候補。報告の判断は法務の L11） | [privacy-leak-response.md](privacy-leak-response.md) |
| 委託先の担当者の不正の疑い（委託先の役割の一括の停止） | [vendor-access-suspend.md](vendor-access-suspend.md) |
| 制裁の一致を確かめた（page） | [sanctions-true-match.md](sanctions-true-match.md) |
| 提供者の障害（チェーン分析、トラベルルール、eKYC、参照の価格）、制裁の一覧の取り込みの失敗 | [provider-outage.md](provider-outage.md) |
| 重要な情報の事象を開く・公表する・閉じる | [material-info-handling.md](material-info-handling.md) |
| `legal.*` の値の変更（結論の文書から適用まで） | [legal-config-change.md](legal-config-change.md) |
| 当局への報告の書き出しと提出、作り直しのハッシュの違い | [regulatory-report-submission.md](regulatory-report-submission.md) |
| 法令の施行の時刻の切り替え | [regime-cutover.md](regime-cutover.md) |

**計画のもの**

| アラート（重さ） | 手順（予定のファイル名） | 作る Story |
| --- | --- | --- |
| 使える残高の負、拘束の照合の不一致（page） | `balance-hold-mismatch.md` | `balance-holds`、`order-resubmit-and-expire` |
| 不公正取引の兆しの急増、相場の急変の後の案件の並べ | `surveillance-surge.md` | `surveillance-signals` |
| 当局・捜査機関からの照会、資産の凍結の要請 | `legal-request.md`（法務の L6 の後に確定。aml-and-travel-rule の手順と合わせる） | `compliance-rules-and-review` |

- すべてのアラートは、対応する手順の URL を注釈に持つ（CI で検査する。[observability.md](../architecture/observability.md) の 4.7 節）。
- 計画の手順を作るまでは、[incident-response.md](incident-response.md) の一般の手順で対応する。利用者への障害の知らせは、お知らせと状況のページで行う（文言は法務の確認の後）。
- 資産と台帳の障害（方針の外の署名、二重の出金、台帳とウォレットの差）は、セキュリティと財務の担当を必ず呼ぶ。

## 5. 定期作業

| 作業 | 頻度 | 持ち主 |
| --- | --- | --- |
| 日次の全部の再生の結果の確認 | 毎日 | Ops、Dev |
| 台帳とコールド、銀行・信託の照合の結果と仮勘定の確認 | 毎営業日 | 財務、Ops |
| 分別管理の日次の報告の確認（形は法務の L2・L3 の後） | 毎営業日 | 財務 |
| ウォレットの段ごとの残高と割合の確認 | 毎日 | Ops、財務 |
| コールドの儀式（ウォームの補充。[cold-ceremony.md](cold-ceremony.md)） | 営業日に 1 回（既定）と臨時 | Ops、セキュリティ、財務 |
| 承認者の一覧と期限つきの権限の使用の記録の見直し | 毎月 | セキュリティ |
| 署名の方針のバージョンと、境界の記録の照らし合わせ | 毎週 | セキュリティ |
| ノードのクライアントの更新の確認（合意の規則の変更を含む。[node-upgrade.md](node-upgrade.md)） | 毎週 | Ops |
| 不公正取引の案件の待ちの確認 | 毎週 | コンプライアンス |
| DR の訓練（大阪での板の再開） | 半年ごと | Ops |
| 鍵の復旧の訓練（コールドの鍵の材料からの復元、試験の鍵で） | 年 1 回 | セキュリティ、Ops |
| 費用の見直し（約定あたり・出金あたり・口座あたりの原価） | 毎月 | Ops、PM |
| 仮勘定の年齢の確認（30 日を超えたものは財務の責任者へ） | 毎営業日 | 財務 |
| 常設の部品の最大の使用率の確認（マッチングの EC2、MSK、Aurora、`ws-gateway`） | 毎週 | Ops |
| 担当者ごとの参照の数の見直し（CS と運用者） | 毎月 | セキュリティ |
| 写しのエンジンの遅れと比べの欠けの時間の確認 | 毎週 | Ops、Dev |
| 利用者の手数料の表と見積もりの比べ（[withdrawal-fee-review.md](withdrawal-fee-review.md)） | 毎週 | 財務、Ops |
| 銀行の営業日の表（`business_calendars`）の更新 | 年 1 回 | Ops |

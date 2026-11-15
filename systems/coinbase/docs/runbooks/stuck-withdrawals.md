# Runbook: 出金の詰まり

- Owner: Ops（当番）
- 対応するアラート: 置き換えが 5 回を超えて自動の置き換えが止まった、詰まりの判定の急増、放送の失敗の急増、`signing` の滞留、`waiting_funds` の滞留、出金の速さの p95 が 2 時間を超えた（チケット）
- 最終確認日: 2026-11-15

前提の設計は [ADR-0044](../decisions/0044-stuck-transaction-replacement.md)（BTC 6 ブロック・ETH 25 ブロックで詰まりと判定し、宛先と額を変えずに手数料だけ上げる置き換えを 5 回まで）、[ADR-0042](../decisions/0042-withdrawal-transition-table.md)（遷移の表 DT-WD）、[ADR-0047](../decisions/0047-fee-estimation-and-broadcast-paths.md)（放送と流し直し）。流れは [withdrawals.md](../architecture/withdrawals.md) の 8 節。

**同じ出金に 2 つの取引を作らない。** 結果が分からないときは、同じ署名済みの取引を流し直す。

## 症状

- `broadcast` のまま、判定のブロック数を過ぎても入らない出金が増えた。置き換えが 5 回を超えた出金がある。
- ノードが取引を拒んだ（手数料が低すぎる、入力が使用済み、nonce が古い）。
- `signing` に長く留まる出金がある（HSM・MPC の障害、境界の拒否）。
- `waiting_funds` の出金が溜まっている（ホット・ウォームの不足）。

## 影響

- 利用者には「送金済み、確認中」か「処理中」が続く。出金の速さの SLO を消費する。
- ETH は 1 つのレーンの nonce の詰まりで、そのレーンの後の出金が全部止まる（他の 3 つのレーンは進む）。

## 確認

1. 状態ごとの件数と最古の時刻（`withdrawal_events`）。資産とレーン（ETH）ごとに分ける。
2. `broadcast` の詰まり：チェーンの混み（見積もりの値の急騰）か、本システムの取引だけか。各ノードの mempool に取引が見えるか（`broadcasts` の結果と理由のコード）。
3. 拒否の「入力が使用済み」「nonce が古い」：前の取引が確定した可能性がある。合意の頭の規則（[chain-nodes-and-confirmations.md](../architecture/chain-nodes-and-confirmations.md) の 4.1 節）でチェーンを確かめる。
4. `signing` の滞留：signer のアダプターの誤り・時間切れ、境界の拒否（方針の外なら [hot-wallet-compromise.md](hot-wallet-compromise.md)）。
5. `waiting_funds`：ホット・ウォームの残高と、補充・儀式の予定。

## 対処

1. **混みでの詰まり**：上限までの置き換えは自動で進む（手数料が表の値の 10 倍までは P06 で自動、超えると P07 で運用 1 人の承認）。承認の待ちを片付ける。
2. **5 回を超えた**：その出金ごとに判断する。
   - 混みが収まる見込み：待つ（流し直しは続く）。
   - 急ぐ：運用の画面から 6 回目以降の置き換えを依頼する（運用 1 人の承認。宛先と額は変わらない）。
3. **ETH のレーンの詰まり**：詰まった最古の nonce の取引だけを置き換える。後ろの nonce の出金は置き換えない（先頭が入れば続いて入る）。
4. **入力・nonce が他の取引で使われた**：作り直しの条件（W22）に当たる。自動の停止が働き、セキュリティに知らせが行く（[tripwire-reopen.md](tripwire-reopen.md)）。手で作り直さない。
5. **`signing` の滞留**：提供者の障害なら回復を待ち、同じ依頼を流し直す（guard が同じ取引だけを返す）。[provider-outage.md](provider-outage.md)。
6. **`waiting_funds`**：補充の承認を急ぐか、臨時の儀式を予定する（[cold-ceremony.md](cold-ceremony.md)）。

## エスカレーション

- `broadcast` の詰まりが 6 時間を超え、100 件を超える：Ops の責任者と PM（利用者への知らせ）。
- 拒否の理由が説明できない、本システムの取引だけが入らない：Dev のテックリード（取引の組み立て、レーンの nonce の割り当て）。

## 事後

- 置き換えの回数、払った手数料の増え、遅れた件数を記録する。利用者の手数料の表との差は [withdrawal-fee-review.md](withdrawal-fee-review.md)。
- 詰まりの判定のブロック数と置き換えの倍率（見積もりの 1.2 倍）を実績で見直す。

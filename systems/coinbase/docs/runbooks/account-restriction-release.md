# Runbook: 口座の制限の解除

- Owner: 制限を立てた者の種類の担当（CS、コンプライアンス、監視の責任者）、Ops
- 対応するアラート: 定期作業（解除の依頼）。制限の反映の遅れ（p99 5 秒を超えた。チケット）、期限を過ぎて残る制限の行（毎週の確認）
- 最終確認日: 2026-11-15

前提の設計は [ADR-0052](../decisions/0052-account-lifecycle-levels-and-restrictions.md)（制限は行で持ち、行ごとに立てた者の種類の承認で外す）と [ADR-0019](../decisions/0019-account-trading-restrictions.md)（取引に固有の理由も同じ `account_restrictions` に行を足す）。使える機能の決定表は [kyc-and-accounts.md](../architecture/kyc-and-accounts.md) の 4.4 節、反映の速さは 4.5 節。

口座の実際の制限は、立っている行のうち重いほう（`frozen` ＞ `restricted`）。**1 つの行を外しても、ほかの行が残れば制限は残る。** 解除は行ごとに行い、口座の全部の行をまとめて外す操作は持たない。

## 症状

- 利用者が制限の解除を求めた（再確認を済ませた、本人の確かめが済んだ）。
- 案件が閉じ、措置の行を外す判断が出た。
- 公表の時刻の 1 営業日後になった重要な情報の止め（`staff_blackout`。自動で外れる）。

## 影響

- 誤って外すと、制裁の対象・乗っ取られた口座・不公正取引の疑いの口座が、取引と出金をできる。外すのは止めるより慎重にする。

## 確認

1. 口座の立っている全部の行（種類、理由のコード、立てた者の種類、案件の番号、立てた時刻）。
2. 外す行の理由のコードごとの、外す者と条件（下の表）。
3. 外す依頼の作成者と、承認する 2 人目が別の人であること。

| 理由のコード | 種類 | 外す者（作成者と別の 2 人目の承認） | 条件 |
| --- | --- | --- | --- |
| `reverify_due` | `restricted` | 自動（再確認の完了） | 再確認の結果が `verified` |
| `takeover_lock` | `frozen` | CS の社員と 2 人目 | 本人の確かめ（回復の eKYC か CS の確かめ）。外した後も 72 時間の待ちを数え直す（[account-takeover.md](account-takeover.md)） |
| `compliance_hold` | `restricted` | コンプライアンスの担当と 2 人目 | 案件の判断の記録 |
| `sanctions_match` | `frozen` | コンプライアンスの責任者と 2 人目 | 一致の誤りの確定（`dismissed`）。資産の扱いは法務の L6 |
| `surveillance_hold`・`surveillance_suspension` | `restricted`・`frozen` | 監視の責任者（提案者と別） | 案件の判断。案件を閉じても行は残り、外すのは別の承認（[market-surveillance.md](../architecture/market-surveillance.md) の 5 節） |
| `staff_blackout` | `restricted` | 自動 | 公表の時刻の 1 営業日後（[material-info-handling.md](material-info-handling.md)） |
| `legal_order`・`deceased` | `frozen` | コンプライアンスの責任者と法務 | 法務の確認待ち（L6・L14） |
| 取引に固有の理由（ADR-0019） | `restricted` | 立てた者の種類の担当と 2 人目 | ADR-0019 の行ごと |

## 対処

1. 運用の画面で、外す行を選び、理由と根拠（案件の番号）を書いて依頼を作る（案件に結び付く期限つきの権限）。
2. 2 人目が、根拠と、口座のほかの行を見て承認する。承認で `released_at`・`released_by` が書かれ、`identity` が同じトランザクションで outbox（`account.capabilities_changed`）を書く。
3. 反映を確かめる：`identity.capabilities(account_id)` の結果と、`order-gateway` の写し（5 秒で切れる）。出金は正本を見るので、すぐに効く。
4. 利用者に知らせる（理由は出さない。文言は法務の確認の後の型）。

## エスカレーション

- 外す者の種類が分からない行、立てた者の記録のない行：Dev のテックリードとコンプライアンス（記録の誤りとして起票する）。
- 反映が 1 分を超えて遅れる：Ops。`relay` の遅れを見る。

## 事後

- 外した行、外した者、根拠を毎週まとめ、期限を過ぎて残る行を、立てた者の種類の担当に戻す。

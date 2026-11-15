# Runbook: 乗っ取りの兆しの急増

- Owner: セキュリティ、CS の責任者、Ops（当番）
- 対応するアラート: 「これは私ではない」の急増、アカウントの回復・パスキーの追加の率の急増、出金の宛先の登録・取り消しの急増、72 時間の待ちに当たる出金の依頼の急増、日本円の出金の口座の変更の急増、自動の停止の「登録から 48 時間の中の宛先への出金」「同じ宛先への別の口座からの出金」（[ADR-0066](../decisions/0066-automatic-withdrawal-tripwires.md)）
- 最終確認日: 2026-11-15

前提の設計は [ADR-0053](../decisions/0053-sign-in-step-up-cooldown-and-api-keys.md)（パスキー、重要な操作の確かめ、72 時間の待ち）、[ADR-0045](../decisions/0045-allowlist-registration-recorded-in-boundary.md)（宛先の登録の時刻を境界が記録）、[ADR-0052](../decisions/0052-account-lifecycle-levels-and-restrictions.md)（制限の行）。画面と待ちは [kyc-and-accounts.md](../architecture/kyc-and-accounts.md) の 5 節、出金の側は [withdrawals.md](../architecture/withdrawals.md) の 5 節。

パスワードは持たない。72 時間の待ちの契機は、パスキーの追加、TOTP の再設定、メールアドレス・電話番号の変更、アカウントの回復である。

## 症状

- 多くの口座で、短い時間に回復・端末の追加・連絡先の変更が起き、その後に宛先の登録と出金の依頼が続く。
- 知らせを受けた利用者の「これは私ではない」が増えた（`frozen`（`takeover_lock`）が立つ）。
- 外部の大きな漏えい（メールとパスワードの組、フィッシングの集団）の報道の後に、回復の試みが増えた。

## 影響

- 待ちの 72 時間と宛先の待ち 24 時間の間は、資産は口座の中にとどまる（売買と入金は止めない）。待ちの後の出金が本当の危険である。
- 自動の署名を止めると、その資産の出金は承認の段に回り、正しい利用者の出金も遅れる。

## 確認

1. 兆しの口座の数と、共通の点（同じ端末の特徴、IP の範囲、回復の方式、新しい宛先の重なり）。ID と数だけで数え、氏名やアドレスを利用者の ID と同じ記録に書かない。
2. 待ちの終わりが近い口座の数と時刻（`cooldowns`）。宛先の待ちが終わる時刻。
3. 回復の方式の内訳（`jpki`・`ic_chip_face` のやり直し）。提供者の側の異常（同じ書類での繰り返し）。
4. 同じ宛先に複数の口座から出金の依頼があるか。

## 対処

1. **回復を人の確かめに回す**：`ops.account_recovery_auto_enabled` を切る（当番 1 人で切れる）。回復の依頼は CS の社員の確かめの待ち行列に入る。
2. **兆しの資産の自動の署名を止める**：自動の停止が働いていなければ、その資産の `ops.hot_auto_signing_enabled.<asset>` を切る（承認の段で払い続ける）。承認者は、待ちを過ぎたばかりの口座と新しい宛先の出金を、本人への確かめの後に承認する。
3. **共通の宛先を止める**：複数の口座から同じ宛先への出金があれば、その宛先の登録をコンプライアンスが `suspended` にする（[aml-and-travel-rule.md](../architecture/aml-and-travel-rule.md) の 5.4 節と同じ扱い）。
4. **口座を止める**：乗っ取りが確かな口座は、CS の社員が `frozen`（`takeover_lock`）を立て、全セッションを消す。日本円の出金の口座の変更も取り消す（[fiat-and-banking.md](../architecture/fiat-and-banking.md)）。
5. **外す**：本人の確かめ（回復の eKYC のやり直しか、CS の確かめ）と 2 人目の承認で `takeover_lock` を外す（[account-restriction-release.md](account-restriction-release.md)）。外した後も 72 時間の待ちは数え直す。
6. **開ける**：兆しの率が普段に戻ってから、Ops とセキュリティの 2 人の承認で `ops.account_recovery_auto_enabled` と自動の署名を開ける（[tripwire-reopen.md](tripwire-reopen.md)）。

## エスカレーション

- 待ちを過ぎた口座から、本人でない出金が 1 件でも署名された：SEV1 の候補。IC、セキュリティの責任者、財務、コンプライアンス。流れた先を [hot-wallet-compromise.md](hot-wallet-compromise.md) の「追う」と同じ経路で知らせる。
- 利用者への注意の呼びかけ（フィッシングの注意）：PM と法務（文言）。
- 補填の扱い：財務、法務、経営（法務の L12）。

## 事後

- 兆しの口座の数、止めた範囲と時間、本人でない出金の有無を記録する。
- 72 時間の待ちと、回復の方式を見直す（PM、セキュリティ）。新しい形の兆しを [ADR-0066](../decisions/0066-automatic-withdrawal-tripwires.md) の表に足すかを起票する。

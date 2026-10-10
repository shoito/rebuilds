---
status: accepted
date: 2026-10-10
---

# ADR-0056: eKYC は 4 つの口（セッションの作成、結果の取得、Webhook、データの削除）を持つ提供者のアダプターの裏に置き、方式ごとに提供者を替えられるようにする。確認の水準は `unverified`・`verified_document`・`verified_ic` の 3 つ。確認で開く機能と上限はバージョンの付いた表 `kyc_gates` に置き、法令に関わる値は `legal.*` を参照する。結果は 1 つの関数で状態の機械を進める

詳細は [identity-verification.md](../architecture/identity-verification.md) の 4〜6・8 節。

## Context

- 本人確認は外部の eKYC の提供者を使う（マイナンバーカードの IC を優先、書類と顔の照合を予備）。本システムは結果と水準を持つ（[architecture/README.md](../architecture/README.md) の 6 節）。
- 確認は、匿名でない配送（[ADR-0006](0006-shipping-orchestration-via-carriers.md)）、売上金の残高（`legal.balance_requires_kyc_level`。[ADR-0004](0004-proceeds-model-under-payment-services-act.md)）、振込の上限、制限つきのカテゴリを開く。値の多くは法務の確認待ち（L1・L2）。
- 取引時確認の方式としてどの方式が足りるかは法務の確認待ち（L2）。提供者の選定も未定（E15）。
- 提供者の結果は Webhook で届き、重複・欠け・順序の入れ替えがある。

## Options

1. **提供者のアダプターと、方式・水準・開く機能の表を分ける。結果は Webhook の inbox と照会から 1 つの関数で当てる**
2. 1 社の提供者の SDK と API を直接使い、機能ごとに「確認済みか」の真偽で判定する
3. 自前で書類の真贋と顔の照合を作る

## Decision

1 を採用する。3 は Non-goals（[intent.md](../intent.md)）。

- アダプター：`createSession`・`getResult`・`verifyWebhook`・`deleteData`。方式ごとの提供者は設定（`kyc.provider.{method}`）。
- 水準：`unverified`、`verified_document`（`document_face`）、`verified_ic`（`ic_chip`）。公開の印は 2 つの確認の水準で同じ。
- 利用者の状態：`unverified`・`pending`・`verified`・`on_hold`・`revoked`。`on_hold` は、確かめた指紋が別の確認済みのアカウントにあるときと、確かめた生年月日が申告と違うとき。
- `applyKycResult` が決定表 DT-KYC-001 で進める。Webhook の中身を信じず、署名の確かめの後に照会で結果を取る。結果がなければ 10 分ごとに照会（72 時間まで）。
- `kyc_gates`（バージョンつき）：機能ごとの必要な水準。法令の値（残高の条件、振込・購入の上限）は `legal.*` を参照し、結論まで本番で無効。匿名でない配送は本家に寄せて確認を求める。
- 確かめた生年月日は `ageOf()` の入力にする（[ADR-0068](0068-account-deletion-and-minors.md)）。

> 2026-10-10 の注記：犯罪収益移転防止法の施行規則の改正で、非対面の「ホ」方式（書類の画像と容貌の画像）は 2027 年 4 月 1 日から使えなくなる（法律事務所の解説で確かめた。改正命令の本文は**未検証**）。`document_face`（`verified_document`）を取引時確認に使う機能の条件に入れるかは、法務の確認待ち（L2）で決める。`kyc_gates` は水準の一覧で条件を書くので、結論で表を替える。

### 他の案を選ばなかった理由

- **2（直接と真偽）**：法務の結論で方式の扱い（片方だけ足りる）が分かれたとき、機能ごとのコードを書き直す。提供者を替えにくい。
- **3（自前）**：書類の真贋と顔の照合のモデルは題材の核でなく、誤りの影響が大きい。

## Consequences

- 良くなること：法務の結論で表を替えれば、コードを書き直さずに開く機能と上限を変えられる。提供者を方式ごとに替えられる。
- 引き受けるコスト：アダプターの契約の試験と提供者の模型（`kyc-sim`）を持ち続ける。提供者の障害の間は確認できない（迂回しない）。

## Confirmation

- PROP-KYC-001（水準は決定表の行でだけ上がり、冪等）、PROP-KYC-004・005（表の条件を満たさないと開かない、`legal.*` が未設定なら本番で効かない）。
- DT-KYC-001 の表駆動テスト（E15 の合否）。
- アダプターの契約の試験。

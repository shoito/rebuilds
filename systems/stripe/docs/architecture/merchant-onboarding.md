# Merchant Onboarding: Stripe

加盟店の審査（KYC・KYB）、確認の流れ、リスクの審査、機能の有効化（決済・入金）、継続的な監視、拒否と契約の終了、リスクに応じた留保（リザーブ）。

| 関連 | 決定 |
| --- | --- |
| [ADR-0022](../decisions/0022-merchant-onboarding-and-kyc.md) | 審査は自前のステートマシンで持ち、本人確認・法人確認・反社・制裁の照合は外部の提供者を使う。機能は `requirements` と capability で開け閉めする |
| [ADR-0002](../decisions/0002-account-tenancy.md) | 加盟店のアカウントがテナント。テスト環境は審査なしで使える |
| [ADR-0003](../decisions/0003-double-entry-ledger.md) | リザーブは台帳の口座で表す |
| [ADR-0024](../decisions/0024-data-retention-and-deletion.md) | 本人確認の記録の保持 |

## 1. 目標と前提

- **本家に寄せる。** 加盟店のアカウントに `requirements`（`currently_due`・`eventually_due`・`past_due`・`pending_verification`・`current_deadline`・`disabled_reason`・`errors`）、`charges_enabled`・`payouts_enabled`、決済手段ごとの capability を持たせる（[API を利用して本人確認を処理する](https://docs.stripe.com/connect/handling-api-verification)、2026-09-26 に確認）。
- **テスト環境は、登録した直後から使える。** 本番の決済は、審査が済むまで開かない。
- 日本の法令との関係（法務の確認が要る。結論は書かない）：
  - **割賦販売法**：クレジットカード番号等取扱契約締結事業者は、加盟店の契約の締結の前と後に調査を行い、問題があれば指導や契約の拒否・解除を行う義務を負う（第 35 条の 17 の 8）。加盟店自身には、カード番号の適切な管理（第 35 条の 16）と不正利用の防止の措置が求められる（[BUSINESS LAWYERS の解説](https://www.businesslawyers.jp/articles/193)、[条文](https://lawzilla.jp/law/336AC0000000159?n=ln35_17_8.4&mode=only)）。**このシステムの運営者が締結事業者の登録を要するか**（intent.md のとおり、アクワイアラ・決済代行と接続する形のとき）は法務の確認事項。設計は、自ら調査を行い、その証跡を残せる形にしておく。
  - **犯罪収益移転防止法**：特定事業者には取引時確認、確認記録・取引記録の保存、疑わしい取引の届出の義務がある。このシステムの業務が特定事業者の特定業務に当たるか（資金移動業に当たるか、収納代行か）は、intent.md の未解決事項（資金決済法の位置づけ）と一体で法務が確認する。設計は、当たる場合の水準（取引時確認と同等の確認、記録の 7 年保存、届出の窓口）で作る。
  - **個人情報保護法**：代表者・実質的支配者の本人確認書類は個人情報。利用目的の通知、安全管理、保持期間を ADR-0024 で決める。
- 犯収法の施行規則の改正で、2027-04-01 から、非対面の本人確認で本人確認書類の画像を送る方法（規則 6 条 1 項 1 号ホ）が廃止され、マイナンバーカードの公的個人認証（JPKI）と、運転免許証などの IC チップの情報を送る方法が中心になる。IC チップ付きの書類を持たない人のための補完措置は残る（2025-02-28 に命令案を公示、2025-06-24 に公布。[e-Gov の意見募集の結果と命令](https://public-comment.e-gov.go.jp/servlet/Public?CLASSNAME=PCM1040&id=120250002&Mode=1)、2026-09-27 に確認）。本人確認の提供者は、この方式に対応するものを選ぶ。

## 2. 確認する情報（日本）

本家の日本の項目（氏名・住所のカナと漢字など）に合わせる（[必要な確認情報](https://docs.stripe.com/connect/required-verification-information)）。どの項目をいつ求めるかは、下の表を初期値とし、法務の確認で確定する。

### 2.1 個人事業主（`business_type = individual`）

| 項目 | 確認の方法 |
| --- | --- |
| 氏名（漢字・カナ）、生年月日、住所（漢字・カナ）、電話番号、メール | 入力。本人確認で照合 |
| 本人確認 | 外部の eKYC（JPKI、または IC チップの読み取りと容貌の照合） |
| 屋号、事業の内容、URL（または商品の説明）、業種（MCC） | 入力。URL の審査（2.3 節） |
| 入金先の銀行口座 | 口座の名義と本人の氏名（カナ）の照合 |

### 2.2 法人（`business_type = company`）

| 項目 | 確認の方法 |
| --- | --- |
| 商号（漢字・カナ）、本店の所在地、法人番号 | 国税庁の法人番号公表サイトの API で実在と名称・所在地を照合。登記事項は登記情報提供サービスで確認する（方式は着手時に決める） |
| 代表者（氏名、生年月日、住所、役職） | 代表者の本人確認（2.1 節と同じ eKYC）。登記上の代表者であることの確認 |
| 実質的支配者（議決権の 25% 超を持つ個人など） | 申告。本家の `owners` に相当 |
| 取引担当者（代表者でない人が登録するとき） | 本人確認と、法人を代理する権限の確認 |
| 事業の内容、URL、業種、入金先の口座 | 2.1 節と同じ。口座の名義は法人名で照合 |

### 2.3 全加盟店に共通の審査

| 審査 | 内容 |
| --- | --- |
| 反社会的勢力の照合 | 法人・代表者・実質的支配者を、外部の照合サービスに当てる |
| 制裁・PEP の照合 | 財務省の経済制裁の対象者リスト、国連・主要国のリスト、外国 PEP |
| 業種の審査 | 取り扱わない業種（本家の禁止・制限の業種に倣った一覧）と、高リスクの業種（追加の書類を求める） |
| Web サイトの審査 | 事業の内容、返品・返金・キャンセルの方針、問い合わせ先、利用規約、特定商取引法に基づく表記の掲載。本家も URL の審査で返金の方針や顧客サービスの情報の欠落を個別のエラーにしている。特定商取引法の表記を本家の日本の審査が求めるかは、本家の公式の文書に記述がなく未検証（2026-09-27 に確認） |
| カード情報の保護と不正の対策 | 加盟店がカード番号を保持しない形（Checkout・Elements）で使うこと、EMV 3-D セキュアなどの不正の対策を取ること（割賦販売法の加盟店調査の確認事項に当たる。法務の確認） |
| 加盟店情報の照会 | 日本クレジット協会の加盟店情報交換制度などへの照会が要るか（締結事業者に当たる場合。法務の確認） |

## 3. 確認の流れ

```
登録（メール・パスワード・MFA）─▶ テスト環境をすぐ使える
  │
  ▼ 本番の有効化を申請
requirements.currently_due を満たす入力（ダッシュボードのフォーム、または API）
  │
  ▼ 提出
自動の確認（並行）
  ├─ eKYC（代表者・個人事業主）
  ├─ 法人番号・登記の照合
  ├─ 反社・制裁・PEP の照合
  ├─ 口座の名義の照合
  └─ URL・業種の自動の検査
  │
  ├─ すべて通過し、リスクのスコアが低い ─▶ リスクの審査（自動で承認）
  ├─ 一部が失敗 ─▶ requirements.errors に理由を入れ、currently_due に戻す
  └─ 疑わしい一致・高リスクの業種 ─▶ リスクの審査（人）
  │
  ▼ 承認
アクワイアラへの加盟店の登録（必要な場合）─▶ capability が active
  │
  ▼
charges_enabled = true（本番の決済が可能）
payouts_enabled = true（口座の確認が済んでいれば）
```

- 状態は `requirements` の配列と capability の状態（`inactive` / `pending` / `active`）で表す。本家と同じく、Event `account.updated` で知らせる。
- `errors[].code` は本家のコードの名前に寄せる（例：`verification_document_name_mismatch`、`invalid_url_website_incomplete_refund_policy`）。
- 自動の確認は非同期のジョブで行い、外部の提供者の結果を Webhook かポーリングで受け取る。結果は `pending_verification` に置いている間に反映する。
- アクワイアラが加盟店ごとの審査を行う場合（ブランドごとの審査を含む）、capability を `pending` のままにし、アクワイアラの結果で `active` にする。本家の日本のアカウントでは、JCB は自動で有効になり、JCB がすべてのアカウントを審査して、却下や追加の情報を求めることがある（[日本の JCB の有効化](https://support.stripe.com/questions/enabling-jcb-payments-for-japan-based-stripe-accounts)、2026-09-27 に確認）。審査の期間は公式の文書になく、**未検証**（数日から数週間とする[第三者の解説](https://pay.jp/column/stripe-japan-guide)がある）。ブランドごとに有効化の状態を持つかは、最初のアクワイアラの仕様で決める。

## 4. リスクの審査

- **自動の判断**：各確認の結果、業種のリスク、登録からの経過、URL の評価、照合の一致の度合いをルールで点数にする（[fraud.md](fraud.md) と同じルールの言語を使う。対象はアカウントの属性）。
- **人の審査**：社内の審査担当が、社内の管理画面（加盟店のダッシュボードとは別）で行う。判断と理由を必ず記録し、監査ログに残す（ADR-0023）。
- 審査担当は、書類の画像を閲覧するときに理由を入力する。閲覧も監査ログに残す。
- 追加の情報の依頼は、本家のリスクの要件（`<id>.<内容>.<解決の方法>` の形、例：`restricted_or_prohibited_industry_diligence.form`）に倣い、`currently_due` に入れる。
- 審査の担当者と、承認できる金額・業種の範囲を役割で分ける（高リスクの業種の承認は上位の担当者）。

## 5. 機能の有効化

| フラグ・capability | 開く条件 | 閉じる条件 |
| --- | --- | --- |
| `card_payments` | 本人確認・法人確認・反社・制裁の照合が通過し、リスクの審査が承認、アクワイアラの登録が済んだ | `past_due` がある、`rejected.*`、アクワイアラの停止 |
| `konbini_payments` | `card_payments` と同じ審査に加え、収納代行の事業者の登録（必要な場合） | 同上 |
| `jp_bank_transfer_payments` | 同上 | 同上 |
| `charges_enabled` | 1 つ以上の決済の capability が `active` | すべての決済の capability が `active` でない |
| `payouts_enabled` | 入金先の口座の名義が照合済みで、入金の停止の理由がない | 口座の変更の直後（下の注）、`past_due`、リザーブの設定による全額の留保、`rejected.*` |

- **入金先の口座の変更**は、再認証と MFA を求め、登録済みのメールに知らせる。変更から一定の期間（初期値 3 日）は入金を止める。口座の乗っ取りによる送金先の書き換えへの対策。
- `current_deadline` までに `currently_due` を満たさなければ、まず入金を止め、さらに応答がなければ決済も止める（本家と同じ順）。
- 判定は 1 つの関数（`evaluateAccountCapabilities`）にまとめ、表駆動で試験する。

### データモデル

列・制約・索引の正本は [data-model/onboarding.md](data-model/onboarding.md)。

```sql
accounts                 (id, business_type, country, charges_enabled, payouts_enabled,
                          disabled_reason, requirements JSONB, current_deadline, ...)
account_capabilities     (account_id, capability, status, requested_at, status_changed_at)
account_persons          (account_id, id, relationship, name_kanji, name_kana, dob, address...,
                          verification_status)                                 -- 代表者・実質的支配者
verification_checks      (account_id, id, subject_type, subject_id, kind, provider, provider_ref,
                          result, reason_code, checked_at)                     -- eKYC・照合の結果
verification_documents   (account_id, id, person_id NULL, kind, s3_key, sha256, uploaded_at, purge_after)
risk_reviews             (account_id, id, trigger, decision, reason, reviewer_operator_id, decided_at)
account_reserves         (account_id, id, kind, percent, window_days, fixed_amount, release_at,
                          status, reason)
```

- 書類の画像は、本体のアカウントの専用の S3 バケット（KMS の `kyc` キー、閲覧は審査担当のロールだけ）に置く。DB には鍵と要約（ハッシュ）だけを置く。
- `verification_checks` には提供者の結果の要約だけを置き、生の応答（顔写真など）を持たない。提供者の側の保持期間を契約で決める。

## 6. 継続的な監視

| 対象 | 方式 | 動作 |
| --- | --- | --- |
| Dispute の率、不正の早期警告の率 | 日次で加盟店ごとに計算。ブランドの監視プログラムの閾値と比べる。Visa の VAMP は、CNP の件数で（不正の報告＋Dispute）÷ 決済の件数。日本を含む AP 地域の Excessive Merchant は 220bps 以上かつ月 1,500 件以上で、2026-04-01 から 150bps 以上に下がった（[VAMP の fact sheet 2025](https://corporate.visa.com/content/dam/VCOM/corporate/visa-perspectives/security-and-trust/documents/visa-acquirer-monitoring-program-fact-sheet-2025.pdf)、2026-09-27 に確認）。他のブランドの閾値はアクワイアラとの契約で確かめる | 閾値の 50% で警告、超えたらリスクの審査とリザーブの検討 |
| 返金の率、決済の急増、平均の金額の急変 | 日次 | リスクの審査 |
| 業種・URL の変更 | 変更の Event | 再審査 |
| 制裁・PEP のリスト | リストの更新ごとに全加盟店を照合し直す | 一致したら入金を止めて審査 |
| 反社の照合 | 年 1 回と、代表者・実質的支配者の変更時 | 同上 |
| 本人確認の書類の期限、代表者の変更 | 変更の Event、年 1 回の確認の依頼 | `eventually_due` に入れる |
| 割賦販売法の途上の調査 | 定期（頻度は法務の確認の後に決める） | 調査の記録を残す |

- 監視の結果は `risk_reviews` に起票する。判断は人が行う。
- 監視の対象の加盟店を、ダッシュボードで本家の「要対応」に相当する表示で知らせる。

## 7. リザーブ（留保）

本家は、固定のリザーブ（定めた日まで一定の割合を留保）と、ローリングのリザーブ（各決済の一定の割合を、一定の期間ずつ留保）を使い、通常 30〜90 日とする。事前に条件（割合、期間）を加盟店に知らせる（[Reserves FAQ](https://support.stripe.com/questions/reserves-frequently-asked-questions)、2026-09-26 に確認）。

| 種類 | 台帳での表し方 |
| --- | --- |
| ローリング | 決済の残高が `merchant_pending` から `merchant_available` へ移る仕訳と同じトランザクションで、割合の分を `merchant_reserved` へ保留する（`reserve_hold`）。期間を過ぎたら解放のジョブが戻す（`reserve_release`） |
| 固定 | 設定時に、金額を `merchant_available` から `merchant_reserved` へ移す。解放日に戻す |
| 最低残高 | 入金の計算で、指定の額を残して入金する（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)） |

- 仕訳と解放の予定（`reserve_holds`）は [ledger.md](ledger.md) の 4.4 節にある。この文書の `account_reserves` は、リスクの担当が設定する計画（種類、割合、期間、理由）で、台帳の側はそれに従って仕訳を作る。
- 振り替えと解放はすべて台帳の仕訳で行い、残高の列を直接書き換えない（ADR-0003）。解放のジョブは、リザーブと日付を冪等キーにする（ADR-0004）。
- 返金・Dispute が起きた決済にリザーブが残っていれば、先に解放して充てる（ledger.md と同じ）。
- リザーブの設定・変更・解除は、リスクの担当が理由を付けて行い、監査ログに残し、加盟店に Event とメールで知らせる。加盟店は異議を申し立てられる（本家の `reserve_appeal` に相当）。

## 8. 拒否と契約の終了

| `disabled_reason` | 意味 |
| --- | --- |
| `requirements.past_due` | 期限までに情報が出なかった |
| `requirements.pending_verification` | 確認中 |
| `under_review` | リスクの審査中 |
| `listed` | 制裁・反社のリストとの一致の疑いを調査中 |
| `rejected.fraud` | 不正・違法な行為の疑い |
| `rejected.terms_of_service` | 利用規約の違反 |
| `rejected.listed` | リストとの一致が確定 |
| `rejected.incomplete_verification` | 確認が期限内に済まなかった |
| `rejected.other` | その他 |

値は本家と同じ（[API を利用して本人確認を処理する](https://docs.stripe.com/connect/handling-api-verification)）。

- **拒否**：決済の capability をすべて閉じる。既存の決済の返金と、Dispute への対応はできる。
- **残高の扱い**：拒否の後も、Dispute と返金に備えて残高を留保し（初期値 120 日。法務・アクワイアラとの契約で確定する）、その後、照合済みの口座へ入金する。**リストとの一致による拒否では、入金してよいかを法務が判断する**（凍結・届出が要る場合がある）。
- 拒否・終了の決定は、審査担当の上位者の承認を要し、理由を記録する。加盟店への通知の文面は法務の確認を経る。
- 割賦販売法の上で、契約の解除の情報を加盟店情報交換制度へ登録する義務があるかは法務の確認事項。
- **加盟店からの解約**：新しい決済を止め、残高の留保と入金は拒否と同じ流れ。データの保持は ADR-0024 に従う。
- 異議の申し立て（本家の `rejection_appeal`）を受け付け、別の審査担当が見直す。

## 9. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | 登録とテスト環境の即時の利用、`charges_enabled` の判定の骨格 |
| E2 | `requirements` と capability のステートマシン、個人事業主・法人の入力、eKYC・法人番号・反社・制裁の連携、口座の名義の照合、リスクの審査の管理画面、拒否と異議 |
| E4 | リザーブの仕訳と解放のジョブ、入金先の口座の変更時の停止 |
| E7 | ダッシュボードの有効化のフォーム、要対応の表示 |
| E8 | コンビニ払い・銀行振込の capability |
| E9 | Dispute の率などの継続的な監視と、リザーブの判断 |
| E10 | 監視のアラートと runbook |

## 10. 未解決の問い

- 法務の確認待ち（割賦販売法の登録と加盟店調査、犯収法の特定事業者、本人確認の記録の保持期間、拒否の後の残高の留保）は [intent.md](../intent.md) の「法務の確認待ち」にまとめた。結論が出るまで、E2 の審査の Story の spec を承認しない。
- 犯収法の特定事業者に当たらない場合も同等の確認を行うか：当たる前提の水準で作る（ADR-0022）。水準を下げるかは、法務の結論の後に PM が決める。
- 持ち越し：アクワイアラによる加盟店の審査の範囲と、結果の受け取り方（3 節）は、E3 の接続先の選定で確かめ、E2 の `onboarding-requirements` の Story に反映する。

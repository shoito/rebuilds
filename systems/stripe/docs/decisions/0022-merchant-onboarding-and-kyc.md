---
status: accepted
date: 2026-09-26
---

# ADR-0022: 加盟店の審査は自前の状態機械で持ち、確認・照合は外部の提供者を使い、機能は `requirements` と capability で開け閉めする

## Context

本番の決済を始める前に、加盟店の本人確認（KYC）と事業の確認（KYB）、反社会的勢力・制裁の照合、業種と Web サイトの審査が要る。日本では、割賦販売法の加盟店調査の義務（締結事業者に当たる場合）や、犯罪収益移転防止法の取引時確認（特定事業者に当たる場合）が関わる。どちらに当たるかは法務の確認待ちである（intent.md の未解決事項）。

本家は、アカウントの `requirements`（`currently_due`・`eventually_due`・`past_due`・`pending_verification`・`current_deadline`・`disabled_reason`・`errors`）と capability、`charges_enabled`・`payouts_enabled` で、審査の状態と使える機能を表す（[API を利用して本人確認を処理する](https://docs.stripe.com/connect/handling-api-verification)）。

## Options

1. **審査の状態機械とリスクの審査は自前で持ち、本人確認（eKYC）・法人の照合・反社と制裁の照合は外部の提供者を使う**
2. 審査の全体を、KYC・KYB の外部のプラットフォームに任せる
3. すべてを自前で作る（書類の読み取り・容貌の照合を含む）
4. 審査をアクワイアラ・決済代行に任せる

## Decision

1 を採用する。詳細は [merchant-onboarding.md](../architecture/merchant-onboarding.md) にある。

- **状態の表し方は本家に合わせる。** `requirements`、capability（`card_payments`、`konbini_payments`、`jp_bank_transfer_payments`。状態は `inactive` / `pending` / `active`）、`charges_enabled`・`payouts_enabled`、`disabled_reason`（`rejected.fraud` など本家と同じ値）。変化は `account.updated` の Event で知らせる。
- **機能の判定は 1 つの関数**（`evaluateAccountCapabilities`）に集め、表駆動で試験する。
- **テスト環境は審査なしで使える。** 本番の決済は、審査の承認と（必要なら）アクワイアラの登録が済むまで開かない。
- **外部の提供者**：eKYC（JPKI・IC チップの読み取りに対応するもの）、法人番号・登記の照合、反社の照合、制裁・PEP の照合。提供者はアダプタの裏に置き、差し替えられるようにする。
- **リスクの審査**は社内の担当が社内の管理画面で行い、判断と理由を記録する。
- **法令の水準**：犯収法の取引時確認と、割賦販売法の加盟店調査に当たる場合の水準で作る。当たらないと法務が判断しても、確認の水準を下げるかは PM が決める。
- 2 は、状態が外部のデータモデルに縛られ、本家に寄せた `requirements` を自分で表せない。加盟店調査の証跡も外部に置くことになる。
- 3 は、書類の真贋・容貌の照合を自前で作る負担が大きく、犯収法の方式の変更（2027 年に予定される非対面の確認の見直し）にも追従しにくい。
- 4 は、アクワイアラごとに審査が変わり、複数のコネクタへの振り分け（intent.md）と相性が悪い。加盟店調査の義務が自分にある場合にも足りない。アクワイアラ自身の審査は、capability の `pending` として待つ。

## Consequences

- 良くなること：
  - 本家と同じ形の `requirements` を API とダッシュボードで出せる。
  - 提供者を替えても、状態機械と証跡は変わらない。
  - 加盟店調査・取引時確認の記録を、自分の DB と監査ログに残せる。
- 引き受けるコスト：
  - 提供者ごとの契約・費用・個人情報の委託の管理（外国の提供者なら、外国にある第三者への提供の論点）。
  - 審査の担当の体制と、管理画面を持つ。
  - 法務の結論によって、確認の項目・頻度・保存の期間を変える可能性がある。

## Confirmation

- 表駆動テスト：`requirements` と照合の結果の組み合わせごとに、capability と `charges_enabled`・`payouts_enabled` が期待どおりになる。
- 結合テスト：審査が済んでいない加盟店の本番のキーでの決済が、`account_invalid` 相当のエラーになる。テストのキーでは成功する。
- 結合テスト：入金先の口座を変えた直後は、`payouts_enabled` が偽になり、通知が送られる。
- 審査の判断が、すべて理由と担当者つきで `platform_audit_events` に残る（ADR-0023）。

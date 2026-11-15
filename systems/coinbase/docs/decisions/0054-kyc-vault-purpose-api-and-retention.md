---
status: proposed
date: 2026-11-15
---

# ADR-0054: kyc-vault は目的の関数だけで読み、画像を持たず、期限で鍵を破棄する

## Context

- 本人確認の書類と顔の画像、氏名・住所・生年月日、口座の番号は `kyc-vault` にだけ置く（[ADR-0001](0001-platform-and-stack.md)、AGENTS.md）。本家は 2025 年に、サポートの委託先の担当者から利用者のデータが持ち出された（intent の出典）。
- 金庫を読む者は多い：名義の照合（`funding`）、制裁の照合とトラベルルール（`compliance`）、当局への報告、CS と案件の調べ。
- 確認の記録と取引の記録の保存の期間、退会の後の保持、外国の提供者への提供は法務の確認待ち（L4・L11）。相続・差押えは L14。
- Workday の題材が、目的で縛る金庫の関数と監査の行、ハッシュの鎖、保持の表と legal hold を設計した（[ADR-0046](../../../workday/docs/decisions/0046-purpose-bound-vault-api-and-access-log.md)、[ADR-0048](../../../workday/docs/decisions/0048-audit-log-hash-chain-and-anchoring.md)、[ADR-0049](../../../workday/docs/decisions/0049-retention-rules-table-and-legal-hold.md)）。

## Options

1. **目的ごとの関数だけで読み、関数は要る項目だけを返し、同じトランザクションで監査の行を書く。書類と顔の画像は提供者に置き、本システムは受け取らない。保持の期限の後は人ごとの鍵を破棄する**
2. 金庫の表を読む権限を役割ごとに与え、行の読み出しを監査のログに書く
3. 画像も金庫に置き、本システムで保存の期間を管理する

## Decision

1 を採用する。

- 置くもの：`persons`（氏名、カナ、生年月日、住所、国籍。人ごとの鍵の封筒の暗号化）、`person_declarations`（職業、目的、適合性の項目）、`kyc_checks`（方式、書類の種類、提供者の参照、判定）、`bank_accounts`（`funding` が書く）。
- 置かないもの：書類と顔の画像（提供者だけ。保存の期間と削除の依頼は提供者の選定の条件）、個人番号（MVP は集めない。税の報告で要るかは法務の L10）。
- 関数：`nameKanaMatches`、`travelRuleOriginator`、`screeningSubject`、`reportSubject`、`revealForCase`（[kyc-and-accounts.md](../architecture/kyc-and-accounts.md) の 6.2 節）。真偽で足りるものは真偽だけを返す。`revealForCase` は期限つきの権限、理由、2 人の承認（[Auth0 の ADR-0056](../../../auth0/docs/decisions/0056-operator-access.md)）。
- 監査：読み出しごとに同じトランザクションで監査の行を書き、ハッシュの鎖でつなぐ（Workday の ADR-0048）。
- 退会：未約定の注文、拘束、手続き中の入出金、残高、`frozen`、開いた案件がどれも 0 のときだけ受け、`closing` にする。
- 保持：退会から `legal.kyc_record_retention_days`・`legal.transaction_record_retention_days`（開発・検証の既定 2,555 日。本番は法務の L4・L11）。照会・差押えの間は legal hold（Workday の ADR-0049）。期限の後に人ごとの鍵を破棄し、`closed` にする。台帳と core には口座の ID と `person_key` だけが残る。

### 他の案を選ばなかった理由

- **2**：役割に表の読み出しを与えると、問い合わせに要らない項目まで引ける（本家の 2025 年の事故の形）。何の目的で読んだかが残らない。
- **3**：本システムが画像を持つと、漏れの経路と保管の費用が増え、削除の確かめも本システムの責任になる。確認の判定は提供者の結果で足りる。

## Consequences

- 良くなること：
  - 金庫の読み出しの目的と項目が、関数の一覧と監査の鎖で説明できる。
  - 画像の漏れの経路が本システムにない。
  - 鍵の破棄で、行を探して消さずに、人ごとのデータを読めなくできる。
- 引き受けるコスト：
  - 新しい目的には、関数と監査の項目を足す変更が要る（spec のレビューで扱う）。
  - 画像を後で見直したいとき（不正の調べ）は、提供者の保存の期間の中だけで、提供者の画面を使う。
  - 個人番号が要ると決まったら、Workday の保管庫を使う ADR を別に起票する。

## Confirmation

- PROP-KYC-004（金庫の読み出しは全件、同じトランザクションの監査の行を持つ）。PROP-KYC-005（退会は残高・拘束・手続き中の入出金が 0 のときだけ）。
- 漏れの経路の表（[quality.md](../quality.md) の 2.2.1 節 I）に、関数ごとの返す項目の行を置き、ログ・トレース・CS の画面に出ないことを確かめる。
- DB の権限の検査：`kyc-vault` の表を直接 SELECT できる役割は、関数の持ち主だけ（CI で役割の一覧を比べる）。
- 保持の試験：時刻を進め、期限の後に鍵が破棄され、関数が「消えた」を返す。legal hold の間は破棄されない。

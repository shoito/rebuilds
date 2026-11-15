---
status: proposed
date: 2026-11-15
---

# ADR-0052: 口座の寿命・確認の水準・制限を分け、使える機能を 1 つの表で決める

## Context

口座で何ができるかは、いくつもの者が決める。

- 口座の開設と退会の流れ（`identity`）。
- 取引時確認の結果（eKYC の提供者の結果を自前の規則で当てる。[ADR-0011](0011-external-providers-boundary.md)）。方式の扱いは法務の確認待ち（L4）で、非対面の「ホ」方式は 2027 年 4 月 1 日から使えなくなると解説されている（**未検証**）。
- コンプライアンス（制裁の一致、疑わしい取引）、不公正取引の監視の措置、法令の要請（差押え、凍結。法務の L6・L14）、本人の「これは私ではない」。

これらを 1 つの状態の列に詰めると、ある者が状態を戻したときに、別の者が立てた止めを消してしまう。`order-gateway` は注文ごとに口座の状態を確かめるが（[ADR-0004](0004-order-entry-holds-and-idempotency.md)）、受け付けの p99 20ms（NFR-001）の中で `identity` を毎回呼べない。

## Options

1. **寿命の状態、確認の水準、制限の行（複数）の 3 つの軸に分け、使える機能を決定表 DT-KYC-001 だけで決める。各サービスは機能の写しを事象で持つ**
2. 1 つの状態の列（`active`・`suspended`・`frozen` など）を持ち、書く者が上書きする
3. サービスごとに自分の止めの印を持ち、各自で判定する

確認の方式：

- a. **方式を列で持ち、本番で使える方式と期間を `legal.kyc_allowed_methods` で決める**
- b. 方式をコードで固定し、法務の結論でコードを直す

## Decision

1 と a を採用する。

- 寿命の状態：`applying`・`verifying`・`review`・`active`・`rejected`・`closing`・`closed`。遷移の表は [kyc-and-accounts.md](../architecture/kyc-and-accounts.md) の 4.3 節。
- 確認の水準：`none`・`contact`・`verified`。`verified` の方式は `jpki`・`ic_chip_face`・`document_face`・`document_postal`。`legal.kyc_allowed_methods` は方式ごとの使える期間を持ち、本番は法務の L4 の結論まで空にする（どの方式でも `verified` にしない）。
- 制限：`account_restrictions` の行（`restricted` か `frozen`、理由のコード、立てた者の種類）。解除は行ごとに、立てた者の種類の承認で行う。重いほうが効く。
- 使える機能：`identity.capabilities()` が DT-KYC-001（同 4.4 節）だけで答える。`frozen` に入るときは未約定の注文の取り消しを依頼する。
- 写し：outbox の `account.capabilities_changed` で各サービスが写しを更新し、写しは 5 秒で切れる。`frozen` は写しを消す依頼を直接にも送る。出金は写しでなく正本で確かめ直す。
- 1 つの `person_key` に個人の口座は 1 つ。法人は `organizations` と担当者・実質的支配者の確認で `verified` にし、同じ法人の口座を 1 つの自己約定の組にする（PM の判断待ち P1。入れないなら `release.corporate-accounts` の裏）。
- 適合性の申告は記録し、段に応じた上限（`legal.suitability_limits`）は本番で無効にしておく（法務の L12）。

### 他の案を選ばなかった理由

- **2**：コンプライアンスが立てた `frozen` を、再確認の完了が `active` に戻して消す、といった誤りがエラーにならない。
- **3**：同じ口座の判定がサービスごとにずれ、販売所では買えるが取引所では買えない、といった食い違いが残る。
- **b**：法務の結論と施行の日のたびにコードを直し、終わりの日を過ぎた方式を使う誤りを防げない。

## Consequences

- 良くなること：
  - 止めを立てた者が、自分の止めだけを外せる。止めの理由が行として残り、監査できる。
  - 判定が 1 つの表にあり、表駆動のテストで全行を確かめられる。
  - 方式の扱いが変わっても、設定の変更で済む。
- 引き受けるコスト：
  - 写しの期限の間（最長 5 秒）、`restricted` への変化が注文に効かないことがある。`frozen` と出金は直接の依頼と正本で補う。
  - 3 つの軸を画面で説明する文言が要る。

## Confirmation

- DT-KYC-001（寿命・水準・制限の全部の組）と DT-KYC-002（方式 × 期間 × 確認の日）の表駆動のテスト。
- PROP-KYC-001（水準は表の行でだけ上がり冪等）、PROP-KYC-002（`frozen` の間の注文の受け付け 0。写しの期限を含む）、PROP-KYC-003（本番で `legal.kyc_allowed_methods` が空なら `verified` 0）。
- レビュー：新しい止めの理由を足す spec は、理由のコードと解除の承認者の種類を書いている。

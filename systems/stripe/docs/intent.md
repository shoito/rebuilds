# Intent: Stripe を AI エージェント主体で再構築する

- Author: shoito
- Status: accepted
- Date: 2026-09-26

## Problem

オンラインで代金を受け取るには、カード会社・決済代行・銀行との接続、カード情報の安全な扱い（PCI DSS）、返金やチャージバック、入金と照合、法令への対応が要る。事業者（加盟店）がこれを自前で持つのは重く、決済の失敗や二重請求、帳尻の合わないお金は、そのまま信用の損失になる。

本家 Stripe は、これを「数行のコードで決済を受けられる API」と「お金が必ず合う裏側」として提供している。その中身を、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。

## Proposed outcome

加盟店が API で決済を受け取り、返金し、入金を受けられる決済基盤を、次の 3 つの価値を満たすように作り直す。

1. **開発者がすぐに組み込める**：一貫した API、冪等なリクエスト、日付で固定される API の版、テスト用の環境、Webhook。
2. **お金が必ず合う**：すべてのお金の動きを複式簿記の台帳に記録し、残高・手数料・入金・決済代行の精算を照合する。
3. **安全で止まらない**：カード情報を扱う範囲を最小に閉じ込め（PCI DSS）、決済の API は高い可用性を保つ。

### MVP に含める

- 加盟店のアカウント、API キー（公開・秘密・制限付き）、テスト環境と本番環境の分離
- Customer、PaymentMethod、PaymentIntent（オーソリ・キャプチャ・取り消し）、Refund
- 決済手段：カード（3D セキュア 2 を含む）。日本向けに、コンビニ払いと銀行振込（振込先の割り当て）
- 決済代行・アクワイアラへの接続（コネクタ）と、失敗時の振り分け
- Dispute（チャージバック）の受け取りと、証拠の提出
- 台帳、残高、手数料、Payout（加盟店の口座への入金）、精算ファイルとの照合
- Event と Webhook
- ホスト型の決済ページ（Checkout に相当）と、埋め込み型の入力部品（Elements に相当）
- ダッシュボード（加盟店向けの Web 画面）
- ルールによる基本的な不正検知

### 守るべき振る舞い

- 同じ冪等キーの要求を何度送っても、決済は 1 回しか起きない。
- 成功を返した決済・返金・入金は失わない。台帳の借方と貸方は、常に一致する。
- カード番号は、カード情報を扱う専用の領域（CDE）の外に、平文で一度も出ない。
- 加盟店は、他の加盟店のデータを一切見られない。
- API の版を固定した加盟店は、その版の振る舞いを受け続ける。

## Affected users and systems

- 加盟店の開発者（API・SDK・Webhook）と、運用担当（ダッシュボード）
- 加盟店の顧客（決済ページ、3D セキュアの認証）
- 決済代行・アクワイアラ、カードブランド、銀行（入金）、コンビニ収納の事業者
- 社内の運用（リスク審査、サポート、経理）

## Constraints

- 決済の中継は、ライセンスを持つ決済代行・アクワイアラと接続して行う。このシステム自体がカードブランドの会員（アクワイアラ）になることは前提にしない。
- 日本の法令（割賦販売法のカード情報の保護、資金決済法、犯罪収益移転防止法、個人情報保護法）への対応は、法務の確認を前提に設計する。
- 実行基盤と技術は、rebuilds の他の題材（Slack）の決定を引き継ぎ、決済に固有の事情だけを変える（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| Connect（プラットフォームと連結アカウント） | 資金の流れと本人確認の範囲が大きく広がる。MVP の後の Epic で扱う |
| Billing（サブスクリプション・請求書） | 決済の上に作る別の製品。MVP の後の Epic で扱う |
| Radar の機械学習による不正検知 | 大量の取引データが前提。MVP はルールと外部の不正検知サービスの連携で行う |
| Terminal（対面決済）、Issuing（カード発行）、Treasury、Capital、Atlas、Tax、Identity | それぞれ別の免許や物理機器・金融機関との契約が要る別の製品 |
| 暗号資産・ステーブルコインの決済 | 法令とカストディの論点が別に大きい |
| 自前でのカードブランドへの直接接続 | アクワイアラの免許と認定が要る |

## Open questions

### 法務の確認待ち

設計はどの結論にも対応できる形にしてあるが、結論は出していない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。**

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 資金決済法の位置づけ：加盟店の代わりに代金を受け取って後で渡す流れが、収納代行か資金移動業か。預かり金の分別管理、銀行口座の名義・用途、全銀システムへの直接の参加の可否 | [payouts-and-reconciliation.md](architecture/payouts-and-reconciliation.md)、[ADR-0018](decisions/0018-payout-execution-via-banking-partner.md) | E4 の入金（Payout）の Story。E8 の銀行振込（顧客の現金残高を預かるため。[ADR-0013](decisions/0013-japan-async-payment-methods.md)） |
| L2 | 割賦販売法：クレジットカード番号等取扱契約締結事業者の登録の要否、加盟店調査の項目・頻度、加盟店情報交換制度への照会・登録、セキュリティガイドラインの適用の範囲 | [merchant-onboarding.md](architecture/merchant-onboarding.md)、[security.md](architecture/security.md) の 14 節 | E2 の審査の Story（`requirements` と照合、リスクの審査、拒否） |
| L3 | 犯罪収益移転防止法：特定事業者に当たるか（L1 と一体）。取引時確認・記録の保存・届出の義務 | [ADR-0022](decisions/0022-merchant-onboarding-and-kyc.md) | E2 の審査の Story |
| L4 | 個人情報保護法：加盟店の顧客の情報を委託として扱うか自ら取得するか、外国にある第三者（海外の提供者）への提供、カード番号の漏えい等の報告の義務を負う者と手順 | [security.md](architecture/security.md) の 12・14 節、[fraud.md](architecture/fraud.md) の 6 節 | E2 の本人確認の提供者の連携、E9 の外部の不正検知サービスの連携、E10 の `card-data-exposure` の runbook |
| L5 | 電気通信事業法の外部送信規律：Checkout・Elements で端末の情報を集めて外部の不正検知サービスへ送ることが当たるか、公表の方法 | [checkout.md](architecture/checkout.md) の 12 節、[fraud.md](architecture/fraud.md) の 6 節 | E6 の端末の信号の収集、E9 の外部の不正検知サービスの連携 |
| L6 | 帳簿等の保存期間：取引の記録（7 年）、台帳（10 年）、本人確認の記録（7 年）、監査のアーカイブ（7 年）の期間。Object Lock は後から短くできない | [ADR-0023](decisions/0023-audit-log.md)、[ADR-0024](decisions/0024-data-retention-and-deletion.md)、[security.md](architecture/security.md) の 13 節 | E10 の監査のアーカイブと保持のジョブ（本番の Object Lock のバケットを作る前）。E4 の台帳の古いパーティションの書き出し |
| L7 | 拒否・解約の後の残高の留保：留保の期間（既定案 120 日）と、制裁・反社のリストとの一致で拒否したときに入金してよいか | [merchant-onboarding.md](architecture/merchant-onboarding.md) の 8 節 | E2 の拒否と契約の終了の Story、E4 の入金の停止と解除 |
| L8 | 消費税の扱い：決済手数料・Dispute の手数料にかかる消費税と、`fee_details` の `tax`、請求書の要件 | [ledger.md](architecture/ledger.md) の 2.2 節 | E4 の手数料（`fee-schedules`）の Story |

### 接続先の選定（法務以外）

- 最初のカードのコネクタ（決済代行・アクワイアラ）：E3 の着手前に選ぶ。条件は照会 API、3DS Server、30 日のオーソリ、S1 のピークの 1.5 倍（750 件/秒）を受けられること（[architecture/README.md](architecture/README.md) の 6 節の「持ち越し」）。
- コンビニ収納代行（E8）、提携銀行（E4・E8）、eKYC・照合の提供者（E2）、外部の不正検知サービス（E9）、QSA（E10）。

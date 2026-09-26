---
status: accepted
date: 2026-09-26
---

# ADR-0027: カード入力は CDE の側のオリジンが配る iframe で受け、loader も CDE の変更管理で配る

## Context

[ADR-0005](0005-pci-scope-segmentation.md) で、カード番号は顧客のブラウザから Vault（CDE）へ直接送り、加盟店のサーバーと本体を通さないと決めた。これを画面でどう実現するかを決める。

本家は次のようにしている（2026-09-26 に確認）。

- Checkout と Elements は、カード入力をすべて Stripe のドメインが配る iframe に置く。これで加盟店は SAQ A の対象になる（[PCI DSS 準拠ガイド](https://stripe.com/guides/pci-compliance)）。
- Stripe.js は常に `https://js.stripe.com` から直接読み込ませ、バンドルや自前の配信を認めない（[Including Stripe.js](https://docs.stripe.com/js/including)）。
- 3D セキュアの認証画面は `hooks.stripe.com` を経由して iframe やモーダルで出す（[3D セキュア](https://docs.stripe.com/payments/3d-secure/authentication-flow)）。

加えて、PCI DSS v4.0.1 は、決済ページのスクリプトの管理（6.4.3）と改ざんの検知（11.6.1）を求める。PCI SSC は 2025 年 1 月に、これらを SAQ A から外し、代わりに「加盟店のサイトがスクリプトの攻撃を受けにくいこと」を適格の条件にした（[PCI SSC のブログ](https://blog.pcisecuritystandards.org/important-updates-announced-for-merchants-validating-to-self-assessment-questionnaire-a)）。

## Options

1. **カード入力の iframe と loader を CDE のアカウントから配り、ホスト型の決済ページは本体に置いて iframe を埋め込む**
2. **ホスト型の決済ページも含めて、すべてを CDE に置く**
3. **カード入力の iframe だけを CDE に置き、loader は本体から配る**
4. **iframe を使わず、加盟店のページに直接入力欄を出し、JavaScript で Vault へ送る（本家の旧 Stripe.js v2 に近い）**

## Decision

1 を採用する。

- `js.<domain>`（loader）、`elements.<domain>`（カード入力の iframe、Payment Element の iframe）、`hooks.<domain>`（3D セキュアの中継）は、CDE のアカウントの S3＋CloudFront から配る。変更は CDE と同じ管理（二者のレビュー、署名付きのビルド、デプロイの承認）で行う。
- カード入力の iframe は、カード番号・有効期限・CVC を `vault.<domain>`（テスト環境は `vault-test.<domain>`）へ直接送り、使い捨ての `card_input` を受け取る。iframe はそれを公開キーで本体の API に渡して `pm_` を作らせ、本体が PrivateLink で Vault に紐づける（CDE から本体を呼ばない。[ADR-0029](0029-multi-account-and-cde-layout.md)、[card-vault.md](../architecture/card-vault.md) の 3.1 節）。加盟店のページの JavaScript と、本体の API には、カード番号を渡さない。loader と iframe の間のメッセージの型に、カード番号を含む種類を定義しない。
- ホスト型・埋め込み型の決済ページ（`checkout.<domain>`）は本体に置き、カード入力の部分だけを iframe で埋め込む。決済ページは「CDE に影響しうるシステム」として PCI の範囲に入れ、スクリプトの目録と SRI、CSP、1 時間ごとの改ざんの検知を当てる。
- 決済の画面には、第三者のスクリプト（計測、CAPTCHA、タグマネージャー）を読み込まない。
- 2 は、決済ページの頻繁な変更（文言、見た目、決済手段の追加）まで CDE の変更管理に乗せることになり、開発の速さを大きく落とす。
- 3 は、loader が改ざんされると、加盟店のページに偽の入力欄を出してカード番号を盗めるので、iframe だけを守っても足りない。
- 4 は、加盟店が SAQ A-EP の対象になり、本家の既定の体験と合わない。

## Consequences

- 良くなること：
  - 加盟店は、ホスト型・埋め込み型・Payment Element のどれでも SAQ A の対象になれる。
  - 本体の API とログにカード番号が来ないので、本体は CDE の外に保てる。
- 引き受けるコスト：
  - 決済ページは CDE の外だが PCI の範囲に入るので、6.4.3・11.6.1 の統制を運用し、監査の対象になる。
  - loader の変更は CDE の変更管理に乗るので、リリースの速さが落ちる。loader は薄く保ち、画面の多くを iframe の中に置く。
  - 見た目の変更は、用意したテーマ・変数・書体の一覧に限る。加盟店の任意の CSS・書体の URL を iframe に読み込ませない（本家より狭い）。
  - 本家にある組み込みの CAPTCHA を、第三者のスクリプトなしで作る必要がある。

## Confirmation

- データの流れの検査：本体のログ・DB・メッセージにカード番号の形が出ないこと（ADR-0005 の検査）に加え、E2E で加盟店のページの `window` からカード番号に届かないこと（`postMessage` の監視、DOM の走査）を確かめる。
- IaC の検査：`js.<domain>`・`elements.<domain>`・`hooks.<domain>` の配信が CDE のアカウントにあり、デプロイのロールが CDE の経路だけにある。
- 合成監視：決済ページのスクリプトのハッシュと、セキュリティのヘッダーが、リリースの目録と一致する（1 時間ごと）。
- CSP：ホスト型の決済ページが `frame-ancestors 'none'`、埋め込み型が Session の `return_url` のオリジンだけを許す。

---
status: accepted
date: 2026-09-26
---

# ADR-0012: 3D セキュアはコネクタが提供する 3DS Server を使い、日本で発行されたカードの CIT では常に要求する

## Context

カードの EC 決済では、EMV 3-D セキュア（3DS2）による本人認証が要る。

- 日本では、クレジットカード・セキュリティガイドラインが、EC 加盟店に EMV 3-D セキュアの導入を求めている。本家も、同ガイドラインが求める場合に自動で 3DS を起動する（[3D セキュアを使用して認証する](https://docs.stripe.com/payments/3d-secure/authentication-flow)、2026-09-26 に確認）。
- 3DS2 の認証要求を組み立てる 3DS Server は、EMVCo の認定と、各カードブランドの Directory Server への接続・登録が要る。
- 本家は自前の 3DS Server を持ち、PaymentIntent の `requires_action` と `next_action`（`use_stripe_sdk`、`redirect_to_url`）で認証を表す。

## Options

1. **コネクタ（決済代行）が提供する 3DS Server を使う**
2. **自前で 3DS Server を作り、EMVCo の認定を取る**
3. **独立した 3DS の専業の事業者の 3DS Server を使う**（決済代行とは別に契約する）

## Decision

1 を採用する。詳細は [payments.md](../architecture/payments.md) の 6 節にある。

- **認証はコネクタの能力 `three_ds_server` として扱う。** Connector Gateway（CDE）が、コネクタの 3DS Server に認証を要求する（カード番号を使うため CDE の中で行う）。
- **API の形は本家に合わせる。** チャレンジが要れば `requires_action` にし、`next_action` に `use_stripe_sdk`（Elements・Checkout の iframe）か `redirect_to_url`（`return_url` があるとき）を入れる。認証の結果・ECI・認証の流れを Charge に記録し、Dispute の証拠に使う。
- **要求する条件**：日本で発行されたカードの CIT は常に要求する。加盟店の `request_three_d_secure`、不正検知のルール、カード発行会社の `authentication_required` でも要求する。事前に認証した MIT は免除とする。加盟店は API で 3DS を無効にできない。
- 2 は、本家に最も近いが、EMVCo の認定と各ブランドへの登録に時間と費用がかかり、MVP の範囲を超える。S3 で決済代行を複数使い分けるようになったら再検討する。
- 3 は、決済代行を替えても 3DS を保てるが、契約と接続が 1 つ増える。最初の決済代行が 3DS Server を提供しない場合に選ぶ。

## Consequences

- 良くなること：
  - 認定を取らずに、日本のガイドラインが求める 3DS を MVP から提供できる。
  - 加盟店は、本家の `next_action` の扱いのまま組み込める。
- 悪くなること、引き受けるコスト：
  - 3DS の体験（チャレンジの画面、frictionless の率）と、Stripe.js が行う 3DS Method（ブラウザーの情報の収集）の方式が、コネクタに依存する。コネクタが iframe での表示を許さない場合は `redirect_to_url` だけになる。
  - 決済代行を替えると、3DS の認証の結果を引き継げない（認証とオーソリは同じコネクタで行う）。
  - 3DS Server の障害は、そのコネクタの障害として扱う。

## Confirmation

- 結合テスト：模擬のアクワイアラで、本家の 3DS のテスト用のカード（`4000000000003220`、`4000002500003155`、`4000008400001629`、`4000000000003055`）が、本家と同じ状態の遷移になる。
- 契約テスト：Elements が `use_stripe_sdk` と `redirect_to_url` の両方を扱える。
- 未検証：ガイドラインの版と条文、最初のコネクタが 3DS Server と iframe での表示を提供するか。法務の確認と、コネクタの選定で確かめる。

> 2026-09-27 の注記：`next_action.type` の値のうち本家の名前を含む `use_stripe_sdk` は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従い、本システムでは `use_<brand>_sdk` とする（[payments.md](../architecture/payments.md) の 3.1・6.2 節）。形と意味は変えない。

> 2026-09-27 の注記（ガイドラインの版と本家の振る舞い）：
> - 現行のガイドラインは[クレジットカード・セキュリティガイドライン【6.1 版】](https://www.j-credit.or.jp/security/pdf/Creditcardsecurityguidelines_6.1_published.pdf)（2026 年 3 月）で、3DS は「5-2-2-2 ① EC 加盟店の指針対策」にある。EC 加盟店は EMV 3-D セキュアを導入し、原則として決済の都度に認証する。ただし、カード番号の登録時だけの認証や、リスクの判断による認証も認められる。Confirmation の「ガイドラインの版と条文」の未検証は、これで解消した。法的な当てはめは法務の確認のまま。
> - 本家は、発行国を問わず日本の加盟店のすべてのカードに求め、カードごとに少なくとも 1 回（保存時か最初の使用時）認証した後の CIT には強制しない。デビット・プリペイド、Apple Pay・Google Pay、MOTO、2025-04-01 より前に保存したカードは対象外（[日本の 3D セキュア必須化の例外](https://docs.stripe.com/payments/3d-secure/japan-exemptions)、2026-09-27 に確認）。本 ADR の「日本で発行されたカードの CIT では常に要求」は、本家とこの点で違う。決定は変えない。

> 2026-09-28 の注記（3DS の範囲の確定）：範囲は本 ADR のまま確定し、本家には揃えない。理由は次のとおり。
> - ガイドライン 6.1 版は、決済の都度の認証を原則にしている。本 ADR の範囲はその原則に沿う。
> - 本家の免除（保存したカードの以後の CIT、デビット・プリペイドなど）は、本家の不正検知とリスクの判断を前提にしている。本システムの MVP はルールだけで不正を検知する（ADR-0021）。
> - 本家との違い（発行国を問わない適用、カードごとに 1 回の認証、免除の対象）は、[fraud.md](../architecture/fraud.md) の 5 節に残す。本家に揃えるのは、リスクの判断による認証を足すとき（E9 以降）に新しい ADR で検討する。

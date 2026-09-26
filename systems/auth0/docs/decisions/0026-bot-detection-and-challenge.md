---
status: accepted
date: 2026-09-27
---

# ADR-0026: ボットの検知は自前のリスクの点数と自前の proof-of-work のチャレンジで行う。WAF はエッジの後ろ盾、第三者の CAPTCHA は法務の L2 の後

## Context

ボットの検知の方式は、E8 の着手前に決めることになっていた（[intent.md](../intent.md)）。第三者の部品を使うなら、法務の L2（電気通信事業法の外部送信規律）と L1（外国にある第三者への提供）に関わる。

本家 Auth0 のボットの検知は、統計のモデルでログイン・サインアップ・再設定のボットらしい集中を見つけ、CAPTCHA を「なし」「危険なときだけ」「常に」で求める。危険の水準は低・中（既定）・高。提供者は本家の Auth Challenge（JavaScript が要る）、Simple CAPTCHA（JavaScript が要らない）、第三者（[Bot Detection](https://auth0.com/docs/secure/attack-protection/bot-detection)、2026-09-27 に確認）。

候補の条件（2026-09-27 に確認）：

- Cloudflare Turnstile：無料の版は 20 個のウィジェット、ウィジェットごとに 10 個のホスト名まで。任意のホスト名は Enterprise。トークンは 300 秒・1 回限りで、サーバーから siteverify を呼ぶ（[Plans](https://developers.cloudflare.com/turnstile/plans/)、[Server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)）。
- Google reCAPTCHA：組織ごとに月 10,000 回の評価まで無料（[Compare tiers](https://docs.cloud.google.com/recaptcha/docs/compare-tiers)）。
- hCaptcha：Pro は年払いで月 99 USD、10 万回。受動のモードは Pro 以上（[hCaptcha Pro](https://www.hcaptcha.com/pro)）。
- AWS WAF：CAPTCHA は 1,000 回の試行ごと、Challenge は 1,000 回の応答ごとに 0.40 USD。Bot Control は別に課金（[AWS WAF Pricing](https://aws.amazon.com/waf/pricing/)）。本システムは既にエッジで WAF を使う（[infrastructure.md](../architecture/infrastructure.md) の 4.3 節）。

本システムの制約：

- 認証の経路に同期の外部の依存を足さない（[ADR-0005](0005-authentication-path-availability.md)）。第三者の CAPTCHA は siteverify の呼び出しが要る。
- Universal Login は JavaScript なしでもパスワードのログインを完了できる（[ADR-0011](0011-universal-login-rendering-and-transaction.md)）。
- テナントごとにカスタムドメインがあり、ホスト名の数が多い（S1 で最大 1 万）。

## Options

1. **自前のリスクの点数（WAF のラベル、IP・識別子の速度、既知の端末、ブラウザの一貫性、フォームの時間）と、自前の proof-of-work（PoW）のチャレンジ。WAF の Challenge はエッジの後ろ盾。第三者の CAPTCHA は L2 の後にテナントの持ち込みで足す**
2. 第三者の CAPTCHA（Turnstile など）を既定にする
3. WAF の Bot Control と CAPTCHA・Challenge だけに任せる

## Decision

1 を採用する。

- 点数は 0〜100。水準 `low`・`medium`（既定）・`high` で閾値を変える。モードは `never`・`when_risky`（既定）・`always`。流れはログイン・サインアップ・再設定。
- PoW は、トランザクションに結び付き、MAC を付けた 5 分の 1 回限りのチャレンジ。難しさは点数で変える。端末の指紋は取らない。
- JavaScript なしの要求は、チャレンジを求められた時点で先へ進めず、IP のバケツを強く絞る。
- 大きな攻撃では、テナントの全体を WAF の Challenge に切り替える（runbook）。
- 第三者の CAPTCHA は、L2 の結論の後に、テナントが自分のキーを持ち込む形で足す。足すときは ADR-0005 の縮退の表に「提供者が落ちたら PoW に切り替える」を先に加える。
- 2 は、外部への同期の依存と、端末の情報の外部への送信（L2）を既定にする。テナントのホスト名の数で無料の版に収まらない。
- 3 は、テナントごとの設定と識別子ごとのシグナルを使えず、WAF の CAPTCHA は画面の体験をテナントのブランドに合わせにくい。

## Consequences

- 良くなること：
  - 外部の依存と外部送信なしで、テナントの設定だけでボットを抑えられる。
  - 利用者の操作が要らず、画像のパズルがないので、アクセシビリティの問題が少ない。
- 引き受けるコスト：
  - PoW は、計算の資源を持つ攻撃者には費用を上げるだけで、止めはしない。点数と IP・識別子の数の組み合わせで補う。
  - 点数の重みを自分で調整し続ける必要がある。
  - JavaScript を切った正規の利用者は、攻撃の最中にログインしにくい。

## Confirmation

- 性質ベーステスト：同じチャレンジの解は 2 回通らない。別のトランザクションの解は通らない。`monitor` はチャレンジしない。
- 模擬の試験（E8）：K5 の基準を、JavaScript を実行するボットとしないボットの両方で満たす。
- 指標：チャレンジの成功率 95% 以上、解くまでの時間の p95 3 秒以内。

## References

- 設計の詳細：[attack-protection.md](../architecture/attack-protection.md) の 6 節

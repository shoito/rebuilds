---
status: accepted
date: 2026-09-27
---

# ADR-0038: カスタムドメインは TXT で所有を確かめてから配信のテナントを作り、証明書は CloudFront の管理に任せる

## Context

テナントは、ログインの画面を `login.example.co.jp` のような自社のドメインで出したい。カスタムドメインは、フィッシングへの耐性（利用者が見るドメイン）、パスキーの RP ID、ブラウザのサードパーティ Cookie の制限の点で重要である。S1 は 1 テナントに 1 つ、複数は S2 以降（[ADR-0002](0002-tenancy-and-isolation.md)）。エッジは CloudFront のマルチテナントの配信の「配信のテナント」で受けると決めた（[ADR-0058](0058-edge-and-custom-domains.md)）。この ADR は、ドメインの登録から削除までの流れ、所有の確認、証明書を決める。

本家 Auth0 の振る舞い（2026-09-27 に確認）：

- 証明書は「Auth0 が管理する」か「自分で管理する」を選ぶ。Auth0 が管理する場合は、CNAME のレコードで確かめ、証明書を 3 か月ごとに自動で更新する。CNAME は更新のために常に置いておく必要があり、CNAME のフラット化は支援しない。DNS の事業者のプロキシが有効だと、確認が終わらない（[Configure Custom Domains with Auth0-Managed Certificates](https://auth0.com/docs/customize/custom-domains/auth0-managed-certificates)）。
- 自分で管理する場合（Enterprise）は、TXT のレコードで確かめ、リバースプロキシが `cname-api-key` のヘッダーを付けて送る。キーは 1 回だけ表示される（[Self-Managed Certificates](https://auth0.com/docs/customize/custom-domains/self-managed-certificates)）。
- 既存のテナントにカスタムドメインを足すと、既存のセッションは無効になり、再ログインが要る。トークンの `iss` は要求に使ったドメインになる。メールのリンクもカスタムドメインを使う（[Custom Domains](https://auth0.com/docs/customize/custom-domains)）。
- 複数のカスタムドメインは Enterprise で、基本の上限は 1 テナント 20（[Multiple Custom Domains](https://auth0.com/docs/customize/custom-domains/multiple-custom-domains)）。

AWS の事実（2026-09-27 に確認）：

- 配信のテナントは、CloudFront が管理する証明書を ACM に求められる。検証は HTTP で、`ValidationTokenHost` が `cloudfront`（CloudFront が検証のファイルを返す）か `self-hosted`。ドメインがすでに別の CloudFront を向いているときは `_cf-challenge.<domain>` の TXT が要る。1 テナントに保留中の要求は 1 つだけ。更新は CloudFront が自動で行う。秘密鍵は取り出せない（[Request certificates for your CloudFront distribution tenant](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/managed-cloudfront-certificates.html)）。
- 配信のテナントは既定で 1 アカウント 1 万、1 テナントのドメインは 100 まで（[Quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)）。
- ACM の DNS の検証は 72 時間で時間切れになる（[DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)）。

## Options

所有の確認：

1. **本システムが発行した値の TXT のレコード（`_<brand>-challenge.<domain>`）で所有を確かめ、その後に CNAME を本システムのエッジへ向けてもらう**
2. 本家と同じく、CNAME のレコードだけで確かめる
3. HTTP のファイルで確かめる

証明書：

- a. **CloudFront が管理する証明書（HTTP の検証）**
- b. テナントの持ち込みの証明書（ACM へのインポート）
- c. 本家の「自分で管理する」と同じ、テナントのリバースプロキシの後ろに置く形

## Decision

1 と a を採用する。b と c は MVP の後に、需要を見て扱う。

- **所有の確認を、ドメインを向ける前に行う。** CNAME だけの確認（2）では、CNAME を消し忘れた古いドメインを、他のテナントが登録して乗っ取れる（dangling CNAME）。TXT の値はテナントとドメインの組ごとに 128 ビットの乱数で作り、ドメインが消えるまで置いておいてもらう。
- **DNS の確認は、本システムの Worker が行う。** 複数の公開の DNS の問い合わせ先（異なる事業者の再帰のリゾルバー）で同じ値が見えることを確かめる。1 つの問い合わせ先の汚染で確認が通らないようにする。
- **確認の後に配信のテナントを作り、証明書を求める。** テナントには、`login.example.co.jp CNAME <tenant-id>.edge.jp.<brand>.<domain>` を設定してもらう。CNAME の向き先は、テナントごとの名前にする（配信のテナントのエンドポイントへの CNAME を本システムの DNS で持つ）。証明書の HTTP の検証は `ValidationTokenHost=cloudfront` で行う。
- **状態**：`pending_verification` → `verified` → `provisioning` → `ready` → （`failed`・`suspended`・`deleting`）。遷移は下の表と、[custom-domains.md](../architecture/custom-domains.md) の 3 節の状態の図のとおり。
- **定期の確認**：`ready` の後も、TXT と CNAME を 24 時間ごとに確かめる。TXT が 7 日続けて見えないときは、ダッシュボードとメールで警告し、30 日で `suspended`（配信を止める）にする。CNAME が他へ向いたときは、証明書の更新が失敗する前に警告する。
- **有効化の条件**：`ready` になったドメインで、本システムが `https://<domain>/.well-known/<brand>-domain-check` を取り、テナントの ID の入った応答が返ることを確かめてから、`tenant_hostnames` に書く（[ADR-0039](0039-hostname-resolution-and-issuer.md)）。
- **削除**：`deleting` にして `tenant_hostnames` から消し、配信のテナントを消す。同じドメインを他のテナントが登録するには、新しい TXT の確認を通す。削除から 30 日は、同じテナントだけが同じ TXT で復活できる。
- **ドメインの制約**：公開のサフィックスそのもの（`co.jp` など）、本システムのドメイン、IDN の混在で見分けにくいもの（Punycode で、異なる文字体系を混ぜたもの）を拒否する。ワイルドカードは受けない。apex（`example.co.jp`）は、CNAME を置けない DNS が多いので、ALIAS・CNAME のフラット化に対応した DNS に限って許す（証明書の更新が止まる危険を画面で示す）。
- 3 は、ドメインを本システムへ向けた後でないと確かめられず、1 の順序が守れない。
- b は、テナントが証明書の期限を管理することになり、期限切れがそのままログインの停止になる。c は、テナントのプロキシの誤りでヘッダーの偽装や TLS の弱い設定が入る。どちらも Enterprise 向けの機能として MVP の後に検討する。

## Consequences

- 良くなること：
  - dangling CNAME によるドメインの乗っ取りを、所有の確認で防げる。
  - 証明書の発行と更新を運用しない。
- 引き受けるコスト：
  - テナントは TXT と CNAME の 2 つのレコードを置く（本家は CNAME 1 つ）。
  - CloudFront の管理する証明書に依存するので、証明書の発行の失敗（CAA のレコードで Amazon が許されていないなど）を、テナントに分かる言葉で示す必要がある。
  - 既存のテナントがカスタムドメインを足すと、SSO のセッションの Cookie はホスト名ごとなので、利用者は再ログインになる（本家と同じ）。

## Confirmation

- 結合テスト（staging）：TXT なしでは配信のテナントが作られない。TXT を消して 30 日相当の時刻を進めると `suspended` になり、要求がオリジンに届かない。
- 性質ベーステスト：任意の 2 テナントが同じドメインを登録しようとしたとき、TXT の確認を通したほうだけが `verified` になり、同時に 2 つが `ready` にならない。
- 結合テスト：CAA で Amazon を許していないドメインで、`failed` と理由（`caa_forbidden`）が返る。

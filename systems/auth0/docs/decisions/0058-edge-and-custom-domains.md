---
status: accepted
date: 2026-09-27
---

# ADR-0058: エッジは CloudFront＋WAF にし、カスタムドメインは CloudFront のマルチテナントの配信のテナントとして受ける

## Context

認証の経路のすべての要求は、エッジを通る（[ADR-0005](0005-authentication-path-availability.md)）。エッジで行うこと：

- TLS の終端、HSTS
- WAF：IP のレート制限、明らかな攻撃の遮断、ボットの抑制
- discovery・JWKS を S3 から配り、オリジンの障害中も古い版を返す
- テナントのカスタムドメイン（S1 は 1 テナントに 1 つ）の TLS

カスタムドメインの証明書の発行と更新、所有の確認、ホスト名からテナントの解決は custom-domains の領域が決める。この ADR は、エッジで何を使うかを決める。

AWS の事実（2026-09-27 に確認）：

- CloudFront のマルチテナントの配信（SaaS Manager）は、設定の雛形になる配信と、ドメインごとの「配信のテナント」からなる。テナントごとに WAF の web ACL、証明書を変えられる。テナントの証明書は、CloudFront が ACM に HTTP の検証で発行を求め、更新も CloudFront が行う。秘密鍵は取り出せない（[Request certificates for your CloudFront distribution tenant](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/managed-cloudfront-certificates.html)、[Understand how multi-tenant distributions work](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-config-options.html)）。
- 配信のテナントは、既定で 1 アカウント 1 万まで（引き上げを申請できる）。マルチテナントの配信は 20、接続グループは 100（[Quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)）。
- 通常の配信の代替ドメイン名（CNAME）は、既定で 1 配信に 100。1 つの配信に付けられる証明書は 1 つ（同上）。
- 1 配信の毎秒の要求数の既定の上限は 250,000（同上。引き上げを申請できる）。
- オリジングループのフェイルオーバーは、`GET`・`HEAD`・`OPTIONS` の要求だけで働く。`POST` では働かない（[origin failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)）。

## Options

カスタムドメインの受け方：

1. **CloudFront のマルチテナントの配信の、配信のテナントにする。** 証明書は CloudFront が管理する
2. 通常の配信にカスタムドメインを代替ドメイン名として足す。証明書は ACM で本システムが発行する（100 ドメインごとに配信を分ける）
3. 自前の TLS の終端（NLB＋Envoy など）で、Let's Encrypt の証明書を自前で発行・更新する

## Decision

1 を採用する。

- **本システムのドメイン（`*.jp.<brand>.<domain>`）は、通常の配信 1 つで受ける。** 証明書はワイルドカードの 1 枚（ACM、DNS の検証）。
- **カスタムドメインは、マルチテナントの配信の、テナントごとの配信のテナントにする。** 雛形の配信は、認証の経路と同じオリジン・ビヘイビア・WAF を持つ。
  - テナントのカスタムドメインを受けたら、Worker が edge のアカウントのロールで配信のテナントを作り、CloudFront が管理する証明書を求める（検証の方式は custom-domains の領域で決める）。
  - 1 テナント 1 つ（S1）なので、S1 の本番のテナント 3,000 のすべてが使っても、既定の 1 万に収まる。S2（本番 3 万）の前に、上限の引き上げか、アカウントを分けるかを決める。
- **オリジンへは、ホスト名をそのまま伝える。** Auth は `Host`（CloudFront が付ける元のホスト名のヘッダー）からテナントを解決する（[ADR-0002](0002-tenancy-and-isolation.md)）。オリジンは CloudFront からの要求だけを受ける（ALB のセキュリティグループを CloudFront のマネージドプレフィックスリストに限り、加えて秘密のカスタムヘッダーを検査する）。
- **discovery・JWKS**：テナントごとに S3 へ書き出し、S3 のオリジン（東京）と、大阪の S3（レプリケーション）をオリジングループにする。`GET` なのでフェイルオーバーが働く。キャッシュの期間と、古い版を返す期間は keys-and-secrets の領域で決める。
- **`POST` の要求（`/oauth/token`、ログインの送信）は、オリジングループでは切り替わらない。** リージョンの切り替えは、配信のオリジンの設定を大阪の ALB に変えて行う（[ADR-0060](0060-disaster-recovery-and-stages.md)）。
- **WAF**：認証の経路の web ACL を、通常の配信と雛形の配信に付ける。値は [infrastructure.md](../architecture/infrastructure.md) の 4.3 節。
- 2 は、ドメインの追加のたびに配信の設定を書き換え、100 ごとに配信を増やす運用になる。配信の設定の書き換えは、全ドメインに効く変更の反映（数分）を伴い、1 つのテナントの操作が他のテナントの配信に影響する。3 は、TLS の終端と証明書の自動化を自前で持ち、DDoS の防御とエッジのキャッシュを失う。

## Consequences

- 良くなること：
  - カスタムドメインの証明書の発行・更新を、自前で持たない。
  - テナントのドメインの追加・削除が、他のテナントの配信に影響しない。
- 引き受けるコスト：
  - CloudFront のマルチテナントの配信に固有の制約（使えない機能：継続的デプロイ、レガシーの標準ログなど）を受ける。エッジの設定の変更は、staging の雛形の配信で先に試す。
  - 証明書の秘密鍵を持たないので、CloudFront を使わない形への移行では、証明書を発行し直す必要がある。
  - AWS Firewall Manager のポリシーは、マルチテナントの配信に効かない（同上の資料。今後対応とある）。WAF の設定は Terraform で直接管理する。
  - S3（ピーク 30 万件/秒のトークンの発行）では、1 配信の毎秒の要求数の既定の上限（25 万）を超える。セルごとに配信を分けるか、引き上げを申請する（[ADR-0060](0060-disaster-recovery-and-stages.md)）。

## Confirmation

- 結合テスト（staging）：カスタムドメインの配信のテナントを作り、証明書の発行の後、そのドメインで `/authorize` から `/oauth/token` まで通る。削除した後、そのドメインへの要求がオリジンに届かない。
- 合成監視：本番の監視用のテナントのカスタムドメインで、1 分ごとにログインとトークンの発行を試す。
- 訓練：東京の S3 のオリジンを止め、JWKS が大阪の S3 から返ることを確かめる（四半期）。

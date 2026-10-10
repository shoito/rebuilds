---
status: accepted
date: 2026-10-10
---

# ADR-0010: エッジの KeyValueStore は要求の多いホストだけを持つ「熱い集まり」（4 MB まで）にし、集まりにないホストは全体の面の `edge-router` が `shop-directory` で引いてポッドへ中継する。独自のドメインは CloudFront のマルチテナントの配信のテナントと CloudFront が管理する証明書で受ける。全体の面からポッドへの読み出しの写しを、ポッドをまたぐ経路 P5 として足す

## Context

- [ADR-0002](0002-pods-and-shop-placement.md) は、エッジの CloudFront Functions が KeyValueStore でホスト → ショップ・ポッドを引くと決めた。
- KeyValueStore は 1 つの保存が 5 MB、1 つの関数に結べる保存は 1 つ、値は 1 KB まで（[CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、2026-10-10 に確認）。1 ホストの鍵と値は 70〜90 バイト（`fine` の型は 260 バイト前後。[storefront-api-and-caching.md](../architecture/storefront-api-and-caching.md) の 7 節）で、5 MB に入るのは 6 万ホストほど。S1 の登録 10 万ショップと独自のドメインは入らない。S3 の 500 万ショップは、配信を分けても入らない。
- ストアフロントの要求はショップの間で大きく偏る。登録したショップの多くは、試用・準備中・要求の少ないショップである。
- 独自のドメインには TLS の証明書が要る。標準の配信の別名は 100（引き上げ可）で、ショップごとの証明書を 1 つの配信に積めない。CloudFront のマルチテナントの配信は、テナントごとにドメインと、CloudFront が管理する証明書（HTTP の検証、自動の更新）を持てる。テナントはアカウントあたり 10,000（引き上げ可）（[Multi-tenant distributions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-config-options.html)、[Managed certificates](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/managed-cloudfront-certificates.html)、2026-10-10 に確認）。
- [app-platform-and-apis.md](../architecture/app-platform-and-apis.md) は、全体の `app-registry` のアプリの定義をポッドへ写す経路が、ADR-0002 の P1〜P4 にないことを持ち越した。

## Options

振り分けの表：

1. **KeyValueStore は熱い集まりだけ。集まりにないホストは `edge-router` が引いて中継する**
2. 配信を複数に分け、それぞれの関数と KeyValueStore に全ホストを分けて持つ
3. Lambda@Edge（origin request）で全体の DB を引く

独自のドメイン：

- a. **マルチテナントの配信のテナント（ショップごと）と、CloudFront が管理する証明書**
- b. 標準の配信の別名と、ACM の SAN の証明書をまとめて持つ
- c. 自前の TLS の終端（NLB と証明書の自動の発行）

## Decision

1 と a を採用する。詳細は [shops-and-pods.md](../architecture/shops-and-pods.md) の 5・6 節。

- KeyValueStore の上限を 4 MB とし、3.5 MB を超えたら要求の少ないホストから外す。`edge-router` が中継したホストのうち、5 分で 30 件を超えたものを入れる。セール・隔離のポッド・移し替え中・プラスのプランのショップは固定の枠（1 MB）に入れる。
- `edge-router`（全体の面、Fargate、VPC origin）は、`shop-directory` の値をメモリーに 30 秒持ち、ポッドの内部の ALB へ中継する。中継した応答の `s-maxage` を 10 秒に切り詰める（世代の番号なしでも NFR-011 の p95 10 秒）。
- 値の形は `v1|<shop_short>|<pod>|<state>|<gen>[|…]`。`state` は `a`・`p`・`f`・`c`・`r`。移し替えの停止はエッジに出さない。
- 既定のドメイン `<handle>.<brand>.<domain>` は、マルチテナントの配信 `mtd-storefront` の 1 つのテナント（ワイルドカードの共有の証明書）で受ける。独自のドメインを持つショップだけ、ショップごとのテナントを作る。
- **P5（足す経路）**：全体の面の定義（アプリの定義、プランの上限、言語・通貨の表）を、SNS でポッドへ配り、ポッドの DB の写しの表（`*_replica`、RLS の外、ショップのデータの列を持たない）に当てる。ポッドの要求は全体の Aurora を直接読まない。[ADR-0002](0002-pods-and-shop-placement.md) の P1〜P4 と [ADR-0003](0003-tenancy-and-rls.md) の RLS の外の表の一覧に、この ADR で足す。

### 他の案を選ばなかった理由

- **2（配信を分ける）**：既定のドメインのワイルドカードは 1 つの配信にしか置けず、ホストを配信に分けるには、ホストごとの DNS と別名が要る。S3 の 500 万ショップでは配信の数も足りない。
- **3（Lambda@Edge）**：キャッシュの鍵（世代の番号）は viewer request で要り、origin request では遅い。外れのたびに東京の DB へ往復する。
- **b（SAN の証明書）**：1 つの証明書の名前の数と、1 つの配信の別名の数に上限があり、1 つの事業者の DNS の失敗が証明書の更新を巻き込む。
- **c（自前の TLS）**：エッジのキャッシュと WAF を独自のドメインで使えない。

## Consequences

- 良くなること：
  - KeyValueStore の大きさが、登録したショップの数でなく、要求の多いショップの数で決まる。
  - 独自のドメインの証明書の発行と更新を CloudFront に任せられる。
  - アプリの定義の写しの経路が明示になる。
- 引き受けるコスト：
  - 集まりにないショップの最初の要求は、`edge-router` の中継の分（p95 20ms）遅い。`edge-router` が止まると、集まりにないショップが届かない。
  - 熱い集まりの入れ替えの仕組み（要求の数え上げ、固定の枠）を持つ。
  - テナントの数の上限の引き上げを申請し続ける（天井は**未検証**）。
  - ADR-0002 の本文の P1〜P4 と、ADR-0003 の RLS の外の表の一覧は、この ADR と合わせて読む。

## Confirmation

- 性質ベーステスト：PROP-POD-001（2 つの経路の振り分けが一致）、PROP-POD-002（4 MB を超えない、固定の枠は外れない）。
- 試験のベクトル：CloudFront Functions の JavaScript と `edge-router` の TypeScript が、同じホストの表で同じ結果を出す。
- スキーマの検査：`*_replica` の表が `shop_id` を持たず、全体の写しの区分の一覧にある。
- 監視：熱い集まりの大きさ、`edge-router` の中継の数と遅れ、証明書の期限（[observability.md](../architecture/observability.md)）。

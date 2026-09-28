---
status: accepted
date: 2026-09-28
---

# ADR-0049: アカウントとネットワークは他の題材の形を引き継ぎ、WebSocket も CloudFront → ALB を通す。Gateway は接続の数でスケールしてスティッキーにせず、Writer は内部だけ、顧客の指定する宛先への送信は egress の専用の経路にする

## Context

本システムの入口は、画面の静的な資産、Sync API（HTTP）、Sync Gateway（長く続く WebSocket。S1 のピークで 6 万接続）、公開 API、連携の受け口である。Writer はすべての書き込みの入口で、外に出さない（[ADR-0006](0006-transactions-writer-and-idempotency.md)）。Webhook・自前の GitLab・インポートの元は、顧客の指定する宛先で、SSRF の踏み台になりうる。

事実（2026-09-28 に確認）：

- CloudFront は WebSocket を HTTP/1.1 で扱い、オリジンのリクエストポリシーで `Sec-WebSocket-*` のヘッダーを転送する（[Use WebSockets with CloudFront distributions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/distribution-working-with.websockets.html)）。
- ALB のアイドルの時間切れは 1〜4,000 秒（既定 60 秒）（[Edit attributes for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)）。
- CloudFront は、オリジンからクライアントへ 10 分流れない WebSocket を切る（Slack の題材の infrastructure.md で確認済み）。

## Options

WebSocket の入口：

1. **CloudFront → ALB（他の HTTP と同じ入口、WAF）**
2. NLB を直接インターネットに出す
3. API Gateway の WebSocket の API

Gateway の配置：

- a. **スティッキーにしない。接続のあるワークスペースのチャンネルを各タスクが購読する**
- b. ワークスペースごとにタスクを割り当てる

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 1〜3 節。

- アカウント（management、security、log-archive、shared、edge、dev、staging、prod）と SCP は Auth0 の題材と同じ。
- VPC は public・private・egress・isolated の 4 種のサブネット。Webhook・自前の GitLab・Jira のサイト・添付の取り出しは egress の `worker-egress` から専用の NAT で送り、本体の VPC エンドポイントと DB への経路を持たない。決まった宛先は private から Network Firewall の許可リストで。
- ホスト名：`<brand>.<domain>`（画面、`/api/auth/*`、`/sync/*`、`/sync/ws`）、`api.<brand>.<domain>`（GraphQL、OAuth、`/hooks/*`）、`<brand>usercontent.<domain>`（添付）、`update.<brand>.<domain>`（Electron の更新）。
- WebSocket は CloudFront → `alb-app` → `gateway`。ALB のアイドルの時間切れは 120 秒。Gateway の 20 秒の ping で CloudFront の 10 分の切断に当たらない。
- ECS（Fargate、ARM64）のサービス：`auth`、`sync-api`、`gateway`、`writer`、`public-api`、`relay`、`worker-*`、`worker-egress`。Gateway は接続の数（目標 1 タスク 3,000）でスケールし、縮める時は 10 分で逃がす。Writer は Service Connect（HTTP/2、TLS）の内部だけ。Relay は 64 の区画を期限つきの鍵で分け合う。
- OpenSearch は isolated のサブネット、3 AZ、1 時間ごとのスナップショットを大阪へ。
- 2 を採らない理由：WAF と、他の入口と同じ TLS・証明書・ログの統制が外れる。DDoS の対策を別に持つ必要がある。
- 3 を採らない理由：接続の最大の時間と、アイドルの時間切れの制限（2 時間・10 分と記憶しているが、この工程で AWS の文書で確かめられなかった。**未検証**）があり、長く続く同期の接続に合わない。接続ごとの課金も、6 万の常時の接続では高い。範囲の証明と欠けの埋め（[ADR-0007](0007-sync-actions-and-range-proof-deltas.md)）をタスクの状態で持つ設計とも合わない。
- b を採らない理由：ワークスペースの割り当てと、その交代の仕組みが要る。S1 の規模では、Valkey の複製の量（[capacity.md](../architecture/capacity.md) の 5.2 節）で足りる。S2 で見直す。

## Consequences

- 良くなること：
  - すべての入口が同じ統制（WAF、TLS、ログ）を通る。
  - Gateway のタスクが落ちても、どのタスクにも再接続できる。
  - 顧客の指定する宛先への送信が、本体の資源に届かない。
- 引き受けるコスト：
  - WebSocket のデータ転送に CloudFront の料金がかかる（[infrastructure.md](../architecture/infrastructure.md) の 11 節）。
  - 大きなワークスペースの差分が、多くの Gateway のタスクに複製される。
  - ALB の keepalive の期間が WebSocket に当たるか、CloudFront の WebSocket の上限は未検証。

## Confirmation

- Terraform のポリシー検査：isolated・egress の経路、ALB のアイドルの時間切れ、KMS の鍵の主体。
- E1 の結合の確かめ：CloudFront 経由の WebSocket が 1 時間以上続く（ping あり）。
- E12 の L4（再接続の殺到）。

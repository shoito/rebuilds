---
status: accepted
date: 2026-10-04
---

# ADR-0043: AWS のアカウントとネットワークは他の題材の形を引き継ぐ。画面・API・予約ページは CloudFront を通し、CalDAV は WebDAV のメソッドを通すため CloudFront を通さず WAF つきの ALB で受ける。iMIP は東京の SES の受信を主、大阪を副の MX にする。利用者の決める宛先（ICS の購読、Webhook）は egress の経路から、Web Push は配信のサービスの許可リストだけへ出す

## Context

[architecture/README.md](../architecture/README.md) の 1.2 節は、CloudFront＋WAF の後ろに、静的な資産・予約ページ・API・CalDAV を置く絵を描いた。他の題材（Linear・Slack・Auth0 の infrastructure.md）は、アカウントを management・security・log-archive・shared・edge・dev・staging・prod に分け、prod の VPC を public・private・egress・isolated のサブネットに分けている。

この題材に固有の事情がある。

- **CalDAV は WebDAV のメソッドを使う。** `PROPFIND`・`PROPPATCH`・`REPORT`・`OPTIONS` が要る（[ADR-0007](0007-interop-standards-scope.md)）。CloudFront の「許すメソッド」は、`GET, HEAD`、`GET, HEAD, OPTIONS`、`GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE` の 3 つの組から選ぶ形で、`PROPFIND`・`REPORT` を選べない（[Cache behavior settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html)、2026-10-04 に確認）。ALB のリスナーの規則は、標準と独自の HTTP のメソッドを条件に書ける（[Condition types for listener rules](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html)、2026-10-04 に確認）。
- **iMIP の受信は SES の受信を使う。** SES の受信は東京（`ap-northeast-1`）と大阪（`ap-northeast-3`）の両方で使える（[Amazon SES endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html)、2026-10-04 に確認）。
- **外へ出る宛先が 3 種類ある。** ICS の購読の URL と Webhook の宛先は利用者が決める（SSRF の踏み台になりうる）。Web Push の宛先はブラウザの事業者の配信のサービスで、購読の `endpoint` は利用者のブラウザが決めた URL として届く。メールは SES。
- データは日本に置く（[intent.md](../intent.md)）。Web Push の配信のサービスはブラウザの事業者が運営し、国外にありうる（法務の L4）。

## Options

CalDAV の入口：

1. **CloudFront を通さず、`dav.<brand>.<domain>` を WAF つきの ALB で受ける**
2. CloudFront で受け、`PROPFIND`・`REPORT` を `POST` に包むようクライアントに求める
3. NLB で TCP のまま受け、タスクで TLS を終える

iMIP の受信：

- a. **東京の SES の受信を主（MX の優先 10）、大阪を副（同 20）にする**
- b. 東京だけ（大阪は切り替えのときに MX を書き換える）

外への送信：

- x. **利用者の決める宛先は egress のサブネット（専用の NAT、DB への経路なし）から出す。Web Push は private から Network Firewall の許可リスト（配信のサービスのホスト名）へ出す**
- y. すべて private の NAT から出す

## Decision

1・a・x を採用する。

### アカウント

他の題材と同じ（management、security、log-archive、shared、edge、dev、staging、prod）。SCP で東京・大阪以外のリージョンを禁止する（CloudFront・WAF・ACM のための us-east-1 のグローバルなサービスを除く）。

### ホスト名と入口

| ホスト名 | 入口 | 行き先 |
| --- | --- | --- |
| `calendar.<brand>.<domain>` | CloudFront（WAF） | 殻（S3）、`/tzdata/<version>/*`（S3、変わらない）、`/rt` → `alb-app` → `realtime`（WebSocket）、`/.well-known/caldav` → `dav.<brand>.<domain>` へのリダイレクト |
| `api.<brand>.<domain>` | CloudFront（WAF） | `alb-app` → `api`（`/v1`。公開 API と自社の画面の API は同じ。[ADR-0026](0026-public-rest-api-shape.md)） |
| `auth.<brand>.<domain>` | CloudFront（WAF） | `alb-app` → `auth`（ログイン、SSO、SCIM、OAuth。[accounts-and-orgs.md](../architecture/accounts-and-orgs.md)） |
| `book.<brand>.<domain>` | CloudFront（WAF、ボットの対策の規則を別に） | 殻（S3）、`/api/*` → `alb-app` → `booking` |
| `ics.<brand>.<domain>` | CloudFront（WAF） | `alb-app` → `api`（ICS の公開。[ADR-0025](0025-ics-subscriptions-both-directions.md)。秘密のアドレスの経路をログに残さない。[security.md](../architecture/security.md) の 7 節） |
| `dav.<brand>.<domain>` | **ALB（`alb-dav`、AWS WAF を ALB に付ける、Shield Standard）** | `caldav` |
| `imip.<brand>.<domain>` | MX：東京の SES の受信（10）、大阪の SES の受信（20） | S3 → SNS → SQS → `imip-inbound` |
| `mail.<brand>.<domain>` | SES の送信（DKIM）、MAIL FROM は `bounce.mail.<brand>.<domain>` | — |

- `alb-dav` は public のサブネットに置き、TLS 1.2 以上の方針、HTTP/1.1。WAF は IP ごとのレート制限、Basic 認証の失敗の数の規則（[security.md](../architecture/security.md) の 3.3 節）、本文の大きさ（2 MiB）を持つ。
- DNS の SRV（`_caldavs._tcp.<brand>.<domain>` → `dav.<brand>.<domain>:443`）と TXT（`path=/dav/`）を置く（RFC 6764）。
- DR では、`dav.<brand>.<domain>` の Route 53 のレコードを大阪の `alb-dav` へ切り替える（CloudFront の配信のオリジンの切り替えと同じ手順の中で行う）。

### サブネットと外への送信

| サブネット | 置くもの | 外への経路 |
| --- | --- | --- |
| public | `alb-app`、`alb-dav`、NAT | Internet Gateway |
| private | `api`、`caldav`、`realtime`、`booking`、`auth`、`relay`、`worker-*`（下の 2 つを除く） | NAT → Network Firewall（許可リスト：SES と AWS のエンドポイント、IdP のメタデータ、Web Push の配信のサービス） |
| egress | `ics-fetcher`、`push-sender`（Webhook） | 専用の NAT（Elastic IP を公開する）。VPC エンドポイントと isolated への経路を持たない |
| isolated | Aurora、ElastiCache（Valkey） | なし |

- `ics-fetcher` と `push-sender` は DB に触れない。結果は SQS で private の Worker に渡す。名前解決の後の IP の検査とリダイレクトの扱いは [ADR-0040](0040-untrusted-calendar-input-gate.md)。
- Web Push の `notifier` は private から出す。購読の `endpoint` のホスト名を許可リストで確かめてから送る。許可リストの正確な値（ブラウザごとの配信のサービスのホスト名）は、E9 で各ブラウザの購読の応答から集めて確かめる（**未検証**）。
- SES・SQS・SNS・S3・KMS・Secrets Manager・AppConfig・CloudWatch Logs・X-Ray・ECR・STS は VPC エンドポイントで使う。

### サービスの配置

[architecture/README.md](../architecture/README.md) の 1.2 節のコンテナを、ECS Fargate（ARM64）の別のサービスにする。台数は [capacity.md](../architecture/capacity.md) の 6 節。`packages/writer` はライブラリで、`api`・`caldav`・`booking`・`worker-*` の中で動く（[ADR-0001](0001-platform-and-stack.md)）。

### 他の案を選ばなかった理由

- **2（`POST` に包む）**：OS の標準のカレンダーは変えられない。
- **3（NLB）**：AWS WAF を付けられず、TLS の証明書の管理と HTTP の層の規則をタスクで持つことになる。
- **b（東京だけ）**：東京の障害の間、外部の返事・招待のメールは送り手の再送に頼る。再送の間隔と期限は送り手次第（**未検証**）で、DR の手順に MX の書き換えを足すことになる。大阪の受信は国内で、データの所在の約束（L4）も変えない。
- **y（すべて private）**：利用者の決める宛先へ、DB と同じ VPC の経路から出ることになる。

## Consequences

- 良くなること：
  - CalDAV が OS の標準のカレンダーのまま動く。
  - 東京の SES の受信が止まっても、外部のメールは大阪に届く。
  - SSRF の踏み台になりうる送信が、DB に届かない経路に閉じる。
- 引き受けるコスト：
  - CalDAV はエッジの CloudFront の守り（エッジでの DDoS の吸収、地理の制限）を使えない。Shield Standard と ALB の WAF で受ける。
  - 大阪の SES の受信が受けたメールを、東京が主の間は東京の処理へ渡す仕組みが要る（[infrastructure.md](../architecture/infrastructure.md) の 6.3 節）。
  - Web Push の配信のサービスの許可リストを保守する必要がある。

## Confirmation

- Terraform のポリシーの検査：isolated の経路表に NAT・IGW がない、egress のサブネットから VPC エンドポイント・isolated への経路がない、`alb-dav` に WAF が付いている、SCP のリージョンの制限。
- 合成監視：`dav.<brand>.<domain>` への `PROPFIND`・`REPORT`、大阪の SES の受信へのテストのメール（[observability.md](../architecture/observability.md) の 6 節）。
- 結合テスト：`notifier` が許可リストの外の `endpoint` に送らない。`ics-fetcher` が私的なアドレスに解ける URL を拒む。

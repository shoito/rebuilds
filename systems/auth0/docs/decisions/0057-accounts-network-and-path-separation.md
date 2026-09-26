---
status: accepted
date: 2026-09-27
---

# ADR-0057: AWS のアカウントを用途で分け、認証の経路と管理の経路を入口・ALB・DB の接続まで分ける

## Context

[ADR-0005](0005-authentication-path-availability.md) は、認証の経路（認可サーバー、Universal Login、Signer）と管理の経路（Management API、ダッシュボード、ログの検索）を、別の ECS のサービスと別の DB の接続プールにすると決めた。どこまで分けるか（入口、ALB、WAF、アカウント）は、この領域で決める。

分ける目的は 2 つ。

- 管理の経路の負荷・障害・デプロイの失敗が、ログインに及ばないこと（NFR-001）。
- 管理の経路への攻撃（Management API のトークンの総当たり、ログの検索の大量の要求）が、認証の経路の容量を食わないこと。

他の題材は、AWS Organizations で management・security・log-archive・shared・dev・staging・prod を分けている（Slack・Stripe の infrastructure.md の 1 節）。

## Options

アカウント：

1. **他の題材と同じ構成に、認証の経路と管理の経路を同じ prod のアカウントに置く**
2. 認証の経路と管理の経路を、別の AWS アカウントにする

経路の分け方：

- a. **ホスト名・CloudFront のビヘイビア・WAF のルール・ALB・ECS のサービス・DB のロールと接続プールを分ける**
- b. ECS のサービスだけを分け、ALB を共有してパスで振り分ける

## Decision

1 と a を採用する。

### アカウント

| アカウント | 中身 |
| --- | --- |
| management | Organizations、SCP、IAM Identity Center、請求 |
| security | GuardDuty・Security Hub・Inspector の委任管理者、調査用のロール |
| log-archive | 組織の CloudTrail、Config、VPC フローログ、監査ログ（[ADR-0054](0054-audit-log.md)、Object Lock） |
| shared | ECR、Route 53（本システムのドメイン）、Managed Grafana、CI の起点 |
| edge | CloudFront の配信とテナントの配信、WAF、ACM（us-east-1）。カスタムドメインの証明書（[ADR-0058](0058-edge-and-custom-domains.md)） |
| dev、staging | 開発・検証 |
| prod | 本番（東京と大阪）。認証の経路・管理の経路・Signer・Worker・Aurora・Valkey |
| actions | Actions（E13、MVP の後）の実行器（Lambda のテナントの隔離のモード）、ビルド（CodeBuild と npm のプロキシ）、束の S3、`actions-egress` の VPC（専用の NAT）。prod の VPC と経路を持たない（[ADR-0049](0049-extensibility-execution-isolation.md)）。E13 の着手時に作る（2026-09-27 の統合で追加） |

- **edge を prod から分ける。** カスタムドメインの追加・削除は、テナントの操作で頻繁に起こり、CloudFront の API を Worker から呼ぶ。この権限を prod のワークロードのロールに与えず、edge のアカウントの狭いロール（テナントの配信の作成・更新・削除だけ）を引き受けさせる。
- **actions を prod から分ける。** テナントの任意のコードを動かす基盤なので、prod の網・ロール・VPC エンドポイントに届かないアカウントに置く。prod の Auth のタスクのロールは、actions のアカウントの関数の `lambda:InvokeFunction` と、束の S3 の署名付き URL の作成だけを持つ。actions のアカウントから prod への経路と、ロールの引き受けは持たない。
- 2 は、認証の経路と管理の経路が同じ Aurora を正本とするので（[ADR-0002](0002-tenancy-and-isolation.md)）、アカウントを分けても DB を共有することになり、分ける利点が小さい。S3 のセル構成では、セルごとにアカウントを分ける（[ADR-0060](0060-disaster-recovery-and-stages.md)）。

### 経路の分け方（a）

| 層 | 認証の経路 | 管理の経路 |
| --- | --- | --- |
| ホスト名 | `<tenant>.jp.<brand>.<domain>`、カスタムドメイン | `<tenant>.jp.<brand>.<domain>/api/v2/*`（本家に寄せる）と、`manage.<brand>.<domain>`（ダッシュボード） |
| CloudFront | 認証の経路のビヘイビア | 管理の経路のビヘイビア（`/api/v2/*`）と、ダッシュボードの配信 |
| WAF | 認証の経路のルール（IP のレート制限、Bot Control、ATP は 4.3 節） | 管理の経路のルール（トークンのエンドポイント以外は `Authorization` のない要求を落とす） |
| ALB | `alb-auth` | `alb-mgmt` |
| ECS | `auth`、`signer` | `mgmt`、`dashboard`（静的な配信のため ECS は持たない） |
| DB | ロール `auth_app`、接続プール（writer・reader） | ロール `mgmt_app`、別の接続プール。重いクエリは reader だけ |

- **Management API のトークンの発行は、認証の経路で行う。** M2M のクライアントクレデンシャルは `/oauth/token` を通る。管理の経路は、そのトークンの検証だけを行う（JWKS をメモリーに持つ）。
- **`/api/v2/*` を CloudFront のビヘイビアで分ける。** 同じホスト名でも、パスで別の ALB に送る。管理の経路の ALB・タスクが落ちても、認証の経路の ALB には影響しない。
- b は、ALB の LCU・接続・デプロイの失敗（リスナーの規則の誤り）を共有し、管理の経路の問題が認証の経路に及ぶ。

## Consequences

- 良くなること：
  - 管理の経路のデプロイ・障害・負荷が、ログインに及ばない。
  - WAF のルールを経路ごとに調整でき、ログインへの攻撃の対策が管理の経路の誤検知を増やさない（逆も同じ）。
- 引き受けるコスト：
  - ALB が 2 つ、CloudFront のビヘイビアとWAF のルールが経路ごとに増える。
  - edge のアカウントとの間のロールの引き受けと、Terraform の状態が 1 つ増える。

## Confirmation

- Terraform の CI（ポリシー検査）：`alb-auth` のターゲットに `mgmt` のサービスがない。`mgmt` のタスクのロールに edge のアカウントのロールの引き受けがない（Worker だけが持つ）。
- 障害の注入（staging、四半期）：`mgmt` のタスクをすべて止めても、ログイン・トークンの発行・JWKS の合成監視が成功し続ける。
- 負荷試験（E12）：Management API のログの検索を上限まで流しながら、NFR-002・NFR-003 を満たす。

---
status: accepted
date: 2026-10-09
---

# ADR-0062: 自己監視は selfmon のアカウントの大阪のリージョンに置き、本番の ADOT のコレクターから VPC の中の `selfmon-relay` を経て AMP と CloudWatch Logs へ送る。アラートは AMP のルールと CloudWatch のアラームから SNS を経てオンコールのサービスへ直接送る。デッドマンスイッチは `canary` の心拍、AMP の Watchdog、送り手の沈黙の 3 段にする

## Context

- 本システムを本システムで監視すると、本システムが止まったときに監視と通知も止まる（[runbooks/](../runbooks/README.md) の 5 節）。runbooks は、別の AWS アカウントの AMP・CloudWatch と、オンコールのサービスへの直接の連携、外からの見張り（`canary`）を決めた。リージョンは決めていない。
- 本番は東京で、DR は大阪（[ADR-0061](0061-dr-stage-up-and-cell-expansion.md)）。東京のリージョンの障害は、本番の最大の障害の 1 つである。
- データの面のサブネットは外への経路を持たない（[ADR-0058](0058-untrusted-senders-egress-and-operator-access.md)）。
- AMP は東京と大阪で提供されている。ワークスペースあたり有効な系列 既定 5,000 万、取り込み 1 秒 166 万の標本（[Amazon Managed Service for Prometheus endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/prometheus-service.html)、2026-10-09 に確認）。
- 監視の経路そのものが止まったことにも気づく必要がある（自己監視の経路の監視）。

## Options

置き場所：

1. **selfmon のアカウント、大阪のリージョン**
2. selfmon のアカウント、東京のリージョン
3. 本番のアカウントの CloudWatch だけ

デッドマンスイッチ：

- a. **3 段（`canary` の心拍、AMP の Watchdog をオンコールのサービスの心拍へ、送り手の沈黙）**
- b. `canary` の心拍だけ

## Decision

1 と a を採用する。

- selfmon（大阪）：AMP（ルールと Alertmanager）、CloudWatch（Logs とアラーム）、SNS、Grafana、`canary`、見張りの受け口。本番と別の DNS のゾーン、秘密の置き場、break-glass の IAM の利用者を持つ。prod のロールを引き受けない。
- 経路：本番のタスクの ADOT のコレクター（EC2 はデーモン、Fargate はサイドカー）→ control のサブネットの `selfmon-relay` → NAT → Network Firewall（大阪の AMP・CloudWatch Logs・トレースのエンドポイントの許可リスト）→ selfmon のアカウントのロールで書く。コレクターは最大 15 分をディスクに溜め、本番のタスクを止めない。
- アラート：AMP のルール → Alertmanager → SNS → オンコールのサービス。CloudWatch のアラーム → SNS → オンコールのサービス。本システムの `notifier` を使わない。
- デッドマンスイッチ：
  - 段 1：`canary` が毎分 `CanaryHeartbeat` を書き、欠けを異常とみなすアラームが取り込み 2 分・通知 3 分で鳴る
  - 段 2：常に鳴る Watchdog を、オンコールのサービスの心拍の受け口へ 1 分ごとに送る。途切れたらオンコールのサービスが呼び出す
  - 段 3：`absent_over_time(svc_up[5m])` と、AMP の書き込みの数の 0 のアラーム
- 本番のアカウントにも、selfmon を失ったときのための最小のアラーム（NLB の 5xx、MSK のオフラインのパーティション、Aurora の可用性）を置く。
- 本番を大阪へ切り替えたときは、selfmon の最小の写し（アラームと `canary`）を東京に起こす。

### 他の案を選ばなかった理由

- **2（東京）**：東京のリージョンの障害で、本番と監視が同時に止まる。最も要るときに気づけない。
- **3（本番のアカウントだけ）**：本番のアカウントの障害（権限の誤り、IAM、DNS）で監視も止まる。運用者が本番に入れないときに調べられない。
- **b（心拍だけ）**：`canary` と CloudWatch のアラームの経路が止まると、何も鳴らない。

## Consequences

- 良くなること：
  - 本番の東京の障害、本番のアカウントの障害、本システムの通知の経路の障害のどれでも、呼び出しが届く。
  - 監視の経路そのものの停止に気づける。
- 引き受けるコスト：
  - 東京 → 大阪の自己の計測の転送の費用。
  - selfmon の運用（別のアカウント、別の認証）。
  - オンコールのサービスの心拍の機能に依る（選ぶサービスで形が違う）。

## Confirmation

- 四半期ごとの訓練：検証のセルで本システムのモニターの評価と通知を止め、段 1 から呼び出しが届く。AMP のルールを止め、段 2 から届く（E13 の `self-monitoring-drill`）。
- Terraform の検査：selfmon のアカウントのリソースが、prod のアカウントのリソース（DNS、秘密、ロール）を参照しない。
- 本番：自己監視の経路の健全の SLI（3 段のどれかが鳴った回数）を見る。

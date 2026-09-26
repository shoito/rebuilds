---
status: accepted
date: 2026-09-26
---

# ADR-0011: AWS 上で、ECS Fargate とマネージドサービスを使って動かす

## Context

本番の実行基盤を決める。今の設計は、次の 4 つを前提にしている。

- 状態を持たない API
- WebSocket を常時保持する Gateway
- PostgreSQL（RLS）
- Redis Pub/Sub

規模は S1（同時接続 5 万）から S3（100 万）へ段階的に広げる。企業顧客から、リージョン・監査・暗号鍵に関する要件が来ることも見込む。

## Options

1. **AWS**：ECS Fargate＋Aurora PostgreSQL＋ElastiCache＋S3＋CloudFront
2. **Cloudflare**：Workers＋Durable Objects＋Hyperdrive＋R2
3. **Kubernetes**（EKS など）で、クラウドに依存しない構成にする

## Decision

1 を採用する。

| 用途 | サービス |
| --- | --- |
| API・Gateway・Relay・Worker の実行 | ECS on Fargate（サービスごとに分け、個別にオートスケールする） |
| HTTP と WebSocket の入口 | CloudFront → ALB。ALB は WebSocket を扱え、アイドルタイムアウトを延ばせる |
| 静的な Web クライアント | S3＋CloudFront |
| DB | Aurora PostgreSQL。3 AZ にまたがる。writer 1 台＋reader、自動フェイルオーバー |
| リアルタイム配信のバス | ElastiCache（Valkey。Redis 互換で、Pub/Sub と sharded pub/sub を使える） |
| Worker 向けキュー | SQS |
| ファイル | S3。配信は CloudFront の署名付き URL |
| メール | SES |
| 鍵と秘密情報 | KMS、Secrets Manager |
| 防御 | AWS WAF、Shield Standard、GuardDuty |
| リージョン | 東京（ap-northeast-1）を主にする。災害復旧に大阪（ap-northeast-3）を使う |

- 今の設計（PostgreSQL、Redis、常時接続の Gateway）を、書き換えずにそのまま載せられる。
- 2 の Durable Objects は、チャンネルごとの順序付けと配信によく合う。ただし、ADR-0001〜0003 と RLS を前提にした設計の大部分を作り直すことになる。企業向けのリージョン・監査要件への対応も読みにくい。
- 3 は移植性が高いが、クラスタそのものの運用が加わる。小さなチームと AI エージェントで持つには、運用の設計が最も大きくなる。

## Consequences

- 良くなること：
  - DB・キャッシュ・キューの冗長化とバックアップを、マネージドサービスに任せられる。
  - IaC で環境を再現できる。IaC の道具は別の ADR で決める。
- 引き受けるコスト：
  - AWS に依存する。セル構成（S3）に移るときも、AWS の上で組むことになる。
  - Fargate は、接続数あたりのコストが EC2 より高くなりうる。Gateway は、S2 以降に EC2 の起動タイプへ移す余地を残す。
  - Aurora が対応する PostgreSQL のバージョンと拡張機能は、本家の PostgreSQL より遅れることがある。

## Confirmation

- 着手前に、次の 2 点を確かめる。
  - Aurora PostgreSQL が、PostgreSQL 18（`uuidv7()`）と pg_bigm に対応しているか。
  - どちらかが未対応なら、UUIDv7 はアプリで生成し、検索は RDS for PostgreSQL か OpenSearch で代替する。その場合は、この ADR と ADR-0004・0009 を更新する。
- 全リソースを IaC で定義し、コンソールからの手作業での変更を禁止する（AWS Config で逸脱を検知する）。

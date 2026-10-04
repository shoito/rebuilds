---
status: accepted
date: 2026-10-04
---

# ADR-0054: アカウントとネットワークは他の題材の形を引き継ぎ、入口は CloudFront → ALB にする。サービスは入口・書き込み・読み出し・消費者・Worker に分けて ECS Fargate に置き、外の宛先への送信は egress の専用の経路にする

## Context

- 基盤は AWS（東京、DR は大阪）、ECS Fargate、Terraform（[ADR-0001](0001-platform-and-stack.md)）。Linear・Auth0・Slack の題材が、アカウント（management、security、log-archive、shared、edge、dev、staging、prod）とネットワーク（public・private・egress・isolated）の形を決めている。
- この題材は、読み出しが書き込みよりずっと多く（S1 でタイムラインの読み出し 1 万件/秒、投稿 300 件/秒）、出来事の消費者が多い（[ADR-0005](0005-event-log-and-outbox.md)）。
- 学習と評価のジョブ（Python、[ADR-0006](0006-ranking-boundary.md)）はデータレイクを読む。本番の DB に届く必要はない。
- リンクのカードの取り出しは、利用者の書いた URL へ外向きに送る（SSRF の危うさ）。

## Options

1. **他の題材の形を引き継ぎ、data のアカウントを足す。サービスを役割で分けて Fargate に置く**
2. 読み出しの経路を Lambda にする
3. 1 つの大きなサービス（モノリス）に入口と書き込みと読み出しをまとめる

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 1〜3 節。

- アカウントに data（データレイク、学習と評価）を足し、本番のサービスと分ける。本人だけの表を data に流さない。
- 入口は CloudFront → ALB（`alb-app`、`alb-api`）。WebSocket も CloudFront を通す。ホスト名は `<brand>.<domain>`、`api.<brand>.<domain>`、`<brand>media.<domain>`、`<brand>.<short-tld>`、`updates.<brand>.<domain>`。
- サービス：入口（`app-api`、`public-api`、`gateway`、`ingest`、`auth`）、書き込み（`post`、`graph`、`engagement`、`dm`、`accounts`、`ts`）、読み出し（`timeline`、`ranking`、`search-api`、`media`）、`relay`、出来事の消費者、SQS の Worker、社内の `ts-console`。すべて Fargate（ARM64）、サービスごとの IAM ロール。
- 書き込みのサービスだけが Aurora の writer に書く。Kinesis に書けるのは Relay と Ingest だけ（IAM と Terraform の検査）。
- リンクのカードの取り出しと後の Webhook は egress の `worker-egress` から送り、本体の VPC エンドポイントと DB への経路を持たない。
- 2 を採らない理由：Valkey と Aurora への接続を大量の同時の実行で持つことになり、接続の数とコールドスタートが読み出しの p99 に乗る。
- 3 を採らない理由：fan-out の Worker や消費者の負荷が、入口の遅延を巻き込む。スケールの指標が役割ごとに違う。

## Consequences

- 良くなること：
  - 他の題材と同じ統制（WAF、TLS、ログ、SCP）を使える。
  - 役割ごとにスケールでき、殺到の時に削る順（[ADR-0060](0060-capacity-headroom-and-load-shedding.md)）を役割で分けられる。
- 引き受けるコスト：
  - サービスの数が多い（30 前後）。タスク定義と IAM ロールの管理が増える。
  - サービスの間の往復が読み出しの経路に乗る。

## Confirmation

- Terraform のポリシー検査：isolated・egress の経路、Kinesis の書き込みの権限、KMS の鍵の主体。
- E1 の結合の確かめ：CloudFront 経由の WebSocket が 1 時間以上続く。

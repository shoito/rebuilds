---
status: accepted
date: 2026-09-28
---

# ADR-0055: セルごとに AWS アカウントを分け、制御の面・エッジ・メールの受信の入口を別のアカウントに置く。ルーターは CloudFront Functions と KeyValueStore でホスト名からセルを選び、セルの App はテナントを解決し直す

詳細は [infrastructure.md](../architecture/infrastructure.md) の 1〜3 節。

## Context

[ADR-0002](0002-tenancy-and-isolation.md) は、セル（アプリのサービス群・Aurora・Valkey・OpenSearch・S3・KMS の組）を S1 の初日から使い、ルーターがホスト名 → テナント → セルをテナントのデータを読まずに解決し、解決できない要求は 404 にすると決めた。対応表は制御の面が持ち、ルーターはキャッシュで制御の面が落ちても動き続ける。

メールの受信も、封筒の受け手 → テナント → セルを、テナントのデータを読む前に解決する（[ADR-0034](0034-inbound-email-threading-and-sender-trust.md)）。

CloudFront Functions は KeyValueStore を読め、要求のオリジンを関数の中で選べる（[Helper methods for origin modification](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html)、[Amazon CloudFront KeyValueStore](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html)、2026-09-28 に確認）。KeyValueStore の上限は、1 つのストアが 5 MB、キーが 512 バイト、値が 1 KB、1 つの関数に 1 つのストア、アカウントに 200 のストア（引き上げ可）である。1 つの配信のオリジンは 100（引き上げ可）である（[CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、2026-09-28 に確認）。書き込みがエッジに届くまでの時間は公式の文書に数値がなく、未検証（E1 `edge-router-kvs` で計測する）。

## Options

### アカウント

1. **セルごとのアカウント（共有のセルも）**
2. 本番を 1 つのアカウントにし、セルを VPC で分ける

### ルーター

- a. **CloudFront Functions と KeyValueStore（エッジ）**
- b. ECS のルーターのサービス（対応表をプロセスのメモリーに持ち、セルの ALB へ転送する）
- c. DNS でテナントごとにセルへ向ける（テナントごとの CNAME）

### メールの受信

- x. **共有の受信の入口（SES と一時のバケット）と `mail-router`。専用のセルは専用の受信のサブドメイン**
- y. セルごとの受信のサブドメイン（`<cell>.in...`）を全テナントで使う

## Decision

1、a、x を採用する。

- アカウント：management、security、log-archive、shared、edge、control（制御の面）、mail-ingress、`cell-*`（共有・専用）、dev、staging。セルの間に経路とロールの引き受けを持たない。
- ルーター：ビューアーの要求の関数が KeyValueStore でホスト名からセルを引き、セルのオリジンを選ぶ。なければ 404。KeyValueStore は制御の面が書く。
- セルの App は、元のホスト名からテナントを制御の面の台帳の写しで解決し直し、そのセルのテナントでなければ 421 にする（テナントの移動の間の古い対応と、ヘッダーの偽りの守り）。
- メール：mail-ingress の SES が `*@in.<brand>.<domain>` を一時のバケットに置き、`mail-router` が台帳でセルを決めてセルのバケットと SQS へ送る。専用のセルは専用の受信のサブドメインで直接受ける。

2 を採らない理由：1 つのセルの誤操作・クォータの消費が、他のセルに及ぶ。専用のセル（顧客ごとのアカウント）と形が分かれ、Terraform のモジュールが 2 つになる。

b を採らない理由：要求の経路に、全セルが共有するサービスが 1 つ増える（その障害で全セルが止まる）。エッジの関数なら、CloudFront の可用性の上で動き、対応表もエッジにある。ADR-0002 の「ルーターのプロセスの中にキャッシュ」は、エッジの KeyValueStore のキャッシュで満たす。

c を採らない理由：テナントの作成・移動のたびに DNS を変え、TTL の間は古いセルに届く。ワイルドカードの証明書と配信を、テナントごとに扱うことになる。

y を採らない理由：テナントを別のセルへ移すと、受信のアドレスが変わり、顧客のメールサーバーの転送の設定を変えてもらうことになる。

## Consequences

- 良くなること：
  - セルの障害と操作の影響をアカウントの単位で閉じる。共有と専用のセルが同じ形になる。
  - ルーターに同期の依存がない。
- 引き受けるコスト：
  - アカウントの数が増える（セルごと）。アカウントの作成を Terraform（`org/`）で自動にする。
  - KeyValueStore の 5 MB と、配信のオリジンの 100（引き上げ可）が、テナントとセルの数の上限になりうる。S3 の 3 万テナントは、1 件 100 バイトで約 3 MB で収まるが余裕は小さい。S3 の前にセルの群ごとに配信とストアを分ける。
  - mail-ingress の一時のバケットに、全テナントの原本が短い時間置かれる。読めるのは `mail-router` だけにする。

## Confirmation

- 結合テスト：未知のホスト名が 404 で、どのセルにも届かない。別のセルのテナントのホスト名を偽ったヘッダーで送ると 421。
- IaC のポリシー検査：セルのアカウントの間の VPC ピアリング・Transit Gateway の接続・ロールの信頼がない。
- 本番の監視：421 の件数（テナントの移動の間以外は 0）。

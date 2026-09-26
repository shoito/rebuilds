---
status: proposed
date: 2026-09-27
---

# ADR-0002: 既定のトピックは、ローカルのディスクの 3 つの複製と S3 への階層型の保存にする

## Context

ログの保存の方式は、遅延・費用・耐久性を大きく左右する。2 つの型がある。

| 型 | 例 | 遅延 | 費用 | 耐久性の源 |
| --- | --- | --- | --- | --- |
| ローカルのディスクで複製し、古いものを S3 へ | 本家の Apache Kafka（KIP-405）、Kora、MSK | 低い（数 ms〜数十 ms） | AZ をまたぐ複製の転送料金が大きい | 3 つの AZ の複製（ISR） |
| S3 を正本にする（ディスクレス） | WarpStream、AutoMQ（WAL は EBS）、Redpanda の Cloud Topics、Confluent の Freight、本家の KIP-1150 | 高い（数百 ms〜数秒） | 複製の転送がなく、S3 の要求の費用が主 | S3 |

公開の値（いずれも 2026-09-27 に確認）：

- WarpStream の produce の遅延は、S3 Standard で p99 約 400ms、S3 Express One Zone で p50 105ms・p99 170ms。Lightning Topics で p50 33ms・p99 50ms だが、冪等なプロデューサーとトランザクションを受け付けず、返すオフセットも正確でない（[WarpStream のブログ](https://www.warpstream.com/blog/the-art-of-being-lazy-log-lower-latency-and-higher-availability-with-delayed-sequencing)、2026-02-04）。
- Redpanda の Cloud Topics の端から端までの遅延は、500ms から数秒（[Redpanda Cloud Topics](https://www.redpanda.com/data-streaming/cloud-topics-write-to-object-storage)）。
- Confluent の Freight は、2026-08 の発表で冪等なプロデューサーとトランザクションに対応したとしている（[2026 Q3 の発表](https://www.confluent.io/blog/2026-q3-confluent-cloud-launch/)）。一方、クライアントの設定の文書は、まだ `enable.idempotence=false` を求めている（[Freight Clients](https://docs.confluent.io/cloud/current/client-apps/optimizing/freight.html)）。どちらが現状かは未検証。
- 本家の KIP-1150 は 2026-03 に採択されたが、実装の KIP-1163・1164 は議論中で、本家の版には入っていない（[Aiven の解説](https://aiven.io/blog/kip-1150-accepted-and-the-road-ahead)）。
- AZ をまたぐ転送は、送信と受信で各 $0.01/GB（[AWS Architecture Blog](https://aws.amazon.com/blogs/architecture/exploring-data-transfer-costs-for-aws-managed-databases/)）。複製 3 では、1 GB の書き込みごとにネットワークだけで約 $0.053 かかる（[architecture/README.md](../architecture/README.md) の NFR-010）。

利用者の主な用途（マイクロサービスの間のイベント、注文・決済の状態の変化）は、遅延に敏感で、トランザクションを使う。一方、ログの取り込みのように、遅延より費用が大事な用途もある。

## Options

1. **ローカルのディスクの複製＋階層型の保存だけ**
2. **S3 を正本にする（ディスクレス）だけ**
3. **1 を既定にし、2 をトピックの種類として後で足す**

## Decision

3 を採用する。MVP（S1）は 1 だけを提供する。

### 既定のトピック（Standard のトピック）

- 複製は 3。AZ ごとに 1 つ（本家の rack の配置）。
- `min.insync.replicas=2`。`acks=all` の書き込みは、2 つ以上の AZ の複製に届いてから成功を返す。
- `unclean.leader.election.enable=false`。ISR の外の複製をリーダーにしない。
- これらはテナントに変えさせない（トピックの設定の許可リストに入れない）。
- ローカルのディスクは EBS（gp3）を候補にする。ブローカーの入れ替えで、ボリュームを付け替えられるため。インスタンスストアとの比較は broker-and-log-storage の領域で行う。
- 閉じたセグメントは、階層型の保存（KIP-405）で S3 へ上げる。ローカルの保持は短く（初期値は数時間。値は capacity の領域で決める）、それより古いものは S3 から読む。
- コンシューマーは、同じ AZ の複製から読む（fetch-from-follower、KIP-392）。AZ をまたぐ読み取りの転送をなくす。

### ディスクレスのトピック（S2、Later）

- 遅延を許せる用途（ログ、分析への取り込み）向けの、別の種類のトピックとして足す。遅延の目標は別に置く（p99 1 秒以内）。
- 本家の KIP-1150 の実装が本家の版に入っていれば、それを使う（[ADR-0001](0001-upstream-brokers-and-stack.md) の方針）。
- S2 の開始の時点で本家に入っていなければ、自前で作るか、提供を遅らせるかを、改めて ADR で決める。その際、冪等なプロデューサーとトランザクションを捨てない（WarpStream の Lightning Topics のような意味の緩和はしない）ことを前提にする。

### 2 を選ばない理由

- 用途の中心が遅延に敏感で、p99 50ms（NFR-003）を S3 Standard では満たせない。
- S3 Express One Zone は 1 つの AZ に置くので、AZ の喪失で RPO 0（NFR-001）を満たすには、複数の AZ に書く仕組みが別に要る。

## Consequences

- 良くなること：
  - 遅延と耐久性は、本家の実装の実績のある構成で得られる。
  - 階層型の保存で、ローカルのディスクが小さくなる。ブローカーの追加・入れ替えで移すデータが減り、伸び縮みが速くなる（NFR-007）。
  - 保持を長くしても、保存の費用は S3 の単価で済む。
- 引き受けるコスト：
  - Standard のトピックでは、AZ をまたぐ複製の転送料金が残る。料金（1 GB あたりの書き込みの単価）に反映する。
  - 階層型の保存は、ローカルと S3 の境界にメタデータの食い違いの危険がある。Kora は、テスト環境でこれによるデータの喪失を観測している（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.6 節）。耐久性の監査の対象に入れる。
  - トピックの種類が 2 つになると、料金・クォータ・互換の範囲（ディスクレスで使えない機能があれば）を、種類ごとに説明する必要がある。

## Confirmation

- 設定のテスト：テナントの設定の API で、`replication.factor`、`min.insync.replicas`、`unclean.leader.election.enable` を変えようとすると拒否される。
- 障害注入のテスト：1 つの AZ のブローカーをすべて止めても、`acks=all` で成功を返した書き込みがすべて読める（Jepsen の形。[ADR-0005](0005-compatibility-policy.md) の耐久性のテスト）。
- 階層型の保存の境界：セグメントを S3 へ上げる途中でブローカーを止めても、オフセットの抜け・重複が出ない。本番では、S3 のセグメントとリモートのメタデータの不変条件を日次で監査する。

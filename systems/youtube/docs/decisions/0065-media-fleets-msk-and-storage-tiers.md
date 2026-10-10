---
status: accepted
date: 2026-10-10
---

# ADR-0065: メディアの面は用途ごとの EC2 のキャパシティープロバイダーに置く。符号化は x86 の CPU の Spot（型 6 つ以上）、ライブは `g6.2xlarge` を On-Demand のキャパシティの予約で下限を持ち、`origin-cache` は `im4gn.4xlarge`、`match-engine` は `r7g.8xlarge`、`live-origin` は `r7g.4xlarge` にする。MSK は Express の `express.m7g.large` × 3 から始め、元のファイルは公開の 90 日の後に Deep Archive、レンディションは Intelligent-Tiering にする

## Context

- [ADR-0001](0001-platform-and-stack.md) は、メディアの面を ECS の EC2（CPU の Spot、GPU、NVMe）で動かし、視聴の出来事を MSK に流すと決めた。型と購入の形は infrastructure の領域に預けた。
- [cdn-and-delivery.md](../architecture/cdn-and-delivery.md) の 6.4 節は `origin-cache` に NVMe 約 7.5 TB・25 Gbps 以上を求めた。[live-streaming.md](../architecture/live-streaming.md) は GPU の確保を infrastructure の領域に預けた。
- ライブの変換を Spot に置くと、中断で配信が切れる。GPU の On-Demand は東京の AZ ごとの在庫が保証されない（**未検証**）。
- 符号化の出力は、同じ入力・同じ設定から同じラダーが出ることを守る（[intent.md](../intent.md)）。x264・SVT-AV1 の出力が命令セットの違う型の間で同じバイトになるかは確かめていない（**未検証**）。
- 価格（東京、On-Demand、AWS の公開の価格表、2026-10-10 に取得）：`c7i.4xlarge` 0.899 USD、`g6.2xlarge` 1.418 USD、`g6.xlarge` 1.167 USD、`im4gn.4xlarge` 1.707 USD、`i4i.8xlarge` 3.221 USD、`r7g.8xlarge` 2.067 USD、`r7g.4xlarge` 1.034 USD、`express.m7g.large` 0.527 USD（すべて 1 時間）。
- S3 の保存の単価（東京）：Standard 0.025、Intelligent-Tiering の Infrequent 0.0138・Archive Instant 0.005、Glacier Instant Retrieval 0.005（USD/GB・月）。Deep Archive の最小の保存は 180 日、戻しは標準 12 時間以内・大量 48 時間以内（[Amazon S3 storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html)、[Archive retrieval options](https://docs.aws.amazon.com/AmazonS3/latest/userguide/restoring-objects-retrieval-options.html)、2026-10-10 に確認）。

## Options

符号化：

1. **x86 の型 6 つ以上の Spot（急ぎの組は On-Demand の下限）、命令セットを 1 つにそろえる**
2. Graviton と x86 を混ぜた Spot

ライブの GPU：

- a. **`g6.2xlarge` の On-Demand。下限をキャパシティの予約で持つ**
- b. Spot

`origin-cache`：

- x. **`im4gn.4xlarge`（7.5 TB、25 Gbps）**
- y. `i4i.8xlarge`（7.5 TB、18.75 Gbps）

## Decision

1、a、x を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 4〜6 節。

- 符号化：`fleet-enc-urgent`（On-Demand 8 台 ＋ Spot）、`fleet-enc-normal`、`fleet-enc-back`（Spot だけ）。型は `c7i`・`c7a`・`c6i`・`c6a`・`m7i`・`m6i` の 4xlarge・8xlarge。命令セットは符号化器の組み立て（`enc_build`）の一部に固定する（[ADR-0071](0071-encoder-pinning-reencode-and-manifest-format-versions.md)）。Graviton は `encoder-arch-poc` の後に別の `enc_build` で足す。
- ライブ：`g6.2xlarge`（L4 × 1）。東京の 3 AZ に 20 台ずつのキャパシティの予約（平常の夜のピークの配信を詰めて置ける数）。大きな催しの前に期間つきの予約を足す。ASR は `g6.xlarge` の Spot。
- `origin-cache`：`im4gn.4xlarge` × 9（AZ ごとに 3）＋予備 3。`live-origin`：`r7g.4xlarge` × 12。`match-engine`：`r7g.8xlarge` × 4（2 つの写し × 2 シャード）＋予備 1。`live-chat-gateway`：`c7gn.2xlarge` × 6。
- 全群れで IMDSv2 必須、ホップの上限 1。GPU の群れは NVIDIA のドライバーのバージョンを AMI に固定する。
- MSK：Express の `express.m7g.large` × 3（3 AZ）。S1 の書き込みは複製の後で約 9.3 MB/秒、1 ブローカーの持続の目安 15.6 MB/秒（[Amazon MSK quota](https://docs.aws.amazon.com/msk/latest/developerguide/limits.html)、2026-10-10 に確認）。目安の 60% で型を上げる。
- S3：元のファイルは公開から 90 日まで Glacier Instant Retrieval、その後 Deep Archive。レンディションは Intelligent-Tiering（Deep Archive の層は有効にしない）。中間の出力は 7 日。作り直しの戻しは大量、急ぎは標準。

### 他の案を選ばなかった理由

- **2（混ぜる）**：同じキーへ違う型の出力が書かれうる（冪等は最初の書き込みを採るので壊れないが、黄金の動画の決定性の試験と本番の出力がずれる）。在庫の幅より出力の一致を先にする。
- **b（GPU の Spot）**：中断で配信が切れる。予備の切り替えの欠け（3 秒）が頻繁に起きる。
- **y（`i4i.8xlarge`）**：単価が約 1.9 倍で、帯域が求めた 25 Gbps に届かない。

## Consequences

- 良くなること：
  - 符号化の費用を Spot で下げ、出力の一致を守る。
  - ライブの下限の GPU を確保する。
  - 元のファイルの保存を 90 日の後に約 0.006 USD/時間・月に下げる。
- 引き受けるコスト：
  - キャパシティの予約の空きの時間の費用。
  - Graviton の安い Spot を当面使わない。
  - Deep Archive の戻しの待ち（12〜48 時間）を作り直しが受ける。Deep Archive の東京の保存の単価は価格表で見つからなかった（**未検証**）。

## Confirmation

- 夜間の決定性の検査：黄金の動画 20 本を群れの全部の型で符号化し、出力のバイトが同じ（[delivery.md](../architecture/delivery.md) の 2.2 節）。
- E15 の負荷試験で、平常のピークの使用 60% 以下、AZ を 1 つ止めて催しのピークで 90% 以下（[capacity.md](../architecture/capacity.md) の 7 節）。
- `cost-metering` で単位あたりの原価を請求の実績で置き換える。

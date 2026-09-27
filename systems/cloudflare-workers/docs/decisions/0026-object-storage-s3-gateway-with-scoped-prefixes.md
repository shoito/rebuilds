---
status: accepted
date: 2026-09-27
---

# ADR-0026: オブジェクトストレージは、S3 の共有のバケットの上に、バケットごとの接頭辞と要求ごとに絞った権限で S3 互換の層を作る

詳細は [object-storage.md](../architecture/object-storage.md) の 4〜6 節。

## Context

ADR-0005 は、オブジェクトストレージのバケットにホームのリージョンを持たせ、成功を返した書き込み・削除を、直後のすべての読み込み・一覧に反映すると決めた。本体は S3 に置き、S3 互換の API とアカウントの認証は自前の層で作る。

守ること（本家の R2 に寄せる。2026-09-27 に確認）：

- 書き込み・削除の直後の読み込みと一覧が最新。同時の書き込みは最後に完了したものが勝つ（[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)）。
- S3 の API の主な操作、マルチパート、条件付きのヘッダー（[R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)）。

S3 の事実（2026-09-27 に確認）：

- PUT・DELETE の直後の読み込み・一覧は強く整合する（[What is Amazon S3?](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)）。
- `If-Match`・`If-None-Match` の条件付きの書き込みを PutObject・CompleteMultipartUpload・CopyObject で使える（[Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)）。
- 利用者のメタデータは 2 KB まで（[Object metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html)）。キーは 1,024 バイトまで。
- 分割された接頭辞ごとに 1 秒に PUT 系 3,500、GET 系 5,500 以上。接頭辞の数に上限はない（[Optimizing performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)）。

## Options

1. **S3 の共有のバケットに `<bucket_id>/<key>` で置く薄い層。** オブジェクトのメタデータは S3 に任せ、バケットの設定だけを Aurora に置く。S3 への権限は bucket_id ごとの STS のセッションに絞る
2. **自前のメタデータの DB（Aurora か DynamoDB にオブジェクトの一覧）と、S3 に本体（変えない ID で置く）**
3. **テナントのバケットごとに S3 のバケットを 1 つ作る**

## Decision

1 を採用する。

- ホームのリージョンごとに共有の S3 のバケットを 16 個持ち（`<brand>-obj-apne1-00`〜`-15`）、bucket_id のハッシュで選ぶ。
- 自前のゲートウェイ（Rust、状態なし、3 AZ）が、SigV4 を検証し、名前を `<bucket_id>/<key>` に変え、S3 を呼ぶ。応答から接頭辞を取り除く。続きのトークンと `UploadId` は暗号化して bucket_id に結びつける。
- S3 を呼ぶ権限は、bucket_id ごとに STS の `AssumeRole` で得たセッションだけにし、セッションのポリシーでその接頭辞に絞る。ゲートウェイの素のロールは、テナントのデータへの権限を持たない。
- 一貫性、条件付きの書き込み、マルチパート、ETag は、S3 のものをそのまま使う。ゲートウェイにキャッシュを持たない。
- バケットの設定（名前、ホームのリージョン、管轄、CORS、ライフサイクルの規則、公開の設定）は制御プレーンの Aurora に置き、ADR-0004 の配信で届ける。CORS とライフサイクルは、S3 の機能でなく自前で行う（共有のバケットにテナントの規則を置けないため）。
- 保存時の暗号化は SSE-S3（ETag を MD5 のままにするため）。
- 災害の復旧のため、大阪へ S3 CRR で写す。
- 2 を採らない理由：DB と S3 の間の整合（本体の書き込みとメタデータの確定の順、孤立した本体の掃除）、一覧・条件付きの書き込み・マルチパートを自前で作る量が大きい。S3 がすでに強い整合でこれらを持つ。
- 3 を採らない理由：S3 のバケットの数の上限（アカウントあたり既定 10,000。Service Quotas で引き上げられる。[Bucket quotas](https://docs.aws.amazon.com/AmazonS3/latest/userguide/BucketRestrictions.html)、2026-09-27 に確認）を、S1 の数万のバケットで超えうる。引き上げても、利用者の数だけ実際のバケットを持つ運用の重さは残る。バケットの作成・削除は結果整合で（上の資料）、利用者の作成の直後の書き込みが失敗しうる。

## Consequences

- 良くなること：
  - 強い整合、条件付きの書き込み、マルチパートを、自前で作らずに S3 から得る。
  - ゲートウェイの変換を誤っても、S3 のセッションのポリシーが他のテナントの接頭辞を拒む（2 重の防御）。
  - ゲートウェイは状態を持たないので、増減と障害が単純。
- 引き受けるコスト：
  - 利用者のメタデータは 2 KiB（本家は 8,192 バイト）、キーは 1,011 バイト（本家は 1,024）。
  - ライフサイクルは Inventory の日次の一覧に頼るので、反映が最大 2 日かかる（本家は多くの場合 24 時間以内）。
  - 未完のマルチパートの中止は 7 日より長くできない。
  - STS の `AssumeRole` の上限と遅延に依る（上限はアカウント・リージョンごとに `AssumeRole` と `GetSessionToken` の合計で既定 1 秒 600。[IAM and STS quotas](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html)、2026-09-27 に確認）。セッションを 1 時間キャッシュするので、S1 のバケット数万で平均 1 秒 10 件程度に収まる見込み。
  - 原価は、保存・操作とも本家の料金を上回る（[ADR-0028](0028-object-egress-pricing.md)）。
  - 自前のメタデータが要る機能（バージョニング、大きなメタデータ、自前の索引）を足すときは、2 への移行になる。

## Confirmation

- 線形化可能性の検査（Jepsen の形）：5 リージョンのバインディングと外の S3 のクライアントから、同じキーの PUT・GET・DELETE・LIST を混ぜ、障害を注入して違反 0 件（ADR-0005 の E8 の受け入れ）。
- 脱出のテスト：ゲートウェイの変換をわざと壊した試験のビルドで、他の bucket_id の接頭辞への要求が S3 の側で拒否される。
- 互換の試験：AWS の SDK・CLI・rclone で、対応の範囲の操作が毎日通る。

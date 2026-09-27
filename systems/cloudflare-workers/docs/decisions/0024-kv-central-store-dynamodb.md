---
status: accepted
date: 2026-09-27
---

# ADR-0024: KV の正本は東京の DynamoDB に置き、4 KiB を超える値は S3 に置く。同じキーの書き込みは条件付きの書き込みで 1 秒に 1 回に制限する

詳細は [kv-store.md](../architecture/kv-store.md) の 5 節。

## Context

ADR-0005 は、KV の書き込みを中央の正本に確定してから成功を返し、正本を東京に置くと決めた。保存先は kv-store の領域で決めることにしていた（候補は DynamoDB、Aurora、S3）。

守る約束と制限（本家に寄せる。2026-09-27 に確認）：

- キー 512 バイト、メタデータ 1,024 バイト、値 25 MiB。同じキーへの書き込みは 1 秒に 1 回で、超えると 429（[KV limits](https://developers.cloudflare.com/kv/platform/limits/)）。
- 一覧は UTF-8 のバイトの辞書順で、`prefix` と `cursor` を持つ（[List keys](https://developers.cloudflare.com/kv/api/list-keys/)）。
- 本家は、中央を自前の分散 DB（3 重の複製）と R2（1KB を超える値）の組み合わせにしている（[Redesigning Workers KV](https://blog.cloudflare.com/rearchitecting-workers-kv-for-redundancy/)、2025-08-08）。

AWS の側の事実（2026-09-27 に確認）：

- DynamoDB の項目は 400 KB まで。書き込みは 1KB ごとに 1 単位。区画あたり 1 秒に書き込み 1,000 単位・読み込み 3,000 単位が上限。条件付きの書き込みができる。`BatchWriteItem` は条件を付けられない（[Constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)、[Partition key design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)）。
- 東京の価格：DynamoDB のオンデマンドの書き込み 100 万単位あたり 0.715 ドル、読み込み 0.1425 ドル、保存 1GB-月あたり 0.285 ドル。S3 の PUT は 1,000 あたり 0.0047 ドル、GET は 10,000 あたり 0.0037 ドル（AWS の価格表の API、2026-09-26 の公開分）。
- S3 は書き込みの直後の読み込みで強く整合する（[What is Amazon S3?](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html)）。

## Options

1. **DynamoDB（東京）に項目を置き、大きな値は S3 に置く**
2. **Aurora PostgreSQL（東京）の表に置く**（大きな値は S3）
3. **S3 だけに置く**（1 キー 1 オブジェクト。一覧は S3 の ListObjectsV2）

## Decision

1 を採用する。

- 表 `kv_entries`：`pk = namespace_id || shard`（shard はキーのハッシュの 16 の剰余）、`sk = キーの UTF-8 のバイト`（Binary）。一覧は 16 の区画への `Query` を併合する。
- 値とメタデータが 4 KiB 以下なら項目に入れる。超えたら S3 に `{namespace_id}/{key_hash}/{version}` で置き、項目には参照を置く。S3 に先に書き、DynamoDB の確定を成功とする。
- 書き込みは、東京の書き込みサービスが条件付きの `PutItem` で行う。条件は「項目がない、または `last_write_ms` が 1 秒以上前」。満たさなければ 429。削除は墓石の書き込みにし、同じ条件を受ける。
- 有効期限は `expires_at` に持ち、読み込みと一覧で除く。消すのは DynamoDB の TTL に任せる。
- PITR（35 日）を有効にする。グローバルテーブルで大阪に複製し、S3 は大阪へ CRR する。S1 では大阪から読み書きせず、東京の全体の障害のときの手動の切り替えにだけ使う。
- 2 を採らない理由：書き込みが 1 台のライターに集まり、KV の読み込みのミスと一覧を合わせた量で、S2 に向けて分割の設計が早く要る。制御プレーンの Aurora と障害の範囲を分けたい。
- 3 を採らない理由：1 秒に 1 回の制限を S3 だけでは強制しにくい（条件付きの書き込みは ETag の比較で、時刻の条件を持てない）。小さな値の書き込みが S3 の PUT の料金（100 万あたり 4.7 ドル）になり、DynamoDB（4 KiB で約 2.9 ドル）より高い。

## Consequences

- 良くなること：
  - 1 秒に 1 回の制限を、リージョンやノードの数によらず正本で強制できる。
  - 同時の 2 つの書き込みは、片方が 429 になる。黙って値が消えない。
  - 容量の計画が要らない（オンデマンド）。区画の分割は DynamoDB に任せられる。
- 引き受けるコスト：
  - 同時の書き込みの勝ち方が本家と違う（本家は最後の書き込みが勝つ。この設計は先に確定した方が勝ち、後は 429）。文書で示す。
  - 一覧が 16 の `Query` になる。区画の数を後から変えるのが難しい。
  - 大阪への複製の分だけ、書き込みの原価が約 2 倍になる。4 KiB の値の書き込みは約 5.7 ドル/100 万で、本家の料金（5.00 ドル/100 万）を上回る。料金は limits-and-billing で決める。
  - 東京の全体の障害の RPO は、グローバルテーブルの複製の遅れに依る（MREC は「ふつう 1 秒以下」で、保証の値はない。[How global tables work](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html)、2026-09-27 に確認）。RPO は保証しない（[ADR-0051](0051-disaster-recovery-and-honest-rpo.md)）。

## Confirmation

- 結合テスト：同じキーの 1 秒以内の 2 回目が 429。異なるキーの同時の書き込みは全部成功。4 KiB の境目と 25 MiB の値。
- 性質ベーステスト：16 区画の一覧の併合が、単一の順序と一致する。
- 負荷試験：1 つの名前空間に 5,000 件/秒の書き込み（異なるキー）で、スロットリングが 0.1% 未満。
- 訓練：`kv-region-failover` を四半期ごとに検証の環境で行い、RPO を記録する。

---
status: accepted
date: 2026-10-10
---

# ADR-0011: 部分の大きさは 8・16・32・64 MiB から部分の数が 10,000 以下になる値を選ぶ。マルチパートは CRC64NVME の全体のチェックサムで作り、部分ごとに `Content-MD5` と CRC64NVME を署名に含めて S3 に確かめさせる。任意の SHA-256 は完了の前に読み直して確かめる

## Context

- [ADR-0002](0002-upload-and-pipeline-orchestration.md) は、S3 のマルチパートの上の自前のセッションにし、部分ごとに `Content-MD5` を付け、任意の全体の SHA-256 が合ったときだけ完了を返すと決めた。部分の大きさは既定 16 MiB・8〜64 MiB、期限 7 日、部分の URL は 15 分。
- S3 のマルチパートは部分が 10,000 までである（[multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)、2026-10-10 に確認）。16 MiB では 160 GiB（約 171.8 GB）までしか上げられず、256 GB の上限に届かない。
- S3 がマルチパートで「全体」のチェックサムを照合できるのは CRC 系（CRC64NVME・CRC32・CRC32C）だけで、SHA-256 と MD5 は部分の合成の値になる（[Checking object integrity for data uploads](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)、2026-10-10 に確認）。SSE-KMS の部分の ETag は MD5 にならない。
- 本体はクライアントから S3 へ直接送る。サーバーは本体を見ない。
- Web のクライアントは、ブラウザの標準の暗号の API では SHA-256 を少しずつ計算できない（全体を一度に渡す形）。256 GB のファイルの SHA-256 は WebAssembly の実装が要る。

## Options

全体の確かめ：

1. **CRC64NVME の全体のチェックサム（`FULL_OBJECT`）を必須にし、S3 に照合させる。SHA-256 は任意で、サーバーが完了の前に読み直す**
2. SHA-256 を必須にし、サーバーが全部を読み直す
3. 部分の MD5 の合成（ETag の形）だけを比べる

部分の大きさ：

- a. **8・16・32・64 MiB から、部分の数が 10,000 以下になる最小の値と回線の希望の大きいほう**
- b. 常に 64 MiB
- c. 回線に合わせて部分ごとに変える

## Decision

1 と a を採用する。詳細は [upload-and-ingest.md](../architecture/upload-and-ingest.md) の 4 節。

- `CreateMultipartUpload` で CRC64NVME と `FULL_OBJECT` を指定する。クライアントはファイルを読みながら全体の CRC64NVME を計算し、`complete` で渡す。サーバーはそれを `CompleteMultipartUpload` に渡し、S3 が照合する。
- 部分の URL を出す前に、クライアントは部分の MD5 と CRC64NVME を出す。サーバーは記録し、署名に `content-length`・`content-md5`・`x-amz-checksum-crc64nvme` を含める。値の違う本体は S3 が拒む。
- `complete` では、`ListParts` の全頁で番号 1..N・大きさ・チェックサムが記録と合うことを確かめてから S3 の完了を呼ぶ。足りなければ 409 と番号の一覧を返す。
- 作成の時に SHA-256 を渡されたら、S3 の完了の後に `verifying` にし、範囲の GET を並べて順に読み直す。合えば `completed`、違えばオブジェクトを消して `rejected`。セッションが `completed` になった時を「完了」とする。
- 部分の大きさは作成の時に 1 つに決める。回線の希望（携帯 8 MiB、既定 16 MiB、速い回線 32 MiB）と、10,000 部分の下限の大きいほう。
- 期限は作成から 7 日、部分の URL は 15 分（ADR-0002 のまま）。部分の確定の要求は S3 を呼ばず、記録だけを書く（NFR-001 の p99 2 秒）。

### 他の案を選ばなかった理由

- **2（SHA-256 を必須）**：すべてのアップロードで全部を読み直す。256 GB で約 4 分かかり、Web のクライアントにも重い。
- **3（MD5 の合成）**：S3 の部分の値を並べただけで、クライアントが読んだファイルの全体と比べたことにならない。SSE-KMS では ETag が MD5 にならない。
- **b（常に 64 MiB）**：携帯の回線で 1 部分に 1 分半かかり、切れたときの送り直しが大きい。
- **c（部分ごとに変える）**：位置の計算と再開が、部分ごとの大きさの表を要する。得るものが小さい。

## Consequences

- 良くなること：
  - 256 GB まで上げられる。全体の確かめを S3 が追加の読み出しなしで行う。
  - 壊れた部分は PUT の時点で拒まれ、完了の前に気づく。
- 引き受けるコスト：
  - クライアントは部分を送る前に読み、2 つのチェックサムを計算する（WebAssembly の CRC64NVME を含む）。
  - SHA-256 を渡すクライアントは、完了まで読み直しの時間を待つ。
  - ADR-0002 の「全体の SHA-256」を「必須の CRC64NVME と任意の SHA-256」に具体化した。`Content-MD5` と CRC64NVME を両方署名に含める形は**未検証**で、通らなければ CRC64NVME だけにする（AGENTS.md の言い回しの見直しが要る）。

> 2026-10-10 の注記：統合の工程で、[AGENTS.md](../../AGENTS.md) の「部分ごとに `Content-MD5`」をこの ADR に合わせて言い直した。S3 の文書（2026-10-10 に確認）は、CRC64NVME が全体の型だけを持つことを示すが、部分の署名つきの URL にチェックサムを含める形の記述はない。`presigned-part-checksum-poc` の結果まで、その形は**未検証**。

## Confirmation

- 性質ベーステスト：PROP-UPL-001（揃いとチェックサムが合うときだけ `completed`）、PROP-UPL-003（部分の数と大きさ）。
- 結合テスト：署名に含めた値と違う本体の PUT が拒まれる。`FULL_OBJECT` の照合の失敗で `BadDigest` になる（`presigned-part-checksum-poc`）。
- 決定表：DT-UPL-001。

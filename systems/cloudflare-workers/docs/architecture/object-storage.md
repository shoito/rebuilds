# Object Storage: Cloudflare Workers

S3 互換のオブジェクトストレージ（本家の R2 に相当するもの）の設計。S3 の API の対応の範囲、ホームのリージョンとメタデータの置き場所、マルチパートのアップロード、条件付きの要求、カスタムドメインでの公開、署名付きの URL、外向きの転送の料金、ライフサイクルの規則を決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0003](../decisions/0003-edge-locations.md) | S1 は AWS の 5 リージョン。入口は Global Accelerator の anycast の IP |
| [ADR-0005](../decisions/0005-storage-consistency.md) | バケットはホームのリージョンを持ち、成功を返した書き込み・削除は直後のすべての読み込み・一覧に反映する |
| [ADR-0010](../decisions/0010-process-sandbox-and-egress-invariants.md) | バインディングの呼び出しは外向きのプロキシの口を通り、isolate の鍵で許可を決める |
| [ADR-0026](../decisions/0026-object-storage-s3-gateway-with-scoped-prefixes.md) | S3 の共有のバケットの上に、バケットごとの接頭辞と要求ごとに絞った権限で S3 互換の層を作る |
| [ADR-0027](../decisions/0027-object-public-access-and-presigned-urls.md) | 公開はカスタムドメインと別の登録可能なドメインの開発用の URL で行う。署名付きの URL は S3 互換の口だけで受ける |
| [ADR-0028](../decisions/0028-object-egress-pricing.md) | 外向きの転送は無料にせず、原価を下回らない従量で課金する |

KV は [kv-store.md](kv-store.md)、外向きのプロキシの約束は [sandbox-and-security.md](sandbox-and-security.md) の 7 節にある。入口のプロキシとカスタムドメインの TLS は [edge-network-and-routing.md](edge-network-and-routing.md)、料金の値は [limits-and-billing.md](limits-and-billing.md)、不正な内容の扱いは [abuse-and-trust-safety.md](abuse-and-trust-safety.md) にある。

本家の振る舞い・数値は、2026-09-27 に本家の文書、AWS の文書と価格表で確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| S3 互換の API（署名 SigV4）と、関数のバインディングの API | 管理の画面と API キーの発行の画面（dashboard-and-api） |
| バケットのホームのリージョン、オブジェクトとバケットの設定の置き場所 | 入口のプロキシの実装、カスタムドメインの TLS の証明書（edge-network-and-routing） |
| マルチパートのアップロード、条件付きの要求、コピー | 料金の値と無料の枠（limits-and-billing） |
| 公開のバケット（カスタムドメイン、開発用の URL）、公開の配信のキャッシュ、署名付きの URL | 不正な内容の検知と削除の手順（abuse-and-trust-safety。法務の L1） |
| ライフサイクルの規則（期限切れ、低頻度の保存への移動、未完のマルチパートの中止） | S3 のイベントの通知、バージョニング、オブジェクトのロック（MVP の後） |

## 2. 本家と AWS の仕組み（確かめたこと）

| 項目 | 本家（R2）・AWS | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| 一貫性 | 書き込みの完了の後、世界のどこでも最新が読める。一覧も最新。削除の直後は「ない」を返す。同時の書き込みは最後に完了したものが勝つ。カスタムドメインでキャッシュを有効にすると、キャッシュの分だけ緩む（404 も既定でキャッシュする） | [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) |
| S3 の API | バケット（ListBuckets、HeadBucket、CreateBucket、DeleteBucket、CORS、ライフサイクル）とオブジェクト（Get、Put、Delete、マルチパート、Copy）。ACL、バージョニング、オブジェクトのロック、SSE-KMS、タグは未実装。条件付きのヘッダー（If-Match など）に対応。リージョンは `auto`（空と `us-east-1` を別名にする） | [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) |
| 制限 | オブジェクト 5 TiB、単一のアップロード 5 GiB、マルチパート 4.995 TiB・10,000 部分、キー 1,024 バイト、メタデータ 8,192 バイト、同じキーへの同時の書き込み 1 秒に 1 回、バケット 100 万、カスタムドメイン 1 バケットに 100 | [R2 limits](https://developers.cloudflare.com/r2/platform/limits/) |
| マルチパート | 部分は 5 MiB〜5 GiB（最後を除き同じ大きさ）。未完のアップロードは既定で 7 日で中止。ETag は部分の MD5 を連ねた MD5 に `-部分の数` | [Multipart objects](https://developers.cloudflare.com/r2/objects/multipart-objects/) |
| ライフサイクル | 期限切れ、低頻度の保存への移動、未完のマルチパートの中止。接頭辞で絞る。反映は多くの場合 24 時間以内。1 バケットに 1,000 規則 | [Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) |
| 公開 | カスタムドメイン（同じアカウントのドメイン。WAF・キャッシュ・アクセスの制御を使える）と、開発用の r2.dev（速さの制限つき、本番に使わない）。根の一覧は出さない | [Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/) |
| 署名付きの URL | SigV4。1 秒〜7 日。GET・HEAD・PUT・DELETE。S3 の API の口だけで、カスタムドメインでは使えない | [Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) |
| 場所 | 場所のヒント（wnam・enam・weur・eeur・apac・oc）は最善の努力。管轄（eu・us・fedramp）は固い約束。作成後は移せない | [Data location](https://developers.cloudflare.com/r2/reference/data-location/) |
| R2 の料金 | 保存 0.015 ドル/GB-月（低頻度 0.01）、Class A 4.50 ドル/100 万、Class B 0.36 ドル/100 万、**外向きの転送は無料** | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| S3 の一貫性 | PUT・DELETE の直後の読み込み・一覧は強く整合。同じキーの同時の PUT は、時刻の遅い方が勝つ。バケットの設定は結果整合 | [What is Amazon S3?](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html) |
| S3 の条件付きの書き込み | `If-None-Match: *` と `If-Match: <ETag>` を PutObject・CompleteMultipartUpload・CopyObject で使える。失敗は 412、同時の削除とぶつかると 409（または 404） | [Conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) |
| S3 のメタデータ | 利用者のメタデータは 2 KB まで | [Working with object metadata](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingMetadata.html) |
| S3 の速さ | 分割された接頭辞ごとに 1 秒に PUT 系 3,500、GET 系 5,500 以上。広げる途中で 503（Slow Down） | [Optimizing performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html) |
| AWS の東京の価格 | S3 Standard 0.025 ドル/GB-月（最初の 50 TB）、PUT・COPY・POST・LIST 0.0047 ドル/1,000、GET 0.0037 ドル/10,000。インターネットへの転送 0.114 ドル/GB（最初の 10 TB）〜0.084 ドル/GB（150 TB 超） | AWS の価格表の API（AmazonS3・AWSDataTransfer の ap-northeast-1、2026-09-26 の公開分） |
| Global Accelerator | 時間の固定の料金に加え、DT-Premium（向きと地域で決まる GB あたりの料金）が、EC2 の外向きの転送の料金に上乗せされる | [Global Accelerator pricing](https://aws.amazon.com/global-accelerator/pricing/) |

## 3. 原則

- **一貫性は S3 に任せ、自分たちの層にキャッシュを持たない**（公開の配信のキャッシュを除く）。S3 は書き込みの直後の読み込み・一覧で強く整合する。自前の層でこれを壊さない。
- **テナントの分離は 2 重にする。** 自前の層が接頭辞を付けるのに加え、S3 への要求の権限自体を、そのバケットの接頭辞に絞る（6 節）。
- **外向きの転送の費用を隠さない。** 本家の「転送は無料」は、この設計では真似しない（10 節）。
- **本家の SDK の互換は目標にしない**（リポジトリ共通の ADR-0006）。ただし S3 の API は業界の標準なので、AWS の SDK と一般の S3 の道具で使えることを目標にする。

## 4. 構成

[ADR-0026](../decisions/0026-object-storage-s3-gateway-with-scoped-prefixes.md)。

```
外の S3 のクライアント                      関数（任意のリージョン）
  │ https://<account_id>.storage.<brand>.<domain>   │ env.BUCKET.get/put/...
  ▼ （ホームのリージョンだけを指す別の accelerator）   ▼ 外向きのプロキシ（isolate の鍵 → bucket_id）
┌──────────── ホームのリージョン（S1：東京） ──────────────────────────────┐
│ オブジェクトのゲートウェイ（Rust、ECS か EC2、3 AZ、状態なし）            │
│   ├─ SigV4 の検証（ヘッダー、クエリの署名付き URL、aws-chunked）         │
│   ├─ バケットの設定の写し（名前 → bucket_id、CORS、公開、規則）          │
│   ├─ 要求の変換：bucket/key → s3://<shared>/<bucket_id>/<key>            │
│   └─ STS のセッション（bucket_id の接頭辞に絞った権限）で S3 を呼ぶ       │
│ S3 の共有のバケット <brand>-obj-apne1-00 … -15（bucket_id のハッシュで選ぶ）│
│ ライフサイクルのジョブ（S3 Inventory → 規則の評価 → 削除・移動）         │
└───────────────────────────────────────────────────────────────────┘
      │ S3 CRR（災害の復旧の写し）
      ▼ 大阪の共有のバケット（S1 は読み書きしない）
```

- **メタデータの置き場所**：
  - オブジェクトのメタデータ（大きさ、ETag、`Content-Type` などの HTTP のメタデータ、利用者のメタデータ）は、S3 のオブジェクトのメタデータにそのまま置く。自前の DB に写さない。
  - バケットの設定（名前、アカウント、ホームのリージョン、管轄、CORS、ライフサイクルの規則、公開の設定、カスタムドメイン）は、制御プレーンの Aurora の表に置き、ADR-0004 の配信でゲートウェイとエッジのノードへ届ける。
- **ホームのリージョン**：S1 は東京だけ（ADR-0005）。管轄は `jp`（東京と大阪だけに置く）と、指定なしの 2 つ。S2 で他のリージョンを選べるようにする。作成後は移せない（本家と同じ）。
- **S3 の API の口の経路**：`*.storage.<brand>.<domain>` は、ホームのリージョンだけを指す別の Global Accelerator（大阪を予備）に向ける。関数の入口の accelerator を使うと、近いリージョンで受けてから東京へ中継することになり、遅延と転送の費用が 2 重になるため。
- **関数のバインディングの経路**：関数が東京以外のリージョンで動くときは、外向きのプロキシからリージョンの間の私的な経路でゲートウェイへ送る（遅延が増える。ADR-0005 の引き受けるコスト）。

## 5. API

### 5.1 S3 互換の API（S1 の対応の範囲）

| 分類 | 対応する | 対応しない（S1） |
| --- | --- | --- |
| バケット | ListBuckets、CreateBucket、HeadBucket、DeleteBucket（空のときだけ）、GetBucketLocation（`auto` を返す）、Get・Put・DeleteBucketCors、Get・Put・DeleteBucketLifecycleConfiguration | ACL、ポリシー、バージョニング、オブジェクトのロック、タグ、Web サイトの設定、複製、イベントの通知、暗号化の設定 |
| オブジェクト | GetObject（Range、条件）、HeadObject、PutObject（条件）、DeleteObject、DeleteObjects（1,000 件まで）、CopyObject（同じアカウントの中、条件）、ListObjectsV2・ListObjects（`prefix`・`delimiter`・`start-after`・`max-keys` 1,000） | オブジェクトの ACL・タグ、GetObjectAttributes、RestoreObject、SelectObjectContent、SSE-KMS、SSE-C（14 節） |
| マルチパート | CreateMultipartUpload、UploadPart、UploadPartCopy、CompleteMultipartUpload（条件）、AbortMultipartUpload、ListParts、ListMultipartUploads | — |
| 署名 | SigV4（ヘッダー、クエリの署名付き URL、`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`、`UNSIGNED-PAYLOAD`） | SigV2、POST のフォームでのアップロード（本家も非対応） |
| リージョン | `auto`。空と `us-east-1` を `auto` の別名にする（本家と同じ。多くの SDK の既定に合わせるため） | — |
| チェックサム | `Content-MD5`、`x-amz-checksum-crc32`・`crc32c`・`crc64nvme`・`sha1`・`sha256`（S3 にそのまま渡す） | — |

- 要求の本文は、ゲートウェイで貯めずに流す。署名した本文のハッシュ（`x-amz-content-sha256`）は、流しながら計算し、合わなければ S3 へのアップロードを中止して 400 にする。
- ゲートウェイは、S3 の応答の `Key`・`Prefix`・`CommonPrefixes` から `bucket_id/` を取り除き、続きのトークンを自前の暗号化したトークンに包む（6 節）。

### 5.2 バインディングの API

本家の R2 のバインディングの形に寄せる（`env.<BINDING>` の名前は利用者が決める）。

| メソッド | 対応する S3 の操作 | 備考 |
| --- | --- | --- |
| `head(key)` | HeadObject | |
| `get(key, {range, onlyIf})` | GetObject | `onlyIf` は `etagMatches`・`etagDoesNotMatch`・`uploadedBefore`・`uploadedAfter` を条件のヘッダーに変える。条件に合わなければ本文のない結果 |
| `put(key, value, {httpMetadata, customMetadata, onlyIf, md5, sha256})` | PutObject | `onlyIf` の `etagMatches` → `If-Match`、`etagDoesNotMatch: "*"` → `If-None-Match: *`。失敗は `null` |
| `delete(key｜keys[])` | DeleteObject・DeleteObjects | 1,000 件まで |
| `list({prefix, delimiter, cursor, limit, include})` | ListObjectsV2 | `limit` は 1,000 まで |
| `createMultipartUpload(key, …)`・`resumeMultipartUpload(key, uploadId)` | マルチパートの各操作 | 5.3 節 |

### 5.3 マルチパートのアップロード

- 部分は 5 MiB〜5 GiB、最大 10,000 部分、オブジェクトは 5 TiB まで。本家の「最後を除き同じ大きさ」は求めない（S3 の制約に合わせ、より緩くする）。
- `UploadId` は、`{bucket_id, key, s3_upload_id, created_at}` を AES-GCM で暗号化したものを返す。別のバケット・別のキーで使われたら 404（`NoSuchUpload`）にする。
- ETag は S3 が返すもの（部分の MD5 を連ねた MD5 と `-部分の数`）。本家と同じ形になる。S3 の保存時の暗号化を SSE-S3 にし、ETag が MD5 のままになるようにする（SSE-KMS では MD5 でなくなる）。
- 未完のアップロードは、既定で 7 日で中止する。共有のバケットに S3 のライフサイクルの規則（`AbortIncompleteMultipartUpload` 7 日）を置いて最後の守りにし、利用者が 7 日より短くした規則は 8 節のジョブが行う。7 日より長くはできない（本家との差）。
- CompleteMultipartUpload の条件（`If-None-Match`・`If-Match`）はそのまま S3 に渡す。アップロードの途中に同じキーへ別の書き込みがあると、完了は 412 になる（S3 と同じ）。

### 5.4 条件付きの要求

| 操作 | 条件 | 振る舞い |
| --- | --- | --- |
| GET・HEAD | `If-Match`、`If-None-Match`、`If-Modified-Since`、`If-Unmodified-Since` | S3 にそのまま渡す（304・412） |
| PUT・Complete・Copy | `If-Match: <ETag>`、`If-None-Match: *` | S3 の条件付きの書き込みにそのまま渡す。412・409 を返す |
| Copy の元 | `x-amz-copy-source-if-*` | そのまま渡す。元のバケットが同じアカウントで、同じホームのリージョンかをゲートウェイが確かめる |

- 条件付きの書き込みで、比較と書き込みを 1 つにできる（楽観ロック）。これにより、利用者はキーごとの排他を自分で書ける。
- 本家の「同じキーへの同時の書き込みは 1 秒に 1 回」の制限は、S1 では強制しない。S3 の 503（Slow Down）を 503 として返す。

### 5.5 制限（S1 の既定）

| 項目 | 値 | 本家との差 |
| --- | --- | --- |
| バケット | アカウントあたり 1,000 | 本家は 100 万。S1 の規模に合わせる。値は limits-and-billing |
| キー | 1,011 バイト | 本家は 1,024。S3 のキーの上限 1,024 から、接頭辞の `bucket_id/`（13 バイト）を引いた値 |
| 利用者のメタデータ | 2 KiB | 本家は 8,192 バイト。S3 の上限 |
| オブジェクト | 5 TiB。単一の PUT は 5 GiB | 同じ |
| 部分 | 5 MiB〜5 GiB、10,000 | 大きさを揃えることは求めない |
| DeleteObjects | 1,000 件 | 同じ |
| カスタムドメイン | バケットあたり 100 | 同じ |
| ライフサイクルの規則 | バケットあたり 1,000 | 同じ |

## 6. テナントの分離

- `bucket_id` は、バケットの作成時に採番する 12 文字のランダムな base32。名前（利用者が付ける）と別にする。削除したバケットの名前を別の人が作っても、`bucket_id` は変わる。
- ゲートウェイの S3 への要求は、次の 2 重の検査を受ける。
  1. ゲートウェイが、署名（またはバインディングの isolate の鍵）からアカウントを決め、そのアカウントのバケットの名前から `bucket_id` を引き、`<bucket_id>/<key>` に変える。
  2. S3 を呼ぶ権限は、`bucket_id` ごとに STS の `AssumeRole` で得たセッションの資格情報に限る。セッションのポリシーは `arn:aws:s3:::<shared>/<bucket_id>/*` と、`s3:prefix` が `<bucket_id>/` で始まる ListBucket だけを許す。ゲートウェイの素のロールは、テナントのデータの S3 の権限を持たない。
- ゲートウェイの変換に誤りがあっても、別のバケットの接頭辞には S3 の側で届かない。セッションは `bucket_id` ごとに最大 1 時間キャッシュする。
- キーの検証：空のキー、1,011 バイトを超えるキー、不正な UTF-8 を拒む。`..`、`/` で始まるキー、`%2F` などの符号化は、S3 と同じくただの文字として扱い、パスとして解釈しない（接頭辞の外に出る手段がないことを脱出のテストで確かめる）。
- 続きのトークン・`UploadId`・`cursor` は、`bucket_id` を含めて暗号化と認証を付ける。別のバケットでは使えない。
- アクセスキー：
  - `object_access_keys` の表に、アクセスキーの ID（`<BRAND>` で始まる 20 文字。AWS の `AKIA` などの接頭辞と重ならない。リポジトリ共通の ADR-0006）と、KMS で暗号化した秘密の鍵を置く。SigV4 の検証には秘密の鍵が要るので、ハッシュにできない。
  - 権限の範囲：アカウント全体か、バケットの一覧。読み込みだけか、読み書きか。
  - ゲートウェイは、秘密の鍵から日ごとの署名の鍵（日付・リージョン・サービスで導く鍵）を作ってメモリに置き、秘密の鍵そのものは長く持たない。
  - 鍵を消すと、その鍵で作った署名付きの URL もすべて無効になる。
- 保存時の暗号化は SSE-S3。アカウントごとの鍵は 14 節の問い。

## 7. 公開の配信と署名付きの URL

[ADR-0027](../decisions/0027-object-public-access-and-presigned-urls.md)。

### 7.1 カスタムドメイン

- 利用者は、同じアカウントで確認済みのドメイン（edge-network-and-routing の手順）を、バケットに付ける。`GET`・`HEAD` だけを受け、パスをキーにする。根（`/`）の一覧は出さない（本家と同じ）。
- 経路：利用者 → 近いリージョンのエッジのノードの入口のプロキシ（TLS の終端）→ 公開の読み込みの口 → ホームのリージョンのゲートウェイ。
- **キャッシュ**はドメインごとに選べ、既定は無効。有効にすると、入口のプロキシのリージョンのキャッシュ（実装は edge-network-and-routing）に置く。
  - オブジェクトの `Cache-Control` に従う。ないときは 1 時間。404 は 60 秒。
  - 消去の API（URL、接頭辞、ドメインの全体）を持ち、設定の配信の経路で全リージョンへ p99 10 秒で届ける（NFR-008 と同じ経路）。
  - 有効にしたドメインでは、上書き・削除がキャッシュの期間だけ見えない。ADR-0005 が認める緩みで、画面と文書で示す。
- 応答に `X-Content-Type-Options: nosniff` を付ける。

### 7.2 開発用の URL

- `https://pub-<32 桁の 16 進>.<brand>usercontent.<domain>`。既定は無効で、利用者が有効にする。
- 関数の既定のドメイン（`*.<brand>.<domain>`）と別の登録可能なドメインにし、Public Suffix List に載せる。利用者の HTML が、他の利用者や自分たちのドメインのクッキーに触れないようにする。
- 速さの制限：バケットあたり 1 秒に 100 要求（仮）。キャッシュはしない。本番に使わないよう、画面と応答のヘッダーで示す。
- カスタムドメインに WAF などの守りを置いても、開発用の URL を有効のままにすると、そこから読める（本家も同じ注意を出している）。画面で警告する。

### 7.3 署名付きの URL

- SigV4 のクエリの署名。GET・HEAD・PUT・DELETE。期限は 1 秒〜7 日。
- S3 の API の口（`<account_id>.storage.<brand>.<domain>`）だけで受ける。カスタムドメインと開発用の URL では受けない（本家と同じ）。
- 期限の判定はゲートウェイの時計で行い、15 分の時計のずれを許す（S3 の SigV4 と同じ。S3 は要求の時刻が 15 分を超えてずれると `RequestTimeTooSkewed` で断る。[Authenticating Requests (SigV4)](https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html)、2026-09-27 に確認）。
- 署名付きの URL は持っている人なら誰でも使える。文書で、短い期限と PUT の `Content-Type` の固定を勧める。

## 8. ライフサイクルの規則

- 規則はバケットの設定として Aurora に置く（S3 の API の PutBucketLifecycleConfiguration で受ける）。対応する動作は、期限切れ（作成からの日数、日付）、低頻度の保存への移動、未完のマルチパートの中止。接頭辞で絞る。
- 共有の S3 のバケットには、テナントごとの規則を置けない（S3 の規則はバケットあたり 1,000 で、テナントの規則を写せない）。そこで、自前のジョブで行う。
  1. S3 Inventory の日次の一覧（共有のバケットごと）を受ける。
  2. `bucket_id` ごとに分け、そのバケットの規則を評価する。
  3. 期限切れは DeleteObjects（1,000 件ずつ）。一覧を取ってから消すまでに同じキーが上書きされていたら消さないよう、条件付きの削除（`DeleteObjects` の各キーに一覧の時点の `ETag` を付ける）で消す。S3 は ETag が合わないキーを `412` で消さない。条件は最新の版にだけ効く（[Conditional deletes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-deletes.html)、2026-09-27 に確認）。HeadObject と削除の間の競合は起きない。
  4. 低頻度の保存への移動は、同じキーへの CopyObject で保存の種類を S3 Standard-IA に変える。
  5. 未完のマルチパートは ListMultipartUploads で探し、AbortMultipartUpload する。
- 反映は、規則の変更から 48 時間以内を目標にする（本家は多くの場合 24 時間以内。Inventory が日次のため、この設計は最大で 2 日かかる）。
- GET・HEAD の応答の `x-amz-expiration` は、ゲートウェイが規則から計算して付ける。
- 低頻度の保存の料金と最低の保存の期間は、S3 Standard-IA の原価から limits-and-billing で決める。Standard-IA は 30 日の最低の保存の期間と、128 KB 未満を 128 KB として数える課金を持つ（[Storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html)、2026-09-27 に確認）。移動の規則は 128 KB 未満のオブジェクトを移さない。

## 9. 障害の型

| 障害 | 検知 | 振る舞い |
| --- | --- | --- |
| S3 の 503（Slow Down） | ゲートウェイの 503 の率 | そのまま 503 を返す（S3 の SDK は再試行する）。1 つのバケットに集中するなら、利用者に接頭辞の分散を勧める |
| ゲートウェイのタスクの障害 | ロードバランサーの健全性 | 他の AZ のタスクで続ける（状態を持たない） |
| STS の障害 | `AssumeRole` の失敗 | キャッシュ済みのセッション（最大 1 時間）で続ける。切れたバケットの要求は 503 で閉じる（素のロールで代わりに呼ばない） |
| KMS の障害（アクセスキーの復号） | 復号の失敗 | その日の署名の鍵がメモリにあれば続ける。なければ 503 |
| 制御プレーン（Aurora）の障害 | 設定の配信の遅れ | ゲートウェイは手元の設定の写しで続ける。新しいバケット・鍵・規則は反映されない |
| 東京の全体の障害 | 合成監視 | オブジェクトストレージは止まる。runbooks の `object-region-failover` で大阪の写しへ手動で切り替える。RPO は CRR の遅れ（14 節） |
| ライフサイクルのジョブの遅れ | Inventory の到着と処理の遅れ | 48 時間を超えたら警報。遅れの間、期限切れのオブジェクトが残る（課金しない） |
| 公開のキャッシュが古い値を返し続ける | 利用者の報告、消去の失敗 | 消去を再送する。消去の配信の遅れを監視する |

## 10. 外向きの転送の料金

[ADR-0028](../decisions/0028-object-egress-pricing.md)。

本家の R2 は、外向きの転送を無料にしている。この設計は AWS の上で動くので、同じことをすると大きな赤字になる。率直に比べる。

| 1 か月あたり（東京、S1 の構成） | 本家（R2 の料金） | この設計の原価（AWS の東京の定価） |
| --- | --- | --- |
| 保存 1 TB | 15 ドル | S3 25 ドル（大阪への複製を含めると約 50 ドル＋複製の転送） |
| 書き込み 100 万回 | 4.50 ドル（Class A） | S3 の PUT 4.70 ドル＋ゲートウェイの計算 |
| 読み込み 1,000 万回 | 3.60 ドル（Class B） | S3 の GET 3.70 ドル＋ゲートウェイの計算 |
| インターネットへの転送 1 TB | **0 ドル** | **約 115 ドル**（0.114 ドル/GB）＋ Global Accelerator の DT-Premium（アジア太平洋のリージョンからアジア太平洋の利用者へ 0.010 ドル/GB。価格表の API、2026-09-27） |
| インターネットへの転送 200 TB | **0 ドル** | 約 18,000 ドル（段階の料金の合計。10 TB × 0.114＋40 TB × 0.089＋100 TB × 0.086＋50 TB × 0.084）＋ DT-Premium |
| 東京以外のリージョンの関数から読む 1 TB | 0 ドル | リージョンの間の転送（東京から他のリージョンへ 0.09 ドル/GB。価格表の API、2026-09-27）が加わる |

- **原価だけで、保存・操作とも本家の料金を上回る。** 転送を含めると、差はさらに大きい。本家が転送を無料にできる理由（自前の網と相互接続）は、この設計にはない（本家の原価の構造は公開されていない）。
- したがって、料金の構造は「保存（GB-月）＋操作（書き込み系・読み込み系）＋インターネットへの転送（GB）」にし、転送に無料の枠を付ける。値は limits-and-billing で決める。
- 同じホームのリージョンの関数がバインディングで読む分は、転送として課金しない（利用者の関数の応答として外へ出る分は、関数の転送の扱いになる。limits-and-billing で決める）。
- CloudFront を前に置けば S3 から CloudFront への転送は無料だが、CloudFront からインターネットへの転送は課金される。
- **CloudFront の定額の計画がある**（2026-09-27 に確認。[Flat-rate pricing plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)）。1 つの計画は 1 つの配信と 1 つの apex のドメインを覆い、超過の料金を取らない。Premium は月 50 TB・5 億要求で 1,000 ドル（125 TB で 2,250 ドル。最大 600 TB まで選べる）で、転送の単価にすると 0.02 ドル/GB 前後になり、定価（0.114 ドル/GB）より大幅に安い。ただし、目安を続けて大きく超えると配信の質を下げうるとされ、多数のテナントの配信（multi-tenant distributions）は対象外で、WAF の関連付けが必須。
- 公開のバケットの開発用の URL（`<brand>usercontent.<domain>` の 1 つの apex）の配信に当てられるかは未検証（規約と、多数のテナントの内容を 1 つの計画で配ってよいか）。S2 の前の見直し（[ADR-0028](../decisions/0028-object-egress-pricing.md)）で確かめる。カスタムドメインの公開の配信は、1 つの apex の制限のため当てられない。
- 利用者への説明では、「転送は無料」を掲げない。日本の利用者への近さと、関数との統合を価値にする。

## 11. テスト

| 種類 | 対象 | 確かめること |
| --- | --- | --- |
| 単体 | SigV4 の検証 | AWS の公開のテストの組（署名の例）が全部通る。期限切れ・時計のずれ・署名の範囲外のヘッダーの改ざんを拒む |
| 単体 | 名前の変換 | `bucket_id/` の付け外しが、キー・接頭辞・`CommonPrefixes`・`StartAfter`・続きのトークンで往復して一致する |
| 性質ベース | 一覧 | 任意のキーの集合と `prefix`・`delimiter`・`max-keys` で、ゲートウェイの一覧が、同じキーを専用のバケットに置いたときの S3 の一覧と一致する |
| 一貫性（Jepsen の形） | 線形化可能性 | 5 リージョンの関数（バインディング）と外の S3 のクライアントから、同じキーに PUT・GET・DELETE を混ぜる。ゲートウェイのタスクの停止、STS の遅延、リージョンの間の経路の分断を注入する。Knossos の登録簿のモデルで線形化可能性を検査する（ADR-0005 の E8 の受け入れ） |
| 一貫性 | 一覧の即時性 | PUT・DELETE の成功の直後の ListObjectsV2 に、必ず反映している |
| 一貫性 | 条件付きの書き込み | 同じキーへの N 個の同時の `If-None-Match: *` の PUT で、成功はちょうど 1 つ。`If-Match` の比較と書き込みで増やすカウンターが、同時の N 本の後に N 増えている（失われた更新 0） |
| 結合 | マルチパート | 5 MiB の境目、10,000 部分、途中の同じキーへの PUT で完了が 412、7 日で中止 |
| 結合 | 公開 | カスタムドメインで GET・HEAD だけが通る。根の一覧が出ない。キャッシュの有効・無効と消去 |
| 結合 | 署名付きの URL | 期限の前後、別のアカウントのバケットへの URL（自分の鍵で署名）の拒否、鍵の削除の後の拒否 |
| 結合 | ライフサイクル | 期限切れ・移動・未完の中止が 48 時間以内。一覧の後に上書きされたオブジェクトを消さない |
| 分離（脱出のテスト） | 接頭辞 | `..`・`%2F`・不正な UTF-8・NUL・長すぎるキー、別のバケットの続きのトークン・`UploadId`、別のアカウントのコピーの元で、他のバケットに届かない。セッションのポリシーだけで拒否されることも、ゲートウェイの変換を壊した試験のビルドで確かめる |
| 互換 | S3 の道具 | AWS の SDK（JavaScript・Python・Go）、AWS CLI、rclone で、対応の範囲の操作が通る（毎日） |

テスト名には要件の ID を含める（開発リポジトリの `specs/` で採番する）。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0026](../decisions/0026-object-storage-s3-gateway-with-scoped-prefixes.md) | ホームのリージョンの S3 の共有のバケットに `bucket_id/` の接頭辞で置き、自前のゲートウェイで S3 互換の API を出す。S3 への権限は bucket_id ごとの STS のセッションに絞る。オブジェクトのメタデータは S3 に、バケットの設定は Aurora に置く。大阪へ CRR する |
| [0027](../decisions/0027-object-public-access-and-presigned-urls.md) | 公開はカスタムドメイン（キャッシュは選べる、既定は無効）と、別の登録可能なドメインの開発用の URL（既定は無効、速さの制限）。署名付きの URL は S3 の API の口だけで受ける |
| [0028](../decisions/0028-object-egress-pricing.md) | 外向きの転送は無料にしない。保存・操作・転送の従量にし、原価を下回らない値を limits-and-billing で決める |

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E8 | ゲートウェイの骨格：SigV4 の検証（ヘッダー、aws-chunked、署名付きの URL）と名前の変換 |
| E8 | STS のセッションのキャッシュと、bucket_id の接頭辞に絞ったセッションのポリシー |
| E8 | バケットの操作（作成・削除・一覧・CORS）と、設定の配信（Aurora → ゲートウェイ・エッジのノード） |
| E8 | オブジェクトの操作（Get・Put・Head・Delete・DeleteObjects・Copy・List）と条件付きの要求 |
| E8 | マルチパート（暗号化した `UploadId`、7 日の中止） |
| E8 | バインディングの API と、外向きのプロキシの口 |
| E8 | ライフサイクルのジョブ（Inventory、規則の評価、削除・移動・中止）と `x-amz-expiration` |
| E8 | 線形化可能性の検査（Jepsen の形）と、S3 の道具の互換の試験 |
| E8 | 大阪への CRR と `object-region-failover` の訓練 |
| E4 | カスタムドメインの公開の読み込みの経路と、リージョンのキャッシュと消去（edge-network-and-routing と合わせて） |
| E4 | ストレージの API の口の accelerator（ホームのリージョンだけを指す） |
| E12 | 開発用の URL のドメイン（`<brand>usercontent.<domain>`）の取得と Public Suffix List への登録、通報の窓口（法務の L1 の確認の後） |
| E11 | 保存・操作・転送の量の計測と集計（転送は公開の配信と S3 の API の口で数える） |
| E6 | ダッシュボードのアクセスキーの発行と、CLI のバケットの操作 |

## 14. 未解決の問い

- 自前のメタデータの DB を持つ形（Aurora か DynamoDB にオブジェクトの一覧を持ち、S3 は本体だけ）に移る必要が出るか。利用者のメタデータの 8 KiB、キーの 1,024 バイト、バージョニングなどの要望次第。
- SSE-C（利用者が渡す鍵での暗号化）に対応するか。
- アカウントごとの暗号化の鍵（SSE-KMS）にするか。ETag が MD5 でなくなることと、KMS の要求の費用。
- 大阪への CRR の RPO。S3 の Replication Time Control（15 分の SLA）を使っても、NFR-010 の RPO 1 分は保証できない。
- CloudFront などで外向きの転送の原価を下げられるか。
- 本家の「同じキーへの同時の書き込み 1 秒に 1 回」を強制するか。
- 公開のキャッシュを S1 でどのリージョンに置くか（5 リージョンの全部か、東京だけか）。

### 決定

2026-09-27 の既定案。

- S1 は S3 の共有のバケットの上の薄い層にする。自前のメタデータの DB は持たない。差（メタデータ 2 KiB、キー 1,011 バイト）は文書で示す。要望が増えたら、ADR-0026 を更新してから移る。
- SSE-C と SSE-KMS は S1 で対応しない。SSE-S3 だけにする。
- CRR は全部のバケットで有効にする（NFR-010 の RTO 1 時間のため）。RPO 1 分は保証できないことを PM・Ops に諮る（矛盾として報告する）。→ 統合の工程（2026-09-27）で、NFR-010 を ADR-0051 の製品ごとの値（99.9% で 15 分以内）に改めた（[README.md](README.md) の 3 節）。
- 転送の原価の削減は S2 の前に調べる。S1 は 10 節の構造で課金する。
- 1 秒に 1 回の制限は強制しない。
- 公開のキャッシュは、有効にしたドメインについて全リージョンに置く。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：接頭辞の変換の誤りで、別のテナントのオブジェクトに届く。STS のセッションのポリシーでの 2 重の防御と、変換を壊したビルドでの脱出のテスト。
- リスク：強い整合を壊す（ゲートウェイにキャッシュを足す変更）。線形化可能性の検査を、ゲートウェイの変更ごとに回す。
- リスク：ライフサイクルのジョブが、上書きされた新しいオブジェクトを消す。消す直前の ETag の確認と、その試験。
- リスク：S3 の API の互換の退行。AWS の SDK・CLI・rclone の毎日の試験。
- 本番での検証：各リージョンの合成の関数と、外の S3 のクライアントで、PUT の直後の GET・LIST を 1 分ごとに確かめる。

**runbooks**

- `object-gateway-5xx`：ゲートウェイの 5xx の増加。S3 の 503、STS・KMS の失敗、設定の写しの遅れを切り分ける。
- `object-region-failover`：東京の全体の障害で、大阪の写しへ切り替える。CRR の遅れ（RPO）の確認と、戻す手順。
- `object-lifecycle-lag`：ライフサイクルの反映が 48 時間を超えた。Inventory の到着とジョブの確認。
- `object-public-cache-purge`：消去が届かない、古い内容が配信される。
- `object-access-key-compromise`：鍵の漏れの疑い。鍵の無効化と、署名付きの URL の失効の確認、利用の記録の抽出。
- SLI の追加の依頼（Ops へ）：操作ごとの遅延と 5xx の率、S3 の 503 の率、STS のセッションのキャッシュの当たり、ライフサイクルの遅れ、CRR の遅れ、公開のキャッシュの当たりの率。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `object_buckets`（制御プレーンの Aurora） | `id`（bucket_id）、`account_id`、`name`、`home_region`、`jurisdiction`、`s3_shard`（00〜15）、`cors`、`public_dev_url_enabled`、`created_at`、`deleted_at` | RLS。`(account_id, name)` で一意 |
| `object_bucket_lifecycle_rules`（Aurora） | `bucket_id`、`rule_id`、`prefix`、`action`（`expire`・`transition_ia`・`abort_multipart`）、`days`・`date`、`enabled` | RLS。1 バケットに 1,000 まで |
| `object_custom_domains`（Aurora） | `bucket_id`、`hostname`、`cache_enabled`、`min_tls`、`status` | RLS。TLS の証明書は edge-network-and-routing |
| `object_access_keys`（Aurora） | `access_key_id`、`account_id`、`secret_ciphertext`（KMS）、`scope`（アカウント・バケットの一覧）、`permission`（`read`・`read_write`）、`created_at`、`last_used_at`、`revoked_at` | RLS |
| S3 の共有のバケット `<brand>-obj-apne1-{00..15}` | `<bucket_id>/<key>`、S3 のオブジェクトのメタデータ | SSE-S3。大阪へ CRR（CRR のためバージョニングを有効にし、削除の印も複製する。旧い版は両方のバケットで 7 日で消す。[security.md](security.md) の 8.1 節）。未完のマルチパートを 7 日で中止する規則 |
| 使用量（limits-and-billing） | `account_id`、`bucket_id`、保存の量（日次）、書き込み系・読み込み系の数、インターネットへの転送の量 | `account_id` で分ける |

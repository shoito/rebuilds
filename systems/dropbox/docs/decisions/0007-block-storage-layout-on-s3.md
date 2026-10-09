---
status: accepted
date: 2026-10-09
---

# ADR-0007: ブロックはテナントの接頭辞を持つ不変の S3 オブジェクトで、クライアントは署名つき URL で直接送る。SSE-KMS とバケットキー、バージョニング（削除から 30 日）、128 KiB 以上は Intelligent-Tiering、大阪へ CRR。GC は参照 0 から 7 日の猶予の後

## Context

ブロック（[ADR-0002](0002-chunking-and-block-addressing.md)）の中身を、どこに、どう置くかを決める。条件は次のとおり。

- **耐久性**：確定したバージョンの中身を失わない（NFR-005）。物理の耐久性（ディスクの故障、消失訂正符号、複製）は S3 の役目にする。S3 のどのクラスも 99.999999999% の耐久性で設計されている（[Amazon S3 storage classes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html)、2026-10-09 に確認）。本システムが失いうるのは、**論理の誤り**（参照のあるブロックを GC が消す、索引と S3 が食い違う、誤った操作）である。
- **量**：S1 で物理 13 PB、ブロックの送信のピーク 2 GB/秒、配信のピーク 4 GB/秒（[architecture/README.md](../architecture/README.md) の 2 節）。中身をサーバーの ECS に通すと、転送の費用と台数が増える。
- **重複排除の守り**：正規のキーにクライアントが書けると、他人の有無が漏れる、他人のブロックを壊せる（[ADR-0003](0003-dedupe-scope-and-privacy.md)）。
- **費用**：Standard-IA と Glacier Instant Retrieval は 128 KB 未満を 128 KB として課金し、30 日・90 日の最小の保存の期間がある。Intelligent-Tiering は 128 KB 未満を監視せず、常に高頻度の層に置く（同上の資料）。
- **DR**：大阪へ切り替えたとき、中身も読める。
- 本家は、最大 4 MB のブロックを SHA-256 で名付け、1 GB のバケットにまとめて消失訂正符号をかける自社の保存の層を持つ（[Inside the Magic Pocket](https://dropbox.tech/infrastructure/inside-the-magic-pocket)、2026-10-09 に確認）。本システムは保存の層を作らない（[intent.md](../intent.md) の Non-goals）。

## Options

1. **1 ブロック 1 オブジェクト。テナントの接頭辞を持つ内容の番地のキーに、クライアントが一時のキー経由で直接送る**
2. 小さなブロックをまとめたパックのオブジェクト（数十〜数百 MB）に詰め、索引にオフセットを持つ
3. 1 ファイルのバージョンを 1 オブジェクトにする（S3 のマルチパートのアップロード）
4. 中身をサーバー（ECS）が受けて S3 へ書く

## Decision

1 を採用する。

### バケットとキー

| バケット（東京） | キー | 中身 | 設定 |
| --- | --- | --- | --- |
| `<brand>-incoming-apne1` | `u/<upload_id>/<n>`（`upload_id` は 128 ビットの乱数） | 送られたばかりのブロック | 2 日で消す。クライアントの書き込みは、ここだけ |
| `<brand>-blocks-apne1` | `b/<sc>/<h[0:4]>/<tenant_id>/<hash>` | 確かめたブロック。`sc` は `s`（128 KiB 未満）か `l` | バージョニング、Intelligent-Tiering（`l`）、大阪へ CRR |
| `<brand>-blocklists-apne1` | `bl/<h[0:4]>/<tenant_id>/<blocklist_hash>` | 大きなファイルのブロックの一覧 | 同上（Standard） |
| `<brand>-previews-apne1` | `p/<tenant_id>/<rev_id>/<kind>` | プレビュー・サムネイルのキャッシュ | 作り直せる。90 日で消す |
| `<brand>-audit-apne1` | 日ごと | 監査ログの写し | Object Lock（期間は法務の L3・L6 の後） |
| `<brand>-exports-apne1` | `x/<tenant_id>/<export_id>` | サーバーが組み立てたダウンロード（フォルダーの ZIP、1 つの URL のファイル）。[ADR-0054](0054-server-assembled-downloads.md) | 1 日で消す。写さない |

- キーの先頭に近い位置にハッシュの 4 文字を置き、S3 の接頭辞ごとの要求の上限に偏りを作らない。`incoming` のキーは `upload_id` を 128 ビットの乱数（UUIDv7 にしない）にして、同じ時刻のアップロードが同じ接頭辞に集まらないようにする。

> 2026-10-09 の注記：capacity の領域が、`upload_id` が UUIDv7 なら時刻が先頭に来て `incoming` の接頭辞が偏ると指摘した。block-storage の領域が `upload_id` を 128 ビットの乱数にしたので、キーの形 `u/<upload_id>/<n>` は変えない。キーにテナントを含め、重複排除をテナントの中に閉じる（[ADR-0003](0003-dedupe-scope-and-privacy.md)）。
- ブロックは書き換えない。同じキーへの 2 回目の書き込みは、同じ中身である。

### アップロード

1. commit で「送れ」と答えたブロックに、サーバーが `incoming` のキーへの署名つきの PUT の URL（期限 15 分）を返す。モバイルの背景の送信で 15 分が足りるかは持ち越し（`mobile-background-upload-poc` で切れる頻度を測り、多ければモバイルの背景の URL だけ期限を延ばす。[mobile-and-camera-upload.md](../architecture/mobile-and-camera-upload.md) の 8.1 節）。URL は SHA-256 のチェックサムの指定を含む。ブロックは最大 16 MiB なので、マルチパートは使わない。
2. クライアントが PUT する。S3 はチェックサムを計算し直し、合わなければ拒む（[Checking object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html)、2026-10-09 に確認）。署名でチェックサムの指定を強制できるかは `presigned-upload-poc` で確かめる。強制できなくても、次の 3 で確かめるので正しさは変わらない。
3. `block-verifier` が、S3 の持つ SHA-256 を読み、番地のハッシュと大きさを確かめる。合えば、正規のキーへ S3 の中で写し（「ないときだけ書く」の条件つき。CopyObject は 2025-10-29 から `If-None-Match` の条件を受ける。[Amazon S3 adds conditional write functionality to copy operations](https://aws.amazon.com/about-aws/whats-new/2025/10/amazon-s3-conditional-write-functionality-copy-operations)、2026-10-09 に確認。既にあれば写さない）、`incoming` を消し、ブロックの索引に `live` で入れる。合わなければ `incoming` を消して、commit に失敗を返す。
4. commit は、一覧のすべてのブロックが、要求した主体にとって `have`（読める名前空間の参照にある）・`copy`（読める他のテナントの参照から写した）・`granted`（この主体が送って検証された許可がある）のどれかで、索引で `live` か `orphaned`（`deleting` でない）であることを、同じトランザクションで確かめる（[ADR-0018](0018-upload-sessions-and-block-grants.md)）。

> 2026-10-09 の注記：最初の起票は「索引で `live` なら受ける」だった。これでは、読めない名前空間のブロックのハッシュを知るだけで、送らずに commit して他人の中身を自分のファイルにできる。ADR-0018 が受ける条件を `have`・`copy`・`granted` に絞り、この穴を塞いだ。

- クライアントは正規のキーに書けない。IAM の方針で、クライアントに渡す署名の役割の書き込みを `incoming` に限る。
- 中身はサーバーの ECS を通らない（`block-verifier` は S3 の中の写しと属性の読み出しだけ）。

### ダウンロード

- サーバーは、`can()` で読めると判定したリビジョンのブロックに、CloudFront の署名つき URL（`content.<brand>usercontent.<domain>`、期限 1 時間）を返す。CloudFront は OAC で `blocks` バケットから読む。ブロックは不変なので、エッジで長くキャッシュする。国外のエッジでのキャッシュの扱いは法務の L5。

### 暗号化

- SSE-KMS（バケットごと・リージョンごとのカスタマー管理のキー）と S3 のバケットキー。顧客の鍵（BYOK）は MVP の後（E16）。

### 保存のクラスと費用

- `sc=l`（128 KiB 以上）は Intelligent-Tiering で直接置く。非同期の取り出しが要るアーカイブの層は有効にしない（復元とプレビューを待たせないため）。
- `sc=s`（128 KiB 未満）は Standard に置く（Intelligent-Tiering の監視の外で、IA の最小の課金にも当たるため）。
- 小さなブロックをまとめるパック（案 2）は、S2 の前に、オブジェクトの数と要求の費用を測って block-storage の領域で決める。

### 削除と GC

- ブロックの状態は `live` → `orphaned`（参照の和が 0 になった時刻を持つ）→ `deleting` → 消す、とする。
- 参照の和は `ns_block_refs` の名前空間ごとの和（[ADR-0003](0003-dedupe-scope-and-privacy.md)）。リビジョンの保持の期限が切れたときに減る（versions-and-recovery の領域）。
- `block-gc` は、`orphaned` から **7 日** を過ぎ、行のロックの下で参照がまだ 0 のブロックだけを `deleting` にして消す。commit は同じ行のロックの下で `live` を確かめ、`orphaned` なら `live` に戻して参照を足す。`deleting` のブロックを参照する commit は、そのブロックを「送れ」に戻す。
- 消したオブジェクトは、S3 のバージョニングで **30 日** 戻せる（古いバージョンを 30 日で消すライフサイクル）。GC の誤りに気づいたら、古いバージョンから戻す（runbook）。
- テナントの削除・解約では、索引の行を消し、GC と同じ経路で消す。最後のバイトが消えるまでの日数（7＋30 日と、大阪の写し）は法務の L6 の約束に合わせる。

### 照合

- 毎日：ブロックの 0.1% を抜き取り、S3 の SHA-256 と索引を比べる。
- 毎日：すべての確定したリビジョンのうち、その日に作られたものと抜き取りで、一覧のブロックが索引で `live` であることを確かめる。
- 毎週：S3 Inventory と索引を突き合わせ、索引にないオブジェクト（GC の対象）と、オブジェクトのない索引の行（SEV の候補）を数える。

### DR

- `blocks` と `blocklists` を、大阪へ CRR（Replication Time Control を有効にし、15 分を目標）で写す。RTC は多くのオブジェクトを数秒で、99.9% を 15 分以内に写す。転送が既定の 1 Gbps の割り当てを超える間と、要求の上限を超える間は、RTC の SLA が当たらない（[Meeting compliance requirements with S3 Replication Time Control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)、2026-10-09 に確認）。S1 の新しいデータは平均 450 MB/秒（約 3.6 Gbps）なので、割り当ての引き上げを E1 の `s3-buckets-baseline` で申請する。削除のマーカーも写し、大阪でも古いバージョンを 30 日で消す。大阪の写しは、`sc=l` を Glacier Instant Retrieval、`sc=s` を Standard に置く。
- メタデータは Aurora Global Database で写す（RPO 1 分）。大阪へ切り替えたとき、大阪にまだ届いていないブロックを参照するリビジョンは「中身の待ち」にし、そのファイルを手元に持つ端末へ送り直しを求める（NFR-005 の中身の RPO 15 分。infrastructure の領域）。

### 他の案を選ばなかった理由

- **2（パック）**：オブジェクトの数と要求は減るが、パックの中の一部の削除に、詰め直し（コンパクション）が要る。GC の誤りの余地が増え、Intelligent-Tiering の層がパックの単位になる。S1 の量では、まず 1 ブロック 1 オブジェクトで測る。
- **3（1 バージョン 1 オブジェクト）**：バージョンの間でブロックを共有できず、差分の送信と重複排除が効かない。
- **4（サーバーが受ける）**：ピークで 2 GB/秒の中身が ECS を通り、転送の費用と台数が増える。中身を読む部品が増え、通信の秘密（法務の L1）の論点も広がる。

## Consequences

- 良くなること：
  - 物理の耐久性を S3 に任せ、本システムは参照・猶予・照合・バージョニングの論理の守りに集中できる。
  - 中身がサーバーを通らず、送受信の量に応じてサーバーを増やさなくてよい。
  - クライアントが正規のキーに書けないので、重複排除の漏れとブロックの書き換えを防げる。
- 引き受けるコスト：
  - 新しいブロックごとに、`incoming` への PUT、写し、削除の 3 つの要求がかかる。
  - 小さなファイルが多いテナントで、オブジェクトの数と要求の費用が増える。
  - 大阪の写しで、保存の費用が増える（Glacier Instant Retrieval で抑える）。DR の時の取り出しの料金を引き受ける。
  - 消した中身が最後に消えるまで、最大で 37 日と写しの分の時間がかかる。

## Confirmation

- IAM の方針の検査（CI）：クライアントへの署名の役割が、`incoming` の PUT だけを持ち、`blocks`・`blocklists` に書けない。
- 結合テスト（LocalStack と実の S3 の検証の環境）：チェックサムの合わないブロックが索引に入らない。`deleting` のブロックを参照する commit が「送れ」に戻る。GC と commit を並行に流して、参照のあるブロックが消えない。
- 性質ベーステスト：任意の commit・保持の期限切れ・GC の列で、確定して保持の期間の中のリビジョンのすべてのブロックが `live` である。
- 本番：照合の結果（チェックサムの不一致、オブジェクトのない索引の行）を SLI にする（[runbooks/README.md](../runbooks/README.md)）。CRR の遅れを監視する。

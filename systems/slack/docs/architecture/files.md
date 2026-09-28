# Files: Slack

ファイルのアップロード、スキャン、サムネイル、配信、削除。スキャンと配信の方式は [ADR-0015](../decisions/0015-file-upload-scan-and-delivery.md) で決めた。S3 のキーは `ws/{workspace_id}/files/{file_id}`（[ADR-0009](../decisions/0009-pooled-tenancy-with-rls.md)）。

## 1. 方針

- **利用者が上げたバイト列を、そのまま inline で表示しない。** 原本は常にダウンロードとして配る。画面に出すのは、サーバーが再エンコードしたサムネイルだけ。
- **スキャンで問題がないと分かるまで、誰も読めない。** S3 のバケットポリシー（タグによるアクセス制御）と、DB のファイルの状態の、二重で止める。
- **1 つのファイルは 1 つのメッセージにだけ付く。** ファイルを読めるかは、そのメッセージのチャンネルを読めるかで決まる。権限の規則が増えない。
- MVP のプレビューは画像まで（intent.md）。PDF や動画のプレビューは範囲外。

## 2. 構成

| 資源 | 用途 |
| --- | --- |
| S3 `uploads` バケット | 原本。GuardDuty Malware Protection for S3 の保護対象。キーは `ws/{workspace_id}/files/{file_id}` |
| S3 `derived` バケット | サムネイルと、リンクのプレビューの画像。サーバーが生成したものだけを置く。スキャンの対象外 |
| CloudFront（ファイル専用のドメイン） | 配信。署名付き URL が必須。アプリとは別のドメインにし、Cookie を持たない |
| SQS `file-events` | スキャン結果とサムネイル生成のジョブ |
| file Worker（ECS） | 状態の更新、内容の判定、サムネイル生成、削除 |

- 両方のバケットで、パブリックアクセスをすべて遮断する。読み出しは CloudFront（OAC）と file Worker にだけ許す。
- `derived` バケットのキーも `ws/{workspace_id}/files/{file_id}/thumb_{幅}.webp` の形にする。
- 暗号化は SSE-KMS とバケットキーにする（`files` の鍵。[ADR-0017](../decisions/0017-encryption-and-key-management.md)）。そのため、GuardDuty が使う IAM ロールに、その鍵の `kms:GenerateDataKey` と `kms:Decrypt` を、`kms:ViaService` を S3 に限る条件付きで与える（[AWS のドキュメント](https://docs.aws.amazon.com/guardduty/latest/ug/malware-protection-s3-iam-policy-prerequisite.html)）。

## 3. 状態

```
pending_upload ──complete──▶ scanning ──NO_THREATS_FOUND──▶ processing ──▶ ready
      │                         │
      │ 24h 未完了               ├─THREATS_FOUND──────────▶ blocked
      ▼                         ├─UNSUPPORTED / ACCESS_DENIED─▶ unscannable
   (GC で削除)                   └─FAILED / 15 分以内に結果なし─▶ 再スキャン ─▶ failed

どの状態からでも ──▶ deleted
```

`files` に足す列：`status`、`name`、`declared_mime`、`detected_mime`、`width`、`height`、`scan_result`、`scanned_at`、`deleted_at`（[data-model/files-and-search.md](data-model/files-and-search.md) に反映済み。キーは ID から決まるので列に持たない）。

## 4. アップロード

1. **作成**：`POST /workspaces/{ws}/files` `{ name, size, mime }`
   - 大きさ（100 MB 以下）、ワークスペースの容量（7 節）、アップロードのレートを確かめる。
   - `files` に `pending_upload` で INSERT し、容量を予約する。
   - 署名付きの PUT の URL を返す。有効期限は 15 分。
2. **PUT**：クライアントが S3 へ直接 PUT する。
   - URL の署名に、`Content-Length`（申告した大きさ）と `Content-Type` を含める。署名に含めたヘッダーが実際のリクエストと違えば、S3 は `SignatureDoesNotMatch` で拒否する（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html#PresignedUrlFAQ)）。ただし、署名付き PUT で `Content-Length` を強制できると明示した公式の記述はない（未検証。POST の `content-length-range` のような大きさの条件は PUT にない）。着手前に、申告と違う大きさの PUT が拒否されるかを PoC で確かめる。強制されなくても、3 の検査で止める。
   - S3 の CORS は、アプリのオリジンからの PUT だけを許す。
3. **完了**：`POST /workspaces/{ws}/files/{id}/complete`
   - API が `HeadObject` で、オブジェクトがあり、大きさが申告と一致することを確かめる。違えばオブジェクトを消し、400 を返す。
   - 状態を `scanning` にする。
4. **投稿**：メッセージの投稿（[messaging.md](messaging.md)）に `file_ids` を付ける。
   - 付けられるのは、自分が上げた、まだどのメッセージにも付いていない、`scanning` / `processing` / `ready` のファイル。
   - スキャンの完了を待たずに投稿できる。画面には「スキャン中」と出し、状態が変わったら `file.updated` で更新する。

- 大きなファイル（100 MB 超、最大 1 GB）のマルチパートアップロードは、S2 で足す。
- ファイルの種類は、拡張子や MIME で制限しない。危険は、スキャン（5 節）と配信の仕方（6 節）で抑える。

## 5. スキャンと隔離

GuardDuty Malware Protection for S3 を使う（2026-09 に AWS のドキュメントで確認）。

- 保護対象のバケットにオブジェクトが作られると（PutObject、CompleteMultipartUpload など）、自動でスキャンが始まる。
- 結果は EventBridge の既定のイベントバスに届く。タグ付けを有効にすると、オブジェクトに `GuardDutyMalwareScanStatus` のタグが付く。値は `NO_THREATS_FOUND`、`THREATS_FOUND`、`UNSUPPORTED`、`ACCESS_DENIED`、`FAILED` のいずれか。
- タグ付けは、バケットの保護を有効にするときに設定する。後から有効にしても、それ以前のオブジェクトには付かない。
- 結果の通知は at-least-once で、同じオブジェクトの結果が重複して届きうる。
- 上限：オブジェクトの大きさ 100 GB、アーカイブの展開 100,000 ファイル・入れ子 100 段、保護できるバケットは 1 アカウント・1 リージョンあたり 25。
- 料金は、スキャンしたデータ量とオブジェクト数に応じてかかる（us-east-1 で 1 GB あたり 0.09 ドル、1,000 オブジェクトあたり 0.215 ドル。毎月 1 GB・1,000 件の無料枠）。ほかに、タグ付け、GuardDuty が呼ぶ S3 の API、EventBridge のイベントの料金が別にかかり、無料枠に含まれない（[GuardDuty の料金](https://aws.amazon.com/guardduty/pricing/)、[AWS のドキュメント](https://docs.aws.amazon.com/guardduty/latest/ug/pricing-malware-protection-for-s3-guardduty.html)）。東京の単価は未検証（料金ページのリージョン別の表を取得できなかった）。着手前に料金ページで確かめる。

### 5.1 隔離

**タグによるアクセス制御（TBAC）**：`uploads` バケットのポリシーで、GuardDuty のロール以外は、`GuardDutyMalwareScanStatus = NO_THREATS_FOUND` のタグがないオブジェクトを `GetObject` できないようにする。CloudFront と file Worker も、この制限を受ける。あわせて、GuardDuty のロール以外がこのタグを書き換えることを禁止する（AWS のドキュメントにあるポリシーの例に従う）。

**DB の状態**：API は、`ready` 以外のファイルの URL を発行しない。

どちらか一方に誤りがあっても、スキャン前・感染したファイルは配られない。

### 5.2 結果の処理

EventBridge のルールで、スキャン結果を SQS `file-events` に送る。file Worker が次を行う。

1. S3 のキーから `workspace_id` と `file_id` を取り出し、テナントのコンテキストを設定する。
2. 状態が `scanning` のときだけ遷移させる（重複した結果は無視する）。

| 結果 | 次の状態 | 行うこと |
| --- | --- | --- |
| `NO_THREATS_FOUND` | `processing` | 内容の判定とサムネイル生成（5.3 節） |
| `THREATS_FOUND` | `blocked` | 投稿者とワークスペースの管理者に知らせる。監査ログに残す。オブジェクトは TBAC で読めないまま 30 日保管し、S3 のライフサイクル（タグで絞る）で消す |
| `UNSUPPORTED` / `ACCESS_DENIED` | `unscannable` | 配らない（安全側）。画面には「スキャンできないファイル」と出す |
| `FAILED` | 再スキャン | GuardDuty のオンデマンドスキャンで 1 回だけやり直す。再び失敗したら `failed` にし、配らない |

- 15 分たっても結果が来ない `scanning` のファイルは、定期ジョブが再スキャンに回す。
- 状態が変わったら、ファイルが付いたメッセージのチャンネルに `file.updated` を積む（`seq` を消費する）。

### 5.3 内容の判定とサムネイル

- **内容の判定**：原本の先頭のバイト列から、実際の種類（`detected_mime`）を判定する。申告と違ってもアップロードは拒否しないが、画面とダウンロードには判定した種類を使う。
- **サムネイル**：`detected_mime` が JPEG・PNG・GIF・WebP の画像なら、幅 360・720・1440 の WebP を作り、`derived` バケットに置く。
  - 画素数の上限（5,000 万）を設け、展開の爆弾を防ぐ。
  - EXIF などのメタデータを捨てる。位置情報を漏らさない。
  - アニメーション GIF は、アニメーション WebP にする。
  - SVG は画像として扱わない（スクリプトを含みうる）。
- 画像の復号は攻撃面になるので、サムネイル生成は専用のタスク（ECS）で動かす。権限は `uploads` の読み出しと `derived` への書き込み、状態の更新だけ。メモリと時間（30 秒）に上限を設ける。
- 終わったら `ready` にし、`file.updated` を積む。サムネイル生成に失敗しても `ready` にする（原本のダウンロードはできる）。

## 6. 配信

1. クライアントが `GET /workspaces/{ws}/files/{id}/url?variant=original|thumb_720` を呼ぶ。履歴の取得では、サムネイルの URL をメッセージに含めて返す。
2. API が判定関数（ADR-0005）で、ファイルを読めるかを確かめる。
   - 投稿前のファイル：アップロードした本人だけ。
   - 投稿後のファイル：付いたメッセージのチャンネルを読めて、メッセージが削除されていない。
   - 読めなければ 404。
3. 状態が `ready` なら、CloudFront の署名付き URL を返す。

| 対象 | 有効期限 | 返し方 |
| --- | --- | --- |
| 原本 | 5 分 | `Content-Disposition: attachment`、`Content-Type: application/octet-stream`、`X-Content-Type-Options: nosniff` |
| サムネイル | 15 分 | `Content-Type: image/webp`、inline |

- 応答のヘッダーは、CloudFront の応答ヘッダーポリシーで、経路（原本・サムネイル）ごとに固定する。S3 のメタデータや利用者の申告に頼らない。
- ファイル専用のドメインにし、アプリの Cookie が送られないようにする。HTML や SVG が万一開かれても、アプリのオリジンで動かない。
- **署名付き URL は発行後に取り消せない。** 権限を失った人が、有効期限の間だけ URL を使える。期限を短くして抑える。署名付き Cookie は、同じドメインのすべてのファイルに効くため使わない。
- CloudFront のキャッシュのキーから署名のパラメーターを除き、利用者をまたいでキャッシュを共有する。署名はエッジで確かめてからキャッシュを返す。ファイルを消したら、そのパスを無効化する。
- 署名の鍵は Secrets Manager に置き、CloudFront の信頼された鍵グループで検証する。鍵は RSA 2048 か ECDSA 256 のどちらも使える（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-trusted-signers.html)）。どちらにするかは実装で決める。

## 7. 容量と上限

| 対象 | 上限（MVP） | 超えたとき |
| --- | --- | --- |
| 1 ファイルの大きさ | 100 MB | 400 |
| ワークスペースの容量 | プランごと（例：無料 5 GB） | 作成を 409 で拒否する |
| アップロードの作成 | 1 メンバーあたり 1 分に 20 件 | 429 |
| 1 メッセージの添付 | 10 件（[messaging.md](messaging.md)） | 400 |

- 容量は `workspace_usage (workspace_id, storage_bytes)` で数える。作成時に予約し、失敗・GC・削除で戻す。同じトランザクションで更新する。
- サムネイルとリンクのプレビューの画像は、容量に数えない。
- 容量の上限は [runbooks/README.md](../runbooks/README.md) の 2 節の「ストレージ」にあたる。

## 8. 削除と保持

削除の経路を 1 つにし（`deleteFile`）、すべての削除がそこを通るようにする。保持期間のポリシーは、将来この経路を呼ぶ。

| きっかけ | 行うこと |
| --- | --- |
| メッセージの削除 | 付いたファイルを `deleted` にする |
| ファイルだけの削除（投稿者、管理者） | `deleted` にし、`file.updated` を積む。メッセージには「ファイルは削除されました」と出す |
| 投稿されないまま 24 時間 | GC が消す |
| ワークスペースの削除 | 両バケットの `ws/{workspace_id}/` を一括で消す |
| 保持期間のポリシー（将来） | 期限を過ぎたファイルに `deleteFile` を呼ぶ |

`deleted` にしたあと、file Worker が次を行う。

1. 原本とサムネイルを S3 から消す。
2. CloudFront のキャッシュを無効化する。
3. 容量を戻す。

- `deleted` になった時点で、API は URL を発行しない。S3 からの消去が遅れても、新しく配られることはない。
- バケットのバージョニングを有効にする場合、古いバージョンが残る。ライフサイクルで古いバージョンを 30 日で消し、「削除から 30 日で完全に消える」と定める。
- リーガルホールドがかかったファイルは、`deleteFile` が消さない（将来。[security.md](security.md)）。

## 9. テスト

- 経路ごとの漏洩テスト：別のワークスペース、参加していないチャンネル、削除済みのメッセージのファイルに、URL が発行されない。
- スキャン前・`blocked` のオブジェクトを、CloudFront 経由で取得できない（ステージングで EICAR のテストファイルを使う）。
- 同じスキャン結果が重複・順不同で届いても、状態が正しく遷移する。
- 原本が常に `attachment` で返る。申告と中身が違う（PNG と申告した HTML など）ファイルでも同じ。

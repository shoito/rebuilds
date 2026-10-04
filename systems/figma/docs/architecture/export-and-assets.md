# Export and assets: Figma

書き出し（PNG・JPG・SVG・PDF）、サーバーでの描画、画像、フォント、サムネイル。ファイルの中身の外にあるバイト列（画像・フォント・書き出しの結果・サムネイル）の置き場所と配り方を決める。

前提となる決定は、描画のエンジンを Rust で書き、同じコードをネイティブでも動かすこと（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0004](../decisions/0004-gpu-rendering-in-wasm.md)）、ファイルの中身を読む経路を限ること（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)）、画像をファイルに入れずハッシュで参照すること（[document-model.md](document-model.md) の 9.5 節）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0034](../decisions/0034-export-rendering-split.md) | 画面からの書き出しはクライアントのエンジンで行う。サムネイル・API・大きな一括の書き出しは、ネイティブのエンジンの Render Worker で行う |
| [0035](../decisions/0035-content-addressed-images.md) | 画像は組織ごとに中身の SHA-256 で重複を除く。クライアントで正規化してから署名付き PUT で上げ、別ドメインの CDN から短命の署名付き URL で配る |
| [0036](../decisions/0036-font-sources-and-licensing.md) | フォントの出どころは、同梱のオープンなフォント・組織のフォント・端末のフォントの 3 つ。サーバーの描画と PDF への埋め込みは、ライセンスの確かなものに限る |

## 1. 目的と範囲

- 扱う：書き出しの設定と形式、書き出しをどこで描くか、Render Worker、画像のアップロード・重複の除去・縮小版・配信・削除、フォントの出どころ・配信・代わりのフォント、サムネイル、外部の URL からの画像の取り込み。
- 扱わない：画面の描画とテキストの整形（rendering-engine.md）、画像のデコードと GPU のメモリ（rendering-engine.md）、SVG の読み込みの UI（editor-and-tools.md）、バージョンとチェックポイントの保存（[file-storage-and-history.md](file-storage-and-history.md)）、権限の判定関数（permissions-and-sharing.md）、公開 API の `/images`（[api-and-webhooks.md](api-and-webhooks.md)。描画はこの文書の Render Worker を使う）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 形式 | PNG・JPG・SVG・PDF。倍率（`2x`）、幅（`w`）、高さ（`h`）で大きさを指定。接尾辞。色のプロファイル（ファイルと同じ・sRGB・Display P3）。JPG は既定で高品質、PDF は既定で中品質。SVG と PDF は 1x だけ。SVG は「テキストをアウトライン化」「id 属性を含める」「線を単純化」。PNG・JPG・SVG は「重なるレイヤーを無視」「境界の箱を含める」（[Export formats and settings for static designs](https://help.figma.com/hc/en-us/articles/13402894554519-Export-formats-and-settings-for-static-designs)） | 同じ項目を `ExportSetting` に持つ（4.1 節） |
| API の書き出し | 倍率 0.01〜4。32 メガピクセルまで、超えたら縮小。結果の URL は 30 日で切れる。描けなかったノードは `null`（[File endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)） | 倍率と上限は同じ。URL の期限は短くする（4.4 節） |
| 画像の取り込み | 長辺が 4096 px を超える画像は、長辺 4096 px 以下に縮める。メタデータの一部は失われうる（[Add images and videos to designs](https://help.figma.com/hc/en-us/articles/360040028034-Add-images-and-videos-to-designs)。検索結果の要約で確認） | 同じ上限。縮小とメタデータの除去をクライアントで行う（6.2 節） |
| 画像の参照 | 画像の塗りは `imageRef` で参照し、`GET image fills` が URL を返す。URL は 14 日以内に切れる（[File endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)） | `image_hash`（SHA-256）で参照する（document-model.md） |
| 既定のフォント | Google Fonts と Apple のフォントが既定で使える。ChromeOS・Linux では端末のフォントを使えない（[Add a font to Figma](https://help.figma.com/hc/en-us/articles/360039956894-Add-a-font-to-Figma)） | 同梱のオープンなフォント（7.2 節） |
| 端末のフォント | ブラウザでは、常駐の補助のアプリ（font installer）を入れる。補助のアプリは本家のドメインからの接続だけを受ける（同上） | Chromium では Local Font Access API、補助のアプリは MVP の後（7.4 節） |
| 組織のフォント | Organization・Enterprise のプランで、組織・チームの管理者が .TTF・.OTF を上げる。Web フォントは上げられない。上げる人は、権利を持つことを確かめる（[Upload and manage shared fonts](https://help.figma.com/hc/en-us/articles/360039956774-Upload-and-manage-shared-fonts)） | 同じ（7.3 節） |
| サーバーでの描画 | エンジンの C++ をネイティブにもビルドし、サーバーで使う（[Figma rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)、2025-09-18） | Rust のエンジンをネイティブにビルドする（5 節） |

いずれも 2026-09-27 に確認。画面からの書き出しを本家がクライアントで描くかサーバーで描くかは、公開の資料で確かめられなかった（**未検証**）。

## 3. 全体構成

```
ブラウザ
 ├─ エンジン（WASM）：画面からの書き出し（PNG・JPG・SVG・PDF）、画像の正規化とハッシュ
 └─ UI の殻：書き出しのパネル、フォントの選択、画像のアップロード
      │ 1. 画像の登録（ハッシュ）        │ 3. 画像・フォントの取得（署名付き URL）
      ▼                                  ▼
 API（Hono）── Aurora（images・org_fonts・export_jobs・file_thumbnails）
      │ 2. 署名付き PUT                   CloudFront（assets.<brand>usercontent.<domain>）
      ▼                                        ▲
 S3（assets バケット）◀── Worker（image-ingest・font-ingest。TypeScript＋Rust の検査器）
      ▲
      │ 書き出し・サムネイルの結果
 Render Worker（Rust ネイティブ。SQS render-export・render-thumbnail）
      │ 読むだけ
      ▼
 S3 のチェックポイント＋Journal（DynamoDB）
```

- **利用者が上げたバイト列は、アプリと別のドメイン `assets.<brand>usercontent.<domain>` から配る**（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。Cookie を持たないドメインにし、アプリのオリジンで SVG や HTML が動かないようにする（Slack の [ADR-0015](../../../slack/docs/decisions/0015-file-upload-scan-and-delivery.md) と同じ考え方）。
- Render Worker は、書き出しとサムネイルだけの独立したサービスにする。重い描画が、Document Server と API の遅延（NFR-001）に響かないようにする。

## 4. 書き出し

### 4.1 書き出しの設定

ノードの `export_settings`（[document-model.md](document-model.md) の 4.2 節、プロパティ 70、最大 16 個）に保存する。配列全体が 1 つの競合の単位。

```
ExportSetting {
  format: Png | Jpg | Svg | Pdf,
  constraint: Scale(f32) | Width(u32) | Height(u32),   // Svg・Pdf は Scale(1.0) だけ
  suffix: String,                // 最大 64 バイト。ファイル名に使える文字だけ
  color_profile: Document | Srgb | DisplayP3,
  jpg_quality: Low | Medium | High,     // 既定 High（本家と同じ）
  pdf_image_quality: Low | Medium | High,   // 既定 Medium（本家と同じ）
  contents_only: bool,           // 既定 true：重なるレイヤーを無視（Pdf では常に true）
  use_absolute_bounds: bool,     // 既定 false：境界の箱を含める
  svg_outline_text: bool,        // 既定 true
  svg_include_id: bool,          // 既定 false
  svg_simplify_stroke: bool,     // 既定 true
  resampling: Detailed | Basic,  // 既定 Detailed（双三次）、Basic は最近傍（本家と同じ）
}
```

- `Scale` は 0.01〜4（本家の API と同じ）。`Width`・`Height` は 1〜16,384 px。
- `SLICE` のノードは、範囲だけを持つ書き出しの対象である（[document-model.md](document-model.md) の 3 節）。描くのは、範囲に重なる兄弟と子孫。

### 4.2 どこで描くか

ADR-0034。

| 経路 | 描く場所 | 理由 |
| --- | --- | --- |
| 画面からの書き出し（選択したノード、1 回に最大 500 個） | クライアントのエンジン | 待たずに出せる。端末のフォント（7.4 節）を使える。サーバーの費用がかからない |
| 画面からの一括の書き出し（ファイル全体、500 個を超える、合計 200 メガピクセルを超える） | Render Worker | タブのメモリ（NFR-004）を超えないため |
| サムネイル（8 節） | Render Worker | 誰もファイルを開いていなくても作る |
| 公開 API の `/images`（[api-and-webhooks.md](api-and-webhooks.md)） | Render Worker | 同上 |
| 描画の一致のテスト | 両方 | 同じ参照ファイルを両方で描き、差を比べる（13 節） |

- クライアントの書き出し：
  - PNG・JPG：エンジンがオフスクリーンのテクスチャに描き、読み戻して、Web Worker で符号化する。GPU のテクスチャの上限（WebGL2 は端末ごと。4096〜16,384 px）を超える大きさは、タイルに分けて描いてつなぐ。
  - SVG：シーングラフから SVG の要素を書く。エフェクト（ぼかし、影）は SVG のフィルタに変換する。変換できないもの（背景のぼかし、一部のブレンドモード）は、その部分を PNG にして `<image>` で埋める。
  - PDF：シーングラフから PDF の描画の命令を書く（Rust の PDF の書き出しの crate を使う。候補は rendering-engine.md で PoC）。テキストの扱いは 7.6 節。
- 書き出しは、クライアントが今持つ状態（未確定の自分の変更を含む）を描く。サーバーの書き出しは、確定した `seq` を描く（5.2 節）。

### 4.3 形式ごとの規則

| 形式 | 規則 |
| --- | --- |
| PNG | 透過あり。色のプロファイルが Display P3 のときは ICC を埋める |
| JPG | 透過は白で塗る。品質は Low 60・Medium 80・High 92（この設計の値。本家の値は **未検証**） |
| SVG | 1x だけ。`svg_include_id` のとき、レイヤー名を `id` に入れる。名前は XML の属性として正しくエスケープし、`id` に使えない文字は `_` に置き換える。`<script>`・イベントの属性・外部の参照（`href` の http(s)）は書かない。画像は `data:` の URI で埋める |
| PDF | 1x だけ。ページはノードごとに 1 ページ。JavaScript・フォームの動作・外部のファイルの起動（Launch）の注釈は書かない。リンクは http(s) の URI だけ |

### 4.4 上限

| 項目 | 上限 | 超えたら |
| --- | --- | --- |
| 1 枚の画素数（PNG・JPG） | 32 メガピクセル（本家の API と同じ） | 縮めて書き出し、画面に知らせる |
| 1 回の画面からの書き出し | 500 個・合計 200 メガピクセル | Render Worker の一括の書き出しに回す |
| 1 回の一括の書き出し | 5,000 個・1 GiB（ZIP） | 拒否。ページごとに分けるよう案内する |
| Render Worker の 1 ジョブの時間 | 60 秒（一括は 1 個ごとに 60 秒、全体 30 分） | 失敗。そのノードは `null` |
| SVG・PDF の出力 | 1 個 200 MiB | 失敗 |
| サーバーの書き出しの結果の保持 | 14 日（S3 のライフサイクル） | 消す。本家の API は 30 日。短くするのは、結果の URL の漏れの影響を小さくするため |
| 結果の署名付き URL | 24 時間 | 取り直す |

## 5. Render Worker（サーバーでの描画）

ADR-0034。

### 5.1 構成

- Rust のネイティブのバイナリ。エンジンの crate（`doc-model`・レイアウト・描画）を、ブラウザと同じバージョンで使う（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- ECS Fargate（CPU だけ。GPU はない）で動かす。wgpu の Vulkan のバックエンドを、Mesa の lavapipe（CPU の Vulkan の実装）の上で動かす（[ADR-0004](../decisions/0004-gpu-rendering-in-wasm.md)、[ADR-0014](../decisions/0014-gpu-backend-selection-and-fallback.md)）。10 万ノードの参照ファイルのサムネイルを p95 10 秒以内に描けるかは **未検証**（E10 の `render-worker-core` の PoC で計測する）。lavapipe は Vulkan 1.3 の適合を得ている（Khronos の Vulkanised 2025 の発表 [Current state of Lavapipe](https://vulkan.org/user/pages/09.events/vulkanised-2025/T5-Lucas-Fryzek-Igalia.pdf)、2025-02-13、2026-09-27 に確認）。足りなければ足りなければ GPU のインスタンス（ECS on EC2）を別の ADR で検討する。
- キューは 2 つに分ける：`render-export`（利用者が待つ。優先）、`render-thumbnail`（待たない。ファイルのサムネイルと、コメントの通知のプレビューの画像。[comments-and-notifications.md](comments-and-notifications.md) の 5.5 節）。同じサービスの 2 つのタスクの群れで受ける。
- **1 ジョブを 1 つの子プロセスで描く。** 親のプロセスが SQS を受け、子のプロセスを起こし、結果を受け取って S3 に書く。子は、メモリの上限（`RLIMIT_AS` 8 GiB）と時間の上限を持ち、描き終えたら終わる。組織をまたいで、メモリに前のジョブの中身が残らないようにする。

### 5.2 ファイルの読み方

1. ジョブには `org_id`・`file_id`・`seq`（描くバージョン）・ノードの ID・設定が入る。ジョブを作るときに、API が判定関数で権限を確かめる（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)）。Render Worker は権限を判定しない。
2. 子のプロセスは、`seq` 以下で最新のチェックポイントを S3 から読み、`seq` までのジャーナルを当てる（[ADR-0003](../decisions/0003-journal-and-checkpoints.md) の回復と同じコード）。Document Server には問い合わせない。持ち主の負荷を増やさないため。
3. 対象のノードを含むページのチャンクだけを読む（[document-model.md](document-model.md) の 8.2 節）。
4. 画像は `images/{org_id}/{sha256}` から、描く大きさに合う縮小版を読む（6.4 節）。フォントは 7.5 節の規則で集める。
5. レイアウトは、保存された `derived_layout` を使う（[document-model.md](document-model.md) の 9.2 節）。フォントがなくても、行の位置は画面と同じになる。ただし、インスタンスの中の導出したノードは保存されないので、子のプロセスが導出（[components-and-libraries.md](components-and-libraries.md) の 3.3 節）の後に、同じ `layout` の crate で計算する（[layout.md](layout.md) の 4.1 節、ADR-0019・0020）。文書のフラグはマニフェストの `features` に従う（ADR-0055）。

- 同じ `(file_id, seq, ページ)` を続けて描くときのために、子のプロセスを起こす前の読み込み（チャンクの復号）の結果を、ローカルのディスクに 10 分キャッシュする（組織ごとのディレクトリ）。

### 5.3 通信の制限

- Render Worker のタスクは、インターネットへの経路を持たない。S3・SQS・DynamoDB・Aurora（ジョブの状態の更新）には VPC エンドポイントで届く。外部の URL の画像を描くことはない（9 節で、取り込みの時点で S3 に入れる）。
- 子のプロセスは、親とのパイプ以外の通信を持たない。子は起動の直後に、自分で `PR_SET_NO_NEW_PRIVS` を立てて seccomp のフィルタを入れ、`socket`・`connect`・`bind` などを禁止する（特権を要らない）。ネットワークの名前空間は使わない。Fargate は特権のコンテナを許さず、`CAP_SYS_ADMIN`・`CAP_NET_ADMIN` を与えない（足せるのは `CAP_SYS_PTRACE` だけ）ため（[Fargate security considerations for Amazon ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-security-considerations.html)、2026-09-27 に確認）。
  - > 2026-09-27 の注記：「ネットワークの名前空間を分け、使えなければ seccomp」を、seccomp だけに改めた。

## 6. 画像

ADR-0035。

### 6.1 形式と上限

| 項目 | 値 |
| --- | --- |
| 受け付ける形式 | PNG、JPEG、GIF（最初のコマだけ。アニメーションはプロトタイピングの後）、WebP。HEIC・AVIF・TIFF は MVP では受けない |
| 大きさ | 1 枚 20 MiB まで（正規化の後） |
| 画素 | 長辺 4,096 px まで（本家と同じ）。超えたらクライアントが縮める |
| 1 ファイルの画像 | 参照は数えない（ファイルの大きさの上限で抑える）。1 組織の画像の合計に上限を置かない。1 枚の上限とファイルの大きさの上限で抑え、組織ごとの合計を計測する（2026-09-27 に推奨案で確定。本家にプランの容量の上限があるかは **未検証**） |

### 6.2 アップロードの流れ

```
クライアント（エンジン）                API                          S3 / Worker
 1. 読み込み・形式の判定（先頭のバイト）
 2. 長辺 4096 px を超えたら縮める
 3. メタデータを除く（EXIF・XMP・位置情報。再符号化しない）
 4. SHA-256 を計算 → image_hash
 5. Paint に image_hash を入れて、すぐ描く（未確定の変更として送る）
 6. POST /internal/files/{file_key}/images { sha256, bytes, mime, width, height }
                                      → 編集の権限を判定関数で確かめる
                                      → images に (org_id, sha256) がある：{ status: "ready" }
                                      → ない：行を pending で作り、署名付き PUT を返す
                                         （Content-Length・Content-Type・x-amz-checksum-sha256 を署名に含める）
 7. PUT（S3 がチェックサムを検証する）  ──────────────────────────▶ images/{org_id}/{sha256}
                                                                   S3 のイベント → SQS image-ingest
                                                                   8. 検査と縮小版（6.3 節）→ ready
 9. Realtime で ready を受け、他の人の画面も本物の画像に替わる
```

- **重複の除去は組織の中だけで行う。** 同じ画像を別の組織が上げても、別のオブジェクトにする。組織をまたいで除くと、「このハッシュの画像がすでにある」という応答（6 の `ready`）から、他の組織が持つ画像を当てられる。
- 他の人の画面では、`pending` の画像を灰色の置き場所で描く。10 分たっても `ready` にならない画像は「読み込めない画像」と表示する（10 節）。
- 画像を参照する変更を、Document Server は `images` の表と照らさない（変更の確定の経路に Aurora を入れない。NFR-001）。組織に存在しないハッシュは、描画と書き出しで「読み込めない画像」になるだけで、他の組織の画像には届かない（6.4 節の署名は組織の中の表だけを引く）。
- ファイルの複製で組織が変わるとき（ゲストが自分の組織へ複製する）は、複製のジョブが `blob_refs_chunk`（[document-model.md](document-model.md) の 8.2 節）の画像を新しい組織の鍵へ S3 の中でコピーし、`images` の行を作る。呼び口は [file-storage-and-history.md](file-storage-and-history.md) の複製の手順の `assets.copy_refs(src_file, dst_file, hashes)` とする。同じ組織の中の複製では何もしない。

### 6.3 取り込みの検査（image-ingest）

Worker（TypeScript）が、Rust の検査器（`asset-inspect`。子プロセスで動かす）を呼ぶ。

| 検査 | 失敗したら |
| --- | --- |
| 中身の SHA-256 が鍵と一致する（S3 のチェックサムに加えて確かめる） | `rejected` |
| 先頭のバイトの形式が `mime` と一致し、6.1 節の形式である | `rejected` |
| ヘッダーの幅・高さが 4,096 px 以下で、登録の値と一致する | `rejected` |
| 全体をデコードできる（デコードの前に画素数でメモリを見積もり、上限 64 MiB を超える確保をしない） | `rejected` |
| EXIF・XMP の位置情報が残っていない | `rejected`（クライアントの不具合として数える） |
| GuardDuty Malware Protection for S3 の結果（Slack の ADR-0015 と同じ） | `NO_THREATS_FOUND` 以外は `rejected` |

- 検査に通ったら、縮小版を作る：長辺 2048・512・128 px の WebP（`images/{org_id}/{sha256}/w2048.webp` など）。元の長辺より大きい段は作らない。
- `rejected` の画像は配らない。参照するノードは「読み込めない画像」になる。

### 6.4 配信

- クライアントは、描く画像のハッシュを集めて `POST /internal/files/{file_key}/images:sign { hashes, size }` を呼ぶ。API は、閲覧の権限を判定関数で確かめ、`images` の表（ファイルを持つ組織）に `ready` の行があるハッシュだけに、CloudFront の署名付き URL を返す。
- 署名付き URL の期限は 15 分。パスはハッシュで決まるので、中身は不変で、CloudFront と S3 の応答に `Cache-Control: public, max-age=31536000, immutable` を付ける。署名の検査は CloudFront の縁で要求ごとに行い、署名の引数をキャッシュの鍵に含めない。署名付き URL は取得を許すもので、キャッシュしたオブジェクトは中身のハッシュで名付けた不変のものである。パスが組織を含む（`images/{org_id}/{sha256}`）ので、ある組織の文脈で出した URL で他の組織のオブジェクトは取れず、キャッシュを組織の間で共有しない（[permissions-and-sharing.md](permissions-and-sharing.md) の 11 節と揃えた）。CloudFront は、署名と方針（期限）を確かめてから、キャッシュを見る。期限は要求の時点で確かめる。署名の引数（`Expires`・`Key-Pair-Id`・`Policy`・`Signature`）はオリジンへ送る前に外す（[Use signed URLs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-urls.html)、[Cache content based on query string parameters](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/QueryStringParameters.html)、いずれも 2026-09-27 に確認）。キャッシュの方針はクエリ文字列を鍵に含めない。E10 の `image-sign-endpoint` の PoC では、実際の配信で、キャッシュに当たった要求でも署名のないものと期限の切れたものが 403 になることを結合テストで確かめる。
- CloudFront は `OPTIONS` の要求では署名を確かめない（同上の Use signed URLs）。署名の要る経路（`files`・`assets` の `<brand>usercontent`）の許すメソッドは `GET`・`HEAD` だけにする。チャンクと画像の `fetch` は単純な要求（独自のヘッダーなし）にして、事前の確認（preflight）を起こさない。
- CloudFront の標準のログは、クエリ文字列（署名を含む）を記録する（同上）。ログの置き場所は security.md の 7 節の保持と権限に従う。
- 応答のヘッダーは経路ごとに CloudFront で固定する：`Content-Type` は登録の値、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox; default-src 'none'`、`Cross-Origin-Resource-Policy: cross-origin`（エンジンが `fetch` で読むため。CORS はアプリのオリジンだけを許す）。
- ブラウザは、読んだ画像をキャッシュ（Cache Storage）に鍵をハッシュにして持つ。権限を失った後も、端末に残ったキャッシュは消せない（本家も同じとみなす。**未検証**）。

### 6.5 削除（参照の数え上げ）

- 画像の参照は、各ファイルのチェックポイントの `blob_refs_chunk` にある。参照の数は数えない。ファイルやバージョンを消すとき（[file-storage-and-history.md](file-storage-and-history.md) の削除の手順）に、この領域で行うことはなく、次の掃除で消える。
- 週に 1 回、組織ごとに「残している全チェックポイント（バージョンの履歴を含む）の `blob_refs_chunk` の和集合」を作り、どこからも参照されず、作ってから 7 日を過ぎた画像を消す（mark-and-sweep）。7 日は、上げた直後でまだチェックポイントに入っていない画像を守るため。
- **消すのは東京と大阪の両方のバケット。** S3 のレプリケーションは、バージョンを指定した削除とライフサイクルの動作を大阪へ複製しない（[ADR-0045](../decisions/0045-audit-log-and-data-lifecycle.md)、[security.md](security.md) の 7 節）。mark-and-sweep の削除・取り下げの削除・`exports/` と `thumbnails/` のライフサイクルの規則は、両方のバケットに同じものを置く。大阪が止まっているときは、大阪の分を後から流す。
- ファイルとバージョンの保持の期間は [file-storage-and-history.md](file-storage-and-history.md) と法務（[intent.md](../intent.md) の L4）で決まる。画像はそれに従って消える。
- 権利の侵害の申し立てで画像を消すとき（[intent.md](../intent.md) の L2）は、`images` の行を `taken_down` にし、S3 のオブジェクトを消す。参照するノードは「読み込めない画像」になる。ファイルの中身（`image_hash`）は変えない。

## 7. フォント

ADR-0036。

### 7.1 出どころ

| 出どころ | 中身 | 画面 | サーバーの描画（サムネイル・一括の書き出し・API） | PDF への埋め込み |
| --- | --- | --- | --- | --- |
| 同梱 | ライセンスを確かめたオープンなフォント（SIL OFL・Apache 2.0） | ○ | ○ | ○（サブセット） |
| 組織のフォント | 組織・チームの管理者が上げた .TTF・.OTF | ○（組織のファイルを見る人） | ○（法務の確認待ち。L1） | `fsType` が許すときだけ（7.6 節。法務の確認待ち） |
| 端末のフォント | 利用者の端末にあるフォント | その人の画面だけ | ×（代わりのフォント） | ×（アウトライン化） |

### 7.2 同梱のフォント

- 和文を先に揃える（[intent.md](../intent.md) の「日本の市場を先に狙う」）。候補は Noto Sans JP・Noto Serif JP・BIZ UDPGothic・BIZ UDPMincho・M PLUS 系など、OFL で配られているもの。欧文は Inter と、Google Fonts の OFL・Apache のもの。一覧とバージョンは、開発リポジトリの `fonts/catalog.toml` に持ち、ライセンスの文と出典を並べる。
- 既定のフォントは、UI の言語が日本語なら Noto Sans JP、それ以外は Inter。
- 配信：`fonts/catalog/{sha256}` を CloudFront から配る。同梱のフォントは権限が要らないので、署名なしで、`immutable` のキャッシュにする。
- 和文のフォントは 1 書体で数 MB になる（Noto Sans JP は、日本語のサブセットの OTF の Regular が約 4.5 MB、Google Fonts の可変フォント `NotoSansJP[wght].ttf` が約 9.6 MB。[notofonts/noto-cjk](https://github.com/notofonts/noto-cjk) の `Sans/SubsetOTF/JP`、[google/fonts](https://github.com/google/fonts) の `ofl/notosansjp`、2026-09-27 に確認）。読み込みの時間は E2 の `bundled-font-catalog` で計測する。書体ごとにファイル全体を読み、ブラウザのキャッシュ（Cache Storage）に持つ。文字の範囲ごとに分けて読む方式（Web フォントの `unicode-range` のような分割）は、整形（GSUB・GPOS）がファイル全体を要するため MVP では採らない。読み込みの時間を E10 で計測して見直す。

### 7.3 組織のフォント

- 組織の管理者（組織全体）とチームの管理者（そのチーム）が上げる（本家と同じ）。上げるときに「権利を持つか、ライセンスを受けている」ことの確認を取り、確認した人と日時を記録する。
- 形式は .TTF・.OTF（本家と同じ）。1 ファイル 50 MiB まで。1 組織 2,000 ファイルまで（この設計の値）。
- 取り込みの検査（font-ingest。`asset-inspect` の子プロセス）：
  - OpenType の表を解析できる（Rust の fontations の `read-fonts` を候補にする）。表の長さ・オフセットが範囲の中にある。解析の失敗は `rejected`。
  - 名前（ファミリー・スタイル・PostScript の名前）、太さ、斜体、`OS/2` の `fsType` を読み、`org_fonts` の行に書く。
  - 同じ組織で同じ PostScript の名前のフォントがあれば、新しい方を使い、古い方を置き換えるか確かめる（管理者の操作）。
- 配信：組織のファイルを見られる人に、6.4 節と同じ署名付き URL（期限 15 分）で配る。**ゲスト・リンクを知っている人にも配るか**は法務の確認待ち（L1）。決まるまでの既定は「配る」とし、該当の Story の spec は承認しない（[intent.md](../intent.md) の「法務の確認待ち」）。
- 管理者がフォントを消したら、`org_fonts` の行を `deleted` にし、7 日後に S3 から消す。そのフォントを使うテキストは、代わりのフォント（7.5 節）で描かれる。

### 7.4 端末のフォント

- **MVP：Chromium（Chrome・Edge）で、Local Font Access API（`window.queryLocalFonts()`）を使う。** 利用者の許可を求め、許可されたらフォントの一覧と中身（SFNT のバイト列）をエンジンに渡す（[Local Font Access API](https://developer.mozilla.org/en-US/docs/Web/API/Local_Font_Access_API)、2026-09-27 に確認。対応は一部のブラウザに限られる）。release フラグの裏に置き、L1 が決まってから出す。
- Firefox・Safari では、端末のフォントを使えない（MVP）。本家の ChromeOS・Linux と同じ扱い。
- **MVP の後：補助のアプリ（常駐する小さなプログラム）を検討する。** 本家の形は、`localhost` で待ち受け、本家のドメインからの接続だけを受けるもの（2 節）。これは、他の Web サイトからの接続、DNS の再バインド、他のローカルのプロセスからの接続への守りが要る。作るなら、`Origin` の検査に加え、アプリからの初回の対にした鍵（ペアリング）での認証、署名と公証（macOS）、自動の更新を持たせる。別の ADR で決める。
- **端末のフォントのバイト列はサーバーへ送らない。** 端末のフォントを使ったテキストは、他の人・サーバーの描画では代わりのフォントになる。

### 7.5 フォントがないとき

- ノードは `font_family`・`font_style` の名前でフォントを参照する（[document-model.md](document-model.md) の 9.5 節）。探す順は、組織のフォント → 同梱 → 端末のフォント（自分の画面だけ）。
- 見つからなければ、代わりのフォント（和文を含むなら Noto Sans JP、それ以外は Inter）で描き、エディタに「フォントがありません」を出す（本家の missing font alert と同じ考え方）。行の位置は保存された `derived_layout` を使うので、他の人の画面でレイアウトは崩れない。見つからないフォントのまま、テキストを編集すると、そのクライアントが代わりのフォントでレイアウトを計算し直す。
- Render Worker は、代わりのフォントで描いたとき、ジョブの結果に `substituted_fonts`（ファミリーの名前の一覧）を付ける。画面と API はそれを利用者に見せる。

### 7.6 PDF・SVG のテキスト

| フォント | PDF | SVG（`svg_outline_text = false` のとき） |
| --- | --- | --- |
| 同梱（OFL・Apache） | サブセットを埋め込む。テキストとして選択・検索できる | `<text>` と `font-family`。フォントは埋め込まない（本家の API の説明と同じく、見た目は保証しない） |
| 組織のフォント | `fsType` が 0（インストール可能）・8（編集可能）・4（プレビューと印刷）で、`0x0100`（サブセット不可）・`0x0200`（ビットマップだけ）が立っていなければサブセットを埋め込む。それ以外はアウトライン化する（[OpenType の OS/2 の表](https://learn.microsoft.com/en-us/typography/opentype/spec/os2)、2026-09-27 に確認）。L1 が決まるまでは、すべてアウトライン化する | 同上 |
| 端末のフォント | アウトライン化する | 同上 |

- アウトライン化したテキストは、PDF で選択・検索できない。書き出しのパネルで知らせる。

## 8. サムネイル

- **何を描くか**：ファイルのサムネイルの対象のノード（利用者が選んだフレーム。なければ最初のページの最初の最上位のフレーム。それもなければ最初のページ全体）。対象のノードは、`DOCUMENT` のプロパティ `thumbnail_node`（[document-model.md](document-model.md) の 4.2 節の 91）に持つ。
- **いつ描くか**：チェックポイントを書いた後、前のサムネイルから 5 分以上たち、対象のページが変わっていれば、Document Server が `render-thumbnail` にジョブを入れる。名前付きのバージョンを作ったときは、そのバージョンのサムネイルも描く。
- **大きさ**：長辺 960 px の WebP と、一覧用の長辺 320 px の WebP。
- **置き場所**：`thumbnails/{org_id}/{file_id}/{seq}-{960|320}.webp`。`file_thumbnails` の表に最新の `seq` を持つ。古いものは 7 日後に消す。バージョンのサムネイルはバージョンと同じ期間残す。
- **配信**：ファイルの一覧の API が、閲覧の権限を判定関数で確かめたファイルだけに、署名付き URL（期限 15 分）を付けて返す。権限を外した後、新しい URL は出ない（NFR-010。サムネイルもファイルの中身として扱う）。
- 共有のリンクのプレビュー（OGP の画像）は、「リンクを知っている全員」で共有したファイルにだけ出す。組織の中・招待だけのファイルは、一般の画像を出す（permissions-and-sharing.md と合わせる）。

## 9. 外部の URL からの画像の取り込み（SSRF）

サーバーが外部の URL を取りに行く経路は、次に限る。

| 経路 | 時期 |
| --- | --- |
| 画像の URL を貼り付けたとき、ブラウザが CORS で読めない画像を、サーバーに取りに行かせる | MVP |
| SVG の読み込みで、`<image href="https://...">` の画像 | MVP（ただし既定は取りに行かない。利用者が「外部の画像を取り込む」を選んだときだけ） |
| 公開 API・プラグインからの画像の URL の取り込み | MVP の後 |

- **取得は、VPC に接続しない、権限を持たない Lambda（`asset-fetch`）で行う。** Slack の [ADR-0016](../../../slack/docs/decisions/0016-isolated-link-unfurling.md) の方式と、宛先の検査（スキームは https だけ、名前解決したすべての IP を検査してプライベート・リンクローカル・メタデータ・IPv6 の同等のアドレスを拒否、検査したアドレスへ直接つなぐ、リダイレクトは最大 3 回で毎回検査、自分たちのドメインを取得しない）をそのまま使う。
- 上限：接続 2 秒・全体 10 秒・20 MiB。`Content-Type` が画像で、先頭のバイトが 6.1 節の形式であること。
- Lambda は、取ったバイト列を返すだけ。VPC の中の Worker が、6.2 節の正規化（縮小・メタデータの除去・ハッシュ）をサーバーで行い、6.3 節の検査を通して `images` に入れる。クライアントは、返ってきた `image_hash` を `Paint` に入れる。
- 利用者ごとに 1 分 30 回、組織ごとに 1 分 300 回まで（Valkey で数える）。

## 10. 障害のときの振る舞い

| 障害 | 起きること | 対応 |
| --- | --- | --- |
| 画像の PUT が途中で失敗 | 行が `pending` のまま | クライアントが再送する（ハッシュが同じなので冪等）。24 時間 `pending` の行と S3 の未完了のアップロードは消す |
| 上げた人が PUT の前にタブを閉じた | 他の人の画面で画像が出ない | 10 分後に「読み込めない画像」。上げた人が次にファイルを開いたとき、手元のキャッシュに残っていれば再送する |
| image-ingest の検査の失敗 | `rejected` | 置き場所を「読み込めない画像」にし、上げた人に理由（形式・大きさ・脅威）を知らせる |
| Render Worker の子プロセスがメモリ・時間の上限を超えた | そのノードの書き出しが失敗 | 結果の該当のノードを `null` にする（本家の API と同じ）。同じジョブを 1 回だけ再試行する |
| Render Worker のキューの滞留 | 書き出し・サムネイルが遅れる | `render-export` を優先し、`render-thumbnail` を後回しにする。滞留が 10 分を超えたら警告 |
| ソフトウェアの描画とクライアントの描画の差が許容を超えた | 書き出しの見た目の差 | 参照画像のテスト（13 節）で、出す前に止める。本番では利用者の報告を受け、参照ファイルに加える |
| CDN（CloudFront）の障害 | 画像・フォントが出ない | S3 の署名付き GET の URL に切り替える ops フラグを持つ（キャッシュは効かない） |
| 組織のフォントの検査の失敗 | `rejected` | 管理者に理由を示す |
| 端末のフォントの許可を拒否 | 端末のフォントが出ない | 同梱と組織のフォントだけで続ける |

## 11. セキュリティ

| 脅威 | 守り |
| --- | --- |
| 画像の URL の取り込みでの SSRF | 9 節（VPC の外の権限のない Lambda、宛先の検査） |
| 悪意のある画像（デコーダーの欠陥、展開の爆弾） | メモリ安全な Rust のデコーダー。デコードの前に画素数で確保を見積もる。検査は子プロセスで、メモリと時間の上限付き。クライアントのデコードは Web Worker（rendering-engine.md） |
| 悪意のあるフォント（表の破損、巨大な表） | fontations での解析と範囲の検査。子プロセス。クライアントのエンジンも同じ解析器を使う |
| 悪意のある SVG（読み込み） | 読み込みはクライアントの WASM の解析器（usvg を候補）。`<script>`・`foreignObject`・イベントの属性は無視する。DTD と外部の実体を読まない（実体の展開の爆弾を防ぐ）。外部の参照は既定で取りに行かない（9 節）。結果は `doc-model` の検証を通る（[document-model.md](document-model.md) の 4.4 節） |
| 書き出した SVG・PDF が、開いた人の環境で動く | 4.3 節（スクリプト・動作の注釈を書かない、名前のエスケープ）。書き出しの結果は `Content-Disposition: attachment` で配る |
| 利用者が上げたバイト列がアプリのオリジンで動く | 別のドメイン（`<brand>usercontent`）、`nosniff`、`CSP: sandbox` |
| 組織をまたぐ画像の漏れ | 重複の除去を組織の中に限る（6.2 節）。署名はファイルを持つ組織の表だけを引く（6.4 節） |
| 権限のない人へのサムネイル・画像・書き出しの漏れ | 署名付き URL を、判定関数を通した後にだけ出す。期限は 15 分（書き出しの結果は 24 時間） |
| 書き出しの結果の URL の漏れ | 結果の保持 14 日、URL 24 時間（4.4 節） |
| 端末のフォントの補助のアプリの悪用 | MVP では作らない（7.4 節） |
| ログへの中身の漏れ | 画像のハッシュ・フォントの名前・レイヤー名をログに書かない。ID と大きさだけ（本題材の AGENTS.md） |

## 12. 観測

- 書き出し：経路（クライアント・サーバー）と形式ごとの件数、所要時間、失敗率、縮めた件数、`null` の件数。
- Render Worker：キューの滞留と待ち時間（`render-export`・`render-thumbnail`）、子プロセスの所要時間・最大のメモリ・上限超えの件数、代わりのフォントを使った件数。
- 画像：アップロードの件数と大きさ、重複で上げずに済んだ割合、`pending` から `ready` までの時間、`rejected` の理由ごとの件数、署名の API の遅延、CloudFront のキャッシュのヒット率。
- フォント：同梱のフォントの読み込みの時間（書体ごと）、代わりのフォントの表示の件数、組織のフォントの `rejected` の件数。
- 外部の取得：`asset-fetch` の件数、宛先の検査での拒否の件数（SSRF の試み）。

## 13. テスト

- 参照画像のテスト（SC-6）：参照ファイルの集合を、WebGL2・WebGPU・Render Worker（ソフトウェアの描画）で PNG に書き出し、参照画像との差（画素の差の割合と最大の差）が許容に収まる。許容の値は quality.md で決める。
- SVG・PDF の往復：参照ファイルを SVG で書き出し、同じ SVG の読み込みで取り込んで描いた画像が、元と許容の差に収まる（SVG で表せる要素だけ）。PDF は、書き出した PDF を PDF の描画の道具（pdfium など）で画像にして比べる。
- 表駆動のテスト：4.1 節の設定のすべての組み合わせの境界（`Scale` 0.01・4、32 メガピクセルちょうどと超え）、7.6 節の `fsType` の値ごとの扱い。
- 性質ベーステスト：
  - **PROP-EA-001**：任意の画像のバイト列で、クライアントの正規化 → ハッシュ → サーバーの検査のハッシュが一致する（冪等）。同じバイト列の 2 回目の登録は、PUT を求めない。
  - **PROP-EA-002**：任意の 2 組織で、一方の組織の文脈の署名の API に他方の画像のハッシュを渡しても、URL が返らない。
  - **PROP-EA-003**：任意のファイルとバージョンの集合で、6.5 節の削除の後、残したチェックポイントが参照する画像がすべて残る。
  - **PROP-EA-004**：任意のレイヤー名（制御文字、`<`・`"`・`]]>` を含む）で、書き出した SVG が正しい XML で、スクリプトの要素・イベントの属性を含まない。
- fuzzing：`asset-inspect` の画像とフォントの解析（任意のバイト列で落ちない、上限を超える確保をしない）、SVG の読み込みの解析器。
- SSRF：Slack の ADR-0016 の Confirmation と同じ宛先の一覧で、`asset-fetch` が取得しない。
- 権限の結合テスト：権限を外した直後の利用者が、サムネイル・画像・書き出しの新しい URL を得られない。ゲストが、共有されていないファイルの画像の URL を得られない。
- 障害注入：Render Worker の子プロセスを途中で殺し、ジョブが 1 回だけ再試行され、該当のノードが `null` になる。

## 14. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり（E1 基盤とビルド … E10 書き出しとアセット … E12 運用と GA の準備）。

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `assets-bucket-and-cdn` | assets バケット、`<brand>usercontent` のドメイン、CloudFront の署名の鍵、応答のヘッダーの固定 |
| E2 | `image-paint-by-hash` | `Paint` の `image_hash` での描画と、読み込み中・読み込めない画像の置き場所（描画の側は rendering-engine） |
| E2 | `bundled-font-catalog` | 同梱のフォントの一覧、CDN での配信、Cache Storage、既定のフォント |
| E4 | `image-upload-client` | 読み込み・縮小・メタデータの除去・ハッシュ・署名付き PUT（6.2 節） |
| E4 | `svg-import-sanitize` | SVG の読み込みの解析と無視する要素（11 節。UI は editor-and-tools） |
| E10 | `image-ingest-worker` | `asset-inspect`（画像）、GuardDuty、縮小版、`ready` の通知 |
| E10 | `image-sign-endpoint` | `images:sign`、組織の中だけの引き当て、キャッシュの PoC |
| E10 | `export-settings-panel` | `export_settings` の編集と、書き出しのパネル |
| E10 | `client-export-raster` | PNG・JPG のクライアントの書き出し（タイルでの大きな画像を含む） |
| E10 | `client-export-svg` | SVG の書き出しと 4.3 節の規則 |
| E10 | `client-export-pdf` | PDF の書き出し、同梱のフォントのサブセットの埋め込み、アウトライン化 |
| E10 | `render-worker-core` | Render Worker、子プロセス、チェックポイント＋ジャーナルの読み込み、ソフトウェアの描画の PoC |
| E10 | `server-bulk-export` | 一括の書き出しのジョブ、ZIP、結果の保持と URL |
| E10 | `file-thumbnails` | サムネイルのジョブ、`thumbnail_node`、一覧の API での配信 |
| E10 | `org-fonts` | 組織・チームのフォントのアップロード、`asset-inspect`（フォント）、配信（L1 の確認待ち） |
| E10 | `local-fonts-chromium` | Local Font Access API（release フラグ。L1 の確認待ち） |
| E10 | `asset-fetch-egress` | `asset-fetch` の Lambda、画像の URL の取り込み |
| E10 | `render-parity-suite` | 参照画像のテストの集合と CI（SC-6） |
| E7 | `image-gc` | 6.5 節の mark-and-sweep（東京と大阪の両方。保持の期間は file-storage-and-history と L4） |
| E12 | `asset-takedown` | 権利の侵害の申し立てでの画像・フォントの削除の手順（L2） |
| 延期 | `font-helper-app` | 端末のフォントの補助のアプリ（別の ADR。roadmap.md の延期の一覧） |

## 15. 未解決の問い

### 決定（2026-09-27、既定案）

- **画面からの書き出しはクライアントで描く**（4.2 節、ADR-0034）。本家がどちらで描くかは **未検証** だが、端末のフォントを使えることと、サーバーの費用で決めた。
- **重複の除去の範囲は組織の中**（6.2 節、ADR-0035）。組織をまたぐ除去で減る容量より、存在の当て推量の危険を重く見た。
- **メタデータの除去はクライアントで、再符号化せずに行う**（6.2 節）。サーバーで除くとバイト列が変わり、クライアントのハッシュと合わなくなるため。
- **サーバーの書き出しの結果の保持は 14 日、URL は 24 時間**（4.4 節）。本家の API（30 日）より短い。
- **端末のフォントは、MVP では Chromium の Local Font Access API だけ**（7.4 節、ADR-0036）。補助のアプリは MVP の後に別の ADR で決める。
- **組織のフォントの PDF への埋め込みは、L1 が決まるまでアウトライン化**（7.6 節）。
- **Render Worker は Fargate の CPU で、lavapipe の上の wgpu**（5.1 節）。性能は E10 の `render-worker-core` の PoC で確かめる。
- **1 組織の画像の容量**：MVP では上限を置かない。組織ごとの合計を計測し、料金の設計（MVP の後）で見直す（6.1 節。推奨案で確定）。
- **CDN の署名とキャッシュ**：署名はキャッシュの鍵に含めない。キャッシュのオブジェクトは中身のハッシュで名付け、パスに組織かファイルを含める（6.4 節。統合の工程で permissions-and-sharing と揃えた）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 組織のフォントを、ゲスト・リンクを知っている人に配るか。サーバーの描画・PDF への埋め込みに使ってよいか | 法務（L1）。決まるまで該当の Story の spec を承認しない |
| 同梱の和文のフォントの読み込みの時間とメモリ（NFR-003・004） | E2 の `bundled-font-catalog` で計測。遅ければ文字の範囲ごとの分割を別の ADR で検討する |
| キャッシュに当たった要求でも、CloudFront が署名と期限を毎回確かめること（署名はキャッシュの鍵に含めないと統合の工程で決めた。6.4 節） | 資料で確かめた（6.4 節）。`image-sign-endpoint` の結合テストで、実際の配信でも確かめる |
| ソフトウェアの描画の性能（10 万ノードのサムネイル p95 10 秒） | E10 の `render-worker-core` の PoC。足りなければ GPU のインスタンスの ADR |
| JPG の品質の値（本家の Low・Medium・High の中身） | 本家の値は確かめられない。この設計の値のまま、利用者の声で見直す |
| 補助のアプリを作るか | MVP の後。Firefox・Safari の利用者の声で決める |

## 16. quality.md・runbooks・data-model への項目

### quality.md

- 参照画像のテスト（SC-6）の許容の値と、参照ファイルの集合（和文のテキスト、エフェクト、ブレンドモード、マスク、画像、大きなフレーム）。
- 書き出しの失敗率（目標 0.1% 未満）と、Render Worker の `render-export` の待ち時間 p95（目標 5 秒以内）。
- サムネイルの遅れ（チェックポイントから p95 2 分以内）。
- 画像の `pending` から `ready` まで p95 10 秒以内。
- 権限の漏れのテスト（13 節の権限の結合テスト、PROP-EA-002）を、NFR-010 のリリースの基準に入れる。
- fuzzing（`asset-inspect`・SVG の解析器）の実行時間と、見つかった落ちの数。

### runbooks

- `render-worker-backlog.md`：キューの滞留のとき、`render-thumbnail` を止めて `render-export` にタスクを回す手順、タスクの数の増やし方。
- `asset-takedown.md`：権利の侵害の申し立て（L2）で、画像・フォントを `taken_down` にし、S3 から消し、記録を残す手順。
- `cdn-fallback.md`：CloudFront の障害で、S3 の署名付き GET に切り替える ops フラグの手順と、戻す手順。
- `image-rejected-spike.md`：`rejected` の急増（クライアントの不具合か、攻撃か）の切り分け。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `images` | `org_id`、`sha256`、`byte_size`、`mime`、`width`、`height`、`status`（`pending`・`ready`・`rejected`・`taken_down`）、`reject_reason`、`uploaded_by`、`created_at`、`ready_at`。主キー `(org_id, sha256)`。RLS |
| Aurora `org_fonts` | `org_id`、`id`、`scope`（`org`・`team`）、`team_id`、`family`、`style`、`weight`、`italic`、`postscript_name`、`fs_type`、`sha256`、`byte_size`、`status`、`license_confirmed_by`、`license_confirmed_at`、`uploaded_by`、`created_at`、`deleted_at`。一意 `(org_id, scope, team_id, postscript_name)`（`deleted_at IS NULL`）。RLS |
| Aurora `export_jobs` | `org_id`、`id`、`file_id`、`seq`、`requested_by`、`source`（`ui`・`api`）、`params`、`status`、`result_keys`、`substituted_fonts`、`created_at`、`finished_at`、`expires_at`。RLS |
| Aurora `file_thumbnails` | `org_id`、`file_id`、`seq`、`kind`（`current`・`version`）、`version_id`、`s3_key_960`、`s3_key_320`、`rendered_at`。RLS |
| S3 `images/{org_id}/{sha256}` と `.../w{2048,512,128}.webp` | 画像の本体と縮小版 |
| S3 `fonts/catalog/{sha256}`、`fonts/{org_id}/{sha256}` | 同梱のフォント、組織のフォント |
| S3 `exports/{org_id}/{job_id}/…` | サーバーの書き出しの結果（14 日） |
| S3 `thumbnails/{org_id}/{file_id}/{seq}-{960,320}.webp` | サムネイル |
| SQS `image-ingest`、`font-ingest`、`render-export`、`render-thumbnail` | 取り込みと描画のジョブ |
| document-model のプロパティ | `DOCUMENT` のプロパティ `thumbnail_node: Option<NodeId>`（91。scalar。持ち主は export-and-assets）。統合の工程で登録した |

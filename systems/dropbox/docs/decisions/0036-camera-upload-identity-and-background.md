---
status: accepted
date: 2026-10-09
---

# ADR-0036: カメラのアップロードは、端末の中は（端末, OS の写真の ID, 変更の印）で、アカウントの中は `content_sha256` で重ねない。元の形式（編集した写真は今の見た目の全体の大きさの資源）をそのまま上げる。前景では直接、背景では iOS は背景の URLSession と BGProcessingTask、Android は WorkManager と `dataSync` の前景のサービスで送り、署名つき URL の期限切れは起こされたときに取り直す。既定は写真はモバイルの回線でも上げ、動画は Wi-Fi だけ、電池が 20% 未満で充電していなければ止める

## Context

[architecture/README.md](../architecture/README.md) の 6 節は、カメラのアップロードを「写真のライブラリの新しい項目を、OS の写真の ID と内容のハッシュで重ねずに上げる。元の形式（HEIC など）のまま上げ、変換はプレビューだけで行う」と決めた。NFR-012 は、OS がアプリに時間を与えてから p95 5 分で確定することを求める。

決めることは次である。

- 重複の判定の鍵。OS の写真の ID は端末ごとで、再インストール・機種の変更で変わる。同じ写真が複数の端末にある（iCloud の写真の共有など）。
- 編集した写真、Live Photo の扱い。
- iOS・Android の背景の制約の中での送り方。背景の URLSession は OS が後でタスクを始めることがあり、署名つき URL は 15 分で切れる（[ADR-0007](0007-block-storage-layout-on-s3.md)）。
- 回線と電池の既定。本家は、既定でモバイルの回線でも上げ、電池が少ないと止める（[Camera uploads overview](https://help.dropbox.com/create-upload/camera-uploads-overview)、2026-10-09 に確認）。

## Options

重複の判定：

1. **端末の中は（端末, OS の写真の ID, 変更の印）、アカウントの中は `content_sha256`**
2. OS の写真の ID だけ
3. `content_sha256` だけ

背景の送り方：

- a. **iOS は背景の URLSession と BGProcessingTask、Android は WorkManager と前景のサービス。URL は起こされたときに取り直す**
- b. 前景のときだけ送る
- c. モバイルの背景の送信の URL の期限を長くする

## Decision

1 と a を採用する。詳細は [mobile-and-camera-upload.md](../architecture/mobile-and-camera-upload.md) の 5〜9 節。

- 端末の `camera_assets` で（端末, OS の写真の ID, 変更の印）が `done` なら上げない。編集で変更の印が変われば、同じノードの新しいリビジョンとして `base_rev` の条件つきで上げる。
- サーバーの `camera_upload_index(tenant_id, ns_id, account_id, content_sha256)` を一意にし、同じ中身を既に上げていれば `done`（重複）にする。本人が上げたものだけを引くので漏れない。利用者がサーバーで消しても行は 1 年残し、蘇らせない。
- 元の形式で上げる。編集した写真は今の見た目の全体の大きさの資源。Live Photo の対の動画は既定でオフ。HEIC を JPEG に変換して保存しない。
- 置き場所は利用者のルート（チームのメンバーは本人のフォルダー）の `カメラアップロード` で、フォルダーは ID で持つ。名前は撮影の日時の `YYYY-MM-DD HH.MM.SS.<ext>`、作成の条件で衝突を避ける。
- 背景：iOS は BGProcessingTask で分割とブロックの書き出し、背景の URLSession で送り、起こされたときに検証の待ち・commit・URL の取り直しを行う。1 回に作るタスクは 16 ブロックまで。Android は WorkManager、100 MB を超えるものは `dataSync` の前景のサービス。
- 既定の方針：写真はモバイルの回線でも上げる、動画は Wi-Fi だけ、OS の省データ・ローミングでは上げない、電池 20% 未満で充電していない・省電力・熱の状態が重いときは止める。チームの管理者は無効にできる。
- 状態は意図の記録として遷移の前に書き、アプリの終了・再起動から続ける。

### 他の案を選ばなかった理由

- **2（OS の ID だけ）**：再インストールと機種の変更で、すべての写真を上げ直す。
- **3（`content_sha256` だけ）**：判定のたびに資源を書き出してハッシュを取る。大きな動画のライブラリで、電池と時間を使う。編集を新しいリビジョンとして結べない。
- **b（前景だけ）**：アプリを開かない利用者の写真が上がらない。本家の振る舞い（背景で上げる）とも違う。
- **c（URL の期限を長くする）**：漏れた URL の使える時間が延びる。まず取り直しで足りるかを `mobile-background-upload-poc` で測る。足りなければ別の ADR で ADR-0007 の値を変える。

## Consequences

- 良くなること：
  - 再インストール、機種の変更、複数の端末でも重ならない。
  - 利用者が消した写真を蘇らせない。
  - 元の形式で残り、変換の劣化がない。
- 引き受けるコスト：
  - 背景の送信は OS の判断に左右され、NFR-012 は「時間を与えられてから」でしか約束できない。
  - URL の取り直しで、背景の送信の往復が増える。
  - HEIC を表示できない端末・アプリへは、プレビューか元の HEIC を渡すことになる。

## Confirmation

- 性質ベーステスト：PROP-CAM-001（重複 0・漏れ 0）、PROP-CAM-002（意図して消したものを蘇らせない）。
- 決定表：DT-CAM-001（方針）。
- 実機の試験：`mobile-background-upload-poc` で、背景の仕組みと URL の期限切れの頻度を測る。

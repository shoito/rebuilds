---
status: accepted
date: 2026-10-09
---

# ADR-0054: フォルダーの ZIP と「1 つの URL で大きなファイルを取る」ダウンロードは、Worker の `export-builder` が S3 のブロックを読んで S3 の `exports` に組み立て、署名つき URL で `<brand>usercontent.<domain>` から返す。API・Link は中身を通さない。上限は 10,000 ファイル・20 GiB

## Context

- [ADR-0001](0001-platform-and-stack.md) と [ADR-0038](0038-public-api-shape-and-change-feeds.md) は、ブロックの中身をサーバーの ECS に通さないと決めた。ダウンロードは `download_plan` のブロックの URL を受け、利用者が組み立てる。
- ところが、次の 2 つは組み立てを利用者に任せられない。
  - Web の画面と共有リンクの「フォルダーをまとめてダウンロード」（E7 の `web-download`、[shared-links.md](../architecture/shared-links.md) の 5.2 節）。ブラウザは 1 つのファイルとして保存したい。
  - ブラウザや単純な HTTP の道具で、複数のブロックからなるファイルを 1 つの URL で取る（[api-and-webhooks.md](../architecture/api-and-webhooks.md) の持ち越し）。
- ブロックは内容で区切った 1〜16 MiB（[ADR-0002](0002-chunking-and-block-addressing.md)）で、S3 の UploadPartCopy は最後を除く部品を 5 MiB 以上にする必要があるため、S3 の中だけで連結できない。
- 本家はブラウザからフォルダーを ZIP で取れる。上限の値は、公式の資料で確かめられなかった（コミュニティの回答に 20 GB・10,000 ファイルと 250 GB・10,000 ファイルの 2 つの記述がある。**未検証**）。

## Options

1. **Worker（`export-builder`）が S3 のブロックを読み、S3 の `exports` に組み立てて、署名つき URL で返す**
2. ブラウザの中で組み立てる（Service Worker とストリームで ZIP を作る）
3. API が要求のたびに中身を中継して流す
4. 持たない（デスクトップのクライアントか SDK を使わせる）

## Decision

1 を採用する。

- **入口**：`files/export`（API）と、共有リンクのフォルダーのダウンロード（Link）。どちらも `can()` で読めるノードだけを対象にし、共有リンクはダウンロードの禁止・`scan_state`・帯域の上限（[ADR-0028](0028-shared-link-abuse-controls.md)）を確かめる。1 ブロックのファイルは組み立てず、ブロックの URL をそのまま返す。
- **目録**：API・Link が、確かめた後の対象（リビジョン、ブロックの番地、ZIP の中の相対の名前）を目録にして `exports` の `x/<tenant_id>/<export_id>/manifest` に置き、SQS の `export-jobs` には `export_id` だけを入れる。名前をキューとログに出さない。
- **組み立て**：`export-builder`（private のサブネットの Worker）が、ブロックを S3 から読み、ZIP（無圧縮の格納、ZIP64）か 1 つのファイルとして、S3 のマルチパートのアップロード（64 MiB の部品）で `x/<tenant_id>/<export_id>/data` に書く。中身を解釈しない（変換・展開をしない）。各ブロックの SHA-256 を確かめ、合わなければ失敗にする。
- **権限**：`export-builder` のロールは `blocks`・`blocklists` の `GetObject`、`exports` の `PutObject`、`kms-blocks` の復号と暗号化だけ。DB には書かず、結果は `export-results` のキューで API へ返す。
- **配信**：できたら、API・Link が `content.<brand>usercontent.<domain>/x/...` の CloudFront の署名つき URL（1 時間、共有リンクは 15 分、`Content-Disposition: attachment`）を返す。要求ごとに作り、他の要求と使い回さない。`exports` は 1 日で消し、大阪へ写さない。
- **上限**：1 回 10,000 ファイル・合計 20 GiB（本システムの値）。超えたら 400 `export_too_large` で、デスクトップのクライアントか SDK を案内する。1 アカウントの同時の組み立ては 3 つ。
- **監査**：ダウンロードとして活動の事象に残す（[ADR-0045](0045-audit-log-and-data-lifecycle.md)）。
- ADR-0001・ADR-0038 の「中身はサーバーを通さない」は、「要求を受けるサービス（API・Link・Notify・Auth）は中身を通さない。中身を読むのは、決めた Worker（`block-verifier` の写し、`export-builder`、隔離した変換）だけ」と読む。

### 他の案を選ばなかった理由

- **2（ブラウザで組み立て）**：中身はサーバーを通らないが、ストリームでの保存はブラウザによって使えず、単純な HTTP の道具では使えない。フォルダーの ZIP の需要を満たせない。
- **3（API が中継）**：要求を受けるサービスに中身が流れ、台数と時間切れの扱いが増える。API の可用性が大きなダウンロードに引きずられる。
- **4（持たない）**：Web の画面と共有リンクで、フォルダーをまとめて渡す主な使い方を覆えない。

## Consequences

- 良くなること：
  - Web の画面と共有リンクでフォルダーを 1 つのファイルで取れる。単純な HTTP の道具でも大きなファイルを 1 つの URL で取れる。
  - 要求を受けるサービスは中身を通さないまま。
- 引き受けるコスト：
  - 組み立ての間（20 GiB で数分）、利用者は待つ。S3 の読み出しと書き込みの要求と、1 日分の一時の保存の費用がかかる。
  - 中身を読む Worker が 1 つ増える。中身を機械で読むことに当たるかは法務の L1 の論点に含める（変換も展開もしない）。
  - 組み立てた写しは、権限の取り消しの後も、出した URL の期限（最長 1 時間）まで使える。

## Confirmation

- 性質ベーステスト：任意の木と権限の変更で、目録に読めないノードが入らない。組み立てた ZIP を展開すると、目録の各ファイルの `content_sha256` と一致する。
- IaC の検査：`export-builder` のロールが決めた S3 の操作と鍵の外に広がらない。`exports` のライフサイクルが 1 日。
- 結合テスト：ダウンロードの禁止のリンクで `files/export` が拒まれる。上限を超える要求が 400。キューとログに名前が出ない。

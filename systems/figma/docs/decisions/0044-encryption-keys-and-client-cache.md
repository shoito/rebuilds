---
status: accepted
date: 2026-09-27
---

# ADR-0044: 保存時の暗号化はデータの種類ごとの KMS の鍵（マルチリージョン）で行い、組織ごとの鍵は MVP で持たない。端末のキャッシュは暗号化せず、組織の方針で止められるようにする

## Context

ファイルの中身は、Aurora ではなく、DynamoDB のジャーナル、S3 のチェックポイントとチャンク、Document Server のメモリ、ブラウザの IndexedDB に置く（[ADR-0003](0003-journal-and-checkpoints.md)、[ADR-0025](0025-content-addressed-checkpoints-and-loading.md)）。file-storage-and-history.md は、組織ごとの鍵と、共有の端末でのキャッシュの扱いを、この領域に任せた（同文書の 13・16 節）。

- 保存の場所が多い。鍵を 1 つにすると、1 つの鍵の権限が全部の中身に届く。
- 大阪へ複製する（DynamoDB のグローバルテーブル、S3 のクロスリージョンのレプリケーション、Aurora の Global Database）。大阪でも同じ鍵で復号できる必要がある。
- 能力のチケット（Ed25519）の署名の鍵を、API が持つ（[ADR-0030](0030-single-policy-engine-and-signed-capabilities.md)）。
- ブラウザの IndexedDB に、チャンク（ファイルの中身）が残る（500 MB まで。ログアウトで消す）。

rebuilds の Slack は、保存時の暗号化を KMS のカスタマー管理キーで行い、秘密情報を Secrets Manager で入れ替えると決めた（[Slack の ADR-0017](../../../slack/docs/decisions/0017-encryption-and-key-management.md)）。

## Options

鍵：

1. **データの種類ごとの KMS のカスタマー管理キー（マルチリージョンキー）。組織ごとの鍵は持たない**
2. **組織ごとの KMS の鍵（データキーを組織ごとに分ける）**
3. **AWS 管理のキーだけ**

端末のキャッシュ：

- a. **暗号化しない。ログアウトと権限の喪失で消し、組織の方針でキャッシュを止められる**
- b. **WebCrypto の鍵で暗号化する（鍵は IndexedDB に置く、またはサーバーから受け取る）**

## Decision

1 と a を採用する。詳細は [security.md](../architecture/security.md) の 5 節。

- **鍵の分け方**：`journal`（DynamoDB のジャーナルと Router の表）、`files`（S3 のチェックポイント・チャンク・大きな変更）、`assets`（画像・フォント・書き出し・サムネイル）、`metadata`（Aurora）、`logs`（CloudWatch Logs と監査のアーカイブ）、`secrets`（Secrets Manager）。どれも東京で作り、大阪にレプリカを置くマルチリージョンキーにする。
- 鍵のポリシーで、使える役割を分ける。Document Server は `journal` と `files` だけ、Render Worker は `files` の復号と `assets` だけ、API は `metadata` と `assets` の一部。人は、break-glass の役割でしか復号できない。
- S3 は SSE-KMS とバケットキー、DynamoDB はカスタマー管理キー、Aurora はストレージの暗号化。鍵の自動の入れ替え（年 1 回）を有効にする。
- **能力のチケットの署名の鍵**は、Secrets Manager に置き、API のプロセスに読み込んで署名する（ファイルを開くたびに KMS を呼ばない）。90 日ごとに入れ替え、`kid` で新旧を 24 時間並べる。公開鍵は Gateway と Document Server に配る。
- **組織ごとの鍵は、MVP で持たない。** 企業の要望（自分の鍵を持ち込む）が出たら、S2 の前に別の ADR で扱う。ジャーナルとチェックポイントは組織をまたいで同じ表・バケットにあるので、組織ごとの鍵にするには、データキーの階層（組織ごとのデータキーで本体を暗号化する）を足す必要がある。
- **端末のキャッシュ**：暗号化しない。鍵を同じ端末の中に置く限り、端末を持つ人から守れないため。代わりに次を持つ。
  - ログアウト、セッションの失効を知ったとき、権限の喪失を知ったときに消す（[file-storage-and-history.md](../architecture/file-storage-and-history.md) の 6.3 節）。
  - 組織の方針 `client_cache = allowed | session_only | disabled`（MVP の後、E12）。`session_only` はタブを閉じると消す、`disabled` は IndexedDB に書かない。ファイルを持つ組織の方針に従う。
- 2 を採らない理由：MVP では費用（組織の数だけの鍵と KMS の呼び出し）と、大阪の複製・掃除・複製の手順の複雑さに見合わない。
- 3 を採らない理由：鍵のポリシーで役割を分けられず、監査もしにくい。
- b を採らない理由：鍵が同じ端末にあれば守りにならない。サーバーから鍵を受け取る形は、オフラインで開けなくなり、キャッシュの目的（2 回目に速く開く）を損なう。

## Consequences

- 良くなること：
  - 1 つの役割が漏れても、届く中身がデータの種類で限られる。
  - 大阪で、同じ鍵のレプリカで復号できる。
- 引き受けるコスト：
  - 共有の端末では、ログアウトしないとファイルの中身が残る。画面と文書で知らせる。
  - 組織ごとの鍵を後から入れるには、データキーの階層の移行が要る。

## Confirmation

- IAM Access Analyzer と鍵のポリシーの lint：Document Server の役割が `assets` と `metadata` の鍵を使えない、など。
- DR の訓練：大阪で、ジャーナル・チェックポイント・Aurora を、レプリカの鍵で読める。
- 結合テスト：ログアウトの後、IndexedDB の `chunks` が空になる。

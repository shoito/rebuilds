---
status: accepted
date: 2026-09-26
---

# ADR-0009: LFS の objects は、ネットワークごとの S3 のキーに置き、presigned URL で直接転送する

詳細は [git-protocols.md](../architecture/git-protocols.md) の 7 節。

## Context

Git LFS は、大きなファイルを Git の外に置き、Git には pointer だけを入れる。クライアントは batch API で転送先を聞き、指示された URL に直接 GET・PUT する（[LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)）。

決めることは次のとおり。

- どこに置くか。ストレージのノード（ADR-0003 の 3 つの複製）か、S3 か。
- どの範囲で重複を除くか（リポジトリ、ネットワーク、全体）。
- 転送をフロントエンドを通すか、直接にするか。
- いつ消すか。

## Options

1. **S3 に、ネットワークごとのキー（`lfs/<network_id>/<oid>`）で置く。batch API は presigned URL を返し、転送は S3 と直接行う**
2. **S3 に、全体で oid ごとに 1 つだけ置く**（全体の重複排除）
3. **ストレージのノードに、Git の objects と同じく 3 つの複製で置く**

## Decision

1 を採用する。

- batch API は Git フロントエンドが受け、認証・認可を行う（ADR-0002、ADR-0004）。`download` は GET、`upload` は PUT の presigned URL を返す。PUT の署名に SHA-256 のチェックサムを含め、S3 が中身を oid と照らす（クライアントがヘッダーを付けるかは未検証。E3 の PoC で確かめる）。`verify` で、フロントエンドが S3 の object を確かめて登録する。
- キーをネットワークごとにし、fork の間で共有する。ネットワークをまたいで共有しない。
- push の受け付けで、pointer が指す objects が S3 にあることを確かめる（本家も push の前段のフックで確かめる）。
- 使われなくなった LFS の objects を、履歴の走査で消すことはしない。本家と同じく、消すにはリポジトリを削除する（[Removing files from Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/removing-files-from-git-large-file-storage)）。ネットワークが空になったら、復元の期間の後に消す。
- 暗号化は SSE-KMS、別のリージョンへ複製する。
- 2 を採らない理由：oid を知っているだけで、別のネットワーク（非公開のリポジトリを含む）の中身を「すでにある」と判定できてしまい、存在の有無が漏れる。削除の判定も全体の参照の数え上げになる。
- 3 を採らない理由：大きなバイナリでノードのローカルのディスクを埋め、3 倍の容量を使う。S3 のほうが耐久性と単価で有利。

## Consequences

- 良くなること：
  - 大きなファイルの転送が、フロントエンドとストレージのノードを通らない。
  - 耐久性は S3 に任せられる。
- 引き受けるコスト：
  - fork のネットワークの分割のとき、LFS の objects もコピーが要る。
  - 利用者が LFS の objects だけを消す手段がない（リポジトリの削除か、運用への依頼）。
  - presigned URL は、有効期限の間は URL を知る誰でも使える。期限を短く（1 時間）し、ログに残さない。

## Confirmation

- 結合テスト：権限のない利用者の batch API の要求が、404（非公開）または 403 になる。別のネットワークの oid を指定しても、`upload` の省略（「すでにある」の応答）が起きない。
- 結合テスト：S3 にない oid の pointer を含む push が拒否される。
- 結合テスト：oid と中身が違う PUT が失敗する（PoC の結果で決める）。
- レビュー観点：presigned URL をログ・Webhook・監査ログに出していないこと。

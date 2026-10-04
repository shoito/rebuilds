---
status: accepted
date: 2026-09-28
---

# ADR-0022: コメントの本文は ProseMirror の JSON を LWW で持つ。インラインのコメントは Yjs の相対位置の組をコメントの行に持つ。メンションは ID で持ち、本文のメンションは Worker が抜き出す。添付は署名付きの URL で S3 へ直接上げ、別のドメインから配る

## Context

本文の CRDT は [ADR-0021](0021-description-crdt-yjs-in-sync-log.md) で決めた。残るのは、コメント、インラインのコメント、メンション、添付である。本家の公式の文書は次のように書いている（いずれも 2026-09-28 に確認）。

- コメントを直せるのは作った人だけ（[Edit issues](https://linear.app/docs/editing-issues)）。スレッド、解決、リアクションがある。本文の範囲を選んでコメントを付けられる（[Comments and reactions](https://linear.app/docs/comment-on-issues)）。
- 利用者のメンションは、その人に通知し、イシューを購読させる（[Editor](https://linear.app/docs/editor)）。
- API の上げは、署名付きの URL へ `PUT` する（[How to upload a file to Linear](https://linear.app/developers/how-to-upload-a-file-to-linear)）。

[ADR-0002](0002-sync-model.md) の競合の表は、「本文」の行に「コメントの本文」を含め、CRDT にするとした。y-prosemirror の文書は、同時編集では添字の位置が正しく動かないので、コメントなどは相対位置で作るよう勧めている（[y-prosemirror](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror)）。Yjs の相対位置は、要素に固定され、他の人の変更で動かない（[Y.RelativePosition](https://docs.yjs.dev/api/relative-positions)）。

## Options

コメントの本文：

1. **ProseMirror の JSON を `lww` で持つ（作った人だけが書く）**
2. ADR-0002 のとおり、コメントごとに Yjs の文書を持つ

インラインのコメントの印：

- a. **本文に書かず、コメントの行に Yjs の相対位置の組（と引用の文字）を持つ**
- b. 本文の CRDT の中に、コメントの ID を持つ装飾（mark）を書く

本文のメンションの通知：

- x. **Worker がまとめの時にメンションの集合を比べ、増えた人について Writer のシステムのトランザクションで購読を足し、通知の事象を出す**
- y. クライアントがメンションの追加を別の操作としてトランザクションに入れる

添付：

- p. **クライアントが署名付きの URL で S3 へ直接上げ、`upload_ref` で行を作る。配りは別のドメインの短い期限の署名付きの URL**
- q. 本体の API のサーバーが受けて S3 へ流す

## Decision

1・a・x・p を採用する。詳細は [editor-and-descriptions.md](../architecture/editor-and-descriptions.md) の 5〜8 節。

- **コメント**：`body` は `RichTextDoc` の JSON Schema に合う ProseMirror の JSON、64 KiB まで、`lww`。スレッドは 1 段。解決は最初のコメントの `resolved_at`。これは ADR-0002 の競合の表の「コメントの本文」を CRDT から LWW に変える。イシューとプロジェクトの説明は CRDT のまま。
- **インラインのコメント**：`Comment.anchor = {doc, start, end, quote}`。`start` は範囲の最初の文字の後ろ側（`assoc` 0）、`end` は最後の文字の前側（`assoc` −1）。作成の時だけ書く。強調は装飾として描き、本文を変えない。範囲がすべて消えたら「外れた」として一覧に `quote` と出す。
- **メンション**：ノード `{kind, id}` で持ち、表示の文字を持たない。コメントのメンションは派生（[ADR-0025](0025-derived-changes-in-writer.md)）で購読と通知の事象を出す。本文のメンションは Worker のまとめで抜き出し、サーバーだけの `doc_mentions` と比べる。どちらも `can()` で見てよい人に絞る。
- **添付**：`POST /files/uploads` で `can()` と大きさ・種類を確かめ、15 分の `PUT` の URL（大きさ・種類・SHA-256 を署名に含める）と 24 時間の `upload_ref`（HMAC）を返す。Writer は `upload_ref` を確かめて `pending` で作り、Worker が S3 の HEAD で確かめて `ready` か `failed` にする。配りは `/files/<id>` で `can()` を確かめ、`<brand>usercontent.<domain>` の 5 分の署名付きの URL へ転送する。`nosniff`、`CSP: sandbox`、画像・PDF・動画以外は `attachment`。1 ファイル 100 MiB（本システムの値）。
- 2 を採らない理由：書くのは作った人だけで、同時の編集は同じ人の 2 台の端末の場合に限られる。コメントは数が多く、1 件ごとに Yjs の状態、まとめ、`_doc_state` を持つ費用に見合わない。LWW なら行の全体が差分で届き、遅延の読み込みの規則（`_u`）がそのまま使える。
- b を採らない理由：コメントの作成・解決・削除のたびに本文の CRDT に書くことになり、本文のバージョンと履歴が汚れる。コメントを消しても mark が残る。コメントを書けるが本文を編集できない権限を作ったときに、書き込みの権限が混ざる。
- y を採らない理由：本文は CRDT で、合わさった後にどのメンションが残ったかは、クライアントの操作からは決まらない（2 人が同時に同じ人をメンションし、1 人が消す）。まとめた文書から抜き出すのが正しい。
- q を採らない理由：大きなファイルが API のサーバーのメモリーと帯域を使う。S3 の署名付きの URL で、大きさ・種類・中身のハッシュを縛れる。

## Consequences

- 良くなること：
  - コメントが軽く、一覧の読み込みが速い。
  - インラインのコメントが本文の同時編集とぶつからない。
  - メンションの通知が、合わさった後の本文に基づく。
  - 添付の中身が本体のドメインで動かない。
- 引き受けるコスト：
  - ADR-0002 の表の 1 行を変える。ADR-0002 は accepted のため、最初の設計の間の直しとして、ADR-0002 に日付付きの注記を足す必要がある（この ADR の範囲の外の編集なので、統合の工程で行う）。2026-09-28 に ADR-0002 に注記を足した。
  - 本文のメンションの通知が、最大で数秒遅れる。
  - 署名付きの URL は持っている人が読める。5 分の期限で抑える。
  - マルウェアの検査をしない（MVP）。

## Confirmation

- 性質ベーステスト：PROP-DOC-004（アンカー）、PROP-DOC-005（メンションの通知）。
- 結合テスト：署名の外の `PUT` が拒否される。期限切れ・他のワークスペースの `upload_ref` が拒否される。見てよくない人の `/files/<id>` が 404。
- 表駆動テスト：コメントの編集・削除・解決の権限（作った人・管理者・他のメンバー）。`can()` の決定表は permissions-and-teams の領域で書く。

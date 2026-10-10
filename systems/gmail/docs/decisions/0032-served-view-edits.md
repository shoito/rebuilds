---
status: accepted
date: 2026-10-10
---

# ADR-0032: blob は受け取ったバイトのまま変えず、利用者に返すバイトは「配る形」（前置き＋ blob に編集の表を当てたもの）にする。編集は、本システムの authserv-id を名乗る `Authentication-Results` の名前の変更と、止めた添付のパートの置き換えの 2 つだけ。配った後に編集が増えたら、メッセージを新しいオブジェクトの世代にする

詳細は [message-parsing-and-storage.md](../architecture/message-parsing-and-storage.md) の 7.5 節と [client-sync-and-protocols.md](../architecture/client-sync-and-protocols.md) の 7.8 節。

## Context

- [ADR-0003](0003-message-storage-layout-and-dedupe.md) は、受け取ったバイトを不変の blob に置き、受け手に返すメッセージを「前置き＋本文の blob」とした。DKIM の検証、転送、IMAP の `BODY[]`、書き出し、eDiscovery が同じバイトを使う前提だった。
- RFC 8601 の 5 節は、受け手の MTA が、自分の authserv-id を名乗る外からの `Authentication-Results` を消すか隠すことを求める（MUST）。blob を変えないと、IMAP のアプリは偽の結果を本物と区別できない（[sender-authentication.md](../architecture/sender-authentication.md) の 5 節、17 節の持ち越し）。
- 止めた添付（[attachment-and-url-scanning.md](../architecture/attachment-and-url-scanning.md) の `attachment_blocked`）は、どの経路からも取り出させない。IMAP の `BODY[]` と生の取得は、添付のバイトをそのまま含む（同 14 節の持ち越し）。
- 添付は、配った後の検査（署名の更新の後 72 時間）で止まることがある。IMAP は、同じ UID のメッセージの中身を変えてはならない（RFC 9051 の 2.3.1.1 節）。

## Options

1. **blob は変えず、返すときに編集の表を当てた配る形を返す**
2. 配送の時に、受け手ごとに編集した blob を別に書く
3. 編集しない（Web とアプリだけが前置きを信じ、添付の取得だけを拒む）

## Decision

1 を採用する。

- 配る形 = 前置き ＋ edit(blob, `view_edits`)。`view_edits` はメッセージの行に持つ（位置、長さ、置き換えのバイト）。
- 編集は 2 種類だけ：
  - `rename_authres`：blob のヘッダーの部の、本システムの authserv-id を名乗る `Authentication-Results` の欄の名前を `X-<Brand>-Untrusted-Authentication-Results` に変える。
  - `replace_blocked_part`：止めた添付のパートを、`text/plain` の短い知らせ（`X-<Brand>-Blocked: <理由のコード>`）に置き換える。境界と他のパートは変えない。
- 配る形を使う：IMAP の `BODY[]`・`BODYSTRUCTURE`・`RFC822.SIZE`、JMAP の Email の `blobId` の取得と `headers`・`size`、EML の書き出し、利用者の転送、検索の索引。
- blob を使う：DKIM・ARC の検証、選別、保留と eDiscovery（編集の表を添える）。
- 配った後に編集が増えたら、同じトランザクションで `object_gen` を進め、新しい JMAP の Email の ID・`EMAILID`・各箱の UID にする（[ADR-0034](0034-threading-implementation-and-merge.md) と同じ仕組み）。
- 容量は受け取った論理の大きさで数える（[ADR-0031](0031-blob-references-gc-and-quota.md)）。

### 他の案を選ばなかった理由

- **2**：同じ配送の受け手の間の共有（[ADR-0003](0003-message-storage-layout-and-dedupe.md)）を壊し、後からの止めで blob を書き直すことになる。受け取ったバイトを失う。
- **3**：RFC 8601 の MUST を満たさない。IMAP のアプリから止めた添付を取り出せる。

## Consequences

- 良くなること：
  - 受け取ったバイトを失わずに、RFC 8601 と添付の止めを、すべての経路で守れる。
  - 範囲の読み出しも、編集の表の写しで扱える。
- 引き受けるコスト：
  - 配る形は、元の DKIM の署名に合わないことがある（止めた添付、署名に含まれた `Authentication-Results`）。転送の先は ARC の封印に頼る。
  - 後からの止めで、IMAP のアプリはメッセージを取り直す。
  - [ADR-0003](0003-message-storage-layout-and-dedupe.md) の「受け手に返すメッセージは、前置き＋本文の blob」は、この ADR の配る形で読み替える。blob を変えない決まりは変わらない。

## Confirmation

- 性質ベーステスト：PROP-MSG-002・008・009。
- 相互運用の試験：主な IMAP のアプリで、止めた添付の知らせのパートと、名前を変えた欄の表示。
- lint：IMAP・JMAP・書き出しの読み出しの関数は、blob を直接返さず、配る形の関数を通す（型で強制する）。

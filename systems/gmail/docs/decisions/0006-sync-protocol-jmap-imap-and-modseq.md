---
status: accepted
date: 2026-10-10
---

# ADR-0006: Web・アプリ・第三者の API は JMAP（RFC 8620・8621）に本システムの拡張を足して使い、既存のアプリには IMAP4rev2（CONDSTORE・QRESYNC）を出す。独自の同期の API は作らない。両方を、アカウントごとの `modseq` と change log の上に作る

## Context

利用者は、Web、iOS・Android のアプリ、既存のメールのアプリ（Outlook、Thunderbird、iOS のメール、日本の業務のメールのアプリ）から、同じアカウントを使う。どの経路でも、既読・ラベル・削除が揃って見える必要がある（NFR-006）。

クライアントの同期には、次の要素が要る。

- **差分の取得**：手元の状態から、変わったものだけを取る。全体の取り直しは、数万通のメールボックスでは重い。
- **プッシュ**：変化を即時に知らせる。モバイルは OS のプッシュ（APNs・FCM）を通す。
- **オフラインの変更**：アプリは手元で変更し、後でサーバーに送る。衝突を決める。
- **既存のアプリ**：IMAP しか話せない。IMAP は UID（箱ごとに増える番号）と `UIDVALIDITY`、CONDSTORE・QRESYNC（RFC 7162）の `MODSEQ` で差分を取る。

選択肢は、IMAP、JMAP、独自の同期の API である。本家は独自の Web の API と REST の API を持ち、IMAP には独自の拡張（`X-GM-LABELS`、`X-GM-MSGID`、`X-GM-THRID`、`X-GM-RAW`）を足している（[IMAP Extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions)、2026-10-10 に確認）。拡張の名前は本家の名前を含み、使えない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

JMAP（RFC 8620 の Core、RFC 8621 の Mail）は、メッセージの複数の箱への所属（`mailboxIds`）、スレッド（`threadId`）、状態の文字列と `*/changes` による差分、`EmailSubmission`（送信）、プッシュ（EventSource、RFC 8887 の WebSocket）を持つ公開の標準である。

## Options

1. **JMAP を主の API（Web・アプリ・第三者）にし、IMAP4rev2 を既存のアプリ向けに出す。どちらも共通の change log の上に作る**
2. IMAP だけを出し、Web とアプリも IMAP の上に作る
3. 独自の同期の API（gRPC・REST）を作り、IMAP を足す

## Decision

1 を採用する。

### change log と modseq

- アカウントごとに `modseq`（64 ビットの整数）を持つ。`mailstore` は、メールボックスのどの変更（配送、ラベル、旗、スレッドの合わせ、削除、ラベルの作成・名前の変更）でも、同じトランザクションで `modseq` を 1 つ進め、change log に書く：`changes(tenant_id, account_id, modseq, kind, entity_type, entity_id, label_ids)`。
- 1 つの変更が複数のメッセージに当たる操作（スレッドのアーカイブ、全部を既読）は、1 つの `modseq` で複数の行を書く。
- 各メッセージは最後に変わった `modseq` を持つ。IMAP の `MODSEQ`、JMAP の状態は、この値から求める。
- change log の保持は 30 日（本システムの既定）。それより古い状態からの差分の要求には、JMAP は `cannotCalculateChanges`、IMAP の QRESYNC は全体の取り直しを返す。

### JMAP

- `urn:ietf:params:jmap:core`、`:mail`、`:submission`、`:vacationresponse` と、WebSocket・EventSource のプッシュを出す。
- 状態の文字列は、型ごとの最後の `modseq`（`Email`・`Thread`・`Mailbox`）を符号化したもの。`Email/changes` は change log をその `modseq` から読む。
- JMAP の `Mailbox` に本システムのラベルを対応させる。システムのラベルは `role`（`inbox`、`sent`、`drafts`、`junk`、`trash`、`important`、`scheduled`、`snoozed`）を持つ。アーカイブは「受信箱のラベルを外す」ことなので、`archive` の役の箱は持たない。
- 加えて、役 `all` の仮想の箱を出す。`SPAM`・`TRASH`・`SCHEDULED` のないすべてのメッセージを含み、`mailboxIds` の差分では足し外しできない（[ADR-0041](0041-jmap-extensions-and-mailbox-mapping.md)）。

> 2026-10-10 の注記：最初の一覧には役 `all` がなかった。RFC 8621 の 2 節は、Email が 1 つ以上の箱に属することを求める（MUST）。ラベルのないアーカイブのメッセージでもこれを満たすため、[ADR-0041](0041-jmap-extensions-and-mailbox-mapping.md) で役 `all` の仮想の箱を足した。`archive` の役の箱を持たない決まりは変わらない。IMAP の `[<Brand>]/All Mail` も、同じ集合（`SPAM`・`TRASH`・`SCHEDULED` を除く）にそろえた。

- 本システムの拡張は `urn:<brand>:params:jmap:mail` の能力の下に置く：スレッドへの一括の操作、スヌーズ、ミュート、検索の文法の文字列（`Email/query` の `filter` に、検索の IR の文字列を渡す）、配信停止のボタン、送信の取り消し。
- 予約の送信は FUTURERELEASE（RFC 4865）の `HOLDUNTIL`・`HOLDFOR` で表す。元に戻す送信の窓は、サーバーがアカウントの設定から足す。窓・予約の間の `EmailSubmission/set`（`undoStatus: canceled`）で取り消す（[ADR-0041](0041-jmap-extensions-and-mailbox-mapping.md)）。

> 2026-10-10 の注記：最初は「`EmailSubmission/set` の `sendAt` で、元に戻す送信の窓と予約の送信を表す」とした。RFC 8621 の 7 節では、`sendAt` はサーバーが決める変わらない性質で、クライアントは書けない。FUTURERELEASE を使えば解放の時刻、使わなければ作成の時刻でなければならない（MUST）。そこで [ADR-0041](0041-jmap-extensions-and-mailbox-mapping.md) のとおり、予約は FUTURERELEASE で表し、窓はサーバーが足す形にした。窓だけの送信の `sendAt` は作成の時刻で、窓の終わりは拡張の性質 `<brand>:releaseAt` で返す。


### IMAP

- IMAP4rev2（RFC 9051）と、`CONDSTORE`・`QRESYNC`（RFC 7162）、`IDLE`、`MOVE`、`SPECIAL-USE`、`OBJECTID`（RFC 8474。`EMAILID`・`THREADID` を出す）、`UIDPLUS`、`LITERAL-`、`AUTH=OAUTHBEARER`・`AUTH=XOAUTH2`。
- 各ラベルを箱として出す（[ADR-0004](0004-labels-as-primary-mailbox-model.md)）。`[<Brand>]/All Mail` は `SPAM`・`TRASH`・`SCHEDULED` 以外のすべて（JMAP の役 `all` と同じ集合）。
- **UID**：箱（ラベル）ごとの UID の数えを持ち、メッセージがそのラベルを得るたびに新しい UID を振る（`message_labels.uid`）。ラベルを外して付け直したメッセージは新しい UID になる。UID は再利用しない。`UIDVALIDITY` はラベルの作成の時に決め、ラベルを消して同じ名前で作り直したときだけ変わる。
- **MODSEQ**：アカウントの `modseq` をそのまま使う。箱の `HIGHESTMODSEQ` は、その箱の所属の変更とその箱のメッセージの変更の最大。アカウントで単調に増えるので、箱ごとに単調という RFC 7162 の条件を満たす。
- 外したラベル（`EXPUNGE` に当たる）は、QRESYNC の `VANISHED` で返すため、change log から求める。
- 独自の拡張（本家の `X-GM-*` に当たるもの）は出さない。必要な働き（メッセージの ID、スレッドの ID）は OBJECTID で出す。

### プッシュ

- `push-gateway` は、relay から change log の通知を受け、アカウントの接続中の JMAP のクライアントに `StateChange`、IMAP の IDLE のセッションに `EXISTS`・`FETCH` などの未承諾の応答の合図を送る。
- モバイルは JMAP の `PushSubscription` に相当する端末の登録を持ち、APNs・FCM へ「状態が変わった」だけを送る。中身（差出人、件名）を入れるかは法務の L3 の後に決める（mobile-and-push の領域）。

### 衝突

- 変更は `mailstore` の API の条件つきの操作にする（JMAP の `ifInState`、IMAP の `UNCHANGEDSINCE`）。条件がない操作は、最後に書いたものが勝つ（ラベルと旗は集合の足し引きで当て、全体の置き換えにしない）。
- 下書きはバージョンを持ち、古いバージョンからの保存は 409 で返す（クライアントが合わせる）。

### 他の案を選ばなかった理由

- **2（IMAP だけ）**：ラベル（複数の箱への所属）とスレッドを標準の IMAP で表すのが難しく、モバイルの差分の取得とプッシュが弱い。Web から IMAP を話すのは向かない。
- **3（独自の API）**：作る量と、第三者のアプリの対応の量が増える。JMAP で必要な形をほぼ表せる。

## Consequences

- 良くなること：
  - Web・アプリ・第三者が、同じ公開の標準で同期できる。第三者に開く API が標準になる。
  - JMAP と IMAP が同じ change log を読むので、状態がずれにくい。
- 引き受けるコスト：
  - JMAP の拡張の仕様を自分で書き、保守する。
  - IMAP のラベルごとの UID の数えと、`message_labels` の行の数が増える。
  - JMAP のクライアントのライブラリを、Web・iOS・Android で持つ。

## Confirmation

- 性質ベーステスト（同期の収束）：任意の変更の列を、JMAP・IMAP・配送・フィルターから混ぜて当て、任意の時点で切断と再接続を挟んだクライアントの模型が、すべての変更を受けた後にサーバーと同じ状態になる（[quality.md](../quality.md) の 2.2.1 節 E）。
- 性質ベーステスト（IMAP）：どの箱でも UID が単調に増え、再利用されない。`MODSEQ` が箱ごとに単調に増える。QRESYNC の結果を当てたクライアントが、全体の取り直しと同じ状態になる。
- 相互運用の試験：主な IMAP のアプリ（Thunderbird、iOS のメール、Outlook）と、IMAP の試験の道具で、主な流れを確かめる。
- lint：change log を書かずにメールボックスの表を変えるコードを禁止する（`mailstore` の書き込みの関数を通すことを型で強制する）。

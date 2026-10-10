---
status: accepted
date: 2026-10-10
---

# ADR-0041: JMAP の `Mailbox` に役 `all` の仮想の箱を出し、`SPAM`・`TRASH`・`SCHEDULED` のないメッセージは必ずそこに属する。隠した所属は `<brand>:hiddenMailboxIds` で読ませる。`STARRED` はキーワード `$flagged` で出す。送信の保留は FUTURERELEASE で表し、元に戻す送信の窓はサーバーが足し、保留の間は `SCHEDULED` を持つ。拡張は能力 `urn:<brand>:params:jmap:mail` の下に置き、名前に `<Brand>`・`<brand>:` を付ける

詳細は [client-sync-and-protocols.md](../architecture/client-sync-and-protocols.md) の 6 節。

## Context

- RFC 8621 の 2 節は、Email が 1 つ以上の箱に属することを求める（MUST）。ラベルのモデルでは、アーカイブしたメッセージはどのラベルも持たないことがある（[ADR-0004](0004-labels-as-primary-mailbox-model.md)）。[ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md) は `archive` の役の箱を持たないとした。
- RFC 8621 の 2.5 節は、`onDestroyRemoveEmails` が真なら、他の箱にないメッセージを消す。ラベルの消去でメッセージが消えるのは、ラベルのモデルの意味に合わない。
- RFC 8621 の 7 節は、`sendAt` をサーバーが決める性質とし、遅らせる送信を FUTURERELEASE（RFC 4865）で表す。[ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md) は「`sendAt` で窓と予約を表す」と書いたが、クライアントが `sendAt` を書くことはできない。
- 送信の受け付けから解放までの間、メッセージは「送信済み」を持たない（[architecture/README.md](../architecture/README.md) の 1.3 節 B）。
- `STARRED` はシステムのラベルだが、JMAP には `$flagged` のキーワードがある。両方で出すと、同じ状態が 2 つの表し方になる。

## Options

1. **役 `all` の仮想の箱、隠した所属の拡張の性質、`$flagged`、FUTURERELEASE とサーバーの窓、保留の間の `SCHEDULED`**
2. ラベルのないメッセージを `archive` の役の箱に入れる
3. RFC の MUST を外れ、`mailboxIds` が空のメッセージを返す

## Decision

1 を採用する。

- 役 `all` の箱は、`SPAM`・`TRASH`・`SCHEDULED` のないすべてのメッセージを含む仮想の箱。`mailboxIds` の差分で足す・外す要求は `invalidProperties`。
- `SPAM`・`TRASH` のメッセージの `mailboxIds` は `junk` か `trash` だけ。隠した所属は `<brand>:hiddenMailboxIds`（読み出しだけ）。
- `STARRED` は `$flagged` で出し、箱にしない。`DRAFT` は箱と `$draft` の両方で出すが、`$draft` の直接の変更は拒む。
- 予約の送信は `HOLDUNTIL`・`HOLDFOR` で表し、`maxDelayedSend` は 366 日。元に戻す送信の窓はアカウントの設定からサーバーが足す。`pending` の間はメッセージに `SCHEDULED` を付け、取り消しで `DRAFT` に戻し、解放で `SENT` にする。`onSuccessUpdateEmail` の下書き → 送信済みの移しは、この保留への移しとして当てる。
- 拡張は `urn:<brand>:params:jmap:mail`：`<Brand>Thread/set`、`<Brand>Unsubscribe/set`、`<Brand>Device/set`、性質 `<brand>:inboxAt`・`hiddenMailboxIds`・`snoozeUntil`・`authWarning`・`unsubscribe`・`muted`、条件 `<brand>:query`。
- 役 `scheduled`・`snoozed` が IANA の登録にないと分かったら、役を使わず `<brand>:role` の性質で表す。

### 他の案を選ばなかった理由

- **2**：受信箱からのアーカイブが「`archive` の箱への移動」になり、ラベルを付けたメッセージのアーカイブの意味（`INBOX` を外すだけ）と合わない。[ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md) に反する。
- **3**：標準のクライアントのライブラリと試験の道具が、MUST の違反で壊れる。

## Consequences

- 良くなること：
  - 標準の JMAP のクライアントで、ラベルのモデルが RFC に沿って動く。
  - ラベルの消去でメッセージが消えない。
  - IMAP の All Mail と JMAP の `all` が同じ集合になる。
- 引き受けるコスト：
  - 仮想の箱の件数（`totalEmails` など）を別に数える。
  - `onSuccessUpdateEmail` の当て方が、クライアントの期待（すぐ送信済みに入る）と数秒ずれる。
  - [ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md) の「`sendAt` で表す」は、この ADR の FUTURERELEASE の形で読み替える。

## Confirmation

- 性質ベーステスト：PROP-SYNC-005（`mailboxIds` と IMAP の箱の一致）。
- 相互運用：JMAP の公開の試験の道具で、`Mailbox` と `EmailSubmission` の標準の振る舞い。
- 表駆動テスト：`mailboxIds` の差分と DT-MBX の行の対応。

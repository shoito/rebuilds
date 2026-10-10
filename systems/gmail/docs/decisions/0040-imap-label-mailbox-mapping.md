---
status: accepted
date: 2026-10-10
---

# ADR-0040: IMAP はラベルを箱として出し、見える所属ごとに UID を振る。隠すと `VANISHED`、戻すと新しい UID。`\Deleted` は所属ごとに持ち、`EXPUNGE` はその箱のラベルを外す（All Mail・Sent Mail・Drafts ではゴミ箱へ、Trash・Spam では完全な削除）。箱ごとの `MODSEQ` はメッセージと所属の大きいほう。Sent Mail への `APPEND` は 24 時間の中の同じ `Message-ID` の送信と結ぶ。IMAP4rev1 と IMAP4rev2 を両方出し、同時の接続は 15

詳細は [client-sync-and-protocols.md](../architecture/client-sync-and-protocols.md) の 7 節。

## Context

- [ADR-0004](0004-labels-as-primary-mailbox-model.md) と [ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md) は、ラベルを箱として見せ、ラベルごとに UID を振り、`COPY` はラベルを足し、`MOVE` は付け替え、`EXPUNGE` はその箱のラベルを外し、Trash の `EXPUNGE` は完全な削除にすると決めた。
- 決めていないこと：
  - IMAP の `\Deleted` はメッセージの旗だが、同じメッセージが複数の箱に見える。メッセージの旗にすると、`仕事` で `\Deleted` を付けて `INBOX` で `EXPUNGE` したアプリが、受信箱から意図せず外す。
  - `[<Brand>]/All Mail` の `EXPUNGE` を何にするか（ラベルの付け外しに当たらない）。
  - 隠した所属（[ADR-0033](0033-label-operations-decision-table.md)）をどう見せるか。
  - アプリが送信の後に Sent Mail へ `APPEND` すると、本システムの送信済みと 2 通になる。
  - IMAP4rev2 を話さない古いアプリへの名前の符号化。

## Options

`\Deleted`：

1. **所属ごとに持つ**
2. メッセージの旗にする

All Mail の `EXPUNGE`：

- a. **ゴミ箱へ移す**
- b. 完全に削除する
- c. 拒む

## Decision

1 と a を採用する。

- 見える所属を得るたびに、その箱の `uidnext` から UID を振る（配送、ラベル、隠したものを戻す、合わせの世代の切り替え）。失うと `imap_vanished` に書き、`VANISHED` で知らせる。
- `\Deleted` は `message_labels.imap_deleted`。`EXPUNGE` は、その箱で `\Deleted` の所属だけに当てる。
- `EXPUNGE` の意味：利用者のラベル・`INBOX`・`Starred`・`Important` はラベルを外す。`All Mail`・`Sent Mail`・`Drafts` はゴミ箱へ。`Trash`・`Spam` は完全な削除。
- 箱 L の m の `MODSEQ` は `max(m.modseq, 所属の modseq)`。`HIGHESTMODSEQ` はラベルの行に持ち、同じトランザクションで上げる。
- `EMAILID` は `(message_id, object_gen)`、`THREADID` は `thread_id` から作る。
- Sent Mail への `APPEND` は、同じアカウントの 24 時間の中の同じ `Message-ID` の送信があれば、既存のメッセージに結んで `APPENDUID` を返す。
- IMAP4rev1 と IMAP4rev2 を出し、`ENABLE IMAP4rev2` の有無で箱の名前を UTF-8 か修正 UTF-7 で返す。
- `SCHEDULED`・`SNOOZED` は箱にしない。予約の送信のメッセージは IMAP に出さない。
- 独自の拡張（本家の `X-GM-*` に当たるもの）は出さない（[ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md)）。
- 同時の接続は 15。超えたら `NO [LIMIT]`。

### 他の案を選ばなかった理由

- **2**：箱をまたいで `\Deleted` が見え、別の箱の `EXPUNGE` が意図しないラベルを外す。
- **b**：All Mail を同期するアプリの整理（重複に見えるものの削除）で、メールが完全に消える。
- **c**：多くのアプリが削除の操作を失敗として扱い、利用者が消せない。

## Consequences

- 良くなること：
  - 既存のアプリの操作が、ラベルの意味の中で予測できる結果になる。
  - IMAP の整理でメールを失いにくい。
- 引き受けるコスト：
  - 所属ごとの旗と UID の行が増える。
  - 送信済み・下書きの `EXPUNGE` が「ゴミ箱へ」になるのは、IMAP の利用者の予想と違うことがある（説明の文書に書く）。

## Confirmation

- 表駆動テスト：DT-SYNC-001（コマンドと操作の表）。
- 性質ベーステスト：PROP-SYNC-002・005。
- 相互運用の試験：主な IMAP のアプリで、削除・移動・送信の後の `APPEND` を確かめる。

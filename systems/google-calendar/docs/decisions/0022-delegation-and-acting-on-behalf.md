---
status: accepted
date: 2026-10-04
---

# ADR-0022: 代理の人は主のカレンダーに `writer` 以上を持つ人とし、持ち主の名前で予定を作り出欠を返せる。iTIP では `SENT-BY` に代理の人を入れ、監査ログに操作した人と代わりに操作した相手を残す。代理の人は持ち主の `private` の予定の中身も見られる

## Context

日本の組織では、秘書やアシスタントが役員の予定を作り、招待に返事をすることが多い（[intent.md](../intent.md) の組織の利用者）。[architecture/README.md](../architecture/README.md) の 7 節は、委任（代理の人）を sharing-and-acl の範囲にした。

標準には、代理の送信の形がある。RFC 5545 の 3.2.18 節の `SENT-BY` の引数と、RFC 5546 の 3.2.2.5 節の「主催者の代わりに送る」である。本家の `writer` は `private` の予定の詳細も見られる（[Acl resource](https://developers.google.com/workspace/calendar/api/v3/reference/acl)、2026-10-04 に確認）。本家の委任の細部（`SENT-BY` を付けるか、通知の扱い）は、公式の資料で確かめられなかった（未検証）。

決めずに作ると、代理の人の操作がだれの操作として残るかが経路ごとに違い、監査ができない。

## Options

1. **主のカレンダーへの `writer` 以上を代理とみなし、別のロールを作らない**
2. 「代理」の専用のロールを作る
3. 代理の機能を持たない（代理の人は自分の名前で予定を作る）

## Decision

1 を採用する。詳細は [sharing-and-acl.md](../architecture/sharing-and-acl.md) の 9 節。

- 主のカレンダーに `writer` 以上を持つ人は、そのカレンダーの持ち主の代理の人である。
- 代理の人が持ち主のカレンダーに作る予定は、主催者を持ち主にし、ORGANIZER に `SENT-BY=mailto:<代理の人>` を付ける。持ち主の写しの出欠を返すときは、ATTENDEE に `SENT-BY` を付ける。内部の iTIP のメッセージにも `sent_by` を入れる（[invitations-and-itip.md](../architecture/invitations-and-itip.md)）。
- 監査ログに `actor_id`（操作した人）と `on_behalf_of`（代わりに操作した相手）を残す。変更のログには入れない。
- 代理の人は `writer` の段なので、持ち主の `private` の予定の中身も見られる（[ADR-0021](0021-effective-role-and-redact-table.md) の決定表の行 4）。
- 組織の外の人を代理にできるのは、組織の外への上限が `writer` 以上のときだけ。

### 他の案を選ばなかった理由

- **2（専用のロール）**：ACL のロールが 6 つになり、[ADR-0004](0004-tenancy-and-rls.md) と `redact()` の決定表を変える。`writer` と何が違うかを説明しにくい。
- **3（持たない）**：代理の人が主催者になり、出欠の返事や変更の権限が持ち主に戻らない。外部の参加者には、だれの会議かわからない。

## Consequences

- 良くなること：
  - 代理の操作が、iTIP（`SENT-BY`）と監査ログの両方で、だれがだれの代わりに行ったかを残す。
  - 新しいロールを足さず、決定表を変えない。
- 引き受けるコスト：
  - 主のカレンダーに `writer` を付けると、自動で代理になる。予定を書くだけの共有（家族など）でも、持ち主の名前で招待を送れる。共有の画面で「代理として招待を送れる」と示す（clients.md）。
  - 外部のカレンダーが `SENT-BY` をどう表示するかは相互運用の試験で確かめる（未検証）。

## Confirmation

- 結合テスト：代理の人が作った予定の ORGANIZER に `SENT-BY` が付き、監査ログに `actor_id` と `on_behalf_of` が残る。代理の人の出欠の返事が持ち主の出欠として主催者の写しに当たる。
- 表駆動テスト：DT-ACL-002 の「出欠を返す」の行。
- 相互運用の試験：`SENT-BY` つきの招待と返事を、本家・Outlook・Apple のカレンダーへ送り、表示を記録する。

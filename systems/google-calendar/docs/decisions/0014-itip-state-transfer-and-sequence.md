---
status: accepted
date: 2026-10-04
---

# ADR-0014: 内部の iTIP のメッセージは受け手に見せてよい形の予定オブジェクトの全体を運び、新旧を `(SEQUENCE, 主催者の版)` で決める。`SEQUENCE` は RFC 5546 の 2.1.4 節の項目に場所と参加者の削除を足して上げ、日時が変わったら出欠を `needs_action` に戻し、戻す前の `SEQUENCE` への返事は捨てる

## Context

[ADR-0006](0006-organizer-and-attendee-copies.md) は、参加者ごとに写しを持ち、主催者の写しを正にし、内部の iTIP のメッセージ（`REQUEST`・`CANCEL`・`REPLY`）で配ると決めた。新旧は `(SEQUENCE, DTSTAMP)` で判定する。

細部が決まっていない。

- **メッセージの中身**：iTIP は、変えた回だけの `REQUEST`（`RECURRENCE-ID` つき）も、系列の全体も送れる。差分を送ると、1 通が欠けたときに写しが戻らない。
- **同点**：`DTSTAMP` は時計の時刻で、複数の Writer の時計のずれや、同じミリ秒の変更で同点や逆転が起きうる。
- **`SEQUENCE` を上げる変更**：RFC 5546 の 2.1.4 節は、DTSTART・DTEND・DURATION・DUE・RRULE・RDATE・EXDATE・STATUS の変更で上げることを求める（MUST）。[ADR-0006](0006-organizer-and-attendee-copies.md) の一覧は、場所と参加者の削除を含み、STATUS と DURATION を書いていない。
- **出欠を戻すか**：日時が変われば、前の返事は前の日時に対するものである。本家が戻すかは確かめられなかった（未検証。[Events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events)、2026-10-04 に確認）。
- **遅れた返事**：日時を変えた後に、前の日時への返事が届く。

## Options

メッセージの中身：

1. **予定オブジェクトの全体（状態の転送）**
2. 変えた部分だけ（差分）

出欠を戻すか：

- a. **日時・規則の変更で、主催者以外の人の出欠を `needs_action` に戻す**
- b. 戻さない

## Decision

1 と a を採用する。詳細は [invitations-and-itip.md](../architecture/invitations-and-itip.md) の 5・6 節。

- 内部の `REQUEST` は、受け手に見せてよい形（`can_see_other_guests` を当てたもの）の予定オブジェクトの全体を運ぶ。回だけの参加者には、その回だけを運ぶ。256 KiB を超えたら S3 に置く。
- 内部の新旧は `(SEQUENCE, 主催者の版)` で決める。主催者の版は変更ごとに 1 ずつ増え、時計に左右されない。外部とのやりとりは RFC 5546 の 2.1.5 節の `(SEQUENCE, DTSTAMP)` に従い、回のメッセージは系列の `SEQUENCE` より小さければ捨てる。
- `SEQUENCE` を上げる：DTSTART・DTEND・DURATION・TZID・RRULE・RDATE・EXDATE・STATUS（RFC 5546 の 2.1.4 節）、LOCATION と参加者の削除（[ADR-0006](0006-organizer-and-attendee-copies.md)）。タイトル・説明・参加者の追加・出欠・tzdb の計算し直しでは上げない。
- DTSTART・DTEND・DURATION・TZID・RRULE・RDATE の変更では、主催者以外の人の参加者の出欠を `needs_action` に戻し、`reset_sequence` を記録する。会議室は排他の制約で決め直す。
- 返事は、参加者と回ごとに `(reply_sequence, reply_dtstamp)` の新しいものが勝つ。`reply_sequence < reset_sequence` の返事は捨て、最新の `REQUEST` を送り直す。
- 当て方の全体を決定表 DT-ITIP-001 にする。

### 他の案を選ばなかった理由

- **2（差分）**：1 通の欠けで写しが戻らず、照合のジョブまで食い違いが残る。入れ替わりで差分を当てる順が崩れる。
- **b（戻さない）**：10:00 に承諾した人が、15:00 に動いた後も承諾に見え、主催者は来ない人を数える。

## Consequences

- 良くなること：
  - 重複・入れ替わり・欠けがあっても、最後に届いた新しいメッセージで写しが収束する。照合のジョブも同じメッセージを送り直すだけでよい。
  - 時計のずれで新旧を誤らない。
  - 遅れて届いた前の日時への返事が、新しい日時の出欠として効かない。
- 引き受けるコスト：
  - 大きな系列（上書きが多い）のメッセージが大きい。S3 に置く分の遅れがある。
  - 日時の変更のたびに、参加者に返事のやり直しを求める。画面で「前は承諾していた」を示して、返事を軽くする（clients.md）。
  - STATUS と DURATION を `SEQUENCE` の対象に足した。統合の工程で [ADR-0006](0006-organizer-and-attendee-copies.md) の一覧もこの ADR に揃えた（2026-10-04）。

## Confirmation

- 表駆動テスト：DT-ITIP-001（当て方）、DT-ITIP-002（`SEQUENCE` と出欠を戻す）。
- 性質ベーステスト（配送のシミュレーター）：PROP-ITIP-001（収束）、PROP-ITIP-002（返事は 1 回だけ効く）、PROP-ITIP-003（古いメッセージは効かない）。
- 相互運用の試験：日時の変更の後、外部のカレンダーが出欠を戻すかを記録する。

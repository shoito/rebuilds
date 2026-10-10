---
status: accepted
date: 2026-10-10
---

# ADR-0023: 書き出しは `https://cal.<brand>.<domain>/l/<token>.ics`（160 ビットの乱数。DB にはハッシュ）で、有効な行の `block_span`（準備の日を含む）を終日の VEVENT で出し、氏名・住所・連絡先を出さない。`UID` は `<claim_group>@<brand>.<domain>`。取り込みで同じ領域の `UID` は自分の書き出しの戻りとして捨てる

## Context

- 書き出しは秘密のアドレスで、作り直すと古いアドレスは 404（[architecture/README.md](../architecture/README.md) の 6 節）。本システムの変化から作り直しまで p95 1 分（NFR-003）。
- 他の掲載先は書き出しを読むだけで、準備の日や締め切りの設定を知らない（[ヘルプの記事 99](https://www.airbnb.com/help/article/99) の「準備の日の設定の違いで効かない」、2026-10-10 に確認）。
- 書き出しに個人のデータを出さない（[quality.md](../quality.md) の 2.2.1 節 H）。
- `PRODID` と `UID` に本家の名前を使わない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- Google Calendar の題材の公開する ICS（[ADR-0025](../../../google-calendar/docs/decisions/0025-ics-subscriptions-both-directions.md)）と同じ秘密のアドレスの形を使う。

## Options

1. **`block_span` を終日の予定で出す。`UID` は組の ID。自分の戻りを `UID` で捨てる**
2. 泊（`nights`）だけを出す
3. 塞がった日の和を 1 つの予定にまとめて出す

## Decision

1 を採用する。詳細は [calendar-sync.md](../architecture/calendar-sync.md) の 9 節。

- 中身：有効な `stay_claims` の全種類。`DTSTART` = `lower(block_span)`、`DTEND` = `upper(block_span)`。`SUMMARY` は `Reserved` か `Not available`。氏名・人数・金額・住所・`DESCRIPTION`・`ATTENDEE` を出さない。`PRODID:-//<Brand>//Calendar//EN`。
- 範囲は昨日から予約できる期間の端まで。
- `ETag` は `calendar_version`。`Cache-Control: private, max-age=60`。1 アドレス 1 時間 120 回。
- 取り込みで `UID` が `@<brand>.<domain>` で終わる予定は捨てる。

### 他の案を選ばなかった理由

- **2**：他の掲載先が準備の日に予約を入れ、本システムの取り込みで重なりになる。
- **3**：`UID` が変化のたびに変わり、相手の差分の取り込みが毎回全部の作り直しになる。日程の変更を追えない。

## Consequences

- 良くなること：
  - 他の掲載先でも準備の日が守られる。
  - 日程の変更で `UID` が変わらず、相手が更新として扱える。
- 引き受けるコスト：
  - 準備の日も「塞がり」として相手に見える。
  - 相手が `UID` を付け替えて戻すと、捨てられない（[ADR-0022](0022-ical-conflict-clipping-and-reevaluation.md) の `possible_echo` で扱う）。

## Confirmation

- 性質ベーステスト PROP-ICS-006（RFC 5545 の検証の道具で読め、有効な行の `block_span` と一致し、個人のデータを含まない）。
- 漏れの経路の表の「iCal の書き出し」の行（[quality.md](../quality.md) の 2.2.1 節 H）。

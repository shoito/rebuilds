---
status: accepted
date: 2026-10-10
---

# ADR-0021: 取り込みは `ical-fetcher` が egress の経路から 15 分ごとに条件つきで取り、1 つの取り込みの予定を泊の区間の和にまとめ、前回との区間の差分だけを `applyIcalSnapshot` で書く。上限を超えた入力・壊れた入力は既存の行を消さない。未来の泊の半分以上が一度に消える取得は、2 回続けて同じ内容を得るまで書かない

## Context

- 他の掲載先の iCal は、外部との二重の予約を防ぐ唯一の入力であることが多い。取り込みは 15 分ごと、2 年先まで、1 リスティング 5 件まで（[architecture/README.md](../architecture/README.md) の 6 節）。取得から反映まで p95 1 分（NFR-003）。
- 取り込みの予定は `stay_claims` の `ical_block` で、排他の制約に入る（[ADR-0002](0002-availability-representation-and-double-booking.md)）。同じ取り込みの重なる予定どうしも別の組になり、互いに当たる。
- 相手の障害で、空の・途中で切れた iCal が 200 で返ることがある。そのまま書くと、外部で売れた夜が本システムで空いて見える。
- 外部の入力は信用しない（大きさ、件数、期間、私的なアドレス）。信用しない宛先への送信は DB に触れない専用のタスクで行う（[ADR-0076](0076-accounts-network-and-egress-with-ssrf-controls.md)）。
- Google Calendar の題材の ICS の購読（[ADR-0025](../../../google-calendar/docs/decisions/0025-ics-subscriptions-both-directions.md)）は予定ごとに写す。宿泊では予定の中身は要らず、泊の和だけが要る。

## Options

1. **取り込みごとに泊の区間の和を作り、区間の差分を書く。急な消失は 2 回の確かめ**
2. 予定（`UID`）ごとに `stay_claims` の行を持ち、`UID` の差分を書く
3. 毎回、取り込みの行を全部外して入れ直す

## Decision

1 を採用する。詳細は [calendar-sync.md](../architecture/calendar-sync.md) の 4〜6 節。

- `ical-fetcher`（DB に触れない）が `If-None-Match`・`If-Modified-Since` で取り、本文のハッシュが同じなら何もしない。違えば読み、泊の区間の和（`desired`）を SQS の FIFO（グループ = `listing_id`）で `ical-sync` に渡す。
- 泊への直し方：終日は `[DTSTART, DTEND)`、`DTEND` がなければ 1 泊（RFC 5545 の 3.6.1 節）。時刻つきは物件のタイムゾーンの日付で直し、4 時間未満は捨てる。`STATUS:CANCELLED`・`TRANSP:TRANSPARENT` を捨てる。`RRULE` は 500 回まで展開。範囲は昨日から 730 日。
- 上限：2 MiB、VEVENT 5,000、1 回の区間 500。超えたら失敗にし、既存の行を残す。
- `applyIcalSnapshot` は取り込みとリスティングの行をロックし、`current − desired` を外し、`desired − current` を入れる（重なりは [ADR-0022](0022-ical-conflict-clipping-and-reevaluation.md)）。
- 未来の泊が 10 泊以上で 50% 以上減る取得は、15 分後に同じハッシュを得るまで書かない。
- 失敗は 15 分から倍にして最大 4 時間。1 時間でホストに知らせ、7 日で `disabled`。

### 他の案を選ばなかった理由

- **2**：同じ取り込みの重なる予定が排他の制約で互いに当たる。相手が `UID` を毎回変えると、毎回全部を外して入れ直すことになる。
- **3**：外して入れ直す間に他の予約が入る窓はロックで防げるが、毎回の書き込みで `calendar_version` が上がり、検索と写しを毎回作り直す。

## Consequences

- 良くなること：
  - 書き込みは区間が変わったときだけ。`UID` の付け替えに強い。
  - 壊れた・空の取得で、全部の日が空くことがない。
- 引き受けるコスト：
  - 急な消失の確かめの間（最大 30 分）、外部で取り消された日が塞がったまま残る。
  - 予定ごとの由来は区間の中の鍵のハッシュの一覧でしか持たない。

## Confirmation

- 性質ベーステスト PROP-ICS-001（最後の内容と一致）、PROP-ICS-004（壊れた入力で消さない）、PROP-ICS-005（私的なアドレスへの接続 0）。`ical-sim` の全場面（[quality.md](../quality.md) の 2.2.1 節 G）。
- `ical-import-poc` で、量と相手の形と急な消失の閾値を測って記録する。

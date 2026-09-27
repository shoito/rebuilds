---
status: accepted
date: 2026-09-27
---

# ADR-0009: 主催者の操作は Meeting Actor が決定表で判定し、メディアの操作は Media Node で強制する。ミュートの解除とビデオの開始は本人の同意なしにしない

## Context

主催者は、参加者のミュート、ビデオの停止、退出させる、ロック、共同主催者の指名、画面共有の許可、名前の変更の制限を行える（[intent.md](../intent.md) の MVP）。

- 荒らしへの対処では、相手のクライアントが指示に従わない（改造したクライアント）ことを前提にする必要がある。クライアントに「ミュートして」と頼むだけでは、音声は止まらない。
- 一方で、他人のマイクやカメラを遠隔で入れることは、盗聴・盗撮になりうる。本家も、既定は主催者が解除を「頼む」形（Ask to Unmute）で、すぐに解除できるのは参加者が前もって同意したときだけである（[Muting or unmuting participants in a meeting](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0066716)、2026-09-27 に確認）。
- SFU は、producer（送り手からの流れ）を止めれば、全員への転送を止められる（mediasoup の `producer.pause()`。[mediasoup v3 API](https://mediasoup.org/documentation/v3/mediasoup/api/)、2026-09-27 に確認）。

## Options

1. **Actor が判定し、メディアの操作は Media Node で強制する。解除と開始は本人の同意**
2. **Actor が判定し、クライアントに従わせる（Media Node では強制しない）**
3. **主催者が解除・開始も強制できる（本人の同意の設定を組織で選べる）**

## Decision

1 を採用する。詳細は [signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 9 節。

- 役割は `host`（1 人）、`cohost`（50 人まで）、`attendee`。判定の決定表は Actor だけが持つ。クライアントは同じ表をボタンの表示だけに使う。
- ミュート・ビデオの停止・共有の停止は、Actor が差分を配った後、Media Node で producer を止める（`producer.pause` か `close`）。クライアントが送り続けても転送されない。
- 「全員をミュート」で本人の解除を禁じたときは、Actor が本人の解除の命令を拒否する。
- ミュートの解除とビデオの開始は、主催者が「頼む」だけにし、本人の端末で確認を出す。組織の設定でも強制にはしない。
- 退出させる操作は、Aurora に記録してから、Media Node の transport と WebSocket を閉じる（[ADR-0007](0007-meeting-actor-lease-and-epoch.md)）。
- 主催者は cohost を退出させられる。cohost は host と他の cohost を退出させられない。
- 主催者の接続が 60 秒戻らないときは、cohost、同じ組織のアカウント、アカウントのある人の順に自動で引き継ぐ。ゲストには渡さない。
- 2 を採らない理由：改造したクライアントに対して無力である。荒らしへの対処（intent.md の K6）を満たさない。
- 3 を採らない理由：本人の知らないうちにマイク・カメラが入る経路を作ることになる。通信の秘密（intent.md の L2）の整理とも合わない。

## Consequences

- 良くなること：
  - 主催者の操作が、クライアントの実装に依らずに効く。
  - 本人の同意なしにマイクとカメラが入ることはない。
- 引き受けるコスト：
  - メディアの操作は、Actor から Media Node への指示の分だけ遅れる（`host.mute` から音声が止まるまで p95 500ms を目標にする）。
  - Actor が止まっている間（最大 10 秒）は、主催者の操作が効かない。
  - 主催者不在の会議では、待合室の人が入れない。

## Confirmation

- 結合テスト：指示を無視する改造したクライアントを `host.mute` しても、他の参加者に音声が届かない（受けた RTP のパケットの数が 0）。
- 決定表の試験：9.2 節の各行を、役割と対象の役割の組み合わせで確かめる。
- 結合テスト：主催者の `host.ask_unmute` だけでは、本人の producer が再開しない。

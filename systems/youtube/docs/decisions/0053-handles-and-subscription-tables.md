---
status: accepted
date: 2026-10-10
---

# ADR-0053: ハンドルは ASCII の 3〜30 文字にして正規化した値で一意にし、登録は本人の表 `subscriptions` と扇形の配りの専用の表 `channel_subscribers` の 2 つに同じトランザクションで書く。登録のフィードは読み出しの時にチャンネルの最近の動画の写しを合わせる

## Context

- 登録は本人の表（FORCE RLS）である（[ADR-0009](0009-single-tenant-and-playable.md)）。一方、通知の扇形の配りは、チャンネルの側から登録者を順に読む必要がある。
- X の題材は、フォローを向きの違う 2 つの隣接の表に持った（[X の ADR-0007](../../../x/docs/decisions/0007-follow-graph-storage.md)）。
- アカウントとチャンネルの形、所有者、役割と権限は accounts-and-safety の領域で決める（ADR-0059、[accounts-and-safety.md](../architecture/accounts-and-safety.md) の 4 節）。ハンドルの規則はこの領域で決める。
- ハンドルは URL とメンションに使う。多くの言語の文字を受けると、見た目の似た文字のなりすましの検査が要る。
- 登録のフィードは時刻の順で、登録者の多い利用者（数千のチャンネル）でも速く返したい。

## Options

登録の表：

1. **本人の表と、専用の役割だけが読む逆向きの表の 2 つ。同じトランザクションで書く**
2. 本人の表だけで、扇形の配りは RLS を外して読む
3. 逆向きの表を非同期に作る

登録のフィード：

- a. **読み出しの時に、`ch_last:` で選んだ上位 50 チャンネルの `ch_recent:` を合わせる**
- b. 公開の時に全登録者のフィードへ書く（プッシュ）

## Decision

1 と a を採用する。詳細は [channels-subscriptions-and-notifications.md](../architecture/channels-subscriptions-and-notifications.md) の 3〜5 節。

- ハンドル：`@` と `[a-z0-9._-]` の 3〜30 文字、先頭と末尾は英数字。小文字の値に一意の索引。14 日に 2 回まで変えられ、古いハンドルを 14 日取り置いて転送する。
- 登録：`subscriptions(user_id, channel_id, level)`（本人の表）と `channel_subscribers(channel_id, user_id, level)`（専用の DB の役割 `fanout_reader` だけ）を、outbox と同じトランザクションで書く。既定の段階は `personalized`。利用者あたり 4,000 チャンネル。
- 登録者の数：Valkey に積んで 1 分ごとに書き戻し、毎日突き合わせる。表示は 3 桁の有効数字。
- フィード：`ch_last:` を束ねて読み、最後の公開の新しい上位 50 チャンネルの `ch_recent:`（直近 30 本）を合わせ、`playable()` を通す。

### 他の案を選ばなかった理由

- **2（RLS を外して読む）**：本人の表を RLS の外で読む経路が増え、漏れの監査が難しくなる。
- **3（非同期）**：登録の直後の公開で通知が漏れる。
- **b（プッシュのフィード）**：数百万の登録者のチャンネルの公開で数百万の書き込みになる。動画の公開は投稿より少なく、読み出しの合わせで足りる。

## Consequences

- 良くなること：
  - 本人の表の RLS を保ったまま、チャンネルの側から登録者を順に読める。
  - 大きなチャンネルの公開で書き込みが増えない。
- 引き受けるコスト：
  - 2 つの表の書き込みと毎日の突き合わせ。
  - ASCII のハンドルは日本の利用者に不便。S2 で日本語のハンドルを検討する。

## Confirmation

- PROP-SUB-001・005。
- RLS の検査：`channel_subscribers` を API の役割で読めない。

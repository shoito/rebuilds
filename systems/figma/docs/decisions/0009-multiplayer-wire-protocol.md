---
status: accepted
date: 2026-09-27
---

# ADR-0009: 送受信は WebSocket の上の二値のメッセージ。`ChangeSet` ごとの `client_seq` で重複を除き、ジャーナルに書いた後に `Committed` を Gateway ごとに 1 回配る

## Context

[ADR-0002](0002-central-authoritative-multiplayer.md) で中央のサーバーが順序を決めると決め、[ADR-0003](0003-journal-and-checkpoints.md) でジャーナルに書いてから確定を返すと決めた。残る問いは、クライアントと Document Server の間で何を、どの単位で、どう送るかである。

- 再接続や持ち主の交代で、同じ変更が 2 回届きうる。2 回当てても結果は同じ（LWW）だが、`create` は重複の拒否になり、Undo の記録もずれる。
- 利用者の 1 つの操作（貼り付けで 100 ノード）は、他の人に半分だけ見えてはならない。
- 1 ファイルに数百の接続がある。Document Server が接続ごとに送ると、送信の量が接続の数に比例する（[architecture/README.md](../architecture/README.md) の 7 節のホットスポット）。
- 自分の入力は、サーバーを待たずに画面に出す（NFR-002）。

本家は、変更をプロパティの値の単位で送り、未確定の自分の変更と同じプロパティへのサーバーの変更を捨てて、ちらつきを防ぐ（[How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)、2019-10-16、2026-09-27 に確認）。送受信の形式そのものは公開されていない（**未検証**）。rebuilds の Notion は、端末ごとの連番（`tx_counter`）で重複を除く（[Notion の collaboration.md](../../../notion/docs/architecture/collaboration.md) の 4 節）。

## Options

1. **`ChangeSet` 単位のメッセージ。セッションごとの `client_seq` で重複を除き、確定の後に配る。配信は Gateway ごとに 1 回**
2. **操作（1 プロパティ）単位のメッセージ。重複の除去はしない（LWW に任せる）**
3. **確定の前に、他の人へ先に配る（楽観的な配信）**
4. **Document Server が接続ごとに直接送る（Gateway は中継だけ）**

## Decision

1 を採用する。詳細は [multiplayer.md](../architecture/multiplayer.md) の 3・4・9 節。

- WebSocket のバイナリのフレーム。符号化は [ADR-0008](0008-canonical-binary-serialization.md)。メッセージの種類は `Hello`・`Changes`・`Presence`・`Follow`・`LoadPage`・`Ping` と、`Welcome`・`Ack`・`Reject`・`Committed`・`PageData`・`PresenceBatch`・`Participants`・`RoleChanged`・`ResumeToken`・`Kick`・`Pong`（`ResumeToken` は 2026-09-27 に足した。[permissions-and-sharing.md](../architecture/permissions-and-sharing.md) の 5.5 節）。
- 変更は `ChangeSet`（1 つの利用者の操作）を単位に送り、原子的に当てる。`seq` は `ChangeSet` ごとに 1 つ。
- セッションごとの `client_seq` を 1 ずつ増やす。サーバーは `last_client_seq` をセッションの表に持ち、ジャーナルとチェックポイントに残す。再送は `≤ last_client_seq` で重複として `Ack` だけを返す。飛びは `Reject(out_of_order)`。
- 確定の順：検証 → `seq` → メモリに適用 → ジャーナル → `Committed`。ジャーナルに書く前の変更は、誰にも見せない。
- `Committed` は Gateway のタスクごとに 1 回送る。Gateway が接続に分け、送り手には `Ack`（`ops` を省く）に変える。
- 接続のチケット（または同じ持ち主への再接続での再開のトークン）は URL に入れず、最初のメッセージで送る。`schema_hash` が合わなければ `Kick(version_mismatch)`。
- 2 を採らない理由：1 つの操作が半分だけ当たる状態が他の人に見える。`create` の重複と Undo の記録のずれを、個別に扱うことになる。
- 3 を採らない理由：持ち主が確定の前に落ちると、他の人が見た変更が消える（ADR-0003 と同じ理由）。
- 4 を採らない理由：1 ファイル 500 接続で、Document Server の送信が接続の数に比例し、ホットスポットが悪化する。

## Consequences

- 良くなること：
  - 再接続と持ち主の交代で、変更が 2 回当たらない。
  - 1 つの操作は、全員に一度に見える。
  - Document Server の送信の量が、Gateway の数に比例する。
- 引き受けるコスト：
  - セッションの表を、ジャーナルとチェックポイントに持つ。
  - 確定の時間に、ジャーナルの書き込みが入る（[multiplayer.md](../architecture/multiplayer.md) の 8 節の予算）。
  - Gateway が、ファイルごとの接続の一覧と、送り手の判別を持つ。

## Confirmation

- 性質ベーステスト（PROP-MP-004・005）：`Ack` を受けた変更はすべてサーバーの履歴にあり、同じ `(session_id, client_seq)` は 1 回だけ当たる。
- 障害注入のテスト：`Committed` の送信の前後で Document Server を落とし、クライアントの送り直しで重複も欠落も起きない。
- 計測：Document Server の送信のバイト数を、接続の数と Gateway の数で割って、Gateway の数に比例することを確かめる。

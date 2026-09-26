---
capability: channels
change: 260926-channel-list
issue:
epic: E1
status: approved
---

# Spec: 参加しているチャンネルの一覧

## 概要

E1 の Web クライアントのサイドバーに必要な、参加しているチャンネルの一覧を返す。チャンネルの作成・参加・退出・アーカイブは E2 の `channel-lifecycle`、権限の決定表は E2 の `authorization-decision-tables` で扱う。E1 では、seed で作ったチャンネルとメンバーシップだけを使う。

## ADDED Requirements

### REQ-CHN-001: 参加しているチャンネルの一覧

ワークスペースのメンバーがチャンネルの一覧を要求したとき、システムは、そのメンバーが参加しているチャンネルだけを、名前の順で返さなければならない。各要素は `{ channel_id, name, kind, is_private, last_seq, last_read_seq }` を持つ。

#### Scenario: 参加しているチャンネルだけが返る

- Given W1 に `#general`・`#random`・`#secret`（プライベート）があり、メンバー A は `#general` と `#random` に参加している
- When A が `GET /api/workspaces/{W1}/channels` を要求する
- Then `#general` と `#random` だけが返る。`#secret` の名前も件数も応答に含まれない

#### Scenario: 別のワークスペース

- Given A は W1 のメンバーで、W2 のメンバーではない
- When A が `GET /api/workspaces/{W2}/channels` を要求する
- Then 404 が返る

### REQ-CHN-002: 未読の有無の材料

一覧の各チャンネルについて、システムは `last_seq`（チャンネルの最新の `seq`）と、要求者の `last_read_seq` を返さなければならない。未読の有無と数は、クライアントがこの 2 つから求める（[read-state-and-notifications.md](../../architecture/read-state-and-notifications.md)）。

#### Scenario: 未読がある

- Given `#general` の `last_seq` が 10 で、A の `last_read_seq` が 7
- When A が一覧を要求する
- Then `#general` の要素は `last_seq`=10、`last_read_seq`=7 を持つ

## Correctness Properties

### PROP-CHN-001: 一覧は参加しているチャンネルの集合と等しい

任意のチャンネル（パブリック・プライベート）とメンバーシップの組み合わせについて、一覧が返すチャンネルの集合は、要求者の `channel_members` の行があるチャンネルの集合と等しい。他のワークスペースのチャンネルは、どの組み合わせでも含まれない。

## Design

- 読み取りは reader の DB で行ってよい。ただし、直後に投稿した結果（`last_seq`）がすぐ反映されないことがある。E1 では許容し、E4 のリアルタイム同期で補う。
- 権限の判定は ADR-0005 の判定関数（`listReadableChannels` 相当）を通す。E2 でパブリックチャンネルの「参加していないが読める」一覧を加えるときに、この関数を拡張する。

## Open questions

- サイドバーの並び順（名前の順か、最近の活動の順か）。E1 は名前の順にし、E5 で見直す（PM）。

## 決定（2026-09-26、PM・QA、既定案）

上の Open questions は、次のとおり決めた。

- E1 のサイドバーは名前の順にする。最近の活動の順は E5 で見直す。

---
capability: messaging
change: 260926-post-and-list-messages
epic: E1
status: draft
---

# Spec: メッセージの投稿と履歴取得

## 概要

チャンネルのメンバーがメッセージを投稿し、履歴を取得できるようにする。walking skeleton として、契約 → API → DB を端から端まで貫く最初の変更。リアルタイム配信（E4）と Web 表示（次の変更）は含めない。

## ADDED Requirements

### REQ-MSG-001: メッセージの投稿

チャンネルのメンバーがメッセージを投稿したとき、システムはメッセージを保存し、そのチャンネルでそれまでの最大値より 1 大きい `seq` を付けて返さなければならない。

#### Scenario: 空のチャンネルへの最初の投稿

- Given メンバー A が属する、メッセージ 0 件のチャンネル C
- When A が C に本文「hello」を投稿する
- Then 201 が返り、`seq` は 1、本文は「hello」、投稿者は A である

#### Scenario: 続けての投稿

- Given `seq` 1〜3 のメッセージがあるチャンネル C
- When メンバーが C に投稿する
- Then 返されるメッセージの `seq` は 4 である

### REQ-MSG-002: 再送による重複の防止

同じメンバーが同じチャンネルに同じ `client_msg_id` で投稿した場合、システムは新しいメッセージを作らず、既存のメッセージを返さなければならない。

#### Scenario: 同じ client_msg_id での再送

- Given A がチャンネル C に `client_msg_id` = X で投稿し、`seq` 5 が返っている
- When A が C に `client_msg_id` = X で再び投稿する
- Then 200 が返り、`seq` 5 の既存メッセージが返る。C のメッセージ数は増えず、`seq` も消費されない

#### Scenario: 別のメンバーが同じ client_msg_id を使う

- Given A が C に `client_msg_id` = X で投稿済み
- When B が C に `client_msg_id` = X で投稿する
- Then 201 が返り、新しいメッセージとして保存される

### REQ-MSG-003: メンバー以外の投稿の拒否

チャンネルのメンバーでない者が投稿した場合、システムは 404 を返し、何も保存せず、`seq` も消費してはならない。

#### Scenario: 非メンバーの投稿

- Given A がメンバーでないチャンネル C（最新の `seq` は 7）
- When A が C に投稿する
- Then 404 が返り、C のメッセージ数は変わらず、次にメンバーが投稿したときの `seq` は 8 である

#### Scenario: 別のワークスペースのチャンネルへの投稿

- Given ワークスペース W1 のメンバー A と、ワークスペース W2 のチャンネル C
- When A が、パスのワークスペースを W1 にして、C の ID に投稿する
- Then 404 が返り、W1・W2 のどちらにも何も保存されない

### REQ-MSG-004: 履歴の取得

チャンネルのメンバーが履歴を要求したとき、システムはメッセージを `seq` の降順で、最大 `limit` 件返さなければならない。`before_seq` が指定されたときは、それより小さい `seq` のメッセージだけを返さなければならない。

#### Scenario: 最新ページ

- Given `seq` 1〜120 のメッセージがあるチャンネル C
- When メンバーが `limit` を指定せずに履歴を要求する
- Then `seq` 120〜71 の 50 件が降順で返り、`has_more` は true である

#### Scenario: 前のページ

- Given `seq` 1〜120 のメッセージがあるチャンネル C
- When メンバーが `before_seq` = 71、`limit` = 100 で要求する
- Then `seq` 70〜1 の 70 件が返り、`has_more` は false である

#### Scenario: limit の上限

- When メンバーが `limit` = 101 で要求する
- Then 400 が返る

### REQ-MSG-005: メンバー以外の履歴取得の拒否

チャンネルのメンバーでない者が履歴を要求した場合、システムは 404 を返さなければならない。

#### Scenario: 非メンバーの履歴取得

- Given A がメンバーでないチャンネル C
- When A が C の履歴を要求する
- Then 404 が返り、レスポンスに C の存在を示す情報（名前など）は含まれない

#### Scenario: 別のワークスペースのチャンネルの履歴

- Given ワークスペース W1 のメンバー A と、ワークスペース W2 のチャンネル C
- When A が、パスのワークスペースを W1 にして、C の ID の履歴を要求する
- Then 404 が返る

### REQ-MSG-006: 本文の検証

本文が空、または 40,000 文字を超える場合、システムは 400 を返し、何も保存してはならない。

#### Scenario: 空の本文

- When メンバーが空の本文（空白のみを含む）で投稿する
- Then 400 が返る

#### Scenario: 上限ちょうど

- When メンバーが 40,000 文字の本文で投稿する
- Then 201 が返る

## Decision Tables

### DT-MSG-001: 投稿の結果

上から順に評価し、最初に一致した行を採用する。別のワークスペースのチャンネルは、「チャンネルのメンバー」が「いいえ」として扱われる（RLS により存在自体が見えない）。権限の判定を最初に行うのは、非メンバーに本文の検証結果を返すと、チャンネルの存在が漏れるため。

| # | チャンネルのメンバー | 本文が有効 | 同じ（メンバー, `client_msg_id`）の既存メッセージ | → ステータス | → 返すもの | → `seq` の消費 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | いいえ | - | - | 404 | エラー | しない |
| 2 | はい | いいえ | - | 400 | エラー | しない |
| 3 | はい | はい | あり | 200 | 既存のメッセージ（本文が違っても既存を返す） | しない |
| 4 | はい | はい | なし | 201 | 新しいメッセージ | する |

## Correctness Properties

### PROP-MSG-001: seq は欠番・重複なく単調増加する

1 つのチャンネルへの、任意の数の並行した投稿（再送や非メンバーの投稿を含む）に対して、保存されたメッセージの `seq` の集合は、ちょうど 1 から N（N はメッセージ数）である。

### PROP-MSG-002: 冪等性

任意の投稿リクエストの列（同じ `client_msg_id` の再送を任意の回数含む）に対して、保存されるメッセージ数は、異なる（メンバー, `client_msg_id`）の組の数と等しい。

## Design

- データモデルと採番方法は [data-model.md](../../architecture/data-model.md)、[ADR-0001](../../decisions/0001-per-channel-sequence.md) に従う。
- 本文は [ADR-0006](../../decisions/0006-message-body-ast.md) の AST で受け付ける。この変更ではテキストノードだけを扱う。
- テナントの分離は [ADR-0009](../../decisions/0009-pooled-tenancy-with-rls.md) に従い、最初のマイグレーションから `workspace_id`・複合キー・RLS を入れる。後から入れるとマイグレーションが重いため。
- 認証は E2 まで簡易方式（開発用トークンから `account_id` を得て、パスの `workspace_id` からメンバーを解決する）とする（[ADR-0010](../../decisions/0010-accounts-and-workspace-members.md)）。
- 非メンバーに 403 ではなく 404 を返すのは、プライベートチャンネルの存在を漏らさないため（[ADR-0005](../../decisions/0005-single-authorization-check.md)）。
- API：
  - `POST /workspaces/{workspace_id}/channels/{channel_id}/messages` `{ client_msg_id, body }` → 201（新規） / 200（再送）
  - `GET /workspaces/{workspace_id}/channels/{channel_id}/messages?before_seq&limit` → `{ messages, has_more }`

## Open questions

- パブリックチャンネルを非メンバーが閲覧できるようにするか（本家は可能）。E2 で決める。この変更では、すべてのチャンネルをメンバー限定として扱う。

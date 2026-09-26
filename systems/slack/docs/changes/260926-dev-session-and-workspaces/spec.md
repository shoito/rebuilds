---
capability: workspaces
change: 260926-dev-session-and-workspaces
issue:
epic: E1
status: approved
---

# Spec: 開発用のサインインと、自分のワークスペースの一覧

## 概要

E1 の Web クライアント（[web-app-shell-routing](../260926-web-app-shell-routing/spec.md)）が動くのに必要な、最小の「だれか」と「どこに入れるか」を用意する。

本番のログイン（Better Auth、メールの OTP、OAuth）は E2 の `auth-email-otp-and-oauth` で作る。この変更の開発用のサインインは、そのときに置き換える。

## ADDED Requirements

### REQ-WS-001: 開発用のサインイン

開発用のサインインが有効な環境で、メールアドレスを指定してサインインを要求したとき、システムはそのメールアドレスのアカウントを（なければ作って）選び、セッションの Cookie を発行しなければならない。

#### Scenario: 既存のアカウントでのサインイン

- Given seed で作られたアカウント `alice@example.test`
- When `POST /api/dev/sign-in { email: "alice@example.test" }` を送る
- Then 204 が返り、`HttpOnly`・`Secure`・`SameSite=Lax` のセッションの Cookie が付く

#### Scenario: 未知のメールアドレス

- When 存在しないメールアドレスで要求する
- Then アカウントが作られ、204 が返る

### REQ-WS-002: 本番での無効化

開発用のサインインが無効な環境（prod）では、システムは `POST /api/dev/sign-in` に 404 を返し、アカウントもセッションも作ってはならない。

#### Scenario: prod での要求

- Given 環境が prod
- When `POST /api/dev/sign-in` を送る
- Then 404 が返り、アカウントの数は変わらない

### REQ-WS-003: 自分のワークスペースの一覧

サインインしたアカウントが自分のワークスペースの一覧を要求したとき、システムは、そのアカウントがメンバー（無効化されていないもの）として属するワークスペースだけを、名前の順で返さなければならない。

#### Scenario: 2 つのワークスペースに属する

- Given アカウント A が W1・W2 のメンバーで、W3 のメンバーではない
- When A が `GET /api/me/workspaces` を要求する
- Then W1 と W2 だけが返る。応答は `{ account_id, workspaces: [...] }` で、各要素は `{ workspace_id, name, member_id, role }` を持つ

#### Scenario: 無効化されたメンバー

- Given A の W2 のメンバーが無効化されている
- When A が一覧を要求する
- Then W2 は含まれない

### REQ-WS-004: 未サインインの拒否

セッションがない、または期限切れの要求に対して、システムは `GET /api/me/workspaces` と、すべての `/api/workspaces/...` に 401 を返さなければならない。

#### Scenario: Cookie なし

- When Cookie なしで `GET /api/me/workspaces` を要求する
- Then 401 が返る

## Decision Tables

### DT-WS-001: 開発用のサインインの可否

上から順に評価し、最初に一致した行を採用する。

| # | 環境 | `DEV_SIGN_IN_ENABLED` | → 結果 |
| --- | --- | --- | --- |
| 1 | prod | - | 404（ルート自体を登録しない） |
| 2 | local / dev / staging | 真 | 受け付ける |
| 3 | local / dev / staging | 偽 | 404 |

## Correctness Properties

PROP-WS-001 は、テナント分離の性質として ADR-0009・0027 と quality.md が参照しているため、E2 で定義する。ここでは使わない。

### PROP-WS-002: 一覧はメンバーシップの部分集合である

任意のアカウント・ワークスペース・メンバーシップ（無効化を含む）の組み合わせについて、`GET /api/me/workspaces` が返すワークスペースの集合は、そのアカウントの有効なメンバーシップのワークスペースの集合と等しい。

## Design

- **テナントをまたぐ読み取り**：自分のワークスペースの一覧は、テナントをまたぐ正当な読み取り（ADR-0009 の規則）にあたる。`members` の RLS に「`account_id = current_setting('app.account_id')` の行は読める」ポリシーを加えるか、`SECURITY DEFINER` の関数 `me_list_workspaces()` で行う。ここでは関数を採る。例外を 1 か所に閉じられるため。
- **セッション**：E1 のセッションは、`sessions` テーブルに置き、Cookie には不透明な ID だけを入れる。E2 で Better Auth のセッションに置き換える（ADR-0012）。認証ミドルウェアの入口（`account_id` を得る部分）だけを差し替えればよい形にする。
- `DEV_SIGN_IN_ENABLED` は環境変数で持ち、prod の Terraform では定義しない。prod のイメージでも、ルートの登録の段階で除く（DT-WS-001 の 1 行目）。
- seed は、`alice`・`bob`（W1・W2）、`carol`（W2 のみ）のアカウントと、各ワークスペースの `#general` を作る。

## Open questions

- E2 で Better Auth に置き換えるときに、E1 の `sessions` の行を移すか、捨てるか（dev・staging だけなので、捨ててよい見込み）。

## 決定（2026-09-26、PM・QA、既定案）

上の Open questions は、次のとおり決めた。

- E2 で Better Auth に置き換えるとき、E1 の `sessions` の行は移さずに捨てる（dev・staging だけのため）。
- `GET /api/me/workspaces` の応答に `account_id` を含める（web-app-shell-routing の「最後に開いたワークスペース」の記憶のキーに使う）。

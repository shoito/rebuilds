---
status: accepted
date: 2026-10-10
---

# ADR-0058: OAuth のスコープを、読み・変更・送信・設定・全部の 9 つに分け、`basic`・`sensitive`・`restricted` の 3 つの級に置く。JMAP のメソッドと IMAP・submission はスコープの表で判定する。`restricted` を求める第三者のアプリは、持ち主と所有のドメインと方針の確かめに加えて、独立した評価者の安全の評価を受け、年 1 回やり直す。確かめていないアプリは警告の画面を出し、許す利用者を 100 人までにする。組織はアプリを許可の一覧で絞り、組織の中だけのアプリは確かめなしで使える

詳細は [api-and-integrations.md](../architecture/api-and-integrations.md) の 5・6 節。

## Context

- MVP は JMAP と IMAP を第三者のアプリに開く（[intent.md](../intent.md)）。第三者のアプリは、利用者のメールの全部を読める。悪意のある・作りの甘いアプリは、大量のメールの漏えいの入口になる。
- 本家は、制限のスコープを求めるアプリに確かめと、第三者のサーバーで扱うなら認定の評価者の安全の評価を求め、12 か月ごとにやり直させる。確かめていないアプリは許す利用者の数に上限がある（[Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)、2026-10-10 に確認。上限の数は資料にない）。
- IMAP は読み書きの区別が細かく、操作を細かいスコープに対応させると既存のアプリが壊れる。
- 組織は、利用者が許せるアプリを絞りたい。

## Options

1. **9 つのスコープと 3 つの級、級ごとの確かめ、組織の方針**
2. 読みと書きの 2 つのスコープだけ
3. 第三者のアプリを MVP では開かない（本システムのアプリだけ）

## Decision

1 を採用する。

- スコープ：`mail.metadata`（`sensitive`）、`mail.readonly`・`mail.modify`（`restricted`）、`mail.compose`・`mail.send`（`sensitive`）、`mail.labels`（`basic`）、`mail.settings.basic`（`sensitive`）、`mail.settings.sharing`（`restricted`）、`mail.full`（`restricted`）。管理の API は `admin.*`。
- 判定：`jmap-api` の 1 つの表（メソッド × 引数 × スコープ、DT-API-001）。本文・`headers` の全体・語の検索は `mail.readonly` 以上。`Email/set` の `destroy` は `mail.full`。IMAP は `mail.full`、submission は `mail.send` 以上。
- 級：`unverified`（100 人まで、警告）、`verified`（持ち主・ドメイン・方針の確かめ、`sensitive` まで）、`assessed`（安全の評価、`restricted` を含む、12 か月）。`known_mail_client` は `assessed` 扱い（端末の中だけで扱うアプリに限る）。`org_internal` は確かめなしで、その組織のアカウントだけ。
- 同意：部分の同意を許す。`mail.full` と `mail.settings.sharing` は 10 分以内の再認証。
- 組織：`apps.policy` は `all`・`verified_only`（既定）・`allowlist`。アプリごと・級ごとの禁止と、組織全体の取り消し。

### 他の案を選ばなかった理由

- **2**：送信だけのアプリ、見出しだけのアプリに全部の読みを与えることになる。転送の設定（乗っ取りの入口）を読みの権限と分けられない。
- **3**：既存のメールのアプリ（IMAP）が使えず、移行の妨げになる。[intent.md](../intent.md) の MVP の範囲に反する。

## Consequences

- 良くなること：
  - アプリは要る分だけを求め、利用者は何を許すかが分かる。
  - 全部を読めるアプリは評価を経たものに限られる。
  - 組織が自分の利用者のアプリを絞れる。
- 引き受けるコスト：
  - 審査の担当と評価者の仕組みを運用する。
  - スコープの表の保守（新しいメソッド・拡張ごとに行を足す）。
  - 確かめていないアプリの開発者は 100 人を超えて広げられない。

## Confirmation

- 性質ベーステスト：PROP-API-001（スコープの外が出ない）。
- 表駆動テスト：DT-API-001、DT-API-002。
- lint：JMAP のメソッドを足すとき、DT-API-001 に行のないメソッドを CI が拒む。
- E17 の外部のペンテストで、スコープの迂回を確かめる。

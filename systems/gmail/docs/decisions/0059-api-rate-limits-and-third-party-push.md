---
status: accepted
date: 2026-10-10
---

# ADR-0059: 速さの上限は、JMAP のメソッドの重さ（単位）を `(account, client)`・`account`・`client` の 3 つの鍵の GCRA で数え、超えたら 429 と `Retry-After` を返す。IMAP は 1 時間 2.5 GB・1 日 20 GB の読み出しと 1 時間 1 GB の書き込みを数える。第三者のサーバー向けのプッシュは JMAP の `PushSubscription`（確かめの番号、https、公開の IP だけ、中身なし、最長 7 日）で出し、送れないときは 24 時間まで後退して止める

詳細は [api-and-integrations.md](../architecture/api-and-integrations.md) の 7・8 節。

## Context

- 第三者のアプリの暴走（同期の誤り、`FETCH 1:*` の繰り返し）は、利用者の全体の量とシャードの負荷を食う。[client-sync-and-protocols.md](../architecture/client-sync-and-protocols.md) は IMAP の読み出しを 1 時間 2.5 GB と仮に置き、この領域で見直すとした。
- 本家の API は単位で数え、利用者あたり 1 分 6,000 単位、プロジェクトあたり 1 分 120 万単位（[Usage limits](https://developers.google.com/workspace/gmail/api/reference/quota)、2026-10-10 に確認）。IMAP は 1 日 2,500 MB の読み出しと 500 MB の書き込み（[Gmail bandwidth limits](https://knowledge.workspace.google.com/admin/gmail/gmail-bandwidth-limits)、同）。
- 本システムの利用者の平均は 2 GB で、IMAP の初回の同期を 1 日で終えたい。
- 第三者のサーバーは、ポーリングの代わりに変化の合図を求める。webhook は、本システムから任意の URL へ送る経路で、SSRF の入口になる。プッシュに中身を入れない（[ADR-0045](0045-push-payload-without-content.md)）。

## Options

上限の数え方：

1. **メソッドの重さの単位と 3 つの鍵の GCRA**
2. 要求の数だけを数える
3. 時間の窓（1 分の固定の窓）の数え

第三者のプッシュ：

- a. **JMAP の `PushSubscription`（RFC 8620 の 7.2 節）と EventSource**
- b. EventSource だけ
- c. 本システムの独自の webhook の形

## Decision

1 と a を採用する。

- 単位：見出しの `*/get` 1 ＋ 100 件ごと 1、本文の `Email/get` 5 ＋ 10 件ごと 5、`*/changes` 2、`Email/query` 5（語の検索は 10）、`*/set` 2 ＋ 50 件ごと 2、送信 1 通 20、転送 1 MiB ごと 2。
- 上限：`(account, client)` 1 分 3,000（バースト 500。本システムのアプリは 2 倍）、`account` 12,000（2,000）、`client` 300 万（`unverified` は 3 万）。GCRA を Valkey に持ち、使えないときは台ごとに割る。429 と `Retry-After` と RFC 7807 の本文。
- IMAP：読み出し 1 時間 2.5 GB・1 日 20 GB、書き込み 1 時間 1 GB、コマンド 1 接続 1 秒 50。超えたら `NO [LIMIT]`。
- 送信は、加えて [ADR-0021](0021-sending-limits-and-compromised-account-detection.md) の上限で数える。
- `PushSubscription`：https、送るたびの解決で公開の IP だけ、egress の代理だけから。中身は `StateChange`（`keys` があれば RFC 8291 で暗号化）、`<Brand>-Signature` の HMAC。最長 7 日、1 秒 1 回にまとめる、時間切れ 5 秒、1 分から 1 時間の後退、24 時間で `disabled`。購読は 1 クライアント 5・アカウント 50。
- EventSource：1 クライアント 5・アカウント 20。

### 他の案を選ばなかった理由

- **2**：本文を 1,000 通取る要求と見出しを 1 通取る要求が同じ重さになり、上限が負荷を表さない。
- **3**：窓の境目の前後で 2 倍を通す。
- **b**：サーバーのアプリが接続を持ち続けることになり、多くの利用者を持つアプリで接続の数が増える。
- **c**：標準があるのに独自の形を作ることになる（[ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md)）。

## Consequences

- 良くなること：
  - 負荷に比例した上限で、1 つのアプリが利用者・全体の量を食えない。
  - IMAP の初回の同期が 1 日で終わる。
  - 第三者のサーバーがポーリングをやめられる。
- 引き受けるコスト：
  - 単位の表の保守。単位の値は負荷試験で見直す。
  - IMAP の読み出しの上限を本家より緩くしたので、暴走のときの負荷が大きい（1 時間の上限で抑える）。
  - webhook の送り先の検査と egress の代理を運用する。

## Confirmation

- 性質ベーステスト：PROP-API-002（GCRA の上限）、PROP-API-003（SSRF）、PROP-API-004（中身なし）。
- 負荷試験（E17）：上限に当たる同期のアプリの模型で、他のアカウントの NFR-005・NFR-006 が保たれる。
- 監視：429 の率をクライアントごとに見る（[observability.md](../architecture/observability.md)）。

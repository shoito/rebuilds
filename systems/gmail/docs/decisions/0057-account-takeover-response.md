---
status: accepted
date: 2026-10-10
---

# ADR-0057: 乗っ取りの対応は、アカウントの状態 `normal → at_risk → locked → recovering → normal` の機械で行う。`locked` で、すべてのセッションと OAuth のトークンを失効し、送信を保留（ADR-0021）し、直近 7 日に作った転送の先・フィルター・送信の別名・回復の手段を止めて本人の見直しに回す。乗っ取りの印は送信の点・サインインの危険・設定の変更の 3 つから入り、どの部品も同じ `account_risk` の出来事で状態を動かす

詳細は [accounts-and-security.md](../architecture/accounts-and-security.md) の 9 節。

## Context

- 乗っ取られたアカウントは、転送の規則を仕込まれてメールを抜かれ、本人の連絡先へのフィッシングの踏み台になる（[architecture/README.md](../architecture/README.md) の 6 節のリスク）。
- 送信の乗っ取りの点は `outbound-gate` が出し、0.9 以上で送信をすべて保留して再認証を求める（[ADR-0021](0021-sending-limits-and-compromised-account-detection.md)）。サインインの危険は `accounts` が出す（[ADR-0056](0056-sign-in-risk-and-account-recovery.md)）。転送・フィルターの変更は `mailstore` で起きる。
- 信号を出す部品が別々で、それぞれが別の対応（送信の保留、セッションの失効、転送の止め）をすると、途中で止まったとき・同時に起きたときに状態が食い違う。
- 転送の先は確かめてから有効になる（[ADR-0048](0048-verified-forwarding.md)）が、攻撃者が転送の先を自分で確かめれば有効になる。

## Options

1. **1 つのステートマシンと `account_risk` の出来事。`locked` の動作は冪等な段の列**
2. 部品ごとに対応する（`outbound-gate` は送信を止め、`accounts` はセッションを失効する）
3. 疑いがあれば、アカウントを停止（`suspended`）にする

## Decision

1 を採用する。

- 状態：`normal`・`at_risk`・`locked`・`recovering`。`accounts.risk_state` に持ち、`account_risk_events` に理由のコードと遷移を残す。
- 出来事：`accounts`（サインインの中・高）、`outbound-gate`（送信の点 0.5〜0.9 は `at_risk`、0.9 以上は `locked`）、`mailstore`（転送の先・送信の別名・回復の手段の変更は `at_risk` の信号）、本人の「自分ではない」、運用の手順。SNS `account-risk` で流し、`accounts` の 1 つの処理だけが状態を書く。
- `locked` の段：(1) セッションとトークンの失効と IMAP の切断、(2) 送信の保留（予約の送信を含む）、(3) 直近 7 日の転送の先・フィルター（転送・削除・既読の動作）・送信の別名・回復の手段を `suspended_pending_review`、(4) 7 日より前からの回復の手段へ知らせる、(5) 組織の `security_admin` へ知らせる。各段は冪等で、途中の停止の後に再び回す。
- `at_risk` は 7 日何もないか、本人の確かめで `normal` に戻る。`locked` から出るのは回復（[ADR-0056](0056-sign-in-risk-and-account-recovery.md)）だけ。
- 見直しで残さなかったものは 7 日で消す。
- 受信は止めない（`suspended` にしない）。

### 他の案を選ばなかった理由

- **2**：部品の間で状態が食い違い、送信は止まったが転送は動く、のような半端な状態が残る。
- **3**：本人も受信を見られず、停止の間のメールを送り手に 5xx で返すことになる。本人の回復が遅れる。

## Consequences

- 良くなること：
  - 信号の出どころによらず、同じ対応が同じ順で効く。
  - 仕込まれた転送とフィルターを、消さずに止めて本人に見せられる。
- 引き受けるコスト：
  - 本人が直近 7 日に正当に作った転送も止まる。
  - `account-risk` の出来事の経路（SNS）と、状態を書く処理の可用性を持つ。

## Confirmation

- 性質ベーステスト：PROP-ACCT-004（遷移と段の完了）。
- 結合：送信の点とサインインの危険が同時に来たとき、`locked` の段の途中の停止と再実行。
- 本番：`locked` から段の完了までの時間（p99 60 秒）を監視する。

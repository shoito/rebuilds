---
status: accepted
date: 2026-10-10
---

# ADR-0049: 時刻の仕事は、メールボックスのシャードの `timers` の表と、シャードごとの見張り（1 秒ごと、`SKIP LOCKED`）で動かす。送信の依頼は `pending → releasing → released`・`canceled` の状態の機械で、取り消しと解放は条件つきの更新で競う。予約の送信は 100 通・366 日まで。不在の返信は RFC 3834 に沿い、差出人のアドレスの HMAC ごとに 96 時間に 1 回だけ返し、設定の文を変えたら覚えを消す

詳細は [filters-forwarding-and-automation.md](../architecture/filters-forwarding-and-automation.md) の 6・7 節。

## Context

- 元に戻す送信（5・10・20・30 秒）、予約の送信（100 通、1 年）、スヌーズの起こし、不在の返信の期間の終わりは、決めた時刻に `mailstore` の操作を起こす必要がある（[architecture/README.md](../architecture/README.md) の 6 節の決定）。予約の送信の 100 通は本家に合わせる（[Schedule emails to be sent later](https://support.google.com/mail/answer/9214606)、2026-10-10 に確認）。
- NFR-002 は、窓の後から外部の MX への最初の試行まで p95 5 秒を求める。窓の解放の遅れはこの予算を食う。
- 取り消し（`undoStatus: canceled`）と解放は同時に起きうる。両方が成功すると、送ったのに下書きに戻る、または取り消したのに送られる。
- 不在の返信は、本家に合わせて同じ差出人へ 4 日に 1 回（[Send automatic replies](https://support.google.com/mail/answer/25922)、2026-10-10 に確認）。RFC 3834 は、自動のメール・メーリングリストに返さないこと、`Auto-Submitted: auto-replied` を付けることを決める。
- 時刻の仕事は、アカウントをまたいで期限の来た行を探す。テナントをまたぐ処理は [ADR-0007](0007-tenancy-accounts-orgs-and-rls.md) の一覧の経路だけにする。

## Options

時刻の仕事：

1. **シャードの `timers` の表と、シャードごとの見張り**
2. SQS の遅延のメッセージ（最大 15 分）と、長いものの再投入
3. EventBridge Scheduler の 1 件ごとの予定

## Decision

1 を採用する。

- `timers(tenant_id, account_id, timer_id, kind, due_at, ref_id, state)` を、作る操作と同じトランザクションで書く。シャードごとに 2 台の見張りが 1 秒ごとに期限の来た行を 500 行まで `FOR UPDATE SKIP LOCKED` で取り、アカウントの文脈を設定して `mailstore` の操作を呼ぶ。見張りは X4（システムの作業）のロールで動く。
- 送信の依頼：`pending`（メッセージは `SCHEDULED`）→ 見張りが `releasing`（条件 `state = pending`）→ `outbound-gate` に渡して `released`（`SENT`）。取り消しは条件 `state = pending` の更新で `canceled`（`DRAFT` に戻す）。負けたほうは何もしない。取り消しが負けたら `cannotUnsend`。
- 予約の送信は 100 通・366 日。解放の時に関門で止まったら、`SCHEDULED` のまま理由を付けて知らせる。
- 不在の返信：RFC 3834 と本家の条件（迷惑メール・自動のメール・リスト・Bcc に返さない、送り手の認証が通る）、送り手のアドレスの HMAC ごとの `last_sent_at` で 96 時間、空の `MAIL FROM`、`Auto-Submitted: auto-replied`、1 日 500 通。文・開始日を変えたら覚えを消す。

### 他の案を選ばなかった理由

- **2**：1 年先の予約は再投入の連鎖になり、取り消しで SQS のメッセージを消せない（見えない間に削除できない）。状態の正が 2 か所になる。
- **3**：1 件ごとの予定の作成と消去の費用と速さの上限が、送信の量（S1 で 1 日 300 万）に合わない。予定とメールボックスの状態を 1 つのトランザクションで書けない。

## Consequences

- 良くなること：
  - 時刻の仕事の作成・取り消しが、メールボックスの変更と同じトランザクションで決まる。
  - 解放と取り消しの競争が、条件つきの更新で 1 つの結果になる。
- 引き受けるコスト：
  - シャードごとの見張りを運用し、遅れを監視する。
  - X4 の例（保持の期限、ゴミ箱の期限、パック、GC）に、送信の解放とスヌーズの起こしが加わる。[ADR-0007](0007-tenancy-accounts-orgs-and-rls.md) の一覧に書き足すかを Dev（テックリード）が決める。
  - 不在の返信のローカル部の大文字小文字の違いは別の送り手として数える。

## Confirmation

- 性質ベーステスト：PROP-SUB-001（取り消しと解放の競争）、PROP-VAC-001（96 時間）。
- 表駆動テスト：DT-VAC-001。
- 結合：窓 5・10・20・30 秒の解放の時刻の分布（p99 2 秒）、予約の 100 通目と 101 通目、366 日の境。
- 監視：`due_at` から 30 秒を過ぎた行の数（警報）。

---
status: proposed
date: 2026-11-15
---

# ADR-0020: 速さの上限を 3 つの段の GCRA で持ち、取り消しを別に数える

## Context

板の入力の多くはマーケットメイカーの注文と取り消しで、S1 の最大は全体で 3,000 件/秒（[architecture/README.md](../architecture/README.md) の 2 節）。1 つの板の sequencer と engine は単一の書き手で、流量に上限がある（[ADR-0002](0002-sequencer-and-event-journal.md)）。

- 1 つの口座の暴走（誤った自動の売買）が、板の全部の利用者の受け付けを遅らせてはいけない（NFR-001）。
- 相場の急変で、取り消しが速さの上限で拒まれると、利用者は不利な注文を板に残したままになる。
- マーケットメイカーを MVP に入れるかは PM の判断待ち（P1）。入れるなら、個人より高い上限の段が要る。
- 本家の認証の要る REST の口は、profile ごとに 1 秒 15、瞬間 30（[Rate limits](https://docs.cdp.coinbase.com/exchange/rest-api/rate-limits)、2026-11-15 に確認）。
- 速さの上限の一般の設計（Valkey の GCRA、429 の理由の見出し）は Slack と Stripe の題材にある。

## Options

1. **段（`app`・`api_standard`・`api_mm`）ごとに、注文・取り消し・照会を別の GCRA で数え、板ごとの新しい注文の全体の上限を足す。取り消しは全体の上限にかけない**
2. 1 つの要求の数の上限（注文も取り消しも同じ枠）を口座ごとに持つ
3. 板ごとの全体の上限だけを持ち、口座ごとには持たない

## Decision

1 を採用する。

- 段の値は [order-entry-and-risk.md](../architecture/order-entry-and-risk.md) の 4.8 節の表を正とする。`api_standard` は本家の認証の要る口と同じ 1 秒 15、瞬間 30 にする。取り消しは注文の 2 倍の枠にする。
- 計数は Valkey の GCRA で、口座ごと（全キーで共有）にする（[Stripe の rate-limiting.md](../../../stripe/docs/architecture/rate-limiting.md) の 3.2 節）。
- 板ごとの新しい注文の全体の上限は 1 秒 5,000 件（S1 の最大の約 1.7 倍。`engine-latency-poc` で確かめる）。超えたら `market_busy`。取り消しはこの上限にかけない。
- 板ごとの口座の注文の数の上限（`app` 100、`api_standard` 500、`api_mm` 5,000）は `NewOrder` に載せ、エンジンが数える。
- `api_mm` の段は P1 の結論まで使わない。値の一時の引き上げは、Ops と PM の 2 人の承認と期限つきの上書きにする。
- Valkey の障害の間は、各タスクのメモリーで、段の値をタスクの数で割った上限を数える（注文を止めない）。

### 他の案を選ばなかった理由

- **2**：注文の山で取り消しの枠を使い切り、急変の時に取り消せない。
- **3**：1 つの口座の暴走で、板の全部の利用者が `market_busy` を受ける。

## Consequences

- 良くなること：
  - 1 つの口座の暴走は、その口座の段の中に閉じる。
  - 取り消しが、新しい注文の山に巻き込まれない。
- 引き受けるコスト：
  - 取り消しの山（全体の上限なし）は、sequencer と engine が受けきる前提になる。負荷試験で確かめる。
  - 段の値は推定で、P1 の結論と実際の流量で見直す。

## Confirmation

- 性質（PROP-ORD-6）：段の上限を超える注文は通らない。取り消しは全体の上限で拒まれない。
- 負荷試験：[quality.md](../quality.md) の 2.2.1 節 H で、1 つの口座が段の 10 倍を送っても、他の口座の受け付けの p99 が 20ms 以内。

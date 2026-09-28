---
status: accepted
date: 2026-09-28
---

# ADR-0034: 変更のイベントの購読はオブジェクトの view_all を要し、共有で絞らず FLS を配信の時にかける。組織が定義するイベントは型の権限で守り、既定で確定の後に発行する

詳細は [events-and-integrations.md](../architecture/events-and-integrations.md) の 4 節。

## Context

intent は、利用者が見られないレコードが変更のイベントの購読に現れないこと、FLS で見えない項目の値がどの経路でも返らないことを求める。[sharing-and-record-access.md](../architecture/sharing-and-record-access.md) の 6.4 節は、変更のイベントを「配信の時の購読者の権限で、レコードの水準と FLS を判定する」とし、詳細をこの領域に任せた。

本家（2026-09-28 に確認）：

- 変更のイベントは共有の設定を無視し、オブジェクトの全てのレコードのイベントを送る。そのかわり、購読者にそのオブジェクトの「すべて参照」（ToDo・行動と全てのオブジェクトは「すべてのデータの参照」、利用者は「すべての利用者の参照」）を求め、配信の時に確かめる。購読者が読めない項目はイベントに入れない（[Change Data Capture Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_change_data_capture.pdf)、Winter '27 版）。
- 組織が定義するイベント（プラットフォームイベント）は、「すぐに発行」（既定。トランザクションに結ばない）と「確定の後に発行」を選べる（[Platform Events Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/platform_events.pdf)、Winter '27 版）。

## Options

変更のイベントの購読：

1. **オブジェクトの `view_all`（または `view_all_data`）を要し、レコードの共有で絞らない。FLS は配信の時に購読者ごとにかける**
2. 誰でも購読でき、配信の時に購読者ごとにレコードの共有と FLS で絞る

組織が定義するイベントの発行の既定：

- a. **確定の後（`after_commit`）。API と、明示した `immediate` だけすぐに発行**
- b. すぐに発行（本家の既定）

## Decision

1 と a を採用する。

- 購読の判定は `DT-EVT-001`（`api_enabled` × チャンネル × 権限 → 結果）にする。活動とメールのチャンネルは `view_all_data`、利用者は `view_all_users`、全てとカスタムのチャンネルは含む全てのオブジェクトの権限を要する。
- 購読の時と配信の時の両方で判定する。権限の形は 60 秒だけキャッシュし、権限を失ったら接続を 403 で閉じる。
- 配信の時に、読めない項目を `fields` と `changed_fields` から落とす。積み上げ集計は [ADR-0027](0027-roll-up-summaries-incremental-with-reconciliation.md) の FLS に従う。項目が全て落ちた `UPDATE` は送らない。
- 組織が定義するイベントの型は、権限セットで `read`（購読）と `create`（発行）を持つ。項目の FLS は持たない。既定は `after_commit`。
- `system` の文脈のフローが `publish_event` でレコードの値を写す時、有効化の時に写す項目を管理者に見せて警告する。
- 2 は、配信のたびに購読者ごとの共有の判定が要り、共有の変更で見える範囲が変わったレコードの扱い（作成・削除として送るか）が決まらない。判定の誤りがそのまま外への漏えいになる。
- b は、巻き戻った保存と食い違うイベントを既定で出す。

## Consequences

- 良くなること：
  - 変更のイベントの購読者は常に全てのレコードを読めるので、レコードの判定が要らず、漏れの経路がない。
  - FLS は配信の時の権限で効く。
  - 組織のイベントが、既定で保存と食い違わない。
- 引き受けるコスト：
  - `view_all` を持てない連携は、変更のイベントを使えない。REST の問い合わせ（更新の時刻での取り出し）か、Webhook の `run_as` の利用者を分ける運用で補う。
  - 組織のイベントは項目の FLS を持たないので、写す値の扱いは管理者の設定に頼る。
  - 本家から移る組織は、組織のイベントの既定の違いに合わせる必要がある。

## Confirmation

- 決定表：`DT-EVT-001` を表駆動テストにする。
- 性質ベーステスト：任意の購読者の権限の形で、配信したイベントに読めない項目の値と名前がない。
- 結合テスト：権限を外して 60 秒以内に接続が閉じる。
- 性質ベーステスト：`after_commit` のイベントは、巻き戻ったトランザクションから出ない。

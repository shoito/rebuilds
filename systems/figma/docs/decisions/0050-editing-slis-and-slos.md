---
status: accepted
date: 2026-09-27
---

# ADR-0050: 編集の SLO は「開ける」と「確定する」の 2 つのイベントの SLI で数え、反映の遅延は合成のボットで、回復の時間は Router の記録で測る

## Context

NFR-008 は「編集（ファイルを開き、変更が確定する）の月間 99.95%、メタデータの API は 99.9%」、NFR-001 は「他の人の画面まで p99 250ms」、NFR-007 は「持ち主の障害から p95 15 秒」を求める（[architecture/README.md](../architecture/README.md) の 4 節）。

- 編集は WebSocket の上の長い接続で、HTTP の要求の成功率では数えられない。
- 1 つの Document Server の障害は、そのタスクのファイルだけを止める。時間の割合（「全体が動いていた分」）で数えると、部分的な障害が見えない。
- NFR-001 の遅延は、送り手と受け手の 2 つの端末をまたぐ。サーバーの中の時間だけでは足りない。
- 利用者の側の原因（ネットワーク、権限の拒否、不正な変更）を、SLO の失敗に数えたくない。

## Options

1. **イベントの SLI（開く試み・確定の試みごとの良い・悪い）を、サーバーの記録で数える。遅延は合成のボットで測る**
2. **時間の SLI（1 分ごとに「編集できたか」を合成の監視で判定）**
3. **クライアントの計測だけで数える**

## Decision

1 を採用する。値と一覧の正本は Ops の [runbooks/README.md](../runbooks/README.md) に置く。計測の仕組みは [observability.md](../architecture/observability.md) の 5 節。

| SLI | 良いイベント | 数える場所 | SLO（月間、S1） |
| --- | --- | --- | --- |
| `edit_open` | 有効なチケットの `Hello` から、`Welcome` を返すまでが 10 秒以内 | Gateway | 99.95% |
| `edit_commit` | 検証を通った `ChangeSet` に、2 秒以内に `Ack` を返す | Document Server | 99.95% |
| `edit_propagation` | 合成のボットの組で、送ってから相手が受け取るまで 250ms 以内 | ボット（東京の 3 AZ から） | 99%（NFR-001 の p99） |
| `owner_recovery` | 持ち主の生存が切れてから、新しい持ち主が受け付けを始めるまで 15 秒以内 | Router と Document Server の記録 | 95%（NFR-007 の p95） |
| `metadata_api` | API の 5xx でない応答 | ALB と API | 99.9% |
| `realtime_delivery` | コミットから購読者への送信まで 1 秒以内 | Realtime の edge | 99%（[comments-and-notifications.md](../architecture/comments-and-notifications.md) の 5.3 節） |

- **数えないもの**：クライアントの側の理由の失敗（チケットの期限切れ、`forbidden`、`Reject` の検証の失敗、`version_mismatch`）。ただし、`Reject` と `version_mismatch` の率は別に見て、急増は警告にする（サーバーの不具合でも起きるため）。
- **持ち主が変わる間**（`Kick(owner_changed)` から再接続まで）の確定の失敗は、`edit_commit` に数えない。代わりに `owner_recovery` で数える。二重に数えない。
- **編集の SLO は、`edit_open` と `edit_commit` の両方で守る。** 月間の「編集の可用性」は、2 つの悪いイベントの率の大きい方で報告する。
- **エラーバジェットの方針**：Slack と同じ（バジェットを使い切ったら、信頼性の作業を機能より先にする）。デプロイの前に、残りのバジェットを確かめる（[runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)）。
- **クライアントの計測**（[ADR-0049](0049-client-telemetry-without-content.md)）は、NFR-002〜005 の品質の指標として quality.md で扱い、SLO（呼び出しの対象）にはしない。端末の差が大きく、Ops が直せないものが多いため。
- 2 を採らない理由：部分的な障害（1 つのタスクのファイルだけが止まる）を拾えない。
- 3 を採らない理由：タブが閉じた・端末が眠ったなどの揺れが大きく、送られない失敗（ページが壊れた）を数えられない。

## Consequences

- 良くなること：
  - 1 つのタスク・1 つのファイルの障害も、影響した試みの数で SLO に効く。
  - 利用者の側の理由で、呼び出しが鳴らない。
- 引き受けるコスト：
  - 良い・悪いの判定の規則（数えない理由の一覧）を、Gateway と Document Server のコードで持ち、変えるときは Ops の承認を要する。
  - 合成のボットの運用（東京の 3 AZ、ボット用の組織とファイル）が要る。

## Confirmation

- 結合テスト：Document Server を 1 つ止めたとき、`owner_recovery` の記録が増え、`edit_commit` の悪いイベントが増えない（二重に数えない）。
- ダッシュボードの検査：各 SLI のバーンレートのアラームが、[observability.md](../architecture/observability.md) の 6 節の表にあり、runbook に結びついている。

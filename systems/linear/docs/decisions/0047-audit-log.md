---
status: accepted
date: 2026-09-28
---

# ADR-0047: 監査ログは、ワークスペースの監査（Aurora、1 年）とプラットフォームの監査に分け、Writer が対象の操作と同じ DB のトランザクションで書く。どちらも log-archive へハッシュの連鎖つきで写し、`sync_actions` を監査ログの代わりにしない

## Context

権限の変化（管理者の非公開のチームへの参加、ロールの変更、停止、非公開への切り替え）を監査ログに残すことが、permissions-and-teams の領域から求められている（[permissions-and-teams.md](../architecture/permissions-and-teams.md) の 13 節）。API キー・Webhook・連携・書き出し・インポートの作成と取り消し、`sync_epoch` を上げる運用の操作も、後で誰が行ったかを確かめる必要がある。監査ログの画面は、本家では Enterprise の機能で、intent も MVP の後に置く。

すべての変更は `sync_actions` に `actor_id` と `origin` 付きで残る（[ADR-0007](0007-sync-actions-and-range-proof-deltas.md)）。ただし、`sync_actions` は 30 日で消え（[ADR-0013](0013-sync-group-changes-retention-and-reset.md)）、`sync_epoch` を上げると番号の意味が変わる。サーバーだけの表（API キー、Webhook の秘密）の変更は `sync_actions` に載らない。

## Options

1. **専用の表に、Writer・各サービスが対象の操作と同じ DB のトランザクションで書く。log-archive へ写す**
2. `sync_actions` を長く持ち、監査ログとして読む
3. アプリのログ（CloudWatch Logs）から監査の行を拾う

## Decision

1 を採用する。詳細は [security.md](../architecture/security.md) の 6 節。

- ワークスペースの監査（`audit_events`）：ワークスペースの表（RLS）、日ごとのパーティション、DB に 1 年、log-archive に 3 年（既定案。法務の L5）。
- プラットフォームの監査（`platform_audit_events`）：RLS の外。運用者のアクセス、サポートの参照、`sync_epoch` を上げた操作、PITR での戻し、リーガルホールド、break-glass。log-archive に 5 年。
- 1 行は ID・時刻・主体・操作・対象・IP・利用者のエージェントのハッシュ・`detail`。`detail` に中身（タイトル・本文）を入れない。
- log-archive へは 1 時間ごとに写し、ワークスペースごとにハッシュの連鎖を付ける。Object Lock。
- 記録は MVP から取り、画面とストリームは MVP の後。
- 2 を採らない理由：`sync_actions` は変更の量で大きく、長く持つと保存とパーティションの費用が大きい。サーバーだけの表の変更が載らない。DR で番号の意味が変わる。
- 3 を採らない理由：ログの取りこぼし（非同期の送信）で監査の行を失いうる。業務のトランザクションと原子的でない。

## Consequences

- 良くなること：
  - 監査の行と対象の操作が原子的にそろう。
  - log-archive の写しで、DB の改ざん・消去の後も確かめられる。
- 引き受けるコスト：
  - 監査の対象の操作の一覧を保つ必要がある（新しい管理の操作を足す時のレビューの項目）。
  - Writer のトランザクションに行が 1 つ増える。

## Confirmation

- 結合テスト：監査の対象の操作ごとに、同じトランザクションで 1 行ができ、失敗したトランザクションでは行がない。
- log-archive のハッシュの連鎖の検証のジョブ（日次）。
- レビューの観点：DT-PERM-002 の管理の操作と、6 節の一覧の突き合わせ。

---
status: accepted
date: 2026-09-28
---

# ADR-0058: 権限を狭める操作は、Aurora に加えて、東京の中で同期して複製する追記だけの記録にも書き、大阪へ送る。大阪への昇格では、書き込みを受ける前に、失った範囲の記録をやり直す

## Context

[ADR-0050](0050-disaster-recovery-and-sync-epoch-bump.md) は、リージョンの障害で大阪へ昇格し、全ワークスペースの `sync_epoch` を上げてから書き込みを受けると決めた。NFR-007 は RPO 1 分以内を許す。失った範囲（複製の遅延ぶん）の確定は、大阪では起きなかったことになる。

失った範囲に、権限を狭める操作が入っていると、次のことが起きる。

- 停止・除外したメンバー、非公開にしたチームのメンバーでない人、チームから外した人の購読（`SyncSubscription`）が、大阪で元に戻る。`sync_epoch` のやり直しのブートストラップで、その人の端末へ、見てよくなくなったデータがまた届く（NFR-008 の破れ）。
- 取り消したセッション・API キー・OAuth のトークンが、大阪でまた使える。

[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の B の 6.4 は、これを「アプリのログから操作を探し、管理者にやり直しを依頼する」としていた。人の手で、しかも書き込みを受けた後に行うので、その間は漏れる。

Auth0 の題材は、失った範囲のセキュリティを強める操作を、log-archive の監査ログと認証のイベントから、受け付けの再開の前にやり直す（Auth0 の ADR-0060）。この題材の監査ログ（[ADR-0047](0047-audit-log.md)）は log-archive へ 1 時間ごとに写すので、直近の 1 分を取り出すには使えない。

## Options

1. **権限を狭める操作を、Aurora のトランザクションに加えて、東京の中で同期して複製する追記だけの記録（DynamoDB のグローバルテーブル）にも書き、大阪へ送る。昇格の後、`sync_epoch` を上げた後で、書き込みを受ける前に、失った範囲の記録をやり直す**
2. Auth0 と同じく、log-archive の監査ログからやり直す
3. 権限を狭める操作だけ、Aurora の大阪への複製がそのコミットを越えるまで待ってから完了を返す
4. 今の runbook のまま、管理者に一覧を示してやり直しを依頼する

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 6.3 節、手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の B。

### 対象の操作

| 種類 | 操作 |
| --- | --- |
| `member_suspend` | メンバーの停止（`User.status = suspended`）、ワークスペースからの除外、アカウントの削除による停止 |
| `role_downgrade` | ロールの引き下げ（`owner`・`admin` → `member`、`member` → `guest`） |
| `team_private` | 公開のチームを非公開にする |
| `team_leave` | チームのメンバーシップの削除（非公開のチーム、ゲストの公開のチーム） |
| `session_revoke` | セッションの取り消し、全部の端末からのログアウト、遠隔の消去（`wipe_requested`） |
| `credential_revoke` | API キーの取り消し、OAuth の認可・トークンの取り消し、OAuth のアプリの削除、Webhook の停止・削除、連携のインストールの削除 |
| `access_restrict` | ログインの手段の制限を狭める、許可したドメインの削除、招待・招待のリンクの取り消し、ワークスペースの削除の依頼（`pending_deletion`） |

- どれが対象かは、`packages/policy` の中の 1 つの一覧で決める（[ADR-0032](0032-single-policy-module-and-group-mapping.md)）。Writer と認証のサービスは、その一覧に当たる操作を確定したときに記録を書く。
- 権限を広げる操作（参加、戻し、公開への切り替え）は記録しない。失った範囲の広げる操作は失われたままにする（安全側）。

### 記録

- 置き場所：DynamoDB の表 `narrowing_journal`（東京、オンデマンド、PITR）。大阪をレプリカにしたグローバルテーブルにする。
- 項目：`pk = workspace_id`、`sk = <committed_at>#<client_tx_id>`、`kind`、`target`（ID だけ）、`ops`（やり直す操作。ID と列挙の値だけで、中身を持たない）、`actor`、`sync_id`。35 日の TTL（バックアップと同じ）。
- 追記だけ：書き手のロールには、条件付きの `PutItem`（`attribute_not_exists(sk)`）だけを許し、`UpdateItem`・`DeleteItem` を許さない。
- 書く順：Writer は、対象の操作を含むトランザクションで、サーバーだけの表 `narrowing_outbox` に同じ内容の行を書いてコミットする。コミットの後、ack を返す前に `narrowing_journal` へ書き、`narrowing_outbox.shipped_at` を埋める。書けなければ ack はそのまま返し、Relay が 1 秒ごとに残りを送る。認証のサービスのセッションの取り消しも、同じ 2 段で書く。
- 東京の中の複製：DynamoDB は、200 の応答の時点で書き込みを永続化しており、リージョンの中の 3 つの AZ に複製する（[DynamoDB read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html)、[Resilience and disaster recovery in Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/disaster-recovery-resiliency.html)、2026-09-28 に確認）。大阪への複製は非同期（既定の MREC）で、ふつう 1 秒以内に届く（同じ文書）。遅延を `ReplicationLatency` で見る。

### やり直し

- 大阪への昇格のワークフロー（ADR-0050）の順を、次のようにする。
  1. 東京の書き込みを止める。2. 大阪の二次を昇格する。3. 古い一次のスナップショットを保全する。4. 全ワークスペースの `sync_epoch` を上げる。**5. 失った範囲の記録をやり直す。** 6. 大阪の Sync API と reader を広げる。7. 入口を大阪へ。8. `ops.writes_enabled` を開く。
- 5 の範囲：大阪の `narrowing_journal` のうち、`committed_at` が「東京が応答しなくなった時刻 − 直近の `AuroraGlobalDBRPOLag` − 5 分」より後のもの。
- 各項目について、大阪の `tx_results` にその `client_tx_id` があれば済み（複製で届いていた）とし、なければ `ops` を Writer のシステムのトランザクション（`actor = system`、`origin = worker`、履歴に `{k: "auto", rule: "dr_replay"}`）で当てる。セッション・トークンの取り消しは、`platform` のロールで該当の表に当てる。`committed_at` の順に当て、何度走らせても同じ結果になる。
- やり直しのジョブは `ops.writes_enabled = false` の間に、専用の許可（`ops.dr_replay_mode`）で Writer を通す。利用者の書き込みはまだ受けない。
- やり直した件数と、やり直せなかった件数（参照先が大阪にない、など）をプラットフォームの監査に残し、該当のワークスペースの管理者に知らせる。
- 同じやり直しを、1 つのワークスペースを時点へ戻す差し替え（disaster-recovery.md の D）でも行う。戻す時点より後の、そのワークスペースの記録が対象になる。

- 2 を採らない理由：監査ログは 1 時間ごとに log-archive へ写し、S3 のレプリケーションも非同期なので、直近の 1 分を取り出せない。監査ログを同期で写すと、全部の監査の書き込みが遅くなる。
- 3 を採らない理由：大阪の複製の位置（`highest_lsn_written`）は `aurora_global_db_status()` で読めるが（[aurora_global_db_status](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora_global_db_status.html)、2026-09-28 に確認）、トランザクションのコミットの LSN をそれと比べられるかは**未検証**で（Auth0 の ADR-0060 と同じ問題）、複製が遅れている間、停止・取り消しが終わらない。停止は急ぐ操作なので、完了を遅らせたくない。
- 4 を採らない理由：人の手で探す間、書き込みを受け、除外した人の端末にデータが届く。漏れの窓が数十分から数時間になる。

## Consequences

- 良くなること：
  - 権限を狭める操作が失われる窓が、Aurora の RPO（1 分以内）から、DynamoDB の大阪への複製の遅延（ふつう 1 秒以内。AWS の文書）と、コミットから記録までの数ミリ秒に縮む。
  - やり直しが受け付けの再開の前に終わるので、やり直しのブートストラップが正しい購読で行われる。
- 引き受けるコスト：
  - DynamoDB という部品が 1 つ増える（他の題材では Figma が使っている）。狭める操作は 1 秒に数件の見込みで、費用は小さい。
  - 対象の操作の ack が、DynamoDB の書き込みの分（数ミリ秒）遅れる。
  - 失った範囲の広げる操作と、狭める操作以外の変更は、これまでどおり失われうる（RPO の範囲）。
  - 対象の操作の一覧を保守する必要がある。新しい権限の操作を足すときに、一覧に入れ忘れる危うさがある。

## Confirmation

- ワークフローの試験：5 のやり直しが終わる前に `ops.writes_enabled` を開けない、入口を切り替えられない。
- シミュレーター（[ADR-0010](0010-deterministic-sync-simulator.md)）：PROP-DR-001（DR の切り替えで最後の k 件を失っても、失った範囲の狭める操作は大阪で効いており、対象の人の手元に見てよくない行が残らない）。
- DR の訓練（staging、四半期）：切り替えの直前の 10 秒に、停止・非公開への切り替え・API キーの取り消しを入れ、昇格の後に、停止した人の端末へ何も届かない（配信の監査と `orphan_rows` が 0）、取り消したキーが使えないことを確かめる。
- lint：`packages/policy` の権限の操作の一覧に、狭める操作かどうかの印のない操作があれば失敗させる。
- 本番：`narrowing_outbox` の送っていない最古の行が 5 秒、`narrowing_journal` の `ReplicationLatency` が 10 秒を超えたら呼び出す。

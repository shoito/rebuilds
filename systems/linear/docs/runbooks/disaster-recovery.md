# Runbook: 災害復旧（AZ の障害、リージョンの障害と `sync_epoch` の引き上げ、ワークスペースの戻し、訓練）

- Owner: Ops
- 対応するアラート: AZ の障害（複数のサービスで 1 つの AZ のターゲットが不健全）、大阪からの合成監視の連続失敗、`AuroraGlobalDBRPOLag` の超過、`narrowing_journal` の複製の遅れ・送り残し、大阪の待機の構成の異常、訓練（staging 四半期、本番の switchover 年 1 回）
- 最終確認日: 2026-09-28

構成と目標は [infrastructure.md](../architecture/infrastructure.md) の 6 節、方針は [ADR-0050](../decisions/0050-disaster-recovery-and-sync-epoch-bump.md)、[ADR-0013](../decisions/0013-sync-group-changes-retention-and-reset.md)、[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md) にある。目標は NFR-007（AZ：RPO 0・RTO 5 分、リージョン：RPO 1 分・RTO 1 時間）。

**最重要の規則：DB の中身を戻す・切り替える操作の後は、該当のワークスペースの `sync_epoch` を上げるまで、書き込みを受けない。** 上げずに書き込みを受けると、同じ `sync_id` に違う変更が振られ、クライアントが「同じ番号で違う中身」を持ち続ける（NFR-005 の破れ）。switchover（RPO 0）と、Writer のトランザクションでの行の戻しだけは、番号が保たれるので上げない。

## 症状

| 場面 | 見え方 |
| --- | --- |
| A. AZ の障害 | 1 つの AZ のタスク・Aurora のインスタンス・Valkey のノードが不健全。Gateway の接続が 3 分の 1 切れる |
| B. リージョンの障害 | 東京の Sync API・Gateway・公開 API が応答しない。大阪からの合成監視は大阪の ALB へ成功し、東京へは失敗 |
| C. 複製の遅延 | `AuroraGlobalDBRPOLag` が 10 秒を超え続ける、または `narrowing_journal` の `ReplicationLatency` が 10 秒・`narrowing_outbox` の送り残しが 5 秒を超える（東京は正常） |
| D. ワークスペースの戻しの依頼 | 顧客の誤りの大量の削除、誤った一括の変更で、ゴミ箱と Undo で戻せないもの |
| E. 訓練 | 計画 |

## 影響

- A：数十秒、書き込みが `retry` になる。クライアントは手元で読み書きを続け、outbox に貯める。コミット済みを失わない。
- B：切り替えまで（目標 1 時間以内）、送信・差分・ブートストラップ・公開 API・Webhook・連携が止まる。**クライアントは手元で読み書きを続ける**（NFR-006）。切り替えの後、複製の遅延ぶん（RPO 1 分以内）の確定を失う。
  - 失った範囲の自分の変更で、確定から 15 分以内のもの（outbox の `done`）は、`sync_epoch` のやり直しで送り直され、1 回だけ当たる。それより古い確定は失われる。
  - 失った範囲の権限を狭める操作（停止、除外、ロールの引き下げ、非公開への切り替え、脱退、セッション・キー・トークンの取り消し、ログインの制限の強化）は、`narrowing_journal` から、書き込みを受ける前にやり直す（ADR-0058）。権限を広げる操作（参加、戻し、公開への切り替え）は失われたままになる。
  - 失った範囲で送った Webhook・メール・Slack・PR のコメントは取り消せない。送り直しで再び確定した変更は、Webhook が新しい `syncId` で再び送られる。
  - 切り替えの後、全端末がやり直しのブートストラップをする（散らしの間は、古い手元のデータを読み取りの専用で見せ、書き込みは outbox に入る）。
  - 検索は最大 4 時間、サーバーの検索が止まり、手元の検索だけになる。
- D：そのワークスペースの全端末がやり直しのブートストラップをする。

## 確認

1. AWS Health Dashboard と Grafana の AZ ごとの内訳で、1 つの AZ か、リージョン全体かを見分ける。
2. Aurora のクラスタのイベントで、フェイルオーバーの有無と、今の writer の AZ を確かめる。
3. リージョンの障害を疑うときは、大阪の合成監視と、別の回線からの到達性の両方で確かめる。
4. **`AuroraGlobalDBRPOLag` の直近の値と、東京が応答しなくなった時刻を記録する。** 失った範囲の目安になる（連携の読み直しで使う）。
5. 大阪の待機の構成（[infrastructure.md](../architecture/infrastructure.md) の 6.5 節）が直近の確認で正常か。

## 対処

### A. AZ の障害

基本は自動で回復する。

1. インシデントを宣言する（SEV2 から。[incident-response.md](incident-response.md)）。
2. Aurora が別の AZ へ自動でフェイルオーバーしたことを確かめる。5 分たっても writer がなければ、手動でフェイルオーバーする。**`sync_epoch` は上げない**（コミット済みを失わないので番号は保たれる）。
3. Gateway が残る 2 AZ で再接続を受けているか（1 タスク 5,000 接続まで）、オートスケールが追いつくかを見る。`hello` の受け付けの上限で `overloaded` が続くなら、`retry_after_ms` を上げる（[capacity.md](../architecture/capacity.md) の 3.3 節）。
4. Valkey のレプリカの昇格を確かめる。その間、Gateway は reader から欠けを埋める。
5. AZ が回復したら、台数を平常に戻す。

### B. リージョンの障害（東京 → 大阪）

**切り替えの判断は、インシデントの指揮者（IC）が行い、Ops の責任者が承認する。** AWS の見込みで 30 分以内に回復しそうなら、待つことも選ぶ（クライアントは手元で作業を続けられ、待てばデータを失わず、全端末のやり直しも起きない）。

1. SEV1 を宣言し、顧客へ告知する（ステータスページ）：「手元での作業は続けられます。つながったら送られます」。
2. **東京への書き込みを止める。** 東京に届くなら `ops.writes_enabled = false`（東京）。届かなくても次へ進む（write fencing は最善努力）。
3. **失った範囲を記録する**（「確認」の 4）。
4. **「DR：大阪を有効化」のワークフローを大阪で起動する。** ワークフローは次を順に行う。途中で止まったら、止まった段から手で続ける。
   1. 大阪の Writer が `ops.writes_enabled = false` で待っていることを確かめる。
   2. Aurora の二次を昇格させる。東京の writer が生きていれば switchover（RPO 0。この場合、**7〜9 の `sync_epoch` の引き上げとやり直しは行わない**）、応答しなければ `aws rds failover-global-cluster --allow-data-loss`（大阪で実行）。RDS のイベントで write fencing の成否を確かめる。
   3. 古い一次の障害の時点のスナップショット（`rds:unplanned-global-failover-…`）があれば、手動のスナップショットにコピーして保全する。
   4. 大阪の reader を 5 台に、Sync API を 60 タスクに、Gateway を東京と同じ最小に広げる（[capacity.md](../architecture/capacity.md) の 4.2 節）。reader の追加に 10〜15 分かかる見込み（未検証）。
   5. `ops.epoch_reset_spread_min` を決める。reader が 5 台そろっていれば 10 分（既定）、そろっていなければ 30 分。
   6. 空の SQS と Valkey を確かめる。Relay の区画の担当が大阪で取れることを確かめる。
   7. **全ワークスペースの `sync_epoch` を 1 つ上げる**（`platform` のロールのジョブ。ワークスペースの ID の範囲ごと。プラットフォームの監査に残る）。ジョブの完了（全ワークスペースの件数の一致）を確かめる。
   8. 上げた件数と、`workspace_sync` の `sync_epoch` の分布（全部が +1）を確かめる。
   9. **失った範囲の権限を狭める操作をやり直す**（ADR-0058）。「DR：狭める操作のやり直し」のジョブに、失った範囲の開始（「確認」の 4 の時刻 − 直近の `AuroraGlobalDBRPOLag` − 5 分）を渡す。ジョブは `ops.dr_replay_mode = true` の Writer で、大阪の `narrowing_journal` のうち範囲の記録を `committed_at` の順に、大阪の `tx_results` になければ当てる。完了の後、やり直した件数・済みの件数・やり直せなかった件数を確かめ、`ops.dr_replay_mode = false` に戻す。やり直せなかった件数が 0 でなければ、一覧をインシデントの記録に残し、Dev のテックリードに渡す。**ここまで終わるまで 10 に進まない。**
   10. `global/edge` の変数 `active_region` を大阪にして apply する（CloudFront のオリジンを大阪の ALB に）。
   11. `ops.writes_enabled = true`（大阪）。
5. **受け付けを見る。**
   1. 合成監視（伝播、起動、公開 API、Webhook）が大阪で成功することを確かめる。
   2. やり直しのブートストラップ（理由 `epoch`）の件数、Sync API の `429`、reader の CPU を見る。散らしの幅の中に収まるかを見て、足りなければ `ops.epoch_reset_spread_min` を伸ばす。
   3. 送り直しの集中（`client` の書き込み、`tx_results` での重複の返し）を見る。1 ワークスペースのロックの待ちが伸びたら、`ops.write_budget.*` で `client` 以外を絞る。
   4. 収束の監査で、合成監視のクライアントが一致すること（`unexplained` 0）を確かめる。
6. **外の部品を戻す。**
   1. 検索：大阪で最新の OpenSearch のスナップショットからドメインを作り、戻す（Terraform の `regional/data` の大阪の変数）。戻ったら数え直し（[search.md](../architecture/search.md) の 9.4 節）を全ワークスペースで流し、`ops.search_enabled = true`。目標 4 時間。
   2. 連携：失った範囲の開始の時刻（「確認」の 4 の時刻 − 複製の遅延 − 5 分）から後に更新された PR を読み直す（[integrations.md](../architecture/integrations.md) の 7.2 節）。
   3. Webhook：送りの予定（`webhook_deliveries`）の失った範囲の分は作り直さない。受け手には重複と欠けがありうることを告知に含める。
   4. **権限を狭める操作**：4 の 9 でやり直した。やり直した件数を、該当のワークスペースの管理者に知らせる。失った範囲の権限を広げる操作（参加、戻し、公開への切り替え、招待）は失われたので、やり直しを依頼する。`narrowing_journal` の大阪への複製の遅延（「確認」の 4 の時刻の `ReplicationLatency`）の分は取りこぼしうる。その間の狭める操作の要求を、Gateway・Public API・認証のアプリのログ（CloudWatch Logs は東京。読めなければ log-archive）で探し、見つかれば同じジョブで当てる。
7. 顧客へ、再開と影響（直近の変更の一部が失われうること、Webhook の重複、検索の再開の時刻）を告知する。

**東京へ戻す（フェイルバック）**：東京の回復の後、Aurora が東京を二次として加え直す。複製が追いついたら、別の計画作業として switchover（RPO 0）で戻す。**switchover では `sync_epoch` を上げない。** 急がない。

### C. 複製の遅延

1. 東京の writer の書き込みの量（インポート、一括の編集）と、大阪の二次の状態を確かめる。
2. インポートが原因なら `ops.write_budget.import` を下げる。
3. 30 分続くなら、AWS のサポートに問い合わせる。この間にリージョンの障害が起きると失う範囲が広がることを、IC に伝える。
4. `narrowing_journal` の送り残し（`narrowing_outbox` の `shipped_at` が空の行）が増えているなら、Relay の送り直しと DynamoDB の書き込みのエラー（スロットリング、権限）を確かめる。`ReplicationLatency` が高いなら、DynamoDB のグローバルテーブルの状態を確かめ、AWS のサポートに問い合わせる。この間の停止・取り消しは、リージョンの障害で失われうることを IC に伝える。

### D. ワークスペースの戻し

**まず、差し替えでなく、Writer のトランザクションで戻せないかを考える**（番号が前へ進むだけなので `sync_epoch` を上げずに済み、端末のやり直しも起きない）。

1. 依頼の範囲（ワークスペース、時点、対象）を、依頼したオーナーと書面で確かめる。プラットフォームの監査に残す。
2. PITR で隔離した VPC に新しいクラスタを戻す（本番のクラスタを上書きしない）。
3. **Writer で戻す方式**（推奨）：戻すべき行の差を、戻したクラスタと本番から作り、Worker のシステムのトランザクション（`origin = worker`、`actor = system`、枠の中）で当てる。履歴に `{k: "auto", rule: "restore"}` を残す。`sync_epoch` は上げない。
4. **差し替えの方式**（3 ができない時。例：`sync_actions` を含めて時点へ戻す必要がある）：
   1. そのワークスペースを `workspaces.status = moving` にして書き込みを止める（Writer は `retry`）。
   2. そのワークスペースの行を、戻したクラスタの行で差し替える（`platform` のロールのジョブ）。
   3. **そのワークスペースの `sync_epoch` を上げる。** 上げるまで `moving` を外さない。
   4. 戻す時点より後の、そのワークスペースの `narrowing_journal` の記録をやり直す（B の 4 の 9 と同じジョブに、ワークスペースと時点を渡す。ADR-0058）。
   5. `moving` を外す。そのワークスペースの全端末がやり直しになる。端末の outbox の確定から 15 分以内のものは送り直され、差し替えの時点より後の変更として当たる（依頼の意図と合うかを、依頼者に先に説明する）。
5. 検索の索引を、そのワークスペースだけ作り直す（`search-reindex.md`）。

### E. 訓練

| 訓練 | 頻度 | 合格 |
| --- | --- | --- |
| B の計画外の切り替え（staging。東京の Aurora を止めて `--allow-data-loss`。止める直前の 10 秒に、停止・非公開への切り替え・API キーの取り消しを入れる） | 四半期 | 1 時間以内に大阪で受け付け、`sync_epoch` を上げて狭める操作をやり直す前に書き込みを受けていない、停止した人・メンバーでない人の端末へ何も届かない（配信の監査と `orphan_rows` が 0）、取り消したキーが使えない、合成監視のクライアントが一致、直近の確定の送り直しが 1 回だけ当たる、検索が 4 時間以内に戻る |
| B の switchover（本番） | 年 1 回 | RPO 0、`sync_epoch` を上げない、端末のやり直しが起きない |
| D のワークスペースの差し替え（staging） | 半年 | 端末が一致、outbox の送り直しが 1 回 |

## エスカレーション

- B の判断は IC と Ops の責任者。30 分で判断がつかなければ、Dev のテックリードと PM を加える。
- `sync_epoch` の引き上げ、または狭める操作のやり直しのジョブが失敗・途中で止まった：大阪の書き込みを開けずに、Dev のテックリードを呼ぶ。
- 切り替えの後に収束の監査の `unexplained` が出た：SEV1 のまま、[incident-response.md](incident-response.md) の「収束の不一致」を並行で進める。
- 個人データの漏えい等に当たる可能性（切り替えで権限の変更が失われ、除外した人に再びデータが届いた、など）：法務へ（[security.md](../architecture/security.md) の 12 節）。

## 事後

- 失った範囲、送り直しで回復した件数、やり直しの件数と時間、検索の再開の時間を記録する。
- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- この手順で足りなかったことを、ここに反映する。特に、reader の追加の時間と散らしの幅の実績を [capacity.md](../architecture/capacity.md) に返す。

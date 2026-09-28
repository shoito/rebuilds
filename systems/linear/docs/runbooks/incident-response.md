# Runbook: インシデントへの対応（伝播の遅れ、収束の不一致、非公開のチームの漏えい、端末の保存の消去）

- Owner: Ops
- 対応するアラート: 書き込みの経路の SLO のバーンレート、伝播の遅れ、差分の配信の停止、Relay の遅れ、収束の不一致、非公開のチームの漏えいの疑い（配信の監査、`orphan_rows`、`subscription_drift`）、端末の保存の消去の増加、秘密の出力の検出、監査ログのハッシュの連鎖の失敗、および個別の runbook のない呼び出しのアラート全部（[observability.md](../architecture/observability.md) の 5.4 節）
- 最終確認日: 2026-09-28

## 共通の進め方

| 重さ | 目安 | 例 |
| --- | --- | --- |
| SEV1 | 多くのワークスペースで送信・差分が止まる。非公開のチーム・ワークスペースをまたぐ漏えいの疑い。outbox の喪失が広く起きる | 差分の配信の停止、配信の監査の不一致 |
| SEV2 | 一部のワークスペース・端末で、SLO を大きく消費。収束の不一致。秘密の出力 | 伝播の遅れ、`unexplained` の不一致 |
| SEV3 | 利用者の影響が小さい・迂回できる | 端末の保存の消去の増加（1 つのブラウザの版） |

1. インシデントの指揮者（IC）を決め、チャンネルを作り、時刻を記録し始める。
2. 影響の範囲（ワークスペースの数、端末の数、経路）を決める。**利用者は手元で作業を続けられるか**（サーバーの障害は、手元の読み書きを止めない）を先に確かめ、告知に書く。
3. 直前の変更（サーバーのデプロイ、Web・Electron の段階、フラグ、マイグレーション）を確かめる。疑わしければ [deploy-and-rollback.md](deploy-and-rollback.md) で戻す。
4. 被害を止める → 原因を取り除く → 回復を確かめる、の順に進める。
5. 顧客への告知はステータスページで。漏えいの疑いは、法務と相談してから文面を決める。

## 場面 1：伝播の遅れ

### 症状

合成監視の伝播 p99 が 3 秒を超える、RUM の確定から適用の p99 が 2 秒を超える、差分の配信の停止（10 秒を超える）、Relay の遅れ（`sync_outbox` の最古が 5 秒）。

### 影響

他の人の変更が画面に遅れて出る（NFR-002）。送信の確定（ack）は届くので、自分の変更は失わない。遅れの間に同じフィールドを変えると、上書きが増える（履歴に残る）。

### 確認

区間ごとのヒストグラム（[observability.md](../architecture/observability.md) の 3.3 節、予算は [sync-engine.md](../architecture/sync-engine.md) の 7.6 節）で、どこで遅れているかを見る。

| 遅れている区間 | 疑うもの | 見るもの |
| --- | --- | --- |
| コミット → Relay | Relay の停止、区画の担当の取りこぼし、`LISTEN/NOTIFY` の停止、Aurora の負荷 | Relay のタスク、`relay:lease:*`、`sync_outbox` の滞留 |
| Relay → Gateway | Valkey の障害・遅れ、pub/sub の溢れ | Valkey の CPU・ネットワーク、`PUBLISH` の失敗 |
| Gateway の欠けの埋め | reader の複製の遅れ、Valkey のメッセージの喪失 | reader の `ReplicaLag`、欠けの埋めの回数 |
| Gateway → クライアント | Gateway の CPU・送信の待ち、`resync_required` の多発、CloudFront | Gateway のタスクあたりの接続と送信、送信の待ちの大きさ |
| クライアントの保存と適用 | クライアントの版の不具合、IndexedDB の遅さ | RUM の `build` の別 |
| 送信から ack も遅い | Writer・ロックの待ち（1 ワークスペースか全体か） | `top_workspace_lockwait`、Writer の CPU、Aurora の writer |

### 対処

1. Relay：担当のない区画があれば、Relay のタスクを入れ替える。Valkey が落ちていれば、DB の勧告的ロックでの担当に切り替わっているかを見る。
2. Valkey：障害なら、Gateway は reader から欠けを埋め続ける（遅いが正しい）。回復を待つ。
3. Gateway の過負荷：タスクを増やす。1 つの大きなワークスペースの送信が原因なら、そのワークスペースの接続が散っているかを見る。
4. 1 つのワークスペースのロックの待ち：`ops.write_budget.<origin>` でそのワークスペースの `api`・`notifier`・`worker`・`import` を絞る。インポートなら `paused` にする（`writer-lock-contention.md`、`import-degrades-workspace.md`）。
5. 全体の Writer・Aurora：Writer の CPU なら増やす。Aurora の writer なら、重い問い合わせ（Worker の一括、書き出し）を止める（`ops.*` のフラグ）。
6. 直前のリリースが原因なら戻す（[deploy-and-rollback.md](deploy-and-rollback.md)）。

### 回復の確かめ

合成監視の伝播 p99 が 1 秒以内に 30 分戻り、`sync_outbox` の滞留が 0。遅れの間に `resync_required`・取り戻しが増えたクライアントが、再び `resume` になっている。

## 場面 2：収束の不一致

### 症状

収束の監査で `unexplained` が 1 件以上（[observability.md](../architecture/observability.md) の 4.3 節）。または、利用者から「再読み込みで表示が変わった」の報告が続く。

### 影響

その端末の画面が、サーバーと違う状態を見せ続けている（NFR-005）。利用者は気づかないまま、古い値の上で作業しうる。

### 確認

1. `convergence_mismatches` から、ワークスペース・モデル・行の ID・端末の版（`build`・`schema_hash`）・`L` を読む。中身は見ない（必要なら、運用者のアクセスの規則で、サポートの参照の許しを得てから。[security.md](../architecture/security.md) の 8 節）。
2. 版で偏っているか（特定のクライアントの版だけか）、モデルで偏っているか、ワークスペースで偏っているか。
3. その行の `sync_actions` を `L` の前後で読み（行の ID と `sync_id` と `changed`、`origin`）、直前に何が起きたか（移動、グループの変化、並びの振り直し、派生、インポート、DR）を見る。
4. 端末の報告（2 段目の `(id, _u, 行のハッシュ)`）で、`_u` が合っていて中身が違うのか（当て方の誤り・正準形の違い）、`_u` から違うのか（差分の欠け・範囲の証明の誤り）を見分ける。

### 対処

1. 該当の端末に `resync_required` を送り、正す（監査が自動で行う。行われていなければ手で）。
2. 版で偏っていれば、その版の段階を止める（[deploy-and-rollback.md](deploy-and-rollback.md) の B・C）。
3. 範囲の証明・欠けの検出の誤りが疑われる（`_u` から違う）ときは SEV2 のまま、Dev のテックリードを呼ぶ。同じワークスペースの他の端末も抜き取りを増やす（そのワークスペースの監査の割合を一時に 100% にする）。
4. シミュレーターで再現を試み、再現した種を `sim/regressions/` に足す（`convergence-mismatch.md`）。
5. 広く起きていて止められない場合の最後の手段：影響のワークスペースの `sync_epoch` を上げ、全端末をやり直させる（プラットフォームの監査に残す。やり直しの負荷は [capacity.md](../architecture/capacity.md) の 4.2 節）。

### 回復の確かめ

該当の端末の再監査が `match`。同じ原因の新しい `unexplained` が 24 時間出ない。

## 場面 3：非公開のチームの漏えいの疑い

### 症状

配信の監査で、購読と交わらない行を送った・読ませた記録（[observability.md](../architecture/observability.md) の 4.4 節）。端末の `orphan_rows` が 0 でない（脱退の直後を除く）。`subscription_drift` が見てよくない方向にずれた。検索・Webhook・書き出し・通知・Slack・PR のコメントで、見てよくない中身が出たという報告。

### 影響

非公開のチーム・他のワークスペースのデータが、見てよくない人の端末（IndexedDB）や外の宛先に届いた可能性（NFR-008）。**画面に出ていなくても、端末に残れば漏えいとして扱う**（[security.md](../architecture/security.md) の 12 節）。

### 確認

1. SEV1 の候補として IC を立て、セキュリティの担当と法務に知らせる（漏えい等の報告の要否の判断のため。法務の L1）。
2. 経路を決める：差分（Gateway）、ブートストラップ・取り戻し・遅延の読み込み（Sync API）、検索、公開 API、Webhook、書き出し、通知（メール・Slack）、連携（Slack の展開、PR のコメント）。
3. 配信の監査の記録から、影響の組（行の ID、接続・端末の ID、利用者の ID、時刻）を集める。抜き取りは 1% なので、見つかった組から、同じ条件（同じ Gateway の版、同じグループの変化）の範囲を推定する。
4. 購読の状態：`sync_subscriptions` と `groupsFor` の差（`subscription_drift` のジョブを手で流す）。

### 対処

1. **止める。**
   - 原因の版が分かれば戻す（[deploy-and-rollback.md](deploy-and-rollback.md)）。分からなければ、原因の経路を止める：検索は `ops.search_enabled = false`、Webhook は `ops.webhooks_enabled = false`、連携は `ops.integrations.<provider> = false`。差分・ブートストラップの誤りで止める手段がない場合は、影響のワークスペースの書き込みと接続を止めることを IC が判断する。
   - 購読のずれは、Writer のシステムのトランザクションで直す（`subscription-drift-repair.md`）。
2. **端末から消す。** 影響の利用者の接続に `kick: forbidden`（ワークスペースから外れていない場合も）を送らず、まず握手をやり直させる（`resync_required`）。握手の `welcome.groups` との差で、手元の見てよくない行が消える（[bootstrap-and-partial-sync.md](../architecture/bootstrap-and-partial-sync.md) の 7.5 節）。`sync_epoch` を上げずに該当の人だけを消す方法である。消えたかを、その端末の次の監査の `orphan_rows` で確かめる。オフラインの端末は、つながった時に消える。届いた端末の ID の一覧と、消えたことを確かめた時刻を記録する。
3. **外に出たもの**（Webhook の宛先、Slack、メール、PR のコメント）は取り消せない。宛先と中身の種類を記録し、法務に渡す。Slack のメッセージは、ボットのトークンで消せるものを消す。
4. 原因を直し、性質ベーステスト（PROP-SYNC-004、PROP-PERM-002 ほか。[security.md](../architecture/security.md) の 10 節）に、見つかった場面の種を足す。

### 回復の確かめ

配信の監査の不一致が 0 に戻り、影響の端末の `orphan_rows` が 0、`subscription_drift` が 0。法務への報告の要否の判断が記録されている。

## 場面 4：端末の保存の消去

### 症状

`lost_local`（ブラウザに消された未送信）と `corrupt` のやり直しが平常の 3 倍（[observability.md](../architecture/observability.md) の 5.3 節）。利用者から「オフラインの変更が消えた」の報告。

### 影響

ブラウザが IndexedDB を消すと、未送信の outbox が失われ、取り戻せない（中身はサーバーにない）。NFR-004 の保証の外（ADR-0005）だが、利用者には喪失に見える。

### 確認

1. ブラウザの系統と版、OS、`persist()` の結果（認められていたか）、`usage/quota` の帯で偏りを見る。
2. Safari の 7 日の消去、ブラウザの版の更新、ストレージの圧迫（端末の空き）のどれか。
3. 本システムの版で偏っていれば、手元の保存の不具合（移行の誤り、`QuotaExceededError` の扱い、退かしが outbox に触れた）を疑う。この場合は場面 4 ではなく、outbox の喪失として SEV2 に上げる（退かしは outbox に触れないはず。PROP-STORE-005）。

### 対処

1. ブラウザの側の原因なら：
   - 影響の利用者に、画面の知らせ（「ブラウザにより n 件が消去されました」）が出ているかを確かめる（[client-store-and-offline.md](../architecture/client-store-and-offline.md) の 9.3 節）。
   - サポートの案内（Electron の利用、永続の保存の許可、ブラウザの設定）を出す（`client-storage-eviction.md`）。
   - 特定のブラウザの版の既知の問題なら、その版の利用者に、画面で Electron を強く勧める表示を出すフラグを入れる。
2. 本システムの原因なら：その版の段階を止め（[deploy-and-rollback.md](deploy-and-rollback.md) の B）、修正を前へ出す。
3. 喪失の件数（端末ごと）を記録する。

### 回復の確かめ

`lost_local`・`corrupt` が平常に戻る。本システムの原因だった場合は、オフラインの 3 つの場面の試験に再現の場面を足した。

## 場面 5：その他

| アラート | 最初の手 |
| --- | --- |
| 書き込みの経路の SLO のバーンレート | 場面 1 の「送信から ack も遅い」の行、Aurora のフェイルオーバーの有無（[disaster-recovery.md](disaster-recovery.md) の A） |
| 秘密の出力の検出 | 出力したログのグループのアクセスを止め、該当の秘密を取り消し・入れ替え（`leaked-token-response.md`）、出力のコードを直す。SEV2 |
| 監査ログのハッシュの連鎖の失敗 | log-archive の写しと DB を比べ、改ざんか写しの誤りかを見分ける。セキュリティの担当を呼ぶ。SEV2 |

## エスカレーション

| 状況 | 連絡先 |
| --- | --- |
| SEV1、または 30 分で被害を止められない SEV2 | Ops の責任者、Dev のテックリード |
| 漏えいの疑い（場面 3）、秘密の出力 | セキュリティの担当、法務（報告の要否） |
| 収束の不一致の原因が同期の核 | Dev のテックリード（同期の核の持ち主） |
| AWS の障害 | AWS のサポート（Business 以上） |

## 事後

- ポストモーテムを 5 営業日以内に書く（非難しない形）。
- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- 性質ベーステスト・シミュレーターの種・監査に、見つからなかった理由を反映する。
- この手順で足りなかったことを、ここに反映する。

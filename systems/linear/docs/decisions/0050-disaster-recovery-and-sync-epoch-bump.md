---
status: accepted
date: 2026-09-28
---

# ADR-0050: 大阪にウォームスタンバイを置き、リージョンの切り替えは書き込みを止めてから昇格し、全ワークスペースの `sync_epoch` を上げてから書き込みを受ける。検索は 4 時間で戻し、失った範囲の外への副作用は取り消せないものとして扱う

## Context

NFR-007 は、リージョンの障害で RPO 1 分以内・RTO 1 時間以内を求める。Aurora Global Database の計画外のフェイルオーバーは、複製の遅延ぶんを失いうる。write fencing は最善努力で、先にアプリの書き込みを止めることが勧められている（[Using switchover or failover in Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)、2026-09-28 に確認）。

[ADR-0013](0013-sync-group-changes-retention-and-reset.md) は、リージョンの切り替えと時点の復元で `sync_epoch` を上げ、クライアントがやり直し、確定から 15 分以内の outbox を送り直すと決めた。ただし、誰が・いつ・どの範囲で上げるか、上げる前に書き込みを受けないことをどう守るか、検索・連携・Webhook などの外の部品をどう扱うかは決めていない。

`sync_epoch` を上げる前に大阪で書き込みを受けると、失った範囲の番号に別の変更が振られ、古い番号を持つクライアントが「同じ番号で違う中身」を持ち続ける（NFR-005 の破れ）。

## Options

1. **ウォームスタンバイ。書き込みを止めてから昇格し、全ワークスペースの `sync_epoch` を上げてから `writes_enabled` を開く。ワークフローで自動化し、判断は人**
2. 自動のフェイルオーバー（健康の確かめで自動に切り替える）
3. パイロットライト（大阪に DB の複製だけ）

検索：

- a. **大阪に OpenSearch を常に置かず、スナップショットから戻す（RTO 4 時間）**
- b. 大阪にも索引を常に持ち、両方に書く

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 6 節、手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

- 大阪に常に置くもの：Aurora の Global Database の二次（reader 1 台）、各サービスの最小のタスク、ALB、NAT、VPC エンドポイント、空の SQS と Valkey、ECR・Secrets Manager・KMS のレプリカ、S3 のレプリカ（添付、資産、配布物、OpenSearch のスナップショット）。
- 切り替え：インシデントの指揮者が判断し、Ops の責任者が承認する。ワークフローは、(1) 東京の書き込みを止める（`ops.writes_enabled = false`）、(2) 大阪の二次を昇格（東京が生きていれば switchover）、(3) 古い一次のスナップショットを保全、(4) **全ワークスペースの `sync_epoch` を 1 つ上げ、プラットフォームの監査に残す**、(5) 大阪の Sync API と reader をやり直しの殺到に向けて広げる（[capacity.md](../architecture/capacity.md) の 4.2 節）、(6) 入口を大阪へ、(7) `writes_enabled` を開く、の順に行う。(4) の前に書き込みを受けない。
  > 2026-09-28 の注記：(4) と (5) の間に「失った範囲の権限を狭める操作のやり直し」を足した（[ADR-0058](0058-dr-permission-narrowing-journal.md)）。停止・除外・非公開への切り替え・取り消しが失った範囲に入ると、大阪で権限が戻り、やり直しのブートストラップで見てよくないデータが届くため。やり直しが終わるまで `writes_enabled` を開けない。また、(5) の散らしの幅は `ops.epoch_reset_spread_min` で 30 分まで伸ばせる（[ADR-0013](0013-sync-group-changes-retention-and-reset.md) の注記）。
- 大阪の Writer は、起動の時に `writes_enabled = false` で待つ。
- 検索は大阪でスナップショットから戻し、数え直しで追いつかせる。その間、サーバーの検索は止め、手元の検索だけにする。
- 失った範囲の変更で送った Webhook・メール・Slack・PR のコメントは取り消せない。送り直しで同じ変更が再び確定すると、Webhook は新しい `syncId` で再び送られる。公開 API の文書に書く。
- GitHub の事象は、失った範囲の開始から後に更新された PR を読み直して埋める。
- switchover（計画のフェイルバック、訓練）は番号を保つので、`sync_epoch` を上げない。1 つのワークスペースの時点の差し替えでは、そのワークスペースだけ上げる。
- `rds.global_db_rpo` は設定しない。`AuroraGlobalDBRPOLag` が 10 秒を超えたら呼び出す。
- 2 を採らない理由：スプリットブレインの余地があり、`sync_epoch` を上げる前に両方で書き込みを受けうる。東京の短い不調で全クライアントのやり直しを起こす費用が大きい。
- 3 を採らない理由：タスクとネットワークを起動する時間で RTO 1 時間に収まりにくい。
- b を採らない理由：索引の費用が 2 倍になり、両方への書き込みの順序と遅れの管理が要る。検索は手元でも縮退できる（[search.md](../architecture/search.md) の 10 節）。

## Consequences

- 良くなること：
  - DR の後も全クライアントがサーバーと一致する（NFR-005）。失った範囲の自分の変更は、15 分以内なら送り直される。
  - 書き込みの停止と `sync_epoch` の順序を、ワークフローが守る。
- 引き受けるコスト：
  - 切り替えの後、全端末がやり直しのブートストラップをする。大阪の構成を一時に広げる必要がある。
  - 検索が最大 4 時間止まる。
  - 外への副作用（Webhook など）の重複と、取り消せない送信が残る。

## Confirmation

- DR の訓練（staging 四半期、本番の switchover 年 1 回）：計画外の切り替えを模し、合成監視のクライアントが一致し（収束の監査。[ADR-0053](0053-convergence-audit.md)）、失った範囲の送り直しが 1 回だけ当たる。
- シミュレーター（[ADR-0010](0010-deterministic-sync-simulator.md)）：DR の切り替え（最後の k 件を失い `sync_epoch` を上げる）の性質。
- ワークフローの試験：`sync_epoch` を上げる前に `writes_enabled` を開けない。

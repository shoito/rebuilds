# Runbook: 災害復旧（リージョンの障害、KRaft のクォーラムの喪失、写しの遅れ、訓練）

- Owner: Ops
- 対応するアラート: 大阪の容量の予約が `active` でない（D-1）、大阪からの合成監視の全失敗、`AuroraGlobalDBRPOLag` の超過、大阪への写しの遅れ（S3 RTC）、KRaft のスナップショットの写しの欠け、訓練（四半期に 1 回）
- 最終確認日: 2026-09-27

構成は [infrastructure.md](../architecture/infrastructure.md) の 8 節、範囲は [ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md)、大阪への写しは [ADR-0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md) と [tiered-and-object-storage.md](../architecture/tiered-and-object-storage.md) の 6.6 節にある。AZ の喪失は [incident-response.md](incident-response.md) の「AZ の喪失」で扱う。

## 症状

| 場面 | 見え方 |
| --- | --- |
| A. 東京のリージョンの喪失 | 大阪からの合成監視が、東京の全ブローカーと管理 API で失敗する。東京の probe も応答しない。AWS Health Dashboard に東京の広い範囲のイベント |
| B. 写しの遅れ | `AuroraGlobalDBRPOLag` が 30 秒を 5 分超える。S3 RTC の `ReplicationLatency` が 15 分を超える、`OperationsFailedReplication` > 0。KRaft のスナップショットの写しが 2 時間ない |
| C. KRaft のクォーラムの喪失 | 1 つの物理クラスタで、活動中のコントローラーが 0。過半数のコントローラーのボリュームを失った |
| D. 訓練 | 四半期に 1 回（dp-staging・cp-staging）。年に 1 回、大阪で本番の台数を起動できるかの確認 |

## 影響

- A：
  - 制御面の切り替え（目標 1 時間）まで、管理 API・コンソールが使えない。
  - データ面は、大阪で書き込みの経路を作り直すまで（目標 4 時間。SLA にしない）、produce・fetch ができない。
  - 失うもの（[ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md) の表）：写しが無効の論理クラスタのレコード全て、写しが有効の論理クラスタの S3 に上がっていない部分（閉じていないセグメント、最大 1 時間か 256 MiB ＋ LSO で止まった部分＋ CRR の遅れ）、圧縮のトピック（Kafka Streams の changelog を含む）、コンシューマーのオフセット、トランザクションの状態、テナントのメトリクスの履歴。
- B：この状態で A が起きると、失う範囲が広がる。
- C：その物理クラスタのメタデータが変えられない。リーダーを失ったパーティションはオフライン。

## 確認

1. AWS Health Dashboard、大阪の合成監視、別の回線（社内の端末）からの到達性で、東京全体か、1 つの AZ か、当社の部品（NLB、Envoy、DNS）だけかを見分ける。**1 つの AZ なら [incident-response.md](incident-response.md) の「AZ の喪失」へ。**
2. 次の値を、インシデントの記録に書く（A の手順で失う範囲の説明に使う）：
   - `AuroraGlobalDBRPOLag` の直近の値と、東京が応答しなくなった時刻
   - `kraft_snapshots` の論理クラスタごとの最新の `as_of`（大阪の Aurora で読む）
   - 写しを有効にした論理クラスタの一覧（`logical_cluster_dr_copy`）と、S3 RTC の直近の遅れ
3. 大阪の骨組みの健全性：大阪の EKS、エッジ（NLB、Envoy、sni-router）、Strimzi、ECR の複製、証明書（大阪の名前を含む）。

## 対処

### A. 東京 → 大阪

**切り替えの判断は、インシデントの指揮者（IC）が行い、Ops の責任者が承認する。** AWS の見込みで 1 時間以内に回復しそうなら、待つことも選ぶ（データ面は大阪で作り直してもオフセットと直近のデータが戻らないので、東京の回復を待つほうが利用者の損は小さいことが多い）。制御面とデータ面の判断を分けてよい。

#### A-1. 宣言と告知

1. SEV1 を宣言し（[incident-response.md](incident-response.md)）、状況のページで告知する。告知には、戻らないもの（オフセット、直近のレコード、圧縮のトピック）を書く。
2. 東京の制御面・エージェントへ書き込みが届くなら、止める（東京の api を読み取り専用にする。東京の SQS への送り出しを止める）。

#### A-2. 制御面（目標 1 時間）

1. Aurora Global Database を大阪へ切り替える（計画外は `failover-global-cluster --allow-data-loss`）。切り替えの前に、東京への書き込みが止まっていることを確かめる。
2. 大阪の ECS の api・internal-api・relay・usage・billing の最小のタスクを広げる。
3. 管理 API の DNS（`api.<brand>.<domain>`）を大阪の ALB へ向ける。
4. 合成監視で、管理 API とコンソールのログインを確かめる。
5. 論理クラスタの作成・変更を止めたままにする（データ面がまだない）。コンソールに「災害復旧中」を出す。

#### A-3. データ面の書き込みの経路（目標 4 時間。SLA にしない）

1. 作り直す物理クラスタを決める。東京の物理クラスタと同じ数・同じ層にする（論理クラスタの配置をそのまま写すため）。大阪の EC2 の空きが足りなければ、代わりの型（r7g・m7g）を Terraform の変数で選ぶ。
2. Terraform：`live/dp/prod/apne3/pcs/pc-<id>` を apply（CMK、バケット、ノードグループ）。目安 20 分。
3. gitops：Strimzi の Kafka・KafkaNodePool を大阪の EKS へ適用（目安 15 分。burn-in は省く）。
4. 制御面：論理クラスタを大阪の物理クラスタへ割り当て直し（ID・接頭辞・API キーはそのまま）、エージェントが `__<brand>_tenants`・`__<brand>_credentials` を配る。
5. トピック・パーティションの数・設定・ACL を、`kraft_snapshots` から命令で作り直す（エージェントが論理クラスタごとに実行）。作り直した論理クラスタのオフセットは 0 から始まる。
6. DNS：ブートストラップの `*.apne1.<brand>.<domain>` を大阪の NLB へ向ける。大阪のブローカーは `…<az-id>.apne3.<brand>.<domain>` を広告する（証明書は両方の名前を持つ）。
7. 合成監視（大阪の probe）で、論理クラスタごとの produce・consume を確かめる。
8. 利用者への案内：クライアントはブートストラップを変えずにつなぎ直せる。コンシューマーは、オフセットが戻らないので、時刻で位置を決め直す（`--to-datetime` のリセット、または `auto.offset.reset`）。トランザクションの `transactional.id` は作り直される。Kafka Streams は状態を作り直す。

#### A-4. 履歴の戻し（写しを有効にした論理クラスタ、目標 24 時間）

1. dr-vault の大阪のバケットの `_rlmm/` の最後のスナップショットから、有効なセグメントの一覧を読む。
2. 自前の道具で、大阪の物理クラスタの RLMM に登録し直し、読み取り専用のトピック（`remote.log.copy.disable=true`）として見せる。トピックの名前の形は E4 で決める（書き込みの経路の同じ名前のトピックと衝突させない）。
3. 戻したトピックの最初と最後のオフセットと、`_rlmm/` の記録を突き合わせる。
4. 利用者に、戻した範囲（論理クラスタ・トピックごとの最後のオフセットと時刻）を知らせる。

#### A-5. 東京の回復の後

- S1 では、大阪から東京へ自動で戻さない。東京へ戻すのは、計画した移行（新しい物理クラスタ、ブートストラップの向け直し、利用者の告知）として別に行う。大阪で受けた書き込みを東京へ移す手段はクラスタの間の複製（S2）で、S1 では利用者のアプリで読み直してもらう。
- 東京の古い物理クラスタは、利用者に連絡してから消す（東京に残っていたレコードを取り出したい利用者がいれば、読み取り専用で一時的に開ける）。

### B. 写しの遅れ

1. `AuroraGlobalDBRPOLag`：大阪との経路と、東京の書き込みの急増（使用量の集計、監査の索引の一括）を見る。`rds.global_db_rpo` は設定しない（設定すると大阪の遅れで東京のコミットが止まる。Stripe の [infrastructure.md](../../../stripe/docs/architecture/infrastructure.md) の 5.3 節と同じ理由）。
2. S3 RTC の遅れ：前方一致ごとの要求の速さと、1 Gbps の既定の転送の上限を超えていないかを見る。RTC の SLA は、これらを超えている間は適用されない（[S3 RTC](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)）。大量の写しの開始（新しく写しを有効にした大きな論理クラスタ）なら、写しの規則を段階的に有効にする。
3. `OperationsFailedReplication`：dr-vault の KMS のキーのポリシー、バケットのポリシー、複製の役割を見る。
4. KRaft のスナップショットの写しの欠け：データ面のエージェントの責務のメトリクスと、`<brand>-ops-<pc-id>-apne1` への書き込みの権限を見る。

### C. KRaft のクォーラムの喪失（1 つの物理クラスタ）

1. SEV1 を宣言する。その物理クラスタの全ての論理クラスタに影響する。
2. **ボリュームが残っているか**を確かめる。コントローラーの EBS が残っていれば、同じ AZ の新しいノードに付け替えて、同じ投票者として戻す（[metadata-and-control.md](../architecture/metadata-and-control.md) の 3.3 節）。過半数が戻れば終わり。
3. 1 台だけ残っているなら、残りの 2 台を「足してから外す」手順（`add-controller`・`remove-controller`）で入れ替える。一度に 1 つ。この間、他の変更を止める。
4. 過半数のボリュームを失ったとき（最後の手段）：
   - 本家に、スナップショットからクォーラムを作り直す正式な手順はない（4.3 の [KRaft](https://kafka.apache.org/43/operations/kraft/) の運用の文書に載っていない。2026-09-27 に確認）。Dev のテックリードと、本家の文書・開発者への確認の結果に従う。
   - 材料：`<brand>-ops-<pc-id>-apne1` の最新のスナップショット（1 時間ごと）、`kraft_snapshots`（30 秒ごと）。
   - スナップショットの後に作られたトピック・ACL・パーティションの変更は失われうる。ブローカーのログ（EBS と S3）は残るが、メタデータと合わない部分が出うる。耐久性の監査（AUD-1〜6）を全て回し、影響したテナントを特定する。
5. この手順は、検証の環境で年 2 回試す（[ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)）。

### D. 訓練

| 訓練 | 頻度 | 合格 |
| --- | --- | --- |
| 東京の喪失（staging）：A-2〜A-4 | 四半期 | 制御面 1 時間以内、書き込みの経路 4 時間以内、戻した履歴の中身とオフセットが元と同じ |
| 大阪の EC2 の空きの確認（D-1） | 四半期 | 予約が `active`、ブローカーの型を AZ ごとに起動できる |
| 大阪での本番の台数の起動 | 年 1 回 | 東京の本番と同じ台数の r8g・m8g を 1 時間以内に起動できる（起動して消す） |
| KRaft のクォーラムの喪失（dp-verify） | 年 2 回 | C-4 の手順で、メタデータを戻し、監査の不一致を特定できる |
| AZ の退避（本番） | 四半期 | 1 つの AZ のブローカーを降格して、SLO を守ったままリーダーを他の AZ へ移し、戻す（[replication-and-durability.md](../architecture/replication-and-durability.md) の 8.4 節） |

- 訓練の結果を `dr_restores` に書く（種類、各段の完了の時刻、失った範囲の見積もり、結果）。

### D-1. 大阪の EC2 の空きの確認（`osaka-capacity-check`、四半期）

リージョンの障害では他社も大阪へ移るので、大阪で EC2 を起動できないおそれがある（[architecture/README.md](../architecture/README.md) の 6 節）。コントローラーとエッジの最小だけを予約し、ブローカーは起動できるかを定期に確かめる。

1. 予約を確かめる：大阪の On-Demand Capacity Reservation（コントローラー m8g.xlarge を AZ ごとに 1 台、Envoy c8g.xlarge を AZ ごとに 1 台）が `active` で、台数と AZ ID が Terraform の定義と一致する。常設の Envoy 2 台が予約を使っている。`active` でなければ ticket を切り、E12 の `osaka-standby` の Terraform で作り直す。
2. ブローカーの型を起動して消す：dr の検証用のノードグループで、`apne3-az1`〜`az3` の AZ ごとに r8g.4xlarge・m8g.4xlarge を 3 台ずつ、オンデマンドで起動し、`InsufficientInstanceCapacity` が出ないことを確かめてから消す。出た型と AZ は、代わりの型（r7g.4xlarge・m7g.4xlarge）でも同じことを試す。
3. 結果を `dr_restores`（種類 `capacity_check`）に書く。2 回続けて `InsufficientInstanceCapacity` が出た型は、A-3 の手順 1 の既定の型を代わりの型に替える提案を Ops の責任者に出す。
4. 費用：1 回あたり 18 台を数分起動するだけで、数ドル。

## エスカレーション

- 東京の喪失の判断 → Ops の責任者（切り替えの承認）、PM（利用者への告知の内容）、法務（SLA・利用規約の該当。intent.md の L6）。
- 大阪の EC2 の空きが足りない → AWS のサポート（Enterprise の担当）に容量を相談する。
- KRaft の過半数のボリュームの喪失 → Dev のテックリード。本家の開発者のメーリングリストへの相談を含めて判断する。
- 戻したデータの食い違い（オフセット、中身） → SEV1 のまま、Dev のテックリードと耐久性の監査の担当。

## 事後

- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- 失った範囲（論理クラスタ・トピックごと）の実際の値を、見積もり（`AuroraGlobalDBRPOLag`、RTC の遅れ、`segment.ms`）と比べ、[ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md) の表と利用者向けの説明を直す。
- 大阪の書き込みの経路の作り直しにかかった時間を記録し、S2 のクラスタの間の複製の優先度の判断に使う。
- この手順で足りなかったことを、ここに反映する。

---
status: accepted
date: 2026-09-27
---

# ADR-0048: 大阪への災害復旧は、DynamoDB のグローバルテーブル（MREC）・S3 の複製・Aurora の Global Database と縮小したウォームスタンバイで行い、切り替えのたびに「世代」を上げてジャーナルとチェックポイントの置き場所を分ける

## Context

NFR-009 は、リージョンの障害で RPO 1 分・RTO 1 時間（大阪）を求める。[ADR-0003](0003-journal-and-checkpoints.md) は、ジャーナルを DynamoDB のグローバルテーブルで、S3 をクロスリージョンのレプリケーションで大阪へ複製すると決めた。細部に次の問題がある。

- **グローバルテーブル（MREC）は非同期で、項目ごとに「最後の書き込みが勝つ」。** 複製は通常 1 秒以内。条件付きの書き込みは、そのリージョンの項目に対してだけ評価される。`TransactWriteItems` はそのリージョンの中でだけ原子的で、他のリージョンでは一部だけが見えうる。止まったリージョンの未複製の書き込みは、回復したときに複製される。MRSC（強い整合性）は、ちょうど 3 つのリージョン（またはレプリカ 2＋witness）が要り、トランザクションと TTL を使えない。東京・大阪は MRSC の対象のリージョンに入る（[How DynamoDB global tables work](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html)、2026-09-27 に確認）。
- したがって、東京が止まった後に大阪でジャーナルを書き続けると、**東京が戻ったときに、東京の未複製の項目が大阪の同じ `(file_id, seq)` の項目を上書きしうる。** 東京が完全には止まっておらず、一部の利用者が東京で編集を続けた場合も同じである。
- S3 のレプリケーション（RTC）は、多くの物を数秒で、99.9% を 15 分以内に複製する（[S3 Replication Time Control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)、2026-09-27 に確認）。大阪の最新のチェックポイントは、ジャーナルより遅れうる。東京で後から書かれたマニフェストが、大阪の同じキーのマニフェストを上書きしうる。
- Aurora の Global Database は、計画外の切り替えで複製の遅れの分を失う（Stripe の [infrastructure.md](../../../stripe/docs/architecture/infrastructure.md) の 5.3 節）。

## Options

1. **MREC のグローバルテーブル。切り替えのたびに「世代」を上げ、新しい世代のジャーナルとマニフェストを別のキーに書く**
2. **MREC のグローバルテーブル。キーはそのまま**
3. **MRSC のグローバルテーブル（東京・大阪＋第 3 のリージョン）**
4. **グローバルテーブルを使わず、DynamoDB のバックアップ（PITR）を大阪へ写す**

大阪の構成：

- a. **縮小したウォームスタンバイ**（ECS のサービスを最小の台数、ALB、Aurora の二次に reader 1 台を常に置く）
- b. **パイロットライト**（データだけを複製し、計算の資源は切り替えのときに Terraform で作る）

## Decision

1 と a を採用する。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)、構成は [infrastructure.md](../architecture/infrastructure.md) の 7 節。

### 世代（`region_gen`）

- 書き込みを受けるリージョンと世代の番号を、各リージョンの設定（AppConfig と SSM）に持つ。最初は東京・世代 1。
- **リージョンを切り替えるたびに、世代を 1 上げる**（計画外でも計画的でも）。
- 世代 `g ≥ 2` のジャーナルは、パーティションキーを `{file_id}#g{g}` にする。世代 1 は [ADR-0024](0024-journal-items-and-fencing.md) のとおり `{file_id}`。
- 世代 `g ≥ 2` のマニフェストは `files/{file_id}/checkpoints/g{g}/{seq:020}`、大きな変更は `files/{file_id}/journal-blobs/g{g}/{start_seq}-{epoch}`。チャンクは中身のハッシュで名付けるので、世代で分けない。
- 新しい世代で初めてファイルを回復した持ち主は、その世代のフェンスの項目（`seq = 0`）に `base_gen`（元の世代）と `base_end_seq`（元の世代から当てた最後の `seq`）を書く。
- 回復の手順（[file-storage-and-history.md](../architecture/file-storage-and-history.md) の 4.4 節）を、次のように広げる。
  1. 今の世代のフェンスの項目があれば、その `base_*` と、今の世代のチェックポイントから始める。
  2. なければ、元の世代で「大阪にある、チャンクがそろった最新のマニフェスト」を選ぶ（Aurora の `checkpoint_seq` が指すマニフェストが未複製なら、`checkpoints/` を一覧して 1 つずつ戻る）。
  3. 元の世代のジャーナルを、そのマニフェストの `seq` の次から、**飛びの手前まで**当てる。そこが `base_end_seq`。飛びの後の項目は、失った範囲として扱う（下の「取り戻し」）。
  4. 以後は今の世代のパーティションに書く。`seq` は `base_end_seq + 1` から続ける。
- `file_leases` の割り当ては、`region_gen` が今の世代でない項目を「持ち主なし」とみなす（[ADR-0047](0047-router-task-liveness-and-file-assignment.md)）。東京の古い項目が後から複製されて上書きしても、Router は持ち主なしとみなして割り当て直し、フェンスで古い持ち主が止まる。

### 切り替え（計画外）

1. 東京の書き込みを止める（届くなら ops フラグ `ops.multiplayer_read_only`、入口の CloudFront を大阪へ）。
2. 大阪の設定の世代を上げ、Aurora の Global Database を大阪へ切り替える。
3. 大阪の Document Server・Gateway の台数を東京と同じにする。回復のジョブが、東京で開いていたファイル（`file_leases` の `owned`・`handoff`）を順に回復する。
4. DynamoDB のグローバルテーブルから東京のレプリカを外すことを試みる（障害中に外せるかは資料に記述がなく **未検証**。E12 の `dr-drill` で、AWS FIS のリージョンの切り離しで確かめる。外せなくても、世代で分けたキーには東京の書き込みが届かない）。

### 取り戻し（東京が戻った後）

- `dr-salvage` のジョブが、各ファイルについて、元の世代のジャーナルのうち `base_end_seq` より後の項目（東京で確定したが大阪に届かなかった変更）を探す。
- 見つかったら、`base_end_seq` の状態にそれらを当てた状態をチェックポイントとして書き、バージョンの一覧に「障害で反映されなかった編集」として足す（バージョンの種類の追加は file-storage-and-history の領域への提案）。今のファイルには自動で混ぜない。利用者が比べて、復元か複製を選ぶ。
- 失った範囲の件数とファイルの数を、インシデントの記録に残す。

### 戻す（計画的）

- 大阪で、全ファイルを `released`（チェックポイントを書いて手放す）にし、DynamoDB の `ReplicationLatency` と S3 の複製の待ちが 0 になってから、東京で世代を上げて受け付けを始める。RPO 0 で戻せる。

### その他

- ジャーナルの複製の遅れ（`ReplicationLatency`）が 10 秒を超えたら警告、30 秒で呼び出し（RPO 1 分の半分）。
- S3 は RTC を有効にし、15 分を超えた複製の事象を受ける。
- 2 を採らない理由：上の Context の上書きで、確定した変更がどちらかのリージョンで静かに消える。
- 3 を採らない理由：トランザクションが使えず、ADR-0024 のフェンスの書き込みが成り立たない。TTL も使えない。書き込みごとにリージョンをまたぐ往復が入り、NFR-001 の予算を圧迫する。
- 4 を採らない理由：RPO 1 分を満たせない。
- b を採らない理由：ECS・ALB・Valkey を切り替えのときに作ると、30 分以上かかりうる（Slack の S1 のパイロットライトは RTO 4 時間）。1 時間の RTO に余裕がない。

## Consequences

- 良くなること：
  - 東京が戻っても、大阪で確定した変更が上書きされない。
  - 失った範囲の変更を捨てずに、利用者が取り戻せる形で残す。
  - 計画的な切り替えは RPO 0。
- 引き受けるコスト：
  - 回復の手順が、世代をまたぐ読み方を持つ。PROP-FS-001・002 のテストを、世代の切り替えを含む列に広げる。
  - [file-storage-and-history.md](../architecture/file-storage-and-history.md) の 4.1 節（パーティションキー）と 5 節（マニフェストのキー）に、世代 2 以降の形を足す。統合の工程で行う。
  - 大阪に、最小の台数の ECS・ALB・Aurora の reader を常に払う。

## Confirmation

- 性質ベーステスト：任意の変更の列・複製の遅れ・切り替えの時点で、大阪で確定した変更は、東京の遅れた項目が後から届いても失われない。
- DR の訓練（四半期に 1 回、staging）：AWS FIS でグローバルテーブルの複製を止めてから切り替え、失った範囲が 1 分以内で、`dr-salvage` がそれをバージョンとして取り戻す。
- 年 1 回、本番で計画的な切り替えを行い、RTO を計る。

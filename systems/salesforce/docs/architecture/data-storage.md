# Data storage: Salesforce

`records` の表、ピボットの索引・一意・関係の表、長いテキストの別の表、論理シャードへの割り当て、ごみ箱と削除の確定、整合の検査、大口の組織の射影の表（S2 以降）の設計。土台は [ADR-0002](../decisions/0002-custom-object-storage.md)（records＋JSONB＋型付きのピボット）と [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)（RLS、論理シャード 256）。この文書で決めたことは、次の 3 つの ADR にある。

- `records` とピボットの表は、`shard_no` で LIST 分割する。ピボットの索引は、索引の指定のある項目・名前・外部 ID だけに書き、空の値も印の行として書く。組織の `shard_no` は、作成時にハッシュで決めて `orgs` に持ち、以後は変えない（[ADR-0010](../decisions/0010-record-tables-partitioning-and-pivots.md)）。
- 削除は `deleted_at` と削除の束（`delete_batch_id`）で表し、15 日で確定する。ごみ箱の間は索引と一意の行を外し、戻す時に作り直す（[ADR-0011](../decisions/0011-recycle-bin-and-purge.md)）。
- ピボットと射影は正本の写しとして、同じトランザクションで書き、整合の検査で差を 0 に保つ。射影の表は S2 以降に、運用の判断で大口の組織にだけ作る（[ADR-0012](../decisions/0012-derived-copies-consistency-and-projections.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| `records`、ピボット、長いテキストの表の形と索引 | 項目の型、`field_no`、型の変換の手順（[metadata-and-runtime.md](metadata-and-runtime.md)） |
| 論理シャードへの割り当てと、表の分割 | 物理のクラスタ、セル、組織の移動、DR（infrastructure の領域） |
| ごみ箱、戻す、削除の確定、消去 | 項目の変更の履歴の保持（audit-and-field-history の領域） |
| 整合の検査 | 共有の表と閉包の表の形（[sharing-and-record-access.md](sharing-and-record-access.md)） |
| 射影の表（S2） | 問い合わせの計画で、どの表を使うかの判断（[query-language-and-api.md](query-language-and-api.md)） |
| 保存の量の見積もり | 容量の計画の全体（capacity の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| データの表 | 全組織のレコードを MT_Data に入れる。GUID、OrgID、ObjID、名前、文字列の flex 列（Value0〜ValueN） | [Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)（以下「MT」） |
| ピボットの表 | MT_Indexes（型付きの StringValue・NumValue・DateValue）、MT_Unique_Indexes（一意）、MT_Relationships（両向きの複合索引）、MT_Fallback_Indexes（全レコードの名前）、MT_Name_Denorm（ObjID と名前） | MT |
| 分割 | 全てのデータ・メタデータ・索引を OrgID で物理的に分割し、問い合わせは組織の分割だけを読む | MT |
| ごみ箱 | 削除は IsDeleted の印。15 日は戻せる。主従の親を戻すと子も戻る | MT |
| ごみ箱と性能 | ごみ箱の行も DB に残り、問い合わせは除外する必要がある。ごみ箱は保存の容量に数えない。件数の上限はない。15 日の後に完全な削除の予定に入るが、時刻は保証しない。一括の API には、ごみ箱を通らない完全な削除がある | [Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)（以下「LDV」） |
| 索引の表と空の値 | カスタム項目の索引は、型付きの写しの索引の表で持つ。既定では空の値の行を含めない。空で絞る条件は索引を使えない | LDV |
| 索引を張れない項目 | ロングテキスト、リッチテキスト、決定的でない数式など | LDV |
| skinny table | よく使う項目を持つ読みのための写し。元の表の変更と同期する。200 列まで。他のオブジェクトの項目は持てない。サポートへの依頼で作る | LDV |

## 3. 表

### 3.1 `records`

```sql
CREATE TABLE records (
  shard_no        smallint    NOT NULL,           -- 4 節
  org_id          uuid        NOT NULL,
  object_id       uuid        NOT NULL,
  id              uuid        NOT NULL,           -- UUIDv7
  record_type_id  uuid,
  owner_id        uuid        NOT NULL,           -- 利用者、またはキューのグループ
  parent_id       uuid,                           -- 1 本目の主従の親、または活動の主の親。共有の「親に連動」で使う
  name            text,                           -- 名前の項目（表示用。検索は record_index_values）
  data            jsonb       NOT NULL,           -- field_no → 値（metadata-and-runtime.md の 3.3 節）
  created_at      timestamptz NOT NULL,
  created_by      uuid        NOT NULL,
  updated_at      timestamptz NOT NULL,
  updated_by      uuid        NOT NULL,
  deleted_at      timestamptz,                    -- ごみ箱（5 節）
  delete_batch_id uuid,
  row_version     bigint      NOT NULL,
  PRIMARY KEY (org_id, object_id, id, shard_no)
) PARTITION BY LIST (shard_no) WITH (fillfactor = 85);
```

| 索引 | 用途 |
| --- | --- |
| 主キー `(org_id, object_id, id, shard_no)` | 1 件の読み、ID の範囲での走査（整合の検査、再計算） |
| `(org_id, object_id, owner_id, id) WHERE deleted_at IS NULL` | 所有者での絞り込みと、共有の条件（[sharing-and-record-access.md](sharing-and-record-access.md) の 6 節） |
| `(org_id, object_id, updated_at, id) WHERE deleted_at IS NULL` | 更新の時刻での取り出し（連携の同期）、最近の更新の並び |
| `(org_id, object_id, created_at, id) WHERE deleted_at IS NULL` | 作成の時刻での絞り込み |
| `(org_id, parent_id) WHERE parent_id IS NOT NULL` | 親に連動する共有、主従の子の列挙 |
| `(org_id, delete_batch_id) WHERE deleted_at IS NOT NULL` | ごみ箱の一覧、戻す、確定 |

- 主キーの末尾に `shard_no` を置くのは、PostgreSQL の分割の表の主キーに、分割の列が要るためである。問い合わせは必ず `shard_no = $1` を含め、分割の刈り込みを効かせる。
- `record_type_id`・`owner_id`・`parent_id`・`name` を実際の列にするのは、共有・画面・問い合わせで毎回使うため（ADR-0002 のシステムの列に、`parent_id` を足した）。
- **`parent_id` の意味**（2026-09-28。sales-objects の領域の依頼、[ADR-0021](../decisions/0021-lead-conversion-and-activity-parents.md)）：主従の従のオブジェクトでは 1 本目の主従の親。活動（ToDo・行動・メール）では主の親（`what` があれば `what`、なければ `who`）。どちらも「親に連動」の判定（[sharing-and-record-access.md](sharing-and-record-access.md) の 5.5 節、[sales-objects.md](sales-objects.md) の 4 節）で使う。主の親の変更は、`parent_id` の列の更新だけで、共有の行を書き直さない。それ以外のオブジェクトでは空。
- `fillfactor = 85`：`updated_at` に索引があるので、更新は HOT にならない。ページの空きで、更新での行の移動を抑える。値は E3 で測って決める。
- 行ロック：更新は `SELECT ... FOR UPDATE` で 1 行ずつ取る。`row_version` で楽観の衝突を検出する（[query-language-and-api.md](query-language-and-api.md) の 6.4 節の `If-Match`）。

### 3.2 ピボットの表

| 表 | 主キー・一意 | 列 | 索引 |
| --- | --- | --- | --- |
| `record_index_values` | `(org_id, record_id, field_no, ord, shard_no)` | `object_id`、`v_text`（正規化）、`v_num`、`v_ts`、`v_bool`、`is_null` | 型ごとの部分索引：`(org_id, object_id, field_no, v_text, record_id) WHERE v_text IS NOT NULL`、`v_num`・`v_ts`・`v_bool` も同じ形。空：`(org_id, object_id, field_no, record_id) WHERE is_null`。「含む」：`v_text` の trigram の GIN（`btree_gin` で `org_id` を先頭に置けるかは E3 の PoC） |
| `record_unique_values` | 一意：`(org_id, object_id, field_no, v_norm, shard_no)` | `record_id` | `(org_id, record_id)` |
| `record_relationships` | `(org_id, child_id, field_no, shard_no)` | `child_object_id`、`parent_id`、`parent_object_id` | `(org_id, parent_id, child_object_id, field_no, child_id)` |
| `record_long_texts` | `(org_id, record_id, field_no, shard_no)` | `value`（TOAST、lz4） | — |

- どの表も `shard_no` で LIST 分割し、`org_id` と RLS を持つ（ADR-0005）。
- **`record_index_values` に書く項目**：`indexed` の項目、`external_id` の項目、名前の項目、実体化した数式（[metadata-and-runtime.md](metadata-and-runtime.md) の 7.5 節）。ADR-0002 の持ち越し（全項目に張るか）は、既定を「指定のある項目だけ」とし、E3 の PoC で書き込みの増幅と問い合わせの速さを測って確かめる（ADR-0010）。
- **空の値も書く。** 空の項目は `is_null = true` の行を 1 行書く。本家は空の値を索引に含めず、空で絞る条件が索引を使えない（LDV）。本システムは、空で絞るリストビュー（「担当が未設定の商談」など）でも索引を使えるようにする。
- **名前の前方一致**（search の領域の依頼）：参照の項目の候補（[search.md](search.md) の 4.4 節）が `v_text` の範囲の条件で前方一致を引けるよう、`v_text` の B-tree は `COLLATE "C"`（コードポイントの順）で作る。並べ替えの規則（14 節の決定）とも合う。E3 の PoC で計画を確かめる。
- **文字列の正規化**：`v_text` と `v_norm` は、NFKC で正規化し、小文字にした値にする（全角・半角の英数字、大文字・小文字を同じにする）。問い合わせの値も同じ関数で正規化してバインドする。正規化の関数は TypeScript に 1 つだけ持ち、評価器と共有する。`unique_case_sensitive` の項目の `v_norm` は、小文字にしない。
- 選択リストは `value_id` を、複数選択は値ごとに 1 行（`ord`）を書く。
- `record_relationships` は、全ての参照・主従の項目に書く。関連リスト、積み上げ集計、削除の連鎖、関係をたどる問い合わせで使う。

### 3.3 行の大きさ

- `records.data` は 64KB まで（[metadata-and-runtime.md](metadata-and-runtime.md) の 3.4 節）。
- PostgreSQL は、約 2KB を超える JSONB を TOAST に出し、1 つの項目の更新でも値全体を書き直す。行が大きいほど、更新の費用が増える。
- ロングテキストとリッチテキストは `record_long_texts` に分ける（ADR-0002）。
- オブジェクトの行の大きさの p95 が 16KB を超えたら、Setup の画面で管理者に警告し、ロングテキストへの移しや項目の整理を勧める。

### 3.4 書き込みの経路

- ピボットの行は、純粋な関数 `derivePivotRows(objectSegment, record) → rows` で、レコードとメタデータから決める。
- 保存（[metadata-and-runtime.md](metadata-and-runtime.md) の 6 節の手順 6）では、保存の前と後のレコードから `derivePivotRows` を 2 回求め、差分の行だけを書く（変わっていない項目のピボットを書き直さない）。
- `records` とピボットは同じトランザクションで書く（ADR-0002）。書いた直後の問い合わせに出る。
- 一意の違反は `record_unique_values` の一意の制約で DB が検出する。違反した `field_no` から項目を求め、400 `DUPLICATE_VALUE` を返す。
- 外部 ID・一意の値の引き（upsert、親の外部 ID での参照）は、塊（200 件）の値をまとめて 1 回の問い合わせで引く（bulk-and-import の領域の依頼）。
- 同じ関数を、整合の検査（6 節）と、型の変換・数式の作り直しでも使う。

### 3.5 outbox

保存・メタデータの変更と同じトランザクションで書き、確定の後に Relay（論理シャードごとの唯一の書き手）が読んで配る。送った後に消す。

| `kind` | 書く所 | 受け手 |
| --- | --- | --- |
| `change_event` | 保存の手順 11 | Relay → `events` のクラスタ（[ADR-0033](../decisions/0033-change-event-log-and-replay.md)） |
| `org_event` | 組織が定義するイベントの `after_commit` の発行 | Relay → `events` のクラスタ |
| `field_history` | 保存の手順 9（最上位で 1 回） | Relay → `history` のクラスタ（[ADR-0047](../decisions/0047-field-history-tracking-and-retention.md) の注記） |
| `search_index` | 保存の手順 11 | Relay → SQS → indexer（[search.md](search.md) の 4.5 節） |
| `delivery` | フローの `call_webhook`、トリガーの外向きの呼び出し | Worker（class `delivery`）→ prod-egress（[events-and-integrations.md](events-and-integrations.md) の 6 節） |
| `email` | `send_email`、1 通ずつのメール、通知 | Worker → SES |
| `async` | 非同期の経路、after_commit のトリガー、メタデータの後の仕事、`metadata.version_changed` | Worker・Relay |
| `login_event` | ログインとトークンの発行 | Worker → `login_events`（[audit-and-field-history.md](audit-and-field-history.md) の 4 節） |

- 変更のイベント・組織のイベント・履歴は、同じ outbox の行の ID から作る `event_id` の一意の制約で、二重の送信を捨てる。
- outbox は `shard_no` で分割し、最古の未送の行の経過時間を Relay の遅れとして計測する（`event-relay-lag`）。

## 4. 論理シャードへの割り当て（ADR-0010）

- `orgs.shard_no`（0〜255）を組織の作成時に決める。値は `org_id` の SHA-256 の先頭 2 バイトを 256 で割った余りにする（ADR-0005 の「`org_id` のハッシュで論理シャードを決める」）。
- **以後は `orgs.shard_no` を正とし、計算し直さない。** 組織の `shard_no` を変えるのは、組織の移動の手順（infrastructure の領域）だけにする。
- 240〜255 はハッシュで割り当てない予約の番号にする。S2 以降、大口の組織を、作成時か組織の移動で予約の番号へ置き、専用のクラスタへ割り当てられるようにする。ハッシュは 0〜239 の範囲で割り当てる（`% 240`）。
- `shard_map(shard_no, cluster_id, state)` で、論理シャードを物理のクラスタへ割り当てる。S1 は全て 1 つのクラスタ。
- 組織の解決（ホスト名・トークン → `org_id`、`shard_no`）の結果は、組織の設定のキャッシュに持つ。データ層は `SET LOCAL app.org_id` と `SET LOCAL app.shard_no` を設定し、RLS の方針で両方を確かめる。
- 分割する表（13）：`records`、ピボットの 4 つ、`record_shares`、`implicit_parent_grants`、`group_members_closure`（[sharing-and-record-access.md](sharing-and-record-access.md)）、outbox、`record_match_keys`・`activity_relations`（[sales-objects.md](sales-objects.md)）、`flow_scheduled_actions`・`approval_locks`（[automation-flows.md](automation-flows.md)）。メタデータの表のような小さな表は分割しない。一覧の正本は [data-model.md](data-model.md) の 2 節の「分割・保持」の列。
- S1 の分割の数は、256 × 13 表 ≒ 3,300。PostgreSQL 18 の計画の時間は、`shard_no` の定数での刈り込みで抑える。E1 で計画の時間を測る。
- 組織の置き場所は `org_placements` の上書きがあればそれ、なければ `shard_map` で決める（[infrastructure.md](infrastructure.md) の 4.1 節、[ADR-0055](../decisions/0055-shard-placement-and-stage-criteria.md)）。

## 5. ごみ箱と削除の確定（ADR-0011）

### 5.1 削除

| 事象 | 振る舞い |
| --- | --- |
| レコードの削除 | `deleted_at`・`delete_batch_id` を入れる。`record_index_values`・`record_unique_values` の行を消す（一意の値を放す）。`record_relationships`・`record_long_texts`・`record_shares` は残す |
| 主従の子 | 同じ `delete_batch_id` で子（と孫）も削除の状態にする |
| 参照の子（`on_parent_delete = set_null`） | 子の参照の値を空にし、`recycle_bin_links` に（束、子、`field_no`、親）を残す |
| 参照の子（`restrict`） | 子がいれば削除を断る（400 `DELETE_RESTRICTED`） |
| 一括の完全な削除 | システムの権限「完全な削除」を持つ利用者の一括のジョブだけ。ごみ箱を通らず、確定と同じ消去をする |

- 削除の束（`recycle_bin_batches`）：`batch_id`、`root_object_id`、`root_record_id`、`deleted_by`、`deleted_at`、`record_count`、`purge_after`（削除から 15 日）。
- 1 回の削除で束に入る子の数は、トランザクションの上限（DML の行 10,000。ADR-0005）に数える。子の多い親（10,000 件を超える）の削除は、一括のジョブで行う。

### 5.2 戻す

戻すのは束の単位で、全部か無しかで行う。

| # | 親がごみ箱にある | 一意の値の衝突 | オブジェクト・項目が削除中 | 参照先が確定済み | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | はい（主従の子だけを戻す） | - | - | - | 拒否：`PARENT_DELETED`（親の束を戻す） |
| 2 | - | あり | - | - | 拒否：`DUPLICATE_VALUE`（衝突した項目と値を返す） |
| 3 | - | - | オブジェクトが削除中 | - | 拒否：`ENTITY_IS_DELETED` |
| 4 | - | - | 項目だけ削除中 | - | 戻す。その項目の値は残し、項目の復元で見えるようにする |
| 5 | - | - | - | あり | 戻す。その参照は空のまま |
| 6 | - | - | - | - | 戻す |

- 戻す時に、`derivePivotRows` でピボットの行を作り直し、`recycle_bin_links` の参照を戻し、共有の評価（手順 10）を行う。
- 戻せるのは、削除した人、束の元のレコードの所有者、そのオブジェクトの「すべて変更」を持つ人。本家の戻せる人の規則は未検証。
- 一意の値をごみ箱の間に放すのは、削除した取引先と同じ外部 ID で作り直す連携の操作を止めないため。その代わり、戻す時に衝突しうる（表の 2）。

### 5.3 確定と消去

- Worker が 1 時間ごとに `purge_after` を過ぎた束を拾い、組織の公平な順番（ADR-0005）で消す：`records`、ピボット、長いテキスト、`record_shares`、`implicit_parent_grants`、`record_match_keys`、`activity_relations`、`recycle_bin_links`、そのレコードの `field_history`（`history` のクラスタ。[audit-and-field-history.md](audit-and-field-history.md) の 5.4 節）と検索の文書。
- 消去は、`purge_after` から 24 時間以内に終える。本家は完全な削除の時刻を保証しない（LDV）が、本システムは個人データを長く残さないために期限を置く。
- 管理者はごみ箱を空にできる。利用者は自分が削除した束を空にできる。空にする操作は監査に残す。
- 確定の後、変更のイベントに `purged` を出す（events-and-integrations の領域）。
- 法務の L5 の結論で、15 日と 24 時間を見直す。

### 5.4 問い合わせからの除外

- 全ての問い合わせは `deleted_at IS NULL` を付ける。`records` の索引は `WHERE deleted_at IS NULL` の部分索引にしてあるので、ごみ箱の行が索引の走査を重くしない。
- ごみ箱を含める問い合わせ（REST の `/query-all`）だけが、`deleted_at` の条件を外す。
- ごみ箱の行は保存の容量に数えない（本家と同じ。LDV）。

## 6. 整合の検査（ADR-0012）

| 検査 | 比べるもの | 頻度 |
| --- | --- | --- |
| ピボット | `records` から `derivePivotRows` で求めた行と、4 つのピボットの表の行 | 組織ごとに 7 日で全件を一周。1 万件以下のオブジェクトは毎日 |
| 参照 | `data` の参照の値と `record_relationships` | 同上 |
| 所有者 | `owner_id` が存在する利用者かキュー | 毎日 |
| 孤児 | `record_long_texts`・ピボットの行で、`records` にないもの | 7 日 |
| 射影 | 射影の表と `records`（7 節） | 毎日 |
| 照合の鍵 | `deriveMatchKeys` で求めた鍵と `record_match_keys`（[sales-objects.md](sales-objects.md) の 6.3 節） | ピボットと同じ |
| 積み上げ集計 | 子から集計し直した値と親の値（[automation-flows.md](automation-flows.md) の 7.5 節） | 7 日で全ての親を一周 |
| 共有 | 標本の照合（[sharing-and-record-access.md](sharing-and-record-access.md) の 9 節） | 連続 |

- 検査は ID の範囲（1 万件）ごとに、期待する行と実際の行を並べてハッシュで比べ、違う範囲だけを 1 件ずつ比べる。
- 差が見つかったら、そのレコードの行ロックを取り、`derivePivotRows` で作り直して直す。直した件数を `pivot_drift_repaired_total{table}` で数える。
- **差は、保存の経路の不具合である。** 1 件でも出たら警告し、原因を調べる。直すのは被害を止めるためで、差が出ることを許すためではない。
- 検査は reader で範囲を比べ、直す時だけ writer を使う。組織ごとの DB の時間の計測（ADR-0005）に数え、重い組織の検査は後回しにする。
- 組織の移動の間（`orgs.status` の補助の状態 `migrating`。[ADR-0056](../decisions/0056-org-migration-by-row-filtered-logical-replication.md)）の組織は、検査を飛ばし、切り替えの後に先のクラスタで続ける（infrastructure の領域の依頼）。

## 7. 射影の表（S2 以降、ADR-0012）

大口の組織の、よく使うオブジェクトの読みが NFR-001 に収まらない時に、型付きの専用の表を作る。本家の skinny table と同じく、読みのための写しである（LDV）。

- **作る条件**：オブジェクトの生きている行が 1,000 万件以上で、そのオブジェクトのリストビュー・レポートの p95 が NFR-001 の 2 倍を 7 日続けて超えた時。Ops が capacity の領域の基準で判断し、runbook で作る。利用者が自分では作れない。
- **形**：`proj_<projection_id>`（`org_id`、`id`、`owner_id`、`record_type_id`、`updated_at`、選んだ項目を型付きの列で最大 100 列）。他のオブジェクトの項目は持たない。`org_id` と RLS を持つ。索引は選んだ項目に Ops が張る。
- **同期**：保存の手順 6 で、`records` と同じトランザクションで書く。非同期にすると、レポートの値と共有の判定が正本とずれるため。
- **使う時**：問い合わせの計画（[query-language-and-api.md](query-language-and-api.md) の 4 節）が、参照する全ての項目が射影にある時だけ使う。
- **メタデータとの関係**：`projections(org_id, object_id, projection_id, field_nos, state, built_version)`。射影に入っている項目の型の変換・削除があると、同じ版で `state = stale` にし、計画が使わなくなる。Worker が作り直して `active` に戻す。
- **DDL**：射影の表の作成は、マイグレーションの外の DDL になる。専用の DB のロールを持つ Worker だけが、許可リストの形（`proj_` の接頭辞）で行う。DDL の lint（ADR-0002）の例外として許可リストに書く。
- **数の上限**：1 つの組織で 3 つ、1 つのクラスタで 500 まで（PostgreSQL のカタログを膨らませないため）。
- 本家の skinny table は 200 列までだが（LDV）、本システムは 100 列で始める。行の幅を抑え、写しの書き込みの費用を小さくするため。

## 8. 保存の量の見積もり（S1）

| 対象 | 見積もり | 前提 |
| --- | --- | --- |
| `records` | 約 0.7TB | 5 億件 × 平均 1.2KB（`data`）＋行の頭 |
| `record_index_values` | 約 0.3TB | レコードあたり平均 3 行（名前、索引 1、空の印 1）× 約 90B ＋索引 |
| `record_relationships` | 約 0.15TB | レコードあたり平均 2 行 |
| `record_unique_values` | 約 0.05TB | 外部 ID を持つオブジェクトだけ |
| `record_long_texts` | 約 0.3TB | 活動の本文、メモ |
| ごみ箱 | 上の数 % | 15 日分 |

数値は本システムの想定で、E3 と E12 で測って capacity の領域で見直す。

## 9. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| ピボットの差が見つかる | 6 節。直して警告 |
| 消去の Worker が止まる | 冪等なので再開で続ける。`purge_after` から 24 時間を超えたら警告 |
| 一意の違反が同時の保存で起きる | DB の一意の制約で片方が失敗する。`DUPLICATE_VALUE` を返す（再試行しない） |
| 射影の表が壊れる・遅れる | `state = stale` にすれば、計画は `records` とピボットに戻る。射影を捨てても正本は失われない |
| 分割の表の計画が遅い | `shard_no` の定数がない SQL を lint で禁止する。計画の時間の p99 を計測する |
| 大きな束の削除・戻すが上限を超える | 全体を巻き戻す。一括のジョブで行うよう案内する |

## 10. セキュリティ

- 全ての表に `org_id` と RLS。`shard_no` も RLS の方針で確かめる（4 節）。
- ピボットの表は正本の写しで、正規化した値を持つ。ピボットの表を直接読める経路を持たない（データ層の外からの SQL の禁止。ADR-0003）。
- 削除の確定から 24 時間以内に、ごみ箱の行と写しを全て消す（5.3 節）。ごみ箱を空にする操作は監査に残す。
- 完全な削除は専用のシステムの権限だけに許す（5.1 節）。
- 射影の表の DDL は、専用の DB のロールと許可リストだけ（7 節）。
- RLS を外せる DB のロールは `admin_cross_org`（`cross-org-worker` だけが使う。組織の作成、Sandbox の複製、組織の移動、組織の消去）と `maint`（分割の `DROP`、射影の DDL）の許可リストに限る。CI のマイグレーションの検査がこの一覧を読む（sandboxes-and-deploy の領域の依頼、[ADR-0054](../decisions/0054-accounts-network-and-service-separation.md)）。
- `security:sensitive` の対象：RLS の方針、ごみ箱の戻せる人の規則、消去の Worker、射影の DDL。

## 11. テスト

- 決定表（`DT-STO-*` の草案）：5.1 節の削除の振る舞い、5.2 節の戻す表。
- 性質ベーステスト：
  - 任意のメタデータとレコードの操作の列（作成・更新・削除・戻す・型の変換）で、ピボットの表の行が、`records` から `derivePivotRows` で求めた行と一致する（ADR-0002）。
  - 任意の操作の列で、ピボットを使った問い合わせの結果が、`records` の全行を参照の評価器で判定した結果と一致する（ADR-0002）。空の値の条件を含める。
  - 任意の削除と戻すの列で、戻した後のレコード・ピボット・参照が、削除の前と一致する（表の 4・5 を除く）。
  - 文字列の正規化：任意の文字列で、正規化は冪等で、全角・半角・大文字・小文字の違いだけの 2 つの文字列は同じ値になる。
  - 任意の 2 組織で、一方の `app.org_id`・`app.shard_no` の下で他方の行が読めない（ADR-0005）。
- 上限の試験：`data` の 64KB、束の子の数（DML の行 10,000）で、ちょうどで通り、1 つ超えたら拒否する。
- 結合テスト：確定から 24 時間以内に、全ての表から行が消える。
- 結合テスト：射影を `stale` にすると、同じ問い合わせが同じ結果を返したまま、計画が `records` に戻る。
- 性能テスト（E3）：1 オブジェクト 5,000 万件の組織で、索引の項目の等価の条件が p95 100ms 以内（ADR-0002）。空の値の条件も同じ。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0010](../decisions/0010-record-tables-partitioning-and-pivots.md) | `records` とピボットを `shard_no` で LIST 分割し、組織の `shard_no` は作成時のハッシュで決めて以後は変えない。ピボットの索引は指定のある項目・名前・外部 ID に書き、空の値も印の行として書く。文字列は NFKC と小文字で正規化する |
| [0011](../decisions/0011-recycle-bin-and-purge.md) | 削除は印と削除の束で表し、15 日で確定して 24 時間以内に消す。ごみ箱の間は索引と一意の行を外し、戻す時は束の単位で全部か無しかで作り直す |
| [0012](../decisions/0012-derived-copies-consistency-and-projections.md) | ピボットと射影は正本の写しとして同じトランザクションで書き、整合の検査で差を 0 に保つ。射影の表は S2 以降に運用の判断で大口の組織にだけ作る |

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | 分割の表のマイグレーション（`shard_no` の LIST 分割）、`shard_map`、RLS の方針（`org_id` と `shard_no`） |
| E1 | lint：`shard_no` の定数のない SQL、マイグレーションの外の DDL（射影の許可リストを除く） |
| E3 | `records` の読み書きと `derivePivotRows`、差分でのピボットの書き込み |
| E3 | 一意と外部 ID（`record_unique_values`）と、`DUPLICATE_VALUE` |
| E3 | 関係（`record_relationships`）と、関連リストの読み |
| E3 | 長いテキストの別の表 |
| E3 | ピボットの PoC：全項目か指定だけかの書き込みの増幅と問い合わせの速さの計測 |
| E3 | ごみ箱：削除、戻す（決定表）、確定と消去の Worker、ごみ箱を空にする |
| E3 | 整合の検査（ピボット・参照・孤児）と、直す処理、`pivot_drift_repaired_total` |
| E9 | 一括の完全な削除（専用の権限） |
| E12 | 保存の量の見積もりの計測と、`fillfactor` と TOAST の設定の見直し |
| E12（S2 の準備） | 射影の表：作成の runbook、同じトランザクションでの書き込み、`stale` の扱い、整合の検査 |

## 14. 未解決の問い

- ピボットの索引を、全項目に張るか、指定のある項目だけにするか（ADR-0002 からの持ち越し）。
- 文字列の並べ替えを、正規化した値のコードポイントの順にするか、日本語の照合（ICU）にするか。
- ごみ箱の期間（15 日）と消去の期限（24 時間）。法務の L5 の結論で変わりうる。
- ごみ箱の間に一意の値を放す規則で、戻す時の衝突が多く起きないか。
- 射影の表を、同じトランザクションで書く費用が、大口の組織の書き込みの速さに見合うか。
- `btree_gin` で `org_id` を先頭に置いた trigram の索引が、組織の数が多い時に使えるか。

### 決定

2026-09-28 の既定案。

- ピボットは指定のある項目だけで作る。E3 の PoC で、全項目にしても 1 件の保存の p95 が 20% 以上遅くならず、問い合わせの計画が単純になると分かれば、ADR を改める。
- 並べ替えは、正規化した値のコードポイントの順で作る。評価器と SQL の結果を一致させやすいため。ひらがなとカタカナの順などの要望が出たら、読みの項目（ふりがな）を足す方向で扱う（sales-objects の領域）。
- ごみ箱は 15 日、消去は 24 時間で作り、値を設定で変えられるようにする。
- 一意の値はごみ箱の間に放す。戻す時の衝突は `DUPLICATE_VALUE` で返し、管理者が片方を直す。
- 射影は同じトランザクションで書く。S2 の前に、射影を持つ組織の保存の p95 を測り、NFR-002 を超えるなら、射影を持てるオブジェクトを読みの多いものに絞る。
- trigram の索引は E3 の PoC で確かめる。使えなければ、「含む」の条件は他の条件で絞った候補にだけ評価器で当てる。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：ピボットと正本のずれ（誤った絞り込み、一意の漏れ）。`derivePivotRows` の性質ベーステストと、本番の整合の検査。
- リスク：ごみ箱の戻すでのデータの不整合と、確定の後の消し残し。戻すの決定表と、消去の結合テスト。
- リスク：組織の分離の破れ（RLS と `shard_no`）。性質ベーステスト。
- 本番での検証：整合の検査の差が 0 であること。消去の遅れが 0 であること。

**runbooks**

- `pivot-drift-detected`：整合の検査で差が出た。対象の組織・オブジェクト・項目、直前のデプロイ、保存の経路の不具合を調べる。
- `purge-overdue`：確定から 24 時間を超えた消去。
- `recycle-bin-restore-conflict`：戻すの衝突の問い合わせへの対応（管理者への案内）。
- `projection-create`・`projection-rebuild`・`projection-drop`：射影の表の作成・作り直し・廃止（S2）。
- SLI の追加の依頼（Ops へ）：`pivot_drift_repaired_total`、消去の遅れ、分割の表の計画の時間の p99、1 件の保存で書くピボットの行の数の分布、行の大きさの p95。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `records` | 3.1 節 | `shard_no` で LIST 分割、RLS |
| `record_index_values` | `org_id`、`object_id`、`field_no`、`record_id`、`ord`、`v_text`、`v_num`、`v_ts`、`v_bool`、`is_null` | 分割、RLS。正本の写し |
| `record_unique_values` | `org_id`、`object_id`、`field_no`、`v_norm`、`record_id` | 分割、RLS。一意の制約 |
| `record_relationships` | `org_id`、`child_id`、`field_no`、`child_object_id`、`parent_id`、`parent_object_id` | 分割、RLS |
| `record_long_texts` | `org_id`、`record_id`、`field_no`、`value` | 分割、RLS |
| `recycle_bin_batches` | `org_id`、`batch_id`、`root_object_id`、`root_record_id`、`deleted_by`、`deleted_at`、`record_count`、`purge_after` | RLS |
| `recycle_bin_links` | `org_id`、`batch_id`、`child_id`、`field_no`、`parent_id` | 参照の空にした値を戻すため |
| `orgs.shard_no`、`shard_map` | `shard_no`、`cluster_id`、`state` | `shard_map` は RLS の外（運用） |
| `projections` | `org_id`、`object_id`、`projection_id`、`field_nos`、`state`、`built_version` | S2 |
| `consistency_check_progress` | `org_id`、`object_id`、`check_kind`、`last_id`、`cycle_started_at` | 検査の進み |

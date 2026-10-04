# Bootstrap and Partial Sync: Linear

クライアントが最初にデータを取る処理（ブートストラップ）と、手元に全部を持たないときの同期を決める。全体・部分・手元から・やり直しの 4 つの起動の経路、ストリームの形、一貫した写しの取り方、遅延の読み込みと部分の索引、同期グループの変化（参加・脱退・移動・非公開への切り替え）と手元の追加・消去、同期のログの保持と、古すぎるクライアントのやり直しを扱う。

前提となる決定は、同期のモデル（[ADR-0002](../decisions/0002-sync-model.md)）、ブートストラップと部分の同期（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)）、テナントと権限（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、手元の保存（[ADR-0005](../decisions/0005-client-persistence-and-offline.md)）、差分と範囲の証明（[ADR-0007](../decisions/0007-sync-actions-and-range-proof-deltas.md)）、Gateway の握手（[ADR-0009](../decisions/0009-sync-gateway-protocol.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0011](../decisions/0011-bootstrap-stream-and-chunked-snapshots.md) | ブートストラップは NDJSON のストリームで、モデルを ID の範囲のチャンク（2 万行）に分け、チャンクごとに 1 つの写し（`as_of`）で読む。クライアントは最も小さい `as_of` から差分を当て、行の `updated_sync_id` で古いものを退ける。チャンクの境を先に決めるので、途中で切れても残りのチャンクだけを取り直せる |
| [0012](../decisions/0012-lazy-loading-coverage-and-tombstones.md) | 遅延の読み込みは「被覆の鍵」（`Comment:issue_id=…` など）の単位で求め、そろったら部分の索引に記録する。読み込みと差分の順序の揺れは、行の `updated_sync_id` と、15 分持つ削除の墓標で解く |
| [0013](../decisions/0013-sync-group-changes-retention-and-reset.md) | 同期グループの参加・脱退は `SyncSubscription` の差分で表し、参加はそのグループの部分のブートストラップ、脱退は同じ IndexedDB のトランザクションでの消去にする。`sync_actions` は 30 日、やり直しは握手の決定表で決める。DR の切り替えと復元では `sync_epoch` を上げ、直近 15 分に確定した outbox を送り直す |

## 1. 目的と範囲

- 扱う：
  - 起動の経路（全体・部分・手元から・やり直し）の選び方と、状態の遷移
  - Sync API のブートストラップと遅延の読み込みの API、ストリームの形、上限
  - 一貫した写しと、中断からの再開
  - 部分の索引（被覆の鍵）と、読み込みと差分の突き合わせ
  - 同期グループの一覧、参加・脱退・移動・非公開への切り替え・ワークスペースからの除外
  - 同期のログの保持、`floor_sync_id`、やり直し、`sync_epoch`
- 扱わない：
  - 差分の形、範囲の証明、握手の決定表の本体（[sync-engine.md](sync-engine.md)）
  - IndexedDB の store の定義、outbox、複数のタブ、メモリーの階層（[client-store-and-offline.md](client-store-and-offline.md)）
  - `can()` と同期グループの計算の規則（[permissions-and-teams.md](permissions-and-teams.md)）
  - 手元にないデータを含むビューとフィルター（[views-and-filters.md](views-and-filters.md)）
  - 保持の期間の法的な判断（法務の L5。[intent.md](../intent.md)）

## 2. 本家の形（確かめたこと）

いずれも 2026-09-28 に確認。

### 2.1 公式

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 大きなデータ | データが大きくなり、「いつ、どれをメモリーに読むか」が課題になった、という講演がある。ページは動画の案内で、技術の詳細は本文にない | [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine)（2023-06-29） |
| 非公開のチーム | メンバーでない人はイシューを見られない。公開のチームを非公開にすると、メンバーでない人は担当と購読から外れる | [Private teams](https://linear.app/docs/private-teams) |

### 2.2 第三者の解析（本家の保証ではない）

| 項目 | 解析の内容 | 出典 |
| --- | --- | --- |
| 読み込みの方針 | `instant`（全体のブートストラップで読む。既定）、`lazy`（最初に使うときに全部読む）、`partial`（索引の問い合わせで必要な分を読む）、`explicitlyRequested`、`local` の 5 つ | [wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine) |
| 全体のブートストラップ | `/sync/bootstrap?type=full&onlyModels=…`。モデルの列をストリームで返し、メタデータに `lastSyncId`・`subscribedSyncGroups`・`databaseVersion`・`returnedModelsCount` を持つ。応答の各行は `ModelName=<JSON>` の形という観察もある | 同上、[Reverse engineering Linear's sync magic](https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/)（2022-12-20） |
| 部分のブートストラップ | `/sync/bootstrap?type=partial&syncGroups=<id>&onlyModels=…`。特定の同期グループのモデルを読む | reverse-linear-sync-engine |
| 部分の索引 | `issueId-<UUID>` のような索引の値で読む。参照を 3 段までたどって索引の組を作る。読んだ索引を別のデータベース（`<hash>_partial`）に記録し、同じものを二度取らない。まとめて `/sync/batch` に求める | 同上 |
| 同期グループ | 利用者、チームのメンバーシップ、ロールの UUID の一覧で購読する。2024 年の終わりに `userSyncGroups` へ分けられた | 同上 |
| グループの変化 | 差分の G・S でグループが変わると、新しいグループのモデルを取りに行ってから残りの差分を当てる。外れたグループのモデルは IndexedDB から消す | 同上 |

- 本家の同期のログの保持の期間と、古すぎるクライアントの扱いは、公開の資料で確かめられなかった（**未検証**）。

## 3. 起動の経路

### 3.1 選び方

```
 起動
  │ 登録（<brand>_registry）にこのアカウント×ワークスペースの DB があり、_meta が読め、
  │ スキーマのバージョンが移行できる？
  ├─ いいえ ─▶ サーバーのブートストラップ（kind=auto：全体か部分かはサーバーが決める。4.1 節）
  └─ はい ──▶ 手元から（5 節）
                │ WebSocket の握手（sync-engine.md の 9.4 節）
                ├─ resume / catch_up ─▶ 通常
                └─ reset ─────────────▶ やり直し（8.2 節）：手元のモデルを捨て、outbox を残して、サーバーのブートストラップ
```

### 3.2 状態

`_meta.bootstrap` に持つ。

```
 none ──(開始)──▶ streaming{kind, groups, chunks, done[], s_min} ──(全チャンク)──▶ catching_up ──(L = head)──▶ ready
                         │ 切れた・タブが閉じた                                          ▲
                         ▼                                                               │
                  streaming（残りのチャンクだけ取り直す。4.5 節）─────────────────────────┘
 ready ──(reset)──▶ resetting{reason} ──▶ streaming …
```

- `streaming` の間に、`instant` のモデルのチャンクがそろえば、画面を出してよい（ADR-0003）。`partial` のモデルは「読み込み中」と示す。
- 書き込み（トランザクションの作成と outbox）は、どの状態でも受け付ける。送るのは `ready` か `catching_up` の後。

## 4. サーバーのブートストラップ（全体・部分）

ADR-0011。

### 4.1 全体か部分か

- Sync API が決める（`kind=auto`）。接続の同期グループで見てよいモデルの数の見積もり（`workspace_stats` のグループごとの数の和）が 5 万件以下なら全体、超えれば部分（ADR-0003 の仮の値。E3 の PoC で決める）。
- 全体：`instant` と `partial` のモデルをすべて取る。`lazy` は取らない。
- 部分：`instant` のすべてと、`partial` のうち条件に合うもの。イシューの条件は、未完了、または 30 日以内に完了・取り消したもの（ADR-0003 の仮の値）。
- どちらでも、アーカイブしたモデルは取らない（`lazy`。ADR-0003）。

### 4.2 API とストリーム

```
GET /sync/bootstrap?workspace=…&kind=auto&schema=<hash>
Accept-Encoding: br, gzip
→ 200 application/x-ndjson
```

```
{"t":"head","v":1,"kind":"partial","workspace_id":"…","sync_epoch":3,"schema_hash":"…",
 "groups":["workspace","team:…","user:…"],
 "chunks":[{"m":"User","c":0,"after":null,"upto":null},
           {"m":"Issue","c":0,"after":null,"upto":"01926f…"},{"m":"Issue","c":1,"after":"01926f…","upto":null}]}
{"t":"chunk","m":"User","c":0,"as_of":18234}
{"t":"rows","m":"User","rows":[{"id":"…","name":"…","_u":1203,"_g":["workspace"]}, …]}
{"t":"chunk_end","m":"User","c":0,"n":1800}
…
{"t":"covered","keys":["Issue:team_id=…:active", …]}
{"t":"end","s_min":18190,"rows":123456}
```

| 行 | 意味 |
| --- | --- |
| `head` | 種類、世代（`sync_epoch`）、スキーマ、購読するグループ、**チャンクの境の一覧**。境は最初に決め、クライアントが `_meta` に持つ |
| `chunk` | チャンクの始まりと、その写しの `as_of`（その写しの中で読んだ `workspace_sync.last_sync_id`） |
| `rows` | 最大 1,000 行。各行に `_u`（`updated_sync_id`）と `_g`（同期グループ）を付ける |
| `chunk_end` | チャンクの終わりと行の数 |
| `covered` | この応答で完全にそろった被覆の鍵（6.2 節） |
| `end` | 全チャンクの `as_of` の最小（`s_min`） |

- モデルの順：`instant` を依存の順（ワークスペース、利用者、チーム、ワークフローの状態、ラベル、サイクル、プロジェクト、イニシアチブ、保存したビュー、自分の通知…）に、その後に `partial`。
- 圧縮は br を優先し、なければ gzip。
- 応答はワークスペースと写しの組でキャッシュしない（ADR-0003）。

### 4.3 一貫した写し

- **チャンクごとに 1 つの読み取りのトランザクション**（`REPEATABLE READ, READ ONLY`）で、`workspace_sync.last_sync_id`（= `as_of`）とチャンクの行を読む。PostgreSQL のホットスタンバイは `SERIALIZABLE` を使えないが `REPEATABLE READ` は使える。Aurora の reader で同じ振る舞いになるかは**未検証**（E3 の前の `bootstrap-poc` で確かめる）。
- チャンクは ID の範囲で 2 万行。1 つのチャンクの読み取りを 10 秒以内に収める。長い読み取りは reader の複製の適用と衝突し、取り消されうる。Aurora の reader でも、複製の適用と衝突した読み取りは `canceling statement due to conflict with recovery` で取り消される（[Replication with Amazon Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Replication.html)）。待つ時間の `max_standby_streaming_delay` は 1〜30 秒の範囲でしか設定できない（[Amazon Aurora PostgreSQL parameters, Part 2](https://aws.amazon.com/blogs/database/amazon-aurora-postgresql-parameters-part-2-replication-security-and-logging/)）。いずれも 2026-09-28 に確認。10 秒は、この上限の中に収める値である。取り消されたら、Sync API がそのチャンクだけを読み直す。
- クライアントは、全チャンクを書いた後、`L = s_min` とし、`s_min` の後の差分を当てる（握手は `catch_up` になる）。
- **なぜ正しいか**：チャンク `k` の行は、`as_of_k ≥ s_min` の時点の状態である。`s_min` の後の差分を順にすべて当てるとき、行の `_u` 以下の差分は退ける（`_u ≥ s` なら当てない）。行の作成・更新は `_u` で退けられ、写しの後の変更は当たる。写しの前に消えた行は写しになく、`s_min` の後の削除の差分は「ない行を消す」だけになる。写しの前に消えた行への古い `update` が差分で先に来ても、後の `delete` が必ず続く。よって、全差分を当てた後の状態は、サーバーの状態と一致する（PROP-BOOT-001 で確かめる）。

### 4.4 クライアントの書き込み

- `rows` を 2,000 行ずつ 1 つの IndexedDB のトランザクション（`durability: "relaxed"`）で書く（[client-store-and-offline.md](client-store-and-offline.md) の 4 節）。落ちても、そのチャンクを取り直せばよい。
- `chunk_end` を受けたら、同じトランザクションで `_meta.bootstrap.done` にチャンクを足す。
- ブートストラップの間に届く生の差分は、メモリーに持つ（16 MiB まで。超えたら捨てて、終わった後に `s_min` から取り戻す）。全チャンクの後に、`s_min` の後を順に当てる。
- 行を書く規則：手元に同じ ID の行があれば、`_u` の大きい方を残す。墓標（6.4 節）があり、墓標の `sync_id` が行の `_u` より大きければ書かない。

### 4.5 中断と再開

- タブが閉じた・接続が切れたら、次の起動で `_meta.bootstrap` の `chunks` と `done` を見て、残りのチャンクだけを求める。

```
POST /sync/bootstrap/chunks
{ "workspace": "…", "sync_epoch": 3, "groups_hash": "…",
  "chunks": [{"m":"Issue","after":"01926f…","upto":null}] }
```

- サーバーは `sync_epoch` と購読のグループが変わっていれば `409 restart` を返し、クライアントは最初からやり直す（書いた行は捨てる）。
- 再開したチャンクの `as_of` は新しくなりうる。`s_min` は全チャンクの最小のままにする。

### 4.6 部分のブートストラップの条件と被覆

- 部分のブートストラップは、読んだ条件を被覆の鍵として返す（`covered`）。例：
  - `Issue:team_id=<T>:active`：チーム T の未完了と 30 日以内に完了・取り消したイシューは、手元にそろっている。
  - 全体のときは `Issue:team_id=<T>:all`。
- ビューとフィルターは、条件が被覆の鍵に含まれるかで、手元だけで答えられるかを決める（views-and-filters の領域）。
- 条件の外のイシュー（古い完了）は、開いたときに ID で読む（`Issue:id=<X>`）か、サーバーの問い合わせで読む。

### 4.7 上限と見積もり

| 項目 | 値 |
| --- | --- |
| 1 チャンク | 2 万行、読み取り 10 秒以内 |
| 1 つの `rows` の行 | 1,000 行 |
| 1 つの Sync API のタスクの同時のブートストラップ | 20（超えたら `429` と `Retry-After`） |
| 全体のブートストラップの目安（モデル 5 万件） | 行 1 KB で約 50 MB、圧縮で約 6 MB（見積もり。E3 で測る） |
| 部分のブートストラップの目安（最大のワークスペース） | `instant` 数万件と、イシュー約 10 万件（未完了と直近 30 日。全体の 2 割と仮定）で約 150 MB、圧縮で約 20 MB（見積もり。E3 で測る） |

- NFR-003（部分で p95 10 秒）は、ダウンロード（20 MB）、JSON の解析、IndexedDB への書き込みの和で決まる。IndexedDB の一括の書き込みの速さは端末とブラウザで大きく違い、**未検証**。E3 の前の `bootstrap-poc` で基準の端末で測る。遅すぎれば ADR-0005 の代案（SQLite の WASM）へ替える ADR を書く。

## 5. 手元からの起動

- 手順：登録を開く → ワークスペースの DB を開く（移行があれば [client-store-and-offline.md](client-store-and-offline.md) の 6 節）→ `_meta` を読む → `instant` のモデルをメモリーへ → 大きなモデル（イシュー）は索引の形で読む（同 7 節）→ 画面を出す → WebSocket の握手。
- 画面はサーバーを待たずに出す（ADR-0003）。握手の結果が `reset` なら、画面は手元のデータのまま「再同期しています」と示し、8.2 節の手順に入る。
- NFR-003（2 回目以降 p95 1.5 秒）の内訳の予算：DB を開く 100ms、`_meta` 20ms、`instant` の読み出し 500ms、イシューの索引の読み出し 500ms、描画 200ms、余裕 180ms。

## 6. 遅延の読み込みと部分の索引

ADR-0012。

### 6.1 API

```
POST /sync/load
{ "workspace": "…", "keys": ["Comment:issue_id=…", "IssueHistory:issue_id=…", "Issue:id=…"], "min_sync_id": 18240 }
→ 200 application/x-ndjson
{"t":"head","as_of":18251}
{"t":"rows","m":"Comment","rows":[…]}
{"t":"covered","key":"Comment:issue_id=…"}
{"t":"more","key":"IssueHistory:issue_id=…","cursor":"…"}
{"t":"end"}
```

- 1 回に 50 鍵まで。クライアントは 20ms の間に求めた鍵をまとめる。
- 1 つの鍵で 5,000 行を超えるときは `more` と `cursor` で続ける。最後のページを受けてから、被覆を記録する。
- `min_sync_id`：グループへの参加の直後など、写しが特定の `sync_id` より後である必要があるときに付ける。Sync API は reader の `last_sync_id` がそれに届くまで 50ms おきに 2 秒待ち、届かなければ writer から読む。
- 同期グループの絞り込みは、差分と同じ関数で行う（ADR-0004）。見てよくない行は返さない。見てよくないことも返さない（ないのと区別しない）。

### 6.2 被覆の鍵

| 形 | 意味 | 例 |
| --- | --- | --- |
| `<Model>:<field>=<value>` | その索引の値の行が手元にすべてある | `Comment:issue_id=…` |
| `<Model>:id=<id>` | その 1 行を読んだ（ない・見てよくないも含めて確かめた） | `Issue:id=…` |
| `<Model>:<field>=<value>:<条件>` | 部分のブートストラップの条件でそろっている | `Issue:team_id=…:active` |

- 鍵の形はスキーマ（索引に使うフィールド）から生成する。スキーマにない鍵は、Sync API が `400` で断る。
- 記録は `_partial_indexes`：`{key, as_of, groups}`。`groups` は、その鍵の行が属しうる同期グループ（例：イシューのチームのグループ）。脱退のときに消す鍵を探すのに使う（7.4 節）。
- 一緒に読むもの：スキーマの `include` に書いたものだけ（例：イシューを ID で開いたら、そのコメントと履歴）。本家の解析にある 3 段までの参照のたどり方は採らない。読み込みの量が読めなくなるため。

### 6.3 差分と読み込みの突き合わせ

| 場面 | 規則 |
| --- | --- |
| 読み込みの行が手元の行より新しい（`row._u > local._u`） | 書く |
| 読み込みの行が手元の行より古い、同じ | 捨てる |
| 読み込みの行に、より新しい墓標がある（`tomb.s > row._u`） | 捨てる（消えた行を生き返らせない） |
| 差分が遅延のモデルの行を運ぶ（被覆がまだない） | 書く（ADR-0003）。被覆はまだ記録しない |
| 差分の `delete`・`evict` | 行を消し、墓標を書く |

- 被覆の記録は、読み込みの `as_of` がいくつでもよい。`as_of` の後の変更は差分で届き、前の変更は応答に含まれる。

### 6.4 墓標

- `_tombstones`：`{model, id, s, at}`。`delete` と `evict` を当てたときに書く。
- 15 分持つ。15 分より前に始めた読み込み・グループのブートストラップの応答は捨てて、求め直す。これで、どの応答も、自分より後の削除を見落とさない。
- 墓標がないと起きる誤り：読み込みを求める → 差分で行の削除が届き、手元から消す → 削除より前の写しの応答が届き、行が生き返る。ADR-0003 の「`updated_sync_id` の大きい方を残す」だけでは、消えた行に比べる相手がない。

### 6.5 手元にないことの見せ方

- 被覆がない単位を画面で開いたら、手元にある分を出し、「読み込み中」を示して読み込む。オフラインなら「オフラインのため、一部だけ表示しています」と示す。
- 被覆のあるビューは、手元の評価だけで答える（NFR-001）。

## 7. 同期グループ

ADR-0013。グループの種類は、ADR-0003 の 4 つ（`workspace`・`team:<id>`・`user:<id>`・`role:admin`）に、ADR-0033 で足した `members`（ゲストを除くメンバー）を加えた 5 つ。誰が購読するかは [permissions-and-teams.md](permissions-and-teams.md) の 5.1 節、モデルごとの規則は [data-model-and-schema.md](data-model-and-schema.md) の 3.5 節。

### 7.1 購読の表

```sql
CREATE TABLE sync_subscriptions (
  workspace_id   uuid   NOT NULL,
  id             uuid   NOT NULL,          -- モデルの ID（SyncSubscription）
  user_id        uuid   NOT NULL,
  sync_group     text   NOT NULL,          -- 'team:…' など
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, user_id, sync_group)
);
```

- `SyncSubscription` は普通のモデルで、`user:<user_id>` のグループに属する。行の追加が参加、削除が脱退である（ADR-0007）。
- Writer は、メンバーシップ・ロール・チームの公開の状態を変えるトランザクションの中で、`can()` から購読を計算し直し、差を `SyncSubscription` の `insert`・`delete` として同じトランザクションに書く。購読をクライアントが指定することはない（ADR-0003）。
- 各行（サーバーの表と手元）は `sync_groups`（手元では `_g`）を持つ。手元の各モデルの store は `_g` に multiEntry の索引を張る（[client-store-and-offline.md](client-store-and-offline.md) の 3 節）。

### 7.2 Gateway での扱い

- Gateway は、絞る前の列を順に処理し、接続の利用者の `SyncSubscription` の変更を見たら、その `sync_id` の直後から接続の `groups` を変える（ADR-0007）。
- 参加：`M` の後から、そのグループの変更を送る。
- 脱退：`M` の後から、そのグループの変更を送らない。

### 7.3 参加

```
 差分：SyncSubscription insert（sync_id = M、group = team:X）
  │ クライアント
  ├─ _meta.groups に team:X を「読み込み中」で足す（IndexedDB のトランザクション）
  ├─ GET /sync/bootstrap?kind=group&group=team:X&min_sync_id=M（4.2 節と同じ形。instant と partial の条件）
  │     行は 4.4 節と 6.3 節の規則で書く（墓標と _u）
  ├─ その間の team:X の差分は、普通に当てる（行の全体なので書ける）
  └─ end：被覆の鍵を記録し、team:X を「そろった」にする
```

- 写しは `M` 以後である必要がある（`min_sync_id=M`）。`M` より前の写しだと、参加の前に消えた行が生き返りうる。
- 公開のチームへの切り替えのように、多くの人が同時に参加するときは、クライアントは 0〜30 秒の乱数だけ待ってから読む（7.8 節）。

### 7.4 脱退

1 つの IndexedDB のトランザクション（`durability: "strict"`）で、次をまとめて行う。

1. `_meta.groups` から外す。
2. 各モデルの store の `_g` の索引で、そのグループの行を引く。残りの購読のどれにも属さない行を消す。
3. `_partial_indexes` の、そのグループに依存する鍵を消す。
4. 墓標を書く（6.4 節）。

- その後、メモリーのプールから同じ行を外し、画面を描き直す。
- 消した行への未確定のトランザクションは outbox に残す。送ればサーバーが `forbidden` で拒否し、`_rejected` に理由が残る（ADR-0003。判断をサーバーの 1 か所に保つ）。
- 添付ファイルの手元の写し、検索の手元の結果など、消した行から作ったものも消す（[client-store-and-offline.md](client-store-and-offline.md) の 3 節）。

### 7.5 握手での購読の差

- オフラインの間に参加・脱退が起きても、握手の `welcome.groups` が正である（ADR-0003）。
- クライアントは、差分を当てる前に、
  - 手元にあって `welcome.groups` にないグループを 7.4 節の手順で消す。
  - `welcome.groups` にあって手元にないグループを、7.3 節の手順で読む（`min_sync_id = live_from`）。
- 取り戻し（`catch_up`）の差分は、今の購読で絞られる。脱退したグループの変更は届かない。参加したグループの参加より前の変更は届くが、今はメンバーなので見てよい。

### 7.6 ワークスペースからの除外

- Gateway は `kick: forbidden` を送る。チケットの発行も `403` になる。
- クライアントは、そのアカウント×ワークスペースの DB を outbox ごと消す。outbox はもう送れない（権限がない）。消す前に、未送信の件数を本人に示す。
- オフラインの間に除外された場合も、次にチケットを求めた時点で同じ処理をする。

### 7.7 グループをまたぐ移動

- イシューをチーム A から B へ移すと、Writer は同じトランザクションで、イシューと、そのグループの規則で決まる依存の行（コメント、履歴、添付の情報、本文、購読）の `sync_groups` を変え、それぞれに `groups_before` 付きの `update` を書く。
- Gateway は、B を購読する接続に行の全体を、A だけを購読する接続に `evict` を送る（ADR-0003、ADR-0007）。
- 依存の行が 1 万を超えるイシューの移動は、Writer がイシュー自身と最初の 1 万行を同じトランザクションで移し、残りを Worker のシステムのトランザクションで 1,000 行ずつ移す。その間、残りの古いコメントは A のメンバーにも見え続ける（移動の前から見えていたもの）。移動の後に書かれたコメントは、イシューの今のチームで決まるので B だけに入る。

### 7.8 非公開への切り替えと、公開への切り替え

| 変化 | Writer（1 つのトランザクション） | クライアント |
| --- | --- | --- |
| 公開 → 非公開 | チームを非公開にする。メンバーでない人の担当と購読を外す（ADR-0004）。メンバーでない人の `team:X` の `SyncSubscription` を消す | メンバーでない人は 7.4 節で消す |
| 非公開 → 公開 | チームを公開にする。ワークスペースの全メンバーに `team:X` の `SyncSubscription` を足す | 参加した人は 0〜30 秒の乱数の後に 7.3 節で読む |
| 非公開のチームへの参加・脱退 | そのメンバーの `SyncSubscription` を足す・消す | 7.3・7.4 節 |
| 管理者のロールの付与・剥奪 | `role:admin` の `SyncSubscription` を足す・消す | 同上 |
| ゲストとメンバーの間のロールの変更 | `members` と、公開のチームの `team:<id>` の `SyncSubscription` を足す・消す（[permissions-and-teams.md](permissions-and-teams.md) の 7.3 節） | 同上 |

- メンバー 2,000 人のワークスペースで、公開 → 非公開は、最大 2,000 件の `SyncSubscription` の削除と、担当・購読の変更を 1 つのトランザクションで書く。ロックの保持が長くなるので、この操作だけは `lock_timeout` を 10 秒にする。
- 非公開 → 公開の一斉の読み込みの負荷（2,000 人 × チームの部分のブートストラップ）は、乱数の待ちと Sync API の受け付けの上限（4.7 節）で散らす。同じグループの写しは誰が読んでも同じなので、グループと `as_of` の組でキャッシュできるが、S1 では行わない（14 節の持ち越し）。

## 8. 同期のログの保持とやり直し

ADR-0013。

### 8.1 保持

- `sync_actions` は 30 日持つ（ADR-0003 の仮の値。法務の L5 と、やり直しの頻度で E3 に決める）。日ごとのパーティション（[sync-engine.md](sync-engine.md) の 7.1 節）。
- 保持のジョブ（毎日 03:00 JST）は、落とすパーティションについて、ワークスペースごとの最大の `sync_id` を求め、`workspace_sync.floor_sync_id` をそれ以上に上げてから、パーティションを落とす。`floor` を先に上げるので、落とした範囲を「ある」と答えることがない。
- `tx_results` は 90 日（ADR-0006）。`sync_actions` より長いので、30 日を超えたオフラインの outbox も重複を見分けられる。

### 8.2 やり直し

条件は握手の決定表（[sync-engine.md](sync-engine.md) の 9.4 節）と、手元の条件で決まる。

| 理由 | どこで分かるか |
| --- | --- |
| `too_old`：`L < floor` | 握手、取り戻しの `410` |
| `too_far`：`head − L > 50,000` | 握手 |
| `epoch`：`sync_epoch` が違う | 握手、`kick: epoch_changed` |
| `ahead`：`L > head` | 握手 |
| `migration`：手元の DB を移行できない | 起動 |
| `corrupt`：`_meta` がない・登録と食い違う | 起動 |

手順：

1. `_meta.reset = {reason, started_at}` を書く（strict）。
2. モデルの store、`_partial_indexes`、`_tombstones` を空にする。**`_outbox`・`_rejected`・`_blobs` は残す**（ADR-0003、ADR-0005）。
3. サーバーのブートストラップ（4 節）。
4. 終わったら、outbox の未確定を `pending` に当て直し、送る。
5. `_meta.reset` を消す。

- やり直しの間も、画面は手元に残るもの（outbox の当て直しを含む）で出し、書き込みは outbox に入る。`epoch` のやり直しでは、手元の古いモデルを先には消さず、ブートストラップを別の名前の DB に書いてから差し替える（読みながら書き換える）。他の理由では、手元のモデルが信用できないので先に消す。
- サーバーが一斉にやり直しを起こす場面（`epoch`）では、`welcome` の `retry_after_ms` で 0〜10 分に散らす（既定）。DR の切り替えの後に大阪の構成が広がりきらないときは、Ops のフラグ `ops.epoch_reset_spread_min` で 30 分まで伸ばす（[capacity.md](capacity.md) の 4.2 節、ADR-0013 の注記）。散らしている間、クライアントは古い手元のデータを読み取りの専用で出し、「再同期を待っています」と示す（書き込みは outbox に入る）。

### 8.3 `sync_epoch`

- 次のときに、ワークスペースの `sync_epoch` を 1 つ上げる。
  - リージョンの切り替え（大阪への昇格）。最後の 1 分ほどの確定を失いうる（NFR-007 の RPO）。同じ `sync_id` が別の変更に振り直される。
  - ワークスペースの時点の復元（PITR）。
- S2 のクラスタの移動は `sync_id` を保つので上げない。
- リージョンの切り替えでは、`sync_epoch` を上げた後、書き込みを受ける前に、失った範囲の権限を狭める操作（停止、非公開への切り替え、脱退など）を別の記録からやり直す（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)）。やり直しのブートストラップが、正しい購読で絞られるようにするため。
- 上げると、全クライアントの握手が `reset`（`epoch`）になる。手元の `L` が新しいサーバーの `head` より先でも、同じ番号で違う中身の状態を持ち続けない。
- **直近の確定の送り直し**：outbox の行は、確定して消す代わりに `done` として 15 分残す（[client-store-and-offline.md](client-store-and-offline.md) の 5 節）。`epoch` のやり直しでは、`done` の行も送り直す。生き残った変更は `tx_results` で前の結果が返り（重複しない）、失われた変更は 1 回だけ当たる。README の NFR-007 の「outbox に残っていれば送り直される」を、確定を確かめた後の 15 分にも広げるものである。

### 8.4 古すぎる outbox

- 90 日より古いトランザクション（`client_tx_id` の UUIDv7 の時刻）は自動で送らない（ADR-0005）。画面で本人に一覧を示し、「送る」か「捨てる」を選ばせる。送るときは新しい `client_tx_id` を振り直す（重複の検出はできないことを示す）。

## 9. 障害のときの振る舞い

| 障害 | 起きること | 回復 |
| --- | --- | --- |
| ブートストラップの途中で切れた | 一部のチャンクだけ手元にある | 残りのチャンクだけ取り直す（4.5 節） |
| 途中で購読・世代が変わった | 残りのチャンクの取り直しが `409 restart` | 最初からやり直す |
| reader の長い読み取りが取り消された | チャンクの読み取りが失敗 | Sync API がそのチャンクを別の写しで読み直す（`as_of` が変わってもよい） |
| Sync API の混雑 | `429` | `Retry-After` と乱数の待ち。手元から起動できるクライアントは画面を出したまま待つ |
| 読み込みの応答が遅い（15 分超） | 墓標が切れている | 応答を捨てて求め直す（6.4 節） |
| 脱退の消去の途中でタブが落ちた | IndexedDB のトランザクションが戻る | 次の起動の握手の `welcome.groups` で、もう一度消す（7.5 節） |
| 保持のジョブが `floor` を上げた後、パーティションを落とす前に止まった | ログは残るが `floor` の外として扱う | 次の実行で落とす。安全側 |
| DR の切り替え | 直近の確定の喪失 | `sync_epoch`、送り直し（8.3 節） |
| やり直しの殺到 | Sync API と reader の負荷 | 0〜10 分（DR では 30 分まで）に散らす、受け付けの上限、reader の追加（[capacity.md](capacity.md) の 4.2 節） |

## 10. セキュリティ

- ブートストラップ・取り戻し・遅延の読み込み・グループのブートストラップは、どれも権限の関数から導いた同期グループで絞る（ADR-0004）。クライアントが指定するグループ・被覆の鍵は、サーバーで購読と照合し、外れたものは空の結果にする（存在を明かさない）。
- 脱退の消去は、メモリー・IndexedDB・手元の派生物（検索の結果、添付の写し）すべてに及ぶ。消し漏れは漏えいである（README の 6 節）。
- `sync_epoch` を上げずに DB を戻すことは、手順で禁止する（runbooks）。同じ番号で違う中身が配られ、手元の状態が壊れる。
- ブートストラップの応答をキャッシュしない。CDN を通す場合も `Cache-Control: private, no-store`。
- ログには、ワークスペースの ID、種類、チャンクの数、行の数、大きさ、時間だけを書く。行の中身を書かない。

## 11. テスト

### 11.1 性質ベーステスト（[ADR-0010](../decisions/0010-deterministic-sync-simulator.md) のシミュレーター）

- **PROP-BOOT-001（経路の同値）**：全体・部分・手元から・やり直し・中断からの再開のどの経路でも、同じ差分を受けた後、手元の状態（被覆のある範囲）がサーバーの見てよい状態と一致する。
- **PROP-BOOT-002（見てよい集合）**：任意のグループの参加・脱退・移動・非公開への切り替え・ワークスペースからの除外の列の後、各クライアントの手元（メモリー、IndexedDB、部分の索引）が、その時点で見てよい行の集合の部分集合であり、被覆のある鍵については等しい。
- **PROP-BOOT-003（順序の揺れ）**：遅延の読み込み・グループのブートストラップの応答と、差分の到着の順序を入れ替えても、最終の状態が変わらない。消えた行が生き返らない。
- **PROP-BOOT-004（やり直しで失わない）**：どの理由のやり直しでも、outbox の未確定のトランザクションが失われず、ちょうど 1 回確定するか拒否される。
- **PROP-BOOT-005（世代）**：DR の切り替え（最後の k 件を失い `sync_epoch` を上げる）の後、全クライアントがサーバーと一致し、切り替えの前 15 分以内に確定を見た自分の変更は、失われていれば 1 回だけ当たり直す。
- **PROP-BOOT-006（保持の境）**：保持のジョブと取り戻しが並行しても、`floor` より前の範囲を「ある」と答えない。

### 11.2 結合テスト

- 写しの読み取りの途中で書き込みがあっても、`s_min` の後の差分を当てた結果がサーバーと一致する（Aurora の reader、Testcontainers の PostgreSQL の両方）。
- 大きなチャンクの読み取りが reader で取り消されたとき、Sync API が読み直す。
- 被覆の鍵の形のうち、スキーマにないものが `400` になる。見てよくないグループの鍵が空になる。

### 11.3 障害注入とオフライン

- ブートストラップの途中でのタブの強制終了、ネットワークの切断、Sync API のタスクの喪失。
- 非公開への切り替えを、オフラインの端末で受ける（握手での消去）。
- 7 日と 31 日のオフラインの後の再接続（31 日は `too_old` のやり直しで outbox を送る）。
- 計測（E3）：基準のワークスペース（イシュー 50 万件）で、部分のブートストラップの操作できるまでの時間 p95 10 秒、手元からの起動 p95 1.5 秒（NFR-003）。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `schema-load-strategy` | スキーマの `load`（`instant`・`partial`・`lazy`）、`partial` の条件、`include`、被覆の鍵の生成（data-model-and-schema と共同） |
| E3 | `bootstrap-stream-api` | 4.2 節の API、チャンクの境、チャンクごとの写し |
| E3 | `bootstrap-client-writer` | 4.4 節の書き込み、`_meta.bootstrap` の状態、画面を先に出す |
| E3 | `bootstrap-resume` | 4.5 節の再開と `409 restart` |
| E3 | `bootstrap-kind-threshold` | 4.1 節の全体と部分の切り替え、`workspace_stats` |
| E3 | `local-bootstrap` | 5 節の手元からの起動と時間の予算 |
| E3 | `lazy-load-api` | 6.1 節の API、まとめ、ページング、`min_sync_id` |
| E3 | `partial-index-coverage` | 6.2・6.3 節の被覆と突き合わせ |
| E3 | `tombstones` | 6.4 節の墓標と 15 分の規則 |
| E3 | `sync-subscriptions` | 7.1・7.2 節の表、Writer での計算、Gateway の購読の変化 |
| E3 | `group-join-bootstrap` | 7.3 節 |
| E3 | `group-leave-purge` | 7.4・7.5 節（握手での差を含む） |
| E3 | `cross-group-move` | 7.7 節と依存の行の移動、Worker の続き |
| E4 | `team-privacy-toggle` | 7.8 節の同期の側（permissions-and-teams の同名の Story と 1 つ） |
| E4 | `workspace-removal-purge` | 7.6 節 |
| E3 | `sync-log-retention` | 8.1 節の保持のジョブと `floor` |
| E3 | `reset-bootstrap` | 8.2 節のやり直しと、outbox を残す手順 |
| E12 | `sync-epoch-dr` | 8.3 節の `sync_epoch` と、直近の確定の送り直し。DR の訓練で確かめる |
| E3 | `stale-outbox-review` | 8.4 節の 90 日を超えた outbox の確認の画面 |
| E3 | `bootstrap-sim-props` | 11.1 節の PROP-BOOT-001〜006 |
| E12 | `bootstrap-load-test` | 最大のワークスペースの部分のブートストラップと、やり直しの殺到の負荷試験 |

## 13. 未解決の問い

### 決定

2026-09-28 の既定案。E3 の PoC と法務の L5 で覆りうる。

- **全体と部分の閾値**：見てよいモデルの数 5 万件（ADR-0003 の仮の値のまま）。
- **部分のイシューの条件**：未完了と、30 日以内に完了・取り消したもの（ADR-0003 の仮の値のまま）。
- **チャンク**：ID の範囲で 2 万行、読み取り 10 秒以内（ADR-0011）。
- **ストリームの形**：NDJSON、`rows` は 1,000 行、br か gzip（ADR-0011）。
- **墓標の期間**：15 分。応答が 15 分を超えたら捨てる（ADR-0012）。
- **参照のたどり方**：スキーマの `include` だけ。3 段のたどりはしない（ADR-0012）。
- **同期のログの保持**：30 日。`tx_results` は 90 日（ADR-0013）。
- **やり直しの閾値**：取り戻しが 5 万件を超えたら（ADR-0003 の仮の値のまま）。
- **`sync_epoch`**：DR の切り替えと PITR で上げる。確定した outbox を 15 分残して送り直す（ADR-0013）。
- **グループの一斉の読み込み**：0〜30 秒の乱数。S1 ではグループの写しをキャッシュしない。
- **除外されたワークスペースの手元**：outbox ごと消し、件数を示す。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 部分のブートストラップが基準の端末で p95 10 秒に収まるか（IndexedDB の一括の書き込み） | E3 の前の `bootstrap-poc`。収まらなければ SQLite の WASM への切り替えの ADR（ADR-0005 の代案） |
| Aurora の reader での `REPEATABLE READ` の 10 秒の読み取りが取り消されないか（取り消しの仕組みと 30 秒の上限は確かめた。4.3 節） | E3 の前の `bootstrap-poc` |
| 同期のログの保持の期間（30 日） | 法務の L5 と、やり直しの頻度の計測（E3） |
| グループと `as_of` の組での写しのキャッシュ | 非公開 → 公開の切り替えの負荷を E12 で測って決める |
| 部分のイシューの条件に、自分の担当・購読の古い完了のイシューを足すか | 試用のチームの声（オフラインで見たいもの） |
| 本家の同期のログの保持の期間 | 公開の資料では確かめられない（**未検証**のまま） |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- ブートストラップの種類ごとの操作できるまでの時間 p50・p95（NFR-003）。ダウンロード・解析・IndexedDB の書き込みの内訳。
- 手元からの起動の時間 p95（NFR-003 の 1.5 秒）。
- やり直しの回数と理由ごとの割合（`too_old`・`too_far`・`epoch`・`ahead`・`migration`・`corrupt`）。`corrupt` の増加は保存の消去の目安。
- 中断からの再開の回数と、`409 restart` の割合。
- 遅延の読み込みの p95 と、被覆のない単位を開いた回数。
- 脱退の消去の時間と、消去の後の配信の監査の不一致 0 件（NFR-008）。
- 本番の抜き取り：クライアントの手元の行の `_g` が、今の購読の部分集合であること。

### runbooks

- `bootstrap-overload.md`：Sync API・reader の負荷が高いときの確かめ方（一斉のやり直し、公開への切り替え、デプロイ）と、受け付けの上限と `retry_after_ms` の引き上げ。
- `sync-log-retention.md`：保持のジョブの確かめ方、`floor` の確認、パーティションの落とし忘れの対処。
- `workspace-restore-and-epoch.md`（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の D にまとめた）：ワークスペースを PITR で戻す手順。必ず `sync_epoch` を上げることと、その後のやり直しの見守り。
- `private-team-leak-response.md`：非公開のチームのデータが見てよくないクライアントへ届いた疑いのときの手順（配信の監査の確認、該当の接続の `kick`、手元の消去の強制）。

### data-model（索引への追加の提案）

| 表・store | 中身 | 節 |
| --- | --- | --- |
| `sync_subscriptions` | 同期グループの購読（`SyncSubscription` のモデル） | 7.1 |
| `workspace_stats` | グループごとのモデルの数の見積もり（全体と部分の切り替え） | 4.1 |
| `workspace_sync.floor_sync_id`・`sync_epoch` | 保持の境、番号の世代 | 8.1、8.3 |
| モデルの行の `sync_groups`（手元は `_g`） | 行の同期グループ | 7.1 |
| 手元の `_partial_indexes` | 被覆の鍵、`as_of`、`groups` | 6.2 |
| 手元の `_tombstones` | 削除・`evict` の墓標（15 分） | 6.4 |
| 手元の `_meta.bootstrap`・`_meta.reset` | ブートストラップの状態、チャンクの境、やり直しの理由 | 3.2、8.2 |

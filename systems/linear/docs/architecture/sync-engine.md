# Sync Engine: Linear

同期エンジンの核。クライアントのオブジェクトプールとトランザクション、Writer の検証と適用、`sync_id` と `sync_actions`、差分の形と配信、欠けの検出、載せ直し（rebase）、フィールドの型ごとの競合の規則、分数インデックスの鍵、Sync Gateway のプロトコル、冪等性、収束を確かめる決定的なシミュレーターを決める。

前提となる決定は、基盤と部品（[ADR-0001](../decisions/0001-platform-and-stack.md)）、同期のモデル（[ADR-0002](../decisions/0002-sync-model.md)）、ブートストラップと同期グループ（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)）、テナントと権限（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、手元の保存と outbox（[ADR-0005](../decisions/0005-client-persistence-and-offline.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-transactions-writer-and-idempotency.md) | トランザクションは「意図」の操作の列で、全体が確定か拒否のどちらか。Writer はワークスペースの行を最初にロックし、検証・適用・`sync_actions`・結果の記録を 1 つの DB のトランザクションで書く。結果は `(workspace_id, client_tx_id)` で 90 日持ち、再送には同じ結果を返す |
| [0007](../decisions/0007-sync-actions-and-range-proof-deltas.md) | `sync_id` は変更（sync action）ごとに振り、ワークスペースの中で欠けなく続く。差分は `(from, to]` の範囲の証明つきのパケットで送り、クライアントは範囲の連続で欠けを見つける。Gateway は絞る前の列の連続を自分で確かめてから範囲を名乗る。`update` は変更後の行の全体を運ぶ |
| [0008](../decisions/0008-conflict-rules-and-fractional-keys.md) | 競合の規則はスキーマの `conflict` で 1 か所に書く。並びの鍵は base-62 の分数インデックスで、範囲（`order_scope`）ごとに一意。重なりは Writer が振り直し、48 バイトを超えたら近くの兄弟の窓だけを振り直す。上書きは、フィールドごとの最後の `sync_id` で見つけて履歴に残す |
| [0009](../decisions/0009-sync-gateway-protocol.md) | Gateway のプロトコルは WebSocket の上の JSON のテキストフレーム。認証は最初のメッセージの 60 秒・1 回限りのチケット。`hello` の握手の決定表で、続き・取り戻し・やり直しを決める。取り戻しは Sync API の HTTP で行い、Gateway は生の差分だけを流す |
| [0010](../decisions/0010-deterministic-sync-simulator.md) | 収束は、1 つのプロセスで本物の同期のコード（クライアント・Writer の規則・Gateway の絞り込み）を動かす、シードから再現できるシミュレーターで確かめる。PR ごとに 2,000 の列、夜間に 20 万の列。失敗したシードは回帰テストに残す |

## 1. 目的と範囲

- 扱う：
  - クライアントのオブジェクトプール、モデルの状態の 2 層（確定・未確定）、トランザクションの形と一生
  - Writer の検証・適用・`sync_id` の振り方・冪等性
  - `sync_actions` の形、Relay と Gateway の配信、範囲の証明、欠けの検出と取り戻し
  - 載せ直し、フィールドの型ごとの競合の規則、分数インデックス、上書きの記録
  - Sync Gateway のプロトコル（メッセージ、握手、心拍、切断、背圧）
  - 決定的なシミュレーターと、収束の性質
- 扱わない：
  - ブートストラップ、遅延の読み込み、同期グループの変化、ログの保持とやり直し（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md)）
  - IndexedDB の構成、outbox の保存、複数のタブ、手元の移行、メモリー（[client-store-and-offline.md](client-store-and-offline.md)）
  - モデルの定義の言語とコードの生成（[data-model-and-schema.md](data-model-and-schema.md)）
  - 本文の CRDT の部品と保存の形（[editor-and-descriptions.md](editor-and-descriptions.md)）
  - `can()` の決定表（[permissions-and-teams.md](permissions-and-teams.md)）
  - Gateway の配置、再接続の殺到の容量（[infrastructure.md](infrastructure.md)・[capacity.md](capacity.md)）

## 2. 本家の形（確かめたこと）

公式の資料と、第三者の解析を分けて書く。いずれも 2026-09-28 に確認。

### 2.1 公式

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 同期 | 変更をリアルタイムで同期する。つながらないときは手元に保存し、つながったら再送する。再起動の後も再送する | [Download Linear](https://linear.app/docs/get-the-app) |
| 未送信の表示 | 送る変更が多いとき、ワークスペースの名前の横に「Syncing」と件数を出す | 同上 |
| オフラインの上書き | オフラインで多くの編集をすると、他の人の変更を上書きしうる。変更の作成の時刻を比べないため。オフラインは「失敗への備え」の位置付け | 同上 |
| 講演 | 同期エンジンの拡大の課題と、API の形の変化を話した講演がある。ページには動画の案内だけがあり、技術の詳細は本文にない | [Scaling the Linear Sync Engine](https://linear.app/now/scaling-the-linear-sync-engine)（2023-06-29） |

### 2.2 第三者の解析（本家の保証ではない）

| 項目 | 解析の内容 | 出典 |
| --- | --- | --- |
| オブジェクトプール | `SyncClient` がモデルを UUID で引く表を持つ。`ModelRegistry` がモデル（約 80 種）とプロパティのメタデータを持ち、スキーマのハッシュを計算する | [wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine) |
| トランザクション | 作成・更新・削除・アーカイブ・アーカイブの解除の 5 種。マイクロタスクでまとめ、IndexedDB の表に保存し、1 つの GraphQL の mutation にまとめて送る。応答で各 mutation の `lastSyncId` を受け、その差分が届くまで `completedButUnsyncedTransactions` に持つ | 同上 |
| 冪等性 | 送った後、応答の前にクライアントが落ちると、同じ変更が 2 回効きうる。まれとして受け入れている | 同上 |
| 差分 | パケットは sync action の配列。各要素は `id`（sync の番号）、`modelName`、`modelId`、`action`、`data`。`action` は I・U・A・D・V と、C（部分の索引の印）、G・S（同期グループの変化） | 同上 |
| 欠け | WebSocket の握手の後、手元とサーバーの `lastSyncId` を比べ、違えば履歴の API から取り戻す | 同上、[Reverse engineering Linear's sync magic](https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/)（2022-12-20） |
| 競合 | 大部分は LWW。CRDT は本文だけ | [architecture/README.md](README.md) の 1.3 節（講演の要約。第三者） |

- 本家の `lastSyncId` は全ワークスペースで共通の 1 つの数である（第三者の解析だけで確認。自分のワークスペースの続く変更の間で数が飛ぶことからの推定。本家の保証ではない。README の 1.3 節）。本システムはワークスペースごとの `sync_id` にする（ADR-0002）。
- 本家の WebSocket のメッセージの形（`{"cmd": "sync", ...}` など）は、2022 年の観察による。今の形は**未検証**。
- この設計は、上の考え方を参考にするが、コードも SDK も使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。本家の冪等性の弱さ（送信の後に落ちると 2 回効く）は、`client_tx_id` で除く（ADR-0006）。

### 2.3 他の方式との比較（参考）

| 項目 | この設計 | Replicache | Zero |
| --- | --- | --- | --- |
| 未確定の変更 | outbox の列。確定を差分で確かめてから消す | 保留の mutation の列。`lastMutationID` 以下を消す | 同じ系統（Replicache の後継） |
| 載せ直し | 確定した状態に差分を当て、未確定の列を当て直す | 確定した版まで戻し、差分を当て、保留を再生する | — |
| サーバーの順序 | ワークスペースの `sync_id` | クッキー（サーバーの状態を表す不透明な値） | — |
| 配る単位 | 同期グループ（権限と同じ単位） | クライアントの見え方（Client View） | 画面の問い合わせ |

出典：[How Replicache works](https://doc.replicache.dev/concepts/how-it-works)、[Zero の概要](https://zero.rocicorp.dev/docs/introduction)（いずれも 2026-09-28 に確認）。考え方の比較だけに使う（ADR-0001）。

## 3. 構成と流れ

```
 クライアント（書き手のタブ）
   UI ─ 操作 ─▶ Tx を作る ─▶ オブジェクトプール（pending に積み、画面に当てる）─▶ 描画
                     │ 同じイベントループの回の Tx をまとめて
                     ▼
                IndexedDB `_outbox` にコミット（strict）─▶ submit（WebSocket）
                                                               │
 Sync Gateway ◀────────────────────────────────────────────────┘
   │ submit を Writer へ（内部の HTTP/2。workspace_id を付ける）
   ▼
 Writer：ワークスペースの行をロック → Tx ごとに検証・適用・sync_actions → tx_results → sync_outbox → COMMIT
   │ ack（Tx ごとの結果）を Gateway へ返す ──────────────▶ クライアントへ ack
   ▼
 Aurora：sync_outbox ──▶ Relay（ワークスペースの順に読む）──▶ Valkey（ワークスペースごとのチャンネル）
                                                                    │ 絞る前の差分（連続した範囲）
                                                                    ▼
 Sync Gateway：ワークスペースの列の連続を確かめる → 接続ごとに同期グループで絞る → deltas {from, to}
                                                                    │
                                                                    ▼
 クライアント：範囲の連続を確かめる → IndexedDB に保存（モデル・_meta・確定した outbox の削除）→ メモリーに当て、pending を当て直す
```

- ack と差分は別の経路で届く。順序は揺れる。クライアントは両方をそろえて使う（6 節）。
- Public API と Worker の書き込みも、同じ Writer を通る（README の 1.2 節）。送り手に WebSocket がないだけで、`sync_actions` と配信は同じである。

## 4. クライアントのオブジェクトプールとトランザクション

### 4.1 オブジェクトプール

- ワークスペースごとに 1 つのプール。`Map<model_name, Map<id, Model>>` と、スキーマが宣言した索引（例：`Comment.issue_id`）を持つ。
- 各モデルは 2 層を持つ（ADR-0002）。
  - `confirmed`：確定した行。差分を `sync_id` の順に当てたもの。
  - `pending`：そのモデルに触れる未確定の操作（outbox の順）。
- 画面が読む値は `view = apply(confirmed, pending)`。プールは `pendingByModel`（モデルの ID → 未確定の操作の列）を持ち、差分が触れたモデルだけを計算し直す。全体の未確定の列を毎回当て直さない。7 日のオフラインで 1 万件を超える未確定があっても、差分 1 件の当て直しは触れたモデルの数に比例する。
- 反応型のストア（MobX か自前か）は E2 の PoC で決める（ADR-0001）。どちらでも、画面は `view` の値だけを読み、`confirmed` と `pending` に触れない。
- メモリーの階層（行だけ持つか、観測可能なオブジェクトにするか）は [client-store-and-offline.md](client-store-and-offline.md) の 7 節。

### 4.2 トランザクションの形

```json
{
  "id": "01926f3a-7c1e-7b2a-9d40-5b0c3e8f1a22",
  "fv": 3,
  "base": 18234,
  "at": "2026-09-28T01:02:03.456Z",
  "ops": [
    { "op": "create", "m": "Issue", "id": "01926f3a-…", "d": { "team_id": "…", "title": "…", "state_id": "…", "sort_key": "a0V" } },
    { "op": "set", "m": "Issue", "id": "…", "f": "priority", "v": 2 },
    { "op": "add", "m": "Issue", "id": "…", "f": "label_ids", "v": "…" },
    { "op": "remove", "m": "Issue", "id": "…", "f": "label_ids", "v": "…" },
    { "op": "incr", "m": "…", "id": "…", "f": "…", "n": 1 },
    { "op": "append", "m": "IssueDescription", "id": "…", "v": "<base64 の CRDT の更新>" },
    { "op": "archive", "m": "Issue", "id": "…" },
    { "op": "unarchive", "m": "Issue", "id": "…" },
    { "op": "delete", "m": "Comment", "id": "…" }
  ]
}
```

| フィールド | 意味 |
| --- | --- |
| `id` | `client_tx_id`。クライアントが UUIDv7 で振る。冪等性の鍵 |
| `fv` | トランザクションの形の版。サーバーは今の版と 1 つ前の版を、リリースから 30 日受ける（ADR-0005） |
| `base` | 作った時点で手元にあった `last_sync_id`。上書きの検出に使う（8.4 節） |
| `at` | クライアントの時刻。表示と調査のためだけに使い、順序には使わない |
| `ops` | 操作の列。意図で書く（位置は添字でなく、ID と並びの鍵で指す）。古い `base` の上で作った操作も、今の状態にそのまま当てられる |

- **原子性**：1 つのトランザクションは、全体が確定するか、全体が拒否されるかのどちらか。1 回の入力（キーの操作、ドラッグ、一括の編集の 1 回）が 1 つのトランザクションになる（ADR-0002）。
- **一括の編集**：選んだイシューが多いと、500 操作ずつの複数のトランザクションに分ける。分けた単位の間は原子的でない。画面は「n 件のうち m 件を反映」と示す。
- **ID**：作るモデルの ID はクライアントが UUIDv7 で振る。人が読む番号（`ENG-123`）は Writer が確定の時に振り、差分で届く（ADR-0002）。

### 4.3 上限

| 項目 | 上限 | 超えたら |
| --- | --- | --- |
| 1 トランザクションの操作 | 500 | クライアントが分ける（4.2 節） |
| 1 トランザクションの大きさ | 256 KiB（JSON） | 本文の大きな貼り付けは、CRDT の更新を複数のトランザクションに分ける |
| 1 回の `submit` | 100 トランザクション・1 MiB | 分けて送る |
| 送ったが ack のない `submit`（1 接続） | 4 個 | 次を送らずに待つ |
| 1 接続の送信の流量 | 平均 50 トランザクション/秒、瞬間 500 | `retry_later`（9.2 節）。取り消しではない |
| outbox の件数 | 5 万件・100 MiB | 新しい編集を止める（[client-store-and-offline.md](client-store-and-offline.md) の 5.3 節） |

### 4.4 トランザクションの状態

```
 created ──(outbox のコミット)──▶ queued ──(submit を送る)──▶ sent
    │                                  ▲                        │
    │ 1 秒コミットできない               │ 切断・retry_later        │ ack ok (s)          ack reject
    ▼                                  │                        ▼                         ▼
 unsaved（画面に「保存していない」）       └──────────────────── acked(s) ──(L ≥ s)──▶ done   rejected ──▶ _rejected へ
```

- `done` は、`s` までの差分を IndexedDB に保存したとき。同じ IndexedDB のトランザクションで outbox の行を消す（ADR-0005）。
- `acked(s)` のまま `pending` から外さない。`s` までの差分が届く前に外すと、画面が一瞬古い値に戻る（ADR-0002）。
- 送信の順は outbox の順（`seq`）。前のトランザクションの結果を待たずに続きを送ってよい（4.3 節の 4 個まで）。Writer は同じ接続の `submit` を順に処理する（5.2 節）ので、作成の後の更新が先に当たることはない。

## 5. Writer

ADR-0006。

### 5.1 入口

- Sync Gateway、Public API、Worker は、内部の HTTP/2 で Writer を呼ぶ。本文は `{workspace_id, actor, origin, txs[]}`。
  - `actor`：利用者の ID。Worker の定期処理（自動で閉じる、繰り越し）は `system`。
  - `origin`：`client`・`api`・`worker`・`notifier`（通知係。[notifications-and-inbox.md](notifications-and-inbox.md) の 5.5 節）・`import`。`sync_actions` に残し、調査と Webhook の発火の条件に使う。`import` のトランザクションだけは、`server_only` の一部のフィールド（`created_at`、作者、完了・取り消しの時刻）を操作の値で受け、Triage の入り口を当てない（DT-IMPORT-002。[import-export.md](import-export.md) の 5.2 節、[data-model-and-schema.md](data-model-and-schema.md) の 3.2 節の `import_writable`）。
- Writer はステートレスな ECS のサービス。ワークスペースの割り当てはしない。順序は DB の行のロックで決まる（ADR-0002）。

### 5.2 1 回の書き込みの手順

```sql
BEGIN;  -- READ COMMITTED
SET LOCAL app.workspace_id = $ws;                          -- RLS（ADR-0004）
SELECT last_sync_id, sync_epoch FROM workspace_sync
 WHERE workspace_id = $ws FOR UPDATE;                     -- (1) 最初にロック
-- (2) Tx ごとに：
SAVEPOINT tx_n;
  -- 冪等：tx_results に (ws, client_tx_id) があれば、前の結果を返して次へ
  -- 検証（5.3 節）→ 失敗なら ROLLBACK TO SAVEPOINT tx_n、拒否を tx_results に記録
  -- 適用：モデルの表を書き、sync_id を next, next+1, … と振って sync_actions を書く
  -- tx_results に (ws, client_tx_id, 'ok', 最後の sync_id) を書く
RELEASE SAVEPOINT tx_n;
-- (3)
UPDATE workspace_sync SET last_sync_id = $last WHERE workspace_id = $ws;
INSERT INTO sync_outbox (workspace_id, from_sync_id, to_sync_id) VALUES ($ws, $first - 1, $last);
COMMIT;
```

- **ロックを最初に取る。** 検証の読み出しと適用の間に、他の書き込みが入らない。削除された親への参照、循環、並びの鍵の重なりを、ロックの中で確かめられる。代わりに、ロックの保持の時間が検証の時間だけ伸びる。1 トランザクションの検証と適用を 2ms 以内に収め、S1 の 1 ワークスペースの上限（1 秒 300 件。README の 2 節）を E2 の PoC で確かめる。足りなければ、ロックの前に検証して、ロックの中で読んだ行の `updated_sync_id` が変わっていないことを確かめる方式（楽観的な検証）に替える ADR を書く。
- **`sync_id` は変更（sync action）ごとに 1 つ振る。** ワークスペースの中で欠けなく続く。拒否したトランザクションは番号を使わない（ロールバックするので）。トランザクションの確定の `sync_id` は、その最後の変更の番号である（ADR-0007）。
- **拒否も記録する。** 拒否の結果を `tx_results` に書くので、再送にも同じ拒否を返せる。拒否は `sync_actions` に載せない（ADR-0002）。
- **再試行できる失敗**（ロックの待ちの時間切れ、DB のフェイルオーバー、直列化の失敗）は、トランザクションを拒否しない。Writer は全体をロールバックし、Gateway に `retry` を返す。クライアントは同じ `client_tx_id` で送り直す。
- **ロックの待ち**：`lock_timeout = 2s`。大きな一括の書き込み（インポート）が他の利用者を待たせないよう、インポートは 1 回の DB のトランザクションを 200 件までにする（import-export の領域）。

### 5.3 検証

クライアントと同じモデルの定義のコード（共有のパッケージ）で行う。サーバーの判定が正である（ADR-0002）。上から順に評価し、最初に当たった行で決める。

| # | 条件 | 結果 | コード |
| --- | --- | --- | --- |
| 1 | `fv` が受け付ける版にない | 全体を拒否しない。`submit` 全体に `upgrade_required` | — |
| 2 | 同じ `client_tx_id` の結果がある | 前の結果を返す（適用しない） | 前の結果 |
| 3 | トランザクションが上限（4.3 節）を超える | 拒否 | `too_large` |
| 4 | 対象のモデルが存在しない（`create` 以外） | 拒否 | `not_found` |
| 5 | 対象のモデルが削除済み | 拒否 | `deleted` |
| 6 | `can(actor, action, model)` が偽。移動なら前と後の両方で判定 | 拒否 | `forbidden` |
| 7 | 型・範囲・列挙の外の値。スキーマにないフィールド | 拒否 | `invalid` |
| 8 | 参照先が存在しない・削除済み・見てよくない | 拒否 | `invalid_reference` |
| 9 | 親の変更で循環ができる | 拒否 | `cycle` |
| 10 | ワークフローの規則に反する（例：`Duplicate` を利用者が付ける） | 拒否 | `workflow_violation` |
| 11 | `create` の ID が既にある | 拒否 | `duplicate_id` |
| 12 | 並びの鍵が重なる・長すぎる | 受け付け、Writer が書き換える（8.3 節） | ok（`server_ops` あり） |
| 13 | それ以外 | 受け付け | ok |

- 行 8 の「見てよくない」：参照先が、`actor` の購読しない同期グループにある場合。存在を明かさないよう、`not_found` と区別しない理由の文言にする（ADR-0004）。
- アーカイブしたモデルへの `update` は受け付ける（ADR-0002）。規則の細部は issues-and-workflow の領域の決定表にする。
- 検証の失敗の `detail` には、モデルの名前・ID・フィールドの名前だけを入れる。値を入れない。

### 5.4 冪等性の記録

```sql
CREATE TABLE tx_results (
  workspace_id  uuid        NOT NULL,
  client_tx_id  uuid        NOT NULL,
  created_on    date        NOT NULL,   -- パーティションの鍵（記録した日）
  status        smallint    NOT NULL,   -- 1 = ok, 2 = rejected
  sync_id       bigint,                 -- ok のとき、最後の sync_id
  reject_code   text,
  server_ops    jsonb,                  -- Writer が書き換えた値（並びの鍵など）
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, client_tx_id, created_on)
) PARTITION BY RANGE (created_on);
```

- 90 日持つ（ADR-0005）。日ごとのパーティションで持ち、古いものを落とす。
- パーティションの鍵を主キーに含めるので、`(workspace_id, client_tx_id)` の一意は DB で強制しない。Writer がワークスペースの行のロックの中で先に引く。UUIDv7 の ID は「ID の時刻 − 1 日」の日から今日までのパーティションだけを引き、UUIDv5 の ID（公開 API の `Idempotency-Key`、参加、連携の事象。サーバーの主体だけが使い、クライアントの `submit` では受けない）は全部を引く（[data-model/sync.md](data-model/sync.md) の `tx_results`。2026-09-28 に足した）。
- 90 日より古いトランザクションは、クライアントが自動では送らない（ADR-0005、[client-store-and-offline.md](client-store-and-offline.md) の 5.4 節）。重複を見分けられないため。
- `client_tx_id` の UUIDv7 の時刻が、今より 1 日以上先のものは拒否する（`invalid`）。時計の狂った端末の ID が、記録の保持の計算を壊さないため。

## 6. 載せ直し（rebase）

ADR-0006、ADR-0002。

### 6.1 規則

| 受けたもの | クライアントの処理 |
| --- | --- |
| 他の人の差分（`update` など） | `confirmed` に当てる。そのモデルの `pending` を当て直して `view` を作る。同じフィールドに自分の未確定の値があれば、画面は自分の値のまま |
| 自分の ack（ok、`s`） | トランザクションを `acked(s)` にする。`server_ops` があれば、同じ操作を `pending` の中で書き換える（例：並びの鍵）。まだ `pending` から外さない |
| 差分で `L ≥ s` になった | `acked(s)` のトランザクションを `pending` から外す（`done`）。差分に自分の変更が含まれているので、`view` は変わらない |
| 自分の ack（reject） | トランザクションを `pending` から外し、触れたモデルの `view` を作り直し、`_rejected` に理由を書き、画面に短く示す |
| `retry` / `retry_later` | 状態を `queued` に戻す。待ってから同じ `client_tx_id` で送る |
| 他の人の `delete`・`evict` | `confirmed` から消す。そのモデルへの自分の `pending` は残す（サーバーが拒否するまで）。`view` では消えたものとして扱う |

- **依存する後のトランザクション**：作成が拒否されると、そのモデルへの後の更新は、サーバーで `not_found` として拒否される。クライアントは先回りして捨てない。拒否の判断をサーバーの 1 か所に保つため。
- **ちらつきの防止**：ack と差分の順序が揺れても、`L ≥ s` まで `pending` に残すので、画面は自分の値から動かない（ADR-0002）。

### 6.2 1 つのモデルの `view` の計算

```
view(m) = fold(pendingByModel[m], confirmed[m], applyOp)
applyOp(row, set(f, v))        = row with f = v
applyOp(row, add(f, x))        = row with f = f ∪ {x}
applyOp(row, remove(f, x))     = row with f = f \ {x}
applyOp(row, incr(f, n))       = row with f = f + n
applyOp(row, append(u))        = CRDT に u を合わせる（本文の部品）
applyOp(row, archive)          = row with archived_at = 手元の時刻（仮）
applyOp(null, create(d))       = d
applyOp(row, delete)           = null
applyOp(null, set/add/…)       = null（対象がない。サーバーで拒否される）
```

- `applyOp` は、Writer がサーバーで使う関数と同じコードである（ADR-0001）。クライアントとサーバーで違う結果にならない。

## 7. `sync_actions` と差分

ADR-0007。

### 7.1 表

```sql
CREATE TABLE workspace_sync (
  workspace_id   uuid     PRIMARY KEY,
  last_sync_id   bigint   NOT NULL,        -- 最後に振った番号
  floor_sync_id  bigint   NOT NULL,        -- ログに残る最も古い番号の 1 つ前（保持の外）
  sync_epoch     integer  NOT NULL DEFAULT 1  -- 番号の世代。DR の切り替え・復元で上げる
);

CREATE TABLE sync_actions (
  workspace_id   uuid        NOT NULL,
  sync_id        bigint      NOT NULL,
  created_on     date        NOT NULL,     -- パーティションの鍵（日ごと）
  tx_id          uuid        NOT NULL,     -- client_tx_id、またはサーバーが振った ID
  tx_end         boolean     NOT NULL,     -- トランザクションの最後の変更
  origin         smallint    NOT NULL,
  actor_id       uuid,
  model          text        NOT NULL,
  model_id       uuid        NOT NULL,
  action         smallint    NOT NULL,     -- 7.2 節
  data           jsonb,                    -- 7.2 節
  changed        text[],                   -- update で変わったフィールド
  groups         text[]      NOT NULL,     -- 変更の後の同期グループ
  groups_before  text[],                   -- グループが変わったときだけ
  PRIMARY KEY (workspace_id, sync_id, created_on)
) PARTITION BY RANGE (created_on);

CREATE INDEX sync_actions_model_idx
  ON sync_actions (workspace_id, model, model_id, sync_id);   -- updatedFrom（api-and-webhooks の 5.5 節）、収束の監査（observability の 4.2 節）

CREATE TABLE sync_outbox (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid   NOT NULL,
  from_sync_id  bigint NOT NULL,   -- (from, to]
  to_sync_id    bigint NOT NULL,
  committed_at  timestamptz NOT NULL,  -- Writer の COMMIT の直前の時刻（伝播の計測。observability の 3.3 節）
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

- `sync_outbox` は RLS の外に置く（[data-model.md](data-model.md) の 5 節）。Relay が全ワークスペースの行を順に読むため。行は `workspace_id` と番号の範囲と時刻だけを持ち、中身を持たない。Relay は範囲の `sync_actions` を、行の `workspace_id` で `SET LOCAL` してから読む。

- `sync_actions` は日ごとのパーティション。保持の期間（仮に 30 日）を過ぎたパーティションを落とす（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 8 節）。パーティションの鍵を主キーに含める必要があるので、`(workspace_id, sync_id)` の一意は DB では強制しない。ワークスペースの行のロックが一意を保証する。
- `workspace_sync` は RLS の対象（ADR-0004）。保持のジョブと DR の手順だけが `floor_sync_id` と `sync_epoch` を書く。

### 7.2 変更の種類

| `action` | 意味 | `data` |
| --- | --- | --- |
| `insert` | 作成 | 行の全体 |
| `update` | フィールドの変更、集合の追加・削除、加算の結果、グループの移動 | **変更後の行の全体**と `changed` |
| `append` | 本文の CRDT の更新 | 更新のバイト列（base64） |
| `archive` / `unarchive` | アーカイブとその解除 | 行の全体 |
| `delete` | 削除 | なし |

- `update` に行の全体を載せる理由：遅延のモデル（コメントなど）の行が手元になくても、差分だけで行を作れる。ADR-0003 は「購読しているグループの差分は、遅延のモデルのものも含めて、すべて受けて IndexedDB に書く」と決めており、変わったフィールドだけでは行を書けない。イシューの行は、本文（別のモデル）を除けば 1〜2 KB ほどで、ログの量は許容できる（S1 で 1 日 800 万行の見込み。README の 2 節）。
- 本文の CRDT は `append` で送る。行の全体を持たないモデルなので、手元に状態がないクライアントは、読み込むまで `append` を IndexedDB の保留の store に貯める（editor-and-descriptions の領域で決める）。
- 同期グループへの参加・脱退は、`SyncSubscription` モデル（`user:<id>` のグループ）の `insert`・`delete` で表す（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7 節）。専用の `action` を足さない。
- Gateway が作る `evict`（手元から消す）は、ログには書かない。グループの移動（`groups_before` あり）を、前のグループだけを購読する接続へ送るときに作る（7.4 節）。

### 7.3 Relay

- Relay は `sync_outbox` を `id` の順に読み、範囲の `sync_actions` を読んで、Valkey のワークスペースのチャンネル（`sync:<workspace_id>`）へ 1 つのメッセージで出す。メッセージは `{from, to, actions[]}` で、絞る前の全体の列である。
- 同じワークスペースの範囲を、1 つの Relay のタスクだけが順に出す。Relay のタスクは、`hash(workspace_id)` の区画を担当する。担当の割り当てと交代は、Slack の Relay（[realtime.md](../../../slack/docs/architecture/realtime.md) の 11 節）と同じ考え方にする。
- Relay は `LISTEN/NOTIFY` で起こされ、50ms ごとの読み出しを取りこぼしの備えにする。
- 1 メッセージは 1 MiB まで。大きい範囲は、トランザクションの境（`tx_end`）で分ける。
- S2 では Valkey のクラスタで sharded pub/sub（`SPUBLISH`・`SSUBSCRIBE`）にする（Slack の realtime.md の 13 節と同じ）。

### 7.4 Gateway での絞り込みと範囲の証明

Gateway は、接続のあるワークスペースごとに、次の状態を持つ。

```
head[ws]      : 絞る前の列で、欠けなく受けた最後の sync_id
buffer[ws]    : head より先に届いた範囲（欠けが埋まるまで持つ）
conns[ws]     : 接続ごとの { groups: Set, sent_to: sync_id, queue }
```

1. Valkey から `{from, to, actions}` を受ける。
2. `from == head` なら当てる。`from > head` なら欠けとして `buffer` に置き、Aurora の reader から `(head, from]` を読む（reader が追いついていなければ 50ms おきに 2 秒まで読み直し、だめなら writer から読む）。`to ≤ head` は重複として捨てる。
3. 欠けなく並んだ範囲について、各接続に対して、
   - `groups ∩ 接続の groups ≠ ∅` の変更を載せる。
   - `groups_before` があり、`groups_before ∩ 接続の groups ≠ ∅` かつ `groups ∩ 接続の groups = ∅` なら、`evict` を載せる。
   - `SyncSubscription` の変更が接続の利用者のものなら、**その sync_id の直後から**接続の `groups` を変える。絞る前の列を順に処理するので、どの接続でも、参加・脱退の位置が `sync_id` で決まる。
4. 接続へ `deltas {from: sent_to, to: 範囲の終わり, actions: [...]}` を送り、`sent_to` を進める。載せる変更が 0 件でも、1 秒に 1 回まで空のパケットで範囲を知らせる。
5. 範囲の終わりは、必ずトランザクションの境（`tx_end`）にする。クライアントが半分だけのトランザクションを当てる状態を作らない。

- **範囲の証明の意味**：`deltas {from: a, to: b}` は、「`(a, b]` のうち、この接続が見てよい変更は、これで全部」を表す。Gateway は、絞る前の列が `(a, b]` で欠けなく並んだときだけ、これを名乗る。
- 絞り込みは、権限の関数（ADR-0004）から導いた接続の `groups` だけで決める。Gateway は、行の中身を見て権限を判断しない。

### 7.5 クライアントでの欠けの検出

手元の `L`（`_meta.last_sync_id`）とパケットの `{from, to}` を比べる。

| 条件 | 処理 |
| --- | --- |
| `from == L` | 当てる。`L = to` |
| `from < L < to` | `sync_id > L` の変更だけを当てる。`L = to` |
| `to ≤ L` | 重複。捨てる |
| `from > L` | 欠け。パケットを持ったまま、Sync API で `(L, from]` を取り戻す（9.5 節）。そろったら順に当てる |

- 取り戻しの応答も、同じ範囲の形（`{from, to}` と変更の列）で返る。同じ判定で当てる。
- 持っておくパケットは 16 MiB まで。超えたら持ったものを捨て、`(L, 今の head]` をまとめて取り戻す。
- 1 つのパケットの保存は、1 つの IndexedDB のトランザクションで、モデルの行・`_meta.last_sync_id`・確定した outbox の行の削除をまとめて書く（ADR-0005、[client-store-and-offline.md](client-store-and-offline.md) の 4 節）。

### 7.6 伝播の遅延の予算（NFR-002：確定から他のクライアントの適用まで p99 1 秒）

| 区間 | 予算（p99） |
| --- | --- |
| Writer のコミット → Relay の読み出し（NOTIFY、取りこぼしは 50ms の読み出し） | 100ms |
| Relay → Valkey → Gateway | 50ms |
| Gateway の欠けの埋め（まれ。reader の遅れ） | 300ms |
| Gateway → クライアント（日本の中の回線） | 150ms |
| クライアントの IndexedDB の保存（relaxed）とメモリーへの適用 | 150ms |
| 余裕 | 250ms |

- 送信から ack まで p99 300ms（NFR-002）の内訳は、クライアント → Gateway 50ms、Gateway → Writer 10ms、ロックの待ちと検証と適用とコミット 150ms、戻り 60ms、余裕 30ms。
- 画面への反映は、IndexedDB の保存を待ってから行う。保存より先にメモリーへ当てると、保存の前にタブが落ちたとき、画面に出た値が手元にない状態になる。遅延の予算の中に保存を含めた。

## 8. 競合の規則

ADR-0008。規則はスキーマの `conflict` で 1 か所に書く。規則のないフィールドは、コードの生成で失敗させる（ADR-0002）。

### 8.1 スキーマでの書き方（例）

```ts
model("Issue", {
  groups: { rule: "team", from: "team_id" },           // team:<team_id>（data-model-and-schema の 3.5 節）
  fields: {
    title:      { type: "string",   conflict: "lww", max: 512 },
    state_id:   { type: "ref:WorkflowState", conflict: "lww" },
    priority:   { type: "int",      conflict: "lww", range: [0, 4] },
    label_ids:  { type: "set<ref:IssueLabel>", conflict: "set", max: 100 },
    sort_key:   { type: "order_key", conflict: "order", order_scope: ["team_id"] },
    sub_sort_key: { type: "order_key", conflict: "order", order_scope: ["parent_id"] },
    number:     { type: "int",      conflict: "server_only" },
  },
  track_overwrites: ["title", "state_id", "priority", "assignee_id", "estimate", "due_date", "cycle_id", "project_id", "parent_id"],
});
```

- `groups` は関数で書かず、名前の付いた規則と `from` の組（`{ rule, from }`）で書く（[ADR-0019](../decisions/0019-schema-definition-and-codegen.md)、[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節）。生成器が SQL とクライアントのコードの両方に訳すため。上の例は `conflict` と `order_scope` の書き方だけを示し、全部のフィールドは [data-model-and-schema.md](data-model-and-schema.md) の 3.1 節にある。

### 8.2 型ごとの規則

| `conflict` | 操作 | Writer での当て方 | 差分 |
| --- | --- | --- | --- |
| `lww` | `set` | 確定の順で後が勝つ。フィールドごとに独立 | 行の全体 |
| `set` | `add`・`remove` | その時点の集合に足す・除く。同じ要素への操作は後が勝つ。集合の全体を置き換える `set` を受けない | 行の全体 |
| `order` | `set`（鍵） | 鍵は LWW。重なり・長さは 8.3 節 | 行の全体。書き換えは ack の `server_ops` |
| `counter` | `incr` | 足す | 行の全体 |
| `server_only` | なし | Writer だけが書く（番号、作成の時刻） | 行の全体 |
| `crdt` | `append` | 更新をそのまま足す | `append` |

- 集計の値（完了したイシューの数、見積もりの合計）はフィールドに持たない（ADR-0002）。
- 削除・アーカイブ・親子の循環の規則は ADR-0002 と 5.3 節の決定表のとおり。

### 8.3 分数インデックスの鍵

- **形式**：ASCII の base-62（`0-9A-Za-z`）。先頭の 1 文字で整数部の長さを表し、末尾を `0` にしない。バイトの比較がそのまま順序になる。David Greenspan の「Implementing Fractional Indexing」と、それに基づく [rocicorp/fractional-indexing](https://github.com/rocicorp/fractional-indexing) の形式に倣う（2026-09-28 に確認）。コードは自前で書く（ADR-0001）。上限は 64 バイト。
- **作り方**：
  - 1 つのモデルを入れる・動かす：`key_between(前, 後)`。決定的。
  - 複数をまとめて入れる・動かす（一括の並べ替え、複製）：乱数の接頭辞 `p = key_between_jittered(前, 後)`（小数部に 4 文字の乱数）を作り、その後ろに `generate_n_keys` の鍵を付ける。2 人が同じ隙間へ同時にまとめて入れても、まとまりが交ざらない。同時に作ると鍵が重なりうることは、上のライブラリの説明にもある。
- **範囲**：鍵は `order_scope`（例：イシューの手動の並びはチーム、サブイシューの並びは親）の中で一意にする。Writer は `(workspace_id, scope…, sort_key)` の索引で重なりを調べる。
- **重なり**：当てる鍵が同じ範囲の別の行の鍵と等しければ、Writer は `key_between(重なった鍵, 次の鍵)` に書き換えて当てる。書き換えた値は、送り手には ack の `server_ops`、他の人には差分の行の全体で届く。
- **長さ**：当てた後の鍵が 48 バイトを超えたら、Writer は同じトランザクションの中で、その鍵の前後の 32 個ずつ（計 65 個）を、窓の外側の 2 つの鍵の間で `generate_n_keys` で振り直す。それでも 48 バイトを超えるなら、窓を 2 倍にし、1,024 個まで広げる。1,024 個で足りなければ、その範囲の全体の振り直しを Worker のジョブにする（システムのトランザクション）。ADR-0002 の「兄弟の鍵をまとめて振り直す」を、チームのイシュー（数十万件）でも 1 回の書き込みが大きくならない形にしたもの。
- **同じ隙間への同時の挿入**の交ざりは、1 つずつの挿入では起きうる（[Interleaving anomalies in collaborative text editors](https://martin.kleppmann.com/papers/interleaving-papoc19.pdf)、Kleppmann ほか、2019、2026-09-28 に確認）。課題管理の並べ替えは 1 件ずつが多く、交ざっても意味は壊れないので受け入れる。

### 8.4 上書きの記録

- `track_overwrites` に挙げたフィールドについて、行に `field_sync_ids jsonb`（フィールド → 最後に変えた `sync_id` と `actor_id`）を持つ。
- `set` を当てるとき、`field_sync_ids[f].sync_id > base` で、かつ `actor_id` が送り手と違えば、上書きである。Writer は同じトランザクションで、イシューの履歴に `overwrite { field, old_value, old_actor, old_sync_id }` を書く（履歴の形は issues-and-workflow の領域）。
- `base` の時刻（`sync_actions` の `created_on` と行の作成の時刻から引く。保持の外なら 30 日より前とみなす）が 1 時間以上前なら、ack の結果に `overwrote: [field…]` を付け、クライアントは本人に知らせる（ADR-0002）。
- 集合・並び・本文は上書きの記録の対象にしない。集合と本文は合わさり、並びは意図の衝突が小さいため。

## 9. Sync Gateway のプロトコル

ADR-0009。接続のライフサイクル（心拍、デプロイの時の穏やかな切り替え、受け付けの制限）は、Slack の [realtime.md](../../../slack/docs/architecture/realtime.md) の 3・8 節を先例にし、違うところだけを書く。

### 9.1 フレーム

- WebSocket のテキストフレーム。1 フレームに 1 つの JSON のメッセージ。`{"t": "<種類>", ...}` の形。
- 1 フレームの上限は 1 MiB。超えたら切る（`kick: frame_too_large`）。
- WebSocket の圧縮（permessage-deflate）は、差分の流れ（サーバー → クライアント）に使う（[ADR-0009](../decisions/0009-sync-gateway-protocol.md) の 2026-09-28 の注記）。
  | 項目 | 値 |
  | --- | --- |
  | サーバー → クライアント | 文脈の持ち越しあり、`server_max_window_bits=12`（4 KiB の窓）、zlib の `memLevel` 4。圧縮のメモリーは 1 接続 約 16 KiB |
  | クライアント → サーバー | `client_no_context_takeover`（`submit` は小さく、受ける側の窓のメモリーを持たない） |
  | 圧縮しないもの | 1 KiB 未満のフレーム（`ack`・`pong`・空の `deltas`） |
  | 止め方 | Ops のフラグ `ops.ws_deflate = false` で、新しい接続の交渉で拡張を返さない（今の接続はそのまま） |
  - 見込み：差分の JSON は同じキーの行が続くので、圧縮で送信の量が 3 分の 1〜4 分の 1 になると見込む（**未検証**。E12 の `cost-baseline` で測る）。
  - 文脈の持ち越しがあると、同じ `groups` の接続の間で圧縮したフレームを使い回せない（[capacity.md](capacity.md) の 3.2 節の直列化の使い回しは、圧縮の前の JSON まで）。E12 の負荷試験で、圧縮の率・Gateway の CPU・メモリーを、`server_no_context_takeover`（圧縮した 1 つのフレームを同じ `groups` の接続で使い回せる）と比べて、どちらにするかを確定する。
  - 取り戻しとブートストラップ（HTTP）は、これまでどおり br か gzip。

### 9.2 メッセージ

クライアント → サーバー：

| `t` | 中身 |
| --- | --- |
| `hello` | `v`（プロトコルの版）、`ticket`、`client_id`、`build`（殻とレンダラーの組 `shell@x.y.z+web@<hash>`。Web は `shell` を省く。[delivery.md](delivery.md) の 6 節）、`schema_hash`、`fv`（送る形の版）、`workspace_id`、`last_sync_id`、`sync_epoch`、`groups_hash`、`pending: {count, oldest_at, oldest_fv}` |
| `submit` | `req`（接続の中の連番）、`txs`（4.2 節の列） |
| `ping` | `ts`（画面が見えている間、30 秒ごと） |

サーバー → クライアント：

| `t` | 中身 |
| --- | --- |
| `welcome` | `session_id`、`head`（今の `last_sync_id`）、`live_from`（この接続の差分がどこから始まるか）、`sync_epoch`、`floor`、`groups`（今の購読の一覧）、`mode`（`resume`・`catch_up`・`reset`）、`reset_reason`、`send`（`ok`・`upgrade_required`）、`retry_after_ms`（やり直しを散らす待ち）、`lost_local`（ブラウザに消された未送信の件数。[client-store-and-offline.md](client-store-and-offline.md) の 9.3 節）、`min_build`、`limits`、`flags`（クライアントのフラグ。[delivery.md](delivery.md) の 3 節）、`audit_followup`（収束の監査の 2 段目の求め `{audit_id, model, buckets}`。[observability.md](observability.md) の 4.3 節） |
| `deltas` | `from`、`to`、`c`（範囲の最後のトランザクションの Writer のコミットの直前の時刻、ミリ秒。伝播の計測。[observability.md](observability.md) の 3.3 節）、`actions`（7.2 節。`[{s, tx, e, m, id, a, d, c, g}]`。`e` は `tx_end`、行の `c` は変わったフィールド） |
| `ack` | `req`、`results: [{id, ok: true, s, server_ops?, overwrote?} ｜ {id, ok: false, code, detail}]` |
| `retry` | `req`、`after_ms`（再試行できる失敗、流量の超過） |
| `kick` | `code`、`retry_after_ms` |
| `pong` | `ts`（`ping` の値をそのまま）、`g_in`・`g_out`（Gateway が `ping` を受けた時刻と `pong` を返した時刻。時計の差の見積もり。[observability.md](observability.md) の 3.3 節） |

`kick` のコード：

| `code` | 意味 | クライアント |
| --- | --- | --- |
| `forbidden` | ワークスペースのメンバーでなくなった | 接続を閉じる。手元の消去は [bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.6 節 |
| `session_revoked` | ログインのセッションが取り消された | ログインの画面へ |
| `upgrade_required` | `build < min_build`、または `schema_hash` が互換の一覧にない | 送信を止め、更新を促す。手元の読み書きと outbox への保存は続ける（ADR-0005） |
| `resync_required` | 送信の待ちがあふれた（9.6 節） | `L` から Sync API で取り戻してから再接続 |
| `epoch_changed` | `sync_epoch` が変わった（DR の切り替え、復元） | やり直しのブートストラップ |
| `overloaded`・`server_shutdown` | 混雑、デプロイ | `retry_after_ms` の後に再接続 |
| `frame_too_large`・`protocol_error` | クライアントの誤り | エラーの報告を送り、再接続（1 分に 3 回まで） |

### 9.3 接続の確立

```
Client                    Sync API                Gateway                     Aurora (reader)
  │ POST /sync/ticket ───▶│ セッションを確かめ、60 秒・1 回限りのチケット（Valkey に SHA-256 だけ）
  │◀── { ticket, url } ───│
  │ WSS 接続（URL にチケットを入れない）─────────────────▶│
  │ hello ─────────────────────────────────────────────▶│ チケットを GETDEL で消費。Origin を確かめる
  │                                                     │ can() から購読の groups を計算（ADR-0004）
  │                                                     │ workspace_sync を読む（head, floor, epoch）
  │                                                     │ 9.4 節の決定表で mode を決める
  │◀────────────────────────────────────────── welcome ─│ live_from = head。以後の差分を流し始める
  │ mode = catch_up：Sync API で (L, live_from] を取る（その間の deltas は持っておく）
  │ outbox の queued / sent を outbox の順に submit
```

- チケットを URL に入れないのは、プロキシとアクセスログに残るため。最初のメッセージで送る。
- `hello` が 10 秒以内に届かなければ切る。

### 9.4 握手の決定表

上から評価し、最初に当たった行で決める。

| # | 条件 | `mode` | `reset_reason` |
| --- | --- | --- | --- |
| 1 | `build < min_build`、または `schema_hash` が互換の一覧にない | `kick: upgrade_required` | — |
| 2 | `sync_epoch` が違う | `reset` | `epoch` |
| 3 | `last_sync_id > head` | `reset` | `ahead`（DR の後の取りこぼしなど） |
| 4 | `last_sync_id < floor` | `reset` | `too_old` |
| 5 | `head − last_sync_id > 50,000` | `reset` | `too_far` |
| 6 | `last_sync_id < head` | `catch_up` | — |
| 7 | それ以外 | `resume` | — |

- `groups_hash` が `welcome.groups` と違えば、どの `mode` でも、クライアントは先に購読の差を処理する（外れたグループの消去、加わったグループの部分のブートストラップ。[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.5 節）。
- `fv` が受け付ける版にないときは、`welcome.send = upgrade_required` にする。差分は受けるが、送らない（ADR-0005）。
- 行 5 の 50,000 は ADR-0003 の仮の値。E3 の PoC で、取り戻しとやり直しの時間を比べて決める。

### 9.5 取り戻し（Sync API）

```
GET /sync/deltas?workspace=…&after=L&until=H&limit=5000
→ 200 application/x-ndjson（br か gzip）
{"t":"range","from":L,"to":X}
{"s":…,"tx":…,"e":true,"m":"Issue","id":"…","a":"update","d":{…},"c":["state_id"],"g":["team:…"]}
…
{"t":"next","after":X}       // 続きがあるとき
```

- 同期グループの絞り込みは、Gateway と同じ関数で行う（ADR-0004）。`evict` も同じ規則で作る。
- `after < floor` なら `410 too_old`。クライアントはやり直しのブートストラップをする。
- 1 回の応答は 5,000 変更まで。範囲の終わりはトランザクションの境にする。

### 9.6 心拍・背圧・再接続

| 項目 | 値 |
| --- | --- |
| サーバーの WebSocket の ping フレーム | 20 秒ごと（ブラウザが自動で pong を返す） |
| クライアントの `ping` | 画面が見えている間 30 秒ごと。45 秒なにも受けなければ切って再接続 |
| 1 接続の送信の待ち | 4 MiB か、最も古い未送信が 10 秒 → `kick: resync_required` |
| 予期しない切断の後の最初の再接続 | 0〜5 秒の一様な乱数（Figma の multiplayer.md の 7.2 節と同じ） |
| 以後の再接続 | full jitter の指数（基数 1 秒、上限 30 秒）。`retry_after_ms` があれば従う |
| `online` イベント | 0〜2 秒の乱数の後に再接続 |
| 1 接続の拒否の多さ | 1 分に 100 回の拒否で `kick: protocol_error`（壊れたクライアントの暴走を止める） |

- 背景のタブ（書き手が隠れたタブ）では、ブラウザがタイマーを間引く。そこで、生存の確認をクライアントのタイマーに頼らず、サーバーの ping フレームで行う。Chrome は、5 分より長く隠れ、30 秒音がなく、WebRTC を使わないページで、5 回以上連鎖したタイマーを 1 分に 1 回まで間引く（[Heavy throttling of chained JS timers beginning in Chrome 88](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)、2026-09-28 に確認）。クライアントの 45 秒の無受信の判定は、この条件で遅れうるので、隠れたタブでは使わない。

## 10. 障害のときの振る舞い

| 障害 | 起きること | 回復 |
| --- | --- | --- |
| クライアントの接続が切れた | `sent` のトランザクションの結果が分からない | 再接続で `queued` と `sent` を送り直す。`tx_results` で前の結果が返る（PROP-SYNC-002） |
| Writer がコミットした後、ack の前に落ちた | ack が届かない | 同上。差分が先に届けば `L ≥ s` で `done` になるが、`s` を知らないので、送り直しの ack で知る |
| Relay が遅れる・落ちる | 差分が遅れる | 担当の交代。Gateway は欠けを reader から埋める |
| Valkey のメッセージが落ちた | Gateway の列に欠け | Gateway が reader から埋める（7.4 節） |
| Aurora の reader が遅れている | Gateway の埋めが遅れる | 2 秒で writer から読む |
| Gateway のタスクが落ちた | 接続がすべて切れる | 乱数の待ちで再接続。`L` からの取り戻し |
| Aurora のフェイルオーバー（AZ） | 書き込みが数十秒止まる | Writer は `retry` を返す。クライアントは outbox に貯める（NFR-006） |
| リージョンの切り替え（DR） | 最後の 1 分ほどの確定を失いうる（NFR-007） | `sync_epoch` を上げる。全クライアントがやり直し、outbox を送り直す。失った範囲のトランザクションは `tx_results` にないので、1 回だけ効く（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 8.3 節） |
| 1 ワークスペースの書き込みの集中 | ロックの待ちが伸びる | `lock_timeout` で `retry`。流量の上限。インポートの束を小さくする |
| クライアントとサーバーの規則の版の違い | 画面の `view` とサーバーの結果がずれる | 差分の行の全体で `confirmed` が正される。`schema_hash` の互換の一覧の外は `upgrade_required` |

## 11. セキュリティ

- すべての変更を Writer で検証する。クライアントの検証は、画面のためだけにある。
- 差分・取り戻しは、権限の関数から導いた同期グループだけで絞る（ADR-0004）。Gateway と Sync API は、行の中身で権限を判断しない。絞り込みの関数は 1 つにし、Gateway・Sync API・シミュレーターで同じコードを使う。
- 参照先を見てよくない変更の拒否は、存在を明かさない文言にする（5.3 節）。
- チケットは 60 秒・1 回限り。WebSocket の `Origin` を確かめる。
- `client_tx_id` は送り手のワークスペースの中でだけ意味を持つ。他のワークスペースの結果を引けない（主キーに `workspace_id`、RLS）。
- ログ・トレース・メトリクスには、`workspace_id`・`sync_id`・`client_tx_id`・モデルの名前・大きさ・理由のコードだけを書く。タイトル・本文・値を書かない。
- 配信の監査（README の NFR-008）：Gateway は送った変更の `groups` と、接続の `groups` の組を抜き取りで監査の流れへ出す。

## 12. テスト

### 12.1 決定的なシミュレーター（ADR-0010）

- 1 つのプロセスで、次の本物のコードを動かす。
  - クライアントの同期の核（プール、`pendingByModel`、欠けの検出、outbox の状態）。IndexedDB は、トランザクションの原子性と「落ちたら relaxed の最後の k 件を失う」を模したメモリーの実装に差し替える。
  - Writer の検証と適用の関数（モデルの定義のコード）。DB は、ワークスペースの行のロックを模したメモリーの実装。
  - Gateway の絞り込み、範囲の証明、欠けの埋め。
  - Sync API の取り戻しとブートストラップ。
- 乱数はシードから作る。時刻は仮想の時計。ネットワークは経路ごとの待ち行列で、接続の中の順序は保ち、経路の間（ack と差分）の順序は揺らす。
- 起こす出来事：操作、切断、再接続、クライアントの落ち（メモリーを失い、コミットした IndexedDB は残る）、Writer の ack の前の落ち、Valkey のメッセージの喪失・重複、Relay の遅れ、reader の遅れ、Gateway の落ち、グループの参加・脱退・移動・非公開への切り替え、保持の外への押し出し、DR の切り替え（最後の k 件を失い `sync_epoch` を上げる）、クライアントの版の更新（1 つ前の形の outbox）。
- fast-check でシードと出来事の列を作り、失敗したら縮める。縮めた列は `sim/regressions/<日付>-<短い名前>.json` に残し、毎回の CI で再生する。
- 回数：PR ごとに 2,000 の列（各 200 の出来事、クライアント 2〜6）。夜間に 20 万の列。同期エンジン・競合の規則・ブートストラップに触れる PR は、夜間と同じ回数を必須にする。

### 12.2 性質

- **PROP-SYNC-001（収束）**：任意の出来事の列で、操作が止み全員が追いついた後、各クライアントの `confirmed` と `view` が、そのクライアントが見てよい範囲のサーバーの状態と一致する（正準形のハッシュ）。
- **PROP-SYNC-002（ちょうど 1 回）**：同じ `client_tx_id` のトランザクションは、何回送っても、最大 1 回だけ効く。outbox にコミットしたトランザクションは、最終的に確定か拒否のどちらか 1 つの結果を持つ。
- **PROP-SYNC-003（欠けの検出の完全さ）**：クライアントの受けた範囲が `(0, L]` で連続していれば、`L` 以下の見てよい変更をすべて当てている。
- **PROP-SYNC-004（範囲の証明の正しさ）**：Gateway が送った `deltas {from, to}` の変更の集合は、サーバーのログの `(from, to]` を接続の `groups` で絞ったものと等しい。
- **PROP-SYNC-005（直列）**：サーバーの状態は、確定したトランザクションを `sync_id` の順に 1 つずつ当てた結果と等しい。
- **PROP-SYNC-006（ちらつきなし）**：自分の `set` が ack された後、`L ≥ s` になるまで、画面のそのフィールドの値は自分の値から変わらない。後に確定した他の人の値を除く。
- **PROP-SYNC-007（拒否の見せ方）**：拒否されたトランザクションは `view` から消え、`_rejected` にちょうど 1 件ある。
- **PROP-SYNC-008（並び）**：任意の挿入・移動の列の後、各 `order_scope` の中で鍵は一意で 64 バイト以下、全クライアントで同じ並び。まとめての挿入は、乱数の接頭辞が違う限り連続する。
- **PROP-SYNC-009（集合）**：同時の `add` を失わない。`remove` は、それより前に確定した `add` だけを打ち消す。
- **PROP-SYNC-010（上書きの記録）**：`base` より後に他の人が変えた `track_overwrites` のフィールドへの `set` は、必ず履歴に `overwrite` を 1 件残す。

### 12.3 結合・障害注入

- PostgreSQL（Testcontainers）で、2 つの Writer から同じワークスペースに同時に書き、`sync_id` の順とコミットの順が一致し、`sync_id > x` を読む読み手が見落とさないことを確かめる（ADR-0002 の Confirmation）。
- Writer の中の 5.3 節の決定表を、表駆動テストで全行確かめる。
- 障害注入（E12）：Writer のタスクの強制終了、Aurora のフェイルオーバー、Valkey の再起動、Relay の停止、Gateway のタスクの喪失、reader の遅れの注入。PROP-SYNC-001・002 を本物の構成で確かめる。
- 負荷（E12）：1 ワークスペースに 1 秒 300 件の書き込み、2,000 接続。送信から ack の p99 と、伝播の p99（NFR-002）。

### 12.4 オフラインと再送

[client-store-and-offline.md](client-store-and-offline.md) の 11 節の 3 つの場面（オフラインのまま再起動、送信の途中で落ちる、古い版の outbox を新しい版で送る）を、この領域の変更にも必須にする。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `schema-conflict-kinds` | スキーマの `conflict`・`order_scope`・`track_overwrites`・`groups` を必須にし、欠ければ生成を失敗させる（data-model-and-schema と共同） |
| E2 | `object-pool-two-layer` | プール、`confirmed`・`pendingByModel`・`view`、6.2 節の `applyOp` の共有 |
| E2 | `tx-format-and-lifecycle` | 4.2 節の形、4.4 節の状態、一括の編集の分割 |
| E2 | `writer-commit-path` | 5.2 節の手順、ロック、savepoint、`sync_outbox`、`retry` |
| E2 | `writer-validation-table` | 5.3 節の決定表と表駆動テスト |
| E2 | `tx-results-idempotency` | `tx_results`、再送に前の結果、90 日のパーティション |
| E2 | `sync-actions-log` | `sync_actions` の表と日ごとのパーティション、`update` の行の全体 |
| E2 | `relay-workspace-publish` | 7.3 節の Relay、区画の担当 |
| E2 | `gateway-range-proof` | 7.4 節の絞り込み、範囲の証明、欠けの埋め、`evict` |
| E2 | `client-gap-detection` | 7.5 節の判定、取り戻し、持つパケットの上限 |
| E2 | `sync-api-deltas` | 9.5 節の取り戻しの API |
| E2 | `gateway-protocol-handshake` | 9.2〜9.4 節のメッセージ、チケット、握手の決定表 |
| E2 | `rebase-and-ack` | 6 節の規則、ちらつきの防止、`server_ops` |
| E2 | `fractional-keys` | 8.3 節の鍵、乱数の接頭辞、重なりと窓の振り直し、Worker の全体の振り直し |
| E2 | `overwrite-record` | 8.4 節の `field_sync_ids`、履歴への記録、本人への通知 |
| E2 | `gateway-permessage-deflate` | 9.1 節の permessage-deflate（窓 4 KiB、`ops.ws_deflate`）。圧縮の率と CPU の確定は E12 の `cost-baseline` |
| E2 | `sync-simulator` | 12.1 節のシミュレーターと PROP-SYNC-001〜010、回帰の種の保存 |
| E3 | `gateway-heartbeat-backoff` | 9.6 節の心拍、背圧、再接続の待ち |
| E4 | `sync-ticket` | チケットの発行と消費（accounts-and-auth と共同） |
| E12 | `sync-fault-injection` | 12.3 節の障害注入と負荷 |
| E12 | `delivery-audit` | 11 節の配信の監査の抜き取り |

## 14. 未解決の問い

### 決定

2026-09-28 の既定案。E2 の PoC と計測で覆りうる。

- **`sync_id` の単位**：変更（sync action）ごと。トランザクションの確定の番号は最後の変更の番号（ADR-0007）。
- **`update` の中身**：変更後の行の全体と `changed`（ADR-0007）。
- **ロックの位置**：Writer の最初。楽観的な検証は、PoC で上限に届かないときの代案（ADR-0006）。
- **1 回の `submit` の扱い**：1 つの DB のトランザクションで、トランザクションごとに savepoint。トランザクションどうしは独立に確定・拒否（ADR-0002）。
- **冪等の記録の保持**：90 日（ADR-0005 と同じ）。
- **差分の配信**：Valkey の pub/sub、絞る前の列をワークスペースごとのチャンネルで。Gateway が欠けを埋めてから範囲を名乗る（ADR-0007）。
- **フレーム**：JSON のテキスト。差分の流れに permessage-deflate（窓 4 KiB）を使う（ADR-0009 の 2026-09-28 の注記）。
- **取り戻しの経路**：Sync API の HTTP。Gateway は生の差分だけ（ADR-0009）。
- **並びの鍵の振り直し**：48 バイトで窓（65 個から最大 1,024 個）。それ以上は Worker（ADR-0008）。
- **上書きの通知**：`base` が 1 時間以上前の上書きだけを本人に知らせる（ADR-0002）。
- **シミュレーターの回数**：PR ごとに 2,000、夜間に 20 万（ADR-0010）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 1 ワークスペースの書き込みの上限（1 秒 300 件）に、最初にロックを取る方式で届くか | E2 の PoC。届かなければ楽観的な検証の ADR |
| 複数の接続の `submit` を Writer でまとめて 1 つの DB のトランザクションにする（group commit）か | E2 の PoC で、ロックの待ちの p99 を見て決める |
| permessage-deflate の文脈の持ち越しを使うか（窓 4 KiB）、使わずに圧縮したフレームを使い回すか | E12 の負荷試験で、圧縮の率・CPU・メモリーを比べて決める（9.1 節） |
| `update` の行の全体でログが想定（1 日 800 万行）より大きくなるか | E2 で行の大きさの分布を測る。大きければ、遅延のモデルだけ全体、他は変わったフィールドにする |
| 反応型のストア（MobX か自前か） | E2 の PoC（ADR-0001） |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 送信から ack の p50・p99（NFR-002 の 300ms）と、うちロックの待ちの時間。
- 伝播の p50・p99（NFR-002 の 1 秒）を 7.6 節の区間ごとに。合成監視の 2 つのクライアントで測る。
- 拒否の率（コードごと）。`forbidden`・`invalid_reference` の急な増加はクライアントの誤りの目安。
- Gateway の欠けの埋めの回数と、クライアントの取り戻しの回数・範囲の大きさ。
- 上書きの記録の件数と、通知した件数。
- 並びの鍵の長さの分布と、窓の振り直し・全体の振り直しの回数。
- シミュレーターの回数と、見つかった失敗の種の数（夜間）。
- 収束の監査（NFR-005）：クライアントのモデルのハッシュをサーバーと突き合わせる抜き取りの不一致の件数。

### runbooks

- `sync-propagation-lag.md`：伝播の遅れの確かめ方（Relay の遅れ、Valkey、Gateway の欠けの埋め、reader の遅れ）と対処。
- `writer-lock-contention.md`：1 ワークスペースのロックの待ちが伸びたときの確かめ方（インポート、一括の編集、長い検証）と、流量の上限の引き下げ。
- `sync-epoch-bump.md`（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md) の B・D にまとめた）：DR の切り替え・復元の後に `sync_epoch` を上げる手順と、やり直しの殺到の見守り。
- `convergence-mismatch.md`：収束の監査で不一致が出たときの調べ方（該当のワークスペースの `sync_actions`、クライアントの報告、シミュレーターでの再現）。

### data-model（索引への追加の提案）

| 表・store | 中身 | 節 |
| --- | --- | --- |
| `workspace_sync` | `last_sync_id`、`floor_sync_id`、`sync_epoch` | 7.1 |
| `sync_actions` | 変更のログ（日ごとのパーティション） | 7.1 |
| `sync_outbox` | Relay への範囲 | 7.1 |
| `tx_results` | 冪等の記録（90 日） | 5.4 |
| モデルの行の `updated_sync_id`・`sync_groups`・`field_sync_ids` | 行の版、同期グループ、上書きの検出 | 7.1、8.4 |
| Valkey の `sync:<workspace_id>` | 絞る前の差分の配信 | 7.3 |
| Valkey のチケット（SHA-256、60 秒） | WebSocket の認証 | 9.3 |

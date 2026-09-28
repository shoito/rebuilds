# Client Store and Offline: Linear

クライアントの手元の保存と、オフラインの振る舞い。IndexedDB の構成、outbox、書き込みの耐久性、複数のタブ（書き手の選出とタブの間の通知）、手元の DB のスキーマの移行、保存の上限と消去への備え、メモリーの上限とモデルの遅延の復元、オフラインの表示を決める。

前提となる決定は、基盤と部品（[ADR-0001](../decisions/0001-platform-and-stack.md)）、同期のモデル（[ADR-0002](../decisions/0002-sync-model.md)）、ブートストラップ（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)）、手元の保存とオフライン（[ADR-0005](../decisions/0005-client-persistence-and-offline.md)）、トランザクション（[ADR-0006](../decisions/0006-transactions-writer-and-idempotency.md)）。同期の本体は [sync-engine.md](sync-engine.md)、起動の経路と同期グループは [bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) にある。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0014](../decisions/0014-indexeddb-layout-durability-and-migrations.md) | IndexedDB の store はモデルの名前で持ち、行に `_u` と `_g` を付ける。outbox の書き込みだけ `durability: "strict"`、差分とブートストラップは `"relaxed"`。outbox の行は確定の後 15 分 `done` で残す。形の移行は `onupgradeneeded` では store と索引だけにし、行の移行は続きから再開できる通常のトランザクションで行う。outbox は書き換えず、送る時に今の形へ変換する |
| [0015](../decisions/0015-multi-tab-leader-and-broadcast.md) | 書き手のタブを Web Locks で 1 つ選び、WebSocket・送信・差分の保存を任せる。どのタブも outbox へ直接書き、BroadcastChannel で知らせる。書き手は保存した差分の ID の一覧を配り、他のタブは IndexedDB から読み直す。通知を取りこぼしたタブは、手元の `last_sync_id` の食い違いで気づいて読み直す |
| [0016](../decisions/0016-memory-tiers-quota-and-offline-ux.md) | メモリーは 3 層（観測可能なモデル、大きなモデルの詰めた索引、IndexedDB だけ）にし、観測可能なモデルは 5 万個まで。保存の上限は `navigator.storage` で見張り、遅延のモデルの写しだけを退かす。outbox・`_meta`・未送信の添付は退かさない。ブラウザが消した場合は、サーバーのクッキーの端末の ID で、失った未送信の件数を本人に示す |

## 1. 目的と範囲

- 扱う：IndexedDB のデータベースと store、行の形、書き込みの経路と耐久性、outbox の行と状態、添付ファイルのオフラインの送信、複数のタブ、手元の移行、メモリーの階層と上限、保存の上限と消去、オフラインの表示。
- 扱わない：
  - 差分・ack・載せ直しの規則（[sync-engine.md](sync-engine.md)）
  - ブートストラップの API、部分の索引の意味、同期グループの消去の条件（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md)）
  - 画面の描画、仮想化、遅延の予算の計測（[client-app.md](client-app.md)）
  - ログアウトと共有の端末での消去、手元の DB の暗号化（[security.md](security.md)）
  - 本文の CRDT の状態の保存の形（[editor-and-descriptions.md](editor-and-descriptions.md)）

## 2. 本家の形と、使う Web の API（確かめたこと）

いずれも 2026-09-28 に確認。

### 2.1 本家

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| オフライン（公式） | 送れない変更を手元に持ち、つながったら再送する。再起動の後も再送する。未送信が多いと「Syncing」と件数を出す。オフラインは失敗への備えの位置付け | [Download Linear](https://linear.app/docs/get-the-app) |
| データベース（第三者の解析） | `linear_databases` にワークスペースごとのデータベースの一覧（名前、`schemaHash`、`schemaVersion`）。ワークスペースのデータベースに、モデルごとの store（名前はハッシュ）、`_meta`（`lastSyncId`、`firstSyncId`、`subscribedSyncGroups` など）、未送信のトランザクションの store、部分の索引の別のデータベース | [wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine) |
| スキーマの移行（第三者の解析） | モデルのメタデータから計算したハッシュが変わると、`schemaVersion` を上げて移行する | 同上 |

- 本家の複数のタブの扱い（書き手の選出の有無）は、公開の資料でも解析でも確かめられなかった（**未検証**）。

### 2.2 Web の API

| API | この設計で使う性質 | 出典 |
| --- | --- | --- |
| IndexedDB の `durability` | `"strict"` は永続の保存に書けたことを確かめてからコミットとみなす。`"relaxed"` は OS に渡した時点でコミットとみなす。`"default"` はブラウザの既定 | [IDBDatabase.transaction()](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction)（MDN） |
| Chrome の既定 | Chrome 121 から既定が `relaxed` になった（Firefox・Safari に合わせた）。移行のように失えない書き込みには `strict` を勧めている | [A change to the default durability mode in IndexedDB](https://developer.chrome.com/blog/indexeddb-durability-mode-now-defaults-to-relaxed)（Chrome for Developers） |
| Web Locks | 同じオリジンのタブとワーカーの間のロック。`exclusive`（既定）と `shared`。`ifAvailable`・`steal`・`signal`。コールバックの終わり、タブ・ワーカーの終了で外れる。`navigator.locks.query()`。安全なコンテキストだけ。2022-03 から主要なブラウザで使える | [Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)（MDN） |
| BroadcastChannel | 同じオリジン・同じ保存の区画のタブ・フレーム・ワーカーの間の通知。送り手自身は受けない。構造化複製で送る。`messageerror`。2022-03 から主要なブラウザで使える | [BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)（MDN） |
| 保存の上限 | Chrome は既定・永続とも最大でディスクの 60%。Firefox は既定でディスクの 10% か 10 GiB の小さい方、永続でディスクの 50%（上限 8 TiB）。Safari（macOS 14・iOS 17 以降）はブラウザのアプリで約 60%、埋め込みの WebView で約 15% | [Storage quotas and eviction criteria](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)（MDN） |
| 消去 | 空きが少ないと、最も長く使っていないオリジンから消す。永続でないオリジンだけが対象。消すときはオリジンのデータを全部まとめて消す。Safari は、追跡の防止が有効なとき、7 日間操作のないオリジンのスクリプトが作ったデータを消す（サーバーが設定したクッキーは除く） | 同上 |
| `persist()`・`estimate()` | `persist()` は Firefox では利用者に尋ね、Chrome・Edge・Safari は利用の度合いで自動で決める。`estimate()` は `usage` と `quota` の見積もりを返す | 同上 |

## 3. IndexedDB の構成

ADR-0014。ADR-0005 の構成を具体にする。

### 3.1 データベース

| データベース | 名前 | 中身 |
| --- | --- | --- |
| 登録 | `<brand>_registry` | store `databases`：`{name, account_id, workspace_id, schema_version, created_at, last_opened_at, pending_count, persisted}` |
| ワークスペース | `<brand>_<h>`。`h` は `SHA-256(account_id + ":" + workspace_id)` の base32 の先頭 20 文字 | 3.2 節の store |

- データベースの名前に、ワークスペースの名前や slug を入れない（開発者のツールで、どの顧客を使っているかが見えないように）。
- IndexedDB の版の番号は、クライアントの手元のスキーマの版（`schema_version`、整数）と同じにする。

### 3.2 store

| store | キー | 索引 | 中身 |
| --- | --- | --- | --- |
| モデルごと（`Issue`、`Comment` …） | `id` | スキーマの `index`（例：`team_id`、`issue_id`）、`_g`（multiEntry） | モデルの行。3.3 節 |
| `_meta` | `k` | — | `last_sync_id`、`sync_epoch`、`groups`、`groups_hash`、`schema_version`、`schema_hash`、`bootstrap`、`reset`、`migration`、`client_id`、`flags`（クライアントのフラグ。オフラインでも同じ値を使う。[delivery.md](delivery.md) の 3 節） |
| `_outbox` | `seq`（自動の連番） | `id`（一意）、`state` | 未確定と、確定して 15 分以内のトランザクション。5 節 |
| `_rejected` | `id` | `seen` | 拒否されたトランザクションと理由（本人に示すまで持つ） |
| `_partial_indexes` | `key` | `groups`（multiEntry） | 被覆の鍵（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 6.2 節） |
| `_tombstones` | `[m, id]` | `at` | 削除と `evict` の墓標（同 6.4 節） |
| `_blobs` | `id` | `tx_id` | オフラインで付けた添付ファイルの中身と送信の状態（5.5 節） |
| `_doc_state` | `[m, id]` | `opened_at` | 本文（`IssueDescription` など）の確定した更新をまとめた Yjs の状態、`as_of`、最後に開いた時刻（[editor-and-descriptions.md](editor-and-descriptions.md) の 4.5 節） |
| `_doc_updates` | `[m, id, s]` | — | 被覆のない本文に差分で届いた `append`（`s` は `sync_id`）。1 文書 256 KiB を超えたら捨てる（同上） |
| `_drafts` | `key` | `updated_at` | 画面を離れたときの一時の下書き（作成中のイシュー・コメント。端末だけ。同期しない。[issues-and-workflow.md](issues-and-workflow.md) の 12 節）。端末をまたぐ下書きは `IssueDraft` のモデル |

- モデルの store の名前はモデルの名前にする。本家の解析のようにハッシュにはしない。名前を隠しても、行の中身が読めるので意味が薄く、調査がしにくくなる。
- `_doc_state`・`_doc_updates` は、ADR-0014 が予約した `_doc_*` の名前で、editor-and-descriptions の領域の依頼を受けて統合の工程で足した。書き込みの経路と退かしは 4 節・9.2 節の表に従う（`_doc_state` は M3、未確定の `append` のある文書は退かさない）。
- `_drafts` は退かさない（利用者が書いた未送信の文字）。ログアウトと除外では、他の store と一緒に消える。

### 3.3 行の形

```json
{ "id": "01926f…", "team_id": "…", "title": "…", "state_id": "…", "priority": 2,
  "label_ids": ["…"], "sort_key": "a0V", "number": 123,
  "_u": 18240, "_g": ["team:…"] }
```

- `_u`：その行を最後に変えた `sync_id`（`updated_sync_id`）。ブートストラップ・遅延の読み込み・差分の突き合わせに使う（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 4.4・6.3 節）。
- `_g`：行の同期グループ。脱退のときに、multiEntry の索引で消す行を引く（同 7.4 節）。
- 行は確定した状態だけを持つ。未確定の変更をモデルの store に書かない（AGENTS.md。画面の操作から直接書かない）。

## 4. 書き込みの経路と耐久性

ADR-0014。

| 経路 | 1 つの IndexedDB のトランザクションに入れるもの | `durability` | 理由 |
| --- | --- | --- | --- |
| outbox への追加 | 同じイベントループの回で作ったトランザクションの全部（ADR-0005） | `strict` | 保証の起点（NFR-004）。電源の喪失でも失わない |
| 差分のパケット | モデルの行、`_meta.last_sync_id`、確定した outbox の行を `done` にする、15 分を過ぎた `done` の行を消す、墓標 | `relaxed` | 失っても、`last_sync_id` ごと前に戻るだけで、取り戻せる。outbox の `done` が戻っても、送り直しは冪等 |
| ブートストラップ | 2,000 行と `_meta.bootstrap` の進み | `relaxed` | チャンクを取り直せる |
| 遅延の読み込み | 行と被覆の鍵 | `relaxed` | 読み直せる |
| 脱退の消去 | 行・被覆・`_meta.groups`・墓標 | `strict` | 見てよくないデータを残さない |
| やり直しの開始、移行の進み | `_meta.reset`・`_meta.migration` | `strict` | 途中で落ちた後の判断に使う |

- `relaxed` の書き込みが電源の喪失で失われても、正しさは崩れない。IndexedDB のトランザクションの原子性で、手元の状態と `last_sync_id` はそろったまま前に戻る。`strict` と `relaxed` のトランザクションの間の永続の順序には頼らない。
- 入力の経路（操作 → トランザクション → メモリー → 描画）では、IndexedDB を待たない（NFR-001、ADR-0005）。outbox のコミットは描画の後に終わる。
- outbox のコミットが 1 秒以上終わらなければ、画面に「保存していない変更」を示す（ADR-0005）。この間にタブを閉じようとしたら、`beforeunload` で確かめる。それ以外では確かめない（outbox に入っていれば失わないので）。
- 差分のパケットは、IndexedDB に保存してからメモリーに当てる（ADR-0005。[sync-engine.md](sync-engine.md) の 7.6 節）。

## 5. outbox

ADR-0014。

### 5.1 行

```json
{ "seq": 4812, "id": "01926f3a-…", "fv": 3, "base": 18234, "at": "2026-09-28T01:02:03.456Z",
  "ops": [ … ], "state": "sent", "ack_s": null, "server_ops": null,
  "sent_at": "…", "attempts": 1, "tab_id": "…", "done_at": null, "blob_refs": [] }
```

- `seq` は IndexedDB の自動の連番。複数のタブが同じ store に書いても、`readwrite` のトランザクションは直列になるので、コミットの順と `seq` の順が一致する。送信の順は `seq` の順（[sync-engine.md](sync-engine.md) の 4.4 節）。
- 行は、作った時の形（`fv`）のまま持つ。移行で書き換えない（6.3 節）。

### 5.2 状態

| `state` | 意味 | 次 |
| --- | --- | --- |
| `queued` | コミット済み。未送信 | 書き手が送ると `sent` |
| `sent` | 送ったが、結果を知らない | ack で `acked`・拒否で `_rejected` へ移す・切断で `queued` |
| `acked` | 確定の `sync_id`（`ack_s`）を知っている | `last_sync_id ≥ ack_s` の差分の保存で `done` |
| `done` | 確定を差分で確かめた | 15 分後に消す |

- **`done` を 15 分残す理由**：DR の切り替えで直近の確定を失ったとき、`done` の行も送り直すため（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 8.3 節）。ADR-0005 の「確定したら消す」を 15 分遅らせるもので、保証を弱めない。
- `pending`（画面に重ねる未確定の列）は、`queued`・`sent`・`acked` の行から作る。

### 5.3 上限

| 項目 | 値 | 超えたら |
| --- | --- | --- |
| 未確定の件数 | 5 万件 | 新しい編集を止め、「未送信が多すぎます。接続を確かめてください」を示す |
| 未確定の大きさ | 100 MiB | 同上 |
| 警告 | 1,000 件、または最も古い未送信が 24 時間 | 画面に示す |
| 7 日のオフライン（NFR-004） | 1 人 1 日 2,000 トランザクション × 1 KB と見て約 14 MB | 上限の内 |

### 5.4 送信

- 送るのは書き手のタブだけ（8 節）。`queued` の行を `seq` の順に、`submit` の上限（100 件・1 MiB、ack のない `submit` 4 個まで）で送る。
- 送る前に、行の `fv` を今の形へ変換する（6.3 節）。
- 90 日より古い行は送らず、確認の一覧に出す（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 8.4 節）。

### 5.5 添付ファイル

ADR-0005 がこの領域に任せた、添付のオフラインの送信を決める。

- オフラインで付けた添付は、中身を `_blobs` に `Blob` のまま保存し（`strict`）、`create Attachment { upload_ref }` のトランザクションを outbox に入れる。行の `blob_refs` に `_blobs` の ID を持つ。
- 1 ファイル 25 MiB、未送信の合計 200 MiB まで。超えたら、オフラインでは付けられないと示す。
- つながったら、書き手のタブが先回りして送信の URL を取り、中身を上げる。outbox の送信は、`blob_refs` のある行に来たら、その上げが終わるまで先へ進まない（後のトランザクションがその添付を参照しうるため）。
- 上げが恒久に失敗したら（大きさ・種類の拒否）、そのトランザクションを拒否として扱い、`_rejected` に理由を書き、続きを送る。
- 確定した後、`_blobs` の行は消す。

## 6. 手元の DB の移行

ADR-0014。ADR-0005 の方針（移行で outbox を消さない、1 つ前の版の outbox を読める）を具体にする。

### 6.1 版

- `schema_version`（整数）：store・索引・行の形のどれかが変わったら上げる。スキーマの生成が、前の版との差から上げるべきかを判定し、上げ忘れを CI で失敗させる。
- `schema_hash`：スキーマの生成が出すハッシュ。握手で送る（[sync-engine.md](sync-engine.md) の 9.4 節）。

### 6.2 手順

```
 新しいコードのタブが open(name, v_new)
  ├─ 他のタブの古い接続に versionchange が届く
  │    古いタブ：まとめ中の outbox を書き終えてから db.close()、
  │               「新しい版に更新しました。再読み込みしてください」を示し、操作を止める
  ├─ onupgradeneeded（versionchange のトランザクション）：store と索引の追加・削除だけ
  └─ 開いた後：Web Locks の `<brand>:migrate:<db>` を取り、行の移行を通常のトランザクションで
       2,000 行ずつ。進みを `_meta.migration = {from, to, model, cursor}` に書く（strict）
       落ちたら、次の起動で cursor から続ける
```

- `onupgradeneeded` の中は同期の IndexedDB の操作しかできないので、行の移行を入れない。長い移行でブラウザの versionchange のトランザクションを長く持たないためでもある。
- 行の移行の種類：
  | 変化 | 移行 |
  | --- | --- |
  | 任意のフィールドの追加 | 既定値で埋める |
  | 必須のフィールドの追加、型の変更 | そのモデルの行と被覆の鍵を捨て、取り直す（`instant`・`partial` はそのモデルだけのブートストラップ、`lazy` は次に使う時の読み込み） |
  | モデルの削除 | store を消す |
  | 移行の関数が失敗した | やり直しのブートストラップ（outbox は残す。[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 8.2 節） |
- `blocked`（古いタブが閉じない）が 10 秒続いたら、新しいタブは「他のタブを閉じてください」と示す。

### 6.3 outbox の変換

- outbox の行は書き換えず、送る時に `upcast[fv → fv+1]` の関数を順に当てて今の形にする。元の形を残すので、変換の誤りを直した版で、もう一度変換できる。
- 変換の関数は、少なくとも 180 日分（outbox の自動の送信の期限 90 日の 2 倍）の版を持つ。変換の関数のない古い形の行は、90 日を超えた行と同じく、確認の一覧に出す。
- サーバーは今の形と 1 つ前の形を、リリースから 30 日受ける（ADR-0005）。クライアントは常に今の形で送るので、クライアントを更新した後は受け付けられる。

### 6.4 古いコードで新しい DB を開いた

- ロールバックなどで、古いコードが新しい版の DB を開くと `VersionError` になる。古いコードは DB に触れず、「新しい版で開いてください」と示す。outbox を読めないまま消すことはしない。
- クライアントのロールバックが DB の版をまたがないよう、DB の版を上げる変更は、機能の変更と別のリリースにする（delivery の領域）。

## 7. メモリー

ADR-0016。

### 7.1 階層

| 層 | 持つもの | 形 |
| --- | --- | --- |
| M1：観測可能なモデル | `instant` のモデル、画面で使っているモデル（開いたイシュー、見えている一覧の行、コメント） | 反応型のオブジェクト（MobX か自前か。E2 の PoC） |
| M2：詰めた索引 | 行の多いモデル（イシュー）の、フィルター・並べ替え・グループ化・コマンドメニューの照合に使うフィールド | モデルごとの列の配列（ID、チーム、状態、担当、優先度、見積もり、サイクル、プロジェクト、ラベル、並びの鍵、親、番号、タイトル、作成・更新・完了の時刻）と、派生の列 `identifier`（`ENG-123`。チームの識別子と番号から作る）・`title_norm`（タイトルに `normalizeForSearch` を当てたもの）。M2 の列は、スキーマの `m2` と `packages/filter` の登録から生成する（[data-model-and-schema.md](data-model-and-schema.md) の 4.1 節の行 14） |
| M3：IndexedDB だけ | 遅延のモデルの写し、古い完了のイシュー、本文 | 行 |

- 一覧の切り替え・フィルター・並べ替え（NFR-001 の対象）は M2 だけで答える。IndexedDB を待たない。
- 行の詳細（イシューを開く）は、M1 になければ IndexedDB から読んで M1 にする（非同期。NFR-001 の対象外）。
- 差分は、M2 と、M1 にある行に当てる。M3 だけの行は IndexedDB への保存で済む。

### 7.2 上限と追い出し

| 項目 | 値 |
| --- | --- |
| M1 の数（`instant` を除く） | 5 万個。超えたら、観測されていない（画面が読んでいない）ものから古い順に M1 から外す |
| M2 の大きさの目安 | イシュー 1 件 200 バイト（`identifier`・`title_norm` を足すと約 300 バイト）。部分のブートストラップの 10 万件で約 30 MB、全体の 5 万件で約 15 MB |
| JS のヒープの目標 | 最大のワークスペースで p95 500 MB、モデル 5 万件以下で p95 250 MB（基準の端末。E2・E3 で測る） |

- ヒープの計測は、RUM では Chrome の非標準の `performance.memory`、Electron では `process.getProcessMemoryInfo()` を使う。`performance.measureUserAgentSpecificMemory()` はクロスオリジンの隔離が要るので、S1 では使わない。`performance.memory` は Chromium だけにある非推奨の非標準の API（[MDN の互換性のデータ](https://github.com/mdn/browser-compat-data) 8.1.3）、`measureUserAgentSpecificMemory()` は安全な文脈とクロスオリジンの隔離が要る（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory)）、`process.getProcessMemoryInfo()` は Electron の主とレンダラーの両方で使える（[process](https://www.electronjs.org/docs/latest/api/process)）。いずれも 2026-09-28 に確認。Firefox と Safari では RUM のヒープの値を送らない。
- M1 から外したモデルを画面が再び読むと、M2（あれば）で一覧を出しながら、IndexedDB から戻す。

## 8. 複数のタブ

ADR-0015。ADR-0005 の決定（Web Locks で書き手を選び、他のタブは outbox へ直接書き、BroadcastChannel で知らせる）を具体にする。

### 8.1 役割

| 役割 | 仕事 |
| --- | --- |
| 書き手（1 つ） | WebSocket、outbox の送信、差分の保存、添付の上げ、ブートストラップとやり直しの進行、保存の上限の見張り |
| どのタブも | 画面、自分のトランザクションの outbox への追加、遅延の読み込み（HTTP）とその保存、`_rejected` の表示 |

### 8.2 選出

```ts
navigator.locks.request(`<brand>:leader:${dbName}`, async () => {
  await becomeLeader();          // _meta と outbox を読み、WebSocket を開く
  await untilStepDown();         // タブを閉じる・freeze・steal まで持ち続ける
});
```

- 書き手のタブが閉じると、ロックが外れ、待っている次のタブが書き手になる（Web Locks の性質）。
- ページが凍結される（`freeze` イベント）ときは、書き手を自分から降りる（WebSocket を閉じ、ロックを返す）。凍結されたページがロックを持ち続けるかは**未検証**なので、自分から降りる（E3 の `multi-tab-leader` で確かめる）。`freeze` イベントは Chromium だけにある（[MDN の互換性のデータ](https://github.com/mdn/browser-compat-data) 8.1.3、2026-09-28 に確認）。他のブラウザは 10 秒の `steal` で補う。
- 見えているタブが、書き手の `status` を 10 秒受けなければ、`steal: true` で書き手を取る。古い書き手は、ロックを奪われたら直ちに送信をやめる。
- 2 つの書き手が短い間重なっても、送信は `client_tx_id` で冪等で、各接続の中の順序が保たれ、Writer が 1 回の `submit` をロックの中で順に処理するので、作成の前に更新が当たることはない（[sync-engine.md](sync-engine.md) の 5.2 節）。

### 8.3 通知

チャンネルの名前は `<brand>:${dbName}`。

| メッセージ | 送り手 | 中身 | 受け手の処理 |
| --- | --- | --- | --- |
| `outbox` | どのタブも | 追加した `seq` の一覧 | IndexedDB から行を読み、自分の `pending` に足す。書き手は送信の列に足す |
| `applied` | 書き手 | `from`、`to`、`changes: [{m, id, a}]` | `from` が自分の `L` と等しければ、ID の行を IndexedDB から読んで当てる。違えば 8.4 節 |
| `ack` / `rejected` / `done` | 書き手 | `client_tx_id`、`s`・理由 | `pending` を更新する |
| `groups` | 書き手 | 外した・足したグループ | メモリーから外す・読み込み中にする |
| `covered` | どのタブも | 被覆の鍵 | 同じものを求めない |
| `status` | 書き手 | 接続の状態、未送信の件数、`mode`、5 秒ごと | 表示（9.4 節） |
| `reset` | 書き手 | やり直しの段階 | 表示。終わったら手元から読み直す |

- `applied` に行の中身を載せず、ID だけを載せる。大きなパケット（1 MiB 超）の構造化複製を避け、受け手は保存済みの行を IndexedDB から読む。
- 1 つのタブの中で、画面はそのタブの `pending` を重ねる。他のタブの未確定も `outbox` の通知で `pending` に入るので、全タブの画面が同じになる。

### 8.4 取りこぼし

- 凍結・破棄から戻ったタブ、`messageerror` を受けたタブ、`applied.from ≠ L` を見たタブは、`_meta.last_sync_id` を読み、自分の `L` と違えば、メモリーを手元から読み直す（手元からの起動の一部。ネットワークは使わない）。
- 画面が見えるようになったとき（`visibilitychange`）も同じ比較をする。

### 8.5 Electron

- Electron の複数のウィンドウは、同じセッション（同じ保存の区画）で開き、タブと同じ扱いにする。同じセッションのウィンドウの間で Web Locks と BroadcastChannel が効くことは**未検証**（E6 の `electron-shell` で確かめる）。

## 9. 保存の上限・消去・オフラインの表示

ADR-0016。

### 9.1 永続の保存

- ログインの後、最初にワークスペースを開いたとき（利用者の操作の後）に `navigator.storage.persist()` を求める。結果を登録の `persisted` に書く。
- 認められなかった Web の利用者で、未送信があるときは、Electron を勧める表示を出す（ADR-0005）。
- Electron は、アプリのデータの場所に保存され、ブラウザの消去の方針を受けない（ADR-0005）。空きの少ないときの Electron の振る舞いは**未検証**（E6 の `electron-shell` で確かめる）。

### 9.2 見張りと退かし

- 書き手は `navigator.storage.estimate()` を、起動の時、ブートストラップの後、10 分ごとに読む。

| `usage / quota` | 処理 |
| --- | --- |
| 70% 以上 | 遅延のモデルの写し（コメント、履歴、アーカイブしたもの、しばらく開いていないイシューの本文の状態）を、被覆の鍵の最後の利用の古い順に、被覆の鍵と一緒に消す |
| 85% 以上 | 利用者に警告する |
| outbox の書き込みで `QuotaExceededError` | 上の退かしをしてから 1 回だけ書き直す。だめなら、新しい編集を止め（読み取りの専用）、「端末の空きが足りないため、変更を保存できません」と示す。書けなかった操作は画面から取り消す |

- **退かさないもの**：`_outbox`、`_rejected`、`_meta`、未送信の `_blobs`、`instant` のモデル、`partial` の被覆のある行。
- 行を消すときは、同じトランザクションで被覆の鍵も消す。被覆があると名乗ったまま行がない状態を作らない。

### 9.3 ブラウザに消されたとき

- ブラウザの消去はオリジンのデータを全部まとめて消す（MDN）。登録も `_meta` も消えるので、手元だけでは、未送信があったことが分からない。
- そこで、サーバーが HttpOnly のクッキー `<brand>_cid`（端末の ID、乱数）を設定する。Gateway は、握手と `status` の度に、端末の ID ごとに最後に報告された未送信の件数を持つ（`client_devices` の表。端末の ID はワークスペースを決める前に引くので RLS の外に置き、行は `(device_id, account_id, workspace_id)` ごとにする。[data-model.md](data-model.md) の 5 節）。
- 手元の DB がない状態で握手したとき、その端末の ID に未送信の報告があれば、`welcome.lost_local = {pending, reported_at}` を返し、画面で「この端末の未送信の変更 n 件が、ブラウザにより消去されました」と示す。
- Safari の 7 日の消去は、サーバーが設定したクッキーを消さない（MDN）ので、この仕組みが働く。
- 未送信の中身はサーバーにないので、取り戻せない。見せるのは件数だけである。

### 9.4 オフラインの表示

表示は 1 か所（ワークスペースの名前の横）にまとめる。本家の「Syncing」と件数の表示と同じ考え方である（2.1 節）。

| 状態 | 表示 | 書き込み |
| --- | --- | --- |
| 同期済み | なし | できる |
| 同期中 | 「同期中 n」 | できる |
| オフライン | 「オフライン・未送信 n」 | できる |
| 再接続中 | 「再接続しています」 | できる |
| 再同期を待つ（やり直しの散らし） | 「再同期を待っています」 | できる（outbox に入る） |
| 更新が必要 | 「アプリの更新が必要です」。送信を止める | できる（outbox に入る） |
| 保存の空きが少ない | 警告 | できる |
| 保存できない | 「空きが足りません」 | できない |
| 未送信を失った | 9.3 節の知らせ | できる |

- オフラインで使えないもの：手元にないデータの検索と読み込み、招待、連携の設定、インポート、手元にない添付の表示（ADR-0005）。ボタンを消さず、押すと理由を示す。
- 拒否されたトランザクション（`_rejected`）は一覧で理由とともに示し、本人が見たら消す。上書きの知らせ（[sync-engine.md](sync-engine.md) の 8.4 節）も同じ一覧に出す。

## 10. 障害のときの振る舞い

| 障害 | 起きること | 回復 |
| --- | --- | --- |
| 操作から outbox のコミットの前にタブが落ちた | その操作は失われる（ADR-0005 の保証の外） | 1 秒以上コミットできないときの表示と `beforeunload` で、窓を知らせる |
| outbox のコミットの後、送信の前に落ちた | `queued` のまま残る | 次の書き手が送る |
| 送った後、ack の前に落ちた | `sent` のまま残る | 送り直し。冪等（ADR-0006） |
| 差分の保存の途中で落ちた | トランザクションが戻る | `last_sync_id` も戻るので、取り直す |
| 電源の喪失 | `relaxed` の直近のコミットを失いうる | 同上。outbox は `strict` なので残る |
| 書き手のタブが凍結・破棄された | 送信が止まる | 自分から降りる、`steal`、ロックの解放で次の書き手 |
| 移行の途中で落ちた | `_meta.migration` が残る | 続きから再開 |
| 古いタブと新しいタブが混在 | 古いタブの DB の接続が閉じられる | 古いタブは操作を止め、再読み込みを促す |
| 保存の上限 | 書き込みの失敗 | 9.2 節 |
| ブラウザの消去 | 手元がすべて消える | やり直しのブートストラップ。失った件数を示す（9.3 節） |

## 11. テスト

### 11.1 必須の 3 つの場面（AGENTS.md、ADR-0005）

outbox・再接続・スキーマの移行に触れる変更には、次の試験を付ける。Playwright（Chromium・Firefox・WebKit）と、IndexedDB を模したシミュレーター（[ADR-0010](../decisions/0010-deterministic-sync-simulator.md)）の両方で行う。

1. **オフラインのまま再起動**：オフライン（`context.setOffline(true)`）で操作し、タブを閉じて開き直し、つなぐ。全トランザクションが 1 回ずつ確定する。
2. **送信の途中で落ちる**：`submit` を送った後、ack の前に、タブを強制終了（CDP の `Page.crash`、ブラウザのプロセスの終了）する。開き直した後、重複しない。
3. **古い版の outbox を新しい版で送る**：1 つ前の版のクライアントで outbox を作り、オフラインのまま今の版へ更新し（DB の移行を含む）、つなぐ。全トランザクションが確定する。

加えて：

- 差分の保存の途中で落としても、手元の `last_sync_id` と状態がずれない。
- 書き手のタブを閉じる・凍結させても、他のタブの outbox が送られる。
- 保存の上限の近くで、退かしが outbox を消さない。

### 11.2 性質ベーステスト

- **PROP-STORE-001（失わない）**：任意の操作・落ちる時点・電源の喪失・再起動・タブの交代の列で、outbox にコミットしたトランザクションは、最終的にちょうど 1 回確定するか、拒否されて `_rejected` に示される（NFR-004）。
- **PROP-STORE-002（原子性）**：差分の保存の任意の時点で落ちても、手元の行の集合は、ある `L` までの差分をすべて当てた状態と一致し、`_meta.last_sync_id = L`。
- **PROP-STORE-003（順序）**：複数のタブが同時に outbox に書いても、送信の順は `seq` の順で、あるタブで作成を見てから作った更新は、その作成より後に送られる。
- **PROP-STORE-004（移行）**：任意の 1 つ前の版の DB と outbox から、移行の途中の任意の時点で落ちて再開しても、移行の後に outbox の全件が送れ、モデルの状態がサーバーと一致する。
- **PROP-STORE-005（退かし）**：保存の上限による退かしの後、`_outbox`・`_meta`・未送信の `_blobs` は変わらず、被覆の鍵がある単位の行はすべて手元にある。
- **PROP-STORE-006（タブの収束）**：操作が止んだ後、全タブの画面の状態が一致し、サーバーの状態と一致する。

### 11.3 計測

- 手元からの起動 p95 1.5 秒（NFR-003）、基準のワークスペースでのヒープ（7.2 節）、outbox のコミットの時間 p99（strict）。E3 の CI のベンチマークに入れる。
- 7 日のオフラインの耐久試験（E12）：1 日 2,000 トランザクションを 7 日分ためて送り、全件が 1 回ずつ確定する。

## 12. セキュリティ

- 手元の DB には、見てよいデータだけが入る（同期グループの絞り込み。ADR-0004）。脱退の消去は `strict` で行う（4 節）。
- データベースの名前に、ワークスペースの名前を入れない（3.1 節）。
- 端末の ID のクッキーは HttpOnly・Secure・SameSite=Lax。中身は乱数で、アカウントに結び付けるのはサーバーの表だけにする。
- ログアウト、共有の端末、手元の暗号化は security の領域で決める（ADR-0005 の「ログアウトでは、そのアカウントのデータベースをすべて消す。未送信があれば先に確かめる」を前提にする）。
- エラーの報告とログに、outbox の中身・行の中身を入れない。件数・大きさ・状態・理由のコードだけにする。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `client-schema-version-check` | スキーマの生成で `schema_version` の上げ忘れを CI で失敗させる |
| E3 | `idb-layout` | 3 節のデータベース・store・索引・行の形と、登録 |
| E3 | `idb-write-paths` | 4 節の経路と `durability`、保存してから当てる順 |
| E3 | `outbox-store` | 5.1〜5.4 節の行・状態・上限・送信、`done` の 15 分 |
| E3 | `offline-attachments` | 5.5 節の `_blobs` と上げの順序 |
| E3 | `client-db-migration` | 6.2 節の手順、`_meta.migration` の再開、`blocked` の扱い |
| E3 | `outbox-upcast` | 6.3 節の変換と、変換の関数の保持 |
| E3 | `multi-tab-leader` | 8.2 節の選出、凍結での降り方、`steal` |
| E3 | `multi-tab-broadcast` | 8.3・8.4 節の通知と取りこぼし |
| E3 | `storage-quota-watch` | 9.1・9.2 節の `persist`・`estimate`・退かし・読み取りの専用 |
| E3 | `lost-local-notice` | 9.3 節の端末の ID と、失った件数の知らせ |
| E3 | `offline-status-ui` | 9.4 節の表示と `_rejected` の一覧（client-app と共同） |
| E3 | `offline-replay-tests` | 11.1 節の 3 つの場面の Playwright の試験 |
| E3 | `store-sim-props` | 11.2 節の PROP-STORE-001〜006 |
| E2 | `memory-tiers-poc` | 7 節の M1・M2・M3 と、反応型のストアの選定の計測 |
| E6 | `m2-index-views` | M2 の上での一覧・フィルター（views-and-filters・client-app と共同） |
| E12 | `offline-endurance` | 7 日のオフラインの耐久試験 |

## 14. 未解決の問い

### 決定

2026-09-28 の既定案。E2・E3 の PoC で覆りうる。

- **`durability`**：outbox・脱退の消去・`_meta` の進みは `strict`、それ以外は `relaxed`（ADR-0014）。
- **outbox の `done` の保持**：15 分（ADR-0014）。
- **行の移行**：`onupgradeneeded` の外で、2,000 行ずつ、再開できる形（ADR-0014）。
- **outbox の変換の関数の保持**：180 日（ADR-0014）。
- **タブの間の通知**：ID だけを配り、IndexedDB から読み直す（ADR-0015）。
- **書き手の交代**：凍結で自分から降りる、見えているタブが 10 秒で `steal`（ADR-0015）。
- **M1 の上限**：5 万個（ADR-0016）。
- **保存の見張り**：70% で退かし、85% で警告（ADR-0016）。
- **添付のオフライン**：1 ファイル 25 MiB、合計 200 MiB。
- **outbox の上限**：5 万件・100 MiB。
- **ブラウザの消去の知らせ**：サーバーのクッキーの端末の ID で件数を示す（ADR-0016）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| IndexedDB の一括の書き込みと読み出しが、NFR-003 に間に合うか | E3 の前の `bootstrap-poc`（基準の端末、3 つのブラウザ）。遅ければ SQLite の WASM（ADR-0005 の代案） |
| 反応型のストア（MobX か自前か）と、M1・M2 の境 | E2 の前の `memory-tiers-poc`（ADR-0001） |
| 凍結されたページが Web Locks を持ち続けるか | E3 の `multi-tab-leader` で Chrome を確かめる（`freeze` は Chromium だけ） |
| Electron の複数のウィンドウでの Web Locks と BroadcastChannel、空きの少ないときの振る舞い | E6 の `electron-shell` で確かめる |
| 未送信の中身をサーバーの側に一時的に預けて、消去から守るか | 試用で消去が問題になれば。預ける中身の扱いは security と法務（L5） |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- outbox の喪失 0 件（NFR-004）：本番の監視として、端末の ID ごとの未送信の報告と、確定の突き合わせ。`lost_local` の件数。
- outbox の未送信の件数の分布と、最も古い未送信の年齢の分布。
- outbox のコミットの時間 p99（strict）と、「保存していない変更」の表示の回数。
- 手元からの起動の時間 p95、ヒープの p95（ワークスペースの大きさの帯ごと）。
- 移行の回数・時間・失敗（やり直しになった割合）。
- 書き手の交代の回数と、`steal` の回数。取りこぼしからの読み直しの回数。
- `persist()` が認められた割合、退かしの回数、読み取りの専用になった回数。
- 11.1 節の 3 つの場面の試験を、CI の必須のチェックにする。

### runbooks

- `client-storage-eviction.md`：`lost_local`・`corrupt` のやり直しが増えたときの確かめ方（ブラウザの版、Safari、空き）と、利用者への案内（Electron、永続の保存）。
- `client-migration-failure.md`：クライアントの版の後に、移行の失敗・やり直しが増えたときの確かめ方と、クライアントの版の停止・戻し（DB の版をまたがない戻し方）。
- `outbox-backlog.md`：未送信が長く残る端末が増えたときの確かめ方（`upgrade_required`、流量の上限、Writer の拒否）。

### data-model（索引への追加の提案）

| 表・store | 中身 | 節 |
| --- | --- | --- |
| 手元の `<brand>_registry.databases` | ワークスペースの DB の一覧 | 3.1 |
| 手元のモデルの store（`_u`・`_g` 付きの行） | 確定した行 | 3.2、3.3 |
| 手元の `_meta` | `last_sync_id`、`sync_epoch`、`groups`、`schema_version`、`bootstrap`、`reset`、`migration`、`client_id`、`flags` | 3.2 |
| 手元の `_outbox` | トランザクションと状態（`done` は 15 分） | 5 |
| 手元の `_rejected`・`_blobs` | 拒否の理由、オフラインの添付 | 3.2、5.5 |
| 手元の `_doc_state`・`_doc_updates`・`_drafts` | 本文の状態、被覆のない本文への `append`、一時の下書き | 3.2 |
| `client_devices`（サーバー） | 端末の ID、アカウント、ワークスペース、最後に報告された未送信の件数と時刻 | 9.3 |

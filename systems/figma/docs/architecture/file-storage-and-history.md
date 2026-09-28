# File storage and history: Figma

ファイルの中身の永続化と、版の履歴。ジャーナル（DynamoDB）、チェックポイント（S3）、ファイルの読み込み、持ち主の交代と回復、版の履歴と復元、複製、削除を決める。

前提となる決定は、ジャーナルとチェックポイント（[ADR-0003](../decisions/0003-journal-and-checkpoints.md)）、Router の割り当てと組織の分離（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)、[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md)）、大阪への DR の世代（[ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md)）、直列化の形式（[ADR-0008](../decisions/0008-canonical-binary-serialization.md)）、送受信（[ADR-0009](../decisions/0009-multiplayer-wire-protocol.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0024](../decisions/0024-journal-items-and-fencing.md) | ジャーナルの項目は `seq` の範囲の group commit。書き込みは、フェンスの項目の `epoch` を確かめる `TransactWriteItems` で行い、`ClientRequestToken` で再試行を冪等にする。大きな変更は S3 に置いて項目から指す。TTL は書いた時点から 30 日で、回復の漏れは掃除のジョブで拾う |
| [0025](../decisions/0025-content-addressed-checkpoints-and-loading.md) | チェックポイントはマニフェストと、中身のハッシュで名付けたページのチャンク。変わったページだけを書く。クライアントは、判定の後に出す署名付きの URL で CloudFront からチャンクを読み、端末にキャッシュし、それより後の変更だけを Document Server から受け取る |
| [0026](../decisions/0026-version-history-restore-and-deletion.md) | 版は、チェックポイントに印を付けたもの（自動・名前付き・復元の前後）。復元は差分を 1 つの変更として当て、履歴を消さない。削除はゴミ箱と完全な削除の 2 段で、完全な削除は S3・ジャーナル・版を消すジョブで行う |

## 1. 目的と範囲

- 扱う：ジャーナルの項目の形と書き込み・読み出し、チェックポイントの作り方と置き場所、ファイルを開くときの読み込み、ファイルを手放すとき、持ち主の交代での回復、版の履歴の API、復元、複製、ゴミ箱と完全な削除、保持と掃除、リージョンの複製。
- 扱わない：ノードとチャンクの中身の形（[document-model.md](document-model.md)）、変更の送受信（[multiplayer.md](multiplayer.md)）、Router の割り当ての実装（[infrastructure.md](infrastructure.md) の 5 節）、画像とサムネイル（[export-and-assets.md](export-and-assets.md)）、権限の判定（[permissions-and-sharing.md](permissions-and-sharing.md)）、データの削除の期間の法務の判断（[security.md](security.md)、[intent.md](../intent.md) の L4）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| チェックポイント | 以前は 30〜60 秒ごとにファイル全体を S3 へ書くだけだった（[Making multiplayer more reliable](https://www.figma.com/blog/making-multiplayer-more-reliable/)、2022-10-20） | 60 秒か 5,000 件ごと（ADR-0003）。変わったページだけを書く（ADR-0025） |
| ジャーナル | DynamoDB。変更にファイルごとの連番を振り、`[start, end]` の範囲でまとめて約 0.5 秒ごとに書く。1 日 22 億件の変更、95% を約 600ms 以内に保存（同上） | 約 20ms ごとの group commit。確定の前に書く（ADR-0003） |
| 二重の持ち主 | DynamoDB の別の表に `(lock UUID, file key)` を書いて持ち主になり、ジャーナルの書き込みは lock UUID が一致する条件付きにする。読み取りは強い整合性（同上） | 同じ考え方。フェンスの項目の `epoch` を `TransactWriteItems` の `ConditionCheck` で確かめる（ADR-0024） |
| 検証 | チェックポイント A とその後のジャーナルから作ったファイルが、チェックポイント B とバイト単位で一致するかを、本番で影として約 40 万回続けて確かめてから出した（同上） | 同じ検証を、出す前と本番の抜き取りで行う（13 節） |
| 版の履歴 | 自動の版は 30 分ごと。接続が切れたときやアプリが落ちたときにも作る。Starter と下書きは 30 日、有料のプランはすべての履歴を見られる。復元は、今の状態と復元した版の 2 つの自動の版を足し、履歴を消さない。版から新しいファイルを作れるが、コメントと履歴は写らない。名前付きの版を作れる（[View a file's version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)） | 同じ振る舞い（8〜10 節） |
| 削除 | ゴミ箱に入れ、権限のある人が戻すか完全に消すまで残す。完全に消したら、どのプランでも戻せない。消したチームは 28 日以内なら戻せる（[Delete and restore files](https://help.figma.com/hc/en-us/articles/360047512294-Delete-and-restore-files)） | 同じ（11 節） |

いずれも 2026-09-27 に確認。本家が、ジャーナルに書く前に送り手へ確定を返すかは記事にない（**未検証**。ADR-0003 の注記と同じ）。

## 3. 置き場所

| 置き場所 | 中身 | 正本か |
| --- | --- | --- |
| DynamoDB `journal` | ジャーナルの項目とフェンスの項目（4 節） | チェックポイントより後の変更の正本 |
| DynamoDB `file_leases`・`ds_liveness` | Router の割り当てとタスクの生存（ADR-0047。[infrastructure.md](infrastructure.md) の 5 節） | 持ち主の正本 |
| S3 `<brand>-files-{env}-{region}` の `files/{file_id}/` | マニフェスト、チャンク、大きな変更の本体（5 節） | ファイルの中身の正本 |
| Aurora `files`・`file_versions`・`file_storage_jobs` | 最新のチェックポイントの位置、版の一覧、ジョブ（15 節） | メタデータの正本（RLS） |
| Document Server のメモリ | 今の状態 | 正本ではない（落ちたら上から戻す） |
| ブラウザの IndexedDB | チャンクのキャッシュ（6.3 節） | 正本ではない |

- S3 のキーには `org_id` を入れない。ファイルの組織は Aurora の `files` で決める。ファイルを別の組織へ移しても、オブジェクトを動かさない。
- S3 はバージョニングを有効にし、古い版は 30 日で消す。大阪へのクロスリージョンのレプリケーションに要る（ADR-0003）。レプリケーションは、版を指定した削除とライフサイクルの動作を複製しない（削除マーカーも、既定では複製しない。[What does Amazon S3 replicate?](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-what-is-isnot-replicated.html)、2026-09-27 に確認）ので、ライフサイクルの規則は東京と大阪の両方のバケットに置く（11.2 節、ADR-0045）。

## 4. ジャーナル

ADR-0024。

### 4.1 項目の形

```
journal  (PK: pk S, SK: seq N)
  pk = {file_id}          // 世代 1
     = {file_id}#g{g}     // 大阪への切り替えの後の世代 g ≥ 2（ADR-0048）

フェンスの項目：seq = 0
  epoch        N   // 今の持ち主の epoch（file_leases の割り当ての epoch と同じ値）
  owner        S   // Document Server のタスクの ID
  fenced_at    N
  base_gen     N   // 世代 2 以降だけ：回復の元の世代（ADR-0048）
  base_end_seq N   // 世代 2 以降だけ：元の世代から当てた最後の seq

ジャーナルの項目：seq = このまとまりの最初の seq（1 以上）
  end_seq      N   // このまとまりの最後の seq
  epoch        N   // 書いた持ち主の epoch
  fmt          N   // 本体の形式の版
  body         B   // zstd(JournalBatch)。350 KiB を超えるときは持たない
  blob_key     S   // body の代わりに S3 に置いたときのキー（4.3 節）
  body_sha256  B
  bytes        N   // 圧縮の前の大きさ
  written_at   N   // UNIX 秒
  ttl          N   // written_at + 30 日（4.5 節）
```

```
JournalBatch {
  entries: [ {
    seq, session_id, client_seq, committed_at_ms,
    origin,                   // document-model.md の 7 節（User・Plugin・LayoutRepair・Server）
    ops: Vec<Op>,             // 4.3 節のまとめの後
    server_ops: Vec<Op>,
  } ],
  session_opens: [ { session_id, user_id, seq } ],   // ADR-0007
}
```

- 利用者の ID は、`session_opens` にだけ書く。各変更には `session_id` だけを書く。
- 以下の手順の `journal[file_id, …]` は、今の世代のパーティションキー（世代 1 は `file_id`、世代 2 以降は `{file_id}#g{g}`）を指す。
- DynamoDB の項目は 400 KB まで、トランザクションは 100 項目・4 MB まで（[Constraints in Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)、2026-09-27 に確認）。

### 4.2 書き込み

```
TransactWriteItems(
  ClientRequestToken = hash(file_id, epoch, start_seq)   // 36 文字以内
  ConditionCheck: journal[file_id, 0]           epoch = :my_epoch
  Put:            journal[file_id, start_seq]   attribute_not_exists(seq)
)
```

1. file actor は、検証を通った `ChangeSet` を書き込みの待ち行列に積む。
2. 書き込みのタスクは、前の書き込みが終わっていて、待ち行列の最初の変更から 20ms たつか、256 KiB か 500 件たまったら、1 つのまとまりにして書く。書き込み中に届いた変更は次のまとまりに入る（同時に書くのは 1 つだけ。順序を単純に保つ）。
3. 成功したら、`durable_seq = end_seq` にし、その範囲の `Committed` と `Ack` を送る（[multiplayer.md](multiplayer.md) の 4.5 節）。

| 結果 | 扱い |
| --- | --- |
| 成功 | 確定 |
| `TransactionCanceled`：フェンスの `ConditionalCheckFailed` | 持ち主が変わった。状態を捨て、`Kick(owner_changed)`、ファイルを手放す |
| `TransactionCanceled`：`Put` の `ConditionalCheckFailed` | 同じ `seq` を別の持ち主が書いた（フェンスの前の古い持ち主との競合）。同上 |
| `TransactionConflict`・スロットリング・タイムアウト・5xx | 同じ `ClientRequestToken` と同じ中身で再試行する（指数の待ち、最大 10 秒）。トークンは最初の完了から 10 分間冪等である（[TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)、2026-09-27 に確認）。前の試行が実は成功していても、二重に書かれない |
| 10 秒たっても書けない | 確定できないまま持ち続けない。`Kick(owner_changed)` を送り、ファイルを手放す。新しい持ち主が回復し、クライアントが送り直す。書けていたかどうかは、新しい持ち主のジャーナルの読み取りで決まる |

- フェンスの項目を割り当ての項目（`file_leases`）と分けるのは、ADR-0024 の時点では、ファイルごとのリースの延長とジャーナルの書き込みが同じ項目に当たるのを避けるためだった。ADR-0047 で延長はタスクの生存の表へ移ったが、フェンスをジャーナルと同じパーティションに置くことで、世代ごとの回復（ADR-0048）がジャーナルの表の中で閉じる。フェンスの項目は、持ち主が変わるときだけ書く。
- トランザクションの書き込みは、通常の 2 倍の単位を使う（[Constraints in Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)）。1 ファイルの書き込みの上限は [multiplayer.md](multiplayer.md) の 12.3 節。

### 4.3 まとめと大きな変更

- **まとめ**：1 つのまとまりの中で、後の変更が同じ `(ノード, プロパティ)` を書くなら、前の変更からその操作を除く。ただし、その間にそのノードの `Create`・`Delete` があるときは除かない。各変更の見出し（`seq`・`session_id`・`client_seq`）は残す。まとまりの終わりの状態は、除く前と同じになる（PROP-FS-005）。ドラッグのような連続の操作で、書き込みの量を抑える。
- **大きな変更**：圧縮した本体が 350 KiB を超えるまとまりは、先に S3 の `files/{file_id}/journal-blobs/{start_seq}-{epoch}`（世代 2 以降は `journal-blobs/g{g}/{start_seq}-{epoch}`）へ置き、項目には `blob_key` と `body_sha256` だけを書く。S3 の書き込みの分、確定が遅れる（大きな貼り付けだけ）。
- まとめる前の 1 つの `ChangeSet` は 4 MiB まで（[multiplayer.md](multiplayer.md) の 4.6 節）。

### 4.4 持ち主が変わるとき（フェンス）

新しい持ち主は、Router から割り当て（`file_leases`、`epoch = E`。ADR-0047）を受けた後、次の順に進む。大阪への切り替えの後の世代をまたぐ回復は ADR-0048 の手順（元の世代のチャンクがそろった最新のマニフェストから、飛びの手前まで当てる）に広げる。

1. `UpdateItem journal[file_id, 0] SET epoch = :E, owner = :me  IF attribute_not_exists(epoch) OR epoch < :E`。失敗したら、より新しい持ち主がいるので手を引く。
2. Aurora の `files.checkpoint_seq` と `checkpoint_key` を読み、マニフェストとチャンクを読む（5 節）。
3. `Query journal  file_id = :f AND seq > :checkpoint_seq`（強い整合性の読み取り、1 MB ごとに続きを読む）。
4. 項目の範囲が続いているか（`次の seq = 前の end_seq + 1`）を確かめる。飛びがあれば読み込みを止め、ファイルを `maintenance`（理由 `journal_gap`。`files.state`、[data-model/organization.md](data-model/organization.md) の `files`）にしてアラームを出す（12 節）。
5. `seq` の順に当てる。`session_opens` と各変更の `(session_id, client_seq)` から、セッションの表を戻す。
6. 受け付けを始める。

- 1 のフェンスの後は、古い持ち主の書き込みはすべてフェンスの `ConditionCheck` で失敗する。3 の読み取りより後に古い持ち主が書き足すことはない。
- 回復の時間の目安（NFR-007 の 15 秒）：持ち主の生存の期限 10 秒＋猶予 2 秒＋読み込みと当て直し（[infrastructure.md](infrastructure.md) の 5.4 節）。60 秒ぶん（最大 5,000 件）のジャーナルを当てる時間は 1 秒未満を見込む（**未検証**。E7 の `journal-fencing-recovery` で計測する）。

### 4.5 保持と TTL

- TTL は書いた時点で `written_at + 30 日` にする。ADR-0003 の「チェックポイントより古い項目を 30 日後に消す」を、項目を書き直さずに満たす形にした。チェックポイントは最大 60 秒ごとに書かれるので、ほとんどの項目は書いた直後にチェックポイントより古くなる。
- TTL の削除は数日以内で、期限の過ぎた項目も消えるまでは読める（[Using time to live (TTL) in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)、2026-09-27 に確認）。回復の読み取りは、期限で絞らない。
- **危険**：Document Server が落ちた後、そのファイルが 30 日開かれないと、チェックポイントより後の項目が TTL で消える。これを防ぐため、次の 2 つを持つ。
  - **回復のジョブ**：持ち主のタスクの生存が切れたまま、手放しの記録（`released`・`handoff`）のないファイルを、Router が見つけ、5 分以内に Document Server に割り当てて回復させ、チェックポイントを書いて手放させる（ADR-0047）。
  - **掃除の見張り**：毎日、`file_leases` のうち生存の切れた持ち主の `owned` を数え、1 日を超えて残るものをアラームにする。
- ジャーナルの表は、PITR（35 日）を有効にする（[What is Amazon DynamoDB?](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html)、2026-09-27 に確認）。

## 5. チェックポイント

ADR-0025。形は [document-model.md](document-model.md) の 8.2 節。

### 5.1 書くとき

| きっかけ | 版の種類（8 節） |
| --- | --- |
| 前のチェックポイントから 60 秒たち、変更がある | なし（自動の版の条件に当たれば自動の版） |
| 前のチェックポイントから 5,000 件 | 同上 |
| ファイルを手放すとき（接続が 0 になって 10 分、Document Server の停止） | 同上 |
| 名前付きの版を作る | 名前付き |
| 復元の前と後 | 復元の前・復元した版 |
| 複製の元（今の状態から複製するとき） | なし |

### 5.2 手順

1. file actor は、今の `Doc` の写し（HAMT なので O(1)）と、その時点の `seq = S` と、前のチェックポイントからの変わったページの一覧を取る。
2. 別のスレッド（`spawn_blocking`）で、変わったページだけを直列化し、zstd で圧縮し、SHA-256 を計算する。変わっていないページは、前のマニフェストのチャンクの参照をそのまま使う。
3. 新しいチャンクを `files/{file_id}/chunks/{sha256}` に PUT する（同じハッシュなら中身も同じなので、上書きしても害がない）。
4. `durable_seq ≥ S` になるまで待つ（写しには、まだジャーナルに書けていない変更が含まれうる）。その前に持ち主でなくなったら、ここで捨てる。
5. マニフェストを `files/{file_id}/checkpoints/{S:020}`（世代 2 以降は `checkpoints/g{g}/{S:020}`。ADR-0048）に PUT する。
6. Aurora：`UPDATE files SET checkpoint_seq = S, checkpoint_key = ..., node_count = ..., size_bytes = ... WHERE id = :file AND checkpoint_seq < S AND state <> 'purging'`。
7. 版の条件（8.2 節）に当たれば、同じトランザクションで `file_versions` に行を足す。

- 6 が失敗しても、ジャーナルが残っているので、回復は古いチェックポイントから進むだけで、正しさは変わらない。
- 5 の後・6 の前に落ちると、どこからも指されないマニフェストが残る。掃除（5.4 節）で消す。

### 5.3 チェックポイントの保持

- 版の印のないチェックポイントは、48 時間以内のものはすべて、それより古いものは 1 日に 1 つを 30 日まで残し、それより古いものは消す。
- 30 日の間は、日ごとのチェックポイントと 30 日のジャーナルから、どの `seq` の状態も作り直せる。チェックポイントの破損に気づいてから戻す余裕（ADR-0003）。
- 版の印のあるチェックポイントは、版の保持（8.4 節）に従う。

### 5.4 掃除（GC）

ファイルごとに、Worker のジョブで行う。きっかけは、ファイルを手放したとき（前の掃除から 24 時間以上）と、毎日の見回り（直近 31 日に編集されたファイル）。

1. `files/{file_id}/checkpoints/`（世代の下も含む）を一覧し、5.3 節と 8.4 節の規則で残すマニフェストを決め、残さないものを消す。`files.checkpoint_key` が指すものは必ず残す。
2. 残すマニフェストが参照するチャンクの集合を作る。
3. `files/{file_id}/chunks/` のうち、集合になく、最終更新から 7 日を過ぎたものを消す。7 日は、書き込み中のチェックポイントと、読み込み中のクライアントを守る猶予。
4. `journal-blobs/` のうち、ジャーナルの項目の TTL（30 日）を過ぎたものを消す。

- 新しいチェックポイントが古いチャンクを再び指すのは、前のチェックポイント（必ず残す）か、復元した版（版として残す）のチャンクだけである。どちらも残す集合に入るので、消えない。
- 掃除は東京と大阪の両方のバケットで行う（S3 の削除は複製されない。ADR-0045）。大阪の側は、大阪にあるマニフェストから残す集合を作る。

## 6. ファイルを開く（読み込み）

ADR-0025。

### 6.1 流れ

```
Browser                    API            Gateway / Router       Document Server           CloudFront + S3
  │ GET /files/{id} ─────────▶│ 判定関数 → 役割、ticket（60 秒）
  │◀───── ticket ─────────────│
  │ WebSocket Hello ──────────────────────▶│ 判定、持ち主の問い合わせ ───▶│（なければ回復：4.4 節）
  │◀──────────────────────────────── Welcome { LoadPlan } ──────────────│
  │ 今のページのチャンク：端末のキャッシュ、なければ署名付き URL で取る ─────────────────────────▶│
  │ 復号 → 当てる → LoadPlan.tail の変更を当てる → 描画（操作できる）
  │ 他のページのチャンクを、裏で順に取る
```

```
LoadPlan {
  manifest_seq: u64,
  document_chunk: ChunkRef + url,
  pages: [ { page_id, node_count, chunks: [ChunkRef + url] } ],   // 今のページを先頭に
  sessions_chunk: ChunkRef + url,
  tail: Vec<Committed>,       // manifest_seq より後、今の seq までの確定した変更
  url_expires_at,
}
```

- `url` は `files.<brand>usercontent.<domain>` の CloudFront の署名付き URL（期限 5 分、パスは `files/{file_id}/chunks/{sha256}`）。Document Server が、接続の判定を通ったセッションにだけ出す。署名はキャッシュの鍵に含めない（[permissions-and-sharing.md](permissions-and-sharing.md) の 11 節）。ブラウザは S3 を直接読まない（ADR-0005）。
- `tail` は、最大でチェックポイントの間隔（60 秒か 5,000 件）ぶん。Document Server がメモリに持つ直近の確定した変更から作る。
- 期限が切れたら、`LoadPage` で新しい URL を求める。
- 1 つの大きなファイルを数百人が同時に開いても（会議の始まり）、チャンクは CloudFront から配られ、Document Server の送信は `tail` だけになる。

### 6.2 ページの遅延の読み込み

- 最初に読むのは、`DOCUMENT` と全ページの `CANVAS` のノード（`document_chunk`）と、今のページのチャンクだけ。
- 他のページは、今のページが操作できるようになった後に、裏で 1 つずつ読む。メモリが NFR-004 の 80% を超えそうなら、見ていないページを読まないでおく。
- 読み込んでいないページへの変更の扱いは [multiplayer.md](multiplayer.md) の 6.3 節。

### 6.3 端末のキャッシュ

- チャンクは中身のハッシュで名付けるので、変わらない。ブラウザの IndexedDB に、ハッシュを鍵にして置く（利用者ごと、合計 500 MB、古い順に外す）。
- 2 回目に開くときは、変わったページのチャンクだけを取る（NFR-003 のキャッシュありの 2 秒）。
- ログアウトしたら、その利用者のキャッシュを消す。権限を失ったファイルのチャンクは、ファイルの一覧の同期（Realtime）で知ったときに消す。
- 共有の端末でのキャッシュの暗号化は MVP でしない（16 節）。

### 6.4 Document Server が読み込むとき

- 4.4 節の回復と同じ手順。チャンクは S3 から直接読む（VPC のゲートウェイエンドポイント）。
- 大きなファイル（メモリの見積もり 1.5 GiB 超。圧縮の前のチェックポイントでおよそ 500 MB 超）は、`ds-large` のタスクへ置く（[ADR-0051](../decisions/0051-document-server-memory-admission.md)）。

### 6.5 手放すとき

- 接続が 0 になって 10 分たったら、チェックポイントを書き、フェンスはそのままにして割り当てを手放す（`file_leases` を `released` にし、`released_seq` を記録する。ADR-0047）。
- 手放した後に開かれたら、別の Document Server が 4.4 節で読み込む（`epoch` を上げる）。

## 7. 回復の保証

- **確定したものは失わない**：`Ack`・`Committed` を出した変更は、ジャーナルかチェックポイントにある（4.2 節の順序）。
- **二重の持ち主でも分かれない**：ジャーナルに書けるのは、フェンスの `epoch` を持つ 1 つだけ（4.2・4.4 節）。
- **作り直しは一致する**：チェックポイント A と `(A, B]` のジャーナルから作った状態は、チェックポイント B と同じバイト列（[document-model.md](document-model.md) の 8.3 節の正準形）。
- **確定の前に失われうるもの**：クライアントが送り直す（[multiplayer.md](multiplayer.md) の 9 節）。タブが閉じていれば失われる（NFR-006 の範囲の外）。
- **リージョンの喪失**：ジャーナルはグローバルテーブル（非同期）、S3 はクロスリージョンのレプリケーションで大阪へ。最大 1 分の損失を許す（NFR-009、ADR-0003）。大阪での再開の手順は infrastructure.md で決める。

## 8. 版の履歴

ADR-0026。

### 8.1 版の種類

| 種類 | 作るとき | 画面 |
| --- | --- | --- |
| `auto` | 8.2 節の条件 | 日時 |
| `named` | 利用者が名前と説明を付けて作る。`auto` に後から名前を付けても `named` になる | 名前と説明 |
| `restore_before` | 復元の直前の状態 | 「復元の前」 |
| `restore_after` | 復元した直後の状態 | 「{版} を復元」 |
| `dr_salvaged` | 大阪への切り替えで今のファイルに入らなかった、東京で確定した編集を `dr-salvage` のジョブが取り戻した状態（ADR-0048） | 「障害で反映されなかった編集」。今のファイルには混ぜず、利用者が比べて復元か複製を選ぶ |

### 8.2 自動の版

- チェックポイントを書いたとき、最後の `auto` から 30 分以上たち、その間に変更があれば、そのチェックポイントを `auto` にする。
- ファイルを手放すときのチェックポイントも、最後の `auto` から 5 分以上たっていれば `auto` にする（本家の「接続が切れたときにも作る」に当たる）。

### 8.3 API

| API | 中身 |
| --- | --- |
| `GET /files/{id}/versions?cursor=` | 版の一覧（新しい順、50 件ずつ）。作った人、種類、名前、日時。水準 `view` 以上 |
| `POST /files/{id}/versions` `{ name, description }` | 名前付きの版を作る。Document Server にチェックポイントを求める（ファイルが開かれていなければ、Router が割り当てる）。`edit` 以上 |
| `PATCH /files/{id}/versions/{vid}` `{ name, description }` | 名前と説明を変える。`edit` 以上 |
| `GET /files/{id}/versions/{vid}/view` | その版を閲覧するための `LoadPlan`（`tail` は空）。Document Server を通さず、API が判定してチャンクの署名付き URL を出す。閲覧だけで、編集できない。`view` 以上 |
| `POST /files/{id}/versions/{vid}/restore` | 9 節。`edit` 以上 |
| `POST /files/{id}/duplicate` `{ version_id?, project_id }` | 10 節。`edit` 以上、または `view` で「閲覧者に複製を許す」がオン（permissions-and-sharing.md の 4.2 節） |

- 水準と操作の対応の正は、permissions-and-sharing.md の 4.2 節（水準 × 操作）。ここに書いた要る水準は、その表の写しである。

### 8.4 保持

| プラン | 版の保持 |
| --- | --- |
| 無料 | 30 日。30 日を過ぎた版は、最新の 1 つを除いて消す（見えなくするだけでなく、掃除で消す） |
| 有料 | すべて残す |

- 本家の Starter と下書きは 30 日、有料はすべての履歴を見られる（2 節）。本システムも同じにする（2026-09-27 に決定。[intent.md](../intent.md) の Open questions）。
- プランを上げても、消した版は戻らない。

## 9. 復元

1. API が判定関数で `edit` 以上を確かめ、Router に持ち主を求め（なければ割り当てる）、Document Server の内部の API `restore(version_id, user_id)` を呼ぶ。
2. file actor は、今の状態でチェックポイントを書き、`restore_before` の版にする。
3. 版のマニフェストとチャンクを読み、今の状態との差分（作る・消す・プロパティの置き換え）を計算する。ノードの ID は版のものをそのまま使う。
4. 差分を 1 つの `ChangeSet`（`session_id = 0`、実行した利用者の ID を付ける）として、通常の変更と同じくジャーナルに書き、`Committed` を配る。4 MiB を超えるときは、ジャーナルには大きな変更として書き（4.3 節）、クライアントには `Kick(resync_required)` を送って読み込み直させる。
5. チェックポイントを書き、`restore_after` の版にする。

- 復元より前の版は消えない。コメントはすべて残る（コメントはメタデータにあり、ノードの ID で付く。消えたノードに付いたコメントは、キャンバスの位置に残る。comments-and-notifications.md）。
- 復元の最中に届いた他の人の変更は、復元の後に `seq` の順で当たる（LWW）。
- 版の閲覧（8.3 節の `view`）は、ファイルの状態を変えない。

## 10. 複製

1. API が判定関数で複製を許すか（上の表）を確かめ、新しい `files` の行を `state = 'creating'` で作る（複製先の組織・プロジェクト）。
2. 元のマニフェストを決める：`version_id` があればその版、なければ今の状態（開かれていれば Document Server にチェックポイントを求め、開かれていなければ `files.checkpoint_key`。回復が要る状態なら、先に回復させる）。
3. Worker のジョブが、チャンクを新しいファイルのキーへ S3 の中でコピーし（`CopyObject`）、新しいマニフェストを `seq = 0` で書く。`next_session_id` は元の値を引き継ぎ（ノードの ID を変えないため。ADR-0007）、セッションの表は空にする。
4. 画像の参照（`blob_refs_chunk`）を export-and-assets の領域に渡し、複製先の組織から読めるようにする（インターフェースは `assets.copy_refs(src_file, dst_file, hashes)`）。
5. `files.state = 'active'`、`source_file_id`・`source_version_id` を記録する。サムネイルは作り直す。

- コメントと版の履歴は写さない（本家と同じ）。
- 大きなファイルの複製は数十秒かかりうる。一覧には「複製中」と出す。

## 11. 削除

ADR-0026。

### 11.1 状態

```
active ──ゴミ箱へ──▶ trashed ──完全に削除──▶ purging ──ジョブの完了──▶ purged
   ▲                    │
   └────── 戻す ────────┘
```

| 操作 | 権限 | 中身 |
| --- | --- | --- |
| ゴミ箱へ | `owner`（permissions-and-sharing.md の 4.2 節） | `state = 'trashed'`、`trashed_at`、`trashed_by`。Gateway に知らせ、接続中の人に `Kick(file_deleted)`。Document Server はチェックポイントを書いて手放す。新しく開けない |
| 戻す | `owner` | `state = 'active'` |
| 完全に削除 | ゴミ箱にあるファイルの `owner` | `state = 'purging'`、削除のジョブを積む。戻せない |

- ゴミ箱のファイルは、誰かが戻すか完全に消すまで残す（本家と同じ）。組織の管理者が期間を決めて自動で消す設定は、MVP の後にする。
- チームを消したときは、配下のファイルをゴミ箱に入れ、28 日の間はチームごと戻せる（本家と同じ）。28 日を過ぎたら、配下のファイルの完全な削除を積む。組織の解約も同じ形にし、期間は法務の確認の後に決める（[intent.md](../intent.md) の L4）。

### 11.2 完全な削除のジョブ

`file_storage_jobs` に手順ごとの進み具合を持ち、途中で止まっても続きからやり直せる（各手順は冪等）。

1. Router：そのファイルの割り当てを `deleted` にし（`epoch` を最大値に。ADR-0047）、どの Document Server も持てないようにする。フェンスの `epoch` を最大値に上げる。
2. ジャーナル：`Query` で項目を集め、`BatchWriteItem` の削除（25 件ずつ）で消す。フェンスの項目も消す。
3. S3：`files/{file_id}/` の下のすべてのオブジェクトと、その古い版（バージョニング）を `DeleteObjects`（1,000 件ずつ）で消す。**東京と大阪の両方のバケットで行う**（S3 のレプリケーションは版を指定した削除を複製しない。ADR-0045）。大阪が止まっていれば、大阪の手順だけを後から流す（手順を分けて記録する）。DynamoDB のジャーナルの削除は、グローバルテーブルが大阪へ伝える。
4. 画像の参照を export-and-assets の領域に外させる（参照の数が 0 になった画像の削除は、その領域の規則による）。
5. `file_versions` の行、コメント（comments-and-notifications の領域に依頼）、検索の索引（search の領域に依頼）、サムネイルを消す。
6. `files` は、`id`・`org_id`・`purged_at` だけを残し、他の列を消す（監査のため。期間は security.md で決める）。`state = 'purged'`。

- **消えずに残る場所**：DynamoDB の PITR（東京・大阪とも 35 日）、Aurora のバックアップ（35 日）。S3 は 3 の手順で両方のバケットの古い版まで消す。完全な削除から最大 35 日は、バックアップに中身が残る。利用規約とデータ処理の契約への書き方は法務の確認待ち（L4）。

## 12. 障害のときの振る舞い

| 障害 | 起きること | 対応 |
| --- | --- | --- |
| Document Server が落ちた | メモリの状態が消える | 持ち主の生存の期限の後に別の持ち主が 4.4 節で回復（NFR-007） |
| ジャーナルの書き込みが遅い・スロットリング | 確定が遅れる | 同じトークンで再試行。10 秒でファイルを手放す（4.2 節） |
| ジャーナルの書き込みの結果が分からない（タイムアウト） | 書けたか分からない | 同じトークンで再試行（冪等）。手放した後は、新しい持ち主の読み取りで決まる |
| 二重の持ち主 | 片方が書けない | 書けない方が手放す（4.2 節） |
| チェックポイントの PUT が失敗 | チェックポイントが進まない | 次のきっかけでやり直す。ジャーナルは残る。3 回続けて失敗したらアラーム（チェックポイントが 10 分進まないファイル） |
| チャンクの破損（ハッシュが合わない） | そのチェックポイントを読めない | 残っている 1 つ前のチェックポイントと、ジャーナルから作り直す（30 日の範囲）。作り直したら新しいチェックポイントを書く |
| ジャーナルの飛び | 回復で `seq` が続かない | 読み込みを止め、ファイルを `maintenance`（`journal_gap`）にする。編集させない。runbook で調べる |
| 手放さずに落ちたファイルが開かれない | TTL で後の項目が消える危険 | 回復のジョブ（4.5 節）。1 日残ればアラーム |
| S3 の障害 | 開けない、チェックポイントが書けない | 開いているファイルの編集は続く（ジャーナルだけで確定できる）。チェックポイントの間隔が伸びる。回復の時間が伸びる |
| DynamoDB の障害 | 確定できない | 編集が止まる（NFR-008 の可用性に効く）。閲覧は、チャンクが読めれば続く |
| Aurora の障害 | `checkpoint_seq` を進められない、版を作れない | ジャーナルとチェックポイントの PUT は続く。回復は古い `checkpoint_seq` から進むので、読むジャーナルが増えるだけ |

## 13. セキュリティ

- Document Server の IAM のロールは、`journal` の表と `files/*` のキーの読み書きだけ。Worker は読み取りと、ジョブの種類ごとに要るものだけ。ブラウザは S3 を直接読まない。
- チャンクの署名付き URL は、判定を通ったセッションにだけ、5 分の期限で出す。URL が漏れても 5 分で使えなくなる。キーのハッシュは中身から決まるが、ファイルの ID を含むパスでしか読めない。
- S3 は SSE-KMS（バケットキー）、DynamoDB は顧客管理の KMS の鍵で暗号化する。組織ごとの鍵は security.md で決める（MVP の後の候補）。
- 版の閲覧・復元・複製は、元のファイルの判定関数を通す。複製先の組織の文脈で元のチャンクを読むことはない（S3 の中でコピーし、新しいファイルの ID のキーにする）。
- ログには `file_id`・`seq`・大きさ・理由だけを書く。
- 完全な削除のジョブは、実行した人・日時・ファイルの ID を監査のログに残す（security.md）。

## 14. テスト

### 14.1 性質ベーステスト

- **PROP-FS-001（耐久性）**：任意の変更の列・チェックポイントの位置・落ちる位置で、回復した状態が「確定した最後の `seq`」の状態と一致し、`Ack` を返した変更をすべて含む。
- **PROP-FS-002（作り直しの一致）**：任意のチェックポイント A・B（A < B）で、A と `(A, B]` のジャーナルから作った状態の正準形が、B と同じバイト列。
- **PROP-FS-003（復元）**：任意の版 V への復元の後、状態が V と一致し、それまでの版がすべて残る。
- **PROP-FS-004（掃除）**：任意のチェックポイント・版・掃除の列で、残すマニフェストが参照するチャンクは消えない。
- **PROP-FS-005（まとめ）**：任意のまとまりで、4.3 節のまとめの前と後で、まとまりの終わりの状態が一致する。
- **PROP-FS-006（複製）**：複製したファイルの状態が、元の版の状態と一致する（ノードの ID を含む）。
- **PROP-FS-007（フェンス）**：任意の 2 つの持ち主の書き込みの交ざりで、ジャーナルの項目の範囲が続き、1 つの `epoch` の列に分かれない。

### 14.2 障害注入（E7・E12）

- Document Server を、ジャーナルの書き込みの前・中・後、チェックポイントの各手順（5.2 節の 1〜7）の間で強制終了する。PROP-FS-001 を確かめる。
- DynamoDB への呼び出しに、遅延・スロットリング・タイムアウト（実際は成功）・`TransactionConflict` を注入する（テスト用の中継）。二重に書かれず、`Ack` の欠落もない。
- 同じファイルを 2 つの Document Server に持たせ（生存の期限を短くし、古い持ち主の停止を注入）、片方だけが確定する。
- チャンクの中身を壊し、1 つ前のチェックポイントからの作り直しを確かめる。
- ジャーナルの項目を 1 つ消し、飛びの検知とアラームを確かめる。
- 大阪への複製の遅れ（グローバルテーブルの複製の一時停止。AWS FIS の操作がある。[What is Amazon DynamoDB?](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html)）の中でリージョンを切り替え、損失が 1 分以内に収まる（E12 の DR 訓練）。

### 14.3 本番での検証（本家に倣う）

- ジャーナルを出す前に、影の書き込みで PROP-FS-002 を本番のファイルで確かめる（本家は約 40 万回続けて成功してから段階的に出した。2 節）。
- 出した後も、チェックポイントを書くたびに、1% の割合で「前のチェックポイント＋ジャーナル」から作り直して比べる（Worker）。不一致は即時のアラーム。

## 15. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり。

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `dynamodb-journal-table` | `journal` の表、TTL、PITR、グローバルテーブル（大阪）、IAM |
| E1 | `files-bucket` | S3 のバケット、バージョニング、SSE-KMS、クロスリージョンのレプリケーション、CloudFront の署名付き URL |
| E7 | `journal-group-commit` | 4.2・4.3 節。トランザクション、トークン、まとめ、大きな変更 |
| E7 | `journal-fencing-recovery` | 4.4 節。フェンス、回復、飛びの検知 |
| E7 | `checkpoint-writer` | 5.1・5.2 節。変わったページだけのチャンク、`durable_seq` の待ち |
| E7 | `load-plan-and-chunk-cache` | 6 節。`LoadPlan`、署名付き URL、IndexedDB のキャッシュ、ページの遅延の読み込み |
| E7 | `orphan-recovery-job` | 4.5 節の回復のジョブと見張り |
| E7 | `storage-gc` | 5.3・5.4 節 |
| E7 | `version-history-api` | 8 節。一覧、名前付き、版の閲覧 |
| E7 | `version-restore` | 9 節 |
| E7 | `file-duplicate` | 10 節 |
| E7 | `trash-and-purge` | 11 節（東京と大阪の両方のバケット。security.md の `purge-both-regions` と 1 つにする） |
| E7 | `durability-fault-injection` | 14.2 節の枠 |
| E7 | `shadow-replay-validation` | 14.3 節 |
| E12 | `dr-journal-failover-drill` | 大阪への切り替えの訓練と、損失の計測 |

## 16. 未解決の問い

### 決定（2026-09-27、既定案）

- **group commit**：20ms・256 KiB・500 件のどれか早い方。同時に書くのは 1 つ。
- **ジャーナルの TTL**：書いた時点から 30 日。回復のジョブで漏れを防ぐ（4.5 節）。
- **フェンスの置き場所**：ジャーナルの表の `seq = 0` の項目（割り当ての項目と分ける）。
- **大きな変更**：350 KiB を超えたら S3 に置く。
- **チェックポイントの保持**：48 時間はすべて、30 日までは 1 日 1 つ。
- **自動の版**：30 分ごと、手放すときは 5 分ごと。
- **無料のプランの版**：30 日で消す。見えなくするだけにはしない（推奨案で確定。8.4 節）。
- **ゴミ箱**：自動では消さない（本家と同じ）。チームの削除は 28 日で戻せなくなる。
- **端末のキャッシュ**：500 MB、暗号化しない。組織の方針で止められるようにする（[security.md](security.md) の決定、ADR-0044）。
- **組織ごとの KMS の鍵**：MVP で持たない（ADR-0044）。持ち込みの鍵の需要は S2 の前に企業の商談で見る（security.md）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| DynamoDB のトランザクションの書き込みの p99 と、フェンスの `ConditionCheck` の費用が NFR-001 に収まるか | E3・E7 の前の PoC |
| 1 ファイルの書き込みが 1 パーティションの上限に近づいたときの分け方（ジャーナルのパーティションキーを `file_id#bucket` に分けるか） | 負荷試験（E12）。分けると回復の読み取りが複数になる |
| 完全な削除の後、バックアップに残る期間（最大 35 日）の書き方 | 法務（L4） |
| 回復の時間（60 秒ぶんのジャーナルの当て直し）の実測 | E7 |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- 確定の時間のうちジャーナルの書き込みの p50・p99、まとまりの大きさと件数の分布、まとめで除いた操作の割合。
- 再試行・`TransactionConflict`・スロットリングの率。フェンスの失敗の数（二重の持ち主の目安）。
- チェックポイントの間隔の実測、書く時間、1 回に書いたチャンクの数とバイト数、10 分進まないファイルの数。
- 回復の時間（生存の切れ → 受け付けの再開）の p95（NFR-007）。
- 作り直しの検証（14.3 節）の実行数と不一致の数（目標 0）。
- 開く時間（NFR-003）のうち、チャンクの取得・復号・`tail` の適用の内訳、端末のキャッシュの当たりの率。
- 手放さずに 1 日を超えて残るファイルの数（目標 0）。
- 完全な削除のジョブの完了までの時間と、止まったジョブの数。

### runbooks

- `journal-gap-or-corruption.md`：ジャーナルの飛び・チャンクの破損を見つけたときに、ファイルの編集を止め、PITR と日ごとのチェックポイントから作り直す手順。
- `journal-throttling.md`：DynamoDB のスロットリング・遅延で確定が遅れたときの確かめ方（表・パーティション・ファイル）と、まとめの間隔の引き上げ。
- `orphaned-file-recovery.md`：手放さずに残ったファイルを一覧し、回復のジョブを手で流す手順。
- `checkpoint-stalled.md`：チェックポイントが進まないファイルの確かめ方（S3、Aurora、直列化の時間）。
- `file-purge-request.md`：利用者・組織からの完全な削除の依頼と、バックアップに残る期間の説明（法務の確認の後）。
- `version-restore-support.md`：サポートが、利用者の依頼で版を復元・複製する手順と、監査のログ。

### data-model

形の正本は [data-model/file-storage.md](data-model/file-storage.md)（Aurora・DynamoDB・S3）と [data-model/document.md](data-model/document.md)（直列化）。下は、この領域が持ち込んだ項目の一覧。

| 置き場所 | 中身 |
| --- | --- |
| DynamoDB `journal` | 4.1 節（`seq = 0` はフェンス。PK は世代 1 が `{file_id}`、世代 2 以降が `{file_id}#g{g}`） |
| S3 `files/{file_id}/checkpoints/{seq:020}`・`checkpoints/g{g}/{seq:020}` | マニフェスト（世代 1・世代 2 以降） |
| S3 `files/{file_id}/chunks/{sha256}` | チャンク（世代で分けない） |
| S3 `files/{file_id}/journal-blobs/{start_seq}-{epoch}`・`journal-blobs/g{g}/…` | 大きな変更の本体 |
| Aurora `files` の列 | `checkpoint_seq`、`checkpoint_key`、`node_count`、`size_bytes`、`state`、`trashed_at`、`trashed_by`、`purged_at`、`source_file_id`、`source_version_id`、`last_edited_at`、`checkpoint_gen`。定義は [data-model/organization.md](data-model/organization.md) の `files` |
| Aurora `file_versions` | `org_id`、`file_id`、`id`、`kind`（`auto`・`named`・`restore_before`・`restore_after`・`dr_salvaged`）、`seq`、`region_gen`、`manifest_key`、`name`、`description`、`created_by`、`created_at`、`delete_after`。`FORCE ROW LEVEL SECURITY` |
| Aurora `file_storage_jobs` | `org_id`、`id`、`file_id`、`kind`（`gc`・`purge`・`duplicate`・`restore`・`orphan_recovery`・`dr_salvage`）、`region`、`step`、`state`、`attempts`、`next_run_at`、`last_error`（中身を含めない） |
| ブラウザの IndexedDB `chunks` | ハッシュ → 圧縮したチャンク（6.3 節） |

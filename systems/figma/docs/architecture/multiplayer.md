# Multiplayer: Figma

同じファイルを複数の人が同時に編集する仕組み。変更の送受信の形式、サーバーでの適用と確定、プロパティ単位の LWW、並びの鍵（分数インデックス）と振り直し、循環の拒否、クライアントの合わせ直し（rebase）、再接続、Undo と Redo、在席とカーソル、人が集まるファイルへの対処を決める。

前提となる決定は、中央のサーバーが順序を決める方式（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md)）、ジャーナルに書いてから確定する（[ADR-0003](../decisions/0003-journal-and-checkpoints.md)）、Router の割り当て（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)、[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md)）、ドキュメントのモデル（[document-model.md](document-model.md)、ADR-0006〜0008）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0009](../decisions/0009-multiplayer-wire-protocol.md) | 送受信は WebSocket の上の二値のメッセージ。変更は `ChangeSet` 単位でセッションごとの `client_seq` を持ち、サーバーはジャーナルに書いた後に `Committed` を配る。再送は `(session_id, client_seq)` で重複を除く |
| [0010](../decisions/0010-ordering-keys-and-cycle-rejection.md) | 並びの鍵は base-62 の可変長の文字列。重なりはサーバーが振り直し、48 バイトを超えたら兄弟をまとめて振り直す。複数のノードの挿入には乱数の接頭辞を付ける。循環を作る変更は `ChangeSet` ごと拒否する |
| [0011](../decisions/0011-presence-and-fan-out.md) | 在席・カーソルはジャーナルに書かない一時的なデータで、Document Server がファイルごとに 50ms（人が多いと 100ms）ごとにまとめて配る。配信は Gateway ごとに 1 回で、Gateway が接続ごとに分ける。1 ファイルの参加は 500 人、編集は 200 人まで |
| [0012](../decisions/0012-multiplayer-undo-redo.md) | Undo は自分の変更を打ち消す新しい変更として送る。他の人が後から上書きした値は戻さない。Redo の項目は Undo を実行した時点の値で作る |

## 1. 目的と範囲

- 扱う：クライアント・Gateway・Document Server の間のメッセージ、接続と再接続、変更の確定の順序、競合の解き方、クライアントの画面の状態、Undo と Redo、在席とカーソル、視点を追う、人が集まるファイル、権限の変化への対応。
- 扱わない：ジャーナル・チェックポイント・読み込みの中身（[file-storage-and-history.md](file-storage-and-history.md)）、ノードとプロパティの定義（[document-model.md](document-model.md)）、Router と Document Server の配置（[infrastructure.md](infrastructure.md)）、権限の判定（[permissions-and-sharing.md](permissions-and-sharing.md)）、テキストの IME（[editor-and-tools.md](editor-and-tools.md)）、版の照合（[delivery.md](delivery.md)）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 権威 | ファイルごとのサーバーのプロセスが権威。OT は使わず、CRDT の考え方を借りる（[How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)、2019-10-16） | 同じ（ADR-0002） |
| 競合 | オブジェクトのプロパティごとに、サーバーに最後に届いた値が勝つ（同上） | 同じ。`map` のプロパティは要素ごと（ADR-0006） |
| ちらつき | 未確定の自分の変更と同じプロパティへのサーバーの変更を、確定まで捨てる（同上） | 同じ（7 節） |
| 並び | 0 と 1 の間の分数を任意精度の文字列で持つ。同じ位置への同時の挿入は、サーバーが後の方に一意の位置を振る。鍵の長さは実際の使い方では問題にならない（[Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/)、2017-03-06） | 同じ考え方。長さの上限と、まとめての振り直しを足す（ADR-0010） |
| 循環 | サーバーが拒否する。クライアントは、拒否されるまで循環したノードを木から外す（How Figma's multiplayer technology works） | 同じ |
| Undo | 「たくさん Undo して、コピーして、Redo で今に戻ったとき、文書は変わっていない」。Undo と Redo は、実行の時点で逆の履歴を書き換える（同上） | 同じ原則。他の人の上書きは戻さない（ADR-0012） |
| オフライン | 再接続では、新しい写しを取り、その上にオフラインの編集を当て直す（同上） | 同じ。長いオフラインは MVP で扱わない（ADR-0002） |
| 人数 | 1 ファイルに 500 人（編集と閲覧の合計）、編集は 200 人、カーソルの表示は 200 人まで。500 人に達すると、後から入った人は動かない版を見る。閲覧で 500 人に達していても、編集の権限のある人は 20 人まで入れる（[How many people can be in a file at once?](https://help.figma.com/hc/en-us/articles/1500006775761-How-many-people-can-be-in-a-file-at-once)） | 同じ上限にする（ADR-0011） |
| ファイルの外のデータ | コメントや利用者は、Postgres の上の別の仕組み（LiveGraph）で配る（[LiveGraph](https://www.figma.com/blog/livegraph-real-time-data-fetching-at-figma/)、2021-10-14） | 同じ分け方（Realtime。[architecture/README.md](README.md) の 1 節） |

いずれも 2026-09-27 に確認。本家の送受信の形式、在席の送り方、Gateway の構成は公開されていない（**未検証**）。

## 3. 構成

```
Client (WASM engine + UI)
   │ WebSocket (binary frames)
   ▼
Multiplayer Gateway ── 接続の終端、チケットの検証、権限の判定、Router への問い合わせ、ファイルごとの配信
   │ Gateway と Document Server の間は、タスクの組ごとに 1 本の多重化した接続（ファイルごとのストリーム）
   ▼
Document Server
   ├─ file actor（ファイルごとに 1 つの tokio のタスク）：検証 → seq → 適用 → ジャーナル → 確定 → 配信
   └─ presence task（ファイルごと）：在席とカーソルをまとめて配る
```

- **file actor** は、ファイルの `Doc`（[document-model.md](document-model.md) の 10 節）を 1 つのタスクだけが持つ。受け取り口は 1 つの待ち行列で、順に処理する。ロックは要らない。
- **配信は Gateway ごとに 1 回**：Document Server は、そのファイルに接続を持つ Gateway のタスクにだけ送る。Gateway が、自分の接続へ分けて送る。Document Server の送信の量は、接続の数ではなく Gateway の数に比例する（ADR-0011）。
- 在席は file actor を通らない。編集の処理を在席の量で遅らせない。

## 4. プロトコル

### 4.1 フレーム

- WebSocket のバイナリのフレーム。1 フレームに 1 メッセージ。符号化は [ADR-0008](../decisions/0008-canonical-binary-serialization.md) と同じ（`msg_type: u8` ＋本体）。
- 1 フレームの上限は 4 MiB＋64 KiB（`ChangeSet` の上限 4 MiB ＋見出し）。超えたら Gateway が接続を切る（`frame_too_large`）。
- WebSocket の圧縮（permessage-deflate）は使わない。変更は小さく、圧縮の CPU とメモリ（接続ごとの辞書）に見合わない。

### 4.2 メッセージ

クライアント → サーバー：

| メッセージ | 中身 |
| --- | --- |
| `Hello` | `file_id`、`auth`（次のどちらか。`Ticket`：API が判定関数を通した後に出す、60 秒の署名付きの能力のチケット。[permissions-and-sharing.md](permissions-and-sharing.md) の 5.4 節。`ResumeToken`：同じ持ち主への再接続で使う、Gateway の再開のトークン。同 5.5 節）、`protocol_version`、`schema_hash`、`engine_version`（ビルドの ID）、`resume: Option<{session_id, last_seq}>`、`current_page` |
| `Changes` | `client_seq: u32`、`ops: ChangeSet`（`origin` を含む。[document-model.md](document-model.md) の 7 節） |
| `LoadPage` | `page_id`（読み込んでいないページの変更がたまりすぎたとき。6.3 節） |
| `Presence` | `page_id`、`cursor: Option<(f32, f32)>`、`selection: Vec<NodeId>`（100 まで）、`viewport: Rect＋zoom`、`state`（`idle`・`editing_text`・`dragging`） |
| `Follow` | `target_session: Option<u32>`（視点を追う。`None` でやめる） |
| `Ping` | 時刻 |

サーバー → クライアント：

| メッセージ | 中身 |
| --- | --- |
| `Welcome` | `session_id`、`level`、`resumed: bool`、`last_client_seq`、`seq`、`load: LoadPlan`（[file-storage-and-history.md](file-storage-and-history.md) の 6 節）、`participants`、`features`（文書のフラグ。ADR-0055）、`batch_interval_ms`（まとめの間隔。ADR-0052） |
| `Ack` | `client_seq`、`seq`、`server_ops: Vec<Op>`（サーバーが書き換えた値、足した操作） |
| `Reject` | `client_seq`、`code`（6 節の表）、`detail`（ノードの ID だけ。中身を含めない） |
| `Committed` | `seq`、`session_id`、`client_seq`、`ops`、`server_ops`（他の人の確定した変更） |
| `PageData` | `page_id`、`chunk_refs`、`at_seq`（`LoadPage` への応答） |
| `PresenceBatch` | `entries: [{session_id, page_id, cursor, selection, viewport, state}]`（変わったものだけ） |
| `Participants` | 参加と退出（`session_id`、`user_id`、`level`、`color`） |
| `RoleChanged` | `level`（`view`・`edit`・`owner`）、`batch_interval_ms`（書き込みの予算の段が変わったときの指示。ADR-0052） |
| `ResumeToken` | `token`、`expires_at`（Gateway が `Welcome` の直後と 30 秒ごとに出す。60 秒・1 回だけ。permissions-and-sharing.md の 5.5 節） |
| `Kick` | `reason`（`owner_changed`・`forbidden`・`file_deleted`・`version_mismatch`・`overloaded`・`server_shutdown`・`resync_required`・`ticket_required`）、`retry_after_ms` |
| `Pong` | 時刻（`Ping` への応答。Gateway は、20 秒のあいだ何も送っていない接続にも送る。[infrastructure.md](infrastructure.md) の 4 節） |

- `Committed` は、Document Server が Gateway に 1 回だけ送る。Gateway は、送り手の接続には `Ack` に変えて送る（`ops` を省く）。
- 利用者の名前・アイコンは、メッセージに含めない。`user_id` から、UI の殻が API で取る（権限の判定を API に寄せる）。

### 4.3 接続の確立

```
Client          Gateway                    Router          Document Server
  │ Hello ───────▶│
  │               │ 能力のチケットを検証（署名、期限、jti の使い回し、file_id）→ level（view / edit / owner）、acl_version
  │               │ owner(file_id) ───────────▶│ なければ割り当て（ADR-0047）
  │               │ open_session(file, user, level, resume) ──────────────▶│
  │               │                                               │ resume が有効なら同じ session_id
  │               │                                               │ でなければ session_open をジャーナルに書く（ADR-0007）
  │◀──── Welcome ─│◀──────────────────────────────────────────────│
  │ LoadPlan に従って読み込む（file-storage-and-history.md の 6 節）
  │ Changes ─────▶ ...
```

- 版の照合は [ADR-0053](../decisions/0053-client-server-version-skew.md) による。Document Server は `protocol_version`（今の版と 1 つ前の版を話す）、`schema_hash`（今の表から追加だけでたどれる直近 30 日の一覧）、`engine_version`（`min_client_build` 以上）を確かめる。どれかが外れたときだけ `Kick(version_mismatch, retry_after_ms)`（0〜5 分に散らす）を返し、クライアントは強い再読み込みをする。`schema_hash` が違っても一覧の中なら、接続を続ける（[delivery.md](delivery.md) の 4 節）。
- `resume` は、同じ利用者の同じファイルのセッションで、セッションの表にあるときだけ受ける。他の利用者の `session_id` は受けない。
- 再接続では、最後に受けた再開のトークンが期限の内なら、チケットの代わりに使う（API を通さない）。Gateway は、署名・期限・`rid` の使い回し・`epoch` が今の割り当てと等しいこと・組織の `acl_version`・ログインのセッションの取り消しを確かめる。外れたら `Kick(ticket_required)` を返し、クライアントは API のチケットを取って、0〜1 秒の乱数だけ待ってつなぎ直す（permissions-and-sharing.md の 5.5 節）。
- チケットは URL に入れない（プロキシとアクセスログに残るため）。最初のメッセージで送る。

### 4.4 セッションの表

Document Server は、ファイルごとに次の表を持つ。チェックポイントに含め（[document-model.md](document-model.md) の 8.2 節）、ジャーナルから戻せる。

| 列 | 意味 |
| --- | --- |
| `session_id` | ADR-0007 |
| `user_id` | セッションを開いた利用者 |
| `last_client_seq` | 確定した最後の `client_seq`。再送の重複を除く |
| `opened_seq`・`last_active_at` | 表の掃除に使う |
| `verified_level` | その持ち主（`epoch`）の間に、API のチケットで確かめた最も高い水準。再開のトークンでの再接続の上限に使う（[permissions-and-sharing.md](permissions-and-sharing.md) の 5.5 節）。メモリにだけ持ち、チェックポイントとジャーナルに書かない |

- 30 日使われていないセッションは、チェックポイントの表から外す。`next_session_id` は戻さない。

### 4.5 変更と確定

1. クライアントは、利用者の操作ごとに `ChangeSet` を作り、自分の画面に当て（7 節）、`client_seq` を 1 つ進めて送る。
2. ドラッグなど続く操作は、20Hz（50ms）ごとに 1 つの `ChangeSet` にまとめる。同じ `(ノード, プロパティ)` は最後の値だけにする。
3. file actor は、`client_seq` を確かめる。
   - `≤ last_client_seq`：確定済みの再送。適用せず、`Ack { duplicate }` を返す。
   - `= last_client_seq + 1`：処理する。
   - それ以外：`Reject(out_of_order)`。クライアントは再接続する。
4. 検証する（6 節）。通れば `seq` を振り、メモリの `Doc` に当て、ジャーナルの書き込みの待ち行列に入れる。
5. ジャーナルに書けたら（group commit。[file-storage-and-history.md](file-storage-and-history.md) の 4 節）、その範囲の `ChangeSet` について、`Committed` を Gateway に送る。
6. 書けないまま持ち主でなくなったら（条件付きの書き込みの失敗）、メモリの状態を捨て、全員に `Kick(owner_changed)` を送る。未確定の変更は、クライアントが新しい持ち主へ送り直す（9 節）。

- `seq` は `ChangeSet` ごとに 1 つ振る。
- 確定の前の変更は、他の人に見せない（ADR-0003）。検証を通った後の `ChangeSet` は、メモリには当たっているが、`Committed` を送るまで外に出ない。

### 4.6 上限と流量

| 項目 | 上限 | 超えたら |
| --- | --- | --- |
| 1 つの `ChangeSet` | 4 MiB | クライアントが分ける。分けた各部分は別の Undo の項目にしない（10 節） |
| 1 セッションの送信 | 毎秒 60 `ChangeSet`・4 MiB | Gateway が読むのを遅らせ（背圧）、10 秒続けば `Kick(overloaded)` |
| 1 セッションの在席 | 毎秒 30 | 間引く |
| 未確定の `ChangeSet`（クライアント） | 1 万件か 32 MiB | 編集を止め、「接続を待っています」を出す |
| 1 ファイルの参加 | 500 人（編集 200 人）。編集の権限のある人は、閲覧で埋まっていても 20 人まで入れる | 12 節 |
| Gateway の 1 接続の送信の待ち | 8 MiB か 5 秒 | `Kick(resync_required)`。クライアントは読み込み直す |

## 5. 並びの鍵（分数インデックス）

ADR-0010。子の並びは、各ノードの `parent_index.key`（`OrderKey`）の辞書順だけで決める（本題材の AGENTS.md）。

### 5.1 形式

- ASCII の base-62（`0-9A-Za-z`）の文字列。バイトの比較がそのまま順序になる（Rust と TypeScript で同じ結果）。
- 先頭の 1 文字が整数部の長さを表し、残りが小数部（[fractional-indexing](https://github.com/rocicorp/fractional-indexing)。David Greenspan の「Implementing Fractional Indexing」に基づく。2026-09-27 に確認）。末尾は `0` にしない（どの 2 つの鍵の間にも、必ず鍵が作れる）。
- 長さは 64 バイトまで（[document-model.md](document-model.md) の T5）。

### 5.2 作り方

| 場面 | 鍵 |
| --- | --- |
| 1 つのノードを兄弟の間に入れる・動かす | `key_between(前, 後)`。決定的（乱数なし） |
| 複数のノードをまとめて入れる（貼り付け、複製、グループ化） | 乱数の接頭辞 `p = key_between_jittered(前, 後)`（小数部に 4 文字の乱数）を作り、`p` の後ろに `generate_n_keys` の鍵を付ける。2 人が同じ隙間へ同時に貼り付けても、まとまりが交ざらない |
| 末尾に足す | `key_between(最後, None)` |

- 分数インデックスでは、同時に同じ隙間へ入れた 2 つの列が、1 つずつ交ざることがある（[Interleaving anomalies in collaborative text editors](https://martin.kleppmann.com/papers/interleaving-papoc19.pdf)、Kleppmann ほか、2019、2026-09-27 に確認）。テキストと違い、レイヤーの並びでは 1 つのノードの挿入が多いので、まとめての挿入だけに乱数の接頭辞を付ける。

### 5.3 サーバーでの振り直し

- **重なり**：当てる `parent_index` の鍵が、同じ親の別の子の鍵と同じなら、サーバーはその値を `key_between(重なった鍵, 次の鍵)` に書き換えてから当てる。書き換えた値は、送り手には `Ack.server_ops`、他の人には `Committed` の `ops`（書き換えた後の値）で届く。
- **長さ**：当てた後の鍵が 48 バイトを超えたら、サーバーは同じ `seq` の中で、その親の子すべての鍵を `generate_n_keys(None, None, n)` で振り直し、`server_ops` に入れる。子が多い親（1 万以上）では `server_ops` が大きくなるが、まれとみなす。
- クライアントが作る鍵が 64 バイトを超えそうなとき（切断中に同じ隙間へ何度も入れた）は、クライアントがその親の子の鍵をまとめて振り直す変更を送る。
- 振り直しの `server_ops` は、`session_id = 0`（サーバー）の操作として記録する。

## 6. サーバーでの適用の規則

`doc-model` の同じ関数で、クライアントとサーバーが判定する（ADR-0001）。サーバーの判定が正である。

### 6.1 決定表

| 状況 | 結果 | 送り手への返事 |
| --- | --- | --- |
| 権限がない（水準 `view` の接続からの `Changes`） | `ChangeSet` 全体を拒否 | `Reject(forbidden)` |
| 型・範囲・種類の組み合わせの誤り | 全体を拒否 | `Reject(invalid_value / invalid_property / invalid_parent)` |
| `parent_index` で自分の子孫の下に入る（循環） | 全体を拒否 | `Reject(cycle)` |
| 深さが 256 を超える | 全体を拒否 | `Reject(depth_exceeded)` |
| 生きている ID と同じ `Create` | 全体を拒否 | `Reject(duplicate_id)` |
| `Create`・`parent_index` の親が消えている | 全体を拒否 | `Reject(parent_missing)` |
| `Set`・`MapSet` の対象のノードが消えている | その操作だけを捨てる | `Ack`（捨てた数を `dropped` に入れる） |
| `Delete` の対象が既に消えている | その操作だけを捨てる | `Ack` |
| 並びの鍵が重なる・長すぎる | 5.3 節で書き換える | `Ack.server_ops` |
| 子が 0 になった `GROUP`・`BOOLEAN_OPERATION` | 同じ `seq` の中でサーバーが消す（T8） | `server_ops` |
| ファイルの上限（ノードの数など） | 全体を拒否 | `Reject(file_too_large)` |

- 「全体を拒否」は、`ChangeSet` の原子性による（[document-model.md](document-model.md) の 7 節）。1 つの利用者の操作が半分だけ当たる状態を作らない。
- 「親が消えている」の拒否：A がフレーム F を消し、その後に B が X を F へ動かすと、B の変更は拒否され、X は元の場所に残る。順が逆（B の移動が先）なら、X は F と一緒に消える。どちらも全員の結果は同じ。

### 6.2 循環の判定

- `parent_index` を当てる前に、新しい親から根までをたどり、動かすノード自身が現れたら循環とする。たどる長さは深さの上限（256）までで止まる。
- 同時の 2 つの移動（A を B の下へ、B を A の下へ）は、後に届いた方が拒否される。

### 6.3 読み込んでいないページへの変更

- クライアントは、読み込んでいないページのノードへの `Committed` を、ノードの ID ごとに保留する。そのページのチャンクを読んだら、保留した変更を `seq` の順に当てる（チャンクは保留より前の `seq` の状態なので、結果は正しい）。
- 保留が 20 MiB を超えたら、`LoadPage` で今の `seq` のページを求める。Document Server はそのページを直列化して `PageData` を返す（[file-storage-and-history.md](file-storage-and-history.md) の 6 節）。

## 7. クライアントの状態と合わせ直し

### 7.1 持ち方

```
confirmed: Doc            // 確定した状態。Committed と Ack を seq の順に当てたもの
pending:   Vec<Pending>   // 送った／送る前の自分の ChangeSet（client_seq の順）
overlay:   Overlay        // pending を confirmed の上に重ねた差分。(ノード, プロパティ) → 値、作ったノード、消したノード
view = DocView { base: confirmed, overlay }   // 描画・レイアウト・ヒットテストが読む（document-model.md の 9.1 節）
```

- 自分の操作：`overlay` に当て、`pending` に積み、送る。
- 他の人の `Committed`：`confirmed` に当てる。`overlay` に同じ鍵があれば、画面は変わらない（自分の値が見え続ける。本家と同じ）。鍵がなければ画面が変わる。
- 自分の `Ack`：`pending` の先頭を `confirmed` に当て（`server_ops` を含む）、その鍵を `overlay` から外す（後の `pending` に同じ鍵があれば、その値を残す）。
- 自分の `Reject`：拒否された `ChangeSet` を `pending` から外し、それが触れた鍵について `overlay` を作り直す（残りの `pending` の最後の値、なければ外す）。拒否された `ChangeSet` に依存する後の `pending`（そのノードへの `Set` など）は、サーバーで捨てられるので、そのまま送る。拒否の理由を画面に短く出す。
- **他の人の `Delete`**：`overlay` の同じノードへの値があっても、ノードは画面から消える（サーバーは自分の `Set` を捨てるため）。
- **一時的な循環**：`overlay` の `parent_index` と `confirmed` の組み合わせで循環ができたら、その循環に入るノードを `DocView` の子の列から外す。自分の変更が拒否されるか、相手の変更が確定すれば解ける（ADR-0002）。

### 7.2 状態の遷移

```
          Hello              Welcome            読み込み完了
 Idle ─────────▶ Connecting ─────────▶ Loading ─────────────▶ Live ◀──────────┐
                    ▲  │ 失敗                                   │ │ 切断        │ Welcome（resume）
                    │  ▼                                         │ ▼             │
                    │ Backoff ◀──────────────────────────────── Disconnected ──┘
                    └───┘  最初は 0〜5s の一様な乱数、以後 1s, 2s, 4s … 30s（±20% の乱数）
 Live ── RoleChanged(view) ──▶ ReadOnly ── RoleChanged(edit) ──▶ Live
 どこからでも ── Kick(forbidden / file_deleted) ──▶ Closed
 どこからでも ── Kick(version_mismatch) ──▶ Reload（ページを読み込み直す）
 Connecting ── Kick(ticket_required) ──▶ API のチケットを取り、0〜1s の乱数の後に Connecting
```

- `Disconnected` の間も、編集はできる（4.6 節の上限まで）。画面に「オフライン」と未確定の件数を出す。
- 予期しない切断（`Kick` なし）の後の最初の再接続は、0〜5 秒の一様な乱数だけ待つ。Gateway のタスクの喪失で 1 万の接続が一度に戻るのを散らすため（[capacity.md](capacity.md) の 2.2 節）。`Kick` に `retry_after_ms` があれば、それに従う。
- 未確定があるままタブを閉じようとしたら、ブラウザの確認を出す（`beforeunload`）。未確定の変更を端末に保存することは、MVP でしない（16 節）。

## 8. 遅延の予算（NFR-001：p99 250ms、同じリージョン）

| 区間 | 予算（p99） |
| --- | --- |
| 操作 → 送信（20Hz のまとめ） | 50ms |
| クライアント → Gateway（東京） | 30ms |
| Gateway → Document Server、待ち行列と検証 | 10ms |
| group commit の待ち | 20ms |
| ジャーナルの書き込み（DynamoDB のトランザクション） | 40ms（**未検証**。E3 の前の `dynamodb-transaction-poc` で計測する） |
| Document Server → Gateway → 相手のクライアント | 40ms |
| 相手の適用と描画（1 フレーム） | 17ms |
| 余裕 | 43ms |

- DynamoDB は「1 桁 ms」の性能を掲げる（[What is Amazon DynamoDB?](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Introduction.html)、2026-09-27 に確認）。トランザクションの書き込みの p99 は資料にない（**未検証**。`dynamodb-transaction-poc` で計測する）。

## 9. 再接続と回復

| 場面 | クライアント | サーバー |
| --- | --- | --- |
| 接続だけが切れた（Gateway の入れ替え、ネットワーク） | `Hello { resume: {session_id, last_seq} }` | 同じ持ち主なら、`last_seq` より後の `Committed` を、メモリの直近の 1 万件（または 60 秒）から送る。範囲の外なら `LoadPlan` で読み込み直しを指示する |
| 持ち主が変わった（`Kick(owner_changed)`、Document Server の障害） | 同じく `resume` で再接続 | 新しい持ち主は、チェックポイントとジャーナルからセッションの表を戻しているので、`last_client_seq` を返せる。`last_seq` より後が手元にないときは読み込み直し |
| 読み込み直し | `confirmed` を捨て、新しく読み込み、`pending` のうち `last_client_seq` より後を `overlay` に当て直す | — |
| セッションの表から外れていた（30 日） | 新しい `session_id` で開く | — |

- どの場合も、クライアントは `Welcome.last_client_seq` 以下の `pending` を確定済みとして外し、残りを `client_seq` の順に送り直す。送り直しは、ジャーナルに記録した `(session_id, client_seq)` で重複を除く（4.5 節）。
- `pending` の変更は、値の置き換え（意図）で書かれているので、新しい状態にもそのまま当てられる。対象が消えていれば、サーバーが捨てる。
- Gateway と Document Server の間の接続が切れたら、Gateway はそのファイルの接続すべてに `Kick(owner_changed)` を送る（クライアントの再接続で Router から持ち主を引き直す）。
- 再接続の殺到を避けるため、`retry_after_ms`、最初の 0〜5 秒の乱数の待ち、クライアントの指数の待ち（±20% の乱数）を使う（7.2 節）。
- 持ち主が変わらない再接続（Gateway の入れ替え・喪失、ネットワーク）は、再開のトークンで API のチケットを取らずに入る。持ち主が変わった再接続（`Kick(owner_changed)`）は `epoch` が変わるので、API のチケットを取る（[capacity.md](capacity.md) の 2.2 節）。

## 10. Undo と Redo

ADR-0012。

- Undo の履歴は、クライアントごと・ファイルごとに持つ。他の人の変更は Undo しない。
- **項目の作り方**：自分の `ChangeSet` を当てる直前に、触れた鍵ごとの「前の値」（`view` の値）と「自分が書いた値」を記録する。記録するのは入力のプロパティだけで、`derived` のプロパティ（`derived_layout`）は記録しない。レイアウトの修復の `Set`（`origin = LayoutRepair`）は項目にしない（ADR-0012 の注記、[layout.md](layout.md) の 4.2 節）。ドラッグのように 20Hz で分けた `ChangeSet` は、操作の始まりから終わりまでを 1 つの項目にまとめる。4 MiB を超えて分けた `ChangeSet` も 1 つの項目にする。
- **Undo の実行**：項目の鍵ごとに、今の `view` の値が「自分が書いた値」と同じなら「前の値」に戻す新しい `ChangeSet` を作って送る。戻した入力から計算し直した `derived_layout` を同じ `ChangeSet` に入れる。違う（他の人が後から上書きした）鍵は戻さない。その時点の値で Redo の項目を作る（本家の「実行の時点で逆の履歴を書き換える」）。
- **ノードの削除の Undo**：消したときに記録したノードと子孫のプロパティで、同じ ID のまま作り直す（[document-model.md](document-model.md) の 6 節）。親が消えていたら、同じページの直下に、元の絶対位置で作る。
- **ノードの作成の Undo**：そのノードを消す。他の人がそのノードの下に子を足していたら、子ごと消える。消す前に子の数を数え、他の人の子があれば確認を出す。
- 本家の原則「たくさん Undo して、コピーして、Redo で今に戻ったとき、文書は変わっていない」を、1 人の編集で守る。
- Undo の `ChangeSet` がサーバーに拒否されたら（循環など）、その項目を捨て、理由を出す。
- 履歴は 200 項目までで、タブを閉じると消える。

## 11. 権限の変化

- Gateway と Document Server は判定関数を持たない。接続時は、API が判定関数を通して発行した能力のチケットの `level` を使う（[ADR-0030](../decisions/0030-single-policy-engine-and-signed-capabilities.md)）。権限の変更は `acl.changed { org_id, acl_version, file_ids? }` として Gateway に届き、Gateway は該当する接続を API の一括の判定で判定し直す（[ADR-0031](../decisions/0031-org-acl-version-and-connection-revalidation.md)）。セッションの取り消し（`session.revoked`）も同じ経路で切る（[ADR-0043](../decisions/0043-authentication-sessions-and-org-sso.md)）。
  - 読めなくなった：`Kick(forbidden)`。クライアントは画面を閉じ、`pending` を捨てる。
  - 編集できなくなった：Document Server のセッションの水準を変え、クライアントに `RoleChanged(view)`。以後の `Changes` は `Reject(forbidden)`。`pending` は捨て、件数を画面に出す。
- 取りこぼしに備えて、Gateway は 5 分ごとに接続中のすべてのセッションを判定し直す。目標は、権限を外してから接続が切れるまで p99 10 秒（[permissions-and-sharing.md](permissions-and-sharing.md) の 9 節）。
- ファイルをゴミ箱に入れたら、`Kick(file_deleted)`（[file-storage-and-history.md](file-storage-and-history.md) の 11 節）。

## 12. 在席・カーソル・人が集まるファイル

ADR-0011。

### 12.1 在席とカーソル

- 在席は一時的なデータ。ジャーナルにもチェックポイントにも書かない。
- クライアントは、変化があるときだけ `Presence` を送る（毎秒 30 まで）。
- Document Server の presence task は、ファイルごとに 50ms ごと（参加が 50 人を超えたら 100ms ごと）に、変わった項目だけを `PresenceBatch` にまとめて Gateway に送る。
- Gateway は、同じページを見ている接続にだけカーソルを送る。在席（顔のアイコン）はページを問わず送る。
- 表示するカーソルは 200 人まで（参加の早い順）。選択は 100 ノードまでを送り、それより多いときは数だけを送る。
- `session_id`・`user_id`・色は、サーバーが付ける。クライアントが他人になりすませない。
- 10 秒更新のないカーソルは、受け手が消す。

### 12.2 視点を追う

- `Follow { target_session }` を送ると、Document Server は追われている人の `viewport` を、変わるたびに（20Hz まで）追う人にだけ送る。
- 追う人の画面は、相手の `viewport` に合わせてパン・ズームし、ページも移る。自分でキャンバスを動かしたら追うのをやめる。
- 全員に自分を追わせる機能（本家の Spotlight に当たる）は、`Presence.state = presenting` を送り、受け手に確認を出す形にする。

### 12.3 人が集まるファイル

- 参加（編集と閲覧の合計）は 500 人、編集は 200 人まで。本家と同じ（2 節）。
- 500 人を超えて入った人は、**動かない版**を見る。最新のチェックポイントを読み込み、`Committed` と在席を受けない。「最新にする」ボタンで読み込み直す。閲覧で 500 人に達していても、編集の権限のある人は 20 人まで、通常の参加として入れる。
- 1 ファイルの処理の見積もり（S1）：編集者 200 人がそれぞれ 20Hz で送ると毎秒 4,000 `ChangeSet`。1 件の検証と適用を 10µs とすると、file actor の CPU は 1 秒あたり 40ms。ジャーナルは group commit の中で同じ鍵をまとめるので（[file-storage-and-history.md](file-storage-and-history.md) の 4.3 節）、書き込みの量は変わった鍵の数で決まる。
- DynamoDB の 1 パーティションは、書き込みを毎秒 1,000 単位（1 単位は 1 KB）まで出す設計である（[Best practices for designing and using partition keys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)）。トランザクションの書き込みは 2 倍の単位を使う（[Constraints in Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)）。いずれも 2026-09-27 に確認。1 ファイルのジャーナルは 1 つのパーティションキーで、ソートキー（`seq`）は増える一方なので、書き込みは末尾の 1 つのパーティションに集まる。DynamoDB は頻繁に使われる項目を分けて置き直すが、ソートキーが単調に増える項目の集まりは、ソートキーで分けない（[DynamoDB burst and adaptive capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html)、2026-09-27 に確認）。1 ファイルの書き込みは予算（毎秒 400 単位）で数え、使った割合が 50%・80% を超えたら、クライアントのまとめの間隔を 100ms・200ms に広げ、100% では確定を遅らせる（Document Server が `Welcome` と `RoleChanged` の `batch_interval_ms` で指示する。[ADR-0052](../decisions/0052-journal-throughput-and-hot-file-budget.md)、[capacity.md](capacity.md) の 4.2 節）。
- 在席の送信の量：参加 500 人、100ms ごと、1 項目 40 バイトで、1 回の `PresenceBatch` は最大約 8 KB。Gateway が 10 台なら、Document Server の送信は毎秒約 800 KB。Gateway の側は、1 接続あたり毎秒 80 KB になる。
- 配信の層を Document Server の外に分ける案（閲覧だけの接続を別のノードから配る）は、Gateway ごとに 1 回の配信で足りる間は採らない。S2 で 1 ファイル 500 人を超える需要があれば、Gateway の間の木構造の配信を ADR にする。

## 13. 障害のときの振る舞い

| 障害 | 起きること | 回復 |
| --- | --- | --- |
| クライアントの接続が切れた | 未確定が残る | 9 節の `resume`。重複は `client_seq` で除く |
| Gateway のタスクが落ちた | そのタスクの接続がすべて切れる | クライアントが別の Gateway に再接続する（ALB）。再接続の殺到は乱数の待ちで散らす |
| Document Server が落ちた | 確定していない `ChangeSet` は失われる（確定済みはジャーナルにある） | 持ち主の生存の期限（10 秒＋猶予 2 秒）の後に別の持ち主が回復し（NFR-007、ADR-0047）、クライアントが送り直す |
| 二重の持ち主 | 片方のジャーナルの書き込みが失敗する | 失敗した方は `Kick(owner_changed)` を送り、状態を捨てる（[file-storage-and-history.md](file-storage-and-history.md) の 4.4 節） |
| ジャーナルが遅い・スロットリング | 確定が遅れる。`pending` が伸びる | 再試行。10 秒書けなければ、ファイルを手放す（同上） |
| 1 つの接続が遅い（送信の待ちが伸びる） | Gateway のメモリが伸びる | 8 MiB か 5 秒で `Kick(resync_required)` |
| クライアントのバグで不正な変更を送り続ける | 拒否が続く | 1 分に 100 回の拒否で `Kick`。拒否の理由をエラーの報告に送る（中身を含めない） |
| WASM とサーバーの `doc-model` の版が違う | 結果が食い違う | ADR-0053 の 3 つの版の照合で、互換の外だけ `Kick(version_mismatch)`。結果を変える規則は文書のフラグ（`Welcome.features`）で全員そろえる |

## 14. セキュリティ

- すべての変更をサーバーで検証する。クライアントの検証は、画面のためだけにある。
- `Create` の ID の `session_id` は、自分のセッションか、既に振られた `session_id`（Undo による作り直し）に限る。まだ振られていない `session_id` の ID は拒否する。別の人の今後の ID を先に使う嫌がらせは、同じファイルの編集者にしかできない（その人は元から全体を消せる）ので、受け入れるリスクとする。
- WebSocket の `Origin` を確かめる。能力のチケットは 60 秒で、1 回だけ使える（`jti` を Valkey に置く。[permissions-and-sharing.md](permissions-and-sharing.md) の 5.4 節）。Document Server もチケットの署名と `file_id`・`level` を確かめる（ADR-0043）。
- 在席の `selection` と `viewport` から、閲覧だけの人にも他の人の作業の場所が見える。これは本家と同じ振る舞いとして受け入れる。
- ログ・トレース・メトリクスには、`file_id`・`session_id`・`seq`・大きさ・理由のコードだけを書く。ノードの名前・テキスト・値を書かない。
- 1 セッションの流量の上限（4.6 節）で、1 人がファイルの処理を占有することを防ぐ。

## 15. テスト

### 15.1 性質ベーステスト（シミュレーター）

サーバーとクライアント N 個を 1 つのプロセスで動かし、メッセージの遅延・並べ替え（接続の中の順序は保つ）・切断・再送・持ち主の交代を乱数で起こす（`doc-model` の同じコード）。

- **PROP-MP-001（収束）**：任意のクライアントの数・操作・遅延・切断の列で、操作が止まり全員が追いついた後、全クライアントの `confirmed` と `view` がサーバーの状態と一致する（正準形のバイト列）。
- **PROP-MP-002（木の不変条件）**：任意の `parent_index` の変更の列で、サーバーの木が T1〜T9 を満たす。クライアントの `view` は、一時的な循環のノードを外した状態で T3 を満たす。
- **PROP-MP-003（鍵）**：任意の挿入・移動の列で、兄弟の鍵が一意で、64 バイト以下。
- **PROP-MP-004（確定の順序）**：任意の障害の列で、`Ack` を受けた `ChangeSet` はすべて、最後のサーバーの状態の履歴に含まれる（ジャーナルへの書き込みの前に `Ack` しない）。
- **PROP-MP-005（重複なし）**：任意の再送の列で、同じ `(session_id, client_seq)` は 1 回だけ当たる。
- **PROP-MP-006（Undo）**：1 人の編集で、任意の操作の後に k 回 Undo、コピー、k 回 Redo すると、状態が元と一致する。
- **PROP-MP-007（Undo は他人を戻さない）**：A の変更の後に B が同じ鍵を上書きし、A が Undo しても、その鍵は B の値のまま。
- **PROP-MP-008（まとめての挿入）**：2 人が同じ隙間へ同時に n 個ずつ貼り付けても、それぞれのまとまりが連続する（乱数の接頭辞が異なる限り）。

### 15.2 決定表

- 6.1 節の各行を、クライアントの検証とサーバーの検証の両方で表駆動テストにする。
- 7.1 節の `Committed`・`Ack`・`Reject` と `overlay` の組み合わせ。

### 15.3 結合・障害注入

- 閲覧だけの接続からの `Changes` が拒否される。
- 共有を外された接続が、`acl.changed` から 10 秒以内に切られる。
- Document Server の強制終了、Gateway の強制終了、Gateway と Document Server の間の分断、DynamoDB の遅延と失敗を注入し、PROP-MP-001・004 を確かめる（[file-storage-and-history.md](file-storage-and-history.md) の 14 節と共通の枠）。
- 負荷：1 ファイルに 500 接続（編集 200）で、NFR-001 の p99 と、Document Server の CPU・送信の量を計測する（E12。[capacity.md](capacity.md) の L2）。

## 16. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり。

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `mp-protocol-codec` | 4.2 節のメッセージの型と符号化（表から生成） |
| E3 | `gateway-connect` | 能力のチケットの検証、`Hello`、Router への問い合わせ、Document Server との多重化した接続 |
| E3 | `file-actor-commit` | `client_seq` の確認、検証、`seq`、group commit との結合、`Ack`・`Committed`・`Reject` |
| E3 | `client-overlay-rebase` | `confirmed`・`pending`・`overlay`、7.1 節の規則、一時的な循環 |
| E3 | `ordering-keys` | 5 節の鍵、サーバーの振り直し、乱数の接頭辞 |
| E3 | `reconnect-resume` | 9 節、背圧と `Kick`、最初の 0〜5 秒の乱数の待ち |
| E3 | `gateway-resume-token` | 再開のトークンの発行と検証（permissions-and-sharing.md の 5.5 節） |
| E3 | `change-origin-tag` | `ChangeSet` の `origin` とジャーナルへの記録（plugins・layout と合わせる） |
| E3 | `presence-cursors` | 12.1 節、ページごとの絞り込み |
| E3 | `follow-viewport` | 12.2 節 |
| E3 | `multiplayer-undo` | 10 節 |
| E3 | `mp-simulator-props` | 15.1 節のシミュレーターと PROP-MP-001〜008 |
| E9 | `acl-change-kick` | 11 節（`acl.changed` の受け取りと判定し直し） |
| E12 | `hot-file-load-test` | 500 接続の負荷試験と、まとめの間隔の自動の調整 |

## 17. 未解決の問い

### 決定（2026-09-27、既定案）

- **まとめの間隔**：20Hz（50ms）。ジャーナルの書き込みの多いファイルは 100ms（12.3 節）。
- **1 ファイルの人数**：本家と同じ 500 人・編集 200 人・カーソル 200 人・編集の権限の枠 20 人。
- **超えた人の扱い**：動かない版（12.3 節）。
- **Undo の範囲**：他の人の上書きは戻さない。履歴は 200 項目、タブを閉じたら消える。
- **未確定の変更の端末への保存**：MVP ではしない。タブを閉じる前に確認を出す。
- **再接続の最初の待ち**：予期しない切断では 0〜5 秒の一様な乱数（capacity.md の提案を取り込んだ）。
- **版の照合**：`schema_hash` の一致ではなく、ADR-0053 の 3 つの版で照合する（delivery.md の提案を取り込んだ）。
- **WebSocket の圧縮**：使わない。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| DynamoDB のトランザクションの書き込みの p99 が 40ms に収まるか | E3 の前の `dynamodb-transaction-poc`（東京、オンデマンド） |
| 未確定の変更を IndexedDB に保存し、タブを閉じても送れるようにするか | 試用のチームの声（SC-2）と、切断の頻度の計測で決める |
| テキストの同時の入力の損失が問題になるか（ADR-0002 の 4 案への切り替え） | 試用の期間の報告で決める |
| 1 ファイル 500 人を超える需要（全社の発表）への対応 | S2 の前。Gateway の間の配信の木を ADR にする |
| Undo の履歴をタブをまたいで残すか | 利用者の声で決める |
| 本家の送受信の形式と在席の送り方 | 公開されていない。調べない |

## 18. quality.md・runbooks・data-model への項目

### quality.md

- 反映の遅延（入力 → 他の人の画面）の p50・p99 を、8 節の区間ごとに計る。クライアントが `Committed` の受信の時刻と、送り手の操作の時刻（`client_seq` に付けた時刻）の差を、同じファイルの試験用のボットで計る。
- 確定の時間（`Changes` の受信 → `Ack` の送信）の p99 と、うちジャーナルの書き込みの時間。
- 拒否の率（理由のコードごと）。`cycle`・`parent_missing` の率は競合の多さの目安。
- 再接続の成功率と、読み込み直しになった割合。
- 収束のシミュレーターの実行の数と種（CI は PR ごとに 1 万の列、夜間に 100 万）。
- 1 ファイルの参加の数の分布と、上限に達した回数。

### runbooks

- `document-server-hot-file.md`：1 ファイルに CPU・ジャーナルの書き込みが集中したときの確かめ方（参加の数、変更の率、DynamoDB のスロットリング）と、まとめの間隔の変更、ファイルを大きいタスクへ移す手順。
- `multiplayer-reconnect-storm.md`：Gateway・Document Server の入れ替えで再接続が集中したときの確かめ方と、`retry_after_ms` の引き上げ。
- `acl-revocation-lag.md`：権限を外したのに接続が残るときの確かめ方（Realtime の経路の遅れ、Gateway の判定し直し）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| チェックポイントの `sessions_chunk` | 4.4 節のセッションの表 |
| ジャーナルの項目の中の `session_open` と `(session_id, client_seq)` | [file-storage-and-history.md](file-storage-and-history.md) の 4.2 節 |
| Valkey の使ったチケットの `jti` | [permissions-and-sharing.md](permissions-and-sharing.md) の 5.4 節（この領域では持たない） |

# Search: Linear

イシュー・コメント・プロジェクトの全文検索を決める。日本語の部分一致、検索の基盤の選択、索引の更新と遅れ、同期グループでの権限の絞り込み、手元の検索とサーバーの検索の組み合わせを扱う。

前提となる決定は、テナントと非公開のチーム（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）、差分の形と `groups_before`（[ADR-0007](../decisions/0007-sync-actions-and-range-proof-deltas.md)）、同期グループの参加・脱退（[ADR-0013](../decisions/0013-sync-group-changes-retention-and-reset.md)）、メモリーの 3 層（[ADR-0016](../decisions/0016-memory-tiers-quota-and-offline-ux.md)）、コマンドメニューの照合（[ADR-0017](../decisions/0017-keymap-command-menu-and-ime.md)）、本文の CRDT と `text_plain`（[ADR-0021](../decisions/0021-description-crdt-yjs-in-sync-log.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0030](../decisions/0030-search-engine-opensearch.md) | 検索は S1 から Amazon OpenSearch Service で行う。文書はモデルの行ごと（イシュー、コメント、プロジェクト）。一致の判定は 1〜2 文字の N-gram、関連度は同梱の kuromoji。正規化はアプリの共有の関数で行う。文書のバージョンは行の `sync_id` で、外部のバージョン（`version_type: external`）で古い書き込みを捨てる。Aurora PostgreSQL 18 の `pg_bigm` は使えることを確かめたが、Writer のクラスタに大きな GIN の索引を足すこと、RLS の下で索引が効かないこと、関連度の並べ替えが弱いことから、代案として残す |
| [0031](../decisions/0031-search-permission-by-sync-groups.md) | 権限は同期グループで効かせる。文書に行の `sync_groups` を入れ、検索した人の購読（`groupsFor`）を `terms` の条件にする。結果は Aurora で今の `sync_groups` と削除を読み直して、合わないものを落とす。抜粋は、索引のバージョンが行のバージョンと同じときだけ返す。画面は手元の検索（M2 のタイトルと識別子）をすぐに出し、サーバーの結果を後から足す |

## 1. 目的と範囲

- 扱う：
  - 検索の対象（イシューのタイトル・本文、コメント、プロジェクトの名前・説明）
  - 検索の基盤の選択（OpenSearch か `pg_bigm` か）
  - 文書の形、日本語の解析、正規化
  - 権限の絞り込み（同期グループ）、読み直し、抜粋
  - 索引の更新（Relay → SQS → 索引の Worker）、遅れ、数え直し、作り直し
  - 手元の検索とサーバーの検索の組み合わせ、識別子（`ENG-123`）での検索
- 扱わない：
  - ビューの中の「タイトルに含む」の条件（[views-and-filters.md](views-and-filters.md) の 4.2 節）
  - コマンドメニューの照合の予算と並べ方（[client-app.md](client-app.md) の 6 節）。ここでは、サーバーの結果の足し方だけを決める
  - 公開 API の検索の形（[api-and-webhooks.md](api-and-webhooks.md)。同じ検索の関数を使う）
  - 意味の検索（埋め込み）、AI の機能（MVP の後。[intent.md](../intent.md)）
  - 添付ファイルの中身の検索（MVP では行わない。ファイル名だけを本文に入れる）

## 2. 本家の形（確かめたこと）

いずれも 2026-09-28 に確認。

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 対象 | ワークスペースのイシュー・プロジェクト・ドキュメント。イシューの ID、タイトル・説明・コメントの語で探す。ビューの中の検索（一覧・ボード・インボックス）はイシューのタイトルだけ | [Search](https://linear.app/docs/search) |
| 識別子 | `LIN-123` か、`lin123` の略記で探せる | 同上 |
| 並び | 関連度の見込みで並べる。未着手と進行中を先に、次に Backlog、完了、取り消し、アーカイブの順 | 同上 |
| 絞り込み | チーム・人・状態などを `@` で書くと絞り込みになる | 同上 |
| 上限 | 結果は最大 500 件。英語のよくある語（stop words）は、引用符で囲まない限り除く | 同上 |

- 本家の検索の基盤（エンジン）、日本語の解析、索引の遅れは、公開の資料で確かめられなかった（**未検証**）。

使う部品の事実（2026-09-28 に確認）：

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| `pg_bigm` | Aurora PostgreSQL 18（18.3・18.4）でバージョン `1.2_20250903` が使える。17・16 でも使える。`pgroonga` は一覧にない | [Extension versions for Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html) |
| RLS と関数 | 行の方針の条件は、利用者の問い合わせの条件より先に評価する。LEAKPROOF の印のある関数・演算子だけが、方針より先に評価されうる | [CREATE POLICY](https://www.postgresql.org/docs/18/sql-createpolicy.html) |
| kuromoji | Amazon OpenSearch Service の全ドメインに同梱 | [Plugins by engine version](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html) |
| Sudachi | 任意のプラグイン（日本語に推奨と書かれている）。パッケージはバージョンごとに結び付け、辞書の差し替えはすぐには反映されない | 同上 |
| 外部のバージョン | `version_type=external` は、指定のバージョンが保存のバージョンより大きいときだけ書く | [Index document](https://docs.opensearch.org/latest/api-reference/document-apis/index-document/) |

## 3. 基盤の選択

ADR-0030。

| 観点 | `pg_bigm`（Aurora） | OpenSearch（kuromoji・N-gram） |
| --- | --- | --- |
| 日本語の部分一致の取りこぼし | なし（2 文字の N-gram。1 文字は全走査） | なし（1〜2 文字の N-gram の句の一致） |
| 関連度の並べ替え | `bigm_similarity` の類似度だけ。語の重み、フィールドの重みを組みにくい | BM25、フィールドの重み、状態による重みを組める |
| RLS | `LIKE` は LEAKPROOF でないので、RLS のある表では GIN の索引が効かない。Slack の題材と同じく、RLS を外した専用の表と `SECURITY DEFINER` の関数が要る（Slack の ADR-0027） | RLS の外。テナントの条件を検索の関数で必ず付ける |
| 書き込みの負荷 | Writer と同じクラスタに GIN の索引の更新が増える（索引を同じクラスタに置く場合）。`sync_id` を振るロックの書き込みの上限（ADR-0002）と同じ資源を使う | 別の基盤。Aurora の負荷を増やさない |
| 規模 | S1 のイシュー・コメントの合計を数億行と見込む。1 つの Aurora の GIN の索引は重い | 索引をシャードに分ける。S2 で大口のワークスペースを専用の索引へ |
| 運用 | 追加の部品なし | ドメインの運用、バージョンの更新、費用 |
| S2 への移行 | 必要（README の技術スタックの計画では S2 で専用の基盤） | 不要 |

- 採用：**S1 から OpenSearch**。関連度の並べ替え（本家の並び）と、Writer のクラスタへの負荷を避けることを重く見る。
- `pg_bigm` は代案として残す。検索の基盤が落ちたときの非常の経路（10 節）ではなく、「OpenSearch の費用が S1 の規模に見合わない」と E8 の PoC で分かったときの代案である。そのときは Slack の ADR-0027 と同じ形（専用のスキーマと関数）にし、別の Aurora のクラスタに置く ADR を書く。
- [architecture/README.md](README.md) の 4 節の当初の「S1 は PostgreSQL の全文検索、S2 で専用の基盤」とは違う決定である。README は統合の工程（2026-09-28）で揃えた。

## 4. 文書

### 4.1 索引

- 1 つの索引 `docs_v<n>`（別名 `docs`）に、モデルを問わず文書を入れる。モデルをまたいで 1 回の検索で並べるため。
- ルーティングは `workspace_id`。S1 はシャード 12、レプリカ 1（E8 で測って決める）。S2 で、イシューが 100 万件を超えるワークスペースを専用の索引（別名で切り替え）へ移す。
- 文書の ID は `<model>:<id>`。

### 4.2 フィールド

| フィールド | 型 | 中身 |
| --- | --- | --- |
| `workspace_id` | keyword | — |
| `m` | keyword | `Issue`・`Comment`・`Project` |
| `id` | keyword | 行の ID |
| `groups` | keyword（配列） | 行の `sync_groups`（6 節） |
| `team_id` | keyword | イシューのチーム（コメントはイシューのチーム） |
| `issue_id` | keyword | コメントの親のイシュー |
| `identifier` | keyword（配列） | `ENG-123` と、別名（移動の前の識別子）。大文字に正規化 |
| `state_type` | keyword | イシューの状態の種類（並びの重みに使う） |
| `archived`・`trashed`・`deleted` | boolean | 既定の検索では `archived` を含め、`trashed`・`deleted` を除く |
| `updated_at` | date | — |
| `title` | text | タイトル（プロジェクトは名前）。`normalizeForSearch` の後 |
| `body` | text | イシューの本文（`doc_states.text_plain`）、コメントの本文の文字、プロジェクトの説明。先頭 256 KiB まで |
| `v` | long | 文書のバージョン（4.3 節） |

- `title` と `body` は多重のフィールドにする：`.gram`（1〜2 文字の N-gram。一致の判定）、既定（kuromoji。関連度）。
- 添付のファイル名は `body` の末尾に足す。
- 担当・ラベルなどのフィールドは入れない。絞り込みは検索の後に手元のモデルで行う（7.2 節）か、`team_id`・`state_type` の条件だけにする。

### 4.3 バージョン

- 文書のバージョン `v` は、索引の Worker が文書を作るときに読んだ行の `updated_sync_id` の最大（イシューなら、イシューの行、本文の `compacted_through`、別名の行のうち最大）。どれもワークスペースの `sync_id` なので、同じ文書のバージョンは単調に増える。
- 書き込みは `version_type=external`。古いバージョンの書き込みは衝突で捨てられる。索引の Worker が並列に動いても、新しいバージョンが残る。
- 削除：行がない・削除済みなら、`deleted: true` の墓標の文書を、削除の `sync_id` をバージョンにして書く。本物の削除は数え直しのジョブ（9.4 節）が 1 日後に行う。OpenSearch の削除の記録（`index.gc_deletes`、既定 60 秒）より遅れて届いた古い書き込みが、文書を生き返らせないようにするため。

## 5. 日本語の解析

### 5.1 正規化

- 正規化は、アナライザーではなく、共有のパッケージの `normalizeForSearch`（NFKC → 英字の小文字化 → カタカナをひらがなに寄せる → 連続する空白を 1 つ）で行う。索引とクエリの両方にかける。
- クライアントのコマンドメニュー（[client-app.md](client-app.md) の 6 節）とビューの `title contains`（[views-and-filters.md](views-and-filters.md) の 4.2 節）も同じ関数を使う。手元の検索とサーバーの検索で、同じ語が同じものに当たる。
- ひらがなとカタカナを同じにするのは、コマンドメニューの照合と合わせるため。Notion・Slack の題材は同一視しないと決めているが、この題材はキーボードの即時の照合を優先する。

### 5.2 アナライザー

| フィールド | トークナイザー | 役割 |
| --- | --- | --- |
| `title.gram`・`body.gram` | N-gram（1〜2 文字） | 一致の判定。語ごとに `match_phrase` で連続を要求する |
| `title`・`body` | kuromoji（`search` モード） | 関連度。`should` にだけ使う |

- 1 文字の語（「件」）でも取りこぼさないよう 1 文字の N-gram を入れる。索引の大きさの増え方は**未検証**で、E8 の前の `search-poc` で測る。
- Sudachi は、AWS が日本語に推奨している。辞書の管理とバージョンごとのパッケージの結び付けの運用が要るので、S1 は同梱の kuromoji で始め、関連度の不満が出たら Sudachi に替える（索引の作り直しで切り替える）。
- 英語の語幹の処理と stop words の除去はしない（本家は英語の stop words を除く）。日本語の文の中の英字の語を取りこぼさないため。

## 6. 権限

ADR-0031。

### 6.1 文書のグループ

- 文書の `groups` は、行の `sync_groups` と同じ（[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節の規則で Writer が決めた値）。
  - イシュー：`team:<team_id>`。
  - コメント：`via` でイシューのグループ。
  - プロジェクト：`ProjectTeam` のチームのグループの和（[cycles-and-projects.md](cycles-and-projects.md) の 3.3 節）。
- 権限の判定を別の形（Notion の題材の権限キー）で持たない。同期グループの判定と検索の判定が、同じ値になる。

### 6.2 問い合わせ

- 問い合わせは 1 つの関数 `buildSearchRequest` だけで作る。OpenSearch のクライアントを他の場所から使うことを lint で禁止する。

```json
{ "routing": "<workspace_id>",
  "query": { "bool": {
    "filter": [
      { "term":  { "workspace_id": "<workspace_id>" } },
      { "terms": { "groups": ["workspace", "team:…", "team:…"] } },
      { "term":  { "trashed": false } },
      { "term":  { "deleted": false } } ],
    "must":   [ { "multi_match": { "query": "<正規化した語>", "type": "phrase", "fields": ["title.gram^3", "body.gram"] } } ],
    "should": [ { "match": { "title": { "query": "<語>", "boost": 3 } } },
                { "match": { "body": "<語>" } },
                { "terms": { "state_type": ["unstarted", "started"], "boost": 2 } },
                { "term":  { "archived": { "value": false, "boost": 1.5 } } } ] } },
  "size": 50 }
```

- `groups` の値は、呼んだ人の今の購読（`groupsFor(principal)`。[permissions-and-teams.md](permissions-and-teams.md) の 5 節）。検索のたびに `sync_subscriptions` から読む（1 回の索引の読み出し）。キャッシュしない。脱退・非公開への切り替えが次の検索から効く。
- 1 人の購読のグループの数は、チームの数（数百まで）。`terms` の上限（65,536）に届かない。
- 語は空白で分け、語ごとに `must` の句の一致にする（AND）。
- 並びは本家に寄せる：関連度に、状態（未着手・進行中を上げる）とアーカイブ（下げる）の重みを足す。

### 6.3 読み直し

1. OpenSearch から `(m, id, v, score)` を最大 60 件得る（1 ページ 50 件に、落ちる分の余裕）。
2. Aurora の reader で、RLS の下で、行の `sync_groups`・`updated_sync_id`（本文は `compacted_through`）・削除とゴミ箱を読む。
3. 今の `sync_groups` が呼んだ人の購読と交わらない行、削除・ゴミ箱の行を落とす。落ちた数を `search_hydration_drop` として数える。
4. 抜粋（ハイライトの前後 80 字）は、文書の `v` が今の行のバージョンと同じときだけ返す。違えば抜粋なしで、ID だけを返す。
5. 50 件に切って返す。合計の件数は返さない。結果は最大 500 件（本家と同じ）、10 ページまで。

- 読み直しの理由：索引の遅れ（9 節）の間、文書の `groups` は古い。イシューが公開のチームから非公開のチームへ移った直後に、前のチームの人の検索に出うる。Aurora の今の値で落とせば、遅れの間も漏れない。
- 抜粋をバージョンで絞る理由：タイトルを書き換えて秘密を消した直後に、古い文書の抜粋が出ないようにするため。

### 6.4 権限の変化の反映

| 契機 | 文書の変更 | 検索に効くまで |
| --- | --- | --- |
| メンバーの参加・脱退、非公開への切り替え、ロールの変更 | なし（`groups` はチームの ID。変わるのは呼んだ人の購読） | 次の検索から（即時） |
| イシューのチームの移動 | イシュー・コメントの文書の `groups` を書き直す（`groups_before` 付きの `update` の差分を索引の Worker が受ける） | p95 10 秒。その間は読み直しで守る |
| プロジェクトのチームの変更 | プロジェクトの文書の `groups` | 同上 |
| ワークスペースからの除外 | なし | 次の検索から（チケット・セッションの確認で拒否） |

## 7. 検索の API と画面

### 7.1 API

```
POST /search
{ "workspace": "…", "q": "ログイン 失敗", "models": ["Issue","Comment","Project"],
  "team": null, "include_archived": true, "cursor": null }
→ 200
{ "results": [ {"m":"Issue","id":"…","score":12.3,"snippet":{"f":"body","text":"…","hl":[[10,14]]}},
               {"m":"Comment","id":"…","issue_id":"…","snippet":null} ],
  "cursor": "…" }
```

- 返すのは ID と抜粋だけ。タイトル・状態・担当は、クライアントが手元のモデルで描く。手元になければ `Issue:id=…` の遅延の読み込み（同期グループで絞る）で得る。
- 語が識別子の形（`^[A-Za-z][A-Za-z0-9]{0,6}-?\d+$`）なら、全文の検索の前に `GET /sync/resolve`（[data-model-and-schema.md](data-model-and-schema.md) の 5.4 節）で引き、当たればそれを最初に置く。`eng123` の略記も同じ形で受ける（本家と同じ）。
- 上限：1 人 1 秒に 5 回、ワークスペースで 1 秒に 100 回。語は 200 字まで、語の数は 10 まで。

### 7.2 絞り込み

- 本家の `@` の絞り込み（チーム・人・状態）は、クライアントがフィルターの木（[views-and-filters.md](views-and-filters.md) の 3 節）に直し、検索の結果の ID を手元のモデルで評価して絞る。サーバーには `team` と `state_type` だけを渡す（文書のフィールドにあるもの）。
- 絞ると 1 ページの件数が減る。画面は「さらに読み込む」を出す。

## 8. 手元の検索とサーバーの検索の組み合わせ

ADR-0031。

```
 入力（1 打ごと）
   │ (1) 手元：識別子の前方一致 → M2 の title_norm の部分一致（client-app の 6 節と同じ照合）
   ▼        すぐに描く（NFR-001）
 150ms 入力が止まったら
   │ (2) サーバー：POST /search（前の要求は取り消す）
   ▼
 (3) 組み合わせて描き直す
```

- 並び：
  1. 識別子の完全一致
  2. 手元のタイトルの一致（手元の並び：完全一致 → 前方一致 → 部分一致）
  3. サーバーの結果のうち、手元の一致にないもの（サーバーの順）
- 同じイシューが手元とサーバーの両方にあれば、手元の位置に置き、サーバーの抜粋（本文・コメントでの一致）を添える。
- サーバーの結果が来ても、既に描いた手元の結果の位置は動かさない（選びかけた行が動かないように）。サーバーの結果は下に足す。
- オフライン：手元の結果だけを描き、「オフラインのため、本文とコメントは検索していません」と示す。
- 手元の本文の検索はしない。本文は M3（IndexedDB）で、走査が予算に収まらないため。
- 手元の結果に、見てよくないものは入らない（手元には見てよいものしかない。ADR-0004）。脱退で手元の行を消すとき、検索の手元の結果の保存（最近の検索の結果）も消す（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 7.4 節）。

## 9. 索引の更新と遅れ

### 9.1 流れ

```
 Writer（sync_actions）─▶ Relay ─▶ SQS（search-index、FIFO でない）─▶ 索引の Worker
                                                                   │ 行を Aurora の reader から読み直す
                                                                   │ （min_sync_id まで待つ。2 秒で writer）
                                                                   ▼
                                                             OpenSearch（bulk、external のバージョン）
```

- Relay は、`search` の印のあるフィールド（[data-model-and-schema.md](data-model-and-schema.md) の 3.2 節）か `sync_groups` が変わった変更、作成・削除・アーカイブ・移動だけを `search-index` に流す。本文は、まとめの Worker が `text_plain` を書いた時に流す。
- 索引の Worker は差分の中身を使わず、行を読み直して文書を作る（4.3 節のバージョンを付ける）。差分の到着の順にかかわらず、新しい状態が残る。
- 1 秒か 500 件で bulk にまとめる。

### 9.2 遅れの目標（NFR-010）

| 区間 | 予算（p95） |
| --- | --- |
| 確定 → Relay → SQS | 1 秒 |
| SQS → 索引の Worker の読み直し | 2 秒 |
| bulk → 検索できる（`refresh_interval` 1 秒） | 2 秒 |
| 本文のまとめ（最後の `append` から 3 秒） | 本文だけ +3〜30 秒 |
| 合計 | タイトル・コメント 5 秒、本文 10 秒 |

- 本文は、まとめの 30 秒の上限（最初の `append` から）に当たると 10 秒を超える。書き続けている間の本文は、書き終わってから 10 秒以内を目標にする。

### 9.3 遅れの見せ方

- 自分が作ったばかりのイシューは、手元の検索（タイトル）で見つかる。サーバーの検索に出るまでの間も、手元の結果にある。
- `search_index_lag_seconds`（確定の時刻と、OpenSearch に書いた時刻の差）を測る。p95 が 30 秒を超えたら警告、5 分を超えたら画面に「検索の結果が遅れています」と示す（サーバーが `/search` の応答に `lagging: true` を付ける）。

### 9.4 数え直しと作り直し

- 数え直し（1 時間ごと、ワークスペースを順に）：Aurora の行の `(id, updated_sync_id)` と、索引の `(id, v)` を、ID の範囲ごとのハッシュで比べ、違う範囲を読み直して書き直す。墓標の文書を 1 日後に消す。
- 作り直し（アナライザーの変更、Sudachi への切り替え）：新しい索引 `docs_v<n+1>` を作り、全ワークスペースを流し込み、その間の変更は両方に書き、数え直しで追いついたら別名を切り替える。
- ワークスペースの削除（解約）：`workspace_id` での削除の問い合わせを、データの削除の手順（security の領域）の一部にする。

## 10. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| OpenSearch が落ちた | サーバーの検索ができない | `/search` は `503`。画面は手元の検索だけを出し、「本文とコメントの検索は使えません」と示す。`pg_bigm` などの非常の経路は持たない |
| 索引の Worker が遅れる | 新しい変更が検索に出ない | 9.3 節の遅れの表示。SQS の滞留で Worker を増やす |
| 移動の直後で `groups` が古い | 前のチームの人の検索に出る候補になる | 6.3 節の読み直しで落とす |
| 文書が生き返る（遅れた古い書き込み） | 消したイシューが候補に出る | 外部のバージョンと墓標（4.3 節）。読み直しで削除を落とす |
| 本文のまとめが止まる | 本文の変更が検索に出ない | まとめの Worker の監視（[editor-and-descriptions.md](editor-and-descriptions.md) の 10 節） |
| 1 つのワークスペースが索引の書き込みを占める（インポート） | 他のワークスペースの遅れ | インポートの経路の変更は別の SQS（`search-bulk`）に流す（import-export の領域と決める） |

## 11. セキュリティ

- **テナント**：`buildSearchRequest` が必ず `routing` と `workspace_id` の条件を付ける（PROP-SEARCH-001）。OpenSearch はワークスペースの分離を持たないので、この関数が唯一の守りの 1 つ目で、読み直し（RLS の下）が 2 つ目。
- **非公開のチーム**：`groups` の条件と、Aurora の読み直し。索引の値（タイトル・本文）を、読み直しを通らずに返さない。抜粋はバージョンが同じときだけ。
- **件数・並びの漏れ**：合計の件数を返さない。見てよくない文書は `filter` で除かれるので、並びにも影響しない。
- **検索の語**：利用者の書いた中身と同じに扱う。ログには語の長さと語の数だけを書く。遅い問い合わせのログ（OpenSearch のスローログ）は有効にしない。
- **OpenSearch への接続**：VPC の中、細かなアクセス制御の IAM のロール。索引の Worker は書き込みだけ、検索の API は読み取りだけのロール。
- **ゲスト**：ゲストの購読は、参加したチームのグループと `workspace` だけ（[permissions-and-teams.md](permissions-and-teams.md) の 6 節）。`workspace_members` の行（イニシアチブ）は検索の対象にしない（MVP の対象はイシュー・コメント・プロジェクトで、どれもチームのグループ）。
- **データの削除**：ゴミ箱の 30 日後の削除、解約で、文書も消す（9.4 節）。スナップショット（OpenSearch の自動のバックアップ）の保持は法務の L5 で決める。

## 12. テスト

- **性質ベーステスト**：
  - **PROP-SEARCH-001（組み立て）**：任意の検索の条件で、`buildSearchRequest` の要求が `routing`・`workspace_id`・`groups`・`deleted`・`trashed` の条件を含む。
  - **PROP-SEARCH-002（見てよいものだけ）**：任意のメンバーシップ・非公開への切り替え・移動の列と、任意の索引の遅れ（文書の `groups` が古い）の下で、`/search` の結果は、すべて呼んだ人がその時点で見てよい行である。
  - **PROP-SEARCH-003（収束）**：任意の変更の列と、索引の Worker の任意の並列・順序・重複の後、変更が止まって数え直しが 1 回終われば、索引の各文書の `v` と中身が Aurora の行と一致し、消した行の文書は墓標か、ない。
  - **PROP-SEARCH-004（正規化の一致）**：任意の文字で、手元の照合（M2）とサーバーの一致の判定が、タイトルについて同じ結果を返す（正規化が同じ関数であること）。
- **例示テスト**：日本語の 1 文字の語、全角と半角、ひらがなとカタカナ、長音、絵文字、`ENG-123`・`eng123`。
- **結合テスト**（Testcontainers の OpenSearch）：索引の Worker を止めて移動し、読み直しで落ちることを確かめる。
- **計測**：S1 の想定の量（イシュー 5,000 万、コメント 2 億の合成のデータ）で、索引の大きさ、`/search` の p99 500ms（NFR-010）、遅れの p95 10 秒。
- **合成監視**：「イシューを非公開のチームへ移す → 前のチームの人の検索に出ない」を 5 分ごと。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E8 | `search-poc` | 3 節の比較の計測（索引の大きさ、p99、費用）。OpenSearch の決定を確かめる |
| E8 | `search-index-mapping` | 4 節の索引、フィールド、アナライザー、正規化 |
| E8 | `search-indexer` | 9.1 節の Relay の選別と、索引の Worker、外部のバージョン、墓標 |
| E8 | `search-query-and-rehydrate` | 6.2・6.3 節の `buildSearchRequest`、読み直し、抜粋、PROP-SEARCH-001・002 |
| E8 | `search-api` | 7 節の API、識別子の解決、上限 |
| E8 | `search-local-merge` | 8 節の手元とサーバーの組み合わせ（client-app と共同） |
| E8 | `search-reconcile` | 9.4 節の数え直し、作り直し、PROP-SEARCH-003 |
| E8 | `search-lag-ux` | 9.3 節の遅れの計測と表示 |
| E8 | `opensearch-domain` | ドメイン、VPC、IAM、スナップショット（infrastructure と共同） |
| E12 | `search-privacy-synthetic` | 12 節の合成監視と、外部のペンテストの対象に検索を入れる |

## 14. 未解決の問い

- S1 の基盤を OpenSearch にするか、`pg_bigm` にするか。
- 関連度のアナライザーを kuromoji にするか、Sudachi にするか。
- ひらがなとカタカナを同じにするか。
- 権限を同期グループで効かせるか、別の権限キーを持つか。
- サーバーの検索が落ちたとき、`pg_bigm` の非常の経路を持つか。
- 文書の単位を行にするか、イシュー（コメントを含む）にするか。

### 決定

2026-09-28 の既定案。E8 の PoC で覆りうる。

- **基盤**：S1 から OpenSearch（ADR-0030）。`pg_bigm` は Aurora PostgreSQL 18 で使えることを確かめたうえで、代案とする。
- **アナライザー**：一致は 1〜2 文字の N-gram、関連度は同梱の kuromoji。Sudachi は関連度の不満が出たら（ADR-0030）。
- **かな**：同じにする。コマンドメニューと合わせる。
- **権限**：同期グループ。文書に行の `sync_groups`、検索のたびに購読を読む。結果は Aurora で読み直す（ADR-0031）。
- **非常の経路**：持たない。手元の検索だけで続ける。
- **単位**：行ごと。コメントを別の文書にし、どのコメントで当たったかを示す。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| OpenSearch の費用と、シャードの数 | E8 の `search-poc` |
| 1 文字の N-gram の索引の大きさ | E8 の `search-poc` |
| 本家の検索の基盤、日本語の解析、索引の遅れ | 公式の資料では確かめられなかった（**未検証**のまま） |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- PROP-SEARCH-001〜004 を E8 のリリースの基準にする。PROP-SEARCH-002 は NFR-008 の試験の一部として E12 でも回す。
- 日本語の例示テストの集まり（12 節）を、アナライザーや正規化の変更の PR の必須にする。
- 本番：`search_hydration_drop`（読み直しで落ちた数）。移動の直後以外で出たら、`groups` の反映の誤りとして調べる。
- 本番：`search_index_lag_seconds` の p95（10 秒）、`/search` の p99（500ms）、数え直しで直した文書の数。
- 合成監視：「非公開へ移す → 前のチームの人の検索に出ない」。

### runbooks

- `search-index-lag.md`：遅れの原因の切り分け（Relay、SQS の滞留、索引の Worker、OpenSearch の書き込みの拒否）と、Worker を増やす手順。
- `search-reindex.md`：索引の作り直しと別名の切り替え、1 つのワークスペースだけの作り直し。
- `opensearch-outage.md`：ドメインの障害の間の画面の案内と、回復の後の数え直し。

### data-model（索引への追加の提案）

| 表・置き場所 | 中身 | 節 |
| --- | --- | --- |
| OpenSearch の `docs` の索引 | 行ごとの文書、`groups`、バージョン | 4 |
| `packages/search` | `normalizeForSearch`（views-and-filters・client-app と共有）、`buildSearchRequest` | 5.1、6.2 |
| SQS の `search-index`・`search-bulk` | 索引の更新の流れ | 9.1 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Search](https://linear.app/docs/search)
- AWS, [Extension versions for Amazon Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)（`pg_bigm` 1.2_20250903 が 18.3・18.4 で使える）
- AWS, [Plugins by engine version in Amazon OpenSearch Service](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html)（kuromoji の同梱、Sudachi の任意のプラグイン）
- OpenSearch, [Index document](https://docs.opensearch.org/latest/api-reference/document-apis/index-document/)（`version_type=external`）
- PostgreSQL 18 Documentation, [CREATE POLICY](https://www.postgresql.org/docs/18/sql-createpolicy.html)（方針の条件と LEAKPROOF）
- Slack の題材の [ADR-0027](../../../slack/docs/decisions/0027-search-table-rls-exception.md)（`pg_bigm` と RLS の例外）

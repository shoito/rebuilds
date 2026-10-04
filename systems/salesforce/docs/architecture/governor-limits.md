# Governor limits: Salesforce

全ての上限の一覧と値、数え方、計測の方法、組織ごとの割り当て（API、一括、イベント、ストレージ）、長い要求の同時実行、Worker の公平な順番、上限の情報の返し方の設計。土台は [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)（1 トランザクションの上限と組織ごとの割り当てを、実行基盤のデータ層で強制する）。この文書で決めたことは、次の 2 つの ADR にある。

- **上限の正本はこの文書の一覧（と、同じ内容を持つコードの上限の登録簿）だけにする。** 他の領域の文書の上限の表は写しで、食い違ったらこの文書を正とする。他の領域から来た 3 つの依頼を決めた：フローの要素の実行は足並みの 1 歩で数える。積み上げ集計の集計し直しは取得の行に数えない（別の上限で抑える）。レポートは、トランザクションの上限ではなく別の予算で抑える。同じ考えで、一括の問い合わせと検索にも別の予算を置く（[ADR-0041](../decisions/0041-limits-registry-and-counting-rules.md)）。
- 組織ごとの割り当ては、24 時間の移動の窓で数え、有料の本番の組織だけ 110% まで超えられる。長い要求（20 秒以上）の同時実行は組織で 25。Worker は、仕事の種類ごとに組織の重み付きの公平な順番（仮想時刻）で回し、DB の時間を使いすぎた組織の重みを下げる。上限の情報は `<Brand>-Limit-Info`（割り当て）と、求めた時だけ返す `<Brand>-Tx-Usage`（トランザクションの使用量）で返す（[ADR-0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 全ての上限の一覧、値、数え方、エラー | 各機能の中で上限をどこで確かめるかの実装（各領域） |
| トランザクションの上限の計測器 | 問い合わせの計画の予算の中身（[query-language-and-api.md](query-language-and-api.md) の 4 節） |
| 別の予算（レポート、一括の問い合わせ、検索、レコードのページ） | エディションとライセンスの定義（[orgs-users-and-auth.md](orgs-users-and-auth.md)） |
| 組織ごとの割り当て、長い要求の同時実行、公平な順番 | 負荷の見積もりと部品の必要量（capacity の領域） |
| `<Brand>-Limit-Info`、`<Brand>-Tx-Usage`、`/api/v1/limits` | 騒がしい隣人の検知のダッシュボード（observability の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 1 トランザクションの上限 | 同期で問い合わせ 100、取得の行 50,000、DML 150、DML の行 10,000、CPU 10,000ms、ヒープ 10MB（非同期は問い合わせ 200、CPU 60,000ms、ヒープ 25MB）。超えると捕まえられない例外で巻き戻る | [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md) に写した [Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)（Winter '27 版） |
| API の割り当て | Enterprise は 24 時間で 100,000＋ライセンスの数 × 1,000。Unlimited は 1 ライセンス 5,000。Full の Sandbox は 5,000,000。組織の全体で数え、利用者ごとではない | [Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)（以下「Limits」。2026-09-11 更新版） |
| 割り当ての超過 | 有料で有効な組織は、急な増加に備えて一定の量だけ超えて動く。超えられる量には上限（hard cap）がある。試用・Developer・Sandbox には効かない。超えられる量は資料に書かれていない | Limits |
| 割り当ての見え方 | REST の応答の `Sforce-Limit-Info`、`/limits`、Setup の画面。使用量が割合を超えたらメールで知らせる設定がある | Limits |
| 要求の大きさ | URI と見出しの合計 16,384 バイト。超えると 414・431 | Limits |
| 一括の割り当て | 24 時間で 15,000 の batch（Bulk API と共有）、取り込み 1 億 5,000 万行、問い合わせのジョブ 10,000、問い合わせの結果 1TB。結果は 7 日。1 つのジョブの CSV は 150MB（base64 の前の目安 100MB） | Limits |
| 長い要求 | 20 秒以上の要求の同時実行は本番で 25 | [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)、Limits |
| イベントの割り当て | 発行は 1 時間 250,000（Enterprise・Unlimited）、配信は 24 時間 50,000（Unlimited）・25,000（Enterprise）。配信は変更のイベントと共有。移動の窓で数える | [Platform Events Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/platform_events.pdf)（Winter '27 版） |
| フローの要素の数 | 1 トランザクションの要素の数の上限（2,000）は API のバージョン 57.0 でなくした。フローは Apex の上限に従う | [Flow Limits per Org](https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit.htm&type=5)、[Per-Transaction Flow Limits](https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit_transaction.htm&type=5)（2026-09-28 に確認） |
| 集計の読みの数え方 | `COUNT()` 以外の集計の関数は、集計に使った行を全て取得の行に数える。`COUNT()` は 1 行（`GROUP BY` があればグループごとに 1 行）。積み上げ集計の計算し直しの読みの数え方は資料に書かれていない（未検証。E6 の `flow-limit-counting` で試用の組織で確かめる） | [Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)（Winter '27 版、2026-09-28 に確認） |

## 3. 上限の登録簿（ADR-0041）

### 3.1 形

上限は、開発リポジトリの 1 つのファイル（`packages/limits/registry.ts`、仮称）に登録する。

```ts
{
  id: "tx.query_rows",            // 変えない ID。エラーと計測の名前に使う
  scope: "transaction",           // transaction | request | metadata | budget | allocation | concurrency
  value: { sync: 50000, async: 50000 },
  unit: "rows",
  counts: "rows returned by user and flow queries, incl. aggregated rows",
  excludes: ["rollup.recalc", "sharing.eval", "dup.candidate_keys"],
  error: { status: 400, code: "LIMIT_EXCEEDED" },
  owner: "governor-limits",
  source_area: "query-language-and-api",
  test: "LIM-TX-002",             // 上限の試験の ID
}
```

- 実行基盤の計測器・API の応答・Setup の画面・この文書の一覧は、全てこの登録簿から作る。CI で、この文書の表と登録簿が一致することを検査する（表を生成して比べる）。
- 値を変える PR は、上限の試験（ちょうどで通り、1 つ超えたら巻き戻る・拒否する）を必ず伴う（AGENTS.md）。値を緩めて試験を通さない。
- 他の領域の文書の上限の表は写しとして残してよいが、「値はこの文書を正とする」と書く（各領域はすでにそう書いている）。

### 3.2 種類

| `scope` | 意味 | 超えた時 |
| --- | --- | --- |
| `transaction` | 1 つの DB のトランザクション（ADR-0005）。同期・非同期で値が違う | 全体を巻き戻す。400 `LIMIT_EXCEEDED`。フローからも捕まえられない |
| `request` | 1 回の API の要求の形（文の長さ、件数、本文の大きさ） | 実行の前に拒否する（400・413・414） |
| `metadata` | 設定の数・大きさ（項目の数、フローの要素の数） | メタデータの保存・デプロイを拒否する |
| `budget` | トランザクションではない読みの処理（レポート、一括の問い合わせ、検索、レコードのページ）の予算 | 打ち切り、非同期に回す、または部分の結果 |
| `allocation` | 組織ごとの 24 時間・1 時間の量 | 429 `REQUEST_LIMIT_EXCEEDED` と `Retry-After` |
| `concurrency` | 組織ごとの同時の数 | 429 `CONCURRENT_LIMIT_EXCEEDED`、または順番待ち |

## 4. トランザクションの上限と数え方（ADR-0005、ADR-0041）

### 4.1 一覧

| ID | 上限 | 同期 | 非同期 | 数え方 |
| --- | --- | --- | --- | --- |
| `tx.queries` | 問い合わせの数 | 100 | 200 | 実行した問い合わせ 1 文を 1。フローの `get_records` は、足並みでまとめた 1 回を 1。積み上げ集計の集計し直しは 1。重複の照合の候補の読みは 1 |
| `tx.query_rows` | 取得の行の合計 | 50,000 | 50,000 | 利用者とフローの問い合わせが返した行。集計の問い合わせは集計した行を数える（ADR-0018）。**積み上げ集計の集計し直しの行は数えない**（4.3 節） |
| `tx.dml` | DML の数 | 150 | 150 | DML 1 文を 1。フローの DML は、まとめた 1 回を 1。積み上げ集計の親の入れ子の保存は、塊ごとに 1 |
| `tx.dml_rows` | DML の行の合計 | 10,000 | 10,000 | 作成・更新・削除・戻すの行。入れ子の保存の行を足す |
| `tx.cpu_ms` | 実行基盤の CPU 時間 | 10,000ms | 60,000ms | 経過時間から DB の待ちを引いた近似（ADR-0005）。数式・フローの解釈器・検証を含む。E13 では利用者のコードの燃料の使用量を係数で換算して足す（係数は E13 の前の PoC で決める） |
| `tx.memory` | 結果と状態のメモリー | 10MB | 25MB | 問い合わせの結果の行、フローの変数、DML の塊の大きさの見積もり |
| `tx.flow_elements` | フローの要素の実行 | 2,000 | 2,000 | **足並みの 1 歩を 1**（4.2 節） |
| `tx.nesting` | 保存の自動化の入れ子の深さ | 16 | 16 | 保存の後のフローの DML、積み上げ集計の親の保存、`subflow` を足す |
| `tx.subflow_depth` | `subflow` の段 | 10 | 10 | |
| `tx.events_published` | 組織が定義するイベントの発行 | 150 | 150 | 発行の呼び出し 1 回を 1（1 回で複数件でも 1）。変更のイベントは数えない |
| `tx.outbound_calls` | 外向きの呼び出し（`call_webhook`） | 100 | 100 | outbox への依頼 1 件を 1。新しい上限（ADR-0041） |
| `tx.emails` | メールの送信（`send_email`、1 通ずつの送信） | 10 | 10 | 送信の依頼 1 回を 1。1 回の宛先は 100 まで。新しい上限（ADR-0041） |
| `tx.duration` | トランザクションの時間 | 2 分 | 10 分 | 開始から確定まで |
| `tx.code_fuel` | 利用者のコードの燃料（E13） | 50 億 | 300 億 | Wasmtime の燃料。トランザクションの全ての呼び出しの合計。値は E13 の `code-engine-poc` で `tx.cpu_ms` の 10 秒・60 秒に見合うよう決める（今の値は仮。未検証） |
| `tx.code_memory` | 1 回の呼び出しの線形メモリー（E13） | 64MB | 128MB | 実体化の時に確保する大きさ |
| `tx.code_invocations` | 砂場の呼び出しの数（E13） | 200 | 400 | 1 塊・1 トリガーを 1 |

- 「同期」は画面と REST の要求。「非同期」は Worker のトランザクション（一括の取り込みの 1 つのトランザクション、予定の経路、非同期の経路、スケジュールのフロー、承認の通知の後の処理）。
- `tx.code_*` は extensibility の領域の依頼（[extensibility.md](extensibility.md) の 7 節、[ADR-0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md)）で足した。燃料・メモリーを超えたら全体を巻き戻し、利用者のコードの `try`・`catch` でも捕まえられない（Wasmtime のトラップはホストで扱う）。トリガーの中のホストの API の問い合わせ・DML は、通常の `tx.queries`・`tx.dml` などに数える。
- 数えないもの：メタデータの読み、共有の評価（手順 10）の中の読み書き、承認のロックの表の読み、outbox の書き込み、項目の変更の履歴の書き込み（手順 9）、監査のログ。これらはシステムの仕事で、利用者の設定で量が決まらないか、別の上限で抑えているため。
- `tx.outbound_calls` と `tx.emails` は ADR-0005 の表になかった。フローの `call_webhook`・`send_email`（[automation-flows.md](automation-flows.md) の 3.2 節）が 1 回の保存で無制限に送信を依頼できないようにする。本家の似た上限は、1 トランザクションの外への呼び出し 100（合計の待ち 120 秒）、`sendEmail` の呼び出し 10（[Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)、Winter '27 版の「Per-Transaction Apex Limits」、2026-09-28 に確認）。

### 4.2 フローの要素の実行：足並みの 1 歩で数える

- [automation-flows.md](automation-flows.md) の 4.2 節の依頼を受け、**足並みの 1 歩を 1 と数える**ことを正式に決める（ADR-0041）。200 の実行が同じ `assignment` を通っても 1。`loop` は、繰り返しの 1 歩を 1 と数え、実行ごとに繰り返しの数が違えば最も多い実行の数を採る。
- 理由：実行（インタビュー）ごとに数えると、200 件の塊で 10 要素のフローが 2,000 に達し、一括の取り込みが動かない。同じフローが 1 件では通り、200 件では落ちる。足並みの 1 歩なら、数がフローの形だけで決まり、上限の試験が再現できる。
- この数え方は本家と違う（本家はフローの要素の数に上限を持たない。積み上げ集計の読みの数え方は未検証。2 節）。移行の文書に書く。
- 代わりに、1 つの実行の中の繰り返しの問い合わせ・DML は、`tx.queries`・`tx.dml` で抑える（まとめられないため）。

### 4.3 積み上げ集計の集計し直し：取得の行に数えない

- [automation-flows.md](automation-flows.md) の 7.3 節の依頼を受け、**手順 8 の積み上げ集計の集計し直しで読んだ子の行は `tx.query_rows` に数えない**ことを正式に決める（ADR-0041）。問い合わせの数（`tx.queries`）には 1 と数える。
- 代わりに、別の上限 `rollup.sync_recalc_children`（5 万）を置く。子が 5 万件を超える親は同期で集計し直さず、`rollup_stale` に入れて Worker が 1 時間以内に直す（[ADR-0027](../decisions/0027-roll-up-summaries-incremental-with-reconciliation.md)）。
- 理由：集計し直しは利用者の問い合わせではなく保存の一部で、読む行の数は利用者が選んだものではない。数えると、子の多い親の子を 1 件直すだけで上限を超え、業務が止まる。5 万件の上限で、1 回の保存の DB の費用は抑えられる。
- 利用者やフローが書いた集計の問い合わせ（`SELECT COUNT() ...`）は、これまでどおり集計した行を数える（ADR-0018）。例外は手順 8 だけ。

### 4.4 エラー

```json
{
  "errors": [{
    "code": "LIMIT_EXCEEDED",
    "message": "Too many query rows: 50001 (limit 50000)",
    "limit": "tx.query_rows", "used": 50001, "max": 50000,
    "where": { "kind": "flow", "flow": "sync_region", "element": "e4" }
  }],
  "request_id": "req_..."
}
```

- `where` は、超えた場所（フローと要素、入れ子の深さ、API の要求）。値や件数の見積もりは入れない（[query-language-and-api.md](query-language-and-api.md) の 6.2 節）。
- フローの `fault` の経路では捕まえられない。巻き戻りは records・ピボット・共有の行・outbox のどれにも残らない（ADR-0005）。

### 4.5 計測器

- 計測器はトランザクションの文脈（AsyncLocalStorage）に 1 つ持ち、データ層の問い合わせ・DML・フローの解釈器・outbox の書き込みの入口で数える。数えた直後に上限と比べ、超えたらその場で例外を投げる。
- セーブポイントで戻すとき（部分の成功のやり直し。[metadata-and-runtime.md](metadata-and-runtime.md) の 6.3 節）は、計測器の数もセーブポイントの時点に戻す。
- CPU 時間は、要素・文ごとの経過時間の合計から DB の待ちを引いた近似にする。Node.js のイベントループで正確に分けられないため（ADR-0005）。判定がぶれるので、上限の試験は CPU 以外の上限で行い、CPU は余裕を持った負荷試験で見る。
- 確定の時に、使用量の最大の割合（どの上限で何 % か）を `tx_limit_peak_ratio{limit}` として計測する。80% を超えたトランザクションは、組織の「上限に近い自動化」の一覧に載せる（9.4 節）。
- **名前空間ごとの内訳**（E13。extensibility の領域の依頼、[ADR-0050](../decisions/0050-packages-namespaces-and-code-isolation.md)）：パッケージのコードと組織の設定は、同じトランザクションの上限を共有する（パッケージに別の上限を与えない）。計測器は、使用量を名前空間（パッケージの名前空間、組織の設定は `_org`）ごとにも足し、`tx_limit_peak_ratio{limit, namespace}` と `<Brand>-Tx-Usage` の内訳（9.2 節）、「上限に近い自動化」に出す。どのパッケージが上限を使っているかを、組織の管理者と配布者が見分けられるようにする。
- データ層は、トランザクションの開始で `SET LOCAL application_name = 'o:<org_id>:<path>'` を設定する（observability の領域の依頼。騒がしい隣人の DB の側の計測、[ADR-0059](../decisions/0059-noisy-neighbor-detection-two-sources.md)）。計測器の差し込み口に含める。

## 5. 別の予算（ADR-0041）

トランザクションではない読みの処理は、トランザクションの上限ではなく、それぞれの予算で抑える。DB の時間は、どれも組織ごとの DB の時間（7 節）に数える。

| ID | 予算 | 値 | 超えた時 | 担当の領域 |
| --- | --- | --- | --- | --- |
| `report.sync` | レポートの同期の実行 | reader の DB の時間 20 秒、読む行の見積もり 100 万、詳細の行 2,000、グループ 2,000 | 非同期に回す（1 回） | [reports-and-dashboards.md](reports-and-dashboards.md) の 5.3 節 |
| `report.async` | レポートの非同期の実行 | DB の時間 10 分、読む行 5,000 万、エクスポート 100 万行 | 400 `REPORT_TOO_LARGE` | 同上 |
| `bulk.query` | 一括の問い合わせのジョブ | reader の DB の時間 1 ジョブ 60 分、1 回の読みの範囲 25 万行、結果の 1 ファイル 1GB | ジョブを `failed`（`QUERY_TIMEOUT`） | [bulk-and-import.md](bulk-and-import.md) の 5 節 |
| `search.request` | 検索の 1 回の要求（1 ページ） | OpenSearch の時間 2 秒、候補の固定の束 3,000、後の確かめはオブジェクトごとに 1 回、下限の時間 600ms | 部分の結果と `more_may_exist` | [search.md](search.md) の 6 節 |
| `ui.record_page` | レコードのページの API | 問い合わせ 10、最初に読む関連リスト 6 | 関連リストを `deferred` | [ui-layouts-and-list-views.md](ui-layouts-and-list-views.md) の 4.1 節 |
| `ui.list_view_count` | リストビューの件数 | 1 万件で打ち切り | 「1 万件以上」 | 同 5.3 節 |
| `query.explain` | 計画の説明 | 候補の見積もりだけ（実行しない） | — | [query-language-and-api.md](query-language-and-api.md) の 4.6 節 |

- **レポートの予算**：[reports-and-dashboards.md](reports-and-dashboards.md) の 14 節の依頼を受け、レポートの実行を `tx.*` の外に置き、上の `report.*` で抑えることを正式に決める（ADR-0041）。レポートは DML のトランザクションではなく、reader で広い範囲を集計する道具だからである。
- **一括の問い合わせの予算**：[query-language-and-api.md](query-language-and-api.md) の 4.5 節は、一括の問い合わせを「非同期の上限の中で」実行するとした。これでは `tx.query_rows`（5 万）で数百万行の取り出しが止まる。一括の問い合わせは、reader で ID の範囲ごとに読んで S3 に書く読みだけの処理なので、`bulk.query` の予算で抑える（ADR-0041）。問い合わせの言語の上限（文の長さ、関係の数）は同じものを使う。
- 画面と REST の同期の問い合わせは、これまでどおり `tx.*` と `query.sync_timeout`（30 秒）で抑える。

## 6. 上限の一覧（全領域）

各領域の文書の値を集めたもの。**この表が正本**で、各領域の表は写し。本家の値の出典は各領域の文書にある。

### 6.1 要求の形（`request`）

| ID | 上限 | 値 | 領域 |
| --- | --- | --- | --- |
| `req.body_bytes` | 要求の本文 | 10MB（一括のアップロードは 150MB） | query-language-and-api、bulk-and-import |
| `req.uri_bytes` | URI と見出し | 16KB | query-language-and-api |
| `req.composite` | 複合の要求の副要求 | 25 | query-language-and-api |
| `req.collections` | collections の件数 | 200 | query-language-and-api |
| `query.chars` | 問い合わせの文字数 | 100,000 | query-language-and-api |
| `query.literal_chars` | 1 つの文字列のリテラル | 4,000 | query-language-and-api |
| `query.parent_depth` | 親への参照の段 | 5 | query-language-and-api |
| `query.parent_relationships` | 親への別々の関係 | 35 | query-language-and-api |
| `query.child_subqueries` | 子の副問い合わせ（1 段、親 1 件 200 件） | 10 | query-language-and-api |
| `query.semi_joins` | 半結合 | 2 | query-language-and-api |
| `query.in_values` | `IN` の値 | 1,000 | query-language-and-api |
| `query.group_by` | `GROUP BY` の項目・集計の結果のグループ | 3・2,000 | query-language-and-api |
| `query.offset` | `OFFSET` | 2,000 | query-language-and-api |
| `query.page_size` | 1 ページ | 200〜2,000（長いテキスト 2 つ以上で 200） | query-language-and-api |
| `query.ast_nodes`・`query.sql_joins` | AST の節・生成した SQL の結合 | 5,000・20 | query-language-and-api |
| `query.sync_timeout` | 同期の問い合わせの時間 | 30 秒 | query-language-and-api |
| `query.non_selective_rows` | 対話で選択的でない問い合わせを断る大きさ | 20 万件 | query-language-and-api |
| `lead.convert_items` | リードの変換の 1 回 | 50 | sales-objects |
| `search.query_chars` | 検索の語の文字数 | 2〜500（CJK は 1 文字から） | search |
| `search.results` | 検索の 1 回の結果・合計 | 1 回 200、オブジェクトごと 200、ページ送りで 2,000 | search |
| `events.publish_batch` | 組織が定義するイベントの 1 回の発行 | 200 件、1 件 64KB | events-and-integrations |
| `events.poll_batch` | 変更のイベントの 1 回の読み | 1,000 件 | events-and-integrations |

### 6.2 メタデータ（`metadata`）

| ID | 上限 | 値 | 領域 |
| --- | --- | --- | --- |
| `md.custom_objects` | 組織のカスタムオブジェクト | 800 | metadata-and-runtime |
| `md.fields` | オブジェクトの項目（削除中を含む） | 500 | metadata-and-runtime |
| `md.relationships`・`md.master_detail`・`md.md_depth` | 関係・主従・主従の段 | 40・2・3 | metadata-and-runtime |
| `md.rollups` | オブジェクトの積み上げ集計 | 25 | metadata-and-runtime、automation-flows |
| `md.indexed_fields`・`md.unique_fields` | 索引の項目・一意の項目 | 50・25 | metadata-and-runtime |
| `md.picklist_values` | 有効な選択リストの値 | 1,000 | metadata-and-runtime |
| `md.record_data_bytes` | `records.data` | 64KB | metadata-and-runtime、data-storage |
| `md.change_elements` | 1 つのバージョンで変える要素 | 10,000 | metadata-and-runtime、sandboxes-and-deploy |
| `formula.*` | 式の文字・展開後の AST の節・親への参照の段・たどる関係・参照の深さ | 5,000・2,000・5・15・10 | metadata-and-runtime |
| `sharing.*` | ロール・ロールの深さ・グループとキュー・入れ子・共有ルール（うちレコードの条件）・手動の共有・チーム・利用者の権限セット・組織の権限セット | 2,000・20・5,000・5・300（50）・500・100・100・1,000 | sharing-and-record-access |
| `sharing.closure_sync_rows` | 閉包の同期の更新 | 1 万行 | sharing-and-record-access |
| `sharing.skew_warn` | 所有者・親のスキューの警告 | 1 万件 | sharing-and-record-access |
| `dup.*` | 有効な重複の規則・照合の規則・重複の規則の照合の規則・照合の項目・候補 | 5・5・3・10・200 | sales-objects |
| `activity.relations` | 活動の追加の関係者 | 取引先責任者 50 かリード 1 | sales-objects |
| `layout.*` | レイアウトの項目・関連リスト | 200・20 | ui-layouts-and-list-views |
| `list_view.*` | 条件・列・並べ替え | 10・15・2 | ui-layouts-and-list-views |
| `flow.*` | バージョンの要素・バージョンの数・1 オブジェクト 1 手順の有効なフロー・予定の経路・実行の順の番号 | 500・50・50・10・1〜2,000 | automation-flows |
| `validation.*` | 有効な入力規則・返すエラー | 100・20 | automation-flows |
| `approval.*` | 段・承認者・有効なプロセス（オブジェクト・組織） | 30・25・50・1,000 | automation-flows |
| `report.*` | レポートの型のオブジェクト・列・グループ・条件・クロス条件 | 4・100・サマリー 3／マトリックス 2×2・20・3（副 5） | reports-and-dashboards |
| `dashboard.*` | 部品・条件（値）・購読・受け取る人 | 20・5（50）・5・50 | reports-and-dashboards |
| `search.searchable_fields` | オブジェクトの検索できる項目 | 20 | search |
| `events.*` | イベントの型・型の項目・カスタムのチャンネル・変更のイベントの対象のオブジェクト | 50・50・20・エディション（8.1 節） | events-and-integrations |
| `webhook.*`・`outbound.*` | Webhook の宛先・外向きの呼び出しの宛先 | 20・50 | events-and-integrations |
| `history.tracked_fields` | 項目の変更の履歴を持つ項目 | 1 オブジェクト 20 | audit-and-field-history |
| `package.*` | パッケージの部品・zip・展開後 | 10,000・50MB・600MB | sandboxes-and-deploy |
| `code.bundle_size` | 1 つのトリガーのバイトコード（E13） | 1MB | extensibility |
| `code.triggers_per_object` | 1 オブジェクトの有効なトリガー（E13） | 20 | extensibility |
| `code.log_lines` | 1 回の呼び出しのデバッグのログ（E13） | 100 行・64KB（超えた分は捨てて印を付ける） | extensibility |

### 6.3 Worker の処理の上限

| ID | 上限 | 値 | 領域 |
| --- | --- | --- | --- |
| `rollup.sync_recalc_children` | 同期で集計し直す子 | 5 万（超えたら `rollup_stale`） | automation-flows |
| `flow.scheduled_runs_24h` | スケジュールのフローの実行 | 25 万かライセンス × 200 の大きい方、1 フロー 25 万 | automation-flows |
| `flow.pending_scheduled_actions` | 予定の経路の行 | 1,000 万 | automation-flows |
| `flow.live_screen_interviews` | 生きている画面のフローの実行 | 5 万 | automation-flows |
| `sharing.jobs` | 同時の共有のジョブ・閉包のジョブ | 組織 2・1 | sharing-and-record-access |
| `bulk.*` | 8.2 節 | | bulk-and-import |

## 7. 組織の DB の時間と騒がしい隣人（ADR-0042）

- 全ての経路（Runtime、Worker、reader のレポート・一括の問い合わせ・検索の後の確かめ）で、DB の時間（文の実行の時間の合計）を組織ごとに数える。Runtime はトランザクションの計測器から、Worker は仕事ごとに、確定の時に 1 分の桶へ足す（Valkey、失われたら DB の 1 分ごとの集計で補う）。
- 組織の DB の時間が、物理のクラスタの DB の時間の 20% を 5 分続けて超えたら、その組織を「重い」とし、Worker の重みを半分にする（8.4 節）。対話の経路は止めない（利用者の画面を止めない）。
- 重い状態は、10% を下回って 15 分続いたら外す。状態の変化は `org_db_time_heavy{org}` として出し、Ops の騒がしい隣人の検知（observability の領域）に渡す。
- 対話の経路は、長い要求の同時実行（8.3 節）と、トランザクションの上限と、`statement_timeout` の 3 段で守る。

## 8. 組織ごとの割り当て（ADR-0042）

### 8.1 割り当ての表（エディションごとの初期値）

エディションの定義は [orgs-users-and-auth.md](orgs-users-and-auth.md) の 4 節。値は本システムの初期値で、E12 の負荷試験と、E2 の着手前の PM の判断（intent）で決める。

| ID | 割り当て | 窓 | Pro | Enterprise | Unlimited | Developer・試用 | Sandbox |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `alloc.api_requests` | API の要求 | 24 時間 | 50,000＋ライセンス × 500 | 100,000＋ライセンス × 1,000 | 100,000＋ライセンス × 5,000 | 15,000 | 元の本番と同じ式（Full は 500 万） |
| `alloc.bulk_rows` | 一括の取り込みの行 | 24 時間 | 100 万 | 1,000 万 | 5,000 万 | 10 万 | 本番と同じ |
| `alloc.bulk_query_jobs` | 一括の問い合わせのジョブ | 24 時間 | 1,000 | 10,000 | 10,000 | 100 | 本番と同じ |
| `alloc.bulk_query_bytes` | 一括の問い合わせの結果 | 24 時間 | 10GB | 100GB | 500GB | 1GB | 本番と同じ |
| `alloc.events_published` | 組織が定義するイベントの発行 | 1 時間 | 5 万 | 25 万 | 25 万 | 5 万 | 本番と同じ |
| `alloc.events_delivered` | イベントの配信（変更のイベントと共有、API の購読者と Webhook） | 24 時間 | 10 万 | 50 万 | 100 万 | 1 万 | 10 万 |
| `alloc.cdc_objects` | 変更のイベントの対象のオブジェクト | — | 5 | 20 | 50 | 5 | 本番と同じ |
| `alloc.report_sync_runs`・`alloc.report_async_runs` | レポートの API の実行 | 1 時間 | 500・1,200 | 500・1,200 | 500・1,200 | 100・200 | 同じ |
| `alloc.dashboard_refresh`・`alloc.dashboard_results` | ダッシュボード | 1 時間 | 200・5,000 | 200・5,000 | 200・5,000 | 50・1,000 | 同じ |
| `alloc.emails_single` | 1 通ずつのメール | 24 時間 | 1,000 | 5,000 | 5,000 | 15 | 0（外へ送らない） |
| `alloc.data_storage` | データの容量 | — | 10GB＋ライセンス × 20MB | 同じ | 同じ | 200MB | 種類ごと（[sandboxes-and-deploy.md](sandboxes-and-deploy.md) の 3 節） |
| `alloc.file_storage` | ファイルの容量 | — | 10GB＋ライセンス × 2GB | 同じ | 同じ | 20MB | 種類ごと |

- API の要求の数に入れるもの：REST（`/api/versions` と `/api/v1/limits` を除く）、一括のジョブの作成・状態・結果の取り出しの要求、検索の API、イベントの発行・読みの API。画面（本システムの SPA）の要求は数えない（本家も一部の自社のアプリを数えない。Limits）。画面の要求は、長い要求の同時実行と上限で守る。
- データの容量は、1 レコードを 2KB と数える（本家の数え方に寄せる。本家も多くのレコードを約 2KB と数える。[Salesforce Data Storage: Estimated Record Size by Object Type](https://help.salesforce.com/s/articleView?id=000383664&type=1)、2026-09-28 に確認）。ごみ箱の行は数えない（本家もごみ箱のレコードをストレージに数えない。ADR-0011）。容量を超えたら、作成を 400 `STORAGE_LIMIT_EXCEEDED` で断り、更新と削除は通す。

### 8.2 数え方と超過（ADR-0042）

- **24 時間の移動の窓で数える。** Valkey に 1 分ごとの桶（1,440 個）を持ち、合計を読む。桶は 1 分ごとに Aurora の `org_usage_minutes` にも書き、Valkey を失った時は DB から作り直す。
- **超えた時**：有料の本番の組織は、割り当ての 110% まで通す（本家の「一定の量だけ超えて動く」に寄せる。本家は量を公開していない）。110% で 429 `REQUEST_LIMIT_EXCEEDED` と `Retry-After`（最も古い桶が抜けるまでの秒）を返す。試用・Developer・Sandbox は 100% で止める。
- **知らせ**：80%・100% を超えたら、組織の管理者（`customize_application`）にメールと Setup の通知で知らせる。本家も割合でメールを送れる（Limits）。
- Valkey の障害の時は、割り当ての検査を**通す側に倒す**（fail open）。止めると全ての組織の API が止まるため。DB の 1 分の集計で後から数え、超過は通知だけにする。
- 組織の移動（[ADR-0056](../decisions/0056-org-migration-by-row-filtered-logical-replication.md)）の切り替えの後は、移動の先の Valkey の桶を `org_usage_minutes` から作り直す。作り直しが済むまで（最大 1 分）、その組織の割り当ては fail open の範囲で数える（infrastructure の領域の依頼）。

### 8.3 長い要求の同時実行

- 組織ごとに、実行中の要求の開始の時刻を Valkey の sorted set に持つ。20 秒を超えて実行中の要求の数が 25 以上の間は、その組織の新しい同期の要求（画面・REST。一括のジョブの状態の読みと `/limits` を除く）を 429 `CONCURRENT_LIMIT_EXCEEDED` と `Retry-After: 5` で断る。本家も長い要求が 25 に達すると新しい要求を断る（ADR-0005、Limits）。
- 要求の終わりに集合から外す。タスクが落ちて残った印は、`request_timeout`（2 分）＋ 30 秒で消す。
- Sandbox は 10、Developer・試用は 5。

その他の同時の数（`concurrency`。Enterprise の初期値）：

| ID | 同時の数 | 値 | 領域 |
| --- | --- | --- | --- |
| `conc.long_running` | 20 秒を超えた要求 | 25 | この節 |
| `conc.event_streams` | 変更のイベント・組織のイベントの SSE の接続 | 100 | events-and-integrations |
| `conc.search` | 検索の要求 | 20 | search |
| `conc.report_sync` | レポートの同期の実行 | 利用者 2、組織 20 | reports-and-dashboards |
| `conc.bulk_jobs` | 処理中の一括のジョブ・開いたジョブ | 10・100 | bulk-and-import |
| `conc.deploys` | デプロイの適用・検証 | 1・3 | sandboxes-and-deploy |

### 8.4 Worker の公平な順番

```
仕事の種類（class）ごとに：
  jobs(org_id, class, id, state, available_at, cost_hint)      -- Aurora。FOR UPDATE SKIP LOCKED で取る
  org_vtime(class, org_id, vtime, weight, running, next_available_at)  -- 組織の仮想時刻と、待ちの仕事の最も早い時刻

Worker の取り出し：
  1. その class で running < org_cap の組織のうち、vtime が最も小さい組織を選ぶ
  2. その組織の最も古い仕事を取る
  3. 終わったら vtime += 実際の費用（DB の時間の秒）/ weight
  新しく仕事を持った組織の vtime は、max(自分の vtime, その class の最小の vtime) から始める
```

| class | 例 | 組織ごとの同時の上限（`org_cap`） |
| --- | --- | --- |
| `bulk_ingest` | 一括の取り込みの部分（1 万行） | 10 |
| `bulk_query` | 一括の問い合わせ | 3 |
| `report_async` | レポートの非同期の実行、定期の配信、エクスポート | 5 |
| `sharing` | ルールのバージョン・閉包の世代のジョブ | 2（閉包は 1） |
| `flow_async` | 予定の経路、非同期の経路、スケジュールのフロー | 5 |
| `metadata_post` | 型の変換、索引の作成、照合の鍵の作成、積み上げ集計の `building` | 2 |
| `search_reindex` | 検索の作り直し | 1 |
| `sandbox_copy` | Sandbox の複製 | 1 |
| `delivery` | Webhook、外向きの呼び出し、メール | 20 |
| `maintenance` | ごみ箱の消去、項目の値の消去、期限の掃除、整合の検査（2026-09-28 に足した。期限で動く仕事は `jobs.available_at` で予約し、組織をまたいで表を走査しない） | 1 |

- **重み**は、エディションとライセンスの数で決める（`1 + log2(ライセンスの数 + 1)`、上限 8）。大きな組織は多く回るが、小さな組織が待たされ続けない。7 節の「重い」組織は重みを半分にする。
- 仮想時刻で回すのは、仕事の大きさがばらつくため（1 万行の取り込みと、10 行の予定の経路）。件数で順番に回すと、大きな仕事の組織が多くを占める。
- SQS は「仕事が来た」の通知だけに使い、順番は `jobs` の表で決める。SQS は組織ごとの公平な取り出しを持たないため。
- 1 つの class の待ちが 15 分を超えたら警告する（`worker_queue_age_seconds{class}`）。

## 9. 上限の情報の返し方（ADR-0042）

### 9.1 `<Brand>-Limit-Info`

```
<Brand>-Limit-Info: api-usage=10018/115000; long-running=3/25
```

- 形は [ADR-0020](../decisions/0020-rest-api-shape-and-versioning.md) と [query-language-and-api.md](query-language-and-api.md) の 6.5 節のまま。バージョンの一覧を除く全ての応答に付ける。
- 110% までの超過の間は、`api-usage=121000/115000` のように使用量が割り当てを超えて見える。

### 9.2 `<Brand>-Tx-Usage`（求めた時だけ）

```
要求：<Brand>-Tx-Usage: request
応答：<Brand>-Tx-Usage: queries=12/100; query-rows=3401/50000; dml=3/150; dml-rows=210/10000;
      cpu-ms=820/10000; flow-elements=45/2000; nesting=3/16
      （E13 でパッケージのコードが動いた時）<Brand>-Tx-Usage-Ns: acme=queries:4,cpu-ms:310; _org=queries:8,cpu-ms:510
```

- 要求の見出しで求めた時だけ付ける。全ての応答に付けると見出しが大きくなり、ほとんどの利用者は使わないため。
- 値は最上位のトランザクションの使用量。複合の要求では副要求ごとに本文の `tx_usage` に入れる。
- 名前空間の内訳（E13）は、パッケージのコードが動いたトランザクションだけ `<Brand>-Tx-Usage-Ns` で返す。見出しが大きくならないよう、使った上限だけを並べる。
- フローのデバッグ（[automation-flows.md](automation-flows.md) の 9.3 節）の足跡にも、要素ごとの使用量を入れる。

### 9.3 `/api/v1/limits`

```json
{
  "allocations": [
    { "id": "alloc.api_requests", "max": 115000, "used": 10018, "window": "24h", "hard_max": 126500 },
    { "id": "alloc.bulk_rows", "max": 10000000, "used": 120000, "window": "24h" }
  ],
  "concurrency": [ { "id": "conc.long_running", "max": 25, "running": 3 } ],
  "storage": [ { "id": "alloc.data_storage", "max_mb": 20480, "used_mb": 3120 } ]
}
```

- 割り当ての数に入れない。認証は要るが、権限は `api_enabled` だけ。容量は `view_setup` がなければ返さない。

### 9.4 Setup の画面

- 「組織の上限」：割り当ての使用量の推移（24 時間・30 日）。
- 「上限に近い自動化」：直近 7 日で、あるトランザクションの上限の 80% を超えたフロー・要素・API の要求の上位 20。どの上限か、何 % か、何回か。値やレコードの ID は出さない。

## 10. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| Valkey を失う | 割り当ての検査を通す（fail open）。長い要求の同時実行は、タスクごとの数で近似する（タスクあたり 5）。DB の 1 分の集計で後から数える |
| 計測器の漏れ（データ層を通らない経路） | lint とアーキテクチャのテストで禁止する（ADR-0003）。最後の守りは `statement_timeout` と `idle_in_transaction_session_timeout`（ADR-0005） |
| 1 つの組織の仕事が 1 つの class を占める | `org_cap` と仮想時刻で抑える。他の組織の待ちが 15 分を超えたら警告 |
| `jobs` の表が大きくなる | 終わった行は 7 日で消す。待ちの行の数を計測する |
| 上限の登録簿と文書の表の食い違い | CI で落とす |
| 割り当ての誤った 429（窓の数え間違い） | DB の集計と Valkey の数を 1 時間ごとに比べ、5% 以上ずれたら警告 |

## 11. セキュリティ

- 上限のエラーの文言に、値・件数の見積もり・他の組織の情報を入れない（4.4 節）。
- `/limits` は、容量を `view_setup` の人にだけ返す（組織の大きさが分かるため）。
- 割り当ての数は組織ごとで、他の組織の使用量が見える経路を持たない。見出しの値も要求した組織のものだけ。
- 公平な順番の重みは、組織の管理者が変えられない。変えられるのは Ops の運用だけ（監査に残す）。
- `security:sensitive` の対象：計測器の差し込み口（抜け道を作らない）、割り当ての fail open の範囲。

## 12. テスト

- 上限の試験：4.1 節・6 節の全ての上限で、ちょうどで通り、1 つ超えたら巻き戻る・拒否する。ID ごとに試験の ID（`LIM-*`）を持ち、登録簿の `test` と結ぶ。CI で、試験のない上限を落とす。
- 上限の試験：`tx.flow_elements` を足並みで数えて 2,000 で通り 2,001 で巻き戻る。200 件の塊と 1 件で、同じフローの使用量が同じ。
- 上限の試験：積み上げ集計の子 5 万件の親の子を 1 件直す保存が、`tx.query_rows` を使わずに通る。5 万 1 件で `rollup_stale` になる。
- 上限の試験：一括の問い合わせで 100 万行を取り出せる（`tx.query_rows` に当たらない）。
- 性質ベーステスト：任意のトランザクションの操作の列（セーブポイントでの戻しを含む）で、計測器の数が、確定した操作の数と一致する。
- 性質ベーステスト：任意の組織の仕事の到着の列で、公平な順番の各組織の取り出しの割合が、重みの比から一定の幅に収まる（仮想時刻の性質）。
- 結合テスト：割り当ての 100%・110% の境目、`Retry-After`、fail open。長い要求 25 本の後の 429。
- 負荷試験（E12）：上限まで負荷をかけた組織があっても、他の組織の p95 の悪化が 10% 以内（NFR-003、K4）。
- 契約テスト：`<Brand>-Limit-Info`・`<Brand>-Tx-Usage` の形、`/limits` の JSON。

## 13. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0041](../decisions/0041-limits-registry-and-counting-rules.md) | 上限の正本を 1 つの登録簿とこの文書にし、数え方を決める。フローの要素は足並みの 1 歩で数え、積み上げ集計の集計し直しは取得の行に数えず子 5 万件で抑え、レポート・一括の問い合わせ・検索はトランザクションの外の予算で抑える。外向きの呼び出しとメールの上限を足す |
| [0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md) | 割り当ては 24 時間の移動の窓で数え、有料の本番だけ 110% まで超えられる。長い要求の同時実行は 25。Worker は仕事の種類ごとに組織の仮想時刻で公平に回し、DB の時間の重い組織の重みを下げる。上限の情報は `<Brand>-Limit-Info`・求めた時の `<Brand>-Tx-Usage`・`/limits` で返す |

他の領域への依頼：

- query-language-and-api の領域：4.5 節の「一括の問い合わせは非同期の上限の中で」を、「`bulk.query` の予算で」に直す。6.5 節に `<Brand>-Tx-Usage` を足す。
- automation-flows の領域：3.2 節の `call_webhook`・`send_email` に `tx.outbound_calls`・`tx.emails` を書く。
- 各領域：上限の表に「値は governor-limits.md を正とする」を書く（すでにあるものはそのまま）。

## 14. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：上限の登録簿と文書の表の一致、試験のない上限の検出 |
| E1 | 組織ごとの DB の時間の計測と 1 分の桶 |
| E3 | トランザクションの計測器（問い合わせ、行、DML、CPU の近似、メモリー、時間）と `LIMIT_EXCEEDED` |
| E3 | `<Brand>-Limit-Info`・`<Brand>-Tx-Usage`・`/api/v1/limits` |
| E3 | API の割り当て（24 時間の移動の窓、110%、fail open、80%・100% の知らせ） |
| E3 | 長い要求の同時実行（25） |
| E6 | フローの要素の足並みの数え方と、積み上げ集計の例外の計測 |
| E6 | `tx.outbound_calls`・`tx.emails` |
| E13 | `tx.code_*`・`code.*` の上限と計測 |
| E14 | 名前空間ごとの内訳（`tx_limit_peak_ratio{namespace}`、`<Brand>-Tx-Usage-Ns`） |
| E7 | レポートの予算を登録簿に載せ、`tx.*` から外す |
| E8 | イベントの発行・配信の割り当て |
| E9 | 一括の割り当てと `bulk.query` の予算、`jobs` の表と公平な順番（仮想時刻） |
| E9 | Worker の class ごとの `org_cap` と重み |
| E11 | Setup の「組織の上限」と「上限に近い自動化」 |
| E12 | 全ての上限の試験の網羅の確認、騒がしい隣人の負荷試験、値の見直し |

## 15. 未解決の問い

- 足並みの 1 歩で数える方法は、ADR-0005 の「フローの暴走を止める」意図に合うか。
- 積み上げ集計の例外は、DB の費用を抑えきれるか（子 5 万件の読みが 1 回の保存に入る）。
- 110% までの超過を許すか。許すなら何 % か。
- 割り当ての値（エディションごと）は、本家の価格の段と合うか（intent の「選定・計測で決めるもの」）。
- 画面の要求を API の割り当てに数えないことで、画面の API を連携に流用する抜け道にならないか。
- `<Brand>-Tx-Usage` を常に返すか。
- Worker の順番を Aurora の表で持つ方法が、S2 の仕事の量に耐えるか。

### 決定

2026-09-28 の既定案。

- 足並みの 1 歩で数える（ADR-0041）。1 つの実行の中の繰り返しは `tx.queries`・`tx.dml`・`tx.cpu_ms` で止まるので、暴走は止まる。
- 積み上げ集計は例外にし、子 5 万件で同期の集計し直しを止める。E12 で、5 万件の集計し直しの p99 を測り、1 秒を超えるなら 2 万件に下げる。
- 110% で始める。E12 と本番の最初の 3 か月の超過の頻度を見て見直す。
- 割り当ての値は 8.1 節の初期値で作り、E2 の着手前に PM が決める。
- 画面の要求は数えない。画面の API はセッションの Cookie でしか通らず、連携のトークン（OAuth）では通らないようにする（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 6 節）。
- `<Brand>-Tx-Usage` は求めた時だけ返す。
- `jobs` の表で始め、S2 の前に 1 秒あたりの取り出しの数を測る。1,000 件/秒を超える見込みなら、class ごとに Valkey の順番へ移す。

## 16. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：上限の計測の漏れ（データ層を通らない経路）で、1 つの組織が共有の DB を占める。lint、計測器の性質ベーステスト、上限の試験の網羅の CI。
- リスク：上限の値と数え方が領域ごとにずれる。登録簿と文書の一致の CI。
- リスク：騒がしい隣人。E12 の負荷試験（NFR-003、K4）を GA の判定の必須にする。
- 上限の試験：4.1 節・6 節の全て。
- 本番での検証：`tx_limit_peak_ratio` の分布、組織ごとの 429 の率、`worker_queue_age_seconds{class}`。

**runbooks**

- `org-allocation-exceeded`：組織が割り当ての 100%・110% に達した。使っている経路（連携のアプリ）を特定し、組織に案内する。一時的な引き上げは Ops の判断で行い、監査に残す。
- `noisy-neighbor-db-time`：ある組織の DB の時間がクラスタの 20% を超えた。重みの半分が効いているか、対話の経路の重い要求を調べる。
- `worker-queue-backlog`：class の待ちが 15 分を超えた。
- `limit-counter-drift`：Valkey と DB の数のずれが 5% を超えた。
- SLI の追加の依頼（Ops へ）：組織ごとの DB の時間の割合、429 の率（割り当て・同時実行）、`worker_queue_age_seconds{class}`、`tx_limit_peak_ratio{limit}` の p99、`LIMIT_EXCEEDED` の件数（上限ごと）。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `org_usage_minutes` | `org_id`、`alloc_id`、`minute`、`count` | RLS。25 時間より古い行を消す |
| `org_allocations` | `org_id`、`alloc_id`、`max`、`overage_pct`、`source`（`edition`・`override`） | 上書きは Ops だけ。監査に残す |
| `org_db_time_minutes` | `org_id`、`cluster_id`、`minute`、`db_ms`、`path`（`runtime`・`worker`・`reader`） | 7 日 |
| `jobs` | `org_id`、`class`、`id`、`state`、`available_at`、`cost_hint`、`attempts`、`payload_ref` | Worker の順番。終わった行は 7 日で消す |
| `org_vtime` | `class`、`org_id`、`vtime`、`weight`、`running` | RLS の外（運用） |
| `tx_limit_peaks` | `org_id`、`day`、`limit_id`、`where_kind`、`where_ref`、`max_ratio`、`count` | 「上限に近い自動化」の元。7 日 |

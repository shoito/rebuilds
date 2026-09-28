# API and integrations: ServiceNow

REST のテーブルの API（データ辞書から作る）、API のクライアントの認証、取り込み（取り込みの表と変換の対応）、CMDB の取り込みの API の形、Webhook とイベントの購読（署名付き）、テナントごとのレート制限、冪等性、ヘッダー（`<Brand>-` の形）を決める。

前提の決定は、レコードの読み書きを Record Service だけが行うこと（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)）、REST API・Webhook の出口では API のクライアントの主体で ACL を判定し、Webhook の本文には ID と変わったフィールドの ID だけを入れること（[access-control.md](access-control.md) の 6.2 節の 12 行）、フローの外への呼び出しは outbox から送り、冪等のキーを `<Brand>-Idempotency-Key` で送ること（[workflow-engine.md](workflow-engine.md) の 5.5 節）、CI の作成・更新は識別と調整の 1 つの入口だけを通すこと（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)、[ADR-0037](../decisions/0037-ci-ingest-entry-point-and-ambiguity-hold.md)）、本家の名前を識別子に使わないこと（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0048](../decisions/0048-dictionary-driven-table-api.md) | REST のテーブルの API は、実効の辞書から型と検証を作る 1 組のエンドポイントにする。絞り込みはリストと同じ式の言語、ページ送りはキーセット、更新は `If-Match`（行の版）、作成は `Idempotency-Key` で 1 回にする。OpenAPI はテナントの `meta_version` ごとに作る。連携のクライアントは OAuth 2.0 のクライアントクレデンシャルで認証し、主体は `integration` の利用者にする |
| [0049](../decisions/0049-import-sets-and-transform-maps.md) | 一括の取り込みは、取り込みの実行と行の表（原本の写し）に置いてから、版付きの変換の対応で 1 行ずつ Record Service を通して書く。一致のキー（coalesce）は索引のあるフィールドに限り、キーごとの助言ロックで並行の重複を防ぎ、2 つ以上に一致したら推測せずに行のエラーにする。CI を対象にする変換は CMDB の入口のペイロードを作る |
| [0050](../decisions/0050-signed-webhooks-and-tenant-rate-limits.md) | Webhook は薄い事象（ID・版・変わったフィールドの ID）を、Standard Webhooks に寄せた HMAC-SHA256 の署名（`<Brand>-Webhook-Signature`）で、少なくとも 1 回送る。送る時点で購読の主体の ACL で確かめる。レート制限はテナントとクライアントのトークンバケットで、要求の重みを付け、`<Brand>-RateLimit-*` と `Retry-After` を返す |

この文書の決定表・性質は設計の草案である。ID は E10・E11 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：テーブルの API、画面以外のクライアントの認証とトークン、問い合わせの言語、ページ送り、楽観的な排他、冪等性、エラーの形、API の版、OpenAPI、取り込み、CMDB の取り込みの API の外形、Webhook とイベントの購読、外への送信の SSRF の対策、レート制限。
- 扱わない：ACL の判定（[access-control.md](access-control.md)）、CI の識別と調整の中身（[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md)）、フローの `call_webhook` の実行の仕組み（[workflow-engine.md](workflow-engine.md) の 5.5 節。送信の部品と署名はこの文書と共有する）、メールの受信（[notifications-and-email-ingest.md](notifications-and-email-ingest.md)）、本家からの移行の道具（法務の L7 の確認待ち。[intent.md](../intent.md)）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| テーブルの API | テーブルのレコードの作成・読み取り・更新・削除の REST API。符号化した問い合わせの文字列で絞り、取得の件数の上限と開始の位置でページを送る。参照のフィールドに表示の値を付けるかを選べる | [Table API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html)（件数の上限の既定 10,000、開始の位置の既定 0、表示の値は `true`・`false`・`all`） |
| レート制限 | 1 時間あたりの受け付けの数の規則を、利用者・ロール・全員に置ける。利用者の規則がロールの規則に、ロールの規則が全員の規則に勝つ。応答に上限・戻る時刻・規則の ID のヘッダーを付け、超えたら 429 と `Retry-After`。ノードごとに数え、30 秒ごとに DB に書くので、効くまでに最大 30 秒かかる | [Inbound REST API rate limiting](https://www.servicenow.com/docs/bundle/zurich-api-reference/page/integrate/inbound-rest/concept/inbound-REST-API-rate-limiting.html) |
| 取り込み | 取り込みの表（import set）に置き、変換の対応（transform map）で対象の表に写す。一致のキー（coalesce）にしたフィールドが既存のレコードと一致すれば更新、なければ作成。複数のフィールドを一致のキーにすると、すべてが一致したときだけ更新 | [Import set coalesce](https://www.servicenow.com/docs/bundle/zurich-integrate-applications/page/administer/import-sets/concept/c_ImportSetCoalesce.html)（本文は取得できず、検索の結果の抜粋と解説の記事で確認。未検証で、本家の振る舞いで、設計の前提ではない） |
| 署名付き Webhook の形 | Standard Webhooks は、`webhook-id`・`webhook-timestamp`・`webhook-signature` のヘッダーと、`id.timestamp.本文` の HMAC-SHA256（`v1,` と Base64）を定める | [Standard Webhooks の仕様](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) |

- 本家の API のパス、問い合わせのパラメーターの名前、ヘッダーの名前は写さない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の API と互換にしない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。Standard Webhooks は公開の仕様で、形を寄せる（名前は `<Brand>-` にする）。

## 3. 認証と主体

### 3.1 クライアントの種類

| 種類 | 認証 | 主体 | 使いどころ |
| --- | --- | --- | --- |
| 連携のクライアント | OAuth 2.0 のクライアントクレデンシャル（`client_secret_basic`、または `private_key_jwt`） | クライアントに結んだ `kind = integration` の利用者（[access-control.md](access-control.md) の 3.4 節。ロールは直接のものだけ、`requester` を持たない） | 監視・資産管理・人事のシステム、CI/CD |
| 利用者の代わりのアプリ | 認可コード ＋ PKCE（テナントの SSO でログイン） | その利用者 | テナントが作る社内のツール |
| 画面 | Cookie のセッション（[access-control.md](access-control.md) の 9 節） | その利用者 | 作業の画面・ポータル |

- アクセストークンは不透明な値（接頭辞 `<brand>_at_`、1 時間）。DB にはハッシュだけを持つ。クライアントシークレットは `<brand>_cs_` の接頭辞を付け、作成の時に 1 回だけ見せる。接頭辞は GitHub のシークレットスキャンのパートナーに登録する（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- リフレッシュトークンは利用者の代わりのアプリだけに出し、使うたびに入れ替える（再利用を見つけたら系列を失効）。
- 長く有効な API キーは MVP で持たない。
- スコープ：`records:read`、`records:write`、`imports:write`、`cmdb:ingest`、`webhooks:manage`。**スコープは主体の ACL を広げない。** 許可は「スコープが許す操作」かつ「主体の ACL が許す操作」である。クライアントには、さらに使えるテーブルの許可の一覧を付けられる（既定は全テーブル）。
- クライアントの作成・シークレットの発行は `tenant_admin`、クライアントの利用者へのロールの付与は `acl_admin`（[access-control.md](access-control.md) の 3.3 節）。発行・失効は監査ログに残す。

### 3.2 要求のヘッダー

| ヘッダー | 向き | 意味 |
| --- | --- | --- |
| `Authorization: Bearer <brand>_at_...` | 要求 | アクセストークン |
| `<Brand>-Api-Version: YYYY-MM-DD` | 要求 | 振る舞いの版（4.8 節）。なければクライアントに固定した版 |
| `Idempotency-Key` | 要求 | 作成・取り込み・CMDB の取り込みの冪等（4.5 節） |
| `If-Match: "v<version>"` | 要求 | 更新・削除の楽観的な排他（4.4 節） |
| `<Brand>-Request-Id` | 応答 | 要求の ID（問い合わせのとき使う） |
| `ETag: "v<version>"` | 応答 | 行の版 |
| `<Brand>-RateLimit-Limit`・`-Remaining`・`-Reset`、`Retry-After` | 応答 | 7 節 |

## 4. テーブルの API（[ADR-0048](../decisions/0048-dictionary-driven-table-api.md)）

### 4.1 エンドポイント

```
GET    /api/v1/tables/{table}                    一覧
POST   /api/v1/tables/{table}                    作成
GET    /api/v1/tables/{table}/{id}               単体
GET    /api/v1/tables/{table}/by-number/{number} 番号で単体
PATCH  /api/v1/tables/{table}/{id}               更新（送ったフィールドだけ）
DELETE /api/v1/tables/{table}/{id}               削除
POST   /api/v1/tables/{table}/{id}/journal       作業メモ・コメントの追加
GET    /api/v1/tables/{table}/{id}/history       監査の履歴（読めるフィールドだけ）
GET    /api/v1/openapi.json                      このテナントの今の辞書の OpenAPI
```

- `{table}` は辞書の内部の名前（`incident`、`c_facilities_request` など）。親のクラスの名前で一覧を取ると、子のクラスのレコードも返る（`class` のフィールドで見分ける）。
- **型と検証は実効の辞書から作る。** App は `(tenant_id, meta_version)` ごとに、辞書から Zod のスキーマを組み立ててキャッシュする（[architecture/README.md](README.md) の 4 節）。テナントがフィールドを足すと、次の要求から API に出る。
- 状態の遷移、承認、変更のリスクの評価などの業務の操作は、テーブルの API の `PATCH` でも行える（状態のフィールドを変える）。遷移の表で照合する（[ADR-0022](../decisions/0022-process-state-machines.md)）。承認の回答は、承認のテーブルの `PATCH` で、成り代わり・本人の承認の禁止の規則を通す（[ADR-0016](../decisions/0016-approvals.md)）。専用の操作の API は作らない（持ち越し：使いにくければ足す）。
- 読めないレコードは 404、読めるが書けないときは 403（DT-ACL-001 の注）。

### 4.2 読み取りの形

```
GET /api/v1/tables/incident?q=active = true and priority <= 2
                           &fields=number,title,assignment_group,c_building
                           &display=true&limit=100&sort=-updated_at
→ 200
{
  "data": [
    { "id": "0192...", "class": "incident", "version": 7,
      "number": "INC0001234", "title": "...",
      "assignment_group": { "id": "0191...", "display": "サービスデスク" },
      "c_building": "本社 3F" }
  ],
  "next": "/api/v1/tables/incident?cursor=eyJ...",
  "count": { "value": 10000, "capped": true }      ← count=capped を指定したときだけ
}
```

- `q` はリストのフィルターと同じ式の言語（比較、`in`、`is empty`、論理の結合、1 段の参照のたどり、`now` の相対）。同じ構文解析器とコンパイラを使う。索引のない条件の制限もリストと同じ（422 `unindexed_filter`）。
- `fields` を省くと、読めるフィールドすべて（組み込み＋テナント）。読めないフィールドは、指定されてもキーごと返さない（エラーにしない。DT-ACL-003 の 1・12 行）。
- `display=true` で、参照のフィールドを `{id, display}` にする。表示の値は参照先の ACL を通す（6.2 節の 6 行）。読めなければ `{ "id": null, "display": null, "restricted": true }`（ID も出さない）。
- 読めない値での絞り込み・並べ替えは NULL の意味で処理する（[access-control.md](access-control.md) の 6.1 節）。
- **ページ送りはキーセットだけにする。** `limit` は既定 100、最大 1,000。`next` の `cursor` は、並べ替えのキーの値と `id` と問い合わせのハッシュを持つ不透明な値（署名付き。改ざんすると 400）。`offset` は受けない。
- `count=capped` で、10,001 行で打ち切った件数を返す（画面と同じ。[portal-and-ui.md](portal-and-ui.md) の 4.5 節）。
- 大きな一覧は、エクスポート（[reports.md](reports.md) の 11 節）か取り込みの反対の向き（持ち越し）を案内する。

### 4.3 書き込み

- `POST` と `PATCH` の本文は、フィールドの名前をキーにした JSON。値の形は読み取りと同じ（参照は ID の文字列、または `{id}`）。
- `PATCH` は、送ったフィールドだけを変える。送らないフィールドは変えない。
- 読み取り専用・書けないフィールドの扱いは DT-DICT-001・ACL と同じ（値が違えば 403、同じなら無視）。
- 保存の流れは Record Service の同じ流れ（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 5 節）。監査の履歴の `channel = api`、`actor_kind = integration`（連携のクライアント）か `user`。

### 4.4 楽観的な排他

- 応答の `ETag` は行の `version`。`PATCH`・`DELETE` に `If-Match` を付けると、版が違えば 412 にする。
- `If-Match` は任意にする。付けないときは、送ったフィールドだけを今の行に当てる（フィールドの単位の最後の書き込みが勝つ）。状態の遷移は、遷移の表の照合（今の状態から許されるか）で守られる。
- 連携のクライアント向けの文書で、状態を変える `PATCH` には `If-Match` を勧める。

### 4.5 冪等性

- `POST`（作成、作業メモの追加、取り込み、CMDB の取り込み）は `Idempotency-Key` を受ける。
- `(tenant_id, client_id, key)` を 24 時間一意にし、最初の要求の本文のハッシュと応答（状態のコード、本文の先頭 64 KB、作ったレコードの ID）を持つ。
- 同じキー・同じ本文の送り直しは、最初の応答を返す（`<Brand>-Idempotent-Replayed: true`）。同じキー・違う本文は 422 `idempotency_key_reused`。最初の要求が処理中なら 409 `idempotency_in_progress`。
- キーの行は、作成のトランザクションと同じトランザクションで書く（作成がコミットされたら、キーの行も必ずある）。
- 番号は保存と別のトランザクションで取るので、送り直しで欠番が出る（[ADR-0008](../decisions/0008-record-numbering.md)）。

### 4.6 エラー

- エラーは RFC 9457 の `application/problem+json` にする。`type` は本システムの URL（`https://<brand>.<domain>/problems/<code>`）、`code` は機械の読める値（`invalid_transition`、`field_read_only`、`mandatory`、`record_changed`、`unindexed_filter`、`rate_limited` など）、`errors` にフィールドごとの詳細。
- 詳細に、読めないフィールドの名前や値を入れない。ACL の拒否の理由（規則の ID）は本番では返さない（[access-control.md](access-control.md) の 5 節）。

### 4.7 OpenAPI

- `/api/v1/openapi.json` は、今のテナントの実効の辞書から作る（`meta_version` ごとにキャッシュ）。見られるのは `records:read` のクライアントと管理者。**クライアントの主体で読めるテーブル・フィールドだけを載せる**（辞書の構造も、読めない部分は見せない）。
- 本システムの基盤の部分（認証、エラー、ページ送り）の OpenAPI は、`@hono/zod-openapi` で作り、公開の文書にする（[architecture/README.md](README.md) の 4 節）。

### 4.8 API の版

- パスの版（`/api/v1`）は、互換を壊す大きな変更のときだけ上げる。
- 振る舞いの細かな変更は、日付の版（`<Brand>-Api-Version`）で出す。クライアントは作成の時の版に固定され、管理者が版を上げる。古い版は、次の版を出してから 12 か月は動かす。
- **テナントの辞書の変更は API の版ではない。** フィールドの追加は、すべてのクライアントにすぐに出る（追加は互換を壊さない）。フィールドの削除（2 段の削除。[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 6 節）は、非表示の時点で API から消える。30 日の猶予の間に連携を直す。管理者に、非表示にするフィールドを使っているクライアント（直近 30 日の要求の `fields` と本文に出たもの）を示す。

## 5. 取り込み（[ADR-0049](../decisions/0049-import-sets-and-transform-maps.md)）

### 5.1 流れ

```
1. 取り込みの実行を作る：POST /api/v1/imports { source: "<import_source の名前>", run_key }
   （画面の CSV のアップロードも同じ）
2. 行を置く：CSV のファイル（S3 の署名付き URL へアップロード）か、JSON の行のまとまり（1 回 1,000 行）
   → Ingest が解析し、import_row に原本の写しとして置く（まだ対象の表を変えない）
3. 変換：Engine の bulk_job が、変換の対応の版で 1 行ずつ処理する
   1 行 = 1 トランザクション：一致のキーのロック → 一致の検索 → Record Service の保存（channel = import）
4. 結果：行ごとの状態（inserted / updated / skipped / error と理由）、実行の集計
```

- 取り込みの表に原本を先に置くのは、変換の対応を直して同じ原本でやり直せるように、また行ごとの結果を原本と並べて見せるためである。
- 利用者・グループ・グループの所属（主体の表）の取り込みは、1,000 行ずつのトランザクションにまとめ、まとまりごとに `acl_version` を 1 回だけ上げる（[access-control.md](access-control.md) の 7 節）。

### 5.2 表

| 表 | 中身 |
| --- | --- |
| `import_source` | 名前、形式（`csv` / `json`）、文字コード（`auto` / `utf-8` / `shift_jis`）、既定の変換の対応。メタデータ |
| `transform_map`（版付き。版は `transform_map_version`） | 対象のテーブル、フィールドの対応（対象のフィールド ← 式。式は原本の列を読む）、一致のキー、一致のとき（`update` / `skip`）、一致しないとき（`insert` / `skip`）、選択肢の値の対応の表、`run_as`（実行の主体）、空の値の扱い（`ignore` / `clear`）。メタデータ、公開で不変の版 |
| `import_run` | 取り込み元、変換の対応の版、`run_key`（7 日一意）、状態（`loading` / `ready` / `transforming` / `completed` / `failed` / `cancelled`）、件数、開始・終わり |
| `import_row` | `run_id`、`row_no`、`raw`（JSONB。原本の 1 行）、`lane`（一致のキーのハッシュの区画）、状態、`target_id`、`error_code`、`error_detail` |

- 実行は、開始したときの変換の対応の版に固定する（フローの版と同じ考え。[ADR-0014](../decisions/0014-flow-dsl-and-versioning.md)）。
- `import_row` は 30 日で消す（原本の写しに個人の情報が入りうる。[security.md](security.md) の 7 節）。

### 5.3 一致のキー（coalesce）

- **一致のキーは、索引のあるフィールドに限る**（型付きの列の索引、`ext_index`、一意の索引のあるもの）。変換の対応の公開の時に確かめ、なければ公開させない。索引のないキーでの一致は、テナントの全行の走査になるためである。
- 複数のフィールドを一致のキーにすると、すべてが等しい行を探す（本家と同じ意味）。
- **並行の重複を防ぐ。** 行のトランザクションの始めに、`pg_advisory_xact_lock(hash(tenant_id, map_id, 一致のキーの正規化した値))` を取る。同じキーの 2 行（同じファイルの中、または並行の 2 つの実行）が同時に「一致なし → 作成」に進まない。
- 同じ実行の中の同じキーの行は、`lane`（キーのハッシュの区画）ごとに `row_no` の順に 1 行ずつ処理する。後の行が前の行の作ったレコードを更新する。結果はファイルの順で決まる（決定的）。区画の間は並行に処理する。

DT-IMP-001（1 行の変換）：

| # | 一致のキーの値 | 一致した行の数 | 一致のとき・しないときの設定 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 空（どれか 1 つでも） | - | - | `error`（`empty_coalesce_key`）。空の値で作らない |
| 2 | ある | 2 以上 | - | `error`（`ambiguous_coalesce`）。推測で選ばない |
| 3 | ある | 1 | `update` | Record Service の更新（`If-Match` なし。変えたフィールドだけ） |
| 4 | ある | 1 | `skip` | `skipped` |
| 5 | ある | 0 | `insert` | Record Service の作成 |
| 6 | ある | 0 | `skip` | `skipped` |
| 7 | - | - | 保存が ACL・検証・遷移で失敗 | `error`（Record Service のエラーのコード） |
| 8 | - | - | - | `error`（網羅の確かめ） |

- 2 行を推測で片付けないのは、CMDB と同じ考え（あいまいなら止める。[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）である。本家の振る舞いは未検証（本家の振る舞いで、設計の前提ではない）。
- 一致の検索は、`run_as` の主体の ACL で読める行だけを対象にする。読めない行と一致して「一致なし → 作成」になると、重複を作る。これを防ぐため、**一致の検索だけは `run_as` の主体の ACL で行い、見つからなかったときは、ACL を外した件数の確かめ（存在するかだけ）を行い、存在すれば `error`（`coalesce_target_not_readable`）にする**。存在の有無だけを行のエラーに残し、値は返さない（取り込みの実行者は、その主体の権限の外の行があることを知る。変換の対応の `run_as` を決めた管理者の責任の範囲とする）。

### 5.4 変換の式と文字コード

- 対応の式は式の言語（[ADR-0001](../decisions/0001-platform-and-stack.md)）で、原本の列を読む。副作用を持たない。文字列の関数（切り出し、置き換え、全角・半角の揃え）、日付の解釈（書式を指定。和暦は持たない）、選択肢の値の対応の表の引き。
- CSV の文字コードは、`auto` のとき、UTF-8（BOM があれば UTF-8）→ 厳格な UTF-8 → Shift_JIS（WHATWG の `shift_jis` の復号器）の順に試し、置き換えの文字が出ない最初のものを使う（メールの復号の DT-MAIL-005 と同じ考え）。どれも失敗なら、実行を `failed`（`undecodable`）にする。置き換えを許して取り込まない（CSV の値は記録の値で、化けたまま保存しない）。
- 上限：1 ファイル 100 MB、50 万行、1 行 64 KB。1 テナントの同時の変換の実行 2。
- 行のエラーは実行を止めない。最初の 1,000 行でエラーが 50% を超えたら、実行を止める（`failed`、`error_rate`）。変換の対応の誤りで大量の誤った書き込みをしないためである。

### 5.5 CMDB への取り込み

- **CI のクラスのテーブルを対象にした変換の対応は作れない**（公開の時に拒否する）。CI は識別と調整の入口だけが書く（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）。
- 代わりに、変換の対応の対象を `cmdb_payload` にする。変換は行ごとに CMDB の取り込みのペイロードの項目（クラス、`native_key`、`observed_at`、属性、関係）を作り、取り込み元（`csv`）の名前で入口へ送る（[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 5.2 節）。項目の結果（新規・一致・保留・エラー）を `import_row` に写す。
- CMDB の取り込みの API は `POST /api/v1/cmdb/ingest`（`cmdb:ingest` のスコープ、`Idempotency-Key` と `batch_key`）にする。ペイロードの中身と上限は cmdb-and-reconciliation の 5.2 節が正本である。

## 6. Webhook とイベントの購読（[ADR-0050](../decisions/0050-signed-webhooks-and-tenant-rate-limits.md)）

### 6.1 購読

| 列 | 意味 |
| --- | --- |
| `id`、`name`、`owner_principal`（購読を作った連携のクライアントの利用者、または利用者） | 送る時点の ACL の判定に使う主体 |
| `url` | `https:` だけ。ホストはテナントの許可の一覧（`webhook_allowlist`。フローと共有）に入っていること |
| `events` | `record.created`、`record.updated`、`record.deleted`、`sla.warning`、`sla.breached`、`approval.requested`、`approval.decided`、`ci.held`、`import.completed` |
| `tables` | 対象のテーブル（子のクラスを含む） |
| `condition` | 式の言語。**送る時点の今の値に、購読の主体の `visible(f)` を当てて評価する** |
| `secrets` | 署名の秘密（最大 2 つ。入れ替えのため）。KMS で暗号化（[security.md](security.md) の 5 節） |
| `state` | `active` / `paused` / `disabled`（失敗が続いた） |

- 作成は `webhooks:manage` のスコープか `tenant_admin`。1 テナント 100 購読まで。

### 6.2 本文

```
POST <url>
<Brand>-Webhook-Id: whd_0192...          ← 配達の ID（送り直しでも同じ）
<Brand>-Webhook-Timestamp: 1790000000    ← 署名の時刻（UNIX 秒）
<Brand>-Webhook-Signature: v1,<base64>   ← 秘密が 2 つなら空白で区切って 2 つ
Content-Type: application/json

{
  "id": "whd_0192...",
  "type": "record.updated",
  "occurred_at": "2026-09-28T00:00:00Z",
  "subscription_id": "...",
  "table": "incident",
  "record": { "id": "0192...", "number": "INC0001234", "version": 8 },
  "changed_fields": ["state", "assigned_to"]      ← フィールドの名前。値は入れない
}
```

- **値を入れない（薄い事象）。** 受け手は、自分の主体で API を呼んで値を読む（DT-ACL-003 の 12 行）。本文にレコードの値を入れると、送る時点と受け手が読む時点で権限が違うときに漏れる。受け手の主体と購読の主体の ACL の違いも生まない。
- `number` は入れる。受け手の画面の表示と、担当者との会話に要る。番号の読み取りの権限（行の `read`）は、送る前に確かめる（6.4 節）。
- `changed_fields` は、購読の主体が読めるフィールドの名前だけ（読めないフィールドの変更は、変わったことも知らせない。監査の履歴の画面と同じ。[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 7.4 節）。読めるフィールドが 1 つも変わっていなければ、`record.updated` を送らない。

### 6.3 署名

- 署名の対象は `id + "." + timestamp + "." + 本文`（本文はバイト列のまま）。HMAC-SHA256 を Base64 にし、`v1,` を付ける（Standard Webhooks の形。名前は `<Brand>-`）。
- 秘密は 32 バイトの乱数で、`<brand>_whsec_` の接頭辞を付け、作成の時に 1 回だけ見せる。
- 入れ替え：新しい秘密を足すと、入れ替えの期間（既定 24 時間）は 2 つの署名を並べて送る。受け手はどちらかが合えば受ける。期間の後に古い秘密を消す。
- 受け手の検証の手引き：署名の時刻が今から 5 分より離れていれば捨てる。`id` で重複を捨てる。本システムは検証の見本（TypeScript・Python・Java）を公開する。
- フローの `call_webhook`（[workflow-engine.md](workflow-engine.md) の 5.5 節）も、同じ送信の部品で署名する。フローの本文は管理者が作るので、値が入りうる。フローの本文に入れた値の ACL は、フローの実行の主体と受け手の主体で確かめる（同じ文書の 5.4 節）。

### 6.4 配達

```
outbox（record.changed、sla.*、approval.*、ci.held、import.completed）
  → Relay → SQS → Notifier：
     1. 事象に合う購読を選ぶ（テーブル、種類）
     2. 購読ごとに、送る時点の購読の主体で decide(read)。読めなければ配達を作らない（suppressed、no_read_access）
     3. condition を今の値（visible(f)）で評価
     4. webhook_delivery を作る（一意：event_id, subscription_id）→ 配達の ID
     5. 送る（egress の NAT。SSRF の検査）→ 2xx で delivered
```

- **少なくとも 1 回。順序は約束しない。** 受け手は `record.version` で古い事象を見分ける（`occurred_at` より確か）。
- 再試行：失敗（2xx 以外、5 秒のタイムアウト、接続の失敗）で、10 秒・1 分・10 分・1 時間・以後 3 時間ごと、24 時間まで。4xx（408・429 を除く）は再試行しない。429 は `Retry-After` に従う。
- 1 つの購読で失敗が 72 時間続いたら、購読を `disabled` にし、テナントの管理者に知らせる。溜まった配達は 7 日保ち、再開の時に送り直せる（画面と API）。
- 同時に送る数：1 購読 5、1 テナント 50。1 つの遅い受け手が、他の購読を待たせない。
- 送信の先の検査（SSRF）：名前解決の後の IP が、プライベート・ループバック・リンクローカル・メタデータのアドレスなら送らない。リダイレクトを追わない。egress の NAT の固定の IP から送る（テナントが受け手の許可の一覧に入れられる。[infrastructure.md](infrastructure.md) の 2 節）。

## 7. レート制限（[ADR-0050](../decisions/0050-signed-webhooks-and-tenant-rate-limits.md)）

### 7.1 規則

| 単位 | 既定（S1。E11・E12 の計測で見直す） | 超えたとき |
| --- | --- | --- |
| テナント（本番）の API の全体 | 1 秒 100 の重み、ためられる上限 1,000 | 429 `rate_limited`（`reason = tenant`） |
| テナント（サブプロダクション） | 1 秒 20、上限 200 | 同上 |
| 連携のクライアント | 1 秒 50、上限 500（テナントの中の取り分） | 429（`reason = client`） |
| 画面のセッション（利用者） | 1 秒 20、上限 100 | 429（`reason = user`） |
| 重い要求の同時の実行（テナント） | エクスポート 2、取り込みの変換 2、`count=capped` の一覧 10 | 429（`reason = concurrency`） |
| セルの全体（守り） | App のタスクごとの同時の要求 200 | 503（容量の都合。429 にしない） |

- 要求の重み：単体の読み取り 1、一覧 2（`count=capped` なら 5）、書き込み 3、取り込みの行のまとまり 10、CMDB の取り込み 1 項目あたり 0.1。
- **テナントの上限は契約で変えられる**（大口は上げる）。上限の値は制御の面の台帳に持ち、セルに配る。
- 容量・依存先の都合（DB のフェイルオーバー、過負荷）では 429 を返さず 503 にする。429 は「この利用者が使いすぎ」の意味だけにする（Auth0 の [observability.md](../../../auth0/docs/architecture/observability.md) の 3.2 節の分け方に倣う）。

### 7.2 実装

- トークンバケットを Valkey に置く（テナント・クライアント・利用者のキー。1 回の要求で Lua の 1 回の往復）。
- **Valkey が落ちたら、App のタスクのメモリーの近似のバケット（上限をタスクの数で割った値）で続ける。** 正確さは落ちるが、制限を外さない。
- 応答のヘッダー：`<Brand>-RateLimit-Limit`（1 秒の重み）、`<Brand>-RateLimit-Remaining`、`<Brand>-RateLimit-Reset`（満ちるまでの秒）、429 のときは `Retry-After`。
- 本家は 1 時間の窓で数え、効くまでに最大 30 秒かかる（2 節）。本システムは秒の単位のバケットにする（連携の一斉の再試行の山を早く抑えるため）。

### 7.3 WAF

- エッジの WAF で、IP ごとのレート制限（5 分に 30,000）と共通のルールを置く（[infrastructure.md](infrastructure.md) の 4 節）。テナントの単位の制限はアプリで行う（WAF はテナントを知らない）。

## 8. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Aurora の writer のフェイルオーバー | 書き込みは 503 と `Retry-After`。冪等のキーで送り直せる |
| Valkey が落ちる | レート制限は近似のバケット。冪等のキーは DB に持つので影響しない |
| Webhook の受け手の障害 | 6.4 節の再試行と無効化 |
| 取り込みの変換の途中の停止 | `bulk_job` は `import_row` の状態から続きを処理する（行ごとのトランザクション。済んだ行はやり直さない） |
| SQS の滞留 | Webhook の配達が遅れる。事象は失われない（outbox から作り直せる） |

## 9. セキュリティ

- スコープは ACL を広げない（3.1 節）。連携のクライアントの主体も、同じ ACL で判定する。
- トークン・秘密はハッシュか暗号文で持ち、接頭辞で漏えいを検知できるようにする（3.1・6.3 節）。
- Webhook は薄い事象で、署名付き。送信の先は許可の一覧と IP の検査で SSRF を防ぐ（6 節）。
- 一覧の `cursor` は署名付きで、別のテナント・別の問い合わせに使えない（4.2 節）。
- OpenAPI は主体の読めるテーブル・フィールドだけを載せる（4.7 節）。
- 取り込みの原本は 30 日で消す。取り込みで読めない一致の行があれば、存在だけをエラーにする（5.3 節）。
- CSV の式の注入の対策はエクスポートの側で行う（[reports.md](reports.md) の 11 節）。取り込みの値はそのまま保存し、画面ではエスケープして描く。

## 10. テスト

### 10.1 決定表

- DT-IMP-001（1 行の変換）を、`spec.md` から読む表駆動テストにする。
- DT-API-001（冪等のキーの判定：新規・同じ本文の送り直し・違う本文・処理中）と DT-WH-001（配達の判定：読めない・条件に合わない・読めるフィールドの変更がない・送る）も同じ。

### 10.2 性質ベーステスト

- **PROP-API-001（冪等）**：任意の作成の要求と送り直しの列（並行を含む）で、同じキー・同じ本文ならレコードはちょうど 1 つ、応答は同じ。
- **PROP-API-002（API は画面より広くない）**：任意の主体・テーブルで、API の一覧・単体で返る値の集合は、同じ主体の画面のモデルの値の集合と等しい。
- **PROP-IMP-001（並行でも重複しない）**：任意の取り込みの行の集合と、任意の並行の 2 つの実行で、一致のキーが同じ行から作られるレコードは高々 1 つ。
- **PROP-IMP-002（決定性）**：同じ原本と同じ変換の対応の版で、区画の処理の順をどう変えても、最終の対象の行は同じ。
- **PROP-WH-001（署名の往復）**：任意の本文・時刻・秘密の組で、送る側の署名を受け手の見本の検証が受け、1 バイトでも変えた本文を拒む。
- **PROP-WH-002（配達は漏らさない）**：任意の ACL と事象の列で、配達の本文に、購読の主体が送る時点で読めないフィールドの名前が出ない。

### 10.3 結合テスト

- 漏れの試験の REST API・Webhook の出口（[access-control.md](access-control.md) の 12.3 節）。
- SSRF の試験：許可の一覧のホストの名前が、プライベートの IP・メタデータのアドレスに解決される場合に送らない。
- レート制限：Valkey を止めたときの近似のバケット。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `api-clients-and-oauth` | 3 節のクライアント、クライアントクレデンシャル、認可コード＋PKCE、トークン、スコープ |
| E11 | `table-api-dictionary-driven` | 4.1〜4.3 節（data-dictionary-and-tables と一緒に）、PROP-API-002 |
| E11 | `api-query-language-and-cursor` | 4.2 節の `q`・`cursor`・`count=capped` |
| E11 | `api-idempotency-and-etag` | 4.4・4.5 節、DT-API-001（PROP-API-001） |
| E11 | `api-problem-details-and-versions` | 4.6・4.8 節 |
| E11 | `tenant-openapi` | 4.7 節 |
| E11 | `import-runs-and-transform-maps` | 5.1〜5.4 節、DT-IMP-001（PROP-IMP-001・002） |
| E10 | `cmdb-ingest-api` | 5.5 節、`POST /api/v1/cmdb/ingest`（cmdb-and-reconciliation と一緒に） |
| E11 | `webhook-subscriptions-and-delivery` | 6.1・6.2・6.4 節、DT-WH-001（PROP-WH-002） |
| E11 | `webhook-signing-and-rotation` | 6.3 節、検証の見本（PROP-WH-001） |
| E11 | `tenant-rate-limits` | 7 節 |
| E3 | `hr-import-principals` | 利用者・部署・グループの取り込み（5.1 節の主体の表の扱い。L1 の確認待ち） |
| E12 | `api-load-and-abuse-test` | API のピーク（S1 2,000 件/秒）とレート制限の負荷試験 |

## 12. 未解決の問い

### 決定（2026-09-28、既定案）

- **テーブルの API は 1 組のエンドポイントで、辞書から型を作る**（4.1 節、ADR-0048）。
- **ページ送りはキーセットだけ。`offset` を受けない**（4.2 節）。
- **`If-Match` は任意、作成の `Idempotency-Key` は 24 時間**（4.4・4.5 節）。
- **テナントの辞書の変更は API の版にしない**（4.8 節）。
- **取り込みの一致のキーは索引のあるフィールドに限り、あいまいなら行のエラー**（5.3 節、ADR-0049）。
- **CI を直接対象にする変換を作らせない**（5.5 節）。
- **Webhook の本文に値を入れない**（6.2 節、ADR-0050）。
- **署名は Standard Webhooks の形、名前は `<Brand>-`**（6.3 節）。
- **容量の都合は 503、使いすぎは 429**（7.1 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 承認の回答・状態の遷移の専用の操作の API | E11 の連携の実例を見て |
| 長く有効な API キー | 顧客の要望を見て。まずはクライアントクレデンシャルで足りるかを確かめる |
| 大量の読み出し（取り込みの反対の向き、差分の取り出し） | E11 の後 |
| mTLS のクライアントの認証 | 大口の顧客の要望を見て |
| 本家からの移行の道具（本家の API からの読み出し） | 法務の L7 の後 |
| レート制限の既定の値と、契約の段の値 | E11・E12 の計測と PM の料金の設計 |
| Webhook の事象の種類の追加（変更の予定、CAB の決定） | 各 Epic で |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- API の p99（単体・一覧・書き込み）と 5xx の割合。
- 429 の件数（理由別・テナント別）。
- 冪等のキーの送り直しの割合と、`idempotency_key_reused` の件数。
- 取り込みの行の結果の内訳と、`ambiguous_coalesce`・`coalesce_target_not_readable` の件数。
- Webhook の配達の遅れ（事象から 2xx まで）の p50・p99、失敗の割合、無効になった購読の数。
- 漏れの試験の REST API・Webhook の出口の結果：漏れ 0 件（K6）。

### runbooks

- `api-rate-limit-storm.md`：429 の急増の確かめ方（1 テナント・1 クライアントの再試行の山）と、一時の上限の変更。
- `webhook-delivery-backlog.md`：配達の滞留・無効になった購読の確かめ方と、送り直し。
- `import-run-stuck-or-failed.md`：取り込みの変換の停止・失敗の調べ方と、変換の対応の直しとやり直し。
- `leaked-api-credential.md`：シークレットスキャンの通知・漏えいの疑いのときのクライアントシークレット・トークン・Webhook の秘密の失効。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `api_client`、`api_client_secret`（ハッシュ）、`oauth_token`（ハッシュ）、`oauth_refresh_family` | 3.1 節 |
| Aurora `idempotency_key` | 4.5 節。`(tenant_id, client_id, key)` 一意、24 時間 |
| Aurora `import_source`、`transform_map`、`transform_map_version`（不変の版） | 5.2 節。メタデータ |
| Aurora `import_run`、`import_row` | 5.2 節。`(tenant_id, source_id, run_key)` 7 日一意。`import_row` は 30 日 |
| Aurora `webhook_subscription`、`webhook_secret`（KMS で暗号化） | 6.1 節 |
| Aurora `webhook_delivery` | 6.4 節。`(tenant_id, event_id, subscription_id)` 一意、7 日 |
| Aurora `webhook_allowlist` | 6.1 節。フローと共有（workflow-engine の表） |
| Valkey レート制限のバケット | 7.2 節。失われてもよい |
| 制御の面 テナントのレート制限の段 | 7.1 節 |
| S3 取り込みの原本のファイル（30 日） | 5.1 節 |

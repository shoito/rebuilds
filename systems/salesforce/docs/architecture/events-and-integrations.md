# Events and integrations: Salesforce

変更のイベント（オブジェクトごとの変更の流れ、順序、3 日の再生、購読の権限）、組織が定義するイベント（発行と購読）、Webhook（署名 `<Brand>-Signature`、再送、止めと再開）、外向きの呼び出し（フローの `call_webhook`、宛先の登録、SSRF の守り）、メールの送信の設計。土台は [ADR-0008](../decisions/0008-dml-order-of-execution.md)（保存の手順 11 で outbox に書き、手順 13 で送る）、[ADR-0025](../decisions/0025-flow-definition-and-bulk-engine.md)（`call_webhook`・`publish_event`・`send_email` は outbox に書くだけ）、NFR-010（確定から購読者まで p95 5 秒、少なくとも 1 回、レコードごとの順序、3 日の再生）。この文書で決めたことは、次の 3 つの ADR にある。

- 変更のイベントは、outbox から Relay が、イベントの専用の Aurora のクラスタの日ごとの分割の表に書く。組織ごとに確定の順に増える `replay_id` を、論理シャードの唯一の書き手が付ける。保持は 3 日で、購読者は `replay_id` から再生できる。読みは SSE の流れと、取り出しの API の 2 つ（[ADR-0033](../decisions/0033-change-event-log-and-replay.md)）。
- 変更のイベントの購読は、そのオブジェクトの `view_all`（全てのオブジェクトなら `view_all_data`）を要し、レコードの単位の共有では絞らない。項目は配信の時に購読者の FLS で落とす。組織が定義するイベントは、イベントの型の `read`（購読）と `create`（発行）の権限で守り、既定で確定の後に発行する（[ADR-0034](../decisions/0034-event-subscription-access-and-org-events.md)）。
- Webhook は、同じイベントのログの上の「宛先ごとのカーソル」で押し出す購読にする。本文に `<Brand>-Signature` を付け、宛先の検査（SSRF の守り）を通した専用の送信の網（本番と別の prod-egress のアカウント、固定の IP）から送る。本番からは SQS で受け渡す。フローの外向きの呼び出しも、登録した宛先だけに、同じ送信の網から、応答を待たずに送る（[ADR-0035](../decisions/0035-webhooks-outbound-calls-and-ssrf-guard.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。本家のイベントの基盤・Pub/Sub API・CometD との互換は持たない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 変更のイベントの形、ログ、順序、再生、チャンネル、購読の API | 保存の手順と outbox に書く時点（[metadata-and-runtime.md](metadata-and-runtime.md) の 6 節） |
| 変更のイベントの購読の権限、FLS | 共有の判定の本体（[sharing-and-record-access.md](sharing-and-record-access.md)） |
| 組織が定義するイベントの型、発行、購読、保持 | フローの要素の定義と解釈器（[automation-flows.md](automation-flows.md)） |
| Webhook の宛先、署名、配信、再送、止めと再開 | 外向きの網の構成の詳細（infrastructure の領域） |
| 外向きの呼び出しの宛先、認証の秘密、送信 | 秘密の鍵の階層（security の領域） |
| メールの送信（1 通ずつ、フローの `send_email`、通知）の送信事業者と送信の網 | メールの記録（BCC）と送信の画面（[sales-objects.md](sales-objects.md) の 8 節） |
| 割り当て（発行・配信）の使い方 | 割り当ての値の正本（[governor-limits.md](governor-limits.md)） |

## 2. 本家の仕組み（確かめたこと）

主な出典は [Change Data Capture Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_change_data_capture.pdf)（Winter '27 版、以下「CDC」）と [Platform Events Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/platform_events.pdf)（Winter '27 版、以下「PE」）。

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 保持 | 変更のイベントはイベントバスに最大 3 日。購読者は過去のイベントを取り直せる | CDC |
| 共有 | 変更のイベントは共有の設定を無視し、オブジェクトの全てのレコードのイベントを送る | CDC の「Required Permissions for Change Event Subscribers」 |
| 購読の権限 | 1 つのオブジェクトは、そのオブジェクトの「すべて参照」。利用者は「すべての利用者の参照」。「すべて参照」のない標準オブジェクト（ToDo・行動）と、チャンネルの全てのオブジェクトは「すべてのデータの参照」。権限は配信の時に確かめ、購読の後の変更は Pub/Sub API で 10 分以内に効く | 同上 |
| FLS | 購読者が読めない項目は、イベントに入れない | 同上 |
| 見出し | `entityName`、`recordIds`、`changeType`、`changedFields`、`transactionKey`（トランザクションの ID）、`sequenceNumber`（トランザクションの中の順）、`commitTimestamp`、`commitNumber`、`commitUser` | CDC |
| 選べるオブジェクト | 既定で 5 つまで。追加のライセンスで増やせる | CDC |
| 隙間のイベント | イベントを作れない時（DB の層での変更、1MB を超える、内部のエラー、一部の型の変換）は、値のない隙間のイベント（`GAP_*`）を送る。受け手はレコードを読み直す | CDC の「Gap Events」 |
| あふれのイベント | 1 つのトランザクションの 10 万の変更を超えた分は、オブジェクトごとに 1 つの `GAP_OVERFLOW` にまとめる | CDC の「Overflow Events」 |
| 監査に向かない | 記録と項目の変更の監査に使うことは勧めない | CDC |
| 組織が定義するイベント | 高い量のイベントは 72 時間保持。`ReplayId` で位置を持ち、連続を保証しない。一意の識別は `EventUuid` | PE |
| 発行の時点 | 「すぐに発行」（既定。トランザクションに結ばない）と「確定の後に発行」 | PE |
| 割り当て | 発行は 1 時間 250,000（Enterprise・Unlimited）。配信は 24 時間 50,000（Unlimited）・25,000（Enterprise）で、変更のイベントと共有。移動の窓。フローや Apex の購読は配信に数えない。定義は Enterprise で 50 | PE の「Platform Event Allocations」 |
| 1 件の大きさ | 1MB | PE |
| Webhook の本文の署名 | 本家のアウトバウンドメッセージ・Webhook の署名の方式は確かめられなかった（未検証） | — |

## 3. 変更のイベント（ADR-0033）

### 3.1 形

```json
{
  "replay_id": "000000000001a2b3",
  "event_id": "0192f0c1-...",
  "schema": "change.v1",
  "header": {
    "object": "opportunity",
    "record_ids": ["0192..."],
    "change_type": "UPDATE",
    "changed_fields": ["stage", "amount", "x_region"],
    "tx_key": "0192...",
    "tx_seq": 3,
    "commit_ts": "2026-09-28T01:02:03.456Z",
    "commit_user": "0192...",
    "origin": { "kind": "api", "client_id": "<brand>_app_..." },
    "record_version": 8,
    "metadata_version": 1043
  },
  "fields": { "stage": "negotiation", "amount": "1200000", "x_region": "kanto" }
}
```

| `change_type` | `fields` の中身 |
| --- | --- |
| `CREATE` | 空でない全ての項目 |
| `UPDATE` | 変わった項目の新しい値（空になった項目は `null`） |
| `DELETE` | なし（ごみ箱へ） |
| `UNDELETE` | 空でない全ての項目 |
| `GAP_CREATE`・`GAP_UPDATE`・`GAP_DELETE`・`GAP_UNDELETE` | なし。受け手はレコードを読み直す |

- 見出しは本家の CDC の見出しに寄せる（2 節）。名前は本システムのもの。
- 1 レコード 1 件にする（本家のように同じ変更の複数のレコードをまとめない）。受け手の処理と、FLS の絞りと、配信の数え方を単純にするため。`record_ids` は、隙間のイベントで複数のレコードをまとめる時だけ複数になる。
- 項目は API の名前で返す。名前は配信の時のメタデータの版で解決する（`field_no` は変わらないので、名前が変わっても同じ項目を指す）。配信の時に消えている項目は落とす。
- 数と通貨は文字列、日付は ISO 8601（[ADR-0020](../decisions/0020-rest-api-shape-and-versioning.md) と同じ）。
- 数式の項目は入れない（保存しないため）。積み上げ集計は入れる（親の保存で親の `UPDATE` になる）。
- 長いテキストは 32KB まで入れ、超えたら `header.truncated_fields` に名前を入れ、値を落とす。1 件は 256KB まで。超えたら `GAP_UPDATE` にする。
- `origin` は、変更の出どころ（画面、API のクライアント、フロー、一括のジョブ、承認）。受け手が、自分の書いた変更を無視できる（本家の見出しと同じ目的。CDC）。

### 3.2 生成

```
保存の手順 11（最上位で 1 回、変わった全てのレコード）
  outbox に change_event（org, object, record_id, op, row_version, 変わった field_no と新しい値, tx_key, tx_seq）
  │ 確定（手順 12）
  ▼
Relay（論理シャードごとに 1 つの書き手。advisory lock を持つ Worker のタスク）
  1. その論理シャードの未送の outbox の行を id の順に 1,000 件読む
  2. 組織ごとに replay_id を採番し、events の Aurora に INSERT（1 トランザクション）
  3. 同じトランザクションで event_heads(org, max_replay_id) を進める
  4. outbox の行を送った印にする（主の Aurora。2 の後に行う。二重に送った時は event_id で重複を捨てる）
  5. 購読者への通知（Valkey の Pub/Sub）
  ▼
events（イベントの専用の Aurora のクラスタ、日ごとの分割）
  ├─▶ SSE・取り出しの API（3.4 節）
  └─▶ Webhook の送り手（5 節）
```

- **`replay_id` は、組織の中で確定の順に単調に増える。** 論理シャードごとに書き手は 1 つで、組織は 1 つの論理シャードに属するため（[ADR-0010](../decisions/0010-record-tables-partitioning-and-pivots.md)）。形は `commit_ms`（48 ビット）｜シャードの中の連番（16 ビット）の 16 進 16 文字。Auth0 の再構築のログの `log_id` と同じ考え方（[auth0 の ADR-0042](../../../auth0/docs/decisions/0042-log-event-model-and-type-codes.md)）。
- **レコードごとの順序が守られる理由**：同じレコードの 2 つの保存は、行ロック（手順 1 の `FOR UPDATE`）で順番になる。後の保存の outbox の行は、前の保存の確定の後に入れられるので、`id` が大きく、Relay が前の行と同じか後の読みで見る。Relay は `id` の順に送るので、後の変更が前の変更より小さい `replay_id` を持つことはない。`record_version`（`row_version`）でも確かめられる。
- **トランザクションの境目**：同じ `tx_key` のイベントは、`tx_seq` の順に並び、連続した `replay_id` を持つ（Relay は 1 つのトランザクションの行を分けずに送る）。
- 隙間のイベント：型の変換（[metadata-and-runtime.md](metadata-and-runtime.md) の 5 節）、整合の検査での直し、消去、組織の移動の中のデータの直しは、保存の手順を通らない。これらの仕事は、変えたレコードの ID を 200 件ずつ `GAP_UPDATE` として outbox に書く。
- あふれ：1 つのトランザクションの DML の行は 1 万まで（[governor-limits.md](governor-limits.md)）なので、本家の 10 万のあふれは起きない。あふれのイベントは持たない。
- 変更のイベントは、対象のオブジェクト（3.3 節）の変更だけを outbox に書く。対象でないオブジェクトは書かない（outbox の量を抑える）。ただし、Webhook と組織の検索の索引と統計は別の outbox の種類で扱う。

### 3.3 チャンネルと対象のオブジェクト

| チャンネル | 中身 |
| --- | --- |
| `/changes/<object>` | 1 つのオブジェクトの変更 |
| `/changes/all` | 組織が対象にした全てのオブジェクト |
| `/changes/custom/<name>` | 組織が作るチャンネル。対象のオブジェクトの部分集合と、項目の条件（数式の分類 A）で絞る |

- 管理者は Setup で、変更のイベントの対象のオブジェクトを選ぶ（`cdc_enabled_objects`）。数はエディションの割り当て `alloc.cdc_objects`（[governor-limits.md](governor-limits.md) の 8.1 節。Enterprise 20）。本家の既定は 5（CDC）。
- カスタムのチャンネルの条件で絞ったイベントは、配信の割り当てに数えない（本家も絞った後の数で数える。CDC）。

### 3.4 購読の API

```
GET /api/v1/events/changes/opportunity/stream        （SSE。Last-Event-ID に replay_id）
  → event: change
    id: 000000000001a2b3
    data: {...}

GET /api/v1/events/changes/opportunity?after=<replay_id>&limit=1000   （取り出し）
  → { "events": [...], "next": "<replay_id>", "has_more": true, "oldest_available": "<replay_id>" }
```

- 開始の位置は、`after=<replay_id>`、`from=earliest`（保持の最も古い）、`from=latest`（今から）、`from_time=<ISO 8601>`（3 日の中）。
- 保持の外の `replay_id` を指定したら 410 `REPLAY_ID_EXPIRED` と `oldest_available` を返す。受け手は全件の同期（一括の問い合わせ）からやり直す。
- SSE は 1 本の接続を 1 時間で切り、受け手は `Last-Event-ID` で続ける。組織の同時の接続は `conc.event_streams`（Enterprise 100）。
- gRPC の購読（本家の Pub/Sub API に相当）は MVP で持たない。
- 読みは `events` のクラスタの reader で行う。1 回の読みで最大 1,000 件・1MB。

### 3.5 保存と保持

- `events` は、主の Aurora と別のクラスタに置く。変更のイベントの読み（購読者の追いつき、再生）が、レコードの保存の DB に及ばないようにする。README の持ち越し（「変更のイベントの再生の置き場所：Aurora の分割の表、Kinesis Data Streams など」）をここで決める（ADR-0033）。
- 表：`change_events(org_id, replay_id, object_id, record_id, change_type, tx_key, tx_seq, body)`。日ごとの分割（取り込みの日）。主キー `(org_id, replay_id)`、索引 `(org_id, object_id, replay_id)`。RLS をかける。
- **保持は 3 日**（NFR-010。本家も 3 日。CDC）。4 日目の分割を `DROP` する。組織の保持を延ばす選択は持たない（3 日を超える同期の遅れは、一括の問い合わせで取り直す）。
- 量の見積もり（S1）：保存の行の平均 500 行/秒（ピーク 2,000）、1 件 1KB で、1 日 4,300 万件・43GB、3 日で約 130GB。
- 本文は KMS の暗号化の Aurora に置く。組織の削除で、その組織の行を消す（分割の `DROP` を待たずに `DELETE`）。

## 4. 購読の権限と組織が定義するイベント（ADR-0034）

### 4.1 変更のイベントの購読の権限

**DT-EVT-001：変更のイベントの購読**（上から評価。購読の時と、配信の時の両方で評価する）

| # | `api_enabled` | チャンネル | 購読者の権限 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | なし | - | - | 403 `API_DISABLED` |
| 2 | あり | `/changes/<object>`（活動・メール以外） | そのオブジェクトの `view_all`、または `view_all_data` | 購読できる |
| 3 | あり | `/changes/task`・`/changes/event`・`/changes/email_message` | `view_all_data` | 購読できる |
| 4 | あり | `/changes/user` | `view_all_users` | 購読できる |
| 5 | あり | `/changes/all`・カスタムのチャンネル | 含む全てのオブジェクトに 2〜4 の権限 | 購読できる |
| 6 | あり | - | それ以外 | 403 `INSUFFICIENT_ACCESS` |

- **レコードの単位の共有では絞らない。** 購読できるのは、そのオブジェクトの全てのレコードを読める人だけにする（本家と同じ。CDC）。
  - 共有で 1 件ずつ絞ると、配信のたびに購読者ごとの共有の判定が要る。共有の変更で「見えるようになった」「見えなくなった」レコードの扱い（作成・削除として送るか）も決まらない。
  - `view_all` を要すれば、intent の「見られないレコードは変更のイベントの購読に現れない」を、判定なしで満たす。[sharing-and-record-access.md](sharing-and-record-access.md) の 6.4 節の「配信の時の購読者の権限で、レコードの水準と FLS を判定する」は、この表で具体にする（レコードの水準は `view_all` で常に読める）。
- **権限は配信の時にも確かめる。** 購読者の権限の形を 60 秒だけキャッシュし、権限を失ったら、次の配信の前に接続を 403 で閉じる（本家は Pub/Sub API で 10 分以内。CDC）。
- **FLS**：配信の時に、購読者の権限の形で読めない項目を `fields` から落とし、`changed_fields` からも名前を落とす（読めない項目が変わったことも知らせない）。積み上げ集計は [ADR-0027](../decisions/0027-roll-up-summaries-incremental-with-reconciliation.md) の FLS（集計する子の項目も読める時だけ）。項目がすべて落ちた `UPDATE` は送らない（配信の数に数えない）。
- 連携の利用者（`integration` のライセンス。[orgs-users-and-auth.md](orgs-users-and-auth.md) の 5 節）に、必要なオブジェクトの `view_all` だけを持つ権限セットを割り当てる使い方を文書で勧める。

### 4.2 組織が定義するイベント

```yaml
# イベントの型（メタデータ。版を上げる）
api_name: x_order_shipped
label: 出荷の知らせ
publish_behavior: after_commit      # after_commit（既定）| immediate
fields:
  - { api_name: order_no,   type: text, length: 40, required: true }
  - { api_name: shipped_at, type: datetime }
  - { api_name: amount,     type: currency, scale: 0 }
```

- イベントの型は `md_event_types`・`md_event_fields` に持つ。項目の型は `text`・`number`・`currency`・`percent`・`date`・`datetime`・`checkbox`・`id`（参照の ID の文字列。参照の関係は持たない）。
- **発行**：
  - フローの `publish_event`（保存の後・非同期・予定・スケジュール・画面）。
  - `POST /api/v1/events/types/x_order_shipped`（1 回 200 件まで、1 件 64KB まで。`event_id` を返す）。
- **発行の時点**：
  - `after_commit`（既定）：発行はトランザクションの outbox に書き、確定の後に Relay が `events` に書く。巻き戻ったら発行しない。
  - `immediate`：API からの発行は要求の中ですぐ `events` に書く。フローの中の `immediate` の発行は、巻き戻っても残る（ログや失敗の知らせに使う）。本家の既定は「すぐに発行」（PE）だが、本システムは、保存と食い違うイベントを既定で出さないよう `after_commit` を既定にする。
- `replay_id` と保持（3 日）と取り出しの API は、変更のイベントと同じ（`/api/v1/events/types/<type>/stream`）。
- **購読**：
  - API の購読者（SSE・取り出し）と Webhook（5 節）。
  - **イベントで起動するフロー**（`event_triggered`）：Worker がイベントを 200 件ずつ読み、1 つの非同期のトランザクションで足並みの実行にする（[ADR-0025](../decisions/0025-flow-definition-and-bulk-engine.md)）。フローの種類の追加を automation-flows の領域に依頼する（11 節）。フローの購読者は、購読者ごとのカーソル（`event_subscriber_cursors`）で続きから読む。
- **権限**：イベントの型は、オブジェクトと同じく権限セットでの `read`（購読）と `create`（発行）を持つ（[sharing-and-record-access.md](sharing-and-record-access.md) の 3.2 節の「オブジェクト」の権限を使う）。項目の FLS は持たない（型ごとの権限だけ）。
- **漏れの経路**：`system` の文脈のフロー（[automation-flows.md](automation-flows.md) の 3.3 節）は、利用者が読めない項目の値をイベントの項目に写せる。イベントの購読者はレコードの共有にも FLS にも縛られない。そのため、フローの有効化の時に、`publish_event` の項目に写すレコードの項目の一覧を管理者に見せて警告する。イベントの型の `read` の権限は、写す値を読んでよい人にだけ与えるよう文書に書く。

### 4.3 割り当て

| 割り当て | 値（Enterprise） | 数え方 |
| --- | --- | --- |
| `alloc.events_published` | 1 時間 25 万 | 組織が定義するイベントの発行の件数。変更のイベントは数えない |
| `alloc.events_delivered` | 24 時間 50 万 | API の購読者（SSE・取り出し）と Webhook に届けた件数。購読者ごとに足す。フローの購読者は数えない（本家と同じ。PE） |
| `alloc.cdc_objects` | 20 | 変更のイベントの対象のオブジェクト |
| `tx.events_published` | 1 トランザクション 150 | 発行の呼び出しの回数（[governor-limits.md](governor-limits.md) の 4.1 節） |

- 配信の割り当てを超えたら、SSE を 429 で閉じ、取り出しは 429 と `Retry-After`、Webhook は `paused_quota` にして送らない（ログは 3 日残るので、窓が空けば続きから送る）。

## 5. Webhook（ADR-0035）

### 5.1 登録

```
webhook_endpoints(org_id, id, name, url, status, sources[], run_as_user_id,
                  secret_enc, secret_prev_enc, secret_prev_expires_at,
                  cursor_replay_id, first_failure_at, last_success_at, created_by)
```

| 項目 | 規則 |
| --- | --- |
| `sources` | 変更のイベントのチャンネル（`/changes/<object>`・カスタムのチャンネル）と、組織が定義するイベントの型 |
| `run_as_user_id` | 配信の権限を決める利用者（連携の利用者）。DT-EVT-001 と FLS を、この利用者で評価する。管理者本人を既定にしない |
| URL | `https://` だけ、ポートは 443 だけ。IP のリテラル・`localhost`・本システムのドメインを拒否する。登録の時と、送る時の両方で宛先を検査する（6.2 節） |
| 秘密 | 32 バイトの乱数、`<brand>_whsec_` で始まる（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。作成と入れ替えの時に 1 回だけ見せる。KMS のエンベロープ暗号化で持ち、読みの API は返さない |
| 本数 | 組織 20（`webhook.endpoints`） |
| 権限 | 作成・変更は `manage_integrations`（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 7 節）。監査に残し、組織の管理者全員にメールで知らせる |

### 5.2 配信

```
webhook-sender（Worker、class delivery）
  1. 宛先のリース（DB の行ロック、30 秒）を取る。1 つの宛先は同時に 1 つの送り手
  2. events から sources に合う replay_id > cursor を最大 100 件（1MB）読む
  3. run_as_user の権限で DT-EVT-001 と FLS をかける（落ちたイベントは送らず、カーソルは進める）
  4. 本文を作って署名し、送信の網（6.3 節）へ渡す
  5. 2xx でカーソルを最後の replay_id に進める。それ以外は進めず、再試行を予定する
```

```
POST <url>
Content-Type: application/json
<Brand>-Signature: t=1790000000,v1=5257a869e7ec...
<Brand>-Delivery-Id: 0192f0c1-...
<Brand>-Webhook-Id: 0192...

{ "delivery_id": "0192f0c1-...", "events": [ {…3.1 節の形…}, … ] }
```

- **署名**：`v1 = hex(HMAC-SHA256(秘密, "{t}.{本文}"))`。Stripe の再構築の形と同じにする（[stripe の ADR-0025](../../../stripe/docs/decisions/0025-webhook-signing-and-isolated-delivery.md)）。受け手は、`t` が 5 分以内であることと、`v1` を定数時間で比べることを確かめる。秘密の入れ替えでは、古い秘密を最大 24 時間残し、その間は `v1=` を 2 つ並べる。再試行のたびに `t` と署名を作り直す。
- **少なくとも 1 回**。受け手は `event_id` で重複を捨てる。順序は宛先ごとの `replay_id` の順で送るので、レコードごとの順序も守られる（1 つの宛先の送り手は 1 つ）。
- **再試行**：同じまとまりを 1 秒・5 秒・30 秒で 3 回。その後は 1 分・5 分・15 分・1 時間ごと。宛先の 410 は、すぐに `disabled`。
- **止める**：最初の失敗から 72 時間成功しなければ `disabled` にし、組織の管理者に知らせる。ログの保持（3 日）を過ぎると続きから送れないため。再開の時にカーソルが保持の外なら、残る最も古いイベントから再開し、「欠け」を知らせる（`gap_notified`）。
- 1 つの不正なイベントで宛先の全体が止まるのを避けるため、同じまとまりへの 4xx が 24 時間続いたら、1 件ずつに分けて送り、それでも拒否される 1 件を飛ばして記録する（Auth0 の再構築の ADR-0044 と同じ）。
- 配信は `alloc.events_delivered` に数える（件数）。
- 配信の記録（`webhook_deliveries`）は、まとまりごとに 1 行（状態、HTTP の状態、所要時間、最初と最後の `replay_id`）を 7 日持つ。本文は持たない。Setup で直近の 100 件を見られる。

### 5.3 手動の再送

- 管理者は、宛先のカーソルを 3 日の中の任意の `replay_id` か時刻に戻せる（`manage_integrations`、監査に残す）。

## 6. 外向きの呼び出しと送信の網（ADR-0035）

### 6.1 外向きの呼び出し（`call_webhook`）

```
outbound_endpoints(org_id, id, api_name, base_url, auth_kind, auth_secret_enc, headers, timeout_ms, status)
  auth_kind: none | bearer | basic | hmac（<Brand>-Signature と同じ形）
```

- フローの `call_webhook` 要素（[automation-flows.md](automation-flows.md) の 3.2 節）は、宛先を `outbound_endpoints.api_name` で指し、パス（登録した `base_url` の下）と JSON の本文をフローの式で作る。**任意の URL をフローの式で作らせない。**
- 実行の中では outbox に書くだけにし、確定の後に送る（手順 13）。巻き戻れば送らない。応答を待たない（ADR-0025）。
- 送信の結果は `outbound_call_log`（状態、時間。本文なし。7 日）に残す。再試行は 1 秒・10 秒・1 分・10 分・1 時間の 5 回。冪等のために `<Brand>-Delivery-Id` を付ける。
- 1 トランザクション 100 件（`tx.outbound_calls`。[governor-limits.md](governor-limits.md) の 4.1 節）。
- 認証の秘密は、Webhook の秘密と同じく KMS のエンベロープ暗号化で持ち、読みの API は返さない。Sandbox へは複製しない（[sandboxes-and-deploy.md](sandboxes-and-deploy.md) の 4.4 節）。

### 6.2 宛先の検査（SSRF の守り）

| 検査 | 規則 |
| --- | --- |
| 形 | `https://` だけ。ポート 443 だけ。利用者名・パスワードを URL に含めない。IP のリテラルは拒否 |
| 名前解決 | 送る時に解決し、得た全てのアドレスを検査する。検査したアドレスに直接つなぐ（TLS の SNI とホスト名の検証は元の名前で）。DNS の再バインドで検査の後に別のアドレスへ行かせない |
| 拒否するアドレス | ループバック、プライベート（RFC 1918、ULA）、リンクローカル（169.254.0.0/16。IMDS を含む）、CGNAT（100.64.0.0/10）、マルチキャスト、予約、`0.0.0.0/8`、本システムの VPC とサービスのアドレス、IPv4 に写した IPv6 |
| リダイレクト | 追わない（3xx は失敗として扱う） |
| 時間 | 接続 3 秒、全体 10 秒（宛先の設定で 30 秒まで） |
| 応答 | 状態だけを使い、本文は最初の 64KB だけ読んで捨てる |
| 証明書 | 公開の CA の検証を必須にする。自己署名は不可 |

### 6.3 送信の網

- Webhook・外向きの呼び出しは、**本番と別の AWS アカウント（prod-egress）の送信の VPC** の送り手（`sender`）から送る（2026-09-28。infrastructure の領域の依頼、[ADR-0054](../decisions/0054-accounts-network-and-service-separation.md)、ADR-0035 の注記）。prod-egress の VPC は、本番の VPC・DB・VPC エンドポイントへの経路（ピアリング、Transit Gateway）を持たず、外へは Elastic IP 付きの NAT だけで出る。Stripe の再構築の ADR-0025 の送信の網を、アカウントの境界で強めた形にする。
- **受け渡しは SQS。** 本番の Worker（webhook-sender、class `delivery`）が署名を付け、署名済みの要求（宛先、見出し、本文、`<Brand>-Delivery-Id`）を prod-egress のアカウントの SQS に入れる。本番の Worker のロールには、そのキューへの `SendMessage` だけを許す。送り手は SQS から取り出し、宛先の検査（6.2 節）をしてから送り、結果（状態、HTTP の状態、時間）を別の SQS で本番へ戻す。本番の Worker が結果でカーソルを進め、再試行を予定する。
- 署名は本番の Worker で行う。送り手は秘密を持たず、本番の DB も読めない。
- メールは SES の API（本番の VPC エンドポイント）で渡すので、この経路を通らない。
- NAT の Elastic IP を送信元の IP として公開し、組織が受け手のファイアウォールで許せるようにする。変える時は 30 日前に知らせる。
- 宛先が海外にある時（名前解決の結果の国）、Setup に「海外の宛先」と出す。**法務の L2・L4 の結論が出るまで、E8 の Webhook の spec を承認しない**（intent）。

## 7. メールの送信

- 送るもの：1 通ずつのメール（[sales-objects.md](sales-objects.md) の 8.2 節）、フローの `send_email`、承認の通知、レポートの定期の配信、システムの通知（パスワードの再設定、割り当ての知らせ）。
- 送信は確定の後に outbox から、Amazon SES（東京）で送る。組織は送信のドメインを登録し、DKIM・SPF を確かめる（`email_sender_domains`）。確かめるまでは、本システムのドメイン（`noreply@mail.<brand>.<domain>`）から「〜の代わりに」で送る。
- 戻ってきたメール（bounce）と苦情（complaint）を SES の通知で受け、宛先を `email_suppressions` に入れて以後送らない。取引先責任者・リードの `email_opt_out` は送信の前に確かめる（sales-objects の 8.2 節）。
- 1 通ずつのメールの割り当ては `alloc.emails_single`（[governor-limits.md](governor-limits.md) の 8.1 節）。1 トランザクション 10 回（`tx.emails`）。
- Sandbox は、システムの通知を除き、外へ送らない（[sandboxes-and-deploy.md](sandboxes-and-deploy.md) の 4.4 節）。
- 本文の開封の計測は持たない（法務の L4。sales-objects の 8.2 節）。

## 8. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| Relay が止まる | outbox に残る。書き手のロックを他のタスクが取り、続きから送る。遅れの p95 が 30 秒を超えたら警告 |
| Relay が `events` に書いた後、outbox の印の前に落ちる | 同じ行をもう一度送る。`event_id`（outbox の行の ID から作る）の一意の制約で 2 回目を捨てる |
| `events` のクラスタの障害 | Relay は outbox に残して待つ。保存は止めない（outbox は主の Aurora）。購読者は 503 で待つ |
| 購読者が 3 日より長く止まる | 410 `REPLAY_ID_EXPIRED`。一括の問い合わせで取り直す |
| 購読者の権限が外れる | 60 秒以内に 403 で閉じる |
| Webhook の宛先が落ちている | 再試行、72 時間で `disabled`、管理者に知らせる |
| 1 つの宛先が遅い | 宛先ごとの送り手なので、他の宛先を待たせない。送信の網の同時の送信は組織 20（`org_cap`） |
| 宛先の検査で拒否 | 送らず、`blocked_destination` として記録し、管理者に知らせる。セキュリティの計測（`ssrf_blocked_total`）に数える |
| SES の送信の拒否・割り当て | outbox に残して再試行。1 時間を超えたら警告 |
| 配信の割り当ての超過 | 4.3 節 |

## 9. セキュリティ

- 変更のイベントは `view_all` の人にだけ届け、FLS を配信の時にかける（4.1 節）。組織が定義するイベントは型の権限で守り、`system` のフローの写しを警告する（4.2 節）。
- Webhook は、登録した利用者の権限で配信を決める。管理者の広い権限で全ての項目を外へ出さない。
- 本文の署名、秘密の暗号化、読みの API で秘密を返さない、入れ替えの重なり（5.2 節）。
- 宛先の検査と、本番への経路のない prod-egress のアカウントの送信の網（6.2 節・6.3 節）。本番から prod-egress へは SQS の `SendMessage` だけ。
- Webhook・外向きの呼び出しの宛先の作成・変更は、監査に残し、組織の管理者全員に知らせる（乗っ取られた管理者が宛先を変えて全てのデータを外へ出すことを警戒する）。
- `events` のクラスタは RLS をかけ、組織の ID は購読のトークンから決める（ADR-0005）。
- `security:sensitive` の対象：DT-EVT-001、配信の FLS、Webhook の `run_as`、署名、宛先の検査、送信の網。

## 10. テスト

- 決定表：`DT-EVT-001` を表駆動テストにする。
- 性質ベーステスト（fast-check）：
  - `PROP-EVT-001`（草案）：任意の保存の列（並行、巻き戻り、部分の成功を含む）で、確定した保存ごとにちょうど 1 つのイベント（`event_id` で重複を捨てた後）があり、同じレコードのイベントの `replay_id` の順が確定の順（`record_version` の順）と一致する。巻き戻った保存のイベントはない。
  - `PROP-EVT-002`（草案）：任意の購読者の権限の形で、配信したイベントの `fields` と `changed_fields` に、読めない項目がない。
  - 任意の送信の失敗の列（時間切れ、5xx、送り手の交代）で、宛先が受け取った `event_id` の集合が、`sources` に合うイベントの集合を含む（Webhook の少なくとも 1 回）。
  - `after_commit` の組織のイベントは、巻き戻ったトランザクションから出ない。
- 結合テスト：3 日を過ぎた `replay_id` が 410。SSE の `Last-Event-ID` での続き。権限を外して 60 秒以内に閉じる。
- 結合テスト：署名の検証（正しい秘密、入れ替え中の 2 つ、改ざん、古い `t`）。
- SSRF のテスト：6.2 節の拒否するアドレス、内部を指すリダイレクト、DNS の再バインド、IPv4 に写した IPv6。
- 上限の試験：`tx.events_published` 150、`tx.outbound_calls` 100、`events.publish_batch` 200、配信・発行の割り当て。
- 合成監視：本システムの受け口の Webhook で、確定から届くまで p95 5 秒（NFR-010）と、取りこぼしの日次の突き合わせ。

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0033](../decisions/0033-change-event-log-and-replay.md) | 変更のイベントは outbox から Relay がイベントの専用の Aurora の日ごとの分割の表に書き、論理シャードの唯一の書き手が組織の中で確定の順に増える `replay_id` を付ける。保持は 3 日。SSE と取り出しの API で再生する |
| [0034](../decisions/0034-event-subscription-access-and-org-events.md) | 変更のイベントの購読はオブジェクトの `view_all` を要し、共有で絞らず、FLS を配信の時にかける。組織が定義するイベントは型の権限で守り、既定で確定の後に発行する |
| [0035](../decisions/0035-webhooks-outbound-calls-and-ssrf-guard.md) | Webhook はイベントのログの上の宛先ごとのカーソルで送り、`<Brand>-Signature` で署名する。外向きの呼び出しは登録した宛先だけ。どちらも宛先の検査を通し、内部に経路のない送信の網から送る |

他の領域への依頼：

- automation-flows の領域：フローの種類に `event_triggered`（組織が定義するイベントで起動）を足す。`call_webhook` の宛先を `outbound_endpoints.api_name` で指すことを 3.2 節に書く。（2026-09-28 に反映済み：automation-flows.md の 3.2・3.4 節）
- sharing-and-record-access の領域：システムの権限に `view_all_users`・`manage_integrations` を足す（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 7 節）。6.4 節の「変更のイベント」の行を DT-EVT-001 に合わせる。（2026-09-28 に反映済み）
- data-storage の領域：outbox の種類（`change_event`・`org_event`・`search_index`・`delivery`）と、Relay の論理シャードごとの書き手。
- query-language-and-api の領域：`/api/v1/events/...` を REST の一覧に足す。

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | `events` の Aurora のクラスタ、SES |
| E8 | prod-egress のアカウント（送信の VPC、NAT、Elastic IP、経路なし）と SQS の受け渡し |
| E1 | CI：`DT-EVT-001` の表駆動テストと `PROP-EVT-*` の枠。SSRF のテストの組 |
| E3 | outbox の `change_event` の行（手順 11）と Relay（論理シャードごとの書き手、`replay_id`、重複の除き） |
| E8 | 対象のオブジェクトの選択、チャンネル（オブジェクト・全て・カスタム） |
| E8 | 取り出しの API と SSE、開始の位置、410、保持の 3 日の分割の `DROP` |
| E8 | DT-EVT-001 と配信の FLS、権限の 60 秒の確かめ |
| E8 | 隙間のイベント（型の変換・整合の検査・消去） |
| E8 | 組織が定義するイベントの型、発行の API、`after_commit`・`immediate` |
| E8 | Webhook の宛先の登録、署名、宛先ごとのカーソルの配信、再試行、`disabled`、再送 |
| E8 | 外向きの呼び出しの宛先と、`call_webhook` の送信 |
| E8 | 宛先の検査と、送信の網での送信 |
| E8 | 割り当て（発行・配信・対象のオブジェクト） |
| E5 | メールの送信（SES、送信のドメインの確認、bounce と苦情） |
| E6 | `event_triggered` のフローと、フローの購読者のカーソル |
| E11 | Webhook・外向きの呼び出しの宛先の変更の監査と、管理者への知らせ |
| E12 | NFR-010 の計測（確定から p95 5 秒）、1 日 4,300 万件の負荷試験 |

## 13. 未解決の問い

- 変更のイベントをレコードの単位の共有で絞る需要（`view_all` を持てない連携）に、どう応えるか。
- 1 レコード 1 件のイベントで、一括の取り込みの時の量（配信の割り当て）が足りるか。
- 組織が定義するイベントの既定を `after_commit` にするのは、本家から移る組織を困らせないか（本家の既定は「すぐに発行」）。
- 保持を 3 日より延ばす選択を持つか。
- gRPC の購読を持つか。
- 海外の Webhook の宛先の扱い（法務の L2・L4）。

### 決定

2026-09-28 の既定案。

- 共有で絞る購読は持たない。連携の利用者に `view_all` を与える運用を勧める。要望が多ければ、「見える範囲の変化を `DELETE`・`CREATE` として送る」購読を別の ADR で検討する。
- 1 レコード 1 件で作り、E12 で一括の取り込み 100 万件のイベントの量を測る。配信の割り当てが足りなければ、カスタムのチャンネルの条件での絞りを案内する。
- `after_commit` を既定にする。移行の文書に本家との違いを書く。
- 保持は 3 日だけ（NFR-010）。
- gRPC は MVP の後。SSE と取り出しで始める。
- 海外の宛先は Setup で知らせ、法務の結論が出るまで E8 の spec を承認しない。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：変更のイベント・Webhook を通した、見えないデータ・読めない項目の漏れ。DT-EVT-001、`PROP-EVT-002`、経路ごとの否定側のテスト。
- リスク：イベントの取りこぼし・順の乱れ・巻き戻った保存のイベント。`PROP-EVT-001` と障害の注入（Relay の停止、二重の送信）。
- リスク：SSRF。宛先の検査のテストの組を CI の必須にし、外部のペンテスト（E12）で確かめる。
- 本番での検証：確定から届くまでの p95（NFR-010）、Webhook の取りこぼしの日次の突き合わせ、`ssrf_blocked_total`。

**runbooks**

- `event-relay-lag`：Relay の遅れの p95 が 30 秒を超えた。
- `events-cluster-degraded`：`events` のクラスタの障害。outbox の滞留を見る。
- `webhook-endpoint-disabled`：宛先が 72 時間の失敗で止まった組織への案内と、再開の手順。
- `outbound-ssrf-blocked-spike`：宛先の検査の拒否が急に増えた（攻撃の試み、または設定の誤り）。
- `egress-ip-change`：送信元の IP を変える時の 30 日前の知らせの手順。
- `ses-bounce-rate-high`：bounce の率が上がった組織の送信を止める判断。
- SLI の追加の依頼（Ops へ）：確定から `events` までの遅れ、購読者への配信の遅れ、Webhook の成功率と遅れ、`disabled` の宛先の数、`ssrf_blocked_total`、SES の bounce と苦情の率。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `outbox`（種類の追加） | `org_id`、`shard_no`、`id`、`kind`（`change_event`・`org_event`・`search_index`・`delivery`・`email`）、`payload`、`relayed_at` | 主の Aurora。分割、RLS |
| `change_events`・`org_events` | `org_id`、`replay_id`、`event_id`、`object_id`・`type_id`、`record_id`、`change_type`、`tx_key`、`tx_seq`、`body` | `events` のクラスタ。日ごとの分割、3 日、RLS |
| `event_heads` | `org_id`、`max_replay_id` | 購読者への通知 |
| `cdc_enabled_objects` | `org_id`、`object_id` | メタデータ |
| `event_channels` | `org_id`、`name`、`objects`、`filter` | メタデータ |
| `md_event_types`、`md_event_fields` | `org_id`、`type_id`、`api_name`、`publish_behavior`、`field_id`、`type` | メタデータ |
| `event_subscriber_cursors` | `org_id`、`subscriber_kind`（`flow`）、`subscriber_id`、`source`、`replay_id` | |
| `webhook_endpoints` | 5.1 節 | 秘密は暗号化 |
| `webhook_deliveries` | `org_id`、`endpoint_id`、`delivery_id`、`first_replay_id`、`last_replay_id`、`status`、`http_status`、`duration_ms`、`attempt`、`at` | 7 日 |
| `outbound_endpoints`、`outbound_call_log` | 6.1 節 | 秘密は暗号化。ログは 7 日 |
| `email_sender_domains`、`email_suppressions` | `org_id`、`domain`、`dkim_state`、`address_hash`、`reason` | |

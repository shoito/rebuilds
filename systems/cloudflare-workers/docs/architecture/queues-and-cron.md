# Queues and Cron: Cloudflare Workers

少なくとも 1 回の配信のキュー（本家の Queues に相当するもの）と、cron の式による定期の起動（本家の Cron Triggers に相当するもの）の設計。配信の保証、バッチ、再試行、デッドレターのキュー、消費者の並行の数、保存の方式、分散のスケジューラーを決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0004](../decisions/0004-config-and-code-distribution.md) | キューとトリガーの設定は、変更のログで配る |
| [ADR-0005](../decisions/0005-storage-consistency.md) | キューは少なくとも 1 回。確定したメッセージは失わない。再試行の上限を超えたらデッドレターのキューへ |
| [ADR-0009](../decisions/0009-cpu-and-memory-metering.md) | CPU 時間の強制。キュー・cron の 1 回の上限は runtime-and-isolates の 6.1 節の表 |
| [ADR-0033](../decisions/0033-queues-on-sqs-with-own-dispatcher.md) | S1 のキューの保存は SQS の標準のキュー。配送は自前のディスパッチャー。Durable Objects の上の自作は S2 で見直す |
| [ADR-0034](../decisions/0034-cron-sharded-scheduler.md) | cron はシャードごとのリースを持つ東京のスケジューラーで起動し、予定の時刻ごとの記録で 2 重の起動を防ぐ |

関数の CPU 時間の上限は [runtime-and-isolates.md](runtime-and-isolates.md) の 6.1 節、Durable Objects のリースの仕組みは [durable-objects.md](durable-objects.md) の 5 節にある。料金の値は [limits-and-billing.md](limits-and-billing.md) の 6 節にある。

本家の振る舞い・数値は、2026-09-27 に本家の文書とブログ、AWS の文書と価格表で確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| キューの生産者のバインディング（`send`・`sendBatch`）と消費者（`queue()` の手続き、pull の HTTP API） | 管理の画面と API の形（dashboard-and-api） |
| 保存の方式、配信の保証、バッチ、再試行、遅延、デッドレターのキュー、並行の数の自動の調整 | 料金の値（limits-and-billing） |
| cron の式、トリガーの配信、分散のスケジューラー、起動の保証 | 関数の実行そのもの（runtime-and-isolates） |
| 障害の振る舞い、試験 | ワークフロー（長時間の耐久の実行。MVP の後） |

## 2. 本家と AWS の仕組み（確かめたこと）

| 項目 | 本家・AWS | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| 配信の保証 | 少なくとも 1 回。まれに 2 回以上届く。ID を付けて冪等にすることを勧める | [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) |
| バッチ | `max_batch_size` 既定 10・最大 100、`max_batch_timeout` 既定 5 秒・最大 60 秒。早い方で届ける | [Batching, retries and delays](https://developers.cloudflare.com/queues/configuration/batching-retries/) |
| 再試行 | 既定 3 回で、使い切ると削除（デッドレターのキューがなければ）。`msg.ack()`・`ackAll()`・`msg.retry()`・`retryAll()`。成功すれば暗黙に全部を確認。`msg.attempts` で自前の指数的な待ちを作れる | 同上 |
| 遅延 | 送信と再試行で最大 24 時間 | 同上、[Limits](https://developers.cloudflare.com/queues/platform/limits/) |
| デッドレター | 任意。なければ再試行の上限で完全に消える。DLQ はふつうのキュー。消費者のない DLQ のメッセージは 4 日で消える | [Dead letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/) |
| 並行 | バックログとその増え方、失敗の率で自動に増減する。最大 250。`retry()` は失敗として数えない | [Consumer concurrency](https://developers.cloudflare.com/queues/configuration/consumer-concurrency/) |
| 制限 | キュー 10,000/アカウント、メッセージ 128 KB、`sendBatch` 100 件・256 KB、1 キューに 1 秒 5,000 件、バックログ 25 GB、保持は既定 24 時間（無料）・最大 14 日、再試行 100 回、消費者の実時間 15 分、CPU 既定 30 秒・最大 5 分、pull の可視性のタイムアウト 12 時間 | [Limits](https://developers.cloudflare.com/queues/platform/limits/) |
| 本家の作り | Durable Objects の上に作る。保存のシャード（全リージョン、生産者の近く）、消費者のシャード、1 つの調整役。調整役は割り当ての表を KV に書く。2024 年 10 月の時点で、中央値の遅延 200ms → 60ms、1 キューの最大 400 → 5,000 件/秒、並行 20 → 250 | [Durable Objects aren't just durable, they're fast](https://blog.cloudflare.com/how-we-built-cloudflare-queues/) |
| 本家の料金 | 64 KB ごとに 1 操作。1 メッセージはふつう 3 操作（書き込み・読み込み・削除）。100 万操作あたり 0.40 ドル | [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) |
| cron の式 | 5 つの欄と Quartz の拡張（`L`・`W`・`#`）。UTC。`controller.scheduledTime`。変更の反映に最大 15 分 | [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| cron の制限 | アカウントあたり無料 5、有料 250。CPU 時間は、間隔 1 時間未満で 30 秒、1 時間以上で 15 分（有料。無料は 10ms） | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| SQS の標準のキュー | メッセージ 1 MiB、保持 60 秒〜14 日（既定 4 日）、可視性のタイムアウト 最大 12 時間、遅延 最大 15 分、1 回の要求に 10 件、長いポーリング 最大 20 秒、処理中（受けて未削除）のメッセージは約 12 万件まで、バックログは無制限。ほぼ無制限の毎秒の要求 | [SQS message quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html)、[SQS queue quotas](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-queues.html) |
| SQS の東京の料金 | 標準の要求 100 万あたり 0.40 ドル（毎月 100 万は無料）。64 KB ごとに 1 要求。1 要求に 10 件まで | AWS の価格表の API（AWSQueueService の ap-northeast-1、2026-09-27 に確認）、[SQS pricing](https://aws.amazon.com/sqs/pricing/) |

## 3. 原則

- **確定したメッセージは失わない。重複は許す**（ADR-0005）。送信は、保存が確定してから成功を返す。
- **メッセージの ID は再配信でも変えない。** 利用者は ID で冪等にできる。
- **cron の予定の時刻ごとの起動は 1 回に寄せるが、保証は「少なくとも 1 回の試み」ではなく、7.3 節の規則で明示する。**
- **要求の処理の経路で制御プレーンを呼ばない**（ADR-0004）。バインディングからキューの ID への対応は、ノードの設定の写しから読む。

## 4. キューの API と制限

### 4.1 生産者

| メソッド | 振る舞い |
| --- | --- |
| `send(body, {contentType, delaySeconds})` | 保存が確定してから解決する。`contentType` は `json`（既定）・`text`・`bytes`・`v8`（構造化の複製） |
| `sendBatch([{body, contentType, delaySeconds}], {delaySeconds})` | 100 件・256 KiB まで。全部が確定してから解決する。一部の失敗は例外（どれが確定したかを返す） |

- 1 キューの毎秒の送信の上限（5,000 件）を超えると、例外（本家と同じ）。

### 4.2 消費者

- **push**：消費者の関数の `queue(batch, env, ctx)`。`batch.messages[]` は `{id, timestamp, body, attempts, ack(), retry({delaySeconds})}`。`batch.ackAll()`・`batch.retryAll({delaySeconds})`。
  - 手続きが例外なく終われば、明示に `retry()` したもの以外を全部確認する。
  - 例外・時間切れ・CPU 超過なら、明示に `ack()` したもの以外を全部再試行する。
- **pull**：HTTP API。`POST /accounts/{account_id}/queues/{queue_id}/messages/pull`（`batch_size` 100 まで、`visibility_timeout_ms` 12 時間まで）で受け、`lease_id` を返す。`POST …/messages/ack` で `acks[]` と `retries[{lease_id, delay_seconds}]` を送る。
- 1 つのキューは push か pull のどちらか 1 つの消費者を持つ（本家と同じ）。

### 4.3 制限（S1 の既定）

| 項目 | 値 | 本家との差 |
| --- | --- | --- |
| キュー | アカウントあたり 10,000 | 同じ |
| メッセージ | 128 KiB | 同じ |
| `sendBatch` | 100 件・256 KiB | 同じ |
| 1 キューの送信 | 1 秒 5,000 件 | 同じ |
| バックログ | 1 キュー 25 GiB（概算で強制） | 同じ |
| 保持 | 既定 4 日（無料 24 時間）、最大 14 日 | 既定の値は本家の文書で有料の既定が読み取れない（未検証）。SQS の既定の 4 日にする |
| バッチ | `max_batch_size` 既定 10・最大 100、`max_batch_timeout` 既定 5 秒・最大 60 秒 | 同じ |
| 再試行 | 既定 3、最大 100 | 同じ |
| 送信の遅延 | **最大 15 分** | 本家は 24 時間。SQS の遅延の上限 |
| 再試行の遅延 | **最大 12 時間** | 本家は 24 時間。SQS の可視性のタイムアウトの上限 |
| 並行 | 最大 250 | 同じ |
| 消費者の実時間 | 15 分 | 同じ |
| 消費者の CPU | 1 束あたり既定 30 秒、`limits.cpu_ms` で最大 5 分（無料 10ms。[runtime-and-isolates.md](runtime-and-isolates.md) の 6.1 節） | 同じ |
| DLQ の消費者なしの保持 | 4 日 | 同じ |

## 5. キューの保存の方式

[ADR-0033](../decisions/0033-queues-on-sqs-with-own-dispatcher.md)。

### 5.1 比べたもの

| 観点 | SQS の標準のキュー（採用） | Durable Objects の上の自作（本家の方式） |
| --- | --- | --- |
| 耐久性 | SQS に任せる（複数の AZ） | E9 の複製と PITR に依る。キューが DO の欠陥をそのまま受ける |
| 着手の順 | E10 を E9 と並行に進められる | E9 の完成の後 |
| 生産者の近さ | S1 は東京の SQS だけ。海外の生産者は東京への往復（100〜250ms。未検証） | 生産者の近くのリージョンに置ける（本家と同じ） |
| 遅延の上限 | 送信 15 分、再試行 12 時間 | 24 時間を作れる |
| 原価 | 送信・受信・削除を 10 件ずつまとめれば、1 メッセージ約 0.3 要求＝約 0.12 ドル/100 万メッセージ（64 KB 以下のとき） | DO の要求・時間・行の書き込み。未試算 |
| 運用 | キューの作成・削除の API だけ | 保存のシャード、消費者のシャード、調整役を運用する |

### 5.2 対応づけ

- 利用者のキュー 1 つを、東京の SQS の標準のキュー 1 つに対応させる。名前は `<brand>-q-{queue_id}`（80 文字以内）。SQS の文書にキューの数の上限の記載はない（実際の上限は未検証）。
- DLQ は、利用者のもう 1 つのキュー。SQS の再配送の方針（redrive）は使わず、ディスパッチャーが移す（6.3 節）。
- メッセージの形：本文は、内容の種類に応じた直列化の後、base64 にして SQS の本文に入れる（SQS の本文は XML で許される文字だけのため）。128 KiB は base64 で約 171 KiB になり、SQS の 1 MiB に収まる。
- メッセージの属性：`msg_id`（自前の ULID。再配信でも変わらない）、`content_type`、`enqueued_at`、`account_id`、`queue_id`。
- 保存時の暗号化は SQS の SSE（SQS の管理の鍵）。

### 5.3 送信の流れ

```
関数（リージョン X） ─ env.Q.send(body)
  ▼ 外向きのプロキシ：isolate の鍵 → バインディング → queue_id
キューのゲートウェイ（リージョン X）
  │ 大きさ・内容の種類の検証、msg_id の採番
  │ 毎秒の上限：東京の速さの制限の表（Valkey）に 1 秒の窓で数える
  ▼ リージョンの間の私的な経路
東京の SQS：SendMessageBatch（10 件ずつ）
  │ 成功 → send が解決する
  │ 応答が失われて再送したときは、重複しうる（少なくとも 1 回の範囲）
  ▼
ディスパッチャーへ「空でなくなった」の合図（最善の努力。6.1 節の長いポーリングの待ちを縮める）
```

## 6. 配送

### 6.1 ディスパッチャー

- 東京に置く自前の部品（Rust、3 AZ）。キューを 256 のシャードに分け、シャードごとのリース（DynamoDB の条件付きの更新。durable-objects の 5 節と同じ形）で分担する。
- push の消費者を持つキューごとに、並行の数 `c` の分だけ、次を回す。
  1. `ReceiveMessage`（10 件、長いポーリング 20 秒、可視性のタイムアウト＝`max_batch_timeout`＋15 分＋1 分）を、`max_batch_size` に届くか、最初のメッセージから `max_batch_timeout` がたつまで繰り返す。
  2. 消費者の関数を、東京のランタイムで起動する（関数の要求と同じ隔離。起動の内部の API は runtime-and-isolates の呼び出しの結果の記録と同じ形）。
  3. 結果に従い、確認は `DeleteMessageBatch`、再試行は `ChangeMessageVisibility`（遅延の秒）にする。
- 空のキューの長いポーリングの費用を抑えるため、空が 5 分続いたキューは、1 分ごとの確認に落とし、ゲートウェイの合図で戻す。
- `attempts` は SQS の `ApproximateReceiveCount`。

### 6.2 並行の数の自動の調整

- 1 バッチごとに見直す。
  - バックログ（`ApproximateNumberOfMessages`）が `c × max_batch_size` を超え、直前のバッチが例外なく終わったら、`c` を 1 増やす（`max_concurrency` と 250 まで）。
  - 起動が例外・時間切れで終わったら、`c` を半分にする（1 まで）。`retry()` は失敗に数えない（本家と同じ）。
  - バックログが空なら、1 分ごとに 1 減らす。
- アカウントの全キューの並行の合計に上限を置く（値は limits-and-billing）。1 つのアカウントがディスパッチャーを占めないようにする。
- SQS の処理中のメッセージの上限（約 12 万件）に対し、`250 × 100 = 25,000` 件なので収まる。

### 6.3 再試行とデッドレター

```
バッチの結果のメッセージ m：
  確認           → DeleteMessage
  再試行         → attempts = ApproximateReceiveCount
                   attempts <= max_retries  → ChangeMessageVisibility(delay 秒。既定 retry_delay、最大 12 時間)
                   attempts >  max_retries  → DLQ があれば：DLQ の SQS へ SendMessage（同じ msg_id）→ 元を DeleteMessage
                                              DLQ がなければ：DeleteMessage し、捨てた数を指標と利用者のログに出す
```

- DLQ への送信を先にし、元の削除を後にする。その間に落ちると、DLQ に 2 重に入りうる（少なくとも 1 回の範囲）。
- ディスパッチャーが落ちたら、受けたメッセージは可視性のタイムアウトの後に再び見え、再配信される。このとき `ApproximateReceiveCount` が増えるので、基盤の障害で再試行の回数を使いうる。基盤の障害で使った回数は数え直さない（S1。13 節の問い）。
- 並び順は保証しない（本家と同じ）。

## 7. cron

[ADR-0034](../decisions/0034-cron-sharded-scheduler.md)。

### 7.1 式とトリガー

- 5 つの欄（分・時・日・月・曜日）と Quartz の拡張（`L`・`W`・`#`）。UTC。本家と同じ。
- 間隔は 1 分が最小。アカウントあたり無料 5、有料 250（本家と同じ）。
- トリガーは関数の設定の一部として、デプロイで決まる。制御プレーンの Aurora の `cron_triggers` に置き、変更のログでスケジューラーへ届く。反映は p99 60 秒以内（本家は最大 15 分）。

### 7.2 スケジューラー

```
スケジューラー（東京、3 台以上。大阪に待機）
  トリガーを 64 のシャードに分ける（xxhash(trigger_id) mod 64）
  シャードごとのリース（DynamoDB の条件付きの更新、2 秒ごとに更新、7 秒で自ら止まる、10 秒で引き継ぐ）

リースを持つシャードの各トリガー：
  1) 次の予定の時刻 t を式から計算し、最小のヒープに入れる
  2) 時刻 t になったら、起動の記録を条件付きで作る
       表 cron_fires：pk = trigger_id、sk = t、
       条件 attribute_not_exists(pk)  ← 同じ予定の時刻の 2 重の起動を防ぐ
     失敗（すでにある）→ 何もしない
  3) 成功 → 起動するリージョンを選ぶ（既定は東京。容量に余裕のあるリージョンを選ぶ）
     関数の scheduled(controller) を controller.scheduledTime = t で起動する
  4) 結果（成功・例外・時間切れ・基盤の失敗）を cron_fires に書く
```

### 7.3 起動の保証

- **予定の時刻ごとの起動の記録は、ちょうど 1 つ**（`cron_fires` の条件付きの作成）。リースの引き継ぎの途中でも、同じ予定の時刻を 2 回起動しない。
- **基盤の失敗**（利用者のコードが始まる前の失敗：ランタイムの容量、経路）は、同じ予定の時刻のまま最大 3 回、10 秒あけて試す。
- **利用者のコードの例外・時間切れは、再試行しない**（本家も再試行しないと見られるが未検証）。結果を記録し、指標と tail に出す。
- **取りこぼし**：スケジューラーの停止（リースの引き継ぎの 10 秒、東京の障害）で予定の時刻を過ぎたものは、過ぎてから 15 分以内なら 1 回だけ起動する（`scheduledTime` は本来の予定の時刻）。15 分より古いものは起動せず、`missed` として記録する。
- 遅れの目標：予定の時刻から起動の開始まで p99 5 秒（リースの引き継ぎの間を除く）。

### 7.4 東京の障害

- スケジューラーとリースの表、`cron_fires` は東京にある。東京の全体の障害では cron が止まる。
- runbooks の `cron-region-failover` で、大阪の待機のスケジューラーへ手動で切り替える。`cron_fires` は DynamoDB のグローバルテーブルで大阪に複製しておき、切り替えの時点で複製に届いていない起動の記録の分だけ、2 重の起動がありうる。

## 8. 障害の型

| 障害 | 検知 | 振る舞い |
| --- | --- | --- |
| SQS の遅延・エラー | ゲートウェイの失敗の率 | `send` は例外。利用者が再試行する。ゲートウェイの自動の再送は 1 回まで（重複の原因になるので増やさない） |
| ディスパッチャーの停止 | リースの更新の途絶 | 10 秒で別の台がシャードを引き継ぐ。処理中のバッチは可視性のタイムアウトの後に再配信 |
| 消費者の関数が常に例外 | 再試行の率、DLQ への移動の数 | 並行の数が 1 まで下がる。再試行を使い切ったら DLQ か削除 |
| バックログの急増 | バックログの増え方 | 並行の数を増やす。25 GiB に近づいたら利用者に知らせ、超えたら `send` を例外にする |
| リージョンの間の経路の障害 | ゲートウェイの失敗 | 東京以外のリージョンの `send` が失敗する（S1 の既知の制約） |
| 東京の全体の障害 | 合成監視 | キューと cron が止まる。キューの SQS は東京にあり、S1 では切り替えない（メッセージは SQS に残り、回復の後に配る）。cron は 7.4 節 |
| スケジューラーのシャードのリースの二重（分断） | 計装 | `cron_fires` の条件付きの作成で、2 重の起動は起きない |
| 時計のずれ（スケジューラー） | Time Sync の指標 | 起動が早まる・遅れる。100ms を超えたらその台を外す |

## 9. セキュリティ（テナントの分離）

- キューの ID は、外向きのプロキシが isolate の鍵とバインディングから決める。isolate から届く ID は使わない（ADR-0010）。
- SQS のキューはテナントごとに分かれる。ディスパッチャーとゲートウェイの権限は `<brand>-q-*` に限り、エッジのノードのロールは SQS に直接の権限を持たない。
- ディスパッチャーは、受けたメッセージの `account_id`・`queue_id` の属性が、キューの持ち主と一致することを確かめてから起動する。違えば捨てて重大な事象にする。
- pull の `lease_id` は、SQS の受信のハンドルと `queue_id` を暗号化して包む。別のキューでは使えない。
- 消費者の関数は、そのキューの持ち主のアカウントの関数だけ。別のアカウントのキューを消費者にできない（設定の検証）。
- cron の起動は、そのトリガーを持つ関数の版を起動する。`cron_fires` にはアカウントの ID を持たせ、利用者の画面では自分の分だけを見せる。
- メッセージの本文をログに出さない。

## 10. テスト

| 種類 | 対象 | 確かめること |
| --- | --- | --- |
| 単体 | cron の式の解析 | Quartz の拡張（`L`・`W`・`#`）を含む表駆動の試験。うるう年、月末、UTC の境 |
| 性質ベース | cron の次の時刻 | 任意の式と時刻で、次の時刻が式に合い、その間に式に合う時刻がない |
| 性質ベース | 再試行の判定 | 任意の結果の列で、確認したメッセージは再配信されず、再試行の上限の後は DLQ か削除のどちらかにちょうど 1 回進む（重複を除く） |
| 耐久性（障害の注入） | 失わないこと | 生産者が送った `msg_id` をすべて記録し、ディスパッチャーの SIGKILL、分断、SQS の遅延、消費者の例外を注入する。成功を返した `msg_id` が、最後に必ず 1 回以上「確認」か「DLQ」か「上限で削除（記録あり）」になる。失われた `msg_id` が 0 件 |
| 結合 | バッチ | `max_batch_size` と `max_batch_timeout` の早い方で届く |
| 結合 | 遅延 | 送信の遅延 15 分、再試行の遅延 12 時間の境目。超える値の拒否 |
| 結合 | 並行 | バックログの増加で並行が増え、例外で減る。`retry()` で減らない |
| 結合 | cron の 2 重の起動 | スケジューラーの 2 台に同じシャードのリースを持たせた（分断の模擬）状態で、同じ予定の時刻の起動が 1 回 |
| 結合 | cron の取りこぼし | スケジューラーを 5 分止めると、止まっていた間の予定の時刻が 1 回ずつ起動する。20 分止めると、15 分より古いものは `missed` |
| 負荷 | 1 キューの 5,000 件/秒 | 送信と配送が続き、遅延の中央値が 1 秒以内（東京の生産者） |
| 分離 | キューの ID | 別のアカウントのキューへの送信・pull の `lease_id` の流用が拒否される |

テスト名には要件の ID を含める（開発リポジトリの `specs/` で採番する）。

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0033](../decisions/0033-queues-on-sqs-with-own-dispatcher.md) | S1 のキューは、利用者のキュー 1 つを東京の SQS の標準のキュー 1 つに対応させる。配送・バッチ・並行・再試行・DLQ は自前のディスパッチャーで行う。遅延は送信 15 分・再試行 12 時間まで。Durable Objects の上の自作は S2 で見直す |
| [0034](../decisions/0034-cron-sharded-scheduler.md) | cron は東京のスケジューラーがシャードごとのリースで分担し、`cron_fires` の条件付きの作成で予定の時刻ごとの起動を 1 つにする。基盤の失敗だけを 3 回まで試し、15 分より古い取りこぼしは起動しない |

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E10 | キューの作成・削除（SQS のキューの作成、設定の配信） |
| E10 | キューのゲートウェイと生産者のバインディング（`send`・`sendBatch`、内容の種類、毎秒の上限） |
| E10 | ディスパッチャー（シャードのリース、受信とバッチ、消費者の起動、確認と再試行） |
| E10 | 並行の数の自動の調整と、アカウントの上限 |
| E10 | DLQ への移動と、上限で捨てたメッセージの記録 |
| E10 | pull の消費者の HTTP API |
| E10 | cron のスケジューラー（式の解析、シャードのリース、`cron_fires`、取りこぼしの規則） |
| E10 | 耐久性の試験（失われた `msg_id` の検査）と、cron の 2 重の起動の試験 |
| E10 | `cron-region-failover` の訓練 |
| E2 | キュー・cron の起動の内部の API と、CPU 時間の上限の表の適用（runtime-and-isolates と合わせて） |
| E6 | CLI の `queues` の操作、ローカル開発の模擬のキューと cron の手動の起動 |
| E11 | キューの操作（64 KiB ごと）と cron の起動の計量 |
| E1 | SQS・DynamoDB・Valkey（速さの制限）の Terraform |

## 13. 未解決の問い

- 海外の生産者の送信の遅延（東京への往復）を、S2 でどう縮めるか。生産者のリージョンに SQS を置き、ディスパッチャーが複数のリージョンのキューから読むか、DO の上の自作に移るか。
- 24 時間の遅延（本家）を作るか。SQS の上では、遅延の保管の表（DynamoDB）と取り出しの仕組みが要る。
- 基盤の障害で使った再試行の回数を数え直すか。SQS の `ApproximateReceiveCount` は戻せないので、自前の数え方が要る。
- 大きなメッセージ（本家を超える大きさ）の要望への対応。
- cron の利用者のコードの例外を再試行するか（本家の振る舞いは未検証）。
- cron の起動のリージョンを、容量に余裕のあるリージョンに回すとき、データの所在の約束（`jp`）とどう合わせるか。

### 決定

2026-09-27 の既定案。

- 海外の生産者の遅延は S1 で受け入れ、文書で示す。S2 の前に、生産者の近くの保存の方式を ADR にする。
- 遅延は送信 15 分・再試行 12 時間まで。本家との差として文書で示す。
- 基盤の障害の再試行の回数は数え直さない。既定の `max_retries` 3 を保ち、基盤の障害の率を SLI にする。
- メッセージは 128 KiB まで。
- cron の利用者のコードの例外は再試行しない。
- cron の起動のリージョンは、S1 では東京に固定する（データの所在の問題を避ける）。容量に余裕のあるリージョンへ回すのは S2 で決める。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：成功を返したメッセージを失う（削除の誤り、DLQ への移動の誤り）。失われた `msg_id` の検査を、ディスパッチャーの変更ごとに回す。
- リスク：cron の 2 重の起動・取りこぼし。`cron_fires` の条件付きの作成と、分断の模擬の試験。
- リスク：1 つのアカウントがディスパッチャーを占める。アカウントの並行の上限の試験。
- 本番での検証：東京と各リージョンの合成の生産者が 10 秒ごとに送り、合成の消費者が受けるまでの時間と抜けを見る（カナリア）。1 分ごとの合成の cron の起動の遅れと抜け。

**runbooks**

- `queue-backlog-growth`：バックログの急増。消費者の失敗の率、並行の数、アカウントの上限の確認。
- `queue-dispatcher-stuck`：受信はあるが確認が進まない。シャードのリース、消費者の起動の失敗の確認。
- `queue-dlq-surge`：DLQ への移動の急増。利用者への連絡。
- `cron-missed-fires`：`missed` の記録の発生。スケジューラーのリースと時計の確認。
- `cron-region-failover`：7.4 節。
- SLI の追加の依頼（Ops へ）：送信の遅延と失敗の率、送信から配送の開始までの遅延、バックログ、並行の数、DLQ への移動の数、上限で捨てた数、cron の起動の遅れと `missed` の数。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `queues`（制御プレーンの Aurora） | `id`、`account_id`、`name`、`sqs_url`、`retention_seconds`、`delivery_delay_seconds`、`created_at`、`deleted_at` | RLS |
| `queue_consumers`（Aurora） | `queue_id`、`type`（`push`・`pull`）、`script_id`、`max_batch_size`、`max_batch_timeout_ms`、`max_retries`、`retry_delay_seconds`、`max_concurrency`、`dead_letter_queue_id` | RLS。1 キューに 1 つ |
| SQS のキュー `<brand>-q-{queue_id}`（東京） | 本文（base64）、属性 `msg_id`・`content_type`・`enqueued_at`・`account_id`・`queue_id` | SSE（SQS の管理の鍵） |
| `queue_dispatch_leases`（東京の DynamoDB） | `shard`（0〜255）、`owner`、`lease_seq`、`epoch` | テナントの表ではない |
| `cron_triggers`（Aurora） | `id`、`account_id`、`script_id`、`expression`、`created_at` | RLS。デプロイで決まる |
| `cron_scheduler_leases`（東京の DynamoDB） | `shard`（0〜63）、`owner`、`lease_seq`、`epoch` | テナントの表ではない |
| `cron_fires`（東京の DynamoDB、大阪へ複製） | `trigger_id`、`scheduled_time`、`account_id`、`status`（`started`・`succeeded`・`failed`・`platform_failed`・`missed`）、`attempts`、`started_at`、`finished_at`、`ttl`（30 日） | 利用者の画面の最近の起動の一覧にも使う |

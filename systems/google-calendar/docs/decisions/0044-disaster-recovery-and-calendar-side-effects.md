---
status: accepted
date: 2026-10-04
---

# ADR-0044: リージョンの障害は大阪のウォームスタンバイへ人の判断で切り替え、書き込みを止めてから昇格し、`sync_epoch` を上げる。失った範囲の外への副作用は、外部への iMIP の次の送信で `SEQUENCE` を 1 つ余分に上げること、リマインダーの送信の重複を数えて SLO から分けること、で扱う

## Context

NFR-007 は、リージョンの障害で RPO 1 分以内・RTO 1 時間以内を求める。[ADR-0005](0005-change-log-and-sync-tokens.md) は、DR の切り替えで `epoch` を上げ、古いトークンに 410 を返すと決めた。他の題材（Linear の ADR-0050）は、大阪のウォームスタンバイ、書き込みを止めてからの昇格、`sync_epoch` の引き上げを決めている。

Aurora Global Database の計画外のフェイルオーバーは、複製の遅延ぶんを失いうる。古い一次の書き込みを止める仕組みは最善努力で、先にアプリの書き込みを止めることが勧められている（[Using switchover or failover in Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)。Linear の infrastructure.md の 6.3 節で 2026-09-28 に確認した事実を引き継ぐ）。

カレンダーには、失った範囲（最後の数十秒）の変更が、すでに外へ出ている場合がある。

- **外部への iMIP**：失った変更の `REQUEST`（`SEQUENCE` を上げたもの）が外部の参加者に届いている。大阪では `SEQUENCE` が 1 つ前のままで、次の変更で同じ値の `SEQUENCE` を別の中身で送ると、相手は古い（同じ `SEQUENCE` で `DTSTAMP` が新しいだけの）更新と見て、時刻の変更を出欠を戻さずに当てるか、捨てる（RFC 5546 の 2.1.5 節。相手の実装次第で**未検証**）。
- **リマインダー**：失った範囲で送った通知の送信の記録が大阪にない。大阪の `reminder-scheduler` が同じ鍵で送り直しうる。
- **Webhook・Web Push・メールの通知**：送ったものは取り消せない。
- **外部からの iMIP の受信**：東京の S3 にだけあり、大阪で処理されていないメールがある。

## Options

1. **大阪のウォームスタンバイ。人の判断で切り替え、書き込みを止めてから昇格し、`sync_epoch` を上げる。外への副作用は、iMIP の `SEQUENCE` の余白と、リマインダーの重複の計数で扱う**
2. 1 に加えて、送った iMIP の `SEQUENCE` とリマインダーの送信の記録を、DynamoDB のグローバルテーブルに書いてから外へ出す
3. パイロットライト（大阪に DB の二次だけ置き、切り替えのときにサービスを作る）

## Decision

1 を採用する。

### 構成

- 大阪に、各サービスを最小 1〜2 タスク、Aurora の二次（reader 1 台）、空の Valkey、SQS、SES の受信（MX 20）を置く（[infrastructure.md](../architecture/infrastructure.md) の 5 節）。
- `rds.global_db_rpo` は設定しない。`AuroraGlobalDBRPOLag` が 10 秒を 5 分超えたら呼び出す（[runbooks/README.md](../runbooks/README.md) の 4 節）。

### 切り替えの手順（ワークフロー）

1. IC と Ops の責任者が切り替えを決める（[roadmap.md](../roadmap.md) の「エージェントに任せないこと」）。
2. 東京の入口を止める（CloudFront のオリジンを保守の応答に、`alb-dav` の WAF を全拒否に）。`ops.writes_enabled = false`。
3. Aurora の計画外のフェイルオーバーで大阪を昇格させる。古い一次の障害の時点のスナップショットがあれば、手動のスナップショットにコピーする。
4. **`sync_epoch` を上げる**：全カレンダーの `epoch` を 1 つ上げる（[ADR-0005](0005-change-log-and-sync-tokens.md)）。失った範囲の `change_seq` が、大阪で別の変更に振り直されるため。Web・API・CalDAV のトークンはすべて 410 になり、取り直しになる。
5. **`dr_epoch_started_at` を記録する**：下の iMIP とリマインダーの扱いに使う。
6. 大阪のサービスを広げる（[capacity.md](../architecture/capacity.md) の 5 節の取り直しの殺到）。
7. `ops.writes_enabled = true` にし、CloudFront のオリジンと `dav.<brand>.<domain>` の DNS を大阪へ切り替える。

### 失った範囲の外への副作用

| 副作用 | 扱い |
| --- | --- |
| 外部への iMIP の `SEQUENCE` | `dr_epoch_started_at` の後、外部の参加者のいる主催者の写しは、最初に外部へ送る `REQUEST`・`CANCEL` で、`SEQUENCE` を本来の値より 1 つ余分に上げる（予定オブジェクトに `seq_margin_epoch` を記録して 1 回だけ）。RFC 5546 は `SEQUENCE` が飛ぶことを禁じていない。本システムの中の参加者の写しは、`(SEQUENCE, 主催者のバージョン)` で判定するので影響しない（[ADR-0014](0014-itip-state-transfer-and-sequence.md)） |
| リマインダーの重複 | 大阪の `reminder-scheduler` は、通知の時刻が `dr_epoch_started_at − 2 分` より前の項目を送らずに数える（遅れすぎ）。その後の項目は送る。失った範囲で東京が送った分と重なるものは重複になりうる。重複の数を `dr_window` の印で数え、NFR-003 の重複の率から分けて報告する |
| Webhook・Web Push・メールの通知 | 取り消さない。Webhook の受け手は `epoch` の 410 で取り直す。公開 API の文書に、DR の後に同じ変更の通知が 2 回届きうることを書く |
| 外部からの iMIP の受信 | 東京の S3 にあって処理していないメールは、東京の回復の後、`imip-inbound` が S3 の一覧から拾い直す（同じ `Message-ID` は捨てる）。東京の障害の間に届くメールは、MX 20 の大阪が受ける |
| 送信の上限の数（Valkey） | 大阪の Valkey は空から始まる。上限の数は 0 から数え直す（迷惑な送信の上限が一時的に緩む）。DB の `imip_send_quota` の上書きは残る |

### 大阪が受けたメールの扱い（平常時）

- 東京が主の間に、送り手の都合で大阪の SES の受信にメールが届いたら、大阪の `imip-inbound-relay`（最小 1 タスク）が、S3 の鍵を東京の SQS へ送る（リージョンをまたぐ SQS の送信）。東京の `imip-inbound` が、大阪の S3 から読む（`s3-imip-raw` の大阪の鍵の `Decrypt` を東京のロールに許す）。

### 東京へ戻す

- 東京の回復の後、Aurora が東京を二次として加え直し、計画作業として switchover（RPO 0）で戻す。番号が保たれるので `sync_epoch` を上げない。

### 他の案を選ばなかった理由

- **2（DynamoDB に先に書く）**：iMIP の送信とリマインダーの送信のたびに、リージョンをまたぐ書き込みの往復を待つことになる。リマインダーの集中（[capacity.md](../architecture/capacity.md) の 3 節）で、送信の開始が遅れる。失った範囲は 1 分以内で、`SEQUENCE` の余白と重複の計数で足りる。
- **3（パイロットライト）**：サービスの起動とイメージの取得、Valkey・SQS の作成で、RTO 1 時間に収まらない見込み。

## Consequences

- 良くなること：
  - 失った範囲の変更で外部へ送った `SEQUENCE` と、大阪の次の送信の `SEQUENCE` がぶつからない。
  - リマインダーの重複が、DR の窓の分として数えられ、平常の品質の指標を汚さない。
- 引き受けるコスト：
  - DR の後、外部の参加者のいる予定の次の変更で、外部のカレンダーが出欠を戻しうる（`SEQUENCE` が上がるため。本来は戻さなくてよい変更でも）。
  - 失った範囲で 2 回 `SEQUENCE` を上げた予定は、余白 1 では足りない。1 分の窓で同じ予定を 2 回日時の変更をすることはまれとして引き受ける。
  - すべてのクライアントが取り直す。大阪の `api`・`caldav` を先に広げる。

## Confirmation

- E12 の `dr-failover-drill`（staging、四半期）：RPO・RTO を測る。切り替えの後、合成監視のクライアント（Web の API と CalDAV）が 410 から取り直して一致する。
- 結合テスト：`dr_epoch_started_at` の後の最初の外部への `REQUEST` の `SEQUENCE` が 1 つ余分に上がり、2 回目は上がらない。
- 結合テスト：大阪の `reminder-scheduler` が、`dr_epoch_started_at − 2 分` より前の項目を送らない。
- 合成監視：大阪の SES の受信へのテストのメールが、東京の `imip-inbound` で処理される。

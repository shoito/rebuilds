# Runbooks: Google Calendar

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節にある。SLI の計測とアラートの条件の実装は observability の領域（まだない）で書く。**SLO の値とアラートの一覧の正本はこの文書** で、値を変えるときは、この文書を先に変える。

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| 予定の読み書きの可用性 | API・CalDAV の要求のうち、5xx・時間切れでないもの（エッジ、API、CalDAV） | **月間 99.9%**（NFR-006） | 1 時間のバーンレート 14.4 倍・6 時間で 6 倍で呼び出し、3 日で 1 倍でチケット。エラーバジェットを使い切ったら、修正以外のデプロイを止める | |
| 予約ページの可用性 | 予約ページの表示と予約の要求のうち、5xx・時間切れでないもの | **月間 99.9%**（NFR-006） | 同上（別に数える） | |
| 書き込みの速さ | 予定の作成・変更の API が 300ms 以内 | **p99 300ms**（NFR-001） | p99 が 1 秒を 10 分超えたら呼び出し | |
| 範囲の読み出しの速さ | 週の表示の範囲の読み出しが 300ms 以内 | **p95 300ms**（NFR-001） | 1 日続けて超えたらチケット | |
| 伝播（同じ利用者の他の端末） | 確定から合図を受けた Web クライアントの差分の取得の完了まで（合成監視） | **p99 3 秒**（NFR-002） | p99 が 10 秒を 10 分超えたら呼び出し | ○ |
| 伝播（主催者 → 参加者の写し） | 主催者の写しのコミットから、本システムの中の参加者の写しのコミットまで（`itip-delivery`） | **p99 5 秒**（参加者 200 人まで）、**p99 60 秒**（それを超える分）（NFR-002） | p99 が 30 秒を 10 分超えたら呼び出し | ○ |
| リマインダーの時刻どおりの送信 | 通知の時刻から送信の開始まで 30 秒以内のもの（画面・Web Push）、2 分以内のもの（メール） | **月間 99.9%**、**p99 30 秒**（NFR-003、NFR-006） | 5 分の窓で 1% を超えて遅れたら呼び出し | ○ |
| リマインダーの送り漏れ | 送信の記録と予定の回の照合での漏れ | **0**（NFR-003、K6） | 1 件でチケット、100 件で呼び出し | ○ |
| 空き時間の探索 | 50 人＋会議室 20、2 週間の候補の計算（合成監視） | **p95 1 秒**（NFR-004） | 1 日続けて超えたらチケット | ○ |
| 会議室の二重予約 | 会議室の重なりの検査 | **0**（NFR-005、K5） | 1 件で呼び出し（SEV2 から） | ○ |
| 権限の分離 | 応答の監査の不一致 | **0**（NFR-008、K8） | 1 件で呼び出し（SEV1 の候補） | ○ |
| 展開の正しさ | 展開の索引の照合の不一致、古い `tzdata_version` の行（採用から 24 時間の後） | **0**（NFR-009、K1・K2） | 1 件でチケット。施行の日まで 7 日を切っていれば呼び出し | ○ |
| 差分の同期 | 変更 1,000 件以下の差分の応答が 1 秒以内 | **p99 1 秒**（NFR-010） | 1 日続けて超えたらチケット | |
| iMIP | 外部への招待の送信事業者への引き渡し 60 秒以内、外部からの返事の取り込み 2 分以内 | **p95 60 秒・p95 2 分**（NFR-011） | p95 が 10 分を超えたらチケット、SES の送信の停止で呼び出し | |
| Webhook | 変更から最初の送信まで | **p95 30 秒**（NFR-012） | p95 が 5 分を超えたらチケット | |
| 検索 | 変更から検索に出るまで、検索の応答 | **p95 30 秒、p99 1 秒**（NFR-012） | 更新の遅れの p95 が 5 分を超えたらチケット | ○ |

- SLO の窓は 30 日の移動の窓（報告は暦の月）。エラーバジェットを使い切ったら、信頼性の作業を機能より先にする。デプロイの前に残りを確かめる。
- **数えないもの**：検証の拒否（4xx）。ただし 4xx の率の急な上がりは、クライアントとの食い違いの兆候として見る。社内の監視用のテナントは SLO の計算から除き、別に見る。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う（[quality.md](../quality.md) の 4.1 節）。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分、リージョンの障害は RPO 1 分・RTO 1 時間（NFR-007）。
- 本家は Calendar を含め月間 99.9% の SLA を出している（[Google Workspace SLA](https://workspace.google.com/terms/sla/)、2026-10-04 に確認）。本システムの SLO は同じ水準にする。

## 2. 上限と容量のパラメーター

値の正本は、各 ADR と領域の文書（まだないものは [architecture/README.md](../architecture/README.md) の 6 節の決定）にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 1 カレンダーの書き込み | 1 秒 50 件（見込み。E2 の PoC で確かめる） | [ADR-0005](../decisions/0005-change-log-and-sync-tokens.md) | — |
| 展開の索引の範囲 | 過去 31 日から未来 548 日 | [ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md) | — |
| 1 つの予定オブジェクト | 上書き 1,000、RDATE 1,000、EXDATE 5,000、範囲の中の回 5,000 | 同上 | — |
| 予定の項目 | タイトル 1,024 文字、説明 64 KiB、直接の参加者 1,000、グループの展開 10,000、リマインダー 5 件 | [architecture/README.md](../architecture/README.md) の 6 節 | — |
| 変更のログの保持 | 30 日（法務の L5 の後に確定） | [ADR-0005](../decisions/0005-change-log-and-sync-tokens.md) | — |
| 配送の並行 | 受け手ごとに並行、大きな招待はバッチ | [ADR-0006](../decisions/0006-organizer-and-attendee-copies.md) | `ops.itip_delivery_concurrency` |
| Webhook の通知の経路 | 期限 既定 7 日・最大 30 日、経路ごとに 1 秒 1 回にまとめる | architecture/README.md の 6 節 | `ops.webhooks_enabled` |
| ICS の購読 | 6 時間ごと、10 MiB・5 万件まで | 同上 | `ops.ics_fetch_interval_min`（延ばすだけ） |
| リマインダーの遅れすぎ | 15 分を超えたら送らずに数える | [quality.md](../quality.md) の 2.2.1 節 F | — |
| tzdb の再計算の速さ | 施行の近い順、採用から 24 時間以内に終える | [ADR-0002](../decisions/0002-time-representation.md) | `ops.tzdata_recompute_rate` |

## 3. リリースとロールバック

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。未完成の振る舞いは `release.*` のフラグの裏に置く。`release.*` は 100% の後 30 日で消す。
- **展開・時刻・権限の規則をフラグにしない。** `expand()`・`resolve()`・`redact()` の振る舞いの変更は、コードの版として出し、本番の照合の指標で見る。フラグで経路ごとに違う規則が動く状態を作らない。
- **サーバーのデプロイの順**：マイグレーション（広げる段だけ）→ API・CalDAV・Booking・Auth（ローリング）→ Relay → Worker → Realtime（1 タスクずつ逃がす）→ Web の資産（置くだけ）。自動のロールバックの条件は、5xx、書き込みの p99、4xx の率の急な上がり、展開の索引の照合の不一致。
- **Web のクライアント**：段階的に 1% → 10% → 50% → 100%、各段 4 時間以上。止める条件：JavaScript のエラーの率が 2 倍、範囲の読み出しの p95 が 10% 以上遅い。
- **tzdb の版の採用**：
  1. 新しい tzdb のリリースを検知したら、`packages/tzdata` の PR を作る。差分の報告（変わるゾーンと区間、影響する予定の見積もり）を Dev と Ops が見る。
  2. サーバーと Web のクライアントを同じ版で出す。Web のクライアントの段階を、サーバーの採用の後すぐに 100% まで進める（版の混在の期間を短くする）。
  3. 再計算のジョブを `ops.tzdata_recompute_rate` で動かし、古い `tzdata_version` の行が 0 になるまで見る。
  4. 施行の日まで 7 日を切った改正は、凍結の期間でも急ぎの採用として扱う。
  5. 戻すときは、前の版を「新しい版」として同じ手順で出す（派生の値を作り直す）。古い版の値の行を残さない。
- **ロールバック**：まずフラグで戻す。次に 1 つ前のイメージ（マイグレーションは広げる段だけなので、前の版が今の DB で動く）。縮める段の後は前へ戻さない。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| サーバー、Web のクライアント | 平日 10〜17 時 | 金曜 15 時以降、日本の祝日の前日、年末年始、年度の始め（4 月の第 1 週）、エラーバジェットを使い切っている間 |
| マイグレーション（縮める・消す段） | 計画作業として平日 10〜15 時 | 同上 |
| tzdb の版の採用 | 平日 10〜15 時 | 施行の日まで 7 日を切った改正は凍結を受けない |
| Terraform（ネットワーク、データ） | 平日 10〜16 時。Ops の承認 | 同上 |

- 上の時間帯と凍結は本システムの既定である。年度の始めは、組織の異動と会議の設定が集中し、カレンダーの利用が増えると見込んだ（本システムの想定）。本家の運用の値ではない。

## 4. アラートと手順

個別の手順は、まだない。各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。「作る Story」の列は、そのアラートの計測と手順を作る [roadmap.md](../roadmap.md) の Story である。手順の文書は、その Story の完了の条件に含める（E12 の `runbooks-e12` でまとめて確かめる）。

| アラート（重さ） | 手順（予定のファイル名） | 作る Story |
| --- | --- | --- |
| 予定の読み書きの SLO のバーンレート（page・ticket） | `incident-response.md` | `slo-dashboards-alerts` |
| 書き込みの遅れ、カレンダーのロックの待ち（上位のカレンダーの p99 200ms が 10 分。ticket） | `calendar-lock-contention.md` | `writer-and-change-log-skeleton`、`calendar-write-throughput-poc` |
| 伝播の遅れ（主催者 → 参加者の写し。page）、配送の滞留（SQS の最古 60 秒。page） | `itip-delivery-lag.md` | `itip-internal-delivery` |
| 写しの照合の食い違いの増加（ticket） | `attendee-copy-drift.md` | `copy-reconciliation` |
| 展開の索引の照合の不一致（ticket。施行の近い tzdb の改正の後は page） | `occurrence-index-mismatch.md` | `occurrence-index` |
| 古い `tzdata_version` の行が残る、再計算のジョブの遅れ | `tzdata-update.md`（採用と再計算の手順を含む） | `tzdata-recompute-job`、`tzdata-update-drill` |
| 会議室の二重予約（page、SEV2 から） | `room-double-booking.md` | `room-booking-exclusion` |
| 権限の漏れの疑い（応答の監査。page、SEV1 の候補） | `access-leak-response.md` | `leak-path-tests`、`policy-can-redact` |
| リマインダーの遅れ（page）、送り漏れ（ticket・page）、scheduler の停止 | `reminder-delay.md` | `reminder-timer-wheel`、`reminder-delivery-ledger` |
| SES の送信の停止・バウンスの率の上がり、受信の滞留 | `email-delivery.md` | `imip-outbound`、`imip-inbound`、`email-notifications` |
| 迷惑な招待の急増 | `invite-abuse.md` | `invite-spam-controls` |
| 差分の同期の 410 の急増 | `sync-token-reset-spike.md` | `sync-tokens` |
| Realtime の再接続の殺到 | `realtime-reconnect-storm.md` | `realtime-gateway` |
| CalDAV の 4xx の急な上がり（クライアントの版の変化） | `caldav-client-regression.md` | `caldav-reports-and-sync` |
| Webhook の送信の失敗の増加 | `webhook-delivery.md` | `webhook-channels` |
| ICS の購読の取得の失敗の増加 | `ics-subscription-failures.md` | `ics-subscribe` |
| 予約ページのボットの急増 | `booking-abuse.md` | `booking-bot-protection` |
| 検索の更新の遅れ | `search-index-lag.md` | `search-table-pg-bigm` |
| デプロイ中の自動ロールバック、Web の段階の止める条件 | `deploy-and-rollback.md` | `ci-pipeline-baseline` |
| DR の複製の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分。page）、リージョンの障害 | `disaster-recovery.md`（`sync_epoch` の更新を含む） | `osaka-warm-standby`、`dr-failover-drill` |

- すべてのアラートは、対応する手順の URL を注釈に持つ（CI で検査する）。
- 手順を作るまでは、`incident-response.md`（E1 で最初に作る）の一般の手順で対応する。

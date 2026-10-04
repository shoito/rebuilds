# Runbooks: Google Calendar

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節にある。SLI の計測とアラートの条件の実装は [observability.md](../architecture/observability.md) の 5 節にある。**SLO の値とアラートの一覧の正本はこの文書** で、値を変えるときは、この文書を先に変える。

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| 予定の読み書きの可用性 | API・CalDAV の要求のうち、5xx・時間切れでないもの（CloudFront、`alb-dav`、API、CalDAV） | **月間 99.9%**（NFR-006） | 1 時間のバーンレート 14.4 倍・6 時間で 6 倍で呼び出し、3 日で 1 倍でチケット。エラーバジェットを使い切ったら、修正以外のデプロイを止める | |
| 予約ページの可用性 | 予約ページの表示と予約の要求のうち、5xx・時間切れでないもの | **月間 99.9%**（NFR-006） | 同上（別に数える） | |
| 書き込みの速さ | 予定の作成・変更の API が 300ms 以内 | **p99 300ms**（NFR-001） | p99 が 1 秒を 10 分超えたら呼び出し | |
| 範囲の読み出しの速さ | 週の表示の範囲の読み出しが 300ms 以内 | **p95 300ms**（NFR-001） | 1 日続けて超えたらチケット | |
| 伝播（同じ利用者の他の端末） | 確定から合図を受けた Web クライアントの差分の取得の完了まで（合成監視を正本、RUM を補い） | **p99 3 秒**（NFR-002） | p99 が 10 秒を 10 分超えたら呼び出し | ○ |
| 伝播（主催者 → 参加者の写し） | 主催者の写しのコミットから、本システムの中の参加者の写しのコミットまで（`itip_deliveries`） | **p99 5 秒**（参加者 200 人まで）、**p99 60 秒**（それを超える分）（NFR-002） | p99 が 30 秒を 10 分超えたら呼び出し | ○ |
| リマインダーの時刻どおりの送信 | 通知の時刻から送信の開始まで 30 秒以内のもの（画面・Web Push）、2 分以内のもの（メール）。`reminder_deliveries` | **月間 99.9%**、**p99 30 秒**（NFR-003、NFR-006） | 5 分の窓で 1% を超えて遅れたら呼び出し | ○ |
| リマインダーの送り漏れ | 送信の記録と予定の回の照合での漏れ（`missing`） | **0**（NFR-003、K6） | 1 件でチケット、100 件で呼び出し | ○ |
| リマインダーの重複 | 送信の記録の鍵の衝突と notifier の 2 重の送り（DR の窓 `dr_window` は分けて報告） | **0.01% 未満**（NFR-003） | 日次で超えたらチケット | ○ |
| 空き時間の探索 | 50 人＋会議室 20、2 週間の候補の計算（合成監視） | **p95 1 秒**（NFR-004） | 1 日続けて超えたらチケット | ○ |
| 会議室の二重予約 | 会議室の重なりの検査（`accepted` どうし） | **0**（NFR-005、K5） | 1 件で呼び出し（SEV2 から） | ○ |
| 権限の分離 | 応答の監査の不一致 | **0**（NFR-008、K8） | 1 件で呼び出し（SEV1 の候補） | ○ |
| 展開の正しさ | 展開の索引の照合の不一致、古い `tzdata_version` の行（採用から 24 時間の後） | **0**（NFR-009、K1・K2） | 1 件でチケット。施行の日まで 7 日を切っていれば呼び出し | ○ |
| 差分の同期 | 変更 1,000 件以下の差分の応答が 1 秒以内（`sync_token_uses`） | **p99 1 秒**（NFR-010） | 1 日続けて超えたらチケット | |
| iMIP | 外部への招待の送信事業者への引き渡し 60 秒以内、外部からの返事の取り込み 2 分以内 | **p95 60 秒・p95 2 分**（NFR-011） | p95 が 10 分を超えたらチケット、SES の送信の停止で呼び出し | |
| Webhook | 変更から最初の送信まで | **p95 30 秒**（NFR-012） | p95 が 5 分を超えたらチケット | |
| 検索 | 変更から検索に出るまで、検索の応答 | **p95 30 秒、p99 1 秒**（NFR-012） | 更新の遅れの p95 が 5 分を超えたらチケット | ○ |

- SLO の窓は 30 日の移動の窓（報告は暦の月）。エラーバジェットを使い切ったら、信頼性の作業を機能より先にする。デプロイの前に残りを確かめる。
- **数えないもの**：検証の拒否（4xx）。ただし 4xx の率の急な上がりは、クライアントとの食い違いの兆候として見る。社内の監視用のテナントは SLO の計算から除き、別に見る。
- 正しさと遅れの SLI は、業務の記録から全件で数える（[ADR-0046](../decisions/0046-sli-from-ledgers-and-delivery-tracing.md)）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う（[quality.md](../quality.md) の 4.1 節）。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分、リージョンの障害は RPO 1 分・RTO 1 時間（NFR-007）。
- 本家は Calendar を含め月間 99.9% の SLA を出している（[Google Workspace SLA](https://workspace.google.com/terms/sla/)、2026-10-04 に確認）。本システムの SLO は同じ水準にする。

## 2. 上限と容量のパラメーター

値の正本は、下の「正本」の列の ADR と領域の文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 1 カレンダーの書き込み | 1 秒 50 件（見込み。E2 の PoC で確かめる）。`origin` ごとの枠：`user` 30、`itip` 15、`maintenance` 5、`import` 5 | [ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)、[ADR-0047](../decisions/0047-time-shaped-capacity-and-calendar-write-admission.md) | `ops.calendar_write_budget.<origin>` |
| 展開の索引の範囲 | 過去 31 日から未来 548 日 | [ADR-0003](../decisions/0003-recurrence-storage-and-expansion.md) | — |
| 1 つの予定オブジェクト | 上書き 1,000、RDATE 1,000、EXDATE 5,000、範囲の中の回 5,000、知らないプロパティ 32 KiB | 同上、[ADR-0007](../decisions/0007-interop-standards-scope.md) | — |
| 予定の項目 | タイトル 1,024 文字、説明 64 KiB、直接の参加者 1,000、グループの展開 10,000（入れ子 10 段）、リマインダー 5 件・0〜40,320 分 | [architecture/README.md](../architecture/README.md) の 6 節、[ADR-0016](../decisions/0016-group-invitation-expansion.md) | — |
| 外からの入力 | CalDAV の `PUT` 1 MiB、ICS の取り込み・購読 10 MiB・5 万件、iMIP のメール 10 MiB（`text/calendar` 1 MiB） | [ADR-0040](../decisions/0040-untrusted-calendar-input-gate.md) | — |
| 変更のログの保持 | 30 日（法務の L5 の後に確定） | [ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)、[ADR-0042](../decisions/0042-audit-log-and-data-lifecycle.md) | — |
| 配送の並行 | 受け手ごとに並行、200 人を超える招待は `itip-bulk`（1 テナントの同時のバッチ 20） | [ADR-0006](../decisions/0006-organizer-and-attendee-copies.md)、[ADR-0016](../decisions/0016-group-invitation-expansion.md) | `ops.itip_delivery_concurrency` |
| iMIP の送信の上限 | 主催者 24 時間で外部 2,000、作って 30 日以内の個人 200、組織 50,000 | [ADR-0015](../decisions/0015-imip-addressing-and-trust.md) | `ops.imip_outbound`（`.<tenant>`。止めるだけ） |
| 公開 API のレート制限 | （アプリ, 利用者）1 分 600、（アプリ, テナント）1 分 10,000、利用者の書き込み 1 分 120、テナント 1 分 30,000 | [ADR-0027](../decisions/0027-oauth-apps-scopes-and-rate-limits.md) | — |
| CalDAV | 1 利用者 1 分 300、1 テナント 1 分 30,000。認証の失敗の上限は [sync-and-caldav.md](../architecture/sync-and-caldav.md) の 6.7 節（アカウントの全体を止めない） | [sync-and-caldav.md](../architecture/sync-and-caldav.md) の 6.7・10 節 | — |
| Webhook の通知の経路 | 期限 既定 7 日・最大 30 日、経路ごとに 1 秒 1 回にまとめる、24 時間失敗で停止 | [ADR-0028](../decisions/0028-push-channels-signed-webhooks.md) | `ops.webhooks_enabled` |
| ICS の購読 | 6 時間ごと（`REFRESH-INTERVAL` で 1〜24 時間）、10 MiB・5 万件 | [ADR-0025](../decisions/0025-ics-subscriptions-both-directions.md) | `ops.ics_fetch_interval_min`（延ばすだけ） |
| リマインダーの遅れすぎ | 15 分を超えたら送らずに数える（`skipped_late`）。計画は 7 日先まで | [ADR-0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md)、[ADR-0030](../decisions/0030-reminder-planning-horizon-and-replan.md) | — |
| tzdb の再計算の速さ | 全体 5,000 件/秒、1 テナント 500 件/秒。会議室の予約の行を先に、施行の近い順。採用から 24 時間以内に終える | [ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md) | `ops.tzdata_recompute_rate` |
| tzdb の版 | AppConfig の `tzdata.active_version`（イメージの中の版だけを受ける） | [ADR-0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md) | Ops の承認で切り替える（[tzdb-update.md](tzdb-update.md)） |
| 書き込みの全体の停止 | `ops.writes_enabled` | [ADR-0044](../decisions/0044-disaster-recovery-and-calendar-side-effects.md) | DR とインシデントだけ |

## 3. リリースとロールバック

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。未完成の振る舞いは `release.*` のフラグの裏に置く。`release.*` は 100% の後 30 日で消す（例外は下の「長く残すフラグ」の一覧だけ）。
- **展開・時刻・権限の規則をフラグにしない。** `expand()`・`resolve()`・`can()`・`redact()` の振る舞いの変更は、コードの版として出し、本番の照合の指標で見る。フラグで経路ごとに違う規則が動く状態を作らない。不具合は前のイメージへ戻して直す（展開の索引は `expander` が作り直す）。漏れている経路を止めるのは `ops.*` で行う。
- **サーバーのデプロイの順**：マイグレーション（広げる段だけ）→ API・CalDAV・Booking・Auth（ローリング）→ Relay → Worker → Realtime（1 タスクずつ逃がす）→ Web の資産（置くだけ）。自動のロールバックの条件は、5xx、書き込みの p99、4xx の率の急な上がり、展開の索引の照合の不一致、CalDAV の 4xx の急な上がり。`worker-reminder-scheduler` と `worker-notifier` は、毎時 05〜15 分と 35〜45 分にだけ始める。手順は [deploy-and-rollback.md](deploy-and-rollback.md)。
- **Web のクライアント**：段階的に 1% → 10% → 50% → 100%、各段 4 時間以上。止める条件：JavaScript のエラーの率が 2 倍、範囲の読み出しの p95 が 10% 以上遅い、ドラッグの p95 が 10% 以上遅い、書き込みの 4xx の率が 2 倍、窓の取り直しの率が 2 倍（[delivery.md](../architecture/delivery.md) の 5.1 節）。
- **tzdb の版の採用**（[ADR-0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md)。手順の正本は [tzdb-update.md](tzdb-update.md)）：
  1. `tzdata-watch` が新しい tzdb のリリースを見つけ、GPG の署名を確かめて、`packages/tzdata` に版を足す PR を作る。差分の報告（変わるゾーンと区間、施行までの日数、影響する予定の見積もり、外部への `REQUEST` の見積もり）を Dev と Ops が見て、採用を決める。
  2. マージし、`/tzdata/<version>/` を S3 に置き、新旧の版を含むイメージをデプロイする（`active` は旧のまま）。Web のクライアントは資産の版に関係なく API の `tzdata_version` のゾーンを取るので、Web の資産の段階を速める必要はない。
  3. AppConfig の `tzdata.active_version` を新しい版にする（東京と大阪。Ops の承認）。全タスクが新しい版を 2 分続けて報告したら、`expander` が計算し直しを始める。会議室の予約の行と予約ページの区間を先に直し、切り替えの窓（[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md)）を短くする。古い `tzdata_version` の行が 0 になるまで見る。
  4. 施行の日まで 7 日を切った改正は、凍結の期間でも急ぎの採用として扱う。
  5. 戻すときは、`tzdata.active_version` を前の版に戻す。行ごとに `tzdata_version` を持つので、計算し直しがどちらの方向にも収束する（デプロイは要らない）。
- **ロールバック**：まずフラグで戻す（`release.*`・`ops.*`）。次に 1 つ前のイメージ（マイグレーションは広げる段だけなので、前の版が今の DB で動く）。縮める段の後は前へ戻さない。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。

> 2026-10-04 の注記（統合の工程）：tzdb の採用の手順の 2（「サーバーと Web のクライアントを同じ版で出し、Web の段階をすぐに 100% まで進める」）と 5（「前の版を新しい版として同じ手順で出す」）を、AppConfig の切り替え（ADR-0049）に合わせて書き直した。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| サーバー、Web のクライアント | 平日 10〜17 時 | 金曜 15 時以降、日本の祝日の前日、年末年始、年度の始め（4 月の第 1 週）、エラーバジェットを使い切っている間 |
| マイグレーション（縮める・消す段） | 計画作業として平日 10〜15 時 | 同上 |
| tzdb の版の採用（デプロイと AppConfig の切り替え） | 平日 10〜15 時 | 施行の日まで 7 日を切った改正は凍結を受けない |
| Terraform（ネットワーク、データ） | 平日 10〜16 時。Ops の承認 | 同上 |

- 上の時間帯と凍結は本システムの既定である。年度の始めは、組織の異動と会議の設定が集中し、カレンダーの利用が増えると見込んだ（本システムの想定）。本家の運用の値ではない。

### 3.2 長く残すフラグ（30 日で消す規則の例外）

`release.*` は 100% の後 30 日で消す。次の一覧のフラグだけは、終わりの条件まで残す。一覧の外のフラグが 30 日を超えたら、CI の週次の検査が Issue を作る（[delivery.md](../architecture/delivery.md) の 3 節）。一覧への追加は Ops と PM の承認を要する。

| フラグ | 残す理由 | 終わりの条件 | 持ち主 |
| --- | --- | --- | --- |
| `release.admin-event-access` | 管理者による従業員の予定の閲覧。法務の L8 の結論まで本番で有効にしない（[ADR-0037](../decisions/0037-admin-roles-delegation-and-event-access.md)） | L8 の結論。持つと決まれば、組織の方針（`admin_event_access_*`）へ移してフラグを消す。持たないと決まれば、コードと一緒に消す | PM（法務） |
| `release.cross-tenant-shared-writes` | 共有のカレンダーへのテナントをまたぐ書き込み（[ADR-0004](../decisions/0004-tenancy-and-rls.md) の X4、[ADR-0021](../decisions/0021-effective-role-and-redact-table.md)） | テックリードの確認。認めれば 100% の後 30 日で消す。認めなければ、上限を `reader` にしてコードと一緒に消す | Dev（テックリード） |

- `ops.*` は運用の止め・絞りで、寿命の規則の対象ではない。`tzdata.active_version` はデータの版の固定で、フラグではない。

## 4. アラートと手順

「手順」の列のうち、リンクのあるものは作成済み（6 節）。リンクのないものは計画で、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。「作る Story」の列は、そのアラートの計測と手順を作る [roadmap.md](../roadmap.md) の Story である。手順の文書は、その Story の完了の条件に含める（E12 の `runbooks-e12` でまとめて確かめる）。条件の細部は [observability.md](../architecture/observability.md) の 5.6 節。

| アラート（重さ） | 手順 | 作る Story |
| --- | --- | --- |
| 予定の読み書きの SLO のバーンレート（page・ticket）、書き込みの p99 が 1 秒を 10 分（page） | [incident-response.md](incident-response.md) | `slo-dashboards-alerts` |
| カレンダーのロックの待ち（上位のカレンダーの p99 200ms が 10 分。ticket） | `calendar-lock-contention.md` | `writer-and-change-log-skeleton`、`calendar-write-admission` |
| 伝播の遅れ（主催者 → 参加者の写し。page）、配送の滞留（SQS の最古 60 秒。page） | `itip-delivery-lag.md` | `itip-internal-delivery` |
| 写しの照合の食い違いの増加（ticket） | `attendee-copy-drift.md` | `copy-reconciliation` |
| 展開の索引の照合の不一致（ticket。施行の近い tzdb の改正の後は page）、範囲の端のジョブの停止 | `occurrence-index-mismatch.md`（`expander-advance-stalled` の手順を含む） | `occurrence-index` |
| 古い `tzdata_version` の行が残る、再計算のジョブの遅れ、切り替えの窓が長い | [tzdb-update.md](tzdb-update.md) | `tzdata-recompute-job`、`tzdata-update-drill` |
| **tzdb の新しいリリースの未採用**（IANA のリリースから 7 日、または施行まで 14 日を切った。ticket） | [tzdb-update.md](tzdb-update.md) | `tzdata-watch-and-rollout` |
| **AppConfig の `tzdata.active_version` の不一致**（タスクの報告する版が 2 種類以上で 5 分、または東京と大阪で違う。page） | [tzdb-update.md](tzdb-update.md) | `tzdata-runtime-switch`、`tzdata-version-telemetry` |
| 会議室の二重予約（page、SEV2 から） | `room-double-booking.md` | `room-booking-exclusion` |
| 権限の漏れの疑い（応答の監査。page、SEV1 の候補） | `access-leak-response.md` | `leak-path-tests`、`redact-response-audit` |
| リマインダーの遅れ（page）、送り漏れ（ticket・page）、scheduler の停止（page） | `reminder-delay.md`（送り漏れの照合の調べ方を含む） | `reminder-timer-wheel`、`reminder-delivery-ledger`、`reminder-sli` |
| SES の送信の停止・Bounce・Complaint の率の上がり、受信の滞留、未確認の返事の急増 | `email-delivery.md` | `imip-outbound`、`imip-inbound`、`email-notifications` |
| 迷惑な招待の急増 | `invite-abuse.md` | `invite-spam-controls` |
| 差分の同期の 410 の急増 | `sync-token-reset-spike.md` | `sync-tokens` |
| **変更のログの欠け**（`change_seq_gap_total` 1 件。page、SEV2） | [incident-response.md](incident-response.md) | `writer-and-change-log-skeleton` |
| Realtime の再接続の殺到 | `realtime-reconnect-storm.md` | `realtime-gateway` |
| CalDAV の 4xx の急な上がり（クライアントの版の変化）、CalDAV の認証の失敗の急増 | `caldav-client-regression.md` | `caldav-reports-and-sync`、`caldav-client-lab` |
| Webhook の送信の失敗の増加 | `webhook-delivery.md` | `webhook-channels` |
| ICS の購読の取得の失敗の増加 | `ics-subscription-failures.md` | `ics-subscribe` |
| 予約ページのボットの急増 | `booking-abuse.md` | `booking-bot-protection` |
| 検索の更新の遅れ | `search-index-lag.md` | `search-table-pg-bigm` |
| デプロイ中の自動ロールバック、Web の段階の止める条件 | [deploy-and-rollback.md](deploy-and-rollback.md) | `ci-pipeline-baseline`、`web-cohort-rollout` |
| DR の複製の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分。page）、リージョンの障害、大阪の待機の構成の異常 | [disaster-recovery.md](disaster-recovery.md) | `osaka-warm-standby`、`dr-failover-workflow`、`dr-failover-drill` |
| 東京の SES の受信の停止（大阪の受信への切り替わり） | `ses-inbound-failover.md` | `ses-inbound-dual-region` |
| **SLI の集計の欠け**（`slo-aggregator` の出力が 5 分ない。page） | [incident-response.md](incident-response.md) | `slo-aggregator` |
| **シークレットスキャンの通知**（本システムの接頭辞の秘密の公開の検知。page）、ログの秘密の出力の検出（page、SEV2） | `credential-compromise.md`（作るまでは [incident-response.md](incident-response.md)） | `secret-storage`、`otel-baseline` |
| 監査ログのハッシュの連鎖の検証の失敗（page、SEV2） | [incident-response.md](incident-response.md) | `audit-log-table-and-archive` |

- 太字は統合の工程（2026-10-04）で足したアラート（observability の 5.6 節の依頼）。
- すべてのアラートは、対応する手順の URL を注釈に持つ（CI で検査する）。
- 手順を作るまでは、[incident-response.md](incident-response.md) の一般の手順で対応する。

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 | 作る Story |
| --- | --- | --- | --- |
| DR の訓練（staging の切り替え、本番の switchover） | staging 四半期、本番 年 1 回 | [disaster-recovery.md](disaster-recovery.md) | `dr-failover-drill` |
| tzdb の更新の訓練（合成の改正を本番と同じ構成で） | 半年 1 回、と E12 | [tzdb-update.md](tzdb-update.md) | `tzdata-update-drill` |
| 祝日の表の更新（2 月の暦要項の反映、1 月の 1 年分の追加、CSV との照合） | 毎年 1・2 月 | `holidays-annual-update.md`（予定） | `japanese-holidays-calendar` |
| キャパシティのレビュー（段階の指標、業務の時間の下限、上位 50 のカレンダー） | 月次 | `capacity-review.md`（予定） | `capacity-review-dashboard` |
| 相互運用の手動の確認の表（K9） | CalDAV・招待に触れたリリースの前、月 1 回 | [deploy-and-rollback.md](deploy-and-rollback.md) の「リリースの前」 | `interop-acceptance` |
| 解約したテナントの削除の確かめ | 日次のジョブの結果を週次 | `tenant-purge.md`（予定） | `data-lifecycle` |
| 長く残すフラグと、30 日を超えた `release.*` の一覧 | 週次 | 3.2 節 | `flags-appconfig` |

## 6. 作成済みの runbook

| ファイル | 中身 |
| --- | --- |
| [incident-response.md](incident-response.md) | 共通の進め方（重さ、IC、告知、調べ方）と、個別の手順のないアラートの最初の切り分け（書き込みの遅れ、変更のログの欠け、SLI の集計の欠け、秘密の出力、監査の連鎖） |
| [deploy-and-rollback.md](deploy-and-rollback.md) | サーバーのデプロイの順、自動のロールバック、前のイメージへの戻し、Web の段階の止め方、リリースの前の確認 |
| [disaster-recovery.md](disaster-recovery.md) | 大阪への切り替えのワークフロー、`sync_epoch`、失った範囲の副作用、東京へ戻す、訓練の合格基準 |
| [tzdb-update.md](tzdb-update.md) | tzdb の版の採用（署名、差分の報告、デプロイ、AppConfig の切り替え）、計算し直しと切り替えの窓の監視、急ぎの採用、戻し、遅れたときの再実行 |

計画の runbook（4・5 節のリンクのないもの）：`calendar-lock-contention.md`、`itip-delivery-lag.md`、`attendee-copy-drift.md`、`occurrence-index-mismatch.md`、`room-double-booking.md`、`room-needs-review-backlog.md`、`access-leak-response.md`、`org-policy-change.md`、`reminder-delay.md`、`email-delivery.md`、`invite-abuse.md`、`sync-token-reset-spike.md`、`realtime-reconnect-storm.md`、`caldav-client-regression.md`、`credential-compromise.md`、`webhook-delivery.md`、`api-abuse.md`、`ics-subscription-failures.md`、`booking-abuse.md`、`search-index-lag.md`、`freebusy-slow.md`、`sso-outage.md`、`tenant-move-failure.md`、`ses-inbound-failover.md`、`holidays-annual-update.md`、`capacity-review.md`、`tenant-purge.md`、`schema-expand-contract.md`。

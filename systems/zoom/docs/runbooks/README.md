# Runbooks: Zoom

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みとアラートの条件の実装は [observability.md](../architecture/observability.md) の 5・6 節にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md と [ADR-0052](../decisions/0052-media-slis-and-mos-estimation.md) は、これを計測・実装する側の記述である。値を変えるときは、この文書を先に変え、observability.md を合わせる。値はすべて既定案で、SLO の値は PM と Ops が承認する。

## 1. SLI と SLO

| SLI | 良いイベント ／ 対象 | SLO（30 日、S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| 参加の成功 | 参加のボタンから 10 秒以内に音声の送受信が始まった試行 ／ 参加の試行（待合室の時間を除く） | **99.5%**（K2） | 速いバーンレートで呼び出し、遅いバーンレートでチケット。エラーバジェットを使い切ったら、修正以外のデプロイを止める | ○ |
| 参加の速さ | 参加のボタンから最初の音声の送受信まで | **p95 3 秒**（NFR-002）。TURN の経路は 5 秒 | p95 が 15 分超えたらチケット | ○ |
| 良い音声の分 | `mos_est ≥ 3.6` かつ隠しの率 < 5% の参加者・分 ／ 音声を受けた参加者・分 | **97%** | サーバーの側の悪化（Node の世代・AZ の偏り、ENA の超過）と同時なら呼び出し、そうでなければチケット | ○ |
| フリーズのない分 | 1 秒以上のフリーズがない参加者・分 ／ 映像を受けた参加者・分 | **95%** | 同上 | ○ |
| 意図しない脱落 | `leave_reason = dropped` の数 ／ 参加者・時間 | **0.5% 以下**（K4） | チケット。Node の障害の波と同時なら呼び出し | ○ |
| 付け替えの時間 | `media.reattach` から 5 秒以内に音声の最初のパケットを受けた参加者 ／ 付け替えを受けた参加者 | **95%**（NFR-004） | 1 時間で 90% を下回ったら呼び出し | ○ |
| 制御の回復 | 持ち主を失ってから 10 秒以内に最初の `ack` を返した会議 ／ 持ち主を失った会議 | **99%**（NFR-004） | 5% 以上が 10 秒で戻らなければ呼び出し | |
| API | 5xx でない応答 ／ 参加・予定の API の要求 | **99.95%**（NFR-005） | バーンレートで呼び出し | |
| 転送の健全さ（サーバーの側） | ENA の超過が 0 で、合成の会議の転送の遅れ p99 が 10ms 以内だった Node・分 ／ Node・分 | **99.9%** | チケット。複数の Node なら呼び出し | |
| 公開 API（E11） | `api.<brand>.<domain>` の 5xx でない応答 | 99.9% | バーンレートでチケット | |

- **数えないもの**：合成の監視の組織の会議、クライアントの側の理由の失敗（パスコードの誤り、待合室で断られた、ロック、E2EE に非対応のブラウザ）。良い音声の分とフリーズのない分は、利用者の回線の悪さでも減るので、SLO の違反をそのままサーバーの障害とみなさない。Media Node の側の数、`ice_path`、ブラウザで分けて見る。
- **バーンレート**（他の題材と同じ）：呼び出しは 1 時間／5 分で 14.4 倍、6 時間／30 分で 6 倍。チケットは 3 日／6 時間で 1 倍（[observability.md](../architecture/observability.md) の 5.1 節）。
- SLO の窓は 30 日の移動の窓（報告は暦の月。他の題材と同じ）。エラーバジェットを使い切ったら、信頼性の作業を機能より先にする。デプロイの前に残りを確かめる。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う（[quality.md](../quality.md) の 4.1 節）。定義を変えるときは QA と合意する。
- 復旧の目標：Media Node の障害で音声 p95 5 秒、Actor の障害で制御 10 秒（NFR-004）。リージョンの障害は RTO 1 時間・RPO 1 分（[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md)）。
- 月次の費用の指標 K8（S1 0.20 円、S2 0.07 円）は SLO にしない。Ops が毎月計算し、2 か月続けて超えたら PM と Dev に報告する（[ADR-0053](../decisions/0053-capacity-model-cost-target-and-load-bots.md)）。

## 2. 上限と容量のパラメーター

値の正本は各文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 1 会議の参加者 | S1 100 人、映像は 1 人最大 25 本、音声は最大 3 本 | NFR-006、[ADR-0011](../decisions/0011-forwarding-and-layer-selection.md) | — |
| Media Node の点 | 新しい会議は 0.7 未満、0.85 で会議を割らない、0.95 で移す | [ADR-0012](../decisions/0012-media-assignment-and-cascading.md) | 障害の波のときの一時的な引き下げ（0.6） |
| 1 台の上限 | consumer 24,800（62 worker × 400）、CPU 70%、送出 20 Gbps（仮）、pps は E7 | [capacity.md](../architecture/capacity.md) の 3 節 | E7 の実測で置き換える |
| 台数（東京） | ピーク 27 台（AZ ごと 9）、夜間 6 台、ウォームプール AZ ごと 2 台 | capacity.md の 5 節 | Auto Scaling の最小・最大、予測の上書き |
| リース | TTL 6 秒、更新 2 秒、自分で止まる 4.5 秒 | [ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md) | — |
| Actor Host | 1 タスク 2,000 会議、`stopTimeout` 120 秒 | [signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 5.3・10.3 節 | タスクの数 |
| シグナリングの上限 | 1 メッセージ 64 KiB・1 MiB、`cmd` 毎秒 20 | 同 6.3 節 | — |
| 参加の流量 | IP 毎分 30、番号の種類 10 分に 20、会議のパスコードの誤り 1 時間 50 | [meeting-security.md](../architecture/meeting-security.md) の 8.2 節 | — |
| TURN | 資格情報 12 時間、1 人 4 割り当て、1 割り当て 10 Mbps、台 2 Gbps で足す | [ADR-0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md)、capacity.md の 5.3 節 | 台の数 |
| 参加の受付 | `ops.join_admission`（毎秒の上限） | [delivery.md](../architecture/delivery.md) の 6 節 | 再接続の嵐と DR の後に段階的に開く |
| IPv6 の候補 | `media.ipv6_candidates`、防御のモードの Node は出さない | [ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md) の注記 | 範囲の全体への IPv6 の攻撃で切る |

## 3. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- **デプロイとリリースを分ける。** デプロイは Ops が承認し（作成者と別の人）、リリース（フラグを広げる）は PM が判断する。すべての新しい振る舞いは release フラグの裏に置く。
- **フラグは 4 種類**（[ADR-0056](../decisions/0056-client-release-trains-and-meeting-scoped-flags.md)）：release、meeting（開催の開始で Actor が評価し、会議の全員と Media Node で揃える。`media.red`・`media.svc`・`media.av1`）、ops（止める向きはすぐ。進行中の会議に 10 秒以内）、experiment。
- **デプロイの順**：マイグレーション（expand）→ Worker・API・Assignment（blue/green）→ Actor Host（1/6 ずつのローリング、計画した引き渡し）→ Gateway（1 タスクずつ、接続を 60 秒で少しずつ閉じる）→ Web（割合）。シグナリングのスキーマはサーバーを先に、クライアントを後に。
- **Media Node の波**（[ADR-0055](../decisions/0055-media-node-rolling-replacement.md)）：その場で更新しない。新しい AMI の台を AZ ごとに 1 台（新しい会議の 5%）→ 平日のピークを含む 24 時間、同じ時間の古い世代と SLI を比べる（合格の基準は [quality.md](../quality.md) の 4.1 節）→ 1 日 1 回 10% → 25% → 50% → 100%、各波の後 4 時間比べる。古い台は会議が自然に終わるのを 4 時間待ち、残りは夜間に make-before-break で移す。急ぎ（重大な脆弱性）はカナリア 1 時間、15 分ごとに 20%。TURN も同じ形。
- **クライアントの列車**：Web は毎日出せる。社内 → 1% → 10% → 50% → 100%（各 4 時間）で版ごとの SLI を比べ、会議の中では版を変えない。アプリ（E13）は 2 週ごとの列車で、デスクトップは 1 週で 1% → 100%、モバイルはストアの段階的な公開。シグナリングは Web に N−1、アプリに N−2 まで。重い不具合は `min_client_version` を上げて強制の更新。
- **ロールバック**：まずフラグで戻す。次に 1 つ前のタスク定義（制御の側）、新しい世代の Media Node を全部 `draining`（重い回帰は make-before-break で古い台へ）、Web の割合を 0。マイグレーションは戻さない。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| 制御の側、Web の段を進める | 平日 10〜16 時。平日の 8〜10 時と月曜の朝を避ける | 金曜 15 時以降、日本の祝日の前日、年末年始、組織から知らされた大きな会議の時間、エラーバジェットを使い切っている間、夜間のメディアの試験が 2 日続けて失敗している間 |
| Media Node・TURN の波 | 平日 10〜16 時に足す。古い台の強制の移動は夜間 22〜6 時 | 同上 |
| Terraform（`media/network`・`media/ip`・`regional/keys`） | 平日 10〜16 時。`security:sensitive` は 2 人の承認 | 同上 |

- 重大な脆弱性の修正は時間帯の制限を受けない。レビューと必須の CI（メディアの段を含む）は省かない。

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。作るまでは [incident-response.md](incident-response.md) の該当の節で対応する。アラートの条件の実装は [observability.md](../architecture/observability.md) の 6 節。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。呼び出し（page）は、SLO か、サーバーの側の原因を示す症状か、セキュリティ（DDoS、内容の出力、監査）に限る。

| アラート（重さ） | 手順 | 状態（作る Story） |
| --- | --- | --- |
| 参加の成功の速いバーンレート（page）、参加の失敗の急増（5 分で 2% 超。page）、合成の監視の会議の連続失敗（同じ AZ で 2 回。page） | [incident-response.md](incident-response.md) | 作成済み（アラートの実装は E1 の `alerts-with-runbooks`、合成の監視は E7 の `synthetic-meetings`） |
| Media Node の障害の波（`dead` が 10 分に 2 台以上、`media.reattach` が 5 分に 2,000 人超。page） | [incident-response.md](incident-response.md) の「Media Node の障害の波」 | 作成済み（検知は E7 の `media-node-failover`） |
| メディアの IP への DDoS の兆候（受信の pps が平常の 5 倍、ICE を通らない送信元が 30% 超。page、SEV2 から） | [incident-response.md](incident-response.md) の「メディアの IP への DDoS」、`shield-eip-protection.md` | 作成済み（個別の手順と検知は E7 の `media-node-under-attack-mode`・`shield-advanced-onboarding`） |
| TURN の過負荷（CPU 70%、1 台 2 Gbps、割り当て 3 倍が 5 分。page）、TURN の拒否の急増（1 分に 100 超。ticket、10 倍で page） | [incident-response.md](incident-response.md) の「TURN の過負荷」 | 作成済み（指標は E2 の `turn-coturn-deploy`） |
| シグナリングの再接続の嵐（新しい接続が平常の 5 倍、`resume` の失敗 5% 超。page） | [incident-response.md](incident-response.md) の「シグナリングの再接続の嵐」、`signaling-reconnect-storm.md` | 作成済み（個別の手順は E2 の `reconnect-resume`） |
| 内容・秘密の出力の検出（1 件以上。page、SEV2）、監査ログのハッシュの連鎖の検証の失敗（page、SEV2） | [incident-response.md](incident-response.md) の「内容・秘密の出力」、`content-leak-detected.md` | 作成済み（個別の手順は E1 の `content-leak-scanner`、ハッシュの連鎖は `audit-log-three-streams`） |
| デプロイ中の自動の戻し、Media Node のカナリアの不合格、Web の版の悪化（page） | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み（E10 の `media-node-canary-and-waves`、E1 の `web-release-percentage`） |
| DR の複製の遅延（`AuroraGlobalDBRPOLag` 60 秒を 5 分。page）、大阪の待機の構成の異常（ticket、30 分で page）、AZ の障害 | [disaster-recovery.md](disaster-recovery.md) | 作成済み（E10 の `osaka-media-standby`・`dr-drill-region`） |
| 待合室もパスコードもない会議が 1 件以上（毎日の監査。page、SEV2） | [incident-response.md](incident-response.md)、`join-guard-violation.md` | E3 の `join-guard-invariant` で作成 |
| 接続の追跡の上限の超過（`conntrack_allowance_exceeded` ≥ 1。page） | `conntrack-allowance-exceeded.md`（network-traversal の 15 節） | E1 の `media-sg-untracked` で作成 |
| 品質の報告の経路の遅れ（Firehose・Athena、要約の足し込みの詰まり。ticket） | `qos-pipeline-lag.md`（observability の 11 節） | E1 の `qos-report-pipeline` で作成 |
| 公開する範囲の変更、BYOIP の広告と撤回 | `media-ip-range-change.md`（network-traversal の 15 節）、`byoip-range-operations.md`（infrastructure の 15 節） | E1 の `byoip-onboarding` で作成 |
| ラボの自己診断の失敗が続く | `netem-lab-broken.md`（delivery の 11 節） | E1 の `netem-lab-namespaces` で作成 |
| 期限を過ぎたフラグ（週次） | `stale-flags.md`（delivery の 11 節） | E1 の `meeting-scoped-flags` で作成 |
| TURN の台の障害、TURN の秘密の入れ替え（90 日） | `turn-node-failure.md`、`turn-secret-rotation.md`（network-traversal の 15 節） | E2 の `turn-coturn-deploy`・`turn-rest-credentials` で作成 |
| 顧客の網から入れない問い合わせ | `customer-network-cannot-join.md`（network-traversal の 15 節） | E2 の `customer-firewall-doc` で作成 |
| ブラウザの新しい版での回帰 | `browser-release-regression.md`（clients の 15 節、codecs の 14 節） | E2 の `browser-capability-probe` で作成 |
| 空きの不足のうち起動の失敗（在庫）、EIP のプールの枯渇（空き 10 未満で ticket、0 で page） | `ec2-capacity-shortage.md`、`eip-pool-exhausted.md`（infrastructure の 15 節） | E2 の `media-fleet-asg` で作成 |
| 主催者不在の会議の問い合わせ | `host-lost-meeting.md`（signaling の 17 節） | E3 の `host-handover` で作成 |
| 推測の疑いの IP・ASN の増加、パスコードの総当たりの疑い | `meeting-id-enumeration.md`、`passcode-bruteforce.md`（meeting-security の 14 節） | E3 の `join-rate-limits`・`enumeration-uniform-response` で作成 |
| 報告の急増、報告の優先度と対処 | `abuse-report-surge.md`（security の 16 節）、`trust-safety-report-triage.md`（meeting-security の 14 節） | E3 の `participant-report` で作成 |
| 待合室の荒らしの問い合わせ | `waiting-room-flood.md`（meeting-security の 14 節） | E3 の `waiting-room-core` で作成 |
| 良い音声の分の悪化（サーバーの側と同時なら page、それ以外は ticket） | `audio-quality-degradation.md`（codecs の 14 節） | E4 の `mos-est-calibration` で作成 |
| フリーズの率の急増（1 時間で 3 ポイント。ticket、Node の世代に偏れば page） | `video-freeze-spike.md`（codecs の 14 節） | E4 の `freeze-sli` で作成 |
| キーフレームの嵐（ticket） | `keyframe-storm.md`（media-server-sfu の 15 節） | E4 の `keyframe-control` で作成 |
| 仮想背景の失敗の報告の増加 | `virtual-background-failures.md`（clients の 15 節） | E5 の `virtual-background` で作成 |
| チャットのファイルの検査の遅れ、24 時間の消去の停止 | `chat-file-scan-backlog.md`、`chat-retention-audit.md`（chat-and-reactions の 12 節） | E5 の `chat-file-transfer`・`chat-retention` で作成 |
| カレンダーの同期の遅れ、提供者の障害、tzdata の更新、OAuth のクライアントの秘密の入れ替え | `calendar-sync-lag.md`、`calendar-provider-outage.md`、`tzdata-update.md`、`oauth-app-credentials-rotation.md`（scheduling-and-calendar の 12 節） | E6 の `calendar-change-sync`・`timezone-handling`・`google-calendar-oauth-write` で作成 |
| 組織の IdP の障害、SAML の証明書の期限、誤った設定の解決（`effective_settings` の不一致 1 件以上。ticket）、集計の停止 | `sso-idp-outage.md`、`saml-certificate-expiry.md`、`settings-misresolution.md`、`usage-rollup-backfill.md`（accounts-and-admin の 12 節） | E6 の `org-sso-oidc`・`org-sso-saml`・`settings-registry-and-resolver`・`usage-reports` で作成 |
| 付け替えの時間の SLO（1 時間で 90% 未満。page） | `media-node-failure.md`（media-server-sfu の 15 節） | E7 の `media-node-failover` で作成 |
| ENA の上限の超過（1 分に 1 以上。page、1 台なら ticket） | `media-node-allowance-exceeded.md`（media-server-sfu の 15 節） | E7 の `load-l0-l2` で作成（指標の収集は E1 の `ena-metrics-collection`） |
| worker の異常終了（1 時間に 3 以上。page） | `mediasoup-worker-died.md`（media-server-sfu の 15 節） | E7 の `worker-died-recovery` で作成 |
| 制御の回復の遅れ（page）、Valkey の切り替え（page） | `actor-host-failover.md`、`valkey-failover-meetings.md`（signaling の 17 節） | E7 の `actor-failover-drill` で作成 |
| 空きの不足（`fleet_headroom` が目標の 50% を 10 分。page）、朝の立ち上がりの予測の外れ | `media-capacity-shortage.md`、`morning-ramp-scaling.md`（capacity の 11 節） | E7 の `predictive-scaling` で作成 |
| Shield Advanced の EIP の保護の付け外し | `shield-eip-protection.md`（security の 16 節） | E7 の `shield-advanced-onboarding` で作成 |
| 録画の失敗（`failed` が 1 時間で 1% 超。page） | `recorder-failures.md`（recording-and-transcription の 14 節） | E8 の `recorder-rtp-capture` で作成 |
| 合成の待ち行列の滞留 | `recording-compose-backlog.md`（同上） | E8 の `recording-compose` で作成 |
| 字幕の遅れ・停止（p95 5 秒を 10 分。ticket、全体の停止は page）、Transcribe の上限 | `transcribe-outage.md`、`transcribe-quota.md`（同上） | E8 の `transcriber-live-captions` で作成 |
| ごみ箱の削除の停止、保全と開示の請求 | `recording-purge.md`、`recording-legal-hold.md`（同上。中身は法務の L4・L8 の後） | E8 の `recording-retention-trash-hold` で作成 |
| E2EE の鍵の更新の遅れ（`e2ee.rekey_slow` の率 1% 超。ticket）、復号の失敗の増加 | `e2ee-rekey-slow.md`、`e2ee-decrypt-failures.md`（e2ee の 17 節） | E9 の `e2ee-rekey-on-leave` で作成 |
| AS の中間 CA の鍵の漏えい、外部の送り手の鍵の入れ替え（月次） | `e2ee-as-key-compromise.md`、`e2ee-external-sender-key-rotation.md`（e2ee の 17 節） | E9 の `e2ee-credentials-as`・`mls-delivery-service` で作成 |
| Node の計画した停止（drain） | `node-drain.md`（media-server-sfu の 15 節） | E10 の `make-before-break-migration` で作成 |
| 公開 API の過負荷、Webhook の配送の滞留、止めた受け口、トークンの漏えい | `public-api-overload.md`、`webhook-backlog.md`、`webhook-endpoint-disabled.md`、`oauth-token-leak.md`（api-and-webhooks の 13 節） | E11 の `api-rate-limits`・`webhook-delivery`・`oauth-authorization-server` で作成 |
| 組織の削除 | `org-deletion.md`（accounts-and-admin の 12 節） | E12 の `org-deletion-and-user-offboarding` で作成 |
| 捜査機関からの照会 | `law-enforcement-request.md`（security の 16 節。中身は法務の L4 の後） | E12 の `law-enforcement-request-handling` で作成（法務：L4） |
| アプリの更新の停止と戻し | `desktop-app-update-rollback.md`（clients の 15 節） | E13 の `desktop-electron-shell` で作成 |
| SIP トランクの障害、不正な発信の急増、IVR の文言の更新、Phone Bridge の容量 | `sip-trunk-outage.md`、`toll-fraud-response.md`、`ivr-prompt-update.md`、`phone-bridge-capacity.md`（telephony の 12 節） | E14 の `sip-edge-and-call-controller`・`dial-out-with-guards`・`dial-in-ivr`・`phone-bridge` で作成 |
| K8 の超過（月次。ticket） | [capacity.md](../architecture/capacity.md) の 6 節 | 定期の確認（5 節）。計算は E1 の `cost-dashboard-k8` |

「E12 までに作る」ものは、上の表の E1〜E12 の Story の行のすべてである（GA の判定の条件。[quality.md](../quality.md) の 5 節）。各行の Story は [roadmap.md](../roadmap.md) にある。

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| AZ の障害の訓練（`media-staging`。負荷のボットで会議を載せ、1 つの AZ の Media Node を全部止める） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の F（合格基準は [quality.md](../quality.md) の 4.3 節） |
| 東京のリージョンの障害の訓練（staging・`media-staging`。RTO 1 時間、大阪で受けられる参加者の数） | 四半期 | 同上 |
| 本番の switchover（大阪で受けて戻す） | 年 1 回 | 同上 |
| PITR からの復元 | 四半期 | 同上 |
| 大阪の待機の構成の確認 | 月次 | [infrastructure.md](../architecture/infrastructure.md) の 8.4 節 |
| Actor・Media Node・Valkey・TURN の障害の注入 | 週次（`media-staging`） | [delivery.md](../architecture/delivery.md) の 2.3 節 |
| make-before-break の移動の訓練 | 四半期 | [ADR-0055](../decisions/0055-media-node-rolling-replacement.md) の Confirmation |
| DDoS の防御のモードの試験（`media-lab`）と、Shield の保護を加えて外す手順の訓練 | 防御のモードは四半期と Media Node の変更の時、手順は半年 | [incident-response.md](incident-response.md) の「メディアの IP への DDoS」 |
| インシデント対応の机上訓練（メディアの IP への DDoS、録画の漏えい） | 年 1 回 | [incident-response.md](incident-response.md) |
| 負荷試験（L1 の一部を週次、L3〜L5 はリリース前と半年ごと） | 週次・半年 | [capacity.md](../architecture/capacity.md) の 7 節 |
| **K8 の月次の確認**（請求、送ったバイト、参加者・分、下りの平均。Edge の閾値の送出 10 Gbps） | 月次 | [capacity.md](../architecture/capacity.md) の 6 節、[ADR-0050](../decisions/0050-disaster-recovery-and-edge-migration.md) |
| キャパシティの見直し（台数、点の平均、TURN、クォータ） | 月次 | [capacity.md](../architecture/capacity.md) の 8 節 |
| 設定の監査（待合室もパスコードもない会議、`effective_settings`、E2EE の受け手、保持の期限） | 日次（自動） | [quality.md](../quality.md) の 4.2 節 |
| TURN の踏み台の合成の試験 | 日次（自動） | [security.md](../architecture/security.md) の 10 節 |
| 合成の監視の会議の結果の確認 | 日次 | [observability.md](../architecture/observability.md) の 7 節 |
| TURN の静的な秘密の入れ替え | 90 日 | `turn-secret-rotation.md`（E2） |
| `ip_prefix_hash` の pepper の入れ替え（前の pepper を 30 日残す） | 30 日 | [meeting-security.md](../architecture/meeting-security.md) の 10 節 |
| E2EE の外部の送り手の鍵の入れ替え | 月次 | `e2ee-external-sender-key-rotation.md`（E9） |
| 参加のトークンの署名の鍵の入れ替え | 年 1 回 | [security.md](../architecture/security.md) の 5 節 |
| Media Node・TURN の AMI の定期の入れ替え（OS・カーネル・mediasoup の更新） | 月次（波で出す） | [deploy-and-rollback.md](deploy-and-rollback.md) |
| 運用者のアクセスのレビュー | 四半期 | [security.md](../architecture/security.md) の 7 節 |
| 外部のペンテスト | GA の前（E12）、以後年 1 回 | [security.md](../architecture/security.md) の 10 節 |
| 訓練の記録の見直し（目標の未達を Intent へ） | 四半期 | 各 runbook の「事後」 |

## 6. 作成済みの runbook

| runbook | 中身 |
| --- | --- |
| [incident-response.md](incident-response.md) | 共通の進め方と、Media Node の障害の波、TURN の過負荷、メディアの IP への DDoS、シグナリングの再接続の嵐、内容・秘密の出力 |
| [deploy-and-rollback.md](deploy-and-rollback.md) | 制御の側、Media Node、TURN、Web クライアント、フラグ、Terraform の出し方と戻し方 |
| [disaster-recovery.md](disaster-recovery.md) | AZ の障害、東京のリージョンの障害（大阪への切り替え）、Aurora・Valkey の障害、論理的な破損、訓練 |

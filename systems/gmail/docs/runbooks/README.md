# Runbooks: Gmail

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節にある。SLI の計測とアラートの条件の実装は [observability.md](../architecture/observability.md) にある。表と置き場所は [data-model.md](../architecture/data-model.md)。**SLO の値とアラートの一覧の正本はこの文書** で、値を変えるときは、この文書を先に変える。

この題材は、外部の事業者との関係の上で動く。受信は送り手の MTA の再試行に、送信は相手の事業者の評判の判断に依る。本システムの障害だけでなく、**送信の IP がブロックリストに載る・相手の事業者に迷惑メールの箱へ入れられる** ことも、利用者から見れば障害である（5 節）。

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| MX の受け付けの可用性 | 外部の見張りの接続のうち、220 と 250 まで通ったもの（東京と大阪の副 MX を合わせる） | **月間 99.99%**（NFR-007） | 1 時間のバーンレート 14.4 倍・6 時間で 6 倍で呼び出し、3 日で 1 倍でチケット。エラーバジェットを使い切ったら、修正以外のデプロイを止める | |
| SMTP の応答 | DATA の終わりの 250 が、1 MiB まで 2 秒以内 | **p99 2 秒**（NFR-003） | p99 が 5 秒を 10 分超えたら呼び出し | |
| 受信の遅れ | 見張りのメールの、250 からクライアントに見えるまで | **p50 2 秒・p95 10 秒・p99 30 秒**（NFR-001、K2） | p95 が 60 秒を 5 分超えたら呼び出し | ○ |
| 受け付けたメールの欠け | 見張りのメールの、送った番号と届いた番号の差。スプールと配送の突き合わせの不一致 | **0**（NFR-004、K1） | 1 件で呼び出し（SEV1 の候補）。GC を `ops.blob_gc_enabled` で止める | ○ |
| 送信の受け付け | 送信の依頼のうち、5xx・時間切れでないもの（上限の超過は除く） | **月間 99.95%**（NFR-007） | MX と同じバーンレート | |
| 送信の遅れ | 見張りのメールの、窓の後から外部の MX への最初の試行まで | **p95 5 秒・p99 30 秒**（NFR-002、K3） | p95 が 60 秒を 10 分超えたら呼び出し | |
| 送信の到達 | 外部の見張りのアカウントに送った見張りのメールのうち、受信箱に入ったもの | **100%**（K7） | 1 つの事業者で 15 分続けて迷惑メールの箱か不達なら呼び出し（5 節） | ○ |
| Web・JMAP・IMAP の可用性 | 要求のうち、5xx・時間切れでないもの | **月間 99.9%**（NFR-007） | MX と同じバーンレート | |
| 同期の通知 | 変更から接続中のクライアントへの通知まで | **p95 2 秒・p99 5 秒**（NFR-006、K6） | p99 が 30 秒を 5 分超えたら呼び出し | ○ |
| 検索 | 検索の要求のうち、1 秒以内に返ったもの（NVMe のアカウント） | **p99 1 秒**（NFR-005、K5） | 1 時間続けて超えたらチケット | |
| 検索の新しさ | 見張りのメールが検索に出るまで | **p95 10 秒・p99 60 秒**（NFR-005） | p99 が 10 分を超えたらチケット | |
| 選別の報告の率 | 受信箱に届いたメールのうち、迷惑メールと報告されたもの | **0.05% 以下**（NFR-008） | 1 日の値が超えたらチケット、2 倍で選別の当番を呼び出し | ○ |
| 選別の誤判定の代わり | 迷惑メールの箱・隔離のメールのうち、迷惑メールではないと報告・解除されたもの | **前の 7 日の平均の 1.5 倍以内**（NFR-009） | 超えたら直近のモデル・規則を戻し、チケット | ○ |
| 分離 | 応答の監査の不一致（アカウント、組織） | **0**（NFR-010、K8） | 1 件で呼び出し（SEV1 の候補） | ○ |
| 後方散乱 | 受け付けた後に、確かめられない MAIL FROM へ送った DSN | **0** | 1 件でチケット、10 件で呼び出し | ○ |
| blob の突き合わせ | blob の目録の行のうち、S3 のオブジェクトのないもの | **0** | 1 件で呼び出し（SEV1 の候補） | ○ |

- SLO の窓は 30 日の移動の窓（報告は暦の月）。エラーバジェットを使い切ったら、信頼性の作業を機能より先にする。デプロイの前に残りを確かめる。
- **数えないもの**：SMTP の時点の拒否（5xx は判定の結果）、上限の超過（429・452 4.2.1）、送信の上限の超過。ただし率の急な上がりは、判定の誤りの兆候として見る。社内の見張りのアカウントは SLO の計算から除き、別に見る。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う（[quality.md](../quality.md) の 4.1 節）。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分。リージョンの障害は、受信の受け付け RTO 0（大阪の副 MX）、メタデータ RPO 1 分、blob とスプール RPO 15 分、配送と閲覧の再開 RTO 1 時間（NFR-004）。
- 本家のサービスの SLA は、公式の資料で確かめなかった（**未検証**）。

## 2. 上限と容量のパラメーター

値の正本は、各 ADR と領域の文書にある（一覧は [architecture/README.md](../architecture/README.md) の 6 節の「数値の正本」）。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 受信の大きさ | SIZE 50 MiB、1 トランザクションの宛先 100 | [ADR-0002](../decisions/0002-accept-then-filter.md) | — |
| DATA の終わりの検査の予算 | 10 秒 | 同上 | — |
| 接続の速さの上限 | 層ごと・IP・/24・ASN ごとの GCRA（[inbound-smtp.md](../architecture/inbound-smtp.md) の 6.2 節） | [ADR-0010](../decisions/0010-inbound-connection-tiers-and-rate-limits.md) | IP・範囲ごとの一時の引き下げ、許可の一覧への追加（記録つき） |
| 一時の絞り（評判の分からない IP） | 同じ IP を 15 分まで | 同上 | — |
| 送信の大きさ | 25 MiB（添付の合計） | NFR-011 | — |
| 個人の送信の上限 | 1 日 500 通、1 通の宛先 500（24 時間の移動の窓） | NFR-011（本家に合わせる） | アカウントごとの引き下げ（乗っ取りの疑い） |
| 組織の送信の上限 | 1 日 2,000 通、1 通の宛先 2,000（外部 500）、1 日の宛先 10,000、外部 3,000 | NFR-011（本家に合わせる） | 同上 |
| 送信の再試行 | 1・5・15・30 分、1・2 時間、以後 4 時間ごと（±20%）。期限 5 日、24 時間で遅れの通知 | [ADR-0019](../decisions/0019-mta-out-queues-throttling-and-retries.md) | — |
| 配送の待ち行列 | `inbound-delivery` と `inbound-delivery-low`。可視の時間切れ 5 分、10 回で DLQ。終わりの印は 10 秒か 1,000 件の束 | [ADR-0011](../decisions/0011-spool-commit-and-sweeper.md) | タスクの数 |
| MIME の解析 | 入れ子 32、パート 1,000、ヘッダーの部 256 KiB、2 秒、256 MiB | [ADR-0029](../decisions/0029-mime-parsing-limits-and-charsets.md) | `ops.mime_max_parts_override`（一時の引き下げだけ） |
| 元に戻す送信・予約の送信 | 5・10・20・30 秒（既定 5 秒）。予約は 100 通・1 年先まで | [ADR-0049](../decisions/0049-timed-jobs-vacation-and-scheduled-send.md) | — |
| 不在の返信 | 同じ送り手へ 96 時間に 1 回 | 同上 | — |
| IMAP の量 | 読み出し 1 時間 2.5 GB・1 日 20 GB、書き込み 1 時間 1 GB | [ADR-0059](../decisions/0059-api-rate-limits-and-third-party-push.md) | — |
| 容量 | 個人 15 GB | NFR-011 | — |
| ゴミ箱・迷惑メールの箱の期限 | 30 日 | [architecture/README.md](../architecture/README.md) の 6 節 | — |
| change log の保持 | 30 日 | [ADR-0006](../decisions/0006-sync-protocol-jmap-imap-and-modseq.md) | — |
| IMAP の同時の接続 | アカウントあたり 15 | NFR-014 | — |
| blob の GC の猶予 | 参照 0 から 7 日 | [ADR-0003](../decisions/0003-message-storage-layout-and-dedupe.md) | — |
| 受信の受け付け | — | — | `ops.inbound_accept_enabled`（東京の MX を止め、大阪の副 MX に寄せるだけ） |
| 送信の配送 | — | — | `ops.outbound_delivery_enabled`（プールごと・宛先のドメインごとに止めるだけ） |
| blob の GC・パックの詰め直し | — | — | `ops.blob_gc_enabled`、`ops.blob_repack_enabled`（止めるだけ） |
| 選別のモデル | — | — | `ops.filter_model_pinned`（前のバージョンに固定するだけ） |
| blob の鍵の破棄 | — | — | `ops.blob_shred_paused`（止めるだけ。欠けの疑いの間） |

## 3. リリースとロールバック

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。未完成の振る舞いは `release.*` のフラグの裏に置く。`release.*` は 100% の後 30 日で消す。
- **形式・判定の規則をフラグにしない。** blob の形式、change log の形、スレッドとラベルの規則、SMTP の時点の判定の表の変更は、コードのバージョンとして出し、本番の照合の指標で見る。
- **形式の変更の順序**：読む側を先に出し、全台に行き渡ってから、書く側を出す。書く側を戻しても、読む側は新しい形式を読み続ける。
- **MTA のデプロイ**：`mx-edge` と `mta-out` は 1 台ずつ入れ替える。入れ替える台は、NLB から外して新しい接続を断り（421 で送り手に他の台を使わせる）、進行中の会話と配送を終えてから止める（最大 10 分）。送信の IP を持つ台は、その IP の送信を他の台へ移してから止める。
- **選別のモデルと規則**：評価の集まりの合否 → 影の判定（7 日）→ 1% → 10% → 50% → 100% のアカウントで判定に使う。各段で 1 節の選別の指標を見て、外れたら前のバージョンに戻す（`ops.filter_model_pinned`）。
- **管理の面のデプロイの順**：マイグレーション（広げる段だけ）→ `mailstore`（ローリング）→ `jmap-api`・`push-*` → Web の資産（置くだけ）。メールボックスのシャードのマイグレーションは、シャードを 1 つずつ。
- **自動のロールバックの条件**：MX の 5xx・時間切れ、DATA の終わりの 250 の p99、受信の遅れの p95、見張りのメールの欠け、同期の通知の p99、選別の誤判定の代わりの指標の急な上がり。
- **モバイルのアプリ**：段階のリリース（1% → 10% → 50% → 100%、各 48 時間以上）。サーバーは 12 か月前までのアプリのバージョンを受ける。
- **ロールバック**：まずフラグで戻す。次に 1 つ前のイメージ（マイグレーションは広げる段だけなので、前のバージョンが今の DB で動く）。縮める段の後は前へ戻さない。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| 管理の面、Web の資産 | 平日 10〜17 時 | 金曜 15 時以降、日本の祝日の前日、年末年始、エラーバジェットを使い切っている間 |
| `mx-edge`・`mta-out` | 平日 10〜16 時。1 日 1 つの役割 | 同上。大きな配信の時期（年末年始の挨拶、大型の販売の催し）の週 |
| `mailstore`、メールボックスのシャードのマイグレーション | 平日 10〜15 時。1 日に全シャードの 1/4 まで | 同上 |
| 選別のモデル・規則の段の進め | 平日 10〜16 時 | 同上。大きなフィッシングの波の対応中は、対応の規則だけを入れる |
| Terraform（ネットワーク、IP、S3 の方針） | 平日 10〜16 時。Ops の承認 | 同上 |

- 上の時間帯と凍結は本システムの既定である。本家の運用の値ではない。

## 4. アラートと手順

核の手順は作った：[incident-response.md](incident-response.md)、[deploy-and-rollback.md](deploy-and-rollback.md)、[disaster-recovery.md](disaster-recovery.md)、[ip-blocklisted.md](ip-blocklisted.md)、[spam-wave.md](spam-wave.md)、[account-takeover.md](account-takeover.md)、[mail-delivery-backlog.md](mail-delivery-backlog.md)。下の表で「計画」のものは、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。「作る Story」の列は、そのアラートの計測と手順を作る [roadmap.md](../roadmap.md) の Story である。手順の文書は、その Story の完了の条件に含める（E17 の `runbooks-e17` でまとめて確かめる）。

| アラート（重さ） | 手順 | 作る Story |
| --- | --- | --- |
| MX の受け付けの SLO のバーンレート、DATA の終わりの遅れ（page） | 計画：`inbound-degraded.md`（大阪の副 MX への寄せを含む） | `smtp-server-core`、`slo-dashboards-alerts` |
| 受け付けたメールの欠け、スプールと配送の不一致（page、SEV1 の候補） | 計画：`accepted-mail-integrity.md`（GC の停止、スプールからの再配送を含む）。それまで [mail-delivery-backlog.md](mail-delivery-backlog.md) と [incident-response.md](incident-response.md) | `spool-and-delivery-queue`、`mailstore-deliver` |
| 配送の待ち行列の滞り（`inbound-delivery` の古いメッセージが 5 分、DLQ。page） | [mail-delivery-backlog.md](mail-delivery-backlog.md) | `spool-and-delivery-queue` |
| 迷惑メールの急な波（申し出の急増、新しいフィッシングの型。page） | [spam-wave.md](spam-wave.md) | `rules-engine`、`connection-reputation-and-limits` |
| 選別の誤判定の代わりの指標の急な上がり（page） | 計画：`filter-false-positive-spike.md`（モデルの固定と戻しを含む） | `filter-eval-and-shadow` |
| 送信の IP のブロックリストへの掲載（page） | [ip-blocklisted.md](ip-blocklisted.md)（5 節） | `feedback-loops-and-blocklist-monitoring` |
| 外部の事業者への到達の低下（見張りが迷惑メールの箱・不達。page） | 計画：`deliverability-incident.md`（5 節）。それまで [ip-blocklisted.md](ip-blocklisted.md) | `deliverability-tests`、`ip-pools-and-warmup` |
| 乗っ取りの疑いの送信の急増、送信の内容の選別の急な上がり（page） | 計画：`outbound-abuse.md`（アカウントの保留、プールの隔てを含む）。それまで [account-takeover.md](account-takeover.md) | `compromised-account-detection` |
| 送信の待ち行列の滞り、相手のドメインの絞り（ticket。大手の事業者なら page） | 計画：`outbound-queue-backlog.md` | `mta-out-queues-and-throttling` |
| 後方散乱の検出 | 計画：`backscatter.md` | `retries-and-dsn` |
| TLS の証明書の期限、MTA-STS の方針の取得の失敗（page） | 計画：`tls-and-mta-sts.md` | `mta-sts-and-tls-rpt-inbound` |
| DKIM の鍵の交換の失敗、署名の失敗の急増（page） | 計画：`dkim-signing.md` | `dkim-signing-and-key-rotation` |
| 同期の通知の遅れ、change log の追いつきの遅れ（page） | 計画：`sync-lag.md` | `push-gateway`、`change-log-and-modseq` |
| メールボックスのシャードの書き込みの遅れ、容量（page） | 計画：`mailbox-shard-pressure.md`（アカウントの移し替えを含む） | `mailbox-shards-baseline` |
| 検索の遅れ、索引の追いつきの遅れ | 計画：`search-degraded.md` | `search-node-and-placement` |
| blob の突き合わせの不一致（page、SEV1 の候補） | 計画：`blob-integrity.md`（GC と詰め直しの停止、S3 の古いバージョンからの戻しを含む） | `blob-catalog-and-refcount` |
| 分離の疑い（応答の監査。page、SEV1 の候補） | 計画：`access-leak-response.md`。それまで [incident-response.md](incident-response.md) | `mailbox-shards-baseline`、`aurora-directory-and-rls` |
| ログの走査での中身の検出 | 計画：`content-in-logs.md`（法務の L1 の後に確定） | `observability-and-mail-canary` |
| 乗っ取りの大規模な発生（サインインの失敗の急増、転送の規則の大量の作成。page） | [account-takeover.md](account-takeover.md) | `ato-detection-and-response` |
| CRR の遅れ（15 分を超える。page）、Aurora Global Database の遅延（`AuroraGlobalDBRPOLag` 10 秒が 5 分。page）、リージョンの障害 | [disaster-recovery.md](disaster-recovery.md) | `osaka-warm-standby`、`dr-failover-drill` |
| 開示の請求・捜査機関からの照会 | 計画：`legal-request.md`（法務の L4 の後に確定） | `lawful-access-framework` |
| デプロイ中の自動ロールバック | [deploy-and-rollback.md](deploy-and-rollback.md) | `ci-pipeline-baseline` |

- すべてのアラートは、対応する手順の URL を注釈に持つ（CI で検査する）。
- 計画の手順を作るまでは、[incident-response.md](incident-response.md) の一般の手順で対応する。利用者へは公表のページで知らせる（文言は法務の L7 の後）。
- どの手順でも、利用者のメールの中身を開いて調べない。ID と数と理由のコードで調べる（[ADR-0008](../decisions/0008-spam-pipeline-boundary-and-secrecy.md)）。

## 5. IP のブロックリストと到達性の障害

送信の到達は、相手の事業者の判断で決まり、本システムの中の指標だけでは見えない。次の形で検知し、対応する。

### 5.1 検知

| 信号 | 見方 | 頻度 |
| --- | --- | --- |
| 公開のブロックリストへの掲載 | 送信のプールのすべての IP（IPv4 は /24 の単位、IPv6 は /64）を、主なブロックリストに照会する | 5 分ごと |
| 外部の見張り | 外部の主な事業者の見張りのアカウントへの見張りのメールが、受信箱に入ったか、迷惑メールの箱か、不達か（[quality.md](../quality.md) の 2.2.1 節 K） | 1 分ごと |
| 相手の応答 | 宛先のドメインごとの 4xx・5xx の率と、応答の文（評判の理由を示すもの）の急な上がり | 1 分ごと |
| フィードバックループ | 外部の事業者からの苦情の報告（ARF、RFC 5965）の率。プールごと・アカウントごと | 5 分ごと |
| 事業者の評判の画面 | 外部の事業者が送信者に提供する評判の画面（登録できるもの） | 毎日 |

### 5.2 対処（[ip-blocklisted.md](ip-blocklisted.md) と計画の `deliverability-incident.md` の骨子）

1. **原因の送信を止める**：掲載・低下の直前の送信を、アカウント・組織・プールの単位で調べる（ID と数で）。原因のアカウントの送信を保留にし、疑いのプールへ移す。乗っ取りなら [account-takeover.md](account-takeover.md) へ。
2. **影響を限る**：掲載された IP・範囲を、そのプールの送信から外す（`ops.outbound_delivery_enabled` で IP ごとに止める）。同じプールの他の IP に寄せるのは、評判を広げない量に限る。相手の事業者ごとの速さを下げる。
3. **送信の待ちを守る**：止めた間の送信は待ち行列に残る（最大 5 日）。利用者には、遅れていることを画面で示す。
4. **解除を申請する**：原因を止めたことを確かめてから、ブロックリストと相手の事業者の手順に従って解除を申請する（NFR-012：掲載から 4 時間以内）。申請の記録を残す。
5. **戻す**：解除の後、IP をウォームアップの計画の量から戻す。
6. **事後**：原因（送信の上限、乗っ取りの検知、プールの分け方の欠け）を `changes/` の新しい `intent.md` として起票する。

- 受信の側の誤った掲載（本システムの MX の IP が、受信の検証のための照会で掲載されたなど）も同じ手順で扱う。
- 外部の事業者との連絡は、Ops と到達性の担当だけが行う。エージェントは調査の要約の草案まで。

## 6. 定期作業

| 作業 | 頻度 | 持ち主 |
| --- | --- | --- |
| スプールと配送の突き合わせの結果の確認 | 毎日（自動）、毎週の確認 | Ops |
| blob の目録と S3 Inventory の突き合わせ | 毎週 | Ops |
| 送信のプールの評判とウォームアップの進みの確認 | 毎週 | Ops、到達性の担当 |
| DKIM の鍵の交換 | 半年ごと（自動、結果の確認） | Ops |
| 選別の質（報告の率、誤判定の代わり、評価の集まりの結果）の確認 | 毎週 | QA、Ops |
| 報告のサンプルの置き場所の操作の監査の抜き取り | 毎月 | QA、法務 |
| DR の訓練（大阪の副 MX と切り替え） | 半年ごと | Ops |
| 費用の見直し（アカウントあたりの原価、迷惑メールの割合、S3 の要求） | 毎月 | Ops、PM |

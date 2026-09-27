# Runbooks: Kafka

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みとアラートの条件の実装は [observability.md](../architecture/observability.md) の 6〜8 節にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md と [ADR-0047](../decisions/0047-slos-synthetic-probes-and-alerts.md) は、これを計測・実装する側の記述である。値を変えるときは、この文書を先に変え、observability.md を合わせる。

## 1. SLI と SLO

外からの合成監視（probe のアカウント、東京の 3 つの AZ、`client.rack` を設定）で、ブローカーごとに毎秒 1 回の produce（`acks=all`・冪等、1 KB）と consume（`read_committed`）を流して測る（[observability.md](../architecture/observability.md) の 6 節）。

| SLI | 定義（数える場所） | Basic | Standard（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- | --- |
| 可用性（NFR-002） | 合成の produce と consume のうち、5 秒以内に成功した割合（30 日）。throttle は失敗にしない | **99.5%** | **99.95%**（S2 で 99.99%） | 2 節のバーンレートで呼び出し・チケット。予算を使い切ったら修正以外の変更を止める | |
| produce の遅延（NFR-003） | 分ごとにブローカーごとの合成の produce の p99 を出し、物理クラスタの最悪のブローカーの値をその分の値にする。30 日の分の値の p99 | **100ms** | **50ms** | p99 が目標を 15 分超えたらチケット | ○ |
| 端から端の遅延（NFR-004） | 同じ方法で、produce の開始から consume まで | **200ms** | **100ms** | 同上 | ○ |
| 受け付けた書き込みの喪失（NFR-001、SC-2） | カナリア（AUD-7）の抜け、監査（AUD-1〜6）と階層型の監査の不一致 | **0**（予算なし） | **0**（予算なし） | 1 件で呼び出し（SEV1） | ○ |
| テナントの分離（NFR-008 の前半） | 隣のテナントの確認の失敗、`tenant_boundary_violation` | **0** | **0** | 1 件で呼び出し（SEV1） | ○ |
| クォータの公平さ（NFR-008 の後半） | クォータの中なのに絞られた時間が週 5 分以内のテナントの割合 | **99.9%** | **99.9%** | 下回った週はチケット | ○ |
| 管理 API の可用性 | 管理 API の要求のうち、5xx とタイムアウトでない割合 | **99.9%** | **99.9%** | バーンレートで呼び出し（データの経路と別に数える） | |
| 反映の遅れ | 望ましい状態の変更から `observed_generation` まで p99 | **30 秒** | **30 秒** | `observed_generation` の遅れ 5 分で呼び出し | ○ |
| 論理クラスタの作成 | `requested` から `running` まで p99 | **60 秒** | **60 秒** | 1 日超えたらチケット | ○ |
| メトリクスの鮮度 | 発生から問い合わせられるまで p99 | **3 分** | **3 分** | 1 日超えたらチケット | ○ |

- **数えないもの**：合成監視の論理クラスタの上限に当たった throttle（それ自体を異常として別に見る）、降格中のブローカーの合成監視（「降格中」として別に見せる）。テナントの実際の要求の失敗は補助の指標で、SLO にしない（クライアントの誤りの `*_AUTHORIZATION_FAILED`・`POLICY_VIOLATION` を除いたサービスの失敗の急増を見る）。
- 大阪からの合成監視は、リージョンの到達性だけに使い、遅延の SLI に使わない。
- SLO は **物理クラスタごと** に計算する（1 つの物理クラスタの障害を、全体の平均で薄めない）。物理クラスタごとの週の値の分布（中央値・p90・p99）を「全体の SLO」としてダッシュボードに出す（Kora の 4.4.2 節）。
- SLO の窓は 30 日の移動の窓（報告は暦の月。`slo_monthly_reports`）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- SLA（返金の条件）は、法務の確認（intent.md の L6）の後に、この SLI から作る。
- 復旧の目標：AZ の障害は RPO 0・リーダーの移動 1 分以内。リージョンの障害は、制御面が RPO 1 分・RTO 1 時間、データ面が書き込みの経路の作り直し 4 時間・履歴の戻し 24 時間（どちらも SLA にしない。戻せる範囲は NFR-009 と [ADR-0045](../decisions/0045-osaka-disaster-recovery-scope.md)）。

## 2. エラーの予算とバーンレート

Standard の 99.95% は、30 日の予算が約 21.6 分。Basic の 99.5% は約 3.6 時間。

| 重さ | 長い窓 | 短い窓 | バーンレート | 意味 |
| --- | --- | --- | --- | --- |
| 呼び出し | 1 時間 | 5 分 | 14.4 | 1 時間で月の予算の 2% を消費 |
| 呼び出し | 6 時間 | 30 分 | 6 | 6 時間で 5% |
| チケット | 3 日 | 6 時間 | 1 | このペースで月の予算を使い切る |

- 耐久性・テナントの分離・監査の不一致は予算を持たない。1 件で呼び出す。
- **予算を使い切った物理クラスタ** では、修正以外の変更（本家の版の更新、パッチ、プラグイン、設定のロール、release フラグの拡大）を止める。信頼性の作業を機能より先にする。デプロイの前に残りを確かめる。
- 呼び出しは、SLO と、耐久性・テナントの分離・データの喪失に関わる症状に限る。原因の側の指標（CPU など）はチケットとダッシュボードにとどめる。

## 3. 上限と容量のパラメーター

値の正本は各文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 層ごとの上限（帯域、要求、パーティション、接続、`transactional.id`、グループ、圧縮のトピック、ACL、API キー） | Standard は 1 CU あたりの値 × CU（最大 10） | [multi-tenancy-and-quotas.md](../architecture/multi-tenancy-and-quotas.md) の 6 節、[ADR-0037](../decisions/0037-capacity-unit-definition.md) | 論理クラスタの単位の上書き（`logical_cluster_limits`。理由と期限を書き、監査ログに残る。`tenant-limit-override.md`） |
| 物理クラスタのパーティション、ブローカーの複製 | 10 万、4,000 | [ADR-0017](../decisions/0017-metadata-limits-and-snapshots.md) | — |
| ブローカーの設計点 | 送信と EBS の基準の帯域の 60%（W = 80 MB/秒）、ブローカーあたり Standard 3.2 CU・Basic 13.3 CU | [ADR-0048](../decisions/0048-broker-design-point-and-cost-model.md)、[capacity.md](../architecture/capacity.md) | ブローカーの台数（`broker-scale-out.md`） |
| ディスクの段階の対応 | 70%・75%（`storage.size` の拡張）・85%・90%（cordon）・95%（背圧） | [broker-and-log-storage.md](../architecture/broker-and-log-storage.md) の 5.3 節 | ローカルの保持の一時の短縮（85%） |
| 再配置 | 1 ブローカーあたり 100 MB/秒、同時 10、物理クラスタで 100 | [metadata-and-control.md](../architecture/metadata-and-control.md) の 4.3 節 | throttle の値 |
| 配置 | 得点 0.7 未満で受け入れ、平均 0.6 超で物理クラスタを計画 | [ADR-0033](../decisions/0033-logical-cluster-placement.md) | — |
| 耐久性の設定 | 複製 3、`min.insync.replicas=2`、unclean な選出の禁止、ELR | [ADR-0012](../decisions/0012-durability-settings-and-elr.md) | **変えない**（unclean な選出は `incident-response.md` の手順と承認だけ） |
| 運用のフラグ | `tiered.delete.pause`、`broker.demotion.auto`、`quota.dynamic`、`edge.ip_allowlist.enforce`、`rollout.pause` | [delivery.md](../architecture/delivery.md) の 9 節 | 各フラグ（`ops_flags` に記録） |

## 4. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md) の 5〜7 節、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- **デプロイとリリースを分ける。** デプロイは Ops が承認し（作成者と別の人）、リリース（release フラグを広げる）は PM が判断する。未完成の振る舞いは release フラグ（制御面・コンソール）か運用のフラグ（データ面）の裏に置く。
- **昇格**：
  - 制御面：main → cp-dev（自動）→ cp-staging（自動、E2E）→ cp-prod（Ops の承認。blue/green のカナリア 10% → 100%、アラームで自動の戻し。マイグレーションは expand → 移行 → contract）。
  - データ面の部品（エージェント、コーディネーター、sni-router、Envoy）：dp-dev → dp-staging → dp-prod の 1 つの物理クラスタ → 残り。Envoy は AZ ごとに 1 台ずつ、NLB の排出（300 秒）の後。1 つの AZ が終わったら 30 分待つ。
  - ブローカー：dp-dev → dp-staging → dp-verify（U1〜U6）→ dp-prod。本家の版は staging で 7 日（U7）。本番は Basic の物理クラスタ → Standard の最初の 1 つ（カナリア）→ 残りの Standard。各物理クラスタの後に 24 時間。
- **ブローカーのローリング更新**：コントローラー（1 台ずつ）→ ブローカー（AZ の順、AZ の中は 1 台ずつ）。各台の後に関門 G1〜G7 を満たすまで待つ。AZ の間に 30 分。関門を 30 分満たせなければ止めて人を呼び、自動で戻さない（[ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md)）。同時にロールする物理クラスタは 1 つ。
- **ロールバック**（[delivery.md](../architecture/delivery.md) の 6.3 節）：

| 変更 | 戻し方 |
| --- | --- |
| パッチ・プラグイン・設定だけ（本家の版は同じ） | 1 つ前のイメージの digest で、同じ関門でロールする |
| 本家の版の更新（`metadata.version` を上げる前） | 1 つ前の本家の版のイメージで、同じ関門でロールする |
| `metadata.version`（と戻せない機能の版）を上げた後 | 戻さない。前へ直す（修正のパッチか本家のパッチ版） |
| 制御面 | blue/green で前の版へ。マイグレーションは戻さない |
| データ面の振る舞い | まず運用のフラグで切る |

- `metadata.version` は、全ての物理クラスタでバイナリが揃ってから 7 日後に、Basic → Standard のカナリア → 残りの順に上げる。
- **急ぐために関門を外さない。** 戻しのロールも同じ関門を通る。

### 4.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| 制御面、データ面の部品 | 平日 10〜17 時（JST） | 月末・月初の 2 営業日（請求の締め）、年末年始、エラーの予算を使い切っている間、日次の試験（差分・行列・Jepsen・Streams）が 2 日続けて失敗している間 |
| ブローカーのロール | 平日 10〜16 時に始める。関門で止まったら翌日に持ち越してよい | 同上 |
| `metadata.version`・機能の版の引き上げ | 平日 10〜15 時 | 同上 |
| Terraform（`network`・`edge`） | 平日 10〜16 時。計画を 2 人で承認 | 同上 |

- 脆弱性の修正（重大。リモートから悪用できるもの）は 72 時間以内に取り込み、時間帯の制限を受けない。レビューと必須の CI（Jepsen の部分集合を含む）は省かない。
- 凍結の予定は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する。

## 5. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。作るまでは [incident-response.md](incident-response.md) の該当の節で対応する。アラートの条件の実装は [observability.md](../architecture/observability.md) の 8 節。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。「状態」の列の Story は、その手順を作る [roadmap.md](../roadmap.md) の Story である。

| アラート（重さ） | 条件（初期値） | 手順 | 状態 |
| --- | --- | --- | --- |
| 可用性の速いバーンレート（page）・遅いバーンレート（ticket） | 2 節 | [incident-response.md](incident-response.md) | 作成済み |
| 合成監視の連続失敗（ブローカー。page） | 1 つのブローカーで 2 分続けて 50% 以上失敗 | [incident-response.md](incident-response.md) | 作成済み |
| 合成監視の連続失敗（AZ。page、SEV2） | 1 つの AZ の全ブローカーで 1 分続けて失敗 | [incident-response.md](incident-response.md) の「AZ の喪失」 | 作成済み |
| オフラインのパーティション（page、SEV1）、min ISR を下回るパーティション（page） | `OfflinePartitionsCount` > 0 が 1 分、`UnderMinIsrPartitionCount` > 0 が 2 分 | [incident-response.md](incident-response.md) の「オフラインのパーティション」、`offline-partitions.md` | 作成済み（個別の手順は E3） |
| 複製の遅れ | URP > 0 が 10 分（ticket）、30 分（page） | [incident-response.md](incident-response.md) | 作成済み |
| コントローラー（page） | `ActiveControllerCount` の和が 1 でない状態が 1 分。投票者が 1 台でも落ちた | [incident-response.md](incident-response.md)、[disaster-recovery.md](disaster-recovery.md) の C、`controller-replacement.md` | 作成済み（個別の手順は E3） |
| カナリアの抜け（AUD-7。page、SEV1） | 成功を返した連番が 5 分読めない | [incident-response.md](incident-response.md) の「耐久性の監査の不一致」、`canary-gap.md` | 作成済み（個別の手順は E3） |
| 耐久性の監査の不一致（AUD-1〜6）、階層型の監査の重大な破れ（page、SEV1） | 1 件以上 | 同上、`durability-audit-mismatch.md`、`tiered-audit-violation.md` | 作成済み（個別の手順は E3・E4） |
| テナントの境界の拒否、隣のテナントの確認の失敗（page、SEV1） | 1 件以上 | [incident-response.md](incident-response.md) の「テナントの境界の破れ」、`tenant-boundary-violation.md` | 作成済み（個別の手順は E8） |
| 背圧・うるさい隣人（page） | 1 つのブローカーの背圧が 1 分以上。クォータの中で絞られたテナントが 15 分で 1% を超える | [incident-response.md](incident-response.md) の「うるさい隣人」、`noisy-neighbor.md` | 作成済み（個別の手順は E7） |
| エッジ（page） | NLB の AZ の健全なターゲットが 0、Envoy の上流への接続の失敗の急増、xDS の更新が 10 分ない | [incident-response.md](incident-response.md) の「エッジの不調」、`edge-az-outage.md`、`sni-router-down.md` | 作成済み（個別の手順は E12） |
| KMS のスロットリング（page） | `ThrottlingException` が 1 件以上 | [incident-response.md](incident-response.md) の「KMS のスロットリング」 | 作成済み |
| ロールの関門で停止（page） | rolling-update-guard が 30 分進めない | [deploy-and-rollback.md](deploy-and-rollback.md) の B | 作成済み |
| 本家の版の遅れ（ticket） | 最新のマイナー版の x.y.0 から 3 か月 | [deploy-and-rollback.md](deploy-and-rollback.md) の D | 作成済み |
| Global Database の遅れ（page） | `AuroraGlobalDBRPOLag` が 30 秒を 5 分超える | [disaster-recovery.md](disaster-recovery.md) の B | 作成済み |
| 大阪への写しの遅れ（ticket） | S3 RTC の `ReplicationLatency` が 15 分超、`OperationsFailedReplication` > 0 | [disaster-recovery.md](disaster-recovery.md) の B | 作成済み |
| KRaft のスナップショットの写し（ticket） | 2 時間ない | [disaster-recovery.md](disaster-recovery.md) の B | 作成済み |
| 大阪からの合成監視の全失敗（page、SEV1） | 東京の全ブローカーで 3 分 | [disaster-recovery.md](disaster-recovery.md) の A | 作成済み |
| 表にない API（page） | `UNSUPPORTED_VERSION` の件数 > 0 | `unknown-api-alert.md`（protocol-and-compatibility の 15 節） | E2 の `unknown-api-alert` で作成 |
| 古いクライアントの版を使うテナントの告知 | 計画作業 | `client-deprecation-notice.md`（同上） | E2 の `client-version-telemetry` で作成 |
| ディスクの使用率 | 70%（ticket）、85%（page）、90%（cordon の確認） | `broker-disk-pressure.md`（broker-and-log-storage の 13 節） | E3 の `disk-pressure-ladder` で作成 |
| 回復が長い | 回復の経過時間が 5 分超 | `broker-slow-recovery.md`（同上） | E12 の `broker-storage-alerts` で作成 |
| ボリュームの喪失 | I/O エラー、ログのディレクトリの失敗 | `broker-volume-loss.md`（同上） | E3 の `broker-volume-replacement` で作成 |
| クリーナーの停止（ticket） | クリーナーの最終の実行からの時間 | `log-cleaner-stalled.md`（同上） | E12 の `broker-storage-alerts` で作成 |
| オフラインのパーティションと人の判断の unclean な選出 | — | `offline-partitions.md`（replication-and-durability の 15 節） | E3 の `fault-injection-matrix` で作成 |
| 監査の不一致の調べ方 | — | `durability-audit-mismatch.md`（同上） | E3 の `durability-audit-checks` で作成 |
| カナリアの抜けの調べ方 | — | `canary-gap.md`（同上） | E3 の `canary-producer-consumer` で作成 |
| 劣化したブローカー（1 台で ticket、2 台以上で page） | 中央値の 3 倍かつ p99 50ms 超が 5 分 | `slow-broker-demotion.md`（replication-and-durability・metadata-and-control の `broker-demotion.md`・observability の `degraded-broker.md` をまとめた） | E3 の `slow-broker-demotion` で作成 |
| コントローラーの入れ替え | 投票者の喪失 | `controller-replacement.md`（metadata-and-control の 13 節） | E3 の `controller-replacement` で作成 |
| KRaft のクォーラムの喪失 | 活動中のコントローラー 0 | `kraft-quorum-loss.md`（同上。[disaster-recovery.md](disaster-recovery.md) の C を詳しくする） | E3 の `controller-replacement`・E12 の `metadata-snapshot-backup` で作成 |
| 階層型の上げの遅れ | 閉じたセグメントが 30 分上がらない（ticket）、2 時間（page） | `tiered-copy-stalled.md`（tiered-and-object-storage の 15 節） | E4 の `rsm-tenant-wrapper` で作成 |
| 階層型の監査の重大な破れ | 1 件以上 | `tiered-audit-violation.md`（同上） | E4 の `tiered-durability-audit` で作成 |
| リモートの読み取りの待ち行列の満杯 | 満杯の件数 > 0 が続く | `remote-fetch-saturation.md`（同上） | E7 の `remote-fetch-quota` で作成 |
| 論理クラスタの削除の後の東京と大阪の削除の確認 | 日次のジョブの失敗 | `tenant-tiered-data-deletion.md`（同上） | E8 の `data-deletion-verification` で作成 |
| ぶら下がったトランザクション（ticket） | 最も古い開いたトランザクションが 15 分を超える | `hanging-transaction.md`（transactions-and-idempotence の 16 節） | E5 の `hanging-txn-detector` で作成 |
| コーディネーターの読み込みが遅い | `__consumer_offsets`・`__transaction_state` の読み込み | `coordinator-load.md`（consumer-groups の `coordinator-load.md` と transactions の `transaction-coordinator-load.md` をまとめた） | E6 の `coordinator-fault-injection` で作成 |
| テナントが `transactional.id` の上限に当たった | 断った件数 | `txn-limit-exceeded.md`（transactions-and-idempotence の 16 節） | E5 の `transactional-id-limit` で作成 |
| リバランスの嵐 | ConsumerGroupHeartbeat の p99 の悪化 | `rebalance-storm.md`（consumer-groups の 15 節） | E7 の `group-request-quota` で作成 |
| 遅れのメトリクスが止まった | エージェントの遅れの計算の遅延 | `consumer-lag-collector-down.md`（同上） | E6 の `consumer-lag-collector` で作成 |
| うるさい隣人の調べ方と上書き | — | `noisy-neighbor.md`（multi-tenancy-and-quotas の 15 節） | E7 の `noisy-neighbor-suite` で作成 |
| クォータのコーディネーター（ticket） | 配分が 5 分更新されない | `quota-coordinator-down.md`（同上） | E7 の `quota-coordinator` で作成 |
| 上限の上書きの手順と監査 | — | `tenant-limit-override.md`（同上） | E7 の `tenant-limit-override` で作成 |
| テナントの境界の破れの調べ方と報告 | — | `tenant-boundary-violation.md`（security-and-acls の 16 節。multi-tenancy の `cross-tenant-exposure.md` をまとめた。報告は法務の L4） | E8 の `tenant-authorizer` で作成 |
| API キーの漏洩（シークレットスキャンの通報） | 通報 | `api-key-leak.md`（security-and-acls の 16 節） | E8 の `secret-scanning-partner` で作成 |
| 制御面が止まっているときの急ぎの失効 | — | `emergency-credential-revoke.md`（同上） | E8 の `reauth-and-revocation` で作成 |
| KMS のキーを使えない（BYOK の取り消しを含む） | EBS の付け替えの失敗、KMS の拒否 | `kms-key-access-lost.md`（同上） | E12 の `kms-and-encryption-baseline` で作成 |
| 反映の遅れ（page） | `observed_generation` の遅れが 5 分 | `agent-down.md`（control-plane-and-provisioning の 18 節） | E9 の `desired-state-reconcile` で作成 |
| 望ましい状態と実際の食い違いが戻らない | 反映の後の合成の失敗 | `reconcile-drift.md`（同上） | E9 の `desired-state-reconcile` で作成 |
| 物理クラスタの作成と burn-in | 計画作業 | `physical-cluster-create.md`（同上） | E9 の `pc-provisioner` で作成 |
| 容量（ticket・page） | ブローカーの送信・EBS が基準の 70% を 1 時間（ticket）、85% を 15 分（page）。物理クラスタの `score` が 0.6 超（ticket） | `broker-scale-out.md`（control-plane の提案。capacity の `capacity-add-brokers.md` をまとめた） | E9 の `broker-scale-out` で作成 |
| ブローカーの退役 | 計画作業 | `broker-retire.md`（control-plane の提案。metadata-and-control の `broker-decommission.md` をまとめた） | E9 の `broker-retire` で作成 |
| 止まった再配置 | 2 時間進まない | `stuck-reassignment.md`（metadata-and-control の 13 節） | E9 の `reassignment-executor` で作成 |
| 受け入れ可能な物理クラスタがない | 作成の待ちの件数 > 0 | `placement-capacity-exhausted.md`（control-plane-and-provisioning の 18 節） | E9 の `placement` で作成 |
| 管理 API の停止 | 管理 API の可用性の SLO | `management-api-outage.md`（console-and-api の 15 節） | E10 の `management-api-foundation` で作成 |
| `/v1` の廃止の告知 | 計画作業 | `api-deprecation.md`（同上） | E10 の `openapi-contract` で作成 |
| CLI・プロバイダーの公開と戻し | 計画作業 | `cli-release.md`、`terraform-provider-release.md`（同上） | E10 の `cli-provider-release` で作成 |
| 使用量の照合の不一致（ticket） | 1% を超える | `usage-reconciliation-mismatch.md`（metrics-and-billing の 15 節） | E11 の `usage-reconciliation` で作成 |
| 使用量の経路の長い停止 | 最新の分の遅れ 15 分、3 日を超える停止 | `usage-pipeline-backlog.md`（同上） | E11 の `usage-pipeline` で作成 |
| 月の締め | 計画作業 | `month-end-close.md`（同上） | E11 の `invoices` で作成 |
| 誤った請求書の訂正 | 締めの前の検査 | `invoice-correction.md`（同上。経理の確認待ち、L7） | E11 の `invoices` で作成 |
| 未払いの停止と再開 | 期限から 30 日 | `dunning-suspension.md`（同上。法務の確認待ち、L8） | E11 の `dunning-and-suspension` で作成 |
| 証明書の期限 | 30 日前（ticket）、7 日前（page） | `tls-certificate-renewal.md`（security-and-acls・infrastructure） | E12 の `tenant-certificate-rotation` で作成 |
| 1 つの AZ の Envoy の停止と降格の判断 | NLB の AZ の健全なターゲットが 0 | `edge-az-outage.md`（infrastructure の 17 節） | E12 の `edge-production` で作成 |
| sni-router の停止 | xDS の更新が 10 分ない | `sni-router-down.md`（同上） | E12 の `edge-production` で作成 |
| 大阪の EC2 の空きの確認（予約の健全性、ブローカーの型のオンデマンドの起動） | 四半期（予約が `active` でないときは ticket） | [disaster-recovery.md](disaster-recovery.md) の D-1（`osaka-capacity-check`。個別の手順にするときは同じ名前で作る） | 作成済み（予約は E12 の `osaka-standby`） |
| 合成監視の誤報の見分け方 | probe のアカウント側の障害 | `synthetic-probe-false-alarm.md`（observability の 14 節） | E12 の `synthetic-probes` で作成 |
| Strimzi の版の更新と戻し | 計画作業 | `strimzi-upgrade.md`（control-plane・delivery） | E12 の `rolling-update-guard` で作成 |
| `metadata.version` と機能の版の引き上げ | 計画作業 | `feature-version-bump.md`（delivery の 13 節。[deploy-and-rollback.md](deploy-and-rollback.md) の D を詳しくする） | E12 の `upstream-upgrade-workflow` で作成 |
| スキーマレジストリの誤った削除・破損 | ID の取得の 404 の率 | `schema-registry-restore.md`（connectors-and-schema の 12 節） | E16 の `sr-core-api` で作成 |
| 悪意のあるプラグイン | 走査、外への通信の異常 | `connector-malicious-plugin.md`（同上） | E17 の `custom-connector-upload` で作成 |
| 出口のプロキシの障害と許可リストの誤り | プロキシの健全性 | `connector-egress-proxy.md`（同上） | E17 の `connector-runtime` で作成 |

- 本家の版の取り込みの手順（protocol-and-compatibility の `upstream-upgrade.md` の候補）は、[deploy-and-rollback.md](deploy-and-rollback.md) の D にまとめた。大阪での戻し（tiered の `osaka-restore.md` の候補）は [disaster-recovery.md](disaster-recovery.md) の A-4 にまとめた。AZ の喪失（replication の `az-loss.md` の候補）は [incident-response.md](incident-response.md) の「AZ の喪失」にまとめた。

### 5.1 領域との対応

| 領域 | アラート・手順 |
| --- | --- |
| [protocol-and-compatibility.md](../architecture/protocol-and-compatibility.md) | `unknown-api-alert.md`、`client-deprecation-notice.md`、[deploy-and-rollback.md](deploy-and-rollback.md) の D |
| [broker-and-log-storage.md](../architecture/broker-and-log-storage.md) | `broker-disk-pressure.md`、`broker-slow-recovery.md`、`broker-volume-loss.md`、`log-cleaner-stalled.md` |
| [replication-and-durability.md](../architecture/replication-and-durability.md) | [incident-response.md](incident-response.md) の「AZ の喪失」「オフラインのパーティション」「耐久性の監査の不一致」、`offline-partitions.md`、`durability-audit-mismatch.md`、`canary-gap.md`、`slow-broker-demotion.md` |
| [metadata-and-control.md](../architecture/metadata-and-control.md) | `controller-replacement.md`、`kraft-quorum-loss.md`、`stuck-reassignment.md`、`broker-retire.md`、`slow-broker-demotion.md` |
| [tiered-and-object-storage.md](../architecture/tiered-and-object-storage.md) | `tiered-copy-stalled.md`、`tiered-audit-violation.md`、`remote-fetch-saturation.md`、`tenant-tiered-data-deletion.md`、[disaster-recovery.md](disaster-recovery.md) の A-4 |
| [transactions-and-idempotence.md](../architecture/transactions-and-idempotence.md) | `hanging-transaction.md`、`coordinator-load.md`、`txn-limit-exceeded.md` |
| [consumer-groups.md](../architecture/consumer-groups.md) | `rebalance-storm.md`、`coordinator-load.md`、`consumer-lag-collector-down.md` |
| [multi-tenancy-and-quotas.md](../architecture/multi-tenancy-and-quotas.md) | [incident-response.md](incident-response.md) の「うるさい隣人」、`noisy-neighbor.md`、`quota-coordinator-down.md`、`tenant-limit-override.md`、`tenant-boundary-violation.md` |
| [security-and-acls.md](../architecture/security-and-acls.md) | `tenant-boundary-violation.md`、`api-key-leak.md`、`emergency-credential-revoke.md`、`kms-key-access-lost.md`、`tls-certificate-renewal.md` |
| [control-plane-and-provisioning.md](../architecture/control-plane-and-provisioning.md) | `agent-down.md`、`reconcile-drift.md`、`physical-cluster-create.md`、`broker-scale-out.md`、`broker-retire.md`、`placement-capacity-exhausted.md`、`strimzi-upgrade.md` |
| [console-and-api.md](../architecture/console-and-api.md) | `management-api-outage.md`、`api-deprecation.md`、`cli-release.md`、`terraform-provider-release.md` |
| [metrics-and-billing.md](../architecture/metrics-and-billing.md) | `usage-reconciliation-mismatch.md`、`usage-pipeline-backlog.md`、`month-end-close.md`、`invoice-correction.md`、`dunning-suspension.md` |
| [connectors-and-schema.md](../architecture/connectors-and-schema.md) | `schema-registry-restore.md`、`connector-malicious-plugin.md`、`connector-egress-proxy.md` |
| [infrastructure.md](../architecture/infrastructure.md)、[capacity.md](../architecture/capacity.md) | [disaster-recovery.md](disaster-recovery.md)、[incident-response.md](incident-response.md) の「AZ の喪失」「エッジの不調」「KMS のスロットリング」、`edge-az-outage.md`、`sni-router-down.md`、`tls-certificate-renewal.md`、[disaster-recovery.md](disaster-recovery.md) の D-1（`osaka-capacity-check`）、`broker-scale-out.md` |
| [observability.md](../architecture/observability.md) | アラートの条件の実装側（8 節）、`synthetic-probe-false-alarm.md` |
| [delivery.md](../architecture/delivery.md) | [deploy-and-rollback.md](deploy-and-rollback.md)、`strimzi-upgrade.md`、`feature-version-bump.md` |
| [data-model.md](../architecture/data-model.md) | 索引のみ。運用の対象は各領域の文書で扱う |

## 6. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| 東京の喪失の訓練（staging。制御面の切り替え、書き込みの経路の作り直し、履歴の戻し） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の D（合格基準は [quality.md](../quality.md) の 2.4 節） |
| AZ の退避の訓練（本番。1 つの AZ のブローカーを降格してリーダーを移し、戻す） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の D、[replication-and-durability.md](../architecture/replication-and-durability.md) の 8.4 節 |
| 大阪の EC2 の空きの確認（`osaka-capacity-check`） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の D-1 |
| 大阪での本番の台数の起動の確認 | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の D |
| KRaft のクォーラムの喪失とスナップショットからの復旧（dp-verify） | 年 2 回 | [disaster-recovery.md](disaster-recovery.md) の C・D（[ADR-0015](../decisions/0015-kraft-dynamic-quorum-and-controller-sizing.md)） |
| 大阪の写しの戻しの演習（staging） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の A-4（[ADR-0019](../decisions/0019-tiered-storage-lifecycle-and-dr-copy.md)） |
| 大阪の待機の構成の確認（合成監視、Terraform の差分、Global Database と CRR の遅れ） | 月次 | [disaster-recovery.md](disaster-recovery.md)、[infrastructure.md](../architecture/infrastructure.md) の 8.2 節 |
| 耐久性の監査・階層型の監査・使用量の照合の結果の確認 | 日次 | [quality.md](../quality.md) の 4.2 節 |
| 監査・カナリアの自己検査（検証の環境で、わざと誤作動させて検出されることを確かめる） | 四半期 | [ADR-0014](../decisions/0014-durability-audit-and-fault-injection.md) の Confirmation |
| 負荷試験（T1〜T11。大きな変更の後、本家の版の取り込みの前は T8） | 各 Epic、半年ごと | [capacity.md](../architecture/capacity.md) の 11 節 |
| うるさい隣人の試験（N1〜N10） | 週次（CI） | [multi-tenancy-and-quotas.md](../architecture/multi-tenancy-and-quotas.md) の 11.3 節 |
| キャパシティの見直し（送信・EBS の使用率、パーティションの数、配置の得点、段階の移行の目安） | 月次（予測は四半期） | [capacity.md](../architecture/capacity.md)、[infrastructure.md](../architecture/infrastructure.md) の 10 節 |
| 原価の見直し（CUR ÷ 書き込みの GB、NFR-010） | 月次 | [capacity.md](../architecture/capacity.md) の 8 節 |
| SLO の月次の報告（層・物理クラスタごと、予算の消費の原因） | 月次 | 1・2 節、`slo_monthly_reports` |
| 本家の新しい版・RC の確認と取り込みの計画 | 本家の RC・リリースのたび | [deploy-and-rollback.md](deploy-and-rollback.md) の D |
| ディスクレスの KIP と本家で直っていないトランザクションの問題の確認 | 四半期 | [ADR-0020](../decisions/0020-diskless-topics-adoption.md)、[ADR-0022](../decisions/0022-exactly-once-verification.md) |
| テナント向けの証明書の更新 | ACM の更新ごと（最長 198 日） | `tls-certificate-renewal.md`（E12） |
| 上限の上書きの期限切れの確認 | 週次 | `tenant-limit-override.md`（E7） |
| cordon・降格のままのブローカーの確認 | 週次 | [metadata-and-control.md](../architecture/metadata-and-control.md) の 5 節 |
| 外部の侵入試験 | GA の前（E12）、以後年 1 回 | [security-and-acls.md](../architecture/security-and-acls.md) の 11 節 |
| インシデント対応の机上訓練（受け付けた書き込みの喪失、テナントの境界の破れを想定） | 年 1 回 | [incident-response.md](incident-response.md) |
| 訓練の記録の見直し（目標の未達を Intent へ。`dr_restores` の値を ADR-0045 の表に反映する提案） | 四半期 | 各 runbook の「事後」 |

## 7. 作成済みの手順

| 手順 | 内容 |
| --- | --- |
| [incident-response.md](incident-response.md) | 重さと役割、共通の進め方、Kafka に固有の場面（AZ の喪失、オフラインのパーティション、うるさい隣人、耐久性の監査の不一致、テナントの境界の破れ、エッジの不調、KMS のスロットリング） |
| [deploy-and-rollback.md](deploy-and-rollback.md) | ブローカーのローリング更新、関門で止まったとき、ロールバック、本家の版の取り込みと `metadata.version` |
| [disaster-recovery.md](disaster-recovery.md) | 東京 → 大阪の切り替え、写しの遅れ、KRaft のクォーラムの喪失、訓練 |

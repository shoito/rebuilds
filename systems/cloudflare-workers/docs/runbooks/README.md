# Runbooks: Cloudflare Workers

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みとアラートの条件の実装は [observability.md](../architecture/observability.md) の 5〜7 節にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md と [ADR-0053](../decisions/0053-slos-probes-and-burn-rate-alerts.md) は、これを計測・実装する側の記述である。値を変えるときは、この文書を先に変え、observability.md を合わせる。

## 1. SLI と SLO

合成監視（`probe` のアカウントから、5 リージョンの外と国内の複数の ISP の地点。利用者と同じ DNS → GA → NLB → ノードの経路）と、入口のプロキシが数える実際の要求のプラットフォームが原因の失敗の、両方で測る（[observability.md](../architecture/observability.md) の 5・6 節）。窓は 28 日の移動の窓（報告は暦の月。`slo_reports`）。

| SLI | 定義（数える場所） | SLO（S1） | NFR | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- | --- |
| 関数の実行の可用性 | リージョンごと・5 分ごとに、合成監視の成功の割合と、実際の要求のうちプラットフォームが原因の失敗でない割合の、悪い方 | **99.99%** | NFR-004 | 2 節のバーンレートで呼び出し・チケット。予算を使い切ったリージョンは配信を止める | ○ |
| 基盤の遅延 | 入口のプロキシの基盤の遅延（受けてから関数に渡すまで＋応答を返すまで） | **p50 2ms、p99 10ms** | NFR-002 | 15 分超えたらチケット | ○ |
| 冷たい起動 | コードありの冷たい起動 p99、コードなし p99（圧縮前 1MiB 以下の関数。1MiB を超える関数は大きさの帯ごとに計測して公開するが SLO にしない） | **5ms、50ms** | NFR-001 | 1 週間超えたらチケット（ランタイムの intent） | ○ |
| 国内の TTFB | 国内の ISP の地点からの最小の関数の TTFB p50 | **30ms** | K3 | 1 週間超えたらチケット | ○ |
| 制御プレーンの可用性 | 管理 API の要求のうち 5xx・タイムアウトでない割合 | **99.9%** | NFR-004 | バーンレートで呼び出し（データプレーンと別に数える） | |
| 設定の伝搬 | 変更ごとの、コミットから健全な全ノードの適用まで | **p99 10 秒** | NFR-008 | 15 分超えたら呼び出し | ○ |
| デプロイの伝搬 | デプロイごとの、全ノードの適用と中継のキャッシュの到着まで | **p99 30 秒** | NFR-008 | 同上 | ○ |
| ストレージの読み込み | KV・オブジェクト・DO の読み込みの成功の割合 | **99.99%** | NFR-004 | バーンレート | |
| ストレージの書き込み | 同じく書き込み | **99.9%** | NFR-004 | バーンレート | |
| KV の見えるまでの時間 | リージョンの組ごと、`cacheTtl=60` | **p99 70 秒** | NFR-009 | 15 分超えたら呼び出し | ○ |
| V8 の修正の遅れ | T+0 から全ノードの報告まで | **24 時間以内（100%）** | NFR-007 | T+16h で全リージョンに届いていなければ呼び出し | ○ |
| 隔離 | 脱出の探りの失敗、テナントをまたぐ到達 | **0 件**（予算なし） | NFR-006 | 1 件で呼び出し（SEV1） | ○ |
| 耐久性 | DO のカナリアの抜け・戻り、二重の持ち主の検査の失敗、KV の版の戻り、失われたキューの `msg_id` | **0 件**（予算なし） | NFR-009・010 | 1 件で呼び出し（SEV1） | ○ |
| 伝搬の取りこぼし | 60 秒で埋まらない番号の抜け | **0 件**（予算なし） | NFR-008 | 1 件で呼び出し | ○ |
| 監査の完全さ | 監査の鎖と WORM の写しの食い違い | **0 件**（予算なし） | — | 1 件で呼び出し（SEV2） | ○ |

- **プラットフォームが原因の失敗**：`internalError`、`evicted`、ホームへの転送の失敗、ランタイムのプロセスの落ち、コードの取得の失敗、外向きのプロキシの停止による失敗。利用者のコードの例外・制限の超過・利用者のオリジンの失敗は含めない。分類の表は QA が承認する（[ADR-0053](../decisions/0053-slos-probes-and-burn-rate-alerts.md)）。
- SLO は **リージョンごと** に計算する。全体の値（リージョンの要求の数で重みを付けた平均）は予算の表示にだけ使う。
- 合成監視の関数は `ci-internal` の cordon に置き、テナントと同じ制限を受ける。制限に当たったら、それ自体を異常にする。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- SLA（返金の条件）は、法務の確認（intent の L7）の後に、この SLI から作る。
- **復旧の目標**（[ADR-0051](../decisions/0051-disaster-recovery-and-honest-rpo.md)、[architecture/README.md](../architecture/README.md) の 3 節の NFR-010）：AZ の障害は RPO 0・RTO 5 分。リージョンの障害は関数の迂回で RTO 5 分。東京の全体の障害は、制御プレーンとストレージの RTO 1 時間（手動）、RPO は製品ごとの率直な値（KV の小さな値と Aurora は秒の単位で保証なし、KV の大きな値・オブジェクトは 99.9% で 15 分以内、DO は 10 秒＋15 分以内、キューは東京の回復まで止まる）。「RPO 1 分」を約束しない（**PM・Ops の確認事項**、intent の P2）。

## 2. エラーの予算とバーンレート

99.99% の 28 日の予算は約 4 分。99.9% は約 40 分。

| 重さ | 長い窓 | 短い窓 | バーンレート | 意味 |
| --- | --- | --- | --- | --- |
| 呼び出し | 1 時間 | 5 分 | 14.4 | 1 時間で予算の約 2% を消費 |
| 呼び出し | 6 時間 | 30 分 | 6 | 6 時間で約 5% |
| チケット | 3 日 | 6 時間 | 1 | このペースで予算を使い切る |

- 隔離・耐久性・伝搬の取りこぼし・監査の食い違いは予算を持たない。1 件で呼び出す。
- **予算を使い切ったリージョン** では、ランタイムの週 1 回の取り込みの波と AMI の入れ替えを止める。V8 の緊急の経路は止めない（[delivery.md](../architecture/delivery.md) の 5.2 節）。信頼性の作業を機能より先にする。
- 呼び出しは、SLO と、隔離・耐久性・データの喪失に関わる症状に限る。原因の側の指標（CPU など）はチケットとダッシュボードにとどめる。

## 3. 上限と容量のパラメーター

値の正本は各文書にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す。

| 対象 | 値 | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| 計画ごとの制限（CPU 時間、メモリ、サブリクエスト、大きさ、日ごとの枠） | 無料・有料の表 | [limits-and-billing.md](../architecture/limits-and-billing.md) の 3 節、[ADR-0038](../decisions/0038-plan-limits-and-edge-enforcement.md) | アカウントの単位の上書き（`account_limits`。理由と承認者を書き、監査ログに残る） |
| cordon ごとのプロセスの isolate の上限、外向きの方針 | 300・500・1,000、ポートと速さの表 | [ADR-0011](../decisions/0011-cordon-tiers-and-placement.md)、[abuse-and-trust-safety.md](../architecture/abuse-and-trust-safety.md) の 7.1 節 | `account_egress` の上書き（基盤の器の段階。厳しくするのは 5 分の段） |
| エッジのノードの設計点 | c7i.24xlarge で CPU 50% の 8,000 件/秒、70% で 11,200 件/秒 | [ADR-0054](../decisions/0054-capacity-design-point-and-region-sizing.md)、[capacity.md](../architecture/capacity.md) | ASG の最小・最大の台数（`region_capacity_plans`） |
| 退避の閾値 | soft 70%、hard 85%、`memory.max` は予算の 110% | [ADR-0007](../decisions/0007-isolate-lifecycle-and-dynamic-loading.md) | — |
| 性能カウンターの検知の閾値 | E3 の実験で決める | [ADR-0013](../decisions/0013-spectre-mitigations-and-dynamic-isolation.md) | `pmu_thresholds`（基盤の器。厳しくするのは 5 分の段） |
| 同時に `drain` するリージョン | 2 つまで。東京と大阪の同時は 2 人の承認 | [ADR-0017](../decisions/0017-global-accelerator-and-regional-nlb.md) | `region_flags` |
| ホームのノードの断り | CPU 70%、メモリの hard の段、50ms で応答の頭がない | [ADR-0019](../decisions/0019-route-matching-and-home-node-forwarding.md) | — |
| 一括の変更の保留 | 1 つの変更が 1 万項目超 | [ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md) | 承認（`bulk-change-approval`） |
| 運用のフラグ | `rollout.pause` など | [delivery.md](../architecture/delivery.md) の 7 節 | `platform_flags`（`ops` の種類。段階と 2 人の承認） |

## 4. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md) の 5〜10 節、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。**利用者の関数の**デプロイとロールバックは利用者の操作で、ここでは扱わない（[deployment-and-config-distribution.md](../architecture/deployment-and-config-distribution.md)）。

- **デプロイとリリースを分ける。** デプロイは Ops が承認し（作成者と別の人）、リリース（`platform_flags` の `release` の種類のフラグを広げる）は PM が判断する。未完成の振る舞いは release フラグの裏に置いてからマージする。フラグは 90 日で消す計画を持つ。
- **急ぐために関門を外さない。** 戻しも同じ関門を通る（戻しの波の速さだけを変える）。

### 4.1 ランタイムの波（cordon × リージョン）

週 1 回の取り込み（月曜）。[ADR-0055](../decisions/0055-staged-runtime-rollout-by-cordon-and-region.md)。

| 波 | 対象 | 待ち | 始め方 |
| --- | --- | --- | --- |
| W0 | ステージングの全 cordon | 2 日（月・火） | 自動（取り込みの CI の成功。性能の退行の門、WPT の門、脱出のテスト） |
| W1 | 本番の全リージョンの `ci-internal` | 4 時間 | Dev のテックリードの承認（水曜の朝） |
| W2 | 海外の 1 リージョン（最も小さいところ）の `c0-untrusted`・`c1-free` | 4 時間 | 自動 |
| W3 | 全リージョンの `c0-untrusted`・`c1-free` | 12 時間 | 自動 |
| W4 | 大阪の `c2-paid`・`cq-quarantine` | 6 時間 | 自動 |
| W5 | 全リージョンの `c2-paid`・`cq-quarantine` | 12 時間 | 自動 |
| W6 | `c3-dedicated`、研究者用のノード | — | 自動（契約で事前の通知が要る利用者には知らせる） |

- **共通の関門**（配信の制御役が 5 分ごとに、新しい版の cordon と同じ時間の前の版を比べる）：プラットフォームが原因の失敗の率 1.2 倍以内、プロセスの落ち・OOM 0、seccomp の違反 0（1 件で止めてセキュリティの当番）、冷たい起動の p99 1.1 倍以内、`exceededCpu` の率 1.2 倍以内、CPU 時間の中央値 1.05 倍以内、合成監視・探りの成功 100%。外れたら自動で止め、2 回続けば自動で戻す。
- **戻し**：ノードの前の版で、プロセスを 25% ずつ 2 分おきに起動し直す。全ノードで約 10 分。前の版に既知のセキュリティの欠陥がある場合は戻さず、V8 のフラグなどで止める。
- **互換の日付**：新しい版の最大の互換の日付は、W5 が終わるまでデプロイで受け付けない（[ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md)）。
- 波が翌週の月曜までに終わらないときは、翌週の取り込みを W0 までで止め、前の週の版の W6 を先に終える。取り込みを 2 週続けて飛ばしたら、Dev のテックリードへ上げる（`upstream-rebase-blocked`）。

### 4.2 V8 の緊急の経路

[ADR-0012](../decisions/0012-v8-24-hour-patch-pipeline.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md) の D。

| 時刻 | 段 | 承認 |
| --- | --- | --- |
| T+0 | 検知（15 分ごと）。当番を呼ぶ。進行中の通常の波を止める | 自動 |
| T+1h | 影響と重さの判断 | セキュリティの当番 |
| T+4h | 修正の版（上流のタグが T+3h までにあればそれ、なければ本番の土台に cherry-pick）、ビルド（90 分以内）、署名 | Dev の当番 |
| T+8h | 速い試験（上流の単体の一部、WPT の核、脱出のテスト、再現コード） | 自動 |
| T+10h | カナリア（`scope.node_pct = 1`。リージョンごとに 1 台、全 cordon）1 時間 | **承認 1 回目**（セキュリティの当番と Dev のテックリード） |
| T+12h | 大阪 | 当番 |
| T+16h | 全リージョン | **承認 2 回目** |
| T+24h | 全ノードの報告を確かめ、`fleet_complete_at` を書く | 当番 |

- 関門は 4.1 節と同じ値。外れたら戻さず（脆弱な版に戻るため）、原因を調べて修正の版を作り直す。
- 凍結の期間とエラーの予算の停止は、この経路を止めない。時間帯の制限も受けない。エージェントは承認しない。

### 4.3 ノードの部品（AMI）と制御プレーン

| 変更 | 経路 | 時間 |
| --- | --- | --- |
| Rust の部品（入口・外向きのプロキシ、スーパーバイザー、受け手）、OS | 週 1 回の AMI。ステージング 2 日 → 海外 1 → 大阪 → 残りの海外 → 東京。リージョンの中は 1 AZ ずつ、最小の健全な割合 90%。1 リージョンで 1 時間に全ノードの 1/3 まで | 約 3 日 |
| カーネルの重大な修正（名前空間、seccomp、cgroup、eBPF） | 臨時の AMI。同じ順を短い待ちで | 72 時間以内 |
| 中継、DO のルーター・配置・ログのノード、ゲートウェイ | 群ごとの AMI かイメージ。1 台・1 AZ ずつ。DO のホストは持ち主の割り当てを先に移す | 群ごと |
| 制御プレーン（ECS） | ステージングの後、blue/green で 10% → 100%。スキーマは拡張 → 移行 → 縮小だけ。リーダーを持つもの（採番器、配信の元、cert-manager）は新しいタスクがリースを取ってから古いものを止める | 時間帯の中 |
| CLI | W5 の完了の後に、その版の workerd を同梱して npm に（CI の OIDC、provenance） | 週 1 回 |

### 4.4 基盤の設定の段階

[ADR-0056](../decisions/0056-platform-config-staging-and-flags.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md) の G。

| 段 | 範囲 | 待ち |
| --- | --- | --- |
| 1 | ステージング | 30 分 |
| 2 | 海外の 1 リージョンの `ci-internal` | 30 分 |
| 3 | 同じリージョンの全 cordon | 30 分 |
| 4 | 大阪 | 30 分 |
| 5 | 全リージョン | — |

- 対象は基盤の器（`egress_policy`・`platform_flags`・`cordon_policy`・`pmu_thresholds`・`geo`・`runtime_release`・`runtime_rollout`・`region_key`・`account_egress`。[data-model.md](../architecture/data-model.md) の 8 節）。作成と範囲の拡大は 2 人の承認。
- セキュリティの修正（拒否の一覧への追加、閾値や外向きの方針を厳しくする、漏洩の疑いの鍵の入れ替え）は、段の待ちを 5 分に縮められる。
- 戻しは前の値を同じ段で書く新しい変更。緊急のときは Ops の責任者の承認で全範囲に一度に書いてよい。
- 利用者の器（デプロイ、ルート、シークレット、停止）と `region_flags`（`drain`）は速い経路のまま。

### 4.5 時間帯と凍結

| 対象 | 時間帯（JST） | 凍結（修正だけ） |
| --- | --- | --- |
| ランタイムの W1 以降、AMI の入れ替え、基盤の器の段 2 以降 | 平日 10〜17 時に始める。波の自動の進行は時間帯の外でも続けてよい（関門は常に判定する） | 月末・月初の 2 営業日（請求の締め）、年末年始、大きな催しの日、エラーの予算を使い切っている間（そのリージョン）、日次の試験（Jepsen の形、脱出のテスト、WPT）が 2 日続けて失敗している間 |
| 制御プレーン | 平日 10〜17 時 | 同上 |
| Terraform（`network`・`edge`） | 平日 10〜16 時。計画を 2 人で承認。複数のリージョンを 1 回で変えない | 同上 |

- V8 の緊急の経路とカーネルの重大な修正は、時間帯と凍結の制限を受けない。レビューと必須の CI（脱出のテスト、WPT の核）は省かない。
- 凍結の予定は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する（E12 の `freeze-and-error-budget`）。

## 5. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。作るまでは [incident-response.md](incident-response.md) の該当の節か、[deploy-and-rollback.md](deploy-and-rollback.md)・[disaster-recovery.md](disaster-recovery.md) の該当の段で対応する。アラートの条件の実装は [observability.md](../architecture/observability.md) の 7 節。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。「状態」の列の Story は、その手順を作る [roadmap.md](../roadmap.md) の Story である。

### 5.1 呼び出し・チケットのアラート

| アラート（重さ） | 条件（初期値） | 手順 | 状態 |
| --- | --- | --- | --- |
| 関数の実行の可用性の速いバーンレート（page）・遅いバーンレート（ticket） | 2 節 | [incident-response.md](incident-response.md) | 作成済み |
| リージョンの合成監視の全失敗（page、SEV1 の候補） | 1 つのリージョンで 2 分 | [incident-response.md](incident-response.md) の「リージョンの退避」、`region-drain` | 作成済み（個別の手順は E4 の `region-drain`） |
| 東京の全体の障害（page、SEV1） | 東京の合成監視・制御プレーン・ストレージの同時の失敗が 5 分 | [disaster-recovery.md](disaster-recovery.md) | 作成済み |
| 脱出の探りの失敗、テナントをまたぐ到達の疑い（page、SEV1） | 1 件 | [incident-response.md](incident-response.md) の「サンドボックスの脱出の疑い」、`sandbox-probe-failure` | 作成済み（個別の手順は E3 の `escape-test-suite`） |
| seccomp の違反（page、セキュリティの当番） | 1 件 | 同上、`seccomp-violation` | 作成済み（個別の手順は E3 の `seccomp-allowlist`） |
| V8 の Critical・High の修正の検知（page、セキュリティの当番） | 検知のジョブ | [incident-response.md](incident-response.md) の「V8 の 0-day」、[deploy-and-rollback.md](deploy-and-rollback.md) の D | 作成済み |
| V8 の修正の遅れ（page） | T+16h で全リージョンに届いていない | 同上 | 作成済み |
| 設定の伝搬の SLO（page） | 設定 p99 が 10 秒を 15 分超える | [incident-response.md](incident-response.md) の「設定の伝搬の停止」、`config-propagation-slow` | 作成済み（個別の手順は E5 の `propagation-sli`） |
| 全体の古さ（page） | 中継の先頭が 5 分進まない | 同上、`config-origin-down` | 作成済み（個別の手順は E5 の `config-outbox-sequencer`） |
| 取りこぼし（page） | 60 秒で埋まらない抜け 1 件 | 同上 | 作成済み |
| 局所の遅れのノード（1 台で ticket、2 台以上で page） | 1 リージョンで | `node-lmdb-rebuild` | E5 の `snapshots-and-bootstrap` で作成 |
| 監視のスレッドの心拍の途切れ（page）、ランタイムのプロセスの落ちの繰り返し（page） | 1 件、5 分に 5 回 | `runtime-crash-loop` | E2 の `isolate-metrics` で作成 |
| プロセスの OOM（ticket、3 件/時で page） | 1 件 | `runtime-process-oom` | E2 の `isolate-table-and-eviction` で作成 |
| 冷たい起動の嵐（ticket） | 冷たい起動の率 5% を 10 分 | `cold-start-storm` | E2 の `warm-pool-and-code-cache` で作成 |
| ランタイムの配信の関門で停止・自動の戻し（page） | 配信の制御役 | [deploy-and-rollback.md](deploy-and-rollback.md) の A・B | 作成済み |
| 隔離の急増（page、セキュリティの当番） | `cq-quarantine` が 1 ノードで 32 に達する | `quarantine-surge` | E3 の `quarantine-cordon` で作成 |
| PMU を読めないノード（ticket） | 起動・動作中の検査の失敗 | `pmu-unavailable-node` | E1 の `edge-node-ami` で作成 |
| CPU の余裕の不足（page） | リージョンの CPU 50% を 15 分、ASG が最大 | `capacity-headroom-low` | E1 の `asg-warm-pool` で作成 |
| ホームの断りの率（ticket） | 20% を 10 分 | `home-refusal-high` | E4 の `home-node-forwarding` で作成 |
| メモリの予算の圧迫（ticket） | hard 85% に入るプロセスが増える | `memory-budget-pressure` | E2 の `isolate-table-and-eviction` で作成 |
| 証明書の期限（14 日で ticket、7 日で page） | 最小の残りの日数 | `cert-renewal-failure` | E4 の `cert-manager-acme` で作成 |
| ACME の上限（ticket） | 発行の失敗の率、上限の到達 | `acme-rate-limit` | 同上 |
| 専用のリゾルバーの障害（page） | リゾルバーの健全性 | `egress-resolver-down` | E4 の `egress-proxy` で作成 |
| KV の古さの SLO（page） | 見えるまでの p99 が 70 秒を 15 分 | `kv-staleness-slo-breach` | E7 の `kv-consistency-checker` で作成 |
| KV の版の戻り（page、SEV1） | 1 件 | [incident-response.md](incident-response.md) の「耐久性の違反」 | 作成済み |
| KV の区画の偏り（ticket） | 区画あたり 700 単位/秒 | `kv-hot-partition` | E7 の `kv-entries-and-writer` で作成 |
| KV の L2 の劣化（ticket） | Valkey のシャードの障害 | `kv-l2-degraded` | E7 の `kv-l2-cache` で作成 |
| オブジェクトのゲートウェイの 5xx（page） | 5xx の率 | `object-gateway-5xx` | E8 の `object-gateway-skeleton` で作成 |
| ライフサイクルの遅れ（ticket） | 48 時間超 | `object-lifecycle-lag` | E8 の `object-lifecycle` で作成 |
| DO のカナリアの抜け・戻り（page、SEV1） | 1 件 | [incident-response.md](incident-response.md) の「耐久性の違反」、`do-unavailable-objects` | 作成済み（個別の手順は E9 の `do-placement-leases`） |
| DO のホストの同時の停止（page） | AZ の障害 | `do-host-failure-storm` | E9 の `do-placement-leases` で作成 |
| DO のログのノードのディスク（70% で ticket、90% で page） | 使用率 | `do-log-node-disk-pressure` | E9 の `do-log-nodes` で作成 |
| キューの `msg_id` の喪失（page、SEV1） | 1 件 | [incident-response.md](incident-response.md) の「耐久性の違反」 | 作成済み |
| キューのバックログの急増・ディスパッチャーの停止・DLQ の急増（ticket → page） | バックログ、確認が進まない、DLQ への移動 | `queue-backlog-growth`・`queue-dispatcher-stuck`・`queue-dlq-surge` | E10 の `queue-dispatcher`・`queue-dlq` で作成 |
| cron の `missed`（ticket） | 1 件 | `cron-missed-fires` | E10 の `cron-scheduler` で作成 |
| 複製の遅れ（Aurora。page） | `AuroraGlobalDBRPOLag` が 30 秒を 5 分 | [disaster-recovery.md](disaster-recovery.md) | 作成済み |
| 複製の遅れ（S3・DynamoDB。ticket） | S3 の `ReplicationLatency` 15 分、`OperationsFailedReplication` > 0、DynamoDB の `ReplicationLatency` 60 秒 | [disaster-recovery.md](disaster-recovery.md) | 作成済み |
| バンドルの `pending_regions`（ticket） | 1 時間続く | `bundle-region-pending` | E5 の `bundle-multi-region-put` で作成 |
| 一括の変更の保留（ticket） | 1 万項目超の変更 | `bulk-change-approval` | E5 の `config-outbox-sequencer` で作成 |
| 監査の鎖の食い違い（page、SEV2） | 1 件 | `audit-chain-mismatch` | E12 の `audit-chain-worm` で作成 |
| ADK の復号の急増（page、セキュリティの当番）、包み直しのジョブの役割の窓の外の使用（page） | 平常の 10 倍を 5 分、CloudTrail の事象 | [incident-response.md](incident-response.md)、`kms-key-compromise` | E3 の `key-rewrap-rotation` で作成 |
| break-glass の使用（知らせ） | 1 件 | `break-glass` | E1 の `operator-access` で作成 |
| 使用量の経路の遅れ（ticket） | 束の遅れ p99 が 5 分 | `usage-pipeline-lag` | E11 の `usage-aggregator` で作成 |
| 使用量の突き合わせの差（ticket） | 0.5% 超 | `usage-reconciliation-mismatch` | E11 の `usage-reconciliation` で作成 |
| 利用者のログの取り込みの遅れ（ticket） | p99 60 秒を 15 分 | `tenant-logs-ingest-lag` | E6 の `tenant-logs` で作成 |
| tail のハブの停止（page） | ハブの健全性 | `tail-hub-down` | E6 の `tail` で作成 |
| テレメトリの経路の停止（ticket） | AMP への書き込みの失敗が 5 分 | [incident-response.md](incident-response.md) | 作成済み |
| シークレットスキャンの受け口の停止（page） | 受け口の失敗 | `secret-scanning-endpoint-down` | E1 の `secret-scanning-partner` で作成 |
| レート制限の保存の停止（ticket） | Valkey の停止 | `rate-limit-store-down` | E1 の `api-rate-limit` で作成 |
| WPT の退行で取り込みが止まった（ticket） | 門の失敗 | `wpt-regression-blocked` | E2 の `wpt-gate` で作成 |
| 取り込みの停止（ticket） | 2 週続けて飛ばした | `upstream-rebase-blocked` | E2 の `weekly-upstream-intake` で作成 |
| AMI の入れ替えの停止（ticket） | ASG の入れ替えが進まない | [deploy-and-rollback.md](deploy-and-rollback.md) の F | 作成済み |
| 基盤の設定の検証の失敗（page） | ノードがスキーマに合わない値を拒否 | [deploy-and-rollback.md](deploy-and-rollback.md) の G | 作成済み |
| 位置の表の更新の失敗（ticket） | 古さ 30 日に近づく | `geoip-table-update-failed` | E4 の `geoip-provider` で作成 |
| 既定のドメインの遮断（page） | 外部の一覧の監視 | `default-domain-blocklisted` | E12 の `default-domain-blocklist-monitor` で作成 |
| フィッシングの通報の急増（page） | 同じ雛形の大量の通報 | `phishing-report-surge` | E12 の `abuse-intake` で作成 |
| 採掘の検知（ticket） | 静的な印・宛先 | `crypto-mining-detected` | E12 の `abuse-static-scan` で作成 |
| インスタンスの容量の不足（page） | ASG の起動の失敗 | `instance-capacity-shortage` | E1 の `asg-warm-pool` で作成 |
| TGW のピアリング・PrivateLink の障害（page） | 経路の健全性 | `tgw-peering-down`・`privatelink-endpoint-down` | E1 の `network-vpc-tgw` で作成 |
| リージョンの KMS の障害（page） | 新しいノードが健全にならない | `regional-kms-outage` | E1 の `kms-keys` で作成 |
| 決済の失敗の急増（page） | 引き落としの失敗の急増 | `payment-failure-wave` | E11 の `payments` で作成 |

### 5.2 計画作業と申し出への対応

| 手順 | 使う場面 | 状態 |
| --- | --- | --- |
| [deploy-and-rollback.md](deploy-and-rollback.md) | ランタイムの波、戻し、seccomp の違反で止まった、V8 の緊急の配信、毎週の空の実行と四半期の訓練、AMI、基盤の設定（旧候補の `runtime-rollback`・`v8-emergency-patch`・`v8-patch-drill`・`ami-rollout-stuck`・`platform-config-rollback` をこの文書の B・D・E・F・G にまとめた） | 作成済み |
| [disaster-recovery.md](disaster-recovery.md) | 東京の全体の障害と大阪への切り替え、戻し、訓練 | 作成済み |
| `control-plane-dr-epoch` | Aurora の切り替えの後のエポックと補正、失われた変更の一覧（disaster-recovery の 2 を詳しくする） | E1 の `cp-dr-epoch-drill` で作成 |
| `kv-region-failover` | KV の大阪への切り替え（disaster-recovery の 3） | E7 の `kv-osaka-replica` で作成 |
| `object-region-failover` | オブジェクトの大阪への切り替え（disaster-recovery の 4） | E8 の `object-osaka-crr` で作成 |
| `do-region-evacuate` | DO のリージョンの退避（disaster-recovery の 5） | E9 の `do-jurisdiction-and-dr` で作成 |
| `cron-region-failover` | cron の大阪への切り替え（disaster-recovery の 6） | E10 の `cron-region-failover` で作成 |
| `region-drain` | `drain` の配り方（制御プレーンが止まっているときの中継への直接の書き込みを含む） | E4 の `region-drain` で作成 |
| `accelerator-failover` | `edge.<brand>.<domain>` の予備への切り替えと戻し | E4 の `global-accelerator` で作成 |
| `relay-rebuild` | 中継の作り直し | E5 の `regional-relay` で作成 |
| `hostname-takeover-report` | ホスト名を奪われたという申し出 | E4 の `custom-domains` で作成 |
| `egress-false-deny` | 正当な宛先が拒否される | E4 の `egress-proxy` で作成 |
| `egress-attack-report` | `<Brand>-Worker` での攻撃の通報 | E12 の `abuse-intake` で作成 |
| `object-public-cache-purge`・`object-access-key-compromise` | 公開のキャッシュの消去が届かない、アクセスキーの漏れ | E8 の `object-public-buckets`・`object-gateway-skeleton` で作成 |
| `do-pitr-restore-support` | 利用者の復元の依頼の支援 | E9 の `do-pitr` で作成 |
| `secret-in-logs-report` | 「ログにシークレットが出た」の申し出 | E6 の `tail` で作成 |
| `clickhouse-recovery` | ClickHouse のノードの障害と複製の回復 | E6 の `tenant-logs` で作成 |
| `support-log-access` | 運用者の期限付きのログの閲覧の申請と承認 | E6 の `support-log-access` で作成 |
| `cli-release-rollback` | 壊れた CLI の版の `deprecate` | E6 の `cli-weekly-release` で作成 |
| `invoice-close`・`invoice-correction` | 月の締め、赤の請求書 | E11 の `invoices` で作成 |
| `quota-block-release` | 誤った `quota_block`・`spend_capped` の解除と返金 | E11 の `quota-block-and-spend-cap` で作成 |
| `leaked-token` | トークンの漏れ | E1 の `api-tokens` で作成 |
| `account-takeover-suspected` | ログインの異常の申し出 | E1 の `login-and-stepup` で作成 |
| `audit-export-request` | 18 か月を超える監査ログの依頼 | E12 の `audit-export` で作成 |
| `abuse-false-positive` | 誤った停止の戻し | E12 の `trust-safety-console` で作成 |
| `csam-report`・`law-enforcement-request` | 児童の性的な搾取の内容の通報、捜査機関の照会（手順は法務の確認の後に確定。L1・L4） | E12 の `legal-requests` で作成 |
| `vulnerability-report-triage` | 報奨金の報告の受付と連絡 | E12 の `vulnerability-program` で作成 |
| `account-deletion-restore` | 削除の予約の中の戻し | E12 の `account-deletion` で作成 |
| `ga-byoip-migration` | BYOIP への移行（S2） | E13 の `byoip-ranges` で作成 |

### 5.3 領域との対応

各領域の文書の「runbooks に載せるもの」を、この節の表に集めた。重なる候補は 1 つにした（上の「旧候補」）。SLI の追加の依頼は、[observability.md](../architecture/observability.md) の 2 節の表に反映してある。

## 6. 定期作業と訓練

| 作業 | 頻度 | 手順（合格基準は [quality.md](../quality.md) の 2.2.1・2.4 節） |
| --- | --- | --- |
| V8 の緊急の経路の空の実行 | 毎週 | [deploy-and-rollback.md](deploy-and-rollback.md) の E |
| V8 の修正の実際の訓練（過去の修正を本番で 24 時間以内） | 四半期 | 同上 |
| ランタイムの戻しの訓練（前の版へ 10 分以内） | 四半期 | [deploy-and-rollback.md](deploy-and-rollback.md) の B（[ADR-0055](../decisions/0055-staged-runtime-rollout-by-cordon-and-region.md)） |
| 東京の全体の障害の訓練（staging。製品ごとの RPO・RTO の記録） | 半期 | [disaster-recovery.md](disaster-recovery.md) の「訓練」 |
| リージョンの `drain`（本番。3 つ目を拒むことを含む） | 四半期 | [incident-response.md](incident-response.md) の「リージョンの退避」、`region-drain` |
| 予備のアクセラレーターへの切り替え | 半期 | `accelerator-failover` |
| 予備の発行局での発行と更新 | 四半期 | `cert-renewal-failure` |
| `kv-region-failover`・`do-region-evacuate`・`cron-region-failover`（検証の環境） | 四半期 | 各手順 |
| DR の鍵（大阪の `cp-adk-wrap` だけでシークレットの受付とデプロイ） | 半期 | [ADR-0047](../decisions/0047-kms-key-hierarchy.md) の Confirmation |
| break-glass の訓練 | 四半期 | `break-glass` |
| 監査の突き合わせの自己検査（staging でわざと書き換えて検出される） | 四半期 | `audit-chain-mismatch` |
| 法的な保全の訓練（削除・掃除・TTL の書き出しが止まる） | 四半期 | [abuse-and-trust-safety.md](../architecture/abuse-and-trust-safety.md) の 14 節 |
| 本番の各 cordon の脱出の探り・偽のシークレットの探りの結果の確認 | 日次（探りは 1 時間ごと） | [quality.md](../quality.md) の 4.2 節 |
| 使用量の突き合わせ・監査の突き合わせの結果の確認 | 日次 | 同上 |
| RSK・RDK の入れ替え（段階的に配る） | 毎月 | [security.md](../architecture/security.md) の 4.2 節 |
| 負荷試験（T1〜T10。大きな変更の後） | 各 Epic、半年ごと | [capacity.md](../architecture/capacity.md) の 10 節 |
| キャパシティの見直し（CPU の利用率、断りの率、isolate の数、ASG の最小との差） | 月次（予測は四半期） | [capacity.md](../architecture/capacity.md) |
| 原価の見直し（CUR、行ごとの原価と請求の比 1.3 以上、K8 の式） | 月次 | [limits-and-billing.md](../architecture/limits-and-billing.md) の 5.5・6 節 |
| SLO の月次の報告（リージョンごと、予算の消費の原因） | 月次 | 1・2 節、`slo_reports` |
| プラットフォームが原因の失敗の分類の見直し（合成監視と実際の要求の差） | 月次 | [observability.md](../architecture/observability.md) の 6.1 節（QA と） |
| 古いフィーチャーフラグの確認（90 日） | 週次 | [delivery.md](../architecture/delivery.md) の 7 節 |
| 上流の workerd・V8 の取り込みの計画、パッチの行数と `upstreamable` の PR の確認 | 毎週・四半期 | [ADR-0006](../decisions/0006-workerd-fork-and-upstream-tracking.md) |
| 性能カウンターの検知の閾値と誤検知の見直し | 四半期 | [ADR-0013](../decisions/0013-spectre-mitigations-and-dynamic-isolation.md) |
| 外部の侵入試験 | GA の前（E12）、以後年 1 回 | [sandbox-and-security.md](../architecture/sandbox-and-security.md) の 9.3 節 |
| インシデント対応の机上訓練（サンドボックスの脱出、V8 の 0-day を想定） | 年 1 回 | [incident-response.md](incident-response.md) |
| 訓練の記録の見直し（目標の未達を Intent へ。`dr_drills` の値を ADR-0051 の表に反映する提案） | 四半期 | 各 runbook の「事後」 |

## 7. 作成済みの手順

| 手順 | 内容 |
| --- | --- |
| [incident-response.md](incident-response.md) | 重さと役割、共通の進め方、この基盤に固有の場面（サンドボックスの脱出の疑い、V8 の 0-day、リージョンの退避、設定の伝搬の停止、耐久性の違反、テナントをまたぐデータの報告） |
| [deploy-and-rollback.md](deploy-and-rollback.md) | ランタイムの波と関門、戻し、seccomp の違反で止まったとき、V8 の緊急の配信、毎週の空の実行と四半期の訓練、AMI、基盤の設定 |
| [disaster-recovery.md](disaster-recovery.md) | 東京の全体の障害、制御プレーン・KV・オブジェクト・DO・cron の大阪への切り替え、キューとログの扱い、利用者への連絡、戻し、訓練 |

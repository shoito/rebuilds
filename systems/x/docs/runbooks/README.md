# Runbooks: X

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節にある。SLI の計測とアラートの条件の実装は [observability.md](../architecture/observability.md) にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability の文書は、これを計測・実装する側の記述にする。値を変えるときは、この文書を先に変える。

## 1. SLI と SLO

| SLI | 良いイベント（数える場所） | SLO（S1） | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| タイムラインの読み出しの可用性 | ホーム（フォロー中・おすすめ）・プロフィール・会話の要求のうち、5xx・時間切れでないもの。おすすめの代わりの並びで返したものは良い（App API） | **月間 99.95%**（NFR-004） | 1 時間のバーンレート 14.4 倍・6 時間で 6 倍で呼び出し、3 日で 1 倍でチケット。エラーバジェットを使い切ったら、修正以外のデプロイを止める | |
| 投稿の書き込みの可用性 | 投稿の要求のうち、確定か検証の拒否で答えたもの（Post） | **月間 99.9%**（NFR-004） | 同上 | |
| DM の可用性 | DM の送信のうち、確定か検証の拒否で答えたもの（DM） | **月間 99.9%**（NFR-004） | 同上 | |
| 公開 API の可用性 | 5xx・時間切れでない応答。`429` は良い（Public API） | **月間 99.9%**（NFR-004） | 同上（画面と別に数える） | |
| 投稿の書き込みの遅延 | 投稿の API の応答 | **p99 300ms**（NFR-001） | p99 が 1 秒を 10 分超えたら呼び出し | |
| fan-out の遅延 | 投稿の確定から、監視用のフォロワーの読み出しに出るまで（合成監視の組。プッシュとプルの両方） | **p95 5 秒、p99 30 秒**（NFR-002） | 合成監視の p99 が 30 秒を 10 分超えたら呼び出し。Fanout の SQS の最古のメッセージが 60 秒を超えたら呼び出し | ○ |
| タイムラインの読み出しの遅延 | ホーム（フォロー中）の最初のページ、おすすめの最初のページ、作り直し | **フォロー中 p99 300ms、おすすめ p99 800ms、作り直し p99 2 秒**（NFR-003） | フォロー中の p99 が 1 秒を 10 分超えたら呼び出し。それ以外は 1 日続けて超えたらチケット | ○ |
| 見える範囲の分離 | 抜き取りの監査の `hide_unexplained` の件数（説明のつく不一致を除く。[quality.md](../quality.md) の 4.2 節、[observability.md](../architecture/observability.md) の 7 節） | **0**（NFR-009、K3） | 1 件で呼び出し（SEV1 の候補） | ○ |
| 削除・措置の反映 | 削除・措置から、全経路（写し、検索、プロフィール、公開の URL、CDN のメディア）で見えなくなるまで（合成監視。[observability.md](../architecture/observability.md) の 4.2 節） | **p99 60 秒**（NFR-009） | p99 が 5 分を超えたら呼び出し | ○ |
| カウンター | 確定から表示まで、照合の後の差 | **p95 5 秒、差 0**（NFR-006） | 消費者の遅れ（`IteratorAge`）が 60 秒を 10 分超えたらチケット。照合の後に差が残ったらチケット | ○ |
| 閲覧の数の誤差 | データレイクの集計との差 | **2% 以内**（NFR-006） | 1 日の差が 2% を超えたらチケット | ○ |
| 検索 | 投稿から検索に出るまで、検索の応答 | **p95 15 秒、p99 500ms**（NFR-007） | 索引の遅れの p95 が 1 分を 15 分超えたらチケット、5 分を超えたら呼び出し | ○ |
| 通知 | 出来事から通知の行、プッシュの送信 | **p95 5 秒、p95 10 秒**（NFR-008） | p95 が 1 分を 15 分超えたらチケット | |
| DM の配信 | 送信から、オンラインの相手の端末まで | **p95 1 秒**（NFR-008） | p95 が 5 秒を 10 分超えたら呼び出し | |
| 法令の期限 | 削除の申出のうち、期限の中で判断と通知を済ませたもの | **100%**（NFR-010、K6） | 期限の 48 時間前に未処理ならチケット、24 時間前で呼び出し（T&S の当番）。期限の値は法務の L1 の後 | ○ |
| 命に関わる通報の初動 | 優先度の最も高い通報のうち、1 時間以内に初動したもの | **100%**（NFR-010） | 30 分で未着手なら呼び出し（T&S の当番） | ○ |
| 公開 API の遅延 | 1 件の読み出し | **p99 500ms**（NFR-012） | 1 日続けて超えたらチケット | |
| メディアの処理 | 画像の投稿に使えるまで、1 分の動画の変換 | **p95 3 秒、p95 60 秒**（NFR-013） | p95 が 3 倍を 30 分超えたらチケット | |

- SLO の窓は 30 日の移動の窓（報告は暦の月）。エラーバジェットの方針は他の題材と同じ（使い切ったら信頼性の作業を機能より先にする）。
- **数えないもの**：検証の拒否（文字数の超過、レート制限の `429`、権限の拒否）。ただし、拒否の率の急な上がりは版のずれや規則の誤りの兆候として見る。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分、リージョンの障害は RPO 1 分・RTO 1 時間（NFR-005）。写しは作り直す。

## 2. 上限と容量のパラメーター

値の正本は各領域の文書と ADR にある。Ops が運用で変えてよいのは、下の「運用で変えるもの」だけで、変えたら記録を残す（AppConfig の変更の履歴と監査ログ）。

| 対象 | 値（S1 の既定） | 正本 | 運用で変えるもの |
| --- | --- | --- | --- |
| fan-out の閾値 | フォロワー 1 万でプル、0.8 倍でプッシュへ戻す。瞬間のピーク（`burst`）では `max(2,000, T / 2)` | [ADR-0003](../decisions/0003-timeline-fanout-hybrid.md)、[ADR-0015](../decisions/0015-fanout-pipeline-and-burst-control.md)（E5 の PoC で確定） | `ops.fanout.pull_threshold`、`ops.fanout.burst_*` |
| ホームの写し | 800 件、最後の読み出しから 30 日で期限切れ | [timeline-fanout.md](../architecture/timeline-fanout.md) の 12 節 | — |
| 作者の最近の投稿（`ar:`） | 全作者、7 日・200 件 | 同上 | — |
| 作り直し | フォローが 2,000 人超なら直近 3 日。全体で毎秒 500 まで、超えたら 24 時間・200 件の `partial` | [ADR-0016](../decisions/0016-timeline-rebuild-single-flight.md) | `ops.timeline.rebuild_rate`（殺到の時に下げる） |
| `tid` の生成器 | リージョンごとに 512（東京 0〜511、大阪 512〜1023）、貸し出し 60 秒。使用率 7 割でアラート | [ADR-0002](../decisions/0002-post-ids-and-ordering.md)、[posts-and-ids.md](../architecture/posts-and-ids.md) の 8 節 | — |
| Kinesis の保持、outbox の送った行 | 7 日、1 時間 | [ADR-0005](../decisions/0005-event-log-and-outbox.md)、[ADR-0056](../decisions/0056-disaster-recovery-osaka.md) | — |
| カウンター | 書き戻し 60 秒、照合の静かさ 5 分 | [engagement-and-counters.md](../architecture/engagement-and-counters.md) の 8 節 | — |
| おすすめの時間の予算 | 合計 800ms（全体の締め切り 700ms） | [ADR-0006](../decisions/0006-ranking-boundary.md)、[ranking-and-recommendation.md](../architecture/ranking-and-recommendation.md) の 4.1 節 | `ops.ranking.fallback`（代わりの並びに固定する） |
| 利用者の行動の上限 | 投稿 1 日 1,000（電話の確認なし 50）、フォロー 400、DM 500 など | [api-and-rate-limits.md](../architecture/api-and-rate-limits.md) の 5.3 節（`policy.ratelimit.*`） | `ops.ratelimit.*`（スパムの攻撃の時に一時に下げる） |
| 公開 API の全体の天井 | エンドポイントの組ごと | [api-and-rate-limits.md](../architecture/api-and-rate-limits.md) の 5 節 | `ops.ratelimit.global.*` |
| SMS の送信 | 全体 3,000 通/分 | [accounts-and-auth.md](../architecture/accounts-and-auth.md) の 4.4 節 | `ops.auth.sms_per_minute`、`ops.auth.sms_provider` |
| 閲覧者の集合の写し | 寿命 1 時間、修復の遅れ 30 秒で劣化の運転 | [ADR-0012](../decisions/0012-viewer-sets-cache.md) | `ops.graph.viewer_sets_bypass` |
| 書き込みの停止 | DR の切り替えの時 | [infrastructure.md](../architecture/infrastructure.md) の 7.3 節 | `ops.writes_enabled` |

殺到の時に削る順（[capacity.md](../architecture/capacity.md) の 7 節、[ADR-0060](../decisions/0060-capacity-headroom-and-load-shedding.md)）：閲覧の取り込み（`ingest` が束を捨てる）→ おすすめ（`ops.ranking.fallback`）→ 作り直しの範囲（`ops.timeline.rebuild_rate`）→ 公開 API（`ops.ratelimit.global.*`）→ fan-out の量（`burst`、足りなければ `ops.fanout.pull_threshold`）。投稿の書き込み、`visible()`、措置の反映、法令の期限の処理は削らない。手順は `load-shedding.md`。

## 3. リリースとロールバック

流れの理由は [delivery.md](../architecture/delivery.md) にある。手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリース（フラグを広げる）は PM が判断する。未完成の振る舞いは `release.*` のフラグの裏に置く。
- **ランキングの変更は `experiment.ranking.*` で広げる。** 1% → 5% → 50% → 100%。ガードレールの指標（[ADR-0006](../decisions/0006-ranking-boundary.md)）が悪くなったら止める。
- **サーバーのデプロイの順**：マイグレーション（広げる段だけ）→ 書き込みのサービス → Relay → 消費者（Fanout、Counter、Search、Notification）→ 読み出しのサービス → Gateway（接続を 1 タスクずつ逃がす）。出来事の形を変えるときは、消費者が新旧の両方を読めるようにしてから、作る側を変える。
- **アプリ**：週 1 回の列車でストアに出す。iOS は App Store の段階的リリース（7 日で 1% → 2% → 5% → 10% → 20% → 50% → 100%。割合は選べない。止めるのは合計 30 日まで）、Android は Google Play の段階的公開（1% → 10% → 50% → 100%、各段 1 日以上）。クラッシュのないセッションの割合が前の版より 0.5 ポイント下がるか、投稿の失敗の率が前の版の 2 倍で止める。JS だけの修正は OTA（1% → 10% → 100%）。最低の版の強制はセキュリティと API の互換の理由に限る（[ADR-0062](../decisions/0062-mobile-release-and-min-version.md)）。
- **ロールバック**：まずフラグ（`release.*`・`ops.*`・`experiment.*`）で戻す。次に 1 つ前のイメージ。
- 本番へのデプロイは Ops が承認する（作成者と別の人）。
- **デプロイの時間帯と凍結**：平日 10〜17 時。凍結は、金曜 15 時以降、日本の祝日の前日、年末年始（年が変わる 0 時の瞬間のピークを含む）、大きな催し（選挙の開票、大型のスポーツの大会）の当日、エラーバジェットを使い切っている間。上の時間帯と凍結は本システムの既定で、本家の運用の値ではない。

## 4. アラートと手順

手順は [templates/runbook.md](../../../../docs/templates/runbook.md) に従う。「状態」が「作成済み」の手順はこのディレクトリにある。「計画」の手順は、「作る Story」の完了の条件に含める（E14 の `runbooks-e14` で全部そろったことを確かめる）。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する）。

| アラート（重さ） | 手順 | 状態 | 作る Story |
| --- | --- | --- | --- |
| SLO のバーンレート（タイムラインの読み出し・投稿・DM・公開 API。page・ticket）と、個別の手順のない呼び出し | [incident-response.md](incident-response.md) | 作成済み | `slo-dashboards-alerts` |
| デプロイの止める条件（5xx、遅延、消費者の遅れ、アプリのクラッシュ） | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み | `ci-pipeline-baseline`、`mobile-release-train` |
| DR の判断 | [disaster-recovery.md](disaster-recovery.md) | 作成済み | `dr-failover-workflow`、`dr-drill` |
| fan-out の遅れ（合成監視の p99、SQS の最古のメッセージ、`burst` の長さ。page） | `fanout-backlog.md`（閾値を一時に下げる、Worker を増やす、DLQ の再投入） | 計画 | `fanout-worker`、`fanout-synthetic-monitor` |
| 写しの作り直しの殺到（作り直しの率、`partial` の割合、Aurora の reader の負荷。page） | `timeline-rebuild-storm.md` | 計画 | `timeline-rebuild` |
| Valkey のノード・クラスタの喪失 | `valkey-cluster-loss.md`（クラスタごとの影響と戻し方）、`author-recent-rebuild.md`（`ar:` の読み直し） | 計画 | `valkey-clusters`、`author-recent-cache` |
| 読み出しの抜け（`timeline.freshness_miss` の `unknown`。ticket） | `freshness-miss.md` | 計画 | `freshness-metrics` |
| 見える範囲の監査の `hide_unexplained`（page、SEV1 の候補） | `visibility-leak.md` | 計画 | `visibility-audit` |
| 閲覧者の集合の修復の遅れ（30 秒。page） | `viewer-sets-repair-lag.md`（劣化の運転への切り替え） | 計画 | `viewer-sets-cache` |
| 削除・措置の反映の遅れ（page） | `takedown-propagation.md`（KeyValueStore、CDN の無効化、索引の再処理） | 計画 | `media-delivery-and-takedown` |
| outbox の最も古い行、消費者の遅れ、担当のいないシャード（ticket・page） | `event-log-lag.md` | 計画 | `outbox-relay-kinesis`、`stream-consumer-lib` |
| 関係の逆向きの表の遅れ（S2） | `graph-reverse-lag.md` | 計画（S2） | S2 の分割の Story |
| カウンターの遅れ、照合の差（ticket） | `counter-drift.md`（Aggregator の遅れ、殺到する投稿、照合の差の調べ方） | 計画 | `counter-aggregator`、`counter-writeback-reconcile` |
| 閲覧の取り込みの欠け（受け付けと集計の差、日ごとの補正） | `view-ingest-loss.md` | 計画 | `view-ingest` |
| `tid` の主キーの重複、時計の戻り、生成器の番号の使用率 7 割（page） | `tid-collision.md`（重複と時計）、`tid-lease-exhaustion.md`（番号の不足） | 計画 | `tid-generator` |
| 投稿の書き込みの遅延（p99 1 秒を 10 分） | `post-write-latency.md`（区間ごとの確かめ方） | 計画 | `post-write-path` |
| 通知の遅れ、殺到の受け手 | `notification-lag.md` | 計画 | `notification-rows` |
| プッシュの事業者の失敗、トークンの失効の急増、証明書・鍵の期限 | `push-provider-errors.md` | 計画 | `push-delivery` |
| 検索の索引の遅れ（ticket・page） | `search-index-lag.md` | 計画 | `search-indexer` |
| ランキングのガードレールの悪化、代わりの並びの割合（ticket） | `ranking-regression.md`（実験を止める） | 計画 | `ranking-guardrails` |
| 殺到の時に削る | `load-shedding.md`（2 節の順と、戻す条件） | 計画 | `load-shedding-controls` |
| 法令の期限の接近（ticket・page。T&S の当番） | `legal-deadline.md` | 計画 | `legal-takedown-intake` |
| 命に関わる通報の未着手（page。T&S の当番） | `urgent-report.md` | 計画 | `reports-intake` |
| スパムの攻撃（登録・投稿の急増。page） | `spam-wave.md`（上限の一時の引き下げ、登録の確認の強化） | 計画 | `spam-rules` |
| SMS の送信の急増 | `sms-abuse.md`（`spam-wave.md` から参照） | 計画 | `auth-signup-login` |
| 有害なメディアの照合の提供者の障害（公開のメディアの処理が止まる） | `media-hash-provider-outage.md` | 計画 | `media-hash-matching` |
| 1 つのアプリの暴走、公開 API の全体の天井 | `api-abuse.md` | 計画 | `rate-limits` |
| 乗っ取りの疑い・大量の発生 | `account-takeover.md` | 計画 | `account-takeover-response` |
| 個人データの漏えいの疑い | `data-breach.md`（報告の期限は法務の L4 の後） | 計画 | `data-lifecycle` |
| 本番のデータへの直接のアクセス | `break-glass.md` | 計画 | `audit-log` |
| OTA の束の戻し | `ota-rollback.md` | 計画 | `ota-update-server` |

## 5. 定期作業と訓練

| 作業 | 頻度 | 合格基準 |
| --- | --- | --- |
| DR の訓練（計画外の切り替え） | 四半期（staging） | [quality.md](../quality.md) の 2.4 節 |
| Valkey のタイムラインのクラスタの喪失の訓練 | 半年（staging） | 同上 |
| 瞬間のピークの負荷試験（年が変わる 0 時の形） | 年 1 回（12 月の前）と、fan-out の大きな変更の後 | NFR-002 の p99 30 秒、NFR-003 |
| 法令の申出の合成の案件での訓練 | 四半期 | 期限の超過 0、手順の抜け 0 |
| 生成器の貸し出しと時計の監視の確かめ | 月 1 回 | 貸し出しの重なり 0 |
| 本人だけの表の RLS の監査 | 四半期 | [data-model.md](../architecture/data-model.md) の 3 節の一覧と、DB の FORCE RLS の設定が一致 |
| Valkey の数のクラスタの喪失の訓練 | 半年（staging） | [quality.md](../quality.md) の 2.4 節 |
| AZ の障害の訓練 | 半年（staging） | 同上 |
| 大阪の待機の確かめ（合成監視、Terraform の差分、複製） | 1 分〜月 1 回 | [infrastructure.md](../architecture/infrastructure.md) の 7.7 節 |
| T&S の読み出しの抜き取りの点検 | 週ごと | 理由と範囲の不一致 0（[security.md](../architecture/security.md) の 6.3 節） |
| 運用の状況の公表の集計（情報流通プラットフォーム対処法） | 法務の L1 の後に頻度を決める | — |

## 6. 作成済みの runbook

| 手順 | 内容 |
| --- | --- |
| [incident-response.md](incident-response.md) | 共通の進め方（重さ、IC、告知）と、見える範囲の漏れ・届かない・数のずれの最初の切り分け |
| [deploy-and-rollback.md](deploy-and-rollback.md) | サーバーのデプロイの順と観察、アプリの列車と段階の配布、止める条件、戻し方 |
| [disaster-recovery.md](disaster-recovery.md) | 大阪への切り替えの 9 段、`ar:` の先の作成、outbox の送り直し、東京へ戻す |

他の手順は 4 節の「計画」の列にある。各 Story で作る。

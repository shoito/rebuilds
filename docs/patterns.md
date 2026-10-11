# 題材をまたぐパターンの索引

同じ設計の問題が、いくつもの題材に形を変えて出てくる。この文書は、テーマごとに「どの題材のどの文書から読むとよいか」をまとめた索引である。設計そのものは各題材の文書と ADR にあり、ここでは説明し直さない。

- 「最初に読む」は、そのテーマが題材の主な論点になっていて、いちばん詳しく書いてある題材。
- 「資料」は前提知識の資料（GitHub Pages）の節、「ADR」は設計の決定。
- どの題材にも共通する土台（RLS、UUIDv7、outbox、冪等、フラグ）は、先に [共通の前提知識](https://shoito.github.io/rebuilds/docs/primer/index.html) を読む。

## 読む順の道筋

目的に合わせて、題材を次の順に読むと、前の題材の知識が次の題材の前提になる。

| 道筋 | 順 | 身につくこと |
| --- | --- | --- |
| はじめの一歩 | Slack → Stripe → GitHub | outbox と配信、冪等と台帳、権限とイベントの配信。どの題材にも出る土台 |
| お金 | Stripe → Mercari → Airbnb → Shopify | 複式簿記の台帳、預かりと決着、結果の分からない決済、売り越しの防止 |
| 共同編集と同期 | Figma → Notion → Linear → Dropbox → Google Calendar | 権威サーバー、CRDT、ローカルファースト、ファイルの衝突、差分同期のトークン |
| 大量のイベント | X → Datadog → YouTube | ファンアウト、数の集計、時系列の保存、取り込みの割り当て、配信 |
| 業務のプラットフォーム | Salesforce → ServiceNow → Workday | メタデータ駆動、ワークフローと SLA、有効日付、給与の計算 |
| リアルタイムと位置 | Slack → Zoom → Uber | 常時の接続、メディアの中継、位置の索引とマッチング |
| 信頼と安全 | Auth0 → Gmail → X → Mercari | 認証と攻撃の防御、送信者の認証と迷惑メール、モデレーション、不正 |

## ロールから探す

PM・Dev・QA・Ops のそれぞれが、特に手本にできる題材。各題材の資料の最初の節「この題材から学べること」に、ロールごとの学びと、読む設計の文書（PM は intent と roadmap、Dev は architecture と ADR、QA は quality、Ops は runbooks）をまとめている。

| ロール | 題材 | 学べること |
| --- | --- | --- |
| PM | [Slack](https://shoito.github.io/rebuilds/systems/slack/docs/primer/index.html#learn) | spec・plan・quality が揃った変更の実例。価値を 3 つに絞り、未読数を近似と割り切る |
| PM | [メルカリ](https://shoito.github.io/rebuilds/systems/mercari/docs/primer/index.html#learn) | 法令の結論を待つ値を設定に切り出し、結論まで本番で有効にしない |
| PM | [Uber](https://shoito.github.io/rebuilds/systems/uber/docs/primer/index.html#learn) | 制度の線引き（運送の主体）から範囲を決め、法令の論点をフラグと記録で本番の関門にする |
| PM | [Workday](https://shoito.github.io/rebuilds/systems/workday/docs/primer/index.html#learn) | 誤り 0 件のゴールデンデータと 3 か月の並行稼働を、切り替えの判定にする |
| Dev | [Airbnb](https://shoito.github.io/rebuilds/systems/airbnb/docs/primer/index.html#learn) | 日付の範囲の排他の制約で、同じ夜を二度売らないことを DB が拒む |
| Dev | [Shopify](https://shoito.github.io/rebuilds/systems/shopify/docs/primer/index.html#learn) | 熱い在庫の行を分け、注文をちょうど 1 回にし、他人のコードを砂場で動かす |
| Dev | [GitHub](https://shoito.github.io/rebuilds/systems/github/docs/primer/index.html#learn) | 3 つの複製の合意で、成功を返した push を失わない |
| Dev | [Notion](https://shoito.github.io/rebuilds/systems/notion/docs/primer/index.html#learn) | テキストは CRDT、構造はサーバーの順序と使い分け、最初から論理シャードを持つ |
| QA | [Linear](https://shoito.github.io/rebuilds/systems/linear/docs/primer/index.html#learn) | 本物の同期のコードを決定的なシミュレーターで毎晩 20 万の列に通す |
| QA | [Stripe](https://shoito.github.io/rebuilds/systems/stripe/docs/primer/index.html#learn) | お金の不変条件を性質にし、コネクタの障害注入と照合で確かめ続ける |
| QA | [Workday](https://shoito.github.io/rebuilds/systems/workday/docs/primer/index.html#learn) | 給与の期待値を、実装と独立したゴールデンデータセットで持つ |
| QA | [Auth0](https://shoito.github.io/rebuilds/systems/auth0/docs/primer/index.html#learn) | RFC から拒否の側のテストを作り、通してはいけない要求を先に決める |
| Ops | [Datadog](https://shoito.github.io/rebuilds/systems/datadog/docs/primer/index.html#learn) | 監視のサービス自身を、別のアカウントの自己監視とデッドマンスイッチで見張る |
| Ops | [Zoom](https://shoito.github.io/rebuilds/systems/zoom/docs/primer/index.html#learn) | 音声と映像の体感の品質を、回線の劣化の下の数値の SLO にする |
| Ops | [Gmail](https://shoito.github.io/rebuilds/systems/gmail/docs/primer/index.html#learn) | 送信の評判、IP のブロックリスト、迷惑メールの波を運用の手順で扱う |
| Ops | [Google カレンダー](https://shoito.github.io/rebuilds/systems/google-calendar/docs/primer/index.html#learn) | tz データベースの改正という、外から来る時限の変更を運用で受ける |

## テーマ別

### 台帳（複式簿記）

お金や在庫を「残高の列の書き換え」ではなく「追記だけの仕訳の和」で持つ。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **Stripe**（最初に読む） | 勘定科目、熱い口座の分割 | [資料](https://shoito.github.io/rebuilds/systems/stripe/docs/primer/index.html#ledger)・[ADR-0003](../systems/stripe/docs/decisions/0003-double-entry-ledger.md)・[ADR-0016](../systems/stripe/docs/decisions/0016-hot-accounts-and-ledger-sharding.md) |
| Mercari | 預かりと売上金、ポイントのロット | [資料](https://shoito.github.io/rebuilds/systems/mercari/docs/primer/index.html#escrow)・[ADR-0003](../systems/mercari/docs/decisions/0003-escrow-and-double-entry-ledger.md)・[ADR-0039](../systems/mercari/docs/decisions/0039-points-as-separate-lot-accounts.md) |
| Airbnb | 予約ごとの預かりの決着、為替 | [資料](https://shoito.github.io/rebuilds/systems/airbnb/docs/primer/index.html#money)・[ADR-0005](../systems/airbnb/docs/decisions/0005-payments-hold-capture-and-ledger.md)・[ADR-0046](../systems/airbnb/docs/decisions/0046-chart-of-accounts-and-journal-types.md) |
| Shopify | 在庫の移動の台帳 | [ADR-0023](../systems/shopify/docs/decisions/0023-inventory-movements-ledger-and-reconciliation.md) |
| Uber・YouTube | 精算と照合、収益の分配と丸め | [Uber ADR-0025](../systems/uber/docs/decisions/0025-ledger-settlement-and-reconciliation.md)・[YouTube ADR-0057](../systems/youtube/docs/decisions/0057-revenue-ledger-share-calculation-and-rounding.md) |
| Workday | 有給の付与の台帳、給与の仕訳の書き出し | [ADR-0024](../systems/workday/docs/decisions/0024-annual-leave-grant-ledger.md)・[ADR-0037](../systems/workday/docs/decisions/0037-payroll-journal-export.md) |

### ステートマシン

状態と遷移を決定表で決め、遷移の関数を 1 か所に置き、期限で自動に進める。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **Stripe**（最初に読む） | 結果が分からない状態、3DS の待ち | [資料](https://shoito.github.io/rebuilds/systems/stripe/docs/primer/index.html#payment-intent)・[ADR-0010](../systems/stripe/docs/decisions/0010-payment-intent-state-machine.md) |
| Mercari | 取引の期限、自動の完了 | [資料](https://shoito.github.io/rebuilds/systems/mercari/docs/primer/index.html#states)・[ADR-0002](../systems/mercari/docs/decisions/0002-transaction-state-machine-and-single-purchase.md) |
| Airbnb | 予約、仮押さえ、リクエストの期限 | [ADR-0004](../systems/airbnb/docs/decisions/0004-booking-state-machine-and-holds.md) |
| Shopify | チェックアウトと注文の一意 | [ADR-0005](../systems/shopify/docs/decisions/0005-checkout-state-machine-and-exactly-once-orders.md) |
| ServiceNow | インシデント・変更・問題の過程 | [資料](https://shoito.github.io/rebuilds/systems/servicenow/docs/primer/index.html#change)・[ADR-0022](../systems/servicenow/docs/decisions/0022-process-state-machines.md) |
| Uber | 乗車の状態 | [資料](https://shoito.github.io/rebuilds/systems/uber/docs/primer/index.html#states) |
| Datadog・YouTube・X | モニターの状態、異議の期限、フォローの状態 | [Datadog ADR-0041](../systems/datadog/docs/decisions/0041-monitor-state-machine.md)・[YouTube ADR-0048](../systems/youtube/docs/decisions/0048-claim-dispute-appeal-state-machine-and-deadlines.md)・[X ADR-0011](../systems/x/docs/decisions/0011-graph-edge-state-machine-and-locking.md) |

### 一回性と熱い行（売り越し・二重予約の防止）

同じものを二度売らないことを、DB の制約で保証し、集中する行の待ちを減らす。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **Shopify**（最初に読む） | フラッシュセールの在庫、行の分割 | [資料](https://shoito.github.io/rebuilds/systems/shopify/docs/primer/index.html#hot-rows)・[ADR-0004](../systems/shopify/docs/decisions/0004-inventory-reservation-model.md)・[ADR-0020](../systems/shopify/docs/decisions/0020-inventory-slot-counters-and-reservation-sweep.md) |
| Mercari | 一品の購入、集中する出品 | [資料](https://shoito.github.io/rebuilds/systems/mercari/docs/primer/index.html#single-purchase)・[ADR-0026](../systems/mercari/docs/decisions/0026-hot-listing-purchase-admission.md) |
| Airbnb | 日付の範囲の排他の制約 | [資料](https://shoito.github.io/rebuilds/systems/airbnb/docs/primer/index.html#exclusion)・[ADR-0002](../systems/airbnb/docs/decisions/0002-availability-representation-and-double-booking.md)・[ADR-0036](../systems/airbnb/docs/decisions/0036-hot-date-admission-and-hold-limits.md) |
| Stripe | 熱い口座 | [ADR-0016](../systems/stripe/docs/decisions/0016-hot-accounts-and-ledger-sharding.md) |

### ファンアウト

1 つの出来事を、多くの受け手に配る。書く時に配るか、読む時に集めるか。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **X**（最初に読む） | 書く時と読む時の混ぜ方、有名人 | [資料](https://shoito.github.io/rebuilds/systems/x/docs/primer/index.html#fanout)・[ADR-0003](../systems/x/docs/decisions/0003-timeline-fanout-hybrid.md)・[ADR-0015](../systems/x/docs/decisions/0015-fanout-pipeline-and-burst-control.md) |
| Slack | チャンネルへの常時の接続での配信 | [資料](https://shoito.github.io/rebuilds/systems/slack/docs/primer/index.html#realtime)・[ADR-0003](../systems/slack/docs/decisions/0003-redis-pubsub-for-fanout.md) |
| YouTube | ライブのチャット、登録の通知の間隔 | [ADR-0032](../systems/youtube/docs/decisions/0032-chat-sequencer-and-batched-fanout.md)・[ADR-0054](../systems/youtube/docs/decisions/0054-notification-fanout-pacing-and-coalescing.md) |
| GitHub・Figma・Mercari | 通知、在席、保存した検索の通知 | [GitHub ADR-0016](../systems/github/docs/decisions/0016-notification-fanout.md)・[Figma ADR-0011](../systems/figma/docs/decisions/0011-presence-and-fan-out.md)・[Mercari ADR-0064](../systems/mercari/docs/decisions/0064-fanout-batching-quiet-hours-and-caps.md) |

### 共同編集と同期

複数の端末が同じデータを変え、食い違いを解く。

| 題材 | 方式 | 入口 |
| --- | --- | --- |
| **Figma**（最初に読む） | 中央の権威サーバー、プロパティごとの後勝ち | [資料](https://shoito.github.io/rebuilds/systems/figma/docs/primer/index.html#collab)・[ADR-0002](../systems/figma/docs/decisions/0002-central-authoritative-multiplayer.md) |
| Notion | テキストの CRDT とサーバーが決める構造 | [資料](https://shoito.github.io/rebuilds/systems/notion/docs/primer/index.html#text-crdt)・[ADR-0010](../systems/notion/docs/decisions/0010-text-crdt-with-server-ordered-structure.md) |
| Linear | ローカルファースト、同期 ID と差分 | [資料](https://shoito.github.io/rebuilds/systems/linear/docs/primer/index.html#localfirst)・[ADR-0002](../systems/linear/docs/decisions/0002-sync-model.md)・[ADR-0007](../systems/linear/docs/decisions/0007-sync-actions-and-range-proof-deltas.md) |
| Dropbox | 3 つの木とファイルの衝突 | [資料](https://shoito.github.io/rebuilds/systems/dropbox/docs/primer/index.html#sync)・[ADR-0006](../systems/dropbox/docs/decisions/0006-sync-conflict-model.md) |
| Google Calendar・Gmail | 変更の記録と同期のトークン、JMAP と IMAP | [Google Calendar ADR-0005](../systems/google-calendar/docs/decisions/0005-change-log-and-sync-tokens.md)・[Gmail ADR-0006](../systems/gmail/docs/decisions/0006-sync-protocol-jmap-imap-and-modseq.md) |

### 時間

有効日付、繰り返し、タイムゾーン、夏時間、tz データベースの更新。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **Workday**（有効日付） | 過去と未来の訂正、取消 | [資料](https://shoito.github.io/rebuilds/systems/workday/docs/primer/index.html#effective)・[ADR-0002](../systems/workday/docs/decisions/0002-effective-dated-data-model.md) |
| **Google Calendar**（繰り返しとタイムゾーン） | 繰り返しの展開、例外、夏時間 | [資料](https://shoito.github.io/rebuilds/systems/google-calendar/docs/primer/index.html#recurrence)・[ADR-0003](../systems/google-calendar/docs/decisions/0003-recurrence-storage-and-expansion.md)・[ADR-0008](../systems/google-calendar/docs/decisions/0008-recurrence-expansion-semantics.md) |
| Airbnb | 物件の現地の日付、tz の更新 | [ADR-0019](../systems/airbnb/docs/decisions/0019-tzdb-update-and-time-zone-recompute.md) |
| ServiceNow | 業務時間での SLA の計時 | [資料](https://shoito.github.io/rebuilds/systems/servicenow/docs/primer/index.html#sla) |

### シャーディングとセル

テナントや文書を DB・スタックに割り当て、動かす。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **Notion**（最初に読む） | ワークスペースのシャード、止めない再シャーディング | [資料](https://shoito.github.io/rebuilds/systems/notion/docs/primer/index.html#sharding)・[ADR-0003](../systems/notion/docs/decisions/0003-workspace-sharding.md)・[ADR-0028](../systems/notion/docs/decisions/0028-zero-downtime-resharding.md) |
| Shopify | ポッドとショップの移動 | [資料](https://shoito.github.io/rebuilds/systems/shopify/docs/primer/index.html#pods)・[ADR-0002](../systems/shopify/docs/decisions/0002-pods-and-shop-placement.md) |
| Slack・Stripe・ServiceNow・Datadog | セルの構成、テナントの移動 | [Slack ADR-0023](../systems/slack/docs/decisions/0023-cell-based-architecture.md)・[Stripe ADR-0031](../systems/stripe/docs/decisions/0031-active-active-cells.md)・[ServiceNow ADR-0056](../systems/servicenow/docs/decisions/0056-dedicated-cells-and-tenant-moves.md)・[Datadog ADR-0003](../systems/datadog/docs/decisions/0003-tenancy-cells-and-isolation.md) |
| Uber | 都市のセル、地理の索引の分割 | [ADR-0039](../systems/uber/docs/decisions/0039-city-cells-and-osaka-warm-standby.md)・[ADR-0011](../systems/uber/docs/decisions/0011-geo-index-sharding-lease-and-rebuild.md) |

### 速さの上限と公平さ

1 つのテナント・利用者が、他の人の分を使い切らないようにする。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **Salesforce**（最初に読む） | ガバナ制限：1 つのトランザクションの上限 | [資料](https://shoito.github.io/rebuilds/systems/salesforce/docs/primer/index.html#limits)・[ADR-0005](../systems/salesforce/docs/decisions/0005-tenancy-and-governor-limits.md) |
| Slack・Stripe・X | API の上限、トークンバケット | [Slack ADR-0029](../systems/slack/docs/decisions/0029-rate-limiting.md)・[Stripe ADR-0009](../systems/stripe/docs/decisions/0009-rate-limiting.md)・[X ADR-0047](../systems/x/docs/decisions/0047-rate-limit-token-buckets.md) |
| Auth0 | 攻撃の防御の数え方 | [資料](https://shoito.github.io/rebuilds/systems/auth0/docs/primer/index.html#attack)・[ADR-0024](../systems/auth0/docs/decisions/0024-attack-protection-counters-and-enforcement.md) |
| Datadog | 取り込みの割り当て、騒がしい隣人 | [ADR-0012](../systems/datadog/docs/decisions/0012-intake-quota-coordination.md) |

### 数を数える

視聴回数・いいね・参照の数を、速く、ほぼ正しく、後で確定させる。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **YouTube**（最初に読む） | 視聴回数の 2 段の確定 | [資料](https://shoito.github.io/rebuilds/systems/youtube/docs/primer/index.html#views)・[ADR-0007](../systems/youtube/docs/decisions/0007-two-phase-view-counting.md) |
| X | 数の集計と照合、表示回数の近似 | [資料](https://shoito.github.io/rebuilds/systems/x/docs/primer/index.html#counters)・[ADR-0023](../systems/x/docs/decisions/0023-counter-aggregation-and-reconciliation.md) |
| Dropbox | ブロックの参照の数と GC | [資料](https://shoito.github.io/rebuilds/systems/dropbox/docs/primer/index.html#gc)・[ADR-0019](../systems/dropbox/docs/decisions/0019-block-refcount-and-gc-protocol.md) |
| Datadog | 課金のためのホストの数え方 | [ADR-0054](../systems/datadog/docs/decisions/0054-metering-units-and-host-counting.md) |

### 検索と権限

索引は遅れて食い違う写し。見えてはいけないものを結果に出さない。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **GitHub**（最初に読む） | コード検索と権限の絞り込み | [ADR-0014](../systems/github/docs/decisions/0014-code-search-engine.md)・[ADR-0015](../systems/github/docs/decisions/0015-search-permission-filtering.md) |
| Dropbox・Notion・Salesforce | 共有の権限での絞り込み | [Dropbox ADR-0034](../systems/dropbox/docs/decisions/0034-search-index-and-permission-filter.md)・[Notion ADR-0023](../systems/notion/docs/decisions/0023-search-engine-and-permission-filtering.md)・[Salesforce ADR-0032](../systems/salesforce/docs/decisions/0032-search-permission-post-filter.md) |
| Mercari・X | 日本語の解析 | [Mercari ADR-0018](../systems/mercari/docs/decisions/0018-search-index-layout-and-japanese-analysis.md)・[X ADR-0025](../systems/x/docs/decisions/0025-search-engine-and-japanese-analysis.md) |
| Airbnb | 日付の範囲の空室で絞る 2 段の検索 | [資料](https://shoito.github.io/rebuilds/systems/airbnb/docs/primer/index.html#search)・[ADR-0003](../systems/airbnb/docs/decisions/0003-search-for-date-range-availability.md) |

### 鍵、金庫、監査ログ

秘密のデータを封筒の暗号化で閉じ、運用者が読むときは理由と記録を残す。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **Workday**（最初に読む） | マイナンバーの金庫、目的で縛る API、ハッシュの鎖の監査ログ | [資料](https://shoito.github.io/rebuilds/systems/workday/docs/primer/index.html#mynumber)・[ADR-0046](../systems/workday/docs/decisions/0046-purpose-bound-vault-api-and-access-log.md)・[ADR-0048](../systems/workday/docs/decisions/0048-audit-log-hash-chain-and-anchoring.md) |
| Stripe | カード情報の金庫と鍵の階層 | [資料](https://shoito.github.io/rebuilds/systems/stripe/docs/primer/index.html#pci)・[ADR-0019](../systems/stripe/docs/decisions/0019-vault-encryption-and-key-hierarchy.md) |
| Auth0 | 署名の鍵の階層と入れ替え | [資料](https://shoito.github.io/rebuilds/systems/auth0/docs/primer/index.html#keys)・[ADR-0045](../systems/auth0/docs/decisions/0045-kms-key-hierarchy.md)・[ADR-0046](../systems/auth0/docs/decisions/0046-signing-key-lifecycle.md) |
| Mercari・Airbnb | 住所の金庫、運用者の開示と監査 | [Mercari ADR-0070](../systems/mercari/docs/decisions/0070-operator-access-vault-reveal-and-audit.md)・[Airbnb ADR-0074](../systems/airbnb/docs/decisions/0074-operator-access-reveal-and-audit-chain.md) |
| Zoom | エンドツーエンドの暗号化 | [資料](https://shoito.github.io/rebuilds/systems/zoom/docs/primer/index.html#e2ee)・[ADR-0004](../systems/zoom/docs/decisions/0004-encryption-and-e2ee.md) |

### Webhook の署名と配信

外へ送るイベントを、署名し、再送し、相手の遅さや悪意から本体を守る。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **Stripe**（最初に読む） | 署名、隔離した配信 | [資料](https://shoito.github.io/rebuilds/systems/stripe/docs/primer/index.html#webhooks)・[ADR-0025](../systems/stripe/docs/decisions/0025-webhook-signing-and-isolated-delivery.md) |
| GitHub・Zoom・Shopify | 署名、Standard Webhooks、中身の預かり | [GitHub ADR-0022](../systems/github/docs/decisions/0022-webhook-signing-and-delivery.md)・[Zoom ADR-0044](../systems/zoom/docs/decisions/0044-signed-webhooks-standard-webhooks.md)・[Shopify ADR-0061](../systems/shopify/docs/decisions/0061-webhook-delivery-and-signing.md) |
| Salesforce | 外への呼び出しと SSRF の防御 | [ADR-0035](../systems/salesforce/docs/decisions/0035-webhooks-outbound-calls-and-ssrf-guard.md) |
| Shopify | 受ける側：決済の通知の inbox と照会 | [ADR-0036](../systems/shopify/docs/decisions/0036-payment-webhook-inbox-and-inquiry-schedule.md) |

### 乱用・不正・モデレーション

ML は信号、決定は規則と人。措置には根拠と異議の道を残す。

| 題材 | 何が難しいか | 入口 |
| --- | --- | --- |
| **Gmail**（最初に読む） | 迷惑メールの選別と通信の秘密 | [資料](https://shoito.github.io/rebuilds/systems/gmail/docs/primer/index.html#filtering)・[ADR-0008](../systems/gmail/docs/decisions/0008-spam-pipeline-boundary-and-secrecy.md) |
| X・YouTube | 措置のモデル、スパムとボット、年齢と子ども | [X ADR-0038](../systems/x/docs/decisions/0038-moderation-action-model.md)・[X ADR-0040](../systems/x/docs/decisions/0040-spam-and-bot-defense.md)・[YouTube ADR-0052](../systems/youtube/docs/decisions/0052-moderation-actions-age-kids-and-promotion.md) |
| Mercari・Airbnb | T&S の段と ML の境界 | [Mercari ADR-0009](../systems/mercari/docs/decisions/0009-trust-and-safety-pipeline-boundary.md)・[Airbnb ADR-0009](../systems/airbnb/docs/decisions/0009-trust-and-safety-and-ml-boundary.md) |
| Stripe | 不正の規則のエンジン | [ADR-0021](../systems/stripe/docs/decisions/0021-fraud-rules-engine.md) |
| Dropbox・GitHub | 共有のリンクの乱用、信用しない内容の隔離 | [Dropbox ADR-0028](../systems/dropbox/docs/decisions/0028-shared-link-abuse-controls.md)・[GitHub ADR-0013](../systems/github/docs/decisions/0013-untrusted-content-domain-isolation.md) |

## 題材に固有の論点

次の論点は、ほかの題材に同じ形では出てこない。その題材の資料から読む。

| 論点 | 題材 |
| --- | --- |
| Git のオブジェクトの保存と複製、merge queue | [GitHub](https://shoito.github.io/rebuilds/systems/github/docs/primer/index.html) |
| メディアの中継（SFU）と帯域の推定 | [Zoom](https://shoito.github.io/rebuilds/systems/zoom/docs/primer/index.html) |
| 地理の格子とマッチング | [Uber](https://shoito.github.io/rebuilds/systems/uber/docs/primer/index.html) |
| 時系列 DB とスケッチ、テールサンプリング | [Datadog](https://shoito.github.io/rebuilds/systems/datadog/docs/primer/index.html) |
| 変換のラダー、ABR、ライブ、著作物の照合 | [YouTube](https://shoito.github.io/rebuilds/systems/youtube/docs/primer/index.html) |
| SMTP、SPF・DKIM・DMARC、送信の評判 | [Gmail](https://shoito.github.io/rebuilds/systems/gmail/docs/primer/index.html) |
| メタデータ駆動の実行、共有の再計算 | [Salesforce](https://shoito.github.io/rebuilds/systems/salesforce/docs/primer/index.html) |
| CMDB の識別と照合 | [ServiceNow](https://shoito.github.io/rebuilds/systems/servicenow/docs/primer/index.html) |
| 日本の給与計算、源泉徴収、社会保険 | [Workday](https://shoito.github.io/rebuilds/systems/workday/docs/primer/index.html) |
| 民泊の 180 日の上限、宿泊者名簿 | [Airbnb](https://shoito.github.io/rebuilds/systems/airbnb/docs/primer/index.html) |
| 匿名の配送 | [Mercari](https://shoito.github.io/rebuilds/systems/mercari/docs/primer/index.html) |
| テーマの言語、WASM の拡張の砂場 | [Shopify](https://shoito.github.io/rebuilds/systems/shopify/docs/primer/index.html) |
| 描画のエンジン（WebGL / WASM） | [Figma](https://shoito.github.io/rebuilds/systems/figma/docs/primer/index.html) |

## この索引を直すとき

- 題材を足したら、その題材の主な論点を、上のテーマの表か「題材に固有の論点」に足す。
- 「最初に読む」は、そのテーマを題材の主な論点として扱い、資料に節を持つ題材にする。
- 「ロールから探す」は、各題材の資料の「この題材から学べること」のうち、ほかの題材より特に手本になるものを選ぶ。1 ロール 4 題材までにする。

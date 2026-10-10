# Runbook: 人気の出品と大型の企画の日

- Owner: Ops（当番）、企画の日は Ops・IC・財務の担当
- 対応するアラート: 熱い出品の検知、購入の p99 の悪化、負けの応答の p99 の悪化、DB の接続の使用率 70% 超、企画の日の定期作業
- 最終確認日: 2026-10-10

運用の方針は [README.md](README.md) の 5 節、購入の守り方は [transactions-and-state-machine.md](../architecture/transactions-and-state-machine.md) の 5 節（[ADR-0026](../decisions/0026-hot-listing-purchase-admission.md)）、容量の作業は [capacity.md](../architecture/capacity.md) の 5 節（[ADR-0077](../decisions/0077-sizing-tiers-and-campaign-prescaling.md)）、ダッシュボードは [observability.md](../architecture/observability.md) の 5 節。

## 症状

- 出品の詳細の閲覧が 1 分 1,000 を超えた、または先着の印の取り合い（`SET NX` の失敗）が 1 秒 100 を超えた出品がある（熱い出品の枠に入る）。
- 購入の p99 が 2 秒を 5 分超えた、負けの応答の p99 が 1 秒を超えた。
- 大型の企画の日（予定）。

## 影響

- 人気の出品で負けた買い手の応答が遅れる。DB の接続が尽きると、他の出品の購入も遅れる（NFR-002、NFR-007）。
- 正しさ（二重の販売なし）は DB の条件つきの更新と部分一意の索引が守るので、遅れても二重には売れない。

## 確認

1. 熱い出品の枠ごとの取り合いの数、負けの応答の p99、決済の失敗の後の出品の戻しの数。
2. core の書き込みの CPU、接続の使用率、行のロックの待ち。
3. Valkey の状態。Valkey が落ちていれば、出品ごと・タスクごとの同時実行 4 と `lock_timeout` 200ms で DB を守っている（`transactions` のタスクは最大 12 で、1 出品の DB に届く購入は 48 件まで）。
4. 出品と取引の照合（熱い出品と企画の日は 1 分ごと）の不一致と最後の成功の時刻。
5. WAF のボットのラベル、同じ端末の帯からの連打。

## 対処

**人気の出品（予定できない）**

1. 台数で受けない。`transactions` のタスクの最大（12）を上げない（48 件の上限が崩れる）。`app-api` は最小の数の余力と自動の拡大で受ける。
2. 熱い出品の Valkey の写しの更新が遅れていれば、写しの更新を優先する（outbox の優先の待ち行列）。
3. DB の接続の使用率が 70% を超えたら、その出品の購入の要求を同時実行の上限で絞る（自動）。それでも他の購入が遅れるなら、`ops.purchase_enabled` でその出品だけを一時に止め、利用者に「手続きが混み合っています」を出す。
4. ボットの連打は、WAF の規則と T&S の規則（`fraud-signals`）で絞る。
5. 出品と取引の照合の不一致が 1 件でも出たら、その出品の購入を止め、`double-sale.md`（計画）の手順、それまでは [incident-response.md](incident-response.md) の SEV1 で扱う。

**大型の企画の日（予定する）**

| いつ | 作業 |
| --- | --- |
| 14 日前まで | PM から期間、ポイントの付与の規則（法務の L4 の確認を経たもの）、想定の量（購入、検索、値下げ、通知）を受け取る。[capacity.md](../architecture/capacity.md) の 1 節の最大と比べ、超えるなら段を上げる計画を作る |
| 3 日前 | core の読み出しの写しを 1 つ、OpenSearch のデータのノードを 3 つ足す。運送会社と決済の提供者に量を知らせる。縮めた規模の負荷試験 |
| 前日 | 凍結（[README.md](README.md) の 3.1 節）。見張りの購入。担当の Ops・IC・財務を決める |
| 60 分前 | 予定の拡大：`app-api` 最小 30、`transactions` 12、`search-api` 15、`notifier-decide`（engagement）10、`notifier-send` 8、`media-processor` 10 |
| 開始 | 出品と取引、取引と台帳の照合を 1 分ごとにする。熱い出品の見張り |
| 最中 | 値下げ・新着の通知の遅れが p95 30 分を超えたら、`ops.saved_search_digest_minutes` を伸ばす。なお遅れれば `ops.fanout_enabled` で fan-out を止める。取引の通知は止めない |
| 終わり＋2 時間 | ECS の最小を戻す。照合を 5 分ごとに戻す。ポイントの付与の仕訳の数と、企画の規則の計算を照らす（財務） |
| 翌日 | 読み出しの写しと OpenSearch のノードを戻す |
| 3 営業日 | 3 者の照合。振り返り（購入の最大、熱い出品の数、SLI の消費、通知の量） |

## エスカレーション

- 照合の不一致、台帳の不変条件の違反：SEV1。IC、Dev のテックリード、財務。
- 購入の SLO のバーンレートが 1 時間 14.4 倍を超える：SEV2。企画を止めるかを PM と決める。

## 事後

- 熱い出品の数、取り合いの最大、負けの応答の p99、DB の接続の最大を記録し、`hot-listing-purchase-poc` の値（同時実行 4、`lock_timeout`、48 件）と比べる。
- 次の企画の既定の値（予定の拡大の数）に反映する。

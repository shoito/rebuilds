---
status: accepted
date: 2026-10-10
---

# ADR-0077: 部品の大きさを S1・S2・S3 の段で Terraform の変数に持ち、平常は 2 AZ で平常の山を受けられる最小の数と自動の拡大で動かす。大型の企画の日は 3 日前に core の読み出しと OpenSearch を足し、60 分前に Fargate の最小を上げる。人気の出品の急増は拡大で受けず、先着の印と出品ごとの同時実行の上限で受ける。静かな時間の終わりの通知の山は、散らしと予定の拡大で受ける

## Context

- 負荷の山は 3 種類ある（[capacity.md](../architecture/capacity.md) の 1 節）。
  - 大型の企画の日：予定でき、購入が普段の平均の 30 倍で 1 時間続き、検索・値下げ・通知も増える。
  - 人気の出品：予定できず、1 つの出品に 1 秒 5,000 件の購入の試みが集まる。
  - 静かな時間の終わり：毎日 9 時に、夜の間に止めた通知が出る（[ADR-0064](0064-fanout-batching-quiet-hours-and-caps.md)）。
- 人気の出品の山は、1 つの出品の行への集中で、台数を増やしても速くならない。購入の正しさは DB の条件つきの更新が守り、Valkey の先着の印は流量を絞るだけ（[ADR-0002](0002-transaction-state-machine-and-single-purchase.md)）。
- Fargate の自動の拡大の速さ（1〜3 分）は**未検証**で、1 秒の山には間に合わない。
- OpenSearch のノードの追加は、シャードの移りに数時間かかる。Aurora の読み出しの追加も数十分かかる。
- Shopify の題材は、ポッドの大きさの段と、セールの前もっての拡大を決めた（[Shopify の ADR-0074](../../../shopify/docs/decisions/0074-pod-size-tiers-and-pre-scaling.md)）。

## Options

1. **段の変数、最小の数と自動の拡大、企画の日の前もっての拡大。人気の出品は先着の印と同時実行の上限**
2. 常に企画の日の大きさで動かす
3. 自動の拡大だけに任せる

## Decision

1 を採用する。詳細は [capacity.md](../architecture/capacity.md) の 4・5 節。

- 段：Aurora・Valkey・OpenSearch・ECS の大きさを S1・S2・S3 の Terraform の変数に持つ。S1 は core `db.r8g.2xlarge` × 3、ledger `db.r8g.xlarge` × 2、content `db.r8g.2xlarge` × 2、Valkey `cache.r7g.xlarge` の 2 シャード、OpenSearch のデータ `r7g.2xlarge.search` × 9。
- 平常：各サービスは 2 AZ で平常の山を受けられる最小のタスクの数を持ち、CPU（60%）とキューの年齢で自動に広げる。
- 大型の企画の日：14 日前に量を受け取り、3 日前に core の読み出し 1 と OpenSearch のデータのノード 3 を足し、60 分前に `app-api`・`transactions`・`search-api`・通知・`media-processor` の最小を予定の拡大で上げ、終わりの 2 時間後に戻す。
- 人気の出品：前もって広げない。先着の印、出品の写しからの負けの応答、出品ごとの同時実行の上限（Valkey の停止の時は既定 4）で受け、最小の数の余力（`app-api` 最小 12、`transactions` 最小 6）で 1 秒 5,000 件の CPU を吸う。
- 静かな時間の終わり：60 分の散らしと、毎日 8:55〜10:05 の `notifier-decide`（engagement）と `notifier-send` の予定の拡大。

### 他の案を選ばなかった理由

- **2（常に最大）**：企画の日は月に数回で、平常の費用が倍以上になる。
- **3（自動の拡大だけ）**：拡大が 1 秒の山に間に合わない。OpenSearch と Aurora の追加は数十分〜数時間かかる。

## Consequences

- 良くなること：
  - 平常の費用を、2 AZ で平常の山を受ける大きさに抑えられる。
  - 人気の出品の山が、台数ではなく設計（先着の印と同時実行の上限）で受けられ、他の購入に響かない。
- 引き受けるコスト：
  - 企画の日の予定を Ops が 14 日前に受け取る運用が要る（[runbooks/](../runbooks/README.md) の 5.2 節）。
  - 予定にない企画並みの山（外の話題での急増）は、自動の拡大の遅れの間、検索と出品の p95 を外しうる。購入は守る。

## Confirmation

- 負荷試験（E18、[capacity.md](../architecture/capacity.md) の 7 節）：人気の出品 1 つと 100 を同時、大型の企画の日、静かな時間の終わり。合否は二重の販売 0、照合の不一致 0、NFR-002・NFR-008 の p99・p95。
- 月次のキャパシティのレビューで、段階の 8 指標と企画の日の実績を見る。

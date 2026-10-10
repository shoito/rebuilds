---
status: accepted
date: 2026-10-10
---

# ADR-0081: 部品の大きさを S1・S2・S3 の段で Terraform の変数に持ち、平常は最小の数と自動の拡大で動かす。予定した繁忙期は 7 日前にデータの部品を足し、期間中は毎日の夕方と送金の山の日に Fargate の最小を予定の拡大で上げる。熱い日付は拡大で受けず、先着の印と同時実行の上限で受ける。PMS の一斉の書き込みは速さの上限とジョブのキューで均す

## Context

- 日本の繁忙期（年末年始、ゴールデンウィーク、お盆、桜と紅葉）と大きな催しに予約が集まる。予約の最大は普段の平均の 100 倍が夕方の 1 時間（[architecture/README.md](../architecture/README.md) の 2 節）。チェックインの山の後に、送金の振り替えと送金の束の山が来る（[ADR-0005](0005-payments-hold-capture-and-ledger.md)）。
- 熱い日付（催しの日程の発表の直後の 1 秒）は 1 つのリスティングの行に集まる。行のロックは台数を増やしても速くならない（[ADR-0004](0004-booking-state-machine-and-holds.md)）。
- データの部品（Aurora の読み出しの写し、OpenSearch のノード、Valkey のシャード）は足すのに数十分から数時間かかる。Fargate の自動の拡大は 1〜3 分（**未検証**）。
- PMS は朝に料金を一斉に書き換える。S3 では core の書き込みの大半が PMS と iCal になる（[capacity.md](../architecture/capacity.md) の 3 節）。
- Mercari の題材は、段の変数と企画の日の前もっての拡大を決めた（[Mercari の ADR-0077](../../../mercari/docs/decisions/0077-sizing-tiers-and-campaign-prescaling.md)）。

## Options

1. **段の変数、最小の数と自動の拡大、予定した繁忙期の前もっての拡大、熱い日付は流量の絞りで受ける**
2. 自動の拡大だけ
3. 繁忙期の最大に合わせて常に大きく持つ

## Decision

1 を採用する。詳細は [capacity.md](../architecture/capacity.md) の 4・5 節。

- **段**：S1・S2・S3 の部品の大きさを Terraform の変数に持つ。S1 は Aurora core `db.r8g.2xlarge` × 3、ledger・content `db.r8g.xlarge` × 2、vault `db.r8g.large` × 2、Valkey 2 シャード、OpenSearch データ 3。
- **平常**：各サービスは 2 AZ で夕方の山を受けられる最小の数を持ち、CPU とキューの年齢で自動に広げる。`booking` の最大は 12（Valkey の停止の時に 1 リスティングの DB に届く同時の予約を 48 に抑える）。
- **予定した繁忙期**：30 日前に量を受け取り、7 日前に core の読み出し 1・OpenSearch のデータ 3・Valkey のシャード 2 を足し、縮めた規模の負荷試験を回す。期間中は毎日 18:00〜24:00 に `app-api`・`search-api`・`pricing`・`booking`・写しと索引の書き手の最小を上げる。チェックインの山の翌営業日に `ledger`・`payouts`・`deadline-runner` の最小を上げる。終わりの 2 日後に ECS、7 日後にデータの部品を戻す。
- **熱い日付**：前もって拡大しない。Valkey の先着の印と、リスティングごとの同時実行の上限で、DB に届く要求を絞る。負けの応答は写しから返す。
- **PMS**：アプリ全体の速さの上限と、一括のジョブのホストごとの公平なキューで、一斉の書き込みを均す。

### 他の案を選ばなかった理由

- **2（自動の拡大だけ）**：夕方の山の立ち上がりと、データの部品の追加の時間に間に合わない。
- **3（常に最大）**：S1 の平常の費用が 2 倍を超える。繁忙期は年に数回で、数日から 1 週間。

## Consequences

- 良くなること：
  - 繁忙期の山を、費用を平常の大きさに保ったまま受けられる。
  - 熱い日付が、他のリスティングの予約と検索に広がらない。
- 引き受けるコスト：
  - 繁忙期の日付と量を PM が 30 日前までに渡す運用が要る。
  - 予定の外の大きな催しは、熱い日付の守りと自動の拡大だけで受ける。

## Confirmation

- E20 の `load-tests` の場面（[capacity.md](../architecture/capacity.md) の 7 節、[quality.md](../quality.md) の 2.2.1 節 J）の合否。
- 繁忙期の振り返りで、予約の最大、熱い日付の数、SLI の消費を記録し、次の既定の値に反映する（[runbooks/](../runbooks/README.md) の 5.2 節）。

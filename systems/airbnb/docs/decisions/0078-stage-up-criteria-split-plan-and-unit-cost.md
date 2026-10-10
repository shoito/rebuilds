---
status: accepted
date: 2026-10-10
---

# ADR-0078: 段階を上げる基準を 10 の指標で月次に見て、上限の 60% で準備を始める。S2 で OpenSearch を地域ごとの索引にし、Valkey と core の読み出しと content を広げ・分ける。S3 で core を置き場所の鍵（届出住宅に結んだリスティングは届出住宅の ID）のハッシュで分け、予約・`stay_claims`・届出住宅を同じ分け先に置く。予約の原価は予約の経路で数える

## Context

- 規模の段階は S1（10 万リスティング）、S2（100 万）、S3（1,000 万）で、S3 で core を `listing_id` のハッシュで分けると決めている（[architecture/README.md](../architecture/README.md) の 2 節）。
- `reserveStay` は、届出住宅の行のロック、リスティングの行のロック、`stay_claims` の挿入、`regulated_nights` の挿入を 1 つの core のトランザクションで行う（[ADR-0004](0004-booking-state-machine-and-holds.md)、[ADR-0006](0006-regulatory-night-cap-enforcement.md)）。1 つの届出住宅に複数のリスティングがありうる。`listing_id` だけで分けると、同じ届出住宅のリスティングが別の分け先になり、180 日の数えが分け先をまたぐ。
- 検索の部分の更新（`stay_ranges`）は予約・ブロック・取り込み・PMS の書き込みのたびに走る（[ADR-0003](0003-search-for-date-range-availability.md)）。
- 予約あたりの原価の目標（決済の提供者の手数料と為替を除く、S1 で 30 円以下）は、見積もりと予約・台帳・通知・外部の和で数える（[architecture/README.md](../architecture/README.md) の 2.1 節）。

## Options

core の分け方：

1. **置き場所の鍵（届出住宅に結んだリスティングは届出住宅の ID、他はリスティングの ID）のハッシュで分ける**
2. `listing_id` のハッシュで分け、180 日の数えを分け先をまたぐ 2 相の確定にする
3. 分けずに大きな型と読み出しの写しで受け続ける

原価の数え方：

- a. **予約の経路の原価で目標を見て、全原価の按分を参考の値として並べる**
- b. 全原価の按分で目標を見る

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 8・9 節。

- **指標**：core の書き込みの CPU と行の数、熱いリスティングと届出住宅の行のロックの待ち、OpenSearch の CPU と部分の更新の数、Valkey のメモリーと操作、ledger の熱い口座のロックの待ち、期限の処理の 1 分の件数、アカウントの上限。月次に見て、上限の 60% で準備を始め、2 つが超えたら次の段の計画を始める。
- **S2**：OpenSearch を地域ごとの索引に、Valkey を 8 シャードに、core の読み出しを 5 に、content を `content-messaging` と `content-ts` に分ける。
- **S3**：core を `core-accounts` と `core-stays`（置き場所の鍵のハッシュで 16）に分ける。リスティング、`stay_claims`、カレンダー、見積もり、予約、届出住宅、`regulated_nights` を同じ分け先に置き、`reserveStay` を 1 つの分け先に閉じる。リスティングを届出住宅に結ぶ・外すときは、分け先の移し（予約の受け付けを止めた短い移し）を伴う。ledger は口座の持ち主のハッシュ、vault は主体のハッシュで分ける。細部は S3 の準備の時に後継の ADR で決める。
- **原価**：予約の経路（見積もりと予約、台帳、通知）の AWS の原価は S1 で約 2 円で、目標を満たす。全原価の按分（約 36 円）は参考の値として並べる。SMS と本人確認の提供者の料金は選定の後に入れる。

### 他の案を選ばなかった理由

- **2（`listing_id` と 2 相の確定）**：予約の 1 つのトランザクションの性質（[ADR-0004](0004-booking-state-machine-and-holds.md)）が崩れ、上限の超過 0（NFR-006）を分散の取引で守ることになる。
- **3（分けない）**：S3 の書き込み（予約に加えて iCal 300 万のアドレスと PMS の書き込み）が 1 つの書き込みのインスタンスの上限を超える見込み（[capacity.md](../architecture/capacity.md) の 3 節）。
- **b（全原価で見る）**：検索の写真の配信が大半で、予約の経路の効率の目標として役に立たない。

## Consequences

- 良くなること：
  - S3 でも予約と 180 日の数えが 1 つのトランザクションに残る。
  - 準備を 1 四半期前に始められる。
- 引き受けるコスト：
  - 届出住宅への結び付けの変更が分け先の移しを伴う（頻度は低い見込み）。
  - 部屋の多い届出住宅は 1 つの分け先に集まる。
  - 全原価の按分は目標を超える（約 36 円）。検索の写真の費用を別に見張る。

## Confirmation

- 月次の `capacity_reviews` で 10 指標を記録する。
- `cost-baseline` の Story で、9 節の原価を請求の実績で置き換える。
- S3 の準備の時に、置き場所の鍵で分けた状態の `reserveStay` の性質ベーステスト（[quality.md](../quality.md) の 2.2.1 節 A・B）を分け先の数 16 で回す。

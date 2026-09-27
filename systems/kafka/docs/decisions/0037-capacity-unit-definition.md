---
status: accepted
date: 2026-09-27
---

# ADR-0037: CU は層ごとの 6 つの次元の組にし、時間の CU は分ごとの CU の最大にする

## Context

intent.md は、論理クラスタを「使った分だけ払い、容量を考えない」ものとし、容量の単位（CU）の定義を metrics-and-billing の領域に任せた。CU は、クォータ（上限）と請求（使った分）の両方に使う。[multi-tenancy-and-quotas.md](../architecture/multi-tenancy-and-quotas.md) の 6 節は、Standard を「1 CU あたりの値 × CU（1〜10）」とする仮の表を置き、正式な定義をこの領域に任せた。

事実（いずれも 2026-09-27 に確認）：

- Confluent Cloud の eCKU は、1 時間の中の最大の eCKU を請求し、すべての次元で使用が 0 なら払わない（[Billing dimensions](https://docs.confluent.io/cloud/current/billing/billing-dimensions.html)）。
- 1 eCKU の上限は、Standard で書き込み 25 MB/秒、読み取り 75 MB/秒、パーティション 250、接続 1,000、接続の試み 50 回/秒、要求 1,500 回/秒、最大 10 eCKU。Basic で 5・15 MB/秒、30、20、5 回/秒、100 回/秒、最大 50 eCKU（[Cluster types](https://docs.confluent.io/cloud/current/clusters/cluster-types.html)）。

## Options

1. **層ごとに、6 つの次元（書き込み、読み取り、パーティション、接続、接続の試み、要求）の組を 1 CU とする。時間の CU は、分ごとに次元の最大を取った CU の、時間の中の最大**
2. 書き込みのスループットだけで CU を決める
3. CU を持たず、次元ごとに別々に課金する

## Decision

1 を採用する。詳細は [metrics-and-billing.md](../architecture/metrics-and-billing.md) の 3 節にある。

- **Standard の 1 CU**：書き込み 25 MB/秒、読み取り 75 MB/秒、パーティション 250、接続 1,000、接続の試み 50 回/秒、要求 1,500 回/秒。最大 10 CU。Confluent の Standard の eCKU と同じ値にし、multi-tenancy-and-quotas の 6 節の表と一致させる。
- **Basic の 1 CU**：書き込み 5 MB/秒、読み取り 15 MB/秒、パーティション 100、接続 100、接続の試み 10 回/秒、要求 400 回/秒。最大 5 CU。5 CU が multi-tenancy-and-quotas の 6 節の Basic の固定の上限と一致する。上限は 5 CU で固定し、請求は使った分にする。
- **分ごとの CU** ＝ 次元ごとの `ceil(使用量 ÷ 1 CU の値)` の最大。**時間の CU** ＝ その時間の分ごとの CU の最大。書き込み・読み取り・要求・接続がすべて 0 の時間は 0 CU。
- **パーティションの次元**は、上限（クォータ。`max_cu` × 1 CU の値）と配置に使い、請求の時間の CU の計算からは外す。パーティションは、CU に含む数を超えた分をパーティション-時で課金する（[ADR-0039](0039-jpy-billing-and-free-tier.md) の改定。2026-09-27 の統合の工程。PM・Dev の確認待ち）。同じパーティションを CU とパーティション-時で二重に課金しないため。
  - 定価の算定（2026-09-27 の検証の工程で追加。**PM の確認事項**）：含む数を超える S1 のパーティション（Standard 4 万、Basic 6.8 万）を原価の単価（Standard $0.0012、Basic $0.0010）で課金すると月に $84,680 で、パーティションのための台数の原価（約 $135,000）の 0.63 倍にしかならない。$135,000 ÷ $84,680 ＝ 1.59 なので、定価は原価の 1.6 倍以上にする（下限 Standard $0.00192、Basic $0.00160）。既定案は Standard 0.32 円・Basic 0.27 円のパーティション-時で、1 ドル 150 円で月に 2,274.7 万円（$151,645、原価の単価の約 1.8 倍）になる（[capacity.md](../architecture/capacity.md) の 10.3 節）。
- **要求**：クォータは処理時間（`request_percentage`）で掛け、説明と請求は毎秒の要求の数で行う。
- CU の値の正本はこの ADR と metrics-and-billing の 3 節に置き、クォータの値（multi-tenancy-and-quotas の 6 節）は同じ表から作る。

2 を選ばない理由：パーティションや接続を多く使い、スループットの少ない利用者（多くの小さなトピック、多くのクライアント）の資源の消費を表せない。うるさい隣人の原因（接続の嵐、パーティションの数）が値段に出ない。

3 を選ばない理由：利用者が、次元ごとの単価を足して費用を見積もる必要がある。Confluent の利用者に馴染みのある eCKU の形から離れる。

## Consequences

- 良くなること：
  - 上限の引き上げ（CU の増加）が、クォータの変更だけで済む（NFR-007）。
  - Confluent の Standard から移る利用者が、同じ数の CU で見積もれる。
  - 使わない時間は 0 で、開発の論理クラスタを放置しても容量の課金が続かない。
- 引き受けるコスト：
  - 1 分の中の瞬間の山は、分の平均でならされる。クォータは秒の単位で掛かるので、請求より厳しく絞られる時間がありうる。
  - Basic の値は Confluent と違う（Basic の固定の上限を 5 つに分けた結果）。移行の説明に書く。
  - 値は E7 の負荷試験で見直す。変えるときは、この ADR を改め、価格の改定と同じ告知（30 日）を行う。

## Confirmation

- 表駆動テスト：分・時間の CU の計算（0 の時間、パーティションだけの時間、上限での切り、パーティションが請求の CU に入らないこと）。
- CI：クォータの値の表（multi-tenancy-and-quotas の 6 節から作る spec）と、CU の値の表が、同じ正本から作られ、一致する。
- 性質ベーステスト：時間の CU は、その時間のどの分の CU 以上で、最大の分の CU と等しい。

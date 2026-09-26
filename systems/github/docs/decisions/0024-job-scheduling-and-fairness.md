---
status: accepted
date: 2026-09-26
---

# ADR-0024: ジョブは持ち主ごとの同時実行の上限と、持ち主の間の公平な順番で配る

詳細は [actions.md](../architecture/actions.md) の 4〜5 節と 9 節。

## Context

ホストされたランナーは、全利用者で共有する有限の資源である。1 つの持ち主が matrix（最大 256 ジョブ）や大量の push で数千のジョブを積むと、単純な FIFO では他の持ち主のジョブが長く待つ。NFR-007（開始まで p95 60 秒）は、全体でも、小さな持ち主にとっても満たしたい。

本家は、プランごとに持ち主単位の同時実行の上限を持つ（Free 20、Pro 40、Team 60、Enterprise 500。[Actions limits](https://docs.github.com/en/actions/reference/limits)）。ワークフローの `concurrency` のグループもある。

決めることは次の 3 つ。

- キューの正本をどこに置くか。
- 持ち主の間の順番をどう決めるか。
- ランナーへどう渡すか（押し込むか、取りに来させるか）。

## Options

### 順番

1. **全体で 1 つの FIFO**
2. **持ち主ごとの上限だけを掛けた FIFO**
3. **持ち主ごとの上限に加え、持ち主の間を重み付きの Deficit Round Robin で回す**

### 渡し方

A. **ランナーが long poll で取りに来る（pull）**
B. **スケジューラが VM を選んで押し込む（push）**

## Decision

順番は 3、渡し方は A を採用する。

- **キューの正本は Aurora の `workflow_jobs`（`state = 'queued'`）。** 配る順番の計算は、Scheduler が Valkey の上に持つ「ラベル → 持ち主ごとのリスト」で行う。Valkey を失っても DB から作り直せる。
- **持ち主ごとの上限は、本家のプランの値に合わせる。** 上限を超える持ち主のジョブは、候補に入れない。セルフホストのランナーのジョブは、この上限に数えない（本家と同じ）。
- **持ち主の中は FIFO、持ち主の間は重み付きの Deficit Round Robin。** 重みはプランで差を付けるが、Free の持ち主が飢えない下限を持つ。値は負荷試験で決める。
- **ランナーは 50 秒の long poll でジョブを取りに来る。** 本家のセルフホストのランナーと同じ形（[Communicating with self-hosted runners（GHES 3.16）](https://docs.github.com/en/enterprise-server@3.16/actions/hosting-your-own-runners/managing-self-hosted-runners/communicating-with-self-hosted-runners)）で、ホストとセルフホストの経路を 1 つにする。接続はランナーからの外向きだけになり、Broker は状態を持たずに増やせる。
- **割り当ては DB の条件付き更新で行う。** 1 つのジョブを 2 つのランナーに渡さない。受け取りの確認が 60 秒以内に来なければ queued に戻し、ホストされたランナーでは該当の VM を壊す。
- **`concurrency` のグループは、リポジトリの範囲の 1 行（`concurrency_groups`）で順序を決める。** `pending` の置き換え、`queue: max`（100 まで）、`cancel-in-progress` は本家の現行の仕様（[Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)）に合わせる。
- **S2 では、Scheduler を持ち主のハッシュで分割する。** 1 つの持ち主は 1 つの区画にだけ属し、上限の数え方が区画をまたがない。
- 1 を採らない理由：大きな持ち主が小さな持ち主を締め出す。
- 2 を採らない理由：上限より少ない持ち主が多数いるとき、全体の容量が足りない時間帯には、先に積んだ持ち主がやはり先に取る。上限だけでは、容量の不足時の公平を作れない。
- B を採らない理由：スケジューラが全 VM の状態を正確に持つ必要があり、VM の死活とのずれで二重の割り当てや取りこぼしが起きやすい。セルフホストのランナーは外から押し込めない（入る向きの接続がない）ので、経路が 2 つになる。

## Consequences

- 良くなること：
  - 1 つの持ち主の大量のジョブが、他の持ち主の待ちに効きにくい。
  - 本家と同じ上限なので、利用者の期待と合う。
  - ホストとセルフホストで、ランナーのプロトコルが 1 つになる。
- 引き受けるコスト：
  - long poll の接続を多数持つ Broker を作り、運用する。
  - 重みと下限の調整に、負荷試験と本番の観測が要る。
  - S1 の Scheduler はリーダー選出の 1 つで、フェイルオーバーの間は配り出しが止まる（数秒〜数十秒）。

## Confirmation

- 性質ベーステスト：任意のジョブの到着の列で、どの時点でも、持ち主ごとの `in_progress` のホストのジョブの数が上限を超えない。1 つのジョブが 2 つのランナーに割り当てられない。
- シミュレーション：1 つの持ち主が 10,000 ジョブを積んだ状態で、他の持ち主のジョブの待ちの p95 が、積まれていないときの 2 倍以内。
- 負荷試験：S1 の規模で NFR-007 を満たす。
- 障害注入：Scheduler・Broker・Valkey を落としても、`queued` のジョブが失われず、復旧後に配られる。

---
status: accepted
date: 2026-10-10
---

# ADR-0073: Aurora は 3 クラスタとも I/O-Optimized、書き込みと別の AZ の読み出し、Global Database で大阪へ。AZ の障害の RPO 0 は Aurora のストレージによる。ledger だけ主のクラスタに `rds.global_db_rpo = 60` を置き、失う仕訳を 60 秒以内に限る。大阪はウォームスタンバイで、OpenSearch はスナップショットから戻す。切り替えは受け付けの停止 → 昇格 → 拡大 → 照合 → 振込を最後に開ける順で、IC と Ops の責任者が決める

## Context

- NFR-011 は、確認の画面を出した取引・仕訳の消失 0、AZ の障害で RPO 0・RTO 5 分、リージョンの障害で RPO 1 分・RTO 1 時間。データは東京と大阪に置く（[intent.md](../intent.md)）。
- お金の正本は ledger の仕訳で（[ADR-0003](0003-escrow-and-double-entry-ledger.md)）、失った仕訳は、提供者・銀行との照合でしか見つからない。core と content は、失っても照合と利用者の再操作で直せる範囲が広い。
- Aurora のクラスタのボリュームは 3 つの AZ に写しを持つ。Global Database の複製の遅れは通常 1 秒未満で、Aurora PostgreSQL は `rds.global_db_rpo`（20 秒以上）で、全部の二次の遅れが値を超えると主の commit を止められる。2 つのリージョンだけのときは、二次のリージョンのパラメーターのグループを既定のままにするよう AWS は勧める（[Aurora の文書](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database-disaster-recovery.html)、2026-10-10 に確認）。
- 検索の索引は core から作り直せる（[ADR-0008](0008-search-engine-and-index.md)）。Valkey は失ってよい。
- Shopify の題材は、大阪をウォームスタンバイにし、受け付けを止めてから正本を移す順にした（[Shopify の ADR-0071](../../../shopify/docs/decisions/0071-osaka-dr-and-stage-up-criteria.md)）。

## Options

ledger の RPO：

1. **ledger の主に `rds.global_db_rpo = 60` を置く。core と content は置かない**
2. どのクラスタにも置かない（遅れは監視だけ）
3. 3 クラスタとも置く

DR：

- a. **大阪のウォームスタンバイ（Aurora の小さい二次、ECS の定義、OpenSearch はスナップショット）**
- b. 大阪にも同じ大きさで常に動かす
- c. バックアップからの復元

## Decision

1 と a を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 4・7 節。

- Aurora：core（書き込み 1、読み出し 2）、ledger（1・1）、content（1・1）。I/O-Optimized、`rds.force_ssl = 1`、自動のバックアップ 35 日、Global Database で大阪（二次は読み出し 1、`db.r8g.large`）。
- AZ の障害：Aurora のストレージで RPO 0。各サービスは 2 AZ で平常の山を受けられる最小のタスクの数を持つ。
- ledger：東京の主のクラスタのパラメーターのグループに `rds.global_db_rpo = 60`。大阪の二次は既定のまま。止まった間は、core の outbox が仕訳の事象を溜め、残高での購入の引き当ては 503。
- 大阪の平常：ECS のタスク 0、空の Valkey、変換の後の写真（`photos`）・`opensearch-snapshots`・log-archive の写し、複数のリージョンの鍵、東京と大阪の固定の IP を相手に登録。
- 切り替え：IC と Ops の責任者が決める（東京の回復の見込みが 1 時間を超える）→ `ops.purchase_enabled`・`ops.payouts_enabled`・`ops.carrier_enabled.*` を止める → 3 クラスタを管理されたフェイルオーバーで昇格 → ECS と Valkey を広げる → 元を大阪へ → OpenSearch のスナップショットの戻し（待たない）→ 照合（出品と取引、取引と台帳、直近 10 分の支払いの試行の照会、配送の照会）→ 購入と配送を開ける → 取引と台帳の照合が 0 になってから振込を開ける。
- 戻しは switchover（RPO 0）で計画作業として行う。

### 他の案を選ばなかった理由

- **2（置かない）**：複製が長く遅れている時のリージョンの障害で、失う仕訳の範囲に上限がない。お金の消失は照合でしか見つからず、利用者の売上金に直結する。
- **3（3 クラスタとも）**：core に置くと、複製の遅れで購入が止まり、NFR-007（購入 99.95%）を削る。core と content の失った範囲は照合と再操作で直せる。
- **b（常に動かす）**：取引とお金の正本が 1 つの書き込みの DB にある設計と合わず、費用が倍になる。
- **c（バックアップから）**：RPO 1 分と RTO 1 時間を守れない。

## Consequences

- 良くなること：
  - リージョンの障害でも、失う仕訳は 60 秒以内に限られる。
  - 大阪の平常の費用が、小さい二次と S3 の写しで済む。
  - 受け付けを止めてから正本を移し、振込を照合の後に開けるので、二重の振り替えと二重の振込を作らない。
- 引き受けるコスト：
  - 大阪への複製が 60 秒を超えて遅れると、ledger の書き込みが止まる（平常でも起きうる）。遅れの指標を見張り、止まりの頻度を計測する。
  - 切り替えの後、検索は数時間落ちた形になる。

## Confirmation

- DR の訓練（半年ごと）：RPO・RTO を測り、照合で二重の販売 0・振り替えの重複 0 を確かめる。
- 監視：`AuroraGlobalDBRPOLag` 10 秒が 5 分で呼び出し（[runbooks/](../runbooks/README.md) の 4 節）。ledger の commit の待ち（RPO による）の発生を指標にする。
- plan のポリシー検査：ledger の主の `rds.global_db_rpo` の削除を拒む。

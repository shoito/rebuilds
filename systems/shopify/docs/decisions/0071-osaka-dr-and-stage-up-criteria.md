---
status: accepted
date: 2026-10-10
---

# ADR-0071: 大阪は、全ポッドと全体の Aurora Global Database の二次（読み出し 1 台）、S3 の写し、ECR・KMS・AppConfig の写し、ECS のサービスの定義（ポッドはタスク 0）を持つウォームスタンバイにする。切り替えは、チェックアウトの停止 → Aurora の昇格 → ECS の拡大 → KeyValueStore の `sys:region` → 照合 → チェックアウトの再開の順で、IC と Ops の責任者が決める。段階を上げる基準は 6 つの指標で見て、上限の 60% で準備を始める

## Context

- NFR-005 は、リージョンの障害で RPO 1 分・RTO 1 時間。データは東京と大阪に置く（[intent.md](../intent.md)）。
- ポッドの数だけ Aurora のクラスタがある。大阪に東京と同じ大きさを常に持つと、Aurora と ECS の費用が倍になる。
- カートは Valkey にあり、失ってよい（[ADR-0028](0028-cart-storage-in-valkey.md)）。検索の索引は Aurora から作り直せる。
- 決済が東京の最後の数秒に済み、注文の行が大阪に届かない場合がある。照合の処理と提供者の照会で拾える（[ADR-0005](0005-checkout-state-machine-and-exactly-once-orders.md)）。
- 段階（S1 → S2 → S3）の移りには、アカウント・エッジの上限・全体の DB の分け方の準備が要り、1 四半期かかる。

## Options

DR：

1. **Aurora Global Database の小さい二次と、ECS の定義だけのウォームスタンバイ**
2. 大阪にも同じ大きさの常の稼働（アクティブ・アクティブ）
3. バックアップからの復元（パイロットライトより小さい）

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 7・8 節。

- 大阪の平常：全ポッドと全体の Aurora の二次（読み出し 1、最小の型）、ECS のサービスの定義（ポッドはタスク 0、全体の `shop-directory`・`identity`・`edge-router` は 1）、Valkey の最小の空のクラスタ、S3 の CRR、ECR・KMS（複数のリージョンの鍵）・AppConfig・Secrets Manager の写し。OpenSearch は持たず、切り替えの後に作り直す。
- 切り替えの順：チェックアウトの受け付けを止める → 全体の Aurora を昇格 → ポッドの Aurora を並行 10 で昇格 → ECS と Valkey を広げる → `sys:region = osaka` → 全ポッドで照合 → チェックアウトを開ける。判断は IC と Ops の責任者（[roadmap.md](../roadmap.md)）。
- 失った範囲の決済は、照合の処理と提供者の日次の突き合わせで、注文を作るか返金する。
- 東京へ戻すのは、Global Database の管理された切り替えで、計画作業として行う。
- 段階を上げる基準：共有のポッドの数（ポッドの組）、`mtd-storefront` の要求、KeyValueStore の熱い集まり、全体の Aurora の書き込みの CPU、最大のショップの大きさ、1 ショップのフラッシュセールの注文。上限の 60% で準備を始め、2 つが超えたら S2 の計画を始める。

### 他の案を選ばなかった理由

- **2（アクティブ・アクティブ）**：在庫と注文の正本が 1 つの書き込みの DB にある設計（[ADR-0004](0004-inventory-reservation-model.md)、[ADR-0005](0005-checkout-state-machine-and-exactly-once-orders.md)）と合わず、費用が倍になる。
- **3（バックアップから）**：RPO 1 分を守れない。全ポッドの復元が 1 時間に収まらない。

## Consequences

- 良くなること：
  - 大阪の平常の費用が、Aurora の小さい二次と S3 の写しで済む。
  - 切り替えの順が、売り越しと一回性を崩さない順（受け付けを止めてから正本を移す）になる。
- 引き受けるコスト：
  - 切り替えの後、カートは空になり、検索は数時間落ちた形（名前の前方一致）になる。
  - 大阪で ECS のタスクを起こせる量と時間は、訓練で確かめるまで**未検証**。
  - ポッドの数だけ二次のクラスタがあり、昇格の作業の並行を管理する。

## Confirmation

- DR の訓練（半年ごと、staging と本番の見張りのポッド）：RPO・RTO を測り、照合で売り越し 0・重複の注文 0 を確かめる。
- 監視：`AuroraGlobalDBRPOLag` 10 秒が 5 分で呼び出し（[runbooks/](../runbooks/README.md) の 4 節）。大阪の Terraform の plan に差分がない（日次）。
- 月次のキャパシティのレビューで、段階の 6 指標を見る（[capacity.md](../architecture/capacity.md) の 7 節）。

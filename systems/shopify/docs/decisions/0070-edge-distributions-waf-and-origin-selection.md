---
status: accepted
date: 2026-10-10
---

# ADR-0070: ストアフロント・チェックアウト・Admin API は 1 つのマルチテナントの配信（`mtd-storefront`）と 1 つの viewer request の関数で受け、関数が KeyValueStore の値から、アカウントをまたいで共有した VPC origin のポッドの元を選ぶ。ポッド → 元の対応と東京・大阪の切り替えも KeyValueStore の値で持つ。WAF の Bot Control とアカウントの乗っ取りの防止は、チェックアウト・カート・待合室の入口・ログインの経路に絞る

## Context

- エッジは、ホスト → ショップ・ポッド（[ADR-0010](0010-shop-routing-hot-set-and-custom-domains.md)）、待合室の許可証（[ADR-0025](0025-queue-pass-tokens.md)）、キャッシュの鍵（[ADR-0050](0050-edge-cache-keys-and-generations.md)）を、同じ要求の中で扱う。KeyValueStore は 1 つの関数に 1 つしか結べない。関数は 10 KB まで（[CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、2026-10-10 に確認）。
- 独自のドメインは、マルチテナントの配信のテナントで受ける（ADR-0010）。
- CloudFront Functions は viewer request で `selectRequestOriginById()` により、配信の中の元（VPC origin を含む）を選べる（[Helper methods](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html)、2026-10-10 に確認）。
- リージョンの障害では、全ポッドの元を大阪へ切り替える（NFR-005 の RTO 1 時間）。
- WAF の Bot Control は要求あたりの課金で、ストアフロントの全要求に掛けると大きい（[capacity.md](../architecture/capacity.md) の 6 節）。

## Options

1. **1 つのマルチテナントの配信と 1 つの関数。元の選択と地域の切り替えを KeyValueStore の値で**
2. ポッドごとの配信（DNS で振り分け）
3. 1 つの元（全体の振り分けのサービス）に全要求を送る

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 3 節。

- 配信：`mtd-storefront`（テナント：既定のドメインのワイルドカード 1、独自のドメインのショップごと）、`admin`（標準）、`cdn`（標準）。
- 関数 `fn-route`：ホストの値 → `state` の処理 → 許可証の確かめ → キャッシュの鍵の材料 → `sys:origins` と `sys:region` から `<pod>-<region>` の元を選ぶ。熱い集まりにないホストは `edge-router-<region>`。10 KB に収める。
- 元：ポッドの組のアカウントが作った内部の ALB の VPC origin を、RAM で edge のアカウントへ共有する。東京と大阪の両方の元を配信に持つ。
- 地域の切り替え：`sys:region` の 1 つの値の書き換えで、全ポッドの元を大阪へ向ける（[ADR-0071](0071-osaka-dr-and-stage-up-criteria.md)）。
- WAF：共通の管理の規則と IP の評判と IP の速さの上限は全部に。Bot Control（共通）はチェックアウト・カート・待合室の入口・ログイン・Storefront API のカートのミューテーションだけ。標的型はフラッシュセールの間の対象のショップだけ。ATP は管理画面のログインだけ。

### 他の案を選ばなかった理由

- **2（ポッドごとの配信）**：ショップの移し替えのたびに DNS と配信の別名を変えることになり、伝わりが遅く、配信の数がポッドの数で増える。
- **3（1 つの元）**：全要求が東京の 1 つのサービスを通り、障害の範囲が全ポッドになり、キャッシュの外れのたびに往復が 1 つ増える。

## Consequences

- 良くなること：
  - 移し替えと DR の切り替えが、KeyValueStore の値の書き換えで済む。
  - Bot Control の費用が、守る経路の要求の数で決まる。
- 引き受けるコスト：
  - 1 つの関数に、振り分け・許可証・鍵の材料を 10 KB で詰める。関数の変更は全ショップに効くので、段階のデプロイ（CloudFront の段階の配信と見張り）を要る（[delivery.md](../architecture/delivery.md) の 4.3 節）。
  - 配信あたりの要求・元・テナントの上限の引き上げを、段階ごとに申請する（天井は**未検証**）。

## Confirmation

- 試験のベクトル：`fn-route` と `edge-router` と元の `x-<brand>-ck` の検証が、同じホストの表で同じ結果（PROP-POD-001、PROP-EDGE-001）。
- 結合テスト（staging）：`sys:region` の書き換えで、全ポッドの要求が大阪の元へ向く。
- 関数の大きさの検査（CI）：10 KB を超えたら落とす。

---
status: accepted
date: 2026-09-27
---

# ADR-0032: 運用のツールはロールと金額の上限、理由つきの一時の権限、書き手と承認者を分ける変更の要求で作り、閲覧と監査ログを毎日照合する

詳細は [support-and-operations-tools.md](../architecture/support-and-operations-tools.md)。

## Context

社内の運用のツールは、乗客とドライバーの位置と個人の情報を最も広く見られ、お金（返金・訂正）と規則（運賃、区域の多角形、乗降の地点）を変えられる場所である。

- 人が軌跡を見る操作は、理由と監査ログを必須にする（[ADR-0010](0010-location-trails-map-matching-and-retention.md)、NFR-009）。
- 区域の多角形と乗降の地点、運賃の規則の変更は 2 人の確認で行う（[ADR-0033](0033-osm-import-and-service-area-polygons.md)、[ADR-0034](0034-geocoding-provider-and-pickup-points.md)、[pricing-and-fares.md](../architecture/pricing-and-fares.md) の 10 節）。
- 返金と訂正は `fare_adjustments` と台帳で行い、1 万円以上は 2 人の承認（[payments-and-payouts.md](../architecture/payments-and-payouts.md) の 6 節、[ADR-0025](0025-ledger-settlement-and-reconciliation.md)）。
- エージェントは草案を作るが、承認はしない（[AGENTS.md](../../../../AGENTS.md)）。

## Options

1. **1 つの運用の API と画面。ロールと上限、機微な閲覧は理由つきの一時の権限、変更は共通の変更の要求、閲覧と監査ログの毎日の照合**
2. **領域ごとに管理の画面を作り、それぞれに権限と承認を持たせる**
3. **ロールだけで閲覧を許し、監査ログを後から見る**

## Decision

1 を採用する。

- ロール（`support_t1`・`support_t2`・`safety_agent`・`safety_lead`・`supply_reviewer`・`finance_ops`・`geodata_editor`・`fare_rule_editor`・`release_manager`・`auditor`）と金額の上限を方針のデータで持ち、運用の API の 1 か所で判定する。
- 軌跡、個人の情報の全体、通話の記録、メッセージ、安全の報告、書類の画像の閲覧は、チケットかインシデントの ID を理由にした、1 対象・30 分の一時の権限でだけ行う。位置の閲覧の権限は [ADR-0036](0036-location-privacy-keys-retention-and-audited-access.md) の `location_access_grants` を使う。社員の認証と本番のデータの期限つきの承認は [ADR-0037](0037-authentication-device-integrity-and-fraud-response.md) に従う。
- お金・規則・データの変更は `change_requests` で行い、書き手と承認者を別の人にする（DB の検査）。適用は各領域の API を冪等に呼び、運用の API は他の領域の DB に直接書かない。
- エージェントは下書き（`author_kind = agent`）を作れるが、承認と適用はできない。
- 監査ログの形・書き方・保持は ADR-0036 に従う（操作と同じトランザクションで書き、outbox で S3 Object Lock へ）。この ADR は、書く対象（一時の権限、機微な閲覧、すべての変更、ロールの付与）と、閲覧の API のアクセスの記録との毎日の照合を決める。監査ログを書けなければ操作を失敗させる。
- 2 を採らない理由：権限・承認・監査の実装が領域ごとに分かれ、抜けが出る。
- 3 を採らない理由：見てから気づくのでは、位置の閲覧の濫用を防げない。

## Consequences

- 良くなること：
  - 機微な閲覧が理由と対象に結びつき、濫用を見つけやすい。
  - 2 人の承認の仕組みが 1 つで、領域が増えても同じ形で足せる。
- 引き受けるコスト：
  - 担当は閲覧のたびに理由を入れる手間がある。
  - 監査ログの障害が、運用の操作を止める。
  - 上限の値は **未検証** で、見直しが要る。

## Confirmation

- 性質ベーステスト：PROP-OPS-001〜004（[support-and-operations-tools.md](../architecture/support-and-operations-tools.md) の 11 節）。
- 決定表：DT-OPS-001（ロール × 操作 × 対象）を CI で回す。
- 監視：毎日の照合の不一致 0 件、1 人 1 日の軌跡の閲覧の最大。
- レビュー：運用の API から他の領域の DB に直接書く変更、監査ログを書かずに返す閲覧の API を差し戻す。

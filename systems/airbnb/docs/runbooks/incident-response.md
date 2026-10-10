# Runbook: 障害の一般の手順

- Owner: Ops（当番）
- 対応するアラート: 個別の手順のないすべての page と、個別の手順から呼ばれたとき
- 最終確認日: 2026-10-10

SLO とアラートの一覧は [README.md](README.md) の 1・4 節、計測は [observability.md](../architecture/observability.md)。個別の手順があれば、そちらを先に使う。安全の事故（人の身の安全）は、システムの障害と別の当番で [safety-incident.md](safety-incident.md) を使う。

## 症状

- page が鳴った。または利用者・ホスト・運用者・提供者から、予約できない・送金が来ない・通知が来ない・相手の住所が見える、などの報告が来た。

## 影響

障害の重さ（SEV）を最初の 15 分で決める。迷ったら重いほうにする。

| SEV | 例 | 呼ぶ人 |
| --- | --- | --- |
| SEV1 | 二重の予約、届出住宅の上限の超過、決着の重複・チェックインの前の release、台帳の不変条件の違反、正確な住所・名簿・旅券の漏れの疑い、予約が全体で止まる | IC（インシデントの指揮）、Dev のテックリード、財務（お金のとき）、セキュリティと法務（漏れのとき）、CS と安全の担当（ゲストが泊まる所を失うとき）、PM |
| SEV2 | 予約の SLO のバーンレート、期限の遅れ（p99 10 分超）、送金の遅れ、決済の提供者・銀行の障害、iCal の取り込みの広い失敗、検索の混入の率 3% 超 | IC、Dev の当番、財務（お金のとき） |
| SEV3 | 検索・通知の遅れ、1 つの機能の劣化 | Ops の当番 |

## 確認

1. どの SLI が外れているか（[README.md](README.md) の 1 節）。正しさの SLI は、不一致の数と「最後の成功からの時間」の両方を見る。照合が止まっている 0 を正常と読まない（[ADR-0079](../decisions/0079-sli-measurement-and-correctness-monitors.md)）。
2. 直近のデプロイ・フラグの変更・`legal.*` の変更・設定の表のバージョン・Terraform の適用（`deployments`・`legal_config_changes`・`config_versions` の表と監査の事象）。
3. 外部の状況（決済の提供者、為替の相場の提供者、提携銀行、eKYC、APNs・FCM、SMS、AWS の Health Dashboard）。
4. 影響の範囲を、ID と数と理由のコードだけで数える。住所・氏名・旅券の番号・メッセージの本文を調べの記録に書かない。

## 対処

1. **同じ夜とお金と上限を先に守る。** 正しさの SLI が外れたら、まず止める：
   - 二重の予約・上限の超過の疑い：`ops.booking_enabled` でそのリスティング・届出住宅・地域・全体を止める（[double-booking-or-cap-violation.md](double-booking-or-cap-violation.md)）。
   - 決着・台帳の誤り：`ops.payouts_enabled` で送金を止める（[payout-failure.md](payout-failure.md)）。予約は止めない（預かりの仕訳は後から書ける）。
   - 漏れの疑い：経路を止める（その API・通知の種類のフラグ、`ops.partner_api_enabled.<app>`）。
2. 直近のデプロイが疑わしければ戻す（[deploy-and-rollback.md](deploy-and-rollback.md)）。フラグで戻せるなら先にフラグ。
3. 外部の障害なら、その手段だけを止める（`ops.payments_enabled`、`ops.ical_import_enabled` のドメインごとの停止）。仮押さえの期限は照会の延長（DT-BKG-001 の行 12・13）に任せ、手で延ばさない。
4. 予約・お金・`stay_claims`・`regulated_nights` を手で書き換えない。直しは遷移の関数、持ち主の関数、決まった仕訳の型、打ち消しの仕訳だけ（[security.md](../architecture/security.md) の 6.3 節）。
5. 利用者への知らせは、お知らせと状況のページで出す（文言の型は法務の確認の後）。

## エスカレーション

- SEV1 は 15 分以内に IC を立て、30 分ごとに状況を共有する。
- お金の障害は財務を必ず呼ぶ。漏れの疑いはセキュリティと法務（漏えい等の報告の要否は法務の確認待ち：L8）。
- 大阪への切り替えの判断は IC と Ops の責任者（[disaster-recovery.md](disaster-recovery.md)）。

## 事後

- SEV1・SEV2 は 5 営業日以内に振り返りを書く。調査の結果は ID と数と理由のコードだけで、`changes/` の新しい `intent.md` として起票する（Maintain 段。[quality.md](../quality.md) の 4.3 節）。
- 止めたフラグを戻したこと、照合が 0 に戻ったことを確かめる。
- この手順と個別の手順で足りなかったことを反映する。

# Runbook: 障害の一般の手順

- Owner: Ops（当番）
- 対応するアラート: 個別の手順のないすべての page と、個別の手順から呼ばれたとき
- 最終確認日: 2026-10-10

SLO とアラートの一覧は [README.md](README.md) の 1・4 節、計測は [observability.md](../architecture/observability.md)。個別の手順があれば、そちらを先に使う。

## 症状

- page が鳴った。または利用者・運用者・提供者・運送会社から、買えない・売上金が出ない・通知が来ない・相手の情報が見える、などの報告が来た。

## 影響

障害の重さ（SEV）を最初の 15 分で決める。迷ったら重いほうにする。

| SEV | 例 | 呼ぶ人 |
| --- | --- | --- |
| SEV1 | 二重の販売、振り替えの重複・両方、台帳の不変条件の違反、住所・本人・2 者のデータの漏れの疑い、購入が全体で止まる | IC（インシデントの指揮）、Dev のテックリード、財務（お金のとき）、セキュリティ（漏れのとき）、PM |
| SEV2 | 購入の SLO のバーンレート、期限の遅れ（p99 10 分超）、措置の反映の遅れ、決済の提供者・運送会社・銀行の障害、振込の失敗の急増 | IC、Dev の当番、財務（お金のとき） |
| SEV3 | 検索・通知の遅れ、1 つの機能の劣化 | Ops の当番 |

## 確認

1. どの SLI が外れているか（[README.md](README.md) の 1 節）。正しさの SLI は、不一致の数と「最後の成功からの時間」の両方を見る。照合が止まっている 0 を正常と読まない（[ADR-0075](../decisions/0075-sli-measurement-and-correctness-monitors.md)）。
2. 直近のデプロイ・フラグの変更・`legal.*` の変更・Terraform の適用（`deployments`・`legal_config_changes` の表と監査の事象）。
3. 外部の状況（決済の提供者、運送会社、提携銀行、APNs・FCM、AWS の Health Dashboard）。
4. 影響の範囲を、ID と数と理由のコードだけで数える。住所・氏名・メッセージの本文を調べの記録に書かない。

## 対処

1. **お金と一品の一回性を先に守る。** 正しさの SLI が外れたら、まず止める：
   - 二重の販売の疑い：`ops.purchase_enabled` でその出品・カテゴリ・全体を止める。
   - 振り替え・台帳の誤り：`ops.payouts_enabled` で振込を止める（[ledger-reconciliation-mismatch.md](ledger-reconciliation-mismatch.md)）。
   - 漏れの疑い：経路を止める（その API・通知の種類のフラグ、`ops.fanout_enabled`）。
2. 直近のデプロイが疑わしければ戻す（[deploy-and-rollback.md](deploy-and-rollback.md)）。フラグで戻せるなら先にフラグ。
3. 外部の障害なら、その手段・運送会社だけを隠す（`ops.carrier_enabled.<carrier>`、遮断器による決済の手段の非表示）。期限の近い取引は、運用が `ops_hold` で期限を止めるかを決める。
4. お金・取引の状態を手で書き換えない。直しは遷移の関数、決まった仕訳の型、打ち消しの仕訳だけ（[ADR-0060](../decisions/0060-ops-money-interventions-and-proceeds-hold.md)）。
5. 利用者への知らせは、お知らせと状況のページで出す（文言の型は法務の確認の後）。

## エスカレーション

- SEV1 は 15 分以内に IC を立て、30 分ごとに状況を共有する。
- お金の障害は財務を必ず呼ぶ。漏れの疑いはセキュリティと法務（漏えい等の報告の要否は法務の確認待ち：L5）。
- 大阪への切り替えの判断は IC と Ops の責任者（[disaster-recovery.md](disaster-recovery.md)）。

## 事後

- SEV1・SEV2 は 5 営業日以内に振り返りを書く。調査の結果は ID と数と理由のコードだけで、`changes/` の新しい `intent.md` として起票する（Maintain 段。[quality.md](../quality.md) の 4.3 節）。
- 止めたフラグを戻したこと、照合が 0 に戻ったことを確かめる。
- この手順と個別の手順で足りなかったことを反映する。

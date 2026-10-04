# Runbooks: Stripe

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みは [observability.md](../architecture/observability.md) にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md の 3.2・5.2 節はこれを計測・実装する側の記述である。

## 1. SLI と SLO

| SLI | SLO | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- |
| 決済の API の可用性（PaymentIntent・Refund・PaymentMethod の 5xx とタイムアウトでない割合。カードの拒否と 4xx は成功） | 99.99%（NFR-001。S3 で 99.995%） | 速いバーンレートで呼び出し。エラーバジェットを使い切ったら修正以外のデプロイを止める | |
| 処理時間（コネクタの待ちを除く）p99 | 300ms 以内（NFR-002） | 15 分続いたらチケット | |
| オーソリの技術的な成功率（コネクタ別） | 99.9% | 5 分間で 98% 未満なら呼び出し | ○ |
| オーソリの承認率（コネクタ別・ブランド別） | 目標なし。過去 4 週の同じ曜日・時間帯との差 | 10 ポイント以上の低下が 15 分続けば呼び出し | ○ |
| 結果不明の残り（最古の経過時間） | 15 分以内。24 時間を超えるものは 0 件 | 15 分超で呼び出し。24 時間超は SEV2 | ○ |
| コネクタの通知の反映 p95 | 5 秒以内（ADR-0014） | 保留が 24 時間を超えたら 1 件でもアラート | |
| Webhook の最初の配信の遅れ p95（コミット → 送信開始） | 10 秒以内（NFR-006） | 15 分超でチケット、30 分で呼び出し | |
| 照合の不一致（精算・銀行の明細と台帳） | T+2 営業日で 0 件（NFR-005） | T+1 で残ればチケット、T+2 で呼び出し | ○ |
| 台帳の整合（日次の再計算と集計の差、全口座の合計） | 差 0（ADR-0003） | 1 口座でも SEV2 | ○ |
| 仮勘定（`suspense:*`）の残高 | 5 営業日以内に 0 | 5 営業日続けばチケット | ○ |
| DR の複製の遅延（`AuroraGlobalDBRPOLag`、live・Vault） | 10 秒以内 | 10 秒超が 5 分続けば呼び出し | |
| PAN の形の検出（本体のログ・DB・S3・SQS） | 0 件 | 1 件で呼び出し（SEV2 から） | ○ |

- SLO の窓は 30 日。99.99% のエラーバジェットは約 4.3 分しかないので、合成監視と症状のアラート（5 分間の 5xx が 1% 超）も置く（[observability.md](../architecture/observability.md) の 5.1 節）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- テスト環境（サンドボックス）は SLO の対象外。リージョンの障害の RTO は 4 時間（お金が動かないため。[infrastructure.md](../architecture/infrastructure.md) の 5.3 節）。
- 復旧の目標：AZ の障害は RPO 0・RTO 5 分（NFR-007）、リージョンの障害は RPO 1 分・RTO 1 時間（NFR-008。失った範囲はコネクタへの照会で回復する）。

## 2. 加盟店単位の上限と負荷

上限の値の正本は [rate-limiting.md](../architecture/rate-limiting.md) の 4 節。プランで変えない。緩和・引き締めは `rate_limit_overrides`（アカウント × 環境）で行い、Ops が承認して監査ログに残す（手順は `rate-limit-override.md`）。

| 対象 | 上限（S1） | 超えたとき |
| --- | --- | --- |
| 全体（アカウント） | 本番 1 秒に 100、サンドボックス 1 秒に 25 | 429 `global-rate` |
| エンドポイントの既定 | 1 秒に 25（決済の経路は全体の枠だけ） | 429 `endpoint-rate` |
| 同時実行 | 本番 同時 50（一覧・`expand` は操作ごとに 10） | 429 `global-concurrency` / `endpoint-concurrency` |
| PaymentIntent の更新 | 1 オブジェクト 1 時間に 1,000 回 | 429 `resource-specific` |
| エッジ（WAF、IP） | api 5 分に 30,000、Vault・Checkout 5 分に 1,000 | 403（WAF）。Vault・Checkout は急増時に Challenge |
| Webhook の送信 | 送信先ごとに同時 10、アカウントごとに 1 秒 100 件 | 遅らせる（捨てない） |

- api・DB の主要な指標に `account_id` のラベルを付ける（上位 100 件＋「その他」）。1 つの加盟店が確定の 20% を超え続けたら、S2 の判断の材料にする（[infrastructure.md](../architecture/infrastructure.md) の 8 節）。
- 大きな緩和（全体を 2 倍以上）は 6 週間前までの申請で受け、容量を確かめてから承認する（本家と同じ）。

## 3. リリースとロールバック

流れの正本は [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- すべての新機能は release フラグの裏に置く。割り当ての単位は加盟店のアカウント。
- お金の区分 A の変更：影の実行（7 日かつ 10 万件以上、月末または Payout の日を含む）→ 社内の加盟店 → 同意を得た加盟店 → 1% → 10% → 50% → 100%。各段で 24 時間以上、かつ日次の照合と Payout を 1 回以上通す（[ADR-0032](../decisions/0032-release-safety-for-money-moving-code.md)）。
- お金の不変条件のガード（台帳の整合、影の実行の差、技術的な成功率、結果不明の発生率、照合の不一致）でフラグを自動で切る。
- ロールバックはまずフラグで行う。台帳は戻さず、訂正の仕訳で直す。
- 本番へのデプロイは Ops が承認する。CDE は作成者と別の 2 人（Dev のテックリードとセキュリティの担当）と変更記録（`pci:change`）が要る（[ADR-0033](../decisions/0033-cde-pipeline-and-change-control.md)）。

### 3.1 デプロイの時間帯と凍結

| 対象 | 時間帯 | 凍結（修正だけ） |
| --- | --- | --- |
| 本体（prod） | 平日 10〜17 時 | 金曜 15 時以降、月末・月初の 2 営業日（Payout と締めの集中）、年末年始、大型セールの前後、エラーバジェットを使い切っている間、夜間の CI が 2 日続けて失敗している間（フラグの拡大も止める） |
| CDE（cde-test・cde-live） | 平日 10〜16 時。cde-live は cde-test の 24 時間後 | 本体と同じ。セキュリティの修正は時間帯の制限を受けない（2 人の承認は省かない） |
| DR のフェイルバック（東京へ戻す switchover） | 計画作業として | 月末・月初は避ける |

凍結の予定（年末年始、大型セールの日付）は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する。

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。できるまでは [incident-response.md](incident-response.md) の該当の節で対応する。アラートの条件は [observability.md](../architecture/observability.md) の 5.2 節。

| アラート | 手順 | 状態 |
| --- | --- | --- |
| SLO の速いバーンレート、合成監視の連続失敗、5xx の急増 | [incident-response.md](incident-response.md) | 作成済み |
| デプロイ中の自動ロールバック、デプロイ後の悪化、お金の不変条件のガードの停止 | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み |
| AZ・リージョンの障害、`AuroraGlobalDBRPOLag` の超過、失った決済の回復 | [disaster-recovery.md](disaster-recovery.md) | 作成済み |
| KMS のスロットリング（CDE） | [incident-response.md](incident-response.md) の「KMS のスロットリング」 | 作成済み |
| outbox の最古の行が 30 秒超 | `relay-backlog.md` | E1 で作成 |
| MFA を失った利用者からの回復の依頼（本人確認の手順） | `mfa-recovery.md` | E2 で作成 |
| コネクタの技術的な成功率・承認率の低下、接続先の障害 | `connector-outage.md`（コネクタの切り離しと振り分け） | E3 で作成 |
| 結果不明の滞留（最古 15 分超、24 時間超） | `unknown-outcome-backlog.md`（接続先への参照番号での確認を含む） | E3 で作成 |
| 照合の不一致（T+1・T+2） | `reconciliation-break.md` | E4 で作成 |
| 仮勘定の残高が 5 営業日続く | `suspense-balance.md`（2 人の承認での振替・償却） | E4 で作成 |
| 台帳の整合の検査の失敗 | `balance-drift.md`（集計の修正と自動入金の停止） | E4 で作成 |
| 入金の失敗・組戻し・資金返却の増加 | `payout-failure.md`（口座の停止と再入金） | E4 で作成 |
| `in_transit` のまま予定の着金日を 2 営業日過ぎた入金 | `payout-in-transit-delay.md`（銀行への照会、払出口座の残高） | E4 で作成 |
| Webhook の配信の遅れ・滞留 | `webhook-delivery-backlog.md` | E5 で作成 |
| エンドポイントの一斉の無効化 | `endpoint-mass-disable.md`（キルスイッチと再予定） | E5 で作成 |
| 不正の急増、カードテスティングの兆候 | `fraud-spike.md`（プラットフォームのルールの一時的な強化、WAF の Challenge） | E9 で作成 |
| 決済ページの改ざんの検知（SEV1） | `payment-page-tamper.md`（目録にないスクリプトの配信の停止、前のバージョンへの戻し、影響の範囲の調査） | E6 で作成 |
| Dispute の証拠を送れないまま期限が近い | `dispute-submission.md`（コネクタの管理画面からの手動の提出、加盟店への連絡） | E9 で作成 |
| PAN の形の検出、カード番号の漏洩の疑い | `card-data-exposure.md`（報告の要否は法務：[intent.md](../intent.md) の L4） | E10 で作成 |
| 鍵の削除の予約・無効化・ポリシーの変更、ローテーションの失敗、漏洩の疑い | `key-rotation.md`（`ReEncrypt`、HMAC 鍵の入れ替え） | E10 で作成 |
| CDE の期限を過ぎた権限、深夜の CDE への入場 | `cde-access.md`（JIT の申請・承認・当番） | E10 で作成 |
| API キーの漏洩の通知（シークレットスキャン） | `api-key-leak.md`（本番は 24 時間でローテーション、サンドボックスは即時失効） | E10 で作成 |
| 決済の経路の 429、特定の加盟店の上限の変更 | `rate-limit-override.md` | E10 で作成 |
| 重要なセキュリティの仕組みの失敗、セキュリティインシデント | `security-incident.md` | E10 で作成 |

### 4.1 領域との対応

各領域の文書に対して、運用で見る指標と手順の置き場所。

| 領域 | アラート・手順 |
| --- | --- |
| [api.md](../architecture/api.md)、[rate-limiting.md](../architecture/rate-limiting.md) | SLO の速いバーンレート、5xx の急増、決済の経路の 429（`rate-limit-override.md`） |
| [auth-and-keys.md](../architecture/auth-and-keys.md) | API キーの漏洩（`api-key-leak.md`）、MFA の回復（`mfa-recovery.md`） |
| [payments.md](../architecture/payments.md)、[payment-methods.md](../architecture/payment-methods.md) | 技術的な成功率・承認率（`connector-outage.md`）、結果不明の滞留（`unknown-outcome-backlog.md`） |
| [disputes.md](../architecture/disputes.md) | 証拠を送れないまま期限が近い（`dispute-submission.md`） |
| [ledger.md](../architecture/ledger.md) | 台帳の整合（`balance-drift.md`）、仮勘定（`suspense-balance.md`） |
| [payouts-and-reconciliation.md](../architecture/payouts-and-reconciliation.md) | 照合の不一致（`reconciliation-break.md`）、入金の失敗・遅れ（`payout-failure.md`・`payout-in-transit-delay.md`） |
| [card-vault.md](../architecture/card-vault.md)、[security.md](../architecture/security.md) | PAN の形の検出（`card-data-exposure.md`）、鍵（`key-rotation.md`）、CDE のアクセス（`cde-access.md`）、KMS のスロットリング、セキュリティの仕組みの失敗（`security-incident.md`） |
| [fraud.md](../architecture/fraud.md)、[merchant-onboarding.md](../architecture/merchant-onboarding.md) | 不正の急増（`fraud-spike.md`）。加盟店の継続的な監視は審査の担当の業務で、アラートにしない（merchant-onboarding.md の 6 節） |
| [events-and-webhooks.md](../architecture/events-and-webhooks.md) | 配信の遅れ（`webhook-delivery-backlog.md`）、一斉の無効化（`endpoint-mass-disable.md`）、outbox の遅れ（`relay-backlog.md`） |
| [checkout.md](../architecture/checkout.md) | 決済ページの改ざんの検知（`payment-page-tamper.md`）、合成監視（Checkout の表示と支払い） |
| [dashboard.md](../architecture/dashboard.md) | 専用のアラートは置かない。公開 API の SLO と合成監視で見る（ダッシュボードは公開 API を呼ぶ。ADR-0028） |
| [infrastructure.md](../architecture/infrastructure.md)、[capacity.md](../architecture/capacity.md) | AZ・リージョンの障害と複製の遅延（[disaster-recovery.md](disaster-recovery.md)）、キャパシティの見直し（5 節） |
| [delivery.md](../architecture/delivery.md) | デプロイとお金の不変条件のガード（[deploy-and-rollback.md](deploy-and-rollback.md)） |
| [observability.md](../architecture/observability.md) | アラートの条件の正本の実装側（5.2 節） |
| [data-model.md](../architecture/data-model.md) | データモデルの正本。保持とパーティションの `DROP` は 3.11 節。運用の手順は各領域の文書で扱う |

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| PITR からの復元訓練（台帳の再計算の一致を含む） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の E |
| 計画外のフェイルオーバーと失った決済の回復の訓練（staging・cde-nonprod） | 四半期 | [disaster-recovery.md](disaster-recovery.md) の E |
| 本番の switchover（大阪で決済を受けて戻す） | 年 1 回 | [disaster-recovery.md](disaster-recovery.md) の E |
| 大阪の待機の構成の確認 | 月次 | [disaster-recovery.md](disaster-recovery.md) の E |
| コネクタの障害注入（模擬のアクワイアラでのタイムアウト・切断・照会の遅延） | 月 1 回、staging | `connector-outage.md`（E3） |
| 負荷試験（モデルの 1 倍・2 倍、コネクタの遅延、大口の集中）。大型セールの前は 2 倍を 1 時間 | リリース前、四半期 | [capacity.md](../architecture/capacity.md) の 5 節 |
| キャパシティの見直し | 月次 | [capacity.md](../architecture/capacity.md) の 5 節 |
| 鍵のローテーションと `ReEncrypt` の手順の実行 | 年 1 回、staging | `key-rotation.md`（E10） |
| CDE のアクセスの見直し（承認者の名簿、JIT の記録） | 四半期 | `cde-access.md`（E10、ADR-0020） |
| 期限を過ぎたカード番号の消し残しの確認 | 四半期 | ADR-0024 |
| 外部の脆弱性スキャン（ASV） | 四半期と大きな変更の後 | [security.md](../architecture/security.md) の 10 節 |
| 分割（セグメンテーション）の検証 | 6 か月ごとと分割の方式の変更の後 | 同上 |
| ペネトレーションテスト | 年 1 回と大きな変更の後 | 同上 |
| インシデント対応の計画の試験（カード番号の漏洩を想定） | 年 1 回 | [incident-response.md](incident-response.md) |
| SCP の検査（本体のロールが CDE のロールを引き受けられない） | 四半期 | ADR-0029 |
| CDE の本番へのデプロイと変更記録の突き合わせ | 四半期 | ADR-0033 |
| 営業日の表（`business_calendars`）の更新 | 年 1 回 | [ledger.md](../architecture/ledger.md) の 5.1 節 |

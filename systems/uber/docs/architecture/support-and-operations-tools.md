# Support and operations tools: Uber

社内の運用（サポート、安全、事業者の審査、経理、地図と運賃の規則の担当）が使うツール。乗車の調べ、運賃の訂正と返金（台帳を通す）、軌跡の監査つきの閲覧、2 人の承認が要る変更、問い合わせの受け付け、事業者の管理画面と共通の部分（権限・監査・即時の更新）を決める。

前提となる決定は、人が軌跡を見る操作は理由と監査ログを必須にすること（[ADR-0010](../decisions/0010-location-trails-map-matching-and-retention.md)）、乗降の地点と区域の多角形の変更は 2 人の確認で行うこと（[ADR-0034](../decisions/0034-geocoding-provider-and-pickup-points.md)、[ADR-0033](../decisions/0033-osm-import-and-service-area-polygons.md)）、運賃の訂正と返金は `fare_adjustments` と台帳で行うこと（[payments-and-payouts.md](payments-and-payouts.md) の 6・8 節、[ADR-0025](../decisions/0025-ledger-settlement-and-reconciliation.md)）、運賃の規則の有効化は 2 人の承認（[pricing-and-fares.md](pricing-and-fares.md) の 10 節）、事業者の管理画面の役割と画面（[supply-and-operators.md](supply-and-operators.md) の 5 節）、管理画面は Web（TypeScript）で書くこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）、NFR-009（人が軌跡を見る操作は 100% 監査ログ）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0032](../decisions/0032-ops-console-roles-limits-change-requests-and-audit.md) | 社内の運用のツールは 1 つの Web の画面（`ops.<domain>`）と運用の API にする。権限はロールと金額の上限で決め、軌跡・個人の情報・通話の記録の閲覧は、チケットかインシデントの ID を理由にした 30 分の一時の権限で行う（位置は ADR-0036 の `location_access_grants`）。お金と規則とデータの変更は、書き手と承認者を分ける変更の要求（`change_requests`）で行う。監査ログの形と保持は [ADR-0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md) に従い（同じトランザクションで書き、outbox で S3 Object Lock へ）、閲覧の API の呼び出しと毎日照合する。エージェントは下書きを作れるが、承認と適用はできない |

## 1. 目的と範囲

- 扱う：運用のロールと権限、乗車の調べの画面、軌跡の閲覧、運賃の訂正と返金の操作、2 人の承認の仕組み（変更の要求）、監査ログ、問い合わせ（チケット）の受け付けと振り分け、アプリの中のヘルプ、食い違いと復元した乗車の確認、事業者の管理画面との共通の部分。
- 扱わない：返金と訂正の仕訳（[payments-and-payouts.md](payments-and-payouts.md)）、事業者の管理画面の画面ごとの機能（[supply-and-operators.md](supply-and-operators.md) の 5 節）、安全の担当の対応の手順（[safety-and-trust.md](safety-and-trust.md) の 4・8 節）、社員の認証の方式と鍵（`security.md`）、配車の設定の変更（`delivery.md`）。
- 運用のツールは、乗客とドライバーの位置と個人の情報を最も広く見られる場所である。「見せる範囲を狭く、見たことを必ず残す」を原則にする。

## 2. ロールと権限

### 2.1 社内のロール

| ロール | できること | 金額の上限（1 件・1 日） |
| --- | --- | --- |
| `support_t1` | 乗車の調べ（丸めた位置）、チケットの対応、キャンセル料の免除、補償の返金 | 1 件 3,000 円、1 日 30,000 円 |
| `support_t2` | T1 に加え、運賃の訂正（減額・増額の申請）、軌跡の閲覧、乗客の利用の制限の申請 | 1 件 10,000 円未満、1 日 100,000 円 |
| `safety_agent` | 安全のインシデントの対応、軌跡と押した後の位置の閲覧、番号を隠した電話、ドライバーの `safety_hold` の申請 | 返金はしない |
| `safety_lead` | `safety_agent` に加え、`safety_hold` の承認、警察の照会への回答の承認（法務と 2 人） | — |
| `supply_reviewer` | 事業者・車両・ドライバーの書類の審査（[supply-and-operators.md](supply-and-operators.md)） | — |
| `finance_ops` | 返金・訂正の承認（10,000 円以上）、償却、仮勘定の解消、まとめての返金の承認 | 1 件 500,000 円 |
| `geodata_editor` | 区域の多角形・乗降の地点の変更の下書きと承認（書き手と別の人） | — |
| `fare_rule_editor` | 運賃の規則の下書きと承認（書き手と別の人） | — |
| `release_manager` | アプリの `required_min`、`nav_handoff_targets` の変更の下書きと承認（[rider-and-driver-apps.md](rider-and-driver-apps.md) の 10.3 節） | — |
| `auditor` | 監査ログの閲覧と書き出しだけ | — |
| `legal_counsel` | `legal_gate_records` とリーガルホールドの作成と取り消し、運賃の規則（L2 の対象）と位置の外部への提供の承認（[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)。2026-09-28 に足した） | — |

- 上限の値は、S1 の初めの値として 2026-09-28 に確定した（E11 の `ops-policy-engine`）。S1 の問い合わせの分布を見て見直す。
- 1 人に複数のロールを付けてよいが、同じ変更の要求の書き手と承認者は別の人にする（4 節）。
- 上限は Cedar などの方針のデータで持ち、コードに書かない。判定は運用の API の 1 か所で行う（Slack の題材の 1 つの判定の関数と同じ考え方）。

### 2.2 一時の権限（just-in-time）

- 次の閲覧は、ロールだけでは足りず、**理由つきの一時の権限**を要る：軌跡（乗車の軌跡、押した後の位置）、個人の情報の全体（名前・電話番号の全桁・メール）、通話の記録、乗車のメッセージの本文、安全の報告の本文、事業者の書類の画像。
- 担当は、チケットかインシデントの ID と、閲覧する対象（1 乗車・1 人）を入れて権限を求める。ロールと対象が合えば、その対象だけに 30 分の権限が出る（自動）。位置の閲覧の権限は [ADR-0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md) の `location_access_grants`（30 分、1 乗車の区間か 1 つのインシデント）そのもので、この領域はその画面と申請の流れを持つ。複数の乗車・1 人の期間の軌跡・外部への提供は、ADR-0036 のとおり法務の担当と運用の責任者の 2 人の承認を要する。安全の報告の本文だけは、`safety_lead` の承認を要る。
- 権限は、対象の乗車・人の ID に結びつき、他の対象に使えない。

### 2.3 社員の認証

- IAM Identity Center の SSO と多要素の認証（[ADR-0037](../decisions/0037-authentication-device-integrity-and-fraud-response.md)）。フィッシングに強い FIDO2 の鍵を求め、管理された端末からだけ入れる。本番のデータを読むロールは、ADR-0037 の期限つきの承認（最長 4 時間）の中で使い、2.2 節の一時の権限はその中でさらに対象を絞る。
- セッションは 8 時間、操作がなければ 30 分で切る。

## 3. 乗車の調べ

### 3.1 探し方

| 鍵 | 方法 |
| --- | --- |
| 乗車の ID、領収書の番号 | 完全一致 |
| 乗客の電話番号 | E.164 に正規化した番号の HMAC で完全一致。部分一致は作らない |
| ドライバー・車両の番号・事業者と日時 | 事業者 × 日付の範囲 × ドライバーで絞る |
| チケット・インシデント | 結びついた乗車 |

- 探した結果の一覧は、乗客とドライバーの名前を姓の頭文字だけ、電話番号を下 4 桁だけで出す。

### 3.2 乗車の詳細

| 区画 | 中身 | 元 |
| --- | --- | --- |
| 時系列 | 状態の遷移（発生の時刻と記録の時刻の両方）、オファーの履歴、journal の送り直し、`restored` の印 | `trip_events`、`trip_commands`（[trips-lifecycle.md](trips-lifecycle.md)） |
| 場所 | 乗車地・降車地（`street` に丸めた点と名前）。正確な値は軌跡の閲覧（3.3 節）で | `trips` |
| 運賃 | 見積もりの内訳、選んだルート（距離・経由地点の名前・提供者・地図の版）、メーターの額と出どころ、照合の結果、訂正 | `fare_quotes`、`meter_readings`、`fare_adjustments`（[pricing-and-fares.md](pricing-and-fares.md)） |
| 支払い | 与信・確定・返金の状態、PSP の参照、台帳の仕訳の一覧（読み取りだけ） | [payments-and-payouts.md](payments-and-payouts.md) |
| ナビ | 引き継ぎの記録、逸脱の知らせ、当てはめの逸脱の距離 | `trip_nav_events`、`trip_trails` |
| 安全 | 共有の有無、インシデント、報告、評価（一時の権限で本文） | [safety-and-trust.md](safety-and-trust.md) |
| 連絡 | 通話の記録（時刻と長さ）、メッセージ（一時の権限で本文） | `call_logs`、`trip_messages` |
| 食い違い | `trip_conflicts` と、その解決 | [trips-lifecycle.md](trips-lifecycle.md) の 8.4 節 |

- 画面は読み取りだけで、乗車の行を直接変える操作を置かない。状態を変えるのは `system_cancel`（理由と監査）と、食い違いの解決（3.4 節）だけで、どちらも Trips の遷移関数を呼ぶ。

### 3.3 軌跡の閲覧

- 窓口は `trail-viewer` の API だけ（ADR-0010）。一時の権限（2.2 節）の対象の乗車の、迎車の開始から降車まで（インシデントのときは押した後の位置も）を返す。
- 画面は地図に線を描くだけで、座標の書き出し・コピーの機能を置かない。地図に担当の ID と時刻の透かしを出す。
- S3 の `trip-trails/` は、`trail-viewer` のロールだけが位置の KMS の鍵で読める。担当のブラウザーには、描画用に間引いた線（最大 500 点）だけを返す。
- 呼び出しごとに監査ログを書き、書けなければ返さない（監査ログを先に書く）。
- 毎日、`trail-viewer` の API のアクセスの記録と監査ログの件数を照合し、1 件でも違えば SEV2（ADR-0010 の Confirmation）。

### 3.4 食い違いと復元した乗車の確認

- `trip_conflicts` と `restored` の乗車（[trips-lifecycle.md](trips-lifecycle.md) の 8.4・8.5 節）を一覧にし、`support_t2` が確かめる。
- 解決の選択肢は「状態を変えない」「運賃を訂正する（5 節）」「キャンセル料を免除する」「運用が乗車を完了にする（Trips の遷移を運用の事象として）」。終端の状態を戻す操作は置かない。

## 4. 変更の要求（2 人の承認）

```sql
change_requests (id, kind, target_ref,
                 payload jsonb,          -- 変更の中身（差分）
                 preview jsonb,          -- 適用の前の検査の結果（区域なら無作為の点の判定、返金なら仕訳の案）
                 author_id, author_kind,  -- 'human' | 'agent'
                 approver_id, status,     -- draft → pending → approved → applied | rejected | expired
                 reason, ticket_ref,
                 created_at, decided_at, applied_at, expires_at,  -- 既定 7 日
                 idempotency_key)
```

| `kind` | 書ける人 | 承認できる人 | 適用の前の検査 |
| --- | --- | --- | --- |
| `fare_adjustment`（10,000 円以上、補償の上限の超過） | `support_t2` | `finance_ops` | 仕訳の案、返金の合計の上限（[payments-and-payouts.md](payments-and-payouts.md) の 6 節） |
| `bulk_refund`（障害のときのまとめての返金） | `finance_ops` | `finance_ops`（別の人）と Dev のリーダー | 対象の乗車の一覧と合計の試算（dry-run） |
| `service_area_polygon`（`fare_zone` などすべての区域の種類） | `geodata_editor` | `geodata_editor`（別の人） | 変更の前後の多角形の地図の差分、無作為の 10 万点の判定の一致（[maps-and-geodata.md](maps-and-geodata.md) の 10 節） |
| `pickup_point` | `geodata_editor` | `geodata_editor`（別の人） | 80 m・50 m の規則の検査（ADR-0034） |
| `fare_rule_set`・`dynamic_fare_policy` | `fare_rule_editor` | `fare_rule_editor`（別の人）と法務の窓口（L2 の対象の規則） | 決定表のテストと、幅の検査（[pricing-and-fares.md](pricing-and-fares.md)） |
| `client_policy`・`nav_handoff_targets` | `release_manager` | Dev と Ops（別の人） | 影響する端末の数 |
| `operator_bank_account` | 事業者の `operator_owner`（申請） | `finance_ops` | 事業者の登録の連絡先への通知（[payments-and-payouts.md](payments-and-payouts.md) の 14 節） |
| `safety_hold`（ドライバーの停止） | `safety_agent` | `safety_lead` | 事業者への連絡の記録 |
| `law_enforcement_response` | `safety_agent` | `safety_lead` と法務 | 回答の範囲（L7） |

- **書き手と承認者は必ず別の人**（DB の検査 `author_id <> approver_id`）。承認者は、承認の時点でその `kind` のロールを持つ。
- 適用は `idempotency_key` で冪等にし、適用の処理は各領域の API（Payments・Pricing・Maps・Supply）を呼ぶ。運用の API は、各領域の DB に直接書かない。
- 期限（7 日）を過ぎた要求は `expired` にする。承認の後、24 時間の中で適用されなければ警告する。
- **エージェント**（AI）は `author_kind = agent` として下書きを作れる（チケットから返金の案を作るなど）。承認と適用はできない（[AGENTS.md](../../../../AGENTS.md) の「エージェントは承認しない」）。エージェントの下書きは、人が書き手として引き受けてから承認に回る（書き手の人と承認者の人は別）。

## 5. 運賃の訂正と返金

- 種類・承認・事業者の精算への影響は [payments-and-payouts.md](payments-and-payouts.md) の 6 節の表に従う。この領域は、その操作の画面と、上限と承認の判定を持つ。
- 画面の流れ：乗車の詳細 → 「訂正・返金」→ 種類と額と理由のコード、チケットの ID → 仕訳の案と、事業者の精算への影響の表示 → 上限の中なら送信（`fare_adjustments` を作る）、超えれば変更の要求。
- 訂正の額は、画面でも「確定の額と追加の請求の合計を超えない」を検査する（Payments の DB の検査が最後の守り）。
- `correction_up`（増額）は、事業者の確認が要る。事業者の管理画面に確認の依頼を出し、事業者の `operator_admin` が確かめる。
- 事業者は、自社の乗車の訂正を**申請**できる（管理画面）。この基盤の運用が承認する。
- 同じ乗車の訂正は `seq` で順に扱い、二重に作らない（チケットの ID と種類で重複を検査）。
- **自動の処置**：S1 で自動で返金するのは、キャンセル料の免除の規則（ドライバーの迎車の到着が、受諾の時点の ETA より 5 分以上遅れていた乗車の、乗客の取り消し）だけにする。規則は版つきのデータで、release フラグの裏に置く。

## 6. 問い合わせとアプリの中のヘルプ

- 乗客とドライバーは、アプリの乗車の履歴から、乗車を選んで問い合わせる。区分（運賃・キャンセル料・忘れ物・ドライバーの言動・アプリの不具合・安全）を選び、安全の区分は安全の報告（[safety-and-trust.md](safety-and-trust.md) の 8 節）に回す。
- 問い合わせは、この基盤の `support_tickets` に置く（S1）。外部のヘルプデスクの SaaS は使わない。乗車・監査・変更の要求と結びつけやすく、個人の情報を外部に出さないため（外部の SaaS を使うかは、S2 で問い合わせの量と、外国への提供の法務の確認（L4）を見て決める）。
- 振り分け：区分と、乗車の状態（未確定の運賃、食い違いあり）で、`support_t1`・`support_t2`・`safety_agent` の列に入れる。
- 返答の下書き：エージェントがチケットの中身と乗車の詳細（丸めた位置だけ）から下書きを作り、担当が確かめて送る。エージェントに一時の権限を与えない。
- 目標：最初の返答まで、普通の区分で 24 時間、運賃・キャンセル料で 12 時間（S1 の目標として 2026-09-28 に確定。E11 の `support-tickets`）。S1 の実績で見直す。
- 忘れ物：降車の 30 分の後は番号を隠した通話が切れる（[safety-and-trust.md](safety-and-trust.md) の 6 節）。忘れ物の問い合わせは、担当がドライバー（事業者）に連絡し、受け渡しの方法を決める。

## 7. 事業者の管理画面との共通の部分

事業者の管理画面の画面と役割は [supply-and-operators.md](supply-and-operators.md) の 5 節。社内の運用のツールと、次を共通にする。

| 共通の部分 | 中身 |
| --- | --- |
| 画面の基盤 | 同じ Web の部品（TypeScript）。ドメインは `ops.<domain>`（社内）と `operator.<domain>`（事業者。[infrastructure.md](infrastructure.md) の 4 節）で分け、API も `ops/v1` と `operator/v1` で分ける |
| 監査ログ | 同じ `audit_events`。事業者の `operator_owner` は自社の利用者の操作だけを見られる |
| 即時の更新 | 安全のインシデント、書類の期限、運行枠の上限の変化などを、Server-Sent Events（`/events`）で画面に送る。`rt-gateway`（[notifications-and-realtime-push.md](notifications-and-realtime-push.md)）は使わない。ブラウザーの画面だけの経路で、正しさは再読み込みで保つ |
| 位置の見せ方 | 乗車の後の履歴は `street` に丸める。正確な位置は理由と監査つき（[supply-and-operators.md](supply-and-operators.md) の 9 節） |
| 変更の要求 | 事業者の申請（振込先の変更、訂正の申請）は 4 節の仕組みに入る |

- 事業者の「稼働の地図」（自社のオンラインの車の位置）は、運行管理の目的で、事業者の利用者に自社の車の位置を見せる（[supply-and-operators.md](supply-and-operators.md) の 5.2 節）。これは「乗車の相手にだけ正確な位置を見せる」規則（NFR-009）の 2 つの例外の 1 つで、運送の主体の事業者の運行管理に限る。見るたびに監査ログを残す。扱いは法務の確認待ち（L4）で、`legal.l4.operator_fleet_map` の裏に置く（[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)）。

## 8. 監査ログ

監査ログの表（`audit_events`）、書き方（操作と同じトランザクションで書き、outbox で log-archive の S3 の Object Lock へ送る）、保持（Aurora に 1 年、アーカイブに 7 年。既定案で法務の確認待ち）は [ADR-0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md) と `security.md` が正本。この領域は、何を書くかと、どう照合するかを決める。

- 書く対象：一時の権限の発行と使用、軌跡・個人の情報・通話の記録・メッセージ・報告・書類の閲覧、すべての変更（返金、訂正、変更の要求、`system_cancel`、`safety_hold`）、ロールの付与と剥奪、ログイン。
- 項目：主体（種類・ID・ロール）、組織（`platform`・`operator` と ID）、操作、対象、理由、チケット、一時の権限の ID、要求の ID、結果。
- 監査ログを書けなければ、閲覧も変更も失敗させる（同じトランザクションのため）。
- 毎日、閲覧の API のアクセスの記録と監査ログの件数を照合する。1 件でも違えば SEV2。
- 監査ログの閲覧は `auditor` と、事業者の `operator_owner`（自社の分）だけ。監査ログの閲覧も監査ログに残す。

## 9. 失敗のしかた

| 失敗 | 起きること | 抑え方 |
| --- | --- | --- |
| 監査ログを書けない | 閲覧と変更ができない | 監査ログを先に書く。書けなければ操作を失敗させる（閲覧の可用性より監査を優先） |
| Payments の API の障害 | 返金を作れない | 変更の要求を `approved` のまま残し、回復の後に適用する（冪等） |
| 権限の設定の誤り | 見えてはいけないものが見える | 方針のデータの変更も変更の要求で行い、方針のテスト（ロール × 操作の表）を CI で回す |
| 担当の不正（まとめての閲覧） | 多くの乗車の軌跡を見る | 1 人 1 日の軌跡の閲覧が 20 件を超えたら `safety_lead` に知らせる。一時の権限は 1 対象に限る |
| 画面の障害 | 担当が調べられない | 安全のインシデントの受信は画面と別の経路（[safety-and-trust.md](safety-and-trust.md) の 4.3 節） |

## 10. セキュリティとプライバシー

- 社内の運用の API は、社内のネットワークの経路（ゼロトラストの接続の仕組み）からだけ呼べる。インターネットに直接出さない（方式は `security.md`）。
- 画面に出す個人の情報は、既定で伏せる（名前の頭文字、電話番号の下 4 桁、位置の `street`）。全体を出すのは一時の権限の中だけ。
- 書き出し（CSV）は、`finance_ops` の明細と `auditor` の監査ログだけに置く。乗車の一覧の書き出しは置かない。
- ログとトレースに、個人の情報と緯度経度を書かない（[AGENTS.md](../../AGENTS.md)）。
- 担当の画面のスクリーンショットの防止はしない（管理された端末の方針に任せる）。透かしで出どころを追えるようにする。

## 11. テスト

- **PROP-OPS-001（2 人の承認）**：任意の要求・承認の列で、書き手と承認者が同じ人の変更、承認者がロールを持たない変更は適用されない。
- **PROP-OPS-002（監査の完全性）**：軌跡・個人の情報の閲覧の API の任意の呼び出しの列（監査ログの書き込みの失敗を注入）で、監査ログの行のない閲覧の応答は 0 件。
- **PROP-OPS-003（上限）**：任意の返金の列で、担当ごとの 1 件・1 日の上限を超える返金は、変更の要求なしに作られない。
- **PROP-OPS-004（一時の権限の範囲）**：一時の権限は、発行した対象と期限の中でだけ使える。
- 方針のテスト：ロール × 操作 × 対象の表（決定表 DT-OPS-001）を表駆動のテストにする。
- 照合の試験：閲覧の API のアクセスの記録から 1 件を消す・足すと、毎日の照合が失敗すること。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E11 | `ops-console-shell` | `ops.<domain>` の画面の基盤、SSO と多要素の認証、ロール |
| E11 | `ops-policy-engine` | 2.1 節の方針のデータと判定、DT-OPS-001 |
| E11 | `jit-access-grants` | 2.2 節の一時の権限（PROP-OPS-004） |
| E11 | `trip-lookup` | 3.1・3.2 節の探し方と詳細の画面 |
| E11 | `trail-viewer-audited` | 3.3 節（location の Story と同じ。PROP-OPS-002） |
| E11 | `trip-conflict-review` | 3.4 節（trips の Story と同じ） |
| E11 | `change-requests` | 4 節の仕組みと、各領域の適用の API（PROP-OPS-001） |
| E11 | `fare-adjustment-ui` | 5 節の訂正と返金の画面、上限（PROP-OPS-003）。payments と一緒に |
| E11 | `bulk-refund-dry-run` | 障害のときのまとめての返金 |
| E11 | `support-tickets` | 6 節の問い合わせ、振り分け、エージェントの下書き |
| E11 | `audit-coverage-and-reconciliation` | 8 節の書く対象の網羅と毎日の照合（監査ログの基盤は security の Story） |
| E11 | `ops-sse-events` | 7 節の即時の更新（社内と事業者） |
| E2 | `operator-correction-requests` | 事業者からの訂正の申請と増額の確認（supply と一緒に） |
| E4 | `geodata-change-approval` | 区域と乗降の地点の変更の要求と検査（maps と一緒に） |
| E7 | `fare-rule-change-approval` | 運賃の規則の変更の要求（pricing と一緒に） |

## 13. 未解決の問い

### 決定

2026-09-27、既定案。

- **画面**：社内は `ops.<domain>`、事業者は `operator.<domain>`。同じ部品、別の API。
- **権限**：ロールと金額の上限。機微な閲覧は理由つきで 30 分・1 対象の一時の権限（位置は ADR-0036 の `location_access_grants`）。
- **変更**：`change_requests` で書き手と承認者を分ける。エージェントは下書きだけ。
- **返金の上限**：T1 は 1 件 3,000 円、T2 は 10,000 円未満、それ以上は `finance_ops` の承認（Payments の 6 節の「1 万円以上は 2 人」と合わせる）。
- **監査ログ**：ADR-0036 の形と保持（Aurora 1 年、アーカイブ 7 年の既定案）。この領域は書く対象と照合を決める。
- **問い合わせ**：S1 は自前のチケット。外部の SaaS は使わない。
- **自動の返金**：キャンセル料の免除の 1 つの規則だけ（フラグの裏）。
- **即時の更新**：SSE。`rt-gateway` と分ける。

### 決定（2026-09-28、推奨案で確定）

- **運用のロールの上限の値**：2.1 節の値を S1 の初めの値にする。S1 の分布で見直す。
- **最初の返答の目標**：普通の区分で 24 時間、運賃・キャンセル料で 12 時間。
- **社内の運用を外部に委ねるか**：S1 は委ねない。夜間のサポートも社内の担当で持つ。委託先のロールと監査の仕組みを足さずに済み、個人の情報を外に出さないため。S2 で問い合わせの量を見て見直す。
- **事業者の管理画面への即時の更新**：`rt-gateway` と分けた SSE のまま（上の決定）。[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 14 節の持ち越しも、これで閉じた。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 問い合わせの保持の期間（L4・L7）。監査ログの保持は ADR-0036 の既定案 | 法務の確認待ち |
| 事業者の稼働の地図で正確な位置を見せる扱い（L4） | 法務の確認待ち。確認まで `legal.l4.operator_fleet_map` の裏 |
| 外部のヘルプデスクの SaaS を使うか | S2。量と、外国への提供の確認（L4）を見て |
| 返金の上限の値、最初の返答の目標の時間の見直し | S1 の運用の結果で |
| 警察の照会への回答の手順（L7） | 法務が決める |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 監査ログと閲覧の API の毎日の照合の不一致の件数（0 件）。
- 一時の権限の発行の件数（ロール・理由の種類ごと）、1 人 1 日の軌跡の閲覧の最大。
- 変更の要求の承認までの時間、期限切れの件数、承認の後に適用されない件数。
- 返金と訂正の件数と額（種類・負担者ごと）、上限を超えて変更の要求になった件数。
- 問い合わせの最初の返答までの時間（区分ごと）、再び開いた割合。
- `trip_conflicts` の解決までの時間。

### runbooks

- `audit-reconciliation-mismatch.md`：照合の不一致のときの確かめ方（閲覧の API のログ、監査ログの書き込みの失敗）と、SEV2 の扱い。
- `bulk-refund.md`：障害のときのまとめての返金の手順（対象の抽出、dry-run、2 人の承認、適用、事業者への説明）。
- `ops-access-review.md`：月 1 回のロールの棚卸しと、退職・異動のときの剥奪。
- `suspicious-ops-access.md`：担当の閲覧が急に増えたときの確かめ方と、権限の停止。
- `change-request-stuck.md`：承認の後に適用されない要求の確かめ方と、適用し直し。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `staff_users`（`id`、`idp_subject`、`status`）、`staff_role_grants`（`staff_id`、`role`、`granted_by`、`granted_at`、`revoked_at`） | 2.1 節 |
| Aurora `jit_grants`（位置以外。位置は ADR-0036 の `location_access_grants`）（`id`、`staff_id`、`scope`（pii・call_log・message・report・document）、`target_type`、`target_id`、`reason`、`ticket_ref`、`approved_by`、`expires_at`） | 2.2 節 |
| AppConfig `ops_policies`（ロール × 操作 × 上限） | 2.1 節。変更は変更の要求で |
| Aurora `change_requests` | 4 節 |
| Aurora `support_tickets`（`id`、`requester_kind`、`requester_id`、`trip_id`、`category`、`status`、`queue`、`assigned_to`、`created_at`、`first_response_at`、`resolved_at`）、`support_ticket_messages` | 6 節 |
| Aurora `audit_events` と log-archive の S3（ADR-0036） | 8 節。この領域は `action` の値の一覧を足す |
| Aurora `auto_refund_rules`（版、条件、有効期間） | 5 節 |

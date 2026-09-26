# Fraud: Stripe

ルールによる不正検知、速度の検査、ブロック・許可のリスト、3D セキュアの要否の判断、レビューのキュー、外部の不正検知サービスとの連携、指標。

| 関連 | 決定 |
| --- | --- |
| [ADR-0021](../decisions/0021-fraud-rules-engine.md) | Radar に寄せたルールの言語を、決済の経路の中で同期に評価する。速度は Valkey の集計、外部のサービスはシグナルの 1 つ |
| [ADR-0004](../decisions/0004-idempotency.md) | 評価の結果は、決済の試行ごとに 1 回だけ記録する |
| [ADR-0005](../decisions/0005-pci-scope-segmentation.md) | Fraud は CDE の外にあり、PAN を見ない。カードは指紋・BIN・下 4 桁で扱う |

## 1. 目標と前提

- MVP は**ルールと外部の不正検知サービスの連携**で行う。機械学習のモデルは作らない（intent.md の Non-goals）。
- 本家の Radar に寄せる。ルールの書き方（`{action} if {条件}`）、4 つの動作（3DS の要求・許可・ブロック・レビュー）、リスト、レビューのキュー、ルールの試験と段階的な適用を同じ考え方にする（[Radar のルール](https://docs.stripe.com/radar/rules)、2026-09-26 に確認）。
- **決済の API の可用性（NFR-001）を不正検知の障害で落とさない。** Fraud の部品が落ちたら、決済は既定のルールだけで続け、後でレビューに回す（4.4 節）。
- 日本のクレジットカード・セキュリティガイドラインは、EC 加盟店に EMV 3-D セキュアの導入と、不正ログイン対策を求めている（6.0 版で追加、2026 年 3 月の 6.1 版でも指針対策は変わらない。[日本クレジット協会の改訂の資料](https://www.j-credit.or.jp/security/pdf/Creditcardsecurityguidelines_6.1_revisionpoint.pdf)）。3DS の既定の判断（5 節）は、これを前提にする。

## 2. 全体の流れ

```
PaymentIntent の confirm（Payments）
  │
  ├─ 段 1：3DS の判断（request_3ds のルール、発行会社の要求、日本発行のカードの CIT）
  │     └─ 必要なら 3DS（Connector Gateway 経由で 3DS Server へ）→ 結果を属性に入れる
  │
  ├─ 段 2：オーソリの前の判定（allow → block → review の順）
  │     ├─ block  → 決済を失敗にする（コネクタへ送らない）。outcome.type = blocked
  │     └─ それ以外 → オーソリへ
  │
  ├─ オーソリ（コネクタ）
  │
  └─ 段 3：オーソリの後の判定（発行会社の CVC・住所の照合の結果を使うルールだけ）
        ├─ block  → オーソリを取り消す（void）。outcome.type = blocked
        └─ review → オーソリ・キャプチャは通常どおり進め、レビューを開く
```

- [payments.md](payments.md) の 4 節の手順との対応：段 1 は手順 3（不正検知）、段 2 は手順 6（3D セキュア）の後で手順 7（オーソリ）の前、段 3 は手順 8（結果の反映）の前。段 2 でブロックした試行はコネクタへ送らず、`decline_code = fraudulent`（顧客には `generic_decline`）で失敗にする。
- 段の順序と「許可は他のすべてに優先する」「レビューはブロックの後に評価する」「3DS の要求のルールは他より先に評価する」は本家と同じ。
- 評価は Payments のプロセスの中のライブラリ（`packages/fraud-rules`）で行い、別のサービスへのネットワークの往復を増やさない。速度の集計と外部のサービスへの問い合わせだけが外に出る。
- 段 2 と段 3 の結果は、決済の試行の ID を冪等キーにして `fraud_evaluations` に 1 回だけ書く（ADR-0004 の内部の層）。
- 対象の決済手段：MVP はカードだけ。コンビニ払いと銀行振込は、ブロックとリストだけを適用する（本家もルールの属性で決済手段を絞れる）。

## 3. ルールの言語

### 3.1 形

```
{action} if {predicate}

Request 3D Secure if :risk_level: != 'normal' and :amount_in_jpy: > 30000
Block if :card_fingerprint: in @blocked_cards
Block if :card_country: != 'JP' and :is_anonymous_ip:
Review if :card_funding: = 'prepaid' and :is_disposable_email:
Allow if :customer: in @trusted_customers and :risk_level: != 'highest'
Block if :is_3d_secure: and not :is_3d_secure_authenticated:
```

- 動作は `request_3ds`・`allow`・`block`・`review` の 4 つ。
- 属性は `:name:`、メタデータは `::key::`、リストは `@alias`。演算子は `=`、`!=`、`>`、`<`、`>=`、`<=`、`in`、`and`、`or`、`not`、`is_missing()`。ループ・関数の定義・外部の呼び出しはない。
- ルールは保存時に AST へ構文解析し、型（属性と値の型の一致）を検査する。評価は純粋な関数で、1 件あたりの評価の上限（ノード数）を持つ。
- 加盟店ごとの上限：取引のルール 200 件、リスト 1 つあたり 5 万件（本家と同じ。[Radar のリスト](https://docs.stripe.com/radar/lists)）。

### 3.2 属性（MVP）

本家の属性の名前に合わせる（[サポートされる属性](https://docs.stripe.com/radar/rules/supported-attributes)）。

| 分類 | 属性 |
| --- | --- |
| 金額 | `amount_in_jpy`（ほかの通貨も換算して評価）、`currency` |
| カード | `card_brand`、`card_country`、`card_funding`、`card_bin`、`card_fingerprint`、`is_new_card_on_customer`、`seconds_since_card_first_seen` |
| 照合（段 3） | `cvc_check`、`address_zip_check` |
| 3DS（段 2） | `is_3d_secure`、`is_3d_secure_authenticated`、`has_liability_shift` |
| 顧客 | `customer`、`email`、`email_domain`、`is_disposable_email`、`seconds_since_email_first_seen` |
| 接続元 | `ip_address`、`ip_country`、`is_anonymous_ip` |
| 取引の文脈 | `is_off_session`、`payment_method_type`、`destination`（加盟店の国）、`risk_level`・`risk_score`（外部のサービス。6 節） |
| 速度（4 節） | `authorized_transactions_per_card_fingerprint_{hourly,daily,weekly}`、`declined_…`、`blocked_…`、`…_per_email_…`、`…_per_ip_address_…`、`email_count_for_ip_{hourly,daily}` |

- 本家の速度の属性の名前は `…_per_payment_instrument_fingerprint_…` などの形で、決済手段をまたぐ。MVP はカードだけなので `card_fingerprint` の名前で始め、決済手段を増やすときに本家の名前へ別名を付ける。

### 3.3 ルールの階層

| 階層 | 作る人 | 内容 |
| --- | --- | --- |
| プラットフォームのルール | 社内のリスクの担当（Ops） | 全加盟店に先に適用する。制裁の対象国、プラットフォームのブロックリスト（不正と報告されたカード）、カードテスティングの防御。加盟店は上書きできない |
| 既定のルール | 同上 | 全加盟店に既定で有効。加盟店が無効にできるもの（例：CVC の照合の失敗でブロック）もある |
| 加盟店のルール | 加盟店の owner・admin・developer | ダッシュボードと API で作る |

- 評価の順：段ごとに、プラットフォームのルール → 既定のルール → 加盟店のルール。`allow` は加盟店のルールと既定のルールには優先するが、**プラットフォームの `block` には優先しない**。本家でも許可のルールは申請して使う扱いで、既定のリスクの評価を上書きしうる危険を明示している（[Radar のルール](https://docs.stripe.com/radar/rules)）。
- ルールの作成・変更・無効化は監査ログに残す（ADR-0023）。本家は変更の履歴を 180 日見せる。本システムでは監査ログの保持期間に従う。

### 3.4 試験と段階的な適用

- **試験**：新しいルールを、過去 90 日の決済の評価の記録（`fraud_evaluations` の属性のスナップショット）に当て、影響する件数と金額、そのうちのちの Dispute・返金の件数を示す。本家は過去 6 か月で試す。S1 はデータの量から 90 日で始める。
- **段階的な適用**：取引のルールは、合致した決済のうち何 % に動作を適用するかを 0〜100% で指定できる。0% は影の評価（動作せず、合致だけを記録する）。本家と同じ。
- ルールの保存は、最新の版を楽観ロックで書き、評価の側は 10 秒以内に反映する（加盟店ごとのルールの集合を版つきでキャッシュする）。

## 4. 速度とリスト

### 4.1 速度の集計

- ElastiCache（Valkey）に、キー（加盟店 × 指紋・メール・IP × 結果の種類）ごとの時間のバケットを持つ。1 時間の窓は 1 分のバケット 60 個、1 日は 1 時間のバケット 24 個、1 週は 1 日のバケット 7 個。
- 集計の更新は、決済の結果の Event（outbox → SQS）から Worker が行う。Event の ID を 7 日の TTL で覚えて、再配送で二重に数えない。
- 同期の経路では読むだけ（1 回の `MGET` 相当）。更新の遅れの目標は p99 5 秒以内。カードテスティングのような秒単位の攻撃は、別に同期のレート制限で止める（7 節）。
- プラットフォーム全体の集計（加盟店をまたぐ、内部向けの指紋）も同じ方式で持ち、プラットフォームのルールだけが使う。

### 4.2 リスト

| 種類 | 既定のリスト（加盟店ごと） |
| --- | --- |
| ブロック | カードの指紋、BIN、発行国、メールアドレス、メールのドメイン、IP アドレス、IP の国、Customer ID |
| 許可 | 同上。**指紋の許可リストの項目は最長 30 日で失効する**（本家と同じ） |

- 加盟店は独自のリスト（文字列、指紋、BIN、Customer ID、メール、IP、国）を作れる。項目に有効期限を付けられる。
- リストは Aurora に置き、加盟店ごとに版つきで Payments のプロセスにキャッシュする（最大 10 秒の遅れ）。
- 「返金して不正と報告」（8 節）で、そのカードの指紋と関係するメールアドレスを既定のブロックリストへ自動で入れる（本家と同じ）。

### 4.3 データモデル

```sql
fraud_rules       (account_id, id, phase, action, source, ast JSONB, traffic_pct,
                   status, version, created_by, updated_at)          -- account_id NULL はプラットフォーム
fraud_lists       (account_id, id, alias, item_type, is_default, ...)
fraud_list_items  (account_id, list_id, value, expires_at, created_by, created_at)
fraud_evaluations (account_id, payment_attempt_id, phase, outcome, matched_rule_ids,
                   attributes JSONB, risk_score, evaluated_at)        -- 日ごとのパーティション
reviews           (account_id, id, payment_intent_id, opened_reason, rule_id,
                   status, closed_reason, assigned_to, opened_at, closed_at)
```

- すべてテナントテーブル（`account_id` と RLS。ADR-0002）。プラットフォームのルールは別のテーブル `platform_fraud_rules` に置き、RLS の例外を作らない。
- `fraud_evaluations.attributes` に PAN・CVC は入らない（Fraud は受け取らない）。メール・IP は個人情報として保持期間に従う（ADR-0024）。

### 4.4 障害時の振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Valkey が使えない | 速度の属性を「欠損」として評価する（`is_missing` が真。比較は偽）。メトリクスを出す |
| 外部のサービスの時限切れ | `risk_level` を欠損にする |
| ルールの評価で例外 | そのルールを飛ばし、アラートにする。ほかのルールは評価する |
| 上の 3 つのどれかが起きた決済 | 決済は続ける（fail-open）。`fraud_evaluations` に劣化の印を付け、金額が閾値を超えるものをレビューに回す |

- fail-open にするのは、NFR-001 を不正検知の部品の障害で落とさないため。プラットフォームのブロックリストだけは、Payments のプロセスのキャッシュで評価できるので、Valkey の障害でも効く。

## 5. 3D セキュアの判断

| 入力 | 判断 |
| --- | --- |
| 発行会社が認証を求めて拒否した（soft decline） | 3DS を行って再試行する（ルールにかかわらず。本家と同じ） |
| 加盟店の要求 `payment_method_options.card.request_three_d_secure` | `any`：可能なら行う。`challenge`：チャレンジを求める。`automatic`（既定）：下の判断に任せる |
| 日本で発行されたカード | 顧客がその場にいる決済（CIT）は常に要求する。加盟店は API で無効にできない（[ADR-0012](../decisions/0012-3ds-via-connector.md)）。フリクションレスかチャレンジかは発行会社が決める |
| `request_3ds` のルール | 合致すれば要求する |
| 顧客がいない決済（off-session、MIT） | 要求しない。最初の保存（CIT）で認証しておく |

- 3DS の実行の流れ（`requires_action`、3DS Server への要求）は [payments.md](payments.md) の 6 節と ADR-0012。Fraud が決めるのは「要求するか」だけ。
- 本家の日本での既定の振る舞い（`automatic` のときに日本発行のカードで常に要求するか）は未検証。検証の予定：日本のテスト環境で確かめ、Stripe の日本向けの文書と照合する。
- 3DS の結果（`is_3d_secure`、`is_3d_secure_authenticated`、`has_liability_shift`）を属性に入れ、段 2 で評価する。本家は、3DS を行わなかった決済をブロックするルールで、ウォレットと off-session を除外する例を示している。既定のルールもこれに倣う。
- 3DS の認証に失敗したら、オーソリへ進まず、PaymentIntent を `requires_payment_method` に戻す（[payments.md](payments.md)）。
- 3DS の要求を出しても、発行会社が行うとは限らない（本家の説明と同じ）。結果の種類ごとの扱いは [payments.md](payments.md) に書く。

## 6. 外部の不正検知サービス

```ts
interface RiskProvider {
  assess(input: RiskInput, deadlineMs: number): Promise<RiskAssessment | undefined>
}
// RiskInput：金額、通貨、BIN、下 4 桁、内部向けの指紋、メールのハッシュまたは値、IP、デバイスの情報、加盟店の業種
// RiskAssessment：risk_score（0〜99）、risk_level（normal / elevated / highest）、reasons[]
```

- 段 1 の前に呼び、結果を `risk_score`・`risk_level` の属性にする。時間の予算は 150ms。超えたら欠損として進む。
- **PAN を渡さない。** 渡すと提供者が PCI のスコープに入る。BIN・下 4 桁・指紋で足りる提供者を選ぶ。
- 提供者は加盟店ごとに有効化できる。既定は無効。有効化していない加盟店では `risk_level` は常に欠損で、本家の `risk_level` を使うルールはそのままでは働かない（ダッシュボードで知らせる）。
- 個人情報（メール、IP、デバイスの情報）を外部へ渡すことになる。**委託か第三者提供か、外国にある第三者への提供に当たるか、Checkout・Elements でデバイスの情報を集めて外部へ送ることが電気通信事業法の外部送信の規律に当たるかは、法務の確認が要る。**
- 結果（Dispute、不正の報告）を提供者へ返す仕組みは、提供者の API に合わせて E9 で作る。

## 7. カードテスティングの防御

公開キーで PaymentMethod を作れるため、盗んだ番号の有効性を小さな金額で試す攻撃の入口になる。

- Vault Ingress と confirm の API に、IP・公開キー・加盟店ごとのレート制限を掛ける（[rate-limiting.md](rate-limiting.md)）。
- 加盟店ごとに、拒否の率と、1 つの IP・指紋あたりの試行を監視する。閾値を超えたら、プラットフォームのルールで一時的に厳しくする（例：その加盟店の on-session の全件で 3DS を要求）。Vault の入口では WAF の Challenge を有効にする。
- 急増は runbook の `fraud-spike.md`（E9 で作る。[runbooks/README.md](../runbooks/README.md)）で扱う。

## 8. レビューのキュー（ダッシュボード）

本家のレビューに寄せる（[決済をレビューする](https://docs.stripe.com/radar/reviews)、2026-09-26 に確認）。

- `review` のルールに合致し、**オーソリに成功した**決済だけがキューに入る。拒否された決済は入らない。
- レビュー中の決済は、通常どおりキャプチャされる（手動キャプチャの決済はオーソリのまま）。MVP では入金を止めない。
- 操作：

  | 操作 | 効果 |
  | --- | --- |
  | 承認 | 変更せずにレビューを閉じる（`closed_reason = approved`） |
  | 返金 | 返金してレビューを閉じる（`refunded`）。手動キャプチャなら取り消し |
  | 返金して不正と報告 | 返金し、指紋とメールを既定のブロックリストへ（`refunded_as_fraud`） |
  | キャプチャ | 手動キャプチャの決済を、承認の前後にキャプチャできる |

- レビュー中に Dispute が来たら、レビューを自動で閉じる（`disputed`）。
- 早期の不正警告（EFW）を受けたら自動で全額返金する設定を、加盟店が選べる。既定は無効（[disputes.md](disputes.md) の 7 節）。返金したカードの指紋は既定のブロックリストへ入れる。
- レビューを担当者に割り当てられる。自分の割り当てだけを変えられる。
- Event：`review.opened`、`review.closed`（[events-and-webhooks.md](events-and-webhooks.md)）。
- 画面は [dashboard.md](dashboard.md)。ルールの作成とレビューの操作ができるロールは、[ADR-0008](../decisions/0008-api-keys-and-dashboard-access.md) のロールの決定表で決める（本家ではルールの作成は owner・admin・developer に限る）。

## 9. 指標

| 指標 | 用途 | アラート |
| --- | --- | --- |
| ブロック率・レビュー率（加盟店別、ルール別） | ルールの効き目、誤検知の兆候 | 加盟店のブロック率が 7 日の平均の 3 倍 |
| ルールごとの合致数・金額 | 本家のルールの指標に相当。急増・急減の検知 | ルールの合致数の急変 |
| 3DS の要求率・実施率・フリクションレス率・チャレンジの成功率 | 購入完了率への影響 | 成功率の急落（3DS Server の障害の兆候） |
| オーソリの承認率 | 不正の対策の副作用 | 承認率の急落 |
| 不正による Dispute の率（件数・金額）、不正の早期警告の率 | 結果の指標。ブランドの監視プログラムの基準と比べる（[merchant-onboarding.md](merchant-onboarding.md) の 6 節） | 加盟店の率が閾値に近づく |
| レビューの承認の割合、レビューの滞留時間 | レビューのルールが広すぎないか | 滞留の増加 |
| 評価の時間 p99、外部のサービスの時限切れの率、速度の集計の遅れ | 決済の経路の遅延の予算（NFR-002） | p99 20ms 超、時限切れ 5% 超 |
| 劣化した評価の件数（4.4 節） | fail-open の頻度 | 1 件でも |
| カードテスティングの兆候（7 節） | 攻撃の検知 | 閾値超え |

- 値は [observability.md](observability.md) の仕組みで集める。閾値の初期値は運用の開始後に見直す。

## 10. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E3 | 段 2 のブロックとプラットフォームのブロックリスト、`fraud_evaluations` の記録 |
| E3 | 3DS の判断（soft decline、加盟店の要求、日本発行のカード）と段 2 での 3DS の属性 |
| E7 | ルールとリストの編集画面、ルールの試験、レビューのキューと操作 |
| E9 | ルールの言語の全体（段 1〜3）、速度の集計、段階的な適用、外部のサービスの連携、不正の報告のリストへの反映、カードテスティングの防御 |
| E10 | 指標とアラート、runbook の `fraud-spike` |

## 11. 決定と持ち越し（2026-09-26、既定案）

- **レビュー中の決済の入金を止める設定**：MVP では持たない（8 節のとおり入金を止めない）。本家でも入金を止めるのはプラットフォーム向けのアカウントのルールで、Connect とともに扱う。
- 持ち越し：最初の外部の不正検知サービスは E9 で選ぶ（PAN を渡さずに使えるもの）。個人情報の渡し方（委託か第三者提供か、外国にある第三者、外部送信規律）は [intent.md](../intent.md) の「法務の確認待ち」。

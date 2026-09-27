# Delivery: Uber

ブランチ、CI、デプロイ、リリースとフラグの流れ。Slack の [delivery.md](../../../slack/docs/architecture/delivery.md) と Figma の [delivery.md](../../../figma/docs/architecture/delivery.md) を引き継ぎ、この題材に固有の 5 つを足す：**配車と運賃の再生・影の実行の関門**、**リースを持つ主と待機の入れ替え**、**都市のセルの単位の波**、**法務の確認待ちの経路の legal のフラグ**、**モバイルのアプリの列車とサーバーの互換**。

| 対象 | 方針 |
| --- | --- |
| ブランチモデル | リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)（トランクベース開発） |
| デプロイとマイグレーション、フラグの基盤 | Slack の [ADR-0022](../../../slack/docs/decisions/0022-zero-downtime-deploy-and-migrations.md)・[ADR-0026](../../../slack/docs/decisions/0026-feature-flags.md) を引き継ぐ |
| 配車と運賃の変更の関門、都市の波 | [ADR-0042](../decisions/0042-replay-and-shadow-gates-for-dispatch-and-pricing.md) |
| フラグの種類、法務の関門、安全の既定 | [ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md) |
| アプリの列車と強制の更新 | [ADR-0006](../decisions/0006-native-apps-contracts-vectors-and-release-train.md)（[rider-and-driver-apps.md](rider-and-driver-apps.md) の 10 節） |
| 手順 | [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |

原則は 4 つ。

- **`main` は常にデプロイできる状態に保つ。**
- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリースは PM が判断する。法務の確認待ちの経路は、法務の記録がないと本番で有効にできない（ADR-0043）。
- **配車と運賃の変更は、本番の乗客に届く前に、同じ入力で比べる。**
- **安全の機能は、どの失敗でも「出す」に倒す。**

## 1. 変更からマージまで

```
changes/YYMMDD-<slug>/ の spec・plan が承認済み
   ▼
ブランチ uber/YYMMDD-<slug>（エージェントは worktree ごとに 1 本）
   ▼
PR ─▶ PR の CI（2 節）─▶ レビュー（CODEOWNERS、作成者と別の人）
   ▼
merge queue ─▶ squash で main へ
```

- 未完成の振る舞いは release フラグの裏に置く。
- PR の説明に、変更フォルダ、規模、使うフラグ（種類）、**配車・運賃・遷移への影響**（なし・設定・計算）、**アプリとの契約への影響**（Protocol Buffers の変更の有無）、区分「安全」かを書く。

### 1.1 リポジトリの中の区分

開発リポジトリは 1 つ（モノレポ）。

| パス | 中身 | コードオーナー |
| --- | --- | --- |
| `proto/` | Protocol Buffers（アプリ・Go・TypeScript の契約。buf） | Dev のテックリード |
| `go/loc-ingest`、`go/geo-index`、`go/dispatch`、`go/eta`、`go/rt-gateway` | 熱い経路 | 配車の持ち主 |
| `go/dispatch/solver`、`go/dispatch/eligibility` | 最適化、候補の条件 | 配車の持ち主＋ QA |
| `services/trips` | 遷移関数、決定表（DT-TRIP） | Dev のテックリード＋ QA |
| `services/pricing`、`packages/money` | 運賃の計算、金額の型 | 運賃の持ち主＋ QA |
| `services/payments` | 支払い、台帳 | お金の持ち主（Stripe の題材の [ADR-0032](../../../stripe/docs/decisions/0032-release-safety-for-money-moving-code.md) の考え方） |
| `vectors/` | 状態機械のテストのベクター（アプリと共有。ADR-0006） | Dev のテックリード |
| `apps/rider-ios`、`apps/rider-android`、`apps/driver-ios`、`apps/driver-android` | アプリ | アプリの持ち主 |
| `apps/*/safety` | 緊急の入口 | 安全の持ち主＋ QA |
| `infra/` | Terraform（[infrastructure.md](infrastructure.md) の 10 節） | Ops |

- `services/trips`、`go/dispatch/solver`、`services/pricing`、`packages/money`、`apps/*/safety` の変更には、QA の承認を必須にする（GitHub のルールセット）。

## 2. CI

### 2.1 PR の CI

Slack の delivery.md の 2.1 節の段（型、lint、単体、結合、migration lint、`terraform plan`、秘密情報の検査）をすべて持ち、次を足す。目標は 20 分以内。

| 段 | 内容 | 失敗の条件 |
| --- | --- | --- |
| Go の検査 | `go vet`、`staticcheck`、`govulncheck`、`-race` の単体 | 1 件でも |
| 契約 | `buf lint`、`buf breaking`（main と比べ、サポートするアプリの版の範囲で互換を壊さない） | 互換を壊す変更に `contract-breaking` のラベルと承認がない |
| 状態機械のベクター | Trips の遷移の表から作ったベクターを、サーバーと 4 つのアプリの reducer で通す（ADR-0006） | 1 件でも |
| 決定表 | DT-TRIP・DT-DISP・DT-FARE・DT-PAY・DT-SUP を `spec.md` から読む表駆動テスト | 1 件でも |
| 性質ベーステスト | PROP-LOC・GEO・DISP・TRIP・FARE・PAY・SUP・SEC（PR ごとに 1 万の列） | 1 件でも |
| 配車の再生・シミュレーション | 配車の計算・設定を変える PR だけ。3 節 | 二重の割り当て 1 件、または基準の外 |
| `fare-replay` | 運賃の計算を変える PR だけ。3 節 | 許していない額の差 1 件 |
| 位置のログの検査 | 結合試験のログ・トレースに緯度経度の形の値がない（[location-ingestion.md](location-ingestion.md) の 14.3 節） | 1 件でも |
| 権限と漏洩 | 4 種類のトークン × API、位置の漏洩のテスト（[security.md](security.md) の 11 節） | 1 件でも |
| 保持の表 | [security.md](security.md) の 7.2 節の表と、生成した Terraform の値の一致（PROP-LOC-005） | 不一致 |
| 要件の追跡 | 要件 ID がテストから参照されている（[process.md](../../../../docs/process.md) の 7 節） | 参照のない ID |

### 2.2 夜間

- 性質ベーステストを 100 万の列で流す。
- 市場のシミュレーションを 1 日分、平常・雨・大雪の需要と複数の種で流す（[capacity.md](capacity.md) の 7.2 節）。
- `fare-replay` を直近 90 日の見積もりで流す。
- 小さな地域の Valhalla のタイルの作成と検査（[eta-and-routing.md](eta-and-routing.md) の 11 節）。
- 失敗ごとに最小の再現を Issue に起こす（エージェントが Maintain の段で拾う）。

## 3. 配車と運賃の関門

[ADR-0042](../decisions/0042-replay-and-shadow-gates-for-dispatch-and-pricing.md) による。

| 変更 | PR の関門 | 本番に出す前 | 展開 |
| --- | --- | --- | --- |
| 配車の計算 | 直近 7 日の再生、1 時間の縮小のシミュレーション | 影の実行 1 週間 | 区域の release フラグ：1 区域の 10% のバッチ → 100% → 他の区域 |
| 配車の設定（AppConfig） | 直近 7 日の再生の結果を変更の要求に添える。検証の関数で範囲 | 重みの大きな変更は影の実行 | AppConfig の段階的な配備（区域ごと） |
| 候補の条件のデータ | 決定表、PROP-DISP-002・007 | — | 版の承認（2 人）と有効の日時 |
| 運賃の計算のコード | 公示の例、`fare-replay`（直近 30 日、差 0） | 影の計算 3 日 | Pricing のカナリア |
| 運賃の規則のデータ | 型の検証、見本の乗車 100 件の試算 | — | 有効の日時。法務の確認待ちは legal のフラグ |
| Trips の遷移の表 | DT-TRIP、ベクター | — | サーバーを先に、アプリを後に |

### 3.1 再生とシミュレーション

- **再生**：`dispatch-replay --zone --from --to --algo <新しい版> --config <新しい設定>`。記録（`dispatch-decisions/`、位置は解像度 10）の入力を新旧に流し、組の違い、割り当ての数、迎車の ETA の合計と平均、貪欲法の率、計算の時間の p99、二重の使用（0 件）を出す（[dispatch-and-matching.md](dispatch-and-matching.md) の 9.2 節）。
- **縮小のシミュレーション**：仮の時計で 1 時間分。成立率、迎車の時間、空車の時間、辞退の率、二重の割り当て（0 件でなければ失敗）。
- CI は、記録を読むための専用の役割（`location` の鍵の復号だけを許す、書き込みなし）で S3 を読む。記録は丸めた値で、乗客の個人の情報を含まない（[ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md)）。

### 3.2 影の実行

- dispatch-shadow のタスクが、本番の区域の `DispatchBatchRecord` の入力（候補と ETA の後）を受け、新しい計算で解いて記録するだけ。提案しない。遅れたら捨てる。
- 基準（1 週間、変更の前と比べて）：二重の割り当て 0 件、成立率 −0.5 ポイントより悪くない、迎車の ETA の平均 +3% より悪くない、計算の時間の p99 300 ms 以内（ADR-0015）。
- 影の計算（運賃）：見積もりのたびに Pricing が新旧のコードで計算し、差を `fare_shadow_diffs` に記録する。乗客には旧の額だけを出す。

### 3.3 `fare-replay`

- 直近 30 日の `fare_quotes` の入力（規則の版、距離、時刻、割引、倍率、入力のハッシュ）を新しいコードで計算し直し、額と内訳が一致するかを見る（[ADR-0018](../decisions/0018-versioned-fare-rules-and-integer-yen.md)）。
- 差を許すのは、PR に一覧で書いた見積もりの種類だけ（例：新しい丸めの規則を使う規則の版）。一覧の外の差は失敗にする。
- すでに確定した見積もりと乗車の額は変えない。

## 4. デプロイ

### 4.1 順序

1 つのリリースに複数の部品の変更があるときは、次の順に出す。

```
マイグレーション（expand）─▶ 購読する側（Payments・索引・rt-router などの事象の読み手）
   ─▶ trips・pricing・supply ─▶ Go の熱い経路（loc-ingest → geo-index → dispatch → eta）─▶ rt-gateway
   ─▶ api ─▶ アプリ（列車。5 節）─▶ release フラグ
```

- 事象・契約の形を変えるときは、読み手を先に出す（新旧の形を読める）。サーバーを先に、アプリを後に。
- 位置の形（`LocationBatch`）と常時の接続の形は、サポートするアプリの版（8 つ前の列車まで）を読める間は古い形を残す。

### 4.2 方式

| サービス | 方式 | 理由 |
| --- | --- | --- |
| api、trips、pricing、payments、supply、console | ECS の blue/green（カナリア 10% → 100%）。CloudWatch アラームで自動の戻し | Slack と同じ |
| trips-workers、payments-workers、rt-router、push-sender | ローリング（`minimumHealthyPercent` 100%） | SQS と DB から処理を再開できる |
| loc-ingest、eta-service | ローリング（1 回に 1/3） | 無状態。端末は送り直す |
| geo-index、dispatch | **待機を先に**：待機のタスクを入れ替え、`READY`（索引）・未割り当ての依頼の読み込み（配車）を確かめる → 主がリースを自分から手放す → 新しい待機がリースを取る → 古い主を入れ替える | 主の役の引き継ぎを 1 回にし、期限切れ（約 6.5 秒）を待たない（[ADR-0011](../decisions/0011-geo-index-sharding-lease-and-rebuild.md)） |
| rt-gateway | ローリング（1 回に 10%）。`Goaway` で接続を散らして閉じる | 再接続の殺到を避ける（[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 10 節） |
| valhalla-eta、valhalla-match | タイルの版は青緑（[eta-and-routing.md](eta-and-routing.md) の 5.3 節）。コードだけの変更はローリング | 起動に時間がかかる |
| アプリ | 列車と段階的な公開（5 節） | — |

### 4.3 都市の波（S2 から）

- 配備と設定の変更は、都市のセル（[infrastructure.md](infrastructure.md) の 5 節）の単位で、小さな都市 → 中の都市 → 東京の順に出す。
- 共有のサービス（trips・api など）は都市で分けられないので、カナリアのタスクの割合で出し、都市ごとの SLO を見る。
- 各波の後 30 分、その都市の `dispatch_decision`・`offer_delivery`・成立率を見る（[observability.md](observability.md) の 6 節）。

### 4.4 時間帯と凍結

| 期間 | 扱い |
| --- | --- |
| 平日 10〜17 時 | ふつうのデプロイ |
| 金・土の 17 時〜翌 6 時、日本の祝日の前日の夜 | 修正だけ |
| 12/28〜1/3 | 凍結（修正だけ）。大晦日の前もっての拡大（[capacity.md](capacity.md) の 6 節）と重なる |
| 予定の大きな催し、雨の予報で前もって広げた時間帯 | 配車・運賃・Trips の変更を出さない |
| エラーバジェットを使い切った都市 | その都市の配車・運賃・Trips の変更を止める（修正だけ） |

### 4.5 マイグレーション

- Slack の ADR-0022 と同じ expand / contract。バックフィルは小分けに行う。
- Aurora `core` の `trips`・`driver_assignments`・`trip_timers` の大きな表の索引の追加は `CONCURRENTLY` で行い、遷移の書き込みを止めない。
- 運賃の規則のデータ（`fare_rule_sets`）はマイグレーションで書かない。承認の流れで入れる（ADR-0018）。
- DynamoDB の属性の追加は、コードの互換（知らない属性を無視する）で行う。

## 5. モバイルのアプリの列車と強制の更新

決定は [ADR-0006](../decisions/0006-native-apps-contracts-vectors-and-release-train.md)（[rider-and-driver-apps.md](rider-and-driver-apps.md) の 10 節）。この領域は、サーバーの側の約束を書く。

- **列車**：月曜に切り、木曜に審査、金曜から公開。4 つのアプリを同じ列車で出す。
- **段階的な公開**：iOS の段階的な公開は、1 日目 1%、2 日目 2%、3 日目 5%、4 日目 10%、5 日目 20%、6 日目 50%、7 日目 100%。止められる期間は合計 30 日まで。段階的な公開の最中も、App Store から手で更新する人には届く（[Release a version update in phases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/)、2026-09-27 に確認）。手で更新する人がいるので、段階の割合を「新しい版の利用者の上限」として当てにしない。新しい機能は release フラグで守る。
- Android は Play の段階的な公開（1% → 5% → 20% → 50% → 100%）。Play の段階的な公開の細部は **未検証**。
- **サーバーの互換**：サーバーは、最新から 8 つ前の列車の版までの契約（Protocol Buffers、状態機械のベクター、ヘッダー `<Brand>-Client`）を受け付ける。`buf breaking` はその範囲で検査する。
- **強制の更新**：`required_min` を上げるのは、セキュリティの欠陥、支払いと運賃の誤り、サーバーの互換を保てない変更のときだけ。Dev と Ops の 2 人の承認。乗車の最中と緊急の入口は塞がない（rider-and-driver-apps の 10.3 節）。サーバーは `required_min` より古い版の受諾と出庫を 426 で拒むが、乗車中の操作（journal）は拒まない。
- **ドライバーのアプリ**は、週末の夜に段階を進めない。
- **安全の区分**の変更（緊急の入口、乗車の共有）は、変更単位の `quality.md` に端末の試験の結果を付ける。フラグの取得を失敗させた状態でも入口が出ることを、列車ごとの UI の試験で確かめる（ADR-0043）。

## 6. リリースとフラグ

[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md) による。フラグの基盤は AppConfig。

### 6.1 フラグの種類

| 種類 | 名前 | 割り当て | 評価する場所 |
| --- | --- | --- | --- |
| release | `release.<area>.<feature>` | 都市・事業者・交通圏・利用者（`hash(flag + id)`） | 各サービス、アプリのブートストラップ |
| ops | `ops.<area>.<action>` | 全体・都市 | 各サービス |
| legal | `legal.<L番号>.<feature>` | 事業者 × 交通圏 | 各サービス。本番の値は `legal_gate_records` の範囲の中だけ |

主な ops のフラグ（runbook から使う）：

| フラグ | 効果 |
| --- | --- |
| `ops.dispatch.pause.<city>` | その都市の新しいオファーを止める（依頼は受けない。進行中の乗車は続く） |
| `ops.intake.reject.<city>` | その都市の新しい依頼を与信の前に断る（「混み合っています」） |
| `ops.dispatch.algo_pin.<zone>` | 区域の配車の計算を指定の版に固定する |
| `ops.upfront.suspend.<region>` | 事前確定運賃を止め、メーターの目安だけにする（日本版ライドシェアも止まる） |
| `ops.rideshare.pause.<city>` | 日本版ライドシェアの新しいオファーを止める |
| `ops.payments.in_vehicle_only` | アプリの決済の新しい与信を止め、タクシーは車内払いへ案内する |
| `ops.loc.interval_ms` | 位置の送信の間隔（2,000〜10,000）を変える |
| `ops.region.writable` | 書き込みを受けるリージョン（DR） |

### 6.2 日本版ライドシェアの経路

日本版ライドシェアのドライバーへのオファーは、次のすべてが真のときだけ出る。

1. `release.rideshare.dispatch`（機能の完成。都市 × 事業者）
2. `legal.l2.rideshare_dispatch` と `legal.l5.rideshare_drivers`（法務の結論の範囲）
3. 事業者の許可（`operator_authorizations` の `rideshare_permit`）と運行枠（[ADR-0027](../decisions/0027-rideshare-operating-windows.md)）
4. 候補の条件 E1・E5（[ADR-0014](../decisions/0014-dispatch-eligibility-and-street-hails.md)）
5. 事前確定運賃が出せる（`ops.upfront.suspend` が偽。[ADR-0017](../decisions/0017-fare-distance-for-pre-fixed-fares.md)）

- 同じく、変動運賃は `legal.l2.dynamic_fare`・`legal.l9.dynamic_fare`、代金の受け取りの形は `legal.l6.<model>` の裏に置く。
- 法務の結論の記録（`legal_gate_records`）は法務の担当だけが作る。AppConfig の検証の関数が、本番の legal のフラグの値を記録の範囲と照らす。

### 6.3 フラグの後始末

- 100% にした release フラグは、30 日後に消す PR を自動で起票する。
- legal のフラグは消さない（法務の結論が期間を持つため）。月に 1 回、本番で真の legal のフラグと記録の範囲を突き合わせる。

## 7. ロールバック

| 何を | どう戻す | 注意 |
| --- | --- | --- |
| release・legal のフラグ | AppConfig で切る | 進行中の乗車は、始まったときの条件で最後まで続ける |
| 配車の計算・設定 | `ops.dispatch.algo_pin.<zone>`、AppConfig の前の版 | デプロイを待たない |
| サーバー（api など） | 1 つ前のイメージの digest で再デプロイ | — |
| geo-index・dispatch | 待機を先に戻し、リースを渡す（4.2 節と同じ） | 2 つの版が同時に提案しても、Trips の epoch で守られる |
| 運賃のコード | 前のイメージ | 確定した見積もりの額は変えない |
| アプリ | 段階的な公開を止める。必要なら `required_min` を上げる | 公開した版は取り消せない。フラグで機能を切る |
| マイグレーション | 戻さない。前へ進める修正を書く | — |

手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。

## 8. 環境

| 環境 | 目的 | データ |
| --- | --- | --- |
| local | 開発、エージェントの確認ループ | seed、合成の軌跡、Kinesis の代わり（LocalStack）、Valhalla の小さな地域のタイル |
| dev | 結合の確認 | seed |
| staging | リリースの前の確認、負荷試験、市場のシミュレーション、DR の訓練 | seed と合成のデータ（`loc-loadgen`、`rider-loadgen`） |
| prod | 本番 | 本番。合成の区域（[observability.md](observability.md) の 9 節） |

- 本番の位置・乗車の記録を本番の外に出さない。再生とシミュレーションに使う記録は、丸めて匿名化したもの（`dispatch-decisions/` の解像度 10）だけで、実行は prod の中の専用の役割か、analytics のアカウントの HMAC の写しで行う。

## 9. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `ci-go-and-contracts` | 2.1 節の Go の検査、`buf breaking`、状態機械のベクター |
| E1 | `appconfig-flag-taxonomy` | 6.1 節の 3 種類、検証の関数 |
| E1 | `legal-gate-records` | `legal_gate_records` と画面、AppConfig の検証の関数での照合 |
| E1 | `deploy-pipelines` | 4.2 節の方式ごとのパイプライン、時間帯と凍結の検査 |
| E3 | `lease-aware-deploy` | geo-index・dispatch の待機を先にした入れ替え |
| E5 | `dispatch-replay-ci` | 3.1 節の再生と縮小のシミュレーションの CI |
| E5 | `dispatch-shadow-runner` | 3.2 節の影の実行 |
| E7 | `fare-replay-ci` | 3.3 節 |
| E7 | `pricing-shadow-diff` | 影の計算と `fare_shadow_diffs` |
| E1 | `mobile-release-train` | 5 節（rider-and-driver-apps の Story と同じ 1 つ） |
| E14 | `city-wave-rollout` | 4.3 節の都市の波（S2 の前） |

## 10. 未解決の問い

### 決定（2026-09-27、既定案）

- 配車の計算は再生・シミュレーション・影の実行 1 週間を経て、区域のフラグで出す。
- 運賃のコードは `fare-replay` の差 0 と影の計算 3 日。
- フラグは release・ops・legal。legal は法務の記録の範囲でだけ本番で有効。
- geo-index・dispatch は待機を先に入れ替える。
- 12/28〜1/3 は凍結。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 影の実行の 1 週間を、小さな変更（設定の小さな重み）で短くしてよいか | S1 の運用の後、Dev と QA |
| CI が本番の記録を読む権限の形（prod の中で走らせるか、analytics の写しか） | E5。セキュリティの担当と決める |
| Play の段階的な公開の細部 | E9 |
| 都市の波の順序（S2 の都市の大きさ） | S2 の前 |

## 11. quality.md・runbooks・data-model への項目

### quality.md

- 配車の変更ごとの再生・シミュレーション・影の実行の結果と基準（3 節）。
- `fare-replay` の差の件数（許した差の内訳）。
- デプロイの後 30 分の SLO の悪化で戻した回数。
- アプリの段階的な公開を止めた回数と理由。

### runbooks

- [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)（この領域で作った）。
- `dispatch-algorithm-rollout.md`（[dispatch-and-matching.md](dispatch-and-matching.md) の提案）：3.2 節の影の実行から区域のフラグで広げる手順。
- `legal-gate-enable.md`：法務の結論を記録し、legal のフラグを事業者 × 交通圏で有効にする手順。
- `mobile-release-halt.md`（[rider-and-driver-apps.md](rider-and-driver-apps.md) の提案）。

### data-model

| 置き場所 | 中身 |
| --- | --- |
| Aurora `core` `legal_gate_records`（`id`、`l_number`、`feature`、`operator_id`、`fare_area_id`、`summary`、`evidence_doc_id`、`approved_by`、`valid_from`、`valid_to`） | 6.2 節 |
| Aurora `core` `fare_shadow_diffs`（`quote_id`、`old_amount_yen`、`new_amount_yen`、`code_version`、`created_at`） | 3.2 節。30 日 |
| AppConfig `release.*`・`ops.*`・`legal.*` | 6.1 節 |
| S3 `ci/replay-results/<pr>/` | 3.1 節の結果（PR に添える） |

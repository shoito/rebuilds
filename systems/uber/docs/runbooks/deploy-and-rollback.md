# Runbook: デプロイとロールバック

- Owner: Ops
- 対応するアラート: blue/green の自動の戻し、デプロイの後 30 分の SLO の悪化（`dispatch_decision`・`trip_transition`・`offer_delivery`）、リースの持ち主がいない状態（配備の中）、新しいアプリの版のクラッシュの急増
- 最終確認日: 2026-09-27

流れは [delivery.md](../architecture/delivery.md)、配車と運賃の関門は [ADR-0042](../decisions/0042-replay-and-shadow-gates-for-dispatch-and-pricing.md)、フラグの種類は [ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)、アプリの列車は [ADR-0006](../decisions/0006-native-apps-contracts-vectors-and-release-train.md) にある。

## 症状

次のときに使う。

- 本番（prod）へサーバーをデプロイするとき、配車の計算・設定を区域に広げるとき、運賃の規則を有効にするとき、legal のフラグを有効にするとき、アプリの段階的な公開を進めるとき
- デプロイの後に、配車・遷移・配信の SLO、成立率、アプリのクラッシュが悪化したとき
- geo-index・dispatch の入れ替えで、リースの引き継ぎが進まないとき

## 影響

- 通常のデプロイ：geo-index・dispatch の入れ替えで、主の役の引き継ぎが 1 回ある（配車の検索は待機が答えるので止まらない）。rt-gateway の入れ替えで、接続が散らして切れ直す。乗車の記録は失われない。
- 失敗したデプロイ：配車の SLO（`dispatch_decision` 99.9%）を消費する。配車の計算・運賃の不具合は、エラーにならずに、組の悪化や額のずれとして現れる（再生・`fare-replay`・影の実行で見つける）。

## 確認

### デプロイの前

1. 対象のコミットが staging にデプロイ済みで、E2E、状態機械のベクター、決定表、性質ベーステスト、短い負荷（L1 を 10 分。[capacity.md](../architecture/capacity.md) の 7.2 節）が通っている。
2. デプロイできる時間帯である（[delivery.md](../architecture/delivery.md) の 4.4 節）。金・土の夜、12/28〜1/3、予定の催しと前もって広げた時間帯は、修正だけ。
3. 変更の分類を見る（PR の説明）。
   - マイグレーションが expand だけか。contract を含むなら、1 つ前のリリースで参照をやめていること。
   - **配車の計算・設定の変更**なら、再生・シミュレーションの結果が PR にあり、影の実行の基準（1 週間）を満たしている。
   - **運賃の計算の変更**なら、`fare-replay` の差 0（または許した差の一覧）と影の計算 3 日の結果がある。
   - **契約（Protocol Buffers）の変更**なら、`buf breaking` が通り、読み手が先に本番にある。
   - **legal のフラグ**を有効にするなら、`legal_gate_records` に範囲の記録がある。
4. その都市のエラーバジェットが残っている（[observability.md](../architecture/observability.md) の 6 節）。
5. 進行中のインシデント、二重の割り当ての検査の失敗、outbox の滞留、Aurora の大阪への複製の遅れがない。

### デプロイの後（入れ替えが終わってから 30 分）

| 見るもの | 正常 | 異常 |
| --- | --- | --- |
| `dispatch_decision` の悪い事象の率（都市ごと） | デプロイの前と同じ | 0.1% を超える |
| `disp_request_to_decision_seconds` の p95 | 3 秒以内 | 超える |
| `disp_proposal_rejected_total{reason="EPOCH_MISMATCH"}` | デプロイの前と同じ | 2 倍以上（索引の遅れ、2 つの配車のタスク） |
| `trip_transition` の悪い事象、409 の率 | 同じ | 2 倍以上 |
| `offer_delivery` の p95 | 1.5 秒以内 | 超える |
| `geo_apply_lag_seconds` の p99 | 1 秒以内 | 超える |
| 成立率（15 分の窓） | 同じ曜日・時間帯と同じ | 5 ポイント以上低い |
| 見積もりの失敗の率、`fare_shadow_diffs` の件数 | 同じ、0 | 増える |
| 二重の割り当て・二重の請求の検査 | 0 | 1 以上（直ちに SEV1。[incident-response.md](incident-response.md)） |
| 合成の配車の依頼（[observability.md](../architecture/observability.md) の 9 節） | 成功 | 2 回続けて失敗 |

## 対処

### サーバーのデプロイ

1. GitHub の `prod` の Environment で、Ops が承認する（作成者と別の人）。
2. マイグレーションのタスクの成功を確かめる。失敗したら、アプリのデプロイは自動で止まる。
3. [delivery.md](../architecture/delivery.md) の 4.1 節の順に進む：購読する側 → trips・pricing・supply → loc-ingest → geo-index → dispatch → eta → rt-gateway → api。
4. **geo-index・dispatch（待機を先に）**：
   1. 待機のタスクを新しいタスク定義で入れ替える。
   2. 新しい待機が `READY`（索引）・未割り当ての依頼の読み込み（配車）になったことを確かめる（`geo_rebuild_seconds`、ダッシュボードの「リース」）。
   3. 「リースを手放す」のワークフローで、主に自分から手放させる。新しい待機がリースを取り、`lease_epoch` が 1 増えたことを確かめる。
   4. 古い主のタスクを入れ替える。新しいタスクが待機になる。
   5. 途中で新しい待機が `READY` にならなければ、入れ替えを止める。古い主はリースを持ったまま動き続ける。
5. **rt-gateway**：ローリング（1 回に 10%）。`rt_connections` と再接続の率、`Hello` の流量の制限を見る。
6. **api・trips など**：blue/green のカナリア（10%）。アラームが鳴らなければ 100%。

### 配車の計算・設定を広げる

1. 影の実行の基準を満たしていることを、ダッシュボードの「影の実行」で確かめる。
2. 区域の release フラグで、1 区域の 10% のバッチに新しい計算を使う。30 分見る。
3. 悪化がなければ 100%、次に他の区域（S2 から都市の波）。
4. 設定の値（重みなど）の変更は、AppConfig の段階的な配備で区域ごとに入れる。検証の関数が範囲の外を拒む。

### 運賃の規則を有効にする

1. 規則の版が `approved`（2 人の承認）で、有効の日時が正しい（地域の時刻の 0 時）。
2. 見本の乗車 100 件の試算を、公示の例と突き合わせてある。
3. 法務の確認待ちの規則は、legal のフラグの範囲の記録がある。
4. 有効の日時の後 30 分、見積もりの失敗の率と、新しい版の見積もりの件数を見る。
5. 誤りがあれば、次の版で直す（承認の後の版は書き換えない）。直すまでは、`ops.upfront.suspend.<region>` でその区域の事前確定運賃を止めることを検討する。

### legal のフラグを有効にする

1. `legal_gate_records` に、L 番号・範囲（事業者 × 交通圏 × 機能）・法務の担当の承認がある。
2. PM の判断を記録する。
3. AppConfig の本番の構成を変える。検証の関数が範囲の外を拒んだら、記録の範囲を法務に確かめる（範囲を広げる操作を Ops が代わりにしない）。
4. 日本版ライドシェアは、運行枠と事業者の許可もそろっていることを、事業者の管理画面で確かめる（[delivery.md](../architecture/delivery.md) の 6.2 節）。

### アプリの段階的な公開を進める

1. 前の段で 24 時間以上、[rider-and-driver-apps.md](../architecture/rider-and-driver-apps.md) の 10.1 節の基準（クラッシュのない利用者 99.8% 以上、ANR、オファーの受信の確認、出庫の失敗）を満たしている。
2. ドライバーのアプリは、金・土の 18 時〜翌 6 時に進めない。
3. App Store Connect・Play Console で次の段に進める。手で更新する人には段に関わらず届くので、新しい機能は release フラグで守られていることを確かめる。

### 悪化したとき

1. **フラグで戻す。** 新しい機能の release フラグを切る。配車の計算は `ops.dispatch.algo_pin.<zone>` で前の版に固定する。設定は AppConfig の前の版に戻す。
2. **サーバーが原因なら**、1 つ前のイメージの digest で再デプロイする（「前のリリースを再デプロイ」のワークフロー）。geo-index・dispatch は、待機を先に戻す同じ手順で戻す。
3. **運賃のコードが原因なら**、前のイメージで戻す。すでに確定した見積もりの額は変えない。誤った額で確定した乗車は、運賃の訂正の手順で直す（`fare_adjustments`、2 人の承認）。
4. **アプリが原因なら**、段階的な公開を止める。安全の機能・支払いの誤りなら、`required_min` を上げる判断を Dev と Ops の 2 人で行う（乗車の最中と緊急の入口は塞がない）。
5. **マイグレーションは戻さない。** 前へ進める修正を書く。
6. **二重の割り当て・二重の請求が出たら**、戻す前に SEV1 を宣言する（[incident-response.md](incident-response.md)）。
7. 戻しても直らなければ、インシデントを宣言する。

### リースの引き継ぎが進まないとき

1. `geo_shard_leases` の項目（`owner_task`、`lease_epoch`、`expires_at_ms`）を見る。
2. 新しい待機が `READY` でないなら、Kinesis の読み直しの進み（遅れ）と、Aurora の reader の写しの読み込みを見る（[geospatial-index.md](../architecture/geospatial-index.md) の 5.4 節）。
3. 主が手放さないなら、主のタスクを止める。待機がリースの期限（5 秒）の後に取る。配車の検索は待機が答えるので止まらない。
4. どちらも `READY` にならず 60 秒を超えたら、[incident-response.md](incident-response.md) の「都市の配車の停止」に移る。

## エスカレーション

- 戻しても 15 分以内に配車の SLO が回復しない → インシデントを宣言する。
- 二重の割り当て・二重の請求 → SEV1。Dev のテックリードとお金の持ち主を呼ぶ。
- 運賃の誤りで確定した乗車がある → 運賃の持ち主と PM（乗客と事業者への連絡）を呼ぶ。
- マイグレーションが途中で止まり状態がわからない → Dev のテックリードを呼ぶ。
- legal のフラグの範囲に疑問がある → 法務の担当を呼ぶ。Ops が範囲を判断しない。

## 事後

- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- CI・再生・影の実行で防げた失敗なら、関門（再生の期間、影の実行の基準、`fare-replay` の範囲）を足す提案を Dev と QA に出す。
- この手順で足りなかったことを、ここに反映する。

# Supply and operators: Uber

供給の側の正本。タクシー事業者・営業所・車両・ドライバーの登録、書類の確認（第二種運転免許、日本版ライドシェアの要件）、出庫と入庫（ドライバーのセッション）、配車に出てよいかの判定、事業者の管理画面、日本版ライドシェアの運行枠（地域・曜日・時間帯・台数）を決める。

前提となる決定は、運送の主体はタクシー事業者で、この基盤は配車のアプリと決済の窓口に留まること、白タクを設計しないこと（[intent.md](../intent.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0026](../decisions/0026-supply-registry-and-document-verification.md) | 事業者・営業所・車両・ドライバーは、事業者が登録し、この基盤が書類を確かめる。配車に出てよいかは、書類・期限・停止・運行枠から求める判定を版つきで持ち、出庫と提案の両方で確かめる。事業者を通さないドライバーの登録の経路は作らない |
| [0027](../decisions/0027-rideshare-operating-windows.md) | 日本版ライドシェアの運行枠は、運輸局の通知をもとに事業者が登録し運用が承認するデータにする。同時に稼働する台数は、出庫のトランザクションで事業者 × 営業区域ごとに数えて上限を守る。雨天・酷暑・イベントの拡大は、根拠の記録つきで運行管理者が有効にする |

## 1. 目的と範囲

- 扱う：事業者の登録と契約の状態、営業所、車両、ドライバー、書類と期限、確認の流れ、ドライバーの状態、出庫・入庫のセッション、点呼の記録の受け取り、配車に出てよいかの判定と索引への配信、事業者の管理画面、日本版ライドシェアの運行枠と稼働の記録・報告。
- 扱わない：本人確認（顔の照合など）と、評価・通報による利用の停止（`safety-and-trust.md`）、位置の送信（[location-ingestion.md](location-ingestion.md)）、配車の候補の条件（[dispatch-and-matching.md](dispatch-and-matching.md) の 5 節）、振込先の口座と精算（[payments-and-payouts.md](payments-and-payouts.md)）、運賃の規則の登録（[pricing-and-fares.md](pricing-and-fares.md)）、運用の担当の権限と監査の共通部分（`support-and-operations-tools.md`）。
- **ドライバーは、必ずどれかの事業者に属する。** 事業者を通さずに個人が登録して客を運ぶ経路は作らない（白タクの禁止）。登録の API は事業者の管理画面の権限でしか呼べない。

## 2. 制度（2026-09-27 に確認した事実）

### 2.1 タクシー

- タクシーのドライバーは第二種運転免許を持つ（[東北運輸局「日本版ライドシェア（自家用車活用事業）について」](https://wwwtb.mlit.go.jp/tohoku/content/000338889.pdf) の比較表、2024-11-21。[intent.md](../intent.md) にも同じ記述がある）。
- タクシー事業者は、営業所のある単位地域（全国を分けた地域）の原簿に登録を受けた運転者（登録運転者）でなければ、タクシーに乗務させてはならない。登録は、その地域の事業者に雇われて選任された（か、その予定の）人の申請で国土交通大臣が行い、運転者証を交付する（[タクシー業務適正化特別措置法 第 3 条](https://laws.e-gov.go.jp/law/345AC0000000075)・第 5 条・第 14 条、e-Gov で 2026-09-27 に本文を確認）。以前は「指定地域」だけの制度だったが、現行の条文は単位地域ごとの原簿である。

### 2.2 日本版ライドシェア（自家用車活用事業）

[関東の運輸支局長の公示「自家用車活用事業の許可基準」](https://wwwtb.mlit.go.jp/kanto/content/000324077.pdf)（2024-03-29）から。

| 対象 | 要件 |
| --- | --- |
| 事業者 | 一般乗用旅客自動車運送事業（法第 4 条）の許可を持つ法人のタクシー事業者。許可の期間は 2 年 |
| 運行管理 | 事業用と自家用の合計が 5 両以上の営業所は、合計 40 両ごとに運行管理者を 1 名以上。点呼・指導監督・研修の体制。事故の報告の体制。ドライバーの他業での勤務時間を把握する |
| 整備管理 | 自家用車の整備管理の体制。5 両以上の営業所は常勤の整備管理者 |
| 保険 | 対人 8,000 万円以上・対物 200 万円以上の任意保険か共済 |
| ドライバー | 第一種運転免許（初心運転者期間を除く）か第二種運転免許。従事する日の前 2 年間に無事故で、免許の停止の処分を受けていない。事業者が研修と指導監督を行い、事業者の名称・氏名・免許の有効期限などを書いた運転者証明（電磁的記録でもよい）を発行して携行させる |
| 車両 | 乗車定員 10 人以下。事業に使う間、外から見やすく表示し、事業者の名称が分かるようにする。事業者は、契約のあるドライバーの自家用車を登録して管理する。登録の台数に制限はない |
| 使用できる台数 | 運輸局長などが通知する範囲。不足車両数の範囲内で、原則として営業所の事業用自動車の台数の範囲内 |
| 運送の形 | 事業者が運送責任を負う。引受けの時点で発着地が確定している。利用者の事前の承諾。運賃は事業者の事前確定運賃制度に準ずる。原則キャッシュレス。発地か着地が営業区域の中 |
| 記録 | 使用できる自家用車の稼働の状況を記録し、求めに応じて報告する |

### 2.3 曜日・時間帯と台数

[物流・自動車局旅客課の事務連絡「自家用車活用事業における曜日・時間帯及び不足車両数の設定等について」](https://wwwtb.mlit.go.jp/kanto/content/000369458.pdf)（2026-02-26）から。

- 配車アプリが普及した 12 の交通圏（札幌、仙台市、県南中央、千葉、特別区・武三、京浜、名古屋、京都市域、大阪市域、神戸市域、広島、福岡）は、運輸局が配車アプリのデータから不足する曜日・時間帯と不足車両数を公表し、希望する事業者に使用可能車両数を配分する。都道府県のタクシー協会の申し出でも配分する（公表の時と、原則半年ごと）。
- それ以外の交通圏は、協会・事業者・自治体・協議会の申し出で決める。事業者の申し出では、金曜・土曜の 16 時台から翌 5 時台、営業区域のタクシーの台数の 5% を既定とし、根拠を付ければ広げられる（台数は 10% が上限）。
- 配分の通知から 3 か月以内に合理的な理由なく許可を申請しないと、配分は無効になる。供給過剰のおそれがあれば、運輸支局が曜日・時間帯と台数を調整する。

### 2.4 運用の改善

[事務連絡「自家用車活用事業の運用改善等について」](https://wwwtb.mlit.go.jp/kanto/content/000379002.pdf)（2026-02-26）から。

- **雨天**：24 時間先までの降水量の予報が 1 時間 5 mm 以上の時間帯と、その前後 1 時間。5 mm 以上が 1 時間だけなら、前後 1〜2 時間で最大 4 時間まで。
- **酷暑**：水曜日の 10 時の時点で、翌木曜日から次の水曜日までの予報に最高気温 35℃ 以上の日が 1 日でもあれば、その 1 週間のすべての日の 11 時から 17 時台。
- 雨天・酷暑の台数：指定のない時間帯は、営業所に通知された使用可能車両数のうち最大のもの。指定のある時間帯と重なれば、使用可能車両数にそれを加える。対象は上の 12 の地域。予報は日本気象協会のサイトで確かめる。判断は運行管理者が行うほか、この規定に沿った機能を持つ配車アプリでもよい。
- **イベント**：主催者・自治体の要請書か、協会の実施計画書をもとに、運輸支局が認める時間帯と台数。
- **営業所の間の融通**：営業所ごとに配分された台数を、同じ事業者の営業所の間で融通できる。
- **稼働の報告**：交通圏、自家用車の使用車両数、実車回数、輸送人員。
- **費用**：燃料費、アプリの通信費、ドライブレコーダーやアルコールチェッカーの費用などは事業者が負担する。

## 3. データのモデル

```sql
operators (id, legal_name, corporate_number,           -- 法人番号
           taxi_business_permit_no,                   -- 一般乗用旅客自動車運送事業の許可
           invoice_registration_no,                   -- 適格請求書の登録番号
           status,                                    -- 'applying' | 'reviewing' | 'active' | 'suspended' | 'terminated'
           contract_version, contract_signed_at,
           collection_model,                          -- 'agent_collection' | 'operator_merchant'（ADR-0024）
           settlement_cycle,                          -- 'semi_monthly' | 'weekly' | 'monthly'
           created_at, updated_at)

operator_service_areas (operator_id, service_area_id, -- 営業区域（maps-and-geodata の service_areas、kind = eigyo_kuiki）
                        permit_evidence_doc_id, effective_from, effective_to)

operator_authorizations (id, operator_id, kind,       -- 'upfront_fare' | 'dynamic_upfront_fare' | 'dynamic_pickup_fee' | 'rideshare_permit'
                         service_area_id, authorization_no, valid_from, valid_to,
                         evidence_doc_id, status, approved_by)

offices (id, operator_id, name, address, service_area_id,
         operations_managers jsonb,                    -- 運行管理者の氏名と資格の番号
         taxi_vehicle_count,                           -- 事業用自動車の台数（使用可能車両数の上限の判定に使う）
         status)

vehicles (id, operator_id, office_id,
          service_kind,                                -- 'taxi'（事業用）| 'rideshare'（自家用）
          owner_driver_id,                             -- rideshare：車の持ち主のドライバー
          plate_no, vehicle_class, seats, make_model, color,
          meter_kind,                                  -- 'integrated' | 'certified_soft' | 'none'（ADR-0019）
          meter_device_id,
          status,                                      -- 'pending_review' | 'active' | 'suspended' | 'retired'
          created_at, updated_at)

drivers (id, operator_id, office_id, operator_driver_code,   -- 事業者の中の番号
         display_name, photo_doc_id, phone_e164_enc,
         service_kinds text[],                         -- 'taxi' | 'rideshare'
         status,                                       -- 3.2 節
         employment_kind,                              -- 'employee' | 'contractor' | 'unknown'（L5。この基盤は判断しない）
         created_at, updated_at)

driver_licenses (driver_id, license_class,             -- 'first' | 'second'
                 license_no_hash,                      -- 番号は HMAC で持つ（重複の登録の検知）
                 expires_on, novice_until,             -- 初心運転者期間の終わり
                 evidence_doc_id, verified_at, verified_by)

driver_attestations (id, driver_id, kind,              -- 'no_accident_2y' | 'no_suspension_2y' | 'training_done' | 'rideshare_certificate_issued'
                     attested_by_operator_user, attested_at, valid_until, evidence_doc_id)

documents (id, owner_type, owner_id, doc_type,         -- 3.3 節
           s3_key, sha256, uploaded_by, uploaded_at,
           status,                                     -- 'uploaded' | 'in_review' | 'accepted' | 'rejected' | 'expired'
           expires_on, reviewer_id, reviewed_at, reject_reason, retention_until)

insurance_policies (id, vehicle_id, insurer, policy_no_enc,
                    bodily_limit_yen, property_limit_yen,   -- rideshare は 8,000 万・200 万以上
                    valid_from, valid_to, evidence_doc_id, status)

operator_users (id, operator_id, email, role,          -- 5.1 節
                office_ids uuid[], mfa_enrolled, status)
```

- `service_area_id` は、[maps-and-geodata.md](maps-and-geodata.md) の 9 節の `service_areas.area_id` を指す。営業区域は `kind = eigyo_kuiki`、日本版ライドシェアの区域は `rideshare_zone`。多角形はこの領域で持たない。
- すべての表に `operator_id` を持ち、RLS で事業者ごとに分ける。この基盤の運用の担当は、理由の入力と監査ログつきで事業者をまたいで読める。
- 免許証の番号は平文で持たない。重複の登録（同じ人が 2 つの事業者に登録）を見つけるため、鍵つきのハッシュ（HMAC）だけを持つ。同じ人が 2 つの事業者に属することを禁じるかは持ち越し（13 節）。
- 書類の画像は S3 の専用のバケットに置き、KMS で暗号化し、確認の担当と事業者の管理者だけが署名つきの URL で見られる。

### 3.1 事業者の立ち上げ

1. 事業者が申し込み、法人の情報、事業の許可、営業区域、事前確定運賃・変動運賃・日本版ライドシェアの認可と許可を、写しとともに登録する。
2. この基盤の審査の担当が、写しと登録の値を突き合わせる（2 人の承認）。
3. 契約（代理受領権の付与を含む。[ADR-0024](../decisions/0024-fare-collection-model.md)）を結び、振込先の口座を登録する（[payments-and-payouts.md](payments-and-payouts.md) の 14 節）。`collection_model` が B なら、PSP の審査を通す。
4. 運賃の規則を割り当てる（[pricing-and-fares.md](pricing-and-fares.md) の `operator_fare_assignments`）。
5. `active` にする。認可・許可の期限（日本版ライドシェアは 2 年）の 60 日前と 30 日前に、事業者と審査の担当に知らせる。期限を過ぎた認可は、その種類の配車を止める。

### 3.2 ドライバーの状態

```
 draft ──書類の提出──▶ pending_review ──確認の完了──▶ active ◀──再開──┐
   ▲                        │ 差し戻し                  │              │
   └────────────────────────┘                          ├─停止─▶ suspended
                                                       ├─書類の期限切れ─▶ expired ─書類の更新と確認─▶ active
                                                       └─登録の解除─▶ offboarded（終端）
```

- 停止（`suspended`）は、事業者の操作か、この基盤の安全の担当の操作で入る。理由のコードと監査ログを必須にする。安全の担当の停止は、事業者が解除できない。
- 位置の偽装などの自動の検知は、ドライバーを自動では停止しない。候補から外すまでに留め、事業者と運用が確かめてから停止する（[location-ingestion.md](location-ingestion.md) の 13 節）。

### 3.3 書類の種類と要否（DT-SUP-001）

| 書類・記録 | タクシー | 日本版ライドシェア | 期限の扱い |
| --- | --- | --- | --- |
| 運転免許（第二種） | 必須 | 第一種か第二種のどちらか必須 | 有効期限で `expired` |
| 初心運転者期間でないこと | - | 必須（第一種のとき、`novice_until` < 今日） | 期間の終わりの日から有効 |
| 2 年間の無事故・無免停 | - | 事業者の証明（`driver_attestations`）が必須。根拠の書類（運転記録の証明など）を添付できる | 許可基準は「従事する日前 2 年間」の無事故・無免停を求め、確かめる頻度は定めない（[許可基準](https://wwwtb.mlit.go.jp/kanto/content/000324077.pdf) の (2)①、2026-09-27 に確認）。既定は 1 年ごとの更新と、事業者が事故・免停を知った時点の取り消し（**QA・PM の確認事項**） |
| 研修・指導監督の完了 | 事業者の証明（任意） | 事業者の証明が必須 | - |
| 運転者証明の発行 | - | 事業者の証明が必須（電磁的記録の写し） | 免許の期限に合わせる |
| タクシーの運転者の登録（登録運転者） | 必須（事業者が登録番号と運転者証を登録する） | - | 登録の抹消・運転者証の返納で `revoked` |
| 顔写真 | 必須 | 必須 | - |
| 車検証 | 必須 | 必須 | 有効期間の満了 |
| 自賠責保険 | 必須 | 必須 | 期間の満了 |
| 任意保険 | 事業者の保険（必須） | 対人 8,000 万円以上・対物 200 万円以上（必須） | 期間の満了 |
| 乗車定員 10 人以下 | - | 車検証の値で確かめる | - |
| 車両の表示（ステッカー） | - | 事業者の証明が必須 | - |

- 書類の確認は、この基盤の審査の担当が行う（画像と登録の値の突き合わせ）。書類の値の読み取り（OCR）は補助に使ってよいが、確定は人が行う。
- 免許証の真正の確かめ方（IC の読み取りなど）は、本人確認と合わせて `safety-and-trust.md` で決める。
- 期限切れの 30 日前と 7 日前にドライバーと事業者に知らせる。期限の日の 0 時（Asia/Tokyo）に、判定（4 節）から外す。これはタイマーではなく、日次のジョブと、出庫の時の検査の両方で行う。

## 4. 配車に出てよいかの判定

### 4.1 判定（DT-SUP-002：出庫の可否）

上から評価し、最初に一致した行。

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | 事業者が `active` でない | 拒否 `operator_inactive` |
| 2 | ドライバーが `active` でない | 拒否 `driver_inactive` |
| 3 | 車両が `active` でない、または車両がドライバーの事業者のものでない | 拒否 `vehicle_invalid` |
| 4 | 選んだサービスの種類が、ドライバーの `service_kinds` か車両の `service_kind` と合わない | 拒否 `service_mismatch` |
| 5 | DT-SUP-001 の必須の書類・記録のどれかが `accepted` でない、または期限切れ | 拒否 `document_missing:{doc_type}` |
| 6 | rideshare で、事業者の日本版ライドシェアの許可が有効でない | 拒否 `rideshare_permit_invalid` |
| 7 | rideshare で、今の時刻に営業区域の運行枠が開いていない | 拒否 `rideshare_window_closed` |
| 8 | rideshare で、事業者 × 営業区域の稼働の台数が上限に達している | 拒否 `rideshare_capacity_full` |
| 9 | rideshare で、今日の点呼の記録がない | 拒否 `roll_call_missing` |
| 10 | 同じドライバーの有効なセッションがある | 既存のセッションを返す（別の端末なら古い方を終える） |
| 11 | それ以外 | 許可。セッションを作る |

- タクシーの点呼の記録は、事業者の設定で必須にできる（既定は任意）。事業者は自社の点呼の仕組みを持つことが多いため。
- 判定の結果は `eligibility_ver` とともにセッションに持ち、索引へ配る（4.3 節）。

### 4.2 ドライバーのセッション（出庫と入庫）

```sql
driver_sessions (id uuid PRIMARY KEY, driver_id, vehicle_id, operator_id, office_id,
                 service_kind,                        -- 'taxi' | 'rideshare'
                 service_area_id,                      -- 出庫の地点の営業区域
                 status,                              -- 'online' | 'ended'
                 started_at, ended_at, end_reason,    -- 'driver' | 'window_closed' | 'capacity_reduced' | 'suspended' | 'timeout' | 'device_replaced'
                 eligibility_ver bigint,
                 roll_call_record_id,
                 anchor_server_time, anchor_elapsed_ms,   -- 位置の取り込みの時刻の基準点（location-ingestion の 4.3 節）
                 location_untrusted boolean DEFAULT false, -- 同上の 13 節
                 paused_by_system_at,                  -- オファーの時間切れが 2 回続いた自動の休憩（dispatch-and-matching の 8.3 節）
                 app_version, device_id_hash)
CREATE UNIQUE INDEX one_online_session_per_driver ON driver_sessions (driver_id) WHERE status = 'online';
CREATE UNIQUE INDEX one_online_session_per_vehicle ON driver_sessions (vehicle_id) WHERE status = 'online';

roll_call_records (id, operator_id, driver_id, office_id, kind,  -- 'pre_duty' | 'post_duty'
                   performed_by, performed_at, method,            -- 'in_person' | 'remote' | 'external_system'
                   alcohol_check_result, external_ref)
```

- 1 人のドライバー、1 台の車両に、同時に 1 つのオンラインのセッション。
- **自動の休憩**：Trips がオファーの時間切れが 2 回続いたことを知らせたら（[trips-lifecycle.md](trips-lifecycle.md) の 3.3 節の行 10）、`paused_by_system_at` を入れ、判定を「出てはいけない」にする（`eligibility_ver` を増やす）。ドライバーがアプリで空車に戻すと解除する。セッションは終えない。
- 位置が 10 分届かないセッションは、`timeout` で終える（索引の項目の削除と合わせる。[geospatial-index.md](geospatial-index.md) の 4.3 節）。有効な割り当てがある間は終えない。
- 点呼は事業者の責任で、この基盤は記録を受け取るだけにする。受け取り方は、管理画面での入力か、事業者の点呼の仕組みからの API。

### 4.3 判定の版と配信

- ドライバー・車両・書類・停止・許可・運行枠・稼働の台数のどれかが変わったら、影響するオンラインのセッションの判定をやり直し、`eligibility_ver` を 1 増やす。
- 変化は outbox で `supply.session_changed`（`driver_id`、`session_id`、`eligibility_ver`、オンラインか、サービスの種類、車両の種類、席の数、事業者・営業所、`location_untrusted`、配車に出てよいか）として配る。索引は `eligibility_ver` の大きい事象だけを適用する（[geospatial-index.md](geospatial-index.md) の 4.2 節）。
- 判定が「出てはいけない」に変わっても、有効な割り当ての乗車は最後まで続ける。新しいオファーだけを止める。Trips の提案の検査（[trips-lifecycle.md](trips-lifecycle.md) の 4.3 節）も同じ表を読む。

## 5. 事業者の管理画面

### 5.1 役割

| 役割 | できること |
| --- | --- |
| `operator_owner` | すべて。役割の付与、契約・振込先の変更の申請 |
| `operator_admin` | 営業所・車両・ドライバーの登録と停止、書類の提出、運賃の割り当ての確認、変動の時間帯の表の下書き |
| `office_manager`（運行管理者） | 担当の営業所のドライバーの状態、点呼の記録、日本版ライドシェアの雨天・酷暑の拡大の有効化、稼働の確認 |
| `finance` | 明細・請求書・振込・運賃の水準の報告の閲覧と取り出し |
| `viewer` | 閲覧だけ |

- ログインは多要素の認証を必須にする。認証の方式は `security.md` で決める。
- 事業者の利用者の操作はすべて監査ログに残し、事業者の `operator_owner` が自社の分を見られる。

### 5.2 画面と機能

| 機能 | 中身 |
| --- | --- |
| 登録 | 営業所、車両、ドライバーの登録、書類の提出と差し戻しの対応、期限の一覧 |
| ドライバーの管理 | 状態、停止と再開、出庫の履歴と稼働の時間（他業との勤務時間の把握の材料）、取り消しの回数、評価の要約（`safety-and-trust.md`） |
| 稼働の地図 | 自社のオンラインの車の位置と状態。位置は運行管理の目的に限り、アクセスを監査ログに残す。NFR-009 の例外なので `legal.l4.operator_fleet_map` の裏に置き、`legal_gate_records` に記録のある事業者でだけ出す（[ADR-0043](../decisions/0043-flag-taxonomy-legal-gates-and-safety-defaults.md)）。記録の前は、台数と状態の一覧（位置なし）と、解像度 7 のセルごとの台数だけを出す |
| 乗車の履歴 | 自社の乗車の一覧、状態、運賃、訂正。乗客の情報の見せ方は 9 節 |
| 精算 | 締めごとの明細、手数料の適格請求書、振込の状態（[payments-and-payouts.md](payments-and-payouts.md) の 11 節） |
| 運賃 | 割り当てられた運賃の規則の閲覧、変動運賃・変動迎車料金の時間帯の表の下書き、運賃の水準の報告の取り出し（[pricing-and-fares.md](pricing-and-fares.md) の 6.3 節） |
| 日本版ライドシェア | 運行枠の登録、雨天・酷暑・イベントの拡大、稼働の台数の今の値、稼働の報告の取り出し（6 節） |
| 利用者 | 自社の管理画面の利用者と役割 |

- 管理画面は Web（TypeScript）で、事業者の API（`api.<domain>/operator/v1/...`）だけを使う（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- 大手の事業者の自社の配車・点呼・勤怠の仕組みとつなぐ API（書類の登録、点呼の記録、明細の取り出し）も、同じ API として出す。

## 6. 日本版ライドシェアの運行枠（[ADR-0027](../decisions/0027-rideshare-operating-windows.md)）

### 6.1 データ

```sql
rideshare_allotments (id, operator_id, office_id, service_area_id,
                      source,               -- 'bureau_published'（運輸局の公表）| 'association' | 'operator_request' | 'municipality' | 'council'
                      notice_ref, notice_date, evidence_doc_id,
                      valid_from, valid_to, -- 許可の期間の中
                      weekly_slots jsonb,   -- [{ weekday: 5, from: "16:00", to: "29:59", vehicles: 10 }, ...]（29:59 は翌 5:59）
                      status,               -- 'draft' | 'approved' | 'active' | 'expired' | 'void'
                      approved_by_1, approved_by_2, created_at)

rideshare_extensions (id, operator_id, service_area_id,
                      kind,                 -- 'rain' | 'heat' | 'event' | 'disaster'
                      window_from, window_to,
                      vehicles_rule,        -- 'max_allotted' | 'fixed'
                      fixed_vehicles,       -- event・disaster
                      evidence jsonb,       -- 予報の値・確かめた時刻・ページ、要請書の写しの ID
                      activated_by, activated_at, revoked_at, status)

rideshare_capacity (operator_id, service_area_id, PRIMARY KEY (operator_id, service_area_id),
                    updated_at)             -- 出庫のトランザクションでロックする行
```

- 運行枠は、運輸局の通知（配分の通知、許可）を事業者が写しとともに登録し、この基盤の審査の担当が 2 人で承認する。承認の後は書き換えず、変えるときは新しい行で置き換える。
- 時刻は地域の時刻（Asia/Tokyo）で評価する。日をまたぐ枠は 24 時より後の時刻（29:59 など）で書く。
- 配分は営業所ごとに通知されるが、同じ事業者の営業所の間で融通できる（2.4 節）。そこで、**上限は事業者 × 営業区域で合計する**。

### 6.2 今の上限の求め方

時刻 `t` の事業者 × 営業区域の上限 `L(t)` は次のとおり。

```
base(t)  = Σ（営業所ごとの、t を含む有効な weekly_slots の vehicles）
maxAllot = max（営業所ごとの、有効な運行枠のどの枠の vehicles）の合計   -- 雨天・酷暑の「最大のもの」
wx(t)    = t を含む有効な rain・heat の拡大があれば maxAllot、なければ 0
ev(t)    = t を含む有効な event・disaster の拡大の fixed_vehicles の合計
L(t)     = base(t) + wx(t) + ev(t)
```

- 雨天・酷暑の「営業所に通知された使用可能車両数のうち最大のもの」を、営業所ごとの最大の合計と読む。この読み方は法務の確認待ち（L2。運輸局への確認を含む）。
- `L(t)` の計算は純粋な関数にし、時刻と有効な行を引数に取る。

### 6.3 出庫の時の数え方

1. `rideshare_capacity` の行（事業者 × 営業区域）を `FOR UPDATE` で取る。
2. `L(now)` を求める。
3. その事業者 × 営業区域のオンラインの rideshare のセッションの数 `n` を数える。
4. `n < L(now)` なら、セッションを作ってコミットする。そうでなければ `rideshare_capacity_full` で拒否する。

- 行のロックで、同時の出庫が上限を超えることを防ぐ。S1 の規模（事業者 × 営業区域あたり数十〜数百台）では、この行に書き込みが集中しても足りる。
- 出庫の拒否の回数を事業者に見せる（上限の見直しの材料）。

### 6.4 枠の終わりと上限の減少

- 枠の終わりの 15 分前に、オンラインの rideshare のドライバーに知らせる。
- 枠の終わりで、判定を「出てはいけない」にし（`eligibility_ver` を増やす）、新しいオファーを止める。乗車中の割り当ては最後まで続け、終わったらセッションを `window_closed` で終える。
- 枠の中で上限が下がったら（拡大の終わりなど）、超えた分のセッションを、出庫の遅い順に選び、新しいオファーを止めて、乗車の後に `capacity_reduced` で終える。
- 判定と上限の変化は、1 分ごとのジョブと、枠の境の時刻に入れたタイマー（`supply_timers`、`trip_timers` と同じ形）で行う。

### 6.5 雨天・酷暑・イベントの拡大（DT-SUP-003）

| # | 種類 | 条件 | 有効にする人 | 時間帯 |
| --- | --- | --- | --- | --- |
| 1 | `rain` | 12 地域の営業区域。24 時間先までの予報で 1 時間 5 mm 以上の時間がある | 運行管理者（`office_manager`） | その時間と前後 1 時間。5 mm 以上が 1 時間だけなら最大 4 時間まで |
| 2 | `heat` | 12 地域。水曜日の 10 時の時点で、木曜日から次の水曜日の予報に最高 35℃ 以上の日がある | 運行管理者 | その 1 週間の毎日 11:00〜17:59 |
| 3 | `event` | 運輸支局が認めた要請書か実施計画書がある | 事業者の管理者が登録し、審査の担当が承認 | 認められた時間帯 |
| 4 | `disaster` | 運輸局が活用を認めた通知がある | 同上 | 運輸局が定めた期間 |
| 5 | それ以外 | - | - | 拡大しない |

- 雨天・酷暑は、S1 では運行管理者が管理画面で有効にし、確かめた予報の値・時刻・ページを `evidence` に入れる。この基盤は、入力された値が条件を満たすか（5 mm 以上、35℃ 以上、時間帯の計算）だけを確かめる。
- 予報のデータを自動で取り込んで有効にする機能は、予報のデータの提供の条件（事務連絡が指定する日本気象協会のサイトの利用条件）を確かめてから作る（持ち越し）。
- 対象の 12 地域でない営業区域では、`rain`・`heat` を登録できない。

### 6.6 稼働の記録と報告

- 月ごと・交通圏ごとに、使用車両数（日ごと・時間帯ごとのオンラインの rideshare の台数の最大）、実車回数（完了した乗車の数）、輸送人員（`END_TRIP` の `passenger_count` の合計。[trips-lifecycle.md](trips-lifecycle.md) の 8.3 節）を集計し、管理画面から取り出せるようにする。
- 許可の条件の「稼働の状況の記録」の元のデータ（セッション、乗車）は、許可の期間と、その後の保存の期間まで残す。既定は [security.md](security.md) の 7.2 節の乗車の記録と同じ（法務の確認待ち（L4））。

## 7. 事業者に出す報告

| 報告 | 周期 | 元 |
| --- | --- | --- |
| 精算の明細・手数料の請求書 | 締めごと | [payments-and-payouts.md](payments-and-payouts.md) の 11 節 |
| 運賃の水準（変動運賃の A〜D） | 週次・3 か月 | [pricing-and-fares.md](pricing-and-fares.md) の 6.3 節 |
| 日本版ライドシェアの稼働 | 月次・求めに応じて | 6.6 節 |
| ドライバーの稼働の時間 | 日次 | セッション |
| 書類の期限 | 常時 | 3.3 節 |

## 8. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Aurora の writer のフェイルオーバー | 出庫と登録が数十秒失敗する。アプリは再試行する。オンラインのセッションは続く |
| 判定の配信が遅れる | 索引は古い判定で候補を出しうるが、Trips の提案の検査が同じ表を読むので、出てはいけないドライバーへのオファーは作られない |
| 1 分ごとのジョブが止まる | 枠の終わりの処理が遅れる。枠の境のタイマーと、Trips の提案の検査（枠が開いているか）で止まる。ジョブの遅れを監視する |
| 書類の画像のストアが読めない | 確認の作業だけが止まる。配車には影響しない |
| 事業者の点呼の仕組みからの連携が止まる | 管理画面での入力に切り替える。rideshare の出庫が `roll_call_missing` で止まることを事業者に知らせる |

## 9. セキュリティとプライバシー

- 事業者の間は RLS で分ける。事業者は他の事業者のドライバー・車両・乗車・報告を見られない（L9 の観点でも、事業者どうしで運賃や稼働の情報を共有する経路を作らない）。
- 免許証などの書類の画像は、個人情報として最小の人だけが見られる。見るたびに監査ログを残す。保存の期間は、登録の解除から法務の結論の期間まで（既定 3 年。法務の確認待ち（L4）。[security.md](security.md) の 7.2 節）。
- 免許証の番号は HMAC だけを持ち、平文を DB に置かない。
- 事業者が見る乗車の情報：乗車の間は、運行管理のために乗車地・降車地を見られる。乗車の後の履歴は、H3 の解像度 9 に丸めた位置と、乗客の表示名だけにする。事故・苦情の対応で正確な位置が要るときは、理由の入力と監査ログつきで見る。事業者とこの基盤の間の個人情報の関係（委託・共同利用・第三者提供）は法務の確認待ち（L4）。
- ドライバーの停止・再開、書類の承認、運行枠の承認、拡大の有効化は、理由と監査ログを必須にする。
- 事業者の管理画面の API は、事業者の利用者のトークンでだけ呼べる。ドライバーのアプリのトークンでは呼べない（ドライバーが自分を登録する経路を作らない）。

## 10. テスト

### 10.1 決定表

- DT-SUP-001（書類の要否）、DT-SUP-002（出庫の可否）、DT-SUP-003（拡大）を表駆動テストにする。
- 6.2 節の `L(t)` を、公表の例（金曜・土曜の 16 時台から翌 5 時台、雨天の前後 1 時間、酷暑の 11〜17 時台）で表にする。

### 10.2 性質ベーステスト（fast-check、DB は Testcontainers の PostgreSQL）

- **PROP-SUP-001（台数の上限）**：任意の並行の出庫・入庫・枠の変更・拡大の有効化と取り消しの列で、どの時点でも、事業者 × 営業区域のオンラインの rideshare のセッションのうち、新しいオファーを受けられるものの数は `L(t)` 以下。
- **PROP-SUP-002（期限切れ）**：任意の書類の期限と時刻の列で、必須の書類が期限切れのドライバーは、期限の日の 0 時以降に新しいオファーを受けない（出庫の検査と Trips の提案の検査の両方で）。
- **PROP-SUP-003（事業者の分離）**：任意の事業者の利用者のトークンで、他の事業者の行は読めず、書けない。
- **PROP-SUP-004（判定の収束）**：任意の順序・重複の `supply.session_changed` を索引の規則で適用した結果は、DB の最後の判定と一致する。
- **PROP-SUP-005（白タクの経路がない）**：任意の API の呼び出しの列で、`operator_id` を持たないドライバー、または事業者の審査が済まない事業者のドライバーのセッションは作られない。

### 10.3 結合

- 模擬の事業者の点呼の仕組みからの記録の取り込み。
- 枠の境の時刻をまたぐ乗車で、乗車は続き、次のオファーが来ないこと。

## 11. ADR

| ADR | 決定 |
| --- | --- |
| [0026](../decisions/0026-supply-registry-and-document-verification.md) | 事業者・営業所・車両・ドライバーの登録と書類の確認、配車に出てよいかの版つきの判定 |
| [0027](../decisions/0027-rideshare-operating-windows.md) | 日本版ライドシェアの運行枠のデータ、出庫での台数の上限、雨天・酷暑・イベントの拡大 |

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `operator-onboarding` | 3.1 節、許可・認可の登録と 2 人の承認、期限の通知 |
| E2 | `offices-vehicles-drivers` | 3 節の表、RLS、ドライバーの状態（3.2 節） |
| E2 | `document-review` | 書類の提出・確認・差し戻し・期限（DT-SUP-001、PROP-SUP-002） |
| E2 | `driver-sessions-and-eligibility` | 4 節、出庫の可否（DT-SUP-002）、`supply.session_changed` の配信（PROP-SUP-004）。E3 の索引と一緒に |
| E2 | `roll-call-records` | 点呼の記録の入力と API |
| E2 | `operator-console-core` | 5 節の役割、多要素の認証、監査ログ、登録の画面 |
| E2 | `operator-console-trips-and-map` | 乗車の履歴と稼働の地図（9 節の見せ方） |
| E2 | `no-independent-driver-path` | PROP-SUP-005 と、ドライバーのアプリのトークンで登録の API を呼べないこと |
| E12 | `rideshare-requirements` | DT-SUP-001 の rideshare の列、保険の下限、定員、運転者証明 |
| E12 | `rideshare-allotments` | 6.1・6.2 節、運行枠の登録と承認 |
| E12 | `rideshare-capacity-enforcement` | 6.3・6.4 節（PROP-SUP-001） |
| E12 | `rideshare-weather-and-event-extensions` | 6.5 節（DT-SUP-003） |
| E12 | `rideshare-activity-reports` | 6.6 節 |
| E11 | `driver-suspension-by-safety` | 安全の担当による停止と、事業者が解除できないこと |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- **登録の主体**：事業者だけ。ドライバーが自分で登録する経路は作らない。
- **2 年の無事故・無免停**：事業者の証明を必須にし、この基盤は根拠の書類を任意で受ける。証明の更新は 1 年ごと。
- **台数の上限の単位**：事業者 × 営業区域で合計する（営業所の間の融通のため）。
- **雨天・酷暑の拡大**：S1 は運行管理者が根拠つきで手で有効にする。
- **点呼**：rideshare は記録を必須、タクシーは事業者の設定で必須にできる（既定は任意）。
- **事業者が見る乗車の履歴**：乗車の後は丸めた位置と表示名だけ。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| ドライバーの労働の位置づけと、この基盤とドライバーの間に契約を作らないことで足りるか（L5） | E2 のドライバーの登録と E12 の前に法務が結論を出す |
| 同じ人が 2 つの事業者に同時に属することを許すか | L5 と、事業者の運行管理の責任の整理を見て E2 で決める |
| 登録運転者の確かめ方（運転者証の写しで足りるか、原簿の照会の手段があるか） | E2 の `document-review` の前に事業者と確かめる（登録の要否は 2.1 節で確認済み） |
| 無事故・無免停の確かめ方（運転記録の証明を必須にするか）と、更新の頻度 | E12 で運輸局に確かめる |
| 雨天・酷暑の「最大のもの」の読み方（L2） | E12 の前に運輸局に確かめる |
| 予報のデータの自動の取り込み | 予報の提供の条件を確かめて S2 で |
| 書類と稼働の記録の保存の期間（L4） | 法務 |
| 事業者との個人情報の関係（委託・共同利用・第三者提供）（L4） | 法務。E2 の管理画面の乗車の履歴の Story の前 |
| 本人確認（顔の照合、免許証の IC の読み取り） | `safety-and-trust.md` の ADR で |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 出庫の拒否の割合と理由の内訳（書類、枠、台数、点呼）。
- 書類の確認の待ちの時間の p50・p95 と、差し戻しの割合。
- 期限切れで判定から外れたドライバーの数（事前の通知が効いているか）。
- rideshare の台数の上限を超えた時間（常に 0。PROP-SUP-001 の本番の検査として 1 分ごとに数える）。
- 判定の変化から索引への反映までの時間。

### runbooks

- `document-review-backlog.md`：確認の待ちが溜まったときの増員と、優先の付け方（期限の近いもの）。
- `rideshare-window-change.md`：運輸局の新しい通知（配分、調整）を登録し、承認し、切り替える手順。
- `rideshare-capacity-anomaly.md`：上限の超過や、出庫の拒否の急増のときの確かめ方。
- `operator-suspension.md`：事業者の許可の取り消し・停止の知らせを受けたときの、事業者の停止と進行中の乗車の扱い。
- `driver-safety-hold.md`：安全の担当によるドライバーの停止の手順（[safety-and-trust.md](safety-and-trust.md) の runbook と同じ 1 つにした）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `operators`、`operator_service_areas`、`operator_authorizations`、`offices`、`vehicles`、`drivers`、`driver_licenses`、`driver_attestations`、`documents`、`insurance_policies`、`operator_users` | 3 節。すべて `operator_id` と RLS |
| Aurora `driver_sessions`、`roll_call_records` | 4.2 節。`driver_sessions` の `anchor_server_time`・`anchor_elapsed_ms`・`location_untrusted` は [location-ingestion.md](location-ingestion.md) の提案を取り込んだ |
| Aurora `rideshare_allotments`、`rideshare_extensions`、`rideshare_capacity`、`supply_timers` | 6 節 |
| S3 `supply-documents/`（KMS、専用のバケット） | 書類の画像 |
| outbox の事象 `supply.session_changed` | 4.3 節（索引が読む `eligibility_ver`） |

# Taxes: Airbnb

税。宿泊税（自治体ごとの段階・定率・定額と免除）、入湯税、消費税の扱い、税の表の形とバージョン、税の区域、課税の標準（素泊まりの料金に何を含めるか）、泊ごと・人ごとの計算と端数、明細、税の表の変更と既存の予約、預かりと納付の型（法務の L4）を決める。

前提となる決定は次のとおり。

- 税は `quoteStay` の段の 1 つで、`packages/tax` の関数が計算する。見積もりは税の表のバージョンを固定する（[pricing-and-fees.md](pricing-and-fees.md) の 6 節、[ADR-0030](../decisions/0030-quote-stay-pipeline-and-rounding.md)）
- 税の表はバージョンの付いた設定にする。フラグにしない。コードに自治体の名前を書かない（[AGENTS.md](../../AGENTS.md)）
- 本システムが税を預かり納めるかは法務の L4 の後。既定は「ホストが納める。本システムは額を出して明細に書く」（[architecture/README.md](README.md) の 6 節）。台帳の `tax_payable:<jurisdiction>:<tax>` は L4 の後に使う（[ADR-0005](../decisions/0005-payments-hold-capture-and-ledger.md)）
- 物件の自治体のコードと税の区域は、ピンの確定の時に正確な位置から求めて core に書く（[location-and-geo.md](location-and-geo.md) の 4.4 節）

この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0032](../decisions/0032-tax-rule-tables-by-jurisdiction.md) | 税は `tax_rules` の行（管轄、税の種類、適用の開始と終わり（泊の日）、施設の種類、計算の型、段階・率、課税の標準の定義、免除、端数、同時に集める他の管轄）で持ち、表全体にバージョンを付ける。計算の型は `bracket_per_person_night`・`percent_per_person_night`・`flat_per_person_night` の 3 つ。値は公式の資料から運用と法務が入れ、資料の URL と確認日を行に持つ |
| [0033](../decisions/0033-stay-tax-computation.md) | 宿泊税・入湯税は泊ごと・人ごとに計算する。泊の課税の標準は、その夜の料金（長期の割引を夜に按分した後）と追加のゲストの料金に、表が含めると定めた滞在の料金（清掃料など）を夜に等しく按分して足し、課税の人数で割る。どの表を使うかは泊の日で決める。見積もりの後に税の表が変わっても、見積もりの額で請求する |
| [0034](../decisions/0034-tax-collection-model.md) | 預かりと納付の型は `legal.lodging_tax_collector`（`host`・`platform`）で持ち、本番の値は法務の L4 の後。`host` では税を総額に含めて受け、release でホストへの支払いに含め、管轄・月ごとの明細をホストに出す。`platform` では `tax_payable:<jurisdiction>:<tax>` に振り替える。キャンセルの税の返し方は ADR-0039 の DT-CXL-001 に従う |

## 1. 範囲

- 扱う：税の種類（宿泊税、入湯税、消費税）、税の表の形とバージョン、管轄と税の区域、施設の種類による当てはめ、課税の標準、泊ごと・人ごとの計算、免除、端数、明細の行、検索の目安への使い方、税の表の変更と既存の予約、預かりと納付の型の枠組み、ホストへの明細、キャンセルの税の扱いの既定。
- 扱わない：
  - 料金の規則とサービス料（[pricing-and-fees.md](pricing-and-fees.md)）。
  - 台帳の仕訳の形と送金（ledger-and-payouts の領域）。この文書は `tax_payable` を使う条件を書く。
  - キャンセルの返金の決定表（cancellations-and-changes の領域）。この文書は税の行の扱いの既定を渡す。
  - 本システムのサービス料の適格請求書の発行（ledger-and-payouts の領域「手数料の請求書」）。この文書は消費税の額の出し方を書く。
  - 日本の外の税（S2 以降）。

## 2. 制度の形（確かめたこと）

いずれも 2026-10-10 に確認。法令の解釈は書かない。本システムへの当てはめ（特別徴収義務者が誰か、仲介の事業者の義務、標準に清掃料を含むか）は**法務の確認待ち（L4）**。表の値は、公式の資料から写した初めの値で、本番の表は運用と法務が確かめてから入れる。

| 管轄 | 税 | 内容 | 出典 |
| --- | --- | --- | --- |
| 東京都（2027-03-31 の泊まで） | 宿泊税 | 1 人 1 泊の宿泊料金が 1 万円以上 1 万 5 千円未満 100 円、1 万 5 千円以上 200 円。1 万円未満は課税しない。対象は旅館・ホテル（簡易宿所・民泊は含まない）。宿泊料金は食事料金などを含まない素泊まりの料金 | [東京都主税局 宿泊税の見直し](https://www.tax.metro.tokyo.lg.jp/kazei/leisure/shuk/shuk_minaoshi)、[宿泊税](https://www.tax.metro.tokyo.lg.jp/kazei/leisure/shuk/2) |
| 東京都（2027-04-01 の泊から） | 宿泊税 | 宿泊料金の 3%。1 人 1 泊 1 万 3 千円未満は課税を免除。対象に簡易宿所と民泊（住宅宿泊事業、特区民泊）を足す | 同上 |
| 京都市（2026-03-01 の泊から） | 宿泊税 | 1 人 1 泊の宿泊料金が 6 千円未満 200 円、6 千円以上 2 万円未満 400 円、2 万円以上 5 万円未満 1,000 円、5 万円以上 10 万円未満 4,000 円、10 万円以上 10,000 円。全部の宿泊施設（住宅宿泊事業を含む）。宿泊料金は素泊まりの料金（室料とサービス料）で、食事代と消費税を除く。修学旅行などは課税しない。改正前の泊は 2 万円未満 200 円、2 万円以上 5 万円未満 500 円、5 万円以上 1,000 円（最初の草案の確認の値。2026-10-10 には資料を取得できず**未検証**） | [京都市 宿泊税について](https://www.city.kyoto.lg.jp/gyozai/page/0000236942.html)（見直しの告知のページは 2026-10-10 に取得できなかった。改正後の税率はこのページで確かめた。改正前の税率は**未検証**の写し） |
| 大阪府（2025-09-01 の泊から） | 宿泊税 | 1 人 1 泊の宿泊料金が 5 千円未満は課税しない、5 千円以上 1 万 5 千円未満 200 円、1 万 5 千円以上 2 万円未満 400 円、2 万円以上 500 円。旅館・ホテル、簡易宿所、特区民泊、住宅宿泊事業。宿泊料金は民泊の清掃料などを含み、飲食代・税を含まない | [大阪府 宿泊税](https://www.pref.osaka.lg.jp/o050040/zei/alacarte/shukuhaku.html) |
| 福岡市（福岡県の分を含む。2020-04-01 の施行） | 宿泊税 | 1 人 1 泊の宿泊料金が 2 万円未満 200 円（市 150 円、県 50 円）、2 万円以上 500 円（市 450 円、県 50 円）。市が県の分と一括して集める。住宅宿泊事業を含む。免税点はない | [福岡市 宿泊税の概要](https://www.city.fukuoka.lg.jp/zaisei/zeisei/life/syuku001.html)、[よくある質問](https://www.city.fukuoka.lg.jp/zaisei/zeisei/life/syukuqa.html) |
| 市町村（鉱泉浴場の所在地） | 入湯税 | 入湯客 1 人 1 日 150 円を標準として、市町村が条例で定める（地方税法第 701 条の 2）。旅館などが特別徴収義務者として集める | [総務省 入湯税](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/149767_20.html) |
| 国 | 消費税 | 標準の税率 10%。総額の表示と、適格請求書の端数処理は Shopify の題材で確かめた（[taxes-and-invoices.md](../../../shopify/docs/architecture/taxes-and-invoices.md) の 2 節） | 同左 |

- 東京都の宿泊料金に清掃料を含むかは、資料に記載がなかった（**未検証**）。京都市の「室料及びサービス料」に清掃料が入るかも確かめられなかった（**未検証**）。表は `base_includes` の欄で持ち、法務と運用が確かめてから値を入れる。
- 他の自治体（金沢市、北海道、倶知安町、ニセコ町など）の宿泊税は、この確認では読んでいない（**未検証**）。導入と改正が続いているので、表の更新を運用の定期の作業にする（9 節）。
- 子どもを「1 人」と数えるか、入湯税の年齢の免除は自治体ごとに違う（**未検証**）。表の欄で持つ。
- 宿泊税・入湯税に消費税がかかるかの扱いは確かめていない（**未検証**、L4）。この設計は税の行を宿泊の対価と別の行にし、消費税の計算に入れない。
- 本家が日本の宿泊税を代わりに集めて納めているかは、公式の資料で確かめられなかった（**未検証**）。

## 3. 要件

| 要件 | 値 | 出どころ |
| --- | --- | --- |
| 総額の一致 | 税を含む見積もりの総額と請求の額の違い 0 | NFR-015 |
| 表との一致 | 税の額は、見積もりに固定した税の表のバージョンで `tax-ref` が出す額と 1 円も違わない | [quality.md](../quality.md) の 2.2.1 節 C |
| 泊の日での切り替え | 改正の日をまたぐ滞在は、泊ごとに改正の前と後の表を使う | 京都市の資料（2 節） |
| 表の変更の反映 | 新しい表のバージョンは、出した後に作る見積もりから効く | [AGENTS.md](../../AGENTS.md) の「表はバージョンの付いた設定」 |
| 見積もりの速さ | 税の計算を含めて p99 500ms | NFR-004 |

## 4. 税の表（ADR-0032）

### 4.1 管轄と区域

- 管轄は `jurisdiction`：都道府県のコード、市区町村のコード（全国地方公共団体コード）、または税の区域の ID（自治体の一部だけに課す税。`tax_zones` の多角形。[location-and-geo.md](location-and-geo.md) の 4.4 節）。
- リスティングに当たる管轄は、`municipality_code`・その都道府県のコード・`tax_zone_ids` の集まり。1 つの滞在に複数の管轄の税が当たりうる（都道府県と市の両方が課す場合）。
- 同じ管轄・同じ税の種類で、一方が他方の分も集める（福岡市が県の分を集める）ときは、行を分けたまま `collected_with` で結び、明細は 1 行（内訳を持つ）にする。

### 4.2 行の形

| 欄 | 中身 |
| --- | --- |
| `jurisdiction`、`tax_kind`（`lodging_tax`・`bathing_tax`） | |
| `valid_from`、`valid_to` | 泊の日（物件の現地の日付）。`valid_to` は含む |
| `facility_types` | 当たる施設の種類の集合（`minpaku`（住宅宿泊事業）、`tokku_minpaku`、`ryokan_hotel`、`kan_i_shukusho`）。リスティングの施設の種類は届出・許可の種類から決まる（regulatory-compliance-japan の領域） |
| `calc_type` | `bracket_per_person_night`、`percent_per_person_night`、`flat_per_person_night` |
| `brackets` | `[{from, to, amount}]`（`from` を含み `to` を含まない。円） |
| `percent_bps`、`exempt_below` | 定率の率（万分率）と、課税しない 1 人 1 泊の標準の額の下限 |
| `flat_amount` | 定額 |
| `base_includes` | 課税の標準に含める滞在の料金：`cleaning_fee`、`pet_fee`、`extra_guest_fee` の集合。値が確かめられていない行は `unverified` の印を持ち、本番の表に入れない |
| `person_rule` | 数える人：`adults_and_children`、`adults_only`、`age_from:N` |
| `requires_amenity` | 入湯税は `onsen_bath` |
| `rounding` | `per_person_night_floor`（定率のとき、1 人 1 泊ごとに円未満を切り捨て）など。資料で確かめられない行は `unverified` |
| `collected_with` | 一括して集める他の行 |
| `source_url`、`source_checked_at` | 公式の資料と確認日 |

- 表全体（`tax_table_versions`：`version`、`published_at`、`approved_by`）にバージョンを付け、見積もりは作成の時の最新のバージョンを固定する。行の変更は新しいバージョンとして出す。古いバージョンは消さない。
- 表の中身（条例の読み取り）は、運用と法務が入れる。エージェントは変えない（[roadmap.md](../roadmap.md) の「エージェントに任せないこと」）。期待する値の試験のベクトルは QA が持つ。

### 4.3 2 節の値の行（草案）

| `jurisdiction` | `valid_from`〜`valid_to` | `facility_types` | `calc_type` | 値 | `base_includes` |
| --- | --- | --- | --- | --- | --- |
| 東京都 | 2002-10-01〜2027-03-31 | `ryokan_hotel` | `bracket_per_person_night` | [0, 10,000) 0、[10,000, 15,000) 100、[15,000, ∞) 200 | `unverified` |
| 東京都 | 2027-04-01〜 | 全部 | `percent_per_person_night` | 300 bp、`exempt_below` 13,000 | `unverified` |
| 京都市 | 〜2026-02-28 | 全部 | `bracket_per_person_night` | [0, 20,000) 200、[20,000, 50,000) 500、[50,000, ∞) 1,000 | `unverified` |
| 京都市 | 2026-03-01〜 | 全部 | `bracket_per_person_night` | [0, 6,000) 200、[6,000, 20,000) 400、[20,000, 50,000) 1,000、[50,000, 100,000) 4,000、[100,000, ∞) 10,000 | `unverified` |
| 大阪府 | 2025-09-01〜 | 全部 | `bracket_per_person_night` | [0, 5,000) 0、[5,000, 15,000) 200、[15,000, 20,000) 400、[20,000, ∞) 500 | `cleaning_fee`（資料に「民泊の清掃料等を含む」） |
| 福岡市 | 2020-04-01〜 | 全部 | `bracket_per_person_night` | [0, 20,000) 150、[20,000, ∞) 450。`collected_with` 福岡県（福岡市の区域） | `unverified` |
| 福岡県（福岡市の区域） | 2020-04-01〜 | 全部 | `flat_per_person_night` | 50 | `unverified` |

- 東京都の改正前の行の開始の日（平成 14 年 10 月 1 日）は、主税局の資料の施行日。
- `unverified` の行は、開発・検証の環境の試験には使い、本番の表には法務と運用の確かめの後に入れる。確かめが済むまで、その管轄のリスティングは税の行を「現地で支払い」の注で出す（9 節）。

## 5. 計算（ADR-0033）

### 5.1 入力と出力

```text
computeStayTaxes(input) -> TaxLines
input:
  nights[]        : { date, nightly_after_discount, extra_guest_fee }   ← 整数、ホストの通貨
  stay_fees       : { cleaning_fee, pet_fee }
  persons         : { adults, children, infants, child_ages[] }
  listing         : { jurisdictions[], facility_type, amenities }
  tax_table       : 固定したバージョン
output:
  lines[]         : { tax_kind, jurisdiction, amount, breakdown[] }       ← 明細の行（管轄ごと）
  per_night[]     : { date, base_per_person, persons_counted, amount }    ← 監査と返金の計算のため
```

### 5.2 手順

1. **長期の割引を夜に按分する**：割引の額を、夜の料金の比で按分する（切り捨ての後、残りを額の大きい夜から 1 円ずつ、同じ額なら日付の順）。`nightly_after_discount = nightly − 按分`。
2. **滞在の料金を夜に按分する**：行の `base_includes` にある滞在の料金（清掃料、ペット）を泊数で等しく割る（切り捨ての後、残りを早い夜から 1 円ずつ）。
3. 各夜 `n` で、当たる行を泊の日で選ぶ（`valid_from ≤ date ≤ valid_to`、施設の種類、`requires_amenity`）。
4. 課税の人数 `k` = 行の `person_rule` で数えた人数。
5. 1 人 1 泊の標準 `b_n = (nightly_after_discount_n + extra_guest_fee_n（含むとき）+ 按分した滞在の料金_n) / k`。分子と分母の整数で持ち、段階の判定は有理数のまま比べる（円未満を丸めてから比べない）。
6. 1 人 1 泊の税：
   - `bracket_per_person_night`：`b_n` が入る段階の額。
   - `percent_per_person_night`：`b_n < exempt_below` なら 0、そうでなければ `rounding` に従って `b_n × percent_bps / 10,000`。
   - `flat_per_person_night`：`flat_amount`。
7. 夜の税 = 1 人 1 泊の税 × `k`。管轄ごとに夜の税を足して明細の行にする。

- 夜ごとに段階を判定するのは、1 泊の料金が夜で違う（週末、季節、上書き）ためである。滞在の平均で判定すると、段階の境の近くで夜ごとの判定と違う額になる。どちらが条例に合うかは法務の確認待ち（L4）で、`per_night` の判定を既定にする。

### 5.3 例：京都市の 3 泊（[pricing-and-fees.md](pricing-and-fees.md) の 8.2 節）

夜の料金 17,000・20,000・14,000、追加のゲスト 2,000/泊、清掃料 6,000、大人 3 人。表は京都市 2026-03-01〜。`base_includes` を仮に `cleaning_fee`・`extra_guest_fee` として計算する（京都市の値は**未検証**）。

| 夜 | 標準の分子 | ÷ 3 人 | 段階 | 1 人の税 | 夜の税 |
| --- | --- | --- | --- | --- | --- |
| 11-27 | 17,000 + 2,000 + 2,000 = 21,000 | 7,000 | [6,000, 20,000) | 400 | 1,200 |
| 11-28 | 20,000 + 2,000 + 2,000 = 24,000 | 8,000 | 同上 | 400 | 1,200 |
| 11-29 | 14,000 + 2,000 + 2,000 = 18,000 | 6,000 | 同上（6,000 を含む） | 400 | 1,200 |
| 計 | | | | | **3,600** |

- `base_includes` に清掃料を含めないと、11-29 は (14,000 + 2,000) / 3 = 5,333.33… で [0, 6,000) の 200 円になり、計 3,000 円。標準の定義 1 つで 600 円違う。`unverified` の行を本番に入れない理由である。

**同じ滞在を他の管轄の表で計算すると**（施設は住宅宿泊事業、清掃料を含む標準）：

| 表 | 夜ごとの 1 人の標準 | 1 人 1 泊の税 | 計 |
| --- | --- | --- | --- |
| 大阪府 | 7,000・8,000・6,000 | 200・200・200 | 1,800 |
| 東京都（2027-03-31 まで） | - | 民泊は対象外 | 0 |
| 東京都（2027-04-01 から） | 7,000・8,000・6,000 | 1 万 3 千円未満で免除 | 0 |
| 福岡市・福岡県 | 7,000・8,000・6,000 | 150 + 50 | 1,800（市 1,350、県 450。明細は 1 行） |

**東京都の定率の例**（2027-04-01 の後、住宅宿泊事業、2 人、1 泊 40,000 円、清掃料 4,000 円を含めると仮定）：標準 = (40,000 + 4,000) / 2 = 22,000 ≥ 13,000。1 人 1 泊 22,000 × 3% = 660、夜の税 1,320。端数の扱いは**未検証**（この例は割り切れる）。

**改正の日をまたぐ例**（京都市、2026-02-28 から 2 泊、1 人 1 泊の標準 8,000 円、2 人）：2-28 の夜は改正前の表で 200 × 2 = 400、3-01 の夜は改正後の表で 400 × 2 = 800。計 1,200。

### 5.4 入湯税

- リスティングが `onsen_bath` の設備を持ち、その市町村の `bathing_tax` の行があるときだけ計算する。`flat_per_person_night` で、`person_rule` に年齢の免除を持つ。
- 宿泊を伴う入湯の「1 日」と泊の対応（1 泊 = 1 日か）、民泊の温泉の扱い、特別徴収義務者は自治体ごとに違う（**未検証**、L4）。MVP の表には、運用と法務が確かめた市町村の行だけを入れる。
- 温泉の設備の自己申告の誤り（温泉でない浴室に `onsen_bath`）は、表示の規則と審査で扱う（[listings-and-content.md](listings-and-content.md) の 7 節）。

### 5.5 検索の目安

- `quoteSummary` も同じ `computeStayTaxes` を呼ぶ（[ADR-0030](../decisions/0030-quote-stay-pipeline-and-rounding.md)）。表はプロセスのメモリーに持ち、新しいバージョンを 1 分ごとに確かめて読み直す。
- 検索の結果の総額は税を含む目安である（[pricing-and-fees.md](pricing-and-fees.md) の 8.1 節）。

## 6. 明細

| 明細の行 | 中身 |
| --- | --- |
| `lodging_tax:<jurisdiction>` | 例「宿泊税（京都市）3,600 円」。一括して集める行は内訳つきの 1 行（「宿泊税（福岡市・福岡県）1,800 円」） |
| `bathing_tax:<jurisdiction>` | 例「入湯税（〇〇市）」 |
| 消費税 | 行を出さない（7 節） |

- 確認の画面・予約の画面・領収書（ゲスト）・ホストの明細に同じ行を出す。
- 税の行の額は、請求の通貨への按分の対象になる（[pricing-and-fees.md](pricing-and-fees.md) の 8.2 節）。ホストの明細と納付の資料は、ホストの通貨（円）の額で出す。

## 7. 消費税

- **宿泊の対価**：ホストの料金は消費税を含む額（総額の表示）として扱い、本システムは足さない。ホストが課税の事業者か、免税の事業者か、適格請求書の登録があるかで、ゲストへの領収書の書き方が変わる。本システムが誰の名前で領収書・適格請求書を出すか（媒介者交付特例を使うか）は法務の確認待ち（L4）。それまで、ゲストの領収書は「宿泊の代金（税込み）」の 1 行と税の行で出し、消費税の額を書かない。
- **サービス料**：本システムがホストに請求するサービス料は消費税を含む額で、うち消費税は `floor(service_fee × 10 / 110)`（[pricing-and-fees.md](pricing-and-fees.md) の 7 節）。ホストへの手数料の適格請求書の形と、一の請求書につき税率ごとに 1 回の端数処理（月ごとにまとめるか予約ごとか）は ledger-and-payouts の領域で決める（Shopify の題材の [ADR-0017](../../../shopify/docs/decisions/0017-consumption-tax-calculation-and-rounding.md) の考え方）。
- **海外のホスト・プラットフォーム課税**：S2 以降。法務の L4。

## 8. 預かりと納付の型（ADR-0034。枠組み、法務の確認待ち L4）

| `legal.lodging_tax_collector` | 受け取り | release の仕訳 | ホストへの資料 | 本システムの義務 |
| --- | --- | --- | --- | --- |
| `host`（既定） | 税を総額に含めて受ける | 税の額をホストへの支払い（`host_payable`）に含める（[ADR-0005](../decisions/0005-payments-hold-capture-and-ledger.md)） | 月ごと・管轄ごと・税の種類ごとの、泊数・人数・課税の標準・税の額の明細（申告に使う） | 額を正しく出して明細に書く |
| `platform` | 同上 | 税の額を `tax_payable:<jurisdiction>:<tax>` に振り替える | 本システムが納めた旨の明細 | 管轄ごとの申告と納付（特別徴収義務者の登録など。L4） |

- 本番の値は法務の結論の後に決める。結論までは `host` で、管轄ごとに値を持てる形（`legal.lodging_tax_collector.<jurisdiction>`）にする。管轄ごとに本システムが集める協定がありうるため。
- **キャンセルの税**：返し方の正本は [cancellations-and-changes.md](cancellations-and-changes.md) の 5.3 節の DT-CXL-001（[ADR-0039](../decisions/0039-cancellation-policy-table-and-refund-decision-table.md)）。使わなかった泊の税を返し、チェックインの前は全額を返す。この文書は、泊ごとの額（`reservation_tax_nights`）を渡すことと、返した税・残した税を `host`・`platform` のどちらで扱うかを持つ。ホストの取り分（違約金）に税を掛けない。違約金が課税の標準に当たらないことの確かめは L4。
- 日程・人数の変更：新しい見積もりで税を計算し直し、差額を `alter` の仕訳に入れる（[ADR-0005](../decisions/0005-payments-hold-capture-and-ledger.md)）。

## 9. 失敗と回復

| 事象 | 影響 | 扱い |
| --- | --- | --- |
| 改正の公表が予約の後（泊の前） | 予約の時の表と、泊の日に有効な表が違う | 見積もりの額で請求する（NFR-015）。差額の扱い（ホストが現地で集める、本システムが差額を請求する、ホストが負う）は法務の L4。既定は、ホストとゲストに差額を知らせ、ホストの明細に「改正による差額」を出す。京都市はゲストが差額を施設に払う旨を案内している（2 節の資料） |
| 表の誤り（段階の値の入れ違い） | 誤った税 | 新しいバージョンで直す。誤ったバージョンで作った見積もりと予約を一覧にし、財務と法務が扱いを決める（返金か、ホストの明細の直し） |
| 税の区域の誤り（ピンの区域の判定の誤り） | 別の管轄の税 | 区域を直し、求め直しのジョブ（[location-and-geo.md](location-and-geo.md) の 4.4 節）。影響した予約を一覧にする |
| 確かめていない管轄（`unverified` の行しかない） | 税を出せない | その管轄のリスティングは公開できるが、確認の画面に「宿泊税は現地で支払いが必要な場合があります」の注を出し、税の行を出さない。運用の待ち行列で表を確かめる。法務と、この扱いで公開してよいかを確かめる（L4） |
| 表の読み込みの失敗 | 見積もりができない | 503。税のない総額を出さない（[pricing-and-fees.md](pricing-and-fees.md) の 11 節） |

## 10. 上限

| 対象 | 値 |
| --- | --- |
| 1 つの滞在に当たる管轄 | 4 |
| 段階 | 1 行 10 |
| 表のバージョン | 消さない |
| 1 滞在の泊数 | 27（MVP の上限。[availability-and-calendars.md](availability-and-calendars.md) の 6.3 節） |

## 11. data-model への項目

| 置き場所 | 中身 | 節 |
| --- | --- | --- |
| Aurora core `tax_table_versions`（`version`、`published_at`、`approved_by`、`notes`） | 表のバージョン | 4.2 |
| Aurora core `tax_rules`（4.2 節の欄、`table_version`） | 税の行 | 4.2 |
| Aurora core `tax_zones`（`id`、`jurisdiction`、`geom`、`valid_from`） | 税の区域 | 4.1 |
| Aurora core `quotes.tax_lines`、`quotes.tax_table_version`（見積もりの写しの列） | 明細と固定 | 5、6 |
| Aurora core `reservation_tax_nights`（`reservation_id`、`quote_id`、`night_date`、`jurisdiction`、`tax_kind`、`base_numerator`、`persons_counted`、`amount`、`table_version`） | 泊ごとの税（返金・明細・申告の資料） | 5.2、8 |
| Aurora ledger の口座 `tax_payable:<jurisdiction>:<tax>`（`platform` のときだけ） | 預かり | 8 |
| AppConfig `legal.lodging_tax_collector`、`legal.lodging_tax_collector.<jurisdiction>` | 型 | 8 |

## 12. テストと性質

| ID | 性質・試験 |
| --- | --- |
| PROP-TAX-001 | 任意の夜の料金・滞在の料金・人数・表で、`computeStayTaxes` は `tax-ref`（条例の文のとおりに夜ごと・人ごとに書いた素直な実装）と 1 円も違わない |
| PROP-TAX-002 | 夜の課税の標準の和（× 人数）は、按分の前の対象の料金の和と一致する（按分で 1 円も消えず増えない） |
| PROP-TAX-003 | 改正の日をまたぐ滞在で、各夜の税は、その夜の日付で有効な行で計算される |
| PROP-TAX-004 | 見積もりの後に表の新しいバージョンを出しても、その見積もりから作った予約の税の額は変わらない |
| PROP-TAX-005 | `bracket_per_person_night` の税は、夜の料金について単調に増える（減らない） |
| PROP-TAX-006 | チェックインの前のキャンセルの返金は、税の行の全額を含む。滞在中のキャンセルの返金の税は、泊まらない夜の `reservation_tax_nights` の和（規則は DT-CXL-001） |
| PROP-TAX-007 | `unverified` の欄を持つ行は、本番の表のバージョンに入らない（表の公開の検査） |
| 試験のベクトル | 4.3 節の各行の段階の境（境の 1 円前・ちょうど・1 円後）、5.3 節の例（3,600、3,000、1,800、0、1,320、1,200） |
| 仮想の時計 | 改正の日の 0 時をまたぐ泊、年度の境 |

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E8 | `tax-tables` | 表の形、バージョン、区域、2 節の行の確かめと入力の手順。預かりと納付の型は法務：L4（4 節） |
| E8 | `stay-tax-computation` | `computeStayTaxes`、按分、夜ごとの判定、`tax-ref`（5 節） |
| E8 | `tax-lines-and-statements` | 明細の行、ホストの月ごとの税の明細（6、8 節） |
| E12 | `tax-collection-and-remittance` | `platform` の型の仕訳と納付の資料。法務：L4（8 節） |
| E10 | （cancellations-and-changes の領域の `cancellation-policies`）キャンセルの税 | DT-CXL-001 の税の行（PROP-TAX-006） |

## 14. 未解決の問い

### 決定（2026-10-10、既定案）

- **表の形**：管轄・泊の日・施設の種類・3 つの計算の型・標準の定義・資料の URL を持つ行と、表全体のバージョン（ADR-0032）。
- **計算**：夜ごと・人ごとの判定、割引と滞在の料金の按分、有理数のままの段階の判定（ADR-0033）。
- **型**：`legal.lodging_tax_collector` の既定 `host`（ADR-0034）。キャンセルの税は DT-CXL-001（ADR-0039）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 本システムが特別徴収義務者として預かり納めるか。管轄ごとの協定 | 法務の確認待ち（L4） |
| 課税の標準に清掃料・追加のゲストの料金を含むか（東京都・京都市・福岡市） | 法務と運用が各自治体に確かめる。確かめるまで `unverified` |
| 夜ごとの判定か、滞在の平均か | 法務の確認待ち（L4） |
| 宿泊税・入湯税への消費税、ゲストの領収書の消費税の書き方、媒介者交付特例 | 法務の確認待ち（L4） |
| 改正の後の差額の扱い | 法務の確認待ち（L4） |
| 他の自治体の表と、改正の見張りの運用 | E8 の `tax-tables` で、運用の月ごとの確かめの手順を決める |

## 出典

いずれも 2026-10-10 に確認。

- 東京都主税局, [宿泊税の見直し](https://www.tax.metro.tokyo.lg.jp/kazei/leisure/shuk/shuk_minaoshi)：改正前は 1 万円以上 1 万 5 千円未満 100 円、1 万 5 千円以上 200 円、旅館・ホテルだけ。令和 9 年 4 月 1 日から 3%、免除 1 万 3 千円未満、簡易宿所と民泊を対象に足す。宿泊料金は素泊まりの料金
- 京都市, [宿泊税について](https://www.city.kyoto.lg.jp/gyozai/page/0000236942.html)：5 段階の税率（令和 8 年 3 月 1 日から。見直しの告知のページは 2026-10-10 に 404 で、改正前の税率は最初の草案の確認の値のまま）、住宅宿泊事業を含む、素泊まりの料金（室料及びサービス料）
- 大阪府, [宿泊税](https://www.pref.osaka.lg.jp/o050040/zei/alacarte/shukuhaku.html)：令和 7 年 9 月 1 日からの 3 段階、5 千円未満は課税しない、民泊の清掃料等を含む
- 福岡市, [宿泊税の概要](https://www.city.fukuoka.lg.jp/zaisei/zeisei/life/syuku001.html)、[宿泊税に関するよくある質問](https://www.city.fukuoka.lg.jp/zaisei/zeisei/life/syukuqa.html)：2 万円未満 200 円（市 150、県 50）、2 万円以上 500 円（市 450、県 50）、民泊を含む。条例の施行は令和 2 年 4 月 1 日
- 総務省, [入湯税](https://www.soumu.go.jp/main_sosiki/jichi_zeisei/czaisei/czaisei_seido/149767_20.html)：1 人 1 日 150 円を標準に市町村が定める目的税。旅館などが特別徴収する

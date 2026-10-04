# Sales objects: Salesforce

営業の標準オブジェクト（取引先、取引先責任者、リード、商談、活動）、リードの変換、重複の規則と照合（日本語の名前・カナの正規化）、メールの記録の設計。土台は [ADR-0002](../decisions/0002-custom-object-storage.md)（標準オブジェクトも records の表に入れる）、[ADR-0008](../decisions/0008-dml-order-of-execution.md)（DML の手順。重複の規則は手順 5）、[ADR-0015](../decisions/0015-sharing-reasons-and-where-they-live.md)（取引先と子の暗黙の共有）。この文書で決めたことは、次の 2 つの ADR にある。

- リードの変換は、1 つのトランザクションで行う合成の DML にする。作る・更新するレコードは、全て通常の DML の手順を通る。活動は多態の参照（誰と・何と）を持ち、共有は「主の親」1 つの判定と、割り当てられた人の判定の強い方で決める（[ADR-0021](../decisions/0021-lead-conversion-and-activity-parents.md)）。
- 重複の規則は、保存の手順 5 で、同じトランザクションで書く正規化した照合の鍵で候補を引き、評価器で点数を付けて判定する。日本語は NFKC、カナの統一、長音の統一、法人格の除去、異体字の表で正規化する。見えないレコードとの重複は、既定で知らせない（[ADR-0022](../decisions/0022-duplicate-rules-and-japanese-matching.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。ヘルプの記事は、2026-09-28 にブラウザーで本文を読んで確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 取引先・取引先責任者・リード・商談・活動（ToDo・行動）・メールの標準の項目と規則 | 項目の型、データ辞書（[metadata-and-runtime.md](metadata-and-runtime.md)） |
| 商談のフェーズの定義（確度、完了、成立、売上予測の分類） | 売上予測、商品と価格表、見積もり（MVP の後。intent） |
| リードの変換と、項目の対応の設定 | 画面・レイアウト（[ui-layouts-and-list-views.md](ui-layouts-and-list-views.md)） |
| 活動の多態の参照と、その共有の判定の入力 | 共有の判定の本体（[sharing-and-record-access.md](sharing-and-record-access.md)） |
| 重複の規則、照合の規則、日本語の正規化、重複の記録 | 一括の取り込みでの重複の照合の流れ（bulk-and-import の領域。照合の部品はこの文書のものを使う） |
| メールの記録（BCC の宛先での取り込み）と、1 通ずつの送信 | 一括のメール（MVP の後。法務の L8）、メールの送信事業者の運用（events-and-integrations の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| リードの変換で作るもの | 取引先、取引先責任者、任意で商談を作る。既存の取引先・取引先責任者に合わせる（merge）こともできる | [Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)（Winter '27 版、以下「Apex」）の「Converting Leads」 |
| 変換の状態 | 変換の前に、`IsConverted = true` のリードの状態の値を問い合わせて渡す。状態を変換済みの値に変えるだけでは変換できない | Apex、[Object Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/object_reference.pdf)（Winter '27 版、以下「OBJ」）の Lead |
| キューが所有するリード | 取引先と取引先責任者はキューに所有させられないので、変換の時に所有者の指定が要る | Apex |
| 変換した後のリード | 問い合わせはできる。更新できるのは「変換済みのリードの参照・編集」の権限を持つ人だけ。`ConvertedAccountId`・`ConvertedContactId`・`ConvertedOpportunityId`・`ConvertedDate` を持つ | OBJ の Lead |
| 項目の対応 | 標準の項目は決まった対応で写る。カスタム項目は、設定で取引先・取引先責任者・商談の項目に対応を付ける。変換の画面で商談を「表示・任意」「表示・必須」「表示しない」にできる | [Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)（Winter '27 版、以下「MDAPI」）の LeadConvertSettings |
| 既存のレコードへの変換 | 既存の取引先・取引先責任者の値は上書きせず、空の項目にだけ入れる。リードの活動は、できた取引先・取引先責任者・商談に付く。変換済みのリードは読むだけになる | [What happens when I convert leads?](https://help.salesforce.com/s/articleView?id=sales.faq_leads_what_happens_when.htm&type=5)（2026-09-28 に確認） |
| 商談のフェーズ | フェーズごとに既定の確度、完了か、成立か、売上予測の分類を持つ | OBJ の OpportunityStage |
| 活動の関連先 | ToDo・行動は、リード 1 件か、取引先責任者 50 件までに関連付けられる（共有の活動を有効にした時） | OBJ の TaskRelation、EventRelation |
| 活動の共有 | 活動は自分の共有の表を持たない | [Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)（以下「RLA」） |
| 活動を見られる人の細部 | 活動の OWD の既定は非公開。割り当てられた人と、関連先を見られる人のどちらで決まるか、複数の関連先の時にどうなるかは、公開の資料に書かれていない（未検証。E4 の `activity-sharing` で試用の組織で確かめる） | [Default Organization-Wide Access Levels](https://help.salesforce.com/s/articleView?id=platform.security_sharing_owd_default_settings.htm&type=5)（2026-09-28 に確認） |
| 重複の規則 | 作成・更新ごとに「許可（警告・記録）」か「止める」を選ぶ。照合の規則を 1 つ以上持つ。共有の扱いを「共有を守る」「共有を無視する」から選ぶ。「共有を守る」では、見えないレコードとの重複は何も知らせず保存を通す | MDAPI の DuplicateRule |
| 照合の規則 | 項目ごとに「完全一致」か、あいまいな照合の方法（名、姓、会社名、電話、市区町村、番地、郵便番号、役職）を選ぶ。空の値を一致とみなすかを選ぶ。条件の論理を持つ | MDAPI の MatchingRule |
| あいまいな照合の中身 | 会社名は「Inc」「Corp」などを外して正規化する。Jaro-Winkler 距離、Metaphone 3、名前の異表記、頭字語、編集距離などを組み合わせ、大文字と小文字を区別しない | [Matching Algorithms Used with Matching Methods](https://help.salesforce.com/s/articleView?id=sales.matching_rules_matching_algorithms.htm&type=5)、[Standard Account Matching Rule](https://help.salesforce.com/s/articleView?id=sales.matching_rules_standard_account_rule.htm&type=5)（2026-09-28 に確認） |
| 規則の数 | 1 オブジェクトで有効な重複の規則 5、有効な照合の規則 5、1 つの重複の規則に照合の規則 3 | [Things to Know About Duplicate Rules](https://help.salesforce.com/s/articleView?id=sales.duplicate_rules_overview.htm&type=5)（2026-09-28 に確認） |
| 日本語の照合 | あいまいな照合が日本語（漢字・カナ）をどう扱うかは、資料に書かれていない。電話と住所は区切りごとに比べ、北米のデータに向くと書く | Standard Account Matching Rule |
| メールの記録 | 利用者ごとの BCC の宛先で送ったメールを、宛先のメールの一致するレコードの活動の履歴か、未処理の一覧に記録する。別の機能（活動の取り込み）は、「メールを活動として同期」を有効にすると、取り込んだメールをレコードとして保存し、レポート・ワークフロー・API で使える | [How Does Email to Salesforce Work?](https://help.salesforce.com/s/articleView?id=sales.email_my_email_2_sfdc.htm&type=5)、[Emails and Einstein Activity Capture](https://help.salesforce.com/s/articleView?id=sales.aac_email_parent.htm&type=5)（2026-09-28 に確認） |

## 3. 標準オブジェクト

### 3.1 共通

- 標準オブジェクトは `md_objects` の `kind = standard` の行で、組織の作成時に種から入れる（[metadata-and-runtime.md](metadata-and-runtime.md) の 3.1 節）。レコードは `records` に入れ、カスタムオブジェクトと同じ経路で読み書きする（ADR-0002）。
- 標準の項目の API の名前は、接頭辞なしの小文字のスネークにする。組織は、標準オブジェクトに `x_` のカスタム項目を足せる。
- 標準の項目は削除できない。ラベル、ヘルプの文、選択リストの値、必須（標準で必須でないもの）は変えられる。
- 全ての標準オブジェクトの名前の項目は `records.name` に写し、索引を張る（[data-storage.md](data-storage.md) の 3.2 節）。
- 日本の住所は、複合の住所として `postal_code`、`prefecture`、`city`、`street`、`building`、`country` の 6 つの項目で持つ。本家の複合の住所（番地・市区町村・州・郵便番号・国）とは分け方が違う。日本の都道府県を選択リストにできるようにするため。

### 3.2 取引先（`account`）

| 項目 | 型 | 備考 |
| --- | --- | --- |
| `name` | `text`（255） | 必須。会社名 |
| `name_kana` | `text`（255） | 会社名のカナ。重複の照合と並べ替えに使う |
| `corporate_number` | `text`（13） | 法人番号。13 桁の数字の形を検査する。一意・外部 ID にできる |
| `parent` | `lookup`（取引先） | 親会社。循環を禁止する（保存の手順 2 で親をたどって確かめる。10 段まで） |
| `type`、`industry`、`rating` | `picklist` | |
| `phone`、`website` | `phone`、`url` | |
| `billing_*`、`shipping_*` | 住所の 6 項目 × 2 | 3.1 節 |
| `employees`、`annual_revenue` | `number`、`currency` | |
| `owner` | システムの列 | `records.owner_id`。キューには所有させない（3.4 節） |

- OWD の既定は `private`。`grant_via_hierarchy` は常に真（[sharing-and-record-access.md](sharing-and-record-access.md) の 4.1 節）。
- 取引先の子（商談・取引先責任者）との暗黙の共有は、共有の領域の 5.6 節のとおり。

### 3.3 取引先責任者（`contact`）

| 項目 | 型 | 備考 |
| --- | --- | --- |
| `last_name` | `text`（80） | 必須 |
| `first_name` | `text`（40） | |
| `last_name_kana`、`first_name_kana` | `text`（80、40） | 重複の照合と並べ替えに使う |
| `name` | システムの計算 | `last_name`＋空白＋`first_name`（日本語の組織の既定）。表示の順は組織の設定で変えられる。`records.name` に写す |
| `account` | `lookup`（取引先） | 任意。空なら暗黙の共有の対象外になり、所有者と共有だけで判定する |
| `email`、`phone`、`mobile_phone` | | `email` は正規化した値で照合する（6 節） |
| `title`、`department`、`reports_to`（`lookup` 取引先責任者） | | |
| `mailing_*` | 住所の 6 項目 | |
| `email_opt_out`、`do_not_call` | `checkbox` | 送信の前に確かめる（8 節）。法務の L8 |

- OWD の既定は `private`（取引先の子として、共有の領域の暗黙の共有を使う）。本家は取引先責任者に「親に連動」を選べるが、本システムの `controlled_by_parent` は主従の従と活動だけに選べる（共有の領域の 4.1 節）。取引先との関係が参照だからである。
- 取引先責任者とリードの個人データの扱いは、法務の L1 の結論まで、E5 の spec を承認しない（intent）。

### 3.4 リード（`lead`）

| 項目 | 型 | 備考 |
| --- | --- | --- |
| `last_name`、`first_name`、それぞれの `_kana` | | 取引先責任者と同じ |
| `company`、`company_kana` | `text` | 必須（`company`） |
| `corporate_number` | `text`（13） | |
| `status` | `picklist` | 値ごとに `converted`（変換済みの値か）を持つ。3.4.1 節 |
| `source`、`rating`、`industry` | `picklist` | |
| `email`、`phone`、`mobile_phone`、`title`、住所 | | |
| `is_converted` | システム | 変換で真になる。利用者は書けない |
| `converted_account`、`converted_contact`、`converted_opportunity` | システムの `lookup` | 変換で入る |
| `converted_at` | システムの `datetime` | |

- リードはキューに所有させられる（営業の振り分けの待ち行列）。
- **変換したリードは読むだけにする。** 更新は `edit_converted_leads` のシステムの権限を持つ人だけができる。本家と同じ（OBJ）。削除は `delete` の権限で通常どおりできる。
- `status` を変換済みの値に書き換える更新は、`INVALID_VALUE` で断る。変換は 5 節の API だけで行う（本家と同じ。OBJ）。

#### 3.4.1 リードの状態の値

| 列 | 意味 |
| --- | --- |
| `converted` | 変換済みの値か。組織に 1 つ以上必要。変換の時に選ぶ |
| `is_default` | 作成時の既定 |
| `closed_unconverted` | 変換せずに終わった（失注など）。リストビューの既定の条件で使う |

`md_picklist_values` に `attrs`（JSONB）を足して持つ。選択リストの値に意味を持たせる同じ仕組みを、商談のフェーズ（3.5 節）と ToDo の状態でも使う。

### 3.5 商談（`opportunity`）

| 項目 | 型 | 備考 |
| --- | --- | --- |
| `name` | `text`（120） | 必須 |
| `account` | `lookup`（取引先） | 任意。空なら暗黙の共有の対象外 |
| `amount` | `currency`（JPY は `scale` 0） | |
| `close_date` | `date` | 必須 |
| `stage` | `picklist` | 必須。値ごとの属性は下の表 |
| `probability` | `percent` | 既定はフェーズの `default_probability`。利用者が変えられる |
| `forecast_category` | `picklist` | フェーズから決まる。利用者は書けない（MVP） |
| `is_closed`、`is_won` | システムの `checkbox` | フェーズから決まる。保存の手順 2 で入れる |
| `type`、`lead_source`、`next_step` | | |
| `owner` | システムの列 | |

**フェーズの値の属性（`attrs`）**

| 属性 | 値 | 本家 |
| --- | --- | --- |
| `default_probability` | 0〜100 | `DefaultProbability`（OBJ） |
| `is_closed` | 真偽 | `IsClosed` |
| `is_won` | 真偽。`is_closed` が真の時だけ真にできる | `IsWon` |
| `forecast_category` | `pipeline`・`best_case`・`commit`・`closed`・`omitted` | `ForecastCategory` |

- 組織は、完了して成立のフェーズと、完了して不成立のフェーズを、少なくとも 1 つずつ持つ（保存の時に検査する）。
- フェーズを変えると、保存の手順 2 で、`probability`（利用者がこの保存で書いていなければ）・`forecast_category`・`is_closed`・`is_won` をフェーズの値から入れ直す。この値は保存の前のフローより前に決まるので、フローは入れ直した値を見る。
- **商談の履歴**：`opportunity_history`（`stage`・`amount`・`probability`・`close_date`・`forecast_category` が変わるたびに 1 行）を、保存の手順 9（項目の変更の履歴と同じ場所）で書く。パイプラインの推移のレポート（[reports-and-dashboards.md](reports-and-dashboards.md)）の元になる。項目の変更の履歴の設定とは別に、常に書く。
- **商談の取引先責任者の役割**（`opportunity_contact_role`）：商談と取引先責任者をつなぐ標準の主従の従のオブジェクト。`role`（選択リスト）、`is_primary`（商談ごとに 1 件まで。保存の手順 6 の一意で守る）。商談に連動して共有する（`controlled_by_parent`）。
- 商品・価格表・商談の商品は MVP の後（intent）。`amount` は利用者が直接入れる。

### 3.6 活動（`task`、`event`）

| 項目 | ToDo（`task`） | 行動（`event`） |
| --- | --- | --- |
| 件名 | `subject`（必須） | `subject`（必須） |
| 日時 | `due_date`（`date`） | `start_at`、`end_at`（`datetime`、必須）、`is_all_day` |
| 状態 | `status`（選択リスト。値に `is_closed`）、`priority` | — |
| 誰と（`who`） | 多態の参照：取引先責任者かリード | 同じ |
| 何と（`what`） | 多態の参照：取引先、商談、活動を許したカスタムオブジェクト | 同じ |
| 追加の関係者 | `activity_relations`：取引先責任者 50 件まで、またはリード 1 件（本家と同じ。OBJ） | 同じ。行動は出席者の返事も持つ |
| 割り当て | `owner`（利用者。キュー不可） | `owner` |

- **多態の参照**は、`data` に `{"id": ..., "object": ...}` を持つ新しい項目の型 `polymorphic_lookup` とし、`record_relationships` に書く（参照先のオブジェクトの ID を行に含める）。型の追加は [metadata-and-runtime.md](metadata-and-runtime.md) の 3.3 節の表への追加の依頼として扱う（12 節）。
- `who` がリードで、`what` を持つことはできない（本家と同じ扱いにする。[Object Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/object_reference.pdf)、Winter '27 版の Task、2026-09-28 に確認）。
- カスタムオブジェクトは、`md_objects.allow_activities` が真の時だけ `what` になれる。
- 活動の共有は 4 節。

### 3.7 メールのメッセージ（`email_message`）

8 節で使う。活動と同じく `who`・`what` と `activity_relations` を持つ。本文は `record_long_texts`、添付は S3 に置いて `email_attachments` で指す。`message_id`（RFC 5322 の Message-ID）を一意の外部 ID にし、同じメールを 2 回記録しない。

## 4. 活動の共有（ADR-0021）

活動は自分の共有の行を持たない（RLA。ADR-0004 の「主従の従と活動は親のレコードの判定に従う」）。本システムでは、次の規則で水準を決める。

- **主の親**：`what` があれば `what`、なければ `who`。主の親の ID を `records.parent_id` に写す。
- **水準**：次の 2 つの強い方。
  1. 主の親の水準（共有の領域の DT-SHR-001 で親を判定したもの）。`read` なら `read`、`edit` 以上なら `edit`。
  2. 割り当てられた本人（`owner_id` が本人）と、その上司（`grant_via_hierarchy` の閉包）は `full`。
- 主の親がない活動（`who`・`what` とも空）は、2 だけで決める。
- `activity_relations` の追加の関係者は、水準を広げない。追加の取引先責任者を見られるだけでは、その活動を見られない。
- 主の親の変更と `owner` の変更は、共有の行の書き直しを伴わない（行を持たないため）。

**DT-ACT-001：活動の水準**（上から評価し、最初に一致した行を採る）

| # | オブジェクトの `read` | `modify_all`・`modify_all_data` | `view_all`・`view_all_data` | 本人・階層で割り当て | 主の親の水準 | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | なし | - | - | - | - | `none` |
| 2 | あり | あり | - | - | - | `full` |
| 3 | あり | なし | - | あり | - | `full` |
| 4 | あり | なし | - | なし | `edit` 以上 | `edit` |
| 5 | あり | なし | あり | なし | - | `read` |
| 6 | あり | なし | なし | なし | `read` | `read` |
| 7 | あり | なし | なし | なし | `none` か、主の親がない | `none` |

- この表は、共有の領域の DT-SHR-001 の行 3・4（活動の割り当てと `controlled_by_parent`）を活動について細かくしたものである。`controlled_by_parent` の行は「所有者」を見ないので、割り当てられた本人が親を見られない時に自分の ToDo を見られなくなる。そのため、共有の領域に「活動の割り当て」の行を依頼し、2026-09-28 に DT-SHR-001 の行 3 として足した（割り当てられた本人と上司は `full`）。
- 問い合わせの時の条件は、共有の領域の 6.2 節の「親に連動」の枝に、`owner_id IN g_me` の枝を足した形にする。主の親のオブジェクトが多態なので、親のオブジェクトごとに条件を作り、`OR` でつなぐ（取引先、商談、取引先責任者、リード、活動を許したカスタムオブジェクトの数だけ）。

## 5. リードの変換（ADR-0021）

### 5.1 API

```
POST /api/v1/leads/convert
{
  "items": [
    {
      "lead": "<lead_id>",
      "converted_status": "qualified",
      "account": { "id": "<既存の取引先>" } | { "create": true },
      "contact": { "id": "<既存の取引先責任者>" } | { "create": true },
      "opportunity": { "create": true, "name": "2026 年度 新規" } | { "create": false },
      "owner": "<利用者の ID>",
      "row_version": 7
    }
  ],
  "all_or_none": false
}
```

- 1 回の要求は 50 件まで。1 件の変換は、1 つの**変換の単位**で、全部か無しかにする。`all_or_none = true` なら要求の全体を 1 つのトランザクションにする。`false` なら、単位ごとにセーブポイントを取り、失敗した単位だけを巻き戻す（[metadata-and-runtime.md](metadata-and-runtime.md) の 6.3 節と同じ考え方）。
- 本家の 1 回の上限は、公開の資料に見当たらない（未検証。E5 の `lead-conversion` で試用の組織で確かめる）。本システムは、1 件で DML が 4〜6 回（作成 3、リードの更新 1、活動の付け替え）になるので、DML の 150 回（ADR-0005）の中に収まる 50 件にする。
- 画面の「変換」も同じ API を使う。

### 5.2 手順

1 つの変換の単位は、次の順で行う。各レコードの作成・更新は、通常の DML の手順（ADR-0008 の 1〜8）を通る。共有の評価（手順 10）と outbox（手順 11）は、最上位の要求の最後に 1 回だけ行う。

| # | 手順 | 失敗した時 |
| --- | --- | --- |
| 1 | リードを `FOR UPDATE` で読む。`row_version` を比べる。`is_converted` が真なら断る | 409 `LEAD_ALREADY_CONVERTED`、409 `CONFLICT` |
| 2 | 権限：`convert_leads` のシステムの権限、リードの `edit` の水準、取引先・取引先責任者・商談の `create`（作る時）か、既存のレコードの `edit` の水準 | 403 `INSUFFICIENT_ACCESS`、404 |
| 3 | `converted_status` が変換済みの値か確かめる | 400 `INVALID_VALUE` |
| 4 | 所有者：リードの所有者がキューなら `owner` を必須にする。指定がなければリードの所有者 | 400 `REQUIRED_FIELD_MISSING` |
| 5 | 取引先：作るなら、対応の表（5.3 節）で値を作って作成する。既存なら、空の項目だけに値を入れて更新する | 通常の DML のエラー（入力規則、重複の規則など） |
| 6 | 取引先責任者：5 と同じ。`account` を手順 5 の取引先にする。既存の取引先責任者が別の取引先に属していたら断る | 400 `CONTACT_ACCOUNT_MISMATCH` |
| 7 | 商談：作るなら、`account` を手順 5 の取引先にし、`stage` をフェーズの既定の値にする。商談の取引先責任者の役割を 1 件（主）作る | 通常の DML のエラー |
| 8 | リードの活動・メールの `who` を取引先責任者に、`what` が空なら商談（作らなければ取引先）に付け替える | 通常の DML のエラー |
| 9 | リードを更新する：`is_converted`、`converted_*`、`converted_at`、`status`。この更新だけは「変換済みは読むだけ」の検査の外で行う | — |
| 10 | 変換の記録（`lead_conversions`）を書く | — |

- 手順 5〜9 の保存の後のフローは、通常どおり動く。フローは `lead_conversions` の行と、リードの `is_converted` を見て、変換の途中の保存かを判断できる。
- 重複の規則（6 節）は、手順 5・6 の作成にも効く。止める設定の規則に当たれば、その変換の単位を失敗にし、重複の候補（見られるものだけ）を返す。画面は、候補の既存のレコードを選んで変換し直す流れを出す。
- 変換を元に戻す操作は持たない（本家の資料にも戻す操作の記述はない。変換済みのリードは読むだけになる。2 節）。誤った変換は、できたレコードの削除と、リードの `edit_converted_leads` での直しで扱う。

### 5.3 項目の対応

| 対応 | 持ち方 |
| --- | --- |
| 標準の項目 | システムの固定の表（例：`company` → 取引先の `name`、`company_kana` → `name_kana`、`corporate_number` → `corporate_number`、`last_name` → 取引先責任者の `last_name`、住所 → 取引先の `billing_*` と取引先責任者の `mailing_*`） |
| カスタム項目 | `lead_convert_mappings(org_id, lead_field_id, target_object, target_field_id)`。メタデータで、バージョンを上げて変える |
| 商談の作成の既定 | `lead_convert_settings.opportunity_creation`：`optional`・`required`・`hidden`（MDAPI の VisibleOptional・VisibleRequired・NotVisible に寄せる） |

- 対応の保存の時に、型が合うこと（同じ型か、[metadata-and-runtime.md](metadata-and-runtime.md) の 5.1 節で変換できる型）と、1 つの先の項目に 2 つの元が向かないことを検査する。
- 変換する人が、元の項目を読めない、または先の項目を編集できない時は、その項目を写さない（黙って落とす）。変換を失敗にすると、FLS の細かい違いで営業の業務が止まるため。落とした項目は、応答の `skipped_fields` に項目の名前だけを返す（値は返さない）。
- 既存のレコードへの変換では、先の項目が空の時だけ写す（本家に合わせる。2 節）。

## 6. 重複の規則と照合（ADR-0022）

### 6.1 形

```
duplicate_rule
 ├─ object、sort_order、active
 ├─ on_create: allow_alert | allow_report | allow_alert_report | block | off
 ├─ on_update: 同上
 ├─ sharing: enforce（既定）| bypass
 ├─ condition：数式（分類 A）。当てはまるレコードだけを調べる
 └─ matching_rules（3 つまで）
      └─ matching_rule（対象のオブジェクト。別のオブジェクトも可：リード ↔ 取引先責任者）
           ├─ items（10 まで）：field、method、blank（null_not_allowed | match_blanks）、threshold
           └─ logic：「(1 AND 2) OR 3」
```

照合の方法（`method`）：

| 方法 | 正規化（6.2 節） | 候補の引き方（ブロッキング） | 判定 |
| --- | --- | --- | --- |
| `exact` | 共通の正規化 | 正規化した値の等価 | 等価 |
| `person_name` | 共通＋カナの統一＋異体字 | カナの読みの項目があれば、正規化したカナの先頭 2 文字。なければ漢字の姓の等価 | カナの Jaro-Winkler ≥ `threshold`（既定 0.92）。カナがない時は、正規化した漢字の等価 |
| `company_name` | 共通＋法人格の除去＋カナの統一＋異体字 | 法人格を除いた値の先頭 3 文字（カナの項目があればカナ） | Jaro-Winkler ≥ 0.90。`corporate_number` が両方にあれば、それが一致した時だけ一致（不一致なら一致しない） |
| `phone` | 数字だけ。`+81` を `0` に | 下 8 桁 | 数字の全体の等価 |
| `email` | 小文字、前後の空白を除く | 等価 | 等価 |
| `postal_code` | 数字だけ（7 桁） | 等価 | 等価 |
| `address` | 共通＋丁目・番地・号の数字の統一（「1丁目2番3号」「1-2-3」を同じに） | 郵便番号との組 | 正規化した値の等価 |

- 本家の照合の方法（名、姓、会社名、電話、市区町村、番地、郵便番号、役職。MDAPI）に寄せつつ、日本の名前はカナの読みで照合する。漢字から読みを推定する形態素の解析は、MVP では持たない（辞書の保守と誤りの説明が重い）。カナの項目の入力を画面で促す。
- 1 つのレコードで調べる候補は、照合の規則ごとに 200 件まで。超えたら、その規則は「照合できない」とし、保存は通す。重複の記録に `overflow` として残す。

### 6.2 日本語の正規化

正規化は TypeScript の 1 つの関数 `normalizeForMatch(method, value)` で行い、保存・照合の鍵・評価器で共有する。[data-storage.md](data-storage.md) の 3.2 節の文字列の正規化（NFKC、小文字）の上に、次を足す。

| 段 | 内容 | 例 |
| --- | --- | --- |
| 1 | NFKC（半角カナ → 全角、全角英数 → 半角） | `ｶﾌﾞｼｷｶﾞｲｼｬ` → `カブシキガイシャ` |
| 2 | 小文字 | `ACME` → `acme` |
| 3 | ひらがな → カタカナ | `やまだ` → `ヤマダ` |
| 4 | 長音と横線の統一（`ー`、`－`、`―`、`‐`、`-`、`ｰ` → `ー`。カナの後ろの時だけ） | `コーヒ－` → `コーヒー` |
| 5 | 空白・中黒・記号の除去（`・`、`、`、`.`、`,`、括弧） | `山田　太郎` → `山田太郎` |
| 6 | 異体字の表（`髙` → `高`、`﨑` → `崎`、`齋`・`齊` → `斎`、`邊`・`邉` → `辺`、`澤` → `沢`、`濱` → `浜`、`廣` → `広` など）。表はシステムで持ち、組織は足せる | `髙橋` → `高橋` |
| 7（会社名だけ） | 法人格の除去：`株式会社`、`(株)`、`㈱`、`有限会社`、`(有)`、`合同会社`、`一般社団法人`、`inc`、`co`、`ltd`、`llc`、`corp` など。前後どちらでも | `株式会社例示商事` → `例示商事` |
| 8（カナだけ） | 小さなカナを大きく（`ァ` → `ア`、`ッ` → `ツ`）、濁点を保つ | `キャノン`・`キヤノン` → 同じ鍵 |

- 段 8 は、カナの表記の揺れ（拗音・促音の大小）を吸収する。誤って一致する組が増えるので、`person_name`・`company_name` の鍵にだけ使い、`exact` には使わない。
- 正規化は冪等にする（性質ベーステスト）。

### 6.3 照合の鍵の表

```sql
CREATE TABLE record_match_keys (
  shard_no   smallint NOT NULL,
  org_id     uuid     NOT NULL,
  object_id  uuid     NOT NULL,
  rule_id    uuid     NOT NULL,     -- 照合の規則
  item_no    smallint NOT NULL,
  block_key  text     NOT NULL,     -- 候補を引く鍵（6.1 節の「候補の引き方」）
  record_id  uuid     NOT NULL,
  PRIMARY KEY (org_id, rule_id, item_no, block_key, record_id, shard_no)
) PARTITION BY LIST (shard_no);
CREATE INDEX ON record_match_keys (org_id, record_id);
```

- 鍵は、ピボットの表と同じく、純粋な関数 `deriveMatchKeys(ruleSegment, record)` でレコードとメタデータから決め、保存の手順 6 で同じトランザクションで差分を書く（[ADR-0012](../decisions/0012-derived-copies-consistency-and-projections.md) と同じ考え方）。整合の検査の対象にも入れる。
- 照合の規則を有効にする時は、Worker が 1 万件の範囲ごとに鍵を作る（`building`）。作り終えるまで、規則は重複の規則で使えない（Setup に「準備中」と出す）。共有のルールのバージョン（[sharing-and-record-access.md](sharing-and-record-access.md) の 7.2 節）と同じ流れにする。
- ごみ箱の間のレコードの鍵は消す（ピボットの索引と同じ。[data-storage.md](data-storage.md) の 5.1 節）。

### 6.4 保存の手順 5 での判定

1. 塊（200 件）の各レコードについて、当てはまる重複の規則を `sort_order` の順に集める。
2. 規則の照合の規則ごとに、`block_key` の等価で候補の ID を引く。塊の中の同じ鍵の他のレコードも候補にする（同じ要求で重複を 2 件作るのを見つけるため）。
3. 候補のレコードを読み、評価器で項目ごとの一致を判定し、`logic` で結ぶ。
4. `sharing = enforce` なら、候補を保存する人の水準で `read` 以上のものに絞る（共有の領域の判定を、候補の ID に対して 1 回の問い合わせで行う）。
5. 結果の表（DT-DUP-001）で動作を決める。

**DT-DUP-001：重複の規則の動作**

| # | 設定の動作 | 一致（絞った後） | 要求の `allow_duplicates` | 結果 |
| --- | --- | --- | --- | --- |
| 1 | `off` | - | - | 保存する |
| 2 | - | なし | - | 保存する |
| 3 | `block` | あり | - | 400 `DUPLICATE_DETECTED`。見られる一致だけを返す |
| 4 | `allow_alert`・`allow_alert_report` | あり | なし | 400 `DUPLICATE_DETECTED`（警告）。見られる一致を返す |
| 5 | `allow_alert`・`allow_alert_report` | あり | 真 | 保存する。`allow_alert_report` なら重複の記録を書く |
| 6 | `allow_report` | あり | - | 保存する。重複の記録を書く |

- `allow_duplicates` は、REST の本文の `options.allow_duplicates`（本家の `allowSave` に相当。MDAPI）。名前に本家の識別子を使わない。
- 手順 5 の照合で使った問い合わせと読んだ行は、トランザクションの上限に数える。
- 一括の取り込み（bulk-and-import の領域）は、同じ判定を塊ごとに行う。

### 6.5 共有と重複（見えないレコードの扱い）

| `sharing` | 見えないレコードとの一致 | 本家 |
| --- | --- | --- |
| `enforce`（既定） | 無いものとして扱う。止めない、知らせない、記録しない | 同じ（MDAPI の EnforceSharingRules） |
| `bypass` | `block` の時は止める。返す一致は見られるものだけで、見えない一致は件数も返さず「表示できない重複があります」とだけ返す。`allow_*` の時は、見えない一致を無いものとして扱い、記録だけ書く | 本家は共有を無視する（MDAPI の BypassSharingRules）。返す内容の細部は未検証（E5 の `matching-and-duplicate-rules` で確かめる） |

- `bypass` は、見えないレコードの存在を 1 ビット漏らす（止められたことから、同じ値のレコードがあると分かる）。`customize_application` を持つ管理者が、Setup で警告を読んで選んだ時だけ有効にし、監査に残す。
- 重複の記録（`duplicate_record_sets`、`duplicate_record_items`）は、共有の判定の対象のオブジェクトにする。見る人が見られる項目の行だけを返す。

## 7. 商談・リードの周辺の規則

- 取引先の所有者の変更で、子の商談・取引先責任者の所有者を一緒に変える選択肢を、所有者の変更の API に持つ（`cascade_owner: ["opportunity", "contact"]`、自分が所有する子だけ・全て）。本家の同様の選択肢の細部は未検証（E5 の `accounts-and-contacts` で確かめる）。子の所有者の変更は、それぞれ通常の DML（手動の共有は消える。共有の領域の 5.3 節）。
- 完了した商談（`is_closed`）の `amount`・`close_date` の変更を止めるかは、組織の入力規則に任せる。システムでは止めない。
- リードの割り当て（本家の割り当てのルール）は、MVP では持たない。保存の前のフローでキューや所有者を決める（[automation-flows.md](automation-flows.md)）。

## 8. メールの記録と送信

### 8.1 記録（BCC の宛先）

```
利用者の送るメール（BCC: <token>@log.<org>.<brand>.<domain>）
      │
      ▼
SES の受信 → S3（暗号化）→ SQS → Worker
      │ 1. 宛先の token から (org, 利用者) を決める。未知なら捨てる
      │ 2. 差出人が利用者の登録のアドレスか、SPF・DKIM が通るかを確かめる。通らなければ隔離
      │ 3. Message-ID で重複を捨てる
      │ 4. To・Cc のアドレスを、利用者が見られる取引先責任者・リードの email と照合する（6.2 節の email の正規化）
      ▼
email_message を作る（who は最初の一致、残りは activity_relations。what は空）
一致なし → 利用者の「未処理のメール」（email_message の owner＝利用者、who・what 空）
```

- token は利用者ごとの 128 ビットの乱数で、利用者は Setup で作り直せる（古い token は 7 日で無効）。宛先のドメインは組織ごとにし、`<brand>` の名前で書く（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- 照合と作成は、その利用者の権限（FLS と共有）で行う。見えない取引先責任者には付けない。
- 本文は 1MB まで `record_long_texts` に、添付は 1 通 25MB まで S3 に置く。超えたら本文を切り、添付を落として記録する。
- 記録したメールは通常のレコードなので、レポートとリストビューに出る。本家の一部の機能のように外の置き場に持たない（2 節）。

### 8.2 送信（1 通ずつ）

- レコードの画面から 1 通ずつ送る。送信は確定の後に outbox からメールの送信事業者へ渡す（手順 13。events-and-integrations の領域）。送ったメールは `email_message`（`direction = outbound`）として同じトランザクションで記録する。
- 宛先の取引先責任者・リードの `email_opt_out` が真なら、送信を 400 `EMAIL_OPTED_OUT` で断る。
- 開封の計測（画像の埋め込み）とリンクの計測は、MVP では持たない。端末の情報を外へ送る仕組みになり、法務の L4 の結論が要るため。
- 一括のメールは MVP の後（法務の L8）。

## 9. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| 照合の鍵の作成（`building`）が止まる | 範囲ごとに冪等なので再開で続ける。規則は有効にならないまま。24 時間を超えたら警告 |
| 照合の鍵と `records` がずれる | 整合の検査（[data-storage.md](data-storage.md) の 6 節）で直す。ずれの間は重複を見逃しうる（保存は止めない） |
| 候補が 200 件を超える（よくある名前） | その規則は照合しない。`duplicate_match_overflow_total` を数える。規則の見直しを管理者に勧める |
| リードの変換の途中で上限を超える | その変換の単位を巻き戻す。`all_or_none = false` なら他の単位は続ける |
| メールの受信の Worker が止まる | S3 と SQS に残るので再開で続ける。SQS の滞留が 15 分を超えたら警告 |
| 差出人の検査に落ちるメールが多い | 隔離に入れ、利用者に知らせる。なりすましの試みとして数える |

## 10. セキュリティ

- 重複の規則の既定は `enforce` にし、見えないレコードの存在を漏らさない（6.5 節）。`bypass` の選択は監査に残す。
- 重複の応答・変換の応答・メールの照合の結果に、見えないレコードの ID・名前・件数を入れない。
- 活動の共有は、追加の関係者で広げない（4 節）。広げると、取引先責任者を 1 人見られるだけで、その人に関する他人の活動が見えるため。
- リードの変換で FLS を満たさない項目は写さず、値を応答に入れない（5.3 節）。
- BCC の token は秘密として扱い、ログに出さない。差出人を検査し、他人になりすました記録を防ぐ（8.1 節）。
- テストのデータに、実在の会社名・人名・メールアドレス・電話番号・法人番号を使わない（AGENTS.md）。正規化の例の文字列も、生成したものか一般の語にする。
- `security:sensitive` の対象：活動の共有の条件（DT-ACT-001）、重複の規則の共有の絞り込み、メールの受信の差出人の検査。

## 11. テスト

- 決定表：`DT-ACT-001`（活動の水準）、`DT-DUP-001`（重複の規則の動作）、リードの変換の失敗の表（5.2 節）、6.5 節の共有と重複の表を、spec から読み込む表駆動テストにする。
- 性質ベーステスト（fast-check）：
  - 正規化は冪等で、6.2 節の各段の揺れだけが違う文字列は同じ値になる。
  - 任意の操作の列で、`record_match_keys` が `deriveMatchKeys` で全件を作り直したものと一致する。
  - 任意のレコードの組で、照合の鍵で引いた候補による判定が、全件を評価器で総当たりした判定と一致する（ブロッキングで取りこぼさない。候補の上限の内側で）。
  - 任意の活動・親・所有者・共有の操作の列で、活動の水準が、DT-ACT-001 をそのまま書いた参照の評価器と一致する（共有の領域の `PROP-SHR-001` の拡張）。
  - 任意のリードと変換の指定で、変換は全部か無しか（失敗した単位のレコードがどこにも残らない）。
- 経路ごとの否定側のテスト：見えない取引先責任者との重複が、応答・重複の記録・レポートに出ない（`enforce`）。見えない一致の件数が `bypass` の応答に出ない。追加の関係者だけの活動が見えない。
- 上限の試験：変換 50 件で通り 51 件で拒否。照合の規則の数（5）、重複の規則の照合の規則（3）、項目（10）、候補 200 件。
- 結合テスト：BCC の受信から記録まで（差出人の検査の失敗、Message-ID の重複、一致なし）。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0021](../decisions/0021-lead-conversion-and-activity-parents.md) | リードの変換を 1 つのトランザクションの合成の DML にし、各レコードは通常の DML の手順を通す。活動は多態の参照を持ち、主の親 1 つの水準と、割り当てられた本人の水準の強い方で共有を決める |
| [0022](../decisions/0022-duplicate-rules-and-japanese-matching.md) | 重複の照合は、同じトランザクションで書く正規化した照合の鍵で候補を引き、評価器で判定する。日本語は NFKC・カナの統一・長音・異体字・法人格の除去で正規化し、読みの推定はしない。見えないレコードとの重複は既定で知らせない |

他の領域への依頼（この文書では決めず、各領域の文書の更新を待つ）：

- 共有の領域：DT-SHR-001 に「活動の割り当て」の行を足す（4 節）。システムの権限に `convert_leads`・`edit_converted_leads` を足す。（2026-09-28 に反映済み：DT-SHR-001 の行 3、sharing-and-record-access.md の 3.2 節）
- metadata-and-runtime の領域：項目の型に `polymorphic_lookup` を足す。`md_picklist_values.attrs` を足す。`md_objects.allow_activities` を足す。
- data-storage の領域：`records.parent_id` の意味を「1 本目の主従の親、または活動の主の親」に広げる。`record_match_keys` を分割の表と整合の検査の対象に足す。

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：`DT-ACT-001`・`DT-DUP-001` の表駆動テストの枠。正規化の性質ベーステスト |
| E2 | 組織の作成で、標準オブジェクト（取引先、取引先責任者、リード、商談、活動、メール）と既定のフェーズ・リードの状態・ToDo の状態を種から入れる |
| E3 | 項目の型 `polymorphic_lookup` と、選択リストの値の属性（`attrs`） |
| E4 | 活動の共有（DT-ACT-001）と、多態の主の親での問い合わせの条件 |
| E5 | 取引先・取引先責任者（カナ、法人番号、日本の住所）と、取引先の親の循環の検査 |
| E5 | リードと状態の値、変換済みのリードを読むだけにする規則 |
| E5 | リードの変換の API（5 節）と、項目の対応の設定、変換の画面 |
| E5 | 商談とフェーズの属性、`opportunity_history`、商談の取引先責任者の役割 |
| E5 | ToDo・行動と、`activity_relations`（50 件）、活動のタイムラインの画面 |
| E5 | 日本語の正規化の関数と異体字の表 |
| E5 | 照合の規則・重複の規則のメタデータ、`record_match_keys` と `building` のジョブ |
| E5 | 保存の手順 5 の重複の判定（DT-DUP-001）と、`allow_duplicates`、重複の記録 |
| E5 | メールの記録（BCC の受信、差出人の検査、照合、未処理のメール）。法務の L4 の確認が済むまで spec を承認しない |
| E5 | 1 通ずつのメールの送信と `email_opt_out` |
| E6 | 変換の途中の保存をフローが判断できる情報（`lead_conversions`）と、変換の保存の後のフローのテスト |
| E7 | パイプラインの推移のレポートの元（`opportunity_history`）の標準のレポートの型 |
| E9 | 一括の取り込みで、同じ重複の判定を使う（bulk-and-import の領域と結合） |
| E11 | 重複の規則の `bypass` の選択、BCC の token の作り直しの監査 |
| E12 | よくある名前の組織での候補の上限（200）の計測と、照合の時間の p95 |

## 14. 未解決の問い

- 活動を見られる人の本家の規則（割り当て・関連先・複数の関連先）が未検証（E4 の `activity-sharing` で確かめる）。本システムの規則（4 節）で本家から移る組織が困らないか。
- カナの読みの項目が空の日本語の名前を、どこまで照合するか。形態素の解析で読みを推定するか。
- 重複の規則の `bypass` を MVP に入れるか。
- 1 回のリードの変換の件数（50）は十分か。本家の値は未検証（E5 の `lead-conversion` で確かめる）。
- 取引先責任者に `controlled_by_parent` を選べるようにするか（本家は選べる）。
- 取引先の所有者の変更で子の所有者も変える選択肢の既定。
- メールの記録で、Cc の宛先のうち社内の利用者を照合から外すか。

### 決定

2026-09-28 の既定案。

- 活動は 4 節の規則で作る。移行の文書に本家との違いの可能性を書き、E5 で本家の試用の組織で確かめる。
- 読みの推定はしない。画面でカナの入力を促し、カナが空の時は漢字の正規化した等価で照合する。要望と誤りの率を見て、MVP の後に検討する。
- `bypass` は入れるが、管理者の明示の選択と警告と監査を条件にする。
- 変換は 50 件で作り、E12 の上限の試験で DML の数を測って見直す。
- 取引先責任者の `controlled_by_parent` は持たない。取引先の暗黙の共有で足りる。要望が出たら、参照の親に連動する共有として共有の領域で扱う。
- 所有者の変更の子への連鎖は、既定を「自分が所有する子だけ」にする。
- 社内の利用者（組織の利用者の email）は照合から外す。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：活動の共有の誤りによる情報の漏えい。DT-ACT-001、性質ベーステスト、経路ごとの否定側のテスト。
- リスク：重複の判定で見えないレコードの存在が漏れる。6.5 節の表を否定側のテストにする。
- リスク：正規化の誤りによる重複の見逃し・誤った一致。正規化の性質ベーステストと、生成したカナ・漢字の揺れのコーパスでの一致の率の計測。
- リスク：リードの変換の半端な状態。全部か無しかの性質ベーステスト。
- 上限の試験：変換 50 件、照合の規則・重複の規則・項目・候補の数。
- 本番での検証：`duplicate_match_overflow_total`、照合の鍵の整合の検査の差の件数 0。

**runbooks**

- `match-keys-building-stuck`：照合の鍵の作成が 24 時間を超えた。
- `duplicate-overflow-high`：候補の上限を超える照合が多い組織への案内（規則の見直し）。
- `email-intake-backlog`：メールの受信の滞留が 15 分を超えた。
- `email-intake-spoofing`：差出人の検査の失敗が急に増えた。
- SLI の追加の依頼（Ops へ）：重複の判定の時間の p95、変換の API の p95、メールの受信から記録までの時間の p95、`duplicate_match_overflow_total`、隔離したメールの件数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `records`（標準オブジェクト） | 取引先・取引先責任者・リード・商談・活動・メール | 3 節。項目は `md_fields` |
| `md_picklist_values.attrs` | フェーズ・リードの状態・ToDo の状態の属性 | metadata-and-runtime の表への追加 |
| `opportunity_history` | `org_id`、`id`、`opportunity_id`、`changed_at`、`stage`、`amount`、`probability`、`close_date`、`forecast_category`、`changed_by`、`tx_id` | `changed_at` の月ごとの分割、RLS。商談に連動して読む |
| `activity_relations` | `org_id`、`activity_id`、`related_object_id`、`related_id`、`kind`（`who`・`attendee`）、`response` | 分割、RLS |
| `lead_convert_mappings`、`lead_convert_settings` | `org_id`、`lead_field_id`、`target_object`、`target_field_id`、`opportunity_creation` | メタデータ |
| `lead_conversions` | `org_id`、`lead_id`、`account_id`、`contact_id`、`opportunity_id`、`converted_by`、`converted_at`、`skipped_fields` | |
| `matching_rules`、`matching_rule_items` | `org_id`、`rule_id`、`object_id`、`logic`、`state`（`building`・`active`・`inactive`）、`item_no`、`field_id`、`method`、`blank`、`threshold` | メタデータ |
| `duplicate_rules`、`duplicate_rule_matchers` | `org_id`、`id`、`object_id`、`sort_order`、`on_create`、`on_update`、`sharing`、`condition`、`matching_rule_id` | メタデータ |
| `record_match_keys` | 6.3 節 | 分割、RLS、整合の検査 |
| `duplicate_record_sets`、`duplicate_record_items` | `org_id`、`set_id`、`rule_id`、`record_id`、`detected_at` | 共有の判定の対象 |
| `name_variant_chars` | `org_id`（システムの行は nil UUID）、`from_char`、`to_char` | 異体字の表 |
| `email_log_addresses` | `org_id`、`user_id`、`token_hash`、`created_at`、`expires_at` | token は hash だけ持つ |
| `email_attachments` | `org_id`、`email_message_id`、`s3_key`、`size`、`content_type` | |

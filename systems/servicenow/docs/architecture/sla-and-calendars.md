# SLA and calendars: ServiceNow

業務カレンダー（営業時間、タイムゾーン、祝日、会社の休日）、日本の祝日のデータの取り込み（内閣府の CSV、版付き）、SLA・OLA の定義（開始・一時停止・再開・停止・リセット・取り消し、さかのぼりの開始）、期限の計算（純粋な関数）、タイマーの登録、警告と違反の通知、カレンダーの変更のときの計算し直しを決める。

前提の決定は、SLA の期限をカレンダーから計算してタイマーに登録し、計時の核を純粋な関数にし、日本の祝日を内閣府の CSV から取り込んだ版付きの表にすること（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)）、そして [AGENTS.md](../../AGENTS.md) の「SLA とカレンダー」の規則（純粋な関数、性質ベーステスト、カレンダーとタイムゾーンのジェネレーター、祝日をコードに埋め込まない）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0019](../decisions/0019-business-calendar-and-pure-time-functions.md) | カレンダーは IANA のタイムゾーンの上の週の型・祝日の集合の版・会社の休日・例外の不変の版で持ち、計時は秒の単位の半開区間の上の純粋な関数 2 つで行う。祝日はその暦の日の 0〜24 時を除く。期限は「業務時間がちょうど d になる最も早い時刻」 |
| [0020](../decisions/0020-japanese-holiday-data.md) | 内閣府の CSV を月に 1 回取りに行き、内容のハッシュが変われば草案の版を作る。法の規則から求めた振替休日・国民の休日との突き合わせと人の承認を経て公開する。収録の範囲の外は祝日なしで計算し、印を付けて後で計算し直す |
| [0021](../decisions/0021-sla-definitions-and-timers.md) | SLA の定義は版付きで、計時の行は定義の版・カレンダーの版・タイムゾーンを開始の時に固定する。条件の評価は保存と同じトランザクションで、停止 ＞ リセット ＞ 取り消し ＞ 一時停止・再開の順。警告は 50%・75%、違反は 100% のタイマー。違反の事実は後の計算し直しで取り消さない |

この文書の決定表・性質は設計の草案である。ID は E5 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：カレンダーのモデルと版、計時の純粋な関数、祝日のデータの取り込みと版、SLA の定義、計時の行の状態機械、保存の時の条件の評価、期限と警告・違反のタイマー、通知の依頼、カレンダー・祝日・定義の変更のときの計算し直し、残り時間の表示。
- 扱わない：タイマーの表と取得の仕組み（[workflow-engine.md](workflow-engine.md) の 5・8 節。SLA は `priority = 0` で共有する）、通知の本文と配信（`notifications-and-email-ingest.md`）、SLA の達成率のレポート（`reports.md`）、当番表とエスカレーション（`assignment-and-on-call.md`。業務カレンダーの関数は共有する）、優先度の表（`itsm-processes.md`）。

## 2. 本家と外の資料（確かめたこと）

| 項目 | 内容 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| SLA の定義の種類 | SLA、OLA、Underpinning contract。目標は「なし」「応答」「解決」 | [Create an SLA definition](https://www.servicenow.com/docs/bundle/zurich-it-service-management/page/product/service-level-management/task/t_CreateAnSLADefinition.html) |
| 長さ | 利用者が指定する長さ、または相対の長さ（将来の日付から計算） | 同上 |
| スケジュールの取り方 | スケジュールなし（24 時間 365 日）、SLA の定義のスケジュール、タスクのフィールドのスケジュール | 同上 |
| タイムゾーンの取り方 | 呼び出し元のタイムゾーン、SLA の定義のタイムゾーン、CI の場所、タスクの場所、呼び出し元の場所 | 同上 |
| 条件 | 開始・一時停止・停止・リセット。取り消しの時点：「開始の条件を満たさなくなったとき」（既定）、「取り消しの条件を満たしたとき」、「しない」。再開の時点：「一時停止の条件を満たさなくなったとき」（既定）、「再開の条件を満たしたとき」 | 同上 |
| さかのぼりの開始 | 開始の時刻を、タスクの日時のフィールド（例：作成の時刻）にできる。さかのぼりの一時停止を選ぶと、その間の一時停止の時間も数える | 同上。さかのぼりの一時停止の説明は本家の KB（[Configure SLA retroactive start and pause](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB1605073)、検索の結果の抜粋で確認。本文は未検証） |
| 計時の更新 | 違反までの近さで分けた定期のジョブで更新する | [ADR-0004](../decisions/0004-workflow-and-sla-engine.md) の Context（未検証） |
| 祝日のスケジュール | 祝日は、除外の型の予定を持つ子のスケジュールとして、営業時間のスケジュールに付ける。毎年の繰り返しの設定がないと効かない | コミュニティの記事で確認（[SLA Schedule excluding Holidays](https://www.servicenow.com/community/sysadmin-forum/sla-schedule-excluding-holidays/m-p/2530767)）。公式の文書は未検証 |
| 警告の既定 | 50%・75%・100% で通知する既定のフロー | 未検証（公式の文書で確かめられなかった） |
| 日本の祝日の CSV | 内閣府が「昭和 30 年（1955 年）から令和 9 年（2027 年）国民の祝日（csv 形式）」を公開。翌々年の分（令和 10 年）は前年の 2 月に掲載する | [国民の祝日について](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html) |
| CSV の形 | `https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv`。Shift_JIS、見出し「国民の祝日・休日月日,国民の祝日・休日名称」、日付は `YYYY/M/D`（0 で埋めない）。振替休日と国民の休日は、どちらも名称が「休日」（例：`2026/5/6,休日`（振替）、`2026/9/22,休日`（国民の休日））。取得の時点で 21,538 バイト、更新の日時は 2026-02-02 | CSV を取得して確認 |
| 振替休日・国民の休日 | 祝日が日曜日に当たるときは、その日の後で最も近い祝日でない日を休日とする（第 3 条第 2 項）。前日と翌日が祝日である祝日でない日は休日とする（第 3 条第 3 項） | [国民の祝日について](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html) |
| CSV の利用の条件 | ページに利用の条件の記載がない | 同上。未検証（政府標準利用規約が適用されるかは確かめられなかった） |
| ITIL 4 のサービスレベル管理 | 目的は、事業に基づくサービスレベルの目標を定め、提供をそれに照らして評価・監視・管理すること。ITIL 4 は OLA・UC の区別を用語から外した | [What's New and Changed in the ITIL 4 Service Level Management Practice](https://www.beyond20.com/blog/itil-4-service-level-management-practice/)（二次の資料。PeopleCert の原典は未検証） |

- 本システムは、SLA・OLA・UC の種類を定義の属性として持つ（本家と同じ）。ITIL 4 が用語の区別を外したことは、画面の文言で「SLA」を総称に使う理由にする。種類ごとの振る舞いの違いは持たない（レポートの絞り込みにだけ使う）。
- 本家の「定期のジョブで更新する」方式は採らない（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)）。

## 3. カレンダー（[ADR-0019](../decisions/0019-business-calendar-and-pure-time-functions.md)）

### 3.1 モデル

```
Calendar（版ごとに不変）{
  time_zone: IANA の名前（例：Asia/Tokyo、America/New_York）
  weekly: [ { weekday: 1..7（月..日）, start: "HH:MM", end: "HH:MM" } ... ]
            end ≤ start のときは翌日の end まで（日付をまたぐ営業時間）
            end = "24:00" を許す
  holiday_sets: [ { set_id, version: 固定の版 | "latest" } ]    ← 国民の祝日など
  company_holidays: [ { from: "YYYY-MM-DD", to: "YYYY-MM-DD", name } ]   ← 年末年始など
  exceptions: [ { from: 現地の日時, to: 現地の日時, kind: "closed" | "open" } ]
}
none（カレンダーなし）＝ すべての時間を数える（24 時間 365 日）
```

| 表 | 列 |
| --- | --- |
| `calendar` | `tenant_id`、`id`、`stable_key`、`name`、`active_version_id` |
| `calendar_version` | `tenant_id`、`id`、`calendar_id`、`version_no`、`definition`（上の形）、`resolved_holiday_versions`（`latest` を公開の時点で解いた版の組）、`content_hash`、`published_at` |
| `holiday_set` | `id`、`tenant_id`（国民の祝日は NULL＝全テナント共通）、`source`（`jp_cabinet_office` / `tenant`）、`name` |
| `holiday_set_version` | `id`、`set_id`、`version_no`、`status`（`draft` / `published` / `retired`）、`covers_from`、`covers_to`、`source_sha256`、`fetched_at`、`approved_by`、`published_at`、`diff_summary` |
| `holiday` | `set_version_id`、`date`、`name`、`kind`（`national` / `substitute` / `citizens` / `tenant`） |

- **カレンダーの版は、祝日の集合の `latest` を公開の時点で具体的な版に解いて持つ。** 祝日の集合に新しい版が出たら、`latest` を参照するカレンダーの新しい版を自動で作る（8 節）。計時の行は、常に具体的な版の組を指す。
- テナントの作成のときの既定のカレンダー：「平日 9:00〜18:00、Asia/Tokyo、国民の祝日（`latest`）、会社の休日 12/29〜1/3」。テナントは変えられる（決定。13 節）。
- 本家の「子のスケジュールとして祝日を付け、除外の予定を持つ」形（2 節）は写さない。祝日の集合を版付きの別の表にし、カレンダーから参照する。

### 3.2 業務時間の区間

- カレンダーの意味は、UTC の時刻の上の**業務時間の区間の列**（互いに重ならず、昇順の半開区間 `[s, e)`）である。
- 区間の作り方（現地の暦の日 D ごと）：
  1. D の曜日の `weekly` の項目から、現地の `[D start, D end)`（または日付をまたぐとき `[D start, D+1 end)`）を作る。
  2. `exceptions` の `open` を足し、`closed` を引く。
  3. 祝日（祝日の集合の版の日付）と会社の休日の日付 H について、現地の `[H 00:00, H+1 00:00)` を引く。**日付をまたぐ営業時間では、祝日の日付にかかる部分だけを引く。**
  4. 現地の時刻を、IANA のタイムゾーンで UTC に直す。存在しない現地の時刻（夏時間の始まりの空白）は、空白の直後の時刻に寄せる。2 回ある現地の時刻（夏時間の終わり）は、区間の始まりは早い方、終わりは遅い方を採る（その日の営業時間の実際の長さを数える）。
  5. 重なる区間・隣り合う区間をまとめる。
- 時刻は整数の秒で扱う。入力の時刻は秒に切り捨てる（K2 の「1 秒の差もなく一致」の単位）。

## 4. 計時の関数（[ADR-0019](../decisions/0019-business-calendar-and-pure-time-functions.md)）

### 4.1 形

```ts
type Instant = number;           // UTC の Unix 秒（整数）
type Seconds = number;           // 0 以上の整数
type CompiledCalendar = {
  intervals(from: Instant, to: Instant): Iterable<[Instant, Instant]>;  // 3.2 節の区間を遅延して出す
  horizon: Instant;              // 区間を出せる最後の時刻（祝日の版の収録の範囲など。5.4 節）
};

addBusinessTime(start: Instant, d: Seconds, cal: CompiledCalendar | null): Result<Instant, CalendarError>
businessTimeBetween(from: Instant, to: Instant, cal: CompiledCalendar | null): Seconds
```

- どちらも純粋な関数で、現在の時刻・DB・キャッシュを読まない（[AGENTS.md](../../AGENTS.md)）。`CompiledCalendar` は、カレンダーの版と祝日の版から作った値で、呼び出す側が渡す。
- `cal = null`（カレンダーなし）のとき、`addBusinessTime(s, d) = s + d`、`businessTimeBetween(f, t) = max(0, t − f)`。

### 4.2 意味

- `businessTimeBetween(f, t)`：`f ≥ t` なら 0。そうでなければ、`[f, t)` と業務時間の区間の重なりの長さの合計。
- `addBusinessTime(s, d)`：
  - `d = 0` なら `s`。
  - `d > 0` なら、`businessTimeBetween(s, t) = d` を満たす**最も早い** `t`。区間の中で d を使い切ったら、その時刻（区間の終わりちょうどのこともある）を返す。次の区間の始まりへ進めない。
  - 例：営業時間 9:00〜18:00、`s` = 17:00、`d` = 1 時間 → 同じ日の 18:00。`d` = 2 時間 → 翌営業日の 10:00。
- `s` が業務時間の外なら、次の区間の始まりから数える（`businessTimeBetween` の定義から自然にそうなる）。
- 業務時間が 1 秒もないまま、`s` から 5 年先まで進んだら、`CalendarError.no_working_time` を返す（無限の探索を防ぐ）。

### 4.3 計算の方法

- 区間は、年ごとにまとめて作り、`(calendar_version_id, 年)` をキーにプロセスの中にキャッシュする（キャッシュは呼び出す側が持つ。関数の中ではない）。
- `addBusinessTime` は、区間を順にたどり、1 つの区間の長さを丸ごと引ける間は引き、最後の区間の中で残りを足す。長い d（数週間）は、週ごとの業務時間の合計で先に大きく進めてから細かくたどる（祝日の週は個別に数える）。
- 参照の実装：1 分ごと（秒の端数は別に数える）に業務時間かを判定する素朴な実装を、テストのためだけに持つ（11.2 節）。K2 の「参照の実装と 1 秒の差もなく一致」の参照はこれである。

### 4.4 カレンダーの誤り（保存の時の検証）

DT-CAL-001：

| # | 検査 | 結果 |
| --- | --- | --- |
| 1 | タイムゾーンが IANA の名前でない | 422 |
| 2 | `weekly` の時刻の書式、`start = end`（長さ 0） | 422 |
| 3 | 同じ曜日の項目が重なる | 422 `overlapping_hours` |
| 4 | 週の業務時間の合計が 0（`exceptions` の `open` もない） | 422 `no_working_time` |
| 5 | `company_holidays` の `from > to`、または 1 つの範囲が 366 日を超える | 422 |
| 6 | 参照する祝日の集合がない、または `published` の版がない | 422 |
| 7 | そのほか | 保存する（新しい版） |

## 5. 日本の祝日のデータ（[ADR-0020](../decisions/0020-japanese-holiday-data.md)）

### 5.1 取り込みの流れ

```
月に 1 回（毎月 1 日と、2 月は毎週）＋ 運用者の手動の実行
  1. CSV を取得する（HTTPS。取得の元の URL は設定に持つ。コードに埋めない）
  2. SHA-256 が最新の版の source_sha256 と同じなら終わる
  3. Shift_JIS → UTF-8、見出しの行を確かめ、行を解析する（YYYY/M/D, 名称）
  4. 検証（DT-HOL-001）
  5. 草案の版（status = draft）を作り、前の版との差分（足した日・消えた日・名称の変更）を diff_summary に入れる
  6. 運用者（Ops）に承認を依頼する（2 人目の確認。差分を見て承認する）
  7. 承認で published にする。前の版は retired にしない（固定の版を参照するカレンダーのため残す）
  8. latest を参照するカレンダーの新しい版を作り、動いている計時を計算し直す（8 節）
```

- CSV の取得の失敗（通信、404、見出しの違い）は、SEV4 で知らせ、翌日に再び試す。データを変えない。
- **祝日のデータは、コードにもテストのフィクスチャーのコードにも埋め込まない。** テストでは、取り込んだ CSV のファイルそのもの（固定の版）を読み込む（[AGENTS.md](../../AGENTS.md)）。

### 5.2 検証（DT-HOL-001）

| # | 検査 | 失敗のとき |
| --- | --- | --- |
| 1 | 見出しが「国民の祝日・休日月日,国民の祝日・休日名称」 | 取り込みを止める（`header_changed`）。形式の変更として人が調べる |
| 2 | すべての日付が正しい暦の日付、重複がない | 止める |
| 3 | 収録の年が 1955 年から切れ目なく続き、最後の年が前の版の最後の年以上 | 止める |
| 4 | 名称が「休日」の日は、法の規則（第 3 条第 2 項・第 3 項）で、名称が「休日」以外の日から求めた振替休日・国民の休日の集合と一致する | 草案にするが、承認の画面で強く示す（`rule_mismatch`）。法の改正（特例の法律による移動など）で規則だけでは決まらない日がありうるため、止めはしない |
| 5 | 取り込みの日より前の日付が、前の版から変わった（足された・消えた） | 草案にするが、承認に 2 人目を要る（`past_changed`）。過去の計時の結果に関わるため |
| 6 | 前の版より日付の数が 5% 以上減った | 止める（取得の誤りの疑い） |

- `kind` の付け方：名称が「休日」で、第 3 条第 2 項で説明できる日は `substitute`、第 3 項で説明できる日は `citizens`、どちらでもなければ `national`（名称は「休日」のまま）。計時は `kind` を使わない（すべて休み）。`kind` は画面の表示とテストのジェネレーターのために持つ。

### 5.3 テナントの祝日

- テナントは、自分の祝日の集合（`source = tenant`。創立記念日、地域の祭りの日など）を作れる。版の扱いは国民の祝日と同じだが、承認はテナントの `sla_admin` が行う。
- 海外の拠点の祝日（米国の祝日など）は、MVP ではテナントの祝日の集合として手で入れる。国ごとの公式のデータの取り込みは MVP の後（持ち越し）。

### 5.4 収録の範囲の外

- 祝日の集合の版は `covers_to`（CSV の最後の年の 12 月 31 日）を持つ。計時の関数は、`covers_to` より後の日付を「祝日なし」として計算する。
- 期限が `covers_to` を越える計時の行は、`calendar_coverage_exceeded = true` にする。翌年の分を含む新しい版が公開されたら、8 節の計算し直しの対象になる。
- 内閣府の掲載の時期（前年の 2 月）から、通常は 10 か月以上先まで収録される。`today + 10 か月 > covers_to` になったら、SEV4 で取り込みの遅れを知らせる。

## 6. SLA の定義と計時の行（[ADR-0021](../decisions/0021-sla-definitions-and-timers.md)）

### 6.1 定義

| 列 | 意味 |
| --- | --- |
| `id`、`stable_key`、`version_no`、`content_hash` | メタデータの共通の列。定義は版付き（公開で新しい版） |
| `name`、`kind`（`sla` / `ola` / `uc`）、`target`（`none` / `response` / `resolution`） | |
| `table_id` | 対象のクラス。子のクラスにも効く |
| `duration` | 業務時間の秒（MVP は長さだけ。相対の長さは持ち越し） |
| `schedule_source` | `none`（24 時間 365 日）/ `definition`（`calendar_id`）/ `task_field`（タスクの参照のフィールド。値が空なら `definition` の既定） |
| `tz_source` | `caller` / `definition` / `ci_location` / `task_location` / `caller_location`。値が取れなければカレンダーのタイムゾーン |
| `start_condition`、`pause_condition`、`stop_condition`、`reset_condition` | 式の言語の条件（保存の後の値で評価） |
| `cancel_when` | `start_not_met`（既定）/ `cancel_condition`（`cancel_condition` を持つ）/ `never` |
| `resume_when` | `pause_not_met`（既定）/ `resume_condition`（`resume_condition` を持つ） |
| `retroactive_start_field` | 日時のフィールド（空なら今） |
| `retroactive_pause` | 真なら、さかのぼった区間の一時停止も数える（6.5 節） |
| `warn_at` | 警告の割合（既定 `[50, 75]`） |
| `notify` | 警告と違反の通知の受け手（担当者、担当のグループ、グループの管理者）と通知のテンプレート |
| `active` | |

- 本家の「タイムゾーンの取り方」「スケジュールの取り方」「取り消し・再開の時点」の選択肢（2 節）に寄せた。名前は本システムのもの。
- タイムゾーンの取り方の値（利用者の `time_zone`、場所のタイムゾーン）は、開始の時に解いて計時の行に固定する（6.2 節）。
- **組み込みの定義の一時停止の既定は、[itsm-processes.md](itsm-processes.md) の 4.4 節で決めた**（統合で決めた）。SLA（インシデントの応答・解決）は、依頼者の回答待ち（`on_hold` かつ `hold_reason = awaiting_caller`）と解決（`resolved`）でだけ止める。ベンダー待ち・問題待ち・変更待ちは IT の側の都合なので、依頼者との約束を止めない。担当のグループの OLA は、ベンダー待ち（`awaiting_vendor`）でも止める。組み込みの定義は、テナントの作成の時にテナントの行として作り、テナントが変えられる（[data-model.md](data-model.md) の 3 節）。

### 6.2 計時の行

| 列 | 意味 |
| --- | --- |
| `tenant_id`、`id`、`task_id`、`sla_def_version_id` | |
| `stage` | `in_progress` / `paused` / `completed` / `cancelled` |
| `version` | 変更ごとに 1 上げる。タイマーの `target_version` と比べる |
| `calendar_version_id`（NULL は 24 時間 365 日）、`time_zone` | 開始の時に固定 |
| `start_at`、`duration` | |
| `pause_since` | `paused` のとき、一時停止の始まり |
| `paused_business`、`paused_wall` | 一時停止の累計（業務時間・実時間） |
| `planned_end` | 期限の時刻（UTC）。`paused` のときは再開までの目安として持たず NULL |
| `stop_at` | |
| `breached`、`breached_at` | 違反したか（段階とは別に持つ。違反の後も進む） |
| `breach_disputed_at` | 計算し直しで期限が後ろに動き、違反した行の新しい期限がまだ来ていないと分かった時刻（8 節）。`task_sla_event` の `breach_disputed` と同じトランザクションで入れる。レポートの分類（[reports.md](reports.md) の DT-RPT-002）はこの列で判定する。統合で足した |
| `warned_pct` | 送った警告の最大の割合 |
| `calendar_coverage_exceeded` | 5.4 節 |
| `cancel_reason` | `start_not_met` / `cancel_condition` / `reset` / `definition_deactivated` / `task_deleted` |

- `task_sla_event`：計時の行の変化（開始、一時停止、再開、停止、取り消し、リセット、警告、違反、計算し直し）を、前後の値と原因とともに追記する。監査の対象。

### 6.3 状態機械

```
     （開始の条件が真）
  ─────────────────────▶ in_progress ──一時停止の条件──▶ paused
                            │   ▲                        │
                            │   └────再開────────────────┘
                            │ 停止の条件（in_progress・paused のどちらからも）
                            ▼
                         completed
     in_progress・paused ──取り消し・リセット──▶ cancelled（リセットなら、同じ保存で新しい行を開始できる）
  breached は段階ではなく印。in_progress で期限を過ぎたときに立つ。completed・cancelled でも残る
```

### 6.4 保存の時の評価（DT-SLA-001）

保存の流れ（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 5 節の 8 段）で、タスクのクラス（祖先を含む）に合う有効な定義ごとに、保存の後の値で評価する。1 つの定義について、上から評価し、最初に一致した行を採る。時刻 `now` は保存のトランザクションの DB の時刻（秒に切り捨て）。

| # | 今の計時の行 | 停止 | リセット | 取り消し（`cancel_when` に従う） | 一時停止 | 再開（`resume_when` に従う） | 開始 | 結果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | なし | - | - | - | - | - | 偽 | 何もしない |
| 2 | なし | 真 | - | - | - | - | 真 | 何もしない（開始と停止が同時に真。記録だけ残す） |
| 3 | なし | - | - | - | - | - | 真 | 開始（6.5 節）。一時停止の条件が真なら `paused` で始める |
| 4 | `in_progress`・`paused` | 真 | - | - | - | - | - | `completed`。`stop_at = now`、タイマーを消す |
| 5 | `in_progress`・`paused` | 偽 | 真 | - | - | - | - | `cancelled`（`reset`）。開始の条件が真なら、新しい行を開始（6.5 節） |
| 6 | `in_progress`・`paused` | 偽 | 偽 | 真 | - | - | - | `cancelled`、タイマーを消す |
| 7 | `in_progress` | 偽 | 偽 | 偽 | 真 | - | - | `paused`。`pause_since = now`、タイマーを消す |
| 8 | `paused` | 偽 | 偽 | 偽 | - | 真 | - | `in_progress`。累計を足し、期限を計算し直し、タイマーを登録し直す（6.6 節） |
| 9 | - | - | - | - | - | - | - | 何もしない |

- 優先の順は、停止 ＞ リセット ＞ 取り消し ＞ 一時停止・再開（決定。13 節）。同じ保存で複数が真になっても、1 つの遷移だけを行う。
- `cancel_when = never` のとき、取り消しの列は常に偽。
- 1 つのタスクに、同じ定義の `in_progress`・`paused` の行は高々 1 つ（部分一意索引 `(tenant_id, task_id, sla_def_id) WHERE stage IN ('in_progress','paused')`）。
- 定義の新しい版の公開は、動いている行を変えない（行は開始の時の版に固定）。定義を無効にしたら、動いている行を `cancelled`（`definition_deactivated`）にする（管理者が選べば、そのまま最後まで動かす）。

### 6.5 開始

```
start_at   = retroactive_start_field の値（空・未来なら now）を秒に切り捨て
cal        = schedule_source から解いたカレンダーの active の版（なければ none）
tz         = tz_source から解いたタイムゾーン（なければ cal のタイムゾーン）
cc         = compile(cal の版, tz)            ← カレンダーのタイムゾーンを tz で置き換えて使う
paused_bus = retroactive_pause なら、[start_at, now) の間の一時停止の区間（6.5.1）の業務時間の合計、でなければ 0
planned_end = addBusinessTime(start_at, duration + paused_bus, cc)
```

- **`tz_source` のタイムゾーンは、カレンダーの営業時間を読み替えるタイムゾーンである。** 例：カレンダーが「平日 9〜18 時」で、呼び出し元がニューヨークなら、ニューヨークの 9〜18 時を数える。祝日の日付も、そのタイムゾーンの暦の日で引く。本家の意味と同じかは未検証（2 節の「タイムゾーンの取り方」から推した）。
- `planned_end` を秒で持ち、警告と違反のタイマーを登録する（7 節）。

#### 6.5.1 さかのぼりの一時停止

- `retroactive_pause` のとき、監査の履歴（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 7 節の `record_change`）から、`start_at` から今までのタスクの値の変化を読み、一時停止の条件の真の区間を求める。純粋な関数 `pauseIntervals(history, pause_condition)` にする。
- 読む履歴は 1,000 件まで。超えたら、さかのぼりの一時停止を 0 として計算し、`task_sla_event` に `retro_pause_truncated` を残す。
- 一時停止の条件が、監査から外したフィールドを使うときは、定義の保存の時に 422 にする（履歴から求められないため）。

### 6.6 一時停止と再開

```
一時停止：pause_since = now、planned_end = NULL、警告・違反のタイマーを消す
再開：    paused_business += businessTimeBetween(pause_since, now, cc)
          paused_wall     += now − pause_since
          planned_end = addBusinessTime(start_at, duration + paused_business, cc)
          警告・違反のタイマーを登録し直す（すでに過ぎた割合の警告は送らない。違反の時刻を過ぎていれば今すぐ違反のタイマー）
```

- **経過の業務時間** ＝ `businessTimeBetween(start_at, t, cc) − paused_business −（paused なら businessTimeBetween(pause_since, t, cc)）`。
- `planned_end` を毎回 `start_at` から計算し直すのは、再開のたびの丸めの誤差を溜めないためである（一時停止の区間の分け方によらない。PROP-SLA-003）。
- 残り時間の表示：画面・API は、読み取りのときに `duration − 経過の業務時間` を上の関数で計算して返す（純粋な関数なので安い）。

## 7. 警告・違反のタイマーと通知

- 開始・再開・計算し直しのとき、同じトランザクションで次のタイマーを登録する（[workflow-engine.md](workflow-engine.md) の 5.1 節の `timer`、`priority = 0`）。
  - 警告：`warn_at` の各 p について、`addBusinessTime(start_at, ⌈duration × p / 100⌉ + paused_business, cc)`。すでに `warned_pct ≥ p` なら登録しない。
  - 違反：`planned_end`。
  - `target_version` は計時の行の `version`。
- 発火のトランザクション：計時の行を `FOR UPDATE`、版がタイマーと違えば何もしない。同じなら、警告は `warned_pct = p`、違反は `breached = true`・`breached_at = due_at`（発火の時刻ではなく期限の時刻）、`task_sla_event`、outbox（`sla.warning` / `sla.breached`。通知とフローのトリガーが使う）を書き、タイマーを消す。
- 違反の後も計時は続く（停止まで経過の時間を数える）。違反の時刻は `planned_end` で、発火の遅れの影響を受けない。
- 通知の受け手は、送る直前に受け手の主体で ACL を判定する（[access-control.md](access-control.md) の 6.2 節の 11 行）。
- NFR-003：違反の発火は期限から p99 60 秒以内。発火の遅れ（`fired_at − due_at`）を計測する。

DT-SLA-002（タイマーの発火）：

| # | 計時の行の段階 | 版 | 種類 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | `completed`・`cancelled`、または行がない | - | - | タイマーを消すだけ |
| 2 | - | タイマーと違う | - | タイマーを消すだけ |
| 3 | `paused` | 同じ | - | タイマーを消すだけ（一時停止でタイマーを消し忘れた場合の守り） |
| 4 | `in_progress` | 同じ | 警告 p、`warned_pct < p` | `warned_pct = p`、`sla.warning` |
| 5 | `in_progress` | 同じ | 警告 p、`warned_pct ≥ p` | タイマーを消すだけ |
| 6 | `in_progress` | 同じ | 違反、`breached = false` | `breached = true`、`breached_at = due_at`、`sla.breached` |
| 7 | `in_progress` | 同じ | 違反、`breached = true` | タイマーを消すだけ |

## 8. 計算し直し

| きっかけ | 対象 | 振る舞い |
| --- | --- | --- |
| 国民の祝日の新しい版の公開 | `latest` を参照するカレンダーを使う、動いている計時の行 | カレンダーの新しい版を作り、行ごとに新しい版で `planned_end` を計算し直す |
| テナントの祝日の集合・カレンダーの公開 | そのカレンダーを使う、動いている計時の行 | 同上。管理者は「新しく始まる計時だけに効かせる」も選べる（既定は動いている行にも効かせる） |
| SLA の定義の新しい版 | なし | 動いている行は開始の時の版のまま |

- ジョブが、対象の行を 500 件ずつ、行ごとのトランザクションで処理する：行を `FOR UPDATE`、`calendar_version_id` を新しい版に替え、`planned_end`・経過を計算し直し、タイマーを登録し直し、`version += 1`、`task_sla_event`（`recalculated`、前後の `planned_end` とカレンダーの版）を書く。
- **違反の事実は取り消さない。** 計算し直しで `planned_end` が後ろに動き、すでに `breached = true` の行の新しい期限がまだ来ていないとき、`breached` はそのままにし、`task_sla_event` に `breach_disputed` を残し、同じトランザクションで `breach_disputed_at` を入れる（決定。13 節）。レポートは `breach_disputed` の行を別に数えられる。
- まだ違反していない行で、新しい `planned_end` がすでに過ぎているときは、今すぐの違反のタイマーを登録する（`breached_at` は新しい `planned_end`）。
- 計算し直しのジョブは冪等である（同じカレンダーの版なら何も変えない）。途中で落ちたら、残りの行から続ける。

## 9. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Aurora の writer のフェイルオーバー | 保存と発火が数十秒止まる。復旧の後、期限の古い順に発火する。`breached_at` は `planned_end` なので、遅れても違反の時刻は正しい |
| タイマーのワーカーの遅れ（9 時の集中） | SLA のタイマーは優先度 0 で先に取る（[workflow-engine.md](workflow-engine.md) の 8.2 節）。p99 60 秒を超えたら SEV2 |
| CSV の取得の失敗・形式の変更 | 版を作らない。前の版のまま計算する。SEV4 |
| 祝日の版の誤った公開 | 前の版を「最新」に戻す新しい版を公開する（版は消さない）。計算し直しが走り、`task_sla_event` に残る |
| カレンダーの業務時間が 0 の版 | 保存の時の検証で防ぐ（DT-CAL-001）。関数は `no_working_time` を返し、計時の行は開始せず、`task_sla_event`（`calendar_error`）と管理者への通知を残す |
| 計算し直しのジョブの停止 | 行ごとのトランザクションなので、止まった行から続ける。進み具合を計測する |

## 10. セキュリティ

- SLA の定義・カレンダー・テナントの祝日の変更は `sla_admin`。国民の祝日の版の承認は、本システムの運用者（Ops）の 2 人（5.1 節）。
- CSV の取得は HTTPS で、取得の元の URL は設定で固定する。リダイレクトで別のホストに移ったら止める。
- 計時の行と `task_sla_event` は、タスクの ACL に従って読む（計時の行の `read` はタスクの `read` を要る組み込みの規則）。
- 通知は受け手ごとに判定する（7 節）。

## 11. テスト

### 11.1 決定表

- DT-SLA-001（保存の時の評価）、DT-SLA-002（タイマーの発火）、DT-CAL-001（カレンダーの検証）、DT-HOL-001（祝日の検証）を、`spec.md` から読む表駆動テストにする。

### 11.2 性質ベーステスト（fast-check）

ジェネレーター：

- タイムゾーン：`Asia/Tokyo`、`America/New_York`、`Europe/London`、`Australia/Sydney`（南半球の夏時間）、`UTC`、`Asia/Kolkata`（30 分のずれ）。
- 週の型：平日の日中、土曜の半日、日付をまたぐ夜勤（22:00〜翌 06:00）、24 時間の曜日、1 日に 2 つの区間（昼休み）。
- 祝日：固定の版の内閣府の CSV（テストのリソースのファイル）から、振替休日と国民の休日を含む年（2026 年の 5 月・9 月、2027 年の 3 月）を選ぶ。会社の休日の年末年始（12/29〜1/3）。
- 時刻：うるう年の 2 月 29 日（2028 年）、夏時間の切り替えの前後 3 時間、年の変わり目、祝日の前日の夜勤。
- 長さ：0、1 秒、区間の長さちょうど、数週間。

性質：

- **PROP-SLA-001（加算と測定が逆）**：任意の `s`・`d`・`cal` で、`businessTimeBetween(s, addBusinessTime(s, d, cal), cal) = d`。
- **PROP-SLA-002（最も早い）**：任意の `s`・`d > 0`・`cal` で、`t = addBusinessTime(s, d, cal)` とすると、`businessTimeBetween(s, t − 1, cal) < d`。
- **PROP-SLA-003（単調）**：`d1 ≤ d2` なら `addBusinessTime(s, d1) ≤ addBusinessTime(s, d2)`。`t1 ≤ t2` なら `businessTimeBetween(s, t1) ≤ businessTimeBetween(s, t2)`。
- **PROP-SLA-004（一時停止の分け方によらない）**：任意の開始・停止の時刻と、一時停止の区間の任意の分割（同じ合計の区間を細かく分ける、隣り合う区間をつなぐ）で、6.6 節の式の経過の業務時間と `planned_end` は同じ。
- **PROP-SLA-005（休みは数えない）**：任意の `f`・`t` で、`[f, t)` が祝日・会社の休日・営業時間の外だけにあれば `businessTimeBetween(f, t) = 0`。
- **PROP-SLA-006（加法）**：`f ≤ m ≤ t` なら `businessTimeBetween(f, t) = businessTimeBetween(f, m) + businessTimeBetween(m, t)`。
- **PROP-SLA-007（参照の実装と一致）**：任意の入力（長さは 30 日以下）で、2 つの関数の結果は、4.3 節の素朴な参照の実装と秒で一致する（K2）。
- **PROP-SLA-008（決定性）**：同じ入力で、何度・どのプロセスで・どの時刻に呼んでも同じ結果（関数が現在の時刻を読まないことの確かめ。実行の時計を任意にずらして比べる）。
- **PROP-SLA-009（評価の 1 回）**：任意の保存の列（条件の真偽の任意の組）で、DT-SLA-001 の後の計時の行は、同じ定義で動いている行が高々 1 つで、`task_sla_event` の列を順に適用すると今の行になる。
- **PROP-SLA-010（計算し直しの冪等）**：同じカレンダーの版で 2 回計算し直しても、2 回目は何も変えない。
- **PROP-HOL-001（法の規則）**：固定の版の CSV の、名称が「休日」以外の日から第 3 条第 2 項・第 3 項で求めた集合は、名称が「休日」の日の集合と一致する（DT-HOL-001 の 4 行の検査が正しいことの確かめ）。

### 11.3 障害注入（workflow-engine と共有）

- 違反のタイマーの発火のトランザクションのコミットの直前・直後でプロセスを落とし、`sla.breached` がちょうど 1 回だけ outbox に入ることを確かめる。
- 一時停止の保存と、違反のタイマーの発火を同時に起こし、どちらの順でも最終の状態が DT-SLA-001・002 と合うことを確かめる。
- 計算し直しのジョブを途中で落とし、再開の後にすべての行が新しい版になり、二重の `recalculated` がないことを確かめる。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E5 | `business-time-functions` | 3.2・4 節、参照の実装（PROP-SLA-001〜008） |
| E5 | `calendar-model-and-versions` | 3.1 節、DT-CAL-001、既定のカレンダー |
| E5 | `jp-holiday-import` | 5.1・5.2 節、DT-HOL-001（PROP-HOL-001）、承認の画面 |
| E5 | `tenant-holiday-sets` | 5.3 節 |
| E5 | `sla-definition-model` | 6.1 節、定義の版 |
| E5 | `task-sla-evaluation-in-save` | 6.2〜6.6 節、DT-SLA-001（PROP-SLA-009） |
| E5 | `sla-retroactive-pause` | 6.5.1 節 |
| E5 | `sla-timers-and-notifications` | 7 節、DT-SLA-002 |
| E5 | `sla-recalculation-job` | 8 節（PROP-SLA-010） |
| E5 | `sla-remaining-time-api` | 残り時間の表示の API と画面の部品 |
| E5 | `holiday-coverage-monitor` | 5.4 節の監視 |
| E5 | `business-time-wait` | フローの業務時間の待ち（workflow-engine と一緒に） |
| E6 | `incident-default-slas` | インシデントの既定の定義（優先度ごとの応答・解決） |
| E11 | `sla-attainment-report` | 達成率、`breach_disputed` の扱い（`reports.md` と一緒に） |
| E12 | `timer-burst-load-test` | 200 万件の計時と 9 時の集中の負荷試験、フェイルオーバーでの発火の遅れの計測（workflow-engine・capacity と同じ Story） |

## 13. 未解決の問い

### 決定（2026-09-28、既定案）

- **祝日は、その暦の日の 0〜24 時を除く**：日付をまたぐ夜勤でも、祝日の日付にかかる部分だけを引く（3.2 節、ADR-0019）。
- **期限は「業務時間がちょうど d になる最も早い時刻」**：区間の終わりで使い切ったら次の区間へ進めない（4.2 節）。
- **時刻は整数の秒**（3.2 節）。
- **既定のカレンダーは平日 9〜18 時、Asia/Tokyo、国民の祝日、12/29〜1/3**（3.1 節）。
- **条件の優先は停止 ＞ リセット ＞ 取り消し ＞ 一時停止・再開**（6.4 節、ADR-0021）。
- **`tz_source` のタイムゾーンで、カレンダーの営業時間を読み替える**（6.5 節）。
- **警告の既定は 50%・75%**（6.1 節）。
- **違反の事実は計算し直しで取り消さず、`breach_disputed` を残す**（8 節）。
- **収録の範囲の外は祝日なしで計算し、印を付けて後で計算し直す**（5.4 節、ADR-0020）。
- **祝日の版の公開は運用者 2 人の承認**（5.1 節）。
- **一時停止の既定：SLA は依頼者の回答待ちだけ、OLA はベンダー待ちでも止める**（6.1 節、[itsm-processes.md](itsm-processes.md) の 4.4 節。統合で決めた）。
- **`task_sla.breach_disputed_at` の列を足す**（6.2・8 節。統合で決めた）。
- **法の規則との不一致は止めずに強く示す**（DT-HOL-001 の 4 行）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 相対の長さ（「翌営業日の 12 時まで」） | E5 の後。顧客の要望を見て |
| 海外の祝日の公式のデータの取り込み | 海外のリージョン（S3）の前 |
| 内閣府の CSV の利用の条件（政府標準利用規約の適用の有無）と、取得の元の変更の通知の受け方 | 法務の確認待ち（[intent.md](../intent.md) の L9）。E5 の `jp-holiday-import` の着手の前に、PM が内閣府の問い合わせの窓口で確かめ、法務が判断する |
| `breach_disputed` を契約の SLA のレポートでどう扱うか | E11 で PM が決める |
| タイマーの 9 時の集中での発火の遅れの実測 | E12 の `timer-burst-load-test` |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 違反の発火の遅れ（`fired_at − planned_end`）の p50・p99（K2、NFR-003）。
- 参照の実装との不一致の件数（性質ベーステストと、本番の抜き取りの再計算）：0 件。
- 計算し直しの件数と、`breach_disputed` の件数。
- `calendar_coverage_exceeded` の行の数と、祝日の収録の残りの月数。
- 祝日の取り込みの結果（取得の成否、`rule_mismatch`・`past_changed` の件数）。
- SLA の達成率（テナント別・定義別。E11 のレポートと同じ数え方）。

### runbooks

- `holiday-import.md`：祝日の CSV の取り込みの確かめ方、差分の見方、承認と公開、誤った公開の戻し方（前の内容の新しい版）。
- `sla-breach-lag.md`：違反の発火の遅れの警告の確かめ方（タイマーの取得、DB の負荷、優先度）。
- `sla-recalculation.md`：計算し直しのジョブの進み具合の確かめ方と、止まったときの再開。
- `calendar-misconfiguration.md`：テナントのカレンダーの誤り（業務時間 0、タイムゾーンの誤り）で計時が始まらないときの対応。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `calendar`、`calendar_version` | 3.1 節。メタデータ |
| Aurora `holiday_set`、`holiday_set_version`、`holiday` | 3.1・5 節。国民の祝日は `tenant_id` が NULL の共通のデータ（RLS の例外として許可の一覧に載せる） |
| Aurora `sla_def`（版付き） | 6.1 節。メタデータ |
| Aurora `task_sla` | 6.2 節。部分一意索引 `(tenant_id, task_id, sla_def_id) WHERE stage IN ('in_progress','paused')`。`breach_disputed_at` の列を持つ |
| Aurora `task_sla_event` | 6.2 節。追記だけ、月ごとのパーティション、監査の対象 |
| Aurora `timer`（`sla_warning`・`sla_breach`、`priority = 0`） | 7 節。workflow-engine と共有 |
| S3（取り込みの元の CSV の原本、版ごと） | 5.1 節。版の `source_sha256` と対応 |

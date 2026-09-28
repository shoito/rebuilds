# Time and attendance: Workday

打刻と取り込み、打刻の訂正、客観的な記録との突き合わせ、勤務体系、労働時間の計算（法定内・法定外、深夜、休日、月 60 時間超）、36 協定の上限と警告、月次の締め、給与への連携を決める。

前提の決定は、人事のデータを 2 軸で持つこと（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）、変更は業務プロセスを通すこと（[ADR-0003](../decisions/0003-business-process-engine.md)）、給与は `known_at` を固定した入力から純粋に計算すること（[ADR-0004](../decisions/0004-payroll-engine.md)）。事業所（36 協定の単位）と「管理監督者に当たりうるか」の印は [core-hr.md](core-hr.md) にある。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0021](../decisions/0021-clock-events-corrections-and-objective-records.md) | 打刻は端末が採番した ID つきの追記のみの事象にする。端末は落ちている間 72 時間まで貯めて送る。訂正は元の打刻を消さず、`time_correction` の業務プロセスで「追加」「無効」の記録を足す。PC のログ・入退室の記録を取り込み、打刻との乖離を日ごとに検知して理由を求める。自動では直さない |
| [0022](../decisions/0022-work-schedules-and-work-hour-calculation.md) | 勤務体系は有効日付の「勤務の規則」で持ち、種類（固定、シフト、フレックス、1 か月単位の変形）と印（管理監督者、裁量労働のみなし、1 年単位の変形）を分ける。労働時間は分の整数で、日・週・期間の順に区分する純粋な関数で計算する。1 日ごとの切り捨ては持たない。端数の処理は給与の側で行う |
| [0023](../decisions/0023-overtime-agreement-monitoring-and-monthly-close.md) | 36 協定は事業所ごとの有効日付の設定で持つ。日次と退勤の打刻ごとに、実績と見込みで 6 つの上限を判定し、本人・上長・人事に段階的に警告する。月次の締めは状態機械で、確定した月の集計を版とハッシュつきで給与に渡す。締めた後の訂正は新しい版を作り、給与の遡及で扱う |

## 1. 目的と範囲

- 扱う：打刻（Web、スマートフォンのブラウザ、打刻機、一括の取り込み）、端末での一時の保存、打刻の訂正、客観的な記録（PC のログ、入退室）の取り込みと突き合わせ、勤務体系とシフト、所定の休日と法定の休日、労働時間の区分の計算、36 協定の設定と警告、月次の締めと確認、給与への連携、出勤簿の元のデータ。
- 扱わない：休暇の残日数と申請（[absence-and-leave.md](absence-and-leave.md)）、割増賃金の額と率（[payroll-jp-rules.md](payroll-jp-rules.md)）、給与の実行（[payroll-engine.md](payroll-engine.md)）、打刻の画面（[self-service-ui.md](self-service-ui.md)）、打刻機の連携の形式（[integrations-and-bulk.md](integrations-and-bulk.md)）。
- 本システムは労務の判断をしない（[intent.md](../intent.md) の Non-goals）。36 協定の締結、管理監督者の該当、裁量労働の対象の判断は企業と社労士が行う。システムは設定を受け取り、計算し、警告する。

## 2. 法令と本家の形（確かめたこと）

法令は e-Gov の法令 API で 2026-09-28 に確かめた（[労働基準法](https://laws.e-gov.go.jp/law/322AC0000000049)、[労働基準法施行規則](https://laws.e-gov.go.jp/law/322M40000100023)）。解釈の結論は出さない。

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 法定労働時間 | 1 週 40 時間、1 日 8 時間（休憩を除く） | 労基法 32 条 |
| 1 か月単位の変形 | 1 か月以内の期間を平均して週 40 時間を超えない定めで、特定の日・週に 8 時間・40 時間を超えられる | 労基法 32 条の 2 |
| フレックス | 清算期間は 3 か月以内。1 か月を超えるときは、1 か月ごとに週平均 50 時間を超えない | 労基法 32 条の 3 |
| 法定の休日 | 毎週 1 回、または 4 週 4 日 | 労基法 35 条 |
| 36 協定の限度時間 | 月 45 時間・年 360 時間（3 か月を超える 1 年単位の変形は月 42 時間・年 320 時間） | 労基法 36 条 4 項 |
| 特別条項 | 月の時間外＋休日は 100 時間未満、年の時間外は 720 時間以内、月 45 時間を超える月は年 6 か月以内 | 労基法 36 条 5 項 |
| 実績の上限 | 月の時間外＋休日 100 時間未満。2〜6 か月の平均（時間外＋休日）80 時間以内 | 労基法 36 条 6 項 |
| 研究開発の除外 | 新たな技術・商品・役務の研究開発の業務は、36 条 3〜5 項と 6 項 2・3 号を適用しない | 労基法 36 条 11 項 |
| 事業場の通算 | 労働時間は、事業場が違っても通算する | 労基法 38 条 |
| 適用の除外 | 管理監督者などは、労働時間・休憩・休日の規定を適用しない（深夜は除外されない） | 労基法 41 条 |
| 記録の保存 | 賃金その他労働関係の重要な書類を 5 年（当分の間 3 年） | 労基法 109 条、143 条 |
| 賃金台帳の時間の記入 | 労働日数、労働時間数、延長・休日・深夜の時間数。41 条の労働者は労働時間数と延長などの時間数を記入しなくてよい | 規則 54 条 |

- 厚生労働省の案内も同じ上限を示す（[時間外労働の上限について](https://www.startup-roudou.mhlw.go.jp/36_pact.html)、2026-09-28 に確認）。月 100 時間未満と 2〜6 か月の平均 80 時間には、法定の休日の労働を含む。建設・自動車の運転・医師には別の扱いがある（内容は未検証。MVP は対象にしない）。
- 労働時間の把握は、タイムカード・IC カード・PC の使用時間などの客観的な記録を基礎にする。自己申告なら、必要に応じて実態を調べて補正する。入退場や PC の記録と自己申告に著しい乖離があれば、実態調査と補正を求める（[労働時間の適正な把握のために使用者が講ずべき措置に関するガイドライン](https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/roudouzikan/070614-2.html)、検索の要約で 2026-09-28 に確認）。
- 1 日ごとに一定の時間に満たない分を一律に切り捨てることは認められない（[厚生労働省のリーフレット](https://www.mhlw.go.jp/content/11200000/001310369.pdf)の表題、2026-09-28 に確認。本文は未取得）。
- 2 暦日にまたがる勤務は始業の日の労働とする、法定の休日は暦日（0 時〜24 時）で数える、週の起算は定めがなければ日曜とする、という扱いは行政の通達によるとされるが、原本を確かめていない（未検証）。本システムは既定をこの扱いにし、テナントの設定で週の起算の曜日を変えられる。
- 本家の勤怠（Workday Time Tracking）の内部の計算の規則は、公開の資料で確かめられなかった（未検証）。設計は本家に依らない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## 3. 打刻と取り込み（[ADR-0021](../decisions/0021-clock-events-corrections-and-objective-records.md)）

### 3.1 打刻の事象

```sql
-- Raw clock events. Append-only. Never updated or deleted by the app role.
time_clock_events (
  tenant_id, id uuid /* v7, server */, employment_id,
  client_event_id uuid,            -- generated on the device; idempotency key
  kind text,                       -- clock_in | clock_out | break_start | break_end
  occurred_at timestamptz,         -- device time (or terminal time)
  received_at timestamptz,         -- server time
  source text,                     -- web | mobile_web | terminal | import | correction
  device_id, terminal_id, import_batch_id,
  location_id,                     -- workplace at the time (from worker_job)
  flags text[],                    -- late_arrival_72h, clock_skew, duplicate_kind ...
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employment_id, client_event_id))
```

- 打刻の ID（`client_event_id`）は端末が UUIDv7 で作る。同じ ID の 2 回目の送信は、最初の記録を返す（冪等）。
- 位置の情報（GPS）は MVP では集めない。打刻の場所は、端末・打刻機の登録と IP の範囲だけで示す（13 節）。
- 打刻の時刻は秒まで持つ。分への変換は計算のときに行う（5.2 節）。

### 3.2 端末での一時の保存

NFR-004 のとおり、落ちている間も打刻を失わない。

| 状況 | 振る舞い |
| --- | --- |
| API に届かない | ブラウザの IndexedDB に `client_event_id` と `occurred_at` を持って貯め、つながったら古い順に送る |
| 打刻機 | 打刻機の側で貯め、取り込みの一括で送る（形式は [integrations-and-bulk.md](integrations-and-bulk.md)） |
| `occurred_at` が受信の 72 時間より前 | 受けるが `late_arrival_72h` の印を付け、上長の確認を要する。月の締めの後なら 3.4 節の訂正に回す |
| `occurred_at` が受信より 5 分以上未来、またはオンラインで 5 分以上過去 | `clock_skew` の印。計算には使うが、月の締めで確認を要する |
| 同じ種類の打刻が続く（出勤の後にまた出勤） | 両方を残し `duplicate_kind` の印。計算は 5.1 節の規則で 1 つを採る |

- 端末の時計はずれうる。ずれの検知だけを行い、時刻を勝手に直さない。

### 3.3 客観的な記録

| 記録 | 取り込み | 使いみち |
| --- | --- | --- |
| PC のログ（ログオン・ログオフ、最初と最後の操作） | テナントの連携で日次に取り込む（`time_objective_logs`） | 打刻との乖離の検知 |
| 入退室の記録（IC カード） | 同上 | 同上 |
| 打刻機の記録 | 3.1 節の打刻そのもの | 客観的な記録として扱う |

```sql
time_objective_logs (tenant_id, id, employment_id, work_date date, source text,
                     first_seen timestamptz, last_seen timestamptz, import_batch_id, received_at)
time_divergences (tenant_id, id, employment_id, work_date, kind text,  -- start_gap | end_gap | no_clock
                  minutes int, threshold int, state text,              -- open | explained | corrected
                  reason_code, reason_text, resolved_by, resolved_at)
```

乖離の判定（DT-TIME-001。上から評価し、当たる行をすべて出す）：

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | 客観的な記録があり、打刻がない | `no_clock`。本人と上長に通知。締めの前に訂正か理由を要する |
| 2 | 最後の客観的な記録 − 退勤の打刻 ≥ しきい値（既定 30 分） | `end_gap`。理由を要する（例：私用の在社、PC の消し忘れ） |
| 3 | 出勤の打刻 − 最初の客観的な記録 ≥ しきい値 | `start_gap`。理由を要する |
| 4 | 乖離がしきい値未満 | 何もしない |
| 5 | 客観的な記録の連携がない | 何もしない。テナントの設定に「連携なし」を記録し、報告に出す |

- 乖離は自動で直さない。本人が理由を選ぶか、`time_correction` で直す。理由の区分はテナントが足せる。
- しきい値、客観的な記録をどこまで見るかは社労士の確認待ち（[intent.md](../intent.md) の L6）。
- 自己申告（打刻を使わず、始業・終業を入力する）の運用は、テナントの設定で許す。そのときは客観的な記録の連携を必須にし、乖離の検知を止められない。

### 3.4 訂正（`time_correction`）

- 打刻は消さない。訂正は `time_clock_corrections` に「追加」（打刻を足す）か「無効」（元の打刻を計算から外す）を記録する。

```sql
time_clock_corrections (tenant_id, id, employment_id, work_date, case_id,
                        action text,              -- add | void
                        target_event_id,          -- for void
                        kind, occurred_at,        -- for add
                        reason_code, reason_text, recorded_at)
```

- 訂正は `time_correction` の業務プロセスを通す。既定は本人の起票と上長の承認。上長が部下の打刻を直すときは、本人への通知を必須にする（本人の確認なしに労働時間が減る訂正を防ぐ）。
- 労働時間を減らす訂正は、理由を必須にし、月次の報告に件数を出す（監査の抜き取り）。
- 締めた月の訂正は、7 節の手順で月を開き直すか、次の月の差分にする。

## 4. 勤務体系（[ADR-0022](../decisions/0022-work-schedules-and-work-hour-calculation.md)）

### 4.1 勤務の規則

勤務の規則（`work_rules`）はテナントの設定で、版を持つ。従業員への割り当ては有効日付の facet（`employment_work_rule`）にする。

| 項目 | 内容 |
| --- | --- |
| `type` | `fixed`（固定）・`shift`（シフト）・`flex`（フレックス）・`monthly_variable`（1 か月単位の変形） |
| 所定の時刻 | 固定：始業・終業・休憩。シフト：シフトの型の一覧 |
| 1 日の所定労働時間 | 分。変形では日ごとの予定から |
| 週の起算の曜日 | 既定は日曜 |
| 法定の休日の決め方 | `fixed_weekday`（例：日曜）・`last_rest_day_in_week`（週の最後の休日）・`four_in_four_weeks`（4 週 4 日。起算日を持つ） |
| 所定の休日 | 曜日、テナントの暦の休日 |
| 深夜の時間帯 | 22:00〜5:00（厚生労働大臣の定めによる例外は持たない） |
| 変形の期間 | 1 か月以内。起算日 |
| フレックスの清算期間 | MVP は 1 か月。コアタイム・フレキシブルタイム、清算期間の総労働時間 |
| 打刻の丸め | 持たない（5.2 節） |

印（`flags`。規則ではなく、雇用の facet の項目）：

| 印 | 意味 | 計算への影響 |
| --- | --- | --- |
| `managerial` | 管理監督者として扱う（判断は企業） | 時間外・休日の区分を作らない。深夜は計算する。労働時間の状況は記録する。36 協定の集計の対象外 |
| `discretionary` | 裁量労働のみなし（MVP の外。印だけ） | 労働日の労働時間を協定のみなし時間とする。深夜と休日は実績で計算する |
| `annual_variable` | 1 年単位の変形（MVP の外。印だけ） | MVP では計算を拒み、担当に手入力を求める |
| `overtime_exempt_rnd` | 研究開発の業務（36 条 11 項） | 36 協定の上限の判定を止め、長時間の警告だけにする |

- 印の付け外しは `employment_status` と同じく業務プロセスを通し、理由を記録する。印は労務の判断の結果で、システムは正しさを判定しない（L6）。
- 「管理監督者に当たりうるか」の職務の印（[core-hr.md](core-hr.md) の 4.3 節）と雇用の `managerial` の印が食い違えば、警告を出す。

### 4.2 シフト

```sql
shift_patterns (tenant_id, id, work_rule_id, code, start_time, end_time, breaks jsonb,
                crosses_midnight bool, scheduled_minutes int)
shift_assignments (tenant_id, id, employment_id, work_date, shift_pattern_id,
                   is_rest_day bool, is_legal_holiday bool, published_at, version)
```

- シフトは月の単位で公開する。公開の後の変更は版を足し、本人に通知する。
- 変形では、期間の始まりの前に日ごとの所定を決めて公開する。期間の途中で所定を変えると、変形の要件を欠くおそれがある。システムは公開の後の変更に警告を出し、理由を求める（止めない）。

## 5. 労働時間の計算（[ADR-0022](../decisions/0022-work-schedules-and-work-hour-calculation.md)）

### 5.1 1 日の区間

1. 労働日（`work_date`）ごとに、打刻と訂正を合わせた事象の列を作る。訂正の `void` は外し、`add` は足す。
2. 勤務は始業の打刻の日に属する。日をまたいでも、次の出勤の打刻まで、または始業から 24 時間までを同じ勤務にする。
3. 出勤と退勤の組、休憩の開始と終了の組を作る。組にならない打刻は `unpaired` の問題として出し、その日の計算を「未確定」にする。
4. 休暇（[absence-and-leave.md](absence-and-leave.md)）の半日・時間単位の区間を「労働しなかったが所定内として扱う時間」として足す。休暇は労働時間ではない（36 協定と割増の対象外）。
5. 区間を暦日の 0 時と、22 時・5 時で切る。法定の休日は暦日で判定するため。

### 5.2 分への変換と丸め

- 出勤は分の切り捨て、退勤は分の切り上げで分にする。休憩の開始は切り上げ、終了は切り捨て。どの向きでも労働時間を短くしない。
- 1 日ごとの丸め（15 分単位の切り捨てなど）は持たない。テナントが望んでも設定を作らない（2 節）。
- 1 か月の合計の 30 分単位の処理（30 分未満の切り捨て、以上の切り上げ）は、行政の通達で認められているとされる（[昭和 63 年 3 月 14 日基発第 150 号の抜粋](https://jsite.mhlw.go.jp/aichi-roudoukyoku/var/rev0/0119/6636/hasuutoriatukai.pdf)、検索の要約で 2026-09-28 に確認）。この処理は賃金の計算なので、勤怠は分の整数を渡し、処理は給与の側で行う（[payroll-jp-rules.md](payroll-jp-rules.md) の 7 節）。

### 5.3 区分

出力は、労働日ごとと期間ごとの分の整数の集合にする。

| 区分 | 意味 |
| --- | --- |
| `scheduled_worked` | 所定の時間の中の労働 |
| `non_statutory_ot` | 所定を超え、法定（日 8 時間・週 40 時間、変形・フレックスでは枠）以内の労働（法定内残業） |
| `statutory_ot` | 法定を超えた労働（法定外。36 協定と割増の対象） |
| `statutory_ot_over_60` | 月の `statutory_ot` のうち 60 時間（3,600 分）を超えた分 |
| `legal_holiday_work` | 法定の休日の労働（時間外に数えない） |
| `rest_day_work` | 所定の休日（法定でない）の労働。週 40 時間の判定に入る |
| `night` | 22 時〜5 時の労働。他の区分と重なって数える |
| `leave_paid_minutes` | 有給の休暇で所定内として扱う時間 |
| `absence_minutes` | 欠勤・遅刻・早退の時間（所定 − 労働 − 休暇） |

### 5.4 手順（固定・シフト）

区分の手順（DT-TIME-002 で表にし、表駆動テストで確かめる）：

1. 法定の休日の区間はすべて `legal_holiday_work`。以下の日・週の計算から外す。
2. 日ごとに、労働の区間を時刻の順に積む。所定の終わりまでは `scheduled_worked`。所定を超えて 8 時間（480 分）までは `non_statutory_ot`。480 分を超えた分は `statutory_ot`。
3. 週ごとに、日の計算で `statutory_ot` にしなかった労働（所定の休日の労働を含む）を、週の起算の曜日から時刻の順に積み、2,400 分を超えた分を `statutory_ot` に移す。
4. 月ごとに、`statutory_ot` を時刻の順に積み、3,600 分を超えた分に `statutory_ot_over_60` の印を付ける。
5. `night` は、1〜3 の区分とは別に、22 時〜5 時の労働の分を数える。

- 週が月をまたぐときは、週の判定はその週の全日で行い、区分した分はそれぞれの日の月に属する。前の月の日の分は前の月の締めで確定しているので、後から週 40 時間を超えた分は当月の日に付く（時刻の順に積むので自然にそうなる）。
- 60 時間の月は、賃金の計算の期間（締日）で数えるか暦月で数えるかを、テナントの設定で決める。既定は給与の締めの期間（未検証。L18）。

### 5.5 1 か月単位の変形

- 法定の枠 ＝ 2,400 分 × 期間の暦日数 ÷ 7（分未満は切り捨て。切り捨ての向きは枠を狭くし、法定外を多く数える）。
- 日：所定が 8 時間を超える日は所定を超えた分、それ以外は 8 時間を超えた分を `statutory_ot`。
- 週：所定が 40 時間を超える週は所定を超えた分、それ以外は 40 時間を超えた分。日で数えた分を除く。
- 期間：期間の労働の合計が枠を超えた分。日と週で数えた分を除く。
- 所定を超え、法定の基準（上の 3 つ）以内の分は `non_statutory_ot`。

### 5.6 フレックス（清算期間 1 か月）

- 法定の枠 ＝ 2,400 分 × 清算期間の暦日数 ÷ 7。
- 清算期間の労働の合計（法定の休日を除く）が枠を超えた分を `statutory_ot`、総労働時間を超え枠以内の分を `non_statutory_ot` にする。
- 総労働時間に足りない分は `absence_minutes`（控除か繰り越しかはテナントの設定。繰り越しは MVP の外）。
- 週 5 日勤務で「所定労働日数 × 8 時間」を枠にする労使協定（32 条の 3 第 3 項）は、テナントの設定の印で持つ。
- 清算期間が 1 か月を超えるフレックスと、月ごとの週平均 50 時間の判定は MVP の外。足すときは ADR を起票する。
- 60 時間の判定は、清算期間の終わりにまとめて行う。

### 5.7 労働時間の状況

- 管理監督者と裁量労働の印の人も、打刻と区間の計算は同じく行い、「労働時間の状況」として記録する（労働安全衛生法の把握の義務があるとされる。条文は未確認で未検証）。区分は `managerial` の印により `scheduled_worked` と `night` だけにする。

### 5.8 計算の実行

- 計算は純粋な関数 `computeWorkDay(input, rule, calendar) → DayResult` と `computePeriod(days, rule) → PeriodResult` にする。現在時刻を使わない。
- 退勤の打刻、訂正、休暇の承認、シフトの変更、勤務の規則の割り当ての変更で、その日と、影響する週・期間を再計算する（outbox の事象で Worker が行う）。
- 結果は `work_day_results` に版として追記する。入力のハッシュが前の版と同じなら書かない。

```sql
work_day_results (tenant_id, id, employment_id, work_date, version int,
                  input_hash bytea, calc_engine_version text, work_rule_version_id,
                  minutes jsonb,          -- {scheduled_worked: 450, statutory_ot: 30, night: 0, ...}
                  issues text[],          -- unpaired, clock_skew, divergence_open ...
                  status text,            -- final | provisional
                  computed_at, superseded_at,
                  PRIMARY KEY (tenant_id, employment_id, work_date, version))
```

## 6. 36 協定（[ADR-0023](../decisions/0023-overtime-agreement-monitoring-and-monthly-close.md)）

### 6.1 協定の設定

```sql
-- Effective-dated per location (the 事業場). Created via bp `overtime_agreement_change`.
overtime_agreements (tenant_id, id, location_id, valid daterange,
                     period_start date,                 -- 対象期間の起算日（1 年）
                     daily_limit_min, monthly_limit_min, annual_limit_min,   -- 協定の時間
                     holiday_days_per_month int,
                     special_clause bool,
                     special_monthly_limit_min,        -- < 6000 (100h) incl. holiday
                     special_annual_limit_min,         -- <= 43200 (720h)
                     special_months_max int,           -- <= 6
                     variable_over_3m bool,            -- 42h/320h variant
                     filed_on date, document_ref,
                     PRIMARY KEY (tenant_id, id))
```

- 保存のとき、協定の値が法の上限を超えるものを拒む（月 45 時間・年 360 時間、特別条項の 100 時間未満・720 時間・6 か月。1 年単位の変形は 42・320）。
- 事業所に有効な協定がない日の時間外・休日の労働は、発生のたびに人事へ警告する。

### 6.2 判定する値

利用者ごと・日ごとに、次の値を集計する（`statutory_ot` と `legal_holiday_work` から）。

| # | 値 | 上限 | 根拠 |
| --- | --- | --- | --- |
| M1 | 1 日の時間外 | 協定の 1 日の時間 | 協定 |
| M2 | 月の時間外 | 協定の月の時間（特別条項がなければ上限） | 36 条 4 項 |
| M3 | 月の時間外＋休日 | 100 時間未満（6,000 分未満） | 36 条 6 項 2 号 |
| M4 | 2〜6 か月の平均の時間外＋休日 | 80 時間以内 | 36 条 6 項 3 号 |
| M5 | 対象期間の時間外 | 360 時間、特別条項は協定の時間（720 時間以内） | 36 条 4・5 項 |
| M6 | 月 45 時間を超えた月の数 | 6 か月以内 | 36 条 5 項 |
| M7 | 月の法定の休日の労働の日数 | 協定の日数 | 協定 |

- M3・M4 は、事業所が変わっても通算する（38 条）。協定の単位の M1・M2・M5・M6・M7 は事業所ごとに数える。異動の月の扱い（どちらの協定で数えるか）は未検証（L17）。
- M4 は、各月について、直前の 1〜5 か月を加えた 2〜6 か月の平均を全部見る。
- 月は協定の対象期間の起算日から 1 か月ごとに区切る。

### 6.3 警告

警告の段（DT-TIME-003。値ごとに上から評価する）：

| # | 条件 | 段 | 届け先 |
| --- | --- | --- | --- |
| 1 | 実績が上限を超えた（M3 は 100 時間に達した） | `breached` | 本人、上長、人事。人事の受信箱に対応の案件 |
| 2 | 見込みが上限を超える | `forecast_breach` | 本人、上長、人事 |
| 3 | 実績が上限の 80%（テナントの設定）以上 | `approaching` | 本人、上長 |
| 4 | M2 が 45 時間を超え、特別条項がない | `breached` | 同 #1 |
| 5 | それ以外 | なし | — |

- 見込み ＝ 実績 ＋（残りの予定の労働日 × 直近 10 労働日の平均の時間外）。シフトの予定があれば予定を使う。
- 判定は、退勤の打刻を受けた直後（その人だけ）と、日次の全員の実行で行う。K5（超える前に警告が届く割合 100%）は、見込みの警告が実績の超過より前に出たかで測る。
- 同じ値・同じ段の警告は、月に 1 回だけ送る。段が上がれば送る。
- 通知の本文に時間の数を書かない。「36 協定の上限に近づいています」と、ログインを要するリンクだけにする（[business-process-engine.md](business-process-engine.md) の 10.3 節）。
- 警告は止めない。上限を超える労働をさせないかは企業の判断で、システムは打刻を拒まない（拒むと記録が残らず、把握の義務に反する）。
- 研究開発の印（`overtime_exempt_rnd`）の人は、M1〜M7 の代わりに、月の時間外＋休日 100 時間の到達を警告する（医師の面接指導の対象の把握のため。労働安全衛生法の要件は未検証）。

```sql
overtime_alerts (tenant_id, id, employment_id, agreement_id, metric text, level text,
                 month date, value_min int, limit_min int, forecast_min int,
                 raised_at, notified jsonb, acknowledged_by, acknowledged_at)
```

## 7. 月次の締め（[ADR-0023](../decisions/0023-overtime-agreement-monitoring-and-monthly-close.md)）

### 7.1 期間

- 締めの期間（`time_periods`）は、会社 × 勤怠の締日で作る。給与の締日と同じにするのが既定。違うときは、給与は「その給与の期間に締めた勤怠の期間」を使う（[payroll-engine.md](payroll-engine.md) の 4 節）。

### 7.2 状態

```
 open ──(締日の翌日)──▶ employee_review ──(本人の確認)──▶ manager_review ──(timesheet_approval)──▶ hr_locked ──(給与の入力の固定)──▶ handed_off
   ▲                                                                                                │
   └──────────────────────────── reopen（time_period_reopen。承認つき）◀──────────────────────────────┘
```

| 状態 | できること |
| --- | --- |
| `open` | 打刻、訂正、休暇 |
| `employee_review` | 本人が月の集計を確かめる。問題（未確定の日、乖離）があれば訂正を出す |
| `manager_review` | 上長が `timesheet_approval` で承認する。問題の残る人は承認できない（人事が理由つきで進められる） |
| `hr_locked` | 人事が確定する。集計の版を作る（7.3 節） |
| `handed_off` | 給与の入力の固定がその版を読んだ |
| reopen | 人事が `time_period_reopen` で開き直す。理由と承認を要する |

- 期限は給与の実行の予定から逆算して受信箱に出す（[business-process-engine.md](business-process-engine.md) の 10.1 節）。
- 締めの期限を過ぎて本人や上長が動かないときは、人事が理由つきで進める。進めた件数を月次の報告に出す。

### 7.3 給与への連携

```sql
time_period_summaries (tenant_id, id, period_id, employment_id, version int,
                       minutes jsonb, days jsonb,      -- worked_days, absence_days, paid_leave_days ...
                       day_result_ids uuid[], summary_hash bytea,
                       locked_at, locked_by, superseded_at,
                       PRIMARY KEY (tenant_id, period_id, employment_id, version))
```

- `hr_locked` のとき、各人の集計を版として書き、日の結果の版の一覧とハッシュを持たせる。
- 給与の入力の固定は、`known_at` の時点で最新の集計の版とハッシュを入力の文書に入れる（[ADR-0004](../decisions/0004-payroll-engine.md)）。
- 締めた後の訂正（reopen の後の訂正、または次の月に入った `time_correction`）は、新しい集計の版を作る。確定した給与にかかれば、給与の遡及の候補になる（[payroll-engine.md](payroll-engine.md) の 7 節）。勤怠の側で給与を直さない。
- 賃金台帳の時間の欄（規則 54 条）は、この集計から作る（[payments-and-accounting.md](payments-and-accounting.md) の 6 節）。

## 8. 規模

- 打刻：S1 のピーク 400 件/秒（始業の 15 分に 3 割）。1 件の書き込みは 1 行の挿入と冪等の索引の確認だけにし、p99 300ms（NFR-005）。計算は outbox の後で非同期にする。
- 日の再計算：100 万人 × 1 日 2〜4 回。1 回 5ms で 1 日 4 時間の CPU ほど。Worker を水平に広げる。
- 36 協定の日次の判定：100 万人を夜間 1 時間で。事業所 × 月の集計の表を増分で保つ。
- `time_clock_events` は S1 で 1 日 400 万行。月ごとのパーティション。保存は L5 の結論まで 5 年を既定にする。

## 9. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| API が落ちている | 端末に貯める（3.2 節）。打刻機は機器の側で貯める |
| 同じ打刻の二重の送信 | `client_event_id` の一意の制約で 1 つにする |
| 打刻機の時計のずれ | `clock_skew` の印。締めの確認で扱う。自動で直さない |
| 客観的な記録の取り込みが止まる | 乖離の検知を「データなし」とし、締めの画面に「連携が止まっている」を出す。締めは止めない（人事が理由つきで進める） |
| 再計算の Worker の遅れ | 締めの `hr_locked` の前に、未計算の日が 0 件であることを確かめる。残っていれば締めを拒む |
| 勤務の規則の設定の誤り（例：法定の休日がない週） | 保存のときに検査して拒む（DT-TIME-004） |
| 36 協定の判定の遅れ | 日次の実行の遅れを監視する（1 時間で警告）。退勤ごとの判定が落ちても、日次で必ず追いつく |

## 10. セキュリティとプライバシー

- 勤怠のドメインは `time.records`（[security-model.md](security-model.md) の 3 節）。上長は部下の打刻・集計・36 協定の警告を見る。給与の額は見ない。
- 客観的な記録（PC のログ）は、本人の行動の記録になる。取り込むのは最初と最後の時刻だけにし、操作の内容・アプリの名前・URL は取り込まない。
- 位置の情報は集めない（3.1 節）。足すときは、要配慮ではないが本人の同意と目的の説明が要る。法務の確認を経て ADR にする。
- 打刻の端末の登録と、打刻機の API の鍵はテナントの管理者が発行する。鍵は取り消せ、呼び出しを記録する。
- 通知に労働時間の数を書かない（6.3 節）。
- テストのデータは合成の人だけ（[AGENTS.md](../../AGENTS.md)）。

## 11. テスト

### 11.1 決定表

| ID | 内容 |
| --- | --- |
| DT-TIME-001 | 客観的な記録との乖離（3.3 節） |
| DT-TIME-002 | 区分の規則（5.4〜5.6 節）。固定・シフト・変形・フレックス × 日・週・月の境界 × 法定の休日・所定の休日 × 深夜 × 管理監督者 |
| DT-TIME-003 | 36 協定の警告の段（6.3 節） |
| DT-TIME-004 | 勤務の規則の保存の検査（法定の休日がない、変形の枠を超える予定、深夜の帯の誤り） |
| DT-TIME-005 | 月次の締めの状態の遷移（7.2 節） |

DT-TIME-002 の行は、少なくとも次の境界を持つ：1 日 480 分ちょうど・481 分、週 2,400 分ちょうど・2,401 分、月 3,600 分ちょうど・3,601 分、22:00 と 5:00 の前後の 1 分、0 時をまたぐ勤務、法定の休日の 23:59〜翌 0:01、週が月をまたぐ週、変形の枠（28・29・30・31 日の期間）。

### 11.2 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-TIME-001 | 任意の打刻の列で、区分の合計（`night` と `leave_paid_minutes` を除く）は、労働の区間の合計に等しい。分が消えず、二重に数えない |
| PROP-TIME-002 | 任意の打刻の列と、同じ `client_event_id` の任意の再送で、記録される打刻の数は変わらない |
| PROP-TIME-003 | 任意の打刻の列で、ある労働の区間を延ばしても、どの区分の分も減らない（単調性） |
| PROP-TIME-004 | 任意の列で、`statutory_ot_over_60` ≤ `statutory_ot`、かつ `statutory_ot_over_60` ＝ max(0, 月の `statutory_ot` − 3,600) |
| PROP-TIME-005 | 任意の訂正の列の後、打刻の行は減らず、無効にした打刻は計算に入らない |
| PROP-TIME-006 | 任意の実績の列で、M3 が 6,000 分に達する日より前に、`forecast_breach` か `approaching` の警告が出ているか、その月の最初の日に達している（予測の失敗は、急な長時間の 1 日だけ） |
| PROP-TIME-007 | 任意の打刻の列で、同じ入力から計算した日の結果は、入力の順序と再計算の回数によらず同じ |

### 11.3 例と結合

- 例：月曜〜金曜 9:00〜18:00（休憩 1 時間）で、水曜だけ 22:30 まで働き、土曜（所定の休日）に 4 時間働いた週。水曜は `statutory_ot` 270 分・`night` 30 分、土曜の 240 分は週 40 時間を超えて `statutory_ot`。
- 結合：オフラインで 50 件を貯めて再接続し、順不同・重複ありで届いても、結果が同じ。
- 負荷：始業の 15 分に 400 件/秒（E12）。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E6 | `clock-events-ingest` | 3.1・3.2 節。冪等の打刻、端末の一時の保存、印（PROP-TIME-002） |
| E6 | `clock-terminal-integration` | 打刻機の取り込み（形式は E6 の前に決める。[intent.md](../intent.md)）。[integrations-and-bulk.md](integrations-and-bulk.md) の同じ名前の Story と 1 つにした |
| E6 | `time-correction-process` | 3.4 節（PROP-TIME-005） |
| E6 | `objective-records-divergence` | 3.3 節（DT-TIME-001）。PC のログ・入退室の取り込み |
| E6 | `work-rules-and-shifts` | 4 節（DT-TIME-004） |
| E6 | `work-hour-calc-fixed-shift` | 5.1〜5.4 節（DT-TIME-002、PROP-TIME-001・003・004・007） |
| E6 | `work-hour-calc-monthly-variable` | 5.5 節 |
| E6 | `work-hour-calc-flex` | 5.6 節 |
| E6 | `overtime-agreements` | 6.1 節。協定の設定と保存の検査 |
| E6 | `overtime-alerts` | 6.2・6.3 節（DT-TIME-003、PROP-TIME-006）。K5 の計測 |
| E6 | `monthly-close` | 7 節（DT-TIME-005）。本人の確認、`timesheet_approval`、`hr_locked`、reopen |
| E6 | `time-to-payroll-handoff` | 7.3 節。集計の版とハッシュ |
| E12 | `statutory-registers` | 出勤簿の元のデータの出力（[reporting.md](reporting.md) の 5.1 節の 4 つの帳簿と 1 つにした） |
| E12 | `load-test-suite` | 打刻の集中の負荷試験（[capacity.md](capacity.md) の 7 節の負荷試験と 1 つにした） |

## 13. 未解決の問い

### 決定

- **打刻は端末が採番した ID つきの追記のみの事象**。訂正は「追加」「無効」の記録で、元を消さない（[ADR-0021](../decisions/0021-clock-events-corrections-and-objective-records.md)）。
- **1 日ごとの丸めは持たない**。分の整数で計算し、月の合計の 30 分の処理は給与の側の設定にする。
- **出勤は分の切り捨て、退勤は切り上げ**。労働時間を短くする向きに丸めない。
- **客観的な記録との乖離は検知して理由を求め、自動では直さない**。既定のしきい値は 30 分。
- **勤務体系の種類は固定・シフト・フレックス（1 か月）・1 か月単位の変形**。管理監督者・裁量労働・1 年単位の変形・研究開発は印で持つ（[ADR-0022](../decisions/0022-work-schedules-and-work-hour-calculation.md)）。
- **36 協定の警告は止めない**。打刻を拒まない（[ADR-0023](../decisions/0023-overtime-agreement-monitoring-and-monthly-close.md)）。
- **締めた後の訂正は集計の新しい版にし、給与の遡及で扱う**。

### 社労士の確認待ち（[intent.md](../intent.md) に載せたもの。L6 を細かくしたもの）

| # | 問い | 確認先 | 止める spec |
| --- | --- | --- | --- |
| L17 | 月の途中で事業所が変わった人の 36 協定の月・年の時間を、どちらの協定で数えるか。100 時間・80 時間の通算の扱い | 社労士 | E6 の `overtime-alerts` |
| L18 | 月 60 時間の「1 か月」の起算（賃金の締めの期間か、協定の起算か暦月か）。就業規則で定める前提でよいか | 社労士 | E6 の `work-hour-calc-fixed-shift` |
| L19 | 2 暦日にまたがる勤務、法定の休日の暦日の扱い、週の起算の既定（2 節の未検証の通達） | 社労士 | 同上 |
| L20 | 乖離のしきい値の既定（30 分）と、自己申告の運用を許す条件 | 社労士 | E6 の `objective-records-divergence` |
| L21 | 管理監督者・裁量労働の人の「労働時間の状況の把握」（労働安全衛生法）に何を記録すれば足りるか | 社労士 | E6 の `work-rules-and-shifts` |
| L22 | 変形の期間の途中のシフトの変更を、警告にとどめてよいか | 社労士 | E6 の `work-hour-calc-monthly-variable` |

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 打刻機の機種と形式 | E6 の着手の前（[intent.md](../intent.md) の「選定・計測で決めるもの」） |
| 清算期間が 1 か月を超えるフレックス、1 年単位の変形、裁量労働の計算 | MVP の後。ADR を起票する |
| 代替休暇（60 時間超の割増の代わりの休暇） | MVP の後。[payroll-jp-rules.md](payroll-jp-rules.md) と合わせる |
| 建設・自動車の運転・医師の上限の特例 | 対象のテナントが出たとき |
| 位置の情報の打刻 | 法務の確認の後 |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- K5：36 協定の見込みの警告が、実績の超過より前に届いた割合（目標 100%）。
- 打刻の p99（NFR-005 の 300ms）と、端末から遅れて届いた打刻の件数。
- 乖離の件数と、理由の区分の分布。労働時間を減らす訂正の件数（監査の抜き取り）。
- 締めの期限を人事が理由つきで進めた件数。
- DT-TIME-002 の境界の行の網羅（全行が表駆動テストにある）。

### runbooks

- `clock-ingest-backlog.md`：打刻の受付の遅れ・端末の再送の集中への対応。
- `objective-log-import-failure.md`：客観的な記録の取り込みの停止。締めへの影響とテナントへの連絡。
- `overtime-alert-job-delay.md`：36 協定の日次の判定の遅れ。追いつきの手順。
- `time-period-reopen.md`：締めた月を開き直すときの確認（給与の実行の状態、遡及の候補）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `time_clock_events` | 3.1 節。追記のみ。月ごとのパーティション |
| Aurora `time_clock_corrections`、`time_objective_logs`、`time_divergences` | 3.3・3.4 節 |
| Aurora `work_rules`（版）、facet `employment_work_rule`、`shift_patterns`、`shift_assignments` | 4 節 |
| Aurora `work_day_results` | 5.8 節。版の追記 |
| Aurora facet `overtime_agreements`、`overtime_alerts` | 6 節 |
| Aurora `time_periods`、`time_period_summaries` | 7 節。集計の版とハッシュ |
| ブラウザ IndexedDB `pending_clock_events` | 3.2 節。送信の前の一時の保存 |

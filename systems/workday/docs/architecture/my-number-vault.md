# My Number vault: Workday

マイナンバー（個人番号）の保管庫を決める。収集と本人確認、保管と暗号化、利用の目的で縛った API、事務取扱担当者、アクセスの記録、保管庫の中での法定の書類の生成、保存の期間と削除、移行、漏えいの疑いのときの対応を扱う。

前提の決定は、保管庫を別の AWS アカウントに置き、人事の側には参照の ID（`mn_ref`）だけを置くこと（[ADR-0005](../decisions/0005-security-and-my-number.md)）。権限の全体は [security-model.md](security-model.md)（`my_number` のドメインの判定は保管庫の側）、鍵とアカウントは [security.md](security.md) と [infrastructure.md](infrastructure.md)、記録の保存は [audit-and-retention.md](audit-and-retention.md) にある。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0045](../decisions/0045-my-number-collection-and-identity-verification.md) | 番号の入力と本人確認の書類の提出は、保管庫が配る画面（別のオリジン）で受け、人事の SPA と API を通さない。本人確認は、方法・書類の種類・確認した人・時刻を記録する。書類の画像は確認の後 30 日で消す（既定。確認待ち）。扶養の親族の番号は従業員を通して受ける |
| [0046](../decisions/0046-purpose-bound-vault-api-and-access-log.md) | 保管庫の API は、相互 TLS のサービスの認証に加え、人事の側が署名した操作者の主張（テナント、操作者、代理、目的、対象）を毎回受ける。目的と事務取扱担当者の指定は保管庫が自分の表で判定する。番号の平文は保管庫の外に返さず、法定の書類は保管庫の中で作る。アクセスの記録はハッシュの連鎖で、番号を含めない |
| [0047](../decisions/0047-my-number-retention-and-deletion.md) | 番号の本体の記録は、雇用が続く間と、退職の後の最後の法定の事務が終わるまで持つ。番号を書いた書類は、書類の種類ごとの保存の期間で持つ。期限が来たものを日次に候補にし、事務取扱担当者の確認で 30 日以内に削除する。削除の記録には番号も HMAC も残さない。バックアップの中の暗号文は 35 日で消える |

## 1. 目的と範囲

- 扱う：保管庫の構成、収集（従業員、扶養の親族）、本人確認の記録、暗号化、目的と事務取扱担当者、保管庫の API、画面での表示、アクセスの記録と取扱状況の確認、法定の書類の生成と取り出し、保存の期間と削除、移行、障害と DR、漏えいの疑い。
- 扱わない：人事の側の権限（[security-model.md](security-model.md)）、法定調書・年末調整の計算そのもの（E13。[payroll-jp-rules.md](payroll-jp-rules.md) の 10 節）、電子申請（E14）、監査ログの全体の保管（[audit-and-retention.md](audit-and-retention.md)。保管庫の記録の連鎖の形だけここで決める）。
- **番号の平文は保管庫の外に出さない**（[AGENTS.md](../../AGENTS.md)、intent の「守るべき振る舞い」）。例外は、法令で決まった書類に書くときだけで、そのときも保管庫の中で書類を作る。
- 法令の解釈は結論を出さない。確認待ちは 15 節と [intent.md](../intent.md) の L1・L2。

## 2. 法令とガイドライン（確かめたこと）

個人情報保護委員会の [特定個人情報の適正な取扱いに関するガイドライン（事業者編）](https://www.ppc.go.jp/legal/policy/my_number_guideline_jigyosha/)（平成 26 年 12 月 11 日、令和 7 年 6 月一部改正。[PDF](https://www.ppc.go.jp/files/pdf/2506_my_number_guideline_jigyosha.pdf)）の本文を、2026-09-28 に確かめた。[ADR-0005](../decisions/0005-security-and-my-number.md) も令和 7 年 6 月の一部改正の版を引くように直した（日付つきの注記）。

| 項目 | ガイドラインの記述（要約） | 設計への反映 |
| --- | --- | --- |
| 利用の制限 | 社会保障・税・災害対策の決められた事務に限る（第 4-1） | 目的を API の必須の引数にし、目的ごとに許す操作を決める（6 節） |
| 本人確認 | 番号法 16 条。個人番号カード、または「番号確認書類」＋「身元確認書類」など、法令と利用事務実施者が認める方法による（第 4-3-(4)） | 方法と書類の種類を記録する（4 節） |
| 継続的な保管 | 雇用の契約など継続的な関係があれば、翌年度以降の源泉徴収・社会保険の事務のために継続して保管できる。休職中も同じ（第 4-3-(3)） | 雇用が続く間は削除の候補にしない（10 節） |
| 保存の期間の後の廃棄 | 扶養控除等申告書は、所得税法施行規則 76 条の 3 により、提出の期限の属する年の翌年 1 月 10 日の翌日から 7 年を経過する日まで保存する。過ぎたら記載の番号をできるだけ速やかに廃棄する。システムは、保存の期間の後の削除を前提に作ることが望ましい（第 4-3-(3)） | 書類の種類ごとの保存の期間の規則表と、日次の削除の候補（10 節） |
| 取扱状況の記録 | 利用・出力の状況、削除・廃棄の記録、事務取扱担当者のシステムの利用状況（ログイン実績、アクセスログ）を記録する。**取扱状況を確認するための記録には特定個人情報を記載しない**（別添 1 の C-b・c） | アクセスの記録に番号を入れない（8 節）。取扱状況の確認の画面（9 節） |
| 技術的安全管理措置 | アクセス制御（事務取扱担当者に限る）、アクセス者の識別と認証、外部からの不正アクセスの防止、通信経路と保存の暗号化（別添 1 の F） | 7 節、[security.md](security.md) |
| 削除の記録 | 削除・廃棄の記録を保存する。委託したときは証明書などで確認する（別添 1 の E-d） | 削除の記録（10.3 節）と、テナントへの削除の証明の出力 |
| 委託 | 委託元は委託先を監督する。再委託は委託元の許諾を要する（第 4-2-(1)） | 本システムが委託先に当たるかは法務の確認待ち（L1）。サブプロセッサーの一覧を持つ |
| 漏えい等の報告 | 番号法 29 条の 4。報告の対象の事態（不正アクセス、不正な目的、100 人超など）。委託先は委託元に通知すれば報告の義務を免れる。通知の「速やか」の目安は概ね 3〜5 日。高度な暗号化などの措置が講じられていれば報告を要しない（別添 2） | [runbooks/incident-response.md](../runbooks/incident-response.md) の「マイナンバーの漏えいの疑い」 |

- 扶養控除等申告書など 10 種類の申告書の保存（翌年 1 月 10 日の翌日から 7 年。退職所得の受給に関する申告書の一部は 10 年）は、[国税庁 No.2503](https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2503.htm)（2026-09-28 に確認。根拠は所得税法施行規則 76 条の 3 など）。

## 3. 構成

```
 prod アカウント（人事）                          vault アカウント（東京・大阪）
 ┌──────────────────────────┐               ┌──────────────────────────────────────────┐
 │ API・Worker・Payroll        │── 相互 TLS ──▶│ vault-api（ECS）                           │
 │ 人事の DB：mn_ref、登録済み   │  PrivateLink  │   目的の判定、事務取扱担当者の判定、記録     │
 │                            │  ＋操作者の主張 │ vault-docgen（ECS）：法定の書類の生成        │
 └──────────────────────────┘               │ vault-web：番号の入力・本人確認・表示の画面    │
                                              │ Aurora（vault 専用）、S3（書類・確認の画像）  │
 利用者のブラウザ ─── mn.<tenant>.<brand>.<domain> ─▶ CloudFront ─▶ vault の ALB（vault-web）  │
                                              │ KMS：vault-mn、vault-docs、vault-hmac       │
                                              └──────────────────────────────────────────┘
                                                      │ アクセスの記録（連鎖）
                                                      ▼ log-archive（Object Lock。保管庫の専用の接頭辞）
```

- 保管庫は別の AWS アカウント（[infrastructure.md](infrastructure.md) の 1 節、[ADR-0054](../decisions/0054-accounts-network-and-vault-boundary.md)）。人事の側から保管庫へは、PrivateLink の VPC エンドポイントだけでつながる。保管庫から人事の側へは、書類の生成のときに書類の元のデータを取りに行く読み取りの API（相互 TLS）だけ。
- 保管庫の画面は別のオリジン（`mn.<tenant>.<brand>.<domain>`）。人事の SPA から別のタブで開く。人事の SPA のコードは番号に触れない（[self-service-ui.md](self-service-ui.md) の 10 節）。
- 人事の DB の facet（`worker_personal`・`worker_dependents`）は、`mn_ref`（UUIDv7）と `mn_status`（`none`・`registered`・`verified`・`deleted`）だけを持つ。

## 4. 収集と本人確認（[ADR-0045](../decisions/0045-my-number-collection-and-identity-verification.md)）

### 4.1 流れ

```
入社の業務プロセスの子の案件「マイナンバーの提出」（core-hr の 5.3 節）
  ▼ 本人の受信箱のリンク
保管庫の画面（別のオリジン。人事のセッションから引き換えた 10 分の保管庫のセッション）
  1. 利用目的の通知を表示（テナントが登録した文面の版）。表示した版を記録
  2. 番号を入力（12 桁。チェックデジットを画面とサーバーで確かめる）
  3. 本人確認の書類を撮影・アップロード（下の表の組み合わせ）
  4. 送信 ─▶ vault：暗号化して保存（status = registered）。人事の側に mn_ref と registered を通知
  ▼
事務取扱担当者が保管庫の画面で書類を見て確かめる ─▶ verified（方法、書類の種類、確認した人、時刻を記録）
  ▼
確認の画像は 30 日後に消す（既定。L44）
```

### 4.2 本人確認の方法

番号法 16 条と、ガイドラインの〈参考 1：本人確認の概要〉に沿って、方法を選ばせる。どの組み合わせが認められるかの細部は、施行規則と利用事務実施者（国税庁、日本年金機構など）が認める方法による。システムは「どの方法で、どの書類で、誰が確かめたか」を記録し、方法の正しさの判定はしない。

| 方法 | 番号の確認 | 身元の確認 | 記録 |
| --- | --- | --- | --- |
| 個人番号カード | カードの裏面 | カードの表面 | 方法 `mn_card` |
| 番号確認書類＋身元確認書類 | 住民票の写し（番号つき）など | 運転免許証など | 方法 `number_doc_and_id_doc`、書類の種類 2 つ |
| 身元確認の省略（雇用の関係で本人と明らか） | 番号確認書類 | 省略の理由（入社のときに身元を確かめた記録） | 方法 `id_known_by_employment`（L45） |
| 電子の確認（公的個人認証など） | — | — | MVP の外 |

- 画像は保管庫の S3（`vault-docs` の鍵）に置き、人事の側に渡さない。
- 事務取扱担当者の確認の画面では、番号と書類の画像を並べて見せる。確認の操作も記録する（8 節）。

### 4.3 扶養の親族

- 扶養控除等申告書に書く扶養の親族の番号は、従業員が保管庫の画面で入れる。扶養の親族の本人確認を事業者が行う必要があるかは、事務の種類による。扶養控除等申告書の親族の番号は、従業員が本人確認を行い、事業者には義務がない。国民年金の第 3 号被保険者の届出は、第 3 号被保険者本人が事業者に出すもので、従業員は代理人として出す（[個人情報保護委員会の Q&A](https://www.ppc.go.jp/legal/policy/faq/) の Q6-2-2・Q1-12、2026-09-28 に確認）。事務ごとに画面の手順をどう分けるかは確認待ち（L46）。
- 扶養の親族の記録は、人事の facet `worker_dependents` の行の `mn_ref` と結ぶ。扶養から外れたら、10 節の規則で削除の候補になる。

## 5. 保管と暗号（[ADR-0046](../decisions/0046-purpose-bound-vault-api-and-access-log.md)）

```sql
-- Vault Aurora. tenant_id + RLS as everywhere.
mn_records (tenant_id, mn_ref uuid, subject_kind text,       -- worker | dependent
            subject_id uuid,                                  -- worker_id or dependent row id (HR side)
            number_ciphertext bytea, dek_ciphertext bytea,    -- AES-256-GCM, AAD = tenant_id || mn_ref
            key_arn_version text,
            dedupe_hmac bytea,                                -- HMAC-SHA256(tenant_hmac_key, number)
            status text,                                      -- registered | verified | deleted
            purpose_notice_version, registered_at, verified_at, verification_id,
            PRIMARY KEY (tenant_id, mn_ref),
            UNIQUE (tenant_id, dedupe_hmac) WHERE status <> 'deleted')
mn_verifications (tenant_id, id, mn_ref, method, doc_kinds text[], image_keys text[],
                  verified_by, verified_at, images_deleted_at)
```

- 番号はレコードごとのデータの鍵（DEK）で暗号化し、DEK を保管庫の KMS の鍵 `vault-mn` で包む（エンベロープ暗号化。[ADR-0005](../decisions/0005-security-and-my-number.md)）。AAD にテナントと `mn_ref` を入れ、行の入れ替えを検知する。
- 重複の登録の検知（同じテナントで同じ番号の別の人）は、テナントごとの HMAC の鍵で求めた値の一意の制約で行う。テナントごとの HMAC の鍵は `vault-hmac` の鍵で包んで保管庫の DB に置く。
- 復号は `vault-api` と `vault-docgen` のタスクのロールだけ。人のロールは `vault-mn` の `Decrypt` を持たない（break-glass も含む。[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)）。

## 6. 目的に縛られた API（[ADR-0046](../decisions/0046-purpose-bound-vault-api-and-access-log.md)）

### 6.1 呼び出しの認証

- サービスの認証：人事の側の `api`・`worker` のタスクと保管庫の間は相互 TLS（保管庫のアカウントの Private CA の証明書。7 日）。
- **操作者の主張**：人事の側の API は、呼び出しごとに JWT（60 秒、`jti` は 1 回限り）を作り、人事のアカウントの KMS の非対称の鍵（`hr-vault-assertion`）で署名して渡す。中身：`tenant_id`、`actor_worker_id`、`on_behalf_of`（委任）、`purpose`、`mn_refs`、`request_id`、`step_up_at`（再認証の時刻）。保管庫は公開鍵で確かめる。
- 保管庫は、主張を信じるだけでなく、**自分の表で判定する**（6.3 節）。人事の側が乗っ取られても、事務取扱担当者でない人の名前で番号の表示はできない。

### 6.2 操作

| 操作 | 呼ぶ人 | 返すもの | 条件 |
| --- | --- | --- | --- |
| `register` | 本人（保管庫の画面） | `mn_ref`、状態 | 保管庫のセッション |
| `status` | 人事の側（`worker.personal` の `view` の範囲） | 状態だけ（`none`・`registered`・`verified`・`deleted`） | — |
| `verify` | 事務取扱担当者（保管庫の画面） | 確認の記録 | 目的 `identity_verification` |
| `reveal` | 事務取扱担当者（保管庫の画面） | 番号の全桁を 60 秒だけ画面に表示（コピーの操作を記録） | 理由の入力、5 分以内の再認証 |
| `generate_document` | 人事の側の Worker（担当者の操作の代理） | 書類の ID | 目的と書類の種類の組が 6.4 節の表にある |
| `download_document` | 事務取扱担当者（保管庫の画面） | 15 分の 1 回限りの URL | 再認証 |
| `delete` | 事務取扱担当者（保管庫の画面） | 削除の記録の ID | 10 節 |
| `access_log` | 事務取扱責任者（保管庫の画面） | テナントのアクセスの記録 | 9 節 |

- **人事の側に返すのは、`mn_ref` と状態と書類の ID だけ**。番号の一部（末尾 4 桁など）も返さない。画面での末尾の表示は、保管庫の画面の中だけで行う（番号の一部が個人番号に当たるかの確認は L47）。

### 6.3 事務取扱担当者と目的

```sql
mn_handlers (tenant_id, id, worker_id, purposes text[], valid daterange,
             designated_by_case_id, approved_by, training_attested_at)
mn_purposes (purpose, allowed_ops text[], allowed_documents text[])   -- system table
```

- 事務取扱担当者の指定は、人事の側の業務プロセス `mn_handler_designation`（テナントの事務取扱責任者の起票、別の人の承認）で行う。完了の事象を、署名つきで保管庫に送り、保管庫が `mn_handlers` に書く。保管庫は、承認の記録（案件の ID、承認者）を持たない指定を受けない。
- 指定の条件に、テナントが入れた教育の実施の記録（`training_attested_at`）を要る（人的安全管理措置。ガイドラインの別添 1 の D）。
- 目的（`mn_purposes`）の初期の一覧：`identity_verification`、`withholding_slip`（源泉徴収票）、`salary_payment_report`（給与支払報告書）、`health_pension_notification`（健康保険・厚生年金の届出）、`employment_insurance_notification`（雇用保険の届出）、`dependents_declaration`（扶養控除等申告書）。目的は番号法の事務の範囲に限る。テナントは足せない。
- 判定：操作者が今日有効な `mn_handlers` の行を持ち、その目的を含み、操作が目的の `allowed_ops` にあること。委任では、委任した人と実際の操作者の両方が担当者であること（[ADR-0014](../decisions/0014-bp-routing-and-delegation.md) の考え方を保管庫でも使う）。

### 6.4 法定の書類の生成

```
人事・給与の側（Worker）            保管庫（vault-docgen）
  書類の元のデータ（番号なし。         1. 主張と目的を判定
  mn_ref で人と扶養を指す）  ───▶     2. mn_ref の番号を復号し、元のデータと合わせる
                                       3. 書類（PDF、後に e-Tax・eLTAX の形）を作る
                                       4. 保管庫の S3（vault-docs の鍵）に置き、書類の ID と SHA-256 を返す
```

- 元のデータは番号を含まない JSON で、種類ごとのスキーマ（Zod）で検証する。元のデータの中に番号の形の値があれば拒む。
- 作った書類は保管庫の外に出さない。取り出しは事務取扱担当者が保管庫の画面から行い、記録する。取り出した後の扱い（提出、印刷）はシステムの外で、画面で注意を出す。
- MVP の書類の種類は、生成の仕組みと、E11 で決める 1 種（候補：健康保険・厚生年金保険の資格取得届）。源泉徴収票・給与支払報告書・扶養控除等申告書の電子の保存は E13（[payroll-jp-rules.md](payroll-jp-rules.md) の `statutory-reports-in-vault`）。
- 電子申請（e-Tax、eLTAX、e-Gov）への送信は、後の Epic で保管庫から行う。

## 7. 技術的・物理的な統制

| 統制 | 設計 |
| --- | --- |
| アクセス制御 | 6.3 節。保管庫の DB のロールは `vault_app`（RLS の対象）だけ。人のロールは DB に入れない |
| 識別と認証 | 事務取扱担当者は、人事のログイン（SSO か パスキー）に加え、保管庫の操作の前に再認証 |
| 外部からの不正アクセス | 保管庫の VPC はインターネットからの入口を vault-web の ALB（CloudFront 経由、WAF）だけにする。vault-api は PrivateLink だけ。外への出口は持たない（VPC エンドポイントだけ） |
| 通信と保存の暗号化 | TLS 1.2 以上、相互 TLS、KMS（5 節） |
| 端末 | 番号の表示と書類の取り出しは、テナントが登録した IP の範囲からだけ許せる（テナントの設定。既定は無効） |
| 物理 | AWS のデータセンター（東京・大阪）。管理区域の考え方は、クラウドの責任共有に沿って、テナントの事務の端末の側はテナントが持つ |
| 運用者 | 本システムの運用者は、通常の運用で保管庫のデータと記録の中身を見ない（[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)） |

## 8. アクセスの記録（[ADR-0046](../decisions/0046-purpose-bound-vault-api-and-access-log.md)）

```sql
mn_access_log (tenant_id, seq bigint, id, at timestamptz, actor_worker_id, on_behalf_of,
               actor_kind,            -- handler | employee_self | service
               purpose, op, mn_ref, document_id, result, deny_reason,
               request_id, source_service, client_ip_prefix,
               prev_hash bytea, hash bytea,
               PRIMARY KEY (tenant_id, seq))
```

- すべての操作（成功も拒否も）を、操作と同じトランザクションで追記する。**番号・番号の一部・HMAC を記録に入れない**（ガイドラインの別添 1 の C-c）。
- ハッシュの連鎖はテナントごと（`hash = SHA-256(prev_hash || 正規の形の行)`）。行を log-archive の保管庫の専用の接頭辞（Object Lock のコンプライアンスモード）へ送り、日次に連鎖を確かめる（[audit-and-retention.md](audit-and-retention.md) の 4 節、[ADR-0048](../decisions/0048-audit-log-hash-chain-and-anchoring.md)）。
- 日次に、保管庫の ALB・NLB のアクセスの記録（要求の ID）と `mn_access_log` を突き合わせ、記録の欠けを 0 件にする（[ADR-0005](../decisions/0005-security-and-my-number.md) の Confirmation、NFR-007）。

## 9. 取扱状況の確認

テナントの事務取扱責任者が、保管庫の画面で次を見られる（ガイドラインの別添 1 の C-c の例示の項目）。どれも番号を含まない。

| 項目 | 中身 |
| --- | --- |
| 特定個人情報ファイルの種類・名称 | 本体の記録、確認の画像、書類（種類ごと） |
| 責任者・取扱部署 | テナントが入れる |
| 利用目的 | 6.3 節の目的と、通知の文面の版 |
| 削除・廃棄の状況 | 10 節の候補・実行の件数と記録 |
| アクセス権を有する者 | `mn_handlers` の今日の一覧と履歴 |
| アクセスの記録 | 8 節の記録の検索と出力 |

## 10. 保存と削除（[ADR-0047](../decisions/0047-my-number-retention-and-deletion.md)）

### 10.1 何を、いつまで

| 対象 | いつまで持つか（既定。確認待ちの L2） |
| --- | --- |
| 本体の記録（従業員） | 雇用が続く間（休職を含む）。退職の後は、退職の年の源泉徴収票・給与支払報告書の作成と、資格喪失の届出の事務が終わるまで。既定は「退職の日の属する年の翌年 1 月 31 日」と「喪失の届出の完了」の遅いほう＋ 30 日 |
| 本体の記録（扶養の親族） | 扶養から外れた後、同じ規則（その年の源泉徴収票の作成まで） |
| 書類（扶養控除等申告書など） | 書類の種類ごとの保存の期間（例：翌年 1 月 10 日の翌日から 7 年。[国税庁 No.2503](https://www.nta.go.jp/taxes/shiraberu/taxanswer/gensen/2503.htm)） |
| 書類（届出の控え） | 事務ごとの保存の期間（[audit-and-retention.md](audit-and-retention.md) の規則表） |
| 本人確認の画像 | 確認の後 30 日（L44） |
| アクセスの記録・削除の記録 | 番号を含まないので、[audit-and-retention.md](audit-and-retention.md) の監査ログの規則に従う |

- 保存の期間は、[audit-and-retention.md](audit-and-retention.md) の規則表 `retention_rules` の行を参照する。期間の値は確認待ちの間、長いほうの候補を既定にする。
- 本体の記録を消しても、保存の期間の中の書類には番号が残る。書類はその期間の後に消す。

### 10.2 手順

```
日次のジョブ：規則表と、人事の側の事実（退職日、扶養の終わり、届出の完了、源泉徴収票の作成）から候補を作る
  ▼ 事務取扱担当者の受信箱（保管庫の画面）
確認（候補の一覧を見て承認。保留の理由があれば保留）── 担当者と別の人の承認（2 段）
  ▼
削除：本体の行を消す（番号の暗号文と包んだ DEK と HMAC を消す）。書類の S3 のオブジェクトを消す（版もすべて）
  ▼
削除の記録（10.3 節）。人事の側に mn_status = deleted を通知
```

- 候補が出てから 30 日以内に削除する（NFR-007）。30 日を超えた候補は、テナントの事務取扱責任者と本システムの監視に出す。
- 税務調査などの保全（リーガルホールド）は、削除を止める。保全の設定と解除も記録する。
- 保管庫の書類の S3 は Object Lock を使わない（期限の前に消せなくなるため）。版の管理を有効にし、消した版は 1 日で完全に消えるライフサイクルにする。

### 10.3 削除の記録

```sql
mn_deletions (tenant_id, id, mn_ref, subject_kind, target text,   -- record | document | verification_images
              document_kind, retention_rule_id, candidate_at, approved_by, second_approved_by,
              executed_at, backup_expiry_at)
```

- 番号も HMAC も残さない。`backup_expiry_at` に、バックアップの中の暗号文が消える日（実行の日 ＋ 35 日）を書く。
- テナントに、削除の証明（期間の中の削除の記録の一覧。PDF）を出せる（委託元への証明。ガイドラインの別添 1 の E-d）。
- バックアップ（Aurora の自動のバックアップ、35 日）の中には、消した記録の暗号文が 35 日残る。これを「復元不可能な手段での削除」とみなせるかは確認待ち（L48）。

## 11. 移行

- 現行のシステムの番号は、テナントの導入の担当が保管庫の画面から、保管庫の S3 へ直接アップロードする（人事のアカウントを通さない）。ファイルは `vault-docs` の鍵で暗号化され、取り込みの後に消す。
- 保管庫は、人事の側から「社員番号 → 人・扶養の ID」の対応を取り（番号を含まない）、行を結んで `mn_records` を作る。本人確認の記録は `migrated`（現行のシステムで確認済み、とテナントが表明した記録）にする。
- 検証：件数、チェックデジット、重複（HMAC）、結べない行。結べない行の報告に番号を出さない（行の番号だけ）。

## 12. 規模

- S1：従業員 100 万人と扶養の親族で、本体の記録 約 200 万件（初期見積もり）。1 件 1 KB 未満。
- 操作：通常は入社の時期（4 月）の登録と確認。書類の生成は E13（年末調整）の後、12〜1 月に集中する。
- アクセスの記録：1 日数千〜数万件。

## 13. 障害と DR

| 障害 | 振る舞い |
| --- | --- |
| 保管庫が止まる | 人事・勤怠・給与の計算は止まらない（計算に番号を使わない。[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)）。番号の提出と書類の生成は待たせる |
| リージョンの障害 | 保管庫のアカウントも大阪にウォームスタンバイを持つ（Aurora Global Database、KMS のマルチリージョンの鍵）。切り替えは人事の側の後でよい（振込ファイルの生成に保管庫は要らない。[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)） |
| アクセスの記録の書き込みの失敗 | 操作ごと失敗させる（記録のない操作をしない） |
| 連鎖の検証の失敗 | SEV2 から。[runbooks/incident-response.md](../runbooks/incident-response.md) |
| 記録の欠け（ALB との突き合わせ） | SEV2 から。原因の経路を止める |

## 14. テスト

### 14.1 決定表

- DT-MN-001：保管庫の操作の判定（操作 × 目的 × 担当者の指定 × 委任 × 再認証 → 許す・拒む）。
- DT-MN-002：削除の候補（雇用の状態 × 退職の年の書類の作成の完了 × 届出の完了 × 保全 × 書類の保存の期間 → 本体を消す・書類を消す・待つ）。

### 14.2 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-MN-001 | 任意の操作の列で、保管庫の外への応答・人事の側の DB・ログ・トレース・メトリクスに、個人番号の形の値が現れない |
| PROP-MN-002 | 任意の操作の列で、`mn_access_log` の行の数は保管庫の API の呼び出し（成功と拒否）の数と一致し、連鎖が検証できる |
| PROP-MN-003 | 任意の操作の列で、事務取扱担当者でない主体の `reveal`・`download_document`・`delete` は拒まれる（人事の側の主張が偽っていても） |
| PROP-MN-004 | 任意の 2 テナントで、同じ番号を登録しても重複の検知がテナントをまたがない（HMAC の鍵がテナントごと） |

### 14.3 CI と本番

- CI：人事の側のパッケージのコード・ログ・フィクスチャー・入力の文書に、個人番号の形（12 桁でチェックデジットが合うもの）が現れたら失敗させる（[ADR-0005](../decisions/0005-security-and-my-number.md)）。テストの番号は合成の生成器（印つき）だけ。
- 本番：8 節の日次の突き合わせと連鎖の検証。四半期ごとに、人事の側のログ・S3・分析用の出力の番号の形の走査（[observability.md](observability.md) の 4 節）。

## 15. 未解決の問い

### 決定

- **番号の入力と本人確認は保管庫の画面で受ける。** 人事の SPA と API を通さない。
- **人事の側には番号の一部も返さない。**
- **保管庫は、操作者の主張を受けたうえで、自分の担当者の表で判定する。**
- **法定の書類は保管庫の中で作り、保管庫の中に置く。**
- **削除は候補から 30 日以内。削除の記録に番号も HMAC も残さない。**
- **保管庫の書類の S3 に Object Lock を使わない。**

### 法務・税理士・社労士の確認待ち（[intent.md](../intent.md) に載せたもの。L1・L2 を細かくしたもの）

| # | 問い | 確認先 | 止める spec |
| --- | --- | --- | --- |
| L44 | 本人確認の書類の画像（写し）を保存するか、いつ消すか。保存しない場合に確認の記録だけで足りるか | 法務・社労士 | E11 の `mn-collection-and-verification` |
| L45 | 雇用の関係で本人と明らかなときの身元確認の省略の条件と、記録に残すべきこと | 社労士 | 同上 |
| L46 | 扶養の親族の本人確認を、どの事務で誰が行うか（扶養控除等申告書、第 3 号被保険者の届出） | 税理士・社労士 | 同上 |
| L47 | 番号の一部（末尾 4 桁）の表示・記録が、特定個人情報の扱いになるか | 法務 | E11 の `vault-api` |
| L48 | バックアップ（35 日）に残る暗号文の扱いが、削除の要件を満たすか。満たさないなら、DEK を別の保存に置いて消す方式が要る | 法務 | E11 の `mn-retention-and-deletion` |
| L49 | 本システムが委託先に当たる場合の、テナントとの契約（監督、再委託の許諾、AWS をサブプロセッサーとして扱うこと、漏えいのときの通知の期限） | 法務 | E12 の GA の判定 |
| L50 | 退職者の本体の記録を消す時期（10.1 節の既定）と、再雇用の見込みがある人の扱い | 税理士・社労士 | E11 の `mn-retention-and-deletion` |

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| MVP の保管庫の書類の 1 種 | E11 の着手の前に PM と |
| 公的個人認証（個人番号カードの IC の読み取り）での本人確認 | MVP の後 |
| 電子申請の送信を保管庫から行う経路（外への出口） | E14。出口を足すときに ADR |
| 保管庫の画面の表示で、事務取扱担当者の端末の IP の制限を既定にするか | E11 でテナントの利用の試験を見て |

## 16. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E11 | `vault-account-and-network` | 3 節、[infrastructure.md](infrastructure.md) の vault アカウント、PrivateLink、相互 TLS |
| E11 | `vault-storage-and-keys` | 5 節（PROP-MN-004） |
| E11 | `vault-api` | 6.1・6.2 節（DT-MN-001、PROP-MN-001・003）。操作者の主張 |
| E11 | `mn-handlers` | 6.3 節。指定の業務プロセスと保管庫への反映 |
| E11 | `mn-collection-and-verification` | 4 節。保管庫の画面（L44〜L46 の確認の後） |
| E11 | `vault-access-log` | 8・9 節（PROP-MN-002）。連鎖、突き合わせ、取扱状況の確認 |
| E11 | `vault-docgen` | 6.4 節。生成の仕組みと 1 種の書類 |
| E11 | `mn-retention-and-deletion` | 10 節（DT-MN-002。L48・L50 の確認の後） |
| E12 | `mn-migration` | 11 節 |
| E13 | `statutory-reports-in-vault` | 源泉徴収票・給与支払報告書（[payroll-jp-rules.md](payroll-jp-rules.md)） |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- K6：保管庫の外に番号の形が出た件数（CI と本番の走査。目標 0）、アクセスの記録の欠け（目標 0）。
- 削除の候補から実行までの日数（NFR-007：30 日以内）と、30 日を超えた件数。
- 本人確認の未完了（`registered` のまま 30 日を超えた件数）。
- 拒否の件数と理由（担当者でない人の試み）。

### runbooks

- `vault-access-log-gap.md`：突き合わせの欠け、連鎖の検証の失敗。
- `mn-deletion-overdue.md`：30 日を超えた削除の候補。
- `vault-break-glass.md`：保管庫の緊急の操作（[security.md](security.md) の 7 節）。
- 漏えいの疑いは [runbooks/incident-response.md](../runbooks/incident-response.md) の場面。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| vault Aurora `mn_records`、`mn_verifications` | 5 節 |
| vault Aurora `mn_handlers`、`mn_purposes`（システム）、`mn_purpose_notices` | 6.3 節、4.1 節 |
| vault Aurora `mn_documents` | 6.4 節（種類、SHA-256、保存の期限、S3 のキー） |
| vault Aurora `mn_access_log` | 8 節。追記のみ。ハッシュの連鎖 |
| vault Aurora `mn_deletions`、`mn_deletion_candidates`、`mn_legal_holds` | 10 節 |
| vault S3 `docs/{tenant}/{document_id}`、`verification-images/{tenant}/{id}` | `vault-docs` の鍵。Object Lock なし |
| 人事の Aurora `worker_personal.mn_ref`・`mn_status`、`worker_dependents.mn_ref`・`mn_status` | 3 節 |
| 人事の Aurora `mn_handler_designations`（業務プロセスの中身） | 6.3 節 |

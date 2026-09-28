# Self-service UI: Workday

従業員とマネージャーの画面を決める。セルフサービスの画面、受信箱、スマートフォンのブラウザ、打刻の画面、多言語（日本語・英語）、アクセシビリティ、有効日付のデータの見せ方（時点の指定、将来の変更、保留中の案件）を扱う。

前提の決定は、人事のデータを 2 軸で持つこと（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）、変更は業務プロセスを通すこと（[ADR-0003](../decisions/0003-business-process-engine.md)）、権限の判定を 1 か所にまとめること（[ADR-0005](../decisions/0005-security-and-my-number.md)、[ADR-0017](../decisions/0017-authorization-evaluator.md)）。受信箱の射影は [business-process-engine.md](business-process-engine.md) の 10 節、打刻の端末での一時の保存は [time-and-attendance.md](time-and-attendance.md) の 3.2 節、明細の文書は [payments-and-accounting.md](payments-and-accounting.md) の 4 節にある。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0038](../decisions/0038-single-responsive-spa-and-offline-clock.md) | 画面は 1 つのレスポンシブな React の SPA にする。ネイティブのアプリは作らない。打刻の画面だけを、Service Worker と IndexedDB の待ち行列でオフラインに耐えさせる。文言は ICU MessageFormat の辞書で日本語と英語を持つ |
| [0039](../decisions/0039-effective-dated-views-and-change-requests.md) | 画面は「いつの時点か」を常に示す。時点は URL の `asOf` に持つ。将来の変更と保留中の案件を、今の値に重ねて見せる。変更の申請の画面は有効日を必須にし、訂正と変更を別の操作にする |

## 1. 目的と範囲

- 扱う：従業員の画面（ホーム、自分の情報、変更の申請、打刻、休暇、明細、マイナンバーの提出の入口）、マネージャーの画面（部下の一覧、受信箱、勤怠と 36 協定の状況、起票）、受信箱の画面、スマートフォンのブラウザ、多言語、アクセシビリティ、時点の見せ方、画面の計測（K8）。
- 扱わない：人事・給与の担当と管理者の画面の細部（各領域の Story で作る。部品と規則はこの文書に従う）、承認の流れ（[business-process-engine.md](business-process-engine.md)）、権限の判定（[security-model.md](security-model.md)）、ログインと SSO（[integrations-and-bulk.md](integrations-and-bulk.md) の 7 節）、マイナンバーの入力の画面の中身（[my-number-vault.md](my-number-vault.md) の 4 節。保管庫が描画する）。
- **画面は API だけを使う。** 画面のための別の読み取りの経路を作らない。見えない項目は API が落とす（[security-model.md](security-model.md) の 3.3 節）。画面は `redacted` の印を見て「権限がありません」を出す。

## 2. 本家の形（確かめたこと）

本家の実装は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

| 本家の考え方 | 内容 | このシステムでの扱い |
| --- | --- | --- |
| 1 つの画面の体系 | 画面・モバイル・レポートに同じ権限が効く（[ホワイトペーパー](https://www.workday.com/content/dam/web/en-us/documents/whitepapers/whitepaper_workday_technology_platform_devt_process.pdf)、2026-09-28 に確認） | 同じ。画面は API の上にだけ作る |
| 受信箱 | 業務プロセスのタスクを受信箱に集める（[Approval Step](https://doc.workday.com/admin-guide/en-us/manage-workday/business-processes/business-process-step-types/dan1370797855296.html)、2026-09-28 に確認） | 受信箱の射影（[ADR-0015](../decisions/0015-bp-deadlines-reminders-and-inbox.md)）を画面にする |
| 専用のモバイルのアプリ | 本家はモバイルのアプリを配る（公開の資料の記述。機能の範囲は未検証） | 作らない。スマートフォンのブラウザで同じ SPA を使う（[ADR-0038](../decisions/0038-single-responsive-spa-and-offline-clock.md)） |

## 3. 画面の構成（[ADR-0038](../decisions/0038-single-responsive-spa-and-offline-clock.md)）

### 3.1 アプリ

| 項目 | 決定 |
| --- | --- |
| 形 | React の SPA（Vite でビルド）。1 つのアプリで、従業員・マネージャー・人事・給与・管理者の画面を持つ。見える画面は権限の判定で決まる |
| 配信 | S3＋CloudFront（静的な資産）。API は同じホスト名の `/api/*`（`<tenant>.<brand>.<domain>`） |
| 状態 | サーバーの状態は TanStack Query（キャッシュのキーに `tenant`・`asOf`・`knownAt` を含める）。画面の状態は URL に持つ |
| 型 | API の型は `@hono/zod-openapi` の OpenAPI から生成したクライアント（`packages/api-client`）だけを使う |
| 部品 | 自前の部品集（`packages/ui`）。アクセシビリティの規則（8 節）を部品の側で守る |
| 描画 | サーバーでの描画は使わない。明細は保存した表示の文書（JSON）を画面で描き、PDF は保存したものを取り出す（[ADR-0036](../decisions/0036-payslips-wage-ledger-and-e-delivery-consent.md)） |

- [architecture/README.md](README.md) の 4 節は「一部をサーバーで描画（明細、帳票）」としていた。明細の PDF は確定のときに決定的に作ると決まったので（ADR-0036）、画面の描画に SSR は要らない。README の該当の行は統合の工程で直した。

### 3.2 画面の一覧（MVP）

| 利用者 | 画面 | 中身 | 主な API |
| --- | --- | --- | --- |
| 従業員 | ホーム | やること（受信箱の件数、未提出のもの、締めの確認）、打刻、次の支給日、年休の残り | 受信箱、打刻、休暇 |
| 従業員 | 自分の情報 | 氏名、住所、連絡先、扶養、口座（末尾 4 桁）、所属・職務。時点の切り替え（5 節） | 時点の問い合わせ |
| 従業員 | 変更の申請 | 住所、氏名、口座、扶養、緊急連絡先（[core-hr.md](core-hr.md) の 6 節） | 業務プロセスの起票 |
| 従業員 | 打刻 | 出勤・退勤・休憩、今日の記録、未送信の件数（4 節） | 打刻 |
| 従業員 | 勤怠 | 日ごとの記録、訂正の申請、乖離の理由、月の締めの確認 | 勤怠 |
| 従業員 | 休暇 | 残日数（付与ごと・失効の日）、申請、取消、年 5 日の進み | 休暇 |
| 従業員 | 明細 | 月ごとの一覧、明細の表示、PDF、電子交付の承諾（[payments-and-accounting.md](payments-and-accounting.md) の 4.3 節） | 明細 |
| 従業員 | マイナンバー | 提出と本人確認の入口。中身は保管庫の画面（[my-number-vault.md](my-number-vault.md) の 4 節） | 保管庫 |
| マネージャー | チーム | 部下の一覧（時点つき）、組織図 | 一覧、組織図 |
| マネージャー | 受信箱 | 承認・差し戻し・却下、まとめての承認（6 節） | 受信箱 |
| マネージャー | 勤怠の状況 | 部下の残業の実績と見込み、36 協定の段、締めの確認 | 勤怠 |
| マネージャー | 起票 | 異動、昇給（権限があるとき）、時季の指定 | 業務プロセスの起票 |

- 人事・給与の担当の画面（案件の一覧、給与の実行、確認の検査）は、同じ部品で各領域の Story が作る。
- マネージャーには、給与の額を既定で見せない（[security-model.md](security-model.md) の 6 節）。昇給の起票の画面は、起票者の権限で見える項目だけを出す。

## 4. 打刻の画面とオフライン（[ADR-0038](../decisions/0038-single-responsive-spa-and-offline-clock.md)）

- 打刻の画面は、SPA の中の 1 画面だが、Service Worker で資産を先に保存し、通信がなくても開ける。
- 打刻を押すと、端末で `client_event_id`（UUIDv7）と `occurred_at` を作り、IndexedDB の `pending_clock_events` に書いてから送る。送れたら消す（[time-and-attendance.md](time-and-attendance.md) の 3.2 節）。
- 画面に「未送信 N 件」を常に出す。送れない理由（オフライン、ログインの期限切れ）を出す。
- ログインの期限が切れていても、打刻は端末に貯める。次のログインで送る。貯めた打刻は、ログインした利用者の雇用の ID に結ぶ。**別の利用者が同じ端末でログインしたら、前の利用者の未送信の打刻を送らない**（端末に残し、元の利用者の次のログインで送る。72 時間を超えたら画面で警告する）。
- 共有の端末（工場の入口のタブレットなど）は、個人のログインの打刻ではなく、打刻機の連携（[integrations-and-bulk.md](integrations-and-bulk.md) の 8 節）で扱う。
- 位置の情報は取らない（[time-and-attendance.md](time-and-attendance.md) の 3.1 節）。
- 目標：押してから画面の確定の表示まで 300ms 以内（通信があるとき。NFR-005 の打刻 p99 300ms はサーバーの応答）。端末に書いた時点で「記録しました（未送信）」を出し、利用者を待たせない。

## 5. 有効日付の見せ方（[ADR-0039](../decisions/0039-effective-dated-views-and-change-requests.md)）

### 5.1 時点

- すべての人事のデータの画面は、「いつの時点か」を見出しの横に出す（既定は「今日」）。
- 時点は URL の `asOf=YYYY-MM-DD` に持つ。共有したリンクで同じ時点が開く。API の `effective_on` にそのまま渡す（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 7 節）。
- 過去の知識（`knownAt`）の切り替えは、`audit` の権限がある利用者の画面にだけ出す（[security-model.md](security-model.md) の 6 節）。出すときは、画面の上に帯で「YYYY-MM-DD hh:mm の時点で記録されていた内容」と常に示す。
- 日付はテナントの暦（S1 は日本時間）で出す。和暦の併記は利用者の設定（既定は西暦）。

### 5.2 将来の変更と保留中の案件

画面は、今の値に次の 2 つを重ねて示す。

| 種類 | 見え方 | 例 |
| --- | --- | --- |
| 将来の変更（完了した案件の、有効日が先の差分） | 項目の横に「4 月 1 日から：営業 2 課」 | 3 月に入れた 4 月 1 日付の異動 |
| 保留中の案件（承認待ち） | 項目の横に「申請中：住所の変更（5 月 1 日から）」と案件へのリンク | 本人の住所の変更の申請 |

- 同じ項目に保留中の案件があるとき、新しい申請の画面は警告を出す（二重の申請を防ぐ。止めはしない。業務プロセスの完了のときの見ていた版の確認で扱う。[business-process-engine.md](business-process-engine.md) の 6.3 節）。
- 履歴の画面は、期間の帯（タイムライン）と、差分の一覧（変更・訂正・取消の種類つき）で出す（[object-model-and-effective-dating.md](object-model-and-effective-dating.md) の 7.4 節）。

### 5.3 変更の申請の画面

- **有効日を必須にする。** 既定の値は置かない（「今日」を黙って入れない）。候補（今日、来月の 1 日）をボタンで出す。
- 有効日が今日より前なら、「過去の日付での変更です。確定した給与に差額が出ることがあります」と出す（[ADR-0028](../decisions/0028-retro-deltas-and-bonus-runs.md)）。90 日より前は権限が要る（`retro_override`）。
- **「訂正」は別の操作にする。** 「変更」は「その日から変わった」、「訂正」は「もともと誤っていた」。訂正は履歴の画面の差分の行から始め、元の差分と理由を示す（[ADR-0007](../decisions/0007-change-correction-rescind-semantics.md)）。本人のセルフサービスには訂正を出さない（人事の担当の操作）。
- 起票の画面は、読んだ版の ID（`based_on_version_ids`）を案件に持たせる（ADR-0007 の Consequences）。
- `SAME_DAY_CONFLICT` などの拒否は、定型の文と直し方（「訂正として出し直す」）を出す（[ADR-0006](../decisions/0006-temporal-table-triplet-and-fold.md) の Consequences）。
- 休職の開始は、休暇の申請の画面からはできない。「休職は人事に相談してください」を出す（[ADR-0025](../decisions/0025-special-leave-and-leave-of-absence-boundary.md) の Consequences）。
- 振込先の口座の変更は、次の給与の締め切りを出す（「5 月 25 日の支給に反映するには 5 月 15 日までに承認が必要です」。[core-hr.md](core-hr.md) の 6 節）。

## 6. 受信箱

- 受信箱は `inbox_items` の射影と、今日の委任の結びで読む（[ADR-0015](../decisions/0015-bp-deadlines-reminders-and-inbox.md)）。画面は 1 回の API の呼び出しで一覧を出す。目標は p95 500ms（NFR-005）。
- 並びの既定は期限の近い順。期限を過ぎたものは先頭に印をつける。
- 案件の画面は、承認者の権限で見える項目だけを出す。委任で操作しているときは、委任した人と代理人の共通部分（[business-process-engine.md](business-process-engine.md) の 7 節）と、「○○さんの代理」の帯を出す。
- **まとめての承認**：同じ業務プロセスの種類で、選んだ案件を 1 回の操作で承認できる。ただし、給与・口座・退職・権限の種類はまとめての承認の対象にしない（1 件ずつ中身を見る）。まとめての承認でも、案件ごとに職務分掌と除外を確かめる（[ADR-0014](../decisions/0014-bp-routing-and-delegation.md)）。給与の変更の額を一覧に出すかは持ち越し（[business-process-engine.md](business-process-engine.md) の 17 節）。
- 通知（メール）の本文には、業務プロセスの種類と件数と、ログインを要するリンクだけを書く（ADR-0015）。リンクは受信箱の案件の URL で、トークンを含めない。

## 7. 多言語（[ADR-0038](../decisions/0038-single-responsive-spa-and-offline-clock.md)）

- MVP の言語は日本語（既定）と英語。利用者の設定で選ぶ。テナントの既定の言語をテナントの管理者が決める。
- 文言は ICU MessageFormat の辞書（`packages/i18n`。キーは画面と用途で名前を付ける）に持つ。コードに文言を直接書くことを lint で禁じる。
- 数・日付・通貨は `Intl` で出す。金額は整数の円を 3 桁区切りで出す（`packages/money` の表示の関数。`number` に変えない）。
- 法令の名前（甲欄、標準報酬月額、36 協定など）は、英語の画面でも日本語の用語を併記する（誤訳で意味が変わるのを防ぐ）。英語の訳語の一覧は、社労士の確認のいらない表示の用語として QA が持つ。
- テナントが持つ名前（組織、職務、業務プロセスの表示の名前、休暇の種類）は、テナントが言語ごとに入れる。英語が空なら日本語を出す。
- 明細・帳票の PDF は日本語だけ（法定の記載の事項の表示）。英語の画面では、明細の表示の文書から英語の見出しで描く（金額と項目は同じ文書）。
- 通知のメールも利用者の言語で出す。

## 8. アクセシビリティ

- 目標：WCAG 2.2 の AA。国内の規格の JIS X 8341-3:2016 は WCAG 2.0 と一致する規格で、WCAG 2.2 の AA を満たせば、その達成基準を含む（WCAG 2.2 は WCAG 2.0 の達成基準をほぼ含む。[WAIC の Q&A](https://waic.jp/qa/jis-wcag/)、2026-09-28 に検索の要約で確認。細部は未検証）。
- 部品（`packages/ui`）で守る：キーボードだけで操作できる、フォーカスが見える、フォームの項目にラベルとエラーの説明を結ぶ、色だけで状態を示さない（36 協定の段は色と文字）、タップの対象は 24×24 CSS ピクセル以上。
- 時点の帯・将来の変更・保留中の案件（5 節）は、スクリーンリーダーで読める文にする（アイコンだけにしない）。
- 打刻のボタンは、押した結果を `aria-live` で読み上げる。
- 検査：PR の CI で axe の自動検査（違反 0 件）。E5 の完了の前に、スクリーンリーダー（VoiceOver、NVDA）での手の確認を QA が行う。

## 9. スマートフォンのブラウザ

- 幅 360 CSS ピクセルで、3.2 節の従業員とマネージャーの画面がすべて使える。人事・給与の担当の画面は、タブレット以上を対象にする（表が多い）。
- 対象のブラウザ：iOS の Safari、Android の Chrome の最新と 1 つ前の版。PC は Chrome・Edge・Safari・Firefox の最新と 1 つ前の版。
- Service Worker は打刻の画面の資産にだけ使う。他の画面の API の応答を保存しない（個人情報を端末に残さない）。
- ログアウトのとき、IndexedDB の未送信の打刻以外の保存を消す。

## 10. セキュリティとプライバシー

- API の応答の個人情報をブラウザの保存（localStorage、IndexedDB）に書かない。例外は未送信の打刻（`client_event_id`、種類、時刻、雇用の ID だけ）。
- CSP：`script-src 'self'`、`frame-ancestors 'none'`。外部のスクリプト（分析のタグなど）を入れない。
- 画面の計測（11 節）の値に、氏名・額・入力の値を入れない。
- マイナンバーの入力は、保管庫が配る画面（別のオリジン。[my-number-vault.md](my-number-vault.md) の 4 節）で行う。人事の SPA のコードは番号に触れない。
- 口座番号は末尾 4 桁だけを出す。全桁の入力の欄は、入力の後に伏せる。

## 11. 画面の計測（K8）

- K8「従業員の申請（住所の変更、休暇）が、説明なしで 3 分以内に終わる割合 90% 以上」を計測する。
- 画面は、申請の開始（画面を開いた時刻）と送信の時刻を、案件の ID と一緒に計測の API に送る。値は時間と画面の名前と結果だけ。
- 集計は Worker が日次に行い、`ui_task_timings` に置く（個人を特定しない。雇用の ID は持たない）。
- E5 の利用者の試験（合成のデータのテナント）で、初めて使う人の完了の時間を測る。

## 12. テスト

### 12.1 決定表

- DT-UI-001：変更の申請の画面の有効日の扱い（今日・過去 90 日以内・90 日より前 × 権限 × 確定した給与の期間にかかるか → 受ける・警告・拒否）。
- DT-UI-002：まとめての承認の可否（業務プロセスの種類 × 委任の有無 × 職務分掌 → 受ける・1 件ずつ・拒否）。

### 12.2 性質ベーステスト

| ID | 性質 |
| --- | --- |
| PROP-UI-001 | 任意の未送信の打刻の列と、任意の通信の断・再開・ログアウト・別の利用者のログインの列で、送信された打刻の集合は、元の利用者が押した打刻の集合と一致し、別の利用者の雇用に結ばれない |
| PROP-UI-002 | 任意の `asOf` の画面の表示は、同じ `effective_on` の API の応答と一致する（画面が値を作らない） |

### 12.3 E2E

- Playwright：3.2 節の画面の主な流れを、日本語と英語、PC とスマートフォンの幅で。
- 打刻のオフライン：通信を切って 3 回押し、戻して送られること。
- axe の自動検査。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E5 | `ui-shell-and-design-system` | 3.1 節。`packages/ui`、`packages/i18n`、ルーティング、権限による画面の出し分け、axe の CI |
| E5 | `ui-as-of-and-history` | 5.1・5.2 節（PROP-UI-002） |
| E5 | `ui-change-requests` | 5.3 節（DT-UI-001）。住所・氏名・口座・扶養・緊急連絡先 |
| E5 | `ui-inbox` | 6 節（DT-UI-002）。[business-process-engine.md](business-process-engine.md) の受信箱の画面もこの Story にまとめた |
| E5 | `ui-manager-team` | チーム、組織図、起票 |
| E5 | `ui-task-timing` | 11 節（K8） |
| E6 | `ui-clock-offline` | 4 節（PROP-UI-001） |
| E6 | `ui-timesheet-and-overtime` | 勤怠、乖離の理由、36 協定の段 |
| E7 | `ui-time-off` | 休暇の申請と残り |
| E10 | `ui-payslips` | 明細の一覧・表示・PDF・承諾 |
| E11 | `ui-my-number-entry` | 保管庫の画面への入口（[my-number-vault.md](my-number-vault.md)） |

## 14. 未解決の問い

### 決定

- **ネイティブのアプリを作らない。** スマートフォンのブラウザで同じ SPA を使う。
- **画面の描画に SSR を使わない。** 明細は保存した文書を描き、PDF は保存したものを取り出す。
- **時点は URL に持つ。** 変更の申請の有効日に既定の値を置かない。
- **本人のセルフサービスに訂正の操作を出さない。**
- **給与・口座・退職・権限の案件は、まとめての承認の対象にしない。**
- **アクセシビリティの目標は WCAG 2.2 の AA。**

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| まとめての承認で給与の変更の額を一覧に出すか | E5 で PM と利用者の試験で決める |
| プッシュ通知（Web Push）を使うか | E5 の後。通知の本文の規則（個人情報を入れない）は同じ |
| 英語以外の言語 | 需要を見て MVP の後 |
| 和暦の既定 | E5 の利用者の試験で |
| 打刻の画面の PWA のインストールを勧めるか | E6 で、iOS の Safari の Service Worker の保存の期間を確かめてから（未検証） |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- K8 の割合（目標 90% 以上）と、画面ごとの完了の時間の分布。
- 未送信の打刻の最大の滞留時間（端末からの報告）と、72 時間を超えて届いた件数。
- axe の違反 0 件と、手の確認の記録。
- 受信箱の p95（NFR-005）。

### runbooks

- `ui-asset-release-rollback.md`：静的な資産の配布の戻し方（CloudFront の無効化、前の版の資産の再配布）。
- 大量の端末から貯めた打刻が一度に届いたときの確認：[time-and-attendance.md](time-and-attendance.md) の `clock-ingest-backlog.md` にまとめた（統合の工程で決めた。[runbooks/README.md](../runbooks/README.md) の 4 節）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `user_preferences` | 言語、和暦の併記、既定の画面 |
| Aurora `ui_task_timings` | 11 節。個人を特定しない集計 |
| ブラウザ IndexedDB `pending_clock_events` | 4 節（[time-and-attendance.md](time-and-attendance.md) と同じ） |
| S3 `web-assets/{version}/` | SPA の静的な資産 |

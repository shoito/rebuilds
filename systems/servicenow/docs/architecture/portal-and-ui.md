# Portal and UI: ServiceNow

作業の画面（データ辞書から組み立てるフォームとリスト、関連リスト、画面の規則）、従業員のポータル（テーマと決まった部品）、アプリのプッシュ、多言語（日本語・英語）、アクセシビリティを決める。

前提の決定は、テナントに任意のコードと HTML を持たせないこと（[ADR-0001](../decisions/0001-platform-and-stack.md)、[intent.md](../intent.md) の Non-goals）、辞書を組み込みとテナントの定義の重ね合わせで持ち、`meta_version` ごとにコンパイルすること（[ADR-0006](../decisions/0006-data-dictionary-and-field-types.md)、[ADR-0010](../decisions/0010-metadata-versions-and-config-packages.md)）、読めない値を画面に出さないこと（[ADR-0012](../decisions/0012-acl-enforcement-at-every-exit.md)）、カタログの表示の条件を画面とサーバーで同じ評価器で評価すること（[ADR-0028](../decisions/0028-catalog-items-and-variables.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0040](../decisions/0040-metadata-driven-forms-and-lists.md) | フォームとリストは、サーバーが辞書・配置・画面の規則・ACL から「画面のモデル」をコンパイルして返し、画面はそれを描くだけにする。画面の規則は式の言語で書き、画面とサーバーで同じ評価器を使い、サーバーを正とする。リストはキーセットのページ送りで、件数は上限付きで数える |
| [0041](../decisions/0041-employee-portal-themes-widgets-and-push.md) | 従業員のポータルは、作業の画面と同じホスト名の別の画面の束にする。見た目はテーマのトークンと決まった部品の配置だけで変える。プッシュは Web Push（ホーム画面に置いた PWA を含む）で送り、ネイティブのアプリは MVP で作らない |
| [0042](../decisions/0042-i18n-ja-en-and-translations.md) | 画面の文言はコードのバージョンの ICU MessageFormat の辞書に持ち、テナントのラベル（テーブル・フィールド・選択肢・カタログ・通知）は安定したキーの翻訳の表に持つ。言語は利用者 → テナントの既定 → 日本語の順に決める。日時は利用者のタイムゾーンで表示し、保存は UTC |

この文書の決定表・性質は設計の草案である。ID は E2・E6・E8 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：作業の画面の構成、フォーム・リスト・関連リストの組み立て、画面の規則（表示・必須・読み取り専用）、保存の衝突の画面での扱い、ダッシュボードの枠（中身は [reports.md](reports.md)）、従業員のポータル（申請・報告・自分のチケット・承認・ナレッジ）、テーマと部品、Web Push、多言語、アクセシビリティ、画面の配信とキャッシュ。
- 扱わない：ACL の判定（[access-control.md](access-control.md)）、カタログの変数と回答の正規化（[service-catalog-and-requests.md](service-catalog-and-requests.md)）、検索の索引（[search.md](search.md)）、通知の本文（[notifications-and-email-ingest.md](notifications-and-email-ingest.md)）、セッションと SSO（[access-control.md](access-control.md) の 9 節）。
- **画面は Record Service の出口の 1 つである。** 画面のための抜け道の API を作らない（[access-control.md](access-control.md) の 6.2 節の 1〜8・16 行）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| 画面の規則 | UI の方針（UI policy）は、条件に合うと、フィールドを表示・必須・読み取り専用にする。ブラウザで評価し、条件は利用者がフィールドを変えたときに評価し直す。値の消去は、本家の SDK の文書（[UI Policies](https://servicenow.github.io/sdk/guides/ui-policy-guide)）にあるが公式の製品の文書では未検証 | [Using UI policies](https://www.servicenow.com/docs/bundle/zurich-platform-administration/page/administer/form-administration/task/t_CreateAUIPolicy.html) |
| 多言語 | 国際化のプラグインと、言語ごとの翻訳のプラグイン（日本語を含む）を有効にする。翻訳した値はフィールドの種類ごとに別の表に持つ | コミュニティの記事（[ServiceNow Localization and Language Translation](https://www.servicenow.com/community/itsm-forum/servicenow-localization-and-language-translation/m-p/3455929)）。公式の本文は未検証（本家の振る舞いで、設計の前提ではない） |
| ポータル | 部品（widget）とテーマで作り、部品は複製して中身（HTML・スクリプト）を変えられる | [Employee Center widgets](https://www.servicenow.com/docs/r/employee-service-management/employee-experience-foundation/employee-center-widgets-list.html)（検索の結果の抜粋で確認。本文は未検証で、本家の振る舞いで、設計の前提ではない） |

- 本家は部品の中身とクライアントのスクリプトを顧客が書ける。本システムは書かせない（[intent.md](../intent.md) の Non-goals）。本家の画面の名前・部品の名前は写さない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 3. 画面の構成

```
<tenant>.<brand>.<domain>
  /            … 作業の画面（担当者・承認者・管理者）。React の SPA
  /portal      … 従業員のポータル。別の画面の束（依頼者の端末は遅い回線とスマートフォンを前提にする）
  /admin       … 設定（辞書・フロー・ACL・SLA）。作業の画面の束の中の画面群。ロールで出し分ける
  /api/v1/...  … REST API（api-and-integrations.md）。画面も同じ API を使う
  /ui/v1/...   … 画面のモデルの API（4 節）。画面だけが使う読み取りの API
静的な資産：cdn.<brand>.<domain>（テナントに依らない。バージョンの付いたファイル名で長くキャッシュする）
```

- **画面の束は全テナントで同じもの**にする。テナントごとに違うのは、画面のモデル（辞書・配置・規則）とテーマのトークンだけである。テナントのファイル（JavaScript・CSS）を配らない。
- 画面の束のバージョンは、App のバージョンと同じ日に出す。古い束を開いたままの利用者には、App が「新しいバージョンがある」を返し、画面の保存の後に読み直させる（保存の途中で切り替えない）。
- 画面の束と API の互換は、1 つ前のバージョンまで保つ（[delivery.md](delivery.md) の 5 節）。

## 4. フォームとリスト（[ADR-0040](../decisions/0040-metadata-driven-forms-and-lists.md)）

### 4.1 画面のモデル

画面は、サーバーから受け取った「画面のモデル」を描くだけにする。

```
GET /ui/v1/form/{table}/{id}?view=default
→ {
    meta_version, acl_version,
    layout:  セクション・列・フィールドの順（form_layout の実効の値）,
    fields:  { field_id: { type, label（利用者の言語）, mandatory, read_only, choices?, ref? } },
    rules:   画面の規則（式の木。4.3 節）,
    record:  { version, values: 読めるフィールドだけ（キーも読めないものは入れない）,
               display: 参照の表示の値（読めるものだけ）},
    writable: 書けるフィールドの ID の集合,
    related: 関連リストの定義（中身は別の要求）,
    actions: 今の状態で出せる操作（状態の遷移の表と ACL から。itsm-processes.md の 3 節）
  }
```

- **レコードの値と、フィールドの属性と、書けるフィールドの集合は、同じ要求で同じ `acl_version` から作る。** 画面は、書けないフィールドを入力にしない。書けないフィールドの値を送っても、サーバーは DT-DICT-001 と ACL で拒否する（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 5 節）。
- 配置と規則の部分は `(tenant_id, meta_version, table, view, 言語)` で作り、App のメモリーと Valkey にキャッシュする。レコードの部分と `writable` は、要求ごとに作る。
- `actions` は、状態の遷移の表（[ADR-0022](../decisions/0022-process-state-machines.md)）のうち、今の状態から出られ、主体のロールで許されるものだけを出す。押しても `guard` や必須で 422 になりうる（画面は理由を出す）。

### 4.2 配置

| 表 | 中身 |
| --- | --- |
| `form_layout` | `table_id`、`view`（`default`・`portal`・テナントの名前）、セクション（見出しのラベルのキー、列の数、フィールドの ID の並び）、関連リストの並び |
| `list_layout` | `table_id`、`view`、列（フィールドの ID、参照のたどりは 1 段まで）、既定の並べ替え、既定のフィルター |
| `view_rule` | どの主体にどの `view` を使うか（ロール・グループの条件。上から最初に一致したもの） |

- 配置はメタデータで、`meta_version` の対象、パッケージで移送できる（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 10.1 節）。
- 組み込みのテーブルの既定の配置は、コードのバージョンに持つ。テナントは `view` を足すか、既定の配置を上書きする。
- 利用者ごとのリストの列の並びと保存したフィルターは `user_list_pref` に持つ。メタデータではない（パッケージで移さない）。
- 配置に読めないフィールドがあっても、画面のモデルからは落とす。空のセクションは出さない。

### 4.3 画面の規則

- 規則は `ui_rule(table_id, view?, condition, actions[{field_id, visible?, mandatory?, read_only?, set_value?}], order, on_load)`。条件と `set_value` は式の言語で書く（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **画面とサーバーで同じ評価器を使う。** 評価器は TypeScript の純粋な関数のパッケージで、画面の束とサーバーの両方に入る（カタログの変数と同じ。[ADR-0028](../decisions/0028-catalog-items-and-variables.md)）。
- **サーバーを正とする。** 保存の時、Record Service は保存の後の値で規則を評価し直す（保存の流れの 4 段の辞書の検証の中）。

DT-UI-001（保存の時の画面の規則の適用）：

| # | 規則の結果 | 送られた値 | 結果 |
| --- | --- | --- | --- |
| 1 | `mandatory` かつ `visible` | 空 | 422 `mandatory`（画面の規則による必須も、辞書の必須と同じ扱い） |
| 2 | `mandatory` だが `visible = false` | 空 | 許す（見えない必須は求めない） |
| 3 | `read_only` | 今の値と違う | 403 `field_read_only` |
| 4 | `read_only` | 今の値と同じ | 無視する |
| 5 | `visible = false` | 今の値と違う | 許す（隠すのは表示のためで、権限ではない。権限は ACL で決める） |
| 6 | - | - | 辞書の検証（DT-DICT-001）に従う |

- 5 行の理由：画面の規則は業務の入力の補助で、秘密を守る仕組みではない。値を守るのはフィールドの ACL である。規則で隠した値が API で書けることは、利用者向けの文書に書く。カタログの変数は、見えない値を捨てる（DT-VAR-001）ので扱いが違う。カタログの回答は申請の入力で、フォームのフィールドはレコードの値だからである。この違いは意図したもので、[service-catalog-and-requests.md](service-catalog-and-requests.md) の 4.2 節にも同じことを書いた（統合で決めた）。
- `set_value` は画面だけで動かす（入力の補助）。サーバーの値の設定は、レコードのルール（[ADR-0017](../decisions/0017-no-code-record-rules.md)）で行う。同じことを 2 か所で決めないためである。
- 規則は 1 テーブル・1 `view` で 100 まで、1 つの規則の式の評価は 5ms まで（ACL の条件と同じ上限）。

### 4.4 保存と衝突

- フォームは読んだときの `version` を送る。違えば 409 `record_changed`（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 4.1 節）。
- 409 のとき、画面は相手の変更（変わったフィールドとその値。読めるものだけ）と自分の変更を並べ、フィールドごとに選ばせる。重なりのないときは「自分の変更を今のバージョンに当て直す」を 1 回の操作で出す。自動では当て直さない（状態の遷移を黙って二重にしないため）。
- 作業メモ・コメントの追記は、レコードの `version` を条件にしない（追記どうしはぶつからない）。
- 他の人が同じレコードを開いていることの表示（在席）は MVP に入れない（持ち越し）。

### 4.5 リスト

- 問い合わせは Record Service のリストの出口（[access-control.md](access-control.md) の 6.2 節の 2〜4 行）を通す。列は `visible(f)` で読む。
- **ページ送りはキーセット（並べ替えのキー＋`id`）にする。** 1 ページ 50 行（最大 100）。任意のページへの飛び越しは、先頭から 10,000 行までだけ許す（`OFFSET` を大きくしない）。
- **件数は上限付きで数える。** `count(*)` を 10,001 行で打ち切り、超えたら「10,000 件以上」と出す。ACL の述語を入れた件数なので、読める行だけを数える（件数から推測できない）。
- 絞り込みは、索引のある列（型付きの列、`ext_index` のフィールド）だけを既定で出す。索引のないテナントのフィールドは、索引のある条件で 10,000 行以下に絞ったときだけ使える（[ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)）。
- 読めないフィールドは、列・絞り込み・並べ替えの選択肢に出さない（[access-control.md](access-control.md) の 6.1 節）。
- リストの自動の更新は、30 秒ごとのバージョンの確かめ（`max(updated_at)` と件数の変化）で「新しい行があります」を出す。行を勝手に入れ替えない（担当者の作業中の視線を動かさない）。

### 4.6 関連リストと参照

- 関連リストは、関連の先のテーブルでのリスト（6.2 節の 8 行）で、1 つのフォームで最初の 1 ページだけを同じ往復で返す（NFR-001 の「関連リストの最初の 1 ページ」）。2 つ目以降のタブは開いたときに読む。
- 参照のフィールドの入力は、参照先のテーブルでの読める行の前方一致（表示のフィールド）で候補を出す。候補の問い合わせも ACL を通す。表示の値は、読めないときは「（表示できないレコード）」とし、ID も出さない（6.2 節の 6 行）。

## 5. 作業の画面の主な画面

| 画面 | 中身 | 関わる領域 |
| --- | --- | --- |
| 自分の作業 | `task` の `assigned_to = me` と、自分のグループの未割り当て。SLA の残り時間の順 | [sla-and-calendars.md](sla-and-calendars.md) の 6.6 節（残り時間は読み取りの時に計算） |
| インシデント・問題・変更・要求のフォーム | 4 節のモデル。上部に番号・状態・優先度・SLA の帯、下に作業メモとコメントの時系列 | [itsm-processes.md](itsm-processes.md) |
| メジャーインシデントの画面 | 候補の一覧、昇格・却下、子のインシデント、影響を受けるサービス、状況の更新の周期 | [itsm-processes.md](itsm-processes.md) の 6 節 |
| 変更の予定表 | 期間の中の変更・禁止期間・保守の時間帯。衝突の印 | [itsm-processes.md](itsm-processes.md) の 9 節 |
| CAB の会議 | 議題、各承認者が自分の承認に 1 回の操作で答える枠 | [itsm-processes.md](itsm-processes.md) の 8.6 節 |
| CI の画面 | 属性と来歴（どの取り込み元がどの値か）、関係、影響の範囲（見る人の範囲） | [cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) |
| 保留の一覧 | メールの保留、CI の保留、トリガーの抑え | [notifications-and-email-ingest.md](notifications-and-email-ingest.md)、[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md)、[workflow-engine.md](workflow-engine.md) |
| ダッシュボード | レポートの部品の並び | [reports.md](reports.md) |
| 全体の検索 | テーブルを横断する検索 | [search.md](search.md) |
| 設定 | 辞書、配置、画面の規則、フロー、ACL、SLA、通知、カタログ | 各領域 |

- キーボードだけで主な操作ができるようにする（リストの行の移動、フォームの保存、作業メモの追加）。担当者は 1 日に数百件を扱う。
- 画面の文言で「ITIL」の商標を使うかは法務の確認待ち（[intent.md](../intent.md) の L6）。E6 の画面の文言の確定まで、一般の言葉（インシデント、変更など）だけを使う。

## 6. 従業員のポータル（[ADR-0041](../decisions/0041-employee-portal-themes-widgets-and-push.md)）

### 6.1 画面

| 画面 | 中身 |
| --- | --- |
| ホーム | 検索の箱、よく使う品目、自分の開いているチケット、承認の依頼、お知らせ |
| カタログ | カテゴリと品目（見える品目だけ。[service-catalog-and-requests.md](service-catalog-and-requests.md) の 6.1 節）、申請のフォーム |
| 障害の報告 | 報告のフォーム（フォームからのレコードの作成。同じ文書の 7 節）。入力の途中にナレッジの候補を出す |
| 自分のチケット | 自分が依頼した・自分のための・見守りの要求とインシデント（DT-REQ-002）。コメントの追加、再オープン |
| 承認 | 自分への承認の依頼。承認・却下を 1 回の操作で（[ADR-0016](../decisions/0016-approvals.md)）。成り代わりの間は出さない |
| ナレッジ | 検索と記事。評価、「解決した」の押下（[knowledge.md](knowledge.md) の 7 節） |

- ポータルの読み書きも Record Service の出口を通る（DT-ACL-003 の 16 行）。ポータルのための別の権限の判定を作らない。
- 自己解決の事象（`portal_event`）は、画面から一括で送る（[knowledge.md](knowledge.md) の 7.3 節）。利用者の ID と検索の語を入れない。

### 6.2 テーマと部品

- **見た目はテーマのトークンだけで変える。** トークン：主の色・副の色・文字の色・背景の色、ロゴ（画像）、角の丸み、文字の大きさの段（標準・大）。色の組は、保存の時にコントラストの比を検査し、WCAG 2.2 の AA（本文 4.5:1）に届かなければ保存させない。
- **部品は決まった種類だけにする。** 部品：お知らせ、よく使う品目、カテゴリの一覧、検索の箱、自分のチケット、承認の依頼、ナレッジの記事の一覧、リンクの一覧、文章（制限付きの Markdown。[knowledge.md](knowledge.md) の 3.5 節と同じ描き方）。ページは部品の配置（行と列）で作る。
- テナントの HTML・CSS・JavaScript は受けない。画像はテナントの添付として受け、`image/png`・`image/jpeg`・`image/webp` だけにする（SVG は受けない。スクリプトを含めうるため）。
- ポータルは既定で 1 つ。子会社ごとに別のポータル（別のテーマと品目の並び）を 5 つまで持てる。URL は `/portal/{portal_key}`。

### 6.3 性能

- 依頼者の端末は遅い回線とスマートフォンを前提にする。ポータルの画面の束は作業の画面と分け、最初の表示の JavaScript を圧縮の後 200 KB 以内にする（目標。E8 で測る）。
- ポータルの最初の表示の LCP を p75 2.5 秒以内にする（RUM。[observability.md](observability.md) の 3.2 節）。

### 6.4 プッシュ

- **Web Push で送る。** 作業の画面とポータルは PWA にし、利用者が許可したら購読を `push_subscription` に持つ。iOS・iPadOS は 16.4 から、ホーム画面に置いた Web アプリで Web Push を受けられる。Safari のタブの中では受けられない（[Web Push for Web Apps on iOS and iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)、2026-09-28 に確認）。
- 通知の本文は短くし、レコードの値を入れない（「INC0001234 に割り当てられました」まで）。押すと画面を開き、ログインの後に値を見せる。プッシュの配信の事業者（ブラウザの提供者）を経るので、値を事業者に渡さない（[security.md](security.md) の 3 節）。
- 当番の呼び出しの受け付け（[ADR-0027](../decisions/0027-on-call-rotations-and-escalation.md)）は、プッシュを押して開いた画面で、ログインのセッションで本人を確かめて行う。夜中の受け付けのために、当番の利用者だけ「端末のセッション」を長く保つ（最大 14 日、無操作 7 日。端末の生体の認証の再確認（WebAuthn の利用者の確認）を受け付けの前に求める）。値は [security.md](security.md) の 5 節で決める。
- ネイティブのアプリ（App Store・Google Play）は MVP で作らない（持ち越し）。Android の Chrome とデスクトップのブラウザは Web Push を受けられる。

## 7. 多言語（[ADR-0042](../decisions/0042-i18n-ja-en-and-translations.md)）

### 7.1 言語の決め方

```
表示の言語 = user.language（ja | en）
           → なければ tenant.default_language
           → なければ ja
```

- ログインの前の画面（SSO の選択、パスワードのログイン）は、ブラウザの `Accept-Language` とテナントの既定で決める。
- MVP の言語は `ja` と `en` だけ。言語を足すのは、文言の辞書と翻訳の表に行を足すだけで済む形にする（コードの分岐を作らない）。

### 7.2 2 種類の文言

| 種類 | 置き場所 | 例 |
| --- | --- | --- |
| 画面の決まった文言 | コードのバージョンの ICU MessageFormat の辞書（`ja.json`・`en.json`） | ボタン、エラー、組み込みの状態のラベル、組み込みのフィールドのラベル |
| テナントが作った文言 | `translation(tenant_id, stable_key, attribute, locale, text)` | テナントのテーブル・フィールド・選択肢のラベル、カタログの品目と変数、ポータルの部品の文章、通知のテンプレート（[notifications-and-email-ingest.md](notifications-and-email-ingest.md) の 4 節の「言語ごと」） |

- 翻訳の表はメタデータで、`meta_version` の対象、パッケージで移送できる。キーは `stable_key`（名前ではなく安定したキー）にする。
- テナントの文言に訳がなければ、作成の時の言語の文言を出す（空にしない）。画面の管理者の画面に「訳のない文言」の一覧を出す。
- 組み込みの文言の辞書は、キーの抜けを CI で検査する（`ja` と `en` のキーの集合が等しいこと）。
- ナレッジの記事の翻訳のバージョンは持ち越し（[knowledge.md](knowledge.md) の 1 節）。

### 7.3 日時・数・文字

- 保存は UTC（`timestamptz`）。表示は利用者の `time_zone`（なければテナントの既定、なければ `Asia/Tokyo`）で行う。SLA の期限の表示は、計時の行のタイムゾーンではなく見る人のタイムゾーンで出し、括弧で計時のタイムゾーンを添える（海外の拠点の SLA の読み違いを防ぐ）。
- 日付の書式は `Intl.DateTimeFormat` の言語ごとの既定（`ja`：`2026/09/28 09:00`）。和暦は MVP で出さない。
- 入力の文字列は NFC に正規化して保存する（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.3 節）。全角・半角の揺れ（ＡＢＣ と ABC）は保存では変えず、検索の解析で吸収する（[search.md](search.md) の 4 節）。
- 並べ替えは、日本語の読み（ふりがな）では行わない。文字列の並べ替えは DB の照合順序（`und-x-icu`）で行う。読みの並べ替えは持ち越し。

## 8. アクセシビリティ

- **WCAG 2.2 の AA を目標にする。** WCAG 2.2 は 2025 年に ISO/IEC 40500:2025 になり、JIS X 8341-3 は ISO/IEC 40500:2025 との一致規格への改正の作業中である（[JIS X 8341-3 改正概要（ウェブアクセシビリティ基盤委員会）](https://waic.jp/wp-content/uploads/2026/02/20260206-waic-a11y-seminar-2.pdf)、2026-09-28 に確認。原案は 2026 年 5 月ごろの完成を目標にしていた。2026-09-28 の時点で改正の JIS の公示は確かめられなかった）。公共機関の顧客への説明は、改正の JIS の発行の後に合わせる。
- 画面のモデルから描くので、ラベル・必須の印・エラーの結び付け（`aria-describedby`）を部品の側で一度だけ正しく作れば、全テナントのフォームに効く。
- 自動の検査（axe-core）を E2E の中で動かし、重大な違反 0 件を CI の条件にする（[delivery.md](delivery.md) の 2 節）。手での検査（スクリーンリーダー：NVDA と VoiceOver）を E8 と E12 で行う。

## 9. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| Valkey が落ちる | 画面のモデルの配置の部分を DB から作る。遅くなるが正しい |
| 画面のモデルのコンパイルの失敗（新しいコードで古い配置が読めない） | そのテーブルは組み込みの既定の配置で出し、管理者に知らせる。SEV3。リリースの前の全テナントの配置のコンパイルの検査で防ぐ（[delivery.md](delivery.md) の 4 節） |
| 静的な資産の配信（CloudFront）の障害 | 作業の画面が開けない。API は動く。SEV2 |
| 古い画面の束 | 1 つ前のバージョンまで API の互換を保つ。それより古ければ読み直させる |
| Web Push の配信の失敗 | 購読が失効（410）なら購読を消す。当番の呼び出しはメールの経路でも送る（[assignment-and-on-call.md](assignment-and-on-call.md) の 6 節） |

## 10. セキュリティ

- 画面は、テナントの HTML・スクリプトを描かない。テナントの文言は、React の既定のエスケープで描く。`dangerouslySetInnerHTML` は制限付きの Markdown の描画の部品だけが使い、許可の一覧のタグだけの HTML にサニタイズしたものだけを渡す（lint で強制する）。
- CSP：`script-src 'self' cdn.<brand>.<domain>`（nonce）、`object-src 'none'`、`frame-ancestors 'none'`、`base-uri 'none'`。画像はテナントの添付の署名付き URL と `cdn` だけ。
- Cookie はテナントのホスト名だけに付け、`Domain` を付けない（[access-control.md](access-control.md) の 9.1 節）。`SameSite=Lax`、`Secure`、`HttpOnly`。状態を変える要求は CSRF のトークンを要る。
- 画面のモデルの API（`/ui/v1`）は、REST API と同じ出口の判定を使う。画面だけが知る情報（書けるフィールドの集合）は、同じ主体で API からも求められる情報であり、秘密ではない。
- プッシュの本文にレコードの値を入れない（6.4 節）。

## 11. テスト

### 11.1 決定表

- DT-UI-001（保存の時の画面の規則）を、`spec.md` から読む表駆動テストにする。

### 11.2 性質ベーステスト

- **PROP-UI-001（画面とサーバーの一致）**：任意の画面の規則の集合と値の組で、画面の評価器とサーバーの評価器の結果（表示・必須・読み取り専用）が等しい。同じパッケージの同じ関数を両方で呼ぶので、束の作り方（別のビルド）の違いで結果が変わらないことを確かめる。
- **PROP-UI-002（画面のモデルは漏らさない）**：任意の辞書・配置・ACL・レコードで、画面のモデルに入る値の集合は、同じ主体の単体の取得（DT-ACL-003 の 1 行）で返る値の集合に含まれる。
- **PROP-UI-003（件数の上限）**：任意の行の数と ACL で、リストの件数は `min(読める行の数, 10,001)` と等しい。

### 11.3 E2E

- Playwright で、主な流れ（インシデントの作成から解決、変更の承認、ポータルの申請、承認の回答）を `ja` と `en` の両方で通す。
- 漏れの試験（[access-control.md](access-control.md) の 12.3 節）の画面の出口：画面のモデル、リスト、関連リスト、参照の候補、ポータル。
- アクセシビリティの自動の検査（8 節）。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `ui-model-api` | 4.1 節の画面のモデル、キャッシュ（PROP-UI-002） |
| E2 | `form-and-list-layouts` | 4.2 節の配置、`view_rule`、組み込みの既定 |
| E2 | `ui-rules-shared-evaluator` | 4.3 節、DT-UI-001、PROP-UI-001 |
| E2 | `list-keyset-paging-and-capped-count` | 4.5 節（PROP-UI-003） |
| E2 | `form-conflict-merge` | 4.4 節の 409 の画面 |
| E2 | `i18n-message-catalogs` | 7.2 節の組み込みの辞書、キーの抜けの CI |
| E2 | `tenant-translations` | 7.2 節の翻訳の表、訳のない文言の一覧 |
| E6 | `agent-workspace-core` | 5 節の自分の作業、フォームの帯、作業メモの時系列、キーボードの操作 |
| E6 | `major-incident-ui` | メジャーインシデントの画面 |
| E6 | `inbound-quarantine-ui` | メールの保留の一覧（notifications-and-email-ingest と一緒に） |
| E7 | `change-calendar-and-cab-ui` | 変更の予定表と CAB の会議の画面 |
| E8 | `portal-shell-and-themes` | 6.1・6.2 節、コントラストの検査 |
| E8 | `portal-catalog-ui` | カタログと申請（service-catalog-and-requests と一緒に） |
| E8 | `portal-approvals-mobile` | スマートフォンでの 1 回の操作の承認 |
| E8 | `web-push-and-pwa` | 6.4 節、購読、当番の端末のセッション |
| E9 | `portal-deflection-events` | 自己解決の事象（knowledge と一緒に） |
| E10 | `ci-form-provenance-and-impact` | CI の画面の来歴と影響の範囲 |
| E12 | `accessibility-audit` | 8 節の手での検査 |

## 13. 未解決の問い

### 決定（2026-09-28、既定案）

- **画面はサーバーの画面のモデルを描くだけ**（4.1 節、ADR-0040）。
- **画面の規則で隠したフィールドの値は保存で捨てない**。守るのは ACL（DT-UI-001 の 5 行）。カタログの変数とは扱いが違う。
- **リストはキーセットのページ送り、件数は 10,000 で打ち切る**（4.5 節）。
- **テナントの HTML・CSS・SVG を受けない**（6.2 節、ADR-0041）。
- **プッシュは Web Push。ネイティブのアプリは MVP で作らない**（6.4 節）。
- **言語は `ja`・`en`、利用者 → テナント → `ja` の順**（7.1 節、ADR-0042）。
- **WCAG 2.2 の AA を目標にする**（8 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| ネイティブのアプリ（当番の呼び出しの確実な受け取り、iOS の Web Push の制約） | E8 の後。当番の受け付けの時間の実測（[assignment-and-on-call.md](assignment-and-on-call.md) の quality の項目）を見て |
| 当番の端末のセッションの長さ（14 日・7 日） | E8 で [security.md](security.md) と一緒に |
| 在席の表示（同じレコードを開いている人） | MVP の後 |
| 読みでの並べ替え（ふりがなのフィールド） | 顧客の要望を見て |
| 画面の文言の「ITIL」の商標の使い方 | 法務の L6 の後 |
| ポータルの最初の表示の JavaScript の大きさ（200 KB）と LCP の目標 | E8 の計測 |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- フォームを開くまでの時間（RUM の p95、サーバーの p99）。NFR-001、K1。
- リストの 1 ページの時間（サーバーの p99）、`unindexed_filter` の件数。
- 409 `record_changed` の件数と、その後の当て直しの割合。
- 画面の規則の画面とサーバーの食い違い（PROP-UI-001 の本番の抜き取り。保存の時の DT-UI-001 の 1 行の 422 のうち、画面が必須を出していなかったもの）：0 件。
- ポータルの LCP の p75、スマートフォンの割合。
- アクセシビリティの自動の検査の重大な違反：0 件。
- 訳のない文言の件数（テナント別）。

### runbooks

- `ui-model-compile-failure.md`：画面のモデルのコンパイルの失敗で既定の配置になったときの対応。
- `static-assets-outage.md`：CloudFront の資産の配信の障害のときの確かめ方。
- `web-push-delivery-failure.md`：プッシュの配信の失敗の確かめ方（購読の失効、ブラウザの提供者の障害）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `form_layout`、`list_layout`、`view_rule`、`ui_rule` | 4.2・4.3 節。メタデータ |
| Aurora `user_list_pref` | 4.2 節。利用者ごと。パッケージで移さない |
| Aurora `portal`、`portal_page`、`portal_theme` | 6.2 節。メタデータ |
| Aurora `translation` | 7.2 節。メタデータ。`(tenant_id, stable_key, attribute, locale)` 一意 |
| Aurora `push_subscription` | 6.4 節。`(tenant_id, user_id, endpoint_hash)` 一意 |
| Valkey 画面のモデルの配置の部分 | 4.1 節。失われてもよい |
| コードのバージョン 組み込みの文言の辞書、組み込みの配置 | 4.2・7.2 節 |

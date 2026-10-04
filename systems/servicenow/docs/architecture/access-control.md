# Access control: ServiceNow

利用者・グループ・ロール、ACL（テーブル・行・フィールド × 作成・読み取り・書き込み・削除）、評価の順序と既定の拒否、継承したクラスの規則、判定のキャッシュ、値を返すすべての出口での適用、成り代わり、テナントの SSO（SAML・OIDC）を決める。

前提の決定は、テナントを RLS で分けること（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）、レコードの読み書きを Record Service だけが行うこと（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)）、そして [AGENTS.md](../../AGENTS.md) の「アクセス制御」の規則（1 つの判定の関数、決定表、既定の拒否、すべての出口でのフィールドの ACL）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0011](../decisions/0011-roles-groups-and-acl-evaluation.md) | ACL は「許可の条件」と「拒否の条件」の 2 種の規則で書く。拒否の条件はクラスの階層のすべての段で効き、許可の条件は最も近いクラスの規則だけを使う。一致する許可の規則がなければ拒否する。本家の「規則がなければ許可」は採らない |
| [0012](../decisions/0012-acl-enforcement-at-every-exit.md) | 行の規則の条件は SQL の述語にコンパイルできる式に限り、一覧・件数・集計の問い合わせに押し込む。読めないフィールドの値は、その利用者にとって NULL として扱い、絞り込み・並べ替え・集計・検索もその値で行う。判定の材料は `acl_version` をキーにキャッシュする |
| [0013](../decisions/0013-impersonation-and-tenant-sso.md) | 成り代わりは専用のロールで、自分の持たないロールを持つ人には成り代われず、60 分で切れ、承認・権限の変更・エクスポートができない。SSO はテナントごとに複数の IdP（SAML 2.0・OIDC）を持ち、SP 起点を既定にし、SSO の強制のときも非常用の管理者を 2 人まで残す |

この文書の決定表・性質は設計の草案である。ID は E3 の各変更の `spec.md` に移すときに確定する。決定表は `spec.md` から直接読み込み、テストに書き写さない（[AGENTS.md](../../AGENTS.md)）。

## 1. 目的と範囲

- 扱う：テナントの中の主体（利用者、グループ、ロール、連携のクライアント、フローの実行）、ACL の規則と評価、保存と読み取りでの適用、出口ごとの規則、キャッシュと無効化、成り代わり、テナントの SSO と利用者の対応付け。
- 扱わない：セッション・MFA・パスワードの仕組みの細部（Slack の [identity-and-access.md](../../../slack/docs/architecture/identity-and-access.md) を先例にし、違いだけをこの文書に書く）、API のクライアントの認証とトークン（`api-and-integrations.md`）、運用者のアクセス（`security.md`）、検索の索引の中の ACL の属性（`search.md`。この文書は満たすべき約束だけを書く）、社員と組織の人事のシステムからの取り込み（E3 の Story。この文書は取り込んだ後の主体のモデルを書く）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| 対象と操作 | 対象はテーブル・フィールド・レコード。操作は作成・読み取り・書き込み・削除のほか、実行、レポート、タスクの関係の編集など | [Access control list rules](https://www.servicenow.com/docs/bundle/zurich-platform-security/page/administer/contextual-security/concept/exploring-access-control-list.html) |
| 評価の順序 | テーブルの規則、次にフィールドの規則。利用者は「フィールドに一致する最初の規則」と「テーブルに一致する最初の規則」の両方を満たす必要がある。ワイルドカードの規則は既定の範囲を覆う | 同上 |
| 1 つの規則の中 | ロール（一覧のどれか 1 つ）、セキュリティの属性、データの条件、スクリプトのすべてを満たすと通る | 同上 |
| 規則の種類 | 「条件を満たさない限り拒否」（Deny-Unless）と「条件を満たせば許可」（Allow-If） | 同上 |
| 規則がないとき | 一致する規則がなければ、アクセスを許す。ただし、既定の規則の集合がすべてのレコードの操作を守る | 同上 |
| 既定の拒否 | 既定の拒否の設定を「deny」にすると、規則がないとき、またはテーブルのワイルドカードの規則しかないときに拒否する。一度変えると戻せない | [Deny by default with empty ACLs](https://www.servicenow.com/docs/bundle/xanadu-platform-security/page/administer/security-center/reference/sc-security-manager-default-deny.html) |
| 行とフィールド | 利用者は、フィールドに一致する最初の規則と、テーブルに一致する最初の規則の両方を満たす必要がある。行とフィールドは AND | [Access control list rules](https://www.servicenow.com/docs/r/platform-security/access-control/exploring-access-control-list.html) |
| クラスの継承 | テーブルの規則は、テーブル名 → 親のテーブル名 → `*` の順に探す。フィールドの規則は、`テーブル.フィールド` → `親.フィールド` → `*.フィールド` → `テーブル.*` → `親.*` → `*.*` の順 | [ACL rule types](https://www.servicenow.com/docs/bundle/xanadu-platform-security/page/administer/contextual-security/concept/acl-rule-types.html) |
| 管理者の上書き | 規則ごとに、管理者のロールが条件を飛ばせるかの印を持つ | コミュニティの記事で確認。公式の本文は未検証（本家の振る舞いで、設計の前提ではない。本システムは管理者の上書きを持たない） |
| 成り代わり | 成り代わりの操作を監査の表に、成り代わった相手と実際の人の両方で記録できる | [Enable impersonation tracking in audit logs](https://www.servicenow.com/docs/r/platform-security/enable-impersonation-tracking-audit-logs.html) |
| 成り代わりのロール | 専用のロール（impersonator）が要る | [Impersonate a user](https://www.servicenow.com/docs/r/platform-administration/user-administration/t_ImpersonateAUserInUI16.html)。管理者が既定で持つかは未検証（本家の振る舞いで、設計の前提ではない） |
| SSO | SAML 2.0・OIDC の IdP を最大 10 までログインの画面に並べられる。SSO の時に利用者を作り、グループに入れられる | [Multi-Provider single sign-on (SSO)](https://www.servicenow.com/docs/r/zurich/platform-security/authentication/c_MultipleProviderSingleSignOn.html) |

- 本家は、規則のスクリプト（サーバーのコード）で条件を書ける。本システムはスクリプトを持たない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。条件は式の言語だけで書く。
- 本家のロールの名前、既定の規則の中身は写さない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 3. 主体

### 3.1 利用者

- **利用者はテナントの中に持つ。** テナントごとにホスト名（`<tenant>.<brand>.<domain>`）が別で、同じ人が複数のテナント（本番と開発）に居るときは、別の利用者の行になる。Slack のようなテナントの外のアカウントは持たない。
- `user`：`tenant_id`、`id`、`user_name`（テナントの中で一意、変えられる）、`email`、`name`、`kind`（`human` / `integration`）、`active`、`locked_out`、`company_id`、`department_id`、`location_id`、`manager_id`、`time_zone`、`language`、`source`（`manual` / `hr_import` / `sso_jit`）、`break_glass`（9.3 節）。
- 無効（`active = false`）の利用者は、ログインできず、すべての判定で拒否になる。レコードの参照（担当者の履歴など）は残す。

### 3.2 グループ

- `group`（担当のグループ）：`tenant_id`、`id`、`name`（一意）、`manager_id`、`parent_id`、`type`（`assignment` / `approval` / `other` の複数）、`active`。
- `group_member`：`group_id`、`user_id`。
- `group_role`：グループに付けたロール。メンバーは、グループのロールを持つ。
- **親のグループのロールは、子のグループのメンバーに継承しない。** 親は、レポートと割り当ての規則の階層にだけ使う。本家の振る舞いは未検証（本家の振る舞いで、設計の前提ではない）。継承させると、組織の変更（親の付け替え）で権限が黙って広がるためである。

### 3.3 ロール

- `role`：`tenant_id`（組み込みは NULL）、`id`、`name`、`contains`（含むロール）、`elevated`（昇格が要るか）、`assignable_by`。
- ロールは他のロールを含める。含む関係の深さは 5 段まで、循環を禁止する（保存の時に検査する）。
- 組み込みのロール（名前は本システムのもの）：

| ロール | 中身 |
| --- | --- |
| `requester` | 既定。すべての人間の利用者が暗黙に持つ。ポータルでの申請・報告、自分のチケット、承認の依頼への回答 |
| `agent` | 担当者。タスクの読み書き（グループの条件付き）、作業メモ |
| `agent_admin` | グループの管理、割り当ての規則 |
| `change_manager` | 変更の承認の方針、CAB の運営 |
| `approver` | 承認者として指名されうる（承認は指名で行い、ロールは表示と絞り込みのため） |
| `knowledge_admin`、`catalog_admin`、`cmdb_admin`、`sla_admin` | 各領域の設定 |
| `auditor` | 全テーブルのレコードと履歴の読み取りだけ（書き込み・削除・エクスポートの権限を含まない）。フィールドの規則で守られた値（個人の機微な値）は読めない |
| `impersonator` | 成り代わり（8 節） |
| `acl_admin` | ACL の規則とロールの割り当ての変更。`elevated`（3.5 節の昇格が要る） |
| `tenant_admin` | テナントの設定、辞書、フロー。`acl_admin` を含まない（職務の分離。ACL の変更は別のロール） |
| `major_incident_manager` | メジャーインシデントの候補の昇格・却下、優先度の上書き（[itsm-processes.md](itsm-processes.md) の 5.2・6 節）。`agent` を含む |
| `problem_manager` | 問題の確定（`assess` → `root_cause_analysis`）と完了、既知のエラーのナレッジベースの持ち主（[itsm-processes.md](itsm-processes.md) の 7 節、[knowledge.md](knowledge.md) の 5 節）。`agent` を含む |

- `tenant_admin` が `acl_admin` を含まないことで、辞書・フローの管理者と権限の管理者を分けられる。小さなテナントは、同じ人に両方を付ける。
- `major_incident_manager`・`problem_manager` は、統合で組み込みのロールに足した（itsm-processes が使う。テナントのロールにしないのは、組み込みの遷移の表と ACL の規則がこの名前を参照するため）。
- **`requester` の組み込みの規則（主なもの）**：
  - 要求・要求の品目・実行のタスク：[service-catalog-and-requests.md](service-catalog-and-requests.md) の DT-REQ-002。
  - インシデントの作成（`create`）：`allow_if`、ロール `requester`、条件 `requester_id = me`（他人のための報告は `agent` の代行だけ）。ポータルの報告のフォーム（フォームからのレコードの作成。[ADR-0030](../decisions/0030-portal-requester-scope-and-record-producers.md)）が依頼者の主体で保存するために要る。書けるフィールドは `title`、`description`、`requester_id`、`urgency`、`category`、`service_offering_id`、`ci_id`、`watchers` と添付だけにする（フィールドの `*` の `deny_unless` で、優先度・影響度・担当・状態を書かせない）。`channel = portal`・`opened_by` はシステムが入れる。
  - インシデントの読み取り：`requester_id = me` または `opened_by = me` または `me ∈ watchers` の行。作業メモは読めない（DT-ACL-003 の 13 行）。
  - インシデントの更新：コメントの追加と、`resolved` からの再オープン（[itsm-processes.md](itsm-processes.md) の DT-INC-001 の 5 行）だけ。
  - 統合で決めた。カタログの品目の公開の検査（DT-CAT-001 の 5 行）は、この規則で `field_map` の先を確かめる。
- ロールの付け外しは `acl_admin` だけができる。自分へのロールの付与も記録し、`auditor` が読める。

### 3.4 主体の解決

```
principal(actor) =
  人間の利用者：user_id、roles* = closure(直接のロール ∪ 所属のグループのロール ∪ {requester})、
               groups = 所属のグループ、属性（company, department, location, manager）
  連携のクライアント：kind = integration の利用者。ロールは直接のものだけ。requester を持たない
  フローの実行：flow_run の実行の主体（workflow-engine の 5.4 節）
  closure はロールの含む関係の推移的な閉包
```

- 主体は `(tenant_id, user_id, acl_version)` をキーにキャッシュする（7 節）。

### 3.5 昇格

- `elevated` のロール（`acl_admin`、`impersonator`）の権限は、セッションで「昇格」を済ませたときだけ効く。昇格は、MFA（SSO の人は IdP での再認証。`prompt=login`・`ForceAuthn`）を通すことで行い、15 分で切れる。
- 昇格していない間は、`elevated` のロールを持たないものとして判定する。本家にも昇格の仕組みがある。昇格の役割は、利用者が手で責任を引き受けてから使え、セッションの間だけ効く（[Elevated privilege roles](https://www.servicenow.com/docs/r/platform-security/c_ElevatedPrivilege.html)、2026-09-28 に確認）。

## 4. ACL の規則（[ADR-0011](../decisions/0011-roles-groups-and-acl-evaluation.md)）

### 4.1 形

| 列 | 意味 |
| --- | --- |
| `id`、`stable_key` | メタデータの共通の列（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 9 節） |
| `table_id` | 対象のクラス。`*`（全テーブル）は組み込みの規則だけが使える |
| `field_id` | NULL なら行の規則。フィールドの ID ならフィールドの規則。`*` ならそのテーブルのすべてのフィールドの規則 |
| `operation` | `create` / `read` / `write` / `delete` |
| `effect` | `allow_if`（条件を満たせば許可）/ `deny_unless`（条件を満たさなければ拒否） |
| `roles` | ロールの一覧。どれか 1 つを持てば満たす。空なら「ロールを問わない」 |
| `condition` | 式の言語の条件（4.4 節）。空なら真 |
| `admin_override` | 真なら `tenant_admin` はロールと条件を満たしたものとする（既定は真。`deny_unless` では既定を偽にする） |
| `active` | 無効の規則は無視する |

- 組み込みの規則は、コードのバージョンに含める（辞書と同じ。[ADR-0006](../decisions/0006-data-dictionary-and-field-types.md)）。テナントは規則を足し、組み込みの規則を無効にできる。**組み込みの `deny_unless` の規則は無効にできない**（例：他人の承認の依頼への回答、監査の履歴の書き込み）。

### 4.2 評価の順序

`decide(principal, op, table, record?, field?)` は、次の順で評価する。

```
chain = [table, parent(table), ..., root]         ← クラスの階層（近い順）

行の判定 row(op, record):
  1. D = chain のすべての段の、行の deny_unless の規則（op が一致、active）
     1 つでも満たさなければ → 拒否
  2. A = chain を近い順にたどり、行の allow_if の規則を 1 つ以上持つ最初の段の規則の集合
     A が空（どの段にもない）→ 拒否（既定の拒否）
  3. A のどれか 1 つを満たせば → 許可。どれも満たさなければ → 拒否

フィールドの判定 field(op, record, f):
  0. row(op', record) が拒否なら → 拒否（op' は read のとき read、write のとき write）
  1. Df = chain のすべての段の、f と * の deny_unless の規則。1 つでも満たさなければ → 拒否
  2. Af = chain を近い順にたどり、f の allow_if の規則を持つ最初の段の規則の集合
     Af が空なら、同じく * の allow_if の規則を持つ最初の段の規則の集合
     それも空なら → 許可（フィールドは行の判定に従う）
  3. Af のどれか 1 つを満たせば → 許可。どれも満たさなければ → 拒否

条件の評価の途中の失敗（型の誤り、参照先が読めない、時間の上限）は、その規則を「満たさない」とする。
```

- **行の既定は拒否、フィールドの既定は行に従う。** すべてのテーブルに組み込みの `allow_if` の行の規則を用意する。規則のないテナントのテーブルは、管理者が規則を足すまで誰も読めない（作ったテナントの管理者は、`admin_override` の組み込みの規則 `*`・`read` で読める）。
- **拒否の条件は親から逃げられない。** 親のクラス（例：`task`）の `deny_unless` は、テナントが作った子のクラスにも効く。許可の条件は、子で規則を定めれば親の規則を置き換える（本家の「具体的なものから探す」に寄せた）。
- 本家は、規則がないとき既定で許可し、設定で既定の拒否に変える（2 節）。本システムは常に既定の拒否で、設定で変えられない（差異）。

### 4.3 行の判定の決定表（DT-ACL-001）

上から評価し、最初に一致した行を採る。

| # | 認証 | 利用者 | 操作 | `deny_unless`（全段） | `allow_if` の最も近い段 | その段の規則のどれかを満たす | 結果 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | なし・期限切れ | - | - | - | - | - | 401 |
| 2 | あり | 無効・ロック | - | - | - | - | 401（セッションを消す） |
| 3 | あり | 有効 | 4 つの操作のどれでもない | - | - | - | 拒否 |
| 4 | あり | 有効 | - | 1 つでも満たさない（評価の失敗を含む） | - | - | 拒否 |
| 5 | あり | 有効 | - | すべて満たす | ない | - | 拒否（既定の拒否） |
| 6 | あり | 有効 | - | すべて満たす | ある | はい | 許可 |
| 7 | あり | 有効 | - | すべて満たす | ある | いいえ（評価の失敗を含む） | 拒否 |
| 8 | - | - | - | - | - | - | 拒否（上のどの行にも当たらないとき。表の網羅の確かめ） |

- 「満たす」は、ロール（`roles` が空、または主体がどれか 1 つを持つ、または `admin_override` で `tenant_admin`）かつ条件が真。
- 読めないレコードは、存在を漏らさないため、単体の取得でも 404 を返す。読めるが書けないときは 403 を返す。

### 4.4 フィールドの判定の決定表（DT-ACL-002）

| # | 行の判定（同じ操作） | フィールドの `deny_unless`（全段、f と *） | f の `allow_if` の最も近い段 | * の `allow_if` の最も近い段 | 満たす | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 拒否 | - | - | - | - | 拒否 |
| 2 | 許可 | 1 つでも満たさない | - | - | - | 拒否 |
| 3 | 許可 | すべて満たす | ある | - | はい | 許可 |
| 4 | 許可 | すべて満たす | ある | - | いいえ | 拒否 |
| 5 | 許可 | すべて満たす | ない | ある | はい | 許可 |
| 6 | 許可 | すべて満たす | ない | ある | いいえ | 拒否 |
| 7 | 許可 | すべて満たす | ない | ない | - | 許可（行に従う） |
| 8 | - | - | - | - | - | 拒否 |

### 4.5 条件の言語の制限

- 行の規則の条件は、**SQL の述語にコンパイルできる形**だけを許す（[ADR-0012](../decisions/0012-acl-enforcement-at-every-exit.md)）。
  - レコードのフィールド（型付きの列、索引を付けた `ext` のフィールド、参照のフィールド）と定数の比較、`in`、`is empty`、論理の結合。
  - 参照のたどりは 1 段まで（例：`assignment_group.manager = me`）。
  - 主体の属性：`me`（利用者の ID）、`me.groups`、`me.roles`、`me.company`、`me.department`、`me.location`、`me.manager`。
  - 時刻の比較は、`now` の相対（例：`opened_at > now - 30d`）を許す。`now` は要求の開始の時刻に固定する。
- コンパイルできない条件（2 段以上のたどり、索引のない `ext` のフィールド、関連のレコードの件数）は、規則の保存の時に 422 で拒否する。
- フィールドの規則の条件も同じ制限にする（一覧でフィールドごとに述語を作るため。6 節）。
- 式の評価器は純粋な関数で、副作用を持たない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。1 回の評価の時間の上限は 5ms。超えたら「満たさない」にする。

## 5. 保存と単体の読み取りでの適用

Record Service の保存の流れ（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 5 節）の 1 段目で、次を行う。

| 操作 | 判定 |
| --- | --- |
| 作成 | 行の `create`（作成の後の値で条件を評価する）。値を入れたフィールドごとにフィールドの `create`（フィールドの `create` の規則がなければ、`write` の規則を使う） |
| 更新 | 行の `write`（更新の前の値で評価する）、変えたフィールドごとのフィールドの `write`。さらに、更新の後の値で行の `write` をもう一度評価し、満たさなければ拒否する（自分を担当から外して読めなくなる更新は許すが、書き込みの条件の外へ移す更新は拒否する。例外は 13 節の持ち越し） |
| 削除 | 行の `delete` |
| 単体の取得 | 行の `read`。返すフィールドごとにフィールドの `read`。読めないフィールドは応答に入れない |

- **フィールドの書き込みの拒否は、黙って落とさない。** 値が今の値と違えば 403（`field_not_writable`）にする。同じなら無視する（フォームは全体を送る。[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の DT-DICT-001 と同じ扱い）。
- 同期のレコードのルールとフローが入れる値は、実行した利用者のフィールドの ACL を通さない（ルールとフローの書き込みは、定義した管理者の権限で決まる。[workflow-engine.md](workflow-engine.md) の 5.4・6 節）。ただし行の書き込みの可否は、フローの実行の主体で判定する。
- 判定の結果（拒否したときの規則の ID）は、開発のテナントでは応答の診断の欄に入れる。本番のテナントでは入れず、`acl_admin` だけが見られる判定のログに残す（10 節）。

## 6. 出口（[ADR-0012](../decisions/0012-acl-enforcement-at-every-exit.md)）

### 6.1 読めない値は NULL として扱う

- 一覧・件数・集計・並べ替え・絞り込み・グループ化では、各フィールドを次の式で読む。

```
visible(f) = CASE WHEN field_read_predicate(f, principal) THEN f END
```

- `field_read_predicate` は、4.4 節の判定を SQL の述語にしたもの。ロールだけで決まるフィールドは、真か偽の定数になり、偽なら `NULL` の定数に置き換える。
- **読めない値は、その利用者にとって NULL である。** 絞り込み（`f = 5`、`f != 5`、`f is empty`）、並べ替え、グループ化、集計（合計・平均・最大）は、すべて `visible(f)` の上で行う。値を使わない件数も、行の述語を満たす行だけを数える。これで、並べ替えの位置や絞り込みの件数から、読めない値を推測できない。
- 画面は、読めないフィールドを絞り込み・並べ替えの選択肢に出さない。API で指定されたときは、エラーにせず NULL の意味で処理する（エラーにしても推測はできないが、結果の形を 1 つにする）。

### 6.2 出口ごとの規則（DT-ACL-003）

| # | 出口 | 規則 |
| --- | --- | --- |
| 1 | フォーム（単体の取得） | 行の `read` がなければ 404。読めないフィールドは応答に入れない（キーも入れない） |
| 2 | リスト | 行の述語を `WHERE` に押し込む。列は `visible(f)` |
| 3 | 件数（リストの総数、バッジ） | 行の述語を満たす行だけを数える |
| 4 | 並べ替え・絞り込み・グループ化 | `visible(f)` の上で行う（6.1 節） |
| 5 | 集計・レポート・ダッシュボード | 見る人の主体で 2〜4 を行う。定期の配信は、受け手ごとに受け手の主体で計算する（`reports.md`） |
| 6 | 参照の表示の値 | 参照先の行の `read` と表示のフィールドの `read` があるときだけ表示の値を出す。なければ「（表示できないレコード）」と ID を出さない |
| 7 | 参照のたどり（リストの列 `requester.department`、条件） | たどる各段で、行とフィールドの `read` を判定する |
| 8 | 関連のリスト | 関連の先のテーブルでの 2〜4 |
| 9 | 検索 | 索引の ACL の属性で絞った後、返す直前に各結果を判定の関数で確かめ直す。読めないフィールドの一致の強調を出さない（`search.md`） |
| 10 | エクスポート（CSV など） | リストと同じ問い合わせ。行の上限は 10 万。`auditor` は含まない |
| 11 | 通知の本文・差し込み | 送る直前に、受け手ごとに受け手の主体で判定する。読めない差し込みは空にする（`notifications-and-email-ingest.md`） |
| 12 | REST API・Webhook | API のクライアントの主体で 1〜4。Webhook の本文には ID と変わったフィールドの ID だけを入れ、値は受け手が API で取る（`api-and-integrations.md`） |
| 13 | 監査の履歴・作業メモ | 履歴の各フィールドは、今のフィールドの `read` で判定する。作業メモ（`work_note`）は、`work_note` の読み取りの規則（組み込み：`agent` 以上）で判定する（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 7.4 節） |
| 14 | フローの中の参照 | フローの実行の主体で判定する（[workflow-engine.md](workflow-engine.md) の 5.4 節） |
| 15 | 添付ファイル | 添付ファイルの行は、親のレコードの `read` に従う。署名付き URL は判定の後にだけ出し、有効期間は 5 分 |
| 16 | ポータルの自分のチケット | リストと同じ（ポータル用の抜け道を作らない） |

- すべての出口は、Record Service の同じ `decide` と、同じ述語のコンパイラを使う。出口ごとに判定を書かない（[AGENTS.md](../../AGENTS.md)）。

## 7. キャッシュと無効化

- テナントに `acl_version`（単調に増える整数）を持つ（`tenant_meta`。[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 9.1 節）。次の変更は、同じトランザクションで `acl_version` を 1 上げる。
  - ACL の規則の変更（メタデータの変更として `meta_version` も上がる）
  - ロールの付け外し、ロールの含む関係の変更
  - グループの所属の変更、グループのロールの変更、グループの無効化
  - 利用者の無効化・ロック、主体の属性（会社・部署・場所・上長）の変更
- 要求の始めに、`meta_version` と同じ往復で `acl_version` を読む。キャッシュのキー：
  - 主体：`(tenant_id, user_id, acl_version) → principal`
  - コンパイル済みの規則と述語：`(tenant_id, meta_version, table_id, op) → 規則の集合・述語の雛形`
- 変更のコミットの後に始まった要求は、古い権限で判定されない。
- 人事のシステムからの一括の取り込みは、1 回の取り込みで `acl_version` を 1 回だけ上げる（取り込みのトランザクションの単位で）。取り込みの間に毎行上げると、キャッシュが効かなくなる。

## 8. 成り代わり（[ADR-0013](../decisions/0013-impersonation-and-tenant-sso.md)）

テナントの管理者・担当者が、ある利用者から見える画面を確かめるための機能。運用者（本システムの運営の社員）の顧客データへのアクセスは `security.md` で扱い、この仕組みを使わない。

DT-IMP-001（成り代わりの開始）：

| # | 本人 | 相手 | 環境 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | `impersonator` を持たない | - | - | 403 |
| 2 | - | 自分 | - | 400 |
| 3 | - | 無効・ロック | - | 403 |
| 4 | - | 本人の持たないロールを 1 つでも持つ（`closure` で比べる） | - | 403 `insufficient_privilege_to_impersonate` |
| 5 | - | `break_glass` の利用者 | - | 403 |
| 6 | - | - | 本番のテナントで、テナントの設定が「本番で成り代わりを許さない」 | 403 |
| 7 | 昇格（3.5 節）を 15 分以内に済ませていない | - | - | 401 `step_up_required` |
| 8 | - | - | - | 開始。60 分で切れる |

成り代わりの間の制限：

| 操作 | 可否 |
| --- | --- |
| 読み取り、画面の確認 | 相手の権限で可 |
| レコードの作成・更新 | 相手の権限で可。履歴は `actor_id` = 相手、`real_actor_id` = 本人（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 7.1 節） |
| 承認の依頼への回答 | 不可（承認は本人の意思表示で、J-SOX の証跡になるため） |
| ACL・ロール・グループの所属の変更、SSO の設定 | 不可 |
| エクスポート、API のトークンの作成 | 不可 |
| パスワード・MFA・通知の設定の変更 | 不可 |
| 成り代わりの入れ子（成り代わりの中で別の人に成り代わる） | 不可 |

- 画面の上に、成り代わりの間であることと、終える操作を常に出す。
- 開始・終了・その間の書き込みを、テナントの監査ログに残す。相手の利用者は、自分のプロフィールで「最近の成り代わり」を見られる（決定。14 節）。

## 9. テナントの SSO（[ADR-0013](../decisions/0013-impersonation-and-tenant-sso.md)）

### 9.1 構成

| 表 | 列 |
| --- | --- |
| `idp_config` | `tenant_id`、`id`、`protocol`（`saml2` / `oidc`）、`name`、メタデータ（SAML：エンティティ ID、SSO の URL、署名の証明書（複数。切り替えのため）。OIDC：発行者、クライアントの ID、秘密（KMS で暗号化）、JWKS の URL）、`email_domains`、`jit`（自動の作成）、`attribute_map`、`group_map`、`enabled` |
| `user_identity` | `tenant_id`、`user_id`、`idp_id`、`subject`（SAML の NameID か、OIDC の `sub`）。`(tenant_id, idp_id, subject)` 一意 |
| `tenant_auth_policy` | `sso_required`、`password_allowed`、`mfa_required`、`session_idle_minutes`、`session_max_hours`、`impersonation_in_production` |

- 1 つのテナントに最大 10 の IdP を持てる（子会社ごとの IdP のため）。ログインの画面は、メールアドレスのドメインで IdP を選ぶ。
- **SP 起点のログインを既定にする。** IdP 起点（SAML の要求を伴わない応答）は、テナントが明示的に有効にしたときだけ受ける。要求の ID と `InResponseTo` の照合ができず、応答の横取りの影響が大きいためである。
- SAML：応答とアサーションの署名を検証し、署名の対象の要素を明示して取り出す（署名の包み替えの攻撃に備える）。`Audience`、`Recipient`、`NotOnOrAfter`（時計のずれは 3 分まで）、アサーションの ID の再利用を確かめる（ID は有効期間まで Valkey と DB に持つ）。XML の外部実体を読まない。SAML・OIDC の部品は第三者の汎用のライブラリを使ってよい（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）が、E3 でセキュリティのレビューを通す。
- OIDC：認可コードのフローと PKCE、`state` と `nonce`、ID トークンの署名・`iss`・`aud`・`exp` の検証。
- セッション・Cookie・MFA の仕組みは Slack の [identity-and-access.md](../../../slack/docs/architecture/identity-and-access.md) の 3・4 節を先例にする。違いは、Cookie をテナントのホスト名だけに付ける（`Domain` を付けない）ことである。

### 9.2 利用者の対応付け（DT-SSO-001）

| # | `user_identity` に `(idp, subject)` がある | メールアドレスが一致する有効な利用者がいる | IdP のドメインの確認 | `jit` | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | ある（利用者が有効） | - | - | - | その利用者でログイン。属性を `attribute_map` で更新する（`jit` のとき） |
| 2 | ある（利用者が無効） | - | - | - | 403 |
| 3 | ない | いる | ドメインを確認済み、かつメールのドメインが `email_domains` に入る | - | `user_identity` を作って紐付け、ログイン |
| 4 | ない | いる | 上を満たさない | - | 403 `account_link_required`（管理者が紐付ける） |
| 5 | ない | いない | ドメインを確認済み | 有効 | 利用者を作り（`source = sso_jit`、ロールは `requester` だけ、`group_map` のグループ）、ログイン |
| 6 | ない | いない | - | 無効、または未確認 | 403 `user_not_provisioned` |

- ドメインの確認は、DNS の TXT レコードで行う（Slack の identity-and-access.md の 5.2 節と同じ）。確認していないドメインのメールアドレスで、既存の利用者に紐付けない（別の IdP からの乗っ取りを防ぐ）。
- `group_map` でグループの所属を付けるのは、JIT の作成のときと、ログインのたびの同期（設定で選ぶ）である。**ロールは IdP から直接付けない。** グループを通して付ける（ロールの付け外しの記録を `acl_admin` の設定に集めるため）。

### 9.3 SSO の強制と非常用の管理者

- `sso_required` のテナントでは、パスワードでのログインを拒否する。ただし `break_glass` の印の利用者（`tenant_admin` を持つ、最大 2 人）は、パスワードと MFA でログインできる。IdP の障害のときに設定を直すためである。
- `break_glass` のログインは、テナントの全 `tenant_admin` と `acl_admin` にメールで知らせ、監査ログに残す。
- MFA は、パスワードでログインする人すべてに必須にする（`mfa_required` の既定は真。SSO の人は IdP の MFA に任せる）。

## 10. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 条件の評価の失敗・時間の超過 | その規則を満たさないとする（拒否の側）。1 分に 100 件を超えたら、テナントの `acl_admin` に知らせ、SEV3 |
| 規則のコンパイルの失敗（新しいコードのバージョンで古い規則が読めない） | そのテーブルのすべての操作を拒否する。SEV2。規則の保存の時の検証と、リリースの前の全テナントの規則のコンパイルの検査（`delivery.md`）で防ぐ |
| Valkey が落ちる | 主体と規則を DB から作る。遅くなるが正しい |
| `acl_version` の読み取りの失敗 | 要求を 503 にする。古いキャッシュで判定しない |
| IdP が落ちる | SSO の利用者はログインできない。既存のセッションは有効期間まで続く。`break_glass` で設定を直せる |
| IdP の証明書の切り替え | 複数の証明書を持てるので、新旧を並べて登録してから古いものを外す |

- 判定のログ：拒否の判定を、要求の ID、主体、対象、規則の ID でサンプリング（1%。拒否が多いときに上限）して残す。値は残さない。`acl_admin` が「なぜ見えないか」を調べる道具（Story `acl-explain`）はこのログではなく、同じ `decide` を説明の形で動かす。

## 11. セキュリティ

- ACL の変更は `acl_admin` と昇格（3.5 節の再認証。MFA を 15 分以内に通したこと）を要る。変更は `meta_change` と監査ログに残る。
- ロールの自己付与を許すが、すべて `auditor` と他の `acl_admin` に通知する。
- 成り代わりは権限を広げない（DT-IMP-001 の 4 行）。
- 読めない値は、値だけでなく件数・順序・集計・強調からも漏らさない（6 節）。
- 別のテナントのデータは RLS でそもそも読めない。ACL は RLS の内側の判定である（二重の防御）。
- `admin_override` は `tenant_admin` の運用の便利のためのもので、組み込みの `deny_unless` の規則（承認・監査）には効かない。
- 本システムの運営の社員は、テナントの利用者ではない。テナントのデータへのアクセスは `security.md` の手順（顧客の許可、時間の制限、運用の監査ログ）を通す。

## 12. テスト

### 12.1 決定表（表駆動テスト）

- DT-ACL-001（行）、DT-ACL-002（フィールド）、DT-ACL-003（出口）、DT-IMP-001（成り代わり）、DT-SSO-001（対応付け）を、`spec.md` から読み込むテストにする。
- 決定表の組み合わせの生成：条件の列（ロールの有無、`deny_unless` の段の位置、`allow_if` の段の位置、条件の真偽・失敗、`admin_override`、クラスの深さ 1〜4）の全組み合わせを作り、各組み合わせが表のどの行に当たるかを求め、`decide` の結果と比べる。表の最後の行（既定の拒否）に当たる組み合わせがあれば、それも拒否であることを確かめる。

### 12.2 性質ベーステスト

- **PROP-ACL-001（既定の拒否）**：任意の規則の集合で、どの `allow_if` の規則にも当たらない（主体、操作、対象）は拒否。
- **PROP-ACL-002（拒否の単調）**：任意の規則の集合に `deny_unless` の規則を足しても、許可の集合は増えない。
- **PROP-ACL-003（述語と関数の一致）**：任意の規則・主体・レコードの集合で、SQL の述語で一覧に出る行の集合は、`decide(read)` が許可する行の集合と一致する。フィールドの `visible` も同じ。
- **PROP-ACL-004（推測できない）**：任意のテーブルで、読めないフィールド f の値だけが違う 2 つのデータの集合に対し、任意の問い合わせ（絞り込み・並べ替え・グループ化・集計・件数）の結果は、見る人にとって同じ。
- **PROP-ACL-005（キャッシュの鮮度）**：任意の権限の変更と要求の並行の列で、変更のコミットの後に始まった要求の判定は、変更の後の規則での判定と一致する。
- **PROP-ACL-006（成り代わりは広げない）**：任意の本人と相手で、成り代わりの間に許可される操作の集合は、本人の許可の集合と相手の許可の集合の両方に含まれる操作の集合の部分集合である（相手の持つロールを本人が持つことを DT-IMP-001 で求めるため）。

### 12.3 出口ごとの漏れの試験

- 読めないフィールドに特徴的な値（「漏れの印」）を入れたデータを作り、6.2 節の 16 の出口すべてで、応答・メール・CSV・Webhook・検索の結果・ログに印が出ないことを確かめる。
- 並べ替え・絞り込みの推測の試験：読めない値の大小で並べ替えた結果と、NULL として並べ替えた結果が同じ。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `principals-users-groups-roles` | 3 節の表、ロールの閉包、主体の解決とキャッシュ |
| E3 | `acl-rule-model-and-decide` | 4.1〜4.4 節、`decide`（DT-ACL-001・002、PROP-ACL-001・002） |
| E3 | `acl-condition-compiler` | 4.5 節、述語へのコンパイル、保存の時の検証（PROP-ACL-003） |
| E3 | `acl-exits-null-semantics` | 6 節の `visible(f)` と出口ごとの適用（DT-ACL-003、PROP-ACL-004） |
| E3 | `acl-leak-suite` | 12.3 節の 16 の出口の漏れの試験。後の Epic が出口を足すたびに広げる |
| E3 | `acl-version-cache` | 7 節（PROP-ACL-005） |
| E3 | `builtin-acl-rules` | 組み込みのロールと規則の集合（インシデント・変更・要求・ナレッジ・CMDB の既定） |
| E3 | `acl-explain` | 「なぜ見えないか」を説明する管理の画面と API |
| E3 | `impersonation` | 8 節（DT-IMP-001、PROP-ACL-006） |
| E3 | `tenant-sso-saml-oidc` | 9 節（DT-SSO-001）、ドメインの確認、IdP の証明書の切り替え |
| E3 | `break-glass-admins` | 9.3 節 |
| E3 | `hr-import-principals` | 人事のシステムからの利用者・部署・上長・グループの取り込み（L1 の確認待ち） |
| E6 | `incident-acl-defaults` | インシデント・問題の既定の規則（担当のグループ、依頼者本人） |
| E8 | `requester-acl` | ポータルの自分のチケット・承認の範囲の規則（統合で service-catalog の依頼者の範囲の Story とまとめた） |
| E11 | `report-acl-aggregation` | 集計と定期の配信での受け手ごとの判定 |
| E12 | `external-pentest` | 外部のペンテストの範囲に、出口の推測と成り代わりを含める（統合で roadmap の Story にまとめた） |

## 14. 未解決の問い

### 決定（2026-09-28、既定案）

- **既定の拒否は設定で変えられない**：本家の既定の許可は採らない（4.2 節、ADR-0011）。
- **拒否の条件は階層のすべての段で効き、許可の条件は最も近い段だけ**（4.2 節）。
- **読めない値は NULL として扱い、絞り込み・並べ替えもそれで行う**（6.1 節、ADR-0012）。
- **行の規則の条件は SQL にコンパイルできる形だけ**（4.5 節）。
- **親のグループのロールを子に継承しない**（3.2 節）。
- **`tenant_admin` は `acl_admin` を含まない**（3.3 節）。
- **成り代わりの中の承認を禁止する**（8 節、ADR-0013）。
- **`major_incident_manager`・`problem_manager` を組み込みのロールに足す**（3.3 節。統合で決めた）。
- **`requester` にポータルからのインシデントの作成（本人が依頼者のもの）を許す組み込みの規則を持つ**（3.3 節。統合で決めた）。
- **相手は「最近の成り代わり」を見られる**（8 節）。
- **SP 起点の SSO を既定、IdP 起点は明示の有効化**（9.1 節）。
- **IdP からロールを直接付けない。グループを通す**（9.2 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 更新の後の値で行の `write` を評価し直すこと（5 節）が、担当の付け替え（自分のグループの外へ回す）を妨げないか。妨げるなら「回す」操作の例外の規則を作るか | E6 の Story で、担当者の操作の観察と一緒に QA が確かめる |
| SCIM での利用者・グループの同期 | E3 の後。人事のシステムの取り込みの実績を見て |
| 匿名の閲覧者（ログインしない人へのナレッジの公開） | `knowledge.md` で。MVP はログインを必須にする |
| 判定のログのサンプリングの割合 | E3 の計測 |
| 大きな規則の集合（1 テーブルに数百の規則）での述語の大きさと問い合わせの速さ | E3 の計測。上限（1 テーブル・操作ごとに 50 の規則）を仮に置く |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 出口の漏れの試験の結果（16 の出口 × 組み込みのテーブル）：漏れ 0 件（K6、NFR-010）。
- 条件の評価の失敗の件数（テナント別）。
- 判定の p99（主体の解決・規則の評価）と、リストの問い合わせの述語による遅れ。
- `acl_version` の上がる頻度（テナント別。人事の取り込みの影響）。
- 成り代わりの回数と、その間の書き込みの件数。
- SSO のログインの失敗の割合（理由別）、`break_glass` のログインの回数（0 が目標）。

### runbooks

- `acl-lockout.md`：ACL の変更の誤りで管理者も読めなくなったときの戻し方（`meta_change` からの前のバージョンの適用。`break_glass` の使い方）。
- `idp-outage.md`：テナントの IdP の障害のときの案内と `break_glass` の手順。
- `idp-certificate-rotation.md`：IdP の証明書の切り替えの手順。
- `suspected-acl-leak.md`：漏れの疑いの報告の受け方、判定のログと `acl-explain` での調べ方、セキュリティの事案への引き上げ。
- `acl-compile-failure.md`：規則のコンパイルの失敗でテーブルが拒否になったときの対応。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `user`、`group`、`group_member`、`group_role`、`role`、`user_role` | 3 節 |
| Aurora `acl_rule` | 4.1 節。メタデータ（`meta_version` の対象） |
| Aurora `tenant_meta.acl_version` | 7 節 |
| Aurora `impersonation_session`（本人、相手、開始・終了、理由） | 8 節 |
| Aurora `idp_config`、`user_identity`、`tenant_auth_policy`、`domain_verification` | 9 節 |
| Valkey：主体、コンパイル済みの規則 | 7 節。失われてもよい |

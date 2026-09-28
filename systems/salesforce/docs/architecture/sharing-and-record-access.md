# Sharing and record access: Salesforce

プロファイルと権限セット、オブジェクトの権限、項目レベルのセキュリティ（FLS）、組織の共有設定（OWD）、ロール階層、公開グループとキュー、共有ルール、手動の共有、チーム、親に連動する共有、暗黙の共有、再計算、スキューの扱い、参照の評価器の設計。土台は [ADR-0004](../decisions/0004-record-access-model.md)（事前計算＋所有者は問い合わせの時に閉包と結ぶ＋影の世代）。この文書で決めたことは、次の 5 つの ADR にある。

- 権限は権限セットで与え、プロファイルは既定値の入れ物と 1 つの基本の権限セットにする。権限は和で合わせ、項目の権限は読み・編集の 2 つにする（[ADR-0013](../decisions/0013-permission-sets-and-field-level-security.md)）。
- OWD の変更は述語の切り替えだけにし、行を書き直さない。グループの閉包を 1 つの表にまとめ、利用者本人とキューもグループとして扱う。ロール階層もこの閉包で表す（[ADR-0014](../decisions/0014-owd-roles-groups-and-closure.md)）。
- 共有の理由ごとに持ち方を決める。所有者の条件の共有ルールと暗黙の子の共有は問い合わせの時に、レコードの条件の共有ルール・手動・チーム・暗黙の親は行に持つ（[ADR-0015](../decisions/0015-sharing-reasons-and-where-they-live.md)）。
- 再計算の単位を、オブジェクトの世代ではなく、共有ルールの版と閉包の世代にする。スキューは 1 万件で警告し、閉包の大きな変更は非同期にする（[ADR-0016](../decisions/0016-recalculation-rule-versions-and-skew.md)）。
- 参照の評価器を、決定表をそのまま書いた純粋な関数にし、性質ベーステストのオラクルと、本番の標本の照合に使う。多く見せる食い違いは、セキュリティの呼び出しにする（[ADR-0017](../decisions/0017-reference-access-evaluator.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 権限セット、プロファイル、オブジェクトの権限、FLS、システムの権限 | 利用者・ライセンス・ログイン（orgs-users-and-auth の領域） |
| OWD、ロール階層、公開グループ、キュー、閉包 | テリトリー管理（MVP の後） |
| 共有ルール、手動の共有、チーム、親に連動、暗黙の共有 | 取引先・商談の業務の規則（sales-objects の領域） |
| 判定の決定表、問い合わせの時の条件、保存での更新 | 問い合わせの計画での条件の置き方（[query-language-and-api.md](query-language-and-api.md) の 4 節） |
| 再計算、世代、保留、スキュー | レポート・検索・変更のイベントの経路の実装（各領域。ここでは守る規則だけ） |
| 参照の評価器と本番の標本の照合 | 外部の利用者（ポータル）の共有（intent の Non-goals） |

## 2. 本家の仕組み（確かめたこと）

主な出典は [Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)（Winter '27 版、以下「RLA」）と [Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)（以下「LDV」）。

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 2 つの層 | オブジェクトの単位（参照・作成・編集・削除、FLS）と、レコードの単位（共有） | RLA |
| 開く権限 | 「すべて参照」「すべて変更」は、共有の設定に関わらず全レコードに届く | RLA |
| レコードの単位の道具 | OWD、ロール階層、テリトリー、共有ルール、チーム、手動の共有、プログラムでの共有 | RLA |
| 事前計算 | 読む時に全て計算すると 300ms に収まらないので、設定が変わった時に計算して保存する | RLA |
| 4 種の付与 | 明示（所有者、共有ルール、割り当てのルール、手動、チーム、プログラム）、グループの所属、継承（ロール・テリトリーの階層、グループの階層）、暗黙（子が見えれば親の取引先を見られる。親が見えれば子の商談・ケース・取引先責任者を見られる） | RLA |
| 表 | レコードの表（所有者を持つ）、オブジェクトの共有の表（レコード、利用者かグループ、水準、理由）、グループの保守の表（所属の展開） | RLA |
| 共有の表を持たないもの | 主従の従、両方の OWD が公開・参照・更新、活動・ファイル | RLA |
| 最も強い付与 | 複数の付与があれば、最も強いものを使う | RLA |
| システムのグループ | ロールごとに Role（上司を間接のメンバーに含む）、RoleAndSubordinates（部下を直接のメンバーに含む）などを作る。キューも同じ表で扱う | RLA |
| 所有者の変更 | 手動の理由の共有の行を消す。所有者の条件の共有ルールの行も付け替える | RLA の Scenario 4 |
| ロールの移動 | 1 人のロールの移動でも、グループの所属と、共有ルールの行の大きな書き換えになる | RLA の「Putting It All Together」 |
| 大きな組織の例 | 取引先 1,000 万件、利用者 7,000、ロール 2,000、テリトリー 1,000 | RLA |
| 共有の計算の保留 | 管理者が共有の計算を止めて、後でまとめて再開できる | LDV |
| スキュー | 1 人が 1 万件を超えて所有しない。1 つの親に 1 万件を超える子を置かない | LDV |
| 共有ルールの数 | 1 オブジェクト 300、うちレコードの条件のもの 50 | [Salesforce Enterprise Edition Allocations](https://help.salesforce.com/s/articleView?id=xcloud.overview_limits_enterprise.htm&type=5)（2026-09-28 に確認） |
| プロファイルの権限の廃止の計画 | Spring '26 からの廃止を取りやめた。既定値はプロファイルに、権限は権限セットに置くことを勧める | [Permissions in Profiles Retirement Cancelled](https://help.salesforce.com/s/articleView?id=003834041&type=1)（2026-09-28 に確認） |
| 数式の値と参照先の FLS | 公開の資料に書かれていない（未検証。E6 の `formula-indexing-and-fls` で試用の組織で確かめる） | — |

## 3. オブジェクトの権限と FLS（ADR-0013）

### 3.1 権限セットとプロファイル

- **権限は全て権限セットで与える。** 権限セットは、オブジェクトの権限、項目の権限、システムの権限を持つ。
- **権限セットのグループ**は、権限セットを束ねる。利用者には権限セットか、権限セットのグループを割り当てる。
- **プロファイル**は、既定値の入れ物にする：ページレイアウトの割り当て、使えるレコードタイプと既定のレコードタイプ、ログインの時間帯と IP の範囲。プロファイルは、1 つの**基本の権限セット**を持つ。利用者はプロファイルを必ず 1 つ持ち、その基本の権限セットも割り当てられたものとして扱う。
- 本家はプロファイルの権限の廃止を取りやめたが、権限セットに寄せることを勧めている（2 節）。本システムは、最初から権限を権限セットに寄せる。
- 割り当ては期限を持てる（`expires_at`）。期限を過ぎた割り当ては、判定で無視し、Worker が 1 時間ごとに消す。

### 3.2 権限の種類

| 種類 | 値 | 依存（保存の時に検査する） |
| --- | --- | --- |
| オブジェクト | `read`、`create`、`edit`、`delete`、`view_all`、`modify_all` | `create`・`edit` → `read`。`delete` → `edit`。`view_all` → `read`。`modify_all` → `delete`・`view_all` |
| 項目 | `read`、`edit` | `edit` → `read` |
| システム | 25（下の一覧。各権限の意味は [orgs-users-and-auth.md](orgs-users-and-auth.md) の 7.1 節） | 下の依存の表 |

**システムの権限（25）**（2026-09-28。orgs-users-and-auth の領域の依頼で、[ADR-0045](../decisions/0045-system-permissions-and-delegation.md) の一覧に合わせた。正本は orgs-users-and-auth.md の 7.1 節）

| 分類 | 権限 |
| --- | --- |
| データ | `view_all_data`、`modify_all_data`、`view_all_users`、`transfer_records`、`bulk_hard_delete`、`import_records` |
| 営業 | `convert_leads`、`edit_converted_leads` |
| レポート | `export_reports`、`manage_report_folders`、`schedule_reports_for_others`、`view_my_team_dashboards` |
| 画面 | `manage_public_list_views` |
| API | `api_enabled` |
| 管理 | `view_setup`、`customize_application`、`manage_users`、`manage_sharing`、`defer_sharing`、`manage_auth_settings`、`manage_integrations`、`manage_sandboxes`、`deploy_metadata` |
| 監査 | `view_audit_trail`、`erase_history_values` |

**システムの権限の依存**（保存の時に検査する）

| 権限 | 要る権限 |
| --- | --- |
| `modify_all_data` | `view_all_data` |
| `view_all_data` | `view_all_users` |
| `customize_application`・`manage_users`・`manage_sharing`・`manage_auth_settings`・`manage_integrations`・`manage_sandboxes`・`view_audit_trail` | `view_setup` |
| `deploy_metadata` | `customize_application` |
| `defer_sharing` | `manage_sharing` |
| `convert_leads`・`edit_converted_leads` | リードのオブジェクトの `edit` |
| `bulk_hard_delete` | `api_enabled` |
| `erase_history_values` | `view_audit_trail`、`modify_all_data` |

- 権限セットは、割り当てられるライセンス（`permission_sets.license`。空なら全て）を持つ。ライセンスの外の権限を持つ権限セットは、そのライセンスの利用者に割り当てられない（[ADR-0043](../decisions/0043-orgs-editions-licenses-and-users.md)）。
- 権限を渡す規則（部分集合の規則、最後の管理者）は `DT-AUTH-002`（orgs-users-and-auth.md の 7.2 節）。
- 利用者の権限は、割り当てられた全ての権限セットの**和**にする。権限を狭める権限セット（本家の muting に相当）は、MVP では持たない。
- 項目の権限の対象外：名前、所有者、作成・更新の日時と人、レコードタイプは、オブジェクトを読めれば読める。数式・積み上げ集計・自動採番は `edit` を持てない。
- 必須の項目（`required`）は、`create` を持つ権限セットでは `edit` を外せない（保存の時に検査する）。外せると、誰も作成できなくなる。
- 数式の項目の FLS は、参照先の項目の FLS も要る（[metadata-and-runtime.md](metadata-and-runtime.md) の 7.7 節）。

### 3.3 利用者の権限の形

- 利用者に割り当てた権限セットの ID を並べてハッシュにしたものを**権限の形**（`perm_shape`）と呼ぶ。同じ割り当ての利用者は同じ形になる。
- `(org_id, metadata_version, perm_shape)` をキーに、オブジェクト × 権限と、項目 × 権限の表をコンパイルしてキャッシュする（ADR-0003 の「利用者の権限の形」）。
- 割り当ての変更はデータの変更で、メタデータの版を上げない。利用者の `perm_shape` は、要求の開始時に `user_perm_assignments` から求める（利用者の設定のキャッシュに持ち、割り当ての変更で消す）。権限セットの定義の変更はメタデータの変更で、版を上げる。

### 3.4 FLS をかける場所

| 場所 | 読めない項目 |
| --- | --- |
| 問い合わせの `SELECT` | 既定で `INVALID_FIELD`。画面用の要求は、落として返せる（ADR-0003） |
| `WHERE`、`ORDER BY`、`GROUP BY`、集計 | 常に `INVALID_FIELD`。存在しない項目と同じ応答にする（読めない項目で絞って値を推し量らせないため） |
| 記述（describe） | 返さない |
| 作成・更新の要求の本文 | 編集できない項目があれば `FIELD_NOT_EDITABLE` |
| 数式 | 参照先を全て読める時だけ返す |
| レポート・リストビュー・検索の結果・エクスポート | 列と条件に使えない。結果に出さない |
| 変更のイベント・Webhook の本文 | 購読者（か、Webhook の実行者）が読めない項目を落とす |
| 項目の変更の履歴 | 読めない項目の履歴を返さない |

## 4. OWD、ロール階層、グループと閉包（ADR-0014）

### 4.1 OWD とアクセスの水準

| OWD | 意味 |
| --- | --- |
| `private` | 所有者、階層、共有で決める |
| `public_read` | 全員が読める。編集は所有者、階層、共有で決める |
| `public_read_write` | 全員が読み、編集できる |
| `controlled_by_parent` | 主従の親の判定に従う。主従の従と活動だけに選べる |

- 新しいカスタムオブジェクトの既定は `private` にする。本家の社内の既定は `Public Read/Write`（[Default Organization-Wide Access Levels](https://help.salesforce.com/s/articleView?id=platform.security_sharing_owd_default_settings.htm&type=5)、2026-09-28 に確認）で、本システムは本家より狭い。安全な方に倒し、差として移行の文書に書く。
- オブジェクトは `grant_via_hierarchy`（階層で上司にも与えるか）を持つ。標準オブジェクトは常に真。カスタムオブジェクトは偽にできる。
- 外部の利用者向けの OWD は持たない（intent の Non-goals）。

レコードの水準は 4 つにする。

| 水準 | できること |
| --- | --- |
| `none` | 何もできない |
| `read` | 読む |
| `edit` | 読む、編集する |
| `full` | 読む、編集する、削除する、手動で共有する、所有者を変える |

### 4.2 ロール

- ロールは木。`roles(role_id, parent_role_id, child_access)`。深さは 20 まで。
- `child_access`：そのロールの利用者が取引先を所有する時に、子の商談・取引先責任者に与える水準（`none`・`read`・`edit`）。暗黙の子の共有（5.6 節）で使う。本家の同様の設定の細部は、公開の資料に書かれていない（未検証。E5 の `implicit-and-parent-sharing` で試用の組織で確かめる）。
- ロールを持たない利用者は、階層の外にいる。誰もその人のレコードを階層で見ない。連携の利用者やキューの代わりの利用者は、ロールなしを勧める（本家は、1 人の利用者が 1 万件を超えるレコードを持たないことを勧める。[Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)、2026-09-28 に確認。ロールなしを勧めるかは未検証。E4 の `owd-roles-groups-closure` で確かめる）。

### 4.3 グループの種類

全てのグループは `groups(group_id, kind, ...)` の 1 つの表に置く。

| 種類 | `group_id` | 直接のメンバー | 階層の継承 |
| --- | --- | --- | --- |
| `user` | 利用者の ID と同じ | 本人 | 本人のロールの上の全ての利用者 |
| `queue` | キューの ID と同じ | 利用者、ロール、ロールと部下、公開グループ | 公開グループと同じ |
| `role` | システムが作る | そのロールの利用者 | 上のロールの利用者 |
| `role_and_subordinates` | システムが作る | そのロールと、下の全てのロールの利用者 | 上のロールの利用者 |
| `public` | 管理者が作る | 利用者、ロール、ロールと部下、他の公開グループ（入れ子は 5 段まで） | 設定 `grant_via_hierarchy`（既定は真）で、メンバーの上司にも与える |

- 利用者のグループの ID を利用者の ID と同じにするのは、`records.owner_id` をそのまま「所有者のグループ」として閉包と結べるようにするためである。キューが所有するレコードも同じ形で扱える。
- 本家も、キュー・公開グループ・ロールのグループを同じ表で扱い、ロールごとにシステムのグループを作る（RLA）。

### 4.4 閉包の表

```sql
CREATE TABLE group_members_closure (
  shard_no      smallint NOT NULL,
  org_id        uuid     NOT NULL,
  generation    bigint   NOT NULL,     -- 7 節
  user_id       uuid     NOT NULL,     -- 利用者
  group_id      uuid     NOT NULL,     -- 利用者が（入れ子と階層を展開して）属するグループ
  via_hierarchy boolean  NOT NULL,     -- 階層の継承だけで属しているか
  PRIMARY KEY (org_id, generation, user_id, group_id, via_hierarchy, shard_no)
) PARTITION BY LIST (shard_no);
CREATE INDEX ON group_members_closure (org_id, generation, group_id, user_id);
```

- 1 行は「利用者 U は、グループ G のメンバーとして扱われる」を表す。
- `via_hierarchy = true` の行は、U が G の直接・入れ子のメンバーの上司であるだけで属していることを示す。`grant_via_hierarchy = false` のオブジェクトでは、この行を使わない。
- **ロール階層もこの表で表す。** 上司 M は、部下 S の `user` のグループに `via_hierarchy = true` で属する。そのため「M は S の所有するレコードを見られる」は、`owner_id` が M の属するグループかどうかで判定できる。ADR-0004 の `role_subordinates_closure` は、この表の `kind = user` の行の見方として持ち、別の表にしない。
- 大きさ：利用者の数 ×（属するグループの数＋部下の数）。S1 の最大の組織（5,000 人、ロールの平均の深さ 5、グループ 200）で、約 5,000 ×（20＋5）＝ 12.5 万行に、上司の部下の行が加わる。部下の行の合計は「利用者の数 × 平均の深さ」で約 2.5 万行。
- 利用者 1 人の閉包が 2 万行を超えたら警告する（8 節）。

## 5. 共有の理由（ADR-0015）

| 理由 | 持ち方 | 水準 | 保存での更新 |
| --- | --- | --- | --- |
| 所有者本人・キュー・階層の上司 | 問い合わせの時に `owner_id` と閉包を結ぶ | `full` | なし（所有者の変更は列の更新だけ） |
| 所有者の条件の共有ルール | `owner_rule_grants`（メタデータ）を問い合わせの時に閉包と結ぶ | ルールの水準 | なし |
| レコードの条件の共有ルール | `record_shares`（`row_cause = rule`、`rule_id`） | ルールの水準 | そのレコードのルールを評価し直す |
| 手動の共有 | `record_shares`（`manual`） | `read`・`edit` | 所有者の変更で消す |
| チーム | `record_shares`（`team`）と `record_team_members` | メンバーごと | チームの変更で足し引き |
| 親に連動 | 問い合わせの時に親の判定を使う（行を持たない） | 親の水準 | なし |
| 暗黙の親（子が見えれば親を読める） | `implicit_parent_grants` | `read` | 子の所有者・親・共有の変更で、その子の行を作り直す |
| 暗黙の子（取引先の所有者が子を見る） | 問い合わせの時に、親の所有者とロールの `child_access` を結ぶ | `child_access` | なし |

### 5.1 所有者の条件の共有ルール

- 形：「グループ A のメンバーが所有するレコードを、グループ B に水準 L で共有する」。A・B はロール、ロールと部下、公開グループ。
- `owner_rule_grants(org_id, object_id, rule_id, source_group_id, grantee_group_id, access_level)` はメタデータで、`sharing` の部品に入る。変更は版を上げるだけで、行の書き直しがない（ADR-0004）。
- 判定：利用者 U が属するグループ（閉包）に `grantee_group_id` があるルールを集め、その `source_group_id` の直接・入れ子のメンバー（`via_hierarchy = false`）が所有するレコードを、ルールの水準で見られる。

### 5.2 レコードの条件の共有ルール

- 形：「条件 C を満たすレコードを、グループ B に水準 L で共有する」。条件は数式の言語の真偽の式で、同じレコードの項目だけを参照できる（分類 A。[metadata-and-runtime.md](metadata-and-runtime.md) の 7.3 節）。親の項目や時刻で変わる条件は、保存の時に評価しきれないので許さない。
- 行：`record_shares(row_cause = 'rule', rule_id, grantee_group_id = B, access_level = L)`。
- **ルールは版を持つ。** ルールの変更は新しい `rule_id` を作り、古い `rule_id` と入れ替える（7 節）。

### 5.3 手動の共有

- `full` の水準を持つ利用者（所有者、上司、`modify_all`）と、`manage_sharing` を持つ利用者が、利用者・ロール・ロールと部下・公開グループへ `read`・`edit` で共有する。
- **所有者が変わったら、手動の共有の行を消す。** 本家と同じ（RLA の Scenario 4）。
- 1 レコードの手動の共有は 500 行まで。

### 5.4 チーム

- `record_team_members(org_id, record_id, user_id, team_role, access_level)`。取引先チームと商談チーム（MVP は基本だけ。intent）。
- メンバーごとに `record_shares(row_cause = 'team', grantee_group_id = user_id)` を持つ。
- 所有者の変更ではチームを消さない。本家の振る舞いは未検証（E5 の `implicit-and-parent-sharing` で試用の組織で確かめる）。
- 1 レコードのチームは 100 人まで。

### 5.5 親に連動

- `controlled_by_parent` のオブジェクトのレコードの水準は、`records.parent_id` の親の水準とする（オブジェクトの権限で上限をかける）。親も `controlled_by_parent` なら、さらに親をたどる。主従の段は 3 まで（[metadata-and-runtime.md](metadata-and-runtime.md) の 3.4 節）。
- 本家も、主従の従と活動は自分の共有の表を持たない（RLA）。

### 5.6 暗黙の共有

MVP で扱う親子は、標準オブジェクトの「取引先 ← 商談」「取引先 ← 取引先責任者」に限る。カスタムオブジェクトには暗黙の共有を持たない。

- **暗黙の親**：子（商談・取引先責任者）を見られる利用者は、親の取引先を `read` で見られる。
  - `implicit_parent_grants(org_id, parent_object_id, parent_id, child_id, grantee_group_id, source_rule_id)` を、子ごとに持つ。相手は、子の所有者の `user` のグループ（上司は閉包の `via_hierarchy` で届く）と、子の `record_shares` の相手。
  - 子ごとに行を持つので、1 つの取引先に多くの子が同時に作られても、同じ行を奪い合わない（親のスキューでのロックの待ちを避ける）。
  - 所有者の条件の共有ルールで子を見る利用者には、暗黙の親を与えない。行にすると、ルールの変更が子の数だけの書き直しになるため。本家がこの場合に親を見せるかは未検証（E5 の `implicit-and-parent-sharing` で確かめる）。差として文書に残す。
- **暗黙の子**：取引先の所有者（と上司）は、その取引先の子を、所有者のロールの `child_access` の水準で見られる。
  - 問い合わせの時に、子の親の参照から親の `owner_id` を引き、それが利用者から見て所有者として見える集合に入り、そのロールの `child_access` が `read` 以上かで判定する。
  - 行にしないので、取引先の所有者の変更は、子の数に依らない。

### 5.7 上限（S1 の初期値）

| 上限 | 値 | 本家 |
| --- | --- | --- |
| 組織のロール | 2,000 | 大きな組織の例に 2,000（RLA）。上限は未検証 |
| ロールの深さ | 20 | 未検証 |
| 組織の公開グループ・キュー | 5,000 | 未検証 |
| グループの入れ子の段 | 5 | 未検証 |
| 1 オブジェクトの共有ルール（合計） | 300 | 300（Enterprise の割り当て） |
| うちレコードの条件のもの | 50 | 50（同） |
| 1 レコードの手動の共有 | 500 | 未検証 |
| 1 レコードのチーム | 100 | 未検証 |
| 1 利用者の権限セット（グループを展開した後） | 100 | 未検証 |
| 組織の権限セット | 1,000 | 作るもの 1,000、パッケージを含めて 1,500（Enterprise の割り当て） |

本家の列の「未検証」は、本家の値を公開の資料で確かめていないもの。本システムの値は本家に依らず、E12 の `limits-final-values` で決める。

値は governor-limits の領域の一覧にも載せる。

## 6. 判定

### 6.1 決定表

**DT-SHR-001：レコードの水準**（上から順に評価し、最初に一致した行を採る。行は強い水準から並べてあるので、最初の一致が「最も強い付与」になる）

| # | オブジェクトの `read` | `modify_all` または `modify_all_data` | `view_all` または `view_all_data` | OWD | 本人・キュー・階層で所有者 | 所有者の条件のルール | 行の付与（`record_shares`・暗黙の親・暗黙の子）の最大 | 結果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | なし | - | - | - | - | - | - | `none` |
| 2 | あり | あり | - | - | - | - | - | `full` |
| 3 | あり | なし | - | `controlled_by_parent`（活動だけ） | あり（割り当てられた本人か、その上司） | - | - | `full` |
| 4 | あり | なし | - | `controlled_by_parent` | - | - | - | 親の水準（この表で親を判定。活動では親の `full` を `edit` にする。親が `none` でも、行 9 の `view_all` があれば `read`） |
| 5 | あり | なし | - | 親に連動でない | あり | - | - | `full` |
| 6 | あり | なし | - | `public_read_write` | なし | - | - | `edit` |
| 7 | あり | なし | - | - | なし | `edit` | - | `edit` |
| 8 | あり | なし | - | - | なし | - | `edit` | `edit` |
| 9 | あり | なし | あり | - | なし | - | - | `read` |
| 10 | あり | なし | なし | `public_read` | なし | - | - | `read` |
| 11 | あり | なし | なし | - | なし | `read` | - | `read` |
| 12 | あり | なし | なし | - | なし | - | `read` | `read` |
| 13 | あり | なし | なし | - | なし | なし | なし | `none` |

- 「本人・キュー・階層で所有者」は、`owner_id` が本人、本人が属するキュー、`grant_via_hierarchy` のオブジェクトで本人の部下（閉包の `user` のグループ）のどれか。
- 行 3（2026-09-28。sales-objects の領域の依頼、[ADR-0021](../decisions/0021-lead-conversion-and-activity-parents.md)）：活動（ToDo・行動・メール）は、割り当てられた本人（`owner_id`）と、その上司（`grant_via_hierarchy` の閉包）が `full` を持つ。行 4 だけだと、割り当てられた本人が主の親を見られない時に、自分の ToDo を見られなくなるため。活動の水準の細部は [sales-objects.md](sales-objects.md) の `DT-ACT-001` で、この表の行 3・4 を活動について細かくしたものである。
- 行 4 の例外：`view_all` を持つ利用者は、親を見られなくても従を読める。本家の細部は未検証（E4 の `sharing-predicate-compiler` で試用の組織で確かめる）。
- 起票の時の行の番号は、行 3 を足した 2026-09-28 に 1 つずつ繰り下げた（旧い行 3 は今の行 4）。

**DT-SHR-002：操作の可否**

| # | 操作 | オブジェクトの権限 | レコードの水準 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 読む | `read` | `read` 以上 | 可 |
| 2 | 編集する | `edit` | `edit` 以上 | 可 |
| 3 | 削除する | `delete` | `full` | 可 |
| 4 | 手動で共有する | `read` | `full`、または `manage_sharing` | 可 |
| 5 | 所有者を変える | `edit` | `full`、または `transfer_records` と `edit` 以上 | 可 |
| 6 | 作成する | `create` | （レコードがまだない） | 可 |
| 7 | それ以外 | - | - | 不可 |

- 読めないレコードへの操作は、存在しない時と同じ 404 `NOT_FOUND` を返す。読めるが操作できない時は 403 `INSUFFICIENT_ACCESS` を返す（[query-language-and-api.md](query-language-and-api.md) の 6.3 節）。

**DT-SHR-003：項目の権限**（3.2 節・3.4 節）は、項目の種類（システムの項目、必須、数式、通常）× 権限セットの和 → 読み・編集、の表として spec に書く。

### 6.2 問い合わせの時の条件

非公開のオブジェクトで、コンパイラ（ADR-0003）の段 4 が足す条件の形。`$me` は利用者、`$cg` は閉包の世代、`$rules` はスナップショットで有効なレコードの条件のルールの ID の集合（7 節）。

```sql
-- G_me：利用者が属するグループ（階層を使わないオブジェクトでは via_hierarchy = false だけ）
WITH g_me AS (
  SELECT group_id FROM group_members_closure
  WHERE org_id = $org AND shard_no = $s AND generation = $cg AND user_id = $me
    AND ($hier OR via_hierarchy = false)
)
SELECT ... FROM records r
WHERE r.org_id = $org AND r.shard_no = $s AND r.object_id = $obj AND r.deleted_at IS NULL
  AND (
        r.owner_id IN (SELECT group_id FROM g_me)                         -- 本人・キュー・部下
     OR r.owner_id IN (SELECT c.user_id FROM group_members_closure c      -- 所有者の条件のルール
                        WHERE c.org_id = $org AND c.shard_no = $s AND c.generation = $cg
                          AND c.via_hierarchy = false
                          AND c.group_id = ANY($rule_sources_for_me))
     OR EXISTS (SELECT 1 FROM record_shares s                            -- 行の付与
                 WHERE s.org_id = $org AND s.shard_no = $s AND s.record_id = r.id
                   AND s.grantee_group_id IN (SELECT group_id FROM g_me)
                   AND (s.rule_id IS NULL OR s.rule_id = ANY($rules)))
     OR EXISTS (SELECT 1 FROM implicit_parent_grants p                   -- 暗黙の親（取引先だけ）
                 WHERE p.org_id = $org AND p.shard_no = $s AND p.parent_id = r.id
                   AND p.grantee_group_id IN (SELECT group_id FROM g_me)
                   AND (p.source_rule_id IS NULL OR p.source_rule_id = ANY($rules)))
     OR EXISTS (SELECT 1 FROM records a                                  -- 暗黙の子（商談・取引先責任者だけ）
                 WHERE a.org_id = $org AND a.shard_no = $s AND a.id = (r.data->>$acct_field_no)::uuid
                   AND a.owner_id IN (SELECT group_id FROM g_me)
                   AND a.owner_id = ANY($owners_with_child_access))
      )
```

- `$rule_sources_for_me` は、スナップショットの `owner_rule_grants` から、`grantee_group_id` が `G_me` にあるルールの `source_group_id` を集めた集合。要求の開始時に求める。
- `$owners_with_child_access` は、ロールの `child_access` がそのオブジェクトで `read` 以上のロールにいる利用者の集合。編集の判定では `edit` 以上にする。
- 活動（`controlled_by_parent`）の条件は、主の親のオブジェクトごとに「`r.parent_id` の親が読める」条件を作って `OR` でつなぎ、`r.owner_id IN (SELECT group_id FROM g_me)` の枝（DT-SHR-001 の行 3）を足す（[sales-objects.md](sales-objects.md) の 4 節）。
- 編集の判定では、各理由の水準（`access_level >= 'edit'` など）を条件に足す。
- `public_read` のオブジェクトの読みでは、この条件を足さない。`public_read_write` では、読み・編集とも足さない。
- `view_all`・`modify_all`・`view_all_data`・`modify_all_data` を持つ利用者には、読みの条件を足さない。
- この形のうち、どの枝から問い合わせを進めるか（共有から進めるか、他の条件から進めるか）は、問い合わせの計画が決める（[query-language-and-api.md](query-language-and-api.md) の 4 節）。
- **利用者の所属（`G_me`）をキャッシュしない。** 所属の変更（グループから外す）の直後に、古い所属で見せないため。`G_me` は閉包の主キーの範囲の読み 1 回で、数 ms で済む。

### 6.3 保存での更新（`applySharingDelta`）

[metadata-and-runtime.md](metadata-and-runtime.md) の 6 節の手順 10 で、トランザクションで変わったレコードの集合について 1 回呼ぶ。

| 変わったもの | 更新 |
| --- | --- |
| レコードの条件のルールの条件の項目 | そのレコードについて、有効な全てのルール（と、作成中のルール。7 節）を評価し直し、`record_shares` の `rule` の行を足し引きする |
| 所有者 | `manual` の行を消す。子（商談・取引先責任者）なら `implicit_parent_grants` のその子の行を作り直す |
| 親の参照（取引先） | その子の `implicit_parent_grants` を作り直す |
| 子の `record_shares`（手動・チーム・ルール） | その子の `implicit_parent_grants` を作り直す |
| 作成 | 上の全てを新しいレコードについて行う |
| 削除・戻す | 何もしない（行はごみ箱の間も残す。[data-storage.md](data-storage.md) の 5 節） |

- 手動の共有とチームの変更は、レコードの DML ではない API（共有の API、チームの API）で行う。その時も、同じトランザクションで `applySharingDelta` を呼ぶ。
- 更新は、変わったレコードの数に比例する。所有者の変更で、所有者の数の多いレコードを書き直さない。

### 6.4 どの経路でも同じ判定

| 経路 | 規則 |
| --- | --- |
| 画面・REST・一括の API | 全て問い合わせと DML の AST にしてコンパイラを通る（ADR-0003） |
| 関係をたどる読み | 親を読めなければ、親の項目は空で返し、親の項目での条件では親がないものとして扱う |
| 参照の項目の表示 | 参照の ID は返す。参照先の名前は、参照先を読める時だけ返す |
| リストビューの件数・レポートの集計 | 読めるレコードだけを数える（reports-and-dashboards の領域） |
| 全文検索 | オブジェクトの権限と FLS は前に（OpenSearch の問い合わせの組織・オブジェクト・`texts.f` の絞り）、レコードの共有は後に（索引から得た ID を、データ層の問い合わせで絞り直してから返す）。索引に共有を写さない（[search.md](search.md) の 6 節、[ADR-0032](../decisions/0032-search-permission-post-filter.md)） |
| 変更のイベント | 購読は、そのオブジェクトの `view_all`（活動・メールは `view_all_data`、利用者は `view_all_users`）を要し、レコードの単位の共有では絞らない（`view_all` なので全てのレコードを読める）。購読の時と配信の時の両方で `DT-EVT-001` を判定し、FLS は配信の時に購読者の権限の形で落とす（[events-and-integrations.md](events-and-integrations.md) の 4.1 節、[ADR-0034](../decisions/0034-event-subscription-access-and-org-events.md)）。Webhook は宛先の `run_as_user_id` の利用者で同じ判定をする |
| エクスポート・一括の問い合わせ | 実行する利用者の権限で判定する |

## 7. 再計算と世代（ADR-0016）

### 7.1 変更の種類と、反映の仕方

| 変更 | 反映 | 途中の見え方 |
| --- | --- | --- |
| レコードの保存、手動の共有、チーム | 同じトランザクション（6.3 節） | 確定まで見えない |
| OWD、`grant_via_hierarchy`、ロールの `child_access` | メタデータの版を上げるだけ（6.2 節の条件が変わる） | 版の切り替えで一度に変わる |
| 所有者の条件の共有ルールの追加・変更・削除 | メタデータの版を上げるだけ | 同上 |
| レコードの条件の共有ルールの追加・変更 | 新しい `rule_id` の行を Worker が作り、できたら版を上げて有効にする（7.2 節） | 作っている間は古いルールで判定する |
| レコードの条件の共有ルールの削除 | 版を上げて無効にし、行は後で消す | 版の切り替えで一度に消える |
| 1 人の利用者のグループ・ロールの変更 | 閉包を同じトランザクションで直す。直す行が 1 万行を超えるなら 7.3 節 | 確定まで見えない |
| ロールの木の移動、グループの入れ子の変更、大きな所属の変更 | 閉包の新しい世代を作り、できたら版を上げて切り替える（7.3 節） | 作っている間は古い世代で判定する |

- **OWD の変更で、行を書き直さない。** `record_shares` は OWD に関わらず、常に保つ。本家は両方の OWD が公開・参照・更新のオブジェクトに共有の表を持たない（RLA）が、本システムは保つ。OWD を非公開に戻した時に、再計算なしで切り替えるため。そのため、OWD の変更には再計算がなく、版の切り替え（p95 5 秒）で反映する。NFR-005 の 15 分の目標は、行を作るレコードの条件のルールの再計算に当てる（2026-09-28 に NFR-005 を改めた。[README.md](README.md) の 3 節）。
- ADR-0004 は「設定の変更は、オブジェクトごとの `active_generation` で影の世代を作る」とした。この文書では、影を作る単位を、レコードの条件のルールの版（`rule_id`）と、閉包の世代に狭めた。影で作るのはそのルールの行だけになり、オブジェクトの全ての共有の行を 2 倍にしない。

### 7.2 レコードの条件のルールの版

1. 管理者がルールを足す・変える。メタデータの版を上げ、新しい `rule_id` を `building` の状態で入れる。変更なら、古い `rule_id` は `active` のまま残す。
2. Worker が、オブジェクトのレコードを ID の範囲（1 万件）ごとに読み、新しいルールの条件を評価して `record_shares`（`rule_id` は新しいもの）と、子のオブジェクトなら `implicit_parent_grants`（`source_rule_id`）を書く。範囲のレコードを `FOR SHARE` で読み、範囲の書き込みの間に同じレコードの保存を待たせる（1 範囲 1 秒以内）。
3. 範囲を済ませた後に保存されたレコードは、`applySharingDelta` が `building` のルールも評価して書く。範囲を済ませる前のレコードは、Worker が後で読む。
4. 全ての範囲が済んだら、標本の照合（9 節）を新しいルールで 1,000 件行う。食い違いがあれば、切り替えずに止めて警告する。
5. 1 つの版で、新しい `rule_id` を `active` にし、古い `rule_id` を `retired` にする。スナップショットの有効なルールの集合（`$rules`）が一度に変わる。
6. `retired` の行を Worker が消す。

- 要求は 1 つの版に固定されるので、1 つの問い合わせの中で、古いルールと新しいルールが混ざらない。
- ジョブは範囲ごとに冪等で、止まっても同じ範囲をやり直せる（ADR-0004）。
- 同じオブジェクトで作成中のルールは、同時に 1 つまで。組織の中で同時に動く共有のジョブは 2 つまで（Worker の公平な順番。ADR-0005）。

### 7.3 閉包の世代

1. ロールの木の移動などで、メタデータの版を上げて新しい構成を `pending` で入れる。閉包の新しい世代 `g+1` を作るジョブを入れる。
2. Worker が、利用者の範囲ごとに、`pending` の構成から閉包の行を `generation = g+1` で書く。
3. ジョブの間の小さな所属の変更は、`g` と `g+1` の両方に書く（範囲を済ませた利用者の分）。
4. 全て済んだら標本の照合をし、1 つの版で構成を有効にし、閉包の世代を `g+1` に切り替える。
5. `g` の行を後で消す。

- 閉包の世代の番号は、スナップショットの `sharing` の部品に入る（[metadata-and-runtime.md](metadata-and-runtime.md) の 4.4 節）。
- 閉包のジョブは、組織の中で同時に 1 つまで。作っている間の次の構成の変更は、そのジョブが終わってから次のジョブにまとめる。

### 7.4 共有の計算の保留

- `defer_sharing` の権限を持つ管理者は、組織の共有の計算を保留にできる（本家の機能に倣う。LDV）。
- 保留の間：レコードの条件のルールと閉包の世代のジョブは、作ってもよいが切り替えない。構成の変更は `pending` のまま積む。レコードの保存・手動の共有・小さな所属の変更は、今までどおり同じトランザクションで反映する。
- 再開で、積んだ構成の変更を 1 つのジョブにまとめて作り、切り替える。
- 保留と再開は監査に残す。保留が 7 日を超えたら、管理者と Ops に警告する。

## 8. スキュー（ADR-0016）

| 種類 | 閾値 | 本家 | 本システムでの影響 | 対応 |
| --- | --- | --- | --- | --- |
| 所有者のスキュー | 1 人が 1 オブジェクトで 1 万件を超えて所有 | 1 万件を超えて所有しない（LDV） | 所有者は問い合わせの時に結ぶので、ロールの変更・所有者の変更の費用は増えない。所有者から進める計画が選ばれにくくなる | Setup に警告。ロールなしの利用者に持たせることを勧める |
| 親のスキュー | 1 つの親に 1 万件を超える子 | 1 万件を超える子を置かない（LDV） | 暗黙の親は子ごとの行なので、行の奪い合いはない。積み上げ集計が親の行ロックを取る（automation-flows の領域） | Setup に警告。親の行ロックの待ちを計測する |
| グループの大きさ | 1 利用者の閉包が 2 万行、または 1 グループの閉包が 1 万人 | — | 所属の変更で直す閉包の行が増える | 1 万行を超える閉包の変更は、同期ではなく閉包の世代のジョブにする |
| 共有の行の多さ | 1 レコードの `record_shares` が 500 行 | — | 判定の `EXISTS` が重くなる | 手動の共有の上限（5.3 節）。グループへの共有を勧める |

- スキューの数は、`stats_owner_counts`（[query-language-and-api.md](query-language-and-api.md) の 4.2 節）と、閉包の行の数から、毎日求める。

## 9. 参照の評価器と標本の照合（ADR-0017）

### 9.1 参照の評価器

- `referenceAccess(state, userId, recordId) → level` の TypeScript の純粋な関数。`state` は、権限セットと割り当て、OWD、ロールの木、グループの定義（入れ子のまま）、共有ルール、利用者、レコード（所有者、親、項目）、手動の共有、チーム。
- 決定表（DT-SHR-001・002・003）と 5 節の定義を**そのまま**書く。閉包・世代・`record_shares`・`implicit_parent_grants` を使わない。ロールの木とグループの入れ子は、その場でたどる。
- 速さは問わない。本番の対話の経路では使わない。

### 9.2 性質ベーステスト

- ジェネレーター：ロール 1〜8、利用者 1〜10、公開グループ 0〜4（入れ子を含む）、キュー 0〜2、ルール 0〜5（所有者の条件・レコードの条件）、レコード 0〜30、オブジェクト 1〜3（うち 1 つは親に連動、1 組は暗黙の共有の親子）。
- 操作：レコードの作成・更新・所有者の変更・削除・戻す、手動の共有、チーム、所属の変更、ロールの移動、OWD の変更、ルールの追加・変更・削除、ジョブの範囲の 1 歩、切り替え、保留と再開。
- 性質：
  - `PROP-SHR-001`（草案）：任意の操作の列の後、全ての（利用者、レコード、操作）で、本番の経路（Testcontainers の PostgreSQL で 6.2 節の条件を実行）の結果が参照の評価器と一致する。
  - `PROP-SHR-002`（草案）：ジョブの途中のどの時点で問い合わせても、1 つの問い合わせの結果の全体が、古い構成の評価器の結果か、新しい構成の評価器の結果のどちらか一方と一致する。
  - `PROP-SHR-003`（草案）：任意の操作の列で、読めないレコードの ID が、問い合わせ・関係をたどる読み・件数のどこにも出ない。
- 1 回の CI で 1,000 通り、夜間に 10 万通り回す。

### 9.3 本番の標本の照合

- Runtime は、1 件の読みの判定の 1,000 件に 1 件と、問い合わせの結果の 1 万行に 1 行を標本にし、（組織、利用者、レコード、判定した水準、メタデータの版、閉包の世代）を SQS に送る。組織ごとに 1 分 10 件、全体で 1 秒 200 件まで。
- Worker は、その時点の DB の状態を読んで参照の評価器で判定し直す。食い違いがあれば 5 秒後にもう一度判定する（直後の変更との競合を除く）。
- 2 回とも食い違えば `access_oracle_mismatch_total{direction}` を数える。
  - `direction = over`（本番が評価器より多く見せた）：情報の漏えいの疑い。セキュリティの当番を呼び出す。
  - `direction = under`（少なく見せた）：警告にし、翌営業日に調べる。
- 食い違いを自動で直さない。原因（閉包の漏れ、ルールの行の漏れ、条件の生成の不具合）を調べてから直す。

## 10. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| ルールの版・閉包の世代のジョブが止まる | 冪等なので再開で続ける。切り替えの前なので、判定は古い構成のまま |
| 切り替えの前の標本の照合で食い違う | 切り替えない。ジョブを止めて警告する。管理者には「計算中」と見せ続ける |
| 本番の標本の照合で `over` が出る | 呼び出し。runbook `access-oracle-mismatch` で、該当の組織の対象のオブジェクトに、評価器で確かめる安全の設定（機能フラグで、そのオブジェクトの読みの結果を評価器でも絞る）をかけられる |
| 閉包が大きくなりすぎる | 8 節の警告。1 利用者 5 万行で、所属の追加を断る |
| 保留が長く続く | 7 日で警告 |
| 所属の読み（`G_me`）が遅い | 閉包の主キーの範囲の読みの p99 を計測する。遅ければ、利用者の閉包の行の数を調べる |

## 11. セキュリティ

- この領域の全ての変更は `security:sensitive` にする（systems/salesforce の AGENTS.md）。
- 判定は、コンパイラの段 3・4 の 1 か所だけで行う（ADR-0003）。経路ごとに判定を書かない。
- 判定の規則を変える変更は、決定表（`DT-SHR-*`）の変更を伴う。決定表のない変更で判定を変えない（AGENTS.md）。
- 読めないレコードは 404 にし、存在を漏らさない。読めない項目は存在しない項目と同じ応答にする（3.4 節）。
- 利用者の所属をキャッシュしない（6.2 節）。所属を外した直後に古い権限で見せない。
- 権限セットの割り当て、共有ルール、OWD、ロール、グループ、保留の変更は、監査のログに残す（audit-and-field-history の領域）。
- `manage_users` を持つ利用者が、自分より強い権限セットを割り当てることを防ぐ規則は、orgs-users-and-auth の領域で決める。

## 12. テスト

- 決定表：`DT-SHR-001`（レコードの水準）、`DT-SHR-002`（操作）、`DT-SHR-003`（項目）を、spec から直接読み込む表駆動テストにする。
- 性質ベーステスト：9.2 節の `PROP-SHR-001`〜`003`。7.2 節の範囲の書き込みと保存の競合を、並行の操作で試す。
- 上限の試験：5.7 節の上限で、ちょうどで通り、1 つ超えたら拒否する。閉包の同期の更新が 1 万行で同期、1 万 1 行で非同期のジョブになる。
- 経路ごとの否定側のテスト：画面・REST・一括・レポート・リストビューの件数・検索・変更のイベント・エクスポート・関係をたどる読みで、読めないレコードと読めない項目が出ない（ADR-0004）。
- 性能テスト（E4 の PoC）：6.2 節の条件で、100 万件・1,000 人の組織のリストビューの最初のページが NFR-001 に収まる。所有者の条件のルールの結合の速さ（ADR-0004 の持ち越し）。
- 性能テスト（E12）：100 万件・1,000 人の組織でのレコードの条件のルールの追加が 15 分以内、ロールの木の移動での閉包の世代の作成が 5 分以内（NFR-005、K6）。

## 13. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0013](../decisions/0013-permission-sets-and-field-level-security.md) | 権限は権限セットで与えて和で合わせ、プロファイルは既定値と基本の権限セットの入れ物にする。読めない項目は存在しない項目と同じに扱う |
| [0014](../decisions/0014-owd-roles-groups-and-closure.md) | OWD の変更は述語の切り替えだけにし、利用者本人とキューもグループとして、ロール階層を含む閉包を 1 つの表にまとめる |
| [0015](../decisions/0015-sharing-reasons-and-where-they-live.md) | 所有者の条件のルールと暗黙の子は問い合わせの時に、レコードの条件のルール・手動・チーム・暗黙の親は行に持つ。暗黙の親は子ごとの行にする |
| [0016](../decisions/0016-recalculation-rule-versions-and-skew.md) | 再計算の単位をレコードの条件のルールの版と閉包の世代にし、切り替えの前に標本で照合する。スキューは 1 万件で警告し、大きな閉包の変更は非同期にする |
| [0017](../decisions/0017-reference-access-evaluator.md) | 参照の評価器を決定表をそのまま書いた純粋な関数にし、性質ベーステストと本番の標本の照合に使う。多く見せる食い違いはセキュリティの呼び出しにする |

## 14. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：`DT-SHR-*` の表駆動テストを spec から読み込む枠。`PROP-SHR-*` の性質ベーステストの枠（Testcontainers） |
| E2 | プロファイル（既定値と基本の権限セット）と、利用者の作成での割り当て |
| E4 | 権限セット・権限セットのグループ・割り当て（期限を含む）、権限の依存の検査、権限の形のコンパイル |
| E4 | FLS をかける場所（3.4 節）と、読めない項目を存在しない項目と同じに扱う応答 |
| E4 | OWD と `grant_via_hierarchy`、ロールの木、グループの種類、閉包の表と同期の更新 |
| E4 | 問い合わせの時の条件（6.2 節）の生成と、`DT-SHR-001`・`002` の表駆動テスト |
| E4 | 所有者の条件の共有ルール（メタデータだけ） |
| E4 | レコードの条件の共有ルールと、ルールの版のジョブ（7.2 節） |
| E4 | 手動の共有の API と、所有者の変更での削除 |
| E4 | 閉包の世代のジョブ（7.3 節）と、共有の計算の保留（7.4 節） |
| E4 | 参照の評価器と `PROP-SHR-001`〜`003` |
| E4 | 本番の標本の照合と `access_oracle_mismatch_total`、呼び出し |
| E4 | E4 の PoC：所有者の条件のルールの結合の速さ、100 万件・1,000 人のリストビュー |
| E5 | 親に連動（活動）、チーム、暗黙の親・子の共有（取引先・商談・取引先責任者）と、ロールの `child_access` |
| E5 | 関係をたどる読み・参照の名前の表示での判定（6.4 節） |
| E12 | スキューの警告（8 節）と、100 万件でのルールの追加・ロールの移動の負荷試験 |

## 15. 未解決の問い

- 暗黙の親を、所有者の条件の共有ルールで子を見る利用者にも与えるか（本家の振る舞いは未検証。E5 の `implicit-and-parent-sharing` で確かめる）。
- 所有者の変更で、チームを残すか消すか（本家は未検証。同じ Story で確かめる）。
- キューのメンバーに `full` を与えるか、`edit` にとどめるか（本家は未検証。E4 の `owd-roles-groups-closure` で確かめる）。
- 新しいカスタムオブジェクトの OWD の既定を `private` にしてよいか（本家の既定は `Public Read/Write`。2 節・4 節）。
- 本番の標本の照合で `over` が出た時に、自動で安全の設定をかけるか、人が判断するか。
- 利用者の所属をキャッシュしない方針で、対話の要求の p95 が NFR-001 に収まるか。
- 共有ルールの数などの上限の本家の値を、試用の組織で確かめるか（共有ルールと権限セットの数は割り当ての表で確かめた。他は未検証）。

### 決定

2026-09-28 の既定案。

- 暗黙の親は、子の所有者と子の行の付与の相手にだけ与える。本家との差として移行の文書に書く。要望が出たら、ルールの版のジョブで暗黙の親の行も作る形に広げる（`source_rule_id` をすでに持っている）。
- 所有者の変更ではチームを残す。
- キューのメンバーには `full` を与える。キューのレコードは、メンバーが引き取って所有者になる前提のため。
- 新しいカスタムオブジェクトの既定は `private` にする。
- `over` の食い違いでは自動の安全の設定をかけず、呼び出しを受けた人が runbook で判断する。誤った自動の遮断で、営業の業務を止めないため。1 時間以内に判断できなければ、安全の設定をかける。
- 所属はキャッシュしない。E4 の PoC で `G_me` の読みの p99 が 5ms を超えたら、所属の版の番号（所属の変更で上げる）をキーにしたキャッシュを検討する。
- 本家の上限の値は確かめない。本システムの値を上限の試験で守る。

## 16. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：共有の判定の誤りによる情報の漏えい（最重要）。決定表、性質ベーステスト、経路ごとの否定側のテスト、本番の標本の照合の 4 重で見る。
- リスク：再計算の途中の新旧の混在。`PROP-SHR-002` と、並行の操作のテスト。
- リスク：FLS の漏れ（条件・並べ替え・数式・イベント）。3.4 節の表を否定側のテストにする。
- 上限の試験：5.7 節と、閉包の同期と非同期の境目。
- 本番での検証：`access_oracle_mismatch_total{direction="over"}` が 0。切り替えの前の標本の照合の結果。

**runbooks**

- `access-oracle-mismatch`：標本の照合の食い違い。`over` なら呼び出し。対象を特定し、安全の設定をかけるか判断する。
- `sharing-job-stuck`：ルールの版・閉包の世代のジョブが進まない、切り替えの前の照合で止まった。
- `sharing-deferred-too-long`：保留が 7 日を超えた。
- `data-skew-warning`：所有者・親のスキュー、閉包の大きさの警告の組織への案内。
- SLI の追加の依頼（Ops へ）：`access_oracle_mismatch_total{direction}`、共有のジョブの所要時間（NFR-005）、`G_me` の読みの p99、閉包の行の数の最大、保留の組織の数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `permission_sets` | `org_id`、`ps_id`、`api_name`、`is_profile_base`、`license` | メタデータ。`license` は orgs-users-and-auth の依頼 |
| `permission_set_object_perms` | `org_id`、`ps_id`、`object_id`、`can_read`、`can_create`、`can_edit`、`can_delete`、`can_view_all`、`can_modify_all`（列の名前は [data-model.md](data-model.md) の 8 節） | メタデータ |
| `permission_set_field_perms` | `org_id`、`ps_id`、`field_id`、`can_read`、`can_edit` | メタデータ |
| `permission_set_system_perms` | `org_id`、`ps_id`、`perm` | メタデータ |
| `permission_set_groups`、`permission_set_group_members` | `org_id`、`psg_id`、`ps_id` | メタデータ |
| `profiles` | `org_id`、`profile_id`、`base_ps_id`、既定のレイアウト・レコードタイプ、ログインの制限 | メタデータ |
| `user_perm_assignments` | `org_id`、`user_id`、`ps_id` または `psg_id`、`expires_at` | データ（版を上げない） |
| `roles` | `org_id`、`role_id`、`parent_role_id`、`child_access` | メタデータ |
| `groups`、`group_direct_members` | `org_id`、`group_id`、`kind`、`grant_via_hierarchy`、`member_kind`、`member_id` | 構成 |
| `group_members_closure` | 4.4 節 | 分割、RLS、世代 |
| `owner_rule_grants` | `org_id`、`object_id`、`rule_id`、`source_group_id`、`grantee_group_id`、`access_level` | メタデータ |
| `criteria_rules` | `org_id`、`rule_id`、`rule_key`、`object_id`、`condition`、`grantee_group_id`、`access_level`、`state`（`building`・`active`・`retired`） | メタデータ |
| `record_shares` | `org_id`、`object_id`、`record_id`、`grantee_group_id`、`access_level`、`row_cause`（`manual`・`team`・`rule`）、`rule_id` | 分割、RLS |
| `implicit_parent_grants` | `org_id`、`parent_object_id`、`parent_id`、`child_id`、`grantee_group_id`、`source_rule_id` | 分割、RLS |
| `record_team_members` | `org_id`、`record_id`、`user_id`、`team_role`、`access_level` | |
| `sharing_jobs` | `org_id`、`kind`（`rule`・`closure`）、`target`、`state`、`progress`、`deferred` | |
| `access_oracle_samples` | `org_id`、`user_id`、`record_id`、`decided`、`oracle`、`direction`、`checked_at` | 食い違いだけを残す |

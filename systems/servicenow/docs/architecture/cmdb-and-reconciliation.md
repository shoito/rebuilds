# CMDB and reconciliation: ServiceNow

CI のクラスの階層と属性、識別の規則（独立・依存の CI）と 1 つの入口、取り込み元の優先度と鮮度による属性ごとの調整、重複の候補と統合、関係の型と PostgreSQL の上の関係の表、影響の範囲の走査、CSDM に寄せたサービスのモデルを決める。後のディスカバリーとサービスマッピングは、この入口の取り込み元の 1 つとして足す。

前提の決定は、CI の作成・更新を識別と調整の 1 つの入口に集め、正規化した識別の値の一意の索引で重複を防ぎ、属性ごとの優先度と鮮度で調整し、関係のグラフを PostgreSQL に持つこと（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）、CI の階層を 1 つの表 `ci` に置き、クラスに固有の属性を `ext` に入れること（[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)、[ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)）、レコードのクラスを作成の後に変えないこと（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.4 節）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0036](../decisions/0036-ci-classes-and-identification-rules.md) | CI のクラスは組み込みの階層にテナントが子を足せる形で持つ。識別の規則はクラスごとに、優先度の付いた識別の項目（属性の組）の一覧で、子は親の規則を継承する。複数の値を持つ属性（MAC アドレスなど）は値ごとに索引に入れる。取り込み元の固有のキーを最も優先の項目として持つ。依存の CI は親の CI と自分の値の組で識別する。クラスの違う CI に一致しても、クラスを変えない |
| [0037](../decisions/0037-ci-ingest-entry-point-and-ambiguity-hold.md) | 1 つの入口は、ペイロードの項目ごとに 1 つのトランザクションで識別と調整を行う。一致は、値のあるすべての識別の項目の一致の和集合で決め、2 つ以上の CI なら保留にする。作成と識別の値の登録は一意の制約の下で行い、違反なら識別をやり直す。保留は候補の集合ごとに 1 つのタスクにまとめ、統合は人だけが行う。ペイロードは取り込み元の観測の時刻を必須にする |
| [0038](../decisions/0038-attribute-reconciliation-per-source-state.md) | 調整は、CI・取り込み元ごとの最新の観測の状態を持ち、属性の値をその状態の集合から決まる純粋な関数で選ぶ。鮮度は、その属性の最新の観測の時刻から測る。これで到着の順序によらず最終の値が決まる。関係の有無も、取り込み元ごとの「ある・ない」の最新の状態から決める。ADR-0005 の調整の決定表を、この形に細かくする |
| [0039](../decisions/0039-ci-relations-impact-traversal-and-service-model.md) | 関係は型付きの表で、型ごとに影響の伝わる向きを持つ。影響の範囲は再帰の CTE で、深さ 6・節の数 10,000・2 秒で打ち切る。画面の走査は見る人の ACL の述語を走査に押し込み、変更の承認の根拠の走査はシステムの主体で行って写しを残す。サービスのモデルは CSDM に寄せたクラス（ビジネスのサービスと提供、サービスのインスタンス、技術のサービスと提供、ビジネスのアプリ、動的な CI のまとまり）で持つ |

この文書の決定表・性質は設計の草案である。ID は E10 の各変更の `spec.md` に移すときに確定する。

## 1. 目的と範囲

- 扱う：CI のクラスと属性、識別の規則と正規化、取り込み元とデータ源の規則、1 つの入口（API・CSV・外部の資産管理・画面の手入力）、ペイロードの形、識別の手順と並行、保留と重複の候補、統合、属性の調整、関係の型と調整、鮮度と廃止の候補、影響の範囲の走査、サービスのモデル、変更とインシデントの画面への影響の範囲の提供。
- 扱わない：ディスカバリーのエージェントとサービスマッピング（MVP の後。[intent.md](../intent.md)）、資産管理（ライセンス・購買。MVP の後）、取り込みの API の認証とレート制限の細部（`api-and-integrations.md`）、CI の画面（`portal-and-ui.md`）、変更のリスクと承認での影響の範囲の使い方（[itsm-processes.md](itsm-processes.md) の 8.3・9.4 節）。
- **CI と CI の関係の作成・更新は、この文書の入口だけが行う**（[AGENTS.md](../../AGENTS.md)、[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）。Record Service は `ci` と `ci_relation` への入口の外からの書き込みを拒否する（`cmdb_admin` の統合・廃止の操作も入口の中の操作として実装する）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| 識別 | 識別の規則で CI を一意に見分ける。取り込み元の名前と取り込み元の固有のキー（`source_name`・`source_native_key`）での識別が速い道。属性の組での照合は遅い道 | [Identification and Reconciliation engine (IRE)](https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/ire.html) |
| 依存の CI | 依存の CI（アプリなど）は、依存の分類（ホストのサーバーなど）で先に親を識別してから識別する。同じ設定のパスが複数の機器にありうるため | 同上 |
| 識別の項目 | 識別の項目を優先度の順に試す。参照の表（ネットワークのアダプターなど）の上の項目を持てる。関係の項目（related entries）は識別には使わず、関係の表のレコードを作る | 二次の資料とコミュニティの記事。細部は未検証（本家の振る舞いで、設計の前提ではない） |
| 調整 | 権威のある取り込み元だけが CI の属性を書ける（静的な調整の規則。取り込み元の優先度を決める旧来の規則）。子のクラスの規則が親の規則を上書きする | IRE の文書、[Reconciliation rules](https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/r_ReconciliationRulesPrinciples.html) |
| 時刻 | 最後に見つけた時刻はペイロードの時刻が新しいときだけ更新する。取り込み元の新しさの時刻（`source_recency_timestamp`）で、衝突したときの値の優先を決める | IRE の文書 |
| データの更新の規則・動的な調整 | データの更新の規則は、取り込み元の観測が古くなったとみなし、優先度の低い取り込み元に書かせる時期を決める。動的な調整の規則は、複数の取り込み元の値から最大の値や最も多く報告された値を選ぶ。同じ属性に両方があれば動的な規則が勝つ | [Reconciliation rules](https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/r_ReconciliationRulesPrinciples.html) |
| ペイロードの重複 | ペイロードの中の重複の項目を 1 つにまとめて処理する | IRE の文書 |
| CSDM 5 | 領域（基盤、構想と戦略、設計と計画、構築と統合、サービスの提供、サービスの消費、ポートフォリオの管理）を持つ。「アプリのサービス」は「サービスのインスタンス」、「技術のサービス」は「技術の管理のサービス」に名前が変わった（表の名前は同じ）。サービスの消費の領域はビジネスのサービス・その提供・要求のカタログ | [CSDM 5 White Paper](https://www.servicenow.com/community/s/cgfwn76974/attachments/cgfwn76974/common-service-data-model-kb/744/3/CSDM%205%20w%20links.pdf)（7 つの領域、表のラベルの変更）。二次の資料（[CSDM 5.0 Explained](https://dss.bg/news/csdm-5-0-explained-whats-new-how-it-works-why-it-matters)、[Your A-Z guide to CSDM 5.0](https://plat4mation.com/blog/your-a-z-guide-to-csdm-5-0/)）も参照 |

- 本家は、複数の CI に一致したとき、既定で最も古い CI を選んで更新し、重複の解消のタスクを作るとされる（コミュニティの記事で確認。公式の本文は未検証で、本家の振る舞いで、設計の前提ではない）。本システムは推測で選ばず保留にする（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）。
- 本家の CI のクラスの名前、表の名前、CSDM の表の名前は写さない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。CSDM の版の追従は目標にしない（ADR-0005）。

## 3. CI のクラスと属性（[ADR-0036](../decisions/0036-ci-classes-and-identification-rules.md)）

### 3.1 組み込みのクラスの階層

```
ci
├─ hardware
│   ├─ computer
│   │   ├─ server ─┬─ linux_server
│   │   │          └─ windows_server
│   │   └─ end_user_device（PC）
│   ├─ network_device（ルーター、スイッチ、ファイアウォールは device_role の選択肢）
│   └─ storage_device
├─ virtual_machine
├─ cloud_resource ─┬─ cloud_vm、cloud_database、cloud_bucket、cloud_load_balancer
├─ software_instance ─┬─ app_server_instance、database_instance、web_server_instance
├─ business_application
├─ service ─┬─ business_service
│           ├─ service_offering ─┬─ business_service_offering
│           │                    └─ technology_service_offering
│           ├─ technology_service
│           └─ service_instance（CSDM の「アプリのサービス」に当たる）
└─ ci_group（動的な CI のまとまり）
```

- テナントは、組み込みのクラスの子を作れる（深さは辞書と同じく 6 段まで。[ADR-0006](../decisions/0006-data-dictionary-and-field-types.md)）。
- クラスの名前は本システムのもの。本家のクラスの名前は写さない。

### 3.2 属性

| 置き場所 | 属性 |
| --- | --- |
| `ci` の型付きの列（全クラス共通） | `tenant_id`、`id`、`class_id`、`name`、`operational_status`（`operational` / `non_operational` / `repair` / `retired` / `stale_candidate`）、`owner_group_id`、`support_group_id`、`location_id`、`environment`（`production` / `staging` / `development` / `test`）、`criticality`（1〜4）、`first_seen_at`、`last_seen_at`、`merged_into_id`、`version`、`created_at`、`updated_at` |
| `ci.ext`（クラスに固有。組み込みも。ADR-0003 の例外） | `serial_number`、`asset_tag`、`manufacturer`、`model`、`fqdn`、`host_name`、`ip_addresses`（複数）、`mac_addresses`（複数）、`bios_uuid`、`os`、`os_version`、`cpu_count`、`memory_mb`、`cloud_account`、`cloud_region`、`cloud_resource_id`、`install_path`、`port`、`version` など |

- 複数の値を持つ属性（`ip_addresses`、`mac_addresses`）は、`ext` の中で配列にする。辞書の型（14 種）に配列はないので、CI の属性の定義（`ci_attribute`）で `multi: true` を持たせ、入口の中だけで扱う（辞書の `ext` の検証は配列の各要素に型を当てる）。この扱いは CMDB の入口だけの例外で、テナントの他のテーブルには広げない。
- 絞り込み・並べ替えに使う属性（`serial_number`、`fqdn`、`host_name` など）は、組み込みで `ext_index` に写す（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 4.2 節の「索引を付ける」を組み込みで立てる）。

## 4. 識別の規則（[ADR-0036](../decisions/0036-ci-classes-and-identification-rules.md)）

### 4.1 形

```
IdentificationRule {                 ← クラスごと。なければ最も近い祖先の規則を使う
  class_id
  kind: independent | dependent
  depends_on?: { relation_type, parent_class }       ← dependent のとき（例：runs_on → computer）
  entries: [{ id, priority, attributes: [attr], allow_partial: false }]
}
```

- **取り込み元の固有のキー**（`(source_id, native_key)`）を、すべてのクラスで最も優先の暗黙の項目にする（本家の速い道に当たる。2 節）。取り込み元が自分の中の ID を送るとき、2 回目からはこの項目で一致する。
- 項目の属性の値がすべて揃い、正規化の後に有効なときだけ、その項目を使う（`allow_partial` は MVP で偽に固定）。
- 複数の値の属性を含む項目は、値ごとに別の識別の値として扱う（例：`mac_addresses` の各 MAC）。どれか 1 つが一致すれば、その項目で一致する。

組み込みの規則（既定）：

| クラス | 項目（優先度の順） |
| --- | --- |
| `hardware`（と子） | 1：`serial_number` ＋ `manufacturer`、2：`bios_uuid`、3：`mac_addresses`（値ごと）、4：`fqdn`、5：`name` ＋ `location_id`（`network_device` だけ） |
| `virtual_machine` | 1：`bios_uuid`、2：`cloud_resource_id` ＋ `cloud_account`、3：`mac_addresses`、4：`fqdn` |
| `cloud_resource`（と子） | 1：`cloud_resource_id` ＋ `cloud_account` ＋ `cloud_region` |
| `software_instance`（と子） | 依存（`runs_on` → `computer` か `virtual_machine`）。1：`install_path` ＋ `port`、2：`name` ＋ `port` |
| `business_application`、`service`（と子）、`ci_group` | 1：`name`（手入力と API が主。正規化は大文字・小文字と空白だけ） |

### 4.2 正規化

| 属性の種類 | 正規化 | 無効の値（識別に使わない） |
| --- | --- | --- |
| `serial_number`、`asset_tag` | 前後の空白を除き、大文字にし、内部の空白を除く | 空、`0`、`NONE`、`N/A`、`DEFAULT STRING`、`TO BE FILLED BY O.E.M.`、`SYSTEM SERIAL NUMBER`、`123456789`、すべて同じ文字、など（組み込みの一覧 ＋ テナントの追加） |
| `mac_addresses` | 区切りの記号（`:`、`-`、`.`）を除き、小文字の 12 桁の 16 進 | `000000000000`、`ffffffffffff`、マルチキャストの印の付いた値、仮想の既知の接頭辞のうちテナントが除いたもの |
| `bios_uuid` | 小文字、ハイフンの形。バイトの順の違い（先頭の 3 つの区切りの並びが逆）の両方の形を識別の値として登録する | すべて 0、すべて F |
| `fqdn`、`host_name` | 小文字、末尾の `.` を除く。IDN は A ラベル（punycode） | `localhost`、`localhost.localdomain` |
| `name` | NFC、前後の空白を除く、大文字・小文字を区別しない（小文字にしたものを索引に） | 空 |
| `cloud_resource_id` | 取り込み元の形のまま（大文字・小文字を区別する） | 空 |

- 正規化の関数は純粋で、冪等である（`normalize(normalize(x)) = normalize(x)`。PROP-CMDB-007）。
- `bios_uuid` の 2 つの形の登録は、同じ機器の取り込み元によってバイトの順が違う形で送られる、よく知られた食い違いへの対策である（一般に知られる事情。本家の扱いは未検証で、本家の振る舞いで、設計の前提ではない）。2 つの形が別の CI にすでに登録されていれば、それは保留（5.3 節）になる。

### 4.3 識別の値の表

```
ci_identifier(tenant_id, rule_class_id, entry_id, value_hash, ci_id, source_id?, created_at)
  UNIQUE (tenant_id, rule_class_id, entry_id, value_hash)
  INDEX  (tenant_id, ci_id)
value_hash = sha256(entry_id, 正規化した値の組の正準の JSON)
依存の CI：value_hash に親の CI の ID を含める
取り込み元の固有のキー：entry_id = 'native'、value_hash = sha256(source_id, native_key)
```

- `rule_class_id` は、規則を持つクラス（識別に使った規則の持ち主）。子のクラスが親の規則を継承するとき、親のクラスの ID になる。これで、`linux_server` と `server` の CI が同じシリアル番号を持てば、同じ規則の上で一意の制約にかかる。
- 規則の違う 2 つのクラス（例：`hardware` と `virtual_machine`）の間では、同じ MAC が別の CI に登録されうる（物理のホストと仮想の機械は別の CI）。

### 4.4 クラスの違う一致

- ペイロードのクラスと、一致した CI のクラスが違うときは、**CI のクラスを変えない**（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.4 節）。
  - ペイロードのクラスが、一致した CI のクラスの子孫（`server` の CI に `linux_server` のペイロード）：一致として扱い、CI のクラスにない属性を捨て、項目の結果に `class_mismatch` の警告を残す。
  - それ以外（祖先、または別の枝）：保留（`class_conflict`）。
- クラスの付け替え（`server` を `linux_server` にする）は持ち越し（14 節）。辞書の「クラスを変えない」の例外を作るかの判断になる。

## 5. 1 つの入口（[ADR-0037](../decisions/0037-ci-ingest-entry-point-and-ambiguity-hold.md)）

### 5.1 取り込み元とデータ源の規則

| 表 | 列 |
| --- | --- |
| `ci_source` | `tenant_id`、`id`、`name`、`kind`（`manual` / `csv` / `api` / `asset_mgmt` / `discovery`（後）/ `cloud_api`）、`integration_user_id`、`active` |
| `ci_source_rule`（データ源の規則） | `tenant_id`、`source_id`、`class_id`、`may_create`、`may_update`、`may_create_relations` |

DT-CMDB-003（取り込み元が作ってよいか）：

| # | 識別の結果 | クラスの規則（最も近い祖先で探す） | 結果 |
| --- | --- | --- | --- |
| 1 | 新規 | `may_create` が真 | 作る |
| 2 | 新規 | `may_create` が偽、または規則がない | 項目のエラー `create_not_allowed`（CI を作らない） |
| 3 | 一致 | `may_update` が真 | 調整（6 節）へ |
| 4 | 一致 | `may_update` が偽 | 観測は記録しない。`last_seen_at` だけを進める（その取り込み元がこの CI を見たことは残す） |
| 5 | 保留・エラー | - | 何も書かない |

- 組み込みの既定：`manual` と `asset_mgmt` はすべてのクラスで作れる。`api` と `csv` は、テナントが規則を足すまで `hardware` と `software_instance` の子だけを作れる。サービスのクラス（`service` の子）は `manual` だけが作れる（サービスは人が定義するもの）。

### 5.2 ペイロード

```
POST /cmdb/ingest  （api-and-integrations.md のパスの形に合わせる）
{
  source: <source_id>,
  batch_key: <取り込み元が付ける冪等のキー>,            ← (tenant, source, batch_key) で 7 日一意
  items: [{
    ref: "a1",                                           ← ペイロードの中の参照の名前
    class: "linux_server",
    native_key?: "srv-0001",
    observed_at: "2026-09-28T01:23:45Z",                  ← 必須。取り込み元がその値を観測した時刻
    attributes: { serial_number: "...", mac_addresses: [...], ... },
    present_attributes?: [...]                            ← 値を空にしたい属性（明示の「空」）
  }],
  relations: [{ parent: "a1" | {ci_id}, child: "b2" | {ci_id}, type: "runs_on",
               observed_at, state: "present" | "absent" }],
  relation_snapshot?: [{ ci: "a1", types: ["runs_on"] }]   ← この CI のこの型の関係は、送ったものがすべて（ほかは absent）
}
```

- 1 つのペイロードは、項目 1,000、関係 5,000 まで。CSV は取り込みの道具が同じ形のペイロードに変換する（CSV の列と属性の対応は、取り込み元ごとの設定）。
- **`observed_at` を必須にする。** 受け付けの時刻（壁時計）で代えると、到着の順序で結果が変わる（6.3 節）。手入力の画面は、保存のトランザクションの DB の時刻を `observed_at` にする。
- `observed_at` が受け付けの時刻より 5 分以上未来の項目は、エラー `observed_at_in_future`（取り込み元の時計の誤りを、最新の観測として固定させないため）。
- 画面の手入力（`cmdb_admin` と CI の `support_group` のメンバー）も、`manual` の取り込み元のペイロード（項目 1 つ）として同じ入口を通る。

### 5.3 識別の手順

```
identify(item, rule, lookup) → Match(ci) | New | Held(reason, candidates) | Error(reason)
  0. 依存の CI なら、関係の項目から親を先に識別する（同じペイロードの ref か、ci_id）。
     親が New・Held・Error なら Error(parent_unresolved)
  1. 使える項目（値がすべて揃い、正規化の後に有効）ごとに、識別の値の集合を作る（native を含む）
     使える項目が 1 つもなければ Error(no_identifier)
  2. candidates = ⋃ lookup(entry, value_hash)      ← 使えるすべての項目の一致の和集合
  3. |candidates| = 0 → New
     |candidates| = 1 → Match（4.4 節のクラスの検査）
     |candidates| ≥ 2 → Held(ambiguous, candidates)
```

- **一致は、使えるすべての項目の和集合で決める。** [ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md) の「上から順に照合し、一致したら既存の CI を更新」を、「最初の項目の一致で止めず、他の項目が別の CI を指していないかも確かめる」に細かくする。優先の高い項目がある CI に一致しても、低い項目が別の CI に一致するなら、2 つの CI は同じ機器の重複の疑いがあり、推測で片方を更新しない（あいまいなときは止める。ADR-0005）。
- 優先度は、同じ CI に一致する項目の間では意味を持たない。優先度は、`Match` の後に新しい識別の値を登録するときの順（下の 5.4 節）と、画面での説明に使う。
- 識別の関数は、`lookup`（識別の値の表の読み取り）を引数に取る純粋な関数にし、DB の書き込みは呼ぶ側（5.4 節）で行う。

DT-CMDB-001（識別の結果）：

| # | 依存 | 親の識別 | 使える項目 | 一致した CI の数 | クラス | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | はい | 一致しない（New・Held・Error） | - | - | - | エラー `parent_unresolved` |
| 2 | - | - | 0 | - | - | エラー `no_identifier` |
| 3 | - | - | 1 以上 | 0 | - | 新規（DT-CMDB-003 へ） |
| 4 | - | - | 1 以上 | 1 | 同じ、または子孫 | 一致（子孫なら `class_mismatch` の警告） |
| 5 | - | - | 1 以上 | 1 | 祖先・別の枝 | 保留 `class_conflict` |
| 6 | - | - | 1 以上 | 2 以上 | - | 保留 `ambiguous` |
| 7 | - | - | - | 一致した CI が `merged_into_id` を持つ | - | 統合の先の CI で 4〜6 をやり直す（統合の鎖は 5 段まで。超えたらエラー） |
| 8 | - | - | - | 一致した CI が `retired` | - | 一致として扱い、`operational_status` を戻すかは調整（6 節）で決める |

- 7 行は、表の上で先に評価する（統合された古い CI の識別の値が残っていても、統合の先へ向ける）。表の順は `spec.md` で確定する。

### 5.4 書き込みと並行

1 つの項目を、1 つのトランザクションで処理する。

```
BEGIN
  SET LOCAL app.tenant_id
  r = identify(item, rule, lookup = SELECT ... FROM ci_identifier WHERE ...)
  New:
    ci を作る（class、name、first_seen_at = observed_at）
    すべての識別の値を ci_identifier に INSERT          ← 一意の違反なら ROLLBACK、識別からやり直す
    調整（6 節）で属性を書く
  Match(c):
    SELECT ci FOR UPDATE（c）
    まだ登録されていない識別の値を ci_identifier に INSERT（優先度の順）
                                                       ← 一意の違反：その値は別の CI のもの → ROLLBACK、やり直す（次は ambiguous になる）
    調整（6 節）
  Held：ci を変えず、保留の行（5.5 節）を書く
  ingest_item の結果を書く（同じトランザクション）
COMMIT
```

- **並行の取り込みが同じ新しい機器を作ろうとしたら、一意の制約で片方が失敗し、やり直しの識別で既存の CI に一致する**（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）。やり直しは 3 回まで。超えたら項目のエラー `contention` にし、取り込み元が再送する。
- 識別の値の登録を `Match` の後にも行うのは、新しい MAC などを、既存の CI の識別の値として覚えるためである。登録しようとした値が別の CI のものだと分かったら、その取り込みは 2 つの CI を指していたことになるので、やり直しで保留になる。
- ロックの順：`Match` で 1 つの CI の行をロックする。関係の処理（7 節）で 2 つの CI に触れるときは、関係の行だけを書き、CI の行はロックしない（デッドロックを避ける）。
- ペイロードの中の処理の順：独立の CI → 依存の CI（親の順に位相の順）→ 関係。同じペイロードの中で同じ識別の値を持つ項目は、先に 1 つにまとめる（本家と同じ。2 節）。まとめ方は、同じ属性の値が違えば `observed_at` の新しいほう（同じなら正準の値の順）。
- ペイロードの冪等：`(tenant_id, source_id, batch_key)` を 7 日一意にし、同じキーの送り直しは、前の結果を返して何もしない。キーが違っても同じ内容の送り直しは、6 節の調整が冪等なので結果は変わらない（PROP-CMDB-001）。

### 5.5 保留と重複の候補

| 表 | 列 |
| --- | --- |
| `ci_hold` | `tenant_id`、`id`、`reason`（`ambiguous` / `class_conflict`）、`candidate_set_hash`、`candidate_ci_ids`、`task_id`、`first_held_at`、`last_held_at`、`hold_count`、`sample_items`（最新の 5 件のペイロードの項目の写し） |
| `ci_duplicate_task` | `task` の子のクラス。`hold_id`、`candidate_ci_ids`、担当は `cmdb_admin` のグループ |

- **同じ候補の集合の保留は、1 つにまとめる。** `(tenant_id, reason, candidate_set_hash)` を、開いている保留の中で一意にする。同じ取り込みが毎日届いても、タスクは 1 つで `hold_count` が増える（PROP-CMDB-004）。
- 保留の間、候補の CI はどれも変わらない（その項目の観測は記録しない）。取り込み元の結果には `held` と保留の ID を返す。
- 担当者の選択肢：「統合する」（5.6 節）、「別の機器である」（識別の値のうち衝突したものを、どちらかの CI から外し、その値を識別に使わない除外の一覧に入れる）、「取り込み元の誤り」（保留を閉じ、その取り込み元の担当に知らせる）。選んだ後、保留の中の最新の項目を入口に流し直す。

### 5.6 統合

- **統合は人だけが行う**（`cmdb_admin`、理由を必須にする）。自動の統合はしない。誤った統合は戻しにくい（ADR-0005）。
- 1 つのトランザクションで次を行う（統合の先 `s`、統合される側 `d`）：
  - `d` の識別の値を `s` に付け替える（`s` と衝突する値はないはず。あれば統合を中止）。
  - `d` の取り込み元ごとの観測の状態を `s` の状態に合わせる（6 節の max の結合。統合も同じ演算で行う）。属性の値を選び直す。
  - `d` の関係を `s` に付け替える（重複する関係は 1 つにし、取り込み元の状態を結合する。自分への関係になるものは捨てる）。
  - `d` を `operational_status = retired`、`merged_into_id = s` にする。
  - `d` を参照するタスク（`task.ci_id`、変更の影響を受ける CI）は、`bulk_job` で `s` に付け替える（進行中のタスクだけ。完了したタスクは履歴として `d` のまま）。
- 統合を戻す操作は MVP に持たない（統合の前の状態を `ci_merge_log` に残し、`cmdb_admin` が手で直せるようにする）。

## 6. 調整（[ADR-0038](../decisions/0038-attribute-reconciliation-per-source-state.md)）

### 6.1 取り込み元ごとの観測の状態

```
ci_source_state(tenant_id, ci_id, source_id,
                attrs jsonb,        ← { attr_id: { v: 正準の値, t: observed_at } }
                last_seen_at)
PK (tenant_id, ci_id, source_id)
```

- 1 つの CI の 1 つの取り込み元につき 1 行。取り込み元がその CI について最後に観測した、属性ごとの値と時刻を持つ。
- **更新は属性ごとの max の結合で行う。**

```
merge(old, new)[a] =
  a が old にしかない → old[a]
  a が new にしかない → new[a]
  両方にある → t の大きいほう。t が同じなら、正準の値の辞書の順で大きいほう
```

- `merge` は交換・結合・冪等（半束の結合）なので、同じ取り込み元の観測がどの順に届いても、何回届いても、状態は同じになる。
- 明示の「空」（`present_attributes` で値なしを送る）は、`v = null` の観測として同じ演算で扱う。ペイロードに属性がないことは、観測がないことで、値を消さない。
- 書き込みの量：1 つの項目で `ci_source_state` の 1 行の更新と、`ci` の 1 行の更新（値が変わったときだけ）。属性ごとの行を持たないのは、1 秒 1,000 CI × 属性 20 の行の書き込みを避けるためである（NFR-005）。

### 6.2 優先度と鮮度

| 表 | 列 |
| --- | --- |
| `ci_precedence` | `tenant_id`、`class_id`、`attr_id`（`*` はそのクラスのすべての属性）、`source_id`、`priority`（小さいほど強い）、`staleness_days`、`may_write` |

- 規則の探し方：CI のクラスから祖先へたどり、`(attr_id, source_id)` の規則を持つ最初の段を使う。なければ `(*, source_id)` を同じくたどる。それもなければ、取り込み元の既定（`priority = 100`、`staleness_days = 30`、`may_write = true`）。**子のクラスの規則が親の規則に勝つ**（本家の振る舞いに寄せた。2 節）。
- 組み込みの既定：`asset_mgmt` 10、`manual` 20、`cloud_api` 20、`api` 30、`csv` 40、`staleness_days` はすべて 30。テナントが変える。

### 6.3 値の選び方（DT-CMDB-002）

属性 `a` の値は、`a` についての各取り込み元の観測 `O = {(s, v, t)}`（`may_write` の偽の取り込み元を除く）から、次の純粋な関数で選ぶ。

```
choose(O, rules):
  O が空 → 値を変えない（前の値のまま。観測のない属性は調整の外）
  T = max{ t | (s, v, t) ∈ O }                              ← その属性の最新の観測の時刻
  live = { (s, v, t) ∈ O | t ≥ T − staleness(s) }           ← 最新の観測から見て鮮度の中のもの
  (s*, v*, t*) = live の中で、priority(s) の小さい順、t の大きい順、v の正準の順、s の ID の順で最初のもの
  → v*
```

| # | 観測の状況 | 結果 |
| --- | --- | --- |
| 1 | 観測がない | 変えない |
| 2 | 観測が 1 つの取り込み元だけ | その値（鮮度に関係なく） |
| 3 | 複数、最も強い取り込み元の観測が `T − staleness` の中 | 最も強い取り込み元の値 |
| 4 | 複数、最も強い取り込み元の観測が `T − staleness` より古い | 鮮度の中の取り込み元のうち最も強いものの値 |
| 5 | 同じ強さの取り込み元が複数、鮮度の中 | 観測の新しいほう。同じ時刻なら正準の値の順 |

- **鮮度は、壁時計ではなく、その属性の最新の観測の時刻 `T` から測る**（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md) の「鮮度は受け付けた時刻ではなく、ペイロードの時刻で比べる」と同じ考え）。`choose` は現在の時刻を読まないので、同じ観測の集合からは常に同じ値になる。
- **ADR-0005 の調整の決定表との違い**：ADR-0005 は「最後に書いた取り込み元と時刻」だけを持ち、新しいペイロードと比べて書くかを決める。この形では、到着の順で結果が変わる場合がある。例：強い取り込み元 H が時刻 1 日目に値 x、弱い取り込み元 L が 40 日目に値 y を観測し、鮮度が 30 日のとき、H → L の順なら「H の値は L の時刻から見て古い」で y になり、L → H の順なら「H は強い」で x になる。取り込み元ごとの状態を持ち、状態の集合から選べば、どちらの順でも y になる（`T` = 40 日目、H の観測は鮮度の外）。この文書の形は ADR-0005 の細部を決めたもので、ADR-0005 の原則（属性ごと、優先度と鮮度、ペイロードの時刻、到着の順序によらない）は変えない。
- 選んだ値が `ci` の今の値と違えば、`ci`（型付きの列か `ext`）を更新し、監査の履歴（`record_change`、`actor_kind = integration`、`cause_id = ingest_item`）に残す。`ci_attr_winner`（属性ごとに、選ばれた取り込み元と時刻）を `ci.ext` の隣の `provenance` の列（JSONB）に持ち、画面で「この値はどこから来たか」を出す。

### 6.4 最後に見た時刻と廃止の候補

- `ci.last_seen_at = max(ci_source_state.last_seen_at)`（`may_update` の偽の取り込み元も含む。見たことは記録する）。
- 日次のジョブが、`last_seen_at` が `retire_after_days`（クラスごと、既定 90 日）より古く、`operational_status = operational` の CI を `stale_candidate` にし、持ち主のグループに見直しのタスクを 1 件作る。**自動で廃止・削除しない。** 取り込み元が止まっただけ（連携の障害）の可能性があるためである。`manual` だけの CI（サービスなど）はこの対象から外す。
- 入口からは CI を削除しない。廃止は `operational_status = retired`（`cmdb_admin` の操作、または取り込み元の明示の「廃止」の属性の観測）。

## 7. 関係（[ADR-0039](../decisions/0039-ci-relations-impact-traversal-and-service-model.md)）

### 7.1 関係の型

| 表 | 列 |
| --- | --- |
| `ci_relation_type` | `tenant_id`（組み込みは NULL）、`id`、`name`、`parent_label`・`child_label`（「依存する」・「に使われる」など）、`impact`（`child_to_parent` / `parent_to_child` / `none`）、`allowed`（`(親のクラス, 子のクラス)` の組の一覧。祖先で合えばよい） |

組み込みの型：

| 型 | 親 → 子 | 影響の向き | 例 |
| --- | --- | --- | --- |
| `depends_on` | 使う側 → 使われる側 | 子 → 親（子の障害が親に及ぶ） | サービスのインスタンス → データベースのインスタンス |
| `runs_on` | ソフトウェア → ホスト | 子 → 親 | アプリのサーバー → Linux のサーバー |
| `hosted_on` | 仮想の機械 → 物理のホスト | 子 → 親 | VM → サーバー |
| `contains` | 入れ物 → 中身 | 子 → 親 | ビジネスのサービス → その提供 |
| `connected_to` | 機器 → 機器 | なし | スイッチ → サーバー（S1 は影響の走査に使わない） |
| `member_of` | CI → CI のまとまり | 子 → 親（まとまりの中の CI の障害がまとまりに及ぶ） | サーバー → 動的な CI のまとまり（7.4 節で使う） |

### 7.2 表

```
ci_relation(tenant_id, id, parent_id, child_id, type_id, present, first_seen_at, last_changed_at, version)
  UNIQUE (tenant_id, parent_id, child_id, type_id)
  INDEX  (tenant_id, child_id, type_id) WHERE present
  INDEX  (tenant_id, parent_id, type_id) WHERE present
ci_relation_source_state(tenant_id, relation_id, source_id, state: present | absent, t)
  PK (tenant_id, relation_id, source_id)
```

- 関係の有無は、取り込み元ごとの最新の状態（`t` の大きいほう。同じなら `present` を優先）から決める：**どれかの取り込み元の最新の状態が `present` なら `present`**。すべてが `absent` なら `present = false`（行は消さない。履歴と、後の `present` の観測のため）。この演算も max の結合なので、到着の順によらない（PROP-CMDB-002）。
- `relation_snapshot`（5.2 節）は、その CI・型について送らなかった既存の関係に、その取り込み元の `absent`（時刻は項目の `observed_at`）を入れる。その取り込み元が観測したことのない関係には何もしない（他の取り込み元の関係を消さない）。
- 関係の作成・更新も入口の中で行い、データ源の規則の `may_create_relations` と、型の `allowed` を確かめる（DT-CMDB-004）。
- 関係の数の上限：1 つの CI の関係 10,000、テナントの関係 CI の数の 10 倍（S1 の最大のテナントで 5,000 万）。超えたら取り込みの項目のエラー。

DT-CMDB-004（関係の検査）：

| # | 条件 | 結果 |
| --- | --- | --- |
| 1 | 親か子が解けない（ref のエラー、存在しない、統合済みは統合の先に付け替える） | 関係のエラー `endpoint_unresolved` |
| 2 | 親と子が同じ CI | エラー `self_relation` |
| 3 | 型の `allowed` に `(親のクラス, 子のクラス)` が合わない | エラー `relation_not_allowed` |
| 4 | 取り込み元の `may_create_relations` が偽で、関係の行がまだない | エラー `create_not_allowed` |
| 5 | そのほか | 取り込み元の状態を結合し、`present` を決め直す |

- 循環は禁止しない（実際の構成に循環はありうる。`connected_to` など）。走査が循環に強ければよい（8 節）。

### 7.3 依存の CI と関係

- 依存の CI の識別に使う関係（`runs_on` など）は、依存の CI の項目と一緒に送る（5.3 節の 0）。識別の後、その関係を同じトランザクションで `present` にする。

### 7.4 動的な CI のまとまり

- `ci_group` のクラスの CI は、`membership_condition`（CI の属性の式）を持つ。メンバーは日次のジョブ（と条件の変更の時）で計算し、`member_of` の関係として、組み込みの取り込み元 `system_group` の観測で書く（入口を通す）。
- 1 つのまとまりのメンバーは 5,000 まで。
- サービスのインスタンスが「この条件のサーバー群に依存する」を表すのに使う（CSDM の動的な CI のまとまりの考え。2 節）。

## 8. 影響の範囲の走査（[ADR-0039](../decisions/0039-ci-relations-impact-traversal-and-service-model.md)）

### 8.1 問い合わせ

```sql
WITH RECURSIVE impacted(ci_id, depth, path) AS (
  SELECT unnest($start_ids), 0, ARRAY[unnest($start_ids)]
  UNION ALL
  SELECT r.parent_id, i.depth + 1, i.path || r.parent_id           -- 影響の向きが child_to_parent の型
  FROM impacted i JOIN ci_relation r
    ON r.tenant_id = $t AND r.child_id = i.ci_id AND r.present AND r.type_id = ANY($c2p_types)
  WHERE i.depth < $max_depth AND NOT r.parent_id = ANY(i.path)       -- 循環を避ける
  UNION ALL
  ... parent_to_child の型は向きを逆にして同じく
)
SELECT ci_id, min(depth) FROM impacted GROUP BY ci_id LIMIT $max_nodes + 1
```

- 上限：深さ 6（ADR-0005 の既定）、節の数 10,000、文の時間 2 秒（`statement_timeout`）。上限に当たったら、そこまでの結果と `truncated = true` を返す。画面は「一部だけ表示」と出す。
- 経路の配列で循環を避ける。同じ CI に複数の経路で届くときは、最も短い深さを採る。
- S1 の最大のテナント（CI 500 万、関係はその数倍）で、深さ 6 の走査が上限の中に収まるかを E10 で計測する（[architecture/README.md](README.md) の 6 節の持ち越し）。収まらなければ、影響の表の事前の計算か、グラフの専用の置き場所を再評価する（ADR-0005 の S3 の再評価を前倒しする）。

### 8.2 走査の主体と ACL

| 使い道 | 走査の主体 | 結果の見せ方 |
| --- | --- | --- |
| 画面（CI・インシデント・変更の「影響の範囲」） | 見る人 | **見る人の `ci` の行の読み取りの述語を、走査の結合に押し込む。** 読めない CI は通らない（その先へも進まない）。結果の件数も読める CI だけ |
| 変更の評価（リスクの規則、承認者の決定。[itsm-processes.md](itsm-processes.md) の 8.3・9.4 節） | システム | 結果を `change_impact_snapshot` に写す。写しを見るときは、見る人の ACL で各行を絞る |
| メジャーインシデントの影響を受けるサービス | システム | 同上（インシデントの写し） |

- 画面の走査で読めない CI を通らないのは、読めない CI を通って届いた先を出すと、その間に読めない CI があることが分かるためである（件数も漏らさない。NFR-010）。そのため、同じ CI の影響の範囲が、見る人によって違う。
- 変更の評価はシステムの主体で全体を走査する。承認者（影響を受けるビジネスのサービスの持ち主）は、自分のサービスが影響を受けることを知らされるが、それはその人の持ち物の情報である。

## 9. サービスのモデル（[ADR-0039](../decisions/0039-ci-relations-impact-traversal-and-service-model.md)）

| クラス | 意味 | 主な関係 |
| --- | --- | --- |
| `business_service` | 業務の側から見たサービス（例：経費精算） | `contains` → `business_service_offering` |
| `business_service_offering` | 提供の単位（例：経費精算・本社向け）。SLA とカタログの品目の対象 | `depends_on` → `service_instance` |
| `business_application` | アプリの台帳の単位（例：経費精算システム）。構成ではなく持ち物の記録 | `contains` → `service_instance`（環境ごと） |
| `service_instance` | 動いているアプリの 1 つの実体（例：経費精算・本番）。CSDM 5 の「サービスのインスタンス」 | `depends_on` → `software_instance`、`ci_group`、`cloud_resource` |
| `technology_service` | IT の内部の提供（例：データベースの基盤） | `contains` → `technology_service_offering` |
| `technology_service_offering` | その提供の単位（例：PostgreSQL・本番・東京）。担当のグループを持つ | `depends_on` → `ci_group` など |

- タスクの参照：`task` の共通の列に `service_offering_id` を足す（`ci_id` は既存）。インシデントの報告のフォームでは、依頼者がサービスの提供を選び、担当者が CI を入れる。
- `business_service_offering` の `criticality` を、優先度のトリガー（メジャーインシデントの候補）と変更のリスクの規則の式で使う（[itsm-processes.md](itsm-processes.md) の 6.1・8.3 節）。
- 割り当ての規則は `service_offering.support_group` を式で使える（[assignment-and-on-call.md](assignment-and-on-call.md) の 3.1 節）。
- サービスのクラスは `manual` の取り込み元だけが作る（5.1 節）。サービスどうしの関係は手入力と、後のサービスマッピングで作る。
- CSDM の領域（構想と戦略、ポートフォリオの管理など）のクラスは MVP に入れない。名前と範囲は本システムのもので、CSDM の版の追従は目標にしない（ADR-0005）。

## 10. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 並行の取り込みの一意の違反 | 識別をやり直す（3 回まで）。超えたら `contention` のエラーで取り込み元が再送 |
| 取り込みの途中の停止 | 項目ごとのトランザクションなので、済んだ項目は残り、残りは再送で処理される。調整は冪等なので、済んだ項目の再送も結果を変えない |
| 取り込み元の時計の誤り（未来の時刻） | 5 分より未来の項目はエラー。過去に大きくずれた時刻の観測は、鮮度で自然に負ける |
| 取り込み元の停止 | CI は変わらない。90 日で廃止の候補のタスク（自動で廃止しない） |
| 識別の規則の誤り（弱すぎる） | 保留が増える。保留の件数の急な増加を知らせる（`cmdb-hold-surge.md`） |
| 識別の規則の誤り（強すぎる・値の誤り） | 重複の CI ができる。日次の重複の検出のジョブ（ADR-0005 の Confirmation）で見つけて保留のタスクにする |
| 走査の上限・時間切れ | `truncated` を返す。変更の評価では、リスクの規則で「影響の範囲の不明」を高リスクとして扱える |
| 動的なまとまりのジョブの停止 | 前のメンバーのまま。次の回で追いつく |

## 11. セキュリティ

- 入口の API は、取り込み元の連携の主体（`kind = integration`）のトークンで呼ぶ。トークンは取り込み元 1 つに結ぶ（別の取り込み元の名で送れない）。
- 取り込み元の優先度・データ源の規則・識別の規則の変更は `cmdb_admin` だけ。変更はメタデータの変更として監査に残る。
- CI の読み取りは ACL で絞る（例：セキュリティの機器は特定のグループだけ）。影響の範囲の画面は見る人の述語を押し込む（8.2 節）。
- 統合は人だけ、理由を必須にし、`ci_merge_log` に前の状態を残す。
- ペイロードの `sample_items`（保留の中の写し）は、CI と同じ ACL で読む。取り込み元の秘密の値（資格情報）はペイロードに入れない（属性の許可の一覧にない項目は捨てる）。
- テストに実在の機器のシリアル番号・MAC を使わない（[AGENTS.md](../../AGENTS.md)）。ジェネレーターは架空の値を作る。

## 12. テスト

### 12.1 決定表

- DT-CMDB-001（識別の結果）、DT-CMDB-002（値の選び方）、DT-CMDB-003（データ源の規則）、DT-CMDB-004（関係の検査）を、`spec.md` から読む表駆動テストにする。

### 12.2 性質ベーステスト（fast-check、DB は Testcontainers の PostgreSQL）

ジェネレーターは、架空の機器の集合（真の同一性を持つ）と、それを観測する取り込み元の列（値の欠け、正規化の揺れ：MAC の区切り・大文字小文字・BIOS の UUID のバイトの順、無効のシリアル番号、時刻の揺れ、同じ時刻）を作る。

- **PROP-CMDB-001（冪等）**：任意のペイロードの列を処理した後で、同じ列の任意の部分をもう一度処理しても、`ci`・`ci_identifier`・`ci_source_state`・`ci_relation` は変わらない。
- **PROP-CMDB-002（順序によらない）**：任意のペイロードの集合を、任意の順・任意の分け方（1 つにまとめる・分ける）で処理しても、属性の値と関係の有無は同じになる。条件：同じ真の機器を指すペイロードが、すべて少なくとも 1 つの共通の識別の値を持ち、別の機器と識別の値を共有しない入力（識別の結果が順によらず、保留に当たらない入力。保留は 004 で扱う）。取り込み元の時刻が同じで値の違う観測も含める（正準の順で決まる）。
- 識別そのものは、順によっては結果が変わりうる。例：同じ機器を、MAC だけのペイロードと、シリアル番号だけのペイロードが先に届くと 2 つの CI ができ、両方を持つペイロードが先に届くと 1 つになる（後者の順では、前者の 2 つのペイロードは既存の CI に一致する）。前者の順では、両方を持つペイロードは保留になり、人の統合で 1 つになる。統合の後の属性は、統合の演算（max の結合）で順によらない値になる（PROP-CMDB-005）。
- **PROP-CMDB-003（並行でも重複しない）**：同じ真の機器を指す任意のペイロードを、任意の並行度（1〜32）で同時に処理しても、その機器の識別の値のどれかを共有する CI は 1 つだけ。
- **PROP-CMDB-004（あいまいなら止まる）**：2 つの既存の CI に一致する識別の値を持つ任意のペイロードで、どちらの CI も変わらず（属性・識別の値・観測の状態）、同じ候補の集合の開いている保留はちょうど 1 つ（何回送っても）。
- **PROP-CMDB-005（統合の整合）**：任意の統合の後で、識別の値は一意、統合される側への関係と進行中のタスクの参照は 0 件、統合の先の属性は両方の観測の状態の結合から `choose` した値。
- **PROP-CMDB-006（走査）**：任意のグラフ（循環を含む）と開始の集合で、走査は止まり、結果は素朴な幅優先の探索の結果と、上限の中で一致する。見る人の述語を押し込んだ走査の結果は、読める CI だけの部分グラフの上の探索の結果と一致する。
- **PROP-CMDB-007（正規化）**：任意の値で `normalize(normalize(x)) = normalize(x)`。MAC の区切りと大文字小文字の揺れ、BIOS の UUID のバイトの順の揺れは、同じ識別の値の集合に写る。
- **PROP-CMDB-008（誤った統合をしない）**：真に別の機器（識別の値を共有しない）どうしは、どの順・並行度でも、同じ CI にならない。

### 12.3 負荷と本番の検査

- 負荷（E10・E12）：1 セルで 1 秒 1,000 CI の取り込み（NFR-005）。属性 20、取り込み元 3、既存の CI 500 万。
- 本番：日次の重複の検出（正規化の後に同じ値を持つ CI の組。ADR-0005）、`ci_identifier` と CI の属性の整合の抜き取り、保留の件数。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E10 | `ci-class-hierarchy` | 3 節、組み込みのクラスと属性、`multi` の属性 |
| E10 | `identification-rules-and-normalization` | 4 節（PROP-CMDB-007） |
| E10 | `ci-ingest-entry-point` | 5.2〜5.4 節、DT-CMDB-001・003（PROP-CMDB-001・003・008） |
| E10 | `ci-hold-and-duplicate-tasks` | 5.5 節（PROP-CMDB-004） |
| E10 | `ci-merge` | 5.6 節（PROP-CMDB-005） |
| E10 | `attribute-reconciliation` | 6.1〜6.3 節、DT-CMDB-002（PROP-CMDB-002） |
| E10 | `ci-staleness` | 6.4 節 |
| E10 | `ci-relations` | 7.1〜7.3 節、DT-CMDB-004 |
| E10 | `dynamic-ci-groups` | 7.4 節 |
| E10 | `impact-traversal` | 8 節（PROP-CMDB-006）と計測 |
| E10 | `service-model` | 9 節のクラスと画面 |
| E10 | `cmdb-csv-import` | CSV の取り込みの道具（入口のペイロードへの変換） |
| E10 | `cmdb-manual-edit-via-entry` | 画面の手入力を入口に通す |
| E10 | `duplicate-detection-job` | 12.3 節の日次の検出 |
| E7 | `change-impact-snapshot` | 変更の影響の写し（itsm-processes と一緒に） |
| E10 | `cmdb-ingest-api` | 取り込みの API の形と認証（api-and-integrations と一緒に） |
| E12 | `cmdb-ingest-load-test` | 12.3 節の負荷 |

## 14. 未解決の問い

### 決定（2026-09-28、既定案）

- **一致は、使えるすべての識別の項目の和集合で決める**（5.3 節、ADR-0037）。
- **取り込み元の固有のキーを最も優先の項目にする**（4.1 節、ADR-0036）。
- **複数の値の属性は値ごとに識別の値にする**（4.1 節）。
- **BIOS の UUID は 2 つのバイトの順の形を登録する**（4.2 節）。
- **クラスの違う一致でもクラスを変えない。子孫なら一致、それ以外は保留**（4.4 節）。
- **ペイロードの `observed_at` を必須にし、5 分より未来を拒む**（5.2 節）。
- **保留は候補の集合ごとに 1 つにまとめ、統合は人だけ**（5.5・5.6 節）。
- **調整は取り込み元ごとの状態の max の結合と、最新の観測からの鮮度で選ぶ**（6 節、ADR-0038）。
- **子のクラスの優先度の規則が親に勝つ**（6.2 節）。
- **自動で廃止・削除しない**（6.4 節）。
- **関係は取り込み元ごとの「ある・ない」の最新の状態で決め、行は消さない**（7.2 節）。
- **画面の走査は見る人の述語を押し込み、変更の評価はシステムの主体で走査して写しを残す**（8.2 節、ADR-0039）。
- **サービスのクラスは手入力だけが作る**（9 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| クラスの付け替え（`server` → `linux_server`）を許すか | E10 の利用者の調査で。許すなら、辞書の「クラスを変えない」（data-dictionary-and-tables の 3.4 節）の例外を ADR で決める |
| 部分の識別（`allow_partial`）と、項目の中の一部の値での照合 | E10 の後。取り込み元の実態を見て |
| 統合を戻す操作 | E10 の運用の後 |
| 深さ 6・節 10,000・2 秒の上限の値と、グラフの専用の置き場所への移行の基準 | E10 の計測（最大のテナントの規模） |
| 動的な調整（本家の、状況で取り込み元を選ぶ規則）に当たるもの | MVP の後。今の `choose` に規則を足す形で |
| ディスカバリーの取り込み元の優先度の既定 | ディスカバリーの Epic（MVP の後） |
| 本家の複数の一致のときの振る舞いと、子のクラスの調整の規則の意味 | 本家の公式の本文で確かめられたら 2 節を直す |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 重複の CI の件数（日次の検出。K4、NFR-005 の 0 件）。
- 保留の件数（理由別）と、処理までの時間。急な増加は識別の規則の誤りの兆し。
- 取り込みの速さ（1 セルの CI/秒）と、項目の結果の内訳（新規・一致・保留・エラー）。
- 一意の違反によるやり直しの回数と、`contention` のエラーの件数。
- 走査の `truncated` の割合と、走査の時間の p99。
- 廃止の候補の件数（取り込み元の停止の兆し）。
- 統合の件数と、統合の後の取り込みの保留（統合の誤りの兆し）。

### runbooks

- `cmdb-duplicate-detected.md`：日次の検出で重複が見つかったときの調べ方（識別の値、取り込みの履歴、正規化の漏れ）と統合の手順。
- `cmdb-hold-surge.md`：保留の急な増加の調べ方（取り込み元の設定の変更、無効の値の一覧の不足）。
- `cmdb-source-outage.md`：取り込み元の停止で廃止の候補が増えたときの確かめ方と、見直しのタスクの一括の取り消し。
- `cmdb-wrong-merge.md`：誤った統合の手での直し方（`ci_merge_log` からの戻し）。
- `impact-traversal-slow.md`：走査の遅れ・打ち切りの調べ方（関係の数の多い CI、索引の状態）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `ci`（列の追加） | 3.2 節。`operational_status`、`criticality`、`first_seen_at`、`last_seen_at`、`merged_into_id`、`provenance`（JSONB） |
| Aurora `ci_attribute`（`multi` の印を含む CI の属性の定義）、`ci_identification_rule` | 3.2・4.1 節。メタデータ |
| Aurora `ci_identifier` | 4.3 節。一意の制約が重複の防止の要 |
| Aurora `ci_identifier_exclusion` | 5.5 節の「別の機器」の除外の一覧 |
| Aurora `ci_source`、`ci_source_rule`、`ci_precedence` | 5.1・6.2 節 |
| Aurora `ci_source_state` | 6.1 節。`(tenant_id, ci_id, source_id)` |
| Aurora `ingest_batch`、`ingest_item`（結果、30 日） | 5.2・5.4 節。`(tenant_id, source_id, batch_key)` 一意 |
| Aurora `ci_hold`、`task`（クラス `ci_duplicate_task`） | 5.5 節 |
| Aurora `ci_merge_log` | 5.6 節 |
| Aurora `ci_relation_type`（組み込みは NULL の行）、`ci_relation`、`ci_relation_source_state` | 7 節 |
| Aurora `task`（列の追加） | `service_offering_id` |
| Aurora `change_impact_snapshot` | 8.2 節（itsm-processes と共有） |

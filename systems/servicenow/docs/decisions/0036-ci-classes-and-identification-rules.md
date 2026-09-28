---
status: accepted
date: 2026-09-28
---

# ADR-0036: CI のクラスは組み込みの階層にテナントが子を足す形で持ち、識別の規則は優先度付きの識別の項目の一覧にする。複数の値の属性は値ごとに、取り込み元の固有のキーは最も優先の項目にし、クラスの違う一致でもクラスを変えない

詳細は [cmdb-and-reconciliation.md](../architecture/cmdb-and-reconciliation.md) の 3・4 節。

## Context

[ADR-0005](0005-cmdb-identification-and-reconciliation.md) は、クラスごとに識別の規則（識別の項目を優先度の順に並べたもの）を持ち、子は親の規則を継承し、識別の値を正規化して一意の索引の表に持つと決めた。細部（クラスの階層、複数の値の属性、取り込み元の固有のキー、クラスの違う一致）は、この領域に残した。

本家は、取り込み元の名前と固有のキーでの識別を速い道にし、属性の組での照合を遅い道にする。依存の CI は、親を先に識別する（[Identification and Reconciliation engine (IRE)](https://www.servicenow.com/docs/r/servicenow-platform/configuration-management-database-cmdb/ire.html)、2026-09-28 に確認）。ネットワークのアダプターの表のような、関係の表の上の識別の項目を持てる（二次の資料。公式の本文は未検証。本システムは同じ形を自分で設計しており、本家の細部は前提にしない）。

[data-dictionary-and-tables.md](../architecture/data-dictionary-and-tables.md) の 3.4 節は、レコードのクラスを作成の後に変えないと決めた。

## Options

### 複数の値の属性（MAC、IP）

1. **CI の属性に配列を許し、値ごとに識別の値にする**
2. 本家に近く、ネットワークのアダプターなどの別の表を作り、その上に識別の項目を置く

### 取り込み元の固有のキー

- a. **すべてのクラスで最も優先の暗黙の項目にする**
- b. 使わない（属性だけで識別する）

### クラスの違う一致

- x. **クラスを変えない。子孫なら一致（余る属性を捨てる）、それ以外は保留**
- y. ペイロードのクラスへ付け替える

## Decision

1、a、x を採用する。

- 組み込みのクラス：`hardware`（`computer` → `server` → `linux_server`・`windows_server`、`end_user_device`、`network_device`、`storage_device`）、`virtual_machine`、`cloud_resource`、`software_instance`、`business_application`、`service`（CSDM に寄せた子。ADR-0039）、`ci_group`。テナントは子を足せる。
- 規則は `independent` / `dependent`、`entries`（優先度、属性の組）。子は最も近い祖先の規則を使う。値の揃わない項目は使わない。
- 正規化は属性の種類ごとの純粋な関数で、無効の値の一覧（組み込み ＋ テナント）を持つ。BIOS の UUID は 2 つのバイトの順の形を登録する。
- `ci_identifier(tenant_id, rule_class_id, entry_id, value_hash, ci_id)` に一意の制約。規則を持つクラスの ID で揃え、親の規則を継承する子どうしを同じ一意の空間に置く。依存の CI は親の ID を値に含める。
- 取り込み元の固有のキーは `entry_id = native`。
- クラスの違う一致は、子孫なら一致（`class_mismatch` の警告）、それ以外は保留 `class_conflict`。クラスの付け替えは持ち越す。

2 を採らない理由：MVP の取り込み元（API、CSV、資産管理）は、MAC を CI の属性の一覧として送るのがふつうで、アダプターの表の識別と管理を加えるほどの利点がない。後のディスカバリーでアダプターの表が要れば、別の ADR で足す。

b を採らない理由：取り込み元が自分の ID を持つのに、毎回属性で照合すると、属性の変わる CI（ホスト名の変更）で一致を失う。

y を採らない理由：辞書の「クラスを変えない」（data-dictionary-and-tables の 3.4 節）に反する。別の枝への付け替えは、誤った識別のときに CI を壊す。

## Consequences

- 良くなること：
  - 同じ機器の取り込み元の違い（MAC の書き方、BIOS の UUID のバイトの順）を正規化で吸収できる。
  - 取り込み元の 2 回目からの識別が速く、属性の変更に強い。
- 引き受けるコスト：
  - CI の属性だけに配列（`multi`）を許す例外を持つ。
  - `server` として作った CI を `linux_server` にできない。取り込み元のクラスを揃える案内が要る。

## Confirmation

- 決定表 DT-CMDB-001。
- 性質ベーステスト PROP-CMDB-007（正規化の冪等と揺れの吸収）。
- lint：識別の値の表への書き込みが、入口のモジュールの外にないこと。

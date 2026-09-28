---
status: accepted
date: 2026-09-28
---

# ADR-0002: レコードを共有の records の表（システムの列＋JSONB）に入れ、型付きのピボットの表で引く

## Context

組織の管理者は、画面の操作でオブジェクトと項目を足し、名前を変え、型を変え、消す。変更は数秒で反映され、他の組織に影響してはならない（[intent.md](../intent.md) の K2）。S1 で 5,000、S3 で 50 万の組織があり、1 組織は標準とカスタムで数十のオブジェクトを持つ。Sandbox も別の組織として数える。

本家は、オブジェクトと項目を DB の構造ではなくメタデータとして持つ。全組織のレコードを 1 つの大きな表（MT_Data）に入れ、項目の値は、型を持たない文字列の「flex 列」（Value0〜ValueN）に入れる。1 つの flex 列は、組織やオブジェクトによって別の項目に使われ、型も違う。そのため flex 列には DB の索引を張れない。索引の要る項目は、型付きの列（StringValue、NumValue、DateValue）を持つピボットの表（MT_Indexes）へ同じトランザクションで写して引く。一意の制約、関係、名前も別のピボットの表で持つ。全ての表は組織の ID で物理的に分割されている（[Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)、2026-09-28 に確認）。flex 列の数は、今の公式の資料に書かれていない。本システムの設計はこの数に依らない。

本システムは PostgreSQL（Aurora PostgreSQL 18）の上に作る（[ADR-0001](0001-platform-and-stack.md)）。PostgreSQL には本家の DB にない JSONB と部分索引がある。一方で、表の数が多いときの負担は大きい。

## Options

1. **本家に倣った、ユニバーサルな広い表。** records に文字列の flex 列を数百持ち、項目を列の番号に割り当てる。索引・一意・関係はピボットの表で持つ
2. **組織のオブジェクトごとに、PostgreSQL の実テーブルを作る。** 項目の追加は `ALTER TABLE ADD COLUMN`、索引は `CREATE INDEX`
3. **共有の records の表に JSONB の本体を持ち、式の索引で引く。** 項目の索引は、`(data->>'<項目>')` の式の部分索引を組織・オブジェクトごとに作る
4. **共有の records の表に JSONB の本体を持ち、型付きのピボットの表で引く。** 3 と同じ本体に、1 の索引の考え方を組み合わせる

### 比べた観点

| 観点 | 1. 広い表 | 2. 実テーブル | 3. JSONB＋式の索引 | 4. JSONB＋ピボット |
| --- | --- | --- | --- | --- |
| 項目の追加・名前の変更 | メタデータだけ | DDL（`ADD COLUMN` は速いが、表のロックを取る） | メタデータだけ | メタデータだけ |
| 規模での DDL | なし | S1 で数十万、S3 で数千万の表。カタログと接続ごとの関係のキャッシュが膨らみ、自動 VACUUM とダンプとマイグレーションが重い | 索引の数だけ DDL。1 つの表に数万の部分索引が付き、書き込みのたびに述語を評価する | なし（索引の表は全組織で共通） |
| 型の扱い | 全て文字列。比べる時に毎回変換 | DB の型そのまま | JSON の型（文字列・数・真偽）。日付は文字列 | 本体は JSON の型、索引は型付きの列 |
| RLS | 表が少なく、方針は数個 | 表ごとに方針が要る | 表が少ない | 表が少ない |
| 索引 | ピボットの表 | 組織ごとに自由に張れる。いちばん速い | 張れるが、数が増えると表全体が遅くなる | ピボットの表。条件によっては結合が要る |
| 1 件の読み | 1 行 | 1 行 | 1 行 | 1 行 |
| 1 件の書き | 1 行＋索引の行 | 1 行 | 1 行 | 1 行＋索引の行 |
| 集計（レポート） | 文字列から変換して集計 | 速い | JSONB から取り出して変換 | JSONB から取り出して変換 |

## Decision

4 を採用する。

### 表の形

- **`records`**：全組織・全オブジェクト（標準・カスタム）のレコード。
  - システムの列は実際の列にする：`org_id`、`id`（UUIDv7）、`object_id`、`record_type_id`、`owner_id`、`name`、`created_at`・`created_by`、`updated_at`・`updated_by`、`deleted_at`（ごみ箱）、`row_version`。
  - `owner_id` を実際の列にするのは、共有の判定（[ADR-0004](0004-record-access-model.md)）で毎回使うため。
  - 項目の値は `data`（JSONB）に、**項目の ID をキーにして**入れる。API の名前をキーにしない。名前の変更がメタデータだけで済む。
    > 2026-09-28 の注記：キーは、項目の ID ではなく、オブジェクトの中で再利用しない短い番号 `field_no` にした（[ADR-0006](0006-data-dictionary-and-field-lifecycle.md)）。ピボットの表も `field_no` で引く（[ADR-0010](0010-record-tables-partitioning-and-pivots.md)）。名前の変更をメタデータだけで済ませる意図は同じ。システムの列には、主従の 1 本目の親と活動の主の親を指す `parent_id` を足した（[ADR-0021](0021-lead-conversion-and-activity-parents.md)、[data-storage.md](../architecture/data-storage.md) の 3.1 節）。
  - 日付・日時は ISO 8601 の文字列、通貨と小数は文字列の十進数で入れる。浮動小数で丸めない。
- **`record_index_values`**：索引の指定のある項目と、外部 ID の項目の値。`(org_id, object_id, field_id, v_text | v_num | v_ts, record_id)` で、型ごとに B-tree を張る。テキストの「含む」は trigram の索引。
- **`record_unique_values`**：一意の項目。`(org_id, object_id, field_id, 正規化した値)` に一意の索引を張り、DB で一意を強制する。
- **`record_relationships`**：参照・主従の項目。`(org_id, field_id, parent_id, child_id)` と逆向きの索引で、関連リストと親のたどりを速くする。
- **`record_long_texts`**：ロングテキストとリッチテキスト。本体と分けて持ち、短い項目の更新で長い値を書き直さない（PostgreSQL は、変わった JSONB の値を TOAST ごと書き直すため）。
- ピボットの表は、`records` の変更と**同じトランザクション**で書く。書いた直後の問い合わせに、その変更が出る。
- 全ての表の主キーと索引の先頭に `org_id` を置き、RLS をかける（[ADR-0005](0005-tenancy-and-governor-limits.md)）。
- 項目の削除は、メタデータを消した印にするだけにし、値は削除の確定まで残す。確定の後に Worker が値を消す。本家も、消した項目とレコードを一定の期間は復元できる（[Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)）。
- 項目の型の変換（テキストから数値など）は、変換できない値を先に数えて利用者に見せ、承認の後に Worker が行ごとに書き換える。変換の間は、両方の型で読める。

### 選ばなかった理由

- **1（広い表）**：PostgreSQL では、全て文字列にする利点がない。JSONB なら型が残り、列の番号の割り当ての管理も要らない。本家がこの形なのは、その DB に合わせた選択と考える（本家は理由を公開していない。推測）。
- **2（実テーブル）**：組織ごとの索引が自由に張れる点は最も優れる。ただし、S1 で数十万、S3 で数千万の表になり、PostgreSQL のカタログ・接続ごとのキャッシュ・自動 VACUUM・マイグレーションの負担が、組織の数に比例して増える。DDL は表のロックを取り、多くの組織が同時に項目を変えると、ロックの待ちが他の組織に広がる。Sandbox を作るたびに表を作ることにもなる。
- **3（式の部分索引）**：部分索引は 1 つの共有の表に付くので、数万になると、全ての書き込みが全ての索引の述語を評価し、計画も遅くなる。索引の作成も DDL で、2 と同じ問題が出る。

### 後の拡張

- 大口の組織の、よく使うオブジェクトの読みが遅い時は、S2 以降で**射影の表**（組織・オブジェクトの専用の実テーブルに、よく使う項目を型付きで写したもの）を検討する。正本は records のままにし、射影は作り直せる写しにする。本家の skinny table も、同じく読みのための写しである（[Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)、2026-09-28 に確認）。この判断は data-storage の領域の ADR で行う。

## Consequences

- 良くなること：
  - 項目とオブジェクトの追加・名前の変更・削除が、メタデータの変更だけで済み、DDL がない。
  - 表の数が組織の数に依らず一定で、RLS・マイグレーション・運用が単純になる。
  - Sandbox の作成が、行の複製だけで済む。
- 引き受けるコスト：
  - 書き込みの増幅：1 件の保存で、索引・一意・関係の項目の数だけピボットの行を書く。索引を張れる項目の数に上限を置く（metadata-and-runtime の領域）。
  - ピボットの表は正本の写しなので、ずれを検出して作り直す整合の検査のジョブを運用する。
  - 集計は JSONB から値を取り出して変換するので、実テーブルより遅い。レポートは reader で受け、S2 で分析用の写しを検討する。
  - 問い合わせの計画を、PostgreSQL の統計だけに任せられない。組織・オブジェクト・項目ごとの値の分布を自前で持ち、ピボットの表を使うかを選ぶ（query-language-and-api の領域）。
  - 1 行の JSONB が大きいと、更新のたびの書き直しが重い。項目の数の上限と、長い値の別の表で抑える。

## Confirmation

- 性質ベーステスト：任意のスキーマ・レコード・操作の列で、ピボットの表を使った問い合わせの結果が、`records` の全行を参照の評価器で判定した結果と一致する。
- 性質ベーステスト：任意の項目の追加・名前の変更・削除・復元の列の後で、レコードの値が失われない（削除の確定の前）。
- 整合の検査：本番で、`records` とピボットの表の差分を定期的に数え、0 を保つ。
- CI：メタデータの変更の経路に DDL が含まれないことを検査する（マイグレーションの外での `CREATE TABLE`・`ALTER TABLE`・`CREATE INDEX` を禁止する lint）。
- 性能テスト（E3）：1 オブジェクト 5,000 万件の組織で、索引の項目の等価の条件の問い合わせが p95 100ms 以内。

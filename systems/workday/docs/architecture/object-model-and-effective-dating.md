# Object model and effective dating: Workday

人事のデータを有効時間と記録時間の 2 軸（bitemporal）で持つための、共通の型とテーブルの形、差分の畳み込み、変更・訂正・取消の意味、時点の問い合わせ、発効のタイマー、性質ベーステストを決める。実装は `packages/temporal` にまとめる。

前提の決定は、人事のデータを 2 軸で持ち、差分を有効日の順に畳み込むこと（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）、変更は業務プロセスを通すこと（[ADR-0003](../decisions/0003-business-process-engine.md)）、給与は `known_at` を固定した入力のスナップショットから計算すること（[ADR-0004](../decisions/0004-payroll-engine.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-temporal-table-triplet-and-fold.md) | facet ごとに差分・版・現在の 3 つのテーブルを、宣言から生成する。現在のテーブルは `WITHOUT OVERLAPS` の主キーと `PERIOD` の外部キーで守る。書き込みは DB の関数だけが行う。同じ日の差分の順序は、事象の種類の優先度（`seq`）で決め、同じ `seq` で同じ項目に触れる差分は拒む |
| [0007](../decisions/0007-change-correction-rescind-semantics.md) | 変更・訂正・取消を差分の種類で区別する。訂正は元の差分を取消の印で退け、新しい差分を足す。取消は、依存する後の差分があれば拒む。依存は決定表（DT-TEMP-004）で判定する |
| [0008](../decisions/0008-point-in-time-queries-and-activation-timers.md) | 時点の問い合わせは `effective_on` と `known_at` を受け、`known_at` は「安定の境界」（今 − 10 秒）より前に限る。将来日付の副作用は、差分と同じトランザクションで発効の予定を書き、テナントの暦の 0 時に BP Worker が実行する |
| [0009](../decisions/0009-temporal-reference-model-testing.md) | 純粋な参照のモデル（メモリーの中の畳み込み）を正解として、DB の実装を fast-check のモデルベーステストで比べる。本番では夜間に同じ参照のモデルで抜き取りの検査をする |

## 1. 目的と範囲

- 扱う：有効日付の共通の型、facet の宣言、3 つのテーブルの形と DB の制約、差分の畳み込み、隙間の扱い、変更・訂正・取消の意味と依存の判定、遡及の検知の事象、時点の問い合わせの API、発効のタイマー、性質ベーステストと本番の整合の検査。
- 扱わない：どの項目をどの facet にまとめるか（[core-hr.md](core-hr.md)）、業務プロセスの状態機械（[business-process-engine.md](business-process-engine.md)）、権限（[security-model.md](security-model.md)）、遡及の差額の計算（[payroll-engine.md](payroll-engine.md)）、監査ログの保管と改ざんの検知（[audit-and-retention.md](audit-and-retention.md)）。
- **有効日付のテーブルに書くのは `packages/temporal` と、その下の DB の関数だけ**（[AGENTS.md](../../AGENTS.md)）。業務プロセスの完了のステップが、この API を呼ぶ。

## 2. 本家の形（確かめたこと）

本家の振る舞いは考え方として参考にする。実装は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。どれも 2026-09-28 に確認した。

| 本家の考え方 | 内容 | このシステムでの扱い |
| --- | --- | --- |
| 有効の時点と入力の時点 | 変更には、業務の上で有効になる時点（Effective Moment）と、システムに入力した時点（Entry Moment）がある。有効の時点を持たない変更もある。同じ有効日に複数の変更があれば、入力の時点で最後のものを取る（[Change Detection](https://doc.workday.com/workday-education/en-us/course-manuals/creating-integrations-using-global-payroll-connect/change-detection.html)） | 有効時間は日単位の `daterange`。記録時間は `recorded_at` と `superseded_at`。同じ日の順序は入力の順ではなく、事象の種類の `seq` で決める（5.2 節） |
| 将来日付の発効 | 将来日付の変更は、指定したタイムゾーンの、その日の 0 時に効く（[Concept: Effective Dates](https://doc.workday.com/admin-guide/en-us/manage-workday/business-processes/business-process-framework-concepts/dan1370796344630.html)） | 見え方は問い合わせの日付で自然に変わる。副作用だけを、テナントの暦の 0 時に発効のタイマーで行う（8 節） |
| 監査 | 前後の値、変更者、時刻を記録する（[Concept: Auditing](https://doc.workday.com/admin-guide/en-us/manage-workday/tenant-configuration/auditing/dan1370797846272.html)） | 差分のテーブルが監査の正本の 1 つになる。前後の値は版から出す |
| 保存 | 少数の汎用のテーブルに追記し、メモリーの中のグラフで読む（[ホワイトペーパー](https://www.workday.com/content/dam/web/en-us/documents/whitepapers/whitepaper_workday_technology_platform_devt_process.pdf)。汎用のテーブルの詳細は古い第三者の記事で未検証） | 採らない。型のある facet のテーブルと DB の制約にする（[ADR-0002](../decisions/0002-effective-dated-data-model.md)） |

- 本家で、将来日付の変更の後に、それより前の日付の変更が入ったとき、将来日付の変更の項目をどう扱うかは、公開の資料で確かめられなかった（未検証）。本システムは差分の畳み込みで決める（5 節）。

## 3. 共通の型（`packages/temporal`）

```ts
// Calendar date in the tenant calendar. "YYYY-MM-DD". Never a JS Date.
type CivilDate = string & { readonly __brand: "CivilDate" };

// Half-open [start, end). end = null means unbounded.
type Validity = { start: CivilDate; end: CivilDate | null };

// Transaction time. Microsecond precision, taken from the DB clock.
type KnownAt = string & { readonly __brand: "KnownAt" };

type ChangeKind = "change" | "correction" | "end";

interface Delta<F> {
  set: Partial<F>;             // fields to set
  unset: (keyof F)[];          // fields to clear (nullable fields only)
}

interface FacetSpec<F> {
  name: string;                // e.g. "worker_job"
  subject: "worker" | "employment" | "job_assignment" | "position" | "organization" | "role_assignment";
  fields: z.ZodType<F>;        // full-state schema, validated after each fold step
  gapPolicy: "contiguous" | "gapped";
  coverage?: { facet: string; mode: "within" };   // e.g. worker_job within employment
  seqTable: Record<EventType, number>;             // same-day ordering (5.2)
  dependencyRules: DependencyRule[];               // DT-TEMP-004 inputs
}
```

- 日付は、テナントの暦の日付（S1 は `Asia/Tokyo`）で扱う。`Date` の型を有効日に使わない。境界の変換は `packages/temporal` の関数だけで行う。
- 有効時間は半開区間 `[start, end)`。人事の「退職日」（最後の在籍日）が 3 月 31 日なら、雇用の `end` は 4 月 1 日になる。この変換は [core-hr.md](core-hr.md) の 5 節の関数だけが行う。
- 空の範囲は持たない。PostgreSQL も `WITHOUT OVERLAPS` の列に空の範囲を許さない（[CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html)、2026-09-28 に確認）。

### 3.1 上限と既定値

| 項目 | 値 | 理由 |
| --- | --- | --- |
| 有効日の下限 | 1900-01-01 | 移行の履歴（入社日、生年月日の由来の日付）を受ける |
| 将来日付の上限 | 今日＋3 年 | 誤入力（年の打ち間違い）を拒む。発効の予定の表を小さく保つ |
| 1 つの差分の項目の数 | facet の項目の数まで | 差分は facet を越えない |
| 1 つの業務プロセスの案件が書く差分 | 200 件まで | 一括の変更は親子の案件に分ける（[business-process-engine.md](business-process-engine.md) の 9 節） |
| 1 つの主体・facet の差分の件数 | 警告 2,000 件、拒否 10,000 件 | 畳み込みの時間を抑える。超えたら運用で確かめる |
| 遡及の警告の窓 | 確定した給与の期間にかかるすべて | 給与の遡及の候補（[payroll-engine.md](payroll-engine.md)） |
| 過去日付の変更の上限（業務プロセスの権限なし） | 90 日前まで | それより前は `retro_override` の権限を要する（[security-model.md](security-model.md) の 4.3 節） |

## 4. テーブルの形（[ADR-0006](../decisions/0006-temporal-table-triplet-and-fold.md)）

facet ごとに 3 つのテーブルを持つ。マイグレーションは facet の宣言（`FacetSpec`）から生成し、手で書かない。例は `worker_job`。

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- uuid columns in GiST (temporal PK/FK)

-- 1. Changes (deltas). Append-only except the rescind marker.
CREATE TABLE worker_job_changes (
  tenant_id            uuid        NOT NULL,
  id                   uuid        NOT NULL,          -- UUIDv7
  subject_id           uuid        NOT NULL,          -- job_assignment_id for worker_job
  effective_on         date        NOT NULL,
  seq                  smallint    NOT NULL,          -- from FacetSpec.seqTable
  kind                 text        NOT NULL CHECK (kind IN ('change','correction','end')),
  event_type           text        NOT NULL,          -- e.g. hire, job_change, terminate
  delta                jsonb       NOT NULL,          -- {set:{...}, unset:[...]}, Zod-validated
  fields               text[]      NOT NULL,          -- touched fields (for DT-TEMP-001/004)
  case_id              uuid        NOT NULL,          -- BP case (ADR-0003)
  based_on_version_ids uuid[]      NOT NULL,          -- versions the initiator saw
  corrects_change_id   uuid,                          -- for kind = correction
  recorded_at          timestamptz NOT NULL,
  recorded_by          uuid        NOT NULL,
  rescinded_at         timestamptz,
  rescinded_by_case_id uuid,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON worker_job_changes (tenant_id, subject_id, effective_on, seq);

-- 2. Versions (folded periods, with transaction time). Append-only except superseded_*.
CREATE TABLE worker_job_versions (
  tenant_id       uuid        NOT NULL,
  id              uuid        NOT NULL,
  subject_id      uuid        NOT NULL,
  valid           daterange   NOT NULL CHECK (NOT isempty(valid)),
  state           jsonb       NOT NULL,    -- full folded state (typed columns below for FK/query)
  position_id     uuid, job_profile_id uuid, org_id uuid, grade text, ...,
  source_change_ids uuid[]    NOT NULL,    -- deltas that produced this state
  recorded_at     timestamptz NOT NULL,
  superseded_at   timestamptz,
  superseded_by_case_id uuid,
  known           tstzrange GENERATED ALWAYS AS (tstzrange(recorded_at, superseded_at)) STORED,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX ON worker_job_versions USING gist (tenant_id, subject_id, valid, known);

-- 3. Current knowledge. Rows = versions whose superseded_at IS NULL.
CREATE TABLE worker_job (
  tenant_id    uuid      NOT NULL,
  subject_id   uuid      NOT NULL,          -- job_assignment_id
  employment_id uuid     NOT NULL,          -- fixed per job assignment; used for coverage
  valid        daterange NOT NULL,
  version_id   uuid      NOT NULL,
  position_id  uuid, job_profile_id uuid, org_id uuid, grade text, ...,
  PRIMARY KEY (tenant_id, subject_id, valid WITHOUT OVERLAPS),
  FOREIGN KEY (tenant_id, employment_id, PERIOD valid)
    REFERENCES employment_status (tenant_id, subject_id, PERIOD valid),
  FOREIGN KEY (tenant_id, org_id, PERIOD valid)
    REFERENCES organization (tenant_id, subject_id, PERIOD valid),
  FOREIGN KEY (tenant_id, position_id, PERIOD valid)
    REFERENCES position_detail (tenant_id, subject_id, PERIOD valid)
);
```

- **`WITHOUT OVERLAPS`**：主体ごとに有効期間が重ならないことを DB が守る。`WITHOUT OVERLAPS` の列は範囲型で、他の列を GiST に載せるには `btree_gist` が要る（[CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html)、[btree_gist](https://www.postgresql.org/docs/18/btree-gist.html)、2026-09-28 に確認）。Aurora PostgreSQL は 18.3 から 18 系を提供し（[AWS の発表](https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-aurora-postgresql-major-version-18/)、2026-06-11）、`btree_gist` は対応する拡張の一覧にある（[Extensions supported for Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)）。どちらも 2026-09-28 に確認。E1 の PoC で、実際の Aurora の版で時間の制約を作れることを確かめる。
- **`PERIOD` の外部キー**：参照する側の期間の全体が、参照先の期間の和で覆われていることを守る。参照の動作は `NO ACTION` だけが使える（`CASCADE` などは時間の外部キーで使えない。[CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html)、2026-09-28 に確認）。このため、組織を閉じる前に所属を移す、という順序を業務プロセスの側で守る（[core-hr.md](core-hr.md) の 4.4 節）。
- **coverage**：`worker_job` は雇用（`employment_status`）の期間の中にだけある（`coverage: within`）。これを `PERIOD` の外部キーで表す。
- **版の `state`**：畳み込んだ状態の全体を `jsonb` で持ち、外部キーと検索に使う列だけを型のある列にも持つ。時点の問い合わせは `state` を Zod で読み直す。
- **追記のみ**：差分と版のテーブルに、アプリのロールは `INSERT` と `SELECT` だけを持つ。`rescinded_*` と `superseded_*` を空から埋める更新は、`temporal_owner` が持つ関数だけが行い、トリガーで他の列の更新と、埋めた後の更新を拒む。
- **現在のテーブル**は、版から作る写し。行の削除と追加は `temporal_owner` の関数（`temporal.apply_fold`）だけが行う。アプリのロールは `EXECUTE` だけを持つ。
- **テナント**：3 つのテーブルとも `tenant_id` を先頭に持ち、RLS を掛ける（[ADR-0005](../decisions/0005-security-and-my-number.md)）。関数の中でも、呼び出し元の `app.tenant_id` で RLS が効くことを守る。
  - 注：書き込みを関数だけに限る方法は 2 つある。(a) `SECURITY DEFINER` の関数にする。関数の所有者のロールで動くので、所有者にも `FORCE ROW LEVEL SECURITY` の対象になる設定が要る。(b) 書き込みの専用のロールをアプリの接続で `SET LOCAL ROLE` し、そのロールにだけ表の書き込みを許す。どちらにするかは E1 の `temporal-constraints-poc` で RLS のテストと合わせて決める（持ち越し）。

### 4.1 facet の一覧（初期）

facet の中身は [core-hr.md](core-hr.md) の 3 節で決める。この領域は、共通の性質だけを決める。

| facet | 主体 | 隙間 | coverage | 備考 |
| --- | --- | --- | --- | --- |
| `employment_status` | 雇用 | gapped | — | 在籍・休職の区分。退職で `end` |
| `worker_job` | 職務の割り当て | contiguous | `employment_status` | ポジション、職務、組織、等級、勤務地。主たる職務と兼務で主体を分ける |
| `employment_primary_job` | 雇用 | contiguous | `employment_status` | その日の主たる職務の割り当ての ID（雇用ごとに 1 つ） |
| `worker_compensation` | 雇用 | contiguous | `employment_status` | 基本給、手当 |
| `worker_personal` | 人 | contiguous | — | 氏名、性別、生年月日（訂正のみ） |
| `worker_address` | 人 | gapped | — | 住所の種類ごとに主体を分ける |
| `worker_payment_election` | 雇用 | gapped | `employment_status` | 振込先（口座の値は暗号化。[security-model.md](security-model.md)） |
| `worker_dependents` | 人 | gapped | — | 扶養の親族ごとに主体を分ける |
| `organization` | 組織 | gapped | — | 名前、種類、上位（[core-hr.md](core-hr.md) の 4 節） |
| `position_detail` | ポジション | gapped | `organization` | 所属組織、職務、状態 |
| `org_role_assignment` | 組織×ロール | gapped | `organization` | 上長・人事の担当の割り当て（[security-model.md](security-model.md)） |

## 5. 差分の畳み込み

### 5.1 手順

主体・facet ごとに、次を 1 つのトランザクションで行う（[ADR-0006](../decisions/0006-temporal-table-triplet-and-fold.md)）。

1. 主体の行（`<subject>` の親のテーブルの行）を `SELECT ... FOR UPDATE` でロックする。同じ主体の畳み込みを直列にする。
2. 新しい差分を検査する（DT-TEMP-001、DT-TEMP-003）。
3. 差分を追記する。取消なら `rescinded_at` を埋める。
4. 影響の始まりの日 `D` を決める。`D` = 新しい差分の `effective_on`、取消した差分の `effective_on`、訂正で動いた有効日のうち最も早い日。
5. 取消されていない差分を `(effective_on, seq)` の順に並べ、`D` より前の最後の状態から始めて、`D` 以降の期間を作り直す。
6. 各段で、状態の全体を `FacetSpec.fields` で検証する。失敗したら全体を戻す（例：必須の項目が `unset` された）。
7. 隣り合う同じ状態の期間をまとめる（coalesce）。
8. 作り直した期間と、現在のテーブルの `D` 以降の期間を比べる。違う期間だけ、古い版に `superseded_at` を書き、新しい版を追記し、現在のテーブルの行を差し替える。`D` をまたぐ期間は `D` で分ける。
9. outbox に `temporal.changed`（主体、facet、影響の範囲 `[D, ∞)`、`case_id`）を書く。影響の範囲が今日以前なら `temporal.retro_detected` も書く（6.4 節）。
10. 発効の予定を書き直す（8 節）。

```ts
// Pure fold. Used by the DB write path AND the reference model (ADR-0009).
function fold<F>(spec: FacetSpec<F>, deltas: ChangeRow[]): Period<F>[] {
  const live = deltas.filter(d => d.rescindedAt === null)
                     .sort(byEffectiveOnThenSeq);          // no tie by recorded_at (5.2)
  const out: Period<F>[] = [];
  let state: F | null = null;
  for (const [day, group] of groupBy(live, d => d.effectiveOn)) {
    for (const d of group) state = applyDelta(spec, state, d);   // kind=end -> null
    if (state !== null) spec.fields.parse(state);                 // throws -> rollback
    out.push({ start: day, state });
  }
  return coalesce(closeEnds(out)).filter(p => p.state !== null);
}
```

### 5.2 同じ日の順序（DT-TEMP-001）

同じ主体・facet・有効日に複数の差分がありうる（例：入社の日に、等級の訂正と住所の変更）。入力の順に依存すると、並行する案件の完了の順で結果が変わる。本システムは、事象の種類の優先度（`seq`）で順序を決め、同じ `seq` で同じ項目に触れるものは拒む（[ADR-0006](../decisions/0006-temporal-table-triplet-and-fold.md)）。

| # | 同じ日に既存の差分がある | 同じ `seq` | 触れる項目が重なる | 新しい差分が訂正 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | いいえ | - | - | - | 受ける |
| 2 | はい | - | - | はい | 受ける（訂正は元の差分を退ける。6.2 節） |
| 3 | はい | いいえ | - | いいえ | 受ける。`seq` の順に適用する |
| 4 | はい | はい | いいえ | いいえ | 受ける。項目が重ならないので、順序によらず同じ結果 |
| 5 | はい | はい | はい | いいえ | 拒む（`SAME_DAY_CONFLICT`）。訂正として出し直すよう示す |

`seq` の既定の表（小さいほど先）：

| 事象の種類 | `seq` |
| --- | --- |
| `hire`・`rehire`・`org_create`・`position_create` | 100 |
| `data_correction`（訂正の差分） | 元の差分と同じ |
| `job_change`・`transfer`・`promotion`・`demotion` | 300 |
| `compensation_change` | 400 |
| `leave_start`・`leave_return` | 500 |
| `personal_change`（住所、口座、扶養） | 600 |
| `terminate`・`org_inactivate`・`position_close` | 900 |

- 例：同じ日に入社と退職（日雇いの誤入力など）は、入社が先に効き、退職で `end` になる。期間は空になり、現在のテーブルに行が残らない。これは雇用の facet では拒む（DT-TEMP-002 の #4）。

### 5.3 隙間と終わり（DT-TEMP-002）

| # | facet の隙間 | 差分 | 前の状態 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | - | `change` | なし（最初の差分） | 状態を作る。`set` が必須の項目を満たさなければ拒む |
| 2 | - | `change` | あり | `set` を上書き、`unset` を消す |
| 3 | gapped | `end` | あり | 状態を無くす（期間を閉じる）。後の `change` でまた始まる |
| 4 | gapped | `end` | あり、同じ日に始まった | 拒む（`EMPTY_PERIOD`）。取消を使う |
| 5 | contiguous | `end` | - | 拒む（`END_NOT_ALLOWED`）。coverage の親の `end` で自然に閉じる |
| 6 | contiguous | 親の期間が閉じた | あり | 期間を親の終わりで切る（`coverage` の畳み込み。同じトランザクションで子の facet も畳み込み直す） |
| 7 | - | `end` | なし | 拒む（`NOTHING_TO_END`） |
| 8 | contiguous | 親が再開した（再雇用） | 前の状態は閉じている | 最初の差分として扱う（#1）。前の雇用の状態を引き継がない |

- coverage の親子（雇用と職務など）は、親を先に、子を後に、同じトランザクションで畳み込む。子が親の外に出る差分は `PERIOD` の外部キーで失敗する。先にアプリで検査し、`OUTSIDE_COVERAGE` の分かる誤りを返す。

## 6. 変更・訂正・取消（[ADR-0007](../decisions/0007-change-correction-rescind-semantics.md)）

### 6.1 意味

| 操作 | 差分の書き方 | 意味 | 過去の知識 | 業務プロセス |
| --- | --- | --- | --- | --- |
| 変更（将来日付） | `kind = change`、`effective_on > 今日` | その日から変わる | 変わらない | 種類ごとの業務プロセス |
| 変更（過去日付） | `kind = change`、`effective_on ≤ 今日` | その日から変わっていた | 変わらない | 同上。90 日より前は `retro_override` の権限 |
| 訂正 | `kind = correction`、`corrects_change_id` | 元の差分がもともと誤っていた | 変わらない | 元の案件の `correct`（[business-process-engine.md](business-process-engine.md) の 8 節） |
| 取消 | 元の差分に `rescinded_at` | 元の変更は無かった | 変わらない | 元の案件の `rescind` |
| 終わり | `kind = end` | その日から無くなる（gapped の facet だけ） | 変わらない | 退職、組織の廃止など |

- 「過去の知識が変わらない」は、どの操作も、`superseded_at` を埋めるのと追記だけで行うことで守る。PROP-TEMP-003 で確かめる。
- 過去日付の変更と訂正は、データの上ではどちらも新しい版になる。区別は `kind` で持ち、監査、業務プロセスの権限、社会保険の届出（訂正は届出の訂正になりうる）で使う（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）。

### 6.2 訂正（DT-TEMP-003）

訂正は、元の差分を取消の印で退け、`corrects_change_id` を持つ新しい差分を同じトランザクションで足す。`seq` は元の差分と同じにする。

| # | 訂正で変えるもの | 新しい有効日が、同じ項目に触れる別の差分をまたぐ | 元の差分が `hire`・`rehire` | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 値だけ | - | - | 受ける |
| 2 | 有効日 | いいえ | いいえ | 受ける。影響の始まりは古い日と新しい日の早いほう |
| 3 | 有効日 | はい | - | 拒む（`CORRECTION_CROSSES_CHANGE`）。取消して入れ直す |
| 4 | 有効日 | いいえ | はい | 受ける。coverage の子の最初の差分の有効日も同じ日に動かす（入社日の訂正。[core-hr.md](core-hr.md) の 5.1 節） |
| 5 | 触れる項目を増やす | - | - | 拒む（`CORRECTION_WIDENS`）。別の変更として出す |
| 6 | 訂正の訂正 | - | - | 受ける。`corrects_change_id` は直前の訂正を指す。連鎖は 10 段まで |

- 「またぐ」は、古い有効日と新しい有効日の間（両端を含む）に、同じ項目に触れる取消されていない別の差分があること。またぐと、その差分との前後が入れ替わり、意味が変わるため拒む。

### 6.3 取消と依存（DT-TEMP-004）

取消は、後の差分がその差分を前提にしているとき拒む（[ADR-0002](../decisions/0002-effective-dated-data-model.md)）。前提にしているかは、次の表で判定する。表は上から評価する。候補の後の差分 `L` は、同じ主体・facet（coverage の子の facet を含む）の、取消されていない差分で、`L.effective_on ≥ R.effective_on` のもの。`R` は取り消す差分。

| # | `R` の種類 | `L` の種類 | `L.based_on_version_ids` が `R` の作った版を含む | `L` と `R` の項目が重なる | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `hire`・`rehire` | 何でも（coverage の子を含む） | - | - | 依存。拒む（後の案件から先に取り消す） |
| 2 | 何でも | `terminate`・`end` | - | - | 依存しない（退職は前の職務を前提にしない）。ただし 6.4 節の警告 |
| 3 | 何でも | 何でも | はい | はい | 依存。拒む |
| 4 | 何でも | 何でも | はい | いいえ | 依存しない。受ける |
| 5 | 何でも | 何でも | いいえ | - | 依存しない。受ける |
| 6 | 業務プロセスの種類が `depends_on` を宣言 | 宣言の相手 | - | - | 依存。拒む（例：昇格の案件の後の、その昇格を条件にした昇給） |

- `based_on_version_ids` は、起票の画面・API が読んだ版の ID を、案件が完了のときに差分へ写したもの。起票の時と完了の時の間に版が変わったら、完了の前に「見ていた版が古い」として担当に確かめ直させる（[business-process-engine.md](business-process-engine.md) の 6.3 節）。
- 拒んだときは、依存する後の案件の一覧を返す。担当は、後の案件から順に取り消す。一括の取消（依存の連鎖をまとめて取り消す）は MVP では持たない（13 節）。

### 6.4 遡及の検知

- 影響の範囲が今日以前にかかる畳み込みは、outbox に `temporal.retro_detected`（主体、facet、`[D, today]`、`kind`、`case_id`）を書く。
- 給与の領域は、この事象と確定した給与の期間を突き合わせ、遡及の候補を作る（[payroll-engine.md](payroll-engine.md)）。この領域は給与の期間を知らない。
- 休暇の付与、社会保険の等級、36 協定の集計も同じ事象を購読する。

## 7. 時点の問い合わせ（[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)）

### 7.1 API

| 引数 | 意味 | 既定 | 制限 |
| --- | --- | --- | --- |
| `effective_on` | 有効日 | テナントの暦の今日 | 1900-01-01〜今日＋3 年 |
| `known_at` | 記録の時刻 | 今（現在の知識） | テナントの作成の時刻以上、安定の境界以下 |
| `range`（履歴） | 有効日の範囲 | 全期間 | 1 回の応答は 500 期間まで。カーソルで続ける |

- API の読み取りは `GET /workers/{id}/job?effective_on=2026-04-01&known_at=2026-05-20T09:00:00Z` の形にする。応答に、使った `effective_on`・`known_at`・版の ID を返す。
- `known_at` を省くと、現在のテーブルを読む（速い）。`known_at` を指定すると、版のテーブルを読む。

```sql
-- Value on day D as known at T.
SELECT state FROM worker_job_versions
 WHERE tenant_id = $1 AND subject_id = $2
   AND valid @> $D::date
   AND known @> $T::timestamptz;
```

### 7.2 安定の境界

`recorded_at` はトランザクションの時刻で決まる。長いトランザクションが後からコミットすると、時刻 T の問い合わせの結果が、後から変わりうる。これは PROP-TEMP-003（過去の知識は変わらない）を破る。

- 有効日付の書き込みのトランザクションに `transaction_timeout = 5s` を設定する（[Client Connection Defaults](https://www.postgresql.org/docs/18/runtime-config-client.html)、2026-09-28 に確認）。
- `recorded_at` は、ロックを取った後の `clock_timestamp()` にする。
- 問い合わせの `known_at` は、**安定の境界**（今 − 10 秒）以下に限る。より新しい `known_at` を指定されたら、安定の境界に丸め、応答にそう示す。
- 給与の入力の固定（[payroll-engine.md](payroll-engine.md)）は、`known_at` = 固定の開始の時刻 − 10 秒で読み、読み始める前に 10 秒待つ。同じ `known_at` で後から読んでも同じ入力になる。

### 7.3 複数の facet の一貫性

- 1 人の複数の facet を同じ時点で読むときは、同じ `known_at` を使う。`known_at` を省いたときは、1 つの読み取り専用のトランザクション（`REPEATABLE READ`）で読む。
- 一覧（組織の全員）は、`effective_on` を 1 つに決めて、現在のテーブルの `valid @> D` で読む。`known_at` を指定した一覧は、レポートの領域の非同期の出力に回す（[reporting.md](reporting.md)）。画面の同期の応答では、`known_at` の一覧を 1,000 行までにする。

### 7.4 履歴と差分の表示

- 主体の履歴は、現在のテーブルの期間の列と、各期間の元の差分（`source_change_ids`）と案件を返す。
- 「この値はいつ誰が変えたか」の画面は、差分のテーブルを `effective_on` と `recorded_at` の両方の順で出す。訂正と取消には印を付ける。

## 8. 発効のタイマー（[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)）

将来日付の変更は、読み取りの日付で自然に見え方が変わる。発効の日に要る副作用だけを、タイマーで行う。

| 副作用の例 | 持ち主 |
| --- | --- |
| SSO のアカウントの有効化・無効化の連携 | [integrations-and-bulk.md](integrations-and-bulk.md) |
| ロールの割り当ての変化による権限のキャッシュの無効化 | [security-model.md](security-model.md) |
| 上長の変更による、進行中の案件の担当の確認の通知 | [business-process-engine.md](business-process-engine.md) |
| 本人・上長への通知 | 通知の worker |

```sql
temporal_activations (tenant_id, id, subject_type, subject_id, facet,
                      effective_on date,
                      fire_at timestamptz,        -- effective_on 00:00 in tenant tz
                      source_change_id uuid,
                      handler text,               -- registered side-effect handler
                      state text,                 -- scheduled / fired / cancelled
                      fired_at timestamptz, attempts int,
                      PRIMARY KEY (tenant_id, id))
```

- 差分を書くトランザクションの中で、`effective_on > 今日` の差分に対して、facet ごとに登録した副作用の予定を作る。
- 取消・訂正で元の差分が退いたら、予定を `cancelled` にし、必要なら新しい予定を作る（同じトランザクション）。
- BP Worker が、`fire_at <= now()` の予定を `FOR UPDATE SKIP LOCKED` で取り、副作用を outbox に書いて `fired` にする。副作用は冪等キー（予定の ID）で重複を防ぐ。
- 発効の日を過ぎてから入った過去日付の変更には、予定を作らず、差分の書き込みの時にすぐ副作用を出す。

発効の予定の扱い（DT-TEMP-005）：

| # | 操作 | 差分の有効日 | 元の予定の状態 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 変更 | 今日より後 | - | 予定を作る |
| 2 | 変更 | 今日以前 | - | 予定を作らず、副作用をすぐ outbox に書く |
| 3 | 取消 | - | `scheduled` | 予定を `cancelled` にする |
| 4 | 取消 | - | `fired` | 取消の副作用（逆の副作用。例：アカウントの無効化）をすぐ出す |
| 5 | 訂正 | 今日より後 | `scheduled` | 元の予定を `cancelled` にし、新しい有効日で予定を作る |
| 6 | 訂正 | 今日以前 | `scheduled` | 元の予定を `cancelled` にし、副作用をすぐ出す |
| 7 | 訂正 | 今日より後 | `fired` | 逆の副作用をすぐ出し、新しい有効日で予定を作る |
| 8 | 訂正 | 今日以前 | `fired` | 副作用の登録の定義で、値の変化だけを出す（再発行）。何も変わらなければ何もしない |
- 止まっていた後の追いつきは、`fire_at` の順に処理する。1 テナントあたり 1 分に 5,000 件までにして、他のテナントを待たせない。
- 年度の変わり目（4 月 1 日）に大量の発効が集中する。予定の件数は 7 日前から監視し、BP Worker を前の日に増やす（[capacity.md](capacity.md)）。

## 9. 規模と性能

- 版の行の見積もり：S1 で 1 人あたり年 20 版（全 facet）× 100 万人 ≒ 年 2,000 万行。差分は年 1,500 万行。
- 1 人・1 facet の畳み込みは、差分 100 件までで 10ms 以内（Aurora の writer での計測の目標。E2 で測る）。
- 組織の再編（数千人の所属の変更）は、主体ごとの畳み込みの繰り返しになる。親子の案件で 200 人ずつに分ける（[business-process-engine.md](business-process-engine.md) の 9 節）。
- S2 で、版と差分のテーブルを `recorded_at` の月ごとのパーティションにする。PostgreSQL は、パーティションをまたぐ `WITHOUT OVERLAPS` を張れないので、現在のテーブルはパーティションにしない（未検証。E2 の PoC で確かめる）。

## 10. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 畳み込みの途中で検証が失敗する | トランザクションを戻す。案件は完了しない。担当に誤りのコード（`EMPTY_PERIOD` など）を示す |
| `PERIOD` の外部キーの違反 | 同上。アプリの事前の検査で `OUTSIDE_COVERAGE` を返すのが普通で、DB の違反は設計の漏れとして警告する |
| 同じ主体への並行の書き込み | 主体の行ロックで直列になる。5 秒の `transaction_timeout` で失敗した側は、案件の完了を再試行する |
| 現在のテーブルと版の食い違い（バグ） | 夜間の検査で検知する（12.3 節）。直すのは現在のテーブルだけで、`temporal.rebuild_current(subject)` で版から作り直す。差分と版は変えない |
| 発効のタイマーの遅れ | 見え方は正しい（読み取りの日付で決まる）。副作用だけが遅れる。5 分の遅れで警告 |
| Aurora のフェイルオーバー | 進行中のトランザクションは失われ、案件の完了が再試行される。コミット済みの差分は失われない（RPO 0、NFR-006） |
| 時計のずれ | `recorded_at` は DB の時計だけを使う。アプリの時計は使わない |

## 11. セキュリティとプライバシー

- 時点の問い合わせも、権限の判定を通す（[security-model.md](security-model.md)）。過去の値を見る権限は、今の値を見る権限と同じドメインで判定する。例外として、`known_at` を指定した問い合わせ（「当時システムが何を知っていたか」）は、監査の権限（`audit` の `view`）を加えて要る。訂正で消した誤りの値（例：誤った口座番号）が、普通の利用者に見えないようにするため。
- 差分の `delta` にも個人情報が入る。差分のテーブルの読み取りは、facet のドメインの権限で絞る。
- 暗号化する項目（口座番号）は、差分と版の両方で暗号文を持つ。畳み込みは暗号文のまま行い、復号しない。
- マイナンバーは有効日付のテーブルに入れない。人事の側は `mn_ref` だけを持つ（[ADR-0005](../decisions/0005-security-and-my-number.md)）。
- ログには主体の ID、facet、誤りのコードだけを出し、差分の値を出さない。

## 12. テスト（[ADR-0009](../decisions/0009-temporal-reference-model-testing.md)）

### 12.1 参照のモデル

- `fold` は純粋な関数で、DB の書き込みの経路と、テストの参照のモデルの両方で使う。参照のモデルは、差分の一覧をメモリーに持ち、どの時刻の問い合わせにも、その時刻までに記録された差分を畳み込んで答える（遅いが明らかに正しい形）。
- DB の実装（Testcontainers の PostgreSQL 18）と、参照のモデルに同じ操作の列を入れ、結果を比べる（fast-check のモデルベーステスト。[Model based testing](https://fast-check.dev/docs/advanced/model-based-testing/)、2026-09-28 に確認）。

### 12.2 性質（fast-check）

生成器は、1〜3 の主体、2 つの facet（contiguous と gapped、coverage の親子）、有効日は 60 日の窓の中（境界を濃くする）、操作は変更・過去日付の変更・訂正・取消・終わり・再開、同じ日の衝突を意図して混ぜる。

| ID | 性質 |
| --- | --- |
| PROP-TEMP-001 | 任意の操作の列の後、現在のテーブルで、同じ主体・facet の期間は重ならず、空の期間がない |
| PROP-TEMP-002 | 現在のテーブルは、取消されていない差分を `fold` した結果と一致する |
| PROP-TEMP-003 | 任意の時刻 T（安定の境界より前）の問い合わせの結果は、T より後のどの操作の後でも変わらない |
| PROP-TEMP-004 | 同じ有効日・同じ `seq` の差分（受けられたもの）は、入れる順序を入れ替えても同じ現在の知識になる |
| PROP-TEMP-005 | 任意の時刻 T の問い合わせは、参照のモデルで「T までに記録された差分」を畳み込んだ結果と一致する |
| PROP-TEMP-006 | coverage の子の期間は、いつも親の期間の和の中にある |
| PROP-TEMP-007 | 取消した差分を、依存の判定（DT-TEMP-004）が許す順で全部取り消すと、主体の現在の知識は差分がない状態と一致する |
| PROP-TEMP-008 | 発効の予定は、`effective_on > 記録の日` の生きている差分とちょうど 1 対 1 に対応する（取消・訂正の後も） |
| PROP-TEMP-009 | 隣り合う 2 つの期間の状態は必ず違う（coalesce の不変） |

- 失敗した例は、種（seed）と縮めた操作の列をテストの名前に残し、回帰のテストに加える。
- CI の試行は 1 性質あたり 500 回、夜間は 20,000 回。

### 12.3 決定表と本番の検査

- DT-TEMP-001〜005 は `spec.md` から読む表駆動テストにする。
- 夜間の検査（NFR-002）：
  - 現在のテーブルと、`superseded_at IS NULL` の版の突き合わせ。
  - 1% の主体を抜き取り、差分から参照のモデルで畳み込み直し、版と比べる。
  - `fired` でない過去の発効の予定。
  - 食い違いは SEV2。検査はリーダーで行う。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `temporal-constraints-poc` | Aurora PostgreSQL 18 で `WITHOUT OVERLAPS`・`PERIOD`・`btree_gist`・RLS の組み合わせを確かめる。書き込みの関数の権限の方式（4 節の注）を決める |
| E2 | `temporal-types` | 3 節の型、`CivilDate` の変換、上限の検査 |
| E2 | `temporal-ddl-generator` | `FacetSpec` から 3 つのテーブル・制約・RLS・トリガーのマイグレーションを作る。CI の検査（3 つのテーブルと制約を持たない有効日付のテーブルを拒む） |
| E2 | `temporal-fold-and-write-path` | 5 節の手順、DT-TEMP-001・002、PROP-TEMP-001・002・004・006・009 |
| E2 | `temporal-correction-and-rescind` | 6 節、DT-TEMP-003・004、PROP-TEMP-007 |
| E2 | `temporal-point-in-time-query` | 7 節の API、安定の境界、PROP-TEMP-003・005 |
| E2 | `temporal-activation-timers` | 8 節、DT-TEMP-005、PROP-TEMP-008 |
| E2 | `temporal-retro-events` | 6.4 節の `temporal.retro_detected` と購読の契約 |
| E2 | `temporal-nightly-consistency` | 12.3 節の夜間の検査と `rebuild_current` |
| E3 | `temporal-history-ui` | 7.4 節の履歴と差分の画面（core-hr の画面と一緒に） |

## 14. 未解決の問い

### 決定

- **同じ日の順序は `seq` で決め、同じ `seq` で同じ項目の差分は拒む**（5.2 節）。入力の順（本家の Entry Moment の考え方）に依存させない。並行する案件の完了の順で結果が変わらない。
- **訂正で有効日を動かせるのは、同じ項目の別の差分をまたがない範囲だけ**（DT-TEMP-003）。
- **取消の依存は、`based_on_version_ids` と項目の重なりと、業務プロセスの種類の `depends_on` で判定する**（DT-TEMP-004）。一括の連鎖の取消は MVP では持たない。
- **`known_at` は安定の境界（今 − 10 秒）以下に限る**。書き込みのトランザクションは 5 秒で打ち切る。
- **`known_at` を指定した問い合わせには監査の権限を加えて要る**（11 節）。
- **将来日付の上限は今日＋3 年、有効日の下限は 1900-01-01**。
- **過去日付の変更は、90 日より前なら `retro_override` の権限を要する**。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 現在のテーブルへの書き込みを関数だけに限る方式（`SECURITY DEFINER` と RLS の関係） | E1 の `temporal-constraints-poc` |
| 版と差分のパーティションの時期と、`WITHOUT OVERLAPS` とパーティションの関係 | E2 の PoC と S2 の前の計測 |
| 依存の連鎖をまとめて取り消す操作を持つか | E3 の後に、人事の担当の利用の実績で決める |
| 社会保険の届出の訂正に要る「訂正の理由」の区分 | [payroll-jp-rules.md](payroll-jp-rules.md) と社労士の確認 |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 有効日付の性質（PROP-TEMP-001〜009）の CI と夜間の試行の回数、失敗の種の回帰の一覧。
- 夜間の整合の検査の食い違いの件数（目標 0。NFR-002）。
- 畳み込みの時間の p99（主体あたりの差分の件数ごと）。
- `SAME_DAY_CONFLICT`・`CORRECTION_CROSSES_CHANGE`・取消の拒否の件数（業務の設計の見直しの材料）。
- 発効のタイマーの遅れの p99。

### runbooks

- `temporal-consistency-mismatch.md`：夜間の検査の食い違いへの対応。`rebuild_current` の使い方、原因の調べ方、給与の遡及の確認。
- `activation-backlog.md`：発効の予定の滞留（4 月 1 日などの集中）の確かめ方と、BP Worker の増やし方。
- `rescind-chain.md`：取消が依存で拒まれたときに、依存の一覧から順に取り消す手順（人事の担当向けの支援）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `<facet>_changes` | 4 節。追記のみ（`rescinded_*` を除く） |
| Aurora `<facet>_versions` | 4 節。追記のみ（`superseded_*` を除く）。GiST (`tenant_id`, `subject_id`, `valid`, `known`) |
| Aurora `<facet>`（現在） | 4 節。`WITHOUT OVERLAPS` の主キー、`PERIOD` の外部キー |
| Aurora `temporal_activations` | 8 節 |
| outbox の事象 `temporal.changed`・`temporal.retro_detected` | 5.1・6.4 節 |

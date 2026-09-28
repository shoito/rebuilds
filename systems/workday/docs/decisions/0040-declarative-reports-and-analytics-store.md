---
status: accepted
date: 2026-09-28
---

# ADR-0040: レポートを宣言の定義で持ち、同じ権限の判定を通して時点を固定して実行し、S2 は S3 の Iceberg と Athena に移す

詳細は [reporting.md](../architecture/reporting.md) の 3・4・6 節。

## Context

- intent は、人員の一覧・組織図・異動の履歴・残業・休暇・給与の集計・賃金台帳を、任意の時点で出すことを求める。
- レポートも画面・API と同じ権限の判定を通す（[ADR-0005](0005-security-and-my-number.md)、[AGENTS.md](../../AGENTS.md)）。判定は `can`・`scopeFilter`・`project` に集まっている（[ADR-0017](0017-authorization-evaluator.md)）。
- 時点は `effective_on` と `known_at`。`known_at` は安定の境界より前に限り、監査の権限を要する（[ADR-0008](0008-point-in-time-queries-and-activation-timers.md)）。
- [architecture/README.md](../architecture/README.md) の 6 節は、レポートの基盤（Aurora の reader のままか、分析用の列指向の基盤か）を S2 の前に決めるとした。
- テナントが自由な SQL や式を書けると、権限の判定を迂回でき、検証もできない（[ADR-0013](0013-bp-definition-format-and-versions.md) と同じ理由）。

## Options

定義：

1. **システムが持つデータの元の上で、列・条件・集計・時点を選ぶ宣言の定義。SQL は report-service が組み立てる**
2. テナントが SQL を書く（読み取り専用のロールで実行）
3. 外部の BI の道具にデータを出し、そこでレポートを作る

実行の場所：

- a. **S1 は Aurora のレポート専用の reader。S2 は S3 の Iceberg の表と Athena。どちらも report-service からだけ読む**
- b. S1 から分析用のデータウェアハウス（Redshift など）を置く
- c. すべて Aurora の reader で行い、reader を増やす

## Decision

1 と a を採用する。

- データの元（`report_sources`）はシステムの定義で、列ごとにドメインを持つ。マイナンバー・口座番号・要配慮は列にしない。
- 定義（`report_definitions`）は版を持ち、条件は業務プロセスの式の木の核を使う。
- 実行は、`project` で列を落とし、`scopeFilter` を SQL に入れ、パラメーター化した SQL で行う。1,000 行を超える見込みなら非同期。
- 実行ごとに `report_runs`（定義の版、引数、`resolved_known_at`、落とした列、抑止の数、行数、結果の SHA-256）を記録する。値は記録しない。
- 組織の範囲は、権限の規則の時点（`effective_on` と今日の早いほう）で絞る。
- S1 はレポート専用の reader とカスタムエンドポイント。S2 は、データの元の列だけを夜間に Iceberg の表へ書き出し、Athena で読む。Athena の実行は report-service のロールだけ。
- 2 を採らない理由：RLS はテナントの分離を守るが、組織の範囲と項目の射影を守らない。権限の判定の迂回になる。
- 3 を採らない理由：出したデータの先で、権限と閲覧の記録が効かない。一括の出力の経路で、テナントの責任で出すことはできる（[integrations-and-bulk.md](../architecture/integrations-and-bulk.md)）。
- b を採らない理由：S1 の量（最大 3 万人）なら専用の reader で足りる見込み。常時の費用と、もう 1 つの権限の実装が増える。
- c を採らない理由：S2 の 10 万人のテナントの推移の集計が、給与の入力の固定と reader を取り合う。

## Consequences

- 良くなること：
  - レポートの行と列が API と一致し、閲覧の記録が必ず残る。
  - 同じ引数で同じ結果を出し直せ、監査で説明できる。
- 引き受けるコスト：
  - テナントの表現力が限られる。足りないデータの元・関数はシステムのリリースで足す。
  - S2 では Aurora 用と Athena 用の 2 つの SQL の組み立てを保守する。同じ定義の結果の一致を、書き出しの鮮度の範囲で確かめるテストが要る。
  - 分析用の基盤は前日までの鮮度。

## Confirmation

- 性質ベーステスト：PROP-RPT-001（同じ引数で同じ結果）、PROP-RPT-002（レポートと `can`・`project` の一致）、PROP-RPT-004（テナントの分離。Aurora と分析用の基盤の両方）。
- lint：report-service の外で、人事のテーブルを一覧で読むコードを禁じる（[ADR-0017](0017-authorization-evaluator.md) の lint と同じ）。
- 本番：レポートと API の判定の抜き取りの突き合わせで、不一致 0 件。

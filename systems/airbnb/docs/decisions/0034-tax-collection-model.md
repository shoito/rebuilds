---
status: accepted
date: 2026-10-10
---

# ADR-0034: 預かりと納付の型は `legal.lodging_tax_collector`（`host`・`platform`）で持ち、本番の値は法務の L4 の後。`host` では税を総額に含めて受け、release でホストへの支払いに含め、管轄・月ごとの明細をホストに出す。`platform` では `tax_payable:<jurisdiction>:<tax>` に振り替える。キャンセルの税の返し方は ADR-0039 の DT-CXL-001 に従う

> 2026-10-10 の注記：統合の工程で、キャンセルの税の返し方の規則を [ADR-0039](0039-cancellation-policy-table-and-refund-decision-table.md) に移した（2 つの ADR に同じ規則が別の書き方であったため）。規則の中身は変えていない。

詳細は [taxes.md](../architecture/taxes.md) の 8 節。

## Context

- 本システムが宿泊税・入湯税を特別徴収義務者として預かり納めるか、ホストが納めるかは法務の確認待ち（[intent.md](../intent.md) の L4）。既定は「ホストが納める。本システムは額を出して明細に書く」（[architecture/README.md](../architecture/README.md) の 6 節）。
- 台帳は `tax_payable:<jurisdiction>:<tax>` の口座を持ち、L4 の後に使う。既定はホストへの支払いに含める（[ADR-0005](0005-payments-hold-capture-and-ledger.md)）。
- 管轄ごとに、本システムが集める協定を結ぶ可能性がある。
- 泊がないのに税を残すと、ゲストに説明がつかない。

## Options

1. **`legal.*` の値（管轄ごとに持てる）で型を切り替える。仕訳と明細の両方の形を先に作る**
2. ホストが納める型だけを作り、結論で作り直す
3. 本システムが納める型だけを作る

## Decision

1 を採用する。

- `legal.lodging_tax_collector` と `legal.lodging_tax_collector.<jurisdiction>`。既定 `host`。本番の値は法務の L4 の後。
- `host`：税は総額に含めて受け、release で `host_payable` に含める。ホストに月ごと・管轄ごと・税の種類ごとの泊数・人数・標準・税の額を出す。
- `platform`：release で税の額を `tax_payable:<jurisdiction>:<tax>` に振り替え、納付の資料を作る。
- キャンセルの税の返し方（使わなかった泊の分を返す。チェックインの前は全額）は [ADR-0039](0039-cancellation-policy-table-and-refund-decision-table.md) と DT-CXL-001 が正本で、この ADR は返した税・残した税を `host`・`platform` のどちらの型で扱うかだけを持つ（法務の確認待ち：L4）。

### 他の案を選ばなかった理由

- **2**：結論が `platform` なら、台帳と明細と返金の計算を後から作り直す。
- **3**：法務の結論の前に本システムが納める前提で作ると、登録と納付の義務を負わないうちに預かりのお金が生まれる。

## Consequences

- 良くなること：
  - 法務の結論を、値の変更と管轄ごとの切り替えで受けられる。
- 引き受けるコスト：
  - 2 つの型の仕訳と明細を試験し続ける。
  - 型を切り替えた日の前後の予約は、予約の時の型で決着する（見積もりに型を写す）。

## Confirmation

- PROP-TAX-006（キャンセルの税）。
- 台帳の性質（[quality.md](../quality.md) の 2.2.1 節 C）を、2 つの型の両方で回す。

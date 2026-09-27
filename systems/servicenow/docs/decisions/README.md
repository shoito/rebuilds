# Decisions: ServiceNow

ServiceNow の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は ADR-0006、本家の実装を使わない規則は ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、記録の基盤を自前で実装する。本家のスクリプトの API との互換は求めない | accepted |
| [0002](0002-tenancy-and-isolation.md) | 共有のセルでの RLS のマルチテナントを既定にし、大口の企業には同じ版の専用のセルを出す | accepted |
| [0003](0003-table-hierarchy-and-extensible-schema.md) | テーブルはクラスの継承の階層として辞書に持ち、組み込みのクラスは型付きの列、テナントの拡張は JSONB と型付きの索引の表で持つ | accepted |
| [0004](0004-workflow-and-sla-engine.md) | ワークフロー・承認・SLA は Aurora の上の自前の耐久性のあるエンジンで動かし、遷移をレコードと同じトランザクションで 1 回だけ行う | accepted |
| [0005](0005-cmdb-identification-and-reconciliation.md) | CI の作成・更新を識別と調整の 1 つの入口に集め、正規化した識別の値の一意の索引で重複を防ぐ。関係のグラフは PostgreSQL に持つ | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

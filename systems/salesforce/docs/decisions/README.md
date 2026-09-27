# Decisions: Salesforce

Salesforce の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、メタデータの実行基盤を自前で作る。本家の言語との互換は持たない | accepted |
| [0002](0002-custom-object-storage.md) | レコードを共有の records の表（システムの列＋JSONB）に入れ、型付きのピボットの表で引く | accepted |
| [0003](0003-metadata-driven-runtime.md) | メタデータを版の付いた不変のスナップショットにコンパイルし、要求を 1 つの版に固定して AST から SQL を作る | accepted |
| [0004](0004-record-access-model.md) | 共有を事前計算し、所有者とロール階層は閉包の表と結ぶ。設定の変更の再計算は影の世代で切り替える | accepted |
| [0005](0005-tenancy-and-governor-limits.md) | 組織を共有スキーマと RLS で分け、論理シャードとセルで広げる。上限は実行基盤のデータ層で強制する | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

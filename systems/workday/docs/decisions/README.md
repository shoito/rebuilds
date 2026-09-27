# Decisions: Workday

Workday の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を使わない規則は ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、給与計算も TypeScript で書く。お金は整数の円と固定小数点で扱う | accepted |
| [0002](0002-effective-dated-data-model.md) | 人事のデータを有効時間と記録時間の 2 軸で持ち、変更の差分を有効日の順に畳み込む | accepted |
| [0003](0003-business-process-engine.md) | 業務プロセスを、版つきの定義と Aurora に永続する状態機械で自前に作る | accepted |
| [0004](0004-payroll-engine.md) | 給与計算を、入力のスナップショットと規則表の版から決まる純粋な計算にする | accepted |
| [0005](0005-security-and-my-number.md) | ドメインと業務プロセスの権限と職務分掌で守り、マイナンバーは別アカウントの保管庫に置く | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

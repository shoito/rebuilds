# Decisions: Stripe

Stripe の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 実行基盤と技術は Slack の決定を引き継ぎ、金額は最小単位の整数で扱う | accepted |
| [0002](0002-account-tenancy.md) | 加盟店のアカウントをテナントにし、共有スキーマと RLS で分ける | accepted |
| [0003](0003-double-entry-ledger.md) | お金の正本は、追記のみの複式簿記の台帳にする | accepted |
| [0004](0004-idempotency.md) | すべての書き込みを冪等にする | accepted |
| [0005](0005-pci-scope-segmentation.md) | カード情報は CDE（別の AWS アカウント）に閉じ込め、本体はトークンだけを扱う | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

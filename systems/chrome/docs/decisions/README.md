# Decisions: Chrome

Chrome の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-languages-and-platform.md) | ブラウザは Rust、クラウドのサービスは TypeScript と AWS で作る | accepted |
| [0002](0002-engine-build-vs-reuse.md) | ブラウザの構造は自作し、成熟した部品を使う | accepted |
| [0003](0003-multi-process-site-isolation.md) | 複数プロセスとサイトの隔離を、最初から前提にする | accepted |
| [0004](0004-release-channels-and-updates.md) | 4 つのチャンネルと 4 週ごとのリリース、段階的な自動更新にする | accepted |
| [0005](0005-privacy-first-services.md) | クラウドのサービスは送るデータを最小にし、同期は暗号化する | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

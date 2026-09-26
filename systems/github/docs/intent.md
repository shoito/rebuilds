# Intent: GitHub を AI エージェント主体で再構築する

- Author: shoito
- Status: accepted
- Date: 2026-09-26

## Problem

ソフトウェアの開発は、Git のリポジトリを中心に、レビュー・課題の管理・CI・リリースが回っている。これらを支えるホスティングは、次の点で難しい。

- 大量のリポジトリを、壊さずに保存し、速く配る。
- 公開と非公開が入り混じる中で、権限を正しく守る。
- 差分・マージ・検索といった、重い計算を大量にこなす。

本家 GitHub は、これを「コードの置き場所」を超えた、共同作業の場として提供している。その中身を、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。AI エージェントが開発の主な作り手になる時代に、エージェントが使いやすいことも、再構築の論点に含める。

## Proposed outcome

Git のリポジトリのホスティングと、その上の共同作業を作り直す。次の 3 つの価値を満たす。

1. **コードを失わず、速く配る**：push したコミットは失われない。clone と fetch が速い。
2. **レビューして安全に取り込む**：Pull Request、差分、レビュー、ブランチの保護、merge queue。
3. **開発の流れをつなぐ**：Issue、通知、検索、Webhook と API、CI（Actions に相当）。

### MVP に含める

- ユーザー、Organization、チーム、ロール。リポジトリの公開・非公開、コラボレーター
- Git のホスティング：HTTPS と SSH、プロトコル v2、LFS。fork
- Web でのコードの閲覧：ファイル、履歴、blame、Markdown の描画
- Pull Request：差分、レビュー、コメント、必須のレビュー、ブランチの保護（ruleset）、マージの方式（merge・squash・rebase）、merge queue
- Issue、ラベル、マイルストーン、担当者
- 通知（Web とメール）
- 検索：リポジトリ・Issue・Pull Request の検索と、コード検索
- REST API と GraphQL API、Webhook、OAuth のアプリと GitHub App に相当する仕組み、個人用アクセストークン
- CI（Actions に相当）：ワークフローの定義、ホストされた実行環境、シークレット、ログ、成果物
- ステータスとチェック（外部の CI の結果の表示）

### 守るべき振る舞い

- 受け付けた push（成功を返した ref の更新）は失われない。
- 非公開のリポジトリの中身は、権限のない人に一切見えない。Webhook・検索・通知・API・CI のログのどこからも漏れない。
- ブランチの保護の規則を満たさない変更は、保護されたブランチに入らない。
- CI のジョブは、他のジョブ・他のリポジトリのシークレットに触れられない。

## Affected users and systems

- 開発者（Git のクライアント、Web、API、CLI）
- Organization の管理者
- CI の実行環境と、外部の CI・ツール（Webhook と API の利用者）
- AI エージェント（API とトークンで操作する主体）

## Constraints

- 実行基盤は、rebuilds の他の題材の決定（AWS、Terraform、OpenTelemetry）を引き継ぐ。Git のストレージ層だけは、Git の操作に適した言語を選ぶ（[ADR-0001](decisions/0001-platform-and-stack.md)）。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| Copilot（AI によるコードの補完・生成） | 別の製品。ただし、エージェントが使いやすい API とトークンは MVP で扱う |
| Codespaces（クラウドの開発環境） | 実行環境の運用が別に大きい |
| Packages（パッケージのレジストリ） | レジストリごとの互換性の実装が大きい。MVP の後の Epic |
| Pages（静的サイトのホスティング） | MVP の後の Epic |
| Discussions、Wiki、Projects（計画のボード）、Sponsors、Marketplace | 共同作業の中核の外。MVP の後に候補として扱う |
| Advanced Security（秘密情報の走査、依存の脆弱性、コードの静的解析） | MVP の後の Epic。ただし、push の中の秘密情報の走査（push protection）は候補として早めに検討する |
| Enterprise Server（オンプレミス版） | 配布と運用の形が別の製品 |

## Open questions

- ~~公開リポジトリの大量の clone（CI や AI の学習の収集）への帯域とコストの対策を、どこまで行うか。~~ → 2026-09-26 に既定案で決めた：人気の公開リポジトリの bundle-uri と CDN、リポジトリごと・IP ごとの clone のレート制限。利用者ごとの帯域の課金は MVP に含めない（[architecture/README.md](architecture/README.md) の 6 節）。

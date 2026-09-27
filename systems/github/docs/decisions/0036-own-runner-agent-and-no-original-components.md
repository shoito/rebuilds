---
status: accepted
date: 2026-09-28
---

# ADR-0036: Actions のランナーのエージェントを自前で作り、本家の公開の部品を核に使わない

## Context

リポジトリ共通の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md) は、題材の核に本家の実装を使うことを禁じた。2026-09-28 に、この題材の設計を見直した。

- **Actions のランナーのエージェント**：[actions.md](../architecture/actions.md) の 9.2 節と 18 節は、本家の [actions/runner](https://github.com/actions/runner)（MIT）を fork して使うと決めていた。アクションの実行、式の評価、ログのマスクは、CI の主な論点そのものである。これは ADR-0007 に反する。
- **その他の本家の公開の部品**：本家は Markdown の解析器（cmark-gfm）、言語の判定（Linguist）、UI の部品（Primer）なども公開している。設計はこれらを核に使っていないが、エージェントが実装の段階で選びがちである。
- **本家の設計の参照**：Git のストレージは本家の Spokes（非公開）の公開の記事に倣う。コードは使っていない。

## Options

1. **ランナーのエージェントを Go で自前で作る。** 振る舞いは本家の公開の文書に合わせる
2. **actions/runner を fork して使う**（元の決定）
3. **第三者の実装（nektos/act など）を土台にする**

## Decision

1 を採用する。

> 2026-09-28 の注記：actions.md の 18 節の「actions/runner を fork して使う」（2026-09-26 の決定）を覆す。ADR-0007 に反するため。

- **ランナーのエージェントは Go で作る。** 1 つの静的なバイナリにし、ホストされたランナーの VM と、セルフホストのランナー（Linux・macOS・Windows）に同じものを配る。Broker・Log service と同じ言語にする。
- **互換の目標は、公開の文書にある振る舞いだけにする。** アクションの種類（JavaScript・Docker・composite）、`action.yml` の形、ワークフローのコマンド（`::add-mask::` など）、環境のファイル（出力・環境変数・パス・ステップの要約）、式の構文と関数、取り消しの手順。名前は ADR-0006 で置き換える。プロトコルの互換は振る舞いであり、ADR-0007 に反しない。
- **式の評価器は、サーバー（TypeScript）とランナー（Go）の 2 つになる。** 同じテストのコーパスで両方を検査する（actions.md の 3.3 節。元の設計と同じ）。
- **公開のアクション（`actions/checkout` など）は、利用者のワークフローが呼ぶ内容として実行する。** 本システムの部品ではないので、ADR-0007 の対象外とする。
- **他の本家の公開の部品も、核に使わない。**
  - Markdown：本家の cmark-gfm を使わない。TypeScript の第三者の解析器（micromark と GFM の拡張など）で、CommonMark と GFM の仕様のテストを通す（[web.md](../architecture/web.md) の 4.1 節）。
  - UI：本家の Primer・Octicons を使わない。自前の部品と、第三者のアイコンを使う（現在の設計も使っていない）。
  - 言語の判定（[search.md](../architecture/search.md) の 3.1 節、[web.md](../architecture/web.md) の 3.2 節）：第三者の go-enry を使ってよい。go-enry は本家の Linguist の規則のデータ（MIT）を取り込むが、本家の実装ではない。言語の判定は検索と表示の補助で、核から外れ、置き換えがきく。
  - 開発の道具（CodeQL、Dependabot など。[security.md](../architecture/security.md) の 11 節）：開発リポジトリの検査の道具で、製品の部品ではない。置き換えがきく（Semgrep、osv-scanner）ので、候補のままにする。
- 2 を採らない理由：CI の主な論点（アクションの実行、式、マスク）を設計しないことになる。ADR-0007 に反する。
- 3 を採らない理由：act は手元で動かすための道具で、長時間の接続、心拍、取り消し、セルフホストの登録を持たない。土台にすると、結局ほとんどを作り直す。挙動の比較の参考にはしてよい。

## Consequences

- 良くなること：
  - アクションの実行とマスクの設計を、自分の責任で持てる。Broker とのプロトコルを最初から自前の形で作れる。
  - 本家の追従（四半期ごとの取り込み）の作業がなくなる。
- 引き受けるコスト：
  - 実装の量が増える。E8 の見積もりを増やす。
  - 公開のアクションとの互換を、自分で確かめる必要がある。よく使われるアクションの一覧で互換のテストを持つ。
  - Windows・macOS のセルフホストのランナーの検証が要る。

## Confirmation

- レビュー観点：開発リポジトリの依存の一覧（`go.mod`、`package.json`）に、本家が作った製品の本体（actions/runner、cmark-gfm、Primer など）が入っていない。
- 互換のテスト：よく使われる公開のアクション（checkout、setup 系、cache、upload-artifact など）を、自前のランナーで動かし、結果を固定する。
- 式の評価器：サーバーとランナーで、同じコーパスの結果が一致する。

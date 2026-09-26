---
status: accepted
date: 2026-09-26
---

# ADR-0011: ブランチの保護は ruleset に一本化し、1 つの評価関数で push とマージの両方を判定する

## Context

「ブランチの保護の規則を満たさない変更は、保護されたブランチに入らない」は、守るべき振る舞いである（[intent.md](../intent.md)）。

本家には、ブランチの保護の仕組みが 2 つある。

- 旧来の「ブランチの保護の規則（branch protection rule）」：1 つのブランチに 1 つだけ効く。
- ruleset：1 つのブランチに複数が同時に効く（[About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)）。
  - 優先順位はなく、規則は集約され、最も厳しいものが効く。
  - 無効化しても消さずに残せる。
  - 読み取り権限のある人は、有効な ruleset を見られる。
  - Organization の単位でも定義できる。

変更がブランチに入る経路は複数ある。

- git push
- Web・API でのマージ
- merge queue
- 提案の適用
- Web での編集

経路ごとに判定を書くと、どれかで抜けが生じる。

## Options

1. **ruleset だけを持ち、1 つの評価関数を、すべての ref の更新の経路から呼ぶ**
2. 旧来のブランチの保護の規則と ruleset の両方を持つ（本家と同じ）
3. 旧来のブランチの保護の規則だけを持つ

## Decision

1 を採用する。詳細は [pull-requests.md](../architecture/pull-requests.md) の 5 節にある。

- **保護のモデルは ruleset だけにする。**
  - 持ち主：リポジトリか Organization
  - 対象：ref の名前の fnmatch のパターン
  - 状態：`active`・`evaluate`・`disabled`
  - 規則と、バイパスする主体
- **規則は集約し、最も厳しいものが効く。** 本家と同じ規則にする。
  - 数値は最大
  - 真偽は OR
  - 許すマージの方式は積集合
  - 必須のチェックは和集合
- **評価の関数は 1 つにする。** `evaluate(repo, ref, operation, actor, context)` が、許否・違反の一覧・使ったバイパスを返す。
  - Git のフロントエンドは、push の ref の更新の合意の前に呼ぶ（[git-protocols.md](../architecture/git-protocols.md)）。
  - API は、マージ・merge queue の取り込み・提案の適用・Web での編集の前に呼ぶ。ストレージの RPC の直前に、Git の現在の SHA で再評価する。
- **バイパスは ruleset ごとに判定する。** ある ruleset のバイパスで、別の ruleset の違反を許さない。バイパスで通した操作は監査ログに残す。モードは「常に」と「PR 経由のときだけ」（[Creating rulesets for a repository](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)）。
- **`evaluate` の状態を持つ。** 強制せず、違反を記録するだけにする。本家では Enterprise の機能だが（[Enterprise Cloud のドキュメント](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository)）、ここでは新しい規則を安全に入れるために全体で使えるようにする。プランでの制限は PM が決める。
- **判定の材料が読めないときは拒否する（fail closed）。** ruleset やチェックの結果を読めなければ、push もマージも拒否する。
- 2 は、2 つのモデルの重なりの規則（どちらも効く場合の集約）を実装し、検証する負担が大きい。新しく作るので、移行の互換のために旧来のモデルを持つ理由がない。
- 3 は、Organization の単位の保護と、複数の規則の重ね合わせを表せない。
- 旧来のブランチの保護の規則の REST API を互換のために提供するかは、[api-and-webhooks.md](../architecture/api-and-webhooks.md) で決める。提供する場合も、ruleset への写像として実装し、別の保存と評価を持たない。

## Consequences

- 良くなること：
  - すべての経路で、同じ規則が同じ結果になる。判定の抜けを 1 か所の検証で防げる。
  - 決定表（ruleset の組み合わせ × 主体 × 操作 → 許否）で網羅的に検証できる。
- 悪くなること、引き受けるコスト：
  - push の経路が、ruleset の DB の読み取りに依存する。キャッシュ（ruleset の版ごと）で緩和するが、DB の障害時は push も止まる（fail closed）。
  - 本家の旧来のブランチの保護の規則に慣れた利用者・ツールには、違いがある。

## Confirmation

- 決定表のテスト：ruleset の組み合わせ（複数・Organization とリポジトリ・`active` と `evaluate`）× 主体（バイパスの有無・モード）× 操作（作成・更新・force push・削除・3 つの方式のマージ・キューへの追加）の許否を、push と API の両方の経路で同じ結果になることを確かめる。
- 性質ベーステスト：任意の ruleset の集合と操作の列で、`active` の規則を満たさない ref の更新が、バイパスの記録なしに Git に反映されない。
- lint：ストレージの ref の更新の RPC を呼ぶコードが、評価の関数の結果を引数に持たない場合に失敗させる。
- 障害注入：ruleset の読み取りを失敗させると、push とマージが拒否される。

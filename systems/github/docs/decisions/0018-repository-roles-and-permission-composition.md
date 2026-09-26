---
status: accepted
date: 2026-09-26
---

# ADR-0018: リポジトリの権限は、本家と同じ 5 つのロールの最大値で決める

## Context

[ADR-0002](0002-repository-permission-model.md) で、権限の判定を `can(actor, action, resource)` の 1 つに集めると決めた。その中身、つまり「ある人がリポジトリに何をしてよいか」を、どの元（持ち主、コラボレーター、チーム、Organization の基本の権限、公開の種類）から、どう合成するかを決める。

本家 GitHub の利用者は、ロールの名前と振る舞いを知っている。道具（`gh`、Octokit）と AI エージェントも、本家のロールと権限の名前を前提にしている。

## Options

1. **本家と同じ 5 つの固定のロール（read・triage・write・maintain・admin）。実効のロールは、すべての元の最大値。明示の拒否は持たない**
2. 固定のロールに、明示の拒否（deny）を加える
3. 最初からカスタムのロール（権限の自由な組み合わせ）を持つ

## Decision

1 を採用する。詳細は [identity-and-permissions.md](../architecture/identity-and-permissions.md) の 4〜6 節にある。

- ロールは本家と同じ 5 つにし、ロールごとの操作は本家の表に合わせる（[Repository roles for an organization](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)、2026-09-26 に確認）。
- 実効のロールは、次の元の最大値にする：個人のリポジトリの持ち主（admin）、Organization の owner（admin）、直接のコラボレーター、チーム（親チームのロールを子チームに引き継ぐ）、基本の権限（Organization のメンバーだけ。外部のコラボレーターには効かない。既定は read）、公開の種類（`public` はだれでも read、`internal` は Enterprise のメンバーが read）。
- 操作は、細粒度の PAT と App と同じ「権限の名前 × 水準」（`contents:write` など）で表す。ロールの表と資格情報の上限を同じ語彙で書き、実効の許可を「ロールが許す操作 ∩ 資格情報の上限」とする。
- 読み取りもできない資源への要求は、どの操作でも 404 にする（存在を漏らさない）。
- fork の権限（非公開の fork は上流のチームの権限を引き継ぐ、上流の権限を失ったら非公開の fork を消す、公開の種類を変えたら fork を切り離す）も本家に合わせ、1 つの fork のネットワークの中で公開と非公開を混ぜない。
- 2 は、本家にない概念で、利用者の期待とずれる。最大値の合成を崩すので、判定と一覧の絞り込み（`accessPredicate`）が複雑になる。
- 3 は、本家では Enterprise の機能で、MVP の利用者の大半には要らない。判定の表と漏洩のテストの組み合わせが一気に増える。E10 の後に、固定のロールを基にしたカスタムのロールとして検討する。

## Consequences

- 良くなること：
  - 利用者・道具・エージェントが、本家の知識のまま権限を理解できる。
  - 合成が「最大値」だけなので、`can()` と `accessPredicate` を同じ規則から作れ、一覧と個別の判定が食い違いにくい。
- 引き受けるコスト：
  - 「この人だけ外す」ができない。外すには、その人を与えている元（チーム、基本の権限）を変える必要がある。
  - 入れ子のチームの引き継ぎのために、`team_closure` を保つ必要がある。
  - 本家の表の細部（会話のロックの最小のロールなど）に確かめきれない点が残り、実装の前に 1 行ずつ確かめる必要がある。

## Confirmation

- 表駆動テスト：identity-and-permissions.md の 5.3・5.4・5.5 節と 6 節の各行。
- 性質ベーステスト：実効のロール ＝ 元の最大値。`can()` と `accessPredicate` の結果が一致する。読めない資源は常に 404。1 つのネットワークの公開の種類は 1 つ。
- lint：`packages/authz` の外から、権限の表（`repository_collaborators`・`team_repository_roles`・`org_memberships` など）を読むことを禁止する。

---
status: accepted
date: 2026-09-26
---

# ADR-0004: エージェントの PR は GitHub App から作り、人が承認する

## Context

[process.md](../process.md) の「兼務と自己承認」は、同じ関門で作成者と承認者を別の人にすることを求めている。ブランチの保護（[ADR-0002](0002-trunk-based-development.md)）では、`CODEOWNERS` の承認を必須にする。

しかし、今のリポジトリは個人のもので、持ち主は `@shoito` だけである。GitHub では、PR の作成者は自分の PR を承認できない。このままでは、`@shoito` が作った PR も、`@shoito` の端末で動くエージェントが `@shoito` として作った PR も、マージできない。

## Options

1. **エージェントの PR は GitHub App（ボットのアカウント）から作る。** 人が自分で作った PR だけは、管理者のバイパスでマージし、事後に確認する
2. **Organization に移し、承認者を増やす**
3. **必須の承認を外し、CI と merge queue だけを必須にする**

## Decision

1 を採用する。

- **エージェントは、GitHub App のトークンで push し、PR を作る。** PR の作成者は App になるので、`@shoito` が `CODEOWNERS` として承認できる。「作成者（エージェントに指示した人）と承認者を別にする」という規則とは、次のように整理する。エージェントの成果物は、指示した人のものとみなす。ただし、承認の操作では、エージェントの出力を人がレビューする関門として働く。
- **App の権限は最小にする。** 付けるのは、`contents: write`（ブランチへの push）、`pull_requests: write`、`issues: write`、Projects の項目の更新だけ。レビューの承認、マージ、ruleset の変更、`main` への直接の push はできない。
- **人が自分で作った PR は、リポジトリの管理者だけがバイパスでマージできる。**
  - ruleset のバイパスの対象を、管理者のロールに限る。
  - バイパスでマージした PR には、CI（`ci-pipeline` の REQ-DLV-015）が `review:post-merge` のラベルを付け、週次のレポートに載せる。
  - Epic の完了までに、別の人かエージェントのレビュー（QA 役の Subagent）で事後に確認し、結果を PR にコメントしてからラベルを外す。process.md の「人数が足りないとき」の規則の具体化である。
- **人が増えたら、バイパスを外す。** 2 人目の承認者が加わった時点で、ruleset のバイパスをなくし、この ADR を見直す。
- 2 は、人が増えるまで承認者の問題を解かない。3 は、エージェントの PR を人が見ないままマージできてしまう。

App の作成と、Projects の更新への利用は、E1 の `github-project-setup` で行う。

## Consequences

- 良くなること：
  - エージェントの変更は、必ず人の承認を経てマージされる。
  - エージェントの権限が App の単位で絞られ、監査もしやすい。
- 引き受けるコスト：
  - App の秘密鍵の管理が加わる（Secrets Manager か GitHub の Secrets に置き、定期的に入れ替える）。
  - 人が自分で作った PR は、事後の確認まで、1 人の判断でマージされた状態になる。

## Confirmation

- ruleset の設定（バイパスの対象が管理者だけであること）を、`ci-pipeline` のドリフトの検査で確かめる。
- 週次のレポートで、`review:post-merge` のまま Epic が完了したものが 0 件であることを確かめる。

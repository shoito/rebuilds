---
status: accepted
date: 2026-09-28
---

# ADR-0062: security:sensitive はパスで自動で付け、テックリードとセキュリティの担当の 2 人の承認、追加の CI、組織の単位の段階的なリリースを必須にする

詳細は [delivery.md](../architecture/delivery.md) の 4 節。

## Context

systems/salesforce の AGENTS.md は、アクセス制御、共有の再計算、テナントの分離、Sandbox へのデータの複製、監査のログ、暗号、秘密の保存に触れる PR に `security:sensitive` のラベルを付け、Dev のテックリードとセキュリティの担当の承認を必須にし、エージェントは承認しないとした。各領域の文書は、対象の範囲を挙げた（共有の全て、コンパイラの段 2〜5、検索の問い合わせの組み立て、レポートのコンパイル、変更のイベントの判定、複製の Worker、監査の全て、認証の全て、計測器の差し込み口など）。

ラベルを人が付けると、付け忘れる。rebuilds の他の題材（Auth0 の ADR-0065）は、パスで自動で付ける形を決めた（[auth0 の ADR-0065](../../../auth0/docs/decisions/0065-security-sensitive-change-flow.md)）。

## Options

1. **CODEOWNERS とパスの規則でラベルを自動で付け、外すのはセキュリティの担当だけにする。2 人の承認、追加の CI、組織の単位の段階的なリリースを必須にする**
2. 作成者がラベルを付ける
3. 全ての PR を 2 人の承認にする

## Decision

1 を採用する。

- パスの規則（開発リポジトリの `.github/security-paths.yml`）：`packages/access/**`（判定、閉包、共有の行、参照の評価器）、`packages/compiler/{bind,authz,sharing,plan}/**`、`packages/search/query/**`、`packages/reports/compile/**`、`packages/events/authz/**`、`services/worker/cross-org/**`、`packages/audit/**`、`packages/auth/**`、`packages/crypto/**`、`packages/limits/meter/**`、`services/code-runner/**`、`infra/**/{iam,kms,scp,network}/**`、全てのマイグレーションの RLS の方針。
- 規則に当たる PR にはラベルを自動で付ける。当たらない PR でも、PR のテンプレートの問い（漏えいの経路を足すか、判定を変えるか、秘密に触れるか）に「はい」と答えたら付ける。外せるのはセキュリティの担当だけ。
- 承認：Dev のテックリードとセキュリティの担当の 2 人。作成者（エージェントに指示した人を含む）は承認者になれない。エージェントの承認は数えない（GitHub の必須のレビューを、人のチームだけにする）。
- 追加の CI：性質ベーステストを PR で 1 万通り（通常は 1,000）、漏えいの経路のテストを全て、秘密の走査、依存の脆弱性の検査を Critical・High で失敗。
- マージの後：アクセスの判定を変える変更は、フラグの裏に置き、影の実行（[ADR-0063](0063-org-staged-release-and-shadow-evaluation.md)）で新旧を比べてから、組織の単位で広げる。
- ロールバックの PR は、2 人目の承認を事後（24 時間以内）でよい。
- 2 は付け忘れる。3 は、承認者が足りず、全ての変更が遅くなる。

## Consequences

- 良くなること：
  - 付け忘れがなく、判定と秘密に触れる変更を必ず 2 人が見る。
  - 判定の変更が、本番で新旧を比べてから広がる。
- 引き受けるコスト：
  - セキュリティの担当が承認の待ちになりやすい。パスの規則を狭く保ち、四半期ごとに見直す。
  - 人数が足りない時は、[process.md](../../../../docs/process.md) の「兼務と自己承認」に従い、事後の確認を Epic の完了までに行う。

## Confirmation

- CI：パスの規則に当たる PR にラベルがない時、失敗する。
- GitHub の設定の検査：`security:sensitive` の PR の必須のレビューが 2 人で、コードオーナーにセキュリティのチームが入っている。
- 四半期ごとに、ラベルのない PR の標本 20 件をセキュリティの担当が見直し、付けるべきだった PR があればパスの規則を足す。

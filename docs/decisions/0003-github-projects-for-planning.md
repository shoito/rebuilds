---
status: accepted
date: 2026-09-26
---

# ADR-0003: 計画と進み具合は GitHub Projects で持ち、仕様の正本はリポジトリに置く

## Context

Epic・Story の計画、優先度、イテレーション、担当、判断待ちを、チーム（人間とエージェント）で共有する場所が必要になった。

一方、[ADR-0001](0001-adopt-ai-native-lifecycle.md) で、仕様の正本はリポジトリの文書（`spec.md`、ADR）と決めている。プロジェクト管理の道具に仕様や状態を二重に持つと、どちらが正しいかわからなくなる。

## Options

1. **GitHub Projects**（Issue と PR を集め、項目とビューで管理する）
2. **外部の道具**（Linear、Jira など）
3. **リポジトリの Markdown だけ**（`roadmap.md` と frontmatter）

## Decision

1 を採用する。詳細は [project-management.md](../project-management.md) にある。

- **正本を分ける。**
  - 仕様の中身と変更の状態は、リポジトリに置く。
  - 計画の属性（優先度、イテレーション、担当、期日）は、Projects に置く。
  - 承認は、PR のレビューで行う。
- **成果物から決まる項目は、人に書かせない。** Stage（process.md の段）・Change・Rollout は、GitHub Actions が `spec.md` の frontmatter、PR の状態、フラグの段階から写す。
- **Story と変更フォルダを 1 対 1 にする。** `spec.md` の frontmatter の `issue` でつなぎ、CI で欠けを検出する。
- **Issue の種類は、当面ラベル（`type:*`）で表す。** Issue types は Organization でしか使えないため。Organization へ移ったら置き換える。
- 2 は、計画の機能で勝る。ただし、コード・PR・CI と別の場所になり、エージェントの権限の管理も増える。
- 3 は、優先度やイテレーションの頻繁な変更が PR の往復になり、手で管理する一覧が衝突しやすい（process.md の「衝突の防止」）。

## Consequences

- 良くなること：
  - 計画と、コード・PR・CI が同じ場所でつながる。
  - 状態の二重管理がない。
  - エージェントへの依頼（`agent:ready`）と、判断待ち（`needs:*`）が見える。
- 引き受けるコスト：
  - Projects の項目を更新するワークフローを、自分で作って保守する。
  - 個人のリポジトリでは、Issue types が使えない。Sub-issues が使えるかは未検証。

## Confirmation

- CI（`change-link`）：変更フォルダの `spec.md` に `issue` がない、または Story でない Issue を指していたら失敗させる。
- 週次のレポートで、Stage と `spec.md` の `status` の食い違いが 0 件であることを確かめる。

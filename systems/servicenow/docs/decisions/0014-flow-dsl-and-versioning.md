---
status: accepted
date: 2026-09-28
---

# ADR-0014: フローは決まったノードと式の言語だけの JSON の文書で書き、公開すると不変の版になる。実行は開始したときの版に固定し、移し替えない

詳細は [workflow-engine.md](../architecture/workflow-engine.md) の 3 節。

## Context

[ADR-0004](0004-workflow-and-sla-engine.md) は、フローの定義を版付きの不変の文書にし、実行を開始したときの版に固定すると決めた。[AGENTS.md](../../AGENTS.md) は、公開したフローの定義を変えず、実行中のフローは開始したときの版で最後まで進むことを求める。[ADR-0001](0001-platform-and-stack.md) は、テナントに任意のコードを書かせず、条件と式を副作用のない式の言語で書くと決めた。

本家は、トリガー・アクション・サブフロー・条件でフローを組む（[Flows, subflows, and actions reference](https://www.servicenow.com/docs/bundle/yokohama-build-workflows/page/administer/flow-designer/reference/flow-designer-reference.html)、2026-09-28 に確認）。旧来のワークフローでは、新しい版を公開しても動いている実行は影響を受けない（[Overview: Workflow Versioning](https://support.servicenow.com/kb?id=kb_article_view&sysparm_article=KB0538526)、2026-09-28 に検索の結果の抜粋で確認。Flow Designer で同じかは未検証）。本家の上限の既定値は、ループ 1,000、フローのアクション 50 など（[Flow Designer system properties](https://www.servicenow.com/docs/bundle/washingtondc-build-workflows/page/administer/flow-designer/reference/flow-designer-system-properties.html)、2026-09-28 に確認）。

決めることは次のとおり。

- ノードの種類と、ループの書き方。
- 動いている実行を新しい版に移すか。
- サブフローの版をいつ決めるか。

## Options

### ループ

1. **後ろ向きの辺を禁止し、繰り返しは上限のある `for_each` だけ**
2. 任意のグラフ（後ろ向きの辺を許す）と、実行の時のステップの上限

### 版の移し替え

- a. **移さない。取り消して始め直す**
- b. 対応表（古いノード → 新しいノード）で移す

### サブフローの版

- x. **呼ぶ側の公開の時点に固定する**
- y. 呼ぶ時点の有効な版を使う

## Decision

1、a、x を採用する。

- 文書は、トリガー、入力、変数、ノード（最大 200）、開始、失敗のときのノード、実行の主体、書き込むテーブルの宣言を持つ。ノードは 16 種（分岐、変数、読む、作る、更新する、まとめて更新する、タスク、承認、通知、Webhook、長さの待ち、時刻の待ち、条件の待ち、繰り返し、サブフロー、終わり）に限る。
- 公開の時に、DT-FLOW-001（到達、ループ、式の型、書き込みの宣言、条件の待ちの期限、入れ子、自動の承認の禁止）で検証し、内容のハッシュを持つ `flow_version` を作る。`flow_version` は変えない。
- 実行は `flow_version_id` に固定する。移し替えはしない。
- サブフローの呼び出しは、呼ぶ側の公開の時点のサブフローの版に固定する。
- DSL の意味を変えるエンジンの変更は、`engine_schema` を上げ、古い版は古い意味で動かす。

2 を採らない理由：停止を上限だけで守ることになり、上限に当たった実行が途中で失敗する。業務のフローで要る繰り返しは「一覧の要素ごと」がほとんどで、`for_each` で書ける。

b を採らない理由：対応表の誤りで、承認の途中の実行が別の段に飛ぶ。移し替えの正しさを試す組み合わせが大きい。移したい場面（誤りの修正）は、取り消して始め直す一括の操作で足りる。

y を採らない理由：サブフローの公開で、呼ぶ側のすべての動いている実行の振る舞いが変わる。版の固定（AGENTS.md）を、サブフローで破ることになる。

## Consequences

- 良くなること：
  - 実行が動かすノードは、開始したときの版のノードだけで、性質として試せる。
  - すべてのフローが停止する（ノードの数と繰り返しの上限から、動くノードの数に上限がある）。
- 引き受けるコスト：
  - 動いている実行が多いとき、誤りの修正に「取り消して始め直す」が要る。承認の途中の実行は、承認を取り直すことになる。
  - サブフローを直したら、呼ぶ側を公開し直す。画面で「古いサブフローを呼んでいるフロー」を示す。
  - エンジンの意味の変更のたびに、古い意味のコードを残す。

## Confirmation

- 決定表 DT-FLOW-001。
- 性質ベーステスト PROP-FLOW-004（版の固定）、PROP-FLOW-006（停止）。
- DB のロールの検査：`flow_version` に `UPDATE` を与えない。

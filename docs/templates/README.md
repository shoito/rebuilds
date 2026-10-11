# Templates

各成果物のテンプレート。使い方と、どの段で作るかは [process.md](../process.md) にある。

| テンプレート | 作る場所 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | `systems/<name>/docs/intent.md`、`changes/<id>/intent.md` | PM |
| [architecture.md](architecture.md) | `systems/<name>/docs/architecture/README.md` | Dev |
| [architecture-area.md](architecture-area.md) | `systems/<name>/docs/architecture/<area>.md` | Dev |
| [design-log.md](design-log.md) | `systems/<name>/docs/architecture/design-log.md` | Dev |
| [quality.md](quality.md) | `systems/<name>/docs/quality.md` | QA |
| [change-quality.md](change-quality.md) | `changes/<id>/quality.md`（リスクの高い変更のみ） | QA |
| [roadmap.md](roadmap.md) | `systems/<name>/docs/roadmap.md` | PM |
| [spec.md](spec.md) | `specs/<capability>/spec.md`（正本）、`changes/<id>/spec.md`（差分） | PM、QA |
| [plan.md](plan.md) | `changes/<id>/plan.md` | Dev |
| [adr.md](adr.md) | `docs/decisions/`、`systems/<name>/docs/decisions/` | Dev |
| [runbook.md](runbook.md) | `systems/<name>/docs/runbooks/<slug>.md` | Ops |

テンプレートの中のリンクは、コピーした先で解決される相対パスで書いてある。

## 図の決まり

設計の文書の図は Mermaid で書く。ASCII の図は、Mermaid で描けない配置（画面の割り付けなど）に限る。

| 書くもの | 図 |
| --- | --- |
| 状態と遷移（遷移の決定表を持つものを含む） | `stateDiagram-v2` |
| 登場する者が 3 つ以上の流れ、失敗と回復の経路 | `sequenceDiagram` |
| 期限、有効日付、遅れの予算など、時間の軸が要るもの | `gantt`、または時刻を並べた `sequenceDiagram` |
| 構成、処理の順序、判定の流れ | `flowchart` |
| 表と関係 | `erDiagram`（全体の図は関係の線だけにし、列は領域の図に書く） |
| Epic の依存 | `flowchart`（roadmap.md） |

- 1 枚の図の箱は 15 個までにする。超えるときは、概要の図と詳細の図に分ける。
- 図は本文の代わりではない。図の前後に、図が何を示すかを 1〜2 文で書く。
- 表と図が同じものを表すとき（遷移の決定表とステートマシンの図など）は、表を正とし、図はその要約にする。食い違ったら表に合わせる。

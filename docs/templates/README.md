# Templates

各成果物のテンプレート。使い方と、どの段で作るかは [process.md](../process.md) にある。

| テンプレート | 作る場所 | 持ち主 |
| --- | --- | --- |
| [intent.md](intent.md) | `systems/<name>/docs/intent.md`、`changes/<id>/intent.md` | PM |
| [architecture.md](architecture.md) | `systems/<name>/docs/architecture/README.md` | Dev |
| [quality.md](quality.md) | `systems/<name>/docs/quality.md` | QA |
| [change-quality.md](change-quality.md) | `changes/<id>/quality.md`（リスクの高い変更のみ） | QA |
| [roadmap.md](roadmap.md) | `systems/<name>/docs/roadmap.md` | PM |
| [spec.md](spec.md) | `specs/<capability>/spec.md`（正本）、`changes/<id>/spec.md`（差分） | PM、QA |
| [plan.md](plan.md) | `changes/<id>/plan.md` | Dev |
| [adr.md](adr.md) | `docs/decisions/`、`systems/<name>/docs/decisions/` | Dev |
| [runbook.md](runbook.md) | `systems/<name>/docs/runbooks/<slug>.md` | Ops |

テンプレートの中のリンクは、コピーした先で解決される相対パスで書いてある。

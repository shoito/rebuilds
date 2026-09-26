# Plan: GitHub の Issue・Projects・App の設定と同期

- Change: 260926-github-project-setup
- Spec: [spec.md](spec.md)
- Status: draft

## 依存

| 変更・作業 | 関係 |
| --- | --- |
| リポジトリを Organization へ移す | **先に必要。** 人が行う（ADR-0003） |
| [ci-pipeline](../260926-ci-pipeline/plan.md) | 先に必要。`change-link` は `ci-gate` の必須のチェックに加える |
| [agent-skills-foundation](../260926-agent-skills-foundation/plan.md) | この変更の後。App と Project を使う |

## Files that change

パスはリポジトリのルートからの相対パス。

- `.github/labels.yml`、`.github/ISSUE_TEMPLATE/{intent,story,bug,spike}.yml`、`.github/ISSUE_TEMPLATE/config.yml`（新規）
- `.github/workflows/{labels-sync,project-fields-sync,change-link,stage-sync,agent-ready-guard}.yml`（新規）
- `tools/project/setup.ts`、`tools/project/verify.ts`、`tools/project/backfill-issues.ts`、`tools/project/README.md`（新規）
- `tools/project/test/`（新規）：Stage の決め方の表駆動テスト、冪等の性質ベーステスト
- `.github/CODEOWNERS`：Organization のチームに置き換える

## Order of work

- [ ] 1. 人の作業：Organization へ移す。App を作り、Organization にインストールする。Issue types を作る（`tools/project/README.md` の手順。REQ-DLV-016・017）
- [ ] 2. `labels.yml`・`labels-sync`（REQ-DLV-017）
- [ ] 3. Issue Forms（REQ-DLV-018）
- [ ] 4. `tools/project/setup.ts` で Project の項目とビューを作る。`verify.ts` で組み込みのワークフローを検査する（REQ-DLV-019）
- [ ] 5. `project-fields-sync`（REQ-DLV-019）
- [ ] 6. `change-link`（REQ-DLV-020、DT-DLV-006。1 行目は警告）
- [ ] 7. `stage-sync`（REQ-DLV-021、DT-DLV-007、PROP-DLV-005）
- [ ] 8. `agent-ready-guard`（REQ-DLV-022）
- [ ] 9. `backfill-issues.ts` で、既存の変更に Issue を割り当てる（REQ-DLV-023）
- [ ] 10. DT-DLV-006 の 1 行目を失敗に切り替える

## Risks

- **画面でしか設定できない部分の漂流。** `verify.ts` を週次で走らせ、食い違いを Issue にする。
- **App のトークンの権限が広すぎる。** 権限は REQ-DLV-016 の一覧に限り、`verify.ts` で App の権限も読み出して検査する。
- **Stage の同期と人の操作がぶつかる。** Stage は Actions だけが変える項目であることを、Project の項目の説明にも書く。

## Proof

| 証明すること | 要件 / 性質 | 方法 |
| --- | --- | --- |
| App でマージ・承認ができない | REQ-DLV-016 | テスト用の Organization のリポジトリで実際に試す |
| ラベルが定義どおりで、未定義は警告される | REQ-DLV-017 | ワークフローの結合テスト（テスト用のリポジトリ） |
| フォームで Issue type とラベルが付く | REQ-DLV-018 | テスト用のリポジトリで起票して確かめる |
| Project に加わり、System と `needs:pm` が付く | REQ-DLV-019 | 結合テスト |
| つなぎの検査の各行 | REQ-DLV-020、DT-DLV-006 | 表駆動テスト（5 行） |
| Stage の決め方の各行 | REQ-DLV-021、DT-DLV-007 | 表駆動テスト（6 行） |
| Stage は成果物だけで決まり、冪等 | PROP-DLV-005 | 性質ベーステスト（成果物の状態と、手での書き換えの列を生成する） |
| `agent:ready` の保護 | REQ-DLV-022 | 結合テスト |
| 既存の変更への割り当て | REQ-DLV-023 | ドライランの出力の確認と、テスト用のリポジトリでの実行 |

フラグ：使わない（開発の道具で、本番の振る舞いを変えないため）。

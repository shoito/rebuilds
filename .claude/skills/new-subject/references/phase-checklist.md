# 工程ごとのチェックリスト

工程に入ったら、その工程の節だけを読む。どの工程も、終わりに `npm run check` を通してからコミットする。コミットの題は既存の題材に揃える（例：`<Subject>: add foundation (intent, architecture overview, ADRs 0001-0010, quality, roadmap, runbooks)`）。

## 工程 1：基礎

テンプレートは `docs/templates/`。手本の題材の同じファイルと並べて書く。

- [ ] `systems/<name>/AGENTS.md`：最初に読むもの、題材に固有の規則（本家の実装と名前、論点ごとの不変条件、お金、個人のデータと可視性、運用と入力）、このリポジトリでの規則
- [ ] `systems/<name>/CLAUDE.md`：`AGENTS.md` への symlink
- [ ] `docs/README.md`：文書の一覧と持ち主、これから作る文書
- [ ] `docs/intent.md`：Problem、Proposed outcome（MVP に含める・後の Epic・守るべき振る舞い・成功の基準）、Affected users and systems、Constraints、Non-goals、Open questions（法務の確認待ち L1〜、選定・計測で決めるもの）、出典
- [ ] `docs/architecture/README.md`：テンプレートの 1〜8 節すべて
  - [ ] 1.2 コンテナは Mermaid で、箱 15 個まで
  - [ ] 1.3 主要な流れに `sequenceDiagram` を 2〜3 本
  - [ ] 1.4 本家の形に出典
  - [ ] 2.1 費用のモデル
  - [ ] 4 節の表に「エージェントにとっての理由」の列
  - [ ] 7 節の表で、全領域に ADR の番号の範囲を割り当てる
- [ ] `docs/decisions/`：核の決定の ADR（10 本前後）。一覧は `npm run adr-index`
- [ ] `docs/quality.md`：利用者の画面があればアクセシビリティの行
- [ ] `docs/roadmap.md`：Epic と Story、エージェントに任せないこと（理由と、誤りを止める仕組みも）、延期の一覧。Epic の依存を書いたら DAG の図
- [ ] `docs/runbooks/`：`README.md`（SLI・SLO、アラートと手順の対応）と共通の 3 本（deploy-and-rollback、disaster-recovery、incident-response）。題材に固有の事故があれば、その手順も

## 工程 2：領域の文書

- [ ] README の 7 節の全行について、`docs/templates/architecture-area.md` の形で 1 ファイル
- [ ] 各ファイルに「本家の形（確かめたこと）」と出典・確認日
- [ ] 状態・3 者以上の流れ・時間の軸に図
- [ ] 中心の領域に、数字の入った「例」の節
- [ ] ADR は 7 節の範囲の中で採番（`adr` の Skill）
- [ ] 末尾に Story の候補と、quality.md・runbooks・data-model への項目

## 工程 3：統合と事実の確認

- [ ] 領域の文書の間の食い違い（同じ値、同じ表、同じ責務）を洗い出して解く
- [ ] 解いた経緯を `architecture/design-log.md` に `## YYYY-MM-DD：統合` として書き、今の結論を各文書に反映する
- [ ] 本家の値を公式の資料で確かめ、出典と確認日を付ける。確かめられないものは「未検証」
- [ ] 判断が要るものは intent の Open questions へ
- [ ] ルートの `README.md` の題材の表の状態を「設計済み」に

## 工程 4：データモデル

- [ ] `architecture/data-model.md`：規約、表の目録（列・制約・索引・RLS・分割・保持・量）、ER 図、主要な道筋、横断の不変条件、Aurora の外の置き場所
- [ ] `architecture/data-model/`：領域ごとの表と ER 図
- [ ] 全体の ER 図は関係の線だけ。道筋は `flowchart` か `sequenceDiagram`
- [ ] 決めたことを `design-log.md` に `## YYYY-MM-DD：データモデル`

## 工程 5：前提知識の資料と索引

- [ ] `docs/primer/index.html`：`docs/primer/AUTHORING.md` に従う（GA のタグ、favicon、`og:site_name`、節は 13〜22 個、確認の問いは 3〜6 個、用語集）
- [ ] 表紙の直後に「この題材から学べること」の節（PM・Dev・QA・Ops・AI エージェントごとに 2〜3 項目、各項目に設計の文書へのリンク）
- [ ] 資料の数値を設計の文書と照らし合わせる
- [ ] ルートの `index.html` のカードと、`README.md` の題材の表に足す。並び順を揃える
- [ ] `docs/patterns.md` のテーマの表か「題材に固有の論点」に足す。読む順の道筋と「ロールから探す」に入れるかを考える

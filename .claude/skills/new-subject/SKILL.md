---
name: new-subject
description: rebuilds に新しい題材（再構築する SaaS）の設計を立ち上げる。基礎（intent・architecture・ADR・quality・roadmap・runbooks）→ 領域の文書 → 統合と事実の確認 → データモデル → 前提知識の資料と索引への追加、の 5 つの工程を、工程ごとの完了の条件と検査つきで進める。「〇〇を題材に追加して」「新しい題材を始めて」のときに使う。
---

# 新しい題材を立ち上げる

既存の 21 題材は、どれもこの 5 つの工程で作った（コミットの履歴の「<題材>: add foundation」「add area design docs」「integrate area designs, fact-check」「complete data model」「add primer」）。工程ごとにコミットし、工程の終わりに必ず `npm run check` を通す。

## 始める前に

1. 読むもの：ルートの `AGENTS.md`、`docs/process.md`、`docs/templates/README.md`（図の決まり）、`docs/patterns.md`、[ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)（本家の名前を使わない）、[ADR-0007](../../../docs/decisions/0007-no-reuse-of-original-implementation.md)（核に本家の実装を使わない）。
2. 手本にする題材を 1 つ選び、その `AGENTS.md`・`docs/README.md`・`architecture/README.md` を読む。新しい題材ほど型が整っている（例：`systems/airbnb/`、`systems/mercari/`）。
3. `docs/patterns.md` で、この題材の論点がほかの題材のどこで設計済みかを調べる。**設計済みのものは設計し直さず、リンクして引き継ぐ**（台帳は Stripe・Mercari、時間は Google Calendar・Workday など）。
4. 次をユーザーに確かめる。決まっていなければ推奨の既定案を示して確かめる。
   - 題材の名前（`systems/<name>/` の英小文字）と、主な論点の 3〜5 個
   - MVP の範囲（日本向けか、規模の段階 S1 の大きさ）
   - 法令が絡むか（絡むなら「法務の確認待ち」を L 番号で持つ）

## 工程 1：基礎

作るもの（テンプレートは `docs/templates/`）：

- `systems/<name>/AGENTS.md`（`CLAUDE.md` は `AGENTS.md` への symlink）：最初に読むもの、題材に固有の規則（本家の実装と名前、論点ごとの不変条件、お金、個人のデータ、運用）、このリポジトリでの規則
- `docs/README.md`：文書の一覧と持ち主
- `docs/intent.md`：Problem、Proposed outcome（MVP に含める・後の Epic・守るべき振る舞い・成功の基準）、Affected users、Constraints、Non-goals、Open questions（法務の確認待ち L1〜、選定・計測で決めるもの）、出典
- `docs/architecture/README.md`：`architecture.md` のテンプレートの 1〜8 節をすべて。1.2 コンテナ（箱 15 個まで）と 1.3 主要な流れ（シーケンス図）、2.1 費用のモデル、4 節の「エージェントにとっての理由」の列を省かない。7 節の表で、領域ごとに ADR の番号の範囲を割り当てる
- `docs/decisions/`：題材の核の決定を ADR-0001〜（10 本前後）。`README.md` の一覧は `npm run adr-index` で生成する
- `docs/quality.md`（利用者の画面があればアクセシビリティの行を必ず持つ）、`docs/roadmap.md`（Epic と Story）、`docs/runbooks/README.md`（SLI・SLO）と共通の runbook

完了の条件：`npm run check` が通る。README の 7 節に、全領域の文書の行と ADR の範囲がある。

## 工程 2：領域の文書

- README の 7 節の表の領域ごとに、`docs/templates/architecture-area.md` の形で 1 ファイルを書く。並行して進めるなら、領域ごとにサブエージェントに任せてよい。その場合も、下の「エージェントに任せるときの約束」を指示に入れる。
- ADR は、7 節で割り当てた範囲の中で採番する（`adr` の Skill）。
- 状態を持つもの・登場する者が 3 つ以上の流れ・時間の軸が要るものには、図を付ける。
- 数字の入った「例」の節を、中心の領域に 1 つ以上置く。

完了の条件：`npm run check` が通る。全領域の文書が揃い、7 節の表と一致している。

## 工程 3：統合と事実の確認

- 領域の文書の間の食い違い（同じ値・同じ表・同じ責務が違って書かれている）を洗い出して解く。解いた経緯は `architecture/design-log.md` に `## YYYY-MM-DD：統合` として書き、今の結論は各文書に反映する。
- 「本家の形（確かめたこと）」の値を、公式の資料で確かめ、出典と確認日を付ける。確かめられないものは「未検証」と書く。
- 判断が要るもの（範囲・法令の解釈）は決めずに、intent の Open questions に残す。

完了の条件：`npm run check` が通る。ルートの `README.md` の題材の表の「状態」を「設計済み」にできる。

## 工程 4：データモデル

- `architecture/data-model.md`（規約、表の目録、ER 図、主要な道筋、横断の不変条件）と `architecture/data-model/` を書く。全体の ER 図は関係の線だけにし、列は領域の図に書く。
- 道筋（処理の順序）は `erDiagram` ではなく `flowchart` か `sequenceDiagram` で描く。
- 決めたことは `design-log.md` に `## YYYY-MM-DD：データモデル` として書く。

## 工程 5：前提知識の資料と索引

- `systems/<name>/docs/primer/index.html` を `docs/primer/AUTHORING.md` に従って書く（GA のタグ、favicon、`og:site_name` を含む）。数値は設計の文書と照らし合わせる。
- ルートの `index.html` の題材のカードと、`README.md` の題材の表に足す。並び順を揃える。
- `docs/patterns.md` の該当するテーマの表か「題材に固有の論点」に足す。

完了の条件：`npm run check` が通る。

## エージェントに任せるときの約束

サブエージェントに工程の一部を任せるときは、次を指示に必ず入れる（2026-10-10 の見直しで、指示から漏れると品質がばらついたもの）。

- 編集してよいファイルを限る。並行するほかのエージェントのファイルに触れない。git の状態を変える操作をしない。
- 図の中身は、本文・表・ADR から読み取れることに限る。本文と表が食い違ったら、表を正として描き、食い違いは直さずに報告する。
- 新しい設計の判断は `status: proposed` の ADR にする。範囲と法令の判断はしない。
- 「ステートマシン」「バージョン」と書く（`AGENTS.md` の「言語」）。
- 作業の終わりに `npm run check -- --files <変えたファイル>` を通す。

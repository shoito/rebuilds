---
name: new-subject
description: rebuilds に新しい題材（再構築する SaaS）の設計を立ち上げる。基礎（intent・architecture・ADR・quality・roadmap・runbooks）→ 領域の文書 → 統合と事実の確認 → データモデル → 前提知識の資料と索引への追加、の 5 つの工程を、工程ごとの完了の条件と検査つきで進める。「〇〇を題材に追加して」「新しい題材を始めて」のときに使う。
---

# 新しい題材を立ち上げる

既存の 21 題材は、どれも同じ 5 つの工程で作った。工程ごとにコミットし、工程の終わりに必ず `npm run check` を通す。

## 始める前に

1. 読むもの：ルートの `AGENTS.md`、`docs/process.md`、`docs/templates/README.md`（図の決まり）、`docs/patterns.md`、リポジトリ共通の ADR-0006（本家の名前を使わない）と ADR-0007（核に本家の実装を使わない）。
2. 手本にする題材を 1 つ選び、その `AGENTS.md`・`docs/README.md`・`architecture/README.md` を読む。新しい題材ほど型が整っている（例：`systems/airbnb/`、`systems/mercari/`）。
3. `docs/patterns.md` で、この題材の論点がほかの題材のどこで設計済みかを調べる。**設計済みのものは設計し直さず、リンクして引き継ぐ**。
4. 次をユーザーに確かめる。決まっていなければ推奨の既定案を示す。
   - 題材の名前（`systems/<name>/` の英小文字）と、主な論点の 3〜5 個
   - MVP の範囲（対象の国、規模の段階 S1 の大きさ）
   - 法令が絡むか（絡むなら「法務の確認待ち」を L 番号で持つ）

## 工程

| 工程 | 作るもの | 終わりの目安 |
| --- | --- | --- |
| 1. 基礎 | AGENTS.md、intent、architecture/README、核の ADR、quality、roadmap、runbooks | README の 7 節に全領域と ADR の範囲がある |
| 2. 領域の文書 | README の 7 節の全行 | 全領域の文書が揃い、7 節と一致している |
| 3. 統合と事実の確認 | 食い違いの解消、design-log、本家の値の出典 | 題材の状態を「設計済み」にできる |
| 4. データモデル | data-model.md と data-model/ | 全表が目録にあり、ER 図と道筋の図がある |
| 5. 資料と索引 | primer、index.html、README の表、patterns.md | サイトから題材の資料に行ける |

工程に入ったら、[references/phase-checklist.md](references/phase-checklist.md) のその工程の節を読み、チェックリストを満たす。

## 判断の決まり

- 新しい設計の判断は `status: proposed` の ADR にする（`adr` の Skill）。承認はしない。
- MVP の範囲と法令の解釈は決めない。選択肢と推奨を示し、intent の Open questions に残す。
- 本家の振る舞い・数値には出典と確認日を付ける。確かめられないものは「未検証」と書く。
- 本文と表が食い違ったら、表を正とし、食い違いをユーザーに報告する。

## サブエージェントに分けるとき

工程 2 の領域の文書や、図の追加は、領域・題材ごとにサブエージェントに分けて並行で進めてよい。指示は [references/agent-brief.md](references/agent-brief.md) の「共通の約束」に、作業ごとの指示を足して作る。最後に自分で `npm run check` を全体に通し、報告された食い違いをまとめてユーザーに伝える。

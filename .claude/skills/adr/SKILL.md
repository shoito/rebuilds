---
name: adr
description: rebuilds で ADR（設計の決定の記録）を起票・更新する。題材の領域ごとの番号の範囲から採番し、proposed で書き、一覧を生成し直し、範囲や法令の判断を intent の Open questions へつなぐ。「ADR を書いて」「この決定を ADR にして」や、設計の作業の中で新しい決定が生じたときに使う。
---

# ADR を起票する

決まりの正本は `docs/process.md` の 9 節と `docs/templates/adr.md`。ここには、その手順と、間違えやすい点を書く。

## 置き場所と番号

- リポジトリ全体に関わる決定は `docs/decisions/`、題材の決定は `systems/<name>/docs/decisions/`。
- 題材の `architecture/README.md` の 7 節（領域の文書）の表に、領域ごとの番号の範囲がある。その範囲の中の空いている番号を使う。
- 範囲を使い切っていたら、その題材の最大の番号 + 1 を使い、7 節の表の該当する行に「範囲の外：NNNN」と書き足す。
- 同じ番号がないことは `npm run check` が確かめる。並行するブランチで同じ番号を取ったら、後からマージする側が採番し直す。
- ファイル名は `NNNN-<英小文字の kebab-case>.md`。

## 書き方

- frontmatter：`status: proposed`、`date: <今日>`。**エージェントは `accepted` にしない**。承認はロールの持ち主（人）がする。
- 後の検証や規模の段階を待ってから承認するもの（S2・S3 の計画、PoC の結果しだいのもの）は、`decide_after: <判断する時点>` を足す。今判断が要るものと分けて一覧に出る。
- 見出しは `# ADR-NNNN: <決定の名前>` で、60 字まで。決定の中身は見出しに書かず Decision に書く（見出しは一覧の表にそのまま出る）。
- Options は 2〜4 個。推奨の案を Decision で選び、退けた案の理由を書く。
- 既存の ADR・領域の文書・ほかの題材の設計と矛盾しないかを読んで確かめ、関係する ADR にリンクする。ほかの題材で設計済みのことは、設計し直さずにリンクする（`docs/patterns.md`）。
- Confirmation に、守られていることをどう確かめるか（テスト、性質、決定表、lint、レビュー）を書く。

## 判断をエージェントが決めないもの

次のどれかに当たるときは、ADR に選択肢と推奨を書いたうえで、その題材の `intent.md` の Open questions に「PM の判断待ち」として 1 項目足し、`docs/open-decisions.md` の 3 節にも行を足す。

- MVP の範囲に入れるか（本家からの移行、データの書き出し、新しい言語など）
- 法令の解釈。枠組みだけを書き、結論を書かない。「法務の確認待ち」とし、intent の L 番号の末尾に足す。

## 確定した ADR を変えるとき

- `accepted` の ADR は書き換えない。新しい ADR を書き、古いほうを `superseded by ADR-NNNN` にする。
- 例外：題材の最初の設計の間（開発リポジトリで実装が始まる前）は直してよい。決定を覆す直しには `> YYYY-MM-DD の注記：…` を残す（`docs/process.md` 9 節）。

## 終わりに

```bash
npm run adr-index
npm run open-decisions
npm run check
```

一覧（`decisions/README.md`）と、`docs/open-decisions.md` の承認待ちの表は手で編集しない。`accepted` にしたら `npm run open-decisions` で表から消え、`docs/open-decisions.md` の 5 節に、合わせて直す箇所が残っていないかを見る。`npm run adr-index` が各 ADR の frontmatter と見出しから生成する。題材の `architecture/README.md` の 5 節（主な決定）に載せるかは、その表の前書きに従う（「どれも accepted」とある表には proposed を載せない）。

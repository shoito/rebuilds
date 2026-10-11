# 作業のサブエージェントへの指示の雛形

題材の文書を、サブエージェントに分けて書かせる・直させるときの雛形。2026-10-10 の見直し（図の追加、README の整理、漏れている観点の追加）で使い、指示の漏れによるばらつきをなくした形である。

## 渡し方

- 長い指示は、作業用のディレクトリ（scratchpad）に 1 つのファイルとして書き、各エージェントには「担当の題材」と「そのファイルを読んでから始めること」だけを渡す。指示の本文を入れ忘れて起動する事故を防げる。
- 作業用のファイルは、エージェントごとに別のサブディレクトリを使わせる（同じ名前のファイルを上書きし合った例がある）。
- 指示は英語、報告は日本語にする。

## 共通の約束（どの作業の指示にも入れる）

```text
Repo: {repo path}. Documents are Japanese.
Edit ONLY files under systems/{your subjects}/ (and the extra files named below). Other agents edit other subjects concurrently — never touch anything else. Do not run git commands that change state (no commit, stash, checkout).

Read first: root AGENTS.md (「言語」), docs/templates/README.md (「図の決まり」), the subject's AGENTS.md, and {作業に関係するテンプレートや文書}.

Rules:
- Every node, edge, label, number and sentence you add must be traceable to the existing prose, tables or ADRs. Do not invent behavior.
- If prose and a table (or two documents) disagree, do NOT fix it silently. Follow the table (the source of truth) for what you draw or write, and report the discrepancy with file:line.
- New design decisions go into a new ADR with `status: proposed` (follow the adr skill). Scope decisions (MVP or not) and legal interpretations are not yours: present options with a recommendation and add an item to intent.md Open questions (PM の判断待ち / 法務の確認待ち).
- Write 「ステートマシン」 (never 状態機械) and 「バージョン」 (not 版, except fixed names).
- Mermaid: quoted labels ["..."], ASCII ids, no `;` or `#` in labels, <br/> for line breaks, declare sequenceDiagram participants, ≤15 nodes per diagram. Replace an equivalent ASCII diagram instead of keeping both.
- Match the surrounding Japanese style (short sentences, same vocabulary).
- When done, run: npm run check -- --files <every file you changed>   and fix what it reports.

Report back (Japanese, concise): files changed and what was added (file:section); discrepancies found but not fixed (file:line); anything skipped and why.
```

## 作業ごとに足す指示

### 領域の文書を書く（工程 2）

```text
Write docs/architecture/{area}.md following docs/templates/architecture-area.md. Scope and ADR number range: the row for {area} in docs/architecture/README.md §7. Reuse designs from other subjects listed in docs/patterns.md by linking, not re-designing. Include at least one worked example with concrete numbers. Add Story candidates and the items for quality.md, runbooks and data-model at the end.
```

### 図を足す

```text
Targets (paths under systems/<name>/docs/architecture/): {ファイル・節・図の種類の一覧}
Place each diagram right where the concept is explained, with 1–2 sentences before it saying what it shows. Where a decision table (DT-*) exists, the table stays the source of truth and the diagram summarizes it.
roadmap.md: add an Epic dependency DAG only if dependencies are explicitly stated.
```

### 漏れている観点を足す

```text
Targets: {題材ごとの観点の一覧。grep で無いことを確かめたもの}
Re-check each gap before writing; if it already exists, report and skip. Keep additions proportionate: an ADR (~40–90 lines) + a section in the relevant area doc + a quality.md row + roadmap Story candidates where appropriate. Accessibility needs no ADR unless a real design choice arises.
```

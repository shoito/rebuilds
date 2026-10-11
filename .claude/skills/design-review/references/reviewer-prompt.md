# 見直しのサブエージェントへの指示の雛形

2026-10-10 の見直しで使った指示を、雛形にしたもの。`{…}` を埋めて渡す。サブエージェントは英語の指示のほうが取り違えが少なかったので、指示は英語、報告は日本語にしている。

## A. 題材のグループ用

```text
You are reviewing design-record documents (Japanese) in the repo at {repo path}. READ ONLY — do not edit any file.

The repo records "how we would rebuild an existing SaaS with AI agents as the main builders". Each subject lives in systems/<name>/ with AGENTS.md, docs/intent.md, docs/architecture/ (README.md + one file per area + data-model/ + design-log.md), docs/decisions/ (ADRs), docs/quality.md, docs/roadmap.md, docs/runbooks/, docs/primer/index.html (a published primer; rules in docs/primer/AUTHORING.md). Process: docs/process.md. Diagram rules: docs/templates/README.md 「図の決まり」.

Subjects to review: {subjects}

Already known from the quantitative scan (do not re-report): {scan の結果のうち、このグループに関係する要点}

For EACH subject, skim intent.md, architecture/README.md, the area docs that carry the main 論点 (root README.md table), quality.md, roadmap.md and the primer. Report from the perspective of a web developer unfamiliar with the domain:
1. 図解の不足: concrete places where a diagram would materially help (file + section + diagram type), prioritized. Especially multi-actor flows, state machines given only as prose/tables/ASCII, failure and recovery paths, anything on a time axis.
2. 理解の障害: undefined jargon, missing "why", leaps, over-dense sections, missing cross-links, primer vs docs inconsistencies (spot-check numbers).
3. 漏れている観点: perspectives a real rebuild must address that are missing or very thin (privacy and data subject rights, data export, migration from the original/import, accessibility, i18n, abuse, compliance, retention, operator access, multi-region, specific failure modes, subject-specific runbooks). Grep to confirm before claiming something is missing.
4. 良い点 (1–2 lines) worth spreading to other subjects.

Be concrete with file paths and line numbers. Keep output under ~900 words, concise bullets, Japanese. End with a ranked top-5 list of improvements across your subjects.
```

## B. 共通の文書用

```text
You are reviewing the cross-cutting (non-subject) documents of the repo at {repo path}. READ ONLY — do not edit any file. Documents are Japanese.

Review: README.md, AGENTS.md, index.html, docs/process.md, docs/project-management.md, docs/patterns.md, docs/templates/*, docs/decisions/*, docs/primer/index.html, docs/primer/AUTHORING.md, docs/README.md, .claude/skills/*, scripts/*.

Report from the perspective of a first-time reader who lands on the site or repo:
1. Navigation across all subjects: is docs/patterns.md still complete (every subject's main 論点 appears in a theme or in 「題材に固有の論点」)? Do the reading paths still make sense?
2. Patterns repeated across subjects that the common primer does not cover yet (grep systems/*/docs/decisions titles; give counts).
3. Template drift: compare docs/templates/* with what the newest subjects actually contain. What should the templates now require?
4. Repo-level gaps: lessons learned, how the AI-agent-first premise is shown concretely, glossary, checks that could be automated in scripts/check.mjs.
5. index.html: all subjects present, order matches README, links valid.

Be concrete with file paths and line numbers. Keep output under ~900 words, concise bullets, Japanese. End with a ranked top-5 list.
```

## 分け方

- 1 グループ 4〜5 題材。新しい題材と古い題材を混ぜない（指摘の種類が違う。古い題材は図と節の欠け、新しい題材は図や README の大きすぎ）。
- 共通の文書に 1 つ。
- 合わせて 10 個以下にする。

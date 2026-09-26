---
capability: <capability>
# 以下は差分（changes/YYMMDD-<slug>/spec.md）のときのみ
change: <YYMMDD-slug>
epic: <E1>
status: draft | approved | in-progress | done
---

<!--
正本（specs/<capability>/spec.md）では、見出し「Requirements」の下に要件を並べ、frontmatter は capability だけにする。
差分（changes/YYMMDD-<slug>/spec.md）では、ADDED / MODIFIED / REMOVED の見出しの下に並べる。
MODIFIED と REMOVED には、正本から写した「変更前」の本文を必ず書く。アーカイブ時に CI が正本と照合する（process.md「衝突の防止」）。
決定表・性質も、変更するときは同じ形で書く。
-->

# Spec: <capability または変更名>

## 概要

## ADDED Requirements

### REQ-<CAP>-001: <要件名>

〈事象〉とき、システムは〈振る舞い〉しなければならない。

#### Scenario: <シナリオ名>

- Given
- When
- Then

## MODIFIED Requirements

### REQ-<CAP>-002: <要件名>

#### Before

<正本の本文とシナリオを、そのまま写す>

#### After

<変更後の本文とシナリオ>

## REMOVED Requirements

### REQ-<CAP>-003: <要件名>

- 理由：

#### Before

<正本の本文とシナリオを、そのまま写す>

## Decision Tables

### DT-<CAP>-001: <規則名>

上から順に評価し、最初に一致した行を採用する。

| # | <条件 1> | <条件 2> | → <結果 1> | → <結果 2> |
| --- | --- | --- | --- | --- |
| 1 | | - | | |

## Correctness Properties

### PROP-<CAP>-001: <性質名>

任意の〈入力〉に対して、〈成り立つべきこと〉。

## Design

この変更に固有の設計。横断的なものは architecture.md や ADR に書き、ここからリンクする。

## Open questions

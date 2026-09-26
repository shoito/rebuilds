<!--
正本（specs/<capability>/spec.md）では、見出し「Requirements」の下に要件を並べる。
差分（changes/NNNN-<slug>/spec.md）では、ADDED / MODIFIED / REMOVED の見出しの下に並べる。
MODIFIED には変更後の全文を書く。REMOVED には ID と理由だけを書く。
-->

# Spec: <capability または変更名>

- Capability: <capability>
- Change: <NNNN-slug>（差分のときのみ）
- Status: draft | approved

## 概要

## ADDED Requirements

### REQ-<CAP>-001: <要件名>

〈事象〉とき、システムは〈振る舞い〉しなければならない。

#### Scenario: <シナリオ名>

- Given
- When
- Then

## MODIFIED Requirements

## REMOVED Requirements

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

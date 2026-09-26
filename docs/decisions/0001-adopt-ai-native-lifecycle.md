---
status: accepted
date: 2026-09-26
---

# ADR-0001: AI-Native SDLC を骨格に、正本 spec と変更差分を分けて管理する

## Context

このリポジトリでは、題材ごとに設計ドキュメントと実装コードを置き、実装の大部分を AI エージェントが担う。エージェントに渡す文脈と、人間が判断する地点を、成果物として明確にしておく必要がある。

調べた主な手法は次のとおり。

- Anthropic AI-Native SDLC Playbook：intent → spec → plan
- Kiro：requirements / design / tasks、EARS
- GitHub Spec Kit
- OpenSpec：正本の specs と changes の差分
- AWS AI-DLC

一方で、成果物が多すぎるとレビューが辛くなり、実装と文書がずれていくという批判もある（Böckeler）。

## Options

1. **Kiro 型**：機能ごとに requirements / design / tasks の 3 ファイル
2. **AWS AI-DLC 型**：5 フェーズ・33 ステージの成果物をそのまま使う
3. **Anthropic 型を骨格にした組み合わせ**：intent → spec → plan を骨格にする。spec に Kiro の EARS と要件 ID を入れる。OpenSpec の正本／差分の分離を加える
4. **題材ごとに設計ドキュメント 1 枚**（初回コミットの形）

## Decision

3 を採用する。

- 段ごとに成果物が 1 つずつ（intent / spec / plan）で、成果物の数を抑えられる。要件と設計を spec 1 枚にまとめると、レビューの往復が減る。
- 既存製品の再構築は、機能を少しずつ積み上げる作業になる。正本と差分を分けると、差分だけをレビューすれば済み、正本は実装とずれない。
- EARS と要件 ID があると、要件からテスト・タスクまでを機械的に追える。
- 2 は、設計ドキュメントを中心とするこのリポジトリには重すぎる。4 は、実装を進めると文書が陳腐化する。

独自の追加として、QA が持つ品質戦略 `quality.md` を題材ごとに置く。変更ごとのテスト文書は作らず、spec のシナリオと plan の Proof に書く。

## Consequences

- 良くなること：エージェントが読むべき文書が段ごとに決まる。追跡を CI で検査できる。
- 引き受けるコスト：アーカイブ（差分を正本へ反映する作業）を忘れると、正本が古くなる。

## Confirmation

- CI で、要件 ID がテストから参照されていることを検査する。
- 変更の最後の PR で、`changes/` から `archive/` への移動と正本の更新が行われているかをレビューで確認する。

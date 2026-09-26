---
status: accepted
date: 2026-09-26
---

# ADR-0031: CI を presubmit・CQ・継続の 3 段にし、WPT は期待値で回帰を止め、リリースのブランチは cherry-pick だけにする

## Context

ブラウザのテストは量が多く（WPT、画面の比較、3 OS、性能）、すべてを PR ごとに回すと CI が詰まる。一方、`main` を常に Canary に出せる状態に保つ必要がある。

また、リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md) は「リリースのためのブランチを作らない」とする。サーバーのサービスは `main` から前へ進めればよいが、配布型のブラウザの Stable の修正の版に、4 週ぶんの新しい変更を混ぜることはできない（ADR-0004）。

## Options

CI の段：

1. **presubmit・CQ（merge queue）・継続（main の後）の 3 段に分け、継続の段の失敗は自動の二分探索で原因を戻す**
2. **すべてを merge queue で回す**

WPT の扱い：

1. **固定した版の WPT と、OS ごとの期待値のメタデータを持ち、期待値より悪くなったら止める**
2. **合格率の閾値だけで判定する**

リリースのブランチ：

1. **`main` のスナップショットとしてのブランチを作り、先に `main` に入れた修正の cherry-pick だけを許す**
2. **ブランチを作らず、Stable の修正も `main` から出す**

## Decision

いずれも 1 を採用する。詳細は [build-and-test.md](../architecture/build-and-test.md) の 4・8 節と [update-and-release.md](../architecture/update-and-release.md) の 2 節。

- **CI の段**：presubmit は変更のあったクレートを Linux で 20 分以内、CQ は 3 OS の Tier 1 で全件の単体・結合・ブラウザのテストと WPT の抜粋を 45 分以内、継続は 1 時間ごとに WPT の全件・画面の比較・サニタイザー・性能を回す。継続の段の失敗は、自動の二分探索で原因の PR を特定し、まず戻す。
  - 2 は、CQ が数時間になり、エージェントと人の並行する変更が詰まる。
- **WPT**：本家の web tests が既知の失敗を TestExpectations に記録するのと同じ考え方で（[Chromium の web tests](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/testing/web_tests.md)）、wptrunner のメタデータに期待値を持つ。悪化は止め、改善はボットが期待値を更新する。期待値を悪い方へ変えるのは QA の承認を要する。
  - 2 は、ある領域の改善が別の領域の悪化を隠す。
- **不安定なテスト**：再実行で通ったものは記録し、7 日で 1% を超えたら隔離の候補にする。隔離は QA の承認で、14 日の期限を付ける。隔離したテストは Proof に数えない。セキュリティのテストは隔離しない。
- **リリースのブランチ**：ADR-0002 の例外として、Chrome に限り `release/M` を認める。ブランチは `main` のスナップショットで、変更は先に `main` へ入れた修正の cherry-pick だけ。ブランチの上で開発しない。cherry-pick は release owner が承認する。
  - 2 は、Stable の修正の版が、未検証の新機能を含んでしまう。フラグの裏に置いても、コードの変更そのものの危険は残る。

## Consequences

- 良くなること：
  - PR の待ち時間を短く保ちながら、全件の検査を 1 時間の遅れで回せる。
  - WPT の回帰が、変更のたびに見える。
  - Stable の修正の版を、小さく安全に出せる。
- 引き受けるコスト：
  - 継続の段で見つかった回帰は、`main` に 1 時間ほど残る。その間の Canary は出さない（夜間の段で出すので影響は小さい）。
  - 期待値のメタデータの保守（OS ごと、WPT の更新ごと）が要る。
  - リリースのブランチは、最大 2 本（Beta と Stable）を同時に保守する。cherry-pick の衝突の解消が要る。
  - ADR-0002 に例外を作る。リポジトリ共通の文書での扱いは、リポジトリの持ち主と合意する。

## Confirmation

- ブランチ保護（ruleset）で、`release/*` への直接の push を禁止し、release owner の承認を必須にする。
- cherry-pick の PR に、元の `main` のコミットの参照があることを CI で確かめる（ない PR は、例外の承認の記録を要求する）。
- 期待値のファイルの変更のうち、悪い方への変更に QA の承認があることを CI で確かめる。
- 週次で、CQ の所要時間の p50、隔離中のテストの数と期限、継続の段の失敗から戻すまでの時間を出す。

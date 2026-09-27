---
status: accepted
date: 2026-09-27
---

# ADR-0006: workerd は下流のリポジトリにパッチの列で持ち、上流の最新のタグを週 1 回取り込む

詳細は [runtime-and-isolates.md](../architecture/runtime-and-isolates.md) の 4 節。

## Context

[ADR-0001](0001-runtime-build-vs-reuse.md) で、ランタイムは workerd を元にし、上流との差分を最小にすると決めた。その差分をどう持ち、どの頻度で上流に追いつくかを決める必要がある。

上流の事実（2026-09-27 に確認）：

- 上流はほぼ毎日、`v1.YYYYMMDD.N` の形でタグを公開している。2026-09-14〜09-27 の 14 日に 15 版あった（[workerd の Releases](https://github.com/cloudflare/workerd/releases)）。
- 版の番号は、対応する互換の日付の最大値である（[workerd の README](https://github.com/cloudflare/workerd)）。
- 上流自身が、V8 15.4.80.5 に 41 のパッチを当ててビルドしている（[v8.MODULE.bazel](https://github.com/cloudflare/workerd/blob/main/build/deps/v8.MODULE.bazel)）。
- 本家のランタイムは、少なくとも週 1 回、Chrome の Stable と同じ以上の V8 に更新する（[Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)）。
- 公開版の workerd は、テナントごとの制限を強制しない（`NullIsolateLimitEnforcer`。[server.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c%2B%2B)）。多数のテナントのための差分は必ず要る。

## Options

1. **パッチの列（patch queue）。** 上流のタグを取り込み、自分たちの差分を番号付きのパッチとして毎回当て直す。取り込みは週 1 回
2. **長く生きるフォークの枝。** 上流の main を定期的にマージする
3. **上流の毎日のタグに毎日追従する**
4. **四半期ごとなど、まれに追従する**

## Decision

1 を採用する。

- 下流のリポジトリに、上流のタグ（取り込みのコミット）と `patches/workerd/`・`patches/v8/`・`patches/PATCHES.md` を置く。
- パッチは 1 つの目的に 1 つ。分類は `upstreamable`・`brand`・`multitenant`・`security`。`PATCHES.md` に理由・上流の状態・持ち主・消す条件を書く。
- `upstreamable` は、作ってから 30 日以内に上流へ PR を送る。
- `multitenant` と `brand` のパッチの合計は、S1 で 3,000 行以内を目標にする。
- 自分たちの V8 のパッチは原則持たない（上流の 41 に足さない）。例外は V8 の修正の先取り（`security`）だけ。
- 取り込みは週 1 回（月曜）。ステージングで 2 日、本番は段階的に 3 日。性能の退行の門（起動の p99 が 10%、CPU 時間の中央値が 5% 以上悪化したら止める）を置く。
- 毎日、上流の最新のタグにパッチの列が当たり、テストが通るかを確かめる（本番には出さない）。
- 取り込みを 2 週続けて飛ばしたら、Dev のテックリードへ上げる。V8 のセキュリティの修正は、週 1 回の取り込みと別の緊急の経路で届ける（[ADR-0012](0012-v8-24-hour-patch-pipeline.md)）。
- 2 を採らない理由：マージを重ねると、自分たちの差分が上流の変更と混ざり、何が自分たちの差分かが見えにくくなる。上流に送るときも切り出しにくい。
- 3 を採らない理由：毎日の本番への配信は、段階的な配信と性能の比較の時間が取れない。毎日の検査だけ行い、配信は週 1 回にする。
- 4 を採らない理由：差分が大きくなり、V8 の緊急の修正を当てるときの土台が古くなる。緊急の経路は「先週の土台に修正を当てる」ことを前提にしており、土台が古いほど当たらない危険が増える。

## Consequences

- 良くなること：
  - 自分たちの差分が、常に一覧で見える。上流に送る候補がはっきりする。
  - 土台が最大でも 2 週の古さに保たれ、緊急の修正が当たりやすい。
- 引き受けるコスト：
  - 毎週の取り込みと、パッチの当て直しの手間。上流の構造の変更で、パッチの書き直しが要る週がある。
  - C++ と Bazel のビルドの CI（ASan・UBSan の版を含む）の費用。

## Confirmation

- 毎日の CI：上流の最新のタグに `patches/` が当たり、上流のテスト・WPT の対象・脱出のテストが通る。
- `PATCHES.md` と `patches/` の中身が一致することを、CI の lint で確かめる。
- 四半期ごとに、パッチの行数と `upstreamable` の PR の状態をレビューする。

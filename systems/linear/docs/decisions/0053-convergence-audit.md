---
status: accepted
date: 2026-09-28
---

# ADR-0053: 収束の監査は、抜き取った端末が IndexedDB の確定した行のハッシュを桶ごとに `(L, sync_epoch)` と送り、サーバーは今の行と `sync_actions` から `L` の時点の状態を作り直して比べる。合わない桶は 2 段目で行を特定し、説明のつかない不一致を K5 に数える

## Context

NFR-005・K5 は、本番の抜き取りの検査（クライアントとサーバーのモデルのハッシュの突き合わせ）で、説明のつかない不一致 0 件を求める。README の 6 節は、収束しない不具合を「利用者は再読み込みまで気づかない」重い障害として挙げる。性質ベーステスト（[ADR-0010](0010-deterministic-sync-simulator.md)）は本番の組み合わせを全部は覆えない。

難しさは次のとおり。

- 端末の状態は、ある `sync_id`（`L`）の時点のもので、サーバーの今の状態は先へ進んでいる。
- 端末は購読のグループの行だけを持ち、部分のブートストラップでは一部のイシューだけを持つ。
- 端末には未確定の変更がある。

`sync_actions` の `update` は変更の後の行の全体を運ぶ（[ADR-0007](0007-sync-actions-and-range-proof-deltas.md)）ので、保持（30 日）の中なら、ある行の `L` の時点の状態を作り直せる。

## Options

1. **端末が `L` の時点のハッシュを送り、サーバーが `L` の時点の状態を `sync_actions` から作り直して比べる**
2. サーバーが今の状態のハッシュを送り、端末が追いついた時点で比べる
3. 端末の行を全部サーバーへ送って比べる

## Decision

1 を採用する。詳細は [observability.md](../architecture/observability.md) の 4 節。

- 抜き取り：1 日 1 回、端末の 5%。接続していて、5 秒静かで、対象のモデルに未確定の変更がない時に、Web Worker で IndexedDB の確定した行を読む。
- 対象：`instant` のモデルの全部と、手元の `Issue`（全体のブートストラップの端末は完全さも）。遅延のモデルと本文は持ち越し。
- モデルを ID のハッシュの最初の 1 バイトで 256 の桶に分け、桶ごとに件数と、ID の順の `(id, _u, 正準形の行)` の SHA-256 を送る。正準形は `packages/model` の共有の関数。
- サーバー：`L < floor`、`head − L > 50,000`、`sync_epoch` の違い、`L` の後の購読の変化は `skipped`。今の行のうち `updated_sync_id ≤ L` はそのまま、`(L, head]` に現れる行は `sync_id ≤ L` の最後の `sync_actions` の行から作り直す。`sync_actions` に `(workspace_id, model, model_id, sync_id)` の索引を足す。
- 合わない桶は、次の握手の `welcome.audit_followup` で端末に桶の行の一覧を求め、行の ID を特定する。分類（`match`・`skipped`・`evicted`・`retention`・`stale_build`・`unexplained`）を `convergence_mismatches` に残し、`unexplained` を K5 に数えて呼び出す。
- 同じ報告に `orphan_rows`（手元の行の `_g` が購読と交わらない数）を入れ、NFR-008 の手元の監査にも使う。
- 2 を採らない理由：大きなワークスペースでは、端末が追いつく時点とサーバーの計算の時点が合いにくい。サーバーが端末ごとの購読の今のハッシュを計算し続ける費用が大きい。
- 3 を採らない理由：端末の中身をサーバーへ送り直すことになり、帯域と、中身を扱う経路が増える。

## Consequences

- 良くなること：
  - 本番の端末の収束を、中身を送らずに確かめられる。
  - 不一致の行を特定でき、シミュレーターで再現する手がかりになる。
  - 手元の漏えい（`orphan_rows`）も同じ仕組みで見られる。
- 引き受けるコスト：
  - `sync_actions` に索引が 1 つ増える（容量は [capacity.md](../architecture/capacity.md) の 5.1 節）。
  - 部分の端末の完全さ、遅延のモデル、本文を MVP では確かめない。
  - 正準形の関数をクライアントとサーバーで同じに保つ必要がある（`packages/model` の生成）。

## Confirmation

- 性質ベーステスト：PROP-OBS-001（同じ正準形のハッシュ）、PROP-OBS-002（`L` の時点の作り直しの正しさ）、PROP-OBS-003（壊した行の検出）。
- 本番：監査の件数、分類ごとの割合、`unexplained` 0 件。

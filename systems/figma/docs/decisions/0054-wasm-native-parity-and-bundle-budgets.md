---
status: accepted
date: 2026-09-27
---

# ADR-0054: WASM とネイティブの一致を、同じ入力の列から作った正準形のバイト列で PR ごとに確かめ、WASM の大きさと描画の性能に予算を置いて CI で止める

## Context

同じ Rust のコードを、ブラウザ（`wasm32-unknown-unknown`）とサーバー（`x86_64`・`aarch64` の Linux）で動かす（[ADR-0001](0001-platform-and-stack.md)）。

- 変更の適用、レイアウト、テキストの測定の結果が、WASM とネイティブで 1 ビットでも違えば、Document Server・Render Worker・クライアントで状態や見た目が食い違う。レイアウトは f64 の四則と min・max だけで計算する規則を置いた（[ADR-0020](0020-deterministic-layout-arithmetic.md)）。規則が守られていることを、CI で確かめる必要がある。
- Document Server は ARM64（Graviton）の Fargate、Render Worker は x86-64（lavapipe のため。[rendering-engine.md](../architecture/rendering-engine.md) の 12 節）で動く。ネイティブの側も 2 つの CPU の種類がある。
- WASM のバイナリは、圧縮後 5 MB 以内を目安にする（ADR-0001、rendering-engine.md の 15 節）。開く時間（NFR-003）に直接効く。
- 本家は、PR ごとに GPU 付きの VM のヘッドレスの Chromium でフレーム時間を測り、VM の揺れのため 20% の余裕を置き、10 分以内に終える（[Keeping Figma fast](https://www.figma.com/blog/keeping-figma-fast/)、2026-09-27 に確認）。

## Options

一致の確かめ方：

1. **同じ入力の列（生成した変更の列と参照ファイル）を 3 つのビルド（wasm32、aarch64、x86_64）で当て、正準形のバイト列と、レイアウトのダンプを比べる**
2. **単体テストを 3 つのビルドで走らせるだけ**
3. **本番で抜き取って比べるだけ**

## Decision

1 を採用する。詳細は [delivery.md](../architecture/delivery.md) の 2・3 節。

- **一致の CI（`parity`）**：
  - 入力：`proptest` が生成した変更の列（固定の種で PR ごとに 1 万、夜間に 100 万）、参照ファイルの集合（1 万・10 万・30 万ノード。和文のテキスト、オートレイアウトの入れ子、インスタンス）。本番のファイルは使わない。
  - 3 つのビルドで、同じ列を当て、各段で正準形のバイト列（[document-model.md](../architecture/document-model.md) の 8.3 節）のハッシュを出す。レイアウトは `derived_layout` のダンプ、テキストは測定の結果のダンプを出す。
  - 3 つのハッシュの列が 1 つでも違えば失敗。最初に違った段の入力を、最小の再現に縮めて保存する。
  - wasm32 は、`wasm-bindgen-test` でヘッドレスの Chromium と Firefox の両方で走らせる（JIT の違いで浮動小数の扱いが変わらないことを確かめる）。
  - PROP-DM-004（document-model.md の 14.1 節）と PROP-LAYOUT-001（[layout.md](../architecture/layout.md)）の Proof はこの CI にする。
- **本番の抜き取り**：Render Worker と file-read が読み込んだ状態の正準形のハッシュと、Document Server がメモリに持つ状態のハッシュを、1% の割合で比べる（[file-storage-and-history.md](../architecture/file-storage-and-history.md) の 14.3 節の作り直しの検証と同じジョブ）。
- **WASM の大きさの予算**：
  | 対象 | 予算（brotli 後） | 超えたら |
  | --- | --- | --- |
  | エンジンの WASM（WebGL2 と WebGPU の両方を含む） | 5 MB | CI が失敗 |
  | 1 つの PR での増加 | 50 KB | Dev のテックリードの承認を求める |
  | 最初に読む JS（UI の殻） | 1 MB | CI が失敗 |
  | 同梱の既定の和文のフォント（最初に読む分） | 別の予算（[export-and-assets.md](../architecture/export-and-assets.md) の 7.2 節） | — |
  - 大きさは `twiggy` などで crate ごとの内訳を出し、PR に貼る。
- **性能の CI**：rendering-engine.md の 15 節の予算を、GPU 付きの VM で PR ごとに測る。前の `main` から 20% 以上悪くなれば失敗（本家と同じ余裕）。実機（参照の端末）では夜間に測る。PR の CI は全体で 20 分以内。
- 2 を採らない理由：単体テストは、テストが見た値しか比べない。途中の状態の違いが、後の段で結果を変えることを見落とす。
- 3 を採らない理由：食い違いを出した後で見つけることになる。

## Consequences

- 良くなること：
  - 決定性の破れを、マージの前に、最小の再現と一緒に見つけられる。
  - WASM が静かに大きくなることを防ぐ。
- 引き受けるコスト：
  - CI で 3 つのビルドと 2 つのブラウザを走らせる時間と費用。
  - GPU 付きの VM の CI の実行環境を持つ。AWS の GPU のインスタンスを、ジョブごとに立てて捨てる自前の runner にする（[delivery.md](../architecture/delivery.md) の決定）。

## Confirmation

- CI の設定の検査：`parity`、`wasm-size`、`perf` の 3 つが `main` のブランチの保護の必須の検査に入っている。
- 月に 1 回、わざと決定性を壊す変更（FMA を使う）で `parity` が失敗することを確かめる。

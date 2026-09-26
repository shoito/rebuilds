---
status: accepted
date: 2026-09-26
---

# ADR-0030: ビルドは Cargo を基本にし、C/C++ の部品は事前にビルドした成果物を固定して使う

## Context

ブラウザは Rust で書き（ADR-0001）、V8 などの C/C++ の部品を使う（ADR-0002）。ビルドの仕組みを決める。条件は次のとおり。

- 3 OS・複数のアーキテクチャ・複数の構成（release、debug、ASan）を作る。
- 主な作り手は AI エージェントで、道具（rust-analyzer、cargo-fuzz、cargo-deny）がそのまま使えることが生産性に効く。
- V8 のような大きな部品は、ビルドに時間がかかる（V8 は 1 回に 30 分程度。[rusty_v8](https://github.com/denoland/rusty_v8)）。
- 緊急の修正（NFR-006）では、部品の更新から署名済みの版までを数時間で終えたい。
- 同じコミットから、同じ成果物を作れるようにしたい。

## Options

1. **Cargo ＋ 事前にビルドした C/C++ の成果物 ＋ sccache**
2. **GN ＋ Siso**（本家と同じ。Rust も GN で作る）
3. **Bazel ＋ rules_rust ＋ リモート実行**

## Decision

1 を採用する。詳細は [build-and-test.md](../architecture/build-and-test.md) の 2 節。

- Rust は Cargo のワークスペースで作る。依存は `cargo vendor` でリポジトリに置き、`--locked` でビルドする。ツールチェーンは `rust-toolchain.toml` で固定する。
- C/C++ の部品は、上流のビルド（GN、CMake、Meson）で OS・構成ごとの静的ライブラリを別に作り、レシピ・上流の版・ツールチェーンのハッシュを鍵にして S3 に置く。build.rs はそれを取るだけで、ビルドもネットワークへの接続もしない。
- コンパイルのキャッシュは sccache に S3 を付けて使う。sccache は rustc と clang に対応し、S3 を置き場にできる。リンクするクレート（bin、cdylib、proc-macro）とインクリメンタルのコンパイルはキャッシュできない（[sccache](https://github.com/mozilla/sccache)）。実行ファイルのクレートを薄くして補う。
- リモート実行は S1 では持たない。CQ の p50 が 45 分を超えて戻らないか、キャッシュのない全体のビルドが 90 分を超えたら、3 か Siso 型を改めて比べる。
- 2 は、本家が Rust を GN のテンプレートで作り、crates.io の依存を `//third_party/rust` に取り込む形（[Chromium の Rust](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/rust/README.md)）。C++ が主で Rust が少ない本家には合うが、Rust が主の私たちには、Cargo の依存の解決と道具を捨てる代償が大きい。
- 3 は、密閉されたビルドとリモート実行が強い（[Bazel のリモート実行](https://bazel.build/remote/rbe)）。ただし、規則の保守とリモート実行の基盤の運用が重く、build.rs を持つクレートの取り込みにも手間がかかる。S1 の規模では割に合わない。

## Consequences

- 良くなること：
  - Rust の標準の道具とエコシステムがそのまま使え、エージェントの出力が安定する。
  - C/C++ の部品のビルドが日常のビルドから外れ、時間が読める。
- 引き受けるコスト：
  - Cargo のビルドは密閉ではない。build.rs の禁止事項（ネットワーク、ソースの外への書き込み）を CI で強制する必要がある。
  - C/C++ の部品の成果物を作る工程を、別に持って保守する。部品の構成を変える（例：V8 のビルドの引数）たびに、成果物を作り直す。
  - リモート実行がないので、実行環境の台数で CI の速さを買う（[infrastructure.md](../architecture/infrastructure.md) の 8 節）。

## Confirmation

- CI をネットワークのない環境で動かし、build.rs がネットワークに出たら失敗させる。
- 継続の段で、別のディレクトリで 2 回ビルドし、署名の前の成果物が一致することを確かめる（[build-and-test.md](../architecture/build-and-test.md) の 7 節）。
- 部品の目録（ADR-0002）のハッシュと、実際に使った成果物のハッシュが一致することを、ビルドの来歴で確かめる。
- CQ の所要時間とキャッシュのヒット率を週次で見て、リモート実行を検討する条件に当たっていないかを確かめる。

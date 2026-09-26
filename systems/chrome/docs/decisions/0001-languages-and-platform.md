---
status: accepted
date: 2026-09-26
---

# ADR-0001: ブラウザは Rust、クラウドのサービスは TypeScript と AWS で作る

## Context

ブラウザは、信頼できない入力（HTML、CSS、JavaScript、画像、フォント、ネットワークの応答）を大量に処理する。主要なブラウザの重大な脆弱性の多くは、メモリ安全性の欠陥（解放後の使用、境界外の読み書き）である。

一方、クラウドのサービス（同期、更新、Safe Browsing）は、他の題材と同じ形の Web サービスである。

## Options

1. **ブラウザは Rust、サービスは TypeScript と AWS**
2. **ブラウザは C++（本家と同じ）**
3. **すべて Rust**

## Decision

1 を採用する。

- ブラウザ（Browser プロセス、エンジン、ネットワーク、UI）は Rust で書く。`unsafe` は、部品との境界（FFI）と、性能上どうしても要る箇所に限り、1 か所ずつレビューする。
- 既存の C/C++ の部品（V8 など。[ADR-0002](0002-engine-build-vs-reuse.md)）は、Rust のバインディングで包み、境界の型を狭くする。
- クラウドのサービスは、Slack の ADR-0007・0011・0020・0021 と同じ（TypeScript、AWS、Terraform、OpenTelemetry）。
- 2 は、既存の知見が多いが、メモリ安全性の欠陥を言語で減らせない。
- 3 は、サービスで他の題材と道具を共有できない。

## Consequences

- 良くなること：
  - 自作の部分で、メモリ安全性の欠陥の多くを、コンパイルの時点で防げる。
- 引き受けるコスト：
  - C++ の部品との境界（V8 の GC とハンドル、所有権）が複雑になる。
  - Rust のビルドの時間。キャッシュとビルドの分散で抑える（[build-and-test.md](../architecture/build-and-test.md)）。

## Confirmation

- CI で、`unsafe` の追加を検出し、セキュリティのレビューを必須にする。
- ファズ（[build-and-test.md](../architecture/build-and-test.md)）を、FFI の境界と、解析器（HTML・CSS・画像）に常時かける。

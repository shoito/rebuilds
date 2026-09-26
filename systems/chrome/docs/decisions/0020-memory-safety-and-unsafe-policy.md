---
status: accepted
date: 2026-09-26
---

# ADR-0020: Rule of 2 を Rust に当てはめ、`unsafe` と C/C++ の部品の置き場所を決める

## Context

ADR-0001 でブラウザを Rust で書くと決めたが、V8 や動画の復号器などの C/C++ の部品（ADR-0002）と、FFI・IPC の共有メモリの `unsafe` は残る。どこまでを許し、どこに置くかを決めないと、メモリ安全でないコードが権限の高いプロセスで信頼できない入力を扱う形が、少しずつ入り込む。

本家 Chromium の「Rule of 2」は、「信頼できない入力」「安全でない言語」「高い権限」のうち、2 つまでしか同時に持たないという規則である。Rust は、本家でもメモリ安全な言語として認められている。

## Options

1. **Rule of 2 を、`unsafe` な Rust と C/C++ を「安全でない言語」とみなして適用する**
2. **`unsafe` を個別のレビューだけで管理する（置き場所は制限しない）**

## Decision

1 を採用する。詳細は [sandbox-and-security.md](../architecture/sandbox-and-security.md) の 5・6 節。

- **Browser プロセスで、信頼できない入力（IPC、マニフェスト、同期のデータ、更新の目録、Safe Browsing のリスト）を、`unsafe` を含むコードや C/C++ で解析しない。** 必要なら Utility プロセスに出す。
- C/C++ の部品は、サンドボックスの中（Renderer・Utility）でだけ、信頼できない入力を扱う。
- `unsafe` は、クレートの単位で既定で禁止する。許すクレートを目録で管理し、`unsafe` のブロックごとに安全である理由を書き、セキュリティの担当がレビューする。`unsafe` を含むクレートのテストは Miri でも回す。
- 第三者のクレートは、監査の記録（cargo-vet の形式）と既知の脆弱性の検査（RustSec）を CI で必須にする。
- 攻撃の緩和：Windows は Control Flow Guard（Rust は `-C control-flow-guard`）、V8 のサンドボックスを有効にする。MiraclePtr に相当する解放後の使用の緩和は、安全な Rust では不要とし、FFI の境界では生のポインタを持たずハンドルの型で包む。
- 2 は、1 つずつのレビューは正しくても、「どこで」動くかの判断が抜ける。

## Consequences

- 良くなること：
  - サンドボックスの外での、メモリの破損による Critical の脆弱性の入り口を、構造で減らせる。
- 引き受けるコスト：
  - Browser プロセスで済むはずの処理を Utility に出すと、IPC とプロセスの起動の費用がかかる。
  - 第三者のクレートの監査の作業が続く。

## Confirmation

- CI で、`unsafe` の追加と、許可の目録にないクレートの `unsafe` を検出して止める。
- CI で、Browser プロセスに入るクレートの依存関係に、C/C++ の解析器が無いことを検査する。
- 監査の記録のないクレートの追加を止める。

## References

- Chromium: [The Rule of 2](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/security/rule-of-2.md)
- Rust: [rustc の codegen の選択肢](https://doc.rust-lang.org/rustc/codegen-options/index.html)

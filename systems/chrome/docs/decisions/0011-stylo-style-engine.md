---
status: accepted
date: 2026-09-26
---

# ADR-0011: スタイルの計算に Stylo を使う

## Context

CSS の解析、カスケード、セレクタの照合、計算値、無効化は、仕様の量が多く、性能（Speedometer 3、NFR-003）に直結する。[ADR-0002](0002-engine-build-vs-reuse.md) は Stylo を候補に挙げた。自作の DOM とレイアウトにつなげられるか、ライセンスと保守の形を確かめて決める。

確かめたこと（2026-09-26）：

- Stylo は Firefox と Servo が使う Rust の CSS のエンジン。servo/stylo は、mozilla-central から Stylo の部分を取り出した `upstream` の枝と、Servo 向けの変更を載せた `main` の枝を持ち、上流と同期するたびに crates.io へ出す（`stylo`、`selectors`、`servo_arc`、`stylo_atoms`、`stylo_traits`、`stylo_dom` など）。ライセンスは MPL-2.0（[servo/stylo](https://github.com/servo/stylo)）。
- Stylo は DOM を trait（`TElement`・`TNode` など）越しに読む。Blitz は、自前の DOM に Stylo をつないで動かしている（[DioxusLabs/blitz](https://github.com/DioxusLabs/blitz)）。

## Options

1. **Stylo（crates.io の版）を使う**
2. **CSS のエンジンを自作する**
3. **lightningcss など、解析だけの部品を使い、カスケードと計算値を自作する**

## Decision

1 を採用する。

- Stylo は `servo` の機能で組む。crates.io の版を完全に固定し、更新は PR で行う。フォークは持たない。足りないプロパティや修正は、servo/stylo に送る。
- 自分たちの DOM に Stylo の trait を実装する層（`style_bridge`）を 1 つ作り、`unsafe` はこの層に閉じる。
- 並列の走査（rayon）を使う。走査の間、DOM は読み取り専用で、Stylo が書くのは要素の `style_data` だけにする（[rendering.md](../architecture/rendering.md) の 4 節）。
- MPL-2.0 はファイル単位のコピーレフト。Stylo のファイルを改変して配るときは、そのファイルを公開する。自分たちのコードは MPL の影響を受けない。上流に送る方針なので、改変は持たない。
- 2 を採らない理由：セレクタの照合と無効化の最適化、カスケードの層（`@layer`）、`:has()`、container queries、計算値の補間まで、Firefox で長年最適化されたものに並ぶには年単位の作業が要る。
- 3 を採らない理由：解析はエンジンの一部にすぎず、重いのはカスケード・照合・無効化である。

## Consequences

> 2026-09-27 の注記：Stylo は crates.io の `stylo`（0.21.0、2026-09-08）として出ている。プロパティの定義は、`.mako.rs` の `engines="gecko servo"` から TOML（`style/properties/longhands.toml` など）に移った。一方のエンジンだけのプロパティには `engine = "gecko"` を書き、Servo で未実装のものは `servo_pref` で止める（[servo/stylo](https://github.com/servo/stylo)、2026-09-27 に確認）。「`servo` で有効なプロパティは `gecko` より少ない」は正しい。一覧は、この TOML から出す。

- 良くなること：
  - Firefox で本番の実績がある、並列で速いスタイルの計算を得る。
  - CSS の新しい機能が、Firefox の実装とともに上流から入る。
- 悪くなること、引き受けるコスト：
  - Stylo の API は安定を約束していない。上流の同期ごとに `style_bridge` の追従が要る。
  - `servo` の機能で有効なプロパティは、`gecko` の機能より少ない。**未検証**：どれだけ足りないか。E1 で、プロパティの定義から `servo` で有効な一覧を出し、WPT の対象（NFR-007）と突き合わせる。足りない分は上流に送る作業として E2 に積む。
  - スタイルの挙動の細部は、Chrome ではなく Firefox の実装に揃う。互換性の差は WPT と主要サイトの検査で見つけて、上流で直す。
  - DOM の設計が、Stylo の trait と並列の走査の前提（読み取り専用の走査、要素ごとのデータの置き場）に縛られる。

## Confirmation

- `Cargo.lock` で Stylo の版が固定されていること、`[patch]` で Stylo を差し替えていないことを CI で検査する。
- `style_bridge` の外から `style` クレートを import しないことを lint で検査する。
- WPT の `css/` の対象の領域の合格率を、Stylo の更新の前後で比べ、下がる更新はマージしない。

---
status: accepted
date: 2026-09-26
---

# ADR-0008: ナビゲーションは Browser が主導し、応答を見てプロセスを決め、文書ごとに frame の実体を作る

## Context

サイトごとのプロセス（[ADR-0003](0003-multi-process-site-isolation.md)、[ADR-0007](0007-process-allocation-policy.md)）では、行き先の URL がどのサイトか、つまりどのプロセスで表示するかが、リダイレクトと応答のヘッダー（COOP など）で決まる。また、埋め込みの可否（X-Frame-Options、CSP の `frame-ancestors`）やダウンロードの判定を Renderer に任せると、侵害された Renderer が迂回できる。

本家は、以前は Renderer がナビゲーションのリクエストを出していたが、Browser が出す形（browser-side navigation）に移した。応答を受けてからプロセスを選び、応答をコミットの IPC で Renderer へ渡し、Renderer のコミットの完了を Browser が検査する（[Life of a Navigation](https://chromium.googlesource.com/chromium/src/+/main/docs/navigation.md)）。さらに、文書ごとに Browser 側の frame の実体を作り直す RenderDocument へ段階的に移行している（[RenderDocument](https://chromium.googlesource.com/chromium/src/+/main/docs/render_document.md)）。

## Options

1. **Browser が主導する。応答の後にプロセスを決め、コミットを検査する。文書ごとに frame の実体を作る**
2. 1 と同じだが、同じサイトのナビゲーションでは frame の実体を使い回す（本家の移行前の形）
3. **Renderer がナビゲーションのリクエストを出し、応答を見て Browser へプロセスの移動を頼む**

## Decision

1 を採用する。詳細は [navigation-and-loading.md](../architecture/navigation-and-loading.md) の 3〜5 節。

- ナビゲーションのリクエスト・リダイレクト・応答は、Browser が Network サービスに頼んで扱う。Renderer は、ナビゲーションを「頼む」だけで、Browser が行き先の制限を検査してから受け付ける。
- 応答の検査（Safe Browsing、204/205、ダウンロード、埋め込みの可否、COOP/COEP、MIME）を、Renderer に本文を渡す前に Browser で行う。
- 最終の URL と応答のヘッダーから、行き先のプロセスを決める。Browser が始めたナビゲーションでは、予測したプロセスを先に用意してよいが、応答で決め直す。
- コミットの指示で、応答のヘッダー、本文のデータのパイプ、Browser が計算したオリジンとポリシー、その文書用の端点を渡す。
- Renderer のコミットの完了は、送った指示・プロセスの鍵と照合し、合わなければプロセスを終了させる。
- クロスドキュメントのナビゲーションでは、同じプロセスでも、frame の Browser 側の実体を新しく作る。
- 2 は、使い回しの判断が複雑で、前の文書の状態・権限が次の文書へ残るバグの温床になる。本家が RenderDocument へ移している理由と同じ。
- 3 は、応答の本文が一度行き先でないプロセスに届き、Site Isolation と両立しない。

## Consequences

- 良くなること：
  - 埋め込みの可否、COOP、ダウンロードの判定が、侵害された Renderer に左右されない。
  - 文書と Browser 側の実体が 1 対 1 になり、権限の端点の寿命が文書の寿命にそろう。
- 引き受けるコスト：
  - ナビゲーションごとに Browser を経由する往復が増える。予測したプロセスの先行の用意と、本文のデータのパイプでの直送で抑える。
  - 同じサイトのナビゲーションでも実体を作り直す費用。E3 で測る。

## Confirmation

- 侵害された Renderer を模すテスト：別のサイトの URL・オリジンでのコミットの完了、`pushState` での別のオリジンの URL、内部のページへのナビゲーションの要求を送り、拒否とプロセスの終了を確かめる。
- Web Platform Tests の `html/browsers/browsing-the-web/`、`html/cross-origin-opener-policy/`、`content-security-policy/frame-ancestors/`、`x-frame-options/` の合格率を追う。
- 同じ文書の実体が 2 つの文書に使われていないことを、デバッグのビルドの `assert` で確かめる。

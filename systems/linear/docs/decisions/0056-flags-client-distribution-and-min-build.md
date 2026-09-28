---
status: accepted
date: 2026-09-28
---

# ADR-0056: クライアントのフラグはサーバーが評価して握手で配り、同期の意味はフラグにしない。Web は `index.html` を端末の桶ごとに段階的に切り替え、Electron は更新の案内を端末の桶で返す。最低の版は Gateway の `min_build` で殻とレンダラーの組で強制し、手元の読み書きは止めない

## Context

クライアントは、Web（SPA、Service Worker の殻）と Electron（殻がレンダラーをリモートから読む。[client-app.md](../architecture/client-app.md) の 11 節）である。README の技術スタックは、クライアントのフラグをブートストラップで配ると置いた。client-app・client-store-and-offline の領域は、Electron の自動更新の段階と最低の版、DB の版を上げる変更を機能の変更と別のリリースにすることを、delivery の領域に任せた。

- Electron の `autoUpdater` は macOS と Windows だけで、macOS は署名が必須（[autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、2026-09-28 に確認）。段階的な出し方の仕組みは持たない（同じ文書に記載がない）。
- クライアントとサーバーの規則（競合、`applyOp`、`derive`）が違うと収束しない（[ADR-0002](0002-sync-model.md)）。
- 手元の DB の版を上げたクライアントを前の版に戻すと、前のコードは新しい DB を開けない（[client-store-and-offline.md](../architecture/client-store-and-offline.md) の 6.4 節）。

## Options

クライアントのフラグ：

1. **サーバーが評価し、`welcome.flags` と `GET /sync/flags` で配り、手元に持つ**
2. 外部のフラグの事業者の SDK をクライアントに入れる

Web の段階：

- a. **CloudFront Functions が端末の ID の桶で `index.html` の版を選ぶ**
- b. 全員に同時に出す

Electron の段階：

- x. **更新の案内を `public-api` が返し、端末の桶で新しい版を返すかを決める**
- y. 静的な案内のファイルを差し替える（全員に同時）

## Decision

1・a・x を採用する。詳細は [delivery.md](../architecture/delivery.md) の 3・5・6 節。

- フラグは `release.*`（未完成を隠す）と `ops.*`（止め・絞り）とクライアントのフラグ。クライアントは `_meta.flags` に持ち、オフラインでも同じ値を使う。**競合の規則、`applyOp`、`derive`、同期グループ、トランザクションの形はフラグにしない**（スキーマの版で変える。[ADR-0057](0057-schema-change-ordering.md)）。`release.*` は 100% の後 30 日で消す。
- Web：版ごとの接頭辞で S3 に置き、KeyValueStore の割合と端末の ID（`<brand>_cid`）の桶で `index.html` を選ぶ。1% → 10% → 50% → 100%、各段 4 時間以上、RUM の指標で止める。戻しは割合を戻す。手元の DB の版を上げるリリースは機能の変更と別にし、1% で 48 時間見て、問題は前へ直す。
- Electron：殻の版とレンダラーの版を分ける。殻は `update.<brand>.<domain>` の案内で、桶が割合より小さい端末にだけ新しい版を返す。1% → 10% → 50% → 100%。Chromium の High 以上の修正は 24 時間で 100%。止めは割合 0、戻しは前のコードで版を上げて出す。署名の鍵はクラウドの HSM。
- 最低の版：`hello` の `build` を殻とレンダラーの組にし、Gateway の `min_build` で比べる。古ければ `upgrade_required` で送信を止め、手元の読み書きと outbox は続ける。上げる理由は、プロトコル・互換の一覧の外れ・セキュリティに限る。
- 2 を採らない理由：オフラインでの評価と、握手の時の値との食い違いの扱いが要る。端末の情報が外部へ出る（法務の L2）。
- b を採らない理由：問題のある版が全員に一度に届く。
- y を採らない理由：Electron の殻の問題（起動しない）は、全員に届くと戻せない（版を下げられない）。

## Consequences

- 良くなること：
  - クライアントの問題を、少ない端末のうちに止められる。
  - フラグの誤りで収束が崩れない。
  - 最低の版の強制でも、利用者の作業（手元の読み書き）が止まらない。
- 引き受けるコスト：
  - 段階の切り替えの仕組み（CloudFront Functions、KeyValueStore、更新の案内）を自前で持つ。
  - 手元の DB の版を上げるリリースは戻せず、出すのに時間がかかる。
  - `hello` の `build` の形が変わる（sync-engine の領域への依頼）。

## Confirmation

- 例示テスト：桶の割り当てが端末の ID で安定し、割合を上げると前の段の端末を含む。
- E2E：`min_build` より古いクライアントが `upgrade_required` の後も手元で書け、outbox に入る。
- 静的な検査：フラグの参照が `packages/model`・`packages/policy`・同期の核のパスに現れない。

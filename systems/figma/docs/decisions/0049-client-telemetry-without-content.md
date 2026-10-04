---
status: accepted
date: 2026-09-27
---

# ADR-0049: クライアントの計測（フレーム時間・メモリ・WASM の異常終了）は、ブラウザの中で集計してから、中身を含まない形で自前の受け口へ送る

## Context

この題材の品質の多くは、利用者の端末の中で決まる。NFR-002（1 フレーム）、NFR-003（開く時間）、NFR-004（メモリ 1.5 GB）、NFR-005（フレーム時間 p95 16.7ms）は、サーバーのメトリクスでは測れない。エンジン（WASM）の panic、メモリの確保の失敗、GPU のコンテキストの喪失も、端末でしか見えない（[rendering-engine.md](../architecture/rendering-engine.md) の 13 節、[editor-and-tools.md](../architecture/editor-and-tools.md) の 20 節）。

一方で、ファイルの中身（ノードの名前、テキスト、画像、フォントの名前）をログ・メトリクスに書かない規則がある（[AGENTS.md](../../AGENTS.md)）。Rust の panic のメッセージは、書式の引数に値を含みうる。

ブラウザの計測の API には差がある。

- Long Animation Frames（50ms を超える描画の遅れ）は実験的で、主要なブラウザのすべてでは動かない（[MDN: PerformanceLongAnimationFrameTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceLongAnimationFrameTiming)、2026-09-27 に確認）。
- `performance.measureUserAgentSpecificMemory()` は、安全なコンテキストと cross-origin isolation を要し、主に Chromium だけで動く（[MDN](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measureUserAgentSpecificMemory)、2026-09-27 に確認）。

本家は、描画の性能をフレーム時間で見る。PR ごとに GPU 付きの VM のヘッドレスの Chromium で測り（VM の揺れのため 20% の余裕）、古い機種を含む実機でも測る（[Keeping Figma fast](https://www.figma.com/blog/keeping-figma-fast/)、2022 年 10 月に導入、2026-09-27 に確認）。本番の端末の計測の仕組みは公開されていない（**未検証**）。

## Options

1. **ブラウザの中で集計（ヒストグラム）してから、自前の受け口へ送る。異常終了は、場所だけを送る**
2. **生のイベント（フレームごと）を送る**
3. **外部の RUM・エラー追跡のサービス（SaaS）に送る**

## Decision

1 を採用する。詳細は [observability.md](../architecture/observability.md) の 3 節。

- **自分で測る。** エンジンは、フレームごとの時間（入力の適用、レイアウト、シーングラフ、タイル、合成）を `performance.now()` で測り、自分のメモリ（WASM の線形メモリ、キャッシュの内訳の予算）を数える。ブラウザの API は、使えるときだけ補助に使う。
- **ブラウザの中で集計する。** 60 秒ごとに、対数の区間のヒストグラム（区間の数は固定）と件数にまとめる。フレーム時間は、パン・ズーム・ドラッグ・待機を分けて数える。
- **送る先**：`telemetry.<brand>.<domain>` の受け口（API と別のサービス。TypeScript）。`sendBeacon` か `fetch(keepalive)` で送る。受け口は、ラベルを許可リストで検査してから、OpenTelemetry のメトリクスに変えて AMP へ送る。
- **ラベル**：ビルドの ID、ブラウザの種類と大きなバージョン、OS の種類、GPU のバックエンド、GPU の区分（ベンダーを丸めたもの）、ファイルの大きさの区分（ノードの数を 5 段）。`file_id` と `user_id` はメトリクスのラベルに入れない。
- **異常終了の報告**：
  - Rust の panic のフックは、**場所（ファイル・行・列）と、閉じた列挙の種類だけ**を送る。メッセージの文字列は送らない。
  - WASM の trap（`unreachable`、メモリの確保の失敗）は、エンジンの呼び出しを包む JS で捕まえ、同じ形で送る。スタックは関数の番号の列で送り、ビルドごとに保管した名前の表でサーバーの側で読み替える。
  - `file_id`・`session_id`・ノードの ID と大きさは添えてよい（AGENTS.md の規則の範囲）。
  - 報告の後、エンジンは作り直す（再読み込み）。確定していない変更は失われうるので、報告に `pending` の件数を添える。
- **標本化**：メトリクスは全セッション。異常終了の報告は、同じ場所の報告を 1 セッション 1 回に絞る。
- **保持**：受け口の生のログは 30 日。集計したメトリクスは 13 か月。
- **同意**：利用規約に計測の範囲を書き、中身を送らないことを示す。組織の方針で止める設定は持たない（品質の計測に要るため）。書き方は法務の確認待ち（[security.md](../architecture/security.md) の 9 節）。
- 2 を採らない理由：量（毎秒 60 件×接続の数）と、フレームごとの記録から操作の内容が推し量れること。
- 3 を採らない理由：panic のメッセージやパンくずに中身が混ざる危険を、外部に持ち出す。送る前の除去を自分で持つなら、送り先も自分で持つ方が単純である。

## Consequences

- 良くなること：
  - NFR-002〜005 を、本番の端末で、ブラウザ・OS・GPU の別に見られる。
  - 中身が端末の外に出ない。
- 引き受けるコスト：
  - panic のメッセージがないので、原因の特定は場所と再現に頼る。
  - 受け口と、ビルドごとの名前の表の保管を自前で持つ。

## Confirmation

- lint：エンジンの `panic!`・`expect` の書式の引数に、ノードの値の型（`NodeName`・`TextContent` など）を渡すコードを検出する。
- 結合テスト：受け口が、許可リストにないラベルと、長さの上限を超える値を捨てる。
- 抜き取り：受け口のログを週に 1 回見て、中身らしき文字列（ノードの名前の形）がないことを確かめる。

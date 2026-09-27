---
status: accepted
date: 2026-09-27
---

# ADR-0008: シグナリングは WebSocket の上の JSON で、版はサブプロトコルで決め、状態は (epoch, seq) 付きのスナップショットと差分で配る

## Context

[ADR-0005](0005-meeting-state-and-signaling.md) は、JSON と Zod、版を付けて 1 つ前まで受けること、スナップショットと連番付きの差分で配ることを決めた。この領域では、封筒の形、版の決め方、`epoch` が変わったときの扱い、落としてよいイベントの扱いを決める。

- Web クライアントとサーバーは TypeScript で、型を共有できる（[ADR-0001](0001-platform-and-stack.md)）。ネイティブのアプリの共通のコアは Rust で、同じスキーマから型を作る（[ADR-0003](0003-client-platform.md)）。
- 話者の音量のような 1 秒に数回のイベントを、`seq` を付けて全員に配ると、差分の保持と再送の量が増える。
- ブラウザの WebSocket は任意のヘッダーを付けられないが、サブプロトコル（`Sec-WebSocket-Protocol`）は指定できる（[RFC 6455](https://www.rfc-editor.org/rfc/rfc6455#section-1.9)、2026-09-27 に確認）。

## Options

形式：

1. **JSON（Zod のスキーマ）**
2. **Protocol Buffers などの二値の形式**

版の決め方：

- a. **WebSocket のサブプロトコル（`<brand>.sig.v1`）**
- b. **URL のパス（`/v1/ws`）だけ**
- c. **`hello` の中の版の番号だけ**

## Decision

1 と a を採用する。詳細は [signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 6・7 節。

- 封筒は `t`（`cmd`・`ack`・`err`・`evt`・`snap`・`eph`・`ping`・`pong`）で種類を分ける。
- 版は `Sec-WebSocket-Protocol: <brand>.sig.v<N>` で決める。サーバーは今の版と 1 つ前の版を受ける。版の中では項目を足すことだけを許し、クライアントは知らない項目と `name` を無視する。
  - > 2026-09-27 の注記：ネイティブのアプリ（MVP の後。[ADR-0023](0023-desktop-electron-mobile-native.md)）は、利用者が更新するまで古い版が残る。そこで、サーバーはアプリ（`hello.client.kind` が `desktop`・`ios`・`android`）には 2 つ前の版（N−2）までを受ける。Web は今と 1 つ前（N−1）のまま。どちらも、最低の版（`min_client_version`。Web は `client-config`、アプリは `client_releases`）より古いクライアントには `upgrade_required` を返し、更新を求める（強制の更新）。[ADR-0056](0056-client-release-trains-and-meeting-scoped-flags.md) の持ち越しへの答え。決定の中身（サブプロトコルで版を決め、版の中では足すだけ）は変えない。
- 状態の差分（`evt`）とスナップショット（`snap`）は `(epoch, seq)` を持つ。`epoch` が変わったら、クライアントは差分を求めずにスナップショットを受け取り直す。
- 一時的なイベント（`eph`：音量、制御の遅れの通知など）は `seq` を付けず、保持も再送もしない。
- 1 メッセージの上限は、クライアント → サーバーで 64 KiB、サーバー → クライアントで 1 MiB。
- WebSocket の圧縮は使わない。
- 2 を採らない理由：シグナリングの量は小さく（1 会議で毎秒数十件）、二値にする利点が小さい。JSON はブラウザの開発者ツールで読め、エージェントが扱いやすい。
- b を採らない理由：パスだけでは、1 つの接続で受ける版を交渉できない。
- c を採らない理由：接続を開いた後に版の不一致が分かり、最初の往復が無駄になる。

## Consequences

- 良くなること：
  - サーバーと Web クライアントが 1 つのスキーマのパッケージ（`@<brand>/signaling-schema`）を共有できる。
  - 差分の保持と再送の対象が、状態の変化だけになる。
- 引き受けるコスト：
  - S3 の 1,000 人の会議では、スナップショットが大きくなる。一覧のページ分けを S3 の前に決める。
  - `epoch` が変わるたびに、全員がスナップショットを受け取る（100 人で約 10 MB の送信の見込み。**未検証**。E7 の `signaling-load-test` で測る）。

## Confirmation

- 契約の試験：版を上げる PR で、1 つ前の版のクライアントの試験の列が通る。
- 性質ベーステスト：PROP-SIG-001（任意の操作と障害の列で、全クライアントの状態が Actor の `(epoch, seq)` の順の状態と一致する）。
- 結合テスト：`eph` を落としても、クライアントの状態（一覧、ミュート、共有）は変わらない。

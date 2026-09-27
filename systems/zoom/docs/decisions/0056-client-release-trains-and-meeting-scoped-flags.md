---
status: accepted
date: 2026-09-27
---

# ADR-0056: Web クライアントは毎日出せるが段階的に広げ、アプリは 2 週ごとの列車で出す。メディアに関わるフラグは開催の開始で決めて会議の中で揃える

## Context

クライアントには、Web（[ADR-0021](0021-web-client-browser-support.md)）と、MVP の後のデスクトップ（Electron）・モバイル（ネイティブ）がある（[ADR-0023](0023-desktop-electron-mobile-native.md)）。

- シグナリングのサーバーは、今の版と 1 つ前の版を受ける（[ADR-0008](0008-signaling-protocol.md)）。
- Web は読み込み直せば新しい版になる。アプリは利用者が更新するまで古い版が残る。モバイルはストアの審査を通る。
- メディアの機能（RED、SVC、AV1）は、会議の全員と Media Node が同じ設定でなければ動かない（[codecs-and-bandwidth-adaptation.md](../architecture/codecs-and-bandwidth-adaptation.md) の 13 節のフラグ `media.red`・`media.av1`・`media.svc`）。同じ会議の中で、人によってフラグの値が違うと、会議の途中で振る舞いが割れる。
- リポジトリ共通の規則は、未完成の振る舞いを release フラグの裏に置いてからマージすることを求める（ルートの [AGENTS.md](../../../../AGENTS.md)）。

## Options

Web：

1. **毎日出せる。版ごとの不変の資産を CloudFront に置き、利用者の割合で 1% → 10% → 50% → 100% に広げる。会議の中では版を変えない（次の参加から）**
2. 出したらすぐに全員

フラグ：

- a. **フラグの種類を分ける。メディアに関わるフラグは、Actor が開催の開始で評価し、会議の状態に入れて会議の全員と Media Node で揃える。止める向き（kill switch）だけは、進行中の会議にもすぐ効かせる**
- b. クライアントがそれぞれ評価する

## Decision

1 と a を採用する。詳細は [delivery.md](../architecture/delivery.md) の 5・6 節。

- **Web**：
  - 版ごとの資産（`/app/<version>/...`）を不変で置く。入口のページは、API の `client-config` が返す版を読む。版は利用者（アカウントは `user_id`、ゲストは端末の鍵）のハッシュで決め、割合で広げる。
  - 会議に入っている間は、版を変えない。新しい版は、次の参加の時に読む。
  - 広げる間、版ごとの SLI（参加の成功、良い音声の分、JavaScript の例外の率）を比べ、悪化したら割合を 0 に戻す。戻すと、次の参加から前の版になる。
  - 重い不具合（参加できない、音声が出ない）は、`client-config` で最低の版を上げ、Gateway が古い版の `hello` に `upgrade_required` を返す（[signaling-and-meetings.md](../architecture/signaling-and-meetings.md) の 6.4 節）。会議の途中で読み込み直させるのは、この場合だけ。
- **アプリ**（MVP の後）：2 週ごとの列車。デスクトップは自前の更新の配信で 1% → 10% → 50% → 100% を 1 週かけて広げる。モバイルは、ストアの段階的な公開を使う（App Store は 7 日で 1% から 100%、Google Play は割合を手で上げる。[delivery.md](../architecture/delivery.md) の 5.2 節、2026-09-27 に確認）。`client_releases` に最低の版を持ち、それより古い版は参加の前に更新を求める。
  - シグナリングの版の互換（今と 1 つ前）は、アプリの更新の遅れに足りない可能性がある。アプリを出す前に、サーバーが受ける版の数を見直す（持ち越し）。
    - > 2026-09-27 の注記：持ち越しを決めた。サーバーは、アプリには 2 つ前の版（N−2）までを受け、Web は 1 つ前（N−1）のまま。`client_releases` の最低の版（`min_client_version`）より古いアプリには、参加の前と `hello` で更新を求める（[ADR-0008](0008-signaling-protocol.md) の注記）。
- **フラグの種類**：

| 種類 | 例 | 評価の単位 | 決める時 |
| --- | --- | --- | --- |
| release（未完成の振る舞い） | 新しい画面、ブレイクアウト | 組織か利用者 | 要求ごと |
| meeting（会議の全員で揃える） | `media.red`、`media.svc`、`media.av1`、E2EE の新しい方式 | 開催 | 開催の開始で Actor が評価し、`meeting_instances.effective_flags` と会議の状態に入れる |
| ops（止める・絞る） | `media.red` の停止、`ops.join_admission`（参加の受付を絞る）、`media.ipv6_candidates` | 全体・リージョン | すぐ。meeting のフラグを止める向きに変えたら、Actor が進行中の会議に配り直す |
| experiment | 層の上げ下げの規則の値 | 開催 | 開催の開始 |

- フラグの配布は、他の題材と同じ AWS AppConfig を使う（Slack の題材の [ADR-0026](../../../slack/docs/decisions/0026-feature-flags.md)）。Actor と Media Node は起動時と変更の通知で読む。フラグの値は、会議の状態を通して Media Node に渡し、Node Agent は自分で評価しない（Node が会議の外の状態を読まない。ADR-0005）。
- フラグを消すまでの期限を、作るときに決める（release は 90 日、experiment は 30 日）。期限を過ぎたフラグは CI が警告する。
- 2 を採らない理由：Web の不具合が、全員の次の参加で一度に出る。
- b を採らない理由：同じ会議の中で RED を送る人と剥がせない人が混ざるなど、会議の途中で振る舞いが割れる。

## Consequences

- 良くなること：
  - Web の回帰を、少数の利用者で見つけて戻せる。
  - 会議の中の全員と Media Node が、同じメディアの設定で動く。
- 引き受けるコスト：
  - 会議の途中でフラグを「有効にする」向きには変えられない（次の開催から）。
  - 版ごと・フラグごとの SLI の集計が要る。
  - 同時に 2〜3 の Web の版が動く。シグナリングの互換の試験を、動いている版の組で回す。

## Confirmation

- 性質ベーステスト：任意の開催の開始とフラグの変更の列で、1 つの開催の中の全参加者が受ける meeting のフラグの値は同じ。ops のフラグの停止は、進行中の開催に 10 秒以内に届く。
- 契約の試験：配布中の Web の版（最大 3）の組で、シグナリングの契約の試験が通る。
- CI：期限を過ぎたフラグの一覧を毎週出す。

---
status: accepted
date: 2026-10-10
---

# ADR-0032: チャットの送信は検査の後に MSK の `chat-in` に書き、配信ごとに 1 つの順番付けが番号を振る。1,000 人以上の配信は 1 秒、それ未満は 250 ms ごとにまとめ、Valkey の sharded pub/sub で Gateway のノードへ 1 回だけ送る。視聴者に送るのは 1 秒 20 件（上位は 8 件）までで、配りはベストエフォートにする

## Context

- [architecture/README.md](../architecture/README.md) の 6 節は、ライブチャットを WebSocket の Gateway と Valkey での扇形の配りにし、大きな配信は 1 秒ごとにまとめて送り、低速モードと上位のチャットを持つとした。NFR-013 は 20 万人の配信で送信から画面まで p95 2 秒。
- 人気の配信では、送信が 1 秒に数千件になる（[quality.md](../quality.md) の 2.2.1 節 H の場面で 2,000 件）。視聴者はそれを読めない。1 件ずつ全視聴者に送ると、送りの量が「視聴者 × 送信」で増える（100 万人 × 2,000 件/秒）。
- Slack の題材は、DB を正本にし、配りをベストエフォートにして、欠けはクライアントが DB から差分を取る（[Slack の realtime.md](../../../slack/docs/architecture/realtime.md)）。チャットはメッセージの量が桁違いで、全部を取り戻す必要はない。
- 順序（削除がメッセージの後に届くこと）は守りたい。

## Options

正本と順番付け：

1. **MSK の `chat-in` → 配信ごとの順番付け → `chat-log`（MSK → S3）。Aurora に 1 件ずつ書かない**
2. Aurora に書き、outbox で配る（Slack の題材の形）
3. Valkey Stream だけ

配り：

- a. **まとめ（1 秒・250 ms）、表示の上限、Valkey の sharded pub/sub、ノードごとに 1 回の購読**
- b. 1 件ずつ配る

## Decision

1 と a を採用する。詳細は [live-chat.md](../architecture/live-chat.md) の 3〜5・7 節。

- 送信は Gateway で検査し（[ADR-0033](0033-chat-rate-limits-slow-mode-and-moderation.md)）、`chat-in`（配信の ID を鍵）に `acks=all` で書く。
- `chat-sequencer` はパーティションの持ち主として、配信ごとに `seq = max(前 + 1, 今のミリ秒 × 1024)` を振る。モデレーションの出来事も同じ順番付けを通す。`client_msg_id` の重複は 10 分で捨てる。
- 書く先：Valkey Stream（直近 1,000 件）、まとめの送信、`chat-log`（MSK → S3 Parquet）。
- まとめ：視聴 1,000 人以上は 1 秒、未満は 250 ms。視聴者への上限は `all` 20 件・`top` 8 件（1,000 人未満は 5・2 件）。所有者・モデレーターのメッセージは必ず入れ、残りは上位の点と無作為の抜き取りで選ぶ。`mod` の購読には全部を 250 ms で送る。
- Valkey の sharded pub/sub のチャネル `chat:{stream_id}:all`・`:top`・`:mod`。Gateway のノードは配信ごとに 1 回だけ購読し、1 回だけ直列化・圧縮したフレームを全接続に使い回す。
- Gateway は Rust で状態を持たない。配りはベストエフォートで、`seq` の飛びは Valkey Stream から取り直し、古すぎれば捨てる。

### 他の案を選ばなかった理由

- **2（Aurora）**：1 秒 5,000 件の書き込みと outbox の読み出しが、管理の面の DB に乗る。チャットに全部を取り戻す正しさは要らない。
- **3（Valkey だけ）**：失ってよい部品で、記録（リプレイ、モデレーションの監査）が残らない。
- **b（1 件ずつ）**：送りの量が送信の数に比例し、100 万人で数 Tbps になる。視聴者は読めない。

## Consequences

- 良くなること：
  - 送りの量が「視聴者 × 上限」で決まり、送信の急増に強い。100 万人で全体 約 16 Gbps（動画の約 0.5%）。
  - 削除がメッセージの後に届く順序を、番号で守れる。
- 引き受けるコスト：
  - 大きな配信では、視聴者がすべてのメッセージを見られない（`mod` と記録とリプレイには残る）。
  - MSK のトピックと順番付けの部品を運用する。チャットの記録の保持は法務の確認待ち（L10）。

## Confirmation

- 性質ベーステスト：PROP-CHAT-001（番号が厳密に増える）、PROP-CHAT-002（削除の順序）、PROP-CHAT-003（上限と必ず入れるもの）、PROP-CHAT-005（重複）。
- 負荷試験：20 万人・ピーク 1 秒 2,000 件・3 時間で p95 2 秒。100 万人の模型でノードの送信と Valkey の購読の数（[quality.md](../quality.md) の 2.2.1 節 H）。

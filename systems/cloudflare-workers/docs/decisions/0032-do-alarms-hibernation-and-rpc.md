---
status: accepted
date: 2026-09-27
---

# ADR-0032: WebSocket はランタイムの外の接続の保持役で持って休止を支え、アラームはリージョンの索引で起こし、呼び出しは RPC を基本にする

詳細は [durable-objects.md](../architecture/durable-objects.md) の 8 節。

## Context

本家（2026-09-27 に確認）：

- アラームは 1 つの実体に 1 つ。少なくとも 1 回。例外のときは 2 秒から指数的に最大 6 回まで再試行（[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)）。
- `acceptWebSocket()` で受けた接続は、無活動の実体をメモリから外しても残る。添付は 16,384 バイトまで。ping・pong は実体を起こさずに返せる。コードの更新は全 WebSocket を切る（[WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)）。休止は 10 秒の無活動の後（[Lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)）。
- 互換の日付 2024-04-03 以降、クラスの公開のメソッドを RPC で呼べる。エラーには `.retryable`・`.overloaded` がある（[Invoking methods](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)、[Error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)）。

この題材の制約：

- ランタイムのプロセスは、Spectre の対策で 1 日 1 回入れ替える（[sandbox-and-security.md](../architecture/sandbox-and-security.md) の 6.4 節）。WebSocket をランタイムのプロセスが持つと、毎日切れる。
- 実体がメモリにいない間もアラームを起こす仕組みが要る。アラームを失うと、利用者の定期の処理が止まる。

## Options

1. **WebSocket はホストのスーパーバイザーの接続の保持役（ランタイムの外）が持つ。アラームは SQLite を正本にし、リージョンの索引（DynamoDB）とシャードごとのスケジューラーで起こす。呼び出しは Cap'n Proto の RPC**
2. **WebSocket をランタイムのプロセスが持ち、プロセスの入れ替えで切る。アラームは各ホストの手元の時計だけで起こす**
3. **アラームを queues-and-cron のスケジューラーに載せる**

## Decision

1 を採用する。

- 接続の保持役は、タグ、添付（16,384 バイト）、自動の応答の組を持ち、ping・pong と自動の応答を実体を起こさずに返す。メッセージが来たら実体を起こす。ランタイムのプロセスの入れ替えで、休止できる接続は切れない。デプロイ、持ち主の交代では切る。
- アラーム：`setAlarm` は索引への追加を先にし、SQLite の確定を後にする（確定したアラームは必ず索引にある）。削除は確定を先にし、索引は後で消す。起こされた実体は SQLite の時刻を確かめてから `alarm()` を動かす（空振りを許す）。再試行は 2 秒から倍にして 6 回（本家と同じ）。
- 呼び出しは RPC（Cap'n Proto、mTLS）。`fetch` も受ける。`.retryable`・`.overloaded`・`.remote` を本家と同じ意味で返す。待ちの列が 1,000 件か最も古い待ちが 30 秒を超えたら `.overloaded`（仮）。
- 2 を採らない理由：毎日、全実体の WebSocket が切れる。実体がどのホストにもいない間（退避、引き継ぎ）にアラームが来ると、起こせない。
- 3 を採らない理由：アラームは実体の保存と同じ確定の規則に載せたい（書き込みとアラームの設定をまとめて確定する）。cron のスケジューラーは cron の式の起動に特化し、数の規模も違う（アラームは実体の数だけある）。

## Consequences

- 良くなること：
  - 休止できる WebSocket は、ランタイムのプロセスの入れ替えで切れない。休止中の時間を課金しない。
  - 確定したアラームは、実体の所在によらず起こせる。
- 引き受けるコスト：
  - 接続の保持役という自前の部品（Rust）と、ランタイムとの間の受け渡しの仕組み（workerd の休止の API の差し込み口。量は E9 の PoC で確かめる。未検証）。
  - アラームの索引の書き込みが、`setAlarm` のたびに 1 回増える。
  - 少なくとも 1 回なので、引き継ぎの途中で同じアラームが 2 回動くことがある（本家と同じ）。

## Confirmation

- 結合テスト：ランタイムのプロセスの入れ替えで、休止できる接続が切れず、添付が戻る。休止中の実体がメッセージで起きる。
- 結合テスト：実体がメモリにいない状態で、アラームが期限の 1 秒以内に動く。確定の失敗の後に空振りする。
- 性質ベーステスト：任意の `setAlarm`・`deleteAlarm`・確定の失敗の列で、確定したアラームは必ず索引にある。

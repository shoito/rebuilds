---
status: accepted
date: 2026-09-27
---

# ADR-0037: `tail` はセッションの印を変更のログで配って WebSocket で届け、保存するログは ClickHouse に置く。伏せる処理はノードで行う

詳細は [developer-tooling.md](../architecture/developer-tooling.md) の 7 節と 8 節。

## Context

intent の MVP は、`console.log` のリアルタイムの表示（tail）と、ログの保存と検索を含む。関数は全リージョンのどのノードでも動くので、ある関数のログは多数のノードに散らばる。ノードは制御プレーンに同期で依存しない（[ADR-0004](0004-config-and-code-distribution.md)）。

ログには関数の利用者（エンドユーザー）の要求の中身が入る。認証のヘッダーやシークレットの値が混ざりうる。ログの扱いは、通信の秘密の上の位置づけが法務の確認待ち（[intent.md](../intent.md) の L2）。

本家の振る舞い（2026-09-27 に確認）：

- リアルタイムのログは、通信が多いと標本の段に入る。1 つの関数を同時に見られるのは 10 のクライアントまで（[Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)）。tail の API は WebSocket の URL と有効期限を返す（[Start Worker Tail](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/create/)）。
- 保存するログは有料 7 日・無料 3 日、1 呼び出し 256KB、`head_sampling_rate` を持つ（[Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)）。

## Options

1. **セッションの印を変更のログで配り、ノード → リージョンの中継 → 東京のハブ → WebSocket。保存するログは ClickHouse**
2. 全ノードが全ての呼び出しのイベントを常に中央へ流し、tail は中央で絞り込む
3. 保存するログを CloudWatch Logs（アカウントごとのロググループ）に置く
4. 保存するログを OpenSearch に置く

## Decision

1 を採用する。

- `tail` のセッションを作ると、制御プレーンが `tail/<script_id>` の印を優先の印で変更のログに書く（[ADR-0022](0022-sequenced-change-log-relays-and-lmdb.md)）。ノードは印のある関数だけ、呼び出しの終わりにイベントを作る。
- ノードで絞り込み・標本・伏せる処理を行ってから、リージョンの tail 中継へ送る。中継は東京の tail ハブへ送り、ハブが WebSocket で届ける。WebSocket の認証は、1 回だけ・60 秒の ticket を副プロトコルの値で渡す。
- 同時のセッションは関数ごとに 10。セッションは 1 時間で、CLI が切り替える。量は段ごとに上限を持ち、捨てた数を知らせる。
- 伏せる処理はスーパーバイザーで行う：認証のヘッダー（利用者は外せない）、秘密らしいクエリの値、その版のシークレットの平文（8 バイト以上）の一致、256KB の切り詰め。
- 保存するログは、同じ伏せ方の後、Kinesis を経て東京の ClickHouse に置く。`ORDER BY (account_id, script_id, ts)`、TTL は有料 7 日・無料 3 日。問い合わせは構造化の形だけで、サービスが `account_id` を足し、行の方針を重ねる。
- 運用者は利用者のログを既定で見られない。閲覧は同意と 2 人の承認で 24 時間。
- 2 を採らない理由：tail の見られていない関数のイベントまで作って運ぶ費用が大きい。保存するログを無効にした関数の中身まで中央に集めることになり、L2 の点でも持つデータを増やす。
- 3 を採らない理由：取り込みの料金が量に比例して高く（東京の単価は未検証）、1 万アカウントのロググループの管理と、アカウントをまたぐ集計の問い合わせが難しい。
- 4 を採らない理由：大量の追記と TTL での削除は、列の形式の ClickHouse の方が圧縮と削除の費用で有利。テナントの分離を索引で持つと、索引の数が増える。

## Consequences

- 良くなること：
  - tail の費用は、見られている関数にだけかかる。
  - シークレットの平文と認証のヘッダーが、ノードの外に出ない。
  - ログの検索が 1 つの列の保存で済み、集計（件数の推移）も同じ場所でできる。
- 引き受けるコスト：
  - 印の配信の遅れ（p99 10 秒）だけ、tail の最初のイベントが遅れる。
  - tail は最善の努力で、取りこぼしを許す。正本は保存するログ。
  - シークレットの値を Base64 などに変えた形は伏せられない。
  - ClickHouse の運用（自前かマネージドかは E6 の PoC で決める）。

## Confirmation

- 性質ベーステスト：任意のシークレットの値と、それを含む任意のログで、外に出る文字列に値が現れない。任意のアカウントの組で、問い合わせが他のアカウントの行を返さない。
- 結合テスト：印の配信から 10 秒以内に最初のイベントが届く。11 個目のセッションが 409。上限を超えると `sampling` の知らせが届く。
- 本番の探り：偽のシークレットを出す探りの関数で、ログと tail に平文が出ないことを 1 時間ごとに確かめる。

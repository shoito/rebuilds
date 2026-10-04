# Realtime: Slack

Gateway、購読、ファンアウト、在席・入力中、再接続と差分取得。Gateway の水平分割・購読の集約・在席の方式は [ADR-0013](../decisions/0013-gateway-scaling-and-presence.md) で決めた。前提となる決定は、`seq`（[ADR-0001](../decisions/0001-per-channel-sequence.md)）、DB を正本とするベストエフォート配信（[ADR-0002](../decisions/0002-db-as-source-of-truth-with-outbox.md)）、Redis Pub/Sub（[ADR-0003](../decisions/0003-redis-pubsub-for-fanout.md)）、イベントの Zod スキーマ（[ADR-0008](../decisions/0008-hono-rpc-for-api-contract.md)）、テナントの名前空間（[ADR-0009](../decisions/0009-pooled-tenancy-with-rls.md)）、AWS の構成（[ADR-0011](../decisions/0011-aws-container-platform.md)）。

## 1. 原則

- **正しさは DB とクライアントの差分取得が持つ。** Relay・Valkey・Gateway はイベントを落としてよい。落としたことは、クライアントが `seq` の飛びで検知して取り戻す。
- **Gateway は状態を「作らない」。** Gateway が持つのは接続と購読の表だけで、どれも再接続で作り直せる。Gateway は DB に書き込まない。
- **1 つの接続は 1 つのワークスペースに属する。** テナントの境界を接続の単位にそろえる。
- **Valkey のチャンネル名は必ず `ws:{workspace_id}:` で始める**（ADR-0009）。この文書の `{...}` はプレースホルダーで、実際の名前に波かっこは含めない（Valkey のハッシュタグとして解釈され、1 ワークスペースの全チャンネルが同じスロットに寄るため）。

## 2. 全体の流れ

```
API ── tx: messages + channel_events + outbox ──▶ Aurora (writer)
                                                    │ poll（25ms）
                                                    ▼
                                                  Relay ──▶ SQS（通知・検索など。ADR-0014）
                                                    │ PUBLISH / SPUBLISH
                                                    ▼
                                           Valkey  ws:{w}:ch:{c} / ws:{w}:m:{m} / ws:{w}:pr
                                                    │ ノードごとに 1 回だけ購読
                                                    ▼
Browser ◀── WebSocket ── CloudFront ── ALB ── Gateway（ECS、タスクあたり最大 1 万接続）
```

### NFR-002 の遅延の予算

送信 → 他者の画面に表示の p99 500ms を、区間ごとに割り当てる。負荷試験では区間ごとに計測する。

| 区間 | 予算（p99） |
| --- | --- |
| 送信者 → API のコミット | 200ms（NFR-003） |
| コミット → Relay が読む | 60ms（ポーリング間隔 25ms＋クエリ） |
| Relay → Valkey → Gateway | 20ms |
| Gateway の中の待ちと送出 | 70ms |
| Gateway → 受信者の画面（ネットワークと描画） | 150ms |

## 3. 接続のライフサイクル

### 3.1 接続の確立

```
Client                         API                     Gateway                 Valkey / Aurora(reader)
  │ POST /workspaces/{w}/realtime/tickets               │                            │
  │───────────────────────────▶│ セッションを検証        │                            │
  │                            │ ticket を発行（TTL 30s） ───────────────────────────▶ SET
  │◀──── { ticket, url } ──────│                         │                            │
  │ WSS {url}                  │                         │                            │
  │─────────────────────────────────────────────────────▶│                            │
  │ hello { ticket, protocol, client_id, heads? }       │                            │
  │─────────────────────────────────────────────────────▶│ GETDEL（1 回だけ使える）──▶│
  │                                                      │ 1. 読めるチャンネルを解決 ─▶│（ADR-0005 の判定関数）
  │                                                      │ 2. 購読する                │
  │                                                      │ 3. 各チャンネルの last_seq ▶│
  │◀──────────── ready { connection_id, heads, ... } ────│ 4. 2〜3 の間の受信を送る   │
```

- **認証はチケットで行う。** ブラウザの WebSocket はヘッダーを付けられないので、API が短命の 1 回限りのチケット（32 バイトの乱数。Valkey には SHA-256 だけを置き、TTL 30 秒）を発行する。チケットには `workspace_id`、`member_id`、`session_id` を結び付ける。Gateway は `GETDEL` で消費するので、再利用できない。チケットは URL のクエリに載せず、最初のメッセージ（`hello`）で送る（アクセスログに残さないため。[identity-and-access.md](identity-and-access.md) の 7 節）。
- **`Origin` を検査する。** 許可したオリジン以外からの接続は、ハンドシェイクで拒否する（クロスサイトの WebSocket 乗っ取り対策）。
- **`hello`**：クライアントは、プロトコルのバージョン、端末の ID（`client_id`、端末ごとに固定）を送る。
- **購読してから `last_seq` を読む。** 逆の順にすると、読んだ直後に来たイベントを取りこぼす。購読から `ready` までに受信したイベントは Gateway が溜めておき、`ready` の直後に送る。クライアントは `seq` で重複を捨てる。
- **`ready`** は、読めるチャンネルごとの `last_seq` と `last_read_seq`（heads）を返す。クライアントは自分が持つ `seq` と比べ、差分を取りに行くチャンネルを決める（6 節）。メンションの数などの集計は、`ready` の後に API（[read-state-and-notifications.md](read-state-and-notifications.md) の「未読の要約」）で取る。
- heads は Aurora の reader から読む。reader が遅れていても、購読を先に始めているので、その後のイベントで追いつく。
- **接続はワークスペースごとに 1 本。** 表示していないワークスペースには接続を張らず、未読の要約を 60 秒ごとに API で取る。

### 3.2 心拍とアイドルタイムアウト

| 層 | 制約 | 対応 |
| --- | --- | --- |
| CloudFront | WebSocket は HTTP/1.1 のみ。`Sec-WebSocket-*` ヘッダーをオリジンへ転送する必要がある。オリジンからクライアントへ 10 分間 1 バイトも流れないと、アイドルとみなして切る（[CloudFront のクォータ](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html#limits-websockets)）。数えるのはオリジン → クライアントの向きだけ | 25 秒ごとの心拍で、どの層でもアイドルにならないようにする |
| ALB | アイドルタイムアウトは 1〜4,000 秒（既定 60 秒）。HTTP/2 の PING ではリセットされない | 120 秒に設定する。Gateway の HTTP サーバーの keep-alive タイムアウトは、ALB より長く（130 秒）する（ALB の推奨） |
| Gateway | — | 25 秒ごとに WebSocket の ping フレームを送る。60 秒間なにも受信しなければ切る |
| クライアント | ブラウザの JS は ping フレームを観測できない | 25 秒ごとにアプリの `ping` を送り、10 秒以内に `pong` がなければ切って再接続する |

### 3.3 接続の寿命と失効

- 認証は接続時にしか行わないので、**接続の最長寿命を 24 時間（±1 時間のジッター）** とし、超えたら `4000 reconnect` で切る。
- メンバーの無効化・ロールの変更は、メンバーのストリーム（`ws:{w}:m:{member_id}`）に `member.access_changed` として流れる。セッションの失効は、アカウントのチャンネル（`acct:{account_id}`）に `session.revoked` として流れる（[identity-and-access.md](identity-and-access.md) の 3.3 節）。Gateway は受け取ったら、その接続を `4001` で切る、または購読を作り直す。

### 3.4 切断のコード

| コード | 意味 | クライアントの動作 |
| --- | --- | --- |
| 1000 / 1001 | 通常の切断 | 必要なら再接続 |
| 4000 | reconnect（デプロイ、寿命、ワークスペースの移動） | `retry_after_ms` の範囲でランダムに待って再接続 |
| 4001 | 認証の失効 | 再接続しない。ログインからやり直す |
| 4002 | プロトコルのバージョンが古い | 再読み込みする |
| 4003 | 遅い受信者（7 節） | バックオフして再接続し、差分を取る |
| 4008 | クライアントからの送信が多すぎる、不正なフレーム | バックオフして再接続する |
| 4029 | Gateway の過負荷（受け付けの制限） | `retry_after_ms` 以上待って再接続する |

### 3.5 デプロイ時の穏やかな切り替え

ECS は、タスクを止めるときに ALB からの登録解除を先に行い、登録解除の遅延（deregistration delay）が過ぎてから SIGTERM を送る。ALB は遅延が過ぎた時点で残った接続を強制的に切る。Fargate の停止猶予（`stopTimeout`）は最大 120 秒である。

- 登録解除の遅延を 180 秒にする。その間、新しい接続は来ない。
- Gateway は、自分が登録解除されたこと（ECS のタスクメタデータの `DesiredStatus` が `STOPPED` になること）を 5 秒ごとに確かめ、気づいたら接続を 150 秒かけて少しずつ `4000 reconnect` で切る（1 秒あたり「接続数 ÷ 150」本）。
  - この検知の方法は **未検証**。タスクメタデータ v4 は `DesiredStatus` を返し（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-metadata-endpoint-v4-fargate-response.html)）、登録解除はタスクが `DEACTIVATING` の間に行われる（[タスクのライフサイクル](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html)）。しかし、`DEACTIVATING` の間にメタデータの `DesiredStatus` が `STOPPED` になっているとは書かれていない。着手前に staging の PoC で確かめる。使えなければ、ELB の `DescribeTargetHealth` でターゲットの状態が `draining` になったことを見る方式に替える（タスクロールに読み取りの権限が要る）。
- 検知できなかった場合も、ALB が遅延の終わりに切り、クライアントのジッター付きの再接続（8 節）で吸収する。
- ローリングデプロイは 1 回に全タスクの 10〜20% ずつ入れ替える。同時に再接続してくる数の上限を、この割合で決める。
- デプロイの方式全体は [infrastructure.md](infrastructure.md) にある。

## 4. イベントの形式

WebSocket で送受信するものは、すべて `packages/contract` の Zod スキーマ（`type` による判別共用体）で検証する（ADR-0008）。

```json
{
  "v": 1,
  "type": "message.created",
  "event_id": "0192f7c4-...",
  "workspace_id": "0192...",
  "channel_id": "0193...",
  "seq": 1234,
  "occurred_at": "2026-09-26T09:00:00.000Z",
  "payload_v": 1,
  "payload": { "message": { "...": "..." } }
}
```

| フィールド | 意味 |
| --- | --- |
| `v` | 封筒（エンベロープ）のバージョン |
| `type` | イベントの種類。`<対象>.<動作>` の形 |
| `event_id` | UUIDv7。クライアントの重複排除と、ログの追跡に使う |
| `workspace_id` | 必須。Gateway は接続のワークスペースと一致しないイベントを送らない（多層防御） |
| `channel_id`、`seq` | チャンネルのストリームのイベントだけが持つ |
| `payload_v` | 本体のバージョン。互換性のある追加はバージョンを上げない。互換性を壊すときだけ上げ、移行期間は Relay が両方のバージョンを出す |

### ストリームの種類

| 種類 | 例 | `seq` | 永続化 | 取りこぼしたとき |
| --- | --- | --- | --- | --- |
| チャンネル | `message.created/edited/deleted`、`reaction.added/removed`、`pin.added/removed`、`file.updated`、`channel.created/renamed/archived/updated`、`channel.member_joined/left`（一覧は [messaging.md](messaging.md) の「イベント」） | あり | `channel_events` に残る | `after_seq` の差分取得で取り戻す |
| メンバー | `read.updated`、`thread_subscription.updated`、`channel.joined/left`（自分）、`prefs.updated`、`member.access_changed`（`session.revoked` は `acct:{account_id}`） | なし | 状態は各テーブルが正本 | 再接続時と、タブが前面に戻ったときに、状態を API で取り直す |
| 一時的 | `typing`、`presence.changed` | なし | しない | 取り戻さない |
| 制御 | `hello`、`ready`、`ping`/`pong`、`resync`、`focus`、`activity` | なし | しない | — |

- 1 イベントの大きさの上限は 16 KB とする。超える本文を持つメッセージは、本文を省いた `message.created`（`truncated: true`）として流し、クライアントが API で本体を取る。
- `resync { channel_ids }` は、Gateway が「このチャンネルのイベントを落とした可能性がある」と気づいたとき（7 節・11 節）に送る。クライアントは該当チャンネルの差分を取りに行く。
- 差分取得の元は、チャンネルのイベント列 `channel_events` とする。outbox は配信後に消すので使えない。API は outbox と同じトランザクションで、`seq` を消費するイベントをここにも書く。

  ```sql
  channel_events (workspace_id, channel_id, seq, event_id, type, payload_v, payload JSONB, created_at,
                  PRIMARY KEY (workspace_id, channel_id, seq, event_id))   -- event_id で月ごとに分割
  ```

  - 差分取得は `seq > N ORDER BY seq LIMIT 1000` の範囲読みになる。
  - 保持は 30 日とし、月ごとのパーティションを落とす。それより古い位置から追いつくクライアントは、差分が 1,000 件を超えたときと同じく最新ページを取り直す（6 節）。
  - 読む側で ADR-0005 の判定を通す。`payload` は、そのチャンネルを読める人に見せてよい内容だけを持つ。
  - 主キーに分割キーの `event_id` を含める。`seq` の一意性は採番で守る。形は [data-model/realtime-and-notifications.md](data-model/realtime-and-notifications.md) にある。

## 5. 購読モデル

### 5.1 接続が受け取るもの

| 対象 | Valkey のチャンネル | 購読の条件 |
| --- | --- | --- |
| チャンネルのストリーム | `ws:{w}:ch:{channel_id}` | 接続のメンバーが読めるチャンネルのうち、参加しているもの（`channel_members` にいる）。未参加のパブリックチャンネルは、表示している間だけ（`focus`） |
| メンバーのストリーム | `ws:{w}:m:{member_id}` | 常に |
| アカウント | `acct:{account_id}` | 常に（セッションの失効。[identity-and-access.md](identity-and-access.md) の 3.3 節） |
| 在席 | `ws:{w}:pr` | 画面に在席を出すメンバーがいるとき（9 節） |

- 読めるチャンネルの一覧は、`hello` のときに ADR-0005 の判定関数（`listReadableChannels` 相当）で解決する。Gateway が `channel_members` を独自に参照しない。
- **参加・退出はチャンネルのストリームに流す。** `channel.member_left` は `seq` を消費するイベントなので、同じ Valkey のチャンネルの上で、その後のメッセージより必ず前に届く。Gateway はこれを受けたら、その時点で該当メンバーの接続を購読の表から外す。プライベートチャンネルから外された人に、後続のメッセージを送らない。
- 自分が参加したとき（`channel.joined`）は、メンバーのストリームで知らせ、Gateway が購読を加えてから、クライアントが差分を取る。
- Gateway は、送る直前にも「その接続の購読の表にそのチャンネルがあるか」と「`workspace_id` が一致するか」を確かめる。

### 5.2 ノードごとの集約

```
Gateway ノード
  channelSubs: Map<"ws:{w}:ch:{c}", Set<Connection>>   ← 参照カウント
  memberSubs:  Map<"ws:{w}:m:{m}",  Set<Connection>>
```

- Valkey への購読は **ノードごとに 1 チャンネル 1 回** にする。最初の接続が必要としたときに SUBSCRIBE し、最後の接続がいなくなってから 30 秒後に UNSUBSCRIBE する（切断と再接続が続くときの購読の出し入れを抑える）。
- 受け取ったイベントは **1 回だけシリアライズ** し、同じバッファを該当する全接続に送る。
- Valkey への接続は、ノードあたり購読用に 1〜数本、送信・コマンド用に 1 本を持つ。

### 5.3 巨大チャンネル（S2 の専用経路）

参加者が一定数（初期値 1,000 人）以上のチャンネルを「大規模チャンネル」とし、次のように扱いを分ける。しきい値はチャンネルの属性として持ち、Relay と Gateway の両方が参照する。

| 項目 | 通常のチャンネル | 大規模チャンネル |
| --- | --- | --- |
| Relay | 共有のパーティション | 専用のパーティション。大量のイベントが通常のチャンネルの配信を待たせない |
| 表示していない接続への配信 | すべてのイベント | `channel.head { seq, has_mention_for_you? }` を最大 1 秒に 1 回だけ。本体は `focus` した接続にだけ送る |
| リアクション | 1 件ずつ | 250ms ごとに集約して `reaction.summary` を送る |
| 入力中 | 送る | 送らない |
| 差分取得 | DB（reader） | 直近 1,000 件のイベントを Valkey にキャッシュし、そこから返す。同時に多数のクライアントが同じ範囲を取りに来るため |
| @channel / @here | 6 人以上で送信前に確認（[messaging.md](messaging.md)） | 同じ。10,000 人以上のチャンネルでは owner・admin だけが使える（[messaging.md](messaging.md) の「誰が使えるか」） |

- 大規模チャンネルでも、`seq` は通常どおり消費する。`channel.head` を受けたクライアントは、表示したときに差分を取る。
- S1 では、最大のワークスペースが 5,000 人なので、この経路は作らない。しきい値の属性と `focus` の仕組みだけを先に入れる。

## 6. 再接続と差分取得

1. クライアントはチャンネルごとに「最後に受け取った `seq`」を保持する。
2. WebSocket で受け取ったイベントの `seq` が `last + 1` でなければ、欠損とみなす。
3. 再接続時・欠損検知時は `GET /workspaces/{ws}/channels/{id}/events?after_seq=N` で差分を取得し、`seq` 順に適用する。
4. 差分が多すぎる場合（例：1,000 件超）は差分を諦め、最新ページを取り直す。

これにより、**Valkey や Gateway の配信を「ベストエフォート」にしても正しさが保たれる**。

### 取得の順序と絞り込み

- 再接続の後、すべてのチャンネルを一度に取りに行かない。次の順にし、同時に走らせる取得は 1 クライアントあたり 3 本までにする。
  1. 表示中のチャンネル
  2. メンションや DM のあるチャンネル
  3. その他は heads だけを更新し（未読の表示に足りる）、開いたときに取る
- `ready` の heads で、自分が持つ `seq` と `last_seq` が同じチャンネルは取りに行かない。
- 差分取得の API は reader から読む。クライアントが「`seq` M までは存在する」と知っている場合（WebSocket で M を受け取った）は、`min_seq=M` を付ける。reader の結果が M に届かなければ、API は writer から読み直す（reader の遅れで欠損が続くのを防ぐ）。

## 7. 背圧と遅い受信者

| しきい値（接続ごと） | 動作 |
| --- | --- |
| 送信バッファ（`bufferedAmount`）が 256 KB を超えた | 一時的なイベント（入力中・在席）を捨てる |
| 1 MB を超えた、または 30 秒間 256 KB を下回らない | `4003` で切る。クライアントは再接続して差分を取る |

- 遅い受信者のためにイベントを溜め込まない。溜めるほど Gateway のメモリが減り、ほかの接続を巻き込むため。欠けた分は差分取得で取り戻せる。
- **Valkey の側の背圧**：Gateway の受信が遅れると、Valkey は `client-output-buffer-limit pubsub` を超えた購読の接続を切る。Gateway は購読を張り直し、影響したチャンネルを購読している全接続に `resync` を送る。
- **ノードの過負荷**：イベントループの遅延が 200ms を超えたら、新しい接続を `4029` で断る。ALB のヘルスチェックには生存だけを返し、過負荷を理由に不健全にしない（不健全にすると接続が他のノードへ一斉に移り、連鎖する）。
- クライアントからの送信は、1 接続あたり 1 秒に 10 フレーム（ping を除く）、1 フレーム 16 KB までとし、超えたら `4008` で切る（[rate-limiting.md](rate-limiting.md) の 4.1 節が正）。

## 8. 再接続の殺到への備え

デプロイ、AZ の障害、Valkey のフェイルオーバーで、多数のクライアントが同時に再接続してくる。

- **クライアントのバックオフ**：初回は 0〜3 秒のランダムな待ち。その後は「full jitter」の指数バックオフ（基数 1 秒、上限 30 秒）。`4000`・`4029` で `retry_after_ms` が指定されたら、その範囲に広げる。ネットワークの復帰（`online` イベント）を検知したときも、ランダムな待ちを入れる。
- **受け付けの制限**：Gateway は 1 タスクあたり 1 秒に 200 接続までを受け付け、超えたら `4029` を返す。チケットの発行 API にもワークスペース単位・全体の上限を置く。
- **`hello` の負荷**：チャンネル一覧と heads の取得が、再接続のたびに DB に当たる。reader から読み、同時に実行する数をノードごとに制限する。
- **差分取得の負荷**：6 節の優先順位と同時数の制限に加え、API はメンバー単位のレート制限を持ち、超えたら 429 と `Retry-After` を返す。

## 9. 在席（presence）

- **状態**：`active`（いずれかの端末が接続し、直近 10 分以内に操作がある）、`away`（接続はあるが操作がない、または本人が退席を選んだ）、`offline`（接続がない）。通知の DND は、在席とは別の表示として出す。
- **記録（TTL 方式）**：Gateway は、接続ごとに `ws:{w}:pr:{member_id}`（ソート済み集合。要素は接続 ID、スコアは失効時刻）へ登録し、30 秒ごとにまとめて延長する（失効は 90 秒後）。メンバーの状態は、失効していない要素があるかと、端末ごとの `activity` の最新値で決める。Gateway が落ちても、90 秒以内に消える。
- **集約**：1 人が複数の端末を持つので、端末ごとの状態をメンバー単位にまとめる。いずれかが `active` なら `active`。
- **変化の通知**：状態が変わったら、Gateway はワークスペースの在席のチャンネル `ws:{w}:pr` に、1 秒ごとにまとめた差分（`[{member_id, state}]`）を流す。
- **必要な分だけ購読する**：クライアントは、画面に在席を出すメンバー（DM の相手、表示中のメンバー一覧など。最大 500 人）だけを `presence.subscribe` で Gateway に伝える。Gateway はノード単位でその和集合を持ち、`ws:{w}:pr` の差分から関係するものだけを接続へ送る。
- **照合**：Gateway は 30 秒ごとに、ノードが見ているメンバーの在席を Valkey から読み直し、変化があれば送る。Gateway が落ちたときの `offline` は、この照合で最大 90 秒遅れて反映される。
- 在席は DB に保存しない。Valkey を失ったら、全員が一時的に `offline` に見え、30 秒以内に戻る。
- `activity { state, focused_channel_id }` は、端末の操作・表示状態が変わったとき（最大 10 秒に 1 回）にクライアントが送る。Gateway は `ws:{w}:act:{member_id}`（ハッシュ。接続 ID → 状態、TTL 90 秒）に置く。通知の抑制に使う（[read-state-and-notifications.md](read-state-and-notifications.md)）。

## 10. 入力中（typing）

- クライアントは、入力中の間、同じチャンネル（スレッド）について **3 秒に 1 回まで** `typing { channel_id, thread_root_id? }` を送る。
- Gateway は、その接続の購読の表にチャンネルがあることを確かめ、`ws:{w}:ch:{c}` へ `seq` なしの一時的なイベントとして流す。Relay も DB も通らない。
- 受け取ったクライアントは 5 秒間表示し、同じ人から次が来なければ消す。自分の他の端末には表示しない。
- 大規模チャンネルでは送らない。保存も、差分取得での再送もしない。

## 11. Relay

### 11.1 読み方と順序

- Relay は outbox を 25ms ごとにポーリングし、`ORDER BY id LIMIT 500` で読み、配信し、配信できた行を消す（カーソルで追いかけず、消す方式）。`BIGSERIAL` の採番順とコミット順は一致しないので、カーソル方式では遅れてコミットされた行を飛ばしうるため。
- 同じチャンネルの行は、`last_seq` の行ロックによりコミットの順が `seq` の順になる。消す方式なら、`seq` 6 の行が見えるのは 5 の行が見えた後になる。
- NOTIFY による起床は使わない。通知を伴うトランザクションのコミットが直列化されるため（影響の大きさは **未検証**。PostgreSQL の文書に記述がなく、実装に依存する。NOTIFY を使わないので確かめない）。
- Relay は writer から読む。reader は遅れるため。

### 11.2 複数の Relay

- outbox の行を `hash(channel_id) mod P`（S1 は P = 16）のパーティションに分け、Relay は `pg_try_advisory_lock` でパーティションの持ち主になる。1 つのパーティションは同時に 1 つの Relay だけが処理するので、チャンネル内の順序が保たれる。
- S1 はアクティブ 1 台＋待機 1 台。待機側は 5 秒ごとにロックの取得を試み、アクティブが落ちたら引き継ぐ（DB の接続が切れるとロックも外れる）。
- S2 では Relay を増やし、パーティションを分け合う。大規模チャンネルは専用のパーティションに寄せる（5.3 節）。

### 11.3 配信とまとめ送り

- パーティションごとに Valkey の接続を 1 本使い、PUBLISH をパイプラインでまとめて送る。同じ接続から送ったメッセージは、購読者にその順で届く。
- **Valkey への配信はベストエフォート**：短いタイムアウト（100ms）で 1 回だけ再試行し、だめなら諦めて行を消す（メトリクスに数える）。Valkey の障害で outbox を詰まらせないため。
- **SQS への配信は確実に行う**：送れなかった行は消さず、次の周期で再送する（[ADR-0014](../decisions/0014-sqs-worker-queues-and-notification-delivery.md)）。
- **SQS の障害でリアルタイム配信を止めない**：Valkey へ出した行には `published_at` を付け、次の周期からは Valkey に出さず、SQS への再送だけを行う。行を消すのは、両方が済んでから。`relay` ロールに、この列の UPDATE を許す（前提）。SQS の障害が続くと outbox は伸びるが、新しい行の Valkey への配信は進む。
- 同じ outbox の行から、どの宛先へ出すかは `event_type` の対応表で決める。

### 11.4 outbox の掃除と異常な行

- 行は配信の直後にまとめて消す（1 回の DELETE で最大 500 行）。更新と削除が多いテーブルなので、autovacuum の設定を個別に強める。膨張を VACUUM に任せないよう、最初から日ごとのパーティションに分け、空になった古いパーティションを落とす（[capacity.md](capacity.md) の 3.1 節、[data-model.md](data-model.md) の 2.8 節）。
- 配信できない行（大きさの上限超え、スキーマ違反）は、`outbox_dead` に移して消し、アラートを出す。1 行のせいでパーティション全体を止めないため。`relay` ロールに `outbox_dead` への INSERT を許す（前提）。
- outbox はテナントテーブルだが、Relay は全テナントの行を読む。`relay` ロールだけに全行の読み取りと削除を許すポリシーを置く（[data-model/realtime-and-notifications.md](data-model/realtime-and-notifications.md) で定義した）。

## 12. 複数端末

- 同じメンバーの接続は、それぞれ独立に購読し、同じチャンネルのイベントを受け取る。
- 既読の更新（`read.updated`）はメンバーのストリームに流し、同じメンバーの他の端末に届ける（[read-state-and-notifications.md](read-state-and-notifications.md)）。
- 在席は端末をまたいで集約する（9 節）。通知の抑制は、どの端末が操作中かで決める。
- 1 メンバーあたりの同時接続は、ワークスペースごとに 10 本までとし、超えたら古い接続から `4000` で切る。ワークスペースをまたいだ 1 アカウントの合計は 20 本まで（[rate-limiting.md](rate-limiting.md) の 4.1 節）。

## 13. 規模の段階ごとの構成

### S1（5 万接続）

- Gateway：1 タスク 1 万接続を上限とし、目標 60% と AZ 障害時の余裕を含めて 9 タスク（[infrastructure.md](infrastructure.md)）。
- Valkey：クラスタモードなし、1 シャード（プライマリ＋レプリカ）。通常の PUBLISH / SUBSCRIBE。

### S2（25 万接続）：sharded pub/sub

- Valkey をクラスタモードにし、`SPUBLISH` / `SSUBSCRIBE` を使う。通常の PUBLISH はクラスタの全ノードへ伝わり、シャードを増やしても配信の負荷が減らない。sharded pub/sub は、チャンネル名のスロットを持つシャードの中だけで伝わる（ElastiCache は Valkey と Redis OSS 7 以降で対応）。
- チャンネル名は `ws:{w}:ch:{c}` のまま、ハッシュタグを使わない。チャンネルごとに別のスロットに散る。
- Gateway は、各シャードへの購読用の接続を持つ。スロットの移動（リシャーディング）で購読が外れたら、張り直して `resync` を送る。
- ElastiCache は、クラスタモードで sharded pub/sub に対応する（Valkey、Redis OSS 7 以降。[AWS のドキュメント](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/WorkingWithRedis.html)）。
- 使うクライアントライブラリが `SSUBSCRIBE` とスロットの移動に対応していることを、S2 に入る前に確かめる（**未検証**。ライブラリをまだ選んでいない。S2 の前に、リシャーディング中の購読の張り直しを staging で試す）。
- 大規模チャンネルの経路（5.3 節）を有効にする。Gateway を EC2 の起動タイプへ移すかは、負荷試験で判断する（ADR-0011）。

### S3（100 万接続）：セル

- セルごとに Gateway・Relay・Valkey を持ち、セルをまたぐ購読はない（1 つのワークスペースは 1 つのセルにある）。
- チケットの発行 API が、ワークスペースのセルの Gateway の URL を返す。セル構成と対応表は [infrastructure.md](infrastructure.md) にある。
- ワークスペースを別のセルへ移すときは、移動元の Gateway がそのワークスペースの接続を `4000` で切り、クライアントは新しいチケットで移動先へつなぎ直す。`seq` は移動の前後で変わらないので、差分取得でそのまま追いつける。

## 14. 障害と振る舞い

| 障害 | 起きること | 検知 | 回復 |
| --- | --- | --- | --- |
| Gateway のタスクが落ちる | そのタスクの接続が切れる | ALB のヘルスチェック、接続数の急減 | クライアントがジッター付きで再接続し、差分を取る。在席は最大 90 秒で `offline` になる |
| Valkey のフェイルオーバー | 切り替えの間の配信が落ちる | Gateway と Relay の Valkey 接続の切断 | Gateway は購読を張り直し、全接続に `resync` を送る。クライアントは優先順位と同時数の制限の中で差分を取る |
| Valkey の購読の出力バッファ超過 | そのノードの購読が切られる | Gateway の購読の切断 | 同上（そのノードだけ） |
| Relay が止まる | リアルタイム配信と SQS への送出が止まる。outbox が伸びる。送信者の画面には出るが、他者には出ない | outbox の未処理件数と最古の行の経過時間 | 待機の Relay がロックを取って再開する（10 秒以内）。溜まった行を順に配信する |
| Aurora のフェイルオーバー | 投稿と `hello` が失敗する。Relay が止まる | API のエラー率、DB の接続エラー | 投稿はクライアントが同じ `client_msg_id` で再送する。Gateway の `hello` 失敗は `4029` で返し、再接続させる |
| reader の遅延 | heads や差分取得が古い | reader のレプリカ遅延 | 購読が先なので追いつく。差分取得は `min_seq` で writer に切り替える |
| 遅い受信者 | その接続のバッファが膨らむ | `bufferedAmount` | `4003` で切る。差分取得で取り戻す |
| 再接続の殺到 | `hello` と差分取得が DB に集中する | 新規接続のレート、reader の負荷 | ジッター、受け付けの制限、差分取得の優先順位と同時数の制限 |
| AZ の障害 | 3 分の 1 の接続が切れる | ALB、ECS | 残りの AZ で受ける。Gateway は 1 AZ を失っても足りる台数にしておく |
| 心拍が届かない（途中の機器の切断） | 接続が黙って死ぬ | 両側の心拍 | どちらかが 60 秒（クライアントは `pong` 待ち 10 秒）で切り、再接続する |
| outbox の異常な行 | その行が配信できない | Relay のエラー | `outbox_dead` に移し、アラートを出す |
| 古いクライアント | 知らないイベントの型・バージョンを受け取る | 契約テスト、`hello` のバージョン | 知らない型は無視する。バージョンが古すぎれば `4002` で再読み込みさせる |
| 退出とメッセージの競合 | 外された人に後続のメッセージが届く危険 | — | 退出を同じチャンネルのストリームで `seq` 順に流すので、後続より先に購読から外れる |

## 15. 監視する指標

指標の定義と閾値は [runbooks](../runbooks/README.md) で持つ。ここでは、この設計が前提にしている指標を挙げる。

- 送信 → 表示の遅延（区間ごと。2 節の予算と比べる）
- クライアントの欠損検知率、`resync` の送信数
- outbox の未処理件数と最古の行の経過時間、`outbox_dead` の件数、Valkey への配信の失敗数
- Gateway：タスクあたりの接続数、新規接続のレート、切断コードごとの件数、イベントループの遅延、Valkey の購読数
- 差分取得の API：レート、429 の割合、writer への切り替えの割合

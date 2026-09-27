# Chat and Reactions: Zoom

会議の中のチャット（全員へのメッセージと個別のメッセージ）、ファイル、絵文字のリアクション、挙手の設計。会議の後にチャットを残すかどうかも決める。会議の外のチャット（Team Chat に相当）は扱わない（intent.md の MVP の後）。

前提となる決定は、会議の状態は Meeting Actor が持ち、状態の差分は `(epoch, seq)` で配り、一時的なイベントは `seq` なしで配ること（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)、[ADR-0008](../decisions/0008-signaling-protocol.md)）、E2EE の会議ではチャットを MLS のアプリケーションのメッセージとして暗号化すること（[ADR-0004](../decisions/0004-encryption-and-e2ee.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0036](../decisions/0036-in-meeting-chat-ordering-and-retention.md) | チャットは Actor が会議ごとの `chat_seq` で順序を決め、状態の `seq` とは分ける。配信は `eph` の `chat.message` で行い、クライアントは `chat_seq` の飛びを `chat.fetch` で埋める。会議の間は Valkey の Stream に置く。会議の後は、既定では消す。組織の設定か録画があるときだけ、全員へのメッセージを残す。個別のメッセージは会議の後に残さない |
| [0037](../decisions/0037-chat-files-reactions-and-raise-hand.md) | ファイルは S3 に直接上げ、マルウェアの検査を通したものだけを配る。上限 100 MB。会議の後はチャットと同じく消す。リアクションは `eph` で配り、残さない。挙手と反応の表示（はい・いいえなど）は参加者の状態として `seq` で配る。E2EE の会議では、ファイルを使えず、リアクションは MLS で暗号化する |

## 1. 目的と範囲

- 扱う：全員へのメッセージ、個別のメッセージ、チャットの許可の設定、主催者によるメッセージの削除、会議の後の保持、ファイル、絵文字のリアクション、挙手と反応の表示、E2EE の会議での扱い。
- 扱わない：待合室の人へのメッセージ（[meeting-security.md](meeting-security.md) の 5 節）、シグナリングの封筒と流量（[signaling-and-meetings.md](signaling-and-meetings.md) の 6 節）、MLS の中身（[e2ee.md](e2ee.md)）、録画に入れるチャットのファイルの作り方（[recording-and-transcription.md](recording-and-transcription.md) の 4.4 節）、会議の外のチャット。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| ファイルの送信 | 会議の中でファイルを送れる。組織の設定で許すかを選ぶ（[Enabling file transfer in meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0058822)）。大きさの上限は 1 GB とする解説や、512 MB・2,048 MB の設定を挙げる利用者の投稿がある（一次の値は**未検証**） | 100 MB（ADR-0037） |
| リアクション | 絵文字のリアクションは 10 秒で消える。挙手と反応の表示（はい・いいえ・もっとゆっくり など）は、下げるまで残る（大学の IT の解説。一次は**未検証**） | 同じ考え方（ADR-0037） |
| 途中から入った人のチャットの履歴 | 公開の一次の資料で確かめていない（**未検証**） | 既定は入った後のメッセージだけ。主催者の設定で履歴を見せる |
| 会議の後のチャット | クラウド録画にチャットを残す設定がある（**未検証**） | 録画があれば全員へのメッセージを録画に入れる |
| E2EE の会議 | 会議の前後のチャットなどが使えない（[End-to-end encryption for meetings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065408)） | 会議の中のチャットは MLS で暗号化して使える。会議の後に残さない |

いずれも 2026-09-27 に確認。

## 3. チャット

ADR-0036。

### 3.1 なぜ状態の `seq` と分けるか

- 個別のメッセージは、送り手と受け手の 2 人にしか届かない。状態の `seq` で配ると、他の参加者には `seq` の飛びに見え、スナップショットの取り直しが起きる（[signaling-and-meetings.md](signaling-and-meetings.md) の 7 節）。
- チャットは量が多く、スナップショットに入れない（同 10.1 節）。
- そこで、チャットは Actor が別の番号（`chat_seq`）で順序を決め、`eph` で配り、足りない分をクライアントが取りに来る形にする。

### 3.2 メッセージ

```jsonc
// クライアント → サーバー
{ "t": "cmd", "id": "c-77", "name": "chat.send",
  "body": { "to": "everyone", "text": "資料はこちらです", "client_msg_id": "01J9...", "reply_to": null } }
{ "t": "cmd", "id": "c-78", "name": "chat.send",
  "body": { "to": "p_2M", "text": "少し遅れます", "client_msg_id": "01J9..." } }

// サーバー → クライアント（受け手だけに送る）
{ "t": "ack", "id": "c-77", "chat_seq": 311 }
{ "t": "eph", "name": "chat.message",
  "body": { "chat_seq": 311, "channel": "everyone", "from": "p_7Q", "from_name": "山田",
            "text": "資料はこちらです", "sent_at": "2026-10-06T01:12:03.120Z", "file": null } }
{ "t": "eph", "name": "chat.message",
  "body": { "chat_seq": 312, "channel": "dm:p_2M:p_7Q", "from": "p_7Q", ... } }
{ "t": "eph", "name": "chat.deleted", "body": { "chat_seq": 311, "by": "host" } }
```

- `chat_seq` は会議の開催（`instance_id`）の中で 1 から増える。全員へのメッセージと個別のメッセージで同じ番号の列を使う。
- クライアントは、自分に届くべきメッセージの `chat_seq` を知らない（個別のメッセージは飛ぶ）。そのため、飛びの検出はチャンネルごとの番号で行う。
  - `everyone` のチャンネルは `ch_seq`（全員へのメッセージだけの連番）を持つ。
  - 個別のメッセージは、2 人の組ごとの `ch_seq` を持つ。
  - クライアントは、チャンネルごとの `ch_seq` の飛びを見つけたら、`chat.fetch{channel, after_ch_seq}` で埋める。
- `client_msg_id` で重複を防ぐ。同じ送り手の同じ `client_msg_id` は、既存の `chat_seq` を返す（再接続の後の再送のため）。
- 再接続（`resume`）の後、クライアントは各チャンネルの最後の `ch_seq` を `chat.fetch` で送り、足りない分を受ける。
- `eph` は落としてよいので、`chat.message` を落としても、次のメッセージか再接続で埋まる。

### 3.3 許可の設定

| 設定 | 値 | 既定 |
| --- | --- | --- |
| `chat` | `everyone`（全員が全員へ送れる）・`hosts_only`（全員へ送れるのは主催者・共同主催者だけ）・`off` | `everyone` |
| `private_chat` | `everyone`（誰とでも）・`hosts_only`（主催者・共同主催者との間だけ）・`off` | `everyone` |
| `chat_history_for_late_joiners` | 真・偽 | 偽 |
| `allow_save_chat` | 参加者が自分の端末にチャットを保存できるか | 真 |

判定の決定表の草案（上から順。ID は E5 の `spec.md` で振る。`DT-CHAT-*`）：

| # | 活動の一時停止中 | 送り手の役割 | 宛先 | 設定 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | はい | `attendee` | - | - | 拒否 `suspended` |
| 2 | - | - | `everyone` | `chat = off` | 拒否 `chat_disabled` |
| 3 | - | `attendee` | `everyone` | `chat = hosts_only` | 拒否 `forbidden` |
| 4 | - | - | 個人 | `private_chat = off` | 拒否 `private_chat_disabled` |
| 5 | - | `attendee` | `attendee` | `private_chat = hosts_only` | 拒否 `forbidden` |
| 6 | - | - | 待合室の人 | - | 拒否（待合室あては別の操作。[meeting-security.md](meeting-security.md)） |
| 7 | - | - | - | - | 受ける |

- 主催者・共同主催者も、他の人の個別のメッセージを見られない。
- 名前の変更を禁じた会議でも、チャットの `from_name` は Actor が持つ今の表示の名前を使う（送り手の申告を使わない）。

### 3.4 削除

- 送り手は、自分のメッセージを会議の間に消せる（`chat.delete`）。
- 主催者・共同主催者は、全員へのメッセージを消せる（荒らしへの対処）。個別のメッセージは消せない。
- 消したメッセージは、Valkey の Stream から本文を消し、墓標（`deleted_by`）を残す。既に受けたクライアントは、`chat.deleted` で表示を消す。端末に保存された写しは消せない。

### 3.5 上限

| 項目 | 上限 | 超えたら |
| --- | --- | --- |
| 本文 | 4,096 文字（UTF-8 で 16 KiB 以下） | `invalid_message` |
| 送信（1 人） | 毎秒 3、瞬間 10 | `rate_limited` |
| 1 会議の保持の数（会議の間） | 20,000 件 | 古いものから、本文を捨てて墓標にする |
| `chat.fetch` の 1 回 | 200 件 | 続きは次の要求 |
| リンク | 本文の URL をリンクにする。プレビューは作らない | — |

- リンクのプレビュー（URL の先を取りに行くこと）は作らない。サーバーから任意の URL へ要求を出す経路（SSRF）と、会議の内容を外へ漏らす経路を作らないため。

### 3.6 会議の間の置き場所

- Valkey の Stream（`mtg:{m}:chat`）に、`XADD` で積む。項目は `chat_seq`、`channel`、`ch_seq`、`from`、`text`、`file_id`、`sent_at`、`deleted`。
- Actor の持ち主が替わったら、新しい Actor は Stream の最後から `chat_seq` と各チャンネルの `ch_seq` を戻す。
- Stream の TTL は、会議の終了から 24 時間（持ち主の交代と再接続の猶予、録画の合成のため）。その後は消える。
- Valkey が失われたら、会議の間のチャットの履歴は失われる（クライアントの手元の表示は残る）。チャットの送受信は、新しい Stream で続ける。Valkey は失われてもよい記憶という前提（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）に合わせる。
- 本文は、ElastiCache の保存時と通信の暗号化に加え、会議ごとのデータの鍵で暗号化して積む（Valkey のダンプに平文を残さない）。

### 3.7 会議の後の保持

| 条件 | 全員へのメッセージ | 個別のメッセージ | ファイル |
| --- | --- | --- | --- |
| 既定 | 会議の終了から 24 時間で消す | 同じ | 同じ |
| 録画がある | 録画の区間のものを、録画のファイル（`chat`）に入れる。録画の保持に従う | 入れない | 入れない（ファイルの名前だけ） |
| 組織の設定 `save_chat = true` | Aurora に残す（暗号化）。組織の保持の日数（既定 90 日）に従う。主催者と会議の参加者（アカウントのある人）が読める | 残さない | 残す（チャットと同じ期間） |
| 参加者が自分の端末に保存 | `allow_save_chat` が真なら、クライアントがテキストで書き出す | 自分が送り手か受け手のものだけ | — |

- 個別のメッセージを会議の後に残さないのは、主催者や管理者が読める形で残ることを、送り手が想定しにくいため。組織の記録の保全（eDiscovery）の要求があれば、L8 の結論を踏まえて新しい ADR で扱う。
- チャットの本文を、ログ・トレース・メトリクスに出さない（本題材の AGENTS.md）。数えるのは件数と大きさだけ。

## 4. ファイル

ADR-0037。

### 4.1 流れ

```
Client ── POST /v1/meetings/instances/{i}/chat-files {name, size, content_type, to} ──▶ API
          （参加の再接続用の秘密で、会議の参加者であることを確かめる）
       ◀── { file_id, upload: {url(署名付き PUT, 10 分), headers} }
Client ── PUT（S3 に直接）
S3 ──（オブジェクトの作成）──▶ マルウェアの検査 ──▶ 結果（EventBridge）──▶ Worker
                                                               │ clean：Actor に file.ready を送る
                                                               │ infected：消して、送り手に知らせる
Actor ── eph chat.message{file: {file_id, name, size, content_type}} ──▶ 宛先のクライアント
Client ── GET /v1/chat-files/{file_id} ──▶ API（受け手か確かめる）──▶ 302 署名付き GET（5 分）
```

- マルウェアの検査は、GuardDuty の S3 のマルウェアの保護を使う想定（S3 のオブジェクトの作成で検査し、結果をタグと EventBridge で返す。**未検証**。E5 で確かめる）。検査が終わるまで配らない。
- 受け手の画面は、検査の間「確認中」と出す。

### 4.2 上限と規則

| 項目 | 値 |
| --- | --- |
| 1 ファイル | 100 MB |
| 1 人・1 会議 | 20 ファイル、500 MB |
| 禁止する拡張子 | 組織の設定で決める（既定：`exe`・`msi`・`bat`・`cmd`・`scr`・`js`・`vbs`・`ps1`・`jar`・`apk`・`dmg`・`pkg`） |
| 表示 | 画像も含め、会議の画面の中に中身を描かない（ダウンロードだけ）。`Content-Disposition: attachment`、`X-Content-Type-Options: nosniff` |
| 置き場所 | `chat-files/{org}/{instance_id}/{file_id}`。別のドメイン（`<brand>files.<domain>`）の CloudFront から配る |
| 保持 | 3.7 節 |

- 組織の設定 `file_transfer`（既定：許す）で、ファイルの送信を止められる。
- 本家の上限（**未検証**の 1 GB など）より小さくするのは、マルウェアの検査の時間と費用、会議の中で大きなファイルを送る必要の少なさのため。

## 5. リアクションと挙手

ADR-0037。

### 5.1 リアクション

```jsonc
{ "t": "cmd", "id": "c-90", "name": "reaction.send", "body": { "emoji": "👏" } }
{ "t": "eph", "name": "reaction", "body": { "participant": "p_7Q", "emoji": "👏" } }
// 参加者が多い会議（100 人を超える。S2 から）はまとめて送る
{ "t": "eph", "name": "reaction.batch", "body": { "counts": { "👏": 37, "👍": 12 }, "window_ms": 500 } }
```

- 状態にしない。`seq` を付けず、残さない。クライアントは 10 秒表示して消す。
- 使える絵文字は、Unicode の絵文字の一覧から、組織が許した集合（既定は 6 種：👏・👍・❤️・😂・😮・🎉）。任意の文字列は受けない。
- 流量：1 人毎秒 1。超えたら黙って捨てる（`err` を返さない）。
- 参加者が 100 人を超える会議では、Actor が 500ms ごとに数をまとめる。
- 活動の一時停止中は、主催者・共同主催者以外のリアクションを捨てる。

### 5.2 挙手と反応の表示

- 挙手（`hand_raised`）と反応の表示（`feedback`：`yes`・`no`・`slower`・`faster`・`away`・なし）は、参加者の状態に入れる。`self.update` で変え、`participant.updated` の差分（`seq` あり）で配る（[signaling-and-meetings.md](signaling-and-meetings.md) の 6.2 節）。
- 挙手には、手を挙げた順（`hand_raised_seq`、挙げたときの `seq`）を持たせる。主催者の画面は、この順に並べる。
- 主催者・共同主催者は、1 人の手を下げる、全員の手を下げる（`host.lower_hands`）ことができる（同 9.2 節の「挙手を下げる」）。
- スナップショットに入る。持ち主が替わっても残る。

## 6. E2EE の会議

- チャット：MLS のアプリケーションのメッセージとして暗号化し、[e2ee.md](e2ee.md) の 6.2 節の `e2ee.app` で送る。Actor は暗号文を中身を見ずに順序付けて配る（`chat_seq` と `ch_seq` は付ける）。
  - 会議の間の取りこぼしを `chat.fetch` で埋めるため、Valkey には暗号文だけを積む（3.6 節と同じ TTL）。サーバーは平文を持たない。[e2ee.md](e2ee.md) の 12 節と揃えた（統合の工程で決めた）。
  - 会議の後は、設定にかかわらず残さない（録画も `save_chat` もない）。
- 個別のメッセージ：MLS のアプリケーションのメッセージはグループの全員が復号できるので、そのままでは 2 人だけに閉じられない。S1 の E2EE の会議では、個別のメッセージを使えなくする（`private_chat = off` を強制）。2 人の間の追加の暗号化（HPKE など）は持ち越し。
- ファイル：使えない。
- リアクション：MLS のアプリケーションのメッセージとして暗号化し、`eph` で配る。数のまとめはしない（Actor は中身を読めない）。E2EE の会議の参加者の上限（S1 で 100 人）の間は、まとめなくても流量は収まる見込み（**未検証**）。
- 挙手と反応の表示：状態として平文で扱う（ミュートと同じく、会議の運営のためのメタデータ）。サーバーに見えることを、E2EE を選ぶ画面で示す。
- どの項目がサーバーに見えるかの一覧は e2ee.md に置く。

## 7. 障害のときの振る舞い

| 障害 | 起きること | 対処 |
| --- | --- | --- |
| Actor の持ち主の交代 | 最大 10 秒、チャットを送れない | 新しい Actor が Stream から番号を戻す。クライアントは `client_msg_id` で再送する |
| Valkey が失われた | 会議の間の履歴が失われる | 新しい Stream で続ける。`chat_seq` はスナップショットの値から続ける。クライアントの `ch_seq` の飛びは「履歴を取得できません」と表示する |
| マルウェアの検査が遅れる・止まる | ファイルが「確認中」のまま | 5 分で「確認できませんでした」にし、配らない |
| S3 の障害 | ファイルを上げられない | 送り手に失敗を示す。チャットの本文は続く |
| 会議の後の保存（`save_chat`）の書き込みの失敗 | 保存が遅れる | outbox で再試行。Stream の 24 時間の中で終われば失わない |

## 8. セキュリティとプライバシー

- 本文とファイルの名前を、ログ・トレース・メトリクスに出さない。
- 本文は、クライアントで表示するときにエスケープする。Markdown などの装飾は MVP では解釈しない（URL のリンクだけ）。
- 個別のメッセージは、送り手と受け手の 2 人にしか送らない。Actor の送り先の計算を、決定表の試験で確かめる。
- ファイルは別のドメインから配り、会議の画面のオリジンで中身を描かない。
- 会議の後に残すチャットは、組織の中の人だけが読める（ゲストは会議の後に読めない）。
- 会議の後に残すかどうかは、会議の画面で全員に示す（「この会議のチャットは保存されます」）。

## 9. テスト

### 9.1 性質ベーステスト

- **PROP-CHAT-001（順序と収束）**：任意の送信・切断・再送・持ち主の交代の列の後、各クライアントが見る各チャンネルのメッセージの列は、Actor の `ch_seq` の順の列と一致し、重複がない。
- **PROP-CHAT-002（宛先）**：個別のメッセージが、送り手と受け手以外のクライアントに届くことはない（`chat.fetch` を含む）。
- **PROP-CHAT-003（冪等）**：同じ送り手の同じ `client_msg_id` の送信は、何度送っても 1 件になる。
- **PROP-CHAT-004（保持）**：`save_chat = false` で録画もない会議は、会議の終了から 24 時間後に、チャットの本文とファイルがどこにも残らない。

### 9.2 決定表

- 3.3 節の各行（`DT-CHAT-*`）。3.7 節の保持の表の各行。

### 9.3 結合

| 試験 | 期待 |
| --- | --- |
| 100 人の会議で 1 人が毎秒 3 通を 10 分送る | 全員に届き、`cmd` → `ack` の p95 が他の操作と同じ範囲 |
| EICAR の試験のファイルを送る | 配られず、送り手に知らせる |
| E2EE の会議でファイルを送る | 拒否 |
| E2EE の会議のチャットの Valkey の Stream を読む | 暗号文だけがある |
| ログの検索 | 試験のチャットの本文が現れない |

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E5 | `chat-send-and-deliver` | 3.2 節。`chat_seq`・`ch_seq`、`chat.fetch`、`client_msg_id` |
| E5 | `chat-permissions` | 3.3 節の決定表 |
| E5 | `chat-moderation-delete` | 3.4 節 |
| E5 | `chat-late-joiner-history` | `chat_history_for_late_joiners` |
| E5 | `chat-retention` | 3.7 節。24 時間の消去、`save_chat`、端末への保存 |
| E5 | `chat-file-transfer` | 4 節。署名付きの PUT、マルウェアの検査、別のドメインからの配信 |
| E5 | `reactions` | 5.1 節 |
| E5 | `raise-hand-and-feedback` | 5.2 節 |
| E8 | `chat-into-recording` | 3.7 節の録画のファイル（recording-and-transcription.md と一緒に） |
| E9 | `e2ee-chat-and-reactions` | 6 節（e2ee.md と一緒に） |

## 11. 未解決の問い

### 決定

2026-09-27 の既定案。承認は Dev（テックリード）が行う。保持の既定は PM の確認を取る。

- **順序**：チャットは状態の `seq` と別の `chat_seq`・`ch_seq`。配信は `eph`、取りこぼしは `chat.fetch`。
- **途中から入った人**：既定は入った後のメッセージだけ。
- **会議の後**：既定は 24 時間で消す。`save_chat` で全員へのメッセージを残す（既定 90 日）。個別のメッセージは残さない。
- **ファイル**：100 MB、検査を通したものだけ、別のドメインから配る。
- **リアクション**：残さない。既定 6 種。
- **E2EE**：チャットとリアクションは MLS（`e2ee.app`）、個別のメッセージとファイルは使えない、挙手は平文の状態。取りこぼしを埋めるため、Valkey には暗号文だけを置く（[e2ee.md](e2ee.md) の 12 節と揃えた）。
- **シグナリング**：`chat.*`・`reaction.*`・`host.lower_hands` は [signaling-and-meetings.md](signaling-and-meetings.md) の 6.2 節の表に足した。スキーマの定義は E5 の Story で足す。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 個別のメッセージを組織の記録として残す要求（eDiscovery）への対応（L8） | 法務の確認の後、必要なら新しい ADR |
| 会議の後のチャットの保持の既定（90 日）と、社外の参加者の削除の請求（L6） | 法務の確認の後、PM が決める |
| GuardDuty の S3 のマルウェアの保護の振る舞いと費用 | E5 で確かめる |
| E2EE の会議の個別のメッセージ（2 人の間の追加の暗号化） | E9 の後に検討する |
| チャットの装飾（Markdown、メンション） | E5 の利用者の声で決める |
| 1,000 人の会議（S3）のチャットの流量と、`reaction.batch` の窓 | S3 の前の負荷試験 |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- `chat.send` から受け手の表示までの p95（目標：500ms、案）。
- `chat.fetch` の発生率（取りこぼしの目安）。
- マルウェアの検査の時間（p95）と、検出の件数。
- 会議の終了から 24 時間後に消えていないチャット・ファイルの件数（毎日の監査で 0 であること）。

### runbooks

- `chat-file-scan-backlog.md`：マルウェアの検査が遅れたときの確かめ方と、ファイルの送信を一時的に止める手順。
- `chat-retention-audit.md`：24 時間の消去が止まったときの確かめ方と、手で消す手順。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Valkey `mtg:{m}:chat` | Stream。`chat_seq`、`channel`、`ch_seq`、`from`、`text`（会議の鍵で暗号化）、`file_id`、`sent_at`、`deleted`。TTL は会議の終了から 24 時間 |
| Valkey `mtg:{m}:chat:cmid:{from}:{client_msg_id}` | 重複の検出。`chat_seq`。TTL 10 分 |
| Aurora `meeting_chat_messages` | `save_chat` のときだけ。`instance_id`、`chat_seq`、`from_participant_id`、`from_user_id?`、`from_name`、`text_ciphertext`、`file_id?`、`sent_at`、`deleted_at`、`retention_until` |
| Aurora `chat_files` | `file_id`、`org_id`、`instance_id`、`from_participant_id`、`channel`、`name`、`size`、`content_type`、`s3_key`、`scan_status`（`pending`・`clean`・`infected`・`failed`）、`expires_at` |
| S3 `chat-files/` | 4.2 節 |

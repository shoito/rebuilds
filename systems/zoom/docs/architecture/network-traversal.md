# Network Traversal: Zoom

参加者の端末から Media Node までの経路を、どの網からでも通す仕組み。ICE、STUN、TURN（UDP・TCP・TLS 443）、TURN の実装と資格情報、社内のプロキシとファイアウォール、IPv6、EC2 のパブリック IP とセキュリティグループを決める。

前提となる決定は、EC2 の上の Media Node とパブリック IP・接続の追跡をしない規則（[ADR-0001](../decisions/0001-platform-and-stack.md)）、ブラウザの WebRTC（[ADR-0003](../decisions/0003-client-platform.md)）、Media Node の中のポートの配置（[ADR-0010](../decisions/0010-media-node-process-layout.md)）、付け替え（[ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0014](../decisions/0014-ice-strategy.md) | Media Node は ICE Lite で、公開の IPv4・IPv6 の host の候補だけを出す（UDP と、同じポートの ICE-TCP）。STUN のサーバーは単独では置かない。クライアントは全部の候補を集め（`iceTransportPolicy: "all"`）、前回 TURN の TLS でしかつながらなかった端末は、最初から relay に絞る |
| [0015](../decisions/0015-turn-coturn-and-ephemeral-credentials.md) | TURN は coturn を自前で動かし、UDP 3478・TCP 3478・TLS 443 で待つ。資格情報は TURN REST API の形の一時的なもの（HMAC-SHA1、有効 12 時間）を、参加の応答で渡す。中継の相手は Media Node の IP の範囲だけに限り、それ以外への中継を拒否する |
| [0016](../decisions/0016-media-edge-addressing-and-security-groups.md) | Media Node と TURN は、公開する IPv4 のまとまった範囲（BYOIP か、AWS の連続した IPv4 のブロック）から Elastic IP を付け、IPv6 と併せて持つ。セキュリティグループは、メディアのポートだけを IPv4・IPv6 の全開で両方向に許し、接続の追跡を外す。顧客には、宛先の範囲とポートの一覧を公開する |

## 1. 目的と範囲

- 扱う：ICE の候補と優先の順、STUN と TURN の置き方、TURN の実装の選択、資格情報の発行と失効、TURN の悪用の防止、社内のプロキシ・ファイアウォールでの通し方、公開するポートと宛先の範囲、IPv6、EC2 のパブリック IP・Elastic IP・セキュリティグループ、網が変わったときの ICE restart。
- 扱わない：Media Node の中の worker とポート（[media-server-sfu.md](media-server-sfu.md) の 3 節）、シグナリングの WebSocket の経路（CloudFront・ALB。[infrastructure.md](infrastructure.md)）、帯域の推定（[codecs-and-bandwidth-adaptation.md](codecs-and-bandwidth-adaptation.md)）、ブラウザごとの対応表（[clients.md](clients.md)）。

## 2. 標準と本家で確かめたこと

| 項目 | 標準・資料 | この設計 |
| --- | --- | --- |
| ICE | [RFC 8445](https://www.rfc-editor.org/rfc/rfc8445)（RFC 5245 を置き換え）。候補の種類の優先の推奨値は host 126、peer-reflexive 110、server-reflexive 100、relay 0。aggressive nomination は廃止。ICE Lite は「常に公開のインターネットにつながり、公開の IP を持つ」実装向け | Media Node は ICE Lite（ADR-0014） |
| ICE の SDP | [RFC 8839](https://www.rfc-editor.org/rfc/rfc8839)。`ice-ufrag` は 24 ビット以上の乱数（4 文字以上）、`ice-pwd` は 128 ビット以上（22 文字以上）。ICE Lite は `a=ice-lite` を付ける | mediasoup が作る値を使う |
| 同意の確認 | [RFC 7675](https://www.rfc-editor.org/rfc/rfc7675)。約 5 秒（4〜6 秒）ごとに確認し、30 秒応答がなければ送信を止める | 付け替えの検知には使わない（[ADR-0013](../decisions/0013-media-node-failover-and-reattach.md)） |
| STUN | [RFC 8489](https://www.rfc-editor.org/rfc/rfc8489)（RFC 5389 を置き換え）。既定のポートは UDP・TCP 3478、TLS・DTLS 5349。`MESSAGE-INTEGRITY-SHA256` と、弱い方式への引き下げを防ぐ仕組みを足した | TURN のサーバーが STUN にも答える |
| TURN | [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656)。割り当ての既定の寿命 600 秒、許可 300 秒、チャネル 10 分。寿命の上限は 3,600 秒以下を推奨。既定のポートは 3478、TLS・DTLS は 5349。`REQUESTED-ADDRESS-FAMILY`・`ADDITIONAL-ADDRESS-FAMILY` で IPv6 と両方の割り当て | 443 番で TLS も待つ（ADR-0015） |
| TURN の TLS の ALPN | [RFC 7443](https://www.rfc-editor.org/rfc/rfc7443)。ラベルは `stun.turn`（0x73 0x74 …、TURN の用途）と `stun.nat-discovery` | coturn の設定で受ける。ブラウザが ALPN を送るかは**未検証**（E2 の `network-path-matrix-tests` で、TLS 443 の経路のパケットを取って確かめる） |
| TURN の資格情報 | [TURN REST API の草案](https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00)（2013-07、失効した個人の草案）。`username = 失効の時刻:利用者`、`password = base64(HMAC(秘密, username))`、推奨の有効期間 86,400 秒、応答は `username`・`password`・`ttl`・`uris` | 形は同じ。有効期間は 12 時間（ADR-0015） |
| coturn | `--use-auth-secret`・`--static-auth-secret`（REST API）、`--allowed-peer-ip`・`--denied-peer-ip`（許可を優先）、`--no-multicast-peers`、ループバックは既定で拒否、`--min-port`・`--max-port`（既定 49152〜65535）、`--user-quota`・`--total-quota`、`--max-bps`、`--no-tlsv1`、`--alternate-server`（[README.turnserver](https://github.com/coturn/coturn/blob/master/README.turnserver)）。BSD の 3 条項のライセンス（[LICENSE](https://github.com/coturn/coturn/blob/master/LICENSE)）。最新の版は 4.18.0（2026-09-08、[Releases](https://github.com/coturn/coturn/releases)） | ADR-0015 |
| ブラウザ | [WebRTC 1.0](https://www.w3.org/TR/webrtc/)（W3C Recommendation、2025-03-13）。`iceTransportPolicy` は `"relay"` と `"all"`。`RTCIceServer` は `urls`・`username`・`credential`。`iceCandidatePoolSize`。ICE の状態は `new`・`checking`・`connected`・`completed`・`failed`・`disconnected`・`closed` | 5 節 |
| IP の扱い | [RFC 8828](https://www.rfc-editor.org/rfc/rfc8828)。モード 1〜4。同意がないときの推奨はモード 2（既定の経路とその私的なアドレス）。モード 4 は、HTTP がプロキシを使うならメディアもプロキシを通し、UDP がなければ TCP で送る | 8 節 |
| mediasoup | WebRtcTransport は ICE Lite（役は常に controlled）。`announcedAddress`、`exposeInternalIp`（既定 false）。UDP と TCP の ICE に対応。IPv6 に対応（[API](https://mediasoup.org/documentation/v3/mediasoup/api/)、[設計](https://mediasoup.org/documentation/v3/mediasoup/design/)、[Rust の WebRtcTransport](https://docs.rs/mediasoup/latest/mediasoup/webrtc_transport/struct.WebRtcTransport.html)） | 3 節 |
| 本家のファイアウォールの規則 | 会議のクライアントは TCP 443・8801・8802、UDP 3478・3479・8801〜8810 を、公開された IPv4・IPv6 の範囲へ開ける。HTTPS のプロキシは 443 番で対応（[Zoom network firewall or proxy server settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060548)） | 考え方は同じ（ポートを少なくし、宛先の範囲を公開する）。番号は独自（7.3 節） |

いずれも 2026-09-27 に確認。

## 3. 経路の全体

```
                          ① UDP 20000–20255（直接）
Browser ────────────────────────────────────────────────▶ Media Node（ICE Lite、公開の IPv4・IPv6）
   │                      ② TCP 20000–20255（ICE-TCP、直接）              ▲
   │─────────────────────────────────────────────────────────────────────┤
   │  ③ UDP 3478    ④ TCP 3478    ⑤ TLS 443                               │ UDP（中継の先は
   └──────────────▶ TURN（coturn、公開の IPv4・IPv6）─────────────────────┘   Media Node の範囲だけ）
```

| 順 | 経路 | 通る網の例 | 品質 |
| --- | --- | --- | --- |
| ① | UDP で Media Node に直接 | 家庭、モバイル、多くのオフィス | 最良 |
| ② | TCP で Media Node に直接（ICE-TCP） | UDP を閉じ、TCP の任意のポートを開けている網 | TCP の再送で遅れと揺らぎが増える |
| ③ | TURN の UDP | 宛先を限った UDP だけを許す網（3478 は通すことが多い） | ほぼ ① と同じ。TURN の分の遅れ |
| ④ | TURN の TCP 3478 | UDP を閉じ、TCP の少数のポートだけを開けている網 | ② と同じ |
| ⑤ | TURN の TLS 443 | HTTPS（443）しか通らない網、HTTP のプロキシ | 最も悪い。TLS と TCP の上で RTP を送る |

- 候補の優先は ICE の既定（host > srflx > relay）に任せる。ブラウザは候補を並行に確かめ、通った中で優先の高い組を選ぶ。
- Media Node は ICE Lite なので、Media Node の側の候補は host だけ。クライアントの NAT の外側のアドレスは、Media Node が受けた接続の確認から peer-reflexive として分かる。したがって、直接の経路に STUN のサーバーは要らない（ADR-0014）。

## 4. Media Node の ICE

ADR-0014。

- WebRtcServer の `listenInfos`（worker ごと）：

```ts
[
  { protocol: "udp", ip: "0.0.0.0", announcedAddress: "<公開の IPv4>", port: 20000 + i },
  { protocol: "udp", ip: "<IPv6>",  port: 20000 + i },
  { protocol: "tcp", ip: "0.0.0.0", announcedAddress: "<公開の IPv4>", port: 20000 + i },
  { protocol: "tcp", ip: "<IPv6>",  port: 20000 + i },
]
```

- `exposeInternalIp` は false にする。VPC の中のプライベート IP を、クライアントに知らせない。
- WebRtcTransport は `enableUdp: true`、`enableTcp: true`、`preferUdp: true`。
- EC2 の公開の IPv4 はインスタンスの ENI には現れない（1:1 の NAT）。したがって `ip: "0.0.0.0"` で待ち、`announcedAddress` に Elastic IP を書く。IPv6 は ENI に直接付くので、そのアドレスで待つ。
- 候補の数は、IPv4・IPv6 × UDP・TCP で 4 つ。

## 5. クライアントの ICE

### 5.1 設定

```ts
new RTCPeerConnection({             // mediasoup-client の Device が作る
  iceServers,                       // 5.3 節。参加の応答で受けたもの
  iceTransportPolicy: hint === "relay-tls" ? "relay" : "all",
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
});
```

- 送りと受けの 2 本の transport は、それぞれ別の ICE の組になる（mediasoup の send と recv の transport）。
- `iceCandidatePoolSize` は使わない。mediasoup-client は transport ごとに `RTCPeerConnection` を作り、`iceServers`・`iceTransportPolicy` のほかの `RTCConfiguration` は `additionalSettings` で渡せる（[mediasoup-client の API](https://mediasoup.org/documentation/v3/mediasoup-client/api/)、2026-09-27 に確認）。渡せても、候補の貯めは transport を作るときに始まるので、前もって集めた候補を使えない。

### 5.2 前回の経路の記憶

- 接続が `connected` になったら、選ばれた候補の組の種類（`host`・`srflx`・`prflx`・`relay`）と、relay なら TURN の経路（`udp`・`tcp`・`tls`）を `getStats` から読み、端末の `localStorage` に「網の指紋」（シグナリングの WebSocket の接続の先から見た公開の IP の /24 のハッシュを、API が返す）と一緒に 30 日保存する。
- 同じ網の指紋で、前回 `relay-tls` だけが通っていたら、最初から `iceTransportPolicy: "relay"` にする。直接の経路の確認を待つ時間を省き、NFR-002 の TURN の場合の目標（p95 5 秒）に収める。
- `relay` に絞って 10 秒つながらなければ、`all` で作り直す。

### 5.3 参加の応答で渡す ICE のサーバー

```jsonc
"ice_servers": [
  { "urls": [ "turn:turn-tyo-a-03.<brand>.<domain>:3478?transport=udp",
              "turn:turn-tyo-a-03.<brand>.<domain>:3478?transport=tcp",
              "turns:turn-tyo-a-03.<brand>.<domain>:443?transport=tcp" ],
    "username": "1790043200:p_7Q...",
    "credential": "vXq2...base64..." },
  { "urls": [ "turn:turn-tyo-c-01.<brand>.<domain>:3478?transport=udp",
              "turns:turn-tyo-c-01.<brand>.<domain>:443?transport=tcp" ],
    "username": "1790043200:p_7Q...",
    "credential": "vXq2...base64..." } ],
"ice_servers_expire_at": "2026-09-28T02:40:00Z"
```

- TURN は 2 台（別の AZ）を渡す。1 台目は 3 つの経路、2 台目は UDP と TLS だけ（候補の数を抑える）。
- 台は、API が TURN の台の一覧（心拍と負荷）から、会議の Media Node と同じ AZ を 1 台目に選ぶ。
- STUN の `urls`（`stun:`）は渡さない。TURN のサーバーが STUN の要求にも答えるので、server-reflexive の候補もそこで得られる。第三者の公開の STUN のサーバーは使わない（利用者の IP を第三者に送らない）。

### 5.4 経路の時間の目安

| 経路 | 参加のボタンから音声まで（p95 の目標） |
| --- | --- |
| ① UDP で直接 | 3 秒（NFR-002） |
| ③〜⑤ TURN | 5 秒（NFR-002） |

直接の経路の確認がすべて失敗するまでの時間は、ブラウザの確認の再送と間隔で決まる（RFC 8445 の Ta と、STUN の再送。RFC 8489 は UDP の初回の再送の時間を 500ms 以上とし、既定の回数は 7 回）。RFC 8445 の Ta の既定は 50ms（[RFC 8445](https://www.rfc-editor.org/rfc/rfc8445) の 14.2 節）。実際の時間はブラウザごとに異なる（**未検証**。E2 の `network-path-matrix-tests` で、UDP を閉じた網での `checking` から `connected` までを、ブラウザごとに測る）。

## 6. 網の変化と ICE restart

- クライアントは、ICE の状態が `disconnected` になって 2 秒戻らないとき、または `failed` になったとき、`media.transport.restart{transport_id}` を送る。Actor は Media Node の `transport.restartIce` を呼び、新しい `iceParameters` を返す。クライアントは `transport.restartIce({ iceParameters })` を呼ぶ。
- 端末の網が変わったこと（`navigator.connection` の変化、`online` のイベント）でも、同じ手順で ICE restart する。
- TURN の資格情報の期限（`ice_servers_expire_at`）の 30 分前に、クライアントは `media.ice_servers.refresh` で新しい資格情報を受け、次の ICE restart から使う。使っている割り当ての更新（Refresh）は古い資格情報で行うので、期限が切れた後は割り当てが続かない。期限が近づいて relay を使っているときは、新しい資格情報で ICE restart を行う。
- Media Node が替わるとき（付け替え）は、ICE restart ではなく新しい transport を作る（[media-server-sfu.md](media-server-sfu.md) の 9.3 節）。

## 7. EC2 の網

ADR-0016。

### 7.1 アドレス

| 部品 | IPv4 | IPv6 | 名前 |
| --- | --- | --- | --- |
| Media Node | 公開する範囲の Elastic IP（1 台に 1 つ） | サブネットの /64 から 1 つ | 名前は付けない（ICE の候補は IP で渡す） |
| TURN | 公開する範囲の Elastic IP（1 台に 1 つ） | 同上 | `<region>-<az>-<nn>.turn.<brand>.<domain>`（TLS の証明書のため） |

- **公開する範囲**：顧客がファイアウォールで宛先を許すために、Media Node と TURN の IPv4 を、公開した範囲に収める。候補は 2 つ。
  - BYOIP：自社で持つ IPv4 の範囲（/24 以上）を AWS に持ち込む。
  - AWS の IPAM の、Amazon が提供する連続した公開の IPv4 のブロック。/28〜/30 を、既定で 2 つまで。IPAM が要り、別の料金がかかる。アカウントの間で移せない（[Allocate sequential Elastic IP addresses from an IPAM pool](https://docs.aws.amazon.com/vpc/latest/ipam/tutorials-eip-pool.html)、2026-09-27 に確認）。東京・大阪での可否は文書に書かれておらず、E1 の `byoip-onboarding` で確かめる。
- 公開の IPv4 は、使っていてもいなくても 1 つ 1 時間 0.005 USD かかる（2024-02-01 から。[AWS の告知](https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights/)、[VPC の料金](https://aws.amazon.com/vpc/pricing/)、2026-09-27 に確認）。1 台に 1 つなので、S1 の Node の数では費用は小さい。
- Media Node をクラスタのプレイスメントグループに入れない。EC2 の 1 つのフロー（5 タプル）の帯域は、プレイスメントグループの外で 5 Gbps（[EC2 のネットワークの帯域](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-network-bandwidth.html)、2026-09-27 に確認）。参加者ごとのフローは数 Mbps なので、この上限には当たらない。
- インターネットゲートウェイを通る通信は、32 vCPU 未満のインスタンスで 5 Gbps、それ以上でインスタンスの帯域の 50% に制限される（同上）。Media Node と TURN は 32 vCPU 以上にする。

### 7.2 セキュリティグループ

EC2 は、TCP・UDP の規則が 0.0.0.0/0（または ::/0）をすべてのポートの応答にも許すとき、そのフローを追跡しない。NLB、NAT ゲートウェイ、Global Accelerator などを通る接続は、必ず追跡される。ICMP は常に追跡される。追跡しないフローは、規則を消すとすぐに切れる（[接続の追跡](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-connection-tracking.html)、2026-09-27 に確認）。

Media Node（`sg-media-node`）：

| 向き | プロトコル | ポート | 相手 | 目的 |
| --- | --- | --- | --- | --- |
| 入り | UDP | 20000–20255 | 0.0.0.0/0、::/0 | メディア |
| 入り | TCP | 20000–20255 | 0.0.0.0/0、::/0 | ICE-TCP |
| 入り | TCP | 7443 | `sg-actor-host` | 制御の API（mTLS） |
| 入り | UDP | 40000–40999 | `sg-media-node` | 台の間の PipeTransport（S2） |
| 出 | すべて | すべて | 0.0.0.0/0、::/0 | 応答を追跡させないため |

- メディアの規則は、入りと出の両方が全開なので追跡されない。制御の API とパイプの規則は相手を限るので追跡される。追跡される接続は少数で、上限に当たらない。
- 出の全開は、Media Node からの任意の外への通信を許すことになる。これは追跡を外す条件であり、外への不正な通信は、Node の上の `nftables` の出の規則（メディアの送り元のポートと、SSM・監視の宛先だけを許す）で抑える（**未検証**：`nftables` の規則が ENA の性能に与える影響を E7 の `load-l0-l2` で測る）。
- 同じ理由で、Media Node の前に NLB を置かない（本題材の AGENTS.md）。
- ネットワーク ACL は、メディアのポートの範囲と一時的なポートだけを許す（ステートレス。追跡とは関係しない）。

TURN（`sg-turn`）：

| 向き | プロトコル | ポート | 相手 | 目的 |
| --- | --- | --- | --- | --- |
| 入り | UDP・TCP | 3478 | 0.0.0.0/0、::/0 | STUN・TURN |
| 入り | TCP | 443 | 0.0.0.0/0、::/0 | TURN の TLS |
| 入り | UDP | 49152–65535 | 0.0.0.0/0、::/0 | 中継の口（Media Node からの戻り） |
| 出 | すべて | すべて | 0.0.0.0/0、::/0 | 追跡を外す |

- 中継の口への入りを全開にするのは、追跡を外すためである。中継の相手は coturn の `--allowed-peer-ip` で Media Node の範囲に限るので、他の相手からのパケットは coturn が捨てる（ADR-0015）。
- TURN の中継の口と Media Node の間の通信は、両方の公開の IP の間で行う（VPC の中のインターネットゲートウェイ経由）。プライベート IP を使わないのは、Media Node のプライベート IP を ICE の候補に出さないためである（4 節）。この通信は「Elastic IP を使う同じリージョンの中の通信」で、向きごとに 0.01 USD/GB。インターネットへの転送の料金にはならない（[infrastructure.md](infrastructure.md) の 2.4 節、2026-09-27 に確認）。

### 7.3 顧客に公開する規則

| 宛先 | プロトコル・ポート | 用途 | 無いとき |
| --- | --- | --- | --- |
| `<brand>.<domain>`、`*.<brand>.<domain>` | TCP 443 | Web、API、シグナリング（WebSocket） | 使えない |
| Media Node の範囲（IPv4・IPv6） | UDP 20000–20255 | メディア（最良） | ② 以降へ |
| Media Node の範囲 | TCP 20000–20255 | メディア（ICE-TCP） | ③ 以降へ |
| TURN の範囲 | UDP 3478、TCP 3478 | 中継 | ⑤ へ |
| TURN の範囲 | TCP 443（TLS） | 中継（最後の手段） | 参加できない |

- 範囲は `https://<brand>.<domain>/ip-ranges.json` で機械が読める形でも公開し、変更の 30 日前に知らせる。
- 本家は UDP 8801〜8810 のように少ないポートを使う（2 節）。この設計は worker ごとに 1 つのポートなので範囲が広い（256）。顧客の手間を減らすなら、IP を worker ごとに分けて 1 つのポートにする案があるが、公開の IPv4 の数が Node の vCPU の数だけ増える（13 節）。

## 8. 社内のプロキシとファイアウォール

| 網 | 起きること | この設計での扱い |
| --- | --- | --- |
| UDP を全部閉じる | ① ③ が通らない | ② ④ ⑤ |
| 外への TCP を 80・443 だけに限る | ② ④ も通らない | ⑤（TURN の TLS 443） |
| 明示の HTTP のプロキシ（CONNECT）が必須 | 直接の TCP も通らない | ブラウザが TURN の TLS をプロキシの CONNECT で通す（RFC 8828 のモード 4 の考え方）。ブラウザごとの振る舞いは**未検証**。E2 の `network-path-matrix-tests` で、Squid の CONNECT だけを許す網で Chrome・Edge・Firefox・Safari を試す |
| TLS を検査するプロキシ（中間で復号） | TURN の TLS が、プロキシの証明書に差し替えられる | ブラウザは TURN の TLS の証明書を、OS の信頼の設定で検証する見込み（**未検証**。E2 の `network-path-matrix-tests` で、検査のプロキシの証明書を入れた端末で確かめる）。検査の対象から `*.<brand>.<domain>` を外すよう、顧客の手引きに書く（本家も自社のドメインを検査から外すよう勧めている。2 節） |
| プロキシの認証（NTLM・Kerberos） | ブラウザが認証を扱えれば通る | ブラウザに任せる。通らない網は、顧客の手引きで許可の設定を求める |
| WebRTC の IP の扱いを組織の方針で制限（Chrome の `WebRtcIPHandling` など） | host の候補が出ない、UDP が使えない | TURN で通る。RFC 8828 のモード 3・4 に当たる |
| WebSocket を切るプロキシ | シグナリングがつながらない | 参加の画面で検知し、「プロキシが WebSocket を通していません」と出す。WebSocket の代わりの経路（長いポーリング）は作らない（13 節） |

- 参加の前に、任意で「接続の確認」（`/j/<id>` の画面の「回線を確かめる」）を出す。UDP・TCP・TLS の各経路で TURN と Media Node の確認用の Node に試しにつなぎ、通った経路と RTT を示す。結果は端末の中だけで使い、サーバーには経路の種類だけを送る。

## 9. IPv6

- Media Node と TURN は、IPv4 と IPv6 の両方を持つ（dual stack）。
- ブラウザは両方の候補を確かめ、通った方を使う。IPv6 だけの網（一部のモバイル）からは、IPv6 で直接つながる。
- TURN は、クライアントの求め（`REQUESTED-ADDRESS-FAMILY`・`ADDITIONAL-ADDRESS-FAMILY`）に応じて、IPv4・IPv6 の中継の口を作る（RFC 8656）。中継の相手の Media Node も両方を持つので、どちらでも届く。
- IPv6 の範囲も 7.3 節の公開の一覧に載せる。
- IPv6 にだけ効く問題（経路の MTU の違い、一部の網での IPv6 の品質の悪さ）は、候補の選び方で吸収する。IPv6 を選んだ組の品質を、IPv4 と分けて計測する（15 節）。
- **DDoS の防御のモード（`under_attack`）の Node は、IPv6 の候補を出さない。** Shield Advanced は IPv6 を守れない（[ADR-0045](../decisions/0045-ddos-defense-for-media-edge.md) と、その注記）。その Node で新しく作る transport と ICE restart の候補は IPv4（UDP・TCP）だけにする。既に IPv6 でつながっている参加者は、ICE restart で IPv4 へ移る。IPv6 だけの網の参加者は、TURN（IPv4 と IPv6 の両方の割り当て）を通る。範囲の全体への IPv6 の攻撃は、フラグ `media.ipv6_candidates` で全 Node の IPv6 の候補を止める（[security.md](security.md) の 8.3 節）。

## 10. 障害のときの振る舞い

| 障害 | 起きること | 回復 |
| --- | --- | --- |
| TURN の 1 台が落ちた | その台で中継していた参加者のメディアが止まる | クライアントが `disconnected` を検知し、2 台目の TURN の候補が残っていればそちらへ。なければ `media.ice_servers.refresh` と ICE restart。目標は 5 秒（**未検証**。E2 の `ice-restart-flow` で測る） |
| TURN の全台が落ちた | 直接つながらない参加者が入れない | 直接つながる参加者には影響しない。TURN の台の自動の回復（ASG） |
| 資格情報の秘密の入れ替えを誤った | 新しい参加者の TURN が通らない | 秘密は 2 つ（今と次）を同時に受ける（11 節） |
| 網が変わった（Wi-Fi → モバイル） | 経路が切れる | 6 節の ICE restart |
| NAT の対応付けが切れた（長い無音） | 片方向の通信が止まる | ICE の同意の確認（約 5 秒ごと）が対応付けを保つ。切れたら ICE restart |
| Elastic IP の付け替えを誤った | Node の候補の IP と実際の IP が違う | Node Agent は起動時に、インスタンスのメタデータの公開の IP と `announcedAddress` の一致を確かめ、違えば `active` にならない |
| セキュリティグループの規則が追跡される形に変わった | 接続の追跡の上限でパケットが捨てられる | `conntrack_allowance_exceeded` の警報。Terraform の検査で変更を止める（16.3 節） |

## 11. セキュリティ

### 11.1 TURN の資格情報

- API が参加の応答で発行する（5.3 節）。
  - `username = "<失効の時刻の UNIX 秒>:<participant_id>"`
  - `credential = base64(HMAC-SHA1(秘密, username))`
  - 有効期間 12 時間。
- 秘密は AWS Secrets Manager に置き、90 日ごとに入れ替える。coturn は今の秘密と次の秘密の 2 つを受ける（`--static-auth-secret` を複数行、または `turn_secret` の表）。coturn は、静的な設定とデータベースのどちらでも複数の共有の秘密を使える（[README.turnserver](https://github.com/coturn/coturn/blob/master/README.turnserver) の `--static-auth-secret`、2026-09-27 に確認）。
- 資格情報は、参加者（`participant_id`）と会議の参加の許可に結び付く。会議の外で使える期間は、有効期間の 12 時間に限られる。退出させた人の資格情報は取り消せない（HMAC の形のため）が、中継の相手が Media Node の範囲だけなので、会議の外では中継に使えない（11.2 節）。Media Node の側では、その人の transport は閉じられている。
- HMAC-SHA1 を使うのは、coturn と草案の形に合わせるためである。STUN の `MESSAGE-INTEGRITY` の方式と同じで、秘密の長さ（32 バイト以上）で強さを保つ。RFC 8489 の `MESSAGE-INTEGRITY-SHA256` を使えるかは、ブラウザの対応による（**未検証**。使えなくても設計は変わらない。E2 の `turn-rest-credentials` で記録だけする）。

### 11.2 TURN を踏み台にさせない

- coturn の中継の相手を、Media Node の公開する範囲（IPv4・IPv6）だけに限る（IPv4 と IPv6 の全体を `--denied-peer-ip` にし、Media Node の範囲を `--allowed-peer-ip` にする。coturn は両方に当たるとき許可を優先する）。
- ループバック、マルチキャスト（`--no-multicast-peers`）、VPC の中のプライベートの範囲、インスタンスのメタデータ（169.254.169.254）への中継を拒否する。RFC 8656 の安全の考え方（中継する相手の制限）に従う。
- TCP の中継（RFC 6062）は使わない（`--no-tcp-relay`）。Media Node との間は UDP だけ。
- 1 人あたりの割り当ての数（`--user-quota=4`：送りと受けの transport × IPv4・IPv6）と、1 つの割り当ての帯域（`--max-bps` 10 Mbps）を限る。
- TLS は 1.2 以上（`--no-tlsv1`、`--no-tlsv1_1`）。証明書は `*.turn.<brand>.<domain>` のワイルドカードで、自動で更新する（ACM の書き出せる公開の証明書。[security.md](security.md) の 5 節）。ワイルドカードはいちばん左のラベル全体にしか置けないので、`turn-*` の形の名前は使えない。

### 11.3 Media Node

- ICE の認証（transport ごとの乱数の `ice-ufrag`・`ice-pwd`）を通らない STUN と、DTLS の指紋の合わないパケットを捨てる。
- 候補にプライベート IP を出さない（`exposeInternalIp: false`）。

### 11.4 利用者の IP の扱い

- 利用者の IP は、Media Node と TURN のログに残る。IP は個人情報になりうるので、保持を 30 日にし（security.md で決める）、捜査機関からの照会への扱いは法務の確認待ち（intent.md の L4）。
- 5.2 節の網の指紋は、IP の /24 のハッシュを端末に保存するだけで、サーバーに IP の履歴を残さない。
- 第三者の STUN のサーバーを使わない（5.3 節）。

## 12. テスト

### 12.1 経路ごとの結合テスト

Playwright で実際のブラウザ（Chrome・Edge・Firefox・Safari）を動かし、端末の網を `iptables`・`nftables` で絞る。

| 網の条件 | 期待する経路 | 合格 |
| --- | --- | --- |
| 制限なし | ① | 参加から音声まで p95 3 秒 |
| UDP を全部落とす | ② | 5 秒 |
| UDP と、443 以外の TCP を落とす | ⑤ | 5 秒 |
| 443 以外を落とし、CONNECT だけの HTTP のプロキシ（Squid）を必須にする | ⑤（プロキシ経由） | 参加できる（時間は記録。プロキシ経由の時間は**未検証**のため、閾値は E2 の `network-path-matrix-tests` の後に決める） |
| UDP 3478 だけを許す | ③ | 5 秒 |
| IPv6 だけの網（NAT64 なし） | ① の IPv6 | 3 秒 |
| 前回 ⑤ だった網の指紋で再び参加 | 最初から relay | 3.5 秒 |

### 12.2 回線の劣化（本題材の AGENTS.md の条件）

- 各経路（①・②・⑤）で、損失 5%・20%（ランダム、バースト）、揺らぎ 30・100ms、下りの帯域の 3 Mbps → 500 kbps → 150 kbps と回復、RTT 200ms を加え、音声の MOS の推定と遅れを測る。
- TCP の経路（②・④・⑤）は、損失で遅れが大きく伸びる。NFR-003 の損失 20% は、UDP の経路（①・③）で満たすことを求め、TCP の経路では計測して記録する（閾値は [quality.md](../quality.md) の 2.2.1 節。QA が承認した値）。

### 12.3 障害の注入

| 注入 | 期待 |
| --- | --- |
| TURN の 1 台を止める | 中継していた参加者の音声が戻る（時間を記録。目標 5 秒） |
| 端末の網を切り替える（Wi-Fi を切り、別の網へ） | ICE restart で戻る |
| NAT の対応付けを消す（`conntrack -F` を試験の NAT の上で） | 同意の確認か ICE restart で戻る |
| TURN の秘密を入れ替える | 入れ替えの間も新しい参加が通る |

### 12.4 セキュリティの試験

- 有効な TURN の資格情報で、Media Node の範囲の外（インターネットの任意の IP、VPC の中の IP、169.254.169.254、127.0.0.1）への `CreatePermission` が拒否される（`403 Forbidden`）。
- 期限の切れた `username` の割り当てが拒否される。
- Media Node の ICE の候補に、プライベート IP が含まれない。

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `media-edge-addressing` | 7.1 節。公開する IPv4 の範囲（BYOIP か連続したブロック）、Elastic IP、IPv6 |
| E1 | `media-sg-untracked` | 7.2 節のセキュリティグループと Terraform の検査 |
| E2 | `media-node-ice-lite-candidates` | 4 節。`listenInfos`、`announcedAddress` の起動時の確認 |
| E2 | `turn-coturn-deploy` | coturn の AMI、UDP・TCP 3478、TLS 443、中継の相手の制限、証明書 |
| E2 | `turn-rest-credentials` | 11.1 節。API での発行、秘密の入れ替え |
| E2 | `client-ice-config` | 5.1〜5.3 節。`iceServers`、前回の経路の記憶 |
| E2 | `ice-restart-flow` | 6 節。ICE restart と資格情報の更新 |
| E2 | `network-path-matrix-tests` | 12.1 節の網の条件ごとの試験を CI で回す |
| E2 | `preflight-network-check` | 8 節の「回線を確かめる」 |
| E2 | `customer-firewall-doc` | 7.3 節の規則の公開と `ip-ranges.json` |
| E4 | `path-quality-netem` | 12.2 節 |

## 14. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。公開する規則は Ops が確かめてから出す。

- **STUN**：単独の STUN のサーバーを置かない。第三者の STUN を使わない。
- **Media Node の候補**：公開の IPv4・IPv6、UDP と ICE-TCP、同じポート。プライベート IP を出さない。
- **TURN の実装**：coturn（13 節の比較と ADR-0015）。
- **TURN の経路**：UDP 3478、TCP 3478、TLS 443。5349 は開けない（企業の網で通らないことが多く、443 で足りる）。
- **資格情報の有効期間**：12 時間。
- **中継の相手**：Media Node の範囲だけ。
- **前回の経路の記憶**：30 日、網の指紋ごと。
- **ポートの範囲**：256 のまま。worker ごとに IP を分けない。
- **WebSocket を通さないプロキシ**：代わりの経路は作らない。ベータで該当する顧客の割合を記録する。

### TURN の実装の比較（ADR-0015 の要約）

| 候補 | 良い点 | 悪い点 |
| --- | --- | --- |
| coturn | 実績が長い。RFC 8656・REST API の形・中継の相手の制限・割り当ての上限を持つ。BSD の 3 条項 | C の実装で、脆弱性の対応を追う必要がある |
| 自前（Pion の turn のライブラリなどで書く） | 資格情報や監視を好きに作れる | 作って試験する量が増える。制御の言語（TypeScript）と違う |
| Media Node に TURN の役を持たせる（SFU に組み込む） | 中継の 1 ホップが減る | mediasoup は TURN を持たない。443 番を Node で使うと worker ごとのポートの設計と合わない |
| 外部の TURN のサービス | 運用が要らない | 利用者の IP とメディアの経路が第三者を通る（intent.md の L2・L6）。費用が転送の量に比例する |

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 公開する IPv4 の範囲の入手の時間と費用 | BYOIP の /24 に決めた（[ADR-0049](../decisions/0049-media-node-fleet.md)）。入手は E1 の前に Ops が始め、間に合わなければ AWS の連続したブロックで始める |
| CONNECT のプロキシでの各ブラウザの TURN の TLS の振る舞い | E2 の `network-path-matrix-tests`（12.1 節） |
| TURN を通る参加者の割合 | E2 のベータで計測し、TURN の台の数（capacity.md）に渡す |
| `MESSAGE-INTEGRITY-SHA256` を使えるか | ブラウザの対応を E2 の `turn-rest-credentials` で記録する（設計は変わらない） |
| Media Node と TURN の間を公開の IP で通す通信の料金の区分 | 決着：同じリージョンの中の 0.01 USD/GB（向きごと）。料金のデータの `APN1-DataTransfer-Regional-Bytes` が「using elastic IPs」を含む（[infrastructure.md](infrastructure.md) の 2.4 節、2026-09-27 に確認） |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 選ばれた経路（①〜⑤、IPv4・IPv6）の割合。組織・網の指紋ごと。
- 経路ごとの、参加から音声までの時間の p50・p95。
- ICE の失敗率（`failed` で終わった参加の割合）と、ICE restart の回数と成功率。
- TURN の台ごとの割り当ての数、中継の帯域、拒否した `CreatePermission` の数。
- 経路ごとの音声の MOS の推定と、映像の停止の回数（TCP の経路の品質を分けて見る）。

### runbooks

- `turn-node-failure.md`：TURN の台が落ちたときの確かめ方と、DNS・API の一覧からの外し方。
- `turn-secret-rotation.md`：TURN の秘密を入れ替える手順（次の秘密を足す → API を切り替える → 12 時間待つ → 古い秘密を消す）。
- `customer-network-cannot-join.md`：顧客の網から入れないという問い合わせへの確かめ方（参加の記録の経路の種類、ICE の失敗、プロキシ、公開の規則の案内）。
- `conntrack-allowance-exceeded.md`：Media Node・TURN で `conntrack_allowance_exceeded` が増えたときの確かめ方（セキュリティグループの規則の変化）と戻し方。
- `media-ip-range-change.md`：公開する範囲を変えるときの顧客への告知と切り替えの手順。

### data-model（索引への追加の提案）

確定した形は [data-model/meeting-runtime.md](data-model/meeting-runtime.md) と [data-model/stores.md](data-model/stores.md) にある。

| 置き場所 | 中身 |
| --- | --- |
| Secrets Manager `turn/static-auth-secret` | 今と次の秘密 |
| Valkey `turn:{node_id}:load` | TURN の台の心拍と割り当ての数（TTL 5 秒） |
| Aurora `meeting_participations` に足す列 | `ice_path`（`udp_direct`・`tcp_direct`・`turn_udp`・`turn_tcp`・`turn_tls`）、`ip_family`（診断と品質の集計。IP そのものは持たない） |
| 公開の `ip-ranges.json` | Media Node と TURN の範囲、更新の日付 |
| ブラウザの `localStorage` | 網の指紋ごとの前回の経路（30 日） |

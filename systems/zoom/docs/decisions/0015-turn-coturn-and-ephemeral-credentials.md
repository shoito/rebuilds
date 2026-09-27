---
status: accepted
date: 2026-09-27
---

# ADR-0015: TURN は coturn を自前で動かし、UDP・TCP 3478 と TLS 443 で待ち、一時的な資格情報を使い、中継の相手を Media Node に限る

## Context

[ADR-0001](0001-platform-and-stack.md) は、TURN を自前でホストし、実装（coturn か、SFU に組み込む形か）をこの領域で決めるとした。社内の網には、UDP を閉じる、外への TCP を 443 に限る、HTTP のプロキシを必須にする、といった制限がある。

確かめたこと（いずれも 2026-09-27 に確認）：

- TURN（[RFC 8656](https://www.rfc-editor.org/rfc/rfc8656)）の既定のポートは 3478（UDP・TCP）、TLS・DTLS は 5349。割り当ての既定の寿命は 600 秒で、上限は 3,600 秒以下を推奨。IPv6 と両方の割り当てを扱う。
- 本家の会議のクライアントは、TCP 443・8801・8802、UDP 3478・3479・8801〜8810 を使う。HTTPS のプロキシは 443 番で対応する（[Zoom network firewall or proxy server settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060548)）。
- TURN REST API の草案は、`username = 失効の時刻:利用者`、`password = base64(HMAC(秘密, username))` の一時的な資格情報を定め、有効期間 1 日を勧める。2013 年の個人の草案で、失効している（[draft-uberti-behave-turn-rest-00](https://datatracker.ietf.org/doc/html/draft-uberti-behave-turn-rest-00)）。
- coturn は、この形（`--use-auth-secret`・`--static-auth-secret`）、中継の相手の許可と拒否（`--allowed-peer-ip`・`--denied-peer-ip`。両方に当たれば許可）、マルチキャストの拒否、TCP の中継の無効、割り当てと帯域の上限、TLS 1.2 以上の強制を持つ（[README.turnserver](https://github.com/coturn/coturn/blob/master/README.turnserver)）。BSD の 3 条項のライセンスで、2026-09-08 に 4.18.0 を出している（[Releases](https://github.com/coturn/coturn/releases)）。
- mediasoup は TURN を持たない。

TURN を誰でも使える中継にすると、攻撃者は TURN を踏み台にして、VPC の中や任意の相手へパケットを送れる。

## Options

実装：

1. **coturn を EC2 で自前で動かす**
2. **自前の TURN（Pion の turn などで書く）**
3. **Media Node に TURN の役を持たせる**
4. **外部の TURN のサービス**

資格情報：

- a. **TURN REST API の形の一時的な資格情報（HMAC、有効 12 時間）を、参加の応答で渡す**
- b. **利用者ごとの長期の資格情報（データベース）**

## Decision

1 と a を採用する。詳細は [network-traversal.md](../architecture/network-traversal.md) の 5.3・7・11 節。

- coturn を EC2（32 vCPU 以上、公開の IPv4 と IPv6）で動かし、UDP 3478、TCP 3478、TLS 443 で待つ。5349 は開けない。
- 資格情報は `username = "<失効の UNIX 秒>:<participant_id>"`、`credential = base64(HMAC-SHA1(秘密, username))`、有効期間 12 時間。秘密は Secrets Manager に置き、90 日ごとに入れ替える（今と次の 2 つを受ける）。
- 中継の相手を Media Node の公開する範囲だけにする（IPv4・IPv6 の全体を拒否し、Media Node の範囲を許可）。ループバック、マルチキャスト、プライベートの範囲、インスタンスのメタデータへの中継を拒否する。TCP の中継は使わない。
- 1 人の割り当ては 4 つまで、1 つの割り当ては 10 Mbps まで。
- クライアントには、Media Node と同じ AZ の 1 台と、別の AZ の 1 台を渡す。
- 2 を採らない理由：TURN の実装と試験の量が増え、得るものが少ない。
- 3 を採らない理由：mediasoup に TURN がない。443 番を Media Node で待つと、worker ごとのポート（[ADR-0010](0010-media-node-process-layout.md)）と合わない。
- 4 を採らない理由：利用者の IP とメディアの経路が第三者を通る（intent.md の L2・L6）。費用が転送の量に比例する。
- b を採らない理由：長期の資格情報は漏れたときの影響が長く、発行と失効の状態を TURN と共有する必要がある。一時的な資格情報なら、API と TURN は秘密を共有するだけでよい。

## Consequences

- 良くなること：
  - 443 番しか通らない網からも参加できる。
  - TURN を奪われた資格情報で使われても、中継の先は Media Node だけで、踏み台にならない。
  - API と TURN の間に状態の共有が要らない。
- 引き受けるコスト：
  - HMAC の資格情報は、有効期間の中で取り消せない。退出させた人の資格情報も 12 時間は TURN に割り当てを作れる（中継の先は Media Node だけで、Media Node ではその人の transport は閉じている）。
  - 12 時間を超える会議では、資格情報を更新して ICE restart する処理が要る。
  - coturn の脆弱性の対応と、TLS の証明書の自動の更新を運用する。
  - TURN を通る参加者の転送は、TURN と Media Node の両方で数えられ、費用が増える。

## Confirmation

- セキュリティの試験：有効な資格情報で、Media Node の範囲の外（任意の公開の IP、VPC の中、169.254.169.254、127.0.0.1）への許可の作成が 403 で拒否される。
- 結合テスト：UDP と 443 以外の TCP を落とした網から、TURN の TLS 443 で参加でき、音声まで p95 5 秒以内（NFR-002）。
- 結合テスト：秘密の入れ替えの間も、新しい参加が TURN を通れる。

---
status: accepted
date: 2026-09-27
---

# ADR-0030: アプリとの常時の接続は gRPC の双方向ストリーム 1 本にし、Go の rt-gateway で受ける

詳細は [notifications-and-realtime-push.md](../architecture/notifications-and-realtime-push.md) の 3 節。

## Context

乗客とドライバーのアプリには、オファー、乗車の状態の変化、車の位置を、数秒以内に届ける必要がある（NFR-008、[ADR-0015](0015-offer-protocol-decision-log-and-replay.md) の 5 秒の受信の確認）。プッシュ通知だけでは、届いたかが分からず、遅れも読めない。

本家は、配信の基盤（RAMEN）を SSE で作ったが、書いたメッセージが届いたかが最大 30 秒分からず、期限の短いオファーを送り直せなかった。そこで gRPC の双方向ストリームに移し、受信の確認を同じ接続の逆向きで即時に返すようにした（[Uber's Real-Time Push Platform](https://www.uber.com/gb/en/blog/real-time-push-platform/)、[Uber's Next Gen Push Platform on gRPC](https://www.uber.com/us/en/blog/ubers-next-gen-push-platform-on-grpc/)、いずれも 2026-09-27 に確認）。

ALB は gRPC を HTTP/2 のまま転送できる（[AWS の告知](https://aws.amazon.com/about-aws/whats-new/2020/10/application-load-balancers-enable-grpc-workloads-end-to-end-http-2-support/)、2026-09-27 に確認）。[ADR-0001](0001-platform-and-stack.md) は、Go のサービスを位置の取り込み・索引・配車の 3 つに限り、増やすには ADR を求めた。

## Options

1. **gRPC の双方向ストリーム（HTTP/2、TLS）。受け手は Go のサービス**
2. **WebSocket（独自の枠組み。受け手は TypeScript）**
3. **MQTT（AWS IoT Core か自前のブローカー）**
4. **SSE（下り）＋ HTTPS（上りの確認）**

## Decision

1 を採用する。

- 受け手 1 人に接続 1 本。`Connect(stream ClientFrame) returns (stream ServerFrame)`。最初に `Hello`（プロトコルの版、端末の ID、`resume_after_seq`、`stream_epoch`）を送り、`Ready` を受ける。
- 認証はメタデータのアクセストークン。受け手の鍵はトークンから決める。
- 心拍は両方向 20 秒、40 秒で切る。ALB の待ちの時間切れ（既定 60 秒）より短くする。
- 同じ受け手の新しい接続が来たら、古い接続を `Goaway(replaced)` で閉じる。
- `rt-gateway` は Go で書き、ADR-0001 の Go のサービスの一覧に加える。車の位置の配信（`trip-location-fanout`）は同じバイナリの別の役として動かす。理由は、数万の長い接続と、Kinesis の読み手を、少ない資源で持つため。
- 接続の持ち主は Valkey の登録表（TTL 90 秒）で引き、ノード宛ての Pub/Sub で渡す。`rt-gateway` は DB に書かない。
- QUIC は S1 で使わない。
- 2 を採らない理由：Web のクライアントがないので WebSocket の利点が小さく、受信の確認と型の枠組みを自前で作ることになる。
- 3 を採らない理由：乗車ごとにトピックの権限を付け外しする仕組みが要り、ブローカーの運用か IoT Core の条件の検討が増える。
- 4 を採らない理由：本家が SSE で困った受信の確認の遅れを、そのまま抱える。

## Consequences

- 良くなること：
  - オファーの受信の確認が接続の中で即時に返り、5 秒の取り下げの判定に使える。
  - 型は Protocol Buffers の 1 つの定義から生成できる。
- 引き受けるコスト：
  - Go のサービスが 1 つ増える（言語の運用の範囲は変わらない）。
  - gRPC のモバイルのライブラリの版の追従と、ALB の HTTP/2 の上限（接続あたりの流れの数など）の確かめが要る。
  - ALB は HTTP/2 の PING のフレームに対応せず、PING は待ちの時間切れ（既定 60 秒）を延ばさない（[Edit attributes for your Application Load Balancer](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)、2026-09-27 に確認）。そのため、アプリの層で心拍を送る。
  - ALB は、接続の開始から HTTP client keepalive duration（既定 3,600 秒、60 秒〜7 日）が過ぎると、HTTP/2 の接続に `GOAWAY` を送って閉じる（同じ文書）。`rt.<domain>` の ALB は 24 時間（86,400 秒）にし、それでも来る `GOAWAY` はアプリの再接続（配備のときと同じ扱い）で受ける。

## Confirmation

- 負荷試験：3 万接続で、オファーの作成から `OfferDelivered` まで p95 1.5 秒・p99 4 秒。
- 障害注入：`rt-gateway` のタスクの強制終了と配備の切り替えで、再接続と送り直しが働くこと。
- レビュー：`rt-gateway` に DB への書き込みや業務の判断を入れる変更を差し戻す。

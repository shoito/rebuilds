---
status: accepted
date: 2026-09-28
---

# ADR-0035: Webhook はイベントのログの上の宛先ごとのカーソルで送って <Brand>-Signature で署名し、外向きの呼び出しは登録した宛先だけにし、どちらも宛先を検査して内部に経路のない送信の網から送る

詳細は [events-and-integrations.md](../architecture/events-and-integrations.md) の 5 節と 6 節。

## Context

intent は、変更のイベントと組織が定義するイベントを、外向きの Webhook でも届けることを MVP に含める。[ADR-0025](0025-flow-definition-and-bulk-engine.md) は、フローの `call_webhook` を outbox に書くだけにし、確定の後に送り、応答を待たないとした。[automation-flows.md](../architecture/automation-flows.md) の 12 節は、`call_webhook` の宛先を組織が登録した一覧だけにするとした。

送る先の URL は組織の管理者が決める。宛先の検査に漏れがあると、本システムの内部（DB、メタデータのサービス、IMDS）に届く（SSRF）。宛先を乗っ取られた管理者が変えると、組織の全てのデータが外へ出る。

本家の Webhook・アウトバウンドメッセージの署名の方式は確かめられなかった（未検証）。rebuilds の他の題材では、Stripe の再構築が本文の署名（`<Brand>-Signature: t=…,v1=…`）と、内部に経路のない送信の VPC と固定の IP を決めた（[stripe の ADR-0025](../../../stripe/docs/decisions/0025-webhook-signing-and-isolated-delivery.md)）。Auth0 の再構築は、ログのストリームを宛先ごとのカーソルで送る形を決めた（[auth0 の ADR-0044](../../../auth0/docs/decisions/0044-log-stream-delivery.md)）。

## Options

Webhook の配信：

1. **イベントのログ（[ADR-0033](0033-change-event-log-and-replay.md)）の上の、宛先ごとのカーソル。成功の後にだけ進める。1 つの宛先の送り手は 1 つ**
2. イベント × 宛先の配信の記録を持ち、1 件ずつ再試行する

送る場所：

- a. **内部に経路のない送信の VPC（Elastic IP の NAT だけ）。署名は本体で行い、送り手に秘密を渡さない。アプリの宛先の検査を重ねる**
- b. 本体の VPC の Worker から NAT で送る

## Decision

1 と a を採用する。

- Webhook の宛先は、`sources`（チャンネルとイベントの型）と `run_as_user_id` を持つ。配信の判定（[ADR-0034](0034-event-subscription-access-and-org-events.md) の DT-EVT-001 と FLS）は `run_as` の利用者で行う。
- 送り手は `replay_id > cursor` を最大 100 件・1MB 読み、JSON の配列で 1 回の POST にする。2xx でカーソルを進める。少なくとも 1 回。宛先ごとの `replay_id` の順で送るので、レコードごとの順序も守られる。
- 署名は `<Brand>-Signature: t=<秒>,v1=hex(HMAC-SHA256(秘密, "{t}.{本文}"))`。秘密は `<brand>_whsec_` で始まる 32 バイトで、入れ替えでは古い秘密を 24 時間まで残し `v1=` を 2 つ並べる。`<Brand>-Delivery-Id` を付ける。
- 再試行は 1 秒・5 秒・30 秒、その後 1 分〜1 時間。最初の失敗から 72 時間でイベントの保持（3 日）の前に `disabled` にし、管理者に知らせる。
- 外向きの呼び出しは `outbound_endpoints`（`base_url`、認証の種類と暗号化した秘密）に登録した宛先だけにし、フローはパスと本文だけを式で作る。再試行 5 回、`<Brand>-Delivery-Id` で冪等。1 トランザクション 100 件。
- 宛先の検査：`https`・443 だけ、IP のリテラルの拒否、送る時の名前解決の全てのアドレスの検査（ループバック、プライベート、リンクローカル、CGNAT、予約、本システムのアドレス）、検査したアドレスへの直接の接続、リダイレクトを追わない、接続 3 秒・全体 10 秒。
- 送信の VPC は本体・DB・VPC エンドポイントへの経路を持たない。送信元の IP を公開する。
  > 2026-09-28 の注記：「送信の VPC」は、本番とは別の **prod-egress のアカウント**の VPC とした（[ADR-0054](0054-accounts-network-and-service-separation.md)）。本番の Worker（webhook-sender）が署名を付け、署名済みの要求を prod-egress のアカウントの SQS（本番の Worker には `SendMessage` だけを許す）に入れる。prod-egress の送り手（`sender`）は秘密を持たず、SQS から取り出して宛先の検査をしてから送り、結果は別の SQS で本番へ戻す。本番とのピアリング・Transit Gateway・VPC エンドポイントは持たない（[infrastructure.md](../architecture/infrastructure.md) の 2.2 節）。
- 宛先の作成・変更は `manage_integrations` を要し、監査に残し、組織の管理者全員に知らせる。
- 2 は、1 日数千万のイベント × 宛先の記録を書くことになり、イベントのログと同じ量の書き込みがもう 1 つ増える。
- b は、宛先の検査に漏れがあると、本体の VPC の中の資源に届く。

## Consequences

- 良くなること：
  - 配信の記録が宛先ごとに 1 行（カーソル）で済み、再送とカーソルの巻き戻しが同じ仕組みで書ける。
  - 受け手は、署名と送信元の IP の 2 つで本物かを確かめられる。
  - 宛先の検査に漏れがあっても、内部に届かない。送り手が乗っ取られても署名を偽れない。
- 引き受けるコスト：
  - 1 件の不正なイベントで宛先の全体が止まりうる。24 時間の 4xx で 1 件ずつに分けて、拒否される 1 件を飛ばす。
  - 送信の VPC と NAT を別に持ち、IP の変更を事前に知らせる運用が要る。
  - 72 時間を超える宛先の停止は、イベントの欠けになる。

## Confirmation

- 性質ベーステスト：任意の送信の失敗の列で、宛先が受け取った `event_id` の集合が、合うイベントの集合を含む。
- 結合テスト：署名の検証（正しい秘密、入れ替え中、改ざん、古い `t`）。72 時間で `disabled`、再開で続きから、保持の外で欠けの知らせ。
- SSRF のテスト：拒否するアドレス、内部へのリダイレクト、DNS の再バインド、IPv4 に写した IPv6。
- IaC の検査：送信の VPC にピアリング・TGW・VPC エンドポイントがない。

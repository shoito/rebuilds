---
status: accepted
date: 2026-09-26
---

# ADR-0025: Webhook は本家の署名方式で署名し、固定の IP を持つ隔離された egress VPC から送る

## Context

加盟店は、決済の成功・入金・Dispute を Webhook で受け取り、注文の確定や会計に使う。Webhook の配信には 3 つの要求がある。

- **本物であることの証明**：偽の Webhook で注文を確定させられると、加盟店の損失になる。本家は `Stripe-Signature` ヘッダー（`t=` と `v1=` の HMAC-SHA256）で署名し、SDK の検証は 5 分の許容幅を既定にしている。秘密の入れ替えでは、旧い秘密を最大 24 時間残せる（[Webhook](https://docs.stripe.com/webhooks)、2026-09-26 に確認）。
- **送信元の IP の許可リスト**：本家は Webhook の送信元の IP を公開し、署名の検証と合わせて許可リストを勧めている（[IP アドレス](https://docs.stripe.com/ips)）。加盟店のファイアウォールで、決まった IP からだけ受ける運用がある。
- **SSRF への備え**：送信先の URL は加盟店が自由に決める。内部のサービスや、認証情報のエンドポイントに届いてはならない。

Slack では、利用者が指定した URL への送信を、VPC に接続しない、権限を持たない Lambda で行った（Slack の ADR-0016、apps.md の 13 節）。ただし、この方式では送信元の IP を固定できない。Slack の Events API は署名の検証だけを求めたが、本家の Stripe に寄せるなら IP の固定が要る。

## Options

1. **VPC に接続しない Lambda（Slack の ADR-0016 と同じ）**。送信元の IP は固定しない
2. **専用の egress VPC（内部への経路なし）に置いた Lambda と、Elastic IP 付きの NAT ゲートウェイ**
3. **本体の VPC の中の Worker（ECS）から、NAT ゲートウェイ経由で直接送る**
4. **署名の方式を Standard Webhooks（Slack の apps.md の 8 節）にする**

## Decision

署名は本家の方式、送信は 2 を採用する。

- **署名**：ヘッダーは本家の `Stripe-Signature` と同じ形式（`t=<UNIX 秒>,v1=<hex(HMAC-SHA256(秘密, "{t}.{本文}"))>`）。ヘッダー名は `<Brand>-Signature`、秘密はエンドポイントごとの `<brand>_whsec_` で始まる 32 バイトにする（本家の名前・接頭辞を使わない。リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。入れ替えでは、旧い秘密を「すぐ」か「最大 24 時間」残し、重なりの間は `v1=` を 2 つ並べる。再試行ごとに署名とタイムスタンプを作り直す。4 は検証の実装が多い点で良いが、本家の SDK と加盟店の既存の検証のコードを、ヘッダー名の差し替えだけで使える方を選ぶ。
- **署名する場所**：本体の VPC の中の webhook-sender（ECS）。秘密は KMS で暗号化して DB に置き、sender のタスクロールだけが復号できる。送信器には署名済みの要求だけを渡し、秘密を渡さない。
- **送信する場所**：専用の egress VPC の Lambda。
  - egress VPC には、本体・CDE とのピアリング、Transit Gateway、VPC エンドポイントを置かない。外へ出る経路は NAT ゲートウェイだけ。
  - NAT ゲートウェイの Elastic IP を、送信元の IP として公開する。
  - Lambda の実行ロールはログの書き込みだけ。呼び出せるのは webhook-sender だけ。
  - アプリの宛先の検査（Slack の ADR-0016 の拒否リスト、検査したアドレスへの直接の接続、リダイレクトを追わない）を重ねる。
- 1 は、隔離の強さは同じだが、送信元の IP を固定できず、本家の運用（IP の許可リスト）に合わない。
- 3 は、宛先の検査に漏れがあると、本体の VPC の中の資源に届く。

## Consequences

- 良くなること：
  - 加盟店は、本家と同じ手順（署名の検証と IP の許可リスト）で Webhook を守れる。本家の SDK の検証の実装を流用できる。
  - 宛先の検査に漏れがあっても、内部に届かない。送信器に秘密がないので、送信器が乗っ取られても署名を偽造できない。
- 引き受けるコスト：
  - egress VPC、NAT ゲートウェイ、Elastic IP を別に持つ。NAT の処理の費用が Webhook の量に比例してかかる。
  - Lambda が VPC に接続するので、ENI の作成と同時実行の上限を、容量の計画に含める（[capacity.md](../architecture/capacity.md)）。
  - 公開した IP を変えるときは、事前に告知する必要がある。
  - Slack の ADR-0016 の方式（VPC に接続しない）とは、構成が分かれる。

## Confirmation

- 結合テスト：本家の公開の SDK（`stripe-node` の `webhooks.constructEvent`）の検証の手順（ヘッダー名だけ差し替え）で、本システムの署名が通る。入れ替え中の新旧どちらの秘密でも通る。
- SSRF のテスト：拒否すべきアドレス、内部を指すリダイレクト、DNS の再バインドで送信されない。
- IaC の検査：egress VPC にピアリング・TGW・VPC エンドポイントがない。Lambda の実行ロールの権限がログの書き込みだけ。`lambda:InvokeFunction` を持つのは webhook-sender だけ。
- 合成監視：外部の受け手に届いた Webhook の送信元の IP が、公開の一覧に含まれる。

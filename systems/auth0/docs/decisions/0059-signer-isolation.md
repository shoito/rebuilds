---
status: accepted
date: 2026-09-27
---

# ADR-0059: Signer を外への経路のない専用のサブネットに置き、呼べるのは Auth のタスクだけにする

## Context

[ADR-0003](0003-token-formats-and-signing-keys.md) は、署名の秘密鍵を KMS でエンベロープ暗号化し、Signer のサービスの中でだけ復号して署名すると決めた。Signer のメモリーには、多数のテナントの秘密鍵が平文で載る。Signer が乗っ取られると、多数のテナントのどのユーザーにもなりすませる。

Signer をどう隔離するかを、この領域で決める。前提：

- Nitro Enclaves は EC2 の機能で、指定のインスタンスタイプの EC2 の親インスタンスを要件とする。Fargate はその対象にないので、使えない（[What is Nitro Enclaves?](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html)、2026-09-27 に確認）。
- Signer の要求は、S1 のピークで最大 1 秒 6,000 回の署名（トークンの発行 3,000 件 × 2）。遅延の予算は `/oauth/token` の p99 150ms の中にある（NFR-003）。

## Options

1. **同じ prod のアカウントで、Signer を専用のサブネットに置く。** サブネットにインターネットへの経路を持たせず、セキュリティグループで Auth のタスクからの相互 TLS だけを受ける
2. Signer を別の AWS アカウントに置き、PrivateLink＋相互 TLS で呼ぶ（Stripe の CDE と同じ形）
3. Signer を EC2 に置き、Nitro Enclaves の中で署名する

## Decision

1 を採用する。S3 の前に 2・3 を再評価する。

### ネットワーク

- **専用のサブネット `signer` を 3 AZ に置く。** 経路表に NAT・Internet Gateway への経路を持たない。AWS のサービスへは VPC エンドポイント（KMS、ECR、CloudWatch Logs、STS、Secrets Manager、X-Ray、AppConfig）だけで出る。KMS の VPC エンドポイントのポリシーで、署名鍵の KMS の鍵への `Decrypt` を Signer のロールに限る。
- **入口は内部の NLB（TLS のパススルー）1 つ。** セキュリティグループは、`auth` のタスクのセキュリティグループからの 1 つのポートだけを許す。Management API・Worker・ダッシュボードからは届かない。
- **相互 TLS**：Signer と Auth のクライアント証明書は AWS Private CA で発行し、有効期間は 7 日にして自動で更新する。Signer は、クライアント証明書のサービス名が `auth` のものだけを受ける。

### タスク

- Fargate（ARM64）。`readonlyRootFilesystem`、Linux の capabilities を全部落とす、ECS Exec を無効にする（[ADR-0056](0056-operator-access.md)）。コアダンプを出さない（`ulimit core 0`）。
- コンテナのイメージは、Signer の専用の最小のイメージ（依存は `jose`、HTTP の最小のサーバー、OpenTelemetry だけ）。ネイティブのアドオンを入れない。
- 秘密鍵は、署名の要求で初めて使う時に復号してメモリーに置く（キャッシュの規則は [ADR-0063](0063-cpu-bound-work-sizing.md)）。
- DB は、専用のロール `signer` で接続する。許すのは `signing_keys`・`signing_key_state_versions`・`signing_key_issuers`・`external_idp_keys` の SELECT と、`signing_keys.last_used_at` の UPDATE だけ（[ADR-0047](0047-signer-api-and-jwks-publishing.md)）。他のテナントのデータの表（ユーザー、資格情報、セッションなど）を読めない。

### API

- ADR-0003 のとおり、テナント・トークンの種類・クレームを受け取り（`kid` は Signer が選ぶ。ADR-0047）、署名した JWT を返すだけ。任意のバイト列には署名しない。`iss` と `kid` のテナントの一致を Signer の中で確かめる。外部 IdP のアサーション（Apple のクライアントシークレットなど）は、署名のポートの別のエンドポイントで、用途と宛先を限って受ける（ADR-0047）。
- 鍵の生成・ローテーション・失効は、Signer の別の API で行う。**鍵の管理の API は、`mgmt` のタスクからの相互 TLS だけを受ける別のポートにする。** 署名のポートと分ける（署名のポートからは鍵の管理ができない。Auth からは鍵の管理ができない）。

### 2・3 を選ばなかった理由

- **2（別アカウント）**：Signer の読む `signing_keys` を別の DB に置くことになり、DR（Global Database）と、テナントの削除の一貫性の手間が増える。アカウントを分けて防げる主な脅威（prod のアカウントの IAM の誤設定で鍵が読まれる）は、KMS のキーポリシーで `Decrypt` を Signer のロールだけに限ることで防げる（暗号文が読まれても復号できない）。PrivateLink の往復も遅延の予算を食う。
- **3（Nitro Enclaves）**：メモリーの隔離は最も強い。ただし、EC2 の運用（AMI、パッチ、容量）と、enclave の中の開発・デバッグの手間が S1 の規模に見合わない。S3 で Signer の台数が増え、専用のセルを持つ段階で再評価する。

## Consequences

- 良くなること：
  - Signer に届く経路が、Auth のタスクからの署名と、mgmt のタスクからの鍵の管理の 2 つだけになる。
  - Signer から外へ秘密鍵を持ち出す経路（インターネット）がない。
- 引き受けるコスト：
  - 秘密鍵は、なお Signer のプロセスのメモリーに平文で載る。Signer の脆弱性は致命的である（ADR-0003 の引き受けたコストのまま）。
  - 相互 TLS の証明書の発行と更新の仕組み（Private CA）の費用と運用が要る。
  - Signer の障害の調査で、シェルに入れない。調査はログ・メトリクス・トレースだけで行う。

## Confirmation

- Terraform の CI（ポリシー検査）：`signer` のサブネットの経路表に、NAT・Internet Gateway への経路がない。Signer の NLB のセキュリティグループの入口が、`auth`・`mgmt` のセキュリティグループだけ。
- IAM の静的検査：署名鍵の KMS の鍵の `kms:Decrypt` を持つのは、Signer のタスクのロールだけ。
- 結合テスト：`mgmt` のクライアント証明書で署名のポートを呼ぶと拒否される。`auth` の証明書で鍵の管理のポートを呼ぶと拒否される。
- 週次：Signer のタスクで ECS Exec が無効であることの検査（AWS Config のルール）。

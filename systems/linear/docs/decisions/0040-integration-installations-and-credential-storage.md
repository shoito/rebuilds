---
status: accepted
date: 2026-09-28
---

# ADR-0040: 連携のインストールは管理者のグループのモデルに秘密なしで持ち、秘密は KMS の専用の鍵で包んだ暗号文をサーバーだけの表に置く。GitHub のインストールのトークンはメモリーだけに持ち、顧客の指定するホストへは egress の経路から送る

## Context

連携には、次の秘密が要る。

- プラットフォームで 1 つ：GitHub App の秘密鍵と Webhook の秘密、Slack の署名の秘密とクライアントの秘密。
- インストールごと：Slack のボットのトークンとリフレッシュトークン（12 時間で入れ替わる）、GitLab の顧客のトークン、GitLab の Webhook の署名の鍵。
- 短命：GitHub のインストールのトークン（1 時間。[Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)、2026-09-28 に確認）。

同期のモデルは、差分で管理者のクライアントへ届き、IndexedDB に残る。秘密をモデルに入れると、端末に秘密が残る。GitLab の自前のホストは顧客が指定するので、内部への SSRF の踏み台になりうる。

## Options

秘密の置き場所：

1. **Aurora のサーバーだけの表に、KMS の専用の鍵で包んだ DEK と AES-256-GCM の暗号文（AAD にワークスペースとインストール）**
2. インストールごとに Secrets Manager の秘密を作る
3. モデルのフィールドに暗号文で入れる

送信の経路：

- a. **決まった相手（GitHub・gitlab.com・Slack）は許可リストの NAT、顧客の指定するホストは egress の専用の経路**
- b. すべて同じ NAT

## Decision

1 と a を採用する。詳細は [integrations.md](../architecture/integrations.md) の 6 節。

- `IntegrationInstallation` は `role:admin` のグループのモデル。秘密もハッシュも持たない。
- `integration_secrets` はモデルにしない（差分に載らない）。RLS の対象で、DB のロール `integrations` だけが読む。KMS の鍵 `<brand>-integration-secrets` の `kms:Decrypt` は、連携の Worker と受け口のタスクのロールだけに与える。
- GitHub のインストールのトークンは保存せず、Worker のメモリーで 50 分使う。
- 利用者の外部のアカウントの結び付けで得た利用者のトークンは、ID を読んだら捨てる。
- GitLab のトークンは入れた後に画面に出さず、Webhook の署名の鍵は作った時に 1 回だけ示す。
- 自前の GitLab のホストへの送信は egress のサブネットの `worker-egress` から、名前解決の後の IP の検査とリダイレクトの拒否つきで行う（[api-and-webhooks.md](../architecture/api-and-webhooks.md) の Webhook の送信と同じ部品）。
- 2 を採らない理由：インストールの数（S1 で数千）だけ秘密ができ、費用と Secrets Manager の API の流量の管理が重い。ワークスペースの削除で消し漏れやすい。
- 3 を採らない理由：暗号文でも端末に残り、鍵の管理の誤り 1 つで漏れる。
- b を採らない理由：顧客の指定するホストへの要求が、本体の VPC エンドポイントや DB に届く経路を持つ。

## Consequences

- 良くなること：
  - 秘密が端末・差分・ログに出ない。ワークスペースの削除で行ごと消える。
  - SSRF の影響が egress の経路に閉じる。
- 引き受けるコスト：
  - 受け口（Slack のモーダル）でトークンの復号が要り、KMS の呼び出しが増える。5 分の写しで抑える。
  - 暗号の包みのコードを自分で持つ（[security.md](../architecture/security.md) の 5 節の共通の部品にする）。

## Confirmation

- マイグレーションの検査：`integration_secrets` の `SELECT` の権限が `integrations` のロールだけにある。
- Terraform のポリシーの検査：KMS の鍵のポリシーの `kms:Decrypt` の主体。
- 静的な検査：モデルの定義に `secret`・`token` を含む名前のフィールドがない。
- ログの走査で、トークンの形（`xoxb-`、`glpat-` など外部の形）の文字列が出ていない。

---
status: accepted
date: 2026-09-26
---

# ADR-0026: 自前の OIDC の発行者を持ち、ジョブごとの短命の ID トークンを KMS の鍵で署名する

詳細は [actions.md](../architecture/actions.md) の 7 節。

## Context

デプロイのジョブは、クラウド（AWS・GCP・Azure など）の資格情報を要する。長期の鍵をシークレットに置くと、漏れたときの被害が長く続く。本家は、ジョブごとに OIDC の ID トークンを発行し、クラウドの側でその claim（リポジトリ、ブランチ、環境）を条件に短期の資格情報と交換させる（[OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)、[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)）。

利用者は、本家向けに書いたクラウドの信頼の設定（`sub` の条件）を、発行者の URL を変えるだけで流用したい。

## Options

1. **OIDC は提供せず、長期の鍵をシークレットに置いてもらう**
2. **自前の OIDC の発行者を持ち、claim と `sub` の形を本家に合わせる。署名は KMS の非対称鍵で行う**
3. **自前の発行者を持ち、署名の鍵をアプリの側（Secrets Manager に置いた秘密鍵）で扱う**

## Decision

> 2026-09-26 の注記：本家の有効期限は値として明記されていないが、文書の例のトークンは `exp − iat` が 300 秒（5 分）で、本決定と一致する（[OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)）。KMS の `Sign` の上限は、RSA・ECC の鍵でそれぞれ 1 秒に 1,000 件（アカウント・リージョンごと、暗号の操作と共有、引き上げ可）である（[Request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)）。S1 のジョブの開始のピーク（5 件/秒。[capacity.md](../architecture/capacity.md) の 2.9 節）の十分に内側なので、下の「上限は未検証」は解消した。

2 を採用する。

- 発行者は `https://token.actions.<本番のドメイン>`。`/.well-known/openid-configuration` と JWKS を公開する。
- ワークフローが `id-token: write` を持つジョブだけが、ジョブトークンで ID トークンを要求できる。fork からの `pull_request` では出さない（ADR-0025）。
- claim の名前と `sub` の形（`repo:<owner>/<repo>:environment:<name>`、`...:pull_request`、`...:ref:refs/heads/<branch>`）は本家に合わせる。`sub` に含める claim は、Organization・リポジトリの単位で変えられる。
- **不変の ID を `sub` に含める設定を用意し、推奨する。** リポジトリや持ち主の名前は、削除・改名の後に別の人が取れる。`repository_id`・`repository_owner_id` を含めれば、名前の再利用で別人のジョブが信頼の条件を通ることを防げる。
- 署名は KMS の非対称鍵（RSA、`RS256`）で行い、秘密鍵を KMS の外に出さない。鍵は 90 日ごとに入れ替え、JWKS には新旧の 2 つを並べる。
- 有効期限は 5 分（本家の値は **未検証**）。発行ごとに `jti` と claim を監査ログに残す。
- S3（複数のリージョン）でも、発行者は 1 つにする（JWKS と鍵を全リージョンで同じにする）。利用者の信頼の設定を 1 つに保つため。
- 1 を採らない理由：長期の鍵の漏洩は、Actions の最大の被害の 1 つである。本家のワークフローとの互換も失う。
- 3 を採らない理由：秘密鍵がアプリのメモリに載り、漏れたときに全利用者のクラウドの信頼が破れる。KMS の署名の呼び出しの費用と遅延は、ジョブの数に対して許容できる（KMS の署名の API の上限は **未検証**。S1 の発行の速さと比べて確かめる）。

## Consequences

- 良くなること：
  - 利用者が長期のクラウドの鍵を置かずに済む。
  - 本家の信頼の設定を、発行者の URL と `aud` を変えるだけで流用できる。
- 引き受けるコスト：
  - OIDC の発行者は、全利用者のクラウドへの入口になる。可用性（ジョブのデプロイの手順が止まる）と完全性（誤った claim）の両方を、重要な部品として扱う。
  - KMS の署名の API のレート制限と遅延を、発行の速さに合わせて見積もる必要がある。
  - 鍵の入れ替えの手順を、JWKS のキャッシュ（利用者の側）を考えて運用する。

## Confirmation

- 表駆動テスト：イベント・ref・環境・`sub` の設定の組ごとに、ID トークンの claim と `sub` が期待と一致する。
- 性質ベーステスト：ジョブ A のジョブトークンで、ジョブ B（他のリポジトリ）の claim を持つ ID トークンは得られない。`id-token: write` のないジョブ、fork の PR のジョブは、ID トークンを得られない。
- 結合テスト：AWS の IAM の OIDC のプロバイダーに発行者を登録し、`sub` の条件付きのロールを引き受けられること、条件に合わない `sub` では拒否されること（staging）。
- 監視：JWKS の取得の失敗、署名の失敗、鍵の期限。

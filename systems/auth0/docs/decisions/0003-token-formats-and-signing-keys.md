---
status: accepted
date: 2026-09-27
---

# ADR-0003: アクセストークンと ID トークンはテナントの鍵で署名した JWT にし、秘密鍵は Signer の中だけで使う

## Context

認可サーバーが出すトークンの形式と、署名の秘密鍵の守り方は、後から変えるコストが最も高い決定の 1 つである。テナントのアプリと API は、トークンの形式と JWKS に依存して作られる。署名の秘密鍵が漏れると、そのテナントのどのユーザーにもなりすませる。

本家 Auth0 の振る舞い（2026-09-27 に確認）：

- 署名のアルゴリズムは RS256（推奨）、HS256、PS256（[Signing Algorithms](https://auth0.com/docs/get-started/applications/signing-algorithms)）。ES256 は資料になかった。
- 署名鍵は「使用中」「前の鍵」「次の鍵」の 3 つの状態を持ち、JWKS には複数の鍵が載りうる（[Signing Keys](https://auth0.com/docs/get-started/tenant-settings/signing-keys)）。
- アクセストークンの有効期間の既定は 86,400 秒、最大は 2,592,000 秒（[Update Access Token Lifetime](https://auth0.com/docs/secure/tokens/access-tokens/update-access-token-lifetime)）。
- リフレッシュトークンのローテーションでは、使用済みのトークンの再利用を検知すると、同じ系列のトークンをすべて失効させる。猶予（leeway）は既定で無効。有効期間の既定は 30 日、最大 1 年で、ローテーションしても延びない（[Refresh Token Rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)、[Configure Refresh Token Rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation)）。

AWS KMS の制約（[KMS request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)、2026-09-27 に確認）：

- RSA の鍵の暗号の操作（`Sign` を含む）は、アカウント・リージョンで共有の 1 秒に 1,000 回。ECC も同じく 1,000 回。
- 対称鍵の暗号の操作（`Decrypt`・`GenerateDataKey` を含む）は、東京で共有の 1 秒に 20,000 回。
- どれも引き上げを申請できる。

S1 のトークンの発行のピークは 1 秒に 3,000 件で、1 件の発行で最大 2 回（ID トークンとアクセストークン）署名する（[architecture/README.md](../architecture/README.md) の 2 節）。

## Options

トークンの形式：

1. **アクセストークンは RFC 9068 の JWT、ID トークンは JWT、リフレッシュトークンは不透明な文字列**
2. アクセストークンも不透明にし、テナントの API にイントロスペクション（RFC 7662）で問い合わせさせる

秘密鍵の守り方：

- A. **KMS の非対称鍵で、トークンごとに `Sign` を呼ぶ**
- B. **秘密鍵を KMS の対称鍵でエンベロープ暗号化して保存し、専用の Signer のサービスの中でだけ復号して、プロセスの中で署名する**
- C. 秘密鍵を認可サーバーのプロセスの中で復号して署名する
- D. CloudHSM
- E. Nitro Enclaves の中で署名する

## Decision

形式は 1、秘密鍵は B を採用する。

### トークンの形式

- **ID トークン**：OIDC Core に従う JWT。`iss`・`sub`・`aud`（`client_id`）・`exp`・`iat`・`auth_time`・`nonce`・`amr`・`acr`・`sid` を持つ。
- **アクセストークン**：RFC 9068 の JWT（ヘッダーの `typ` は `at+jwt`）。`aud` は登録した API の識別子。API を指定しない要求にも JWT を出し、`aud` を userinfo のエンドポイントにする（本家は不透明なトークンを出す。本システムは保存と参照を減らすため JWT に揃える）。独自のクレームの名前空間は、テナントが決める URL か `https://<brand>.<domain>/` の形にする。
- **有効期間**：アクセストークンの既定と最大は本家に合わせる（既定 86,400 秒、最大 2,592,000 秒）。ブラウザのフロー（SPA）の既定は短くする（値は authentication-flows の領域で決める）。
- **失効**：JWT のアクセストークンは、失効の一覧を持たず、期限まで有効とする。すぐに止めたいテナントには、短い有効期間とリフレッシュトークンの失効を勧める。
- **リフレッシュトークン**：不透明。256 ビットの乱数に、接頭辞 `<brand>_rt_` とチェックサムを付ける（シークレットスキャン向け。リポジトリ共通の ADR-0006）。保存するのは SHA-256 の値だけ（[ADR-0004](0004-credential-storage.md)）。
  - 系列（family）の ID を持ち、ローテーションで新しいトークンを出すたびに前のトークンを使用済みにする。
  - 使用済みのトークンが再び来たら、系列のすべてを失効させ、ログに残す。
  - 猶予（同じトークンを並行して使える時間）は既定で 0。テナントが 0〜60 秒で設定できる（上限は本システムの決定。本家の `leeway` は既定 0 で、資料と Management API の OpenAPI に上限の記載がない。[Configure Refresh Token Rotation](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation)、OpenAPI の `ClientRefreshTokenConfiguration`、2026-09-27 に確認）。
  - 有効期間は、最終の期限（既定 30 日、最大 1 年、ローテーションで延びない）と、使われない期間の期限を持つ。
- **認可コード**：不透明、1 回限り、有効 60 秒。2 回目の使用を検知したら、そのコードから出したトークンを失効させる（RFC 6749 の 4.1.2）。
- 2 は、テナントの API がトークンの検証のたびに本システムを呼ぶことになり、本システムの障害がテナントの API の障害になる。イントロスペクションは、MVP の後に補助として足すかを検討する。

### 署名のアルゴリズムと鍵

- **既定は RS256（RSA 2048 ビット）。** テナントは ES256（P-256）、PS256 を選べる。
- **HS256 は提供しない。** クライアントシークレットをハッシュでしか持たない（[ADR-0004](0004-credential-storage.md)）ので、シークレットで署名できない。本家との差として記録する。`alg: none` の JWT は、受け取る側（`private_key_jwt` の検証など）でも拒否する。
- **鍵はテナントごと。** 状態は `next`（次）・`current`（使用中）・`previous`（前）・`revoked`（失効）。JWKS には `next`・`current`・`previous` を載せる。
  - `next` を常に JWKS に載せておくので、ローテーションはすぐに切り替えてよい。
  - `previous` は、テナントが失効させるまで JWKS に残す。
  - ローテーションは、テナントの操作（ダッシュボード・Management API）と、本システムの緊急の操作で行う。定期の自動ローテーションは keys-and-secrets の領域で決める。

### 秘密鍵の守り方（B）

- 鍵の対（秘密鍵と公開鍵）は、Signer の中で生成する。
- 秘密鍵は、KMS の対称鍵（署名鍵の専用の鍵）から得たデータキーで AES-256-GCM で暗号化し、Aurora に保存する。暗号化の追加の認証データ（AAD）に `tenant_id` と `kid` を含め、行の入れ替えを検知する。
- 復号できるのは、Signer のタスクのロールだけにする（KMS のキーポリシーで限る）。
- Signer は、復号した秘密鍵をメモリーにだけ置く。ディスクとコアダンプに出さない。
- Signer の API は、テナント・トークンの種類・クレームを受け取って署名した JWT を返すだけにする（使う鍵は Signer がテナントの `current` から選び、`kid` を呼び出し側に選ばせない。[ADR-0047](0047-signer-api-and-jwks-publishing.md)）。
  > 2026-09-27 の注記：当初は「テナント・`kid`・クレームを受け取る」としていた。ADR-0047 で `kid` を呼び出し側に選ばせないと決めたので揃えた。任意のバイト列には署名しない。`iss` が要求のテナントのものと一致することを、Signer の中で確かめる。
- 認可サーバーから Signer へは、VPC の中で相互 TLS で呼ぶ。
- 外部の IdP へのクライアントの認証に要る署名（Apple のクライアントシークレットの JWT、エンタープライズの OIDC 接続の `private_key_jwt`、SAML の AuthnRequest）も、Signer の中で行う。これはトークンの署名とは別の型の用途（外部 IdP のアサーション）として API を分け、テナントの署名鍵ではなく接続ごとの鍵で署名する。署名する中身は Signer が接続の登録の値から組み立て、呼び出し側に任意のクレームを渡させない（[ADR-0047](0047-signer-api-and-jwks-publishing.md)、[keys-and-secrets.md](../architecture/keys-and-secrets.md) の 6.3 節）。
- KMS の鍵は、大阪へ複製するマルチリージョンの鍵にし、DR の後も同じ暗号文を復号できるようにする。

### A・C・D・E を選ばなかった理由

- **A（KMS の `Sign`）**：S1 のピーク（最大 1 秒に 6,000 回の署名）が、既定の RSA の上限（1 秒に 1,000 回。[Request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)、2026-09-27 に確認）を大きく超える。署名ごとに KMS への往復が増え、KMS の障害がそのままトークンの発行の障害になる。テナントごとに KMS の鍵を持つと、鍵の数も多い（S1 で約 3 万）。KMS の鍵は 1 つ月 1 USD（[AWS KMS Pricing](https://aws.amazon.com/kms/pricing/)、2026-09-27 に確認）で、約 3 万の鍵で月 約 3 万 USD になる。
- **C（認可サーバーの中で署名）**：秘密鍵が、外からの要求を直接受けるプロセスのメモリーに載る。認可サーバーの脆弱性で鍵が読まれうる。
- **D（CloudHSM）**：費用と運用（クラスタ、HSM の利用者の管理）が重い。S1 の規模に見合わない。
- **E（Nitro Enclaves）**：隔離は最も強いが、ECS Fargate では使えない。Nitro Enclaves は、指定のインスタンスタイプの EC2 の親インスタンスを要件とし、Fargate はその対象にない（[What is Nitro Enclaves?](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html)、2026-09-27 に確認）。S3 で Signer を EC2 に移すときに再評価する。

## Consequences

- 良くなること：
  - トークンの発行の速さと量が、KMS の上限と遅延に縛られない。KMS の `Decrypt` は Signer の起動時と鍵の読み込みの時だけで済む。
  - 秘密鍵に触れるコードと権限が、Signer の 1 つのサービスに集まり、監査と審査の範囲が狭い。
- 引き受けるコスト：
  - 秘密鍵が Signer のメモリーに平文で載る。Signer の脆弱性は致命的になる。Signer は依存を最小にし、外からの要求を受けず、変更には `security:sensitive` のレビューを求める（[AGENTS.md](../../AGENTS.md)）。
  - トークンの発行に、VPC の中の往復が 1 回増える（遅延の予算に含める）。
  - HS256 を使う本家の利用者は、移行の時に RS256 などへ変える必要がある。

## Confirmation

- lint：Signer のパッケージの外で、秘密鍵を扱う API（`createPrivateKey`、`sign`、`importPKCS8` など）の使用を禁止する。
- IAM：署名鍵の専用の KMS の鍵に `kms:Decrypt` を持つのは Signer のタスクのロールだけであることを、Terraform の検査と週次の監査で確かめる。
- 性質ベーステスト：任意のリフレッシュの列で、使用済みのトークンを再び使うと、系列のすべてのトークンが以後の交換に失敗する。
- 適合試験：OIDC の適合試験で、ID トークンの署名と JWKS の検証が通る。ローテーションの前後で、`previous` の鍵で署名したトークンが検証できる。

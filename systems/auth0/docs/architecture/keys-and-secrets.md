# Keys and secrets: Auth0

Signer、署名鍵の生成・ローテーション・失効・緊急のローテーション、KMS の鍵の階層、pepper、エンベロープ暗号化、JWKS の書き出しの設計。方針は [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)（トークンと署名鍵）と [ADR-0004](../decisions/0004-credential-storage.md)（資格情報の保存）にある。Signer のネットワークと実行の隔離は [ADR-0059](../decisions/0059-signer-isolation.md)、Signer の鍵のキャッシュの大きさは [ADR-0063](../decisions/0063-cpu-bound-work-sizing.md)、DR の後の失効のやり直しは [ADR-0060](../decisions/0060-disaster-recovery-and-stages.md)、運用者の権限は [ADR-0056](../decisions/0056-operator-access.md) にある。

本家 Auth0 と AWS の振る舞いは、2026-09-27 に auth0.com/docs と docs.aws.amazon.com で確かめた。確かめられなかったものは「未検証」と書く。この文書の決定表は設計の草案で、要件 ID は E1・E3 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- 1 つのテナントの鍵で、他のテナントのトークンを作れないようにする（NFR-008）。
- 署名の秘密鍵を Signer の外に平文で出さない（NFR-007）。
- 鍵のローテーションと失効を、テナントのアプリを止めずに行える。漏えいの疑いのときは、数分で古い鍵を無効にできる。
- pepper と KMS の鍵を失って全ユーザーのパスワードが照合できなくなる、という事故を起こさない。

範囲に入れないもの：TLS の証明書（custom-domains.md、[ADR-0058](../decisions/0058-edge-and-custom-domains.md)）、Signer と Auth の間の相互 TLS の証明書（[ADR-0059](../decisions/0059-signer-isolation.md)）、クライアントの秘密の形（[authentication-flows.md](authentication-flows.md) の 6 節）。

## 2. 本家と AWS の形（確かめたこと）

| 項目 | 内容 | 出典（2026-09-27 に確認） |
| --- | --- | --- |
| 署名鍵の状態 | 「使用中」「前の鍵」「次の鍵」 | [Signing Keys](https://auth0.com/docs/get-started/tenant-settings/signing-keys) |
| ローテーション | ダッシュボードか Management API で手で行う。自動のローテーションの記述はない。鍵のローテーションの API は、他より小さいレート制限を持つ | 同上 |
| 失効 | 失効できるのは「前の鍵」だけで、先にローテーションが要る。失効した鍵は再び使えない | [Revoke Signing Keys](https://auth0.com/docs/get-started/tenant-settings/signing-keys/revoke-signing-keys) |
| JWKS | ローテーションの後は複数の鍵が載りうる（資料）。公開のテナント `samples.auth0.com` の JWKS は鍵 2 つで、`Cache-Control: public, max-age=15, stale-while-revalidate=15, stale-if-error=86400`（2026-09-27 に観察。資料には数とキャッシュの期間の記載がない） | [Signing Keys](https://auth0.com/docs/get-started/tenant-settings/signing-keys)、`https://samples.auth0.com/.well-known/jwks.json` |
| Management API の形 | `POST /api/v2/keys/signing/rotate`、`PUT /api/v2/keys/signing/{kid}/revoke`。ローテーションの API は、バースト 5・1 日 5 | Management API の OpenAPI、[Enterprise の Rate Limit Configurations](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/enterprise-public) |
| KMS の自動のローテーション | 対称鍵（KMS が作った鍵の素材）だけ。既定は 365 日ごとで、期間を変えられる。非対称鍵は自動でも即時でもローテーションできない。マルチリージョンの鍵では primary でだけ設定し、replica へ複製される。新しい素材は、すべてのリージョンにそろうまで暗号化に使われない。古い素材は、鍵を消すまで残り、古い暗号文を復号できる | [Rotate AWS KMS keys](https://docs.aws.amazon.com/kms/latest/developerguide/rotate-keys.html) |
| KMS の上限 | 対称鍵の暗号の操作は東京で 1 秒 20,000 回、大阪で 10,000 回。RSA の `Sign` は 1 秒 1,000 回 | [ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、[ADR-0063](../decisions/0063-cpu-bound-work-sizing.md) |
| KMS の鍵の削除の待ち | 7〜30 日（既定 30 日。実際は最大 24 時間長くなりうる） | [Delete an AWS KMS key](https://docs.aws.amazon.com/kms/latest/developerguide/deleting-keys.html) |
| 自動のローテーションの期間の範囲 | 90〜2,560 日（`RotationPeriodInDays`） | [EnableKeyRotation](https://docs.aws.amazon.com/kms/latest/APIReference/API_EnableKeyRotation.html) |

## 3. 鍵の階層

[ADR-0045](../decisions/0045-kms-key-hierarchy.md)。

```
KMS（顧客管理の対称鍵。マルチリージョン。primary は東京、replica は大阪。自動のローテーション 365 日）
│
├─ <brand>-signing-keys ──GenerateDataKey──▶ 署名鍵ごとの DEK ──AES-256-GCM──▶ 署名の秘密鍵（Aurora の signing_keys）
│     暗号化の文脈 {purpose: signing-key, tenant_id, kid}
│     同じ鍵で、外部 IdP の鍵（接続ごと）の DEK も包む ──▶ external_idp_keys（6.3 節）
│     暗号化の文脈 {purpose: external-idp-key, tenant_id, connection_id}
│     使える主体：Signer のタスクのロールだけ（GenerateDataKey、Decrypt）
│
├─ <brand>-credentials ──GenerateDataKey──▶ テナントごとの DEK（版つき）──AES-256-GCM──▶ 戻す必要のある秘密
│     暗号化の文脈 {purpose: tenant-dek, tenant_id, version}          （TOTP の種、ソーシャル IdP の秘密、ログストリームの資格情報、
│     使える主体：Auth・Management API・Worker のタスクのロール             メールの送信の資格情報）
│
├─ <brand>-pepper ──GenerateDataKey──▶ pepper（版つき。暗号文を Secrets Manager に）──HMAC-SHA-256──▶ パスワードのハッシュ
│     暗号化の文脈 {purpose: pepper, version}
│     使える主体：Auth・Management API のタスクのロール（Decrypt だけ）
│
└─ <brand>-data ──▶ Aurora・S3・SQS・Secrets Manager の保存の暗号化（サービスの側の暗号化）
      使える主体：各 AWS のサービス（キーポリシーの `kms:ViaService` で限る）
```

- **用途ごとに KMS の鍵を分ける。** キーポリシーで、用途ごとに使える主体を最小にする。署名鍵の KMS の鍵の `Decrypt` を持つのは Signer のタスクのロールだけ（人・break-glass のロールも持たない。[ADR-0056](../decisions/0056-operator-access.md)）。
- **暗号化の文脈（encryption context）を必ず付ける。** キーポリシーの条件（`kms:EncryptionContext:purpose`）で、用途の違う復号を拒否する。CloudTrail に、どのテナントのどの鍵の復号かが残る。
- **データの層でも AAD を付ける。** 署名鍵の AES-256-GCM の AAD は `tenant_id|kid|alg`、テナントの DEK で暗号化した秘密の AAD は `tenant_id|行の ID|用途`（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)、[ADR-0004](../decisions/0004-credential-storage.md)）。DB の行を入れ替えても復号に失敗する。
- **KMS の鍵そのものの素材は、KMS の自動のローテーション（365 日）に任せる。** 古い素材は KMS が持ち続けるので、暗号文を作り直す必要はない。DEK と、その下の署名鍵・秘密は、KMS のローテーションでは変わらない。変えたいときは、それぞれのローテーション（5 節、3.2 節、4 節）で行う。
- **削除を防ぐ。** 4 つの鍵の `ScheduleKeyDeletion` と `DisableKey` を、組織の SCP で拒否する。例外は、セキュリティの担当と Ops の責任者の 2 人の承認で得る期限つきのロールだけ。削除の待ちは最大の 30 日にする（2 節）。`PutKeyPolicy`・`ScheduleKeyDeletion`・`DisableKey` の呼び出しを、CloudTrail から即時に通知する。
- 鍵の数はリージョンごとに 4 つ（と replica）。テナントごとに KMS の鍵を作らない（鍵の数と費用。[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md) の A を採らなかった理由と同じ）。

### 3.1 DEK の扱い

| 用途 | DEK の単位 | 平文の DEK の置き場所 | 期間 |
| --- | --- | --- | --- |
| 署名鍵 | 鍵ごとに 1 つ | Signer のメモリー（秘密鍵を復号する間だけ）。秘密鍵を復号したら捨てる | 数ミリ秒 |
| テナントの秘密 | テナント × 版 | 使うタスクのメモリーの LRU（上限 1 万件） | 最大 5 分 |
| pepper | pepper そのものが秘密 | Auth・Management API のタスクのメモリー | タスクの寿命 |

- 平文の DEK と秘密鍵を、ディスク・ログ・トレース・コアダンプに出さない（[ADR-0059](../decisions/0059-signer-isolation.md) の `ulimit core 0`）。
- テナントの DEK は、テナントの作成のときに Management API が作る。ローテーション（新しい版を作り、以後の暗号化に使う）は年 1 回の Worker のジョブで行い、古い版の暗号文は、読んだときに新しい版で書き直す。古い版は、参照する行が 0 になってから消す。

### 3.2 テナントの削除

- テナントを消すときは、テナントの DEK の暗号文と、署名鍵の暗号文を消す（暗号の消去）。バックアップに残った暗号文は、DEK がないので復号できない。保持の期間は [ADR-0055](../decisions/0055-data-retention-and-deletion.md) に従う。

## 4. pepper

[ADR-0045](../decisions/0045-kms-key-hierarchy.md)。パスワードのハッシュの方式は [ADR-0004](../decisions/0004-credential-storage.md)。

- pepper は 256 ビットの乱数。KMS の `GenerateDataKey`（`<brand>-pepper`）で作り、暗号文だけを Secrets Manager の `<brand>/pepper/v{n}` に置く。平文はどこにも保存しない。Secrets Manager の秘密は大阪へ複製する。
- Auth と Management API（パスワードの設定・インポート）のタスクは、起動時にすべての有効な版を復号してメモリーに置く。ログインのたびに KMS を呼ばない（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。
- パスワードのハッシュに版（`pv=n`）を記録する。新しいハッシュは `current` の版で作る。
- **ローテーション**：新しい版を作って `current` にする。古い版は、その版のハッシュを持つユーザーが 0 になるまで残す。ログインの成功のときに新しい版で作り直す。版ごとのハッシュの数を日次で数える。
- **漏えいの疑い**：pepper だけでは攻撃にならない（DB のハッシュも要る）。新しい版に替え、古い版のハッシュを持つユーザーは次のログインで作り直す。DB も漏れた疑いがあるときは、テナントに知らせ、古い版のユーザーのパスワードの再設定を求める（手順は runbook）。
- **失う事故への備え**：pepper の KMS の鍵はマルチリージョン、暗号文は Secrets Manager の複製と、log-archive のアカウントの S3（Object Lock）に置く。四半期ごとに、staging で「Secrets Manager の秘密を消した状態から、アーカイブの暗号文で復旧する」訓練をする。
- S3 の段階の前に、pepper を専用の隔離（HSM など）へ移すかを決める（[architecture/README.md](README.md) の 6 節の持ち越し）。

## 5. 署名鍵のライフサイクル

[ADR-0046](../decisions/0046-signing-key-lifecycle.md)。

### 5.1 状態

```
             生成（Signer）          ローテーション              ローテーション（2 つ前）／失効
  (なし) ──────────────▶ next ─────────────▶ current ──────────────▶ previous ─────────────▶ revoked
                          │                    │                          ▲
                          │                    └── 緊急のローテーション ────┼──────────────────▶ revoked
                          │                                               │
                          └── ready（JWKS に載せてから 15 分）── ローテーションの条件 ┘
```

| 状態 | JWKS | 署名に使う | 数 |
| --- | --- | --- | --- |
| `next` | 載せる | 使わない | 1 |
| `current` | 載せる | 使う | 1 |
| `previous` | 載せる | 使わない | 0〜2 |
| `revoked` | 載せない | 使わない | 制限なし（公開鍵と履歴だけ残す） |

- テナントの作成で、`current` と `next` の 2 つを作る。
- `kid` は、公開鍵の JWK の SHA-256 の thumbprint（RFC 7638）を base64url にしたもの。
- アルゴリズムは鍵ごとに持つ。RS256・PS256 は RSA 2048 ビット、ES256 は P-256（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)）。テナントがアルゴリズムを変えるときは、新しいアルゴリズムで `next` を作り直し、ローテーションで切り替える。

### 5.2 操作

| # | 操作 | 前の状態 | 条件 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | ローテーション | `next` が ready、`previous` が 2 つ未満 | — | `next`→`current`、`current`→`previous`、新しい `next` を生成 |
| 2 | ローテーション | `next` が ready でない（JWKS に載せてから 15 分未満） | — | 409 `next_key_not_ready`（待つ時間を返す） |
| 3 | ローテーション | `previous` が 2 つ | — | 409 `too_many_previous_keys`（古い方の失効を求める） |
| 4 | 失効 | `previous` | — | `revoked`。JWKS から外す。秘密鍵の暗号文を消す |
| 5 | 失効 | `current`・`next` | — | 409（先にローテーションが要る。本家と同じ） |
| 6 | 失効 | `revoked` | — | 409（戻せない。本家と同じ） |
| 7 | 緊急のローテーション（テナント） | 任意 | ready を問わない | `next`→`current`、`current`→`revoked`、新しい `next` を生成。`previous` はそのまま（別に失効できる） |
| 8 | 緊急のローテーション（全部） | 任意 | ready を問わない | すべての鍵を `revoked`。新しい `current` と `next` を生成 |
| 9 | アルゴリズムの変更 | 任意 | — | `next` を新しいアルゴリズムで作り直す（古い `next` は使われていないので消す）。15 分後にローテーションできる |

- 操作は、ダッシュボードと Management API（テナントの管理者）と、運用の手順（本システムの運用者。2 人の承認。[ADR-0056](../decisions/0056-operator-access.md)）から行う。
- **ローテーションの API のレート制限**：テナントごとにバースト 5・1 日 5 回（本家の Enterprise の「Write Signing Keys」と同じ。[Enterprise](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy/rate-limit-configurations/enterprise-public)、2026-09-27 に確認。[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 6.3 節）。緊急のローテーションは別に数える（1 時間 3 回）。
- **失効の完了**：[ADR-0060](../decisions/0060-disaster-recovery-and-stages.md) のとおり、大阪への複製を確かめてから「完了」を返す。あわせて、JWKS の書き出しと、エッジでの確かめ（7.3 節）が済むまでを、失効の操作の状態として見せる（`pending`→`published`→`completed`）。
- **定期の自動のローテーション**：既定は無効（本家と同じ）。テナントが 30〜365 日の間隔で有効にできる。有効なときは、Worker のジョブが 5.2 節の 1 を行う（`previous` が 2 つなら、古い方を先に失効させる。その鍵で署名したトークンの最長の有効期間を過ぎているときだけ）。
- 2 年以上 `current` のままの鍵には、ダッシュボードで警告を出す。

### 5.3 失効と緊急のローテーションの効き方

鍵を失効させても、発行済みのトークンは取り消せない。失効が効くのは、テナントの API と RP が新しい JWKS を読んだ時点から。

```
t0      失効の操作（Management API → Signer の鍵の管理の API → DB のコミット）
t0+2s   Signer のキャッシュに反映（通知か、2 秒のポーリング）。緊急のときは、以後この鍵で署名しない
t0+~10s Worker が JWKS を S3 に書き出す（outbox → SQS）
t0+~70s CloudFront のキャッシュが切れる（s-maxage 60 秒。緊急のときは無効化の要求も出す）
t0+~6m  RP・API のキャッシュが切れる（max-age 300 秒に従うクライアント）
```

- RP のキャッシュの長さは RP のライブラリに依る。`max-age` を無視して長く持つライブラリもある（未検証）。緊急のローテーションの通知で、テナントに「JWKS のキャッシュを捨てる」操作を促す。
- 失効した鍵の `kid` の JWT を `id_token_hint`・`private_key_jwt` などで受けたら、本システムの側では即時に拒否する（JWKS の配信を待たない）。
- 緊急のときは、失効に加えて次を検討する（runbook で判断する）：
  - テナントのリフレッシュトークンの系列の失効（鍵の漏えいはリフレッシュトークンを作れないので、既定では行わない）。
  - テナントのトークンの発行の一時停止（キルスイッチ。KMS の障害中で新しい鍵を作れないとき）。

### 5.4 Signer 全体の侵害

- Signer のメモリーには、キャッシュにあるすべてのテナントの秘密鍵が載る（[ADR-0063](../decisions/0063-cpu-bound-work-sizing.md)）。Signer の侵害の疑いは、全テナントの緊急のローテーション（5.2 節の 8）になる。
- 本番のテナントを先に、Signer のタスクを増やして並行で行う。S1 の見積もり：テナント 1 万 × 新しい鍵 2 つで 2 万回の鍵の生成と `GenerateDataKey`。KMS は 1 秒 500 回に絞っても 40 秒。RSA 2048 の鍵の生成の CPU の時間（1 回数十〜百ミリ秒と見込む。未検証）が律速で、Signer を最大の 24 タスクに広げて数分と見込む。E12 の訓練で測る。
- 手順は runbook の `signer-compromise.md`。

## 6. Signer

[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md)。ネットワークと実行の隔離は [ADR-0059](../decisions/0059-signer-isolation.md)。

### 6.1 署名の API（Auth からだけ）

```
POST /v1/sign
{
  "tenant_id": "…",
  "token_type": "id_token" | "access_token" | "logout_token",
  "claims": { … }
}
→ 200 { "jwt": "…", "kid": "…" }

POST /v1/sign-batch        // ID トークンとアクセストークンを 1 回の往復で。最大 2 件
```

Signer の中の検査（どれかに当たれば 400。ログに残し、アラートの対象にする）：

| 検査 | 内容 |
| --- | --- |
| 鍵 | テナントの `current` の鍵で署名する。`kid` を呼び出し側に選ばせない |
| `iss` | テナントの `issuer` の一覧（`signing_key_issuers`）のどれか |
| ヘッダーの `typ` | 種類で決める：`id_token` は `JWT`、`access_token` は `at+jwt`、`logout_token` は `logout+jwt`。呼び出し側に選ばせない |
| 必須のクレーム | 種類ごと（`iss`・`sub`・`aud`・`iat`・`exp`。`access_token` は `client_id`・`jti`、`logout_token` は `jti`・`events`） |
| 禁止のクレーム | `logout_token` の `nonce` |
| 有効期間 | `exp − iat` が種類ごとの上限以下（アクセストークン 2,592,000 秒、ID トークン 86,400 秒、ログアウトトークン 120 秒）。`iat` が Signer の時刻から ±60 秒 |
| 大きさ | クレームの JSON が 8 KiB 以下 |

- 任意のバイト列には署名しない（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)）。種類を 3 つに限り、Signer を「どんなトークンを作れるか」の最後の関所にする。外部の IdP へのクライアントの認証は、この API では受けず、6.3 節の別の API で扱う。
- 署名の p99 は 10 ミリ秒以内（`/oauth/token` の p99 150 ミリ秒の予算の内。NFR-003）。キャッシュにない鍵の最初の署名は、KMS の往復ぶん遅い（[ADR-0063](../decisions/0063-cpu-bound-work-sizing.md)）。
- `last_used_at` は、鍵ごとに 1 分に 1 回まで書く（[ADR-0063](../decisions/0063-cpu-bound-work-sizing.md) の起動時の読み込みに使う）。

### 6.2 鍵の管理の API（Management API からだけ）

| API | 中身 |
| --- | --- |
| `POST /v1/keys:generate` | `{tenant_id, alg}` → Signer の中で鍵の対を作り、`GenerateDataKey` の DEK で秘密鍵を暗号化し、`{kid, public_jwk, private_key_ciphertext, dek_ciphertext}` を返す。平文の秘密鍵は返さない |
| `POST /v1/keys:invalidate` | `{tenant_id, state_version}` → そのテナントの鍵のキャッシュを捨て、DB から読み直す。応答は読み直した版 |
| `POST /v1/external-keys:import` | `{tenant_id, connection_id, purpose, private_key}` → テナントが登録した外部 IdP の秘密鍵（Apple の `.p8`）を Signer の中で暗号化し、`{key_id, public_jwk, private_key_ciphertext, dek_ciphertext}` を返す（6.3 節） |
| `POST /v1/external-keys:generate` | `{tenant_id, connection_id, purpose, alg}` → OIDC の `private_key_jwt`・SAML の SP の鍵の対を Signer の中で作る。公開鍵（JWK、SAML の自己署名の証明書）と暗号文を返す（6.3 節） |

- 状態の遷移（5.2 節）は、Management API が 1 つのトランザクションで `signing_keys` を書き、`signing_key_state_versions` の版を上げ、outbox に `jwks.changed` と監査の事象を入れる。Signer の DB のロールは、`signing_keys`・`signing_key_state_versions`・`signing_key_issuers`・`external_idp_keys` の SELECT と、`signing_keys.last_used_at` の UPDATE だけ（[ADR-0059](../decisions/0059-signer-isolation.md)）。
- 遷移の後、Management API はすべての Signer のタスクに `keys:invalidate` を送る。届かなかったタスクも、2 秒ごとのポーリング（`signing_key_state_versions` の更新）で追いつく。**古い `current` で署名しうる時間の上限は 2 秒。** 緊急のローテーションでは、全タスクの応答を待ってから「署名の停止」を完了とする。
- Signer の DB のロールの表は、2026-09-27 の統合で [ADR-0059](../decisions/0059-signer-isolation.md) と [ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md) に揃えた（`signing_keys` に、同じ用途の小さな表 `signing_key_state_versions`・`signing_key_issuers` と、6.3 節の `external_idp_keys` を足した）。

### 6.3 外部 IdP のアサーション（Auth からだけ）

[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md)。接続の領域（[connections.md](connections.md) の 5.2・6 節、[ADR-0016](../decisions/0016-social-connections-and-idp-tokens.md)、[ADR-0017](../decisions/0017-enterprise-connections.md)）が、外部の IdP へのクライアントの認証の署名を Signer に求めている。トークンの署名（6.1 節）と混ぜず、別の型の用途として持つ。

```
POST /v1/sign-external-assertion
{
  "tenant_id": "…",
  "connection_id": "…",
  "purpose": "apple_client_secret" | "oidc_client_assertion" | "saml_authn_request",
  "params": { … }          // saml_authn_request だけ：request_id、acs_url
}
→ 200 { "assertion": "…", "expires_at": "…" }
```

| `purpose` | 使う接続 | Signer が決めるもの（接続の登録の値から） | 有効期間 | Epic |
| --- | --- | --- | --- | --- |
| `apple_client_secret` | Apple | `alg` ES256、`kid`（Apple の Key ID）、`iss`（Team ID）、`sub`（Services ID）、`aud`（`https://appleid.apple.com`） | 1 時間（Apple の上限は 6 か月。短くする） | E6 |
| `oidc_client_assertion` | エンタープライズの OIDC・Entra ID（`private_key_jwt`） | `iss`・`sub`（IdP での `client_id`）、`aud`（登録した IdP のトークンのエンドポイント）、`jti`（Signer が作る）、`alg` | 300 秒 | E14 |
| `saml_authn_request` | SAML（SP として） | `Issuer`（SP の Entity ID）、`Destination`（登録した IdP の SSO の URL）、`IssueInstant`、署名のアルゴリズム（RSA-SHA256）。AuthnRequest を Signer が組み立てて署名する | —（`IssueInstant` から IdP が判断） | E14 |

- 鍵は接続ごとに `external_idp_keys` に置く。テナントの署名鍵（`signing_keys`）は使わない。鍵の取り込み・生成は 6.2 節の `external-keys:*`（Management API からだけ）。
- 呼び出し側は、クレーム・宛先・有効期間を渡せない。他のテナントの `connection_id`、登録と違う `purpose` は 400 にし、6.1 節の検査の違反と同じくアラートの対象にする。
- Auth は、`apple_client_secret` の結果を接続ごとに有効期間の間キャッシュする（Signer の障害中も、キャッシュの間は Apple の接続が続く。[connections.md](connections.md) の 7 節）。`oidc_client_assertion` は要求ごとに作る（`jti` を使い回さない）。
- 公開鍵の配布：`oidc_client_assertion` の公開鍵は、接続ごとの JWKS として Management API とダッシュボードで示し、テナントが IdP に登録する。SAML の SP の証明書は、接続の SP のメタデータで示す。
- 鍵の入れ替え：テナントの操作で新しい鍵を足し、IdP 側の登録を替えてから古い鍵を失効させる（2 つまで並べて持てる）。

## 7. JWKS と discovery の書き出し

[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md)。エッジの構成は [ADR-0058](../decisions/0058-edge-and-custom-domains.md)。

### 7.1 流れ

```
Management API（鍵の遷移・カスタムドメインの変更）── outbox: jwks.changed{tenant_id, state_version} ──▶ SQS
Worker:
  1. signing_keys から next・current・previous の公開鍵を読む（state_version 以上であること）
  2. テナントのホスト名ごと（テナントのホスト、カスタムドメイン）に jwks.json と openid-configuration を作る
  3. S3（東京）に PUT。オブジェクトのメタデータに state_version と SHA-256
  4. CloudFront の無効化（失効・緊急のときだけ）
  5. jwks_publications に記録
  6. 60 秒後に CloudFront 経由で取得し、SHA-256 を比べる（7.3 節）
S3 のレプリケーション → 大阪の S3（オリジングループの予備）
```

- 書き出しは冪等。同じ `state_version` を何回書いてもよい。古い `state_version` の事象は捨てる（新しいものが先に着いても戻さない）。
- S3 の `jwks/` と `discovery/` の接頭辞への `PutObject` は、Worker のロールだけに許す。S3 のバージョニングを有効にする。

### 7.2 形とキャッシュ

```json
{
  "keys": [
    { "kty": "RSA", "kid": "<current>",  "use": "sig", "alg": "RS256", "n": "…", "e": "AQAB" },
    { "kty": "RSA", "kid": "<next>",     "use": "sig", "alg": "RS256", "n": "…", "e": "AQAB" },
    { "kty": "RSA", "kid": "<previous>", "use": "sig", "alg": "RS256", "n": "…", "e": "AQAB" }
  ]
}
```

- 並びは `current`、`next`、`previous`（新しい順）。最大 4 つ。
- `x5c`（証明書の鎖）は載せない（14 節の持ち越し）。
- `Cache-Control: public, max-age=300, s-maxage=60, stale-while-revalidate=60, stale-if-error=86400`。
  - RP のキャッシュは 5 分。CloudFront は 1 分。
  - オリジン（東京と大阪の S3 の両方）が失敗しても、CloudFront は 24 時間まで古い版を返す（[ADR-0005](../decisions/0005-authentication-path-availability.md) の「古い版を返し続ける」の期間）。
- `ETag` を付け、条件付きの GET に 304 を返す。
- discovery も同じ `Cache-Control` にする。

### 7.3 確かめ

- Worker は、書き出しから 60 秒後に CloudFront 経由で取り直し、SHA-256 を比べる。違えば 60 秒ごとに 5 回まで取り直し、それでも違えばアラート。
- 合成監視（[ADR-0062](../decisions/0062-sli-and-synthetic-monitoring.md)）で、監視用のテナントの JWKS を 1 分ごとに取り、`current` の `kid` が DB と一致するかを見る。
- `next` の ready（5.2 節）は、確かめが済んだ時刻から 15 分後にする（RP のキャッシュ 5 分＋CloudFront 1 分＋余裕）。

## 8. 障害のときの振る舞い

| 障害 | 署名 | ローテーション・失効 | JWKS | pepper・テナントの秘密 |
| --- | --- | --- | --- | --- |
| KMS | キャッシュにある鍵で続く。ない鍵のテナントは 503（[ADR-0063](../decisions/0063-cpu-bound-work-sizing.md)） | 鍵を作れないので、ローテーション・緊急のローテーションはできない。`previous` の失効はできる | 続く | 起動済みのタスクは続く。新しいタスクは起動できない。Signer と Auth を縮小しない |
| Signer の一部のタスク | 他のタスクで続く | 届かないタスクはポーリングで 2 秒以内に追いつく | 続く | — |
| Signer のすべてのタスク | 503 | できない | 続く | — |
| Worker・SQS | 続く | DB の遷移は済むが、JWKS の書き出しが遅れる。ローテーションは `next` が ready にならないので止まる。失効は `pending` のまま | 古い版のまま | — |
| S3（東京） | 続く | 書き出しが失敗し再試行する | 大阪の S3 か、CloudFront の古い版 | — |
| Aurora の writer | 続く（読むだけ） | できない | 続く | — |
| 大阪への切り替え（DR） | 同じ鍵で続く（マルチリージョンの KMS の鍵） | 切り替え前の失効は [ADR-0060](../decisions/0060-disaster-recovery-and-stages.md) でやり直す | 大阪の S3 から | 同じ pepper で続く |

失敗の形：

- **KMS の障害中に漏えいが起きる**：新しい鍵を作れない。テナントのトークンの発行を止め（キルスイッチ）、漏れた鍵を `revoked` にして JWKS から外す。KMS の回復後に新しい鍵を作る。
- **JWKS の配信の食い違い**：S3 と CloudFront で古い JWKS が残ると、ローテーション直後の `current` で署名したトークンを RP が検証できない。`next` を 15 分前から載せておくことで、通常のローテーションでは起きない。緊急のローテーションでは、RP の多くは未知の `kid` で JWKS を取り直すので、数分で回復すると見込む（未検証）。
- **pepper の版の取り違え**：古い版を先に消すと、そのユーザーはログインできない。版ごとのハッシュの数が 0 でない版は消せないように、消す操作の中で数える。

## 9. セキュリティ

| 脅威 | 対応 |
| --- | --- |
| 署名鍵の読み出し（DB・バックアップの漏えい） | 暗号文だけ。`Decrypt` は Signer のロールだけ |
| 別のテナントの鍵での署名 | Signer が `tenant_id` と鍵と `iss` の一致を確かめる。`kid` を呼び出し側に選ばせない |
| 行の入れ替え | KMS の暗号化の文脈と、AES-GCM の AAD に `tenant_id`・`kid` |
| アルゴリズムの取り違え | Signer は鍵のアルゴリズムでだけ署名する。受け取る側は `alg` を許可リストで検証する |
| 任意のトークンの偽造（Auth の乗っ取り） | Signer は 3 つの種類と上限だけを許す。署名の要求の数を、テナントごとに監視する（急増でアラート） |
| 外部 IdP のアサーションの悪用（Auth の乗っ取りで、他の宛先・他のテナントの接続のアサーションを作る） | 用途を 3 つに限り、宛先・有効期間は Signer が登録の値から決める。接続ごとの別の鍵で、テナントの署名鍵を使わない（6.3 節） |
| JWKS の差し替え | S3 の書き込みは Worker だけ。バージョニング。7.3 節の確かめ |
| 鍵の管理の API の悪用 | 署名のポートと分け、Management API からだけ（[ADR-0059](../decisions/0059-signer-isolation.md)）。操作は監査ログ（[ADR-0054](../decisions/0054-audit-log.md)） |
| KMS の鍵の削除・キーポリシーの変更 | SCP で拒否。2 人の承認。CloudTrail の即時の通知 |
| メモリーの露出 | コアダンプなし、ECS Exec なし、依存の最小化（[ADR-0059](../decisions/0059-signer-isolation.md)）。残る危険として受け入れる（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)） |
| 秘密のログへの出力 | 秘密鍵、DEK、pepper、復号した秘密をログ・トレースに出さない。`kid` と版だけを出す |

この領域の変更は `security:sensitive` のラベルを付け、セキュリティの担当の承認を必須にする。

## 10. テスト

### 10.1 決定表

- 5.2 節の操作 × 状態の各行を表駆動テストにする。
- 6.1 節の Signer の検査の各行（種類 × `typ` × クレーム × 有効期間 × テナント）。

### 10.2 性質ベーステスト

- 任意の操作の列（ローテーション、失効、緊急、アルゴリズムの変更）で、各テナントの `current` と `next` はちょうど 1 つずつ、`previous` は 2 つ以下。
- 任意の操作の列の後、書き出した JWKS は、`next`・`current`・`previous` の公開鍵と一致し、`revoked` の鍵を含まない。
- 任意の操作の列で、Signer が署名に使う鍵は、署名の時点（2 秒の窓を除く）の `current` だけ。
- 通常のローテーションの前に `current` で署名したトークンは、次のローテーションの後も、`previous` が失効するまで JWKS で検証できる。
- 任意の 2 テナントで、テナント A の要求で、テナント B の鍵で署名した JWT は得られない（[ADR-0002](../decisions/0002-tenancy-and-isolation.md) の Confirmation）。
- 任意の `signing_keys` の行の入れ替え（`tenant_id`・`kid` の書き換え）で、復号に失敗する。

### 10.3 結合・訓練

- 障害の注入（AWS FIS、staging）：KMS への到達を止めて署名が続くこと、Worker を止めて失効が `pending` のままになること、東京の S3 を止めて JWKS が大阪から返ること（[ADR-0058](../decisions/0058-edge-and-custom-domains.md)）。
- 緊急のローテーションの訓練（四半期）：監視用のテナントで緊急のローテーションを行い、7.3 節の確かめまでの時間を測る。
- pepper の復旧の訓練（四半期。4 節）。
- IAM の静的検査：各 KMS の鍵の `Decrypt` を持つ主体が、3 節の図のとおり。
- 適合試験：OIDC Basic の OP のプロファイルで、ID トークンの署名を JWKS で検証できる。ローテーションの前後で通る（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md) の Confirmation）。

## 11. ADR

| ADR | 決定 |
| --- | --- |
| [0045](../decisions/0045-kms-key-hierarchy.md) | KMS の鍵を用途ごと（署名鍵、資格情報、pepper、保存）に 4 つに分け、暗号化の文脈とキーポリシーで使える主体を限る。pepper は KMS で作り、暗号文だけを置く |
| [0046](../decisions/0046-signing-key-lifecycle.md) | 署名鍵は `next`・`current`・`previous`（2 つまで）・`revoked`。`next` は JWKS に載せて 15 分で ready。緊急のローテーションは `current` を直接失効させる。定期の自動のローテーションは既定で無効 |
| [0047](../decisions/0047-signer-api-and-jwks-publishing.md) | Signer はテナントの 3 つの種類のトークンと、型を分けた外部 IdP のアサーション（3 つの用途）だけに署名し、鍵の生成は Signer の中で行って暗号文だけを返す。JWKS は outbox から Worker が S3 に書き出し、CloudFront で 5 分・1 分のキャッシュ、24 時間の古い版で配る |

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `kms-key-hierarchy` | 4 つの KMS の鍵、キーポリシー、SCP、CloudTrail の通知、IAM の静的検査（Terraform） |
| E1 | `pepper-bootstrap` | pepper の生成、Secrets Manager とアーカイブ、起動時の読み込み、版 |
| E1 | `tenant-data-keys` | テナントの DEK の作成・キャッシュ・ローテーション、AAD |
| E1 | `signer-sign-api` | 署名の API と 6.1 節の検査、`sign-batch` |
| E3 | `signer-key-management-api` | `keys:generate`、`keys:invalidate`、ポーリング |
| E6 | `signer-external-idp-assertions` | 6.3 節の API と `external_idp_keys`、`external-keys:import`（Apple の `.p8`）、`apple_client_secret`。`oidc_client_assertion`・`saml_authn_request` は E14 で足す |
| E3 | `signing-key-lifecycle` | 5.2 節の操作、Management API、監査の事象 |
| E3 | `jwks-and-discovery-publishing` | Worker の書き出し、S3、CloudFront の無効化、7.3 節の確かめ |
| E3 | `emergency-key-rotation` | テナントと全部の緊急のローテーション、キルスイッチ |
| E3 | `scheduled-key-rotation` | 定期の自動のローテーション（テナントの設定） |
| E9 | `dashboard-signing-keys` | 鍵の一覧、ローテーション・失効・緊急の画面、失効の状態（`pending`・`published`・`completed`） |
| E10 | `key-log-events` | 鍵の操作のログのイベントとログストリーム |
| E12 | `key-emergency-drills` | 緊急のローテーションと Signer の侵害の訓練、pepper の復旧の訓練 |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- **定期の自動のローテーション**：既定は無効。テナントが 30〜365 日で有効にできる（本家は自動のローテーションを持たない）。
- **`previous` の数**：2 つまで。超えるローテーションは、古い方の失効を先に求める。
- **`next` の ready**：JWKS の確かめから 15 分。
- **JWKS のキャッシュ**：RP に 300 秒、CloudFront に 60 秒、オリジンの障害中は 24 時間の古い版（[ADR-0058](../decisions/0058-edge-and-custom-domains.md) が keys-and-secrets の領域に任せた値）。
- **`kid`**：RFC 7638 の thumbprint。
- **ローテーションの API のレート制限**：テナントごとにバースト 5・1 日 5 回（本家と同じ）、緊急は別に 1 時間 3 回。
- **古い `current` で署名しうる時間**：2 秒。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| JWKS に `x5c`（自己署名の証明書）を載せるか。本家は署名の証明書（PEM）をダッシュボードから取れる。古いライブラリや SAML の相手が求める | E3 で、主要なライブラリの要否を確かめて決める。SAML の IdP の機能（MVP の後）では要る |
| RSA を 3072 ビットにするか | 署名の CPU（[ADR-0063](../decisions/0063-cpu-bound-work-sizing.md)）と、NIST の移行の時期を見て E12 で決める |
| 主要な RP のライブラリの JWKS のキャッシュの振る舞い（未知の `kid` での取り直し、`max-age` の扱い） | E3 で、`jose`、`jwks-rsa`、Spring Security などを確かめる（未検証） |
| pepper を HSM などの専用の隔離へ移すか | S3 の前（[architecture/README.md](README.md) の 6 節） |
| 耐量子の署名（ML-DSA など）への移行 | JOSE の標準化の状況を見て、S2 以降に検討する |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- Signer の署名の p99（目標 10 ミリ秒）と、キャッシュにない鍵の署名の割合。
- Signer の検査で拒否した要求の数（0 でないならアラート。Auth の不具合か乗っ取りの兆候）。
- JWKS の書き出しから CloudFront での確かめまでの時間（p95 で 2 分以内）と、確かめの失敗の数。
- 失効の操作の `completed` までの時間。
- 緊急のローテーションの訓練の所要時間（四半期）。
- pepper の版ごとのハッシュの数と、古い版の残り。
- KMS の `ThrottlingException` の数（0 を目標）。

### runbooks

- `emergency-key-rotation.md`：テナントの鍵の漏えいの疑いでの緊急のローテーション。判断の基準、2 人の承認、テナントへの連絡、JWKS の確かめ、キルスイッチ（[ADR-0056](../decisions/0056-operator-access.md) が参照する）。
- `signer-compromise.md`：Signer 全体の侵害の疑い。全テナントの緊急のローテーションの順序と見積もり。
- `pepper-recovery.md`：pepper の暗号文を失ったときの、アーカイブからの復旧。pepper の漏えいの疑いのときの版の切り替え。
- `jwks-publication-stale.md`：JWKS の確かめが失敗したときの切り分け（Worker、S3、CloudFront）と、手での書き出し。
- `kms-outage.md`：KMS の障害中の振る舞いの確認と、Signer・Auth を縮小しないことの確認。

### data-model（索引への追加の提案）

| テーブル | 中身 |
| --- | --- |
| `signing_keys` | `tenant_id`、`kid`、`alg`、`state`（`next`・`current`・`previous`・`revoked`）、`public_jwk`、`private_key_ciphertext`、`dek_ciphertext`、`kms_key_arn`、`created_at`、`published_at`、`ready_at`、`activated_at`、`rotated_out_at`、`revoked_at`、`revoke_reason`（`manual`・`emergency`・`scheduled`）、`last_used_at`。失効で `private_key_ciphertext` と `dek_ciphertext` を消す |
| `signing_key_state_versions` | `tenant_id`、`version`、`updated_at`（Signer のポーリング用） |
| `signing_key_issuers` | `tenant_id`、`issuer`（テナントのホストとカスタムドメイン。Signer の `iss` の検査用） |
| `signing_key_operations` | `tenant_id`、`id`、`kind`、`requested_by`、`state`（`pending`・`published`・`completed`・`failed`）、`created_at`、`completed_at` |
| `jwks_publications` | `tenant_id`、`host`、`state_version`、`sha256`、`s3_version_id`、`published_at`、`verified_at` |
| `tenant_data_keys` | `tenant_id`、`version`、`dek_ciphertext`、`created_at`、`retired_at` |
| `pepper_versions`（テナントの外） | `version`、`secret_name`、`state`（`current`・`active`・`retired`）、`created_at`、`hash_count`、`counted_at` |
| `external_idp_keys` | `tenant_id`、`id`、`connection_id`、`purpose`、`alg`、`kid`（Apple の Key ID など）、`public_jwk`、`certificate`（SAML）、`private_key_ciphertext`、`dek_ciphertext`、`params`（`iss`・`sub`・`aud`・宛先。登録の値）、`state`（`active`・`retired`）、`created_at`、`retired_at`。RLS。Signer は SELECT だけ |

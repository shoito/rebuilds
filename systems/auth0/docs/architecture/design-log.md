# Design log: Auth0

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-27：既定案

PM の方針（本家 Auth0 に寄せる、既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に集めた。計測・PoC・選定で決めるものは、下の「持ち越し」に置いた。

- **ADR の状態**：基盤の ADR（0001〜0005）を、他の題材と同じく `accepted` にした（2026-09-27）。先に、ADR-0005 の NFR の番号（リージョンの障害は NFR-006）と縮退の表（漏えいしたパスワードの照合、Actions の実行の基盤、LDAP のコネクタ、エンタープライズの IdP）を直し、ADR-0004 を ADR-0025 に揃えた。intent.md も `accepted` にした。
- **本家の名前・接頭辞を使わない**（リポジトリ共通の ADR-0006）。ヘッダー・Cookie・ドメイン・接頭辞・クレームの名前空間は `<Brand>`・`<brand>`。本家から移るテナントの `auth0|...` の `user_id` は、テナントの顧客のデータとして受け取り、そのまま `sub` にする（本システムが作る識別子ではない。[users-and-profiles.md](users-and-profiles.md) の 3.1 節）。ログの種類のコード（`s`、`fp` など）と `/mfa/challenge`・`org_` のような一般の名前は、本家の名前を含まないので使う。
- **適合試験の対象**：OP の Basic・Config・Form Post・RP-Initiated Logout・Back-Channel Logout。Form Post を加え（intent の K2 の「未定」を埋めた）、Dynamic は持たない。GA の判定は `main` の夜間で 7 日続けて通ること（[quality.md](../quality.md)）。
- **漏えいしたパスワード**：法務の確認までは公式の range API を使い、自前のホストは確認の後（ADR-0025 を正とし、ADR-0004・connections.md・attack-protection.md を揃えた）。
- **Signer の範囲**：テナントのトークン（ID・アクセス・ログアウト）に加え、**型を分けた外部 IdP のアサーション**（`apple_client_secret`、`oidc_client_assertion`、`saml_authn_request`）に署名する。接続ごとの鍵（`external_idp_keys`）を使い、宛先と有効期間は Signer が登録の値から決める（ADR-0047、[keys-and-secrets.md](keys-and-secrets.md) の 6.3 節、security.md）。Signer の DB のロールは 4 つの表（ADR-0059 を揃えた）。
- **HSTS**：本システムのドメインは `includeSubDomains` 付き。カスタムドメインには HSTS を付けるが `includeSubDomains`・`preload` は付けない（custom-domains.md を正とし、security.md の SEC-024 を直した）。
- **AWS のアカウント**：Actions のための `actions` のアカウントを足した（ADR-0057、infrastructure.md）。作るのは E13 の着手時。
- **MFA の API**（`/mfa/challenge` など、埋め込み・ネイティブ向け）：MVP では持たず、MVP の後に扱う形を [mfa-and-passkeys.md](mfa-and-passkeys.md) の 8.1 節に書いた。
- **データベース接続の `authentication_methods`**（`password`・`passkey`）：connections.md の 4.1.1 節に足した（パスキーだけのユーザーを作るための設定）。
- **組織ごとのカスタムドメイン**：持たない（organizations.md、ADR-0051 を正とし、custom-domains.md の E14 の Story を外した）。
- **ログインのトランザクションの用語**：`login_transactions` の行を「トランザクション」、その参照の乱数を「handle」と呼び、画面の URL の `state` で運ぶ。アプリの OAuth の `state` とは別物（authentication-flows.md の 5.4 節、universal-login.md の 4 節）。
- **データモデル**：クライアントの資格情報は `client_credentials` の 1 つの表、`refresh_token_families` は 1 つの定義にまとめ、ユーザーを指す列は `user_pk` に揃え、テナントの外の表を理由とともに列挙した（[data-model.md](data-model.md) の 3・9 節）。
- **ログの種類のコード**：本家に同じ意味のコードがあればそれを使い（`limit_wc`、`limit_mu`、`pwd_leak` など）、ないものは `ap_*` などの独自のコードにする（ADR-0042。attack-protection.md の 8 節を揃えた）。Back-Channel Logout の失敗は `oidc_backchannel_logout_failed`。
- **Epic**：E13 は Actions、E14 は Organizations とエンタープライズ接続。インポート・エクスポート、SCIM、PAR・DPoP・トークン交換・mTLS、SMS、MFA の API は「後回し」（[roadmap.md](../roadmap.md)）。
- **数値の正本**：レート制限は [management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 6 節。トークンの有効期間は [ADR-0008](../decisions/0008-token-lifetimes-and-claims.md)。セッションは使われない期間 3 日・最終の期限 7 日（[ADR-0027](../decisions/0027-server-side-sessions.md)）。JWKS のキャッシュは RP 300 秒・CloudFront 60 秒・オリジンの障害中 24 時間（[ADR-0047](../decisions/0047-signer-api-and-jwks-publishing.md)）。設定の反映は最大 15 秒（ADR-0032）。保持の期間は [security.md](security.md) の 9 節。SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。
- **検証の工程の後の既定案**（2026-09-27）：
  - 認証のイベントのログの `user_name` には、本家と同じくメールアドレスを載せる。保持は `log_retention_days`、ストリームでは伏せ字を選べる（[logs-and-streams.md](logs-and-streams.md) の 3.1 節、[users-and-profiles.md](users-and-profiles.md)）。
  - 429 は方針の制限だけに使い、理由を `<Brand>-RateLimit-Reason`（`tenant`・`endpoint`・`user`・`concurrency`・`attack_protection`）で示す。過負荷・依存先の都合は 503 にする（[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 7.2 節、ADR-0062・ADR-0005 の注記）。
  - Cookie はすべて `__Host-` の接頭辞にする（`__Host-<brand>_did`・`__Host-<brand>_mfa_rd` を含む。一覧は [sessions-and-sso.md](sessions-and-sso.md) の 3.1 節）。
  - `consent_records` は `user_pk` で参照する（ADR-0013、[data-model.md](data-model.md) の 2 節）。
  - 署名鍵のローテーションの API の制限は、本家と同じバースト 5・1 日 5 にする（ADR-0046 の注記）。
- **訓練の頻度**：1 テナントの緊急のローテーションは四半期（ADR-0046 と keys-and-secrets.md に揃え、runbook を直した）。DR の計画外のフェイルオーバーは四半期、本番の switchover は年 1 回（ADR-0060）。
- 領域ごとの決定は、各文書の「決定」の節にある：[authentication-flows.md](authentication-flows.md) の 14 節、[universal-login.md](universal-login.md) の 17 節、[connections.md](connections.md) の 13 節、[users-and-profiles.md](users-and-profiles.md) の 16 節、[mfa-and-passkeys.md](mfa-and-passkeys.md) の 15 節、[attack-protection.md](attack-protection.md) の 17 節、[sessions-and-sso.md](sessions-and-sso.md) の 13 節、[tenants-and-applications.md](tenants-and-applications.md) の 13 節、[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 14 節、[dashboard.md](dashboard.md) の 12 節、[custom-domains.md](custom-domains.md) の 12 節、[email-delivery.md](email-delivery.md) の 16 節、[logs-and-streams.md](logs-and-streams.md) の 12 節、[keys-and-secrets.md](keys-and-secrets.md) の 13 節、[extensibility.md](extensibility.md) の 13 節、[organizations.md](organizations.md) の 13 節。

## 2026-09-27：推奨案で確定

PM の方針（判断が要るところは推奨案で進める）により、法務以外の確認待ち・持ち越しを、次のとおり決めた。法務の確認待ちと、法務の結論に依るもの、計測・PoC が要るものは、下の「持ち越し」に残した。

- **`private_key_jwt` の `aud`**：`issuer` だけを受ける。`draft-ietf-oauth-rfc7523bis` に合わせる。移るクライアントのために、アプリごとの互換のフラグ `legacy_token_endpoint_aud`（既定は無効、GA から 12 か月で廃止）を置く（[authentication-flows.md](authentication-flows.md) の 6.1・14 節、[ADR-0007](../decisions/0007-client-authentication-methods.md) の注記、[tenants-and-applications.md](tenants-and-applications.md) の `clients`）。
- **外向きの `oidc_client_assertion` の `aud`**：同じ規則で、IdP の `issuer` にする。主要な IdP が受けるかは E14 で確かめる（[keys-and-secrets.md](keys-and-secrets.md) の 6.3・13 節）。
- **429 と 503 の分け方**：ADR-0005 の注記（429 は方針の制限、503 は過負荷・依存先の都合）を承認した。SLI を状態コードだけで分けられる（[ADR-0005](../decisions/0005-authentication-path-availability.md)、[ADR-0062](../decisions/0062-sli-and-synthetic-monitoring.md)）。
- **OpenID Foundation の会員**：E12 の前に会員になる。認証の費用は会員 700 USD・非会員 3,500 USD で、プロファイルが 5 つある（[intent.md](../intent.md)、[ADR-0064](../decisions/0064-conformance-suite-in-ci.md)、[roadmap.md](../roadmap.md) の E12）。
- **適合試験の Form Post**：対象に含める。PM の決定として確定した（[authentication-flows.md](authentication-flows.md) の 13.3・14 節、intent の K2）。
- **統合で足した値**：列挙の時間の差の p90 10%（QA。[quality.md](../quality.md) の 2.2.1 節、[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)）、`refresh_token_families.rotation` の列（Dev。[data-model/login-and-sessions.md](data-model/login-and-sessions.md) の 2 節）、Story の名前（PM。[roadmap.md](../roadmap.md)）、runbook の名前（Ops。[runbooks/](../runbooks/README.md)）を、そのまま受け入れた。
- **漏えいしたパスワードの予備の案**：公式の range API を使う間の ADR-0005 の縮退の表の行を、Dev のテックリードの確認として確定した（[attack-protection.md](attack-protection.md) の 17 節）。
- **イントロスペクション**：持たない。JWT を JWKS で確かめる形で足りる（[authentication-flows.md](authentication-flows.md) の 14 節）。
- **`resource`（RFC 8707）**：MVP では受けない。トークン交換で受けるときは `audience` と同じ意味に扱う（同上）。
- **同意の画面の一部の許可**：持たない。まとめて許すか断るかにし、形を単純に保つ（同上）。
- **JWKS の `x5c`**：載せない。OIDC の検証に要らない（[keys-and-secrets.md](keys-and-secrets.md) の 13 節）。
- **耐量子の署名**：S1 では持たない。標準化を待つ（同上）。
- **セッション**：アプリごとの有効期間の上書きは持たない。`federated` のログアウトは E14 で扱う。パスワードの変更・再設定で他のセッションを既定で終える。端末の記憶は別の Cookie。Back-Channel Logout の出口は `worker-egress`（[sessions-and-sso.md](sessions-and-sso.md) の 13 節、[connections.md](connections.md) の 13 節）。
- **K3 の測り方**：データベース接続だけで測る。開発者キーを持たないため（[connections.md](connections.md) の 13 節）。
- **よく使われるパスワードの一覧**：本家と同じ SecLists の 1 万件（同上）。
- **ライブラリ**：WebAuthn は `@simplewebauthn/server`、SAML は第一候補を `@node-saml/node-saml` にする。どちらも着手時に基準を確かめ、満たさないときだけ見直す（4 節、[mfa-and-passkeys.md](mfa-and-passkeys.md) の 15 節、[connections.md](connections.md) の 13 節）。
- **MFA**：BE=1 を拒む設定は AAL3 と一緒に S2 以降。アカウントの画面は MVP の後。IdP の `amr`・`acr` は既定で引き継がない（[mfa-and-passkeys.md](mfa-and-passkeys.md) の 15 節）。
- **Public Suffix List**：`jp.<brand>.<domain>` を登録し、テナントのホスト名を互いに別の site にする。防御は登録に頼らない（[universal-login.md](universal-login.md) の 17 節、[custom-domains.md](custom-domains.md) の 12 節）。
- **ブランディング**：テナントの任意の HTML は MVP で入れない。サインアップの追加の項目は MVP の後に 3 つの型で足し、`user_metadata` に保存する（[universal-login.md](universal-login.md) の 17 節）。
- **カスタムドメイン**：アプリごとにドメインを縛らない。配信のテナントの上限は、先に引き上げを申請する。DNS の確認は Google Public DNS と Cloudflare の DoH の 2 つで行う（[custom-domains.md](custom-domains.md) の 12 節）。
- **メール**：SES の上限は S2 の前に引き上げを申請する。予備の SES のアカウントは、合成監視のメールで毎日暖める（[email-delivery.md](email-delivery.md) の 16 節）。
- **ユーザー**：仮名の `sub` は持たない。本人のメタデータの更新は MVP の後。SCIM の最初のバージョンは `Users` だけ（[users-and-profiles.md](users-and-profiles.md) の 16 節）。
- **テナント**：アカウントを請求・契約の単位にする。ワイルドカードのコールバックの移行は、URL の個別の登録で支える（[tenants-and-applications.md](tenants-and-applications.md) の 13 節）。
- **Actions**：同期のトリガーの時限は既定 10 秒、テナントの上書きで 20 秒まで（[extensibility.md](extensibility.md) の 13 節、[ADR-0048](../decisions/0048-extensibility-triggers-and-failure-policy.md)）。
- **EventBridge の SaaS パートナーの登録**：E10 の着手前に申請する（[logs-and-streams.md](logs-and-streams.md) の 12 節）。

持ち越し（法務、計測・PoC で決めるもの）：

| 項目 | 理由 | いつ・どう決めるか |
| --- | --- | --- |
| 法務の確認待ち（L1〜L8、Pwned Passwords のデータセットの利用の条件、署名鍵の失効の権限と運用者の参照の契約） | 法務 | [intent.md](../intent.md) の「法務の確認待ち」、[security.md](security.md) の 13 節。結論まで、そこに挙げた spec を承認しない |
| 法務の結論に依るもの（第三者の CAPTCHA、WAF の ATP、ログの保持の日数の上限、同意の記録の削除の後の扱い、ログストリームの国外への送信、SMS の送信事業者） | 法務に依る | 各領域の文書の「未解決の問い」。L1・L2・L4・L5・L7・L8 の結論の後 |
| Argon2id のパラメーター、ハッシュのタスクの数、Signer のタスクの数 | 計測 | E12 の負荷試験（k6。[capacity.md](capacity.md) の 5 節） |
| RSA を 3072 ビットにするか | 計測 | 署名の CPU を E12 で測って決める（[keys-and-secrets.md](keys-and-secrets.md) の 13 節） |
| pepper の鍵の置き場所を、S3 で専用の隔離（HSM など）へ移すか | PoC | S3 の前。NIST SP 800-63B-4 は、鍵をハードウェアで守ることを勧めている |
| Nitro Enclaves を Fargate で使えるか | PoC | 使えない（EC2 の親インスタンスが要件。[What is Nitro Enclaves?](https://docs.aws.amazon.com/enclaves/latest/user/nitro-enclave.html)、2026-09-27 に確認）。S3 で Signer を EC2 に移すかを、S3 の前に評価する |
| Lambda のテナントの隔離のモードのコールドスタートと費用 | PoC | E13 の最初の PoC（[extensibility.md](extensibility.md) の 13 節） |
| 列挙の時間の差の 5% の妥当性、画面の LCP の目標、証明書の発行の時間、共有の送信の 1 日の上限、検索を専用の基盤へ移すか、攻撃の防御の閾値と PoW の難しさ、M2M の発行のログを失う件数 | 計測 | 各領域の文書の「持ち越し」（E3・E8・E11・E12、S2 の前） |
| 本家の振る舞いで未確認のもの（不審な IP の抑制のサインアップの補う速度の既定、認可コードの有効期間、ログインのトランザクションの有効期間、ブロックしたユーザーのリフレッシュトークン、リフレッシュでの組織のメンバーシップの確認など。セッションの既定値・リフレッシュトークンの猶予・ログのコードの意味は 2026-09-27 に確かめた） | 確かめるだけ（決定は済み） | 各領域の文書の「持ち越し」に書いた Epic で、本家の資料か試用のテナントで確かめる |

## 2026-09-28：データモデル

ユーザーの依頼（各題材のデータモデルを十分に設計し、ER 図を付ける）により、[data-model.md](data-model.md) を索引から形の正本に変え、`data-model/` に領域ごとの定義（92 テーブル、ER 図 14 個）を置いた。ADR の決定は変えていない。判断が要ったところは推奨案で決めた（詳細は [data-model.md](data-model.md) の 9.2 節）。

- **分割の鍵**：時間で切る表は UUIDv7 の `id` の範囲で切る。旧い `audit_events` の `RANGE (occurred_at)` は主キーと合わず作れなかったので直した。分割した表のハッシュの引き当ては普通の索引にし、1 回限りは条件付きの更新で守る。
- **テナントの外の表**：`signing_key_state_versions` を足した（Signer が全テナントのバージョンを読むため。値はバージョンと時刻だけ）。
- **列の名前と型**：管理者を指す列は `member_user_id`（管理用のテナントの `sub`）、`credential_tickets` はリンクの `secret_hash` とコードの `code_hash` に分けた、`clients` の主キーは `(tenant_id, client_id)`。
- **Valkey とリース**：Valkey のキーは `<用途>:{t:<tenant_id>}:...` で IP を HMAC にする。ログストリームのリースは DB の行で持つ。
- **持ち越し**：`refresh_tokens` の行の数（再利用の検知のため使用済みの行を残すと S1 で十数億行になりうる）を E12 で測り、多ければ ADR-0003 の改訂を Dev のテックリードに諮る（[data-model.md](data-model.md) の 9.4 節）。

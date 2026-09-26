# Decisions: Auth0

Auth0 の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤の上に、検証済みの部品で認可サーバーを自前で実装する | accepted |
| [0002](0002-tenancy-and-isolation.md) | テナントを分離と設定の単位にし、共有スキーマと RLS で分ける | accepted |
| [0003](0003-token-formats-and-signing-keys.md) | アクセストークンと ID トークンはテナントの鍵で署名した JWT にし、秘密鍵は Signer の中だけで使う | accepted |
| [0004](0004-credential-storage.md) | パスワードは Argon2id、高エントロピーの秘密はハッシュ、戻す必要のある秘密はエンベロープ暗号化で持つ | accepted |
| [0005](0005-authentication-path-availability.md) | 認証の経路を管理の経路から分け、依存先が落ちても縮退して動かし続ける | accepted |
| [0006](0006-authorization-code-pkce-and-exact-redirect.md) | 認可の要求は認可コード＋PKCE（S256）だけにし、`redirect_uri` は完全一致で照合する | accepted |
| [0007](0007-client-authentication-methods.md) | クライアントの認証は `client_secret_basic`・`client_secret_post`・`private_key_jwt`・`none` にし、秘密で署名する方式は持たない | accepted |
| [0008](0008-token-lifetimes-and-claims.md) | トークンの有効期間の既定と上限を決め、アクセストークンは 1 つの API に宛てる | accepted |
| [0009](0009-device-authorization-grant.md) | デバイスの認可は RFC 8628 に従い、BASE20 の 8 文字のユーザーコードと、明示の確認の画面で行う | accepted |
| [0010](0010-staged-protocol-extensions.md) | PAR・DPoP・トークン交換・mTLS は、MVP の後に、認可コードの経路の上にフラグで足す | accepted |
| [0011](0011-universal-login-rendering-and-transaction.md) | Universal Login はサーバーで描く HTML にし、ログインの途中の状態はサーバーのトランザクションに持って、ブラウザの Cookie に結び付ける | accepted |
| [0012](0012-branding-and-templates.md) | ブランディングはテーマの変数と文言の上書きに限り、テナントの任意の HTML・JavaScript は画面に入れない | accepted |
| [0013](0013-consent-records.md) | 規約への同意は、文書の版ごとに追記だけの表に記録し、記録の成功をサインアップの完了の条件にする | accepted |
| [0014](0014-connection-abstraction.md) | 接続を「資格情報を確かめて外部の ID を返す部品」として抽象化し、ユーザーとは ID で結ぶ | accepted |
| [0015](0015-database-connection-password-and-enumeration.md) | データベース接続は NIST SP 800-63B-4 のパスワードの規則に従い、サインアップ・ログイン・再設定でアカウントの有無を明かさない | accepted |
| [0016](0016-social-connections-and-idp-tokens.md) | ソーシャル接続は共通の OAuth・OIDC のクライアントと IdP ごとの差分で作り、IdP のトークンは既定で保存しない | accepted |
| [0017](0017-enterprise-connections.md) | エンタープライズ接続（MVP の後）は、SAML の SP を保守されたライブラリで作り、LDAP は外向きにだけつなぐコネクタで受ける | accepted |
| [0018](0018-user-identifier-and-profile-store.md) | ユーザーの ID は接続から独立した不透明な値にし、再利用しない。メタデータに固い上限を置く | accepted |
| [0019](0019-account-linking.md) | ID のリンクは両方の ID での本人の認証を必須にし、メールアドレスの一致だけでは自動にリンクしない | accepted |
| [0020](0020-user-search-and-lifecycle.md) | ユーザーの検索は Aurora の reader の上の限られた言語で行う。ブロックと削除は状態機械で扱い、削除した ID を墓標で守る | accepted |
| [0021](0021-authenticator-model-and-assurance-levels.md) | MFA の要素を認証器の共通の型で持ち、達成した AAL を `acr` で返す。メールの OTP は AAL2 に数えない | accepted |
| [0022](0022-webauthn-and-passkeys.md) | WebAuthn は保守されたライブラリで検証し、RP ID をテナントで固定する。UV 付きのパスキーは単独で MFA を満たす | accepted |
| [0023](0023-otp-and-recovery-codes.md) | TOTP は RFC 6238 の既定で再利用を拒む。リカバリーコードは Argon2id、メールの OTP は鍵付きハッシュで保存し、どちらも試行の上限で守る | accepted |
| [0024](0024-attack-protection-counters-and-enforcement.md) | 攻撃の防御の判定をハッシュの前の 1 つの段にまとめ、数は Valkey、ブロックは DB に持つ。識別子の HMAC と既知の端末の Cookie で数える | accepted |
| [0025](0025-breached-password-detection.md) | 漏えいしたパスワードは k-匿名性で照合する。データの自前のホストは利用条件の確認を条件にし、確認までは公式の range API を使う | accepted |
| [0026](0026-bot-detection-and-challenge.md) | ボットの検知は自前のリスクの点数と自前の proof-of-work のチャレンジで行う。WAF はエッジの後ろ盾、第三者の CAPTCHA は法務の L2 の後 | accepted |
| [0027](0027-server-side-sessions.md) | セッションはサーバーの側に持ち、`__Host-` の Cookie には不透明な秘密だけを入れる | accepted |
| [0028](0028-logout-rp-initiated-and-back-channel.md) | ログアウトは RP-Initiated と Back-Channel を出し、Back-Channel は Worker が再試行ごとにトークンを作り直して送る | accepted |
| [0029](0029-refresh-token-session-binding.md) | リフレッシュトークンの系列は、アプリの設定でセッションに結び付けるか独立にするかを決める | accepted |
| [0030](0030-accounts-tenants-and-members.md) | テナントの上にアカウントを置き、テナントの名前は再利用せず、環境は昇格だけを許す | accepted |
| [0031](0031-application-and-api-registration.md) | アプリの種類でクライアントの認証とグラントの上限を決め、コールバックはワイルドカードなしにし、M2M はアプリ × API の許可で守る | accepted |
| [0032](0032-tenant-config-cache.md) | テナントの設定は版付きの不変のスナップショットでタスクに持ち、pub/sub とポーリングで最大 15 秒で反映する | accepted |
| [0033](0033-management-api-shape.md) | Management API は本家に寄せた `/api/v2` のリソースにし、2 種のページングを持ち、v2 の中では足す変更だけをする | accepted |
| [0034](0034-management-api-authorization.md) | Management API は 3 種のトークンを受け、M2M は要求ごとに今の許可を確かめ、自分より広い許可を作らせない | accepted |
| [0035](0035-rate-limiting.md) | レート制限は本家の単位と Enterprise の値に寄せ、環境で変えてプランで変えず、Valkey の GCRA で数え、リフレッシュを優先する | accepted |
| [0036](0036-dashboard-login-via-admin-tenant.md) | ダッシュボードは静的な SPA にし、管理者は本システムの管理用のテナントでログインする | accepted |
| [0037](0037-break-glass-and-admin-roles.md) | 非常用の経路はテナントの M2M と KMS で署名した運用者の短いトークンにし、ロールは本家に寄せる | accepted |
| [0038](0038-custom-domain-verification-and-certificates.md) | カスタムドメインは TXT で所有を確かめてから配信のテナントを作り、証明書は CloudFront の管理に任せる | accepted |
| [0039](0039-hostname-resolution-and-issuer.md) | ホスト名からテナントを、DB を読まずにプロセスの中の対応表で解決し、リンクとリダイレクトは要求のヘッダーではなく登録したホスト名から作る | accepted |
| [0040](0040-email-sending-platform.md) | メールは Amazon SES（東京）から、テナントごとの SES のテナントと送信ドメインの認証を付けて送り、認証のメールを優先の列で送る | accepted |
| [0041](0041-email-templates-and-tenant-providers.md) | メールのテンプレートは自動でエスケープする制限した Liquid で書かせ、リンクは本システムが作る。テナントの送信事業者は SMTP と SES（クロスアカウント）に限る | accepted |
| [0042](0042-log-event-model-and-type-codes.md) | 認証のイベントは本家の公開のスキーマと種類のコードに寄せ、`log_id` はテナントの中でコミットの順に単調にする | accepted |
| [0043](0043-log-storage-and-search.md) | S1 のログはログの専用の Aurora のクラスタに置き、本家の検索の部分集合を索引で返し、保持はテナントの属性で切る | accepted |
| [0044](0044-log-stream-delivery.md) | ログストリームはストリームごとのカーソルで少なくとも 1 回送り、Webhook に本文の署名を足す | accepted |
| [0045](0045-kms-key-hierarchy.md) | KMS の鍵を用途ごとに 4 つに分け、暗号化の文脈とキーポリシーで使える主体を限る | accepted |
| [0046](0046-signing-key-lifecycle.md) | 署名鍵は `next`・`current`・`previous`・`revoked` で持ち、`next` を先に配ってから切り替える | accepted |
| [0047](0047-signer-api-and-jwks-publishing.md) | Signer はテナントの 3 つの種類のトークンと、型を分けた外部 IdP のアサーションだけに署名し、JWKS は Worker が S3 に書き出してエッジで配る | accepted |
| [0048](0048-extensibility-triggers-and-failure-policy.md) | 拡張のトリガーは同期 3 つと非同期 2 つから始め、同期は全体 10 秒、基盤の障害はテナントが拒否か飛ばすかを選ぶ | accepted |
| [0049](0049-extensibility-execution-isolation.md) | テナントのコードは Lambda のテナントの隔離のモードの共通の実行器で動かし、実行ロールに権限を持たせない | accepted |
| [0050](0050-extensibility-build-secrets-and-limits.md) | npm の依存は隔離したビルドで束ね、秘密は呼び出しの本文でだけ渡し、上限は本家に寄せる | accepted |
| [0051](0051-organization-model-and-login-flow.md) | 組織はテナントの中のメンバーシップの単位にし、ログインの流れは本家の設定を決定表で持つ | accepted |
| [0052](0052-organization-tokens-sessions-and-membership.md) | 組織の文脈のトークンに `org_id` を入れ、リフレッシュの系列を組織に結んでメンバーシップを毎回確かめる | accepted |
| [0053](0053-rfc9700-checklist-and-negative-tests.md) | RFC 9700 の要件と脅威モデルを要件 ID の表にし、要件ごとに拒否の側のテストを持つ | accepted |
| [0054](0054-audit-log.md) | 管理と運用の操作の監査ログは、認証のイベントのログと分け、操作と同じトランザクションで書いて改ざんできない保管庫へ送る | accepted |
| [0055](0055-data-retention-and-deletion.md) | データの保持の既定案を持ち、エンドユーザーの削除は資格情報を先に即時に消し、バックアップの期限を削除の最終の期限にする | accepted |
| [0056](0056-operator-access.md) | 社内の運用者は本番に常設の権限を持たず、テナントのデータの参照はテナントの許可と期限つきの権限で行う | accepted |
| [0057](0057-accounts-network-and-path-separation.md) | AWS のアカウントを用途で分け、認証の経路と管理の経路を入口・ALB・DB の接続まで分ける | accepted |
| [0058](0058-edge-and-custom-domains.md) | エッジは CloudFront＋WAF にし、カスタムドメインは CloudFront のマルチテナントの配信のテナントとして受ける | accepted |
| [0059](0059-signer-isolation.md) | Signer を外への経路のない専用のサブネットに置き、呼べるのは Auth のタスクだけにする | accepted |
| [0060](0060-disaster-recovery-and-stages.md) | 大阪のウォームスタンバイへ人の判断で切り替え、失った範囲のセキュリティを強める操作をやり直す。S3 でテナントをセルに固定する | accepted |
| [0061](0061-secret-free-telemetry.md) | 計装は許可リストの型を通したものだけを出し、秘密の形をログ・トレース・アクセスログの 4 か所で防ぐ | accepted |
| [0062](0062-sli-and-synthetic-monitoring.md) | 認証の経路の SLI は本番のテナントの要求をエッジとサーバーの両方で数え、4xx と方針の 429 を成功、過負荷の 503 を失敗にする | accepted |
| [0063](0063-cpu-bound-work-sizing.md) | Argon2id は Auth のタスクの中の固定の数のスレッドで計算し、Signer は鍵を遅延で読み込んで上限つきで持つ | accepted |
| [0064](0064-conformance-suite-in-ci.md) | OpenID Foundation の適合試験を CI の中で自前で動かし、認証の経路の PR の必須のチェックにする | accepted |
| [0065](0065-security-sensitive-change-flow.md) | `security:sensitive` の変更は、パスで自動にラベルを付け、作成者と別の 2 人の人の承認と、追加の CI の段を必須にする | accepted |
| [0066](0066-tenant-canary-release.md) | 認証の経路の振る舞いの変更は、テナントを単位に、社内・開発の環境・本番の順で広げ、認証の成功率のガードで自動で止める | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

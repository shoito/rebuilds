---
status: accepted
date: 2026-09-27
---

# ADR-0005: 認証の経路を管理の経路から分け、依存先が落ちても縮退して動かし続ける

## Context

テナントのアプリは、ログインとトークンの更新ができないと、ほぼすべての機能が止まる。本家 Auth0 は、Enterprise のプランで月間 99.99% の可用性を約束している（[Auth0 Pricing](https://auth0.com/pricing)、[Service Level Agreements](https://auth0.com/docs/troubleshoot/customer-support/services-level-descriptions)、2026-09-27 に確認）。99.99% の月間の許容の停止は約 4.3 分で、Aurora の writer のフェイルオーバー 1 回で使い切りうる。

本家の基盤は、1 リージョンの 3 AZ に加え、別のリージョンへのジオフェイルオーバーを持つ。Private Cloud では RPO 1 分未満・RTO 15 分未満を示している。データの置き場所として MongoDB・PostgreSQL・Redis・Kafka を使い、エッジで DDoS の防御とレート制限を行う（[Multi-Subscriber Deployment on Converged Architecture](https://auth0.com/blog/multi-subscriber-public-cloud-deployment-on-converged-architecture/)、[The Architect's View of Auth0's New Private Cloud Platform](https://auth0.com/blog/the-architect-s-view-of-auth0-s-new-private-cloud-platform/)、2026-09-27 に確認）。

ここで「認証の経路」は、次のエンドポイントを指す。

- discovery（`/.well-known/openid-configuration`）と JWKS
- `/authorize`、Universal Login の画面（`/u/*`）、ソーシャル接続のコールバック
- `/oauth/token`、`/userinfo`、`/oauth/revoke`、`/oauth/device/code`
- ログアウト（`/oidc/logout`）

## Options

1. **認証の経路を管理の経路と分け、依存先ごとの縮退を決める。セル構成は S3 で入れる**
2. すべてを 1 つのサービスにし、依存先の冗長化（Multi-AZ）だけで守る
3. S1 からセル構成と、東京・大阪の active-active にする

## Decision

1 を採用する。

### 経路を分ける

- **認証の経路（認可サーバー、Universal Login、Signer）と、管理の経路（Management API、ダッシュボード、ログの検索）を、別の ECS のサービスと別の DB の接続プールにする。** 管理の経路の負荷（一括の操作、ログの検索）が、ログインを遅くしない。
- 認証の経路の読み込みは、Aurora の reader を優先する。writer に書くのは、セッション、リフレッシュトークン、認可コード、失敗の回数など、状態を変えるものだけにする。
- ログ・メール・Back-Channel Logout の送信・ログストリームは、transactional outbox から SQS を経て Worker で行う。これらの遅れは、ログインを止めない。

### エッジで配るもの

- **discovery と JWKS は、変わったときに S3 へ書き出し、CloudFront から配る。** オリジン（認可サーバー）を毎回は通らない。CloudFront のオリジングループで、大阪の S3 を予備のオリジンにする。オリジンのエラーのときは、古いバージョンを返し続ける（24 時間。[keys-and-secrets.md](../architecture/keys-and-secrets.md) の 7.2 節）。
- Universal Login の静的な資産（CSS、画像、テナントのロゴ）も、CloudFront から配る。
- WAF で、IP のレート制限と、明らかな攻撃を認証の経路の前で落とす。

### 依存先ごとの縮退

| 依存先 | 止まったときの振る舞い |
| --- | --- |
| テナントの設定（アプリ、接続、ブランド、鍵の公開部分） | 各タスクのメモリーにバージョン付きで持つ。更新は通知で知り、DB が読めない間は最後のバージョンで動く（反映の遅れは最大 15 秒。[ADR-0032](0032-tenant-config-cache.md)） |
| Aurora の reader | writer から読む |
| Aurora の writer（フェイルオーバーの数十秒） | クライアントクレデンシャル（DB に書かない）、JWKS・discovery、発行済みのトークンの検証（テナントの側）は続く。ログイン・リフレッシュは短い再試行の後に 503 と `Retry-After` を返し、ログインの画面は再試行を促す |
| Valkey（セッションのキャッシュ、レート制限、攻撃の防御の数） | セッションは DB（正本）から読む。レート制限と攻撃の防御は、タスクのメモリーの近似の数で続ける（全部を通す fail-open にはしない） |
| SQS、Worker | outbox に残り、回復後に送る。ログの反映とログストリームは遅れる |
| KMS | Signer とパスワードの照合は、メモリーの鍵で続ける。新しいタスクの起動、署名鍵の生成、ローテーションはできない。Signer は最小のタスク数を保ち、KMS の障害中は縮小しない |
| Signer | 複数の AZ に複数のタスクを置く。すべてに届かなければ 503。署名を他のサービスで代わりに行う経路は作らない（鍵の境界を優先する）。外部 IdP のアサーション（Apple のクライアントシークレット）は Auth のキャッシュ（1 時間）の間は続き、切れたらその接続だけが失敗する |
| メールの送信事業者 | 確認・再設定・OTP のメールが遅れる。メールの OTP しか持たないユーザーの MFA は失敗する。パスワードとパスキーのログインは続く |
| ソーシャル IdP | その接続だけが失敗する。画面に、他の方法を案内する |
| 漏えいしたパスワードの照合 | **法務の確認まで、公式の range API（外部、国外）への同期の依存になる**（[ADR-0025](0025-breached-password-detection.md)）。範囲の応答を 24 時間キャッシュし、時限は 200 ms。照合できないときは、サインアップ・パスワードの変更・再設定を 503 にする（照合を飛ばさない）。ログインは照合を飛ばして続け、次のログインで調べる。自前のホスト（[ADR-0004](0004-credential-storage.md)）に移った後は、S3 と各タスクのメモリーの範囲で照合し、取り込みに失敗しても前のバージョンで続ける |
| Actions の実行の基盤（Lambda。E13、MVP の後） | Action を使うテナントのトリガーだけが影響を受ける。トリガーの設定 `on_platform_error` が `deny`（既定）なら、そのテナントのログイン・M2M のトークンの発行が失敗する。`skip` なら Action を飛ばして続ける。Action を使わないテナントは影響を受けない。テナントのコードの失敗と時間切れ（同期 10 秒）は、その要求の失敗にする（[ADR-0048](0048-extensibility-triggers-and-failure-policy.md)、[extensibility.md](../architecture/extensibility.md) の 7 節）。管理用のテナントは Actions を使わない |
| LDAP のコネクタ（E14、MVP の後） | コネクタの受け口（`connector.jp.<brand>.<domain>`）は認証の経路のサービスとして置く。すべてのコネクタに届かないか、照合の応答が 10 秒を超えたら、その LDAP の接続だけが失敗し、画面で他の方法を案内する。他の接続は影響を受けない。照合の結果はキャッシュしない（パスワードに由来する値を残さない）。受け口の障害は SAML・OIDC の接続に及ばない（[ADR-0017](0017-enterprise-connections.md)） |
| SAML・OIDC のエンタープライズの IdP（E14） | ソーシャル IdP と同じ。その接続だけが失敗する |

### 過負荷のとき

- 優先の順は、トークンの更新と JWKS ＞ ログイン ＞ サインアップ ＞ 管理の経路 とする。優先の低いものから 503（`Retry-After`）で断る。
  > 2026-09-27 の注記：当初は「429・503 で断る」としていた。429 はテナントのレート制限など方針の制限だけに使い、過負荷は 503 にする（[ADR-0062](0062-sli-and-synthetic-monitoring.md) の注記。エッジの SLI で状態コードだけで分けるため）。この分け方（429 は方針、503 は過負荷・依存先の都合）は、2026-09-27 に推奨案で確定した。
- パスワードのハッシュの同時実行に上限を置く（[ADR-0004](0004-credential-storage.md)）。

### リージョンの障害とセル

- S1 から、大阪にウォームスタンバイを置く（Aurora Global Database、署名鍵と pepper の KMS の鍵はマルチリージョンの鍵）。切り替えは人の判断で行い、手順は自動化する。目標は NFR-006。
- 大阪へ切り替えても、署名鍵は同じなので、発行済みのトークンは有効のまま。
- **セル構成は S3 で入れる。** テナントをセルに固定し、東京・大阪で両方が受ける。大口のテナントに専用のセルを割り当てる。決定は [ADR-0060](0060-disaster-recovery-and-stages.md) で行った。
- 2 は、管理の経路の障害や負荷がログインに及ぶ。3 は、S1 の規模で費用と運用が見合わない。

## Consequences

- 良くなること：
  - 依存先の多くの障害で、ログインか、少なくともトークンの検証と M2M のトークンの発行が続く。
  - 縮退の振る舞いが決まっているので、障害の訓練とテストが書ける。
- 引き受けるコスト：
  - テナントの設定のキャッシュのため、設定の変更の反映に遅れがある。ダッシュボードに「反映まで最大 15 秒」と示す。
  - Valkey の障害中は、攻撃の防御の数がタスクごとになり、精度が落ちる。
  - サービスが増え、デプロイと監視の対象が増える。

## Confirmation

- 障害の注入（AWS FIS）：staging で、Aurora の writer のフェイルオーバー、Valkey の停止、SQS への到達不能、KMS への到達不能（ネットワークで遮断）、漏えいしたパスワードの range API への到達不能を起こし、表の振る舞いになることを確かめる。四半期ごとに行う。
- 合成監視：本番のテナント（監視用）で、ログイン・リフレッシュ・クライアントクレデンシャル・JWKS を 1 分ごとに試す。
- レビュー：認証の経路のサービスに、新しい同期の依存を加える PR は、この ADR の表の更新を伴うことを確かめる（[AGENTS.md](../../AGENTS.md)）。

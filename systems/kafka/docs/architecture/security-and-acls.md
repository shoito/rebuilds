# Security and ACLs: Kafka

脅威モデル、サービスアカウントと API キー、SASL と TLS、ACL とテナントの名前空間、保存時の暗号化、監査ログ、データの削除の設計。方針は [ADR-0028](../decisions/0028-service-accounts-api-keys-and-sasl-plain.md)（API キーと SASL）、[ADR-0029](../decisions/0029-tenant-scoped-acls-and-rbac.md)（ACL と制御面のロール）、[ADR-0030](../decisions/0030-encryption-and-audit-logs.md)（暗号化と監査ログ）にある。

本家（Apache Kafka、Confluent Cloud）と AWS の振る舞いは、2026-09-27 に公式の文書で確かめた。確かめられなかったものは「未検証」と書く。この文書の決定表は設計の草案で、要件の ID は E8 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- テナントのデータ（レコード）と資格情報を、他のテナント・外部の攻撃者・当社の運用者の不要なアクセスから守る。
- Kafka のクライアントから見た認証と認可は、本家の振る舞い（SASL、ACL、エラーコード）に合わせる。

範囲に入れないもの：

- 名前空間のパッチの中身（資源の名前の付け外し）。multi-tenancy-and-quotas の領域。
- 拒否する API の一覧。[protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節。
- 証明書の発行の仕組みと、ネットワークの構成（SNI のプロキシ、PrivateLink）。infrastructure の領域。
- コンソールのログイン。[console-and-api.md](console-and-api.md) の 5 節。

## 2. 脅威モデル

守るもの：テナントのレコード、API キーの秘密、ACL と設定、監査ログ、請求の情報。

| # | 脅威 | 入口 | 影響 | 主な対策 | 節 |
| --- | --- | --- | --- | --- | --- |
| T1 | 他のテナントの資源の読み書き | 名前空間のパッチの漏れ、ACL の `*` の誤った解釈 | 分離の崩壊（最重） | 名前空間のパッチ（ADR-0004）。Authorizer の包みで、主体と資源の論理クラスタが同じかを必ず確かめる（二重の守り） | 5 |
| T2 | API キーの漏洩 | ソースコード、ログ、CI の設定 | テナントのデータの読み書き | 接頭辞とチェックサムでシークレットスキャンに載せる。失効を 60 秒で反映。キーを 1 つの論理クラスタに絞る | 3 |
| T3 | 資格情報の総当たり | SASL/PLAIN の認証 | キーの推測 | 秘密は 256 ビット。認証の失敗の遅延と、送信元 IP ごとの失敗の数の制限（IP は Envoy のアクセスログから） | 3.6 |
| T4 | 接続の洪水・認証の前の資源の消費 | SNI のプロキシ、ブローカー | 物理クラスタの全テナントの停止 | 認証の前は ApiVersions と SASL だけを受ける。接続の数と頻度の制限を、プロキシと論理クラスタのクォータで掛ける | 3.6 |
| T5 | 細工した要求によるブローカーの不具合 | Kafka のプロトコル | 物理クラスタの停止、情報の漏洩 | 本家の版の追従（ADR-0005）。差分テストの生成器に壊れた要求を入れる（protocol-and-compatibility の 10 節） | — |
| T6 | 盗聴・改ざん | クライアントとブローカーの間、ブローカーの間 | 資格情報とレコードの露出 | TLS 1.2 以上を必須。平文のリスナーを外に出さない。内部も mTLS | 6.1 |
| T7 | ディスク・S3 の中身の持ち出し | EBS のスナップショット、S3 のバケット、廃棄したボリューム | レコードの露出 | EBS と S3 を物理クラスタごとの KMS のキーで暗号化 | 6.2 |
| T8 | 運用者の不要なアクセス | 本番の操作、デバッグ | レコードの閲覧 | レコードを見る道具を本番に置かない。本番への操作は申請と記録つき。監査ログ | 7、8 |
| T9 | 制御面の乗っ取り | 管理 API、コンソール | ACL・キーの書き換えで全テナントに及ぶ | 管理の操作の再認証と MFA、制御面から物理クラスタへは「望ましい状態」だけを渡し、ブローカーの設定を任意に変えられないようにする | 4、[control-plane-and-provisioning.md](control-plane-and-provisioning.md) |
| T10 | サプライチェーン | 本家のブローカー、パッチ、コンテナのイメージ、Strimzi | 全物理クラスタ | イメージの署名と SBOM、依存の脆弱性の走査（delivery の領域） | — |
| T11 | メトリクス・ログからの漏洩 | メトリクスの API、運用のログ | 他のテナントの名前・量の露出、レコードの露出 | メトリクスの API は論理クラスタの ID の条件をサーバーで必ず付ける。レコードの中身をログに出さない（ルールの AGENTS.md） | [metrics-and-billing.md](metrics-and-billing.md) |
| T12 | テナントのコード（コネクター）の悪用 | マネージドのコネクター（Later） | 基盤への侵入、SSRF | 別の EKS クラスタ、Pod ごとの VM、外向きの通信の許可リスト | [connectors-and-schema.md](connectors-and-schema.md) |

- T1 は最も重い。テナントの分離は、名前空間のパッチ（multi-tenancy-and-quotas の領域）と、この文書の Authorizer の包み（5 節）の 2 つで守る。どちらか 1 つが壊れても、他のテナントの資源に届かないようにする。
- 本家の既知の脆弱性（CVE）への対応は、本家の版の追従（ADR-0005）と delivery の領域で扱う。

## 3. サービスアカウントと API キー

### 3.1 本家の仕組み（確かめたこと）

- Confluent Cloud は、Kafka のクラスタに絞った API キー（resource-scoped）と、管理の API 向けの API キーを分ける。秘密は作成時に 1 回だけ表示し、後から取り出せない。キーの ID を SASL の利用者名に使う（[API keys](https://docs.confluent.io/cloud/current/security/authenticate/workload-identities/service-accounts/api-keys/overview.html)）。
- 上限（[Service quotas](https://docs.confluent.io/cloud/current/quotas/service-quotas.html)）：サービスアカウントあたり 100 個、利用者あたり 10 個、組織あたりサービスアカウント 1,000 個。クラスタあたりのキーは Basic 50、Standard 250、Enterprise 2,500、Dedicated 20,000。
- OAuth（SASL/OAUTHBEARER）は Standard 以上で使える。利用者の IdP の JWT を、JWKS で確かめ、クレームで「アイデンティティプール」に対応付ける。クライアントは `extension_logicalCluster` と `extension_identityPoolId` を送る（[OAuth overview](https://docs.confluent.io/cloud/current/security/authenticate/workload-identities/identity-providers/oauth/overview.html)）。
- 本家の Apache Kafka は、SASL/PLAIN を TLS の上だけで使うよう求め、本番では `sasl.server.callback.handler.class` で外部の資格情報を確かめるよう勧める。OAUTHBEARER の既定の実装（署名のない JWT）は本番に使えない（[Authentication using SASL](https://kafka.apache.org/43/security/authentication-using-sasl/)）。

### 3.2 主体

| 主体 | ID | 用途 | 属するもの |
| --- | --- | --- | --- |
| 利用者 | `u-<ランダム>` | コンソール・CLI での操作 | 組織（複数に属せる） |
| サービスアカウント | `sa-<ランダム>` | アプリ、CI、Terraform | 1 つの組織 |
| 内部の主体 | `internal-<用途>-<pc-id>` | データ面のエージェント、ブローカーの間 | 物理クラスタ。テナントには見えない |

- Kafka の主体は `User:<sa-id>` か `User:<u-id>` にする。ID は組織をまたいで一意なので、名前空間を付けない。
- 本番のアプリには、サービスアカウントを使うよう、コンソールと文書で勧める。利用者のキーは、その人が組織を抜けたら失効する（3.5 節）。

### 3.3 API キーの形

| 部分 | 形 | 例 | 役割 |
| --- | --- | --- | --- |
| キーの ID | `<brand>_key_` ＋ Crockford の base32 で 20 文字（100 ビット） | `<brand>_key_7M3Q...` | SASL/PLAIN の利用者名。管理 API の Basic 認証の利用者名。ログに出してよい |
| 秘密 | `<brand>_sec_` ＋ base62 で 43 文字（256 ビット）＋ CRC32 の base62 で 6 文字 | `<brand>_sec_...` | SASL/PLAIN のパスワード。作成時に 1 回だけ表示 |

- 接頭辞の `<brand>_` は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従う。実際の名前は開発リポジトリの作成時に決め、他の既知のサービスの接頭辞と重ならないことを確かめる。
- 秘密の末尾のチェックサムで、シークレットスキャンが偽物を落とせる。GitHub のシークレットスキャンのパートナープログラムに、秘密の形と通知先を登録する（E8）。
- キーの種類は 2 つ。形は同じで、制御面の行の `scope` で分ける。

| 種類 | `scope` | 使える所 |
| --- | --- | --- |
| クラスタのキー | `logical_cluster:<lc-id>` | 1 つの論理クラスタへの Kafka の接続だけ |
| 管理のキー | `management` | 管理 API（[console-and-api.md](console-and-api.md)）とメトリクスの API だけ。Kafka の接続には使えない |
| スキーマレジストリのキー（S2） | `schema_registry:<sr-id>` | 1 つのスキーマレジストリだけ |

- キーは 1 つの範囲に絞る。1 つのキーで複数の論理クラスタに入れる形（Confluent のグローバルな API キー）は持たない。漏れたときの範囲を小さくするため。

### 3.4 保存と検証

```
制御面（Aurora）                     物理クラスタ
api_keys                            ┌──────────────────────────────────────────────┐
  key_id, owner, scope,             │ データ面のエージェント                          │
  secret_sha256, status, ...  ──▶   │   └─ 内部のトピック __<brand>_credentials へ書く │
     outbox → SQS                   │      （圧縮。鍵 = key_id）                      │
                                    │ ブローカー                                      │
                                    │   ├─ 資格情報のキャッシュ（内部のトピックを読む）│
                                    │   └─ SASL/PLAIN のコールバック                  │
                                    │        SHA-256(秘密) を定数時間で比べる         │
                                    └──────────────────────────────────────────────┘
```

- 制御面は秘密の SHA-256 だけを持つ。秘密は 256 ビットの乱数なので、遅いハッシュ（bcrypt など）は要らない。接続のたびの検証を軽くするためでもある（Stripe の [auth-and-keys.md](../../../stripe/docs/architecture/auth-and-keys.md) の 5.2 節と同じ考え方）。
- ブローカーは制御面を同期で呼ばない。制御面が落ちても、既存のキーで接続できる（ADR-0003 の「データの経路は制御面に依存しない」）。
- 資格情報は、物理クラスタごとの内部のトピック `__<brand>_credentials` で配る。載せるのは、その物理クラスタにある論理クラスタのキーだけ。

| 内部のトピックの値 | 中身 |
| --- | --- |
| `key_id` | 鍵 |
| `logical_cluster_id` | キーの範囲。認証した主体に付け、名前空間のパッチが使う |
| `principal` | `User:sa-...` |
| `secret_sha256` | 秘密のハッシュ |
| `cluster_role` | 論理クラスタの管理の権限（`admin` か `none`）。5.3 節 |
| `not_after` | 期限（任意） |
| `generation` | 制御面の世代。古い値で上書きしない |

- 失効は、同じ鍵の墓標（値が空の記録）で配る。
- ブローカーのキャッシュは、内部のトピックを最初から読み終えるまで、テナントの接続を受けない（起動時に全部のキーを知らない状態で認証しない）。
- 内部のトピックは、内部の主体だけが読み書きできる。テナントの名前空間の外にあり、テナントの Metadata の応答に出ない。
- 資格情報を SCRAM の仕組み（KRaft の中の `AlterUserScramCredentials`）に入れない理由は、ADR-0028 にある。

### 3.5 ライフサイクル

| 操作 | 振る舞い | 反映の目標 |
| --- | --- | --- |
| 作成 | 秘密を 1 回だけ表示する。新しい接続で使えるまで待つ時間を、作成の応答の `status` で見せる（`provisioning` → `active`） | 60 秒以内（p99） |
| 失効（削除） | 新しい接続を拒否する。既存の接続は、再認証の期限（下）で切れる | 新しい接続：60 秒以内。既存の接続：15 分以内 |
| ローテーション | 新しいキーを作り、古いキーを利用者が消す。本家と同じく、自動の猶予は付けない | — |
| 利用者の脱退 | その利用者が持つキーをすべて失効する | 同上 |
| サービスアカウントの削除 | 持っているキーがあれば拒否する（先にキーを消す） | — |
| 漏洩の通報（シークレットスキャン） | 即時に失効し、組織の管理者に知らせる | 同上 |

- 既存の接続の失効は、本家の再認証（KIP-368）で行う。ブローカーの `connections.max.reauth.ms` を 900,000（15 分）にする。本家の既定は 0（無効）で、設定するとブローカーは期限を過ぎて再認証しない接続を切る（[KIP-368](https://cwiki.apache.org/confluence/display/KAFKA/KIP-368%3A+Allow+SASL+Connections+to+Periodically+Re-Authenticate)）。再認証の時点で、失効したキーは失敗する。
- 漏洩のように急ぐ場合に、失効したキーの既存の接続をすぐ切る仕組みは、本家の差し込み口にない。名前空間のパッチの出入口に、失効したキーの接続を閉じる小さな処理を足せるかを、E8 の PoC で確かめる（15 節の持ち越し）。
- 最終の使用の時刻は、ブローカーが認証の成功を 1 分ごと・キーごとに数え、使用量の経路（[metrics-and-billing.md](metrics-and-billing.md) の 5 節）で制御面に送る。

### 3.6 総当たりと接続の制限

| 層 | 制限 | 値（初期値） |
| --- | --- | --- |
| SNI のプロキシ（Envoy） | Envoy ごとの新しい接続の頻度の上限（リスナー全体。送信元 IP ごとではない） | 負荷試験 T6 で決める（[capacity.md](capacity.md) の 11 節） |
| SNI のプロキシ（Envoy） | 送信元 IP ごとの新しい接続の頻度 | **S2**。Envoy の組み込みのフィルターは送信元ごとに数えられないので、外部のレート制限のサービスを入れて掛ける（[infrastructure.md](infrastructure.md) の 5.4 節） |
| ブローカー | 認証の失敗の応答の遅延（本家の `connection.failed.authentication.delay.ms`） | 1,000 ms（本家の既定は 100 ms。`connections.max.idle.ms` より小さくする必要がある。[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認） |
| ブローカー | 論理クラスタごとの接続の数と頻度 | CU から決める（[metrics-and-billing.md](metrics-and-billing.md) の 3 節）。適用は multi-tenancy-and-quotas の領域 |
| 制御面 | 送信元 IP ごとの認証の失敗の数 | 1 分に 100 回を超えたら、その IP を 10 分止める（Envoy の RBAC の拒否の一覧として配る） |

- **ブローカーは送信元 IP を知らない。** Envoy は TLS を終端せずに TCP を中継するので、ブローカーから見た送信元は Envoy の IP になる（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)）。送信元 IP は、Envoy のアクセスログ（Proxy Protocol v2 の下流の送信元、SNI、上流への接続の送信元ポート）と、ブローカーの接続（送信元ポート）を突き合わせて得る。認証の失敗の IP ごとの集計と、上の IP の停止は、この突き合わせの結果で行う（E8。[observability.md](observability.md) の 2.2 節）。
- 認証の失敗は、キーの ID と送信元の IP ごとに 1 分でまとめて監査ログに出す（8 節）。失敗のたびに 1 行を出さない。

### 3.7 SASL の機構

| 機構 | 段階 | 扱い |
| --- | --- | --- |
| PLAIN（TLS の上） | S1 | 唯一の機構。利用者名＝キーの ID、パスワード＝秘密 |
| OAUTHBEARER（OIDC） | S2（Standard 以上） | 4 節 |
| SCRAM-SHA-256/512 | 持たない | 機構を有効にしない。`AlterUserScramCredentials` は拒否（protocol-and-compatibility の 4 節） |
| mTLS（クライアント証明書） | 持たない（S2 で再検討） | 利用者に証明書の運用を求める。Dedicated の要望があれば ADR で扱う |
| 委任トークン | 持たない | `DELEGATION_TOKEN_AUTH_DISABLED`（protocol-and-compatibility の 4 節） |

## 4. OAUTHBEARER（S2）

- 組織ごとに、信頼する IdP（発行者 `iss`、JWKS の URL、期待する `aud`）を登録する。
- アイデンティティプールは、クレームの条件（例：`sub == "..."`、`groups` に含む）と、ACL の主体 `User:pool-<id>` の組。ACL は 5 節の規則のまま、主体だけが変わる。
- クライアントは SASL の拡張に `logicalCluster=<lc-id>` と `identityPool=<pool-id>` を付ける。拡張の名前は本家（`extension_logicalCluster`）に寄せる。
- ブローカーは JWKS を 1 時間ごとに取り直し、未知の `kid` では 1 回だけすぐに取り直す。JWKS を取れないときは、手元の鍵で確かめ続ける（最長 24 時間）。
- トークンの期限で再認証する（本家の OAUTHBEARER の振る舞い）。
- 本家の差し込み口（`listener.name.<listener>.oauthbearer.sasl.server.callback.handler.class`）で作る。

## 5. ACL

### 5.1 本家の仕組み（確かめたこと）

[Authorization and ACLs](https://kafka.apache.org/43/security/authorization-and-acls/) による。

- KRaft では `authorizer.class.name=org.apache.kafka.metadata.authorizer.StandardAuthorizer` を使い、ACL は KRaft のメタデータに入る。
- 資源のパターンは LITERAL（名前か `*`）と PREFIXED（接頭辞）。
- ACL のない資源は、既定で super.users だけが使える（`allow.everyone.if.no.acl.found` の既定は false）。
- 資源の種類：Topic、Group、Cluster、TransactionalId、DelegationToken、User。操作：Read、Write、Create、Delete、Alter、Describe、ClusterAction、DescribeConfigs、AlterConfigs、IdempotentWrite、CreateTokens、DescribeTokens、All。
- Confluent Cloud は、組織・クラスタの管理を RBAC で、Kafka の資源の細かい権限を ACL で行う（[Predefined RBAC roles](https://docs.confluent.io/cloud/current/security/access-control/rbac/predefined-rbac-roles.html)）。

### 5.2 構成

```
要求 ─▶ 名前空間のパッチ（資源に <lc> の接頭辞を付ける）
      ─▶ TenantAuthorizer（本家の StandardAuthorizer を包む）
           1. 内部の主体か → StandardAuthorizer へ
           2. API の表（ADR-0006）で拒否の API か → 拒否
           3. 主体の論理クラスタ ≠ 資源の論理クラスタ → 拒否（T1 の二重の守り）
           4. 資源が CLUSTER → 5.3 節の表で決める
           5. それ以外 → StandardAuthorizer（テナントの ACL）
```

- StandardAuthorizer を置き換えず、包む（ADR-0001 の方針）。ACL の保存と評価は本家のまま。
- 3 の確かめは、名前空間のパッチが正しければ常に通る。パッチの漏れを捕まえるためのもので、拒否したら `tenant_boundary_violation` のアラートを上げる（件数の目標は 0）。

### 5.3 CLUSTER の資源

テナントには CLUSTER の ACL を作らせない（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 4 節の CreateAcls の行）。代わりに、TenantAuthorizer が制御面のロール（資格情報の `cluster_role`）で決める。

| 操作（CLUSTER） | `cluster_role = admin` | `none` | 使う API の例 |
| --- | --- | --- | --- |
| Describe | 許す | 許す | DescribeAcls の一部、DescribeCluster |
| Create | 許す | 拒否 | CreateTopics（トピックの資源の Create でも作れる。本家と同じ） |
| Alter | 許す（ACL の作成・削除だけ） | 拒否 | CreateAcls、DeleteAcls |
| DescribeConfigs | 許す | 許す | ブローカーの設定の参照（見せる値は protocol-and-compatibility の 5 節で絞る） |
| AlterConfigs | 拒否 | 拒否 | ブローカーの設定の変更 |
| IdempotentWrite | 許す | 許す | 冪等なプロデューサー（本家の 2.8 以降は、トピックの Write だけで冪等に書ける。IdempotentWrite は 3.0 で非推奨だが残っている。[KIP-679](https://cwiki.apache.org/confluence/display/KAFKA/KIP-679%3A+Producer+will+enable+the+strongest+delivery+guarantee+by+default)、2026-09-27 に確認。どちらでも通るようにする） |
| ClusterAction | 拒否 | 拒否 | ブローカーの間の API |

### 5.4 テナントの ACL の変換

名前空間のパッチが資源の名前に接頭辞を付けるので、ACL の保存の形はテナントの見た目と違う。変換はパッチの ACL の行で行い、応答では元に戻す。

| テナントが作る ACL | 保存の形 | 理由 |
| --- | --- | --- |
| LITERAL `orders` | LITERAL `lc-<id>_orders` | そのまま接頭辞を付ける |
| PREFIXED `app-` | PREFIXED `lc-<id>_app-` | 同上 |
| LITERAL `*` | PREFIXED `lc-<id>_` | 本家の `*` はすべての名前に合う。そのままだと、他のテナントの資源にも合う ACL になる |
| 主体 `User:*` | そのまま | 資源が自分の論理クラスタに閉じるので、他のテナントの主体は資源の名前に届かない。加えて 5.2 節の 3 で止まる |
| 主体 `User:sa-...`（他の組織） | 拒否（`INVALID_REQUEST`） | 組織をまたぐ共有は機能として持たない。エラーコードが本家の検査と合うかは差分テストで確かめる |
| 資源の種類 CLUSTER・DELEGATION_TOKEN・USER | 拒否（`CLUSTER_AUTHORIZATION_FAILED`） | protocol-and-compatibility の 4 節 |

- 接頭辞の形（`lc-<id>_`）は [tiered-and-object-storage.md](tiered-and-object-storage.md) と同じ形にした。正本は multi-tenancy-and-quotas の領域で決める。
- DescribeAcls の応答で、保存の形から元の形に戻せない ACL（手で入れたもの）は返さない。

### 5.5 上限

| 項目 | Basic | Standard | 備考 |
| --- | --- | --- | --- |
| ACL の数（論理クラスタごと） | 1,000 | 10,000 | 本システムの値。Confluent の Cluster types は Basic・Standard とも 1,000 とする（[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 2.3 節）。Standard は、ACL を 1 つずつ付ける運用（ロールで一括に与えない。5.6 節）のため多めにした |
| API キー（論理クラスタごと） | 50 | 250 | Confluent と同じ（[Service quotas](https://docs.confluent.io/cloud/current/quotas/service-quotas.html)） |
| API キー（サービスアカウントごと） | 100 | 100 | 同上 |
| サービスアカウント（組織ごと） | 1,000 | 1,000 | 同上 |

- ACL の上限は、StandardAuthorizer の評価の性能（物理クラスタ全体の ACL の数）で決まる。物理クラスタあたりの ACL の合計の目安を、E8 の `tenant-authorizer` の負荷試験で測る（未検証）。

### 5.6 制御面のロール（RBAC）

管理 API とコンソールの権限。Kafka のデータの権限（Read・Write）は、ロールでは与えず、ACL だけで与える。

| ロール | 範囲 | 主な権限 |
| --- | --- | --- |
| OrganizationAdmin | 組織 | すべて |
| BillingAdmin | 組織 | 請求、支払いの方法、予算 |
| AccountAdmin | 組織 | 利用者の招待、サービスアカウント、ロールの付与（OrganizationAdmin の付与を除く） |
| ClusterAdmin | 論理クラスタ | 論理クラスタの設定、トピック、ACL、その論理クラスタのキーの作成・削除 |
| Operator | 論理クラスタ | トピック・グループ・ACL の参照、メトリクス |
| MetricsViewer | 組織 | メトリクスの API だけ |

- 名前は Confluent の定義済みのロールに寄せる（同上の RBAC の文書）。データの読み書きを含むロール（DeveloperRead など）は持たない。ACL と役割が重なり、判定が 2 か所になるため。
- ClusterAdmin のロールを持つ主体のクラスタのキーは、`cluster_role = admin` で配る（5.3 節）。ロールを外すと、資格情報の記録を更新する（60 秒以内）。
- ロールの判定は、管理 API の 1 つの `authorize()` に集める（Stripe の ADR-0008 と同じ考え方）。

## 6. 暗号化

### 6.1 通信

| 区間 | 方式 |
| --- | --- |
| クライアント → SNI のプロキシ → ブローカー | TLS 1.2 以上（1.3 を優先）。プロキシは TLS を終端しない。ブローカーが証明書を示す。暗号スイートは ECDHE と AEAD だけ |
| ブローカーの間、ブローカー → コントローラー | mTLS。証明書は物理クラスタごとの内部の CA（Strimzi のクラスタの CA。[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 6 節） |
| データ面のエージェント → ブローカー | 内部のリスナー、mTLS。外に出さない |
| 管理 API、コンソール | TLS 1.2 以上（ALB・CloudFront） |
| ブローカー → S3、KMS | TLS（AWS の SDK）。VPC のエンドポイントを通す |

- 平文のリスナーは作らない。テナント向けのリスナーは、SASL_SSL だけにする。
- テナント向けの証明書は、ACM の書き出せる公開の証明書 1 枚に、`*.<region>.<brand>.<domain>` と AZ ごとの `*.<az-id>.<region>.<brand>.<domain>` を載せる（[ADR-0044](../decisions/0044-nlb-sni-proxy-and-zonal-hostnames.md)、[infrastructure.md](infrastructure.md) の 5.5 節）。期限の 30 日前と 7 日前にアラートを出す。

### 6.2 保存時

| 置き場 | 方式 | キー |
| --- | --- | --- |
| EBS（ブローカーのログ） | EBS の暗号化 | 物理クラスタごとの顧客管理のキー（CMK） |
| S3（階層型の保存） | SSE-KMS と S3 Bucket Keys | 同上（物理クラスタごと） |
| Aurora（制御面） | ストレージの暗号化 | 制御面の CMK |
| S3（監査ログ、使用量の生データ） | SSE-KMS と Bucket Keys | 用途ごとの CMK |

- EBS の既定のキー（`aws/ebs`）を使わず、物理クラスタごとの CMK にする。キーのポリシーを、その物理クラスタのノードの役割だけに絞れる。物理クラスタを廃止するとき、キーの削除の予約で、残ったスナップショット・ボリュームを読めなくできる。EBS の既定の暗号化はリージョンの設定で、既存のボリュームのキーは後から変えられない（[Encryption by default](https://docs.aws.amazon.com/ebs/latest/userguide/encryption-by-default.html)）。
- S3 Bucket Keys は、KMS への要求を最大 99% 減らす。暗号化の文脈がオブジェクトではなくバケットの ARN になる（[S3 Bucket Keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html)）。
- KMS の対称の暗号の操作の上限は、東京で 20,000 回/秒（アカウントとリージョンで共有）（[KMS request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)）。Bucket Keys なしでは、S3 の SSE-KMS のオブジェクトの読み書きのたびに KMS を呼ぶ。Bucket Keys を必ず有効にすれば上限から遠いので、S1 ではデータ面の AWS アカウントを分けない（[infrastructure.md](infrastructure.md) の 1 節、[ADR-0043](../decisions/0043-aws-accounts-network-and-eks-layout.md)）。
- テナントごとのキーは S1 では持たない。共有の物理クラスタでは、EBS のボリュームを複数のテナントが使うため。

### 6.3 BYOK（S2）

- Confluent Cloud は、BYOK を Dedicated・Enterprise・Freight で提供し、キーはクラスタの作成時に選び、後から変えられない（[BYOK overview](https://docs.confluent.io/cloud/current/security/encrypt/byok/overview.html)）。
- 本システムは、S2 の Dedicated（1 テナントだけの物理クラスタ）で、利用者の AWS アカウントの KMS のキーを、EBS と S3 の両方に使う。キーは作成時に決め、変えられない。
- 利用者がキーの権限を取り消すと、ブローカーは新しいボリュームを付けられず、S3 から読めなくなる。検知したら利用者に知らせ、クラスタを「キーを失った」状態として表示する。SLA の対象外にする（利用規約。法務の確認待ち）。
- 共有の物理クラスタでの、テナントごとの S3 のキー（階層型の保存のセグメントだけ）は S3 の段階で再検討する。

## 7. 運用者のアクセス

- 本番のブローカーに、レコードを読む道具（コンソールのコンシューマーなど）を置かない。内部の主体にも、テナントのトピックの Read を与えない（エージェントの主体は、管理の操作だけ）。
- 本番の EKS・AWS への人の操作は、申請・承認・期限つきの権限で行い、すべて記録する（infrastructure の領域）。
- サポートでテナントのメタデータ（トピックの名前、設定）を見るときは、組織の許可を求め、監査ログの「運用者のアクセス」に残す。S2 でテナントに見せる（本家の Access Transparency に相当。Confluent の監査ログの対象にある。[Audit log concepts](https://docs.confluent.io/cloud/current/monitoring/audit-logging/cloud-audit-log-concepts.html)）。

## 8. 監査ログ

### 8.1 本家の仕組み（確かめたこと）

- Confluent Cloud は、組織ごとの独立した監査ログのクラスタの `confluent-audit-log-events` のトピックに、認証・認可・組織の操作を CloudEvents 1.0 の JSON で出す。保持は 7 日。対象は Standard・Enterprise・Dedicated・Freight（Basic は対象外）（[Audit log concepts](https://docs.confluent.io/cloud/current/monitoring/audit-logging/cloud-audit-log-concepts.html)）。

### 8.2 対象

| 分類 | 事象 | 層 |
| --- | --- | --- |
| 組織 | ログイン、MFA、招待、ロールの付与・削除、サービスアカウント・API キーの作成・削除、IdP とアイデンティティプールの変更 | 全層 |
| 制御面の操作 | 管理 API の変更の要求すべて（論理クラスタ、トピック、ACL、設定）。要求の元（コンソール・CLI・Terraform・API） | 全層 |
| データ面の管理の操作 | Kafka のプロトコルでの CreateTopics、DeleteTopics、CreatePartitions、IncrementalAlterConfigs、CreateAcls、DeleteAcls、DeleteRecords、DeleteGroups、OffsetDelete | 全層 |
| 認証 | 認証の失敗（キー・IP・分ごとにまとめる）、失効したキーの使用 | Standard |
| 認可 | 拒否（主体・操作・資源・分ごとにまとめる）。許可は記録しない | Standard |
| 運用者のアクセス | 7 節 | 全層（テナントへの公開は S2） |

- produce・fetch の許可は記録しない。量が多く、利用者の役に立ちにくい（Confluent も管理の操作と認証・認可を対象にしている）。
- 変更の前後の値を持つ。API キーの秘密、SASL のパスワード、レコードの中身は持たない。
- 送信元 IP は、ブローカーが知らないので、Envoy のアクセスログとの突き合わせ（3.6 節）で足す。突き合わせられない事象は IP を空にし、Envoy の ID を入れる。

### 8.3 形と経路

```
ブローカー：TenantAuthorizer・資格情報のコールバック・名前空間のパッチ
   └─▶ 内部のトピック __<brand>_audit（物理クラスタごと。保持 3 日）
          └─▶ データ面のエージェント ─▶ Firehose ─▶ S3（監査ログの保管庫）
制御面：管理 API ─────────────────────────────────▶ 同上
                                                      └─▶ 索引（Aurora の audit_events、90 日）
```

- 形は CloudEvents 1.0 の JSON。`type` は `<brand>.audit.v1.<分類>.<事象>`、`source` は `crn://<brand>/org=<org>/lc=<lc>` の形（例。名前は開発リポジトリで決める）。
- 監査ログの保管庫の S3 は、Object Lock（コンプライアンスのモード、1 年）で消せなくする。
- テナントは、管理 API の `GET /v1/audit-events`（直近 90 日。絞り込みとページング）と、コンソールで見る。S2 で、組織ごとの監査ログの論理クラスタのトピックに流す形（Confluent と同じ形）を足す。
- 抜けを検知する：ブローカーの監査ログの記録の数と、エージェントが送った数を、分ごとに比べる。

### 8.4 保持

| 置き場 | 期間 |
| --- | --- |
| 索引（テナントが検索できる） | 90 日 |
| S3 の保管庫 | 1 年（Object Lock）。その後は削除 |
| 耐久性の監査の記録（[replication-and-durability.md](replication-and-durability.md) の 7 節） | 同じ方針（書き込みだけの権限、Object Lock 1 年） |

- 長く持つほど、テナントの個人データ（利用者のメールアドレス、IP）を長く持つ。1 年を超える保持は、法務の確認（intent.md の L4）の後に決める。

## 9. データの削除

| 操作 | 振る舞い | 完了の目標 |
| --- | --- | --- |
| トピックの削除 | 本家のとおり、KRaft から消え、ローカルのセグメントを消す。S3 のセグメントは RemoteLogManager が非同期に消す | ローカル：数分。S3：24 時間以内（未検証。E8 の `data-deletion-verification` で測る） |
| 論理クラスタの削除 | すべてのトピック・グループ・ACL・キーを消す。名前空間の登録を消す。7 日の猶予の後、S3 の残りを前方一致 `lc-<id>_` で消す（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.3 節） | 8 日以内 |
| 組織の解約 | 論理クラスタを削除し、制御面の行を 30 日後に消す（請求の記録は法定の期間だけ残す） | 30 日 |

- S3 のバケットのバージョニングを使うなら、古い版はライフサイクルで 30 日以内に消す。
- 大阪への写し（[tiered-and-object-storage.md](tiered-and-object-storage.md) の 6.6 節）は削除を写さない。論理クラスタの削除では大阪の前方一致も消すが、**トピックだけを削除したときは、大阪の写しがライフサイクル（そのテナントの最大の保持＋7 日）まで残る**。
- **削除の約束（SLA）は、論理クラスタの削除と組織の解約だけを対象にする。**「論理クラスタ・組織の削除から 30 日以内に、当社のすべての置き場（大阪の写しを含む）から消える」とする。トピックの削除は約束の対象にしない。大阪への写しを有効にした論理クラスタでは、消したトピックの写しがライフサイクル（そのテナントの最大の保持＋7 日）まで残ることを利用者の文書に書く。トピックの削除を大阪へ伝えるか（削除の記録から大阪の前方一致を消すジョブ）は、15 節の持ち越し（個人データの削除の約束は法務の確認待ち、L4）。
- 削除の完了を確かめる日次のジョブ：削除した論理クラスタの接頭辞の S3 のオブジェクトの数が、猶予の 7 日の翌日に 0 であること。
- 7 日の猶予の間は、誤った削除からの戻しを受け付けない（S1）。猶予は、進行中の上げ・読み戻しの完了を待つためのもの。
- EBS のスナップショットは、ブローカーのバックアップには使わない（耐久性は複製と S3 で得る。ADR-0002）。使う場合も、7 日で消す。

## 10. 障害と振る舞い

| 事象 | 起きること | 検知 | 対応 |
| --- | --- | --- | --- |
| 制御面の停止 | 新しいキー・失効が反映されない。既存のキーの接続は続く | 反映の遅れのメトリクス | 制御面の復旧。漏洩の急ぎの失効は、runbook の手順で内部のトピックへ直接書く |
| 資格情報のトピックの遅れ | 新しいキーで接続できない（`SASL_AUTHENTICATION_FAILED`） | 作成から `active` までの時間の p99 | エージェントとブローカーのキャッシュの遅れを調べる |
| ブローカーの資格情報のキャッシュの破損 | そのブローカーでの認証の失敗の急増 | ブローカーごとの失敗の率 | ブローカーを再起動し、トピックを最初から読み直す |
| TenantAuthorizer の境界の拒否（5.2 節の 3） | 要求の拒否 | `tenant_boundary_violation` のアラート（目標 0） | 名前空間のパッチの不具合として、E7 の担当と調べる。重大度は最高 |
| 証明書の期限切れ | 全テナントの接続の失敗 | 期限の 30 日前・7 日前のアラート、外からの合成監視 | runbook の手順で更新する |
| KMS の拒否・上限 | S3 の読み書きの失敗、EBS の付け替えの失敗 | KMS のスロットリングのメトリクス | 上限の引き上げ、Bucket Keys の確認 |
| 監査ログの抜け | 記録の欠け | 8.3 節の数の比較 | エージェントの再送。欠けた範囲を記録する |

## 11. テスト

- 表駆動テスト：5.3 節の CLUSTER の操作の表、5.4 節の ACL の変換の表、3.5 節のライフサイクルの表。
- 性質ベーステスト：
  - 任意の 2 つのテナントと、任意の ACL の列（`*`、PREFIXED、`User:*` を含む）で、一方の主体が他方の資源に許可されることがない。
  - 任意の ACL について、作成 → DescribeAcls の結果が、作成した形と同じ（変換の往復）。
  - 任意のキーの操作の列（作成・失効・ロールの変更）を任意の順で配っても、ブローカーのキャッシュの最終の状態が、制御面の最終の状態と同じ（世代で古い値を捨てる）。
- 結合テスト：失効の後、新しい接続が 60 秒以内に失敗し、既存の接続が再認証の期限で切れる。平文の接続が拒否される。TLS 1.1 の接続が拒否される。
- 差分テスト：ACL の API のエラーコードが本家と同じ（protocol-and-compatibility の 7 節）。
- 秘密の扱い：API キーの秘密が、ログ・トレース・メトリクスのラベル・監査ログ・エラーの本文に出ないことを、テストの中でログを走査して確かめる。
- 侵入テスト：GA の前に、外部の業者に、テナントの分離（T1）と認証（T2〜T4）を対象に依頼する。

## 12. ADR

| ADR | 決定 |
| --- | --- |
| [0028](../decisions/0028-service-accounts-api-keys-and-sasl-plain.md) | 資格情報は、1 つの論理クラスタに絞った API キーにし、SASL/PLAIN を TLS の上で使う。検証用のハッシュは内部のトピックで物理クラスタへ配る。OAUTHBEARER は S2 |
| [0029](../decisions/0029-tenant-scoped-acls-and-rbac.md) | ACL は本家の StandardAuthorizer を包んで使い、論理クラスタの境界を二重に確かめる。CLUSTER の権限は制御面のロールで決める。データの権限は ACL だけで与える |
| [0030](../decisions/0030-encryption-and-audit-logs.md) | 通信は TLS 1.2 以上と内部の mTLS。保存は物理クラスタごとの KMS のキーで EBS と S3 を暗号化する。BYOK は S2 の Dedicated。監査ログは CloudEvents の形で S3 と索引に置く |

## 13. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `sasl-plain-callback-poc` | SASL/PLAIN のコールバックと資格情報のキャッシュの PoC。接続あたりの検証の時間を測る |
| E8 | `service-accounts` | サービスアカウントの作成・一覧・削除（管理 API、コンソール） |
| E8 | `api-keys` | 3.3〜3.5 節。キーの形、1 回だけの表示、失効、利用者の脱退での失効 |
| E8 | `credential-distribution` | 内部のトピックへの配布、ブローカーのキャッシュ、起動時の読み終わりの待ち |
| E8 | `reauth-and-revocation` | `connections.max.reauth.ms`、急ぎの失効の PoC |
| E8 | `tenant-authorizer` | 5.2〜5.4 節。境界の確かめ、CLUSTER の表、ACL の変換 |
| E8 | `rbac-roles` | 5.6 節のロールと管理 API の `authorize()` |
| E8 | `auth-failure-throttling` | 3.6 節の失敗の遅延と IP の停止 |
| E8 | `audit-log-pipeline` | 8 節の経路、索引、`GET /v1/audit-events` |
| E8 | `secret-scanning-partner` | GitHub のシークレットスキャンへの登録と、通報の受け口 |
| E8 | `data-deletion-verification` | 9 節の削除と、完了を確かめるジョブ |
| E12 | `kms-and-encryption-baseline` | 物理クラスタごとの CMK、EBS・S3 の暗号化、Bucket Keys |
| E12 | `tls-certificate-rotation` | テナント向けの証明書の更新と期限のアラート（infrastructure の領域と一緒に） |
| S2 | `oauthbearer`、`byok-dedicated`、`audit-log-topic` | 4 節、6.3 節、8.3 節の S2 の部分 |

## 14. 段階ごとの変化

| 項目 | S1 | S2 | S3 |
| --- | --- | --- | --- |
| SASL の機構 | PLAIN | ＋OAUTHBEARER | 同じ |
| 監査ログ | 管理 API と索引 | ＋組織ごとのトピックへの配信、運用者のアクセスの公開 | 同じ |
| 保存時の暗号化 | 物理クラスタごとの CMK | ＋Dedicated の BYOK | 共有の物理クラスタでのテナントごとの S3 のキーを再検討 |
| プライベートの接続 | IP の許可リスト（論理クラスタごと。infrastructure の領域） | PrivateLink | 同じ |

## 15. 未解決の問い

- 失効したキーの既存の接続を、再認証の期限を待たずに切るか。切るなら、本家の差し込み口の外（名前空間のパッチ）に手を入れる。
- `connections.max.reauth.ms` を 15 分より短くするか。短いと、再認証に対応しない古いクライアントの接続が切れやすい。
- IP の許可リストを、論理クラスタごとに持つか、API キーごとに持つか。
- テナント向けの証明書を、全ブローカーで同じワイルドカードにするか、物理クラスタごとに分けるか。
- 監査ログの S3 の保管を 1 年より長くするか。

### 決定（2026-09-27、既定案）

- **急ぎの失効**：S1 は再認証（15 分）で切る。E8 の PoC で、名前空間のパッチの出入口に「失効したキーの接続を閉じる」処理を足す量を測り、20 行程度で済むなら入れる。超えるなら、ADR-0028 を改めて、急ぎの失効は該当する論理クラスタのブローカーの接続を全部切る運用の手順にする。
- **再認証の期限**：15 分。本家の対応するクライアントは 2.2 以上で、ADR-0005 の最小の版（2.1）の Java のクライアントは再認証に対応しない（KIP-368 は 2.2 で入った）。2.1 のクライアントは 15 分ごとに切れて、つなぎ直す。KIP-368 は、再認証に対応しない古いクライアントの接続も、セッションの期限で切ると定める（[KIP-368](https://cwiki.apache.org/confluence/display/KAFKA/KIP-368%3A+Allow+SASL+Connections+to+Periodically+Re-Authenticate)、2026-09-27 に確認）。E8 の `reauth-and-revocation` で、2.1 のクライアントが切断の後に自動でつなぎ直すことを確かめる。これは利用者向けの文書に書く。
- **IP の許可リスト**：論理クラスタごとに持つ（SNI のプロキシで掛けるため）。API キーごとの条件は持たない。
- **証明書**：S1 はリージョンで 1 枚（ACM の書き出せる証明書、リージョンと AZ ごとのワイルドカード）。秘密鍵はブローカーの Secret と書き出しの処理の外に出さない。ACM の上限（最長 198 日）で更新し、2027-03 からの 100 日の上限に合わせて自動化する（[infrastructure.md](infrastructure.md) の 5.5 節）。物理クラスタごとには分けない。
- **監査ログの保持**：索引 90 日、S3 1 年。延長は法務の確認（L4）の後。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 本家の `connection.failed.authentication.delay.ms` の既定値と上限 | E8 で本家の文書とコードで確かめる |
| 3.0 以降の冪等なプロデューサーに CLUSTER の IdempotentWrite が要るか | E2 の差分テストで確かめる |
| 他の組織の主体を含む CreateAcls に返すエラーコード | E2 の差分テスト |
| 物理クラスタあたりの ACL の数と、StandardAuthorizer の評価の性能 | E8 の負荷試験 |
| トピックの削除を大阪の写しに伝えるか | tiered-and-object-storage の領域と E4 で決める。個人データの削除の約束（L4）の答えによる |
| テナントのレコード（個人データを含みうる）の取り扱いの約束 | 法務の確認待ち（intent.md の L4） |

## 16. quality.md・runbooks・data-model への項目

### quality.md

- テナントの分離の性質ベーステスト（11 節）を、分離のリスクの最上位の検証として置く。名前空間のパッチの変更と TenantAuthorizer の変更は、変更単位の `quality.md` を必須にする。
- `tenant_boundary_violation` の本番の件数（目標 0）を、本番での品質検証の指標にする。
- API キーの作成から `active` までの時間の p99（目標 60 秒）、失効の反映の時間。
- 秘密の漏れの走査（ログ・トレース・スナップショット）を CI に置く。

### runbooks

- `runbooks/api-key-leak.md`：漏洩の通報の受け取り、即時の失効、既存の接続の切断、組織への連絡。
- `runbooks/emergency-credential-revoke.md`：制御面が止まっているときに、内部のトピックへ失効を直接書く手順と、その記録。
- `runbooks/tenant-boundary-violation.md`：境界の拒否のアラートの調べ方。影響の範囲の特定、名前空間のパッチの切り戻し。
- `runbooks/tls-certificate-renewal.md`：証明書の手動の更新と、ブローカーへの反映。
- `runbooks/kms-key-access-lost.md`：KMS のキーを使えなくなったとき（BYOK の取り消しを含む）。

### data-model（索引への追加の提案）

| テーブル・記録 | 中身 |
| --- | --- |
| `service_accounts`（制御面） | `id`（`sa-`）、`organization_id`、名前、説明、作成者、作成・削除の時刻 |
| `api_keys`（制御面） | `key_id`、`owner_type`（`user`・`service_account`）、`owner_id`、`scope`、`secret_sha256`、`status`（`provisioning`・`active`・`revoked`）、`generation`、作成者、作成の時刻、失効の時刻と理由、最終の使用の時刻 |
| `role_bindings`（制御面） | `principal`、`role`、`scope`（組織か論理クラスタ）、作成者、作成の時刻 |
| `identity_providers`・`identity_pools`（制御面、S2） | 発行者、JWKS の URL、`aud`、クレームの条件、主体 |
| `ip_allowlists`（制御面） | `logical_cluster_id`、CIDR の一覧 |
| `audit_events`（制御面の索引、90 日） | CloudEvents の `id`・`type`・`source`・`time`、主体、対象、結果、変更の前後。月ごとのパーティション |
| `__<brand>_credentials`（データ面の内部のトピック） | 3.4 節の値 |
| `__<brand>_audit`（データ面の内部のトピック） | ブローカーの監査の事象。保持 3 日 |

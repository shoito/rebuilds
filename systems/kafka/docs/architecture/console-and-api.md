# Console and API: Kafka

Web のコンソール、管理 API（REST）、CLI、Terraform のプロバイダー、コンソールのログインの設計。この文書で決めたことは [ADR-0034](../decisions/0034-management-api-shape.md)（管理 API の形）、[ADR-0035](../decisions/0035-console-and-login.md)（コンソールとログイン）、[ADR-0036](../decisions/0036-cli-and-terraform-provider.md)（CLI と Terraform のプロバイダー）にある。

本家（Confluent Cloud）の振る舞いは、2026-09-27 に公式の文書と GitHub で確かめた。確かめられなかったものは「未検証」と書く。要件 ID は、E10 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

- 運用の担当とアプリの開発者が、クラスタの作成、トピック、API キー、ACL、監視、請求を、コンソール・CLI・Terraform・REST のどれからでも同じ意味で操作できる。
- SC-3：登録から最初の produce と consume まで 5 分以内（コンソールか CLI）。

範囲に入れないもの：

- Kafka のプロトコルでの管理（CreateTopics など）。[protocol-and-compatibility.md](protocol-and-compatibility.md)。
- 権限の判定の中身（ロール、ACL）。[security-and-acls.md](security-and-acls.md) の 5 節。
- 命令の反映の仕組み。[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 6 節。
- メトリクスと請求の API の中身。[metrics-and-billing.md](metrics-and-billing.md)。

## 2. 本家の形（確かめたこと）

- Confluent Cloud の API は、API のグループごとに URL の版を持つ（`/iam/v2/`、`/cmk/v2/`）。版はグループごとの「世代」で、壊す変更はそのグループの版だけを上げる（[Confluent Cloud APIs](https://docs.confluent.io/cloud/current/api.html)）。
- 一覧は `page_size`（最初の要求だけ）と、サーバーが作る不透明な `page_token` でページングし、応答の `metadata` に `next`・`prev`・`first`・`last` を持つ（同上）。
- レート制限を超えると 429 で、`X-RateLimit-Limit`・`X-RateLimit-Remaining`・`X-RateLimit-Reset`・`Retry-After` を返す（同上）。
- エラーは `status`、`error`（`code`・`message`・`details` など）、`requestId` を持つ JSON（同上）。
- 資源は `api_version`、`kind`、`id`（消した後に再利用しない）、`resource_name`（CRN）、`self`、`created_at`・`updated_at`・`deleted_at` を持つ（同上）。
- 冪等キー（`Idempotency-Key`）の仕組みは、文書にない（同上）。
- GA の API の壊す変更は、少なくとも 180 日前に知らせる（同上）。
- Terraform のプロバイダー（`confluentinc/terraform-provider-confluent`）は Go、Apache License 2.0。資源は `confluent_kafka_cluster`、`confluent_kafka_topic`、`confluent_service_account`、`confluent_api_key`、`confluent_kafka_acl`、`confluent_role_binding` など（GitHub の `docs/resources`）。
- CLI（`confluentinc/cli`）は Go（GitHub の言語の表示）。

## 3. 管理 API

### 3.1 URL と資源

```
https://api.<brand>.<domain>/v1/...
```

| 資源 | パス | 操作 | 反映 |
| --- | --- | --- | --- |
| 組織 | `/v1/organizations/{org}` | 取得・更新 | 制御面 |
| 利用者・招待 | `/v1/users`、`/v1/invitations` | 一覧・招待・削除 | 制御面 |
| サービスアカウント | `/v1/service-accounts` | CRUD | 制御面 |
| API キー | `/v1/api-keys` | 作成・一覧・取得・削除（秘密は作成の応答だけ） | 望ましい状態 |
| ロールの付与 | `/v1/role-bindings` | 作成・一覧・削除 | 制御面（クラスタのロールは望ましい状態） |
| 論理クラスタ | `/v1/clusters` | CRUD（更新は名前・`max_cu`・IP の許可リスト） | 望ましい状態 |
| トピック | `/v1/clusters/{lc}/topics`、`.../topics/{name}` | 作成・一覧・取得・削除 | 命令 |
| パーティション | `.../topics/{name}/partitions` | 追加（`count` の増加） | 命令 |
| トピックの設定 | `.../topics/{name}/configs` | 取得・一括更新 | 命令 |
| ACL | `/v1/clusters/{lc}/acls` | 作成・一覧（絞り込み）・削除（絞り込み） | 命令 |
| コンシューマーグループ | `/v1/clusters/{lc}/consumer-groups`、`.../{group}` | 一覧・取得（メンバー、遅れ） | 写し（読み取りだけ） |
| 操作 | `/v1/operations/{id}` | 取得 | — |
| メトリクス | `/v1/metrics/...` | [metrics-and-billing.md](metrics-and-billing.md) の 6 節 | — |
| 請求 | `/v1/billing/...` | 同 7 節 | — |
| 監査ログ | `/v1/audit-events` | 一覧 | [security-and-acls.md](security-and-acls.md) の 8 節 |

- 組織は API キー（管理のキー）かセッションから決まるので、パスに入れない（組織の資源を除く）。
- Confluent の「環境（environment）」に当たる入れ物は持たない。論理クラスタは組織の直下に置く。環境で分けたい利用者は、組織を分けるか、名前の決まりで分ける（14 節の決定）。
- トピックの名前はパスにそのまま入れる。本家の規則（英数字、`.`、`_`、`-`）なので、URL の符号化は要らない。
- 資源の形は、Confluent に寄せて `id`・`kind`・`self`・`created_at`・`updated_at` を持つ。`resource_name` は `crn://<brand>/organization=<org>/cluster=<lc>/topic=<name>` の形（`<brand>` は ADR-0006 のとおり）。

```json
{
  "kind": "Cluster",
  "id": "lc-7k2m9q",
  "self": "https://api.<brand>.<domain>/v1/clusters/lc-7k2m9q",
  "resource_name": "crn://<brand>/organization=org-.../cluster=lc-7k2m9q",
  "spec": {
    "display_name": "orders-prod",
    "tier": "standard",
    "region": "ap-northeast-1",
    "max_cu": 4,
    "ip_allowlist": ["203.0.113.0/24"]
  },
  "status": {
    "phase": "RUNNING",
    "bootstrap_endpoint": "lc-7k2m9q.ap-northeast-1.<brand>.<domain>:9092",
    "observed_generation": 12
  },
  "resource_version": "12",
  "created_at": "2026-09-27T01:23:45Z",
  "updated_at": "2026-09-27T01:24:30Z"
}
```

### 3.2 認証

| 主体 | 方式 |
| --- | --- |
| 管理のキー（サービスアカウント・利用者） | HTTP の Basic 認証。利用者名＝キーの ID、パスワード＝秘密（[security-and-acls.md](security-and-acls.md) の 3.3 節。Confluent と同じ形） |
| CLI の利用者 | デバイスの認可のフロー（OAuth 2.0 Device Authorization Grant）で得たアクセストークン（1 時間）とリフレッシュトークン（30 日）。`Authorization: Bearer` |
| コンソール | セッションの Cookie（5 節） |

- クラスタのキー（Kafka 用）で管理 API を呼ぶと 401（`api_key_scope_mismatch`）。

### 3.3 版

- パスの主版（`/v1`）だけを持つ。`/v1` の中では、足す変更だけを入れる（任意の項目・新しい資源・新しい列挙の値）。
- 列挙の値の追加は壊す変更になりうる。クライアント（CLI・Terraform・SDK）は、知らない値を `UNKNOWN` として扱う決まりにし、文書に書く。
- 壊す変更は `/v2` にし、`/v1` を少なくとも 180 日動かす（Confluent の GA の約束と同じ）。告知は、API の応答の `Deprecation`・`Sunset` の見出し、メール、変更の記録で行う。
- 日付の版（Stripe の方式。rebuilds の Stripe の [ADR-0007](../../../stripe/docs/decisions/0007-date-based-api-versions.md)）は採らない。資源の数が少なく、Terraform のプロバイダーが主な利用者で、プロバイダーの版が API の版を固定する役を持つため（[ADR-0034](../decisions/0034-management-api-shape.md)）。

### 3.4 冪等

- すべての `POST` が `Idempotency-Key` の見出し（255 文字まで）を受ける。CLI と Terraform のプロバイダーは常に付ける。
- 意味は rebuilds の Stripe の設計（[api.md](../../../stripe/docs/architecture/api.md) の 7 節）に合わせる：
  - 範囲は「組織 × キー」。最初の応答（状態コードと本文）を 24 時間以上保存し、同じキー・同じ要求には同じ応答を返す。`Idempotent-Replayed: true` を付ける。
  - 同じキーで中身が違えば 400（`idempotency_key_reused`）。実行中なら 409（`idempotency_key_in_use`）。
  - 検証の失敗、401、429 は保存しない。
- 命令（トピックの作成など）では、`commands` の行に冪等キーを持たせ、同じキーの再送で命令を 2 回作らない。202 の応答も保存し、再送には同じ操作の URL を返す。
- `PUT` 相当の操作（トピックの設定の一括更新）と `DELETE` は、もともと冪等。`DELETE` の 2 回目は 404 を返す（Terraform のプロバイダーは 404 を「消えている」と扱う）。

### 3.5 ページング

- `page_size`（既定 50、最大 200）と `page_token`（不透明）。応答は `{"data": [...], "metadata": {"next": "<url>|null"}}`。
- `page_token` は、並びの鍵（作成の時刻と ID）と絞り込みの条件のハッシュを、サーバーの鍵で暗号化したもの。条件を変えて使うと 400（`invalid_page_token`）。有効期限は 24 時間。
- 総件数は返さない（大きな論理クラスタで高くつく）。
- トピックの一覧は、KRaft の写し（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 6.3 節）から返し、`metadata.as_of` を付ける。

### 3.6 同時の更新

- 資源は `resource_version` を持つ。`PATCH` は `If-Match: "<resource_version>"` を任意で受け、合わなければ 412（`resource_version_mismatch`）。Terraform のプロバイダーは常に付ける。
- KRaft が正本の資源（トピックの設定）は、写しの `resource_version` で比べる。写しが古いと 412 になりうる。そのときは取り直して再試行する。

### 3.7 長い操作

- 論理クラスタの作成・削除、命令が 5 秒で終わらないときは 202 と `Location: /v1/operations/{id}` を返す。
- 操作の資源：`{ "id", "kind", "target", "status": "PENDING|RUNNING|SUCCEEDED|FAILED", "error", "created_at", "completed_at" }`。
- 論理クラスタの作成は、`status.phase` でも追える（`PROVISIONING` → `RUNNING`）。目標は 60 秒（p99）。

### 3.8 エラー

```json
{
  "error": {
    "status": 409,
    "code": "topic_already_exists",
    "message": "Topic 'orders' already exists.",
    "details": { "protocol_error_code": 36 },
    "doc_url": "https://docs.<brand>.<domain>/errors/topic_already_exists",
    "request_id": "req_..."
  }
}
```

- `code` は小文字のスネークケースにする（Confluent は大文字。好みの差で、互換は目標にしない）。
- 命令の失敗では、Kafka のエラーコードを `details.protocol_error_code` に載せる。本家のエラーコードとの対応の表は、開発リポジトリの spec に持つ。
- すべての応答に `X-<Brand>-Request-Id` を付ける（[architecture/README.md](README.md) の 5 節の例）。

### 3.9 レート制限

| 範囲 | 上限（初期値） | 備考 |
| --- | --- | --- |
| 組織ごと（管理 API 全体） | 25 回/秒、瞬間 100 | トークンバケット |
| 組織ごとの命令（トピック・ACL の変更） | 10 回/秒 | 命令の待ちの接続を守る |
| 組織ごとのメトリクスの問い合わせ | 300 回/分 | [metrics-and-billing.md](metrics-and-billing.md) の 6.3 節 |
| 送信元 IP ごとの認証の失敗 | 1 分に 100 回 | [security-and-acls.md](security-and-acls.md) の 3.6 節 |

- 超えたら 429 と `X-RateLimit-Limit`・`X-RateLimit-Remaining`・`X-RateLimit-Reset`・`Retry-After`（Confluent と同じ見出し。見出しの名前に本家の名前を含まないので、そのまま使う）。
- トピックの作成・削除の頻度は、Kafka のプロトコルの側でもクォータで絞る（multi-tenancy-and-quotas の領域）。管理 API の上限と足し合わせない（別々に数える）。

### 3.10 契約

- OpenAPI 3.1 を契約にする。制御面の Hono と Zod の定義から OpenAPI を出力し、CI で前の版との差を検査して、`/v1` の中で壊す変更を止める。
- Go の SDK（`<brand>-go`）を OpenAPI から生成し、CLI と Terraform のプロバイダーが使う。TypeScript の型も生成し、コンソールが使う。
- 管理 API とコンソールの操作は、同じハンドラー・同じ `authorize()`・同じ冪等・同じ監査を通る（rebuilds の Stripe の [ADR-0028](../../../stripe/docs/decisions/0028-dashboard-architecture.md) と同じ考え方）。

## 4. コンソール

### 4.1 作り

- React の SPA（TanStack Router・TanStack Query）。管理 API の `/v1` を、セッションの Cookie で呼ぶ。コンソールだけの API（ホームの集計、導入の手順の状態）は `/console/...` に置き、公開の契約にしない。
- CSP は `script-src 'self'`。第三者のスクリプト（計測、チャットの窓）を読み込まない（Stripe の ADR-0028 と同じ理由。API キーを作れる画面のため）。
- 一覧は、フォーカスの復帰と 30 秒ごとに取り直す。WebSocket は使わない。

### 4.2 画面

| 画面 | 中身 |
| --- | --- |
| ホーム | 論理クラスタの一覧、今月の見込みの請求、お知らせ |
| 論理クラスタ | 概要（ブートストラップ、層、CU の使用と上限）、トピック、コンシューマーグループ（遅れ）、ACL、API キー、メトリクス、設定（IP の許可リスト、`max_cu`） |
| トピック | 作成（パーティションの数、許可した設定）、設定の変更、パーティションの追加、削除、メトリクス |
| 接続の設定 | クライアントの設定の例（Java、librdkafka、franz-go、confluent-kafka-javascript）。ブートストラップと API キーの ID を埋め込み、秘密は伏せる |
| アクセス | 利用者、招待、サービスアカウント、ロール、API キー |
| 請求 | 使用量、請求書、支払いの方法、予算とアラート |
| 監査ログ | 検索（主体、事象、期間） |

- レコードの中身を見る画面（メッセージの閲覧）は、MVP に入れない。入れる場合も、利用者自身の ACL で読む（コンソールの主体に全テナントを読む権限を持たせない）。14 節の持ち越し。

### 4.3 最初の 5 分（SC-3）

```
1. 登録（メールの OTP か Google）                            30 秒
2. 組織の名前 → Basic の論理クラスタを作る（無料の枠）        60 秒（作成の p99）
3. トピックを作る（既定：パーティション 6）                   10 秒
4. API キーを作る（パスキーの登録を促す。6 節）              60 秒
5. 表示された CLI の 1 行で produce と consume               60 秒
```

- 手順 5 の CLI の例：`<brand> topic produce orders --cluster lc-... --api-key <brand>_key_...`。秘密は CLI が尋ねる（履歴に残さない）。
- 導入の各段の所要時間を、自前の計測（第三者のスクリプトなし）で集め、SC-3 の達成率を見る。

### 4.4 言語とアクセシビリティ

- 日本語を先に作り、英語を足す。文言はメッセージのカタログに置き、コードに直書きしない。
- WCAG 2.2 の AA を目標にする。キーボードだけで全画面を操作できる。

## 5. ログイン

- rebuilds の Slack の方式（Better Auth を自前でホストし、パスワードを持たない。Slack の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)）を引き継ぐ。手段は、メールの OTP、Google（OIDC）、パスキー。
- **MFA は、重要な操作の前の段階の認証（ステップアップ）で求める。** 登録の時点では求めない（SC-3 の 5 分を守るため）。

| 重要な操作 | 求めるもの |
| --- | --- |
| API キーの作成・削除 | 直近 10 分以内に、パスキーか TOTP を通したこと |
| ロールの付与・削除、招待、サービスアカウントの削除 | 同上 |
| 論理クラスタの削除、IP の許可リストの変更 | 同上 |
| 支払いの方法の変更 | 同上 |
| 組織の設定で「MFA を全員に必須」を有効にしたとき | ログインのたびに MFA |

- 最初の API キーの作成で、パスキーの登録を案内する（登録は 1 分以内）。
- セッション：アイドル 24 時間、絶対 14 日。Stripe（お金を動かす画面）より長く、Slack より短くする。
- SAML・OIDC のシングルサインオンは S2。

## 6. CLI

- Go の 1 つのバイナリ。コマンド名は `<brand>`（ADR-0006）。

| コマンド | 中身 |
| --- | --- |
| `<brand> login` | デバイスの認可のフロー。トークンは OS のキーチェーンに保存 |
| `<brand> cluster create\|list\|describe\|update\|delete` | 論理クラスタ |
| `<brand> topic create\|list\|describe\|update\|delete` | トピック |
| `<brand> topic produce\|consume` | 動作の確認。Kafka のクライアントは franz-go（行列にある Go のクライアント。[protocol-and-compatibility.md](protocol-and-compatibility.md) の 6 節） |
| `<brand> api-key create\|list\|delete` | API キー。秘密は作成のときに 1 回だけ表示し、`--output json` でも 1 回だけ出す |
| `<brand> service-account ...`、`<brand> acl ...`、`<brand> role-binding ...` | アクセス |
| `<brand> consumer-group list\|describe` | グループと遅れ |
| `<brand> metrics query` | メトリクス |

- 出力は人向けの表（既定）、`--output json|yaml`。終了コードは、成功 0、利用者の誤り 2、サーバーの誤り 3、認証の誤り 4。
- 設定は `~/.config/<brand>/config.yaml`（組織と既定の論理クラスタ）。秘密はファイルに書かず、キーチェーンに置く。CI では環境変数（`<BRAND>_API_KEY`・`<BRAND>_API_SECRET`）。
- 配布：GitHub の Releases、Homebrew の tap、`.deb`・`.rpm`。署名（Sigstore の cosign）と SBOM を付け、macOS は公証する。ライセンスは Apache License 2.0（依存の表示は、intent.md の L2 の確認の後に決める）。
- 更新の確認：起動のとき 1 日 1 回、新しい版を知らせる（自動では更新しない）。

## 7. Terraform のプロバイダー

- アドレスは `<brand>/<brand>`。Terraform Plugin Framework（Go）。Go の SDK（3.10 節）を使う。

| 資源 | 対応する API | 備考 |
| --- | --- | --- |
| `<brand>_cluster` | `/v1/clusters` | 作成は操作が終わるまで待つ（既定 20 分で打ち切り） |
| `<brand>_topic` | `.../topics` | パーティションの数は増やすだけ。減らす計画は、置き換えではなくエラーにする（データを消さないため） |
| `<brand>_topic_config` を持たず、`<brand>_topic` の `config` で扱う | `.../configs` | 許可リストにない設定は、計画の段階で検証する |
| `<brand>_service_account` | `/v1/service-accounts` | |
| `<brand>_api_key` | `/v1/api-keys` | 秘密は状態（state）に `sensitive` で入る。Terraform の ephemeral な資源で秘密を状態に残さない方式を、プロバイダーの版で選べるようにする（ephemeral な資源は Terraform 1.10 から、write-only の引数は 1.11 から。[Terraform 1.10](https://www.hashicorp.com/en/blog/terraform-1-10-improves-handling-secrets-in-state-with-ephemeral-values)、[Terraform 1.11](https://www.hashicorp.com/en/blog/terraform-1-11-ephemeral-values-managed-resources-write-only-arguments)、2026-09-27 に確認。プロバイダーが対応する Terraform の最小の版は E10 の `terraform-provider` で決める） |
| `<brand>_acl` | `.../acls` | ACL の全部の項目で 1 つの資源。更新は置き換え |
| `<brand>_role_binding` | `/v1/role-bindings` | |
| データソース | 論理クラスタ、トピック、サービスアカウント | |

- すべての資源で `import` を持つ。コンソールで作ったものを Terraform に取り込めるようにする。
- トピックと ACL は、テナントが Kafka のプロトコルでも変えられる。計画（plan）で差として見え、適用で Terraform の定義に戻す。これは Terraform の普通の振る舞いで、文書に書く（制御面は調停しない。[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 4.2 節）。
- 受け入れのテスト：ステージングの制御面と物理クラスタに対して、全資源の作成・更新・取り込み・削除を、PR ごと（代表）と日次（全体）で流す。
- Terraform Registry に公開し、GPG の鍵で署名する。

## 8. 障害と振る舞い

| 事象 | 起きること | 検知 | 対応 |
| --- | --- | --- | --- |
| 管理 API の停止 | コンソール・CLI・Terraform が使えない。データの経路は続く | 外からの合成監視 | 制御面の復旧。状況のページで知らせる |
| 命令の遅れ | 202 が増え、操作の完了が遅れる | 202 の率、操作の完了の時間 | エージェントの状態を調べる（[control-plane-and-provisioning.md](control-plane-and-provisioning.md) の 11 節） |
| 写しの遅れ | 一覧が古い（Kafka で作ったトピックが出ない） | `as_of` の遅れ | 同上 |
| 冪等の保存の失敗 | 再送で重複しうる | 保存の失敗の件数 | 応答を返さず 500 にし、再送させる（保存できなかった結果を返さない） |
| Terraform の状態と実際の食い違い | 計画に差が出る | 利用者の報告 | 文書の手順（`import`、`refresh`） |

## 9. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| コンソールの XSS からの API キーの作成 | CSP で `self` 以外のスクリプトを禁止。重要な操作のステップアップの認証 |
| CSRF | `SameSite=Lax` の Cookie、`Origin` の検査、JSON だけを受ける（Slack と同じ） |
| API キーの秘密の露出 | 作成の応答だけで返す。CLI は履歴に残さない入力で受ける。Terraform は `sensitive` と ephemeral の資源 |
| 組織をまたぐ参照 | パスの資源の組織と、主体の組織の一致を `authorize()` で確かめる。合わなければ 404（存在を知らせない） |
| ページングのトークンの改ざん | サーバーの鍵で暗号化し、条件のハッシュで束縛する |
| 配る成果物の改ざん | CLI とプロバイダーの署名、SBOM |

## 10. テスト

- 契約：OpenAPI のスナップショットと、壊す変更の検査（3.10 節）。
- 表駆動テスト：3.4 節の冪等の決定表、3.2 節の主体と範囲（管理のキー・クラスタのキー・セッション）の表、5 節の重要な操作とステップアップの表。
- 性質ベーステスト：任意の一覧の要求の列で、ページングの全件の連結が、ページングなしの全件と同じ（重複・抜けなし）。同じ `Idempotency-Key` の並行の要求で、作られる資源が 1 つだけ。
- E2E：4.3 節の最初の 5 分を、ステージングで毎日流し、所要時間を記録する。
- Terraform：受け入れのテスト（7 節）。CLI：主なコマンドの E2E と、終了コードの表。
- アクセシビリティ：axe の自動の検査と、スクリーンリーダーの手動の確認（リリースごと）。

## 11. ADR

| ADR | 決定 |
| --- | --- |
| [0034](../decisions/0034-management-api-shape.md) | 管理 API は `/v1` の主版だけを持ち、足す変更だけを入れる。POST に冪等キー、一覧に不透明なページングのトークン、長い操作に 202 と操作の資源。OpenAPI を契約にする |
| [0035](../decisions/0035-console-and-login.md) | コンソールは管理 API を呼ぶ SPA にし、第三者のスクリプトを読み込まない。ログインは Better Auth で、MFA は重要な操作の前のステップアップで求める |
| [0036](../decisions/0036-cli-and-terraform-provider.md) | CLI と Terraform のプロバイダーは Go で、OpenAPI から生成した 1 つの SDK を共有する。名前は `<brand>` |

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E10 | `management-api-foundation` | Hono の `/v1`、認証（Basic、Bearer、セッション）、エラーの形、`X-<Brand>-Request-Id` |
| E10 | `idempotency` | 3.4 節の保存と決定表 |
| E10 | `pagination` | 3.5 節のトークンと `as_of` |
| E10 | `operations-resource` | 3.7 節の 202 と操作 |
| E10 | `rate-limits` | 3.9 節 |
| E10 | `openapi-contract` | OpenAPI の出力、差の検査、Go と TypeScript の生成 |
| E10 | `console-shell` | SPA の骨組み、CSP、i18n、ナビゲーション |
| E10 | `console-onboarding` | 4.3 節の最初の 5 分と、その計測 |
| E10 | `console-cluster-pages` | 4.2 節の論理クラスタ・トピック・接続の設定 |
| E10 | `console-login-stepup` | 5 節のログインとステップアップ |
| E10 | `cli` | 6 節のコマンド、デバイスの認可、配布 |
| E10 | `terraform-provider` | 7 節の資源、`import`、受け入れのテスト、Registry への公開 |
| E8 | `console-access-pages` | 利用者・サービスアカウント・ロール・API キーの画面（security-and-acls と一緒に） |
| E11 | `console-billing-pages` | 請求の画面（metrics-and-billing と一緒に） |

## 13. 段階ごとの変化

| 項目 | S1 | S2 | S3 |
| --- | --- | --- | --- |
| ログイン | OTP、Google、パスキー、ステップアップの MFA | ＋SAML・OIDC の SSO、SCIM | 同じ |
| 管理 API | `/v1` | 同じ。スキーマレジストリの管理 | ＋BYOC の管理 |
| コンソール | 日本語、英語 | ＋メッセージの閲覧（14 節の持ち越し） | 同じ |
| リージョン | 東京 | 同じ（大阪は災害復旧） | 大阪、他のリージョン（パスは同じで、`region` で分ける） |

## 14. 未解決の問い

- 「環境（environment）」の入れ物を持つか。
- コンソールでレコードを見る機能を持つか。
- 管理 API の版を日付で持つか、パスの主版にするか。
- API キーの秘密を Terraform の状態に残さない方法。
- CLI の `produce`・`consume` を、どこまで作り込むか（スキーマのある形式、Avro）。

### 決定（2026-09-27、既定案）

- **環境**：持たない。組織の直下に論理クラスタを置く。本番と開発を分けたい利用者には、組織を分けるか、論理クラスタの名前とロールの付与（論理クラスタの単位）で分けるよう案内する。需要が強ければ S2 で、`/v1` に足す形で足す（任意の項目なので壊さない）。
- **レコードの閲覧**：MVP では持たない。S2 で持つなら、利用者のブラウザの中で、利用者が選んだ API キーで読む形を第一の候補にする（コンソールのサーバーがレコードに触れない）。
- **版**：パスの主版（3.3 節）。
- **Terraform の秘密**：`<brand>_api_key` は状態に `sensitive` で入る。ephemeral な資源を別の資源として用意する（`<brand>_api_key` の ephemeral の版）。ephemeral な資源は Terraform 1.10 以上で使える（2026-09-27 に確認。7 節の表）。
- **CLI の produce・consume**：文字列と JSON だけ。スキーマのある形式は、スキーマレジストリ（S2）と一緒に足す。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| プロバイダーが求める Terraform の最小の版 | E10 の `terraform-provider`。ephemeral な資源は 1.10、write-only の引数は 1.11 から（2026-09-27 に確認） |
| CLI の依存の OSS の表示（NOTICE）の形 | 法務の確認待ち（intent.md の L2） |
| 管理 API の組織ごとのレート制限の値 | E10 の負荷試験と、ベータの利用の実績 |

## 15. quality.md・runbooks・data-model への項目

### quality.md

- 最初の 5 分（SC-3）の E2E の所要時間を日次で記録し、目標（5 分）の達成率を本番での品質検証の指標にする。
- OpenAPI の壊す変更の検査を、CI の必須にする。
- Terraform のプロバイダーの受け入れのテストの合格率。

### runbooks

- `runbooks/management-api-outage.md`：管理 API の停止のときの知らせ方（状況のページ）と、データの経路が影響を受けないことの確かめ方。
- `runbooks/api-deprecation.md`：`/v1` の項目・資源の廃止の告知（180 日）の手順。
- `runbooks/cli-release.md`、`runbooks/terraform-provider-release.md`：署名と公開、戻し方。

### data-model（索引への追加の提案）

| テーブル | 中身 |
| --- | --- |
| `users`、`sessions`、`passkeys`、`two_factors`（制御面の `auth` スキーマ） | Better Auth のモデル（Slack と同じ） |
| `organization_members` | `organization_id`、`user_id`、参加日時、無効化の日時 |
| `invitations` | メールアドレス、ロール、トークンのハッシュ、期限（7 日） |
| `idempotency_keys` | `organization_id`、キー、要求のハッシュ、状態、応答の状態コードと本文、作成の時刻。日ごとのパーティション、48 時間で削除 |
| `operations` | `id`、種類、対象、状態、エラー、作成・完了の時刻（`commands` と論理クラスタの作成を指す） |
| `device_authorizations` | デバイスの認可のコード、利用者、期限、状態 |

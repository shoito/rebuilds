# Extensibility: Auth0（MVP の後）

テナントが書くコードで認証の流れを拡張する仕組み（本家の Actions に相当）の設計。トリガー、実行の隔離、時間とメモリーの上限、秘密、npm の依存、失敗の扱い、認証の経路への影響を決める。決定は [ADR-0048](../decisions/0048-extensibility-triggers-and-failure-policy.md)（トリガーと失敗の扱い）、[ADR-0049](../decisions/0049-extensibility-execution-isolation.md)（実行の隔離）、[ADR-0050](../decisions/0050-extensibility-build-secrets-and-limits.md)（ビルド・秘密・上限）にある。

**MVP の後（E13）** に作る。intent は、任意のコードを認証の経路で動かすので隔離の設計が重く、ADR-0005 の依存の制約とも関わるとして、MVP から外した。旧来の Rules・Hooks に相当するものは作らない（intent の Non-goals）。

本家の振る舞いは、2026-09-27 に auth0.com/docs、Management API の OpenAPI、本家のブログで確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| トリガーの種類、呼ぶ場所、入力（`event`）と出力（`api`） | トークンのクレームの規則（ADR-0008）、MFA の判定（mfa-and-passkeys） |
| 実行の隔離（どこで、どう動かすか）、外向きの通信 | 画面の独自のフォーム（本家の Forms。持たない） |
| ビルド（npm の依存）、秘密、版、上限 | エンドユーザーを外部のページへ送るリダイレクト（MVP の後の後。13 節） |
| 失敗と時間切れの扱い、ADR-0005 の縮退の表への行 | |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| トリガー | `post-login`（認証の後、トークンの発行の前）、`pre-user-registration`（作成の前）、`post-user-registration`（作成の後、非同期）、`post-change-password`、`credentials-exchange`（M2M のアクセストークンを返す前。同期）、`send-phone-message`、`password-reset-post-challenge`、`custom-token-exchange` など。OpenAPI の列挙には 15 種 | [Explore Triggers](https://auth0.com/docs/customize/actions/explore-triggers)、[Machine to Machine Trigger](https://auth0.com/docs/customize/actions/explore-triggers/machine-to-machine-trigger)、OpenAPI の `ActionTriggerTypeEnum` |
| 並び | 1 つのトリガーに複数の Action を順に並べる | Explore Triggers |
| 言語と実行環境 | JavaScript（TypeScript は不可）。Node.js。既定は `node22` | [Actions Limitations](https://auth0.com/docs/customize/actions/limitations)、OpenAPI の `CreateActionRequestContent` |
| 時間 | 1 回のトリガーの実行は 20 秒以内。超えるとエラー | Actions Limitations |
| 大きさ | Action のコードは 100 kB を超えないこと（npm の依存を除く） | 同上 |
| 秘密 | キー 128 文字、値 4,096 文字。1 つの Action に 30 個。保存の後は平文で読めない | 同上、[Entity Limit Policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/entity-limit-policy)、[Introducing Auth0 Actions](https://auth0.com/blog/introducing-auth0-actions/) |
| npm | 公開の npm のレジストリのパッケージを使える。1 つの Action に 10 個 | [Manage Dependencies](https://auth0.com/docs/customize/actions/manage-dependencies)、Entity Limit Policy |
| 件数 | テナントに 100 の Action、1 つのトリガーに 20、1 つの Action に 50 の版 | Entity Limit Policy |
| ログ | `console.log` は 1 つの Action で 256 文字まで保持。実行のログは 10 日 | Actions Limitations |
| キャッシュ | トリガーごとに 20 件、キー 64 バイト・値 4 kB・合計 8 kB、最長 24 時間。次の実行で使える保証はない | 同上 |
| 外向きの通信 | 公開された送信元の IP から出る | 同上 |
| 同時実行 | 公開クラウドの拡張の同時実行は 250 | [Rate Limit Policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/rate-limit-policy) |
| 実行の基盤 | 2019 年の記事で、Rules とカスタムのデータベースのスクリプトは Extend（Webtask 由来）の専用のクラスタ（EC2 の Auto Scaling、Docker のコンテナ、独自のプロキシ）で動くとしている。**Actions の今の隔離の方式は公開されていない（未検証）** | [A Look at Auth0 Cloud Architecture: 5 Years In](https://auth0.com/blog/auth0-architecture-running-in-multiple-cloud-providers-and-regions/)（2019-02-26） |
| 本家が勧める使い方 | 検証の済んだ版だけを配備する。下書きと試験ができる | Introducing Auth0 Actions |

## 3. 原則

- **認証の経路の可用性を、テナントのコードの質に左右させない。** テナントのコードの失敗は、そのテナントのログインだけを失敗させる。実行の基盤の障害は、ADR-0005 の縮退の表の行（7 節）で扱う。
- **テナントのコードは、本システムの網・資格情報・他のテナントに届かない。** 隔離の境界は VM（[ADR-0049](../decisions/0049-extensibility-execution-isolation.md)）。
- **秘密はビルドの成果物に入れない。** 実行のたびに渡す。
- **認証の経路の遅延の予算に、テナントのコードの時間を含めない。** NFR-002 は、外部の IdP とメールの待ちと同じく、Action の実行の時間を除いて測る。Action の時間は別に計り、テナントに見せる。

## 4. トリガー

| トリガー | いつ | 同期 | 本家 | Epic |
| --- | --- | --- | --- | --- |
| `post-login` | 認証（MFA を含む）の後、認可コード・トークンの発行の前 | 同期 | 同じ | E13 |
| `credentials-exchange` | `client_credentials` でアクセストークンを返す前 | 同期 | 同じ | E13 |
| `pre-user-registration` | データベース接続のサインアップで、ユーザーを作る前 | 同期 | 同じ | E13 |
| `post-user-registration` | ユーザーを作った後 | 非同期（Worker） | 同じ | E13 |
| `post-change-password` | パスワードの変更の後 | 非同期（Worker） | 同じ | E13 |
| その他（電話のメッセージ、トークン交換など） | — | — | ある | 需要を見て |

### 4.1 `event` と `api`（抜粋）

名前は本システムのもの。形は本家に寄せる（本家の名前を含まない）。

| トリガー | `event` の主なもの | `api` の主なもの |
| --- | --- | --- |
| `post-login` | `tenant`、`client`、`user`（プロフィールとメタデータ。資格情報を含まない）、`connection`、`request`（IP、国、`user_agent`、`query` の許可リストの欄）、`authentication`（`methods`、`amr`）、`organization`（E14）、`resource_server` | `api.access.deny(reason)`、`api.idToken.setCustomClaim(name, value)`、`api.accessToken.setCustomClaim(name, value)`、`api.accessToken.addScope/removeScope`、`api.multifactor.enable(provider)`、`api.user.setAppMetadata(key, value)`、`api.user.setUserMetadata(key, value)` |
| `credentials-exchange` | `tenant`、`client`（`client_metadata` を含む）、`resource_server`、`request`、`requested_scopes` | `api.access.deny(code, reason)`、`api.accessToken.setCustomClaim` |
| `pre-user-registration` | `tenant`、`client`、`connection`、`user`（入力のメール・メタデータ）、`request` | `api.access.deny(reason, userMessage)`、`api.user.setUserMetadata`、`api.user.setAppMetadata` |
| 非同期 | 各事象の `event` | なし（戻り値は捨てる） |

- **独自のクレームは名前空間つきの名前だけ**（URL の形。ADR-0003）。予約のクレーム（`iss`・`sub`・`aud`・`exp`・`iat`・`nbf`・`jti`・`azp`・`scope`・`amr`・`acr`・`auth_time`・`sid`・`nonce`・`org_id` など）は変えられない。書き込みは無視し、実行のログに警告を残す。トークンの大きさの上限（8 KiB。ADR-0008）を超えたら、発行を失敗させる。
- `request.query` と本文は、許可リストの欄だけを渡す。`code`・`code_verifier`・`client_secret`・パスワード・トークンは渡さない。
- メタデータの書き込みは、トリガーの終わりにまとめて 1 回 DB に書く（本家の 1 回の実行あたりの上限、ユーザーとアプリのメタデータ各 32 kB に合わせる）。
- `api.redirect`（外部のページへ送って戻る）は、ログインのトランザクション（ADR-0011）の中断と再開の設計が要る。E13 の後に扱う（13 節）。

### 4.2 呼ぶ順と時間

```
/oauth/token（client_credentials）
  クライアントの認証 → 許可の確認 → [credentials-exchange の Action を順に] → Signer で署名 → 応答

Universal Login
  資格情報の確認 → MFA → [post-login の Action を順に] → 認可コードの発行 → リダイレクト
```

- 1 つのトリガーの Action は、登録の順に 1 つずつ動かす。1 つが `deny` したら、残りを動かさない。
- 呼び出しは、トリガーの全体（順に並んだ Action のすべて）で 1 回の Lambda の呼び出しにする。Action ごとに呼ばない（往復とコールドスタートを減らす）。
- **同期のトリガーの全体の時限は 10 秒**（本家は 20 秒）。ログインの画面で利用者を 20 秒待たせることを、既定では許さない。移るテナントのために、テナントの上書きで 20 秒まで広げられる（13 節）。
- 非同期のトリガーは 20 秒。Worker から呼び、失敗は 3 回まで再試行する（1 分・5 分・30 分）。

## 5. 実行の隔離

### 5.1 比べたもの

[ADR-0049](../decisions/0049-extensibility-execution-isolation.md)。

| 方式 | 隔離の境界 | 起動 | 運用 | npm の互換 | 評価 |
| --- | --- | --- | --- | --- | --- |
| A. V8 isolate（`isolated-vm`、workerd など） | 同じプロセスの中の isolate | 数 ms | 多層の防御（プロセスのサンドボックス、cordon、Spectre の対策）を自前で作る。本家の Cloudflare Workers と同じ層が要る | Node の API が一部しかない。npm のパッケージの多くが動かない | 採らない |
| B. 自前の Firecracker の microVM | KVM の VM | 125 ms 以下（仕様） | EC2 の metal のフリートを運用する（GitHub の [ADR-0023](../../../github/docs/decisions/0023-firecracker-microvm-runners.md)） | Node をそのまま動かせる | 採らない（S3 で再評価） |
| C. Lambda のテナントごとの関数 | Firecracker（Lambda の実行環境） | Node のコールドスタート（未検証） | テナント × Action の版ごとに関数を作る。1 万テナントで数万の関数、コードの保管の上限、配備の速さの上限を管理する | Node をそのまま | 採らない |
| **D. Lambda のテナントの隔離のモード** | Firecracker。実行環境はテナントの間で再利用しない | 同上。テナントごとの実行環境なので、コールドスタートが増える | 関数は Node の版ごとに 1 つの共通の実行器。テナントのコードを実行時に読み込む | Node をそのまま | **採る** |

Lambda のテナントの隔離のモード（[Tenant isolation](https://docs.aws.amazon.com/lambda/latest/dg/tenant-isolation.html)、2026-09-27 に確認）：

- 呼び出しに `tenant-id` を付けると、その関数の実行環境は、その `tenant-id` の呼び出しにだけ使われ、他のテナントに再利用されない。実行環境は Firecracker の仮想化で隔離される。
- 作成時にだけ有効にでき、変えられない。`tenant-id` のない呼び出しは失敗する。
- 実行ロールはすべてのテナントで共通。
- 関数の URL、プロビジョニングされた同時実行、SnapStart は使えない。
- 1,000 の同時実行につき、テナントの実行環境は 2,500 まで（動作中と待機中の合計）。
- 実行環境を作るたびに追加の料金がかかる。
- ニュージーランドを除く商用のリージョンで使える（東京・大阪を含む）。

### 5.2 構成

```
Auth（認証の経路）                                        actions アカウント（prod と別の AWS アカウント）
  actions-invoker（Auth の中のモジュール）                 ┌──────────────────────────────────────────┐
   1. トリガーの版の束（bundle）の ID を設定のキャッシュから  │ Lambda 関数 actions-runner-node22          │
   2. 秘密を復号（ADR-0004）                               │   テナントの隔離のモード、arm64、1,024 MB     │
   3. 束の S3 の署名付き URL（60 秒、その束だけ）を作る      │   実行ロール：権限なし                      │
   4. Invoke(tenant-id = tenant_id, payload) ────────────▶│   VPC：actions-egress（内部への経路なし、     │
      （Lambda の VPC エンドポイント、同期、時限 10 秒）      │         専用の NAT、公開する送信元の IP）   │
   5. 応答を検証（Zod）して適用                            │   1 回目：束を取得し sha256 を照合、/tmp に置く │
                                                          └──────────────────────────────────────────┘
```

- **関数は Node の版ごとに 1 つ**（`actions-runner-node22` など）。テナントのコードは、関数のコードに入れず、実行時に読み込む。関数の数はテナントの数に比例しない。
- **`tenant-id` はテナントの ID。** 同じテナントの複数の Action は、同じ実行環境を共有しうる（同じテナントの中なので許す）。Action ごとにすると、実行環境の上限（1,000 の同時実行につき 2,500）を早く使い切る。
- **実行ロールに権限を持たせない。** 実行ロールはすべてのテナントで共通なので、ロールに S3 や KMS の権限があると、あるテナントのコードが他のテナントの束や秘密を読める。束は、Auth が作る、その束だけの 60 秒の署名付き URL で渡す。秘密は呼び出しの本文で渡す。CloudWatch Logs への書き込みの権限も持たせず、`console.log` は実行器が集めて応答で返す。
- **網**：関数は、本システムの prod の VPC と経路のない専用の VPC（`actions-egress`）に置き、専用の NAT の Elastic IP を送信元として公開する（本家も送信元の IP を公開している）。本システムの内部（prod の VPC、VPC エンドポイント）には届かない。Lambda の中から IMDS には届かない（Lambda に IMDS はない）。
- **アカウント**：関数と `actions-egress` の VPC は、prod と別の AWS アカウント（`actions`）に置く。Auth は、アカウントをまたいで `lambda:InvokeFunction` だけを持つ。`actions` のアカウントは [ADR-0057](../decisions/0057-accounts-network-and-path-separation.md) と [infrastructure.md](infrastructure.md) の 1 節の表に足した（2026-09-27）。
- **束の置き場所**：`actions` のアカウントの S3。テナントの接頭辞ごとに分け、Auth のロールだけが署名付き URL を作れる。

### 5.3 実行器（runner）

- 束を `/tmp/<sha256>` に置き、`sha256` が本文の値と一致することを確かめてから読み込む（署名付き URL が差し替えられても、別の束を動かさない）。
- 束は `vm` のモジュールではなく、普通の CommonJS として `require` する。実行環境がテナントごとに分かれているので、プロセスの中での分離はしない（同じテナントのコードどうし）。
- 実行の前後で、グローバルの状態の汚れ（前の実行が残した値）は、同じテナントの中の話として許す（本家のキャッシュも「次の実行で使える保証はない」）。
- 応答は `{results: [{action_id, commands: [...], logs: "...(256 文字まで)", duration_ms, error?}]}`。`commands` は `api` の呼び出しの記録で、Auth が Zod で検証してから適用する。**テナントのコードは、トークンもユーザーの表も直接変えない。** 変更の指示を返し、Auth が規則（予約のクレーム、大きさ、メタデータの上限）で検証して適用する。

## 6. ビルド、版、秘密

### 6.1 ビルド

[ADR-0050](../decisions/0050-extensibility-build-secrets-and-limits.md)。

```
Management API（Action の版の作成） ─▶ outbox ─▶ actions-builder（actions アカウントの CodeBuild。網は npm のプロキシだけ）
   1. 依存を解決（npm のプロキシ経由。公開の npm のレジストリだけ）、ロックファイルを作る
   2. npm install --ignore-scripts。ネイティブのアドオン（.node、node-gyp）を含むパッケージは拒否
   3. 既知の脆弱性・悪性のパッケージの照合（OSV のデータ）。悪性は拒否、脆弱性は警告
   4. esbuild で 1 つのファイルに束ねる（node22 向け）。束は 10 MiB まで
   5. sha256 を付けて S3 に置く。版の状態を built にする
```

- 依存は、版の作成の時点の具体の版に固定する（`^` を解決して記録する）。本家は版を空にすると最新を使う（[Manage Dependencies](https://auth0.com/docs/customize/actions/manage-dependencies)）。本システムも最新に解決するが、解決した版を記録して、同じ版の再ビルドで変わらないようにする。
- ビルドは、テナントのコードを動かさない（`--ignore-scripts`）。CodeBuild の実行環境は、ビルドごとに使い捨てる。
- TypeScript は受け付けない（本家と同じ）。

### 6.2 版と配備

- Action は版を持つ。状態は `draft` → `built` → `deployed`。1 つの Action の `deployed` の版は 1 つ。
- 「配備」は、トリガーの並びと各 Action の版を、テナントの設定の版（[ADR-0032](../decisions/0032-tenant-config-cache.md)）として書く。反映は最大 15 秒。
- 前の版への切り戻しは、配備の操作 1 回。
- 試験の実行（Management API の `test`）：同じ実行器で、テナントが与えた `event` で動かし、`commands` とログを返す。トークンは発行しない。

### 6.3 秘密

- Action の秘密は、エンベロープ暗号化で持つ（ADR-0004）。作成の後は読めない（本家と同じ）。
- 呼び出しのたびに、Auth が復号して本文で渡す。実行器は `event.secrets` として渡し、実行の後に参照を消す。**束・環境変数・`/tmp` に書かない。**
- 秘密の値は、実行のログと応答の `logs` から、値の完全一致で伏せる（テナントのコードが `console.log(secret)` しても、保存されるログに出さない）。
- テナントのコードが外部へ秘密を送ることは防げない（テナントの秘密なので、テナントの責任）。

## 7. 失敗と縮退

| 事象 | 同期のトリガー | 非同期のトリガー |
| --- | --- | --- |
| テナントのコードの例外 | その要求を失敗にする（ログインはエラーの画面、`/oauth/token` は `access_denied`）。本家と同じ | 再試行 3 回、その後は捨ててログ |
| 時間切れ（10 秒） | 同上 | 同上（20 秒） |
| テナントの同時実行の上限を超えた | 同上（`temporarily_unavailable`） | 遅らせる |
| 実行の基盤の障害（Lambda のスロットリング、Invoke の 5xx、到達不能） | トリガーの設定 `on_platform_error` に従う。既定 `deny`、テナントが `skip`（Action を飛ばして続ける）を選べる | 遅らせる |

- `skip` を選べるのは、Action の結果がなくても安全なトリガー（クレームの付け足しだけなど）を想定している。アクセスの判定（`deny`）を Action で行うテナントが `skip` を選ぶと、障害の間に判定なしで通る。ダッシュボードで警告する。
- `actions_execution_failed` のログを出す（[logs-and-streams.md](logs-and-streams.md)）。
- **ADR-0005 の縮退の表に、次の行を足した**（2026-09-27。AGENTS.md の「認証の経路に同期の依存を足さない。足す必要があるときは、ADR-0005 の縮退の表を先に更新し、レビューを受ける」）。E13 の spec の承認の前に、E13 の PoC の結果（コールドスタート、Lambda の可用性）で行の内容をレビューする。

  | 依存先 | 止まったときの振る舞い |
  | --- | --- |
  | Actions の実行の基盤（Lambda） | Action を使うテナントのトリガーだけが影響を受ける。`on_platform_error` が `deny` のテナントは、ログイン・M2M のトークンの発行が失敗する。`skip` のテナントは Action なしで続く。Action を使わないテナントは影響を受けない |

- Actions を使うテナントの本番の可用性（NFR-001）は、Lambda の可用性にも依る。Lambda の SLA は月間 99.95%（[AWS Lambda SLA](https://aws.amazon.com/lambda/sla/)、2026-09-27 に確認）で、NFR-001 の 99.99% より低い。**Action を使うテナントの SLO の扱い**（Action の基盤の障害を除外するか）は、13 節の問いに挙げる。
- 管理用のテナント（[dashboard.md](dashboard.md)）は Actions を使わない。

## 8. 上限

| 対象 | 上限 | 本家 |
| --- | --- | --- |
| Action の数 | テナントに 100、1 つのトリガーに 20 | 同じ |
| 版 | 1 つの Action に 50（超えたら使われていない最も古い版を消す） | 同じ |
| コード（依存を除く） | 100 kB | 同じ（本家は「超えないこと」の目安） |
| 束（依存を含む） | 10 MiB | 資料に記載がない（2026-09-27 に確認） |
| npm の依存 | 1 つの Action に 10 | 同じ |
| 秘密 | 1 つの Action に 30。キー 128 文字、値 4,096 文字 | 同じ |
| 同期のトリガーの時限 | 全体で 10 秒 | 20 秒 |
| 非同期のトリガーの時限 | 20 秒 | 20 秒（トリガーの種類を問わず、1 回の実行は 20 秒以内。Actions Limitations、2026-09-27 に確認） |
| メモリー | 1,024 MB（関数の設定） | 資料に記載がない（2026-09-27 に確認） |
| テナントの同時実行 | 本番 100、本番以外 10 | 公開クラウドの拡張の同時実行は 250 |
| `console.log` の保持 | 1 つの Action で 256 文字、10 日 | 同じ |
| メタデータの書き込み | 1 回の実行でユーザーとアプリのメタデータ各 32 kB | 同じ |
| 呼び出しの本文 | 6 MB（Lambda の同期の呼び出しの要求・応答の上限。[Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)、2026-09-27 に確認） | — |

- テナントの同時実行は、Auth が Valkey のセマフォ（[management-api-and-rate-limiting.md](management-api-and-rate-limiting.md) の 7.1 節の同時実行の仕組み）で数える。
- Lambda のアカウントの同時実行の上限（既定 1,000。[Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)、2026-09-27 に確認）は、E13 の前に引き上げを申請する。値は capacity の領域で決める。

## 9. セキュリティ

- 隔離の境界は Lambda の実行環境（Firecracker）。テナントの間で実行環境を再利用しない（5.1 節）。
- 実行ロールに権限なし、網は内部に届かない、別の AWS アカウント（5.2 節）。
- 束の `sha256` の照合で、差し替えを防ぐ（5.3 節）。
- テナントのコードは変更の指示を返すだけで、Auth が検証して適用する。予約のクレームを変えられない（4.1 節）。
- ビルドで `--ignore-scripts`、ネイティブのアドオンの拒否、悪性のパッケージの照合（6.1 節）。
- 秘密は束・環境変数・ディスクに書かず、ログから伏せる（6.3 節）。
- `event` に資格情報とトークンを入れない（4.1 節）。
- Action の作成・配備・秘密の変更は、Management API の監査に残し、配備は step-up を要する（[dashboard.md](dashboard.md) の 4.3 節に足す）。
- **Action の配備は、テナントのログインの振る舞いを変えるので、テナントの管理者の乗っ取りの影響が大きい**（任意のクレームを足せる、任意の外部へ利用者の情報を送れる）。配備のたびに、テナントの `admin` 全員にメールで知らせる。

## 10. テスト

- 隔離のテスト（CI と本番の定期の実行）：テストのテナントの Action から、次に届かないこと。
  - 他のテナントの束の署名付き URL（期限切れ・別の束）
  - AWS の API（実行ロールに権限がない）、本システムの内部のアドレス、VPC エンドポイント
  - 前の実行で、他のテナントが `/tmp` とグローバルに置いた印（`tenant-id` を変えて呼ぶ）
- 表駆動テスト：予約のクレームの書き込みの拒否、名前空間のないクレームの拒否、大きさの上限。
- 表駆動テスト：7 節の失敗 × `on_platform_error` の結果。
- 結合テスト：時間切れ（10 秒）で、ログインがエラーの画面になり、`actions_execution_failed` が出る。
- 結合テスト：秘密を `console.log` した Action の保存されたログに、秘密の値が出ない。
- 結合テスト：`postinstall` を持つパッケージ、ネイティブのアドオンを持つパッケージのビルドが失敗する。
- 障害の注入：Lambda の Invoke を遮断し、`deny`・`skip` のテナントと、Action のないテナントの振る舞いを確かめる。
- 負荷試験（E13）：`post-login` の Action ありで、コールドスタート（テナントごとの実行環境の初回）と温まった実行の遅延を計る。

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0048](../decisions/0048-extensibility-triggers-and-failure-policy.md) | トリガーは `post-login`・`credentials-exchange`・`pre-user-registration`（同期）と登録・パスワード変更の後（非同期）から始める。同期は全体 10 秒、テナントのコードの失敗は拒否、基盤の障害はテナントが `deny`・`skip` を選ぶ |
| [0049](../decisions/0049-extensibility-execution-isolation.md) | 実行は Lambda のテナントの隔離のモードの共通の実行器で行う。実行ロールに権限を持たせず、別のアカウントと内部に届かない VPC に置く |
| [0050](../decisions/0050-extensibility-build-secrets-and-limits.md) | npm の依存は隔離したビルドで `--ignore-scripts` で束ね、秘密は呼び出しの本文でだけ渡し、上限は本家に寄せる |

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E13 | PoC：Lambda のテナントの隔離のモードで、コールドスタート・温まった実行の遅延と、費用を計る（着手の最初） |
| E13 | ADR-0005 の縮退の表の更新の提案とレビュー（spec の承認の前提） |
| E13 | Action と版の Management API、ビルド（CodeBuild、npm のプロキシ、照合、esbuild） |
| E13 | 実行器（束の取得と照合、`commands` の記録、ログの収集と伏せ字） |
| E13 | `actions-invoker`：秘密の復号、署名付き URL、テナントの同時実行、時限、`on_platform_error` |
| E13 | `post-login` と `credentials-exchange` の `api`（クレーム、`deny`、MFA の有効化、メタデータ） |
| E13 | `pre-user-registration` と、非同期のトリガー（Worker） |
| E13 | 隔離のテスト、配備の step-up と管理者への通知、`actions_execution_failed` のログ |
| E9 | Action の編集・試験・配備の画面（E13 と合わせて） |

## 13. 未解決の問い

- 同期のトリガーの時限を、本家の 20 秒にするか、本システムの 10 秒にするか。移行のテナントの Action が 10 秒を超えるか。
- Action を使うテナントの SLO：Lambda の障害を NFR-001 の対象から除くか。
- `api.redirect`（外部のページへ送って戻る）をいつ足すか。
- キャッシュ（本家の `api.cache`）を持つか。
- Lambda のコールドスタート（未検証。PoC で計る）と、テナントの隔離の実行環境を作るたびの料金（単価は料金のページで表示されず未検証。[AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)）が、ログインの体験と採算に合うか。合わなければ、自前の Firecracker（GitHub の方式）へ移すか。
- テナントが Action から本システムの Management API を呼ぶとき、本家のような組み込みの手段を用意するか。

### 決定

2026-09-27 の既定案。

- 同期のトリガーの時限は既定で 10 秒。テナントの上書きで 20 秒まで広げられる形を E13 で作る（2026-09-27 に推奨案で確定）。
- Action を使うテナントの SLO は、Action の基盤の障害を除かない（ログインが失敗すれば失敗に数える）。代わりに、`skip` の選択肢と、基盤の可用性の計測をテナントに見せる。
- `actions` のアカウントは、ADR-0057 と infrastructure.md に足した（2026-09-27）。作るのは E13 の着手時。
- `api.redirect` とキャッシュは E13 の範囲に入れない。
- Management API は、組み込みの手段を用意せず、テナントが M2M の資格情報を秘密として持って呼ぶ（Management API のレート制限に数える）。
- 自前の Firecracker への移行は、E13 の PoC の結果（コールドスタートの p99 が 1 秒を超える、または費用が見合わない）で判断する。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：隔離の破れ（他テナントの束・秘密・実行環境の残りに届く）。隔離のテストを CI と本番の定期で回す。
- リスク：テナントのコードで、予約のクレームや大きさの上限が破られる。表駆動テスト。
- 本番での検証：合成監視のテナントに `post-login` の Action を置き、Action ありのログインを 5 分ごとに試す。コールドスタートの割合と遅延を見る。

**runbooks**

- `actions-platform-degraded`：Lambda のスロットリング・エラーの急増。`deny` のテナントへの影響、上限の引き上げ、テナントへの連絡。
- `actions-malicious-package`：悪性のパッケージが見つかった。該当の版を使うテナントの特定、配備の停止、連絡。
- `actions-tenant-runaway`：1 つのテナントの Action が同時実行を使い切る。上限の一時的な引き下げ。
- SLI の追加の依頼（Ops へ）：Action の実行の時間（p50・p99、コールド・温まった実行）、`actions_execution_failed` の率、Lambda のスロットリング、`on_platform_error` の発動の件数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `actions` | `tenant_id`、`id`、`name`、`trigger`、`runtime`、`deployed_version_id` | RLS |
| `action_versions` | `tenant_id`、`id`、`action_id`、`number`、`code`、`dependencies`（解決した版）、`status`（`draft`・`built`・`deployed`・`failed`）、`bundle_s3_key`、`bundle_sha256`、`build_log` | RLS |
| `action_secrets` | `tenant_id`、`action_id`、`name`、`ciphertext`、`updated_at` | RLS。値は読めない |
| `trigger_bindings` | `tenant_id`、`trigger`、`position`、`action_id`、`version_id`、`on_platform_error` | RLS。配備でテナントの設定の版を上げる |
| `action_executions`（ログの専用のクラスタ） | `tenant_id`、`id`、`trigger`、`results`（Action ごとの時間・エラー・256 文字のログ）、`created_at` | RLS。10 日 |

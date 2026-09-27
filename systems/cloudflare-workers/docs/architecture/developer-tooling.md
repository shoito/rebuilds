# Developer Tooling: Cloudflare Workers

開発者が手元から関数を作り、試し、配り、動きを見るための道具の設計。CLI `<brand>`、設定ファイル、workerd を使うローカル開発、`tail`（リアルタイムのログ）、利用者向けのログとトレース、バインディングの型の生成を決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md) | バンドルは ES モジュール・CommonJS・Wasm・データだけ。互換の日付の明示を求める |
| [ADR-0015](../decisions/0015-nodejs-compat-scope.md) | Node.js の互換の範囲。polyfill は CLI が足す |
| [ADR-0021](../decisions/0021-versions-deployments-and-gradual-rollout.md) | 版は変えられない。デプロイは 1〜2 の版と万分率。ロールバックは新しいデプロイ |
| [ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md) | 設定は変更のログでノードの LMDB へ配る |
| [ADR-0035](../decisions/0035-cli-and-single-jsonc-config.md) | CLI は TypeScript で npm に配り、設定ファイルは `<brand>.jsonc` の 1 つの形だけにする。ログインは PKCE とループバック、無人の環境は API トークン |
| [ADR-0036](../decisions/0036-local-dev-on-downstream-workerd.md) | ローカル開発は、本番と同じ下流の workerd と、workerd の中で動く模擬のストレージで行う。本物の資源へのつなぎ込みは、バインディングごとの明示の指定だけ |
| [ADR-0037](../decisions/0037-tail-sessions-and-tenant-logs.md) | `tail` は、変更のログで配るセッションの印と、リージョンの中継を経る WebSocket で届ける。保存するログは ClickHouse に 7 日置く。秘密の値とヘッダーはノードで伏せる |

版とデプロイの仕組みは [deployment-and-config-distribution.md](deployment-and-config-distribution.md)、バンドルの形と検証は [runtime-and-isolates.md](runtime-and-isolates.md) の 7 節、Web API と `request.<brand>` は [web-apis-and-compat.md](web-apis-and-compat.md) にある。管理 API の形と API トークンは [dashboard-and-api.md](dashboard-and-api.md)、制限の値と課金は [limits-and-billing.md](limits-and-billing.md) にある。基盤の側のログ・メトリクスの経路は [observability.md](observability.md) にある（利用者のログとの分け方は 8 節の冒頭）。

本家の振る舞いと数値は、2026-09-27 に本家の文書（Wrangler、Workers Logs、Tail Workers、Development & testing）と workerd の GitHub で確かめた。

## 1. 目的と範囲

- 目的：CLI の導入から、最初の関数が公開の URL で応答するまで、中央値 5 分以内（intent の K4）。手元の動きと本番の動きの差を、利用者に見える形で小さく保つ。

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| CLI のコマンド、配布、ログイン、出力の形 | 管理 API の形、API トークンの形（dashboard-and-api） |
| 設定ファイルの形と、版への写し方 | 版とデプロイのモデル（deployment-and-config-distribution） |
| バンドラー（esbuild）、polyfill の足し方、`request.cf` の lint | バンドルの検証（runtime-and-isolates の 7.3 節） |
| ローカル開発（workerd、模擬のストレージ、本物の資源へのつなぎ込み） | ストレージの本番の実装（kv-store、object-storage、durable-objects、queues-and-cron） |
| `tail`、保存するログの検索、呼び出しのトレース（利用者向け） | 基盤の運用のログ・メトリクス・SLO（observability） |
| 型の生成 | ランタイムの API そのもの（web-apis-and-compat） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| CLI のコマンド | `init`（C3 で雛形を作る）、`dev`（`localhost:8787`、`--remote`・`--local`・`--port`・`--persist-to`）、`deploy`（`--dry-run`・`--minify`・`--outdir`）、`versions upload`・`versions deploy`（割合を指定）、`rollback`、`secret put`・`secret bulk`、`tail`（`--format json\|pretty`、`--status`、`--search`、`--sampling-rate`）、`types` | [Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) |
| 設定ファイル | `wrangler.toml`・`wrangler.json`・`wrangler.jsonc` の 3 つ（v3.91.0 から）。新しい計画には `wrangler.jsonc` を勧め、新しい機能の一部は JSON の形だけで使える。最低限 `name`・`main`・`compatibility_date` が要る | [Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/) |
| 環境 | `env.<name>`。多くのキーは上から受け継ぐが、`vars`・`kv_namespaces` などのバインディングは受け継がず、環境ごとに書く | 同上 |
| 正本 | 設定ファイルを正本とし、ダッシュボードでの変更を避けるよう勧める | 同上 |
| ローカルのシークレット | 設定ファイルと同じ場所の `.dev.vars` か `.env` | 同上 |
| ローカル開発 | Miniflare が、本番と同じランタイム workerd で動かす。バインディングは既定で手元で模擬する（AI は常に遠隔）。`remote: true` でバインディングごとに本物の資源へつなぐ。Durable Objects・環境変数・シークレット・版のメタデータなどは遠隔にできない。遠隔への書き込みは本物のデータを変え、料金がかかる | [Development & testing](https://developers.cloudflare.com/workers/development-testing/) |
| リアルタイムのログ | 呼び出しのログ、`console` のログ、エラー、捕まえていない例外を出す。通信が多いと標本の段に入り、一部を捨てて警告を出す。1 つの関数を同時に見られるのは 10 のクライアントまで（ダッシュボードと CLI の合計） | [Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) |
| tail の API | `POST /accounts/{account_id}/workers/scripts/{script_name}/tails` が `id`・WebSocket の `url`・`expires_at` を返す | [Start Worker Tail](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/tail/methods/create/) |
| 保存するログ | 保持は有料 7 日・無料 3 日。1 呼び出しのログは 256KB まで。アカウントで 1 日 50 億件を超えると 1% の標本にする。`observability.head_sampling_rate`（0〜1）。呼び出しのログは `observability.logs.invocation_logs` で切れる。有料は月 2,000 万件を含み、超過は 100 万件あたり 0.60 ドル | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)、[Pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Tail Workers | 送り元の関数の実行が終わった後に、`tail()` のハンドラーを持つ別の関数を呼ぶ。`tail_consumers` で指定。有料だけ。CPU 時間で課金 | [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) |
| 型の生成 | `wrangler types` が、互換の日付と設定から、バインディングとランタイムの API の型（`worker-configuration.d.ts`）を作る | [Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/) |
| 型の元 | workerd の `types/` が、JSG の RTTI から TypeScript の型（`api.d.ts`）を作る | [workerd の types/README.md](https://github.com/cloudflare/workerd/blob/main/types/README.md) |

**本家との違いを先に書く。**

- 設定ファイルの形は JSONC の 1 つだけにする（ADR-0035）。本家は 3 つの形を持つが、新しい機能を JSON に寄せている。
- 本家の `dev --remote`（コードごと本家の網で動かす）は持たない。本物の資源が要るときは、バインディングごとのつなぎ込みだけにする（ADR-0036）。
- `tail` は、量が多い関数で「標本のモード」に入り、一部のメッセージを捨てて警告を出す（[Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)、2026-09-27 に確認）。入る条件と、ログの伏せ方（秘密の値、ヘッダー）の細部は公開されていない。この設計で決める（7 節）。

## 3. 原則

- **手元と本番の差を隠さない。** 同じ workerd で動かしても、制限の強制、外向きの宛先の制限、KV の古さなどは違う。違いは表にし、実行中に警告で知らせる（6.5 節）。
- **設定ファイルが正本。** CLI は設定ファイルから版を作る。ダッシュボードや API で変えた版との差は、デプロイの前に示す。
- **ログは、見られる人を絞り、伏せてから出す。** ログには関数の利用者（エンドユーザー）の要求が入る。秘密の値と認証のヘッダーは、ノードで伏せてから外に出す。
- **利用者の名前を識別子に使わない。** CLI の名前、設定ファイル、環境変数、npm の名前は `<brand>` で書く（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 4. CLI

[ADR-0035](../decisions/0035-cli-and-single-jsonc-config.md)。

### 4.1 配布

| 項目 | 決定 |
| --- | --- |
| 言語 | TypeScript。Node.js 22 以上で動く |
| 配布 | npm の `<brand>`。計画ごとに `devDependencies` に入れ、`npx <brand>` で使う（版を計画ごとに固定する） |
| workerd | `@<brand>/workerd-<os>-<arch>`（linux-x64・linux-arm64・darwin-x64・darwin-arm64・win32-x64）を任意の依存として入れる。中身は本番と同じ下流の workerd のビルド（[runtime-and-isolates.md](runtime-and-isolates.md) の 4 節） |
| 署名 | npm の provenance（Sigstore）。workerd のバイナリは SHA-256 を CLI のパッケージに書き、起動時に照合する。macOS のバイナリは公証する |
| ライセンスの表示 | workerd（Apache-2.0）、V8、ICU などの NOTICE を `THIRD_PARTY_NOTICES` にまとめ、`<brand> --licenses` で表示する。十分かは法務の確認待ち（[intent.md](../intent.md) の L6） |
| 更新の知らせ | 1 日 1 回、新しい版を知らせる。自動では更新しない |

- CLI の版と、同梱する workerd の版の対応は、`runtime_releases` の `active` の版を CLI のビルドのときに固定する。本番のランタイムは週 1 回上がるので、CLI も週 1 回出す。
- 同梱の workerd が支える互換の日付の最大値より新しい日付が設定にあれば、`dev` は「CLI を更新してください」で止める。`deploy` は止めない（本番の判定に任せる）。

### 4.2 コマンド

| コマンド | 中身 | 管理 API（[dashboard-and-api.md](dashboard-and-api.md)） |
| --- | --- | --- |
| `<brand> login` / `logout` / `whoami` | 4.3 節 | OAuth |
| `<brand> init [dir]` | 雛形（`src/index.ts`、`<brand>.jsonc`、`tsconfig.json`、`.gitignore`、`package.json`）。互換の日付に当日（JST）を書く。`.dev.vars` を `.gitignore` に足す | — |
| `<brand> dev` | ローカル開発（6 節） | 遠隔のバインディングを使うときだけ |
| `<brand> deploy` | バンドル → 版の作成 → 100% のデプロイ → 伝搬の待ち（4.4 節） | `POST .../versions`、`POST .../deployments` |
| `<brand> versions upload` | 版だけを作る（`--message`、`--tag`） | `POST .../versions` |
| `<brand> versions list` / `view <id>` | 直近 100 の版 | `GET .../versions` |
| `<brand> versions deploy <A>@<p>% [<B>@<q>%]` | 段階的なデプロイ。合計 100%。0.01% 刻み | `POST .../deployments` |
| `<brand> deployments list` | 直近のデプロイ | `GET .../deployments` |
| `<brand> rollback [<version_id>]` | 指定の版（省略時は 1 つ前の版）を 100% にする新しいデプロイ。**戻す前に「シークレットの値も戻る」「ストレージの中身は戻らない」を示し、確かめる** | `POST .../deployments`（`reason=rollback`） |
| `<brand> secret put <NAME>` / `delete` / `list` / `bulk <file>` | 値は標準入力から読む（引数に値を取らない。シェルの履歴に残さない）。既定で新しい版を作り 100% にする。段階的なデプロイ中の関数では `--version-only` を求める | `PUT .../secrets/{name}` |
| `<brand> tail [<script>]` | 7 節 | `POST .../tails` |
| `<brand> logs query` | 保存したログの検索（8 節） | `POST .../logs/query` |
| `<brand> types` | 型の生成（9 節） | — |
| `<brand> kv ...`、`<brand> buckets ...`、`<brand> queues ...` | 資源の作成・一覧・削除と、動作の確認のための読み書き | 各資源の API |
| `<brand> check` | 設定の検証、バンドルの大きさ、`request.cf` の lint、互換の日付の確認。デプロイしない | — |

- 出力は人向け（既定）と `--json`。`--json` は 1 行 1 つの JSON（`tail` と `logs` は JSON Lines）。
- 終了コード：成功 0、利用者の誤り（設定、引数、検証の失敗）2、サーバーの誤り 3、認証・権限の誤り 4、制限の超過（大きさ、数）5。
- 対話の確認（`rollback`、`secret delete`、資源の削除）は、端末でなければ（CI）`--yes` を求める。

### 4.3 ログインと資格

| 場面 | 方式 |
| --- | --- |
| 手元（ブラウザあり） | OAuth 2.0 の認可コード＋PKCE。戻り先は `http://127.0.0.1:<空きポート>/callback`（RFC 8252 のループバック）。アクセストークン 1 時間、リフレッシュトークン 30 日 |
| 手元（SSH の先など、ブラウザなし） | `<brand> login --device`：デバイスの認可のフロー（RFC 8628） |
| CI | 環境変数 `<BRAND>_API_TOKEN`（アカウントの API トークン、[dashboard-and-api.md](dashboard-and-api.md) の 6 節）と `<BRAND>_ACCOUNT_ID` |

- トークンは OS のキーチェーン（macOS Keychain、Windows の資格情報マネージャー、Linux の Secret Service）に置く。使えない環境だけ `~/.config/<brand>/auth.json`（0600）に置き、警告を出す。
- CLI のログインで得るトークンの権限は、その利用者のロールと同じ（スコープで絞らない）。CI では、スコープを絞った API トークンを使うよう文書で勧める。

### 4.4 `deploy` の流れ

```
<brand> deploy [--env staging]
 1. <brand>.jsonc を読み、Zod のスキーマで検証（5 節）。env を解決する
 2. バンドル：esbuild（ESM、target は同梱の workerd の V8 に合わせる）
      - nodejs_compat が有効なら、unenv の polyfill を足す（ADR-0015）
      - Wasm・テキスト・データのモジュールを manifest に並べる
      - lint：request.cf の参照、eval / new Function（本番で例外になる）を警告
 3. 手元の検査：大きさの上限（limits-and-billing の 3 節）を超えたら、ここで止める
 4. POST /v1/accounts/{a}/scripts/{name}/versions（multipart：manifest、modules、config）
      Idempotency-Key：バンドルの SHA-256 ＋ 設定の SHA-256 から作る（再送で版を 2 つ作らない）
 5. 版の状態を待つ：validating → distributing → ready（失敗なら検証の誤りを行つきで表示）
 6. POST .../deployments {versions:[{version_id, percentage:100}]}
 7. 伝搬を待つ（既定。--no-wait で省く）：GET .../deployments/{id}/propagation を 1 秒ごと
      リージョンごとの適用を表示し、全リージョンで適用、または 60 秒で終える
 8. 表示：URL、version_id、number、startup_time_ms、圧縮前後の大きさと上限との比
```

- **版とデプロイの時間の目安**（K4 の 5 分の内訳。未検証。E6 の `k4-e2e` で計る）：`init` と依存の導入 90 秒、ログイン 30 秒、最初の `deploy` 30 秒（バンドル 2 秒、検証 5 秒、5 リージョンへの置き 3 秒、伝搬 p99 30 秒）。
- **設定と遠隔の差**：いまのデプロイの版の `source` が `dashboard`・`api` で、その版のバインディング・変数・互換の設定が手元の設定と違えば、差を表示する。端末では確かめ、CI では `--allow-drift` がなければ終了コード 2 で止める（本家は設定ファイルを正本とするよう勧め、ダッシュボードで変えた変数とルートを次のデプロイで上書きする。変数は `keep_vars = true` で残せる。[Configuration の Source of truth](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth)、2026-09-27 に確認。この基盤は黙って上書きせず、差を示して止める）。
- **ソースマップ**：`upload_source_maps: true` のとき、ソースマップを版と一緒に送る。isolate には渡さず、ログの例外のスタックを戻すときだけ使う（8 節）。

## 5. 設定ファイル

[ADR-0035](../decisions/0035-cli-and-single-jsonc-config.md)。

### 5.1 形

- 名前は `<brand>.jsonc`。JSON にコメントと末尾のカンマを許す形。TOML・YAML は受け付けない。
- JSON Schema を `https://schema.<console-domain>/config/v1.json` に公開し、`$schema` でエディターの補完を効かせる。CLI の検証は同じスキーマから作った Zod を使う。

```jsonc
{
  "$schema": "https://schema.<console-domain>/config/v1.json",
  "name": "api-gateway",                    // [a-z0-9-]{1,63}
  "main": "src/index.ts",
  "compatibility_date": "2026-09-27",       // required (ADR-0008)
  "compatibility_flags": ["nodejs_compat"],
  "account_id": "8c1f…",                   // optional; else from login
  "subdomain": true,                        // <name>.<account>.<brand>.<domain>
  "routes": [
    { "pattern": "api.example.jp/*", "hostname": "api.example.jp" }
  ],
  "vars": { "LOG_LEVEL": "info" },          // <= 5KB each
  "kv_namespaces": [{ "binding": "CONFIG", "id": "kvn_…", "remote": false }],
  "buckets": [{ "binding": "ASSETS", "bucket_name": "assets" }],
  "durable_objects": { "bindings": [{ "name": "ROOM", "class_name": "Room" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }],
  "queues": {
    "producers": [{ "binding": "JOBS", "queue": "jobs" }],
    "consumers": [{ "queue": "jobs", "max_batch_size": 10, "max_retries": 3, "dead_letter_queue": "jobs-dlq" }]
  },
  "services": [{ "binding": "AUTH", "service": "auth-worker" }],
  "triggers": { "crons": ["0 */6 * * *"] },  // evaluated in UTC (queues-and-cron)
  "limits": { "cpu_ms": 50, "subrequests": 100 },  // <= plan limits
  "observability": {
    "logs": { "enabled": true, "head_sampling_rate": 1, "invocation_logs": true,
              "redact_headers": ["x-internal-token"] }
  },
  "upload_source_maps": true,
  "env": {
    "staging": {
      "name": "api-gateway-staging",
      "routes": [],
      "vars": { "LOG_LEVEL": "debug" },
      "kv_namespaces": [{ "binding": "CONFIG", "id": "kvn_…" }]
    }
  }
}
```

### 5.2 規則

| 規則 | 内容 |
| --- | --- |
| 必須 | `name`、`main`、`compatibility_date`（本家と同じ 3 つ） |
| 環境の受け継ぎ | 本家と同じ。`compatibility_*`・`main`・`limits`・`observability` などは上から受け継ぐ。バインディング（`vars`・`kv_namespaces`・`buckets`・`durable_objects`・`queues`・`services`）と `routes`・`triggers` は受け継がず、環境ごとに書く。書かなければ空 |
| 知らないキー | 誤りにする（綴りの誤りで設定が黙って効かないことを防ぐ）。`--compat-unknown-keys` で警告に下げられる |
| 秘密 | 設定ファイルに置かない。`vars` に `secret`・`token`・`password`・`key` を含む名前があれば警告する |
| 本家の設定の名前 | 本家の設定ファイルを読み込む変換（`<brand> migrate-config`）は持たない（intent の Non-goals）。キーの名前は本家に寄せ、移しやすくする |
| 版への写し | 設定ファイルそのものは版に入れない。解決したバインディング（資源の ID）、互換の設定、`limits`、`observability` を版の列に入れ、`config_sha256` を版のメタデータに残す |
| `limits` | 計画の上限以下（[limits-and-billing.md](limits-and-billing.md) の 3 節）。上限を超える値は、CLI と API の両方で拒否する |

## 6. ローカル開発

[ADR-0036](../decisions/0036-local-dev-on-downstream-workerd.md)。

### 6.1 構成

```
<brand> dev
 ├─ esbuild（watch）……変更でバンドルを作り直す
 ├─ 開発サーバー（Node.js、CLI の中）
 │    ├─ http://localhost:8787 で受ける（--port、--ip）
 │    ├─ request.<brand> の模擬の値を足す（country=JP、colo=local など。--geo で変える）
 │    ├─ ライブリロード、/__scheduled?cron=… で cron を起こす
 │    └─ 外向きの通信の観察（6.5 節の警告）
 └─ workerd（同梱の下流のビルド。1 つのプロセス）
      ├─ 利用者の関数（設定の互換の日付とフラグ）
      ├─ 模擬のサービス（TypeScript の Worker として同じ workerd の中で動く）
      │    ├─ kv-sim       …… Durable Object の SQLite の上に KV の API
      │    ├─ bucket-sim   …… メタデータは SQLite、本体は .<brand>/state/buckets/ のファイル
      │    ├─ queue-sim    …… SQLite の表。consumer を max_batch_timeout で呼ぶ
      │    └─ remote-proxy …… remote: true のバインディングを管理 API の口へ中継する
      └─ Durable Objects …… workerd の Durable Objects を手元のディスク（SQLite）で動かす
```

- 模擬の保存先は `.<brand>/state/`（`--persist-to` で変える）。`init` で `.gitignore` に足す。`--no-persist` でメモリだけにする。
- Durable Objects は workerd 自身が手元のディスクで動かせる（本家の Miniflare と同じ考え）。上流の設定は `durableObjectStorage` の `localDisk`（`DiskDirectory` のサービスの名前）で、クラスごとの `uniqueKey` のディレクトリに実体ごとの `.sqlite` を置く。上流は「実験。互換を崩す変更がありうる」としている（[workerd.capnp](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)、2026-09-27 に確認）。形の変更は週 1 回の取り込みの CI で検知する。
- 模擬のサービスは、本番のバインディングと同じ JavaScript の API を持つ。API の形の元は、本番のバインディングの型（9 節）と同じ定義にする。

### 6.2 シークレットと変数

- `.dev.vars`（`KEY=value` の形）か `.env` を読み、`vars` と同じくバインディングにする。`--env staging` なら `.dev.vars.staging` を先に読む。
- 本番のシークレットの値は、手元に取り寄せない（管理 API は値を返さない。[deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 8.1 節）。

### 6.3 本物の資源へのつなぎ込み

| バインディング | `remote: true` | 理由 |
| --- | --- | --- |
| KV、オブジェクトストレージ | できる | 本番のデータで試す需要がある |
| キュー（producer） | できる | 送るだけ。consumer は手元で動かさない |
| サービス（他の関数） | できる | 本番のいまのデプロイを呼ぶ |
| Durable Objects | できない | 1 つの名前に 1 つの実体の約束（ADR-0005）を、手元の実体と本番の実体で破る |
| 環境変数・シークレット・版のメタデータ | できない | 値を手元に出さない |

- つなぎ込みは、`remote-proxy` が管理 API の資源の口（`/v1/accounts/{a}/kv/namespaces/{id}/values/...` など）を、ログインのトークンで呼ぶ。エッジのノードを通らない。
- 起動時に、本物の資源に書き込むことと、操作が課金されることを表示する（本家と同じ注意）。本番の資源の書き込みは、監査ログに `client = cli_dev` で残る（[dashboard-and-api.md](dashboard-and-api.md) の 7 節）。

### 6.4 テスト

- `@<brand>/vitest-pool`：Vitest のテストを、同梱の workerd の中で、模擬のサービスと一緒に動かす（本家の Vitest の統合と同じ考え。E6 の後半）。テストごとに模擬の保存を分ける。
- `<brand> dev` の模擬と、`vitest-pool` の模擬は同じ実装を使う。

### 6.5 本番との差

| 項目 | 本番 | 手元 | 手元での扱い |
| --- | --- | --- | --- |
| ランタイム | 下流の workerd | 同じビルド（CLI が固定した版） | 本番は週 1 回上がる。版の差を `dev` の起動時に表示 |
| CPU 時間・メモリの上限 | 強制（ADR-0009） | 強制しない | 1 要求ごとの CPU 時間を測り、計画の上限を超えたら警告する。`--enforce-limits` で強制する（手元の機械の速さで結果が変わる） |
| 外向きの宛先 | 私的なアドレス・内部の範囲を拒否（ADR-0010） | 通す（手元の API を試すため） | 拒否の範囲（[sandbox-and-security.md](sandbox-and-security.md) の 7.1 節）に当たる宛先には「本番では拒否される」と警告する |
| サブリクエストの数 | 外向きのプロキシが数えて止める | 数えて警告 | `--enforce-limits` で止める |
| 時計・スレッド | 止めた時計、スレッドなし | 時計は実行中も進む（上流の単体の workerd の振る舞い。止めた時計は本番のパッチだけ。[sandbox-and-security.md](sandbox-and-security.md) の 6.1 節）。スレッドなしは同じ | 本家と同じ差（本家の文書も「ローカル開発ではタイマーが進む」）。CLI の文書に書く |
| KV の一貫性 | 結果整合（最大 `cacheTtl` の古さ） | 強い整合 | 起動時に表示する。古さを試す `--kv-stale-ms` は持たない（S1） |
| オブジェクトストレージ | ホームのリージョンで強い整合 | 強い整合 | 差なし |
| Durable Objects | 1 つの名前に 1 つの実体、配置 | 1 プロセスの中に 1 つ | 配置・移動・障害は試せない |
| `request.<brand>` | 入口のプロキシが付ける | 模擬の値 | `--geo` で国などを変える |
| `<Brand>-Worker` のヘッダー | 付く | 付ける（同じ値の形） | 差なし |
| 実行時のコードの生成 | 例外 | 例外（同じ workerd） | 差なし |

## 7. `tail`（リアルタイムのログ）

[ADR-0037](../decisions/0037-tail-sessions-and-tenant-logs.md)。

### 7.1 流れ

```
CLI・ダッシュボード       制御プレーン（東京）               エッジのノード               リージョンの tail 中継      tail ハブ（東京）
 │ POST .../scripts/{s}/tails {filters, sampling_rate}
 │───────────────────────▶│ 権限 logs:tail、同時のセッション ≤ 10
 │                         │ tail_sessions に行、config_outbox に tail/<script_id>（優先）
 │◀── {id, url: wss://tail.<console-domain>/v1/tails/{id}, ticket, expires_at(+1h)}
 │ WebSocket（Sec-WebSocket-Protocol: <brand>-tail.v1, ticket.<t>）──────────────────────────────────────────────▶│
 │                         │                                 │ LMDB に tail/<script_id> が届く（p99 10 秒）
 │                         │                                 │ 呼び出しの終わりに：
 │                         │                                 │  1. 絞り込み（ノードで）
 │                         │                                 │  2. 標本（sampling_rate）
 │                         │                                 │  3. 伏せる（7.3 節）
 │                         │                                 │──── TailEvent（gRPC）──▶│ セッションごとに束ねる
 │                         │                                 │                           │──────────────────▶│
 │◀──────────────────────────────────────────────────── JSON（1 メッセージ 1 イベント）───────────────────────│
```

- **セッションの印は変更のログで配る。** ノードは、いま `tail` のある関数だけイベントを作る。`tail` のない関数には費用をかけない。印の値は `[{session_id, filters, sampling_rate, expires_at, region_hub}]`。
- **ticket** は 1 回だけ使える 60 秒の乱数。WebSocket の URL に入れない（プロキシのログに残るため）。ブラウザは WebSocket に `Authorization` のヘッダーを付けられないので、副プロトコルの値で渡す。
- **有効期間**：1 時間。CLI は切れる 5 分前に新しいセッションを作り、つなぎ替える（利用者には切れ目を見せない。重なる間は同じイベントを 2 回受けうるので、`event_id` で重複を捨てる）。WebSocket が 60 秒切れたら、ハブはセッションを閉じ、印を消す。
- **tail ハブ**は東京の ECS。セッションの持ち主のハブの番号を印に入れ、中継はそのハブへ送る。ハブが落ちたら、CLI はセッションを作り直す（取りこぼしは許す。`tail` は最善の努力で、保存するログ（8 節）が正本）。

### 7.2 イベントの形

```jsonc
{
  "event_id": "01J…",                 // ULID; used to drop duplicates
  "session_id": "tl_…",
  "script": "api-gateway", "version_id": "…", "deployment_id": "…",
  "ray": "8f3a…-NRT",                  // <Brand>-Ray
  "event_ts": "2026-09-27T01:02:03.456Z",
  "trigger": "fetch",                  // fetch | scheduled | queue | alarm | websocket
  "outcome": "ok",                     // runtime-and-isolates 6.3
  "cpu_ms": 1.8, "wall_ms": 42,
  "request": { "method": "GET", "url": "https://api.example.jp/v1/items?token=[REDACTED]",
               "headers": { "authorization": "[REDACTED]", "user-agent": "…" },
               "brand": { "country": "JP", "colo": "NRT", "asn": 2516 } },
  "response": { "status": 200 },
  "logs": [ { "level": "log", "ts": "…", "message": ["fetched", 3] } ],
  "exceptions": [ { "name": "TypeError", "message": "…", "stack": "…" } ],
  "subrequests": [ { "host": "origin.example.jp", "status": 200, "ms": 31 } ],
  "truncated": false                   // true when logs exceeded 256KB
}
```

- 本文（要求・応答の body）は入れない。
- 絞り込み：`status`（`ok`・`error`・`canceled`）、`method`、`header`（名前と値）、`search`（`console` の文字列の部分一致）、`ip`（利用者の IP。`self` は CLI の送り元の IP）、`version_id`、`sampling_rate`（0〜1）。

### 7.3 伏せる

伏せるのは、イベントを作るノードのスーパーバイザーで行う。制御プレーン・中継・ハブには、伏せた後のものしか届かない。

| 対象 | 規則 |
| --- | --- |
| ヘッダー | `authorization`、`proxy-authorization`、`cookie`、`set-cookie` の値は常に `[REDACTED]`。利用者は外せない。`observability.logs.redact_headers` で足せる |
| クエリの値 | 名前が `token`・`key`・`secret`・`password`・`sig`・`signature`・`code`・`auth` を含むものの値 |
| シークレットの値 | その版の `secret` のバインディングの平文のうち 8 バイト以上のものが、`console` の出力・例外の文・URL・ヘッダーに現れたら `[REDACTED:<NAME>]` に置き換える。スーパーバイザーは平文を持つ（[deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 8.2 節）ので、Aho–Corasick で探す。置き換えた後の文字列だけを外に出す |
| 大きさ | 1 呼び出しの `logs` と `exceptions` の合計 256KB（本家と同じ）。超えたら後ろを捨て、`truncated: true` |

- シークレットの値の置き換えは、Base64 などに変えた形までは見つけない。文書で示す。
- 伏せる処理はイベントを作るときだけ行い、isolate の中の値は変えない。

### 7.4 量の制御

| 段 | 上限（S1） | 超えたら |
| --- | --- | --- |
| 関数ごとの同時のセッション | 10（本家と同じ） | 409 `too_many_tail_sessions` |
| ノード × 関数 | 50 イベント/秒 | 標本に落とし、捨てた数を数える |
| セッション（ハブ） | 100 イベント/秒、1MB/秒 | 捨てる。1 秒ごとに `{"type":"sampling","dropped":N}` を送り、CLI は警告を出す |
| WebSocket の送りの詰まり | ハブの送りの待ちが 4MB | 古いイベントから捨てる |

## 8. 保存するログとトレース

[ADR-0037](../decisions/0037-tail-sessions-and-tenant-logs.md)。この節は**利用者のログ**（利用者が見る、利用者のデータを含むもの）を持つ。基盤の運用のログ・メトリクス・トレースは [observability.md](observability.md) が持ち、置き場所と見る人を分ける（observability の 3 節の表）。

### 8.1 経路と保存

```
スーパーバイザー（7.3 節と同じ伏せ方）──▶ ノードのログの送り手（Vector）
   ──▶ リージョンの Kinesis Data Streams ──▶ 東京の取り込み（ECS）──▶ ClickHouse（東京、3 つの AZ）
                                                                   └─▶ S3（Parquet。取り込みの失敗の再送用、7 日）
```

- `observability.logs.enabled` の関数だけ保存する。`head_sampling_rate`（0〜1、既定 1）で、呼び出しの単位で保存するかを決める（ノードで、`<Brand>-Ray` のハッシュで決定的に）。
- 保持：有料 7 日、無料 3 日（本家と同じ）。ClickHouse の TTL で消す。
- 件数の上限と課金は [limits-and-billing.md](limits-and-billing.md) の 3 節・5 節。アカウントの 1 日の上限を超えたら、その日の残りを 1% の標本にする（本家と同じ形。値は 3 節）。
- 海外のリージョンのログも東京に集める。国外の利用者の個人データを東京に置くことになる（関係する法令の整理は法務の確認待ち。[intent.md](../intent.md) の L2・L7）。

```sql
CREATE TABLE tenant_logs (
  account_id      UUID,
  script_id       UUID,
  version_id      UUID,
  ts              DateTime64(3, 'UTC'),
  ray             String,
  trigger         LowCardinality(String),
  outcome         LowCardinality(String),
  status          UInt16,
  method          LowCardinality(String),
  url             String,            -- redacted
  client_ip       IPv6,
  country         LowCardinality(String),
  cpu_us          UInt32,
  wall_ms         UInt32,
  logs            String,            -- JSON, redacted, <= 256KB with exceptions
  exceptions      String,
  spans           String,            -- JSON array (8.3)
  plan_retention_days UInt8          -- 3 or 7
) ENGINE = ReplicatedMergeTree
PARTITION BY toDate(ts)
ORDER BY (account_id, script_id, ts)
TTL toDateTime(ts) + toIntervalDay(plan_retention_days);
-- Row policy: every query runs as the log-query role with account_id = {account} injected by the service.
```

- **データの量の見込み**（未検証。E6 の `tenant-logs` で計る）：S1 の平均 2 万件/秒（[capacity.md](capacity.md) の 1 節）のうち、保存を有効にした関数を半分と仮定して 1 万件/秒 × 1KB で 1 日約 860GB、圧縮で約 90GB、7 日で約 630GB。
- ClickHouse を自前で運用するか、AWS の東京で動くマネージドの ClickHouse を使うかは、E6 の PoC で決める（14 節）。

### 8.2 検索

- `POST /v1/accounts/{a}/logs/query`：構造化の問い合わせだけを受ける（利用者の SQL を受けない）。

```jsonc
{
  "from": "2026-09-27T00:00:00Z", "to": "2026-09-27T01:00:00Z",   // <= 7 days, within retention
  "scripts": ["api-gateway"],
  "filters": [ { "field": "outcome", "op": "eq", "value": "exception" },
               { "field": "status", "op": "gte", "value": 500 } ],
  "search": "timeout",               // substring on logs / exceptions
  "ray": null,
  "limit": 100,                      // max 1000
  "cursor": null,
  "aggregate": null                  // or {"count_by": "outcome", "interval": "5m"}
}
```

- 問い合わせのサービスは、`account_id` の条件を必ず足し、ClickHouse の行の方針も重ねる（2 重）。
- 1 回の問い合わせは 10 秒で止める。アカウントあたり同時 5 つ。
- 例外のスタックは、版にソースマップがあれば、問い合わせのときに元のファイルと行に戻して返す。

### 8.3 トレース

- 保存するログの各呼び出しに、自動で `spans` を付ける：サブリクエスト（宛先のホスト、メソッド、状態、時間、送受の大きさ）と、バインディングの呼び出し（種類、操作、時間、結果）。外向きのプロキシが測った値を、呼び出しの ID で呼び出しの記録に合わせる。本文・キーの値は入れない（KV のキーは、名前を伏せずに入れるかを 14 節で問う）。
- 利用者のコードで範囲を作る API（OpenTelemetry の SDK）と、利用者の送り先への OTLP の書き出しは S2 にする（本家は OpenTelemetry での書き出しを持つ）。
- Tail Workers に当たる機能（ログを別の関数で受ける）は S2 にする。

### 8.4 見る権限と、運用者の閲覧

- `logs:tail`・`logs:read` の権限（[dashboard-and-api.md](dashboard-and-api.md) の 5 節）を持つ人とトークンだけが見られる。既定では `owner`・`admin`・`developer` が持つ。
- 基盤の運用者は、利用者のログを既定で見られない。サポートの調査で見るときは、利用者の同意（チケットでの明示）と 2 人の承認で、期限付き（24 時間）の閲覧の権限を得る。閲覧は監査ログに残し、利用者の監査ログにも `actor=platform_support` で見せる。
- ログの中の要求の内容は、関数の利用者（エンドユーザー）の通信である。保存・閲覧の扱いが通信の秘密の上でどう位置づくかは法務の確認待ち（[intent.md](../intent.md) の L2。**E6 の tail とログの保存の spec の承認を止める**）。

## 9. 型の生成

- `<brand> types` が 2 つを作る。
  1. `worker-env.d.ts`：設定ファイル（`--env` で選ぶ環境）のバインディングから `interface Env { CONFIG: KVNamespace; ASSETS: Bucket; ROOM: DurableObjectNamespace<Room>; … }`。`vars` は値の型（文字列の文字どおりの型）にする。シークレットは `.dev.vars` の名前から `string` にする。
  2. ランタイムの API の型：設定の互換の日付とフラグに合う型を、`@<brand>/runtime-types` から選んで参照する。
- `@<brand>/runtime-types` は、下流の workerd のビルドで、上流の `types/`（JSG の RTTI から型を作る仕組み）で作り、ランタイムの版ごとに npm に出す。**上流が作る入口は「最新」と「実験」の 2 つだけ**で、日付ごとの入口はない（上流の `types/scripts/build-types.ts`。本家の `@cloudflare/workers-types` も v5 で日付ごとの入口をなくした。[TypeScript](https://developers.cloudflare.com/workers/languages/typescript/)、2026-09-27 に確認）。
- そのため、**互換の日付とフラグに合う型は `types` のコマンドが手元で作る**（本家の `wrangler types` と同じ考え）。CLI が同梱した workerd で上流の型の生成の仕組み（`/<互換の日付>.bundle` を返す Worker）を動かし、設定の日付とフラグの型を `worker-env.d.ts` の隣に書く。npm の `@<brand>/runtime-types` は、ライブラリの作者向けの最新・実験の型に使う。
- 本家の名前を含む型の名前（`request.cf` の型など）は、`brand` のパッチ（[runtime-and-isolates.md](runtime-and-isolates.md) の 4.2 節）と同じ置き換えを型にも当てる。
- `<brand> dev` と `<brand> deploy` は、`worker-env.d.ts` が設定と合わなければ警告する（生成し直しを促す）。

## 10. 障害の型

| 障害 | 検知 | 振る舞い |
| --- | --- | --- |
| 版の検証の失敗 | 版の `failed` | 検証の誤りをファイル・行つきで表示。終了コード 2 |
| 5 リージョンへの置きが遅い（`pending_regions`） | 版の状態 | `ready` で進む。CLI は「一部のリージョンで最初の要求が遅い」と表示 |
| 伝搬が 60 秒で終わらない | 伝搬の API | デプロイは成立している。遅いリージョンを表示して終了コード 0。`--strict-propagation` で 3 |
| 管理 API の障害 | 5xx、時間切れ | 冪等キーで 3 回まで再試行（1・2・4 秒）。それでも失敗すれば 3 |
| tail の印が届かない（配信の停止） | 30 秒イベントが来ない | CLI は「イベントがない、または配信が遅れている」と表示し続ける。配信の元の状態は状態の頁で示す |
| tail ハブの停止 | WebSocket の切断 | CLI は 1・2・4・8 秒でセッションを作り直す |
| ClickHouse の取り込みの遅れ | Kinesis の遅れ（`IteratorAge`） | 5 分で警報。ログの検索は「最新の N 分は未反映」と応答に付ける |
| ClickHouse の停止 | 問い合わせの失敗 | 検索は 503。取り込みは Kinesis（24 時間）と S3 に溜め、回復後に入れ直す |
| 手元の workerd がない・壊れている | 起動時の SHA-256 の照合 | 入れ直しを促す |

## 11. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| CLI の供給網（npm の乗っ取り、workerd のバイナリの差し替え） | npm の provenance、発行は CI の OIDC だけ（人の手で発行しない）、2 人の承認。workerd のバイナリの SHA-256 をパッケージに書き、起動時に照合 |
| CLI のトークンの漏れ | キーチェーンに置く。リフレッシュトークンは 30 日、使うたびに入れ替える（使い回しを検知したら全て失効）。トークンの接頭辞とチェックサム（[dashboard-and-api.md](dashboard-and-api.md) の 6 節）でシークレットスキャンに載せる |
| シークレットの値の漏れ（シェルの履歴、ログ） | `secret put` は標準入力だけ。ログ・tail は 7.3 節で伏せる |
| tail の ticket の横取り | 1 回だけ、60 秒、URL に入れない。WebSocket は TLS だけ |
| 他のアカウントのログの読み出し | 問い合わせのサービスが `account_id` を足し、ClickHouse の行の方針も重ねる。性質ベーステスト（12 節） |
| 構造化の問い合わせの注入 | 利用者の SQL を受けない。値は束縛の変数で渡す。`search` はリテラルとして扱う |
| ローカル開発のサーバーへの外からの接続 | 既定で `127.0.0.1` だけで待つ。`--ip 0.0.0.0` のときは警告。DNS の再束縛を防ぐため、`Host` が `localhost`・`127.0.0.1`・指定の名前のときだけ受ける |
| 遠隔のバインディングでの誤った本番の書き込み | 起動時の表示、監査ログの `source=cli_dev`、トークンのスコープで書き込みを外せる |

- tail とログの経路、伏せる処理、問い合わせのサービスの変更は `security:sensitive` にする（テナントの分離とシークレットに触れる。[AGENTS.md](../../AGENTS.md)）。
- イベントの形・問い合わせの形の解析はファズの対象にする。

## 12. テスト

| 種類 | 対象 | 確かめること |
| --- | --- | --- |
| 表駆動 | 設定ファイルの検証 | 必須のキー、知らないキー、環境の受け継ぎ（受け継ぐキーと受け継がないキー）、`limits` の上限、`vars` の秘密らしい名前の警告 |
| 表駆動 | 伏せる | 各ヘッダー、クエリの名前、シークレットの値（8 バイトちょうど・7 バイト、URL・例外・`console` の中）、256KB の切り詰め |
| 性質ベース | 伏せる | 任意のシークレットの値と、それを含む任意のログの文字列で、外に出る文字列にその値が現れない（8 バイト以上） |
| 性質ベース | ログの分離 | 任意のアカウントの組と問い合わせで、他のアカウントの行が返らない |
| 性質ベース | 標本 | `head_sampling_rate` が p のとき、保存の割合が p に近く、同じ `<Brand>-Ray` は常に同じ判定 |
| 結合 | `deploy` | 冪等キーでの再送が版を 2 つ作らない。検証の失敗の表示。伝搬の待ち |
| 結合 | `rollback` | 確認の表示（シークレット、ストレージ）。戻せない条件の誤りの表示 |
| 結合 | tail | 印の配信から 10 秒以内にイベントが届く。10 を超えるセッションが 409。1 時間の切り替えで重複を捨てる。上限を超えると `sampling` の知らせ |
| 結合 | ローカル開発 | 模擬の KV・オブジェクト・キュー・Durable Objects の API が本番の型と合う。拒否の範囲の宛先で警告。`--enforce-limits` で CPU の上限で止まる |
| 契約 | 模擬と本番 | 同じテストの集まりを、模擬のサービスと本番のステージングのバインディングの両方に回し、結果が同じ（KV の古さを除く） |
| E2E | K4 | 新しい機械で、`npm create`・`login`・`deploy` から公開の URL の応答までを計り、5 分以内（毎週、ステージング） |
| ファズ | イベントの形、問い合わせの形、設定ファイルの解析 | AGENTS.md の「ファズを止めない」 |

テスト名には要件 ID（開発リポジトリの `REQ-TOOLING-*`・`PROP-TOOLING-*`）を含める。

## 13. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0035](../decisions/0035-cli-and-single-jsonc-config.md) | CLI は TypeScript で npm に配り、同梱の下流の workerd の版を固定する。設定ファイルは `<brand>.jsonc` の 1 つの形。ログインは PKCE とループバック（デバイスのフローを予備）、CI は API トークン |
| [0036](../decisions/0036-local-dev-on-downstream-workerd.md) | ローカル開発は同梱の下流の workerd で動かし、ストレージは同じ workerd の中の模擬のサービスで模す。本物の資源へは、バインディングごとの `remote: true` だけでつなぐ。制限の強制は既定で警告にとどめる |
| [0037](../decisions/0037-tail-sessions-and-tenant-logs.md) | `tail` のセッションの印を変更のログで配り、ノード → リージョンの中継 → 東京のハブ → WebSocket で届ける。伏せる処理はノードのスーパーバイザーで行う。保存するログは ClickHouse に有料 7 日・無料 3 日 |

## 14. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E6 | CLI の骨格（コマンドの解析、出力の形、終了コード、更新の知らせ） |
| E6 | `login`（PKCE とループバック、デバイスのフロー、キーチェーン） |
| E6 | 設定ファイルの JSON Schema と Zod、環境の受け継ぎ、`check` |
| E6 | バンドル（esbuild、unenv の polyfill、`request.cf` の lint、大きさの手元の検査） |
| E6 | `deploy`・`versions`・`deployments`・`rollback`（冪等キー、伝搬の待ち、差の表示） |
| E6 | `secret put`・`bulk`（標準入力、`--version-only`） |
| E6 | `@<brand>/workerd-*` のバイナリの配布と SHA-256 の照合、`THIRD_PARTY_NOTICES` |
| E6 | `dev`：開発サーバー、ライブリロード、`request.<brand>` の模擬、`/__scheduled` |
| E6 | 模擬のサービス（kv-sim、bucket-sim、queue-sim）と Durable Objects の手元の保存（PoC を最初に） |
| E6 | 遠隔のバインディング（`remote-proxy`） |
| E6 | 本番との差の警告（宛先の拒否の範囲、CPU 時間、サブリクエストの数）と `--enforce-limits` |
| E6 | `types` と `@<brand>/runtime-types` の生成・公開 |
| E6 | tail：セッションの API、印の器 `tail/`、ノードのイベントの作成と伏せる処理、リージョンの中継、東京のハブ、CLI とダッシュボードの表示 |
| E6 | 保存するログ：Vector、Kinesis、取り込み、ClickHouse（PoC で運用の形を決める）、問い合わせの API、ソースマップの戻し |
| E6 | 呼び出しのトレース（サブリクエストとバインディングの `spans`） |
| E6 | 運用者の期限付きのログの閲覧（2 人の承認、監査ログ） |
| E6 | `@<brand>/vitest-pool`（後半） |
| E6 | K4 の E2E の計測（毎週） |
| E5 | 版に `config_sha256` と `source` を残す（deployment-and-config-distribution と合わせて） |
| E11 | ログの件数の計測と課金（limits-and-billing と合わせて） |
| E12 | npm の発行の手順（CI の OIDC、2 人の承認）と、L6 の表示の確定 |

## 15. 未解決の問い

- ClickHouse を自前で EC2 に置くか、AWS の東京のマネージドの ClickHouse を使うか。
- KV のキーの名前などを `spans` に伏せずに入れてよいか（利用者のデータが入りうる）。
- ログの中の要求の内容の扱い（通信の秘密）。保存・利用者への提供・運用者の閲覧の条件（L2）。
- CLI に同梱する workerd と NOTICE の表示で足りるか（L6）。
- 手元で CPU 時間の上限を既定で強制するか（手元の機械の速さの差と、本番での驚きの釣り合い）。
- Tail Workers と OTLP の書き出しを S1 で持つか。
- `tail` の 1 セッション 100 イベント/秒は足りるか。
- 本家の設定ファイルからの変換の道具を持つか。

### 決定

2026-09-27 の既定案。

- ClickHouse は E6 の PoC で両方を比べ、S1 の量（1 日約 90GB の圧縮後）で費用と運用の手間の小さい方を選ぶ。PoC の前は、マネージドを第一の候補にする（小さなチームで運用を減らす）。
- `spans` にはキーの名前を入れない。操作の種類・時間・結果・大きさだけにする。要望を見て、利用者が有効にする設定を S2 で足す。
- L2 の確認が済むまで、E6 の tail とログの保存の spec は承認しない。設計は 8.4 節の条件で進める。
- L6 は `THIRD_PARTY_NOTICES` と `--licenses` を前提に進め、法務の確認で足りなければ足す。
- 手元の CPU 時間の上限は強制せず警告にする。`--enforce-limits` を文書で勧める。
- Tail Workers と OTLP の書き出しは S2。S1 は保存するログと `tail` で賄う。
- 100 イベント/秒は S1 の既定。捨てた数の分布を見て、S2 の前に見直す。
- 本家の設定ファイルからの変換の道具は持たない（intent の Non-goals）。キーの名前を寄せ、移し方の文書を用意する。

## 16. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：ログ・tail からのシークレットの値の漏れ。伏せる処理の性質ベーステストと、本番の探り（既知の偽のシークレットを出す探りの関数で、ログに平文が出ないことを 1 時間ごとに確かめる）。
- リスク：他のアカウントのログの読み出し。問い合わせの 2 重の条件と、性質ベーステスト。
- リスク：手元と本番の差での驚き（宛先の拒否、CPU 時間）。模擬と本番の契約テストと、6.5 節の警告。
- リスク：CLI の供給網。発行の手順と provenance。
- 本番での検証：K4 の E2E（毎週）、tail の到着の遅延（印の配信から最初のイベントまで p99 15 秒）、ログの取り込みの遅延（p99 60 秒）。

**runbooks**

- `tail-hub-down`：tail ハブの停止。セッションの作り直しの確認、中継の送り先の切り替え。
- `tenant-logs-ingest-lag`：Kinesis の遅れ、ClickHouse の取り込みの失敗、S3 からの入れ直し。
- `clickhouse-recovery`：ClickHouse のノードの障害と複製の回復。
- `secret-in-logs-report`：利用者から「ログにシークレットが出た」の申し出。該当の行の削除、伏せる処理の見直し、利用者へのシークレットの入れ替えの案内。
- `cli-release-rollback`：壊れた CLI の版の npm の `deprecate` と、前の版への案内。
- `support-log-access`：運用者の期限付きの閲覧の申請と承認。
- SLI の追加の依頼（Ops へ）：tail の到着の遅延、捨てたイベントの数、ログの取り込みの遅延、問い合わせの p95、CLI の `deploy` の成功率（API の側の数え方）。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `tail_sessions`（制御プレーン） | `account_id`、`id`、`script_id`、`created_by`（利用者またはトークン）、`filters`（jsonb）、`sampling_rate`、`hub_id`、`ticket_hash`、`ticket_used_at`、`expires_at`、`closed_at` | RLS |
| 設定の写しの器 `tail/`（ノードの LMDB） | `script_id` → `[{session_id, filters, sampling_rate, expires_at, hub_id}]` | 優先の印で配る。形は [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 6.3 節に足す |
| `tenant_logs`（ClickHouse） | 8.1 節 | `account_id` の行の方針。TTL 3・7 日 |
| ログの再送用（S3） | `tenant-logs/<region>/<date>/<hour>/*.parquet` | 7 日 |
| `script_versions` に足す列 | `config_sha256`、`source_map_keys` | 表の持ち主は deployment-and-config-distribution |
| `support_log_grants`（制御プレーン） | `id`、`account_id`、`ticket_id`、`granted_to`、`approved_by`（2 人）、`expires_at` | 監査ログに写す |
| 手元の状態（利用者の機械） | `.<brand>/state/`（SQLite、ファイル） | 基盤は持たない |

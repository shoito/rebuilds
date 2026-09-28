# Extensibility: Salesforce

利用者のコード（トリガー）とパッケージの設計。MVP の後の Epic で作る（トリガーは E13、パッケージの配布は E14。[roadmap.md](../roadmap.md)）。TypeScript で書き、JS のエンジンを WASM にしたものを、燃料（命令の数）とメモリーの上限を付けた砂場で動かす。土台は [ADR-0001](../decisions/0001-platform-and-stack.md)（MVP は宣言的な設定だけにし、利用者のコードは MVP の後に WASM の砂場で動かす）。この文書で決めたことは、次の 3 つの ADR にある。

- **エンジンは QuickJS-ng、実行系は Wasmtime。** 燃料で上限を決定的に判定する。砂場は Runtime・Worker のタスクの中の別のコンテナの別のプロセスで動かし、DB・網・秘密を持たせない（[ADR-0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md)）。
- **トリガーは DML の手順 3・7・13 に、フローと並べて置く。** 塊（200 件まで）ごとに 1 回呼び、同じトリガーは同じレコードに 1 トランザクションで 1 回。ホストの API はデータ層の問い合わせと DML の AST だけで、既定は実行する利用者の権限（[ADR-0049](../decisions/0049-triggers-in-dml-order-and-platform-api.md)）。
- **パッケージは名前空間の接頭辞と署名を持つ。** 上限は組織と共有し、名前空間ごとに計測する。コードは秘密を読めない（[ADR-0050](../decisions/0050-packages-namespaces-and-code-isolation.md)）。

本家の振る舞いと部品の事実は、2026-09-28 に確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 利用者のコードの言語・エンジン・実行系 | 宣言的な自動化（[automation-flows.md](automation-flows.md)） |
| トリガーの位置、再帰、呼ぶ単位 | DML の手順そのもの（[metadata-and-runtime.md](metadata-and-runtime.md) の 6 節） |
| ホストの API（プラットフォームの API） | 上限の値の正本（[governor-limits.md](governor-limits.md)） |
| 燃料・メモリーの上限と計測 | 外向きの呼び出しの宛先の検査（[events-and-integrations.md](events-and-integrations.md) の 6 節） |
| パッケージ、名前空間、署名、インストール | メタデータの形式とデプロイ（[sandboxes-and-deploy.md](sandboxes-and-deploy.md)） |
| 砂場の隔離 | ネットワークとアカウント（[infrastructure.md](infrastructure.md)） |

独自の API（利用者のコードで REST の口を作る。本家の Apex REST に相当）、画面の部品のコード、スケジュールで動くコード、利用者のコードのデバッガーは、E13 の後の課題にする（14 節）。

## 2. 本家の仕組みと、部品の事実（確かめたこと）

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| 本家のトリガーの位置 | 保存の前のフロー → before トリガー → 検証 → 保存（未確定）→ after トリガー → …… → 保存の後のフロー。API の要求は 200 件の塊でトリガーを動かす | [ADR-0008](../decisions/0008-dml-order-of-execution.md) に写した [Apex Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_apex_developer_guide.pdf)（Winter '27 版） |
| 本家のコードの文脈 | Apex は既定でシステムの文脈で動き、共有を守るかはクラスの宣言で選ぶ | 広く紹介されている（未検証） |
| 本家の CPU の上限 | 同期 10,000ms、非同期 60,000ms。壁時計の CPU 時間で数える | [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md) |
| 本家の管理パッケージ | 名前空間の接頭辞と `__` の区切り。認定されたパッケージは一部の上限を別に数える | 広く紹介されている（未検証） |
| Wasmtime の燃料 | 生成したコードで燃料を減らし、同じ初期状態なら同じ量で止まる（決定的）。epoch の中断は 2〜3 倍速いことがあるが、決定的ではない | [Wasmtime `Config`](https://docs.wasmtime.dev/api/wasmtime/struct.Config.html) |
| 決定的な実行 | 外からの入力（時計など）の仮想化、NaN の正規化、relaxed SIMD の決定的な形か無効化、メモリーの伸長の扱い、燃料での中断 | [Deterministic Wasm Execution](https://docs.wasmtime.dev/examples-deterministic-wasm-execution.html) |
| メモリーの上限 | `StoreLimitsBuilder` で線形メモリーの大きさを限る | [StoreLimitsBuilder](https://docs.wasmtime.dev/api/wasmtime/struct.StoreLimitsBuilder.html) |
| 事前の初期化 | Wizer は Wasmtime に取り込まれ、`wasmtime wizer` になった | [bytecodealliance/wizer](https://github.com/bytecodealliance/wizer) |
| QuickJS-ng | 小さく組み込める JS のエンジン（QuickJS の後継のフォーク）。MIT。最新の ECMAScript を目指す。WASI の reactor の入口を持つ。v0.17.0（2026-09-18） | [quickjs-ng/quickjs](https://github.com/quickjs-ng/quickjs) |
| StarlingMonkey | SpiderMonkey を元にした WASM のコンポーネント向けの JS の実行系。Apache-2.0。WASI 0.2、fetch と Streams。Fastly と Fermyon が本番で使う | [bytecodealliance/StarlingMonkey](https://github.com/bytecodealliance/StarlingMonkey) |
| Javy | JS を WASM にする道具。Apache-2.0。エンジンは rquickjs（QuickJS-ng の束ね）。静的なリンクで 869KB 以上、動的なリンクで 1〜16KB。v9.1.0（2026-07-30） | [bytecodealliance/javy](https://github.com/bytecodealliance/javy)（依存は `crates/javy/Cargo.toml` で確認） |

## 3. エンジンと実行系の選定（ADR-0048）

### 3.1 比べた観点

| 観点 | QuickJS-ng（自前の殻） | StarlingMonkey | Javy |
| --- | --- | --- | --- |
| エンジンの大きさ | 小さい | 大きい（SpiderMonkey） | 小さい（QuickJS-ng） |
| 1 回の実体化の費用 | 小さい見込み | 大きい見込み | 小さい見込み |
| 外への API | 持たない（殻で決める） | fetch・Streams を持つ（外したい） | `Javy.IO` など道具の API |
| 燃料との相性 | 良い（インタープリタのループが WASM の命令になる） | 同じく数えられる | 同じ |
| 版の安定 | エンジンの版だけ追う | WASI 0.2 とコンポーネントの変化を追う | 道具の API の変化（8.x・9.x）を追う |
| 速さ | インタープリタ | インタープリタ（WASM では JIT なし。未検証） | インタープリタ |
| 本家の実装か | 違う（第三者の汎用の部品） | 違う | 違う |

- 数値の比較（実体化の時間とメモリー、200 件の塊の処理の時間）は、E13 の前の PoC で測る。上の「見込み」は未検証。
- 本家の実装（Apex の実行系）は使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。3 つとも本家と関係のない第三者の部品で、ADR-0007 の「使ってよいもの」（言語の実行系）に当たる。

### 3.2 決めたこと

- **QuickJS-ng を、自前の薄い殻（Rust、rquickjs）と一緒に 1 つの WASM のモジュールにする。** 殻はホストの API の結び付けと、値の受け渡し（JSON）だけを持つ。組み込みの `std`・`os` のモジュールを入れない。
- **実行系は Wasmtime。** Node.js（V8）の WASM には燃料の仕組みがないので、上限を決定的に判定できない。
- Javy は、道具としての作り方（事前の初期化、バイトコードの埋め込み）を参考にし、API は使わない。

## 4. 実行の形（ADR-0048）

### 4.1 置き場所

```
Runtime のタスク（ECS Fargate）
┌──────────────────────────────────────────────────────────┐
│ runtime（Node.js）                     code-runner（Rust＋Wasmtime）│
│  データ層・計測器・トランザクション  ◀── UNIX ドメインソケット ──▶ WASM の実体（1 呼び出しに 1 つ）│
│  DB の資格情報あり                     資格情報なし、IAM の権限なし、WASI なし      │
└──────────────────────────────────────────────────────────┘
```

- `code-runner` は、Runtime と Worker のタスクに 1 つずつ持つ別のコンテナ。Runtime とは、タスクの中の共有のボリュームの UNIX ドメインソケットだけでつなぐ。
- ホストの API の呼び出しは、ソケットで Runtime に戻る。Runtime が、今開いているトランザクションの中で、データ層を通して実行する。砂場は DB の接続を持たない。
- `code-runner` は子プロセスのプール（タスクの vCPU の数）を持ち、1 つの子プロセスは同時に 1 つの呼び出しだけを動かす（9 節）。空きがなければ、呼び出しは 2 秒まで待ち、超えたら 503 にする。
- `code-runner` のプロセスが落ちても、Runtime のプロセスは落ちない。呼び出し中のトランザクションは巻き戻し、`CODE_RUNNER_UNAVAILABLE` を返す。

### 4.2 呼び出しの流れ

```
手順 3b・7a・13 で、有効なトリガーがある
  1. Runtime：塊（new・old のレコード、200 件まで）を JSON にし、燃料の残り・メモリーの上限・トリガーの版とともに送る
  2. code-runner：事前に初期化したモジュールを実体化（線形メモリーを上限の大きさで確保）
       → トリガーのバイトコードを読み込む → `handler(ctx, records)` を呼ぶ
  3. 利用者のコードがホストの API を呼ぶ → ソケットで Runtime へ → データ層で実行し、上限を数える → 結果を返す
  4. 終わり（成功、`addError`、例外、燃料切れ、メモリー切れ）→ 使った燃料を Runtime へ返す
  5. 実体を捨てる（呼び出しの間で状態を持たない）
```

- 呼び出しの間で、グローバルの状態を持たない。同じトランザクションの 2 回目の呼び出しも、新しい実体で始める。キャッシュのつもりのグローバル変数が、組織・利用者をまたいで残らないようにする。
- 燃料は、トランザクションの残り（`tx.code_fuel` − 使った量）を渡し、呼び出しの後に使った量を足す。燃料の使用量から `tx.cpu_ms` にも換算して足す（係数は PoC で決める）。

### 4.3 決定的にする設定

| 設定 | 値 | 理由 |
| --- | --- | --- |
| `consume_fuel` | 有効 | 上限の判定を決定的にする |
| epoch の中断 | 使わない | 決定的でない |
| NaN の正規化 | 有効 | 浮動小数の結果を機械に依らずそろえる |
| relaxed SIMD、threads | 無効 | 機械で結果が変わりうる |
| WASI | 渡さない | 時計・乱数・ファイル・ソケット・環境変数を持たせない |
| 線形メモリー | 実体化の時に上限まで確保 | 伸長の成否が揺れないようにする |
| 時刻 | トランザクションの開始の時刻（ホストの API） | 同じ入力で同じ結果 |
| 乱数 | トランザクションごとの種から作る値（暗号には使えないと文書に書く） | 同じ |

### 4.4 ビルド

- 利用者は TypeScript で書く。型は、組織のメタデータから作った型の定義（オブジェクトと項目）と、ホストの API の型を配る。
- デプロイの時（メタデータの版を上げる前の検証。[ADR-0040](../decisions/0040-deploy-validation-and-rollback.md)）に、TypeScript を JS にし、QuickJS-ng のバイトコードにして保存する。型の誤り・構文の誤りは検証の失敗にする。
- バイトコードは `md_code_versions` に、元のコードとハッシュとともに持つ。エンジンの版を上げる時は、全てのバイトコードを作り直す（互換が保たれるかは未検証）。

## 5. トリガーと DML の順（ADR-0049）

### 5.1 位置

| DML の手順（[metadata-and-runtime.md](metadata-and-runtime.md) の 6 節） | 中身 |
| --- | --- |
| 3a | 保存の前のフロー（[ADR-0026](../decisions/0026-record-triggered-flow-order-and-recursion.md)） |
| **3b** | **before トリガー**（`before_save`）。起動したレコードの項目だけを変えられる。DML・発行・外向きの呼び出しの API は使えない |
| 4〜6 | 必須と入力規則、重複の規則、書き込み |
| **7a** | **after トリガー**（`after_save`） |
| 7b | 保存の後のフロー |
| 8〜12 | 積み上げ集計、履歴、共有の評価、outbox、確定 |
| **13** | **after_commit トリガー**（非同期。Worker のトランザクション） |

- 削除でも同じ位置で `before_delete`・`after_delete` を呼ぶ（フローは削除の前を持たないが、トリガーは持つ。削除を止める規則を書けるようにする）。
- 同じ手順の中のトリガーは `order`（1〜2,000）と `api_name` で並べる。フローとは混ぜず、フロー → トリガー（3）、トリガー → フロー（7）の固定の順にする。
- 本家の順（保存の前のフロー → before トリガー、after トリガー → …… → 保存の後のフロー）に寄せた。

### 5.2 再帰と入れ子

- 同じトリガーは、同じトランザクションで同じレコードに 1 回だけ（フローと同じ規則。`DT-FLW-001` を `DT-EXT-001` に広げる）。
- after トリガーの DML は入れ子の保存になり、手順 1〜8 を通る。入れ子の深さは `tx.nesting`（16）に数える。
- after_commit トリガーは、起動したトランザクションの確定の後に、`flow_async_runs` と同じ仕組み（`code_async_runs`）で 1 回だけ動く。失敗は 3 回まで再試行し、その後は組織の管理者に知らせる。

### 5.3 塊で呼ぶ

- 1 回の呼び出しで、塊の全てのレコード（200 件まで）を渡す。1 件ずつ呼ばない。
- 書き手には「塊のレコードをまとめて問い合わせる」書き方を勧め、ループの中の問い合わせを型の上で警告する（lint の規則を SDK に同梱する）。

## 6. プラットフォームの API（ADR-0049）

| API | 中身 | 数える上限 |
| --- | --- | --- |
| `ctx.query(rql, binds)` | 問い合わせの言語（[ADR-0018](../decisions/0018-record-query-language.md)）。データ層でコンパイルし、権限・共有・FLS を付ける | `tx.queries`、`tx.query_rows` |
| `ctx.insert/update/upsert/delete(object, records)` | DML の AST。通常の保存の手順を入れ子で通る | `tx.dml`、`tx.dml_rows`、`tx.nesting` |
| `record.addError(field?, message)` | そのレコードの保存を失敗にする（部分の成功の扱いは [ADR-0008](../decisions/0008-dml-order-of-execution.md)） | — |
| `ctx.publish(eventType, payload)` | 組織が定義するイベント（既定は確定の後）（[ADR-0034](../decisions/0034-event-subscription-access-and-org-events.md)） | `tx.events_published` |
| `ctx.callout(endpointApiName, path, body)` | 登録した宛先への外向きの呼び出しの依頼（outbox。確定の後に送り、応答を待たない） | `tx.outbound_calls` |
| `ctx.now()`、`ctx.random()` | トランザクションの開始の時刻、種から作る値 | — |
| `ctx.user`、`ctx.org` | 実行する利用者の ID・ロケール・時間帯、組織の設定（通貨・会計年度） | — |
| `ctx.log(level, message)` | デバッグのログ（組織の管理者が見る。7 日） | 1 回の呼び出し 100 行・64KB |

- 実行の文脈は `user`（既定。オブジェクトの権限・FLS・共有をかける）と `system_with_sharing`（オブジェクトの権限と FLS を外し、共有は外さない）。`system_with_sharing` は、トリガーの定義の宣言と、管理者の有効化の時の承認と、監査を要する。共有も外す文脈は持たない（14 節）。
- 持たないもの：DB への直接の SQL、任意の URL への送信、応答を待つ外向きの呼び出し、ファイル、秘密の値の読み、他の組織の参照、メールの送信（フローの `send_email` を使う。E13 の後に検討）。
- `ctx.log` とエラーの文言には、実行する利用者が読めない項目の値を差し込ませない。ホストが返す値は、そもそも読める項目だけ（`user` の文脈）。`system_with_sharing` では、ログの閲覧を `view_all_data` に限る。

## 7. 上限（初期値。正本は governor-limits.md）

| ID（案） | 上限 | 同期 | 非同期 | 数え方 |
| --- | --- | --- | --- | --- |
| `tx.code_fuel` | 燃料 | 50 億 | 300 億 | Wasmtime の燃料。トランザクションの全ての呼び出しの合計。値は PoC で、`tx.cpu_ms` の 10 秒・60 秒に見合うよう決める（未検証） |
| `tx.code_memory` | 1 回の呼び出しの線形メモリー | 64MB | 128MB | 実体化の時に確保する大きさ |
| `tx.code_invocations` | 砂場の呼び出しの数 | 200 | 400 | 1 塊・1 トリガーを 1 |
| `code.bundle_size` | 1 つのトリガーのバイトコード | 1MB | — | メタデータの上限 |
| `code.triggers_per_object` | 1 オブジェクトの有効なトリガー | 20 | — | メタデータの上限 |
| `code.log_lines` | ログ | 1 呼び出し 100 行・64KB | — | 超えた分は捨てて印を付ける |

- 燃料・メモリーを超えたら、トランザクション全体を巻き戻し、400 `LIMIT_EXCEEDED`（`limit: tx.code_fuel`、`where: { kind: "trigger", trigger: "…" }`）を返す。利用者のコードの `try`・`catch` で捕まえられない（Wasmtime のトラップはホストで扱い、JS の例外にしない）。
- **governor-limits の領域への依頼**：上の 6 行を登録簿に足す。`tx.cpu_ms` の数え方に「燃料の換算を含む」を足す。

## 8. パッケージと名前空間（ADR-0050）

### 8.1 名前空間

- 配布者の組織が 1 つ登録する英小文字 2〜15 文字。全ての組織で一意。本家の接頭辞・既知の他社の名前との衝突は、登録の時に予約語の表で断る。
- パッケージの部品の API の名前は `<ns>__<name>`（例：`acme__x_score`）。インストール先の部品は名前空間を持たないので、衝突しない。問い合わせの言語・数式では `acme__x_score` をそのまま書く。

### 8.2 パッケージの形

- [ADR-0039](../decisions/0039-metadata-package-format.md) の形に、`package.yaml` の `namespace`・`version`（semver）・`min_platform_version`・`requires`（権限・オブジェクト・宛先）・`locked`（インストール先で変えてはならない部品）・`signature` を足す。
- コードの部品は、TypeScript の元と、ビルドの道具の版と、バイトコードのハッシュを持つ。インストール先はビルドし直してハッシュを比べる。
- 署名は Ed25519。配布者は自分の秘密鍵で目録に署名し、公開鍵を本システムに登録する。本システムは秘密鍵を預からない。

### 8.3 インストールと版の上げ

```
インストール：署名の検証 → ビルドのし直しとハッシュの比べ → requires を管理者に見せる → 検証（ADR-0040）→ 適用（1 つの版）
版の上げ：同じ流れで、差分だけを当てる。locked の部品の差分は常に当たる。インストール先が変えた部品（locked でない）は、変えた方を残す
削除：パッケージの部品を消す。データのある項目は、通常の削除と同じく 15 日戻せる
```

- インストール先の管理者は、パッケージのコード・`locked` の部品を変えられない。レイアウト・リストビュー・権限セットの割り当ては変えられる（`DT-PKG-001`）。
- 上限は組織と共有する。`tx_limit_peak_ratio` と `<Brand>-Tx-Usage` に名前空間ごとの内訳を足す（governor-limits の領域への依頼）。
- 公開の一覧（マーケットプレイス）、有料のライセンスの管理、配布者のセキュリティの審査は、E13 の後の課題にする。E13 は「組織の間で、署名で信頼を確かめて配る」だけにする。

## 9. セキュリティの隔離

| 層 | 守り |
| --- | --- |
| 言語の実行系 | QuickJS-ng の中の脆弱性は、WASM の線形メモリーの中に閉じる。WASM から外へは、殻の結び付けたホストの API だけ |
| WASM の実行系 | Wasmtime の境界。WASI を渡さない。燃料とメモリーの上限。Wasmtime の勧告（セキュリティの告知）を購読し、Critical は 72 時間以内に上げる |
| プロセス | `code-runner` は別のコンテナ・別のプロセス。読み取り専用のファイルシステム、root でない利用者、資格情報の環境変数なし |
| ホストの API | 全てデータ層を通る。組織は Runtime のトランザクションの組織に固定され、砂場から変えられない。問い合わせは権限・共有・FLS の条件の付いた AST になる |
| 秘密 | 砂場に秘密を渡さない。外向きの呼び出しは宛先の名前だけで依頼し、秘密は本体が送信の時に付ける（ADR-0050） |
| 組織をまたぐ状態 | 呼び出しごとに新しい実体。実体を組織・利用者・トランザクションをまたいで使い回さない |
| 供給の経路 | パッケージの署名、インストール先でのビルドのし直し |

- Spectre のような実行の時間を使う横の経路への対策として、`code-runner` は子プロセスのプールを持ち、1 つの子プロセスは同時に 1 つの呼び出しだけを動かす。同じプロセスの中に、同時に別の組織の実体を持たない。これで十分かは、E13 の外部のペンテストで確かめる（未検証）。
- `security:sensitive` の対象：`code-runner` の全て、殻（ホストの API の結び付け）、実行の文脈の判定、パッケージの署名とインストール。

## 10. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| `code-runner` のプロセスが落ちる | 呼び出し中のトランザクションを巻き戻し、503 `CODE_RUNNER_UNAVAILABLE`。ECS がコンテナを作り直す。タスクの健全性の検査に `code-runner` を含める |
| 燃料・メモリーの上限を超える | 全体を巻き戻し、400 `LIMIT_EXCEEDED`。組織の「上限に近い自動化」に載る |
| トリガーの中の例外 | そのトランザクションを失敗にし、トリガーの名前と行を返す（値を入れない） |
| after_commit のトリガーが 3 回失敗 | 止めて管理者に知らせる。起動した保存は確定のまま |
| 1 つのトリガーの失敗が急に増える | `code_trigger_errors_total{trigger}` を計測し、runbook `code-trigger-errors-spike` で組織に知らせる。本システムがトリガーを勝手に無効にしない |
| Wasmtime・QuickJS-ng の脆弱性 | 版を上げ、全てのバイトコードを作り直すジョブを流す。作り直しが済むまで、そのトリガーを古い版で動かす |

## 11. テスト

| 種類 | 対象 |
| --- | --- |
| 性質ベーステスト | 同じコードと入力と燃料で、止まる場所と使った燃料が毎回同じ（ADR-0048） |
| 性質ベーステスト | 各（トリガー、レコード）が 1 トランザクションに 1 回（ADR-0049） |
| 決定表 | `DT-EXT-001`（手順 × 種類 × 事象 → 順と呼ぶか）、`DT-PKG-001`（部品 × 宣言 × 操作する人 → 変えられるか） |
| 上限の試験 | 7 節の全て。ちょうどで通り、超えたら巻き戻る。`try`・`catch` で捕まえても巻き戻る |
| 否定側のテスト | `user` の文脈で読めないレコード・項目が API の結果に出ない。砂場から時計・ファイル・ソケット・秘密に触れない |
| セキュリティのテスト | 既知の JS のエンジンの脆弱性の再現（公開の PoC）が線形メモリーの外に出ない。ファジング（殻の値の受け渡し） |
| 性能テスト（E13 の PoC） | 実体化の時間、200 件の塊の処理の時間、保存の p95 への影響 |

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md) | 利用者のコードは QuickJS-ng を WASM にしたものを、Runtime の隣の別のプロセスの Wasmtime で燃料とメモリーの上限を付けて動かす |
| [0049](../decisions/0049-triggers-in-dml-order-and-platform-api.md) | トリガーは DML の手順 3・7・13 にフローと並べて置き、塊ごとに 1 回呼ぶ。ホストの API はデータ層の AST だけにし、既定は実行する利用者の権限で動かす |
| [0050](../decisions/0050-packages-namespaces-and-code-isolation.md) | パッケージは名前空間の接頭辞と署名を持つメタデータの束にし、上限は組織と共有して名前空間ごとに計測する。コードの秘密は宛先の登録だけで渡す |

他の領域への依頼：

- governor-limits の領域：7 節の上限を登録簿に足す。`<Brand>-Tx-Usage` と `tx_limit_peak_ratio` に名前空間の内訳を足す。（2026-09-28 に反映済み：governor-limits.md の 4.1・4.5・6.2・9.2 節）
- metadata-and-runtime の領域：DML の手順 3・7 を 3a・3b・7a・7b に分け、削除の前後のトリガーの位置を書く。部品 `object:<object_id>` に有効なトリガーの表を入れる。（2026-09-28 に反映済み：metadata-and-runtime.md の 4.2・6.1 節、ADR-0008 の注記）
- automation-flows の領域：`DT-FLW-001` を、トリガーを含む `DT-EXT-001` と矛盾しないよう保つ。
- sandboxes-and-deploy の領域：パッケージの目録の追加の項目（8.2 節）を ADR-0039 の JSON Schema に足す。
- infrastructure の領域：`code-runner` のコンテナを Runtime・Worker のタスク定義に足す（[infrastructure.md](infrastructure.md) の 3 節に書いた）。

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E13 の前 | PoC：QuickJS-ng・StarlingMonkey の実体化の時間とメモリー、燃料と CPU 時間の換算の係数 |
| E13 | `code-runner`（Wasmtime、決定的な設定、ソケット、健全性の検査） |
| E13 | 殻（rquickjs）とホストの API（query・DML・addError） |
| E13 | TypeScript のビルド、バイトコードの保存、型の定義の配布（SDK） |
| E13 | トリガーの位置（3b・7a・13、削除）と再帰の規則（DT-EXT-001） |
| E13 | 上限（燃料・メモリー・呼び出し）と計測 |
| E13 | 実行の文脈（`user`・`system_with_sharing`）と承認・監査 |
| E13 | デバッグのログ（7 日）と Setup の画面 |
| E14 | パッケージ：名前空間の登録、署名、インストール、版の上げ、`locked`、名前空間ごとの上限の内訳（2026-09-28 に E13 から分けた） |
| E13 | 外部のペンテスト（砂場の脱出、組織をまたぐ状態） |

## 14. 未解決の問い

- 共有も外す文脈（本家の `without sharing` に相当）を持つか。
- 独自の API（利用者のコードで REST の口を作る）を持つか。持つなら、割り当てと認証をどう数えるか。
- スケジュールで動く利用者のコード（本家の Batch・Schedulable に相当）を持つか。
- QuickJS-ng のバイトコードの互換が、エンジンの版の上げで保たれるか。
- 燃料と CPU 時間の換算の係数を、どの負荷で決めるか。
- 公開の一覧（マーケットプレイス）と、配布者のセキュリティの審査をいつ作るか。
- 認定のパッケージに別の上限を与えるか（本家は与えると読めるが未検証）。

### 決定

2026-09-28 の既定案。

- 共有を外す文脈は持たない。全てのレコードを見る処理は、`view_all` の権限を持つ連携の利用者の文脈で動かす運用で代える。要望が多ければ、監査と承認を条件に別の ADR で検討する。
- 独自の API は E13 の後。入れる時は、API の割り当てに数え、OAuth のスコープで守る。
- スケジュールのコードは E13 の後。スケジュールのフローから、after_commit のトリガーを起こす形で代える。
- バイトコードは、エンジンの版を上げるたびに作り直す前提で作る（互換を当てにしない）。
- 換算の係数は、E13 の PoC で、生成した利用者のコードの組（文字列の処理、数値の計算、問い合わせの多いもの）で測って決める。
- 公開の一覧と審査は E13 の後。
- 認定のパッケージにも別の上限を与えない（ADR-0050）。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：砂場の脱出・組織をまたぐ状態の残り。セキュリティのテスト、ファジング、外部のペンテスト（E13）。
- リスク：上限の判定がぶれる（燃料の非決定）。決定性の性質ベーステスト。
- リスク：`user` の文脈でも、ホストの API から読めないデータが出る。否定側のテスト（`LEAK-*` の行を足す）。
- 上限の試験：7 節の全て。
- 本番での検証：`code_trigger_errors_total`、燃料の使用量の分布、`CODE_RUNNER_UNAVAILABLE` の率。

**runbooks**

- `code-runner-crash-loop`：`code-runner` のコンテナが繰り返し落ちる。直前のデプロイ、特定の組織のトリガーを調べる。
- `code-trigger-errors-spike`：あるトリガーのエラーが急に増えた。組織の管理者に知らせる。
- `wasm-runtime-advisory`：Wasmtime・QuickJS-ng の勧告への対応（版の上げ、バイトコードの作り直し）。
- `package-signing-key-revoked`：配布者の鍵の失効と、インストールの停止。
- SLI の追加の依頼（Ops へ）：砂場の呼び出しの p95、実体化の時間、燃料の使用量の p99、`code_trigger_errors_total`、`code-runner` の再起動の数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `md_code_units` | `org_id`、`code_id`、`api_name`、`namespace`、`kind`（`trigger`）、`object_id`、`events`（`before_save`・`after_save`・`after_commit`・`before_delete`・`after_delete`）、`order`、`run_as`（`user`・`system_with_sharing`）、`active_version_id` | メタデータ |
| `md_code_versions` | `org_id`、`version_id`、`code_id`、`source`（TypeScript）、`bytecode`、`bytecode_hash`、`engine_version`、`built_at` | メタデータ。エンジンの版の上げで作り直す |
| `code_async_runs` | `org_id`、`version_id`、`record_id`、`origin_tx_id`、`attempts`、`state`、`ran_at` | 一意。7 日で消す |
| `code_debug_logs` | `org_id`、`id`、`code_id`、`tx_id`、`user_id`、`lines`、`created_at` | 7 日で消す |
| `namespaces` | `namespace`、`owner_org_id`、`registered_at` | RLS の外（全組織で一意） |
| `package_publisher_keys` | `owner_org_id`、`key_id`、`public_key`、`state`（`active`・`revoked`）、`revoked_at` | RLS の外 |
| `package_versions` | `namespace`、`version`、`manifest_hash`、`signature`、`key_id`、`s3_key`、`published_at` | RLS の外。本体は S3 |
| `package_installs` | `org_id`、`namespace`、`version`、`installed_by`、`installed_at`、`approved_run_as` | RLS |

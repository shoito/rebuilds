---
capability: flags
change: 260926-feature-flags-appconfig
epic: E1
status: approved
---

# Spec: フィーチャーフラグ `packages/flags` と AppConfig

## 概要

トランクベース開発の前提となる、フィーチャーフラグの仕組みを作る（[ADR-0026](../../decisions/0026-feature-flags.md)、[delivery.md](../../architecture/delivery.md) の 5 節）。この変更に含めるのは次のとおり。

- `packages/flags`：型付きのフラグの定義（名前、種類、既定値、期限、持ち主）と、サーバーでの評価
- AppConfig Agent からの設定の取得と、取得できないときの退避（最後に取得した値、コードの既定値）
- ワークスペース単位の割り当て（`hash(flag_name + workspace_id) mod 100`）、社内のワークスペース、許可リスト
- Web クライアントに渡す、評価済みのフラグの一覧と、それを返すブートストラップの API（`GET /api/workspaces/{workspace_id}/flags`）
- CI の検査：release・migration のフラグの両方の状態でのテスト、期限切れのフラグの検出
- AppConfig のアプリケーション・環境・構成プロファイル・デプロイ戦略の Terraform

含めないもの：Web クライアント側の読み出し（`web-app-shell-routing` の REQ-WEB-017）、ECS のタスク定義への AppConfig Agent のサイドカーの追加（サービスのインフラの変更）、フラグの変更の監査ログ（E8 の `audit-log-core`。それまでは AppConfig の履歴で追う）。

**`entitlement` 種別は作らない。** プランや契約で使える機能は、`packages/entitlements` と DB で持つ（[ADR-0032](../../decisions/0032-plans-and-entitlements.md)、[ADR-0033](../../decisions/0033-slack-aligned-platform-and-plan-decisions.md)）。ADR-0026 の表にある `entitlement` 種別は、ADR-0032 により使わない。

## ADDED Requirements

### REQ-FLAG-001: フラグの定義

システムは、フラグを `packages/flags` に、名前・種類・既定値・期限・持ち主・説明・クライアントへ渡すかを持つ型付きの定義として置かなければならない。定義は次の規則を満たさなければならない。

- 名前は `<種類>.<小文字・数字・_ の名前>` の形で、接頭辞が種類と一致する。
- 種類は `release`・`ops`・`migration` のどれか。
- `release` と `migration` は、既定値が `false` で、期限（日付）を持つ。
- `ops` は期限を持たず、既定値は通常の運転での値にする。

#### Scenario: 正しい release のフラグ

- When `{ name: "release.thread_replies", kind: "release", default: false, expires: "2026-12-31", owner: "pm-messaging", description: "スレッドの返信", client: true }` を定義する
- Then 型検査と、定義の一覧の検査の両方が通る

#### Scenario: 期限のない release のフラグ

- When `expires` のない `release.thread_replies` を定義する
- Then 型検査が失敗する

#### Scenario: 既定値が true の migration のフラグ

- When `{ name: "migration.search_read_opensearch", kind: "migration", default: true, ... }` を定義する
- Then 型検査が失敗する

#### Scenario: 接頭辞と種類が合わない

- When `{ name: "ops.thread_replies", kind: "release", ... }` を定義する
- Then 型検査が失敗する

### REQ-FLAG-002: entitlement 種別を受け付けない

システムは、`entitlement` 種別と、`entitlement.` で始まる名前のフラグを定義できないようにしなければならない。

#### Scenario: entitlement のフラグを定義しようとする

- When `{ name: "entitlement.sso", kind: "entitlement", ... }` を定義する
- Then 型検査が失敗し、定義の一覧の検査も失敗する

### REQ-FLAG-003: 定義にないフラグの参照

システムは、`packages/flags` に定義のないフラグ名での評価を、型検査で拒否しなければならない。

#### Scenario: 綴りの誤り

- Given `release.thread_replies` だけが定義されている
- When コードが `flags.isEnabled("release.thread_reply", ctx)` を呼ぶ
- Then 型検査が失敗する

### REQ-FLAG-004: ワークスペース単位の評価

フラグを評価するとき、システムは DT-FLAG-002 に従って真偽値を返さなければならない。同じワークスペースのすべてのメンバーには、同じ値を返さなければならない。

#### Scenario: 5% の段階

- Given `release.thread_replies` の設定が `{ enabled: true, internal: true, allow_workspaces: [], percentage: 5 }`、社内でないワークスペース W のバケットが 3、社内でないワークスペース X のバケットが 42
- When W と X について評価する
- Then W は `true`、X は `false` である

#### Scenario: 止める

- Given 上の設定を `enabled: false` に変え、W が許可リストにも入っている
- When W について評価する
- Then `false` である

#### Scenario: 社内のワークスペース

- Given 設定が `{ enabled: true, internal: true, allow_workspaces: [], percentage: 0 }` で、W_int が社内のワークスペースの一覧にある
- When W_int と、社内でないワークスペース X について評価する
- Then W_int は `true`、X は `false` である

### REQ-FLAG-005: バケットの計算

システムは、ワークスペースのバケットを、`flag_name` と正規形（小文字）の `workspace_id` を連結した UTF-8 のバイト列の SHA-256 の先頭 4 バイトを符号なしの 32 ビット整数（ビッグエンディアン）として読み、100 で割った余りとして計算しなければならない。

#### Scenario: 既知の値

- Given `flag_name` = `release.example`、`workspace_id` = `0192a5a4-0000-7000-8000-000000000001`
- When バケットを計算する
- Then SHA-256 の先頭 4 バイトは `d0dab303`（3,503,993,603）で、バケットは 3 である

#### Scenario: 大文字の ID

- When `workspace_id` を `0192A5A4-0000-7000-8000-000000000001` として渡す
- Then バケットは小文字のときと同じ 3 である

### REQ-FLAG-006: 設定の取得と退避

設定を取得するとき、システムは DT-FLAG-001 に従って評価に使う設定を決めなければならない。起動時の最初の取得は 2 秒で打ち切り、取得できなくても起動を止めてはならない。起動後は 15 秒ごとに取得し直さなければならない。

#### Scenario: 起動時に AppConfig Agent がない

- Given AppConfig Agent が応答しない
- When サービスを起動し、`release.thread_replies`（既定値 `false`）と `ops.link_unfurl_enabled`（既定値 `true`）を評価する
- Then 起動は 2 秒以内に続行し、評価の結果はそれぞれ `false` と `true` である

#### Scenario: 取得に成功した後で Agent が止まる

- Given 取得に成功した設定で `release.thread_replies` が W について `true`
- When Agent が止まり、次の取得が失敗した後で W について評価する
- Then 結果は `true` のままである

### REQ-FLAG-007: 設定の文書の検証

取得した設定の文書がスキーマに合わない場合、システムはその文書を採用せず、取得の失敗として扱わなければならない。文書にないフラグはコードの既定値で評価し、定義にないフラグの設定は無視しなければならない。

#### Scenario: 割合が範囲外

- Given 最後に取得した有効な設定で `release.thread_replies` の `percentage` が 5
- When `percentage: 150` を含む文書を取得する
- Then その文書は採用されず、評価は `percentage` 5 の設定で行われ、警告ログ（`msg`=`flags_config_invalid`）が出る

#### Scenario: 文書にないフラグ

- Given 有効な文書に `ops.link_unfurl_enabled` の項目がない
- When `ops.link_unfurl_enabled` を評価する
- Then コードの既定値 `true` が返る

### REQ-FLAG-008: 評価は同期で、例外を投げない

システムは、フラグの評価を、手元の設定だけを使って同期で行い、どの設定の状態でも例外を投げずに真偽値を返さなければならない。

#### Scenario: 評価はネットワークを待たない

- Given Agent への取得が 10 秒かかっている最中
- When フラグを評価する
- Then 結果は 1 ms 以内に返る

### REQ-FLAG-009: クライアントへ渡す一覧

ワークスペースのブートストラップの応答を作るとき、システムは、`client: true` のフラグだけを、そのワークスペースについて評価した `{ フラグ名: 真偽値 }` として返さなければならない。`client: false` のフラグの名前を含めてはならない。

#### Scenario: クライアントへ渡すフラグだけ

- Given `release.thread_replies`（`client: true`）と `migration.search_read_opensearch`（`client: false`）
- When ワークスペース W の一覧を作る
- Then 結果は `{ "release.thread_replies": <W の評価の結果> }` で、`migration.search_read_opensearch` を含まない

### REQ-FLAG-010: テストでの上書き

`deployment.environment` が `local` か `test` の間、システムは環境変数 `FLAGS_OVERRIDE` による評価の結果の上書きを受け付けなければならない。それ以外の環境で `FLAGS_OVERRIDE` が設定されている場合、システムは上書きを無視し、エラーログを出さなければならない。

#### Scenario: テストで全部を有効にする

- Given `DEPLOY_ENV=test`、`FLAGS_OVERRIDE=all_on`
- When 任意の release・migration のフラグを評価する
- Then `true` が返る

#### Scenario: prod で上書きを設定してしまう

- Given `DEPLOY_ENV=prod`、`FLAGS_OVERRIDE=all_on`、AppConfig の設定で `release.thread_replies` が W について `false`
- When W について評価する
- Then `false` が返り、エラーログ（`msg`=`flags_override_ignored`）が出る

### REQ-FLAG-011: 期限切れのフラグの検出

CI が定義の一覧を検査するとき、システムは DT-FLAG-003 に従って、期限切れの release・migration のフラグを警告または失敗にしなければならない。

#### Scenario: 期限を 31 日過ぎた

- Given 今日が 2027-02-01 で、`release.thread_replies` の期限が 2026-12-31
- When 期限の検査を実行する
- Then 検査は失敗し、フラグ名・持ち主・経過日数（32 日）を出力する

### REQ-FLAG-012: 両方の状態でのテスト

release・migration のフラグを参照するパッケージは、Turborepo のタスク `test:flags`（`ci-pipeline` の REQ-DLV-011 のフック）で、そのパッケージの結合テストを、それらのフラグをすべて無効にした状態（`FLAGS_OVERRIDE=all_off`）と、すべて有効にした状態（`FLAGS_OVERRIDE=all_on`）の 2 回実行しなければならない。PR で変更されたパッケージが release・migration のフラグを参照しているのに `test:flags` を定義していない場合、CI は失敗しなければならない。

#### Scenario: フラグを参照するパッケージの変更

- Given `apps/api` が `release.thread_replies` を参照して `test:flags` を定義し、PR が `apps/api` を変更している
- When CI が走る
- Then `apps/api` の結合テストが `FLAGS_OVERRIDE=all_off` と `FLAGS_OVERRIDE=all_on` で 1 回ずつ実行され、どちらかが失敗すれば CI も失敗する

#### Scenario: タスクの定義を忘れた

- Given `apps/api` が `release.thread_replies` を参照しているが `test:flags` を定義しておらず、PR が `apps/api` を変更している
- When CI が走る
- Then CI は失敗し、`apps/api` とフラグ名を示す

#### Scenario: フラグを参照しないパッケージだけの変更

- Given PR が `packages/telemetry` だけを変更し、`packages/telemetry` はフラグを参照しない
- When CI が走る
- Then 両方の状態の実行は行われず、CI は成功する

### REQ-FLAG-013: 古い設定で動いていることを知らせる

最後に取得できた設定、またはコードの既定値で評価している間、システムは、設定の出どころ（`fresh` / `last_known` / `default`）と、最後に取得に成功してからの経過秒数をメトリクスとして出さなければならない。

#### Scenario: Agent が止まって 5 分

- Given 最後の取得の成功から 300 秒たち、その後の取得はすべて失敗している
- When メトリクスを読む
- Then `flags_config_source{source="last_known"}` が 1、`flags_config_age_seconds` が 300 以上である

### REQ-FLAG-014: ブートストラップの API

ワークスペースのメンバーが `GET /api/workspaces/{workspace_id}/flags` を要求したとき、システムは 200 で `{ flags: REQ-FLAG-009 の一覧 }` を返し、応答に `Cache-Control: no-store` を付けなければならない。要求者がそのワークスペースのメンバーでない場合、システムは 404 を返さなければならない。

#### Scenario: メンバーの取得

- Given W1 のメンバー A と、W1 で有効な `release.web_channel_view`（`client: true`）
- When A が `GET /api/workspaces/W1/flags` を要求する
- Then 200 で `{ flags: { "release.web_channel_view": true, ... } }` が返る

#### Scenario: 別のワークスペース

- Given W1 のメンバー A（W2 のメンバーではない）
- When A が `GET /api/workspaces/W2/flags` を要求する
- Then 404 が返り、W2 の評価の結果は含まれない

## Decision Tables

### DT-FLAG-001: 評価に使う設定

取得を試みるたびに評価する。上から順に評価し、最初に一致した行を採用する。

| # | Agent からの取得 | 文書がスキーマに合う | 以前に採用した文書 | → 評価に使う設定 | → `source` |
| --- | --- | --- | --- | --- | --- |
| 1 | 成功 | はい | - | 取得した文書（これを「以前に採用した文書」として覚える） | `fresh` |
| 2 | 成功 | いいえ | あり | 以前に採用した文書 | `last_known` |
| 3 | 成功 | いいえ | なし | コードの既定値 | `default` |
| 4 | 失敗（接続できない、時間切れ、2xx 以外） | - | あり | 以前に採用した文書 | `last_known` |
| 5 | 失敗 | - | なし | コードの既定値 | `default` |

- 以前に採用した文書はプロセスのメモリにだけ持つ。ディスクには書かない（再起動したら Agent から取り直す。Agent 自身も最後の値を持つ。**未検証**）。

### DT-FLAG-002: フラグの評価

上から順に評価し、最初に一致した行を採用する。

| # | テストでの上書き（REQ-FLAG-010） | 設定の出どころ | 文書にこのフラグの項目がある | `enabled` | ワークスペースの指定 | 許可リストにある | `internal` かつ社内のワークスペース | バケット < `percentage` | → 値 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | あり | - | - | - | - | - | - | - | 上書きの値 |
| 2 | なし | `default` | - | - | - | - | - | - | コードの既定値 |
| 3 | なし | `fresh` / `last_known` | いいえ | - | - | - | - | - | コードの既定値 |
| 4 | なし | `fresh` / `last_known` | はい | `false` | - | - | - | - | `false` |
| 5 | なし | `fresh` / `last_known` | はい | `true` | なし | - | - | - | `percentage` が 100 なら `true`、それ以外は `false` |
| 6 | なし | `fresh` / `last_known` | はい | `true` | あり | はい | - | - | `true` |
| 7 | なし | `fresh` / `last_known` | はい | `true` | あり | いいえ | はい | - | `true` |
| 8 | なし | `fresh` / `last_known` | はい | `true` | あり | いいえ | いいえ | はい | `true` |
| 9 | なし | `fresh` / `last_known` | はい | `true` | あり | いいえ | いいえ | いいえ | `false` |

- 「ワークスペースの指定なし」は、ワークスペースに属さない処理（`/api/me/*`、ワークスペースをまたぐジョブ）での評価。
- `ops` のフラグも同じ表で評価する。既定値が `true` の `ops` のフラグを文書で有効のままにするには、`percentage` を 100 にする。
- 上書きの値：`all_on` は `true`、`all_off` は `false`、`<名前>=<true|false>` の並びは名前ごと。上書きは release・migration のフラグにだけ効き、`ops` のフラグはコードの既定値を返す（`ops` のフラグを CI で両方の状態にしない）。

### DT-FLAG-003: 期限の検査

上から順に評価し、最初に一致した行を採用する。経過日数は、CI の実行日（UTC）から期限の日付を引いた日数。

| # | 種類 | 経過日数 | → 結果 |
| --- | --- | --- | --- |
| 1 | `ops` | - | 合格（期限を持たない） |
| 2 | `release` / `migration` | 0 以下 | 合格 |
| 3 | `release` / `migration` | 1〜30 | 警告（CI は通す。PR にフラグ名・持ち主・経過日数を出す） |
| 4 | `release` / `migration` | 31 以上 | 失敗 |

## Correctness Properties

### PROP-FLAG-001: バケットは安定している

任意のフラグ名とワークスペースの ID に対して、バケットは 0 以上 100 未満の整数で、プロセス・時刻・評価の回数・ほかのフラグの設定によらず同じ値になる。

### PROP-FLAG-002: 割合を上げてもワークスペースは外れない

任意のフラグ、任意のワークスペース、任意の設定 c に対して、c から `percentage` を上げる、許可リストに ID を足す、`internal` を `false` から `true` にする、のいずれか（組み合わせを含む）で得た設定 c' を考える。c で `true` になるワークスペースは、c' でも `true` になる。

### PROP-FLAG-003: 割り当ては割合に近く、フラグごとに独立している

任意の `percentage` p と、ランダムな UUIDv7 のワークスペース 100,000 件に対して、`true` になる割合は p ± 1 ポイントに収まる。異なる 2 つのフラグで p = 5 のとき、両方で `true` になる割合は 0.25% ± 0.1 ポイントに収まる（同じ 5% のワークスペースに偏らない）。

### PROP-FLAG-004: どんな取得の結果の列でも評価は壊れない

任意の取得の結果の列（成功・失敗・任意の JSON の文書を含む）と任意の評価の要求に対して、評価は例外を投げず、結果は DT-FLAG-001 で決まる設定を DT-FLAG-002 に当てはめた値と一致する。

## Design

### 定義

```ts
// packages/flags/src/definitions.ts
export const flags = defineFlags([
  { name: "ops.example_kill_switch", kind: "ops", default: true,
    owner: "ops", description: "動作確認用", client: false },
]);
```

- この変更では、動作確認用の `ops` のフラグ 1 件だけを定義する。release のフラグは、使う変更が定義する。
- 評価の関数：`isEnabled(name, { workspaceId? })`。`workspaceId` は、テナントのコンテキスト（認証ミドルウェアが解決したもの）から渡す。リクエストの本文やクエリの値を直接渡さない。
- **権限の判定をフラグで置き換えない**（ADR-0026）。フラグが有効でも、ADR-0005 の判定関数を通す。

### AppConfig の設定の文書

AppConfig の構成プロファイルは、自由形式（`AWS.Freeform`）の JSON にし、Zod のスキーマから生成した JSON Schema を AppConfig のバリデーターに登録する。AppConfig のデプロイの前にも、アプリでの取得の後にも、同じスキーマで検証する。

```json
{
  "version": 1,
  "internal_workspaces": ["<workspace_id>", "..."],
  "flags": {
    "release.thread_replies": {
      "enabled": true, "internal": true,
      "allow_workspaces": ["<workspace_id>"],
      "percentage": 5
    }
  }
}
```

- `percentage` は 0〜100 の整数。`allow_workspaces` は正規形の UUID の配列（最大 1,000 件）。
- 機能フラグ専用の形式（`AWS.AppConfig.FeatureFlags`）を使わないのは、次の 2 つのため。フラグ名の `.` を、その形式のキーに使えるかが **未検証**。割合と許可リストの評価をアプリで行うので、専用の形式の評価の機能を使わない。
- 取得は、AppConfig Agent のローカルの HTTP の受け口（`http://localhost:2772/applications/{app}/environments/{env}/configurations/{profile}`）から行う。受け口の形と、Agent が最後の値を持ち続ける振る舞いは **未検証**。
- 設定の値の変更（段階的なリリースの操作）は、Terraform では行わない。Ops と PM が、AppConfig のコンソールか CLI で新しい版を作り、デプロイ戦略（例：10 分で線形、アラームで自動のロールバック）でデプロイする。Terraform は、アプリケーション・環境・プロファイル・バリデーター・デプロイ戦略だけを持ち、設定の中身は `ignore_changes` にする。

### テストでの上書き

- `FLAGS_OVERRIDE` は `all_on`、`all_off`、`release.x=true,migration.y=false` の 3 つの形を受け付ける。
- CI の両方の状態のテスト（REQ-FLAG-012）は、`ci-pipeline` の `test:flags` のフック（REQ-DLV-011）に載せる。フラグを参照するパッケージは、`package.json` の `test:flags` で結合テストを 2 回実行する。`scripts/check-flags-test-task.ts` が、変更されたパッケージのソースから release・migration のフラグ名の参照を探し、参照があるのに `test:flags` がなければ失敗させる。
- `ci-pipeline` の DT-DLV-001 は「`test:flags` はタスクが必須ではない。必須になる条件は `feature-flags-appconfig` で MODIFIED として足す」としている。`ci-pipeline` はまだアーカイブされておらず、正本に DT-DLV-001 がないため、MODIFIED（変更前の本文の写し）を書けない。この変更では、必須になる条件を REQ-FLAG-012 として ADDED で書く。`ci-pipeline` が先にアーカイブされたら、この節を DT-DLV-001 の MODIFIED に書き直す（Open questions）。

### ブートストラップの API

- `apps/api/src/routes/flags.ts` に、メソッドチェーンで `GET /api/workspaces/:workspace_id/flags` を定義し、`c.json(..., 200)` を返す。応答のスキーマは `packages/contract/src/flags.ts` に置く（ADR-0008）。
- メンバーの解決とテナントのコンテキストは、`post-and-list-messages` の認証ミドルウェアに任せる。メンバーでなければ、ミドルウェアの段階で 404 になる。評価に渡す `workspaceId` は、ミドルウェアが解決したものを使う。

### 観測

- 設定の出どころと経過秒数（REQ-FLAG-013）は、`packages/telemetry` のメトリクスとロガーで出す。フラグごとの評価の回数は出さない（系列が増えるため）。
- アラート（例：`default` が 5 分続く）は、E7 の `slo-dashboards-burn-rate` で作る。

## Open questions

- 許可リストとは逆の、除外のリスト（25% の段で特定の顧客だけ外す）が要るか。要るなら DT-FLAG-002 と PROP-FLAG-002 を変える（PM）。
- 期限の長さに上限を設けるか（例：定義から 180 日以内）。今は持ち主が自由に決める（PM、Dev）。
- 両方の状態のテストを「全部無効」と「全部有効」の 2 回にしたので、フラグどうしの組み合わせ（片方だけ有効）は試さない。組み合わせが問題になる変更は、その変更の Proof で個別に試す（QA）。
- 企業向けのプランのワークスペースを 100% の段の最後に有効にする運用（delivery.md の 5 節）を、仕組みで支えるか。今は許可リストと割合だけで、プランによる除外はない（PM）。
- AppConfig Agent をローカルと CI で動かすか。今は動かさず、上書きとメモリ上の取得の差し替えでテストする。Agent の結合テストは、サイドカーを足すインフラの変更で行う（Dev）。
- REQ-FLAG-012 を、`ci-pipeline` の DT-DLV-001 の MODIFIED に移すか、ADDED のまま持つか。どちらの変更が先にアーカイブされるかで決まる（Dev、QA）。

## 決定（2026-09-26、PM・QA、既定案）

上の Open questions は、次のとおり決めた。

- 除外のリストは今は持たない。必要になったら、DT-FLAG-002 と PROP-FLAG-002 を MODIFIED で変える。
- release・migration のフラグの期限は、定義から 180 日以内とする。超える定義は CI で失敗させる。
- 両方の状態のテストは「全部無効」と「全部有効」の 2 回にとどめる。組み合わせが問題になる変更は、その変更の plan の Proof で個別に試す。
- 企業向けのプランのワークスペースを最後に有効にする運用は、許可リストで手作業で行う。プランによる除外の仕組みは作らない。
- AppConfig Agent はローカルと CI では動かさない。Agent との結合テストは、サイドカーを足すインフラの変更で行う。
- REQ-FLAG-012 は ADDED のまま持つ。`ci-pipeline` のほうが後にアーカイブされる場合は、そのときに MODIFIED にまとめる。

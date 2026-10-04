# Delivery: Google Calendar

CI/CD、この題材に固有の関門（展開と参照の性質ベーステスト、tzdb の版の差分、`redact()` の経路の性質、CalDAV・iMIP の記録した通信の再生）、CalDAV のクライアントとの互換の試験、フラグ、サーバーのデプロイ、Web のクライアントの配布、tzdb の版の採用の手順、スキーマの変更の順序を決める。他の題材（Linear・Slack・Auth0 の delivery.md）の形を引き継ぐ（GitHub Actions、OIDC、1 回ビルドして同じ成果物を昇格、prod は Ops の承認）。

| ADR | 決定 |
| --- | --- |
| [0048](../decisions/0048-ci-gates-and-caldav-client-compatibility.md) | CI の関門は変更のパスで足し、外すラベルを持たない。展開と参照の性質ベーステスト、tzdb の版の差分、`redact()` の経路の性質、記録した通信の再生を PR の必須にする。CalDAV のクライアントとの互換は、PR の再生、夜間の実物のクライアントの試験場、リリースの前の手動の表の 3 段で確かめる |
| [0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md) | tzdb の新しい版は前の版と一緒にイメージに入れて先にデプロイし、AppConfig の `tzdata.active_version` を全サービスで一度に切り替えて採用する。Web のクライアントは版つきの URL からゾーンを取る。スキーマの変更は広げる・移る・縮める・消すの順にし、展開の索引は影の表で入れ替える |

SLO・リリースとロールバックの方針・デプロイの時間帯と凍結の正本は [runbooks/README.md](../runbooks/README.md) の 3 節にある。この文書は、その方針の仕組みを書く。

## 1. 変更からマージまで

- ブランチ、PR、Conventional Commits、`changes/` の流れは、リポジトリ共通の規則（[docs/process.md](../../../../docs/process.md)）に従う。
- 変更のパスから、関門を自動で足す（2 節）。関門を外すラベルは持たない（ADR-0048）。
- CODEOWNERS：`packages/recurrence`・`tz`・`tzdata`・`policy`・`writer`・`itip`・`ingress-limits` はテックリード（[roadmap.md](../roadmap.md) の `dev-repo-bootstrap`）。`packages/tzdata` は Ops も承認者に入れる。

## 2. CI

ADR-0048。

### 2.1 PR の CI（必須）

| 関門 | 中身 | 時間の目安 |
| --- | --- | --- |
| 静的な検査 | lint（[ADR-0001](../decisions/0001-platform-and-stack.md) の `Intl` の `timeZone`・`Date` の現地時刻・`AT TIME ZONE` の禁止、`packages/recurrence` の外の RRULE の解釈の禁止、`packages/policy` の外の権限の条件の禁止、`packages/ical` の外の iCalendar の文字列の連結の禁止、ログに予定オブジェクトを渡す呼び出しの禁止）、型、秘密の走査、依存の検査（展開・タイムゾーンのライブラリを本番の依存で禁止） | 5 分 |
| 単体・表駆動 | Vitest。全部の DT-* の表を spec から読んで回す | 5 分 |
| 3 つの `TZ` | 単体と表駆動を `TZ=UTC`・`Asia/Tokyo`・`America/New_York` で回し、結果が同じ（[quality.md](../quality.md) の 2.4 節） | 上に含む（並列） |
| 性質ベース | 展開と参照、`resolve` の往復、写しの収束、差分と全件の一致、`redact()` の経路ごとの性質を各 2,000 試行。`regressions/` の全部のシード | 10 分 |
| マイグレーションの比較 | 空の DB に全マイグレーションを当て、望む形と比べる。新しい表の `tenant_id` と FORCE RLS、秘密の列の名前と型、破壊の変更とそれを読むコードの削除が同じ PR にないこと（7 節） | 3 分 |
| 結合 | Testcontainers（PostgreSQL 18、Valkey、LocalStack の SQS・SES）。`packages/writer`・RLS・変更のログ・outbox・排他の制約・配送 | 10 分 |
| 再生 | CalDAV・iMIP の記録した通信の再生（区分に当たるとき。2.3 節の段 1） | 5 分 |
| E2E | Playwright（時計とタイムゾーンを固定）で主な流れ（作成、ドラッグ、招待、空き時間、予約ページ、オフラインの閲覧） | 10 分 |
| Web の資産 | 殻の JavaScript 250 KB 以下（圧縮後）、配置の計算・ドラッグのベンチマーク（[clients.md](clients.md) の 9 節） | 5 分 |

パスで足す関門は [ADR-0048](../decisions/0048-ci-gates-and-caldav-client-compatibility.md) の表（展開・時刻・権限・書き込み・招待・CalDAV・画面の入力・セキュリティの機微）。

- **性質ベーステストの失敗を、再実行で緑にしない。** 失敗したシードを縮めて `regressions/` に足す PR を先に出す（[quality.md](../quality.md) の 2.3 節）。
- **テストの削除・skip・期待値の緩和・参照との食い違いの許可リスト（`recurrence/reference-divergences.json`）への追加**は、CI が差分から見つけて QA の承認を求める。
- **`packages/tzdata` を変える PR** は、差分の報告（[time-zones-and-holidays.md](time-zones-and-holidays.md) の 6.2 節）がなければ失敗する。報告は PR のコメントに付ける。
- CI の PR の関門の時間は p90 30 分以内を目標にする。核の区分（20,000 試行）は 40 分まで許す。

### 2.2 夜間の CI

| 関門 | 中身 |
| --- | --- |
| 性質ベース | 各 200,000 試行。新しい失敗のシードは自動で Issue にする |
| 配送のシミュレーター | 20 万の列（[quality.md](../quality.md) の 2.2.1 節 C） |
| ファジング | `packages/ical` に 100 万件（[ADR-0040](../decisions/0040-untrusted-calendar-input-gate.md)） |
| tzdb の過去の改正の集まり | 版の組の全部（同 2.2.1 節 B） |
| 実物のクライアントの試験場 | 2.3 節の段 2 |
| E2E | 全部の流れ、3 つのブラウザ |
| 障害の注入（staging） | Aurora のフェイルオーバー、Valkey の再起動、`relay` の停止、`reminder-scheduler` の交代、SQS の重複 |
| セキュリティ | DAST（画面・API・CalDAV・予約ページ） |
| 互換 | 1 つ前のリリースの Web の資産と今のサーバーの E2E |

### 2.3 CalDAV のクライアントとの互換

ADR-0048 の 3 段。

**対象と場面**（K9。[intent.md](../intent.md)）：

| クライアント | 版の範囲 | 段 1（PR の再生） | 段 2（夜間の試験場） | 段 3（手動） |
| --- | --- | --- | --- | --- |
| iOS のカレンダー | 最新と 1 つ前の主の版、ベータ | ○ | iOS のシミュレーター（EventKit の試験のアプリ） | ○ |
| macOS のカレンダー | 最新と 1 つ前、ベータ | ○ | macOS のランナー（EventKit） | ○ |
| Thunderbird | 最新の ESR とリリース | ○ | 自動化の方法を E8 で調べる（**未検証**） | ○ |
| DAVx5（Android） | 最新 | ○ | Android のエミュレーター（UI の自動化で同期） | ○ |
| Outlook（iMIP） | 最新 | ○（iMIP の記録） | — | ○ |
| 本家・Apple のカレンダー（iMIP） | — | ○（iMIP の記録） | — | ○ |

| 場面 | CalDAV | iMIP |
| --- | --- | --- |
| 発見（`/.well-known/caldav`、SRV） | ○ | — |
| 一覧、作成、変更、削除 | ○ | — |
| 1 回分の例外、「これ以降」、系列の全体の変更 | ○ | ○ |
| 時刻つき・終日・浮動、夏時間の境界、VTIMEZONE | ○ | ○ |
| 同期のトークン（差分、失効の `valid-sync-token` のエラーからの取り直し） | ○ | — |
| 版の衝突（`If-Match` の 412） | ○ | — |
| 招待と返事（暗黙のスケジュール、`REQUEST`・`REPLY`・`CANCEL`） | ○ | ○ |
| 表の外の入力の拒否（VTODO など。[ADR-0007](../decisions/0007-interop-standards-scope.md)） | ○ | ○ |
| tzdb の更新の後の同じ `SEQUENCE` の `REQUEST`（[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md)） | — | ○ |

- 記録は合成のアカウントで取り、実在の人のデータを入れない（[AGENTS.md](../../AGENTS.md)）。記録の中の認証情報は試験用の値に置き換えてから保存する。
- 段 2 の結果が段 1 の記録と違えば、記録を取り直す PR を作る。OS のベータで違いが出たら、正式の版の前に直すかを Dev が判断する。
- 段 3 の表は、CalDAV・招待に触れたリリースの前と、月 1 回。結果を K9 の判定に使う。

## 3. フラグ

| 種類 | 置き場所 | 評価 | 例 |
| --- | --- | --- | --- |
| `release.*`（未完成の振る舞いを隠す。名前は kebab-case） | AppConfig | テナント・利用者の ID のハッシュの割合 | `release.booking-pages`、`release.scim`、`release.cross-tenant-shared-writes`、`release.admin-event-access` |
| `ops.*`（運用の止め・絞り。名前は snake_case） | AppConfig（60 秒のポーリング） | サーバー | `ops.writes_enabled`、`ops.imip_outbound`（`.<tenant>`）、`ops.web_push`、`ops.webhooks_enabled`、`ops.ics_fetch_interval_min`、`ops.itip_delivery_concurrency`、`ops.tzdata_recompute_rate`、`ops.calendar_write_budget.<origin>`、`ops.search_enabled` |
| データの版の固定 | AppConfig（15 秒のポーリング） | 全サービスが同じ値。割合・テナントの別を持たない | `tzdata.active_version`（6 節） |
| Web のクライアントのフラグ | サーバーが評価して `GET /v1/flags` で配る | 端末はメモリーと手元の DB に持つ | `release.*` の画面の部分 |

- **展開・時刻・権限の規則をフラグにしない**（[runbooks/README.md](../runbooks/README.md) の 3 節）。`expand()`・`resolve()`・`redact()`・`can()` の振る舞いの変更は、コードの版として出し、戻すときは前のイメージへのロールバックで行う。展開の索引は、前の版の `expand()` で `expander` が作り直す。
- `tzdata.active_version` は、すべての経路が同じ値を読むデータの版の固定で、経路ごとに違う規則が動く状態を作らない（[ADR-0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md)）。
- `release.*` は 100% にしてから 30 日以内に消す。消し忘れを週次で一覧にする。例外（長く残すフラグ）は [runbooks/README.md](../runbooks/README.md) の 3 節の一覧だけで、一覧の外のフラグが 30 日を超えたら CI の週次の検査が Issue を作る。
- AppConfig の構成は東京と大阪に同じものを持ち、変更は両方に当てる（[infrastructure.md](infrastructure.md) の 4 節）。

## 4. サーバーのデプロイ

### 4.1 順序

[runbooks/README.md](../runbooks/README.md) の 3 節の順に従う。

```
1. マイグレーション（広げる段だけ。7 節）
2. api・caldav・booking・auth（ローリング。最小の健全 100%）
3. relay
4. worker-*（キューの処理中のメッセージは可視性のタイムアウトで戻る）
5. realtime（1 タスクずつ。接続に再接続を促し、0〜5 秒の乱数で散らす）
6. Web の資産（S3 に置くだけ。切り替えは 5 節）
```

- ECS のデプロイのサーキットブレーカーと、アラームでの自動のロールバック。条件：5xx の率、書き込みの p99、4xx の率の急な上がり（クライアントとの食い違いの兆候）、展開の索引の照合の不一致、CalDAV の 4xx の急な上がり（クライアントの種類ごと）。
- `worker-reminder-scheduler` は、シャードの借りで引き継ぐ（[ADR-0029](../decisions/0029-reminder-clock-buckets-and-timer-wheel.md)）。`worker-reminder-scheduler` と `worker-notifier` のデプロイは、リマインダーの集中（毎時 50 分〜0 分、20 分〜30 分）を避け、毎時 05〜15 分と 35〜45 分にだけ始める（それ以外は自動で待たせる）。
- サーバーの版の更新で、クライアントの取り直し（410）を起こさない。同期のトークンの形を変えるときは 7 節の段で行う。

### 4.2 ロールバック

- まずフラグで戻す（`release.*`、`ops.*`）。次に 1 つ前のイメージ。マイグレーションは広げる段だけなので、1 つ前の版が今の DB で動く。
- 縮める段のマイグレーションの後は、その前の版へ戻さない。
- 展開・時刻・権限の規則の不具合は、前のイメージへ戻し、展開の索引を `expander` で作り直す（3 節）。
- 手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。

## 5. Web のクライアントの配布

- 成果物（ハッシュ付きの JS・CSS、Service Worker、`index.html`）を、版ごとの接頭辞で S3 に置く。古い版の資産は 30 日残す（開いたままのタブと Service Worker の殻が読む）。
- **段階的な切り替え**：CloudFront Functions が、端末のクッキーのハッシュの桶と、KeyValueStore の「版ごとの割合」から `index.html` の版を選ぶ（他の題材と同じ方式）。1% → 10% → 50% → 100%、各段 4 時間以上（[runbooks/README.md](../runbooks/README.md) の 3 節）。
- 新しい殻は Service Worker が背景で取り、次の起動で使う。サーバーが応答のヘッダー `<Brand>-Client-Min` で最低の版を示し、それより古い殻は、利用者が操作していないとき（パネルが閉じていて入力の途中でない）に再読み込みする。上げる理由は、API の互換の外れとセキュリティに限る。
- **手元の DB の版**：捨ててよい写しなので、版を変えたら消して取り直す（[ADR-0039](../decisions/0039-offline-read-cache-and-local-data.md)）。手元の DB の版の変更を、機能の変更と同じリリースに含めてよい（書き込みを持たないので失うものがない）。
- **tzdb**：Web の資産の配布と切り離す（6 節）。

### 5.1 段階を進める条件

| 指標 | 新しい版と古い版の比べ | 止める条件 |
| --- | --- | --- |
| JavaScript のエラーの率 | 同じブラウザで | 2 倍 |
| 範囲の読み出し（窓なしの週の表示）の p95 | 同上 | 10% 以上遅い |
| ドラッグの p95 | 同上 | 10% 以上遅い |
| 書き込みの 4xx の率（412・400） | 同上 | 2 倍 |
| 窓の取り直しの率 | 同上 | 2 倍 |

## 6. tzdb の版の採用

ADR-0049。流れの図は ADR にある。

### 6.1 手順

| # | 手順 | だれ | 確かめ |
| --- | --- | --- | --- |
| 1 | `tzdata-watch`（毎日）が IANA の新しいリリースを見つけ、`packages/tzdata` に版を足す PR を作る | 自動 | リリースのファイルの GPG の署名（`.asc`）を確かめる（[security.md](security.md) の 3.7 節の OP1）。CLDR の `windowsZones` の版も記録 |
| 2 | CI が差分の報告（変わるゾーンと区間、施行までの日数、影響の見積もり、外部への `REQUEST` の見積もり）と、版の差分の試験を出す | 自動 | 施行まで 7 日未満なら「急ぎ」の印と Ops への知らせ |
| 3 | Dev と Ops が差分の報告を見て採用を判断する | Dev・Ops | エージェントは判断しない（[roadmap.md](../roadmap.md) の「エージェントに任せないこと」） |
| 4 | マージする。`/tzdata/<version>/` を S3 に置く。新旧の版を含むイメージをデプロイする（`active` は旧のまま） | Ops の承認 | 全サービスが新しいイメージで健全 |
| 5 | `tzdata.active_version` を新しい版にする（東京と大阪） | Ops | AppConfig の検証の関数が、イメージにない版を拒否する |
| 6 | 全タスクが新しい版を 2 分続けて報告したら、`expander` が計算し直しを始める | 自動 | [observability.md](observability.md) の 7 節の tzdb のダッシュボード |
| 7 | 古い版の索引の行が 0 になるまで見る。外部への `REQUEST` が 10 万通を超える見積もりなら、送る前に Ops が承認する（[ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md)） | Ops | `stale_tzdata_rows` が 0。採用から 24 時間を過ぎて残れば警報 |
| 8 | 30 日の後、古い版をイメージから外す PR | 自動 | — |

- **時間帯**：平日 10〜15 時（[runbooks/README.md](../runbooks/README.md) の 3.1 節）。施行まで 7 日を切った改正は凍結を受けない。
- **戻す**：`tzdata.active_version` を前の版に戻す。行ごとに `tzdata_version` を持つので、計算し直しがどちらの方向にも収束する（PROP-TZ-004）。[runbooks/README.md](../runbooks/README.md) の 3 節の「前の版を新しい版として出す」と同じ結果を、デプロイなしで得る。
- **Web のクライアント**：API の応答の `tzdata_version` で、その版のゾーンを取る（[ADR-0038](../decisions/0038-web-calendar-rendering-and-local-expansion.md)）。資産のデプロイも段階の速めも要らない。

### 6.2 runbooks との関係

- 統合の工程（2026-10-04）で、[runbooks/README.md](../runbooks/README.md) の 3 節の採用の手順の 2（Web のクライアントを同じ版で出す）と 5（前の版を新しい版として出す）を、この流れ（AppConfig の切り替え）に書き直した。手順の正本は [runbooks/tzdb-update.md](../runbooks/tzdb-update.md)。
- 切り替えの窓での会議室・予約の区間の扱いは [ADR-0012](../decisions/0012-tzdb-update-recompute-and-propagation.md) の「切り替えの窓」。

## 7. スキーマの変更の順序

ADR-0049。段（広げる・埋めて移る・縮める・消す）と、展開の索引の影の表、変更のログの日の分割、手元の DB の扱いは ADR のとおり。

- **書き込みの経路**：埋めの書き込みは `packages/writer` の `maintenance` の経路と `maintenance` の枠（[ADR-0047](../decisions/0047-time-shaped-capacity-and-calendar-write-admission.md)）を通す。DB のロールで直接の `UPDATE` を拒否しているので（[ADR-0005](../decisions/0005-change-log-and-sync-tokens.md)）、ほかの道はない。
- **予定オブジェクトの見え方が変わる埋め**は、変更のログに載り、クライアントに差分として届く。量が多いとき（100 万件を超える）は、tzdb の再計算と同じく、施行の時刻を決めて夜間に流し、速さを `ops.*` で絞る。
- **同期のトークンの形**（`v`）を変えるときは、段 2 で新旧の両方を受け、段 3 で古い形を 410 にする。古い形のトークンの使用（[observability.md](observability.md) の 5.4 節）が 0 に近いことを確かめてから進める。
- **CalDAV の ETag の作り方**を変えるときは、全部の予定オブジェクトの ETag が変わり、CalDAV のクライアントが全件を取り直す。夜間に、テナントごとに順に変える。
- **公開 API の形**の互換を壊す変更は、api-and-push の領域の廃止の手順に従う。
- 手順の確かめは runbook `schema-expand-contract.md`（13 節の提案）。

## 8. ホットフィックス

- 他の題材と同じく、main から出し、関門を省かない。性質ベーステストは、核の区分でも PR の既定の試行（2,000）に下げてよい（夜間の 200,000 は後で必ず回す）。下げたことを記録する。
- 展開・時刻・権限の不具合は、まず前のイメージへのロールバックを考える（3 節）。データの直接の書き換えはしない（`packages/writer` の保守の経路だけ。[roadmap.md](../roadmap.md) の「エージェントに任せないこと」）。

## 9. 指標

| 指標 | 目標 |
| --- | --- |
| デプロイの頻度（サーバー） | 平日 1 日 1 回以上 |
| 変更のリードタイム（マージから本番） | 中央値 1 日以内（Web の段階の切り替えを除く） |
| 変更の失敗の率 | 10% 以下 |
| 回復の時間 | ロールバックで 30 分以内 |
| CI の PR の関門の時間 | p90 30 分以内 |
| 夜間の新しい失敗のシード | 7 日以内に直す |
| tzdb の採用 | IANA のリリースから 7 日以内に採用（施行まで 7 日未満なら 24 時間以内） |
| 試験場で先に見つかった互換の問題 | 80%（[ADR-0048](../decisions/0048-ci-gates-and-caldav-client-compatibility.md)） |
| `release.*` のフラグの寿命 | 100% の後 30 日以内に消す |

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `ci-pipeline-baseline` | 2.1 節の関門、パスでの関門の追加、3 つの `TZ`、テストの緩和の検出、本番の依存の禁止の一覧 |
| E1 | `flags-appconfig` | 3 節（東京・大阪、`tzdata.active_version` の検証の関数を含む） |
| E1 | `web-cohort-rollout` | 5 節の CloudFront Functions と KeyValueStore、`<Brand>-Client-Min` |
| E2 | `prop-tests-in-ci` | 2.1・2.2 節の性質ベーステストと回帰のシード |
| E3 | `tzdata-watch-and-rollout` | 6 節の `tzdata-watch`、差分の報告の PR、`/tzdata/<version>/` の配置、AppConfig の切り替え、切り替えの完了の判定（time-zones-and-holidays・infrastructure と共同） |
| E8 | `interop-replay-harness` | 2.3 節の段 1 |
| E8 | `caldav-client-lab` | 2.3 節の段 2（macOS のランナー、iOS のシミュレーター、Android のエミュレーター） |
| E12 | `interop-acceptance` | 2.3 節の段 3（K9） |
| E12 | `schema-expand-contract-tooling` | 7 節の段の確かめ、影の表の切り替え |

## 11. 未解決の問い

### 決定

2026-10-04 の既定案。

- **関門**：パスで足し、外すラベルなし、性質ベーステストの再実行を認めない（ADR-0048）。
- **CalDAV の互換**：再生・試験場・手動の 3 段（ADR-0048）。
- **tzdb の採用**：イメージに複数の版、AppConfig で全サービスを一度に切り替え（ADR-0049）。
- **規則の戻し**：フラグでなく前のイメージへ（3 節）。統合の工程で、events-and-recurrence の `release.recurrence-*` と sharing-and-acl の `release.policy-*` の案を、前のイメージへのロールバックに直した。
- **スキーマ**：広げる・移る・縮める・消す、展開の索引は影の表（ADR-0049）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| macOS・iOS のシミュレーターでの CalDAV のアカウントの自動の追加と同期の起こし方 | E8 の `caldav-client-lab`（**未検証**） |
| Thunderbird の自動化の方法 | E8 の `caldav-client-lab`（**未検証**） |
| 信頼する tzdb の署名の鍵の指紋 | E3 の `tzdata-watch-and-rollout` |

## 12. 指標の置き場所

9 節の指標は、GitHub の Actions とデプロイの記録から週次で集め、[observability.md](observability.md) の 7 節のダッシュボードとは別の「デリバリー」のダッシュボードに出す。

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 2.1 節の必須の関門を、E1 から全 PR の必須のチェックにする。
- 2.3 節の段 3 の結果を K9 の判定にする。試験場の結果の要約を QA が週次で見る。
- 5.1 節の段階を進める条件を、Web のクライアントのリリースの判定にする。

### runbooks

- [runbooks/README.md](../runbooks/README.md) の 3 節の tzdb の採用の手順の 2・5 を、6 節の流れ（AppConfig の切り替え）に合わせて直した（統合の工程）。
- [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)：4 節の順序、自動のロールバックの条件、リマインダーの集中を避ける時間帯、Web の段階の止め方（統合の工程で作った）。
- [tzdb-update.md](../runbooks/tzdb-update.md)：6.1 節の手順、急ぎの採用、戻し（統合の工程で作った。提案の名前 `tzdata-update.md` を `tzdb-update.md` に改めた）。
- `schema-expand-contract.md`：7 節の段の確かめ方と、影の表の切り替え（[runbooks/README.md](../runbooks/README.md) の 5 節の予定）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 | 節 |
| --- | --- | --- |
| AppConfig | `release.*`、`ops.*`、`tzdata.active_version` | 3、6 |
| CloudFront KeyValueStore | Web の版ごとの割合 | 5 |
| S3 | Web の資産（版ごと、30 日）、`/tzdata/<version>/` | 5、6 |
| 開発リポジトリ | `recurrence/reference-divergences.json`、`regressions/`、CalDAV・iMIP の記録（`interop/recordings/<client>/<version>/`） | 2 |
| `occurrences_v<N>`（影の表）、`event_objects.indexed_through_v<N>` | 展開の索引の形の変更の間だけ | 7、ADR-0049 |

## 出典

- 他の題材の delivery.md（Linear、Slack、Auth0）から引き継いだ形（CloudFront Functions と KeyValueStore の段階的な切り替えなど）は、その文書の出典に従う。
- この文書に本家の事実はない。本家の配布と tzdb の採用の時期は公開の資料にない（**未検証**。2026-10-04 に確認）。

# Delivery: X

CI/CD（この題材に固有の関門：見える範囲の漏れの経路、fan-out の性質、出来事の再生、ランキングのオフラインの評価、本家の実装の検査）、フラグ、サーバーのデプロイ、アプリのリリースの列車とストアの段階の配布、OTA の更新、最低の版、スキーマと契約の変更の順序（DB、出来事、公開 API、画面の API）を決める。他の題材（Linear・Slack の delivery.md）の形を引き継ぐ（GitHub Actions、OIDC、1 回ビルドして同じ成果物を昇格、prod は Ops の承認）。

| ADR | 決定 |
| --- | --- |
| [0061](../decisions/0061-ci-gates.md) | PR の必須の関門に、漏れの経路の表の結合テスト、`visible()` の決定表、fan-out の性質ベーステスト、出来事の再生、本人だけの表の RLS の検査、ランキングのオフラインの評価、本家の実装の依存と写しの検査、OpenAPI と出来事の形の互換の検査を入れる。変更のパスで関門を足し、関門を外すラベルを持たない。性質ベーステストの失敗を再実行で緑にしない |
| [0062](../decisions/0062-mobile-release-and-min-version.md) | アプリは週 1 回の列車でストアに出し、iOS は App Store の段階的リリース（7 日）、Android は段階的公開（1% → 10% → 50% → 100%）で広げる。JS だけの修正は、自前で持つ Expo Updates の形の更新のサーバーから、コード署名した束を段階的に配る。最低の版は App API が `426`（`client_too_old`）で強制し、強制はセキュリティと API の互換の理由に限る。支える版は 12 週 |
| [0063](../decisions/0063-contract-change-ordering.md) | 契約の変更は、広げる → 読む側を新旧の両方に対応させる → 書く側を移す → 縮める、の順にする。DB は広げる段と縮める段を別のリリースにする。出来事は共通の頭（`type`・`version`・`event_id`・`committed_at`・`traceparent`）を持ち、消費者が 1 つ前の版を読めるようにしてから作る側を変える。公開 API は同じ版の中で足すだけ。画面の API は、支える最も古いアプリの版が読めなくなる変更をしない |

## 1. 変更からマージまで

- ブランチ、PR、Conventional Commits、`changes/` の流れは、リポジトリ共通の規則（[docs/process.md](../../../../docs/process.md)）に従う。
- 変更のパスから、関門を自動で足す（2 節）。関門を外すラベルは持たない。

| 区分 | パス（開発リポジトリ） | 足す関門 |
| --- | --- | --- |
| 見える範囲 | `packages/visibility`、読み出しの経路（`services/timeline`、`services/search-api`、`services/app-api`、`services/public-api`、`services/notification*`） | 漏れの経路の表の全行の結合テスト、`visible()` の決定表と性質の完全版 |
| ID | `packages/tid` | 生成器の性質の完全版 |
| タイムライン | `services/timeline`、`services/fanout-*`、`services/author-recent` | fan-out の性質の完全版（夜間と同じ） |
| 出来事の消費者 | `packages/stream-consumer`、`services/*` の消費者 | 出来事の再生 |
| ランキング | `packages/ranking`、`services/ranking`、重みの設定 | オフラインの評価と前の版との比較（8 節） |
| 文字数 | `packages/text` | クライアントとサーバーの例の集まり |
| マイグレーション | `db/migrations` | 本人だけの表の RLS の検査、広げる・縮めるの検査（7.1 節） |
| 契約 | `contracts/openapi`、`contracts/events` | 互換の検査（7.2・7.3 節） |
| セキュリティの機微 | 認証、トークン、KMS、WAF、アプリの署名、OTA の配布 | `security:sensitive`（2 人の承認） |
| 運営の重い値 | `config/ops/fanout*`、ランキングのガードレールの値 | Dev と QA の承認（[roadmap.md](../roadmap.md) の「エージェントに任せないこと」） |

## 2. CI

ADR-0061。

### 2.1 PR の CI（必須）

| 関門 | 中身 | 時間の目安 |
| --- | --- | --- |
| 静的な検査 | 型、lint（`visible()` を通らない応答、ID の `number`、閾値の直書き、書き込みのサービスからの Kinesis の直接の書き込み、`console.log`、本家の名前の識別子）、秘密の走査 | 5 分 |
| 本家の実装の検査 | 依存の一覧（`twitter-text`、本家の Snowflake の移植、`the-algorithm`・`x-algorithm`）、コードの写しの検出（公開のリポジトリの指紋との照合）、ランキングの重みの値に本家の値がないか（[ADR-0001](../decisions/0001-platform-and-stack.md)） | 3 分 |
| 依存の検査 | OSV、ライセンス（AGPL の混入を拒む）、新しい依存は承認 | 2 分 |
| 単体・表駆動 | Vitest。全部の `DT-*` を spec から読んで回す | 5 分 |
| 性質ベース（短縮版） | fast-check：fan-out、カウンターの冪等、`tid`、見える範囲、フォローの 2 表、レート制限。区分に当たれば完全版 | 5〜20 分 |
| 結合 | Testcontainers（PostgreSQL、Valkey、OpenSearch、LocalStack の Kinesis・SQS・S3）。漏れの経路の表の行 | 15 分 |
| 出来事の再生 | 合成の出来事の列を消費者に流し直し、写し（タイムライン、カウンター、索引）が正本から作ったものと一致する | 10 分 |
| マイグレーション | 空の DB に全部を当て、望む形と比べる。本人だけの表の `owner_id` と FORCE RLS、`tid` の表に UUIDv7・連番の既定がない | 3 分 |
| 契約 | OpenAPI の差分（`oasdiff`。v1 の中で壊す変更を拒む）、出来事の形の互換（7.2 節） | 2 分 |
| E2E | Playwright（Web）：登録、投稿、フォロー、ホームに出る、ブロックで消える | 10 分 |
| テストの緩和の検出 | テストの削除・skip・期待値の緩和・漏れの経路の行の削除・ガードレールの値の緩和を差分から見つけ、2 人の承認を求める | 1 分 |

- **性質ベーステストの失敗を再実行で緑にしない**。失敗した種を縮めて回帰の種（`test/regressions/`）に足す PR を先に出す。

### 2.2 夜間の CI

| 関門 | 中身 |
| --- | --- |
| 性質ベース（完全版） | 全部の `PROP-*` を多くの列で |
| E2E（全件） | Playwright、Maestro（iOS・Android のシミュレーター・エミュレーター） |
| 障害の注入 | staging で AWS FIS（Valkey のノード、Kinesis の消費者、Aurora のフェイルオーバー、Fanout Worker） |
| セキュリティ | DAST |
| 互換 | 支える最も古いアプリの版（12 週前の列車）と今のサーバーの E2E（6 節） |
| ランキング | データレイクの合成の出来事での全部の評価 |

### 2.3 固定の端末

- アプリの滑らかさ（[clients.md](clients.md) の 5.2 節）は、型番を固定した実機（Android の中位の機種、iOS の 3 つ前の世代）で測る。クラウドの端末の貸し出しは、機種と温度の条件がそろわないので使わない。
- 一覧の画面に触れる PR で、200 件のスクロールを 20 回行い、落ちたフレームが基準（p75 1%、p95 5%）を超えたら失敗、main の中央値から 20% 悪くなったら警告。
- 毎回、較正のベンチマークを先に走らせ、基準から 5% ずれたらその回を無効にする。

## 3. フラグ

AppConfig（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

| 種類 | 評価 | 例 |
| --- | --- | --- |
| `release.*`（未完成の振る舞いを隠す） | サーバーが利用者の ID のハッシュの割合で評価 | `release.dm_groups`、`release.public_api_v1` |
| `ops.*`（運用の止め・絞り） | サーバー（即時、60 秒のポーリング） | `ops.writes_enabled`、`ops.fanout.pull_threshold`、`ops.timeline.rebuild_window`、`ops.ranking.fallback`、`ops.ratelimit.*`、`ops.auth.*` |
| `experiment.*`（A/B） | サーバーが利用者の ID のハッシュで群を割り当てる | `experiment.ranking.*` |
| `policy.*`（決めた値） | サーバー | `policy.ratelimit.*`、`policy.age.*`、`retention.*` |
| クライアントのフラグ | サーバーが評価し、App API の `GET /api/config` で配る。手元に持ち、オフラインでも同じ値を使う | 画面の新しい部品 |

- `release.*` は 100% にしてから 30 日以内に消す。消し忘れを週ごとに一覧にする。
- **見える範囲・`tid`・出来事の意味を変えるものをフラグにしない**。これらは契約で変える（7 節）。フラグで切り替えると、経路によって判定が変わり、漏れになる。
- `ops.fanout.*` の変更は記録を残す（AGENTS.md）。AppConfig の変更の履歴と、監査ログ（[security.md](security.md) の 6.1 節）。

## 4. デプロイと段階の配布

### 4.1 サーバーの順序

[runbooks/README.md](../runbooks/README.md) の 3 節の順を正本にし、ここで理由を書く。

1. マイグレーション（広げる段だけ。7.1 節）
2. 書き込みのサービス（Post、Graph、Engagement、Accounts、DM、T&S）
3. Relay
4. 消費者（Fanout、Counter、Search、Notification ほか）
5. 読み出しのサービス（Timeline、Ranking、Search API、App API、Public API）
6. Gateway（接続を 1 タスクずつ逃がす。10 分かけて、再接続の待ちは 0〜60 秒の乱数）

- ECS のローリング。デプロイのサーキットブレーカーで、新しいタスクが健全にならなければ止めて戻す。
- 各段の後に 10 分の観察（エラーの率、遅延、消費者の遅れ）。悪くなれば止める。

### 4.2 アプリのリリースの列車

ADR-0062。

| 曜日 | 作業 |
| --- | --- |
| 月 | main から列車のブランチを切る。QA の手動の確かめ（VoiceOver・TalkBack、日本語の入力） |
| 火 | ストアに出す（審査） |
| 水〜 | 審査が通ったら段階の配布を始める |

- iOS：App Store の段階的リリース。7 日で 1% → 2% → 5% → 10% → 20% → 50% → 100% と自動で広がる。止めるのは合計 30 日まで（[Release a version update in phases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/)、2026-10-04 に確認）。
- Android：Google Play の段階的公開。1% → 10% → 50% → 100%（各段 1 日以上）。
- [runbooks/README.md](../runbooks/README.md) の 3 節は両方を「1% → 10% → 50% → 100%」と書いているが、iOS の段階的リリースは割合を選べない。iOS は上の 7 日の形にする（runbooks の書き換えを提案する。13 節）。

### 4.3 止める条件

| 対象 | 止める条件 |
| --- | --- |
| サーバー | 5xx の率が前の版の 2 倍、遅延の p99 が SLO の 1.5 倍、消費者の遅れが 60 秒を超える |
| アプリ | クラッシュのないセッションの割合（[clients.md](clients.md) の 11 節）が前の版より 0.5 ポイント下がる、または投稿の失敗の率が前の版の 2 倍（runbooks の 3 節） |
| ランキング | ガードレールの指標の悪化（[observability.md](observability.md) の 8 節） |

- アプリを止めたら、iOS は段階的リリースの一時停止、Android は段階的公開の停止。直すのは OTA（5 節）か、次の列車。

### 4.4 ロールバック

- まずフラグで戻す。次に 1 つ前のイメージ。マイグレーションは戻さない（広げる段だけなので、古いコードがそのまま動く）。
- アプリはストアで戻せない。OTA で 1 つ前の JS の束に戻すか、修正の版を出す。

## 5. OTA の更新

ADR-0062。

- Expo Updates の公開の仕様（v1）に沿った更新のサーバーを自前で持つ。仕様は、自前の更新のサーバーを持つ組織も対象にした公開の取り決めで、マニフェストのコード署名（`expo-signature`、RSA-SHA256）と、ネイティブのコードの組を表す `runtimeVersion` を持つ（[Expo Updates v1](https://docs.expo.dev/technical-specs/expo-updates-1/)、2026-10-04 に確認）。
- 自前にする理由：署名の鍵を自分の KMS（shared のアカウント）で持ち、段階の配布（利用者の ID のハッシュの割合）と止め方を、サーバーのフラグと同じ仕組みで扱うため。束は S3 に置き、`updates.<brand>.<domain>`（[infrastructure.md](infrastructure.md) の 2.2 節）で配る。
- OTA で出すのは **JS だけの不具合の修正** に限る。新しい機能、ネイティブの部品の変更、権限の変更は列車で出す（ストアの審査を迂回しない）。
- 段階：1% → 10% → 100%（各 2 時間以上）。4.3 節の止める条件で止め、1 つ前の束に戻す。
- `runtimeVersion` は列車ごとのネイティブの組に固定する。違う組の端末には配らない。
- 署名の鍵は `security:sensitive`。束の作成は CI だけが行い、人の手元で作らない。

## 6. 最低の版

ADR-0062。

- アプリは要求ごとに `X-<Brand>-Client: ios/<build>` などの頭を付ける。App API は `GET /api/config` で `min_supported_build` と `recommended_build` を返す。
- `min_supported_build` より古い版の要求に、App API は `426`（`client_too_old`。[api-and-rate-limits.md](api-and-rate-limits.md) の 3.5 節）を返し、アプリは更新を求める画面を出す。手元の写しの閲覧は止めない。
- `min_supported_build` を上げるのは、セキュリティの理由（脆弱性の修正）と、API の互換を保てない理由に限る（runbooks の 3 節）。上げる前に、その版の利用者の割合を見て、1% 未満でなければ 2 週の告知（`recommended_build` で更新を勧める）を挟む。
- **支える版は 12 週**（12 本の列車）。画面の API の変更は、12 週前の版が読めなくなる形にしない（7.4 節）。

## 7. スキーマと契約の変更の順序

ADR-0063。

### 7.1 DB

| 段 | 中身 | 同じリリースにしてよいか |
| --- | --- | --- |
| 広げる | 列・表・索引の追加（`NOT NULL` は既定の値つきで）、新しい制約は `NOT VALID` で足してから検証 | 読むコードと同じリリースでよい |
| 移る | 書く側を新しい列へ。バックフィルは小さな束のジョブ | — |
| 縮める | 古い列・表の削除 | **広げる段と別のリリース**。古い列を読むコードが本番に 1 つもないこと（全サービスのデプロイの後 7 日）を確かめてから |

- 大きな表（投稿、関係の表、通知）の索引は `CREATE INDEX CONCURRENTLY`。表の書き換えになる変更（列の型の変更）をしない（新しい列を足して移る）。
- `tid` の表の主キーの型を変えない。

### 7.2 出来事

- 出来事は共通の頭を持つ：`{ type, version, event_id, committed_at, traceparent, partition_key }`。中身は `type` と `version` ごとの Zod の型（`contracts/events`）。
- 変更の順：(1) 消費者が新しい `version` を読めるようにしてデプロイ（古い版も読み続ける）→ (2) 作る側を新しい `version` に変える → (3) Kinesis の保持（7 日）＋ 送り直しの窓（1 時間。[infrastructure.md](infrastructure.md) の 7.5 節）を過ぎてから、消費者の古い版の読み方を消す。
- 互換の検査（CI）：同じ `version` の型を、足す変更（任意のフィールドの追加）以外で変えたら失敗。`version` を上げたら、消費者の全部に新しい版の読み方があることを確かめる。
- データレイク（Iceberg の表）は足す変更だけで追う。

### 7.3 公開 API

- 同じ版（`/v1/`）の中では足すだけ（[api-and-rate-limits.md](api-and-rate-limits.md) の 3.6 節）。OpenAPI の差分で検査する。

### 7.4 画面の API（App API）

- 画面の API はアプリと Web の内部の契約で、版をパスに持たない。代わりに、支える最も古いアプリの版（12 週）が読めなくなる変更をしない。
- 壊す変更が要るときは、新しいエンドポイント（`/api/home2` のような）を足し、古いものは `min_supported_build` が新しいものに対応した版を超えた後に消す。
- 夜間の互換の E2E（2.2 節）で、12 週前の版のアプリと今のサーバーを確かめる。

## 8. ランキングの変更

- 重み・特徴・モデルの変更の PR は、オフラインの評価の結果（前の版との比較の表）を添えないと失敗する（[ADR-0006](../decisions/0006-ranking-boundary.md)）。CI がデータレイクの合成の出来事で評価を回し、PR にコメントで表を付ける。
- 評価の指標とガードレールの値は [ranking-and-recommendation.md](ranking-and-recommendation.md) と QA が決める。値の緩和は 2 人の承認（2.1 節のテストの緩和の検出）。
- マージの後は `experiment.ranking.*` で 1% → 5% → 50% → 100%。100% は PM が日ごとの値で決める（[observability.md](observability.md) の 8 節）。

## 9. ホットフィックス

- サーバー：main に修正を入れ、通常の CI を通し、段の観察を 10 分から 3 分に縮めてデプロイする。CI の関門は縮めない。
- アプリ：JS だけなら OTA（5 節）。ネイティブの修正は臨時の列車（ストアの審査の早期の依頼）。
- デプロイの凍結の間（[runbooks/README.md](../runbooks/README.md) の 3 節）は、修正のデプロイだけを Ops の承認で行う。

## 10. 指標

| 指標 | 目標 |
| --- | --- |
| PR の CI の時間（中央値） | 20 分以内 |
| main へのマージから本番まで | 2 時間以内 |
| 変更の失敗の率（戻した・直したデプロイの割合） | 10% 以下 |
| 性質ベーステストの新しい失敗の種 | 週ごとに見る（0 を目指さない。見つかることが価値） |
| アプリの列車の遅れ | 月 1 回以下 |
| 古い版のアプリの利用者の割合（12 週を超えた版） | 2% 以下 |

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `ci-pipeline-baseline` | 2.1 節（roadmap の既存の Story） |
| E1 | `original-impl-guard` | 2.1 節の本家の実装の検査 |
| E1 | `flags-appconfig` | 3 節（roadmap の既存の Story） |
| E1 | `event-contracts` | 7.2 節の共通の頭と互換の検査（`outbox-relay-kinesis` と共同） |
| E2 | `mobile-release-train` | 4.2・4.3 節、Maestro の E2E |
| E2 | `ota-update-server` | 5 節。署名の鍵 |
| E2 | `min-client-version` | 6 節 |
| E10 | `ranking-offline-eval` | 8 節（roadmap の既存の Story） |
| E14 | `compat-nightly` | 2.2 節の 12 週前の版との互換 |

## 12. 未解決の問い

### 決定

2026-10-04 の既定案。

- **CI の関門はパスで足し、外すラベルを持たない**（ADR-0061）。
- **アプリは週 1 回の列車。iOS は 7 日の段階的リリース、Android は 1% → 10% → 50% → 100%**（ADR-0062）。
- **OTA は自前の更新のサーバー（Expo Updates の公開の仕様）、JS の修正だけ、署名あり**。
- **支える版は 12 週。最低の版の強制はセキュリティと互換の理由だけ**。
- **契約は 広げる → 読む側 → 書く側 → 縮める**（ADR-0063）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| コードの写しの検出の道具 | E1 の `original-impl-guard` で選ぶ |
| 固定の端末の機種 | E2 の `mobile-release-train` |
| OTA をストアの規約の範囲で使う運用の細部 | E2 の着手の時に、その時点のストアの規約で確かめる |
| Web の殻の段階の配布（利用者の組ごとに `index.html` を切り替えるか） | E2。S1 は一斉に切り替え、問題があればフラグで戻す |

## 13. quality.md・runbooks への項目

### quality.md

- 2.2 節のテストのレベル構成に、「出来事の互換」（7.2 節）と「12 週前のアプリの版との互換」（2.2 節）を足すことを提案する。
- アプリの止める条件（4.3 節）を、E2 以降のリリースの合否に使う。

### runbooks

- 3 節の「アプリ」の段階を、iOS は App Store の 7 日の段階的リリース、Android は 1% → 10% → 50% → 100% に書き換えることを提案する（4.2 節）。
- `deploy-and-rollback.md`：4 節。
- `ota-rollback.md`：5 節の 1 つ前の束への戻し方。

## 出典

いずれも 2026-10-04 に確認。

- Apple, [Release a version update in phases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/)
- Expo, [Expo Updates v1](https://docs.expo.dev/technical-specs/expo-updates-1/)

# Delivery: Linear

CI/CD、同期エンジンに固有の関門（遅延の予算、収束のシミュレーター、オフラインと再送、IME）、フラグ、サーバーのデプロイ、Web のクライアントの配布、Electron の自動更新と最低の版、サーバーとクライアントのスキーマの変更の順序（広げる・移る・縮める）を決める。他の題材（Slack・Auth0 の delivery.md）の形を引き継ぐ（GitHub Actions、OIDC、1 回ビルドして同じ成果物を昇格、prod は Ops の承認）。

| ADR | 決定 |
| --- | --- |
| [0055](../decisions/0055-ci-gates-latency-convergence-ime.md) | PR の必須の関門に、遅延の予算のベンチマーク（固定の機械、Chrome、p99 50ms）、収束のシミュレーター（2,000 の列、同期の核に触れる PR は 20 万）と回帰の種、オフラインと再送の 3 つの場面、IME の決定表と合成の組み立てのテスト、生成とマイグレーションの検査を入れる。変更のパスで関門を足し、関門を外すラベルを持たない。シミュレーターの失敗を再実行で緑にしない |
| [0056](../decisions/0056-flags-client-distribution-and-min-build.md) | サーバーのフラグは AppConfig、クライアントのフラグはサーバーが評価して握手で配り、手元に持つ。Web は `index.html` を端末の組（コホート）ごとに段階的に切り替え、Electron は更新の案内を端末の桶で返して段階的に出す。最低の版は Gateway の `min_build` で強制し、手元の読み書きは止めない。手元の DB の版を上げるリリースは戻せないので、別のリリースにして長く見る |
| [0057](../decisions/0057-schema-change-ordering.md) | スキーマの変更は、サーバーの DB を広げる → サーバーが古い形と新しい形の両方を受ける → クライアントを移す → 古い `schema_hash` の接続が 1% 未満かつ 30 日の後に縮める、の順にする。1 つのデプロイで、DB の破壊の変更と、それを読むコードの変更を一緒に出さない |

## 1. 変更からマージまで

- ブランチ、PR、Conventional Commits、`changes/` の流れは、リポジトリ共通の規則（[docs/process.md](../../../../docs/process.md)）に従う。
- 変更のパスから、関門を自動で足す（2 節）。関門を外すラベルは持たない。

| 区分 | パス（開発リポジトリ） | 足す関門 |
| --- | --- | --- |
| 同期の核 | `packages/sync-*`、`packages/model`、`packages/schema`、`services/writer`、`services/gateway`、`services/sync-api` | シミュレーター 20 万の列、オフラインの 3 つの場面 |
| 手元の保存 | `packages/client-store`、`packages/sync-client` | オフラインの 3 つの場面、移行の試験 |
| 画面の入力の経路 | `apps/web/src/actions`、`packages/keymap`、`apps/web/src/list` | 遅延のベンチマーク（全場面）、IME の自動のテスト |
| 権限 | `packages/policy` | 同期グループの性質ベーステストの全部（[security.md](security.md) の 10 節） |
| セキュリティの機微 | 認証、トークン、KMS、Electron のシェル、配布、WAF | `security:sensitive`（2 人の承認。他の題材と同じ） |

## 2. CI

ADR-0055。

### 2.1 PR の CI（必須）

| 関門 | 中身 | 時間の目安 |
| --- | --- | --- |
| 静的な検査 | lint（`packages/policy` の外の権限の条件、リゾルバーの SQL、`visibility ===` の禁止）、型、秘密の走査、依存の検査 | 5 分 |
| 単体・表駆動 | Vitest。全部の DT-* の表を spec から読んで回す | 5 分 |
| 生成の検査 | [data-model-and-schema.md](data-model-and-schema.md) の 4.1 節の 14 項目、`schema_version` の上げ忘れ、SDL の破壊の変更 | 2 分 |
| マイグレーションの比較 | 空の DB に全マイグレーションを当て、望む形と比べる。新しい表の `workspace_id` と FORCE RLS、RLS の外の表の許可リスト（[data-model.md](data-model.md) の 3 節）、秘密の列の型 | 3 分 |
| 収束のシミュレーター | 2,000 の列（各 200 の出来事、クライアント 2〜6）と、`sim/regressions/` の全部の種（[sync-engine.md](sync-engine.md) の 12.1 節）。同期の核の区分は 20 万の列（並列で 20 分以内） | 5〜20 分 |
| 結合 | Testcontainers（PostgreSQL、Valkey、OpenSearch）で Writer・Gateway・Sync API・Relay | 10 分 |
| オフラインと再送 | Playwright（Chromium・Firefox・WebKit）で、オフラインのまま再起動、送信の途中で落ちる、1 つ前の版の outbox を今の版で送る（[client-store-and-offline.md](client-store-and-offline.md) の 11.1 節）。手元の保存・同期の核の区分で必須 | 15 分 |
| 遅延の予算 | 固定の機械のランナー（2.3 節）、Chrome、[client-app.md](client-app.md) の 9.4 節の場面の各 300 回。どれかの p99 が 50ms を超えたら失敗、main の中央値から 10% 遅くなったら警告 | 15 分 |
| IME | DT-APP-001 の表駆動、PROP-APP-001、Playwright の合成の組み立てのイベント（`compositionstart`〜`compositionend` と `keydown` の順序のブラウザごとの違い）を 3 つのブラウザで | 5 分 |
| E2E | 主要な流れ（ログイン、作成、状態の変更、2 つのクライアントの同期、非公開への切り替え） | 10 分 |

- **シミュレーターの失敗を再実行で緑にしない。** 失敗した種は、縮めて `sim/regressions/` に足す PR を先に出す（AGENTS.md）。
- **遅延の予算を超えた PR を、期待の緩和やテストの外しで通さない**（AGENTS.md）。較正のずれ（2.3 節）で無効になった回は、やり直しであって失敗の見逃しではない。
- **テストの削除・skip・期待値の緩和**は、CI が差分から見つけて `security:sensitive` と同じ 2 人の承認を求める（リポジトリ共通の規則の機械の確かめ）。

### 2.2 夜間の CI

| 関門 | 中身 |
| --- | --- |
| シミュレーター | 20 万の列。新しい失敗の種は自動で Issue にする |
| 遅延の予算 | Firefox・Safari（macOS の固定の機械） |
| オフラインの耐久 | 1 日 2,000 トランザクションを 7 日分ためて送る（仮想の時計。[client-store-and-offline.md](client-store-and-offline.md) の 11.3 節） |
| 障害注入 | Writer の強制終了、Aurora のフェイルオーバー、Valkey の再起動、Relay の停止（staging） |
| セキュリティ | DAST、XSS のファジング、Electron の配布物の設定の検査 |
| 互換 | 1 つ前のリリースのクライアント（Web と Electron の殻）と今のサーバーの E2E |

### 2.3 固定の機械のランナー

- 基準の端末（4 年前の中位のノート PC 相当）と同じ級の、型番を固定した自前のランナー（Linux で Chrome、macOS で Safari と Electron）。クラウドの共有のランナーを使わない（[client-app.md](client-app.md) の 9.4 節）。
- 毎回、決まった較正のベンチマークを先に走らせ、基準から 5% ずれたらその回を無効にしてやり直す。
- 信頼しない PR（フォーク）では動かさない。ランナーに秘密を置かない。1 回ごとに環境を作り直す（ブラウザのプロファイル、合成のワークスペースの IndexedDB の写し）。
- 台数は、PR の数（1 日 50 と見込む）× 15 分で、4 台と予備 2 台。

## 3. フラグ

ADR-0056。

| 種類 | 置き場所 | 評価 | 例 |
| --- | --- | --- | --- |
| `release.*`（未完成の振る舞いを隠す） | AppConfig | サーバーがワークスペース・利用者の ID のハッシュの割合で評価 | `release.slack_unfurl` |
| `ops.*`（運用の止め・絞り） | AppConfig（即時の反映、60 秒のポーリング） | サーバー | `ops.writes_enabled`、`ops.dr_replay_mode`、`ops.epoch_reset_spread_min`、`ops.write_budget.<origin>`、`ops.ws_deflate`、`ops.webhooks_enabled`、`ops.integrations.<provider>`、`ops.notifier.<workspace>`、`ops.search_enabled` |
| クライアントのフラグ | サーバーが評価し、`welcome.flags` と Sync API の `GET /sync/flags` で配る | 端末は `_meta.flags` に持ち、オフラインでも同じ値を使う | `release.new_board_ui` |

- クライアントのフラグは、握手のたびと 5 分ごとに取り直す。値が変わったら、次の画面の切り替えで効かせる（入力の途中で画面を変えない）。
- **同期の意味を変えるものをフラグにしない。** 競合の規則、`applyOp`、`derive`、同期グループの規則、トランザクションの形は、クライアントとサーバーで同じでなければ収束しない。これらはスキーマの版（`schema_hash`・`fv`）で変える（ADR-0057）。フラグは画面と、サーバーだけで完結する振る舞い（通知、連携、Webhook）に使う。
- `release.*` は 100% にしてから 30 日以内に消す。消し忘れを週次で一覧にする。

## 4. サーバーのデプロイ

### 4.1 順序

```
 1. マイグレーション（広げる段だけ。ADR-0057）
 2. writer（ローリング。最小の健全 100%）
 3. relay
 4. gateway・sync-api（gateway は 1 タスクずつ 10 分かけて逃がす）
 5. public-api・auth・worker-*
 6. Web の資産（S3 に置くだけ。切り替えは 5 節）
```

- ECS のデプロイのサーキットブレーカーと、アラームでの自動のロールバック（5xx、拒否の率の急な上がり、送信から ack の p99、Relay の遅れ）。
- Gateway：新しいタスクが健全になった後、古いタスクの接続を `kick: server_shutdown`（`retry_after_ms` は 0〜60 秒の乱数）で 10 分かけて逃がす。登録解除の遅延は 15 分。全 Gateway の入れ替えに約 1 時間（20 タスク、3 並び）。
- サーバーの版の更新で、クライアントのやり直し（ブートストラップ）を起こさない（ADR-0003）。
- Writer と Gateway は、1 つ前の版と混在しても動く（混在の間の `submit` の形、Relay のメッセージの形は、前後の版で読める）。

### 4.2 ロールバック

- サーバーのコードは、1 つ前の版へいつでも戻せる。マイグレーションは広げる段だけなので、1 つ前の版が今の DB で動く（ADR-0057）。
- 縮める段のマイグレーション（列の削除）は、それを読まないコードを出して 1 リリース以上たってから、単独で出す。縮める段の後は、その前の版へ戻さない。
- 手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。

## 5. Web のクライアントの配布

ADR-0056。

- 成果物（ハッシュ付きの JS・CSS、Service Worker、`index.html`）を、版ごとの接頭辞で S3 に置く。古い版の資産は 90 日残す（開いたままのタブと、Service Worker の殻が読む）。
- **段階的な切り替え**：CloudFront Functions が、クッキー `<brand>_cid`（端末の ID。[client-store-and-offline.md](client-store-and-offline.md) の 9.3 節）のハッシュの桶と、KeyValueStore の「版ごとの割合」から、`index.html` の版を選ぶ。1% → 10% → 50% → 100% を、各段で 4 時間以上、RUM の指標（5.1 節）を見て進める。
- 新しい殻は Service Worker が背景で取り、次の起動で使う（[client-app.md](client-app.md) の 10 節）。
- **戻し**：KeyValueStore の割合を前の版に戻す。KeyValueStore の変更は数秒で全部のエッジに届く（[Introducing Amazon CloudFront KeyValueStore](https://aws.amazon.com/blogs/aws/introducing-amazon-cloudfront-keyvaluestore-a-low-latency-datastore-for-cloudfront-functions/)、2026-09-28 に確認）。すでに新しい版を開いた端末は、次の起動で前の版に戻る。ただし、**手元の DB の版（`schema_version`）を上げたリリースは戻せない**（前の版のコードは新しい DB を開けず、再読み込みを促すだけになる。[client-store-and-offline.md](client-store-and-offline.md) の 6.4 節）。そこで、DB の版を上げる変更は機能の変更と別のリリースにし（同 6 節の依頼）、1% で 48 時間見てから進め、問題は前へ直す（修正の版を出す）。

### 5.1 段階を進める条件

| 指標 | 新しい版と古い版の比べ | 止める条件 |
| --- | --- | --- |
| 主要な Action の遅延の p99 | 同じ帯・ブラウザで | 10% 以上遅い |
| 起動の p95 | 同上 | 10% 以上遅い |
| 拒否の率（`invalid`・`forbidden`） | 同上 | 2 倍 |
| やり直しの `migration`・`corrupt` | — | 0.5% 以上 |
| JavaScript のエラーの率 | 同上 | 2 倍 |
| 収束の監査の `unexplained` | — | 1 件 |

## 6. Electron の自動更新と最低の版

ADR-0056。

- Electron の殻（main、preload、ネイティブの部分）の版と、レンダラー（Web の成果物。リモートから読む。[client-app.md](client-app.md) の 11 節）の版を分けて持つ。レンダラーは 5 節の Web と同じに更新される。殻の更新は `autoUpdater` で行う。
- `autoUpdater` は macOS と Windows だけで、macOS は署名が必須（[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、2026-09-28 に確認）。Windows は Squirrel.Windows か MSIX で、どちらにするかは E6 で決める（同じ文書では MSIX の更新も扱える）。
- **更新の案内**：`https://update.<brand>.<domain>/<platform>/<arch>/<channel>?v=<今の版>&b=<桶>` を `public-api` が返す（Squirrel.Mac の JSON の形、Windows は選んだ形）。`b` は端末の ID のハッシュの桶（0〜99）で、案内は「その版の出す割合 > b」の端末にだけ新しい版を返す。配布物は S3 と CloudFront。
- **段階**：1%（24 時間）→ 10%（24 時間）→ 50% → 100%。各段で、殻の版ごとのクラッシュの率、起動の失敗、RUM の指標を見る。Chromium の High 以上の修正を含む版は、24 時間で 100% まで進める（[security.md](security.md) の 11 節の 7 日の期限）。
- **止める**：割合を 0 にする。まだ取っていない端末は取らない。**戻す**：前のコードで版の番号を上げた版を出す（Squirrel は版を下げられない）。手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。
- **署名**：macOS は Developer ID の署名と公証、Windows はコード署名。署名の鍵はクラウドの HSM（shared のアカウント）に置き、CI の署名のジョブだけが使う（`security:sensitive`）。更新の案内は TLS で、配布物の署名を `autoUpdater` が確かめる（macOS。Squirrel.Mac は署名を必須にする）。Electron の文書は Windows の Squirrel.Windows の署名の確かめに触れない（[autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、2026-09-28 に確認）。Windows で配布物の署名が確かめられるかは**未検証**で、E6 の `electron-auto-update` で確かめる。確かめられなければ、更新の案内の応答に配布物の SHA-256 を入れ、殻が入れる前に照らす。
- **最低の版**：Gateway の `min_build`（AppConfig）は、`build` を「殻の版＋レンダラーの版」の組で比べる（`hello` の `build` の形は `shell@x.y.z+web@<hash>`。[sync-engine.md](sync-engine.md) の 9.2 節）。`min_build` より古いと `kick: upgrade_required` で送信を止めるが、手元の読み書きと outbox への保存は続ける（ADR-0005）。上げる理由は、プロトコル・互換の一覧の外れ（30 日）・セキュリティ（殻の脆弱性）に限る。
- 殻の版の支え：直近 90 日の殻は動く。それより古い殻には更新を促す表示を出し、セキュリティの理由があれば `min_build` で止める。

## 7. スキーマの変更の順序

ADR-0057。3 つの版（DB の形、モデルの `schema_hash`・`fv`、手元の DB の `schema_version`）の関係は [data-model-and-schema.md](data-model-and-schema.md) の 6 節。

| 段 | リリース | サーバー | クライアント | 条件 |
| --- | --- | --- | --- | --- |
| 1. 広げる | N | マイグレーションで新しい列・表を足す（`NOT NULL` は既定値つき、索引は `CONCURRENTLY`）。Writer の `derive` で古い操作を新しい列にも写す。既存の行は Worker が埋める（`origin = worker`、枠の中。ADR-0054）。Gateway の互換の一覧に、次のリリースの `schema_hash` を先に足せるようにする | 変わらない | — |
| 2. 移る | N+1 | Writer は古い形（`fv` の 1 つ前）と新しい形の両方を受ける | 新しい列を使う。`upcast` で古い形の outbox を変換。手元の DB の版を上げるなら、機能の変更と別のリリース | 段 1 の埋めが終わった |
| 3. 縮める | N+2 以降 | 古い形を受けるのをやめる（互換の一覧から外す）。古い列を読まないコードを出す | — | 古い `schema_hash` の接続が 1% 未満、かつ段 2 から 30 日、かつ古い `fv` の outbox の報告（`hello` の `pending`）が 0 に近い |
| 4. 消す | 段 3 の次 | 古い列を消すマイグレーションを単独で出す | — | 段 3 のコードが 1 リリース以上動いた |

- **1 つのデプロイで、DB の破壊の変更と、それを読むコードの変更を一緒に出さない。** サーバーのコードを 1 つ前へ戻せるようにするため（4.2 節）。
- `groups` の規則の変更（行の配り先が変わる）は、この手順の外で、別の ADR を要する（[data-model-and-schema.md](data-model-and-schema.md) の 6.2 節）。
- 公開 API の廃止（6 か月）は別に進む（[api-and-webhooks.md](api-and-webhooks.md) の 3.7 節）。
- `sync_actions` の `data` の形が変わるとき、30 日の保持の間は、Gateway・Sync API・監査（[observability.md](observability.md) の 4.2 節）が古い形の行も読めるようにする。
- 手順の確かめは runbook `schema-expand-contract.md`（data-model-and-schema の領域の依頼）。

## 8. ホットフィックス

- 他の題材と同じく、main から出し、関門を省かない。遅延のベンチマークとシミュレーターは、同期の核の区分でも PR の既定の回数（2,000）に下げてよい（夜間の 20 万は後で必ず回す）。下げたことを記録する。
- 同期の核の不具合（収束の不一致、outbox の喪失）は、まず `ops.*` のフラグで止められるかを見る（書き込みの経路の停止 `ops.writes_enabled` は最後の手段。止めてもクライアントは outbox に貯める）。

## 9. 指標

| 指標 | 目標 |
| --- | --- |
| デプロイの頻度（サーバー） | 1 日 1 回以上 |
| 変更のリードタイム（マージから本番） | 中央値 1 日以内（Web の段階の切り替えを除く） |
| 変更の失敗の率 | 10% 以下 |
| 回復の時間 | ロールバックで 30 分以内 |
| CI の PR の関門の時間 | p90 30 分以内 |
| シミュレーターの新しい失敗の種 | 夜間で見つかったものを 7 日以内に直す |
| `release.*` のフラグの寿命 | 100% の後 30 日以内に消す |

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `ci-pipeline-baseline` | 2.1 節の関門、パスでの関門の追加、テストの緩和の検出 |
| E1 | `latency-bench-harness` | 2.3 節の固定の機械のランナー（client-app と共同） |
| E1 | `flags-appconfig-and-client` | 3 節 |
| E1 | `web-cohort-rollout` | 5 節の CloudFront Functions と KeyValueStore |
| E2 | `sim-in-ci` | シミュレーターの PR・夜間の関門、回帰の種 |
| E3 | `offline-scenarios-ci` | オフラインの 3 つの場面を必須に |
| E6 | `ime-ci-tests` | IME の自動のテスト |
| E6 | `electron-auto-update` | 6 節の更新の案内、段階、署名（client-app と共同） |
| E12 | `min-build-enforcement` | 6 節の `min_build` の組の比べ |
| E12 | `schema-expand-contract-tooling` | 7 節の段の確かめ（古い `schema_hash` の接続の数、`fv` の報告） |

## 11. 未解決の問い

### 決定

2026-09-28 の既定案。

- **関門**：パスで足し、外すラベルなし、シミュレーターの再実行を認めない（ADR-0055）。
- **フラグ**：同期の意味をフラグにしない（ADR-0056）。
- **Web の段階**：端末の ID の桶と KeyValueStore（ADR-0056）。
- **Electron**：更新の案内を端末の桶で返す、戻しは前へ（ADR-0056）。
- **スキーマの順序**：広げる・移る・縮める・消す（ADR-0057）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Windows の配布を Squirrel.Windows にするか MSIX にするか | E6 |
| Windows の Squirrel が配布物の署名を確かめるか | E6 の `electron-auto-update`（**未検証**） |
| 固定の機械のランナーの型番と台数 | E1 の `latency-bench-harness` |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- 2.1 節の必須の関門を、E1 から全 PR の必須のチェックにする（遅延は E6 から全場面）。
- 5.1 節の段階を進める条件を、クライアントのリリースの判定にする。
- 本番：デプロイの失敗の率、自動のロールバックの回数、殻の版ごとのクラッシュの率。

### runbooks

- `deploy-and-rollback.md`（本工程で作る）。
- `electron-release-halt.md`（client-app の領域の依頼）は、`deploy-and-rollback.md` の Electron の節に含めた。
- `schema-expand-contract.md`（data-model-and-schema の領域の依頼）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 | 節 |
| --- | --- | --- |
| AppConfig | `release.*`、`ops.*`、`min_build`、互換の一覧 | 3、6 |
| CloudFront KeyValueStore | Web の版ごとの割合、Electron の版ごとの割合 | 5、6 |
| 手元の `_meta.flags` | クライアントのフラグ | 3 |
| S3（Web の資産、Electron の配布物） | 版ごと、90 日 | 5、6 |

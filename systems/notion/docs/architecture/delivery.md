# Delivery: Notion

ブランチ、CI、デプロイ、クライアントの配布、リリース（フラグ）、マイグレーションの流れ。Slack の [delivery.md](../../../slack/docs/architecture/delivery.md) を引き継ぎ（[ADR-0001](../decisions/0001-platform-and-stack.md)）、Notion での違いを書く。

| 対象 | 方針 |
| --- | --- |
| ブランチモデル | リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)（トランクベース開発） |
| デプロイとマイグレーション | Slack の [ADR-0022](../../../slack/docs/decisions/0022-zero-downtime-deploy-and-migrations.md)、[ADR-0031](../decisions/0031-migration-rollout-by-shard-groups.md)（シャードの群れ） |
| フィーチャーフラグ | Slack の [ADR-0026](../../../slack/docs/decisions/0026-feature-flags.md)（AppConfig、ワークスペース単位） |
| AWS の CI/CD | Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) の 6 節 |
| 手順 | [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |

原則は 2 つで、Slack と同じ。

- **`main` は常にデプロイできる状態に保つ。**
- **デプロイ（コードを置くこと）とリリース（機能を有効にすること）を分ける。**

## 1. 変更からマージまで

Slack の 1 節と同じ。ブランチは `notion/YYMMDD-<slug>`、PR の CI、CODEOWNERS のレビュー、merge queue、squash。エージェントは PR を作るが、承認とマージの判断はしない。

## 2. CI

### 2.1 PR の CI

Slack の 2.1 節の段（静的検査、単体・性質・表駆動、結合、契約、フラグの両方の状態、追跡、マイグレーションの lint、E2E、Web、セキュリティ、インフラ、エージェントの eval）を引き継ぐ。Notion での追加：

| 段 | 内容 | 失敗の条件 |
| --- | --- | --- |
| 収束の性質 | 任意の並行・オフラインの操作の列で、全クライアントの最終状態が一致し、入力が失われない（[ADR-0005](../decisions/0005-transactions-as-unit-of-change.md)、[collaboration.md](collaboration.md)） | 反例が 1 件でも |
| ブロックの木 | 任意の操作の列の後で、木が木である（[ADR-0002](../decisions/0002-everything-is-a-block.md)） | 同上 |
| 権限の漏洩 | [quality.md](../quality.md) の 2.2.2 節の漏洩の行列（検索・メンション・同期ブロック・履歴・リレーション・ロールアップ・API・MCP・公開サイト・通知など）で、読めないページの中身が返らない（[ADR-0004](../decisions/0004-inherited-page-permissions.md)） | 1 件でも |
| シャード | 論理シャードを 8 に減らした構成で、ルーター・フェンス・一部のシャードだけに当てたマイグレーションで新旧のアプリが動く（[ADR-0027](../decisions/0027-shard-router.md)、[ADR-0031](../decisions/0031-migration-rollout-by-shard-groups.md)） | 1 件でも |
| マイグレーションの lint | Slack の規則に加え、スキーマ名の直書きの禁止、1 シャード分の変更として書かれている | 規則の違反 |
| E2E（主要シナリオ） | 2 人の同時編集、オフラインでの編集と再接続、共有の変更の後に見えなくなる | 1 件でも |
| デスクトップ | デスクトップアプリのビルドと起動のスモーク（3 節） | 失敗 |

### 2.2 夜間の CI

Slack の 2.2 節に加えて、次を行う。

- 収束の性質のテストを、長い列（数万の操作、数時間分のオフライン）で実行する。
- staging の 480 シャードに対して、その日のマイグレーションを群れの順に当て、所要時間を記録する。

## 3. ビルドと成果物

| 成果物 | 形 | 識別子 |
| --- | --- | --- |
| サーバー | コンテナイメージ（api、sync-gateway、relay、workers、migrator、reshard）。ECR、digest で参照。SBOM と来歴付き | `<日付>-<コミットの短いハッシュ>` |
| Web | ハッシュ付きのファイル名の静的ファイル一式。S3 の新しいパス | 同上 |
| デスクトップ | OS ごとの署名済みのインストーラーと更新の差分。コード署名（macOS の公証、Windows の署名）を CI で行い、鍵は CI の外（KMS か署名のサービス）に置く | 同上。アプリのバージョンは semver を別に持つ |

- サーバーのイメージには、「このアプリが必要とするマイグレーションの番号」を埋め込む（[ADR-0031](../decisions/0031-migration-rollout-by-shard-groups.md) のデプロイの関門で使う）。
- デスクトップは Electron で包む（[ADR-0009](../decisions/0009-electron-desktop-shell.md)、[editor.md](editor.md) の 11 節）。ここでは配布の条件を決める（6 節）。

## 4. デプロイ

### 4.1 環境の昇格

Slack の 4.1 節と同じ（dev → staging は自動、prod は Ops の承認。平日の 10〜17 時。エラーバジェットを使い切っている間は修正だけ）。再シャーディングの期間は、アプリのデプロイは続けるが、マイグレーションを含むリリースを止める（[ADR-0028](../decisions/0028-zero-downtime-resharding.md)）。

### 4.2 デプロイの順序

| 順 | 対象 | 方式 |
| --- | --- | --- |
| 1 | マイグレーション（expand） | migrator が群れ G0 → G1 → G2 → G3 の順に当てる。群れの間で 30 分、G0 の SLI を見る |
| 2 | デプロイの関門 | 台帳で、イメージが必要とする番号まで全 480 シャードに当たったことを確かめる。満たさなければ止める |
| 3 | relay、workers | ローリング。Relay はリースを手放してから止まり、別のタスクが引き継ぐ |
| 4 | api | blue/green のカナリア（10% → 100%）。アラームで自動ロールバック |
| 5 | sync-gateway | ローリングで 10% ずつ。接続を少しずつ移す（下記） |
| 6 | Web | 新しい静的ファイルを置いてから、`index.html` を差し替える |
| 7 | デスクトップ | 段階的な自動更新（6 節） |

- マイグレーションの群れの適用に時間がかかる（S1 で数十分〜数時間）ので、expand のマイグレーションは、それを使うアプリより 1 つ前のリリースで入れる。同じリリースで入れると、関門で止まる。
- **Sync Gateway の接続の移し替え**は Slack の ADR-0022 と同じ：登録解除の遅延 180 秒の間に、接続を少しずつ再接続の合図で切る。クライアントはジッターを入れて再接続し、開いているページの `seq` で差分を取る。未確定のトランザクションはローカルに残るので、入力を失わない。WebSocket で変更を受ける方式なら、切る前に、受け付け済みのトランザクションの応答を送り終える。

### 4.3 新旧の混在

- **サーバーは、対応する最も古いクライアントのバージョンまで互換を保つ。** Web は 1 つ前、デスクトップは 6 節の最小のバージョンまで。API の入出力、WebSocket のイベント、トランザクションの操作の形は、項目の追加だけを行う。
- **操作の種類の追加は、クライアントより先にサーバーへ入れる。** 新しい操作を知らないサーバーに、新しいクライアントが送らないようにする。古いクライアントが、知らない種類のブロックや操作を受け取ったら、読み取り専用で表示し、壊さない（[editor.md](editor.md)、[block-model.md](block-model.md)）。
- クライアントは、起動時と再接続時に自分のバージョンを送る。最小のバージョンを下回っていたら、更新を促す。未確定のトランザクションはローカルの保存に残し、更新の後に送る。
- **ローカルの保存のスキーマ**（SQLite（WASM）。[ADR-0008](../decisions/0008-sqlite-wasm-opfs-local-store.md)）の変更は、クライアントの中で前へ進める移行として書き、古い形のデータを読めることをテストする。未確定のトランザクションを消す移行は禁止する。

## 5. リリース（フラグ）

Slack の [ADR-0026](../../../slack/docs/decisions/0026-feature-flags.md) を引き継ぐ。

- 種類：`release`、`ops`、`migration`。名前は `<種類>.<名前>`。
- **割り当ての単位はワークスペース。** `hash(flag_name + workspace_id) mod 100` をアプリで計算し、API・Sync Gateway・Worker・クライアントで同じ関数を使う。同じページを一緒に編集する人は、同じ機能を見る必要があるため（新しいブロックの種類を、片方だけが作れる状態を避ける）。
- 広げ方：社内のワークスペース → 5% → 25% → 100%。各段で 24 時間以上、SLI（[observability.md](observability.md) の 2 節）を見る。
- **新しいブロックの種類・操作の種類のフラグ**は、クライアントの普及を待つ。フラグを広げる前に、その種類を表示できるクライアント（Web と、デスクトップの最小のバージョン）の割合が 99% を超えていることを確かめる。
- **シャードの群れで広げるフラグ**：DB の負荷の形を変える変更（新しい索引の使い方、書き込みの経路の変更）は、ワークスペースの割合ではなく、マイグレーションの群れ（G0〜G3）で広げてよい。影響を物理クラスタの単位で見られるため。条件は `shard_group(workspace_id)` で評価する。
- ops フラグの例：`ops.read_only_mode`（全体・シャード単位）、`ops.presence_enabled`、`ops.search_indexing_enabled`、`ops.webhook_delivery_enabled`。
- 100% にして 2 週間たったフラグは、コードから消す。

| 判断 | 誰が |
| --- | --- |
| staging での受け入れ | QA |
| 社内 → 5% → 25% → 100% | PM。Ops が指標を確認する |
| 止める・戻す | 誰でもよい（フラグを切る） |

## 6. クライアントの配布

### 6.1 Web

- 新しいバージョンは、次の読み込みで使われる。Service Worker は、新しいバージョンを見つけたら待機させ、開いているタブでは切り替えない（編集中の画面を勝手に読み込み直さない）。
- 最小のバージョンを下回ったタブには、再読み込みを促す。未確定のトランザクションは、ローカルの保存にあるので失われない。

### 6.2 デスクトップの自動更新

| 条件 | 内容 |
| --- | --- |
| 配布の元 | 更新の情報（最新のバージョン、差分の場所、署名）を、自分たちの API（`/desktop/updates`）から返す。ファイルは S3＋CloudFront |
| 段階的な配布 | 更新の情報の API が、`hash(install_id) mod 100` で割合を決めて返す。1% → 10% → 50% → 100%。各段で 24 時間、クラッシュ率と RUM の指標を見る |
| 止める | 更新の情報の API で、配布を止める。配ったバージョンに問題があれば、1 つ前のバージョンより新しい番号で、中身を戻したバージョンを出す（前へ進めて戻す） |
| 署名の検証 | クライアントは、更新の OS のコード署名と、更新の情報の sha512 を検証してから当てる（macOS は Squirrel.Mac が Developer ID の署名を、Windows は `electron-updater` が Authenticode の署名を `publisherName` と照合する） |
| 最小のバージョン | サーバーが対応する最小のバージョンを API で返す。下回ったら、編集を止めて更新を求める（閲覧とローカルの保存は残す） |
| 互換の期間 | デスクトップは最長 90 日前のバージョンまで互換を保つ（初期値）。更新を止めている利用者のため |
| 更新の当て方 | アプリの再起動時に当てる。未確定のトランザクションを送り終えるか、ローカルの保存に残っていることを確かめてから再起動する |

更新の仕組みには electron-builder の `electron-updater` を使う（macOS は dmg＋zip、Windows は NSIS）。`generic` の提供元を `/desktop/updates` に向け、API が要求のヘッダーの `install_id` で割合を決めて `latest.yml` を返す（`stagingPercentage` は使わず、割合はサーバーで決める）。組み込みの `autoUpdater` は、`setFeedURL` で自前の URL を使えるが、Linux に対応せず、Windows での署名の検証と段階的な配布の記述がない（[Electron autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater)、[electron-builder Auto Update](https://www.electron.build/v26/docs/features/auto-update/)、2026-09-27 に確認）。

## 7. 480 シャードのマイグレーションの安全

決定は [ADR-0031](../decisions/0031-migration-rollout-by-shard-groups.md)。

- **expand / contract をシャードごとに当てる。** 1 シャードずつ別のトランザクション、`lock_timeout` 3 秒、索引は `CONCURRENTLY`。
- **群れの順に当てる：** G0（社内・合成監視のシャード）→ G1（5%）→ G2（25%）→ G3（残り）。群れの間で、そのシャードの SLI を見る。
- **台帳で状態を持つ。** 各シャードの `schema_migrations` を `global.migration_ledger` に集める。失敗したシャードは止め、冪等に再実行する。
- **デプロイの関門：** アプリのイメージが必要とする番号まで、全シャードに当たっていなければ、デプロイを止める。
- **バックフィル：** Worker が、シャードごとに小分けにし、物理クラスタの writer の CPU とレプリカ遅延を見て速さを変える。
- **contract：** 古いものを参照するアプリが本番に残っていないこと（1 つ前のリリースで参照をやめた）と、PITR の時点を確かめてから、群れの順に消す。
- **再シャーディングの間は凍結する**（[ADR-0028](../decisions/0028-zero-downtime-resharding.md)）。

## 8. ホットフィックス

Slack の 6 節と同じ（まずフラグで止める。修正は `main` への PR で前へ進める。急ぐときの短縮）。追加：

- マイグレーションを含むホットフィックスでも、群れの順は省略しない。G0 の観察時間だけ 30 分から 10 分に縮めてよい。
- デスクトップのホットフィックスは、段階的な配布の段を 10% → 100% に縮めてよい。

## 9. 指標

DORA の 4 指標と、エージェントの PR の差し戻しなしの割合、merge queue の待ち時間、残っているフラグの数は Slack の 7 節と同じ。追加：

- マイグレーションが全 480 シャードに行き渡るまでの時間（群れごと）
- デスクトップのバージョンの分布（最小のバージョンを下回る利用者の割合）

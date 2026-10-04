# Architecture: Linear

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧、持ち主、ADR の番号の範囲は 7 節にある。品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

## 1. 全体構成

### 1.1 コンテキスト

```
 ソフトウェアのチームの利用者（Web のブラウザ・デスクトップのアプリ。オフラインでも使う）
      │ 画面の操作は手元で反映。トランザクションの送信と差分の受信（WebSocket）
      ▼
┌──────────────── 本システム（<brand>.<domain>、api.<brand>.<domain>）────────────────┐
│  同期（ブートストラップ・トランザクション・差分）、公開 API、連携、通知、検索              │
└──────────────────────────────────────────────────────────────────────────────┘
      ▲ GraphQL・OAuth 2.0            ▲ Webhook の受信            │ 外向き
      │                               │                           ▼
 公開 API の利用者（スクリプト、     GitHub・GitLab（PR・MR・      Webhook の受け手（利用者のサーバー）
 社内のツール、OAuth のアプリ）      push のイベント）、Slack       Slack（通知。スレッドの同期は MVP の後）
 インポートの元（Jira・Asana・       （メッセージの操作）           メールの送信事業者、デスクトップの通知
 Shortcut・GitHub Issues の API）
```

### 1.2 コンテナ

```
 ┌──────────── クライアント（TypeScript の SPA。デスクトップは Electron で包む）────────────┐
 │  UI（React）── オブジェクトプール（反応型のモデル）── トランザクションのキュー             │
 │                     │ 読み書き                          │ outbox（先に保存してから送る）   │
 │                     ▼                                   ▼                                │
 │               IndexedDB（ワークスペースごと：モデル、_meta、_outbox、部分の索引、本文） │
 └──────┬──────────────────────────────────────────────┬──────────────────────────────┘
        │ HTTPS：ブートストラップ（ストリーム）、遅延の読み込み  │ WebSocket：トランザクション、差分
        ▼                                                 ▼
 ┌──────────────── CloudFront＋WAF（静的な資産、Electron の更新の配信）─────────────────┐
 └──────┬─────────────────────────────┬────────────────────────────┬───────────────┘
        ▼                             ▼                            ▼
 ┌──────────────┐           ┌──────────────────┐          ┌─────────────────────┐
 │ Sync API      │           │ Sync Gateway      │          │ Public API           │
 │ ブートストラップ│           │ WebSocket の終端   │          │ GraphQL・OAuth・      │
 │ 遅延の読み込み  │           │ 同期グループで絞る  │          │ Webhook の受信（連携） │
 └──────┬───────┘           └──┬──────────▲────┘          └──────────┬──────────┘
        │                        │ トランザクション│ 差分（sync_id の順）      │
        │                        ▼          │                          │
        │                 ┌──────────────┐  │                          │
        └───────────────▶│ Writer（検証・  │  │◀─────────────────────────┘
                          │ 適用・sync_id）│  │  同じ Writer を通して書く
                          └──────┬───────┘  │
                                 ▼           │
        Aurora PostgreSQL（モデルの表、sync_actions のログ、ワークスペースの sync_id の数、RLS）
                                 │ outbox                │
                                 ▼                        │
                             Relay ──▶ Valkey（ワークスペースごとの差分の配信）
                                 │
                                 ▼
                         SQS ──▶ Worker（通知・メール、Webhook の送信、検索の索引、
                                          連携の送信、インポート、自動で閉じる・繰り越しの定期処理）
```

| コンテナ | 責務 |
| --- | --- |
| クライアント | モデルを手元に持ち、操作を即座に反映する。トランザクションを outbox に保存してから送り、確定した差分の上に未確定の変更を載せ直す（[ADR-0002](../decisions/0002-sync-model.md)、[ADR-0005](../decisions/0005-client-persistence-and-offline.md)） |
| Sync API | ブートストラップ（全体・部分）と、遅延の読み込みを返す。同期グループで絞る（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)） |
| Sync Gateway | クライアントの WebSocket を終端する。トランザクションを Writer へ渡し、ワークスペースの差分を、接続の同期グループで絞って `sync_id` の順に送る |
| Writer | トランザクションを検証し（権限、型、参照、ワークフローの規則）、モデルの表と `sync_actions` を 1 つの DB のトランザクションで書き、ワークスペースの `sync_id` を振る（[ADR-0002](../decisions/0002-sync-model.md)）。Sync Gateway・Public API・Worker のどこから来た書き込みも、ここを通る |
| Public API | 公開の GraphQL（読み出しと変更）、OAuth 2.0、API キー、連携の Webhook の受信 |
| Relay | outbox を読み、差分を Valkey へ、遅れてよい処理を SQS へ流す |
| Worker | 通知、メール、Webhook の送信、検索の索引、連携、インポート、定期処理 |
| Aurora | 唯一の正本。ワークスペースを RLS で分ける（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)） |
| Valkey | 差分の配信と、接続の状態。失われてもよい（クライアントは `sync_id` で取り戻す） |
| DynamoDB | 権限を狭める操作の追記だけの記録。大阪へ複製し、リージョンの切り替えでやり直す（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)） |

原則は 5 つ。

- **正本はサーバーの 1 本の順序である。** ワークスペースごとに、全変更に単調に増える `sync_id` を振る。クライアントは、確定した状態に、未確定の自分の変更を重ねて見せる（[ADR-0002](../decisions/0002-sync-model.md)）。
- **手元で先に反映し、後で確定する。** ローカルの操作は、サーバーを待たずに描く。入力の経路にネットワークと IndexedDB の待ちを入れない（NFR-001）。
- **配信はベストエフォート、取り戻しは確実に。** 差分が欠けたら、クライアントが `sync_id` で取り戻す。取り戻せないほど古ければ、ブートストラップをやり直す（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)）。
- **権限は、配る前に同期グループで絞る。** クライアントに届いたデータは、見てよいデータだけである（[ADR-0004](../decisions/0004-tenancy-and-permissions.md)）。
- **送る前に保存する。** トランザクションは outbox に保存してから送り、確定を差分で確かめるまで消さない（[ADR-0005](../decisions/0005-client-persistence-and-offline.md)）。

### 1.3 本家の形（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 技術 | React、MobX、TypeScript、Node.js、PostgreSQL と、自作の同期 | Tuomas Artman の X への投稿（2019-04 頃。検索結果の抜粋で確認し、本文は未確認） |
| 手元の保存 | IndexedDB に大部分のデータを持ち、変更を WebSocket で受ける | [Reverse engineering Linear's sync magic](https://marknotfound.com/posts/reverse-engineering-linears-sync-magic/)（第三者の解析） |
| 順序 | `lastSyncId` という 1 つの整数で、手元のバージョンを表す。全ワークスペースで共通の 1 つの数である（自分のワークスペースの続く 2 つの変更の間で数が飛ぶことからの推定） | 同上、[reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine)（第三者の解析だけで確認。本家の保証ではない） |
| ブートストラップ | `type=full` と `type=partial` の 2 種。部分は同期グループを指定する。遅延の読み込みは部分の索引で重複を避ける | 同上（第三者の解析） |
| 差分 | 操作の種類 I（挿入）・U（更新）・A（アーカイブ）・D（削除）・V（アーカイブの解除）・C（依存の読み込み）・G/S（同期グループの変化） | 同上（第三者の解析） |
| 変更 | トランザクション（作成・更新・削除・アーカイブ・解除）を GraphQL の mutation にまとめて送る。確定の `lastSyncId` を受け、差分が届くまで保持して載せ直す | 同上（第三者の解析） |
| 競合 | 大部分は LWW。CRDT はイシューの本文にだけ使う | [Linear's sync engine architecture](https://www.fujimon.com/blog/linear-sync-engine)（本家の講演の要約。第三者） |
| オフライン | 失敗への備えという位置付け。変更を手元に持ち、再起動の後も送り直す。作成の時刻を比べないので、他の人の変更を上書きしうる | [Download Linear](https://linear.app/docs/get-the-app)（公式） |
| 複数のリージョン | ワークスペースを作るときに米国か EU を選び、変えられない。リージョンごとにアプリ一式と DB を持ち、利用者のアカウントは米国の認証のサービスに置く。前段の proxy が振り分ける | [How we built multi-region support for Linear](https://linear.app/now/how-we-built-multi-region-support-for-linear)（公式、2024-05-23） |

いずれも 2026-09-28 に確認。本家の同期の実装は、公式の資料では概要しか公開されていない。上の表の「第三者の解析」は、本家のクライアントの挙動の観察から書かれたもので、本家が保証したものではない。この設計は、その考え方を参考にするが、コードも SDK も使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

## 2. 規模の段階

| 段階 | ワークスペース（うち有料） | 月間の利用者 | 同時の接続のピーク | 書き込みのピーク（トランザクション） | 最大のワークスペース | 構成 |
| --- | --- | --- | --- | --- | --- | --- |
| S1（MVP） | 5,000（1,500） | 10 万 | 6 万 | 1,500 件/秒 | メンバー 2,000、イシュー 50 万、モデルの合計 500 万 | 東京の 1 リージョン・3 AZ。Aurora の writer 1 台＋reader 2 台。大阪にウォームスタンバイ（Aurora Global Database） |
| S2 | 5 万（1.5 万） | 100 万 | 60 万 | 15,000 件/秒 | メンバー 1 万、イシュー 300 万、モデルの合計 3,000 万 | ワークスペースを単位に、複数の Aurora のクラスタへ分ける。大口を専用のクラスタへ。検索を専用の基盤へ |
| S3 | 30 万（10 万） | 500 万 | 300 万 | 75,000 件/秒 | メンバー 5 万、イシュー 1,000 万、モデルの合計 1 億 | セル構成。ワークスペースをセルに固定する。海外のリージョン（ワークスペースをリージョンに固定し、アカウントの解決だけを全体で持つ） |

- 数値は本システムの想定。本家の実数は、「40,000 社以上」（[Pricing](https://linear.app/pricing)、2026-09-28 に確認）のほかは、公開の資料で確かめられなかった（未検証）。
- 書き込みの 1 件は、1 回の送信にまとめたトランザクションの束ではなく、モデルの変更 1 件を数える。
- 1 つのワークスペースの書き込みは、`sync_id` を振る行のロックで直列になる（[ADR-0002](../decisions/0002-sync-model.md)）。1 ワークスペースの書き込みの上限を S1 で 1 秒 300 件と見込み、E2 の PoC で確かめる。`client` を優先し、`api`・`notifier`・`worker`・`import` は枠で割り当てる（[ADR-0054](../decisions/0054-per-workspace-write-admission.md)）。インポートも Writer を通し、200 変更の束と `import` の枠（1 秒 100 変更）で書く（[ADR-0044](../decisions/0044-import-pipeline-staging-and-throttled-writer-commits.md)）。
- 同期のログ（`sync_actions`）は S1 の平均で 1 日 800 万行ほどと見込む。保持は既定案で 30 日（[ADR-0013](../decisions/0013-sync-group-changes-retention-and-reset.md)）。法務の L5 と、やり直しの頻度の計測（E3）で確定する。
- 段階を上げる判断の基準は [infrastructure.md](infrastructure.md) の 9 節、負荷のモデルは [capacity.md](capacity.md) の 1 節にある。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | ローカルの操作の遅延 | 入力から描画まで p99 50ms 以内。対象は、状態・優先度・担当・ラベルの変更、並べ替え、コマンドメニューの表示と絞り込み、一覧の切り替え（読み込み済みのもの） | 基準の端末（4 年前の中位のノート PC 相当）と、イシュー 50 万件のワークスペースで。RUM と CI のベンチマークの両方で測る |
| NFR-002 | 同期の伝播 | 確定（Writer のコミット）から、他のオンラインのクライアントの適用まで p99 1 秒以内、p50 200ms 以内。送信から確定の応答まで p99 300ms 以内 | 日本の中の回線。オフラインのクライアントは対象外 |
| NFR-003 | 起動とブートストラップ | 2 回目以降（手元のデータから）の起動で操作できるまで p95 1.5 秒以内。初回：小さなワークスペース（モデル 5 万件以下）は全体のブートストラップで p95 3 秒以内、最大のワークスペースは部分のブートストラップで p95 10 秒以内 | [ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md) |
| NFR-004 | オフラインの耐久性 | outbox に入ったトランザクションの喪失 0 件。再起動・クライアントの更新をまたぐ。7 日のオフラインの後も送れる。サーバーでは 1 回だけ効く | [ADR-0005](../decisions/0005-client-persistence-and-offline.md) |
| NFR-005 | 収束 | 変更が止んで 5 秒後に、全オンラインのクライアントのモデルが、見てよい範囲でサーバーと一致する。本番の抜き取りの検査で説明のつかない不一致 0 件 | [ADR-0002](../decisions/0002-sync-model.md) |
| NFR-006 | 可用性 | 書き込みの経路（トランザクションの受け付け）、差分の配信、ブートストラップ：月間 99.9%。公開 API：月間 99.9% | サーバーが落ちている間も、クライアントは手元で読み書きを続ける（outbox に溜まる） |
| NFR-007 | 耐久性と障害 | 確定を返した変更を失わない。AZ の障害で RPO 0・RTO 5 分以内。リージョンの障害で RPO 1 分以内・RTO 1 時間以内 | リージョンの障害で失った範囲の変更は、クライアントの outbox に残っていれば（確定を確かめた後 15 分の `done` を含む）送り直される（[ADR-0005](../decisions/0005-client-persistence-and-offline.md) の注記、[ADR-0013](../decisions/0013-sync-group-changes-retention-and-reset.md)）。権限を狭める操作は別の記録からやり直す（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)） |
| NFR-008 | テナントと非公開チームの分離 | 他のワークスペースのデータ、権限のない非公開チームのデータが、クライアント・API・Webhook・検索の結果に届いた事象 0 件 | [ADR-0004](../decisions/0004-tenancy-and-permissions.md) |
| NFR-009 | 公開 API と Webhook | 1 件の読み出しの GraphQL の p99 500ms 以内。Webhook の最初の送信 p95 30 秒以内、少なくとも 1 回届ける | 本家の Webhook は 5 秒で時間切れ、再試行は 1 分・1 時間・6 時間の 3 回（[Webhooks](https://linear.app/developers/webhooks)、2026-09-28 に確認） |
| NFR-010 | 検索 | 変更から検索に出るまで p95 10 秒以内。サーバーの検索の p99 500ms 以内。日本語の部分一致で取りこぼさない | 手元に読み込み済みのモデルは、クライアントの中でも絞り込む |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（サーバー・クライアント・共有のモデルの定義） | 他の題材と同じ。モデルの定義と競合の規則を、クライアントとサーバーで同じコードにする（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| モデルの定義 | 自前のスキーマの定義（`packages/schema` の TypeScript の宣言）から、DB の望む形、共有のパッケージ、クライアントの構成、GraphQL の型、検証を生成する | [ADR-0019](../decisions/0019-schema-definition-and-codegen.md) |
| HTTP・検証 | Hono＋Zod | 他の題材と同じ |
| 公開 API | GraphQL（`graphql-js` を Hono の上で。型は生成、入口と mutation は手で書く） | 本家の公開 API の形に寄せる（[ADR-0041](../decisions/0041-public-graphql-generated-schema-and-writer-mutations.md)） |
| リアルタイム | WebSocket（Sync Gateway。JSON のテキストフレーム、差分の流れに permessage-deflate）、Valkey の pub/sub | Slack の [realtime.md](../../../slack/docs/architecture/realtime.md) の Gateway の考え方を先例にする（[ADR-0009](../decisions/0009-sync-gateway-protocol.md)） |
| クライアント | React、反応型のオブジェクトプール（MobX を第一の候補。E2 の PoC で決める）、IndexedDB（`idb` のラッパー）、TanStack Router・Query、`@tanstack/virtual-core` | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0005](../decisions/0005-client-persistence-and-offline.md)、[ADR-0018](../decisions/0018-render-path-and-latency-budget.md) |
| デスクトップ | Electron | Web と同じコードを使う。Notion・Zoom の題材と同じ |
| 本文の同時編集 | ProseMirror と Yjs・y-prosemirror（`packages/doc` に閉じる）。コメントの本文は ProseMirror の JSON を LWW | [ADR-0021](../decisions/0021-description-crdt-yjs-in-sync-log.md)、[ADR-0022](../decisions/0022-comments-anchors-mentions-attachments.md) |
| DB | Aurora PostgreSQL 18、RLS、ID は UUIDv7 | [ADR-0004](../decisions/0004-tenancy-and-permissions.md) |
| 非同期 | transactional outbox → SQS | 他の題材と同じ |
| 検索 | S1 から Amazon OpenSearch Service（一致は 1〜2 文字の N-gram、関連度は kuromoji）。権限は同期グループで絞る。Aurora の `pg_bigm` は使えることを確かめたうえで代案 | [ADR-0030](../decisions/0030-search-engine-opensearch.md)、[ADR-0031](../decisions/0031-search-permission-by-sync-groups.md) |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs、Managed Grafana。クライアントの RUM は自前の収集の口 | [ADR-0052](../decisions/0052-rum-and-propagation-measurement.md) |
| 認証 | Better Auth（`packages/auth` で包む。メールの OTP、Google、パスキー） | [ADR-0034](../decisions/0034-accounts-with-better-auth.md) |
| DR の記録 | DynamoDB のグローバルテーブル（権限を狭める操作の追記だけの記録） | [ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md) |
| フラグ | AWS AppConfig（サーバー）。クライアントのフラグはサーバーが評価して握手で配る | [ADR-0056](../decisions/0056-flags-client-distribution-and-min-build.md) |
| テスト | Vitest、fast-check（収束の性質）、決定的な同期のシミュレーター（自前）、Testcontainers、Playwright（複数のクライアント、オフラインの模擬） | [ADR-0002](../decisions/0002-sync-model.md) の Confirmation |

## 5. 主な決定

どれも `accepted`。0001〜0005 は最初の設計の起票、0006〜0057 は領域の文書の工程、0058 は統合の工程で起票した。最初の設計の間の直し（process.md の 9 節）は、各 ADR の日付付きの注記にある。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤の上に、同期エンジンを自前で作る。クライアントは TypeScript の SPA と Electron、手元の保存は IndexedDB |
| [0002](../decisions/0002-sync-model.md) | ワークスペースごとに、サーバーが全順序を決める変更のログと単調な `sync_id` を持つ。クライアントは楽観的に当て、差分の上に載せ直す。競合はフィールドの型ごとの規則で解く |
| [0003](../decisions/0003-bootstrap-and-partial-sync.md) | 小さなワークスペースは全体のブートストラップ、大きなワークスペースは部分のブートストラップと遅延の読み込み。差分は同期グループで絞って配る |
| [0004](../decisions/0004-tenancy-and-permissions.md) | ワークスペースをテナントにし、FORCE RLS で分ける。チームを権限の範囲にし、非公開のチームは同期グループで差分から外す |
| [0005](../decisions/0005-client-persistence-and-offline.md) | ワークスペースごとの IndexedDB に、モデルと、送る前に保存する outbox を持つ。スキーマのバージョンごとに移行し、outbox は移行で消さない |
| [0006](../decisions/0006-transactions-writer-and-idempotency.md) | トランザクションは意図の操作の列で、全体が確定か拒否。Writer はワークスペースの行を最初にロックし、1 つの DB のトランザクションで書き、結果を 90 日持って再送に同じ結果を返す |
| [0007](../decisions/0007-sync-actions-and-range-proof-deltas.md) | `sync_id` は変更ごとに振って欠けなく続け、差分は範囲の証明つきのパケットで送る。Gateway は絞る前の列の連続を確かめてから範囲を名乗り、`update` は変更後の行の全体を運ぶ |
| [0008](../decisions/0008-conflict-rules-and-fractional-keys.md) | 競合の規則はスキーマの `conflict` に 1 か所で書く。並びの鍵は範囲ごとに一意な base-62 の分数インデックスで、重なりは Writer が振り直し、長くなったら近くの窓だけを振り直す。上書きはフィールドごとの最後の `sync_id` で見つける |
| [0009](../decisions/0009-sync-gateway-protocol.md) | Sync Gateway のプロトコルは WebSocket の上の JSON のテキストフレーム。認証は最初のメッセージのチケット、握手の決定表で続き・取り戻し・やり直しを決め、取り戻しは Sync API の HTTP で行う |
| [0010](../decisions/0010-deterministic-sync-simulator.md) | 収束は、本物の同期のコードを 1 つのプロセスで動かす、シードから再現できる決定的なシミュレーターで確かめる。PR ごとに 2,000 の列、夜間に 20 万の列を回し、失敗したシードを回帰テストに残す |
| [0011](../decisions/0011-bootstrap-stream-and-chunked-snapshots.md) | ブートストラップは NDJSON のストリームで、ID の範囲のチャンクごとに 1 つの写しで読む。クライアントは最も小さい `as_of` から差分を当て、チャンクの境を先に決めて途中から再開できるようにする |
| [0012](../decisions/0012-lazy-loading-coverage-and-tombstones.md) | 遅延の読み込みは被覆の鍵の単位で求め、そろったら部分の索引に記録する。読み込みと差分の順序の揺れは、行の `updated_sync_id` と、15 分持つ削除の墓標で解く |
| [0013](../decisions/0013-sync-group-changes-retention-and-reset.md) | 同期グループの参加・脱退は `SyncSubscription` の差分で表し、参加は部分のブートストラップ、脱退は 1 つの IndexedDB のトランザクションでの消去にする。ログは 30 日持ち、DR の切り替えと復元では `sync_epoch` を上げて、直近 15 分に確定した outbox を送り直す |
| [0014](../decisions/0014-indexeddb-layout-durability-and-migrations.md) | IndexedDB は outbox だけを `strict`、差分とブートストラップを `relaxed` で書く。outbox の行は確定の後 15 分残し、移行は store と索引を `onupgradeneeded` で、行を再開できる通常のトランザクションで行い、outbox は送る時に今の形へ変換する |
| [0015](../decisions/0015-multi-tab-leader-and-broadcast.md) | 書き手のタブを Web Locks で 1 つ選び、どのタブも outbox へ直接書いて BroadcastChannel で知らせる。書き手は保存した差分の ID を配り、他のタブは IndexedDB から読み直し、取りこぼしは `last_sync_id` の食い違いで気づく |
| [0016](../decisions/0016-memory-tiers-quota-and-offline-ux.md) | メモリーは 3 層にし、観測可能なモデルは 5 万個まで。保存の上限を見張って遅延のモデルの写しだけを退かし、ブラウザに消された未送信の件数はサーバーのクッキーの端末の ID で本人に示す |
| [0017](../decisions/0017-keymap-command-menu-and-ime.md) | 操作は 1 つの Action の登録にまとめ、ショートカット・コマンドメニュー・メニューが同じ登録を使う。キーは入れ子の範囲の順に解決し、組み立て中（`isComposing` か `keyCode === 229`）のキーはどのショートカットにも使わない |
| [0018](../decisions/0018-render-path-and-latency-budget.md) | 入力の経路は Action → トランザクション → プールへの適用 → 行ごとの購読の描き直しで、何も待たない。一覧は固定の高さで仮想化し、遅延は自前の印で測って、固定の機械の CI で p99 50ms を超えた PR を失敗させる |
| [0019](../decisions/0019-schema-definition-and-codegen.md) | モデルは TypeScript の宣言で 1 か所に書き、DB・共有のパッケージ・クライアントの構成・GraphQL の型を生成する。欠けた規則は生成で失敗させ、破壊の変更は広げてから縮める |
| [0020](../decisions/0020-ids-and-human-identifiers.md) | モデルの ID はクライアントが振る UUIDv7。人が読む番号はチームごとの数から Writer が確定の時に振り、再利用しない。チームを移したイシューは番号を振り直し、古い識別子は別名の表で引く |
| [0021](../decisions/0021-description-crdt-yjs-in-sync-log.md) | 本文の CRDT は Yjs と y-prosemirror。更新は 250ms ごとにまとめて `append` で送り、同期のログに `sync_id` の順で載せる。Worker がまとめた状態を作り、読み込みは読んだ時点までを合わせて返す |
| [0022](../decisions/0022-comments-anchors-mentions-attachments.md) | コメントの本文は ProseMirror の JSON を LWW で持つ。インラインのコメントは Yjs の相対位置の組をコメントの行に持つ。メンションは ID で持ち、本文のメンションは Worker が抜き出す。添付は署名付きの URL で S3 へ直接上げ、別のドメインから配る |
| [0023](../decisions/0023-workflow-states-and-lifecycle-automation.md) | ワークフローの状態はチームごとの行で、種類の順は固定、移り変わりは制限しない。自動で閉じる・アーカイブは Worker の日ごとのシステムのトランザクションで行い、削除はアーカイブと `trashed_at` の組で表して 30 日後に消す |
| [0024](../decisions/0024-hierarchy-relations-duplicates-and-triage.md) | 親子は `parent_id` の LWW と循環の拒否。関連は向きを正規化した行で両方のグループに属する。重複は `duplicate` の関連の作成で表し、元の 1 件へつなぎ直す。Triage への振り分けは Writer が作成の時に決める |
| [0025](../decisions/0025-derived-changes-in-writer.md) | ある変更から決まる別の変更は、共有のコードの `derive` で求める。Writer は同じトランザクションで書き、クライアントは同じコードで予測して画面に重ねる |
| [0026](../decisions/0026-cycle-rows-and-rollover.md) | サイクルはチームごとの行で、Worker がチームのタイムゾーンで先の分を作る。クールダウンは行のない隙間で表し、繰り越しは次のサイクルの始まりに Worker のシステムのトランザクションで行う。終わったサイクルへの遅れた割り当ては、派生で繰り越し先へ付け替える |
| [0027](../decisions/0027-progress-stats-per-team-via-derive.md) | 進捗は `(対象, チーム)` ごとの `ProgressStat` の行に `counter` で持ち、イシューの変更の `derive` が増減を出す。行はチームの同期グループに属す。イニシアチブの進捗は保存せず画面で足し、1 日 1 回 SQL で数え直す |
| [0028](../decisions/0028-filter-language-and-shared-evaluation.md) | フィルターは型の付いた JSON の木で持ち、共有のパッケージの 1 つの定義から、クライアントの評価の関数と SQL の生成を作る。空の値・文字の正規化・並びの比較を言語の側で決め、共有のテストの例の集まりと差分テストで一致を確かめる |
| [0029](../decisions/0029-view-coverage-planner-and-server-query.md) | ビューは計画の関数が被覆の鍵から「手元だけ」「手元とサーバー」「サーバー」を決める。サーバーの問い合わせは同期グループで絞った行を返し、クライアントはそれを候補として手元に足して同じ関数で評価する。保存したビューは範囲ごとの同期グループに属し、フィルターが参照する ID はビューの読み手全員が見てよいものに限る |
| [0030](../decisions/0030-search-engine-opensearch.md) | 検索は S1 から Amazon OpenSearch Service で、行ごとの文書にする。一致は 1〜2 文字の N-gram、関連度は同梱の kuromoji、正規化はアプリの共有の関数。バージョンは行の `sync_id` で外部のバージョンにする。Aurora の `pg_bigm` は使えることを確かめたうえで代案とする |
| [0031](../decisions/0031-search-permission-by-sync-groups.md) | 検索の権限は同期グループで効かせる。文書に行の `sync_groups` を入れ、検索のたびに呼んだ人の購読を条件にし、結果を Aurora で読み直して今の `sync_groups` と削除で落とす。抜粋はバージョンが同じときだけ返す。画面は手元の検索を先に出し、サーバーの結果を後から足す |
| [0032](../decisions/0032-single-policy-module-and-group-mapping.md) | 権限は `packages/policy` の純粋な関数 `can()` と `groupsFor()` にまとめ、全部の経路とクライアントが同じコードを使う。読む権限は「行の同期グループと購読が交わる」と同じ意味にし、書く権限と管理の権限は決定表で決める |
| [0033](../decisions/0033-team-visibility-changes-and-guests.md) | 同期グループに `members`（ゲストを除くメンバー）を足し、ゲストに届けないワークスペースの行をそこに置く。チームの行は公開なら `workspace`、非公開なら `team:<id>` と `role:admin`。非公開への切り替えは、同期に加えて、担当・購読者・通知・ビューの後始末を行う。管理者は非公開のチームに自分で参加でき、監査に残す |
| [0034](../decisions/0034-accounts-with-better-auth.md) | 認証は Better Auth を `packages/auth` で包んで使う。メールの OTP・Google・パスキー・セッション・複数のセッションの部品を使い、組織の部品は使わない。アカウントは RLS の外の `auth` スキーマ、ワークスペースの中の人は同期するモデルにし、`account_id` で結ぶ |
| [0035](../decisions/0035-sessions-and-sync-ticket.md) | セッションは HttpOnly のクッキーで、使わないまま 30 日で切れ、絶対の期限は置かない。ワークスペースへの入り口は同期のチケットで、発行の時にメンバーシップ・状態・ログインの制限を確かめる。取り消しと停止は Valkey で Gateway に知らせて 5 秒以内に切り、5 分ごとに確かめ直す。Electron はシステムのブラウザでログインし、PKCE の形でコードを交換する |
| [0036](../decisions/0036-notifications-derived-by-notifier.md) | 通知の行は確定の後に Worker（通知係）が作り、Writer のシステムのトランザクションで `Notification`（`user:<id>` のグループ）として書く。受け手は決定表と `can()` で決め、行は中身を持たず、冪等の鍵で 1 つの事象から 1 行だけを作る。既読とスヌーズは行の LWW のフィールドと既読の水位で持ち、同期で端末をまたいで揃える |
| [0037](../decisions/0037-notification-delivery-channels.md) | デスクトップの通知は同期で届いた行をクライアントが OS に出し、別の push の基盤を持たない。メールは種類の急ぎの度合いで待ちを決め、送る時に未読でスヌーズでない行だけを 1 通にまとめる。Slack の個人への通知は 30 秒待って未読なら送る。メールと Slack は送る時にもう一度 `can()` で確かめ、中身はそのときに読む |
| [0038](../decisions/0038-git-hosting-linking-and-state-automation.md) | GitHub は GitHub App、GitLab は顧客のトークンと署名付きの Webhook で受け、PR ごとの順で照合する。結び付けはブランチ名・タイトル・本文の語で決め、状態は前へだけ、複数の PR はそろってから進める。非公開のチームのイシューは、結び付いた利用者が書ける時だけ動かす |
| [0039](../decisions/0039-slack-app-issue-creation-and-channel-notifications.md) | Slack はワークスペースごとに 1 つのインストールで、トークンの入れ替えを有効にする。メッセージからの作成は結び付けた利用者が書けるチームにだけ行い、チャンネルへの通知とリンクの展開は公開のチームに限る。スレッドの同期は MVP の後にする |
| [0040](../decisions/0040-integration-installations-and-credential-storage.md) | 連携のインストールは管理者のグループのモデルに秘密なしで持ち、秘密は KMS の専用の鍵で包んだ暗号文をサーバーだけの表に置く。GitHub のインストールのトークンはメモリーだけに持ち、顧客の指定するホストへは egress の経路から送る |
| [0041](../decisions/0041-public-graphql-generated-schema-and-writer-mutations.md) | 公開の GraphQL は型を生成し、入口と mutation を手で書く。読み出しは同期グループの重なりで SQL で絞り、mutation は 1 つずつ Writer のトランザクションにする。複雑さは実行の前に数え、主体ごとの 1 時間の枠を超えたら 429 を返す |
| [0042](../decisions/0042-api-keys-oauth-apps-and-token-format.md) | API キーは 1 人の利用者に結び、範囲とチームで絞り、期限を 1 年までにする。OAuth のアプリは PKCE（S256）を必須にし、アクセストークン 24 時間、リフレッシュトークンは入れ替えと再利用の検出。トークンは `<brand>_` の接頭辞とチェックサムの形で、ハッシュだけを保存する |
| [0043](../decisions/0043-signed-webhooks-from-sync-log.md) | Webhook は `sync_actions` から作り、作った管理者の権限で送る時にも絞る。署名は時刻を含む `<Brand>-Signature`、5 秒で時間切れ、1 分・1 時間・6 時間で再試行し、24 時間失敗し続けたら止める。送信は egress の経路から |
| [0044](../decisions/0044-import-pipeline-staging-and-throttled-writer-commits.md) | 取り込みは段置きと対応付けと試しの実行の後に、Writer（`origin = import`）へ 200 変更の束で、ワークスペースの枠（1 秒 100 変更、ロックの待ちで半分）で書く。ID は元の記録から決まる UUIDv7 にし、やり直しを冪等にする。取り消しは 7 日、人が触れていない行だけ |
| [0045](../decisions/0045-export-by-permission-to-private-download.md) | 書き出しは頼んだ人の同期グループで絞って Worker が作り、S3 の非公開の場所に 24 時間置く。取り出しはセッションで本人を確かめてから 5 分の署名付きの URL へ転送し、メールには署名付きの URL を入れない |
| [0046](../decisions/0046-device-data-no-app-encryption-and-remote-wipe.md) | 手元の DB はアプリの層で暗号化せず、OS のディスクの暗号化に任せる。ログアウト・除外・遠隔の消去の指示で手元を消し、共有の端末には「この端末に保存しない」の入り方を置く。Electron のミニダンプを外へ送らない |
| [0047](../decisions/0047-audit-log.md) | 監査ログは、ワークスペースの監査（Aurora、1 年）とプラットフォームの監査に分け、Writer が対象の操作と同じ DB のトランザクションで書く。どちらも log-archive へハッシュの連鎖つきで写し、`sync_actions` を監査ログの代わりにしない |
| [0048](../decisions/0048-data-lifecycle-and-workspace-deletion.md) | 保持の期間を 1 つの表で持ち、時間で消える表はパーティションで落とす。ワークスペースの削除は 30 日の猶予の後に Aurora・OpenSearch・S3 から `workspace_id` で消し、バックアップは 35 日で消える。アカウントの削除は人を仮名にし、書いた中身は残す |
| [0049](../decisions/0049-accounts-network-and-service-placement.md) | アカウントとネットワークは他の題材の形を引き継ぎ、WebSocket も CloudFront → ALB を通す。Gateway は接続の数でスケールしてスティッキーにせず、Writer は内部だけ、顧客の指定する宛先への送信は egress の専用の経路にする |
| [0050](../decisions/0050-disaster-recovery-and-sync-epoch-bump.md) | 大阪にウォームスタンバイを置き、リージョンの切り替えは書き込みを止めてから昇格し、全ワークスペースの `sync_epoch` を上げてから書き込みを受ける。検索は 4 時間で戻し、失った範囲の外への副作用は取り消せないものとして扱う |
| [0051](../decisions/0051-workspace-sharding-and-cells.md) | S2 はワークスペースを単位に Aurora のクラスタへ分け、ディレクトリとアカウントを小さな共通のクラスタに置く。移動は `sync_id` を保ち `sync_epoch` を上げない。S3 はワークスペースをセルに固定し、セルごとに主のリージョンを持つ |
| [0052](../decisions/0052-rum-and-propagation-measurement.md) | RUM は自前の口に、端末で集めたヒストグラムを送り、中身と識別子を送らない。伝播は Writer のコミットの直前の時刻を差分と一緒に運び、クライアントは ping の往復で見積もった時計の差で「確定から適用まで」を測る |
| [0053](../decisions/0053-convergence-audit.md) | 収束の監査は、抜き取った端末が IndexedDB の確定した行のハッシュを桶ごとに `(L, sync_epoch)` と送り、サーバーは今の行と `sync_actions` から `L` の時点の状態を作り直して比べる。合わない桶は 2 段目で行を特定し、説明のつかない不一致を K5 に数える |
| [0054](../decisions/0054-per-workspace-write-admission.md) | 1 ワークスペースの書き込みを `origin` ごとの枠で割り当てる。`client` を最優先にして数えず、`api`・`worker`・`notifier`・`import` を Writer がロックの前に数え、ロックの待ちが伸びたら `client` 以外を半分にする |
| [0055](../decisions/0055-ci-gates-latency-convergence-ime.md) | PR の必須の関門に、遅延の予算（固定の機械）、収束のシミュレーターと回帰の種、オフラインと再送の 3 つの場面、IME のテスト、生成とマイグレーションの検査を入れ、変更のパスで重さを足す。関門を外すラベルを持たず、シミュレーターの失敗を再実行で緑にしない |
| [0056](../decisions/0056-flags-client-distribution-and-min-build.md) | クライアントのフラグはサーバーが評価して握手で配り、同期の意味はフラグにしない。Web は `index.html` を端末の桶ごとに段階的に切り替え、Electron は更新の案内を端末の桶で返す。最低のバージョンは Gateway の `min_build` で殻とレンダラーの組で強制し、手元の読み書きは止めない |
| [0057](../decisions/0057-schema-change-ordering.md) | スキーマの変更は、サーバーの DB を広げる → サーバーが古い形と新しい形の両方を受ける → クライアントを移す → 古い `schema_hash` の接続が 1% 未満かつ 30 日の後に縮める → 古い列を単独で消す、の順にする。1 つのデプロイで、DB の破壊の変更とそれを読むコードを一緒に出さない |
| [0058](../decisions/0058-dr-permission-narrowing-journal.md) | 権限を狭める操作は、Aurora に加えて、東京の中で同期して複製する追記だけの記録にも書き、大阪へ送る。大阪への昇格では、書き込みを受ける前に、失った範囲の記録をやり直す |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を核に使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **収束しない不具合**：競合の規則、載せ直し、差分の欠けの検出、派生（`derive`）のどれかの誤りで、クライアントの状態がサーバーとずれ続ける。利用者は再読み込みまで気づかない。決定的なシミュレーター（[ADR-0010](../decisions/0010-deterministic-sync-simulator.md)。PR ごとに 2,000 の列、夜間に 20 万の列）と、本番の収束の監査（[ADR-0053](../decisions/0053-convergence-audit.md)。説明のつかない不一致 0 件）で抑える。
- **非公開のデータの漏れ**：同期グループの判定の漏れは、クライアントの IndexedDB にデータが残る形で漏れる。画面に出なくても漏えいである。読む権限を「行の同期グループと購読が交わる」の 1 つの定義にし（[ADR-0032](../decisions/0032-single-policy-module-and-group-mapping.md)）、差分・ブートストラップ・検索・ビューの問い合わせ・通知・Webhook・書き出し・連携を同じ関数で絞る。性質ベーステストと配信の監査（[observability.md](observability.md) の 4.4 節）で確かめる。複数のグループの和に入る行（関連、プロジェクト）は ID だけを持つ。
- **DR で失う権限の変更**：リージョンの切り替えで失った範囲（RPO 1 分以内）の停止・非公開への切り替え・取り消しが戻ると、除外した人の端末へ、やり直しのブートストラップでデータが届く。権限を狭める操作を別の追記だけの記録に書き、書き込みを受ける前にやり直す（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)）。残る窓は、その記録の大阪への複製の遅延（DynamoDB のグローバルテーブルの既定の形では、ふつう 1 秒以内。[DynamoDB read consistency](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.ReadConsistency.html)、2026-09-28 に確認）。
- **1 ワークスペースの書き込みの直列化**：`sync_id` を振る行のロックが、大きなワークスペースの書き込みの上限（1 秒 300 変更の見込み）になる。`origin` ごとの枠（[ADR-0054](../decisions/0054-per-workspace-write-admission.md)）で、利用者の書き込みを優先する。E2 の PoC で上限を測り、届かなければ楽観的な検証か group commit の ADR を書く。
- **大きなワークスペースのメモリーと起動**：イシュー 50 万件を手元に持つと、ブラウザのメモリーと IndexedDB の読み込みが重い。部分のブートストラップと遅延の読み込み（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)）、メモリーの 3 層（[ADR-0016](../decisions/0016-memory-tiers-quota-and-offline-ux.md)）で抑える。基準の端末での計測を CI に入れる（[ADR-0055](../decisions/0055-ci-gates-latency-convergence-ime.md)）。IndexedDB の一括の書き込みが NFR-003 に間に合うかは未検証で、E3 の前の `bootstrap-poc` で測る。
- **長いオフラインの上書き**：オフラインの間の変更は、確定の順で LWW になり、他の人の新しい変更を上書きしうる（本家の文書と同じ性質）。上書きを履歴に残し、本人に知らせる（[ADR-0008](../decisions/0008-conflict-rules-and-fractional-keys.md)）。イシューとプロジェクトの説明は CRDT で合わせる（[ADR-0021](../decisions/0021-description-crdt-yjs-in-sync-log.md)）。コメントは作った人だけが書くので LWW にする（[ADR-0022](../decisions/0022-comments-anchors-mentions-attachments.md)）。
- **クライアントのバージョンの混在**：古いバージョンのクライアントが、新しいスキーマのサーバーへ outbox を送る。トランザクションの形のバージョンと `upcast` を持ち、サーバーが 1 つ前のバージョンを 30 日受ける。スキーマの変更は広げる・移る・縮める・消すの順（[ADR-0057](../decisions/0057-schema-change-ordering.md)）。手元の DB のバージョンを上げるリリースは戻せないので、機能の変更と別にする（[ADR-0056](../decisions/0056-flags-client-distribution-and-min-build.md)）。
- **ブラウザの保存の消去**：ブラウザが IndexedDB を消すと、未送信の outbox が失われる。永続の保存の許可を求め、Electron を勧め、失った件数をサーバーのクッキーの端末の ID で示す（[ADR-0016](../decisions/0016-memory-tiers-quota-and-offline-ux.md)）。
- **データ転送の費用**：差分の送信が圧縮なしで月に約 230 TB と見積もられ、費用の最大の不確かさである。差分の流れに permessage-deflate を使い（[ADR-0009](../decisions/0009-sync-gateway-protocol.md) の注記）、E12 で測る（[infrastructure.md](infrastructure.md) の 11 節）。
- **IME**：日本語の変換の途中の `Enter`・`Esc` でショートカットが動くと、意図しない変更が送られる。DT-APP-001 と OS × IME × ブラウザの手動の確認で抑える（[ADR-0017](../decisions/0017-keymap-command-menu-and-ime.md)）。
- **外部の連携の変化**：GitHub・GitLab・Slack の API とイベントの形の変更に追従が要る。取りこぼしは再送と読み直しで埋める（[ADR-0038](../decisions/0038-git-hosting-linking-and-state-automation.md)）。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L8）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-09-28、既定案）

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。計測・PoC で決めるものは、下の「持ち越し」に置いた。どれも E1〜E12 の PoC・試験で覆りうる。

- **検索**：S1 から OpenSearch（[ADR-0030](../decisions/0030-search-engine-opensearch.md)）。4 節の技術スタックの「S1 は PostgreSQL の全文検索」を直した。
- **Slack**：チャンネルへの通知とリンクの展開は公開のチームだけ。スレッドの同期は MVP の後（[ADR-0039](../decisions/0039-slack-app-issue-creation-and-channel-notifications.md)）。1.1 節と 7 節を直した。
- **同期グループの種類**：`workspace`・`members`・`team:<id>`・`user:<id>`・`role:admin` の 5 つ。`members`（ゲストを除くメンバー）は ADR-0033 で足した。非公開のチームのモデルは `team:<id>` だけ。モデルごとの規則は `workspace`・`workspace_members`・`team`・`team_or_workspace`・`team_row`・`via`・`user`・`admin`・`teams`・`view_scope`（[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節）。
- **`teams` の規則**：行の中のチームの ID の集合から読むと、公開のチームの人に非公開のチームの ID が届く。結び付けのモデル `ProjectTeam` の行から読む形に替えた（ADR-0003 の注記、ADR-0033）。
- **コメントの本文**：LWW（ADR-0022）。ADR-0002 の競合の表を直し、日付付きの注記を残した。
- **並びの鍵の振り直し**：窓（65 個から最大 1,024 個）で振り直す（ADR-0008）。墓標（ADR-0012）と `sync_epoch`（ADR-0013）とあわせて、ADR-0002・0003 に注記を残した。
- **outbox の `done`**：確定を確かめた後 15 分残し、DR のやり直しで送り直す（ADR-0014）。NFR-007 の「outbox に残っていれば送り直される」を、確定の後 15 分にも広げる。ADR-0005 に注記を残した。同期グループから外れたときの未確定のトランザクションは、サーバーが拒否するまで outbox に残す。
- **自動の処理の流量**：自動で閉じる・アーカイブ・繰り越しは `worker` の枠（1 ワークスペース 1 秒 50 変更）に従い、開始の時刻を散らす（ADR-0023・0026 の注記）。
- **通知係の書き込み**：通知係は `worker` と別の `notifier` の枠（1 ワークスペース 1 秒 50 変更、瞬間 500）で書く。インボックスの行は安く、受け手のグループだけに届くので、受け手ごとに 5 秒に 1 回のトランザクションにまとめる（[ADR-0054](../decisions/0054-per-workspace-write-admission.md) の注記、[capacity.md](capacity.md) の 2.2 節、[notifications-and-inbox.md](notifications-and-inbox.md) の 5.5 節）。自動の処理と通知が同じ枠を取り合わない。
- **やり直しの散らし**：既定 10 分、DR では `ops.epoch_reset_spread_min` で 30 分まで（ADR-0013 の注記）。
- **DR の権限の変更**：権限を狭める操作を DynamoDB のグローバルテーブルに追記し、昇格の後、書き込みを受ける前にやり直す（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)。Auth0 の題材の考え方に倣う）。
- **permessage-deflate**：差分の流れに使う。窓 4 KiB の文脈の持ち越し。E12 で、持ち越しなしと比べて確定する（ADR-0009 の注記）。
- **`Workspace` の持ち主**：permissions-and-teams。`Workspace`（`workspace` のグループ）と `WorkspaceSettings`（`members` のグループ）に分けた（[permissions-and-teams.md](permissions-and-teams.md) の 3.3 節）。
- **RLS の外の表**：`sync_outbox`・`client_devices`・`narrowing_outbox` だけを足し、`workspaces`・`oauth_apps` のコンテキストの前の読み出しは関数にした（[data-model.md](data-model.md) の 5 節）。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。保持の期間は [security.md](security.md) の 9 節。1 ワークスペースの書き込みの枠は [capacity.md](capacity.md) の 2.2 節。公開 API の枠は [api-and-webhooks.md](api-and-webhooks.md) の 4.2 節。クライアントの上限（outbox 5 万件・100 MiB、M1 5 万個）は [client-store-and-offline.md](client-store-and-offline.md) の 5.3・7.2 節。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。
- **検証の後の PM の決定（2026-09-28。推奨案）**：
  - **招待**：`members_can_invite` の既定を偽（管理者だけ）にした。本家の有料のプランの既定と同じで、B2B で安全な既定にするため（[permissions-and-teams.md](permissions-and-teams.md) の 3.3 節の注記）。
  - **手動のアーカイブ**：残す。本家はアーカイブを自動だけにするが、利用者が自動のアーカイブを待たずに片付けられるようにする。本家との意図した差異（[issues-and-workflow.md](issues-and-workflow.md) の 2・18 節）。
  - **イニシアチブの複数の親**：MVP の後。MVP は親を 1 つにする（[cycles-and-projects.md](cycles-and-projects.md) の 3.7・12 節）。
  - **見積もりのキー**：`E`（本家は `Shift+E`）のまま、法務の L8 の後に見直す（下の持ち越し）。
- **検証の工程での直し（2026-09-28）**：未検証の項目を公式の資料で確かめ、次を直した。本文のスキーマにノードを足すのは破壊の変更にし、`min_build` を先に上げる（y-prosemirror が知らないノードを共有の文書から消すため。ADR-0057 の注記、[editor-and-descriptions.md](editor-and-descriptions.md) の 3.2 節）。自動で閉じる・アーカイブに、本家の文書の除外の条件（進行中のサイクル・未完了のプロジェクト、期日、サブイシュー、親）を足した（ADR-0023 の注記）。データ転送の費用を CloudFront の日本の単価で見積もり直した（[infrastructure.md](infrastructure.md) の 11 節）。
- **データモデルの統合（2026-09-28）**：データモデルを [data-model.md](data-model.md) と [data-model/](data-model/) に集め、形（表・列・キー・索引）の正本にした。欠けていた `ProjectDescription`・`attachment_purges`・`audit_export_checkpoints` を足し、共通の列に `updated_at`、`trash` のモデルに `trashed_at`、定義の型に `bytes` を足した。日ごとのパーティションの表の一意の守り方（`tx_results` はロックの中の先の引き、`notification_keys`・`webhook_deliveries` は事象の日で分割）を決めた。コンテキストの前の関数 `resolve_api_credential`・`resolve_integration_target`・`scheduler_due_items`・`auth.upsert_workspace_directory` を起票した（セキュリティの担当の承認待ち）。一覧は [data-model.md](data-model.md) の 7 節。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L8） | [intent.md](../intent.md) の「法務の確認待ち」、[security.md](security.md) の 13 節。結論まで、そこに挙げた Story の spec を承認しない |
| 反応型のストア（MobX か自前か） | E2 の前の `memory-tiers-poc`。イシュー 50 万件での一覧の描画、フィルターの再計算、メモリー |
| 1 ワークスペースの書き込みの上限（1 秒 300 変更）、楽観的な検証・group commit の要否 | E2 の前の `writer-throughput-poc`、E12 の負荷試験 L3 |
| 全体と部分のブートストラップの閾値（5 万件）、やり直しの閾値（5 万件）、部分の条件（30 日） | E3 の PoC（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)） |
| IndexedDB の一括の書き込みが NFR-003 に間に合うか（だめなら SQLite の WASM） | E3 の前の `bootstrap-poc` |
| 同期のログの保持の期間（30 日） | E3。法務の L5 の後に確定する |
| 見積もりのキー（本システムは `E`、本家は `Shift+E`） | 法務の L8 の後（[client-app.md](client-app.md) の 5 節） |
| permessage-deflate の文脈の持ち越しの採否、データ転送の量 | E12 の負荷試験 |
| OpenSearch の費用と型、1 文字の N-gram の索引の大きさ | E8 の `search-poc` |
| 本家の振る舞いで未確認のもの（同期のログの保持、本文の CRDT の部品、可用性の SLA の値） | 公式の資料で確かめられなかった。未検証のまま、本システムの値を使う（`lastSyncId` が全体で共通なことは第三者の解析で確かめた。1.3 節） |

## 7. 領域の文書

領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [sync-engine.md](sync-engine.md) | オブジェクトプールとモデルの登録、トランザクション（作成・更新・削除・アーカイブ・解除）、Writer の検証と適用、`sync_id` の振り方、`sync_actions` のログ、差分の形と配信、欠けの検出、載せ直し（rebase）、フィールドの型ごとの競合の規則、分数インデックスの鍵、Sync Gateway のプロトコル、冪等性、決定的なシミュレーター | 0006–0010 | QA（収束の性質） | E2 |
| [bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) | 全体・部分・手元からのブートストラップ、ストリームの形、遅延の読み込みと部分の索引、同期グループの一覧と変化（参加・脱退・非公開への切り替え）、権限を失ったときの手元の消去、ログの保持の外に出たときのやり直し、`sync_epoch` | 0011–0013 | QA、セキュリティ | E3 |
| [client-store-and-offline.md](client-store-and-offline.md) | IndexedDB の構成、outbox、複数のタブ（書くタブの選出と、タブの間の通知）、手元の DB のスキーマの移行、保存の消去への備え、メモリーの上限とモデルの遅延の復元、オフラインの表示 | 0014–0016 | QA | E3 |
| [client-app.md](client-app.md) | React の画面、キーボードのショートカットとコマンドメニュー、IME、大きな一覧の仮想化、遅延の予算の計測、Electron のシェル（通知、ディープリンク） | 0017–0018 | QA | E6 |
| [data-model-and-schema.md](data-model-and-schema.md) | モデルの定義の言語（フィールドの型、参照、競合の種類、読み込みの方針、同期グループ）、そこからの生成（DB、クライアント、GraphQL、検証）、スキーマのバージョンと後方互換、ID と識別子（`ENG-123`） | 0019–0020 | QA | E1、E2 |
| [editor-and-descriptions.md](editor-and-descriptions.md) | リッチテキストのエディタ、本文の CRDT、同期のログとの載せ方、コメント、メンションと参照、添付ファイルの保存、インラインのコメント | 0021–0022 | QA | E5 |
| [issues-and-workflow.md](issues-and-workflow.md) | イシュー、ワークフローの状態と種類、優先度、ラベルとグループ、見積もりの尺度、担当、親子と関連、重複、Triage、自動で閉じる・アーカイブする、テンプレート、履歴、派生の変更 | 0023–0025 | QA | E5 |
| [cycles-and-projects.md](cycles-and-projects.md) | サイクル（期間、クールダウン、繰り越し、自動の追加、タイムゾーン）、プロジェクト（状態、マイルストーン、進捗の更新）、イニシアチブ、進捗の集計 | 0026–0027 | QA | E7 |
| [views-and-filters.md](views-and-filters.md) | フィルターの言語（クライアントの手元の評価と、サーバー・API の評価で同じ結果）、グループ化と並べ方、保存したビュー、一覧とボード、手元にないデータを含むビューの扱い | 0028–0029 | QA | E8 |
| [search.md](search.md) | 全文検索（日本語）、索引の更新、権限での絞り込み、手元の検索とサーバーの検索の組み合わせ | 0030–0031 | QA、Ops | E8 |
| [permissions-and-teams.md](permissions-and-teams.md) | ワークスペースの行と設定（`Workspace`）、ワークスペースのロール（オーナー・管理者・メンバー・ゲスト）、チームとメンバー、非公開のチーム、`can()`、同期グループとの対応、権限の変化の配り方 | 0032–0033 | セキュリティ | E4 |
| [accounts-and-auth.md](accounts-and-auth.md) | アカウント（1 人が複数のワークスペース）、ログイン（メールのリンク・コード、Google、パスキー）、セッション、同期のチケット、Electron のログイン、招待。後の SAML・SCIM | 0034–0035 | セキュリティ | E4 |
| [notifications-and-inbox.md](notifications-and-inbox.md) | 購読、インボックス、通知の種類と既読、メール・デスクトップの通知、まとめて送る、Urgent の扱い、Slack の個人への通知 | 0036–0037 | QA | E9 |
| [integrations.md](integrations.md) | GitHub・GitLab（インストール、Webhook の受信、ブランチ名・タイトル・閉じる語での結び付け、状態の自動化）、Slack（チャンネルへの通知、メッセージからの作成、リンクの展開。スレッドの同期は MVP の後）、連携の資格情報の保管 | 0038–0040 | セキュリティ、Ops | E10 |
| [api-and-webhooks.md](api-and-webhooks.md) | 公開の GraphQL（スキーマ、ページング、アーカイブを含める、複雑さとレート制限）、API キーと OAuth 2.0 のアプリ、Webhook（対象のモデル、署名の `<Brand>-Signature`、再試行、停止の条件） | 0041–0043 | QA、Ops | E11 |
| [import-export.md](import-export.md) | インポート（Jira、GitHub Issues、Asana、Shortcut、CSV）、利用者の対応付け、一括の書き込みと同期のログ、やり直しと取り消し、書き出し（CSV・JSON） | 0044–0045 | QA | E11 |
| [security.md](security.md) | 脅威モデル、手元の DB のデータの扱い（ログアウトでの消去、共有の端末）、暗号化、監査ログ、データのライフサイクル（アーカイブ・削除・解約）、脆弱性の対応、法務の論点の整理 | 0046–0048 | セキュリティ | E1、E12 |
| [data-model.md](data-model.md)（と [data-model/](data-model/)） | データモデルの正本：規約、ER 図、86 表の列・キー・索引・保持、DB の外のストアの形、横断の不変条件 | なし（各領域の ADR を参照する） | QA | 全 Epic |
| [infrastructure.md](infrastructure.md) | AWS のアカウントとネットワーク、サービスの分け方、Sync Gateway の配置と再接続の殺到への備え、冗長化、DR（`sync_epoch` と狭める操作のやり直し）、段階を上げる基準、S2 のワークスペースのシャード、S3 のセルとリージョン、コスト | 0049–0051、0058（統合の工程で足した） | Ops | E1、E12 |
| [observability.md](observability.md) | ログ・メトリクス・トレース、クライアントの RUM（遅延の予算）、同期の伝播の計測、収束の監査、配信の監査、SLI | 0052–0053 | Ops | E1、E12 |
| [capacity.md](capacity.md) | 負荷のモデル（接続、書き込み、ブートストラップ）、1 ワークスペースの書き込みの上限と割り当て、部品ごとの必要量、負荷試験 L1〜L9 | 0054 | Ops | E12 |
| [delivery.md](delivery.md) | CI/CD、遅延の予算と収束のテストを CI に入れる、フラグ、Web のクライアントの配布、Electron の自動更新と最低のバージョン、サーバーとクライアントのスキーマの変更の順序 | 0055–0057 | QA、Ops | E1、E12 |

- 次に採番する ADR は 0059。統合の後に足す ADR は、関わる領域の行に番号を書き足す。

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。E1〜E12 が MVP（S1）。E13 以降と、延期の一覧も roadmap.md にある。各 Epic の品質の重点と合否基準は [quality.md](../quality.md) の 5 節にある。

# Infrastructure: Figma

AWS の上の構成、アカウント、ネットワーク、Gateway と Document Server の置き方、Router と割り当ての記録、データの基盤、冗長化と大阪への災害復旧、段階の移行、Terraform の構成、費用。Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) を土台にし、マルチプレイヤーに固有の事情だけを変える（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

| ADR | 決定 |
| --- | --- |
| [0046](../decisions/0046-multiplayer-compute-on-fargate-with-drain.md) | Gateway と Document Server は ECS Fargate（ARM64）。Document Server はタスクの保護と自前のドレインでファイルを渡してから止める。WebSocket は CloudFront と ALB で受ける |
| [0047](../decisions/0047-router-task-liveness-and-file-assignment.md) | Router は、タスクごとの生存の記録とファイルごとの割り当ての記録を分ける。手放しの記録、回復のジョブ、削除済みの割り当て |
| [0048](../decisions/0048-osaka-dr-with-journal-generations.md) | 大阪への DR は、グローバルテーブル（MREC）・S3 の複製・Aurora の Global Database と縮小したウォームスタンバイ。切り替えのたびに世代を上げ、ジャーナルとチェックポイントのキーを分ける |
| Slack の ADR-0011・0020・0021・0022・0026 | 実行基盤、Terraform、可観測性の道具、無停止のデプロイ、フラグを引き継ぐ |

ログ・メトリクス・SLI は [observability.md](observability.md)、負荷と台数の根拠は [capacity.md](capacity.md)、CI とリリースは [delivery.md](delivery.md)、暗号化と鍵は [security.md](security.md) にある。数値のうち「初期見積もり」と書いたものは、負荷試験（E12）の前の仮の値である。AWS の仕様で確かめられていないものは「未検証」と書く。

## 1. AWS アカウント

AWS Organizations で、用途ごとにアカウントを分ける。Slack・Stripe と同じ形にする。

| アカウント | 中身 |
| --- | --- |
| management | Organizations、SCP、IAM Identity Center、請求 |
| security | GuardDuty・Security Hub・Inspector の委任管理者、調査用の役割 |
| log-archive | 組織の CloudTrail、Config、VPC フローログ、監査のアーカイブ（Object Lock。[security.md](security.md) の 6 節） |
| shared | ECR（東京と大阪へ複製）、Route 53、Managed Grafana、CI の起点、ビルドごとの WASM の名前の表（[ADR-0049](../decisions/0049-client-telemetry-without-content.md)） |
| dev、staging | 開発・検証の環境。staging は負荷試験と DR の訓練に使う |
| prod | 本番。東京（ap-northeast-1）と大阪（ap-northeast-3） |

- SCP で、東京・大阪以外のリージョンを禁止する（CloudFront・WAF・ACM のための us-east-1 を除く）。CloudTrail・Config・GuardDuty の停止、KMS の鍵の削除の予約を、break-glass の役割以外に禁止する。
- 利用者のコンテンツのドメイン（`<brand>usercontent.<domain>`）は、prod の中の別の CloudFront と別のバケットで配る。アカウントは分けない（権限の分離は鍵とバケットのポリシーで足りる）。

## 2. ネットワーク

リージョンごとに、3 AZ にまたがる VPC を 1 つ持つ。

| サブネット | 置くもの | インターネットへの経路 |
| --- | --- | --- |
| public | ALB、NAT ゲートウェイ | Internet Gateway |
| private | Gateway、Document Server、Router、API、Realtime、Worker、Render Worker、file-read、telemetry の受け口 | NAT 経由（許可の一覧の宛先だけ）。Render Worker と Document Server は経路を持たない |
| isolated | Aurora、Valkey | なし |

- 入口は CloudFront → ALB だけ。ALB は CloudFront のマネージドプレフィックスリストだけを受ける。
- VPC エンドポイント：S3（ゲートウェイ型）、DynamoDB（ゲートウェイ型）、SQS、ECR、Secrets Manager、KMS、CloudWatch Logs、STS、X-Ray、AppConfig。Document Server は、ジャーナル・S3・KMS へエンドポイントだけで届く。
- 外部の URL へ出るもの（画像の URL の取り込み `asset-fetch`、Webhook の `webhook-egress`）は、VPC の外の Lambda に置く（[export-and-assets.md](export-and-assets.md) の 9 節、[api-and-webhooks.md](api-and-webhooks.md) の 6.4 節）。
- **AZ をまたぐ通信を減らす。** Router は、Gateway と同じ AZ の Document Server を優先して割り当てる（空きがあれば）。1 つのファイルの参加者は複数の AZ の Gateway にいるので、完全には避けられない。

## 3. 実行基盤

すべて ECS Fargate。Rust のサービスは ARM64（Graviton）、Render Worker だけ x86-64（lavapipe の動作の確認のため。[rendering-engine.md](rendering-engine.md) の 12 節）。

| サービス | 言語 | 役割 | スケールの指標 | 最小タスク数 |
| --- | --- | --- | --- | --- |
| gateway | Rust | WebSocket の終端、チケット、配信（[multiplayer.md](multiplayer.md) の 3 節） | 接続の数（1 タスク 1 万まで）、CPU 60% | 9（AZ ごとに 3。1 AZ を失っても 6 万接続。[capacity.md](capacity.md) の 2 節） |
| ds-standard | Rust | Document Server（ふつうのファイル） | メモリの予約（[ADR-0051](../decisions/0051-document-server-memory-admission.md)）、ファイルの数 | 12（AZ ごとに 4） |
| ds-large | Rust | Document Server（見積もり 1.5 GiB を超えるファイル） | 同上 | 3（AZ ごとに 1） |
| router | Rust | 割り当て、ドレインの制御、回復のジョブ（5 節） | CPU 50% | 3 |
| api | TypeScript | 認証、メタデータ、判定関数、チケットの発行 | CPU 50%、同時の要求 | 6 |
| realtime | TypeScript | メタデータの購読（[comments-and-notifications.md](comments-and-notifications.md) の 5 節） | 接続の数、CPU | 3 |
| workers | TypeScript | 通知、メール、検索の索引、掃除、完全な削除、`dr-salvage` | SQS の最古のメッセージの経過時間 | キューごとに 1〜2 |
| render-worker | Rust | 書き出し、サムネイル（[export-and-assets.md](export-and-assets.md) の 5 節） | `render-export`・`render-thumbnail` の滞留 | 2 |
| file-read | Rust | 公開 API のファイルの中身（MVP の後。[api-and-webhooks.md](api-and-webhooks.md) の 2 節） | CPU | 0（MVP）、2（公開後） |
| telemetry-ingest | TypeScript | クライアントの計測の受け口（[observability.md](observability.md) の 3 節） | CPU | 2 |

### 3.1 Document Server の止め方（ドレイン）

[ADR-0046](../decisions/0046-multiplayer-compute-on-fargate-with-drain.md) による。

```
デプロイ・縮小・退役の通知
   ▼
router（ドレインの制御）
   ├─ 古いタスクの ds_liveness.state = draining（新しいファイルを置かない）
   ├─ 古いタスクのファイルを、大きい順に毎秒 20 ずつ、新しいタスクへ渡す
   │     古い持ち主：受け付けを止める → ジャーナルを書き切る → file_leases.state = handoff
   │     router：新しい持ち主を割り当てる（epoch + 1）
   │     新しい持ち主：フェンス → チェックポイント＋ジャーナルから回復 → 受け付け
   │     Gateway：Kick(owner_changed) → クライアントが resume で再接続
   └─ ファイルが 0 になったタスクは、タスクの保護を外す → ECS が止める
```

- Document Server は、ファイルを 1 つでも持つ間、ECS のタスクの保護を立てる（期限 60 分、10 分ごとに延ばす）。保護のあるタスクは、ローリングの更新でも止められない（[Task scale-in protection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html)、2026-09-27 に確認）。サービスの `maximumPercent` を 200% にし、新しいタスクが先に起動できるようにする。
- SIGTERM を受けたら（保護の期限切れや強制の停止）、`stopTimeout`（120 秒）の中で、できるだけ渡す。渡せなかったファイルは、生存の期限と回復で拾う（NFR-007）。
- Fargate の退役の通知（AWS Health → EventBridge）を受けたら、待つ期間（14 日に設定）のうちの平日の昼に、ドレインで入れ替える（[Task retirement and maintenance for AWS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-maintenance.html)、2026-09-27 に確認）。EC2 のイベントの時間帯（2025-12-18 から Fargate に使える）で、退役の時刻を平日の昼に寄せてもよい（同上）。タスクの保護は、オートスケールの縮小とデプロイだけを防ぐと書かれている（[Task scale-in protection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-scale-in-protection.html)）。退役は保護を待たない前提にし、ドレインが間に合わなければ生存の期限と回復（NFR-007）で拾う。

## 4. 入口と WebSocket

| 名前 | 経路 | 中身 |
| --- | --- | --- |
| `app.<brand>.<domain>` | CloudFront → S3（静的）・ALB（`/api`） | Web の画面、WASM、内部の API |
| `mp.<brand>.<domain>` | CloudFront → ALB → gateway | マルチプレイヤーの WebSocket |
| `rt.<brand>.<domain>` | CloudFront → ALB → realtime | メタデータの購読の WebSocket |
| `api.<brand>.<domain>` | CloudFront → ALB → public-api | 公開 API（MVP の後） |
| `telemetry.<brand>.<domain>` | CloudFront → ALB → telemetry-ingest | クライアントの計測 |
| `assets.<brand>usercontent.<domain>` | CloudFront → S3 | 画像・フォント・書き出し（署名付き URL） |
| `files.<brand>usercontent.<domain>` | CloudFront → S3 | チェックポイントのチャンク（署名付き URL。[file-storage-and-history.md](file-storage-and-history.md) の 6.1 節） |
| `plugin-ui.<brand>usercontent.<domain>` | CloudFront → S3 | プラグインの UI とコード（MVP の後） |

- チャンクの配信のドメインを、画像と分けて `files.<brand>usercontent` にする。チャンクはブラウザが `fetch` で読むバイナリで、画面に出すものではないが、同じく Cookie を持たないドメインから配る。
- **WebSocket の期限**：
  | 部品 | 期限 | 設定 |
  | --- | --- | --- |
  | クライアント | 20 秒ごとに `Ping` | [multiplayer.md](multiplayer.md) の 4.2 節 |
  | CloudFront | WebSocket に固有のアイドルの期限は資料にない。オリジンの応答の期限（既定 30 秒。オリジンからの次のパケットまで）を 60 秒にする。応答の完了の期限は設定しない（[Origin settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html)、2026-09-27 に確認） | 応答の期限が WebSocket のフレームに効くか、接続の長さの上限は **未検証**。E3 の `gateway-edge-websocket` の PoC で 8 時間切れないことを確かめる |
  | ALB | アイドル 300 秒（既定 60 秒、1〜4,000 秒で変えられる） | [ALB の属性](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html)、2026-09-27 に確認 |
  | Gateway | 60 秒 `Ping` がなければ切る。20 秒のあいだ送っていない接続に `Pong` を送る（CloudFront の応答の期限の中にオリジンからのパケットを置く） | アプリ |
- ALB は、WebSocket の接続を確立したターゲットに固定する。ターゲットの選び方は「未処理の要求が最も少ない」で、接続の数では選ばない（[ターゲットグループの属性](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html)、2026-09-27 に確認）。Gateway の間で接続の数が偏ったら、多い Gateway が新しい接続に `Kick(overloaded, retry_after_ms)` を返して、再接続で散らす。
- **Gateway の入れ替え**：登録解除の遅延を 180 秒にし、その間に接続を `Kick(server_shutdown)` で少しずつ切る（Slack の [ADR-0022](../../../slack/docs/decisions/0022-zero-downtime-deploy-and-migrations.md) の Gateway の形）。`retry_after_ms` を 0〜60 秒に散らす。1 回に入れ替えるのは全体の 10%。

## 5. Router と割り当て

[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md) による。ジャーナルのフェンスは [file-storage-and-history.md](file-storage-and-history.md) の 4.4 節（[ADR-0024](../decisions/0024-journal-items-and-fencing.md)）。

### 5.1 表

```
ds_liveness（DynamoDB、リージョンごと。グローバルテーブルにしない）
  PK task_id
  incarnation      S   // 起動ごとの乱数
  pool             S   // ds-standard | ds-large
  az, addr         S
  state            S   // active | draining | full
  expires_at_ms    N   // 2 秒ごとに now + 10 秒へ延ばす
  files, mem_used, mem_budget, conns   N
  TTL              N   // expires_at + 1 日

file_leases（DynamoDB、グローバルテーブル）
  PK file_id
  org_id           S   // ファイルを持つ組織。割り当てのときに Gateway がチケットから渡す。Document Server と回復のジョブが Aurora の文脈に使う
  state            S   // owned | handoff | released | deleted
  owner_task       S
  owner_incarnation S
  epoch            N   // 割り当てごとに + 1。ジャーナルのフェンスの epoch と同じ値
  region_gen       N   // ADR-0048
  assigned_at, released_at   N
  released_seq     N   // released・handoff のときの durable_seq
  recover_then_release BOOL // 回復のジョブの割り当て（ADR-0047。回復してチェックポイントを書き、released にする）
  gsi_owner        S   // owned・handoff の間だけ owner_task（疎な GSI by_owner のキー）
  TTL              N   // deleted のときだけ、400 日後
```

- `file_leases` の書き込みは、割り当て・手放し・削除のときだけ。延長はしない。
- `ds_liveness` をグローバルテーブルにしない理由：タスクの生存はリージョンの中の事実で、大阪へ複製しても使わない。

### 5.2 流れ

| 場面 | 手順 |
| --- | --- |
| 開く | Gateway → router `owner(file_id, org_id, size_hint, az)`（`org_id` はチケットの値。割り当てで `file_leases` に書く）。`file_leases` を強い整合性で読む。`owned` で持ち主が生きていれば返す。`deleted` なら `gone`。それ以外は、空きのあるタスクを選び（[ADR-0051](../decisions/0051-document-server-memory-admission.md)）、`UpdateItem ... SET epoch = epoch + 1 ... IF epoch = :old`（初めてなら `attribute_not_exists`）。選んだタスクへ `open_file(file_id, epoch)` を送る |
| 持ち主が生きているかの判定 | `ds_liveness[owner_task]` があり、`incarnation` が一致し、`expires_at_ms + 2 秒 > now` |
| きれいに手放す | Document Server がチェックポイントを書いた後（`durable_seq` まで）、`SET state = released, released_seq = :s REMOVE gsi_owner IF owner_task = :me AND epoch = :e` |
| 渡す（ドレイン） | ジャーナルを書き切った後、`SET state = handoff, released_seq = :s IF ...`。router がすぐに次の持ち主を割り当てる |
| 落ちた | `ds_liveness` の期限が切れる。次に開く要求で割り当て直される。誰も開かなければ回復のジョブ（5.3 節） |
| 完全な削除 | 削除のジョブの最初の手順で `SET state = deleted, epoch = <最大値> REMOVE gsi_owner`。以後 router は割り当てない |

- 割り当ての後、新しい持ち主はジャーナルのフェンスを `epoch` で上げてから回復する。フェンスが最後の防御である（ADR-0024）。
- router は延長の経路にいない。router が止まると新しく開けなくなるが、開いているファイルは続く。
- 持ち主の対応は Valkey（30 秒）と Gateway のプロセスの中に持つ。Document Server への接続が失敗したら取り直す。

### 5.3 回復のジョブと見張り

ADR-0024 が求める「手放さずに落ちたファイルを 5 分以内に回復させる」を、router の中のループで行う。

1. 30 秒ごとに `ds_liveness` を読む（タスクの数だけの小さな表）。期限の切れたタスクを見つける。
2. GSI `by_owner` で、そのタスクのファイルを集める。
3. 期限から 2 分たっても割り当て直されていないファイルを、`recover_then_release = true` で空きのあるタスクに割り当てる（1 秒に 50 ファイルまで）。
4. Document Server は回復し、チェックポイントを書き、接続が 0 なら `released` にする。
5. 毎日の見張り：`by_owner` を全部読み、生存の切れた持ち主のファイルの数と最古の経過時間を出す。1 日を超えるものがあれば警告（[observability.md](observability.md) の 6 節）。

### 5.4 時間の予算（NFR-007：p95 15 秒）

| 区間 | 目安 |
| --- | --- |
| タスクが落ちてから、生存の期限が切れるまで | 最大 10 秒 |
| 時計のずれの猶予 | 2 秒 |
| 割り当て、フェンス | 0.1 秒 |
| チェックポイントの読み込みと、ジャーナル 60 秒ぶんの当て直し | 1〜3 秒（**未検証**。E7 の `journal-fencing-recovery` で計測する） |

- タスクの停止を ECS のイベント（EventBridge の `STOPPED`）で先に知れば、期限を待たずに割り当て直せる。ただし、止まったことが確かなとき（ECS が止めた）だけにする。ネットワークの分断では使わない。

## 6. データの基盤

| 基盤 | 使い方 | 設定 |
| --- | --- | --- |
| DynamoDB `journal` | ジャーナルとフェンス（ADR-0024） | オンデマンド、warm throughput（[ADR-0052](../decisions/0052-journal-throughput-and-hot-file-budget.md)）、TTL、PITR 35 日、グローバルテーブル（MREC、大阪） |
| DynamoDB `file_leases` | 割り当て（5 節） | オンデマンド、GSI `by_owner`、TTL、PITR、グローバルテーブル |
| DynamoDB `ds_liveness` | タスクの生存 | オンデマンド、TTL。リージョンごと |
| S3 `<brand>-files-{env}-{region}` | チェックポイント・チャンク・大きな変更 | バージョニング（古いバージョン 30 日）、SSE-KMS、東京 → 大阪のレプリケーション（RTC）、ライフサイクルを両方に置く |
| S3 `<brand>-assets-{env}-{region}` | 画像・フォント・書き出し・サムネイル・コメントの添付 | 同上 |
| CloudFront | 静的な資産、チャンク、画像 | 署名付き URL（鍵のグループ）、`files`・`assets` は Cookie を持たないドメイン |
| Aurora PostgreSQL 18 | メタデータ（RLS） | writer 1＋reader 1（別の AZ）、I/O-Optimized、Global Database（大阪に reader 1） |
| ElastiCache（Valkey） | チケットの `jti`、再開のトークンの `rid` と組織の最新の `acl_version`・取り消したログインのセッションの印（[permissions-and-sharing.md](permissions-and-sharing.md) の 5.5 節）、持ち主のキャッシュ、レート制限、Realtime の無効化の pub/sub | クラスタモードを使わない構成（プライマリ＋レプリカ 2）。用途ごとにクラスタを分ける |
| SQS | Worker のキュー（`render-export`・`render-thumbnail`・`image-ingest` など） | 標準キュー＋DLQ |

- Valkey の pub/sub は、クラスタモードの構成に置かない。本家は、pub/sub をクラスタモードの ElastiCache に移した数週間後に、クラスタのバスのバッファの膨張で CPU が 100% に張り付き、新しいファイルを開けず共同編集もできない障害を起こし、クラスタモードを使わない構成に戻して用途ごとに分けた（[Postmortem: Service disruptions on June 6 & 7 2022](https://www.figma.com/blog/postmortem-service-disruptions-on-june-6-and-7-2022/)、2026-09-27 に確認）。
- S3 のレプリケーションは、バージョンを指定した削除とライフサイクルの動作を複製しない（[security.md](security.md) の 7 節、[ADR-0045](../decisions/0045-audit-log-and-data-lifecycle.md)）。
- DynamoDB のグローバルテーブルで、`TransactWriteItems` は書いたリージョンの中でだけ原子的。大阪では、ジャーナルの項目とフェンスの項目が別々に届きうる（[How DynamoDB global tables work](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/V2globaltables_HowItWorks.html)、2026-09-27 に確認）。大阪での回復は、フェンスの項目に頼らず、ジャーナルの項目の連続だけを見る（ADR-0048）。

## 7. 冗長化と災害復旧

### 7.1 AZ の障害

| 部品 | 動き | 目安 |
| --- | --- | --- |
| Document Server | その AZ のタスクの生存が切れ、割り当て直される。残る 2 AZ に空きを持つ（平常の使用を 2/3 以下） | NFR-007 の 15 秒 |
| Gateway | その AZ の接続が切れ、クライアントが再接続する | 数十秒（再接続の散らし） |
| DynamoDB、S3 | リージョンのサービス。AZ の障害で止まらない | — |
| Aurora | 別の AZ の reader へ自動で切り替わる | 通常 60 秒未満 |
| Valkey | レプリカへ切り替わる。チケットの `jti`・再開のトークンの `rid` の記録を一部失いうる（再使用の検出が一時的に弱まる）。止まっている間、再開のトークンは使えず、再接続は API のチケットに回る | 数十秒 |

- AZ の障害では、確定した変更を失わない（ジャーナルは確定の前に書かれている）。

### 7.2 リージョンの障害（NFR-009：RPO 1 分、RTO 1 時間）

[ADR-0048](../decisions/0048-osaka-dr-with-journal-generations.md) による。手順は [runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)。

| 大阪に常に置くもの | 切り替えのときに増やすもの |
| --- | --- |
| VPC、ALB、ECS のサービス（各 1 タスク）、DynamoDB のレプリカ（`journal`・`file_leases`）、`ds_liveness`（空）、S3 のレプリカのバケット、Aurora の二次（reader 1）、Valkey（小）、SQS、ECR のレプリカ、Secrets Manager のレプリカ、KMS のレプリカの鍵、CloudFront のオリジンの候補 | ECS のタスク数（東京と同じに）、Aurora の reader、Valkey の大きさ |

- **世代**：切り替えのたびに世代を上げ、世代 2 以降のジャーナルは `{file_id}#g{g}`、マニフェストは `checkpoints/g{g}/` に書く。東京の遅れた書き込みが、大阪の確定を上書きしない（ADR-0048）。
- **RPO**：ジャーナルの複製は通常 1 秒以内（MREC）。`ReplicationLatency` が 10 秒を超えたら警告、30 秒で呼び出し。大阪の最新のチェックポイントが遅れていても、古いチェックポイント＋ジャーナル（30 日）から回復できる。
- **RTO の内訳（目安）**：判断 15 分、Aurora の切り替え 5 分、ECS を広げる 10〜15 分、入口の切り替え 5 分、回復のジョブが開いていたファイルを回復する 10〜20 分（1 万ファイルを 1 秒に 50 ファイルで回復すると約 3 分半。利用者が開けば先に回復する）。合計 45〜60 分。**未検証**（E12 の `dr-drill` で計る）。
- **取り戻し**：東京が戻ったら、`dr-salvage` のジョブが、元の世代の `base_end_seq` より後の項目を探し、バージョンとして残す（ADR-0048）。
- **戻す**：大阪で全ファイルを `released` にし、複製の待ちが 0 になってから、東京で世代を上げる（RPO 0）。

### 7.3 バックアップ

| 対象 | 方法 | 保持 |
| --- | --- | --- |
| DynamoDB `journal`・`file_leases` | PITR | 35 日 |
| S3 | バージョニング（古いバージョン） | 30 日 |
| Aurora | 自動バックアップ（PITR）＋ AWS Backup の日次のスナップショット（大阪へコピー） | 35 日 |
| 監査のアーカイブ | log-archive の S3（Object Lock） | 7 年（既定案。法務の確認待ち、L4） |

- 論理的な破損（誤ったジョブがチャンクを消した、など）は、S3 の古いバージョンと、日ごとのチェックポイント＋ジャーナル（30 日）から戻す（[file-storage-and-history.md](file-storage-and-history.md) の 5.3・12 節）。

## 8. S1 の構成と台数（初期見積もり）

根拠は [capacity.md](capacity.md)。

| リソース | 構成 |
| --- | --- |
| gateway | 4 vCPU / 8 GB × 9（AZ ごとに 3）、最大 30 |
| ds-standard | 8 vCPU / 60 GB × 12（AZ ごとに 4）、最大 36 |
| ds-large | 16 vCPU / 120 GB × 3（AZ ごとに 1）、最大 9 |
| router | 1 vCPU / 2 GB × 3 |
| api | 2 vCPU / 4 GB × 6、最大 24 |
| realtime | 2 vCPU / 4 GB × 3、最大 12 |
| workers | 0.5〜1 vCPU × 計 8、最大 30 |
| render-worker | 4 vCPU / 16 GB × 2〜12（x86-64） |
| telemetry-ingest | 1 vCPU / 2 GB × 2 |
| Aurora | writer `db.r8g.2xlarge` × 1、reader 同型 × 1、大阪に reader 同型 × 1 |
| Valkey | `cache.r7g.large`（プライマリ＋レプリカ 2）× 3 クラスタ（チケットとレート制限、キャッシュ、pub/sub） |
| DynamoDB | オンデマンド。`journal` の warm throughput は書き込み毎秒 5 万単位 |
| NAT ゲートウェイ | 東京 3、大阪 3 |
| 大阪 | 各サービス 1 タスク、Aurora の reader 1 |

- staging は同じ構成を最小の台数で持ち、負荷試験のときだけ本番と同じ台数に広げる。dev は夜間と週末に止める。

## 9. 段階の移行（S2・S3）

[architecture/README.md](README.md) の 3 節の段階。移行に四半期ほどかかるので、上限の手前で始める。

| 指標 | S1 → S2 を始める目安 | S2 → S3 を始める目安 |
| --- | --- | --- |
| 同時に開いたファイル | 6,000（S1 の 60%）を 2 週続けて超える | 60 万 |
| 同時接続 | 3 万 | 300 万 |
| Aurora の writer の CPU（ピークの p95） | 60% を超え、1 段上げても 6 か月もたない | シャードを増やしても最大のクラスで 60% |
| `journal` の書き込み | アカウントの表の上限の 50% | 表を分けても 50% |
| 1 ファイルの参加 | 500 人を超える需要（全社の発表） | — |

### 9.1 S2

- **メタデータを縦に分ける**：コメント・通知・`realtime_invalidations` を別の Aurora のクラスタへ（[ADR-0005](../decisions/0005-tenancy-and-document-routing.md)）。振り分けは、アプリの中のルーター（Notion の [ADR-0027](../../../notion/docs/decisions/0027-shard-router.md) と同じ形）を候補にし、S2 の前の ADR で決める。
- **Document Server を AZ ごとの群れにする**：Gateway と Document Server を AZ ごとの組にし、router が参加者の多い AZ にファイルを置く。AZ をまたぐ通信と費用を減らす。
- **Realtime の無効化を WAL から作る**（[comments-and-notifications.md](comments-and-notifications.md) の 5.4 節の条件に当たれば）。
- **ECS on EC2 の再評価**：Document Server のタスクが 100 を超えたら、メモリ最適化のインスタンス（r8g・r8gd）の ECS on EC2 と、Savings Plans を含めた費用を比べる（[ADR-0046](../decisions/0046-multiplayer-compute-on-fargate-with-drain.md)）。差が 30% を超えれば移る ADR を書く。
- **大阪の二次を writer と同じ大きさにする**。

### 9.2 S3

- **セル構成**：セル＝{gateway、router、Document Server、`journal`・`file_leases` の表、Aurora のシャードの群れ、Worker}。組織（`org_id`）をセルに固定する。セルの外（グローバル）に置くのは、アカウントとセッション、組織 → セルの対応表、ファイルの鍵 → 組織の対応表。
- **ファイルは、持つ組織のセルで開く。** ゲストや別の組織の人も、そのセルへ入る（入口のルーターが、ファイルの鍵からセルを引く）。
- **メタデータを横に分ける**：シャードの鍵は `org_id`（組織の中のメタデータ）と `file_id`（コメント、バージョン）を候補にする（ADR-0005）。
- **大阪でも編集を受ける**：セルごとに主のリージョンを東京か大阪に置く（Stripe の [ADR-0031](../../../stripe/docs/decisions/0031-active-active-cells.md) と同じ形）。1 つのセルの書き込みは 1 つのリージョンだけ。
- DynamoDB の MRSC（東京・大阪＋第 3 のリージョン）は、トランザクションと TTL が使えないので、S3 でも使わない（ADR-0048）。

## 10. Terraform の構成

Slack の [ADR-0020](../../../slack/docs/decisions/0020-infrastructure-as-code-with-terraform.md) を引き継ぐ。開発リポジトリの `infra/` に置く。

```
infra/
├── modules/                    # 再利用する部品
│   ├── network/                # VPC、サブネット、エンドポイント、NAT
│   ├── ecs-service/            # タスク定義、サービス、オートスケール、ALB のターゲット
│   ├── ds-pool/                # Document Server の群れ（タスクの保護の権限、ドレインのフック）
│   ├── dynamodb-global/        # グローバルテーブル、TTL、PITR、warm throughput
│   ├── s3-replicated/          # バケット、バージョニング、RTC の複製、両方のライフサイクル
│   ├── aurora-global/
│   ├── edge/                   # CloudFront、WAF、証明書、署名の鍵のグループ
│   └── kms-multiregion/
├── global/                     # Organizations、SCP、Identity Center、Route 53、ECR
├── accounts/{security,log-archive,shared}/
└── envs/{dev,staging,prod}/
    ├── apne1/{network,data,compute,edge}/   # 東京
    └── apne3/{network,data,compute}/        # 大阪
```

- ルートのモジュールを、変更の頻度と影響の範囲で分ける（`network`・`data` は Ops の承認、`compute` はアプリのリリースと同じ頻度）。
- 状態ファイルは、環境ごとの S3 のバケット（東京と大阪へ複製）に置く。大阪で apply できるよう、大阪の状態ファイルは大阪のバケットにも置く（Slack と同じ）。
- `data` のモジュール（DynamoDB、S3、Aurora、KMS）には `prevent_destroy` を付ける。
- 世代（`region_gen`）とリージョンの書き込みの受け付けは、Terraform ではなく AppConfig に置く（切り替えを apply に頼らない）。

## 11. 費用の概算（S1、本番、1 か月）

**大まかな見積もりである。** 東京のオンデマンドの料金をもとにした ±50% の幅の値。Fargate・DynamoDB・CloudFront の単価は AWS の Price List API で 2026-09-27 に確かめた（[capacity.md](capacity.md) の 4.3・6・7 節）。それ以外（Aurora、Valkey、ALB、NAT、可観測性など）の単価は **未検証**（E12 の `cost-dashboard` で実測に置き換える）。サポートの料金と税は含めない。Savings Plans で計算の費用を 20〜30% 下げられる。

| 項目 | 月額（USD、概算） | 根拠 |
| --- | --- | --- |
| ECS Fargate：Document Server（ds-standard 12、ds-large 3） | 7,700 | ARM64、平常の台数。1 台の時間の費用は ds-standard 0.589、ds-large 1.178 USD（730 時間） |
| ECS Fargate：gateway、router、api、realtime、workers、telemetry | 4,000 | |
| ECS Fargate：render-worker（x86-64、平均 6 タスク） | 1,500 | |
| DynamoDB（`journal` の書き込みと大阪への複製、TTL の削除の複製、保存、PITR、`file_leases`） | 13,500 | [capacity.md](capacity.md) の 4 節 |
| S3（チェックポイント・チャンク・画像、東京と大阪）、リージョンをまたぐ転送 | 5,000 | 同 6 節 |
| CloudFront（チャンク、WASM、画像、フォント） | 4,000 | 同 6 節。端末のキャッシュの当たりの率で大きく変わる |
| Aurora（writer・reader・大阪、I/O-Optimized） | 3,500 | |
| Valkey（3 クラスタ）、SQS、KMS、Secrets Manager | 1,500 | |
| ALB、NAT、VPC エンドポイント、AZ をまたぐ転送 | 2,500 | |
| 可観測性（ログ、メトリクス、トレース、Grafana） | 3,000 | |
| WAF、GuardDuty、Security Hub、Inspector、Config、CloudTrail | 1,000 | |
| 大阪のウォームスタンバイの計算の資源 | 1,000 | |
| **本番の合計** | **約 48,000** | |
| staging・dev・shared | 約 8,000 | |

- Slack の S1（約 1 万）より高いのは、DynamoDB のジャーナル（書き込みの量とトランザクションの 2 倍、大阪への複製）、ファイルの中身の CDN の配信、Document Server のメモリのため。
- 大きく効くのは DynamoDB と CloudFront。DynamoDB は、まとめ（[file-storage-and-history.md](file-storage-and-history.md) の 4.3 節）の効き目、CloudFront は端末のキャッシュの当たりの率で決まる。E12 の負荷試験と試用の期間の実測で置き換える。
- 費用は、タグ（`service`、`env`、`region`）ごとに毎月見る。

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `aws-accounts-and-network` | 1・2 節（Slack・Stripe の Terraform のモジュールを流用） |
| E1 | `terraform-layout` | 10 節の構成、状態ファイル、`prevent_destroy` |
| E1 | `ecs-rust-services-baseline` | Rust のサービスの ECS のテンプレート（ARM64、ログ、OTel、ヘルスチェック） |
| E3 | `gateway-edge-websocket` | 4 節の入口、ALB の期限、Gateway の入れ替え |
| E3 | `router-assignment` | 5.1・5.2 節の表と割り当て |
| E3 | `ds-liveness-and-self-fence` | `ds_liveness` の延長と、延ばせないときに自分から止まる |
| E3 | `ds-drain-controller` | 3.1 節のドレイン、タスクの保護、退役の通知 |
| E7 | `orphan-recovery-job` | 5.3 節（file-storage-and-history.md の同じ名前の Story と 1 つにする） |
| E7 | `file-lease-deleted-state` | 削除済みの割り当て（完全な削除のジョブの最初の手順） |
| E12 | `osaka-warm-standby` | 7.2 節の大阪の構成 |
| E12 | `journal-generations` | ADR-0048 の世代のキーと、世代をまたぐ回復 |
| E12 | `dr-salvage-job` | 取り戻しのジョブ |
| E12 | `dr-drill` | DR の訓練（staging で四半期ごと） |
| E12 | `cost-dashboard` | タグごとの費用の可視化 |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- Gateway と Document Server は Fargate（ARM64）。ECS on EC2 は S2 で再評価する。
- 入口は CloudFront → ALB。ALB のアイドル 300 秒、クライアントの `Ping` 20 秒。
- 生存の記録はタスクごと（期限 10 秒、2 秒ごとに延ばす）。割り当ての記録はファイルごと（延ばさない）。
- 大阪は縮小したウォームスタンバイ。切り替えのたびに世代を上げる。
- Valkey の pub/sub はクラスタモードを使わない構成にする。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| CloudFront の応答の期限が WebSocket のフレームに効くか、接続の長さの上限（資料に WebSocket に固有の期限はない。4 節） | E3 の `gateway-edge-websocket` の PoC（8 時間） |
| Fargate の退役が、タスクの保護を待つか | 資料は保護の対象を縮小とデプロイに限るので、待たない前提にした（3 節）。staging で退役の通知を受けた時に観察して記録する（`ds-drain-controller`） |
| ドレインでの 1 ファイルの中断の時間（目標 p95 2 秒） | E3 の計測 |
| 障害中に、グローバルテーブルから東京のレプリカを外せるか | E12 の DR の訓練（FIS で東京を切り離して試す） |
| RTO の内訳の実測 | E12 の DR の訓練 |
| Gateway → Document Server の TLS の証明書 | E1（[security.md](security.md) の 13 節） |
| 費用の単価の確認 | E12 の前に、AWS の料金の計算ツールで置き換える |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- DR の訓練の合否の基準：失った範囲が 1 分以内、RTO 1 時間以内、`dr-salvage` が失った範囲の変更をバージョンとして残す。
- ドレインの品質：デプロイ中のファイルごとの中断の p95、`Kick(owner_changed)` の数、`edit_commit` の悪いイベント。

### runbooks

- [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)、[runbooks/incident-response.md](../runbooks/incident-response.md)（この領域で作った）。
- `ds-drain-stuck.md`：ドレインが進まない（タスクの保護が外れない）ときの確かめ方と、手でファイルを渡す手順。
- `fargate-retirement.md`：退役の通知を受けて、ドレインで入れ替える定期の作業。
- `router-down.md`：router が止まったときの影響（新しく開けない）と、再起動の確かめ方。

### data-model

| 置き場所 | 中身 |
| --- | --- |
| DynamoDB `file_leases`（グローバル） | 5.1 節。GSI `by_owner`。形の正本は [data-model/file-storage.md](data-model/file-storage.md) の 3 節 |
| DynamoDB `ds_liveness`（リージョンごと） | 5.1 節 |
| DynamoDB `journal` のパーティションキー | 世代 1 は `{file_id}`、世代 2 以降は `{file_id}#g{g}`（ADR-0048） |
| S3 `files/{file_id}/checkpoints/g{g}/{seq:020}`、`journal-blobs/g{g}/…` | 世代 2 以降のマニフェストと大きな変更 |
| AppConfig `region.writable`、`region.gen` | 書き込みを受けるリージョンと世代 |
| Valkey `owner:{file_id}` | 持ち主のキャッシュ（30 秒） |

# Capacity: Figma

負荷のモデルと、部品ごとの必要量、パラメーター、負荷試験の計画。台数と構成は [infrastructure.md](infrastructure.md) の 8 節、SLO は [observability.md](observability.md) の 5 節にある。

| ADR | 決定 |
| --- | --- |
| [0051](../decisions/0051-document-server-memory-admission.md) | Document Server は、ファイルごとのメモリを見積もって受け入れを決め、タスクのメモリの 75% を上限にする。大きなファイルは別の群れに置く |
| [0052](../decisions/0052-journal-throughput-and-hot-file-budget.md) | ジャーナルの表はオンデマンドで事前に温め、1 ファイルの書き込みは予算で抑える。予算を超えそうなファイルは、まとめの間隔を段階的に広げる |

**ここの数値は、負荷試験（E12）の前の初期見積もりである。** 仮定は表の中に書き、計測で置き換える。DynamoDB・Fargate・EC2・CloudFront の東京（日本）の単価は、AWS の Price List API（`AmazonDynamoDB`・`AmazonECS`・`AmazonEC2` の `ap-northeast-1`、`AmazonCloudFront`。2026-09 の公開分）で 2026-09-27 に確かめた。それ以外の単価は **未検証**（E12 の `cost-dashboard` で実測に置き換える）。

## 1. 負荷のモデル（S1）

[architecture/README.md](README.md) の 3 節の S1 の値から始める。

| 項目 | 値 | 仮定と根拠 |
| --- | --- | --- |
| 利用者（月間） | 10 万 | README の S1 |
| 日ごとの利用者 | 4 万 | 月間の 40%（仮定） |
| 同時接続（マルチプレイヤー） | 5 万 | README の S1。開いたタブの数 |
| 同時に開いたファイル | 1 万 | README の S1。1 ファイルに平均 5 接続 |
| 編集中のファイル（直近 1 分に確定がある） | 3,000 | 開いたファイルの 30%（仮定） |
| 確定する変更（日） | 5,000 万 | README の S1 |
| 確定の平均 | 毎秒 580 | 5,000 万 ÷ 86,400 |
| 確定のピーク | 毎秒 4,200 | 利用の 80% が平日の 8 時間に集まり（毎秒約 1,400）、その 3 倍をピークとみなす（仮定） |
| ファイルを開く（日） | 40 万 | 日ごとの利用者 × 10 ファイル（仮定） |
| 開くピーク | 毎秒 30 | 8 時間に集まり、その 2 倍 |
| 1 ファイルの参加 | 平均 5、上限 500（編集 200） | [ADR-0011](../decisions/0011-presence-and-fan-out.md) |

### 1.1 ファイルの大きさの分布（仮定）

本家の分布は公開されていない（**未検証**）。E3 の `ds-memory-accounting` と試用の期間の計測で、試用のチームのファイルから置き換える。

| ノードの数 | 開いたファイルの割合 | メモリ（`Doc`） | 圧縮したチェックポイント |
| --- | --- | --- | --- |
| 〜1 千 | 50% | 1 MB | 0.1 MB |
| 1 千〜1 万 | 35% | 10 MB | 1 MB |
| 1 万〜10 万 | 13% | 80 MB | 7 MB |
| 10 万〜30 万 | 1.8% | 400 MB | 35 MB |
| 30 万〜100 万 | 0.2% | 1.5 GB | 130 MB |

- 10 万ノードで `Doc` を 200 MiB 以内とする目標（[document-model.md](document-model.md) の 10 節）から、1 ノードあたり約 2 KB とした。
- 加重の平均は `Doc` が約 25 MB。ファイルごとの固定の分（直近の変更 1 万件か 60 秒、セッションの表、待ち行列）を 16 MB とし、1 ファイル平均 **約 41 MB** とする。

## 2. 接続と Gateway

| 項目 | 見積もり | 仮定 |
| --- | --- | --- |
| 1 接続のメモリ | 約 100 KB | WebSocket の読み書きのバッファと接続の状態。送信の待ちは上限 8 MiB だが、平常は小さい |
| 1 接続の送信 | 毎秒約 22 メッセージ | 平均 5 人のファイルで、在席の `PresenceBatch` が 50ms ごとに 20 回、`Committed` が 2 回 |
| 1 タスク（4 vCPU・8 GB）の接続 | 1 万まで | メモリ 1 GB、送信 毎秒 22 万メッセージ。1 メッセージ 5µs として CPU 約 1.1 コア（**未検証**。E3 の `mp-loadbot` で計測） |
| 必要なタスク | 5 | 5 万 ÷ 1 万 |
| 置くタスク | 9（AZ ごとに 3） | 1 AZ を失っても 6 タスクで 6 万接続 |

### 2.1 人が集まるファイル

- 参加 500 人のファイルで、1 回の `PresenceBatch` は最大約 8 KB、100ms ごと（[multiplayer.md](multiplayer.md) の 12.3 節）。Gateway の側は 1 接続あたり毎秒 80 KB。500 接続が 1 つの Gateway に集まると、毎秒 40 MB を送る。Gateway の間に散っていれば問題にならない。ALB が接続を散らす（[infrastructure.md](infrastructure.md) の 4 節）。

### 2.2 再接続の殺到

| 場面 | 再接続の数 | 抑え方 |
| --- | --- | --- |
| Gateway の入れ替え（デプロイ） | 1 タスク 1 万を 180 秒で | `Kick(server_shutdown)` の `retry_after_ms` を 0〜60 秒に散らす。1 回に全体の 10% |
| Gateway のタスクが落ちた | 1 万が一度に | クライアントは、予期しない切断では最初の待ちを 0〜5 秒の一様な乱数にする（その後は 1・2・4…30 秒 ±20%。[multiplayer.md](multiplayer.md) の 7.2 節に取り込んだ）。持ち主は変わらないので、再開のトークンで入り、API のチケットを取らない |
| Document Server のタスクが落ちた | 約 830 ファイルの全接続（約 4,000） | 同上。router は割り当てを毎秒 200 まで |
| 入口の全体の障害の回復 | 5 万 | 同上の散らしで毎秒約 1 万。60 秒より短い障害なら再開のトークンで入る。60 秒を超えると API のチケットの発行が詰まるので、API は 429 と `Retry-After` を返し、クライアントは待ちを伸ばす |

- **持ち主が変わらない再接続は、Gateway の再開のトークン（60 秒・1 回だけ）で入り、API のチケットを取らない**（[permissions-and-sharing.md](permissions-and-sharing.md) の 5.5 節、[multiplayer.md](multiplayer.md) の 9 節）。Gateway の入れ替え・喪失と、60 秒より短い入口の障害がこれに当たる。Gateway の検証は、署名と Valkey の 2 回の読み書き（`rid` の `SET NX`、組織の `acl_version`）で、1 件 0.1ms 未満の CPU と見積もる。組織の `acl_version` が変わっていた接続だけ、API の一括の判定（500 件ずつ）に回る。
- **API のチケットが要るのは、持ち主が変わった再接続（Document Server の障害、ドレイン）、60 秒を超える入口の障害、トークンの検証に外れたとき（`Kick(ticket_required)`）。** チケットの発行は、判定関数を `acl_version` のキャッシュで通すので、1 件 2ms の CPU と見積もる（**未検証**。`load-test-suite` の L4 で計る）。API の 6 タスク（2 vCPU）で毎秒最大約 6,000。Document Server の落ち（約 4,000 接続を 0〜5 秒に散らす）は毎秒約 800 で収まる。60 秒を超える全体の障害の回復（5 万）は毎秒約 1 万になり足りないので、API は 429 と `Retry-After` を返し、クライアントは待ちを伸ばす。

## 3. Document Server のメモリ

[ADR-0051](../decisions/0051-document-server-memory-admission.md) による。

| 項目 | 見積もり |
| --- | --- |
| 開いたファイルのメモリの合計 | 1 万 × 41 MB ≈ 410 GB |
| うち `ds-large`（見積もり 1.5 GiB 超） | 0.2% の約 20 ファイル × 約 2 GB ≈ 40 GB |
| `ds-standard` の受け入れの上限 | 60 GB × 0.75 = 45 GB |
| `ds-standard` の必要なタスク | 370 GB ÷ 45 GB ≈ 8.2 |
| `ds-standard` の置くタスク | 12（AZ ごとに 4。1 AZ を失っても 8 タスク） |
| `ds-large` の受け入れの上限 | 120 GB × 0.75 = 90 GB |
| `ds-large` の置くタスク | 3（AZ ごとに 1）。1 ファイルの最大（100 万ノードで数 GB）を、どのタスクも受け入れられる |
| 1 タスクのファイルの数 | 平均約 830。上限 5,000 |

- **見積もりの係数**：開く前の見積もりは、圧縮の前のチェックポイントの大きさ × 3 ＋ 16 MiB。係数 3 は **未検証**。E3 の `ds-memory-accounting` で、ファイルの大きさの区分ごとの比を計る。
- **CPU**：確定のピーク 毎秒 4,200 × 1 件 10µs（[multiplayer.md](multiplayer.md) の 12.3 節）≈ 0.04 コア。チェックポイントの直列化（3,000 ファイル × 毎分、変わったページの圧縮の前 1 MB）は毎秒 50 MB で、zstd のレベル 3 と SHA-256 で約 0.3 コア（**未検証**。E7 の `checkpoint-writer` で計測）。CPU はメモリに比べて余る。Document Server の台数はメモリで決まる。
- **回復の集中**：`ds-standard` の 1 タスクが落ちると、約 830 ファイル・37 GB を、残りの 11 タスクで回復する。圧縮したチェックポイントは約 3 GB（メモリの約 1/12）で、1 タスクあたり約 280 MB を読む。接続のあるファイルから先に回復する（再接続の順）。NFR-007 の 15 秒に収まるかは E7・E12 で確かめる。

## 4. ジャーナル（DynamoDB）

[ADR-0052](../decisions/0052-journal-throughput-and-hot-file-budget.md) による。

### 4.1 表全体

| 項目 | 見積もり | 仮定 |
| --- | --- | --- |
| まとまり（1 回の書き込み） | ピーク 毎秒 4,000、平均 毎秒 580 | 20ms の group commit で、同じファイルの確定がまとまるのは人が集まるファイルだけ。ほとんどは確定 1 件 ＝ 1 まとまり |
| 1 まとまりの大きさ | 平均 1.5 KB | 数個の `Set` と見出し |
| 1 まとまりの書き込みの単位 | 6 | `Put`（2 KB に切り上げ）× 2（トランザクション）＝ 4、フェンスの `ConditionCheck`（1 KB）× 2 ＝ 2。`ConditionCheck` の単位の種類は **未検証**（書きとして数えた。`dynamodb-transaction-poc` で確かめる） |
| 書き込みの単位のピーク | 毎秒約 2.5 万 | 4,000 × 6 |
| warm throughput | 毎秒 5 万 | ピークの 2 倍。大阪への切り替えの直後の回復の読み書きにも備える |
| 表の上限 | 毎秒 4 万（既定。引き上げを申請する） | [DynamoDB on-demand capacity mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html)、2026-09-27 に確認 |
| 保存 | 1 日 約 75 GB、30 日（TTL）で約 2.3 TB | 5,000 万 × 1.5 KB |

### 4.2 1 ファイル（ホットパーティション）

| 項目 | 値 |
| --- | --- |
| 1 パーティションの書き込みの上限 | 毎秒 1,000 単位（[Best practices for designing and using partition keys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)、2026-09-27 に確認） |
| 1 ファイルの予算 | 毎秒 400 単位 |
| 通常の 1 ファイルの最大 | 毎秒 50 まとまり（20ms）× 6 ＝ 300 単位（まとまりが小さいとき） |
| 人が集まるファイル（編集 200 人がドラッグ） | 200 人 × 20Hz ＝ 毎秒 4,000 の `ChangeSet`。20ms のまとまりに 80 件。同じ鍵のまとめの後、200 個の `transform`（約 50 バイト）で 1 まとまり約 10 KB。毎秒 50 まとまり × (10 KB × 2 ＋ 2) ≈ 1,100 単位で、予算を超える。予算の段でクライアントのまとめを 100ms・200ms に広げ、毎秒 10〜20 まとまりにすると、1 まとまりは同じ約 10 KB（同じ鍵がまとまる）で 220〜440 単位に収まる |

- 1 ファイルのジャーナルは、ソートキーが増える一方なので、書き込みは末尾の 1 つのパーティションに集まる。DynamoDB は、ソートキーが単調に増える項目の集まりをソートキーで分けない（[DynamoDB burst and adaptive capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html)、2026-09-27 に確認。[multiplayer.md](multiplayer.md) の 12.3 節）。

### 4.3 費用（1 か月）

| 項目 | 見積もり（USD） | 計算 |
| --- | --- | --- |
| 書き込み（東京） | 約 6,500 | 平均 毎秒 3,500 単位 × 260 万秒 ≈ 91 億単位 × 100 万単位あたり 0.715 |
| 大阪への複製の書き込み | 約 2,200 | まとまり 1 件 2 単位（トランザクションでない）× 平均 毎秒 580 × 260 万秒 ≈ 30 億単位 × 100 万単位あたり 0.715（大阪の複製の書き込みの単価も同じ。保存・PITR も東京と同じ単価） |
| TTL の削除の大阪への複製 | 約 2,200 | 期限の切れた項目の削除は、東京では単位を使わないが、複製の先では複製の書き込みの単位を使う（[Using time to live (TTL) in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)、2026-09-27 に確認）。月 15 億件 × 2 単位 × 100 万単位あたり 0.715 |
| 保存（東京と大阪） | 約 1,300 | 2.3 TB × 2 × GB・月 0.285 |
| PITR（東京と大阪） | 約 1,000 | 2.3 TB × 2 × GB・月 0.228 |
| リージョンをまたぐ転送、`file_leases`、`ds_liveness` | 約 300 | |
| **合計** | **約 13,500** | 単価は Price List API で確かめた（2026-09-27）。TTL の削除の複製を 2026-09-27 に足した |

- 費用を大きく下げるのは、同じ鍵のまとめ（[file-storage-and-history.md](file-storage-and-history.md) の 4.3 節）と、フェンスの確かめ方。S2 で、日中の底の量をプロビジョンドとリザーブドにする案を比べる（ADR-0052）。

## 5. Router・API・Realtime

| 部品 | 負荷 | 見積もり |
| --- | --- | --- |
| router の割り当て | 平常は開くピーク 毎秒 30。Document Server の落ちで毎秒最大 200 | 1 件は `file_leases` の読み 1・条件付きの書き 1。3 タスクで余る |
| `ds_liveness` の延長 | Document Server のタスク 15（最大 45）× 毎秒 0.5 | 毎秒 7.5〜22.5 件 |
| `file_leases` の書き込み | 割り当てと手放し。平常 毎秒 60 程度 | 小さい |
| API のチケットの発行 | 開くピーク 毎秒 30。Document Server の落ちで毎秒約 800、60 秒を超える全体の障害の回復で毎秒約 1 万（2.2 節。Gateway の落ちは再開のトークンで API を通らない） | 6 タスクで最大 毎秒約 6,000（**未検証**。`load-test-suite` の L4） |
| Realtime | 接続 5 万、購読の取り直しはコメントと一覧の変更の数 | [comments-and-notifications.md](comments-and-notifications.md) の 5.4 節 |

## 6. S3 と CloudFront

| 項目 | 見積もり | 仮定 |
| --- | --- | --- |
| チェックポイントの書き込み | 3,000 ファイル × 毎分 1 回 × 変わったページの圧縮後 150 KB ≈ 毎秒 7.5 MB | 編集中のファイルは毎分チェックポイントを書く |
| S3 の PUT | 毎秒約 150（チャンク 2＋マニフェスト 1） | 接頭辞はファイルごとなので、接頭辞あたりの上限（毎秒 3,500）に当たらない（[S3 Replication Time Control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html) の要求の速さの目安、2026-09-27 に確認） |
| 大阪への複製の転送 | 月に約 6 TB（チャンクとマニフェスト） | 平日の 10 時間 × 22 日 |
| チャンクの配信（CloudFront） | 1 日 40 万回 × 平均 3 MB × 端末のキャッシュの外れ 50% ≈ 0.6 TB | ファイルの圧縮したチェックポイントの平均は約 3 MB（1.1 節から） |
| WASM と静的な資産 | 月に約 2 TB | 日ごとの利用者 4 万 × ビルドの更新 月 10 回 × 5 MB |
| 画像とフォント | 月に約 10 TB | 仮定 |
| CloudFront の合計 | 月に約 30 TB、約 4,000 USD | 日本の転送は最初の 10 TB が GB あたり 0.114、次の 40 TB が 0.089 で約 3,000 USD。HTTPS の要求は 1 万回あたり 0.012 USD（2026-09-27 に Price List API で確認）。要求の数は仮定 |

## 7. Fargate と EC2 の比較（ADR-0046）

| 項目 | Fargate（ARM64） | ECS on EC2（r8g） |
| --- | --- | --- |
| `ds-standard` 相当 1 台の時間の費用 | 8 vCPU・60 GB で約 0.589 USD（vCPU 時 0.04045、GB 時 0.00442） | `r8g.2xlarge`（8 vCPU・64 GiB）で約 0.568 USD（ECS の費用は別になし） |
| メモリの比率 | 最大 7.5 GB / vCPU | 8 GiB / vCPU |
| 割引 | Compute Savings Plans | Compute Savings Plans、リザーブド |
| 持つ作業 | なし（退役の通知への対応だけ） | AMI の更新、インスタンスのドレイン、容量の予約 |

- 単価は、東京のオンデマンドの値を AWS の Price List API（`AmazonDynamoDB`・`AmazonECS`・`AmazonEC2` の `ap-northeast-1`、`AmazonCloudFront`。2026-09 の公開分）で 2026-09-27 に確かめた。S1 の台数（`ds-*` 15 台）では差がほぼない（1 台あたり 4% 未満）。Compute Savings Plans は Fargate にも効く。S2 で台数が 100 を超えたら比べ直す（[infrastructure.md](infrastructure.md) の 9.1 節）。

## 8. 書き出しの Worker（Render Worker）

| 仕事 | 見積もり | 仮定 |
| --- | --- | --- |
| サムネイル | ピーク 毎秒 10 | 編集中のファイル 3,000 が、5 分に 1 回（チェックポイントの後、前のサムネイルから 5 分以上） |
| 1 枚の CPU | 平均 1.5 CPU 秒 | lavapipe のソフトウェアの描画。10 万ノードで p95 10 秒の目標（[export-and-assets.md](export-and-assets.md) の 5.1 節）は **未検証**（`render-worker-core` の PoC） |
| サーバーの書き出し（一括、MVP の後の公開 API） | 毎秒 1 × 5 CPU 秒 | 仮定 |
| 必要な vCPU（ピーク） | 約 20 | 15 ＋ 5 |
| タスク（4 vCPU・16 GB） | ピーク 6、上限 12 | 子のプロセスは 8 GiB の上限（同 5.1 節）。1 タスクで同時に 2 つ |

- `render-export` の待ちを優先し、`render-thumbnail` は滞留を許す（同 10 節）。スケールは、キューごとの最古のメッセージの経過時間で行う。

## 9. 負荷試験の計画

staging を本番と同じ台数に広げて行う。E12 のリリースの基準にする。

### 9.1 道具

| 道具 | 使いどころ |
| --- | --- |
| `mp-loadbot`（Rust。`doc-model` の符号化と同じコード） | マルチプレイヤーの接続。`Hello`・`Changes`・`Presence` を送り、`Ack`・`Committed` の遅延を計る。操作の型（ドラッグ、テキスト、貼り付け、在席だけ）を混ぜる |
| k6 | API、Realtime、チケットの発行 |
| AWS FIS | タスクの停止、AZ の切り離し、DynamoDB のグローバルテーブルの複製の停止 |
| 参照ファイル | 1 万・10 万・30 万・100 万ノード（[document-model.md](document-model.md) の 17 節）。本番のファイルは使わない |

### 9.2 シナリオ

| # | シナリオ | 負荷 | 合格の基準 |
| --- | --- | --- | --- |
| L1 | S1 の定常 | 接続 5 万、開いたファイル 1 万、確定 毎秒 4,200 を 2 時間 | NFR-001（ボットの組で p99 250ms）、`edit_commit` 99.95%、Document Server のメモリ 80% 以下、DynamoDB のスロットリング 0 |
| L2 | 人が集まるファイル | 1 ファイルに 500 接続（編集 200）、L1 と同時 | そのファイルが手放されない、予算の段が働く、他のファイルの NFR-001 が変わらない |
| L3 | 会議の始まり | 10 万ノードのファイルを 300 人が 1 分以内に開く | 開く時間の p75 5 秒（NFR-003）、Document Server の送信が `tail` だけ、CloudFront のヒットの率 |
| L4 | 再接続の殺到 | Gateway 1 タスクを落とす。次に全 Gateway を 1 分で入れ替える。最後に `ds-standard` を 1 タスク落とす | 再接続の成功 99%、Gateway の落ちで API のチケットの発行が増えない（再開のトークン）、API の 429 が回復の後に 0、確定の損失 0 |
| L5 | Document Server の障害 | `ds-standard` を 1 タスク落とす。次に 1 AZ を切り離す | `owner_recovery` の p95 15 秒（NFR-007）、確定の損失 0 |
| L6 | デプロイ中の負荷 | L1 の最中に Document Server と Gateway を入れ替える | ファイルごとの中断 p95 2 秒、`edit_commit` の悪いイベントの増加なし |
| L7 | ジャーナルの遅れ | DynamoDB への呼び出しに遅延とスロットリングを注入（テスト用の中継） | 10 秒で手放し、再接続で回復、二重の書き込みなし |
| L8 | 書き出しの急増 | サムネイルの 10 倍、一括の書き出し 毎秒 5 | `render-export` の待ちの p95 5 秒、Document Server と API の遅延が変わらない |
| L9 | 大阪への切り替え | 複製を止めて 30 秒後に切り替え | 失った範囲 1 分以内、`dr-salvage` が取り戻す（[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)） |
| L10 | 大きなファイルの割り当て | 100 万ノードのファイルを 20 個、同時に開く | `ds-large` に置かれ、`ds-standard` のメモリが上がらない |

- 各シナリオで、見積もり（1〜8 節）と実測を並べて、この文書の数値を置き換える。

## 10. パラメーター

| パラメーター | 値 | 定める場所 |
| --- | --- | --- |
| Gateway の 1 タスクの接続の上限 | 1 万 | 2 節 |
| クライアントの予期しない切断の最初の待ち | 0〜5 秒の一様な乱数 | 2.2 節 |
| `Kick(server_shutdown)` の散らし | 0〜60 秒 | [infrastructure.md](infrastructure.md) の 4 節 |
| Document Server の受け入れの上限 | タスクのメモリの 75% | ADR-0051 |
| 新しいファイルを置かない | 80% | ADR-0051 |
| 渡しを始める | 85% | ADR-0051 |
| `ds-large` に置く見積もり | 1.5 GiB | ADR-0051 |
| 見積もりの係数 | 3（＋16 MiB） | 3 節 |
| 1 タスクのファイルの上限 | 5,000 | ADR-0051 |
| 1 タスクの同時の直列化 | 4 | ADR-0051 |
| 生存の期限・延長の間隔・猶予 | 10 秒・2 秒・2 秒 | [ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md) |
| router の割り当ての上限 | 毎秒 200 | 5 節 |
| 回復のジョブの割り当ての上限 | 毎秒 50 | [infrastructure.md](infrastructure.md) の 5.3 節 |
| ドレインの渡しの速さ | 1 タスク 毎秒 20 ファイル | ADR-0046 |
| 1 ファイルの書き込みの予算 | 毎秒 400 単位 | ADR-0052 |
| 予算の段 | 50%・80%・100% | ADR-0052 |
| `journal` の warm throughput | 書き込み 毎秒 5 万 | 4.1 節 |

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `mp-loadbot` | 9.1 節の負荷の道具 |
| E3 | `ds-memory-accounting` | ファイルごとのメモリの計測と `ds_liveness` への報告 |
| E3 | `ds-admission-and-shedding` | ADR-0051 の受け入れ、80%・85% の段 |
| E3 | `journal-write-budget` | ADR-0052 の予算と段、クライアントへの間隔の指示 |
| E3 | `reconnect-jitter` | 2.2 節の最初の待ちの散らし |
| E3 | `gateway-resume-token` | 2.2 節の再開のトークン（permissions-and-sharing.md の 5.5 節） |
| E1 | `dynamodb-warm-throughput` | warm throughput と表の上限の申請 |
| E12 | `load-test-suite` | 9.2 節の L1〜L10 |

## 12. 未解決の問い

### 決定（2026-09-27、既定案）

- 1 ファイル平均 41 MB、Document Server の台数はメモリで決める。
- Gateway の 1 タスク 1 万接続。
- 再接続の殺到は、Gateway の再開のトークン（60 秒、`session_id`・`file_id`・`epoch` に束ねる）で API のチケットの経路を避ける（permissions-and-sharing.md の 5.5 節）。
- 1 ファイルの書き込みの予算は 毎秒 400 単位。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| ファイルの大きさの分布と、見積もりの係数 | E7 の計測、試用の期間 |
| Gateway の 1 メッセージの CPU と、1 タスクの接続の上限 | E3 の計測 |
| `ConditionCheck` の単位の種類と、フェンスの確かめ方の費用 | E3 の PoC（`ReturnConsumedCapacity` で計る） |
| CloudFront の配信の量（端末のキャッシュの当たりの率） | 試用の期間 |
| 料金の単価 | E12 の前に、AWS の料金の計算ツールで置き換える |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 9.2 節の L1〜L10 の合格の基準を、E12 のリリースの基準にする。
- 予算の段に入ったファイルの反映の遅延を、NFR-001 の対象に含めるかを QA が決める（ADR-0052）。

### runbooks

- [runbooks/incident-response.md](../runbooks/incident-response.md) の「人が集まるファイル」「再接続の殺到」。
- `ds-memory-pressure.md`：Document Server のメモリが 85% を超え続けるときの確かめ方（大きなファイル、見積もりの外れ）と、台数の引き上げ。

### data-model

- 追加の置き場所はない。`ds_liveness` の負荷の列は [infrastructure.md](infrastructure.md) の 5.1 節。

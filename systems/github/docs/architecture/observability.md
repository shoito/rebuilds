# Observability: GitHub

ログ、メトリクス、トレース、SLI の計測、リポジトリごとの偏りの検知、合成監視。道具は Slack と同じ（OpenTelemetry、Amazon Managed Service for Prometheus、X-Ray、CloudWatch Logs、Amazon Managed Grafana。[Slack の ADR-0021](../../../slack/docs/decisions/0021-observability-stack.md)）。SLI と SLO の定義そのものは Ops の [runbooks/README.md](../runbooks/README.md) を正本とし、ここにはそれを計測する仕組みを書く。

## 1. 全体の流れ

```
 Git フロントエンド・ストレージのサービス（Go、OpenTelemetry Go SDK）
 Web・API・Worker（TypeScript、OpenTelemetry Node.js SDK）
        │ OTLP
        ▼
 ADOT Collector（ECS はサイドカー、ストレージのノードは各ノードのエージェント）
        ├─ traces  ─▶ X-Ray
        ├─ metrics ─▶ Amazon Managed Service for Prometheus
        └─ logs    ─▶ CloudWatch Logs

 Git の子プロセス（trace2 のイベント）─▶ ストレージのサービスが受け取り、スパンとメトリクスに変換
 ストレージのノード（node_exporter、NVMe の統計）─▶ ADOT ─▶ Prometheus
 Actions の実行環境（actions-runners-prod）─▶ 自分のアカウントの Prometheus・CloudWatch
 Amazon Managed Grafana（shared）が横断して見る
```

- 実行環境のアカウントのテレメトリは、prod に送らない。実行環境は信頼できないコードを動かすので、prod へ書ける経路を作らない。Grafana が両方のアカウントを読み取りで見る。
- ジョブの中身（ユーザーのコードのログ）は、テレメトリではなく Actions のログとして扱う（[actions.md](actions.md)）。

## 2. 計装

- Go の側（フロントエンド、ストレージ）と TypeScript の側で、属性名を 1 か所で定義する（`.proto` と同じリポジトリに置き、両方の言語の定数を生成する）。
- 共通の属性：`service.name`、`service.version`、`deployment.environment`、`cloud.availability_zone`（AZ ID）、`repo.id`（3.2 節の規則で扱う）、`storage.node`。
- Git の操作の属性：`git.service`（`upload-pack`・`receive-pack`・`ls-refs`）、`git.protocol`（`https`・`ssh`）、`git.protocol_version`、`git.client`（`agent` の値を、既知の名前と主要な版に丸めたもの）、`git.request_kind`（ref の確認・fetch・clone・push）、`git.bytes_sent`、`git.bytes_received`、`git.objects`。

### 2.1 トレースの伝播（Git の RPC を通して）

1 つの push を、クライアントの接続から、複製の合意、Event、Webhook・Actions の起動まで追えるようにする。伝播には W3C Trace Context を使う。

| 境界 | 運び方 |
| --- | --- |
| Git のクライアント → フロントエンド | Git のクライアントは `traceparent` を送らない。フロントエンドがトレースを始める。HTTPS で `traceparent` が付いていれば（自社のツール、Actions の実行環境）続ける |
| フロントエンド → ストレージ（gRPC） | gRPC のメタデータの `traceparent` |
| ストレージ → 他の複製（合意、書き込み） | 同上。複製ごとに子のスパン |
| ストレージのサービス → Git の子プロセス | 子プロセスの環境変数で trace2 の出力先（`GIT_TRACE2_EVENT` に Unix ソケット）を渡す。ストレージのサービスがイベントを受け、段階（`index-pack`、`pack-objects` など）ごとの時間をスパンにする（[trace2 の API](https://git-scm.com/docs/api-trace2)） |
| ストレージ → push の Event（outbox） | Event の記録に `trace_context` を持たせる |
| outbox → SQS → Worker → Webhook・Actions | メッセージ属性 `traceparent`。1 つの push の Event から多数の Webhook・ジョブが出るので、下流のスパンはスパンリンクでつなぐ |
| Web・API → ストレージの読み取りの RPC | gRPC のメタデータ |

- trace2 のイベントには、コマンドの引数やパスが含まれうる。ストレージのサービスで許可リストの項目（段階の名前、時間、件数、終了コード）だけを残し、パス・ref の名前・引数は捨てる（4 節）。
- ref の確認だけで終わる fetch（[capacity.md](capacity.md) の 1 節で 1,300 件/秒）は数が多く、1 件の価値が低いので、サンプリングの割合を下げる（2.2 節）。

### 2.2 サンプリング

| 対象 | 割合 |
| --- | --- |
| push | 100%（件数が少なく、耐久性の調査に要る） |
| clone、差分のある fetch | 10% |
| ref の確認だけの fetch | 1% |
| Web・API | 10% |
| エラー、または 5 秒を超えたもの | 100%（S1 では、フロントエンドとストレージのサービスが終了時に判定して残す。中央での末尾のサンプリングは S2 で検討） |
| 合成監視のリポジトリ | 100% |

## 3. メトリクス

### 3.1 種類

| 種類 | 対象 | 主な指標 |
| --- | --- | --- |
| RED | フロントエンド、ストレージの RPC、Web・API、Worker | 件数、エラー、時間のヒストグラム。Git の操作の種類・プロトコルごと |
| USE | ストレージのノード、Aurora、Valkey、SQS、ALB・NLB | CPU、メモリ、ディスクの使用率と待ち、ネットワーク、子プロセスの待ち |
| 複製 | ストレージの制御 | 複製が 3 つそろっていないリポジトリの数、修復の待ち件数と最古の経過時間、チェックサムの不一致の件数、合意の失敗 |
| 耐久性 | バックアップ | バックアップの遅れ（最後の push からバックアップまで）の分布、失敗の件数 |
| 業務 | 全体 | push/秒、clone/秒、外向きの転送量、PR の作成、Actions のジョブ/分 |

- ストレージのノードの NVMe は、ドライバの統計と、インスタンスストアの詳細な性能の統計（[AWS のドキュメント](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/nvme-detailed-performance-stats.html)）を集める。読み書きの遅延の悪化を、ディスクの故障の予兆として見る。
- 時計は Amazon Time Sync Service で合わせる。遅延はサーバーの時計で測る。

### 3.2 リポジトリごとの偏りの検知とカーディナリティ

リポジトリは 100 万あるので、`repo.id` をそのままラベルにすると系列が爆発する。一方、障害の多くは「特定のリポジトリへの集中」から来る（人気の OSS の clone、CI の大量の fetch、巨大なモノレポ）。次の規則で両立させる。

- **上位 K 件だけをラベルにする。** フロントエンドとストレージのサービスは、直近 5 分の負荷（件数、送信バイト、CPU 秒）で上位のリポジトリを近似的に数える（Space-Saving などの重い要素の近似のアルゴリズムで、メモリを一定に保つ）。上位 50 件だけ `repo_id` を付け、残りは `repo_id="other"` にまとめる。
- **CPU 秒はプロセスで測る。** Git の子プロセスの CPU 時間（`rusage`）を、終了時にリポジトリに帰属させる。ノードの CPU の 20% 以上を 1 つのリポジトリが使い続けたら、チケットを作る。
- **ラベルを付ける指標を決める。** 件数、送信バイト、CPU 秒、エラー数、待ちの件数。時間のヒストグラムには付けない。
- **持ち主（ユーザー・Organization）でも同じ規則で上位 50 件を見る。** 1 つの持ち主が多数のリポジトリへ分散して負荷をかける場合（CI の大量の fetch）に気づくため。
- ストレージのノードは、ノード名をラベルに持つ（42 台なので問題ない）。
- 非公開のリポジトリの名前はラベルにもログにも出さない。`repo_id` だけを出し、名前が必要なときは、権限のある人が管理の画面で引く。
- 系列の数を監視し、環境ごとの上限（初期値 100 万系列）の 80% でアラートを出す。
- 偏りへの対処（上限、読み取りの複製の追加、利用者への連絡）は [runbooks/incident-response.md](../runbooks/incident-response.md) の「ホットなリポジトリ」。

## 4. ログ

- 1 行 1 JSON の構造化ログ。共通の項目は Slack と同じ（`ts`、`level`、`service`、`version`、`env`、`az`、`trace_id`）。
- Git の操作のログ（アクセスログ）は 1 操作 1 行で、次を持つ。

  | 項目 | 内容 |
  | --- | --- |
  | `repo_id`、`actor_id`、`actor_type`（ユーザー・App・トークン・匿名） | 誰が、どのリポジトリに |
  | `git.service`、`git.protocol`、`git.request_kind` | 何を |
  | `status`、`duration_ms`、`bytes_sent`、`bytes_received` | 結果 |
  | `storage.node`、`replicas_acked`（push のみ） | どの複製で。push では合意した複製の数 |
  | `ref_update_count`（push のみ） | 更新した ref の数（名前は出さない） |

- **出さないもの。** ファイルの中身、パス、ブランチ・タグの名前、コミットのメッセージ、非公開のリポジトリの名前、トークン、`Authorization` ヘッダー、SSH の鍵。ブランチの名前にも秘密が含まれうる（非公開の製品名など）。ロガーは許可リスト方式にし、CI で禁止した項目が渡されていないかを lint で検査する。
- **ref の更新の記録は、ログではなくデータとして持つ。** 誰が、いつ、どの ref を、どのコミットからどのコミットへ動かしたかは、監査と、災害復旧で失った push を列挙するのに使う（[infrastructure.md](infrastructure.md) の 5.2 節）。ストレージの側の push の Event として DB に持ち、権限の判定を通して読む（[security.md](security.md)）。
- IP アドレスは、セキュリティの監査ログにだけ残す（[security.md](security.md)）。

## 5. SLI の計測、アラート、合成監視

### 5.1 SLI の計測

| SLI（runbooks） | 計測に使うメトリクス | 備考 |
| --- | --- | --- |
| Git の操作の成功率（NFR-001） | フロントエンドの操作のうち、サーバーの原因の失敗（5xx 相当、ストレージの RPC の失敗、途中の切断）以外の割合 | 認証の失敗、権限の拒否、上限（429）、クライアントの切断は成功として数える |
| fetch の開始までの時間 p95（NFR-003） | 要求の受信から、パックの最初のバイトを送るまでの時間。1 GB 未満のリポジトリに限る | ref の確認だけで終わる fetch は別の系列にする |
| push の成功までの時間 p95 | 受信の終わりから、成功の応答まで | 合意の遅れを見る |
| push の耐久性（NFR-002） | (1) 合意した複製が 2 未満で成功を返した件数（常に 0。1 件でも呼び出し）、(2) チェックサムの定期の検査の不一致の件数、(3) 複製が 3 つそろっていないリポジトリの数と、修復の最古の経過時間 | (1) は設計上起きないはずのもの。起きたら SEV1 |
| Web の表示 p95（NFR-004） | Pull Request の画面のサーバーの応答時間（差分 1,000 行まで）と、RUM の LCP | |
| Webhook の遅れ p95（NFR-006） | Event の発生（push の合意、PR の変更）から、最初の配信の試行まで | 外部の応答時間は含めない |
| Actions のキューの時間 p95（NFR-007） | ジョブがキューに入ってから、実行環境で実行が始まるまで | ホストされた標準の実行環境に限る |
| 検索への反映（NFR-005） | Event の発生から、索引に入るまで | [search.md](search.md) |
| 通知の遅延 p95（NFR-011） | outbox のイベントの作成から、(1) 受信箱の upsert の完了、(2) SES への受け渡し、まで | 理由（`review_requested`、`mention` など）ごとに分ける。上限でまとめたメールは除く（[notifications.md](notifications.md) の 4.1 節） |
| バックアップの遅れ | push の合意から、大阪の S3 に書き終えるまで。p99 10 分 | NFR-009 の RPO の先行の指標 |

### 5.2 アラート

- Slack と同じ、マルチウィンドウのバーンレート・アラート（1 時間/5 分で 14.4、6 時間/30 分で 6、3 日/6 時間で 1）を、SLO の窓 30 日で計算する（[Slack の observability.md](../../../slack/docs/architecture/observability.md) の 5.2 節）。
- 呼び出し（page）のアラートは、SLO か、確実に利用者へ影響する症状に限る。GitHub に固有のものは次のとおり。

  | アラート | 条件 | 重さ |
  | --- | --- | --- |
  | 合意なしの成功 | 5.1 の push の耐久性 (1) が 1 件以上 | page、SEV1 |
  | 複製の不足 | 複製が 1 つしかないリポジトリが 1 件以上 | page |
  | 修復の遅れ | 修復の待ちの最古が 2 時間を超える | page |
  | ストレージのノードの喪失 | ノードが応答しない、または AWS Health の停止・退役の予定 | page（予定はチケット） |
  | バックアップの遅れ | p99 が 12 分を超える | page |
  | 権限の合成監視の失敗 | 5.3 の権限の確認で、読めてはいけないものが読めた | page、SEV1 |

- 原因側の指標（ノードの CPU、ディスクの充填率）は、ダッシュボードとチケットにとどめる。ただし充填率 75% はチケット、85% は page にする（repack と修復ができなくなるため）。
- すべてのアラートは、対応する runbook の URL を注釈に持つ。

### 5.3 合成監視

CloudWatch Synthetics のカナリアを大阪から実行し、prod の専用の Organization のリポジトリを使う。

| シナリオ | 頻度 |
| --- | --- |
| HTTPS と SSH で、小さなリポジトリを clone、1 コミットを push、別の経路で fetch して一致を確かめる | 1 分 |
| push から Webhook の受信（合成監視の受信先）まで | 1 分 |
| push から Actions のジョブの開始まで | 5 分 |
| Pull Request の画面の表示 | 1 分 |
| **権限の確認**：権限のないアカウントで、非公開のリポジトリの clone、API、検索、ファイルの取得、Webhook の再配信を試み、すべて拒否されることを確かめる（NFR-010） | 5 分 |

- 合成監視のリポジトリは、業務のメトリクスと課金から除く。

## 6. 保持期間とアクセス権

Slack と同じ（アプリのログは prod 30 日、メトリクス 150 日、トレース 30 日、CloudTrail・VPC フローログは log-archive に 1 年）。違いは次のとおり。

- Git の操作のアクセスログは 90 日残す（濫用の調査のため。[security.md](security.md)）。
- 本番のログとトレースは、prod のアカウントから出さない。読めるのは Ops と、Ops が許可した Dev に限る。AI エージェントは本番のログへの経路を持たない。
- 実行環境のアカウントのログは、実行環境のアカウントに置き、prod の人の権限で読む。

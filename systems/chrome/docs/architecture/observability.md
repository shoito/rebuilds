# Observability: Chrome

クラウドのサービスの計測（ログ、メトリクス、トレース）と、ブラウザの端末の側の指標（クラッシュ率、起動の時間、更新の普及）の集め方、SLO の計測、アラート、保持とアクセス。サービスの計装と道具は、Slack の [ADR-0021](../../../slack/docs/decisions/0021-observability-stack.md) と [observability.md](../../../slack/docs/architecture/observability.md) を引き継ぐ（OpenTelemetry、Amazon Managed Service for Prometheus、X-Ray、CloudWatch Logs、Amazon Managed Grafana）。ここには Chrome に固有のことだけを書く。

**SLI・SLO の値とアラートの一覧の正本は、Ops の [runbooks/README.md](../runbooks/README.md) の 1・4 節** に置く。ここには、それを計測する仕組みを書く。4・5 節は、正本を計測・実装する側の記述である。端末の指標の同意と中身は [ADR-0032](../decisions/0032-crash-and-telemetry-privacy.md) に従う。

## 1. 全体の流れ

```
サービス（ECS）─ OTel ─▶ ADOT Collector ─▶ AMP・X-Ray・CloudWatch Logs     （Slack と同じ）
CloudFront・ALB・S3 ─▶ CloudWatch メトリクス、アクセスログ（IP を含むので短く保持）

端末（同意あり）
  テレメトリ ─▶ telemetry-ingest ─┬─ 検証・間引き ─▶ Data Firehose ─▶ S3（Parquet）─▶ Athena
                                  └─ 集計のカウンター ─▶ AMP（版・チャンネル・OS ごと）
  クラッシュ ─▶ crash-ingest ─▶ symbolicator ─▶ Aurora（シグネチャごとの件数）─▶ AMP
端末（同意と無関係）
  更新の確認・結果のイベント ─▶ update-server ─▶ AMP（版ごとの活動中の端末、失敗の率）

AMP ─▶ rollout-guard（配信の自動の停止）、Grafana、Alertmanager ─▶ オンコール
```

- **配信の判断に使う指標は、AMP に集める。** rollout-guard（[update-and-release.md](update-and-release.md) の 4.3 節）は PromQL で前の版と比べる。版・チャンネル・OS・プロセスの種類のラベルは値の数が少ないので、系列の数は問題にならない。
- 詳しい分析（シグネチャの内訳、フィールドトライアルの効果）は、S3 の Parquet を Athena で調べる。

## 2. サービスの計装

Slack の 2〜4 節と同じ。Chrome に固有の点は次のとおり。

- **利用者の識別子を、ログ・トレースのラベルに入れない。** 更新・Safe Browsing・クラッシュ・テレメトリの要求には、もともと利用者の ID がない（[update-and-release.md](update-and-release.md) の 4.1 節）。アカウント・同期は、アカウントの ID をログに入れてよいが、メトリクスのラベルにはしない。
- **IP アドレスをアプリのログに出さない。** レート制限は WAF と ALB で行い、アプリは IP を扱わない。
- update-server の業務のメトリクス：更新の確認の数（版・チャンネル・OS）、返した版、段階の区画の判定の結果、パイプラインの種類（差分・全体）、結果のイベント（成功・エラーの種類）。

## 3. 端末の指標

### 3.1 何を測るか

| 指標 | 定義 | 出どころ | 同意 | 対応する NFR |
| --- | --- | --- | --- | --- |
| Browser プロセスのクラッシュ率 | Browser プロセスのクラッシュ ÷ セッション × 1,000。版・チャンネル・OS ごと | テレメトリの安定性の集計（クラッシュの件数とセッション数） | 要 | NFR-005 |
| Renderer・GPU・Utility のクラッシュ率 | 同上（プロセスの種類ごと） | 同上 | 要 | — |
| 起動直後のクラッシュ率 | 起動から 30 秒以内の Browser のクラッシュ ÷ 起動 | 同上 | 要 | — |
| 起動の時間 | ウォームの起動で、最初の画面の描画まで。p50・p75・p95 | テレメトリ（ヒストグラム） | 要 | NFR-001 |
| Core Web Vitals | 訪れたページの LCP・INP・CLS の分布（URL は送らない） | テレメトリ | 要 | NFR-002 |
| メモリ | Browser・Renderer の合計の分布、タブの数ごと | テレメトリ | 要 | NFR-004 |
| 更新の普及 | 直近 48 時間に活動した端末のうち、その版で動いている割合 | 更新の確認の活動の数え方（プロトコル 4） | 不要（更新の機能） | NFR-006 |
| 更新の失敗率 | 結果のイベントのうち失敗の割合。エラーの種類ごと | 更新の結果のイベント | 不要（更新の機能） | — |
| 再起動までの時間 | 更新のダウンロードから、新しい版で起動するまで | テレメトリ | 要 | NFR-006 |
| Safe Browsing のリストの鮮度 | 端末のリストの版の時刻と、今の時刻の差の分布 | テレメトリ | 要 | NFR-009 |
| 同期の反映の遅延 | 変更の送信から、別の端末での受信まで（サーバーの時刻で） | 同期のサービス | 不要（サーバー側で測る） | NFR-008 |

- **更新の普及は、同意のない端末も含めて数える。** Omaha のプロトコル 4 は、クライアントが「前回いつ数えられたか」を自分で管理して送る方式で、ID なしに 1 日あたりの活動中の端末を重複なく数えられる（[Omaha プロトコル 4](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/updater/protocol_4.md)）。
- **クラッシュ率は、同意した端末だけの値である。** 同意する人が偏る（開発者、新しい機器）と、全体の値とずれる。Beta と Stable の値の比と、クラッシュの報告の画面から送られた件数で、偏りを定期的に見る。
- 本家の UMA のヒストグラムの規則（持ち主、期限、記録の条件を書く）に倣い、指標の登録簿を持つ（[histograms の README](https://chromium.googlesource.com/chromium/src/+/HEAD/tools/metrics/histograms/README.md)、[update-and-release.md](update-and-release.md) の 10 節）。

### 3.2 取り込みの検証

- telemetry-ingest は、登録簿にない指標、期限の切れた指標、範囲の外の値を捨てる。捨てた数を指標にする。
- 1 つのレポートの大きさと、同じセッションからのレポートの頻度に上限を置く。
- レポートにはセッションの中でだけ有効な乱数の ID しかないので、利用者の単位の集計はできない。できないことを前提に、指標はすべて「セッションあたり」「起動あたり」「ページあたり」の率にする。

### 3.3 リリースのダッシュボード

版ごと（新しい版と 1 つ前の版を並べる）に、次を 1 画面に並べる。release owner が段階を進める判断に使う。

- 配信の段階、区画の割合、実際に新しい版で動いている端末の数
- 3.1 のクラッシュ率・起動の時間、と前の版との比、判定に足りる標本か
- 新しい版で上位に入ったクラッシュのシグネチャ
- 更新の失敗率（エラーの種類ごと）
- rollout-guard の判定の履歴

## 4. SLI と SLO の計測

NFR-010 を受けた SLI と、その計測の場所。値の正本は [runbooks/README.md](../runbooks/README.md) の 1 節（この表を採った）。窓は 30 日（Slack と同じ）。

| サービス | SLI | SLO |
| --- | --- | --- |
| 更新の確認 | update-server の要求のうち、2 秒以内に 5xx 以外を返した割合（ALB で測る） | 99.95% |
| 成果物の配信 | CloudFront の成果物の要求のうち、5xx 以外の割合 | 99.95% |
| Safe Browsing のリスト | リストの要求のうち、5xx 以外の割合。加えて、最新の版の生成から配信まで 10 分以内の割合 | 99.95% |
| Safe Browsing の照会 | 1 秒以内に 5xx 以外を返した割合 | 99.95% |
| Safe Browsing の判定（端から端） | テスト用の URL をリストに載せてから、合成の端末で判定されるまで | 30 分以内（NFR-009） |
| 同期 | 同期の要求のうち、5xx 以外の割合 | 99.9% |
| 同期の反映 | 反映の遅延が 10 秒以内の割合（NFR-008） | 95% |
| アカウント | ログイン・トークンの更新のうち、5xx 以外の割合 | 99.9% |
| 拡張機能のストア | 更新の確認とパッケージの取得のうち、5xx 以外の割合 | 99.9% |
| 拡張機能の停止の一覧の反映 | 一覧への追加から、合成の端末で無効になるまで | 30 分以内（ADR-0026） |
| クラッシュ・テレメトリの受け取り | 受け取りの要求のうち、5xx 以外の割合 | 99.5% |

端末の品質の指標（NFR-001・005・006）は、SLO ではなく、リリースの判定の基準と自動の停止の条件として使う（[update-and-release.md](update-and-release.md) の 4.3 節）。判定の基準の値は QA が [quality.md](../quality.md) で決める。

## 5. アラート

Slack の 5.2 節のマルチウィンドウのバーンレートを、4 節の SLI に使う。Chrome に固有のアラート：

| アラート | 条件 | 重さ | 手順 |
| --- | --- | --- | --- |
| 配信の自動の停止 | rollout-guard が段階を凍結した | 呼び出し（営業時間外は Stable のみ） | [bad-release-rollback.md](../runbooks/bad-release-rollback.md) |
| 新しい版のクラッシュの急増 | 新しい版の Browser のクラッシュ率が、前の版の 1.5 倍を超え、かつ 1,000 セッションあたり 0.5 を超える（標本が足りる場合。[update-and-release.md](update-and-release.md) の 4.3 節） | 呼び出し | 同上 |
| 更新の失敗率 | 結果のイベントの失敗が 5% を超える（版ごと） | 呼び出し | 同上 |
| 緊急の修正の普及の遅れ | `urgency=critical` の版の普及が、24 時間で 60% に届かない | チケット（release owner） | [emergency-security-release.md](../runbooks/emergency-security-release.md) |
| Safe Browsing のリストの遅れ | 最新のリストの生成から 20 分たっても CDN に出ていない（NFR-009） | 呼び出し | [service-incident-response.md](../runbooks/service-incident-response.md) |
| 署名の工程の失敗 | リリースの署名・OS の署名・公証の失敗 | 呼び出し（緊急の修正の最中）、それ以外はチケット | 緊急の修正の最中は [emergency-security-release.md](../runbooks/emergency-security-release.md)、それ以外は `signing-key-rotation.md`（E10 で作成） |
| シンボルの欠落 | シンボル化できないクラッシュが、ある版で 5% を超える | チケット | `symbolication-gap.md`（E9 で作成） |
| SLO の速いバーンレート | 4 節の SLI | 呼び出し | [service-incident-response.md](../runbooks/service-incident-response.md) |

- すべてのアラートは、対応する runbook の URL を持つ（Slack と同じ規則）。

## 6. 保持とアクセス

| データ | 置き場所 | 保持 | 読める人 |
| --- | --- | --- | --- |
| サービスのログ | CloudWatch Logs（各アカウント） | prod 30 日 | Ops、許可された Dev |
| CloudFront・ALB・WAF のアクセスログ | S3 | 7 日（IP を含むため） | Ops |
| メトリクス（端末の集計を含む） | AMP | 150 日 | 全ロール |
| テレメトリのレポート（Parquet） | prod-diagnostics の S3 | 90 日。その後は集計だけを残す | 分析の読み取りのロール（Dev、QA、PM） |
| クラッシュのダンプ（生） | prod-diagnostics の S3 | 30 日 | 許可された Dev（読み取りのたびに記録） |
| クラッシュの集計（シグネチャ、スタック） | prod-diagnostics の Aurora | 2 年 | Dev、QA |
| シンボル | ci・prod-diagnostics の S3 | 配布を終えた版から 2 年 | symbolicator、Dev |

- 生のダンプは、利用者のメモリの一部を含みうる。開発者の端末へのダウンロードは、Issue の番号を記録したときだけ許し、prod-diagnostics の中の調査用の環境で開くことを基本にする。
- AI エージェントは、生のダンプとテレメトリのレポートへの経路を持たない。集計とシグネチャ・スタックだけを渡す。
- 利用者が同意を取り消したら、端末は未送信のレポートとダンプを消す。送信済みのものは ID で結び付けられないので、保持の期限で消える。この扱いをプライバシーの説明に書く（ADR-0032）。

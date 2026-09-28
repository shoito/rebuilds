# Observability: Linear

ログ・メトリクス・トレース、クライアントの RUM（遅延の予算の印、起動、outbox）、同期の伝播の計測、収束の監査、配信の監査、SLI・SLO、アラートと runbook の対応、合成監視を決める。道具は他の題材と同じ（OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs、Managed Grafana。Slack の ADR-0021 を引き継ぐ）。

| ADR | 決定 |
| --- | --- |
| [0052](../decisions/0052-rum-and-propagation-measurement.md) | RUM は自前の収集の口（`/rum`）に、端末で集めたヒストグラム（Action の ID ごとの遅延、起動、伝播）を 60 秒ごとに送る。中身・識別子を送らない。伝播は、Writer がコミットの直前の時刻を範囲に付けて差分と一緒に運び、クライアントは ping の往復で見積もったサーバーとの時計の差で「確定から適用まで」を測る。サーバーの区間は各部品の時計で測り、合成監視の 2 つのクライアントを別に持つ |
| [0053](../decisions/0053-convergence-audit.md) | 収束の監査は、抜き取った端末が静かな時に、IndexedDB の確定した行のハッシュを、モデル×256 の桶ごとに `(workspace_id, L, sync_epoch)` と一緒に送る。サーバーは今の行と `sync_actions` から `L` の時点の状態を作り直して比べ、合わない桶の行の ID を 2 段目で特定する。説明のつく不一致（保持の外、退かし）を除いた不一致を K5 に数え、同じ報告で手元の行の `_g` が購読の外にないかも確かめる |

## 1. 全体の流れ

```
 クライアント（Web・Electron）
   │ RUM：60 秒ごとに集めたヒストグラム ─▶ /rum（sync-api）─▶ OTel ─▶ AMP（少ない次元）
   │                                                         └──▶ Firehose ─▶ S3（Parquet）─▶ Athena（細かな分析）
   │ 収束の監査の報告（抜き取り）─▶ /sync/audit ─▶ SQS ─▶ audit-worker ─▶ convergence_audits（結果）
   │ エラーの報告（スタック、Action の ID、版）─▶ /rum/errors
   ▼
 サーバー：ADOT のサイドカー ─▶ AMP（メトリクス）、X-Ray（トレース）、CloudWatch Logs（JSON のログ）
   Gateway の配信の監査の抜き取り ─▶ Firehose ─▶ S3 ─▶ 日次の検査
 合成監視（synthetics のアカウント、prod の VPC の外から CloudFront 経由）─▶ AMP
 Managed Grafana：ダッシュボード、アラート（runbook の URL つき）
```

## 2. 計装

### 2.1 中身を出さない

- ログ・トレース・メトリクス・RUM・エラーの報告に、利用者の書いた中身（タイトル、本文、コメント、ラベルの名前、ビューの条件の文字）、識別子（`ENG-123`）、メールアドレス、トークン、URL の問い合わせの部分を出さない。
- 出してよいもの：`workspace_id`、`user_id`（ID だけ）、`sync_id`、`client_tx_id`、モデルの名前、フィールドの名前、理由のコード、件数、大きさ、時間、版、`schema_hash`。
- アクセスのログは、パスの ID の部分を残し、問い合わせの部分を落とす（ビューの URL の文字の条件。[views-and-filters.md](views-and-filters.md) の 7.3 節の依頼）。CloudFront・ALB のログも同じにする（ALB のアクセスログは問い合わせを落とせないので、`/sync/*` と `/graphql` の ALB のアクセスログを無効にし、アプリのログで数える。Auth0 の題材の ADR-0061 と同じ考え方）。
- `Authorization`、クッキー、`<Brand>-Signature`、Slack・GitHub の署名のヘッダーは、どの層でも伏せる。
- ログの秘密の形の走査（`<brand>_api_` などの接頭辞、外部のトークンの形）を常時流し、見つけたら呼び出す（Auth0 の題材と同じ）。

### 2.2 トレース

- W3C Trace Context。Gateway は `submit` ごとにトレースを始め、Writer・Relay・Worker（通知、Webhook、索引）へ、`sync_outbox` の範囲と SQS のメッセージの属性で `traceparent` を運ぶ。
- クライアントからは `traceparent` を送らない（RUM とトレースを結ばない）。調査で要るときは、`client_tx_id` で結ぶ。
- サンプリング：`submit` は 1%、エラーと 1 秒を超えるものは全部（テールサンプリング）。

### 2.3 メトリクスの次元

- `workspace_id` はメトリクスの次元にしない（5,000〜30 万で数が多い）。ワークスペースの大きさの帯（`ws_band`：S・M・L・XL）を使う。
- ワークスペースごとの値が要るもの（ロックの待ち、書き込みの量）は、上位 50 だけを 1 分ごとに別のメトリクス（`top_workspace_*`）に出し、残りはログの集計（CloudWatch Logs Insights）で見る。

## 3. クライアントの RUM

ADR-0052。

### 3.1 送るもの

| 系統 | 中身 | 抜き取り |
| --- | --- | --- |
| 操作の遅延（NFR-001） | Action の ID ごとの、入力から描画までのヒストグラム（[client-app.md](client-app.md) の 9.2 節の印）、Event Timing の 104ms 超えの件数、長い仕事の件数 | 端末の 10% |
| 起動（NFR-003） | 経路（手元・全体・部分・やり直し）ごとの操作できるまでの時間、内訳（ダウンロード・解析・IndexedDB の書き込み） | 全部 |
| 伝播（NFR-002） | 送信から ack、確定から適用（3.3 節）のヒストグラム | 端末の 10% |
| outbox（NFR-004） | 未送信の件数と最古の年齢の分布、「保存していない」表示の回数、strict のコミットの時間 | 全部 |
| 保存 | `persist()` の結果、`usage/quota` の帯、退かしの回数、`QuotaExceededError` | 全部 |
| やり直し | 理由（`too_old`・`too_far`・`epoch`・`ahead`・`migration`・`corrupt`）ごとの回数 | 全部 |
| メモリー | ヒープの p95（[client-store-and-offline.md](client-store-and-offline.md) の 7.2 節） | 端末の 10% |

- 次元：`action_id`、`app`（`web`・`electron`）、`browser`（系統と大きな版）、`os`、`ws_band`、`build`（直近の 3 版まで。古いものは `older`）。
- 端末で、対数の固定の桶（1ms〜60 秒、隣の桶の比 1.2）のヒストグラムに集め、60 秒ごとと `visibilitychange` で `sendBeacon` を使って送る。1 回の送信は 16 KiB まで。

### 3.2 収集の口

- `POST https://<brand>.<domain>/rum`（`sync-api`）。セッションのクッキーで認証し（ログインしていない画面の RUM は取らない）、端末ごとに 1 分 5 回までに絞る。値の範囲と次元の値の一覧を確かめ、外れたものを捨てる。
- AMP へは、上の次元のヒストグラムとして出す（系列の数の見込み：Action 約 100 × app 2 × browser 6 × ws_band 4 × build 4 ≒ 2 万）。細かな分析（OS の版、IME の有無など）は Firehose で S3 の Parquet に置き、Athena で読む（13 か月）。
- 外部の分析の事業者に送らない。自前の収集の口にするのは、法務の L2（外部送信の規律）の範囲を狭めるため（[client-app.md](client-app.md) の 9.3 節）。公表の文面は法務の確認を待つ。

### 3.3 伝播の計測

```
 Writer：COMMIT の直前に c = 今の時刻（ミリ秒、タスクの時計）→ sync_outbox.committed_at
 Relay ：Valkey のメッセージに {from, to, c}
 Gateway：受けた時刻 g_in、送った時刻 g_out を測り、deltas に {from, to, c} を付ける
 クライアント：保存と適用の後の時刻 a（端末の時計）
              サーバーとの時計の差 θ を ping/pong から見積もる：θ = ((t1 − t0) + (t2 − t3)) / 2、誤差 ≦ RTT/2
              確定から適用 = (a − θ) − c
```

- `pong` に Gateway の受けた時刻と返した時刻を入れる（[sync-engine.md](sync-engine.md) の 9.2 節。反映済み）。
- 次のときは数えない：`catch_up` とブートストラップの差分（確定からの時間が「伝播」ではない）、RTT が 200ms を超えて誤差が大きいとき、タブが背景のとき（タイマーの間引き）。
- サーバーの区間（Writer → Relay、Relay → Gateway、Gateway の欠けの埋め、Gateway の送信）は、各タスクの時計（Amazon Time Sync）で `c` からの経過を測り、区間ごとのヒストグラムにする。予算は [sync-engine.md](sync-engine.md) の 7.6 節。
- 送信から ack（NFR-002 の 300ms）は、クライアントの時計だけで測れる（同じ時計の差）。サーバーの側でも、Gateway の `submit` の受けから ack の送りまでを測る。

## 4. 収束の監査

ADR-0053。NFR-005・K5：本番の抜き取りの検査で、説明のつかない不一致 0 件。

### 4.1 クライアントの報告

- 抜き取り：1 日に 1 回、端末の 5%（端末の ID のハッシュで決める）。接続していて、直近 5 秒に差分がなく、監査の対象のモデルに未確定の変更（`pending`）がないときに行う。
- 読むのは IndexedDB の確定した行（メモリーではない）。Web Worker で、画面の入力の経路を止めない（NFR-001）。
- 対象：
  - `instant` のモデルの全部（利用者、チーム、状態、ラベル、サイクル、プロジェクト、ビュー、通知など）。
  - `Issue`：手元にある行（全体のブートストラップの端末は完全さも比べる。部分の端末は、手元にある行の正しさだけを比べる）。
  - 遅延のモデル（コメントなど）と本文は、MVP では対象にしない（持ち越し）。
- 1 つのモデルを、ID の SHA-256 の最初の 1 バイトで 256 の桶に分け、桶ごとに `count` と、ID の順に並べた `(id, _u, 正準形の行)` の SHA-256 を作る。正準形は生成したコード（`packages/model`）の関数で、キーの順、数の表し方、`null` と欠けの扱いを決める。
- 報告：`{workspace_id, client_id, build, schema_hash, sync_epoch, L, groups_hash, evicted_keys_hash, models: {Issue: [{b, n, h}, …], …}, orphan_rows}`。`orphan_rows` は、手元の行のうち `_g` が今の購読のどれとも交わらない行の数（0 のはず。4.4 節）。

### 4.2 サーバーの突き合わせ

- 報告を SQS に入れ、`audit-worker` が reader で行う。
- 比べる状態は「`L` の時点の、その端末の購読で見てよい行」である。
  1. `L < floor`、`head − L > 50,000`、`sync_epoch` が違う、`L` の後にその利用者の `SyncSubscription` が変わった、のどれかなら、比べずに `skipped` とする（説明のつく理由）。
  2. 今の行のうち、`sync_groups` がその端末の `groups` と交わり、`updated_sync_id ≤ L` のものは、今の行をそのまま使う。
  3. `(L, head]` の `sync_actions` に現れる行（その後に変わった・消えた・移った行）は、同じ `model_id` の `sync_id ≤ L` の最後の `sync_actions` の行の全体（`update` は行の全体を運ぶ。ADR-0007）から作り直す。`L` 以前に `sync_actions` がない（保持の外で作られ、その後に変わった）行は、`skipped_rows` に数える。
  4. 同じ正準形と桶で、ハッシュを作って比べる。
- `(workspace_id, model, model_id, sync_id)` の索引を `sync_actions` に足す（[api-and-webhooks.md](api-and-webhooks.md) の `updatedFrom` と共有）。

### 4.3 不一致の特定と分類

- 合わない桶があれば、次のその端末の握手の `welcome` に `audit_followup: {audit_id, model, buckets}` を付ける。端末は、その桶の `(id, _u, 行のハッシュ)` の一覧を送り、サーバーは行の ID を特定する。
- 分類：

| 分類 | 意味 | K5 に数えるか |
| --- | --- | --- |
| `match` | 一致 | — |
| `skipped` | 4.2 節の 1 | 数えない |
| `evicted` | 端末が保存の上限で退かした（`evicted_keys_hash` で分かる）行だけが違う | 数えない |
| `retention` | 作り直しが保持の外 | 数えない |
| `stale_build` | 端末の `schema_hash` が互換の一覧の外れる直前で、正準形の違い | 数えない（別に数える） |
| `unexplained` | それ以外 | **数える** |

- `convergence_mismatches` に、ワークスペース・モデル・行の ID・端末の版・`L`・分類を残す（中身は残さない）。`unexplained` が 1 件でも出たら呼び出し（5 節）、[runbooks/incident-response.md](../runbooks/incident-response.md) の「収束の不一致」に従う。端末に `resync_required` を送り、その端末を正す。

### 4.4 配信の監査（NFR-008）

| 監査 | 方法 | 期待 |
| --- | --- | --- |
| Gateway の送信 | 送った変更の 1% を抜き取り、`(接続の groups, 変更の groups, groups_before, evict か)` を Firehose へ。日次のジョブで、`groups ∩ 接続の groups = ∅` なのに行を送ったものを数える | 0 |
| Sync API の読み出し | ブートストラップ・取り戻し・遅延の読み込みの行の 0.1% を同じ形で | 0 |
| 端末の手元 | 4.1 節の `orphan_rows`（手元の行の `_g` が購読と交わらない） | 0（脱退の直後の 1 分を除く） |
| 購読のずれ | `subscription_drift`（[permissions-and-teams.md](permissions-and-teams.md) の 5.3 節） | 0 |
| 検索の読み直しで落ちた数 | `search_hydration_drop`（[search.md](search.md) の 15 節） | 移動の直後以外で 0 |
| Webhook・書き出し | 権限で落とした数（期待どおりの落とし）と、送った後の再確かめの不一致 | 不一致 0 |

- 1 件でも期待を外れたら、SEV1 の候補として呼び出し、[runbooks/incident-response.md](../runbooks/incident-response.md) の「非公開のチームの漏えいの疑い」に従う。

## 5. SLI・SLO とアラート

### 5.1 SLI

**SLO の目標値の正本は [runbooks/README.md](../runbooks/README.md) の 1 節**。ここは定義と計測を書く。値を変えるときは runbooks/README.md を先に変え、ここを合わせる。

| SLI | 定義 | 計測 | 目標（案） |
| --- | --- | --- | --- |
| 操作の遅延（NFR-001） | 主要な Action（状態・優先度・担当・ラベル・並べ替え・コマンドメニュー・一覧の切り替え）の入力から描画 | RUM（`ws_band` が L・XL、基準の端末に近い帯。ブラウザの別） | 週の p99 50ms |
| 送信から ack（NFR-002） | クライアントの `submit` から `ack` | RUM、Gateway | p99 300ms |
| 伝播（NFR-002） | 確定から他のオンラインのクライアントの適用 | RUM（3.3 節）、合成監視 | p99 1 秒、p50 200ms |
| 起動（NFR-003） | 経路ごとの操作できるまで | RUM | 手元 p95 1.5 秒、全体（小）p95 3 秒、部分（最大）p95 10 秒 |
| outbox の耐久（NFR-004） | 失った未送信の件数（`lost_local` の報告、移行で失ったもの） | RUM、`client_devices` | 0（ブラウザの消去を除き、別に数える） |
| 収束（NFR-005） | 収束の監査の `unexplained` | 4 節 | 0 |
| 書き込みの経路の可用性（NFR-006） | `submit` のトランザクションのうち、`ok` か `reject`（検証の拒否）で答えたものの割合。`retry` のうち 60 秒以内に確定しなかったもの、5xx、Gateway の受け付けの失敗を失敗に数える | Gateway、Writer | 99.9%（30 日） |
| 差分の配信の可用性（NFR-006） | 合成監視の伝播の確かめのうち、10 秒以内に届いたものの割合 | 合成監視 | 99.9%（30 日） |
| ブートストラップの可用性（NFR-006） | ブートストラップの要求のうち、完了したものの割合（`429` は再試行で完了すれば成功） | Sync API、RUM | 99.9%（30 日） |
| 公開 API（NFR-006・009） | 5xx・時間切れでない割合、1 件の読み出しの p99 | エッジ、`public-api` | 99.9%、p99 500ms |
| Webhook（NFR-009） | 確定から最初の送信の p95 | `webhook-send` | 30 秒 |
| 検索（NFR-010） | 変更から検索に出るまで、`/search` の p99 | `search-indexer`、`sync-api` | p95 10 秒、p99 500ms |
| テナントの分離（NFR-008） | 4.4 節の不一致 | 配信の監査 | 0 |

- 可用性の SLI は、社内の監視用のワークスペースを除いた本番のワークスペースで数える。社内の分は別にも見る。
- 検証の拒否（`forbidden`・`invalid` など）は可用性を消費しない。ただし、拒否の率の急な上がり（5.3 節）は、版のずれや規則の誤りの兆候なので見る。

### 5.2 バーンレート

他の題材と同じマルチウィンドウのバーンレート（1 時間・5 分で 14.4、6 時間・30 分で 6 を呼び出し、3 日・6 時間で 1 をチケット）を、可用性の SLI に使う。すべてのアラートは、対応する runbook の URL を注釈に持つ（CI で検査する。他の題材と同じ）。

### 5.3 平常との差で見る指標

- 拒否の率（コードごと）：過去 4 週の同じ曜日・時間と比べ、`invalid`・`forbidden`・`invalid_reference` が 3 倍を 30 分続けたらチケット、10 倍で呼び出し。直前のリリースを疑う。
- やり直しの回数（理由ごと）：`corrupt` の増加は保存の消去、`migration` の増加はクライアントの移行の誤り、`too_far` の増加はインポートかログの異常。
- `lost_local`（ブラウザに消された未送信）：ブラウザの版ごとに、平常の 3 倍でチケット。
- 上書きの記録の件数：平常の 5 倍でチケット（長いオフラインの一斉の送信か、クライアントの誤り）。

### 5.4 アラートの一覧と runbook

手順の列は、この工程で作る 3 つの runbook と、各領域の文書が提案した runbook を指す。提案の runbook ができるまでは [incident-response.md](../runbooks/incident-response.md) の該当の節で対応する。

| アラート | 条件 | 重さ | 手順 |
| --- | --- | --- | --- |
| 書き込みの経路の SLO の速いバーンレート | 5.2 節 | 呼び出し | [incident-response.md](../runbooks/incident-response.md) |
| 送信から ack の遅れ | p99 が 1 秒を 10 分超える | 呼び出し | [incident-response.md](../runbooks/incident-response.md)、`writer-lock-contention.md` |
| **伝播の遅れ** | 合成監視の伝播 p99 が 3 秒を 10 分超える、または RUM の確定から適用の p99 が 2 秒を 30 分超える | 呼び出し | [incident-response.md](../runbooks/incident-response.md) の「伝播の遅れ」、`sync-propagation-lag.md` |
| 差分の配信の停止 | 合成監視の伝播の確かめが 3 回続けて 10 秒を超える | 呼び出し（SEV1 の候補） | [incident-response.md](../runbooks/incident-response.md) の「伝播の遅れ」 |
| **収束の不一致** | `unexplained` が 1 件 | 呼び出し（SEV2 から） | [incident-response.md](../runbooks/incident-response.md) の「収束の不一致」、`convergence-mismatch.md` |
| **非公開のチームの漏えいの疑い** | 4.4 節の配信の監査の不一致、`orphan_rows`、`subscription_drift` の見てよくない方向のずれ | 呼び出し（SEV1 の候補） | [incident-response.md](../runbooks/incident-response.md) の「非公開のチームの漏えいの疑い」、`private-team-leak-response.md` |
| **端末の保存の消去の増加** | `lost_local`・`corrupt` のやり直しが平常の 3 倍を 1 時間 | チケット（10 倍で呼び出し） | [incident-response.md](../runbooks/incident-response.md) の「端末の保存の消去」、`client-storage-eviction.md` |
| 操作の遅延の後退 | 主要な Action の RUM の p99 が 50ms を 2 日続けて超える | チケット | `latency-regression.md` |
| outbox の滞留 | 最古の未送信が 24 時間を超える端末が、平常の 3 倍 | チケット | `outbox-backlog.md` |
| Relay の遅れ | `sync_outbox` の最古の行が 5 秒を超える | 呼び出し | [incident-response.md](../runbooks/incident-response.md) の「伝播の遅れ」 |
| Gateway の欠けの埋めの急増 | 1 分に平常の 10 倍 | チケット | `sync-propagation-lag.md` |
| 再接続の殺到 | 1 分の新しい接続が 1 万を超える | チケット（Gateway の `overloaded` が 5 分続けば呼び出し） | `reconnect-storm.md` |
| ブートストラップの過負荷 | Sync API の `429` が 1 分に 1,000 を超える | 呼び出し | `bootstrap-overload.md` |
| ロックの待ち | 上位のワークスペースのロックの待ちの p99 が 200ms を 10 分 | チケット | `writer-lock-contention.md` |
| 拒否の率の急な上がり | 5.3 節 | チケット・呼び出し | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)（直前のリリース） |
| デプロイ中の自動ロールバック、フラグのガード | [delivery.md](delivery.md) の 5・7 節 | 呼び出し | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |
| クライアントの版の後の移行の失敗 | `migration` のやり直しが新しい版で 1% を超える | 呼び出し | [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、`client-migration-failure.md` |
| DR の複製の遅延 | `AuroraGlobalDBRPOLag` が 10 秒を 5 分超える | 呼び出し | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 狭める操作の記録の遅れ | `narrowing_outbox` の送り残しの最古が 5 秒を超える、または `narrowing_journal` の `ReplicationLatency` が 10 秒を 5 分超える（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)） | 呼び出し | [disaster-recovery.md](../runbooks/disaster-recovery.md) の C |
| 大阪の待機の構成の異常 | 大阪の合成監視の失敗、スナップショットの年齢 | チケット（30 分で呼び出し） | [disaster-recovery.md](../runbooks/disaster-recovery.md) |
| 検索の遅れ | `search_index_lag_seconds` の p95 が 30 秒を 15 分 | チケット（5 分を超えたら呼び出し） | `search-index-lag.md` |
| Webhook の送りの遅れ | 最初の送信の p95 が 5 分を超える | チケット | `webhook-backlog.md` |
| 連携の受け口の失敗 | 署名の失敗の急増、`integration_events` の最古の未処理が 10 分 | チケット | `integration-ingress-outage.md` |
| 通知の遅れ | 確定から通知の行の p95 が 60 秒 | チケット | `notifier-lag.md` |
| 秘密の出力の検出 | 2.1 節の走査で 1 件以上 | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) |
| シークレットスキャンの通知 | 本システムの接頭辞のトークンの公開の検知 | 呼び出し | `leaked-token-response.md` |
| 監査ログのハッシュの連鎖の検証の失敗 | 日次のジョブ | 呼び出し（SEV2） | [incident-response.md](../runbooks/incident-response.md) |

呼び出しのアラートは、SLO か、分離・収束・秘密の症状に限る。原因の側の指標（CPU など）はチケットとダッシュボードにとどめる。

## 6. 合成監視

| 監視 | 内容 | 頻度 | 置き場所 |
| --- | --- | --- | --- |
| 伝播 | ヘッドレスの同期のクライアント A・B（`packages/sync-client`、IndexedDB はメモリー）を同じプロセスで、監視用のワークスペースにつなぐ。A が 10 秒ごとに監視用のイシューのフィールドを変え、A の送信から ack と、A の送信から B の適用を、同じ時計で測る | 常時 | 東京の 2 AZ（synthetics のアカウント、prod の VPC の外から CloudFront 経由） |
| 起動 | 監視用のワークスペース（モデル 5 万件）の全体のブートストラップ | 5 分 | 同上 |
| 非公開への切り替え | 監視用のチームを非公開にし、メンバーでない監視の利用者の手元から行が消え、検索に出ないことを確かめ、公開に戻す | 1 時間 | 同上 |
| 公開 API | 監視用の API キーで `issues` を読み、`issueUpdate` を書く | 1 分 | 同上 |
| Webhook | 監視用の Webhook の受け手（synthetics のアカウント）に届くまで | 5 分 | 同上 |
| 大阪 | 大阪の ALB へ直接、読み取りの専用の握手とブートストラップ | 1 分 | 大阪 |

- 監視用のワークスペースは本番の基盤の上に置き、SLI では除いて別に見る。
- 伝播の監視は、NFR-002 の p99 の SLI の正本の 1 つにする（RUM は利用者の回線を含むので、両方を見る）。

## 7. ダッシュボード

| ダッシュボード | 中身 |
| --- | --- |
| 同期の全体 | 書き込み/秒、送信から ack、伝播の区間ごと、拒否のコード、`retry`、Gateway の接続と送信、Relay の遅れ、やり直しの理由 |
| ワークスペースの上位 | 書き込み、ロックの待ち、枠での `retry`、接続の数（上位 50） |
| クライアント | Action ごとの遅延、起動、ヒープ、outbox、保存、`persist()`、ブラウザと版の別 |
| 収束と分離 | 監査の件数と分類、配信の監査、`orphan_rows`、`subscription_drift` |
| 外への配信 | 通知、メール、Webhook、連携、検索の遅れ |
| DR | 複製の遅延、大阪の合成監視、スナップショット |

## 8. ログの保持とアクセス

- アプリのログ：CloudWatch Logs 30 日、log-archive 13 か月（[security.md](security.md) の 9 節）。中身を含めない。
- RUM：AMP の保持（既定）、S3 の Parquet 13 か月。
- 配信の監査の抜き取り：S3 に 90 日。
- 運用者のログの閲覧は常設の権限（中身を含まないため）。

## 9. テスト

- 計装の例示テスト：ログ・スパン・メトリクスの出力に、テストのデータの中身（タイトルの目印の文字）が現れない（CI で出力を走査する）。
- 正準形のハッシュ：クライアントとサーバーで同じ `packages/model` の関数を使い、任意の行で同じハッシュになることを性質ベーステストで確かめる（PROP-OBS-001）。
- 監査の作り直し：シミュレーター（[ADR-0010](../decisions/0010-deterministic-sync-simulator.md)）の任意の出来事の列の後、任意の `L` について、4.2 節の作り直しがその時点のサーバーの状態と一致する（PROP-OBS-002）。
- 不一致の検出：シミュレーターでわざと 1 行を壊したクライアントの報告から、監査が `unexplained` とその行の ID を出す（PROP-OBS-003）。
- 伝播の計測：仮想の時計で時計の差と揺らぎを与え、見積もりの誤差が RTT/2 以内（例示テスト）。

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `otel-baseline` | ADOT、AMP、X-Ray、ログの形、中身を出さない規則と走査 |
| E1 | `rum-latency-marks` | 3 節の RUM の口と端末の集め方（client-app と共同） |
| E2 | `propagation-timestamps` | 3.3 節の `committed_at`、`c` の運び、`pong` の時刻、区間のヒストグラム |
| E2 | `synthetic-sync-clients` | 6 節の伝播の合成監視 |
| E3 | `client-storage-telemetry` | outbox・保存・やり直しの RUM |
| E12 | `convergence-audit` | 4.1〜4.3 節 |
| E12 | `delivery-audit` | 4.4 節（sync-engine の Story と同じ） |
| E12 | `slo-dashboards-alerts` | 5〜7 節、runbook の URL の検査 |

## 11. 未解決の問い

### 決定

2026-09-28 の既定案。

- **RUM の送り先**：自前の口と AMP・S3（ADR-0052）。
- **伝播の計測**：コミットの直前の時刻を運び、時計の差を ping で見積もる（ADR-0052）。
- **収束の監査**：`L` の時点の作り直しと桶のハッシュ、2 段目の特定（ADR-0053）。
- **監査の範囲**：`instant` と手元のイシュー。遅延のモデルと本文は持ち越し（ADR-0053）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 遅延のモデル（コメント）と本文（CRDT の状態）を監査に入れるか | E12。本文は `doc_states` のまとめの版と比べる方法が要る |
| 部分のブートストラップの端末の完全さ（被覆の鍵の中の行がそろっているか）の監査 | E12。条件の時刻の扱い（`issue_active_30d`）を決める |
| RUM の公表の文面 | 法務の L2 |
| Chrome のタイマーの間引き | 隠れて 5 分を過ぎたタブは、タイマーが 1 分に 1 回まで間引かれる（[sync-engine.md](sync-engine.md) の 9.6 節）。背景のタブの伝播は数えない |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- 収束の監査の `unexplained` 0 件を K5 の判定にする（E12 の GA の判定の基準）。
- 配信の監査の不一致 0 件を K7 の判定にする。
- PROP-OBS-001〜003 を E12 のリリースの基準にする。

### runbooks

- `runbooks/README.md` への依頼（反映済み）：5.1 節の SLI の目標値と、5.4 節のアラートと手順の表（[runbooks/README.md](../runbooks/README.md) の 1・4 節）。
- `incident-response.md`（本工程で作る）に、伝播の遅れ・収束の不一致・非公開のチームの漏えい・端末の保存の消去の場面を入れた。

### data-model（索引への追加の提案）

| 表・置き場所 | 中身 | 節 |
| --- | --- | --- |
| `sync_outbox.committed_at` | コミットの直前の時刻（伝播の計測） | 3.3 |
| `convergence_audits`（サーバーだけ、日ごとのパーティション、90 日） | 監査の報告と結果の分類 | 4.2 |
| `convergence_mismatches`（サーバーだけ、1 年） | 不一致の行の ID と分類 | 4.3 |
| `sync_actions` の索引 `(workspace_id, model, model_id, sync_id)` | `L` の時点の作り直し（api-and-webhooks と共有） | 4.2 |
| S3 の RUM の Parquet、配信の監査の抜き取り | 13 か月、90 日 | 3.2、4.4 |
| sync-engine への依頼（反映済み。[data-model.md](data-model.md) の 9 節） | `deltas` に `c`、`pong` に Gateway の時刻、`welcome` に `audit_followup` | 3.3、4.3 |

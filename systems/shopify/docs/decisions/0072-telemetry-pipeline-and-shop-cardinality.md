---
status: accepted
date: 2026-10-10
---

# ADR-0072: 計測は ADOT から、メトリクスは observability のアカウントの AMP、ログは CloudWatch Logs（observability のアカウントへ集約）、トレースは X-Ray へ送る。`shop_id` のラベルは、直近 5 分に要求のあったショップのチェックアウトと元のストアフロントの粗い分布の 2 つの指標と、見張りの一覧のショップの全指標にだけ付ける。トレースは尾での抜き取り（1%、エラーと遅いものと見張りの一覧は全部）

## Context

- runbooks の SLI の「隣人の影響」は、同じポッドのショップごとのチェックアウトの p99 を要る（[runbooks/](../runbooks/README.md) の 1 節）。フラッシュセールの間は、そのショップの全部の指標を細かく見たい。
- S1 のポッドには 1.25 万のショップがある。全指標にショップのラベルを付けると、系列の数が指標 × ショップ × バケット × ポッドで増え、時系列の DB の上限と費用に当たる。
- 個人のデータをログに出さない（[AGENTS.md](../../AGENTS.md)）。
- 共通の基盤は OpenTelemetry（ADOT）→ CloudWatch・AMP・Managed Grafana（[ADR-0001](0001-platform-and-stack.md)）。

## Options

1. **ショップのラベルを 2 つの粗い指標と見張りの一覧に絞る**
2. 全指標にショップのラベル
3. ショップごとの値はログからだけ（Logs Insights で集計）

## Decision

1 を採用する。詳細は [observability.md](../architecture/observability.md) の 1・2・3 節。

- 経路：タスクの ADOT のサイドカー → AMP（observability のアカウント）、CloudWatch Logs（各アカウント 30 日、集約と S3 の写し 90 日）、X-Ray。ダッシュボードは Managed Grafana。
- ラベル：`pod`・`service`・`az`・`version`・`route`・`plan` は全部。`shop` は `checkout_request_seconds`（バケット 6）と `storefront_origin_seconds`（バケット 5）だけで、直近 5 分に要求のあったショップだけ出す。見張りの一覧（セール・隔離のポッド・GMV の上位 500）のショップは全指標に `shop` を付ける。`app` は上位 200、他は `other`。
- トレース：尾での抜き取り 1%、エラー・経路ごとの p99 を超えるもの・見張りの一覧のショップは全部。
- ログ：`packages/obs` の型で許した欄だけ。理由のコードは決めた一覧から。IP は日ごとの鍵の HMAC の先頭 8 バイトだけ。

### 他の案を選ばなかった理由

- **2（全部）**：S1 で系列が数千万になり、AMP の上限と費用を超える見込み（上限の値は**未検証**）。ほとんどの系列は値がない。
- **3（ログだけ）**：SLI のバーンレートを分の単位で計算するには、ログの問いの遅さと費用が合わない。

## Consequences

- 良くなること：
  - 隣人の影響の SLI と、フラッシュセールのショップの細かい観察が、系列の数を抑えたまま取れる。
- 引き受けるコスト：
  - 見張りの一覧の外のショップの細かい調査は、トレースの抜き取りとログに頼る。
  - 見張りの一覧の配り（AppConfig）と、出す系列の切り替えを持つ。

## Confirmation

- 性質ベーステスト：PROP-OBS-001（個人のデータなし）、PROP-OBS-002（系列の上限）。
- lint：ログの関数の外での `console.log` と、任意の文字列の欄を禁止する。
- 本番：AMP の活動中の系列の数を日次で見る。S1 で 300 万を超えたら見直す。

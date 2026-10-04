---
status: accepted
date: 2026-09-27
---

# ADR-0043: S1 のログはログの専用の Aurora のクラスタに置き、本家の検索の部分集合を索引で返し、保持はテナントの属性で切る

詳細は [logs-and-streams.md](../architecture/logs-and-streams.md) の 4・5 節。

## Context

認証のイベントは、S1 のピークで 1 秒約 4,000 件、1 日約 1 億件、約 50 GB、30 日で約 1.5 TB になる（[capacity.md](../architecture/capacity.md)）。テナントは Management API とダッシュボードで検索し、NFR-010 はイベントから検索に出るまで p95 30 秒を求める。

本家の保持はプランで 1〜30 日（[Log Data Retention](https://auth0.com/docs/deploy-monitor/logs/log-data-retention)、2026-09-27 に確認）。検索は Lucene の部分集合で、検索では 1,000 件まで（[Log Search Query Syntax](https://auth0.com/docs/deploy-monitor/logs/log-search-query-syntax)、同日に確認）。architecture README の 2 節は、S2 でログの保存と検索を専用の基盤へ移すとしている。保持の期間は、法務の確認待ち（intent の L5）である。

## Options

1. **ログの専用の Aurora PostgreSQL のクラスタ。取り込みの日ごとのパーティション、`tenant_id` を先頭にした索引。全文の検索は持たない。S2 で専用の基盤へ移す**
2. 主の Aurora のクラスタの中の表
3. OpenSearch（S1 から）
4. S3（Parquet）と Athena だけ

## Decision

1 を採用する。

- 索引は `(tenant_id, log_id)` と、`user_id`・`user_name`・`type`・`client_id`・`ip`・`connection_id`・`organization_id` のそれぞれに `log_id` を続けたもの。RLS をかける。
- 検索は本家の部分集合。フィールドのない語は `log_id`・`ip`・`client_name`・`connection`・`type`・`user_name` の完全一致だけ（本家は `description` も探す。[Log Search Query Syntax](https://auth0.com/docs/deploy-monitor/logs/log-search-query-syntax)、2026-09-27 に確認）。`description`・`user_agent` は句の完全一致と前方一致だけ。1 回 5 秒の時限。
- チェックポイントは `q` と組み合わせられる（本家は他の引数を無視する）。索引が揃っているので安く返せる。
- 保持はテナントの属性 `log_retention_days`（1・5・10・30、既定案）で、問い合わせの条件で切る。クラスタは 31 日でパーティションを `DROP` する。本システムの調査用に、S3 の Parquet に 90 日持つ（テナントには見せない）。
- 期間は既定案で、法務の L5 で確定する。
- 2 は、1 日 1 億件の書き込みと検索が、ログインの DB の writer と reader を圧迫する（ADR-0005 の経路の分離に反する）。
- 3 は、S1 の規模で運用（クラスタ、シャード、バージョンの更新、RLS に相当する分離）が重い。全文の検索の利点は、本家の検索の主な使い方（`user_id`、`type`、`ip` での絞り込み）では小さい。S2 の候補に残す。
- 4 は、NFR-010（30 秒で検索に出る）と、Management API の応答の速さを満たしにくい。

## Consequences

- 良くなること：
  - 他の題材と同じ道具（Aurora、RLS、パーティション）で作れる。
  - ログの負荷が認証の経路の DB に及ばない。
- 引き受けるコスト：
  - `description` の自由な語の検索ができない（本家との差）。文書に書く。
  - Aurora のクラスタが 1 つ増える。S2 で移すときに、Management API の形を保ったまま裏の基盤を替える作業が要る。
  - 1.5 TB の Aurora のストレージの費用（東京の Aurora PostgreSQL の標準の構成で 1 GB 月 0.12 USD、約 180 USD／月。I/O は別に 100 万回 0.24 USD。[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/ap-northeast-1/index.csv)、2026-09-27 に確認）。

## Confirmation

- 負荷試験（E12）：1 秒 4,000 件の取り込みで、検索に出るまで p95 30 秒。主な検索（`user_id`、`type`、`ip`、日付の範囲）が p99 1 秒以内。
- 結合テスト：`log_retention_days` を過ぎたログが、検索・チェックポイント・ストリームの開始の位置に出ない。
- 結合テスト：ユーザーの削除で、そのユーザーのログのメールと名前が仮名になる。
- CI：ログのクラスタの新しい表に `tenant_id` と RLS がある（ADR-0002 の検査を共有）。

---
status: proposed
date: 2026-09-26
---

# ADR-0030: S2 で、変更データの取り込み（CDC）によるデータレイクを S3 に作る

S2 に向けた計画。S1 の運用で得た数字で見直し、S2 への移行を始めるときに accepted にする。

## Context

分析（利用の集計、容量の予測、課金の検証）と、将来の AI の機能（MVP の外。[intent.md](../intent.md)）には、全シャードのデータを横断して読む仕組みが要る。本番の Aurora に分析の問い合わせを直接投げると、編集の遅延（NFR-001）を悪化させる。

本家は、Postgres の変更を Debezium の CDC で Kafka に送り、Apache Hudi で S3 に書き、Spark で処理するデータレイクを自前で作った。要点は次のとおり（[Building and scaling Notion's data lake](https://www.notion.com/blog/building-and-scaling-notions-data-lake)）。

- 更新が多い：upsert の 90% が更新である。挿入が多い前提のデータウェアハウスには合わなかった。
- Postgres のホストごとに 1 つの Debezium のコネクター。Kafka のトピックは、480 シャードぶんではなく、テーブルごとに 1 つ。
- 新しいテーブルは、RDS の S3 へのエクスポートで初期の状態を作り、その間の変更を Kafka から追う。通常 24 時間以内に終わる。
- 取り込みの遅延は、多くのテーブルで数分、最大のブロックのテーブルで最大 2 時間。

## Options

1. **Debezium（Kafka Connect）→ Amazon MSK → Spark で Hudi（か Iceberg）の表を S3 に書く**
2. Aurora の S3 へのエクスポート（Parquet）を毎日行い、Athena で読む
3. Aurora の zero-ETL 統合で Amazon Redshift に送る
4. reader に分析の問い合わせを投げる

## Decision

段階で分ける。

- **S1：2 を使う。** 1 日 1 回、Aurora のクラスタのデータを S3 にエクスポートする。エクスポートは、クラスタのクローンから Parquet で書き出すので、稼働中のクラスタの性能に影響しない（[AWS のドキュメント](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/export-cluster-data.html)）。鮮度は 1 日で足りる。
- **S2：1 を採用する（提案）。** 物理クラスタが増え、ブロックが 1,000 億になると、毎日の全体のエクスポートは費用と時間で合わなくなる見込みである。
  - 物理クラスタごとに 1 つのコネクター。スキーマ `shard000`〜`shard479` の同じテーブルを、1 つのトピックにまとめる（本家と同じ）。
  - 初期の状態は、2 のエクスポートで作る。
  - 表の形式は Hudi か Iceberg。S2 の前に、更新の多いブロックの表で両方を比べて決める（未決定）。
  - 鮮度の目標は、ブロックの表で 2 時間以内、その他で 15 分以内。
- 3 は、運用が最も少ない。ただし 480 のスキーマと更新の多い表を、目標の費用で扱えるかは **未検証**。S2 の前の比較に含める。
- 4 は、S1 の小さな調べものにだけ使い、定常の分析には使わない。

### 守ること

- **データレイクは本番のアカウントの中に置く。** 本番のデータを本番のアカウントの外に出さない（Slack の [infrastructure.md](../../../slack/docs/architecture/infrastructure.md) の 7 節と同じ）。
- **データレイクは、権限の判定（[ADR-0004](0004-inherited-page-permissions.md)）を通らない。** 利用者に中身を返す機能（検索、AI の機能を含む）の元にしてはならない。そうした用途に使うときは、別の ADR で権限の扱いを決める。
- 読める人を Ops と、許可したデータ分析の担当に限る。ブロックの本文を含む表と、ID と集計の値だけの表を分け、後者を既定にする。
- 削除（ゴミ箱の期限切れ、ワークスペースの削除）を、データレイクにも反映する。反映の期限は [security.md](../architecture/security.md) のデータのライフサイクルに従う。
- S3 で複数のリージョンに広げるときは、データレイクもリージョンごとに持ち、本文を除いた集計だけを中央に集める（本家の方式。[Enabling multi-region data systems at Notion](https://www.notion.com/blog/enabling-multi-region-data-systems-at-notion)）。

## Consequences

- 良くなること：
  - 分析の負荷を本番の DB から外せる。
  - 論理レプリケーションのスロットを、再シャーディング（[ADR-0028](0028-zero-downtime-resharding.md)）と同じ仕組みで運用できる。
- 引き受けるコスト：
  - MSK、Kafka Connect、Spark の運用が加わる。小さなチームには重い。3 で足りるなら、3 を選び直す。
  - CDC のスロットが止まると、WAL がたまり、本番の DB に影響する。スロットの遅延を監視し、閾値を超えたらスロットを捨てて、エクスポートからやり直す。
  - 再シャーディングとリージョンの切り替えのたびに、コネクターとスロットを作り直す。

## Confirmation

- S2 の前に、staging でブロックの表を対象に、1 と 3 の費用・鮮度・運用の手間を比べ、この ADR を更新する。
- CDC のスロットの遅延（保持している WAL の量）のアラームがあることを確かめる（[observability.md](../architecture/observability.md)）。
- データレイクの表に、権限の判定が要る用途からの参照がないことを、レビューで確かめる。

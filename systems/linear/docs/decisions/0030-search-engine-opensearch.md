---
status: accepted
date: 2026-09-28
---

# ADR-0030: 検索は S1 から Amazon OpenSearch Service で、行ごとの文書にする。一致は 1〜2 文字の N-gram、関連度は同梱の kuromoji、正規化はアプリの共有の関数。版は行の `sync_id` で外部の版にする。Aurora の `pg_bigm` は使えることを確かめたうえで代案とする

## Context

イシュー・コメント・プロジェクトの全文検索が要る（[intent.md](../intent.md)）。日本語の部分一致で取りこぼさず、変更から検索に出るまで p95 10 秒、サーバーの検索の p99 500ms（NFR-010）。

[architecture/README.md](../architecture/README.md) の 4 節は、S1 を PostgreSQL の全文検索（日本語は bigram。`pg_bigm` の可否は確かめていなかった）、S2 で専用の基盤と計画していた。確かめたことは次のとおり（いずれも 2026-09-28）。

- Aurora PostgreSQL 18（18.3・18.4）で `pg_bigm` の版 `1.2_20250903` が使える。`pgroonga` は使えない（[Extension versions for Aurora PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraPostgreSQLReleaseNotes/AuroraPostgreSQL.Extensions.html)）。
- RLS の方針の条件は、LEAKPROOF でない利用者の条件より先に評価される（[CREATE POLICY](https://www.postgresql.org/docs/18/sql-createpolicy.html)）。`LIKE` は LEAKPROOF でないので、RLS のある表では `pg_bigm` の GIN の索引が効かない。Slack の題材は、検索の表だけ RLS を外し、関数を通してだけ読む例外を置いた（Slack の ADR-0027）。
- Amazon OpenSearch Service は kuromoji を全ドメインに同梱し、Sudachi を任意のプラグインとして持つ（[Plugins by engine version](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html)）。
- OpenSearch の `version_type=external` は、指定の版が大きいときだけ書く（[Index document](https://docs.opensearch.org/latest/api-reference/document-apis/index-document/)）。

この題材の Aurora の writer は、ワークスペースの `sync_id` を振るロックで書き込みを直列にする（ADR-0002、ADR-0006）。そのクラスタに大きな GIN の索引の更新を足すと、書き込みの上限を下げる。

## Options

1. **S1 から OpenSearch（N-gram で一致、kuromoji で関連度）**
2. S1 は `pg_bigm`（RLS の外の専用の表と関数）、S2 で OpenSearch
3. S1 から OpenSearch で、Sudachi を関連度に使う

## Decision

1 を採用する。詳細は [search.md](../architecture/search.md) の 3〜5・9 節。

- 1 つの索引（別名 `docs`）に、イシュー・コメント・プロジェクトを行ごとの文書で入れる。ルーティングは `workspace_id`。
- `title`・`body` は、`.gram`（1〜2 文字の N-gram。句の一致で判定）と、kuromoji（関連度）の多重のフィールド。
- 正規化は共有の `normalizeForSearch`（NFKC、小文字、カタカナをひらがなへ）を索引とクエリの両方にかける。手元の照合（コマンドメニュー、ビュー）と同じ関数。
- 索引の Worker は差分の中身を使わず、行を Aurora の reader から読み直して文書を作る。版は読んだ行の `updated_sync_id` の最大で、`version_type=external` で書く。削除は墓標の文書にし、1 日後に消す。
- `pg_bigm` は代案とする。E8 の PoC で OpenSearch の費用が S1 に見合わないと分かれば、別の Aurora のクラスタに Slack の ADR-0027 の形で置く ADR を書く。
- 2 を採らない理由：S2 で基盤の移行（二重の書き込み、流し込み）を必ず行うことになる。関連度の並べ替え（本家の並び）が弱い。RLS の例外が要る。同じクラスタに置けば Writer の資源を使う。
- 3 を採らない理由：Sudachi は版ごとのパッケージの結び付けと辞書の運用が要る。S1 は同梱の kuromoji で始め、関連度の不満が出たら索引の作り直しで替える。

## Consequences

- 良くなること：
  - 検索の書き込みが Aurora の writer の資源を使わない。
  - S1 から関連度・状態の重みで並べられ、S2 への基盤の移行がない。
  - 手元とサーバーで同じ正規化になり、同じ語が同じものに当たる。
- 引き受けるコスト：
  - S1 から OpenSearch のドメインを運用する（費用、版の更新、スナップショット）。
  - テナントの分離を、DB の RLS ではなく、検索の関数（`buildSearchRequest`）と読み直しで守る（ADR-0031）。
  - [architecture/README.md](../architecture/README.md) の 4 節の計画と違う。README の更新が要る。
  - 1 文字の N-gram で索引が大きくなる（量は未検証。E8 の前の `search-poc` で測る）。

## Confirmation

- E8 の PoC：合成のデータ（イシュー 5,000 万、コメント 2 億）で、索引の大きさ、`/search` の p99 500ms、遅れの p95 10 秒、月の費用を測る。
- 性質ベーステスト：PROP-SEARCH-003（索引の収束）、PROP-SEARCH-004（正規化の一致）。
- 日本語の例示テストの集まりを、アナライザーと正規化の変更の PR の必須にする。

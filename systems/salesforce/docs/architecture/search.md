# Search: Salesforce

全文検索（組織の全体の検索、オブジェクトの中の検索、参照の項目の候補の検索）、日本語の解析、索引の遅れと作り直し、名前での代わりの検索、検索の結果の権限の絞り込みの設計。土台は [ADR-0001](../decisions/0001-platform-and-stack.md)（OpenSearch は全文検索の索引にだけ使う写しで、作り直せる）、[ADR-0004](../decisions/0004-record-access-model.md)（検索も同じ判定を通る）、[ADR-0010](../decisions/0010-record-tables-partitioning-and-pivots.md)（名前のピボットと文字列の正規化）。この文書で決めたことは、次の 2 つの ADR にある。

- 索引は OpenSearch の共有の索引（16 個）に組織の ID で振り分けて置き、全ての検索に組織の条件を必ず付ける。日本語は kuromoji の形態素と CJK の 2-gram の 2 つの部分の項目で持ち、NFKC・小文字・ひらがなとカタカナの統一をかける。索引は outbox から非同期に作り、`row_version` を外部の版にして古い書き込みで戻らないようにする。参照の項目の候補と OpenSearch の障害の時は、名前のピボットの前方一致で代わりに引く（[ADR-0031](../decisions/0031-search-index-and-japanese-analysis.md)）。
- OpenSearch の結果は候補とだけ扱う。オブジェクトの権限と FLS は検索の前に条件として絞り、レコードの共有は、候補の ID をデータ層の問い合わせで絞り直してから返す（後の確かめ）。後の確かめは参照の評価器と同じ意味の判定で、本番の標本の照合の対象にする。索引に共有の情報を写さない。件数の合計を返さない。見えない一致の数が応答の時間に出ないよう、1 ページごとに固定の候補の束を取り、束の全てを確かめ、下限の時間まで待って返す（[ADR-0032](../decisions/0032-search-permission-post-filter.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。本家の検索の言語（SOSL）との互換は持たない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 組織の全体の検索（画面の上の検索の箱）、オブジェクトの中の検索、参照の項目の候補 | リストビューと問い合わせの条件の「含む」（[query-language-and-api.md](query-language-and-api.md)、trigram のピボット） |
| 検索の API（`/api/v1/search`） | 重複の照合（[sales-objects.md](sales-objects.md) の 6 節。照合の鍵で行い、検索の索引を使わない） |
| 索引の形、日本語の解析、索引の遅れ、作り直し、整合の検査 | 共有の判定の本体（[sharing-and-record-access.md](sharing-and-record-access.md)） |
| 名前での代わりの検索 | ファイルの本文の検索、ナレッジの記事（MVP の後） |
| 検索の結果の権限の絞り込み、FLS、組織の分離 | 検索のログの分析（observability の領域） |

## 2. 本家の仕組み（確かめたこと）

主な出典は [SOQL and SOSL Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_soql_sosl.pdf)（Winter '27 版、以下「SOSL」）。

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 索引 | 全文検索は、別の検索の基盤で非同期に索引を作る | [Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html) |
| 検索の流れ | 検索の基盤は、まず最大 2,000 件の一致を探す。1 つのオブジェクトなら 250 件（`WHERE`・`ORDER BY` を付けると 2,000 件）、複数なら「2,000 ÷ オブジェクトの数」と 250 の小さい方をオブジェクトごとに返す。「すべてのデータの参照」を持つ人は全てを見る。他の人には利用者の権限の絞りをかけ、見られるものだけを見せる。この段の上限で、一致したレコードが結果から落ちることがある | SOSL の「SOSL Limits on Search Results」 |
| 結果の揺れ | 結果の集合と順は、検索する人で変わり、索引への追加・削除で 1 日の中でも変わる | 同上 |
| 検索の語 | 語、`"..."` の句、ワイルドカード、`AND`・`OR`・`AND NOT`。検索の語が 10,000 文字を超えると結果なし、4,000 文字を超えると論理の演算子を外して `OR` にする | SOSL、[Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)（以下「Limits」） |
| 日本語 | 空白で区切らない東アジアの言語は、形態素で区切る。「東京都」は「東京」「都」に分かれ、「京都」の検索に当たらない | SOSL の「FIND {SearchQuery}」 |
| 検索の範囲 | `IN NAME FIELDS`（名前の項目）、`IN ALL FIELDS` など。システムのモードの Apex は `IN ALL FIELDS` の照合で FLS を無視する。利用者のモード（`WITH USER_MODE`）では FLS とオブジェクトの権限を守る | SOSL の「FIND Clauses in Apex」「WITH」 |
| 結果の上限 | 合計 2,000（API の版 28.0 以降） | Limits |
| 索引の遅れの目安 | 公開の資料に数値がない | — |

本家の「見つけた 2,000 件を後で権限で絞る」形は、見る人の見られるレコードが少ない組織で、見られる一致が結果から落ちる。本システムは、同じ「後の確かめ」を採りつつ、候補を多め（1 ページ 3,000 件の固定の束）に取って落ちを減らす（6 節）。

## 3. 検索の種類と API

| 種類 | 画面 | 経路 |
| --- | --- | --- |
| 組織の全体の検索 | 上の検索の箱。オブジェクトごとに上位を並べる | OpenSearch → 後の確かめ |
| オブジェクトの中の検索 | リストビューの上の検索、関連の検索 | OpenSearch → 後の確かめ（オブジェクトを 1 つに絞る） |
| 参照の項目の候補（タイプアヘッド） | 参照の項目の入力 | 名前のピボットの前方一致を先に、足りなければ OpenSearch（4.4 節） |

```
POST /api/v1/search
{
  "q": "例示 商事",
  "in": "all_fields" | "name_fields",
  "objects": [
    { "object": "account", "where": "billing_prefecture = '東京都'", "fields": ["name", "phone"], "limit": 20 },
    { "object": "contact", "fields": ["name", "email"] }
  ],
  "limit": 50
}
→ 200
{
  "results": [
    { "object": "account", "records": [ { "id": "...", "fields": { "name": "...", "phone": "..." },
                                          "highlights": { "name": "<em>例示</em>商事" } } ],
      "more_may_exist": false }
  ],
  "as_of": "2026-09-28T01:02:03Z",
  "degraded": false
}
```

- `q` は語と `"..."` の句、`OR`、`-`（除く）、末尾の `*`（前方一致）だけにする。本家の SOSL の構文（`FIND {...} RETURNING`）は受け付けない（ADR-0001）。
- `where` は問い合わせの言語（ADR-0018）の条件で、後の確かめの問い合わせにそのまま足す（索引に写さない項目でも絞れる）。
- 返す項目の値は、**索引からではなく、後の確かめで DB から読んだ値**にする（6.3 節）。
- 件数の合計は返さない。`more_may_exist` だけを返す（6.4 節）。
- 検索の API は API の割り当て（`alloc.api_requests`）に数える（[governor-limits.md](governor-limits.md) の 8.1 節）。

## 4. 索引（ADR-0031）

### 4.1 置き場所と振り分け

- Amazon OpenSearch Service の 1 つのドメイン（S1。東京の 3 AZ、専用のマスター 3、データのノード `r7g.2xlarge.search` × 6。台数は [capacity.md](capacity.md) の 7.1 節）。
- 索引は、組織ごとではなく**共有の索引を 16 個**（`rec-v{版}-{00..15}`）持ち、`shard_no`（[ADR-0010](../decisions/0010-record-tables-partitioning-and-pivots.md)）を 16 で割った余りで索引を決める。索引の中は `org_id` を routing にし、1 つの組織の文書は 1 つの OpenSearch のシャードに集まる。
- 組織ごとの索引にしないのは、S1 で 5,000、S3 で 50 万の組織を索引の数にすると、クラスタの状態（マッピングとシャード）が大きくなりすぎるため。
- 大口の組織（`shard_no` 240〜255）は、S2 以降に専用の索引へ分けられる。
- 索引の名前には版（`v{n}`）を付け、別名（alias）で指す。マッピングの変更は新しい版を作って作り直し、別名を切り替える（4.5 節）。

### 4.2 文書の形

```json
{
  "org_id": "0192...",
  "object_id": "0192...",
  "record_id": "0192...",
  "owner_id": "0192...",
  "row_version": 7,
  "metadata_version": 1043,
  "name": "株式会社例示商事",
  "name_kana": "レイジショウジ",
  "texts": [
    { "f": 12, "v": "東京都千代田区..." },
    { "f": 17, "v": "製造業の新規の案件" }
  ],
  "phones": ["0312345678"],
  "emails": ["taro@example.com"],
  "updated_at": "2026-09-28T01:02:03Z"
}
```

- 文書の ID は `{org_id}:{record_id}`。
- `texts` は nested 型にし、`f`（`field_no`）ごとに値を持つ。FLS で読めない項目で一致させないため（6.2 節）。
- `_source` には ID・`row_version`・`metadata_version` だけを残し、本文の値は索引の外（DB）から読む。索引が漏れた時の被害と、索引の大きさを抑える。
- `phones` は数字だけ（`+81` を `0` に）、`emails` は小文字にして、`keyword` で持つ（[sales-objects.md](sales-objects.md) の 6.2 節の正規化と同じ関数）。
- 索引に入れる項目：名前、`name_kana` 系、`searchable` の印のある項目（`text`・`text_area`・`email`・`phone`・`url`・`picklist` の表示の値・`autonumber`）。1 オブジェクト 20 項目まで。長いテキストは最初の 32KB。数式・積み上げ集計・数・日付は入れない（条件は `where` で絞る）。
- `md_fields` に `searchable`（真偽）を足す。標準オブジェクトは既定の組を種から入れる（取引先：名前、名前のカナ、電話、Web サイト、住所。取引先責任者・リード：名前、カナ、メール、電話、会社名。商談：名前）。

### 4.3 日本語の解析

| 部分の項目 | 解析 | 使い方 |
| --- | --- | --- |
| `name`・`texts.v`（主） | `icu_normalizer`（NFKC、小文字）→ `kuromoji_tokenizer`（search モード）→ `kuromoji_baseform`・`kuromoji_part_of_speech`（助詞・助動詞を落とす）→ ひらがなをカタカナに（`icu_transform`）→ 長音の統一 | 語の一致。点数の主 |
| `*.ngram` | `icu_normalizer` → `cjk_bigram`（CJK の 2 文字ずつ。英数字は語） | 辞書にない会社名・人名・造語の取りこぼしを拾う。点数は低め（重み 0.3） |
| `name.prefix` | `icu_normalizer` → `edge_ngram`（1〜20） | 名前の前方一致 |
| `name_kana` | カナの正規化（[sales-objects.md](sales-objects.md) の 6.2 節の段 1〜5、8） | 読みでの検索。ひらがなで打っても当たる |

- 形態素の解析だけでは、本家の例のとおり「京都」で「東京都」に当たらない一方、辞書にない語（例：新しい会社名）を細かく切りすぎて外す。2-gram を併せ、両方を `bool.should` で引き、形態素の一致を高く点数付けする。
- 法人格（「株式会社」「(株)」）は、会社名の検索では同義の語として扱い、点数を下げる（`株式会社` だけで全ての会社が上位に来ないように）。
- 解析器は、Amazon OpenSearch Service が持つ `analysis-kuromoji`・`analysis-icu` のプラグインを使う。Sudachi のプラグインも任意で足せ、辞書を独自のパッケージとして上げられる（[Plugins by engine version in Amazon OpenSearch Service](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html)、[Importing and managing packages](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/custom-packages.html)、2026-09-28 に確認）。
- **E5 の着手前の PoC で決める**（intent）：生成した日本語の会社名・人名・住所・商談名の組で、kuromoji＋2-gram と Sudachi（C モード）＋2-gram の再現率と適合率を比べる。既定の案は kuromoji＋2-gram。Sudachi が再現率で 5 ポイント以上良ければ Sudachi にする。
- 組織ごとの利用者の辞書（社内の製品名など）は MVP で持たない。共有の索引に組織ごとの解析器を持てないため（S2 で専用の索引の組織にだけ検討）。

### 4.4 名前での代わりの検索

- **参照の項目の候補**は、まず `record_index_values` の名前の行（正規化した `v_text`）の前方一致で引く（`v_text >= $q AND v_text < $q || U+FFFF`。[data-storage.md](data-storage.md) の 3.2 節の B-tree）。書いた直後のレコードも出る。共有の条件はデータ層のコンパイラが付ける（通常の問い合わせ）。
- 前方一致で 10 件に満たず、`q` が 2 文字以上なら、OpenSearch の `name` と `name.ngram` で足す。
- **OpenSearch の障害**・その組織の索引の作り直し中（`search_index_state = building`）は、組織の全体の検索も、名前のピボットの前方一致と、`name_kana` の前方一致（索引があれば）だけで答え、`degraded: true` を返す。画面に「名前だけで検索しています」と出す。
- 名前の前方一致は、`tx.queries`・`tx.query_rows` の通常の上限の中で行う。

### 4.5 索引の作り方と遅れ

```
保存の手順 11：outbox に record.changed（org, object, id, row_version, 変わった field_no）
      │ 確定の後
      ▼
Relay ─▶ SQS search-index（標準キュー）
      ▼
indexer（Worker）
  1. 変わった項目に searchable のものがなければ捨てる（名前・所有者の変更は必ず扱う）
  2. 100 件か 1 秒ごとにまとめ、records を writer から読む（ごみ箱・削除なら delete）
  3. _bulk で書く。version_type=external、version=row_version
     （古い row_version の書き込みは 409 で捨てる。順が入れ替わっても戻らない）
  4. 失敗は SQS の再送（最大 10 回）→ dead letter → 範囲の作り直しの仕事にする
```

| 事象 | 索引への反映 |
| --- | --- |
| 作成・更新 | 文書を書く（`row_version` の外部の版） |
| 削除（ごみ箱へ） | 文書を消す。ごみ箱のレコードは検索に出さない（ごみ箱の画面は DB で引く） |
| 戻す | 文書を書き直す |
| 完全な削除・消去 | 文書を消す（ごみ箱で消してあるので、残りの確認だけ） |
| 項目の `searchable` の変更・型の変換・項目の削除 | そのオブジェクトの作り直しの仕事（4.6 節） |
| オブジェクトの削除 | そのオブジェクトの文書を `delete_by_query`（`org_id` と `object_id`） |
| 所有者の変更 | 文書を書き直す（`owner_id` は並べ替えと将来の絞りのためだけ。判定には使わない） |
| 組織の削除・移動 | 組織の文書を消す・移動先で作り直す |

- **遅れの目標**：確定から検索に出るまで p95 5 秒、p99 30 秒。60 秒を超える遅れが 5 分続いたら警告する。
- 一括の取り込み（100 万件）では遅れが延びる。一括の仕事の outbox は、索引の仕事を別の低い優先の SQS に入れ、対話の保存の反映を先にする。
- 保存の直後に自分が作ったレコードを探す体験は、参照の候補（4.4 節）と「最近見たもの」（[ui-layouts-and-list-views.md](ui-layouts-and-list-views.md) の 4.2 節）で補う。

### 4.6 作り直しと整合の検査

- **作り直しの仕事**（`search_reindex_jobs`）：組織・オブジェクトの単位で、`records` を ID の範囲（1 万件）ごとに読み、文書を書く。Worker の class `search_reindex`（[governor-limits.md](governor-limits.md) の 8.4 節）。範囲ごとに冪等。
- マッピングの変更：新しい版の索引を作り、全ての組織を作り直してから別名を切り替える。作り直しの間の変更は、indexer が古い版と新しい版の両方に書く。
- **整合の検査**：組織ごとに 7 日で一周する（[ADR-0012](../decisions/0012-derived-copies-consistency-and-projections.md) と同じ考え方）。ID の範囲ごとに、`records`（生きている行）の `(id, row_version)` と、索引の `(record_id, row_version)` を比べ、差のある文書だけを書き直す。直した件数を `search_drift_repaired_total` で数える。

## 5. 問い合わせの組み立て

```json
{
  "bool": {
    "filter": [
      { "term": { "org_id": "<要求の組織>" } },
      { "terms": { "object_id": ["<読めるオブジェクト>"] } }
    ],
    "should": [
      { "multi_match": { "query": "例示 商事", "fields": ["name^3", "name.ngram^1", "name_kana^2"] } },
      { "nested": { "path": "texts",
                    "query": { "bool": {
                      "filter": [ { "terms": { "texts.f": ["<その利用者が読める searchable の field_no>"] } } ],
                      "must": [ { "match": { "texts.v": "例示 商事" } } ] } } } }
    ],
    "minimum_should_match": 1
  }
}
```

- `org_id` の条件は、問い合わせを組み立てる 1 つの関数だけが付け、外せない。関数の外で OpenSearch の問い合わせを作ることを lint で禁止する（ADR-0003 の直接の SQL の禁止と同じ考え方）。
- `object_id` と `texts.f` の絞りは、権限の形（`perm_shape`）から作る（6.2 節）。
- 点数：形態素の一致 > カナの一致 > 2-gram の一致。同じ点数なら `updated_at` の新しい順。

## 6. 権限の絞り込み（ADR-0032）

### 6.1 流れ

```
要求（利用者 U、版 V に固定）
  1. 読めるオブジェクト O_U と、オブジェクトごとの読める searchable の項目 F_U,o を、権限の形からコンパイル
  2. OpenSearch：org_id ∧ object ∈ O_U ∧ （名前 ∨ texts.f ∈ F_U,o）で候補を取る
     （1 ページごとに固定の 3,000 件の束を 1 回だけ。ページの位置は search_after で持つ）
  3. 後の確かめ：束の全ての候補について、オブジェクトごとに、データ層で
       SELECT <返す項目> FROM <object> WHERE id IN (<候補>) AND <要求の where>
     をコンパイルして実行（共有の条件・FLS・ごみ箱の除外は通常のコンパイラが付ける）。
     見える結果が limit に達しても途中で止めない
  4. 残った ID を、候補の点数の順に並べ直す
  5. 返す：オブジェクトごとに limit まで。束の中で残った結果が返した数より多ければ
     more_may_exist = true（見えない候補の有無では変えない）
  6. 要求の受け付けから下限の時間（1 ページ 600ms）が過ぎるまで待って返す
```

- 後の確かめは、問い合わせと同じコンパイラ（ADR-0003 の段 3・4）を通るので、判定は画面・REST と同じ 1 か所になる（[sharing-and-record-access.md](sharing-and-record-access.md) の 6.4 節の「全文検索」の行）。コンパイラの判定は参照の評価器（[ADR-0017](../decisions/0017-reference-access-evaluator.md)）と一致することを性質ベーステストで確かめているので、後の確かめは参照の評価器と同じ意味になる。
- 本番の標本の照合（ADR-0017）は、検索の結果の行にも当てる（結果の 1 万行に 1 行）。
- 後の確かめの問い合わせは `tx.queries`・`tx.query_rows` に数えない。代わりに `search.request` の予算（[governor-limits.md](governor-limits.md) の 5 節）で抑える：OpenSearch の時間 2 秒、1 ページの候補 3,000、後の確かめはオブジェクトごとに 1 回。

### 6.2 前に絞るもの・後で確かめるもの

| 判定 | どこで | 理由 |
| --- | --- | --- |
| 組織 | OpenSearch の `filter`（必須）＋ 後の確かめの RLS | 2 重に守る。索引の誤りでも、後の確かめの DB が他の組織の行を返さない |
| オブジェクトの権限 | OpenSearch の `filter` | 権限の形から決まり、組織の全てのレコードに同じ。前に絞っても漏れない |
| FLS（一致に使う項目） | OpenSearch の `texts.f` の絞り | 読めない項目の値で一致させると、その値を推し量れる（例：読めない「年収」の項目の値で検索して、当たるかを見る）。[ADR-0013](../decisions/0013-permission-sets-and-field-level-security.md) の「読めない項目は存在しない項目と同じ」 |
| レコードの共有 | 後の確かめ | 利用者ごと・レコードごとに違い、共有の変更で常に変わる。索引に写すと、再計算のたびに索引も書き直すことになり、遅れの間に漏れる |
| 返す値と強調 | 後の確かめで DB から読む | 索引の値は古いことがある。FLS で読める項目だけを返し、強調も読める項目だけで作る |

- 名前の項目は FLS の対象外（オブジェクトを読めれば読める。[sharing-and-record-access.md](sharing-and-record-access.md) の 3.2 節）なので、常に一致に使う。

### 6.3 強調（ハイライト）

- 強調は OpenSearch の highlight を使わず、後の確かめで読んだ値に対して、同じ解析器の語（`_analyze` の結果をキャッシュ）で Runtime が作る。索引に本文を置かず（4.2 節）、読めない項目の断片を作らないため。
- 長いテキストは、一致した語の前後 60 文字だけを返す。

### 6.4 件数と時間から漏らさない

- **件数の合計を返さない。** OpenSearch の `hits.total` は見えないレコードを含むため。画面は「さらに表示」だけを出す。
- `more_may_exist` は、束の中で後の確かめを通った結果が、返した数より多い時だけ true にする。見えない候補がいくつあっても変わらない。次のページ（次の束）は、`more_may_exist` が false でも取りに行ける（見える一致が次の束にありうるため。画面は「さらに探す」を常に出す）。
- 後の確かめで落ちた件数を、応答にもログの利用者向けの画面にも出さない（運用の計測だけ。`search_postfilter_drop_ratio` は組織を特定しない集計で出す）。
- **時間をそろえる（LEAK-012）。** 見えない候補の数で処理の量が変わると、応答の時間から「見えない一致がある」ことを推し量れる。既定の対策は次の 3 つ。
  - **固定の束**：1 ページごとに候補を 3,000 件の束で 1 回だけ取り、見える結果の数で取り直さない。
  - **束の全ての確かめ**：見える結果が `limit` に達しても、後の確かめを束の全ての候補に行う。
  - **下限の時間**：要求の受け付けから 600ms が過ぎるまで返さない。値は E5 の `search-api-post-filter` で、固定の束の後の確かめの p95 を測って決め直す（下限は p95 より上に置く）。
- 残るリスク：
  - 処理が下限を超えた時（大きな組織、DB の負荷の高い時）は、時間が見えない候補の数で揺れる。`search_floor_exceeded_ratio`（下限を超えた要求の割合）を計測し、5% を超えたら下限を見直す。
  - 同じ検索を多く繰り返して平均を比べる攻撃は、下限の内側でも、DB の待ちの揺れから差を拾いうる。検索は `search.request` の予算と組織の同時の検索（20）で数を抑える。
  - OpenSearch の一致の合計が束（3,000）より少ない時は、確かめる候補が減って速い。この差も下限を超えた時だけ表に出る。
  - E12 の外部のペンテストで、時間の差から見えない一致を推し量れないことを確かめる。

### 6.5 見えるのに出ない（取りこぼし）

- 見る人が見られるレコードが少ない組織（非公開の OWD で、部下のいない担当者）では、候補 3,000 件の多くが後の確かめで落ち、見られる一致が 3,000 件の外にあると出ない。本家と同じ性質（2 節）。
- 取りこぼしを減らすため：`where` で絞った検索は、「`where` と共有の条件で絞った ID の集合」が 1 万件以下なら、常にその集合から始め、OpenSearch は `terms` の `record_id` で点数だけを付ける。経路は見える ID の集合の大きさだけで選び、OpenSearch の一致の件数では選ばない（見えない一致で経路が変わると、時間の差になるため）。
- それでも出ない時は、画面に「条件を足すと見つかりやすくなります」と出す。

## 7. 上限（S1 の初期値）

値は [governor-limits.md](governor-limits.md) を正とする。

| 上限 | 値 | 本家 |
| --- | --- | --- |
| 検索の語の文字数 | 2〜500（CJK の文字を含むなら 1 から） | 10,000（Limits） |
| 語の数 | 10 | 未検証 |
| 1 回の結果 | 200（既定 50）。オブジェクトごと 200 | 1 つのオブジェクト 250、合計 2,000（SOSL） |
| ページ送りの合計 | 2,000 | 2,000（Limits） |
| 1 回の要求のオブジェクト | 20 | 未検証 |
| 候補と後の確かめ | 1 ページ 3,000 の固定の束、束の全てを確かめる | 最大 2,000 件を探して絞る（SOSL） |
| 1 ページの下限の時間 | 600ms（E5 で決め直す） | — |
| OpenSearch の時間 | 2 秒 | 未検証 |
| 検索できる項目 | 1 オブジェクト 20 | 未検証 |
| 長いテキストの索引 | 最初の 32KB | 未検証 |
| 組織の同時の検索 | 20 | 未検証 |
| 索引の遅れ | p95 5 秒、p99 30 秒（目標） | 公開の値なし |

本家の列の「未検証」は、本家の値を公開の資料で確かめていないもの。本システムの値は本家に依らず、E12 の `limits-final-values` で決める。

## 8. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| OpenSearch の障害・時間切れ | 名前のピボットの前方一致に切り替え、`degraded: true`（4.4 節）。保存は止めない |
| indexer の遅れ | 遅れの p95 が 60 秒を 5 分超えたら警告。一括の索引の仕事を後回しにする |
| 索引への書き込みの失敗が続く | dead letter から範囲の作り直しの仕事へ。整合の検査でも直る |
| 索引と DB のずれ | 整合の検査で直して数える（4.6 節）。ずれの間、索引にない新しいレコードは見つからず、索引に残った消したレコードは後の確かめで落ちる（漏れない） |
| 版の違う索引への切り替えの途中 | 両方に書き、読みは別名の指す方だけ |
| 大口の組織の検索が 1 つのシャードに集中する | S2 で専用の索引へ。`search_latency_seconds{org_size}` を計測 |
| 組織の移動（セルの間） | 移動先で作り直す。作り直しの間は `degraded` |

## 9. セキュリティ

- 組織の条件は 1 つの関数が必ず付け、後の確かめの RLS で 2 重に守る（6.2 節）。性質ベーステストで、他の組織の文書が結果に出ないことを確かめる。
- 索引は候補を作るだけで、返す値は全て DB から読む。索引に共有の情報を写さない。`_source` に本文を置かない。
- 読めない項目で一致させない（`texts.f` の絞り）。名前以外で FLS の対象の項目を、索引の上位の項目（`name` など）に写さない。
- 件数の合計を返さない（6.4 節）。
- OpenSearch のドメインは VPC の中に置き、Runtime と indexer の IAM のロールだけが読み書きできる。保存時の暗号化とノードの間の TLS を有効にする。
- 検索の語は個人データを含みうる。アクセスのログには語のハッシュと長さだけを残す（[query-language-and-api.md](query-language-and-api.md) の 8 節と同じ考え方）。
- 完全な削除・消去・組織の削除で、文書を消す。消えたことを整合の検査で確かめる。
- `security:sensitive` の対象：問い合わせを組み立てる関数（組織・オブジェクト・項目の絞り）、後の確かめ、強調の作り方。

## 10. テスト

- 決定表：6.2 節の表（判定 × どこで）を `DT-SRCH-001` にし、FLS と共有の組み合わせ（名前・読める項目・読めない項目で一致 × レコードを見られる・見られない → 結果に出るか）を表駆動テストにする。
- 性質ベーステスト（fast-check）：
  - `PROP-SRCH-001`（草案）：任意の組織・利用者・レコード・共有の設定・検索の語で、結果の集合が「索引の候補 ∩ 参照の評価器で読めるレコード」の部分集合で、読めないレコードを含まない。
  - `PROP-SRCH-002`（草案）：任意の 2 組織で、一方の組織の検索に他方の文書が出ない（索引の `org_id` をわざと誤らせても、後の確かめで落ちる）。
  - 読めない項目にだけある語で検索すると、そのレコードは結果に出ない（名前に語がない時）。
  - 任意の保存の列（順の入れ替え、二重の配信を含む）の後で、索引の文書の `row_version` が DB の最後の値と一致する。
  - 正規化：ひらがなとカタカナ、全角と半角、大文字と小文字だけが違う語で、同じ結果になる。
- 否定側のテスト：件数の合計が応答にない。強調に読めない項目の断片がない。ごみ箱のレコードが出ない。見えない一致だけを足した組織と足さない組織で、同じ検索の結果と `more_may_exist` が同じで、応答の時間が下限の内側で区別できない（`LEAK-012`）。
- 解析の評価（E5 の PoC と回帰）：生成した日本語のコーパス（会社名 1 万、人名 1 万、住所、商談名）と正解の組で、再現率・適合率を測る。解析器の設定の変更で 2 ポイント以上悪化したら CI を落とす。
- 結合テスト：OpenSearch を止めて、名前での代わりの検索に切り替わる。
- 上限の試験：7 節の値。
- 性能テスト：組織の全体の検索の p95 800ms（S1 の最大の組織、5 オブジェクト）。参照の候補の p95 200ms。索引の遅れ p95 5 秒。

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0031](../decisions/0031-search-index-and-japanese-analysis.md) | 共有の 16 個の索引に組織の ID で振り分け、組織の条件を必ず付ける。日本語は kuromoji と CJK の 2-gram の 2 つで持つ。outbox から非同期に作り、`row_version` を外部の版にする。参照の候補と障害の時は名前のピボットで引く |
| [0032](../decisions/0032-search-permission-post-filter.md) | OpenSearch の結果は候補だけとし、オブジェクトの権限と FLS は前に絞り、レコードの共有はデータ層の問い合わせで後に確かめる。索引に共有を写さず、件数の合計を返さない。固定の候補の束、束の全ての確かめ、1 ページの下限の時間で、応答の時間をそろえる |

他の領域への依頼：

- metadata-and-runtime の領域：`md_fields.searchable` を足す。部品に検索の項目の一覧を入れる。
- sharing-and-record-access の領域：6.4 節の「全文検索」の行に、「オブジェクトの権限と FLS は前に、共有は後に」と書き足す。
- query-language-and-api の領域：`/api/v1/search` を REST の一覧に足す。
- data-storage の領域：名前の前方一致のために `record_index_values` の `v_text` の B-tree が前方一致に使える（`text_pattern_ops` か `COLLATE "C"`）ことを確かめる。

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | OpenSearch のドメイン（VPC、暗号化、IAM）と、索引の別名の運用 |
| E1 | CI：問い合わせを組み立てる関数の外での OpenSearch の問い合わせの禁止（lint） |
| E3 | outbox から indexer への経路（SQS、まとめ、外部の版） |
| E5 | 日本語の解析の PoC（kuromoji と Sudachi、2-gram）と評価のコーパス |
| E5 | 索引の形（`texts` の nested、`_source` の最小化）と `md_fields.searchable` |
| E5 | 検索の API と、後の確かめ（6.1 節）、`more_may_exist` |
| E5 | 組織の全体の検索の画面と、オブジェクトの中の検索 |
| E5 | 参照の項目の候補（名前のピボットの前方一致＋OpenSearch） |
| E5 | 強調の作り方（読める値だけ） |
| E5 | 作り直しの仕事と整合の検査 |
| E5 | OpenSearch の障害の時の代わりの検索（`degraded`） |
| E4 | `DT-SRCH-001` と `PROP-SRCH-001`・`002` |
| E9 | 一括の取り込みの索引の仕事を低い優先にする |
| E12 | 検索の性能テストと、大口の組織の索引の分け方の判断 |

## 13. 未解決の問い

- kuromoji と Sudachi のどちらを既定にするか。
- 組織ごとの利用者の辞書を持つか。
- 後の確かめで取りこぼす率が、非公開の OWD の組織で許せる大きさか。
- 応答の時間から見えない一致を推し量れる点に、対策（時間をそろえる）が要るか。 → 決定を見よ。
- 索引の遅れの目標（p95 5 秒）は、一括の取り込みの時にも守るか。
- 検索の語をどこまで記録するか（分析と個人データのバランス）。

### 決定

2026-09-28 の既定案。

- kuromoji＋2-gram を既定にし、E5 の PoC で Sudachi が再現率で 5 ポイント以上良ければ替える。
- 組織ごとの辞書は MVP で持たない。S2 で専用の索引を持つ大口の組織にだけ検討する。
- 取りこぼしは、E5 で「見られる一致が 3,000 件の外にあった率」を標本で測る。1% を超えるなら、オブジェクトを 1 つに絞った検索の固定の束を 1 万件に増やす（束の大きさは固定のまま）。
- 時間をそろえる（2026-09-28 に改めた）：固定の束、束の全ての確かめ、1 ページ 600ms の下限（6.4 節）。残るリスクは 6.4 節に書き、E12 の外部のペンテストで確かめる。
- 一括の取り込みの間は、一括の分の遅れの目標を外す（対話の保存の分だけ p95 5 秒を守る）。
- 検索の語は、ハッシュと長さだけを残す。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：検索の結果を通した、見えないレコード・読めない項目の漏れ（最重要の 1 つ）。`DT-SRCH-001`、`PROP-SRCH-001`・`002`、本番の標本の照合を検索の結果にも当てる。
- リスク：組織の条件の付け漏れ。lint と、後の確かめの RLS の 2 重の守り、`PROP-SRCH-002`。
- リスク：日本語の検索の質（取りこぼし・誤った一致）。評価のコーパスと再現率・適合率の回帰の CI。
- 本番での検証：索引の遅れの p95、`search_drift_repaired_total`、`search_postfilter_drop_ratio`、`search_floor_exceeded_ratio`（下限の時間を超えた要求の割合。5% を超えたら下限を見直す。LEAK-012）、`degraded` の率。

**runbooks**

- `search-index-lag`：索引の遅れの p95 が 60 秒を 5 分超えた。indexer の数、SQS の滞留、OpenSearch の書き込みの拒否を調べる。
- `search-degraded`：OpenSearch の障害で名前での代わりの検索に切り替わった。
- `search-reindex`：マッピングの変更、組織・オブジェクトの作り直しの手順。
- `search-drift-high`：整合の検査で直した件数が急に増えた。indexer の不具合を調べる。
- SLI の追加の依頼（Ops へ）：検索の p95・p99、参照の候補の p95、索引の遅れ、`degraded` の率、OpenSearch の CPU と JVM のヒープ、後の確かめの問い合わせの時間。

**data-model**

| テーブル・索引 | 主な列 | 備考 |
| --- | --- | --- |
| `md_fields.searchable` | 真偽 | metadata-and-runtime の表への追加 |
| `search_index_state` | `org_id`、`object_id`、`state`（`ready`・`building`）、`index_version`、`last_full_build_at` | RLS |
| `search_reindex_jobs` | `org_id`、`object_id`、`reason`、`last_id`、`state`、`started_at` | 範囲ごとに冪等 |
| `search_consistency_progress` | `org_id`、`object_id`、`last_id`、`cycle_started_at`、`repaired` | 7 日で一周 |
| OpenSearch `rec-v{n}-{00..15}` | 4.2 節の文書 | 正本の写し。作り直せる |

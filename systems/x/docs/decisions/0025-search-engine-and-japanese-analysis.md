---
status: accepted
date: 2026-10-04
---

# ADR-0025: 検索は OpenSearch で、一致の判定は 1〜2 文字の N-gram、関連度の点は kuromoji で付ける。正規化は 1 つの関数で索引と問い合わせにかける

詳細は [search-and-trends.md](../architecture/search-and-trends.md) の 5 節。

## Context

日本語の投稿の全文検索を、取りこぼさずに（NFR-007「日本語の部分一致で取りこぼさない」）、p99 500ms で返す。日本語は空白で語を分けない。形態素解析だけだと、未知語（新しい固有名詞、ネットの言葉）や、語の途中での一致（「東京都庁」を「京都」で探す）を取りこぼす。N-gram だけだと、関連度の点が粗く、索引が大きくなる。

[architecture/README.md](../architecture/README.md) は、OpenSearch の kuromoji と N-gram の組み合わせを第一の候補にし、E9 の前の `search-poc` で測るとしている。

事実（2026-10-04 に確認）：Amazon OpenSearch Service は kuromoji と ICU をすべてのドメインに入れている。Sudachi は任意のプラグインで、AWS は日本語に勧めている。Sudachi の辞書の差し替えは、次の blue/green のデプロイまで反映されない（[Plugins by engine version](https://docs.aws.amazon.com/opensearch-service/latest/developerguide/supported-plugins.html)）。Slack の題材は、一致を N-gram、点を形態素解析に分けた（[Slack の ADR-0004 と search.md](../../../slack/docs/architecture/search.md)）。

## Options

部品：

1. **Amazon OpenSearch Service**
2. Aurora PostgreSQL の全文検索（pg_bigm など）
3. 自前の転置索引

解析：

- a. **一致の判定は 1〜2 文字の N-gram で連続を求め、関連度の点は kuromoji。英字は語の単位**
- b. kuromoji だけ
- c. N-gram だけ
- d. a の点を Sudachi で付ける

## Decision

1 と a を採用する。d は `search-poc` で比べ、点の質が明らかに良く、辞書の運用（blue/green）を受け入れられるなら替える。

- フィールド：`text.gram`（`ngram` 1〜2 文字、一致）、`text`（kuromoji の `search` の分け方、品詞の除外、基本形、止め語。点）、`text.word`（`standard`、英字の一致）、`hashtags`（`keyword`）。
- 問い合わせの語ごとに、日本語を含めば `text.gram` の `match_phrase`、英字と数字だけなら `text.word` の `match` を `must` に置く。`text` の `match` は `should` に置く。
- 正規化は `packages/text` の `normalizeForSearch`（NFKC、小文字、長音と波ダッシュの統一、幅のない文字の除去）。索引・問い合わせ・トレンドの語・クライアントの補完で同じ関数を使う。アナライザーの側で正規化しない（アプリと同じ結果にするため）。
- ひらがなとカタカナは同一視しない。
- 2 を採らない理由：S3 で 1 日 1 億件の投稿の索引を正本の DB に置くと、書き込みと記憶を圧迫する。公開の表に検索の索引を足すと、投稿の表の分割（S2）と結び付く。
- 3 を採らない理由：題材の核は「何を一致とし、どう見える範囲を守るか」で、転置索引の実装ではない。汎用の部品で足りる。
- b を採らない理由：未知語と語の途中で取りこぼす。
- c を採らない理由：点が粗く、「話題」のタブの質が出ない。

## Consequences

- 良くなること：
  - 取りこぼしを N-gram で防ぎ、点を形態素解析で付けられる。
  - 正規化が 1 つの関数で、補完・検索・トレンドの結果が揃う。
- 引き受けるコスト：
  - N-gram のフィールドで索引が大きくなる（増え方は**未検証**。`search-poc` で測る）。
  - 1 文字の語は候補が多く遅い。時間の上限（400ms）と途中の結果で守る。
  - 正規化のバージョンを変えると、索引の作り直しが要る。

## Confirmation

- 例示テスト：日本語の例の集まり（語の途中、未知語、全角・半角、長音、1 文字、英字との混在）で取りこぼし 0。
- 性質ベーステスト：PROP-SRCH-004（正規化の冪等とクライアント・サーバーの一致）。
- `search-poc` の記録：索引の大きさ、p99、kuromoji と Sudachi の点の比較（人の評価の上位 10 件の妥当さ）。

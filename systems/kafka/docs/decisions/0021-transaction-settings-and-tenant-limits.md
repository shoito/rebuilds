---
status: accepted
date: 2026-09-27
---

# ADR-0021: トランザクションの防御を固定で有効にし、`transactional.id` の数と InitProducerId の頻度にテナントごとの上限を掛ける

詳細は [transactions-and-idempotence.md](../architecture/transactions-and-idempotence.md) の 4〜6 節。

## Context

- 冪等なプロデューサーとトランザクションを、本家と同じ意味で動かす（intent.md）。意味は本家の実装をそのまま使う（[ADR-0001](0001-upstream-brokers-and-stack.md)）。
- 本家の KIP-890 は 2 段ある。第 1 段は古いクライアント向けの確認（`transaction.partition.verification.enable`、既定 `true`）。第 2 段（TV2）はトランザクションごとにエポックを上げ、`transaction.version=2` で有効にする。4.0 からサーバーで既定で有効で、4.0 以上のクライアントが使う（[Transaction Protocol](https://kafka.apache.org/43/operations/transaction-protocol/)、[KIP-890](https://cwiki.apache.org/confluence/display/KAFKA/KIP-890%3A+Transactions+Server-Side+Defense)、2026-09-27 に確認）。
- Jepsen が報告した遅れた `EndTxn` の問題（KAFKA-17754）は、2026-08-12 に「KIP-890 と関連の修正で解決」として閉じられた（[KAFKA-17754](https://issues.apache.org/jira/browse/KAFKA-17754)、2026-09-27 に確認）。
- `transactional.id.expiration.ms` は 7 日、`producer.id.expiration.ms` は 1 日、`transaction.max.timeout.ms` は 15 分。いずれもブローカー全体の設定（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認）。
- PID の乱発でブローカーのメモリーが尽きる問題への本家の対策（KIP-936）は、議論中で実装されていない（[KIP-936](https://cwiki.apache.org/confluence/display/KAFKA/KIP-936%3A+Throttle+number+of+active+PIDs)、2026-09-27 に確認）。
- Kora は、メモリーを使う振る舞いにテナントごとのクォータを掛けている（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 5.2 節）。
- `__transaction_state` のパーティションは物理クラスタのすべてのテナントで共有する。1 つのテナントの大量の `transactional.id` は、コーディネーターの移動のときの読み込みを遅らせ、同じパーティションの他のテナントを待たせる。

## Options

防御の設定：

1. **TV2 と第 1 段の確認を固定で有効にする**
2. 本家の既定に任せ、運用の判断で変えられるようにする

`transactional.id` の上限：

- A. **コーディネーターのパーティションごとに、テナントの ID の数を手元で数えて断る**
- B. テナント全体の数を集計して断る
- C. 上限を掛けない

InitProducerId：

- X. **頻度の上限を掛け、`throttle_time_ms` で遅らせる**
- Y. KIP-936 が入るまで何もしない

## Decision

1、A、X を採用する。

- `transaction.version=2`、`transaction.partition.verification.enable=true` を固定し、テナントの API（UpdateFeatures など）からは変えられない。
- `transaction.max.timeout.ms`、`transactional.id.expiration.ms`、`producer.id.expiration.ms` は本家の既定のまま。
- 2 相コミット（`transaction.two.phase.commit.enable`）は無効。
- 生きている `transactional.id` の上限：Basic 1,000、Standard 10,000。コーディネーターのパーティションのリーダーが「そのテナントの ID の数 ≤ ceil(2 × 上限 ÷ 50)」を確かめ、超える新しい ID の InitProducerId を `TRANSACTIONAL_ID_AUTHORIZATION_FAILED`（文言に上限を超えたことを書く）で断る。既存の ID は使い続けられる。
- InitProducerId の頻度の上限：Basic 毎秒 10、Standard 毎秒 100。ブローカーの数で割った値を、ブローカーごとに静的に掛ける。超えたら応答の `throttle_time_ms` で遅らせる。
- 上限の確かめ方は差し込み口にないので、名前空間のパッチと同じ場所に入れ、パッチの一覧に KIP-890・KIP-936 との関係を書く。
- 2 を選ばない理由：防御を切ると、KAFKA-17754 の型の問題が戻る。変える理由が性能だけなら、ADR で決め直す。
- B を選ばない理由：集計の往復で判断が遅れ、決定的でなくなる。A は偏りで少し早く断られうるが、倍の余裕を持たせた。
- C を選ばない理由：Kafka Streams を使い捨てのディスクで動かすと、再起動のたびに新しい ID が 7 日残る。1 つのテナントがコーディネーターを重くしうる。
- `TRANSACTIONAL_ID_AUTHORIZATION_FAILED` を選ぶのは、InitProducerId に本家が定義するエラーの中で、再試行しても直らないことが伝わるため。本家と違う点として、差分テストの「許された違い」に載せる。

## Consequences

- 良くなること：
  - exactly-once の防御が、4.0 以上のクライアントで常に効く。
  - 1 つのテナントの使い方で、コーディネーターとブローカーのメモリーが傷みにくい。
- 引き受けるコスト：
  - 上限に当たったテナントは、エラーが「認可の失敗」に見える。文言と文書で補う。
  - パッチが増える。KIP-936 が本家に入ったら置き換える。
  - 古いクライアントには、第 1 段の防御しか効かない（本家と同じ）。

## Confirmation

- 設定のテスト：ブローカーの起動時に、`transaction.version` と確認の設定が固定の値であることを検査し、違えば起動を止める。
- 性質ベーステスト：任意の InitProducerId の列で、テナントの ID の数がパーティションごとの上限を超えない。一方のテナントの要求が、他方のエポックを変えない。
- 差分テスト：上限の外では、トランザクションの要求の列のエラーコードとオフセットが本家と同じ。

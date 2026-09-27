---
status: accepted
date: 2026-09-27
---

# ADR-0014: 本番で耐久性の監査とカナリアを持ち、Jepsen の形の障害注入を PR ごとと日次で回す

詳細は [replication-and-durability.md](../architecture/replication-and-durability.md) の 7・8 節。

## Context

[intent.md](../intent.md) の SC-2 は、受け付けた書き込みの喪失を、障害注入のテストと本番の耐久性の監査で 0 件にすることを求める。[ADR-0005](0005-compatibility-policy.md) は、Jepsen の形の耐久性のテストを日次と耐久性に関わる PR ごとに回すと決めた。

事実（2026-09-27 に確認）：

- Kora は、複製と S3 だけでは足りないとして、整合性に関わるメタデータの変化（`log-start-offset` など）を監査の事象として記録し、通常は日次のバッチで不変条件を照合する。早く気づけば、壊れたリーダーを外してデータを救えることがある。報告された事例は、リーダーのストレージの破損による先頭の切り詰め、階層型の保存のメタデータの食い違い、保持の時間の誤変更、`log-start-offset` の更新の競合（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.6 節と表 1）。
- jepsen.tests.kafka は、`lost-write`、`duplicate`、`poll-unseen`、`g1a` などを検出する（[jepsen.tests.kafka](https://jepsen-io.github.io/jepsen/jepsen.tests.kafka.html)）。
- Jepsen は、本家の Kafka のトランザクションのプロトコルにも異常を報告しており、未解決のものがある（KAFKA-17754 など。[Jepsen: Bufstream 0.1.0](https://jepsen.io/analyses/bufstream-0.1.0)）。

## Options

1. **テストの障害注入だけ**
2. **テストの障害注入＋本番の監査（事象の記録と日次の照合）＋本番のカナリア**
3. **2 に加えて、本番でも障害注入を行う**

## Decision

2 を採用する。

- 本番：
  - ブローカーとコントローラーが、7.1 節の事象（レコードの中身を含めない）を出し、運用の論理クラスタを経て S3 に集める。
  - 不変条件 AUD-1〜6 を日次（AUD-3 は週次の抜き取り）で照合し、不一致で人を呼ぶ。
  - 物理クラスタごとのカナリア（AUD-7）で、連番の抜け・重複・順序を常時確かめる。
- テスト：
  - jepsen.tests.kafka を、自社の構成（SASL、名前空間、3 つの rack）で動かす。障害は replication-and-durability.md の 8.3 節。
  - `acks=all` の `lost-write`・`poll-unseen`・`nonmonotonic` と、冪等の `duplicate` は 0 件で合格。
  - トランザクションの異常は、同じシードでパッチなしの本家と比べ、自社だけのものを失敗にする。本家と同じものは既知の制約の一覧に載せる。
  - `durability:sensitive` の PR ごとに 1 時間の部分集合、日次に全体、本家の RC ごとに全体。
- 3 は、S1 では採らない。本番では四半期ごとの AZ の退避の訓練に留める。
- 1 は、Kora の事例のような、テストで再現しにくい本番の不具合（設定の更新、ストレージの破損）を見逃す。

## Consequences

- 良くなること：
  - 喪失を、利用者より先に見つけられる。気づくまでの時間に上限ができる（カナリアは 5 分、監査は 1 日）。
  - 本家の既知の問題と、自社の問題を分けて説明できる。
- 引き受けるコスト：
  - 監査の事象を出すプラグインと、照合のバッチを保守する。本家の版の更新で、事象の出し方が変わりうる。
  - Jepsen の形のテストの環境と実行の費用。

## Confirmation

- 監査の自己検査：検証の環境で、わざと保持を誤作動させ（`log-start-offset` を早く進める）、AUD-1 が翌日の照合で検出する。
- カナリアの自己検査：カナリアのレコードをわざと消し、5 分以内にアラートが出る。
- CI：Jepsen の形のテストの結果と、既知の制約の一覧の差分を毎回出力する。

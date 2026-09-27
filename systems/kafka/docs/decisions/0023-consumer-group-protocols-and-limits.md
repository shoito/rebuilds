---
status: accepted
date: 2026-09-27
---

# ADR-0023: classic と consumer の両方のプロトコルを本家の既定で出し、グループにテナントごとの上限を掛ける

詳細は [consumer-groups.md](../architecture/consumer-groups.md) の 4〜6 節と 8 節。

## Context

- 本家の KIP-848（consumer のプロトコル）は 4.0 で GA。サーバーでは既定で有効で、クライアントは `group.protocol=consumer` で使う。本家は 5.0 でクライアントの既定を consumer にし、6.0 でクライアントを consumer だけにするが、ブローカーは classic を残す（[Consumer Rebalance Protocol](https://kafka.apache.org/43/operations/consumer-rebalance-protocol/)、2026-09-27 に確認）。
- consumer の正規表現（RE2J）はサーバーで評価される（同上）。この題材では、トピックの内部の名前にテナントの接頭辞が付く（[ADR-0025](0025-tenant-namespace-patch.md)）ので、そのままでは他のテナントのトピックに当たりうる。
- `group.max.size`・`group.consumer.max.size` の既定は実質無制限。コーディネーターのスレッドは既定で 4（[Broker Configs](https://kafka.apache.org/43/configuration/broker-configs/)、2026-09-27 に確認）。コーディネーターは物理クラスタの全テナントで共有する。
- intent.md は、テナントが遅れ（lag）を取得できることを MVP に含める。

## Options

プロトコル：

1. **classic と consumer の両方を出す**
2. consumer だけを出す（新しいテナントに移行を強いる）

正規表現：

- A. **コーディネーターの中の評価をパッチで変え、テナントのトピックだけを相手に、接頭辞を外した名前で評価する**
- B. 要求の出入口で、正規表現の文字列に接頭辞を足して書き換える
- C. consumer の正規表現の購読を拒否する

遅れ：

- X. **データ面のエージェントが OffsetFetch と ListOffsets で計算する**
- Y. ブローカーのパッチで計算してメトリクスに出す

## Decision

1、A、X を採用する。

- 機能の版：`group.version` は本家の最新、`share.version`・`streams.version` は 0（[ADR-0024](0024-share-and-streams-groups-staging.md)）。
- 割り当て器は本家の `uniform,range`、移行の方針は `bidirectional`。
- ブローカー全体で `group.max.size`・`group.consumer.max.size` を 1,000 にする。
- テナントのグループの数：Basic 1,000、Standard 10,000。`__consumer_offsets` のパーティションのリーダーが「テナントのグループの数 ≤ ceil(2 × 上限 ÷ 50)」を確かめ、新しいグループを `GROUP_AUTHORIZATION_FAILED`（文言に上限を超えたことを書く）で断る（[ADR-0021](0021-transaction-settings-and-tenant-limits.md) と同じ形）。
- グループの単位の設定は、`consumer.session.timeout.ms`（45〜60 秒）と `consumer.heartbeat.interval.ms`（5〜15 秒）だけを許す。
- 遅れは 60 秒ごとにエージェントが計算し、メトリクスの API に渡す。
- 2 を選ばない理由：classic の独自の割り当て器を使うアプリと、consumer に未対応のクライアントが動かなくなり、「変更なしで動く」（intent.md）に反する。
- B を選ばない理由：正規表現の錨（`^`）や選択（`|`）を含む任意の式で、本家と同じ結果になる書き換えが難しい。
- C を選ばない理由：consumer のプロトコルの機能を欠くことになる。
- Y を選ばない理由：パッチを増やす。遅れはデータの経路に要らない。

## Consequences

- 良くなること：
  - 既存のアプリがどちらのプロトコルでも動き、本家の予定に沿って移行できる。
  - 正規表現の購読が、本家と同じ結果で、テナントの中に閉じる。
  - 共有のコーディネーターを、1 つのテナントのグループの使い方から守れる。
- 引き受けるコスト：
  - 名前空間のパッチが、要求の出入口に加えてコーディネーターの中にも入る。本家の版の更新で当て直す箇所が増える。
  - グループの大きさ 1,000 を超えるアプリは動かない（Dedicated で上げる）。
  - 遅れは最大で 60 秒古い。

## Confirmation

- 性質ベーステスト：任意のテナント・トピック・正規表現で、購読の結果が、1 テナントの本家のクラスタでの結果と同じで、他のテナントのトピックを含まない。
- 性質ベーステスト：任意のグループの操作の列で、他のテナントのグループが見えない。グループの数が上限を超えない。
- クライアントの行列：両方のプロトコル、正規表現、無停止の移行が通る。

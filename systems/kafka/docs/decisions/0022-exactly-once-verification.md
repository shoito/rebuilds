---
status: accepted
date: 2026-09-27
---

# ADR-0022: exactly-once の正しさは、Jepsen の形の試験と Kafka Streams の長時間の試験で毎日確かめ、本家の版の更新の関門にする

詳細は [transactions-and-idempotence.md](../architecture/transactions-and-idempotence.md) の 11・12 節。

## Context

- intent.md の守るべき振る舞い：冪等なプロデューサーの再送は重複を生まない。コミットしたトランザクションの書き込みはすべて見え、中止したものは `read_committed` のコンシューマーに見えない。
- Jepsen は、Kafka のトランザクションのプロトコルに、書き込みの喪失、中止した読み取り、ちぎれたトランザクション（KAFKA-17754）と、中止の後のコンシューマーの位置の問題（KAFKA-17582）を報告した（[Jepsen: Bufstream 0.1.0](https://jepsen.io/analyses/bufstream-0.1.0)、2026-09-27 に確認）。KAFKA-17754 は 2026-08-12 に解決として閉じられたが、修正の版の記載はない。KAFKA-17582 は未解決（ASF の Jira、2026-09-27 に確認）。
- Jepsen は Kafka のテストのライブラリ（`queue`、`txn` のワークロード）を公開している（[jepsen.tests.kafka](https://jepsen-io.github.io/jepsen/jepsen.tests.kafka.html)）。
- [ADR-0005](0005-compatibility-policy.md) は、Jepsen の形の耐久性のテストと Kafka Streams の exactly-once のテストを日次で回すとした。この ADR は、トランザクションについての中身と、関門としての扱いを決める。
- この題材は、本家のブローカーに名前空間のパッチを当てる（[ADR-0004](0004-logical-clusters-on-shared-physical-clusters.md)）。パッチは `transactional.id`・グループ・トピックの名前を書き換えるので、トランザクションの意味を壊しうる。

## Options

1. **Jepsen の形の txn のワークロード＋Kafka Streams の長時間の試験を毎日回し、本家の版の更新とパッチの変更の関門にする。本家で直っていない問題は既知の制約として公開する**
2. 本家の試験に任せ、自社では結合テストだけにする
3. 1 に加えて、本家で直っていない問題を自社のパッチで直す

## Decision

1 を採用する。

- Jepsen の形：`queue` と `txn` のワークロードを、自社のブローカー（パッチ＋差し込み口）の 3 AZ の構成に流す。障害は、停止・一時停止・分断（AZ の単位）・時計のずれ・ディスクの遅延・コーディネーターの移動・クライアントの再起動・トランザクションの中の遅延。クライアントは Java 4.3（TV2）と Java 3.9（第 1 段だけ）。
- KAFKA-17754 の再現の要求の列（遅れて届く `EndTxn`）を、差分テストの送り手で作り、TV2 で締め出されることを確かめる。
- Kafka Streams：集計のトポロジーを 6 時間、障害の下で動かし、出力を入力から計算し直した答えと比べる（重複・欠落 0）。
- 関門：本家の版の更新、名前空間のパッチの変更、トランザクション・グループに触れる PR は、これらが通るまでマージしない（`durability:sensitive`）。
- 公開：本家で直っていない問題（KAFKA-17582 など）と、古いクライアントでは第 1 段の防御しか効かないことを、利用者向けの文書の既知の制約に書く。
- 2 を選ばない理由：パッチがトランザクションの意味を壊していないことは、本家の試験では確かめられない。
- 3 を選ばない理由：本家と違う振る舞いを作ると、差分テストの基準が崩れ、互換の範囲（[ADR-0005](0005-compatibility-policy.md)）が曖昧になる。直すなら本家に提案する。

## Consequences

- 良くなること：
  - パッチと本家の版の更新で、exactly-once が壊れたことに、日の単位で気づける。
  - 利用者が、本家と同じ制約を知ったうえで使える。
- 引き受けるコスト：
  - Jepsen の環境と Streams の長時間の試験の費用と保守。失敗の調べに Clojure と Jepsen の知識が要る。
  - Java 以外のクライアントを Jepsen に組み込めるかは未検証で、しばらく Java だけの検証になる。

## Confirmation

- CI：日次の Jepsen と Streams の試験の結果を、`main` の状態として見せる。失敗が続く間は、本家の版の更新の PR をマージできない。
- 四半期ごとに、KAFKA-17582 などの既知の問題の状態を確かめ、利用者向けの文書を更新する。

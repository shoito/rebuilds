---
status: accepted
date: 2026-09-27
---

# ADR-0020: ディスクレスのトピックは、本家が冪等とトランザクションに対応してから、別の種類のトピックとして出す

詳細は [tiered-and-object-storage.md](../architecture/tiered-and-object-storage.md) の 8 節。

## Context

- [ADR-0002](0002-replicated-log-with-tiered-storage.md) は、ディスクレスのトピックを S2 で別の種類として足し、本家の KIP-1150 の実装が本家に入っていればそれを使うとした。自前で作る場合も、冪等なプロデューサーとトランザクションを捨てないことを前提にした。
- 本家の状況（2026-09-27 に確認）：
  - KIP-1150 は 2026-03-02 に採択。要求として、順序、冪等、トランザクション、グループ、共有のグループ、階層型の保存との互換を挙げる（[KIP-1150](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1150%3A+Diskless+Topics)、[Aiven の解説](https://aiven.io/blog/kip-1150-accepted-and-the-road-ahead)）。
  - KIP-1163（中核）は議論中。トピックの設定 `diskless.enable`（作成時だけ）。WAL のオブジェクトを約 250ms か約 4 MiB で閉じる案。遅延の目標は p50 約 500ms、p99 1〜2 秒。最初の版は、圧縮のトピックとトランザクションに対応しない（[KIP-1163](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1163%3A+Diskless+Core)）。
  - KIP-1164（コーディネーター）は議論中。`__diskless_metadata` を正本にする。冪等の検査は含むが、トランザクションの管理は範囲の外（[KIP-1164](https://cwiki.apache.org/confluence/display/KAFKA/KIP-1164%3A+Diskless+Coordinator)）。
- 費用の概算（東京、4 MiB の WAL、3 AZ、7 日の保持）：ネットワークと S3 で、Standard のトピックの約 $0.059/GB に対し、ディスクレスは約 $0.008/GB。ただし、ブローカー 1 台あたり月に約 $49 の、流量によらない PUT の費用がある。KIP の案の値による概算で、未検証（E13 の `diskless-upstream-tracking` で、本家の実装が入ったら測り直す）。
- 利用者の中心の用途（注文・決済の状態の変化）はトランザクションを使う（intent.md）。

## Options

1. **本家の版に KIP-1163・1164 が入り、冪等とトランザクションに対応してから出す**
2. 本家の最初の版（トランザクションなし）で、トランザクションの書き込みを拒否する種類として出す
3. 自前で作る（Aiven の Inkless などを土台にする）

## Decision

1 を採用する。

- 本家の版に入った後、耐久性（Jepsen の形。[ADR-0022](0022-exactly-once-verification.md) の枠）と互換性の行列を通してから、別の種類のトピックとして出す。
- 遅延の目標は別に置く（p99 1 秒以内を仮の値にし、本家の実装で測って決め直す）。料金は Standard のトピックと別の単価にする。
- 既存のトピックの変換は出さない（本家も作成時だけ）。
- 2 を選ばない理由：同じクラスタの中で、トピックの種類によってトランザクションが使えたり使えなかったりすると、Kafka Streams などの既存のアプリが「変更なしで動く」（intent.md）を満たさない。[ADR-0002](0002-replicated-log-with-tiered-storage.md) の前提（意味を緩めない）にも反する。
- 3 を選ばない理由：[ADR-0001](0001-upstream-brokers-and-stack.md) の方針（本家の実装を使う）に反し、fork への依存を増やす。
- S2 の開始の時点で本家に入っていない、または入ってもトランザクションに対応していないときは、この ADR を見直す。そのとき、2 を「トランザクションを使わない取り込みの用途に限った先行の提供」として、PM と改めて比べる。

## Consequences

- 良くなること：
  - 意味の違うトピックの種類を作らない。耐久性とトランザクションの正しさを、本家の検証に乗せられる。
- 引き受けるコスト：
  - AZ をまたぐ転送の費用（NFR-010 の最大の項目）を下げる時期が、本家の進み具合に依存する。
  - WarpStream、AutoMQ、Redpanda の Cloud Topics に、費用で劣る期間が続く。

## Confirmation

- 四半期ごとに、KIP-1163・1164（と関連する KIP）の状態と本家の版への取り込みを確かめ、tiered-and-object-storage.md の 8.1 節を更新する。
- 提供の前に、ディスクレスのトピックで、Jepsen の形のトランザクションのワークロードと、Kafka Streams の exactly-once の試験が通る。

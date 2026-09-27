---
status: accepted
date: 2026-09-27
---

# ADR-0050: ブローカーのローリング更新は AZ の順に 1 台ずつ、パーティションの安全の関門で止め、本家の版の取り込みは差分テスト・Jepsen・Streams の長時間の試験を通してから行う

詳細は [delivery.md](../architecture/delivery.md) の 5〜7 節と [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。

## Context

- 本家の手順は、ブローカーを 1 台ずつ止めて新しいコードで起動し、全てが新しい版になり振る舞いを確かめてから `kafka-features.sh upgrade --release-version` で `metadata.version` を上げる。4.3 はメタデータの変更を含むので、上げた後の戻しはできない（[Upgrading](https://kafka.apache.org/43/getting-started/upgrade/)、2026-09-27 に確認）。
- Kora は、AZ の順にロールし、2 つの AZ のブローカーを同時にロールしない。ロールしたブローカーが複製の面で完全に戻ったことを確かめてから、次の組に進む。小さなクラスタでは 1 台ずつ（[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.7 節、2026-09-27 に確認）。
- Strimzi の KafkaRoller は、再起動でパーティションが `min.insync.replicas` を下回るときはロールしない。ちょうど `min.insync.replicas` になるロールは許す（[strimzi-kafka-operator#13031](https://github.com/strimzi/strimzi-kafka-operator/issues/13031)、2026-09-27 に確認。閉じられた提案で、余裕を持たせる設定は入っていない）。ELR を有効にした構成で `min.insync.replicas` を変えると再起動が止まらない不具合の報告がある（[#11685](https://github.com/strimzi/strimzi-kafka-operator/issues/11685)。2025-08-17 に修正で閉じられた。本家も、ELR を有効にした間はブローカーの単位の `min.insync.replicas` の変更を拒否する。2026-09-27 に確認）。
- 本家の取り込みは x.y.1 以降、x.y.0 から 3 か月以内。機能の版は全ての物理クラスタでバイナリが揃ってから 7 日後（[ADR-0008](0008-client-matrix-differential-tests-and-version-tracking.md)）。本家の版の更新は、Jepsen の形の試験と Kafka Streams の exactly-once の試験を関門にする（[ADR-0022](0022-exactly-once-verification.md)）。本家の版を 2 つ以上遅らせない（[ADR-0001](0001-upstream-brokers-and-stack.md)）。

## Options

ロールの順：

1. **AZ の順に、AZ の中は 1 台ずつ。各台の後に物理クラスタ全体の関門を確かめる。AZ の間に 30 分の待ちを置く**
2. Strimzi の既定の順に任せる（関門は KafkaRoller の `min.insync.replicas` の確認だけ）
3. AZ ごとに、AZ の中の全ブローカーを同時にロールする

## Decision

1 を採用する。

### 関門（次のブローカーへ進む条件）

| # | 条件 |
| --- | --- |
| G1 | URP が 0、`UnderMinIsrPartitionCount` が 0、オフラインのパーティションが 0 |
| G2 | ロールしたブローカーが登録され（fenced でない）、全ての複製が ISR に戻っている |
| G3 | 優先リーダーに戻っている（リーダーの偏りが 10% 以内） |
| G4 | カナリア（AUD-7）に抜けがない。合成監視の produce・consume が成功している |
| G5 | そのブローカーの produce の p99 が、ロールの前の 1.2 倍以内で 5 分続く |
| G6 | 再配置・降格・コントローラーの入れ替えが進んでいない |
| G7 | KRaft の投票者が全て健全で、遅れが 0（コントローラーのロールのとき） |

- 関門を 30 分満たせなければ、ロールを止めて人を呼ぶ。自動で戻さない（戻すロールも同じ関門を通るため）。
- ロールの前の条件：G1・G6・G7、直近の耐久性の監査に不一致がない、エラーの予算が残っている。
- 順：コントローラー（1 台ずつ）→ ブローカー（AZ の順、AZ の中は 1 台ずつ）。
- Strimzi に任せる部分と、この順と関門を強制する部分（rolling-update-guard）の分け方は、E1・E12 で確かめる（`strimzi.io/pause-reconciliation` は資源の変更の調停を止める。ロールの途中を止められるかは文書になく未検証で、E1 の `strimzi-roll-control-poc` で確かめる）。

### 本家の版の取り込みの関門

| 関門 | 中身 |
| --- | --- |
| U1 | パッチの列が当たり、名前空間の表と API の表が新しい ApiVersions に合う |
| U2 | 差分テスト（全ての API と版、複数のシード）と、クライアントの行列の全体 |
| U3 | Jepsen の形の queue と txn（全ての障害）。本家との同じシードの比較で、自社だけの異常が 0 |
| U4 | Kafka Streams の exactly-once の 6 時間の試験（重複・欠落 0） |
| U5 | 検証の物理クラスタで、負荷をかけたままのロール（旧 → 新 → 旧）で `acks=all` の喪失 0 |
| U6 | 性能の回帰：produce の p99 とスループットが前の版から 10% 以上悪くならない |
| U7 | staging の物理クラスタで 7 日、耐久性の監査に不一致がない |

- 本番の順：Basic の物理クラスタ → Standard の最初の 1 つ（カナリア）→ 残りの Standard。各物理クラスタの後に 24 時間。
- `metadata.version` は、全ての物理クラスタでバイナリが揃ってから 7 日後に上げる。上げるまでは、バイナリの戻しができる。上げた後は戻さず、前へ直す。
- 2 を選ばない理由：Strimzi は ISR が `min.insync.replicas` ちょうどになるロールを許し、AZ の順も保証しない。ロールの途中にもう 1 台が落ちると、書き込みが止まる。
- 3 を選ばない理由：Kora は AZ の中の並行のロールを許すが、S1 の物理クラスタは小さく、1 つの AZ の全台を止めると、残りの 2 つの AZ の負荷が上がる。台数が増えたら（1 AZ に 20 台以上）、AZ の中で 2 台ずつにする案を検討する。

## Consequences

- 良くなること：
  - ロールの途中のどの時点でも、ISR が 2 未満のパーティションができない（1 つの AZ の 1 台だけが止まる）。
  - 本家の版の取り込みの関門が、耐久性と互換性の試験の結果と結び付く。
- 引き受けるコスト：
  - 30 台の物理クラスタのロールは、1 台 5〜10 分として 3〜5 時間かかる（未検証。E12 の `load-test-ga` の T8 で測る）。平日の時間帯に収めるため、AZ ごとに日を分けてよい。
  - rolling-update-guard を自前で保つ。

## Confirmation

- 障害注入（[replication-and-durability.md](../architecture/replication-and-durability.md) の 8.3 節）：ロールの途中に別のブローカーを止めても、`acks=all` の喪失が 0。関門が次のロールを止める。
- 記録：`broker_rollouts` と `rollout_gate_results` に、各台の関門の結果と時刻を残す。
- 監視：本家の最新のマイナー版からの遅れ（日数）。3 か月を超えたらアラート（ADR-0008）。

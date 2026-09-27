# Runbook: デプロイとロールバック（ブローカーのローリング更新）

- Owner: Ops
- 対応するアラート: ロールの関門で停止（rolling-update-guard が 30 分進めない）、ロールの間の合成監視の失敗、本家の版の遅れ（x.y.0 から 3 か月）
- 最終確認日: 2026-09-27

流れは [delivery.md](../architecture/delivery.md) の 5〜7 節、関門と順は [ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md)、成果物は [ADR-0049](../decisions/0049-build-pipelines-artifacts-and-flags.md) にある。制御面（ECS）のデプロイは他の題材と同じ blue/green で、この手順では扱わない。

## 症状

次のときに使う。

- ブローカーを再起動する変更を本番へ入れるとき：本家の版、パッチ、プラグイン、静的な設定、JVM、証明書の更新、ノードの AMI、EKS の版、Strimzi の版
- ロールの途中で、関門（G1〜G7）が 30 分満たされず、rolling-update-guard が止まったとき
- ロールの後に、遅延・エラー・監査の悪化が出たとき

## 影響

- 通常のロール：利用者への影響は小さい。1 台ずつ止めるので、そのブローカーがリーダーのパーティションは、制御された停止でリーダーが移る。クライアントは `NOT_LEADER_OR_FOLLOWER` の後にメタデータを取り直して続ける。
- 1 台が止まっている間、そのブローカーの複製を持つパーティションの ISR は 2。この間にもう 1 台（別の AZ）が落ちると、そのパーティションは `acks=all` の書き込みを受けられない（耐久性を優先。[replication-and-durability.md](../architecture/replication-and-durability.md) の 3.2 節）。関門 G1 で、ISR が 3 に戻ってから次へ進むのはこのため。
- 失敗したロール：produce の遅延（NFR-003）と可用性の予算を消費する。`metadata.version` を上げた後は、バイナリを戻せない。

## 確認

### ロールの前

1. 対象のイメージの digest が、dp-staging で 7 日、耐久性の監査の不一致なしに動いている（本家の版の更新なら U1〜U7 の結果が `upstream_releases` と PR にある）。
2. イメージの署名と SBOM がある（EKS の受け入れの制御が拒否しないこと）。
3. 対象の物理クラスタで：
   - URP 0、`UnderMinIsrPartitionCount` 0、オフライン 0（G1）
   - 再配置・降格・コントローラーの入れ替えが進んでいない（G6）
   - KRaft の投票者が全て健全、遅れ 0（G7）
   - 直近の耐久性の監査（AUD-1〜7）に不一致がない
   - エラーの予算が残っている（[observability.md](../architecture/observability.md) の 7.2 節）
   - ディスクの使用率が 70% 未満（再起動の間、他のブローカーのディスクが増える）
4. 時間帯：平日 10〜16 時に始める。月末・月初の 2 営業日と凍結の期間は修正だけ。
5. 他の物理クラスタで、ロールが進んでいない（同時にロールする物理クラスタは 1 つ）。
6. `broker_rollouts` に計画の行を作り、種類・前後の digest・承認者を書く。

### ロールの間（ブローカーごと）

| 関門 | 見るもの | 正常 |
| --- | --- | --- |
| G1 | 物理クラスタのダッシュボード | URP 0、min ISR を下回るパーティション 0、オフライン 0 |
| G2 | エージェントの表示（`broker_states`） | ロールしたブローカーが unfenced、全ての複製が ISR |
| G3 | リーダーの偏り | 10% 以内 |
| G4 | 合成監視、カナリア | そのブローカーの produce・consume が成功、カナリアの抜けなし |
| G5 | そのブローカーの produce の p99 | ロールの前の 1.2 倍以内で 5 分 |
| G6・G7 | 上と同じ | — |

## 対処

### A. 通常のロール

1. gitops の PR（`spec.kafka.image` の digest、または設定）を Ops が承認する（作成者と別の人）。本家の版の更新は、Strimzi の版の更新と同じ PR。
2. rolling-update-guard が `rollout.pause` を外し、順に進める（[delivery.md](../architecture/delivery.md) の 6.1 節）：
   1. コントローラーを 1 台ずつ。投票者の遅れが 0 に戻ってから次。
   2. ブローカーを AZ の順に、AZ の中は 1 台ずつ。各台の後に G1〜G6 を待つ。
   3. AZ が終わったら 30 分待つ。
3. 物理クラスタの全台が終わったら、24 時間、物理クラスタのダッシュボードと SLO を見る。
4. 次の物理クラスタへ（Basic → Standard のカナリア → 残りの Standard）。
5. `broker_rollouts` を `done` にする。

### B. 関門で止まったとき

1. rolling-update-guard が止まっていることを確かめる（`rollout.pause` が立っている、Strimzi が次の Pod を再起動していない）。**次のブローカーを手で再起動しない。**
2. どの関門かを `rollout_gate_results` で見る。

| 止まった関門 | よくある原因 | 動き |
| --- | --- | --- |
| G1・G2（ISR が戻らない） | 起動の遅れ（ログの回復、メタデータの読み込み）、フォロワーの追いつきの遅れ、ディスクの逼迫 | 起動のログで回復の進みを見る。回復が長いなら待つ（目標 5 分。[ADR-0011](../decisions/0011-log-recovery-and-broker-replacement.md)）。30 分を超えるなら、C の戻しを判断する |
| G1（別のブローカーの URP） | ロールと関係のない障害（別のブローカーの劣化、AZ の不調） | [incident-response.md](incident-response.md) に移る。ロールは止めたまま |
| G3（リーダーが戻らない） | 自動のリーダーの再均衡が効いていない、降格の残り | `ElectLeaders`（PREFERRED）をエージェントから実行する。降格の状態を確かめる |
| G4（合成監視・カナリア） | 新しい版の不具合、エッジの不調 | カナリアの抜けなら直ちに [incident-response.md](incident-response.md) の「耐久性の監査の不一致」。合成監視の失敗なら、そのブローカーだけか全体かを見る |
| G5（遅延） | 新しい版の性能の回帰、ページキャッシュが空（起動の直後） | 15 分待って戻らなければ C |

3. 原因を取り除いたら、`rollout.pause` を外して続ける。

### C. ロールバック

1. **`metadata.version`（機能の版）を上げたかを確かめる。** 上げた後なら、バイナリを戻さない。前へ直す（修正のパッチか、本家のパッチ版）。インシデントとして扱う。
2. 上げる前なら、1 つ前のイメージの digest で gitops の PR を出す。**戻しのロールも A と同じ関門で進める。** 急ぐために関門を外さない。
3. 戻すのは、そのロールで新しいイメージになったブローカーだけ（Strimzi は、digest の違う Pod だけを再起動する）。
4. パッチ・プラグインだけの変更なら、いつでも戻せる。
5. `broker_rollouts` を `rolled_back` にし、理由を書く。

### D. 本家の版の取り込み（`metadata.version` まで）

1. 本家の x.y.1 以降が出たら、`upstream.lock` の PR（[delivery.md](../architecture/delivery.md) の 7 節）。U1〜U6 が通ってからマージする。
2. dp-staging で 7 日（U7）。
3. A の順で全ての物理クラスタをロールする。
4. 全ての物理クラスタでバイナリが揃ってから 7 日、SLO と監査に問題がないことを確かめる。
5. `metadata.version` を上げる（エージェントから `UpdateFeatures`。本家の `kafka-features.sh upgrade --release-version` と同じ。[Upgrading](https://kafka.apache.org/43/getting-started/upgrade/)）。物理クラスタごとに、Basic → Standard のカナリア → 残り、各 24 時間。
6. `upstream_releases` に、物理クラスタごとの適用の時刻を書く。

### E. ブローカー以外の再起動を伴う変更

- 証明書の更新、ノードの AMI、EKS の版：A と同じ関門で進める。ノードの入れ替えは Drain Cleaner が Kubernetes の退避を止め、Strimzi のロールに任せる（[control-plane-and-provisioning.md](../architecture/control-plane-and-provisioning.md) の 8.1 節）。
- Envoy：AZ ごとに 1 台ずつ、NLB の登録の解除（300 秒の排出）の後に入れ替える。1 つの AZ が終わったら 30 分待つ（[delivery.md](../architecture/delivery.md) の 5 節）。

## エスカレーション

- 関門で 30 分止まり、原因が分からない → Dev のテックリードを呼ぶ。
- ロールの間にカナリアの抜け、監査の不一致、`acks=all` の失敗の急増 → SEV1。[incident-response.md](incident-response.md) に移り、同じ物理クラスタへの変更を全て止める（`rollout.pause`）。
- `metadata.version` を上げた後の不具合 → SEV2 以上。Dev のテックリードと、本家への報告の要否を判断する。
- 本家の版の遅れが 3 か月を超えそう → Dev のテックリードに、x.y.0 に修正を当てて入れるかの判断を求める（[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md)）。

## 事後

- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- 関門で見つけた問題を、U1〜U7（dp-verify の試験）で先に見つけられなかったかを QA と見直し、試験を足す。
- ロールの時間（物理クラスタごと）と止まった回数を quality.md の指標に記録する。
- この手順で足りなかったことを、ここに反映する。

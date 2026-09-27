# Delivery: Kafka

ブランチ、CI、成果物、デプロイ、ブローカーのローリング更新、本家の版の追従とパッチの当て直し、フィーチャーフラグの設計。ブランチモデルはリポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)（トランクベース開発）。決定は [ADR-0049](../decisions/0049-build-pipelines-artifacts-and-flags.md)（ビルド・成果物・フラグ）と [ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md)（ローリング更新の関門と本家の版の追従）。

| 対象 | 方針 |
| --- | --- |
| ブランチモデル | リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md) |
| 互換性と耐久性の試験の中身 | [ADR-0005](../decisions/0005-compatibility-policy.md)、[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md)、[ADR-0014](../decisions/0014-durability-audit-and-fault-injection.md)、[ADR-0022](../decisions/0022-exactly-once-verification.md) |
| ビルド、成果物、署名、フラグ | [ADR-0049](../decisions/0049-build-pipelines-artifacts-and-flags.md) |
| ローリング更新、本家の版の取り込み | [ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md) |
| 手順 | [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |

原則は 3 つ。

- **`main` は常にデプロイできる状態に保つ。** 未完成の振る舞いは release フラグの裏に置く。
- **デプロイとリリースを分ける。** デプロイは Ops が承認し、リリースは PM が判断する。
- **ブローカーを止める変更は、パーティションの安全の関門で 1 台ずつ進める。** 関門を満たさなければ止まり、人を呼ぶ。

本家と Strimzi の振る舞いは、2026-09-27 に公式の文書とリポジトリで確かめた。確かめられなかったものは「未検証」と書く。

## 1. リポジトリと成果物

開発リポジトリは 1 つ（モノレポ）。言語ごとに領域を分け、エージェントの作業が 1 つの言語に収まるようにする（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md) の Consequences）。

| パス | 言語 | 成果物 | コードオーナー |
| --- | --- | --- | --- |
| `broker/`（`upstream.lock`、`patches/`、`plugins/`） | Java 21 | ブローカーのコンテナのイメージ | Dev のテックリード（`durability:sensitive`・`security:sensitive` の既定） |
| `dataplane/agent`、`dataplane/quota-coordinator`、`dataplane/canary` | Java 21 | コンテナ | データ面のオーナー |
| `edge/sni-router`、`edge/envoy`（設定の雛形） | Go、YAML | コンテナ | エッジのオーナー |
| `controlplane/`（api、internal-api、relay、usage、billing） | TypeScript | コンテナ（ECS） | 制御面のオーナー |
| `console/` | TypeScript（React） | 静的のファイル | 同上 |
| `cli/`、`terraform-provider/`、`sdk/go/` | Go | バイナリ、Terraform Registry | CLI のオーナー |
| `infra/` | Terraform | — | Ops |
| `gitops/`（Strimzi の CR、Argo CD のアプリ） | YAML | — | Ops ＋ データ面のオーナー |
| `verify/`（Jepsen の Clojure、差分テストの送り手、OMB の設定） | Clojure、Java | — | QA ＋ Dev のテックリード |

- GitHub のルールセットで、`broker/patches/`・`broker/plugins/` の名前空間・認可・認証・複製・階層型の保存に関わるパスへの変更に、Dev のテックリードの承認を必須にする。エージェントは PR を作れるが承認しない（[AGENTS.md](../../AGENTS.md)）。

## 2. 変更からマージまで

```
changes/YYMMDD-<slug>/ の spec・plan が承認済み
   ▼
ブランチ kafka/YYMMDD-<slug>（エージェントは worktree ごとに 1 本）
   ▼
PR ─▶ PR の CI（3 節）─▶ レビュー（CODEOWNERS、作成者と別の人）
   ▼
merge queue ─▶ squash で main へ ─▶ 1 回ビルド（4 節）─▶ 昇格（5 節）
```

- PR の説明に、変更フォルダ、規模、使うフラグ、ラベル（`durability:sensitive`・`security:sensitive`・`protocol`）、ブローカーの再起動を要するかを書く。

## 3. CI

### 3.1 PR の CI

| 対象 | 段 | 失敗の条件 | 目標の時間 |
| --- | --- | --- | --- |
| 全て | lint、型、単体、秘密の走査（`<brand>_sec_` の形とレコードの断片がログ・スナップショットにない） | 1 件でも | — |
| ブローカー | パッチの列が `upstream.lock` のタグに当たる。パッチの行数と対象のファイルの出力（増えたら PR に理由） | 当たらない | 30 分 |
| ブローカー | プラグインの単体と性質ベーステスト（jqwik）：名前空間の往復、他のテナントが見えない、ACL の変換、クォータの配分 | 1 件でも | |
| ブローカー | 名前空間の表・API の表が、本家の ApiVersions の全ての (API, 版) を持つ（[ADR-0006](../decisions/0006-api-exposure-table-and-denial.md)） | 抜け | |
| ブローカー | 差分テスト（代表の列、1 シード）、クライアントの行列（代表の操作）（[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md)） | 許された違いの表にない違い | |
| ブローカー（`durability:sensitive`） | Jepsen の形の部分集合 1 時間（[ADR-0014](../decisions/0014-durability-audit-and-fault-injection.md)） | `lost-write` などが 1 件でも | 90 分 |
| ブローカー（`protocol`） | 行列の全体（その PR のクライアントの範囲） | 失敗 | |
| エージェント・コーディネーター | 調停の性質ベーステスト、契約テスト（制御面の Zod から作った型で読める） | 1 件でも | 20 分 |
| sni-router | SNI → 上流の解決の表駆動テスト、制御面の停止の間も最後の写しで答える | 1 件でも | 10 分 |
| 制御面 | 他の題材と同じ（OpenAPI の壊す変更の検査、冪等の決定表、マイグレーションの expand・contract の検査） | — | 20 分 |
| CLI・プロバイダー | 単体、生成した SDK が OpenAPI と一致、プロバイダーの代表の受け入れのテスト（staging） | — | 20 分 |
| infra | `terraform validate`・`plan`、[infrastructure.md](infrastructure.md) の 9 節の検査 | 違反 | 10 分 |
| gitops | Strimzi の CRD のスキーマの検証。Topic Operator・User Operator が無効（[ADR-0032](../decisions/0032-strimzi-for-physical-clusters.md)） | 違反 | 5 分 |
| アラートの規則 | runbook の URL がある（[ADR-0047](../decisions/0047-slos-synthetic-probes-and-alerts.md)） | ない規則 | 1 分 |

### 3.2 日次・週次

| 頻度 | 中身 |
| --- | --- |
| 日次 | 差分テストの全体（全ての API と版、複数のシード）、クライアントの行列の全体、Jepsen の形の queue と txn（全ての障害）、Kafka Streams の exactly-once の 6 時間の試験、耐久性の監査の自己検査、パッチの列の本家の `trunk` と最新の RC への当たり |
| 週次 | うるさい隣人の試験 N1〜N10（各 1 時間）、負荷試験の回帰（T1・T3 の縮小版。[capacity.md](capacity.md) の 11 節） |

- 日次の失敗は、次の `durability:sensitive`・`protocol` の PR をマージする前に直すか、Issue にして Dev のテックリードの判断を受ける（[ADR-0005](../decisions/0005-compatibility-policy.md)）。日次が 2 日続けて失敗している間は、本番へのブローカーの昇格と release フラグの拡大を止める。

## 4. ビルドと成果物

[ADR-0049](../decisions/0049-build-pipelines-artifacts-and-flags.md)。

### 4.1 ブローカーのイメージ

```
upstream.lock（本家のタグとコミット、例 4.3.1）
  └─ git clone → patches/0001-… 〜 000N-… を git am
       └─ Gradle でビルド（Java 21）→ 本家の jar
plugins/（Gradle のモジュール）→ プラグインの jar
       ▼
FROM <Strimzi の同じ版の Kafka のイメージ>@sha256:…
  └─ 本家の jar を置き換え、プラグインの jar を足す、OpenTelemetry の Java エージェントを足す
       ▼
イメージ：<ecr>/broker:<本家の版>-<パッチの列の短いハッシュ>-<コミット>
```

- 各パッチの先頭に、理由、関連する KIP、ADR、パッチの番号（P1〜P7。[multi-tenancy-and-quotas.md](multi-tenancy-and-quotas.md) の 4.5 節）を書く。
- Strimzi の Kafka のイメージは UBI 9 に Java 21（`java-21-openjdk-headless`）を入れた基のイメージの上に作られる（[docker-images/base/Dockerfile](https://github.com/strimzi/strimzi-kafka-operator/blob/main/docker-images/base/Dockerfile)、2026-09-27 に確認）。本システムの拡張とパッチも Java 21 でビルドするので合う。Strimzi が基の Java を上げたときは、`broker-build-pipeline` の CI で版の食い違いを止める。
- パッチなしの参照のブローカー（差分テストの参照側）も、同じ `upstream.lock` から同時にビルドする。

### 4.2 署名と来歴

- 全ての成果物（コンテナ、CLI、プロバイダー）に cosign の署名、SBOM（SPDX）、SLSA の provenance を付ける。基のイメージは digest で固定する。
- EKS は、署名のないイメージを受け入れない（受け入れの制御の道具は E12 で選ぶ）。署名の検証は、ビルドの OIDC の主体（このリポジトリの `main` のワークフロー）に絞る。
- 依存の脆弱性の走査（イメージ、Go、npm、Gradle）を PR とビルドで行う。本家の CVE は、重大なもの（リモートから悪用できるもの）を 72 時間以内、他を 30 日以内に取り込む（[protocol-and-compatibility.md](protocol-and-compatibility.md) の 8.1 節）。
- 1 回ビルドして、同じ digest を環境へ昇格させる。

### 4.3 CLI と Terraform のプロバイダー

- タグ（semver）で、GoReleaser のワークフローがビルドする。CLI は GitHub の Releases・Homebrew・`.deb`・`.rpm`、macOS の公証。プロバイダーは Terraform Registry に GPG の署名で公開する（[ADR-0036](../decisions/0036-cli-and-terraform-provider.md)）。
- 公開の前に、staging に対するプロバイダーの全資源の受け入れのテストと、CLI の E2E を通す。
- 戻し：公開した版は取り消さず、修正版を出す。重大な不具合の版は、Registry と Homebrew で非推奨にし、利用者に知らせる（`cli-release.md`・`terraform-provider-release.md`、console-and-api の提案）。

## 5. 環境と昇格

```
制御面：main ─▶ cp-dev（自動）─▶ cp-staging（自動、E2E）─▶ cp-prod（Ops の承認）
データ面の部品（エージェント、コーディネーター、sni-router、Envoy）：
        main ─▶ dp-dev ─▶ dp-staging ─▶ dp-prod の 1 つの物理クラスタ ─▶ 残り（Argo CD、Ops の承認）
ブローカー：main ─▶ dp-dev ─▶ dp-staging ─▶ dp-verify（U1〜U6）─▶ dp-prod（6 節の順）
```

- 本番のデプロイの時間帯は平日 10〜17 時（JST）。ブローカーのロールは 10〜16 時に始め、関門で止まったら翌日に持ち越してよい。月末・月初の 2 営業日（請求の締め）と年末年始は、修正以外のデプロイをしない。
- エラーの予算を使い切った物理クラスタには、修正以外を入れない（[observability.md](observability.md) の 7.2 節）。

| 部品 | 方式 |
| --- | --- |
| 制御面（ECS） | 他の題材と同じ blue/green のカナリア（10% → 100%）、アラームで自動の戻し。マイグレーションは expand → 移行 → contract |
| エージェント | 物理クラスタごと。2 つのレプリカの副から入れ替え、Lease の主の交代を確かめる。調停の反映の遅れと命令の失敗の率を 15 分見る |
| クォータのコーディネーター | 物理クラスタごと。3 つを 1 つずつ。止まっても静的な等分に戻るだけ（[ADR-0027](../decisions/0027-dynamic-quota-coordinator-and-backpressure.md)） |
| sni-router | AZ ごとに。xDS の設定の差（クラスタの数、未知の SNI の数）を 15 分見る |
| Envoy | AZ ごとに 1 台ずつ。NLB の登録の解除（300 秒の排出）の後に入れ替える。1 つの AZ が終わったら 30 分待つ |
| Strimzi | 本家の版の取り込みと同じ PR で上げる（[ADR-0032](../decisions/0032-strimzi-for-physical-clusters.md)）。Strimzi の更新はブローカーのロールを起こしうるので、6 節の関門に従う |
| ブローカー（本家の版・パッチ・プラグイン・設定の再起動を要する変更） | 6 節 |
| ブローカー（動的な設定） | データ面のエージェントが望ましい状態から反映する。ロールしない |

## 6. ブローカーのローリング更新

[ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md)。手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。

### 6.1 順

```
1. 始める前の条件（6.2 節の G1・G6・G7 と、監査・予算）
2. コントローラー：1 台ずつ（投票者の遅れが 0 に戻ってから次）
3. ブローカー：AZ の順（例 apne1-az1 → az2 → az4）
     AZ の中は 1 台ずつ：再起動 → G1〜G6 を満たすまで待つ → 次
     AZ が終わったら 30 分待ち、合成監視と監査の事象を確かめる
4. 物理クラスタの全台が終わったら 24 時間おいて、次の物理クラスタ
```

- 本家の手順（1 台ずつ止めて新しいコードで起動し、全てが新しい版になってから `metadata.version` を上げる。[Upgrading](https://kafka.apache.org/43/getting-started/upgrade/)、2026-09-27 に確認）と、Kora の AZ の順のロール（2 つの AZ のブローカーを同時にロールしない。[Kora](https://vldb.org/pvldb/vol16/p3822-povzner.pdf) の 4.7 節）に倣う。
- 本家の制御された停止（`controlled.shutdown.enable=true`）で、止める前にリーダーを移す。再起動は同じ ID・同じボリューム（[broker-and-log-storage.md](broker-and-log-storage.md) の 6.1 節）。

### 6.2 関門

| # | 条件 | 見るもの |
| --- | --- | --- |
| G1 | URP 0、`UnderMinIsrPartitionCount` 0、オフライン 0 | JMX（15 秒の系列） |
| G2 | ロールしたブローカーが登録され、全ての複製が ISR に戻っている | KRaft のメタデータ（エージェント） |
| G3 | 優先リーダーに戻っている（リーダーの偏り 10% 以内） | 同上 |
| G4 | カナリアに抜けがない。そのブローカーの合成の produce・consume が成功 | [observability.md](observability.md) の 6 節 |
| G5 | そのブローカーの produce の p99 が、ロールの前の 1.2 倍以内で 5 分続く | 同上 |
| G6 | 再配置・降格・コントローラーの入れ替えが進んでいない | `reassignment_jobs`、`broker_states` |
| G7 | KRaft の投票者が全て健全、遅れ 0（コントローラーのロール） | 同上 |

- 関門を 30 分満たせなければ止めて人を呼ぶ。自動で戻さない。
- Strimzi の KafkaRoller は、再起動でパーティションが `min.insync.replicas` を下回るときはロールしないが、ちょうど `min.insync.replicas`（ISR 2）になるロールは許す（[strimzi-kafka-operator#13031](https://github.com/strimzi/strimzi-kafka-operator/issues/13031)、2026-09-27 に確認）。G1 は、全ての ISR が 3 に戻ってから次へ進めるので、KafkaRoller より厳しい。
- **rolling-update-guard**（データ面のエージェントの責務）が関門を見て、満たさない間は Strimzi のロールを止める。Strimzi の一時停止の注釈（`strimzi.io/pause-reconciliation`）は、付けている間は資源の変更を調停しない（[Strimzi の文書](https://strimzi.io/docs/operators/latest/deploying.html)、2026-09-27 に確認）。ロールの途中を止められるか、AZ の順を強制できるかは文書に書かれておらず、未検証（E1 の `strimzi-roll-control-poc`）。できなければ、AZ ごとのノードプールに `strimzi.io/manual-rolling-update` の注釈を順に付ける形などを E1 で比べる。
- ELR を有効にした構成で、`min.insync.replicas` を変えると Strimzi の再起動が止まらない不具合の報告がある（[#11685](https://github.com/strimzi/strimzi-kafka-operator/issues/11685)。2025-08-17 に修正で閉じられた。本家も、ELR を有効にした間はブローカーの単位の `min.insync.replicas` の変更を拒否する。2026-09-27 に確認）。`min.insync.replicas` は固定（[ADR-0012](../decisions/0012-durability-settings-and-elr.md)）なので当たらない見込みだが、Strimzi の版を上げるたびに確かめる。

### 6.3 戻し

| 変更 | 戻し方 |
| --- | --- |
| パッチ・プラグイン・設定だけ（本家の版は同じ） | 1 つ前のイメージの digest で、同じ関門でロールする |
| 本家の版の更新（`metadata.version` を上げる前） | 1 つ前の本家の版のイメージで、同じ関門でロールする。本家は、間にメタデータの変更がない版にだけ戻せる（[Upgrading](https://kafka.apache.org/43/getting-started/upgrade/)）。上げる前なら、メタデータは古い版のまま |
| `metadata.version` を上げた後 | 戻さない。前へ直す（修正のパッチ、または本家のパッチ版） |

- だから `metadata.version` は、全ての物理クラスタでバイナリが揃ってから 7 日後に上げる（[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md)）。上げるのも物理クラスタごとに、Basic → Standard のカナリア → 残り。
- `kraft.version`、`transaction.version`、`group.version` などの機能の版も同じ扱い（戻せないものがある）。共有のグループ・Streams のグループの機能の版は、[ADR-0024](../decisions/0024-share-and-streams-groups-staging.md) の条件を満たしてから、runbook で上げる。

### 6.4 時間

- 30 台の物理クラスタで、1 台 5〜10 分（制御された停止、起動、ISR への戻り）として 3〜5 時間（未検証。E12 の `load-test-ga` の T8 で測る。[capacity.md](capacity.md) の 11 節）。起動の時間はログの回復（正しい停止なら飛ばす）とメタデータの読み込み（目標 30 秒）で決まる。
- 1 つの AZ に 20 台を超えたら、AZ の中で 2 台ずつにする案を検討する（Kora は大きなクラスタで AZ の中の数台を並べる）。

## 7. 本家の版の追従

[ADR-0008](../decisions/0008-client-matrix-differential-tests-and-version-tracking.md)、[ADR-0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md)。

### 7.1 流れ

```
本家の RC が出る
   └─ 夜間：パッチの列の当たり、差分テスト・行列・Jepsen（RC に対して）
本家の x.y.1 が出る（x.y.0 は本番に入れない）
   └─ upstream.lock を上げる PR（Strimzi の版も同じ PR）
        U1 パッチの当て直し、名前空間の表と API の表の更新
        U2 差分テストの全体、行列の全体
        U3 Jepsen の queue と txn の全体（本家との同じシードの比較）
        U4 Kafka Streams の exactly-once の 6 時間
        U5 dp-verify で、負荷をかけたままのロール（旧 → 新 → 旧）
        U6 性能の回帰（10% 以内）
   └─ マージ → dp-staging の物理クラスタで 7 日（U7：監査の不一致 0）
   └─ 本番：Basic → Standard のカナリアの物理クラスタ → 残りの Standard（6 節）
   └─ 全ての物理クラスタで揃ってから 7 日 → metadata.version を上げる
```

- 期限：x.y.0 から 3 か月以内に全ての物理クラスタへ。x.y.1 が 3 か月出なければ、Dev のテックリードが x.y.0 に修正を当てて入れるかを決める。Strimzi の対応を待つ時間もこの 3 か月に含む（[ADR-0032](../decisions/0032-strimzi-for-physical-clusters.md)。4.3.0 から Strimzi の対応まで約 5 週間だった）。
- 最新のマイナー版から 2 つ遅れたらアラート（[ADR-0001](../decisions/0001-upstream-brokers-and-stack.md)）。
- 本家の版が古いクライアントの版を取り除くとき（5.0 など）は、[ADR-0005](../decisions/0005-compatibility-policy.md) の 6 か月前の告知と、別の ADR が先。

### 7.2 パッチの当て直し

- パッチの列は、本家の新しいタグに `git am` で当てる。当たらないパッチは、新しいタグの上で書き直し、同じ番号・同じ理由のまま差し替える。
- 当て直しの PR に、パッチごとの行数の差、名前空間の表の差（新しい API・版）、許された違いの表の差を載せる。
- パッチの行数が前の版から 20% 以上増えたら、Dev のテックリードが、差し込み口への置き換えか、本家への提案を検討する。

## 8. データ面の変更の種類と経路

| 変更 | 経路 | ロール |
| --- | --- | --- |
| ブローカーの動的な設定（クォータ、cordon、throttle） | 望ましい状態 → エージェント → Admin API | なし |
| テナントの資源（トピック、ACL） | 命令（[ADR-0031](../decisions/0031-control-plane-reconciliation-and-agent.md)） | なし |
| ブローカーの静的な設定、イメージ、JVM | gitops の PR → Argo CD → Strimzi | あり（6 節） |
| ノードの AMI、EKS の版 | Terraform → ノードグループの入れ替え（Drain Cleaner） | あり（6 節の関門で。ノードの入れ替えもブローカーの再起動） |
| 証明書の更新 | Secret の更新 → Strimzi | あり（6 節） |
| 運用のフラグ | 望ましい状態 → エージェント → `__<brand>_ops_flags` | なし |

## 9. フィーチャーフラグ

[ADR-0049](../decisions/0049-build-pipelines-artifacts-and-flags.md)。

| 種類 | 置き場所 | 例 | 誰が変えるか |
| --- | --- | --- | --- |
| release フラグ（制御面・コンソール） | AppConfig（他の題材と同じ） | 新しい管理 API の資源、コンソールの画面、PrivateLink の受付 | PM（リリースの判断）。組織・論理クラスタの単位で段階的に |
| 運用のフラグ（データ面） | 望ましい状態 → `__<brand>_ops_flags`（物理クラスタごと、世代付き） | `tiered.delete.pause`、`broker.demotion.auto`、`quota.dynamic`、`edge.ip_allowlist.enforce`、`rollout.pause` | Ops。制御面が止まっているときはエージェントの break-glass の CLI（記録つき） |
| 本家の機能の版 | KRaft（UpdateFeatures） | `share.version`、`streams.version`、`metadata.version` | runbook（6.3 節、ADR-0024 の条件） |

- データ面の新しい振る舞い（名前空間の表の新しい API、新しいクォータの種類）は、運用のフラグの裏に置いてからマージし、dp-staging → Basic → Standard の順に有効にする。
- フラグの一覧（名前、種類、既定、持ち主、消す予定）を開発リポジトリに置き、100% にしてから 2 週間でフラグとコードを消す。

## 10. ADR

| ADR | 決定 |
| --- | --- |
| [0049](../decisions/0049-build-pipelines-artifacts-and-flags.md) | ブローカーは本家のタグにパッチの列を当て、Strimzi の基のイメージに載せる。全ての成果物に署名・SBOM・来歴。データ面のフラグは内部のトピックで配る |
| [0050](../decisions/0050-rolling-upgrade-gates-and-upstream-tracking.md) | ローリング更新は AZ の順に 1 台ずつ、関門 G1〜G7 で進める。本家の版は U1〜U7 を通してから、Basic → カナリア → 残りの順に入れる |

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `broker-build-pipeline` | 4.1 節のパッチの列、プラグイン、Strimzi の基のイメージ、参照のブローカー |
| E1 | `patch-line-count-ci` | パッチの行数と対象のファイルの出力、増えたときの理由の要求 |
| E1 | `strimzi-roll-control-poc` | Strimzi のロールを AZ の順に止めて進められるか（一時停止、注釈） |
| E1 | `supply-chain-signing` | cosign、SBOM、provenance、EKS の署名の検証 |
| E2 | `nightly-upstream-rc` | 本家の RC と `trunk` への夜間の当たりと試験 |
| E9 | `dataplane-component-rollout` | エージェント・コーディネーター・sni-router の物理クラスタ・AZ ごとの昇格 |
| E12 | `rolling-update-guard` | 6.2 節の関門、止める仕組み、`broker_rollouts` の記録 |
| E12 | `upstream-upgrade-workflow` | 7.1 節の U1〜U7 の自動化と、`metadata.version` の 7 日の待ち |
| E12 | `ops-flags-topic` | `__<brand>_ops_flags` と break-glass の CLI |
| E10 | `cli-provider-release` | 4.3 節 |

## 12. 未解決の問い

### 決定（2026-09-27、既定案）

- **ロールの順**：コントローラー → AZ の順のブローカー、AZ の中は 1 台ずつ。
- **関門**：G1〜G7。30 分で止めて人を呼ぶ。自動で戻さない。
- **本家の取り込み**：x.y.1 以降。U1〜U7。Basic → Standard のカナリア → 残り。`metadata.version` は 7 日後。
- **ブローカーのソース**：パッチの列（`git am`）。fork のブランチを持たない。
- **データ面のフラグ**：内部のトピックで配る。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| Strimzi のロールの途中を止め、AZ の順を強制する方法 | E1 の PoC |
| Strimzi の基のイメージの Java の版 | E1 |
| EKS の署名の検証の道具 | E12 |
| 30 台のロールの時間（T8） | E12 |
| AZ の中で 2 台ずつロールするか | 1 つの AZ に 20 台を超えたとき |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- ロールの結果：物理クラスタごとの時間、関門で止まった回数と理由、ロールの間の `acks=all` の喪失（目標 0）。
- 本家の最新のマイナー版からの遅れ（日数）と、パッチの行数の推移。
- 日次の試験（差分・行列・Jepsen・Streams）の合格率と、失敗から直すまでの日数。
- 成果物の署名と SBOM の付いていないイメージの数（目標 0）。

### runbooks/README.md

- リリースとロールバックの方針：5 節の昇格、6 節の関門、6.3 節の戻しの表を正本として移す。
- アラート → 手順：ロールの関門で停止 → [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。
- 個別の手順の候補：`upstream-upgrade.md`（protocol-and-compatibility の提案。[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) の本家の版の節と合わせる）、`strimzi-upgrade.md`、`feature-version-bump.md`（`metadata.version` と機能の版）。

### data-model

- `broker_rollouts`、`rollout_gate_results`、`ops_flags`（[data-model.md](data-model.md) の 2 節）。

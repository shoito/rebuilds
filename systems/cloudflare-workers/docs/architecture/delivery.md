# Delivery: Cloudflare Workers

基盤の自前のソフトウェアの CI/CD を決める。ランタイムのフォーク（パッチの列と週 1 回の上流の取り込み）、ビルドと署名、ランタイムの cordon とリージョンの波での配信と戻し、V8 の緊急の経路、ノードの部品の AMI、基盤の設定とフィーチャーフラグ、制御プレーンと CLI の配信。

**利用者の関数の**版・デプロイ・段階的なデプロイ・ロールバックは [deployment-and-config-distribution.md](deployment-and-config-distribution.md) にある。この文書は、それを動かす基盤そのものの配信を扱う。

| 関連 | 決定 |
| --- | --- |
| [ADR-0006](../decisions/0006-workerd-fork-and-upstream-tracking.md) | workerd は下流のリポジトリにパッチの列で持ち、上流を週 1 回取り込む |
| [ADR-0012](../decisions/0012-v8-24-hour-patch-pipeline.md) | V8 の Critical・High の修正は、常設の緊急の経路で 24 時間以内に全ノードへ |
| [ADR-0014](../decisions/0014-wintertc-conformance-and-wpt.md) | WPT の部分集合を取り込みの門にする |
| [ADR-0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md) | 署名の権限を `build-release` に分ける |
| [ADR-0055](../decisions/0055-staged-runtime-rollout-by-cordon-and-region.md) | ランタイムは cordon × リージョンの波で、指標の関門を自動で判定して配る。ノードに 2 つの版を置き、プロセスの入れ替えで戻す。ノードの部品は AMI の入れ替え |
| [ADR-0056](../decisions/0056-platform-config-staging-and-flags.md) | 利用者の変更は速い経路、基盤の設定とフラグは範囲を付けて段階的に |

手順は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。V8 の修正の緊急の経路の中身は [sandbox-and-security.md](sandbox-and-security.md) の 8 節にある。

本家の振る舞いは、2026-09-27 に本家のブログで確かめた。

## 1. 本家の配信（確かめたこと）

| 項目 | 事実 | 出典（2026-09-27 に確認） |
| --- | --- | --- |
| 健全性で判断する配信（HMD） | 配信の成否を SLI・SLO（例：500 の率が 0.1% 未満）で判断し、続ける・止める・自動で戻すを決める。人が気づく前に戻す | [Scaling with safety](https://blog.cloudflare.com/safe-change-at-any-scale/)（2025-05-05） |
| 設定の配信の事故と対策 | 設定が数秒で全網に広がる経路（Quicksilver）に、ソフトウェアのような段階がなかった。設定も段階と健全性の判定で配る | [Code Orange: Fail Small](https://blog.cloudflare.com/fail-small-resilience-plan/)（2025-12-19） |
| ランタイムの配信 | ランタイムを利用者の群ごとの独立したサービスに分け、無料の利用者から先に、重要な群ほどゆっくり配る。7 日で 50 回以上の配信の波 | [Code Orange: Fail Small is complete](https://blog.cloudflare.com/code-orange-fail-small-complete/)（2026-05-01） |
| V8 の修正 | 公開から 24 時間未満で本番。自動のビルドとリリースに、人の 1 回のクリックの承認 | [Security model](https://developers.cloudflare.com/workers/reference/security-model/) |
| 段階の配信 | 健全性を見ながら、無料の利用者から先に、割合を上げて世界へ広げる。異常を見つけたら人の操作なしで戻す。**割合の値は本文にない**（2026-09-27 に本文で確認。前の版の「0.05%・0.5%・…」は検索の要約から入った誤り） | [Code Orange: Fail Small](https://blog.cloudflare.com/fail-small-resilience-plan/)（2025-12-19） |

## 2. リポジトリと成果物

| リポジトリ（開発） | 中身 | 成果物 | 配信の経路 |
| --- | --- | --- | --- |
| `<brand>-workerd` | 上流のタグ、`patches/`、`PATCHES.md`、BUILD の上書き | ランタイムの版（`v1.YYYYMMDD.N-<brand>.M`。x86-64 の Linux）、CLI 用の 5 つの形の workerd | 5 節（ランタイム）、10 節（CLI） |
| `<brand>-edge`（Rust） | 入口・外向きのプロキシ、スーパーバイザー、受け手、中継、使用量の送り手、DO のルーター・配置・ログのノード、ゲートウェイ | コンテナのイメージ（ゲートウェイ等）と、ノードの AMI に入れるバイナリ | 6 節 |
| `<brand>-control-plane`（TypeScript） | 管理 API、ダッシュボード、採番器、配信の元、cert-manager、配信の制御役 | ECS のイメージ | 9 節 |
| `<brand>-cli`（TypeScript） | CLI、模擬のストレージ | npm のパッケージ | 10 節 |
| `infra`（Terraform） | [infrastructure.md](infrastructure.md) の 9 節 | 計画と適用 | CI の OIDC |

- どのリポジトリも、トランクベース、squash、merge queue（リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)）。
- 隔離・鍵・配信に触れる PR は `security:sensitive` にし、セキュリティの担当の承認を要る（[AGENTS.md](../../AGENTS.md)）。

## 3. CI

### 3.1 PR の CI

| リポジトリ | 検査 |
| --- | --- |
| `<brand>-workerd` | パッチの列が当たる、Bazel のビルド（通常と ASan・UBSan）、上流のテスト、WPT の核、脱出のテスト（隔離に触れる PR）、`PATCHES.md` と `patches/` の一致、V8 のサンドボックスが有効なビルド（sandbox-and-security の 4.4 節）、パッチの行数（3,000 行の目標） |
| `<brand>-edge` | `cargo test`、clippy、cargo-fuzz の短い実行、性質ベーステスト、ランタイムとの結合（最新のランタイムの版）、`/healthz` の条件のレビューの規則（制御プレーンの状態を足させない） |
| `<brand>-control-plane` | 型、単体、結合（Aurora の RLS、監査の行）、OpenAPI の契約、ラベルの禁止（テレメトリ） |
| `infra` | `terraform plan`、ポリシーの検査（[infrastructure.md](infrastructure.md) の 9 節）、複数のリージョンを 1 回で変えない |

- 要件 ID（`REQ-*`・`PROP-*`・`DT-*`）をテスト名に含め、CI で追跡を検査する（[docs/process.md](../../../../docs/process.md) の 7 節）。

### 3.2 毎日・毎週

| 頻度 | 中身 |
| --- | --- |
| 毎日 | 上流の最新のタグにパッチの列が当たり、テストが通るか（本番に出さない。ADR-0006）。当たらなければその日のうちにチケット |
| 毎日 | ステージングの全 cordon で脱出のテスト（sandbox-and-security の 9.1 節） |
| 毎週（月曜） | 上流の取り込み、ビルド、ステージングへ（5 節の W0） |
| 毎週 | V8 の緊急の経路の空の実行（何もしないパッチで、ビルドから署名済みの版のカナリアの手前まで。ADR-0012） |
| 毎週 | ノードの AMI（OS の更新を含む） |
| 常時 | Fuzzilli・libFuzzer・cargo-fuzz（security-lab） |

## 4. ビルドと成果物

- **ビルドの場所**：`build-release` のアカウントの使い捨ての環境（ビルドごとに作り直す）。Bazel のリモートキャッシュは同じアカウントに置き、PR の CI からは読むだけ。
- **入力の固定**：上流のタグ、V8 の版、Rust・npm の依存はハッシュで固定する。
- **時間**：ランタイムのフルのビルドは 90 分以内（ADR-0012 の予算）。キャッシュが当たれば 20 分以内を目標（未検証。E1 の `build-release-and-signing` で測る）。
- **署名**：ランタイムの版、AMI、CLI の workerd のバイナリに、KMS の `release-signing`（ECC P-256）で署名する（[ADR-0047](../decisions/0047-kms-key-hierarchy.md)）。ノードは、署名と `runtime_releases` の `artifact_sha256` を確かめてから版を置く。
- **来歴**：SLSA の形の来歴（入力のハッシュ、ビルドの環境、コミット）と SBOM を成果物に付ける（形式の選択は E3）。
- **再現性**：週 1 回、同じ入力の 2 回のビルドのハッシュを比べ、違いを記録する（完全な再現ができるかは未検証。E3 の `reproducible-build-check` で確かめる。sandbox-and-security の 8.4 節）。

## 5. ランタイムの段階的な配信

[ADR-0055](../decisions/0055-staged-runtime-rollout-by-cordon-and-region.md)。

### 5.1 置き方

- ノードには、ランタイムの版を 2 つ（いまと前）置く。新しい版は、ノードの受け手が `runtime_release` の器（基盤の器。[ADR-0056](../decisions/0056-platform-config-staging-and-flags.md)）で知り、中継のキャッシュから取り、署名を確かめて置く。
- **どの cordon のプロセスがどの版で動くか**は、`runtime_rollout` の器（`{version, scope: {regions, cordons, node_pct}}`）で決める。スーパーバイザーは、範囲に入った cordon のプロセスを、新しい版で起動し直す（プロセスの入れ替えの手順。[runtime-and-isolates.md](runtime-and-isolates.md) の 5.5 節）。

### 5.2 波と関門

| 波 | 対象 | 待ち | 始め方 |
| --- | --- | --- | --- |
| W0 | ステージングの全 cordon | 2 日（月・火） | 自動（取り込みの CI の成功） |
| W1 | 本番の全リージョンの `ci-internal` | 4 時間 | Dev のテックリードの承認（水曜の朝） |
| W2 | 海外の 1 リージョン（最も小さいところ）の `c0-untrusted`・`c1-free` | 4 時間 | 自動 |
| W3 | 全リージョンの `c0-untrusted`・`c1-free` | 12 時間 | 自動 |
| W4 | 大阪の `c2-paid`・`cq-quarantine` | 6 時間 | 自動 |
| W5 | 全リージョンの `c2-paid`・`cq-quarantine` | 12 時間 | 自動 |
| W6 | `c3-dedicated`、研究者用のノード | — | 自動（契約で事前の通知が要る利用者には知らせる） |

**共通の関門**（配信の制御役が 5 分ごとに判定。新しい版の cordon と、同じ時間・同じ cordon の前の版を比べる）：

| 指標 | 閾値（初期値） |
| --- | --- |
| プラットフォームが原因の失敗の率 | 前の版の 1.2 倍以内 |
| ランタイムのプロセスの落ち、OOM | 0（1 件で止める） |
| seccomp の違反 | 0（1 件で止め、セキュリティの当番を呼ぶ） |
| 冷たい起動の p99 | 1.1 倍以内 |
| `exceededCpu` の率 | 1.2 倍以内 |
| CPU 時間の中央値（同じ関数の集まり） | 1.05 倍以内 |
| 合成監視・探りの関数 | 成功 100% |

- 外れたら自動で止め、2 回続けば自動で戻し、当番を呼ぶ。人はいつでも止められる。
- **エラーの予算を使い切ったリージョン**では、そのリージョンの波を止める（[observability.md](observability.md) の 6.2 節）。
- **凍結の期間**（年末年始、大きな催しの日）は、W1 以降を止める。V8 の緊急の経路は止めない。
- 取り込みを 2 週続けて飛ばしたら、Dev のテックリードへ上げる（ADR-0006）。

### 5.3 戻し

- ノードの前の版で、プロセスを起動し直す。ノードのプロセスの 25% ずつ、2 分おき（冷たい起動の嵐を抑える）。全ノードで約 10 分。
- 毎日の入れ替えの上限（1 時間に 1/24。sandbox-and-security の 6.4 節）は、戻しでは外す。
- 前の版にセキュリティの欠陥（V8 の修正の前）がある場合は、戻さず、V8 のフラグで該当の機能を止めるなどの手段を当番とテックリードが選ぶ（ADR-0012 の「間に合わないとき」と同じ）。
- 互換の日付の上限：新しい版の最大の互換の日付は、フリートの全てのノードが新しい版を置き、W5 が終わるまで、デプロイで受け付けない（[ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md)）。

## 6. ノードの部品と AMI

| 変更 | 経路 | 時間 |
| --- | --- | --- |
| Rust の部品（入口・外向きのプロキシ、スーパーバイザー、受け手）、OS の更新 | 週 1 回の AMI。ステージング 2 日 → 海外 1 → 大阪 → 残りの海外 → 東京。リージョンの中は 1 AZ ずつ、ASG のインスタンスの入れ替え（最小の健全な割合 90%） | 約 3 日 |
| カーネルの重大な修正（名前空間、seccomp、cgroup、eBPF） | 臨時の AMI。同じ順を短い待ちで | 72 時間以内 |
| 入口のプロキシの軽い修正 | AMI（S1）。Pingora の無停止の再読み込みでの差し替えは S2 で検討 | 同上 |
| 中継、DO のルーター・配置・ログのノード、ゲートウェイ | 群ごとの AMI かコンテナのイメージ。1 台・1 AZ ずつ | 群ごと |

- ノードの入れ替えは、スナップショットからの追いつき（目標 2 分）と冷たい起動を伴う。入れ替えの速さは、1 リージョンで 1 時間に全ノードの 1/3 まで。
- 部品とランタイムの間の形（Unix ドメインソケットの要求の形、呼び出しの記録）は、前後の 1 版と両立させる（ノードに 2 つのランタイムの版が混ざるため）。
- DO のホストの入れ替えは、実体の持ち主の引き継ぎを伴う（リースの 10 秒＋復元）。ホストの退避で、持ち主の割り当てを先に他のホストへ移してから止める（durable-objects の領域で手順を決める）。

## 7. 基盤の設定とフィーチャーフラグ

[ADR-0056](../decisions/0056-platform-config-staging-and-flags.md)。

| 器 | 種類 | 経路 |
| --- | --- | --- |
| `deploy`・`version`・`host`・`routes`・`certs_by_host`・`secret`・`account_state`・`tail`・`acme` | 利用者の器 | 速い経路（p99 10・30 秒） |
| `region_flags`（`drain`） | 障害の対応 | 速い経路（同時に 2 リージョンまで） |
| `egress_policy`・`platform_flags`・`cordon_policy`・`pmu_thresholds`・`geo`・`runtime_release`・`runtime_rollout` | 基盤の器 | `scope` を付けて段階的に（下の表） |

**基盤の器の段階**：

| 段 | 範囲 | 待ち |
| --- | --- | --- |
| 1 | ステージング | 30 分 |
| 2 | 海外の 1 リージョンの `ci-internal` | 30 分 |
| 3 | 同じリージョンの全 cordon | 30 分 |
| 4 | 大阪 | 30 分 |
| 5 | 全リージョン | — |

- 作成と範囲の拡大は 2 人の承認。セキュリティの修正（拒否の一覧への追加、隔離の閾値を厳しくする）は、段の待ちを 5 分に縮められる。
- ノードの受け手は、基盤の器の値を型とスキーマで検証し、通らなければ前の値で動き続ける。
- **フィーチャーフラグ**（`platform_flags` の `release` の種類）：未完成の振る舞いは、フラグの裏に置いてからマージする（[AGENTS.md](../../../../AGENTS.md)）。範囲にリージョン・cordon・アカウントの一覧を持てる。作成から 90 日で消す計画を持ち、CI で古いフラグを警告する。
- 利用者の関数の振る舞いの切り替えは、互換の日付とフラグ（ADR-0008）で扱い、この仕組みを使わない。

## 8. V8 の緊急の経路

[ADR-0012](../decisions/0012-v8-24-hour-patch-pipeline.md)、[sandbox-and-security.md](sandbox-and-security.md) の 8 節。この文書の仕組みとの対応だけを書く。

| ADR-0012 の段 | この文書の仕組み |
| --- | --- |
| T+4h 修正の版とビルドと署名 | 4 節（`build-release`、90 分以内、署名） |
| T+8h 速い試験 | 3.1 節の `<brand>-workerd` の検査の一部（WPT の核、脱出のテスト、再現コード） |
| T+10h カナリア 1% | `runtime_rollout` の `scope.node_pct = 1`（全リージョン、全 cordon）。承認 1 回目 |
| T+12h 大阪 | `scope.regions = [apne3]` |
| T+16h 全リージョン | `scope` を全体へ。承認 2 回目 |
| T+24h 全ノードの報告 | `nodes.runtime_versions` の集計 |

- 共通の関門（5.2 節）は同じ値で判定する。ただし待ちは ADR-0012 の予算に従い、自動で次へ進めない（承認で進める）。
- 通常の取り込みの波が進行中なら止め、修正の版を先に出す。修正の版は、いまの本番の土台（前の週の取り込み）に当てる。
- 毎週の空の実行と四半期の訓練は [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) の「V8 の緊急の配信」。

## 9. 制御プレーンの配信

- ECS のサービスは、ステージングで確かめた後、本番は blue/green（CodeDeploy）で 10% → 100%。関門は管理 API の 5xx の率と遅延。
- 採番器・配信の元・cert-manager は 1 つのリーダーで動くので、新しいタスクがリースを取ってから古いタスクを止める。
- Aurora のスキーマの変更は、前の版のコードと両立する形（拡張 → 移行 → 縮小）だけにする。`config_outbox`・`config_log` の形の変更は、配信の束の形の互換（Protocol Buffers のフィールドの追加だけ。deployment-and-config-distribution の 15 節）と合わせる。
- 制御プレーンの配信の失敗は、デプロイ済みの関数に影響しない（静的な安定）。

## 10. CLI の配信

- 週 1 回、本番のランタイムの W5 の完了の後に、その版の workerd を同梱した CLI を npm に出す（[ADR-0035](../decisions/0035-cli-and-single-jsonc-config.md)）。
- 発行は CI の OIDC の信頼できる発行（provenance つき）だけ。人のトークンで発行しない（[security.md](security.md) の 3.3 節の C8）。
- 壊れた版は `deprecate` し、前の版を案内する（developer-tooling の `cli-release-rollback`）。

## 11. 環境

| 環境 | 構成 | 使い方 |
| --- | --- | --- |
| dev | 東京の 1 AZ、縮小 | 開発者・エージェントの結合テスト |
| staging | 東京・大阪、本番と同じ型を少ない台数で。合成のテナントだけ | W0、AMI、基盤の器の段 1、DR の訓練、負荷試験（台数を一時的に本番と同じに） |
| prod | 5 リージョン | |
| security-lab | 網なし | 再現コード、ファズ |

- 本番の利用者のデータを staging・dev に持ち込まない。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0055](../decisions/0055-staged-runtime-rollout-by-cordon-and-region.md) | ランタイムは `ci-internal` → 無料の cordon（1 リージョン → 全体）→ 有料（大阪 → 全体）→ 専用の波で配り、関門を自動で判定して止め・戻す。ノードに 2 つの版。ノードの部品は週 1 回の AMI、カーネルの重大な修正は 72 時間以内 |
| [0056](../decisions/0056-platform-config-staging-and-flags.md) | 利用者の器は速い経路、基盤の器は `scope` を付けて段階的に配り、2 人の承認とノードの検証を置く。フィーチャーフラグは基盤の器に置き、90 日で消す |

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | `build-release` のアカウント、使い捨てのビルドの環境、Bazel のリモートキャッシュ |
| E1 | 署名（KMS の `release-signing`）と、ノードでの署名の検証 |
| E1 | 週 1 回の AMI の作成と、ASG のインスタンスの入れ替えの順 |
| E2 | 毎日のパッチの当て直しと、週 1 回の取り込みのジョブ（runtime-and-isolates と合わせて） |
| E3 | V8 の緊急の経路の検知のジョブ、`scope.node_pct` の配信、毎週の空の実行 |
| E5 | 基盤の器の `scope` と、受け手の範囲の評価と検証 |
| E5 | 配信の制御役（`rollout-controller`）：波、関門の判定、自動の止めと戻し |
| E5 | ランタイムの版の 2 つ置きと、プロセスの入れ替えでの戻し |
| E5 | フィーチャーフラグ（`platform_flags`）と古いフラグの CI の警告 |
| E6 | CLI の週 1 回の発行（provenance つき） |
| E12 | 凍結の期間と、エラーの予算での配信の停止 |

## 14. 未解決の問い

- 本家の段の値（0.05% など）を、この規模で使う意味があるか（S1 のノードは 20 台前後で、1% は 1 台に満たない）。
- 入口のプロキシを AMI の入れ替えでなく、Pingora の無停止の再読み込みで差し替えるか。
- ビルドの再現性（C++・V8・Bazel）。
- 波の待ちの合計（水〜金の 3 日）で、週 1 回の取り込みが翌週と重ならないか。
- DO のホストの入れ替えの手順（持ち主の移し方）。

### 決定

2026-09-27 の既定案。

- S1 の波は cordon とリージョンの単位で切る。ノードの割合の段（`node_pct`）は V8 の緊急の経路のカナリアだけで使い、1% は「リージョンごとに 1 台」と読み替える。
- 入口のプロキシは S1 では AMI で配る。S2 で無停止の再読み込みを検討する。
- 再現性は E3 で確かめる（security の 13 節の決定と同じ）。
- 波が翌週の月曜までに終わらないときは、翌週の取り込みを W0 までで止め、前の週の版の W6 を先に終える。
- DO のホストの手順は E9 で durable-objects の領域が決め、[runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) に足す。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：ランタイムの退行が有料の利用者に届く。波の関門の結合テストと、自動の戻しの訓練（四半期）。
- リスク：基盤の設定の誤りが全体に広がる。`scope` の性質ベーステストと、スキーマに合わない値の結合テスト。
- リスク：V8 の緊急の経路の腐り。毎週の空の実行の成功率 100%。
- リスク：署名のない・合わない成果物がノードに入る。結合テスト。
- 本番での検証：波ごとの関門の値、戻しの数、配信の時間（取り込みから W5 まで）、フラグの数と年齢。

**runbooks/README.md**

- リリースとロールバックの方針：5 節と 7 節。手順は [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)。
- 個別の手順の候補：`upstream-rebase-blocked`、`runtime-rollback`、`ami-rollout-stuck`、`platform-config-rollback`、`v8-patch-drill`、`cli-release-rollback`。このうち `runtime-rollback`・`ami-rollout-stuck`・`platform-config-rollback`・`v8-patch-drill` は [deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) の B・F・G・E にまとめた（runbooks/README.md の 5.2 節）。
- SLI の追加の依頼：配信の制御役の判定の結果、ノードの版の分布、署名の検証の失敗。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `runtime_releases`（制御プレーン） | [runtime-and-isolates.md](runtime-and-isolates.md) の 15 節。`artifact_sha256`、`signature`、`provenance_uri`、`sbom_uri` を足す | テナントの表ではない |
| `runtime_rollouts`（制御プレーン） | `id`、`version`、`kind`（`weekly`・`emergency`・`rollback`）、`wave`、`scope`、`started_at`、`gate_results`（jsonb）、`status`（`running`・`paused`・`rolled_back`・`done`）、`approved_by` | |
| `ami_releases`・`ami_rollouts`（制御プレーン） | `ami_id`、`region`、`kernel_version`、`components`（版）、`signature`、`rollout_order`、`status` | |
| `platform_config_changes`（制御プレーン） | `id`、`keyspace`、`key`、`value_sha256`、`scope`、`stage`、`created_by`、`approved_by`（2 人）、`change_id`（変更のログ） | 基盤の器の段階の記録 |
| `feature_flags`（制御プレーン） | `name`、`kind`（`release`・`ops`）、`scope`、`owner`、`created_at`、`remove_by` | 基盤の器 `platform_flags` の正本 |
| 設定の写しの器（ノードの LMDB） | `runtime_release/`、`runtime_rollout/`、`platform_flags/`、`cordon_policy/`、`pmu_thresholds/` | [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 6.3 節に足す。基盤の器 |

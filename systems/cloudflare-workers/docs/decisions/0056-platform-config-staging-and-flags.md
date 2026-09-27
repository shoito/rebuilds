---
status: accepted
date: 2026-09-27
---

# ADR-0056: 利用者の変更は速い経路で全ノードへ配り、基盤の設定とフラグはリージョン・cordon の範囲を付けて段階的に配る

詳細は [delivery.md](../architecture/delivery.md) の 7 節と 8 節。

## Context

- 設定の変更のログは、全ノードへ p99 10 秒で届く（NFR-008、[ADR-0022](0022-sequenced-change-log-relays-and-lmdb.md)）。利用者のデプロイ・ルート・シークレットには、この速さが要る。
- 同じ経路には、基盤の側の設定も乗る：`egress_policy`（外向きの拒否の一覧）、`region_flags`、cordon の閾値、ランタイムのフラグ、性能カウンターの閾値、位置の表。
- 本家は、基盤の設定の誤りで 2 回、網を広く止めた。どちらも設定が数秒で世界へ広がり、ソフトウェアの配信のような段階と健全性の判定がなかった。対策として、設定もソフトウェアと同じ段階と健全性の判定で配る仕組み（Snapstone）を作った（[Code Orange: Fail Small](https://blog.cloudflare.com/fail-small-resilience-plan/)、2025-12-19、[Code Orange: Fail Small is complete](https://blog.cloudflare.com/code-orange-fail-small-complete/)、2026-05-01。どちらも 2026-09-27 に確認）。

## Options

1. **器を「利用者の器」と「基盤の器」に分ける。利用者の器は速い経路のまま。基盤の器の項目は、範囲（リージョン・cordon・ノードの割合）を持ち、段階を踏んで範囲を広げる**
2. すべての変更を段階的に配る
3. すべての変更を速い経路で配り、事前の検証だけで守る

## Decision

1 を採用する。

- **利用者の器**（`deploy`・`version`・`host`・`routes`・`certs_by_host`・`secret`・`account_state`・`tail`・`acme`）：速い経路のまま。1 つの利用者の変更の影響はその利用者に閉じる。例外として、1 つの変更が 1 万項目を超えるものは保留にして承認を求める（ADR-0022）。
- **基盤の器**（`egress_policy`・`platform_flags`・`cordon_policy`・`pmu_thresholds`・`geo`・`region_flags` を除く運用の値）：項目に `scope`（`{regions, cordons, node_pct}`）を持たせる。ノードの受け手は、自分に当たる範囲の項目だけを有効にする。
  - 段階：ステージング → 本番の 1 つの海外のリージョンの `ci-internal` → そのリージョンの全 cordon → 大阪 → 全リージョン。各段の待ちは 30 分、関門は [ADR-0055](0055-staged-runtime-rollout-by-cordon-and-region.md) の共通の関門。
  - 範囲を広げる操作は、変更のログへの新しい書き込み（`scope` の更新）。戻しも同じ（前の値の書き込み）。
  - 作成と範囲の拡大は 2 人の承認（[ADR-0046](0046-control-plane-privilege-separation-and-operator-access.md)）。セキュリティの修正（拒否の一覧への追加）は、段の待ちを 5 分に縮められる。
- **ノードの検証**：受け手は、基盤の器の値を型とスキーマで検証し、通らなければ前の値を使い続け、警報を出す（設定の誤りで落ちない。本家の対策の「検証した既定の値で通す」と同じ考え）。
- **`region_flags`（`drain`）** は、障害の対応の手段なので速い経路のまま（[ADR-0017](0017-global-accelerator-and-regional-nlb.md)）。同時に 2 リージョンまでの制限で守る。
- **フィーチャーフラグ**：利用者に見える未完成の機能は、`platform_flags` の `release` の種類のフラグの裏に置く。範囲にアカウントの一覧も持てる（試用の利用者）。フラグは作成から 90 日で消す計画を持つ（CI で古いフラグを警告）。利用者の関数の互換の振る舞いは、互換の日付とフラグ（ADR-0008）で扱い、この仕組みを使わない。
- **制御プレーン**（ECS のサービス）：ステージングで確かめた後、本番は ECS の blue/green（CodeDeploy）で 10% → 100%。Aurora のスキーマの変更は、前の版のコードと両立する形（拡張 → 移行 → 縮小）だけにする。
- 2 を採らない理由：利用者のデプロイの伝搬（p99 30 秒）と、アカウントの停止の即時の反映を守れない。
- 3 を採らない理由：本家が 2 回、全網で踏んだ落とし穴そのもの。

## Consequences

- 良くなること：
  - 基盤の設定の誤りは、まず 1 つのリージョンの自前の関数に出て止まる。
  - 利用者のデプロイの速さは変わらない。
- 引き受けるコスト：
  - 基盤の設定の変更に、最短でも 2 時間前後かかる（緊急のセキュリティの追加を除く）。
  - 器を 2 つの種類に分け、`scope` の評価を受け手に足す。deployment-and-config-distribution の 6.3 節の器の表を、この分類で改める必要がある。

## Confirmation

- 性質ベーステスト：任意の `scope` とノードの属性で、ノードが有効にする項目の集合が定義どおり。
- 結合テスト：スキーマに合わない基盤の値を配ると、ノードが前の値のまま動き、警報が出る。
- CI：基盤の器に書く変更のハンドラーが、`scope` なしで全体に書けない。

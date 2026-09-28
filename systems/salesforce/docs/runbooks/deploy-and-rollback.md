# Runbook: デプロイとロールバック

- Owner: Ops
- 対応するアラート: デプロイの後の悪化（入れ替えの後 15 分の比べ）、`runtime` の blue/green の自動のロールバック、フラグのガードによる自動の段の戻し、影の実行の食い違い（[observability.md](../architecture/observability.md) の 7 節）
- 最終確認日: 2026-09-28

流れは [delivery.md](../architecture/delivery.md)、CI/CD と Terraform の構成は [infrastructure.md](../architecture/infrastructure.md) の 8 節、組織の単位のリリースと影の実行は [ADR-0063](../decisions/0063-org-staged-release-and-shadow-evaluation.md)、`security:sensitive` の変更は [ADR-0062](../decisions/0062-security-sensitive-change-flow.md) にある。組織の管理者が行うメタデータのデプロイ（Sandbox から本番）の戻しは、この手順ではなく `deploy-rollback`（[sandboxes-and-deploy.md](../architecture/sandboxes-and-deploy.md) の 14 節）で扱う。

## 症状

次のときに使う。

- 本番（prod）へデプロイするとき（アプリ、マイグレーション、Terraform）
- フラグの段を進めるとき
- デプロイ・段の進みの後に、SLI の悪化、エラーの率の増加、`LIMIT_EXCEEDED` の急増、`access_oracle_mismatch_total` の増加が出たとき
- 影の実行で食い違いが出たとき

## 影響

- 通常のデプロイ：利用者への影響はない。
- 失敗したデプロイ：対話の可用性（99.9%。28 日の窓のエラーバジェット 約 40 分。[README.md](README.md) の 1 節）を消費する。
- **アクセスの判定の誤りは、5xx にならず、見えてはならないレコード・項目が見える形で現れる。** SLI の悪化がなくても、参照の評価器の `over` か影の実行の食い違いが 1 件出たら、ここで止める。
- **上限の数え方の誤りは、特定の組織の自動化が `LIMIT_EXCEEDED` で止まる形で現れる。** 全体の率は小さく、組織ごとに見る必要がある。
- メタデータの部品の形の誤りは、組織の画面が壊れる（`layout_compile_fallback_total` の増加）形で現れる。

## 確認

### デプロイの前

1. 対象のコミットが staging へデプロイ済みで、PR の CI と夜間の CI（性質ベーステスト 10 万通り、障害の注入）が通っている。
2. デプロイできる時間帯である（平日 10〜17 時。月末の 3 営業日と年末年始は修正だけ）。
3. マイグレーションが expand だけか。contract を含むなら、1 つ前のリリースで参照をやめていること、PITR の直近の復元できる時刻が 5 分以内であることを確かめる。分割の表（約 3,300）への `ALTER` は、staging で測ったロックの時間を見る。
4. **メタデータのコンパイル済みの部品・カーソル・監査の `details`・パッケージの形を変える変更なら、新旧の両方を読めるコードが先に本番にあること**（部品の鍵に形の版がある）。なければ止める。
5. SLO のダッシュボードで、エラーバジェットが残っている。
6. 進行中のインシデント、組織の移動（`org_migrations` の `fenced`）、大きな共有のジョブ、`AuroraGlobalDBRPOLag` の超過がない。
7. `security:sensitive` の PR を含むなら、2 人の承認がそろっている（GitHub の記録で確かめる）。
8. 上限の登録簿を変える PR を含むなら、rebuilds の governor-limits.md が先にマージされている（CI の一致の検査が通っている）。

### デプロイの後（入れ替えが終わってから 15 分）

| 見るもの | 正常 | 異常 |
| --- | --- | --- |
| 5xx の率（ALB） | デプロイの前と同じ | 0.1% を超える |
| レコードのページの p95・p99 | 300ms・800ms 以内 | 超える |
| 保存の p95（自動化を除く） | 200ms 以内 | 超える |
| `LIMIT_EXCEEDED` の数（上限ごと、組織ごと） | デプロイの前と同じ | 2 倍以上、または新しい組織に出る |
| `layout_compile_fallback_total`、`metadata_compile_failures_total` | 0 に近い | 増える |
| `access_oracle_mismatch_total{direction="over"}` | 0 | 1 件以上（直ちにインシデント） |
| `pivot_drift_repaired_total` | 0 に近い | 増える（保存の経路の不具合） |
| Relay の遅れ、検索の索引の遅れ | p95 5 秒 | 30 秒を超える |
| 合成監視 | 成功 | 2 回続けて失敗 |
| 出力の走査（秘密・個人データ） | 0 件 | 1 件以上（直ちにインシデント） |

## 対処

### 通常のデプロイ（アプリ）

1. デプロイのワークフローを、対象のイメージの digest で起動する。
2. マイグレーション（expand）→ `worker`・`relay`・`indexer` → `metadata`・`bulk` → `runtime` の順に進む。
3. `runtime` は blue/green。新しいターゲットグループへ 10% → 50% → 100% と移し、各段で 5 分、「デプロイの後」の表を見る。悪化で自動で戻る。
4. 他のサービスは 1 AZ ずつのローリング。1 AZ ごとに 5xx と `LIMIT_EXCEEDED` を見る。
5. 全てを終えたら、「デプロイの後」の表を 15 分見る。

### マイグレーション

1. expand は通常のデプロイの最初に自動で流れる。分割の表への `ALTER` は根の表に行う。
2. contract は、別のデプロイとして、平日の午前に行う。直前に PITR の復元できる時刻を確かめる。
3. RLS の方針を変えるマイグレーションは `security:sensitive`。適用の後に、組織の分離の性質ベーステストを本番の読むだけの監視の組織 2 つで流す（合成監視の一部）。

### Terraform

1. plan の差分を 2 人（作成者と別）で読む。IAM・KMS・SCP・ネットワーク・`admin_cross_org` に触れるものは `security:sensitive`。
2. WAF の新しい Block は、まず Count で 24 時間出し、誤検知を見てから Block にする。
3. prod-egress の変更は、Elastic IP を変えないことを plan で確かめる（変えるなら `egress-ip-change` の 30 日前の知らせが先）。

### フラグの段を進める

1. 今の段の滞在の時間（24 時間、判定の変更は 72 時間）を過ぎている。
2. 段の組織の SLI の悪化がない、エラーの率が変わらない、`access_oracle_mismatch_total{direction="over"}` が 0、影の実行の食い違いが 0。
3. AppConfig で次の段の組織の一覧を配る。ガード（段の組織の SLO の燃え方 1 時間 14 倍で前の段に戻す）が有効なことを確かめる。

### 影の実行で食い違いが出たとき

1. 段を進めない。`shadow_eval_results` で、食い違いの組織・経路・`oracle_verdict` を見る。
2. `new_correct`（旧い側が誤り）なら、今の本番に誤りがある。`over` の向き（旧い側が多く見せている）なら、[incident-response.md](incident-response.md) の「共有の漏えい」へ進む。
3. `old_correct`（新しい側が誤り）なら、リリースを止め、Dev に戻す。本番の利用者には影響していない（影の結果は返していない）。
4. `both_wrong` なら、両方の不具合として Dev とセキュリティの担当に渡す。

### 悪化したとき

1. **フラグで戻す。** 新しい振る舞いのフラグが原因なら、AppConfig で前の段に戻す。ガードで自動で戻っていれば、戻っていることを確かめる。
2. **フラグで戻せないとき、アプリを戻す。** 1 つ前のイメージの digest で再デプロイする（「前のリリースを再デプロイ」のワークフロー）。`runtime` の blue/green の途中なら、旧い側へ戻す。
3. **マイグレーションは戻さない。** 前へ進める修正を書く。
4. **メタデータの部品の形の誤りで、組織の画面が壊れていたら**：戻した後に、影響した組織の部品を L2 から消し、L3 から作り直すジョブを流す（組織の今の版は変えない）。
5. **上限の数え方の誤りで、組織の自動化が止まっていたら**：戻した後、`tx_limit_peaks` と `LIMIT_EXCEEDED` のログから影響した組織とトランザクションを特定し、組織の管理者に知らせる。止まった一括のジョブは、組織の管理者が再実行する（本システムは自動で再実行しない。二重の保存を避ける）。
6. **ピボット・写しの誤りを書いていたら**：戻した後、影響した組織・オブジェクトに整合の検査を前倒しで流す（`pivot-drift-detected`）。
7. `security:sensitive` の変更のロールバックは、2 人目の承認を事後 24 時間以内でよい。
8. 戻しても直らなければ、インシデントを宣言する（[incident-response.md](incident-response.md)）。

## エスカレーション

- 戻しても 15 分以内に SLO が回復しない → インシデントを宣言する。
- `access_oracle_mismatch_total{direction="over"}` が 1 件、影の実行の `new_correct` の `over`、出力の走査の検出 → SEV2 以上。セキュリティの担当を呼ぶ。
- 他の組織のデータが見えた疑い → SEV1。セキュリティの担当と Dev のテックリードを呼ぶ。
- マイグレーションが途中で止まり状態がわからない → Dev のテックリードを呼ぶ。

## 事後

- 調査結果を Intent の Issue として起票する（Maintain 段）。
- デプロイの失敗を CI で防げたなら、CI の検査（決定表の行、性質のジェネレーター、漏えいの経路の行、上限の試験）を足す提案を Dev と QA に出す。
- この手順で足りなかったことを、ここに反映する。

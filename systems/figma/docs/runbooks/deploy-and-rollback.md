# Runbook: デプロイとロールバック

- Owner: Ops
- 対応するアラート: api の blue/green の自動の戻し、デプロイの後の編集の SLO のバーンレート、ドレインの停滞（`router_drain_remaining_files`）、新しいビルドのクライアントの異常終了の急増
- 最終確認日: 2026-09-27

流れは [delivery.md](../architecture/delivery.md)、Document Server のドレインは [ADR-0046](../decisions/0046-multiplayer-compute-on-fargate-with-drain.md) と [infrastructure.md](../architecture/infrastructure.md) の 3.1 節、版の食い違いは [ADR-0053](../decisions/0053-client-server-version-skew.md)、段階的なリリースとプロパティの表の変更は [ADR-0055](../decisions/0055-staged-rollout-and-schema-changes.md) にある。

## 症状

次のときに使う。

- 本番（prod）へサーバーをデプロイするとき、クライアントのビルドの配信を進めるとき、プロパティの書き込みを解禁するとき
- デプロイの後に、編集の SLO（`edit_open`・`edit_commit`）、`Reject` の率、クライアントの異常終了の率が悪化したとき
- Document Server のドレインが進まないとき

## 影響

- 通常のデプロイ：Document Server の入れ替えで、ファイルごとに 1〜2 秒の中断（`Kick(owner_changed)` と再接続）がある。Gateway の入れ替えで、接続が散らして切れ直す。確定した編集は失われない。
- 失敗したデプロイ：編集の SLO（99.95%）を消費する。変更の適用の規則の不具合は、エラーにならずに、ファイルの状態を食い違わせうる（`parity` と作り直しの検証で見つける）。

## 確認

### デプロイの前

1. 対象のコミットが staging へデプロイ済みで、E2E、`parity`、参照画像、`perf`、`mp-loadbot` の短い負荷（10 分）が通っている。
2. デプロイできる時間帯である（平日 10〜17 時。日本の祝日の前日と、大きな利用者の催しの日は修正だけ）。
3. 変更の分類を見る（PR の説明）。
   - マイグレーションが expand だけか。contract を含むなら、1 つ前のリリースで参照をやめていること。
   - **プロパティの表の変更が「追加以外」（`schema-breaking`）なら止める。** 強い再読み込みを伴うので、別の計画作業にする（下の「互換を切る変更」）。
   - `protocol_version` を上げる変更なら、サーバーが新旧を話せる版が先に本番にあることを確かめる。
   - 文書のフラグ（`release.doc.*`）の既定値を変える変更がないか。
4. 編集の SLO のエラーバジェットが残っている（[observability.md](../architecture/observability.md) の 5 節）。
5. 進行中のインシデント、ジャーナルの飛び、手放さずに 1 日を超えて残るファイル（`router_orphan_oldest_seconds`）がない。
6. `ReplicationLatency`（東京 → 大阪）が平常（数秒以内）。

### デプロイの後（入れ替えが終わってから 30 分）

| 見るもの | 正常 | 異常 |
| --- | --- | --- |
| `edit_open`・`edit_commit` の悪いイベントの率 | デプロイの前と同じ | 0.05% を超える |
| `ds_commit_seconds` の p99 | 110ms 以内（[multiplayer.md](../architecture/multiplayer.md) の 8 節のサーバーの区間） | 超える |
| `ds_reject_total`（`code` ごと） | デプロイの前と同じ | 2 倍以上（特に `invalid_*`） |
| `gw_kick_total{reason="version_mismatch"}` | 0 に近い | 増え続ける（互換の一覧の誤り） |
| `ds_fence_lost_total` | ドレインの間だけ小さく増える | ドレインの後も増える |
| `ds_recovery_seconds` の p95 | 3 秒以内 | 超える |
| 作り直しの検証・`parity` の抜き取りの不一致 | 0 | 1 以上（直ちにインシデント） |
| 合成のボット（反映・開く） | 成功 | 2 回続けて失敗 |

## 対処

### サーバーのデプロイ

1. GitHub の `prod` の Environment で、Ops が承認する（作成者と別の人）。
2. マイグレーションのタスクの成功を確かめる。失敗したら、アプリのデプロイは自動で止まる。
3. [delivery.md](../architecture/delivery.md) の 5.1 節の順に進む。Worker・Render Worker・file-read → Document Server → router → gateway → api・realtime。
4. **Document Server（ドレインの波）**：
   1. サービスを更新する。新しいタスクが起動し、`ds_liveness` に `active` で現れることを確かめる。
   2. router のドレインを始める（「デプロイ：Document Server のドレイン」のワークフロー。波は 10%）。
   3. 各波で `router_drain_remaining_files` が減り、渡したタスクが止まることを確かめる。波の後 5 分、上の表を見る。
   4. 悪化したら、ドレインを止める（ワークフローの「一時停止」）。止めても、渡し終えたファイルは新しいタスクで動き続ける。
5. **gateway**：ローリング（1 回に 10%）。`gw_reconnect_total` と API の 429 を見る。429 が 1 分続けば、入れ替えの割合を 5% に下げる。
6. **api・realtime**：blue/green のカナリア（10%）。アラームが鳴らなければ 100%。

### クライアントのビルドの配信

1. 前の段で 24 時間、[delivery.md](../architecture/delivery.md) の 6.2 節の条件を満たしていることを、Grafana の「ビルドの比較」で確かめる。
2. AppConfig の `client_build_channels` で、次の段の割合にする。
3. 1 時間後に、新しいビルドの異常終了の率と `version_mismatch` を見る。

### プロパティの書き込みの解禁

1. 接続のうち新しい `schema_hash` の割合が 95% 以上であることを確かめる（Grafana の「スキーマの普及」）。
2. 1 つ前の版の Document Server で、新しいプロパティを書いたファイルを開き、値が保たれることを、staging で確かめてある（結合テスト。[ADR-0055](../decisions/0055-staged-rollout-and-schema-changes.md) の Confirmation）。
3. `schema.<prop>.write` を有効にする。**これは戻せない**（書いた値はファイルに残る）。PM の判断を記録する。

### 互換を切る変更（`schema-breaking`、`protocol_version` の打ち切り）

1. Dev のテックリードの承認と、ADR があることを確かめる。
2. 利用の少ない時間帯（平日 19 時以降）に行う。
3. サーバーを出した後、`min_client_build` を上げる。強い再読み込みは `retry_after_ms` で 0〜5 分に散る。
4. `gw_kick_total{reason="version_mismatch"}` と、クライアントの報告の `pending_count`（失った未確定の件数）を見る。

### 悪化したとき

1. **フラグで戻す。** 新しい機能のフラグが原因なら切る。文書のフラグ（`release.doc.*`）を切ったときは、開いているファイルが `Kick(resync_required)` で開き直す。
2. **クライアントのビルドが原因なら**、配信の割合を 0 にし、前のビルドだけにする。タブに残ったビルドを止める必要があれば、`min_client_build` を上げる（強い再読み込み）。
3. **サーバーが原因なら**、1 つ前のイメージの digest で再デプロイする（「前のリリースを再デプロイ」のワークフロー）。Document Server は、同じドレインの波で戻す。
   - 新しい `protocol_version` を話すクライアントのビルドが配信されていれば、**先にクライアントの配信を戻す**。そうしないと、古い Document Server に強い再読み込みで弾かれる。
4. **マイグレーションは戻さない。** 前へ進める修正を書く。
5. **ファイルの状態が食い違った疑い**（作り直しの検証・`parity` の抜き取りの不一致、`layout_divergence`）：
   - 影響するファイルの ID を、不一致の記録から集める。
   - そのファイルを一度閉じさせ（`Kick(resync_required)`）、回復させて、再び不一致になるかを見る。
   - インシデントとして扱う（[incident-response.md](incident-response.md) の「ファイルの状態の食い違い」）。
6. 戻しても直らなければ、インシデントを宣言する。

### ドレインが進まないとき

1. `router_drain_remaining_files` が減らないタスクを見つける。
2. そのタスクの `ds_liveness.state` が `draining` か、タスクの保護が立ったままかを確かめる。
3. 渡しが失敗しているファイル（router のログの `handoff_failed`）を見る。多いのは「新しいタスクに空きがない」（[ADR-0051](../decisions/0051-document-server-memory-admission.md)）。`ds-standard` の台数を上げる。
4. 1 つのファイルだけが渡せないなら、そのファイルに `Kick(resync_required)` を送ってから、手で渡す（ワークフローの「ファイルを渡す」）。
5. 30 分たっても進まず急ぐときは、タスクの保護を外して止める。残ったファイルは持ち主の生存の期限と回復（NFR-007、ADR-0047）で拾われる。確定した編集は失われない。

## エスカレーション

- 戻しても 15 分以内に編集の SLO が回復しない → インシデントを宣言する。
- 作り直しの検証・`parity` の抜き取りの不一致、ジャーナルの飛び → SEV2 以上。Dev のテックリード（`doc-model` の持ち主）を呼ぶ。
- マイグレーションが途中で止まり状態がわからない → Dev のテックリードを呼ぶ。
- 書き込みを解禁したプロパティに不具合がある → PM と Dev のテックリードを呼ぶ（戻せないため、前へ進める修正の判断が要る）。

## 事後

- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- CI で防げた失敗なら、CI の検査（`parity` の入力、参照ファイル、`schema-diff` の規則）を足す提案を Dev と QA に出す。
- この手順で足りなかったことを、ここに反映する。

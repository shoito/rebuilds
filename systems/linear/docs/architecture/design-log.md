# Design log: Linear

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-28：既定案

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。計測・PoC で決めるものは、下の「持ち越し」に置いた。どれも E1〜E12 の PoC・試験で覆りうる。

- **検索**：S1 から OpenSearch（[ADR-0030](../decisions/0030-search-engine-opensearch.md)）。4 節の技術スタックの「S1 は PostgreSQL の全文検索」を直した。
- **Slack**：チャンネルへの通知とリンクの展開は公開のチームだけ。スレッドの同期は MVP の後（[ADR-0039](../decisions/0039-slack-app-issue-creation-and-channel-notifications.md)）。1.1 節と 7 節を直した。
- **同期グループの種類**：`workspace`・`members`・`team:<id>`・`user:<id>`・`role:admin` の 5 つ。`members`（ゲストを除くメンバー）は ADR-0033 で足した。非公開のチームのモデルは `team:<id>` だけ。モデルごとの規則は `workspace`・`workspace_members`・`team`・`team_or_workspace`・`team_row`・`via`・`user`・`admin`・`teams`・`view_scope`（[data-model-and-schema.md](data-model-and-schema.md) の 3.5 節）。
- **`teams` の規則**：行の中のチームの ID の集合から読むと、公開のチームの人に非公開のチームの ID が届く。結び付けのモデル `ProjectTeam` の行から読む形に替えた（ADR-0003 の注記、ADR-0033）。
- **コメントの本文**：LWW（ADR-0022）。ADR-0002 の競合の表を直し、日付付きの注記を残した。
- **並びの鍵の振り直し**：窓（65 個から最大 1,024 個）で振り直す（ADR-0008）。墓標（ADR-0012）と `sync_epoch`（ADR-0013）とあわせて、ADR-0002・0003 に注記を残した。
- **outbox の `done`**：確定を確かめた後 15 分残し、DR のやり直しで送り直す（ADR-0014）。NFR-007 の「outbox に残っていれば送り直される」を、確定の後 15 分にも広げる。ADR-0005 に注記を残した。同期グループから外れたときの未確定のトランザクションは、サーバーが拒否するまで outbox に残す。
- **自動の処理の流量**：自動で閉じる・アーカイブ・繰り越しは `worker` の枠（1 ワークスペース 1 秒 50 変更）に従い、開始の時刻を散らす（ADR-0023・0026 の注記）。
- **通知係の書き込み**：通知係は `worker` と別の `notifier` の枠（1 ワークスペース 1 秒 50 変更、瞬間 500）で書く。インボックスの行は安く、受け手のグループだけに届くので、受け手ごとに 5 秒に 1 回のトランザクションにまとめる（[ADR-0054](../decisions/0054-per-workspace-write-admission.md) の注記、[capacity.md](capacity.md) の 2.2 節、[notifications-and-inbox.md](notifications-and-inbox.md) の 5.5 節）。自動の処理と通知が同じ枠を取り合わない。
- **やり直しの散らし**：既定 10 分、DR では `ops.epoch_reset_spread_min` で 30 分まで（ADR-0013 の注記）。
- **DR の権限の変更**：権限を狭める操作を DynamoDB のグローバルテーブルに追記し、昇格の後、書き込みを受ける前にやり直す（[ADR-0058](../decisions/0058-dr-permission-narrowing-journal.md)。Auth0 の題材の考え方に倣う）。
- **permessage-deflate**：差分の流れに使う。窓 4 KiB の文脈の持ち越し。E12 で、持ち越しなしと比べて確定する（ADR-0009 の注記）。
- **`Workspace` の持ち主**：permissions-and-teams。`Workspace`（`workspace` のグループ）と `WorkspaceSettings`（`members` のグループ）に分けた（[permissions-and-teams.md](permissions-and-teams.md) の 3.3 節）。
- **RLS の外の表**：`sync_outbox`・`client_devices`・`narrowing_outbox` だけを足し、`workspaces`・`oauth_apps` のコンテキストの前の読み出しは関数にした（[data-model.md](data-model.md) の 5 節）。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。保持の期間は [security.md](security.md) の 9 節。1 ワークスペースの書き込みの枠は [capacity.md](capacity.md) の 2.2 節。公開 API の枠は [api-and-webhooks.md](api-and-webhooks.md) の 4.2 節。クライアントの上限（outbox 5 万件・100 MiB、M1 5 万個）は [client-store-and-offline.md](client-store-and-offline.md) の 5.3・7.2 節。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。
- **検証の後の PM の決定（2026-09-28。推奨案）**：
  - **招待**：`members_can_invite` の既定を偽（管理者だけ）にした。本家の有料のプランの既定と同じで、B2B で安全な既定にするため（[permissions-and-teams.md](permissions-and-teams.md) の 3.3 節の注記）。
  - **手動のアーカイブ**：残す。本家はアーカイブを自動だけにするが、利用者が自動のアーカイブを待たずに片付けられるようにする。本家との意図した差異（[issues-and-workflow.md](issues-and-workflow.md) の 2・18 節）。
  - **イニシアチブの複数の親**：MVP の後。MVP は親を 1 つにする（[cycles-and-projects.md](cycles-and-projects.md) の 3.7・12 節）。
  - **見積もりのキー**：`E`（本家は `Shift+E`）のまま、法務の L8 の後に見直す（下の持ち越し）。
- **検証の工程での直し（2026-09-28）**：未検証の項目を公式の資料で確かめ、次を直した。本文のスキーマにノードを足すのは破壊の変更にし、`min_build` を先に上げる（y-prosemirror が知らないノードを共有の文書から消すため。ADR-0057 の注記、[editor-and-descriptions.md](editor-and-descriptions.md) の 3.2 節）。自動で閉じる・アーカイブに、本家の文書の除外の条件（進行中のサイクル・未完了のプロジェクト、期日、サブイシュー、親）を足した（ADR-0023 の注記）。データ転送の費用を CloudFront の日本の単価で見積もり直した（[infrastructure.md](infrastructure.md) の 11 節）。
- **データモデルの統合（2026-09-28）**：データモデルを [data-model.md](data-model.md) と [data-model/](data-model/) に集め、形（表・列・キー・索引）の正本にした。欠けていた `ProjectDescription`・`attachment_purges`・`audit_export_checkpoints` を足し、共通の列に `updated_at`、`trash` のモデルに `trashed_at`、定義の型に `bytes` を足した。日ごとのパーティションの表の一意の守り方（`tx_results` はロックの中の先の引き、`notification_keys`・`webhook_deliveries` は事象の日で分割）を決めた。コンテキストの前の関数 `resolve_api_credential`・`resolve_integration_target`・`scheduler_due_items`・`auth.upsert_workspace_directory` を起票した（セキュリティの担当の承認待ち）。一覧は [data-model.md](data-model.md) の 7 節。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L8） | [intent.md](../intent.md) の「法務の確認待ち」、[security.md](security.md) の 13 節。結論まで、そこに挙げた Story の spec を承認しない |
| 反応型のストア（MobX か自前か） | E2 の前の `memory-tiers-poc`。イシュー 50 万件での一覧の描画、フィルターの再計算、メモリー |
| 1 ワークスペースの書き込みの上限（1 秒 300 変更）、楽観的な検証・group commit の要否 | E2 の前の `writer-throughput-poc`、E12 の負荷試験 L3 |
| 全体と部分のブートストラップの閾値（5 万件）、やり直しの閾値（5 万件）、部分の条件（30 日） | E3 の PoC（[ADR-0003](../decisions/0003-bootstrap-and-partial-sync.md)） |
| IndexedDB の一括の書き込みが NFR-003 に間に合うか（だめなら SQLite の WASM） | E3 の前の `bootstrap-poc` |
| 同期のログの保持の期間（30 日） | E3。法務の L5 の後に確定する |
| 見積もりのキー（本システムは `E`、本家は `Shift+E`） | 法務の L8 の後（[client-app.md](client-app.md) の 5 節） |
| permessage-deflate の文脈の持ち越しの採否、データ転送の量 | E12 の負荷試験 |
| OpenSearch の費用と型、1 文字の N-gram の索引の大きさ | E8 の `search-poc` |
| 本家の振る舞いで未確認のもの（同期のログの保持、本文の CRDT の部品、可用性の SLA の値） | 公式の資料で確かめられなかった。未検証のまま、本システムの値を使う（`lastSyncId` が全体で共通なことは第三者の解析で確かめた。1.3 節） |

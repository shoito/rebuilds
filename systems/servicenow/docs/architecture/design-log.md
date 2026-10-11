# Design log: ServiceNow

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-28：既定案

PM の方針（判断が要るところは推奨の既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した（L9 を足した）。計測・PoC で決めるものは、下の「持ち越し」に置いた。

- **ADR の状態**：0001〜0064 はすべて `accepted`。題材の最初の設計の間なので、食い違いは ADR を直接直し、日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。
- **冪等のキー**：ADR-0004 の `(flow_run, step, attempt)` の `attempt` は、ノードの実行の回（`iteration`）の意味で、配送の再試行の回数を含めない（ADR-0004 の注記、[workflow-engine.md](workflow-engine.md) の 5.5 節）。タイマーの索引は `(shard, due_at)`。
- **CMDB の調整と識別**：ADR-0005 の調整の決定表は到着の順序に依存するので、取り込み元ごとの状態の max の結合と純粋な選び方（[ADR-0038](../decisions/0038-attribute-reconciliation-per-source-state.md)）に置き換えた。一致は識別の項目の和集合で決める（[ADR-0037](../decisions/0037-ci-ingest-entry-point-and-ambiguity-hold.md)）。識別そのものは順序で変わりうることを ADR-0005 の注記と [AGENTS.md](../../AGENTS.md) に書いた。
- **NULL の `tenant_id` と組み込みのデータ**：組み込みのデータを「NULL の行」「コードのバージョンだけ」「テナントの作成の時の行」の 3 つに分けた。NULL の行の許可の一覧は、辞書・ロール・ACL の規則・国民の祝日に、`number_def`・`ci_relation_type`・`ci_attribute`・`ci_identification_rule`・`flow_def`・`flow_version` を足したもの（[data-model.md](data-model.md) の 3.1 節、ADR-0002・ADR-0054 の注記、AGENTS.md）。
- **タイマーの取得**：テナントをまたいで `timer` を読まない。`engine_scheduler` の関数 `claim_due_timers` が識別子だけを返し、テナントのコンテキストで取り直す（[workflow-engine.md](workflow-engine.md) の 5.3・8.3 節、ADR-0015・0018 の注記）。
- **タイマーの種類**：`page_escalation`（優先度 0）と `bulk_step`（優先度 3）を足した（[data-model/workflow-and-approvals.md](data-model/workflow-and-approvals.md) の 4 節）。
- **メールの受信**：infrastructure の共有の入口（mail-ingress）と `mail-router` でセルへ振り分ける。解決できない受け手はバウンスしない（後方散乱を避ける）（[notifications-and-email-ingest.md](notifications-and-email-ingest.md) の 5.1 節、ADR-0034・0035 の注記）。
- **ルーター**：ADR-0002 のルーターは、CloudFront Functions と KeyValueStore に細かくした（ADR-0002 の注記、ADR-0055）。
- **`ext_index`**：`value_ref` を持ち、参照のフィールドを必ず写す（ADR-0003 の注記、ADR-0007）。
- **SLA**：`sla_clock.breach_disputed_at` を足した（[sla-and-calendars.md](sla-and-calendars.md) の 6.2 節、ADR-0047 の注記）。一時停止の既定は [itsm-processes.md](itsm-processes.md) の 4.4 節で決めた形（SLA は依頼者の回答待ちだけ、OLA はベンダー待ちでも止める）を、sla-and-calendars に写した。
- **ロールと ACL**：組み込みのロールに `major_incident_manager`・`problem_manager` を足し、`requester` がポータルから自分のインシデントを作る組み込みの規則を足した（[access-control.md](access-control.md) の 3.3 節）。
- **代理**：`delegation.scope` に `requests` を足した（[workflow-engine.md](workflow-engine.md) の 7.1 節）。
- **辞書**：`searchable` の列を足した。CMDB の `multi` の属性は、CMDB の入口だけの辞書の型の例外とした。CI のクラスの付け替えは持ち越し（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.2・3.3 節）。
- **設定のパッケージ**：配置・画面の規則・翻訳を入れる。レポートは `packaged` の印の付いたものだけ（[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 10.1 節）。
- **画面の規則とカタログの変数**：フォームの画面の規則で隠したフィールドは保存で捨てず、カタログの見えない変数は捨てる。違いは意図したもので、両方の文書に書いた（[portal-and-ui.md](portal-and-ui.md) の 4.3 節、[service-catalog-and-requests.md](service-catalog-and-requests.md) の 4.2 節）。
- **保持**：各領域の「（案）」を [security.md](security.md) の 9 節の表に一本化した。
- **Epic と Story**：Story の Epic の食い違いを揃えた（`cmdb-ingest-api` は E10、`business-time-wait` は E5、`incident-default-slas` は E6、`known-error-articles`・`catalog-form-kb-suggestions`・`catalog-search` は E9、`opensearch-domain-per-cell` は E1、タイマーの山の負荷試験は E4 の `timer-burst-generator` と E12 の `timer-burst-load-test`）。当番の呼び出しは E5 でメールの経路から始め、プッシュは E8 の `web-push-and-pwa` の後に有効にする（[roadmap.md](../roadmap.md)）。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節、保持は [security.md](security.md) の 9 節、上限は各領域の文書（フローは [workflow-engine.md](workflow-engine.md) の 8.1 節、API のレート制限は [api-and-integrations.md](api-and-integrations.md) の 7.1 節）、負荷の見積もりは [capacity.md](capacity.md)。
- **本家の内部の名前の置き換え**（2026-09-28、検証の工程の後）：AGENTS.md の「内部の名前を写さない」に従い、本家の内部の名前と同じだったフィールド・表・値を、全文書・ADR・決定表・data-model で置き換えた。`caller_id` → `requester_id`（参照のたどりは `requester`。`caller_location` → `requester_location`、保留の理由 `awaiting_caller` → `awaiting_requester`、`external_caller_email` → `external_requester_email`）、`short_description` → `title`、`close_code` → `resolution_code`・`close_notes` → `resolution_notes`（インシデントと変更で同じ列を使う。選択肢はクラスごと）、`watch_list` → `watchers`、`cmdb_ci_id` → `ci_id`（たどりは `ci`）、`task_sla` → `sla_clock`・`task_sla_event` → `sla_clock_event`（Story `task-sla-evaluation-in-save` → `sla-clock-evaluation-in-save`）。`assignment_group`・`opened_by`・`kb_category` のような、どの ITSM の製品も使う一般の語は残した。出典の URL と本家の説明の中の名前は変えていない。
- **ITIL のバージョン**：S1 は ITIL 4 の用語のままにする。ITIL（Version 5）は、安定した後、S2 の前に見直す（PM が決めた。[intent.md](../intent.md)）。
- **変更の承認の方針の期限の既定**：`change_approval_policy_rule.due_after` の既定（通常 3 日、緊急 4 時間）を承認した（[itsm-processes.md](itsm-processes.md) の 8.5.1 節）。
- **データモデルの正本**（2026-09-28、データモデルの工程）：[data-model.md](data-model.md) と [data-model/](data-model/) を列・制約・索引・ER 図の正本にした（184 テーブル）。領域の文書は振る舞いの正本で、食い違ったらデータモデルに合わせて直す。主な決定：バージョン付きのメタデータは「定義の表 ＋ 不変のバージョンの表」にそろえた（`sla_def_version`・`escalation_policy_version`・`transform_map_version` を足した）。メタデータの論理削除は `deleted_at`。参照の列は `<name>_id`、辞書の名前は `_id` を除く。セッションの正本は Aurora の `user_session`（Valkey は写し）。`tenant_deletion_run` は制御の面に置く。NULL の行を持つ表の主キーは `id` だけにし、参照の先をトリガー `check_shared_ref()` で確かめる。列の決まっていなかった参照の先（`company`・`department`・`location`、`tenant_setting` など）を最小の形で定義した。一覧は [data-model.md](data-model.md) の 7 節の 10〜22。
- 領域ごとの決定は、各文書の「決定（2026-09-28、既定案）」の節にある。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L9） | [intent.md](../intent.md)、[security.md](security.md) の 14 節。結論まで、そこに挙げた spec を承認しない |
| 1 つのセルに入れるテナントの数と、専用のセルに移す基準 | E12 の負荷試験（[infrastructure.md](infrastructure.md) の 9 節）。専用のセルの販売の条件は PM が E12 の前に決める |
| カスタムのフィールドの索引の上限（テーブルごとの数） | E2 の計測（[ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)） |
| タイマーの取得の間隔・窓・取り分と、9 時の山の見積もり | E4・E12 の計測（[ADR-0018](../decisions/0018-flow-limits-and-tenant-fairness.md)、[ADR-0061](../decisions/0061-load-model-cell-sizing-and-timer-bursts.md)） |
| 関係のグラフの走査の上限と、グラフの専用の置き場所に移す基準 | E10 の計測（[ADR-0039](../decisions/0039-ci-relations-impact-traversal-and-service-model.md)） |
| 日本語の検索の解析器（Sudachi の確認） | E9 の評価（[ADR-0043](../decisions/0043-japanese-analyzer-and-index-layout.md)） |
| レポートの S2 の置き場所（別の Aurora か Redshift か） | E11・E12 の計測。S2 の前（[ADR-0045](../decisions/0045-report-execution-on-reader-and-daily-facts.md)） |
| 契約の SLA の報告で厳格と調整のどちらを使うか | E11 で PM（[ADR-0047](../decisions/0047-sla-attainment-and-breach-disputed.md)） |
| 選べる変更の期間（60 日）と予告の仕方 | E12 の前に PM（[ADR-0063](../decisions/0063-flags-and-staged-release-per-cell.md)） |
| KeyValueStore の書き込みがエッジに届くまでの時間（上限の値は 2026-09-28 に確かめた。[infrastructure.md](infrastructure.md) の 3.1 節） | E1 `edge-router-kvs` で計測（[infrastructure.md](infrastructure.md) の 12 節） |
| CI のクラスの付け替え、統合を戻す操作 | E10 の利用者の調査と運用の後（[cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 14 節） |
| 本家の既定の値で確かめられなかったもの | 各領域の文書の 2 節に「未検証」と、設計の前提でないことを書いた（2026-09-28 の検証の工程）。確かめられたら直す（設計は本システムの値で進める） |

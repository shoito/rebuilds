# Design log: Salesforce

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-28：既定案

利用者の指示（判断が要るところは推奨の既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に集めた。計測・PoC・選定で決めるものは、下の「持ち越し」に置いた。

- **ADR の状態**：0001〜0063 は全て `accepted`（2026-09-28）。題材の最初の設計の間に直したものは、日付付きの注記を残した。
  - ADR-0003 の DML の順とスナップショットの形は、ADR-0008 と ADR-0007 で置き換えた。
  - ADR-0004 の 2 つの閉包の表と、オブジェクトごとの影の世代は、ADR-0014・ADR-0015・ADR-0016 で置き換えた。
  - ADR-0005 のハッシュでのシャードの決め方は ADR-0010・ADR-0055 で細かくし、上限の表に ADR-0041 の外向きの呼び出し・メール（と E13 の `tx.code_*`）を足した。
  - ADR-0002 の JSONB のキーは `field_no`（ADR-0006）。システムの列に `parent_id` を足した。
  - ADR-0018 の「集計した行を取得の行に数える」の例外（積み上げ集計、レポート、一括の問い合わせ）は ADR-0041。
  - ADR-0026・ADR-0049 の手順は 3a・3b・7a・7b（ADR-0008 の注記）。題名も 3a・7b・13（ADR-0026）と 3b・7a・13（ADR-0049）に直した。ADR-0021 の活動の割り当ての行は DT-SHR-001 の行 3 に足した。
  - ADR-0010 の分割の数は、分割する表が 13 に増えて約 3,300 になった。
- **`field_id` の一意の範囲**：「全組織で一意」（ADR-0006）と、Sandbox が元の組織の ID を共有すること（ADR-0038）の食い違いを、**組織の系統（本番の組織と、その Sandbox）の中で一意**に揃えた（ADR-0006 の注記、[metadata-and-runtime.md](metadata-and-runtime.md) の 3.2 節）。
- **DML の手順**：3・7 を 3a（保存の前のフロー）・3b（before トリガー）・7a（after トリガー）・7b（保存の後のフロー）に分け、手順 9（項目の変更の履歴）を手順 10・11 と同じく最上位で 1 回にした（ADR-0008 の注記、[metadata-and-runtime.md](metadata-and-runtime.md) の 6 節）。
- **項目の変更の履歴の置き場所**：18 か月で約 3.5TB になり主のクラスタを圧迫するので、**S1 から `events` と同じ形の別のクラスタ `history` に置く**。手順 9 は同じトランザクションの outbox に書き、Relay が写す。`opportunity_history` は主に残す（ADR-0047・ADR-0060 の注記、[audit-and-field-history.md](audit-and-field-history.md) の 5.2 節、[capacity.md](capacity.md) の 3 節、[infrastructure.md](infrastructure.md) の 4.3 節）。
- **OpenSearch の台数**：3 台（`r7g.xlarge`）ではメモリーとディスクが足りないので、`r7g.2xlarge.search` × 6（3 AZ に 2 つ）で見積もった（[capacity.md](capacity.md) の 7.1 節）。本番の費用の概算は約 40,000 から約 44,000 USD/月に直し、単価を確かめた後に約 44,500 USD/月にした（[infrastructure.md](infrastructure.md) の 9 節）。
- **NFR-005・K6**：OWD の変更は述語の切り替え（再計算なし）。目標をレコードの条件の共有ルールの再計算（15 分）と閉包の世代（5 分）に当て直した（3 節の注記）。
- **ダッシュボード**：見る人の権限だけで集計し、本家の「指定した実行ユーザー」は持たない（ADR-0030）。PM の確認済みの決定として intent に記録した。
- **送信の網**：ADR-0035 の「送信の VPC」を、本番と別の prod-egress のアカウントの VPC と SQS の受け渡しに読み替えた（ADR-0035 の注記、ADR-0054）。
- **システムの権限は 25**（ADR-0045）。正本は [orgs-users-and-auth.md](orgs-users-and-auth.md) の 7.1 節で、共有の領域の 3.2 節を合わせた。
- **活動の共有**：DT-SHR-001 に「活動の割り当て（本人と上司は `full`）」の行 3 を足した。旧い行 3 以降は 1 つ繰り下げた（[sharing-and-record-access.md](sharing-and-record-access.md) の 6.1 節）。
- **変更のイベントの購読**：オブジェクトの `view_all`（DT-EVT-001）を要し、共有で絞らない。共有の領域の 6.4 節を合わせた。
- **フローの種類**：`event_triggered` を足し、フローの式で保存の出どころ `$Origin` を読めるようにした（[automation-flows.md](automation-flows.md) の 3.4 節）。
- **組織の状態**：`orgs.migrating`（組織の移動の書き込みの止め、503 `ORG_MIGRATING`）と Sandbox の列を足した（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 3.1 節）。
- **上限**：一括の問い合わせは `bulk.query` の予算（[query-language-and-api.md](query-language-and-api.md) の 4.5 節）。利用者のコードの `tx.code_*` と、名前空間ごとの内訳を登録簿に足した（[governor-limits.md](governor-limits.md) の 4 節）。
- **メタデータの部品**：`report_types` を足し、部品の鍵に形のバージョンを含めた（ADR-0007 の注記）。
- **`records.parent_id`**：主従の 1 本目の親に加え、活動の主の親を指す（[data-storage.md](data-storage.md) の 3.1 節）。
- **data-model**：`shard_no` で分割する表は 13。統合の工程では索引だけに保つとしたが、次の工程（下）で正本に改めた。
- **データモデルの完成（2026-09-28、既定案）**：[data-model.md](data-model.md) と [data-model/](data-model/) を、列・制約・索引・ER 図の正本にした（領域の文書は振る舞いの正本）。表は 171（`main` の RLS 147、`events` 3、`history` 1、RLS の外 20）、ER 図は 19。アーキテクチャの決定は変えず、次を決めた（詳しくは data-model.md の 8 節）。
  - SQL の予約語の列の名前を改めた（`is_unique`、`can_*`、`sort_order`、`trigger_order`、`from_at`・`to_at`）。`permission_sets`・`profiles` の主キーを `ps_id`・`profile_id` にした。
  - レコードの ID に接頭辞を持たず、`records` に `(org_id, id)` の索引を足した。
  - `change_events`・`org_events` を `event_id` の範囲で分割し、主キーを `(org_id, event_id)` にした（ADR-0033 の `event_id` の一意を分割の表で守るため）。`field_history` の主キーに `source_id` を足した。
  - 期限で動く仕事は `jobs.available_at` で予約し、組織をまたいで表を走査する役割を作らない。Worker の class に `maintenance` を足した。
  - 外部キーはメタデータと設定の表の間だけに張る。
  - 足りない表を最小で定めた：`sso_mfa_policies`、`profile_record_types`、`org_sharing_state`、`org_usage_hours`、`autonumber_counters`、`stats_parent_counts`。
- **数値の正本**：上限と割り当ては [governor-limits.md](governor-limits.md)。保持と消去は [security.md](security.md) の 7 節。SLO とアラートは [runbooks/README.md](../runbooks/README.md)。漏えいの経路は [security.md](security.md) の 4 節。量と台数は [capacity.md](capacity.md)。
- **検証の工程（2026-09-28）**：「未検証」の本家の振る舞いと AWS・部品の事実を、本家の PDF・ヘルプの本文、AWS の資料と Price List API、Wasmtime・QuickJS-ng・Better Auth の資料で確かめ、出典と確認日を付けた。確かめられないもの（試用の組織か PoC が要るもの）は「未検証」のまま、確かめる Story を添えた。設計を変えた・注記したものは次のとおり。
  - SLO の窓を 28 日から他の題材と同じ 30 日の移動の窓に直し、エラーバジェットを約 43 分、速い燃え方を 1 時間 14.4 倍にした（[runbooks/README.md](../runbooks/README.md) の 1 節、[ADR-0058](../decisions/0058-slis-and-per-org-resource-metrics.md) の注記）。
  - LEAK-012（検索の応答の時間から見えない一致を推し量れる）の既定の対策：1 ページごとに固定の候補の束（3,000）を取り、束の全てを後で確かめ、下限の時間（600ms）まで待って返す。`more_may_exist` を見えない候補で変えない。残るリスク（下限を超えた要求、繰り返しの平均の比べ）は [search.md](search.md) の 6.4 節（[ADR-0032](../decisions/0032-search-permission-post-filter.md) の注記）。
  - 本家の Apex は API のバージョン 67.0 から既定で利用者の権限で動く。本システムの既定と同じ向きになった（ADR-0049 の注記。決定は変えない）。
  - 本家はフローの要素の数の上限（2,000）をなくしていた。本システムは CPU 時間の近似が粗いので残し、差として移行の文書に書く（[ADR-0025](../decisions/0025-flow-definition-and-bulk-engine.md) の注記）。
  - **SSO の MFA と特権を持つ利用者のパスキー**（利用者の指示による推奨の既定案。本家の 2026 年の方針に揃えた）：SSO でも IdP の `amr`（OIDC）・`AuthnContextClassRef`（SAML）を接続ごとの受け入れの一覧と比べ、確かめは既定で有効、組織の管理者は理由を記録した時だけ無効にでき監査に残る。主張がない・一覧にない時は SSO の後に本システムの 2 つ目の要素を求める。特権を持つ利用者（`modify_all_data`・`manage_users`・`customize_application` のどれか）はパスキーだけで TOTP を許さず、`sso_bypass` の非常用の管理者は 1 人あたりハードウェアのキーを 2 つ持つ（[ADR-0044](../decisions/0044-authentication-better-auth-sso-and-mfa.md) の注記、[orgs-users-and-auth.md](orgs-users-and-auth.md) の 6.3・6.4・14 節）。
  - Aurora・OpenSearch の仮に置いていた単価を Price List API で確かめ、保存を東京と大阪の 2 つ分で数え直して、本番の費用を約 44,500 USD/月にした（[infrastructure.md](infrastructure.md) の 9 節）。
  - 項目の変更の履歴で `long_text` を選べる型に戻し、「変わった」だけを記録する形に揃えた（ADR-0047 と [audit-and-field-history.md](audit-and-field-history.md) の食い違いを直した）。
- 各領域の「他の領域への依頼」は、この工程で持ち主の文書へ反映した（一覧は [data-model.md](data-model.md) の付録 A と、各文書の「2026-09-28」の書き込み）。領域ごとの決定は、各文書の「決定」の節にある。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | 理由 | いつ・どう決めるか |
| --- | --- | --- |
| 法務の確認待ち（L1〜L11） | 法務 | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた spec を承認しない |
| 1 トランザクションの上限の値、組織ごとの割り当ての値、エディションの分け方と価格 | 計測・PM | E2 の着手前に PM がエディションを決め、E3 で初期値を置き、E12 の負荷試験で値を決める（[governor-limits.md](governor-limits.md)） |
| ピボットの索引を全項目に張るか、trigram の索引 | PoC | E3 の PoC（[ADR-0010](../decisions/0010-record-tables-partitioning-and-pivots.md)） |
| 所有者の条件のルールの結合の速さ、`G_me` の読みの p99 | PoC | E4 の PoC（[sharing-and-record-access.md](sharing-and-record-access.md) の 15 節） |
| 日本語の解析器（kuromoji か Sudachi）、OpenSearch の 1 文書の大きさと台数 | PoC | E5 の着手前の PoC（[ADR-0031](../decisions/0031-search-index-and-japanese-analysis.md)、[capacity.md](capacity.md) の 7.1 節） |
| `history` のクラスタの Aurora の種類（Standard か I/O-Optimized）と台数 | 計測 | E11 で I/O を測る |
| 利用者のコードの燃料と CPU 時間の換算の係数、実体化の時間 | PoC | E13 の前の PoC（[ADR-0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md)） |
| IdP ごとの `amr`・`AuthnContextClassRef` の受け入れの一覧の既定値（特に、フィッシングに強いとみなす SAML のクラス） | 選定 | E2 の `org-sso-saml-oidc` で主な IdP の返す値を確かめて決める（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 6.4 節） |
| 検索の 1 ページの下限の時間（600ms）と固定の候補の束（3,000）の値 | 計測 | E5 の `search-api-post-filter` で、固定の束の後の確かめの p95 を測って決め直す（[search.md](search.md) の 6.4 節） |
| 分析用の写し（レポート）の置き場所 | PoC | S2 の前に別の ADR |
| S3 の最大の組織（50 億件）の置き方と共有の再計算 | 設計 | S3 の前に別の ADR（ADR-0005 の持ち越し） |
| 本家の振る舞いで未確認のもの（フローの再帰の回数、承認者のアクセスとロックを越える自動化、活動の見え方、レポートの集計が見えない行を数えないか、数式・積み上げ集計の FLS、レイアウトの必須が API に効くか、リストビューの上限、Partial Copy の件数） | 確かめるだけ | 2026-09-28 に公開の資料で確かめられるものは確かめた（項目の数、Sandbox の種類と容量、承認の数、入力規則の数など）。残りは各文書の「未検証」に添えた Story で、試用の組織で確かめる |

# Decisions: Salesforce

Salesforce の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、メタデータの実行基盤を自前で作る。本家の言語との互換は持たない | accepted |
| [0002](0002-custom-object-storage.md) | レコードを共有の records の表（システムの列＋JSONB）に入れ、型付きのピボットの表で引く | accepted |
| [0003](0003-metadata-driven-runtime.md) | メタデータを版の付いた不変のスナップショットにコンパイルし、要求を 1 つの版に固定して AST から SQL を作る | accepted |
| [0004](0004-record-access-model.md) | 共有を事前計算し、所有者とロール階層は閉包の表と結ぶ。設定の変更の再計算は影の世代で切り替える | accepted |
| [0005](0005-tenancy-and-governor-limits.md) | 組織を共有スキーマと RLS で分け、論理シャードとセルで広げる。上限は実行基盤のデータ層で強制する | accepted |
| [0006](0006-data-dictionary-and-field-lifecycle.md) | データ辞書は field_id と再利用しない field_no を分けて持ち、型の変換は新しい field_no へ写して切り替え、削除は 15 日保つ | accepted |
| [0007](0007-segmented-metadata-snapshots.md) | スナップショットを内容で番地を決めたオブジェクトごとの部品と不変の manifest に分け、変わった部品だけをコンパイルし直す | accepted |
| [0008](0008-dml-order-of-execution.md) | DML は 200 件の塊で決まった手順で処理し、共有の評価と outbox は確定の直前に 1 回だけ行う | accepted |
| [0009](0009-formula-language-and-evaluator.md) | 数式は表計算に寄せた独自の言語にし、決定性で 4 つに分け、値は参照先を全て読める人にだけ返す | accepted |
| [0010](0010-record-tables-partitioning-and-pivots.md) | records とピボットを shard_no で LIST 分割し、ピボットの索引は指定のある項目に空の値も含めて書く | accepted |
| [0011](0011-recycle-bin-and-purge.md) | 削除は印と削除の束で表し、15 日で確定して 24 時間以内に消す。ごみ箱の間は索引と一意の行を外す | accepted |
| [0012](0012-derived-copies-consistency-and-projections.md) | ピボットと射影は正本の写しとして同じトランザクションで書き、整合の検査で差を 0 に保つ。射影は S2 以降に大口の組織にだけ作る | accepted |
| [0013](0013-permission-sets-and-field-level-security.md) | 権限は権限セットで与えて和で合わせ、プロファイルは既定値と基本の権限セットの入れ物にする。読めない項目は存在しない項目と同じに扱う | accepted |
| [0014](0014-owd-roles-groups-and-closure.md) | OWD の変更は述語の切り替えだけにし、利用者本人とキューもグループとして、ロール階層を含む閉包を 1 つの表にまとめる | accepted |
| [0015](0015-sharing-reasons-and-where-they-live.md) | 所有者の条件のルールと暗黙の子は問い合わせの時に、レコードの条件のルール・手動・チーム・暗黙の親は行に持つ。暗黙の親は子ごとの行にする | accepted |
| [0016](0016-recalculation-rule-versions-and-skew.md) | 再計算の単位をレコードの条件のルールの版と閉包の世代にし、切り替えの前に標本で照合する。スキューは 1 万件で警告する | accepted |
| [0017](0017-reference-access-evaluator.md) | 参照の評価器を決定表をそのまま書いた純粋な関数にし、性質ベーステストと本番の標本の照合に使う。多く見せる食い違いはセキュリティの呼び出しにする | accepted |
| [0018](0018-record-query-language.md) | 問い合わせの言語は SQL に寄せた独自の言語にし、親へのドットと 1 段の子の副問い合わせでたどり、3 値の論理と正規化した文字列の比較にする | accepted |
| [0019](0019-selectivity-statistics-and-planning.md) | 組織ごとの自前の統計と本家に寄せた閾値で駆動の条件を選び、実体化した CTE で順を固定し、見積もりが外れたら 1 回だけ計画し直す | accepted |
| [0020](0020-rest-api-shape-and-versioning.md) | REST API は /api/v1 の下で足す変更だけをし、レコードの JSON はシステムの値と fields を分けて数を文字列で返す。カーソルは暗号化したキーセットにする | accepted |
| [0021](0021-lead-conversion-and-activity-parents.md) | リードの変換は 1 つのトランザクションの合成の DML にする。活動は主の親 1 つと割り当てられた本人で共有を決める | accepted |
| [0022](0022-duplicate-rules-and-japanese-matching.md) | 重複の照合は同じトランザクションで書く正規化した照合の鍵で候補を引き、評価器で判定する。日本語は表で正規化し、見えないレコードとの重複は既定で知らせない | accepted |
| [0023](0023-layouts-and-record-page-composition.md) | レイアウトを部品にコンパイルし、レコードのページを 1 回の要求で組み立てる。レイアウトは狭めるだけで、画面の保存にだけ効く | accepted |
| [0024](0024-list-views-as-filter-ast.md) | リストビューを条件の AST で保存し、見る人の権限で毎回コンパイルする。共有は定義だけで、読めない項目を条件に持つビューは開けない | accepted |
| [0025](0025-flow-definition-and-bulk-engine.md) | フローは版を持つ JSON のグラフにし、塊の実行を足並みをそろえて進める解釈器で動かす。要素の実行は足並みの 1 歩で数える | accepted |
| [0026](0026-record-triggered-flow-order-and-recursion.md) | レコードの変更で動くフローを DML の手順 3・7・13 と予定の経路に置き、実行の順の番号で並べ、同じフローは同じレコードに 1 トランザクションで 1 回だけ動かす | accepted |
| [0027](0027-roll-up-summaries-incremental-with-reconciliation.md) | 積み上げ集計は子の変更から差分で直し、最小・最大が外れた時だけ集計し直す。整合の検査で差を 0 に保ち、集計する子の項目も読める人にだけ返す | accepted |
| [0028](0028-approval-processes-and-record-locks.md) | 承認はプロセスの版・インスタンス・作業の項目の状態で持ち、応答ごとに 1 トランザクションにする。申請中はロックの表で守り、承認者にアクセスを与えない | accepted |
| [0029](0029-report-execution-on-reader-per-viewer.md) | レポートは見る人の権限で毎回コンパイルし、結ぶ全てのオブジェクトに共有の条件と FLS をかけて reader で集計する。見る人をまたぐ事前の集計を持たない | accepted |
| [0030](0030-dashboards-viewer-intersection-and-subscriptions.md) | ダッシュボードは見る人の権限で集計し、部下の視点は部下と見る人の権限の共通部分にする。指定した実行ユーザーの形は持たず、定期の配信は受け取る人ごとに実行する | accepted |
| [0031](0031-search-index-and-japanese-analysis.md) | 検索の索引は共有の 16 個の索引に組織で振り分け、日本語は形態素と 2-gram の 2 つで持ち、outbox から row_version を外部の版にして作る | accepted |
| [0032](0032-search-permission-post-filter.md) | 検索の結果は候補とし、オブジェクトの権限と FLS は前に絞り、レコードの共有はデータ層の問い合わせで後に確かめる。件数の合計を返さない | accepted |
| [0033](0033-change-event-log-and-replay.md) | 変更のイベントは outbox からイベントの専用の Aurora に書き、論理シャードの唯一の書き手が確定の順の replay_id を付けて 3 日保つ | accepted |
| [0034](0034-event-subscription-access-and-org-events.md) | 変更のイベントの購読はオブジェクトの view_all を要し、共有で絞らず FLS を配信の時にかける。組織が定義するイベントは型の権限で守り、既定で確定の後に発行する | accepted |
| [0035](0035-webhooks-outbound-calls-and-ssrf-guard.md) | Webhook はイベントのログの上の宛先ごとのカーソルで送って <Brand>-Signature で署名し、外向きの呼び出しは登録した宛先だけにし、どちらも宛先を検査して内部に経路のない送信の網から送る | accepted |
| [0036](0036-bulk-jobs-chunking-and-partial-success.md) | 一括の取り込みは 1 万行の部分を公平な順番に入れ、200 行ずつの非同期のトランザクションで行ごとに結果を返し、失敗は原因ごとにやり直す | accepted |
| [0037](0037-import-wizard-upsert-and-duplicate-matching.md) | インポートのウィザードは一括のジョブの上の画面にし、upsert と照合での既存の更新は同じ鍵の行を同じ部分に集めて順に処理し、見えない一致は無いものとして扱う | accepted |
| [0038](0038-sandbox-types-and-masked-copy.md) | Sandbox は 4 種類にし、ID をそのまま新しい org_id へ写し、個人データは複製の経路の中で Sandbox ごとの鍵の偽の値に置き換える | accepted |
| [0039](0039-metadata-package-format.md) | メタデータのパッケージは部品ごとの YAML と目録の zip にし、参照は API の名前だけで書き、書き出しを正規化する | accepted |
| [0040](0040-deploy-validation-and-rollback.md) | デプロイは計画を作る検証と 1 つの版で当てる適用に分け、ロックの中は版の確かめと書き込みだけにし、戻しは逆の差分の新しいデプロイにする | accepted |
| [0041](0041-limits-registry-and-counting-rules.md) | 上限の正本を 1 つの登録簿にし、フローは足並みの 1 歩で、積み上げ集計の集計し直しは取得の行の外で数え、レポート・一括の問い合わせ・検索は別の予算で抑える | accepted |
| [0042](0042-org-allocations-fair-queuing-and-limit-info.md) | 割り当ては 24 時間の移動の窓で数えて有料の本番だけ 110% まで通し、Worker は組織の仮想時刻で公平に回し、上限の情報は見出しと /limits で返す | accepted |
| [0043](0043-orgs-editions-licenses-and-users.md) | 組織は種類と状態を持って 30 日の猶予の後に消し、エディションは割り当てと機能だけを変え、ライセンスを権限の上限にし、利用者は消さずに無効にする | accepted |
| [0044](0044-authentication-better-auth-sso-and-mfa.md) | ログインは自前でホストする Better Auth にし、組織ごとの SAML・OIDC の SSO を持ち、Auth0 の題材を IdP にしない。SSO 以外は MFA を必須にし、画面の API はセッションの Cookie だけで通す | accepted |
| [0045](0045-system-permissions-and-delegation.md) | システムの権限を 25 にして依存を決め、権限を渡す人は自分の権限の部分集合しか渡せず、自分より強い利用者を操作できず、最後の管理者を無くせない | accepted |
| [0046](0046-setup-audit-trail-and-login-history.md) | 監査のイベントは変更と同じトランザクションで追記だけの表に書き、組織ごとのハッシュの鎖と毎日の Object Lock の錨で改ざんを見つける。画面は 180 日、ログインの履歴は 180 日 | accepted |
| [0047](0047-field-history-tracking-and-retention.md) | 項目の変更の履歴は 1 オブジェクト 20 項目まで、最上位の最後の値との差を同じトランザクションの outbox に書き、別のクラスタの月ごとの分割に写して 18 か月保ち、読みは見る人の共有と FLS で絞る | accepted |
| [0048](0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md) | 利用者のコードは QuickJS-ng を WASM にしたものを、Runtime の隣の別のプロセスの Wasmtime で燃料とメモリーの上限を付けて動かす | accepted |
| [0049](0049-triggers-in-dml-order-and-platform-api.md) | トリガーは DML の手順 3・7・13 にフローと並べて置き、塊ごとに 1 回呼ぶ。ホストの API はデータ層の AST だけにし、既定は実行する利用者の権限で動かす | accepted |
| [0050](0050-packages-namespaces-and-code-isolation.md) | パッケージは名前空間の接頭辞と署名を持つメタデータの束にし、上限は組織と共有して名前空間ごとに計測する。コードの秘密は宛先の登録だけで渡す | accepted |
| [0051](0051-leak-path-register-and-threat-model.md) | 組織をまたぐ漏えいと、見えないデータの漏えいの経路を 1 つの登録簿にし、経路ごとに否定側のテストと本番の検査を必須にする | accepted |
| [0052](0052-key-hierarchy-and-per-org-data-keys.md) | KMS の鍵はセルと用途ごとに持ち、組織ごとのデータキーで S3 の組織のファイルとアプリの秘密を暗号化する。レコードは DB の保存時の暗号化だけにし、組織の削除は鍵の破棄で仕上げる | accepted |
| [0053](0053-operator-access-and-data-lifecycle.md) | 運用者は組織の管理者の許可と期限つきの権限でだけ組織のデータに触れ、全ての操作を組織の監査に残す。データの種類ごとに保持と消去の期限を 1 つの表で持つ | accepted |
| [0054](0054-accounts-network-and-service-separation.md) | アカウントを管理・監査・本番・送信で分け、本番の VPC の中で対話・管理・一括・Worker・コードの実行を別のサービスとロールにする。送信の VPC と監査のアカウントは本体への経路を持たない | accepted |
| [0055](0055-shard-placement-and-stage-criteria.md) | 論理シャードを物理のクラスタに表で割り当て、組織ごとの上書きを持つ。段階を上げる基準を writer の CPU・保存の量・最大の組織の大きさで決める | accepted |
| [0056](0056-org-migration-by-row-filtered-logical-replication.md) | 組織の移動は org_id の行の絞りを付けた論理レプリケーションで写して追いつき、数十秒の書き込みの止めの間に照合して置き場所を切り替える | accepted |
| [0057](0057-disaster-recovery-osaka-warm-standby.md) | 大阪に Aurora Global Database の副と縮めた ECS を置く温かい待機にし、検索の索引と Valkey は切り替えの後に作り直す。切り替えは人が決め、失った範囲を outbox と replay_id で知らせる | accepted |
| [0058](0058-slis-and-per-org-resource-metrics.md) | SLI は経路ごとに合成監視とサーバーの計測で持ち、組織ごとの使用量は DB の表に全件、メトリクスには上位の組織だけを出す。ログとトレースには組織の ID を持たせ、個人データを入れない | accepted |
| [0059](0059-noisy-neighbor-detection-two-sources.md) | 騒がしい隣人は、アプリの DB の時間と、DB の側の実行中のセッションの標本の 2 つで見つけ、自動の対処は Worker の重みまでにし、対話の経路の絞りは人が決める | accepted |
| [0060](0060-load-model-and-sizing-review.md) | 負荷と大きさは capacity.md の式で持ち、E3・E4・E12 の計測で係数を置き換える。S1 の主のクラスタは writer 1 台に reader 2 台で始め、項目の変更の履歴は S1 から別のクラスタに置く | accepted |
| [0061](0061-access-decision-and-limit-gates-in-ci.md) | 決定表・性質・上限・漏えいの経路を CI の関門にし、上限の登録簿は設計の記録の governor-limits.md と機械的に比べる | accepted |
| [0062](0062-security-sensitive-change-flow.md) | security:sensitive はパスで自動で付け、テックリードとセキュリティの担当の 2 人の承認、追加の CI、組織の単位の段階的なリリースを必須にする | accepted |
| [0063](0063-org-staged-release-and-shadow-evaluation.md) | リリースは組織を単位に段階で広げ、アクセスの判定・問い合わせのコンパイルを変える時は、新旧を本番の標本で並べて比べる影の実行を経る | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

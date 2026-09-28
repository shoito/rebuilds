# Decisions: ServiceNow

ServiceNow の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は ADR-0006、本家の実装を使わない規則は ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、記録の基盤を自前で実装する。本家のスクリプトの API との互換は求めない | accepted |
| [0002](0002-tenancy-and-isolation.md) | 共有のセルでの RLS のマルチテナントを既定にし、大口の企業には同じ版の専用のセルを出す | accepted |
| [0003](0003-table-hierarchy-and-extensible-schema.md) | テーブルはクラスの継承の階層として辞書に持ち、組み込みのクラスは型付きの列、テナントの拡張は JSONB と型付きの索引の表で持つ | accepted |
| [0004](0004-workflow-and-sla-engine.md) | ワークフロー・承認・SLA は Aurora の上の自前の耐久性のあるエンジンで動かし、遷移をレコードと同じトランザクションで 1 回だけ行う | accepted |
| [0005](0005-cmdb-identification-and-reconciliation.md) | CI の作成・更新を識別と調整の 1 つの入口に集め、正規化した識別の値の一意の索引で重複を防ぐ。関係のグラフは PostgreSQL に持つ | accepted |
| [0006](0006-data-dictionary-and-field-types.md) | 辞書は組み込みの定義とテナントの定義を重ねて持ち、フィールドの型を 14 種に限る。子のクラスは属性を上書きできるが型は変えられない | accepted |
| [0007](0007-physical-layout-and-extension-index.md) | `task`・`ci` を階層ごとに 1 つの表に置き、S1 ではパーティションに分けない。参照のフィールドは必ず索引の表に写す | accepted |
| [0008](0008-record-numbering.md) | 番号はテナント・番号の定義ごとの数の行から、保存とは別の短いトランザクションで取る。欠番のないことは約束しない | accepted |
| [0009](0009-record-audit-history-and-journal.md) | 監査の履歴は保存ごとに 1 行、変更と同じトランザクションで追記だけの表に書く。日ごとのハッシュの鎖を S3 Object Lock に置く | accepted |
| [0010](0010-metadata-versions-and-config-packages.md) | メタデータの変更はテナントの版の番号を上げる 1 つのトランザクションで行う。設定の移送は、安定したキーと元の版のハッシュを持つパッケージで行う | accepted |
| [0011](0011-roles-groups-and-acl-evaluation.md) | ACL は許可の条件と拒否の条件の 2 種の規則で書き、拒否は階層のすべての段で、許可は最も近いクラスの段で評価する。一致する許可がなければ拒否する | accepted |
| [0012](0012-acl-enforcement-at-every-exit.md) | 行の規則の条件は SQL の述語にコンパイルできる式に限り、読めないフィールドの値は利用者にとって NULL として扱う。判定の材料は `acl_version` をキーにキャッシュする | accepted |
| [0013](0013-impersonation-and-tenant-sso.md) | 成り代わりは権限を広げず、承認・権限の変更・エクスポートをさせない。テナントの SSO は複数の IdP を持ち、SP 起点を既定にし、非常用の管理者を残す | accepted |
| [0014](0014-flow-dsl-and-versioning.md) | フローは決まったノードと式の言語だけの JSON の文書で書き、公開すると不変の版になる。実行は開始したときの版に固定し、移し替えない | accepted |
| [0015](0015-flow-execution-and-timers.md) | 実行は `flow_run`・`flow_step`・`timer` の表で持ち、1 回の進みを 1 つのトランザクションで行う。トリガーは保存と同じトランザクションで実行を作る | accepted |
| [0016](0016-approvals.md) | 承認はまとまりと個々の承認の 2 つの行で持ち、回答を版の条件付きで 1 回だけ反映する。本人の承認を既定で禁止し、承認の記録が要るテーブルでは期限切れの自動の承認とメールの返信での承認を受けない | accepted |
| [0017](0017-no-code-record-rules.md) | レコードのルールは保存の前・保存の後・非同期の 3 種で、決まった操作だけを持つ。連鎖の深さを 3 にし、超えたら全体を巻き戻す | accepted |
| [0018](0018-flow-limits-and-tenant-fairness.md) | テナントごと・実行ごとの上限を置き、タイマーの取得をテナントごとの取り分で行い、SLA と承認の発火をフローのステップより先にする | accepted |
| [0019](0019-business-calendar-and-pure-time-functions.md) | カレンダーは不変の版で持ち、計時は秒の単位の半開区間の上の純粋な関数 2 つで行う。祝日はその暦の日の 0〜24 時を除き、期限は業務時間がちょうど d になる最も早い時刻とする | accepted |
| [0020](0020-japanese-holiday-data.md) | 内閣府の祝日の CSV を定期に取りに行き、法の規則との突き合わせと人の承認を経て版として公開する。収録の範囲の外は祝日なしで計算し、後で計算し直す | accepted |
| [0021](0021-sla-definitions-and-timers.md) | SLA の計時の行は定義の版・カレンダーの版・タイムゾーンを開始の時に固定し、条件を保存と同じトランザクションで決まった優先の順に評価する。警告と違反はタイマーで発火し、違反の事実は後の計算し直しで取り消さない | accepted |
| [0022](0022-process-state-machines.md) | インシデント・問題・変更の状態は、コードの版に含む宣言の遷移の表で持つ。テナントは状態と辺を足せず、条件と保留の理由だけを足せる。既知のエラーは状態ではなく印にする | accepted |
| [0023](0023-priority-matrix-and-major-incident.md) | 優先度は影響度 × 緊急度の表から導き、直接は書かせない。メジャーインシデントは候補の行で扱い、自動では昇格させず、候補のインシデント自体を親にする | accepted |
| [0024](0024-change-models-risk-and-cab.md) | 変更は種類ごとの状態のモデルで扱い、リスクは規則と質問票の高いほうにする。承認の方針は種類 × リスクの決定表で決め、CAB の決定も各承認者の回答として反映する。緊急の変更も承認なしに実施へ進めない | accepted |
| [0025](0025-change-schedule-and-conflict-detection.md) | 禁止期間と保守の時間帯はカレンダーと同じ区間の表現で CI の条件に結び付けて持ち、衝突は純粋な関数で求める。禁止期間と凍結期間だけを実施の妨げにし、ほかの衝突は警告にする | accepted |
| [0026](0026-assignment-rules-and-member-selection.md) | 割り当ての規則は順序付きで最初に一致した 1 つだけを使い、人が入れた割り当てを上書きしない。担当者はメンバーの行を SKIP LOCKED で取って選ぶ | accepted |
| [0027](0027-on-call-rotations-and-escalation.md) | 当番表は不変の版の層と差し替えで持ち、当番を純粋な関数で求める。呼び出しは専用の状態機械とタイマーで進め、本人の受け付けで止める。経路は差し込み口にし、MVP はメールとプッシュだけにする | accepted |
| [0028](0028-catalog-items-and-variables.md) | カタログの品目は公開で不変の版になり、申請の時の版に固定する。変数は 12 種と配置の 2 種に限り、表示の条件は画面とサーバーで同じ評価器を使ってサーバーを正とする | accepted |
| [0029](0029-request-item-task-model.md) | 1 回の申請で要求と要求の品目を 1 つのトランザクションで作り、依頼者の冪等のキーで 1 回だけにする。要求の品目ごとに固定した版の実行のフローを動かし、要求の状態は子から導く | accepted |
| [0030](0030-portal-requester-scope-and-record-producers.md) | 依頼者は自分が依頼した・自分のための・見守りに入った要求だけを見る。変数ごとに依頼者への公開を持ち、他人のための申請は品目の許可と関係があるときだけ許す。フォームからのレコードの作成も依頼者の主体で保存する | accepted |
| [0031](0031-knowledge-articles-versions-and-publishing.md) | ナレッジの記事は記事の行と版の行で持ち、公開中と編集中の版をそれぞれ高々 1 つにする。レビューに出した本文を固定し、承認した本文だけを公開する。本文は制限付きの Markdown だけにする | accepted |
| [0032](0032-knowledge-feedback-and-deflection.md) | 評価は利用者・版ごとに 1 件にし、旗は理由を必須にして持ち主のタスクにまとめる。自己解決は仮名のセッションの事象から、明示と推定を分けて数える | accepted |
| [0033](0033-notification-rules-and-outbound-email.md) | 通知は Notifier で受け手ごとに作り、`(事象, 規則, 受け手, 経路)` の一意で 1 回だけ送る。本文は受け手の主体で ACL を判定して差し込み、送るメールには推測できない参照の印を付け、返信は印と SES が付けた `Message-ID` で紐付ける | accepted |
| [0034](0034-inbound-email-threading-and-sender-trust.md) | 受信は共有の入口（SES → S3 → SQS → mail-router）からセルの Ingest へ送り、SES の ID で冪等にし、転送 → ヘッダー → 参照の印 → 件名の番号（関係者だけ）の順で紐付ける。差出人は認証の結果で信頼の段階を決め、返信の追記は差出人の主体の ACL を通す | accepted |
| [0035](0035-mail-loop-prevention-and-japanese-decoding.md) | 自動のメールはヘッダーで見分けて自動の応答を返さず、不在の返信は追記しない。流量の上限を最後の守りにする。文字コードは WHATWG の対応で復号し、ラベルのない 8 ビットは UTF-8 → Shift_JIS → EUC-JP の順に試し、送るメールは UTF-8 だけにする | accepted |
| [0036](0036-ci-classes-and-identification-rules.md) | CI のクラスは組み込みの階層にテナントが子を足す形で持ち、識別の規則は優先度付きの識別の項目の一覧にする。複数の値の属性は値ごとに、取り込み元の固有のキーは最も優先の項目にし、クラスの違う一致でもクラスを変えない | accepted |
| [0037](0037-ci-ingest-entry-point-and-ambiguity-hold.md) | CI の入口は項目ごとに 1 つのトランザクションで識別と調整を行い、一致は使えるすべての識別の項目の和集合で決める。一意の制約の違反で識別をやり直し、2 つ以上の CI に一致したら候補の集合ごとに 1 つの保留にする。統合は人だけが行う | accepted |
| [0038](0038-attribute-reconciliation-per-source-state.md) | 属性の調整は CI・取り込み元ごとの最新の観測の状態を max の結合で持ち、値をその状態の集合から純粋な関数で選ぶ。鮮度はその属性の最新の観測の時刻から測る。関係の有無も取り込み元ごとの状態から決める | accepted |
| [0039](0039-ci-relations-impact-traversal-and-service-model.md) | 関係は型ごとに影響の向きを持つ表にし、影響の範囲は深さ 6・節 10,000・2 秒で打ち切る再帰の CTE で求める。画面の走査は見る人の ACL を押し込み、変更の評価はシステムの主体で走査して写しを残す。サービスのモデルは CSDM に寄せたクラスで持つ | accepted |
| [0040](0040-metadata-driven-forms-and-lists.md) | フォームとリストはサーバーがコンパイルした画面のモデルを描く。画面の規則は画面とサーバーで同じ評価器を使いサーバーを正とし、リストはキーセットのページ送りと上限付きの件数にする | accepted |
| [0041](0041-employee-portal-themes-widgets-and-push.md) | 従業員のポータルは同じホスト名の別の画面の束にし、見た目はテーマのトークンと決まった部品だけで変える。プッシュは Web Push で送り、ネイティブのアプリは MVP で作らない | accepted |
| [0042](0042-i18n-ja-en-and-translations.md) | 画面の決まった文言はコードの版の ICU MessageFormat の辞書に、テナントの文言は安定したキーの翻訳の表に持つ。言語は利用者 → テナント → 日本語の順に決め、日時は UTC で保存し見る人のタイムゾーンで出す | accepted |
| [0043](0043-japanese-analyzer-and-index-layout.md) | 日本語の解析器は Sudachi を既定にし、2 文字の n-gram を併せて持つ。索引はセルのドメインに種類ごとの共有の索引を置いて `tenant_id` で経路を決め、テナントのフィールドは入れ子の枠に入れる | accepted |
| [0044](0044-acl-aware-search-and-index-freshness.md) | 検索は ACL の述語の索引で表せる部分を絞り込みにし、返す直前に DB で行とフィールドの読み取りを確かめ直す。一致と強調を読めるフィールドに限り、総数を出さない。索引は DB の今の行を外部の版で入れる | accepted |
| [0045](0045-report-execution-on-reader-and-daily-facts.md) | 集計は S1 ではセルの Aurora のレポート用の reader で問い合わせの時に行い、推移のための過去の状態は日次の事実の表（行の写し）に持つ。集計の結果を事前に計算せず、S2 で PostgreSQL と互換の分析のクラスタへ移す | accepted |
| [0046](0046-acl-aware-aggregation-and-per-recipient-delivery.md) | 集計は見る人の行の述語と `visible(f)` の上で行い、読めない値を空の値と区別しない。結果のキャッシュは主体を当てはめた問い合わせのハッシュで共有し、定期の配信は受け手ごとに計算してテナントの有効な利用者だけに送る | accepted |
| [0047](0047-sla-attainment-and-breach-disputed.md) | SLA の達成率は期間の中に停止した計時の行を母数にし、`breach_disputed` の行は厳格と調整の 2 つの値と件数で出す。既定の表示は厳格にする | accepted |
| [0048](0048-dictionary-driven-table-api.md) | REST のテーブルの API は実効の辞書から型を作る 1 組のエンドポイントにし、リストと同じ式の言語、キーセットのページ送り、`If-Match`、`Idempotency-Key` を持つ。連携のクライアントは OAuth 2.0 のクライアントクレデンシャルで、主体は `integration` の利用者にする | accepted |
| [0049](0049-import-sets-and-transform-maps.md) | 一括の取り込みは取り込みの行の表に原本を置いてから、版付きの変換の対応で 1 行ずつ Record Service を通して書く。一致のキーは索引のあるフィールドに限り、キーごとの助言ロックで重複を防ぎ、2 つ以上に一致したら行のエラーにする。CI への取り込みは CMDB の入口を通す | accepted |
| [0050](0050-signed-webhooks-and-tenant-rate-limits.md) | Webhook は値を入れない薄い事象を、Standard Webhooks に寄せた HMAC-SHA256 の署名で少なくとも 1 回送り、送る時点で購読の主体の ACL で確かめる。レート制限はテナントとクライアントのトークンバケットで、使いすぎは 429、容量の都合は 503 にする | accepted |
| [0051](0051-threat-model-and-security-checklist.md) | 脅威は信頼境界と部品ごとの STRIDE で洗い出し、対策を `SEC-NNN` のチェックリストにして各行に拒否の側のテストを持たせる。ACL・テナントの分離・監査・承認に触れる変更は `security:sensitive` にする | accepted |
| [0052](0052-keys-encryption-and-operator-access.md) | 鍵はセルごと・用途ごとの KMS のマルチリージョンの鍵にし、テナントの秘密をテナントごとの DEK で包む。運用者はテナントのデータへの常設の権限を持たず、テナントが出すサポートの参照の許可と期限付きの権限でだけ読む。AI エージェントは本番に経路を持たない | accepted |
| [0053](0053-data-retention-and-deletion.md) | 保持の期間を種類ごとに既定案として決め、時間で消える表は時間のパーティションで持つ。テナントの削除は 30 日の猶予の後に全置き場所から消し、個人の削除の請求は利用者の行の仮名化で受ける。監査の履歴との関係は法務の L1・L4 まで保留する | accepted |
| [0054](0054-shared-reference-rows-and-cross-tenant-roles.md) | `tenant_id` が NULL の行は、全テナントに同じで機密でない参照のデータだけに許し、RLS は読み取りだけで通す。テナントをまたいで読む DB のロールは、識別子だけを返す関数に限る | accepted |
| [0055](0055-accounts-cells-and-edge-router.md) | セルごとに AWS アカウントを分け、制御の面・エッジ・メールの受信の入口を別のアカウントに置く。ルーターは CloudFront Functions と KeyValueStore でホスト名からセルを選び、セルの App はテナントを解決し直す | accepted |
| [0056](0056-dedicated-cells-and-tenant-moves.md) | 専用のセルは 1 つの顧客のための共有のセルと同じ形のセルにし、同じコード・同じ版で動かす。テナントのセル間の移動は、写し・差分・短い停止・ルーターの切り替え・索引の作り直しの手順で行う | accepted |
| [0057](0057-disaster-recovery-per-cell.md) | DR はセルごとに大阪のウォームスタンバイを持ち、人の判断で切り替える。検索の索引は複製せず切り替えの後に DB から作り直し、失った範囲の受信のメールは S3 の原本から冪等に取り込み直す | accepted |
| [0058](0058-terraform-layout-stages-and-cost.md) | Terraform はセルを 1 つのモジュールとして持ち、セルの一覧のファイルから作る。セルを足す・段階を上げる基準を決め、費用をセル・アカウント・タグで配分する | accepted |
| [0059](0059-slis-timer-lag-and-correctness-monitors.md) | 可用性はエッジで、画面の速さはサーバーの計測と自前の RUM で数える。タイマーと SLA の違反の発火の遅れはコミットの時刻と期限の差で数え、期限を過ぎた未発火の数を別に数える。正しさの監視を SLI と同じ扱いにする | accepted |
| [0060](0060-alerts-and-runbook-mapping.md) | 呼び出しのアラートは SLO のバーンレート、正しさの監視の違反、セキュリティの症状に限り、すべてのアラートに runbook を注釈で持たせて CI で確かめる。個別の runbook ができるまでは incident-response の場面を指す | accepted |
| [0061](0061-load-model-cell-sizing-and-timer-bursts.md) | セルは S1 の負荷の半分を 1 つの Aurora の writer で受ける大きさにし、9 時のタイマーの山は優先度・定期のトリガーのばらつき・平日 8:50 の予定の台数の拡大で受ける。優先度 2・3 の遅れは山の間 5 分まで許す | accepted |
| [0062](0062-spec-driven-ci-fault-injection-and-leak-suite.md) | CI は `spec.md` の決定表を直接読み込んで動かし、性質ベーステスト・障害注入・出口ごとの漏れの試験を、PR（変更に関わるもの、短い版）と夜間（全体）の 2 段で必須にする | accepted |
| [0063](0063-flags-and-staged-release-per-cell.md) | デプロイは制御の面 → カナリアのセル → 共有のセル → 専用のセルの段で行い、振る舞いはフラグで社内 → サブプロダクション → 本番の段で広げる。業務の振る舞いの変更は、顧客が最大 60 日の中で有効にする時期を選べる | accepted |
| [0064](0064-migrations-and-metadata-compatibility-check.md) | DB は expand・移行・contract の 3 段、組み込みの定義はコードの版で変え、フローの意味は `engine_schema` で分ける。デプロイの前に、各セルの中で新しいコードが全テナントの今のメタデータをコンパイルできることを確かめる | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

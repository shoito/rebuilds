# Architecture: Salesforce

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧、持ち主、ADR の番号の範囲は 7 節にある。品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用の手順は [runbooks/](../runbooks/README.md) にある。

## 1. 全体構成

### 1.1 コンテキスト

```
 営業の担当者・管理職（ブラウザ）          組織の管理者（Setup の画面、Sandbox からのデプロイ）
      │ レコード・リストビュー・レポート            │ メタデータの変更・デプロイ
      ▼                                             ▼
┌──────── 本システム（組織ごとのホスト名 <org>.my.<brand>.<domain>）────────┐
│  Web の画面・REST API・一括の API・メタデータの API・フロー・レポート              │
└────────────────────────────────────────────────────────────────────┘
      ▲ REST・一括の API                 ▲ SSO（SAML・OIDC）          │ 外向き
      │                                  │                             ▼
 連携の開発者（基幹システム、名刺管理、MA）   利用者の IdP          Webhook の受け手、変更のイベントの購読者、
                                                                   メールの送信事業者
```

### 1.2 コンテナ

```
            ┌──────── CloudFront＋WAF（静的な資産、IP のレート制限）────────┐
            └──────┬───────────────────────┬──────────────────────┬──────┘
                   │ 対話の経路（画面・API）  │ 一括の経路              │ 管理の経路
                   ▼                        ▼                        ▼
           ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────────┐
           │ Runtime（API）     │   │ Bulk（ジョブの受付）│   │ Metadata（Setup・デプロイ）│
           │ 問い合わせ・DML の  │   └────────┬─────────┘   └──────────┬───────────┘
           │ コンパイルと実行     │            │ ジョブ                   │ メタデータの版
           │ 権限・共有・上限    │            ▼                          │
           └──┬──────────┬────┘      SQS ─▶ Worker（一括の処理、共有の再計算、
              │          │                    スケジュールのフロー、レポートの非同期の実行、
              │          │ コンパイル済みの      検索の索引、Webhook・メールの送信の依頼、
              │          ▼ メタデータ・上限の数   Sandbox の複製、項目の型の変換）
              │      Valkey                         │ 署名済みの要求（SQS）
              ▼                                     ▼
        Aurora PostgreSQL（主。メタデータ、         prod-egress のアカウントの sender
        records＋ピボット、共有の表、監査、           ─▶ Webhook・外向きの呼び出しの宛先
        outbox。RLS）
              │ outbox                           │ reader
              ▼                                  ▼
          Relay ─┬▶ events の Aurora（変更のイベント、3 日）─▶ 購読者
                 └▶ history の Aurora（項目の変更の履歴、18 か月）
                                             Reports（集計）   OpenSearch（全文検索）
```

| コンテナ | 責務 |
| --- | --- |
| Runtime | 画面と API の要求を受け、問い合わせと DML をメタデータに対してコンパイルし、権限・FLS・共有の判定と上限の計測をして実行する。レコードの変更で動くフローを同じトランザクションで動かす（[ADR-0003](../decisions/0003-metadata-driven-runtime.md)） |
| Metadata | オブジェクト・項目・レイアウト・フロー・権限の変更とデプロイ。組織のメタデータの版を上げる唯一の入口 |
| Bulk | 一括のジョブの受付と状態。処理は Worker で、同じ Runtime のライブラリを使う |
| Worker | 遅れてよい処理。組織ごとに公平に順番を回す（[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)） |
| Aurora（主） | 唯一の正本。組織を RLS で分ける。カスタムオブジェクトも標準オブジェクトも共有の表に入れる（[ADR-0002](../decisions/0002-custom-object-storage.md)） |
| Relay、Aurora（`events`・`history`） | 主の outbox を論理シャードごとの唯一の書き手が読み、変更のイベント（3 日）と項目の変更の履歴（18 か月）を別のクラスタに写す（[ADR-0033](../decisions/0033-change-event-log-and-replay.md)、[ADR-0047](../decisions/0047-field-history-tracking-and-retention.md)）。保存の DB の負担と保存の量を主から切り離す |
| sender（prod-egress） | 本番と別のアカウントから、署名済みの Webhook・外向きの呼び出しを送る。本番への経路を持たない（[ADR-0035](../decisions/0035-webhooks-outbound-calls-and-ssrf-guard.md)、[ADR-0054](../decisions/0054-accounts-network-and-service-separation.md)） |
| Valkey | コンパイル済みのメタデータのキャッシュ、上限・割り当ての数。失われてもよい |
| OpenSearch | 全文検索の索引。正本の写しで、作り直せる |

原則は 5 つ。

- **メタデータが振る舞いを決める。** 組織ごとの違いはコードでも DB の構造でもなく、版の付いたメタデータで持つ（[ADR-0003](../decisions/0003-metadata-driven-runtime.md)）。
- **DB の構造は全組織で同じ。** カスタムオブジェクトを足しても DDL は走らない（[ADR-0002](../decisions/0002-custom-object-storage.md)）。
- **アクセスの判定は 1 か所で、事前計算した表で速く行う。** どの経路も同じ判定を通る（[ADR-0004](../decisions/0004-record-access-model.md)）。
- **組織で分け、組織で閉じ、組織ごとに上限を置く。** データもメタデータも組織に属し、1 つのトランザクションと 1 つの組織の使う資源に上限がある（[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)）。
- **本家の実装と言語に頼らない。** 設計の考え方は参考にし、実装と言語は自分で作る（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 2. 規模の段階

| 段階 | 組織（うち本番） | 利用者（合計） | レコード（合計） | 最大の組織 | 対話の要求のピーク | 構成 |
| --- | --- | --- | --- | --- | --- | --- |
| S1（MVP） | 5,000（1,000。残りは Sandbox と試用） | 5 万 | 5 億 | 利用者 5,000、レコード 5,000 万 | 2,000 件/秒 | 東京の 1 リージョン・3 AZ。主の Aurora の writer 1 台＋reader 2 台、`events` と `history` の別のクラスタ。論理シャードは 256 で、物理は 1 つ。OpenSearch はデータ 6 台。大阪にウォームスタンバイ |
| S2 | 5 万（1 万） | 50 万 | 50 億 | 利用者 3 万、レコード 5 億 | 2 万件/秒 | 論理シャードを複数の Aurora のクラスタに割り当てる。Sandbox と試用の組織を本番とは別のクラスタへ。レポートを分析用の写しへ |
| S3 | 50 万（10 万） | 500 万 | 500 億 | 利用者 10 万、レコード 50 億 | 20 万件/秒 | セル構成。組織をセルに固定し、セルの間で組織を動かせる。大口の組織に専用のセル。東京・大阪の両方で受ける |

- 数値は本システムの想定。本家の実数は公開されていない。本家は、大きな組織の例として「取引先 1,000 万件、利用者 7,000 人、ロール 2,000、テリトリー 1,000」を挙げている（[Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)、2026-09-28 に確認）。
- 1 件の対話の要求は、平均で問い合わせを 3〜5 回行う想定。
- 共有の表の行は、非公開の OWD のオブジェクトで、レコードあたり平均 3 行を想定する（所有者は表に持たない。[ADR-0004](../decisions/0004-record-access-model.md)）。
- 段階を上げる判断の基準は、[infrastructure.md](infrastructure.md) の 5 節（[ADR-0055](../decisions/0055-shard-placement-and-stage-criteria.md)）。部品ごとの量と台数の根拠は [capacity.md](capacity.md)。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 画面の速さ | レコードの詳細（レコード、レイアウト、関連リストの最初のページ）の API の p95 300ms、p99 800ms。リストビューの最初のページ（選択的な条件、100 万件まで）の p95 500ms | 本家は、ページの表示の目安を 300ms としている（[Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)）。フローの実行時間を除く |
| NFR-002 | API の速さ | REST のレコード 1 件の読み書きの p95 200ms、p99 500ms。問い合わせ（選択的な条件）の p95 500ms。メタデータの記述の p95 100ms | 自動化の実行時間を除く |
| NFR-003 | 公平（ガバナ制限） | 1 トランザクションの上限を 100% 強制する。上限まで負荷をかけた組織があっても、他の組織の p95 の悪化が 10% 以内 | [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md) |
| NFR-004 | メタデータのデプロイの安全 | デプロイは全部か無しか。検証の失敗で本番が変わる件数 0 件。デプロイの確定の間の、データの書き込みの止まりが p99 1 秒以内。直前の版へ戻すデプロイが 5 分以内に終わる | [ADR-0003](../decisions/0003-metadata-driven-runtime.md) |
| NFR-005 | 共有の再計算 | レコードの保存に伴う共有の変更は、同じトランザクションで反映する。**OWD・`grant_via_hierarchy`・所有者の条件の共有ルールの変更は、述語の切り替え（メタデータの版）だけで、行を書き直さない。反映は K2 と同じ p95 5 秒**。**レコードの条件の共有ルールの追加・変更の再計算は、100 万件・1,000 人の組織で 15 分以内**。ロールの木の移動（閉包の新しい世代）は同じ組織で 5 分以内。再計算の間も、古い構成で判定し続ける | [ADR-0014](../decisions/0014-owd-roles-groups-and-closure.md)、[ADR-0016](../decisions/0016-recalculation-rule-versions-and-skew.md)。2026-09-28 に改めた（下の注記） |
| NFR-006 | 可用性 | 対話の経路（Runtime）の月間 99.9%（本番の組織）。S2 で 99.95% | 本家の標準の SLA は公開の資料に見当たらない。本システムの値は本家に依らない。Sandbox は対象外 |
| NFR-007 | 耐久性と AZ の障害 | 成功を返したレコードとメタデータの変更を失わない。RPO 0、RTO 5 分以内 | |
| NFR-008 | リージョンの障害 | RPO 1 分以内、RTO 1 時間以内 | 大阪へ切り替える |
| NFR-009 | テナントの分離 | 他の組織のデータ・メタデータが見える事象 0 件。Sandbox から本番の組織のデータが見える事象 0 件 | [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md) |
| NFR-010 | 一括の処理と変更のイベント | 一括の登録で、100 万件の取り込みが 30 分以内（自動化が軽い時）。変更のイベントは、確定から購読者に届くまで p95 5 秒以内、少なくとも 1 回、レコードごとの順序を守り、3 日は再生できる | 本家の変更のイベントも 3 日の保持（[Change Data Capture Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_change_data_capture.pdf)、2026-09-28 に確認） |

> 2026-09-28 の注記（NFR-005）：起票の時は「設定の変更（OWD を含む）の再計算は 100 万件・1,000 人の組織で 15 分以内」としていた。[ADR-0014](../decisions/0014-owd-roles-groups-and-closure.md) で、OWD の変更は行を書き直さない述語の切り替えにしたので、OWD には再計算がない。目標を、行を作る再計算（レコードの条件の共有ルールと閉包の世代）に当て直した。ロールの木の移動の 5 分は、最大の組織でも閉包が 5 万行で 1 分未満という見積もり（[capacity.md](capacity.md) の 6 節）に余裕を持たせた値。intent の K6 も同じに直した。

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（サービス・Web） | 他の題材と同じ。メタデータ・AST・決定表を型で扱う（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| HTTP・検証 | Hono＋Zod。API の OpenAPI は組織のメタデータから動的に生成する | 他の題材と同じ。組織ごとにオブジェクトが違うため、固定の型では足りない |
| Web の画面 | React の SPA。ページレイアウトとリストビューはメタデータから描く | ui-layouts-and-list-views の領域で詳しく決める |
| DB | Aurora PostgreSQL 18、RLS、ID は UUIDv7。records と型付きのピボットの索引 | [ADR-0002](../decisions/0002-custom-object-storage.md)、[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md) |
| キャッシュ・数 | ElastiCache（Valkey） | コンパイル済みのメタデータ、上限の数（[ADR-0003](../decisions/0003-metadata-driven-runtime.md)） |
| 全文検索 | Amazon OpenSearch Service。kuromoji と CJK の 2-gram（E5 の PoC で Sudachi と比べる） | [ADR-0031](../decisions/0031-search-index-and-japanese-analysis.md) |
| 非同期 | transactional outbox → Relay（論理シャードごとの唯一の書き手）→ `events`・`history` の Aurora、SQS。Worker の順番は Aurora の `jobs` の表と組織の仮想時刻 | [ADR-0033](../decisions/0033-change-event-log-and-replay.md)、[ADR-0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md) |
| 問い合わせ・数式の言語 | 独自。パーサー、型検査、SQL へのコンパイル、参照の評価器を TypeScript で持つ | [ADR-0003](../decisions/0003-metadata-driven-runtime.md) |
| 利用者のコード（MVP の後、E13） | TypeScript で書き、QuickJS-ng を WASM にしたものを Wasmtime の燃料とメモリーの上限の下で、Runtime の隣の別のコンテナで動かす | [ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md) |
| 認証 | 自前でホストする Better Auth（パスワード＋MFA、パスキー、組織ごとの SAML・OIDC の SSO）。API は OAuth 2.0 | [ADR-0044](../decisions/0044-authentication-better-auth-sso-and-mfa.md) |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs。組織ごとの資源の使用量を計測する | 他の題材と同じ |
| フラグ | AWS AppConfig | 他の題材と同じ |
| テスト | Vitest、fast-check（共有の性質、問い合わせのコンパイラと参照の評価器の一致）、Testcontainers、Playwright、k6 | 他の題材と同じ |

## 5. 主な決定

全ての ADR の一覧（状態を含む）は [decisions/README.md](../decisions/README.md) にある。0001〜0005 が題材の土台で、0006 以降は 7 節の領域ごとの範囲で起票した。全て `accepted`（2026-09-28）。題材の最初の設計の間に直したものは、各 ADR に日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、メタデータの実行基盤を自前で作る。本家の言語との互換は持たない |
| [0002](../decisions/0002-custom-object-storage.md) | レコードを共有の records の表（システムの列＋JSONB）に入れ、型付きのピボットの表で引く |
| [0003](../decisions/0003-metadata-driven-runtime.md) | メタデータを版の付いた不変のスナップショットにコンパイルし、要求を 1 つの版に固定して AST から SQL を作る |
| [0004](../decisions/0004-record-access-model.md) | 共有を事前計算し、所有者とロール階層は閉包の表と結ぶ。設定の変更の再計算は影の世代で切り替える |
| [0005](../decisions/0005-tenancy-and-governor-limits.md) | 組織を共有スキーマと RLS で分け、論理シャードとセルで広げる。上限は実行基盤のデータ層で強制する |
| [0006](../decisions/0006-data-dictionary-and-field-lifecycle.md) | データ辞書は field_id と再利用しない field_no を分けて持ち、型の変換は新しい field_no へ写して切り替え、削除は 15 日保つ |
| [0007](../decisions/0007-segmented-metadata-snapshots.md) | スナップショットを内容で番地を決めたオブジェクトごとの部品と不変の manifest に分け、変わった部品だけをコンパイルし直す |
| [0008](../decisions/0008-dml-order-of-execution.md) | DML は 200 件の塊で決まった手順で処理し、共有の評価と outbox は確定の直前に 1 回だけ行う |
| [0009](../decisions/0009-formula-language-and-evaluator.md) | 数式は表計算に寄せた独自の言語にし、決定性で 4 つに分け、値は参照先を全て読める人にだけ返す |
| [0010](../decisions/0010-record-tables-partitioning-and-pivots.md) | records とピボットを shard_no で LIST 分割し、ピボットの索引は指定のある項目に空の値も含めて書く |
| [0011](../decisions/0011-recycle-bin-and-purge.md) | 削除は印と削除の束で表し、15 日で確定して 24 時間以内に消す。ごみ箱の間は索引と一意の行を外す |
| [0012](../decisions/0012-derived-copies-consistency-and-projections.md) | ピボットと射影は正本の写しとして同じトランザクションで書き、整合の検査で差を 0 に保つ。射影は S2 以降に大口の組織にだけ作る |
| [0013](../decisions/0013-permission-sets-and-field-level-security.md) | 権限は権限セットで与えて和で合わせ、プロファイルは既定値と基本の権限セットの入れ物にする。読めない項目は存在しない項目と同じに扱う |
| [0014](../decisions/0014-owd-roles-groups-and-closure.md) | OWD の変更は述語の切り替えだけにし、利用者本人とキューもグループとして、ロール階層を含む閉包を 1 つの表にまとめる |
| [0015](../decisions/0015-sharing-reasons-and-where-they-live.md) | 所有者の条件のルールと暗黙の子は問い合わせの時に、レコードの条件のルール・手動・チーム・暗黙の親は行に持つ。暗黙の親は子ごとの行にする |
| [0016](../decisions/0016-recalculation-rule-versions-and-skew.md) | 再計算の単位をレコードの条件のルールの版と閉包の世代にし、切り替えの前に標本で照合する。スキューは 1 万件で警告する |
| [0017](../decisions/0017-reference-access-evaluator.md) | 参照の評価器を決定表をそのまま書いた純粋な関数にし、性質ベーステストと本番の標本の照合に使う。多く見せる食い違いはセキュリティの呼び出しにする |
| [0018](../decisions/0018-record-query-language.md) | 問い合わせの言語は SQL に寄せた独自の言語にし、親へのドットと 1 段の子の副問い合わせでたどり、3 値の論理と正規化した文字列の比較にする |
| [0019](../decisions/0019-selectivity-statistics-and-planning.md) | 組織ごとの自前の統計と本家に寄せた閾値で駆動の条件を選び、実体化した CTE で順を固定し、見積もりが外れたら 1 回だけ計画し直す |
| [0020](../decisions/0020-rest-api-shape-and-versioning.md) | REST API は /api/v1 の下で足す変更だけをし、レコードの JSON はシステムの値と fields を分けて数を文字列で返す。カーソルは暗号化したキーセットにする |
| [0021](../decisions/0021-lead-conversion-and-activity-parents.md) | リードの変換は 1 つのトランザクションの合成の DML にする。活動は主の親 1 つと割り当てられた本人で共有を決める |
| [0022](../decisions/0022-duplicate-rules-and-japanese-matching.md) | 重複の照合は同じトランザクションで書く正規化した照合の鍵で候補を引き、評価器で判定する。日本語は表で正規化し、見えないレコードとの重複は既定で知らせない |
| [0023](../decisions/0023-layouts-and-record-page-composition.md) | レイアウトを部品にコンパイルし、レコードのページを 1 回の要求で組み立てる。レイアウトは狭めるだけで、画面の保存にだけ効く |
| [0024](../decisions/0024-list-views-as-filter-ast.md) | リストビューを条件の AST で保存し、見る人の権限で毎回コンパイルする。共有は定義だけで、読めない項目を条件に持つビューは開けない |
| [0025](../decisions/0025-flow-definition-and-bulk-engine.md) | フローは版を持つ JSON のグラフにし、塊の実行を足並みをそろえて進める解釈器で動かす。要素の実行は足並みの 1 歩で数える |
| [0026](../decisions/0026-record-triggered-flow-order-and-recursion.md) | レコードの変更で動くフローを DML の手順 3a・7b・13 と予定の経路に置き、実行の順の番号で並べ、同じフローは同じレコードに 1 トランザクションで 1 回だけ動かす |
| [0027](../decisions/0027-roll-up-summaries-incremental-with-reconciliation.md) | 積み上げ集計は子の変更から差分で直し、最小・最大が外れた時だけ集計し直す。整合の検査で差を 0 に保ち、集計する子の項目も読める人にだけ返す |
| [0028](../decisions/0028-approval-processes-and-record-locks.md) | 承認はプロセスの版・インスタンス・作業の項目の状態で持ち、応答ごとに 1 トランザクションにする。申請中はロックの表で守り、承認者にアクセスを与えない |
| [0029](../decisions/0029-report-execution-on-reader-per-viewer.md) | レポートは見る人の権限で毎回コンパイルし、結ぶ全てのオブジェクトに共有の条件と FLS をかけて reader で集計する。見る人をまたぐ事前の集計を持たない |
| [0030](../decisions/0030-dashboards-viewer-intersection-and-subscriptions.md) | ダッシュボードは見る人の権限で集計し、部下の視点は部下と見る人の権限の共通部分にする。指定した実行ユーザーの形は持たず、定期の配信は受け取る人ごとに実行する |
| [0031](../decisions/0031-search-index-and-japanese-analysis.md) | 検索の索引は共有の 16 個の索引に組織で振り分け、日本語は形態素と 2-gram の 2 つで持ち、outbox から row_version を外部の版にして作る |
| [0032](../decisions/0032-search-permission-post-filter.md) | 検索の結果は候補とし、オブジェクトの権限と FLS は前に絞り、レコードの共有はデータ層の問い合わせで後に確かめる。件数の合計を返さず、応答の時間を固定の束と下限の時間でそろえる |
| [0033](../decisions/0033-change-event-log-and-replay.md) | 変更のイベントは outbox からイベントの専用の Aurora に書き、論理シャードの唯一の書き手が確定の順の replay_id を付けて 3 日保つ |
| [0034](../decisions/0034-event-subscription-access-and-org-events.md) | 変更のイベントの購読はオブジェクトの view_all を要し、共有で絞らず FLS を配信の時にかける。組織が定義するイベントは型の権限で守り、既定で確定の後に発行する |
| [0035](../decisions/0035-webhooks-outbound-calls-and-ssrf-guard.md) | Webhook はイベントのログの上の宛先ごとのカーソルで送って <Brand>-Signature で署名し、外向きの呼び出しは登録した宛先だけにし、どちらも宛先を検査して内部に経路のない送信の網から送る |
| [0036](../decisions/0036-bulk-jobs-chunking-and-partial-success.md) | 一括の取り込みは 1 万行の部分を公平な順番に入れ、200 行ずつの非同期のトランザクションで行ごとに結果を返し、失敗は原因ごとにやり直す |
| [0037](../decisions/0037-import-wizard-upsert-and-duplicate-matching.md) | インポートのウィザードは一括のジョブの上の画面にし、upsert と照合での既存の更新は同じ鍵の行を同じ部分に集めて順に処理し、見えない一致は無いものとして扱う |
| [0038](../decisions/0038-sandbox-types-and-masked-copy.md) | Sandbox は 4 種類にし、ID をそのまま新しい org_id へ写し、個人データは複製の経路の中で Sandbox ごとの鍵の偽の値に置き換える |
| [0039](../decisions/0039-metadata-package-format.md) | メタデータのパッケージは部品ごとの YAML と目録の zip にし、参照は API の名前だけで書き、書き出しを正規化する |
| [0040](../decisions/0040-deploy-validation-and-rollback.md) | デプロイは計画を作る検証と 1 つの版で当てる適用に分け、ロックの中は版の確かめと書き込みだけにし、戻しは逆の差分の新しいデプロイにする |
| [0041](../decisions/0041-limits-registry-and-counting-rules.md) | 上限の正本を 1 つの登録簿にし、フローは足並みの 1 歩で、積み上げ集計の集計し直しは取得の行の外で数え、レポート・一括の問い合わせ・検索は別の予算で抑える |
| [0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md) | 割り当ては 24 時間の移動の窓で数えて有料の本番だけ 110% まで通し、Worker は組織の仮想時刻で公平に回し、上限の情報は見出しと /limits で返す |
| [0043](../decisions/0043-orgs-editions-licenses-and-users.md) | 組織は種類と状態を持って 30 日の猶予の後に消し、エディションは割り当てと機能だけを変え、ライセンスを権限の上限にし、利用者は消さずに無効にする |
| [0044](../decisions/0044-authentication-better-auth-sso-and-mfa.md) | ログインは自前でホストする Better Auth にし、組織ごとの SAML・OIDC の SSO を持ち、Auth0 の題材を IdP にしない。SSO を含む全てのログインで MFA を確かめ、特権を持つ利用者はパスキーだけにし、画面の API はセッションの Cookie だけで通す |
| [0045](../decisions/0045-system-permissions-and-delegation.md) | システムの権限を 25 にして依存を決め、権限を渡す人は自分の権限の部分集合しか渡せず、自分より強い利用者を操作できず、最後の管理者を無くせない |
| [0046](../decisions/0046-setup-audit-trail-and-login-history.md) | 監査のイベントは変更と同じトランザクションで追記だけの表に書き、組織ごとのハッシュの鎖と毎日の Object Lock の錨で改ざんを見つける。画面は 180 日、ログインの履歴は 180 日 |
| [0047](../decisions/0047-field-history-tracking-and-retention.md) | 項目の変更の履歴は 1 オブジェクト 20 項目まで、最上位の最後の値との差を同じトランザクションの outbox に書き、別のクラスタの月ごとの分割に写して 18 か月保ち、読みは見る人の共有と FLS で絞る |
| [0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md) | 利用者のコードは QuickJS-ng を WASM にしたものを、Runtime の隣の別のプロセスの Wasmtime で燃料とメモリーの上限を付けて動かす |
| [0049](../decisions/0049-triggers-in-dml-order-and-platform-api.md) | トリガーは DML の手順 3b・7a・13 にフローと並べて置き、塊ごとに 1 回呼ぶ。ホストの API はデータ層の AST だけにし、既定は実行する利用者の権限で動かす |
| [0050](../decisions/0050-packages-namespaces-and-code-isolation.md) | パッケージは名前空間の接頭辞と署名を持つメタデータの束にし、上限は組織と共有して名前空間ごとに計測する。コードの秘密は宛先の登録だけで渡す |
| [0051](../decisions/0051-leak-path-register-and-threat-model.md) | 組織をまたぐ漏えいと、見えないデータの漏えいの経路を 1 つの登録簿にし、経路ごとに否定側のテストと本番の検査を必須にする |
| [0052](../decisions/0052-key-hierarchy-and-per-org-data-keys.md) | KMS の鍵はセルと用途ごとに持ち、組織ごとのデータキーで S3 の組織のファイルとアプリの秘密を暗号化する。レコードは DB の保存時の暗号化だけにし、組織の削除は鍵の破棄で仕上げる |
| [0053](../decisions/0053-operator-access-and-data-lifecycle.md) | 運用者は組織の管理者の許可と期限つきの権限でだけ組織のデータに触れ、全ての操作を組織の監査に残す。データの種類ごとに保持と消去の期限を 1 つの表で持つ |
| [0054](../decisions/0054-accounts-network-and-service-separation.md) | アカウントを管理・監査・本番・送信で分け、本番の VPC の中で対話・管理・一括・Worker・コードの実行を別のサービスとロールにする。送信の VPC と監査のアカウントは本体への経路を持たない |
| [0055](../decisions/0055-shard-placement-and-stage-criteria.md) | 論理シャードを物理のクラスタに表で割り当て、組織ごとの上書きを持つ。段階を上げる基準を writer の CPU・保存の量・最大の組織の大きさで決める |
| [0056](../decisions/0056-org-migration-by-row-filtered-logical-replication.md) | 組織の移動は org_id の行の絞りを付けた論理レプリケーションで写して追いつき、数十秒の書き込みの止めの間に照合して置き場所を切り替える |
| [0057](../decisions/0057-disaster-recovery-osaka-warm-standby.md) | 大阪に Aurora Global Database の副と縮めた ECS を置く温かい待機にし、検索の索引と Valkey は切り替えの後に作り直す。切り替えは人が決め、失った範囲を outbox と replay_id で知らせる |
| [0058](../decisions/0058-slis-and-per-org-resource-metrics.md) | SLI は経路ごとに合成監視とサーバーの計測で持ち、組織ごとの使用量は DB の表に全件、メトリクスには上位の組織だけを出す。ログとトレースには組織の ID を持たせ、個人データを入れない |
| [0059](../decisions/0059-noisy-neighbor-detection-two-sources.md) | 騒がしい隣人は、アプリの DB の時間と、DB の側の実行中のセッションの標本の 2 つで見つけ、自動の対処は Worker の重みまでにし、対話の経路の絞りは人が決める |
| [0060](../decisions/0060-load-model-and-sizing-review.md) | 負荷と大きさは capacity.md の式で持ち、E3・E4・E12 の計測で係数を置き換える。S1 の主のクラスタは writer 1 台に reader 2 台で始め、項目の変更の履歴は S1 から別のクラスタに置く |
| [0061](../decisions/0061-access-decision-and-limit-gates-in-ci.md) | 決定表・性質・上限・漏えいの経路を CI の関門にし、上限の登録簿は設計の記録の governor-limits.md と機械的に比べる |
| [0062](../decisions/0062-security-sensitive-change-flow.md) | security:sensitive はパスで自動で付け、テックリードとセキュリティの担当の 2 人の承認、追加の CI、組織の単位の段階的なリリースを必須にする |
| [0063](../decisions/0063-org-staged-release-and-shadow-evaluation.md) | リリースは組織を単位に段階で広げ、アクセスの判定・問い合わせのコンパイルを変える時は、新旧を本番の標本で並べて比べる影の実行を経る |

リポジトリ共通の決定（開発プロセス、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を核に使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **アクセス制御の誤り**：共有の表の更新漏れ、FLS の確認漏れ、集計・検索・イベント・キャッシュ・エラーの文言の経路での判定漏れは、そのまま情報の漏えいになる。判定をコンパイラの 1 か所に集め（[ADR-0003](../decisions/0003-metadata-driven-runtime.md)、[ADR-0004](../decisions/0004-record-access-model.md)）、決定表、参照の評価器との性質ベーステスト、漏えいの経路の登録簿（LEAK-001〜030。[ADR-0051](../decisions/0051-leak-path-register-and-threat-model.md)）、本番の標本の照合（[ADR-0017](../decisions/0017-reference-access-evaluator.md)）の 4 重で抑える。判定の変更は影の実行を経てから広げる（[ADR-0063](../decisions/0063-org-staged-release-and-shadow-evaluation.md)）。
- **組織をまたぐ漏えい**：RLS のコンテキストの漏れ、共有の OpenSearch の索引の組織の条件の付け漏れ、キャッシュの鍵の誤り。RLS と `shard_no` の 2 つの確かめ、検索の後の確かめ（[ADR-0032](../decisions/0032-search-permission-post-filter.md)）、キャッシュの鍵への `org_id` の必須化で抑える。
- **共有の再計算の重さ**：レコードの条件のルールの追加と、ロールの木の移動は、大きな組織で時間がかかる（最大の組織でルールの追加 約 1 時間。[capacity.md](capacity.md) の 6 節）。本家も大きな組織で時間がかかると書いている（[Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)）。所有者と OWD を行に持たない設計と、ルールの版・閉包の世代（[ADR-0016](../decisions/0016-recalculation-rule-versions-and-skew.md)）で抑え、再計算の間は古い構成で判定し続ける。S3 の 10 万人・50 億件の組織では 100 時間を超える見込みで、S3 の前に形を見直す。
- **データの偏り（スキュー）**：1 人の所有者や 1 つの親に 1 万件を超えるレコードが集まると、積み上げ集計の親の行ロックと、閉包の変更が重くなる。本家も 1 人の所有者が 1 万件を超えないことを勧めている（[Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)、2026-09-28 に確認）。1 万件で警告し（ADR-0016）、一括の取り込みは親ごとに並べて切る（[ADR-0036](../decisions/0036-bulk-jobs-chunking-and-partial-success.md)）。
- **JSONB の本体での集計の遅さ**：レポートの集計で JSONB から値を取り出して型を変える費用がかかる。S1 は reader で受け、見る人をまたぐ事前の集計を持たない（[ADR-0029](../decisions/0029-report-execution-on-reader-per-viewer.md)）。S2 で分析用の写し（共有の条件を持ち込む形）を PoC で決める。
- **問い合わせの計画の悪化**：ピボットの表を使う計画は、組織ごとのデータの分布で良し悪しが変わる。組織ごとの統計と本家に寄せた閾値、途中の計画の変更、対話の経路での `NON_SELECTIVE_QUERY` で抑える（[ADR-0019](../decisions/0019-selectivity-statistics-and-planning.md)）。統計の標本の偏りは E3 で測る。
- **騒がしい隣人**：上限の内側でも、多数の組織が同時に重い処理をすると共有の DB が詰まる。組織ごとの DB の時間と DB の側の実行中のセッションの 2 つで見つけ、Worker の重みを自動で下げ、対話の経路の絞りは人が決める（[ADR-0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md)、[ADR-0059](../decisions/0059-noisy-neighbor-detection-two-sources.md)）。
- **保存の量**：項目の変更の履歴は 18 か月で約 3.5TB になり、主のクラスタの残りの全てより大きい。S1 から `history` のクラスタに分けた（下の決定）。S2 で主のクラスタは約 22TB になり、論理シャードの単位で分ける（[ADR-0055](../decisions/0055-shard-placement-and-stage-criteria.md)）。
- **メタデータのキャッシュの規模**：S3 で 50 万の組織のコンパイル済みのメタデータを、すべてプロセスに載せられない。内容で番地を決めた部品と 3 層のキャッシュで持つ（[ADR-0007](../decisions/0007-segmented-metadata-snapshots.md)）。
- **Sandbox への個人データの流出**：複製の経路の中で伏せ、伏せる前の値を Sandbox の DB に書かない（[ADR-0038](../decisions/0038-sandbox-types-and-masked-copy.md)）。カスタム項目の分類の漏れは検出して警告する。法務の L3 の結論まで、伏せを外す設定を持たない。
- **外への持ち出し・SSRF**：乗っ取られた管理者・連携のトークンによる Webhook・一括の問い合わせ・エクスポートでの持ち出しと、宛先の検査の漏れ。宛先の変更の監査と管理者全員への知らせ、別のアカウントの送信の網と宛先の検査で抑える（[ADR-0035](../decisions/0035-webhooks-outbound-calls-and-ssrf-guard.md)、[ADR-0054](../decisions/0054-accounts-network-and-service-separation.md)）。
- **利用者のコードの隔離（E13）**：砂場の脱出と、組織をまたぐ状態の残り。WASM の境界、WASI なし、呼び出しごとの新しい実体、資格情報のない別のコンテナ（[ADR-0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md)）と、E13 の外部のペンテストで確かめる。
- **本家との差**：数式の FLS、活動の見え方、指定した実行ユーザーのダッシュボードを持たないこと、フローの要素の数え方、組織が定義するイベントの既定の発行の時点などが本家と違う。移行の文書に書く（各領域の文書の「決定」）。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L11）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-09-28、既定案）

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
- **メタデータの部品**：`report_types` を足し、部品の鍵に形の版を含めた（ADR-0007 の注記）。
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
  - 本家の Apex は API の版 67.0 から既定で利用者の権限で動く。本システムの既定と同じ向きになった（ADR-0049 の注記。決定は変えない）。
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

## 7. 領域の文書

領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [metadata-and-runtime.md](metadata-and-runtime.md) | ユニバーサルなデータ辞書（オブジェクト、項目、関係、レコードタイプ、選択リスト）、メタデータの版とキャッシュ、要求のコンパイル、DML の実行の順序、数式の言語と評価器、項目の型の変換と削除・復元 | 0006–0009 | QA | E3、E6 |
| [data-storage.md](data-storage.md) | records の表、ピボットの索引・一意・関係の表、長いテキストの別の表、outbox、論理シャードへの割り当て、ごみ箱と削除の確定、整合の検査、大口の組織の射影の表（S2 以降） | 0010–0012 | QA、Ops | E3、E12 |
| [sharing-and-record-access.md](sharing-and-record-access.md) | プロファイルと権限セット、オブジェクトの権限、FLS、システムの権限、OWD、ロール階層、公開グループとキュー、共有ルール、手動の共有、チーム、親に連動する共有、暗黙の共有、再計算、スキューの扱い、参照の評価器 | 0013–0017 | QA、セキュリティ | E4 |
| [query-language-and-api.md](query-language-and-api.md) | 独自の問い合わせの言語（構文、関係のたどり方、集計）、選択性の見積もりと計画、REST API（レコード、問い合わせ、記述、複合の要求）、版、エラー、`<Brand>-Limit-Info` のヘッダー | 0018–0020 | QA | E3、E5 |
| [sales-objects.md](sales-objects.md) | 取引先、取引先責任者、リードと変換、商談とフェーズ、活動（ToDo・行動）、重複の規則、メールの記録 | 0021–0022 | QA | E5 |
| [ui-layouts-and-list-views.md](ui-layouts-and-list-views.md) | ページレイアウト、関連リスト、レコードタイプごとの画面、リストビューのビルダーと共有、Setup の画面、アクセシビリティ | 0023–0024 | QA | E5 |
| [automation-flows.md](automation-flows.md) | フローのエンジン（保存の前・後、スケジュール、画面、イベント）、入力規則、積み上げ集計、承認のプロセス、再帰と上限、非同期の続き | 0025–0028 | QA | E6 |
| [reports-and-dashboards.md](reports-and-dashboards.md) | レポートの型、集計の実行（reader、非同期）、見る人の権限での集計、ダッシュボードの見え方、グラフ、定期の配信 | 0029–0030 | QA、セキュリティ | E7 |
| [search.md](search.md) | 全文検索（索引の遅れ、日本語の解析）、名前での代わりの検索、検索の結果の権限の絞り込み | 0031–0032 | QA | E5 |
| [events-and-integrations.md](events-and-integrations.md) | 変更のイベント（順序、再生、購読の権限）、組織が定義するイベント、Webhook（署名 `<Brand>-Signature`、再送）、外向きの呼び出し、メールの送信 | 0033–0035 | QA、Ops | E8 |
| [bulk-and-import.md](bulk-and-import.md) | 一括の API（ジョブ、分割、部分の成功）、インポートのウィザード、外部 ID での upsert、重複の照合、自動化を伴う取り込みの上限 | 0036–0037 | QA、Ops | E9 |
| [sandboxes-and-deploy.md](sandboxes-and-deploy.md) | Sandbox の種類と作成・再作成、データの複製とマスキング、メタデータの形式（独自）、デプロイ（検証だけ、全部か無しか、破壊的な変更）、差分と戻し | 0038–0040 | QA、セキュリティ | E10 |
| [governor-limits.md](governor-limits.md) | 全ての上限の一覧と値（正本）、計測の方法、組織ごとの割り当て（API、一括、イベント、ストレージ）、長い要求の同時実行、公平な順番、上限の情報の返し方 | 0041–0042 | QA、Ops | E3、E12 |
| [orgs-users-and-auth.md](orgs-users-and-auth.md) | 組織の作成と削除、エディションとライセンス、利用者、ログイン（SSO、MFA）、セッション、API の認証、組織のドメイン、システムの権限の一覧と渡す規則 | 0043–0045 | セキュリティ | E2 |
| [audit-and-field-history.md](audit-and-field-history.md) | 設定の変更の履歴、項目の変更の履歴、ログインの履歴、保持と削除、改ざんの防止 | 0046–0047 | セキュリティ、Ops | E11 |
| [extensibility.md](extensibility.md)（MVP の後） | 利用者のコード（TypeScript、QuickJS-ng と Wasmtime の砂場）、トリガー、上限と計測、パッケージと名前空間 | 0048–0050 | セキュリティ、Ops | E13、E14 |
| [security.md](security.md) | 信頼境界、脅威モデル、漏えいの経路の登録簿、暗号化と鍵、運用者のアクセス、データのライフサイクル、脆弱性の対応、法務の論点の整理 | 0051–0053 | セキュリティ | E1、E12 |
| [data-model.md](data-model.md)、[data-model/](data-model/) | データモデルの正本（規約、列・制約・索引、ER 図、DB 以外の置き場所、横断の不変条件） | なし（各領域の ADR を参照する） | QA | 全 Epic |
| [infrastructure.md](infrastructure.md) | AWS のアカウントとネットワーク、サービスの分け方、論理シャードと物理のクラスタ、`events`・`history` のクラスタ、セル、組織の移動、DR、段階を上げる基準、コスト | 0054–0057 | Ops | E1、E12 |
| [observability.md](observability.md) | ログ・メトリクス・トレース、SLI、組織ごとの資源の使用量、騒がしい隣人の検知、アラート | 0058–0059 | Ops | E1、E12 |
| [capacity.md](capacity.md) | 負荷のモデル、表の大きさ、書き込みの増幅、再計算の時間、部品ごとの必要量（OpenSearch の台数を含む） | 0060 | Ops | E12 |
| [delivery.md](delivery.md) | CI/CD、アクセス制御の決定表と性質の CI、上限の試験と登録簿の一致、リリースとフラグ、影の実行、`security:sensitive` の変更の流れ | 0061–0063 | QA、Ops | E1、E12 |

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。E1〜E12 が MVP（S1）で、E13 は利用者のコード、E14 はパッケージ、E15 以降は CPQ・売上予測・AI など。その他の MVP の後の機能は、roadmap.md の「後回し」にある。各 Epic の品質の合否基準は [quality.md](../quality.md) の 5 節。

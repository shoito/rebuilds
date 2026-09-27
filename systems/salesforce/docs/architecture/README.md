# Architecture: Salesforce

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧、持ち主、ADR の番号の範囲は 7 節にある（まだ作っていない）。

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
              │          │ コンパイル済みの      検索の索引、Webhook・メールの送信、
              │          ▼ メタデータ・上限の数   Sandbox の複製、項目の型の変換）
              │      Valkey
              ▼
        Aurora PostgreSQL（メタデータ、records＋ピボットの索引、共有の表、監査、outbox。RLS）
              │ outbox                           │ reader
              ▼                                  ▼
          Relay ─▶ 変更のイベントのログ ─▶ 購読者    Reports（集計）   OpenSearch（全文検索）
```

| コンテナ | 責務 |
| --- | --- |
| Runtime | 画面と API の要求を受け、問い合わせと DML をメタデータに対してコンパイルし、権限・FLS・共有の判定と上限の計測をして実行する。レコードの変更で動くフローを同じトランザクションで動かす（[ADR-0003](../decisions/0003-metadata-driven-runtime.md)） |
| Metadata | オブジェクト・項目・レイアウト・フロー・権限の変更とデプロイ。組織のメタデータの版を上げる唯一の入口 |
| Bulk | 一括のジョブの受付と状態。処理は Worker で、同じ Runtime のライブラリを使う |
| Worker | 遅れてよい処理。組織ごとに公平に順番を回す（[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)） |
| Aurora | 唯一の正本。組織を RLS で分ける。カスタムオブジェクトも標準オブジェクトも共有の表に入れる（[ADR-0002](../decisions/0002-custom-object-storage.md)） |
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
| S1（MVP） | 5,000（1,000。残りは Sandbox と試用） | 5 万 | 5 億 | 利用者 5,000、レコード 5,000 万 | 2,000 件/秒 | 東京の 1 リージョン・3 AZ。Aurora の writer 1 台＋reader 2 台。論理シャードは 256 で、物理は 1 つ。大阪にウォームスタンバイ |
| S2 | 5 万（1 万） | 50 万 | 50 億 | 利用者 3 万、レコード 5 億 | 2 万件/秒 | 論理シャードを複数の Aurora のクラスタに割り当てる。Sandbox と試用の組織を本番とは別のクラスタへ。レポートを分析用の写しへ |
| S3 | 50 万（10 万） | 500 万 | 500 億 | 利用者 10 万、レコード 50 億 | 20 万件/秒 | セル構成。組織をセルに固定し、セルの間で組織を動かせる。大口の組織に専用のセル。東京・大阪の両方で受ける |

- 数値は本システムの想定。本家の実数は、公開の資料で確かめられなかった（未検証）。本家は、大きな組織の例として「取引先 1,000 万件、利用者 7,000 人、ロール 2,000、テリトリー 1,000」を挙げている（[Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)、2026-09-28 に確認）。
- 1 件の対話の要求は、平均で問い合わせを 3〜5 回行う想定。
- 共有の表の行は、非公開の OWD のオブジェクトで、レコードあたり平均 3 行を想定する（所有者は表に持たない。[ADR-0004](../decisions/0004-record-access-model.md)）。
- 段階を上げる判断の基準は、infrastructure の領域で決める。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 画面の速さ | レコードの詳細（レコード、レイアウト、関連リストの最初のページ）の API の p95 300ms、p99 800ms。リストビューの最初のページ（選択的な条件、100 万件まで）の p95 500ms | 本家は、ページの表示の目安を 300ms としている（[Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)）。フローの実行時間を除く |
| NFR-002 | API の速さ | REST のレコード 1 件の読み書きの p95 200ms、p99 500ms。問い合わせ（選択的な条件）の p95 500ms。メタデータの記述の p95 100ms | 自動化の実行時間を除く |
| NFR-003 | 公平（ガバナ制限） | 1 トランザクションの上限を 100% 強制する。上限まで負荷をかけた組織があっても、他の組織の p95 の悪化が 10% 以内 | [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md) |
| NFR-004 | メタデータのデプロイの安全 | デプロイは全部か無しか。検証の失敗で本番が変わる件数 0 件。デプロイの確定の間の、データの書き込みの止まりが p99 1 秒以内。直前の版へ戻すデプロイが 5 分以内に終わる | [ADR-0003](../decisions/0003-metadata-driven-runtime.md) |
| NFR-005 | 共有の再計算 | レコードの保存に伴う共有の変更は、同じトランザクションで反映する。設定の変更の再計算は、100 万件・1,000 人の組織で 15 分以内。再計算の間も、古い世代で判定し続ける | [ADR-0004](../decisions/0004-record-access-model.md) |
| NFR-006 | 可用性 | 対話の経路（Runtime）の月間 99.9%（本番の組織）。S2 で 99.95% | 本家の標準の SLA は、公開の資料で確かめられなかった（未検証）。Sandbox は対象外 |
| NFR-007 | 耐久性と AZ の障害 | 成功を返したレコードとメタデータの変更を失わない。RPO 0、RTO 5 分以内 | |
| NFR-008 | リージョンの障害 | RPO 1 分以内、RTO 1 時間以内 | 大阪へ切り替える |
| NFR-009 | テナントの分離 | 他の組織のデータ・メタデータが見える事象 0 件。Sandbox から本番の組織のデータが見える事象 0 件 | [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md) |
| NFR-010 | 一括の処理と変更のイベント | 一括の登録で、100 万件の取り込みが 30 分以内（自動化が軽い時）。変更のイベントは、確定から購読者に届くまで p95 5 秒以内、少なくとも 1 回、レコードごとの順序を守り、3 日は再生できる | 本家の変更のイベントも 3 日の保持（[Change Data Capture Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_change_data_capture.pdf)、2026-09-28 に確認） |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（サービス・Web） | 他の題材と同じ。メタデータ・AST・決定表を型で扱う（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| HTTP・検証 | Hono＋Zod。API の OpenAPI は組織のメタデータから動的に生成する | 他の題材と同じ。組織ごとにオブジェクトが違うため、固定の型では足りない |
| Web の画面 | React の SPA。ページレイアウトとリストビューはメタデータから描く | ui-layouts-and-list-views の領域で詳しく決める |
| DB | Aurora PostgreSQL 18、RLS、ID は UUIDv7。records と型付きのピボットの索引 | [ADR-0002](../decisions/0002-custom-object-storage.md)、[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md) |
| キャッシュ・数 | ElastiCache（Valkey） | コンパイル済みのメタデータ、上限の数（[ADR-0003](../decisions/0003-metadata-driven-runtime.md)） |
| 全文検索 | Amazon OpenSearch Service | search の領域で解析器を決める |
| 非同期 | transactional outbox → SQS。変更のイベントの再生の置き場所は events-and-integrations の領域で決める | 他の題材と同じ |
| 問い合わせ・数式の言語 | 独自。パーサー、型検査、SQL へのコンパイル、参照の評価器を TypeScript で持つ | [ADR-0003](../decisions/0003-metadata-driven-runtime.md) |
| 利用者のコード（MVP の後） | TypeScript で書き、JS のエンジンを WASM に閉じ込めた砂場で動かす | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs。組織ごとの資源の使用量を計測する | 他の題材と同じ |
| フラグ | AWS AppConfig | 他の題材と同じ |
| テスト | Vitest、fast-check（共有の性質、問い合わせのコンパイラと参照の評価器の一致）、Testcontainers、Playwright、k6 | 他の題材と同じ |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、メタデータの実行基盤を自前で作る。本家の言語との互換は持たない。MVP は宣言的な設定だけにし、利用者のコードは MVP の後に TypeScript を WASM の砂場で動かす |
| [0002](../decisions/0002-custom-object-storage.md) | 全組織・全オブジェクトのレコードを、共有の records の表（システムの列＋JSONB の本体）に入れる。検索と一意と参照は、同じトランザクションで書く型付きのピボットの表で行う。組織ごとの実テーブルは作らない |
| [0003](../decisions/0003-metadata-driven-runtime.md) | メタデータを版の付いた不変のスナップショットとしてコンパイルし、要求ごとに 1 つの版に固定する。問い合わせと DML は AST にして、メタデータに対して束縛・権限の確認・共有の条件の付加をしてから SQL にする |
| [0004](../decisions/0004-record-access-model.md) | 共有を事前計算する。グループの閉包とレコードの共有の行を持ち、所有者と所有者の条件の共有ルールは問い合わせの時に閉包と結ぶ。設定の変更の再計算は、影の世代を作って一度に切り替える |
| [0005](../decisions/0005-tenancy-and-governor-limits.md) | 共有スキーマと RLS で組織を分け、論理シャードとセルで広げる。1 トランザクションの上限と組織ごとの割り当てを、実行基盤のデータ層で強制する |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を核に使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

- **アクセス制御の誤り**：共有の表の更新漏れ、FLS の確認漏れ、集計・検索・イベントの経路での判定漏れは、そのまま情報の漏えいになる。判定を 1 か所に集め（[ADR-0004](../decisions/0004-record-access-model.md)）、決定表・性質ベーステスト・本番での参照の評価器との標本の照合で抑える。
- **共有の再計算の重さ**：ロールの移動、所有者の大量の変更、OWD の変更は、数百万行の共有の表を書き換えうる。本家も、大きな組織で時間がかかると書いている（[Record-Level Access: Under the Hood](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_record_access_under_the_hood.pdf)）。所有者を表に持たない設計と、影の世代で抑える。
- **データの偏り（スキュー）**：1 人の所有者や 1 つの親に 1 万件を超えるレコードが集まると、共有の計算とロックが重くなる。本家も 1 人の所有者が 1 万件を超えないことを勧めている（[Best Practices for Deployments with Large Data Volumes](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_large_data_volumes_bp.pdf)、2026-09-28 に確認）。本システムでの閾値と警告は sharing-and-record-access の領域で決める。
- **JSONB の本体での集計の遅さ**：レポートの集計で JSONB から値を取り出して型を変える費用がかかる。S1 は reader で受け、S2 で分析用の写しを検討する（[ADR-0002](../decisions/0002-custom-object-storage.md)）。
- **問い合わせの計画の悪化**：ピボットの表を使う計画は、組織ごとのデータの分布で良し悪しが変わる。本家は組織・利用者ごとの統計で計画を変える（[Platform Multitenant Architecture](https://architect.salesforce.com/docs/architect/fundamentals/guide/platform-multitenant-architecture.html)）。本システムは、選択性の見積もりを自前で持つ（query-language-and-api の領域）。
- **騒がしい隣人**：上限の内側でも、多数の組織が同時に重い処理をすると共有の DB が詰まる。組織ごとの DB の時間の計測と、Worker の公平な順番で抑える（[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)）。
- **メタデータのキャッシュの規模**：S3 で 50 万の組織のコンパイル済みのメタデータを、すべてプロセスに載せられない。版をキーにした 3 層のキャッシュで持つ（[ADR-0003](../decisions/0003-metadata-driven-runtime.md)）。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

持ち越し（計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 1 トランザクションの上限の値、組織ごとの割り当ての値 | E3 で初期値を置き、E12 の負荷試験で決める（[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)） |
| ピボットの索引の表を、全項目に張るか、索引の指定のある項目だけにするか | E3 の PoC。書き込みの増幅と問い合わせの速さを測る（[ADR-0002](../decisions/0002-custom-object-storage.md)） |
| 共有の再計算の、影の世代の作り方（組織の単位か、オブジェクトの単位か） | E4 の PoC（[ADR-0004](../decisions/0004-record-access-model.md)） |
| 変更のイベントの再生の置き場所（Aurora の分割の表、Kinesis Data Streams など） | E8 の着手前 |
| 利用者のコードの砂場の JS のエンジンと、WASM の実行系 | MVP の後の Epic の前に PoC（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| 本家の振る舞いで未確認のもの（項目の数の上限、Sandbox の種類と容量、フローの実行の順序の細部、承認の仕様） | 各領域の文書で、本家の資料で確かめる |

## 7. 領域の文書（計画）

各領域の文書は、まだない。領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| `metadata-and-runtime.md` | ユニバーサルなデータ辞書（オブジェクト、項目、関係、レコードタイプ、選択リスト）、メタデータの版とキャッシュ、要求のコンパイル、DML の実行の順序、数式の言語と評価器、項目の型の変換と削除・復元 | 0006–0009 | QA | E3、E6 |
| `data-storage.md` | records の表、ピボットの索引・一意・関係の表、長いテキストの別の表、論理シャードへの割り当て、ごみ箱と削除の確定、整合の検査、大口の組織の射影の表（S2 以降） | 0010–0012 | QA、Ops | E3、E12 |
| `sharing-and-record-access.md` | プロファイルと権限セット、オブジェクトの権限、FLS、OWD、ロール階層、公開グループとキュー、共有ルール、手動の共有、チーム、親に連動する共有、暗黙の共有、再計算、スキューの扱い、参照の評価器 | 0013–0017 | QA、セキュリティ | E4 |
| `query-language-and-api.md` | 独自の問い合わせの言語（構文、関係のたどり方、集計）、選択性の見積もりと計画、REST API（レコード、問い合わせ、記述、複合の要求）、版、エラー、`<Brand>-Limit-Info` のヘッダー | 0018–0020 | QA | E3、E5 |
| `sales-objects.md` | 取引先、取引先責任者、リードと変換、商談とフェーズ、活動（ToDo・行動）、重複の規則、メールの記録 | 0021–0022 | QA | E5 |
| `ui-layouts-and-list-views.md` | ページレイアウト、関連リスト、レコードタイプごとの画面、リストビューのビルダーと共有、Setup の画面、アクセシビリティ | 0023–0024 | QA | E5 |
| `automation-flows.md` | フローのエンジン（保存の前・後、スケジュール、画面）、入力規則、積み上げ集計、承認のプロセス、再帰と上限、非同期の続き | 0025–0028 | QA | E6 |
| `reports-and-dashboards.md` | レポートの型、集計の実行（reader、非同期）、見る人の権限での集計、ダッシュボードの実行者、グラフ | 0029–0030 | QA、セキュリティ | E7 |
| `search.md` | 全文検索（索引の遅れ、日本語の解析）、名前での代わりの検索、検索の結果の権限の絞り込み | 0031–0032 | QA | E5 |
| `events-and-integrations.md` | 変更のイベント（順序、再生、購読の権限）、組織が定義するイベント、Webhook（署名 `<Brand>-Signature`、再送）、外向きの呼び出し | 0033–0035 | QA、Ops | E8 |
| `bulk-and-import.md` | 一括の API（ジョブ、分割、部分の成功）、インポートのウィザード、外部 ID での upsert、重複の照合、自動化を伴う取り込みの上限 | 0036–0037 | QA、Ops | E9 |
| `sandboxes-and-deploy.md` | Sandbox の種類と作成・再作成、データの複製とマスキング、メタデータの形式（独自）、デプロイ（検証だけ、全部か無しか、破壊的な変更）、差分と戻し | 0038–0040 | QA、セキュリティ | E10 |
| `governor-limits.md` | 1 トランザクションの上限の一覧と値、計測の方法、組織ごとの割り当て（API、一括、ストレージ）、長い要求の同時実行、公平な順番、上限の情報の返し方 | 0041–0042 | QA、Ops | E3、E12 |
| `orgs-users-and-auth.md` | 組織の作成と削除、エディションとライセンス、利用者、ログイン（SSO、MFA）、セッション、組織のドメイン | 0043–0045 | セキュリティ | E2 |
| `audit-and-field-history.md` | 設定の変更の履歴、項目の変更の履歴、ログインの履歴、保持と削除、改ざんの防止 | 0046–0047 | セキュリティ、Ops | E11 |
| `extensibility.md`（MVP の後） | 利用者のコード（TypeScript、WASM の砂場）、トリガー、上限と計測、パッケージと名前空間 | 0048–0050 | セキュリティ、Ops | E13 |
| `security.md` | 脅威モデル、暗号化、秘密、データのライフサイクル、脆弱性の対応、法務の論点の整理 | 0051–0053 | セキュリティ | E1、E12 |
| `data-model.md` | データモデルの索引 | なし（各領域の ADR を参照する） | QA | 全 Epic |
| `infrastructure.md` | AWS のアカウントとネットワーク、サービスの分け方、論理シャードと物理のクラスタ、セル、組織の移動、DR、段階を上げる基準 | 0054–0057 | Ops | E1、E12 |
| `observability.md` | ログ・メトリクス・トレース、SLI、組織ごとの資源の使用量、騒がしい隣人の検知 | 0058–0059 | Ops | E1、E12 |
| `capacity.md` | 負荷のモデル、共有の表と索引の表の大きさ、再計算の時間、部品ごとの必要量 | 0060 | Ops | E12 |
| `delivery.md` | CI/CD、アクセス制御の決定表と性質の CI、上限の試験、リリースとフラグ、`security:sensitive` の変更の流れ | 0061–0063 | QA、Ops | E1、E12 |

## 8. Epic（草案）

`roadmap.md` を作るときに移す。PM が持つ。

| Epic | 目的 |
| --- | --- |
| E1 | 基盤：AWS・Terraform・CI（決定表・性質・上限の試験の枠を含む）、Aurora と RLS、論理シャード、フラグ、可観測性 |
| E2 | 組織と利用者：組織の作成、エディションとライセンス、利用者、ログインと SSO、Setup の画面の骨格 |
| E3 | メタデータの実行基盤：データ辞書、カスタムオブジェクトとカスタム項目、records とピボットの表、メタデータの版とキャッシュ、問い合わせの言語、REST API、上限の計測の骨格 |
| E4 | アクセス制御：プロファイルと権限セット、FLS、OWD、ロール階層、グループ、共有ルール、手動の共有、再計算、参照の評価器 |
| E5 | 営業の標準オブジェクトと画面：取引先、取引先責任者、リードと変換、商談、活動、ページレイアウト、リストビュー、検索 |
| E6 | 宣言的な自動化：数式、入力規則、フロー（保存の前・後、スケジュール、画面）、積み上げ集計、承認 |
| E7 | レポートとダッシュボード |
| E8 | 変更のイベントと連携：変更のイベント、組織が定義するイベント、Webhook |
| E9 | 一括の API とインポート |
| E10 | Sandbox とメタデータのデプロイ |
| E11 | 監査：設定の変更の履歴、項目の変更の履歴、ログインの履歴 |
| E12 | 本番の準備：負荷試験と上限の値の確定、騒がしい隣人の試験、障害の注入と DR の訓練、外部のペンテスト、GA の判定 |
| E13 以降（MVP の後） | 利用者のコード、パッケージ、CPQ、売上予測、AI、テリトリー管理、複数の通貨 |

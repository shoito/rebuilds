# Architecture: ServiceNow

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く。ファイルの一覧、持ち主、ADR の番号の範囲は 7 節にある。品質は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

## 1. 全体構成

### 1.1 コンテキスト

```
 社員（ブラウザ・スマートフォン）          IT の担当者・承認者・管理者（ブラウザ）
      │ ポータル：申請・報告・承認・ナレッジ      │ 作業の画面：フォーム・リスト・ダッシュボード・設定
      ▼                                           ▼
┌──────────── 本システム（テナントのホスト名 <tenant>.<brand>.<domain>）──────────────┐
│  ITSM のアプリ（インシデント・問題・変更・要求・ナレッジ・CMDB・SLA）                 │
│  記録の基盤（データ辞書・ACL・ワークフロー・通知・レポート・API・監査の履歴）          │
└──────────────────────────────────────────────────────────────────────────────┘
      ▲ メール（受信・送信）     ▲ REST API・Webhook               ▲ SAML・OIDC
      │                           │                                   │
 社内のメールサーバー        監視・資産管理・CI/CD・人事のシステム     テナントの IdP（Entra ID など）
 （サービスデスクの宛先を転送）  （CI・社員・組織の取り込み、イベントの購読）
```

### 1.2 コンテナ

```
        ┌──────────── CloudFront＋WAF（静的な資産、レート制限、明らかな攻撃の遮断）────────────┐
        └──────────────┬──────────────────────────────────────────────┬──────────────────┘
                       │ ホスト名 → テナント → セル（ルーター）          │
                       ▼                                                ▼
   ┌──────────────── セル（共有のセル、または大口の専用のセル）────────────────────────────┐
   │  App（フォーム・リスト・ポータル・REST API）   Admin（データ辞書・フロー・ACL の設定）   │
   │        │ レコードの操作は Record Service を通す（辞書の検証・ACL・同期のルール・履歴）  │
   │        ▼                                                                               │
   │  Aurora PostgreSQL（テナントのレコード・辞書・フローの実行・タイマー・履歴、RLS）       │
   │        │ outbox                        ▲ タイマーの取得（SKIP LOCKED）                  │
   │        ▼                               │                                                │
   │  Relay ─▶ SQS ─▶ Engine（フローの実行、承認、SLA の計時、非同期のルール）              │
   │                 ─▶ Notifier（メール・プッシュ・Webhook）                               │
   │                 ─▶ Indexer（OpenSearch：検索・ナレッジ）                                │
   │  Ingest（メールの受信：mail-router → セルの S3・SQS、CMDB の取り込みと識別・調整）       │
   │  Valkey（辞書と ACL のコンパイル済みのキャッシュ、セッションの写し、レート制限）         │
   │  S3（添付ファイル、メールの原本、エクスポート）                                          │
   └───────────────────────────────────────────────────────────────────────────────────┘
   制御の面（全セルで共有）：テナントの台帳とセルの対応、プロビジョニング、版とフラグの配布
   mail-ingress（全セルで共有）：SES の受信 → 一時の S3 → mail-router（封筒の受け手 → テナント → セル）
```

| コンテナ | 責務 |
| --- | --- |
| Router | ホスト名からテナントとセルを解決し、要求をセルへ送る。テナントのデータを読まない（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。CloudFront Functions と KeyValueStore で動き、セルの App が解決し直す（[ADR-0055](../decisions/0055-accounts-cells-and-edge-router.md)） |
| mail-router | mail-ingress の SES が受けたメールを、封筒の受け手 → テナント → セルで振り分ける。解決できない受け手はバウンスしない（[ADR-0034](../decisions/0034-inbound-email-threading-and-sender-trust.md)、[infrastructure.md](infrastructure.md) の 2.3 節） |
| App | 作業の画面・ポータル・REST API。レコードの読み書きは Record Service（ライブラリ）を通す |
| Record Service | データ辞書による検証、ACL の判定、同期のレコードのルール、番号の採番、監査の履歴、outbox。すべての書き込みの唯一の入口（[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)） |
| Engine | フローの実行、承認、タイマー（SLA とフローの待ち）、非同期のルール（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)） |
| Ingest | メールからのチケット、CMDB の取り込みと識別・調整（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）、CSV・API の一括の取り込み |
| Notifier | 通知のメール（SES）、アプリのプッシュ、Webhook |
| Indexer | 検索の索引（OpenSearch）への反映。ACL の判定に要る属性も索引に入れる |
| Aurora | セルの唯一の正本。テナントを RLS で分ける |
| Valkey | キャッシュと数の置き場所。失われてもよい（DB が正本） |
| 制御の面 | テナントの台帳、セルへの割り当て、テナントの作成、フラグの配布 |

原則は 5 つ。

- **メタデータが振る舞いを決める。** テーブル・フィールド・フォーム・ACL・フロー・SLA は、テナントごとの版付きのメタデータとして持つ。コードはメタデータを解釈する（[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)）。
- **読み書きは 1 つの入口と 1 つの判定を通す。** Record Service と ACL の判定の関数を、画面・API・レポート・検索・通知が共有する。
- **状態の遷移は、DB のトランザクションで 1 回だけ行う。** レコード・フローの実行・タイマー・outbox を同じトランザクションで書く（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)）。
- **セルで分け、テナントで閉じる。** 共有のセルと専用のセルは同じコード・同じ版で動く（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- **本家の実装を使わず、互換も求めない。** スクリプトの API に似せた層を作らない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

### 1.3 主要なフロー

**メールからインシデント、SLA の計時まで**

1. 社内のメールサーバーが、サービスデスクの宛先へのメールを、テナントの受信のアドレスへ転送する。mail-ingress の SES が受信して一時の S3 に置き、`mail-router` が封筒の受け手からテナントとセルを決めて、セルの S3 と SQS へ送る。
2. Ingest が原本を解析する。本文の参照の印か `In-Reply-To` で既存のチケットを探し、なければ新しいチケットにする。差出人を社員のメールアドレスで照合する。
3. Record Service が、1 つのトランザクションでインシデントを作る。割り当ての規則、SLA の開始の条件、監査の履歴、outbox を同じトランザクションで書く。SLA の計時の行には、カレンダーから計算した期限の時刻を入れ、タイマーの表に登録する。
4. Engine が、期限の前の警告と違反のタイマーを発火させる。担当が状態を「保留」にすると、一時停止の条件で計時を止め、再開で期限を計算し直す。

**変更の承認（CAB）**

1. 変更の記録を「評価」に進めると、リスクの質問票と規則からリスクを決める。リスクと種類で、承認の方針（誰の、何段の承認か）が決まる。
2. Engine が承認の依頼を作り、承認者へ通知する。承認者の回答は、承認のレコードの版の番号で守った 1 回の遷移として反映する。
3. すべての承認がそろうと、同じトランザクションで変更の状態を「予定済み」に進め、次のステップのタイマーを登録する。

**CMDB の取り込み**

1. 取り込み元（API、CSV、外部の資産管理）が、CI と関係のまとまり（ペイロード）を送る。
2. Ingest が、クラスごとの識別の規則で既存の CI を探す。識別の値を正規化した一意の索引の上で行うので、並行の取り込みでも重複を作らない。
3. 一致した CI には、属性ごとの取り込み元の優先度と鮮度の規則で、書いてよい属性だけを書く。複数の CI に一致したら、重複の候補として止める（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)）。

## 2. 規模の段階

| 段階 | テナント（うち本番） | 社員（合計） | 担当者（合計） | チケットの作成 | API のピーク | CI（合計・最大のテナント） | 構成 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1（MVP） | 300（100） | 100 万 | 3 万 | 20 万件/日 | 2,000 件/秒 | 5,000 万・500 万 | 東京の 1 リージョン・3 AZ。共有のセル 2 つ（セルの仕組みを初日から使う）。セルごとに Aurora の writer 1 台＋reader 2 台。大阪にウォームスタンバイ（Aurora Global Database） |
| S2 | 3,000（1,000） | 1,000 万 | 30 万 | 200 万件/日 | 20,000 件/秒 | 5 億・2,000 万 | 共有のセルを増やす。大口の企業に専用のセルを出す。レポートの集計を分析の専用の置き場所へ。RTO を 15 分に縮める |
| S3 | 3 万（1 万） | 1 億 | 300 万 | 2,000 万件/日 | 200,000 件/秒 | 50 億・1 億 | セルを東京・大阪の両方で受ける。海外のリージョン。関係のグラフの走査の置き場所を再評価（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md)） |

- 数値は本システムの想定。本家の実数は公開の資料で確かめられなかった（未検証。本家の数値は設計の前提ではない）。
- API のピークは、画面の操作、REST API、ポータルを合わせた要求の数。取り込み（メール・CMDB）は別に数える。
- 動いている SLA の計時は、S1 でおよそ 200 万件、動いているフローの実行はおよそ 100 万件と見込む。タイマーの発火は、業務の開始の時刻（平日の 9 時）に集中する。
- 段階を上げる判断の基準は [infrastructure.md](infrastructure.md) の 9 節にある。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | フォームとリストの速さ | フォームを開く（レコード＋関連リストの最初の 1 ページ）のサーバーの処理 p99 300ms 以内、画面の表示まで p95 1 秒以内。リストの 1 ページ（索引のある条件、50 行まで）のサーバーの処理 p99 500ms 以内 | ACL の判定を含む。カスタムのフィールドでの絞り込みは、索引の対象のフィールドに限る（[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md)） |
| NFR-002 | 保存の速さ | レコードの保存（検証、ACL、同期のルール、履歴、outbox）のサーバーの処理 p99 700ms 以内 | 同期のルールの数と重さに上限を置く（workflow-engine の領域） |
| NFR-003 | SLA の計時の正しさ | 期限の時刻は、同じ入力に対して参照の実装と秒の単位で一致する。警告と違反の発火は、期限の時刻から p99 60 秒以内。停止・一時停止の反映は、レコードの更新と同じトランザクション | 本家は違反の近さで分けた 6 つの定期のジョブで計時を更新する（10 分以内に違反のものでも 1 分ごと。[Scheduled jobs for SLA](https://www.servicenow.com/docs/r/it-service-management/service-level-management/c_ScheduledJobsForSLA.html)、2026-09-28 に確認）。本システムは期限の時刻をタイマーに登録する（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)） |
| NFR-004 | ワークフローの耐久性 | 受け付けたフローのステップ・承認・タイマーを失わない。各遷移はちょうど 1 回。プロセスや AZ の障害の後、止まった実行は 60 秒以内に再開する | 外への呼び出しは少なくとも 1 回で、冪等のキーを付ける |
| NFR-005 | CMDB の調整の正しさ | 取り込みで作られた重複の CI 0 件。属性の最終の値は、到着の順序によらず優先度と鮮度の規則だけで決まる。取り込みは 1 セルで 1 秒 1,000 CI を処理する | [ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md) |
| NFR-006 | 可用性 | 本番のテナントで月間 99.95%（画面・API・ポータル・メールの受信） | 本家の契約の可用性の値は未検証（契約の文書は公開されていない）。サブプロダクション（開発・検証）のテナントは対象外 |
| NFR-007 | 耐久性と AZ の障害 | 成功を返した書き込みを失わない。RPO 0、RTO 5 分以内 | Aurora の Multi-AZ |
| NFR-008 | リージョンの障害 | RPO 1 分以内、RTO 1 時間以内 | 本家の AHA は RPO 1 時間・RTO 2 時間を目標にしている（[Advanced High Availability Architecture](https://www.servicenow.com/lpwhp/high-availability-whitepaper.html)、2026-09-28 に検索の結果の抜粋で確認。白書の本文は取得できず（403）未検証で、本家の振る舞いとして参考にだけ使う）。S2 で RTO 15 分以内 |
| NFR-009 | テナントの分離 | 他のテナントのデータが見える事象 0 件。専用のセルのテナントは、DB・キャッシュ・検索の索引・暗号の鍵を他のテナントと共有しない | [ADR-0002](../decisions/0002-tenancy-and-isolation.md) |
| NFR-010 | アクセス制御と監査 | ACL で読めない値が、どの出口からも漏れた件数 0 件。監査の対象のテーブルの変更は、変更と同じトランザクションで履歴に残り、欠けが 0 件 | access-control、data-dictionary-and-tables の領域 |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（サービス・Web） | 他の題材と同じ（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| HTTP・検証 | Hono＋Zod。REST API は `@hono/zod-openapi` で OpenAPI を出す。テナントのテーブルの検証は、データ辞書から Zod のスキーマを組み立てる | 他の題材と同じ。メタデータから型を作る |
| 画面 | React の SPA（作業の画面・ポータル・設定）。フォームとリストはサーバーがコンパイルした画面のモデルを描く | [ADR-0040](../decisions/0040-metadata-driven-forms-and-lists.md)、[ADR-0041](../decisions/0041-employee-portal-themes-widgets-and-push.md) |
| DB | Aurora PostgreSQL 18、RLS、ID は UUIDv7。セルごとに 1 つのクラスタ（S1） | [ADR-0002](../decisions/0002-tenancy-and-isolation.md)、[ADR-0003](../decisions/0003-table-hierarchy-and-extensible-schema.md) |
| ワークフロー・タイマー | Aurora の上の自前のエンジン（実行の状態とタイマーの表、`FOR UPDATE SKIP LOCKED`） | [ADR-0004](../decisions/0004-workflow-and-sla-engine.md) |
| キャッシュ | ElastiCache（Valkey） | 失われてもよい |
| 検索 | Amazon OpenSearch Service（日本語の解析器は Sudachi ＋ 2 文字の n-gram） | [ADR-0043](../decisions/0043-japanese-analyzer-and-index-layout.md)。E9 の評価で確かめる |
| 非同期 | transactional outbox → SQS | 他の題材と同じ |
| メール | Amazon SES（東京で受信と送信。大阪も受信に対応） | 東京・大阪とも受信のエンドポイントがある（[Amazon SES endpoints and quotas](https://docs.aws.amazon.com/general/latest/gr/ses.html)、2026-09-28 に確認） |
| ファイル | S3（添付ファイル、メールの原本）、CloudFront の署名付き URL | |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs | 他の題材と同じ |
| フラグ | AWS AppConfig | 他の題材と同じ。テナント・セルの単位で振る舞いの変更を出す |
| テスト | Vitest、fast-check、Testcontainers、Playwright | 他の題材と同じ。SLA・CMDB の性質ベーステストと、ワークフローの障害注入 |

## 5. 主な決定

どれも `accepted`（2026-09-28）。状態の一覧は [decisions/README.md](../decisions/README.md)。題材の最初の設計の間なので、統合の工程で直した ADR には日付付きの注記を残した（0002・0003・0004・0005・0015・0018・0034・0035・0047・0054。[process.md](../../../../docs/process.md) の 9 節）。検証の工程（2026-09-28）で公式の文書と照らして直した ADR（0024・0033・0035）にも注記を残した。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、記録の基盤を自前で実装する。本家のスクリプトの API との互換は求めない |
| [0002](../decisions/0002-tenancy-and-isolation.md) | 共有のセルでの RLS のマルチテナントを既定にし、大口の企業には同じ版の専用のセルを出す |
| [0003](../decisions/0003-table-hierarchy-and-extensible-schema.md) | テーブルはクラスの継承の階層として辞書に持ち、組み込みのクラスは型付きの列、テナントの拡張は JSONB と型付きの索引の表で持つ |
| [0004](../decisions/0004-workflow-and-sla-engine.md) | ワークフロー・承認・SLA は Aurora の上の自前の耐久性のあるエンジンで動かし、遷移をレコードと同じトランザクションで 1 回だけ行う |
| [0005](../decisions/0005-cmdb-identification-and-reconciliation.md) | CI の作成・更新を識別と調整の 1 つの入口に集め、正規化した識別の値の一意の索引で重複を防ぐ。関係のグラフは PostgreSQL に持つ |
| [0006](../decisions/0006-data-dictionary-and-field-types.md) | 辞書は組み込みの定義とテナントの定義を重ねて持ち、フィールドの型を 14 種に限る。子のクラスは属性を上書きできるが型は変えられない |
| [0007](../decisions/0007-physical-layout-and-extension-index.md) | `task`・`ci` を階層ごとに 1 つの表に置き、S1 ではパーティションに分けない。参照のフィールドは必ず索引の表に写す |
| [0008](../decisions/0008-record-numbering.md) | 番号はテナント・番号の定義ごとの数の行から、保存とは別の短いトランザクションで取る。欠番のないことは約束しない |
| [0009](../decisions/0009-record-audit-history-and-journal.md) | 監査の履歴は保存ごとに 1 行、変更と同じトランザクションで追記だけの表に書く。日ごとのハッシュの鎖を S3 Object Lock に置く |
| [0010](../decisions/0010-metadata-versions-and-config-packages.md) | メタデータの変更はテナントの版の番号を上げる 1 つのトランザクションで行う。設定の移送は、安定したキーと元の版のハッシュを持つパッケージで行う |
| [0011](../decisions/0011-roles-groups-and-acl-evaluation.md) | ACL は許可の条件と拒否の条件の 2 種の規則で書き、拒否は階層のすべての段で、許可は最も近いクラスの段で評価する。一致する許可がなければ拒否する |
| [0012](../decisions/0012-acl-enforcement-at-every-exit.md) | 行の規則の条件は SQL の述語にコンパイルできる式に限り、読めないフィールドの値は利用者にとって NULL として扱う。判定の材料は `acl_version` をキーにキャッシュする |
| [0013](../decisions/0013-impersonation-and-tenant-sso.md) | 成り代わりは権限を広げず、承認・権限の変更・エクスポートをさせない。テナントの SSO は複数の IdP を持ち、SP 起点を既定にし、非常用の管理者を残す |
| [0014](../decisions/0014-flow-dsl-and-versioning.md) | フローは決まったノードと式の言語だけの JSON の文書で書き、公開すると不変の版になる。実行は開始したときの版に固定し、移し替えない |
| [0015](../decisions/0015-flow-execution-and-timers.md) | 実行は `flow_run`・`flow_step`・`timer` の表で持ち、1 回の進みを 1 つのトランザクションで行う。トリガーは保存と同じトランザクションで実行を作る |
| [0016](../decisions/0016-approvals.md) | 承認はまとまりと個々の承認の 2 つの行で持ち、回答を版の条件付きで 1 回だけ反映する。本人の承認を既定で禁止し、承認の記録が要るテーブルでは期限切れの自動の承認とメールの返信での承認を受けない |
| [0017](../decisions/0017-no-code-record-rules.md) | レコードのルールは保存の前・保存の後・非同期の 3 種で、決まった操作だけを持つ。連鎖の深さを 3 にし、超えたら全体を巻き戻す |
| [0018](../decisions/0018-flow-limits-and-tenant-fairness.md) | テナントごと・実行ごとの上限を置き、タイマーの取得をテナントごとの取り分で行い、SLA と承認の発火をフローのステップより先にする |
| [0019](../decisions/0019-business-calendar-and-pure-time-functions.md) | カレンダーは不変の版で持ち、計時は秒の単位の半開区間の上の純粋な関数 2 つで行う。祝日はその暦の日の 0〜24 時を除き、期限は業務時間がちょうど d になる最も早い時刻とする |
| [0020](../decisions/0020-japanese-holiday-data.md) | 内閣府の祝日の CSV を定期に取りに行き、法の規則との突き合わせと人の承認を経て版として公開する。収録の範囲の外は祝日なしで計算し、後で計算し直す |
| [0021](../decisions/0021-sla-definitions-and-timers.md) | SLA の計時の行は定義の版・カレンダーの版・タイムゾーンを開始の時に固定し、条件を保存と同じトランザクションで決まった優先の順に評価する。警告と違反はタイマーで発火し、違反の事実は後の計算し直しで取り消さない |
| [0022](../decisions/0022-process-state-machines.md) | インシデント・問題・変更の状態は、コードの版に含む宣言の遷移の表で持つ。テナントは状態と辺を足せず、条件と保留の理由だけを足せる。既知のエラーは状態ではなく印にする |
| [0023](../decisions/0023-priority-matrix-and-major-incident.md) | 優先度は影響度 × 緊急度の表から導き、直接は書かせない。メジャーインシデントは候補の行で扱い、自動では昇格させず、候補のインシデント自体を親にする |
| [0024](../decisions/0024-change-models-risk-and-cab.md) | 変更は種類ごとの状態のモデルで扱い、リスクは規則と質問票の高いほうにする。承認の方針は種類 × リスクの決定表で決め、CAB の決定も各承認者の回答として反映する。緊急の変更も承認なしに実施へ進めない |
| [0025](../decisions/0025-change-schedule-and-conflict-detection.md) | 禁止期間と保守の時間帯はカレンダーと同じ区間の表現で CI の条件に結び付けて持ち、衝突は純粋な関数で求める。禁止期間と凍結期間だけを実施の妨げにし、ほかの衝突は警告にする |
| [0026](../decisions/0026-assignment-rules-and-member-selection.md) | 割り当ての規則は順序付きで最初に一致した 1 つだけを使い、人が入れた割り当てを上書きしない。担当者はメンバーの行を SKIP LOCKED で取って選ぶ |
| [0027](../decisions/0027-on-call-rotations-and-escalation.md) | 当番表は不変の版の層と差し替えで持ち、当番を純粋な関数で求める。呼び出しは専用の状態機械とタイマーで進め、本人の受け付けで止める。経路は差し込み口にし、MVP はメールとプッシュだけにする |
| [0028](../decisions/0028-catalog-items-and-variables.md) | カタログの品目は公開で不変の版になり、申請の時の版に固定する。変数は 12 種と配置の 2 種に限り、表示の条件は画面とサーバーで同じ評価器を使ってサーバーを正とする |
| [0029](../decisions/0029-request-item-task-model.md) | 1 回の申請で要求と要求の品目を 1 つのトランザクションで作り、依頼者の冪等のキーで 1 回だけにする。要求の品目ごとに固定した版の実行のフローを動かし、要求の状態は子から導く |
| [0030](../decisions/0030-portal-requester-scope-and-record-producers.md) | 依頼者は自分が依頼した・自分のための・見守りに入った要求だけを見る。変数ごとに依頼者への公開を持ち、他人のための申請は品目の許可と関係があるときだけ許す。フォームからのレコードの作成も依頼者の主体で保存する |
| [0031](../decisions/0031-knowledge-articles-versions-and-publishing.md) | ナレッジの記事は記事の行と版の行で持ち、公開中と編集中の版をそれぞれ高々 1 つにする。レビューに出した本文を固定し、承認した本文だけを公開する。本文は制限付きの Markdown だけにする |
| [0032](../decisions/0032-knowledge-feedback-and-deflection.md) | 評価は利用者・版ごとに 1 件にし、旗は理由を必須にして持ち主のタスクにまとめる。自己解決は仮名のセッションの事象から、明示と推定を分けて数える |
| [0033](../decisions/0033-notification-rules-and-outbound-email.md) | 通知は Notifier で受け手ごとに作り、`(事象, 規則, 受け手, 経路)` の一意で 1 回だけ送る。本文は受け手の主体で ACL を判定して差し込み、送るメールには推測できない参照の印を付け、返信は印と SES が付けた `Message-ID` で紐付ける |
| [0034](../decisions/0034-inbound-email-threading-and-sender-trust.md) | 受信は共有の入口（SES → S3 → SQS → mail-router）からセルの Ingest へ送り、SES の ID で冪等にし、転送 → ヘッダー → 参照の印 → 件名の番号（関係者だけ）の順で紐付ける。差出人は認証の結果で信頼の段階を決め、返信の追記は差出人の主体の ACL を通す |
| [0035](../decisions/0035-mail-loop-prevention-and-japanese-decoding.md) | 自動のメールはヘッダーで見分けて自動の応答を返さず、不在の返信は追記しない。流量の上限を最後の守りにする。文字コードは WHATWG の対応で復号し、ラベルのない 8 ビットは UTF-8 → Shift_JIS → EUC-JP の順に試し、送るメールは UTF-8 だけにする |
| [0036](../decisions/0036-ci-classes-and-identification-rules.md) | CI のクラスは組み込みの階層にテナントが子を足す形で持ち、識別の規則は優先度付きの識別の項目の一覧にする。複数の値の属性は値ごとに、取り込み元の固有のキーは最も優先の項目にし、クラスの違う一致でもクラスを変えない |
| [0037](../decisions/0037-ci-ingest-entry-point-and-ambiguity-hold.md) | CI の入口は項目ごとに 1 つのトランザクションで識別と調整を行い、一致は使えるすべての識別の項目の和集合で決める。一意の制約の違反で識別をやり直し、2 つ以上の CI に一致したら候補の集合ごとに 1 つの保留にする。統合は人だけが行う |
| [0038](../decisions/0038-attribute-reconciliation-per-source-state.md) | 属性の調整は CI・取り込み元ごとの最新の観測の状態を max の結合で持ち、値をその状態の集合から純粋な関数で選ぶ。鮮度はその属性の最新の観測の時刻から測る。関係の有無も取り込み元ごとの状態から決める |
| [0039](../decisions/0039-ci-relations-impact-traversal-and-service-model.md) | 関係は型ごとに影響の向きを持つ表にし、影響の範囲は深さ 6・節 10,000・2 秒で打ち切る再帰の CTE で求める。画面の走査は見る人の ACL を押し込み、変更の評価はシステムの主体で走査して写しを残す。サービスのモデルは CSDM に寄せたクラスで持つ |
| [0040](../decisions/0040-metadata-driven-forms-and-lists.md) | フォームとリストはサーバーがコンパイルした画面のモデルを描く。画面の規則は画面とサーバーで同じ評価器を使いサーバーを正とし、リストはキーセットのページ送りと上限付きの件数にする |
| [0041](../decisions/0041-employee-portal-themes-widgets-and-push.md) | 従業員のポータルは同じホスト名の別の画面の束にし、見た目はテーマのトークンと決まった部品だけで変える。プッシュは Web Push で送り、ネイティブのアプリは MVP で作らない |
| [0042](../decisions/0042-i18n-ja-en-and-translations.md) | 画面の決まった文言はコードの版の ICU MessageFormat の辞書に、テナントの文言は安定したキーの翻訳の表に持つ。言語は利用者 → テナント → 日本語の順に決め、日時は UTC で保存し見る人のタイムゾーンで出す |
| [0043](../decisions/0043-japanese-analyzer-and-index-layout.md) | 日本語の解析器は Sudachi を既定にし、2 文字の n-gram を併せて持つ。索引はセルのドメインに種類ごとの共有の索引を置いて `tenant_id` で経路を決め、テナントのフィールドは入れ子の枠に入れる |
| [0044](../decisions/0044-acl-aware-search-and-index-freshness.md) | 検索は ACL の述語の索引で表せる部分を絞り込みにし、返す直前に DB で行とフィールドの読み取りを確かめ直す。一致と強調を読めるフィールドに限り、総数を出さない。索引は DB の今の行を外部の版で入れる |
| [0045](../decisions/0045-report-execution-on-reader-and-daily-facts.md) | 集計は S1 ではセルの Aurora のレポート用の reader で問い合わせの時に行い、推移のための過去の状態は日次の事実の表（行の写し）に持つ。集計の結果を事前に計算せず、S2 で PostgreSQL と互換の分析のクラスタへ移す |
| [0046](../decisions/0046-acl-aware-aggregation-and-per-recipient-delivery.md) | 集計は見る人の行の述語と `visible(f)` の上で行い、読めない値を空の値と区別しない。結果のキャッシュは主体を当てはめた問い合わせのハッシュで共有し、定期の配信は受け手ごとに計算してテナントの有効な利用者だけに送る |
| [0047](../decisions/0047-sla-attainment-and-breach-disputed.md) | SLA の達成率は期間の中に停止した計時の行を母数にし、`breach_disputed` の行は厳格と調整の 2 つの値と件数で出す。既定の表示は厳格にする |
| [0048](../decisions/0048-dictionary-driven-table-api.md) | REST のテーブルの API は実効の辞書から型を作る 1 組のエンドポイントにし、リストと同じ式の言語、キーセットのページ送り、`If-Match`、`Idempotency-Key` を持つ。連携のクライアントは OAuth 2.0 のクライアントクレデンシャルで、主体は `integration` の利用者にする |
| [0049](../decisions/0049-import-sets-and-transform-maps.md) | 一括の取り込みは取り込みの行の表に原本を置いてから、版付きの変換の対応で 1 行ずつ Record Service を通して書く。一致のキーは索引のあるフィールドに限り、キーごとの助言ロックで重複を防ぎ、2 つ以上に一致したら行のエラーにする。CI への取り込みは CMDB の入口を通す |
| [0050](../decisions/0050-signed-webhooks-and-tenant-rate-limits.md) | Webhook は値を入れない薄い事象を、Standard Webhooks に寄せた HMAC-SHA256 の署名で少なくとも 1 回送り、送る時点で購読の主体の ACL で確かめる。レート制限はテナントとクライアントのトークンバケットで、使いすぎは 429、容量の都合は 503 にする |
| [0051](../decisions/0051-threat-model-and-security-checklist.md) | 脅威は信頼境界と部品ごとの STRIDE で洗い出し、対策を `SEC-NNN` のチェックリストにして各行に拒否の側のテストを持たせる。ACL・テナントの分離・監査・承認に触れる変更は `security:sensitive` にする |
| [0052](../decisions/0052-keys-encryption-and-operator-access.md) | 鍵はセルごと・用途ごとの KMS のマルチリージョンの鍵にし、テナントの秘密をテナントごとの DEK で包む。運用者はテナントのデータへの常設の権限を持たず、テナントが出すサポートの参照の許可と期限付きの権限でだけ読む。AI エージェントは本番に経路を持たない |
| [0053](../decisions/0053-data-retention-and-deletion.md) | 保持の期間を種類ごとに既定案として決め、時間で消える表は時間のパーティションで持つ。テナントの削除は 30 日の猶予の後に全置き場所から消し、個人の削除の請求は利用者の行の仮名化で受ける。監査の履歴との関係は法務の L1・L4 まで保留する |
| [0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md) | `tenant_id` が NULL の行は、全テナントに同じで機密でない参照のデータだけに許し、RLS は読み取りだけで通す。テナントをまたいで読む DB のロールは、識別子だけを返す関数に限る |
| [0055](../decisions/0055-accounts-cells-and-edge-router.md) | セルごとに AWS アカウントを分け、制御の面・エッジ・メールの受信の入口を別のアカウントに置く。ルーターは CloudFront Functions と KeyValueStore でホスト名からセルを選び、セルの App はテナントを解決し直す |
| [0056](../decisions/0056-dedicated-cells-and-tenant-moves.md) | 専用のセルは 1 つの顧客のための共有のセルと同じ形のセルにし、同じコード・同じ版で動かす。テナントのセル間の移動は、写し・差分・短い停止・ルーターの切り替え・索引の作り直しの手順で行う |
| [0057](../decisions/0057-disaster-recovery-per-cell.md) | DR はセルごとに大阪のウォームスタンバイを持ち、人の判断で切り替える。検索の索引は複製せず切り替えの後に DB から作り直し、失った範囲の受信のメールは S3 の原本から冪等に取り込み直す |
| [0058](../decisions/0058-terraform-layout-stages-and-cost.md) | Terraform はセルを 1 つのモジュールとして持ち、セルの一覧のファイルから作る。セルを足す・段階を上げる基準を決め、費用をセル・アカウント・タグで配分する |
| [0059](../decisions/0059-slis-timer-lag-and-correctness-monitors.md) | 可用性はエッジで、画面の速さはサーバーの計測と自前の RUM で数える。タイマーと SLA の違反の発火の遅れはコミットの時刻と期限の差で数え、期限を過ぎた未発火の数を別に数える。正しさの監視を SLI と同じ扱いにする |
| [0060](../decisions/0060-alerts-and-runbook-mapping.md) | 呼び出しのアラートは SLO のバーンレート、正しさの監視の違反、セキュリティの症状に限り、すべてのアラートに runbook を注釈で持たせて CI で確かめる。個別の runbook ができるまでは incident-response の場面を指す |
| [0061](../decisions/0061-load-model-cell-sizing-and-timer-bursts.md) | セルは S1 の負荷の半分を 1 つの Aurora の writer で受ける大きさにし、9 時のタイマーの山は優先度・定期のトリガーのばらつき・平日 8:50 の予定の台数の拡大で受ける。優先度 2・3 の遅れは山の間 5 分まで許す |
| [0062](../decisions/0062-spec-driven-ci-fault-injection-and-leak-suite.md) | CI は `spec.md` の決定表を直接読み込んで動かし、性質ベーステスト・障害注入・出口ごとの漏れの試験を、PR（変更に関わるもの、短い版）と夜間（全体）の 2 段で必須にする |
| [0063](../decisions/0063-flags-and-staged-release-per-cell.md) | デプロイは制御の面 → カナリアのセル → 共有のセル → 専用のセルの段で行い、振る舞いはフラグで社内 → サブプロダクション → 本番の段で広げる。業務の振る舞いの変更は、顧客が最大 60 日の中で有効にする時期を選べる |
| [0064](../decisions/0064-migrations-and-metadata-compatibility-check.md) | DB は expand・移行・contract の 3 段、組み込みの定義はコードの版で変え、フローの意味は `engine_schema` で分ける。デプロイの前に、各セルの中で新しいコードが全テナントの今のメタデータをコンパイルできることを確かめる |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **ACL の漏れ**：出口が 16 あり（[access-control.md](access-control.md) の 6.2 節）、1 つでも判定を通らないと値や件数が漏れる。1 つの `decide` と述語のコンパイラ、読めない値の NULL の意味（[ADR-0012](../decisions/0012-acl-enforcement-at-every-exit.md)）、出口ごとの漏れの試験、本番の漏れの合成監視（[ADR-0059](../decisions/0059-slis-timer-lag-and-correctness-monitors.md)）で抑える。検索と集計は、推測の経路（総数、強調、「（読めない値）」のグループ）を閉じた（[ADR-0044](../decisions/0044-acl-aware-search-and-index-freshness.md)、[ADR-0046](../decisions/0046-acl-aware-aggregation-and-per-recipient-delivery.md)）。
- **テナントの分離の破れ**：RLS のコンテキストの漏れ、NULL の行の誤用、テナントをまたぐロール、検索の `tenant_id` の抜け、ルーター・メールの振り分けの取り違え。NULL の行の許可の一覧と識別子だけを返す関数（[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)）、セルの App の解決し直し（421。[ADR-0055](../decisions/0055-accounts-cells-and-edge-router.md)）、検索の DB での確かめ直しで二重に守る。
- **「1 回だけ」の破れ**：承認の二重の反映、遷移の欠落、タイマーの喪失、承認なしの実施。同じトランザクションでの遷移と版の条件（[ADR-0004](../decisions/0004-workflow-and-sla-engine.md)、[ADR-0015](../decisions/0015-flow-execution-and-timers.md)、[ADR-0016](../decisions/0016-approvals.md)）、障害注入の CI（[ADR-0062](../decisions/0062-spec-driven-ci-fault-injection-and-leak-suite.md)）、本番の突き合わせで抑える。
- **SLA の計時の誤り**：カレンダー・祝日・夏時間・日付をまたぐ営業時間の組み合わせ、計算し直し。純粋な関数と参照の実装との比較（[ADR-0019](../decisions/0019-business-calendar-and-pure-time-functions.md)）、違反の事実を取り消さない規則（[ADR-0021](../decisions/0021-sla-definitions-and-timers.md)）で抑える。
- **タイマーの集中**：平日 9 時に SLA の警告・違反と定期のトリガーが一斉に来る。優先度とテナントの取り分、ばらつき、予定の台数の拡大（[ADR-0061](../decisions/0061-load-model-cell-sizing-and-timer-bursts.md)）で受ける。見積もりは未検証で、E4 `timer-burst-generator` と E12 `timer-burst-load-test` の負荷試験で置き換える。
- **CMDB の識別の誤り**：弱い規則は重複を、強すぎる・誤った値は誤った統合を生む。誤った統合は戻す操作が MVP にない。あいまいなら止め（[ADR-0037](../decisions/0037-ci-ingest-entry-point-and-ambiguity-hold.md)）、統合は人だけにする。識別は到着の順序で変わりうる（[ADR-0005](../decisions/0005-cmdb-identification-and-reconciliation.md) の注記）ので、重複は日次の検出で拾う。
- **関係のグラフの走査**：深い・広いグラフで遅くなる。深さ 6・節 10,000・2 秒で打ち切る（[ADR-0039](../decisions/0039-ci-relations-impact-traversal-and-service-model.md)）。E10 で最大のテナントの規模で計測する。
- **メタデータ駆動の互換と性能**：新しいコードが古いメタデータを読めないと、ACL の拒否や既定の配置になる。リリースの前の全テナントのコンパイルの検査（[ADR-0064](../decisions/0064-migrations-and-metadata-compatibility-check.md)）で防ぐ。カスタムのフィールドの絞り込み・集計は索引の対象に限る（[ADR-0007](../decisions/0007-physical-layout-and-extension-index.md)）。
- **メールの取り込み**：なりすまし、自動の返信のループ、文字コード（ISO-2022-JP の拡張の文字）、紐付けの誤り（[ADR-0034](../decisions/0034-inbound-email-threading-and-sender-trust.md)、[ADR-0035](../decisions/0035-mail-loop-prevention-and-japanese-decoding.md)）。mail-ingress の一時のバケットに全テナントの原本が短い時間置かれる。
- **本家からの移行**：顧客は本家のカスタマイズ（スクリプト）を多く持つ。ノーコードの設定に置き換えられないものが残る。移行の範囲をデータと標準の設定に限る（intent の Non-goals、L7）。
- **法令と契約**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L9）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-09-28、既定案）

PM の方針（判断が要るところは推奨の既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した（L9 を足した）。計測・PoC で決めるものは、下の「持ち越し」に置いた。

- **ADR の状態**：0001〜0064 はすべて `accepted`。題材の最初の設計の間なので、食い違いは ADR を直接直し、日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。
- **冪等のキー**：ADR-0004 の `(flow_run, step, attempt)` の `attempt` は、ノードの実行の回（`iteration`）の意味で、配送の再試行の回数を含めない（ADR-0004 の注記、[workflow-engine.md](workflow-engine.md) の 5.5 節）。タイマーの索引は `(shard, due_at)`。
- **CMDB の調整と識別**：ADR-0005 の調整の決定表は到着の順序に依存するので、取り込み元ごとの状態の max の結合と純粋な選び方（[ADR-0038](../decisions/0038-attribute-reconciliation-per-source-state.md)）に置き換えた。一致は識別の項目の和集合で決める（[ADR-0037](../decisions/0037-ci-ingest-entry-point-and-ambiguity-hold.md)）。識別そのものは順序で変わりうることを ADR-0005 の注記と [AGENTS.md](../../AGENTS.md) に書いた。
- **NULL の `tenant_id` と組み込みのデータ**：組み込みのデータを「NULL の行」「コードの版だけ」「テナントの作成の時の行」の 3 つに分けた。NULL の行の許可の一覧は、辞書・ロール・ACL の規則・国民の祝日に、`number_def`・`ci_relation_type`・`ci_attribute`・`ci_identification_rule`・`flow_def`・`flow_version` を足したもの（[data-model.md](data-model.md) の 3.1 節、ADR-0002・ADR-0054 の注記、AGENTS.md）。
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
- **ITIL の版**：S1 は ITIL 4 の用語のままにする。ITIL（Version 5）は、安定した後、S2 の前に見直す（PM が決めた。[intent.md](../intent.md)）。
- **変更の承認の方針の期限の既定**：`change_approval_policy_rule.due_after` の既定（通常 3 日、緊急 4 時間）を承認した（[itsm-processes.md](itsm-processes.md) の 8.5.1 節）。
- **データモデルの正本**（2026-09-28、データモデルの工程）：[data-model.md](data-model.md) と [data-model/](data-model/) を列・制約・索引・ER 図の正本にした（184 テーブル）。領域の文書は振る舞いの正本で、食い違ったらデータモデルに合わせて直す。主な決定：版付きのメタデータは「定義の表 ＋ 不変の版の表」にそろえた（`sla_def_version`・`escalation_policy_version`・`transform_map_version` を足した）。メタデータの論理削除は `deleted_at`。参照の列は `<name>_id`、辞書の名前は `_id` を除く。セッションの正本は Aurora の `user_session`（Valkey は写し）。`tenant_deletion_run` は制御の面に置く。NULL の行を持つ表の主キーは `id` だけにし、参照の先をトリガー `check_shared_ref()` で確かめる。列の決まっていなかった参照の先（`company`・`department`・`location`、`tenant_setting` など）を最小の形で定義した。一覧は [data-model.md](data-model.md) の 7 節の 10〜22。
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

## 7. 領域の文書

領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [data-dictionary-and-tables.md](data-dictionary-and-tables.md) | データ辞書（テーブル・フィールド・型・参照・選択肢）、クラスの継承（タスク → インシデントなど）、物理の配置、カスタムのフィールドとテーブル、番号の採番、レコードの監査の履歴と作業メモ、メタデータの版と反映、テナントの間の設定の移送（開発 → 本番） | 0006–0010 | QA | E2 |
| [access-control.md](access-control.md) | ユーザー・グループ・ロール、ACL（テーブル・レコード・フィールド × 作成・読み取り・書き込み・削除）、評価の順序と既定の拒否、継承したクラスの規則、判定のキャッシュ、代理と成り代わり、テナントの SSO（SAML・OIDC） | 0011–0013 | QA、セキュリティ | E3 |
| [workflow-engine.md](workflow-engine.md) | フローの定義（ノーコードの DSL）と版、実行とタイマー、承認（多段、代理、期限切れ）、レコードのルール（同期・非同期、スクリプトなし）、外への呼び出し、上限と公平性 | 0014–0018 | QA、Ops | E4 |
| [sla-and-calendars.md](sla-and-calendars.md) | 業務カレンダー（営業時間、タイムゾーン、祝日、会社の休日）、祝日のデータの取り込み、SLA・OLA の定義（開始・一時停止・停止・リセット、さかのぼりの開始）、期限の計算、警告と違反 | 0019–0021 | QA | E5 |
| [itsm-processes.md](itsm-processes.md) | インシデント・問題・変更の状態のモデル、優先度の表（影響度 × 緊急度）、メジャーインシデント、変更の種類・リスクの評価・承認の方針・CAB、変更の予定表・衝突・凍結期間 | 0022–0025 | QA、PM | E6、E7 |
| [assignment-and-on-call.md](assignment-and-on-call.md) | 割り当ての規則、担当のグループ、当番表とローテーション、エスカレーション、オンコールの通知 | 0026–0027 | QA、Ops | E5 |
| [service-catalog-and-requests.md](service-catalog-and-requests.md) | カタログと品目、入力の項目（変数）と表示の条件、利用できる人の条件、要求・要求の品目・実行のタスクのモデル、承認と実行のフロー | 0028–0030 | QA | E8 |
| [knowledge.md](knowledge.md) | 記事と版、レビューと公開の流れ、公開の範囲、評価とフィードバック、問題からの既知のエラーの公開、ポータルでの自己解決の計測 | 0031–0032 | QA | E9 |
| [notifications-and-email-ingest.md](notifications-and-email-ingest.md) | 通知の規則とテンプレート、SES での送信、メールの受信とチケットへの紐付け（参照の印、`In-Reply-To`）、差出人の照合、ループの防止、なりすましへの対策、文字コード | 0033–0035 | QA、Ops | E6 |
| [cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) | CI のクラスの階層と属性、識別の規則（独立・依存の CI）、取り込み元の優先度と鮮度、重複の候補、関係の型とグラフの走査、影響の範囲、CSDM に寄せたサービスのモデル。後のディスカバリーとサービスマッピング | 0036–0039 | QA | E10 |
| [portal-and-ui.md](portal-and-ui.md) | 作業の画面（メタデータから描くフォームとリスト、関連リスト、UI の方針の規則）、従業員のポータル（テーマと部品）、多言語（日本語・英語）、アクセシビリティ | 0040–0042 | QA | E2、E6、E8 |
| [search.md](search.md) | 全体の検索、ナレッジの検索、OpenSearch の索引と反映、ACL を効かせた検索、日本語の解析器 | 0043–0044 | QA、セキュリティ | E9 |
| [reports.md](reports.md) | レポート（一覧・集計・推移）、ダッシュボード、定期の配信、集計の置き場所、ACL を効かせた集計 | 0045–0047 | QA | E11 |
| [api-and-integrations.md](api-and-integrations.md) | REST のテーブルの API、取り込みの API、Webhook とイベントの購読、API のクライアントの認証、レート制限、冪等性、ヘッダー（`<Brand>-` の形） | 0048–0050 | QA、Ops | E11 |
| [security.md](security.md) | 脅威モデル、暗号化と鍵、運用者のアクセス、運用の監査ログ、データの保持と削除、脆弱性の対応、法務の論点の整理 | 0051–0054 | セキュリティ | E1、E12 |
| [data-model.md](data-model.md)、[data-model/](data-model/) | データモデルの正本（置き場所、規約、ER 図、テーブルの列・制約・索引、DB 以外の置き場所の形） | なし（各領域の ADR を参照する） | QA | 全 Epic |
| [infrastructure.md](infrastructure.md) | AWS のアカウントとネットワーク、セルの構成とルーター、専用のセル、冗長化、DR、段階を上げる基準 | 0055–0058 | Ops | E1、E12 |
| [observability.md](observability.md) | ログ・メトリクス・トレース、SLI の計測、タイマーの遅れ・フローの滞留の計測、テナントごとの計測 | 0059–0060 | Ops | E1、E12 |
| [capacity.md](capacity.md) | 負荷のモデル（9 時の集中、月末・期末の変更の集中）、部品ごとの必要量、セルの大きさ | 0061 | Ops | E12 |
| [delivery.md](delivery.md) | CI/CD、リリースとフラグ、テナント・セルの単位の段階的なリリース、メタデータのマイグレーション | 0062–0064 | QA、Ops | E1、E12 |

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。E1〜E12 が MVP（S1）、E13 以降は MVP の後。E13 以降に入れなかった機能は、roadmap.md の「後回し」にある。

# Security: Salesforce

信頼境界、脅威モデル、組織をまたぐ漏えいと見えないデータの漏えいの経路、鍵と暗号化、運用者のアクセス、データのライフサイクルと組織の削除、セキュリティの試験と脆弱性の管理、法務の論点の整理。土台は [ADR-0004](../decisions/0004-record-access-model.md)（アクセスの判定を 1 か所に集める）と [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)（共有スキーマと RLS で組織を分ける）。この文書で決めたことは、次の 3 つの ADR にある。

- **漏えいの経路を 1 つの登録簿（`LEAK-*`）にし、経路ごとに否定側のテストと本番の検査を必須にする**（[ADR-0051](../decisions/0051-leak-path-register-and-threat-model.md)）。
- **KMS の鍵はセルと用途ごとに持ち、組織ごとのデータキー（DEK）で S3 の組織のファイルとアプリの秘密を暗号化する。** レコードは DB の保存時の暗号化だけにし、組織の削除は鍵の破棄で仕上げる（[ADR-0052](../decisions/0052-key-hierarchy-and-per-org-data-keys.md)）。
- **運用者は、組織の管理者の許可と期限つきの権限でだけ組織のレコードに触れ、全ての操作を組織の監査に残す。** データの種類ごとの保持と消去の期限を 1 つの表で持つ（[ADR-0053](../decisions/0053-operator-access-and-data-lifecycle.md)）。

| 関連 | 決定 |
| --- | --- |
| [ADR-0013](../decisions/0013-permission-sets-and-field-level-security.md) | 読めない項目は存在しない項目と同じに扱う |
| [ADR-0017](../decisions/0017-reference-access-evaluator.md) | 参照の評価器と本番の標本の照合。多く見せる食い違いはセキュリティの呼び出し |
| [ADR-0032](../decisions/0032-search-permission-post-filter.md) | 検索の結果は後で確かめる |
| [ADR-0035](../decisions/0035-webhooks-outbound-calls-and-ssrf-guard.md) | 送信の網と宛先の検査 |
| [ADR-0038](../decisions/0038-sandbox-types-and-masked-copy.md) | Sandbox の複製の経路での伏せ |
| [ADR-0044](../decisions/0044-authentication-better-auth-sso-and-mfa.md)、[ADR-0045](../decisions/0045-system-permissions-and-delegation.md) | 認証、権限の昇格の防止 |
| [ADR-0046](../decisions/0046-setup-audit-trail-and-login-history.md) | 監査の追記だけ、ハッシュの鎖、Object Lock の錨 |
| [ADR-0054](../decisions/0054-accounts-network-and-service-separation.md) | アカウントとネットワークの分け方 |
| [ADR-0062](../decisions/0062-security-sensitive-change-flow.md) | `security:sensitive` の変更の流れ |

本家の仕組みは、2026-09-28 に確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目標と前提

- **OWASP ASVS 5.0 の Level 2 を全体の目標にし、アクセス制御の章は Level 3 を目標にする。** この題材の最も重い誤りは、アクセスの判定の誤りだからである。章の番号との照合は E1 で行う（ASVS の原文との照合は未検証）。
- 最も重い障害は 4 つ。
  1. **組織をまたぐ漏えい**：他の組織のレコード・メタデータ・ファイル・イベントが見える（NFR-009、K7）。
  2. **組織の中の見えないデータの漏えい**：共有・FLS の判定の誤りで、見せてはならないレコード・項目が、画面・API・レポート・検索・イベント・エクスポートのどこかに出る（K3）。
  3. **Sandbox への個人データの流出**：伏せていない本番の個人データが、開発・試験の組織に入る（法務の L3）。
  4. **組織の全データの持ち出し**：乗っ取られた管理者・連携のトークンによる、Webhook・一括の問い合わせ・エクスポートでの持ち出し。
- 実行基盤・CI/CD・監視の統制は、rebuilds の他の題材の決定を引き継ぐ（[ADR-0001](../decisions/0001-platform-and-stack.md)）。この文書は、CRM の基盤に固有の部分を書く。
- **AI エージェント（コーディング・運用）は、本番に一切の経路を持たない**（ADR-0053）。

本家の比べる相手：

- 本家の Shield Platform Encryption は、組織ごとの tenant secret と本家の master secret（KDF の種）から、HSM の上の PBKDF2 でデータの暗号化の鍵を導き、導いた鍵を保存しない。組織が鍵を持ち込む方式もある（[Shield Platform Encryption Architecture](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/security_shield_platform_encryption.pdf)。検索の結果の要約で読んだ。本文は未検証）。
- 本家の Hyperforce は、変えない基盤（作り直して入れ替える）、3 つ以上の AZ、ゼロトラスト（全ての経路を明示に認証・認可、JIT の特権）、IaC、保存時・通信時の暗号化、組織ごとの暗号の鍵を原則に挙げる（[Behind the Scenes of Hyperforce](https://engineering.salesforce.com/behind-the-scenes-of-hyperforce-salesforces-infrastructure-for-the-public-cloud-429309542d8e/)、[Hyperforce](https://www.salesforce.com/platform/public-cloud-infrastructure/)、2026-09-28 に確認）。セル・組織の割り当ての細部は公開の記事になかった（未検証）。

## 2. 信頼境界

```
 ┌──────────────── インターネット（信頼しない）────────────────────────────────┐
 │ 営業の利用者のブラウザ  連携のアプリ（OAuth）  組織の管理者  組織の IdP  攻撃者    │
 └───┬───────────────────────┬──────────────────────┬──────────────────────────┘
     │ <org>.my.<brand>.<domain>                      │ SAML・OIDC
 ════╪══ B1：エッジ（CloudFront＋WAF）══════════════════╪══════════════════════════
     ▼                                                ▼
 ┌──── prod アカウント（東京・大阪）───────────────────────────────────────────────┐
 │  ALB ─▶ runtime・metadata・bulk ─(ソケット)─▶ code-runner（B6：WASM の砂場、E13）│
 │   ══ B2：組織のコンテキスト（ホスト名・トークン → org_id、SET LOCAL、FORCE RLS）══    │
 │   ══ B3：データ層（コンパイラの段 3・4 で権限・共有・FLS。直接の SQL の禁止）══       │
 │  Aurora（主・events・history）  Valkey  OpenSearch  S3（組織の DEK で暗号化）      │
 │  worker ─ cross-org-worker（B4：RLS を外す唯一の経路。組織の作成・Sandbox・移動）  │
 │     │ 署名済みの要求（SQS）                                                     │
 └─────┼──────────────────────────────────────────────────────────────────────┘
 ══ B5：prod-egress アカウント（本体への経路なし）══ Webhook・外向きの呼び出し → 組織の宛先
 ══ B7：管理プレーン ══ CI/CD（OIDC）、運用者（SSO＋MFA、JIT）、log-archive（監査の錨、Object Lock）
 ─ ─ B8：開発環境（AI コーディングエージェント）… 本番への経路なし ─ ─
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | 全ての外部の要求 | TLS 1.2 以上、HSTS、WAF、オリジンは CloudFront からだけ受ける（[infrastructure.md](infrastructure.md) の 2.1 節） |
| B2 組織 | サービスから DB | DB を読む前にホスト名・トークンから組織を決める。`SET LOCAL app.org_id`・`app.shard_no`、`FORCE ROW LEVEL SECURITY`（ADR-0005、[ADR-0010](../decisions/0010-record-tables-partitioning-and-pivots.md)） |
| B3 データ層 | 利用者の要求からレコード | 問い合わせと DML の AST をコンパイラで束縛・権限・共有の条件の付加（[ADR-0003](../decisions/0003-metadata-driven-runtime.md)）。`records` とピボットへの直接の SQL を lint で禁止 |
| B4 組織をまたぐ処理 | RLS を外す処理 | 専用のサービス `cross-org-worker` と DB のロール `admin_cross_org` だけ（ADR-0054） |
| B5 外向きの送信 | 組織の宛先 | 別のアカウントの送信の VPC、宛先の検査、本体での署名（ADR-0035、ADR-0054） |
| B6 利用者のコード（E13） | 利用者のコードから本体 | WASM の砂場、WASI なし、ホストの API だけ（[extensibility.md](extensibility.md) の 9 節） |
| B7 管理プレーン | デプロイ、鍵、運用者の操作 | OIDC の短命な認証情報、JIT、2 人の承認（ADR-0053、ADR-0062）、監査 |
| B8 開発環境 | コード（PR としてのみ） | 本番の資格情報・本物の個人データを置かない（systems/salesforce の AGENTS.md） |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主な脅威と対策だけを書く。情報の漏えい（I）の細目は 4 節の登録簿にある。

### 3.1 エッジと組織の解決

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | オリジンを直接叩き、WAF を迂回する | ALB は CloudFront のマネージドプレフィックスリストと秘密のヘッダーだけを受ける（infrastructure の 2.1 節） |
| T | `Host`・`X-Forwarded-Host` を偽り、別の組織に解決させる | 組織の解決は CloudFront が付けた元のホスト名のヘッダーだけを使う。クライアントの同じ名前のヘッダーは CloudFront で上書きする |
| T | トークンのホスト名と、要求のホスト名が違う | OAuth のトークンは `token_routes` で組織を決め、ホスト名の組織と違えば 401（[orgs-users-and-auth.md](orgs-users-and-auth.md)） |
| D | L7 の大量の要求、ログインの総当たり | WAF の IP のレート制限、組織の割り当てと長い要求の同時実行（[ADR-0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md)） |

### 3.2 Runtime とコンパイラ（データ層）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 共有・FLS の条件の付け漏れ（新しい経路、新しい構文） | 判定をコンパイラの段 3・4 の 1 か所だけにする。参照の評価器との一致の性質ベーステスト。本番の標本の照合（ADR-0017） |
| I | 読めない項目で絞る・並べる・集計して、値を推し量る | 読めない項目は存在しない項目と同じ応答（ADR-0013） |
| I | 数式・積み上げ集計を通して、読めない項目の値が出る | 参照先を全て読める時だけ値を返す（[ADR-0009](../decisions/0009-formula-language-and-evaluator.md)、[ADR-0027](../decisions/0027-roll-up-summaries-incremental-with-reconciliation.md)） |
| T | 問い合わせの言語・数式からの SQL の注入 | AST からの生成だけ。値は全てバインド変数（ADR-0003） |
| E | レイアウトの `readonly` を API で越えて書く | レイアウトはアクセス制御ではない。どこでも守る規則は項目・入力規則で書く（[ADR-0023](../decisions/0023-layouts-and-record-page-composition.md)） |
| E | `manage_users` の利用者が自分に強い権限を渡す | 部分集合の規則（ADR-0045） |
| D | 1 つの組織の重い処理が共有の DB を占める | トランザクションの上限、割り当て、`statement_timeout`、騒がしい隣人の検知（[ADR-0059](../decisions/0059-noisy-neighbor-detection-two-sources.md)） |

### 3.3 DB（Aurora）と写し

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | RLS のない新しい表 | CI で `org_id` と RLS の方針のないマイグレーションを失敗にする（ADR-0005） |
| I | ピボット・照合の鍵・共有の行・射影の写しから、正本にない値が読める | 写しは直接読む経路を持たない。整合の検査で差を 0 に保つ（[ADR-0012](../decisions/0012-derived-copies-consistency-and-projections.md)） |
| I | ごみ箱・削除した項目の値が残る | 確定から 24 時間・7 日で消す。遅れを計測する（ADR-0011、ADR-0006） |
| T | DB の特権での監査の書き換え | 追記だけの権限、ハッシュの鎖、別のアカウントの錨（ADR-0046） |
| E | 組織をまたぐ DB のロールの乱用 | `admin_cross_org` は 1 つのサービスだけ。操作は組織の監査に `system` として残す |

### 3.4 検索・イベント・Webhook・レポート・一括

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 共有の OpenSearch の索引で、組織の条件の付け漏れ | 1 つの関数で付け、後の確かめで DB の RLS に通す（2 重）（[ADR-0031](../decisions/0031-search-index-and-japanese-analysis.md)、ADR-0032） |
| I | 変更のイベントで、見えないレコード・読めない項目が届く | 購読に `view_all`、配信の時に FLS（ADR-0034） |
| I | 乗っ取られた管理者が Webhook の宛先を変えて、全てのデータを外へ出す | 宛先の変更は `manage_integrations`、監査、管理者全員への知らせ（ADR-0035） |
| E | SSRF で内部の資源（IMDS、DB）へ届く | 別のアカウントの送信の VPC、宛先の検査（ADR-0035、ADR-0054） |
| I | レポートの集計・部下の視点で、見えない行が数えられる | 見る人の権限で毎回コンパイル、共通部分（ADR-0029、[ADR-0030](../decisions/0030-dashboards-viewer-intersection-and-subscriptions.md)） |
| I | 一括の結果のファイルを、他の利用者・他の組織が取り出す | 作った利用者と `modify_all_data` だけ。組織の DEK で暗号化。署名付きの URL を渡さない（[ADR-0036](../decisions/0036-bulk-jobs-chunking-and-partial-success.md)） |
| R | 大量のエクスポート・削除を否認する | 監査の `data_bulk`（ADR-0046） |

### 3.5 Sandbox・デプロイ・認証・利用者のコード

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 伏せていない個人データが Sandbox に入る | 複製の経路の中で伏せる。分類の漏れを検出して警告（ADR-0038） |
| I | Sandbox から本番の組織のデータを読む | 別の `org_id`、RLS（ADR-0005） |
| T | 改ざんしたメタデータのパッケージのデプロイ | YAML の安全な読み込み、秘密を入れない（[ADR-0039](../decisions/0039-metadata-package-format.md)）。パッケージの署名（[ADR-0050](../decisions/0050-packages-namespaces-and-code-isolation.md)） |
| S | SSO の検証の漏れ、MFA の抜け道 | Better Auth の結合テスト、IdP 起点の SAML を断る、MFA を外せない（ADR-0044） |
| E | 利用者のコードの砂場の脱出（E13） | Wasmtime の境界、WASI なし、別のプロセス、資格情報なし（[ADR-0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md)） |
| I | 利用者のコードで、組織をまたぐ状態が残る | 呼び出しごとに新しい実体（extensibility の 4.2 節） |

### 3.6 管理プレーンと運用

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| E | 運用者が組織のレコードを勝手に見る | 組織の管理者の許可＋JIT＋2 人目の承認（ADR-0053） |
| E | CI の資格情報の乗っ取りで本番を変える | OIDC の短命な資格情報、`main` の保護、`security:sensitive` の 2 人の承認（ADR-0062） |
| T | 依存のパッケージの改ざん（供給の経路） | 依存の固定、許可しないパッケージの一覧（本家の SDK を含む。ADR-0001）、SBOM、署名の確かめ |
| R | 運用の操作の否認 | 組織の監査（`actor_kind = support`）と、本システムの CloudTrail |

## 4. 漏えいの経路の登録簿（ADR-0051）

種類：`cross_org`（組織をまたぐ）、`in_org`（組織の中の見えないレコード・項目）、`existence`（存在・件数の 1 ビット）。テストの ID は開発リポジトリで振る（`LEAK-NNN` をテスト名に含める）。

| ID | 経路 | 種類 | 守り | 否定側のテスト | 本番の検査 | 持ち主 |
| --- | --- | --- | --- | --- | --- | --- |
| LEAK-001 | `records` の読み（REST・画面・フロー） | cross_org・in_org | RLS、コンパイラの段 3・4 | 他の組織・見えないレコードで 404 | 標本の照合（ADR-0017） | sharing |
| LEAK-002 | ピボットの表を使った絞り込み | in_org | 同上。写しは直接読まない | ピボットの計画でも評価器と一致 | 整合の検査 | data-storage |
| LEAK-003 | 関係をたどる読み（親のドット、子の副問い合わせ、半結合） | in_org | 各オブジェクトに共有の条件 | 親・子が見えない時に空 | 標本の照合 | query-language |
| LEAK-004 | 読めない項目の `WHERE`・`ORDER BY`・`GROUP BY` | in_org・existence | 存在しない項目と同じ応答 | 応答が区別できない | — | sharing |
| LEAK-005 | 数式の値 | in_org | 参照先を全て読める時だけ | 読めない項目を参照する数式が出ない | — | metadata |
| LEAK-006 | 積み上げ集計の値 | in_org | 子の項目も読める時だけ | 同 | 整合の検査 | automation |
| LEAK-007 | リストビューの結果と件数 | in_org・existence | 見る人の権限で毎回コンパイル、件数は打ち切り | 見えない行が件数に入らない | 標本の照合 | ui |
| LEAK-008 | 関連リスト | in_org・existence | 件数を出さない | 同 | — | ui |
| LEAK-009 | レポートの集計・グループ・上位 N | in_org | 結ぶ全てに共有の条件 | `PROP-RPT-001` | 結果の行の標本の照合 | reports |
| LEAK-010 | ダッシュボードの部下の視点・定期の配信 | in_org | 共通部分、受け取る人ごとの実行 | `PROP-RPT-002` | — | reports |
| LEAK-011 | 全文検索の結果・強調 | cross_org・in_org | 前に絞る＋後で確かめる、値は DB から | `PROP-SRCH-001`・`002` | 標本の照合 | search |
| LEAK-012 | 検索の件数・応答の時間 | existence | 件数を返さない（時間は未対策） | 件数の合計がない | — | search |
| LEAK-013 | 変更のイベントの購読 | in_org | `view_all`、配信の時の FLS | DT-EVT-001 | — | events |
| LEAK-014 | Webhook の配信 | in_org | `run_as` の利用者で判定 | 同 | 宛先の変更の知らせ | events |
| LEAK-015 | 組織が定義するイベント | in_org | 型の権限、`system` の写しの警告 | — | — | events |
| LEAK-016 | 重複の照合の結果 | existence | `enforce` で見えない一致を無いものに | 見えない一致が応答に出ない | — | sales |
| LEAK-017 | upsert・インポートの照合 | existence | 見えない一致を無いものに | 同 | — | bulk |
| LEAK-018 | 一括の結果のファイル | cross_org・in_org | 作った人だけ、組織の DEK、署名付き URL なし | 他の利用者で 404 | — | bulk |
| LEAK-019 | レポートの非同期の結果・エクスポート | cross_org・in_org | 実行した人だけ、組織の DEK | 同 | — | reports |
| LEAK-020 | 結果のキャッシュ（レポート、レコードのページ） | in_org | 鍵に利用者と権限の形 | キャッシュが他の利用者の結果を返さない | — | reports・ui |
| LEAK-021 | メタデータの部品のキャッシュ | cross_org | 鍵に `org_id` | 他の組織の部品が使われない | — | metadata |
| LEAK-022 | カーソル | cross_org・in_org | 組織・利用者・問い合わせに結ぶ暗号 | 他の利用者のカーソルで 400 | — | query-language |
| LEAK-023 | エラーの文言（上限、入力規則、フロー） | in_org | 値を差し込まない | 読めない値が文言に出ない | ログの走査 | governor・automation |
| LEAK-024 | 計画の説明、統計、`NON_SELECTIVE_QUERY` | existence | 管理者だけ、件数を入れない | — | — | query-language |
| LEAK-025 | 項目の変更の履歴 | in_org | 読みの時の共有と FLS | `PROP-FH-002` | — | audit |
| LEAK-026 | Sandbox の複製 | in_org（個人データ） | 経路の中で伏せる | `PROP-SBX-001` | マスキングの警告の数 | sandboxes |
| LEAK-027 | Sandbox から本番の読み | cross_org | 別の `org_id`、RLS | ADR-0005 の性質 | — | sandboxes |
| LEAK-028 | アプリのログ・トレース | in_org（個人データ） | 値・リテラル・検索の語を入れない型 | ログの型の lint | 出力の走査 | observability |
| LEAK-029 | 運用者の道具 | in_org | 組織の許可と JIT | 許可なしで読めない | 監査 | security |
| LEAK-030 | 利用者のコードのホストの API（E13） | cross_org・in_org | データ層、呼び出しごとの新しい実体 | `user` で読めないものが出ない | — | extensibility |

- 新しい経路を足す変更は、この表に行を足す。`security:sensitive` の PR のテンプレートで問う（ADR-0062）。
- CI は、全ての行のテストの ID が、テストのコードから参照されていることを確かめる（[ADR-0061](../decisions/0061-access-decision-and-limit-gates-in-ci.md)）。

## 5. 鍵と暗号化（ADR-0052）

### 5.1 鍵の階層

```
AWS KMS（セルごと、マルチリージョンの鍵で大阪へ）
 ├─ aurora         … 主・events・history のクラスタの保存時の暗号化
 ├─ s3-org         … 組織の DEK（files・audit）を包む
 ├─ app-secrets    … 組織の DEK（secrets）を包む
 ├─ cursor         … セルのカーソルの鍵を包む（[ADR-0020](../decisions/0020-rest-api-shape-and-versioning.md)）
 ├─ backup         … AWS Backup の保管庫
 └─（log-archive アカウント）audit-archive … 監査の外部の保管の DEK を包む
       │
       ▼
 org_keys（組織 × 用途 × 版）の包んだ DEK
       │ AES-256-GCM、AAD = org_id ‖ purpose ‖ 対象の ID
       ▼
 S3 の組織のファイル（一括・レポート・エクスポート・添付・監査の保管）
 アプリの秘密（Webhook・外向きの呼び出し・OAuth のクライアントの秘密、画面のフローの状態）
```

- KMS の顧客管理の鍵は、アカウントとリージョンごとに既定で 100,000 まで（引き上げを申請できる。[AWS KMS resource quotas](https://docs.aws.amazon.com/kms/latest/developerguide/resource-limits.html)、2026-09-28 に確認）。S3 の 50 万の組織に鍵を 1 つずつ持つと足りない。組織の単位は DEK で持つ。
- DEK は 1 年ごとに新しい版を作る。平文の DEK はプロセスの中に 5 分だけ置く。
- S3 のバケットは、組織の接頭辞ごとに DEK で暗号化したオブジェクトを置き、S3 の保存時の暗号化（SSE-KMS、`s3-org` とは別の鍵）も重ねる。

### 5.2 何を暗号化するか

| データ | 暗号 | 理由 |
| --- | --- | --- |
| `records`、ピボット、共有の行、履歴、監査（Aurora） | Aurora の保存時の暗号化（`aurora` の鍵）だけ | アプリで暗号化すると、索引・一意・並べ替え・集計ができない |
| 変更のイベント（`events` のクラスタ） | 同上 | 同上 |
| 秘密（Webhook の秘密、外向きの呼び出しの認証、OAuth のクライアントの秘密、SSO の鍵） | 組織の `secrets` の DEK＋Aurora の暗号化 | 読みの API で返さない。Sandbox に写さない |
| 画面のフローの状態 | 組織の `secrets` の DEK | 変数に利用者の値が入る |
| S3 の組織のファイル | 組織の `files` の DEK | 組織の単位で消せるようにする |
| 監査の外部の保管 | 組織の `audit` の DEK（log-archive の鍵で包む） | Object Lock で消せないので、鍵の破棄で読めなくする |
| OpenSearch | ドメインの保存時の暗号化、ノードの間の TLS | 写しで、`_source` に本文を置かない（[search.md](search.md) の 9 節） |
| パスワード | Better Auth のハッシュ（Argon2id か scrypt。版の既定を確かめる。未検証） | ADR-0044 |
| OAuth のトークン | ハッシュだけ | ADR-0044 |

- 項目ごとの暗号化（本家の Shield に相当。`sensitive` の項目を組織の鍵で暗号化し、決定的な暗号で等価の検索だけを許す）は、MVP の後の課題にする（14 節）。
- 通信：外は TLS 1.2 以上。サービスの間と DB は TLS。Aurora は `rds.force_ssl` を有効にする。

## 6. 運用者のアクセス（ADR-0053）

| 入口 | 見られるもの | 条件 | 期限 |
| --- | --- | --- | --- |
| `support-read` | メタデータ、エラー、トレース、組織の使用量（レコードの値なし） | JIT の申請、理由の記録 | 4 時間 |
| `support-data` | 許可された範囲のレコードの値（読むだけ） | 組織の管理者（`manage_users`）の許可（1〜7 日、オブジェクトの単位）＋JIT＋別の運用者の承認 | 2 時間 |
| break-glass | 全て（直接の SQL を含む） | 2 人の承認＋セキュリティの担当の承認、セッションの記録 | 1 時間 |

- 全ての操作は、組織の監査に `actor_kind = support`・`via = support` で残り、組織の管理者が見られる（ADR-0046）。break-glass は、事後 24 時間以内に組織の管理者へ知らせる（法的に知らせられない時は法務が判断する）。
- 運用者の道具はデータ層を通る。組織の解決、RLS、上限がかかる。
- 本番のアカウントへの人の経路は、IAM Identity Center の JIT のロールだけ。長期の IAM ユーザーを持たない。
- AI エージェントは本番に経路を持たない。本番の調査は、人が道具で取り出した、個人データを含まない材料（トレース、組織の設定の形、メトリクス）だけを渡す。

## 7. データのライフサイクル（ADR-0053）

この表を正本にする。各領域の期限は写しで、食い違ったらこの表を正とする。期限の値は設定にし、**法務の L5・L7 の結論で変えうる**。

| データ | 保持 | 消し方 | 遅れの計測 | 出典の ADR |
| --- | --- | --- | --- | --- |
| ごみ箱のレコード | 15 日 | 確定から 24 時間以内に全ての表から | `purge_overdue` | [ADR-0011](../decisions/0011-recycle-bin-and-purge.md) |
| 削除した項目の値 | 15 日 | 確定から 7 日以内 | `field_purge_overdue` | [ADR-0006](../decisions/0006-data-dictionary-and-field-lifecycle.md) |
| 変更のイベント | 3 日 | 日ごとの分割の `DROP` | `events_partition_drop_overdue` | [ADR-0033](../decisions/0033-change-event-log-and-replay.md) |
| 監査（Aurora） | 180 日 | 月ごとの分割の `DROP` | `retention_drop_overdue` | ADR-0046 |
| 監査（外部の保管） | 1 年 | Object Lock の期限。組織の削除は鍵の破棄 | 同 | ADR-0046 |
| ログインの履歴 | 180 日 | 分割の `DROP` | 同 | ADR-0046 |
| 項目の変更の履歴（`history` のクラスタ） | 18 か月 | 分割の `DROP` | 同 | [ADR-0047](../decisions/0047-field-history-tracking-and-retention.md) |
| 商談の履歴（`opportunity_history`） | 18 か月（既定案） | 分割の `DROP` | 同 | ADR-0047 |
| 一括の元の CSV・結果 | 24 時間・7 日 | S3 のライフサイクル＋ジョブの確かめ | `bulk_cleanup_overdue` | ADR-0036 |
| レポートの非同期の結果 | 24 時間 | 同 | 同 | ADR-0029 |
| 画面のフローの状態 | 7 日 | ジョブ | — | [ADR-0025](../decisions/0025-flow-definition-and-bulk-engine.md) |
| Webhook の配信の記録、外向きの呼び出しの記録 | 7 日 | ジョブ | — | ADR-0035 |
| フローの非同期の経路の記録、Worker の `jobs` の終わった行、利用者のコードのデバッグのログ（E13） | 7 日 | ジョブ | — | ADR-0026、[ADR-0042](../decisions/0042-org-allocations-fair-queuing-and-limit-info.md)、[ADR-0048](../decisions/0048-user-code-engine-quickjs-ng-on-wasmtime-fuel.md) |
| 組織の間で送ったパッケージ（受ける側） | 30 日 | ジョブ | — | [ADR-0039](../decisions/0039-metadata-package-format.md) |
| 影の実行の結果（ID の集合のハッシュだけ） | 30 日 | ジョブ | — | [ADR-0063](../decisions/0063-org-staged-release-and-shadow-evaluation.md) |
| アプリのログ | 30 日 | CloudWatch Logs の保持 | — | [ADR-0058](../decisions/0058-slis-and-per-org-resource-metrics.md) |
| トレース | 30 日 | X-Ray の保持（既定の日数は未検証） | — | ADR-0058 |
| 組織ごとの使用量の表 | 1 分の粒度 7 日、1 時間の粒度 13 か月 | ジョブ | — | ADR-0058 |
| Aurora のバックアップ | 35 日 | 自動バックアップの期限 | — | ADR-0053 |
| OpenSearch の文書 | 正本に従う | 削除・消去・組織の削除で消し、整合の検査で確かめる | `search_drift_repaired_total` | ADR-0031 |
| 組織の全て（削除の申し込みの後） | 30 日の猶予 | 猶予の後 7 日以内に全て。最後に DEK を破棄 | `org_purge_overdue` | [ADR-0043](../decisions/0043-orgs-editions-licenses-and-users.md)、ADR-0052 |

### 7.1 組織の削除の順

```
申し込み（deleting、30 日の猶予。管理者だけがログインして書き出せる。取り消せる）
  ▼ 猶予の後
1. 組織の置き場所の全てのクラスタで、組織の行を消す（大きな表は ID の範囲ごと。admin_cross_org のロール）
2. events と history のクラスタの行を消す（分割の DROP を待たない）
3. OpenSearch の文書を消す（組織の条件の delete_by_query）
4. S3 の組織の接頭辞を消す（バージョンを含む）
5. Valkey の組織の鍵を消す
6. Sandbox の組織を同じ順で消す
7. 全ての org_keys の wrapped_dek を消し、destroyed_at を残す（監査の外部の保管と、S3 に残りうる版は読めなくなる）
8. org_purge_log に組織の ID のハッシュと日時を残す
  ▼ 35 日の後
Aurora のバックアップの期限で、バックアップの中の行も消える
```

- 7 日の期限は、組織の大きさ（5,000 万件）でも、範囲ごとの並行の削除で収まる見込み（E12 で測る）。

## 8. 秘密の扱い

- 本システムの秘密（DB の資格情報、KMS の鍵の ID、CloudFront の秘密のヘッダー、Better Auth の秘密）は Secrets Manager に置き、タスクのロールで読む。コードとイメージに入れない。
- 組織の秘密は 5.2 節のとおり。作成と入れ替えの時に 1 回だけ見せ、読みの API で返さない。
- トークン・キーの接頭辞は `<brand>_at_`・`<brand>_rt_`・`<brand>_whsec_` の形にし、GitHub のシークレットスキャンのパートナーに独自の形式として登録する（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- ログ・トレース・エラーに秘密を出さない。秘密の型（`Secret<T>`）を持ち、文字列にすると `[redacted]` になるようにする。出力の走査を本番のログの標本で行う（[observability.md](observability.md)）。

## 9. セキュリティの試験と脆弱性の管理

| 種類 | 頻度 | 中身 |
| --- | --- | --- |
| 決定表・性質ベーステスト | PR と夜間 | [delivery.md](delivery.md) の 2 節 |
| 漏えいの経路のテスト | PR | 4 節の全ての行 |
| SAST、依存の検査、秘密の走査 | PR | Critical・High で失敗 |
| コンテナのイメージの検査 | ビルドと毎日 | Inspector |
| DAST | 毎週（staging） | 認証、組織の解決、主な API |
| 外部のペンテスト | E12（GA の前）と年 1 回 | 4 節の登録簿を渡し、登録簿にない経路も探してもらう。E13 の前に砂場の脱出 |
| バグバウンティ | GA の後 | 組織をまたぐ漏えいを最高の報奨にする |

- 脆弱性の対応の期限：Critical 72 時間、High 14 日、Medium 90 日。Better Auth・Wasmtime・QuickJS-ng・PostgreSQL の勧告を購読する。
- 本番の検知：GuardDuty、Security Hub、CloudTrail の異常（KMS の鍵の操作、`admin_cross_org` の資格情報の読み）、参照の評価器の `over`、監査の鎖の食い違い。

## 10. インシデント

手順は [runbooks/incident-response.md](../runbooks/incident-response.md)。組織をまたぐ漏えい、見えないデータの漏えい（参照の評価器の食い違い）、Sandbox のマスキングの事故は、範囲が 1 件でも SEV2 以上にし、セキュリティの担当と法務を呼ぶ。

- 個人データの漏えい等に当たるか、報告の主体（組織か本システムか）、本人への通知の要否は、法務が判断する（法務の L1）。個人情報保護委員会への報告の期限（速報・確報）は、法務の確認を前提にする（未検証）。

## 11. 法務の論点（確認待ち）

設計はどの結論にも対応できる形にするが、結論は出さない（[intent.md](../intent.md) の「法務の確認待ち」）。

| # | この文書に関わる問い | 設計の備え | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 組織の個人データを、委託として扱うのか、クラウドの例外に当たるのか。サポートでの参照、障害の調査、AI での利用 | 運用者のアクセスの 3 段と、組織の許可（6 節）。AI エージェントに本番の経路なし | E2 の組織の作成の利用規約、E5 の取引先責任者とリード |
| L2 | 外国にある第三者への提供（メールの送信事業者、Webhook の宛先、SSO の IdP） | 海外の宛先の表示（events-and-integrations）、サブプロセッサーの一覧 | E8 の Webhook、E2 の SSO |
| L3 | Sandbox へのデータの複製の条件、マスキングの必須 | マスキングを外せない（ADR-0038） | E10 のデータを含む Sandbox |
| L5 | 監査のログ・履歴の保持と、本人の請求。ごみ箱と削除の期限 | 7 節の表を設定の値にする。履歴の値の消去（`erase_history_values`） | E11 の監査の保持と削除 |
| L6 | データの所在（バックアップ、DR、サポートでの参照、サブプロセッサー） | 東京と大阪だけ（SCP でほかのリージョンを禁止。infrastructure の 1 節） | E1 のリージョンの構成、E12 の契約の文書 |
| L7 | 委託の契約（DPA）の雛形、サブプロセッサーの変更の通知、解約時の返却と削除 | 30 日の猶予と書き出し、7 日の消去、鍵の破棄、バックアップの 35 日 | E12 の GA の判定 |

- L4（電気通信事業法）と L8（特定電子メール法）は、この文書の設計に直接の関わりが少ない。events-and-integrations と sales-objects の領域が扱う。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0051](../decisions/0051-leak-path-register-and-threat-model.md) | 組織をまたぐ漏えいと、見えないデータの漏えいの経路を 1 つの登録簿にし、経路ごとに否定側のテストと本番の検査を必須にする |
| [0052](../decisions/0052-key-hierarchy-and-per-org-data-keys.md) | KMS の鍵はセルと用途ごとに持ち、組織ごとのデータキーで S3 の組織のファイルとアプリの秘密を暗号化する。レコードは DB の保存時の暗号化だけにし、組織の削除は鍵の破棄で仕上げる |
| [0053](../decisions/0053-operator-access-and-data-lifecycle.md) | 運用者は組織の管理者の許可と期限つきの権限でだけ組織のデータに触れ、全ての操作を組織の監査に残す。データの種類ごとに保持と消去の期限を 1 つの表で持つ |

他の領域への依頼：

- 各領域：`LEAK-*` の行と、自分の否定側のテストの ID を対応させる。新しい経路を足す時は、この文書に行を足す。
- audit-and-field-history の領域：`org_keys` の `audit` の DEK で外部の保管を暗号化する（3.4 節の「組織ごとのデータキー」をこの文書の 5 節に結ぶ）。
- orgs-users-and-auth の領域：組織の削除の順（7.1 節）に、DEK の破棄を最後の段として足す。サポートのアクセスの許可の画面（6 節）を Setup に足す。
- infrastructure の領域：log-archive のアカウント、SCP、`admin_cross_org` のロールの扱い（[infrastructure.md](infrastructure.md) に書いた）。

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | KMS の鍵（セル × 用途）、`org_keys` と DEK のライブラリ（AAD、5 分のキャッシュ） |
| E1 | 秘密の型（`Secret<T>`）、ログの型の lint、出力の走査 |
| E1 | 漏えいの経路の登録簿の CI（テストの ID の参照） |
| E1 | 運用者の JIT のロール（IAM Identity Center）と break-glass |
| E2 | 組織の削除の順（7.1 節）と鍵の破棄、`org_purge_overdue` |
| E2 | サポートのアクセスの許可（Setup）と、サポートの道具の監査 |
| E11 | 保持の表（7 節）の各消去のジョブの `*_overdue` の計測 |
| E12 | 外部のペンテスト、DAST、GA の前のセキュリティのレビュー |
| E13 | 砂場の脱出のペンテスト |
| MVP の後 | 項目ごとの暗号化（`sensitive` の項目、組織の鍵） |

## 14. 未解決の問い

- 項目ごとの暗号化（本家の Shield に相当）を持つか。持つなら、決定的な暗号での等価の検索と、索引・並べ替え・集計の制約をどう見せるか。
- 組織が鍵を持ち込む方式（BYOK）を、専用のセルで持つか。
- 検索の応答の時間から見えない一致を推し量れる経路（LEAK-012）に対策が要るか。
- 読みの操作（誰がどのレコードを見たか）を監査に残すか（[audit-and-field-history.md](audit-and-field-history.md) の 11 節）。
- Aurora のバックアップの 35 日の間、削除したデータが残ることを、組織への説明（DPA）でどう書くか（法務の L7）。
- 運用者の `support-data` の許可を、組織の管理者が事前に常時で与えられるようにするか。

### 決定

2026-09-28 の既定案。

- 項目ごとの暗号化は MVP の後。要望と規制（金融・医療の組織）を見て、別の ADR で決める。
- BYOK は MVP の後。専用のセルで、セルの鍵を組織の管理の KMS にする形から検討する。
- 応答の時間はそろえない。E12 の外部のペンテストで影響を確かめる（search の領域と同じ）。
- 読みの操作の記録は MVP の後（audit の領域の決定のまま）。
- バックアップの 35 日は DPA に書く。法務の確認を待つ。
- 常時の許可は持たない。許可は最大 7 日とし、組織の管理者が毎回与える。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク上位：アクセスの判定の誤り（LEAK-001〜012）、組織をまたぐ漏えい、Sandbox への個人データの流出。決定表・性質ベーステスト・否定側のテスト・本番の標本の照合の 4 重で見る。
- 漏えいの経路の登録簿の網羅（CI）と、外部のペンテストでの登録簿の外の経路の探索。
- 本番での検証：`access_oracle_mismatch_total{direction="over"}` が 0、出力の走査が 0 件、全ての `*_overdue` が 0。

**runbooks**

- [incident-response.md](../runbooks/incident-response.md)：組織のデータの漏えい、参照の評価器の食い違い、Sandbox のマスキングの事故、騒がしい隣人。
- `org-key-destroy-verify`：組織の削除の後、DEK の破棄とファイルの復号の不能を確かめる。
- `support-break-glass`：break-glass の申請、記録、事後の知らせ。
- `secret-exposure`：秘密の出力の走査で検出した時の入れ替え。
- SLI の追加の依頼（Ops へ）：出力の走査の件数、JIT の申請の数、break-glass の数、全ての `*_overdue`、KMS の `Decrypt` の異常。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `org_keys` | `org_id`、`purpose`（`files`・`audit`・`secrets`）、`key_version`、`wrapped_dek`、`kms_key_arn`、`state`（`active`・`retired`・`destroyed`）、`created_at`、`destroyed_at` | RLS の外（管理のサービスと Worker だけ）。削除で `wrapped_dek` を消す |
| `support_access_grants` | `org_id`、`grant_id`、`granted_by`、`scope`（オブジェクトの一覧）、`expires_at`、`revoked_at` | RLS。組織の管理者が作る |
| `support_sessions` | `org_id`、`session_id`、`operator_id`、`role`（`support-read`・`support-data`・`break_glass`）、`approved_by`、`reason`、`started_at`、`ended_at` | 監査にも写す |
| `leak_path_register` | — | 表でなく、この文書の 4 節（開発リポジトリの CI が読む） |

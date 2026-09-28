# Security: ServiceNow

信頼境界、脅威モデル（部品ごとの STRIDE）、セキュリティのチェックリスト（`SEC-`）、暗号化と鍵、添付ファイル、監査ログ、秘密情報、運用者のアクセス、データの保持と削除（法務の L の論点）、テナントの分離（`tenant_id` が NULL の表の一覧と、テナントをまたぐ DB のロール）、セキュリティの試験、脆弱性の管理、インシデント、法務の論点を決める。

前提の決定は、共有のセルでの RLS のマルチテナント（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）、ACL の既定の拒否とすべての出口での適用（[ADR-0011](../decisions/0011-roles-groups-and-acl-evaluation.md)、[ADR-0012](../decisions/0012-acl-enforcement-at-every-exit.md)）、成り代わりの制限とテナントの SSO（[ADR-0013](../decisions/0013-impersonation-and-tenant-sso.md)）、監査の履歴の追記だけと日次のハッシュの鎖（[ADR-0009](../decisions/0009-record-audit-history-and-journal.md)）、テナントに任意のコードを書かせないこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0051](../decisions/0051-threat-model-and-security-checklist.md) | 脅威は信頼境界と部品ごとの STRIDE で洗い出し、対策を `SEC-NNN` のチェックリストにする。各行は拒否の側のテストを持ち、テストの名前に `SEC-NNN` を含める。ACL・テナントの分離・監査・承認に触れるパスの変更は `security:sensitive` にし、2 人の承認を要る |
| [0052](../decisions/0052-keys-encryption-and-operator-access.md) | 鍵はセルごと・用途ごとの KMS のマルチリージョンの鍵にし、テナントの秘密はテナントごとの DEK で包む。専用のセルは専用のアカウントの鍵を持つ。運用者はテナントのデータへの常設の権限を持たず、テナントの管理者が出す期限付きの「サポートの参照の許可」と、期限付きの権限（最長 4 時間）を通してだけ読む。読んだことはテナントに見える記録に残す。AI エージェントは本番に経路を持たない |
| [0053](../decisions/0053-data-retention-and-deletion.md) | データの保持の期間を種類ごとに既定案として決め、時間で消える表は時間のパーティションで持って `DROP` で消す。テナントの削除は 30 日の猶予の後に、DB・S3・検索の索引・キャッシュ・テナントの鍵を消す。個人の削除の請求は利用者の行の仮名化で受け、監査の履歴との関係は法務の L1・L4 の結論まで保留する。バックアップは 35 日 |
| [0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md) | `tenant_id` が NULL の行は、全テナントに同じで機密でない参照のデータ（組み込みの辞書・ロール・ACL の規則、国民の祝日など）だけに許す。RLS は読み取りだけ NULL の行を通し、書き込みは許さない。NULL の行は本システムの専用のロールだけが書く。テナントをまたいで読む DB のロール（タイマーの取得、outbox の中継、プラットフォームの処理）は、関数を通して識別子だけを返す形に限る |

この文書のチェックリストの行（`SEC-`）と決定表は設計の草案である。ID は E1・E3・E12 の各変更の `spec.md` に移すときに確定する。

## 1. 目標と前提

- **OWASP ASVS 5.0 の Level 2 を全体の目標にする**（[OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/)。最新の版が 5.0.0 であることは 2026-09-28 に確認。章と要件の番号の照合は E1 `sec-checklist-traceability-ci` で行う（未検証））。他の題材（Slack、Stripe）と同じ段にする。
- 最も重い障害は 5 つ。
  1. **テナントをまたいだデータの漏えい**（NFR-009）。
  2. **ACL で読めない値の漏えい**（NFR-010、K6）。出口が 16 あり、1 つの抜けで漏れる（[access-control.md](access-control.md) の 6.2 節）。
  3. **監査の証跡の改ざん・欠け**：変更の承認・権限の変更の履歴は、顧客の J-SOX の証跡になる（[intent.md](../intent.md)）。
  4. **なりすましの承認・なりすましのメールでのチケットの操作**：承認は本人の意思表示で、メールの差出人は偽れる（[ADR-0016](../decisions/0016-approvals.md)、[ADR-0034](../decisions/0034-inbound-email-threading-and-sender-trust.md)）。
  5. **外への送信の踏み台（SSRF）**：Webhook とフローの呼び出しの宛先はテナントが決める（[ADR-0050](../decisions/0050-signed-webhooks-and-tenant-rate-limits.md)）。
- 実行基盤・CI/CD・監視の統制は、他の題材の決定を引き継ぎ（[ADR-0001](../decisions/0001-platform-and-stack.md)）、この題材に固有の部分だけを書く。
- **AI エージェント（コーディング・運用）は、本番に一切の経路を持たない**（[ADR-0052](../decisions/0052-keys-encryption-and-operator-access.md)）。

## 2. 信頼境界

```
  ┌──────────────── インターネット（信頼しない）────────────────────────────────────┐
  │ 社員のブラウザ・スマートフォン   担当者・管理者   連携のシステム   社内のメールサーバー   攻撃者 │
  └────┬───────────────────────────────────┬────────────────────────────┬───────────┘
       │ <tenant>.<brand>.<domain>          │ /api/v1                     │ SMTP（転送）
  ═════╪══ B1：エッジ（CloudFront＋WAF、ルーターの関数）═══════════╪══════ B5：SES の受信 ══
       │ ホスト名 → テナント → セル（テナントのデータを読まない）       │ 封筒の受け手 → テナント → セル
  ┌────▼──────────── セル（共有・専用）─────────────────────────────────▼────────────┐
  │ App（画面・API）  Engine  Ingest  Notifier  Indexer                                  │
  │  ══ B2：テナントのコンテキスト（SET LOCAL app.tenant_id、FORCE RLS）═══════════      │
  │  ══ B3：ACL（Record Service の decide と述語。テナントの中の利用者ごと）════════    │
  │  Aurora  Valkey  OpenSearch  S3  SQS                                                │
  │  Notifier ── B4：外向きの送信（egress の NAT）──▶ Webhook・フローの宛先、Web Push、SES │
  └────────────────────────────────────────────────────────────────────────────────┘
  ═══ B6：管理の面 ═══ 制御の面（テナントの台帳）、CI/CD（OIDC）、運用者（SSO＋MFA、期限付き）、log-archive
  ─ ─ ─ B7：開発の環境（AI コーディングエージェント）… 本番への経路なし ─ ─ ─
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | すべての HTTP の要求 | TLS 1.2 以上、HSTS、WAF、ルーター（ホスト名 → セル。[infrastructure.md](infrastructure.md) の 3 節）。オリジンは CloudFront からの要求だけを受ける |
| B2 テナント | サービスから DB・索引・S3・キャッシュ | ホスト名・封筒の受け手・トークンからテナントを決めてから読む。`SET LOCAL`、FORCE RLS。索引の必須の `tenant_id`。S3・Valkey のテナントの接頭辞（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)、[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)） |
| B3 ACL | テナントの中の利用者からレコード | 1 つの `decide` と述語のコンパイラ、既定の拒否、16 の出口（[access-control.md](access-control.md)） |
| B4 外向き | Webhook、フローの呼び出し、Web Push、メール | 許可の一覧、名前解決の後の IP の検査、署名、薄い事象（[api-and-integrations.md](api-and-integrations.md) の 6 節） |
| B5 メールの受信 | 社外からのメール | SES の認証の結果、差出人の信頼の段階、ループの防止（[notifications-and-email-ingest.md](notifications-and-email-ingest.md)） |
| B6 管理の面 | デプロイ、鍵、運用者の操作、テナントの作成・移動 | OIDC の短命な認証情報、期限付きの権限、2 人の承認、プラットフォームの監査（8 節） |
| B7 開発の環境 | コード（PR としてのみ） | 本番の資格情報を置かない。テストに本物の個人情報を使わない（[AGENTS.md](../../AGENTS.md)） |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主要な脅威と対策だけを書く。`SEC-` は 4 節の行を指す。

### 3.1 エッジとルーター

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | オリジン（セルの ALB）を直接叩き、WAF とルーターを迂回する | ALB のセキュリティグループを CloudFront のマネージドプレフィックスリストに限り、秘密のヘッダーを検査する（SEC-001） |
| T | `Host`・`X-Forwarded-Host` を偽り、別のテナントとして解決させる | セルの App は、CloudFront が付けた元のホスト名だけを信じ、テナントを自分でも解決し直し、そのセルのテナントでなければ 421 にする（SEC-002） |
| I | 未知のホスト名の要求がどこかのセルに届く | ルーターは解決できないホスト名を 404 にし、どのセルにも送らない（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)） |
| D | L7 の大量の要求 | WAF の IP ごとのレート制限、テナントのレート制限（[api-and-integrations.md](api-and-integrations.md) の 7 節） |

### 3.2 App（画面・API）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | セッションの乗っ取り、CSRF | Cookie はテナントのホスト名だけ、`HttpOnly`・`Secure`・`SameSite=Lax`、状態を変える要求に CSRF のトークン（SEC-010） |
| S | API のトークンの漏えい | 不透明なトークン（1 時間）とハッシュでの保存、接頭辞でのシークレットスキャン（SEC-011） |
| T | XSS（テナントのラベル、ナレッジの本文、ポータルの文章） | テナントの HTML を描かない。制限付きの Markdown だけをサニタイズして描く。CSP（SEC-012） |
| I | ACL の出口の抜け（リスト、件数、並べ替え、参照の表示、関連リスト、API、エクスポート） | 1 つの `decide` と述語、`visible(f)`、出口ごとの漏れの試験（SEC-020〜023） |
| I | 他のテナントの ID の推測（参照の検証の応答の違い） | 別のテナントの ID と存在しない ID を同じ応答にする（SEC-024） |
| E | 成り代わりでの権限の拡大、承認 | DT-IMP-001 と、成り代わりの間の承認・権限の変更・エクスポートの禁止（SEC-030） |
| E | `tenant_admin` が ACL を変えて自分に権限を与える | `acl_admin` を別のロールにし、昇格（MFA の再認証）を要る。変更を他の `acl_admin` と `auditor` に知らせる（SEC-031） |
| D | 重い一覧・レポート・エクスポートで DB を占有する | 索引のない絞り込みの制限、件数の上限、レポートの上限、重い要求の同時の実行の上限（SEC-040） |

### 3.3 Record Service・Engine（フロー・承認・タイマー）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| T | 承認の二重の反映、承認なしの実施 | 承認のまとまりのロックと版の条件、`implement` への遷移の条件、日次の突き合わせ（SEC-050） |
| R | 承認者が承認を否認する | 承認の行（誰に依頼し、誰が、誰の代理で答えたか）と監査の履歴、ハッシュの鎖（SEC-051） |
| T | 監査の履歴の書き換え・削除 | アプリのロールに `UPDATE`・`DELETE` を与えない。日次のハッシュの鎖を S3 Object Lock に置く（SEC-052） |
| E | フローの `system_declared` で ACL を迂回する | `tenant_admin` と `acl_admin` の両方の承認、書き込むテーブルの宣言（[workflow-engine.md](workflow-engine.md) の 5.4 節）（SEC-053） |
| D | テナントのフローの暴走 | 上限とテナントの取り分（[ADR-0018](../decisions/0018-flow-limits-and-tenant-fairness.md)） |
| E | 式の言語の評価器からの任意のコードの実行 | 評価器は純粋な関数で、組み込みの関数の一覧を CI で検査する（[ADR-0001](../decisions/0001-platform-and-stack.md)）。式の大きさ・深さ・時間の上限（SEC-054） |

### 3.4 Ingest（メール・CMDB・取り込み）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 社内の人を名乗るメールで、チケットを作る・コメントを足す・再オープンする | 差出人の信頼の段階（DT-MAIL-003）、返信の追記は差出人の主体の ACL（SEC-060） |
| S | メールの返信で承認する・当番を受け付ける | メールの返信では受けない。ログインの後の画面だけ（SEC-061） |
| T | 件名の番号の偽りで、他人のチケットに追記する | 件名の番号は差出人が関係者のときだけ使う。推測できない参照の印（SEC-062） |
| D | 自動の応答のループ、メールの洪水 | ヘッダーでの見分けと流量の上限（DT-MAIL-004、[notifications-and-email-ingest.md](notifications-and-email-ingest.md) の 6 節）（SEC-063） |
| I | 添付ファイルのマルウェアが担当者の端末に届く | 添付ファイルのマルウェアの検査（5.3 節）。検査の済まないファイルは渡さない（SEC-064） |
| T | 取り込みで、弱い取り込み元が強い取り込み元の CI の値を上書きする | 取り込み元の優先度と鮮度の規則（[ADR-0038](../decisions/0038-attribute-reconciliation-per-source-state.md)） |
| T | 取り込みの CSV の式の注入（エクスポートで開いた人の表計算ソフトで式が動く） | エクスポートの時にセルの先頭をエスケープする（[reports.md](reports.md) の 11 節）（SEC-065） |

### 3.5 Notifier（メール・プッシュ・Webhook）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 通知の本文に、受け手の読めない値が入る | 受け手ごとに受け手の主体で判定して差し込む（[ADR-0033](../decisions/0033-notification-rules-and-outbound-email.md)）（SEC-070） |
| I | Webhook の本文の値が受け手のシステムで広がる | 値を入れない薄い事象（SEC-071） |
| S | 第三者が偽の Webhook を受け手に送る | HMAC-SHA256 の署名と時刻（SEC-072） |
| E | SSRF（内部のアドレス、メタデータのアドレス） | 許可の一覧、名前解決の後の IP の検査、リダイレクトを追わない、egress の分離（SEC-073） |
| I | プッシュの本文がブラウザの提供者を経る | プッシュの本文にレコードの値を入れない（SEC-074） |

### 3.6 Indexer・OpenSearch・レポート

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 検索の総数・強調・一致から、読めない値を推測する | 総数を出さない、読めるフィールドだけに一致、DB での確かめ直し（[ADR-0044](../decisions/0044-acl-aware-search-and-index-freshness.md)）（SEC-080） |
| I | 索引の遅れで、削除・権限の変更の後も結果に出る | DB での確かめ直し（SEC-081） |
| I | 集計の「（読めない値）」の件数から推測する | 読めない値を空の値と区別しない（[ADR-0046](../decisions/0046-acl-aware-aggregation-and-per-recipient-delivery.md)）（SEC-082） |
| I | 検索の問い合わせの `tenant_id` の付け忘れ | 問い合わせを組み立てる 1 つの関数で必須にし、DB での確かめ直しで二重に守る（SEC-083） |

### 3.7 データの置き場所

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | RLS のコンテキストの設定漏れ、NULL の行の悪用 | FORCE RLS、NULL の行は読み取りだけ、マイグレーションの CI の許可の一覧（[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)）（SEC-090） |
| I | DB・バックアップ・スナップショット・S3 の漏えい | KMS の保存の暗号化。テナントの秘密は DEK のエンベロープ暗号化（5 節）（SEC-091） |
| T | Valkey の値の改ざん（レート制限・キャッシュ） | VPC の中だけ、TLS と AUTH。失われてよい値だけを置き、判定の正本にしない（SEC-092） |
| I | テナントをまたぐ DB のロールの誤用 | 識別子だけを返す関数に限る（[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)）（SEC-093） |

### 3.8 CI/CD と AI エージェント

他の題材の security.md（Slack・Auth0）と同じ。加えて次のとおり。

- `security:sensitive` のパス（ACL の判定と述語のコンパイラ、Record Service の保存の流れ、RLS とマイグレーション、監査の履歴、承認、成り代わり、SSO、メールの差出人の信頼、Webhook の送信、KMS・IAM・WAF の Terraform）の変更は、作成者と別の 2 人の人（Dev のテックリードとセキュリティの担当）の承認を要る（[delivery.md](delivery.md) の 3 節）。
- テスト・フィクスチャー・シードに本物の個人情報がないことを CI で検査する（[AGENTS.md](../../AGENTS.md)）。

## 4. セキュリティのチェックリスト（[ADR-0051](../decisions/0051-threat-model-and-security-checklist.md)）

各行の拒否の側のテストは、名前に `SEC-NNN` を含める。「決める領域」の文書が振る舞いの詳細と要件 ID（`REQ-*`）を持つ。

| ID | 対策 | 決める領域 | 拒否の側のテストの例 |
| --- | --- | --- | --- |
| SEC-001 | オリジンは CloudFront からだけ受ける | infrastructure | ALB への直接の要求が拒否される |
| SEC-002 | セルの App がテナントを解決し直し、別のセルのテナントを 421 | infrastructure | 偽の `Host`・`X-Forwarded-Host` |
| SEC-010 | Cookie の属性、CSRF のトークン | portal-and-ui、access-control | トークンのない `POST`、別のホスト名の Cookie |
| SEC-011 | API のトークンのハッシュでの保存、接頭辞、1 時間 | api-and-integrations | 期限切れ、別のテナントのトークン |
| SEC-012 | テナントの HTML を描かない、CSP | portal-and-ui、knowledge | 既知の XSS の文字列の一覧をラベル・本文・部品に入れる |
| SEC-020 | 行の既定の拒否 | access-control | 規則のないテナントのテーブルが読めない |
| SEC-021 | 16 の出口の漏れの試験 | access-control | 「漏れの印」が応答・メール・CSV・Webhook・検索・ログに出ない |
| SEC-022 | 並べ替え・絞り込み・集計の推測 | access-control、reports | 読めない値の大小で並べた結果と NULL で並べた結果が同じ |
| SEC-023 | 画面のモデル・API は単体の取得より広くない | portal-and-ui、api-and-integrations | PROP-UI-002、PROP-API-002 |
| SEC-024 | 参照の検証で別のテナントと存在しない ID を同じ応答 | data-dictionary-and-tables | 別のテナントの ID の参照 |
| SEC-030 | 成り代わりは権限を広げず、承認・権限の変更・エクスポートをさせない | access-control | 成り代わりの間の承認の回答 |
| SEC-031 | ACL の変更は `acl_admin` と昇格 | access-control | 昇格のない ACL の変更、`tenant_admin` の ACL の変更 |
| SEC-040 | 重い要求の上限 | portal-and-ui、reports、api-and-integrations | 索引のない絞り込み、上限を超えるエクスポート |
| SEC-050 | 承認は 1 回だけ、承認なしに実施しない | workflow-engine、itsm-processes | 並行の 2 つの回答、承認のない `implement` |
| SEC-051 | 承認の証跡 | workflow-engine | 承認の行の `UPDATE` の権限がない |
| SEC-052 | 監査の履歴は追記だけ、ハッシュの鎖 | data-dictionary-and-tables | アプリのロールの `UPDATE`・`DELETE`、鎖の食い違いの検出 |
| SEC-053 | `system_declared` のフローの 2 人の承認 | workflow-engine | 1 人の承認での有効化 |
| SEC-054 | 式の評価器の上限と副作用のなさ | workflow-engine | 深い入れ子の式、長い文字列の式 |
| SEC-060 | 差出人の信頼の段階 | notifications-and-email-ingest | SPF・DKIM の通らない社内のドメインのメール |
| SEC-061 | メールの返信で承認・受け付けをしない | workflow-engine、assignment-and-on-call | 「承認」の返信 |
| SEC-062 | 件名の番号の紐付けは関係者だけ | notifications-and-email-ingest | 無関係の差出人の件名の番号 |
| SEC-063 | メールのループの防止 | notifications-and-email-ingest | 不在の返信の往復（PROP-MAIL-002） |
| SEC-064 | 添付ファイルのマルウェアの検査の前に渡さない | security（5.3 節） | 検査の済まない添付の署名付き URL の要求 |
| SEC-065 | CSV の式の注入の対策 | reports | `=` で始まる値のエクスポート |
| SEC-070 | 通知の本文は受け手ごとの判定 | notifications-and-email-ingest | 読めない差し込みの値（PROP-NTF-002） |
| SEC-071 | Webhook は薄い事象 | api-and-integrations | 本文に値がない（PROP-WH-002） |
| SEC-072 | Webhook の署名 | api-and-integrations | 改ざんした本文、古い時刻（PROP-WH-001） |
| SEC-073 | SSRF の対策 | api-and-integrations、workflow-engine | プライベートの IP・メタデータのアドレスへの解決、リダイレクト |
| SEC-074 | プッシュの本文に値を入れない | portal-and-ui | プッシュの本文の検査 |
| SEC-080 | 検索の推測の対策 | search | 読めないフィールドだけの一致、総数（PROP-SRCH-003） |
| SEC-081 | 検索の DB での確かめ直し | search | 削除・権限の変更の直後の検索 |
| SEC-082 | 集計で読めない値を区別しない | reports | PROP-RPT-001 |
| SEC-083 | 検索の必須の `tenant_id` | search | PROP-SRCH-005 |
| SEC-090 | FORCE RLS と NULL の行の読み取りだけ | security（10 節） | NULL の行の `INSERT`・`UPDATE`、別のテナントの行 |
| SEC-091 | 保存の暗号化と DEK | security（5 節） | DEK の暗号文を別のテナントの行に差し込むと復号できない（AAD） |
| SEC-092 | Valkey を判定の正本にしない | access-control | Valkey を消しても判定が同じ |
| SEC-093 | テナントをまたぐロールは識別子だけ | security（10 節） | `engine_scheduler` でテナントの表の本文を読めない |
| SEC-094 | SAML・OIDC の攻撃の対策 | access-control | 署名の包み替え、アサーションの再送、`Audience` の違い、外部実体（[ADR-0013](../decisions/0013-impersonation-and-tenant-sso.md)） |
| SEC-095 | 運用者のテナントのデータの参照は許可と期限付きの権限を要る | security（8 節） | 許可のない参照の拒否と、参照の記録 |

- 表のすべての行がテストから参照されていることを CI で確かめる（[delivery.md](delivery.md) の 2 節）。

## 5. 暗号化と鍵（[ADR-0052](../decisions/0052-keys-encryption-and-operator-access.md)）

### 5.1 転送中

| 区間 | 方式 |
| --- | --- |
| 利用者 → CloudFront | TLS 1.2 以上、HSTS（`<brand>.<domain>` の下で `includeSubDomains`） |
| CloudFront → セルの ALB | TLS。オリジンの証明書は ACM |
| ALB → タスク | TLS（Private CA の証明書） |
| タスク → Aurora・Valkey・OpenSearch | TLS。Aurora は `rds.force_ssl`、Valkey は転送中の暗号化と AUTH、OpenSearch は HTTPS だけ |
| Notifier → 外部（Webhook） | TLS。証明書の検証を外さない。`https:` だけ |
| SES の受信・送信 | SES の TLS（送信は `TlsPolicy: Require` を既定。受け手が TLS を持たないときの扱いは E6 で決める） |

### 5.2 保存時の鍵

KMS の鍵は、セルごと・用途ごとに持ち、どれもマルチリージョン（主は東京、レプリカは大阪）にする。

| KMS の鍵 | 守るもの | 使える主体 |
| --- | --- | --- |
| `<brand>-<cell>-data` | Aurora、S3（添付・メールの原本・エクスポート・取り込みの原本）、SQS、OpenSearch、バックアップ | 各 AWS のサービス（`kms:ViaService`） |
| `<brand>-<cell>-tenant-secrets` | テナントごとの DEK → テナントの秘密（Webhook の署名の秘密、フローの資格情報 `tenant_secret`、OIDC の IdP のクライアントの秘密） | App・Engine・Notifier のタスクのロール |
| `<brand>-<cell>-signing` | 設定のパッケージの署名（[ADR-0010](../decisions/0010-metadata-versions-and-config-packages.md)）、一覧の `cursor` と署名付きの内部の URL の HMAC の鍵の包み | App・Engine |
| `<brand>-audit`（log-archive のアカウント） | 監査の日次のハッシュの鎖、プラットフォームの監査、CloudTrail | log-archive のサービスだけ（本番のアカウントの主体は消せない・読めない） |

- **テナントの秘密は、テナントごとの DEK で包む**（エンベロープ暗号化。AES-256-GCM、AAD に `tenant_id` と秘密の ID を入れる）。DEK は `tenant-secrets` の鍵で暗号化して DB に持つ。暗号文を別のテナントの行に差し込んでも復号できない。
- テナントの削除では、そのテナントの DEK を消す（暗号文の秘密を読めなくする。9 節）。
- **専用のセル**は、専用の AWS アカウントの鍵を持つ（他の顧客と共有しない。NFR-009、[ADR-0056](../decisions/0056-dedicated-cells-and-tenant-moves.md)）。顧客の管理する鍵（顧客の AWS アカウントの KMS の鍵を使う形）は持ち越し（S2 の前に、専用のセルの契約の条件と一緒に決める）。
- 鍵の削除の予約・無効化は、SCP で break-glass のロール以外に禁止する（[infrastructure.md](infrastructure.md) の 1 節）。

### 5.3 添付ファイル

- 添付ファイル（レコードの添付、カタログの添付の変数、メールの添付、ナレッジの画像）は、S3 のセルのバケットに、テナントの接頭辞の下に置く（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- **マルウェアの検査を通るまで渡さない。** GuardDuty の S3 のマルウェアの保護で、新しいオブジェクトを検査し、結果をオブジェクトのタグ（`GuardDutyMalwareScanStatus`）に付ける（[Monitoring S3 object scans with GuardDuty managed tags](https://docs.aws.amazon.com/guardduty/latest/ug/monitor-enable-s3-object-tagging-malware-protection.html)、2026-09-28 に確認）。署名付き URL は、タグが `NO_THREATS_FOUND` のオブジェクトにだけ出す。`THREATS_FOUND` は隔離の接頭辞へ移し、添付の行に印を付け、アップロードした人とテナントの管理者に知らせる。`UNSUPPORTED`（暗号化された zip など）は、担当者だけが警告を見た上で取り出せる。
- カタログの添付の変数は、検査が済むまで実行のフローに渡さない（[service-catalog-and-requests.md](service-catalog-and-requests.md) の 9 節）。
- 1 ファイル 50 MB（メールの添付は 25 MB。[ADR-0034](../decisions/0034-inbound-email-threading-and-sender-trust.md)）。画像以外の添付は `Content-Disposition: attachment` で渡し、ブラウザの中で開かせない。
- 添付の行は親のレコードの `read` に従い、署名付き URL は 5 分（DT-ACL-003 の 15 行）。

## 6. 監査ログ

| 系統 | 記録するもの | 置き場所 |
| --- | --- | --- |
| レコードの監査の履歴（`record_change`、`journal_entry`） | テナントのレコードの変更、作業メモ・コメント | Aurora（追記だけ、月ごとのパーティション）。日次のハッシュの鎖を S3 Object Lock（[ADR-0009](../decisions/0009-record-audit-history-and-journal.md)） |
| メタデータの変更（`meta_change`） | 辞書・ACL・フロー・SLA・配置などの変更 | Aurora。監査の履歴と同じ保持 |
| テナントの監査ログ（`tenant_audit_event`） | ログイン、SSO の失敗、`break_glass`、成り代わり、ロールの付け外し、API のクライアントと秘密の発行・失効、エクスポート、パッケージの適用、サポートの参照の許可 | Aurora → log-archive |
| プラットフォームの監査（`platform_audit_event`） | 運用者の本番へのアクセス、サポートの参照、テナントの作成・停止・移動・削除、国民の祝日の版の承認、保持の期間を過ぎたパーティションの削除、リーガルホールド | log-archive（Object Lock、compliance モード） |
| AWS の操作 | CloudTrail（組織の証跡。KMS の操作を含む） | log-archive |

- テナントの管理者と `auditor` は、自分のテナントのテナントの監査ログと、自分のテナントに関わるプラットフォームの監査（サポートの参照）を見られる。
- 保持は 9 節。

## 7. 秘密情報の管理

| 秘密情報 | 保存 | ローテーション |
| --- | --- | --- |
| 利用者のパスワード（`break_glass` と SSO なしのテナント） | Argon2id（Slack・Auth0 の題材と同じ形。パラメーターは E3 で決める） | 利用者の操作 |
| API のクライアントシークレット、アクセストークン、リフレッシュトークン | SHA-256 だけ（[api-and-integrations.md](api-and-integrations.md) の 3.1 節） | クライアントの操作、失効 |
| Webhook の署名の秘密、フローの資格情報、OIDC の IdP の秘密 | テナントの DEK のエンベロープ暗号化（5.2 節） | テナントの操作。Webhook は 2 つを並べる期間 |
| メールの参照の印 | 乱数（秘密ではないが推測できない。[ADR-0033](../decisions/0033-notification-rules-and-outbound-email.md)） | — |
| DB の認証情報、内部の HMAC の鍵、外部の提供者の鍵 | Secrets Manager | 自動のローテーション。HMAC の鍵は新旧を並べる期間 |
| CloudFront → ALB の秘密のヘッダー | Secrets Manager | 90 日 |

- トークン・秘密の接頭辞（`<brand>_at_`、`<brand>_cs_`、`<brand>_whsec_`）を GitHub のシークレットスキャンのパートナーに登録する（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。通知を受けたら失効させる。

## 8. 運用者のアクセス（[ADR-0052](../decisions/0052-keys-encryption-and-operator-access.md)）

- **常設の権限は、ダッシュボード・メトリクス・秘密と個人データを含まないログだけ。** DB・シェル・KMS の管理・S3 のテナントの接頭辞の読み取りは、期限付き（最長 4 時間）で、チケットの ID と理由を要る。
- **テナントのデータの参照は、テナントの管理者が出す「サポートの参照の許可」を要る。** 許可は、対象（テーブルの一覧、または全体）、期限（最長 72 時間）、読み取りだけ、を持つ。運用者は、許可の範囲の中で、本システムの運用の画面（Record Service の上の読み取り専用の主体 `support:<operator_id>`、ACL は許可の範囲の読み取りだけ）から読む。DB を直接読まない。
- 参照したレコードの ID と時刻を、プラットフォームの監査に残し、テナントの管理者が見られる。
- **インシデントの対応の例外**：許可を待てない調査（テナントの分離の破れの疑いなど）は、Ops の責任者とセキュリティの担当の 2 人の承認で期限付きの権限を得る。24 時間以内にテナントへ知らせる（契約の書き方は法務の L5）。
- 運用者がテナントの利用者に成り代わる機能を作らない（テナントの中の成り代わり（[ADR-0013](../decisions/0013-impersonation-and-tenant-sso.md)）は、テナントの利用者のための機能で、運用者は使わない）。
- **AI エージェントは本番に経路を持たない**（コーディング・運用のどちらも）。本番のテレメトリーも読まない。調査は、人が取り出した秘密と個人データを含まない材料で行う。
- 四半期ごとにアクセスをレビューする。

## 9. データの保持と削除（[ADR-0053](../decisions/0053-data-retention-and-deletion.md)）

**期間はすべて既定案で、法務の確認（L1・L2・L4・L5）で確定する。** 表の「期限後」は、時間のパーティションの `DROP` か、日次の削除のジョブで行う。

| データ | 保持（既定案） | 期限後 | 関わる法務の論点 |
| --- | --- | --- | --- |
| テナントのレコード（`task`、`ci`、ナレッジ、カタログの要求） | テナントが消すまで | 削除（監査の履歴に削除の前の値が残る） | L1 |
| 監査の履歴（`record_change`、`journal_entry`）、`meta_change`、承認の行、`sla_clock_event` | 7 年（延長は 10 年まで、短縮はできない） | パーティションを外して消す（保守のロール、プラットフォームの監査） | L4 |
| テナントの監査ログ | DB に 1 年、log-archive に 7 年 | 削除 | L4 |
| プラットフォームの監査、CloudTrail | log-archive に 7 年 | 削除 | L5 |
| フローの実行（`flow_run`・`flow_step`） | 90 日（承認の行は監査と同じ） | 削除 | — |
| 通知（`notification_message`） | 30 日 | 削除 | — |
| 送ったメールの記録（`email_outbound`） | 90 日 | 削除 | L2 |
| 受けたメール（`inbound_email`）と原本（S3） | 1 年 | 削除 | L2・L4 |
| 参照の印（`email_watermark`） | 1 年 | 削除 | — |
| ポータルの事象（`portal_event`） | 90 日（仮名のセッション） | パーティションを `DROP` | L1 |
| 取り込みの原本（`import_row`、S3 のファイル） | 30 日 | 削除 | L1 |
| CMDB の取り込みの結果（`ingest_batch`・`ingest_item`） | 30 日 | 削除 | — |
| CMDB の統合の前の状態（`ci_merge_log`） | 監査の履歴と同じ（7 年） | パーティションを外して消す | L4 |
| 当番の呼び出し（`page`・`page_attempt`） | 監査の履歴と同じ（7 年） | 同上 | L4 |
| 成り代わり（`impersonation_session`）、サポートの参照の許可（`support_access_grant`）、テナントの削除の記録（`tenant_deletion_run`） | 監査の履歴と同じ（7 年） | 削除 | L4・L5 |
| 変更のリスクの評価・CAB・影響の写し（`change_risk_assessment`、`cab_*`、`change_impact_snapshot`）、ナレッジの版 | 監査の履歴と同じ（7 年）。変更・記事が残る間は残す | 削除 | L4 |
| リーガルホールド（`legal_hold`） | 解除の後 7 年 | 削除 | L4・L5 |
| API のクライアントのシークレット・トークン（ハッシュ）（`api_client_secret`、`oauth_token`、`oauth_refresh_family`） | 失効・期限切れの後 30 日 | 削除 | — |
| フローの外への呼び出しの結果（`webhook_result`） | 90 日（フローの実行と同じ） | 削除 | — |
| 抑えたトリガーの記録（`flow_trigger_suppressed`） | 30 日 | 削除 | — |
| 正しさの監視・索引の突き合わせの結果（`correctness_check_run`、`search_reconcile_run`） | 90 日 | 削除 | — |
| レポートの実行の記録（`report_run`）、エクスポートの記録（`export_job`） | 30 日（ファイルは 24 時間） | 削除 | — |
| Webhook の配達（`webhook_delivery`） | 7 日 | 削除 | — |
| 冪等のキー（`idempotency_key`） | 24 時間 | 削除 | — |
| 日次の事実の表（`task_daily_fact`） | 13 か月 | パーティションを `DROP` | — |
| エクスポートのファイル（S3） | 24 時間 | S3 のライフサイクル | — |
| 検索の索引 | DB の写し。DB の削除に従う | 事象で削除、日次の突き合わせ | — |
| アプリのログ | CloudWatch Logs 30 日、log-archive 13 か月（秘密と個人データを含めない） | 自動 | — |
| バックアップ（Aurora の PITR と AWS Backup） | 35 日 | 期限で消える（削除の最終の期限） | L5 |

### 9.1 テナントの削除

```
解約・削除の操作（テナントの管理者と本システムの確認）
  → 状態 suspended：ログインと受信を止める。データはそのまま。30 日の間は戻せる
  → 30 日後：削除のジョブ（platform のロール。プラットフォームの監査）
      1. ルーターと受信の対応表から外す
      2. Aurora：tenant_id の行を、表ごとに消す（大きな表は 1 万行ずつ）
      3. S3：テナントの接頭辞を消す（Object Lock の監査の鎖は保持の期間まで残る）
      4. OpenSearch：routing = tenant_id で delete_by_query
      5. Valkey：テナントの接頭辞のキーを消す
      6. テナントの DEK を消す（秘密の暗号文を読めなくする）
      7. 完了の証明（件数）をプラットフォームの監査に残す
  → バックアップからは 35 日で消える（契約の文書に書く）
```

- 監査の履歴は、テナントの削除でも保持の期間まで残すかは法務の確認待ち（L4・L5。顧客の J-SOX の証跡を顧客が持ち出した後に消してよいか）。既定案は「削除の前に、監査の履歴のエクスポートを顧客に渡し、削除のジョブで消す」。

### 9.2 個人の削除の請求

- 既定案：**利用者の行を仮名化する**（氏名・メール・電話・場所などを「削除された利用者 #n」と空にし、`active = false`）。レコードの参照（担当者・依頼者）は残す。
- 監査の履歴・作業メモの本文の中の個人の情報（「山田さんの PC」のような自由記述）は、追記だけの表なので消せない。これを消すかは、監査の証跡の保持（J-SOX）との関係で法務の確認（L1・L4）の後に決める。それまで E2 の監査の `spec.md` と E3 の利用者の取り込みの `spec.md` は承認しない（[intent.md](../intent.md) の法務の確認待ち）。
- 設計の余地：個人の情報を含みうる自由記述を、利用者ごとの DEK で暗号化して持ち、削除の請求で DEK を消す形（暗号の消去）は、検索・通知・監査の突き合わせの設計に大きく影響するので、L1・L4 の結論で要るとなったら別の ADR で決める。

### 9.3 リーガルホールド

- テナント・レコード・利用者の単位でリーガルホールドを掛けられる（本システムの運用者が、テナントの依頼か法的な求めで）。ホールドは保持の期限と削除のジョブに優先する。掛け外しはプラットフォームの監査に残す。

## 10. テナントの分離（[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md)）

### 10.1 規則

- すべてのテナントテーブルは `tenant_id` を持ち、主キーと索引の先頭に置き、`FORCE ROW LEVEL SECURITY` を掛ける（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- 外部キーは `tenant_id` を含む複合キーにする。例外は 10.2 節の NULL の行への参照だけ。
- 索引（OpenSearch）は必須の `tenant_id` の絞り込み、S3 と Valkey はテナントの接頭辞。
- SQS のメッセージは `tenant_id` を持ち、処理する側は処理の始めに `SET LOCAL app.tenant_id` を設定する。メッセージの `tenant_id` と、読んだ行の `tenant_id` が違えば処理を止めて SEV2。

### 10.2 `tenant_id` が NULL の行を持つ表

**ここにない表は、NULL の `tenant_id` を持たない**（`tenant_id` は NOT NULL）。マイグレーションの CI の許可の一覧は、この表と一致させる。追加するときは、この表と [data-model.md](data-model.md) の 3 節を合わせて更新し、Dev のテックリードとセキュリティの担当の承認を得る（`security:sensitive`）。

| 表 | NULL の行の中身 | 誰が書くか | 許す理由 | 定義の場所 |
| --- | --- | --- | --- | --- |
| `dict_table`、`dict_field` | 組み込みのクラスとフィールド（`task`、`incident`、`ci` と CI のクラスなど） | 起動の時の読み込み（`catalog_loader` のロール。コードの版の定義から） | 全テナントで同じで、コードと一緒にリリースする（[ADR-0006](../decisions/0006-data-dictionary-and-field-types.md)）。機密でない。テナントの行（`c_` のフィールド、上書き）の参照の先として DB に要る | [data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.2 節 |
| `dict_choice_set`、`dict_choice` | 組み込みの選択肢（状態、影響度、緊急度など） | 同上 | 同上 | 同上 |
| `role` | 組み込みのロール（`requester`、`agent`、`acl_admin` など） | 同上 | 同上。`group_role`・`user_role` がテナントの行から参照する | [access-control.md](access-control.md) の 3.3 節 |
| `acl_rule` | 組み込みの ACL の規則（組み込みの `deny_unless` を含む） | 同上 | 同上。テナントは無効にする行（`deny_unless` 以外）と追加の規則を自分の行で持つ。組み込みの行は変えられない | [access-control.md](access-control.md) の 4.1 節 |
| `holiday_set`、`holiday_set_version`、`holiday` | 国民の祝日（内閣府の CSV から取り込んだ版） | 祝日の取り込みのジョブ（`catalog_loader`）と、運用者 2 人の承認の後の公開 | 全テナントで同じ公の暦で、機密でない。テナントのカレンダーの版が参照する（[ADR-0020](../decisions/0020-japanese-holiday-data.md)） | [sla-and-calendars.md](sla-and-calendars.md) の 5 節 |
| `number_def` | 組み込みの番号の定義（`INC`、`CHG` など） | 同上 | 組み込みの辞書の `number_def_id` とテナントの `number_counter` が参照する。テナントの接頭辞の変更は、同じテーブルのテナントの行で上書きする | [data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 8 節 |
| `ci_relation_type` | 組み込みの関係の型（`depends_on` など） | 同上 | テナントの `ci_relation` が参照する | [cmdb-and-reconciliation.md](cmdb-and-reconciliation.md) の 7.1 節 |
| `ci_attribute`、`ci_identification_rule` | 組み込みの CI の属性（`multi` の印を含む）と識別の規則 | 同上 | テナントの `ci_precedence`・`ci_identifier` が参照する。テナントの同じクラスの規則は、組み込みの行に勝つ | 同上の 3.2・4.1 節 |
| `flow_def`、`flow_version` | 組み込みのフロー（`change_approval_policy`、`incident_auto_close`、`kb_publish_approval`、`major_incident_response`、カタログの雛形） | 同上。コードの新しい版は新しい `flow_version` の行にし、前の版を変えない | テナントの `flow_run` が版を参照する（実行は開始の時の版に固定） | [workflow-engine.md](workflow-engine.md) の 3.4 節 |

- 統合で候補を決めた（2026-09-28。[ADR-0054](../decisions/0054-shared-reference-rows-and-cross-tenant-roles.md) の注記）。規則は「テナントの行が外部キーで参照する、またはテナントの行と同じ一意の空間で照合する組み込みのデータだけを NULL の行にする」。`priority_matrix`・配置・画面の規則・状態のモデル・通知の規則とテンプレート・組み込みのレポートはコードの版だけに持ち、テナントは自分の行で上書き・無効・複製をする。既定のカレンダー・組み込みの SLA の定義などは、テナントの作成の時にテナントの行として作る。全体の一覧は [data-model.md](data-model.md) の 3.1 節。

### 10.3 RLS のポリシー

```sql
-- 10.2 節の表だけ
CREATE POLICY shared_read ON dict_field FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id')::uuid OR tenant_id IS NULL);
CREATE POLICY tenant_write ON dict_field FOR INSERT, UPDATE, DELETE     -- 実際は操作ごとに 1 つずつ
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
-- そのほかのすべてのテナントテーブル
CREATE POLICY tenant_only ON task
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

- **アプリのロールは NULL の行を書けない**（`WITH CHECK` で NULL を拒む）。NULL の行を書くのは `catalog_loader` のロールだけで、このロールは NULL の行の表の `INSERT`・`UPDATE` だけを持ち、テナントの行を読めない（`tenant_id IS NULL` の行だけのポリシー）。
- NULL の行はテナントの行を参照しない（NULL の行の外部キーは NULL の行だけを指す）。CI で確かめる。
- テナントが組み込みの定義を変えるときは、自分の行（上書き、無効の印）を足す。NULL の行を書き換えない。

### 10.4 テナントをまたぐ DB のロール

| ロール | 使う処理 | できること | できないこと |
| --- | --- | --- | --- |
| `engine_scheduler` | タイマーの取得（[workflow-engine.md](workflow-engine.md) の 8.3 節） | `SECURITY DEFINER` の関数 `claim_due_timers(shards, limit)` で、`(timer_id, tenant_id)` の組だけを受け取る | テナントの表の本文を読む。受け取った後は、アプリのロールで `SET LOCAL app.tenant_id` をして 1 件ずつ処理する |
| `relay` | outbox の中継 | outbox の行の読み取りと送信済みの印（`tenant_id` と本文は SQS へそのまま） | outbox 以外の表 |
| `indexer_scan`（日次の突き合わせ） | 索引の突き合わせの抜き取り | 関数で `(tenant_id, id, version)` だけ | 本文を読む（本文はテナントのコンテキストで読む） |
| `platform` | テナントの作成・移動・削除、保持のジョブ、課金の集計 | RLS を迂回できる（`BYPASSRLS`） | 画面・API から使えない。操作はすべてプラットフォームの監査へ。期限付きの権限でだけ使う |
| `maintenance` | 保持の期間を過ぎたパーティションの `DETACH`・`DROP` | パーティションの操作 | 行の読み取り・書き換え |
| `catalog_loader` | 10.2 節の NULL の行の読み込み | NULL の行の `INSERT`・`UPDATE` | テナントの行 |

- workflow-engine の 5.3・8.3 節のタイマーの取得は、統合で上の `engine_scheduler` の関数 `claim_due_timers` に置き換えた。

## 11. セキュリティの試験

| 種類 | 対象 | 頻度 | 合否 |
| --- | --- | --- | --- |
| SAST、シークレットスキャン、依存・イメージ・IaC の検査 | 全体 | PR、毎日 | High 以上 0 件（他の題材と同じ） |
| 拒否の側のテスト（`SEC-NNN`） | 4 節の全行 | PR | 全件の成功。参照の漏れ 0 |
| 出口ごとの漏れの試験 | 16 の出口 × 組み込みのテーブル | PR（変更した出口）、夜間（全体） | 漏れ 0 件（K6） |
| テナントの分離 | 性質ベーステスト（任意の 2 テナント）、結合テスト、NULL の行の書き込みの拒否 | PR | 1 件でも失敗 |
| XSS の試験 | ラベル、ナレッジの本文、ポータルの部品、通知のテンプレート | PR | 許可の一覧の外のタグ・属性 0 |
| SSRF の試験 | Webhook、フローの呼び出し | PR | 内部のアドレスへの送信 0 |
| DAST | staging の画面・API・ポータル | 夜間とリリースの前 | High 以上 0 件 |
| 外部のペンテスト | ACL の出口の推測、成り代わり、テナントの分離、SSO、メールの受信、Webhook | E12 と、その後は年 1 回と大きな変更の後 | Critical・High がすべて修正済み |

- 脆弱性の報告の窓口（`security.txt`）を公開の時点で置く。

## 12. 脆弱性の管理

- 他の題材の期限（Critical：緩和 24 時間・修正 7 日、High：30 日）を使う。
- **テナントの分離の破れ、ACL の迂回（読めない値の漏れ）、監査の履歴の改ざん、承認の偽り、認証の迂回につながる脆弱性は、CVSS にかかわらず Critical** とする。
- SAML・OIDC のライブラリ、Markdown のサニタイザー、CSV の解析器、メールの MIME の解析器の脆弱性は、公開から 24 時間以内に影響を判定する。

## 13. インシデントへの対応

- 手順は [runbooks/incident-response.md](../runbooks/incident-response.md)。ACL の漏れの疑いは同じ runbook の場面にある。
- **個人データの漏えい等のおそれ**のとき、個人情報保護委員会への報告と本人への通知の要否、報告の主体（テナントか本システムか）は法務が判断する（L1）。報告は速やか（概ね 3〜5 日以内）に行う（[漏えい等報告・本人への通知の義務化について](https://www.ppc.go.jp/news/kaiseihou_feature/roueitouhoukoku_gimuka/)、2026-09-28 に確認）。確報の期限は、発覚から 30 日以内、不正の目的で行われたおそれがあるときは 60 日以内である（[漏えい等の対応とお役立ち資料](https://www.ppc.go.jp/personalinfo/legal/leakAction/)、2026-09-28 に確認）。当てはめと主体の判断は法務が行う（L1）。
- 検知の源：GuardDuty、Security Hub、出口の漏れの試験の本番の抜き取り、監査のハッシュの鎖の検証、承認のない実施の突き合わせ、SEC の検知のアラート、テナントからの報告、シークレットスキャンのパートナーからの通知。

## 14. 法務の論点（法務の確認待ち）

**結論は出さない。** 設計は、どの結論にも対応できる形にする。下の表の「止まるもの」は、確認が済むまで PM・QA が承認しない。全体の一覧は [intent.md](../intent.md) の「法務の確認待ち」にある。

| # | 論点 | この領域の設計への影響 | 止まるもの |
| --- | --- | --- | --- |
| L1 | 委託か自ら取得か、漏えい等の報告の主体と手順 | 9.2 節の個人の削除の請求、13 節の報告の手順、8 節の運用者の参照 | E3 のユーザーの取り込み、E12 の GA の判定 |
| L2 | メールの受信と自動の処理が「他人の通信の媒介」に当たるか | 9 節のメールの原本の保持、8 節の運用者の参照の範囲 | E6 のメールからのチケット |
| L3 | データの所在（国外に出さない約束の範囲） | 5.2 節の鍵のレプリカ（大阪）、CloudFront・WAF・GuardDuty のグローバルなサービスの扱い（処理の場所は未検証）、プッシュの配信の事業者（ブラウザの提供者。国外の可能性） | E1 のリージョンの構成、E12 の契約の文書 |
| L4 | 監査の履歴と記録の保持の年数、削除の請求との関係 | 9 節の 7 年、9.1・9.2 節 | E2 の監査の履歴、E7 の変更の承認 |
| L5 | DPA、サブプロセッサー、専用のセルの条件、運用者の参照の例外の書き方 | 8 節、9.1 節、バックアップの 35 日の説明 | E12 の GA の判定 |
| L7 | 本家からの移行の道具 | 取り込み（[api-and-integrations.md](api-and-integrations.md) の 5 節）の範囲 | MVP の後の移行の Epic |

- Web Push の配信の事業者（Apple・Google・Mozilla の配信のサービス）は、本文に値を入れないことで個人データを渡さない形にする（[portal-and-ui.md](portal-and-ui.md) の 6.4 節）。購読の端点の URL は利用者の端末に結び付くので、サブプロセッサーの一覧に入れるかは L5 で確かめる。

## 15. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `kms-keys-per-cell` | 5.2 節の鍵、マルチリージョン、SCP |
| E1 | `tenant-dek-envelope` | テナントの DEK とエンベロープ暗号化（AAD） |
| E1 | `rls-null-rows-and-cross-tenant-roles` | 10 節のポリシー、ロール、マイグレーションの CI の許可の一覧 |
| E1 | `sec-checklist-traceability-ci` | 4 節の表とテストの参照の CI |
| E1 | `platform-audit-and-log-archive` | 6 節のプラットフォームの監査、log-archive |
| E2 | `attachment-malware-scan` | 5.3 節 |
| E3 | `support-access-grant` | 8 節のサポートの参照の許可と運用の画面 |
| E3 | `break-glass-and-operator-jit` | 8 節の期限付きの権限 |
| E12 | `tenant-deletion-job` | 9.1 節 |
| E12 | `retention-jobs` | 9 節の削除のジョブとパーティションの `DROP` |
| E12 | `external-pentest` | 11 節 |
| E12 | `legal-items-closure` | 14 節の法務の論点の確定と、保持の期間の確定 |

## 16. 未解決の問い

### 決定（2026-09-28、既定案）

- **ASVS 5.0 の Level 2**（1 節）。
- **鍵はセルごと・用途ごと、テナントの秘密は DEK**（5.2 節、ADR-0052）。
- **添付はマルウェアの検査の後にだけ渡す**（5.3 節）。
- **運用者はサポートの参照の許可と期限付きの権限でだけテナントのデータを読む**（8 節）。
- **保持の期間は 9 節の既定案**（ADR-0053）。
- **NULL の行は 10.2 節の表だけ、読み取りだけ**（ADR-0054）。統合で `number_def`・`ci_relation_type`・`ci_attribute`・`ci_identification_rule`・`flow_def`・`flow_version` を足した。
- **保持の期間の「（案）」を 9 節の表に一本化した**（統合で決めた）。
- **テナントをまたぐロールは識別子だけを返す関数**（10.4 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 顧客の管理する鍵（専用のセル） | S2 の前、専用のセルの契約の条件と一緒に |
| 個人の削除の請求と監査の履歴の自由記述 | L1・L4 の後。暗号の消去が要るなら別の ADR |
| テナントの削除のときの監査の履歴の扱い | L4・L5 の後 |
| 当番の端末のセッションの長さ（最大 14 日、無操作 7 日） | E8（[portal-and-ui.md](portal-and-ui.md) の 6.4 節） |
| ASVS の要件の番号の照合 | E1 |
| SES の送信の TLS の強制の扱い | E6 |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- `SEC-` の行のうち、テストのないもの：0 件。
- 出口ごとの漏れの試験の結果：漏れ 0 件（K6）。
- テナントの分離の性質ベーステストの結果：失敗 0 件（NFR-009）。
- マルウェアの検査の結果の内訳と、検査の遅れの p99。
- サポートの参照の許可の件数と、許可のない参照の試み（0 が目標）。

### runbooks

- [incident-response.md](../runbooks/incident-response.md) の「ACL の漏れの疑い」「テナントの分離の破れの疑い」。
- `suspected-acl-leak.md`（access-control の提案）は、incident-response の場面に含めた。
- `tenant-deletion.md`：テナントの削除のジョブの確かめ方と、途中で止まったときの再開。
- `malware-detected.md`：マルウェアが見つかったときの隔離の確かめ方とテナントへの連絡。
- `leaked-api-credential.md`（api-and-integrations の提案）。
- `operator-access-review.md`：四半期のアクセスのレビューの手順。
- `sensitive-data-in-logs.md`・`security-control-disabled.md`（E1 `telemetry-package`）：ログの走査で秘密・個人データの形を見つけたとき、GuardDuty・CloudTrail・走査・マルウェアの検査が止まったときの手順。それまでは incident-response の共通の進め方。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `tenant_dek`（テナントの DEK の暗号文と版） | 5.2 節 |
| Aurora `attachment`（S3 のキー、検査の状態、隔離の印） | 5.3 節 |
| Aurora `tenant_audit_event` | 6 節。1 年、log-archive へ |
| log-archive `platform_audit_event` | 6 節。7 年、Object Lock |
| Aurora `support_access_grant` | 8 節 |
| Aurora `legal_hold` | 9.3 節 |
| Aurora `tenant_deletion_run` | 9.1 節 |
| 10.2 節の NULL の行を持つ表の一覧 | [data-model.md](data-model.md) の 3 節と一致させる |

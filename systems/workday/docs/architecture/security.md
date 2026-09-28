# Security: Workday

信頼境界、脅威モデル（部品ごとの STRIDE）、個人情報の分類、暗号化と鍵の階層、秘密情報、運用者のアクセス、セキュリティの試験、脆弱性の管理、インシデント、法務の論点を扱う。テナントの中の権限は [security-model.md](security-model.md)、マイナンバーの保管庫の中身は [my-number-vault.md](my-number-vault.md)、監査ログと保存は [audit-and-retention.md](audit-and-retention.md)、アカウントとネットワークは [infrastructure.md](infrastructure.md) にある。

| ADR | 決定 |
| --- | --- |
| [0005](../decisions/0005-security-and-my-number.md) | ドメインと業務プロセスの権限と職務分掌、マイナンバーは別アカウントの保管庫、共有スキーマと RLS |
| [0051](../decisions/0051-threat-model-and-pii-classification.md) | 個人情報を P0〜P4 の 5 つの区分に分け、列ごとに区分を宣言する。区分ごとに、保存の暗号、ログ、分析用の出力、閲覧の記録、テストのデータの規則を決め、CI で守る。脅威は部品ごとの STRIDE の表で持ち、拒否の側のテストを `THR-` の ID で結ぶ |
| [0052](../decisions/0052-kms-key-hierarchy.md) | KMS の鍵を用途ごとに分ける。テナントごとの鍵を S3 のテナントの物体と項目の暗号の DEK に使い、テナントの解約の後に鍵の削除で消せるようにする。振込ファイル、保管庫、監査の署名、保管庫への主張の署名には専用の鍵を置く。どれもマルチリージョン |
| [0053](../decisions/0053-operator-access-and-vault-break-glass.md) | 運用者は本番のデータに常設の権限を持たない。テナントのデータの参照は、テナントの許可（期限つき、ドメインを限る）か、セキュリティの事象のときだけ。保管庫の番号を復号できる人のロールは作らない。保管庫の緊急の操作は 3 者（セキュリティの担当、Ops の責任者、テナントへの通知）で行う。AI エージェントは本番に経路を持たない |

## 1. 目標と前提

- **OWASP ASVS 5.0 の Level 2 を全体の目標にする。** 保管庫（アクセス制御、データの保護、暗号、ログ）は Level 3 を目標にする。他の題材（Slack、Stripe、Auth0）と同じ ASVS 5.0 を使う（[Auth0 の security.md](../../../auth0/docs/architecture/security.md) の 1 節で原文を確認済み）。要件の番号との照合は E1 で行う。
- 最も重い障害は 5 つ。
  1. **マイナンバーの漏えい**：法令の罰則と報告、信頼の失墜（NFR-007）。
  2. **テナントをまたいだ漏えい**（NFR-009）。
  3. **給与・口座・扶養・健康の情報の、権限のない人への露出**（NFR-008）。
  4. **お金の不正**：振込先のすり替え、架空の従業員、振込ファイルの改ざん、自分の給与の操作。
  5. **給与の計算の誤りの大量の発生**（正しさの障害だが、規則表の改ざん・エンジンの供給網の侵害でも起きる）。
- 実行基盤・CI/CD・監視の統制は、他の題材の決定を引き継ぐ（[ADR-0001](../decisions/0001-platform-and-stack.md)）。
- **AI エージェント（コーディング・運用）は、本番に一切の経路を持たない**（[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)）。

## 2. 信頼境界

```
  ┌──────────────────────── インターネット（信頼しない）─────────────────────────────────┐
  │ 従業員・マネージャーのブラウザ  人事・給与の担当  連携（API）  打刻機  テナントの IdP  攻撃者 │
  └────┬────────────────────────────────┬─────────────────────┬───────────────────────┘
       │ <tenant>.<brand>.<domain>        │ mn.<tenant>.<brand>.<domain>
  ═════╪═ B1：エッジ（CloudFront＋WAF）═══╪══════════════════════════════════════════════
  ┌────▼──── prod アカウント（東京・大阪）──┼──────────┐   ┌──── vault アカウント ──────────────┐
  │ API（SPA の API・公開の API・Better Auth）│          │   │ vault-web ◀──────────────────────┘ │
  │ BP Worker、Worker、Relay                 │          │   │ vault-api ◀─ B3：PrivateLink＋相互 TLS │
  │ Payroll Compute（DB に経路なし）         │── B3 ────┼──▶│   ＋操作者の主張（署名）             │
  │ ══ B2：テナント（ホスト名＋セッション → tenant_id、SET LOCAL、FORCE RLS）══ │   │ vault-docgen、Aurora、S3、KMS       │
  │ Aurora、Valkey、SQS、S3                   │          │   └──────────────────────────────────┘
  │ egress Worker ── B5 ──▶ Webhook の URL、テナントの IdP の JWKS・メタデータ │
  └──────────────────────────────────────────┘
  ═══ B4：管理プレーン ═══ CI/CD（OIDC）、運用者（SSO＋MFA、JIT）、log-archive（Object Lock）
  ─ ─ ─ B6：開発環境（AI コーディングエージェント）… 本番への経路なし。合成のデータだけ ─ ─ ─
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | すべての外部の要求 | TLS 1.2 以上、HSTS、WAF（[infrastructure.md](infrastructure.md) の 4 節）。オリジンは CloudFront からの要求だけを受ける |
| B2 テナント | サービスから DB | ホスト名とセッションのテナントの一致、`SET LOCAL app.tenant_id`、FORCE RLS（[ADR-0005](../decisions/0005-security-and-my-number.md)） |
| B3 保管庫 | 人事の側から保管庫 | 別のアカウント、PrivateLink、相互 TLS、署名した操作者の主張、保管庫の担当者の表（[ADR-0046](../decisions/0046-purpose-bound-vault-api-and-access-log.md)） |
| B4 管理プレーン | デプロイ、鍵、運用者の操作 | OIDC の短命な認証情報、JIT（[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)）、`security:sensitive` の 2 人の承認（[delivery.md](delivery.md) の 3 節） |
| B5 外向きの送信 | Webhook、IdP のメタデータ | 専用の egress、名前解決の後の IP の検査、リダイレクトを追わない |
| B6 開発環境 | コード（PR としてのみ） | 本番の資格情報とデータを置かない。テストは合成の人だけ（[AGENTS.md](../../AGENTS.md)） |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主要な脅威と対策だけを書く。`THR-` の ID は、拒否の側のテストの名前に入れる（[ADR-0051](../decisions/0051-threat-model-and-pii-classification.md)）。

### 3.1 エッジと画面

| ID | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| THR-001 | S | オリジンを直接叩き、WAF を迂回する | ALB のセキュリティグループを CloudFront のマネージドプレフィックスリストに限り、秘密のヘッダーを検査する（Auth0 の題材と同じ） |
| THR-002 | T | `Host` の偽りで別のテナントとして扱わせる | テナントはホスト名とセッションの両方で決め、一致しなければ拒む（[ADR-0005](../decisions/0005-security-and-my-number.md)） |
| THR-003 | T | XSS（テナントが入れる名前・通知の文面） | 既定でエスケープする描画、`script-src 'self'` の CSP、テナントの HTML を許さない（[self-service-ui.md](self-service-ui.md) の 10 節） |
| THR-004 | I | 共有の PC のブラウザに給与・個人情報が残る | API の応答を端末に保存しない。ログアウトで保存を消す |
| THR-005 | T | CSV・Excel の出力の数式の注入 | 先頭の `=`・`+`・`-`・`@` を無害にする（[reporting.md](reporting.md) の 4.4 節） |

### 3.2 API と権限

| ID | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| THR-010 | E | ID の書き換えで、範囲の外の従業員を読む（IDOR） | すべての読み取りで `can`・`scopeFilter`（[ADR-0017](../decisions/0017-authorization-evaluator.md)）。PROP-SEC-001 |
| THR-011 | E | 自分の給与の変更を自分で承認する、委任を使って承認する | 起票者と本人の除外（[ADR-0014](../decisions/0014-bp-routing-and-delegation.md)）、職務分掌（[ADR-0019](../decisions/0019-segregation-of-duties-checks.md)） |
| THR-012 | E | 権限の方針を 1 人で広げる | 方針の版と、別の人の有効化（[ADR-0018](../decisions/0018-security-policy-versions-and-activation.md)） |
| THR-013 | I | `known_at` の問い合わせで、訂正で退いた誤りの値（誤って入れた他人の口座など）を見る | `audit` の権限を加えて要る（[ADR-0008](../decisions/0008-point-in-time-queries-and-activation-timers.md)） |
| THR-014 | I | レポートの集計から個人の給与を割り出す | 少人数の抑止（[ADR-0041](../decisions/0041-small-cell-suppression-for-sensitive-aggregates.md)） |
| THR-015 | R | 給与の担当が、誰かの給与を見たことを否認する | 機微なドメインの閲覧の記録（[ADR-0020](../decisions/0020-sensitive-read-audit-and-access-explanations.md)）と連鎖（[ADR-0048](../decisions/0048-audit-log-hash-chain-and-anchoring.md)） |
| THR-016 | D | 重いレポート・一括の出力で DB を使い切る | レポートの reader を分け、同時の実行の上限（[reporting.md](reporting.md) の 6 節） |

### 3.3 お金

| ID | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| THR-020 | S | 乗っ取った従業員のアカウントで、振込先を攻撃者の口座に変える | 口座の変更は本人以外の承認（[core-hr.md](core-hr.md) の 6 節）。変更のたびに本人の登録済みの連絡先へ通知（本文に口座を書かない）。支給日の前の 10 営業日の中の口座の変更は、給与の確認の検査で警告にする（[payroll-engine.md](payroll-engine.md) の 11 節の DT-PAY-004 の #10）。口座の変更はパスキーか SSO の再認証を要る |
| THR-021 | T | 給与の担当が、承認の後に振込ファイルをすり替える | 承認をファイルの SHA-256 に結ぶ（[ADR-0035](../decisions/0035-bank-transfer-files.md)）。取り出しは再認証、1 回限りの URL、記録 |
| THR-022 | E | 架空の従業員を入社させて給与を振り込む | 入社の起票と振込先の承認の職務分掌（S7。警告を止めるに変えることを勧める）。新しい口座が既存の従業員の口座と同じなら警告（口座の HMAC で重複を検知） |
| THR-023 | E | 自分の給与の個別の調整を入れて自分で確定する | 職務分掌 S1・S4（[security-model.md](security-model.md) の 5.1 節） |
| THR-024 | T | 規則表（税額表・料率）を書き換えて、多くの人の控除を変える | 取り込みと独立の照合の 2 人、公開の後は書き換えない、訂正は新しい版と遡及（[ADR-0030](../decisions/0030-rule-table-ingestion-and-verification.md)） |
| THR-025 | T | 給与の計算のエンジンの供給網の侵害（依存の改ざん） | 依存の固定、SBOM、イメージのダイジェストを結果に記録、ゴールデンデータセット、夜間の再現の抜き取り（[ADR-0026](../decisions/0026-payroll-run-stages-and-input-snapshot.md)、[delivery.md](delivery.md)） |

### 3.4 保管庫

| ID | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| THR-030 | S | 人事の側の乗っ取りから、担当者の名前をかたって番号を表示する | 表示は保管庫の画面の中だけ。保管庫の担当者の表と再認証（[ADR-0046](../decisions/0046-purpose-bound-vault-api-and-access-log.md)） |
| THR-031 | S | 操作者の主張の署名の鍵の悪用 | `Sign` は `api` のタスクのロールだけ。他の主体の呼び出しで呼び出す（CloudTrail）。主張は 60 秒・1 回限り |
| THR-032 | I | 人事の側のログ・入力の文書・分析の出力に番号が混ざる | 番号を人事の側で受けない（[ADR-0045](../decisions/0045-my-number-collection-and-identity-verification.md)）。CI と本番の番号の形の走査（[observability.md](observability.md) の 4 節） |
| THR-033 | I | 保管庫の DB・バックアップの持ち出し | エンベロープ暗号化、`vault-mn` の `Decrypt` は保管庫のタスクのロールだけ。人のロールには与えない（[ADR-0052](../decisions/0052-kms-key-hierarchy.md)） |
| THR-034 | T | 保管庫の記録の書き換えで、閲覧を隠す | 記録の連鎖と Object Lock、ALB の記録との突き合わせ |
| THR-035 | E | 運用者が保管庫のデータを読む | 人の復号の経路を作らない。緊急の操作は 3 者（[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)） |

### 3.5 連携

| ID | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| THR-040 | E | 一括の取り込みで業務プロセスと承認を迂回する | 行ごとの子の案件、親の承認は別の人（[ADR-0042](../decisions/0042-bulk-import-through-business-processes.md)） |
| THR-041 | I | 一括の取り込みのファイルに番号を入れて人事の側に置く | 番号の形の列を含むファイルを拒む（[integrations-and-bulk.md](integrations-and-bulk.md) の 11 節） |
| THR-042 | I | Webhook の URL に内部のアドレスを指定する（SSRF） | 専用の egress、名前解決の後の IP の検査、リダイレクトを追わない |
| THR-043 | S | 打刻機の鍵を盗んで打刻を偽る | 端末ごとの鍵、取り消し、送信元の IP の許可リスト、打刻の端末の記録。客観的な記録との乖離の検知（[ADR-0021](../decisions/0021-clock-events-corrections-and-objective-records.md)） |
| THR-044 | S | SAML の応答の偽造・再送 | 署名、`InResponseTo`、IdP 起点の拒否、時刻（[ADR-0044](../decisions/0044-sso-api-clients-and-clock-terminals.md)） |
| THR-045 | E | API の利用者に承認をさせる | 連携用の利用者に `approve` を与えない（[integrations-and-bulk.md](integrations-and-bulk.md) の 6.2 節） |

### 3.6 データの置き場所と運用

| ID | 種類 | 脅威 | 対策 |
| --- | --- | --- | --- |
| THR-050 | I | RLS のコンテキストの設定漏れ（Worker、Payroll の入力の固定） | 性質ベーステスト、マイグレーションの CI（[ADR-0005](../decisions/0005-security-and-my-number.md)）。Payroll Compute は DB に経路を持たない |
| THR-051 | T | 監査ログの削除・書き換え | 追記のみ、連鎖、Object Lock（[ADR-0048](../decisions/0048-audit-log-hash-chain-and-anchoring.md)） |
| THR-052 | I | 本番のデータが開発・テストの環境に入る | 本番のデータを本番のアカウントの外に出さない。匿名化したコピーも作らない。移行のファイルは本番のアカウントだけ |
| THR-053 | E | CI/CD の乗っ取りで本番に任意のコードを出す | OIDC の短命な認証情報、`security:sensitive` の 2 人、イメージの署名の検証（[delivery.md](delivery.md)） |

## 4. 個人情報の分類（[ADR-0051](../decisions/0051-threat-model-and-pii-classification.md)）

| 区分 | 例 | 置き場所 | 保存の暗号 | ログ・トレース | 分析用の出力 | 閲覧の記録 |
| --- | --- | --- | --- | --- | --- | --- |
| P0 業務 | 組織の名前、職務の名前、等級の名前 | Aurora | 保存時の暗号（KMS） | 出してよい | 出してよい | なし |
| P1 個人 | 表示の名前、社員番号、仕事の連絡先、所属、職位、雇用区分、入社日 | Aurora | 同上 | ID だけ（`worker_id`・`employment_id`）。名前・社員番号は出さない | 出してよい（表示の名前だけ） | なし |
| P2 機微 | 氏名（全表記・旧姓）、生年月日、住所、個人の連絡先、扶養、給与の額、口座、勤怠の詳細（打刻の時刻）、休職の種類、退職の理由 | Aurora（口座は項目の暗号） | 同上＋口座はテナントの鍵の DEK | 出さない | 集計だけ（抑止つき）。口座・住所は出さない | 要求ごと（[ADR-0020](../decisions/0020-sensitive-read-audit-and-access-explanations.md)） |
| P3 要配慮 | 健康、障害、労災の内容 | MVP では持たない（`worker.sensitive` のドメインだけ用意） | 持つなら項目の暗号 | 出さない | 出さない | 要求ごと |
| P4 特定個人情報 | 個人番号、番号の一部、番号を書いた書類、本人確認の画像 | 保管庫だけ | エンベロープ暗号化（保管庫の鍵） | 出さない。形の走査で検知 | 出さない | 保管庫の記録（すべて） |

- 列の区分は、facet の宣言（`FacetSpec`）とマイグレーションの注記（`pii_class`）で持つ。CI で「区分のない列」を拒む。
- ログのイベントの型は、P0・P1 の ID だけを受ける（[observability.md](observability.md) の 2 節）。
- テストのデータは区分によらず合成（[AGENTS.md](../../AGENTS.md)）。個人番号は印つきの合成の生成器だけ。
- 保存の期間は区分ではなく、データの種類の規則表で決める（[audit-and-retention.md](audit-and-retention.md) の 5 節）。

## 5. 暗号化

### 5.1 転送中

| 区間 | 方式 |
| --- | --- |
| 利用者 → CloudFront | TLS 1.2 以上、HSTS（`includeSubDomains`） |
| CloudFront → ALB | TLS（ACM） |
| ALB → タスク | TLS（Private CA） |
| 人事の側 → 保管庫 | PrivateLink の上の相互 TLS（保管庫のアカウントの Private CA、7 日） |
| タスク → Aurora・Valkey | TLS。`rds.force_ssl`、Valkey は転送中の暗号化と AUTH |
| Worker → 外部（Webhook） | TLS。証明書の検証を外さない |

### 5.2 保存時（[ADR-0052](../decisions/0052-kms-key-hierarchy.md)）

| KMS の鍵 | アカウント | 守るもの | 使える主体 |
| --- | --- | --- | --- |
| `<brand>-platform-data` | prod | Aurora、SQS、バックアップ、テナントの外の S3 | 各 AWS のサービス（`kms:ViaService`） |
| `<brand>-tenant-<tenant_id>` | prod | テナントの S3 の物体（入力の文書、結果の束、明細、レポートの出力、取り込みのファイル）、項目の暗号の DEK（口座番号） | `api`・`worker`・`payroll-compute`（そのテナントのジョブ）。暗号の文脈に `tenant_id` |
| `<brand>-bank-files` | prod | 振込ファイル | 振込ファイルの生成と取り出しの Worker のロールだけ |
| `<brand>-hr-vault-assertion`（非対称、署名） | prod | 保管庫への操作者の主張 | `api` の `Sign`。保管庫は公開鍵だけ |
| `<brand>-audit-anchor`（非対称、署名） | log-archive | 監査の日の署名 | `audit-verifier` の `Sign` |
| `<brand>-log-archive` | log-archive | log-archive のバケット | log-archive のサービス。prod の主体は書くだけ |
| `vault-mn` | vault | 番号の DEK | `vault-api`・`vault-docgen` のタスクのロールだけ。人のロールには与えない |
| `vault-hmac` | vault | テナントの HMAC の鍵 | 同上 |
| `vault-docs` | vault | 書類・確認の画像 | 同上 |
| `vault-platform-data` | vault | 保管庫の Aurora、バックアップ | 各 AWS のサービス |

- どれもマルチリージョンの鍵（主は東京、レプリカは大阪）。自動のローテーションを有効にする（非対称の鍵を除く）。削除の待ちは 30 日、削除の予約は break-glass のロール以外を SCP で禁じる。
- テナントの解約：データの返却と保存の期間の後に、テナントの鍵の削除を予約し、S3 のテナントの物体とバックアップの中の項目の暗号文を読めなくする（暗号の消去）。Aurora の行は通常の削除で消す。
- 費用：KMS の鍵は東京で 1 本あたり月 1 USD、要求は 1 万回あたり 0.03 USD（[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/awskms/current/ap-northeast-1/index.json)、2026-09-28 に確認）。テナントの鍵は S1 の 600 テナントで月 600 USD 程度（マルチリージョンのレプリカの費用の扱いは未検証）。S3 の SSE-KMS はバケットキーを使って要求を減らす。

## 6. 秘密情報

| 秘密 | 保存 | ローテーション |
| --- | --- | --- |
| DB の認証情報、内部の API の鍵、メールの送信の鍵 | Secrets Manager | 自動（他の題材と同じ） |
| API の利用者の秘密（`client_secret_basic` のとき） | SHA-256 だけ。1 回だけ表示 | テナントの操作 |
| API の利用者の公開鍵（`private_key_jwt`） | Aurora（公開鍵なので暗号なし） | テナントの操作 |
| 打刻機の鍵（`<brand>_tk_`）、Webhook の署名の秘密 | ハッシュ（打刻機）、テナントの鍵のエンベロープ暗号化（Webhook） | テナントの操作 |
| SSO の接続の設定（OIDC のクライアントの秘密、SAML の SP の鍵） | テナントの鍵のエンベロープ暗号化（Better Auth の保存の上に被せる） | テナントの操作 |
| 相互 TLS の証明書 | AWS Private CA | 7 日で自動 |
| CloudFront → ALB の秘密のヘッダー | Secrets Manager | 90 日 |

- 本システムのトークンの接頭辞（`<brand>_at_`、`<brand>_tk_`）は、GitHub のシークレットスキャンのパートナープログラムに独自の形式として登録する（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 7. 運用者のアクセス（[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)）

- 常設の権限：Grafana、メトリクス、アラート、個人情報を含まないアプリのログ。
- 期限つきの権限（最長 4 時間、理由と承認）：本番の DB の読み取り（RLS の対象、テナントを指定）、書き込み（2 人）、ECS Exec（保管庫と Payroll Compute では提供しない）、KMS の管理（2 人）。
- **テナントのデータの参照**：テナントの管理者が、サポートの参照を許可する（期限つき、ドメインを限る。P3・P4 は選べない）。許可のない参照は、セキュリティの事象の対応に限り、プラットフォームの監査に残し、事後にテナントへ知らせる。
- **代理のログインは運用者に使わせない**（[security-model.md](security-model.md) の 9 節）。見え方は説明の報告で確かめる。
- **保管庫**：番号を復号できる人のロールはない（break-glass も含む）。保管庫の緊急の操作（障害の復旧、誤った記録の修復）は、セキュリティの担当と Ops の責任者の 2 人の承認と、テナントの事務取扱責任者への事前（不可能なら直後）の通知で行う。操作は基盤（タスク、ネットワーク、DB の構造）に限り、番号の平文に触れない。
- **給与の結果**：運用者は見ない。障害の調査は、個人を特定しない件数・ハッシュ・実行の状態で行う。額が要る調査は、テナントの許可の参照で行う。
- **AI エージェント**：本番のデータ・ログ・トレース・シェル・KMS に経路を持たない。調査に使うときは、人が取り出した個人情報を含まないものだけを渡す。
- 四半期ごとに、権限の割り当てと期限つきの権限の使用の記録を見直す。

## 8. セキュリティの試験

| 種類 | 対象 | 頻度 | 合否 |
| --- | --- | --- | --- |
| SAST、シークレットスキャン、依存・イメージ・IaC の検査 | 全体 | PR、毎日 | High 以上 0 件（他の題材と同じ） |
| 拒否の側のテスト（`THR-NNN`） | 3 節の全行 | PR | 全件の成功。表のすべての行がテストから参照されている |
| テナントの分離 | 性質ベーステスト（PROP-SEC-002、PROP-RPT-004、PROP-MN-004） | PR | 全件の成功 |
| 個人番号・個人情報の出力の走査 | テストのログ・スナップショット・入力の文書、本番のログ | CI、本番は常時 | 0 件 |
| DAST | staging の画面・API・保管庫の画面 | 夜間とリリース前 | High 以上 0 件 |
| 外部のペンテスト | 権限の迂回、保管庫の境界、振込ファイルの経路、一括の取り込み、SSO | E12 と、その後は年 1 回と大きな変更の後 | Critical・High がすべて修正済み |
| IAM・ネットワークの静的検査 | Terraform | PR | [ADR-0052](../decisions/0052-kms-key-hierarchy.md)・[ADR-0053](../decisions/0053-operator-access-and-vault-break-glass.md)・[ADR-0054](../decisions/0054-accounts-network-and-vault-boundary.md) の条件 |

## 9. 脆弱性の管理

- 他の題材の期限（Critical：緩和 24 時間・修正 7 日、High：30 日）を使う。
- **テナントの分離の破れ、保管庫の境界の破れ、権限の迂回、振込ファイル・口座の改ざんにつながる脆弱性は、CVSS にかかわらず Critical** とする。
- Better Auth（SSO の部品）、PDF のライブラリ、Excel の解析のライブラリの脆弱性は、公開から 24 時間以内に影響を判定する。

## 10. インシデント

- 手順は [runbooks/incident-response.md](../runbooks/incident-response.md)。マイナンバーの漏えいの疑い、給与の計算の誤り（支給日の後）、テナントの分離の破れ、個人情報の出力の場面を持つ。
- **個人データの漏えい等**：個人情報保護法の報告（速報は概ね 3〜5 日以内、確報は 30 日以内、不正の目的によるものは 60 日以内。他の題材で確かめた目安。[Stripe の security.md](../../../stripe/docs/architecture/security.md) の 12 節）。
- **特定個人情報の漏えい等**：番号法 29 条の 4。委託先は委託元に通知すれば報告の義務を免れ、通知の目安は概ね 3〜5 日（[ガイドライン](https://www.ppc.go.jp/legal/policy/my_number_guideline_jigyosha/) の別添 2、2026-09-28 に確認）。本システムが委託先に当たるか（L1）で、テナントへの通知か本システムの報告かが決まる。
- 報告の主体と手順は法務が判断する（11 節）。

## 11. 法務の論点（法務の確認待ち）

**結論は出さない。** 下の「止まるもの」は、確認が済むまで PM・QA が承認しない。全体の一覧は [intent.md](../intent.md) にある（L56〜L58 はこの文書が足したもの）。

| # | 論点 | security の設計への影響 | 止まるもの |
| --- | --- | --- | --- |
| L1 | 本システムは番号法の委託先か。再委託（AWS、運用の外部委託）の許諾 | 10 節の通知の手順、保管庫の運用者の規則、サブプロセッサーの一覧 | E11 の保管庫の本番の利用 |
| L10 | 個人情報保護法の委託先か。要配慮個人情報を持つときの同意と権限。漏えい等の報告の分担 | 4 節の P3、10 節 | E12 の GA の判定 |
| L56 | 運用者によるテナントのデータの参照（セキュリティの事象の例外）を、契約でどう約束するか | 7 節 | E12 の GA の判定 |
| L57 | テナントの解約の後のデータの返却と、鍵の削除による消去の説明（バックアップ 35 日を含む） | 5.2 節 | E12 の GA の判定 |
| L58 | 口座の変更の通知を、本人の個人の連絡先に送ってよいか（個人の連絡先の利用目的） | THR-020 | E10 の `payment-election-change-notice` |

## 12. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | アカウントと境界（prod、vault、log-archive）、KMS の鍵とキーポリシー、`THR-` の追跡の CI、個人情報の区分の宣言と CI、番号の形の走査（CI と本番）、監査ログの表、THR-050〜053（RLS、監査、本番のデータ、CI/CD） |
| E4 | THR-010〜016 の拒否の側のテスト |
| E5 | THR-001〜005、THR-044（SSO） |
| E6 | THR-043（打刻機） |
| E8 | THR-024・025（規則表の改ざん、エンジンの供給網） |
| E10 | THR-020〜023（口座と振込ファイル） |
| E11 | THR-030〜035（保管庫）、運用者の参照の許可の仕組み |
| E12 | THR-040〜042・045（一括の取り込み、Webhook、API）、外部のペンテスト、インシデントの机上訓練（マイナンバーの漏えい、給与の誤り）、`security.txt`、法務の論点の確定 |

## 13. 持ち越し

- ASVS 5.0 の要件の番号の照合（E1）。
- テナントの鍵を S2・S3（6,000〜2 万テナント）でも 1 テナント 1 本にするか（費用とクォータ。KMS の鍵の数の上限は未検証）。S2 の前に決める。

## 14. quality.md・runbooks・data-model への項目

### quality.md

- `THR-` の行のうち、テストのないもの 0 件。
- 番号の形・個人情報の出力の走査の検出 0 件。
- 運用者の期限つきの権限の使用の件数と理由、テナントの許可のない参照の件数。
- 口座の変更の通知の送信の失敗の件数。

### runbooks

- [runbooks/incident-response.md](../runbooks/incident-response.md)（マイナンバーの漏えいの疑い、個人情報の出力、テナントの分離）。
- `tenant-offboarding-crypto-erase.md`：解約のテナントの鍵の削除の手順（2 人の承認、保存の期間の確認）。
- `vault-break-glass.md`：保管庫の緊急の操作。
- `operator-access-review.md`：四半期のアクセスレビュー。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `support_access_grants` | 7 節。テナントの管理者の許可（ドメイン、期限） |
| Aurora `tenant_keys`（RLS の外） | テナントの KMS の鍵の ARN、状態（有効・削除の予約） |
| マイグレーションの注記 `pii_class` | 4 節。列ごと |

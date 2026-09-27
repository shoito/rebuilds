# Security: Stripe

信頼境界、脅威モデル、統制の一覧、暗号化と鍵の管理、監査ログ、秘密情報、サプライチェーン、セキュリティの試験、インシデント対応、データのライフサイクル。カード情報の扱いの詳細は [card-vault.md](card-vault.md) にある。

| 関連 | 決定 |
| --- | --- |
| [ADR-0002](../decisions/0002-account-tenancy.md) | 加盟店のアカウントをテナントにし、共有スキーマと RLS で分ける |
| [ADR-0005](../decisions/0005-pci-scope-segmentation.md) | カード情報は CDE（別の AWS アカウント）に閉じ込める |
| [ADR-0019](../decisions/0019-vault-encryption-and-key-hierarchy.md) | CDE の暗号化と鍵の階層 |
| [ADR-0020](../decisions/0020-cde-access-model.md) | CDE へのアクセスは JIT だけ |
| [ADR-0023](../decisions/0023-audit-log.md) | 監査ログ（Slack の ADR-0018 を引き継ぎ、CDE の系統を加える） |
| [ADR-0024](../decisions/0024-data-retention-and-deletion.md) | データの保持と削除（法定の保存と、個人情報・カード情報の最小化） |

## 1. 目標と前提

- **PCI DSS v4.0.1 のサービスプロバイダー レベル 1**（NFR-010）を満たす設計にする。CDE の外は、Slack と同じく **OWASP ASVS 5.0 の Level 2** を目標にする（Slack の [security.md](../../../slack/docs/architecture/security.md) の 1 節）。
- 最も重い障害は 2 つ。
  1. **カード番号の漏洩**（intent.md の守るべき振る舞い）。
  2. **加盟店をまたいだデータの漏洩と、お金の不正な移動**（NFR-009、入金先の書き換えなど）。
- 実行基盤・CI/CD・監視の統制は Slack の決定を引き継ぎ（ADR-0001）、決済に固有の部分だけをここに書く。
- **AI エージェント（コーディング・運用）は、本番と CDE に一切アクセスしない**（Slack の security.md の 7.3 節と同じ。CDE は JIT の対象にもしない）。

## 2. 信頼境界

```
  ┌──────────────────── インターネット（信頼しない）──────────────────────────┐
  │ 加盟店のサーバー   加盟店の顧客のブラウザ   ダッシュボードの利用者   攻撃者 │
  └────┬──────────────────────┬─────────────────────────┬───────────────────┘
       │ api.<domain>          │ elements / vault.<domain>│ dashboard / checkout.<domain>
  ═════╪══ B1: エッジ（CloudFront＋WAF＋Shield）════════╪═══════════════════════
       │                       │                         │
  ┌────▼───── 本体アカウント（CDE の外）─────────────────▼──────────────────┐
  │ API ─ Payments ─ Ledger ─ Fraud ─ Payouts    Dashboard・Checkout の BFF   │
  │ ══ B2: テナントのコンテキスト（SET LOCAL app.account_id、FORCE RLS）══   │
  │ Aurora（本番）  Aurora（テスト）  SQS  Valkey  S3                          │
  │ Webhook の配信（egress VPC の Lambda）─────────────▶ 加盟店の URL（B5）  │
  └──────────────┬──────────────────────────────▲─────────────────────────────┘
                 │ B3: 本体→CDE は PrivateLink＋mTLS、CDE→本体は SQS だけ │
  ┌──────────────▼──── CDE アカウント（cde-live・cde-test）─┴──────────────────┐
  │ vault-ingest  vault-core  Vault DB  connector-gateway ──▶ Egress（許可リスト）──▶ アクワイアラ・3DS Server（B6）
  └────────────────────────────────────────────────────────────────────────────┘
  ═══ B4: 管理プレーン ═══ CI/CD（OIDC、本体と CDE で別の経路）、運用者（SSO＋MFA、CDE は JIT）
                         log-archive アカウント（CloudTrail、監査、ログ。Object Lock）
  ─ ─ ─ B7: 開発環境（AI コーディングエージェント）… 本番・CDE への経路なし ─ ─ ─
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | すべての外部リクエスト | TLS 1.2 以上、HSTS（preload）、WAF（マネージドルール、レート制限）、Shield Standard |
| B2 テナント | 本体のサービスから DB | `SET LOCAL app.account_id`、FORCE RLS（ADR-0002）。テストと本番は別のクラスタ |
| B3 CDE | 本体と CDE の間 | 本体 → CDE は PrivateLink＋mTLS、CDE → 本体は SQS の `connector-results` だけ（[ADR-0029](../decisions/0029-multi-account-and-cde-layout.md)）。CDE の OU の SCP で本体のロールからの `AssumeRole` を拒否。越える識別子は `pm_`（と紐づけの 1 回の `card_input`）だけで、カード番号も `card_ref` も越えない（[card-vault.md](card-vault.md) の 2 節） |
| B4 管理プレーン | デプロイ、鍵、運用者の操作 | OIDC の短命な認証情報、CDE の経路は別の承認、JIT（ADR-0020）、監査 |
| B5 Webhook | 加盟店の URL への外向きの送信 | 本体・CDE への経路を持たない専用の egress VPC の Lambda から、Elastic IP 付きの NAT の固定 IP で送る。名前解決後の IP の検査、署名（3.4 節、[ADR-0025](../decisions/0025-webhook-signing-and-isolated-delivery.md)、[infrastructure.md](infrastructure.md) の 2.1 節） |
| B6 アクワイアラ | カード番号を含む送信 | Egress のドメインの許可リスト、TLS、TPSP の管理 |
| B7 開発環境 | コード（PR としてのみ） | 本番の認証情報・カード番号を置かない。テストはブランドのテスト用の番号だけ |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主要な脅威と対策だけを書く。

### 3.1 API（`api.<domain>`）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 秘密キーの漏洩（リポジトリへのコミットなど）による、なりすまし | キーは DB にハッシュだけを保存。制限付きキーと、キーごとの送信元 IP の制限（本家のアクセスポリシーに相当）。GitHub のシークレットスキャンのパートナーへの登録を検討し、公開リポジトリでの漏洩を検知したら失効を案内する（本家も GitHub のトークンスキャンを使う。[Stripe のセキュリティ](https://docs.stripe.com/security)） |
| S | 公開キーの悪用（カードテスティング） | 公開キーで作れるものを限る。IP・キーごとのレート制限、[fraud.md](fraud.md) の 7 節 |
| T | 金額・通貨・状態の改ざん、一括代入 | Zod での入出力の検証、未知のフィールドの拒否。状態の遷移は Payments の関数だけが行う |
| T | 再送による二重の請求 | 3 層の冪等（ADR-0004） |
| R | 加盟店が操作を否認する | すべての書き込みの要求をリクエストのログ（要求 ID、キーの ID、IP）に残す。管理操作は監査ログ（ADR-0023） |
| I | 他の加盟店のデータ（IDOR） | キーからアカウントを解決し、RLS。存在しないものと権限がないものは同じ 404 |
| I | テストのキーで本番のデータ | キーの接頭辞でクラスタを振り分ける（ADR-0002） |
| D | 大量の要求、重いリスト取得 | レート制限と同時実行の制限（[rate-limiting.md](rate-limiting.md)）、ページングの上限 |
| E | 制限付きキーの権限を越える | 権限の判定を 1 か所に集める（[auth-and-keys.md](auth-and-keys.md)） |

### 3.2 Vault・CDE

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 本体になりすまして Connector Gateway・Vault Core を呼ぶ（または CDE になりすまして `connector-results` に偽の結果を送る） | PrivateLink のエンドポイントサービスが許可するプリンシパルを prod のアカウントだけに限り、mTLS のクライアント証明書で呼び出し元のサービスを確かめる。`connector-results` のキューのポリシーで送信元を cde-live・cde-test のロールだけに限る |
| S | 別の加盟店の `pm_` で決済する（confused deputy） | Connector Gateway が `account_id` と `pm_` の組の一致を Vault DB で確かめる |
| T | Elements の iframe・Checkout のスクリプトの改ざん（Web スキミング） | iframe は CDE のオリジンから配り、SRI と厳格な CSP。スクリプトの一覧と承認（要件 6.4.3）、改ざんの検知（要件 11.6.1）。日本でもカード情報を保持しない EC 加盟店での Web スキミングが課題とされている（[日本クレジット協会の資料](https://www.j-credit.or.jp/security/pdf/Creditcardsecurityguidelines_6.1_revisionpoint.pdf)） |
| R | 誰がいつ復号したか追えない | 復号ごとの記録を CDE の監査の系統へ（ADR-0023） |
| I | 保存した PAN の読み出し | エンベロープ暗号化。入口の役割は復号できない（ADR-0019）。Vault DB は本体から接続できない |
| I | ログ・ダンプへの PAN・CVC の出力 | フィールドの許可リスト、ログのマスキングと検知、コアダンプの無効化（[card-vault.md](card-vault.md) の 9 節） |
| I | 運用者による閲覧 | 常設の権限なし、JIT、PAN を平文で見る手段を作らない（ADR-0020） |
| D | Vault の入口への大量の要求 | WAF のレート制限と Challenge、Fargate の自動スケーリング |
| E | CDE のデプロイの経路の乗っ取り | CDE 専用の OIDC ロール（`environment:cde-*` と `cde-deploy.yml` に限定）、2 人の承認、本体の CI のロールを SCP で拒否（[ADR-0033](../decisions/0033-cde-pipeline-and-change-control.md)） |

### 3.3 Connector Gateway とコネクタ

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | アクワイアラになりすました応答（DNS の乗っ取り、中間者） | TLS の証明書の検証。アクワイアラが対応すれば証明書の固定か相互 TLS |
| T | 応答の改ざんで、失敗を成功に見せる | 応答の署名・MAC があれば検証する。結果は精算ファイルとの照合で確かめる（[payouts-and-reconciliation.md](payouts-and-reconciliation.md)） |
| I | 許可リストの外への PAN の送信（コードの不具合・悪意） | Egress の Network Firewall でドメインを許可リストに限る。許可リストの変更は CDE の変更の手続きを通す |
| I | コネクタのエラーのログに要求の本文が出る | 本文をログに出さない。エラーは結果コードだけ |
| D | アクワイアラの障害・遅延が決済の API を止める | 時限、サーキットブレーカー、振り分け（[payment-methods.md](payment-methods.md)） |
| R | アクワイアラとの間で、取引の有無が食い違う | 参照番号で照会し、精算で照合する（ADR-0004） |

### 3.4 Webhook の配信（外向きの送信）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | SSRF（加盟店の URL に内部のアドレスを指定する） | 本体・CDE とのピアリングや VPC エンドポイントを持たない egress VPC の Lambda から、NAT の固定 IP で送る。名前解決後の IP を検査し、プライベート・リンクローカル・ループバックを拒否。リダイレクトは追わない（[ADR-0025](../decisions/0025-webhook-signing-and-isolated-delivery.md)、Slack の ADR-0016） |
| S | 第三者が偽の Webhook を加盟店へ送る | エンドポイントごとの署名の秘密で HMAC-SHA256 の署名を付け、時刻を含める（本家の `Stripe-Signature` と同じ形式で、ヘッダー名は `<Brand>-Signature`）。署名は本体の VPC の中の webhook-sender で行い、送信の Lambda に秘密を渡さない（ADR-0025） |
| T | 再送攻撃 | 署名に時刻を含め、SDK の検証で許容の幅（5 分）を超えたものを拒否させる |
| I | 本文から個人情報が漏れる | 本文に PAN・CVC は入らない。HTTPS の URL だけを許可する（本番） |
| D | 遅い・応答しない送信先が配信を詰まらせる | 送信先ごとの同時実行の上限、時限、失敗が続く送信先の無効化と通知 |

### 3.5 ダッシュボードと Checkout

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | アカウントの乗っ取り（フィッシング、パスワードの使い回し） | MFA を全員に必須にし（[ADR-0008](../decisions/0008-api-keys-and-dashboard-access.md)）、パスキー・セキュリティキーを推奨する（本家も推奨している）。新しい端末からのログインを通知する |
| E | 乗っ取ったアカウントで入金先の口座を書き換える | 口座の変更は再認証と MFA、登録済みのメールへの通知、変更後の入金の停止（[merchant-onboarding.md](merchant-onboarding.md) の 5 節） |
| E | 権限の低いメンバーの越権（返金、キーの表示） | ロールの決定表（[auth-and-keys.md](auth-and-keys.md)）。返金・キーの発行・口座の変更・ルールの変更は監査ログに残す |
| T | XSS、CSRF、クリックジャッキング | Slack の security.md の 5 節と同じ（CSP、`SameSite`、`Origin` の検査、`frame-ancestors 'none'`） |
| T | Checkout のページに偽のカード欄を重ねる | Checkout のページのスクリプトも 6.4.3 と 11.6.1 の対象にする（[card-vault.md](card-vault.md) の 2 節） |
| I | 加盟店の顧客の個人情報の大量の持ち出し | エクスポートを監査ログに残す。一覧の API の上限 |
| R | 運用者（サポート）による加盟店のデータの閲覧 | 閲覧の理由の入力と監査ログ。加盟店のセキュリティの履歴に表示する |

### 3.6 CI/CD と AI エージェント

Slack の security.md の 3.10・3.11・7.3 節と同じ。加えて次のとおり。

- CDE のコードと IaC（`cde/`）の変更は、CDE のオーナー（Dev のテックリードとセキュリティの担当）の承認を必須にする（[ADR-0033](../decisions/0033-cde-pipeline-and-change-control.md)）。
- コーディングエージェントが書いたコードも、CDE のコードでは人間 2 人の承認を要する（要件 6.5.1 の変更の管理、6.2.3 のレビュー）。
- テストのデータにブランドのテスト用の番号以外のカード番号がないことを CI で検査する（Stripe の AGENTS.md の規則）。

## 4. 統制の一覧

| 領域 | 統制 | 確認方法 |
| --- | --- | --- |
| スコープ | CDE の別アカウント、2 経路、スコープの確認（要件 12.5.2、サービスプロバイダーは 6 か月ごとの 12.5.2.1） | 分割の検証（10 節）、スコープの文書の定期の見直し |
| カード情報 | トークン化、エンベロープ暗号化、CVC を残さない | [card-vault.md](card-vault.md)、PAN の形の走査 |
| テナント分離 | FORCE RLS、DB ロールの分離 | 性質ベーステスト（ADR-0002） |
| お金の正しさ | 台帳の制約、冪等 | ADR-0003・0004 の Confirmation |
| 認証 | API キーのハッシュ、制限付きキー、ダッシュボードの MFA | [auth-and-keys.md](auth-and-keys.md) |
| 運用者のアクセス | SSO＋MFA、本体は最小権限と break-glass、CDE は JIT | 四半期のアクセスレビュー、ADR-0020 の Confirmation |
| 暗号化 | TLS、KMS の CMK、CDE の鍵の階層 | 5 節、ADR-0019 |
| 監査 | 監査ログ、CloudTrail、CDE の復号の記録 | ADR-0023 |
| 秘密情報 | Secrets Manager とローテーション | 7 節 |
| Web | CSP、SRI、決済ページのスクリプトの管理と改ざんの検知 | 10 節 |
| 不正 | ルール、速度、リスト、3DS | [fraud.md](fraud.md) |
| 加盟店の審査 | KYC・KYB、制裁・反社の照合、継続的な監視 | [merchant-onboarding.md](merchant-onboarding.md) |
| 検知 | GuardDuty、Security Hub（PCI DSS の標準のチェック）、AWS Config、アプリのセキュリティイベント | [observability.md](observability.md) |
| 第三者 | アクワイアラ、3DS Server、eKYC・照合・不正検知の提供者の管理（要件 12.8） | 年 1 回の見直し、AOC・SOC 報告書の取得 |

## 5. 暗号化と鍵の管理

- **本体**：Slack の ADR-0017 と同じ方式にする。転送中はすべて TLS（内部も）、保存時はデータの種類ごとの KMS の CMK（`db`、`queue`、`files`、`audit`、`backup`、`secrets`、`logs`）。加えて、本人確認の書類の `kyc`、Webhook の署名の秘密の `webhook-secrets`（[events-and-webhooks.md](events-and-webhooks.md) の 7.3 節）を分ける。
- **CDE**：`cde-pan`（DEK を包む）、`cde-fp`（指紋の HMAC）、`cde-sad`（CVC の一時保管）と、CDE のストレージの鍵。役割ごとに使える操作を分ける（ADR-0019、[card-vault.md](card-vault.md) の 4・5 節）。
- DR のため、`db`・`backup`・`secrets`・`cde-pan`・`cde-sad` はマルチリージョンキー（東京と大阪）にする。
- 自動のローテーションは年 1 回（KMS の既定）。HMAC 鍵は手動（[card-vault.md](card-vault.md) の 5 節）。

## 6. 監査ログ

方針は ADR-0023。Slack の ADR-0018 の方式（操作と同じトランザクションで `audit_events` に追記し、log-archive の Object Lock のバケットへハッシュの連鎖で送る）を引き継ぐ。

| 系統 | 記録するもの | 置き場所 |
| --- | --- | --- |
| 加盟店の監査（`audit_events`） | ログイン、メンバーとロール、API キーの発行・表示・失効、入金先の口座の変更、返金、Dispute の提出、不正のルールとリストの変更、Webhook の送信先の変更、エクスポート、運用者による閲覧 | 本体の Aurora（テナントテーブル）→ log-archive |
| プラットフォームの監査（`platform_audit_events`） | 審査の判断、リザーブの設定、拒否・終了、プラットフォームのルールの変更、break-glass | 同上 |
| CDE の監査 | 復号（`card_ref`、目的、決済の試行の ID、呼び出し元）、カードの消去、JIT のセッションと入出力、鍵の操作 | CDE から Firehose で log-archive へ直接 |
| AWS の操作 | CloudTrail（組織の証跡） | log-archive |

- 加盟店は、ダッシュボードの「セキュリティの履歴」で自分のアカウントの記録を見られる（本家もセキュリティの履歴でログインや口座の変更を見せる）。プランによらない。
- PCI は監査ログを 12 か月以上保持し、直近 3 か月はすぐ分析できることを求める（要件 10.5.1）。保持期間は ADR-0023・0024。

## 7. 秘密情報の管理

| 秘密情報 | 保存 | ローテーション |
| --- | --- | --- |
| 加盟店の本番の秘密キー・制限付きキー | ハッシュだけ。表示は作成時の 1 回（[ADR-0008](../decisions/0008-api-keys-and-dashboard-access.md)） | 加盟店が行う。旧いキーを最大 7 日動かして入れ替える（ADR-0008） |
| Webhook の署名の秘密 | 署名に使うので可逆。KMS で暗号化して DB に置き、webhook-sender だけが復号できる（ADR-0025） | 加盟店が行う。旧い秘密を最大 24 時間残し、その間は署名を 2 つ付ける（ADR-0025） |
| DB の認証情報、内部の署名鍵 | Secrets Manager | Slack の ADR-0017 と同じ |
| 外部の提供者の API キー（eKYC、照合、不正検知、3DS Server） | Secrets Manager（3DS Server の鍵は CDE の Secrets Manager） | 90 日または提供者の上限 |
| mTLS の証明書 | AWS Private CA、ACM | 90 日 |

- 漏洩の疑いがあれば、周期を待たずに入れ替える（runbook の `key-rotation.md`。[runbooks/README.md](../runbooks/README.md)）。

## 8. サプライチェーンとデプロイの経路

Slack の security.md の 8 節と同じ（ロックファイル、Renovate の猶予期間、SHA で固定した Actions、SBOM、SLSA の来歴、シークレットスキャン）。加えて次のとおり。

- **CDE のデプロイは、本体と別の経路にする。** 詳細は [ADR-0033](../decisions/0033-cde-pipeline-and-change-control.md) と [delivery.md](delivery.md)。CDE 専用のワークフローと OIDC ロール、作成者と別の 2 人の承認と変更記録、デプロイの前の署名の検証。
- CDE のコンテナは、依存を最小にした別のイメージにする。ネイティブのアドオンを持つ依存を入れない。
- Elements の iframe の静的な成果物は、ハッシュを記録し、SRI の値と一致しないものを配らない。
- 支払いのページに読み込むスクリプトの一覧（第三者のものを含む）と、それぞれを載せる理由を持つ（要件 6.4.3）。Checkout に第三者の計測のスクリプトは入れない。

## 9. AI に固有のリスク

- コーディングエージェントの扱いは Slack の security.md の 7.3 節と同じ。本番・CDE・加盟店のデータ・カード番号に経路を持たない。
- 障害の調査にエージェントを使うときは、人間が取り出した、個人情報とカード番号を含まないログやメトリクスだけを渡す。
- 不正のルールを自然言語から作る補助（本家の Radar のアシスタントに相当）は MVP では作らない。作るときは、生成したルールを人が試験（[fraud.md](fraud.md) の 3.4 節）してから有効にする。

## 10. セキュリティの試験

| 種類 | 対象 | 頻度 | 合否 |
| --- | --- | --- | --- |
| SAST、シークレットスキャン、依存・イメージ・IaC の検査 | 全体 | PR、毎日 | Slack の security.md の 10 節と同じ |
| PAN の形の走査 | 本体のログ・DB・S3・SQS | CI（テストのデータ）、本番は毎日 | 検出 0 件（ADR-0005） |
| 外部の脆弱性スキャン（ASV） | インターネットに面した全部（API、Vault、Elements、Checkout、ダッシュボード） | 四半期ごとと大きな変更の後（要件 11.3.2） | ASV の合格 |
| 内部の脆弱性スキャン | CDE と、CDE に接続する系 | 四半期ごと（要件 11.3.1）。Inspector で常時 | High・Critical の解消 |
| ペネトレーションテスト | 外部と内部、アプリの層とネットワークの層 | 年 1 回と大きな変更の後（要件 11.4.1〜11.4.3） | Critical・High がすべて修正済み |
| 分割（セグメンテーション）の検証 | 本体・開発環境・log-archive から CDE への到達 | 6 か月ごとと分割の方式の変更の後（サービスプロバイダーの要件 11.4.6） | 許可した 2 経路（本体 → CDE の PrivateLink、CDE → 本体の SQS）以外に到達できない |
| 決済ページの改ざんの検知 | Elements の iframe、Checkout のページのスクリプトと HTTP ヘッダー | 少なくとも週 1 回（要件 11.6.1）。本システムでは配信のたびと 1 時間ごと | 未承認の変更で即時にアラート |
| 無線のアクセスポイントの検査 | 該当なし（社内に CDE の物理的な資産がない）。QSA に確認する | — | — |
| DAST | ステージング | 夜間とリリース前 | High 以上 0 件 |
| テナント分離・金額・冪等 | 性質ベーステスト | PR | ADR-0002・0003・0004 のとおり |
| 復号の権限 | IAM のポリシーの静的検査（`kms:Decrypt` を持つのは connector-gateway だけ）と、vault-ingest・vault-core の役割で `Decrypt` が失敗することの結合テスト | PR | ADR-0019 のとおり |

- 要件番号は PCI DSS v4.0.1 の原文で照合した（[card-vault.md](card-vault.md) の 10 節）。要件 11.4.6（サービスプロバイダーは分割の検証を 6 か月ごとと方式の変更の後）、10.5.1（12 か月の保持、直近 3 か月はすぐ分析できる）も原文で確かめた（2026-09-27）。
- 脆弱性の報告窓口（`security.txt`）を公開の時点で置く。バグバウンティは、本家も HackerOne で運用している。外部のペンテストで High 以上が 0 件になってから、招待制で始める。

## 11. 脆弱性の管理

Slack の security.md の 11 節の期限（Critical：緩和 24 時間・修正 7 日、High：30 日）を使う。加えて次のとおり。

- **カード番号の露出、テナント分離、お金の不正な移動につながる脆弱性は、CVSS にかかわらず Critical** とする。
- PCI は、Critical のセキュリティパッチを公開から 1 か月以内に当てることを求める（要件 6.3.3）。上の期限はこれより短い。

## 12. インシデントへの対応

- 手順は runbook の `security-incident.md` と `card-data-exposure.md`（どちらも E10 で作る。それまでは [incident-response.md](../runbooks/incident-response.md) の「カード番号の漏洩の疑い」）に書く。検知・封じ込め・根絶・復旧・振り返り、連絡先、証拠の保全を含む（要件 12.10）。
- **カード番号の漏洩の疑い**（または CDE の外での PAN の検出）のとき：

  | 順 | 行うこと |
  | --- | --- |
  | 1 | 封じ込め：該当の経路（Vault の入口、Connector Gateway、配信のスクリプト）を止めるか切り替える。証拠（ログ、スナップショット）を保全し、log-archive の記録を固定する |
  | 2 | 影響の範囲：CDE の監査の記録で、該当の期間の `card_ref` と加盟店を特定する |
  | 3 | 報告（期限は契約とブランドの規則で確定する）：アクワイアラ、カードブランド（アクワイアラ経由）。Visa は疑いか確認の時点から 3 暦日以内（[What To Do If Compromised](https://usa.visa.com/dam/VCOM/download/merchants/cisp-what-to-do-if-compromised.pdf) v10.0）。Mastercard は把握から 24 時間以内（Security Rules and Procedures の 10.3.1。原本は取得できず、検索の抜粋で確認）。JCB は未検証。2026-09-27 に確認。ブランドが求めれば PCI の認定の調査会社（PFI）の調査を受ける |
  | 4 | 報告（法令。法務が判断）：個人情報保護委員会。クレジットカード番号だけの漏洩でも「不正に利用されることにより財産的被害が生じるおそれがある個人データの漏えい等」に当たると考えられ、件数によらず報告の対象になる（[個人情報保護委員会の FAQ](https://www.ppc.go.jp/all_faq_index/faq1-q6-12_/)）。速報は概ね 3〜5 日以内、確報は 30 日以内（不正の目的によるものは 60 日以内）。割賦販売法の上の報告の要否と先も法務が判断する |
  | 5 | 通知：影響を受けた加盟店。本人（カード会員）への通知の方法は、加盟店・アクワイアラと調整する（このシステムが委託先か本人に対する事業者かで、義務を負う者が変わる。法務の確認） |
  | 6 | 鍵のローテーション（[card-vault.md](card-vault.md) の 5 節）、該当のカードのブロックリストへの追加 |

- 検知の源：GuardDuty、Security Hub、PAN の形の走査の検出、改ざんの検知（11.6.1）、不正の急増（[fraud.md](fraud.md) の 9 節）、アクワイアラ・ブランドからの共通の不正利用の地点（CPP）の連絡、外部からの報告。
- インシデントの対応の計画は年 1 回試験する（要件 12.10.2）。訓練は runbooks の訓練の予定に入れる。

## 13. データのライフサイクル

方針は ADR-0024。ここには全体の一覧を書く。**法定の保存期間はすべて法務の確認が要る。**

| データ | 保持 | 期限後 |
| --- | --- | --- |
| カード番号（Vault） | [card-vault.md](card-vault.md) の 6 節（未使用 30 日、保存済みは外すまで、期限切れで 13 か月未使用まで） | 物理削除 |
| CVC | 最初のオーソリまで（最長 30 分） | 取り出しと同時に消す |
| 決済・返金・Dispute・入金の記録 | 取引の年度の終わりから 7 年（税法上の帳簿書類の保存の考え方に合わせる） | 個人情報を消し、金額と ID だけを残す |
| 台帳の仕訳 | 10 年（欠損金の繰越を考え、長い方に合わせる） | 削除（パーティションの `DROP`） |
| 加盟店の顧客の情報（Customer） | 加盟店が消すまで。加盟店の削除で PaymentMethod も外す | 取引の記録の側の個人情報は、上の 7 年に従う |
| 本人確認の記録（書類、結果） | 取引の終了から 7 年（犯収法の確認記録の保存期間に合わせる。適用の有無は法務） | 書類の削除。結果の要約だけを残すかは法務 |
| 不正の評価の記録 | 2 年（Dispute の期限と、ルールの試験に使う期間） | 属性（メール、IP）を消す |
| 監査ログ（加盟店・プラットフォーム） | DB に 1 年、アーカイブに 7 年 | ADR-0023 |
| CDE の監査・ログ | 直近 120 日（3 か月以上）はすぐ検索できる場所、13 か月まで S3（[observability.md](observability.md) の 4.4 節） | 削除 |
| 冪等キー | 24 時間以上・48 時間以内（日ごとのパーティションを 48 時間で `DROP`。[api.md](api.md) の 7.2 節） | 自動（ADR-0004） |
| コネクタの通知の生データ（`connector_inbox`） | 13 か月（照合と監査。PCI の 12 か月に余裕を持たせる。[ADR-0014](../decisions/0014-connector-inbox.md)） | 削除 |
| 要求のログ（`api_request_logs`） | 30 日（メタデータだけ。[auth-and-keys.md](auth-and-keys.md) の 9.2 節） | 削除 |
| Event（API で取得） | 30 日（本家と同じ） | 削除 |
| アプリのログ（本体） | CloudWatch Logs に 120 日、log-archive に 13 か月（PAN・秘密情報を含めない。[observability.md](observability.md) の 4.4 節） | 自動 |
| テスト環境のデータ | 加盟店が消すまで、またはアカウントの終了から 30 日 | 削除 |
| バックアップ | 35 日 | 期限で消える（削除の最終的な期限） |

- リーガルホールドは、保持の期限に優先する（Slack の ADR-0019 と同じ考え方）。
- 加盟店のアカウントの終了では、決済の記録と台帳は法定の期間まで残し、ダッシュボードのメンバーの個人情報は終了から 30 日で消す。

## 14. コンプライアンス

| 対象 | 立場 | 主な対応 |
| --- | --- | --- |
| PCI DSS v4.0.1 | サービスプロバイダー（レベル 1 の設計） | QSA による ROC、AOC の加盟店への提供、責任分担の表（要件 12.9）、ASV スキャン |
| 割賦販売法 | 締結事業者に当たるかは法務の確認 | 加盟店調査の仕組み（[merchant-onboarding.md](merchant-onboarding.md)）、カード番号の適切な管理、不正利用の対策。クレジットカード・セキュリティガイドライン（6.1 版。2026-09-27 に現行の版であることを確認）を実務の指針として参照する |
| 犯罪収益移転防止法 | 特定事業者に当たるかは法務の確認（資金決済法の位置づけと一体） | 当たる前提の水準で確認と記録の保存を設計する |
| 個人情報保護法 | 加盟店の顧客の情報は加盟店からの委託として扱うか、自ら取得するかを法務が確認 | 国内（東京・大阪）に置く。漏えい等の報告（12 節）。外国にある第三者（海外の提供者）の一覧 |
| SOC 2 | — | 本家は SOC 1・SOC 2 Type II を毎年受ける。本システムでは PCI の証跡と共通にし、時期は PM が決める |

## 15. Epic との対応

| Epic | Story の候補 |
| --- | --- |
| E1 | 本体・CDE・log-archive のアカウントと境界、PAN の形の走査の CI |
| E2 | API キーのハッシュ保存と制限付きキー、ダッシュボードの MFA、加盟店のセキュリティの履歴 |
| E5 | Webhook の配信の隔離と署名 |
| E6 | 決済ページのスクリプトの管理（6.4.3）と改ざんの検知（11.6.1）、CSP・SRI |
| E10 | ASV・ペンテスト・分割の検証の実施、監査ログのアーカイブと検証、インシデント対応の訓練、QSA の審査の準備、保持のジョブ |

## 16. 持ち越し

- 法務の確認待ちのもの（割賦販売法・犯収法・個人情報保護法の上の立場、漏えいの報告、財務の記録の保存期間）は、[intent.md](../intent.md) の「法務の確認待ち」にまとめた。結論が出るまで、13 節の期間は既定案として扱う。
- QSA の選定：E10 の着手時に、[intent.md](../intent.md) の「接続先の選定（法務以外）」の条件で選ぶ。最初の審査（ROC）は、本番の加盟店を受け入れる前に受ける（2026-09-28 に確定）。
- カードブランド・アクワイアラへの漏洩の報告の期限と手順：最初のアクワイアラとの契約（E3 の接続先の選定）で確定する。

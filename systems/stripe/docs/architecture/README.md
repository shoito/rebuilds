# Architecture: Stripe

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルにある。

| ファイル | 領域 |
| --- | --- |
| [api.md](api.md) | 公開 API：リソース、版、冪等、ページング、エラー、SDK、テスト環境 |
| [auth-and-keys.md](auth-and-keys.md) | 加盟店のアカウント、ダッシュボードのログイン、API キー、権限 |
| [payments.md](payments.md) | PaymentIntent の状態遷移、オーソリ・キャプチャ・取り消し、返金、3D セキュア |
| [payment-methods.md](payment-methods.md) | 決済手段（カード、コンビニ払い、銀行振込）と、決済代行・アクワイアラのコネクタ |
| [disputes.md](disputes.md) | チャージバック、証拠の提出、結果の反映 |
| [ledger.md](ledger.md) | 複式簿記の台帳、残高、手数料、通貨 |
| [payouts-and-reconciliation.md](payouts-and-reconciliation.md) | 入金（Payout）、精算ファイルとの照合、会計のレポート |
| [card-vault.md](card-vault.md) | カード情報の保管とトークン化、CDE（カード情報を扱う領域） |
| [fraud.md](fraud.md) | ルールによる不正検知、3D セキュアの要否の判断 |
| [merchant-onboarding.md](merchant-onboarding.md) | 加盟店の審査、本人確認、リスクの見直し |
| [events-and-webhooks.md](events-and-webhooks.md) | Event、Webhook の配信と署名 |
| [checkout.md](checkout.md) | ホスト型の決済ページと、埋め込み型の入力部品 |
| [dashboard.md](dashboard.md) | 加盟店向けのダッシュボード |
| [security.md](security.md) | 脅威モデル、PCI DSS の統制、暗号化、監査ログ、データのライフサイクル |
| [data-model.md](data-model.md) | データモデルの索引 |
| [infrastructure.md](infrastructure.md) | AWS の構成、アカウント、ネットワーク、冗長化、災害復旧 |
| [observability.md](observability.md) | ログ、メトリクス、トレース、SLO |
| [capacity.md](capacity.md) | 負荷のモデル、部品ごとの必要量、パラメーター |
| [delivery.md](delivery.md) | CI/CD、リリース、フィーチャーフラグ |
| [rate-limiting.md](rate-limiting.md) | レート制限と同時実行の制限 |

## 1. 全体構成

```
加盟店のサーバー ──HTTPS──▶ API（api.<domain>）─────────────┐
加盟店の顧客のブラウザ ──▶ Checkout・Elements ──▶ Vault API ─┐ │
                                                             │ │
┌──────────────────────── CDE（別の AWS アカウント）───────┐ │ │
│  Vault：カード番号の受け取り・トークン化・保管・復号       │◀┘ │
│  Connector Gateway：アクワイアラへ送る要求の組み立て       │    │
└──────────────────────────────────────────────────────────┘    │
            ▲ トークンだけで呼ぶ                                  │
┌──────────── 本体（CDE の外）────────────────────────────────┐ │
│  API ──▶ Payments（状態遷移）──▶ Ledger（複式簿記）          │◀┘
│    │        │                      │                          │
│    │        └──▶ Fraud（ルール）    └──▶ Payouts・照合         │
│    └──▶ outbox ──▶ Events ──▶ Webhook の配信（外向き送信）    │
│  Dashboard・Checkout のバックエンド                            │
└──────────────────────────────────────────────────────────────┘
```

| コンポーネント | 責務 |
| --- | --- |
| API | 認証（API キー）、冪等、版の変換、入力の検証、レート制限 |
| Payments | PaymentIntent・Refund の状態遷移。コネクタへの要求と結果の反映 |
| Ledger | すべてのお金の動きを、借方と貸方が一致する仕訳として追記する。残高はここから求める |
| Vault（CDE） | カード番号を受け取り、トークンに置き換えて保管する。アクワイアラへの送信のときだけ復号する |
| Connector Gateway（CDE） | 決済代行・アクワイアラごとの差を吸収する。カード番号を扱うので CDE に置く |
| Fraud | 決済の前にルールで判定し、3D セキュアの要否を決める |
| Payouts・照合 | 加盟店への入金と、決済代行の精算ファイル・銀行の明細との照合 |
| Events・Webhook | 状態の変化を Event として記録し、加盟店の URL へ署名付きで配る |

原則は 3 つ。

- **カード番号は CDE の外に出さない。** 本体はトークンだけを扱い、PCI DSS の対象を CDE に閉じ込める（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）。
- **お金の正本は台帳。** 残高・入金額・手数料は、台帳の仕訳から求める。状態のテーブルの数値を正としない（[ADR-0003](../decisions/0003-double-entry-ledger.md)）。
- **すべての書き込みは冪等。** 加盟店の再送、内部の再試行、コネクタの再送のどれでも、お金は 1 回しか動かない（[ADR-0004](../decisions/0004-idempotency.md)）。

## 2. 規模の段階

| 段階 | 決済の確定（ピーク） | 加盟店 | 構成 |
| --- | --- | --- | --- |
| S1（MVP） | 500 件/秒 | 1 万 | 1 リージョン（東京）・3 AZ。Aurora の writer 1 台＋reader。CDE は東京の別アカウント |
| S2 | 5,000 件/秒 | 10 万 | 台帳の書き込みを加盟店のハッシュで分割（シャード）する。Webhook の配信を独立したクラスタにする |
| S3 | 50,000 件/秒（年末商戦の急増を含む） | 100 万 | セル構成。大阪と東京の両方で決済を受ける。大口の加盟店に専用のセル |

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 決済の API の可用性 | 月間 99.99% | S3 で 99.995% |
| NFR-002 | API の処理時間（コネクタの待ちを除く） | p99 300ms 以内 | コネクタの応答時間は別に計測する |
| NFR-003 | 耐久性 | 成功を返した決済・返金・入金・仕訳は失わない | |
| NFR-004 | 冪等性 | 同じキーの要求は、24 時間のあいだ最初の結果を返す | 本家と同じ |
| NFR-005 | 台帳の正しさ | すべての仕訳で借方と貸方が一致する。精算との不一致は T+2 営業日までに 0 件 | |
| NFR-006 | Webhook の配信 | 最初の配信の p95 10 秒以内。失敗は 3 日間、指数的に再試行する | 本家に寄せる |
| NFR-007 | 復旧（AZ の障害） | RPO 0、RTO 5 分以内 | |
| NFR-008 | 復旧（リージョンの障害） | RPO 1 分以内（失った範囲はコネクタの記録で照合して回復）、RTO 1 時間以内 | |
| NFR-009 | テナント分離 | 他の加盟店のデータが見える事象は 0 件 | |
| NFR-010 | PCI DSS | v4.0.1 のサービスプロバイダー レベル 1 の要件を満たす設計 | 監査は別途 |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（API・サービス・Web） | Slack と同じ。型で API の契約と金額の型を守る（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| 金額 | 通貨ごとの最小単位の整数（`bigint`）と、ISO 4217 の通貨コード | 浮動小数点を使わない。JPY は小数なし |
| API | Hono＋Zod。公開 API は `@hono/zod-openapi` で OpenAPI を出す | |
| DB | Aurora PostgreSQL 18。台帳は追記のみのテーブルと制約で守る | |
| 非同期 | transactional outbox → SQS | Slack と同じ |
| CDE | 別の AWS アカウント。暗号鍵は KMS（CDE 専用の鍵）。必要に応じて AWS Payment Cryptography | [ADR-0005](../decisions/0005-pci-scope-segmentation.md) |
| 実行基盤 | AWS（ECS Fargate、Aurora、SQS、S3、CloudFront） | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| IaC | Terraform | Slack と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs | Slack と同じ |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 実行基盤と技術は Slack の決定を引き継ぐ。金額は最小単位の整数で扱う |
| [0002](../decisions/0002-account-tenancy.md) | 加盟店のアカウントをテナントにし、共有スキーマと RLS で分ける。テスト環境と本番環境をデータで分ける |
| [0003](../decisions/0003-double-entry-ledger.md) | お金の正本は、追記のみの複式簿記の台帳 |
| [0004](../decisions/0004-idempotency.md) | すべての書き込みを冪等にする |
| [0005](../decisions/0005-pci-scope-segmentation.md) | カード情報は CDE（別の AWS アカウント）に閉じ込め、本体はトークンだけを扱う |

領域ごとの ADR は、各文書から参照する。

## 6. リスクと未解決事項

- **コネクタの先の障害**：決済の成否は決済代行・アクワイアラに依存する。タイムアウトした要求の結果が分からない状態（オーソリが通ったか不明）を、どう回復するかが最大の難所である（[payments.md](payments.md)）。
- **台帳の書き込みのホットスポット**：大口の加盟店の残高の口座に書き込みが集中する（[ledger.md](ledger.md)）。
- **法令**：資金決済法の上の位置づけは、法務の確認待ち（[intent.md](../intent.md)）。

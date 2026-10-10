# Roadmap: Shopify

## 進め方の原則

- **最初に walking skeleton を通す。** E1・E2・E3・E5・E6・E8・E11 の最小の部分で、ショップの開設 → 商品の登録 → ストアフロントの表示（エッジのキャッシュ）→ カート → チェックアウト（在庫の引き当て）→ 提供者の模型の決済 → 注文 → Webhook を端から端まで貫き、1 つのショップで 1 つの商品が買えるところまで作ってから、機能を広げる。ポッドの振り分け、FORCE RLS、在庫の不変条件と CHECK 制約、`completeCheckout` と一意の制約、価格の写し、テーマの言語の上限、キャッシュの鍵のショップは、最初から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E2 の前：ショップの移し替えの停止の時間と論理デコードの方法（`shop-move-poc`）。
  - E5 の前：熱い品目の枠の数と 1 行の更新の上限（`inventory-hot-row-poc`）。
  - E11 の前：テンプレートの描画の速さと歩数の上限（`theme-renderer-poc`）。
  - E12 の前：世代の番号の伝わるまでの時間（`edge-cache-generation-poc`）。
  - E15 の前：関数の実体化と実行の時間、燃料の上限（`wasm-function-poc`）。
- **規則は 1 つのコードに。** 在庫の数の変更は `packages/inventory`、チェックアウトの遷移と注文の作成は `packages/checkout`、税は `packages/tax`、割引は `packages/discounts`、テーマの言語は `packages/loom`、費用の計算は `packages/graphql-cost`、キャッシュの鍵は `packages/edge-keys` にだけ書く。
- **契約を先に固定する。** チェックアウトの状態と完了の決定表、在庫の不変条件、税の端数処理の規則、割引の組み合わせの決定表、テーマの言語の文法と IR、関数の入出力と上限、Admin API のスキーマと費用、Webhook の署名、提供者のアダプターの契約は、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L10）。下の表で「法務：L*」と書いた Story が当たる。
- **フラッシュセールを早く試す。** 負荷の生成器を E5 で作り、縮めた規模のフラッシュセールの場面を、E5 から夜間に流し続ける。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（TypeScript と Rust、参照の実装の枠）、ポッドのモジュール、全体の面、Aurora と RLS、エッジ、フラグ、監査ログ、大阪の骨格 | 設計中 |
| E2 ショップとポッド | ショップの開設、プラン、ドメインと TLS、ディレクトリと振り分け、ショップの移し替え、ポッドの中の上限 | 未着手（前に移し替えの PoC。開設の審査は法務：L8・L10） |
| E3 カタログと価格 | 商品、バリエーション、オプション、コレクション、メディア、メタフィールド、マーケットと通貨、CSV | 未着手（比較の価格は法務：L2、商品の区分は法務：L10） |
| E4 税とインボイス | 税の区分、総額表示、税率ごとの端数処理、按分、レシート、登録番号 | 未着手（全 Story が法務：L4） |
| E5 在庫と引き当て | 拠点、在庫の状態、引き当て・確定・戻し、枠の行、照合、負荷の生成器 | 未着手（前に熱い行の PoC） |
| E6 カートとチェックアウト | カート、状態の機械、配送先、送料、価格の写し、最終確認画面、注文の作成、照合 | 未着手（最終確認画面は法務：L1） |
| E7 割引のエンジン | 割引の種類、対象、組み合わせの規則、按分、使用の回数 | 未着手（割引の表示は法務：L2） |
| E8 決済の連携 | アダプターの契約、提供者の選定と連携、日本の決済手段、返金、照合 | 未着手（決済の範囲は法務：L7） |
| E9 注文と配送 | 注文のライフサイクル、配送の指示、送料の表、配送の日時、送り状、運送会社 | 未着手 |
| E10 返品と返金 | 返品、返金の計算、在庫への戻し、返還インボイス | 未着手（返還インボイスは法務：L4） |
| E11 ストアフロントのテーマ | テーマの言語、レンダラー、セクションとブロック、テーマの編集、既定のテーマ、特定商取引法の表示 | 未着手（前にレンダラーの PoC。文法は法務：L9、表示は法務：L1、計測は法務：L6） |
| E12 Storefront API とキャッシュ | Storefront API、エッジのキャッシュと無効化、在庫の部品、SEO | 未着手（前に世代の番号の PoC） |
| E13 フラッシュセール | セールの予定、待合室、許可証、ボット対策、隔離のポッド | 未着手 |
| E14 アプリの基盤 | アプリの登録、OAuth とスコープ、Admin API、一括の操作、Webhook、埋め込み、アプリの課金 | 未着手（顧客のデータのスコープは法務：L3、課金は法務：L5、スキーマは法務：L9） |
| E15 関数の砂場 | 関数の種類、入力のクエリ、モジュールの検査と翻訳、`function-runner`、失敗の扱い | 未着手（前に関数の PoC） |
| E16 検索とおすすめ | 検索の索引、日本語、絞り込み、予測の検索、関連の商品 | 未着手 |
| E17 管理画面・スタッフ・監査 | 管理画面、スタッフと権限、SSO、監査ログ、顧客のデータの削除 | 未着手（削除は法務：L3） |
| E18 本番の準備と GA の判定 | 負荷試験、フラッシュセールの試験、DR の訓練、外部のペンテスト、GA の判定 | 未着手（GA の判定は法務：L1・L3・L4・L7・L8） |
| E19 ギフトカードとポイント（MVP の後） | ギフトカード、ストアクレジット、ポイント | 未着手（MVP の後。法務：L5） |
| E20 定期購入（MVP の後） | 定期購入、繰り返しの決済 | 未着手（MVP の後。法務：L1） |
| E21 POS（MVP の後） | 実店舗の販売、店舗の在庫の即時の同期 | 未着手（MVP の後） |
| E22 越境と海外のリージョン（MVP の後） | 海外への販売、関税、外貨のマーケットの有効化（仕組みは E3 で作る）、海外のリージョン | 未着手（MVP の後。法務：L3・L4） |
| E23 B2B と販売のチャネル（MVP の後） | 卸の価格、掛け売り、モール・SNS の連携 | 未着手（MVP の後） |

E1〜E18 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書（[architecture/README.md](architecture/README.md) の 7 節）の「Story の候補」と、2026-10-10 の統合の工程で揃えた。「統合の工程で足した」は、領域の文書が提案した Story である。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Shopify の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`packages/inventory`・`checkout`・`tax`・`loom`、`crates/function-runner` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント（本番、検証、見張りの別のアカウント）、SCP、VPC、egress の経路（Webhook の送信、提供者・運送会社への接続） |
| `pod-terraform-module` | ポッドの Terraform のモジュール（Aurora、Valkey、SQS、ECS のサービス、ALB）（ADR-0002） |
| `global-plane-baseline` | 全体の面の Aurora、`shop-directory` の骨格 |
| `edge-baseline` | CloudFront、WAF、CloudFront Functions と KeyValueStore の骨格、TLS |
| `aurora-rls-baseline` | ポッドの DB の RLS、`SET LOCAL app.shop_id`、RLS の検査、RLS の外の表の許可リスト（ADR-0003） |
| `outbox-and-relay` | outbox、`relay`、SNS・SQS の話題 |
| `ci-pipeline-baseline` | PR の関門、TypeScript と Rust、参照の実装の枠、試験のベクトル、ファジングの夜間、テストの緩和の検出、依存の禁止の一覧（ADR-0001） |
| `flags-appconfig` | `release.*`・`ops.*` のフラグ |
| `observability-baseline` | OpenTelemetry、ショップ・ポッドのラベル、ダッシュボードの骨格、`canary` の骨格 |
| `audit-log-table-and-archive` | 監査ログの表と、S3 の Object Lock への写し |
| `osaka-warm-standby` | 大阪の骨格、Aurora Global Database、S3 の写し |
| `kms-keys-and-column-encryption`（統合の工程で足した） | KMS の鍵の配置と列の封筒の暗号、HMAC の索引（ADR-0066） |
| `retention-policies-and-legal-holds`（統合の工程で足した） | 保持の表と法的な保全の印（ADR-0068）。期間は法務：L3・L4 |
| `operator-access-and-break-glass`（統合の工程で足した） | 運用者のアクセス、2 人の承認の break-glass（ADR-0068） |
| `pod-wave-deploy`（統合の工程で足した） | ポッドの波のデプロイと自動のロールバック（ADR-0075） |
| `pod-migrator`（統合の工程で足した） | 全ポッドのスキーマの移行（広げる・埋める・縮める）（ADR-0075） |

### E2 ショップとポッド

| Story | 内容 |
| --- | --- |
| `shop-move-poc` | PoC：論理デコードでショップの変更を拾う方法、負荷の下の停止の時間 |
| `shop-signup-and-plans` | ショップの開設、プラン、既定のドメイン。開設の審査は法務：L8・L10 |
| `custom-domains-and-tls` | 独自のドメイン、DNS の確かめ、TLS の証明書の自動の発行と更新 |
| `shop-directory-and-routing` | ディレクトリ、KeyValueStore の熱い集まりと `edge-router`、経路 P5、ポッドの ID の不一致の 421（ADR-0002、ADR-0010） |
| `shop-placement` | 新しいショップのポッドの選び方 |
| `shop-mover` | コピー、追いかけ、停止と照合、切り替え、15 分の中継の窓、7 日の後の削除（ADR-0002、ADR-0012） |
| `per-shop-limits` | ポッドの中のショップごとの同時実行・速さの上限（ADR-0003） |
| `shop-lifecycle-and-deletion`（統合の工程で足した） | ショップのライフサイクルと削除の作業、保持の対象（ADR-0013）。保持の範囲は法務：L3・L4 |
| `shop-onboarding-review`（統合の工程で足した） | ショップの開設の審査の枠。法務：L8・L10 |

### E3 カタログと価格

| Story | 内容 |
| --- | --- |
| `products-and-variants` | 商品、バリエーション、オプション（3 つまで）、SKU、重さ |
| `collections` | 手動と条件のコレクション、並べ方 |
| `media-and-images` | 画像・動画の受け取り、変換、CloudFront での配信 |
| `metafields` | メタフィールドの定義と値 |
| `publishing` | 販売の公開の設定、予約の公開 |
| `markets-and-currencies` | マーケット、表示と支払いの通貨の仕組み、固定の価格と換算・丸め（ADR-0015）。外貨のマーケットの有効化は `release.markets-foreign-currency` の裏（仮の決定、PM の判断待ち。E22 と法務：L4） |
| `compare-at-price` | 比較の価格。表示の条件は法務：L2 |
| `product-csv-import-export` | CSV の取り込みと書き出し（一括の操作） |
| `product-categories-and-restrictions` | 商品の区分、扱いに許可の要る品目の印。範囲は法務：L10 |

### E4 税とインボイス

| Story | 内容 |
| --- | --- |
| `tax-categories` | 税の区分（10%・8%・非課税）、商品・送料・手数料の区分。法務：L4 |
| `tax-calculation-and-rounding` | 税率ごとの端数処理、方法の選択、按分、`tax-ref`。法務：L4 |
| `tax-inclusive-pricing` | 総額表示、税込みの価格からの計算。法務：L4 |
| `invoice-registration-number` | 適格請求書発行事業者の登録番号の入力と確かめ。法務：L4 |
| `receipts-qualified-simplified-invoice` | レシート（適格簡易請求書）の発行と記載。法務：L4 |

### E5 在庫と引き当て

| Story | 内容 |
| --- | --- |
| `inventory-hot-row-poc` | PoC：枠 1・8・32・64 の引き当ての速さと p99 |
| `locations` | 拠点、拠点の優先の順 |
| `inventory-levels-and-states` | 拠点 × 品目の数と状態、不変条件、調整と移動の履歴（ADR-0004） |
| `reservations-and-commit` | 引き当て・確定・戻し、期限、掃除の処理（ADR-0004） |
| `inventory-slots` | 枠の行、枠の選び方、枠の直しと統合 |
| `inventory-reference-and-props` | `inventory-ref` と並行の性質ベーステスト（quality.md の 2.2.1 節 A） |
| `inventory-reconciliation` | 毎時の照合と、不一致の通知 |
| `load-generator` | 負荷の生成器と、縮めた規模のフラッシュセールの夜間の場面（quality.md の 2.2.1 節 H） |
| `inventory-location-selection`（統合の工程で足した） | 拠点の選び方とロックの順（ADR-0022） |
| `inventory-movements`（統合の工程で足した） | 移動の履歴（追記の行）（ADR-0023） |

### E6 カートとチェックアウト

| Story | 内容 |
| --- | --- |
| `cart` | カート（Valkey が正本、14 日。ログインした買い手のカートだけ 30 分ごとに DB の `saved_carts` へ写す）、行、数、カートの属性（ADR-0028） |
| `checkout-state-machine` | 状態と遷移、遷移の記録（ADR-0005） |
| `shipping-address-and-methods` | 配送先（日本の住所の形、郵便番号からの補完）、配送の方法と送料の計算の呼び出し |
| `price-snapshot` | 価格の写しと、表示・注文・決済の金額の一致 |
| `final-confirmation-screen` | 最終確認画面。出す事項は法務：L1 |
| `complete-checkout` | `completeCheckout`、決定表 DT-CHK-001、一意の制約（ADR-0005） |
| `checkout-reconciler` | 1 分ごとの照合、15 分超のアラート |
| `checkout-simulator` | `psp-sim` と完了の性質ベーステスト（quality.md の 2.2.1 節 B） |
| `order-confirmation-email` | 注文の確認のメール |
| `checkout-submit-idempotency`（統合の工程で足した） | 送信の冪等キーと 24 時間の応答の保持 |
| `checkout-admission-limits`（統合の工程で足した） | チェックアウトの入口の同時実行と作成の速さの上限（ADR-0031） |
| `checkout-csp-and-script-integrity`（統合の工程で足した） | チェックアウトのページの CSP とスクリプトの目録（ADR-0067） |
| `customer-accounts`（統合の工程で足した） | 買い手のアカウント（メールの 1 回だけのコード） |

### E7 割引のエンジン

| Story | 内容 |
| --- | --- |
| `discount-types` | 金額・率・送料無料・まとめ買い、対象、期間 |
| `discount-codes-and-automatic` | コードと自動の割引、使用の回数の上限（熱い行は枠） |
| `discount-combination-rules` | 組み合わせの決定表、適用の順序、按分と端数 |
| `discount-reference-and-props` | `discount-ref` と決定性の性質（quality.md の 2.2.1 節 C） |
| `discount-display` | 割引の表示。表示の条件は法務：L2 |
| `discount-function-merge`（統合の工程で足した） | 関数の割引の提案の検証と合わせ（ADR-0008、ADR-0032） |

### E8 決済の連携

| Story | 内容 |
| --- | --- |
| `payment-adapter-contract` | アダプターの契約、冪等キー、契約の試験（ADR-0006） |
| `payment-provider-selection` | 提供者の選定（照会の API、冪等、日本の決済手段、Webhook）。範囲は法務：L7 |
| `payment-webhook-inbox` | Webhook の署名の検証、inbox、処理のジョブ |
| `card-payments` | カード（ホストした入力部品・リダイレクト）、オーソリと確定 |
| `konbini-and-bank-transfer` | コンビニ払いと銀行振込、支払い待ちの注文、期限切れの取り消し |
| `carrier-billing-and-bnpl` | キャリア決済と後払い |
| `refunds-and-voids` | 返金と取り消し、`refund_required` の処理 |
| `payment-reconciliation-daily` | 提供者の取引の一覧との日次の突き合わせ |
| `payment-inquiry-and-circuit-breaker`（統合の工程で足した） | 照会の予定と、手段ごとの遮断器（ADR-0036） |
| `card-testing-controls`（統合の工程で足した） | カードテストの上限と自動のチャレンジ（ADR-0067） |

### E9 注文と配送

| Story | 内容 |
| --- | --- |
| `order-lifecycle` | 注文の状態、編集、キャンセル、メモとタグ |
| `fulfillment-orders` | 配送の指示、拠点の振り分け、分割の配送 |
| `shipping-rate-tables` | 送料の表（都道府県、重さ・サイズ、無料の閾値） |
| `delivery-date-time` | 配送の日時の指定 |
| `carrier-csv` | 3 社の送り状の CSV の書き出しと、追跡の番号の取り込み |
| `carrier-api-integration` | 選定した 1 社の API（送り状、追跡） |
| `shipping-notifications` | 発送の通知 |

### E10 返品と返金

| Story | 内容 |
| --- | --- |
| `returns` | 返品の受け付け、理由、状態 |
| `refund-calculation` | 返金の額（一部、送料、割引の戻し）と税 |
| `restock-on-return` | 在庫への戻し |
| `return-invoices` | 返還インボイス。法務：L4 |

### E11 ストアフロントのテーマ

| Story | 内容 |
| --- | --- |
| `theme-renderer-poc` | PoC：IR のインタープリターの速さ、歩数の上限の値 |
| `loom-grammar-and-parser` | 文法の定義、字句解析と構文解析、試験のベクトル（ADR-0007）。文法の確定は法務：L9 |
| `loom-ir-and-interpreter` | IR、インタープリター、歩数、上限、データの先読み |
| `loom-drops-and-filters` | drop のスキーマとフィルターの一覧 |
| `loom-fuzzing` | ファジングとエスケープの性質（quality.md の 2.2.1 節 E） |
| `sections-and-blocks` | セクションとブロック、テーマの定義、セクションの隔離 |
| `theme-editor` | テーマの編集の画面、プレビュー |
| `default-themes` | 既定のテーマ 2 つ。在庫の残りの表示は法務：L2 |
| `legal-pages` | 特定商取引法の表示のページ、プライバシーの方針のひな形。法務：L1・L3 |
| `storefront-analytics` | ストアフロントの計測。外部送信規律は法務：L6 |
| `loom-ir-retranslation`（統合の工程で足した） | IR のバージョンを上げるときの翻訳し直しと比べ（ADR-0076） |

### E12 Storefront API とキャッシュ

| Story | 内容 |
| --- | --- |
| `edge-cache-generation-poc` | PoC：KeyValueStore の世代の番号の伝わるまでの時間 |
| `storefront-api` | Storefront API（GraphQL）、公開と秘密のトークン、ボットの絞り込み |
| `edge-cache-keys` | キャッシュの鍵の組み立て（`packages/edge-keys`）と性質 |
| `cache-invalidation` | 世代の番号、`cache-invalidator` |
| `dynamic-inventory-widget` | 在庫と価格の部品 |
| `seo-basics` | サイトマップ、構造化データ、正規の URL、リダイレクト、`robots.txt` |
| `edge-function-canary-distribution`（統合の工程で足した） | 見張りの配信 `mtd-canary` でのエッジの関数の先出し |
| `rum-and-canary`（統合の工程で足した） | 実ユーザーの計測と外からの見張り（ADR-0073）。計測は法務：L6 |

### E13 フラッシュセール

| Story | 内容 |
| --- | --- |
| `flash-sale-scheduling` | セールの予定、対象、1 人あたりの上限、枠の分割の連動 |
| `waiting-room` | 待合室の列、受け入れの速さ、売り切れの表示 |
| `queue-pass-tokens` | 許可証の発行と確かめ（エッジとチェックアウト） |
| `bot-defense` | WAF の Bot Control、チャレンジ、重複の検出。チャレンジの提供者の選定 |
| `isolation-pod-moves` | 隔離のポッドへの前もっての移し替えの手順と自動化 |
| `flash-sale-load-tests` | フラッシュセールの全場面（quality.md の 2.2.1 節 H） |
| `purchase-limits`（統合の工程で足した） | 1 人あたりの上限（4 種の鍵、送信で引き当て）（ADR-0026） |
| `surge-auto-queue`（統合の工程で足した） | 予定にない急増の自動の待合室（ADR-0027） |
| `flash-sale-prescaling`（統合の工程で足した） | 隔離のポッドの前もっての拡大（ADR-0074） |
| `flash-sale-dashboards`（統合の工程で足した） | セールのショップごとのダッシュボード |

### E14 アプリの基盤

| Story | 内容 |
| --- | --- |
| `app-registration` | アプリの登録、開発者のアカウント |
| `oauth-and-scopes` | OAuth 2.0、スコープ、アクセストークン（`<brand>_at_`）、導入と削除。顧客のデータのスコープは法務：L3 |
| `admin-graphql-schema` | Admin API のスキーマ、バージョン、変換の層。スキーマの確定は法務：L9 |
| `graphql-cost-and-buckets` | 費用の計算とバケット（ADR-0009） |
| `bulk-operations` | 一括の読み出しと書き込み |
| `webhook-subscriptions-and-delivery` | 購読、配信、署名、送り直し、停止 |
| `admin-embedding` | 管理画面への埋め込み、セッションのトークン |
| `app-billing` | 定額と従量の課金、開発者への支払い。法務：L5 |
| `webhook-egress`（統合の工程で足した） | Webhook の隔離した egress と固定の IP（ADR-0062） |
| `compliance-webhooks`（統合の工程で足した） | 個人のデータの開示・削除の依頼の話題。法務：L3 |
| `api-version-lifecycle`（統合の工程で足した） | API の四半期のバージョンの寿命と繰り上げ（ADR-0076） |
| `app-abuse-controls`（統合の工程で足した） | 悪意のあるアプリの止め方と、保護のデータの読み出しの量の見張り |

### E15 関数の砂場

| Story | 内容 |
| --- | --- |
| `wasm-function-poc` | PoC：実体化と実行の時間、燃料、同時の数 |
| `function-runner` | Rust の Wasmtime のホスト、上限、ソケット（ADR-0008） |
| `function-publish-and-compile` | モジュールの検査、事前の翻訳、署名 |
| `function-types-discount-delivery-payment-validation` | 4 つの種類の入出力と失敗の扱い |
| `function-input-queries` | 入力のクエリとスコープ |
| `sandbox-escape-suite` | 脱出の試験（quality.md の 2.2.1 節 F） |
| `function-dev-tooling` | Rust のひな形、入力の型の生成、ログの画面 |
| `wasmtime-upgrade-pipeline`（統合の工程で足した） | Wasmtime の更新の流れ（全モジュールの翻訳し直しと記録した入力の比べ）（ADR-0076） |

### E16 検索とおすすめ

| Story | 内容 |
| --- | --- |
| `search-index` | OpenSearch の索引、日本語の解析、索引の更新 |
| `search-and-filters` | 検索、絞り込み、並べ替え |
| `predictive-search` | 予測の検索 |
| `related-products` | 関連の商品（共起と人気） |

### E17 管理画面・スタッフ・監査

| Story | 内容 |
| --- | --- |
| `admin-shell` | 管理画面の骨格、Admin API だけを使う |
| `staff-accounts-and-invites` | スタッフのアカウント、招待、2 段階の認証 |
| `permissions-and-roles` | 権限の一覧、役割、決定表 |
| `sso` | SSO（SAML・OIDC） |
| `audit-trail` | 監査ログの画面と書き出し |
| `customer-data-requests` | 顧客のデータの開示・削除の請求。法務：L3 |
| `leak-path-tests` | 漏れの経路の表のテスト（quality.md の 2.2.1 節 G） |
| `collaborator-accounts`（統合の工程で足した） | 協力者（パートナー）のアカウント（ADR-0063） |
| `merchant-billing`（統合の工程で足した） | 本システムから事業者への請求（ADR-0065）。本システムのインボイスは法務：L4 |
| `support-access-grants`（統合の工程で足した） | 事業者の許可したサポートのアクセス（ADR-0068） |
| `audit-chain-verification`（統合の工程で足した） | 監査ログのハッシュの鎖と写しの欠けの検査（ADR-0064） |

### E18 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `load-tests` | ストアフロント・チェックアウト・Admin API・Webhook の負荷試験（S1 のピークの 2 倍） |
| `dr-failover-drill` | 大阪への切り替えの訓練 |
| `pentest-external` | 外部のペンテスト（テーマ、関数、API、チェックアウト） |
| `slo-dashboards-alerts` | SLO とアラート（[runbooks/README.md](runbooks/README.md)） |
| `runbooks-e18` | 個別の手順の作成と確認。核の 6 本（[runbooks/](runbooks/README.md) の 4 節）は設計の工程で草案を作った。残りの計画の手順を作り、全部を訓練で確かめる |
| `ga-readiness` | GA の判定。法務：L1・L3・L4・L7・L8 |
| `cost-baseline`（統合の工程で足した） | 月の原価の見積もりを請求の実績で置き換える |
| `pci-scope-review`（統合の工程で足した） | PCI DSS の範囲の確かめ。法務：L7、QSA |

## エージェントに任せないこと

- **契約（チェックアウトの状態と完了の決定表、在庫の不変条件、税の端数処理、割引の組み合わせ、テーマの言語の文法と IR、関数の入出力と上限、Admin API のスキーマと費用、Webhook の署名、アダプターの契約）の確定**：事業者・アプリの開発者・買い手に配った後に変えるコストが最も高い。
- **参照の実装・試験のベクトル・シミュレーターの性質の期待する値の変更**：QA が判断する。
- **在庫の数の手動の修正、注文の手動の作成・取り消し、返金の手動の実行**：Ops と、事業者の依頼の確認。
- **ポッドの割り当ての変更、ショップの移し替えの実行**：Ops が判断する。
- **フラッシュセールの受け入れの速さの変更、待合室の手動の開閉**：Ops（事業者との合意）。
- **大阪への切り替えの判断**：IC と Ops の責任者。
- **開示の請求・捜査機関からの照会への応答、顧客のデータの削除の実行**：法務と Ops。
- **法務の判断**（L1〜L10）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、上限・構成・採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E19〜E23 に入れなかったもの。着手するときに `intent.md` から起票する。

- **カートの変換と拠点の振り分けの関数**（[ADR-0008](decisions/0008-extension-sandbox-wasm.md)）。
- **1 つの行を複数の拠点に分ける引き当て**（[ADR-0004](decisions/0004-inventory-reservation-model.md)）。
- **機械学習のおすすめ**（search-and-recommendations の領域）。
- **REST の Admin API**（[ADR-0009](decisions/0009-admin-api-graphql-and-cost-limits.md)）。
- **ショップごとの暗号化の鍵**（security の領域）。
- **ショップをまたぐ検索（マーケットプレイス）**（[ADR-0002](decisions/0002-pods-and-shop-placement.md)）。

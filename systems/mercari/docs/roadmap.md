# Roadmap: Mercari

## 進め方の原則

- **最初に walking skeleton を通す。** E1・E2・E3・E5・E7・E8・E9・E11 の最小の部分で、電話番号の登録 → 出品（写真 1 枚）→ 検索 → 購入（提供者の模型のカード）→ 預かりの仕訳 → 匿名の配送（運送会社の模型）→ 受取評価 → 評価 → 売上金の残高 を端から端まで貫き、1 つの出品が売れて売上金になるところまで作ってから、機能を広げる。`purchaseListing` と部分一意の索引、遷移の関数と決定表、期限の列と `deadline-runner`、台帳の仕訳の型と冪等キー、住所の金庫、FORCE RLS と `listingVisible()` は、最初から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E5 の前：Sudachi の辞書と分割の単位、索引の大きさ（`search-index-poc`）。
  - E6 の前：保存した検索の照合の鍵と通知の量（`saved-search-matcher-poc`）。
  - E7 の前：人気の出品の同時実行の上限と先着の印（`hot-listing-purchase-poc`）。
  - E14 の前：偽ブランドの分類器の最初の評価（`counterfeit-classifier-poc`）。
- **規則は 1 つのコードに。** 購入と取引の遷移と期限は `packages/transactions`、仕訳は `packages/ledger`、手数料と送料の計算は `packages/fees`、出品の見える範囲は `packages/visibility`、検索の組み立ては `packages/search`、住所の復号は `packages/shipping`、措置は `packages/trust-safety` にだけ書く。
- **契約を先に固定する。** 取引の状態と遷移の決定表、期限の表、台帳の勘定科目と仕訳の型、`legal.*` の値の一覧、配送の事象の順位、`listingVisible()` の決定表、提供者・運送会社のアダプターの契約、規則のエンジンの言語は、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L11）。下の表で「法務：L*」と書いた Story が当たる。
- **人気の出品を早く試す。** 負荷の生成器を E7 で作り、縮めた規模の人気の出品の場面を、E7 から夜間に流し続ける。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（TypeScript と Python、参照の実装の枠）、3 つの Aurora と RLS、outbox、フラグ（`release.*`・`ops.*`・`legal.*`）、監査ログ、運用の画面の骨格、大阪の骨格 | 設計中 |
| E2 アカウントと端末 | 電話番号の確認、ログイン（パスキー、SMS）、セッション、端末、ブロック、退会 | 未着手（退会とデータの削除は法務：L5） |
| E3 出品と写真 | 出品、写真の処理、質の検査、出品の状態、同期の検査の呼び出し | 未着手（事業者の印は法務：L3） |
| E4 カテゴリ・ブランド・価格の提案 | カテゴリの木、状態、ブランドの辞書、カテゴリごとの制限、価格の提案 | 未着手（表示は法務：L4、制限は法務：L10） |
| E5 検索と発見 | 索引、日本語の解析、絞り込みと集計、売れた品、いいね、閲覧の履歴、基本のおすすめ | 未着手（前に索引の PoC。閲覧の履歴の利用は法務：L5） |
| E6 保存した検索と新着の通知 | 保存した検索、照合、まとめ、上限 | 未着手（前に照合の PoC） |
| E7 取引 | `purchaseListing`、状態の機械、期限、キャンセル、受取評価、出品と取引の照合、コメントでの値下げ交渉と価格の変更 | 未着手（前に人気の出品の PoC。購入の確認の画面は法務：L3） |
| E8 決済と預かり | 提供者のアダプター、カード・コンビニ払い、inbox と照会、返金、チャージバック | 未着手（預かりの性質は法務：L1） |
| E9 台帳と売上金 | 勘定科目、仕訳、手数料と送料、売上金の残高と明細、照合、手数料の請求書 | 未着手（売上金の期限は法務：L1、請求書は法務：L8） |
| E10 振込とポイント | 口座の登録、振込、振込の失敗の戻し、ポイント、売上金・ポイントでの購入 | 未着手（法務：L1・L2） |
| E11 配送の連携 | 配送の方法と料金の表、運送会社 2 社のアダプター、匿名の配送、追跡と Webhook、住所の金庫 | 未着手（運送会社への渡し方は法務：L5） |
| E12 メッセージとコメント | 商品のコメント、取引のメッセージ、悪用の絞り込み、通報 | 未着手（絞り込みの範囲は法務：L11、削除の申し出は法務：L9） |
| E13 評価と信用 | 相互の評価、評価の期限、集計と表示、自作自演の検出 | 未着手（表示は法務：L4） |
| E14 T&S | 同期の検査、分類器、規則のエンジン、審査の待ち行列と画面、措置と異議、通報、権利者の窓口、不正 | 未着手（前に分類器の PoC。法務：L6・L7・L9・L10） |
| E15 本人確認 | eKYC の提供者の連携、確認の水準、確認で開く機能と上限、書類の扱い | 未着手（全 Story が法務：L2・L5） |
| E16 紛争と CS | 問題の報告、紛争と期限の停止、運用の介入、補償、問い合わせ、開示の請求と照会 | 未着手（開示は法務：L7、照会は法務：L6） |
| E17 通知 | プッシュ、メール、お知らせ、配信の設定、まとめ、値下げ・いいねの fan-out | 未着手（値下げの文言は法務：L4） |
| E18 本番の準備と GA の判定 | 負荷試験（人気の出品、大型の企画の日）、DR の訓練、外部のペンテスト、GA の判定 | 未着手（GA の判定は法務：L1・L2・L5・L7・L9） |
| E19 オファー（MVP の後） | 決まった形の価格の提示、期限つきの承諾、取り置き | 未着手（MVP の後） |
| E20 事業者の出品（MVP の後） | 事業者の登録、特定商取引法の表示、事業者向けの手数料 | 未着手（MVP の後。法務：L3・L8） |
| E21 ML の価格の提案とおすすめ（MVP の後） | 学習、影の評価、学習した順位の式 | 未着手（MVP の後。法務：L4・L5） |
| E22 早期受取と後払い（MVP の後） | 完了の前の売上金、本システムの与信 | 未着手（MVP の後。法務：L1） |
| E23 鑑定と越境（MVP の後） | 鑑定の流れ、海外の買い手 | 未着手（MVP の後） |

E1〜E18 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。領域の文書（[architecture/README.md](architecture/README.md) の 7 節）を書くときに、各領域の「Story の候補」で直す。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Mercari の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`packages/transactions`・`ledger`・`fees`・`visibility`、`ml/` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント（本番、検証、見張りの別のアカウント）、SCP、VPC、egress の経路（提供者、銀行、運送会社、eKYC、SMS、プッシュ） |
| `aurora-clusters-and-rls` | core・ledger・content の 3 クラスタ、FORCE RLS、`SET LOCAL app.actor_id`、サービスの役割の許可リスト、RLS の検査（ADR-0001、ADR-0007） |
| `outbox-and-relay` | outbox、`relay`、SNS・SQS の話題 |
| `ci-pipeline-baseline` | PR の関門、TypeScript と Python、参照の実装の枠、仮想の時計の枠、テストの緩和の検出、依存の禁止の一覧（ADR-0001） |
| `flags-appconfig` | `release.*`・`ops.*`・`legal.*` のフラグ。`legal.*` は別の構成と承認（ADR-0004） |
| `observability-baseline` | OpenTelemetry、ダッシュボードの骨格、`canary` の骨格、ログの個人のデータの検査 |
| `audit-log-and-ops-shell` | 監査ログの表と S3 の Object Lock への写し、運用の画面の骨格、JIT の権限 |
| `data-lake-baseline` | outbox の事象の写し、仮名にする処理、個人のデータの除外の検査 |
| `osaka-warm-standby` | 大阪の骨格、Aurora Global Database、S3 の写し |

### E2 アカウントと端末

| Story | 内容 |
| --- | --- |
| `sms-provider-selection` | SMS の送信の提供者の選定 |
| `phone-verification-and-signup` | 電話番号の SMS の確認、1 番号 1 アカウント、登録 |
| `passkeys-and-sessions` | パスキー、SMS の一時コード、セッション、取り消し |
| `devices` | 端末の一覧、プッシュのトークン、端末の取り消し |
| `account-takeover-signals` | 新しい端末・電話番号の変更の再確認、兆しの記録（trust-and-safety へ渡す） |
| `profiles-and-blocks` | 公開のプロフィール、ブロック |
| `account-deletion` | 退会、データの削除と保持。法務：L5 |

### E3 出品と写真

| Story | 内容 |
| --- | --- |
| `photo-upload-and-processing` | 署名つきの URL、検査、向き、位置情報の除去、変換、知覚ハッシュ |
| `listings-crud-and-drafts` | 出品の作成・編集・下書き・停止・削除・再出品、出品のバージョン |
| `listing-states` | 出品の状態と遷移（取引・措置との結び付き） |
| `listing-quality-checks` | 必須の項目、写真の質、題名とカテゴリの食い違いの警告 |
| `listing-sync-checks` | 同期の検査の呼び出し（禁止の語、禁止のハッシュ、アカウントの状態）（ADR-0009） |
| `business-seller-flag` | 事業者に当たりうる売り手の印。基準は法務：L3 |

### E4 カテゴリ・ブランド・価格の提案

| Story | 内容 |
| --- | --- |
| `category-tree-and-conditions` | カテゴリの木（3 階層）、状態の段、サイズ |
| `brand-dictionary` | ブランドの辞書、表記の揺れ、正規化 |
| `category-restrictions` | カテゴリごとの制限と禁止。範囲は法務：L10 |
| `price-suggestion-stats` | 売れた品の四分位、広げ方、日次の計算（ADR-0010） |
| `price-suggestion-display` | 出品の画面の表示。文言は法務：L4 |

### E5 検索と発見

| Story | 内容 |
| --- | --- |
| `search-index-poc` | PoC：Sudachi の辞書と分割、2-gram、索引の大きさ、売れた品の保持 |
| `search-index-and-indexer` | 索引、外部のバージョン、措置の優先の待ち行列、作り直し（ADR-0008） |
| `search-query-and-filters` | 検索、絞り込み、集計、並べ替え、見える範囲の絞り込み |
| `sold-listings-search` | 売れた品の検索 |
| `ranking-formula-v1` | おすすめ順の式とバージョン |
| `likes-and-history` | いいね、閲覧の履歴。履歴の利用は法務：L5 |
| `basic-recommendations` | 規則のおすすめ（ADR-0010） |
| `listing-visible-snapshot` | `listingVisible()` の Valkey の写しと、検索の後の確かめ（ADR-0007） |

### E6 保存した検索と新着の通知

| Story | 内容 |
| --- | --- |
| `saved-search-matcher-poc` | PoC：照合の鍵、候補の数、通知の量 |
| `saved-searches` | 保存、正規化、1 人 30 件の上限 |
| `saved-search-matcher` | 逆索引、照合の Worker、参照の実装（quality.md の 2.2.1 節 E） |
| `saved-search-digests` | まとめの窓、1 日の上限、送る前の見える範囲 |

### E7 取引

| Story | 内容 |
| --- | --- |
| `hot-listing-purchase-poc` | PoC：先着の印、出品ごとの同時実行の上限、負けの応答の速さ |
| `purchase-listing` | `purchaseListing`、条件つきの更新、部分一意の索引、冪等（ADR-0002） |
| `transaction-state-machine` | 状態と遷移の関数、決定表 DT-TXN-001、事象の記録 |
| `transaction-deadlines` | 期限の列、`deadline-runner`、紛争の停止と延長、仮想の時計の試験 |
| `cancellations` | キャンセルの申し出と同意、発送の期限切れ |
| `receipt-and-ratings-handoff` | 受取評価、評価の期限、完了 |
| `price-change-and-negotiation` | 価格の変更（値下げ交渉の後）、古い価格の購入の 409 |
| `listing-transaction-reconciler` | 出品と取引の照合（5 分ごと） |
| `purchase-confirmation-screen` | 購入の確認の画面。出す事項は法務：L3 |
| `txn-reference-and-props` | `txn-ref` と並行の性質ベーステスト（quality.md の 2.2.1 節 A） |
| `load-generator` | 負荷の生成器と、縮めた規模の人気の出品の夜間の場面（同 H） |

### E8 決済と預かり

| Story | 内容 |
| --- | --- |
| `payment-provider-selection` | 提供者の選定（照会の API、冪等、コンビニ払い、Webhook、精算の一覧） |
| `payment-adapter-contract` | アダプターの契約、試行の行、冪等キー、契約の試験（ADR-0005） |
| `payment-webhook-inbox` | Webhook の署名の検証、inbox、照会の予定 |
| `card-capture-at-purchase` | カードの売上の確定、3-D セキュア、失敗の戻し |
| `konbini-payments` | コンビニ払い、支払いの期限、番号の取り消し |
| `refunds` | 返金（全額・一部）、`refund` の仕訳との結び付き |
| `chargebacks` | チャージバックの受け取り、取引への結び付け、回収の仕訳 |
| `psp-sim` | 提供者の模型（quality.md の 2.2.1 節 B） |
| `escrow-legal-gate` | 預かりの性質の確かめの門。法務：L1 |

### E9 台帳と売上金

| Story | 内容 |
| --- | --- |
| `ledger-core` | 口座、仕訳、仕訳の行、釣り合いの制約、残高の行、冪等キー（ADR-0003） |
| `escrow-hold-release-refund` | 預かり・release・refund の仕訳、排他の行 |
| `fee-and-shipping-tables` | 手数料の表と送料の表のバージョン、端数（`packages/fees`） |
| `proceeds-balance-and-statements` | 売上金の残高と明細の画面 |
| `proceeds-account-kinds` | `proceeds`・`balance`・`points` の口座の種類と `legal.*` の値（ADR-0004）。期限と失効は法務：L1 |
| `txn-ledger-reconciler` | 取引と台帳の照合（5 分ごと） |
| `three-way-reconciliation` | 台帳と提供者・銀行の日次の照合、仮勘定 |
| `ledger-reference-and-props` | `ledger-ref` と性質ベーステスト（quality.md の 2.2.1 節 B） |
| `fee-invoices` | 手数料の請求書と明細。法務：L8 |

### E10 振込とポイント

| Story | 内容 |
| --- | --- |
| `bank-partner-selection` | 提携銀行の選定（API、全銀の形式のファイル、明細） |
| `bank-accounts` | 口座の登録と確かめ |
| `payouts` | 振込の申請、手数料、実行、失敗の戻し。上限は法務：L2 |
| `points` | ポイントの付与（キャンペーン、補償）と使用、期限。法務：L1・L4 |
| `pay-with-balance` | 売上金・ポイントでの購入、引き当てと戻し。売上金の使用は法務：L1 |

### E11 配送の連携

| Story | 内容 |
| --- | --- |
| `carrier-selection` | 運送会社 2 社の API の能力の確かめと契約（匿名の配送、QR、Webhook、照会） |
| `shipping-methods-and-rates` | 配送の方法、サイズの段、料金の表のバージョン |
| `address-vault` | 住所の金庫、封筒の暗号化、復号の権限（ADR-0006） |
| `carrier-adapters` | 2 社のアダプター、受け付けと QR、取り消し。運送会社への渡し方は法務：L5 |
| `tracking-webhooks-and-polling` | Webhook の inbox、事象の順位、照会のジョブ |
| `non-anonymous-shipping` | 匿名でない配送、追跡の番号、本人確認の条件 |
| `carrier-sim` | 運送会社の模型と競合の試験（quality.md の 2.2.1 節 D） |
| `shipping-incidents` | 紛失・破損・戻りの扱い、補償の依頼 |

### E12 メッセージとコメント

| Story | 内容 |
| --- | --- |
| `listing-comments` | 商品のコメント、削除、売り手の操作。削除の申し出は法務：L9 |
| `transaction-messages` | 取引のメッセージ（2 者） |
| `abuse-filtering` | 禁止の語、連絡先・住所の書き込み、外部の取引への誘導の検出。範囲は法務：L11 |
| `message-reports` | コメントとメッセージの通報 |

### E13 評価と信用

| Story | 内容 |
| --- | --- |
| `mutual-ratings` | 相互の評価、評価の期限、取引の完了との結び付き |
| `reputation-summary` | 評価の集計と表示、本人確認の印。表示は法務：L4 |
| `rating-abuse-detection` | 自作自演・評価の操作の検出 |

### E14 T&S

| Story | 内容 |
| --- | --- |
| `counterfeit-classifier-poc` | PoC：最初の分類器と評価の集まり、閾値 |
| `rules-engine` | 規則の言語、バージョン、影の評価、決定表（ADR-0009） |
| `moderation-actions` | `moderation_actions`、措置の反映（検索・通知・購入）、異議 |
| `review-queues-and-console` | 審査の待ち行列、優先度、審査の画面 |
| `text-and-image-classifiers` | 文字と画像の分類器、`ml-inference` |
| `counterfeit-evalset` | 評価の集まりと評価の枠（quality.md の 2.2.1 節 F） |
| `prohibited-items-policy` | 禁止の品の一覧と規則。範囲は法務：L10 |
| `stolen-goods-handling` | 盗品の疑いの措置と記録。法務：L6 |
| `rights-holder-portal` | 権利者の窓口 |
| `user-reports` | 出品・利用者の通報 |
| `fraud-signals` | 乗っ取り、偽の発送、チャージバック、売上金の現金化の兆し |
| `legal-notices-intake` | 削除の申し出・停止の要請の受け付けと期限。法務：L7・L9 |

### E15 本人確認

| Story | 内容 |
| --- | --- |
| `ekyc-provider-selection` | eKYC の提供者の選定（マイナンバーカードの IC、書類と顔）。方式は法務：L2 |
| `ekyc-integration` | 提供者の連携、確認の状態と水準。法務：L2・L5 |
| `kyc-gated-features` | 確認で開く機能と上限（残高、匿名でない配送、振込の上限）。法務：L1・L2 |
| `kyc-document-retention` | 書類と結果の保存と削除。法務：L2・L5 |

### E16 紛争と CS

| Story | 内容 |
| --- | --- |
| `problem-reports-and-disputes` | 問題の報告、`disputed`、期限の停止 |
| `ops-interventions` | 運用の介入（キャンセル、返金、部分の返金、売上金の保留）と仕訳 |
| `compensation` | 補償（ポイント、売上金）の仕訳と承認 |
| `support-inquiries` | 問い合わせの受け付けと案件 |
| `disclosure-requests` | 販売業者等の情報の開示の請求。法務：L7 |
| `law-enforcement-requests` | 捜査機関・行政の照会。法務：L6 |

### E17 通知

| Story | 内容 |
| --- | --- |
| `notifier-and-preferences` | プッシュ・メール・お知らせ、配信の設定、速さの上限 |
| `transaction-notifications` | 取引の通知（NFR-008 の 10 秒） |
| `price-drop-and-like-fanout` | 値下げ・いいねの fan-out、1 日の上限。文言は法務：L4 |
| `notification-fanout-tests` | fan-out の試験（quality.md の 2.2.1 節 I） |

### E18 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `load-tests` | 人気の出品・大型の企画の日・検索・通知の負荷試験（quality.md の 2.2.1 節 H） |
| `dr-failover-drill` | 大阪への切り替えの訓練 |
| `pentest-external` | 外部のペンテスト（購入、台帳、住所、運用の画面） |
| `slo-dashboards-alerts` | SLO とアラート（[runbooks/README.md](runbooks/README.md)） |
| `runbooks-e18` | 個別の手順の作成と確認 |
| `ga-readiness` | GA の判定。法務：L1・L2・L5・L7・L9 |

## エージェントに任せないこと

- **契約（取引の状態と遷移の決定表、期限の表、台帳の勘定科目と仕訳の型、`legal.*` の値の一覧、配送の事象の順位、`listingVisible()` の決定表、アダプターの契約、規則のエンジンの言語）の確定**：利用者と外部に配った後に変えるコストが最も高い。
- **参照の実装・評価の集まり・試験のベクトル・手数料と送料の表の期待する値の変更**：QA が判断する。
- **手の仕訳、返金・補償の実行、売上金の保留と解除**：Ops と財務の承認の手順。
- **措置（アカウントの停止、取引の取り消し）の判定、異議の判定**：T&S の審査員。
- **`legal.*` の値の変更**：法務と財務。
- **大阪への切り替えの判断**：IC と Ops の責任者。
- **開示の請求・捜査機関からの照会への応答**：法務と Ops。
- **法務の判断**（L1〜L11）。
- **負荷試験・PoC・評価の集まりの結果の解釈**：数字は出せるが、上限・構成・採否は Dev・QA・PM の判断。

## 延期の一覧

MVP の後に検討する。E19〜E23 に入れなかったもの。着手するときに `intent.md` から起票する。

- **オークションの形式、ライブの販売**（transactions-and-state-machine の領域）。
- **梱包・集荷の代行、大型の品の配送**（shipping-integrations の領域）。
- **取引のメッセージのエンドツーエンドの暗号化**（悪用の絞り込みと両立しない。法務の L11 の結論の後に検討する）。
- **core の分割（S3）と ledger の分割（S2）**（infrastructure の領域。段階を上げる基準で起票する）。
- **自前の eKYC**（提供者で足りる間は作らない）。

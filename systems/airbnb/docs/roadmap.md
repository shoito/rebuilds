# Roadmap: Airbnb

## 進め方の原則

- **最初に walking skeleton を通す。** E1・E2・E3・E4・E5・E7・E8・E9・E11・E12・E18 の最小の部分で、ホストの登録 → 日本のリスティング（写真 1 枚、届出番号）→ 地図と日付の検索 → 見積もり → 即時予約（提供者の模型のカード）→ 預かりの仕訳 → チェックインの後の振り替え → 円の振込（銀行の模型）を端から端まで貫き、1 泊が売れてホストの口座に届くところまで作ってから、機能を広げる。`stay_claims` と排他の制約、`packages/stay-time`、`reserveStay` と決定表、`regulated_nights` と CHECK 制約、台帳の仕訳の型と冪等キー、vault、FORCE RLS と `listingVisible()` は、最初から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E4 の前：地名の辞書の出どころとライセンス、住所の検索の提供者（`place-dictionary-poc`）。
  - E6 の前：iCal の取り込みの間隔と量、相手の対応（`ical-import-poc`）。
  - E7 の前：`stay_ranges` とステージ 2 の件数、写しの大きさ、混入の率（`availability-search-poc`）。
  - E9 の前：熱い日付の先着の印、排他の制約と届出住宅のロックの待ち（`hot-dates-booking-poc`）。
- **規則は 1 つのコードに。** 空室と滞在の規則は `packages/availability`、時刻は `packages/stay-time`、予約の遷移は `packages/booking`、キャンセルの精算は `packages/cancellation`、料金は `packages/pricing`、税は `packages/tax`、為替は `packages/fx`、仕訳は `packages/ledger`、180 日と名簿は `packages/compliance-jp`、見える範囲は `packages/visibility`、検索の組み立ては `packages/search`、措置は `packages/trust-safety` にだけ書く。
- **契約を先に固定する。** 予約の状態と遷移の決定表、滞在の規則の決定表、キャンセルの精算の決定表とポリシーの表、台帳の勘定科目と仕訳の型、`legal.*` の値の一覧、180 日の数え方、自治体の規則の表の形、`listingVisible()` の決定表、PMS の API の形、提供者のアダプターの契約は、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L14）。下の表で「法務：L*」と書いた Story が当たる。
- **時刻と並行を早く試す。** 仮想の時計と tz の試験ベクトルを E5 で、並行の性質ベーステストと負荷の生成器を E9 で作り、縮めた規模の熱い日付の場面を E9 から夜間に流し続ける。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（TypeScript と Python、参照の実装の枠、仮想の時計の枠）、4 つの Aurora と RLS、vault、outbox、フラグ（`release.*`・`ops.*`・`legal.*`）、監査ログ、運用の画面の骨格、大阪の骨格 | 未着手（設計は済み。開発リポジトリの作成から） |
| E2 アカウント | ログイン、セッション、端末、言語と通貨、ホストのアカウントと共同ホスト、退会 | 未着手（退会とデータの削除は法務：L8） |
| E3 リスティングと内容 | リスティング、写真、設備、ハウスルール、多言語と翻訳、公開の審査 | 未着手（表示は法務：L13） |
| E4 位置と地名 | 住所と位置の金庫、ずらした位置、地名の辞書、地図 | 未着手（前に地名の辞書の PoC） |
| E5 空室とカレンダー | `stay_claims`、排他の制約、滞在の規則、カレンダーの設定、ブロック、物件のタイムゾーン | 未着手 |
| E6 カレンダーの同期 | iCal の取り込みと書き出し、食い違いの検出 | 未着手（前に iCal の PoC） |
| E7 検索と順位付け | 索引、2 段の空室の絞り込み、価格、日付を決めない検索、順位の式 v1 | 未着手（前に空室の検索の PoC） |
| E8 料金・手数料・税 | 料金の規則、割引、料金、サービス料、税の表、`quoteStay`、総額の表示 | 未着手（税の預かりは法務：L4、割引の表示は法務：L13） |
| E9 予約と仮押さえ | `reserveStay`、ステートマシン、即時予約、リクエスト、熱い日付、確認の画面、チェックインの案内 | 未着手（前に熱い日付の PoC。確認の画面は法務：L7、断りの理由は法務：L2・L11） |
| E10 キャンセルと変更 | ポリシーの表、返金の計算、ホストのキャンセル、運用のキャンセル、日程の変更 | 未着手（ポリシーの表は法務：L7） |
| E11 決済と為替 | 提供者の連携、オーソリと売上の確定、返金、チャージバック、相場の写し | 未着手（預かりは法務：L5） |
| E12 台帳と送金 | 勘定科目、仕訳、預かりと決着、release、送金、保留、照合 | 未着手（法務：L4・L5） |
| E13 損害の請求 | 請求の受け付けと期限、ゲストの応答、運用の判断、請求 | 未着手（全 Story が法務：L12） |
| E14 メッセージと通知 | メッセージ、連絡先の絞り込み、翻訳、プッシュ・メール・SMS | 未着手（絞り込みの範囲は法務：L9） |
| E15 レビュー | 同時の公開、項目ごとの点、ホストの返答、削除の基準 | 未着手（削除と表示は法務：L13） |
| E16 T&S | 規則のエンジン、点、審査、措置と異議、偽のリスティング、不正、パーティーの危険、安全の窓口、差別の禁止 | 未着手（差別の禁止は法務：L11、開示は法務：L14） |
| E17 本人確認 | eKYC の提供者の連携、確認の水準、旅券の読み取り、書類の扱い | 未着手（法務：L3・L8） |
| E18 日本の法令の対応 | 届出住宅、番号の確かめと表示、180 日、自治体の規則、宿泊者名簿、定期報告の書き出し | 未着手（全 Story が法務：L1・L2・L3・L10） |
| E19 ホストの道具と API | 複数のリスティングの管理、一括の変更、共同ホスト、PMS の API、Webhook | 未着手（開示の請求は法務：L14） |
| E20 本番の準備と GA の判定 | 繁忙期・熱い日付の負荷試験、DR の訓練、外部のペンテスト、安全の窓口の訓練、GA の判定 | 未着手（GA の判定は法務：L1・L5・L8・L14） |
| E21 保証金と分割払い（MVP の後） | 保証金のオーソリ、一部を今・残りを後で | 未着手（MVP の後。法務：L5・L12） |
| E22 料金の提案と順位付けの ML（MVP の後） | 学習、影の評価、公平さの評価 | 未着手（MVP の後） |
| E23 複数の同じ部屋と長期の滞在（MVP の後） | 部屋の種類の在庫、28 泊以上の月ごとの請求と送金 | 未着手（MVP の後。法務：L7） |
| E24 海外のホストと国際送金（MVP の後） | 各国の登録・税、国際送金 | 未着手（MVP の後。法務：L6） |
| E25 体験とサービス（MVP の後） | 席と時間の枠の予約 | 未着手（MVP の後。法務：L10） |

E1〜E20 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。領域の文書（[architecture/README.md](architecture/README.md) の 7 節）を書くときに、各領域の「Story の候補」で直す。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Airbnb の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`packages/availability`・`stay-time`・`booking`・`cancellation`・`ledger`・`compliance-jp`・`visibility`、`ml/` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント（本番、検証、見張りの別のアカウント）、SCP、VPC、egress の経路（提供者、銀行、eKYC、翻訳、地図、iCal の取得） |
| `aurora-clusters-and-rls` | core・ledger・content・vault の 4 クラスタ、`btree_gist`、FORCE RLS、`SET LOCAL`、サービスの役割の許可リスト、RLS の検査（ADR-0001、ADR-0007） |
| `vault-envelope-encryption` | vault の封筒の暗号化、読み出しの監査の関数 |
| `outbox-and-relay` | outbox、`relay`、SNS・SQS の話題 |
| `ci-pipeline-baseline` | PR の関門、TypeScript と Python、参照の実装の枠、`clock-sim` の枠、テストの緩和の検出、依存の禁止の一覧（ADR-0001） |
| `flags-appconfig` | `release.*`・`ops.*`・`legal.*` のフラグ。`legal.*` は別の構成と承認 |
| `observability-baseline` | OpenTelemetry、ダッシュボードの骨格、`canary` の骨格、ログの個人のデータの検査 |
| `audit-log-and-ops-shell` | 監査ログの表と S3 の Object Lock への写し、運用の画面の骨格、JIT の権限 |
| `data-lake-baseline` | outbox の事象の写し、仮名にする処理、個人のデータの除外の検査 |
| `osaka-warm-standby` | 大阪の骨格、Aurora Global Database、S3 の写し |

### E2 アカウント

| Story | 内容 |
| --- | --- |
| `sign-in-and-sessions` | パスキー、メール・SMS の一時コード、外部の ID の提供者、セッション、取り消し |
| `devices-and-preferences` | 端末、プッシュのトークン、言語と表示の通貨 |
| `host-accounts-and-cohosts` | ホストのアカウント、共同ホストの役割、リスティングごとの役割（ADR-0007） |
| `account-takeover-signals` | 新しい端末・送金の口座の変更の再確認、72 時間の保留（trust-and-safety へ渡す） |
| `account-deletion` | 退会、データの削除と保持。法務：L8 |

### E3 リスティングと内容

| Story | 内容 |
| --- | --- |
| `photo-upload-and-processing` | 署名つきの URL、検査、位置情報の除去、変換、知覚ハッシュ |
| `listings-crud-and-states` | リスティングの作成・編集・下書き・公開・停止、リスティングのバージョン |
| `amenities-and-house-rules` | 設備の一覧、ハウスルール、チェックインの方法 |
| `multilingual-content-and-translation` | 言語ごとの説明、翻訳の提供者の選定と連携、訳の印 |
| `listing-review-on-publish` | 公開の審査の呼び出し（写真のハッシュ、禁止の語、本人確認、届出番号）（ADR-0009） |
| `listing-visible` | `listingVisible()` の決定表と、検索・共有の経路での使用（ADR-0007） |

### E4 位置と地名

| Story | 内容 |
| --- | --- |
| `place-dictionary-poc` | PoC：地名の辞書の出どころ、ライセンス、多言語の名前、住所の検索の提供者 |
| `address-and-exact-location` | 住所の入力、提供者での位置、ピンの調整、vault への保存、`exactLocationVisible()` |
| `approximate-location` | ずらした位置の決め方、割り出しの試験（quality.md の 2.2.1 節 E） |
| `place-search-and-areas` | 地名の索引、行政の区域の多角形、駅・観光地、入力の補完 |
| `map-provider-integration` | 地図のタイルの提供者の選定と連携 |

### E5 空室とカレンダー

| Story | 内容 |
| --- | --- |
| `stay-time-package` | `packages/stay-time`、物件のタイムゾーン、tz データベースの固定、tz の試験ベクトル（quality.md の 2.2.1 節 D） |
| `stay-claims-and-exclusion` | `stay_claims`、`claim_group`、排他の制約、期限の切れた行の外し方（ADR-0002） |
| `stay-rules` | 滞在の規則の決定表、`checkStayRules` |
| `calendar-settings-and-blocks` | 泊ごとの設定（料金、規則の上書き）、ブロック、準備の日 |
| `avail-reference-and-props` | `avail-ref` と並行の性質ベーステスト（quality.md の 2.2.1 節 A） |

### E6 カレンダーの同期

| Story | 内容 |
| --- | --- |
| `ical-import-poc` | PoC：取得の間隔、量、相手の条件つきの取得の対応 |
| `ical-export` | 秘密のアドレス、作り直し、`UID`・`PRODID`（`<Brand>`） |
| `ical-import` | 取得、正規化、上限、差分、egress の検査、`ical-sim` |
| `calendar-conflicts` | 食い違いの検出、知らせ、運用の待ち行列 |
| `external-nights-declaration` | 他の掲載先の泊の申告（180 日の数えへの入力）。数えへの反映は法務：L1 |

### E7 検索と順位付け

| Story | 内容 |
| --- | --- |
| `availability-search-poc` | PoC：`stay_ranges`、ステージ 1 の件数、写しの大きさ、混入の率 |
| `search-index-and-indexer` | 索引の形、外部のバージョン、`stay_ranges` の計算、日次の下の端の更新（ADR-0003） |
| `availability-cache` | Valkey の空室の写し、`availability-cache-writer`、DB への迂回 |
| `search-query-two-stage` | ステージ 1 と 2、価格の絞り込み、料金の要約の写し |
| `flexible-dates` | 日付を決めない検索 |
| `ranking-formula-v1` | 順位の式とバージョン |
| `search-correctness-sampling` | 混入の抜き取りと、`search-ref`（quality.md の 2.2.1 節 E） |

### E8 料金・手数料・税

| Story | 内容 |
| --- | --- |
| `pricing-rules` | 基本・週末・季節・日付の上書き、長期の割引、清掃料・追加のゲストの料金 |
| `service-fee` | サービス料の表とバージョン |
| `quote-stay-and-snapshots` | `quoteStay`、見積もりの写し、15 分の期限、`price-ref` |
| `tax-tables` | 消費税・宿泊税・入湯税の表、区域、端数。預かりと納付の型は法務：L4 |
| `total-price-display` | 総額の表示と明細。表示の事項は法務：L4・L13 |

### E9 予約と仮押さえ

| Story | 内容 |
| --- | --- |
| `hot-dates-booking-poc` | PoC：先着の印、リスティングごとの同時実行の上限、届出住宅のロックの待ち |
| `reserve-stay` | `reserveStay`、冪等、見積もりの確かめ、仮押さえ（ADR-0004） |
| `booking-state-machine` | 状態と遷移の関数、決定表 DT-BKG-001、`deadline-runner` |
| `booking-requests` | リクエスト、24 時間、承認と断り。断りの理由の扱いは法務：L2・L11 |
| `booking-confirmation-screen` | 確認の画面。出す事項は法務：L7 |
| `check-in-instructions` | 確定の後の住所と入り方、`exactLocationVisible()` |
| `load-generator` | 負荷の生成器と、縮めた規模の熱い日付の夜間の場面（quality.md の 2.2.1 節 J） |

### E10 キャンセルと変更

| Story | 内容 |
| --- | --- |
| `cancellation-policies` | ポリシーの表とバージョン、`refund-ref`。違約金の妥当さは法務：L7 |
| `guest-cancellation-and-refund` | ゲストのキャンセル、精算の決定表 |
| `host-cancellation` | ホストのキャンセル、罰、ゲストへの支援 |
| `ops-cancellation` | 運用のキャンセル（事故、災害）、全額の返金 |
| `reservation-alterations` | 日程・人数の変更、差分の見積もり、`claim_group` の入れ替え |

### E11 決済と為替

| Story | 内容 |
| --- | --- |
| `payment-provider-selection` | 提供者の選定（ゲストの通貨、3-D セキュア、財布型、照会、精算の一覧） |
| `payment-adapter-contract` | アダプターの契約、試行の行、冪等キー、Webhook の inbox、`psp-sim`（ADR-0005） |
| `capture-and-authorization` | 即時予約の確定、リクエストのオーソリと承認での確定 |
| `refunds-and-chargebacks` | 返金、チャージバックの受け取りと仕訳 |
| `fx-rate-snapshots` | 相場の提供者の選定、写しの取り込み、`packages/fx`（ADR-0008） |
| `funds-holding-legal-gate` | 預かりの性質の確かめの門。法務：L5 |

### E12 台帳と送金

| Story | 内容 |
| --- | --- |
| `ledger-core` | 勘定科目、通貨ごとの仕訳、冪等キー、決着の一意（ADR-0005） |
| `release-after-check-in` | `payout_release_at`、release、保留への振り替え |
| `payout-accounts-and-execution` | 送金の口座（vault）、提携銀行の選定、送金の束、失敗の戻し |
| `payout-holds` | 送金の保留と解除（不正、本人確認、損害の請求、口座の変更） |
| `reconciliation` | 予約と台帳、台帳の内部、3 者の照合（`ledger-ref`） |
| `tax-remittance` | 税の預かりと納付の仕訳。法務：L4 |
| `host-statements` | ホストの明細、手数料の請求書。法務：L4 |

### E13 損害の請求

| Story | 内容 |
| --- | --- |
| `damage-claims` | 請求の受け付け（チェックアウトから 14 日）、写真・見積もり、ゲストの応答。法務：L12 |
| `claim-decisions-and-charges` | 運用の判断、ゲストへの請求、補償の記録と仕訳。法務：L12 |

### E14 メッセージと通知

| Story | 内容 |
| --- | --- |
| `message-threads` | 問い合わせと予約のスレッド、添付、決まった文の返信 |
| `contact-info-filter` | 連絡先の絞り込み（確定の前と後の段）。範囲は法務：L9 |
| `message-translation` | メッセージの翻訳 |
| `notifier-and-preferences` | プッシュ・メール・SMS、言語ごとの文、配信の設定 |
| `booking-notifications` | 予約の通知（NFR-012） |

### E15 レビュー

| Story | 内容 |
| --- | --- |
| `review-pairs-and-reveal` | `review_pairs`、期限、同時の公開（quality.md の 2.2.1 節 F） |
| `review-scores-and-display` | 項目ごとの点、集計、表示。表示は法務：L13 |
| `host-responses-and-removal` | ホストの返答、通報と削除の基準。法務：L13 |

### E16 T&S

| Story | 内容 |
| --- | --- |
| `rules-engine` | 宣言の規則の表、バージョン、決定表（ADR-0009） |
| `risk-scores` | 不正・パーティーの危険・偽のリスティング・乗っ取りの点（統計と規則から始める） |
| `review-queues-and-actions` | 審査の待ち行列、`moderation_actions`、異議 |
| `fake-listing-detection` | 写真の使い回し、住所、外部への誘導 |
| `party-prevention` | パーティーの危険の規則、`step_up`、地域と時期の強化 |
| `safety-incidents-and-24x7-line` | 安全の事故の案件、緊急のボタン、24 時間の窓口、代わりの宿の手配の記録 |
| `non-discrimination-policy` | 方針への同意、確定の前の写真の非表示、断りの率の見張り。法務：L11 |
| `disclosure-and-takedown-requests` | 開示の請求、利用の停止の要請。法務：L14 |
| `ts-evalsets-and-fairness` | 評価の集まりと公平さの評価（quality.md の 2.2.1 節 I） |

### E17 本人確認

| Story | 内容 |
| --- | --- |
| `kyc-provider-selection` | eKYC の提供者の選定（旅券の読み取りを含む） |
| `verification-levels` | 確認の水準、求める規則、ホストの公開の前の必須 |
| `passport-capture` | 旅券の読み取り、vault、名簿への受け渡し。法務：L3・L8 |
| `kyc-document-retention` | 書類と結果の保存と削除。法務：L3・L8 |

### E18 日本の法令の対応

| Story | 内容 |
| --- | --- |
| `regulated-properties` | 届出住宅・許可・特定認定の型、番号の入力と書類、確かめの手順。法務：L1・L2 |
| `registration-display` | リスティングへの番号の表示。法務：L1・L2 |
| `night-cap-counting` | `regulated_nights`、`regulated_years`、年度、予約との同じトランザクション、`cap-ref`（ADR-0006）。数え方の値は法務：L1 |
| `municipal-rule-sets` | 自治体の規則の表、区域の多角形、施行の日、反する予約の一覧。法務：L1 |
| `guest-registry` | 宿泊者名簿の電子の名簿、項目、旅券、保存。法務：L3 |
| `periodic-report-export` | 定期報告の補助の書き出し。法務：L1 |
| `ryokan-listings` | 旅館業の施設の掲載と仲介の形。法務：L2・L10 |

### E19 ホストの道具と API

| Story | 内容 |
| --- | --- |
| `multi-listing-calendar` | 複数のリスティングの一覧とカレンダー、一括の料金とブロックの変更 |
| `pms-oauth-apps` | OAuth のアプリ、範囲、トークン（`<brand>_pms_`）（ADR-0007） |
| `pms-api-v1` | リスティング・カレンダー・料金・予約・メッセージの API、冪等、速さの上限 |
| `webhooks` | Webhook の購読、署名（`<Brand>-Signature`）、配信と再送 |

### E20 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `load-tests` | 繁忙期・熱い日付・検索・iCal の負荷試験（quality.md の 2.2.1 節 J） |
| `dr-failover-drill` | 大阪への切り替えの訓練 |
| `pentest-external` | 外部のペンテスト（予約、台帳、vault、位置の割り出し、PMS の API、運用の画面） |
| `safety-line-drill` | 24 時間の安全の窓口の訓練 |
| `slo-dashboards-alerts` | SLO とアラート（[runbooks/README.md](runbooks/README.md)） |
| `runbooks-e20` | 個別の手順の作成と確認 |
| `ga-readiness` | GA の判定。法務：L1・L5・L8・L14 |

## エージェントに任せないこと

- **契約（予約の遷移・滞在の規則・キャンセルの精算の決定表、ポリシーの表、台帳の勘定科目と仕訳の型、`legal.*` の値の一覧、180 日の数え方、自治体の規則の表の形、`listingVisible()` の決定表、PMS の API の形、アダプターの契約）の確定**：利用者と外部に配った後に変えるコストが最も高い。
- **参照の実装・評価の集まり・試験のベクトル・料金とポリシーと税の表の期待する値の変更**：QA が判断する。
- **自治体の規則の表の中身（条例の読み取り）**：法務と運用。
- **手の仕訳、返金・補償の実行、送金の保留と解除**：Ops と財務の承認の手順。
- **措置（アカウントの停止、予約の取り消し、リスティングの削除）の判定、異議の判定、損害の請求の判断**：T&S と CS の担当。
- **安全の事故の対応の判断（警察への連絡、代わりの宿の手配）**：安全の担当。
- **`legal.*` の値の変更**：法務と財務。
- **大阪への切り替えの判断**：IC と Ops の責任者。
- **行政・警察からの照会、開示の請求への応答**：法務と Ops。
- **法務の判断**（L1〜L14）。
- **負荷試験・PoC・評価の集まりの結果の解釈**：数字は出せるが、上限・構成・採否は Dev・QA・PM の判断。

## 延期の一覧

MVP の後に検討する。E21〜E25 に入れなかったもの。着手するときに `intent.md` から起票する。

- **割引の企画（早割、直前割、クーポン）**（pricing-and-fees の領域。景品表示法の L13 の後）。
- **ゲストの残高・ギフトカード**（資金決済法の前払式支払手段。法務の L5 の後）。
- **ホストの評価の段（優良ホスト）**（reviews・search-and-ranking の各領域）。
- **地図の区画の需要の集計と料金の提案の地図**（location-and-geo の領域。区画の方式は別の ADR）。
- **core の分割（S3）、ledger の熱い口座のスロット（S2）と分割（S3）**（infrastructure の領域。段階を上げる基準で起票する。[ADR-0078](decisions/0078-stage-up-criteria-split-plan-and-unit-cost.md)）。
- **自前の eKYC、自前の翻訳、自前の地図**（提供者で足りる間は作らない）。

---
status: accepted
date: 2026-10-10
---

# ADR-0001: 共通の基盤を引き継ぎ、ドメインごとのパッケージを持つ 1 つのコードベースを入口・Worker ごとのサービスで出す。Aurora は core・ledger・content・vault の 4 クラスタにする。ML だけ Python で書く。検索は OpenSearch を汎用の部品として使う

## Context

rebuilds の他の題材で、次の基盤を決めている。

- AWS（東京、DR は大阪。ECS Fargate、Aurora PostgreSQL 18、ElastiCache Valkey、SQS・SNS、S3・CloudFront）
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry、AWS AppConfig のフィーチャーフラグ、トランクベース開発
- FORCE RLS と `SET LOCAL`、UUIDv7、transactional outbox

この題材の主な論点（[README.md](../../README.md)）は、泊の空室と二重の予約の防止、日付の範囲で絞る地図の検索、料金と税と通貨の見積もり、予約の状態の機械と仮押さえ、預かりとチェックインの後の送金、T&S、日本の法令の上限である。性質は次のとおり。

- ほとんどは業務のアプリケーション（リスティング、予約、メッセージ、運用の画面）で、他の題材と同じ形である。
- 空室の正しさは、範囲の重なりの判定である。PostgreSQL の `btree_gist` の排他の制約が、この判定を DB の制約として持てる。Google Calendar の題材も会議室と予約ページでこれを使っている（[ADR-0033](../../../google-calendar/docs/decisions/0033-booking-creation-and-exclusion.md)）。
- お金の正本（台帳）は、予約と書き込みの形が違う。追記だけで、照合と監査が要る。
- 正確な住所・位置、宿泊者名簿、旅券の番号と画像、送金の口座は、他のデータより守りを厚くしたい。読む主体が限られ、保存の期間が法令で決まる。
- 地図と日付と文字の検索は、地理の問い合わせ・範囲の型・多言語の解析が要る。PostgreSQL の全文検索は日本語の形態素の解析を持たない。
- 不正・パーティーの危険の点と料金の提案の学習は、Python の ML の道具が最も揃っている。
- 本家の実装を核に使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。本家はデータ基盤やワークフローの道具を公開しているが、どれも題材の核（空室、検索、料金、予約、台帳、T&S）ではない。それでも、迷いを避けるため、本家が作って公開したライブラリ・ツールは核にも依存にも使わない。

## Options

コードの形：

1. **1 つのコードベース（ドメインごとのパッケージ）を、入口・Worker ごとの別のサービスとして出す**
2. ドメインごとのマイクロサービス（別のリポジトリと DB）
3. 1 つのサービス

DB の分け方：

- a. **core・ledger・content・vault の 4 クラスタ**
- b. core・ledger・content の 3 クラスタ（vault を core の中の表と鍵で分ける）
- c. 1 つのクラスタ

ML：

- x. **Python（学習と推論のサービス）**
- y. TypeScript（ONNX Runtime で推論だけ）

## Decision

1、a、x を採用する。

### サービスの分け方

| サービス | 入口 | 言語・実行基盤 |
| --- | --- | --- |
| `app-api` | アプリと Web の API | TypeScript、Fargate |
| `partner-api` | PMS 向けの API | 同上 |
| `ops-api` | 運用の画面の API | 同上 |
| `identity`、`listings`、`availability`、`search-api`、`pricing`、`booking`、`payments`、`ledger`、`payouts`、`messaging`、`reviews`、`trust-safety`、`compliance-jp`、`notifier` | 内部の API | 同上 |
| Worker（`relay`、`media-processor`、`search-indexer`、`availability-cache-writer`、`ical-sync`、`deadline-runner`、`reconcilers`） | SQS の消費者、定時の処理 | 同上 |
| `ml-inference` | 不正・パーティーの危険・偽のリスティングの点、料金の提案 | Python、Fargate |
| 学習のジョブ | データレイクから学習・評価 | Python、ECS のタスク（infrastructure の領域） |
| アプリ・Web | — | React Native・React（TypeScript） |

- ドメインのパッケージ（`packages/availability`、`stay-time`、`search`、`pricing`、`tax`、`fx`、`booking`、`cancellation`、`payments`、`ledger`、`payouts`、`messaging`、`reviews`、`trust-safety`、`compliance-jp`、`visibility`）は、互いに公開の関数だけを呼ぶ。DB の表は持ち主のパッケージだけが書く（lint で検査する）。

### DB の分け方

| クラスタ | 表 | 書くパッケージ |
| --- | --- | --- |
| core | アカウント、ホストのアカウントと共同ホスト、リスティング、ずらした位置、カレンダーの設定、`stay_claims`、見積もり、予約と予約の事象、届出住宅と `regulated_nights`、iCal の取り込みの状態、outbox | `identity`、`listings`、`availability`、`pricing`、`booking`、`compliance-jp` |
| ledger | 口座、仕訳、仕訳の行、冪等キー、送金、照合の結果、為替の相場の写し、outbox | `ledger`、`payouts` |
| content | メッセージ、レビュー、通知、T&S の案件・措置・通報、安全の事故の案件、outbox | `messaging`、`reviews`、`notifier`、`trust-safety` |
| vault | 正確な住所と位置、宿泊者名簿、旅券の番号と画像の参照、送金の口座の番号、本人確認の結果 | `listings`（位置）、`compliance-jp`（名簿）、`identity`（本人確認）、`payouts`（口座） |

- 予約（見積もりの確かめ、`stay_claims` の挿入、`regulated_nights` の挿入、予約の行）は core の 1 つのトランザクションに閉じる（[ADR-0004](0004-booking-state-machine-and-holds.md)、[ADR-0006](0006-regulatory-night-cap-enforcement.md)）。
- お金の仕訳は ledger の 1 つのトランザクションに閉じる。core と ledger は outbox と冪等キーでつなぐ（[ADR-0005](0005-payments-hold-capture-and-ledger.md)）。
- vault の列は封筒の暗号化（KMS のデータキー）で持ち、読む関数は監査の行を同じトランザクションで書く。vault のクラスタへの接続は、上の 4 つのパッケージのサービスの役割だけに許す（security の領域）。

### 自前で作るもの（核）

| 用途 | 置き場所 | 理由 |
| --- | --- | --- |
| 空室の判定、滞在の規則、時刻の計算 | `packages/availability`、`packages/stay-time` | 題材の核（[ADR-0002](0002-availability-representation-and-double-booking.md)） |
| 検索の候補の絞り込み、空室の写し、順位付け | `packages/search`、`services/availability-cache-writer` | 題材の核（[ADR-0003](0003-search-for-date-range-availability.md)） |
| 料金・税・為替の計算 | `packages/pricing`、`packages/tax`、`packages/fx` | 題材の核（[ADR-0008](0008-multi-currency-and-fx.md)） |
| 予約の状態の機械、仮押さえ、キャンセルの精算 | `packages/booking`、`packages/cancellation` | 題材の核（[ADR-0004](0004-booking-state-machine-and-holds.md)） |
| 台帳、送金 | `packages/ledger`、`packages/payouts` | 題材の核（[ADR-0005](0005-payments-hold-capture-and-ledger.md)） |
| T&S の規則のエンジン、審査、ML の学習と評価 | `packages/trust-safety`、`ml/` | 題材の核（[ADR-0009](0009-trust-and-safety-and-ml-boundary.md)） |
| 法令の上限と名簿 | `packages/compliance-jp` | 題材の核（[ADR-0006](0006-regulatory-night-cap-enforcement.md)） |
| iCal の読み書き | `packages/ical` | 取り込みは信用しない入力で、本システムの泊の範囲への直し方が核に近い。RFC 5545 の解析は自前で、対象の部分（`VEVENT` の `DTSTART`・`DTEND`・`UID`・`STATUS`）に限る |

- **使ってよい第三者の汎用の部品**：OpenSearch と Sudachi・ICU、PostgreSQL の拡張（`btree_gist`、PostGIS）、sharp（画像の変換）、PyTorch・scikit-learn・LightGBM などの ML の枠組み、AWS の SDK、OpenTelemetry、IANA の tz データベース。どれも本家と関係がない。
- **外部のサービス**：決済の提供者、為替の相場の提供者、提携銀行、eKYC の提供者、翻訳の提供者、地図のタイルと住所の検索の提供者、SMS、APNs・FCM、SES。どれもアダプターの後ろに置く。
- **使わないもの**：本家のコード・SDK・API のクライアント、本家が作って公開したライブラリ・ツール、本家から取り出したデータ・モデル・重み・地名の辞書。

### 他の案を選ばなかった理由

- **2（マイクロサービス）**：空室・予約・届出住宅の数えが別の DB に分かれ、二重の予約と上限の防止に分散の取引が要る。小さなチームとエージェントには重い。
- **3（1 つのサービス）**：繁忙期の検索の急増と予約が同じタスクの資源を取り合う。
- **b（vault を core の中に）**：名簿・旅券・口座の読み出しの権限を、core を読むすべてのサービスの役割から外すのが難しい。バックアップと保存の期間の規則も分けにくい。
- **c（1 つのクラスタ）**：メッセージ・通知の書き込みが予約の p99 を押し上げる。台帳の変更の手続きを分けられない。
- **y（TypeScript の推論）**：学習は Python になり、前処理を 2 つの言語で書く。

## Consequences

- 良くなること：
  - 他の題材と同じ道具で、エージェントと人が検証できる。
  - 予約は core、お金は ledger の、それぞれ 1 つのトランザクションに閉じ、正しさを DB の制約で守れる。
  - 名簿・旅券・口座を、別のクラスタと鍵と権限で守れる。
- 引き受けるコスト：
  - core と ledger の間の食い違いを、照合で見つけ続ける必要がある。
  - クラスタが 4 つになり、運用と費用が増える（vault は小さい構成で始める）。
  - Python の `ml-inference` と学習の流れを持ち、2 つの言語になる。
  - OpenSearch の運用（索引の作り直し、容量）が増える。

## Confirmation

- 依存の検査（CI）：本家のコード・SDK・公開のライブラリを依存で禁止する。許す汎用の部品の一覧を持つ。学習のデータと地名の辞書の出どころの一覧を持ち、本家から取り出したデータがないことを確かめる。
- lint：パッケージをまたぐ表の書き込みを禁止する。vault の表を上の 4 つのパッケージ以外が読まないことを確かめる。
- 設計の工程の最後の検証で、依存の一覧に本家の実装が核として入っていないことを確かめる。

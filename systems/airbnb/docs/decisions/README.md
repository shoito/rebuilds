# Decisions: Airbnb

Airbnb の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤を引き継ぎ、ドメインごとのパッケージを持つ 1 つのコードベースを入口・Worker ごとのサービスで出す。Aurora は core・ledger・content・vault の 4 クラスタにする。ML だけ Python で書く。検索は OpenSearch を汎用の部品として使う | accepted |
| [0002](0002-availability-representation-and-double-booking.md) | 空室の正本を、予約・仮押さえ・リクエスト・ブロック・取り込みをまとめた `stay_claims` の泊の範囲の行にし、`(listing_id, block_span)` の排他の制約で重なりを DB で 0 にする。準備の日は各予約の後ろの範囲に含める。泊ごとの行はカレンダーの設定にだけ使う。日付は物件の現地の日付で持つ | accepted |
| [0003](0003-search-for-date-range-availability.md) | 日付の範囲の検索は 2 段にする。OpenSearch に空きの区間を `date_range` の欄で入れて「滞在の範囲を含む区間がある」で候補を 300 件に絞り、Valkey の空室の写し（2 年分の泊のビット列と規則の要約）で滞在の規則を確かめる。価格は粗く絞り、料金の要約で正しく絞る。正しさは予約の時の DB で守る | accepted |
| [0004](0004-booking-state-machine-and-holds.md) | 予約を明示の状態の機械にし、作成を `reserveStay` の 1 つの関数と 1 つのトランザクション（見積もりの確かめ、滞在の規則、排他の制約、180 日の数え）に集める。仮押さえは 10 分、リクエストは 24 時間の期限つきの `stay_claims`。冪等キーと見積もりの一意で予約を 1 回に限る。日程の変更は同じ予約の組の行で入れ替える | accepted |
| [0005](0005-payments-hold-capture-and-ledger.md) | 決済は提供者に任せ、即時予約は確定の時に売上を確定し、リクエストはオーソリを取って承認で確定する。お金は予約ごとの預かりの口座を持つ通貨ごとの複式簿記の台帳で持ち、チェックインの予定の時刻 + 24 時間にホストへの支払いへ振り替える。預かりの決着は冪等キーで 1 回に限る | accepted |
| [0006](0006-regulatory-night-cap-enforcement.md) | 届出住宅を `regulated_properties` として持ち、泊の日を `regulated_nights`（届出住宅 × 日）に予約と同じトランザクションで挿入し、年度の数を CHECK 制約で守る。自治体の規則はバージョンの付いた表で持つ。数え方の解釈と他の掲載先の泊の扱いは `legal.*` に置く | accepted |
| [0007](0007-tenancy-host-accounts-and-rls.md) | テナントは 1 つ。本人の表は本人、ホストの表はホストのアカウント（共同ホストの役割）、予約の表はゲストとホストのアカウントの 2 者の FORCE RLS にする。PMS は OAuth のアプリとしてホストのアカウントの範囲で動く。リスティングの見える範囲は `listingVisible()` の 1 つの関数で決める | accepted |
| [0008](0008-multi-currency-and-fx.md) | リスティングの価格はホストの通貨の整数で持つ。表示と支払いはゲストの通貨にでき、換算は見積もりの時の相場の写し（ID つき）で 1 回だけ行う。台帳の仕訳は 1 つの通貨に閉じ、通貨の間は為替の口座で結ぶ。ホストへは自分の通貨で送る | accepted |
| [0009](0009-trust-and-safety-and-ml-boundary.md) | T&S は、同期の検査・規則のエンジン・人の審査・措置の記録の段に分ける。不正・パーティーの危険・偽のリスティングの ML は点と理由のコードだけを出す。料金の提案はホストが決めた範囲でだけ効き、順位付けの ML は影の評価の後に出す。保護される属性を特徴に使わない | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

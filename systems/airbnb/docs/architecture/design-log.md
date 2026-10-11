# Design log: Airbnb

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-10-10：既定案

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも領域の文書の工程と E1〜E20 の PoC・試験で覆りうる。

- **空室の持ち方**：泊の範囲の `stay_claims` と排他の制約。泊ごとの行で空室を持つ案は、日程の変更・長い滞在・準備の日で行の数と更新の数が増え、二重の予約を一意の制約で止められても準備の日を表しにくいので外した（[ADR-0002](../decisions/0002-availability-representation-and-double-booking.md)）。
- **準備の日**：予約の後ろに 0〜2 泊。`block_span = [check_in, check_out + prep_nights)`。前後の両方の間が、各予約の後ろの間だけで守られる（Google Calendar の題材の [ADR-0033](../../../google-calendar/docs/decisions/0033-booking-creation-and-exclusion.md) と同じ考え方）。
- **検索**：OpenSearch の `date_range` の空きの区間と Valkey の空室の写しの 2 段。ステージ 1 の候補は 300 件（[ADR-0003](../decisions/0003-search-for-date-range-availability.md)）。
- **仮押さえ**：確認の画面の支払いの間 10 分、リクエストは 24 時間。どちらも `stay_claims` の行で、期限の切れた行は次の挿入と 1 分ごとの処理で外す（[ADR-0004](../decisions/0004-booking-state-machine-and-holds.md)）。
- **売上の確定**：即時予約は確定の時。リクエストはオーソリを取り、承認で確定（24 時間はオーソリの期限の中）。分割払いは MVP の後（[ADR-0005](../decisions/0005-payments-hold-capture-and-ledger.md)）。
- **送金の時期**：チェックインの予定の時刻 + 24 時間に release し、次の銀行の締めで送る（本家に寄せた既定値。本家の「チェックインの約 24 時間の後」は統合の工程で記事 3133 で確かめた）。28 泊以上の月ごとの送金は MVP の後。
- **サービス料**：ホストだけの型。既定 15%（本家の多くのホストは 15.5%。本システムの値は設定）。ゲストに見せる額は総額。
- **キャンセルポリシー**：MVP は柔軟（チェックインの 24 時間前まで全額、以後は使った泊と追加の 1 泊を残す）、中程度（5 日前まで全額、以後は追加の 1 泊と残りの泊の 50% を残す）、厳格（30 日前まで全額、7〜30 日前は 50%、7 日未満は返金なし）と、7 日以上前に確定した予約の確定から 24 時間の全額の返金。本家の表（[ヘルプの記事 475](https://www.airbnb.com/help/article/475)）に寄せた。違約金の妥当さは法務の L7。
- **レビュー**：チェックアウトから 14 日、同時の公開（本家に寄せる）。公開の前は直せる、公開の後は直せない。
- **iCal**：取り込みは 15 分ごと、2 年先まで、1 リスティング 5 件まで。書き出しは秘密のアドレス（作り直すと古いアドレスは 404）。
- **位置**：ずらした位置は半径 300〜800 m（人口の密度で変える）の中の決まった点。正確な住所はチェックインの 48 時間前ではなく、確定の時にゲストへ出す（本家の時期は**未検証**。予約の確定の後にゲストが場所を確かめられるほうを選んだ）。
- **180 日の上限**：本システムの予約・仮押さえ・リクエストの泊を、予約と同じトランザクションで数える。他の掲載先の泊は、ホストの申告と取り込んだ予定を `legal.minpaku_count_external_nights` の値に従って数えに足す。値の本番での有効化は法務の L1 の後（[ADR-0006](../decisions/0006-regulatory-night-cap-enforcement.md)）。
- **通貨**：表示は主な 10 通貨。支払いは提供者が対応する通貨でゲストの通貨、他は円。ホストへの送金は MVP は円だけ（[ADR-0008](../decisions/0008-multi-currency-and-fx.md)）。
- **税**：消費税・宿泊税・入湯税の計算の枠と税の表を作る。本システムが預かり納めるかは法務の L4 の後。既定は「ホストが納める。本システムは額を出して明細に書く」。
- **保証金**：MVP は持たない。損害の請求（チェックアウトから 14 日）で扱う。
- **本人確認**：ホストは公開の前に必須。ゲストは、日本の物件の名簿のため、チェックインの前に名簿の項目と旅券（日本に住所のない外国人）を入れる。eKYC の確認は規則で求める（初めての予約、高額、危険の点）。
- **メッセージの絞り込み**：予約の前は電話番号・メールアドレス・URL・外部のサービスの ID・外部の支払いへの誘導を伏せる。確定の後は外部の支払いへの誘導だけを止める。範囲は `legal.message_scan_mode`（法務の L9）。
- **ログイン**：パスキーを勧め、メールの一時コードと外部の ID の提供者。パスワードは持たない（accounts の領域で ADR にする）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L14） | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた Story の spec を承認しない |
| ステージ 1 の候補の数、空きの区間の作り方、写しの大きさ | E7 の前の `availability-search-poc` |
| 熱い日付の先着の印、届出住宅のロックの待ち | E9 の前の `hot-dates-booking-poc` |
| 地名の辞書の出どころとライセンス、住所の検索の提供者 | E4 の前の `place-dictionary-poc` |
| iCal の取り込みの間隔と量、相手の対応 | E6 の前の `ical-import-poc` |
| 決済の提供者、為替の相場の提供者、提携銀行、eKYC の提供者、翻訳の提供者、地図の提供者 | E11・E12・E17・E3・E4 の選定の Story |
| core を分ける時期と分け方の鍵、1 リスティングの複数の同じ部屋 | infrastructure・capacity・availability-and-calendars の各領域 |
| 本家の振る舞いで未確認のもの（送金の時期、リクエストの間の日付、正確な住所の時期、料金の提案の方式） | 各領域の文書で公式の資料で確かめる。確かめられなければ未検証のまま、本システムの値を使う |

## 2026-10-10：統合

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。最初の設計の ADR は直接直し、決定を覆した・具体にしたところに日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

- **予約の時の T&S の `hold`**（[ADR-0057](../decisions/0057-ts-decision-points-and-outcomes.md)、[ADR-0035](../decisions/0035-booking-decision-table-and-deadlines.md) の注記）：予約の `hold` は即時予約をリクエストに回す（`route = 'request_by_ts'`）。T&S が 4 時間以内（`ts_review_due_at`、`request_expires_at` を超えない）に判定し、断りは事象 `ts_decline`、認めるのは `ts_clear`。判定の前のホストの承認は 409 `ts_review_pending`。期限までに判定が出なければホストに任せる。DT-BKG-001 に行 13a・21a・21b・21c を足し、35 行・期限の列 8 つにした（[booking-and-holds.md](booking-and-holds.md) の 6.1.1・7.2 節）。
- **T&S の 150ms の超過**：booking-and-holds の領域は「`allow` で進めて事後の審査」、trust-and-safety の領域は「決定的な一致を確かめて `review`」と書いていた。「`booking` のプロセスの中の写しで決定的な一致（`block` の規則）だけを確かめ、当たれば `block`、当たらなければ進める。後から全部の規則で評価し、`allow` でなければ `review`（`ops_hold` と案件）」に揃え、両方の文書と ADR-0057 に書いた。
- **リクエストの断りの理由**：理由のコードを `dates_not_available`・`group_size`・`house_rules_conflict`・`maintenance`・`other` に、表を `request_declines` に揃えた（正本は [booking-and-holds.md](booking-and-holds.md) の 9 節と [ADR-0038](../decisions/0038-booking-requests-and-arrival-info-release.md)。trust-and-safety の領域の別のコードと `booking_decline_reasons` をやめた）。
- **キャンセルの税**（[ADR-0039](../decisions/0039-cancellation-policy-table-and-refund-decision-table.md)・[ADR-0034](../decisions/0034-tax-collection-model.md) の注記）：「使わなかった泊の税を全部返す。ポリシーに依らない。チェックインの前は全額」を 1 つの規則にし、正本を DT-CXL-001（[cancellations-and-changes.md](cancellations-and-changes.md) の 5.3 節）に置いた。ADR-0034 と [taxes.md](taxes.md) は参照だけにした。返した税・残した税の扱いは法務の確認待ち（L4）。
- **新しいホストの送金**（[ADR-0059](../decisions/0059-fake-listing-signals-and-new-host-holds.md)・[ADR-0048](../decisions/0048-release-payout-batching-and-holds.md)・[ADR-0005](../decisions/0005-payments-hold-capture-and-ledger.md) の注記）：ledger の「最初の予約の release から 72 時間」と T&S の「最初の 3 件、チェックアウトの後 24 時間まで、`host_payable_hold`」を、「最初の 3 件の予約は、各予約の `check_out_at` + 24 時間まで、ledger の `payout_holds`（`kind = 'wait'`、理由 `new_host_first_stays`）でそのホストの送金を束から外す。release は時刻どおり、仕訳は動かさない。持ち主は `payouts`」の 1 つにした（[ledger-and-payouts.md](ledger-and-payouts.md) の 7.3 節）。報告があれば T&S が措置の保留をかける。
- **排他の制約の書き方**（[ADR-0002](../decisions/0002-availability-representation-and-double-booking.md) の注記）：見出しと 5 節を `(listing_id =, claim_group <>, block_span &&)` に直した。ADR-0002 の S3 の分け方の鍵も、2 節と同じく置き場所の鍵に直した。
- **S3 の core の分け方**（2 節）：「`listing_id` のハッシュ」を「置き場所の鍵（届出住宅に結んだリスティングは届出住宅の ID、他はリスティングの ID）のハッシュ」に直した（[ADR-0078](../decisions/0078-stage-up-criteria-split-plan-and-unit-cost.md)）。
- **料金の変化と見積もり**（[ADR-0029](../decisions/0029-nightly-price-rules-and-discounts.md)・[ADR-0010](../decisions/0010-listing-states-and-revisions.md) の注記）：料金の規則・日付の上書きの変化は `pricing_version` だけを上げ、`listing_version` を上げない。見積もりは料金の変化で無効にならない（[ADR-0037](../decisions/0037-quote-binding-and-idempotency.md)）。PROP-PRC-003 を直した。
- **正確な住所を出す期間**（[ADR-0038](../decisions/0038-booking-requests-and-arrival-info-release.md) の注記）：`check_out_at + 14 日` と `+ 7 日` が並んでいたので、ADR-0007 の 7 日に揃えた。
- **泊数の上限**：検索の 1〜90 泊、日付を決めない検索の N = 28、税の 90 泊を、MVP の上限の 27 泊に揃えた（[ADR-0017](../decisions/0017-stay-rules-decision-table.md)）。
- **見張りのリスティング**：observability の領域の提案を採り、`listingVisible()` の DT-LST-VIS-001 に行 3a（見張りの利用者だけに見せる）を足した（[listings-and-content.md](listings-and-content.md) の 8 節、[search-and-ranking.md](search-and-ranking.md) の 5.4 節）。
- **名前の揃え**：
  - 共同ホストの役割は `owner`・`full`・`calendar_and_reservations`・`messages_only`（[ADR-0007](../decisions/0007-tenancy-host-accounts-and-rls.md)。calendar-sync・regulatory-compliance-japan・booking-and-holds の `calendar` を直した）。
  - 日付の上書きの列は `calendar_days.nightly_price_override`、書いた主体は `set_by_type`（pricing-and-fees の `calendar_days.price`・`price_source` を直した）。
  - 正確な位置を読む関数は `readExactLocation(viewer, listing_id, purpose)`（security の `openExactLocation` を直した）。本人確認の結果の表は `identity_verifications`（security の `kyc_results` を直した）。
  - Valkey の鍵は `avail:`・`prc:`・`qs:`・`ss:`・`claim:`・`idem:`・`sess:`・`quote:`・`vel:`・`rl:*`・`pmstok:`（infrastructure の `qsum:` を直した）。為替の相場の取り込みは `payments` の `fx-rate-importer`（infrastructure の `ledger` を直した）。
  - 設定の表は `service_fee_schedules`・`cancellation_policies`・`host_cancellation_fee_tables`・`tax_table_versions`・`municipal_rule_sets`・`fx_markup_versions`（delivery の `fee_schedules`・`cancellation_policy_versions` を直した）。`legal.*` の全部の一覧を [data-model/stores.md](data-model/stores.md) の 9.2 節に置き（データモデルの工程で移した）、[delivery.md](delivery.md) の 3.3 節の表に足りない値を足した。
  - runbooks の名前：`double-booking.md`・`calendar-double-booking.md` を [double-booking-or-cap-violation.md](../runbooks/double-booking-or-cap-violation.md)、`safety-incident-response.md` を [safety-incident.md](../runbooks/safety-incident.md)、`payout-delays.md` を [payout-failure.md](../runbooks/payout-failure.md) にした。
- **数の揃え**：為替の上乗せは 200 bp（pricing-and-fees の 8.2 節の例の 2.5% を直し、額を 455.14 ドルに計算し直した）。相場の写しの古さの上限は 2 時間（pricing-and-fees の 6 時間を直した）。S1 の iCal の取得は約 33 件/秒（2 節の 35 を直した）。Valkey の `avail:` は平均 250 バイト（capacity・infrastructure の 0.5 KB を直した）。
- **本家との意図した違い**（1.4 節）：共同ホストの管理を `owner` だけにすること、パスワードを持たないこと、予約の前にゲストの名前と顔の写真を見せないこと、PMS の API の審査、最長 27 泊、厳格の値（本家の厳格と同じと確かめた）、キャンセルの税の返し方、準備の日を含む iCal の書き出し、料金の上書きで無効にならない 15 分の見積もり、ホストだけの 15% のサービス料、位置のずらし方、15 分ごとの iCal の取り込み、`.ics` で終わらない取り込みのアドレス、リクエストの期限、新しいホストの送金の待ち、キャンセルの後のホストの取り分、ホストのキャンセルの罰、正確な住所を出す時期、レビューへの返答を足した。
- **検証の工程での直し（2026-10-10）**：公式の資料を取得し直して、次を確かめ・直した。
  - 本家：キャンセルポリシー（記事 475。本システムの厳格の値が本家の厳格と同じと確かめ、各ポリシーの税の返し方を足した）、サービス料（記事 1857。確認のみ）、送金の時期（記事 3133 で「チェックインの約 24 時間の後」を確かめ、**未検証**を外した。45 日は記事 425）、iCal（記事 99。3 時間、2 年、`.ics`。確認のみ）、レビュー（記事 13。確認のみ）、共同ホスト（記事 1534。確認のみ）。
  - 日本の法令：仲介業者の義務（掲載の前の届出番号の確かめ、表示、6 か月ごとの観光庁への報告、削除の求め）を観光庁のページで確かめ、[regulatory-compliance-japan.md](regulatory-compliance-japan.md) の 3・10 節に足した。180 日の数え方の施行規則第 3 条の本文と、届出番号の形（M と数字）は取得できず**未検証**のまま。名簿の項目と 3 年の保存、定期報告（偶数月の 15 日）は観光庁のページのまま。外国人の旅券の写しの保管は、厚生労働省・国土交通省の指導として自治体の案内で確かめた（ICT の本人確認の要件は**未検証**）。旅館業法の令和 5 年の改正（特定要求行為、名簿の職業の削除と連絡先の追加）を自治体の解説で確かめ、L2 に足した（条文の番号は**未検証**）。
  - 宿泊税：東京都（2027-04-01 から 3%、1 万 3 千円未満は免除、簡易宿所・民泊を足す）、大阪府（4 段階、民泊の清掃料を含む）、福岡市（市 150・450 円と県 50 円。条例の施行は 2020-04-01 と確かめて表に入れた）、京都市（2026-03-01 からの 5 段階）を確かめた。京都市の見直しの告知のページは 404 で、改正前の税率は**未検証**にした。
  - AWS：`rds.global_db_rpo`（20 秒以上、全部の二次の遅れが値を超えると主の commit を止める、2 つのリージョンだけのときは二次のパラメーターを既定に）と、switchover の RPO 0 を確かめた（確認のみ）。
- **品質と運用**：
  - 各領域の「テストと性質」の ID の一覧を [quality.md](../quality.md) の 2.2.2 節に置き、漏れの経路の表（2.2.1 節 H）に見張りのリスティング、予約の前のゲストの名前、`hold` の予約、名簿の権限の行を足した。
  - runbooks の手順を、作ったもの（[incident-response.md](../runbooks/incident-response.md)、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md)、[peak-season-operations.md](../runbooks/peak-season-operations.md)、[double-booking-or-cap-violation.md](../runbooks/double-booking-or-cap-violation.md)、[safety-incident.md](../runbooks/safety-incident.md)、[payout-failure.md](../runbooks/payout-failure.md)）と、計画のものに分けた（[runbooks/README.md](../runbooks/README.md) の 4 節）。
  - 表の目録と ER 図を持つデータモデルの正本は [data-model.md](data-model.md)（データモデルの工程で書いた。下の「決定（2026-10-10、データモデル）」）。
- **数値の正本**：
  - SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。上限は各 ADR と runbooks の 2 節。
  - 期限（仮押さえ 10 分、リクエスト 24 時間とチェックインの 2 時間前の早いほう、見積もり 15 分、T&S の `hold` 4 時間、送金の振り替え チェックイン + 24 時間）は [ADR-0035](../decisions/0035-booking-decision-table-and-deadlines.md) と [booking-and-holds.md](booking-and-holds.md) の 7.3 節。
  - お金（サービス料 15%、為替の上乗せ 200 bp、ホストのキャンセルの罰 10・25・50%、送金の束 銀行の営業日 09:30）は [ADR-0031](../decisions/0031-host-only-service-fee.md)・[ADR-0043](../decisions/0043-fx-rate-snapshots-markup-and-staleness.md)・[ADR-0040](../decisions/0040-host-and-ops-cancellations.md)・[ADR-0048](../decisions/0048-release-payout-batching-and-holds.md)。
  - 法令（180 日、年度、外部の泊、名簿の 3 年）は [ADR-0065](../decisions/0065-regulated-nights-fiscal-year-and-external-overflow.md)・[ADR-0067](../decisions/0067-guest-registry-in-vault.md) と `legal.*`（[data-model/stores.md](data-model/stores.md) の 9.2 節）。
  - 期間（レビュー 14 日、損害の請求 14 日、iCal 15 分）は [ADR-0055](../decisions/0055-review-pairs-and-simultaneous-reveal.md)・[ADR-0050](../decisions/0050-damage-claim-lifecycle-and-guest-charge.md)・[ADR-0021](../decisions/0021-ical-import-pipeline-and-safety.md)。
  - 速さの上限（PMS のアプリとホスト 1 秒 20・瞬間 100、アプリ 1 秒 500、検索 1 セッション 1 秒 10 回、IP ごと 1 分 120 件）は [ADR-0068](../decisions/0068-pms-oauth-apps-scopes-and-rate-limits.md)・[search-and-ranking.md](search-and-ranking.md) の 10 節・[security.md](security.md) の 3.3 節。
  - 負荷と費用のモデル（S1 で月 約 4.3 万 USD、予約 1 件 約 2 円（予約の経路）・約 36 円（全原価の按分））は [capacity.md](capacity.md) と [infrastructure.md](infrastructure.md) の 9 節。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-10-10：データモデル

データモデルの工程で、索引だった [data-model.md](data-model.md) を、表の目録・ER 図・不変条件を持つ正本（[data-model/](data-model/) の 20 のファイル）に書き直した。名前・列・置き場所の食い違いは [data-model.md](data-model.md) の 7 節（D-1〜D-35）で決め、領域の文書を直した。ADR の決定は変えていない。アーキテクチャに関わるものは次の 1 つで、推奨の案で決めた。

- **取り込む iCal のアドレスの暗号化**（D-30）：アドレスは相手の秘密の値を含むが、[ADR-0073](../decisions/0073-key-layout-and-vault-envelope-encryption.md) の用途の鍵に当たるものがなかった。案は (a) `kms-pms-secrets` に文脈 `purpose = ical-url` を足す、(b) 新しい用途の鍵 `kms-ical-secrets` を作る、(c) core の保存時の暗号化だけにする。**(a) を推奨し採った**。外部の連携の秘密（PMS の秘密、Webhook の秘密）と同じ性質で、鍵の数を増やさない。`ical-scheduler` は暗号文を SQS の `ical-fetch` に入れ、DB に接続しない `ical-fetcher` だけが復号する（`kms-pms-secrets` の鍵の政策に `ical-fetcher` の役割と文脈 `ical-url` を足す）。security の領域で ADR-0073 の後継か注記にする。
- 他の決め事（`ledger_accounts` の名前、`_bps`、S3 のバケットの名前、`search_sample_checks`、Webhook の表を content に、`reservation_settlements` の主キー、通知の重複の鍵、最小の形で足した表など）は、データモデルの中の名前と形の決定で、[data-model.md](data-model.md) の 7 節にある。

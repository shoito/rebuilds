# Design log: Mercari

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-10-10：既定案

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも領域の文書の工程と E1〜E18 の PoC・試験で覆りうる。

- **購入の守り方**：DB の条件つきの更新と部分一意の索引を正本にし、Valkey の先着の印を前に置く。Valkey の Lua での在庫の数えは、障害のときに二重に売りうるので正本にしない（[ADR-0002](../decisions/0002-transaction-state-machine-and-single-purchase.md)）。
- **取引の状態**：`created`（支払い待ち）→ `paid`（預かり）→ `shipped` → `delivered` → `received`（受取評価）→ `completed`（売り手の評価と振り替え）。分かれ道は `cancel_requested`、`cancelled`、`disputed`、`payment_expired`。配達済みは受取評価の代わりにしない（[ADR-0002](../decisions/0002-transaction-state-machine-and-single-purchase.md)。決定表の全 38 行は [ADR-0025](../decisions/0025-transaction-decision-table-and-deadline-pause.md)）。
- **期限の既定値**：コンビニ払いの支払いの期限は購入日を含む 3 日目の 23:59:59、受取評価の自動の完了は発送の 9 日後の 13 時（どちらも本家に寄せる）。売り手の評価の期限は受取評価の後 3 日（72 時間。本システムの値。本家は受取評価の翌日以降に自動で完了することを統合の工程で確かめ、1.4 節の意図した違いにした）。発送の期限は売り手の選んだ発送までの日数の最終日の翌日の 23:59:59 で、過ぎたら買い手がキャンセルを申し出られる（本システムの値）。
- **カードの売上の確定**：購入の時にオーソリと同時に確定する。受取評価まで最長で数週間かかり、オーソリの期限を超えうるため（[ADR-0005](../decisions/0005-payments-via-providers-and-capture-at-purchase.md)）。
- **台帳の置き場所**：core と別の Aurora クラスタ（ledger）。取引の状態とお金の仕訳は outbox と冪等キーでつなぐ。同じ DB で 1 つのトランザクションにする案は、S3 で core を分けたときに作り直しになるので外した（[ADR-0003](../decisions/0003-escrow-and-double-entry-ledger.md)）。
- **手数料**：販売の手数料の率は、カテゴリごとにバージョンの付いた表で持つ。既定 10%（本家と同じ。統合の工程で公式のヘルプで確かめた）、1 円未満は切り捨て（本システムの値。[ADR-0034](../decisions/0034-chart-of-accounts-journal-types-and-fee-rounding.md)）。送料は売り手の負担なら売上金から差し引く。
- **売上金の期限**：口座の種類と期限の仕組みは作る。日数（本家は 180 日）と、本人確認で期限のない残高にする規則は `legal.*` に置き、法務の L1 の後に有効にする（[ADR-0004](../decisions/0004-proceeds-model-under-payment-services-act.md)）。
- **振込**：提携銀行の API。予備に全銀の形式のファイル。手数料は 1 回 200 円（本家に寄せた既定値。値は設定）。
- **ポイント**：MVP では本システムが付けるポイント（キャンペーン、補償）だけ。売上金からポイントへの交換は法務の L1 の後。
- **配送**：MVP は運送会社 2 社の匿名の配送（`<Brand>便`）と、匿名でない配送（追跡の番号の入力）。匿名でない配送に変えるには本人確認を求める（本家に寄せる）。
- **値下げ交渉**：MVP はコメントと価格の変更。値下げは、いいねした利用者に通知する（1 出品 24 時間に 1 回まで）。
- **検索**：OpenSearch と Sudachi。売れた品は同じ索引で `status` の欄で分け、既定の検索は販売中だけ（[ADR-0008](../decisions/0008-search-engine-and-index.md)）。
- **保存した検索の照合**：自前の逆索引（OpenSearch の percolator は、S3 の 5 億件の保存した検索と 1 秒 35 件の新しい出品で、索引と照合の費用が大きいので外した）。
- **価格の提案**：売れた品の直近 90 日の四分位（同じカテゴリ・ブランド・状態。件数が 20 に満たなければ親のカテゴリへ広げる）（[ADR-0010](../decisions/0010-ml-boundary-for-pricing-and-recommendations.md)）。
- **T&S**：出品は同期の検査の後に公開し、非同期の分類器で保留にする（公開の前に分類器を待つと、出品の速さ K10 を守れない）。偽ブランドの疑いの高いブランドは、規則で「公開の前に分類器を待つ」に切り替えられる（[ADR-0009](../decisions/0009-trust-and-safety-pipeline-boundary.md)）。
- **本人確認**：外部の eKYC の提供者（マイナンバーカードの IC を優先、書類と顔の照合を予備）。本システムは結果と確認の水準を持ち、書類の画像を長く持たない（期間は法務の L2・L5 の後）。
- **ログイン**：電話番号の SMS の確認を必須にし、パスキーを勧める。パスワードは持たない（[ADR-0066](../decisions/0066-sign-in-sessions-and-devices.md)）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。

## 2026-10-10：統合

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。最初の設計の ADR は直接直し、決定を覆した・具体にしたところに日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

- **残高の hold の冪等キー**（[ADR-0003](../decisions/0003-escrow-and-double-entry-ledger.md) の注記）：カードの hold と残高の hold が同じ冪等キー `(transaction, <id>, hold)` だったので、組み合わせの支払いで 2 つ目が書けなかった。残高の hold を `(transaction, <id>, hold_balance)`（型 `hold_balance`）に分けた（[ADR-0040](../decisions/0040-balance-spend-order-and-reservation.md)、[ledger-and-proceeds.md](ledger-and-proceeds.md) の 4.3 節）。
- **取り消しの後の出品**（[ADR-0002](../decisions/0002-transaction-state-machine-and-single-purchase.md) の注記）：取り消しの後の出品は `on_sale` に戻すが、発送の後の取り消し（紛争の判断）は `paused` に戻す（[ADR-0027](../decisions/0027-cancellation-rules-and-listing-restoration.md)）。DT-LST-001 の行 7a で表した（[listings-and-photos.md](listings-and-photos.md) の 4.2 節）。先着の印は取り消しで比べて消す（[ADR-0026](../decisions/0026-hot-listing-purchase-admission.md)）。
- **匿名の配送の `shipped` の条件**（[ADR-0006](../decisions/0006-shipping-orchestration-via-carriers.md) の注記）：「`accepted` のない匿名の配送は `shipped` にならない」を「順位 1 以上の運送会社の事象のない配送は `shipped` にならない」と読む（[ADR-0042](../decisions/0042-carrier-event-ranking-and-implied-acceptance.md)）。`delivered` の後の例外（`lost` など）は取引に渡さず、運用の待ち行列にだけ入れる。[quality.md](../quality.md) の 2.2.1 節 D と [security.md](security.md) の 3.2 節を揃えた。
- **保存した検索のまとめの窓**：3 分（[ADR-0023](../decisions/0023-saved-search-alert-windows-and-caps.md)）。1.3 節 E の「15 分」と [runbooks/](../runbooks/README.md) の 2 節を直した。NFR-008 は出品の公開・値下げの commit から数え、窓を含む（3 節）。運用で伸ばす口は `ops.saved_search_digest_minutes`。
- **索引の件数**：販売中・取引中に、売れた品（取引の完了 × 365 日）を足して数え直した。S1 約 7,000 万、S2 約 2.8 億、S3 約 8.5 億（2 節）。[search-and-discovery.md](search-and-discovery.md) の 4.1 節、[capacity.md](capacity.md) の 3 節、[ADR-0008](../decisions/0008-search-engine-and-index.md) の注記を直した。S2 の売れた品の索引の分割の準備（2.4 億件、[ADR-0074](../decisions/0074-stage-up-criteria-and-split-plan.md)）は S2 の中で当たる。
- **本家との意図した違い**（1.4 節）：発送の後の取り消しの `paused`、72 時間の売り手の評価の期限、返金で戻ったポイントの最短 30 日、コンビニ払いの手数料 100 円、依頼の時点の振込の不能での手数料の返し、パスワードと外のアカウントのログインを持たないこと、退会の流れ、静かな時間、写真 10 枚、自動の完了の 1 つの形、評価の 3 段、値下げの通知、売れた品の検索のログイン、メッセージの画像なしを足した。評価を完了まで伏せて同時に公開するのは、本家と同じだと確かめた（違いではない）。題名 40 文字も本家と同じ。説明 1,000 文字の本家の上限は**未検証**。
- **法務の番号**：未成年を L12、特定電子メール法（案内のメール）を L13 として [intent.md](../intent.md) に足した。どちらも法務の確認待ち。[accounts-and-devices.md](accounts-and-devices.md)・[identity-verification.md](identity-verification.md)・[categories-brands-and-pricing-suggestions.md](categories-brands-and-pricing-suggestions.md)・[notifications.md](notifications.md)・[ADR-0065](../decisions/0065-notification-preferences-tokens-and-email.md)・[ADR-0068](../decisions/0068-account-deletion-and-minors.md) から参照した。
- **ledger を分ける段階**：S2 は熱い口座のスロット（`fee_revenue`・`psp_receivable`・`shipping_payable` を 16 に分け、残高の行を持たない）、S3 は口座の持ち主のハッシュでの分割（[ADR-0074](../decisions/0074-stage-up-criteria-and-split-plan.md)）。2 節の表と [roadmap.md](../roadmap.md) の延期の一覧を揃えた。
- **領域をまたぐ提案**：
  - 見張りの出品を `listingVisible()` で見張りの利用者だけに見せる：**採る**。見張りの出品が本物の利用者の検索・購入に出ると、見張りの結果が汚れ、本物の購入で取引が残る。`sentinel` の印を持つ出品は、`sentinel` の印を持つ閲覧者のときだけ `visible`、それ以外は `hidden` にする行を `listingVisible()` の決定表の先頭（措置の行の後）に置く（[ADR-0007](../decisions/0007-single-tenant-and-party-visibility.md) の注記、[observability.md](observability.md) の 4 節、[search-and-discovery.md](search-and-discovery.md) の 5.4 節）。
  - DR の切り替えの間の期限を、止まった時間だけ延ばす：**採る**。切り替えの間は利用者が支払い・発送・受取評価をできず、利用者の責任でない期限切れになる。切り替えを始めた時刻を全体の止める時刻として `dr_events` に書き、`deadline-runner` を再開する前に、終わっていない取引の生きている期限を、止まった時間だけ後ろへずらす（[ADR-0025](../decisions/0025-transaction-decision-table-and-deadline-pause.md) の「ずらす」と同じ規則。注記を足した）。S1 で進行中の取引 50 万件前後を 1 万件ずつ更新し、RTO の照合の段の中で終える。
  - 売れた品の検索をログインした利用者に限る：**採る**。売れた品の価格の一覧は、相場のデータとして持ち出しの価値が最も高い。電話番号で確かめたアカウントごとの速さの上限が効くので、IP だけの上限より強い。売り手の価格の提案はログインした出品の画面で使うので影響しない。ログインしていない利用者には販売中の検索だけを出す（[search-and-discovery.md](search-and-discovery.md) の 5.6 節、[security.md](security.md) の 3.3 節、[ADR-0008](../decisions/0008-search-engine-and-index.md) の注記）。
- **人気の出品の数**（[ADR-0026](../decisions/0026-hot-listing-purchase-admission.md) の注記）：同時実行 4、`lock_timeout` 200ms、Valkey がないときに 1 出品の DB に同時に届く購入は 48 件まで。48 件を守るため、`transactions` のタスクの最大を 12 にした（[capacity.md](capacity.md) の 4.2・5 節。1 秒 5,000 件の CPU は約 5 vCPU で、12 タスクで足りる）。[transactions-and-state-machine.md](transactions-and-state-machine.md) の 5.3 節、[infrastructure.md](infrastructure.md) の 7.4 節と揃えた。
- **名前の揃え**：
  - 本人確認の水準：`legal.balance_requires_kyc_level` の開発の値を `verified_document` にした（`ekyc_verified` は水準の名前にない。[ADR-0056](../decisions/0056-ekyc-provider-and-verification-levels.md)）。
  - 振込の上限の `legal.*`：`legal.payout_limit_yen.{level}`・`legal.payout_monthly_limit_yen.{level}` に揃えた（[identity-verification.md](identity-verification.md) の 5 節。[payouts-and-points.md](payouts-and-points.md) を直した）。
  - 本人確認の閲覧の権限は `kyc.view`、鍵は `kms-kyc`（[ADR-0070](../decisions/0070-operator-access-vault-reveal-and-audit.md)、[ADR-0069](../decisions/0069-key-layout-and-vault-envelope-encryption.md)。[ADR-0057](../decisions/0057-identity-data-minimization-and-retention.md) と [identity-verification.md](identity-verification.md) の `kyc_viewer` を直した）。
  - 価格の提案の Valkey の鍵は `price:*`（[ADR-0016](../decisions/0016-price-suggestion-from-sold-percentiles.md)。[infrastructure.md](infrastructure.md) と [ADR-0072](../decisions/0072-accounts-network-and-egress.md) の `price_stats:*` を直した）。
  - 閲覧の履歴の表は `view_history`（[security.md](security.md) の `browsing_history` を直した）。
  - 発送までの日数のコードは `1_2`・`2_3`・`4_7`（[transactions-and-state-machine.md](transactions-and-state-machine.md) を [listings-and-photos.md](listings-and-photos.md) に揃えた）。
  - 照合の記録の表は、core が `reconciliation_runs`・`reconciliation_findings`、ledger が `recon_runs`・`recon_breaks`（[data-model.md](data-model.md)）。
  - runbooks の名前：`ledger-settlement-mismatch.md` を [ledger-reconciliation-mismatch.md](../runbooks/ledger-reconciliation-mismatch.md)、`payout-failures.md` を [payout-failure.md](../runbooks/payout-failure.md) にした。
- **検証の工程での直し（2026-10-10）**：公式の資料を取得し直して、次を確かめ・直した。
  - 本家：販売の手数料 10%（[ヘルプの記事 65](https://help.jp.mercari.com/guide/articles/65/)。未検証を外した）、振込の手数料 200 円と売上金の 180 日（記事 96）、支払いの期限と自動の完了（記事 61sell・115）、配送の方法と料金（公式のコラム。ゆうパケットポストの資材の代金を足した）、写真 20 枚・商品名 40 文字・価格の幅（記事 62）、評価の 2 段と完了での同時の公開と売り手の評価がないときの翌日以降の完了（記事 1016・115）、保存した検索の 30 日（記事 239）。らくらくメルカリ便の自動の完了が「配達完了から 2 日後の 13 時」であることを新たに確かめ、1.4 節に足した。商品説明の上限、手数料の端数、コンビニ払いの手数料は確かめられず**未検証**のまま。
  - AWS：`rds.global_db_rpo` は Aurora PostgreSQL の Global Database のパラメーターで、値は 20 秒以上、全部の二次の RPO の遅れが値を超えると主の commit を止め、2 つのリージョンだけのときは二次のリージョンのパラメーターのグループを既定のままにするよう勧める。switchover は RPO 0。[ADR-0073](../decisions/0073-aurora-layout-osaka-dr-and-ledger-rpo.md) と [infrastructure.md](infrastructure.md) の 7.2 節の記述のまま（確認のみ）。
  - 日本の法令：資金決済法の 2025 年の改正（国境を跨ぐ収納代行への資金移動業の規制の適用）を金融庁の説明資料で確かめ、[intent.md](../intent.md) の出典に足した。国内の収納代行の扱いと本システムへの当てはめは法務の確認待ち（L1）。犯罪収益移転防止法の非対面の本人確認の「ホ」方式が 2027 年 4 月 1 日から使えなくなることを法律事務所の解説で確かめた（改正命令の本文は**未検証**）。`document_face`（書類と顔の照合）が取引時確認の方式として足りなくなりうるので、[identity-verification.md](identity-verification.md) と [ADR-0056](../decisions/0056-ekyc-provider-and-verification-levels.md) に注記を足した（L2）。古物営業法の古物競りあっせん業は競りの方法の売買の場で、フリーマーケットのサイトの運営は届出の要らない例に挙がることを愛知県警察の資料で確かめた（当てはめは L6）。取引デジタルプラットフォーム消費者保護法は日本法令外国語訳データベースの概要のまま（L7）。
- **品質と運用**：
  - 各領域の文書の「テストと性質」の ID の一覧を [quality.md](../quality.md) の 2.2.2 節に置いた。漏れの経路の表（2.2.1 節 G）に見張りの出品と売れた品の検索の行を足した。
  - runbooks の手順を、作ったもの（[incident-response.md](../runbooks/incident-response.md)、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md)、[hot-listing-or-campaign-day.md](../runbooks/hot-listing-or-campaign-day.md)、[ledger-reconciliation-mismatch.md](../runbooks/ledger-reconciliation-mismatch.md)、[payout-failure.md](../runbooks/payout-failure.md)、[account-takeover.md](../runbooks/account-takeover.md)）と、計画のものに分けた（[runbooks/README.md](../runbooks/README.md) の 4 節）。
  - 表と置き場所の索引は [data-model.md](data-model.md)。ER 図を含む正本は、データモデルの工程で書いた（下の「決定（2026-10-10、データモデル）」）。
- **数値の正本**：
  - SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。上限は各 ADR と runbooks の 2 節。
  - 期限（支払い 3 日目の 23:59:59、カード 30 分、発送の期限、キャンセルの応答 48 時間、自動の完了 発送の 9 日後の 13:00、売り手の評価 72 時間）は [ADR-0025](../decisions/0025-transaction-decision-table-and-deadline-pause.md) と [transactions-and-state-machine.md](transactions-and-state-machine.md) の 7.1 節。
  - お金（販売の手数料 10%、振込の手数料 200 円、コンビニ払いの手数料 100 円、売上金の期限 180 日は `legal.*` の開発の値、振込の待ち 72 時間）は [ADR-0034](../decisions/0034-chart-of-accounts-journal-types-and-fee-rounding.md)・[ADR-0031](../decisions/0031-konbini-pending-payments-and-late-payments.md)・[ADR-0035](../decisions/0035-proceeds-lots-expiry-and-kyc-conversion.md)・[ADR-0038](../decisions/0038-payout-batching-execution-and-failure-handling.md)・[ADR-0067](../decisions/0067-account-takeover-step-up-and-payout-holds.md)。
  - 上限（写真 10 枚・1 枚 20 MB、価格の変更 1 出品 1 日 10 回、`engagement` のプッシュ 1 人 1 日 30 通、保存した検索のプッシュ 1 人 1 日 20 通）は [ADR-0012](../decisions/0012-photo-pipeline-and-perceptual-hashes.md)・[listings-and-photos.md](listings-and-photos.md) の 9 節・[ADR-0064](../decisions/0064-fanout-batching-quiet-hours-and-caps.md)・[ADR-0023](../decisions/0023-saved-search-alert-windows-and-caps.md)。
  - 運用の承認の上限（返金 3 万円、補償 3,000 円、1 日 3 万円）は [ADR-0060](../decisions/0060-ops-money-interventions-and-proceeds-hold.md)。
  - 負荷と費用のモデル（S1 で月 約 8.1 万 USD、取引 1 件 約 4 円）は [capacity.md](capacity.md)、単位あたりの原価は [infrastructure.md](infrastructure.md) の 9 節。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-10-10：データモデル

データモデルの工程で、索引だった [data-model.md](data-model.md) を、表の目録と ER 図を持つ正本（[data-model/](data-model/) の 15 のファイル）に書き直した。名前・列・置き場所の決め（D-1〜D-30）と、直した領域の文書の一覧は [data-model.md](data-model.md) の 7 節。ADR の決定は変えていない。アーキテクチャに関わる 2 件は推奨の案で次のとおり決めた。

- **T&S の暗号文の鍵**：取引のメッセージ・コメントの保持の写し、通報の証拠、権利者の連絡先、法令の申出者は「T&S の鍵」で暗号化すると決まっていたが（[messaging-and-comments.md](messaging-and-comments.md) の 4.3 節、[trust-and-safety.md](trust-and-safety.md) の 17 節）、[ADR-0069](../decisions/0069-key-layout-and-vault-envelope-encryption.md) の鍵の一覧にない。**推奨：KMS の鍵 `kms-ts` を足し、`Decrypt` を `trust-safety` のタスクの役割と、法務の書き出しのジョブだけに与える**。データの鍵は content の `data_keys`（`purpose = 'ts'`）に包んで置く。案：content の保存時の鍵 `kms-content` を使う（採らない。DB を読める役割がそのまま本文を読めてしまう）。security の領域で ADR-0069 に注記するか後継の ADR を起票する。
- **記録のバケット `records`**：決済・運送会社の Webhook の本文、外部の明細、全銀の形式のファイル、分割の表の古い区切りの写しを、S3 の `records` のバケットにまとめ、接頭辞ごとに KMS の鍵と書ける役割を分ける。ledger の物（明細、全銀のファイル）は Object Lock のガバナンスのモードで 10 年（[data-model/stores.md](data-model/stores.md) の 3 節）。案：接頭辞ごとに別のバケット（採らない。ライフサイクルと大阪への写しの設定が増えるだけで、鍵と役割の分けは政策でできる）。[infrastructure.md](infrastructure.md) の 4.2 節の S3 の一覧に足した。

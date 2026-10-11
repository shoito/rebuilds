# Design log: Shopify

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-10-10：既定案

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも領域の文書の工程と E1〜E18 の PoC・試験で覆りうる。

- **ポッドの範囲**：アプリのサービスまで含む完全なセル。本家（アプリのサーバーを共有）と違う。DB の接続の数と、うるさい隣人の影響をポッドに閉じる（[ADR-0002](../decisions/0002-pods-and-shop-placement.md)）。
- **ショップの移し替え**：自前の `shop-mover`（PostgreSQL の論理デコード）。Ghostferry は MySQL 向けで、核の設計を自前にするため使わない（[ADR-0002](../decisions/0002-pods-and-shop-placement.md)）。
- **在庫を引き当てる時点**：支払いの開始（チェックアウトの送信）。カートに入れた時点では引き当てない。期限は通常 15 分、フラッシュセールのショップは 10 分（[ADR-0004](../decisions/0004-inventory-reservation-model.md)）。
- **熱い品目**：在庫を枠の行に分ける（既定 1、フラッシュセールの品目は 32）。Valkey で数えて正本にする案は、障害のときに売り越すので外した（[ADR-0004](../decisions/0004-inventory-reservation-model.md)）。
- **非同期の決済（コンビニ払い・銀行振込）**：支払いの番号を出した時点で「支払い待ち」の注文を作り、在庫を確定する。支払いの期限（提供者の設定。既定 3 日）を過ぎたら注文を取り消し、在庫を戻す（payments-integration の領域）。
- **売上の確定の時点**：既定は注文の作成と同時の自動の確定。事業者は「発送の時に確定」を選べる（オーソリの期限は提供者の値）。
- **待合室**：自前（CloudFront Functions の許可証の確かめと、`waiting-room` の列）。開始の前に来た人は乱数で並べ、以後は来た順（flash-sales-and-queueing の領域）。
- **ボット対策**：AWS WAF の Bot Control と CAPTCHA・Challenge の動作を使い、許可証、1 人あたりの数の上限、重複の検出は自前。外部のチャレンジの提供者は E13 の選定で比べる。
- **ストアフロントの描画の場所**：東京の元（Fargate）で描画し、エッジでキャッシュする。エッジでの描画（Lambda@Edge）は、日本の買い手には東京からの往復が短く、利点が小さいので外した。
- **キャッシュの無効化**：ショップ（大きなショップは商品・コレクション）の世代の番号をキャッシュの鍵に入れ、KeyValueStore で配る。CloudFront の無効化の API はパスの単位で、数と費用の上限があるので主にしない。
- **テーマの言語**：自前（仮の名前は Loom、拡張子 `.loom`）。`{{ }}`・`{% %}` の形は、Jinja や Django にもある公開の形として使う。既定で HTML をエスケープする（[ADR-0007](../decisions/0007-theme-language-design.md)）。
- **関数の砂場**：Wasmtime（燃料）。V8 の isolate は燃料の仕組みがなく決定的な上限を付けられないので外した（[ADR-0008](../decisions/0008-extension-sandbox-wasm.md)）。
- **Admin API**：GraphQL だけ、四半期ごとの日付のバージョン、費用の上限は本家に寄せる（[ADR-0009](../decisions/0009-admin-api-graphql-and-cost-limits.md)）。
- **検索**：OpenSearch（汎用の部品）。順位付けとおすすめは自前の規則。search-and-recommendations の領域で ADR にする。
- **ギフトカード・ポイント**：MVP の後。法務の L5 の後に設計する。
- **運送会社**：MVP は 3 社の送り状の CSV（書き出しと追跡の番号の取り込み）と、選定した 1 社の API。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。

## 2026-10-10：統合

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。最初の設計の ADR は直接直し、決定を覆した・具体にしたところに日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

- **振り分けと KeyValueStore**（[ADR-0002](../decisions/0002-pods-and-shop-placement.md) の注記）：KeyValueStore は 1 つの保存が 5 MB で、全ホストは入らない。要求の多いホストだけの「熱い集まり」（4 MB まで）と、集まりにないホストを中継する全体の `edge-router` にした（[ADR-0010](../decisions/0010-shop-routing-hot-set-and-custom-domains.md)）。[storefront-api-and-caching.md](storefront-api-and-caching.md) の 4.1 節で、値のないホストは `edge-router` へ送る形に直した。
- **ポッドをまたぐ経路 P5**（ADR-0002 の注記）：全体の面からポッドへの読み出しの写し（アプリの定義、プランの上限、言語と通貨の表）を P5 として足した。[app-platform-and-apis.md](app-platform-and-apis.md) の持ち越しはこれで閉じた。写しの表と移し替えの表を、[ADR-0003](../decisions/0003-tenancy-and-rls.md) の RLS の外の表の一覧に足した（ADR-0003 の注記）。
- **移し替えの切り替え**（ADR-0002 の注記）：「伝わる前の要求は 421 で再送させる」を、[ADR-0012](../decisions/0012-shop-mover-logical-decoding-and-cutover.md) の 15 分（最大 24 時間）の中継の窓に置き換えた。`x-<brand>-pod-id` の不一致の 421 は残す。[quality.md](../quality.md) の 2.2.1 節 I と [roadmap.md](../roadmap.md) の `shop-directory-and-routing` も直した。
- **Webhook の本文**（ADR-0002 の注記）：全体の `webhook-dispatcher` は本文を運ぶが保存しない（[ADR-0062](../decisions/0062-webhook-egress-and-payload-custody.md)）。「全体の面はショップのデータを持たない」は「保存しない」と読む。
- **非同期の部品の置き場所**（1.2 節）：`cache-invalidator`・`search-indexer`・`notifier` はポッドの中に置き、`webhook-dispatcher` だけを全体の面に置く（[infrastructure.md](infrastructure.md) の 5 節）。1.2 節の図と表を直し、`edge-router`・`billing` を足した。
- **在庫の数の置き場所**（[ADR-0004](../decisions/0004-inventory-reservation-model.md) の注記）：`available`・`reserved`・`committed` は枠の行、`on_hand`・`unavailable` は拠点の行（[ADR-0020](../decisions/0020-inventory-slot-counters-and-reservation-sweep.md)）。図の `fulfilled`・`restocked` は引き当ての行の状態でなく、注文の側の状態として持つ。
- **決済のアダプター**（[ADR-0006](../decisions/0006-payments-via-providers.md) の注記）：`findByReference` を必須の操作に足した（[ADR-0035](../decisions/0035-payment-attempt-states-and-result-normalization.md)）。事業者の提供者・運送会社の認証の情報は、Secrets Manager でなく、ポッドの DB の KMS の封筒の暗号に置く（[ADR-0066](../decisions/0066-encryption-and-key-layout.md)。ADR-0042 の注記、payments-integration・orders-and-fulfillment の表を直した）。
- **S3 の置き場所**：ショップのデータの S3 のキーは、ポッドに依らない `shops/<shop_id>/…` に揃えた（メディア、テーマ、書き出し、一括の操作の結果、サイトマップ、送り状、監査ログの写しは `audit/shops/<shop_id>/…`）。移し替えで S3 を動かさない。
- **Valkey の鍵**：ショップのデータの鍵は全部 `{<shop_id>}:<種類>:…` で始める（クラスタのハッシュタグ。[ADR-0028](../decisions/0028-cart-storage-in-valkey.md) の注記）。ポッドの運用の鍵は `sys:`、全体の待合室の鍵は `wr:{<sale_id>}:` で、ショップのデータの値を持たない。一覧は [data-model.md](data-model.md)。
- **検索のシャード**（[ADR-0052](../decisions/0052-search-index-per-pod-and-japanese-analysis.md) の注記）：主のシャードを 12 から 3 にし、`routing_partition_size` を使わない。索引はポッドあたり 6 GB 前後で、12 では 1 シャード 0.5 GB ほどと小さすぎるため。
- **返金の税の方式の名前**（[ADR-0017](../decisions/0017-consumption-tax-calculation-and-rounding.md)・[ADR-0043](../decisions/0043-refund-calculation-from-unit-allocations.md) の注記）：taxes-and-invoices の `difference` と returns-and-refunds の「差分（D）」が逆の中身を指していたので、`independent`（返す分だけで計算）と `recompute`（返品の後の注文の税額との差）に揃えた。どちらを使うかは法務の確認待ち（L4）のまま。
- **関数の輸入**（[ADR-0008](../decisions/0008-extension-sandbox-wasm.md) の注記）：`proc_exit` を許す（[ADR-0058](../decisions/0058-function-io-contract.md)）。
- **外貨の通貨（仮、PM の判断待ち）**：intent の MVP は「表示と支払いの通貨」を含むが、外貨のマーケットは海外への販売を伴い、越境の税（法務の L4）と E22 の設計が要る。MVP では仕組み（マーケット、固定の価格、換算と丸め、為替の写し）を作って試験し、外貨のマーケットの有効化は `release.markets-foreign-currency` の裏に置く。MVP で買い手が使える通貨は JPY だけ。[intent.md](../intent.md) と [roadmap.md](../roadmap.md) を同じ書き方に直した。**残る問い**：MVP の GA の判定に外貨の表示（支払いは JPY）だけを含めるか、E22 まで全部を止めるか。
- **本家との意図した違い**（1.4 節）：振り分け、P5、移し替えの中継の窓、売上の確定の時点（最初の発送）、同じ行の複数の商品の割引を持たない、別の行の商品の割引は常に両立、組み合わせの規則を全ショップで同じに、Webhook の購読を消さずに止める、Webhook の専用の秘密を足した。
- **見張りのポッド `p00`**：S1 のポッドは共有 4・隔離 1・見張り 1 になった（2 節、[ADR-0011](../decisions/0011-shop-placement-and-rebalancing.md)）。
- **費用**（2.1 節）：S1 の本番の月の原価は約 18.7 万 USD、共有のポッド 1 つ 約 5,700 USD。capacity と infrastructure の 9 節の値に揃え、目標「1 ポッド月 100 万円以下」に収まることを確かめた。
- **Story**：領域の文書が足した Story（`checkout-submit-idempotency`、`checkout-admission-limits`、`purchase-limits`、`surge-auto-queue`、`inventory-location-selection`、`inventory-movements`、`discount-function-merge`、`payment-inquiry-and-circuit-breaker` ほか 26 件）を [roadmap.md](../roadmap.md) に足し、E6 の `cart` を「Valkey が正本、ログインした買い手のカートだけ 30 分ごとに DB へ写す」に直した。
- **検証の工程での直し（2026-10-10）**：公式の資料を取得し直して、次を確かめ・直した。
  - CloudFront の KeyValueStore は鍵 512 バイト・値 1 KB・保存 5 MB・関数に 1 つ・1 回の更新 50 鍵か 3 MB・アカウントに 200。マルチテナントの配信のテナントはアカウントに 1 万（引き上げ可）、別名はテナントに 100、継続のデプロイは使えない。タグでの無効化（`CacheTagConfig`、1 オブジェクト 50 タグ）はテナントにも使える（確認のみ）。
  - CloudFront の VPC origin のアカウントをまたぐ共有（AWS RAM）は 2025-11-06 の発表（確認のみ）。
  - Aurora PostgreSQL 18 は 2026-06 に一般提供、2026-08 に 18.4（[infrastructure.md](infrastructure.md) の 4 節の未検証を外し、18 で始める）。
  - Aurora の書き込みの交代の後の論理レプリケーションのスロットは、公式の文書に記述がない。AWS のブログは交代の後に作り直すと書く。**未検証**のまま、失う前提で設計した（[shops-and-pods.md](shops-and-pods.md) の 8.6 節）。
  - Wasmtime の `consume_fuel` は決定的に止める仕組みで、燃料が尽きるとトラップ。`epoch_interruption` は決定的でない（確認のみ。ADR-0008 の使い分けのとおり）。
  - 国税庁の Q&A（令和 8 年 5 月改訂）の問 57：一の適格請求書につき税率ごとに 1 回の端数処理、方法は任意、商品ごとの端数処理の合計は不可。[taxes-and-invoices.md](taxes-and-invoices.md) の未検証を外した。当てはめ（本システムが出すレシートへの適用）は法務の確認待ち（L4）のまま。
  - 消費者庁の最終確認画面のガイドライン：令和 3 年の改正の第 12 条の 6 の考え方。意見募集（2021-11-24）の入口だけを確かめ、確定したガイドラインの本文は取得できなかった（**未検証**。intent の出典に書いた）。表示の事項の当てはめは法務の確認待ち（L1）。
  - 本家の Functions の上限（命令 1,100 万、メモリー 10,000 kB、スタック 512 kB、テーブル 4・要素 1 万、入力 128 kB・出力 20 kB、200 行を超えると比例、入力のクエリ 3,000 バイト・費用 30）、Admin API の回復（100・200・1,000・2,000）と 1 クエリ 1,000、Webhook の 4 時間に 8 回と応答 5 秒（確認のみ）。Webhook の失敗が続いたときに消す購読の種類は文書に書いていないので、「Admin API で作った購読を消す」を「購読を消す」に直した。
- **品質と運用**：
  - 各領域の文書の「テスト」「data-model への項目」の提案を反映した。[quality.md](../quality.md) に、性質と決定表の一覧（2.2.2 節）、漏れの経路の表の行、判定基準、Epic の合否基準を足した。
  - runbooks の手順を、作ったもの（[incident-response.md](../runbooks/incident-response.md)、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md)、[flash-sale-operations.md](../runbooks/flash-sale-operations.md)、[shop-move.md](../runbooks/shop-move.md)、[oversell-or-paid-without-order.md](../runbooks/oversell-or-paid-without-order.md)）と計画のものに分けて一覧にし、2 節に新しいフラグ（`ops.inventory_item_sales_enabled` ほか）を足した。
  - 表と置き場所は [data-model.md](data-model.md)（その後のデータモデルの工程で正本にした。下の「決定（2026-10-10、データモデル）」）。
- **数値の正本**：
  - SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。上限は各 ADR と runbooks の 2 節。
  - 引き当ての期限 15 分（フラッシュセールのショップ 10 分）と枠（既定 1、セール 32、1〜64）は [ADR-0004](../decisions/0004-inventory-reservation-model.md)・[ADR-0020](../decisions/0020-inventory-slot-counters-and-reservation-sweep.md)。許可証 15 分は [ADR-0025](../decisions/0025-queue-pass-tokens.md)。
  - 関数の上限（燃料 1,000 万、メモリー 10 MiB、入力 128 KiB、出力 20 KiB、1 段 50ms）は [ADR-0008](../decisions/0008-extension-sandbox-wasm.md)。Admin API の費用（1 クエリ 1,000、回復 100・200・1,000/秒、容量はその 10 倍）は [ADR-0009](../decisions/0009-admin-api-graphql-and-cost-limits.md)。Webhook の送り直し（4 時間に 8 回、1・4・10・20・30・45・60・70 分）は [ADR-0061](../decisions/0061-webhook-delivery-and-signing.md)。KeyValueStore の熱い集まり（4 MB、3.5 MB で外し始め、固定の枠 1 MB）は [ADR-0010](../decisions/0010-shop-routing-hot-set-and-custom-domains.md)。
  - 負荷と費用のモデルは [capacity.md](capacity.md)、単位あたりの原価は [infrastructure.md](infrastructure.md) の 9 節。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-10-10：データモデル

[data-model.md](data-model.md) を、索引からデータモデルの正本に書き直した。規約（ID、テナントと RLS、全体とポッド、金額、税、バージョン、分割・保持・削除、暗号化）、全体の ER 図とチェックアウトから配送までの道筋の図、[data-model/](data-model/) の 19 の領域のファイル（Aurora の 205 表の列・キー・索引・CHECK・RLS・分割・保持・S1 の量と、ER 図 20 個）と、Aurora の外の置き場所（[stores.md](data-model/stores.md)）を持つ。名前と列の食い違いは data-model の 7 節（D-1〜D-41）で決め、領域の文書を直した。ADR の決定は変えていない。

アーキテクチャに関わる次の 2 つは、PM の方針（法務でない判断は推奨の案）により推奨の案で決め、ADR に注記した。

- **ポッドから全体の待合室への受け渡し（D-16）**：待合室（全体の面）は、ポッドのセールの設定（開始・終わり、`rate_cap`、`k`・`q`）と在庫の予算の材料（`U = Σavailable`、`R = Σreserved`、5 秒ごと）を要るが、[flash-sales-and-queueing.md](flash-sales-and-queueing.md) の 5.4 節は「DB の読み出しの写しから」と書くだけで、経路が ADR-0002 の P1〜P5 にない。
  - **決定：案 a（推奨）**。P3（各ポッドが SNS へ出したものを全体で集める）に含める。ポッドの `workers` が `sale/config`・`sale/budget` の事象を出し、`waiting-room` が全体の `waiting_room_sales` と Valkey の `wr:{<sale_id>}:budget` に当てる。値は ID と数だけで、全体の面はショップのデータを持たない。[ADR-0002](../decisions/0002-pods-and-shop-placement.md) の P3 に注記した。
  - 案 b：P6 として新しい経路を足す（ADR-0002 を直す）。中身は案 a と同じで、名前だけが増える。
  - 案 c：`waiting-room` がポッドの読み出しの写しを直接読む。「1 つの要求は 1 つのポッドだけ」と全体の面の分離に反するので外した。
- **X1 の発見の索引（D-6）**：[ADR-0003](../decisions/0003-tenancy-and-rls.md) は「`shop_id` を主キーと索引の先頭に置く」とするが、領域の文書の引き当ての掃除・inbox・照会の予定は `shop_id` を先頭にしない部分索引（`(expires_at) WHERE state = 'reserved'` など）を置いていた。
  - **決定：案 a（推奨）**。決めた表の部分索引だけを例外にし、その索引は `sys` の `SECURITY DEFINER` の関数（ショップの ID だけを返す）からだけ使う。作業はショップごとに `SET LOCAL` して本体を読む（data-model の 3.4 節の一覧）。[ADR-0003](../decisions/0003-tenancy-and-rls.md) の X1 に、表の一覧と規則を注記した。
  - 案 b：例外を作らず、作業がショップを全部回す。1 秒ごとの作業（inbox、照会）でポッドの 1.25 万ショップを回すのは重い。
- **写しの表を足した（D-8）**：P5 の写しに、為替・通貨・言語・署名の公開鍵・関数・保持と保全と削除の方針を足した。どれも ADR-0003 の注記の「全体の写し（`*_replica`）」の区分の中で、経路は P5 のまま。

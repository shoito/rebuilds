# Data model: DB の外（Valkey・KeyValueStore・S3・SNS と SQS・Webhook・OpenSearch・関数・Loom の IR）

[data-model.md](../data-model.md) の一部。Aurora の表の外に置くデータと、外へ出す形をまとめる。正本はどれも Aurora か S3 で、Valkey・KeyValueStore・キャッシュは失ってよい（作り直せるか、閉じる側に倒す）。

- **ショップの区別のない鍵を作らない。** Valkey のショップのデータの鍵は `{<shop_id>}:<種類>:…`（クラスタのハッシュタグで 1 つのスロット）。ポッドの運用の鍵は `sys:…`、全体の待合室の鍵は `wr:{<sale_id>}:…`、全体の identity の鍵は `id:…` で、どれもショップのデータの値を持たない。S3 のショップのデータのキーは `shops/<shop_id>/…`（ポッドを入れない。移し替えで動かさない）。鍵とキーを作る関数は `ShopId` の型を最初の引数に取るものだけ（lint）。
- 鍵・キー・メッセージには ID・ハッシュ・数・理由のコードだけを入れる。買い手のメール・住所・氏名、トークンの平文を入れない（例外：カートの値の行の属性、Webhook の本文。どちらもショップの中だけで運ぶ）。
- `<shop_id>` は UUID の文字列（小文字、ハイフンつき）。`<shop_short>` は `shop_id` の 16 バイトの base64url（22 文字）。
- ER 図は持たない（表でないため）。表との結び付きは各節の「書く・読む」に書く。名前のうち領域の文書で決めていなかったものは、この文書で決めた（D-22〜D-28）。

## 1. Valkey

### 1.1 ポッドの Valkey（ショップのデータ）

| 鍵 | 種類 | TTL | 中身 | 書く・読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `{<shop_id>}:cart:<cart_token>` | 文字列（JSON、1.2 節） | 最後の更新から 14 日 | カート（正本） | `storefront-api`・`storefront-renderer`（Lua の比べて入れ替え）、`checkout` | [ADR-0028](../../decisions/0028-cart-storage-in-valkey.md) |
| `{<shop_id>}:co:sem` | 有限の期限つきの数え上げ（ZSET、メンバーは要求の ID、点は期限） | 30 秒で自動に戻る | チェックアウトの同時実行のセマフォ | `checkout` | [ADR-0031](../../decisions/0031-checkout-admission-limits.md) |
| `{<shop_id>}:co:bucket` | トークンバケット（HASH） | — | チェックアウトの作成の速さ | `checkout` | 同上 |
| `{<shop_id>}:inv:avail:<inventory_item_id>` | 文字列（整数） | 5 秒 | 表示の在庫の和（目安） | `storefront-api`（島） | [inventory-and-reservations.md](../inventory-and-reservations.md) の 11 節 |
| `{<shop_id>}:sale:<sale_id>:avail:<inventory_item_id>` | 文字列（整数） | 2 秒 | セールの間の在庫の島の値（`workers` が 1 秒ごとに読み出しの写しから書く） | `workers` → `storefront-api` | この文書（[ADR-0051](../../decisions/0051-dynamic-islands-and-uncached-personal-data.md) の「Valkey の目安の値」） |
| `{<shop_id>}:tok:<token_hash>` | 文字列（JSON：導入、種類、スコープ、スタッフ、期限） | 60 秒 | アクセストークンの写し（削除・所属の変更で消す） | `admin-api` | [ADR-0054](../../decisions/0054-oauth-install-and-expiring-tokens.md) |
| `{<shop_id>}:cost:<app_id>` | トークンバケット | — | Admin API の（アプリ、ショップ）の費用のバケット | `admin-api`（Lua） | [ADR-0009](../../decisions/0009-admin-api-graphql-and-cost-limits.md) |
| `{<shop_id>}:cost:_total` | トークンバケット | — | ショップの全アプリの合計の回復 | `admin-api` | 同上（名前はこの文書） |
| `{<shop_id>}:sfrl:<ip_hash>` | トークンバケット | — | Storefront API の（ショップ、IP）の費用 | `storefront-api` | [ADR-0049](../../decisions/0049-storefront-api-tokens-and-limits.md) |
| `{<shop_id>}:sfrl:cart:<ip_hash>`・`{<shop_id>}:sfrl:co:<ip_hash>` | 時刻の窓の数 | 1 分 | カートの作成 30・チェックアウトへの送り 10 | `storefront-api` | 同上（名前はこの文書） |
| `{<shop_id>}:sfrl:tok:<token_id>` | トークンバケット | — | 秘密のトークンごとの合計 | `storefront-api` | 同上（名前はこの文書） |
| `{<shop_id>}:origin` | トークンバケット | — | ストアフロントの元への要求のショップごとの上限 | 入口のミドルウェア | [ADR-0003](../../decisions/0003-tenancy-and-rls.md)（名前はこの文書） |
| `{<shop_id>}:ci:window` | 文字列（SET NX） | 2 秒 | キャッシュの世代のまとめの窓の印 | `cache-invalidator` | [storefront-api-and-caching.md](../storefront-api-and-caching.md) の 5.1 節 |
| `{<shop_id>}:redirects` | HASH（パス → 行先） | 5 分 | `url_redirects` の写し | `storefront-renderer` | 同上の 9 節 |
| `{<shop_id>}:sec:<theme_version_id>:<section>:<hash>` | 文字列（HTML の断片） | 5 分 | セクションの描画の結果（キャッシュする種類のテンプレートだけ。`<hash>` は設定と読んだ値のハッシュ） | `storefront-renderer` | [storefront-themes.md](../storefront-themes.md) の 6 節 |
| `{<shop_id>}:pcb:<provider>:<method>` | HASH（窓の失敗の数、全体の数、状態、開いた時刻） | 10 分 | 決済の遮断器 | `checkout` | [ADR-0036](../../decisions/0036-payment-webhook-inbox-and-inquiry-schedule.md) |
| `{<shop_id>}:pal:co:<checkout_id>`・`{<shop_id>}:pal:sess:<sid_hash>`・`{<shop_id>}:pal:ip:<ip_hash>` | 時刻の窓の数 | 1 時間 | 支払いの試みの失敗の数（カードテスト） | `checkout` | [ADR-0067](../../decisions/0067-checkout-script-integrity-and-card-testing.md)（領域の文書の `payment_attempt_limits`。名前はこの文書） |
| `{<shop_id>}:pal:failrate` | 時刻の窓の数（分ごと） | 7 日 | ショップの支払いの失敗の率（7 日の同じ時刻と比べる） | `checkout` | 同上 |
| `{<shop_id>}:pii:<principal_type>:<principal_id>:<yyyymmddhh>` | HyperLogLog（顧客の ID） | 2 時間 | 保護のデータの項目を返した顧客の数 | `admin-api` | [security.md](../security.md) の 3.8 節（領域の文書の `pii_read_counters`。名前はこの文書） |
| `{<shop_id>}:clc:<email_hmac>` | HASH（コードのハッシュ、試みの数） | 10 分 | 買い手のログインの 1 回だけのコード | `storefront-renderer` | この文書（D-11） |
| `{<shop_id>}:clc:rl:<email_hmac>`・`{<shop_id>}:clc:rl:ip:<ip_hash>` | 時刻の窓の数 | 1 時間 | コードの送信の上限（メール 5、IP 50） | 同上 | 同上 |
| `{<shop_id>}:staffenter:<account_id>` | 文字列 | 60 秒 | 入場の判定の写し（所属・状態） | `admin-api` | [ADR-0063](../../decisions/0063-staff-identity-2fa-sso-and-collaborators.md)（名前はこの文書） |
| `{<shop_id>}:inv:events:<inventory_item_id>` | 文字列（SET NX） | 1 秒 | `inventory_levels/update` の 1 品目 1 秒 1 回のまとめ | `workers` | [webhooks.md](../webhooks.md) の 4.1 節（名前はこの文書） |
| `sys:inv:rebalance:<pod_id>` | リスト（`shop_id`・品目・拠点の組） | — | 枠の直しの依頼（失っても次の 0 で再び出る） | `checkout` → `inventory-rebalancer` | [ADR-0021](../../decisions/0021-inventory-slot-probing-and-rebalance.md) |
| `sys:relay:wake` | pub/sub | — | outbox に行が入った合図（失っても `relay` は 1 秒ごとに読む） | 各サービス → `relay` | この文書 |

- `sys:inv:rebalance:<pod_id>` の値はショップの ID と品目の ID だけ。ポッドの運用の鍵で、ショップの区別は値の中に持つ。
- 移し替えの停止の中で、`shop-mover` は `{<shop_id>}:cart:*`・`{<shop_id>}:tok:*`・`{<shop_id>}:cost:*` を先のポッドへ写す（他の鍵は失ってよい）。ショップの削除は `{<shop_id>}:*` を走査して消す。
- Valkey の障害では：カートは読み出しが空・書き込みが 503、セマフォとバケットはタスクの局所の値（上限 ÷ タスクの数）、トークンは DB を読む。

### 1.2 カートの値

```json
{
  "v": 1,
  "version": 7,
  "currency": "JPY",
  "locale": "ja",
  "market_id": "0192…",
  "fx_rate_id": null,
  "customer_id": null,
  "discount_codes": ["SUMMER10"],
  "attributes": {"gift": "yes"},
  "lines": [
    {"line_id": "0193…", "variant_id": "0192…", "inventory_item_id": "0192…",
     "quantity": 2, "attributes": {"engraving": "A"}}
  ],
  "updated_at": "2026-10-10T12:00:00Z"
}
```

- 行 250、1 行の数 9,999、行の属性 1 行 10 個・合計 4 KB。価格を持たない（表示の価格は毎回カタログから読む目安）。
- `saved_carts.cart` はこの値のまま。

### 1.3 全体の Valkey（待合室、identity）

| 鍵 | 種類 | TTL | 中身 | 書く・読む | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `wr:{<sale_id>}:sid:<sid_hash>` | 文字列（券の JSON） | セールの終わり ＋ 1 日 | セッションの券（再入場で同じ券） | `waiting-room` | [ADR-0024](../../decisions/0024-waiting-room-ordering-and-admission-rate.md) |
| `wr:{<sale_id>}:seq` | 文字列（INCR） | 同上 | 開始の後の到着の番号 | 同上 | 同上 |
| `wr:{<sale_id>}:pre` | ZSET（`ticket_id` → `v`） | 同上 | 開始の前の券の値の並び | 同上 | 同上 |
| `wr:{<sale_id>}:admitted` | HASH（`theta`、`admitted_through`、`pre_admitted`、`sold_out`、`waiting_for_returns`） | 同上 | 受け入れの状態（状態の JSON の元） | 同上 | 同上 |
| `wr:{<sale_id>}:used:<ticket_id>` | 文字列（SET NX） | 同上 | 券の交換の印（1 回だけ） | 同上 | [ADR-0025](../../decisions/0025-queue-pass-tokens.md) |
| `wr:{<sale_id>}:budget` | HASH（`U`、`R`、`F`、`at`） | 30 秒 | 在庫の予算の材料（ポッドの事象から。5 秒より古い値は使わない） | `waiting-room` | この文書（D-16） |
| `wr:{<sale_id>}:passes` | 文字列（整数） | 同上 | `F`：発行して終わっていない許可証の数 | 同上 | [flash-sales-and-queueing.md](../flash-sales-and-queueing.md) の 5.4 節（名前はこの文書） |
| `id:sess:<session_hash>` | 文字列（JSON） | 60 秒 | `admin_sessions` の写し | `identity` | この文書 |
| `id:rl:acct:<account_id>`・`id:rl:ip:<ip_hash>` | 時刻の窓の数 | 15 分 | ログインの試み（10・100） | `identity` | [merchant-admin-and-staff.md](../merchant-admin-and-staff.md) の 4.2 節（名前はこの文書） |
| `id:jwks` | 文字列 | 5 分 | JWKS の応答 | `identity` | この文書 |

- 待合室の Valkey の障害では閉じる側に倒す（新しい許可証を出さない。発行済みは署名だけで確かめる）。

## 2. CloudFront KeyValueStore

1 つの保存は 5 MB、関数に 1 つ。熱い集まり（4 MB まで、3.5 MB で外し始める、固定の枠 1 MB）と、システムの値（64 KB までを別に取っておく）を同じ保存に置く（[ADR-0010](../../decisions/0010-shop-routing-hot-set-and-custom-domains.md)）。

| 鍵 | 値 | 書く | 決めた場所 |
| --- | --- | --- | --- |
| `<host>`（小文字、末尾の `.` なし） | `v1\|<shop_short>\|<pod>\|<state>\|<gen>[\|<pgen>\|<fine_bucket_gens>]`（1 KB まで） | `shop-directory`（50 鍵ずつ） | [shops-and-pods.md](../shops-and-pods.md) の 5.2 節、[storefront-api-and-caching.md](../storefront-api-and-caching.md) の 7 節 |
| `sys:origins` | `v1\|<pod>=<origin_id_tokyo>,<origin_id_osaka>;…` | `shop-directory`（ポッドの追加） | [infrastructure.md](../infrastructure.md) の 12 節 |
| `sys:region` | `tokyo`・`osaka` | DR の手順 | [ADR-0071](../../decisions/0071-osaka-dr-and-stage-up-criteria.md) |
| `sys:kid:<kid>` | 許可証の HMAC の鍵（base64url、32 バイト）と `not_after` | `waiting-room`（7 日で入れ替え、2 つ） | [ADR-0025](../../decisions/0025-queue-pass-tokens.md)（名前はこの文書） |
| `sys:kid:current` | 発行に使う `kid` | 同上 | 同上 |
| `sys:sale:<shop_short>` | `v1\|<sale_id の base64url>\|<state>\|<ends_at の Unix 秒>` | `waiting-room` | [flash-sales-and-queueing.md](../flash-sales-and-queueing.md) の 13 節の「セールの有効の印」（形はこの文書） |

- `state`：`a`（売っている）・`p`（パスワードの保護）・`f`（凍結）・`c`（閉店）・`r`（主のホストへ 301）。移し替え中は出さない。
- `gen`・`pgen` は 36 進（最大 8 文字）、`fine_bucket_gens` は 64 × 3 文字の 36 進。値は `shop_hosts` の世代の列の写し（`shop-directory` だけが書く）。
- 値の長さ：通常 70〜90 バイト、`fine` は 260 バイト前後。

## 3. S3

すべて非公開、SSE-KMS、`aws:SecureTransport` を必須。大阪へ CRR（メディア・ショップのデータ・保持・監査）。ショップの削除は `shops/<shop_id>/` の接頭辞を削除の印のタグで消す（大阪も）。

| バケット | キー | 中身 | 鍵 | 保持 | 決めた場所 |
| --- | --- | --- | --- | --- | --- |
| `<brand>-media-apne1` | `shops/<shop_id>/media/<media_id>/original` | 上げた元のメディア（EXIF の位置を消した後） | `kms-global-storage` | ショップの削除まで | [catalog-and-pricing.md](../catalog-and-pricing.md) の 6 節 |
| 同上 | `shops/<shop_id>/media/<media_id>/w<width>.<avif\|webp\|jpg>` | 画像の変換の結果（幅は 16 段） | 同上 | 90 日使われなければ消す（作り直せる） | 同上（キーはこの文書。配信の URL は `/<brand>-media/<shop_id>/<media_id>/<width>.<format>`） |
| 同上 | `shops/<shop_id>/media/<media_id>/hls/…`・`mp4` | 動画の変換の結果 | 同上 | ショップの削除まで | 同上 |
| `<brand>-shop-data-apne1` | `shops/<shop_id>/theme-files/<sha256>` | テーマのファイル（内容のハッシュ。ショップの中で重複を除く） | 同上 | 参照するバージョンが消えて 30 日 | [storefront-themes.md](../storefront-themes.md) の 7 節（キーはこの文書） |
| 同上 | `shops/<shop_id>/themes/<theme_version_id>/ir/v<loom_ir_version>.lir` | Loom の翻訳の結果（9 節） | 同上 | バージョンと同じ | 同上 |
| 同上 | `shops/<shop_id>/assets/<sha256>/<name>` | テーマの資産（`/<brand>-assets/<shop_id>/<hash>/<name>` で `immutable` に配る） | 同上 | 同上 | 同上 |
| 同上 | `shops/<shop_id>/exports/<export_id>.csv` | 商品の CSV の書き出し | 同上 | 7 日 | [catalog-and-pricing.md](../catalog-and-pricing.md) の 11 節 |
| 同上 | `shops/<shop_id>/imports/<import_id>/{source,result}.csv` | CSV の取り込みと結果、追跡の番号の取り込み | 同上 | 30 日 | 同上 |
| 同上 | `shops/<shop_id>/bulk/<bulk_operation_id>.jsonl` | 一括の操作の結果（書き込みの入力は `…/bulk/<id>.input.jsonl`） | 同上 | 7 日 | [app-platform-and-apis.md](../app-platform-and-apis.md) の 5.5 節 |
| 同上 | `shops/<shop_id>/sitemaps/<n>.xml` | サイトマップ | 同上 | 作り直すたびに上書き | [storefront-api-and-caching.md](../storefront-api-and-caching.md) の 9 節 |
| 同上 | `shops/<shop_id>/carrier-exports/<export_id>.csv` | 送り状の CSV | 同上 | 7 日 | [orders-and-fulfillment.md](../orders-and-fulfillment.md) の 7.2 節 |
| 同上 | `shops/<shop_id>/labels/<shipment_id>.pdf` | 運送会社の API の送り状 | 同上 | 90 日 | 同上の 8.1 節 |
| 同上 | `shops/<shop_id>/data-requests/<request_id>.json` | 顧客のデータの開示 | `kms-pod-<id>-pii` | 7 日 | [merchant-admin-and-staff.md](../merchant-admin-and-staff.md) の 9 節（キーはこの文書） |
| `<brand>-retention-apne1`（Object Lock、コンプライアンス） | `retained/shops/<shop_id>/tax-documents/<yyyy>/<document_id>.json` | 保持の対象の文書の値 | `kms-archive` | `retained_until`（L4） | [ADR-0013](../../decisions/0013-shop-lifecycle-and-data-deletion.md)（キーはこの文書） |
| 同上 | `retained/shops/<shop_id>/orders/<yyyy>/<mm>.jsonl` | 注文の金額・日時・税の記録 | 同上 | 同上 | 同上 |
| log-archive の `<brand>-audit-apne1`（Object Lock） | `audit/shops/<shop_id>/<yyyy>/<mm>/<dd>/<hh>.jsonl` | `audit_events` の写し | `kms-archive` | 1 年（L3） | [merchant-admin-and-staff.md](../merchant-admin-and-staff.md) の 7.2 節 |
| 同上 | `audit/chain/shops/<shop_id>/<yyyy-mm-dd>.json` | 日の最後の `hash` | 同上 | 同上 | 同上（キーはこの文書） |
| 同上 | `audit/identity/<yyyy>/<mm>/<dd>/<hh>.jsonl`・`audit/operator/…` | 全体の監査の写し | 同上 | 同上 | この文書 |
| `<brand>-functions-apne1`（全体） | `functions/<app>/<function>/<version>/module.wasm` | 開発者の上げたモジュール | `kms-global-storage` | 90 日（新しいバージョンの後） | この文書 |
| 同上 | `functions/<app>/<function>/<version>/<wasmtime>.cwasm`・`.sig` | 翻訳した機械語と署名 | 同上 | 同上 | [ADR-0059](../../decisions/0059-function-publish-compile-and-distribution.md) |
| `<brand>-static-apne1` | `waiting-room/<version>/…`、`pages/{frozen,closed}.html` | 待合室・凍結・閉店の静的なページ | 同上 | — | [flash-sales-and-queueing.md](../flash-sales-and-queueing.md) の 5.1 節 |
| `<brand>-release-apne1` | `checkout-script-manifest/<release>.json` | チェックアウトのスクリプトの目録（URL と SRI のハッシュ） | 同上 | 1 年 | [ADR-0067](../../decisions/0067-checkout-script-integrity-and-card-testing.md) |
| canary のアカウントの `<brand>-canary-osaka` | `canary-runs/<yyyy>/<mm>/<dd>/<check>.jsonl` | 見張りの結果と時間（`canary_runs`） | canary の鍵 | 90 日 | この文書（D-12） |

- `<app>`・`<function>`・`<version>` は `app_id`・`function_id`・`app_version_id`。`<wasmtime>` は Wasmtime のバージョン。
- 読み手は `.lir`・`.cwasm` の頭のショップ・関数の ID とハッシュを、引いた行の値と比べてから使う（違えば使わず、SEV1 の候補）。

## 4. SNS・SQS と事象の封筒

### 4.1 事象の封筒（outbox → SNS）

```json
{
  "v": 1,
  "event_id": "0192…",
  "shop_id": "0192…",
  "pod_id": "p01",
  "topic": "products/update",
  "aggregate": {"type": "product", "id": "0192…", "version": 42},
  "occurred_at": "2026-10-10T12:00:00.123Z",
  "data": {"changed": ["price"], "channel": null}
}
```

- `data` は `outbox.payload`（ID・数・変わった項目の種類・理由のコードだけ）。使い手は中身でなく正本を読み直す（検索、Webhook の本文）か、世代を上げる（キャッシュ）。
- 使い手は `aggregate.version` が自分の持つ値以下の事象を捨てる（順序の入れ替えに強くする）。
- 封筒の `v` は読む側を先に出してから上げる（1 つ前と互換に保つ。[ADR-0075](../../decisions/0075-pod-wave-rollout-and-cross-pod-migrations.md)）。

### 4.2 話題とキュー

| 名前 | 種類 | 置き場所 | 中身・購読 | 決めた場所 |
| --- | --- | --- | --- | --- |
| `pod-<pod>-events` | SNS（標準） | ポッド | outbox の全部の事象。属性 `topic` で絞って下のキューへ | この文書 |
| `pod-<pod>-search-index` | SQS | ポッド | `products/*`・`collections/membership_changed`・`products/published` | [search-and-recommendations.md](../search-and-recommendations.md) の 4.4 節 |
| `pod-<pod>-webhook-fanout` | SQS | ポッド | Webhook の話題の全部 | [webhooks.md](../webhooks.md) の 6.1 節 |
| `pod-<pod>-cache-invalidator` | SQS | ポッド | 世代を上げる事象 | [storefront-api-and-caching.md](../storefront-api-and-caching.md) の 5.1 節 |
| `pod-<pod>-notifier` | SQS | ポッド | 通知の事象（注文、発送、取り消し） | [orders-and-fulfillment.md](../orders-and-fulfillment.md) の 9 節 |
| `pod-<pod>-jobs.fifo` | SQS FIFO | ポッド | 確定、返金、文書の作成、CSV、一括の操作。メッセージ グループは `shop_id`（ショップの公平） | [ADR-0003](../../decisions/0003-tenancy-and-rls.md) |
| `pod-<pod>-payment-inbox-signal` | SQS | ポッド | inbox の処理の合図（outbox を経ない。失っても 1 秒ごとの読み出しで拾う） | [ADR-0036](../../decisions/0036-payment-webhook-inbox-and-inquiry-schedule.md) |
| `pod-<pod>-webhook-results` | SQS | ポッド | `webhook-dispatcher` の結果（`delivery_id`、状態のコード、時間、誤りの種類） | [ADR-0062](../../decisions/0062-webhook-egress-and-payload-custody.md) |
| `pod-<pod>-replica-apply` | SQS | ポッド | P5 の写しの事象 | [ADR-0010](../../decisions/0010-shop-routing-hot-set-and-custom-domains.md) |
| `webhook-send-00`〜`15` | SQS（SSE-KMS） | 全体 | Webhook の送りの依頼（5.3 節）。アプリのハッシュで 16 本 | [ADR-0062](../../decisions/0062-webhook-egress-and-payload-custody.md) |
| `global-webhook-results` | SNS | 全体 | 結果をポッドへ返す（属性 `pod_id`） | 同上 |
| `global-replica` | SNS | 全体 | P5：アプリの定義、関数、プランの上限、署名の公開鍵、言語・通貨・為替、税率、郵便番号、運送会社の型、商品の区分、保持・保全・削除の方針 | [ADR-0010](../../decisions/0010-shop-routing-hot-set-and-custom-domains.md)（中身の一覧はこの文書） |
| `global-directory-events` | SNS | 全体 | `shop/lifecycle`、`shop/hosts`、プランの変更、パートナーの組織を外れたメンバー | この文書 |
| `global-aggregate-in` | SQS | 全体 | P3：利用量（`billing_usage`）、`shop_load`、`staff/membership_changed`（P4 の写し）、`reindex_jobs` の結果、待合室のセールの設定と在庫の予算（D-16） | [ADR-0002](../../decisions/0002-pods-and-shop-placement.md)（中身の一覧はこの文書） |

- P5 の事象は `{"v":1,"kind":"app_definition","key":"<app_id>","version":<n>,"row":{…}}`。ポッドは `version` が写しの `source_version` より大きいときだけ当てる。
- P3 の事象は封筒の `topic` に `usage/daily`・`shop/load`・`staff/membership_changed`・`search/reindex_result`・`sale/config`・`sale/budget` を使う。`sale/budget` は 5 秒ごとに `{"sale_id","U","R","at"}` だけを運ぶ（ショップのデータの値を持たない）。

## 5. Webhook の本文と送りの依頼

### 5.1 ヘッダー

`X-<Brand>-Topic`、`X-<Brand>-Shop-Domain`、`X-<Brand>-Api-Version`、`X-<Brand>-Webhook-Id`（`delivery_id`）、`X-<Brand>-Event-Id`（`event_id`）、`X-<Brand>-Triggered-At`、`X-<Brand>-Attempt`（1〜9）、`X-<Brand>-Hmac-Sha256`、入れ替えの 24 時間だけ `X-<Brand>-Hmac-Sha256-Previous`（[ADR-0061](../../decisions/0061-webhook-delivery-and-signing.md)）。

- **署名**：`base64(HMAC-SHA256(アプリの Webhook の秘密, 生の本文のバイト))`。秘密は 32 バイトの乱数（開発者には `<brand>_whsec_` の接頭辞で見せる）。受け手は JSON の構文解析の前のバイトで確かめ、定数時間で比べる。試験のベクトルは開発リポジトリの `webhook-signature-vectors.json`。

### 5.2 本文

```json
{
  "id": "gid://<brand>/Order/0192…",
  "<brand>_version": 3,
  "updated_at": "2026-10-10T12:00:00Z",
  "financial_status": "paid",
  "line_items": [{"id": "gid://<brand>/LineItem/0193…", "sku": "TS-W-M", "quantity": 2}],
  "customer": {"id": "gid://<brand>/Customer/0192…", "email": null},
  "<brand>_redacted_fields": ["customer.email"]
}
```

- 形は購読の API のバージョンの Admin API の型に合わせる。事象の時点の資源の写し（より新しい状態を読んだら `<brand>_version` が示す）。
- スコープと保護のデータの承認のない項目は除き、`<brand>_redacted_fields` に道を入れる。
- 256 KiB を超えたら `{"id","<brand>_version","updated_at","<brand>_truncated":true}` だけにする。

### 5.3 送りの依頼（ポッド → 全体の `webhook-send-NN`）

```json
{
  "v": 1,
  "delivery_id": "0192…", "event_id": "0192…", "pod_id": "p01",
  "shop_id": "0192…", "app_id": "0192…",
  "address": "https://example.app/hooks/orders",
  "headers": {"topic": "orders/create", "shop_domain": "tea-shop.<brand>.<domain>",
              "api_version": "2026-10", "triggered_at": "2026-10-10T12:00:00.123Z"},
  "attempt": 1, "not_before": null,
  "body_b64": "eyJpZCI6…"
}
```

- 本文はこの依頼の中だけ（SQS の保持の中）。`webhook-dispatcher` は保存せず、ログに本文と URL のクエリを書かない。

## 6. 価格の写しの正規の JSON

`checkout_price_snapshots.body_canonical` の形（[ADR-0030](../../decisions/0030-price-snapshot-and-final-confirmation.md)）。キーは辞書の順、空白なし、金額は整数の最小単位、税率は基本点（D-5）、個人のデータを入れない。

```json
{"currency":"JPY",
 "discounts":["0192…@3","0192…@1"],
 "fees":[],
 "lines":[{"line_id":"0193…","qty":2,"rate_bp":1000,"tax_category":"standard_10","unit_price":3300,
           "units":[{"n":1,"order_discount":254,"paid":2551,"product_discount":495},
                    {"n":2,"order_discount":254,"paid":2551,"product_discount":495}]}],
 "rounding_mode":"floor",
 "shipping":{"amount":880,"discount":880,"method":"standard","rate_bp":1000,"tax_category":"standard_10"},
 "tax_lines":[{"consideration":5102,"rate_bp":1000,"tax":463,"tax_category":"standard_10"}],
 "tax_rules_version":1,
 "total":5102,
 "v":1}
```

- `snapshot_hash = SHA-256(この UTF-8 のバイト列)`。最終確認画面はこの写しだけから描き、送信は `snapshot_hash` の一致を求める（違えば `409 snapshot_changed`）。
- 例は形の説明用で、1 行のカートにした（割引の条件の成否は省いた）。合計の関係は `total = Σtax_lines.consideration = Σunits.paid + shipping.amount − shipping.discount + Σfees`、税額は `floor(5,102 × 1000 / 11000) = 463`。全体の例は [cart-and-checkout.md](../cart-and-checkout.md) の 6.2 節。

## 7. OpenSearch（ポッドごと）

- 索引 `products_v<n>`、別名 `products`、主のシャード 3、写し 1、`_routing = shop_id`、文書の ID `<shop_id>:<product_id>`、`version_type=external`・`version=catalog_version`（[ADR-0052](../../decisions/0052-search-index-per-pod-and-japanese-analysis.md) の注記）。
- 欄（[search-and-recommendations.md](../search-and-recommendations.md) の 4.2 節）：`shop_id`、`product_id`、`channels`、`status_visible_from`、`deleted`、`title`（`title.bigram`・`title.reading`）、`body`、`vendor`、`product_type`、`tags`、`category_path`、`skus`、`barcodes`、`options_kv`（`名前=値`）、`price_min`、`price_max`、`available`、`sales_30d`、`collections`、`metafields_kv`、`created_at`、`published_at`、`catalog_version`。欄の数はショップに依らず固定。
- 個人のデータを入れない（商品の値だけ）。返す前に各件の `_source.shop_id` を `ctx.shop_id` と比べ、違う件は捨てて数える。
- 削除の印の文書（`deleted: true`）は日次で消す。ショップの削除は `shop_id` の `delete_by_query`。

## 8. 関数の入出力

### 8.1 `checkout` ⇄ `function-runner` の枠（UNIX ドメインソケット）

```text
frame    := len:u32be  header_json  0x00  body
header   := {"v":1,"invocation_id":"<uuid>","function_id":"<uuid>","module_digest":"<sha256 hex>",
             "wasmtime_key":"<wasmtime>","fuel_limit":10000000,"input_limit":131072,"output_limit":20480}
request  body := 入力の JSON（UTF-8）
response body := {"status":"ok|fuel_exhausted|memory_exceeded|trap|output_too_large|input_too_large|module_unavailable|host_error",
                  "trap_kind":null,"fuel":1234567,"duration_us":1800,"output":"<JSON の文字列>","log":"…","log_truncated":false}
```

- `function-runner` は出力の中身を解釈しない（検証は `checkout`）。上限は行 200 を超えると比例して広げる（[ADR-0008](../../decisions/0008-extension-sandbox-wasm.md)）。

### 8.2 入力と出力の JSON

- 入力は入力のクエリの結果の JSON。金額は 10 進の文字列（`"550"`）、ID はグローバル ID、保護のデータの未承認の項目は `null`（[ADR-0058](../../decisions/0058-function-io-contract.md)）。128 KiB まで。
- 出力は種類ごとの JSON スキーマ（割引：`discounts[]`・`strategy`、配送・決済のカスタマイズ：`operations[]`、カートの検証：`errors[]`）。20 KiB まで（[functions-sandbox.md](../functions-sandbox.md) の 5 節）。
- 輸入：`<brand>_io.input_read`・`output_write`・`log`、WASI の `fd_read(0)`・`fd_write(1,2)`・`proc_exit` だけ。

### 8.3 機械語と署名

- `.cwasm` は Wasmtime の固定のバージョンと設定で翻訳したもの。`.sig` は `ECDSA-P256(kms-sign-functions, SHA-256(cwasm) ‖ wasmtime_version ‖ config_hash)` の DER。`function-runner` は公開鍵で確かめ、バージョンが合うものだけを `deserialize` する（[ADR-0059](../../decisions/0059-function-publish-compile-and-distribution.md)）。

## 9. Loom の翻訳の結果（IR）

`shops/<shop_id>/themes/<theme_version_id>/ir/v<loom_ir_version>.lir`。テーマのバージョンの保存で作る不変のファイル（[ADR-0007](../../decisions/0007-theme-language-design.md)、[ADR-0047](../../decisions/0047-loom-data-access-and-prefetch.md)）。形はこの文書で決めた（D-27）。

```text
file      := magic "LOOMIR" (6 bytes)  ir_version:u16le  zstd( cbor(document) )
document  := {
  "shop_id": uuid, "theme_version_id": uuid, "loom_version": int, "ir_version": int,
  "compiler": "<version>", "sources_sha256": {path: hex},
  "constants": [ value… ],                      ← 文字列・数・お金の定数の表
  "templates": { path: {
      "kind": "layout|template|section|snippet",
      "cacheable": bool,                         ← キャッシュする種類のページか（個人の drop を読めば翻訳のエラー）
      "contexts": [ "html_text|attr_quoted|url_attr|script_json|style" … ],
      "code": [ [opcode, operand…] … ],          ← 命令の列（歩数は命令ごとに 1）
      "prefetch": [ {"path": "product.variants.price", "batch": 2, "cost": 1} … ],
      "max_cost": int, "max_loops": int } },
  "section_schemas": { name: json_schema },
  "inline_script_hashes": [ "sha256-…" ]
}
```

- CBOR は RFC 8949 の決定的な符号化（同じテーマのファイルから同じバイト列）。`ir_sha256` は `theme_versions` に持ち、読み手が比べる。
- 読み手（`storefront-renderer`）は頭の `shop_id`・`theme_version_id` を要求のショップと引いた行と比べ、違えば使わない（他のショップの IR を描かない）。
- レンダラーは今の `ir_version` と 1 つ前を読む。上げる手順は [delivery.md](../delivery.md) の 6.3 節。

## 10. エッジのキャッシュの鍵と世代

- 鍵の材料（ヘッダー `x-<brand>-ck`）：`<shop_short>.<gen>.<market>.<lang>`。`fine` の型の商品のページは `<shop_short>.p<pgen>.<bucket_gen>.<market>.<lang>`（桶は `fnv1a32(handle) mod 64`）。ほかに正規化したパスとクエリ（許可の一覧の引数だけ、名前の順）。IP・Cookie の全体・`User-Agent`・`Accept-Language` は入れない（[ADR-0050](../../decisions/0050-edge-cache-keys-and-generations.md)）。
- 島の在庫と価格：鍵はショップ、マーケット、正規化した ID の並び（エッジ 5 秒、セールは 1 秒）。
- Storefront API の永続化したクエリの `GET`：上の材料 ＋ クエリの ID ＋ 変数の SHA-256（60 秒）。
- 世代の正本は `shop_hosts` の世代の列で、`shop-directory` が KeyValueStore へ配る。熱い集まりにないホストは `edge-router` が `shop_hosts.cache_gen` を読んで鍵の材料に入れる。
- 鍵の材料は `packages/edge-keys` の 1 つの関数で作る（CloudFront Functions と元の TypeScript が同じ試験のベクトルを通る）。元は計算し直して比べ、違えば `no-store`。

## 11. トークンの形

| もの | 形 | 保存 | 決めた場所 |
| --- | --- | --- | --- |
| 許可証（`<brand>_qp` の cookie） | `<kid>.<base64url(本体)>.<base64url(HMAC-SHA256)>`。本体 `{shop_id, sale_id, sid_hash, iat, exp(+15 分), jti}` | 持たない（`jti` だけ `queue_pass_redemptions`） | [ADR-0025](../../decisions/0025-queue-pass-tokens.md) |
| 並びの券 | 同じ形、別の鍵。本体 `{sale_id, ticket_id, sid_hash, group, seq, iat}` | Valkey の `wr:{…}:sid:…` | [flash-sales-and-queueing.md](../flash-sales-and-queueing.md) の 5.2 節 |
| Admin API のアクセストークン | `<brand>_at_<base62 で 43 文字>` | SHA-256（`app_tokens`） | [ADR-0054](../../decisions/0054-oauth-install-and-expiring-tokens.md) |
| リフレッシュトークン | `<brand>_rt_<…>` | 同上 | 同上 |
| Storefront のトークン | `<brand>_sf_<…>`・`<brand>_sfp_<…>` | SHA-256（`storefront_tokens`） | [ADR-0049](../../decisions/0049-storefront-api-tokens-and-limits.md) |
| 入場の主張 | JWT ES256、60 秒。`sub`（アカウント）、`aud`（ショップ）、`amr`、`auth_time`、`sid` | 持たない | [ADR-0063](../../decisions/0063-staff-identity-2fa-sso-and-collaborators.md) |
| 導入の要求・戻り | JWT ES256。`shop`、`iat`、`exp`（5 分）、`nonce` | 持たない | [ADR-0054](../../decisions/0054-oauth-install-and-expiring-tokens.md) |
| 埋め込みのセッションのトークン | JWT ES256、60 秒。`iss`、`dest`、`aud`（`client_id`）、`sub`、`exp`、`nbf`、`iat`、`jti`、`sid` | 持たない | [ADR-0056](../../decisions/0056-admin-embedding-and-session-tokens.md) |
| 文書・注文の状況のリンク | HMAC の署名つきの URL（期限 90 日） | 持たない | [taxes-and-invoices.md](../taxes-and-invoices.md) の 7.4 節 |

- JWT の公開鍵は `https://<brand>.<domain>/.well-known/jwks.json`（`signing_keys`）。

## 12. AppConfig とログ

- AppConfig：`ops.*`（snake_case）と `release.*`（kebab-case）。一覧は [runbooks/README.md](../../runbooks/README.md) の 2 節。`watched_shops` の一覧を配る。ショップのデータの値を持たない（ショップの ID だけ）。
- CloudWatch Logs の欄は `packages/obs` の型で許したものだけ（[observability.md](../observability.md) の 2.4 節）。`shop_id`・`pod`・`route`・`request_id`・理由のコード・数。IP は日ごとの鍵の HMAC の先頭 8 バイト。買い手の個人のデータ・決済の情報・トークンを書かない。

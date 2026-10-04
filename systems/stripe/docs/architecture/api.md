# API: Stripe

加盟店の開発者が使う公開 API の設計。形式は [ADR-0006](../decisions/0006-api-shape.md)、バージョンは [ADR-0007](../decisions/0007-date-based-api-versions.md)、冪等は [ADR-0004](../decisions/0004-idempotency.md)、認証と API キーは [auth-and-keys.md](auth-and-keys.md) と [ADR-0008](../decisions/0008-api-keys-and-dashboard-access.md)、レート制限は [rate-limiting.md](rate-limiting.md) と [ADR-0009](../decisions/0009-rate-limiting.md) にある。

本家 Stripe の振る舞いは、2026-09-26 に docs.stripe.com で確かめた。確かめられなかったものは「未検証」と書き、確かめ方を添える。

## 1. 位置づけ

| 項目 | 方針 |
| --- | --- |
| 面 | 公開 API（`api.<domain>/v1`）が製品そのもの。ダッシュボード・Checkout のバックエンドも、同じドメイン層（サービス関数）を呼ぶ。面どうしは HTTP で呼び合わない（Slack の public-api.md の 7 節と同じ） |
| 互換性 | 公開したバージョンの振る舞いは変えない。互換性を壊す変更は、新しい日付のバージョンとして出し、古いバージョンは変換モジュールで保つ（6 節） |
| 本家との関係 | 形・意味・名前を本家の v1 に寄せる。ただし本家の SDK がそのまま動くことは約束しない（10 節） |

## 2. 構成

```
加盟店のサーバー ──HTTPS Authorization: Bearer <brand>_sk_live_... ──┐
Elements・Checkout ─ <brand>_pk_live_...（公開可能キーで許す操作だけ）──┤
                                                               ▼
CloudFront + WAF ─▶ ALB ─▶ api サービス（ECS Fargate、OpenAPIHono）
   1. キーの判別と検証（接頭辞で live / test のクラスタを選ぶ。ADR-0002）
   2. レート制限（rate-limiting.md）
   3. バージョンの決定（<Brand>-Version か、アカウントの既定のバージョン）→ 要求の変換
   4. 冪等（Idempotency-Key）
   5. BEGIN; SET LOCAL app.account_id → ハンドラー → サービス関数
   6. 応答を最新の形で作り、要求のバージョンまで変換して返す
```

- 順序は本家に合わせ、レート制限を冪等より前に置く。本家は「429 は冪等の層の前で返るので、同じキーでも結果が変わりうる」と書いている（[Advanced error handling](https://docs.stripe.com/error-low-level)）。
- 認証は Bearer と HTTP Basic（キーをユーザー名、パスワードは空）の両方を受ける。本家も両方を受ける（[Authentication](https://docs.stripe.com/api/authentication)）。
- 主体は 3 つ：秘密キー・制限付きキー（加盟店のサーバー）、公開可能キー（Elements・Checkout。[auth-and-keys.md](auth-and-keys.md) の 5.4 節）、ダッシュボードのセッション（Cookie と CSRF のトークン。ダッシュボードのオリジンからだけ。[dashboard.md](dashboard.md)）。3 つとも同じハンドラーと `authorize()` を通る。
- CORS は、公開可能キーの経路と、ダッシュボードのオリジンにだけ許す。キーの要求で Cookie は見ない。

## 3. リソースと URL

### 3.1 形式

```
https://api.<domain>/v1/<リソース>[/{id}[/<操作>]]
```

| 規則 | 内容 | 本家 |
| --- | --- | --- |
| リソース | 複数形の名詞（`/v1/payment_intents`、`/v1/customers`） | 同じ |
| 作成・更新 | どちらも `POST`。更新は部分更新（渡した項目だけ変える） | 同じ。本家は `PATCH` を使わない |
| 状態を変える操作 | サブリソースへの `POST`（`/v1/payment_intents/{id}/capture`、`.../cancel`、`.../confirm`） | 同じ |
| 削除 | `DELETE`（削除できるリソースだけ） | 同じ |
| テナント | パスにアカウントを含めない。キーからアカウントが決まる | 同じ |
| 項目名 | `snake_case` | 同じ |
| 金額 | 通貨の最小単位の整数（`amount: 1000`、`currency: "jpy"`）。通貨は小文字の ISO 4217 | 同じ（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| 時刻 | Unix 秒の整数（`created`） | 同じ |
| 共通の項目 | すべてのオブジェクトに `id`、`object`（種類の名前）、`livemode`、`created` | 同じ |

### 3.2 要求の本文は JSON にする

本家の v1 は、要求を `application/x-www-form-urlencoded`、応答を JSON にしている。v2 は要求も応答も JSON である（[API v2 overview](https://docs.stripe.com/api-v2-overview)）。本システムは **v1 のリソースの形に、v2 の JSON の本文を組み合わせる**（ADR-0006）。

| 観点 | JSON（採用） | form-encoded（本家 v1） |
| --- | --- | --- |
| 型 | 整数・真偽値・`null`・入れ子がそのまま表せる。金額の整数を文字列から読み直さない | すべて文字列。`metadata[a]=`、`items[0][price]=` の独自の記法を自前で解釈する |
| 契約 | Zod・OpenAPI 3.1 のスキーマがそのまま効く | 変換の層が要る |
| 本家の向き | v2 は JSON | v1 のまま |
| 失うもの | `curl -d a=b` の手軽さ。本家の SDK との本文の互換 | - |

- 要求は `Content-Type: application/json` だけを受ける。それ以外は 415。
- 未知の項目は 400（`parameter_unknown`）にする。本家と同じく、誤字を黙って無視しない。
- クエリ（`GET` の絞り込み、`expand`）の配列は、本家と同じ角括弧の記法にする（`expand[]=customer&expand[]=latest_charge`）。

### 3.3 オブジェクトの ID

- 形式は `<接頭辞>_<22 文字>`。22 文字は UUIDv7（128 ビット）の base62。
- DB には `uuid` 型で持ち、接頭辞はテーブル（種類）から決める。文字列の ID を列に持たない。
- UUIDv7 なので、ID の順が作成の順になり、ページングのカーソル（5 節）にそのまま使える。代わりに、ID から作成の時刻が分かる。`created` を公開しているので、隠す情報はない。
- 接頭辞の付け方は本家に合わせる。本家は接頭辞の一覧を公式には文書にしていないため、API リファレンスの例の値から採った（例：`cus_`、`pi_`、`pm_`、`ch_`、`evt_`）。

| 接頭辞 | 種類 | 接頭辞 | 種類 |
| --- | --- | --- | --- |
| `acct_` | アカウント | `re_` | Refund |
| `cus_` | Customer | `du_` | Dispute（[disputes.md](disputes.md)） |
| `pm_` | PaymentMethod | `evt_` | Event |
| `pi_` | PaymentIntent | `we_` | Webhook のエンドポイント |
| `ch_` | Charge（確定の試行。[payments.md](payments.md)） | `po_` | Payout |
| `txn_` | 残高の取引 | `cs_` | Checkout のセッション |
| `req_` | 要求の ID（`Request-Id`） | `rak_` | API キーの ID（キーの値とは別。[auth-and-keys.md](auth-and-keys.md)） |

- 接頭辞が違う ID を受けたら、DB を引かずに 404（`resource_missing`）を返す。
- 別の環境（test と live）の ID は、別のクラスタにあるので見つからない。本家も、一方の環境のオブジェクトを他方から使えない（[API keys](https://docs.stripe.com/keys)）。ID の形で環境を区別しないので、エラーは `resource_missing` になる。

### 3.4 `client_secret`

- PaymentIntent などは `client_secret`（`pi_..._secret_...`）を持つ。公開可能キーと組にして、ブラウザから確認・取得に使う。
- 秘密の部分は 32 バイトの乱数で、DB にはハッシュを置く。応答に出すのは秘密キーでの作成・取得の応答だけ。

## 4. 応答

### 4.1 共通の見出し

| 見出し | 内容 |
| --- | --- |
| `Request-Id` | `req_...`。すべての応答に付ける。問い合わせのときに使ってもらう（本家と同じ。[Request IDs](https://docs.stripe.com/api/request_ids)） |
| `<Brand>-Version` | この応答を作ったバージョン |
| `Idempotent-Replayed: true` | 冪等の記録から返した応答（7 節。本家と同じ） |
| `<Brand>-Should-Retry` | 再試行してよいかをサーバーが知っているときだけ付ける（8.1 節） |

- 本家の見出しのうち、`Stripe-` で始まるものは、意味と値の形を本家に合わせ、接頭辞だけを本システムの製品名にする（`<Brand>-Version`、`<Brand>-Should-Retry`、`<Brand>-Rate-Limited-Reason`）。本家の名前を名乗らないため。Webhook の署名の見出しも同じ規則にする（[events-and-webhooks.md](events-and-webhooks.md)）。`<Brand>` は製品名が決まったら 1 か所（`packages/contract/public/headers.ts`）で決める。
- `Request-Id`、`Idempotency-Key`、`Idempotent-Replayed` は製品名を含まないので、本家と同じ名前にする。
- API キーの接頭辞も同じ規則で、本家の `sk_live_` などと重ならない `<brand>_{pk|sk|rk}_{live|test}_` にする（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、[auth-and-keys.md](auth-and-keys.md) の 5.2 節）。Webhook の署名の秘密は `<brand>_whsec_`。オブジェクトの ID の接頭辞（`pi_`、`cus_` など。3.3 節）は秘密ではなく、シークレットスキャンの対象にもならないので、本家に合わせたままにする。

### 4.2 `expand`

- ID を持つ項目のうち、「展開できる」と印を付けた項目を、`expand[]` でオブジェクトに置き換える。本家と同じ（[Expanding responses](https://docs.stripe.com/api/expanding_objects)）。
- すべての要求（取得・一覧・作成・更新）で使える。一覧では `data.` から書く（`data.customer`）。
- 入れ子はドットで書き、深さは最大 4 段（本家と同じ）。5 段以上は 400。
- 既定では出さない項目（本家の Issuing のカード番号のようなもの）も、`expand` で求める形にできる。本システムでは、カード番号は CDE の外に出さない（[ADR-0005](../decisions/0005-pci-scope-segmentation.md)）ので、この用途には使わない。
- 展開は、展開先のオブジェクトに対する読み取りの権限を要する。制限付きキーで権限がなければ、展開の要求全体を 403 にする（黙って ID のままにしない）。
- 一覧での深い展開は重い。同時実行の制限の対象にする（[rate-limiting.md](rate-limiting.md) の 4.3 節）。展開は、一覧の 1 ページぶんの ID をまとめて引く（N+1 にしない）。

### 4.3 `metadata`

- 更新できる主なオブジェクトに `metadata`（文字列から文字列への対応）を持たせる。上限は本家と同じ：キー 50 個、キー 40 文字、値 500 文字、キーに `[` と `]` を使えない（[Metadata](https://docs.stripe.com/api/metadata)）。
- 更新は差分で行う。渡したキーだけを書き換え、値を `null` にしたキーを消す。`metadata: null` で全部を消す。本家の v1 は空文字列で消し、v2 は `null` で消す（[API v2 overview](https://docs.stripe.com/api-v2-overview)）。本文を JSON にしたので、v2 に合わせる。
- 本システムは `metadata` を判定（オーソリ、不正検知のルール）に使わない。本家と同じ。
- カード番号などの機微な情報を入れないよう文書で求める。CDE の外のログ・DB の走査（ADR-0005 の Confirmation）は `metadata` も対象にし、カード番号の形を見つけたら警告する。
- DB では `jsonb` の列に持つ。検索（5.3 節）の対象にする。

## 5. 一覧と検索

### 5.1 一覧のページング

本家の v1 と同じ形にする（[Pagination](https://docs.stripe.com/api/pagination)）。

| 項目 | 内容 |
| --- | --- |
| パラメーター | `limit`（1〜100、既定 10）、`starting_after`、`ending_before`（オブジェクトの ID。同時に使えない） |
| 並び | 新しい順（作成の降順） |
| 応答 | `{ "object": "list", "url": "/v1/customers", "has_more": true, "data": [...] }` |
| 絞り込み | `created[gte]` などの範囲と、リソースごとの項目（`customer` など） |

- カーソルは ID そのもの。ID が UUIDv7 なので、`WHERE (account_id, id) < (:account, :cursor) ORDER BY id DESC LIMIT n+1` で引ける。カーソルの ID が存在するかは確かめない（消えたオブジェクトの ID でも続きを引ける）。
- 一覧は、書いた直後でも一貫して読める（writer から読むか、reader の遅延を許さない一覧は writer を使う）。本家も v1 の上位の一覧は即時に一貫すると書いている（[API v2 overview](https://docs.stripe.com/api-v2-overview)）。
- `total_count` は出さない（本家の v1 の一覧も出さない）。

### 5.2 自動のページング

- SDK に、`has_more` と `starting_after` を使って全件をたどる反復子を持たせる（本家の auto-pagination と同じ）。

### 5.3 検索 API（E11）

- 本家と同じく、Customer・PaymentIntent・Charge に `GET /v1/<リソース>/search?query=...` を持たせる。問い合わせの言語（`field:value`、`AND` / `OR`、`-` での否定、`~` の部分一致、数値の比較、`metadata["k"]:"v"`、最大 10 句）は本家に合わせる（[Search](https://docs.stripe.com/search)）。
- 結果は即時には反映されない。本家は「通常 1 分以内」とし、書いた直後の読み取りに使わないよう求めている。本システムも同じ約束にし、outbox から検索用の索引を更新する。
- ページングは本家の検索と同じく `page`（不透明なトークン）と `next_page`。
- レート制限は、検索のエンドポイント全体で 1 秒 20 件（本家と同じ。[rate-limiting.md](rate-limiting.md)）。
- 索引の実装（Aurora の上か、別の検索エンジンか）は E11 で決める。MVP は一覧の絞り込みだけを出す。

## 6. バージョン

方針は [ADR-0007](../decisions/0007-date-based-api-versions.md)。

### 6.1 本家の仕組み（確かめたこと）

| 項目 | 本家 |
| --- | --- |
| バージョンの形 | `YYYY-MM-DD.<名前>`。2024-09-30.acacia から、毎月は互換性を保つバージョンを出し、年 2 回、互換性を壊す変更で始まる大きなリリースを出す（acacia → basil 2025-03-31 → clover 2025-09-30 → dahlia 2026-03-25）。現在は 2026-08-26.dahlia（[Versioning](https://docs.stripe.com/api/versioning)、[Changelog](https://docs.stripe.com/changelog)） |
| アカウントの既定のバージョン | 最初の API 要求の時点のバージョンがアカウントに固定される。`Stripe-Version` を付けない要求は既定のバージョンで動く（[API upgrades](https://docs.stripe.com/upgrades)） |
| 要求ごとの上書き | `Stripe-Version` 見出しで、その要求だけ別のバージョンにできる。応答もそのバージョンの形になる |
| SDK | 新しい SDK は、SDK のリリース時点のバージョンを送る（stripe-node は v12 から） |
| Webhook | エンドポイントの作成時にバージョンを指定でき、なければアカウントの既定のバージョンで描く。作成後は変えられないので、新しいバージョンのエンドポイントを作って移る |
| 内部の実装 | 互換性を壊す変更ごとに「バージョンの変更モジュール」を書き、応答を最新の形から要求のバージョンまで、時間を遡って変換する（[APIs as infrastructure: future-proofing Stripe with versioning](https://stripe.com/blog/api-versioning)、2017） |
| 上げたバージョンを戻す | 過去の文書には「上げてから 72 時間は戻せる」とあったが、2026-09-26 の [API upgrades](https://docs.stripe.com/upgrades) には記述がない。本システムは 6.5 節で自分の設計として決める |

### 6.2 本システムのバージョン

- **形は本家と同じ `YYYY-MM-DD.<名前>`。** 名前は大きなリリースごとに、アルファベット順の木の名前を付ける。本家の名前（acacia など）は使わない。同じ名前だと、本家の同じバージョンと互換だと誤解されるため。
- 最初のバージョンは、E1 で公開 API を最初に出す日の日付と、最初の名前で切る。
- 互換性を保つ変更（項目・エンドポイント・列挙値・イベントの種類の追加）は、日付のバージョンを上げずに全バージョンへ出す。本家と同じく、応答に項目が増えることを互換の範囲とし、クライアントに未知の項目・列挙値の無視を求める。
- 互換性を壊す変更だけが、新しい日付のバージョンと変更モジュールを作る。月ごとの定期のリリースは持たない（変更がある月にだけバージョンを切る）。大きなリリース（名前の変更）は、互換性を壊す変更をまとめて年 2 回までにする。
- **古いバージョンは止めない。** 本家も古いバージョンを動かし続けている。変換モジュールの保守のコストが、バージョンの数ではなく変更の数に比例するようにする（6.3 節）。止める必要が出たら、新しい ADR で決める。

### 6.3 バージョンの決まり方

| # | `<Brand>-Version` 見出し | アカウントの既定のバージョン | 使うバージョン |
| --- | --- | --- | --- |
| 1 | あり、存在するバージョン | - | 見出しのバージョン |
| 2 | あり、存在しないバージョン | - | 400（`invalid_request_error`、`api_version_invalid`） |
| 3 | なし | あり | 既定のバージョン |
| 4 | なし | なし（最初の要求） | 最新のバージョン。この要求で既定のバージョンとして固定する |

- 公開可能キーの要求も同じ規則。Elements・Checkout は自分のバージョンを必ず付けて送る。
- ダッシュボードは、ビルドが固定したバージョンを送る（[dashboard.md](dashboard.md)）。アカウントの既定のバージョンは、ダッシュボードの要求では固定しない（4 行目を適用しない）。

### 6.4 変更モジュール

```ts
// packages/api-versions/changes/2027-03-xx-remove-legacy-field.ts（形の例）
export default defineVersionChange({
  version: "2027-03-xx.birch",
  description: "Removes `payment_intent.legacy_field`.",
  resources: ["payment_intent"],
  transformResponse: (obj) => ({ ...obj, legacy_field: deriveLegacy(obj) }),
  transformRequest: (params) => params,          // 任意
  sideEffects: false,                             // 振る舞いの変更なら true
});
```

- ハンドラーとサービス関数は、常に最新の形だけを扱う。
- 応答は、最新のバージョンから要求のバージョンまで、間にある変更モジュールを新しい順に適用して作る。要求の変換は古い順に適用する。
- 形の変換で表せない振る舞いの変更（例：既定の値の変更、状態遷移の違い）は `sideEffects: true` にし、サービス関数に `ctx.apiVersion` による分岐を書く。分岐は変更モジュールの ID で参照し（`isBefore(ctx, change)`）、日付の比較をコードに散らさない。
- 変更モジュールは、影響する項目の説明を持ち、開発者向けの変更履歴と、バージョンごとの OpenAPI（9 節）をそこから生成する。
- Event は内部に最新の形で持ち、配信のときに Webhook のエンドポイントのバージョンへ変換する（[events-and-webhooks.md](events-and-webhooks.md)）。`GET /v1/events/{id}` は要求のバージョンで変換する。

### 6.5 バージョンの上げ方

- 加盟店は、ダッシュボードで既定のバージョンを上げる。上げる前に、`<Brand>-Version` 見出しで新しいバージョンを試せる。
- 上げてから 72 時間は、前のバージョンに戻せるようにする（本家の過去の振る舞いに倣った、本システムの決定。本家が今も同じかには依らない）。戻すと、その間に新しい形で送って失敗した Webhook は古い形で再試行する。
- 既定のバージョンの変更は監査ログ（[auth-and-keys.md](auth-and-keys.md) の 9 節）に残す。
- ダッシュボードに、キーごと・バージョンごとの要求の数を出し、古いバージョンの利用を加盟店が見られるようにする（E7）。

## 7. 冪等

方針は [ADR-0004](../decisions/0004-idempotency.md)。ここでは API の層の詳細を決める。

### 7.1 本家の振る舞い（確かめたこと）

[Idempotent requests](https://docs.stripe.com/api/idempotent_requests)、[Advanced error handling](https://docs.stripe.com/error-low-level)、[Error codes](https://docs.stripe.com/error-codes) による。

- すべての `POST` が `Idempotency-Key` を受ける。`GET`・`DELETE` では意味がない。キーは 255 文字まで。
- 最初の要求の状態コードと本文を、成否にかかわらず保存し、同じキーには同じ結果（500 を含む）を返す。
- 保存は、エンドポイントの実行が始まってから。検証に失敗した要求と、並行して実行中の要求と衝突した要求は保存しない（再試行できる）。
- 同じキーでパラメーターやエンドポイントが違えば `idempotency_error`。並行して使われていれば `idempotency_key_in_use`（409）。
- キーは 24 時間以上経てば消してよく、消えた後の同じキーは新しい要求として扱う。
- 再生した応答には `Idempotent-Replayed: true` が付く。
- v2 は保存の期間が 30 日で、失敗した要求を再実行する。本システムは v1 の意味に合わせる（ADR-0004）。

### 7.2 保存

```
idempotency_keys（test・live の各クラスタ。テナントテーブル、RLS）
  account_id, key, created_at, request_method, request_path,
  request_hash, api_version, state (started | completed),
  locked_until, response_status, response_body (jsonb), resource_id
  PRIMARY KEY (account_id, key, created_at)  -- 日ごとのパーティション
```

- 範囲は「アカウント × 環境 × キー」。環境はクラスタが分かれている（ADR-0002）ので、列には持たない。キーごとの主体（どの API キーか）は範囲に含めない。本家もアカウントの中で一意とする。
- `request_hash` は、メソッド・パス・正規化した本文（キーの並びを揃えた JSON）の SHA-256。バージョンは含めない（同じキーでバージョンだけ違う再送は、同じ要求とみなし、最初のバージョンの応答を返す）。
- 日ごとのパーティションにし、48 時間より古いパーティションを `DROP` する。24 時間の約束を、少なくとも 24 時間・最大 48 時間で守る。

### 7.3 手順と決定表

1. 検証（スキーマ、権限、バージョン）。失敗したら記録せずに返す。
2. `started` の行を作る（`locked_until` = 今 + 60 秒）。主キーがパーティションの鍵（`created_at`）を含み、パーティションをまたぐ一意を張れないので、`pg_advisory_xact_lock` で `(account_id, key)` を直列にし、直近 48 時間のパーティションに同じキーがないことを確かめてから挿入する（[data-model/audit-and-operations.md](data-model/audit-and-operations.md) の 2.1 節）。
3. 行が既にあれば、下の表に従う。
4. 実行する。お金を動かす処理は、内部の冪等キー（ADR-0004 の内部の層）を使う。
5. 応答を `completed` として保存する。状態を変えた処理では、状態の遷移と同じトランザクションで保存する。コネクタを呼ぶ処理では、コネクタの結果を反映するトランザクションで保存する。

| # | 同じキーの行 | 要求の中身 | 結果 |
| --- | --- | --- | --- |
| 1 | なし | - | 実行し、結果を保存する |
| 2 | `started`、`locked_until` 前 | - | 409 `idempotency_error` / `idempotency_key_in_use`、`<Brand>-Should-Retry: true` |
| 3 | `started`、`locked_until` 後（処理が異常終了した） | 同じ | 行を取り直して回復する。内部の冪等キーで、済んだ段は飛ばし、残りを実行する |
| 4 | - | メソッド・パス・本文のどれかが違う | 400 `idempotency_error`（保存しない） |
| 5 | `completed` | 同じ | 保存した応答を返す。`Idempotent-Replayed: true` |

- 500 も `completed` として保存する（本家と同じ）。お金の結果が不明な 500 は、[payments.md](payments.md) の照合で前に進めるか戻し、その結果を Event で知らせる。本家も 500 は「結果不明」とし、裏で調整して Webhook を送る。
- 3 行目の回復は、本家の文書にはない本システムの設計である。ECS のタスクが処理の途中で落ちても、加盟店の再送で処理を完結させるため。
- レート制限（429）とキーの認証の失敗（401）は冪等の層より前で返るので、記録しない。

### 7.4 冪等キーを付けない要求

- 受け付ける（本家と同じ）。SDK は、書き込みの要求に既定で UUIDv4 のキーを付け、再試行で同じキーを使う（本家の SDK と同じ）。
- 決済の作成・確定・キャプチャ・返金・Payout の作成で、キーのない要求の割合をメトリクスにし、ダッシュボードで加盟店に見せる（E7）。

## 8. エラー

本家の形に合わせる（[Errors](https://docs.stripe.com/api/errors)）。

```json
{
  "error": {
    "type": "card_error",
    "code": "card_declined",
    "decline_code": "insufficient_funds",
    "message": "Your card has insufficient funds.",
    "param": null,
    "doc_url": "https://docs.<domain>/error-codes/card-declined",
    "request_log_url": "https://dashboard.<domain>/logs/req_...",
    "payment_intent": { "id": "pi_...", "object": "payment_intent", "...": "..." }
  }
}
```

| 項目 | 内容 |
| --- | --- |
| `type` | `api_error`・`card_error`・`idempotency_error`・`invalid_request_error` の 4 つ（本家と同じ） |
| `code` | 機械が分岐に使う安定した識別子。一覧は `packages/contract/public/errors.ts` の列挙にし、OpenAPI と文書に出す |
| `decline_code` | カードの拒否の理由（`insufficient_funds`、`do_not_honor` など）。アクワイアラの応答コードをコネクタで本家の語彙に写す（[payment-methods.md](payment-methods.md)） |
| `advice_code`・`network_decline_code` | 取れたときだけ。写し方はコネクタに依る |
| `param` | 入力の誤りの項目（`amount`、`metadata[foo]`） |
| `payment_intent` など | 決済に関わる失敗では、失敗した状態のオブジェクトを付ける |

| 状態コード | 主な場面と `code` |
| --- | --- |
| 400 | `parameter_missing`、`parameter_unknown`、`parameter_invalid_*`、`api_version_invalid`、`idempotency_error` |
| 401 | キーがない・不正・期限切れ（`api_key_expired`） |
| 402 | 決済の失敗（`card_error`：`card_declined`、`expired_card`、`incorrect_cvc`、`authentication_required`） |
| 403 | 制限付きキーの権限不足、アクセスポリシーでの拒否（[auth-and-keys.md](auth-and-keys.md)） |
| 404 | `resource_missing` |
| 409 | `idempotency_key_in_use`、状態の衝突 |
| 415 | JSON 以外の本文 |
| 424 | 外部（アクワイアラ）の失敗で完了できない。本家にもある状態コード |
| 429 | レート制限（`rate_limit`）、オブジェクトのロック待ちの時間切れ（`lock_timeout`） |
| 500・503 | `api_error` |

- 本家の `code` の名前（`resource_missing`、`parameter_missing`、`payment_intent_unexpected_state`、`livemode_mismatch`、`lock_timeout` など）は、[Error codes](https://docs.stripe.com/error-codes) に存在することを確かめた。同じ意味の場面では同じ名前を使う。
- `message` は人が読むもので、変わりうる。カードのエラーの `message` は、顧客に見せてよい文にする（本家と同じ）。日本語の文言は、ブラウザ側（Elements・Checkout）で `code` と `decline_code` から出す。
- 存在を知らせてはいけない相手（別のアカウント、別の環境）には 404 を返す。
- `request_log_url` は、ダッシュボードの要求のログ（[auth-and-keys.md](auth-and-keys.md) の 9.2 節）への URL。

### 8.1 再試行の合図

`Stripe-Should-Retry` は本家の見出しで、`true` は「待ってから再試行せよ」、`false` は「再試行しても無駄」、なしは「サーバーには分からない」を意味する（[Advanced error handling](https://docs.stripe.com/error-low-level)）。

| 場面 | `<Brand>-Should-Retry` |
| --- | --- |
| 429（レート制限、`lock_timeout`） | `true` |
| 409 `idempotency_key_in_use` | `true` |
| 503（ops フラグでの停止、依存先の一時的な障害で、副作用がないと分かっている） | `true` |
| 400・401・403・404・402 | `false` |
| 500（結果不明） | 付けない |

## 9. 契約と OpenAPI

- ルートは `@hono/zod-openapi` で定義し、OpenAPI 3.1 を生成する（Slack の public-api.md の 6 節と同じ）。公開用のスキーマは `packages/contract/public` に置き、内部のスキーマを import しない。
- **OpenAPI はバージョンごとに出す。** 最新のバージョンの文書を生成し、変更モジュールの記述から古いバージョンの差分を当てて、バージョンごとの文書を作る。本家も OpenAPI を公開している（[stripe/openapi](https://github.com/stripe/openapi)）。
- CI で OpenAPI を再生成して差分を検査する。最新のバージョンで、互換性を壊す変更（項目の削除、型の変更、必須化、列挙値の削除）が、変更モジュールなしに入ったら失敗させる（oasdiff など）。
- 拡張の属性：`x-rate-limit`（[rate-limiting.md](rate-limiting.md) のどの制限に属するか）、`x-permission`（制限付きキーの権限。[auth-and-keys.md](auth-and-keys.md) の 6 節）、`x-expandable`。

## 10. SDK

- **公式の SDK は TypeScript（Node）の 1 つだけ。** OpenAPI から型と薄いクライアントを生成し、手で書くのは次だけにする。
  - バージョンの固定：SDK のリリース時点の最新のバージョンを `<Brand>-Version` で送る（本家の stripe-node v12 以降と同じ）
  - 再試行：ネットワークの失敗・409・429・`<Brand>-Should-Retry: true` で、指数的な間隔とゆらぎで再試行する。既定の回数は本家の stripe-node と同じ 1 回（[stripe-node の README](https://github.com/stripe/stripe-node)）
  - 書き込みへの `Idempotency-Key` の自動付与
  - 一覧の自動のページング
  - Webhook の署名の検証（[events-and-webhooks.md](events-and-webhooks.md)）
- ブラウザ向けは Elements・Checkout のスクリプト（[checkout.md](checkout.md)）で、公開可能キーだけを使う。
- 他の言語は OpenAPI からの生成に任せる。
- **本家の SDK との互換は約束しない。** 本文が JSON で、`metadata` の消し方も違うので、本家の SDK の接続先を変えただけでは動かない。

## 11. テスト環境と本番環境

方針は [ADR-0002](../decisions/0002-account-tenancy.md)（DB のクラスタを分ける）と [ADR-0008](../decisions/0008-api-keys-and-dashboard-access.md)。

### 11.1 本家の仕組み（確かめたこと）

- すべての要求は、サンドボックスか本番のどちらかで動く。それぞれ専用のキーの組を持ち、一方のオブジェクトは他方から使えない（[API keys](https://docs.stripe.com/keys)）。
- アカウントには「テスト環境のサンドボックス」（1 つ、消せない、設定の一部を本番と共有する）と、作れる「一般のサンドボックス」（最大 5 つ、設定を完全に分ける、作成時に本番の設定を写せる、利用者ごとに入れる範囲を絞れる）がある。新しい実装には一般のサンドボックスを勧めている（[Testing use cases](https://docs.stripe.com/testing-use-cases)、[Sandboxes](https://docs.stripe.com/sandboxes)）。
- サンドボックスではカードネットワークや決済代行は決済を処理せず、テスト用のカード番号で結果が決まる。
- サンドボックスのレート制限は本番より低い（[rate-limiting.md](rate-limiting.md)）。

### 11.2 本システムの環境

| 環境 | 置き場所 | キー | 接続先 |
| --- | --- | --- | --- |
| 本番 | live のクラスタ | `<brand>_pk_live_`・`<brand>_sk_live_`・`<brand>_rk_live_` | 本物のコネクタ |
| サンドボックス | test のクラスタ | `<brand>_pk_test_`・`<brand>_sk_test_`・`<brand>_rk_test_` | 模擬のアクワイアラ（テスト用のカード番号で結果が決まる） |

- **サンドボックスは、test のクラスタの中の、独立したアカウント（`acct_`）として作る。** 本番のアカウントを `parent_account_id` で指す。こうすると、サンドボックスの中の分離が、アカウントの RLS（ADR-0002）だけで済む。
- **設定は本番と共有しない。** 本家の「一般のサンドボックス」の振る舞いに合わせる。作成時に本番の設定（ブランド、決済手段の有効化、Webhook のエンドポイントを除く）を写せる。本家の「テスト環境のサンドボックス」の、設定を本番と共有する振る舞いは再現しない。共有すると、テストの操作で本番の設定が変わる事故が起きるため。
- MVP（E1）では、アカウントの作成時にサンドボックスを 1 つ自動で作る。ダッシュボードではこれを「テスト環境」と呼ぶ（[dashboard.md](dashboard.md) の 4 節）。追加のサンドボックス（最大 5 つ）と、利用者ごとの入れる範囲の設定は E11。
- オブジェクトの `livemode` は、live のクラスタでは `true`、test のクラスタでは `false`。
- 模擬のアクワイアラのテスト用のカード番号と、3D セキュア・拒否・Dispute の再現の方法は、本家のテスト用の番号に合わせる（[payment-methods.md](payment-methods.md)、E1 の `mock-acquirer`）。
- サンドボックスで作ったキーで本番のオブジェクトを指すと 404（`resource_missing`）。本番のキーで、テスト用のカード番号を使うと、本家と同じく 402、`code: card_declined`、`decline_code: testmode_decline` にする（[Decline codes](https://docs.stripe.com/declines/codes)、2026-09-27 に確認）。

## 12. 観測

- 要求ごとに記録する：`Request-Id`、アカウント、環境、キーの ID（`rak_`）、メソッド、ルートの型、状態コード、`error.code`、バージョン、冪等キーの有無と再生か、処理時間、送信元の IP。本文は記録しない（[auth-and-keys.md](auth-and-keys.md) の 9.2 節の要求のログは、項目を絞って加盟店に見せる）。
- メトリクス：エンドポイント × 状態コード、バージョンごとの要求の数（古いバージョンの利用）、冪等の再生と 409 の数、変換モジュールの適用の時間。アカウントのラベルは上位 N 件と「その他」に丸める。
- 合成監視：サンドボックスで「PaymentIntent の作成 → 確定 → キャプチャ → 返金」を、最新のバージョンと最も古いバージョンの両方で回す。

## 13. テスト

- 契約：OpenAPI のスナップショットと、バージョンごとの互換性の検査。
- 変更モジュール：各モジュールに、変換の前後の例（固定のオブジェクト）を持たせる。全バージョンについて「最新の形 → 各バージョンへの変換」が、そのバージョンの OpenAPI のスキーマに合うことを性質ベーステストで確かめる。
- 冪等：7.3 節の決定表。同じキーの並行の要求で、作られるオブジェクトが 1 つだけ（ADR-0004 の性質）。
- ページング：任意の作成・削除の列の後で、`starting_after` でたどった全件が、重複も欠けもなく新しい順に並ぶ。
- `expand`：権限のない展開が 403、4 段を超える展開が 400。
- 環境：`<brand>_sk_test_` の要求が live のクラスタに接続しない（ADR-0002 の Confirmation）。

## 14. 段階ごとの変化

| 段階 | 変化 |
| --- | --- |
| S1 | `/v1` の最初のバージョン。環境はアカウントごとに本番とサンドボックス 1 つ |
| S2 | 検索 API、追加のサンドボックス（E11）。読み取りの一覧を reader に寄せる |
| S3 | セル構成。キーの ID からアカウントとセルを引く索引を、セルの外に置く（[auth-and-keys.md](auth-and-keys.md) の 11 節）。パスにアカウントを含めないので、振り分けはキーで行う |

## 15. 決定と持ち越し（2026-09-26、既定案）

- **キーの接頭辞**：`<brand>_{pk|sk|rk}_{live|test}_` にした（4.1 節、リポジトリ共通の ADR-0006）。ADR-0002・0008 の接頭辞の表記もこれに改めた。
- **`.preview` のバージョン**：MVP では持たない。公開前の機能は、アカウント単位の release フラグで限った加盟店にだけ出す（[delivery.md](delivery.md)）。
- **上げたバージョンを戻せる期間**：72 時間（6.5 節）。本家の現行の文書に記述がないので、本システムの決定として持つ。
- 持ち越し：検索 API の索引の実装（Aurora の上か、別の検索エンジンか）は、E11 の PoC で決める（[roadmap.md](../roadmap.md)）。

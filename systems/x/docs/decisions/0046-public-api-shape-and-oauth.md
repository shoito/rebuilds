---
status: accepted
date: 2026-10-04
---

# ADR-0046: 公開 API は `/v1/` の REST で、ID は文字列、一覧は `tid` の範囲と署名した `next_token` で送る。認証は OAuth 2.0 の認可コード＋PKCE と、公開の読み出しだけのアプリのトークン

## Context

公開 API は MVP に入る（[intent.md](../intent.md)）。投稿・利用者・タイムライン・検索・DM の読み書き、OAuth 2.0（PKCE）を持つ。

- 本家の API は、パスに `/2/` を持ち、`next_token` を次の要求の `pagination_token` に入れて送り、新しいものは `since_id` で取る（[Pagination](https://docs.x.com/x-api/fundamentals/pagination)、2026-10-04 に確認）。
- `tid` は生成器の間でおおむね時刻の順で、確定の順と一致しない。「最新の ID より新しいもの」には重なりの窓が要る（[ADR-0002](0002-post-ids-and-ordering.md)）。
- 公開 API も見える範囲の経路の 1 つ（[ADR-0004](0004-single-tenant-and-visibility.md)、[quality.md](../quality.md) の 2.2.1 節）。
- 本家の名前を識別子に使わない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## Options

形：

1. **REST（JSON）、パスに主のバージョン**
2. GraphQL
3. 本家の API と同じ形（互換）

認証：

- a. **OAuth 2.0 の認可コード＋PKCE（S256 必須）と、client credentials のアプリのトークン（公開の読み出しだけ）**
- b. a に加えて OAuth 1.0a

## Decision

1 と a を採用する。詳細は [api-and-rate-limits.md](../architecture/api-and-rate-limits.md) の 3・4 節。

- ベースは `https://api.<brand>.<domain>/v1/`。OpenAPI 3.1 をコードから生成し、TypeScript の SDK を作る。
- ID は 10 進の文字列。応答は `data`・`includes`・`meta`・`errors`。エラーは RFC 9457。書き込みは `Idempotency-Key` を受ける。
- 一覧は `since_id`・`until_id`・`max_results`（既定 20、最大 100）と、HMAC で署名した不透明な `next_token`（24 時間）。`since_id` は 10 秒ぶん戻した位置から返し、クライアントが ID で重複を落とすことを文書に書く。
- 同じバージョンの中では足すだけ。壊す変更は `/v2/` にし、古いバージョンは 12 か月の告知（`Deprecation`・`Sunset`）の後に止める。
- 見えない投稿は `not_found` と同じ形で返す。アプリのトークンの閲覧者は「ログインしていない人」。おすすめは公開 API に出さない。
- トークンは `<brand>_oat_`・`<brand>_ort_`・`<brand>_app_`・`<brand>_ocs_` の接頭辞、base62 の乱数 32 文字、チェックサム 6 文字。SHA-256 で保存する。アクセストークン 2 時間、リフレッシュトークンは入れ替えと再使用の検出。
- 2 を採らない理由：問い合わせの形が自由で、レート制限と計量の単位（返した投稿の件数）を決めにくい。画面の API とも形が分かれる。
- 3 を採らない理由：本家の SDK との互換は目標にしない（[intent.md](../intent.md) の Non-goals）。名前の規則にも反する。
- b を採らない理由：署名の方式が古く、PKCE で足りる。

## Consequences

- 良くなること：
  - 単位（件数）での計量と、レート制限の桶の分け方が素直になる。
  - 画面と同じ `visible()` を通り、アプリの権限で見える範囲を広げない。
- 引き受けるコスト：
  - `since_id` の重複を、クライアントに落としてもらう必要がある。
  - 本家の API に慣れた開発者の移行の手間。
  - バージョンの 12 か月の並行の運用。

## Confirmation

- 契約の検査：OpenAPI の差分で、v1 の中の壊す変更を拒む（[delivery.md](../architecture/delivery.md) の 7.3 節）。
- 性質ベーステスト：PROP-API-001（`next_token` の改ざんと流用の拒否）、PROP-API-002（`since_id` の窓で抜けない）。
- 結合テスト：漏れの経路の表の「公開 API」の行。

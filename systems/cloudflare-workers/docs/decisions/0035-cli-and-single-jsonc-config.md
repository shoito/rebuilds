---
status: accepted
date: 2026-09-27
---

# ADR-0035: CLI は TypeScript で npm に配り、設定ファイルは `<brand>.jsonc` の 1 つの形にする

詳細は [developer-tooling.md](../architecture/developer-tooling.md) の 4 節と 5 節。

## Context

intent の MVP は、CLI から 1 回のコマンドでデプロイでき、導入から最初の応答まで中央値 5 分以内（K4）を求める。CLI は、本番と同じランタイムで手元を動かすために workerd のバイナリを持つ必要がある（[architecture/README.md](../architecture/README.md) の 4 節）。

本家の振る舞い（2026-09-27 に確認）：

- CLI は Node.js の npm パッケージで、`init`・`dev`・`deploy`・`versions`・`rollback`・`secret`・`tail`・`types` を持つ（[Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)）。
- 設定ファイルは TOML・JSON・JSONC の 3 つの形を受ける。新しい計画には JSONC を勧め、新しい機能の一部は JSON の形だけで使える。バインディングは環境に受け継がない（[Configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)）。

本家の CLI・設定ファイルとの完全な互換は目標にしない（intent の Non-goals、[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## Options

1. **TypeScript の CLI を npm に配り、workerd のバイナリを任意の依存で入れる。設定は `<brand>.jsonc` だけ**
2. Go の 1 つのバイナリ（rebuilds の Kafka の題材の CLI と同じ）に workerd を同梱する
3. 設定の形を TOML と JSONC の 2 つにする

## Decision

1 を採用する。

- CLI は TypeScript で、Node.js 22 以上で動く。npm の `<brand>` を計画ごとの `devDependencies` にし、版を計画ごとに固定する。
- workerd は `@<brand>/workerd-<os>-<arch>` を任意の依存で入れる。中身は本番と同じ下流のビルド。SHA-256 を CLI のパッケージに書き、起動時に照合する。
- 設定ファイルは `<brand>.jsonc` だけ。JSON Schema を公開し、同じスキーマから CLI の Zod を作る。知らないキーは誤りにする。必須は `name`・`main`・`compatibility_date`。環境の受け継ぎの規則は本家に寄せる（バインディング・ルート・cron は受け継がない）。
- ログインは OAuth 2.0 の認可コード＋PKCE（RFC 8252 のループバック）。ブラウザのない環境はデバイスの認可（RFC 8628）。CI は `<BRAND>_API_TOKEN`。トークンは OS のキーチェーンに置く。
- `deploy` は冪等キーを付けて版を作り、100% のデプロイを作り、伝搬を待つ。デプロイ済みの版の設定との差を示す。
- 2 を採らない理由：バンドル（esbuild）、Node.js の polyfill（unenv）、Vitest の統合、型の生成はどれも Node.js の生態系にある。Go で書くと、これらを別の Node.js の処理として呼ぶことになる。利用者の多くは Node.js を持つ。
- 3 を採らない理由：2 つの形の検証と文書を保つ手間に見合わない。本家も JSON に寄せている。

## Consequences

- 良くなること：
  - バンドルから型の生成まで 1 つの言語で書ける。
  - 計画ごとに CLI と workerd の版が固定され、チームの中で手元の振る舞いが揃う。
  - エディターの補完とスキーマの検証が同じ定義から来る。
- 引き受けるコスト：
  - 本家の TOML の設定を使う人は、書き直しが要る（変換の道具は持たない）。
  - workerd のバイナリの配布（5 つの形、署名、照合）を持つ。
  - 本番のランタイムが週 1 回上がるので、CLI も週 1 回出す。

## Confirmation

- 表駆動テスト：設定の必須のキー、知らないキー、環境の受け継ぎ、`limits` の上限。
- 結合テスト：同じ冪等キーの `deploy` の再送で版が 1 つ。workerd のバイナリの SHA-256 の不一致で起動を止める。
- E2E：新しい機械で導入から公開の URL の応答まで 5 分以内（毎週）。

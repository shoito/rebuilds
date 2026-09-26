---
status: accepted
date: 2026-09-26
---

# ADR-0008: API の契約を Hono RPC の型で共有する

ADR-0007 の確認方法のうち「契約から生成したコードの差分検査」を、この ADR の確認方法に置き換える。

## Context

Web クライアント・API・Gateway の間の契約を、エージェントが境界をまたいで変更しても崩れないようにしたい。クライアントは TypeScript のモノレポ内にしかなく、外部に公開する API は MVP の範囲外である（intent.md の Non-goals）。

## Options

1. **OpenAPI を正とし、クライアントを生成する**（Zod スキーマ → OpenAPI → クライアントのコード生成）
2. **Hono RPC**：API アプリの型（`AppType`）をクライアントが `hc<AppType>` で直接参照する
3. **tRPC**

## Decision

2 を採用する。

- **生成を挟まずに型でつながる。** サーバーのルート、バリデーター、`c.json(body, status)` の型がそのままクライアントに伝わり、ステータスコードごとにレスポンスの型を絞り込める。生成物のコミットや再生成忘れがない。
- **エージェントが変更の影響をすぐ知れる。** API の入出力を変えると、クライアント側の型検査が直ちに失敗する。
- **Hono のルーティングと HTTP の意味論をそのまま使える。** 3 の tRPC も型でつながるが、独自のプロトコルになる。将来 REST として公開する余地を残したいので採らない。
- **1 は外部公開 API が必要になったときに移る。** `@hono/zod-openapi` を使えば、RPC の型付けを保ったまま OpenAPI を出力できる。

### 構成

| 場所 | 役割 |
| --- | --- |
| `packages/contract` | 入出力と WebSocket イベントの Zod スキーマ。ランタイムでの検証と型の両方に使う |
| `apps/api` | capability ごとにルートを分け（`routes/messages.ts` など）、メソッドチェーンで定義して型を保つ。`zValidator` で `packages/contract` のスキーマを使う。`c.json()` には必ずステータスコードを明示する。`AppType` を export する |
| `packages/api-client` | `hcWithType` で、クライアントの型を tsc で事前にコンパイルしたもの。Web はこれだけを使う |
| `apps/web` | `packages/api-client` を TanStack Query で包んで使う |
| `apps/gateway` | WebSocket の接続は `hc` の `$ws()` で型付けできるが、メッセージの中身は型付けされない。送受信するイベントは、両端で `packages/contract` のイベントスキーマで検証する |

## Consequences

- 良くなること：
  - 契約の変更が、型検査の失敗として即座に見える。
  - OpenAPI の生成と、その同期の手間がない。
- 引き受けるコスト：
  - クライアントとサーバーが TypeScript で強く結合する。TypeScript 以外のクライアントを作るときは、OpenAPI の出力が必要になる。
  - ルートが増えると、型の推論が重くなり、IDE と tsc が遅くなる。capability ごとにルートとクライアントを分け、`hcWithType` で事前にコンパイルして抑える。
  - ルートをメソッドチェーンで書かないと、型が失われる。lint とレビューで守る。
  - クライアントとサーバーの両方の `tsconfig.json` で `"strict": true` が必要になる。

## Confirmation

- `packages/api-client` のコンパイル結果（`.d.ts`）を、API の表面のスナップショットとしてコミットする。CI で再生成し、差分があれば失敗させる。契約を変えるときはスナップショットを更新し、その差分を Dev（テックリード）が承認する（`CODEOWNERS`）。
- WebSocket のイベントスキーマに対して、契約テストを行う（quality.md のテストのレベル構成）。

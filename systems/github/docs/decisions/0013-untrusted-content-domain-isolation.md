---
status: accepted
date: 2026-09-26
---

# ADR-0013: 利用者の内容は、アプリとは別の登録可能ドメインから配り、豊かな描画は隔離した iframe で行う

> 識別子（ヘッダー・接頭辞・ドメイン・環境変数・パスの名前）は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に合わせて `<Brand>`・`<brand>`・`<BRAND>` の置き換え用の名前にした（2026-09-26）。本家の名前は、出典の説明としてだけ書く。

## Context

リポジトリのファイルと、Issue・PR・コメントの本文は、すべて信頼できない入力である。

- Markdown の中の HTML
- SVG（スクリプトを含められる）
- HTML のファイル
- ノートブックの出力（HTML と JavaScript を含む）
- 外部の画像

これらをアプリのオリジンで描画・配信すると、XSS でセッションと非公開のリポジトリの中身が盗まれる。

本家は、利用者の内容を `*.githubusercontent.com` から配り、「ドメインの分離そのものが統制である」としている。github.com の Cookie とセッションに届かないようにするためである（[GitHub Bug Bounty: *.githubusercontent.com](https://bounty.github.com/targets/githubusercontent-com.html)）。外部の画像は Camo でプロキシする（[About anonymized URLs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls)）。

## Options

1. **アプリとは別の登録可能ドメインから利用者の内容を配り、豊かな描画（ノートブックなど）はそのドメインの sandbox の iframe で行う。Markdown はサーバーで無害化してアプリのドメインに出す**
2. アプリのサブドメイン（`raw.<brand>.<domain>` など）から配る
3. すべてをアプリのドメインで、無害化と CSP だけで守る

## Decision

1 を採用する。詳細は [web.md](../architecture/web.md) の 4〜6 節にある。

- **利用者の内容のドメインは、アプリと別の登録可能ドメインにする**（名前は `<brand>usercontent.<domain>` の形。実際の名前は開発リポジトリの作成時に決める。ADR-0006）。
  - 用途ごとにサブドメインを分ける：生のファイル、添付・アバター、画像のプロキシ、描画の iframe。
  - Public Suffix List に登録し、サブドメインどうしも別のサイトにする。
  - このドメインは Cookie で認証しない。
- **Markdown は、サーバーで GFM を HTML にし、許可リストで無害化してから、アプリのドメインに出す。** 本家の描画の流れ（変換 → `script`・インラインの style・`class`・`id` などを除く無害化 → 後処理）と同じ順にする（[github/markup](https://github.com/github/markup)）。
  - 無害化は 1 か所で行う。結果は型（`SanitizedHtml`）で区別する。
  - DOM への HTML の差し込みは、Trusted Types のこの 1 つのポリシーだけにする。
- **SVG は `<img>` でだけ表示する。** アプリの DOM にインラインで入れない。
- **ノートブック・Mermaid・GeoJSON・STL・PDF は、描画の隔離のドメインの iframe で表示する。**
  - iframe は `sandbox="allow-scripts"` で、`allow-same-origin` を付けない。
  - 親とのやり取りは `postMessage` で、形と送り元を検査する。
- **生のファイルは、HTML・JavaScript として解釈させない形で配る。**
  - `Content-Type` はテキストか `application/octet-stream`（画像を除く）にし、`nosniff` と CSP の `sandbox` を付ける。
  - 非公開のリポジトリは、アプリで権限を判定した後の短命の署名付きの URL で配る。
- **外部の画像は、隔離した取得器の画像のプロキシを通す。** アプリの CSP の `img-src` に任意の外部のホストを許さない。
- 2 は、サブドメインが同じサイトになり、`SameSite` の Cookie が送られ、Cookie の注入（`Domain=` の上書き）で、アプリのセッションを固定・上書きされうる。
- 3 は、無害化の 1 つの誤り、CSP の 1 つの迂回が、そのままセッションの窃取になる。SVG やノートブックのように、スクリプトを動かしたい内容を安全に扱えない。

## Consequences

- 良くなること：
  - 無害化の漏れや、利用者の内容のドメインでのスクリプトの実行が、アプリのセッションに届かない。多層の防御になる。
  - 閲覧者の IP とブラウザの情報を、外部の画像の置き主に渡さない。
- 引き受けるコスト：
  - ドメイン・証明書・CDN の配信を 2 系統持つ。
  - 非公開のファイルの URL にトークンが載る。期限まで（5 分程度）は、URL を得た人が読める。`Referrer-Policy: no-referrer` とログからの除去で緩和する。
  - iframe の描画は、高さの調整や、親の画面との連携（リンク・選択）に手間がかかる。

## Confirmation

- XSS の性質ベーステスト：生成した悪意のある Markdown・HTML の断片（イベントの属性、`javascript:` の URL、`<svg>` の埋め込み、DOM clobbering の `id`・`name`、変異 XSS の形）を描画した結果に、実行可能な要素と属性が含まれない。
- E2E のテスト：悪意のある SVG・HTML・ノートブックを、ファイルの画面・生のファイル・添付・iframe のそれぞれで開いても、アプリのオリジンで JavaScript が実行されず、アプリの Cookie が読めない。
- 設定の検査：アプリのドメインの CSP に、利用者の内容のドメインの `script-src` や、任意の外部のホストの `img-src` が含まれない。利用者の内容のドメインの応答に `nosniff` と CSP の `sandbox` が付いている。
- lint：`dangerouslySetInnerHTML` と `innerHTML` の使用を、無害化の出口の 1 か所以外で禁止する。

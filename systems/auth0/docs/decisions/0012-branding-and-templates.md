---
status: accepted
date: 2026-09-27
---

# ADR-0012: ブランディングはテーマの変数と文言の上書きに限り、テナントの任意の HTML・JavaScript は画面に入れない

## Context

テナントは、ログインの画面を自社のサービスに見えるようにしたい。本家 Auth0 の新しい Universal Login は、次の手段を持つ（2026-09-27 に確認）。

- テーマの編集（色、書体（CORS で配る WOFF の URL）、枠線、背景、ロゴの URL・位置・高さ、配置）（[Customize Themes](https://auth0.com/docs/customize/login-pages/universal-login/customize-themes)）
- 画面（prompt）と言語ごとの文言の上書き（[Customize Text Elements](https://auth0.com/docs/customize/login-pages/universal-login/customize-text-elements)）
- Liquid で書くページのテンプレート。`auth0:head` と `auth0:widget` のタグを必ず含める。**カスタムドメインが必須**で、Management API でだけ更新できる。CSS のクラス名と HTML の構造はビルドのたびに変わりうる（[Customize Universal Login Page Templates](https://auth0.com/docs/customize/login-pages/universal-login/customize-templates)）
- サインアップ・ログインの画面の決まった位置（entry point）に、HTML・CSS・JavaScript・Liquid の部品（partials）を差し込める。1 つ 10,000 文字まで。カスタムドメインとページのテンプレートが前提（[Customize Signup and Login Prompts](https://auth0.com/docs/customize/login-pages/universal-login/customize-signup-and-login-prompts)）

テナントの任意の JavaScript をログインの画面に入れると、パスワードが入る画面で第三者のコードが動く。strict CSP（[ADR-0011](0011-universal-login-rendering-and-transaction.md)）が崩れ、テナントの管理者のアカウントが乗っ取られたときに、エンドユーザーのパスワードを盗む経路になる。電気通信事業法の外部送信規律（[intent.md](../intent.md) の L2）の論点も、テナントが入れた計測のスクリプトで増える。

## Options

1. **テーマの変数（色、ロゴ、書体の一覧、角丸、配置）と、文言の上書きに限る。任意の HTML・CSS・JavaScript は入れない**
2. 1 に加え、ヘッダーとフッターに、許可したタグだけの HTML（サニタイズ済み）を入れられる
3. 本家と同じく、Liquid のテンプレートと partials（JavaScript を含む）を入れられる

## Decision

MVP は 1 を採用する。2 は MVP の後の候補（E11 の後）とし、3 は採らない。

- **テーマ**：`branding_themes` に、色（主色、背景、文字、リンク、エラー、成功）、角丸、ロゴ（本システムの資産のストレージにアップロードしたもの。外部の URL は受け付けない）、ファビコン、背景画像、配置（中央・左・右）、書体（本システムが配る一覧から選ぶ。日本語は Noto Sans JP などの配信を持つ）を持つ。
  - 色は、文字と背景のコントラスト比が WCAG 2.2 AA（4.5:1）を満たさない組み合わせを保存時に警告する（拒否はしない）。
  - ロゴなどの資産は、アップロードの時に画像の形式（PNG・JPEG・WebP・SVG）と大きさ（1 MB 以内）を確かめる。SVG はスクリプトと外部の参照を取り除いてから配る。資産は CloudFront から配る（[ADR-0005](0005-authentication-path-availability.md)）。
- **文言の上書き**：画面・言語・キーごとに、テナントが文言を上書きできる。値は平文として扱い、HTML として解釈しない。変数（`${clientName}` など、画面ごとに決めた一覧）だけを展開する。
- **アプリごとの差**：テーマはテナントに 1 つと、アプリごとの上書き（ロゴと主色だけ）を持てる。Organizations（E14）では組織ごとの上書きを足す。
- **カスタムドメインを前提にしない。** 本家はテンプレートにカスタムドメインを求めるが、本システムの 1 の範囲は任意のコードを含まないので、`<tenant>.jp.<brand>.<domain>` でも使える。
- **テナントの計測・チャットのスクリプトは入れない。** ログインの完了や離脱の計測が要るテナントには、ログのイベント（logs-and-streams の領域）を使ってもらう。
- 2 は、サニタイズの誤りがそのまま XSS になるので、MVP では避ける。入れるときは、許可するタグと属性の一覧、`<a>` の `href` の `https:` への限定、CSP の変更なしで表示できることを条件に、別の ADR で決める。
- 3 は、上の Context の理由で採らない。本家との違いとして記録する。

## Consequences

- 良くなること：
  - ログインの画面で、本システムが書いたコードだけが動く。strict CSP を全テナントで同じに保てる。
  - 画面の HTML の構造を変えても、テナントの見た目が壊れない（テナントは構造に依存できない）。
- 引き受けるコスト：
  - 本家のページのテンプレートからの移行で、見た目を完全には再現できないテナントがある。
  - 独自の入力欄（サインアップの追加の項目）が要るテナントには、本システムが用意する項目の型（テキスト、選択、チェックボックス）を設定で足す形を、MVP の後に作る必要がある。同意のチェックボックスは [ADR-0013](0013-consent-records.md) で扱う。

## Confirmation

- 結合テスト：テーマと文言に `<script>`、`javascript:`、`"><img onerror=...>` などを入れても、画面にそのまま文字として出て、実行されない。
- 結合テスト：SVG のロゴから `<script>`、`on*` 属性、外部の `href` が除かれる。
- 合成監視：本番の監視用のテナントで、`/u/login` の CSP のヘッダーが期待の値と一致する（リリースごと）。

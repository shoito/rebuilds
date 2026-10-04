---
capability: messaging
change: 260926-message-body-ast-v1
issue:
epic: E1
status: approved
---

# Spec: 本文の AST v1

## 概要

メッセージの本文を表す AST の v1 を、`packages/contract` の Zod スキーマとして確定する（[ADR-0006](../../decisions/0006-message-body-ast.md)、[messaging.md](../../architecture/messaging.md) の「本文（AST）」と「上限」）。あわせて、本文を扱う共通の関数と、安全な描画の部品を作る。

- 本文のスキーマ、上限、検証の順序
- `toPlainText`：長さの検査（REQ-MSG-006）、検索、通知、MCP で使う、ただ 1 つのテキスト化の関数
- `parsePlainText`：MCP と公開 API が受け取るプレーンテキスト（`<@member_id>`、`<#channel_id>`）から AST を作る関数
- バージョンの管理（`upgradeBody`）
- 本文を React の要素として描く `MessageBody` と、その安全の制約

含めないもの：API のルート（[260926-post-and-list-messages](../260926-post-and-list-messages/spec.md)）、メンションの相手がワークスペースのメンバーかの確認とロールによる使用の制限（E3 の `mentions-and-broadcast`）、入力欄と AST の変換（E3 の `composer-prosemirror-ast`）、公開 API の「リッチテキスト v1」（E12）、絵文字の一覧の固定（E3 の `reactions`）。

この変更の要件は、REQ-MSG-006 の「文字」の数え方（その変更の Open questions）に答える。REQ-MSG-006 の本文は変えない。

## ADDED Requirements

### REQ-MSG-007: 本文のスキーマ

システムは、本文を Design の「スキーマ」の形の AST v1 としてだけ受け付けなければならない。未知のノードの種類、定義にない項目、必須の項目の欠落を含む本文は、400 で拒否しなければならない。

#### Scenario: 段落とメンション

- When `{ v: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "確認お願いします " }, { type: "mention", member_id: "0192a5a4-0000-7000-8000-000000000001" }] }] }` を検証する
- Then 検証に通る

#### Scenario: 未知のノード

- When `{ v: 1, blocks: [{ type: "html", html: "<b>x</b>" }] }` を検証する
- Then 400（`reason`=`invalid_schema`）になる

#### Scenario: 定義にない項目

- When `text` のノードに `style: "color:red"` を足した本文を検証する
- Then 400（`reason`=`invalid_schema`）になる

### REQ-MSG-008: リンクの URL

`link` のノードの `url` が、スキームが `http`・`https`・`mailto` の絶対 URL でない場合、または前後に空白・制御文字を含む場合、システムは本文を 400 で拒否しなければならない。

#### Scenario: javascript スキーム

- When `url` が `javascript:alert(1)`、`JavaScript:alert(1)`、` javascript:alert(1)`（先頭に空白）の本文をそれぞれ検証する
- Then 3 件とも 400（`reason`=`invalid_schema`）になる

#### Scenario: 許可するスキーム

- When `url` が `https://example.com/a?b=c`、`http://example.com`、`mailto:a@example.com` の本文をそれぞれ検証する
- Then 3 件とも検証に通る

### REQ-MSG-009: 文字列の制約

本文のいずれかの文字列が U+0000 か、対になっていないサロゲートを含む場合、システムは本文を 400 で拒否しなければならない。PostgreSQL の `jsonb` に保存できない値を受け付けないため。

#### Scenario: NUL 文字

- When `text` が `"a\u0000b"` の本文を検証する
- Then 400（`reason`=`invalid_schema`）になる

#### Scenario: 対になっていないサロゲート

- When `text` が `"\uD800"` だけの本文を検証する
- Then 400（`reason`=`invalid_schema`）になる

### REQ-MSG-010: 構造の上限と検証の順序

本文を検証するとき、システムは DT-MSG-002 の順に上限を検査し、最初に外れた上限の `reason` を付けて 400 を返さなければならない。上限は次のとおり。

- JSON のサイズ（`JSON.stringify` の結果の UTF-8 のバイト数）：128 KiB（131,072 バイト）以下
- ブロックの入れ子の深さ（最上位のブロックを 1 とし、`quote` の子と `list` の項目の中のブロックで 1 増える）：6 以下
- 異なる `member_id` の `mention` の数：50 以下

#### Scenario: 深さ 6 と 7

- When `quote` を 5 重に入れ子にし、その中に段落を置いた本文（深さ 6）と、6 重にした本文（深さ 7）を検証する
- Then 深さ 6 は検証に通り、深さ 7 は 400（`reason`=`too_deep`）になる

#### Scenario: メンションの数

- When 異なる 50 人へのメンションと、そのうち 1 人への重複したメンションを含む本文と、異なる 51 人へのメンションを含む本文を検証する
- Then 前者は検証に通り、後者は 400（`reason`=`too_many_mentions`）になる

#### Scenario: 文字数の上限の内側でもサイズで拒否される

- When 絵文字「😀」（4 バイト）を 40,000 個並べた `text` の本文を検証する
- Then 400（`reason`=`too_large`）になる。文字数（40,000）は REQ-MSG-006 の上限の内側だが、サイズの検査が先に当たる

### REQ-MSG-011: バージョン

本文を書き込むとき、システムは最新のバージョン（`v` = 1）の本文だけを受け付けなければならない。保存された本文を読み出すとき、システムは `body_format` のバージョンから最新のバージョンへ変換して返さなければならない。`body_format` が未知のバージョンであるか、本文の `v` と一致しない場合、システムは読み出しを失敗として報告し、既知のバージョンとして解釈してはならない。

#### Scenario: 古いバージョン・未来のバージョンの書き込み

- When `v` が 2 の本文を検証する
- Then 400（`reason`=`invalid_schema`）になる

#### Scenario: v1 の読み出し

- Given `body_format` = 1 で保存された本文
- When 読み出しの変換を通す
- Then 保存されたものと等しい v1 の本文が返る

#### Scenario: 未知のバージョンの読み出し

- Given `body_format` = 2 で保存された行（v1 しか知らないビルド）
- When 読み出しの変換を通す
- Then エラー `unsupported_body_version` になり、本文は返らない

### REQ-MSG-012: テキスト化と文字数

システムは、本文のテキスト化を 1 つの関数 `toPlainText` で、DT-MSG-003 に従って行わなければならない。REQ-MSG-006 の「文字数」は、トークンの形（既定）での `toPlainText` の結果の Unicode のコードポイントの数とし、「空」は、`text` と `code_block` の文字列がすべて空白だけで、`text` 以外のインラインのノードを 1 つも含まない本文としなければならない。

#### Scenario: 絵文字の数え方

- Given 「あ」を 39,999 個と「😀」を 1 個並べた `text` の本文（UTF-16 では 40,001 単位）
- When 文字数を数える
- Then 40,000 である

#### Scenario: 段落と引用

- Given 段落「了解です」と、段落「前回の件」を含む `quote` の本文
- When `toPlainText` を呼ぶ
- Then `了解です\n> 前回の件` が返る

#### Scenario: 表示名で書き出す

- Given `mention`（M1）だけを子に持つ段落 1 つの本文、M1 の表示名が「佐藤」
- When 表示の形（名前を引く関数を渡す）で `toPlainText` を呼ぶ
- Then `@佐藤` が返る。トークンの形では `<@M1>` が返る

#### Scenario: メンションだけの本文は空でない

- When `mention` のノードだけを含む本文と、全角の空白「　」だけの `text` を含む本文を検証する
- Then 前者は検証に通り、後者は 400（`reason`=`empty`）になる

### REQ-MSG-013: プレーンテキストからの変換

プレーンテキストを受け取ったとき、システムは DT-MSG-004 に従って AST v1 に変換しなければならない。Markdown などのほかの記法を解釈してはならない。U+0000 か対になっていないサロゲートを含む入力は、400 で拒否しなければならない。

#### Scenario: メンションとチャンネル

- Given `M1`・`C1` は小文字の正規形の UUID
- When `"<@M1> さん、<#C1> を見てください\n*急ぎ*"` を変換する
- Then 結果は、段落 2 つ。1 つ目は `mention(M1)`、`text("さん、")`、`channel_link(C1)`、`text(" を見てください")`、2 つ目は `text("*急ぎ*")`（太字にしない）

#### Scenario: URL の自動認識

- When `"資料は https://example.com/a. です"` を変換する
- Then 結果は `text("資料は ")`、`link(url="https://example.com/a")`、`text(". です")` の段落 1 つ

#### Scenario: ブロードキャストの形は文字列のまま

- When `"<!channel> お知らせ"` を変換する
- Then 結果は `text("<!channel> お知らせ")` の段落 1 つで、`broadcast` のノードを作らない

### REQ-MSG-014: 安全な描画

本文を描画するとき、システムは AST を React の要素に変換して描き、Design の「描画」の表にある要素と属性だけを出さなければならない。HTML の文字列を組み立ててはならず、すべての文字列（本文、表示名、チャンネル名、URL）をテキストとして描かなければならない。

#### Scenario: 本文に HTML を書く

- Given `text` が `<img src=x onerror=alert(1)>` の本文
- When 描画する
- Then 画面には `<img src=x onerror=alert(1)>` という文字列が表示され、`img` の要素は作られない

#### Scenario: 表示名に HTML を書く

- Given メンションの相手の表示名が `<script>alert(1)</script>`
- When 描画する
- Then `@<script>alert(1)</script>` という文字列が表示され、`script` の要素は作られない

#### Scenario: 読めないチャンネルへのリンク

- Given `channel_link` の先を、名前を引く関数が返さない（読めない、または存在しない）
- When 描画する
- Then 「プライベートチャンネル」と表示され、チャンネルの ID もリンクも出ない

#### Scenario: 外部のリンク

- When `url` が `https://example.com`、`text` が「資料」の `link` を描画する
- Then `<a href="https://example.com" rel="noopener noreferrer" target="_blank">資料</a>` になる

### REQ-MSG-015: 描画できない本文

描画する本文が REQ-MSG-007〜011 の検証に通らない場合、または未知のバージョンである場合、システムは「このメッセージは表示できません」と描画し、例外を投げてはならない。

#### Scenario: 未来のバージョンの本文

- When `v` が 2 の本文を描画する
- Then 「このメッセージは表示できません」と表示され、一覧のほかのメッセージは描画される

## Decision Tables

### DT-MSG-002: 本文の検証の順序

上から順に評価し、最初に一致した行を採用する。サイズと JSON の入れ子を先に見るのは、スキーマの検査（再帰）に巨大な入力や深い入力を渡さないため。空と文字数（REQ-MSG-006）は、スキーマに通った後でなければテキスト化できないため、スキーマの後に見る。

| # | サイズ > 128 KiB | JSON の入れ子 > 32 | スキーマに合わない（REQ-MSG-007〜009、バージョン ≠ 1 を含む） | ブロックの深さ > 6 | 空 | 文字数 > 40,000 | 異なる @メンバー > 50 | → 結果 | → `reason` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | はい | - | - | - | - | - | - | 400 | `too_large` |
| 2 | いいえ | はい | - | - | - | - | - | 400 | `too_deep` |
| 3 | いいえ | いいえ | はい | - | - | - | - | 400 | `invalid_schema` |
| 4 | いいえ | いいえ | いいえ | はい | - | - | - | 400 | `too_deep` |
| 5 | いいえ | いいえ | いいえ | いいえ | はい | - | - | 400 | `empty` |
| 6 | いいえ | いいえ | いいえ | いいえ | いいえ | はい | - | 400 | `too_long` |
| 7 | いいえ | いいえ | いいえ | いいえ | いいえ | いいえ | はい | 400 | `too_many_mentions` |
| 8 | いいえ | いいえ | いいえ | いいえ | いいえ | いいえ | いいえ | 通る | - |

- JSON の入れ子は、オブジェクトと配列の入れ子の数（本文の最上位のオブジェクトを 1 とする）。深さ 6 の正しい本文の入れ子は 24 程度なので、32 で正しい本文を拒否しない。
- この表は、[DT-MSG-001](../260926-post-and-list-messages/spec.md) の「本文が有効」の中身にあたる。権限の判定（DT-MSG-001 の 1 行目）は、この表より先に行う。

### DT-MSG-003: テキスト化

ノードごとの書き出し方。モードは「トークン」（既定。長さの検査と MCP に使う）と「表示」（名前を引く関数を渡す。検索と通知に使う）の 2 つ。最上位のブロックどうしは `\n` でつなぐ。

| # | ノード | 条件 | → トークンのモード | → 表示のモード |
| --- | --- | --- | --- | --- |
| 1 | `paragraph` | - | 子を順に連結 | 同左 |
| 2 | `code_block` | - | `text` をそのまま | 同左 |
| 3 | `quote` | - | 子のブロックを `\n` でつなぎ、各行の先頭に `> ` を付ける | 同左 |
| 4 | `list` | `ordered` = false | 項目ごとに、項目のブロックを `\n` でつなぎ、1 行目に `- `、2 行目以降に空白 2 つを付ける。項目どうしは `\n` でつなぐ | 同左 |
| 5 | `list` | `ordered` = true | 4 と同じで、1 行目の印を `1. `、`2. ` …にする | 同左 |
| 6 | `text` | - | `text`（`marks` は無視） | 同左 |
| 7 | `link` | `text` がない、または `url` と同じ | `url` | 同左 |
| 8 | `link` | `text` があり、`url` と違う | `text (url)` | 同左 |
| 9 | `mention` | 名前が引けた | `<@member_id>` | `@表示名` |
| 10 | `mention` | 名前が引けない | `<@member_id>` | `<@member_id>` |
| 11 | `channel_link` | 名前が引けた | `<#channel_id>` | `#チャンネル名` |
| 12 | `channel_link` | 名前が引けない | `<#channel_id>` | `<#channel_id>` |
| 13 | `broadcast` | - | `<!here>` / `<!channel>` / `<!everyone>` | `@here` / `@channel` / `@everyone` |
| 14 | `emoji` | - | `:name:` | 同左 |

### DT-MSG-004: プレーンテキストの解釈

入力を先頭から読み、各位置で上から順に評価し、最初に一致した行を採用する。

| # | その位置から始まる文字列 | → 作るもの |
| --- | --- | --- |
| 1 | `\n` | 今の段落を閉じ、新しい段落を始める |
| 2 | `<@` ＋ 小文字の正規形の UUID ＋ `>` | `mention { member_id }` |
| 3 | `<#` ＋ 小文字の正規形の UUID ＋ `>` | `channel_link { channel_id }` |
| 4 | `http://` か `https://` で始まり、空白・`<`・`>` の直前まで続く文字列。ただし末尾の `.`・`,`・`)`・`!`・`?`・`:`・`;` を除く。`isSafeUrl` が真のものだけ | `link { url }`（`text` を持たない） |
| 5 | それ以外の 1 文字（`<!here>` など、2・3 に当たらない `<` を含む） | 直前の `text` に足す（なければ `text` を始める。`marks` なし） |

- 入力が空なら、子のない段落 1 つを作る。空の `text` は作らない。
- 大文字を含む UUID は 2・3 に当たらず、文字列のまま残る（REQ-MSG-013、PROP-MSG-003 のため）。
- URL の自動認識（4 行目）は、本家 Slack と同じく行う。`text` を持たない `link` は `toPlainText` で `url` に戻る（DT-MSG-003 の 7 行目）ので、PROP-MSG-003 の往復は保たれる。

## Correctness Properties

### PROP-MSG-003: プレーンテキスト → AST → プレーンテキストの往復

U+0000 と対になっていないサロゲートを含まない任意の文字列 s に対して、`toPlainText(parsePlainText(s))`（トークンのモード）は s と等しい。

### PROP-MSG-004: AST → プレーンテキスト → AST の往復

「プレーンの部分集合」に属する任意の本文 b に対して、`parsePlainText(toPlainText(b))` は b と等しい。プレーンの部分集合とは、ブロックが 1 つ以上の `paragraph` だけで、インラインが `marks` のない `text`（空でなく、`\n` と DT-MSG-004 の 2・3 に当たる部分文字列を含まない）、`mention`、`channel_link` だけで、`text` が隣り合わない本文を指す。

### PROP-MSG-005: どんな本文を描画しても実行可能な HTML にならない

任意の JSON の値を本文として、任意の文字列を返す名前を引く関数とともに `MessageBody` で描画すると、例外を投げず、その HTML を HTML のパーサーで読んだ結果は次を満たす。要素は Design の「描画」の表にあるものだけ。属性は表にあるものだけで、`on` で始まる属性、`style`、`src`、`srcdoc`、`formaction` を含まない。すべての `href` のスキームは `http`・`https`・`mailto` のどれか。

### PROP-MSG-006: 検証に通った本文は保存しても変わらない

検証に通った任意の本文 b に対して、`JSON.parse(JSON.stringify(b))` は b と深く等しく、`JSON.stringify(b)` は `\u0000` と対になっていないサロゲートを含まない。

### PROP-MSG-007: 検証は例外を投げず、通った本文は上限を満たす

任意の JSON の値 x に対して、検証の関数は例外を投げずに「通る」か DT-MSG-002 の `reason` のどれかを返す。「通る」なら、x はスキーマに合い、REQ-MSG-006 と REQ-MSG-010 のすべての上限を満たし、`toPlainText` と空の判定は例外を投げない。

## Design

### スキーマ

`packages/contract/src/body/` に置く。形は [messaging.md](../../architecture/messaging.md) の「本文（AST）」と同じで、次を足す。

```ts
type Body = { v: 1; blocks: Block[] };            // blocks は 1 つ以上

type Block =
  | { type: "paragraph"; children: Inline[] }     // children は空でもよい（空行）
  | { type: "code_block"; text: string; lang?: string }   // lang は /^[a-z0-9+#-]{1,32}$/
  | { type: "quote"; children: Block[] }          // 1 つ以上
  | { type: "list"; ordered: boolean; items: Block[][] };  // 項目は 1 つ以上、各項目のブロックも 1 つ以上

type Inline =
  | { type: "text"; text: string; marks?: ("bold" | "italic" | "strike" | "code")[] }  // text は空でない。marks は重複なし
  | { type: "link"; url: string; text?: string }  // REQ-MSG-008
  | { type: "mention"; member_id: string }        // 小文字の正規形の UUID
  | { type: "channel_link"; channel_id: string }  // 同上
  | { type: "broadcast"; range: "here" | "channel" | "everyone" }
  | { type: "emoji"; name: string };              // /^[a-z0-9_+-]{1,64}(::skin-tone-[2-6])?$/
```

- すべてのオブジェクトを `strict`（定義にない項目を拒否）にする。Zod の既定の「捨てる」にしないのは、クライアントが送った項目が黙って消えると、契約の誤りに気づけないため。
- `text` の中の `\n` は許す（段落の中の改行）。描画では改行として表示する。
- 公開する関数：`BodySchema`、`validateBody`（DT-MSG-002）、`toPlainText`、`isBlankBody`、`countBodyChars`、`parsePlainText`、`isSafeUrl`、`upgradeBody`、`LATEST_BODY_VERSION`、`BODY_LIMITS`。性質ベーステスト用のジェネレーターを `packages/contract/body/testing` から出し、後の変更（入力欄、検索、MCP、公開 API、UI ブロック）でも使う。
- API は、400 の応答に `{ error: "invalid_body", reason }` を返す。この形は [260926-post-and-list-messages](../260926-post-and-list-messages/spec.md) の契約に足す必要がある（Open questions）。

### 描画

`packages/ui/src/message-body/MessageBody.tsx` に置く。引数は本文、メンバーの表示名を引く関数、チャンネル名を引く関数（読めなければ何も返さない）。

| AST | 要素 | 属性 |
| --- | --- | --- |
| `paragraph` | `p` | `class` |
| `code_block` | `pre` > `code` | `class`、`data-lang` |
| `quote` | `blockquote` | `class` |
| `list` | `ul` / `ol` > `li` | `class` |
| `text` の `marks` | `strong`、`em`、`s`、`code` | `class` |
| `link`（`isSafeUrl` が真） | `a` | `href`、`rel="noopener noreferrer"`、`target="_blank"`（`mailto` では付けない）、`class` |
| `link`（`isSafeUrl` が偽） | `span`（`text` か `url` を文字列で） | `class` |
| `mention`、`channel_link`、`broadcast`、`emoji` | `span` | `class`、`data-member-id` / `data-channel-id` |
| 改行（`text` の中の `\n`） | `br` | なし |
| 描画できない本文 | `p` | `class` |

- 表示名が引けないメンバーは「@不明なメンバー」と描く。絵文字は、同梱の一覧にあれば Unicode の文字、なければ `:name:` の文字列で描く。画像は出さない。
- `dangerouslySetInnerHTML`・`innerHTML`・`eval` を使わない。`packages/ui` と `apps/web` の lint で `react/no-danger` を有効にする。
- 描画の前に `validateBody` と `upgradeBody` を通す（REQ-MSG-015）。スキーマで拒否した `url` も、描画の直前に `isSafeUrl` でもう一度確かめる（二重の防御）。

### バージョンの管理

- `upgradeBody(bodyFormat, stored)`：`bodyFormat` が 1 なら `validateBody` を通して返す。それ以外は `unsupported_body_version` を投げる。v2 を作るときは、`upgrade_v1_to_v2` をここに足す（messaging.md の「バージョン管理」）。
- 保存済みの行は一括で書き換えない。

## Open questions

- （決定）REQ-MSG-006 の「文字」は、`toPlainText` の結果のコードポイントで数える。書記素で数える案は、結果が Unicode のバージョンと実装に依存するため採らない（PM、2026-09-26）。
- 400 の応答に `reason` を足す契約の変更を、[260926-post-and-list-messages](../260926-post-and-list-messages/spec.md) に含めるか、この変更に含めるか（Dev）。
- （決定）プレーンテキストの URL は、自動で `link` にする。DT-MSG-004 の 4 行目（PM、2026-09-26。本家 Slack に合わせる）。
- `emoji` の名前を、固定した絵文字の一覧で検証するか。一覧は E3 の `reactions` で `packages/contract` に置く予定なので、それまでは形だけを検証する（Dev）。
- 双方向の制御文字（U+202E など）による表示の偽装を、スキーマで拒否するか、描画で無害にするか（Dev、QA）。
- `MessageBody` を `packages/ui` に置くと、この変更で `packages/ui` の骨格も作ることになる。`web-app-shell-routing` と骨格の作成がぶつからないよう、先に着手した側が作る（Dev）。

## 決定（2026-09-26、PM・QA、既定案）

上の Open questions は、次のとおり決めた。

- 400 の `reason` の値の定義は、この変更（`validateBody`）が持つ。API の応答に載せるのは `post-and-list-messages`（反映済み）。
- `emoji` の名前は、E3 の `reactions` までは形だけを検証する。
- 双方向の制御文字は、スキーマでは拒否しない。描画で無害にする（テキストを `bdi` で分離し、`dir="auto"` を付ける）。
- `packages/ui` の骨格は、この変更と `web-app-shell-routing` のうち、先に着手した側が作る。

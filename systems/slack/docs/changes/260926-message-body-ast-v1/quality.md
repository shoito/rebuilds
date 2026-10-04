# Quality: 本文の AST v1

- Change: 260926-message-body-ast-v1
- Spec: [spec.md](spec.md) / Plan: [plan.md](plan.md)
- 題材の品質戦略: [quality.md](../../quality.md)
- 作成の理由: 新しいテスト基盤が必要（本文の AST の任意生成のジェネレーターと、描画した HTML の安全の判定器。後の変更でも使う）

## 1. リスク

| この変更で壊れうるもの | 題材の quality.md との関係 |
| --- | --- |
| 本文や表示名から、実行可能な HTML が描かれる（XSS）。XSS は、読める範囲のデータの持ち出しや、なりすましの投稿につながる | リスク 1 位（権限外のデータが見える）の経路の 1 つ。security.md の「XSS」の検査（AST の描画の性質ベーステスト） |
| `jsonb` に保存できない本文を受け付け、投稿が 500 になる、または保存済みの本文を読めなくなる | リスク 2 位（成功を返したメッセージが消える）に近い。受け付けた後で保存に失敗する形 |
| テキスト化の出力が経路ごとに違い、文字数の上限・検索・MCP の結果が食い違う | 題材のリスク表にはない。契約の安定性 |

## 2. テスト設計

### 2.1 ジェネレーター

`packages/contract/src/body/testing/arbitraries.ts` に置き、後の変更（入力欄、検索、MCP、公開 API、UI ブロック）でも使う。fast-check で作る。

| 名前 | 生成するもの | 分布・工夫 |
| --- | --- | --- |
| `arbBodyString` | 本文の文字列 | 通常の文字（ASCII、ひらがな・漢字、絵文字、結合文字）を 70%、攻撃のコーパス（2.2 節）を 20%、境界の文字（`\n`、`\r`、U+2028、U+FEFF、U+202E、正しいサロゲートの対）を 10%。U+0000 と単独のサロゲートは含めない |
| `arbRawString` | 検証の負例に使う文字列 | `arbBodyString` に、U+0000 と単独のサロゲートを 5% 混ぜる |
| `arbUuid` | 小文字の正規形の UUID | 10% は大文字を混ぜた「正規形でない UUID」を別の生成器として出す |
| `arbInline` / `arbBlock` / `arbBody` | 検証に通る本文 | 深さは 1〜6 を一様に。ノードの種類は一様。`maxLength` で本文のサイズを 128 KiB の内側に収める（収まらなければ `filter` ではなく、生成の段階で長さを配分する） |
| `arbPlainSubsetBody` | PROP-MSG-004 のプレーンの部分集合 | `paragraph` と `text`・`mention`・`channel_link` だけ。隣り合う `text` を結合し、トークンの形の部分文字列を含む `text` を作らない |
| `arbPlainText` | PROP-MSG-003 の入力 | `arbBodyString` に、`<@uuid>`・`<#uuid>`・`<!here>`・不完全なトークン（`<@`、`<@abc>`、`<@` ＋ 大文字の UUID ＋ `>`）を 30% の確率で差し込む |
| `arbAnyJson` | PROP-MSG-005, 007 の任意の入力 | `fc.jsonValue()` に、正しい本文の一部を壊したもの（項目の削除、型の差し替え、未知の `type`、深い入れ子、`url` の差し替え）を 50% 混ぜる |

- 試行の回数は plan の Proof の表のとおり。失敗したら、fast-check の種と縮小後の反例をテストの出力に出す。
- 夜間の CI では、PROP-MSG-005 だけ回数を増やす（200,000 回）。

### 2.2 攻撃のコーパス

`packages/contract/src/body/testing/corpus/` に、次のテキストのファイルを置く。公開されている XSS のペイロードの一覧（OWASP の XSS Filter Evasion Cheat Sheet など）から、要素・属性・スキームの種類が重ならないように 200 件程度を選ぶ。

| 種類 | 例 |
| --- | --- |
| 要素 | `<script>`、`<img onerror>`、`<svg onload>`、`<iframe srcdoc>`、`<math>`、`<style>`、`<object>`、`<embed>`、`<form>` |
| 属性の脱出 | `" onmouseover="`、`' autofocus onfocus='`、`` ` `` |
| URL のスキーム | `javascript:`、`JaVaScRiPt:`、`java\tscript:`、`&#106;avascript:`、`data:text/html,`、`vbscript:`、先頭の空白・制御文字、`\u0000` |
| エンティティ・符号化 | `&lt;script&gt;`、`%3Cscript%3E`、全角の `＜script＞` |

### 2.3 描画の安全の判定器

PROP-MSG-005 の判定。`react-dom/server` の `renderToStaticMarkup` の出力を、parse5 で HTML の断片として読み、木を辿って次を調べる。文字列の検索（`<script` を含まないか）では判定しない。テキストとして正しく表示された `<script>` という文字列を、誤って失敗にしてしまうため。

| ID | 観点 | 条件 | 期待結果 | 要件 / 性質 |
| --- | --- | --- | --- | --- |
| Q1 | 要素 | すべての要素 | spec の Design の「描画」の表にある要素だけ | PROP-MSG-005 |
| Q2 | 属性 | すべての属性 | 表にある属性だけ。`on*`、`style`、`src`、`srcdoc`、`formaction` がない | PROP-MSG-005 |
| Q3 | `href` | すべての `a` | WHATWG の URL として解釈したスキームが `http:`・`https:`・`mailto:` のどれか | PROP-MSG-005、REQ-MSG-008 |
| Q4 | 外部リンク | `http`・`https` の `a` | `rel` に `noopener` と `noreferrer` がある | REQ-MSG-014 |
| Q5 | 例外 | 任意の入力 | 描画が例外を投げない。検証に通らない入力は「このメッセージは表示できません」の 1 要素だけになる | PROP-MSG-005、REQ-MSG-015 |

判定器は `packages/ui/test/support/html-safety.ts` に置き、E12 の UI ブロック（apps.md の性質）でも使う。

### 2.4 境界値

| 対象 | 境界 |
| --- | --- |
| サイズ | 131,071 / 131,072 / 131,073 バイト |
| JSON の入れ子 | 32 / 33 |
| ブロックの深さ | 6 / 7（`quote` だけ、`list` だけ、両者の混在） |
| 文字数 | 40,000 / 40,001 コードポイント（ASCII、ひらがな、絵文字で。絵文字では `too_large` が先に当たる組み合わせも含める） |
| メンション | 異なる 50 / 51 人、同じ人への重複 |

## 3. テスト環境とテストデータ

- 単体・性質ベースのテストは Node の Vitest だけで動かす。ブラウザは使わない（描画は `react-dom/server` で調べる）。
- PROP-MSG-006 の保存の確認だけ、Testcontainers の PostgreSQL（本番と同じバージョン）を使う。
- 攻撃のコーパスは、リポジトリに置くテキストのファイルで、外部から取得しない。

## 4. 合否の判定基準

- Proof の表のすべてが通る。
- PROP-MSG-005 が、PR の 10,000 回と、夜間の 200,000 回の両方で反例 0 件。
- 攻撃のコーパスの全件で、Q1〜Q5 が通る。
- 反例が見つかったら、縮小後の反例を単体テストとして固定してから直す（回帰テスト）。

## 5. リリース後の品質の確認

この変更はリリースのフラグを持たず、利用者に届くのは `post-and-list-messages` と `web-channel-view` の後になる。そのときに見る指標を、Ops に依頼する。

- 本文の検証の拒否の数を、`reason` ごとに（`invalid_body` の 400。急増したら、クライアントとの契約の食い違いを疑う）
- 描画できない本文の表示の数（RUM。0 件が正常。1 件でもあれば調査する）
- CSP の違反の報告（E7 の `security-headers-csp` の後）

## 6. 題材の quality.md へ反映する知見

- 本文の AST のジェネレーター（2.1 節）と攻撃のコーパス（2.2 節）を、題材の quality.md の 2.2.1 節の「クライアント」と「公開 API・アプリ」の重点のテストから参照する。
- 描画の安全の判定は、文字列の検索ではなく、HTML のパーサーの木で行う（2.3 節）。

# Web: GitHub

Web の画面の構成、コードの閲覧（ツリー、ファイル、blame、履歴）、表示の上限、信頼できない内容（Markdown・SVG・ノートブック）の安全な描画、生のファイルの配信、CSP、性能の予算、アクセシビリティ、多言語化。PR の画面の中身は [pull-requests.md](pull-requests.md) にある。

前提として、次の決定に従う。

| 決定 | Web への影響 |
| --- | --- |
| [ADR-0001](../decisions/0001-platform-and-stack.md) | Web は TypeScript（Hono、React）。Git の中身はストレージの RPC で読む |
| [ADR-0002](../decisions/0002-repository-permission-model.md) | すべての画面と、生のファイル・添付の配信が判定関数を通る。権限がないものと存在しないものは同じ 404 を返す |
| [ADR-0010](../decisions/0010-server-side-merge-and-diff.md) | 差分は SHA の組でキャッシュされた RPC の結果を使う |
| [ADR-0013](../decisions/0013-untrusted-content-domain-isolation.md) | 利用者の内容は、アプリとは別の登録可能ドメインから配る。SVG・ノートブックなどは隔離した iframe で描画する |

## 1. 描画の方式

### 1.1 決定：サーバーで React を描画し、画面の単位でハイドレーションする

| 方式 | 評価 |
| --- | --- |
| SPA（クライアントだけで描画） | 公開リポジトリの閲覧は、ログインしていない人と検索エンジンが多い。最初の表示が JavaScript の読み込みと API の往復を待つ。採らない |
| サーバーの描画だけ（MPA） | レビュー、コードの閲覧の操作（ファイルの検索、行の選択、差分の展開）が重くなる。採らない |
| **SSR ＋ 画面の単位のハイドレーション ＋ アプリ内のクライアントの遷移** | 採る |

- Hono の上で React の SSR をストリームで返す（`renderToReadableStream`）。先に画面の骨格と最重要の内容（ファイルの本文、PR の差分の先頭）を送り、残りは Suspense の境界ごとに流す。
- ハイドレーションは画面（ルート）の単位で行う。ただし、差分とコードの表示は、見えている範囲の行だけをハイドレーションし、仮想化する（4.4 節）。本家も、差分で見えている行だけをハイドレーションし、大きな PR（1 万行を超える差分）では TanStack Virtual で仮想化している（[The uphill climb of making diff lines performant](https://github.blog/engineering/architecture-optimization/the-uphill-climb-of-making-diff-lines-performant/)）。
- 最初の読み込みの後の同じアプリの中の遷移（ファイルからファイル、PR のタブの切り替え）は、クライアントのルーター（TanStack Router）で行い、データだけを取る。本家の Issue の画面も、全体の読み込み・Turbo・React の遷移を併用している（[From latency to instant](https://github.blog/engineering/architecture-optimization/from-latency-to-instant-modernizing-github-issues-navigation-performance/)）。
- **JavaScript が動かなくても、公開リポジトリのファイル・README・Issue・PR は読める。** 操作（コメント、マージ）には JavaScript を要する。
- React Server Components は MVP では使わない。Hono との組み合わせの成熟度を見て、後で判断する。
- この決定は [ADR-0035](../decisions/0035-web-rendering-ssr-streaming.md) にした。

### 1.2 構成

```
ブラウザ ─▶ CloudFront ─▶ Web（Hono ＋ React SSR）──▶ API の内部の関数（同じプロセス）
   │                        │                        ├─ Aurora（メタデータ）
   │                        │                        └─ Git ストレージの RPC（tree・blob・diff・blame）
   │                        └─ 描画の Worker（Markdown・構文の色付け。キャッシュ付き）
   └─ iframe ─▶ 利用者の内容のドメイン（描画の隔離・生のファイル・画像のプロキシ）
```

- SSR は API の HTTP を呼び直さず、同じ処理の関数を呼ぶ。ただし権限の判定（ADR-0002）は、HTTP の API と同じ関数を通す。
- 静的なファイル（JS・CSS）は、内容のハッシュを名前に含め、CloudFront から長くキャッシュさせる。
- HTML は CDN でキャッシュしない（MVP）。公開リポジトリの匿名の閲覧を CDN でキャッシュするかは、負荷を見て判断する（12 節）。

## 2. ルート

| パス | 画面 |
| --- | --- |
| `/{owner}/{repo}` | リポジトリの最上位（既定のブランチのツリーと README） |
| `/{owner}/{repo}/tree/{ref}/{path}` | ディレクトリ |
| `/{owner}/{repo}/blob/{ref}/{path}` | ファイル |
| `/{owner}/{repo}/blame/{ref}/{path}` | blame |
| `/{owner}/{repo}/commits/{ref}/{path}` | 履歴 |
| `/{owner}/{repo}/commit/{sha}` | コミット |
| `/{owner}/{repo}/compare/{base}...{head}` | 比較と PR の作成 |
| `/{owner}/{repo}/pull/{number}`、`/files`、`/commits`、`/checks` | PR（[pull-requests.md](pull-requests.md)） |
| `/{owner}/{repo}/issues/{number}` | Issue（[issues.md](issues.md)） |
| `/{owner}/{repo}/raw/{ref}/{path}` | 生のファイルの配信先（5 節）へ転送 |

- **`{ref}` と `{path}` の境目は、存在する ref の最長一致で決める。** ref の名前に `/` を含められるため（`feature/x/y`）。ref の一覧はリポジトリごとにキャッシュする（ref の Event で捨てる）。
- `{ref}` には SHA も書ける。ブランチの URL を、その時点の SHA の URL（パーマリンク）に変える操作を用意する。本家のキーボードの `y` に相当する（[Keyboard shortcuts](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts)）。
- 非公開のリポジトリで権限がない場合、存在しない場合と同じ 404 を返す。ログインしていなければ、404 の画面にログインを案内する（ログインの画面へ自動で転送しない。存在を漏らさないため）。
- 名前の変更・移管の後の古い URL は、転送の表で新しい URL へ 301 で送る。転送の前にも権限を判定する。

## 3. コードの閲覧

### 3.1 ストレージの RPC

| 画面 | RPC | キャッシュのキー |
| --- | --- | --- |
| ツリー | `ListTree(commit, path)`、各項目の最新のコミット（`LastCommitForPaths`） | `(tree_sha)`、`(commit, path)` |
| ファイル | `GetBlob(commit, path, limit)` | `(blob_sha)` |
| blame | `Blame(commit, path, range)` | `(commit, path)` |
| 履歴 | `ListCommits(ref, path, cursor)` | `(commit, path, cursor)` |
| README | `FindReadme(commit, path)` ＋ Markdown の描画 | `(blob_sha)` |

- SHA が決まれば結果が決まるものは、無効化せず追い出すだけにする（ADR-0010 と同じ考え方）。
- 各 RPC は期限を持つ。ツリーの「各項目の最新のコミット」は重いので、画面の表示を待たせず、後から埋める。期限を超えたら空欄のままにする。
- blame は `git blame` に相当し、大きなファイルや長い履歴で重い。期限（例：10 秒）を超えたら「blame を表示できない」を出す。rename の追跡は既定で行う。

### 3.2 ファイルの表示

- 構文の色付けはサーバーで行う。言語の判定は Linguist に相当する規則（拡張子、ファイル名、`.gitattributes` の `linguist-language`）で行い、結果を `(blob_sha, language)` でキャッシュする。
- 本家のコードの表示は、ファイル全体を持つ見えない `textarea` と、見えている行だけを描く色付けの層を重ね、ブラウザの検索とキーボードの操作とスクリーンリーダーを保ちつつ、18,000 行のファイルを 1 秒未満で描画した（[Crafting a better, faster code view](https://github.blog/engineering/architecture-optimization/crafting-a-better-faster-code-view/)）。同じ構成にする。
- 行の選択（`#L10-L20`）、行へのリンクのコピー、ファイルの検索（`t`）、行への移動（`l`）、blame への切り替え（`b`）、ブランチの切り替え（`w`）を持つ（同上の Keyboard shortcuts）。
- シンボルの一覧・定義への移動は、コード検索（[search.md](search.md)）の索引ができてから加える。

### 3.3 大きなファイルと表示の上限

| 条件 | 表示 | 出典 |
| --- | --- | --- |
| 整形した描画（Markdown・CSV など） | 2 MB 未満のファイルだけ試みる。超えたら生のテキストか「表示できない」 | 本家（[Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)） |
| CSV・TSV の表としての描画 | 512 KB まで | 本家（[Working with non-code files](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files)） |
| STL・GeoJSON の描画 | 10 MB まで | 同上 |
| 色付けしたテキストの表示 | 1 MB まで。超えたら「生のファイルを見る」だけ | ここでの決定。本家は表示・色付けの上限を公開していない（2026-09-26 に確認。**未検証**） |
| 1 MB を超え 10 MB 以下のテキスト | 色付けせずに先頭だけを出すか、生のファイルへの案内 | ここでの決定 |
| バイナリ | 画像・PDF など描画できる種類は描画。それ以外は「生のファイルを見る」 | |
| LFS のポインタ | LFS のオブジェクトを取り、上の規則で表示する | [git-protocols.md](git-protocols.md) |
| 履歴の画面のコミットの数 | 10,000 まで | 本家（Repository limits） |

- `GetBlob` に上限を渡し、上限を超えたらストレージの側で打ち切る。大きな blob をアプリ層に運ばない。
- 差分の上限は [pull-requests.md](pull-requests.md) の 3.4 節にある（本家の Repository limits と同じ値）。

## 4. 信頼できない内容の描画

リポジトリのファイル、Issue・PR・コメントの本文は、すべて信頼できない入力とみなす。描画の経路を、内容の種類ごとに 1 つに決め、それ以外で描画しない。

| 内容 | 経路 | 描画するドメイン |
| --- | --- | --- |
| Markdown（ファイル、README、Issue・PR・コメントの本文） | サーバーで GFM → HTML → 許可リストで無害化 → 後処理 | アプリのドメイン（無害化済みの HTML だけ） |
| 画像（PNG・JPEG・GIF・WebP） | `<img>` で利用者の内容のドメインから読む | 利用者の内容のドメイン |
| SVG | `<img>` で読む（スクリプトが動かない）。直接開いたときは CSP の sandbox 付きで配る | 利用者の内容のドメイン |
| ノートブック（`.ipynb`）、Mermaid、GeoJSON、STL、PDF | 描画の隔離のドメインの iframe | 描画の隔離のドメイン |
| 外部の画像（Markdown の中の外部 URL） | 画像のプロキシを通す | 利用者の内容のドメイン |
| 生のファイル | 5 節 | 生のファイルのドメイン |

### 4.1 Markdown（GFM）

本家の描画の流れは、マークアップを HTML に変換し、`script`・インラインの style・`class`・`id` などを除く強い無害化を行い、構文の色付け、絵文字、タスクリスト、見出しのアンカー、画像の CDN、自動リンクなどの後処理をする、というもの（[github/markup](https://github.com/github/markup)）。同じ順にする。

1. **解析**：GFM（表、取り消し線、タスクリスト、自動リンク、脚注、アラート）を解析する。解析器は CommonMark と GFM の仕様のテストを通るものにする。
2. **HTML へ変換**：生の HTML は、解析器では通し、次の無害化で落とす。
3. **無害化**：許可リスト方式。
   - 要素：見出し、段落、リスト、表、`code`・`pre`、`a`、`img`、`details`・`summary`、`kbd`、`sup`・`sub` など、一覧に載ったものだけ。
   - 属性：`href`・`src`（スキームは `http`・`https`・`mailto` と相対 URL だけ）、`alt`、`title`、`align` など、要素ごとの一覧に載ったものだけ。`on*`・`style`・`class`・`id` は落とす。
   - `id` と `name` が要る見出しのアンカーは、`user-content-` の接頭辞を付けて後処理で付ける。本家と同じく、アプリの要素の ID と衝突させない（DOM clobbering の対策。本家の Markdown の API は `id="user-content-…"` を返し、`id` を除いてから名前付きのアンカーを後で付ける。[Markdown の REST API](https://docs.github.com/en/rest/markdown/markdown) の応答で 2026-09-26 に観測、[github/markup](https://github.com/github/markup) の README）。
4. **後処理**：
   - `@メンション`、`#123`・`owner/repo#123` の参照、コミットの SHA をリンクにする。**参照先のタイトルや状態は、閲覧者の権限で判定してから出す。** 非公開のリポジトリの Issue への参照は、読めない人には番号の文字列のままにする（ADR-0002）。
   - 外部の画像の `src` を、画像のプロキシの URL に書き換える（4.4 節）。
   - コードのブロックを色付けする。`mermaid`・`geojson`・`stl`・`math` のブロックは、描画の隔離の iframe の置き場所にする。
   - 相対リンク・相対の画像を、リポジトリの ref とパスで解決する。
5. **キャッシュ**：閲覧者に依らない部分（1〜4 の参照の解決を除く）を、`(内容のハッシュ, 文脈のリポジトリ, 描画器の版)` でキャッシュする。参照の解決は、閲覧者ごとに要求の時点で行う。

- 無害化は、描画の Worker の 1 か所で行う。無害化された HTML は、型（`SanitizedHtml`）で区別し、`dangerouslySetInnerHTML` にはこの型だけを渡せるようにする（lint で禁止し、例外はこの 1 か所）。
- 数式（`$...$`）は、MVP ではサーバーで MathML に変換してから無害化を通す（MathML の要素を許可リストに入れる）。本家は MathJax（ブラウザの JavaScript）で描く（[Writing mathematical expressions](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions)、2026-09-26 に確認）。ここはアプリの origin で利用者の内容から JavaScript を動かさないために、サーバーで変換する（**本家との違い**。12 節の決定）。

### 4.2 SVG

- ファイルの画面では、SVG を `<img src="利用者の内容のドメインの URL">` で表示する。`<img>` の中の SVG は、スクリプトを実行せず、外部の資源も読まない。本家も SVG のインラインのスクリプトとアニメーションを扱わない（[Working with non-code files](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files)）。
- SVG を直接開いた場合に備え、配信の応答に `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` を付ける。
- SVG をアプリのドメインのインラインの DOM に入れない。

### 4.3 ノートブックとその他の描画

- ノートブックは、本家と同じく静的な HTML として描画し、対話的な機能（独自の JavaScript のグラフなど）は動かさない（同上）。
- 変換は、描画の隔離のサービスで行う。ノートブックの出力に含まれる HTML は、4.1 節と同じ許可リストで無害化する。変換の期限は 5 秒とする（本家は 5 秒で描画を諦めると言われる。[Jupyter の blog](https://blog.jupyter.org/rendering-notebooks-on-github-f7ac8736d686)。本家の文書に期限の記述はない。2026-09-26 に確認。**未検証**。本システムの値とする）。
- 描画の結果は、**描画の隔離のドメイン**の iframe で表示する。
  - iframe に `sandbox="allow-scripts"` を付け、`allow-same-origin` は付けない。中身は不透明なオリジンになり、Cookie・storage・親の DOM に触れない。
  - 描画の隔離のドメインの応答には、CSP の `frame-ancestors` でアプリのドメインだけを許す。
  - 高さの調整などの親とのやり取りは `postMessage` で行い、親は `origin` と、決めた形のメッセージだけを受け付ける。
- 非公開のリポジトリのノートブックは、アプリが権限を判定したうえで、短命の署名付きの URL（5.2 節）で iframe に渡す。
- Mermaid、GeoJSON、STL、PDF も同じ iframe の仕組みで描く。本家は GeoJSON の地図や 3D の表示を持つ（同上）。本家の文書は STL・GeoJSON を 10 MB を超えると描かないとするが、描く iframe のドメインは書いていない（[Working with non-code files](https://docs.github.com/en/repositories/working-with-files/using-files/working-with-non-code-files)、2026-09-26 に確認。**未検証**）。本システムは 10 MB の上限を本家に合わせる。

### 4.4 画像のプロキシ

- Markdown の中の外部の画像は、画像のプロキシの URL（HMAC で署名した元の URL）に書き換える。本家は Camo でこれを行い、閲覧者のブラウザの情報を画像の置き主から隠す（[About anonymized URLs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-anonymized-urls)）。
- プロキシは利用者の内容のドメインで動かし、VPC の内部へ届かない隔離した取得器で取る（Slack の [ADR-0016](../../../slack/docs/decisions/0016-isolated-link-unfurling.md) と同じ SSRF の対策）。画像の種類と大きさ（例：10 MB）を検査し、画像以外は返さない。
- HTTPS のページに HTTP の画像が混ざることも防げる。

## 5. 生のファイルと利用者の内容のドメイン（ADR-0013）

### 5.1 ドメインの分け方

| ドメイン（名前は [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) の置き換え用の名前） | 配るもの | Cookie |
| --- | --- | --- |
| `<brand>.<domain>` | アプリ、API | セッション（`__Host-` の接頭辞、`Secure`、`HttpOnly`、`SameSite=Lax`） |
| `raw.<brand>usercontent.<domain>` | 生のファイル | 受け取らない |
| `media.<brand>usercontent.<domain>` | Issue・PR の添付、アバター、LFS の画像 | 受け取らない |
| `camo.<brand>usercontent.<domain>` | 外部の画像のプロキシ | 受け取らない |
| `render.<brand>usercontent.<domain>` | ノートブック・Mermaid などの描画の iframe | 受け取らない |

- **利用者の内容のドメインは、アプリとは別の登録可能ドメインにする。** サブドメインにすると、同じサイト（same-site）になり、`SameSite` の Cookie が送られ、Cookie の注入（`Domain=` の上書き）もできる。本家は利用者の内容を `*.githubusercontent.com` から配り、「ドメインの分離そのものが統制である」としている（[GitHub Bug Bounty: *.githubusercontent.com](https://bounty.github.com/targets/githubusercontent-com.html)）。
- 利用者の内容のドメインを Public Suffix List に登録し、サブドメインどうしも別のサイトにする。本家も `githubusercontent.com`・`github.io` などを Public Suffix List に登録している（[public_suffix_list.dat](https://publicsuffix.org/list/public_suffix_list.dat)、2026-09-26 に確認）。
- アプリのドメインの CSP では、利用者の内容のドメインから スクリプトを読まない（6 節）。

### 5.2 生のファイルの配信

- 応答の `Content-Type` は、画像（SVG を含む）とテキスト以外を `application/octet-stream`、テキストを `text/plain; charset=utf-8` にする。HTML・JavaScript を HTML・JavaScript として返さない。
- すべての応答に次を付ける。
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
  - `Cross-Origin-Resource-Policy: cross-origin`（公開のファイル）か `same-site`（非公開）
  - `Referrer-Policy: no-referrer`
- 公開のリポジトリは、`(repo, commit, path)` で CDN にキャッシュする。ブランチの URL は短い TTL（例：5 分）、SHA の URL は長い TTL にする。
- **非公開のリポジトリは、短命の署名付きの URL で配る。**
  - アプリで権限を判定した後、`(user, repo, path, ref, 期限)` を署名したトークンを URL に付けて転送する。期限は 5 分程度。トークンは他のパス・リポジトリに使えない。
  - 利用者の内容のドメインは Cookie を受け取らないので、Cookie では認証しない。
  - `git` の HTTP のトークン（個人用アクセストークン）による `Authorization` ヘッダーでの取得も受け付ける（CLI・CI のため）。
  - 権限を失った後の最大の露出は、トークンの期限まで。これを受け入れる。
  - CDN にキャッシュしない。
- 本家の生のファイルは `Content-Type: text/plain; charset=utf-8`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` で返る（2026-09-26 に応答のヘッダーで観測）。非公開のリポジトリの生のファイルのトークンの形は公開されていない（**未検証**。本システムの形で作る）。

## 6. CSP とブラウザの防御

アプリのドメインの CSP：

```
default-src 'none';
script-src 'nonce-{random}' 'strict-dynamic';
style-src 'self';
img-src 'self' data: https://camo.<brand>usercontent.<domain> https://media.<brand>usercontent.<domain> https://raw.<brand>usercontent.<domain>;
media-src https://media.<brand>usercontent.<domain>;
font-src 'self';
connect-src 'self' https://media.<brand>usercontent.<domain>;
frame-src https://render.<brand>usercontent.<domain>;
frame-ancestors 'none';
form-action 'self';
base-uri 'none';
object-src 'none';
require-trusted-types-for 'script';
upgrade-insecure-requests;
```

- 静的なファイルは CloudFront の同じオリジンから配るので `'self'` で足りる。スクリプトは SSR が発行する nonce で許す。
- `img-src` に任意の外部のホストを許さない。外部の画像はすべてプロキシを通る（4.4 節）。
- Trusted Types を強制し、DOM の HTML の差し込みは `SanitizedHtml` を作る 1 つのポリシーだけにする。
- 新しい規則は、まず `Content-Security-Policy-Report-Only` で入れて違反を集め、問題がなければ強制にする。本家も CSP を段階的に強めてきた（[GitHub's CSP journey](https://github.blog/engineering/platform-security/githubs-csp-journey/)、[GitHub's post-CSP journey](https://github.blog/engineering/platform-security/githubs-post-csp-journey/)）。
- その他：HSTS（`includeSubDomains; preload`）、`Cross-Origin-Opener-Policy: same-origin`、CSRF は `SameSite=Lax` と、状態を変える要求の CSRF トークンか `Origin` の検査。

## 7. 性能の予算

| 指標 | 目標（S1、p75 は実利用者の計測、p95 はサーバー） |
| --- | --- |
| PR の画面（差分 1,000 行まで） | p95 1.5 秒以内（NFR-004。内訳は [pull-requests.md](pull-requests.md) の 12 節） |
| ファイル・ツリーの画面の最重要の内容の表示（HPC） | p75 1 秒以内。クライアントの遷移では p75 200 ms 以内 |
| LCP | p75 2.5 秒以内 |
| INP | p75 200 ms 以内。差分 20,000 行の PR でも 200 ms 以内 |
| CLS | p75 0.1 以内 |
| 最初の読み込みの JavaScript（gzip 後） | 共通 150 KB 以内、画面ごとの追加 100 KB 以内。CI で超過を失敗にする |
| サーバーの SSR（ストリームの開始まで） | p95 300 ms 以内 |

- HPC（Highest Priority Content）は、本家が画面の主な内容の表示までを測るために使う指標で、200 ms 未満を「即時」、1 秒未満を「速い」とする（[From latency to instant](https://github.blog/engineering/architecture-optimization/from-latency-to-instant-modernizing-github-issues-navigation-performance/)）。同じ区分で、画面ごとに計測する。
- 計測は、実利用者の計測（RUM）とサーバーのトレースの両方で行う（[observability.md](observability.md)）。
- 仮想化の閾値：コードの表示は 500 行、差分は 1 画面 2,000 行を超えたら仮想化する。本家は 500 行で遅くなり始め、2,000 行で目立ったとしている（[Crafting a better, faster code view](https://github.blog/engineering/architecture-optimization/crafting-a-better-faster-code-view/)）。

## 8. アクセシビリティ

- 目標は WCAG 2.2 の AA。
- コードの表示では、見えない `textarea` にファイル全体を置き、スクリーンリーダー・ブラウザの検索・キーボードでの選択を、仮想化と両立させる（3.2 節）。
- 差分は表（`table`）の意味を持たせ、行番号・旧新・変更の種類を読み上げられるようにする。色だけで追加・削除を表さない（`+`・`-` の記号を併記する）。
- 1 文字のキーボードのショートカットは、設定で無効にできるようにする（WCAG 2.1.4）。本家も、修飾キーを使わないショートカットを無効にできる（[Keyboard shortcuts](https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts)）。
- ライト・ダーク・高コントラストのテーマを持ち、`prefers-color-scheme` と `prefers-reduced-motion` に従う。
- CI で axe による検査を行い、主要な画面は四半期ごとに支援技術で手動の確認をする。

## 9. 多言語化

- **MVP の画面は英語と日本語にする**（2026-09-26 の決定）。言語は、利用者の設定があればそれを、なければ `Accept-Language` で選び、どちらにも当たらなければ英語にする。ログインしていない閲覧も `Accept-Language` で選ぶ。SSR の HTML は言語ごとに変わるので、応答に `Vary: Accept-Language` と `Content-Language` を付ける。
- 開発者向けの用語（Pull Request、merge、rebase、fork、commit）は、日本語の画面でも訳さない（ドキュメント・エラー・CLI との対応を保つ）。本家の画面は英語だけ（2026-09 時点の観測）なので、ここは本家との違い。
- 文言はカタログ（ICU MessageFormat）に分け、コードに直書きしない。訳の抜けは CI で検査する（英語にだけある文言を失敗にする）。
- API のエラーの `message` と、Git の `remote:` の行は英語だけにする（機械とログで読まれるため）。メールの通知は、利用者の設定の言語にする。
- 日時は、SSR では UTC の絶対時刻を `<time datetime>` に入れ、クライアントで利用者のタイムゾーンと相対時刻（「3 時間前」）に直す。
- 利用者の内容（コード、Markdown）は、UTF-8 以外の文字コードを判定して表示する。右から左の文字（RTL）と、Trojan Source の類の双方向の制御文字は、コードの表示で警告し、見えるようにする。

## 10. 認証の画面との境目

- ログイン、二要素認証、トークンの発行、OAuth の同意の画面は [identity-and-permissions.md](identity-and-permissions.md) にある。
- 危険な操作（リポジトリの削除、公開の種類の変更、ruleset の削除）は、再認証（sudo モードに相当）を求める。

## 11. 出す Event と記録

- Web は独自の Event を出さない。操作は API の内部の関数を通り、そこで outbox に書く。
- 描画の失敗（無害化の例外、iframe の描画の期限切れ）、CSP の違反の報告を記録し、監視する（[observability.md](observability.md)）。

## 12. 未解決の問い

設計の中で出た問いと、その決定。計測・PoC で決めるものは「持ち越し」に置く。

### 決定（2026-09-26、既定案）

- 1.1 節の描画の方式は [ADR-0035](../decisions/0035-web-rendering-ssr-streaming.md) にした。
- 画面の言語は英語と日本語（9 節）。
- 利用者の内容のドメインの名前は、開発リポジトリの作成時に決める（ADR-0006）。Public Suffix List への登録は、一般公開の前（E9 の `usercontent-domains-psl`）に申請する。登録の反映はブラウザの更新に依るので、登録を待たずにドメインの分離（別の登録可能ドメイン）だけで安全が成り立つ設計にしてある（5.1 節）。
- 数式は、4.1 節のとおりサーバーで MathML に変換してから無害化する。隔離の iframe は使わない。
- **数式**：本家は MathJax（ブラウザの JavaScript）で描くが、本システムは上のとおりサーバーで MathML に変換する（2026-09-26 に確認した本家との違い）。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 公開リポジトリの匿名の閲覧の HTML を CDN でキャッシュするか（1.2 節） | 既定はキャッシュしない。E9 の負荷試験で、匿名の閲覧が Web の負荷の大半を占めるなら、非公開への変更時の無効化とあわせて ADR を起票する |

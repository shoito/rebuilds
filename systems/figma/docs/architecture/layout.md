# Layout: Figma

フレームの中の子の位置と大きさを決める設計。制約（constraints）、オートレイアウト（折り返しと最小・最大を含む）、テキストの折り返しと大きさ、グループの境界、増分の再計算、クライアントとサーバーで結果を一致させる規則を扱う。

| 関連 | 決定 |
| --- | --- |
| [ADR-0019](../decisions/0019-auto-layout-engine-and-layout-persistence.md) | オートレイアウトは自前の flexbox に近い計算で、Taffy を差分のテストの参照にする。結果は `derived_layout` に保存するが、画面はいつも手元で計算した結果を出し、食い違いは決まった 1 人が直す。制約は、親の大きさを利用者が変えたときに当てる |
| [ADR-0020](../decisions/0020-deterministic-layout-arithmetic.md) | レイアウトとテキストの測定は、f64 の四則と min・max だけで計算し、順序を固定する。標準の超越関数、FMA、並列を使わない。結果を変えるアルゴリズムの変更は ADR を要する |
| [ADR-0015](../decisions/0015-text-shaping-and-glyph-rendering.md) | 整形は HarfRust・Skrifa・ICU4X |
| [ADR-0002](../decisions/0002-central-authoritative-multiplayer.md) | プロパティ単位の LWW。サーバーの `seq` の順に全員が当てる |

プロパティの表と `derived_layout` は [document-model.md](document-model.md) の 4 節と 9.2 節、インスタンスの導出は [components-and-libraries.md](components-and-libraries.md) の 3.3 節、描画への受け渡しは [rendering-engine.md](rendering-engine.md) の 4 節、リサイズの操作は [editor-and-tools.md](editor-and-tools.md) の 5 節にある。

## 1. 目的と範囲

- 目的：デザイナーが、フレームとオートレイアウトで画面を組める。同じファイルを開いた全員の画面と、サーバーの書き出しで、位置と大きさが同じになる（intent の「全員の画面は同じ状態に収束する」）。自分の編集は 1 フレームで画面に出る（NFR-002）。
- 範囲：`layout` の crate。入力のプロパティから、各ノードの `derived_layout { transform, size }` を計算する。テキストの行の組み立て（改行、行の高さ）。グループとブール演算の境界。
- 範囲の外：テキストの整形とグリフ（[rendering-engine.md](rendering-engine.md) の 9 節）、リサイズの手の操作と制約の UI（[editor-and-tools.md](editor-and-tools.md)）、インスタンスの導出（components）。グリッドのオートレイアウト、レイアウトグリッドの吸着、テキストの切り詰め（最大の行の数）は MVP の後。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 項目 | 本家 | 本システム |
| --- | --- | --- |
| 向き | 縦・横・グリッド。縦と横に折り返し（wrap）がある（[Guide to auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout)） | 縦・横。折り返しは横だけ（MVP）。グリッドは MVP の後 |
| 間隔 | 余白（padding）、間隔（gap）。自動の間隔に「Between」「Around」「Evenly」（同上） | 固定の間隔と「Between」。「Around」「Evenly」は MVP の後 |
| 大きさ | hug（子に合わせる）、fill（残りを埋める）、fixed。最小・最大の幅と高さ（同上） | 同じ |
| その他 | 「オートレイアウトを無視」（絶対配置）、ベースラインで揃える（同上） | 同じ |
| 負の間隔、線を大きさに含めるか、重なりの順（前の子を上に） | この資料には記述なし（未検証） | 持つ（3 節）。本家の振る舞いとの一致は E5 で確かめる |
| 制約 | 親のフレームの大きさを変えたときの子の動き（左・右・左右・中央・拡大縮小） | 同じ（8 節） |
| 計算の場所と保存 | 公開されていない（未検証） | 4 節 |

## 3. 入力と出力

### 3.1 入力のプロパティ

持ち主は layout。名前と番号は [document-model.md](document-model.md) の 4.2 節（18〜39）に登録した。★は、この文書が足したもの（統合の工程で登録済み）。

| プロパティ | 持つノード | 値 |
| --- | --- | --- |
| `layout_mode` | フレーム・コンポーネント | `none`・`horizontal`・`vertical` |
| `layout_wrap` ★ | 同上 | `no_wrap`・`wrap`（`horizontal` のときだけ有効） |
| `item_spacing` | 同上 | f32。負も可（-10,000〜10,000） |
| `counter_axis_spacing` ★ | 同上 | f32。折り返したときの行の間隔（0〜10,000） |
| `padding_top`・`padding_right`・`padding_bottom`・`padding_left` | 同上 | f32（0〜10,000）。四辺を別の競合の単位にする |
| `primary_axis_align` | 同上 | `min`・`center`・`max`・`space_between` |
| `counter_axis_align` | 同上 | `min`・`center`・`max`・`baseline`（`baseline` は `horizontal` だけ） |
| `counter_axis_align_content` ★ | 同上 | `auto`・`space_between`（折り返したときの行の並べ方） |
| `primary_sizing`・`counter_sizing` | 同上 | `fixed`・`hug` |
| `strokes_included_in_layout` ★ | 同上 | bool（既定 false） |
| `item_reverse_z_index` ★ | 同上 | bool（既定 false。true なら前の子を上に描く） |
| `layout_grow` | オートレイアウトの子 | 0・1（1 なら主軸で fill） |
| `layout_align` | 同上 | `inherit`・`stretch`（`stretch` なら交差軸で fill） |
| `layout_positioning` | 同上 | `auto`・`absolute`（オートレイアウトを無視） |
| `min_width`・`max_width`・`min_height`・`max_height` ★ | レイヤー | `Option<f32>`（0〜1,000,000）。それぞれ別の競合の単位 |
| `constraints` | レイヤー | `{ h, v }`。`min`・`max`・`stretch`・`center`・`scale` |
| `text_auto_resize` | テキスト | `width_and_height`・`height`・`none` |
| `transform`・`size` | レイヤー | 利用者が置いた位置と大きさ（オートレイアウトの子では、計算の結果が優先する） |

### 3.2 出力

- `derived_layout { transform: Affine2x3, size: Vec2 }`（f32。document-model のプロパティ 80）。オートレイアウトの子、hug・fill のフレーム、テキスト、グループ、ブール演算について計算する。
- 描画・ヒットテスト・選択の枠は、ノードの実際の位置と大きさとして `LayoutResult`（`NodeId` → `{ transform, size, baseline }`）を読む（[rendering-engine.md](rendering-engine.md) の 4.1 節）。`derived_layout` を持たないノードは、`transform`・`size` をそのまま使う。
- テキストは、行の組み立ての結果（行ごとのグリフの列と位置）を `TextLayout` として描画に渡す。これは保存しない。

## 4. 結果の保存と収束

[ADR-0019](../decisions/0019-auto-layout-engine-and-layout-persistence.md) で決めた。[document-model.md](document-model.md) の 9.2 節の既定案（入力を変えた本人が計算して `derived_layout` を書く）を引き継ぎ、同時の編集での収束の規則を足す。

### 4.1 書く人と読む人

| 場面 | 振る舞い |
| --- | --- |
| 入力を変えた | 編集した本人のクライアントが、影響する範囲を計算し直し、値が変わったノードの `derived_layout` の `Set` を同じ `ChangeSet` に入れる |
| 画面に出す | どのクライアントも、`DocView`（確定＋未確定の自分の変更。[multiplayer.md](multiplayer.md) の 7 節）から手元で計算した結果を出す。保存された `derived_layout` は画面に使わない（例外は 6.4 節） |
| ファイルを開いた直後 | 最初の描画は、保存された `derived_layout` を使う（計算を待たない。NFR-003）。アイドルの時間に手元で計算し、差があれば入れ替える |
| Render Worker・書き出し | 保存された `derived_layout` を使う（[export-and-assets.md](export-and-assets.md) の 5.2 節）。インスタンスの中の導出したノードは保存されないので、Worker が同じコードで計算する |
| Document Server | 計算しない。`derived_layout` の値の型と範囲だけを検証する |

### 4.2 食い違いの修復

同時の編集（A が余白を変え、B が子を足した）では、確定した入力と、保存された `derived_layout` が食い違いうる。画面は手元の計算なので全員正しく見えるが、保存された値（Worker と、フォントのない人が読む）は古いまま残る。これを次の規則で直す。

1. クライアントは、他の人の `Committed` を当てた後、影響したノードについて、手元の計算の結果と、確定した `derived_layout` をビットで比べる。
2. 違うノードがあれば、**修復の担当**だけが、500ms のあいだそのノードに新しい変更が来ないのを待って、正しい値の `Set` を送る。
3. 修復の担当は、編集の権限を持ち、今つながっているセッションのうち、`session_id` が最も小さいもの（在席の一覧で全員が同じ人を選べる。[multiplayer.md](multiplayer.md) の 12.1 節）。
4. 次のノードは修復しない：測定が「仮」のテキスト（6.4 節）を含む部分木、その人の端末のフォントを使うテキストを含む部分木。
5. 同じノードの修復は、1 セッションで 10 秒に 1 回まで。修復した後にまた食い違ったら、`layout_divergence`（ノードの ID と件数だけ）を記録し、修復をやめる。決定性の不具合（6 節）の兆候として調べる。

- 担当が 2 人になっても（在席の一覧の食い違い）、計算は決定的なので同じ値を書く。LWW で問題は起きない。
- 修復の `Set` は、`origin = LayoutRepair`（[document-model.md](document-model.md) の 7 節）を付け、Undo の項目に入れない。
- 閲覧だけの人は書かない。編集者が誰もいないあいだの食い違いは、次に編集者が開いたときに直る。
- Undo は入力だけを戻す。Undo の `ChangeSet` には、戻した入力から計算し直した `derived_layout` を入れる（記録した前の `derived_layout` を戻さない）。[multiplayer.md](multiplayer.md) の 10 節の項目の作り方は `derived` のプロパティを除く（ADR-0012 の注記）。

## 5. テキストの折り返しと大きさ

### 5.1 大きさの方式

| `text_auto_resize` | 幅 | 高さ |
| --- | --- | --- |
| `width_and_height` | 最も長い行の幅（改行文字でだけ行を分ける） | 行の高さの和 |
| `height` | 固定（`size.x`、または fill で親から決まる） | 折り返した行の高さの和 |
| `none` | 固定 | 固定（はみ出した行も描く） |

- オートレイアウトの子のテキストが主軸で fill なら、幅は親から決まり、`height` と同じく折り返す。
- テキストの測定は、`measure(node, available_width: Option<f64>) -> (width, height, first_baseline)` の 1 つの関数にする。オートレイアウトの計算（7 節）はこの関数だけを呼ぶ。

### 5.2 行の組み立て

1. `text_content`（文字と書式の範囲）を、書式・フォント・文字種・双方向の走りに分け、整形する（[rendering-engine.md](rendering-engine.md) の 9 節）。
2. 改行の候補は ICU4X の `LineSegmenter`（UAX #14）で求める。強さは `Strict`（ICU4X の既定。日本語の行頭の小書きの仮名などで分けない）、`word_option` は `Normal`。
3. 先頭から、行に収まる限り候補まで詰める（貪欲法）。行末の空白は幅に数えない（ぶら下げ）。
4. 1 語が幅に収まらなければ、書記素の境で分ける（CSS の `overflow-wrap: anywhere` と同じ）。
5. 字間（`letter_spacing`）は書記素ごとに足す。行末の書記素の後にも足す（本家との一致は **未検証**）。
6. 行の高さ：`auto` は、その行の最初のフォントの `ascender − descender + line_gap`（`OS/2` の `USE_TYPO_METRICS` が立っていれば typo の値、なければ `hhea`）。フォールバックのフォントの値は使わない（和文が混じっても行の高さが跳ねないように）。px と % の指定はそのまま。
7. ベースラインの位置は、行の高さの中で、`ascender` と `descender` の比で上下を割り振る。

- 約物の詰め（`palt`）、ぶら下げ組み、両端揃えの和文の字間の調整は MVP で扱わない。

### 5.3 測定のキャッシュ

- `(ノード, text_content と書式のハッシュ, available_width)` をキーに、測定の結果を 4 つまで持つ。オートレイアウトは、同じテキストを違う幅で何度か測るため。
- 1 文字の入力では、その段落だけを整形し直す。段落の区切りは改行文字。

## 6. 決定性

[ADR-0020](../decisions/0020-deterministic-layout-arithmetic.md) で決めた。レイアウトの結果は、WASM（各ブラウザ）とネイティブ（Render Worker）でビットまで一致しなければならない。4.2 節の修復は、この一致を前提にする。

### 6.1 算術

- 計算の中は f64。入力の f32 を f64 に広げ（誤差なし）、出力で f32 に丸める（最近接の偶数。どこでも同じ）。
- 使う演算は、`+`・`-`・`*`・`/`・`min`・`max`・`abs`・比較だけ。IEEE 754 はこれらの結果を一意に決める。
- 使わないもの：
  - 標準の `f64::sin`・`cos`・`powf` など。ターゲットごとに別の実装（Linux なら glibc）が計算し、結果がずれうる（WASM とネイティブで実際にずれるかは **未検証**。E2 の CI で確かめる）。回転した子の境界の箱は、行列の成分の絶対値の和で求め、三角関数を要らない形にする。どうしても要るときは、純 Rust の `libm` の crate を明示して呼ぶ。
  - `mul_add`（FMA）と、relaxed SIMD。
  - 並列の計算（足す順が変わる）。
- NaN と無限は入力の検証で入らない（document-model の 4.3 節）。0 での割り算は、割る前に数を確かめる。

### 6.2 順序

- 子はいつも `OrderKey` の順（`DocView` の `children`）。和は左から右へ足す。
- `HashMap` の走査の順に結果を依存させない。ノードの集合は `NodeId` の順に並べてから処理する。
- 増分の計算（9 節）と一からの計算で、同じ式を同じ順で当てる。

### 6.3 版

- 整形の部品（HarfRust、Skrifa、ICU4X のデータ）の版を固定する。上げるときは、参照ファイルのレイアウトの結果が変わらないことを CI で確かめる。変わるなら、ADR を書く（ADR-0020）。
- レイアウトの計算の規則を変えて、既存のファイルの結果が変わる変更はしない。新しい振る舞いは、新しいプロパティの値として足す（例：`primary_axis_align` に `space_around` を足す）。
- クライアントとサーバーの版の食い違いは、接続時の版の照合（[ADR-0053](../decisions/0053-client-server-version-skew.md)）で防ぐ。レイアウトの結果を変える規則の変更は、文書のフラグ（`release.doc.*`。[ADR-0055](../decisions/0055-staged-rollout-and-schema-changes.md)）でファイルごとに切り替え、同じファイルを開いた全員とサーバーが同じ規則で計算する（[delivery.md](delivery.md) の 6.3 節）。

### 6.4 フォントがないとき

- フォントがまだ読み込めていないテキスト、見つからないフォント（[export-and-assets.md](export-and-assets.md) の 7.5 節）を使うテキストは、測定を「仮」にする。
- 「仮」の測定は、確定した `derived_layout` の `size` と、保存されたベースライン（なければ高さの 0.8 倍）を返す。祖先のオートレイアウトは、この値で計算するので、他の人と同じ結果になる。
- 利用者が「仮」のテキストを編集したら、代わりのフォントで測り、その値を書く（export-and-assets の 7.5 節と同じ）。
- 端末のフォントを使うテキストは、その人の画面では端末のフォントで測る。そのテキストを含む部分木は修復しない（4.2 節）。

## 7. オートレイアウトの計算

CSS の flexbox に近いが、本家のデザインツールの意味に合わせて次を変える：縮み（`flex-shrink`）はない、負の間隔を許す、線の太さを大きさに含められる、`space_between` で子が 1 つなら先頭に置く。

### 7.1 手順（1 つのフレーム）

主軸（`horizontal` なら x）を main、交差軸を cross と書く。流れに入る子（`layout_positioning = auto` で表示中）だけを扱う。

1. **子の仮の主軸の大きさ**：
   - fixed：`size.main`
   - hug（子がオートレイアウトのフレームで `primary_sizing` か `counter_sizing` が hug）・テキスト：`measure`（5.1 節）で、主軸を決めずに測る
   - fill（`layout_grow = 1`）：0。折り返すときは、行分けのために `min_*` か、hug として測った大きさを使う
   - 回転した子は、回転した箱の境界の箱で測る（6.1 節）
   - `strokes_included_in_layout` なら、外側・中央の線の太さを足す
   - `min_*`・`max_*` で挟む
2. **行に分ける**：`no_wrap` は 1 行。`wrap` は、先頭から `Σ仮の大きさ + 間隔 × (個数 − 1) ≤ 内側の主軸` の限り同じ行に入れる（比較は f64 のまま。許容の幅を足さない）。1 行に少なくとも 1 つ。
3. **fill を配る（行ごと）**：`空き = 内側の主軸 − Σ(fill 以外) − 間隔 × (個数 − 1)`。空きを fill の子で等分し、`min_*`・`max_*` に当たった子を固定して、残りで配り直す（CSS の「柔軟な長さの解決」の凍結の繰り返し。繰り返しは fill の子の数まで）。空きが負なら、fill の子は `min_*`（なければ 0）になる。fill 以外は縮めない（はみ出す）。
4. **主軸の位置**：fill の子がいれば、詰めて並べる。いなければ `primary_axis_align` で、`min` は先頭、`center` は空きの半分、`max` は空きの全部をずらす。`space_between` は子が 2 つ以上なら `間隔 = 空き / (個数 − 1)`（負にしない）、1 つなら先頭。
5. **交差軸の大きさ**：fixed はそのまま、hug は測った値、fill（`layout_align = stretch`）は行の交差軸の大きさ。`min_*`・`max_*` で挟む。
6. **行の交差軸の大きさ**：1 行なら、フレームの交差軸が fixed のとき内側の交差軸、hug のとき fill 以外の子の交差軸の最大。折り返すときは、行ごとに fill 以外の子の最大。
7. **交差軸の位置**：`min`・`center`・`max` は行の中で揃える。`baseline` は、各子の最初のベースライン（テキストは 5.2 節、フレームは最初のテキストの子孫、なければ下端）を揃える。
8. **行の並び**（折り返すとき）：`counter_axis_align_content = auto` なら `counter_axis_spacing` で詰めて並べる。`space_between` なら、空きを行の間に等分する。
9. **フレーム自身の大きさ**（hug のとき）：主軸は `余白 + Σ子 + 間隔`（折り返すときは hug を使えない。UI で fixed か fill にする）、交差軸は `余白 + Σ行 + counter_axis_spacing × (行数 − 1)`。自分の `min_*`・`max_*` で挟む。
10. **挟まれたら 2 回目**：hug の大きさが `max_*` で挟まれたら、その大きさを決まったものとして 3〜8 を 1 回だけやり直す。

- `layout_positioning = absolute` の子は流れに入らない。自分の `transform` をそのまま使う（8 節の制約は、利用者が親の大きさを変えたときだけ当てる）。
- 重なりの順：既定は後の子が上。`item_reverse_z_index` なら前の子が上（描く順を逆にする。子の並びは変えない）。

### 7.2 入れ子と測定

- hug のフレームを測るときは、その子を再帰的に測る。同じノードを違う条件で何度も測ると計算が指数的に増えるので、`(ノード, 主軸の条件, 交差軸の条件)` を鍵に、測定の結果を 4 つまでキャッシュする（Taffy のキャッシュと同じ考え方）。
- 入れ子の深さは document-model の上限（256）まで。再帰でなく明示のスタックで辿る。

### 7.3 Taffy との差分のテスト

- 負の間隔・`space_between` の子 1 つ・線の太さ・ベースラインを除いた範囲は、CSS の flexbox の `flex: 1 1 0` などに写せる。この範囲で、任意の木を Taffy（0.14 系を固定）でも計算し、結果の差が 1/1024 px 以内であることを性質ベーステストで確かめる（13 節）。
- 違いが出たら、どちらが本家に近いかを確かめ、仕様をこの文書に書き足す。

## 8. 制約とグループ

### 8.1 制約

- 制約は、利用者が親のフレームの大きさを変えたとき（リサイズの操作、数値の入力、制約のある子を持つフレームへの fill の変化を除く）に、**その操作をしたクライアントが**子の `transform`・`size` を計算し、同じ `ChangeSet` で書く。`derived_layout` ではなく、ふつうの入力を書き換える。
- 親の幅が `W0` から `W1` へ、`Δ = W1 − W0` 変わったとき（縦も同じ）：

| 制約 | 子の x | 子の幅 |
| --- | --- | --- |
| `min`（左） | 変えない | 変えない |
| `max`（右） | `x + Δ` | 変えない |
| `stretch`（左右） | 変えない | `w + Δ` |
| `center` | `x + Δ / 2` | 変えない |
| `scale` | `x × W1 / W0` | `w × W1 / W0` |

- 回転した子は、境界の箱に当てて、中心の移動と大きさの比に直す。テキストの `scale` は枠だけを変え、文字の大きさは変えない。
- 子がフレームで、大きさが変わったら、その子の子にも再帰的に当てる。オートレイアウトのフレームの大きさが変わったら、中は 7 節で計算し直す。
- グループの子の制約は、グループではなく、最も近い祖先のフレームに対して当てる。
- 同時の編集：A が親の大きさを変え、B が同じ子を動かすと、子の `transform` は LWW で片方が勝つ。まれとみなす（ADR-0002 と同じ扱い）。

### 8.2 グループとブール演算

- `GROUP` と `BOOLEAN_OPERATION` の `derived_layout` は、子の境界の箱の和（ブール演算は演算の結果の境界の箱。[editor-and-tools.md](editor-and-tools.md) の 8 節）。子を動かすと、グループの境界も変わる。
- グループを動かす・大きさを変える操作は、子の `transform`・`size` を書き換える変更になる（グループ自身は位置の入力を持たない）。

## 9. 増分の再計算

- 変更を受けたら、レイアウトに関わるプロパティ（3.1 節、テキストの中身と書式、子の追加・削除・並べ替え、表示・非表示）が変わったノードに「自分が汚れた」を付ける。
- 上へ伝える：汚れたノードの大きさが親の計算に効くなら（親がオートレイアウト、グループ、ブール演算）、親も汚れにする。親の大きさが子に依存するあいだ（hug、グループ）は、さらに上へ伝える。両軸が fixed のフレームで止まる（そのフレームの中は計算し直すが、外へは伝えない）。
- 下へ伝える：フレームの大きさが変わったら、fill の子と、オートレイアウトの子を計算し直す。
- 計算は、汚れた部分木の根から、上から下へ 1 回で行う。測定のキャッシュ（5.3 節、7.2 節）は、汚れたノードと祖先の分だけ捨てる。
- インスタンスの導出（components の 3.3 節）の後に、導出した木の汚れを受け取る。

## 10. 障害時の振る舞い

| 障害 | 振る舞い |
| --- | --- |
| 1 回の計算が 50ms を超える（巨大な hug の入れ子など） | 計算は最後まで行う（途中の結果を出さない）。`layout_slow`（ノードの ID、ノードの数、時間）を記録する |
| 7.1 の 3 の凍結が上限の回数で終わらない | ありえない（回数は fill の子の数で止まる）。止まったら、その時点の値を使い、`layout_invariant` を記録する |
| 保存された `derived_layout` と手元の計算が何度も食い違う | 4.2 節の 5。修復をやめて記録する |
| フォントがない | 6.4 節 |
| 参照するノードが一時的な循環で木から外れている | 外れたノードはレイアウトに入れない（[document-model.md](document-model.md) の 5 節） |

## 11. セキュリティ

- 入力は他の人が作ったファイル（信頼できない入力）。レイアウトで DoS を起こされうる。
  - 深い入れ子と大量の子：document-model の上限（深さ 256、子 10 万、ページ 30 万ノード）と、明示のスタック。
  - 測定の掛け算の爆発：7.2 節のキャッシュで、1 ノードの測定は 1 回の計算で最大 4 条件に抑える。
  - 巨大な値：入力の範囲（3.1 節）を検証する。計算の途中の値が ±10^9 を超えたら、その値で打ち切る。
- 修復（4.2 節）は編集の権限を持つ人だけが送れる。閲覧の人は `derived_layout` も書けない（サーバーの権限の検査）。
- 記録にはノードの ID と数だけを書く。テキストの中身・名前は書かない。

## 12. 性能の予算

| 場面 | 目標 | 関係する NFR |
| --- | --- | --- |
| 1 つのプロパティの変更の再計算（10 万ノードのファイル） | p95 2 ms（1 フレームの予算の中。[rendering-engine.md](rendering-engine.md) の 15 節） | NFR-002 |
| テキストへの 1 文字の入力（20 段の hug の入れ子の中） | p95 1 ms | NFR-002 |
| オートレイアウトの子 1,000 を持つフレームのドラッグでの並べ替え | 毎フレーム 2 ms 以内 | NFR-002、NFR-005 |
| ファイルを開いた後の全体の計算（10 万ノード） | アイドルの時間に分けて 300 ms 以内。最初の描画は保存された値で行い、待たない | NFR-003 |
| 測定のキャッシュのメモリ | 10 万ノードで 30 MB 以内 | NFR-004 |

- Taffy の README の計測では、10 万ノード（深さ 5）の flexbox の計算が約 39 ms（M1 Pro）である（[DioxusLabs/taffy](https://github.com/DioxusLabs/taffy)、2026-09-27 に確認）。テキストの測定を含む本システムの計算が 300 ms に収まるかは **未検証**。E5 の前に計測する。

## 13. テスト

### 13.1 性質ベーステスト

| ID の案 | 性質 |
| --- | --- |
| PROP-LAYOUT-001 | 任意の木と入力で、WASM とネイティブの結果（`derived_layout` の f32 のビット）が一致する |
| PROP-LAYOUT-002 | 任意の変更の列で、増分の再計算の結果と、一からの計算の結果が一致する |
| PROP-LAYOUT-003 | 計算を 2 回続けても結果が変わらない（冪等） |
| PROP-LAYOUT-004 | 結果に NaN・無限がなく、すべての子の大きさが `min_*` 以上 `max_*` 以下 |
| PROP-LAYOUT-005 | hug のフレームは、負の間隔がなければ、流れに入る子の箱と余白を含む |
| PROP-LAYOUT-006 | 余白・間隔・子の大きさを増やしても、hug のフレームの大きさは減らない |
| PROP-LAYOUT-007 | Taffy に写せる範囲（7.3 節）で、Taffy との差が 1/1024 px 以内 |
| PROP-LAYOUT-008 | 任意の 2 つのクライアントの同時の編集の列（シミュレーター）の後、4.2 節の修復が終わると、保存された `derived_layout` と全員の手元の計算が一致する |
| PROP-LAYOUT-009 | 任意の文字列と幅で、行の幅の和が折り返しの幅を超えない（1 語が収まらないときを除く）。改行の位置が UAX #14 の候補か書記素の境 |

- シミュレーターは multiplayer の性質ベーステスト（[multiplayer.md](multiplayer.md) の 15.1 節）に、レイアウトの入力の変更と修復を足して使う。

### 13.2 決定表と参照

- 7.1 節の組み合わせ（向き × 折り返し × 揃え × 大きさの方式 × 最小・最大）を決定表にし、表駆動のテストにする。期待値は手で計算した値。
- 8.1 節の制約の表を表駆動のテストにする。
- 参照ファイルのレイアウトの結果（`derived_layout` の全ノードのダンプ）を CI で比べる。1 ビットでも変われば落とし、6.3 節の手順を求める。
- 本家との比較：代表の 50 の場面を本家で作り、書き出した位置と大きさと比べる（E5）。

### 13.3 性能

- 12 節の場面を、CI のネイティブのベンチマークと、Chromium の headless（WASM）で測る。前の版より 20% 遅くなったら落とす（[rendering-engine.md](rendering-engine.md) の 16.3 節と同じ仕組み）。

## 14. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0019](../decisions/0019-auto-layout-engine-and-layout-persistence.md) | オートレイアウトは自前の flexbox に近い計算にし、Taffy を差分のテストの参照にする。結果は `derived_layout` に保存するが、画面は手元の計算で出し、食い違いは修復の担当が直す。制約は親の大きさを変えた人が当てる | accepted |
| [0020](../decisions/0020-deterministic-layout-arithmetic.md) | レイアウトとテキストの測定は f64 の四則と min・max だけで、順序を固定して計算する。標準の超越関数・FMA・並列を使わない。結果を変える変更は ADR を要する | accepted |

## 15. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり。

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `layout-crate-skeleton` | `layout` の crate、`LayoutResult`、決定性の lint（超越関数・`mul_add`・`HashMap` の走査の禁止）、WASM とネイティブの一致の CI（PROP-LAYOUT-001） |
| E4 | `text-line-breaking` | 行の組み立て（5.2 節）、測定の関数とキャッシュ、`text_auto_resize` |
| E5 | `constraints-on-resize` | 8.1 節の制約の適用（リサイズの操作は editor-and-tools と一緒に） |
| E5 | `auto-layout-core` | 7.1 節の 1〜7、9〜10（折り返しなし）、hug・fill・fixed、最小・最大 |
| E5 | `auto-layout-wrap` | 折り返し、`counter_axis_spacing`、`counter_axis_align_content` |
| E5 | `auto-layout-baseline-and-strokes` | ベースラインで揃える、線の太さを含める、重なりの順 |
| E5 | `derived-layout-persistence` | 4.1 節の書き手の規則、開いた直後の保存された値での描画（document-model の `derived-layout-property` と一緒に） |
| E5 | `layout-repair` | 4.2 節の修復の担当と比較、`layout_divergence` の記録、PROP-LAYOUT-008 |
| E5 | `incremental-relayout` | 9 節の汚れの伝播、PROP-LAYOUT-002、12 節の性能の CI |
| E5 | `taffy-differential-test` | 7.3 節（PROP-LAYOUT-007） |
| E5 | `group-bounds` | 8.2 節のグループとブール演算の境界 |
| E6 | `instance-layout` | 導出した木のレイアウト（components の 3.3 節と一緒に）。Worker での計算 |
| E10 | `worker-layout-for-instances` | Render Worker で、導出したインスタンスの中身を計算する（export-and-assets と一緒に） |
| E12 | `layout-telemetry` | `layout_slow`・`layout_divergence`・修復の件数の計測と警報 |

E1・E3・E7・E8・E9・E11 には、この領域の Story はない。

## 16. 未解決の問い

- 折り返しで fill の子の行分けの幅、`space_between` の子 1 つ、字間の行末の扱い、負の間隔の重なりの順が、本家と一致するか（E5 で比べる）。
- 絶対配置の子（`absolute`）に、hug で親の大きさが変わったときも制約を当てるか。今は当てない（利用者のリサイズだけ）。
- 縦の折り返し、グリッド、「Around」「Evenly」、テキストの最大の行の数（切り詰め）をいつ足すか。
- 修復の担当がフォントを持たないノード（端末のフォント）の食い違いを、誰が直すか。今は、次にそのテキストを編集した人まで残る。
- ファイルを開いた後の全体の計算（10 万ノードで 300 ms）が、テキストの多いファイルで収まるか。

### 決定（2026-09-27、既定案）

- **結果の保存**：`derived_layout` に保存する（document-model の既定案のとおり）。画面は手元の計算、保存された値は開いた直後・Worker・フォントのない人のため。
- **収束**：修復の担当（最小の `session_id` の編集者）が、500ms の静止の後に直す。
- **制約**：親の大きさを利用者が変えたときに、変えた人が子の入力を書き換える。
- **折り返し**：横だけ。折り返すフレームの主軸は hug にできない。
- **縮み**：fill 以外の子は縮めない。
- **`space_between` の子 1 つ**：先頭に置く。
- **行の高さの `auto`**：行の最初のフォントのメトリクス。フォールバックのフォントの値は使わない。
- **禁則**：ICU4X の `Strict`。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 本家との細部の一致（上の 1 つ目） | E5 で 50 の場面を比べる |
| 全体の計算の時間 | E5 の前に 10 万ノードの参照ファイルで計測 |
| インスタンスの中の上書きで、大きさの方式（hug・fill・fixed）を変えられるか | components-and-libraries.md の 3.4 節の 4 行目。許可で合わせる |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- PROP-LAYOUT-001〜009 を E5 のリリースの基準にする。特に 001（WASM とネイティブの一致）と 008（修復での収束）は、落ちたらリリースしない。
- 参照ファイルのレイアウトのダンプの比較（13.2 節）を PR ごとに行う。
- 本番での検証：`layout_divergence` の件数（目標 0。1 件でも調べる）、修復の `Set` の件数（同時の編集の頻度の目安）、`layout_slow` の件数を日次で見る。

### runbooks

- `layout-divergence.md`：`layout_divergence` が出たとき、ブラウザ・OS・エンジンの版の組で絞り込み、該当のファイルのノードの ID から、決定性の破れ（6 節）か版の食い違いかを切り分ける手順。中身は見ない。
- `layout-engine-upgrade.md`：整形の部品や計算の規則を上げるときに、参照ファイルのダンプの差を確かめ、ADR を書き、サーバー → クライアントの順で出す手順（document-model の `schema-rollout.md` と一緒に）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| document-model のプロパティの表 | 3.1 節の ★（`layout_wrap`、`counter_axis_spacing`、`counter_axis_align_content`、`strokes_included_in_layout`、`item_reverse_z_index`、`min_width`・`max_width`・`min_height`・`max_height`）。持ち主は layout |
| `derived_layout` | 書き手の規則を 4 節に合わせた（本人＋修復の担当。document-model の 4.4 節・9.2 節を統合の工程で改めた） |

## References

- Figma Help: [Guide to auto layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout)（2026-09-27 に確認）
- [DioxusLabs/taffy](https://github.com/DioxusLabs/taffy)（0.14.0、2026-08-24。2026-09-27 に確認）
- W3C: [CSS Flexible Box Layout Module Level 1](https://www.w3.org/TR/css-flexbox-1/)（9.7 節「柔軟な長さの解決」）
- Unicode: [UAX #14 Unicode Line Breaking Algorithm](https://www.unicode.org/reports/tr14/)
- ICU4X: [`icu_segmenter::options::LineBreakOptions`](https://docs.rs/icu_segmenter/latest/icu_segmenter/options/struct.LineBreakOptions.html)（2.3.0。既定の強さは `Strict`。2026-09-27 に確認）
- [rust-lang/libm](https://github.com/rust-lang/libm)

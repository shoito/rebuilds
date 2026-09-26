# Rendering: Chrome

Renderer の中で HTML を画面の画素にするまでの設計。HTML の解析、DOM、スタイル、レイアウト、描画、合成、GPU、スクロールと入力、アニメーション、文字、画像、アクセシビリティの木、性能の予算を扱う。JavaScript と Web API は [javascript-and-web-apis.md](javascript-and-web-apis.md) にある。

前提として、次の決定に従う。

| 決定 | 描画への影響 |
| --- | --- |
| [ADR-0001](../decisions/0001-languages-and-platform.md) | 自作の部分は Rust。C++ の部品（V8、Skia）は Rust のバインディングで包む |
| [ADR-0002](../decisions/0002-engine-build-vs-reuse.md) | DOM とレイアウトは自作。スタイル・描画・文字は部品を使う |
| [ADR-0003](../decisions/0003-multi-process-site-isolation.md) | Renderer はサイトごと。異なるサイトの iframe は別のプロセスで描き、GPU プロセスで合わせる |
| [ADR-0010](../decisions/0010-v8-embedding-and-dom-gc.md) | DOM のオブジェクトは V8 の cppgc のヒープに置き、V8 と 1 つのヒープとして追跡する |
| [ADR-0011](../decisions/0011-stylo-style-engine.md) | スタイルの計算は Stylo |
| [ADR-0012](../decisions/0012-own-layout-engine.md) | レイアウトは自作。不変のフラグメントの木を出力する |
| [ADR-0013](../decisions/0013-skia-raster-and-own-compositor.md) | 描画は Skia。合成は自作（Renderer の合成スレッドと、GPU プロセスの表示の合成） |

## 1. 全体の流れ

本家の RenderingNG の段（Animate → Style → Layout → Pre-paint → Scroll → Paint → Commit → Layerize → Raster → Activate → Aggregate → Draw）と同じ分け方を採る（[RenderingNG architecture](https://developer.chrome.com/docs/chromium/renderingng-architecture)）。段と、どのスレッド・プロセスで動くかを揃えておくと、本家の知見（性能の問題の切り分け、指標）をそのまま使える。

```
Renderer プロセス（サイトごと・サンドボックス）
┌─────────────── main スレッド ───────────────┐   ┌──── 合成スレッド ────┐
│ HTML 解析 → DOM（cppgc）                     │   │ 入力の受付          │
│ JavaScript（V8）                             │   │ スクロール          │
│ Style（Stylo、ワーカーで並列）               │   │ 合成アニメーション  │
│ Layout → フラグメントの木                    │   │ Layerize            │
│ Pre-paint → 属性の木（transform/clip/        │──▶│ 表示リスト＋属性の木│
│             effect/scroll）                  │Commit│ → 合成フレーム    │
│ Paint → 表示リスト（paint chunk）            │   └─────────┬──────────┘
└──────────────────────────────────────────────┘             │ IPC（共有メモリ）
                                                             ▼
GPU プロセス                         ┌──────────────────────────────────┐
                                     │ Raster（Skia、ワーカー）→ タイル │
                                     │ 表示の合成（Aggregate）          │
                                     │  複数 Renderer と Browser UI の  │
                                     │  合成フレームを 1 枚に合わせる   │
                                     │ Draw → OS のスワップチェーン     │
                                     └──────────────────────────────────┘
```

- main スレッドは、JavaScript・DOM・スタイル・レイアウト・描画の記録を持つ。重いが、スクロールと合成のアニメーションは止めない。
- 合成スレッドは、main スレッドが JavaScript で塞がっていても、スクロールと合成アニメーションを進める（RenderingNG と同じ）。
- 画素に変える（Raster）のは GPU プロセスで行う。Renderer は GPU に直接触れない（サンドボックスで GPU のドライバへの経路を閉じる。[sandbox-and-security.md](sandbox-and-security.md)）。

## 2. HTML の解析

### 2.1 解析器

- トークナイザと木の構築は、html5ever（MIT / Apache-2.0）を使う。木への書き込みは `TreeSink` を自分たちの DOM に実装して受ける（[html5ever](https://github.com/servo/html5ever)）。
  - 解析のアルゴリズム（WHATWG HTML の 13.2 節）は、仕様どおりに書くことが価値で、独自に書く利点が小さい。html5ever は html5lib のテストを通している。
  - `<script>` での中断、`document.write` による入力の差し込み、文字コードの判定と途中での切り替えは、html5ever の上に自分たちで組む。Servo が同じ組み方をしている。
- 文字コードは `encoding_rs`（Firefox と同じ実装）で UTF-8 に変換してから渡す。html5ever は UTF-8 しか受けないため。

### 2.2 ストリーミング

- ネットワークから届いた分だけ、少しずつ解析する。本文を全部待たない。
- 1 回の解析は時間で区切る（目安 5ms）。区切ったら、タスクを返して入力やレンダリングの更新に譲る。
- 最初の描画（First Contentful Paint）は、`<head>` のブロッキングのスタイルシートが揃い、`<body>` に内容が入った時点で出してよい。

### 2.3 投機的な解析（preload scanner）

- パーサーが同期の `<script>` で止まっている間、残りの入力を先読みし、`<img>`・`<link rel=stylesheet>`・`<script src>`・`<link rel=preload>` などの取得を先に始める。
- HTML の仕様は、投機的な解析を「DOM を変えずに、取得だけを先に行ってよい」ものとして定義している（[HTML Standard 13.2.8 Speculative HTML parsing](https://html.spec.whatwg.org/multipage/parsing.html#speculative-html-parsing)、[whatwg/html#5959](https://github.com/whatwg/html/pull/5959)）。
- 先読みはトークナイザだけを別に走らせる軽い実装にし、DOM を作らない。後から現れた `<base>` や `<meta http-equiv=Content-Security-Policy>` で結果が変わる取得は、本番の解析で照合し、合わなければ捨てる（Ladybird でも問題になった点）。
- 取得の要求は Network サービスに出し、CSP・CORS・Cookie の判定は Network と Browser の側で行う（[networking.md](networking.md)）。

## 3. DOM

### 3.1 方針

- DOM は Rust で自作する（ADR-0002）。仕様は WHATWG DOM と HTML。
- DOM のノードは V8 の cppgc（Oilpan）のヒープに置く。JavaScript のオブジェクト（ラッパー）と DOM のノードの間の参照は、V8 の GC が 1 つのヒープとして追跡する（[ADR-0010](../decisions/0010-v8-embedding-and-dom-gc.md)）。
  - Blink も DOM を Oilpan に置き、V8 と統合したヒープで追跡している（[High-performance garbage collection for C++](https://v8.dev/blog/high-performance-cpp-gc)）。
  - Rust の `v8` クレートは `cppgc` モジュール（`Heap`、`Member`、`WeakMember`、`Persistent`、`GarbageCollected`、`Visitor`）と、ラッパーとの対応付け（`Object::wrap` / `unwrap`）を公開している（[docs.rs v8::cppgc](https://docs.rs/v8/latest/v8/cppgc/index.html)、v8 152.2.0 で確認）。
- ノードどうしの参照（親・子・兄弟、属性、イベントのリスナー）は `Member<T>` で持つ。`Rc` や生のポインタで持たない。

### 3.2 ノードの形

```
Node（GarbageCollected）
├── node_id: NodeId          # 世代つきの番号。レイアウト・描画・a11y から参照するときに使う
├── parent / first_child / last_child / prev / next: Member<Node>
├── owner_document: Member<Document>
├── flags                    # 接続済み、スタイルの無効化、シャドウの木、など
├── kind: Element | Text | Comment | Document | DocumentFragment | ...
└── Element の場合
    ├── local_name, namespace, attrs（Atom の表）
    ├── shadow_root: Member<ShadowRoot>
    └── style_data: StyleData  # Stylo が書く。GC の参照を持たない（Arc の ComputedValues）
```

- **GC のヒープの外（スタイル、レイアウト、描画、a11y）からは、ノードを `NodeId` で指す。** ポインタを持たせない。削除されたノードを、古いフラグメントや表示リストが指していても、GC が回収した後に触ることがない。`NodeId` は Document が持つ表で引き、世代が合わなければ「ない」として扱う。
- スタイルのデータ（`ComputedValues`）は `Arc` で共有し、GC の参照を含めない。Stylo が並列にスタイルを書いても、GC の書き込みバリアが要らない。
- DOM を変えるのは main スレッドだけ。Stylo の並列の走査は、DOM を読むだけにする（4 節）。

### 3.3 イベント

- イベントの伝播（capture → target → bubble）、`composedPath`、Shadow DOM の再ターゲットは、DOM の仕様どおりに自作する。
- 入力のイベントは、合成スレッドで当たり判定の粗い振り分け（スクロールだけで済むか、main スレッドに渡すか）をしてから、main スレッドで DOM に配る（9 節）。

### 3.4 変更の通知

- DOM の変更は、1 か所（`Node` の変更の関数）から次に通知する。通知を忘れる経路を作らない。
  - スタイルの無効化（Stylo の invalidation。4.3 節）
  - MutationObserver の記録
  - a11y の木の更新（13 節）
  - Custom Elements の反応（`[CEReactions]`。[javascript-and-web-apis.md](javascript-and-web-apis.md)）

## 4. スタイル（Stylo）

### 4.1 組み込み方

- CSS の解析、カスケード、セレクタの照合、計算値は Stylo を使う（[ADR-0011](../decisions/0011-stylo-style-engine.md)）。Firefox と Servo が使う、crates.io に公開されたクレート（`stylo`、`selectors`、`stylo_traits` など。MPL-2.0。[servo/stylo](https://github.com/servo/stylo)）。
- Stylo は DOM を trait（`TElement`・`TNode`・`TDocument`・`TShadowRoot`）越しに読む。自分たちの DOM にこれを実装する層（`style_bridge`）を 1 つ作り、DOM の他の部分から Stylo を直接呼ばない。Blitz が同じ方法で自前の DOM に Stylo をつないでいる（[DioxusLabs/blitz](https://github.com/DioxusLabs/blitz)）。
- Stylo は `servo` の機能で組む（`gecko` の機能は Firefox の C++ に依存するため使えない）。

### 4.2 並列の走査

- Stylo は要素の木を rayon のスレッドプールで並列に走査する。走査の間、main スレッドは JavaScript を止めて待つ（スタイルの計算は同期的な段）。
- 並列の走査の間、DOM は読み取りだけで、Stylo が書くのは各要素の `style_data` だけ。この約束は `style_bridge` の型で表し（読み取り専用の参照型だけを渡す）、`unsafe` はこの層に閉じる。
- cppgc の並行マーキングとの関係：マーキングは GC の参照（`Member`）だけを読み、`style_data` には GC の参照がないので、並列の走査と衝突しない。スタイルの走査中は、GC の回収（sweep で Rust 側のデストラクタを動かすこと）を始めない。

### 4.3 無効化と再計算

- 属性・クラス・状態（`:hover` など）の変化は、Stylo の invalidation の仕組みで影響する要素だけに印を付け、次のフレームで再計算する。
- スタイルシートの追加・削除は、Stylo の `Stylist` を更新して、規則の索引を作り直す。

### 4.4 Stylo の範囲の確かめ

- **未検証**：`servo` の機能で組んだ Stylo が、`gecko` の機能に比べて、どの CSS のプロパティを持たないか。確かめ方：Stylo のプロパティの定義（`engines=` の指定）から、`servo` で有効なプロパティの一覧を機械的に出し、NFR-007 の対象にする WPT の CSS の領域と突き合わせる。足りないプロパティは、Stylo の上流（servo/stylo）に追加を送り、フォークを持たない。E1 の中で行う。

## 5. レイアウト

### 5.1 方針

- レイアウトは自作する（[ADR-0012](../decisions/0012-own-layout-engine.md)）。入力は DOM と計算値、出力は**不変のフラグメントの木**（本家の LayoutNG と同じ考え方。[RenderingNG data structures](https://developer.chrome.com/docs/chromium/renderingng-data-structures)）。
- 箱の木（layout box tree）を DOM から作り、各箱のレイアウトの結果をフラグメントとして返す。フラグメントは位置・大きさ・子のフラグメントを持ち、一度作ったら変えない。変わった部分だけを作り直し、変わらない部分は前のフラグメントを再利用する。

```
DOM ＋ ComputedValues
  → 箱の木の構築（display、匿名の箱、::before/::after、テキストの走り）
  → レイアウト（制約 = 利用できる幅・高さ）
  → フラグメントの木（不変、Arc で共有）
  → Pre-paint（属性の木）→ Paint（表示リスト）
```

### 5.2 範囲

| 機能 | MVP | 実装 |
| --- | --- | --- |
| ブロック（通常の流れ、マージンの相殺、BFC） | 含む | 自作 |
| インライン（行の組み立て、改行、`white-space`、`text-align`、縦の揃え、`::first-line` の一部） | 含む | 自作（文字は 11 節） |
| float と clear | 含む | 自作 |
| 位置指定（relative・absolute・fixed・sticky） | 含む | 自作 |
| Flexbox | 含む | 自作 |
| Grid | 含む（subgrid を除く） | Taffy のグリッドのアルゴリズムを、自作の箱の木の下で使う（ADR-0012） |
| 表（table） | 含む | 自作 |
| 置換要素（img・video・canvas・iframe） | 含む | 自作 |
| 複数段組（multicol）、断片化（印刷） | 含まない | 後の Story。印刷は PDF 出力の Epic で扱う |
| 縦書き（`writing-mode: vertical-*`） | 含む（日本語のため） | 自作。論理的な方向（inline/block）で全体を書き、物理の方向へは最後に変換する |
| `contain`、`content-visibility` | 含む | 自作。レイアウトを省く境界として使う（5.4 節） |
| container queries | 含む | Stylo と協調（レイアウト → 容器の大きさ → スタイルの再計算を 1 往復に限る） |

- 論理的な方向で書くのは最初からにする。後から縦書きを足すと、物理の方向で書いたコードを全面的に直すことになる。

### 5.3 インクリメンタルなレイアウト

- スタイルの変化ごとに「どこまで作り直すか」を決める。
  - 描画だけ（`color` など）：レイアウトを飛ばし、Paint から。
  - 自分の大きさだけ：その箱から、大きさが変わらない祖先まで。
  - 箱の木の形（`display` など）：その部分木の箱の木を作り直す。
- フラグメントの再利用：箱ごとに「前回の制約」と「前回のフラグメント」を持ち、制約と子の変化がなければ前のフラグメントを返す。
- 強制的な同期レイアウト（JavaScript が `offsetWidth` などを読むとき）は、必要な範囲だけ計算する。回数を計測し、開発者ツールで警告できるようにする。

### 5.4 レイアウトを省く

- 画面の外の `content-visibility: auto` の部分木は、レイアウトと描画を省く。
- 背景のタブは、レイアウトを止める（`requestAnimationFrame` も止まる）。

### 5.5 当たり判定

- 当たり判定（hit test）は、フラグメントの木と属性の木から行う。結果は `NodeId`。
- 合成スレッドは、main スレッドのコミットで受け取った「当たり判定の粗い領域」（スクロールできる領域、イベントのリスナーがある領域、`touch-action`）だけで判断する（9 節）。

## 6. 描画の記録（Paint）と表示リスト

- Pre-paint で、属性の木（transform・clip・effect・scroll の 4 つの木）を作る。RenderingNG と同じ分け方（[RenderingNG data structures](https://developer.chrome.com/docs/chromium/renderingng-data-structures)）。
- Paint で、フラグメントの木を CSS の描画の順（stacking context、z-index）で辿り、表示リストを作る。表示リストは、同じ属性の木の状態を共有する描画命令のまとまり（paint chunk）に分ける。
- 表示リストは自前の Rust の型で、Skia の型を含めない。
  - 命令は、矩形・角丸・境界線・影・文字の走り（グリフの ID と位置、フォントの ID）・画像（画像の ID）・グラデーション・パス・clip など。
  - プロセスの境界を越えて GPU プロセスへ送るため、シリアライズの形を固定し、GPU プロセス側で検証してから Skia の呼び出しに変える（14 節）。
- 前回の表示リストと比べて、変わった paint chunk だけを無効化する（raster の無効化の範囲を小さくする）。

## 7. 合成

### 7.1 Renderer の合成スレッド

- main スレッドは、Paint の後に、表示リストと属性の木を合成スレッドへ**コミット**する。コミットの間だけ main スレッドを止める。
- 合成スレッドは次を持つ（[ADR-0013](../decisions/0013-skia-raster-and-own-compositor.md)）。
  - **Layerize**：表示リストを、合成の層（composited layer）に分ける。層にするのは、合成でアニメーションする transform・opacity、スクロールする領域、video・canvas・iframe、`will-change` の要素。層を増やしすぎると GPU のメモリが増えるので、重なりの判定で最小にする。
  - **スクロール**：スクロールの位置を合成スレッドが持ち、main スレッドを待たずに更新する（9 節）。
  - **合成のアニメーション**：transform・opacity・filter のアニメーションと、スクロールに連動するアニメーションを、合成スレッドで進める（10 節）。
  - **タイル**：層をタイル（例：256×256 の物理画素）に分け、見えている範囲と少し先（先読みの余白）のタイルの raster を GPU プロセスに頼む。
  - **Activate**：新しいタイルの raster が揃ったら、その木を有効にし、合成フレームを作る。揃う前にスクロールした場所は、背景の色で埋める（チェッカーボードの時間を指標にする）。

### 7.2 GPU プロセスの表示の合成

- 各 Renderer（別のサイトの iframe を含む）と、Browser の UI は、それぞれ合成フレームを GPU プロセスへ送る。フレームは「surface」の ID で識別し、iframe は親のフレームの中に子の surface への参照として埋め込む（本家の viz の surface と同じ考え方）。
- GPU プロセスの表示の合成（display compositor）は、これらを 1 枚に合わせ（Aggregate）、Skia で描いて（Draw）、OS のスワップチェーンに出す。
- 表示の合成は、GPU の main スレッドとは別のスレッドで動かし、ドライバの呼び出しで止まらないようにする（RenderingNG の viz と同じ）。
- surface の参照は Browser が発行した ID だけを受け付ける。ある Renderer が、他のサイトの surface を自分のフレームに埋め込むことはできない（ADR-0003 の「Renderer を信用しない」を、合成にも適用する。[process-model.md](process-model.md)）。

### 7.3 OS の合成器への委譲

- MVP では、合わせた 1 枚をスワップチェーンに出す。
- 動画・全画面のオーバーレイ（macOS の CoreAnimation、Windows の DirectComposition）への委譲は、消費電力の改善として E3 で行う。

## 8. GPU プロセスと raster

### 8.1 選択

- raster は Skia を使い、合成は自作する（[ADR-0013](../decisions/0013-skia-raster-and-own-compositor.md)）。Rust からは `skia-safe`（MIT）で呼ぶ（[rust-skia](https://github.com/rust-skia/rust-skia)）。
- Skia は、本家 Chrome の raster と Canvas 2D の実装であり、同じ部品で「ページの raster」「Canvas 2D」「表示の合成の描画」を賄える。WebRender は Canvas 2D を持たない（Firefox も Canvas 2D には Skia を使う）。

### 8.2 GPU のバックエンド

| OS | MVP | 備考 |
| --- | --- | --- |
| macOS | Skia Graphite（Metal） | 本家は Apple Silicon の Mac で Graphite を出荷済み（[Chromium Blog, 2025-07](https://blog.chromium.org/2025/07/introducing-skia-graphite-chromes.html)） |
| Windows | Skia Ganesh（OpenGL ES を ANGLE で D3D11 に変換） | 本家の Windows と同じ経路。ANGLE は WebGL にも要る |
| Linux | Skia Ganesh（OpenGL ES / Vulkan） | |
| すべて | Skia の CPU の raster | GPU が使えない・ブロックリストのドライバのとき |

- Windows と Linux の Graphite への移行は、本家の展開を見て判断する（E3 以降）。
- GPU のドライバのブロックリストを持ち、既知の不具合があるドライバでは CPU の raster に落とす。GPU プロセスが繰り返しクラッシュしたら、CPU の raster に落として再起動する。
- **未検証**：`skia-safe` の Graphite のバインディングが、本番で使える範囲（Metal の `Recorder`・`Context`、画像のアップロード）を持つか。`skia-safe` を ANGLE と組み合わせたビルド（EGL の文脈を Skia に渡す）の手間。確かめ方：E1 の中で、3 OS で「表示リスト → タイル → 画面」の最小の経路を組む。

### 8.3 raster の分担

- raster は GPU プロセスのワーカーで行う（本家の OOP raster と同じ）。Renderer は表示リストを共有メモリに書き、GPU プロセスが読んで Skia の命令に変える。
- タイルの優先度：見えている範囲 → 先読みの余白 → 画面の外。スクロールの向きに合わせて先読みを伸ばす。
- GPU のメモリの上限（タイル、画像、glyph のアトラス）を GPU プロセスで 1 つに管理し、背景のタブのタイルから捨てる（NFR-004）。

### 8.4 GPU プロセスの隔離

- GPU プロセスは、Skia・ANGLE・ドライバという大きな C/C++ の攻撃面を持つ。Renderer から届く表示リストは、型・範囲（座標の有限性、画像・フォントの ID の所有）を検証してから Skia に渡す。
- 表示リストのデシリアライザは、常時ファズの対象にする（[build-and-test.md](build-and-test.md)）。

## 9. スクロールと入力の遅延

- 入力は Browser プロセスで受け、どの Renderer（どの surface）に当たったかを、GPU プロセスの当たり判定の情報で決めて送る（クロスプロセスの iframe を含む）。
- Renderer の合成スレッドが入力を最初に受ける。
  - ホイール・タッチパッド・キーのスクロールで、その場所に `passive` でないリスナーがなければ、合成スレッドだけでスクロールする。
  - リスナーがあれば main スレッドに渡し、`preventDefault` の結果を待つ。待つ時間には上限を設け（本家の介入に合わせる）、指標として記録する。
- 入力イベントはフレームに揃えて束ねる（`pointermove` などの連続するイベントは、フレームごとに 1 回配る）。
- スクロールに連動する要素（`position: sticky`、スクロール連動のアニメーション）は、属性の木の scroll の木で表し、合成スレッドで位置を決める。
- 指標：入力から画面の更新まで（Input to frame）と、INP を Renderer で計測する（[observability.md](observability.md)）。

## 10. アニメーション

- Web Animations のモデル（`Animation`、`KeyframeEffect`、タイムライン）を自作し、CSS Animations・CSS Transitions をその上に載せる。
- 値の補間は Stylo の補間の機能（`Animate` trait）を使い、計算値の形を二重に持たない。
- transform・opacity・filter だけを変えるアニメーションは、合成スレッドに渡して進める（main スレッドが塞がっても滑らか）。それ以外は main スレッドで、毎フレームのスタイルの再計算で進める。
- `requestAnimationFrame` は、画面の垂直同期（GPU プロセスから届く BeginFrame）に揃えて呼ぶ。背景のタブでは止める。
- `prefers-reduced-motion` を OS の設定から渡す。

## 11. 文字の組版とフォント

| 役割 | 部品 | 理由 |
| --- | --- | --- |
| フォントの解析・グリフの輪郭 | Skrifa（fontations、Rust） | 本家は Chrome 133 から Skrifa を使い、Chrome 145 で FreeType を Blink から外した（[Memory safety for web fonts](https://developer.chrome.com/blog/memory-safety-fonts)、[googlefonts/fontations](https://github.com/googlefonts/fontations)）。Web フォントは信頼できない入力で、Rust で解析する |
| シェーピング | HarfRust（HarfBuzz の Rust 移植。HarfBuzz の組織が保守） | Skrifa と同じ `read-fonts` の上にあり、`unsafe` がない（[harfbuzz/harfrust](https://github.com/harfbuzz/harfrust)） |
| 改行・書記素・単語の区切り、双方向（bidi） | ICU4X（`icu_segmenter`、`icu_properties`）と `unicode-bidi` | Rust で書かれた Unicode の部品。日本語・タイ語の辞書による区切りを持つ |
| グリフの描画 | Skia（Skrifa のバックエンドで） | 本家と同じ組み合わせ |
| OS のフォントの列挙・代替 | 各 OS の API（CoreText、DirectWrite、Fontconfig） | システムのフォントの一覧と、文字ごとの代替のフォントの選択 |

- インラインのレイアウトは「テキストの走り（同じフォント・同じ方向・同じスクリプト）→ シェーピング → 改行の候補 → 行の組み立て」の順。シェーピングの結果は、文字列とフォントの組でキャッシュする。
- Web フォントは、取得した後、Utility プロセスではなく Renderer の中で Skrifa で検証してから使う（Rust で解析するので、別プロセスに分けない）。OTS（OpenType Sanitizer）に当たる検査は、Skrifa の解析の失敗として扱う。
- `font-display` の既定の待ち時間（block 3 秒）は仕様どおり。
- **未検証**：HarfRust のシェーピングの速度が、HarfBuzz（C++）と比べてどの程度か。確かめ方：E1 で、日本語・アラビア語・デーヴァナーガリーの長文でベンチマークし、1.5 倍を超えて遅ければ HarfBuzz（C++、MIT）に替える。切り替えられるよう、シェーピングは 1 つの trait の裏に置く。
- **未検証**：`skia-safe` から Skia の Fontations のバックエンド（`SkTypeface_Fontations`）を使えるか。使えなければ、Skrifa で輪郭を取り出し、パスとして Skia に渡す。

## 12. 画像

- 画像の復号は、形式ごとの Rust の復号器を優先する（`png`、`zune-jpeg`、`image-webp`、`gif`）。AVIF は `dav1d`（C、BSD）を使う。画像は信頼できない入力なので、C の復号器は Utility プロセスで動かす（[sandbox-and-security.md](sandbox-and-security.md)）。
  - **未検証**：`zune-jpeg` と `image-webp` の、本家（libjpeg-turbo、libwebp）に対する互換性（壊れたファイルの扱い、色空間）と速度。確かめ方：E1 で本家のテスト画像の集まりと WPT の画像のテストで比べる。
- 復号は遅延させる。表示リストは画像の ID だけを持ち、raster の時に、必要な大きさで復号する（大きな画像を縮小して復号する）。
- 復号済みの画像はキャッシュに置き、上限を超えたら、見えていないものから捨てる。
- `loading=lazy`、`decoding=async`、`srcset`・`sizes` は仕様どおり。
- 色の管理：画像の ICC プロファイルと画面の色空間を Skia の色空間の変換で扱う。HDR は MVP に含めない。

## 13. アクセシビリティの木

- Renderer は、DOM とフラグメントの木から、a11y の木（役割、名前、状態、位置）を作る。役割と名前の計算は、HTML-AAM と Accessible Name and Description Computation に従う。
- a11y の木は、支援技術が使われているときだけ作る（OS が問い合わせてきたら有効にする）。
- Renderer は a11y の木の差分を Browser プロセスへ送り、Browser が OS の API（macOS の NSAccessibility、Windows の UI Automation、Linux の AT-SPI）に出す。Browser の UI と Web の内容を 1 つの木として OS に見せる。OS との接続の部品（AccessKit を使うか）は [browser-ui.md](browser-ui.md) で決める。
- a11y の木のノードは `NodeId` で DOM を指す（3.2 節）。

## 14. プロセスの境界と信頼

| 境界 | 送るもの | 検証する側 |
| --- | --- | --- |
| Renderer → GPU | 合成フレーム、表示リスト、画像の復号済みの画素（共有メモリ） | GPU プロセス。形・範囲・所有（自分の surface、自分の画像か） |
| Renderer → Browser | a11y の木の差分、カーソルの形、当たり判定の領域 | Browser。そのプロセスに割り当てたサイトのフレームか |
| Browser → Renderer | 入力、画面の大きさ・倍率、可視性 | — |

- 表示リストとフレームのシリアライズの形は、Rust の型から生成し、手で書かない。デシリアライザはファズの対象にする。

## 15. 動画と Canvas

- `<video>` の復号は Utility プロセス（または OS の復号器）で行い、フレームは GPU のテクスチャとして GPU プロセスへ直接渡す。Renderer は画素に触れない。動画は合成の層として合成する。
  - 復号の部品は、この文書の範囲の外。DRM（Widevine）は S1 に含めない（下の未解決事項）。
- Canvas 2D は Skia で描く。描画の命令を記録し、GPU プロセスで raster する（本家の OOP の Canvas と同じ）。`getImageData` などの読み戻しが多いキャンバスは、CPU の raster に切り替える。
- WebGL は MVP に含めない（[javascript-and-web-apis.md](javascript-and-web-apis.md) の 6 節）。ANGLE を GPU プロセスに載せる形で、後の Story で足す。

## 16. 性能の予算

NFR-002（Core Web Vitals が本家の 1.2 倍以内）、NFR-003（Speedometer 3 が本家の 80% 以上）、NFR-004（タブ 20 枚でメモリが本家の 1.2 倍以内）を、描画の段ごとの予算に分ける。値は基準の端末（[build-and-test.md](build-and-test.md)）での目安で、E3 の計測で見直す。

| 項目 | 予算 | 関係する NFR |
| --- | --- | --- |
| 1 フレーム（60Hz） | 16.7ms。main スレッドの Style＋Layout＋Paint は、DOM の小さな変更で 4ms 以内 | NFR-002（INP）、NFR-003 |
| 合成スレッドのスクロール | 入力から画面の更新まで 1 フレーム以内。main スレッドの状態に依存しない | NFR-002（INP） |
| チェッカーボード（raster が間に合わない領域） | 速いスクロールで、フレームの 1% 未満 | — |
| 初回の解析と描画 | 本家と同じページで FCP・LCP が 1.2 倍以内 | NFR-002 |
| レイアウトのずれ | フォントの差し替え・画像の読み込みで、本家より CLS を悪化させない（`font-display`、`aspect-ratio` の扱いを揃える） | NFR-002（CLS） |
| DOM のノードの大きさ | 要素 1 つあたり、属性を除いて 128 バイト以内を目標 | NFR-004 |
| GPU のメモリ | タイル・画像・グリフの合計に上限。背景のタブのタイルは数秒で捨てる | NFR-004 |
| 復号済みの画像のキャッシュ | Renderer ごとに上限。見えていないものから捨てる | NFR-004 |

- 予算を越えたかどうかは、Renderer のトレース（段ごとの時間）で CI と実機で測る（[observability.md](observability.md)）。
- ベンチマーク：Speedometer 3（NFR-003）、MotionMark 1.3（raster と合成）、主要サイトの読み込みでの LCP・CLS・INP の比較。

## 17. 未解決事項と未検証の項目

| 項目 | 状態 | 確かめ方・決め方 |
| --- | --- | --- |
| `servo` の機能の Stylo が持たない CSS のプロパティ | 未検証 | 4.4 節。E1 で一覧を出し、WPT の対象と突き合わせる |
| Rust の `v8::cppgc` で DOM を作ったときの速度とメモリ | 未検証 | E1 で、ノードの作成・挿入・削除のマイクロベンチマークを本家と比べる（[ADR-0010](../decisions/0010-v8-embedding-and-dom-gc.md)） |
| `skia-safe` の Graphite と ANGLE との組み合わせ | 未検証 | 8.2 節。E1 で 3 OS の最小の経路を組む |
| HarfRust の速度、`skia-safe` での Fontations のバックエンド | 未検証 | 11 節 |
| Rust の画像の復号器の互換性 | 未検証 | 12 節 |
| Taffy のグリッドの、仕様への適合の範囲 | 未検証 | WPT の `css/css-grid` を E2 で流し、合格率が 90% に届かなければ、グリッドも自作に替える（ADR-0012） |
| 動画の復号の部品と DRM（Widevine を使うか） | 復号の部品は未決定。DRM は S1 に含めない | 復号の部品は動画の領域の文書で決める。Widevine はライセンスの申請が要り、法務・事業の確認待ち（[intent.md](../intent.md)、[roadmap.md](../roadmap.md) の「後回しにしたもの」） |
| OS の合成器への委譲の範囲 | 未決定 | E3 で消費電力を測って決める |

## 参考

- [RenderingNG architecture](https://developer.chrome.com/docs/chromium/renderingng-architecture)、[Key data structures in RenderingNG](https://developer.chrome.com/docs/chromium/renderingng-data-structures)
- [High-performance garbage collection for C++（Oilpan / cppgc）](https://v8.dev/blog/high-performance-cpp-gc)、[docs.rs v8::cppgc](https://docs.rs/v8/latest/v8/cppgc/index.html)
- [servo/stylo](https://github.com/servo/stylo)、[servo/html5ever](https://github.com/servo/html5ever)、[DioxusLabs/taffy](https://github.com/DioxusLabs/taffy)、[DioxusLabs/blitz](https://github.com/DioxusLabs/blitz)
- [servo/webrender](https://github.com/servo/webrender)、[rust-skia](https://github.com/rust-skia/rust-skia)、[Introducing Skia Graphite](https://blog.chromium.org/2025/07/introducing-skia-graphite-chromes.html)
- [Memory safety for web fonts](https://developer.chrome.com/blog/memory-safety-fonts)、[harfbuzz/harfrust](https://github.com/harfbuzz/harfrust)
- [HTML Standard: Parsing](https://html.spec.whatwg.org/multipage/parsing.html)、[DOM Standard](https://dom.spec.whatwg.org/)

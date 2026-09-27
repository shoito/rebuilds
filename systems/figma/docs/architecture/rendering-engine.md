# Rendering Engine: Figma

キャンバスを画面の画素にするまでの設計。シーングラフ、タイルとカリング、GPU の抽象（WebGPU・WebGL2）、パスの描画とアンチエイリアス、塗り・エフェクト・ブレンドモード・マスク、テキストの描画と日本語のフォールバック、画像、メモリの予算、サーバーでの描画（ネイティブのビルド）を扱う。

| 関連 | 決定 |
| --- | --- |
| [ADR-0004](../decisions/0004-gpu-rendering-in-wasm.md) | 描画は WASM の中の自前のエンジン。WebGL2 を必須、WebGPU を使えるときに使う。GPU の抽象の下に wgpu |
| [ADR-0013](../decisions/0013-scene-graph-and-tile-rendering.md) | シーングラフは描画用に別に持ち、256 px のタイルに描いてキャッシュする。パスは CPU で線分にし、GPU で面積の被覆率を求める |
| [ADR-0014](../decisions/0014-gpu-backend-selection-and-fallback.md) | 1 つのビルドに WebGPU と WebGL2 を入れる。WebGPU で始め、失敗したらキャンバスを作り直して WebGL2 に移る。サーバーは同じコードを Vulkan のソフトウェアの実装で動かす |
| [ADR-0015](../decisions/0015-text-shaping-and-glyph-rendering.md) | テキストは HarfRust・Skrifa・ICU4X で整形する。小さい文字はグリフのアトラス、大きい文字はパスで描く。グリフのないときの代わりのフォントの順は、ファイルの設定で決める |
| [ADR-0001](../decisions/0001-platform-and-stack.md) | エンジンは Rust → WASM。同じ crate をネイティブにもビルドする |
| [ADR-0034](../decisions/0034-export-rendering-split.md)、[ADR-0035](../decisions/0035-content-addressed-images.md)、[ADR-0036](../decisions/0036-font-sources-and-licensing.md) | 書き出しの描く場所、画像の縮小版と配信、フォントの出どころ（export-and-assets の領域） |

ノードとプロパティの形は [document-model.md](document-model.md)、画面に出す状態（確定＋未確定の自分の変更）は [multiplayer.md](multiplayer.md) の 7 節、レイアウトの計算（位置と大きさ、テキストの折り返し）は [layout.md](layout.md)、選択・変形・テキストの編集は [editor-and-tools.md](editor-and-tools.md)、書き出しの形式・画像とフォントのアップロードと配信・Render Worker は [export-and-assets.md](export-and-assets.md) にある。

## 1. 目的と範囲

- 目的：10 万ノードのファイルでも、パン・ズームを 60fps で描く（NFR-005）。自分の入力を 1 フレームで画面に出す（NFR-002）。ブラウザ・OS・書き出しで同じ見た目にする。
- 範囲：`doc-model` の木とレイアウトの結果から、画面の画素を作るまで。GPU の抽象（`gpu` の crate）、シーングラフ（`scene`）、ラスタライズ（`raster`）、テキストの描画（`text`）、画像のデコードとキャッシュ（`image`）、ネイティブのビルド（`render-native`）。
- 範囲の外：UI の殻（React）、ヒットテストの結果の使い方（editor-and-tools）、レイアウトの計算（layout）、書き出しのファイル形式（export-and-assets）。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 項目 | 本家 | 本システム |
| --- | --- | --- |
| 方式 | WebGL の上の自前のタイルの描画エンジン。マスク、ぼかし、ディザ付きのグラデーション、ブレンドモード、入れ子の不透明度を GPU で描き、すべてアンチエイリアスする（[Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/)、2015-12-07） | 同じ考え方。wgpu の上に自前で作る |
| 言語 | C++ を Emscripten で WASM に。WASM で読み込みが 3 倍速くなった（[Figma is powered by WebAssembly](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/)、2017-06-08） | Rust → WASM（ADR-0001） |
| WebGPU | 描画の呼び出しの引数を明示する形に作り直し、GLSL を naga で WGSL に変換した。WebGPU で始め、互換性のテストはセッションの開始の後に非同期で走らせ、失敗したら WebGL に戻る。戻る率の高い端末はブロックリストに入れる。ネイティブのアプリには Dawn を使う。今後は compute shader のぼかし、MSAA を予定（[Figma rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)、2025-09-18） | WGSL で 1 つに書き、wgpu（naga を含む）で WebGL2 へ。同じ切り替えの仕組みを持つ（ADR-0014） |
| 性能の試験 | PR ごとに GPU 付きの VM で headless の Chromium を走らせ、10 分以内に結果を返す。VM の揺れを見込んで 20% の余裕で判定する。古い機種を含む実機の群れも持つ（[Keeping Figma Fast](https://www.figma.com/blog/keeping-figma-fast/)、2023-08-29） | 同じ 2 層（16 節） |
| 画像 | 512×512 を超える画像は、高解像度と低解像度の 2 つを持つ。見えている画像だけ高解像度を読む（[Image loading and performance](https://help.figma.com/hc/en-us/articles/360052988373-Image-loading-and-performance)）。4096 px を超える画像は、長い辺が 4096 px になるよう縮める（[Add images and videos to designs](https://help.figma.com/hc/en-us/articles/360040028034-Add-images-and-videos-to-designs)） | 同じ（10 節） |
| メモリ | タブあたり 2 GB を上限にする（[Reduce memory usage in files](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)） | 1.5 GB（NFR-004） |
| テキストの描画の方式（アトラスかパスか）、日本語のフォールバックの順序、ぼかしの半径の定義 | 資料に記述なし（未検証） | 9 節、8 節で決める |

## 3. 1 フレームの流れ

```
入力（pointer / key / IME）          サーバーからの変更
        │                                  │
        ▼                                  ▼
 ┌─ doc-model：変更を当てる（未確定の変更を含む）──────────────┐
 │  変わったノードの集合（dirty set）                          │
 └──────────────┬──────────────────────────────────────────────┘
                ▼
 layout：影響する部分だけ計算し直す（layout.md）
                ▼
 scene：描画用のノードを作り直す → 世界座標の変換と境界の箱 → 無効にするタイルの集合
                ▼
 raster：見えていて無効なタイルを描く（1 フレームの時間の予算の中で。残りは次のフレーム）
                ▼
 composite：画面に見えるタイルを並べ、選択の枠・他の人のカーソル・ガイドを上に描く
                ▼
 gpu：submit → 表示
```

- 1 フレームの中で、入力の適用から表示までを行う。すべてブラウザのメインスレッドの WASM で動く（[ADR-0016](../decisions/0016-shell-engine-boundary.md)）。
- 画像のデコード、見ていないページの読み込みの解析、フォントの解凍は Web Worker で行う。
- 描き終わらなかったタイルは、同じ場所の古いタイル（前の版、別の倍率）を拡大・縮小して見せ、次のフレームで描く。空白（チェッカーボード）は見せない。

## 4. シーングラフ

### 4.1 形

`doc-model` のノードの木とは別に、描画用の木（`RenderNode` のアリーナ）を持つ。`doc-model` はサーバーと共有する正本で、描画のための派生値（世界座標、ジオメトリのキャッシュ）を入れないため。入力は `DocRead` と、フレームごとの `ChangeSummary`（[document-model.md](document-model.md) の 9.1 節）、レイアウトの結果（[layout.md](layout.md) の 3 節）、インスタンスの導出の結果（[components-and-libraries.md](components-and-libraries.md) の 3.3 節。導出したノードも普通のノードとして描く）。

| 欄 | 型 | 内容 |
| --- | --- | --- |
| `node_id` | `NodeRef` | `doc-model` の ID（`(session_id, local_id)`）。インスタンスの中の導出したノードは `InstanceSubId` |
| `parent`・`first_child`・`next_sibling` | アリーナの添字 | 描く順（深さ優先）で並べる |
| `local_transform` | f64 の 2×3 の行列 | レイアウトの結果を含む。ファイルの値は f32（document-model の 4.3 節）で、描画の中だけ f64 に広げる |
| `world_transform` | f64 の 2×3 | 親から合成する。GPU に渡すときにタイルの原点からの相対の f32 にする（大きな座標で f32 の精度を失わないため） |
| `local_bounds`・`world_bounds` | 軸に平行な箱 | `world_bounds` は影・ぼかし・線の太さを含む（描画に影響する範囲） |
| `subtree_bounds` | 軸に平行な箱 | 子孫を含めた範囲。カリングで部分木ごと飛ばす |
| `draw_ops` | `Vec<DrawOp>` | 塗り、線、テキスト、画像。ジオメトリは `GeometryId` でキャッシュを指す |
| `effects`・`blend`・`opacity`・`clip`・`mask_role` | | 8 節 |
| `dirty` | ビットの集合 | `TRANSFORM`、`GEOMETRY`、`PAINT`、`EFFECTS`、`CHILDREN`、`TEXT` |

- 1 ノードあたり 200 バイト以内を目標にする（`draw_ops` の中身とジオメトリは別に数える）。10 万ノードで 20 MB。
- ジオメトリ（平坦化した線分、線を塗りに変えた輪郭）は、`(GeometryId, 倍率の段)` でキャッシュする。倍率の段は 2 の冪（1/256〜256）。

### 4.2 更新

1. `doc-model` とレイアウトから、変わったノードと変わった種類（dirty）を受け取る。
2. `TRANSFORM` なら部分木の `world_transform` と境界の箱を計算し直す。`GEOMETRY` ならジオメトリのキャッシュを捨てる。
3. 変わる前と後の `world_bounds` の和を、無効にする範囲にする。この範囲に重なるタイルを無効にする。
4. 親の `subtree_bounds` を、根まで計算し直す（広がらなければ途中で止める）。

1 つのノードの色を変えたとき、再計算はそのノードと祖先の境界の確認だけで、O(木の深さ) で済む。

### 4.3 カリングと空間の索引

- 部分木の境界の箱で、タイルに重ならない部分木を飛ばす（木そのものを BVH として使う）。
- 子が 64 を超える親は、子の境界の箱の R-tree を持つ。ページの直下に数千のフレームが並ぶ形でも、線形の走査を避ける。
- 非表示のノード、不透明度 0 のノード、画面の上で 1/4 px より小さいノードは描かない。
- 画面の上で高さ 3 px より小さい行のテキストは、行ごとの灰色の棒で描く（グリーキング）。整形の結果は使うが、グリフは描かない。
- ヒットテストも同じ索引を、描く順の逆に辿る（[editor-and-tools.md](editor-and-tools.md) の 4 節）。

## 5. タイル

### 5.1 大きさと鍵

- タイルは 256×256 の画面の画素（device pixel）。RGBA8、1 枚 256 KB。
- 鍵は `(page_id, zoom_key, tx, ty)`。`zoom_key` は、ズームが止まったときの倍率（f64 のビット列）。
- ズームの操作の途中は、新しいタイルを描かず、キャッシュにある最も近い倍率のタイルを拡大・縮小して見せる。操作が 120ms 止まったら、今の倍率で描き直す。
- パンでは、画面の外の 1 タイル分の縁を先に描く（アイドルの時間で）。

### 5.2 キャッシュと予算

- タイルのキャッシュは GPU のメモリで 256 MB（`navigator.deviceMemory` が 4 以下なら 128 MB）。1,024 枚（128 MB なら 512 枚）。2560×1440、DPR 2 の画面は 240 枚で埋まる。
- 捨てる順：今の倍率でない → 画面から遠い → 最後に見えた時刻が古い。
- 1 フレームで描くタイルは、時間の予算（15 節）の中で、画面の中心に近いものから。

### 5.3 1 枚のタイルの描き方

1. 部分木の境界の箱でタイルに重なるノードを、描く順に集める。
2. 集めたノードの描画の命令を、GPU の命令の列にする（パスの被覆率、塗り、テキスト、画像）。
3. エフェクト・ブレンド・マスクのあるノードは、オフスクリーンの層に描いて合成する（8 節）。
4. 背景のぼかし（background blur）とレイヤーのぼかしは、タイルの外の画素を要る。タイルの周りに `3σ` の縁を足して描き、中央を切り出す。

## 6. GPU の抽象とバックエンド

### 6.1 `gpu` のインターフェース

- エンジンは `gpu` の crate の型（`Device`、`Texture`、`Pipeline`、`Encoder`）だけを呼ぶ。実装は wgpu 30 系（30.0.1、2026-08-22）。lint で `web-sys` の WebGL・WebGPU の型を禁止する（ADR-0004）。
- 描画の呼び出しは、引数を明示する形：`encoder.draw(pipeline, target, bindings, uniforms, vertices)`。uniform は 1 つのバッファにまとめて書き、フレームの最後に 1 回で送る（本家の WebGPU 対応の `encodeDraw()` と `submit()` の形に倣う）。
- シェーダーは WGSL で 1 つに書く。WebGL2 では wgpu の naga が GLSL ES 3.00 に変換する。
- WebGL2 の制約（wgpu の `Limits::downlevel_webgl2_defaults()`：compute shader なし、storage buffer なし、uniform buffer 16 KiB、テクスチャの 1 辺の保証は 2048）の中で、すべての描画ができるようにする。実際の限界は、アダプターの値を読んで使う。
- WebGPU でだけ使う最適化（compute shader のぼかし、MSAA、RenderBundle）は、同じ結果を WebGL2 の経路でも出せるものに限り、後から足す。

### 6.2 バックエンドの選択と切り替え

[ADR-0014](../decisions/0014-gpu-backend-selection-and-fallback.md) で決めた。

| 場面 | 振る舞い |
| --- | --- |
| 起動 | ブロックリストに載っておらず、前のセッションで戻っていなければ、`wgpu::util::new_instance_with_webgpu_detection` で WebGPU を試す。使えなければ WebGL2 で始める |
| 起動の後 | アイドルの時間に互換性のテスト（参照の小さな場面を描き、既知の画素と比べる）を非同期で走らせる。読み戻しで起動を止めない |
| WebGPU の失敗 | `device.lost`、検証のエラー、互換性のテストの失敗で、WebGL2 に移る |
| WebGL2 のコンテキストの喪失 | 同じ WebGL2 で作り直す。5 分に 3 回を超えたら、描画を止めて再読み込みを案内する |

- 移るときは、`<canvas>` の要素を新しく作って差し替える。一度 `webgpu` のコンテキストを取ったキャンバスからは、`webgl2` のコンテキストを取れないため（HTML の `getContext` の規則）。
- GPU の資源（パイプライン、タイル、画像のテクスチャ、グリフのアトラス）はすべて捨てて作り直す。ドキュメントのモデルと未確定の変更は GPU と関係なく残る。
- 作り直すための元のデータは CPU の側に残す：画像は圧縮したバイト列（Cache Storage）、グリフはフォント、タイルは描き直す。
- 目標：切り替えから操作の再開まで 2 秒以内。その間は最後のフレームの画像を DOM の `<img>` で見せる。

## 7. パスの描画とアンチエイリアス

[ADR-0013](../decisions/0013-scene-graph-and-tile-rendering.md) で決めた。方式は Pathfinder 3 の「D3D9」の段（WebGL2 で動く、ハードウェアのラスタライズで面積の被覆率を求める形）と同じ系統である（[servo/pathfinder](https://github.com/servo/pathfinder)、2026-09-27 に確認）。

1. **平坦化（CPU）**：ベクターネットワークのセグメント（3 次ベジェ）を、画面の上の誤差 0.2 px 以内の線分にする。結果は倍率の段ごとにキャッシュする。
2. **線を塗りに（CPU）**：線（stroke）は、kurbo の線の展開で輪郭にしてから平坦化する。線の端・角の形、内側・中央・外側の線、破線をここで扱う。
3. **振り分け（CPU）**：線分を、タイルの中の 16×16 px の区画に振り分ける。完全に内側の区画（被覆率 1）は、線分を持たない「塗りつぶしの区画」にする。
4. **被覆率（GPU）**：区画ごとに、線分が各画素に与える符号付きの面積を、加算のブレンドで R16F のマスクに足す。
5. **塗り（GPU）**：マスクの値に塗りの規則（非ゼロ：`min(|w|, 1)`、偶奇：`1 - |1 - (|w| mod 2)|`）を当て、塗り（単色、グラデーション、画像）を掛けて合成する。

- アンチエイリアスは、画素ごとの面積の厳密な被覆率になる（MSAA の 4〜8 段より細かい）。細い線と、ほぼ水平な辺がきれいに出る。
- WebGL2 で R16F に描くには `EXT_color_buffer_float` が要る。wgpu の WebGL2 の経路で、R16F の加算のブレンドが使えるかは **未検証**。使えない端末では、同じ手順を RGBA8 の 4 チャンネルに固定小数点で分けて足す形にする。E2 の前の PoC で確かめる。
- ベクターネットワークの領域（region）の塗りは、領域ごとの輪郭を作って（editor-and-tools の 7 節）、非ゼロで塗る。
- 平坦化・振り分けの費用は、パスの点の数に比例する。1 ノードのセグメントの上限は、document-model の検証で持つ（14 節）。

Vello との関係：Vello GPU（旧 `vello_hybrid`、0.2.0、2026-08-07）は、CPU で前処理し GPU で描く「Sparse Strips」の方式で、compute shader なしで WebGL2 に対応した。ただし、マスクの層、複雑なフィルター、非分離のブレンドの一部は未対応で、呼ぶと panic する（[vello_gpu の README](https://github.com/linebender/vello/tree/main/vello_gpu)、2026-09-27 に確認）。WebGL2 には wgpu を通さない独自の経路を使う。このため、この方式を自前に持ち、Vello は参照の実装と比較の対象にする（16 節、20 節）。

## 8. 塗り・エフェクト・ブレンドモード・マスク

### 8.1 塗り

| 種類 | 描き方 |
| --- | --- |
| 単色 | uniform の色 |
| 線形・放射・角度・ダイヤモンドのグラデーション | 256×1 の色の帯のテクスチャ。1/255 の振幅の順序つきのディザを掛け、帯の段差を消す |
| 画像 | 10 節。塗りの形（fill・fit・crop・tile）と調整（露出、コントラスト、彩度、色温度、色合い、ハイライト、シャドウ）はシェーダーで当てる |

- 色は sRGB で扱い、合成も sRGB の値のまま行う（CSS と同じ）。Display P3 は MVP で扱わない。
- 1 つのノードの複数の塗りは、下から順に重ねる。

### 8.2 エフェクト

| エフェクト | 描き方 |
| --- | --- |
| ドロップシャドウ | 形のアルファを縮小したオフスクリーンに描き、広げ（spread）、ぼかし、ずらして、形の下に合成する。広げは、ベクターの形なら輪郭の外側への移動（オフセット）、それ以外はアルファのモルフォロジーの膨張で行う |
| インナーシャドウ | アルファを反転して同じ手順。形で切り抜く |
| レイヤーのぼかし | ノードをオフスクリーンに描き、ぼかして合成する |
| 背景のぼかし | ノードの下の画素（タイルの縁を含む）をコピーしてぼかし、ノードの形で切り抜いて合成する |

- ぼかしは、分離できるガウスのぼかしを 2 回（横と縦）。`σ` が画面の上で 8 px を超えたら、1/2 ずつ縮小してからぼかし、拡大する。1 回のぼかしのタップは 25 以内。
- ぼかしの値から `σ` への換算は `σ = 値 / 2` にする。本家の定義は **未検証** で、E2 で本家の書き出しと比べて合わせる。
- ぼかしの値は、document-model の検証で 0〜1,000 に制限する。描画は、画面の上の `σ` を 256 px で打ち切る。
- WebGPU では、ぼかしを compute shader にする最適化を後から足してよい（6.1 節の条件で）。

### 8.3 ブレンドモードと不透明度

- ブレンドモードは W3C Compositing and Blending Level 1 の 16 種（normal、darken、multiply、color-burn、lighten、screen、color-dodge、overlay、soft-light、hard-light、difference、exclusion、hue、saturation、color、luminosity）。本家が持つ他のモード（plus darker など）の有無と定義は **未検証**。
- normal 以外は、合成先の画素を読む。合成先の範囲をテクスチャにコピーし、シェーダーで式を当てる（固定のブレンドの機能では表せないため）。
- 不透明度が 1 未満か normal 以外のブレンドを持つフレーム・グループは、分離した層（オフスクリーン）に描いてから合成する。グループの既定の「pass through」は分離せず、子が直接その下に合成される。
- オフスクリーンの層は、1 タイルあたり入れ子 8 段まで。超えたら、深い段を 1 つの層にまとめて描く（見た目の差を許す。警告を記録する）。

### 8.4 マスクと切り抜き

- マスクのノードは、同じ親の中で自分より上（後に描く）の兄弟を覆う。種類はアルファ、ベクター（輪郭）、輝度。
- アルファ・輝度のマスクは R8 のテクスチャに描き、覆われる兄弟を 1 つの層に描いて掛け合わせる。ベクターのマスクは、7 節の被覆率のマスクをそのまま使う（層を作らない）。
- フレームの「内容を切り抜く」は、軸に平行で角の丸みがなければシザーで、それ以外は被覆率のマスクで行う。

## 9. テキストの描画

[ADR-0015](../decisions/0015-text-shaping-and-glyph-rendering.md) で決めた。改行と行の組み立ては [layout.md](layout.md) の 5 節にある。

### 9.1 部品

| 役割 | 部品 |
| --- | --- |
| フォントの解析・グリフの輪郭・カラーグリフ | Skrifa（0.47 系、2026-09-08） |
| 整形（shaping） | HarfRust（0.13.3、2026-08-25。HarfBuzz v14.3.1 に揃う。よく使うフォントで HarfBuzz より 25% 未満の遅さ。不正なフォントはエラーにする）（[harfbuzz/harfrust](https://github.com/harfbuzz/harfrust)） |
| 文字種の判定、改行の候補、書記素、双方向 | ICU4X（`icu_segmenter` 2.3 など） |

- rustybuzz は開発を終えてアーカイブされ、HarfRust への移行を勧めている（[harfbuzz/rustybuzz](https://github.com/harfbuzz/rustybuzz)、2026-09-27 に確認）。ADR-0004 も、統合の工程で HarfRust に直した。
- HarfRust はフォントの大きさを持たず、UnitsPerEm で返す。大きさの掛け算はこちらで f64 で行う（layout.md の 6 節の決定性）。

### 9.2 フォントの出どころと読み込み

- フォントの出どころ（同梱・組織・端末）、探す順（組織 → 同梱 → 端末）、配信は [export-and-assets.md](export-and-assets.md) の 7 節（ADR-0036）に従う。ノードは `font_family`・`font_style` の名前でフォントを指す（[document-model.md](document-model.md) の 9.5 節）。
- エンジンの中では、名前から解決したフォントのファイルを、中身の SHA-256（`font_blob_id`）で識別する。整形とアトラスのキャッシュの鍵はこの ID にする。
- 同梱と組織のフォントは、全員が同じバイト列を使うので、整形と改行の結果が全員で一致する（[layout.md](layout.md) の 6 節）。端末のフォント（Chromium の Local Font Access API）はその人の画面だけで使い、他の人とサーバーは保存された `derived_layout` で行の位置を合わせる（[layout.md](layout.md) の 4 節）。
- 読み込みの順：今のページのテキストが使うフォントを、ページのチャンクと並行して先に読む（NFR-003）。和文のフォントは 1 書体で数 MB あり、ファイル全体を読んで Cache Storage に持つ（分割しない。export-and-assets の 7.2 節）。
- フォントのバイト列は WASM のヒープに置き、11 節の 150 MB の予算に数える。超えたら、今のページで使っていないフォントから外す。

### 9.3 和文のフォールバック（グリフがないとき）

フォントそのものが見つからないときの代わりのフォント（和文を含むなら Noto Sans JP、それ以外は Inter）は export-and-assets の 7.5 節が決める。ここでは、見つかったフォントに、ある文字のグリフがないときの順を決める。

書記素クラスタごとに、次の順で、そのクラスタのすべての文字を `cmap` に持つ最初のフォントを使う。

1. ノードに指定したフォント
2. ファイルの設定の「和文のフォールバックのフォント」（既定は Noto Sans JP。同梱のフォントから選ぶ）
3. 記号・絵文字のフォント（同梱の COLRv1 のカラーの絵文字）
4. どれにもなければ、指定したフォントの `.notdef`（豆腐）

- 2 をファイルの設定にするのは、全員で同じフォントが選ばれるようにするため（端末ごとの既定に頼らない）。設定のプロパティは `DOCUMENT` の `cjk_fallback_font`（[document-model.md](document-model.md) の 4.2 節の 92）。
- フォールバックのフォントの太さは、指定の太さに最も近いもの（可変フォントなら `wght` の軸の値をそのまま）にする。
- 本家のフォールバックの順序は **未検証**。欧文のフォントに和文を打ったときの見え方を、E4 で本家と比べる。
- フォントの読み込みが終わるまで、そのテキストのノードは灰色の棒で描く。レイアウトは保存された大きさを使う（[layout.md](layout.md) の 6.4 節）。

### 9.4 グリフの描き方

- 画面の上の文字の大きさが 48 px 以下なら、グリフのアトラスで描く。超えたら、7 節のパスの描画で描く。
- アトラスは R8 の 2048×2048 のページで、最大 4 ページ（16 MB）。鍵は `(font_blob_id, glyph_id, 大きさ（1/4 px の刻み）, 横の端数の位置（1/4 px の 4 段）, 可変の軸の値のハッシュ)`。グリフは 7 節と同じ被覆率の計算を CPU で行ってラスタライズする。
- カラーのグリフ（COLRv1）は、Skrifa の塗りの木を、7〜8 節のパスとグラデーションの描画に変えて描く。48 px 以下は RGBA8 のアトラス（別のページ）に置く。Skrifa の COLRv1 の対応の範囲は **未検証**。
- ヒンティングはしない。ズームと書き出しで形が変わらないようにするため。Windows の OS の文字より細く見えうる。

## 10. 画像

- 画像は `Paint` の `image_hash`（中身の SHA-256）で指す。本体と縮小版（長辺 2048・512・128 px の WebP）は、アップロードの後に Worker が作る。取得は `images:sign` で署名付き URL を得て読む（[export-and-assets.md](export-and-assets.md) の 6 節、ADR-0035）。
- ファイルを開いたら、画面の上の大きさに足りる最も小さい縮小版（まず `w512`、小さく見える画像は `w128`）を読む。画面に見えていて解像度が足りない画像だけ、`w2048` か本体を読む（本家と同じ考え方）。
- `pending` の画像は灰色の置き場所、`rejected`・`taken_down`・10 分たっても `ready` にならない画像は「読み込めない画像」の印（灰色の斜線）で描く（export-and-assets の 6.2 節）。
- デコードは専用の Web Worker で行う。Rust のデコーダー（`png`、`zune-jpeg`、`image-webp`、GIF は最初のコマ）を小さな WASM にして動かす。ブラウザの `createImageBitmap` は使わない。ブラウザごとの色の扱いの差をなくし、Render Worker と同じ画素にするため。速さの差は **未検証**（E2 で測る）。
- デコードした画素（乗算済みの RGBA8）は、転送できる `ArrayBuffer` でメインスレッドに渡し、テクスチャに載せたら CPU の側のコピーを捨てる。圧縮したバイト列は Cache Storage に残す（6.2 節の作り直しのため）。
- ミップマップは、載せた後に GPU の縮小のシェーダーで作る（wgpu は自動で作らない）。
- アダプターのテクスチャの 1 辺の上限が 4,096 未満なら、2,048 の区画に分けて載せる。
- GPU の画像のメモリは 384 MB（`deviceMemory` が 4 以下なら 192 MB）。超えたら、最後に見えたのが古い高解像度の画像から捨て、`w512` に戻す。

## 11. メモリの予算

NFR-004（10 万ノードの参照ファイルで、タブのメモリ 1.5 GB 以内、80% で警告）を、次のように分ける。

| 部分 | 予算 | 置き場所 |
| --- | --- | --- |
| ドキュメントのモデル（10 万ノード） | 200 MiB（[document-model.md](document-model.md) の 10 節） | WASM のヒープ |
| インスタンスの導出とレイアウトのキャッシュ | 150 MB | WASM のヒープ（components・layout） |
| シーングラフとジオメトリのキャッシュ | 200 MB | WASM のヒープ。超えたら古い倍率の段のジオメトリから捨てる |
| テキストのレイアウトの結果 | 100 MB | WASM のヒープ |
| フォント | 150 MB | WASM のヒープ（読み込んだフォントのバイト列） |
| UI の殻（React）と JavaScript | 150 MB | JS のヒープ |
| 小計（CPU の側） | 950 MB | |
| タイル | 256 MB | GPU |
| 画像 | 384 MB | GPU |
| グリフのアトラス・オフスクリーンの層 | 80 MB | GPU |

- GPU のメモリがタブのメモリに数えられるかは、ブラウザと OS で違う（**未検証**）。計測の定義は quality.md で決める。ここでは CPU の側を 950 MB、GPU の側を 720 MB に抑えることを目標にする。
- WASM のメモリは 32 ビット（最大 4 GB）。Safari が memory64 に対応していないため（MDN の browser-compat-data、2026-09-27 に確認）、MVP は `wasm32` のままにする。
- メモリの使用量は 5 秒ごとに数え、1.2 GB（80%）を超えたら、UI の殻に警告を出す。キャッシュ（タイル、ジオメトリ、高解像度の画像）を捨てて、下げられるだけ下げる。

## 12. サーバーでの描画（ネイティブのビルド）

- どこで描くかは ADR-0034 で決まっている：画面からの書き出しはクライアントのエンジン、サムネイル・一括の書き出し・公開 API は Render Worker（[export-and-assets.md](export-and-assets.md) の 4.2 節、5 節）。
- Render Worker のために、同じ crate（`doc-model`・`layout`・`scene`・`raster`・`text`・`image`・`gpu`）を `x86_64-unknown-linux-gnu` にビルドし、`render-native` のバイナリにする。
- Fargate には GPU がない。wgpu の Vulkan のバックエンドを、Mesa の lavapipe（CPU で動く Vulkan の実装）の上で動かす。シェーダーとパイプラインは、ブラウザと同じ WGSL を使う（[ADR-0014](../decisions/0014-gpu-backend-selection-and-fallback.md)）。
- lavapipe の Vulkan の適合の版と、arm64 での動作は **未検証**。S1 では Render Worker を x86-64 に固定する。
- ラスターの書き出しは、1 枚のタイルの描き方（5.3 節）を、書き出しの範囲を覆うタイルの列で繰り返し、つなぐ。ズームの操作がないので、タイルのキャッシュは持たない。クライアントの書き出しも同じ手順で、オフスクリーンに描いて読み戻す。
- SVG・PDF は画素にしない。シーングラフの `draw_ops`（ジオメトリ、塗り、エフェクト、整形したグリフの列）を、export-and-assets の書き出し器に渡す。この領域は、描画の命令の列を安定した形で公開するだけにする。PDF を書く crate の候補（typst が使う `krilla` など）は **未検証** で、E10 の PoC で決める。
- 性能の目標（10 万ノードの参照ファイルのサムネイルを p95 10 秒）は export-and-assets の 5.1 節にあり、**未検証**。

## 13. 障害時の振る舞い

| 障害 | 振る舞い |
| --- | --- |
| WebGPU のデバイスの喪失・検証のエラー | 6.2 節のとおり WebGL2 に移る。記録（アダプターの情報、エラーの種類）を送る。ファイルの中身は送らない |
| WebGL2 のコンテキストの喪失 | 同じバックエンドで作り直す。5 分に 3 回を超えたら、描画を止めて再読み込みを案内する |
| シェーダーのコンパイルの失敗 | そのパイプラインを使う描画を、単純な代わり（エフェクトなし、単色）にする。WebGPU なら WebGL2 に移る |
| 1 フレームが 1 秒を超える状態が 3 回続く | 安全な描画の状態にする：ぼかし・影・背景のぼかしを止め、画像を `w512` にし、UI の殻に「表示を簡略化しています」を出す。原因のノードの ID と大きさだけを記録する |
| GPU のメモリの確保の失敗 | キャッシュを半分にして続ける。2 回続いたら安全な描画の状態にする |
| フォントの読み込みの失敗 | そのテキストをフォールバックのフォントで描き、「フォントがありません」を出す。レイアウトは仮のままにし、結果をファイルに書かない |
| 画像のデコードの失敗 | 画像の塗りを、壊れた画像の印（灰色の斜線）で描く |
| 1 回の submit の GPU の処理が長すぎる（ドライバのタイムアウトの恐れ） | 1 回の submit を、4 ms 相当の作業（タイルの数とパスの区画の数で見積もる）で区切る |

## 14. セキュリティ

描画の入力は、他の人が作ったファイル（信頼できない入力）である。共有のリンクで開いた人のタブを止める（DoS）ことや、デコーダー・フォントの解析の不具合を狙われうる。

| 入力 | 守り方 |
| --- | --- |
| ノードの木 | 深さ 256、子の数、NaN・無限大の拒否は document-model の検証で守る（4.4 節、11 節）。描画は、再帰でなく明示のスタックで辿る。世界座標が ±10^7 を超えるノードは描かない（f32 の精度が画素に足りないため） |
| ベクターのパス | `vector_network` は 1 MiB まで（document-model の 11 節）。平坦化の線分の数を、1 ノード 1,000,000 で打ち切り、超えたら粗い誤差で平坦化し直す |
| エフェクト | ぼかしの値の上限（8.2 節）、エフェクトの数の上限（1 ノード 16）、オフスクリーンの入れ子の上限（8.3 節） |
| 画像 | Rust のデコーダーで、Web Worker の中で解析する。デコードの前にヘッダーの大きさを読み、16,384 px または 2 億 6,800 万画素（16,384²）を超えたら拒否する。デコードの時間が 5 秒を超えたら Worker を終了する |
| フォント | Skrifa と HarfRust は Rust で書かれ、不正なフォントはエラーを返す。エラーのフォントはフォールバックに替える。組織のアップロードは、サーバーでも同じ検証を通す（export-and-assets） |
| GPU のドライバ | シェーダーは自分たちが書いたものだけ。ファイルの中身からシェーダーを作らない。ドライバの不具合で落ちる端末はブロックリストで WebGL2 に寄せる（ADR-0014） |

- 記録（ログ・トレース・メトリクス）には、ノードの ID と大きさだけを書く。ノードの名前、テキスト、画像、フォントの名前は書かない（AGENTS.md の規則）。
- `unsafe` は、`gpu` の crate のバッファの写しと、WASM と JavaScript の境界に限る（ADR-0001）。

## 15. 性能の予算

NFR-002（自分の入力を 1 フレームで）、NFR-003（開く時間）、NFR-004（メモリ）、NFR-005（パン・ズームのフレーム時間 p95 16.7ms）を、段ごとの予算に分ける。値は参照の端末（quality.md で決める）での目安で、E2 の計測で見直す。

| 段 | 予算（1 フレーム） | 関係する NFR |
| --- | --- | --- |
| 入力の適用（doc-model） | 1 ms | NFR-002 |
| レイアウトの増分（layout.md） | 2 ms | NFR-002 |
| シーングラフの更新 | 2 ms | NFR-002 |
| タイルの描画 | 6 ms（残りは次のフレーム） | NFR-002、NFR-005 |
| 合成と重ね描き（選択の枠、カーソル） | 1.5 ms | NFR-005 |
| UI の殻（React）の更新 | 3 ms（[editor-and-tools.md](editor-and-tools.md) の 11 節） | NFR-002 |
| 余裕 | 1.2 ms | |

| 場面 | 目標 | 関係する NFR |
| --- | --- | --- |
| 10 万ノードの参照ファイルのパン・ズーム | フレーム時間 p95 16.7 ms。チェッカーボードの代わりの古いタイルが見えるフレームは 5% 未満 | NFR-005 |
| 1 つのノードの移動（10 万ノードのファイル） | 入力から表示まで 1 フレーム | NFR-002 |
| 最初のページの最初の描画 | ページのデータが届いてから 500 ms 以内（フォントと `w512` の画像を含む） | NFR-003 |
| WASM のバイナリ | 圧縮後 5 MB 以内（ADR-0001。WebGPU と WebGL2 の両方を含めて） | NFR-003 |
| メモリ | 11 節 | NFR-004 |

## 16. テスト

### 16.1 参照画像のテスト（golden）

- 参照の場面の集合（塗り、線の端と角、グラデーション、ブレンドモード 16 種、影とぼかし、マスク 3 種、テキスト（欧文、和文、混植、絵文字）、画像の塗りの形、10 万ノードのファイル）を、次の 3 つで描く。
  1. ネイティブ（lavapipe）：CI の PR ごと。結果はビットで安定するので、参照画像との差を厳しく見る。
  2. Chromium の headless（WebGPU と WebGL2 の両方）：GPU 付きの VM で PR ごと。
  3. 実機の群れ（Chrome・Edge・Firefox・Safari、Windows・macOS、Intel・AMD・NVIDIA・Apple）：日次とリリースの前。
- 判定：チャンネルの差が 8/255 を超える画素が 0.1% 以下、かつ平均の差が 0.5/255 以下。値は E2 で、端末ごとの差を測って決め直す。
- 参照画像の更新は、差の画像を PR に添付し、Dev のレビューを要する。
- Vello CPU で同じ場面を描き、パスの被覆率の結果を比べる（別の実装との差分のテスト）。

### 16.2 性質ベーステスト

- 任意のパス（自己交差、重なった点、長さ 0 のセグメントを含む）で、被覆率が 0〜1 に収まり、NaN が出ない。
- 任意のパスで、CPU の被覆率（アトラスの経路）と GPU の被覆率の差が 1/255 以内。
- 任意の変更の列の後で、増分で更新したシーングラフと、一から作ったシーングラフが一致する（境界の箱、描く順）。
- 任意の変更で、無効にしたタイルの集合が、見た目の変わったタイルを必ず含む（増分の描画と一からの描画の画素が一致する）。

### 16.3 その他

- ファズ：画像のデコーダー、フォント（Skrifa・HarfRust の呼び出し）、ファイルの読み込みの解析（document-model と一緒に）。`cargo-fuzz` で日次。
- 障害注入：WebGPU のデバイスの喪失、WebGL2 のコンテキストの喪失（`WEBGL_lose_context`）を E2E で起こし、2 秒以内に描画が戻り、編集が失われないことを確かめる。
- 性能：本家と同じく、PR ごとに GPU 付きの VM の headless の Chromium で、10 万ノードの参照ファイルのパン・ズーム・選択・移動のフレーム時間を測る。前の版より 20% 以上遅くなったら落とす。参照の端末の実機で日次に測る。
- lint：`web-sys` の WebGL・WebGPU の型を使うコード、描画の crate での `f64::sin` などの標準の超越関数（layout.md の 6 節と同じ理由）、ログにノードの名前を書くコードを禁止する。

## 17. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0013](../decisions/0013-scene-graph-and-tile-rendering.md) | 描画用のシーングラフを別に持ち、256 px のタイルに描いてキャッシュする。パスは CPU で線分にし、GPU で面積の被覆率を求めてアンチエイリアスする | accepted |
| [0014](../decisions/0014-gpu-backend-selection-and-fallback.md) | 1 つのビルドに WebGPU と WebGL2 を入れ、WebGPU で始めて、失敗したらキャンバスを作り直して WebGL2 に移る。サーバーは lavapipe の上の wgpu で同じコードを動かす | accepted |
| [0015](../decisions/0015-text-shaping-and-glyph-rendering.md) | テキストは HarfRust・Skrifa・ICU4X で整形し、48 px 以下はグリフのアトラス、超えたらパスで描く。グリフのないときの和文のフォールバックはファイルの設定で決める。フォントの出どころは ADR-0036 に従う | accepted |

## 18. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり（E1 基盤とビルド、E2 描画エンジンと大きなファイル、E3 ドキュメントのモデルとマルチプレイヤー、E4 ベクターとテキストの編集、E5 フレームとオートレイアウト、E6 コンポーネントとバリアント、E7 保存と版の履歴、E8 コメントと通知、E9 チーム・権限・共有、E10 書き出しとアセット、E11 ファイルの一覧と検索、E12 運用と GA の準備）。

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `gpu-crate-skeleton` | `gpu` の crate の骨格と lint（`web-sys` の禁止）。WASM とネイティブの両方のビルド、バイナリの大きさの検査 |
| E1 | `golden-image-harness` | 参照画像のテストの仕組み（ネイティブの lavapipe、headless の Chromium の WebGPU・WebGL2）と、差の画像の PR への添付 |
| E2 | `gpu-backend-poc` | PoC：1 つのビルドでの WebGPU と WebGL2、キャンバスを作り直しての切り替え、R16F の加算のブレンド、WASM の大きさ（ADR-0014 の Confirmation） |
| E2 | `scene-graph` | `RenderNode`、dirty の伝播、部分木の境界の箱、子の R-tree、`ChangeSummary` からの更新 |
| E2 | `tile-cache` | タイルの描画とキャッシュ、ズームの途中の拡大・縮小、画面の外の先読み |
| E2 | `path-coverage-raster` | パスの平坦化・振り分け・被覆率・塗りの規則（7 節） |
| E2 | `paints-and-strokes` | 単色・グラデーション（ディザ）・線の展開・破線 |
| E2 | `gpu-backend-selection` | バックエンドの選択、起動の後の互換性のテスト、ブロックリストの取得、切り替えと作り直し |
| E2 | `image-decode-worker` | 画像のデコードの Worker、縮小版の読み分け、ミップマップ、GPU の画像のメモリの予算 |
| E2 | `render-memory-budget` | メモリの計測と警告、キャッシュの追い出し、安全な描画の状態 |
| E2 | `render-perf-ci` | 性能の CI（10 万ノードの参照ファイル、GPU 付きの VM）と実機の群れ |
| E4 | `text-shaping-and-glyphs` | 整形（HarfRust・Skrifa・ICU4X）、グリフのアトラス、大きな文字のパスの描画、和文のフォールバック、カラーの絵文字 |
| E4 | `effects-blend-masks` | ブレンドモード 16 種、影・ぼかし・背景のぼかし、マスク 3 種、内容の切り抜き |
| E5 | `layout-to-scene` | レイアウトの結果の受け取りとシーングラフへの反映（layout と一緒に） |
| E6 | `instance-rendering` | 導出したインスタンスの子を普通のノードとして描く（components と一緒に） |
| E9 | `viewer-rendering` | 閲覧だけの接続・共有のリンクでの描画（編集の UI なし）の確認 |
| E10 | `render-native` | lavapipe の上の wgpu のネイティブのビルド、ラスターの書き出しのタイルの列、SVG・PDF への描画の命令の公開（Render Worker は export-and-assets の `render-worker-core`） |
| E12 | `render-telemetry` | 描画のテレメトリー（フレーム時間、バックエンド、切り替えの回数、メモリ）と、ブロックリストの運用 |

E3・E7・E8・E11 には、この領域の Story はない。

## 19. quality.md・runbooks・data-model への項目

### quality.md

- 参照画像のテストの判定の値（16.1 節）と、参照の端末の一覧（GPU の種類、OS、ブラウザ）。export-and-assets の SC-6 の許容の値と同じものにする。
- 性能の予算（15 節）を E2 のリリースの基準にする。PR ごとの 20% の後退の検出。
- NFR-004 の「タブのメモリ」の測り方（GPU のメモリを数えるか）。
- 本番での検証：バックエンドごとのフレーム時間の p95、WebGPU → WebGL2 の切り替えの率、コンテキストの喪失の率、安全な描画の状態に入った率、メモリの警告の率を、ブラウザ・OS・GPU の別に日次で見る。

### runbooks

- `gpu-blocklist.md`：特定の GPU・ドライバで切り替えの率が急に上がったとき、ブロックリストに足して WebGL2 に寄せる手順（リリースなしで反映する）と、戻す手順。
- `browser-render-regression.md`：ブラウザの新しい版で描画が壊れたとの報告で、参照画像のテストをその版で流し、影響する端末をブロックリストで WebGL2 に寄せるか、エフェクトを止めるフラグを出す手順。
- `file-crashes-tab.md`：特定のファイルでタブが落ちるとの問い合わせで、安全な描画の状態の記録（ノードの ID と大きさ）から原因のノードを特定する手順。中身は見ない。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| ブラウザ Cache Storage | フォントと画像の圧縮したバイト列（鍵はハッシュ。export-and-assets の 6.4 節と同じ） |
| ブラウザ `localStorage` | 前のセッションのバックエンドと切り替えの理由（7 日で失効） |
| 配信する設定（フィーチャーフラグ） | GPU のブロックリスト：アダプターの vendor・architecture・description とブラウザの版の組 → 使うバックエンド |
| document-model のプロパティ | `DOCUMENT` のプロパティ `cjk_fallback_font`（92。scalar。フォントのファミリーとスタイルの名前。持ち主は rendering-engine）を統合の工程で登録した。`DOCUMENT` の色空間（Display P3）は MVP で足さない |

## 20. 未解決の問い

- パスの被覆率を、自前でなく Vello GPU（または Vello CPU）に任せられるか。マスクの層と非分離のブレンドへの対応、wgpu の WebGL2 の経路で動くか、を追う。
- Display P3 の色をいつ扱うか。本家の対応の範囲は未検証。
- 背景のぼかしを持つノードが多いファイルで、タイルの縁を足して描く方式の費用。
- 和文のフォントを分割して配るか（export-and-assets の 7.2 節で、MVP は分割しないと決まった）。E10 の計測で見直すとき、整形（GPOS の組の途切れ）への影響をこの領域で確かめる。
- WASM のスレッド（SharedArrayBuffer）で、タイルの描画の CPU の段を並列にするか。COOP・COEP のヘッダーと、画像・フォントの配信への `Cross-Origin-Resource-Policy` が要る。

### 決定（2026-09-27、既定案）

- **タイル**：256×256 の画面の画素。キャッシュは GPU で 256 MB（メモリの少ない端末は 128 MB）。
- **アンチエイリアス**：面積の被覆率（7 節）。MSAA は使わない。
- **テキスト**：48 px 以下はアトラス、超えたらパス。ヒンティングなし。
- **グリフのないときのフォールバック**：指定のフォント → ファイルの `cjk_fallback_font`（既定 Noto Sans JP）→ 絵文字 → `.notdef`。
- **ぼかし**：`σ = 値 / 2`。本家と E2 で比べて合わせる。
- **画像のデコード**：Rust のデコーダーを Web Worker で。`createImageBitmap` は使わない。
- **サーバーの描画**：Fargate の x86-64 で、lavapipe の上の wgpu。
- **スレッド**：MVP はメインスレッドの単一のスレッド＋メッセージで渡す Web Worker。SharedArrayBuffer は使わない。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| R16F の加算のブレンドが wgpu の WebGL2 で使えるか | E2 の前の PoC |
| 1 つのビルドでのキャンバスの作り直しによる切り替えと、WASM の大きさ | E2 の前の PoC。できなければ 2 つのビルド（ADR-0014 の 2） |
| 参照画像のテストの判定の値 | E2 で端末ごとの差を測って決める |
| lavapipe での書き出しの時間 | E10 の前に計測 |
| 本家のぼかしの定義、フォールバックの順序、ブレンドモードの種類 | E2・E4 で本家の書き出しと比べる |

## References

- Figma Blog: [Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/)（2015-12-07。2026-09-27 に確認）
- Figma Blog: [Figma is powered by WebAssembly](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/)（2017-06-08。2026-09-27 に確認）
- Figma Blog: [Keeping Figma Fast](https://www.figma.com/blog/keeping-figma-fast/)（2023-08-29。2026-09-27 に確認）
- Figma Blog: [Figma rendering: Powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)（2025-09-18。2026-09-27 に確認）
- 本題材の [export-and-assets.md](export-and-assets.md)（ADR-0034〜0036）、[document-model.md](document-model.md)、[components-and-libraries.md](components-and-libraries.md)
- Figma Help: [Image loading and performance](https://help.figma.com/hc/en-us/articles/360052988373-Image-loading-and-performance)、[Add images and videos to designs](https://help.figma.com/hc/en-us/articles/360040028034-Add-images-and-videos-to-designs)、[Reduce memory usage in files](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)（2026-09-27 に確認）
- wgpu: [docs.rs wgpu 30.0.1](https://docs.rs/wgpu/latest/wgpu/)、[`new_instance_with_webgpu_detection`](https://docs.rs/wgpu/latest/wgpu/util/fn.new_instance_with_webgpu_detection.html)、[`Limits`](https://docs.rs/wgpu/latest/wgpu/struct.Limits.html)、[gfx-rs/wgpu#6166](https://github.com/gfx-rs/wgpu/issues/6166)、[gfx-rs/wgpu#6371](https://github.com/gfx-rs/wgpu/pull/6371)（2026-09-27 に確認）
- MDN: [browser-compat-data](https://github.com/mdn/browser-compat-data)（`api/GPU.json`、`webassembly/memory64.json`。2026-09-27 に確認）
- [servo/pathfinder](https://github.com/servo/pathfinder)、[linebender/vello](https://github.com/linebender/vello)（vello_gpu 0.2.0、2026-08-07）、[nical/lyon](https://github.com/nical/lyon)、[linebender/kurbo](https://github.com/linebender/kurbo)（2026-09-27 に確認）
- [harfbuzz/harfrust](https://github.com/harfbuzz/harfrust)、[harfbuzz/rustybuzz](https://github.com/harfbuzz/rustybuzz)、[googlefonts/fontations（Skrifa）](https://github.com/googlefonts/fontations)、[unicode-org/icu4x](https://github.com/unicode-org/icu4x)（2026-09-27 に確認）
- W3C: [Compositing and Blending Level 1](https://www.w3.org/TR/compositing-1/)、[WebGPU](https://www.w3.org/TR/webgpu/)
- Mesa: [LLVMpipe](https://docs.mesa3d.org/drivers/llvmpipe.html)（2026-09-27 に確認。lavapipe の記述はない）

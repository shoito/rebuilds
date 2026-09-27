# Editor and tools: Figma

エディタの操作の設計。UI の殻（React）とエンジン（WASM）の境界、選択とヒットテスト、変形（移動・大きさ・回転）、スナップ、ペンとベクターネットワーク、ブール演算、テキストの編集と IME、キーボード操作とショートカット、アクセシビリティ、クリップボードを扱う。

| 関連 | 決定 |
| --- | --- |
| [ADR-0016](../decisions/0016-shell-engine-boundary.md) | エンジンと React は同じメインスレッドで動く。境界は、生成した型のコマンド（殻 → エンジン）と、フレームに 1 回まとめて出す話題ごとのスナップショット（エンジン → 殻）。キャンバスの入力はエンジンが直接受ける |
| [ADR-0017](../decisions/0017-text-input-via-hidden-textarea.md) | キャンバスの上のテキストの入力は、全ブラウザで隠した `textarea` で受ける。EditContext API は Firefox・Safari が対応するまで使わない |
| [ADR-0018](../decisions/0018-vector-networks-and-boolean-operations.md) | ベクターネットワークの編集はクライアントで計算し、ネットワーク全体を 1 つの値として書く。ブール演算の結果は保存せず、i_overlay の整数の計算で決定的に求める。平坦化（確定）だけ曲線を残す iCurve を使う |
| [ADR-0001](../decisions/0001-platform-and-stack.md) | UI の殻は TypeScript と React。エンジンとの型は Rust から生成する |
| [ADR-0012](../decisions/0012-multiplayer-undo-redo.md) | Undo は自分の変更を打ち消す新しい変更 |

描画は [rendering-engine.md](rendering-engine.md)、位置と大きさの計算（制約、オートレイアウト、テキストの折り返し）は [layout.md](layout.md)、変更の送受信と在席は [multiplayer.md](multiplayer.md)、ノードとプロパティは [document-model.md](document-model.md)、インスタンスの編集（上書き）は [components-and-libraries.md](components-and-libraries.md)、SVG の解析と画像のアップロードは [export-and-assets.md](export-and-assets.md) にある。

## 1. 目的と範囲

- 目的：デザイナーが、手元のアプリと同じ速さで、図形・パス・テキスト・フレームを作り、動かせる。自分の入力は 1 フレームで画面に出る（NFR-002）。日本語の IME での入力に重大な不具合がない（SC-5）。
- 範囲：UI の殻とエンジンの境界、ツール（移動、フレーム、セクション、矩形、楕円、線、矢印、多角形、星、ペン、テキスト、手のひら、コメントの置き場所）、選択、変形、スナップ、ベクターネットワークの編集、ブール演算、テキストの編集と IME、ショートカット、アクセシビリティ、コピーと貼り付け、SVG・画像の読み込みの操作。
- 範囲の外：パネルの見た目とデザインシステム（UI の殻の実装で決める）、コメントのスレッド（comments-and-notifications）、プロトタイピング、プラグイン、鉛筆のツール（MVP の後）。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 項目 | 本家 | 本システム |
| --- | --- | --- |
| パスの形 | ベクターネットワーク：点と点を、1 本の鎖でなく任意に線と曲線で結べる。囲まれた領域は自動で塗られ、塗りつぶしのツールで領域ごとに塗り・穴を切り替える。巻き数を利用者に意識させない。曲げのツールで曲線を直接引っ張る。曲線は 3 次ベジェ（[Introducing Vector Networks](https://www.figma.com/blog/introducing-vector-networks/)、2016-02-09） | 同じモデル（7 節） |
| 内部の作り | 独自の DOM・合成器・テキストのレイアウトのエンジンを持つ（[Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/)、2015-12-07） | 同じ考え方（エンジンの中） |
| テキストの入力の受け方（隠した `textarea`、`contenteditable`、EditContext のどれか） | 公開されていない（未検証） | 隠した `textarea`（9 節） |
| ショートカット | 本家の一覧はあるが、どこまで寄せてよいかは法務の確認待ち（[intent.md](../intent.md) の L6） | 10 節。一般的なデザインツールで共通のものに限る |
| キャンバスのアクセシビリティ（読み上げ） | 公開されていない（未検証） | 12 節 |

EditContext API の対応（MDN の browser-compat-data、2026-09-27 に確認）：Chrome・Edge 121 から。Firefox・Safari は未対応（実装の追跡：[Bugzilla 1904161](https://bugzil.la/1904161)、[WebKit 269922](https://webkit.org/b/269922)）。仕様は W3C の Editor's Draft（[EditContext API](https://w3c.github.io/edit-context/)）。

## 3. UI の殻とエンジンの境界

[ADR-0016](../decisions/0016-shell-engine-boundary.md) で決めた。

### 3.1 持ち分

| 持ち主 | 持つもの |
| --- | --- |
| エンジン（WASM） | `<canvas>`、キャンバスの上の pointer と wheel の入力、ツールの状態機械、選択、ヒットテスト、スナップ、変形、ペン、テキストの編集（カーソル、選択の範囲、IME の組み立て中の表示）、選択の枠・ガイド・他の人のカーソルの描画、`ChangeSet` の作成、Undo の履歴 |
| UI の殻（React） | ツールバー、レイヤーのパネル、プロパティのパネル、メニュー、ダイアログ、ファイルの一覧、コメントのパネル、ショートカットの表、隠した `textarea`（9 節）、読み上げの領域（12 節） |

- キャンバスの上の入力は、React を通さず、エンジンが `<canvas>` の要素のイベントを直接受ける（React の再描画の遅れを入力に混ぜない）。
- 殻は、ドキュメントのモデルを持たない。エンジンから受けたスナップショットだけを描く。

### 3.2 コマンド（殻 → エンジン）

```
enum Command {
  SetTool { tool: ToolId },
  SetProps { targets: Selection, prop: PropId, value: Value },   // プロパティのパネルの編集
  RunAction { action: ActionId },                                // ショートカット・メニュー（10 節）
  SelectNodes { ids: Vec<NodeRef>, mode: Replace | Add | Toggle },
  LayerRowsRequest { start: u32, count: u32 },                   // レイヤーのパネルの仮想化
  ToggleExpanded { id: NodeRef },
  SetViewport { .. }, Undo, Redo, Paste { payload }, ...
}
NodeRef = Node(NodeId) | Derived(InstanceSubId)                   // components の 3.3 節
```

- 型は Rust で定義し、TypeScript の型を生成する（document-model の表の生成と同じ仕組み。道具は delivery の領域で決める）。手で書き写さない。
- 呼び出しは同じスレッドの同期の関数呼び出し。値はコンパクトな二値にして渡す（JSON にしない）。

### 3.3 スナップショット（エンジン → 殻）

- エンジンは、描画を終えた後、フレームに 1 回、変わった**話題**（topic）だけの版の番号を上げる。

| 話題 | 中身 |
| --- | --- |
| `selection` | 選んだノードの数、種類、境界の箱 |
| `selection_props` | 選んだノードのプロパティの値。値が違えば `Mixed` |
| `layer_rows` | 要求された範囲の行（名前、種類、深さ、表示、ロック、展開、選択） |
| `tool` | 今のツールと状態（ペンの途中など） |
| `viewport` | ページ、ズーム、位置 |
| `text_edit` | 編集中のテキスト、カーソルの画面の位置（9 節の `textarea` の配置に使う） |
| `status` | 接続、未確定の件数、メモリの警告、描画の簡略化 |

- 殻は `useSyncExternalStore` で話題ごとに購読し、版が上がった話題の部品だけを再描画する。
- レイヤーのパネルは仮想化する。10 万ノードでも、画面に見える行（とその前後 50 行）だけをエンジンに求める。

### 3.4 1 フレームの流れ

1. ブラウザのイベント（pointer、key、`beforeinput`）は、エンジンの入力の列に積むだけにする。
2. `requestAnimationFrame` の最初に、列の入力をまとめて処理し、`ChangeSet` を作る（ドラッグの途中の移動は、1 フレームに 1 つ）。
3. レイアウト → シーングラフ → 描画（[rendering-engine.md](rendering-engine.md) の 3 節）。
4. 話題の版を上げる。React は同じフレームの残りで再描画する（11 節の予算）。

- `pointermove` は 1 フレームに何回も来る。処理はフレームに 1 回だけ。ペンと曲げのツールは、`getCoalescedEvents()` が使えるときは、まとめられた点をすべて使う。

## 4. 選択とヒットテスト

- ヒットテストは、シーングラフの索引を描く順の逆に辿る（[rendering-engine.md](rendering-engine.md) の 4.3 節）。
  - 塗りのある形は、平坦化した輪郭の内側か（巻き数、非ゼロ）。
  - 塗りのない線・細い形は、線から画面の上で 4 px 以内か。
  - テキストは、行の箱の中か。
  - ロックしたノード、非表示のノードは当たらない。
- 選ぶ単位：
  - クリック：ページの直下と、今入っているコンテナ（フレーム・グループ）の直下の子を選ぶ。
  - ダブルクリック：グループ・フレームの中に入る。テキストなら編集を始める。ベクターならパスの編集を始める。
  - Cmd（Windows は Ctrl）＋クリック：最も深いノードを直接選ぶ。
  - Shift＋クリック：選択に足す・外す。
  - 範囲の選択（マーキー）：今のコンテナの直下の子のうち、範囲に重なるもの。ページの直下のフレームは、完全に囲んだときだけ（中から始めたドラッグで外のフレームを選ばないため。本家との一致は **未検証**。E2 の `hit-test-and-selection` で本家と比べる）。
- インスタンスの中のノード（導出したノード）も選べる。選んだノードへの編集は、上書きの書き込みになる（[components-and-libraries.md](components-and-libraries.md) の 3.3 節、3.4 節の決定表で拒否されるものは、パネルで無効にする）。
- 選択は、自分のクライアントの状態で、ドキュメントに書かない。在席で他の人に送る（100 ノードまで。[multiplayer.md](multiplayer.md) の 12.1 節）。在席の `selection` は `NodeId` だけなので、導出したノードを選んでいるときは、そのインスタンスの ID を送る。
- 他の人が選んでいるノードには、その人の色の枠と名前の札を出す。

## 5. 変形（移動・大きさ・回転）

### 5.1 移動

- ドラッグの差を、親の座標に直して `transform` に足す。1 フレームに 1 つの `ChangeSet`。送信は multiplayer が 20Hz にまとめる（[multiplayer.md](multiplayer.md) の 4.5 節）。
- Shift：水平・垂直・45° に制限。Alt（Option）＋ドラッグ：複製して動かす。
- 矢印キー：1 px、Shift＋矢印：10 px（利用者の設定で変えられる）。
- **オートレイアウトの子**：ドラッグは並べ替えになる。主軸の上の兄弟の中点と比べて入る位置を決め、差し込みの線を出す。離したら `parent_index` を、前後の兄弟の鍵の間の鍵に書き換える（鍵の作り方は [multiplayer.md](multiplayer.md) の 5 節）。
- **親の付け替え**：ドラッグ中にポインタがフレームの中に入ったら、そのフレームの子にする（動かしているノードをヒットテストから除く）。Space を押している間は付け替えない。循環になる付け替えは、手元でも検証で弾く（document-model の 4.4 節）。
- ページの外への移動、ロックした親の中への移動はできない。

### 5.2 大きさ

- 選択の枠の 8 つの取っ手。Shift：縦横の比を保つ。Alt：中心から。
- 1 つのノード：`size` と `transform` を書く。フレームなら、子に制約を当てた結果も同じ `ChangeSet` に入れる（[layout.md](layout.md) の 8.1 節）。オートレイアウトの子の hug・fill は、手で大きさを変えたら fixed に変える。
- 複数のノード：選択の境界の箱を拡大・縮小し、各ノードの箱の位置と大きさを比で変える。回転したノードは回転を保ち、自分の軸の方向に大きさを変える（ゆがみ（skew）を作らない）。
- テキスト：`text_auto_resize` が `width_and_height` のとき、幅を変えたら `height` に変える。
- 大きさは 0.01 px 以上。0 を越えて反対へ引いたら、反転（負の拡大）ではなく、取っ手を入れ替える。

### 5.3 回転

- 取っ手の外側の角の近く（画面の上で 16 px 以内）でドラッグ。Shift：15° 刻み。
- 回転の中心は選択の境界の箱の中心。`transform` の行列に回転を掛ける（三角関数を使ってよい。編集の結果は入力として書くので、決定性は要らない。[layout.md](layout.md) の 6 節は計算の側の規則）。

### 5.4 画素への合わせ

- 利用者の設定「画素のグリッドに合わせる」（既定で有効）のとき、移動と大きさの結果の位置と大きさを 1 px に丸める。回転したノードは丸めない。

## 6. スナップ

- 動かしている選択の縦の 3 本（左・中央・右）と横の 3 本（上・中央・下）を、候補の線に合わせる。
- 候補：同じ親の兄弟（動かしているノードを除く）と親のフレームの端と中央。ページの直下なら、画面に見えるページの直下のノード。画面に近い順に 5,000 まで。
- ドラッグの始めに、候補の x の線と y の線をそれぞれ並べた配列を作る。毎フレーム、二分探索で、画面の上で 4 px 以内の最も近い線を探す。
- 等間隔：同じ行（交差軸で重なる）の兄弟の間隔を集め、動かしているノードと隣の間隔が、既存の間隔と 4 px 以内で等しければ合わせ、間隔の印を出す。
- 合った線と、合わせ先のノードの端を、赤い線で描く（選択の枠と同じ重ね描きの段。[rendering-engine.md](rendering-engine.md) の 3 節）。
- Ctrl（macOS は Cmd）を押している間はスナップしない。
- 予算：1 回の探索 1 ms 以内（候補 5,000）。

## 7. ペンとベクターネットワーク

[ADR-0018](../decisions/0018-vector-networks-and-boolean-operations.md) で決めた。

### 7.1 形

`vector_network`（document-model のプロパティ 40。1 MiB まで。全体が 1 つの競合の単位）：

```
VectorNetwork {
  vertices: [ { x: f32, y: f32, handle_mirroring: None | Angle | AngleAndLength, corner_radius: f32 } ],
  segments: [ { start: u32, end: u32, tangent_start: Vec2, tangent_end: Vec2 } ],   // 3 次ベジェ。接線が 0 なら直線
  regions:  [ { loops: [[u32]], winding_rule: NonZero | EvenOdd, fills: Option<Vec<Paint>> } ],
}
```

- 領域（region）は、辺の輪（loop）の集まり。領域ごとに塗りを持てる（`None` ならノードの `fills`）。
- 描画は、領域ごとに輪の辺をつないだ輪郭を作り、`winding_rule` で塗る。領域に入らない辺は線だけ描く（[rendering-engine.md](rendering-engine.md) の 7 節）。

### 7.2 ペンの状態機械

```
Idle ──クリック──▶ Drawing（点を置く。前の点から辺を引く）
Drawing ──ドラッグ──▶ 接線を対称に設定（Alt で対称を切る）
Drawing ──最初の点をクリック──▶ 輪を閉じ、領域を作る ──▶ Idle（選択のまま）
Drawing ──Enter / Esc──▶ 開いたまま終える ──▶ Idle
パスの編集 ──辺をクリック──▶ 辺を t で分割し、点を足す（de Casteljau）
パスの編集 ──Cmd＋辺をドラッグ──▶ 曲げ：ドラッグした点を通るように、辺の 2 つの接線を同じ比で変える
パスの編集 ──点を削除──▶ 次数 2 の点なら、両側の辺を 1 本につなぐ（外側の接線を残す）
```

- Shift：45° 刻みに制限。
- 領域の作り直し：辺を足す・消すと、領域を作り直す。各点で出ていく辺を接線の角度で並べ、面を辿って最小の輪を求める（辺の交差は分割しない。交差する輪は `winding_rule` で塗る）。前の領域の塗りは、前の領域の代表点（重心）を含む新しい領域に引き継ぐ。
- 編集の計算は、編集した人のクライアントだけで行い、結果の `vector_network` を書く。他の人は描くだけなので、計算の決定性は要らない。

### 7.3 大きなネットワークの送信

- 1 MiB のネットワークを 20Hz で送ると、1 セッションの送信の上限（毎秒 4 MiB。[multiplayer.md](multiplayer.md) の 4.6 節）を超える。
- 直列化の後で 64 KiB を超えるネットワークは、ドラッグの途中は 4Hz で送り、離したときに最後の値を送る。手元の画面は毎フレーム変わる。

## 8. ブール演算

- `BOOLEAN_OPERATION` のノードは、子（図形、ベクター、ブール演算）と `boolean_op`（和・差・積・排他）を持つ。子は編集できたまま残る（非破壊）。
- 結果の形は保存しない。子が変わったら、クライアントと Worker が計算し直す。
- 計算（[ADR-0018](../decisions/0018-vector-networks-and-boolean-operations.md)）：
  1. 子の輪郭を、ドキュメントの座標で誤差 1/64 px 以内の線分にする。
  2. 座標を 1/256 px の整数（i32）にする。
  3. i_overlay（9.0）の整数の演算で、和・差・積・排他を求める。
  4. 結果の多角形を、描画のパスとし、境界の箱を `derived_layout` にする（[layout.md](layout.md) の 8.2 節）。
- 整数の演算なので、WASM とネイティブで結果が一致する（レイアウトの決定性に効く）。
- ズームが 16 倍を超える画面では、描画のためだけに誤差を細かくして計算し直す（境界の箱には使わない）。
- 結果はノードごとにキャッシュする。1 回の計算が 20 ms を超えたら、ドラッグの途中は前の結果を動かして見せ、離したときに計算する。
- **平坦化（確定）**：ブール演算を 1 つの `VECTOR` に変える操作では、曲線を残すために iCurve（0.2、線・2 次・3 次ベジェ・楕円の弧のまま演算する）を使う。失敗したら i_overlay の結果を kurbo の曲線の当てはめ（`fit_to_bezpath`）で曲線に直す。iCurve の成熟度と、当てはめの品質は **未検証**（E4 の `boolean-operations` で参照の形で比べる）。
- **線のアウトライン化**：kurbo の線の展開で輪郭にし、i_overlay で和をとって `VECTOR` にする。

## 9. テキストの編集と IME

[ADR-0017](../decisions/0017-text-input-via-hidden-textarea.md) で決めた。

### 9.1 仕組み

- テキストの編集を始めると、殻が隠した `<textarea>` にフォーカスを移す。エンジンは、カーソルの画面の位置を `text_edit` の話題で渡す。
- `textarea` の置き方：
  - 位置：カーソルの行の左上に合わせる（IME の候補の窓がカーソルの近くに出るように）。
  - 文字の大きさ：画面の上の文字の大きさ（8〜64 px に丸める）。行の高さも合わせる。
  - 見えなくする：`color: transparent`、`caret-color: transparent`、`background: transparent`、枠なし、`resize: none`。`opacity: 0` と `display: none` は使わない（IME が候補の窓の位置を取れない端末がある。**未検証**。E4 の前の `ime-textarea-poc` で確かめる）。
- `textarea` の中身は、カーソルのある段落（2,000 文字まで）にし、選択の範囲も合わせる。IME の再変換（選んだ文字を変換し直す）と、前後の文脈による変換の精度のため。
- 添字の対応：`textarea` は UTF-16 の単位、`text_content` は UTF-8 のバイト。段落の先頭からの位置で変換する。

### 9.2 イベントの扱い

| イベント | 扱い |
| --- | --- |
| `beforeinput`（`insertText`、`insertLineBreak`、`deleteContentBackward`・`Forward`、`deleteWordBackward` など） | 既定の動作を止め（`preventDefault`）、エンジンがテキストのモデルに当てる。`textarea` の中身はエンジンの結果で書き直す |
| `compositionstart` | 組み立ての開始。選択の範囲を消して、組み立ての位置を覚える |
| `compositionupdate`・`input`（`isComposing`） | 組み立て中の文字列を、エンジンが下線付きで描く。ドキュメントには書かない |
| `compositionend` | 確定した文字列を、1 つの変更としてテキストのモデルに当てる |
| `keydown`（矢印、Home・End、PageUp・PageDown） | エンジンが、自分の行の組み立て（[layout.md](layout.md) の 5.2 節）でカーソルを動かす。`textarea` の行と一致しないため |
| `keydown`（`isComposing` か `keyCode === 229`） | ショートカットにも移動にも使わない（変換の確定の Enter で改行しない） |

- 組み立ての文節の区切り（どこを変換中か）は、`textarea` からは取れない。組み立て中の全体に 1 本の下線を引く。EditContext なら文節の書式を受け取れる（ADR-0017 で後回しにした理由のひとつ）。
- ブラウザごとの `compositionend` と `keydown` の順序の違い（Safari と Chromium で違うという報告がある。**未検証**）は、E4 の前の `ime-textarea-poc` で主要な組み合わせを記録し、`isComposing` と「直前に組み立てを終えた」印で吸収する。
- 確認する組み合わせ：macOS（日本語入力、Google 日本語入力、ATOK）× Chrome・Safari・Firefox、Windows（Microsoft IME、Google 日本語入力）× Chrome・Edge・Firefox。

### 9.3 同時の編集

- `text_content` は LWW の 1 つの単位（ADR-0002）。同じテキストを 2 人が同時に打つと、後に届いた方が勝つ。
- 他の人が同じテキストのノードを編集中（在席の `state = editing_text` で、`selection` にそのノード）なら、編集を始めるときに「〇〇さんが編集中です」を出す。止めはしない。
- 組み立て中の文字列はドキュメントに書かないので、他の人には確定した文字だけが見える。
- 打鍵の変更は、1 打鍵（または 1 確定）ごとに `ChangeSet` を作り、送信は multiplayer が 20Hz にまとめる。Undo の項目は、打鍵の区切り（1 秒の休み、カーソルの移動、書式の変更）でまとめる。

### 9.4 書式

- 範囲の書式（太さ、大きさ、色など）は `text_content` の `runs`（document-model の 4.2 節）。選択の範囲に書式を当てると、`runs` を分けて書き直す。
- フォントを変えるとき、フォントが読み込まれるまで、測定は「仮」になる（[layout.md](layout.md) の 6.4 節）。

## 10. キーボード操作とショートカット

### 10.1 仕組み

- ショートカットは殻の 1 つの表（`keymap`）で持つ。キーの組み合わせ → `ActionId`。エンジンへは `RunAction` で送る。修飾キーの状態（Shift、Alt、Cmd）は、pointer の入力と一緒にエンジンに渡す。
- 文字のキーは `KeyboardEvent.code`（物理の位置）で、記号のキー（`[`、`]`、`/` など）は `KeyboardEvent.key`（JIS 配列と US 配列で位置が違うため）で照らす。
- 次のときはショートカットを使わない：`textarea`・`input` にフォーカスがある（Esc と、Cmd の付いた一部を除く）、`isComposing`。
- macOS は Cmd、Windows は Ctrl。表示もそれぞれで出す。

### 10.2 既定の表（MVP）

一般的なデザインツールで共通の割り当てに限る。本家に固有の割り当てにどこまで寄せるかは、法務の確認（L6）の後に見直す。

| 操作 | キー |
| --- | --- |
| 移動・フレーム・矩形・楕円・線・ペン・テキスト・手のひら | `V`・`F`・`R`・`O`・`L`・`P`・`T`・`H` |
| 一時的に手のひら | Space を押している間 |
| 元に戻す・やり直す | Cmd＋Z、Cmd＋Shift＋Z |
| コピー・切り取り・貼り付け・複製 | Cmd＋C・X・V、Cmd＋D |
| 削除 | Delete、Backspace |
| グループ・解除 | Cmd＋G、Cmd＋Shift＋G |
| 前面へ・背面へ | Cmd＋]、Cmd＋[ |
| すべて選ぶ | Cmd＋A |
| 拡大・縮小・100% | Cmd＋＋、Cmd＋−、Cmd＋0 |
| 全体を表示・選択を表示 | Shift＋1、Shift＋2 |
| 選択を解く・コンテナから出る | Esc |

- 利用者が割り当てを変える機能は MVP で持たない。
- ショートカットの一覧のダイアログ（Cmd＋/）を持つ。

## 11. 性能の予算

| 場面 | 目標 | 関係する NFR |
| --- | --- | --- |
| 入力（pointer・key）から画面まで | 1 フレーム（16.7 ms）。サーバーを待たない | NFR-002 |
| ヒットテスト（10 万ノード） | 1 回 0.5 ms 以内 | NFR-002 |
| 1,000 ノードを選んだドラッグ | 毎フレーム、入力の処理とスナップで 3 ms 以内 | NFR-002、NFR-005 |
| スナップの探索 | 1 ms 以内（候補 5,000） | NFR-002 |
| React の再描画 | 1 フレームで 3 ms 以内（[rendering-engine.md](rendering-engine.md) の 15 節の予算）。超える部品は、話題を細かく分けるか、次のフレームに回す | NFR-002 |
| レイヤーのパネルのスクロール（10 万ノード） | 60fps。1 回の行の要求は 0.5 ms 以内 | NFR-005 |
| テキストの 1 打鍵（1 万字のノード） | 1 フレーム。その段落だけを整形し直す | NFR-002 |
| ブール演算の再計算（子 100、点 1 万） | 20 ms 以内（超えたら 8 節の遅延） | NFR-002 |

## 12. アクセシビリティ

- 殻（ツールバー、パネル、メニュー、ダイアログ）は WCAG 2.2 AA。レイヤーのパネルは `role="tree"` で、キーボードだけで選択・展開・名前の変更・並べ替えができる。
- キャンバスの要素は `role="application"` と `aria-roledescription="キャンバス"`。キャンバスにフォーカスがあるときのキー操作：
  - Tab・Shift＋Tab：同じ親の次・前の兄弟を選ぶ。
  - Enter：子に入る。Shift＋Enter：親へ出る。
  - 矢印：1 px 動かす。Shift＋矢印：10 px。
- 選択と変形の結果を、`aria-live="polite"` の領域で短く読み上げる（例：「矩形 1 を選択。幅 120、高さ 40」）。名前は利用者が付けたレイヤー名で、読み上げの領域の外（ログ）には出さない。
- テキストの編集中は `textarea` が実際の文字を持つので、スクリーンリーダーは段落を読める。キャンバスの上のすべてのテキストを DOM に写す仕組み（EditContext の仕様が勧める代わりの内容）は、MVP で持たない。
- 他の人のカーソルは色だけで区別しない（名前の札を付ける）。`prefers-reduced-motion` で、ズームとパンのアニメーションを止める。
- 選択の枠とガイドの色は、白と黒の背景のどちらでも 3:1 以上のコントラストにする。

## 13. クリップボードと取り込み

- コピー：選んだノードを document-model の形式で直列化し、次の 3 つをクリップボードに書く。
  1. `text/html`：独自のデータを `data-` の属性に base64 で埋めた要素（同じ製品の別のタブ・別のファイルへの貼り付け用）
  2. `image/png`：選んだノードの画像（他のアプリへの貼り付け用。[export-and-assets.md](export-and-assets.md) の 4.2 節のクライアントの書き出しで作る）
  3. `text/plain`：テキストのノードの文字
- 貼り付け：
  - 独自のデータ：復号し、`doc-model` の検証を通してから、新しい ID を振って作る（document-model の 6 節）。別の組織の画像は、組織ごとの重複の除去（export-and-assets の 6.2 節）のため、貼り付けたクライアントが画像を読み、自分の組織に上げ直す。
  - SVG（`image/svg+xml`、SVG の文字列）：export-and-assets の 11 節の解析器で取り込み、`VECTOR`・`FRAME`・`TEXT` に変える。
  - 画像：export-and-assets の 6.2 節のアップロード。
  - 文字：テキストのノードを作る（編集中なら挿入）。
- ファイルのドラッグ＆ドロップも、貼り付けと同じ経路にする。
- 独自のデータの MIME（Async Clipboard API の `web ` で始まる独自の形式）は、Chrome・Edge 104 からで、Firefox はプレビューだけ、Safari は未対応である（MDN の browser-compat-data の `api/ClipboardItem.json` の `type_web`、2026-09-27 に確認）。MVP は `text/html` に埋める形だけにする。

## 14. 障害時の振る舞い

| 障害 | 振る舞い |
| --- | --- |
| エンジンの panic（WASM の trap） | panic の hook で、ノードの ID と場所だけを記録する。殻は「エラーが起きました。再読み込みします」を出す。送った変更は、サーバーが確定したものは残る。送る前の最大 1 フレーム分の編集は失われうる |
| 自分の変更の拒否（`Reject`） | 画面を戻し（[multiplayer.md](multiplayer.md) の 7 節）、理由を短く出す（例：「この移動は、親子の関係が循環するためできません」） |
| 編集の権限を失った（`RoleChanged(view)`） | ツールを移動に戻し、編集の UI を無効にする。編集中のテキストは確定せず閉じる |
| IME の組み立て中に、他の人がそのテキストのノードを消した | 組み立てを取り消し（`textarea` の blur）、「テキストが削除されました」を出す |
| React の部品の例外 | その部品のエラーの境界で、パネルだけを出し直す。エンジンとキャンバスは続ける |
| 描画の簡略化（[rendering-engine.md](rendering-engine.md) の 13 節） | `status` の話題で、殻が帯を出す |

## 15. セキュリティ

- レイヤー名・テキストは、React のテキストとして描く。`dangerouslySetInnerHTML` と `innerHTML` を使わない（lint）。
- 貼り付けの HTML は、独自のデータの属性だけを読み、HTML として DOM に入れない。独自のデータは、他の人が作ったもの（信頼できない入力）として、復号の上限と `doc-model` の検証を通す。
- SVG は export-and-assets の解析器だけで読み、DOM に入れない。
- ショートカットは、`input`・`textarea` の中で発火しない（入力の横取りと、誤操作の防止）。
- 読み上げの領域とエラーの記録に、レイヤー名・テキストを出さない（記録は ID と数だけ）。
- 閲覧の権限の人には、編集のツールを出さない。出しても、サーバーの検証で拒否される（UI は守りにしない）。

## 16. テスト

### 16.1 性質ベーステスト

| ID の案 | 性質 |
| --- | --- |
| PROP-EDIT-001 | 任意の操作の列（移動、大きさ、回転、グループ、並べ替え、付け替え）の後、ドキュメントの不変条件（document-model の 5 節）が成り立つ |
| PROP-EDIT-002 | 任意の操作の列を Undo で全部戻すと、自分の変更の前の状態に戻る（他の人の変更がないとき） |
| PROP-EDIT-003 | 任意のベクターネットワークの編集（点の追加・削除、辺の分割、曲げ）の後、辺の端の添字が範囲の中にあり、領域の輪が閉じている |
| PROP-EDIT-004 | 任意の多角形の組で、ブール演算の結果が WASM とネイティブで一致する。和は両方の子を含み、積はどちらにも含まれる（整数の座標で） |
| PROP-EDIT-005 | 任意の段落と UTF-16 の位置で、`textarea` の位置 ↔ `text_content` の位置の変換が往復で一致する（サロゲートペア、結合文字を含む） |
| PROP-EDIT-006 | 任意のスナップの候補の集合で、選んだ線が、4 px 以内で最も近いものである（全探索と一致） |

### 16.2 IME と入力

- Playwright で、`compositionstart`・`update`・`end` の列を合成して流すテスト（Chromium・Firefox・WebKit）。
- 9.2 節の組み合わせの手動の確認を、E4 のリリースの前と、ブラウザの大きな版の更新のたびに行う。確認の手順は quality.md に置く。
- 実機の IME での自動のテストは、OS の入力の注入（macOS の `CGEvent`、Windows の `SendInput`）で、最低限の「ひらがなを入力 → 変換 → 確定」を毎日流す（仕組みは **未検証**。E4 の前の `ime-textarea-poc` で作れるか確かめる）。

### 16.3 その他

- 決定表：4 節の選ぶ単位（クリック、ダブルクリック、Cmd、Shift、マーキー × コンテナの種類 × ロック・非表示）。10.1 節のショートカットの発火の条件（フォーカスの先 × `isComposing` × 修飾キー）。
- E2E：図形を作る、ペンで閉じたパスを作り領域を塗る、ブール演算、テキストの入力（IME の合成）、オートレイアウトの並べ替え、コピーと貼り付け、2 つのブラウザでの同時の編集。
- a11y：`@axe-core/playwright` で殻を検査する。VoiceOver と NVDA で、レイヤーのパネルとキャンバスのキー操作を手動で確かめる。
- 性能：11 節の場面を、[rendering-engine.md](rendering-engine.md) の 16.3 節と同じ仕組み（GPU 付きの VM、20% の後退で落とす）で測る。

## 17. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0016](../decisions/0016-shell-engine-boundary.md) | エンジンと React は同じメインスレッドで動かし、生成した型のコマンドと、フレームに 1 回の話題ごとのスナップショットでやり取りする | accepted |
| [0017](../decisions/0017-text-input-via-hidden-textarea.md) | キャンバスの上のテキストの入力は、全ブラウザで隠した `textarea` で受ける。EditContext は Firefox・Safari の対応を待つ | accepted |
| [0018](../decisions/0018-vector-networks-and-boolean-operations.md) | ベクターネットワークの編集は編集した人が計算して全体を書く。ブール演算の結果は保存せず、i_overlay の整数の演算で求め、平坦化だけ iCurve で曲線を残す | accepted |

## 18. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり。

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `shell-engine-bridge` | コマンドと話題の型の生成、同期の呼び出し、`useSyncExternalStore` の購読、エンジンの panic の hook |
| E2 | `canvas-input-loop` | 入力の列と `requestAnimationFrame` での処理、パンとズーム、手のひら |
| E2 | `hit-test-and-selection` | 4 節のヒットテストと選ぶ単位、選択の枠の描画 |
| E2 | `move-resize-rotate` | 5 節の変形（オートレイアウトの並べ替えと付け替えを除く） |
| E2 | `basic-shape-tools` | 矩形・楕円・線・矢印・多角形・星・フレーム・セクションのツール |
| E3 | `remote-selection-and-cursors` | 他の人の選択の枠と名前の札（multiplayer の在席と一緒に） |
| E4 | `snapping` | 6 節のスナップと等間隔、画素への合わせ |
| E4 | `pen-and-vector-network` | 7 節のペン、点・辺の編集、曲げ、領域の作り直し、大きなネットワークの送信 |
| E4 | `boolean-operations` | 8 節の非破壊のブール演算、平坦化、線のアウトライン化 |
| E4 | `ime-textarea-poc` | 9 節の PoC：`textarea` の置き方、見えなくし方、イベントの順序の記録（E4 の前） |
| E4 | `text-editing` | カーソル・選択・書式・行の移動、IME の組み立ての表示、同時の編集の知らせ |
| E4 | `keymap-and-shortcuts` | 10 節の表と発火の条件、一覧のダイアログ（L6 の確認の後に承認） |
| E4 | `layers-panel` | 仮想化したレイヤーのパネル、キーボード操作、名前の変更、並べ替え |
| E4 | `properties-panel` | 選択のプロパティ、`Mixed` の表示、`SetProps` |
| E4 | `clipboard` | 13 節のコピーと貼り付け、ドラッグ＆ドロップ、SVG と画像の取り込みの操作 |
| E4 | `canvas-a11y` | 12 節のキャンバスのキー操作と読み上げ、axe の検査 |
| E5 | `auto-layout-drag-reorder` | オートレイアウトの子のドラッグでの並べ替えと、差し込みの線（layout と一緒に） |
| E5 | `resize-with-constraints` | フレームの大きさの変更で制約を当てる（layout の `constraints-on-resize` と一緒に） |
| E6 | `edit-derived-nodes` | 導出したノードの選択と、上書きの書き込みへの変換（components と一緒に） |
| E9 | `viewer-mode-ui` | 閲覧の権限での UI（編集のツールを出さない）、`RoleChanged` への対応 |
| E12 | `editor-telemetry` | 入力から描画までの時間、React の再描画の時間、IME のイベントの異常（順序の食い違い）の件数 |

E7・E8・E10・E11 には、この領域の Story はない（E8 のコメントの置き場所のツールは comments-and-notifications が持つ）。

## 19. 未解決の問い

- EditContext をいつ使うか。Firefox・Safari が対応したら、文節の表示と候補の窓の位置の精度のために切り替えを検討する。
- キャンバスの上のテキストを、スクリーンリーダーのために DOM に写すか（今のフレームだけ、など）。
- ショートカットと操作を本家にどこまで寄せるか（法務の L6）。
- 在席の `selection` で、導出したノード（`InstanceSubId`）を送れるようにするか（multiplayer と相談）。
- 独自のクリップボードの形式（web の独自の MIME）を使うか。
- エンジンを Web Worker（OffscreenCanvas）に移して、React とメインスレッドを分けるか（ADR-0016 の見直しの条件）。

### 決定（2026-09-27、既定案）

- **スレッド**：エンジンと React は同じメインスレッド（ADR-0016）。
- **IME**：全ブラウザで隠した `textarea`。中身はカーソルのある段落（2,000 文字まで）（ADR-0017）。
- **テキストの同時の編集**：止めずに「編集中です」を知らせる。LWW のまま。
- **ブール演算の結果**：保存しない。i_overlay の整数の演算（ADR-0018）。
- **スナップ**：画面の上で 4 px。候補は 5,000 まで。
- **ショートカット**：一般的なデザインツールで共通の割り当てだけ。割り当ての変更は MVP で持たない。
- **ページの直下のフレームのマーキー**：完全に囲んだときだけ選ぶ。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| `textarea` の見えなくし方と、ブラウザ・IME ごとのイベントの順序 | E4 の前の PoC（`ime-textarea-poc`） |
| iCurve の平坦化の品質 | E4 の前に参照の形で比べる |
| 実機の IME の自動のテストの作り方 | E4 の前に確かめる |
| 本家との細部の一致（マーキー、ダブルクリックの入り方） | E4 で比べる。L6 の結論に従う |

## 20. quality.md・runbooks・data-model への項目

### quality.md

- SC-5（IME の重大な不具合 0 件）の確認の手順：9.2 節の OS × IME × ブラウザの組み合わせの手動の確認表と、合成のイベントの自動のテスト。ブラウザの大きな版の更新のたびに流す。
- PROP-EDIT-001〜006 を E4 のリリースの基準にする。
- 性能の予算（11 節）を E4 のリリースの基準にする。入力から描画までの p95 を RUM で見る。
- a11y：殻は WCAG 2.2 AA（axe と手動）。キャンバスは 12 節の範囲（キー操作と読み上げ）を手動で確かめる。
- 本番での検証：入力から描画までの時間の p95、React の再描画が 3 ms を超えたフレームの割合、エンジンの panic の件数、IME のイベントの順序の食い違いの件数を、ブラウザ・OS の別に日次で見る。

### runbooks

- `ime-regression.md`：ブラウザや OS の更新で IME の不具合が報告されたとき、組み合わせを絞り込み、PoC の記録と比べ、回避のフラグ（`compositionend` の扱いの切り替え）を出す手順。
- `engine-panic-spike.md`：エンジンの panic の急増で、版・ブラウザ・場所（ID と場所だけ）で絞り、前の版に戻すか判断する手順。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `global.user_preferences` | `account_id`、`nudge_small`、`nudge_large`、`snap_to_pixel_grid`、`snapping_enabled`、`updated_at`。組織をまたぐ利用者の設定なので `org_id` を持たない。`global` スキーマに置き、`account_id` で絞る関数を通して読む（統合の工程で決めた。[data-model.md](data-model.md) の 3.2 節） |
| document-model のプロパティの表 | `vector_network` の形（7.1 節）。領域ごとの `fills` を含める |
| ブラウザ `localStorage` | 最後に使ったツール、パネルの幅と開閉（利用者の端末だけ） |

## References

- Figma Blog: [Introducing Vector Networks](https://www.figma.com/blog/introducing-vector-networks/)（2016-02-09。2026-09-27 に確認）
- Figma Blog: [Building a professional design tool on the web](https://www.figma.com/blog/building-a-professional-design-tool-on-the-web/)（2015-12-07。2026-09-27 に確認）
- W3C: [EditContext API](https://w3c.github.io/edit-context/)（Editor's Draft。2026-09-27 に確認）
- MDN: [EditContext API](https://developer.mozilla.org/en-US/docs/Web/API/EditContext_API)、[browser-compat-data の `api/EditContext.json`](https://github.com/mdn/browser-compat-data)（2026-09-27 に確認）
- [iShape-Rust/iOverlay](https://github.com/iShape-Rust/iOverlay)（i_overlay 9.0.0、2026-09-19）、[iShape-Rust/iCurve](https://github.com/iShape-Rust/iCurve)（i_curve 0.2.0、2026-09-19）、[linebender/kurbo](https://github.com/linebender/kurbo)（0.13.1。`fit_to_bezpath_opt` は実験的）（2026-09-27 に確認）
- W3C: [WCAG 2.2](https://www.w3.org/TR/WCAG22/)、[Input Events Level 2](https://www.w3.org/TR/input-events-2/)、[UI Events](https://www.w3.org/TR/uievents/)

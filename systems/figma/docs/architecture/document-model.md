# Document model: Figma

ファイルの中身（ノードの木）の形。ノードの種類、プロパティの表、ID、木の不変条件、変更の単位、直列化の形式を決める。

前提となる決定は、`doc-model` の crate をクライアントとサーバーで共有すること（[ADR-0001](../decisions/0001-platform-and-stack.md)）、プロパティ単位の LWW と分数インデックスと循環の拒否（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md)）、ジャーナルとチェックポイント（[ADR-0003](../decisions/0003-journal-and-checkpoints.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-node-types-and-property-table.md) | ノードの種類とプロパティを 1 つの表（スキーマ）で定義し、競合の単位・検証・持ち主の領域を表に書く。表からコードを生成する |
| [0007](../decisions/0007-node-ids-and-tree-invariants.md) | ノードの ID は `(session_id: u32, local_id: u32)`。`session_id` はファイルごとにサーバーが振り、ジャーナルに記録してから渡す。木の不変条件は `doc-model` の検証器だけで確かめる |
| [0008](../decisions/0008-canonical-binary-serialization.md) | 変更・チェックポイント・通信は、表から生成する自前のスキーマ付きバイナリ（タグ付き・正準形）で表す。ページ単位に分け、zstd で圧縮する |

## 1. 目的と範囲

- 扱う：ノードの種類、プロパティの表、ID、変更の操作（`create`・`set`・`delete`）、木の不変条件と検証、メモリの上の持ち方、直列化の形式、大きさの上限、他の領域とのインターフェース。
- 扱わない：変更の送受信と競合の解き方（[multiplayer.md](multiplayer.md)）、永続化と版（[file-storage-and-history.md](file-storage-and-history.md)）、描画（[rendering-engine.md](rendering-engine.md)）、レイアウトの計算（[layout.md](layout.md)）、コンポーネントの上書きの意味（[components-and-libraries.md](components-and-libraries.md)）、権限の判定（[permissions-and-sharing.md](permissions-and-sharing.md)）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 文書の形 | `Map<ObjectID, Map<Property, Value>>` の 2 段の対応。木は、親の参照をプロパティとして持つ（[How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)、2019-10-16） | 同じ。親と位置を `parent_index` の 1 つのプロパティにする（ADR-0002） |
| ID | クライアントごとの ID を ID に含め、サーバーを待たずに作る（同上） | `(session_id, local_id)`（ADR-0007） |
| 変更の単位 | プロパティの値の境界で原子的。テキストの同時の編集は合わさらない（同上） | 同じ。値が別々に編集されうるものは、別のプロパティか Map の要素に分ける（ADR-0006） |
| 並び | 0 と 1 の間の分数。任意精度を文字列で持つ（[Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/)、2017-03-06） | base-62 の可変長の鍵（ADR-0010） |
| 直列化 | 本家の形式は非公開。本家の CTO が作ったスキーマ付きバイナリの Kiwi がある（[evanw/kiwi](https://github.com/evanw/kiwi)）。本家のファイルが Kiwi を使うかは、公式の資料で確かめられなかった（**未検証**） | Kiwi に近い考え方の自前の形式（ADR-0008） |
| ページ | ページとレイヤーを必要なときに読む（[Reduce memory usage in files](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)） | ページ単位のチャンク（8 節、[file-storage-and-history.md](file-storage-and-history.md)） |

いずれも 2026-09-27 に確認。

## 3. ノードの種類

`NodeType` は `u8` の列挙。番号は一度振ったら変えない。

| 種類 | 親になれる種類 | 子になれる種類 | MVP | 持ち主の領域 |
| --- | --- | --- | --- | --- |
| `DOCUMENT` | なし（根） | `CANVAS` | ○ | document-model |
| `CANVAS`（ページ） | `DOCUMENT` | 下の「レイヤー」すべて | ○ | document-model |
| `FRAME` | `CANVAS`・`FRAME`・`GROUP`・`SECTION`・`COMPONENT` | レイヤー | ○ | layout |
| `GROUP` | `FRAME` と同じ | レイヤー（1 つ以上） | ○ | editor-and-tools |
| `SECTION` | `CANVAS`・`SECTION` | レイヤー | ○ | editor-and-tools |
| `RECTANGLE`・`ELLIPSE`・`POLYGON`・`STAR`・`LINE` | レイヤーを持てる種類 | なし | ○ | editor-and-tools |
| `VECTOR` | 同上 | なし | ○ | editor-and-tools |
| `TEXT` | 同上 | なし | ○ | editor-and-tools |
| `BOOLEAN_OPERATION` | 同上 | 図形・`VECTOR`・`BOOLEAN_OPERATION`（1 つ以上） | ○ | editor-and-tools |
| `COMPONENT` | `CANVAS`・`FRAME`・`SECTION`・`COMPONENT_SET` | レイヤー | ○ | components |
| `COMPONENT_SET` | `CANVAS`・`FRAME`・`SECTION` | `COMPONENT` だけ | ○ | components |
| `INSTANCE` | レイヤーを持てる種類 | なし（中身は元のコンポーネントから作る。9.3 節） | ○ | components |
| `SLICE` | レイヤーを持てる種類 | なし | ○ | export-and-assets |
| （予約）`STICKY`・`CONNECTOR`・`SHAPE_WITH_TEXT` など | — | — | MVP の後（ホワイトボード） | — |

- 「レイヤー」は `CANVAS`・`DOCUMENT` 以外の種類。「レイヤーを持てる種類」は `CANVAS`・`FRAME`・`GROUP`・`SECTION`・`COMPONENT`。
- 種類は作った後に変えない。「フレームに変える」などの操作は、新しいノードを作って子を移し、元を消す変更の集まりにする。種類の変更を LWW にすると、種類ごとのプロパティの組み合わせが壊れるため。
- 親子の組み合わせの表は、`doc-model` の表（ADR-0006）に置き、クライアントとサーバーの検証の両方が使う。

## 4. プロパティの表

### 4.1 表の列

プロパティは 1 つの表（`schema/properties.toml`、開発リポジトリ）で定義し、Rust の型・TypeScript の型・直列化のコード・検証のコードを生成する（ADR-0006）。

| 列 | 意味 |
| --- | --- |
| `id` | `u16`。一度振ったら変えない。消したプロパティの番号は再利用しない |
| `name` | `snake_case` の名前 |
| `type` | 値の型（4.3 節） |
| `kind` | `scalar`（値全体が競合の単位）か `map`（要素の鍵ごとが競合の単位） |
| `node_types` | このプロパティを持てるノードの種類 |
| `default` | 既定値。既定値と同じ値は直列化で省く |
| `validate` | 範囲・長さ・形式（4.4 節） |
| `derived` | 他のプロパティから計算される値か（レイアウトの結果など。9.2 節） |
| `owner` | 定義に責任を持つ領域（document-model、layout、components など） |
| `since` | 追加した形式の版（8.4 節） |
| `public_api`・`api_name`・`api_since` | 公開 API のノードの JSON に出すか、JSON の鍵、出した API の版（[api-and-webhooks.md](api-and-webhooks.md) の 4.1 節、ADR-0042）。既定は出さない |
| `public_plugin` | プラグインの API に出すか（[plugins.md](plugins.md) の 5.5 節、ADR-0038）。既定は出さない。`derived` のプロパティの書き込みは出さない |

**競合の単位の規則**（本題材の AGENTS.md）：1 つのプロパティに、別々に編集されうる値を詰め込まない。別々に編集されうるなら、別のプロパティにするか、`map` にする。

### 4.2 MVP のプロパティ（抜粋）

完全な表は開発リポジトリの `schema/properties.toml` を正とする。ここでは競合の単位の決め方が分かる代表を挙げる。

| id | name | type | kind | 持てる種類 | 備考 |
| --- | --- | --- | --- | --- | --- |
| 1 | `parent_index` | `ParentIndex { parent: NodeId, key: OrderKey }` | scalar | `DOCUMENT` 以外 | 親と位置を 1 つの単位にする（ADR-0002） |
| 2 | `name` | `String`（1〜512 バイト） | scalar | すべて | |
| 3 | `visible` | `bool` | scalar | レイヤー | |
| 4 | `locked` | `bool` | scalar | レイヤー | |
| 5 | `transform` | `Affine2x3 (f32×6)` | scalar | レイヤー | 親に対する変換。移動と回転は同じ単位（同時に別の人が移動と回転をすると片方が勝つ） |
| 6 | `size` | `Vec2 (f32×2)` | scalar | レイヤー | 幅と高さは同じ単位 |
| 7 | `opacity` | `f32`（0〜1） | scalar | レイヤー | |
| 8 | `blend_mode` | `BlendMode (u8)` | scalar | レイヤー | |
| 9 | `fills` | `Vec<Paint>`（最大 32） | scalar | 図形・フレーム・テキスト | 塗りの配列は 1 つの単位。本家も配列ごとに置き換える（**未検証**） |
| 10 | `strokes` | `Vec<Paint>`（最大 32） | scalar | 同上 | |
| 11 | `stroke_weight` | `f32` | scalar | 同上 | |
| 12 | `stroke_align`・`stroke_cap`・`stroke_join`・`dash_pattern` | 各 1 つ | scalar | 同上 | それぞれ別の単位 |
| 13 | `corner_radius` | `CornerRadii (f32×4)` | scalar | 矩形・フレーム・コンポーネント | 四隅は同じ単位 |
| 14 | `effects` | `Vec<Effect>`（最大 16） | scalar | レイヤー | 影・ぼかし |
| 15 | `is_mask` | `bool` | scalar | レイヤー | |
| 16 | `clips_content` | `bool` | scalar | フレーム・コンポーネント | |
| 17 | `constraints` | `Constraints { h: u8, v: u8 }` | scalar | レイヤー | 持ち主は layout |
| 18〜39 | `layout_mode`・`layout_wrap`・`item_spacing`・`counter_axis_spacing`・`padding_top`〜`padding_left`・`primary_axis_align`・`counter_axis_align`・`counter_axis_align_content`・`primary_sizing`・`counter_sizing`・`strokes_included_in_layout`・`item_reverse_z_index`・`layout_positioning`・`layout_grow`・`layout_align`・`min_width`・`max_width`・`min_height`・`max_height` | 各 1 つ | scalar | フレーム・コンポーネント・子（最小・最大はレイヤー） | 持ち主は layout。余白と最小・最大は別々の単位にする（別々に編集されるため）。値の範囲は [layout.md](layout.md) の 3.1 節 |
| 40 | `vector_network` | `VectorNetwork`（頂点・辺・領域。最大 1 MiB） | scalar | `VECTOR` | ベクターネットワーク全体が 1 つの単位 |
| 41 | `polygon_count`・`star_inner_radius` | 各 1 つ | scalar | 多角形・星 | |
| 42 | `boolean_op` | `BoolOp (u8)` | scalar | `BOOLEAN_OPERATION` | |
| 50 | `text_content` | `TextContent { chars: String, runs: Vec<StyleRun> }`（最大 64 KiB） | scalar | `TEXT` | 文字と書式の範囲を 1 つの単位にする。分けると、文字の添字と範囲がずれる（ADR-0002 の「テキストは LWW」） |
| 51〜58 | `font_family`・`font_style`・`font_size`・`line_height`・`letter_spacing`・`text_align_h`・`text_align_v`・`text_auto_resize` | 各 1 つ | scalar | `TEXT` | 範囲の書式がないときの既定。範囲の書式は `text_content` の `runs` |
| 60 | `component_props` | `Map<PropKey, ComponentPropDef>` | map | `COMPONENT`・`COMPONENT_SET` | 持ち主は components |
| 61 | `main_component` | `NodeId` | scalar | `INSTANCE` | 持ち主は components |
| 62 | `overrides` | `Map<OverrideKey, Value>` | map | `INSTANCE` | 要素の鍵は `(ノードのパス, プロパティ id)`。持ち主は components（9.3 節） |
| 63 | `variant_props` | `Map<PropKey, String>` | map | `COMPONENT` | 持ち主は components |
| 64 | `component_prop_values` | `Map<PropKey, Value>` | map | `INSTANCE` | 持ち主は components（[components-and-libraries.md](components-and-libraries.md) の 3.1 節） |
| 65 | `component_prop_refs` | `Map<PropRefTarget, PropKey>`（`visible`・`characters`・`main_component`） | map | コンポーネントの中のレイヤー | 同上 |
| 66〜68 | `publish_key`・`publish_hidden`・`removed_at` | 128 ビットの乱数の文字列・`bool`・時刻 | scalar | `COMPONENT` | 同上。`publish_key` はライブラリ（MVP の後）で使う |
| 70 | `export_settings` | `Vec<ExportSetting>`（最大 16） | scalar | レイヤー | 持ち主は export-and-assets |
| 80 | `derived_layout` | `DerivedLayout { transform, size }` | scalar | レイヤー | `derived`。9.2 節 |
| 90 | `plugin_data` | `Map<(PluginId, Key), Bytes>` | map | すべて | 予約（MVP の後） |
| 91 | `thumbnail_node` | `Option<NodeId>` | scalar | `DOCUMENT` | ファイルのサムネイルの対象。持ち主は export-and-assets（[export-and-assets.md](export-and-assets.md) の 8 節） |
| 92 | `cjk_fallback_font` | `FontRef { family, style }`（既定は同梱の Noto Sans JP） | scalar | `DOCUMENT` | グリフのないときの和文のフォールバック。同梱のフォントだけを選べる。持ち主は rendering-engine（ADR-0015） |

- `Paint` は、単色（`rgba f32×4`）、線形・放射・角度・ダイヤモンドのグラデーション（止まり点は最大 32）、画像（`image_hash: [u8; 32]`、拡大の方式、変換）。画像そのものはファイルに入れず、ハッシュで参照する（9.5 節）。
- 色は sRGB の `f32`。MVP は sRGB だけを扱い、Display P3 のファイルの設定は足さない（[rendering-engine.md](rendering-engine.md) の 8.1 節）。

### 4.3 値の型

`bool`、`u8`〜`u32`、`i32`、`f32`、`String`（UTF-8）、`Bytes`、`NodeId`、`OrderKey`、固定長の構造（`Vec2`、`Affine2x3`、`CornerRadii`）、`Vec<T>`、`Map<K, V>`、列挙。`f64` は使わない（WASM とネイティブで結果を揃えやすく、メモリを抑えるため）。

- `f32` は NaN と無限を持たない。検証で拒否する。`-0.0` は `0.0` に正規化する（直列化の正準形のため。8.3 節）。
- 文字列は NFC に正規化しない（利用者の入力をそのまま持つ）。長さの上限はバイトで数える。

### 4.4 検証

`doc-model` の `validate(op, doc, role) -> Result<(), Reject>` がすべての変更を確かめる。クライアントは送る前に、サーバーは当てる前に、同じ関数を呼ぶ（ADR-0001）。

| 検証 | 失敗したら |
| --- | --- |
| プロパティがノードの種類に許されている | 拒否（`invalid_property`） |
| 値の型・範囲・長さ・要素の数 | 拒否（`invalid_value`） |
| `derived` のプロパティ（`derived_layout`）を書く | 編集の権限を持つセッションからなら、誰の書き込みも受ける。値の型と範囲だけを確かめ、計算し直さない（9.2 節、ADR-0019） |
| 木の不変条件（5 節） | 拒否（`cycle`、`invalid_parent`、`depth_exceeded`） |
| 権限（10 節） | 拒否（`forbidden`） |
| 対象のノードがない | 拒否しない。その操作だけを捨てる（[multiplayer.md](multiplayer.md) の 6 節） |

## 5. 木の不変条件

どの確定した状態（サーバーの `seq` の各点）でも、次が成り立つ。性質ベーステストで確かめる（12 節）。

| # | 不変条件 |
| --- | --- |
| T1 | 根は `DOCUMENT` がちょうど 1 つで、ID は `0:0`。`parent_index` を持たない |
| T2 | 根以外のノードは、生きている親をちょうど 1 つ持つ（`parent_index.parent` が生きている） |
| T3 | 親をたどると、必ず根に着く（循環がない） |
| T4 | 親と子の種類の組み合わせが 3 節の表に合う |
| T5 | 同じ親の子の `OrderKey` は一意で、形式が正しく、64 バイト以下（[multiplayer.md](multiplayer.md) の 5 節） |
| T6 | 深さ（根から数えた段数）は 256 以下 |
| T7 | `CANVAS` は 1 つ以上ある |
| T8 | `GROUP`・`BOOLEAN_OPERATION` は子を 1 つ以上持つ（子が 0 になる変更の後、サーバーが同じ変更の集まりの中でそのノードを消す） |
| T9 | `INSTANCE` の `main_component` が、自分を含むコンポーネントを指さない（インスタンスの参照の循環がない。検証の規則は components の領域が足す。9.3 節） |

- T8 は、他の人が最後の子を別の場所へ動かしたときにも起きる。サーバーは、その `seq` の中で空になったグループを消す操作を足す（サーバーが作る操作。`session_id = 0`）。
- クライアントの画面（確定した状態＋未確定の自分の変更）では、T3 が一時的に破れうる。その間は該当のノードを木から外して描く（ADR-0002、[multiplayer.md](multiplayer.md) の 6 節）。

## 6. ID

- `NodeId = (session_id: u32, local_id: u32)`。文字列では `"{session_id}:{local_id}"` と書く（URL・API・コメントの参照に使う）。
- `session_id` は、ファイルごとにサーバー（Document Server）が振る。ファイルの状態に `next_session_id` を持ち、振ったことをジャーナルに書いてから（`session_open` の記録）クライアントに渡す。持ち主が変わっても、同じ `session_id` を二度振らない（ADR-0007）。
- `local_id` は、セッションの中でクライアントが 1 から数える。`u32` を使い切ったら、クライアントは新しいセッションを求める（実際には起きない大きさ）。
- 予約：`0:0` は `DOCUMENT`、`0:1` は最初の `CANVAS`。`session_id = 0` はサーバーが作る操作（グループの削除、鍵の振り直し、復元）に使う。
- ID はファイルの中だけで一意。ファイルの複製では ID を変えない（[file-storage-and-history.md](file-storage-and-history.md) の 9 節）。別のファイルへの貼り付けでは、新しい ID を振る。
- 消したノードの ID を、Undo で同じ ID のまま作り直せる（[multiplayer.md](multiplayer.md) の 10 節）。生きているノードと同じ ID の `create` は拒否する（`duplicate_id`）。

## 7. 変更の操作

```
Op =
  | Create { id: NodeId, node_type: NodeType, props: Vec<(PropId, Value)> }   // parent_index を必ず含む
  | Set    { id: NodeId, prop: PropId, value: Value }                          // scalar の置き換え。既定値に戻すのも Set
  | MapSet { id: NodeId, prop: PropId, key: MapKey, value: Option<Value> }     // map の要素の置き換え・削除
  | Delete { id: NodeId }                                                      // 子孫もまとめて消す

ChangeSet { ops: Vec<Op>, origin: Origin }   // 1 つの利用者の操作（ドラッグの 1 フレーム、貼り付け 1 回）。原子的に当たる
Origin = User | Plugin { plugin_id, version_id } | LayoutRepair | Server   // 版の履歴の表示に使う印
```

- 親の付け替え・並びの変更は `Set { prop: parent_index }`。
- `Delete` は子孫をまとめて消す。消したノードは状態から取り除き、墓標を持たない。同じ ID の後からの `Set` は捨てる（[multiplayer.md](multiplayer.md) の 6 節）。
- 1 つの `ChangeSet` の操作は、順に当てる。検証に 1 つでも失敗したら、`ChangeSet` 全体を拒否する（原子性）。対象のノードがないことによる「捨てる」は失敗に数えない。
- 1 つの `ChangeSet` は、直列化して 4 MiB 以下（[multiplayer.md](multiplayer.md) の 4 節）。
- `origin` は、プラグインの変更（[plugins.md](plugins.md) の 5.3 節、ADR-0038）、レイアウトの修復（[layout.md](layout.md) の 4.2 節）、サーバーが作る操作（`session_id = 0`）を見分ける印で、ジャーナルに残し、版の履歴の表示に使う。クライアントの申告なので、権限の判定には使わない。`Server` はサーバーだけが付けられる。

## 8. 直列化の形式

ADR-0008。1 つの形式を、通信（WebSocket）、ジャーナル、チェックポイントで使う。

### 8.1 符号化

- スキーマ付きのバイナリ。値は LEB128 の可変長整数、`f32` はリトルエンディアン 4 バイト、文字列は長さ＋UTF-8。
- ノードのプロパティは `(prop_id: varint, len: varint, value)` のタグ付きで並べる。読み手は、知らない `prop_id` を長さで読み飛ばせる（前方互換）。
- 表（ADR-0006）から、Rust の符号化・復号のコードと TypeScript の型を生成する。手で書かない。

### 8.2 チェックポイントの中身

```
Manifest（ファイル 1 つ・版 1 つ）
  magic "<brand>DOC", format_version: u16, schema_hash: [u8; 16]
  file_id, seq, created_at
  features: [FlagId]              // その seq の時点の文書のフラグ（ADR-0055。Render Worker・file-read が読む）
  next_session_id: u32
  sessions_chunk: ChunkRef          // セッションの表（multiplayer.md の 4.4 節）
  document_chunk: ChunkRef          // DOCUMENT ノードと CANVAS ノードのプロパティ
  pages: [ { page_id: NodeId, chunks: [ChunkRef], node_count: u32, raw_bytes: u64 } ]
  blob_refs_chunk: ChunkRef         // 画像・フォントのハッシュの一覧（9.5 節）

ChunkRef { sha256: [u8; 32], compressed_bytes: u32, raw_bytes: u32 }

PageChunk（1 ページ。4 MiB を超えたら ID の順に分ける）
  nodes: [ { id: NodeId, node_type: u8, props: [(prop_id, len, value)] } ]   // ID の昇順
```

- チャンクは zstd（レベル 3）で圧縮し、中身の SHA-256 で名付ける。変わっていないページは、前のチェックポイントと同じチャンクを指す（[file-storage-and-history.md](file-storage-and-history.md) の 5 節、ADR-0025）。
- ページだけを読める。開いたページのチャンクを先に読む（[file-storage-and-history.md](file-storage-and-history.md) の 6 節）。

### 8.3 正準形

- 同じ状態は、いつも同じバイト列になる。ノードは ID の昇順、プロパティは `prop_id` の昇順、既定値と同じプロパティは書かない、`map` の要素は鍵の昇順、`-0.0` は `0.0`。
- 本家は、チェックポイント A とその後のジャーナルから作り直したファイルが、チェックポイント B とバイト単位で一致することを確かめてからジャーナルを出した（[Making multiplayer more reliable](https://www.figma.com/blog/making-multiplayer-more-reliable/)、2022-10-20、2026-09-27 に確認）。正準形は、同じ検証（[file-storage-and-history.md](file-storage-and-history.md) の 13 節）と、WASM とネイティブの一致の検査（ADR-0001）に使う。

### 8.4 版と互換

- `format_version` は、符号化の規則を変えたときだけ上げる。プロパティを足すだけなら上げない（`since` の列で追う）。
- `schema_hash` は、表から計算する。接続時の照合は [ADR-0053](../decisions/0053-client-server-version-skew.md) の 3 つの版（`protocol_version`、`schema_hash` の互換の一覧、`min_client_build`）で行う。サーバーは「今の表から追加だけでたどれる直近 30 日の `schema_hash`」を受け入れ、一致しなくても一覧の中なら接続を続ける。一覧の外なら強い再読み込み（`Kick(version_mismatch)`）にする（[delivery.md](delivery.md) の 4 節、[multiplayer.md](multiplayer.md) の 4.3 節）。
- プロパティを足す順：サーバー（Document Server・Worker）を先に出し、クライアントを後に出し、最後に書き込みを解禁する（`schema.<prop>.write`。ADR-0055）。サーバーは、古いクライアントが送らないプロパティを既定値で扱う。
- 読み手は、知らない `prop_id` を持つチェックポイントを読んだら、値をそのまま持ち、書き出しでもそのまま書く（古い Worker が新しいプロパティを消さない）。
- プロパティを消すときは、`deprecated` にして読み飛ばし、1 か月後に表から外す。番号は再利用しない。

## 9. 他の領域とのインターフェース

### 9.1 描画（rendering-engine）

```
trait DocRead {
  fn get(&self, id: NodeId, prop: PropId) -> Option<ValueRef>;
  fn node_type(&self, id: NodeId) -> Option<NodeType>;
  fn children(&self, id: NodeId) -> impl Iterator<Item = NodeId>;  // OrderKey の順
  fn page_loaded(&self, page: NodeId) -> bool;
}

struct ChangeSummary {            // 当てた変更の要約。フレームごとにまとめて渡す
  created: Vec<NodeId>, deleted: Vec<NodeId>,
  props: Vec<(NodeId, PropId)>,   // 値が変わった (ノード, プロパティ)
  reparented: Vec<NodeId>,
  pages_loaded: Vec<NodeId>,
}
```

- 描画は `DocRead` と `ChangeSummary` だけを使い、`doc-model` の内部の表を直接読まない。シーングラフの作り直しの範囲は `ChangeSummary` から決める。
- 画面に出すのは「確定した状態＋未確定の自分の変更」（[multiplayer.md](multiplayer.md) の 7 節）。描画はこの 2 つを区別しない。
- 一時的に循環したノード（5 節）は、`children` に出さない。

### 9.2 レイアウト（layout）

- レイアウトの入力（`layout_mode`・余白・`constraints`・子の `size` など）と出力を、表の `derived` の列で分ける。出力は `derived_layout`。
- **書く人**：入力を変えた本人のクライアントが計算し、同じ `ChangeSet` に `derived_layout` の `Set` として入れる。同時の編集で入力と保存された結果が食い違ったら、**修復の担当**（編集の権限を持ち、今つながっているセッションのうち `session_id` が最小のもの）が計算し直して書く（[layout.md](layout.md) の 4.2 節、ADR-0019）。
- **画面**：どのクライアントも、画面にはいつも `DocView` から手元で計算した結果を出す。保存された `derived_layout` を画面に使うのは、開いた直後の最初の描画と、測定が「仮」のテキスト（フォントがない）だけ（[layout.md](layout.md) の 4.1 節）。
- **サーバー**：Document Server は計算しない。型と範囲だけを検証する。Render Worker は保存された値を使い、保存されないインスタンスの中身だけを同じコードで計算する（[export-and-assets.md](export-and-assets.md) の 5.2 節）。
- **Undo**：`derived` のプロパティは Undo の項目に入れない。Undo は入力だけを戻し、計算し直した `derived_layout` を同じ `ChangeSet` に入れる（ADR-0012 の注記）。
- レイアウトの計算は決定的でなければならない（WASM とネイティブで同じ結果）。計算の中は f64 の四則と min・max だけにし、順序を固定する（[ADR-0020](../decisions/0020-deterministic-layout-arithmetic.md)）。

### 9.3 コンポーネント（components）

- インスタンスの中身（元のコンポーネントの子孫の写し）は、ノードとして保存しない。`main_component` と `overrides` から、描画・レイアウトの前に展開する。展開したノードの ID は、`(インスタンスの ID, コンポーネントの中のノードの ID の列)` のパスで表す（`InstanceSubId`）。
- `overrides` の鍵は `(パス, prop_id)`。要素ごとが競合の単位（`map`）。同じインスタンスの別のプロパティの上書きは競合しない。
- 検証の規則 T9 と、コンポーネントの中身が変わったときの上書きの扱いは、components の領域が `doc-model` の検証器に足す（`Validator` の登録。検証の規則を `doc-model` の外に書かない）。

### 9.4 権限（permissions-and-sharing）

- `doc-model` は、判定の結果の水準（`Level`）だけを受け取る。判定そのもの（組織・チーム・共有のリンク）はしない。水準の名前は permissions-and-sharing.md（ADR-0029）に合わせる。

| Level | 当ててよい操作 |
| --- | --- |
| `edit`・`owner` | すべて |
| `view` | なし（`forbidden`）。在席とカーソルは送れる |

- 水準は、API が発行する能力のチケットで Gateway が知り、変わったら Document Server に知らせる（[multiplayer.md](multiplayer.md) の 11 節）。

### 9.5 画像・フォント（export-and-assets）

- 画像は `Paint` の `image_hash`（中身の SHA-256）で参照する。本体は export-and-assets の領域が S3 に置く。フォントは `font_family`・`font_style` の名前で参照し、ファイルに埋め込まない。
- チェックポイントの `blob_refs_chunk` に、ファイルが参照する画像のハッシュを並べる。複製・削除・参照の数え上げに使う（[file-storage-and-history.md](file-storage-and-history.md)）。

## 10. メモリの上の持ち方

- `Doc` は、ノードの表（`NodeId → Node`）と、親ごとの子の索引（`OrderKey` の順の木）を持つ。
- ノードの表は、永続的な（変更の前の版を共有する）対応表（HAMT）にする。Document Server は、チェックポイントのために状態の写しを O(1) で取り、別のスレッドで直列化する（ADR-0003 の「スナップショットを取ってから別のスレッドで直列化する」）。
- クライアントも同じ `Doc` を使う（ADR-0001）。HAMT の読み取りの速さが、描画とヒットテストで足りるかは **未検証**。E2 の前の `hamt-node-store-poc` で、10 万ノードで計測する。足りなければ、クライアントだけ通常の対応表に替える（`doc-model` の型の引数で切り替え、適用の規則は 1 つのまま）。
- 読み込んでいないページのノードは持たない。`CANVAS` のノードと、ページの `node_count` だけを持つ。
- WASM のメモリは最大 4 GiB（32 ビット）。10 万ノードで `Doc` の大きさを 200 MiB 以内に収める（NFR-004 の 1.5 GB のうち、残りは描画と画像）。

## 11. 大きさの上限

| 項目 | 上限 | 超えたら |
| --- | --- | --- |
| 1 ファイルのノード | 100 万（30 万で警告） | 作る変更を拒否（`file_too_large`） |
| 1 ページのノード | 30 万 | 同上 |
| 1 ファイルのページ | 1,000 | 同上 |
| 深さ | 256 | 拒否（`depth_exceeded`） |
| 1 ノードの子 | 10 万 | 拒否 |
| `text_content` | 64 KiB | 拒否 |
| `vector_network` | 1 MiB、セグメント 10 万 | 拒否 |
| 座標（`transform` の平行移動、`size`） | ±1,000,000 | 拒否 |
| ぼかしの半径（`effects`） | 0〜1,000 | 拒否 |
| `name` | 512 バイト | 拒否 |
| 1 つの `ChangeSet` | 4 MiB（直列化の後） | クライアントが分けて送る（[multiplayer.md](multiplayer.md) の 4 節） |
| チェックポイント全体（圧縮の前） | 2 GiB | 編集を止め、ページを分けるよう案内する |

- 本家の上限は、タブのメモリ 2 GB だけを確かめた（[Reduce memory usage in files](https://help.figma.com/hc/en-us/articles/360040528173-Reduce-memory-usage-in-files)、2026-09-27 に確認）。ノードの数の上限は公開の資料で見つけられなかった（**未検証**）。上の値はこの設計の決定で、capacity.md と E2 の PoC で見直す。

## 12. 障害のときの振る舞い

| 障害 | 起きること | 対応 |
| --- | --- | --- |
| クライアントとサーバーの `doc-model` の版が違う | 同じ変更の結果が変わりうる | 接続時に ADR-0053 の 3 つの版で照合し、互換の外なら強い再読み込み。結果を変える規則の変更は文書のフラグでファイルごとに切り替える（8.4 節、ADR-0055） |
| 知らない `prop_id` を持つチェックポイント | 古い Worker が値を落としうる | 読み飛ばさずに持ち、そのまま書く（8.4 節） |
| チェックポイントのチャンクの破損 | ハッシュが合わない | 読み込みを止め、前のチェックポイントとジャーナルから作り直す（[file-storage-and-history.md](file-storage-and-history.md) の 12 節） |
| 不変条件の破れ（バグ） | 描画・書き出しが壊れうる | サーバーは当てた後の検査（重い検査は抜き取り）で見つけたら、そのファイルを `maintenance`（`files.state`。[data-model.md](data-model.md) の 5.1 節）にして編集を止め、修復の手順（runbook）に回す |
| WASM とネイティブで `f32` の結果が違う | 画面と書き出しの差 | 表の検証と正準形の比較を CI で両方に走らせる（ADR-0001） |

## 13. セキュリティ

- ファイルの中身は信頼できない入力として扱う。復号は長さと数の上限を先に確かめ、上限を超える確保をしない（巨大な長さの値による DoS を防ぐ）。
- 復号器と検証器は fuzzing の対象にする（`cargo fuzz`。復号 → 検証 → 符号化 → 復号の往復）。
- ノードの名前・テキスト・画像のハッシュを、ログ・トレース・メトリクスに書かない。書いてよいのは ID・種類・大きさ（本題材の AGENTS.md）。
- `plugin_data` など、MVP の後に足すプロパティも、同じ表と検証を通す。

## 14. テスト

### 14.1 性質ベーステスト（`proptest`）

- **PROP-DM-001**：任意の変更の列を当てた後、5 節の T1〜T9 が成り立つ（拒否された変更は当たらない）。
- **PROP-DM-002**：任意の状態で、`decode(encode(doc)) == doc`、かつ `encode(decode(bytes)) == bytes`（正準形）。
- **PROP-DM-003**：任意の状態で、ページ単位の直列化を全ページ読んで作り直した状態が、元と一致する。
- **PROP-DM-004**：任意の変更の列で、WASM とネイティブの適用の結果（正準形のバイト列）が一致する（ADR-0001）。
- **PROP-DM-005**：任意の `ChangeSet` で、検証に失敗したら、状態は 1 バイトも変わらない（原子性）。
- **PROP-DM-006**：知らない `prop_id` を含むノードを復号して符号化すると、その値が残る。

### 14.2 表駆動のテスト

- 3 節の親子の組み合わせのすべて（許すものと拒否するもの）。
- 4.4 節の検証のすべての行。
- 11 節の上限の境界（上限ちょうどと 1 つ超え）。

### 14.3 その他

- fuzzing：復号器（任意のバイト列で落ちない、上限を超える確保をしない）。
- 表の lint：`kind = scalar` の `Vec`・構造の型に、別々に編集されうる値が入っていないかを、表の追加の PR でレビューの観点にする。

## 15. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり：E1 基盤とビルド、E2 描画エンジンと大きなファイル、E3 ドキュメントのモデルとマルチプレイヤー、E4 ベクターとテキストの編集、E5 フレームとオートレイアウト、E6 コンポーネントとバリアント、E7 保存と版の履歴、E8 コメントと通知、E9 チーム・権限・共有、E10 書き出しとアセット、E11 ファイルの一覧と検索、E12 運用と GA の準備。

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `doc-model-schema-codegen` | プロパティの表、表からの Rust・TypeScript のコード生成、表の lint |
| E3 | `doc-model-core-ops` | `Create`・`Set`・`MapSet`・`Delete`、`ChangeSet` の原子性、検証器 |
| E3 | `tree-invariants` | T1〜T9 の検証と性質ベーステスト |
| E3 | `canonical-codec` | 8 節の符号化・復号、正準形、fuzzing |
| E3 | `page-chunked-snapshot` | ページ単位のチャンクとマニフェストの形（保存は E7） |
| E2 | `hamt-node-store-poc` | 10 万ノードでの HAMT と通常の対応表の比較（10 節） |
| E1 | `wasm-native-parity-ci` | WASM とネイティブの一致の CI（PROP-DM-004） |
| E3 | `session-id-allocation` | `session_open` の記録と `next_session_id`（ADR-0007） |
| E5 | `derived-layout-property` | `derived_layout` と、9.2 節の書き手の規則（修復の担当を含む） |
| E6 | `instance-overrides-map` | `overrides` の `map`、`InstanceSubId`、T9 の検証の登録 |

## 16. 未解決の問い

### 決定（2026-09-27、既定案）

- **塗り・線の配列の競合の単位**：配列全体を 1 つの単位にする。2 人が同じノードの別の塗りを同時に変えると、片方が消える。まれとみなす。
- **移動と回転**：`transform` 1 つにまとめる。`x`・`y`・回転を分けると、行列から分解するときの誤差と、分けた値の組み合わせの矛盾が起きるため。
- **ノードの数の上限**：1 ファイル 100 万、1 ページ 30 万（11 節）。
- **深さの上限**：256。
- **種類の変更**：できない。作り直す（3 節）。
- **レイアウトの結果の保存**：保存する。入力を変えた本人と修復の担当が書き、画面はいつも手元の計算（9.2 節、ADR-0019）。
- **インスタンスの中身の ID と上書きの鍵**：`InstanceSubId = (インスタンスの ID, 元のノードの ID の経路)`、上書きの鍵は `(経路, prop_id)`（ADR-0021）。
- **色空間**：MVP は sRGB だけ（[rendering-engine.md](rendering-engine.md) の 8.1 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| HAMT をクライアントでも使うか | E2 の前の `hamt-node-store-poc`（10 節） |
| Display P3 をいつ扱うか | 利用者の声で決める（rendering-engine.md の 20 節） |
| 本家のファイルの形式が Kiwi か、塗りの配列の競合の単位 | 公開の資料では確かめられない。この設計の判断には影響しないので、調べない |

## 17. quality.md・runbooks・data-model への項目

### quality.md

- 不変条件の破れの検知の数（サーバーの抜き取りの検査。目標 0）。
- WASM とネイティブの不一致の数（CI。目標 0）。
- 復号の fuzzing の実行時間（PR ごとに 5 分、夜間に 1 時間）と、見つかった落ちの数。
- 参照ファイル（1 万・10 万・30 万ノード）の `Doc` のメモリと、読み込みの時間。

### runbooks

- `document-invariant-violation.md`：不変条件の破れを見つけたときに、ファイルの編集を止め、最後の正しいチェックポイントとジャーナルから原因の変更を探し、修復の変更を当てる手順。
- `schema-rollout.md`：プロパティを足すときの出す順（サーバー → クライアント）と、戻すときの注意（新しいプロパティを書いたファイルは、古いサーバーでも読み飛ばして持てる）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| S3 `files/{file_id}/checkpoints/{seq}` | マニフェスト（8.2 節） |
| S3 `files/{file_id}/chunks/{sha256}` | ページ・セッション・参照の一覧のチャンク（8.2 節） |
| 開発リポジトリ `schema/properties.toml` | プロパティの表（4 節）。data-model.md から参照する |

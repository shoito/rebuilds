# Client App: Linear

クライアントの画面を決める。React の画面の骨格、入力から描画までの経路、キーボードのショートカットとコマンドメニュー、IME、大きな一覧とボードの仮想化、遅延の予算（NFR-001：p99 50ms）の計測、Web の起動と Service Worker、Electron のデスクトップのシェル（通知、ディープリンク、自動更新）を扱う。

前提となる決定は、基盤とクライアントの形（[ADR-0001](../decisions/0001-platform-and-stack.md)。React、反応型のオブジェクトプール、Electron）、楽観的な適用（[ADR-0002](../decisions/0002-sync-model.md)）、手元の保存と入力の経路（[ADR-0005](../decisions/0005-client-persistence-and-offline.md)）、複数のタブ（[ADR-0015](../decisions/0015-multi-tab-leader-and-broadcast.md)）、メモリーの階層とオフラインの表示（[ADR-0016](../decisions/0016-memory-tiers-quota-and-offline-ux.md)）、派生の変更の予測（[ADR-0025](../decisions/0025-derived-changes-in-writer.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0017](../decisions/0017-keymap-command-menu-and-ime.md) | 操作は 1 つの `Action` の登録にまとめ、ショートカット・コマンドメニュー・右クリックのメニュー・一覧のダイアログが同じ登録を使う。キーは入れ子の範囲（scope）の順に解決し、2 打の列を 1 秒待つ。`isComposing` か `keyCode === 229` のキーは、どのショートカットにも使わない。修飾キーのない 1 打のショートカットは、編集の領域では使わない |
| [0018](../decisions/0018-render-path-and-latency-budget.md) | 入力の経路は「Action → トランザクション → プールに当てる → 行ごとの購読で描き直す」で、IndexedDB とネットワークを待たない。一覧とボードは固定の高さの行で仮想化する。遅延は、イベントの `timeStamp` から描画の後までを自前の印で測り、RUM と、固定の機械の CI のベンチマーク（イシュー 50 万件）で p99 50ms を超えた PR を失敗させる |

## 1. 目的と範囲

- 扱う：
  - 対応環境、アプリの骨格、ルート、画面とプールの間のデータの流れ
  - 入力の経路と Undo
  - キーボードの仕組み、既定の割り当て、IME
  - コマンドメニュー（候補の元、照合、並べ方、予算）
  - 一覧とボードの仮想化、選択とフォーカス
  - 遅延の予算と計測（RUM、CI のベンチマーク）
  - Web の起動（Service Worker）、Electron のシェル
  - アクセシビリティと国際化の方針
- 扱わない：
  - 同期の核、IndexedDB、複数のタブ（[sync-engine.md](sync-engine.md)、[client-store-and-offline.md](client-store-and-offline.md)）
  - フィルターの言語、グループ化、保存したビューの意味（[views-and-filters.md](views-and-filters.md)）
  - 本文のエディタ（[editor-and-descriptions.md](editor-and-descriptions.md)）
  - 通知の種類と既読（[notifications-and-inbox.md](notifications-and-inbox.md)）
  - Electron の自動更新の配信・段階的な出し方・最低の版の強制（[delivery.md](delivery.md)）
  - ログアウトと共有の端末での消去（[security.md](security.md)）

## 2. 本家の形と、使う Web の API（確かめたこと）

いずれも 2026-09-28 に確認。

### 2.1 本家（公式）

| 項目 | 内容 | 出典 |
| --- | --- | --- |
| デスクトップ | macOS（Intel と Apple Silicon）と Windows。Linux は対象外で、ブラウザで使う | [Download Linear](https://linear.app/docs/get-the-app) |
| デスクトップの機能 | OS の通知。`<スキーム>://` に続く URL でアプリのページを開く。自動更新を背景で入れる（macOS では止められる） | 同上 |
| オフライン | 失敗への備えで、完全な機能ではない | 同上 |
| ショートカット（文書に出るもの） | `C` 作成、`Option/Alt+C` テンプレートから作成、`P` 優先度、`X` 選択、選択の後 `Shift+↑/↓` で範囲、`Cmd/Ctrl+K` コマンドメニュー、`G` の後のキーで移動、`M` の後 `R`・`B`・`X` で関連、`Cmd/Ctrl+Shift+M` チームの移動、Triage の `1`・`2`・`3`・`H`、`Cmd/Ctrl+Z` で削除・移動を戻す | [Create issues](https://linear.app/docs/creating-issues)、[Priority](https://linear.app/docs/priority)、[Select issues](https://linear.app/docs/select-issues)（検索の抜粋）、[Issue relations](https://linear.app/docs/issue-relations)、[Edit issues](https://linear.app/docs/editing-issues)、[Triage](https://linear.app/docs/triage)、[Delete and archive issues](https://linear.app/docs/delete-archive-issues) |

- 本家の画面の実装（仮想化の方式、描画の予算、ショートカットの仕組み）は、公開の資料で確かめられなかった（**未検証**）。本家が React と MobX を使うことは、README の 1.3 節のとおり、検索の抜粋でしか確かめていない。
- 状態（`S`）・担当（`A`）・ラベル（`L`）などの 1 打のキーが本家にあるかは、文書で確かめられなかった（**未検証**）。

### 2.2 Web の API と Electron

| 項目 | この設計で使う性質 | 出典 |
| --- | --- | --- |
| `KeyboardEvent.isComposing` | `compositionstart` の後、`compositionend` の前のイベントで真 | [MDN: isComposing](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing) |
| IME の中の `keydown` | 組み立ての一部の `keydown` を無視するには `isComposing || keyCode === 229`。`compositionstart` が `keydown` の後に来る、`compositionend` が `keydown` の前に来る場合、`isComposing` は偽でも `keyCode` は 229 | [MDN: keydown event](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event) |
| `compositionend` | 組み立ての確定か取り消しで発火。2015-07 から主要なブラウザで使える | [MDN: compositionend](https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionend_event) |
| Event Timing | `duration` はイベントの `startTime` から次の描画まで（8ms に丸める）。既定の閾値は 104ms、最小 16ms。`interactionId` で 1 つの操作のイベントをまとめる。Baseline 2025 | [MDN: PerformanceEventTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming) |
| Electron のセキュリティ | 20 項目のチェックリスト（リモートの中身で Node.js を使わない、context isolation、sandbox、CSP、ナビゲーションの制限、`setWindowOpenHandler`、`shell.openExternal` の確かめ、IPC の送り手の確かめ、fuses など） | [Electron: Security](https://www.electronjs.org/docs/latest/tutorial/security) |
| Electron の自動更新 | `autoUpdater`（Squirrel.Mac・Squirrel.Windows）。macOS は署名が必須。静的な置き場（S3 など）のメタデータでも配れる | [Electron: Updating Applications](https://www.electronjs.org/docs/latest/tutorial/updates) |
| ディープリンク | `setAsDefaultProtocolClient`。macOS は `open-url`（`ready` の前に登録）、Windows・Linux は `requestSingleInstanceLock` と `second-instance` | [Electron: Deep Links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app) |

## 3. 対応環境と骨格

### 3.1 対応環境

| 環境 | 対応 |
| --- | --- |
| Chrome・Edge・Firefox（デスクトップ） | 最新 2 メジャー |
| Safari（macOS） | 17 以上（Slack・Notion の題材と同じ） |
| デスクトップのアプリ | macOS（直近 3 版、Intel と Apple Silicon）、Windows 10・11（x64、arm64）。Linux は対象外（本家と同じ） |
| モバイルのブラウザ | 読むことだけを確かめる。操作の予算の対象外（モバイルのアプリは MVP の後） |

### 3.2 構成

```
apps/web/
├── src/app/          # ルート、レイアウト、エラー境界
├── src/actions/      # Action の登録（7 節）。キー・コマンドメニュー・メニューが使う
├── src/keymap/       # キーの解決、範囲、2 打の列、IME の抑止（5 節）
├── src/command/      # コマンドメニュー（6 節）
├── src/views/        # 一覧・ボード・イシューの詳細・Triage・インボックス
├── src/virtual/      # 仮想化の薄い包み（8 節）
├── src/perf/         # 遅延の印と RUM（9 節）
├── src/sw/           # Service Worker（10 節）
└── src/i18n/
apps/desktop/         # Electron の main と preload（11 節）
packages/pool/        # オブジェクトプール、view、購読の API（sync-engine の 4.1 節）
packages/model/       # 生成のパッケージ（data-model-and-schema の 4 節）
packages/doc/         # 本文（editor-and-descriptions の 3.1 節）
packages/ui/          # デザインシステム
```

- ルーターは TanStack Router。モデルでないサーバーの状態（サーバーの検索の結果、招待の画面）は TanStack Query で持つ。Slack・Notion の題材と同じ。
- 画面のコードは `packages/pool` の購読の API（`useModel(id)`、`useField(id, f)`、`useQuery(spec)`）だけを使う。反応型のストア（MobX か自前か。E2 の PoC）の API を直接 import しない（ADR-0001 の lint）。

### 3.3 ルート

| パス | 画面 |
| --- | --- |
| `/<ws>` | インボックスか、最後に開いたビュー |
| `/<ws>/team/<KEY>/<active｜backlog｜all｜triage>` | チームのイシューの一覧・ボード |
| `/<ws>/issue/<KEY>-<number>` | イシューの詳細。古い識別子は今の識別子へ転送（[data-model-and-schema.md](data-model-and-schema.md) の 5.4 節） |
| `/<ws>/issue/<uuid>` | 番号が決まる前のイシュー |
| `/<ws>/view/<id>`、`/<ws>/project/<id>`、`/<ws>/cycle/<id>` | 保存したビュー、プロジェクト、サイクル |
| `/<ws>/inbox`、`/<ws>/my-issues`、`/<ws>/settings/...` | インボックス、自分のイシュー、設定 |

- URL にタイトルを入れない。見てよくない・ないイシューは、同じ「見つかりません」を出す（ADR-0004）。

## 4. 入力の経路と Undo

ADR-0018。

### 4.1 経路

```
 keydown / click
   │ (1) keymap が Action を決める（5 節）
   ▼
 Action.run(ctx)                    ── 選択・フォーカスの文脈
   │ (2) トランザクションを作る。derive で派生を予測（ADR-0025）
   ▼
 pool.apply(tx)                     ── pendingByModel に積み、触れたモデルの view を計算し直す
   │ (3) 触れたフィールドを読む部品だけが描き直される（行ごとの購読）
   ▼
 React の commit → 描画
   │ (4) 描画の後に outbox へ（同じイベントループの回の tx をまとめ、strict でコミット）
   ▼
 書き手のタブが送る（sync-engine の 4.4 節）
```

- (1)〜(3) の間に `await` を置かない。IndexedDB・ネットワーク・Web Locks・BroadcastChannel を待たない（ADR-0005、AGENTS.md）。
- outbox のコミットは (4) で始め、描画を待たせない。1 秒で終わらなければ「保存していない変更」を示す（[client-store-and-offline.md](client-store-and-offline.md) の 4 節）。
- 一覧の並び・絞り込みの計算し直しは、変わった行だけを差し込み・取り除く（views-and-filters の領域の増分の評価）。全件を並べ直さない。

### 4.2 手元にないもの

- 開いたイシューの行が M1 になければ、IndexedDB から読む（非同期。NFR-001 の対象外。ADR-0016）。その間は M2 の列（タイトル、状態、担当）で見出しを先に描く。
- 被覆のない遅延のモデル（コメント、履歴、本文）は、手元の分を描き、「読み込み中」を示す（[bootstrap-and-partial-sync.md](bootstrap-and-partial-sync.md) の 6.5 節）。

### 4.3 選択と一括の操作

- 選択は ID の集合で持つ（添字で持たない）。差分で行が動いても、選択は崩れない。
- 一括の操作は 500 操作ずつのトランザクションに分ける（[sync-engine.md](sync-engine.md) の 4.2 節）。1 つ目のトランザクションまでを入力の経路で当て、残りは次のフレーム以降に 1 フレーム 1 つずつ当てる。1,000 件の一括の変更でも、最初の描画は予算の中に収める。

### 4.4 Undo

- `Cmd/Ctrl+Z` は、直前の Action の逆の操作を、新しいトランザクションとして送る。逆の操作は、当てる前の `view` から Action が作る（例：`set priority 2 → 3` の逆は `set priority 2`、ゴミ箱への削除の逆は戻し）。
- Undo の列はタブごとに 100 件、再読み込みで消える。他の人がその後に同じフィールドを変えていても、逆の操作は LWW で当たる（上書きの記録が残る）。
- 本文にフォーカスがある間は、エディタの Undo を使う（[editor-and-descriptions.md](editor-and-descriptions.md) の 3.5 節）。

## 5. キーボード

ADR-0017。

### 5.1 仕組み

- **Action の登録**：`{id, title, keywords, shortcut?, scope, when(ctx), run(ctx)}`。ショートカット、コマンドメニュー、右クリックのメニュー、ショートカットの一覧のダイアログ（`?`）は、この 1 つの登録から作る。
- **範囲（scope）**：`global` → `view`（一覧・ボード）→ `detail`（イシューの詳細）→ `overlay`（メニュー、コマンドメニュー、ダイアログ）→ `editable`（入力欄、エディタ）の入れ子。フォーカスのある最も内側の範囲から順に探し、最初に `when` が真の Action を実行する。`overlay` が開いている間、外の範囲の 1 打のキーは使わない。
- **2 打の列**：`G` → `I` のような列は、1 打目の後 1,000ms 待つ。待つ間は画面の隅に続きの候補を示す。2 打目が列にないときは、何もしない（1 打目の単独の割り当てを後から実行しない）。
- **キーの照らし方**：英字は `event.key` を小文字にしたもの。記号（`/`、`?`、`[`）も `event.key`。`event.key` が英字でない配列（ロシア語など）では `event.code`（`KeyC` など）で照らす。JIS 配列と US 配列で記号の位置が違うため、記号は `code` で照らさない。
- macOS は `Cmd`、Windows は `Ctrl`。表示もそれぞれで出す。

### 5.2 既定の割り当て（MVP）

本家の文書に出るもの（2.1 節）と、課題管理のツールで一般的なものに限る。本家への寄せ方は法務の L8 の後に見直し、E6 の画面の Story は L8 の確認まで承認しない（[intent.md](../intent.md)）。

| 操作 | キー | 範囲 |
| --- | --- | --- |
| コマンドメニュー | `Cmd/Ctrl+K` | global（編集の領域でも使う） |
| イシューを作る・テンプレートから作る | `C`・`Alt+C` | global |
| 移動（インボックス、自分のイシュー、Triage、設定） | `G` → `I`・`M`・`T`・`S` | global |
| 次・前の行、開く、戻る | `J`・`K` と `↓`・`↑`、`Enter`、`Esc` | view・detail |
| 選ぶ、範囲を広げる、すべて選ぶ | `X`、`Shift+↑/↓`、`Cmd/Ctrl+A` | view |
| 優先度・状態・担当・ラベル・見積もり | `P`・`S`・`A`・`L`・`E`（候補のメニューを開く） | view・detail |
| 関連・塞がれる・塞ぐ | `M` → `R`・`B`・`X` | view・detail |
| チームへ移す | `Cmd/Ctrl+Shift+M` | view・detail |
| Triage の受け入れ・却下・重複・スヌーズ | `1`・`2`・`3`・`H` | view（Triage の一覧） |
| 戻す・やり直す | `Cmd/Ctrl+Z`・`Cmd/Ctrl+Shift+Z` | global |
| ショートカットの一覧 | `?` | global |

- `S`・`A`・`L`・`E` の 1 打の割り当ては本システムの決定で、本家にあるかは**未検証**。
- 利用者が割り当てを変える機能は MVP で持たない。

### 5.3 IME と編集の領域

AGENTS.md の「日本語の変換の途中（`isComposing`）では、ショートカットを発火させない」を、次の規則（DT-APP-001）で守る。上から評価し、最初に当たった行で決める。

| # | 条件 | 扱い |
| --- | --- | --- |
| 1 | `event.isComposing` が真、または `event.keyCode === 229` | どのショートカットにも使わない。2 打の列の待ちも解く |
| 2 | 最後の `compositionend` と同じイベントループの回の `keydown` の `Enter`・`Esc` | 使わない（確定の `Enter` でイシューを送らない、変換の取り消しの `Esc` で画面を閉じない） |
| 3 | フォーカスが編集の領域（`input`、`textarea`、`contenteditable`）にあり、修飾キー（`Cmd`・`Ctrl`・`Alt`）がない | 使わない。例外は `Esc`（規則 1・2 の後で） |
| 4 | フォーカスが編集の領域にあり、修飾キーがある | `editable` と `global` の範囲の Action だけ |
| 5 | それ以外 | 5.1 節の解決 |

- 規則 1 は MDN の勧める判定のとおり（2.2 節）。規則 2 は、`compositionend` が `keydown` の前に来るブラウザへの備えで、`keyCode === 229` が付かない場合があるかは**未検証**。E6 の前の `ime-shortcut-poc` で主要な組み合わせを記録して決める。
- 一覧にフォーカスがある（編集の領域がない）とき、IME をオンにしたまま英字のキーを押した場合の `key` の値（`Process` になるか）は**未検証**。`Process` のときは規則 1 と同じく使わず、画面の隅に「入力モードを英数に」と短く示す。これも `ime-shortcut-poc` で確かめる。
- コマンドメニューの入力欄は、組み立て中の文字でも絞り込む（`input` のイベントの `value` に組み立て中の文字が入る）。組み立て中の `Enter` で Action を実行しない（規則 1・2）。
- 確かめる組み合わせ：macOS（日本語入力、Google 日本語入力、ATOK）× Chrome・Safari・Firefox・Electron、Windows（Microsoft IME、Google 日本語入力）× Chrome・Edge・Firefox・Electron。Figma の題材の組み合わせ（Figma の editor-and-tools.md の 9.2 節）と同じ。

## 6. コマンドメニュー

ADR-0017。

- 開くと、今の文脈（選んだイシュー、開いているイシュー、今のビュー）で `when` が真の Action を、最近使った順に出す。
- 候補の元：
  | 元 | 中身 | 置き場所 |
  | --- | --- | --- |
  | Action | 5.1 節の登録。`title` と `keywords`（日本語と英語） | メモリー |
  | 移動 | チーム、ビュー、プロジェクト、サイクル、設定の画面 | M1 |
  | イシュー | 識別子とタイトル | M2 の `identifier`・`title_norm` の列 |
  | 利用者・ラベル | 名前 | M1 |
- **照合**：入力と候補を、NFKC で正規化し、英字を小文字にし、カタカナをひらがなに寄せる。英字は語の頭の部分列（`chpr` → 「change priority」）、日本語は部分一致。イシューの識別子（`ENG-12`）は前方一致で最初に出す。
- **並べ方**：完全一致 → 識別子の前方一致 → 語の頭の一致 → 部分一致の順。同じ段では、最近使ったもの、今のチームのものを先に。1 回に 50 件まで描く。
- **予算**：開くまでと、1 打ごとの絞り込みを p99 50ms（NFR-001）。イシューの照合は M2 の `title_norm`（正規化した文字の列。[client-store-and-offline.md](client-store-and-offline.md) の 7.1 節）を順に走査する。入力が前の入力を伸ばしたものなら、前の結果の中だけを走査する。M2 にないイシュー（部分のブートストラップの外）は、「サーバーで探す」の候補を出し、search の領域の問い合わせに渡す。
- M2 の走査が予算を超える大きさ（部分のブートストラップのイシュー 10 万件で超えるか）は E6 のベンチマークで測る。超えたら、bigram の索引を Web Worker に持つ ADR を書く。

## 7. Action と画面の約束

- Action は、トランザクションを作る関数か、画面を移る関数のどちらか。1 回の Action は 1 つのトランザクション（一括は 4.3 節）。
- Action は、手元の `view` の値で `when` と入力を決める。サーバーの判定（`can()`）はクライアントでも共有のコードで評価し、許されない Action は候補に出さない。サーバーの拒否は、拒否の一覧に出す（[client-store-and-offline.md](client-store-and-offline.md) の 9.4 節）。
- 候補のメニュー（`P` の優先度など）は、開くのも絞るのも NFR-001 の対象。候補は M1 の `instant` のモデル（状態、ラベル、利用者）から出す。

## 8. 一覧とボード

ADR-0018。

- 仮想化は `@tanstack/virtual-core`（3.17.11、MIT。第三者の汎用の部品）を `src/virtual/` で包んで使う。画面のコードは包みの API だけを使う。
- **一覧**：1 行 36px の固定。グループの見出しも 36px の行として同じ列に入れる。見える行の前後に 10 行ずつ多く描く。
- **ボード**：列ごとに縦の仮想化。カードは 3 つの固定の高さ（ラベルなし、ラベル 1 段、ラベル 2 段）から選び、測らない。列そのものも横に仮想化する（列が 20 を超える場合）。
- **行ごとの購読**：行の部品は `useModel(id)` で自分の行だけを購読する。一覧の部品は、並び（ID の配列）だけを購読する。1 件のイシューの状態の変更で描き直すのは、その行と、並びが変わればその区間だけ。
- **フォーカスの行**：キーボードのフォーカスのある行は、画面の外に出ても描いたままにする（仮想化で外さない）。スクリーンリーダーの位置と、`J`・`K` の続きを保つため。
- 一覧は `role="grid"`、行は `aria-rowindex` と `aria-rowcount` を持ち、仮想化しても全体の件数と位置を伝える。
- **並べ替えのドラッグ**：ドラッグの間は手元だけで動かし、落とした時に 1 つのトランザクション（並びの鍵の `set`）にする。キー操作（`Alt+↑/↓`）でも同じことができる。

## 9. 遅延の予算と計測

ADR-0018。NFR-001：入力から描画まで p99 50ms（基準の端末、イシュー 50 万件のワークスペース）。

### 9.1 内訳

| 区間 | 予算（p99） |
| --- | --- |
| イベントの配送と keymap の解決 | 2ms |
| Action、トランザクションの作成、`derive` | 3ms |
| プールへの適用と、触れたモデルの `view`・並びの計算し直し | 10ms |
| React の描画と commit | 15ms |
| スタイル・レイアウト・描画 | 10ms |
| 余裕（GC、他の仕事） | 10ms |

- 50ms を超える長い仕事（long task）を、入力の経路と、差分の適用（差分のパケットは 1 回 5ms までに分けて当てる）で作らない。

### 9.2 印

- 開始はイベントの `event.timeStamp`。終わりは、React の commit の後の `requestAnimationFrame` の中で `MessageChannel` に投げた次の仕事の時刻（描画の直後の近似）。Action の ID ごとに `performance.measure` を残す。
- Event Timing（`durationThreshold: 16`）の `duration` も集め、自前の印と突き合わせる。16ms 未満の操作は Event Timing に出ないので、p99 の計算には自前の印を使う。Event Timing は、印の抜けや、印の外の遅れ（イベントの配送の前の待ち）を見つけるために使う。

### 9.3 RUM

- Action の ID ごとの遅延のヒストグラム（10% の抜き取り）、長い仕事の件数、ヒープの p95（[client-store-and-offline.md](client-store-and-offline.md) の 7.2 節）を、ワークスペースの大きさの帯・ブラウザ・Electron の別に送る。
- 送るのは数と ID（Action の ID、ビューの種類）だけ。タイトルや識別子を送らない。外部の分析の事業者へは送らない（法務の L2 の外部送信の規律。自前の収集の口に送る）。

### 9.4 CI のベンチマーク

- **機械**：基準の端末（4 年前の中位のノート PC 相当）と同じ級の、型番を固定した自前のランナーを使う。クラウドの共有のランナーは、隣の負荷で揺れるので使わない。
- **較正**：毎回、決まった計算の較正のベンチマークを先に走らせ、基準の値から 5% 以上ずれたら、その回を無効にしてやり直す。
- **データ**：合成したワークスペース（イシュー 50 万件、部分のブートストラップの後の手元の状態）を IndexedDB の写しとして用意し、毎回そこから起動する。本物のデータを使わない（AGENTS.md）。
- **場面**：状態・優先度・担当・ラベルの変更、並べ替え、コマンドメニューを開く・3 文字の絞り込み、一覧とボードの切り替え（読み込み済み）、1,000 件の一括の変更の最初の描画、差分 100 件の受信の最中の状態の変更。各 300 回。
- **判定**：どれかの場面の p99 が 50ms を超えたら PR を失敗させる。main の中央値から 10% 以上遅くなったら警告する。ブラウザは Chrome（Playwright）で必須、Firefox・Safari は夜間。
- 予算を超えた PR を、期待の緩和やテストの外しで通さない（AGENTS.md）。

## 10. Web の起動と Service Worker

- 手元からの起動（NFR-003：p95 1.5 秒）とオフラインの起動のため、Service Worker がアプリの殻（HTML、ハッシュ付きの JS・CSS、フォント、アイコン）を前もってキャッシュする。
- API・Sync API の応答は Service Worker でキャッシュしない（手元のデータは IndexedDB だけに持つ。Slack の題材の client.md の 6 節と同じ）。
- 新しい版の殻は背景で取り、次の起動で使う。`min_build` より古い殻で `upgrade_required` を受けたら、「更新して再読み込み」を示す（[sync-engine.md](sync-engine.md) の 9.2 節）。移行の前の outbox のまとめは [client-store-and-offline.md](client-store-and-offline.md) の 6.2 節に従う。

## 11. Electron のシェル

- **読み込み**：レンダラーは Web と同じ成果物を `https://<brand>.<domain>` から読み込み、同じ Service Worker でオフラインの起動を支える。Notion の題材（Notion の editor.md の 11 節）と同じ形。手元の保存は Electron のセッションの区画の IndexedDB で、ブラウザとは分かれる（ADR-0005）。
- **設定**（Electron のチェックリストに従う）：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webSecurity: true`、`allowRunningInsecureContent: false`、実験の機能を使わない。`setPermissionRequestHandler` で通知だけを許す。`will-navigate` と `setWindowOpenHandler` で、自分のオリジン以外を止め、`https:` の外部のリンクだけを既定のブラウザで開く（`shell.openExternal` にはスキームを確かめた URL だけを渡す）。fuses で `runAsNode` などを切る。
- **preload**：`contextBridge` で出す API は、通知、バッジの数、ディープリンクの受け取り、自動更新の状態、ウィンドウの操作だけ。main の IPC の受け手は、送り手のフレームのオリジンを確かめる。
- **ディープリンク**：`<brand>://<ws>/issue/<KEY>-<number>` の形。スキームの名前は [リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従い、開発リポジトリの作成の時に決める。main は URL を解析し、自分のルート（3.3 節）の形に合うものだけをレンダラーに渡す。macOS は `open-url` を `ready` の前に登録し、Windows は `requestSingleInstanceLock` と `second-instance` で受ける。
- **通知**：Web の Notification API をレンダラーから使い、許可は `setPermissionRequestHandler` で決める。通知の文面に何を入れるか（タイトルを入れるか）は notifications-and-inbox の領域と法務の L4 で決める。
- **複数のウィンドウ**：Web の複数のタブと同じに扱う。書き手の選出と通知（ADR-0015）がそのまま効く。
- **自動更新**：`autoUpdater`（Squirrel）で、署名と公証（macOS）をした配布物を、S3・CloudFront の静的な置き場から配る。段階的な出し方と最低の版は delivery の領域で決める。
- Electron の新しいメジャーには、出てから 8 週以内に上げる（Notion の題材と同じ）。

## 12. アクセシビリティと国際化

- WCAG 2.2 AA。Slack の題材の client.md の方針を引き継ぎ、違うところだけを書く。
- すべての Action は、キーボードとコマンドメニューとメニューのどれからも実行できる（マウスだけの操作を作らない）。ドラッグの並べ替えにはキー操作の代わりがある（8 節）。
- 一覧は 8 節の `grid`。候補のメニューとコマンドメニューは combobox のパターン。操作の結果（「優先度を High に」）を `aria-live="polite"` で短く伝える。
- 手動の確認は VoiceOver と NVDA で、一覧の移動・選択・一括の変更・コマンドメニューを行う。
- 表示は ICU MessageFormat と FormatJS（ja・en）。Action の `keywords` は両方の言語で持ち、どちらでも引ける。日本語の文の折り返しは `line-break: strict`。

## 13. 障害のときの振る舞い

| 事象 | 起きること | 備え |
| --- | --- | --- |
| 予算を超える操作が本番で出た | 操作が重く感じる | RUM の Action ごとの p99 の監視。E6 の後は、超えた Action を次の Intent にする（Maintain） |
| IME の不具合（組み立て中にショートカットが動く） | 意図しない変更が送られる | 5.3 節の規則。`ime-shortcut-poc` と手動の確認表。見つかれば Undo で戻せる |
| レンダラーが落ちた（Electron） | 画面が消える | main がウィンドウを作り直す。outbox にコミット済みの変更は失わない |
| Service Worker の殻が壊れた・古い | 起動しない、古い画面 | 殻の取得の失敗でネットワークから直接読む。`min_build` で古い殻を止める |
| 仮想化で行の高さが合わない（長いタイトル） | 重なり・隙間 | 高さを固定し、タイトルは 1 行で省略する |
| ディープリンクの不正な URL | 意図しない画面・外部の URL | 3.3 節の形だけを受け、他は無視してログに数だけ残す |

## 14. セキュリティ

- CSP：`script-src 'self'`（インラインのスクリプトなし、`eval` なし）、`connect-src` は自分の API・Sync の WebSocket・添付の上げ先、`img-src` は自分と `<brand>usercontent.<domain>`、`frame-src 'none'`、`object-src 'none'`。Trusted Types を有効にする。
- 利用者の書いた文字は React の文字として描く。HTML を差し込むのはエディタのスキーマを通した描画だけ（[editor-and-descriptions.md](editor-and-descriptions.md) の 11 節）。
- Electron は 11 節の設定。リモートの中身で Node.js を使わない。
- RUM とエラーの報告に、利用者の書いた中身と識別子を入れない（9.3 節）。
- クリップボードへのコピー（識別子、URL、Markdown）は、利用者の操作の時だけ行う。

## 15. テスト

- 表駆動テスト：5.3 節の IME と編集の領域の規則の表（DT-APP-001）。合成のキーのイベントで全行を確かめる。
- 性質ベーステスト：
  - **PROP-APP-001（組み立て中の抑止）**：任意の `compositionstart`・`compositionupdate`・`compositionend`・`keydown` の列（ブラウザごとの順序の違いを含む）で、`isComposing` が真か `keyCode` が 229 の `keydown`、および 5.3 節の規則 2 に当たる `keydown` から、Action が 1 つも実行されない。
  - **PROP-APP-002（選択の安定）**：任意の差分（並びの変更、行の追加・削除）の列の後、選択は同じ ID の集合（消えた行を除く）で、フォーカスの行は描かれている。
  - **PROP-APP-003（Undo）**：任意の Action の列の後、同じ数の Undo で、`view` が最初の値に戻る（他の人の変更がない場合）。
- 例示テスト：5.2 節の各割り当て、2 打の列の待ちと取り消し、範囲の優先。
- IME：5.3 節の組み合わせの手動の確認表と、Playwright の合成の組み立てのイベントの自動のテスト。
- 遅延：9.4 節のベンチマークを CI の必須のチェックにする。
- Electron：`webPreferences` の値と fuses の値を、組み立てた成果物から読み出して確かめるテスト。ディープリンクの形の外の URL が無視されるテスト。
- アクセシビリティ：axe の自動の検査と、12 節の手動の確認。

## 16. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `latency-bench-harness` | 9.4 節の固定の機械のランナー、較正、合成のワークスペース、判定 |
| E1 | `rum-latency-marks` | 9.2・9.3 節の印、Event Timing、RUM の口（observability と共同） |
| E6 | `app-shell-and-routes` | 3.2・3.3 節の骨格、ルート、古い識別子の転送 |
| E6 | `input-path` | 4.1 節の経路、描画の後の outbox のコミット |
| E6 | `bulk-actions` | 4.3 節の一括の操作の分けた当て方 |
| E6 | `app-undo` | 4.4 節の Undo |
| E6 | `action-registry-and-keymap` | 5.1 節の Action の登録、範囲、2 打の列 |
| E6 | `ime-shortcut-poc` | 5.3 節の PoC（E6 の前）：イベントの順序、`Process` のキー |
| E6 | `ime-guard` | 5.3 節の規則と DT-APP-001・PROP-APP-001 |
| E6 | `default-shortcuts` | 5.2 節の割り当てと一覧のダイアログ（L8 の後に承認） |
| E6 | `command-menu` | 6 節の候補、照合、並べ方、サーバーの検索への渡し |
| E6 | `virtual-list` | 8 節の一覧、行ごとの購読、フォーカスの行 |
| E6 | `virtual-board` | 8 節のボード |
| E6 | `drag-reorder` | 8 節の並べ替えとキーの代わり |
| E6 | `latency-budget-gate` | 9 節の全場面を E6 のリリースの基準に |
| E6 | `service-worker-shell` | 10 節 |
| E6 | `electron-shell` | 11 節の設定、preload、IPC の確かめ、複数のウィンドウ |
| E6 | `electron-deep-links` | 11 節のディープリンク |
| E9 | `desktop-notifications` | 11 節の通知（notifications-and-inbox と共同） |
| E6 | `electron-auto-update` | 11 節の自動更新（delivery と共同） |
| E3 | `offline-status-ui` | オフラインの表示（[client-store-and-offline.md](client-store-and-offline.md) の 13 節と同じ Story） |

## 17. 未解決の問い

- ショートカットの仕組みを自前で作るか、既存の部品を使うか。
- IME の判定を `isComposing` だけにするか、`keyCode === 229` も見るか。
- 仮想化を自前で作るか、部品を使うか。行の高さを測るか、固定にするか。
- 遅延を Event Timing だけで測るか、自前の印も持つか。
- CI のベンチマークの機械をクラウドにするか、固定の機械にするか。
- Electron のレンダラーを、リモートのオリジンから読むか、アプリに同梱するか。
- Electron のシェルの決定を ADR にするか。

### 決定

2026-09-28 の既定案。E6 の前の PoC と E1 のベンチマークで覆りうる。

- **ショートカット**：自前の Action の登録と keymap。コマンドメニュー・メニュー・一覧のダイアログと同じ登録にする（ADR-0017）。
- **IME**：`isComposing || keyCode === 229` と、`compositionend` と同じ回の `Enter`・`Esc` の抑止。編集の領域では修飾キーのない 1 打を使わない（ADR-0017）。
- **仮想化**：`@tanstack/virtual-core` を包んで使い、行の高さは固定（ADR-0018）。
- **計測**：自前の印を正にし、Event Timing で抜けを見る（ADR-0018）。
- **CI の機械**：型番を固定した自前のランナーと較正（ADR-0018）。
- **Electron のレンダラー**：リモートのオリジン（`https://<brand>.<domain>`）から読み、Service Worker でオフラインの起動を支える。Notion の題材と同じ。
- **Electron の ADR**：シェルの設定はチェックリストのとおりで、選択肢の比べ合いがないので ADR にしない。自動更新と最低の版の決定は delivery の領域の ADR（0055–0057）に任せる。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| `compositionend` の後の `keydown` に `keyCode === 229` が付かない組み合わせがあるか。IME がオンのまま英字を押したときの `key` | E6 の前の `ime-shortcut-poc` |
| コマンドメニューの M2 の走査が、10 万件で p99 50ms に収まるか | E6 のベンチマーク。超えたら Worker の bigram の索引の ADR |
| 反応型のストア（MobX か自前か）が 9.1 節の内訳に収まるか | E2 の PoC（ADR-0001） |
| 本家の 1 打の割り当て（`S`・`A`・`L`・`E`）、画面の実装 | 公式の資料では確かめられない（**未検証**のまま）。寄せ方は法務の L8 |
| RUM の送り先と外部送信の規律の公表 | 法務の L2 と observability の領域 |

## 18. quality.md・runbooks・data-model への項目

### quality.md

- NFR-001 の判定：9.4 節の CI のベンチマークの全場面の p99 ≤ 50ms を、E6 のリリースの基準と、以後の全 PR の必須のチェックにする。
- 本番：Action の ID ごとの p50・p99、長い仕事の件数、Event Timing の 104ms を超えた操作の割合を、ブラウザ・Electron・ワークスペースの大きさの帯の別に日次で見る。
- IME の手動の確認表（5.3 節の組み合わせ）を、ブラウザ・Electron の大きな版の更新のたびに流す。IME の重大な不具合（組み立て中の誤った実行）0 件を E6 のリリースの基準にする。
- a11y：axe の自動の検査で重大な違反 0 件。12 節の手動の確認。
- Electron：`webPreferences` と fuses の検査を、配布物ごとに流す。

### runbooks

- `latency-regression.md`：RUM の p99 が 50ms を超えたときの確かめ方（どの Action、どのブラウザ、ワークスペースの大きさ、直前のリリース）と、フラグでの切り戻し。
- `ime-regression.md`：ブラウザ・OS・IME の更新で組み立て中の誤った実行が報告されたときの、組み合わせの絞り込み、PoC の記録との比べ、5.3 節の規則 2 の切り替えのフラグ。
- `electron-release-halt.md`（[runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) の C にまとめた）：Electron の配布物に問題が出たときの、自動更新の停止と前の版への戻し（delivery の領域と共同）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 | 節 |
| --- | --- | --- |
| M2 の列 `identifier`・`title_norm` | コマンドメニューの照合 | 6 |
| ブラウザ `localStorage` | 最後に開いたビュー、一覧とボードの別、パネルの幅（端末だけ。同期しない） | 3.3 |
| Service Worker のキャッシュ | アプリの殻 | 10 |
| RUM の収集の口 | Action の ID ごとの遅延のヒストグラム、長い仕事、ヒープ | 9.3 |

## 出典

いずれも 2026-09-28 に確認。

- Linear Docs, [Download Linear](https://linear.app/docs/get-the-app)、[Create issues](https://linear.app/docs/creating-issues)、[Priority](https://linear.app/docs/priority)、[Select issues](https://linear.app/docs/select-issues)（検索の抜粋で確認）、[Issue relations](https://linear.app/docs/issue-relations)、[Edit issues](https://linear.app/docs/editing-issues)、[Triage](https://linear.app/docs/triage)、[Delete and archive issues](https://linear.app/docs/delete-archive-issues)
- MDN, [KeyboardEvent.isComposing](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/isComposing)、[Element: keydown event](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event)、[Element: compositionend event](https://developer.mozilla.org/en-US/docs/Web/API/Element/compositionend_event)、[PerformanceEventTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming)
- Electron, [Security](https://www.electronjs.org/docs/latest/tutorial/security)、[Updating Applications](https://www.electronjs.org/docs/latest/tutorial/updates)、[Deep Links](https://www.electronjs.org/docs/latest/tutorial/launch-app-from-url-in-another-app)
- npm, [@tanstack/virtual-core](https://www.npmjs.com/package/@tanstack/virtual-core)（3.17.11）

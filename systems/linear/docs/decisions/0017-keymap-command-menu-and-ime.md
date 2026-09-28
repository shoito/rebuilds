---
status: accepted
date: 2026-09-28
---

# ADR-0017: 操作は 1 つの Action の登録にまとめ、ショートカット・コマンドメニュー・メニューが同じ登録を使う。キーは入れ子の範囲の順に解決し、組み立て中（`isComposing` か `keyCode === 229`）のキーはどのショートカットにも使わない

## Context

この題材は「キーボードだけで、待たずに」課題を管理できることを価値にしている（[intent.md](../intent.md)）。本家は、`C`（作成）、`P`（優先度）、`X`（選択）、`G` の後のキー（移動）、`M` の後のキー（関連）、`Cmd/Ctrl+K`（コマンドメニュー）、Triage の `1`・`2`・`3`・`H` などの、修飾キーのない 1 打や 2 打の列のショートカットを持つ（[Create issues](https://linear.app/docs/creating-issues)、[Priority](https://linear.app/docs/priority)、[Issue relations](https://linear.app/docs/issue-relations)、[Triage](https://linear.app/docs/triage) ほか、2026-09-28 に確認）。

利用者は日本語の IME を使う（[intent.md](../intent.md)）。AGENTS.md は「日本語の変換の途中（`isComposing`）では、ショートカットを発火させない」と決めている。MDN は、組み立ての一部の `keydown` を無視するには `isComposing` と `keyCode === 229` の両方を見るよう勧め、`compositionend` が `keydown` の前に来る場合に `isComposing` が偽になりうると書いている（[Element: keydown event](https://developer.mozilla.org/en-US/docs/Web/API/Element/keydown_event)、2026-09-28 に確認）。

コマンドメニューの表示と絞り込みは NFR-001（p99 50ms）の対象である。

## Options

仕組み：

1. **自前の Action の登録と keymap。ショートカット・コマンドメニュー・右クリックのメニュー・一覧のダイアログが同じ登録を使う**
2. 既存のショートカットの部品（`tinykeys`・`react-hotkeys-hook` など）と、コマンドメニューの部品（`cmdk` など）を別々に使う

IME の判定：

- a. **`isComposing || keyCode === 229` と、`compositionend` と同じイベントループの回の `Enter`・`Esc` の抑止**
- b. `isComposing` だけ

## Decision

1 と a を採用する。詳細は [client-app.md](../architecture/client-app.md) の 5〜7 節。

- Action は `{id, title, keywords, shortcut?, scope, when(ctx), run(ctx)}`。ショートカット、コマンドメニュー、メニュー、一覧のダイアログは、この登録だけから作る。
- 範囲は `global` → `view` → `detail` → `overlay` → `editable` の入れ子。フォーカスのある最も内側から探し、最初に `when` が真の Action を実行する。2 打の列は 1 打目の後 1,000ms 待ち、列にない 2 打目では何もしない。
- 英字と記号は `event.key` で照らす。英字でない配列では `event.code` で照らす。記号を `code` で照らさない（JIS と US の違い）。
- IME の規則（DT-APP-001）：`isComposing` か `keyCode === 229` のキーは使わない。`compositionend` と同じ回の `Enter`・`Esc` は使わない。編集の領域では、修飾キーのない 1 打を使わない（`Esc` を除く）。IME がオンのままのキー（`key === "Process"`）も使わない。
- コマンドメニューは、Action・移動の先・M2 のイシュー（識別子と正規化したタイトル）・利用者・ラベルを候補にし、NFKC・小文字・カタカナのひらがなへの寄せで照らす。入力を伸ばした時は前の結果の中だけを走査する。M2 の外はサーバーの検索に渡す。
- 既定の割り当ては、本家の文書に出るものと、課題管理のツールで一般的なものに限る。寄せ方は法務の L8 の後に見直す。利用者の割り当ての変更は MVP で持たない。
- 2 を採らない理由：ショートカットとコマンドメニューで操作の定義が 2 つになり、`when`（今できるか）と IME の規則を両方に書くことになる。範囲の入れ子と 2 打の列、IME の抑止の規則を 1 か所で持つ部品は見当たらない（本システムの評価）。登録と解決は数百行で書ける。
- b を採らない理由：MDN が書くとおり、`compositionend` が `keydown` の前に来るブラウザでは、確定の `Enter` の `isComposing` が偽になり、イシューを送ったり画面を閉じたりしうる。

## Consequences

- 良くなること：
  - すべての操作が、キー・コマンドメニュー・メニューのどれからも同じ意味で使える。
  - IME の規則が 1 か所にあり、表駆動テストと性質ベーステストで確かめられる。
- 引き受けるコスト：
  - keymap とコマンドメニューを自前で保守する。
  - `compositionend` と同じ回の `Enter` の抑止で、IME を使わない人の極めてまれな素早い入力を落としうる。
  - IME がオンのまま英字を押した人には、ショートカットが効かない（画面で英数への切り替えを促す）。

## Confirmation

- 表駆動テスト：DT-APP-001 の全行を、合成のキーのイベントで。
- 性質ベーステスト：PROP-APP-001（組み立て中の抑止）。
- E6 の前の `ime-shortcut-poc` で、[client-app.md](../architecture/client-app.md) の 5.3 節の OS × IME × ブラウザの組み合わせのイベントの順序を記録し、規則 2 の要否と `Process` の扱いを確かめる。
- lint：`keydown` の受け手を `src/keymap/` の外に書かない（エディタの中の ProseMirror の keymap を除く）。
- ベンチマーク：コマンドメニューを開く・3 文字の絞り込みの p99 50ms（[ADR-0018](0018-render-path-and-latency-budget.md)）。

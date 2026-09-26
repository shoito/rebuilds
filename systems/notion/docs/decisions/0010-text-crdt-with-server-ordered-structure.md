---
status: accepted
date: 2026-09-26
---

# ADR-0010: テキストはブロックごとの CRDT（Fugue＋Peritext）で統合し、構造とプロパティはサーバーの順序で決める

## Context

ADR-0005 は、変更をトランザクションで送り、サーバーがページごとの `seq` で順序を確定すると決めた。テキストの同時編集の統合の方式は、[collaboration.md](../architecture/collaboration.md) に委ねていた（[intent.md](../intent.md) の未解決の問い）。

満たすべきこと：

- 同時に編集しても全員の画面が収束し、入力が失われない。オフラインの長い編集も統合される（intent の「守るべき振る舞い」、NFR-005）。
- 書式（太字、リンク、コメントの範囲）が、同時の編集で壊れない。
- ブロックの木の不変条件と権限を、サーバーで守れる（ADR-0002、ADR-0004）。

本家は、以前は同じブロックへの同時の編集が LWW で失われていた。2025 年 7 月に、RGA に Peritext の書式の操作を足した CRDT を入れ、ブロックの分割・結合を「text slice / text instance」で扱うようにした（[How Notion handles concurrent editing with CRDTs](https://www.notion.com/blog/how-notion-handles-concurrent-editing-with-crdts)）。テキスト以外のプロパティは今も合わさらない（[ヘルプ](https://www.notion.com/help/use-pages-offline)）。

## Options

1. **OT**：Google Docs（[Making collaboration fast](https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs.html)）、ProseMirror の collab（[guide](https://prosemirror.net/docs/guide/#collab)）の方式。中央の権威が版を進め、クライアントは確定していない操作を変換して載せ直す
2. **ページ全体を 1 つの CRDT 文書にする**：Yjs、Automerge、Loro で、テキストとブロックの木とプロパティをすべて CRDT で持つ
3. **サーバーの順序＋ブロック内テキストの CRDT**：構造とプロパティはサーバーが `seq` の順に当て、テキストだけを CRDT で持つ。
   - 3a：テキストの CRDT に既存のライブラリ（Loro、Yjs、Automerge）を使う
   - 3b：Fugue＋Peritext を TypeScript で自前に実装する

## Decision

3b を採用する。詳細は [collaboration.md](../architecture/collaboration.md) の 4〜6 節。

- **1 を採らない理由**：オフラインの長い編集では、基にした版から後の全操作と変換する必要があり、ログを長く残し、統合が遅くなる（[Eg-walker](https://arxiv.org/abs/2409.14252) は、長く分岐した枝の統合で OT が遅いことを示している）。ProseMirror のガイドも、長い分岐を扱っていない。リッチテキストとブロックの木の変換関数の組み合わせは、Figma が OT を避けた理由と同じく、正しさを確かめにくい（[How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)）。
- **2 を採らない理由**：CRDT は定義上どの操作も受け入れるので、サーバーが木の不変条件（循環がない）や権限に反する変更を拒否できない。ブロックを 1 行ずつ保存し、ブロック単位で権限・検索・同期を行う ADR-0002・0004 と合わない。ページ全体を 1 つの文書として読み書きする必要も出る。
- **3 を採る理由**：構造とプロパティの競合は、サーバーの順序と決まった規則（ADR-0011、0012）で十分に決められ、サーバーで検証できる。テキストの入力だけは、どの順で届いても失わずに合わせる必要があり、CRDT がこれを保証する。本家の現在の方式とも同じ形である。
- **列の CRDT に Fugue を使う**（[The Art of the Fugue](https://arxiv.org/abs/2305.00583)）。本家の RGA は、同じ位置への同時の挿入で文が交ざる場合がある。Fugue はこれを最小にする性質を持ち、長いオフラインの編集で効く。
- **書式は Peritext に従う**（[Peritext](https://www.inkandswitch.com/peritext/)）。書式の両端を文字の ID で指し、境界で広がる書式（太字）と広がらない書式（リンク、コメント）を分け、重なる書式は両方残し、排他的な値は後の操作が勝つ。
- **分割・結合は本家の text slice に倣う。** Peritext は段落をまたぐ構造を扱わないため。テキストをインスタンスに属させ、分割は文字の範囲を別のブロックへ移すこととし、サーバーが「範囲 → 今のブロック」の索引を持つ。
- **3a ではなく 3b にする理由**：
  - 分割・結合のために、文字の ID と範囲の索引をサーバーの表で扱う必要があり、ライブラリの内部の形式に依存したくない。
  - サーバーの検証と展開（検索・API 向けのリッチテキスト）を、クライアントと同じ TypeScript のコードで行える。WASM のライブラリをサーバーに持ち込まずに済む。
  - Loro は Fugue と Peritext 相当の書式を持ち（[Loro の rich text](https://loro.dev/blog/loro-richtext)）、最も近い選択肢である。自前の実装が性質ベーステストで収束を示せないときの代替として残す。
- 墓標は消さない。中身の文字列は消し、ID の範囲だけを run で残す。何か月も前の版を基にした操作でも、アンカーが必ず見つかる。

> 2026-09-27 の注記：Decision の「Fugue はこれを最小にする性質を持つ」は正確でない。交ざりを最小にする性質（maximal non-interleaving）が証明されているのは変種の FugueMax で、Fugue が保証するのは前向き（左から右へ）の連続した入力が交ざらないことである（[The Art of the Fugue](https://arxiv.org/abs/2305.00583)、2026-09-27 に確認）。通常の入力は前向きなので、Fugue を採る決定は変えない。Confirmation の「互いの文が交ざらない」は、前向きの連続した挿入についての性質と読む。本家の CRDT（RGA＋Peritext の書式、text slice / text instance、2025 年 7 月の導入）と Peritext・Loro の記述は、出典のとおりであることを確かめた（2026-09-27）。

## Consequences

- 良くなること：
  - テキストの入力は、オフラインの期間と関係なく失われない。
  - サーバーは古い操作のログがなくても統合できる。ログは 30 日で畳める。
  - 構造とプロパティの検証、権限の判定を、これまでどおりサーバーで行える。
- 引き受けるコスト：
  - 列の CRDT と書式の実装を自前で持つ。正しさは、性質ベーステストと、論文の例の再現で確かめる。
  - 構造とプロパティの競合では、片方の値が負ける。負けた値を記録し、本人に見せる仕組みが要る（ADR-0011）。
  - 墓標の分だけ、ブロックの状態が大きくなる。

## Confirmation

- 性質ベーステスト：任意の並行・オフライン・順序の入れ替わり・重複のある操作の列で、全レプリカのテキストと書式が一致する。どの挿入も（削除されていなければ）結果に残る。
- 性質ベーステスト：2 つのレプリカが同じ位置へ別々に連続して挿入したとき、結果で互いの文が交ざらない（Fugue の性質）。
- 例のテスト：Peritext の論文の書式の例（境界での入力、リンクの末尾、重なる書式、排他的な値）を再現する。
- 性質ベーステスト：分割・結合と同時の入力の任意の組み合わせで、入力した文字がちょうど 1 つのブロックに現れる。
- サーバーの展開（`properties` のリッチテキスト）と、クライアントが CRDT から描画した結果が一致する。

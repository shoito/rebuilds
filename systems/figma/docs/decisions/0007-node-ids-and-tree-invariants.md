---
status: accepted
date: 2026-09-27
---

# ADR-0007: ノードの ID は `(session_id, local_id)`。`session_id` はジャーナルに記録してから渡し、木の不変条件は `doc-model` の検証器だけで確かめる

## Context

[ADR-0002](0002-central-authoritative-multiplayer.md) で、ノードの ID をセッションごとの番号とセッションの中の連番の組にし、セッションの番号はサーバーが振ると決めた（ADR-0002 の草案では `(client_id, counter)` と書いた。統合の工程で、この ADR の `(session_id, local_id)` に名前を揃えた）。クライアントはサーバーを待たずにノードを作れる。残る問いは次のとおり。

- セッションの番号の一意性を、どこで、どう保つか。Document Server が落ちて別の持ち主に移っても、同じ番号を二度振ってはならない。二度振ると、別の人が作ったノードの ID が重なる。
- ID の大きさ。ノードの数は 1 ファイル数十万になり、ID はすべての変更とチェックポイントに現れる。
- 木の不変条件（循環がない、親は 1 つ、種類の組み合わせ）を、どこで確かめるか。

本家は、クライアントごとの一意の ID をオブジェクトの ID に含める（[How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)、2019-10-16、2026-09-27 に確認）。本家の URL のノードの ID は `1:23` のような 2 つの数の形に見えるが、中身の意味は公開の資料で確かめられなかった（**未検証**）。

## Options

ID：

1. **`(session_id: u32, local_id: u32)`。`session_id` はファイルごとにサーバーが振り、ジャーナルに記録する**
2. **UUIDv7（128 ビット）をクライアントが振る**
3. **`(user_id, counter)`。利用者ごとに固定**

不変条件の検証：

- a. `doc-model` の 1 つの検証器を、クライアントとサーバーで呼ぶ
- b. サーバーだけで確かめる

## Decision

1 と a を採用する。詳細は [document-model.md](../architecture/document-model.md) の 5・6 節。

- `NodeId = (session_id: u32, local_id: u32)`。8 バイトで、LEB128 にすると多くの ID は 3〜5 バイトになる。
- `session_id` は、ファイルの状態の `next_session_id` から振る。振ったことを `session_open` の記録としてジャーナルに書き、書けてからクライアントに渡す（[ADR-0003](0003-journal-and-checkpoints.md)）。新しい持ち主は、チェックポイントとジャーナルから `next_session_id` を戻すので、同じ番号を二度振らない。
- `local_id` はクライアントが 1 から数える。`0:0` は `DOCUMENT`、`0:1` は最初のページ、`session_id = 0` はサーバーが作る操作に予約する。
- ID はファイルの中だけで一意。複製では変えず、別のファイルへの貼り付けでは振り直す。
- 消したノードの ID は、Undo で作り直すときに再び使える。生きている ID と同じ `create` は拒否する。
- 不変条件（document-model.md の 5 節の T1〜T9）は、`doc-model` の検証器だけに書き、クライアントは送る前、サーバーは当てる前に呼ぶ。サーバーの判定が正である。コンポーネントの領域の規則（インスタンスの参照の循環）も、同じ検証器に登録する形で足す。
- 2 を採らない理由：ID が 16 バイトになり、変更とチェックポイントが大きくなる。10 万ノードで 1.6 MB、参照（親、上書きのパス）を含めるとその数倍。
- 3 を採らない理由：同じ利用者が 2 つのタブで同じファイルを開くと、数え上げが衝突する。タブごとの状態の共有が要る。
- b を採らない理由：クライアントは、拒否される変更を画面に出してから取り消すことになり、ちらつきが増える。

## Consequences

- 良くなること：
  - ID が小さい。
  - 持ち主が変わっても、ID が重ならない。
  - 不変条件の規則が 1 か所にある。
- 引き受けるコスト：
  - 接続のたびに、ジャーナルへの書き込み 1 回が要る（`session_open`）。接続の確立が数十 ms 延びる。
  - セッションの表が、長く使われたファイルで育つ。30 日使われていないセッションは、チェックポイントの表から外す（`next_session_id` は戻さない。[multiplayer.md](../architecture/multiplayer.md) の 4.4 節）。

## Confirmation

- 障害注入のテスト：`session_open` の直後に Document Server を落とし、新しい持ち主が同じ `session_id` を振らない。
- 性質ベーステスト：任意の接続・切断・持ち主の交代の列で、振られた `session_id` がすべて異なる。
- 性質ベーステスト：任意の変更の列の後、T1〜T9 が成り立つ（document-model.md の PROP-DM-001）。

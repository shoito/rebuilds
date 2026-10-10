---
status: accepted
date: 2026-09-26
---

# ADR-0006: ref の更新は、3 つの複製で 3 相の手順を回し、DB のチェックサムの CAS で順序を決める

ADR-0003（3 つの複製）の書き込みの合意を具体化する。詳細は [git-storage.md](../architecture/git-storage.md) の 5 節。

## Context

ADR-0003 で、push は 3 つの複製のうち 2 つ以上で書けたら成功とすると決めた。決めることは次のとおり。

- 複数の複製の ref を、どう同じ内容・同じ順序で更新するか。
- 同じリポジトリへの並行な push を、どう直列にするか。
- 途中で調整役（coordinator）や複製が落ちたときに、「成功を返したのに失われた」状態をどう防ぐか。
- ADR-0005 の outbox の Event を、ref の更新と食い違わずに出すにはどうするか。

本家の Spokes は、3 相コミットで複製を更新し、複製を分散ロックとして使って DB の更新の順序を守る。複製の状態は `(refname, value)` のハッシュの XOR のチェックサムで比べる（[Stretching Spokes](https://github.blog/engineering/infrastructure/stretching-spokes/)）。厳密な過半数に書けない書き込みは受け付けない（[Building resilience in Spokes](https://github.blog/engineering/infrastructure/building-resilience-in-spokes/)）。

> 2026-09-28 の注記：Confirmation の `refs.updated` は、Decision の outbox の Event `repository.refs_updated` と同じものを指す。名前は `repository.refs_updated` にそろえた（[data-model.md](../architecture/data-model.md) の 4 節）。

## Options

1. **3 相の手順（prepare → DB に pending → commit → DB で確定）を coordinator が回す。順序は DB のチェックサムの CAS で決める**（Spokes に寄せる）
2. **主の複製を 1 つ決め、主が `receive-pack` を行い、他の複製が非同期に追う**（主従の複製）
3. **Raft などの合意のライブラリで、ref の更新のログを複製する**

## Decision

1 を採用する。

- 各複製で `git update-ref --stdin` のトランザクション（`start`・`prepare`・`commit`・`abort`）を使う。`prepare` で ref のロックを取り、旧値を確かめる。
- coordinator は Git フロントエンドのプロセスの中で動き、状態を持たない。状態は DB（`repository_checksums`、`ref_transactions`）と複製にだけある。
- 2 票以上が `ok` で、前後のチェックサムが一致したら、DB で `version` を CAS で予約し（`pending`）、`commit` を送る。2 つ以上の `ack` で、同じ DB のトランザクションで、チェックサムと `version` の確定、応答しなかった複製の `out_of_sync`、outbox の `repository.refs_updated` を書く。その後にだけクライアントに成功を返す。
- 途中で止まった `pending` は、回収のワーカーが複製のチェックサムを読んで、確定か中止かを決める。
- チェックサムは Spokes と同じく、全 ref の `(refname, value)` の SHA-256 の XOR とし、差分で更新する。
- 2 を採らない理由：主の障害時に、主にしか書かれていない更新を失う。成功を返す前に 2 つに書く、という NFR-002 を満たすには、同期の複製の仕組みが結局必要になる。
- 3 を採らない理由：Git のリポジトリそのもの（objects と ref）をステートマシンにするのは重い。ref の更新だけを合意すればよく、Git の本体のトランザクションとチェックサムで足りる。本家もこの形で運用している。

## Consequences

- 良くなること：
  - 成功を返した push は、2 つ以上の複製と DB のチェックサムに反映されている。
  - outbox の Event が、確定した ref の更新と 1 対 1 で、`version` の順に並ぶ（ADR-0005）。
  - 複製の一致を、チェックサムの比較だけで安く確かめられる。読み取りでも、同期している複製だけを選べる。
- 引き受けるコスト：
  - push ごとに、複製への 2 往復と DB への 2 回の書き込みがかかる。同じリポジトリの push は直列になる（CAS の競合は再試行を促すエラーになる）。
  - DB が落ちている間は push ができない。読み取りは続く。
  - 回収のワーカーと、`pending` の監視を作って保つ必要がある。
  - S3 でリージョンをまたいで同期の投票をするなら、往復の回数を減らす工夫が要る（本家の Stretching Spokes の課題）。当面はリージョンの中だけで投票する。

## Confirmation

- 性質ベーステスト：任意の並行な push の列と、手順の任意の時点での coordinator・複製の停止のあとで、成功を返した更新は 2 つ以上の複製と DB に反映されている。修復の後、3 つの複製のチェックサムは DB と一致する。
- 性質ベーステスト：outbox の `refs.updated` を `version` の順に適用した ref の写しが、Git の ref と一致する。
- 監視：`pending` の最古の経過時間、定期の照合の不一致の数。
- レビュー観点：クライアントへの成功の応答が、DB の確定の後にしかないこと。

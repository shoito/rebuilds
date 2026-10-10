---
status: accepted
date: 2026-10-10
---

# ADR-0039: change log の行は `(account_id, modseq, seq)` を鍵に種類・実体・ラベルの差分を持ち、日の分割で 30 日持つ。JMAP の状態の文字列は `<epoch>.<modseq>` で、型ごとの最後の `modseq` から作る。`Email/changes` は `modseq` の境で切って `maxChanges` を守る。`Email/queryChanges` は「1 つの箱・時刻の新しい順」の問い合わせだけに答える。大阪への切り替えでは `epoch` を進め、`modseq` を 2^24・UID の数えを 2^16 跳ばす

詳細は [client-sync-and-protocols.md](../architecture/client-sync-and-protocols.md) の 4・5 節。

## Context

- [ADR-0006](0006-sync-protocol-jmap-imap-and-modseq.md) は、アカウントごとの `modseq`、change log、30 日の保持、型ごとの最後の `modseq` を符号化した状態の文字列を決めた。行の形、`maxChanges` での切り方、`Email/query` の `queryState` と `Email/queryChanges` の範囲、DR の切り替えの扱いは決めていない。
- 大阪への切り替えはメタデータの RPO 1 分（NFR-004）。東京で書いて大阪に届かなかった変更の `modseq` を、切り替えの後に別の変更で使い直すと、その `modseq` を知るクライアントが差分を取り損ねる。IMAP の UID も同じ。
- `Email/queryChanges`（RFC 8620 の 5.6 節）は、任意の検索の文字列について正しく作るのが難しい。一方、受信箱の一覧の差分は、Web とアプリの最も多い要求である。

## Options

切り替え：

1. **`epoch` を状態の文字列に入れ、切り替えで進め、`modseq` と UID の数えを跳ばす**
2. 切り替えで全アカウントの `UIDVALIDITY` を変え、全員に取り直させる
3. 何もしない（RPO の 1 分の変更のずれを受け入れる）

queryChanges：

- a. **受信箱の一覧の形（1 つの箱、時刻の並び）だけに答える**
- b. すべての問い合わせに答える
- c. 答えない（`canCalculateChanges: false`）

## Decision

1 と a を採用する。

- 行：`(tenant_id, account_id, modseq, seq)` を主キーに、`kind`、`entity_type`、`entity_id`、`object_gen`、`label_ids_added`・`removed`、`flags_changed`。日の分割で 30 日。補助の `imap_vanished` を同じトランザクションで書く。
- 状態の文字列は `"<epoch>.<modseq>"`。`queryState` は条件のハッシュを足す。
- `Email/changes` は 1 つの `modseq` の行を分けずに、`maxChanges`（既定 500、上限 5,000）の手前の `modseq` で止める。範囲の中で作られて消えたものは返さない。
- `Email/queryChanges` は、`inMailbox` の 1 つだけ・`receivedAt` か `<brand>:inboxAt` の新しい順の問い合わせに答え、変更 2,000 で `tooManyChanges`。`collapseThreads` で範囲にスレッドの合わせがあれば `cannotCalculateChanges`。
- 切り替えでは、各アカウントの最初の書き込みで `epoch` を進め、`modseq` を 2^24、各箱の `uidnext` を 2^16 跳ばす。古い `epoch` の JMAP の状態は `cannotCalculateChanges`。IMAP で跳ばす前の `MODSEQ` からの差分は、全体の旗と、跳ばした範囲の UID の `VANISHED (EARLIER)` で返す。`UIDVALIDITY` は変えない。

### 他の案を選ばなかった理由

- **2**：200 万の IMAP のアプリ（S2）が一斉に全体を取り直し、切り替えの直後の負荷になる。消えた変更のないアカウントまで取り直す。
- **3**：既読・削除のずれが、利用者に見えないまま残る（NFR-006 の収束に反する）。
- **b**：任意の検索の差分は、索引とビットマップの過去の状態が要り、正しさを試験しにくい。
- **c**：受信箱の一覧の更新が、毎回の取り直しになる。

## Consequences

- 良くなること：
  - 切り替えの後も、JMAP と IMAP のクライアントが収束する。
  - 受信箱の一覧の差分を軽く返せる。
- 引き受けるコスト：
  - UID の数えが 32 ビットのため、跳ばしは 1 つの箱で約 6 万回の切り替えまで（実際の上限にならない）。
  - 検索の結果の一覧は、変わるたびに問い合わせ直す。

## Confirmation

- 性質ベーステスト：PROP-SYNC-001・003・004・006。
- DR の訓練（E17）で、切り替えの後の主な IMAP のアプリの振る舞いを確かめる。
- 監視：`cannotCalculateChanges` の率、`hasMoreChanges` の連続の数。

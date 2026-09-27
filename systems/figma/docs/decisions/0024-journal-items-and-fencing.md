---
status: accepted
date: 2026-09-27
---

# ADR-0024: ジャーナルは `seq` の範囲の group commit で、フェンスの `epoch` を確かめる `TransactWriteItems` と `ClientRequestToken` で書く。大きな変更は S3 に置き、TTL の漏れは回復のジョブで拾う

## Context

[ADR-0003](0003-journal-and-checkpoints.md) で、確定した変更を DynamoDB（PK `file_id`、SK `seq`）へ約 20ms ごとの group commit で書き、「その `seq` の項目がまだない」を条件にし、`checkpoint_seq` より古い項目を TTL で 30 日後に消すと決めた。書き込みの細部に、次の問題が残る。

- **二重の持ち主**：新旧の持ち主が、同じ `seq` から書き始めれば条件で片方が止まる。しかし、古い持ち主が新しい持ち主の回復の読み取りより後に書き足すと、新しい持ち主はその項目を知らないまま `seq` を振る。「項目がない」の条件だけでは、両者の書き始めの `seq` がずれたときの防御が弱い。
- **結果の分からない書き込み**：タイムアウトの後に再試行すると、前の試行が成功していれば条件で失敗し、「別の持ち主」と区別できない。
- **大きさ**：項目は 400 KB まで、トランザクションは 100 項目・4 MB まで（[Constraints in Amazon DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)）。大きな貼り付けは 1 項目に入らない。
- **TTL**：`checkpoint_seq` を越えた項目に TTL を後から付けると、書き直しの費用がかかる。書いた時点で付けると、落ちたまま 30 日開かれないファイルの、チェックポイントより後の項目が消える。

本家は、DynamoDB の別の表に `(lock UUID, file key)` を書いて持ち主になり、ジャーナルの書き込みを lock UUID の一致を条件にし、読み取りは強い整合性にした（[Making multiplayer more reliable](https://www.figma.com/blog/making-multiplayer-more-reliable/)、2022-10-20）。`TransactWriteItems` は、別の項目への `ConditionCheck` と `Put` を原子的に行え、`ClientRequestToken` で最初の完了から 10 分間冪等になる。同じ項目に進行中の操作があると `TransactionConflict` で取り消される（[TransactWriteItems](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html)）。TTL の削除は期限から数日以内で、消えるまでは読める（[Using time to live (TTL) in DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html)）。いずれも 2026-09-27 に確認。

## Options

フェンス：

1. **ジャーナルの表の `seq = 0` にフェンスの項目（`epoch`）を置き、`TransactWriteItems` の `ConditionCheck` で確かめる**
2. **Router の割り当ての項目（`file_leases`）を `ConditionCheck` で確かめる**
3. **ADR-0003 のとおり、`Put` の条件だけ**

TTL：

- a. **書いた時点で 30 日。落ちたまま手放していないファイルは回復のジョブで拾う**
- b. **チェックポイントを書いたときに、越えた項目の TTL を書き直す**
- c. **TTL を使わず、掃除のジョブで消す**

## Decision

1 と a を採用する。詳細は [file-storage-and-history.md](../architecture/file-storage-and-history.md) の 4 節。

- **書き込み**：`TransactWriteItems`（`ConditionCheck journal[file_id, 0] epoch = :mine`、`Put journal[file_id, start_seq] attribute_not_exists`）。`ClientRequestToken = hash(file_id, epoch, start_seq)`。一時的な失敗は同じトークンと同じ中身で再試行し、10 秒書けなければファイルを手放す。条件の失敗は、持ち主でなくなったとみなして手放す。
- **フェンス**：新しい持ち主は、Router の割り当ての `epoch`（[ADR-0047](0047-router-task-liveness-and-file-assignment.md)）でフェンスの項目を上げてから（`epoch < :E` を条件に）、ジャーナルを強い整合性で読む。フェンスの後、古い持ち主の書き込みはすべて失敗する。
- **group commit**：前の書き込みが終わっていて、20ms・256 KiB・500 件のどれかに達したら書く。同時に書くのは 1 つ。まとまりの中で、同じ `(ノード, プロパティ)` の前の操作を除く（間に `Create`・`Delete` がない場合）。
- **大きな変更**：圧縮した本体が 350 KiB を超えたら、S3 に置いてから、項目には `blob_key` とハッシュだけを書く。
- **TTL**：書いた時点で 30 日。Router は、持ち主のタスクの生存（`ds_liveness`）が切れ、手放しの記録（`released`・`handoff`）がない割り当てを見つけ、5 分以内に回復させてチェックポイントを書かせる（ADR-0047 の回復のジョブ）。1 日を超えて残ればアラーム。表は PITR（35 日）を有効にする。
- 2 を採らない理由：リースの延長（数秒ごと）とジャーナルの書き込み（毎秒数十回）が同じ項目に当たり、`TransactionConflict` が増える。
  - > 2026-09-27 の注記：[ADR-0047](0047-router-task-liveness-and-file-assignment.md) で、延長はタスクごとの生存の記録（`ds_liveness`）へ移り、割り当ての項目は割り当てと手放しのときだけ書くようになった。この理由は弱まったが、1 を保つ。フェンスをジャーナルと同じパーティションに置くと、世代ごとの回復（[ADR-0048](0048-osaka-dr-with-journal-generations.md)）がジャーナルの表の中で閉じ、グローバルテーブルの割り当ての表の複製の遅れに書き込みの判定が左右されない（[file-storage-and-history.md](../architecture/file-storage-and-history.md) の 4.2 節）。
- 3 を採らない理由：上の Context のとおり、書き始めの `seq` がずれた古い持ち主の書き足しを防げない。結果の分からない再試行を区別できない。
- b を採らない理由：チェックポイントのたびに、数千の項目の書き直しがかかる。
- c を採らない理由：削除の書き込みの費用がかかる。TTL の削除は、期限の来たリージョンでは書き込みの単位を使わない（上の TTL の資料）。グローバルテーブルの複製の先（大阪）では、複製の削除が複製の書き込みの単位を使う（同じ資料、2026-09-27 に確認。[capacity.md](../architecture/capacity.md) の 4.3 節）。掃除のジョブで消しても、同じく両方のリージョンで単位を使うので、a の方が安い。

## Consequences

- 良くなること：
  - 二重の持ち主で、ジャーナルが 2 つの列に分かれない。
  - 結果の分からない書き込みを、安全に再試行できる。
  - 大きな貼り付けも、項目の上限に当たらない。
- 引き受けるコスト：
  - トランザクションは書き込みの単位を 2 倍使う。1 ファイルの書き込みの上限が約半分になる（[multiplayer.md](../architecture/multiplayer.md) の 12.3 節）。
  - Router の回復のジョブが止まると、30 日で編集を失う危険がある。見張りとアラームで守る。
  - 大きな変更は、S3 の書き込みの分だけ確定が遅れる。

## Confirmation

- 性質ベーステスト（PROP-FS-007）：任意の 2 つの持ち主の書き込みの交ざりで、ジャーナルの範囲が続き、分かれない。
- 性質ベーステスト（PROP-FS-005）：まとめの前後で、まとまりの終わりの状態が一致する。
- 障害注入のテスト：タイムアウト（実際は成功）を注入し、再試行で二重に書かれない。
- 監視：手放さずに 1 日を超えて残るファイルの数（目標 0）、フェンスの失敗の数。

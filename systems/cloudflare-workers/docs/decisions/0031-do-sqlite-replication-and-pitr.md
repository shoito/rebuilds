---
status: accepted
date: 2026-09-27
---

# ADR-0031: SQLite の変更は持ち主と別の AZ の複製の 3 台のうち 2 台（2 つの AZ）で確定し、10 秒か 16 MiB ごとに S3 へ置いて 30 日の PITR を持つ

詳細は [durable-objects.md](../architecture/durable-objects.md) の 6・7 節。

## Context

ADR-0005 は、Durable Objects の保存を SQLite にし、変更のログを同じリージョンの別の AZ の 2 台へ送り、3 台のうち 2 台で確定すると決めた。ログはまとめて S3 へ置き、30 日の時点の復旧に使う。

本家（2026-09-27 に確認）：

- SQLite の WAL を VFS で取り、別のデータセンターの 5 台の follower へ送り、3 台の確認で出力のゲートを開く。10 秒か 16MB ごとにまとめてオブジェクトの保存に置く。ログが DB の大きさを超えたらスナップショットを置き、保存量を 2 倍までにする。30 日の中の任意の時点に戻せる（[Zero-latency SQLite storage in every Durable Object](https://blog.cloudflare.com/sqlite-in-durable-objects/)、2024-09-26）。
- PITR の API は `getCurrentBookmark`・`getBookmarkForTime`・`onNextSessionRestoreBookmark`（[SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)）。
- 出力のゲートは、書き込みの確定まで外への通信を止める（[Easy, Fast, Correct — Choose three](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/)）。

読み込みの速さ（手元の SQLite から同期で読む）を保ちつつ、1 つの AZ の喪失で確定済みの書き込みを失わないこと（NFR-010：AZ の障害で RPO 0）が要る。

## Options

1. **持ち主の手元の SQLite と WAL ＋ 別の 2 つの AZ のログのノード 2 台。3 台のうち 2 台（2 つの AZ）で確定。S3 へ 10 秒か 16 MiB ごとに置き、スナップショットと 30 日の PITR**
2. **手元の SQLite の WAL を S3 へ直接置いて確定する**（複製のノードなし）
3. **保存を EBS や Aurora に置き、手元にキャッシュだけ持つ**

## Decision

1 を採用する。

- 自前の SQLite の VFS（workerd への自前のパッチ）で WAL のフレームを取り、`{object_id, epoch, lsn, commit_time_ms, frames, checksum}` の記録にする。
- 持ち主は手元の WAL に fsync し、並列に 2 台のログのノードへ送る。2 つの異なる AZ の 2 台が保存したら確定とし、出力のゲートを開く。
- ログのノードは AZ ごとの群で、多数の実体のログをグループの fsync でまとめる。`promised_epoch` を持つ（[ADR-0030](0030-do-leases-and-fencing.md)）。
- 10 秒か 16 MiB の早い方で、確定済みの記録を 1 つのオブジェクトとして S3 に置く。置けたら `archived_lsn` を知らせ、ログのノードは捨ててよい。ログの合計が DB の大きさを超えたら、スナップショットを置く。
- PITR：ブックマークは `{timeline, lsn}` を HMAC で実体に結びつけたもの。戻すと新しい timeline として続け、古い timeline も 30 日残す。30 日より古い WAL は、30 日前へ戻すのに要るものを除いて消す。
- S3 のバケットは別のリージョンへ CRR で写す（管轄 `jp` は日本の中だけ）。リージョンの障害のときの手動の退避に使う。
- 本家（別の建物の 5 台、3 台で確定）より複製の数が少なく、範囲が 1 リージョンに閉じる。データを失うには、2 つの AZ の 2 台が同時に壊れる必要がある。
- 2 を採らない理由：S3 の PUT の遅延（小さなオブジェクトで 100〜200ms。[Optimizing performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html)、2026-09-27 に確認）が、書き込みごとの出力の遅延になる。PUT の料金が書き込みの数に比例する。
- 3 を採らない理由：EBS は 1 つの AZ に閉じ、AZ の喪失で RPO 0 を守れない。Aurora は同期の読み込みを手元でできず、本家の「遅延 0 の SQLite」の性質を失う。

## Consequences

- 良くなること：
  - 読み込みは手元の SQLite から同期で返る。確定の遅延は AZ の間の往復と fsync（数 ms の見込み。未検証。E9 の `do-commit-and-output-gate` で測る）。
  - 1 つの AZ の喪失で、確定済みの書き込みを失わない（NFR-010 の RPO 0）。
  - 30 日の任意の時点に戻せる（本家と同じ）。
- 引き受けるコスト：
  - ログのノードの群を、リージョンの各 AZ に運用する。
  - 自前の VFS と、workerd の保存の層へのパッチ（上流との差分が増える。PoC で量を確かめる）。
  - リージョン全体の喪失では、S3 に置く前の WAL（最大 10 秒）と CRR の遅れの分を失いうる。NFR-010 の「ホームのリージョンの全体の障害で RPO 1 分」は保証できない（PM・Ops に諮る）。
  - 手元にない大きな DB の復元は、S3 からの取得に時間がかかる（10 GiB で数分）。

## Confirmation

- 性質ベーステスト：確定の判定には 2 つの AZ の 2 台の保存がある。スナップショット＋WAL の復元の結果が、切れ目なしの適用と一致する。PITR の復元の結果が、その時刻の状態と一致する。
- Jepsen の形の試験：障害の中で、確定を返した書き込みの喪失 0 件、Elle の異常 0 件、出力の後に失われた書き込み 0 件。
- 結合テスト：S3 の障害の間も確定が続き、ログのノードがログを捨てない。回復の後に S3 へ追いつく。

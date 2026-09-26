---
status: accepted
date: 2026-09-26
---

# ADR-0018: IndexedDB を SQLite の上に作る

## Context

IndexedDB は、トランザクションを持つキーと値の保存領域で、サイトの保存データの大半を占める。下に置く保存の仕組みは、ディスクの形式として残り、後から替えると移行が要る。

- 本家 Chrome は、LevelDB とファイルを組み合わせた実装から、SQLite の実装へ移行している。まずシークレット（メモリ上）、次に新しく作るデータベース（Chrome 150 で出荷。DevTrial は 148）、最後に既存のデータの移行、と段階を踏む。理由は主に信頼性で、性能の改善も見込む（[PSA: IndexedDB: SQLite backend](https://groups.google.com/a/chromium.org/g/blink-dev/c/jS0khnC5IWA)）。
- Firefox と Safari は、IndexedDB を SQLite の上に作っている（同 PSA）。
- 他の保存（Cookie、Cache Storage の索引、localStorage、各種の索引）も、この設計では SQLite を使う（[storage.md](../architecture/storage.md)）。

## Options

1. **SQLite（`rusqlite`、SQLite を同梱）**
2. **LevelDB の類の LSM ツリー（Rust の実装、例：`fjall`）**
3. **自作の保存エンジン**

## Decision

1 を採用する。詳細は [storage.md](../architecture/storage.md) の 8 節にある。

- データベース（IndexedDB の）ごとに 1 つの SQLite のファイル。オブジェクトストア・インデックスを表と索引に写す。
- キーは、バイト列の比較で IndexedDB のキーの順序になる符号化で持つ。値は構造化の複製の直列化のまま持ち、大きな値と Blob はファイルに出す。
- WAL モード、`synchronous=NORMAL`。SQL は Storage サービスが持つ固定の文だけを実行する。
- シークレットでは、SQLite のメモリ上のデータベースを使う（本家の移行の第 1 段と同じ）。
- 2 は書き込みの多い用途に強いが、本家はそれをやめる方向で、他の保存と部品を分けることになる。LSM の圧縮（compaction）が、ディスクの使用量と割り当ての計算を読みにくくする。
- 3 は、保存エンジンの信頼性（落ちたとき、ディスクの破損）を一から作ることになり、範囲を超える。

## Consequences

- 良くなること：
  - 本家の移行先・Firefox・Safari と同じ種類の部品になり、振る舞い（トランザクションのスケジュールの端の場合を含む）を揃えやすい。
  - データベースごとに 1 ファイルなので、破損の影響をそのデータベースに閉じ込められ、消去・割り当ての計算が簡単になる。
  - 保存の部品を SQLite の 1 つに揃え、試験・ファズ・更新の追従の対象を減らせる。
- 引き受けるコスト：
  - SQLite は C の部品なので、境界の `unsafe` と、SQLite の脆弱性への追従が要る（ADR-0001、ADR-0002）。
  - SQLite の書き込みは 1 本なので、多くの `readwrite` のトランザクションを並行に走らせるページで、LevelDB の実装より遅くなる恐れがある。E4 でベンチマークを取る。
  - 本家が LevelDB の形式で保存したデータを取り込む（本家からの移行）は範囲外とする。

## Confirmation

- Web Platform Tests の `IndexedDB/` を CI で回し、合格率を追う（NFR-007）。
- 本家と同じベンチマーク（IndexedDB の読み書きのマイクロベンチマークと、IndexedDB を多用する実サイトの操作）で、本家の Stable と比べる。比較の対象と基準は [quality.md](../quality.md) に置く。
- 障害の注入（書き込みの途中でのプロセスの停止、ディスク満杯、ファイルの破損）で、破損が 1 つのデータベースに閉じること、満杯で既存のデータを失わないことを確かめる。
- IndexedDB の SQL の文が固定であること（サイトの入力から SQL を組み立てない）を、lint とレビューで確かめる。

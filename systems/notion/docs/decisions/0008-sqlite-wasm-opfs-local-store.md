---
status: accepted
date: 2026-09-26
---

# ADR-0008: ローカルの保存に SQLite（WASM）と OPFS を使い、書くタブを 1 つに限る

## Context

クライアントは、読んだレコードのキャッシュ（ページを 300ms で出すため。NFR-002）、未確定のトランザクションの待ち行列、オフラインで使うページとその部分木（NFR-005）を、端末に保存する。レコードは数万〜数十万になり、ページの部分木やオフラインのページの一覧を問い合わせで引きたい。

本家の Web 版は、SQLite の WASM 版を OPFS に置き、ページの移動を 20% 速くした。`opfs-sahpool` の VFS を選び（COOP / COEP が要らず、Safari と Firefox で動く）、複数のタブが同時に書いて行が破損した経験から、SharedWorker が選んだ 1 つのタブだけが SQLite に書く形にした（[How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)）。オフラインの機能も、この SQLite の上に作っている（[How we made Notion available offline](https://www.notion.com/blog/how-we-made-notion-available-offline)）。

Slack の題材は IndexedDB を選んだ（Slack の ADR-0024）。Slack はチャンネルの最新側のメッセージを持つだけで、問い合わせが単純だった。

対応ブラウザの下限は Safari 17（[editor.md](../architecture/editor.md) の 1 節）。

## Options

1. **IndexedDB**（Slack と同じ）
2. **SQLite（WASM）＋ `opfs` の VFS**（COOP / COEP のヘッダーが要る）
3. **SQLite（WASM）＋ `opfs-sahpool` の VFS**。1 つのタブの専用ワーカーだけが開き、他のタブは SharedWorker 経由で頼む
4. **SQLite（WASM）＋ `opfs-sahpool` を、各タブが独立に開く**

## Decision

3 を採用する。詳細は [editor.md](../architecture/editor.md) の 10 節にある。

- `opfs-sahpool` は COOP / COEP が要らず、Safari 16.4 以上を含む 2023 年 3 月以降の主要なブラウザで動く（[sqlite.org の persistence の文書](https://sqlite.org/wasm/doc/trunk/persistence.md)、2026-09-26 に確認）。下限の Safari 17 を満たす。
- 2 は、COOP / COEP を付けると、外部の埋め込み・画像・連携のスクリプトの読み込みが制約される。本家も同じ理由で避けた。
- 4 は、`opfs-sahpool` が同時に 1 つの接続しか持てず、2 つ目のタブで開けない。本家が経験した破損の危険もある。
- 1 は、ページの部分木・オフラインのページ・LRU の追い出しを、索引と手書きの走査で作ることになる。本家の実測で SQLite が速いことが分かっており、オフラインの表（`offline_page`、`offline_action`）も本家の形をそのまま使える。
- OPFS の同期アクセス（`createSyncAccessHandle`）は専用ワーカーでしか使えない。このため、SQLite を SharedWorker に置けない。Web Locks でロックを取ったタブの専用ワーカーが開き、SharedWorker が他のタブの要求をそこへ回す。ロックを持つタブが閉じたら、次のタブが開き直す。
- OPFS が使えない環境（プライベートブラウズなど）では、メモリだけで動き、オフラインの機能を無効にする。IndexedDB の実装を別に持たない。

> 2026-09-27 の注記：Consequences の「Safari の 7 日の削除が OPFS にも及ぶかは未検証」は解消した。Safari 17 の保存の方針は File System（OPFS）も対象にし、操作のない期間による追い出しを含む（[Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/)、2026-09-27 に確認）。OPFS も消えるものとして扱う（対策は変えない）。プライベートブラウズでの OPFS の可否はブラウザごとに違い、[editor.md](../architecture/editor.md) の 10 節にまとめた。SQLite 3.50 以降は `pauseVfs()`・`unpauseVfs()` で `opfs-sahpool` の接続を他のタブへ譲れるが、譲る相手を決める調停はアプリで要るので、選択肢 4 を採らない理由は変わらない（[sqlite.org の persistence の文書](https://sqlite.org/wasm/doc/trunk/persistence.md)、2026-09-27 に確認）。表の名前は複数形に揃えた（[data-model.md](../architecture/data-model.md) の冒頭の規約）。Confirmation の `record` は `records` と読む。`offline_page`・`offline_action` は本家の名前で、本システムの表は `offline_pages`・`offline_actions`。

## Consequences

- 良くなること：
  - ページの部分木、LRU、オフラインのページを SQL で引ける。本家の形と実測に寄せられる。
  - デスクトップアプリ（Electron）でも同じ実装が動く（[ADR-0009](0009-electron-desktop-shell.md)）。
- 引き受けるコスト：
  - SQLite の WASM（約 1MB）を読み込む。最初の表示の後に遅れて読み込み、最初の表示は API の応答で描く。
  - 書くタブの選び直し、SharedWorker と専用ワーカーの間のやり取りを、内部の契約として持ち、試験する。
  - Slack の題材とクライアントの保存の方式が違う。Slack の ADR-0024 とは、要件（問い合わせの複雑さ）が違うことを理由に分けた。
  - Safari の、操作のない 7 日の後のデータの削除（[WebKit の Tracking Prevention](https://webkit.org/tracking-prevention/)）が OPFS にも及ぶかは未検証。消えても取り直しで動くようにし、未確定のトランザクションが消えうることを画面で知らせる。

## Confirmation

- Playwright（Chromium / Firefox / WebKit）：3 つのタブで同時に編集しても、SQLite を開いているワーカーは常に 1 つで、同じ ID の行が 2 つできない。書いているタブを閉じても、残りのタブで読み書きが続く。
- 性質ベーステスト：任意のタブの開閉と書き込みの列で、最終的な `record` の表が、書き込みを 1 列に並べて当てた結果と一致する。
- E4 の着手前に、各ブラウザのプライベートブラウズで OPFS が使えるかを確かめる。

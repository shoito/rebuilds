---
status: accepted
date: 2026-09-28
---

# ADR-0015: 書き手のタブを Web Locks で 1 つ選び、どのタブも outbox へ直接書いて BroadcastChannel で知らせる。書き手は保存した差分の ID を配り、他のタブは IndexedDB から読み直し、取りこぼしは `last_sync_id` の食い違いで気づく

## Context

[ADR-0005](0005-client-persistence-and-offline.md) で、同じワークスペースを開いたタブ（Electron の複数のウィンドウを含む）のうち 1 つを Web Locks で書き手にし、他のタブは `_outbox` に直接書いて BroadcastChannel で知らせる、と決めた。残る問いは次のとおり。

- タブの間で配る中身（差分の全体か、ID か）。
- 通知の取りこぼし（凍結・破棄から戻ったタブ）。
- 書き手のタブが凍結されたときの交代と、2 つの書き手が重なったときの安全。
- 複数のタブの outbox の順序。

MDN によれば、Web Locks は同じオリジンのタブとワーカーの間で効き、コールバックの終わりとタブの終了で外れ、`steal` で奪える。BroadcastChannel は同じオリジン・同じ保存の区画で、送り手自身は受けず、構造化複製で送る（[Web Locks API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)、[BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)、2026-09-28 に確認）。凍結されたページがロックを持ち続けるかは**未検証**（E3 の `multi-tab-leader` で確かめる）。本家の複数のタブの扱いは、公式の資料にも第三者の解析にもない（**未検証**）。

Replicache は、同じブラウザのプロファイルのクライアントを 1 つのクライアントグループにまとめ、キャッシュを共有する（[How Replicache works](https://doc.replicache.dev/concepts/how-it-works)、2026-09-28 に確認）。Notion の題材は SQLite の OPFS の 1 つの接続の制約から SharedWorker を経由させた（Notion の ADR-0008）。

## Options

配る中身：

1. **保存した差分の `{from, to, changes: [{m, id, a}]}`。受け手は IndexedDB から行を読む**
2. 差分の全体を構造化複製で配る
3. 配らず、各タブが IndexedDB を定期的に読む

実行の場所：

- a. **書き手のタブ（ページ）**
- b. SharedWorker に同期を置く

## Decision

1 と a を採用する。詳細は [client-store-and-offline.md](../architecture/client-store-and-offline.md) の 8 節。

- ロックの名前は `<brand>:leader:<db>`、移行は `<brand>:migrate:<db>`。チャンネルは `<brand>:<db>`。
- 書き手は WebSocket、outbox の送信、差分の保存、添付の上げ、ブートストラップとやり直しの進行、保存の見張りを担う。どのタブも outbox へ `strict` で書き、`outbox {seqs}` を知らせる。IndexedDB の自動の連番（`seq`）が、タブをまたいだコミットの順になる。
- 書き手は差分を保存した後に `applied {from, to, changes}` を配る。受け手は `from` が自分の `L` と等しければ ID の行を読んで当て、違えば `_meta.last_sync_id` と比べて、メモリーを手元から読み直す。凍結・破棄から戻ったとき、`messageerror` を受けたとき、画面が見えるようになったときも比べる。
- 書き手は、`freeze` で自分から降りる。見えているタブは、書き手の `status`（5 秒ごと）を 10 秒受けなければ `steal` で奪う。奪われた書き手は直ちに送信をやめる。重なっても、`client_tx_id` の冪等と、接続の中の順序と、Writer が 1 回の `submit` を順に処理することで、重複も順序の逆転も起きない。
- 2 を採らない理由：大きなパケットの構造化複製がタブの数だけ走り、メインのスレッドを止める。受け手は保存済みの行を読めば足りる。
- 3 を採らない理由：伝播が遅れ（NFR-002）、読み出しが無駄に増える。
- b を採らない理由：SharedWorker は、Android の Chrome では 148 からしか使えない（[MDN の互換性のデータ](https://github.com/mdn/browser-compat-data) 8.1.3、2026-09-28 に確認。Safari は 16、Firefox は 29 から）。古い Android の Chrome が残り、Electron と Web で実行の場所が分かれる。IndexedDB はどのタブからも読み書きでき、書き手はネットワークの役割だけなので、ページで足りる（ADR-0005）。

## Consequences

- 良くなること：
  - タブを閉じても、書き手が交代し、outbox を失わない。
  - タブの間の通知が小さく、取りこぼしても手元から読み直せる。
- 引き受けるコスト：
  - 受け手のタブの IndexedDB の読み出しが増える。
  - 書き手が隠れたタブにあると、ブラウザのタイマーの間引きの影響を受ける（生存の確認はサーバーの ping フレームで行う）。
  - 凍結とロックの振る舞いが、ブラウザごとに違いうる。

## Confirmation

- 性質ベーステスト（[ADR-0010](0010-deterministic-sync-simulator.md)。模した Web Locks と BroadcastChannel で、通知の喪失・凍結・`steal` を注入する）：PROP-STORE-003（順序）、PROP-STORE-006（タブの収束）、PROP-STORE-001（失わない）。
- Playwright：書き手のタブを閉じる・凍結させる（CDP の `Page.setWebLifecycleState`）場面で、他のタブの outbox が送られる。
- 確かめ（E3）：Chrome・Firefox・Safari・Electron で、凍結されたページのロックの振る舞いと、Electron の複数のウィンドウの間の Web Locks・BroadcastChannel。

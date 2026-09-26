---
status: accepted
date: 2026-09-26
---

# ADR-0024: Web クライアントのデータ層を Timeline ストア＋TanStack Query にし、接続を SharedWorker に集め、オフラインの保存に IndexedDB を使う

## Context

Web クライアント（PWA）は、次のことを満たす必要がある（[intent.md](../intent.md) の「守るべき振る舞い」）。

- 全メンバーが同じ順序でメッセージを見る。切断・再接続しても、欠けたメッセージを自動で補う（[ADR-0001](0001-per-channel-sequence.md)、[ADR-0002](0002-db-as-source-of-truth-with-outbox.md)）。
- 二重送信で重複投稿しない。送信中の状態を出し、再読み込みしても未送信のメッセージを失わない。
- 編集・削除・リアクションも即座に反映する。

このとき、決めなければならないことが 3 つある。

1. **データ層**：サーバーの状態をどこに、どの形で持つか。
2. **複数タブ**：同じ人が複数のタブを開いたとき、WebSocket と同期の処理をどう持つか。タブごとに接続すると、同時接続の数（NFR-001）がタブの数だけ増える。
3. **オフラインの保存**：未送信のメッセージ、下書き、最近のメッセージをどこに保存するか。

エージェントは、TanStack Query の無限クエリにイベントを直接書き込む実装や、タブごとの WebSocket を選びがちである。後から変えると、同期の処理を全面的に書き直すことになる。

## Options

### データ層

1. TanStack Query だけ。メッセージは無限クエリのページに持ち、イベントを `setQueryData` で書き込む
2. 全面的な正規化ストア（Redux Toolkit の entity adapter など）に、すべてのサーバーの状態を持つ
3. メッセージだけを専用の Timeline ストア（チャンネルごとに `seq` → メッセージ）で持ち、それ以外は TanStack Query に任せる

### 複数タブ

1. タブごとに WebSocket を持つ
2. Web Locks でリーダーのタブを 1 つ選び、そのタブだけが WebSocket を持ち、`BroadcastChannel` で他のタブに配る
3. SharedWorker に WebSocket と同期エンジンを置き、タブは `MessagePort` でつながる
4. Service Worker に WebSocket を置く

### オフラインの保存

1. `localStorage`
2. Service Worker の Cache Storage に API の応答をキャッシュする
3. IndexedDB に、メッセージ・未送信・下書きを構造化して保存する

## Decision

データ層は 3、複数タブは 3（使えない環境では 1 に戻り、送信キューだけ Web Locks で排他する）、オフラインの保存は 3 を採用する。詳細は [client.md](../architecture/client.md) の 3 節。

### データ層：Timeline ストア＋TanStack Query

- 同期の正しさは「`seq` 順に 1 件ずつ適用し、`applied_seq` 以下は捨て、飛んだら差分取得する」ことで決まる。この処理を 1 か所に集めたい。
- 1 は、ページの境界が取得のたびに変わり、編集・削除・リアクションが別ページのメッセージを指すと、書き込む場所を探す処理が散らばる。楽観表示の差し替えも同じ。
- 2 は、変化の少ないチャンネル一覧や設定まで正規化の対象になり、TanStack Query の再試行・重複排除・無効化を自前で作り直すことになる。
- 3 は、順序の処理をメッセージのストアに閉じ込め、残りは TanStack Query の標準的な使い方で済む。メッセージの取得そのものは Query の `queryFn` 経由で行い、再試行・キャンセルは Query に任せる。

### 複数タブ：SharedWorker

- 接続を 1 ブラウザ・1 ワークスペースにつき 1 本にでき、同時接続の数と、再接続のときの差分取得の集中を減らせる。
- 同期エンジンが 1 つになり、欠損の検知と差分取得を 1 回だけ行う。タブには `seq` の連続が保証されたイベントだけを渡す。
- SharedWorker は、Safari（macOS / iOS）16 以上、Chrome、Firefox で使える。Chrome for Android は 148 以上で使える（MDN browser-compat-data。caniuse は 152 と表示しており、差がある）。いずれも 2026-09-26 に確認した。
- 2 は、リーダーのタブがバックグラウンドで止められたり（タブの凍結・タイマーの間引き）、閉じられたりしたときの引き継ぎが難しい。止まったタブがロックを持ち続けると、全タブの配信が止まる。SharedWorker は、つながっているタブが 1 つでもあれば動き続ける。
- 4 は、Service Worker がアイドルになるとブラウザに止められるので、WebSocket を保てない。Service Worker はアプリの骨格のキャッシュと Web Push の表示に限る。
- 同期エンジンは DOM と React に依存させず、SharedWorker でもタブの中でも動くようにする。SharedWorker がない環境（古い Chrome for Android、Android の WebView など）では、タブごとに動かす（1）。このとき、送信キューは Web Locks（Chrome 69、Firefox 96、Safari 15.4 以上）でロックを取ったタブだけが処理し、タブ間の通知は `BroadcastChannel` で行う。

### オフラインの保存：IndexedDB

- データベースをアカウントごとに分け、キーの先頭に `workspace_id` を置く（[ADR-0009](0009-pooled-tenancy-with-rls.md) の考え方を手元の保存にも当てる）。
- 未送信のメッセージは、画面に出す前に IndexedDB の `outbox` へ書く。送信はチャンネルごとの FIFO で 1 件ずつ行い、`client_msg_id` を変えずに再送する（REQ-MSG-002）。
- 読み取りのキャッシュは、ワークスペースごとに最近の 20 チャンネル × 最新側 200 件、総量 50MB を目安とし、LRU で追い出す。未送信と下書きは追い出さない。
- 1 は同期的で容量が小さく、ワーカーから使えない。2 は、メッセージをイベントで書き換えられず、応答の単位でしか持てない。

## Consequences

- 良くなること：
  - 同期の正しさ（順序・欠損・重複）を、同期エンジンと Timeline ストアの 2 つに閉じ込め、性質ベーステストを集中できる。
  - タブを増やしても、同時接続の数と差分取得の負荷が増えない。
  - 再読み込み・ブラウザの再起動・オフラインのあとも、未送信のメッセージと下書きが残る。起動時にキャッシュを即座に出せる。
- 引き受けるコスト：
  - SharedWorker とタブの間のメッセージの形（版を含む）を、もう 1 つの内部契約として持つ。新しい版のアプリを出すと、古いタブが閉じるまで SharedWorker が 2 つ動き、接続も 2 本になる。
  - SharedWorker のデバッグは、タブより手間がかかる。
  - 同期エンジンを、SharedWorker とタブ単体の 2 つの動かし方で試験する必要がある。
  - IndexedDB に、プライベートチャンネルの本文が端末に残る。ログアウト時に消すが、共有端末での扱いは未解決。

    > 2026-09-26 の注記：共有端末向けの「この端末に保存しない」設定は設けないと決めた。ログアウト時の消去と、セッションの最大有効期間で抑える（[client.md](../architecture/client.md) の 13 節の決定）。

  - Safari は、ホーム画面に追加していないサイトのデータを、操作のない 7 日間で消しうる（[WebKit の Tracking Prevention の文書](https://webkit.org/tracking-prevention/)で 2026-09-26 に確認。ホーム画面の Web アプリは対象外）。キャッシュと未送信が消えても、最新ページの取り直しで動くようにする。
  - iOS の PWA がバックグラウンドにある間の SharedWorker と WebSocket の寿命は、公式の文書に定めがなく未検証。フォアグラウンドに戻ったら必ず差分取得する。E4 の着手前に実機の PoC で測る（[client.md](../architecture/client.md) の 3.4 節）。

## Confirmation

- 性質ベーステスト：同期エンジンに、任意のイベント列（欠け・重複・順の入れ替わり・切断）と差分取得の応答を与え、最終的な Timeline がサーバーの `seq` 順の列と一致する。SharedWorker とタブ単体の両方の動かし方で実行する。
- 性質ベーステスト：任意の送信・失敗・再送・再読み込みの列に対し、投稿されるメッセージは `client_msg_id` ごとに 1 件で、同じチャンネルの中では送った順に `seq` が付く。
- Playwright（Chromium / Firefox / WebKit）：同じ人が 3 タブを開いても WebSocket は 1 本（SharedWorker のある環境）。送信中に再読み込みしても 1 件だけ投稿される。
- lint：`apps/web` で、Timeline ストア以外からメッセージのクエリに `setQueryData` しない。`src/sync/` から React と DOM の API を import しない。

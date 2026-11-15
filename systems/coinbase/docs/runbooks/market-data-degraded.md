# Runbook: 板の配信の遅れ

- Owner: Ops（当番）
- 対応するアラート: 配信の p99 が 500ms を 5 分超えた（page）、接続の急増、再接続の嵐、`slow_consumer` で切った接続の率の急な上がり
- 最終確認日: 2026-11-15

前提の設計は [market-data.md](../architecture/market-data.md)（4.3 節の通し番号と回復、4.4 節の接続と上限、5 節の障害の表）、[ADR-0021](../decisions/0021-market-data-feed-and-book-seq.md)、[capacity.md](../architecture/capacity.md)。SLO は入力の記録への書き込みから送り出しまで p99 50ms（NFR-002）。**遅い接続を待って他の接続を遅らせない。**

## 症状

- 配信の p99 が 500ms を 5 分超えた。
- `ws-gateway` の接続の数が急に増えた、または切れた接続が一斉に再接続してきた。
- `resync` の送信や、利用者の側の取りこぼしの率が増えた。

## 影響

- 利用者の板と約定の表示が遅れる。取りこぼした利用者は購読し直してスナップショットから始める。
- 販売所は Valkey の板の写しから中値を作る。写しが 10 秒更新されなければ提示を止める（[brokerage-quotes-halted.md](brokerage-quotes-halted.md)）。

## 確認

1. 区間ごとの遅れ：エンジンの出力 → `md-publisher` → `md.pub` → `ws-gateway` → 送り出し。どこが伸びたか。
2. エンジンの停止・切り替え中か（`heartbeat` の `book_seq` が進まない）。そうなら [engine-failover.md](engine-failover.md)。
3. `md-publisher` の持ち主の記録（`md_publisher_leases`）と、待機への切り替えの有無。
4. `ws-gateway` のタスクごとの CPU、接続の数（1 タスク 5,000 が目安）、未送信の量。`slow_consumer` で切った数。
5. MSK の `md.*` の書き込みの誤りと遅れ。
6. 時計のずれ（[clock-drift.md](clock-drift.md)）。配信の遅れの値は壁の時計の差なので、ずれで値が信用できなくなる。
7. 接続の急増の元：IP ごとの認証なしの接続の上限（20）に当たっている数、ボットの兆し。

## 対処

1. **`ws-gateway` の負荷**：タスクを足す（S1 は 3 AZ の 6 タスク。1 つの AZ が落ちても 4 タスクで 2 万を受ける形）。
2. **遅い接続**：`slow_consumer`（未送信が 4 MB か 2 秒）の規則で切る。値を緩めない。
3. **再接続の嵐**：タスクを順に抜くときは、切る接続に `reconnect_after_ms`（0〜5,000 の一様な乱数）を送って山を散らす。嵐の最中は、NLB の背後のタスクを先に足してから、抜く作業を止める。
4. **`md-publisher` の停止**：待機が最後に書いた `md.pub` の位置から読み直して続ける。重複は `book_seq` で捨てる。手で `md.pub` に書かない。
5. **Valkey の障害**：REST の板は 503 を返す。販売所は提示を止める。回復の後に `md-publisher` が写しを書き直したことを確かめる。
6. **時計のずれ**：受け付けは影響しない。[clock-drift.md](clock-drift.md) に従い、ずれの間の配信の遅れの値を SLO の計算から除くかを記録する。

## エスカレーション

- 30 分を超える：IC を立てる（SEV2）。
- `book_seq` の飛びが `ws-gateway` の作り直しで消えない（エンジンの出力の欠けの疑い）：Dev のテックリード。[market-halt.md](market-halt.md) の確かめへ。

## 事後

- 再接続の嵐の形（数、間隔）を負荷試験の場面に足す（[quality.md](../quality.md) の 2.2.1 節 H の遅い接続を混ぜる場面）。
- 調査結果を `changes/` の新しい `intent.md` として起票する。

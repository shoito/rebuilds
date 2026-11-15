# Runbook: 正しさの見張りの心拍の途絶

- Owner: Ops（当番）
- 対応するアラート: `watch` が、正しさの SLI の心拍を 5 分受けていない（page、SEV2。`watch` の SNS から直接）、`canary` の 2 回続けての失敗（page）、本体の側の `watch` の応答の検査の失敗（チケット）
- 最終確認日: 2026-11-15

前提の設計は [ADR-0068](../decisions/0068-correctness-monitors-and-independent-watch.md)（`watch` のアカウント、心拍、デッドマンスイッチ）と [observability.md](../architecture/observability.md) の 4.4・4.5 節。判定基準は、正しさの SLI が確かめられていない時間 0 分（[quality.md](../quality.md) の 4.1 節）。**確かめられていない SLI を緑として扱わない。**

## 症状

- 1 つ以上の SLI（写しの要約の比べ、日次の再生、入力の番号、拘束と注文、約定の記帳、台帳とウォレット、ネットワークにつながる額、方針の判定の食い違い）の心拍が 5 分届かない。
- または、`canary`（見張りの口座の注文と取り消し、販売所の購入、配信の購読）が 2 回続けて失敗した。

## 影響

- その SLI は「不明」になる。正しさの破れ（二重の記帳、方針の外の署名など）が起きていても気づけない。
- 利用者から見える影響は、原因による（本体の経路の停止なら全体の障害）。

## 確認

切り分けは 3 つの場所の順に行う。

1. **送り手の側（比べ・照合のジョブ）**：途絶した SLI の送り手（`reconcilers`、写しの `engine-host`、`policy-verifier` など）のタスクの健全性、`*_last_checked` が進んでいるか。1 つの SLI だけなら、多くはこの側。
2. **本体の経路（`prod`・`custody` から `watch` の SQS へ）**：複数の SLI が同時に途絶したなら、送りの経路（VPC の出口、SQS のリソースポリシー、ロール）か、本体のアカウントの広い障害。AMP の本体のアラートの試験の発火が届いているかも見る。
3. **`watch` の側**：`watch` のアカウントの取り込みと見張りのタスク、DynamoDB（`watch_heartbeats`）、大阪の主の状態。

- `canary` の失敗なら、どの場面で落ちたか（受け付けの速さ、通知の到着、拘束が 0 に戻るか、販売所の記帳）。

## 対処

1. **送り手の停止**：ジョブを起こし直す。止まった間（最後に確かめた `seq` か時刻から）を後から確かめ、結果を記録する。後からの確かめで件数が 1 以上なら、その SLI の手順（[README.md](README.md) の 4 節）に移る。
2. **本体の経路**：経路を直す。直るまで、各 SLI を本体の AMP のダッシュボードで 15 分ごとに人が確かめ、記録する。本体のアカウントの侵害の疑いがあれば、[hot-wallet-compromise.md](hot-wallet-compromise.md) の確認に移る。
3. **`watch` の側**：`watch` を戻す。戻るまでは本体の経路だけで見張り、チケットにする（[observability.md](../architecture/observability.md) の 5 節）。
4. **確かめられない時間が 30 分を超え、台帳とウォレットか方針の判定の食い違いの SLI が含まれる**：IC が、ホットの自動の署名（`ops.hot_auto_signing_enabled.<asset>`）を止めるかを判断する（迷ったら止める）。
5. **`canary` の失敗**：場面に応じて [order-entry-degraded.md](order-entry-degraded.md)、[market-data-degraded.md](market-data-degraded.md)、[brokerage-quotes-halted.md](brokerage-quotes-halted.md) へ。

## エスカレーション

- 複数の SLI が 15 分を超えて確かめられない：IC を立てる（SEV2）。
- 後からの確かめで正しさの破れが見つかった：その手順の重さ（多くは SEV1 の候補）。

## 事後

- 確かめられなかった時間を SLI ごとに記録し、判定基準（0 分）の外れとして QA と振り返る。
- 調査結果を `changes/` の新しい `intent.md` として起票する。

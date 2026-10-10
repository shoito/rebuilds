# Runbook: デプロイとロールバック

- Owner: Ops
- 対応するアラート: デプロイ中の自動ロールバック。プレイヤーのバージョンごとの QoE の悪化。デプロイの手順そのもの
- 最終確認日: 2026-10-10

設計は [delivery.md](../architecture/delivery.md)、[ADR-0070](../decisions/0070-ci-cd-golden-media-gates-and-player-rollout.md)、[ADR-0071](../decisions/0071-encoder-pinning-reencode-and-manifest-format-versions.md)。時間帯と凍結は [README.md](README.md) の 3.1 節。

## 症状

- 自動のロールバックの条件（再生の API の 5xx、開始の失敗、再バッファ、再生できるまでの p95、照合の待ち、措置の停止の時間、漏れの監査の不一致）が、デプロイの直後に外れた。
- Web のプレイヤーの新しいバージョンの QoE が、前のバージョンの 1.2 倍を超えた。
- 黄金の動画の夜間の検査が、本番の `enc_build` で落ちた。

## 影響

部品による。プレイヤーの退行は開始の時間と再バッファ（NFR-003・004）、マニフェストの誤りは再生の開始の失敗、エッジの関数の誤りは全部の 403 か全部の通過になる。

## 確認

1. どの部品のデプロイか（`deployments` の記録）。管理の面、作業者のプール、`manifest-service`、`live-*`、`match-engine`、`origin-cache`、エッジの関数、プレイヤー。
2. 形式の番号を変えたか：`ladder_version`、`enc_build`、`fp_version`、`ruleset_version`、`mf`。これらはフラグでなくコードのバージョンなので、戻すのはイメージの戻しになる。
3. プレイヤーのバージョンごとの QoE（`player_version` の切り口、[observability.md](../architecture/observability.md) の 2.2 節）。

## 対処

1. **フラグで戻す**：未完成の振る舞いは `release.*` の裏にある。まずフラグを戻す。
2. **部品ごとの戻し**（「足してから抜く」の逆）：
   - 作業者のプール：古いイメージの作業者を足し、新しいイメージの作業者の取得を止める。作業は冪等なので、途中の作業は古い作業者がやり直す。
   - `manifest-service`：1 つ前のイメージへ。`mf` を上げた変更なら、再生の API の既定の `mf` を前の番号に戻す（2 つ前まで作れる）。マニフェストの cache tag を無効にしない（混ざらない設計のため）。
   - `live-transcoder`・`live-origin`・`live-ingest`：配信中の作業者を止めない。新しい配信だけを古い側へ向ける。
   - `match-engine`：AZ ごとに戻し、索引の読み込みと照合の一致の抜き取りを確かめてから次の AZ へ。両方の写しを同時に止めない（止めると全動画が照合待ちになる）。
   - `origin-cache`：1 ノードずつ。ヒットの率が戻るのを待つ。
   - エッジの関数：本番のディストリビューションの関数を前のバージョンに戻す。次はステージングのディストリビューションで、見張りの再生と見張りの措置を通してから出す。
   - Web のプレイヤー：`player_cfg` の割合を前のバージョンへ戻す（バージョンごとの不変の URL）。
   - アプリ：ストアの段階の配布を止める。重い不具合は再生の API の `min_supported` を上げる（脆弱性のとき）。
3. **データの変更**：マイグレーションは広げる段だけを出しているので、前のイメージで動く。狭める段は戻さない。
4. **符号化の誤り**：誤った `enc_build` で作ったレンディションを `renditions.enc_build` で引き、作り直しの対象にする（`reencode_campaigns`、理由 `defect`）。

## エスカレーション

- 戻しても SLO が戻らない：[incident-response.md](incident-response.md) へ。
- 漏れの監査の不一致を伴う：SEV1。Dev のテックリードと PM。
- `mf` を戻しても古いアプリが読めない：Dev のテックリードと PM（`min_supported` の判断）。

## 事後

- 黄金の動画・端末の試験・ステージングで見つからなかった理由を、試験のベクトルか関門に足す（期待の値の変更は QA の承認）。
- 調査結果を `changes/` の新しい `intent.md` として起票する。

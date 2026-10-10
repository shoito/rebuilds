# Runbook: CDN の障害

- Owner: Ops
- 対応するアラート: 配信の可用性のバーンレート、CDN のエッジの 5xx・時間切れの急増（page）、CloudFront の上限の使用の割合 80%（page）
- 最終確認日: 2026-10-10

設計は [cdn-and-delivery.md](../architecture/cdn-and-delivery.md)、[infrastructure.md](../architecture/infrastructure.md) の 3 節、[ADR-0005](../decisions/0005-cdn-and-origin-strategy.md)、[ADR-0064](../decisions/0064-accounts-network-and-edge-distributions.md)。

## 症状

- セグメントの要求の 5xx・時間切れが増えた（リアルタイムのログの 1% の抜き取り、CloudFront の `5xxErrorRate`）。
- 実ユーザーの開始の失敗・再バッファが、CDN・ISP の切り口で悪化した。
- ディストリビューションの転送・要求の使用の割合が上限に近い。

## 影響

配信の可用性（月間 99.99%、NFR-008）を消費する。全視聴者の再生が止まりうる。S1 は CDN が 1 つ（ADR-0005）。

## 確認

1. **見分ける**：(a) 全体か、(b) 特定の地域・ISP か、(c) 特定の動画・段か、(d) オリジンの 5xx の写しか、(e) 上限の絞りか。リアルタイムのログの `x-edge-detailed-result-type`・`sr-reason` と、`origin-cache`・`live-origin` の指標で分ける。
2. (d) オリジン：`origin-cache` の 5xx、S3 の 503、NLB の健康の確かめ。急な人気なら [viral-spike.md](viral-spike.md)。
3. (e) 上限：どのディストリビューション（`vod`・`live`・`app`）か。`live` の 20 万人級の配信なら要求の上限に近い。
4. 直近の変更：キャッシュの規則、エッジの関数、HMAC の鍵の回し、KeyValueStore の更新。

## 対処

1. **直前の変更を戻す**：キャッシュの規則・エッジの関数は前のバージョンへ（[deploy-and-rollback.md](deploy-and-rollback.md)）。
2. **署名の問題**：鍵の回しの直後なら、前の鍵を KeyValueStore に戻す（2 つを並べて回すので片方を戻せる）。
3. **拒否の一覧の誤り**：正しい動画が 403 なら、`b:`・`t:` の直前の更新を確かめる。措置の記録を消さずに、一覧だけを記録（`delivery_blocks`）から作り直す。
4. **Origin Shield の障害**：Shield を外してエッジから `origin-cache` へ直接に向ける。先に `origin-cache` を増やす。
5. **上限の絞り**：
   - `live`：大きな配信を通常のモード（要求 1.5 件/秒）へ切り替える。上限の引き上げを AWS に至急で頼む。承認が足りなければ `live` を分ける手順（`live-a`・`live-b`、配信の ID のハッシュで振る）を使う。1 つの配信の視聴者は 1 つのディストリビューションに乗るので、1 配信の上限は分けても上がらない。
   - `vod`：急な人気の動画の最上段をマニフェストから一時に外す（運用の記録つき）。
6. **事業者の障害（S1）**：AWS に連絡し、状況のページで知らせる。S2 からは、振り分けの重みを手で他の CDN へ寄せる（5 分以内。寄せる先の約定の量とオリジンの負荷を確かめる）。

## エスカレーション

- 15 分で戻らない全体の停止：SEV1 の候補。Ops の責任者、PM。
- 上限の引き上げ：AWS のサポートと担当の窓口。

## 事後

- 視聴者への影響（開始の失敗、再バッファ）を ISP・端末ごとにまとめる。
- 上限の申請と承認を `cdn_quota_log` に記録する。
- 調査結果を `changes/` の新しい `intent.md` として起票する。

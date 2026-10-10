# Runbook: 措置の配信の停止の遅れ

- Owner: Ops
- 対応するアラート: 措置の停止の遅れ（見張りの措置で 120 秒を超えた。page、SEV2 から）、`delivery_blocks` の段の時刻の遅れ、KeyValueStore の更新の失敗
- 最終確認日: 2026-10-10

設計は [cdn-and-delivery.md](../architecture/cdn-and-delivery.md) の 10 節、[ADR-0027](../decisions/0027-takedown-deny-list-within-60s.md)、[ADR-0062](../decisions/0062-threat-mitigations-and-key-layout.md)（トークンの拒否 `t:`）。目標は NFR-014：決定から新しい配信の 403 まで p99 30 秒、上限 60 秒。

## 症状

- 見張りの措置で、エッジの 403 までが 60 秒を超えた（`canary` の 6 つの見張りの端末と東京・大阪の EC2）。
- `delivery_blocks` の `kvs_put_at`・`replica_at`・`origin_at` のどれかが遅れているか、空のまま。
- 漏れの監査で、措置した動画の応答が見つかった。

## 影響

措置・削除・照合のブロックの動画が配られ続ける。権利者の損害と法令の問題（法務の確認待ち：L1）。漏れの監査の不一致を伴えば SEV1 の候補。

## 確認

1. その措置の `delivery_blocks` の行：どの段が遅れたか。
2. outbox の行があるか（記録してから効かせる。outbox の行がない措置は配信を止めない）。`relay` の遅れ。
3. `delivery-blocker` のやり直しの記録（10 秒ごと 5 回）と、KeyValueStore の置き場の使用の割合（80% で寿命を 24 時間に縮める）。
4. エッジ：見張りの URL の応答を地域・拠点ごとに見る。KeyValueStore の伝わる速さは**未検証**。

## 対処

1. **outbox がない**：措置の記録の誤り。措置の担当に記録を書き直してもらう。手で拒否を置かない（記録のない拒否を作らない）。
2. **KeyValueStore の更新の失敗**：`delivery-blocker` のやり直しが尽きたら、手で `b:{video_id}` を置く。並べてパスの無効化（`/v/{video_id}/*`。キャッシュの鍵はトークンを取り除いた URI。ワイルドカードは 1 秒に 1 件まで）を出す。マニフェストはパスの途中に `mf` と `caps` があるので、cache tag の `#v:{video_id}` の無効化を出し直して止める。
3. **置き場が溢れそう**：拒否の鍵の寿命を 24 時間に縮める（トークンの 6 時間より長いので安全）。終了したチャンネルの大量の動画は、直近に再生のあった動画だけに置く（[ADR-0061](../decisions/0061-creator-tiers-strikes-and-account-standing.md)）。
4. **`playable()` の写し（Valkey）の遅れ**：再生の API とマニフェストは写しを読む。写しを Aurora から作り直す。
5. **`origin-cache` の拒否の集まり**：SNS の `origin-deny` の配りを確かめ、届いていないノードを再起動して集まりを読み直す。
6. **トークンの悪用（措置ではない再配信）**：悪用の分かったトークンは `t:{sig16}` で個別に拒む（`token-abuse.md`、計画）。

## エスカレーション

- 120 秒を超えた：SEV2。Ops の責任者。
- 漏れの監査の不一致：SEV1。Dev のテックリード、PM、法務。
- CloudFront の側の障害：AWS のサポート。

## 事後

- KeyValueStore の伝わる速さと無効化の完了の時間を記録し、[ADR-0027](../decisions/0027-takedown-deny-list-within-60s.md) の値を見直す。
- 調査結果を `changes/` の新しい `intent.md` として起票する。

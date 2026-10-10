---
status: accepted
date: 2026-10-10
---

# ADR-0066: 大阪は管理の面のウォームスタンバイと、元のファイルの写しと、熱い集まりの H.264 のレンディションの写しを持ち、CloudFront のオリジングループで VOD の外れを大阪へ逃がす。段階を上げる準備は上限の 60% で始め、2 つ目の CDN は月の配信 100 PB か配信のピーク 1 Tbps の早いほうの前に入れる

## Context

- NFR-009 はリージョンの障害で、管理の面 RPO 1 分・RTO 1 時間、元のファイルの写し RPO 15 分、再生の再開 RTO 2 時間（大阪の写しから、AV1 なしの段で）を求める。
- [ADR-0002](0002-upload-and-pipeline-orchestration.md) は大阪へ元のファイルだけを写し、レンディションは作り直せるので写さないとし、人気の動画のレンディションを写すかを infrastructure の領域に預けた。
- 2 時間で全動画のレンディションを元のファイルから作り直すことはできない。元のファイルの多くは 90 日の後に Deep Archive にあり、戻しに 12 時間かかる（[ADR-0065](0065-media-fleets-msk-and-storage-tiers.md)）。
- 視聴は少数の動画に偏る（[cdn-and-delivery.md](../architecture/cdn-and-delivery.md) の 7 節）。
- S3 の RTC は大部分を数秒、99.9% を 15 分以内に写す。転送の既定の上限は 1 Gbps（[S3 Replication Time Control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html)、2026-10-10 に確認）。Aurora Global Database の写しの遅れは通常 1 秒未満（[Using Amazon Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)、2026-10-10 に確認）。
- [ADR-0005](0005-cdn-and-origin-strategy.md) は S2 から複数の CDN と決め、時機を決めていない。

## Options

DR の再生：

1. **熱い集まり（総再生時間の 90%）の H.264 のレンディションを大阪へ写し、オリジングループで逃がす。外は大阪で作り直す**
2. すべてのレンディションを大阪へ写す
3. レンディションを写さず、切り替えの後に作り直す

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 7・9・10 節。

- 大阪の平常：管理の面のウォームスタンバイ、Aurora の二次、`origin-cache` 3 台・`manifest-service`・読み出しだけの再生の API、空の MSK。符号化・GPU・`match-engine` は 0 台。
- 写し：元のファイルは CRR と RTC（大阪で 90 日まで Instant Retrieval、その後 Deep Archive）。熱い集まり（直近 7 日の確定の総再生時間の 90% を占める動画と、登録者 10 万以上のチャンネルの公開から 30 日の動画）の H.264 のレンディションを、タグ `dr=hot` の CRR と週ごとの Batch Operations で大阪の Standard-IA へ。参照の指紋と索引も写す。RTC の転送の上限は E1 で 5 Gbps へ申請する。
- 再生の DR：CloudFront のオリジングループで、東京の 5xx の VOD の外れを大阪の `nlb-origin` へ自動に逃がす。熱い集まりの外は「処理中」を返し、大阪で `fast_encode` を作り直す。AV1 の段は載せない。
- アップロードは MVP で大阪で受けない。ライブは大阪の GPU を起こせた分だけ受ける（RTO を置かない）。照合は大阪で索引を読み込むまで「照合待ち」（公開に倒さない）。
- 段階を上げる準備：[infrastructure.md](../architecture/infrastructure.md) の 9 節の指標（配信のピーク、月の配信、ライブの視聴、アップロード、MSK、Aurora、写しの転送、索引）のどれかが上限の 60% に達したら始める。
- 2 つ目の CDN：月の配信 100 PB か配信のピーク 1 Tbps に、四半期の見込みで届く前に本番に入れ、平常から 20% 以上を流す。前提は `multi-cdn-poc` で、パスのトークンの確かめ、拒否の一覧の 60 秒、リアルタイムのログを確かめること。

### 他の案を選ばなかった理由

- **2（すべて）**：S1 の 1 年目で約 1.7 PB（レンディション）を写し続け、ほとんど見られない動画に写しの費用を払う。
- **3（写さない）**：2 時間で再生を戻せない（元のファイルの多くが Deep Archive にある）。

## Consequences

- 良くなること：
  - 総再生時間の 90% を数分で大阪から配れ、RTO 2 時間を満たす。
  - 写しの量を全体の約 5% に抑える。
- 引き受けるコスト：
  - 熱い集まりの外の動画は、リージョンの障害の間に作り直しの待ち（数分〜12 時間）がある。NFR-009 の「再生の再開」を熱い集まりで満たす解釈になるので、PM と QA の合意が要る。
  - 熱い集まりの選び方と写しの割合を毎日見張る。

## Confirmation

- DR の訓練（半年ごと）：熱い集まりの再生が 2 時間以内に戻る。熱い集まりの外の作り直しの時間を記録する。
- 週次（staging）：見張りの動画で、東京の 503 でオリジングループが大阪へ逃がす。
- 日次：熱い集まりの写しの割合 98% 以上。

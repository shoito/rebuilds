---
status: accepted
date: 2026-10-10
---

# ADR-0064: スプールと blob は東京と大阪の別のバケットに置き、CRR と RTC で互いに写す。blob は 30 日まで Standard、パックは 90 日で Glacier Instant Retrieval に移す。Aurora は Global Database で大阪に写す。大阪への切り替えでは、写った東京のスプールのうち `spool-done` のないものを大阪で配り直し、blob が写っていないメッセージは写ったスプールから blob を作り直す。写る前に東京が失われた分だけが失われうる（RPO 15 分）ことを明記し、東京が戻れば残りを配る

詳細は [infrastructure.md](../architecture/infrastructure.md) の 5・7 節。

## Context

- 受け付けたメールを失わない（[ADR-0002](0002-accept-then-filter.md)）。NFR-004 は、リージョンの障害で、メタデータ RPO 1 分、blob とスプール RPO 15 分、受信の受け付け RTO 0、配送と閲覧の再開 RTO 1 時間を求める。
- 大阪の副 MX は常に動き、大阪のスプールと SQS に確定する（[inbound-smtp.md](../architecture/inbound-smtp.md) の 12 節）。
- 保存は 3 年後に物理 1.5 PB。古いメールの読み出しは少ない。S3 の単価（ap-northeast-1、2026-09-28 の公開分、2026-10-10 に確認）は Standard 0.025、Standard-IA 0.0138、Glacier Instant Retrieval 0.005 USD/GB・月で、Glacier Instant Retrieval の取り出しは 0.03 USD/GB、最短 90 日。東京から大阪への転送は 0.09 USD/GB（`AWSDataTransfer`、2026-09-16 の公開分）、RTC は 0.015 USD/GB。
- メタデータ（Aurora、RPO 1 分）と blob（S3、RPO 15 分）の写しの遅れが違う。切り替えの後に、行はあるが blob がないメッセージがありうる。
- 受信のメッセージの blob は、スプールの本文と同じバイトである（[ADR-0003](0003-message-storage-layout-and-dedupe.md)）。

## Options

写しと切り替え：

1. **非同期の写し（CRR＋RTC、Global Database）と、切り替えの時のスプールの配り直しと blob の作り直し**
2. 東京の 250 の前に、大阪のスプールにも同期で確定する
3. 写しをせず、東京の S3 の耐久性だけに頼る

保存の級：

- a. **Standard → パックは 90 日で Glacier Instant Retrieval**
- b. Standard のまま
- c. Intelligent-Tiering

## Decision

1 と a を採用する。

- バケット：`spool-tyo`・`spool-osa`（互いに CRR＋RTC）、`blobs-tyo` → `blobs-osa`（CRR＋RTC）、`quarantine-tyo` → 大阪。索引・特徴・書き出し・報告は写さない（作り直せるか、短命）。
- 級：個別の blob は Standard。256 KiB 以上の個別の blob は 30 日で Standard-IA、90 日で Glacier Instant Retrieval。パックは作って 90 日で Glacier Instant Retrieval。
- Aurora：すべてのクラスタを Global Database で大阪へ。二次は `db.r8g.large` を 1 つ。
- 切り替え（[disaster-recovery.md](../runbooks/disaster-recovery.md)）：(1) 受信は `mx2` が受け続ける、(2) Aurora を大阪へ、(3) `epoch` を進める（[ADR-0039](0039-change-log-states-and-jmap-changes.md)）、(4) `spool-osa` に写った東京のスプールのうち、切り替えの前 2 時間で `spool-done` のないものを大阪で配り直す（冪等。Aurora の RPO の中で記録を失ったものは重複しうる。失うより重複を選ぶ）、(5) `blob_missing` は写ったスプールから blob を作り直し、作り直せないものは「一時的に読めない」と示す、(6) 送信は大阪の Elastic IP の小さなプール `dr-out`（平常から温める）で上限を 1/4 に、(7) 閲覧の名前を大阪へ。
- 戻し：東京のスプールの残りを配り、Aurora を計画した切り替えで戻し、`epoch` をもう一度進める。
- 失いうる範囲：AZ の障害とリージョンの一時の停止では失わない。東京のリージョンの喪失では、写る前のスプール（RTC の 15 分の中）を失いうる。2 つのリージョンへの同期の確定（2）は持ち越し。

### 他の案を選ばなかった理由

- **2**：[ADR-0011](0011-spool-commit-and-sweeper.md) の確定を変え、250 の遅れを 50〜100ms 足し、大阪の S3 の可用性を東京の受け付けの前提にする。リージョンの喪失は稀で、S1 では NFR-004 の RPO 15 分の範囲とする。E17 の DR の訓練の後に測って決め直す。
- **3**：東京のリージョンの停止の間、閲覧と配送が止まる（RTO 1 時間を満たせない）。
- **b**：3 年後の保存の費用が東京だけで月 2.7 万 USD 増える。
- **c**：小さなオブジェクト（128 KiB 未満）は対象外で、監視の費用がオブジェクトの数に比例する。パックの読み出しの形が決まっているので、ライフサイクルで足りる。

## Consequences

- 良くなること：
  - 東京のリージョンの停止で、受け付けは止まらず、閲覧と配送を 1 時間で戻せる。
  - 写しの遅れの間の欠けを、スプールから埋められる。
  - 保存の単価が Standard の 5 分の 1 になる。
- 引き受けるコスト：
  - リージョンの喪失では、写る前のスプールを失いうる。
  - 切り替えの後に重複が入りうる。
  - 写しの転送の費用（書き込み 1 TB あたり約 110 USD）。古いメールの読み出しの取り出しの費用。パックを 90 日の前に詰め直すと最短の期間の費用がかかる。

## Confirmation

- 性質ベーステスト：PROP-INFRA-002（写ったスプールは大阪で少なくとも 1 回配られる）。
- 訓練：半年ごとの DR の訓練で、見張りのメールの欠け 0、受け付けの RTO 0、閲覧の再開 1 時間（[quality.md](../quality.md) の 2.2.1 節 F）。
- 監視：CRR の遅れ（15 分で page）、Global Database の遅延、`blob_missing` の数。
- 計測：`blob-pack-poc` で、パックの詰め直しの閾値と Glacier Instant Retrieval の最短の期間の費用を確かめる。

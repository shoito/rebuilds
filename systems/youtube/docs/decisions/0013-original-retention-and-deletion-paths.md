---
status: accepted
date: 2026-10-10
---

# ADR-0013: 元のファイルの消去は `original-deleter` の役割だけが行い、IAM の拒否と S3 のバージョンの管理（30 日）で他の経路を塞ぐ。創作者の削除は 30 日の猶予の後に、東京と大阪の両方で全バージョンを消す

## Context

- [ADR-0002](0002-upload-and-pipeline-orchestration.md) は、元のファイルを動画が残る間は保持し、消す経路を創作者の削除・保持の期限・法的な削除の手続きの 3 つだけにすると決めた。
- 規則をコードの約束だけで守ると、作業者の不具合、運用者の誤操作、ライフサイクルの規則の誤りで消えうる。
- 法的な削除（**法務の確認待ち：L1・L10**）は、すぐに消すことを求めうる。S3 の Object Lock（変更できない保持）はこれと両立しない。
- 大阪へは元のファイルを CRR で写す。CRR は既定ではバージョンの削除を写さない。

## Options

1. **専用の役割 `original-deleter` だけに `orig/` の削除を許し、他の役割は IAM で拒む。バージョンの管理を有効にし、古いバージョンを 30 日残す**
2. S3 Object Lock（governance）で保護し、削除のときに保護を外す
3. コードの規則とレビューだけで守る

## Decision

1 を採用する。詳細は [upload-and-ingest.md](../architecture/upload-and-ingest.md) の 7 節。

- `orig/` の接頭辞への `DeleteObject`・`DeleteObjectVersion`・`PutLifecycleConfiguration` は、`original-deleter` の役割にだけ許す。バケットの方針でも他の主体を拒む。
- `original-deleter` は、`original_deletions` の行（経路、承認、依頼の時刻）を読み、保全（legal hold）がないことを確かめてから消す。東京と大阪の両方で、全バージョンを消す。
- 経路ごとの猶予：創作者の削除は 30 日、`failed`・`abandoned` の動画は 30 日、法的な削除は承認から 24 時間以内（期限は法務の確認待ち）。
- 層の移し（Glacier Instant Retrieval、Deep Archive）はライフサイクルの規則で行い、消去の規則は置かない。
- 完了を返していないオブジェクト（SHA-256 の不一致、未完了のマルチパート）は元のファイルではなく、`upload-service` の掃除が消してよい。

> 2026-10-10 の注記：「保持の期限」の経路に、ライブのアーカイブで VOD のラダーを作り直さなかったものの元の流れ（`live-src/`）を足した。配信の終わりから 30 日で消す（[ADR-0031](0031-dvr-storage-and-live-to-vod.md) の注記。仮、PM と Dev の判断待ち）。消すのは `original-deleter` で、保全があれば消さない。


### 他の案を選ばなかった理由

- **2（Object Lock）**：governance の解除の権限を持つ役割が、結局 1 の専用の役割と同じになる。保持の期間を動画ごとに延ばし続ける運用が要る。
- **3（コードだけ）**：誤りの経路を塞げない。K1（消失 0 件）の根拠にならない。

## Consequences

- 良くなること：
  - 消去の経路を IAM で 1 つの役割に絞り、監査できる。
  - 誤った上書き・削除のマーカーを 30 日戻せる。
- 引き受けるコスト：
  - 古いバージョンの保存の費用（30 日）。
  - 大阪の写しを消す処理を自前で持つ。

## Confirmation

- IAM の方針の検査（CI）：`orig/` の削除を持つ役割が `original-deleter` だけであること。
- 毎週の S3 Inventory とカタログの突き合わせで、`original_deletions` にない消失が 0 件であること（[quality.md](../quality.md) の 2.2.1 節 F）。
- 障害の注入：作業者の役割で `orig/` の削除を試み、拒まれること。

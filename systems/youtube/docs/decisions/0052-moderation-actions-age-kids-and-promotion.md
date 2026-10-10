---
status: accepted
date: 2026-10-10
---

# ADR-0052: 措置は追記だけの `moderation_actions` に書いてから、対象の措置の要約を同じトランザクションで変えて outbox で配る。年齢の制限は `playable()` の `allow_with: age_check`、子ども向けの印はコメント・通知・個人化・広告・ライブチャットを止め、タイアップは創作者の申告と表示の枠だけを作る

## Context

- 措置は記録してから効かせ、配信の停止は 60 秒以内（AGENTS.md、NFR-014、[ADR-0005](0005-cdn-and-origin-strategy.md)）。見える範囲は `playable()` の 1 か所（[ADR-0009](0009-single-tenant-and-playable.md)）。
- X の題材は、追記だけの措置の記録と要約の列の形を決めた（[X の ADR-0038](../../../x/docs/decisions/0038-moderation-action-model.md)）。
- 子ども向けの動画での個人化・コメント・通知の止め方は**法務の確認待ち：L3**、タイアップの表示は**法務の確認待ち：L4**。本家は子ども向けのチャンネルの通知を送らない（[Manage YouTube notifications](https://support.google.com/youtube/answer/3382248)、2026-10-10 に確認）。

## Options

1. **追記だけの記録 ＋ 要約の列 ＋ outbox。措置の種類を経路ごとの効果の表で決める**
2. 動画の状態の列だけを書き換える
3. 経路ごとに別の措置の表を持つ

## Decision

1 を採用する。詳細は [comments-and-moderation.md](../architecture/comments-and-moderation.md) の 7・8 節。

- 措置の種類：動画は `interstitial`・`age_restrict`・`limited`・`limited_search`・`region_block`・`remove`。コメントは `remove`。チャンネルは機能の制限と停止の依頼。
- 記録：対象、種類、範囲、根拠、主体（人か規則とバージョン）、期限、`supersedes`。取り消しも新しい行。要約（`mod_flags` など）と `state_version` を同じトランザクションで変え、outbox の `moderation_action_applied` で `playable()` の写し・拒否の一覧・検索・おすすめに配る。
- 通報：対象と区分の組の案件、P0（1 時間）〜P3（7 日）。措置への異議は 30 日以内、別の担当が 7 日以内に見る。
- 年齢の制限：年齢を確かめた 18 歳以上だけ `allow`、他は `allow_with: age_check`。埋め込みでは再生しない。
- 子ども向け：アップロードで必ず答えを求める。分類器は審査の待ち行列に入れるだけ。効果はコメントなし、通知なし、個人化しない並び、履歴に入れない、`no_ads`、ライブチャットなし、メンバー限定なし。
- タイアップ：`paid_promotion` の申告、最初の 10 秒と説明の欄の表示、通報の区分。文言と責任の範囲は法務の確認の後。

### 他の案を選ばなかった理由

- **2（状態の列だけ）**：誰がなぜ措置したか、取り消しの経緯が残らない。異議と公表の集計ができない。
- **3（経路ごとの表）**：経路の判定がずれ、漏れの経路が生まれる。

## Consequences

- 良くなること：
  - すべての経路が同じ要約と `playable()` から効果を得る。
  - 措置の監査と公表の集計ができる。
- 引き受けるコスト：
  - 要約の列と記録の一致を確かめ続ける。

## Confirmation

- PROP-MOD-001、DT-CMT-002・003、PROP-CMT-005。
- 見張りの措置：毎日、見張りの動画に措置をかけ、60 秒で配信が止まる（[quality.md](../quality.md) の 2.2.1 節 I）。

---
status: accepted
date: 2026-10-10
---

# ADR-0048: 申し立ては `active → disputed → reinstated → appealed` の状態の機械で持ち、権利者の応答の期限を異議 30 日・再審査 7 日にする。ブロックの申し立ては異議を飛ばして再審査に進め、期限は遷移の時刻に絶対の時刻で書いて 1 分ごとの作業で進める

## Context

- [architecture/README.md](../architecture/README.md) の 6 節は、権利者は 30 日で応え、応えなければ一致を外すと決めた（30 日は本システムの値、本家の値は未検証としていた）。
- 本家は、異議への応答 30 日、再審査への応答 7 日、ブロックの申し立ての直接の再審査（7 日）を公開している（[Dispute a Content ID claim](https://support.google.com/youtube/answer/2797454)、2026-10-10 に確認）。README の 30 日は本家と同じだと確かめられた。
- 期限を過ぎた申し立てが放っておかれると、創作者の収益と公開が不当に止まる。

## Options

1. **状態の機械と、遷移の時刻に書く絶対の期限。1 分ごとの期限の作業**
2. 状態ごとに読み出しの時に期限を計算する（作業を持たない）
3. 時刻の待ち行列（SQS の遅延）で 1 件ずつ起こす

## Decision

1 を採用する。詳細は [copyright-claims-and-disputes.md](../architecture/copyright-claims-and-disputes.md) の 7 節。

- 状態：`active`、`disputed`、`reinstated`、`appealed`、`takedown_requested`、終わりの `released`・`expired`・`withdrawn`・`removed`、`upheld`（権利者だけが後から `released` にできる）。
- 期限：`disputed` 30 日、`appealed` 7 日、`reinstated` の後の再審査の申立て 30 日（本システムの値）、ブロックの直接の再審査 7 日。`takedown_requested` は `legal.copyright.*`（ADR-0049）。
- 期限は `respond_by`（UTC の絶対の時刻）に書き、`claim-deadline-worker` が 1 分ごとに `FOR UPDATE SKIP LOCKED` で 500 行ずつ進め、遷移と outbox を同じトランザクションで書く。
- 遷移は `claim_transitions` に追記する。状態ごとの効果は DT-CLM-002。
- 再審査の条件（本システムの値）：有効な違反の記録がない、開いている再審査が 3 件以下。

> 2026-10-10 の注記：再審査の条件を、領域の文書に揃えて「チャンネルが上級の機能の段にある（有効な strike がないことを含む。[ADR-0061](0061-creator-tiers-strikes-and-account-standing.md)）、開いている再審査が 3 件以下」にした。


### 他の案を選ばなかった理由

- **2（読み出しで計算）**：期限切れの効果（ブロックの解除、預かりの移し、通知）を誰も起こさない。
- **3（遅延の待ち行列）**：SQS の遅延は 15 分が上限で、30 日の期限に使えない。

## Consequences

- 良くなること：
  - 期限を過ぎた申し立てが p99 5 分で必ず進む。
  - 本家と同じ期限で、権利者と創作者に分かりやすい。
- 引き受けるコスト：
  - 期限の作業の遅れを見張る。

## Confirmation

- PROP-CLM-003・004、DT-CLM-002。
- E2E：時計を進め、応答のない異議が 30 日で外れる。

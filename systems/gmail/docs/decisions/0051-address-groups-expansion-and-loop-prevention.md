---
status: accepted
date: 2026-10-10
---

# ADR-0051: アドレス・別名・グループは directory の `addresses` の 1 つの名前空間に置く。グループの展開は `inbound-pipeline` が配送の前に行い、入れ子 5 段・展開の後の受け手 1 万を上限に、同じグループを 2 回展開しない。配送の鍵は `(spool_id, account_id)` で、直接とグループの両方で宛てられた人にも 1 通だけ配る。外のメンバーへは転送と同じ形（SRS・ARC、`forward` のプール）で送り、本システムのループの印で止める

詳細は [organizations-domains-and-routing.md](../architecture/organizations-domains-and-routing.md) の 7 節。

## Context

- 組織は別名とグループ（配布）を使う（[intent.md](../intent.md) の「組織」）。グループは入れ子にでき、外のアドレスをメンバーに持てる。
- 宛先は RCPT の時点で確かめ、グループは「ある」ことだけを確かめる（[ADR-0013](0013-recipient-validation-and-transaction-splitting.md)）。展開は受け付けた後に行う。
- 配送は `(spool_id, recipient)` で冪等にする（[ADR-0002](0002-accept-then-filter.md)）。同じ人が直接とグループの両方で宛てられたとき、`recipient` をアドレスにすると 2 通入る。
- 入れ子のグループの循環、外のメーリングリストとの往復で、ループが起きうる。
- 本家のグループの上限は、公式の資料で確かめられなかった（**未検証**）。
- 外のメンバーへの送信は、本システムからの送信で、送信の評判の関門を通す必要がある（`AGENTS.md`）。

## Options

1. **配送の前に展開し、受け手を `account_id` で重複を除き、展開の結果を記録して読み直しに使う**
2. RCPT の時点で展開し、メンバーを宛先として SMTP のトランザクションに入れる
3. グループを 1 つのメールボックスにし、メンバーは委任で読む

## Decision

1 を採用する。

- 名前空間：`addresses(tenant_id, address_id, domain_id, local_norm_hmac, local_display_enc, target_kind, target_id)`、`(domain_id, local_norm_hmac)` で一意。点の扱いは `domains.local_part_policy`（本システムのドメインは `dots_ignored`、組織のドメインは `dots_significant`）。
- 展開：選別の判定の後、組織の規則の前。入れ子 5 段、展開の後の受け手 1 万（組織で 5 万まで）、メンバー 5 万。同じグループは 1 回だけ展開する。結果を `expansion/<spool_id>` に置き、読み直しで使う。
- 配送の鍵：`(spool_id, account_id)`。
- 投稿の許可：`anyone`・`org`・`members`・`managers`。`org` は DMARC の `pass` か本システムの中からの送信のときだけ組織とみなす。当たらないメッセージは配らず、DSN を返さない。
- 外のメンバー：最後の判定が受信箱のものだけを、SRS・ARC を付けて `forward` のプールから送る（[ADR-0048](0048-verified-forwarding.md)）。グループの組織の送信の上限に数える。
- ループ：`X-<Brand>-Loop: <HMAC(group_id) の先頭 16 文字>` を足し、同じ印があれば展開しない。印 10 個、`Received` 50 を超えたら展開しない。

### 他の案を選ばなかった理由

- **2**：展開の後の宛先が 100 を超え、トランザクションの宛先の上限（[ADR-0002](0002-accept-then-filter.md)）を超える。RCPT の応答の遅れが大きくなる。投稿の許可は From を見るまで決められない。
- **3**：組織の配布の振る舞い（メンバーの受信箱に届く）と違う。委任は MVP の後。

## Consequences

- 良くなること：
  - 同じ人に 1 通だけ届く。読み直しでメンバーが変わっても結果が変わらない。
  - 循環と外との往復が有限で止まる。
  - 外のメンバーへの送信も関門と評判のプールを通る。
- 引き受けるコスト：
  - 展開の結果の記録を S3 に書く（グループあてのメッセージだけ）。
  - 大きなグループのメッセージは、配送の数が多く、受信の遅れの予算を食う（1 万の受け手で数十秒。NFR-001 は受け手ごとの p95 で見る）。
  - 投稿の許可で落としたメッセージを、送り手は知らない。

## Confirmation

- 性質ベーステスト：PROP-ORG-001（有限・1 回・2 回展開しない）、PROP-ORG-002（読み直しで同じ結果）。
- 結合：外のメンバーと外のメーリングリストの往復（`X-<Brand>-Loop`）、直接とグループの重なり。
- lint：配送の鍵を作る関数は `AccountId` を取り、アドレスを取らない。

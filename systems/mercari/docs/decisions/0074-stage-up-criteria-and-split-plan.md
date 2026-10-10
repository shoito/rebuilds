---
status: accepted
date: 2026-10-10
---

# ADR-0074: 段階を上げる基準を 8 つの指標で見て、各指標の上限の 60% で準備を始める。S2 で content を種類ごとのクラスタに、OpenSearch を販売中と売れた品の索引に、ledger の熱い口座をスロットに分ける。S3 で core を `core-accounts` と `core-market`（`listing_id` のハッシュで 16）に分け、ledger を口座の持ち主のハッシュで分ける

## Context

- 規模の段階は S1（MAU 300 万）、S2（1,000 万）、S3（2,500 万）を見込む（[architecture/README.md](../architecture/README.md) の 2 節）。
- 購入は出品の行と取引の行を 1 つのトランザクションで書く（[ADR-0002](0002-transaction-state-machine-and-single-purchase.md)）。core を分けるときは、出品と取引を同じ分け先に置く必要がある。
- ledger の熱い口座（`fee_revenue`・`psp_receivable`）は S2 からスロットに分ける（[ADR-0003](0003-escrow-and-double-entry-ledger.md)）。
- 分ける作業は 1 四半期かかる。上限に当たってから始めると間に合わない。
- [roadmap.md](../roadmap.md) の延期の一覧は「core の分割（S3）と ledger の分割（S2）」と書く。この ADR は、S2 の ledger の作業を熱い口座のスロットと読み、持ち主のハッシュでの分割を S3 に置く。

## Options

1. **指標と準備の基準で見て、まず大きい型へ上げ、上げきる前に分ける準備を終える。分ける順を先に決める**
2. 段階（MAU）の到達で機械的に分ける
3. 最初から分けた形（シャード）で作る

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md) の 8 節。

- 指標：core の書き込みの CPU、core の書き込みの行、ledger の熱い口座のロックの待ち、content の書き込みの行、OpenSearch の件数とシャードの大きさ、Valkey のメモリー、期限の処理の 1 分の件数、アカウントの上限。各指標の上限の 60% で準備を始め、2 つが超えたら S2 の計画を始める。
- S2：content を `content-social`・`content-notify`・`content-ts` に分ける。OpenSearch を販売中と売れた品の索引に分ける。ledger の熱い口座をスロットに分け、残高の行を持たない。

> 2026-10-10 の注記：Context の roadmap の記述（ledger の分割は S2）は、統合の工程で roadmap を直し、S2 は熱い口座のスロット、S3 は口座の持ち主のハッシュでの分割に揃えた。

- S3：core を `core-accounts`（利用者の ID で引く表）と `core-market`（出品・取引・取引の事象・配送。`listing_id` のハッシュで 16）に分ける。買い手の取引の一覧は content の読み出しの表で引く。ledger を口座の持ち主のハッシュで分け、`escrow` は売り手の分け先に置く。細部は S3 の準備を始める時に後継の ADR で決める。
- 月次のキャパシティのレビューで指標を見る。

### 他の案を選ばなかった理由

- **2（MAU で機械的に）**：負荷の形（企画の日の山、人気の出品、通知の量）は MAU に比例しない。早すぎる分割は費用と運用を増やし、遅すぎると間に合わない。
- **3（最初から分ける）**：S1 で分け先をまたぐ問い合わせ（買い手の取引の一覧、運用の画面）と移し替えの道具を持つことになり、MVP が遅れる。

## Consequences

- 良くなること：
  - S1 は 3 クラスタの素直な形で作れる。
  - 分ける順と鍵が先に決まり、表の設計（`listing_id` を取引の表に持つ、パッケージの境界）を今から合わせられる。
- 引き受けるコスト：
  - S3 で core を分けるとき、利用者の ID で引く読み出し（買い手の取引の一覧）を読み出しの表に移す作業が要る。
  - ledger を分けると、refund の買い手の側が分け先をまたぐ。仮の口座の移しを設計する。

## Confirmation

- 月次のキャパシティのレビューの記録（`capacity_reviews`）で 8 指標を見る。
- lint：パッケージをまたぐ表の書き込みの禁止（[ADR-0001](0001-platform-and-stack.md)）が、S2 の content の分割の前提を守る。
- S2 の前に、content の分割の手順を staging で試す。

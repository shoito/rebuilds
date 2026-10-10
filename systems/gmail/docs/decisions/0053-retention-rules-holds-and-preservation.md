---
status: accepted
date: 2026-10-10
---

# ADR-0053: 保持の規則は「範囲（組織・OU・アカウント）× ラベルの条件 × 受け付けからの日数」で、期間の中は利用者が消しても保全し、期間の後に消すか残すかを選ぶ。保留は案件の範囲（アカウント・OU、日付、IR の条件）で、規則より常に強い。評価は消す時に行い、当たるメッセージはメールボックスの行を `preserved_messages` に移して `hold` の参照を足す。複数の規則は最も長いものが勝つ。保全のあるテナントの鍵は破棄しない

詳細は [retention-and-ediscovery.md](../architecture/retention-and-ediscovery.md) の 4 節。

## Context

- 組織は、訴訟と監査のための保留と、ラベルと日数による保持を求める（[intent.md](../intent.md) の「保持と eDiscovery」）。保留の対象は、利用者が完全に削除しても、保留が外れるまで消えない（同「守るべき振る舞い」）。
- 本家は、保留が規則より強く、複数の規則は最も長いものに従い、個別の規則は既定の規則より強い（[How retention works](https://knowledge.workspace.google.com/vault/retention/how-retention-works)、2026-10-10 に確認）。
- 保留のあるメッセージも、利用者が消せばメールボックスの行は消え、blob は `hold` の参照で残る（[ADR-0031](0031-blob-references-gc-and-quota.md)）。eDiscovery が消えたメッセージを探すには、行の情報（差出人、件名、日付）が残る必要がある。
- S1 の組織は最大 20 万人・1 人 2.7 万通。保留を置いた時に全メッセージに参照を足すと、数十億の行を書く。
- 消去の期限は法務の L6。消去は鍵の破棄で行う（[ADR-0003](0003-message-storage-layout-and-dedupe.md)）。

## Options

保留の効かせ方：

1. **消す時に評価し、当たるものだけを保全の行に移す**
2. 保留を置いた時に、範囲の全メッセージに `hold` の参照を足す
3. 保留の範囲のアカウントでは、削除を一切止める（メッセージは隠すだけ）

保全したメッセージの置き場所：

- a. **同じシャードの別の表 `preserved_messages`**
- b. メールボックスの行に `preserved` の印を付けて残す
- c. 保留の専用の置き場所（別のクラスタ）

## Decision

1 と a を採用する。

- 規則：範囲 × ラベルの条件（`any`・システムのラベル・`archived`・`label:<名前>`）× 1〜36,500 日 × `purge`・`keep`。組織の既定の規則は 1 つ、個別は 100 まで。個人のアカウントには置かない。
- 評価：`retention_decision(message, holds, rules, now)` の 1 つの関数（DT-RET-001）。保留 > 個別の規則の最長 > 既定の規則。
- 消す時：`mailstore` が行を消すすべての経路で評価し、保全なら同じトランザクションで行を `preserved_messages` に移し、change log に `destroyed`（`preserved` の印）を書き、`hold:<tenant_id>:<message_id>` の参照を足す。
- 保留の IR の本文の条件は、1 通 CPU 200ms・2 MiB の予算で、超えたら保全する。
- 保留は作成から 60 秒（`effective_at`）で効く。directory の停止で保留が読めないときは消さない。
- 期限の処理：シャードごとに 1 日 1 回、`purge` の規則の期間を過ぎたものを X4 で消す。保全の行も評価し直して消す。
- 保全の行は利用者の容量に数えず、組織の `preserved_bytes` に数える。利用者のどの経路にも出さない。
- 保全の行・`archived` のアカウント・保留のある案件がある間は、テナントの根の鍵と、包んだ鍵の残る日ごとの KEK を破棄しない（[ADR-0060](0060-key-hierarchy-and-crypto-erasure.md)）。

### 他の案を選ばなかった理由

- **2**：書き込みの量が保留の範囲に比例し、OU の将来のメンバーの扱いが別に要る。保留を外す時にも同じ量を書く。
- **3**：利用者の容量と画面に、消したはずのメッセージが残る。メールボックスのモデル（[ADR-0004](0004-labels-as-primary-mailbox-model.md)）に見えないメッセージの例外が入る。
- **b**：JMAP・IMAP・検索・容量のすべてに、見えない行の例外が入る（[ADR-0025](0025-org-quarantine-and-allow-block-lists.md) が隔離で避けたのと同じ理由）。
- **c**：保全の行とメッセージの行の移しが、シャードをまたぐ分散の書き込みになる。

## Consequences

- 良くなること：
  - 保留を置く費用が範囲の大きさに依らない。将来のメンバーにも効く。
  - 保全の行と削除が 1 つのトランザクションで決まる。
  - 利用者の画面に例外が入らない。
- 引き受けるコスト：
  - 消すすべての経路が保留のキャッシュと評価を通る。消す操作の遅れが増える（2 節の予算）。
  - 保留の作成から 60 秒は効かない。
  - 本文の条件の評価で blob を読む費用。
  - 検索に `PRESERVED` の状態を足す（[search.md](../architecture/search.md) の持ち主との調整）。

## Confirmation

- 性質ベーステスト：PROP-RET-001（保留の中の消去 0）、PROP-RET-002（保留のないものは消える）、PROP-RET-003（評価の順）、PROP-RET-006（利用者に出ない）。
- 表駆動テスト：DT-RET-001、DT-RET-002。
- lint：`mailstore` の中で、メッセージの行を消す SQL は `delete_message_row` の 1 つの関数だけが書き、その関数は `retention_decision` を呼ぶ。
- 本番：保全の行の数と組織の `preserved_bytes`、期限の処理の遅れを監視する。

---
status: accepted
date: 2026-09-28
---

# ADR-0052: KMS の鍵を用途とアカウントで分け、テナントの物体はテナントごとの鍵で守り、保管庫・振込ファイル・署名には専用の鍵を置く

詳細は [security.md](../architecture/security.md) の 5 節。

## Context

- 口座番号は項目ごとにエンベロープ暗号化する（[ADR-0005](0005-security-and-my-number.md)）。給与の入力の文書は「テナントの KMS の鍵」で S3 に置く（[ADR-0026](0026-payroll-run-stages-and-input-snapshot.md)）。振込ファイルは専用の鍵で置く（[payments-and-accounting.md](../architecture/payments-and-accounting.md) の 10 節）。
- 保管庫は専用の KMS の鍵を持つ（ADR-0005）。保管庫への操作者の主張の署名（[ADR-0046](0046-purpose-bound-vault-api-and-access-log.md)）と、監査の日の署名（[ADR-0048](0048-audit-log-hash-chain-and-anchoring.md)）にも鍵が要る。
- テナントが解約したとき、S3 とバックアップに残ったテナントのデータを確実に読めなくしたい。
- KMS の鍵は東京で 1 本あたり月 1 USD、要求は 1 万回あたり 0.03 USD（[AWS Price List API](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/awskms/current/ap-northeast-1/index.json)、2026-09-28 に確認）。
- DR は大阪（NFR-006）。鍵が大阪で使えなければ、切り替えの後に復号できない。

## Options

1. **用途とアカウントで鍵を分ける。テナントの S3 の物体と項目の DEK はテナントごとの鍵。振込ファイル・保管庫（番号、HMAC、書類）・主張の署名・監査の署名は専用の鍵。どれもマルチリージョン**
2. 全体で 1 本のデータの鍵と、保管庫の鍵だけ
3. テナントごとの鍵を持たず、テナントごとの DEK を 1 本の鍵で包む

## Decision

1 を採用する。鍵の一覧は [security.md](../architecture/security.md) の 5.2 節。

- テナントの鍵 `<brand>-tenant-<tenant_id>` は、テナントの作成のときに作る。暗号の文脈に `tenant_id` を入れる。S3 はバケットキーを使って要求を減らす。
- `vault-mn`・`vault-hmac`・`vault-docs` は保管庫のアカウントにだけ置き、保管庫のタスクのロールだけが使う。人のロールには、break-glass を含めて与えない。
- `<brand>-bank-files` は振込ファイルの生成と取り出しの Worker のロールだけ。
- `<brand>-hr-vault-assertion`（署名）は `api` だけが `Sign`。`<brand>-audit-anchor`（署名）は log-archive のアカウントで `audit-verifier` だけが `Sign`。
- どれもマルチリージョン（主は東京、レプリカは大阪）。対称の鍵は自動のローテーション。削除の待ちは 30 日。削除の予約とキーポリシーの変更は SCP で break-glass のロール以外に禁じ、CloudTrail で呼び出す。
- テナントの解約：返却と保存の期間の後に、テナントの鍵の削除を予約し、暗号の消去にする（2 人の承認）。
- 2 を採らない理由：テナントの解約の後に、S3 とバックアップに残る暗号文を個別に探して消すことになる。1 本の鍵の権限が全テナントに及ぶ。
- 3 を採らない理由：DEK を包む鍵が全テナントで同じで、解約のテナントだけを暗号で消すには、DEK を包んだ行を探して消すことになる。S3 の SSE-KMS はテナントごとの鍵のほうが素直。

## Consequences

- 良くなること：
  - テナントの解約で、鍵の削除によって S3 とバックアップの暗号文を読めなくできる。
  - 鍵の使用の記録（CloudTrail）が、テナントと用途ごとに分かれる。
- 引き受けるコスト：
  - テナントの鍵の数だけ費用（S1 で月 600 USD 程度）と管理がかかる。S2・S3 でも 1 テナント 1 本にするか（数の上限、費用）は S2 の前に決める。マルチリージョンのレプリカの費用の扱いは未検証。
  - 鍵を誤って削除すると、そのテナントのデータを失う。削除の予約の SCP、2 人の承認、30 日の待ち、呼び出しのアラートで守る。

## Confirmation

- IAM の静的検査（Terraform の CI）：`vault-mn` の `kms:Decrypt` を持つ主体が保管庫のタスクのロールだけ。`<brand>-bank-files` の `Decrypt` が振込ファイルの Worker のロールだけ。人のロールに保管庫の鍵の `Decrypt` がない。
- 日次：すべての鍵のレプリカが大阪で有効。
- CloudTrail のアラート：キーポリシーの変更、削除の予約、無効化、想定外の主体の `Decrypt`・`Sign`。

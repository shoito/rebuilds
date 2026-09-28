---
status: accepted
date: 2026-09-28
---

# ADR-0054: 保管庫を別の OU のアカウントに置き、人事の側とは PrivateLink の片方向の経路だけでつなぎ、Payroll Compute は DB に経路のないサブネットに置く

詳細は [infrastructure.md](../architecture/infrastructure.md) の 1・2 節。

## Context

- [ADR-0005](0005-security-and-my-number.md) は、保管庫を別の AWS アカウントに、専用の ECS・Aurora・KMS で置き、人事の側は相互 TLS の API で `mn_ref` を使って呼ぶと決めた。
- 保管庫の画面は、人事の側を通さずに番号を受ける（[ADR-0045](0045-my-number-collection-and-identity-verification.md)）。保管庫にもインターネットからの入口が要る。
- 保管庫は、書類の元のデータ（番号を含まない）を人事の側から読む（[ADR-0046](0046-purpose-bound-vault-api-and-access-log.md)）。
- Payroll Compute は DB を直接は読まない（[ADR-0004](0004-payroll-engine.md)）。今は lint とコードの規則で守っている。
- 他の題材（Auth0 の ADR-0057）は、アカウントを management・security・log-archive・shared・edge・dev・staging・prod に分けた。

## Options

保管庫の境界：

1. **別の OU（Workloads/Vault）のアカウント。人事の側 → 保管庫は、保管庫が公開する PrivateLink だけ。保管庫 → 人事の側は、人事が公開する読み取りの PrivateLink だけ。保管庫の private のサブネットは外への経路を持たない。画面の入口は保管庫の CloudFront と ALB**
2. 同じアカウントの別の VPC と、VPC ピアリング
3. 同じ VPC の別のサブネット

Payroll Compute：

- a. **DB・Valkey への経路のない `payroll` のサブネット。VPC エンドポイント（S3、SQS、ECR、Logs、KMS）だけ**
- b. private のサブネットに置き、コードの規則だけで守る

## Decision

1 と a を採用する。

- アカウント：management、security、log-archive、shared、edge、dev、staging、prod、vault-staging、vault-prod。
- Workloads/Vault の OU の SCP：保管庫の鍵の `Decrypt` を保管庫のタスクのロール以外に禁止、ECS Exec の禁止、vault-web の public 以外でのインターネットゲートウェイ・NAT の作成の禁止。
- PrivateLink の許可する主体は、相手のアカウントだけ。相互 TLS は保管庫の Private CA。
- 保管庫の画面の配信（CloudFront、WAF）は vault-prod の中に置き、人事の側の edge のアカウントと分ける。
- Payroll Compute のセキュリティグループは、Aurora・Valkey への出口を持たない。
- 2 を採らない理由：ピアリングは双方向の経路を作り、どちらの側からも相手のサブネットへ届く。アカウントが同じなら、IAM の管理者が両方に届く。
- 3 を採らない理由：人事の側の DB・バックアップ・ログの経路と権限が、保管庫と同じ範囲になる（ADR-0005 の b を採らなかった理由と同じ）。
- b を採らない理由：Payroll Compute の依存の侵害や誤りで DB を読むと、再現性（入力の文書だけから決まる）が崩れる。網で止めれば、コードの誤りでも読めない。

## Consequences

- 良くなること：
  - 特定個人情報の安全管理の範囲が、vault-prod のアカウントとそのネットワークに閉じる。
  - Payroll Compute の「DB を読まない」が、網で守られる。
- 引き受けるコスト：
  - 保管庫のために、CloudFront・WAF・ALB・Private CA・VPC エンドポイント・Aurora を別に持つ（[infrastructure.md](../architecture/infrastructure.md) の 11 節の費用）。
  - 2 方向の PrivateLink の管理と、証明書のローテーションの監視。
  - S3 のセルでは、セルごとに vault-prod を持つ。

## Confirmation

- plan のポリシー検査：vault-prod の private と prod の `payroll` のサブネットの経路表に NAT・IGW がない。Payroll Compute のセキュリティグループに Aurora・Valkey への出口がない。
- 結合テスト（staging）：Payroll Compute のタスクから Aurora への接続が失敗する。人事の側から保管庫の Aurora に届かない。
- IAM の静的検査：[ADR-0052](0052-kms-key-hierarchy.md) の鍵の条件。

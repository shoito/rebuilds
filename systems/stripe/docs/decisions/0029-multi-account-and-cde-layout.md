---
status: accepted
date: 2026-09-26
---

# ADR-0029: AWS のアカウントを PCI DSS の範囲で分け、CDE は live と test を別のアカウントにする

## Context

[ADR-0005](0005-pci-scope-segmentation.md) で、CDE を本体と別の AWS アカウントに置くと決めた。まだ決まっていないのは、次の 4 つである。

- テスト環境（`<brand>_pk_test_`）の Vault をどこに置くか。加盟店はテスト環境に本物のカード番号を誤って入れることがあり、受け取った時点で CDE の統制が要る。
- 本体と CDE をどうつなぐか。経路が増えるほど、PCI DSS の範囲とネットワークの統制が広がる。
- CDE のイメージ、CI のロール、Terraform の状態をどこに置くか。
- アクワイアラ・決済代行への接続を、どのアカウントから出すか。

Slack は、用途ごとのアカウント（management、security、log-archive、shared、dev、staging、prod）を Organizations で分けている（Slack の infrastructure.md の 1 節）。

## Options

テスト環境の Vault：

1. live の CDE の中に、テスト環境の Vault も置く
2. **テスト環境の Vault を、別の CDE のアカウント（cde-test）に置く**
3. テスト環境の Vault を、CDE の外（本体の prod）に置き、テスト用のカード番号以外をブラウザ側で拒否する

本体と CDE の接続：

A. VPC ピアリングか Transit Gateway でつなぎ、セキュリティグループで絞る
B. **本体 → CDE は PrivateLink、CDE → 本体は SQS の 2 本だけ**

## Decision

2 と B を採用する。構成は [infrastructure.md](../architecture/infrastructure.md) の 1・2 節、CDE の中は [card-vault.md](../architecture/card-vault.md) の 2 節にある。

- **アカウント**：Slack の構成に、CDE の OU（cde-shared、cde-nonprod、cde-test、cde-live）を足す。本体の prod は live と test の DB を両方持つ（[ADR-0002](0002-account-tenancy.md)）。
- **PCI DSS の範囲**：CDE の OU のアカウントは範囲内。management・security・log-archive は、CDE の権限を配る・CDE のログを保管する接続先として範囲に入れる。本体の prod・dev・staging・shared は範囲外とし、範囲外であることを年次で確かめる。
- **テスト環境の Vault は cde-test に置く。** テスト環境の connector-gateway は、模擬のアクワイアラにだけつなぐ。
  - 1 は、テスト環境の変更（加盟店の統合の試験のための模擬のアクワイアラ、実験的な機能）と負荷（カードテスティングの攻撃）が、live の CDE の変更管理・容量・KMS の上限に及ぶ。
  - 3 は、ブラウザ側の検査を回避されると、本物のカード番号が CDE の外に届く。届いた時点で、本体が PCI DSS の範囲に入る。
- **Elements と Checkout は、公開キーの接頭辞で送り先のホスト名（`vault.<domain>` / `vault-test.<domain>`）を選ぶ。** 本体の VPC と ALB を経由しない。
- **本体と CDE は、2 本の決まった経路だけでつなぐ。**
  - 本体 → CDE：CDE が公開する PrivateLink のエンドポイントサービス（相互 TLS）。許可するのは prod のアカウントだけ。
  - CDE → 本体：prod の SQS キュー（`connector-results`）。キューのポリシーで cde-live（test は cde-test）のロールだけを許可する。コネクタの結果と、カード番号を除いたアクワイアラの通知（[ADR-0014](0014-connector-inbox.md)）を運ぶ。
  - A は、経路表とセキュリティグループの誤りひとつで、本体から CDE の内部へ届く経路ができる。B は、そもそも経路がない。CDE から本体へ HTTP で呼ぶ経路も作らない。
- **CDE のイメージ・CI の起点・Terraform の状態は cde-shared に置く。** 本体の CI のロールは、CDE のアカウントのロールを引き受けられない（SCP で拒否。[ADR-0033](0033-cde-pipeline-and-change-control.md)）。
- **カード番号を扱うコネクタは cde-live から出す。** 扱わないコネクタ（コンビニ、銀行振込、精算ファイルの取得）は本体から出す。
- **大阪の送信元の IP も、最初から接続先に登録する。** リージョンの切り替えで、接続先の許可リストの変更を待たない（[ADR-0030](0030-payments-disaster-recovery.md)）。
- **CDE に常設の人の権限を置かず、AI エージェントには CDE の経路を与えない**（[ADR-0020](0020-cde-access-model.md)）。
- S3 のセル構成では、セルごとに prod と cde-live の組を持つ（[ADR-0031](0031-active-active-cells.md)）。

## Consequences

- 良くなること：
  - live の CDE の中身が、Vault・connector-gateway とその関連に絞られる。監査の範囲と変更の頻度が小さい。
  - 本体から CDE への経路が構成として 2 本しかなく、評価と説明が容易になる。
- 引き受けるコスト：
  - アカウントが 4 つ増える。Network Firewall・NAT・VPC エンドポイント・CloudFront を CDE ごとに持つので、固定費が増える（[infrastructure.md](../architecture/infrastructure.md) の 9 節）。
  - cde-test も PCI DSS の統制の対象として運用する。CDE のデプロイは cde-test → cde-live の 2 段になる。
  - AWS PrivateLink は AWS の PCI DSS の対象サービスの一覧に名前がない（2026-09-26 に確認。[AWS Services in Scope](https://aws.amazon.com/compliance/services-in-scope/PCI/)）。通すのはトークンだけだが、境界の装置として QSA がどう扱うかは **未検証**。E10 の QSA の事前相談で確かめ、問題があれば、CDE の側に置いた NLB と相互 TLS の評価で補う。

## Confirmation

- Terraform の plan のポリシー検査：CDE の VPC に、ピアリング・Transit Gateway の接続・本体の CIDR への経路が含まれていたら失敗させる。
- IAM Access Analyzer：CDE のアカウントのロール・KMS の鍵・PrivateLink のエンドポイントサービス・`connector-results` のキューを、許可したプリンシパル以外が使えないこと。
- SCP の検査：本体の OU のロールが CDE の OU のロールを引き受けられないこと（四半期ごとに、試行が拒否されることを確かめる）。
- 年次：本体（prod）が PCI DSS の範囲外であることの確認（データの流れの図の更新と、カード番号の走査の結果）を、QSA の評価に含める。

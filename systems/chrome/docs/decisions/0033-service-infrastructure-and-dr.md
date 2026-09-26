---
status: accepted
date: 2026-09-26
---

# ADR-0033: サービスは配信を静的にして CDN で守り、署名の鍵と診断のデータを専用のアカウントに分ける

## Context

クラウドのサービス（更新の配信、Safe Browsing、同期、アカウント、クラッシュ、テレメトリ、拡張機能のストア）を AWS に置く（ADR-0001）。Slack の構成（ECS Fargate、Aurora、Terraform、OpenTelemetry）を引き継ぐが、次の点が Slack と違う。

- 更新の配信と Safe Browsing は 99.95%（NFR-010）で、しかも世界中の端末が相手になる（S3）。
- 更新の署名の鍵が漏れると、全端末が侵害されうる。
- クラッシュのダンプは、利用者のメモリの一部を含みうる。
- 緊急の修正のとき、配信の帯域が一時に集中する。

## Options

1. **配信できるものを静的なファイルにして CDN で守り、API は予備の経路を持つ。署名の鍵と診断のデータを専用のアカウントに分ける**
2. **すべてを API のサービスとして、Slack と同じ 1 つの本番のアカウントに置く**
3. **更新の配信を外部の配信サービス（ストア、既製の更新の配信の SaaS）に任せる**

## Decision

1 を採用する。詳細は [infrastructure.md](../architecture/infrastructure.md)。

- **静的な配信**：更新の成果物・予備のマニフェスト・Safe Browsing のリスト・フィールドトライアルの設定は、S3 に置いて CloudFront で配る。S3 を大阪へ複製し、CloudFront のオリジングループで GET を大阪へフェイルオーバーする（フェイルオーバーは GET・HEAD・OPTIONS だけに効く。[AWS のドキュメント](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)）。POST の API（更新の確認）は、端末の側で予備の経路に切り替える（ADR-0029）。
- **アカウント**：Slack の構成に、ci、release-signing、prod-diagnostics を足し、本番を prod-core と prod-diagnostics に分ける。
  - release-signing には、KMS のリリースの鍵（FIPS 140-3 レベル 3 の HSM の中。[AWS FIPS](https://aws.amazon.com/compliance/fips/)）、Authenticode・GPG の鍵の CloudHSM（コード署名の鍵は FIPS 140-2 レベル 2 以上の機器で保管する要件。[CA/Browser Forum](https://cabforum.org/working-groups/code-signing/requirements/)）、署名専用の実行環境だけを置く。
  - prod-diagnostics には、クラッシュとテレメトリのデータだけを置き、prod-core の運用者の権限から外す。
- **リージョン**：S1・S2 は東京、災害復旧は大阪。S3 で、状態を持たない API（更新の確認、Safe Browsing の照会）を米国・欧州に広げる。
- **災害復旧の目標**：静的な配信は RTO 数分、更新・Safe Browsing の API は RTO 1 時間、同期・アカウントは RPO 15 分・RTO 4 時間（Slack の S1 と同じ）、クラッシュ・テレメトリは失ってよい。
- **帯域**：S2 のうちに CloudFront の帯域の上限の引き上げを申請し、S3 では成果物のディストリビューションを分ける（既定は 1 ディストリビューションあたり 150 Gbps。[CloudFront のクォータ](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)）。
- 2 は単純だが、署名の鍵と診断のデータに、本番の運用者の権限がそのまま届く。API が止まると更新も Safe Browsing も止まる。
- 3 は、段階的な配信・自動の停止・差分・署名の分離（ADR-0029）を自分たちで持てず、OS ごとにばらばらになる。

## Consequences

> 2026-09-27 の注記：EC2 Mac には物理のスマートカードを挿せないので、下の「スマートカードを署名専用の機械に挿す運用」は成り立たない。macOS の署名は [ADR-0034](0034-macos-signing-with-rcodesign-and-cloudhsm.md) で決め直した（Linux の署名専用の実行環境で rcodesign を使い、Developer ID の鍵を CloudHSM に置く。公証は App Store Connect の API キーで行う）。release-signing に EC2 Mac は置かない。下の「CloudHSM と EC2 Mac の固定の費用」は、CloudHSM の固定の費用と読む。E9 の PoC で確かめ終えるまで、macOS の Stable は出さない。

- 良くなること：
  - サービスが止まっても、端末は配信済みのものと静的な配信で動き続ける。
  - 鍵と診断のデータへの経路が、アカウントの境界で絞られる。
- 引き受けるコスト：
  - アカウントが 3 つ増え、IAM・ネットワーク・Terraform の状態ファイルが増える。
  - CloudHSM と EC2 Mac の固定の費用がかかる。
  - 大阪への切り替えの訓練に、署名の工程の切り替えを含める必要がある。
  - macOS の署名の鍵をハードウェアに置く方式（CloudHSM から `codesign` を使えるか）は未検証で、確かめるまではスマートカードを署名専用の機械に挿す運用になる。

## Confirmation

- SCP：release-signing の KMS の鍵の削除の予約・鍵のポリシーの変更・CloudHSM のクラスタの削除を、break-glass 以外に禁止していることを AWS Config で確かめる。
- IAM Access Analyzer：release-signing と prod-diagnostics の資源に、許可したロール以外の経路がないこと。
- 年 1 回、東京を使わずに、大阪で「静的な配信」「更新の確認」「署名の工程」を動かす訓練を行う。
- 緊急の修正のたびに、CloudFront の帯域のピークを記録し、上限の 60% を超えたら上限の引き上げか分割を行う。

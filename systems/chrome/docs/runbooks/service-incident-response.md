# Runbook: クラウドのサービスの障害対応

- Owner: Ops
- 対応するアラート: すべての呼び出し（page）のアラート（SLO の速いバーンレート、Safe Browsing のリストの遅れ など）
- 最終確認日: 2026-09-26

クラウドのサービス（更新の配信、Safe Browsing、アカウント、同期、拡張機能のストア、クラッシュ・テレメトリの受け取り）の障害への共通の進め方。役割・告知・振り返りの進め方は、Slack の [incident-response.md](../../../slack/docs/runbooks/incident-response.md) と同じにし、ここには Chrome に固有のことを書く。ブラウザの版の不具合は [bad-release-rollback.md](bad-release-rollback.md)、脆弱性は [emergency-security-release.md](emergency-security-release.md) に進む。

## 症状

- SLO の速いバーンレートのアラート（[observability.md](../architecture/observability.md) の 4・5 節）
- Safe Browsing のリストが 20 分以上配信されていない（NFR-009）
- 利用者・社内から、同期・ログイン・拡張機能の導入ができないという報告
- 署名の鍵、診断のデータ、同期のデータへの不正な接触の疑い

## 影響

### サービスごとの利用者から見た影響

| サービス | 止まったときに端末で起きること | 重さの目安 |
| --- | --- | --- |
| 更新の確認 | 端末は予備のマニフェストで 100% の版を取れる。段階的な配信と緊急の修正の段階の制御が止まる | 緊急の修正の最中なら SEV1、それ以外は SEV2 |
| 成果物の配信（CDN） | 更新のダウンロードが失敗し、再試行する | SEV2 |
| Safe Browsing のリスト・照会 | 端末は手元のリストで判定を続ける。新しい危険なサイトを検知できない | 30 分を超えたら SEV2（NFR-009） |
| アカウント、同期 | 端末の閲覧は続けられる。新しい端末での同期、変更の反映が止まる | SEV2 |
| 拡張機能のストア | 導入と更新ができない。導入済みの拡張機能は動く | SEV3 |
| クラッシュ・テレメトリの受け取り | 端末が後で再送する。自動の停止の判定が止まる | SEV3。配信の途中なら、配信を凍結する |

### 重さ

Slack の重さの表を使う。加えて、次は範囲にかかわらず SEV1 とする。

- 署名の鍵（release-signing）への不正な接触の疑い
- 同期のデータ、クラッシュのダンプへの不正な接触の疑い
- 不正な版・不正な Safe Browsing のリスト・不正な seed が配信された疑い

## 確認

1. どのアラート・報告から始まったかを記録する。
2. 影響の範囲を見る：どのサービスか、全体か、特定のリージョン・AZ・CDN のエッジか。Grafana の SLO のダッシュボードを使う。
3. 直近の変更を見る：サービスのデプロイ、Terraform の変更、フィールドトライアルの seed の変更、Safe Browsing のリストの生成、配信の段階の変更。
4. 更新の配信なら、配信中の版と、緊急の修正の最中かを確かめる。

## 対処

1. **宣言する。** Slack の手順と同じ。インシデントの連絡の場は、このサービスと別の道具に持つ。
2. **被害を止める。** 順番は次のとおり。
   - 直近のサービスのデプロイを戻す（Slack の deploy-and-rollback の手順に倣う）
   - 直近の seed の変更を戻す（前の serial の seed を出し直す）
   - Safe Browsing のリストの生成が壊れたら、最後に正しかった版を最新として指し直す
   - 配信の途中の版を凍結する（受け取りが止まり、自動の停止が判定できないとき）
3. **署名の鍵・データへの不正な接触の疑い（SEV1）**
   - release-signing の署名のロールを止め、新しい署名を止める。
   - 不正な版の配信が疑われるなら、update-server で全チャンネルの配信を凍結し、予備のマニフェストを最後に確認済みの版に固定する。
   - 鍵の交換の要否を、Dev（テックリード）とセキュリティの担当が判断する。リリースの鍵・CUP の鍵を変えるには、新しい公開鍵を埋め込んだ版の配布が要るので、端末は古い鍵と新しい鍵の両方を持つ（鍵の番号で交換できる。[update-and-release.md](../architecture/update-and-release.md) の 5.1 節）。
   - 証拠（CloudTrail、KMS・CloudHSM の記録）を消さない。
4. **リージョンの障害**：静的な配信は CloudFront のオリジングループで大阪へ自動で移る。API を大阪で動かすかは、Ops の責任者が判断する（[infrastructure.md](../architecture/infrastructure.md) の 5 節。大阪への切り替えの手順 `disaster-recovery.md` は E10 で作る。それまでは Slack の [disaster-recovery.md](../../../slack/docs/runbooks/disaster-recovery.md) に倣う）。
5. **告知する。** 更新・Safe Browsing の障害は、利用者から見えにくい。企業の管理者と、ステータスページへの告知は PM が判断する。
6. **収束を確かめる。** SLI が戻り、15 分たってから解決とする。Safe Browsing は、端末のリストの鮮度（[observability.md](../architecture/observability.md) の 3.1 節）が戻ったことも確かめる。

## エスカレーション

| 状況 | 連絡先 |
| --- | --- |
| SEV1 の宣言 | Ops の責任者、Dev（テックリード）、PM、セキュリティの担当 |
| 署名の鍵の侵害の疑い | 上記に加えて、証明書の発行者（CA）への連絡の要否をセキュリティの担当が判断する。Apple・Microsoft への連絡の要否も同じ |
| 同期のデータ・ダンプの漏洩の疑い | 上記に加えて、法的な通知の要否を判断する責任者 |
| AWS 側の障害 | AWS サポートにケースを開く |
| 1 時間たっても被害を止められない | 重さを 1 段上げる |

## 事後

- Slack の手順と同じく、SEV1・SEV2 は 5 営業日以内に振り返りを行い、再発防止を Intent の Issue として起票する（Maintain 段）。
- 署名・配信の経路に関わるものは、[ADR-0029](../decisions/0029-updater-protocol-and-staged-rollout.md)・[ADR-0033](../decisions/0033-service-infrastructure-and-dr.md) の前提が崩れていないかを Dev と見直す。
- この手順で足りなかったことを、ここに反映する。

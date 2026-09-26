# Runbooks: Chrome

Ops が持つ運用の文書。品質の判定基準とリリースの受け入れ基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みは [observability.md](../architecture/observability.md) にある。**SLO の値とアラートの一覧の正本はこの文書** で、observability.md の 4・5 節はこれを計測・実装する側の記述である。段階的な配信の自動の停止の閾値の正本は [update-and-release.md](../architecture/update-and-release.md) の 4.3 節。

## 1. SLI と SLO

### 1.1 クラウドのサービス

| サービス | SLI | SLO | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- | --- |
| 更新の確認（update-server） | 2 秒以内に 5xx 以外を返した割合（ALB で測る） | 99.95%（NFR-010） | 速いバーンレートで呼び出し。エラーバジェットを使い切ったら、修正以外のサービスのデプロイと、Stable の段階の拡大を止める | |
| 成果物の配信 | CloudFront の成果物の要求のうち 5xx 以外の割合 | 99.95%（NFR-010） | 同上 | |
| Safe Browsing のリスト | リストの要求のうち 5xx 以外の割合。加えて、最新の版の生成から配信まで 10 分以内の割合 | 99.95%（NFR-010） | 生成から 20 分たっても CDN に出ていなければ呼び出し | ○ |
| Safe Browsing の照会 | 1 秒以内に 5xx 以外を返した割合 | 99.95%（NFR-010） | 速いバーンレートで呼び出し | |
| Safe Browsing の判定（端から端） | テスト用の URL をリストに載せてから、合成の端末で判定されるまで | 30 分以内（NFR-009） | 30 分を超えたら呼び出し（SEV2） | ○ |
| 同期 | 同期の要求のうち 5xx 以外の割合 | 99.9%（NFR-010） | 速いバーンレートで呼び出し | |
| 同期の反映 | 反映の遅延が 10 秒以内の割合（合成のアカウント） | 95%（NFR-008） | 15 分続いたらチケット、1 時間で呼び出し | ○ |
| アカウント | ログイン・トークンの更新のうち 5xx 以外の割合 | 99.9% | 速いバーンレートで呼び出し | |
| 拡張機能のストア | 更新の確認とパッケージの取得のうち 5xx 以外の割合 | 99.9% | 同上 | |
| 拡張機能の停止の一覧の反映 | 一覧への追加から、合成の端末で無効になるまで | 30 分以内（ADR-0026） | 30 分を超えたら呼び出し | ○ |
| クラッシュ・テレメトリの受け取り | 受け取りの要求のうち 5xx 以外の割合 | 99.5% | 配信の途中で止まったら、rollout-guard が判定できないので段階を凍結する | |

- SLO の窓は 30 日（Slack と同じ）。バーンレートのアラートは Slack の [observability.md](../../../slack/docs/architecture/observability.md) の 5.2 節のマルチウィンドウの形を使う。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。
- 復旧の目標（[infrastructure.md](../architecture/infrastructure.md) の 5.1 節）：静的な配信（成果物、予備のマニフェスト、Safe Browsing のリスト、seed）は RPO 0・RTO 数分。update-server と Safe Browsing の照会は RTO 1 時間。アカウント・同期・ストアは RPO 15 分・RTO 4 時間。クラッシュ・テレメトリは失ってよく、RTO 1 日。

### 1.2 端末の品質の指標

端末の指標は SLO にせず、段階的な配信の自動の停止と、リリースの受け入れの基準に使う。値は同意した端末から（更新の普及と更新の失敗率は全端末）。

| 指標 | 目標・基準 | 使い方 |
| --- | --- | --- |
| Stable の Browser のクラッシュ率 | 1,000 セッションあたり 0.5 件未満（NFR-005） | 自動の停止（前の版の 1.5 倍かつ 0.5 超）、受け入れ（[quality.md](../quality.md) の 4.3 節） |
| 起動直後のクラッシュ率、Renderer・GPU のクラッシュ率 | 前の版の 2 倍を超えない | 自動の停止 |
| 更新の失敗率 | 5% 以下（版ごと） | 自動の停止、呼び出し |
| 起動の時間 p75 | 1 秒以内（NFR-001）。前の版より 20% 以上遅くならない | 自動の停止 |
| 緊急の修正の普及 | Stable への配信の開始から 48 時間で 90%（NFR-006。OS ごとにも記録）。24 時間で 60% | 24 時間で 60% に届かなければチケット |
| 不正なメッセージによる終了 | 理由のコードごとに、前の版の 3 倍を超えない。新しいコードが出ない | チケット（セキュリティの担当と調べる） |

## 2. リリースとロールバック

流れの正本は [update-and-release.md](../architecture/update-and-release.md)、手順は [bad-release-rollback.md](bad-release-rollback.md) と [emergency-security-release.md](emergency-security-release.md)。

- **チャンネルと周期**：Canary は毎日、Dev は毎週、Beta と Stable は 4 週ごと（ADR-0004）。本家は 2026-09-08 の Chrome 153 から 2 週ごとにしたが、この題材は 4 週のまま進め、S2 の前に見直す（[architecture/README.md](../architecture/README.md) の「決定」）。
- **リリースのブランチ**：`release/M` は `main` のスナップショットで、先に `main` へ入れた修正の cherry-pick だけを入れる。リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md) に対する、配布型のソフトウェアのための例外（[ADR-0031](../decisions/0031-ci-tiers-wpt-and-release-branches.md)）。cherry-pick は release owner が承認する。
- **段階**：Stable の RC を 1% に出し（QA の受け入れの後）、1% → 10% → 50% → 100%。各段は最低 24 時間。50% → 100% は release owner の承認と、PM のリリースノートの確認。S1 の 1% は同意済みのセッション 2 万を待つ。
- **止める**：rollout-guard が 5 分ごとに比べ、条件に当たれば段階を凍結する。再開は人が判断する。止めるのは誰でもよい（止めたら release owner に連絡する）。
- **戻す**：基本は前へ進める（roll forward）。機能は seed で止める。版の取り下げ（pull）は、Dev（テックリード）の承認と、1 つ前のマイルストーンでプロファイルが読めることの確認の後だけ。
- **サービスのデプロイ**：Slack の delivery.md と同じ（dev → staging → prod、prod は Ops の承認）。

### 2.1 時間帯と凍結

| 対象 | 時間帯 | 凍結（止めるもの） |
| --- | --- | --- |
| Stable の新しいマイルストーンの開始（RC の 1%）と段階の拡大 | 平日の火〜木曜 10〜16 時（日本時間）。金曜・休日の前日は段階を上げない | 年末年始（12 月 20 日〜1 月 7 日）、大型連休の期間、夜間の段が 2 日続けて失敗している間、同じチャンネルで別の版が凍結中の間、署名の工程に障害がある間、更新の配信・Safe Browsing の SLO のエラーバジェットを使い切っている間 |
| Beta・Dev | 平日 | 夜間の段の失敗が続く間は Dev を出さない（[build-and-test.md](../architecture/build-and-test.md) の 4.2 節）。Beta は Stable と同じ凍結 |
| Canary | 毎日（自動） | 継続・夜間の段が失敗している間は出さない |
| リリースのブランチへの cherry-pick | 常時（release owner の承認） | ブランチから 3 週目以降は、セキュリティ修正とリリースを止める回帰の修正だけ（[update-and-release.md](../architecture/update-and-release.md) の 2 節） |
| フィールドトライアル（seed）で機能を広げる | 平日 10〜16 時。2 人の承認。Canary → Beta → Stable の順 | Stable の凍結と同じ。**機能を止める変更は凍結の対象外**で、全チャンネルに同時に出してよい |
| サービスのデプロイ（prod-core・prod-diagnostics） | 平日 10〜17 時 | 金曜 15 時以降、年末年始、緊急の修正の最中（T−8h〜T+48h は update-server・署名の経路・CDN の設定を変えない） |
| 緊急のセキュリティ修正 | 時間帯と凍結の制限を受けない | 2 人の承認（セキュリティの担当と release owner）は省かない |

凍結の予定（年末年始、大型連休の日付）は、Ops が四半期ごとにこの表の下に書き足し、PM と合意する。

## 3. 署名の鍵

鍵の置き場所と権限は [update-and-release.md](../architecture/update-and-release.md) の 5 節と [infrastructure.md](../architecture/infrastructure.md) の 1 節。人が鍵を使う経路はなく、緊急時のロールは 2 人の承認で有効になり、使うたびに通知する。

| 鍵 | 置き場所 | 交換 |
| --- | --- | --- |
| CUP の鍵（update-server の応答） | Secrets Manager（prod-core） | 90 日ごと。次の鍵の公開鍵を、1 つ前以前のマイルストーンのアップデータに埋め込んでおき、鍵の番号で切り替える |
| リリースの署名の鍵 | release-signing の KMS（マルチリージョンキー。大阪に複製） | 定期には交換しない。予備の鍵の公開鍵をアップデータに埋め込み、漏洩の疑いで切り替える。切り替えを年 1 回 staging で訓練する |
| フィールドトライアル・Safe Browsing のリストの署名の鍵 | 同上（別の鍵） | 同上 |
| Authenticode の鍵 | release-signing の CloudHSM（大阪へバックアップ） | 証明書の期限の 60 日前に、同じ発行者の名前で更新する。Canary から先に切り替える |
| macOS の Developer ID の鍵 | 未定（E9 の PoC） | 証明書の期限の 60 日前 |
| Linux のリポジトリの GPG の鍵 | release-signing の CloudHSM（PKCS#11。未検証） | 鍵の期限の延長を年 1 回 |

## 4. アラートと手順

「作成済み」以外の手順は、各 Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。できるまでは、表の「それまで」の手順で対応する。アラートの条件は [observability.md](../architecture/observability.md) の 5 節。

| アラート | 手順 | 状態 |
| --- | --- | --- |
| 配信の自動の停止（rollout-guard）、新しい版のクラッシュの急増、更新の失敗率 | [bad-release-rollback.md](bad-release-rollback.md) | 作成済み |
| 緊急の修正の普及の遅れ（24 時間で 60% 未満）、署名の工程の失敗（緊急の修正の最中）、0-day・上流の部品の緊急の修正 | [emergency-security-release.md](emergency-security-release.md) | 作成済み |
| SLO の速いバーンレート、Safe Browsing のリストの遅れ（20 分）、署名の鍵・データへの不正な接触の疑い | [service-incident-response.md](service-incident-response.md) | 作成済み |
| シンボルの欠落（ある版で 5% 超） | `symbolication-gap.md`（それまでは service-incident-response の SEV3） | E9 で作成 |
| 署名の工程の失敗（緊急の修正の外）、証明書の期限の 60 日前、CUP の鍵の交換の時期 | `signing-key-rotation.md`（鍵の交換と、漏洩の疑いのときの切り替え） | E10 で作成 |
| AZ・リージョンの障害、大阪への切り替え | `disaster-recovery.md`（Slack の [disaster-recovery.md](../../../slack/docs/runbooks/disaster-recovery.md) を基に、署名の工程の切り替えを含める） | E10 で作成 |
| 不正なメッセージの理由のコードの急増 | `bad-message-spike.md`（バグか攻撃かの切り分け、セキュリティの担当への引き継ぎ） | E5 で作成 |
| Safe Browsing の誤検知の大規模な発生（主要サイトの掲載） | `safe-browsing-false-positive.md`（緊急の削除と保護の一覧） | E5 で作成 |
| Safe Browsing のフィードの停止・契約の終了、判定の遅れ（30 分） | `safe-browsing-feed-outage.md` | E5 で作成 |
| 悪意のある拡張機能の報告、停止の一覧の反映の遅れ（30 分） | `extension-takedown.md`（停止の一覧への追加と二人目の確認、取り消し） | E7 で作成 |
| 同期の鍵の問題（開けない、版が合わない）の問い合わせ | `sync-key-issues.md`（運用者は鍵を戻せないことを前提に、端末での調べ方） | E8 で作成 |
| 同期の DB の平文の検出、ログインの失敗の急増 | `sync-data-exposure.md`・`auth-anomalies.md`（それまでは service-incident-response の SEV1・SEV2） | E8 で作成 |
| 受け取りのデータの IP・URL・ID の検出 | [service-incident-response.md](service-incident-response.md)（SEV1 として扱う） | 作成済み |
| 部品のリスト（ルートストア、CT のログ、失効のリスト、HSTS、PSL）の配信の遅れ | `component-list-staleness.md`（CT のログの一覧が古くなったときの強制の停止の扱いを含む） | E9 で作成 |

- すべてのアラートは、対応する runbook の URL を持つ（Slack と同じ規則）。

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| 大阪での署名の訓練：大阪の KMS の複製と、大阪に復元した CloudHSM で Canary の 1 版を署名し、合成の端末で 3 つの署名を検証する | 半年ごと | `signing-key-rotation.md`（E10）。それまでは [emergency-security-release.md](emergency-security-release.md) の「署名の工程が使えないとき」 |
| 大阪での全体の訓練：東京を使わずに「静的な配信」「更新の確認」「署名の工程」を動かす | 年 1 回 | `disaster-recovery.md`（E10）、ADR-0033 の Confirmation |
| 鍵の交換：CUP の鍵の交換 | 90 日ごと | `signing-key-rotation.md`（E10） |
| 鍵の交換の訓練：予備のリリースの鍵・seed と Safe Browsing のリストの予備の鍵への切り替え（staging） | 年 1 回 | 同上 |
| コード署名の証明書の更新（Authenticode、Developer ID）、GPG の鍵の期限の延長 | 期限の 60 日前、年 1 回 | 同上 |
| 緊急の修正の訓練（staging。害のない修正で T0 まで 8 時間以内、合成の端末で普及を測る） | 四半期 | [emergency-security-release.md](emergency-security-release.md) |
| rollout-guard の訓練（staging。意図的に悪くした版が凍結される） | 年 1 回 | [bad-release-rollback.md](bad-release-rollback.md)、ADR-0029 の Confirmation |
| 負荷試験（更新の確認の 1 倍・3 倍、緊急の修正の集中、同期の再接続の殺到） | リリース前、四半期 | [capacity.md](../architecture/capacity.md) の 5 節 |
| キャパシティの見直し（同意の割合、差分の大きさを含む） | 月次 | [capacity.md](../architecture/capacity.md) の 5 節 |
| クォータの確認（CloudFront の帯域、KMS の署名、Fargate の vCPU） | 段階を上げる前 | 同上 |
| 緊急の修正の帯域のピークの記録（上限の 60% を超えたら引き上げか分割） | 緊急の修正のたび | ADR-0033 の Confirmation |
| 同期の DB の平文の走査 | 週次 | [quality.md](../quality.md) の 4.4 節 |
| 受け取りのデータの IP・URL・ID の走査 | 週次 | 同上 |
| release-signing と prod-diagnostics のアクセスの見直し（ロールの名簿、break-glass の使用の記録） | 四半期 | ADR-0033 |
| SCP と IAM Access Analyzer の検査 | 常時（AWS Config） | ADR-0033 の Confirmation |
| ルートストアの差分を本家と比べる | 毎日（自動） | ADR-0015 の Confirmation |
| Safe Browsing の検出率の記録 | 四半期 | ADR-0021 の Confirmation |
| クラッシュ率の同意の偏りの確認 | 四半期 | [observability.md](../architecture/observability.md) の 3.1 節 |
| 対応するプラットフォームの見直し | 年 1 回 | [build-and-test.md](../architecture/build-and-test.md) の 6 節 |

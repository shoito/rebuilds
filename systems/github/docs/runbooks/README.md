# Runbooks: GitHub

Ops が持つ運用の文書。品質の判定基準は [quality.md](../quality.md) の 4 節、SLI の計測の仕組みは [observability.md](../architecture/observability.md) の 5 節にある。

## 1. SLI と SLO

| SLI | SLO | 許容範囲を外れたときの扱い | 品質の判定に使う |
| --- | --- | --- | --- |
| Git の操作・Web・API の成功率 | 月間 99.95%（NFR-001） | バーンレートのアラート。エラーバジェットを使い切ったら、修正以外のリリースを止める | |
| push の耐久性：合意した複製が 2 未満で成功を返した件数 | 0 件（NFR-002） | 1 件で page、SEV1 | ○ |
| 複製が 3 つそろっていないリポジトリ（1 つ・2 つ別）、修復の最古の経過時間 | 複製が 1 つのリポジトリは 0、修復の最古は 2 時間以内 | 1 つのものが出たら page。2 時間超で page | ○ |
| 定期の照合でのチェックサムの不一致 | 0 件 | 修復に回し、原因不明なら QA と Dev に共有 | ○ |
| fetch の開始までの時間 p95（1 GB 未満） | 1 秒以内（NFR-003） | 15 分続いたらアラート | |
| push の成功までの時間 p95 | 300 ms 以内（小さな push） | 15 分続いたらアラート | |
| PR の画面の表示 p95（差分 1,000 行まで） | 1.5 秒以内（NFR-004） | 15 分続いたらアラート | |
| 検索への反映 | Issue・PR は 10 秒（p99）、コードは 5 分（p95）（NFR-005） | 5 分・15 分続いたらアラート（`search_index_lag`、`code_index_lag`） | |
| `search_hydration_permission_drop`（検索の読み直しで権限により落ちた件数） | 0 件 | 1 件でバグとして QA に共有。`search_exclusions` が 15 分超で残ればアラート | ○ |
| Webhook の最初の配信までの遅延 p95 | 10 秒以内（NFR-006） | 15 分続いたらアラート | |
| Actions のキューの時間 p95（標準の実行環境） | 60 秒以内（NFR-007） | 15 分続いたらアラート。待機中の VM が 0 で 1 分続いたらアラート | |
| 通知の遅延 p95 | 受信箱 30 秒、メール 5 分以内（NFR-011） | 15 分続いたらアラート | |
| バックアップの遅れ p99 | 10 分以内（NFR-009 の RPO の先行指標） | 12 分超で page | ○ |
| 毎日の復元の確認（無作為の 1,000 リポジトリ） | 不一致 0 件 | 1 件で SEV2、QA と Dev に共有 | ○ |
| 権限の合成監視（権限のないアカウントでの取得） | 失敗 0 件（NFR-010） | 1 件で page、SEV1 | ○ |
| 基盤が原因の Actions のジョブの失敗率 | 0.1% 未満 | 超えたらチケット | |

- SLO の窓は 30 日。バーンレートの計算は Slack と同じ（[observability.md](../architecture/observability.md) の 5.2 節）。
- 復旧の目標：AZ は RPO 0・RTO 5 分（NFR-008）。リージョンは RPO 15 分、RTO は Web・API と直近 7 日に使われたリポジトリが 4 時間、全リポジトリが 24 時間（NFR-009。[ADR-0032](../decisions/0032-disaster-recovery-strategy.md)）。
- 「品質の判定に使う」に○がある指標は、QA が品質の判定基準に使う。定義を変えるときは QA と合意する。

## 2. リポジトリ・持ち主ごとの上限

特定のリポジトリ・利用者が共有の資源を占有しないよう、上限を設ける。**値の正本は [git-protocols.md](../architecture/git-protocols.md) の 8 節、[git-storage.md](../architecture/git-storage.md) の 12 節、[api-and-webhooks.md](../architecture/api-and-webhooks.md) の 11 節、[capacity.md](../architecture/capacity.md) の 4 節にある。** 下の表は運用でよく見るものの抜粋。一時的な変更は、主体・リポジトリ単位の上書きで行い、監査ログに残す。

| 対象 | 上限（S1） | 超えたとき |
| --- | --- | --- |
| 1 リポジトリへの Git の要求 | 200 件/秒。ノードあたり同時の `upload-pack` 16 | 待たせ、続けば 429・503 |
| 1 リポジトリの ref の更新 | 5 件/秒 | 待たせる |
| 1 リポジトリの clone（完全） | 1 分に 600 回。超えたら bundle-uri の対象にする | 待たせ、続けば 429 |
| 1 IP の認証なしの clone・fetch | 1 分に 30 回 | 429 |
| 1 認証の主体の clone | 1 分に 60 回 | 429 |
| push の大きさ・ファイル | 1 回 2 GB、1 ファイル 100 MiB（50 MiB で警告）、ref 5,000 | 拒否 |
| リポジトリの大きさ | 10 GB で警告（`large` への移動を検討） | 拒否しない |
| REST の主の制限 | 匿名 60/時、ユーザー 5,000/時、App のインストール 5,000〜12,500/時、ジョブのトークン 1,000/時 | 429 |
| 副の制限 | 同時 100、REST 900 点/分、GraphQL 2,000 点/分、内容の作成 80/分・500/時 | 429 と `retry-after` |
| 検索（API） | コード 10/分、その他 30/分 | 429 |
| Actions の同時実行（持ち主ごと） | Free 20、Pro 40、Team 60、Enterprise 500 | キューで待つ |
| 通知のメール（受け手ごと） | 1 分 20 通、1 時間 200 通 | まとめて送る |
| Webhook の宛先ごとの同時の配信 | 20 | 待たせる。失敗率 90% 超で回路遮断 |

- 上位のリポジトリ・持ち主の内訳（上位 50 件だけ `repo_id` をラベルにする）で偏りを見る（[observability.md](../architecture/observability.md) の 3.2 節）。
- 1 つのリポジトリがノードの CPU の 20% 以上を使い続けたら、チケットにする（「ホットなリポジトリ」）。

## 3. リリースとロールバック

流れは [delivery.md](../architecture/delivery.md)、手順は [deploy-and-rollback.md](deploy-and-rollback.md)。

- デプロイ（Ops が承認）とリリース（PM が判断）を分ける。新しい振る舞いは release フラグの裏に置き、社内 → 5% → 25% → 100% の順に、持ち主の単位で広げる。Git のプロトコルの振る舞いを変える機能は 5% の段を 1 週間にする。
- **アプリの列車（毎日）とストレージの列車（週 2 回）を分ける。** ストレージのノードは 1 つの AZ の中で 1 台ずつ更新し、AZ をまたいで同時に止めない（ADR-0033）。
- Git の本体の版の更新は、サービスの更新と別の PR・別のデプロイにする。脆弱性の修正は短縮の経路で、公開から 48 時間以内に全台。
- 夜間の CI が 2 日続けて失敗している間は、release フラグを広げず、ストレージの列車も止める。
- 指標が許容範囲を外れたら、フラグを切って戻す。ストレージのパッケージは、各ノードに残した 1 つ前の版へ同じ手順で戻す。
- 本番の変更の時間帯は平日 10〜17 時。ストレージの列車は AZ の途中で夜を越さない。

## 4. アラートと手順

「作成済み」以外の手順は、対応する Epic の実装に合わせて [templates/runbook.md](../../../../docs/templates/runbook.md) から作る。

| アラート | 手順 | 状態 |
| --- | --- | --- |
| SLO の速いバーンレート、合成監視の連続失敗、合意なしの成功、権限の合成監視の失敗 | [incident-response.md](incident-response.md) | 作成済み |
| デプロイ中の自動ロールバック、ストレージの列車の自動停止、デプロイ後の悪化 | [deploy-and-rollback.md](deploy-and-rollback.md) | 作成済み |
| AZ・リージョンの障害、複製が 1 つ以下のリポジトリ、DB の論理的な破損 | [disaster-recovery.md](disaster-recovery.md) | 作成済み |
| 修復の待ちの最古が 2 時間超、複製の不足、ストレージのノードの喪失・退役の予定 | `replica-repair.md`（現在は [incident-response.md](incident-response.md) の該当の節） | E3 の `replica-repair` で作成 |
| 1 つのリポジトリの負荷の偏り、上限への到達 | `hot-repository.md`（現在は [incident-response.md](incident-response.md) の該当の節） | E9 の `hot-repository-detection` で作成（E3 で暫定） |
| バックアップの遅れ p99 が 12 分超、復元の確認の不一致 | `backup-lag.md`（現在は [incident-response.md](incident-response.md) の該当の節） | E3 の `git-backup-osaka` で作成 |
| 削除したリポジトリの復元の依頼、fork のネットワークに属するリポジトリの復元（運用者の作業） | `repository-restore.md`（削除の再適用を含む） | E3 の `repository-delete-and-restore` で作成 |
| SSH のホスト鍵・コミットの署名鍵の漏洩・入れ替え | `host-key-rotation.md` | E1 の `git-frontend-https-ssh` で作成（四半期に staging で演習） |
| マージの失敗が続く、キューが進まない、グループの作り直しの多発 | `merge-queue-stuck.md` | E4 の `merge-queue` で作成 |
| メールのバウンス率 2%・苦情率 0.05% 超、SES の送信の停止 | `email-bounce.md` | E5 の `email-bounce-handling` で作成 |
| `search_index_lag` の p99 10 秒超、`code_index_lag` の p95 5 分超、`search_exclusions` の 15 分超の残り | `index-lag.md` | E6 の `search-exclusions` で作成 |
| トークンの漏洩（1 件・大量・App の秘密鍵）、一斉の失効 | `token-leak.md`（4-eyes の承認を含む） | E7 の `token-leak-revocation` で作成 |
| Webhook の配信の滞留、宛先ごとの失敗の急増、egress の拒否の急増 | `webhook-backlog.md` | E7 の `webhook-retries-and-redelivery` で作成 |
| 副の制限の急増、特定の主体の過剰な利用 | `api-abuse.md` | E7 の `rate-limits` で作成 |
| 待機中の VM が 0、キューの時間の悪化、metal のホストの在庫の不足 | `runner-capacity.md` | E8 の `runner-fleet-manager` で作成 |
| 採掘の検知、持ち主の Actions の一時停止、誤検知の申し立て | `crypto-mining.md` | E8 の `actions-abuse-detection` で作成 |
| OIDC の署名の鍵の入れ替え（90 日）、JWKS の取得の失敗 | `oidc-key-rotation.md` | E8 の `oidc-issuer` で作成 |
| セキュリティインシデント（権限の漏洩、隔離の破れ、依存の脆弱性の緊急の修正）。個人情報保護委員会への報告を含む | `security-incident.md` | E9 の `runbooks-completion` で作成 |
| 削除の処理の遅れ・失敗、リーガルホールド、秘密情報の完全な消去の依頼 | `data-deletion.md`（[git-storage.md](../architecture/git-storage.md) の 11.3 節の消去を含む） | E9 の `data-deletion-jobs` で作成 |

## 5. 定期作業と訓練

| 作業 | 頻度 | 手順 |
| --- | --- | --- |
| バックアップからの復元の確認（無作為の 1,000 リポジトリ、prod の隔離した環境） | 毎日（自動） | [disaster-recovery.md](disaster-recovery.md) の E |
| 3 つの複製のチェックサムの照合 | 毎日（自動） | [git-storage.md](../architecture/git-storage.md) の 6.2 節 |
| `git fsck --connectivity-only` の巡回 | 週 1 回（自動） | 同上 |
| ストレージのノード 1 台の終了と修復 | 月 1 回（staging）、四半期に 1 回（prod、退避済みのノード） | [disaster-recovery.md](disaster-recovery.md) の E |
| AZ の分断 | 四半期（staging） | 同上 |
| 大阪への切り替え | 四半期（staging）、年 1 回（prod のバックアップの 20% を大阪へ復元） | 同上 |
| 削除したリポジトリの復元（削除の再適用を含む） | 四半期 | `repository-restore.md`（E3） |
| SSH のホスト鍵の入れ替えの演習 | 四半期（staging） | `host-key-rotation.md`（E1） |
| Actions の隔離の演習（VM からの脱出、内部への到達） | 四半期、実行環境の変更時 | [security.md](../architecture/security.md) の 11 節 |
| 外部の CI からの緊急のデプロイの経路の確認 | 四半期 | [delivery.md](../architecture/delivery.md) の 6.2 節 |
| キャパシティの見直し（充填率 55% でノードの追加を始める） | 月次 | [capacity.md](../architecture/capacity.md) の 5 節 |
| 負荷試験（モデルの 1 倍・2 倍、clone の集中、ノード・AZ の喪失） | リリース前、四半期 | 同上 |
| 外部のペンテスト | 一般公開の前、以後は年 1 回 | [security.md](../architecture/security.md) の 11 節 |

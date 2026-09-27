# Security: Cloudflare Workers

制御プレーンと運用の側のセキュリティの設計。制御プレーンの脅威モデル、鍵とシークレットの階層、人と機械の権限、監査ログの改ざんの検知、脆弱性の窓口と報奨金、データのライフサイクル、法令の点を決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0002](../decisions/0002-isolation-model.md) | 利用者のコードは共有のプロセスの isolate に、L1〜L5 の層を重ねて閉じ込める |
| [ADR-0018](../decisions/0018-acme-certificates-and-sni.md) | 証明書の鍵は、リージョンのデータ鍵（RDK）で包んで配る |
| [ADR-0023](../decisions/0023-code-and-secret-distribution.md) | シークレットはアカウントの鍵（ADK）で暗号化し、ADK をリージョンの秘密の鍵（RSK）で包んで配る |
| [ADR-0042](../decisions/0042-api-tokens-roles-and-audit-log.md) | 監査ログは変更と同じトランザクションで書き、18 か月持つ |
| [ADR-0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md) | 全ノードへ届く 3 つの権限を別の役割とアカウントに分け、人の本番の権限は期限付き・2 人の承認にする |
| [ADR-0047](../decisions/0047-kms-key-hierarchy.md) | 鍵は KMS の 3 層にし、制御プレーンの鍵だけをマルチリージョンにする |
| [ADR-0048](../decisions/0048-audit-log-integrity-and-data-lifecycle.md) | 監査ログはハッシュの鎖と WORM の写しで改ざんを検知する。削除は 30 日の猶予の後、写しは保持の期間で消える |

**利用者のコードに対する脅威モデル**（isolate、プロセスのサンドボックス、cordon、Spectre、V8 の修正）は [sandbox-and-security.md](sandbox-and-security.md) にある。この文書はそれを前提にし、繰り返さない。API トークンとロールは [dashboard-and-api.md](dashboard-and-api.md)、ログの伏せ方は [developer-tooling.md](developer-tooling.md) の 7.3 節、アカウントとネットワークの分け方は [infrastructure.md](infrastructure.md) にある。不正な内容・用途への対応（通報、停止、新しいアカウントの危険度、捜査機関の照会）は [abuse-and-trust-safety.md](abuse-and-trust-safety.md) にある。

本家・AWS の振る舞いと数値は、2026-09-27 に本家のブログと文書、AWS の文書で確かめた。

## 1. 目的と範囲

- 目的：制御プレーンの侵害・誤操作が、全ノード・全テナントへ一度に広がらないようにする。シークレットの平文が、決めた場所の外に出ない。誰が何をしたかが、消せない形で残る。利用者のデータを、約束した期間の中で消す。

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 制御プレーン・配信・ビルドの脅威モデル | 利用者のコードの脅威モデル（sandbox-and-security） |
| KMS の鍵の階層、入れ替え、DR | 鍵を使う仕組みの実装（deployment-and-config-distribution、edge-network-and-routing） |
| 運用者・エージェント・CI の権限、break-glass | API トークンとロール（dashboard-and-api） |
| 監査ログの改ざんの検知と長期の保存 | 監査ログの記録の中身と画面（dashboard-and-api） |
| 脆弱性の窓口と報奨金 | 外部の侵入試験の範囲（sandbox-and-security の 9.3 節） |
| データのライフサイクル（削除、保持、写し） | 各保存の保持の仕組み（各ストレージの領域） |
| 法令の点の整理（法務の確認待ち） | 不正な内容の削除の手順（abuse-and-trust-safety） |

## 2. 確かめたこと

| 項目 | 事実 | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| 本家の設定の配信の事故 | 2025-11-18 は自動の分類器の設定の更新で約 2 時間 10 分、2025-12-05 はセキュリティの設定の変更で約 25 分、網が広く止まった。どちらも設定の変更が数秒で世界へ広がったため | [Code Orange: Fail Small](https://blog.cloudflare.com/fail-small-resilience-plan/)（2025-12-19） |
| 本家の対策 | 設定もソフトウェアと同じ段階と健全性の判定で配る（Snapstone）。18 の主要なサービスに予備の認可の経路を作り、2026-04-07 に 200 人以上で break-glass の訓練をした | [Code Orange: Fail Small is complete](https://blog.cloudflare.com/code-orange-fail-small-complete/)（2026-05-01） |
| 本家の脆弱性の窓口 | HackerOne の報奨金の制度へ報告を求める | [Cloudflare の disclosure の頁](https://www.cloudflare.com/disclosure/) |
| KMS のマルチリージョンキー | 同じ鍵の素材と ID を複数のリージョンに持ち、あるリージョンで暗号化したものを別のリージョンで復号できる | [Multi-Region keys](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html) |
| S3 Object Lock | コンプライアンスのモードでは、保持の期間の中はルートの利用者を含めて誰も上書き・削除できない。期間を短くできない。期限の前に消す方法はアカウントの削除だけ | [Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html) |
| security.txt | 脆弱性の報告の窓口を `/.well-known/security.txt` で示す形式 | [RFC 9116](https://www.rfc-editor.org/rfc/rfc9116.html) |

## 3. 制御プレーンの脅威モデル

### 3.1 守るもの

| 資産 | どこにあるか | 奪われたときの影響 |
| --- | --- | --- |
| ランタイムと AMI の署名の鍵 | `build-release` の KMS（非対称） | 全ノードで任意のコードを、サンドボックスの外（スーパーバイザーの権限）で動かせる。**最も重い** |
| 設定の変更のログへの書き込み | `cp-prod` の Aurora の `config_outbox`、採番器 | 全ノードのルート・証明書・停止・`egress_policy` を変えられる。外向きの拒否の一覧を空にすれば SSRF の守りが消える |
| ADK を包む鍵（`cp-adk-wrap`） | `cp-prod` の KMS | 全アカウントのシークレットの平文 |
| リージョンの鍵（`edge-secrets-<r>`・`edge-tls-<r>`） | `edge-<r>` の KMS | そのリージョンのノードが開けるもの全部（シークレット、TLS の鍵） |
| ACME のアカウントの鍵、Route 53 の書き込み | `cp-prod`、`shared` | 既定のドメインの任意の証明書の発行、既定のドメインの乗っ取り |
| 利用者のバンドル（S3 のコードのバケット） | 5 リージョンの `storage-<r>` | 内容のハッシュで照合するので、書き換えは起動の失敗になる（改ざんは効かない）。削除は可用性の喪失 |
| テナントのデータ（KV、オブジェクト、DO、ログ） | `storage-<r>`、ClickHouse | 利用者の利用者の個人情報の漏えい |
| 運用者の資格情報 | 人の端末、IAM Identity Center | 上のどれかへの入口 |
| CLI の npm のパッケージ、同梱の workerd | npm、`build-release` | 利用者の開発の機械と CI での任意のコードの実行 |

### 3.2 攻撃者

| 攻撃者 | 入口 | 主な守り |
| --- | --- | --- |
| 外部の攻撃者 | 管理 API・ダッシュボード、ログイン、トークンの漏れ | 認証・MFA・トークンのスコープとシークレットスキャン（dashboard-and-api）、WAF の相当の制限（dashboard-and-api の 4.8 節） |
| 利用者のコードからの侵害 | サンドボックスの脱出の後のノード | sandbox-and-security の L2〜L5。ノードの役割は最小（[infrastructure.md](infrastructure.md) の 5 節） |
| 内部者・奪われた運用者 | 本番の権限、break-glass | 期限付きの権限、2 人の承認、監査ログの WORM（[ADR-0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md)） |
| 供給網 | 上流の workerd・V8・Pingora、npm の依存、ビルドの基盤 | ハッシュの固定、隔離したビルド、署名、ノードでの署名の検証（sandbox-and-security の 8.4 節） |
| 誤った変更（人・エージェント） | 設定の変更、Terraform、ランタイムの配信 | 段階的な配信と健全性の関門（[ADR-0055](../decisions/0055-staged-runtime-rollout-by-cordon-and-region.md)、[ADR-0056](../decisions/0056-platform-config-staging-and-flags.md)） |

### 3.3 攻撃の経路と守り

| # | 経路 | 守り | 残る危険 |
| --- | --- | --- | --- |
| C1 | 管理 API の欠陥で、他のアカウントの資源を変える | RLS、権限の積の判定、性質ベーステスト（dashboard-and-api） | RLS の抜け。CI で全てのテナントの表の RLS を検査 |
| C2 | 制御プレーンのタスクの侵害から `config_outbox` へ任意の書き込み | 書ける役割は API のサービスと採番器だけ。基盤の器は `scope` と 2 人の承認が要り、ノードは型とスキーマで検証する。1 万項目を超える変更は保留（ADR-0022） | 利用者の器（ルート・停止）は速い経路で全体に届く。書き込みの主体の監視と、`change_id` ごとの監査で追う |
| C3 | 制御プレーンのタスクの侵害から ADK の復号 | `cp-adk-wrap` の `Decrypt` は暗号化の文脈 `account_id` 必須。1 分あたりの復号の数を監視し、平常の 10 倍で呼び出し | タスクの資格情報で、文脈を付ければ全アカウントを開ける。**制御プレーンのシークレットのサービスは、侵害されれば全シークレットに届く**ことを受け入れる。サービスを小さく保ち、別のタスクの定義と役割にする |
| C4 | ビルドの侵害から悪い版の署名 | `build-release` を別のアカウントにし、署名は KMS の非対称の鍵（鍵は外に出ない）。ビルドの入力はハッシュで固定。署名の要求には、同じコミットの再ビルドの一致を条件にする（再現性。未検証。sandbox-and-security の 8.4 節） | 再現性が得られない間は、ビルドの基盤の侵害を検知しにくい |
| C5 | 運用者の資格情報の奪取 | 常設の本番の権限なし。期限付き（最長 4 時間）、書き込みは 2 人の承認。操作は `log-archive` に | 2 人が同時に奪われる場合 |
| C6 | ACME のアカウントの鍵の奪取 | CAA の `accounturi` で自分たちのアカウントに限る（ADR-0018）。鍵は `cp-data` で暗号化し、cert-manager の役割だけが開ける | 奪われたら、既定のドメインの証明書を攻撃者が発行できる。鍵の入れ替えと CAA の更新の手順を runbooks に |
| C7 | 設定の配信の経路への割り込み | mTLS（内部の CA）、束の CRC と `db_id`（deployment-and-config-distribution の 11 節） | 内部の CA の侵害。中間の CA を年 1 回替える |
| C8 | npm のパッケージの乗っ取り | 発行は CI の OIDC の信頼できる発行（provenance）だけ。人のトークンで発行しない。workerd のバイナリは SHA-256 を CLI に書いて照合（[ADR-0035](../decisions/0035-cli-and-single-jsonc-config.md)） | 依存の npm の汚染。依存の固定と監査 |
| C9 | 侵害されたノードからの横移動 | ノードの役割は最小。`edge-<r>` と `storage-<r>` の分離。ノードから制御プレーンへの経路は配信の購読と使用量の送信だけ（[infrastructure.md](infrastructure.md) の 3 節） | そのリージョンの RSK・RDK と、そのリージョンのノードが開ける全シークレット（ADR-0023 の前提） |
| C10 | 基盤の設定の誤り（悪意なし） | 基盤の器の段階的な配信と検証（ADR-0056） | 利用者の器の誤り（例：採番器の欠陥）は速い経路で広がる。性質ベーステストと障害の注入で守る |

- **最も重い 3 つの権限**（署名、設定のログ、ADK の復号）は、別のアカウント・別の役割・別の承認にする（[ADR-0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md)）。1 つが奪われても、3 つを同時には得られない。

## 4. 鍵とシークレット

[ADR-0047](../decisions/0047-kms-key-hierarchy.md)。

### 4.1 階層

```
cp-prod（東京が主、大阪に複製：マルチリージョンキー）
 ├─ cp-adk-wrap ──包む──▶ ADK（アカウントごと。Aurora の account_data_keys）
 │                          └─包む──▶ シークレットの値（AES-256-GCM。secret_values）
 └─ cp-data ──────包む──▶ Aurora・制御プレーンの S3・ACME のアカウントの鍵・オブジェクトのアクセスキーの秘密

edge-<r>（リージョンごとの単一の鍵）
 ├─ edge-secrets-<r> ─包む─▶ RSK（毎月）─包む─▶ ADK の写し（設定の写しの account_key）
 └─ edge-tls-<r> ─────包む─▶ RDK（毎月）─包む─▶ 証明書の秘密鍵（certificates.wrapped_keys）

build-release
 └─ release-signing（ECC P-256、SIGN_VERIFY）── ランタイム・AMI・CLI の workerd の署名
```

- ノードが KMS を呼ぶのは起動時の 2 回（RSK と RDK）だけ（ADR-0023、ADR-0018）。KMS が止まっても、動いているノードは続く。
- 平文の置き場所：ADK と値の平文は、シークレットのサービスのメモリ（受付の時）、制御プレーンの包み直しのジョブのメモリ、ノードのスーパーバイザーの一時のメモリ、isolate の中だけ。証明書の鍵の平文は、cert-manager のメモリと入口のプロキシのメモリ（`mlock`、コアダンプなし）だけ。

### 4.2 入れ替え

| 鍵 | 周期 | 手順 |
| --- | --- | --- |
| KMS の鍵（全部） | 年 1 回（KMS の自動の入れ替え） | 自動。古い素材での復号は続く |
| RSK・RDK | 毎月 | 包み直しのジョブが新しい版を作り、全 ADK・全証明書の鍵を包み直して配る。前の版は 2 か月残す |
| ADK | 年 1 回、漏洩の疑いのとき | 新しい版を作り、新しい値はそれで暗号化する。古い値は裏で包み直し、終わったら古い版を捨てる |
| `release-signing` | 年 1 回 | AMI に新旧の公開鍵を入れ、旧で署名した版がフリートからなくなってから旧を外す |
| 内部の CA の中間 | 年 1 回 | 中継・ノードに新旧を信頼させてから替える |
| ACME のアカウントの鍵 | 漏洩の疑いのとき | 新しいアカウントを作り、CAA の `accounturi` を先に足してから切り替える |

### 4.3 アカウントごとの鍵（S2 の検討）

- 利用者が持つ鍵（BYOK）と、アカウントごとの CMK は S1 で持たない（ADR-0047）。どのノードもどのアカウントを開けるので、アカウントごとの CMK は S1 では隔離を強めない。
- `c3-dedicated` の専用のノードでは、S2 でアカウントの単位の RSK を検討する（[deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 15 節の決定と同じ）。

## 5. 人と機械の権限

[ADR-0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md)。

| 主体 | 本番で持つもの | 得る方法 |
| --- | --- | --- |
| Ops・Dev（人） | 読み込み（メトリクス、ログの基盤の側、Terraform の計画） | IAM Identity Center、最長 4 時間 |
| Ops・Dev（人） | 書き込み（`drain`、Aurora の DR、ASG の変更） | 別の人の承認で出す期限付きの権限 |
| セキュリティの担当 | `quarantine` と `security` のアカウント、セキュリティのログ | 同上 |
| サポート | 利用者のログの閲覧 | 利用者の同意と 2 人の承認、24 時間（[developer-tooling.md](developer-tooling.md) の 8.4 節） |
| CI（OIDC） | Terraform の apply、ECS の配信、ランタイムの配信の制御役への登録 | 承認済みの計画とタグだけ |
| エージェント | なし | 本番の経路を与えない。開発の環境と CI の中だけで動く |
| break-glass | `cp-prod`・`edge-<r>` の管理者 | 封をした資格情報。使うと `security` へ即時の知らせ、24 時間以内の振り返り |

- ノードへの対話的なログインは止める。break-glass の SSM Session Manager だけ（記録つき）。
- **侵害が疑われるノード**は、`quarantine` のアカウントへ EBS のスナップショットとメモリの写し（取れる場合）を写してから、そのノードを捨てる（[runbooks/incident-response.md](../runbooks/incident-response.md) の「サンドボックスの脱出の疑い」）。

## 6. 監査ログ

[ADR-0048](../decisions/0048-audit-log-integrity-and-data-lifecycle.md)。**持ち分**：利用者の監査ログ（`audit_events`）の記録の中身・形・画面・API・18 か月の保持は [dashboard-and-api.md](dashboard-and-api.md) の 7 節が持つ。この節は、その改ざんの検知と長期の保存（WORM）、基盤の監査、CloudTrail を持つ。

| ログ | 置き場所 | 保持 | 改ざんの検知 |
| --- | --- | --- | --- |
| 利用者の監査ログ（`audit_events`） | Aurora（正本、RLS）＋ `log-archive` の S3（Object Lock、コンプライアンスのモード） | 18 か月 | アカウントごとのハッシュの鎖、1 時間ごとの署名つきの要約、日次の突き合わせ |
| 基盤の監査（権限の申請と承認、break-glass、`quarantine` の操作、鍵の操作） | `log-archive`（Object Lock） | 3 年（仮。法務の確認待ち） | 同上 |
| AWS の API（CloudTrail の組織の証跡） | `log-archive` | 3 年（仮） | CloudTrail のダイジェストの検証 |
| セキュリティの事象（seccomp の違反、探り、隔離） | `security` のアカウント | 1 年（仮） | — |

- 監査の行の `changes` にシークレットの値・トークンの秘密を入れない（dashboard-and-api の 7.2 節）。
- 利用者のログの閲覧（サポート）と基盤の停止は、利用者の監査ログにも載せる（dashboard-and-api の 7.3 節）。捜査機関の照会の対応で知らせないよう求められた操作の載せ方は、法務の判断に従う（intent の L4）。

## 7. 脆弱性の窓口と報奨金

| 項目 | 決定 |
| --- | --- |
| 窓口 | `https://<brand>.<domain>/.well-known/security.txt`（RFC 9116）に、報告の窓口、暗号化の鍵、方針の URL、期限を置く。既定のサブドメインのドメインと管理のドメインにも同じものを置く |
| 報奨金 | 報奨金の制度の事業者（HackerOne など。E12 で選ぶ）で、GA の 3 か月前に招待制で始め、GA と同時に公開する（sandbox-and-security の 9.3 節） |
| 最高の区分 | サンドボックスの脱出、テナントをまたぐ到達、他のアカウントの資源の操作、シークレットの平文の取得、配信・署名の経路の乗っ取り |
| 研究者のアカウント | 登録した研究者のアカウントは、`c3-dedicated` と同じ形の**専用のノードの群**（研究用）に載せる。脱出の試みが本物のテナントと同じプロセス・ノードに載らないようにする |
| 安全な港 | 方針に従った調査を、利用規約の違反・法的な措置の対象にしない旨を方針に書く（文言は法務の確認待ち） |
| 応答の目標 | 受付の確認 1 営業日、重さの判定 3 営業日。Critical の修正の目標は、V8 の欠陥なら 24 時間（NFR-007）、自前の部品なら 7 日 |
| 公開 | 修正の後、報告者と合意して公開する。利用者に影響があれば、利用者への通知を先にする |

## 8. データのライフサイクル

[ADR-0048](../decisions/0048-audit-log-integrity-and-data-lifecycle.md)。

### 8.1 保存ごとの保持

| データ | 正本の保持 | 写し・保険 | 写しが消えるまで |
| --- | --- | --- | --- |
| 関数の版・バンドル | 直近 100 の版、参照されないバンドルは 30 日 | S3 のバージョニング | 削除の印から 30 日 |
| KV | 利用者が消すまで | DynamoDB の PITR 35 日、S3 の旧い版 7 日、大阪の複製 | 35 日 |
| オブジェクト | 利用者が消すまで | 大阪の CRR | CRR の削除の複製で即時（削除の印の複製の設定による。未検証） |
| Durable Objects | 利用者が消すまで | WAL・スナップショット 30 日、CRR | 30 日 |
| キュー | 保持の期間（最長 14 日） | なし | — |
| 保存するログ | 有料 7 日・無料 3 日 | 再送用の S3 7 日 | 7 日 |
| 呼び出しの集計（`invocation_rollup_1m`） | 90 日（仮） | なし | — |
| シークレット | 利用者が消すまで | Aurora のバックアップ（35 日） | ADK を捨てれば開けない |
| 監査ログ | 18 か月 | WORM 18 か月 | 18 か月 |
| 使用量・請求書 | 法令の保存の期間（法務・経理の確認待ち） | 生の束 13 か月 | — |

### 8.2 アカウントの削除

- 削除の要求 → `deletion_scheduled`（30 日。関数は止まり、戻せる）→ 30 日目に正本を消し、ADK を捨てる → 写しは 8.1 節の期間で消える。利用者への約束は「削除の予約から 65 日以内に写しを含めて消える」。
- 法令の保存の義務があるもの（請求書、監査ログ）は残す。
- 不正な利用で停止したアカウントの証拠の保全（法務の判断）は、削除より優先する（abuse-and-trust-safety）。

## 9. 法令の点（法務の確認待ち）

結論は出さない。設計はどの結論にも合わせられる形にする。

| # | 点 | 設計の側の用意 | intent |
| --- | --- | --- | --- |
| S-L1 | 委託の契約（DPA）の雛形と、サブプロセッサー（AWS、ACME の発行局、報奨金の事業者、決済の代行）の一覧と変更の通知 | サブプロセッサーの一覧を公開の頁で持ち、変更は 30 日前に知らせる | L7 |
| S-L2 | 漏えいのときの個人情報保護委員会への報告と本人への通知（期限と対象） | インシデントの手順に、法務への連絡を SEV1 の最初の 1 時間に入れる（[runbooks/incident-response.md](../runbooks/incident-response.md)） | L7 |
| S-L3 | 電気通信事業法の事故の報告の要否（関数の中継が「他人の通信の媒介」に当たるか） | 同上 | L2 |
| S-L4 | ログ・監査ログ・基盤の監査の保持の期間の上限と下限 | 保持は設定の値にし、8.1 節の表を一か所で変えられる | L7 |
| S-L5 | 運用者による利用者のログの閲覧と通信の秘密 | 閲覧は同意・2 人の承認・監査ログ（developer-tooling の 8.4 節） | L2 |
| S-L6 | 捜査機関の照会の対応と、利用者の監査ログへの載せ方 | 基盤の操作の載せ方を、操作ごとに切り替えられる | L4 |
| S-L7 | 報奨金の制度の安全な港の文言、海外の研究者への支払い | 7 節 | L4 |
| S-L8 | 海外のリージョンのログ・監査の東京への集約（外国にある第三者への提供の論点の逆向き） | ログの経路は [developer-tooling.md](developer-tooling.md) の 8.1 節 | L3・L7 |

## 10. テストと確認

| 種類 | 対象 | 確かめること |
| --- | --- | --- |
| CI の検査 | IAM・KMS のポリシー | `release-signing` の `Sign` の主体が 1 つ。ADK の鍵の `Decrypt` に人がない。リージョンの鍵が他のリージョンの役割を含まない |
| CI の検査 | Terraform | Object Lock の期間の変更が 2 人の承認を持つ。全てのバケットが暗号化・パブリックアクセスの遮断を持つ |
| 性質ベース | 監査の鎖 | 途中の 1 行の変更で、その行から検証が失敗する |
| 結合 | シークレット | 平文がディスク・ログ・コアダンプ・中継・監査の行に出ない（deployment-and-config-distribution の 12 節） |
| 結合 | 削除 | 30 日の後に正本が消え、ADK が捨てられる。予約の中の戻しで全てが戻る |
| 訓練（四半期） | break-glass | 使えること、記録が `log-archive` に残ること |
| 訓練（半期） | DR の鍵 | 大阪の `cp-adk-wrap` の複製だけで、シークレットの受付とデプロイができる |
| 外部 | 侵入試験 | GA の前。制御プレーン（管理 API、ダッシュボード、配信の経路、ビルド）を範囲に入れる |

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md) | 署名・設定のログ・ADK の復号を別の役割とアカウントに分ける。人の本番の権限は期限付き・2 人の承認。エージェントに本番の経路を与えない |
| [0047](../decisions/0047-kms-key-hierarchy.md) | KMS の 3 層（制御プレーンの鍵はマルチリージョン、リージョンの鍵は単一、アカウントの鍵はデータ鍵）と、署名の非対称の鍵。入れ替えの周期 |
| [0048](../decisions/0048-audit-log-integrity-and-data-lifecycle.md) | 監査ログのハッシュの鎖と WORM の写し。削除は 30 日の猶予の後、写しは保持の期間で消え、65 日以内に完全に消える |

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | KMS の鍵（`cp-adk-wrap`・`cp-data` のマルチリージョン、`edge-secrets-<r>`・`edge-tls-<r>`、`release-signing`）と鍵のポリシー（Terraform） |
| E1 | IAM Identity Center の期限付きの権限と、2 人の承認の申請の流れ。break-glass の資格情報の封と訓練 |
| E1 | `log-archive` の Object Lock のバケット、CloudTrail の組織の証跡 |
| E3 | RSK・RDK・ADK の包み直しのジョブと毎月の入れ替え（deployment-and-config-distribution と合わせて） |
| E3 | ランタイムと AMI の署名、ノードでの署名の検証 |
| E5 | 基盤の器の `scope` と 2 人の承認（delivery と合わせて） |
| E12 | 監査の行のハッシュの鎖、WORM への写し、1 時間ごとの署名つきの要約、日次の突き合わせ |
| E12 | アカウントの削除の予約・戻し・30 日目の削除と ADK の廃棄 |
| E12 | security.txt、報奨金の制度（招待制 → 公開）、研究者用のノードの群 |
| E12 | サブプロセッサーの一覧の頁と変更の通知 |
| E12 | 外部の侵入試験（制御プレーンを含む） |

## 13. 未解決の問い

- 署名の前のビルドの再現性を、C++・V8・Bazel で得られるか。得られなければ、ビルドの基盤の侵害をどう検知するか。
- 制御プレーンのシークレットのサービスが侵害されたとき、全アカウントの ADK に届く。サービスをさらに分ける（アカウントの範囲ごとの役割）価値があるか。
- 基盤の監査・CloudTrail の保持の期間（3 年は仮）。
- 研究者用のノードの群の費用（`c7i.12xlarge` を AZ ごとに 1 台で、月に約 6,000 ドル）を、報奨金の制度の開始から持つか。
- DynamoDB の PITR・S3 の旧い版から、特定のアカウントのデータを能動的に消す手段を持つか（持たないなら 65 日の約束のまま）。
- 利用者の BYOK を S2 で持つか。

### 決定

2026-09-27 の既定案。

- 再現性は E3 で確かめる。得られない間は、署名の要求に「2 つの別のビルドの基盤での成果物のハッシュの一致」を課すかを E3 の結果で決める。S1 の GA までは、ビルドの基盤を `build-release` の中の使い捨ての環境にし、ビルドごとに作り直す。
- シークレットのサービスは S1 で 1 つ。ADK の復号の数の監視で補う。
- 保持の期間は、法務の確認まで 8.1 節と 6 節の仮の値で作り、値は設定で変えられるようにする。
- 研究者用のノードの群は、招待制の開始から持つ。脱出の試みを本物のテナントの隣で受けない方を優先する。
- 能動的な削除は持たない。65 日の約束を利用規約に書く（法務の確認待ち）。
- BYOK は S2 の需要を見て決める。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：制御プレーンの侵害が全ノードへ広がる。3 つの権限の分離の CI の検査と、基盤の器の段階的な配信の結合テスト。
- リスク：監査ログの改ざん・欠け。鎖の性質ベーステストと、日次の突き合わせの SLI。
- リスク：削除の約束（65 日）の破れ。削除の結合テストと、写しの保持の設定の検査。
- 本番での検証：ADK の復号の数（平常との比）、break-glass の使用の 0 件、監査の突き合わせの食い違い 0 件。

**runbooks**

- `break-glass`：封をした資格情報の使い方、知らせ、振り返り。
- `kms-key-compromise`：鍵の漏洩の疑い（リージョンの鍵、ADK、`release-signing`、ACME のアカウントの鍵）ごとの入れ替えの手順。
- `audit-chain-mismatch`：監査の鎖と WORM の写しの食い違い。証拠の保全と調べ。
- `vulnerability-report-triage`：報告の受付、重さの判定、研究者との連絡、修正と公開。
- `account-deletion-restore`：削除の予約の中の戻し。
- SLI の追加の依頼（Ops へ）：ADK の復号の数、監査の突き合わせの結果、鍵の入れ替えの完了、break-glass の使用。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `audit_events` に足す列 | `prev_hash`、`row_hash` | 表の持ち主は dashboard-and-api |
| `audit_digests`（`log-archive` の S3） | `account_id`、`hour`、`head_hash`、`row_count`、`signature` | Object Lock。1 時間ごと |
| `platform_audit_events`（`log-archive` の S3） | `occurred_at`、`actor`、`action`（`access.grant`・`breakglass.use`・`quarantine.copy`・`key.rotate`）、`approved_by`、`target`、`reason` | Object Lock。3 年（仮） |
| `access_grants`（制御プレーン） | `id`、`requester`、`approver`、`permission_set`、`scope`、`reason`、`granted_at`、`expires_at` | テナントの表ではない |
| `account_data_keys`（制御プレーン） | [deployment-and-config-distribution.md](deployment-and-config-distribution.md) の 16 節 | 版を持つ |
| `region_keys`（制御プレーン） | 同上 | RSK・RDK |
| `account_deletions`（制御プレーン） | `account_id`、`requested_at`、`requested_by`、`scheduled_purge_at`、`purged_at`、`adk_destroyed_at`、`restored_at` | RLS |
| `vulnerability_reports`（制御プレーン） | `id`、`received_at`、`source`、`severity`、`status`、`affected_component`、`fixed_at`、`disclosed_at` | テナントの表ではない。セキュリティの担当だけ |
| `research_accounts`（制御プレーン） | `account_id`、`program_id`、`enrolled_at` | 研究者用のノードの群への配置に使う（cordon の入力） |

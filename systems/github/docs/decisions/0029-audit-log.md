---
status: accepted
date: 2026-09-26
---

# ADR-0029: 管理の操作は同じトランザクションで監査ログに書き、Git のイベントとアクセスログは別の流れで集め、改ざんできないアーカイブへ送る

## Context

「誰が、いつ、何をしたか」の記録には、性質の違う 3 種類がある。

| 種類 | 例 | 量 |
| --- | --- | --- |
| 管理の操作 | メンバーの追加、権限の変更、リポジトリの削除・公開、ruleset の変更、トークンの発行、Webhook の設定 | 少ない |
| Git のイベント | push、clone、fetch | 多い（S1 のピークで 2,000 件/秒） |
| アクセスの記録 | 認証済みの API・Git の要求ごとの、トークン・操作・リポジトリ | 非常に多い |

本家の仕組みは次のとおり（2026-09-26 に確認）。

- Organization の監査ログは、owner だけが見られ、直近 180 日。JSON・CSV でエクスポートできる（[Reviewing the audit log for your organization](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization)）。
- Enterprise の監査ログも 180 日。Git のイベントは 7 日だけ持つ。各記録は、行為者、影響を受けた利用者、リポジトリ、操作、場所、時刻、SAML・SCIM の ID、任意で送信元の IP を持つ（[About the audit log for your enterprise](https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/about-the-audit-log-for-your-enterprise)）。
- Enterprise は、監査ログと Git のイベントを外部（S3、Azure、Datadog、GCS、Splunk など）へストリームできる。止めても 7 日分は失わない（[Streaming the audit log for your enterprise](https://docs.github.com/en/enterprise-cloud@latest/admin/monitoring-activity-in-your-enterprise/reviewing-audit-logs-for-your-enterprise/streaming-the-audit-log-for-your-enterprise)）。
- 個人のセキュリティログは直近 90 日（[Reviewing your security log](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/reviewing-your-security-log)）。
- 漏洩したトークンを失効の API で失効すると、持ち主の監査ログに残る。

また、トークンの漏洩（[security.md](../architecture/security.md) の 12 節）では、盗まれたトークンが何を読んだかを、プランに関係なく運用者が特定できなければならない。

## Options

1. **3 種類すべてを、操作と同じトランザクションで Aurora に書く**
2. **管理の操作は同じトランザクションで Aurora に書く（Slack の ADR-0018 と同じ）。Git のイベントとアクセスの記録は、ストリームで S3 に集める。どちらも改ざんできないアーカイブへ送る**
3. **3 種類すべてを、アプリのログとしてストリームで集める**

## Decision

2 を採用する。

- 1 は、clone・fetch の量を Aurora に入れることになり、Git の読み取りの経路を DB の障害に巻き込む（[ADR-0005](0005-git-as-source-of-truth.md) の考え方に反する）。
- 3 は、管理の操作が成功したのに記録がない、という状態を防げない。

### 管理の操作

- Web・API の操作と同じトランザクションで `audit_events` に INSERT する。`app` のロールは INSERT と SELECT だけ。UPDATE・DELETE をトリガーでも拒否する。
- 形は Slack の ADR-0018 に倣い、`organization_id`（または `enterprise_id`・`user_id`）、`actor_type`（user / app / token / operator / system）、`actor_id`、`token_id`、`action`（例：`repo.destroy`、`protected_branch.update`）、`repository_id`、`target`、`result`、`ip`、`user_agent`、`request_id`、`metadata`（変更の前後）、`occurred_at` を持つ。
- 本文・秘密情報・トークンの値を入れない。
- どの Organization にも属さない記録（個人の設定、ログイン、運用者の操作）は `platform_audit_events` に同じ形で書く。個人のセキュリティログは、ここから本人の分を見せる。
- 対象の操作の一覧は、本家の監査ログのイベントの分類（`org`、`repo`、`team`、`protected_branch`、`hook`、`integration_installation`、`personal_access_token` など）に揃える。一覧の正本は [identity-and-permissions.md](../architecture/identity-and-permissions.md) と [api-and-webhooks.md](../architecture/api-and-webhooks.md) に置く。

### push のイベント

- push は、ストレージの側で ref の更新が合意された後に outbox に書かれる Event（ADR-0005）から、Worker が `audit_events` の `git.push` として書く。push の成功と記録が同じ Event から作られるので、欠落しない。

### clone・fetch のイベントとアクセスの記録

- Git フロントエンドと API は、認証済みの要求ごとに構造化した記録（トークンの ID、利用者、操作、リポジトリの ID、IP、時刻、転送量）を出す。Kinesis Data Firehose で S3（Parquet、時間と Organization で分割）に集め、Athena で引く。
- 記録の送信の失敗で、要求を失敗させない。取りこぼしの率を監視し、0.01% を超えたらアラートにする。
- Organization・Enterprise の利用者に見せる Git のイベント（`git.clone`、`git.fetch`）は、本家と同じく Enterprise だけ、7 日分を出す。
- 運用者のための内部のアクセスログは、プランに関係なく全員の分を 90 日持つ。トークンの漏洩の影響の特定に使う（security.md の 12 節）。

### 保持

| 場所 | 期間 | 見られる人 |
| --- | --- | --- |
| `audit_events`（Organization・Enterprise） | 180 日（本家と同じ） | Organization の owner、Enterprise の管理者 |
| `platform_audit_events` の本人の分（セキュリティログ） | 90 日（本家と同じ） | 本人 |
| Git のイベント（利用者に見せる分） | 7 日（本家と同じ） | Enterprise の管理者 |
| 内部のアクセスログ | 90 日 | 運用者（break-glass の手順の下） |
| 監査ログのアーカイブ（S3、Object Lock のコンプライアンスモード） | 400 日 | 運用者 |

- アーカイブは、Slack の ADR-0018 と同じく、別の AWS アカウント（log-archive）に置き、Organization ごとのハッシュの連鎖と、1 時間ごとのダイジェストの KMS の署名で改ざんを検知する。
- 400 日は、SOC 2 の Type II の観察期間（12 か月）を覆うため。

### 見せ方

- Web の画面、REST と GraphQL の API、JSON・CSV のエクスポート（エクスポートの操作自体も記録する）。
- Enterprise には、S3 へのストリーム（OIDC で顧客の AWS に書く）を S2 で提供する。他の宛先は需要を見て足す。

## Consequences

- 良くなること：
  - 管理の操作と push は、成功すれば必ず記録がある。
  - Git の読み取りの経路が、記録のために DB に依存しない。
  - トークンの漏洩時に、プランに関係なく影響の範囲を特定できる。
  - 保持の期間と見せ方が本家と揃い、移行してくる利用者に説明しやすい。
- 引き受けるコスト：
  - clone・fetch の記録は「最善の努力」で、ごく一部の欠落を許す。
  - 記録の流れが 2 つになり、Firehose・Athena・アーカイブのアカウントを持つ。
  - 内部のアクセスログは IP を含む個人データで、90 日の保持をプライバシーの説明に含める。

## Confirmation

- 表駆動テスト：対象の管理の操作ごとに、成功したら `audit_events` に 1 件、失敗・ロールバックしたら 0 件。
- 性質ベーステスト：任意の push の列の後、Worker が追いついたら、成功した push の数と `git.push` の記録の数が一致する。
- `app` のロールで `audit_events` を UPDATE・DELETE できないことを確かめる。
- アクセスログの取りこぼしの率をダッシュボードで監視する。
- ハッシュの連鎖と署名の検証を毎日実行し、失敗はセキュリティインシデントとして扱う。
- 監査ログの `metadata` に、秘密情報・トークンの値が入っていないことを、テストのデータで検査する。

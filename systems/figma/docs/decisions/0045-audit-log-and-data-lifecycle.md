---
status: accepted
date: 2026-09-27
---

# ADR-0045: 監査ログは操作と同じトランザクションで書いて改ざんできない保管へ送り、組織の管理者に見せる。削除は東京と大阪の両方で、バックアップの期限を最終の期限にする

## Context

- 権限の変更、共有、完全な削除、サポートの操作、プラグインの実行など、後から「誰が、いつ、何をしたか」を示す必要がある（[permissions-and-sharing.md](../architecture/permissions-and-sharing.md)、[file-storage-and-history.md](../architecture/file-storage-and-history.md) の 11・13 節、[plugins.md](../architecture/plugins.md) の 8 節）。
- 本家は、Organization と Enterprise のプランで、組織の管理者が活動のログ（操作の種類、人の名前とメール、日時、IP など）を見て書き出せる。プランを上げる前の操作はさかのぼって記録しない（[View and export activity logs](https://help.figma.com/hc/en-us/articles/360040449533-View-and-export-activity-logs)。検索の結果の要約で確認、2026-09-27）。保持の期間は公開のヘルプで見つけられなかった（**未検証**）。
- 削除したファイルの中身は、ジャーナル、S3（古い版を含む）、大阪の複製、バックアップに残りうる。S3 のレプリケーションは、版を指定した削除を複製先に伝えない。ライフサイクルの動作も複製しない（[What does Amazon S3 replicate?](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-what-is-isnot-replicated.html)、2026-09-27 に確認）。file-storage-and-history.md の 11.2 節は「大阪の複製は削除が伝わる」と書いており、S3 については成り立たない。
- 保持と削除の期間は、法務の確認待ち（[intent.md](../intent.md) の L4・L5）。

rebuilds の Slack は、監査ログを操作と同じトランザクションで DB に書き、改ざんできないアーカイブへ送る（[Slack の ADR-0018](../../../slack/docs/decisions/0018-audit-log.md)）。削除は論理削除から非同期の物理削除へ流し、バックアップの期限を削除の最終的な期限にする（[Slack の ADR-0019](../../../slack/docs/decisions/0019-data-retention-and-deletion.md)）。

## Options

監査ログ：

1. **Slack の ADR-0018 を引き継ぐ。組織の管理者が見られる**
2. **アプリのログ（CloudWatch Logs）から集める**

削除：

- a. **削除のジョブが東京と大阪の両方で消す。バックアップ（最大 35 日）を最終の期限にする**
- b. **東京で消し、大阪はライフサイクルに任せる**

## Decision

1 と a を採用する。詳細は [security.md](../architecture/security.md) の 6・7 節。

- **監査ログ**：`audit_events`（`org_id`、FORCE RLS）に、操作と同じトランザクションで書く。outbox で log-archive のアカウントの S3（Object Lock のコンプライアンスモード）へ送る。
  - 中身（ファイルの名前、ノードの名前、コメントの本文）は書かない。ID と、操作の種類と、変更前後の水準・範囲だけを書く。ファイルの名前は、見る時点で権限を確かめてから引く。
  - Aurora に置くのは 1 年。アーカイブは 7 年を既定案とし、期間は法務の確認待ち（L4）。
  - 組織の管理者は、組織のプラン（MVP の後）で、組織の監査ログを画面と CSV で見る。本家と同じく、プランを上げる前の操作は見せない（記録はしているが、見せる範囲は PM が決める）。
  - 運用者（Ops・サポート）の操作は、組織の監査ログとは別に、`global.operator_audit_events` にも書く。
- **Document Server の中の操作**（ファイルの中身の変更）は、監査ログに書かない。ジャーナルの `session_opens` と版の履歴が、誰がいつ編集したかを示す。組織の監査ログには、ファイルを開いた（接続の確立）ことだけを、1 時間に 1 回に間引いて書く。
- **削除**：
  - 完全な削除のジョブ（file-storage-and-history.md の 11.2 節）は、S3 の版を指定した削除を、東京と大阪の両方のバケットで行う。DynamoDB はグローバルテーブルが削除を伝えるので、東京だけで消す。
  - 掃除（同 5.4 節）と、S3 のライフサイクルの規則も、両方のバケットに同じものを置く。
  - バックアップ（DynamoDB の PITR 35 日、Aurora の自動バックアップ 35 日、S3 の古い版 30 日）からは消さない。期限で消えるのを待つ。完全な削除から最大 35 日は残ることを、利用規約とデータ処理の契約に書く（文言は法務の確認待ち、L4）。
  - アカウントの削除、組織の解約の流れと期間は、security.md の 7 節に表で持つ。
- 2 を採らない理由：ログの取りこぼし（非同期の送信の失敗）で、監査の抜けが生まれる。
- b を採らない理由：大阪に、消したはずのファイルの中身が残り続ける。

## Consequences

- 良くなること：
  - 監査の記録が、操作と一緒にしか書かれない（抜けと二重がない）。
  - 大阪にも削除が及び、消した中身が残る期間を 35 日で説明できる。
- 引き受けるコスト：
  - 削除のジョブが 2 つのリージョンを触る。大阪が止まっているときは、大阪の分を後から流す（ジョブの手順を分ける）。
  - `audit_events` の書き込みが、権限の変更のトランザクションに加わる。

## Confirmation

- 結合テスト：共有の変更・完全な削除・プラグインの実行で、`audit_events` の行ができ、失敗したトランザクションでは行ができない。
- 結合テスト：完全な削除のジョブの後、東京と大阪の両方のバケットに `files/{file_id}/` の版が 1 つも残らない。
- lint：`audit_events` の `details` に、名前・本文の列を入れるコードを検出する。

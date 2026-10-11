---
status: proposed
date: 2026-10-10
---

# ADR-0037: 他のホスティングからのリポジトリと Issue の取り込み

## Context

利用者が乗り換えるとき、Git の履歴は `git push --mirror` で持ち込める。持ち込めないのは、Issue・Pull Request・レビュー・ラベル・マイルストーンなどのメタデータである。取り込みは intent の MVP にも Non-goals にもなく、設計もない。

本家は、URL を指定して他のホスティングから Git のリポジトリを取り込む機能と、Issue・PR などのメタデータを含めて移す移行の道具（組織向け）を持つ（[Importing a repository with GitHub Importer](https://docs.github.com/en/migrations/importing-source-code/using-github-importer/importing-a-repository-with-github-importer)、[About GitHub Enterprise Importer](https://docs.github.com/en/migrations/using-github-enterprise-importer/understanding-github-enterprise-importer/about-github-enterprise-importer)。対応する移行元と範囲の細部は着手時に確かめる）。

取り込みは、既存の決定と次の点でぶつかる。

- **外向きの取得**：URL からの取り込みは、利用者が指定した先へ取りに行く。SSRF の踏み台になりうる（Webhook の送信と同じ問題。[ADR-0022](0022-webhook-signing-and-delivery.md)）。
- **番号**：Issue と PR は 1 つの番号の列を共有し、番号は再利用しない（[ADR-0017](0017-shared-issue-numbering.md)）。元の番号を保てないと、本文・コミットのメッセージの `#123` の参照が別のものを指す。
- **副作用**：Issue・PR・push の作成は、通知（[ADR-0016](0016-notification-fanout.md)）、Webhook、Actions のワークフローを起こす。取り込みで大量に起きると、利用者と外部を巻き込む。
- **作者**：移行元の利用者は、このシステムのアカウントを持たないことが多い。

## Options

1. **Git だけを取り込む**（URL からの取り込み）。Issue・PR は取り込まない
2. **1 に加えて、Issue・PR・コメント・ラベル・マイルストーンを、決めた 1 つの形式の移行のアーカイブから取り込む。MVP の後に提供する**
3. 何も提供しない。`git push --mirror` の案内だけにする（Non-goal にする）

範囲と時期は PM が決める（[intent.md](../intent.md) の未解決の問い）。推奨は 2。

## Decision

**推奨案は 2**（PM の判断待ち）。1 か 2 を採る場合の方式は次のとおりとする。

- **Git の取り込み**：
  - 取得は、VPC に接続しない隔離した取得器で行う（ADR-0022 の egress と同じ方式。名前解決後の IP の検査、リダイレクトを追わない、サイズと時間の上限）。取得した pack は、push と同じ検査（`fsck`、サイズの上限、秘密情報の走査の対象）を通して、空のリポジトリに書く。
  - 移行元の認証情報（トークン）は、取り込みの間だけ暗号化して持ち、終わったら消す。ログに出さない。
- **メタデータの取り込み（2 だけ）**：
  - **空のリポジトリにだけ取り込む。** 元の番号のまま `issues` に書き、終わったら `next_issue_number` を最大の番号の次に進める。欠番は欠番のまま残す。既存の Issue があるリポジトリへの取り込みは提供しない（ADR-0017 の「再利用しない」を守るため）。
  - **副作用を起こさない。** 取り込みの Worker は outbox に通知・Webhook の Event を積まない。push の Event も Actions のワークフローを起こさない（取り込みの間、リポジトリの Actions を無効にしておく）。検索の索引は、終わってからまとめて作る。
  - **作者**：移行元の作者を、確認済みのメールアドレスが一致するアカウントか、取り込む人が指定し相手のアカウントが承認した対応で、このシステムのアカウントに対応づける。相手の名前で書くことになるので、相手の承認のない対応づけはしない。対応しない作者は ghost（[data-model.md](../architecture/data-model.md) の 2.4 節）に付け、本文の先頭に元の作者の名前を表示用の注記として残す。
  - **PR**：head・base のブランチが残っていれば PR として作る。残っていなければ、閉じた PR として、差分を持たない記録にする。レビューのコメントは、行の位置が合うものだけを行に付け、合わないものは会話のコメントにする。
  - 時刻は元の時刻を保つ。タイムラインに「取り込み」の印を出す。
- **実行と記録**：リポジトリの admin だけが実行できる。依頼・完了・失敗・件数を、持ち主の監査ログに残す（[ADR-0029](0029-audit-log.md)）。
- 3 は、メタデータを持つ利用者が乗り換えられない。1 は、Issue の履歴という共同作業の記録を捨てさせる。

## Consequences

- 良くなること：
  - 乗り換えた利用者が、番号と参照を保ったまま Issue・PR の履歴を持ち込める。
  - 取り込みが通知・Webhook・Actions を起こさない。
- 引き受けるコスト：
  - 既存のリポジトリへのメタデータの追加はできない。
  - 移行のアーカイブの形式を 1 つに決め、その形式の変化に追従する。
  - 移行元の他人の発言と個人情報を預かる。扱いは法務の確認待ち（intent の未解決の問い）。

## Confirmation

- 結合テスト：取り込みの間に、通知の受信箱・Webhook の配信・Actions のジョブが 1 件も作られない。
- 性質ベーステスト：任意の番号の集合を取り込んだ後、新しく作る Issue の番号が、取り込んだどの番号とも重ならない。
- 結合テスト：取得器が、内部のアドレス・メタデータのエンドポイントへの URL と、それへのリダイレクトを拒否する。
- 結合テスト：取り込んだ非公開のリポジトリの Issue が、権限のない利用者の検索・API・通知に出ない（経路ごとの漏洩テストに加える）。

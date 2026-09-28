---
status: accepted
date: 2026-09-28
---

# ADR-0038: GitHub は GitHub App、GitLab は顧客のトークンと署名付きの Webhook で受け、PR ごとの順で照合する。結び付けはブランチ名・タイトル・本文の語で決め、状態は前へだけ、複数の PR はそろってから進める。非公開のチームのイシューは、結び付いた利用者が書ける時だけ動かす

## Context

intent の MVP は、GitHub・GitLab の PR（MR）とイシューを、ブランチ名・タイトル・本文の「閉じる語」で結び、PR の状態でイシューの状態を進めることを求める。本家の形は次のとおり（いずれも 2026-09-28 に確認）。

- GitHub は GitHub App を組織に入れ、リポジトリを選ぶ。結び付けはブランチ名・タイトルの ID、本文の閉じる語と ID。閉じない語、`skip`・`ignore` がある。既定は PR の作成で In Progress、マージで Done。複数の PR は最後の PR が条件に届いてから進める（[GitHub](https://linear.app/docs/github)）。
- GitLab は個人のアクセストークンと、GitLab に登録する Webhook の URL（[GitLab](https://linear.app/docs/gitlab)）。
- GitHub は Webhook を自動で再送しない。10 秒以内に応答が要る（[Best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks)）。

決めることは、受け方、結び付けの規則、自動化の規則、書き込みの主体である。特に、GitHub の組織の誰でも PR のタイトルに識別子を書けるので、非公開のチームのイシューを、チームのメンバーでない人が動かせてしまう（[ADR-0004](0004-tenancy-and-permissions.md) の分離）。

## Options

受け方（GitHub）：

1. **GitHub App（組織に入れる。インストールのトークンは 1 時間）**
2. OAuth のアプリと、管理者の利用者のトークン

結び付けの源：

- a. **ブランチ名・タイトル（閉じる扱い）と、本文の閉じる語・閉じない語。語のない本文の識別子は結ばない**
- b. どこにあっても識別子を結ぶ

非公開のチームのイシューの自動化：

- x. **PR の作者が結び付いた利用者で、そのイシューを書ける時だけ動かす。それ以外は結び付けの行だけを書く**
- y. `system` として常に動かす
- z. 非公開のチームのイシューは結ばない

## Decision

1・a・x を採用する。詳細は [integrations.md](../architecture/integrations.md) の 3・4 節。

- 受け口は署名（`X-Hub-Signature-256`、GitLab は `webhook-signature` か `X-Gitlab-Token`）を定数時間で確かめ、`integration_events` に配送の ID で一意に保存し、PR ごとのメッセージグループの SQS FIFO に入れて、すぐに 2XX を返す。外部の API は呼ばない。
- 結び付けは事象のたびに全部の源から作り直す（DT-INT-001）。識別子はワークスペースの `resolve`（別名を含む）で引き、引けないものは捨てる。1 つの PR で 50 イシューまで。
- `GitLink` モデルはイシューの同期グループ（`via`）に入る。
- 状態の自動化はチームの設定（`git_on_draft`・`git_on_open`・`git_on_review`・`git_on_merge`）で、閉じる PR の集合から行き先を決める（DT-INT-002）。前へだけ進め、`canceled`・`duplicate`・ゴミ箱は動かさない。マージの行き先は、閉じる PR が全部終わってから。
- 書き込みは Writer を通す（`origin = worker`、履歴に `{k: "auto", rule: "git"}`）。主体は DT-INT-003：公開のチームは結び付いた利用者か `system`、非公開のチームは結び付いた利用者が `can(user, "update", issue)` の時だけ動かす。
- PR への返しのコメントは識別子と URL だけ。
- 取りこぼしは、失敗した配送の再送と、開いた PR の 1 時間ごとの読み直しで埋める。
- 2 を採らない理由：管理者の利用者が抜けるとトークンが使えなくなる。リポジトリを選べない。
- b を採らない理由：本文の中の参照（「ENG-12 と似ている」）まで結び、誤ってイシューを Done にする。
- y を採らない理由：非公開のチームのメンバーでない人が、PR のタイトルだけでチームのイシューの状態を動かせる。
- z を採らない理由：非公開のチームのメンバーも PR の結び付けを使えなくなる。

## Consequences

- 良くなること：
  - GitHub の再送がなくても、保存と読み直しで取りこぼしを埋められる。
  - PR の事象の順が乱れても、PR ごとの FIFO と作り直しで同じ結果になる。
  - 非公開のチームのイシューが外から動かない。
- 引き受けるコスト：
  - 非公開のチームでは、作者がアカウントを結ばないと自動化が効かない。画面で案内する。
  - 本家と違い、語のない本文の識別子を結ばない（本家の振る舞いは**未検証**）。
  - 開いた PR の読み直しが、GitHub の 1 時間の上限の一部を使う。

## Confirmation

- 表駆動テスト：DT-INT-001〜003 の全行。
- 性質ベーステスト：PROP-INT-001（順序によらない）、PROP-INT-002（非公開を動かさない）、PROP-INT-004（前へだけ）。
- 本番：PR の読み直しで見つかった取りこぼしの数、署名の失敗の数。

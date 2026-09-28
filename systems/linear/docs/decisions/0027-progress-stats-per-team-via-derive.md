---
status: accepted
date: 2026-09-28
---

# ADR-0027: 進捗は `(対象, チーム)` ごとの `ProgressStat` の行に `counter` で持ち、イシューの変更の `derive` が増減を出す。行はチームの同期グループに属す。イニシアチブの進捗は保存せず画面で足し、1 日 1 回 SQL で数え直す

## Context

サイクル・プロジェクト・マイルストーン・イニシアチブは、進捗（範囲、進行中、完了）を示す。本家は次のように数える（いずれも 2026-09-28 に確認）。

- 完了を 1、Started を 25% と数える（[Cycle graph](https://linear.app/docs/cycle-graph)）。
- 取り消し・外したものは範囲から外す。見積もりが無効なチームは全部を 1 点と数える（[Project graph](https://linear.app/docs/project-graph)）。
- 非公開のチームとプロジェクトのつながりは、そのチームのメンバーにだけ見える（[Private teams](https://linear.app/docs/private-teams)）。

この題材では、次の制約がある。

- 大きなワークスペースは部分のブートストラップで、古い完了のイシューが手元にない（[ADR-0003](0003-bootstrap-and-partial-sync.md)）。手元のイシューを数えるだけでは、プロジェクトの進捗が合わない。
- 非公開のチームのイシューの数や点は、メンバーでない人に届けてはならない（[ADR-0004](0004-tenancy-and-permissions.md)）。複数のチームのプロジェクトの合計を 1 行にすると、非公開のチームの仕事の量が漏れる。
- 画面は、状態を変えた直後に進捗を変えたい（NFR-001）。

## Options

1. **`(対象, チーム)` ごとの行に合計を `counter` で持つ。`derive` が増減を出し、Writer が同じトランザクションで当てる**
2. 対象ごとに 1 行の合計を、Worker が非同期に計算し直す
3. 保存せず、読むときにサーバーで数える（API・ビューの問い合わせ）
4. 保存せず、クライアントが手元のイシューを数える

## Decision

1 を採用する。詳細は [cycles-and-projects.md](../architecture/cycles-and-projects.md) の 7 節。

- `ProgressStat` は `target_kind`（`cycle`・`project`・`milestone`）・`target_id`・`team_id` と、点と件数の `scope`・`started`・`completed` を持つ。グループは `team:<team_id>`。
- 行は対象を作る同じトランザクションで Writer が作る。派生は `incr` だけを出す。利用者の `incr` は `derive_only` の印で拒否する。
- `Issue` の `derive` に `progressDelta` を登録し、前の行の欄から `−w`、後の行の欄へ `+w` を出す。`w` はチームの見積もりの設定で決める。
- 割合は `(completed + started / 4) / scope`。取り消し・重複・ゴミ箱は範囲に入れない。
- チームの見積もりの設定の変更は、Worker がそのチームを数え直す。1 日 1 回、全体を SQL で数え直し、差を `incr` で当てる。
- 日ごとの点（`ProgressPoint`、遅延）を Worker が書き、図と予測は画面が描く。
- イニシアチブの進捗は保存しない。画面と公開 API が、見てよいプロジェクトの `ProgressStat` の行を足す。人によって値が違うのは仕様とする。
- 2 を採らない理由：状態を変えても進捗の表示が Worker の遅れの分だけ遅れる。1 行の合計は非公開のチームの量を漏らす。
- 3 を採らない理由：オフラインで表示できない。一覧に多くのプロジェクトを並べると、問い合わせが重い。
- 4 を採らない理由：部分のブートストラップで手元にない完了のイシューを数えられない。

## Consequences

- 良くなること：
  - 手元に全部のイシューがなくても、進捗が正しい。オフラインでも表示できる。
  - 状態の変更と同じトランザクションで進捗が変わり、画面は予測で即座に変わる。
  - 非公開のチームの量が、メンバーでない人に届かない。
- 引き受けるコスト：
  - イシューの変更 1 件で、最大 36 の `incr` の派生が増え、`sync_actions` と Writer のロックの時間が増える。E5・E7 で測る。
  - 派生の誤りは合計のずれになる。1 日 1 回の数え直しで直し、ずれの件数を監視する。
  - `teams` 規則を結び付けのモデルから読む形と、`derive_only` の印を、定義の言語に足す必要がある（[ADR-0019](0019-schema-definition-and-codegen.md) の拡張）。

## Confirmation

- 性質ベーステスト（[ADR-0010](0010-deterministic-sync-simulator.md)）：PROP-PROG-001（数え直しと一致）、PROP-PROG-002（見える分の和）、PROP-PROG-003（予測と確定の一致）。
- 差分テスト：数え直しの SQL と `progressDelta` の和が、任意のデータで一致する。
- 本番：`progress_reconcile_drift` が 0。

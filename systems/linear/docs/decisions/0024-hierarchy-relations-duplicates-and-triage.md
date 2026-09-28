---
status: accepted
date: 2026-09-28
---

# ADR-0024: 親子は `parent_id` の LWW と循環の拒否。関連は向きを正規化した行で両方のグループに属する。重複は `duplicate` の関連の作成で表し、元の 1 件へつなぎ直す。Triage への振り分けは Writer が作成の時に決める

## Context

イシューは、親子（サブイシュー）、関連（塞ぐ・塞がれる・関係する）、重複でつながる。本家の公式の文書は次のように書いている（いずれも 2026-09-28 に確認）。

- 関連は Related・Blocked by・Blocks・Duplicate。重複は、いま見ているイシューを別のイシューの重複にする向きだけで、予約の Duplicate の状態になる（[Issue relations](https://linear.app/docs/issue-relations)）。
- Triage の文書は、Triage で重複にすると元へ添付を移し、状態を Canceled にすると書く（[Triage](https://linear.app/docs/triage)）。関連の文書と食い違う。
- サブイシューは親のチーム・優先度・プロジェクトを受け継ぐ。深さの上限は書かれていない（[Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues)）。
- 連携やチームのメンバーでない人が作ったイシューは Triage に入る（[Triage](https://linear.app/docs/triage)）。

この題材では、非公開のチームのデータを見てよくない人へ送らない（[ADR-0004](0004-tenancy-and-permissions.md)）。関連は 2 つのチームをまたぎうる。変更はオフラインで作られ、後から確定の順で当たる（[ADR-0002](0002-sync-model.md)）。

## Options

関連の持ち方：

1. **関連ごとに 1 つの行（`IssueRelation`）。向きを正規化し、両方のイシューのグループに入れ、ID だけを持つ**
2. イシューの `set` のフィールド（`blocks_ids`・`related_ids`）で持つ

重複：

- a. **`duplicate` の関連の作成で表し、状態の変更は派生にする**
- b. 状態を Duplicate にする `set` と、関連の作成を、クライアントが同じトランザクションで送る

Triage：

- x. **作成の時に Writer が決定表で状態を決める（クライアントの値を替えうる）**
- y. クライアントが決め、Writer は確かめるだけ

## Decision

1・a・x を採用する。詳細は [issues-and-workflow.md](../architecture/issues-and-workflow.md) の 7〜10 節。

- **親子**：`parent_id` は LWW。Writer は循環（`cycle`）と深さ 10 の超過を拒否する。1 つの親の子は 1,000 件まで。子は別のチームでもよい。受け継ぎは画面の既定で、Writer の規則にしない。
- **関連**：`blocks` は「塞ぐ側を `issue_id`」、`related` は ID の小さい方を `issue_id` にする。正規化は共有のコードで、Writer が同じ関数で確かめる。同じ組と種類の行があれば `already_exists`（クライアントは示さずに消す）。行は作るか消すかだけ。グループは両方のイシューのグループの和（`via` の 2 つの参照）。
- **重複**：`create IssueRelation {type: duplicate}` だけを送る。派生で、状態を Duplicate にし、前の状態を `prev_state_id` に残し、購読者を元へ足す。元が重複なら元の元へつなぎ直し（`server_ops`）、この重複を元にしていた関連もつなぎ直す。循環は `cycle`。解除（関連の `delete`）で前の状態へ戻す。Triage の文書の Canceled は採らず、Duplicate に統一する。添付とコメントは移さない。
- **Triage**：`create Issue` の時、Writer が DT-ISSUE-002（`triage_enabled`・`origin`・作った人がメンバーか・クライアントの値）で状態を決め、替えたら `server_ops` で知らせる。クライアントは同じ表で予測する。
- 2 を採らない理由：2 つのイシューのどちらの行に持つかで、配るグループが片方になる。非公開のチームのイシューとの関連を、公開の側の人へ ID だけ見せる形（ADR-0004）を作りにくい。塞ぐ・塞がれるの両側を同時に書くと、片方だけが確定する状態が生まれうる。
- b を採らない理由：利用者が Duplicate の状態を直接付けられることになり、「Duplicate はシステムだけが付ける」（ADR-0002 の例）を検証で守れない。元のつなぎ直しや解除の戻し先を、オフラインのクライアントが知らない状態で決めることになる。
- y を採らない理由：作った人のメンバーシップは、オフラインの間に変わりうる。連携や API からの作成にはクライアントの判断がない。

## Consequences

- 良くなること：
  - 関連が非公開のチームをまたいでも、ID だけが両側に届く。
  - 重複の関連は常に重複でないイシューを指し、画面の「元へ」のたどりが 1 段で済む。
  - Triage の入り口の判断が 1 か所になる。
- 引き受けるコスト：
  - 同時に同じ関連を作ると、片方が拒否になる（画面には出さない）。
  - 重複のつなぎ直しが、多くの関連の書き換えになりうる（派生の 500 件の上限と Worker。ADR-0025）。
  - 本家の Triage の重複（添付を移す）と振る舞いが違う。

## Confirmation

- 表駆動テスト：DT-ISSUE-002（Triage の入り口）、DT-ISSUE-004（自動で閉じる）。
- 性質ベーステスト：PROP-ISSUE-003（重複の元）、PROP-ISSUE-004（木）、PROP-ISSUE-005（自動で閉じるの停止）。
- 性質ベーステスト（ADR-0004 の性質の一部として）：任意のメンバーシップと関連の列の後、関連の行が届いたクライアントは、両方のイシューのどちらかを見てよく、見てよくない側のタイトルと状態を手元に持たない。

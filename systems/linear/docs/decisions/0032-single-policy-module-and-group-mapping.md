---
status: accepted
date: 2026-09-28
---

# ADR-0032: 権限は `packages/policy` の純粋な関数 `can()` と `groupsFor()` にまとめ、全部の経路とクライアントが同じコードを使う。読む権限は「行の同期グループと購読が交わる」と同じ意味にし、書く権限と管理の権限は決定表で決める

## Context

[ADR-0004](0004-tenancy-and-permissions.md) は、権限の判定を 1 つの関数 `can(actor, action, model)` にまとめ、そこから購読する同期グループを導き、Writer・Sync API・Gateway・Public API・検索・Webhook・通知が共有すると決めた。決定表は permissions-and-teams の領域に任せた。

残る問いは次のとおり。

- `can()` の入力（ロール、メンバーシップ、チームの公開）を、どこで、どう読むか。Writer はロックの中、クライアントは手元のモデル、Gateway は握手の時。
- 読む権限を `can()` の中で行の中身から計算すると、同期グループ（行の `sync_groups`）と別の答えを出しうる。そのずれは、同期では届かないのに検索では出る、のような漏れになる。
- 決定表の範囲（ロール × チームの公開 × メンバーか × 操作）と、モデルごとの追加の規則（コメントは書いた人だけ、など）。

本家のロールは、オーナー（Enterprise）・管理者・メンバー・ゲスト（Business 以上）で、公開のチームは全メンバーが見て参加でき、非公開のチームはメンバーだけが見る（[Members and roles](https://linear.app/docs/members-roles)、[Teams](https://linear.app/docs/teams)、[Private teams](https://linear.app/docs/private-teams)、2026-09-28 に確認）。

## Options

1. **純粋な関数（I/O なし）。入力の事実は呼ぶ側が渡す。読む権限は同期グループの交わりで定義する**
2. `can()` が DB を読む関数（サーバーだけ）。クライアントは別の簡易な判定
3. 読む権限も行の中身から `can()` で計算し、同期グループは別に導く

## Decision

1 を採用する。詳細は [permissions-and-teams.md](../architecture/permissions-and-teams.md) の 4・5 節。

- `packages/policy` に `can(principal, action, target, facts)` と `groupsFor(principal, facts)` を置く。手で書く（[ADR-0019](0019-schema-definition-and-codegen.md) の「手で書くもの」）。`Principal` はロール・状態・チームのメンバーシップ・API の範囲。`Facts` はチームの公開と、生成した `groupsOf`。
- `can(p, "read", row) ⇔ groupsOf(row) ∩ groupsFor(p) ≠ ∅`。読む権限に例外を作らない。一部の人に読ませたくない値は、別のモデル（別のグループ）に分ける。
- 書く権限は DT-PERM-001（チームの行）、管理の操作は DT-PERM-002、モデルごとの規則は DT-PERM-003。
- 購読は、Writer がメンバーシップ・ロール・状態・チームの公開を変えるトランザクションで、`groupsFor` の差として `SyncSubscription` に書く（[ADR-0013](0013-sync-group-changes-retention-and-reset.md)）。Gateway・Sync API・検索・ビューの問い合わせは `sync_subscriptions` を読む。1 日 1 回、両者のずれを監査する。
- `packages/policy` の外で権限の条件（`role ===`、`visibility ===`）を書くことを lint で禁止する。
- 2 を採らない理由：クライアントの判定がサーバーとずれ、画面で出した操作が拒否される。I/O を含むと、Writer のロックの中での呼び方と、シミュレーターでの試験が難しくなる。
- 3 を採らない理由：同期・検索・通知で「読める」の答えが 2 つになり、ずれがそのまま漏れになる。

## Consequences

- 良くなること：
  - 読める範囲の試験が、同期グループの試験 1 つにまとまる。検索・ビュー・通知の漏れを同じ性質で防げる。
  - クライアントとサーバーが同じ判定をする。
- 引き受けるコスト：
  - 「行は届くが読めない」を作れないので、読み手の違う値はモデルを分ける（例：`ProjectTeam`）。モデルが増える。
  - `Facts` を呼ぶ側がそろえる手間。そろえ漏れは判定の誤りになるので、呼ぶ側を少なくする（Writer、握手、クライアント）。

## Confirmation

- 表駆動テスト：DT-PERM-001〜004 の全行を、Writer とクライアントの両方で。
- 性質ベーステスト：PROP-PERM-001（決定表の読む権限と、同期グループの交わりの一致）、PROP-PERM-003（購読の一致）。
- lint：`packages/policy` の外の権限の条件の禁止。
- 本番：`subscription_drift` が 0。

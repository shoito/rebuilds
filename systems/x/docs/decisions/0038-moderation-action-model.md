---
status: accepted
date: 2026-10-04
---

# ADR-0038: 措置は追記だけの `moderation_actions` に根拠と主体を書き、同じトランザクションで措置の要約と `state_version` と outbox を書いてから効かせる

詳細は [trust-and-safety.md](../architecture/trust-and-safety.md) の 4・5 節。

## Context

- 措置は記録してから効かせ、取り消せる形で持ち、物理の削除は保持の後のジョブだけが行う（[AGENTS.md](../../AGENTS.md)）。
- `visible()` は読み出しのたびに投稿の状態を読む。状態は写し（`ps:`・`as:`）から読み、`state_version` の新しいものだけを書く（[ADR-0009](0009-post-state-tombstones-and-state-cache.md)）。措置の正本は `moderation_actions` で、投稿の `mod_flags` はその要約である（同 ADR）。
- 措置から全経路で 60 秒（NFR-009）。経路はタイムライン・検索・通知・メディア・API にまたがる（[ADR-0004](0004-single-tenant-and-visibility.md)）。
- 同じ対象に複数の措置（印と地域での非表示）が同時にありうる。措置には期限・取り消し・異議がある。
- 措置を受けた利用者に、措置・根拠・異議の方法を示す（[intent.md](../intent.md)）。運用の状況の公表（L1）に、措置の数と根拠が要る。

## Options

1. **追記だけの措置の行と状態の出来事の行。要約（`mod_flags`・`account_mod`）は効いている行の畳み込みで、同じトランザクションで書き、outbox に出す**
2. 投稿・アカウントの行に措置の列を持ち、上書きする（履歴は監査ログ）
3. 措置をイベントソーシングにし、要約は消費者が非同期に作る

## Decision

1 を採用する。

- `moderation_actions`：対象、種類、値（地域・期限・制限）、規約の区分と版、根拠（規約・法令の案件・照合・規則）、判断した主体（人か `rule:{id}@{version}`）、承認者、案件、状態。行は書き換えない。状態の変化は `moderation_action_events` に足す。
- 種類：投稿は `label`・`reduce`・`geo_withhold`・`remove`、メディアは `remove_media`、アカウントは `label_account`・`reduce_account`・`read_only`・`suspend`、機能は `feature_limit`。判断までの一時の扱いは `interim_reduce`。
- 措置を効かせるトランザクションで、行・要約（効いている行を全部畳み込んで計算し直す）・`state_version` の加算・outbox（`moderation` の流れ）を書く。確定の直後に `ps:`・`as:` の写しを書く。
- 状態：`pending_approval → active → expired | reversed | superseded`。永久の凍結・法令の措置・`csem` は 2 人の承認。`csem` と `violent_threat` の緊急の `remove` は先に効かせ、24 時間以内に 2 人目が確かめる。
- 取り消しは `reversed` の出来事と要約の計算し直しで行う。
- 利用者への通知は、措置の型から作る。通知を止める場合（法執行の求め、捜査を害しうる場合）は理由を案件に記録する。
- 2 を採らない理由：同じ対象の複数の措置と、それぞれの期限・取り消しを表せない。根拠と主体が監査ログに散り、公表の集計ができない。
- 3 を採らない理由：要約が非同期になると、措置の確定から `visible()` に効くまでに消費者の遅れが入り、60 秒を守りにくい。要約の正しさを、行の畳み込みとの一致で確かめにくい。

## Consequences

- 良くなること：
  - 措置の根拠と主体が必ず残り、取り消せ、公表の集計の元になる。
  - 要約と行が同じトランザクションで食い違わない。
  - 措置が `visible()` に数秒で効く。
- 引き受けるコスト：
  - 措置のたびに対象の効いている行を全部読む。1 つの対象の措置は数件なので費用は小さい。
  - 規則の措置も行になるので、行の数が多い（S1 で 1 日数万件の見込み）。保持は L8。

## Confirmation

- 性質ベーステスト：PROP-TS-001（要約と行の畳み込みの一致）、PROP-TS-002（取り消しで元に戻る）、PROP-TS-007（規則の措置の種類の制限）。
- 表駆動テスト：`DT-TS-001`（種類 × 閲覧者 × 経路）。
- lint：`mod_flags`・`account_mod` を、措置のサービスの外で書く SQL を禁止する。`moderation_actions` への `UPDATE`・`DELETE` を禁止する（保持のジョブを除く）。
- 結合テスト：措置から 60 秒で全経路から消える。

---
status: accepted
date: 2026-10-10
---

# ADR-0055: `review_pairs` は 1 予約 1 行で、期限は物件の現地のチェックアウトの時刻から現地の日付で 14 日の後の同じ時刻。提出は組の行を `FOR UPDATE` で取り、DB の `now()` が期限より前のときだけ受け、2 人目の提出なら同じトランザクションで `revealPair()` を呼ぶ。期限は `deadline-runner` が同じ `revealPair()` を呼ぶ。未公開のレビューは書いた本人の外に、RLS と公開のビューで出さない

詳細は [reviews.md](../architecture/reviews.md) の 4 節。

## Context

- 両者が出すか、チェックアウトから 14 日が過ぎるまで、どちらのレビューも相手にも他の人にも見えない。公開は両方同時（NFR-009、[intent.md](../intent.md)）。本家も 14 日と早いほうの公開（[ヘルプの記事 13](https://www.airbnb.com/help/article/13)、2026-10-10 に確認）。
- 2 人の提出、提出と期限の処理が同時に起きうる。アプリの時計と DB の時計がずれると、期限の直前の提出の扱いが揺れる。
- 「14 日」は、夏時間のある国の物件で 14 × 24 時間と違いうる（NFR-014）。
- Mercari の題材は、完了まで隠す相互の評価を、組の行とビューで決めた（[ADR-0049](../../../mercari/docs/decisions/0049-mutual-ratings-sealed-until-completion.md)）。

## Options

1. **組の行のロック、DB の時計、1 つの公開の関数、本人の RLS と公開のビュー**
2. 公開をアプリの判定（両方のレビューを読んで、両方あれば公開の印）で行う
3. 期限を UTC の 14 × 24 時間にする

## Decision

1 を採用する。

- 組は予約ごとに 1 行（`reservation_id` の一意）。`deadline_at` は `addLocalDays(window_start_at, 14, time_zone)`。
- 提出は 1 つのトランザクション：組を `FOR UPDATE`、`now() < deadline_at` と未公開を確かめ、検査を通してレビューを書き、両方が出ていれば `reveal_pair(pair, 'both_submitted')`。
- 期限の処理は 1 分ごとに、期限を過ぎた未公開の組を `FOR UPDATE SKIP LOCKED` で取り、`reveal_pair(pair, 'deadline')` か `closed_empty`。
- `reveal_pair` は `revealed_at IS NULL` の条件つきの更新で、1 回だけ書く。
- `reviews` は本人だけの FORCE RLS。他の全部の経路は公開のビュー `reviews_public`（`revealed_at IS NOT NULL` かつ削除していない行）を読む。公開の後の更新はトリガーで拒む。

### 他の案を選ばなかった理由

- **2**：2 人が同時に出すと、どちらのトランザクションも相手の行を見られず、公開されない。読み出しの経路ごとの判定は漏れやすい。
- **3**：本家と利用者の「14 日」（現地の日付）と 1 時間ずれ、期限の告知の時刻と合わない。

## Consequences

- 良くなること：
  - 片方だけの公開・期限の前の公開が、構造の上で起きない。
  - 提出と期限の競合が 1 つの時計と 1 つのロックで決まる。
- 引き受けるコスト：
  - 組の行のロックの分、同じ予約の同時の提出が直列になる（量は小さい）。
  - 期限の処理は 1 分の粒度で、期限から最大 1 分遅れる（NFR-009 の範囲）。

## Confirmation

- PROP-REV-001〜PROP-REV-006。
- 仮想の時計の試験（[quality.md](../quality.md) の 2.2.1 節 D・F）。

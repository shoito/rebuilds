---
status: accepted
date: 2026-10-04
---

# ADR-0044: アカウントの状態を 5 つにし、Accounts だけが outbox を通して変える。停止は 30 日の猶予の後に削除する。年齢は区分だけを `visible()` に渡し、境の値は法務の L5 の後に設定で入れる

## Context

アカウントには、乗っ取りの疑い、T&S の凍結、本人の停止、削除がある。どの状態も、見える範囲（[ADR-0004](0004-single-tenant-and-visibility.md)）と、写し・検索・通知・数に効く。状態の変更が経路ごとにばらばらだと、凍結や削除の後に投稿が見え続ける（NFR-009）。

- 本家は、停止（deactivate）の後 30 日で削除し、その間のログインで戻すとされる（help.x.com は 403 で**未検証**）。
- App Store の 5.1.1(v) は、アカウントを作れるアプリに、アプリの中での削除を求める（[App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)、2026-10-04 に確認）。
- 年齢の扱い（最低の年齢、確かめの方法、未成年の制限）は法務の確認待ち（[intent.md](../intent.md) の L5）。

## Options

状態の持ち方：

1. **1 つの列 `users.state` に 5 つの状態。変えるのは Accounts だけで、outbox で知らせる**
2. 状態ごとの印（`suspended_at`、`deactivated_at` …）を各サービスが書く

年齢：

- a. **生年月日を Accounts だけが持ち、区分（`under_min`・`minor`・`adult`）を `ViewerContext` に渡す**
- b. 生年月日を各サービスに渡す

## Decision

1 と a を採用する。詳細は [accounts-and-auth.md](../architecture/accounts-and-auth.md) の 7〜9 節。

- 状態：`active`、`locked`（乗っ取りの疑い）、`suspended`（T&S の措置）、`deactivated`（本人の停止）、`deleted`。鍵アカウントは状態ではなく `users.protected` の印。
- 変えるのは Accounts のサービスだけ。`users.state` と outbox の出来事を同じトランザクションで書く。T&S は `moderation_actions` に書いてから Accounts の内部の API を呼ぶ。
- `visible()` は作者の状態を `PostState` から見るので、後始末の前でも隠れる。
- 停止の猶予は 30 日（`policy.deactivation_grace_days`）。満了で `deleted` にし、削除の流れ（[security.md](../architecture/security.md) の 7.2 節）へ入れる。法的な保全のある対象は中身を消さない。
- ハンドルは、変更の後 30 日、削除の後 90 日、他人に渡さない。古いハンドルの URL は転送しない。
- 生年月日は暗号文で Accounts だけが持つ。区分の境（`policy.age.min`・`policy.age.adult`）は L5 の後に入れ、それまで登録の年齢の Story の spec を承認しない。
- 2 を採らない理由：状態の判定が経路ごとに違う列を見ることになり、漏れの原因になる。
- b を採らない理由：生年月日は個人データで、広く渡す必要がない。判定に要るのは区分だけ。

## Consequences

- 良くなること：
  - 状態の変更が 1 か所で、全経路の判定が同じ。
  - 法務の L5 の結論が出ても、設定の値と、区分を使う各領域の規則の追加で済む。
- 引き受けるコスト：
  - Accounts の内部の API が、T&S の措置の経路に入る。
  - 区分の日ごとの計算のジョブ。
  - 30 日の猶予の間、削除を求めた人のデータが残る（削除の説明に含める）。

## Confirmation

- 表駆動テスト：DT-AUTH-002（状態 × 操作 × 入口の可否）。
- 結合テスト：状態の変更の後、全経路の読み出しで投稿が出ない（漏れの経路の表）。
- 仮想の時計の E2E：停止と 30 日の中での戻し、満了での削除。
- マイグレーションの検査：`users.state` を書くロールが Accounts だけ。

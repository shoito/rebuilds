---
status: accepted
date: 2026-09-27
---

# ADR-0006: アプリは Swift と Kotlin で書き、共有は生成した型と状態機械のテストのベクターに限る。リリースは週 1 回の列車で、強制の更新は乗車の最中と緊急の入口を塞がない

詳細は [rider-and-driver-apps.md](../architecture/rider-and-driver-apps.md) の 5・10 節。

## Context

[ADR-0001](0001-platform-and-stack.md) は、アプリをネイティブ（Swift・Kotlin）で書き、共有は Protocol Buffers から生成するモデルと Trips の状態遷移の表のテストのベクターに留めると決めた。細部はこの領域に残した。

- 2 つのコードベースで、乗車の状態の解釈がずれると、ドライバーが誤った操作をし、乗客が誤った状態を見る。
- アプリは古いバージョンが長く残る。サーバーは古いバージョンの形を受け続ける必要がある。
- 乗車の最中に更新を強いると、乗客とドライバーが操作できなくなる。緊急の入口は、どのバージョンでも使えなければならない（NFR-010）。
- 本家は、4 つのアプリをトランクベースで開発し、週 1 回の列車で出していたと説明されている（本家の技術ブログ [The Uber Engineering Tech Stack, Part II](https://www.uber.com/us/en/blog/uber-tech-stack-part-two/)、2016-07-21、2026-09-27 に確認）。
- App Store の段階的な公開は、7 日で 1%・2%・5%・10%・20%・50%・100% と固定で、止められる。対象は自動の更新をする利用者だけ（[Release a version update in phases](https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases)、2026-09-27 に確認）。Google Play の `IMMEDIATE` のアプリ内の更新は、更新が終わるまで画面を塞ぐ（[Support in-app updates](https://developer.android.com/guide/playcore/in-app-updates/kotlin-java)、2026-09-27 に確認）。

## Options

共有：

1. **生成した型と、JSON のテストのベクターだけを共有する。状態機械は各アプリで純粋な reducer として書く**
2. **Kotlin Multiplatform で状態機械を共有する**
3. **状態機械をサーバーだけに置き、アプリは画面の表示だけにする**

配布：

- a. **週 1 回の列車。強制の更新はサーバーが配る最低のバージョンで、場面ごとに塞ぐかを決める**
- b. **機能ができたら出す（列車なし）**
- c. **強制の更新を、ストアの仕組みだけに任せる**

## Decision

1 と a を採用する。

- 型は buf で Swift・Kotlin に生成し、`buf breaking`（`WIRE_JSON`）を CI で守る。列挙の知らない値は既定の振る舞いにする。
- アプリの乗車の状態は `reduce(state, input) -> (state, effects)` の純粋な関数にし、時計・通信・乱数は外から入れる。状態の名前は Trips のものだけを使う。
- Trips の遷移の表（DT-TRIP-001・004、オファーの事象）から JSON のベクターを生成し、スキーマのリポジトリの PR で、Swift と Kotlin の reducer に全ベクターを通す。1 つでも違えばマージしない。
- 対応する OS は iOS 17 以上・Android 10（API 29）以上。
- 列車は月曜に切り、木曜に審査に出し、段階的に公開する。ドライバーのアプリは、週末の夜に段階を進めない。
- サポートは最新から 8 つ前のバージョンまで。サーバーは `recommended_min` と `required_min` を配る。`required_min` より古いバージョンは、依頼の前と出庫を塞ぎ、乗車の最中は塞がない。緊急の入口と 110・119 の案内は、どの場面でも塞がない。サーバーは古いバージョンの受諾と出庫を 426 で拒否する。
- 2 を採らない理由：ビルドの仕組みが 1 つ増え、iOS の背景の位置・通信の層と、共有のコアの境界の不具合を調べる手間が増える。ADR-0001 のとおり、S2 で食い違いの不具合が多ければ見直す。
- 3 を採らない理由：通信が切れたときに、ドライバーが乗車を進められない（[ADR-0022](0022-trip-outbox-and-offline-continuation.md)）。
- b を採らない理由：審査と段階的な公開の手間が機能ごとに生じ、4 つのアプリのバージョンの組み合わせが増える。
- c を採らない理由：ストアには、古いバージョンの利用を止める仕組みがない（iOS）。乗車の最中を避ける判断もできない。

## Consequences

- 良くなること：
  - 2 つのアプリの状態の解釈のずれを、マージの前に見つけられる。
  - 更新の強制で、乗車の最中の利用者を困らせない。
- 引き受けるコスト：
  - 状態機械を 2 回書く。ベクターの生成と保守が要る。
  - サーバーは 8 つ前のバージョンまでの形を受け続ける。
  - 列車に乗り遅れた機能は 1 週待つ。

## Confirmation

- CI：ベクターが Swift と Kotlin で全件通ること。テストの名前に対応する ID を含める。
- 性質ベーステスト：PROP-APP-001〜003（[rider-and-driver-apps.md](../architecture/rider-and-driver-apps.md) の 11.1 節）。
- UI の試験：緊急の入口がログインの後のすべての画面で 1 回のタップで開くこと。`required_min` より古いバージョンの模擬で、乗車の最中の画面が塞がれないこと。
- 監視：`required_min` より古いバージョンの利用者の割合、426 の件数。

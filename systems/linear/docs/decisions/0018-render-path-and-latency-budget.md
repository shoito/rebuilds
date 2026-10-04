---
status: accepted
date: 2026-09-28
---

# ADR-0018: 入力の経路は Action → トランザクション → プールへの適用 → 行ごとの購読の描き直しで、何も待たない。一覧は固定の高さで仮想化し、遅延は自前の印で測って、固定の機械の CI で p99 50ms を超えた PR を失敗させる

## Context

NFR-001 は、ローカルの操作（状態・優先度・担当・ラベルの変更、並べ替え、コマンドメニュー、読み込み済みの一覧の切り替え）の入力から描画までを、基準の端末（4 年前の中位のノート PC 相当）とイシュー 50 万件のワークスペースで p99 50ms に収めることを求める。AGENTS.md は、これを CI のベンチマークで守り、予算を超えた PR を失敗させることを求める。

先に決めたこと：

- 入力の経路で IndexedDB とネットワークを待たない（[ADR-0005](0005-client-persistence-and-offline.md)）。
- 一覧・フィルター・並べ替えは M2（詰めた索引）だけで答え、観測可能なモデル（M1）は 5 万個まで（[ADR-0016](0016-memory-tiers-quota-and-offline-ux.md)）。
- 反応型のストア（MobX か自前か）は E2 の PoC で決める（[ADR-0001](0001-platform-and-stack.md)）。

計測の API として、Event Timing は、イベントの開始から次の描画までの `duration` を 8ms に丸めて出す。既定の閾値は 104ms、最小は 16ms で、それより短い操作は出ない（[PerformanceEventTiming](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceEventTiming)、2026-09-28 に確認）。

## Options

描画：

1. **行ごとの購読と、固定の高さの仮想化（`@tanstack/virtual-core` を包む）**
2. 一覧全体を 1 つの購読で描き直し、React の差分に任せる
3. 高さを測る仮想化（可変の高さ）

計測：

- a. **イベントの `timeStamp` から、commit の後の `requestAnimationFrame` の次の仕事までを自前の印で測る。Event Timing は抜けの確かめに使う**
- b. Event Timing だけ

CI：

- x. **型番を固定した自前のランナーと、毎回の較正**
- y. クラウドの共有のランナーと CPU の間引き（throttling）

## Decision

1・a・x を採用する。詳細は [client-app.md](../architecture/client-app.md) の 4・8・9 節。

- 経路：keymap → Action → トランザクションと `derive` の予測 → `pool.apply` → 触れたフィールドを読む部品だけの描き直し → 描画 → 描画の後に outbox のコミット。この間に `await` を置かない。
- 内訳の予算（p99）：配送と解決 2ms、Action と `derive` 3ms、プールと並び 10ms、React 15ms、レイアウトと描画 10ms、余裕 10ms。差分の適用は 1 回 5ms までに分ける。
- 一覧は 1 行 36px、ボードのカードは 3 つの固定の高さ。前後に 10 行多く描く。フォーカスのある行は外さない。選択は ID の集合。一括の操作は最初の 500 操作だけを入力の経路で当てる。
- 印：開始は `event.timeStamp`、終わりは commit の後の `requestAnimationFrame` の中で `MessageChannel` に投げた次の仕事。Action の ID ごとに RUM へ 10% を送る。Event Timing（`durationThreshold: 16`）と突き合わせる。
- CI：基準の端末と同じ級の、型番を固定した自前のランナー。毎回の較正で 5% ずれたら無効。合成のイシュー 50 万件の手元の状態から起動し、[client-app.md](../architecture/client-app.md) の 9.4 節の場面を各 300 回。どれかの p99 が 50ms を超えたら失敗、main の中央値より 10% 遅ければ警告。Chrome は必須、Firefox・Safari は夜間。
- 2 を採らない理由：1 件の状態の変更で、数万行の一覧の部品が再評価され、React の 15ms の予算を超える。
- 3 を採らない理由：測るための描画とレイアウトが入力の経路に入り、差分で行が動くたびに位置が揺れる。課題管理の一覧は 1 行の省略で足りる。
- b を採らない理由：16ms 未満の操作が出ないので、p99 の分母が偏る。Chromium 以外の古いバージョンでは使えない端末もある。
- y を採らない理由：隣の負荷で結果が揺れ、50ms の境の判定が安定しない。CPU の間引きはメモリーと GC の速さを基準の端末に合わせない。

## Consequences

- 良くなること：
  - NFR-001 を PR ごとに機械で守れる。
  - 本番と CI で同じ印を使い、差を比べられる。
  - 行ごとの購読で、描き直しの量が変わった行の数に比例する。
- 引き受けるコスト：
  - 固定の機械のランナーの調達と保守（壊れたときの代わりの同じ型番）。
  - 行の高さの固定で、長いタイトルは省略になる。
  - 印の終わりは描画の近似で、実際の描画より数 ms ずれうる。
  - `@tanstack/virtual-core` に依存する（包みで差し替えられるようにする）。

## Confirmation

- CI：[client-app.md](../architecture/client-app.md) の 9.4 節のベンチマークを必須のチェックにする。期待の緩和で通さない。
- 性質ベーステスト：PROP-APP-002（選択の安定）。
- lint：入力の経路のモジュール（`src/actions/`、`packages/pool` の `apply`）から、`idb`・`fetch`・`WebSocket`・`navigator.locks` を使うことを禁止する。
- 本番：RUM の Action ごとの p99 を日次で見る。超えたら Maintain の段で Intent にする。

---
status: accepted
date: 2026-09-27
---

# ADR-0008: 外部のナビには選んだルートの主要経由地点を経由地として渡し、経由地を守ると確かめた引き継ぎ先だけを事前確定運賃で使う

詳細は [rider-and-driver-apps.md](../architecture/rider-and-driver-apps.md) の 6 節。

## Context

ドライバーのナビは外部のアプリに引き継ぐ（[ADR-0005](0005-maps-and-routing.md)）。事前確定運賃では、乗客と運転者に同じ走行予定ルート（または主要経由地点）を示し、運転者は原則として逸脱しない（[ADR-0017](0017-fare-distance-for-pre-fixed-fares.md)）。行き先だけを渡すと、外部のナビが別のルートを選ぶ。

事実（2026-09-27 に確認）：

- Google マップの Maps URLs は、経路の操作で `waypoints` を持つ。モバイルのブラウザーで開くと 3 つまで、それ以外は 9 つまで。経由地に対応しない製品では無視される（[Maps URLs](https://developers.google.com/maps/documentation/urls/get-started)）。Android の `google.navigation:` の intent は経由地を持たない（[Google Maps Intents](https://developer.android.com/guide/components/google-maps-intents)）。
- Apple マップの統合の Maps URL（iOS 18.4 以降）は、`/directions` で `waypoint` を繰り返して複数の経由地を渡せ、`avoid=tolls` を持つ（[Adopting unified Maps URLs](https://developer.apple.com/documentation/mapkit/unified-map-urls)）。上限の数は書かれていない。

## Options

1. **主要経由地点を経由地として Maps URLs・統合の Maps URL で渡す。守ることを確かめた引き継ぎ先だけを事前確定運賃で出す。アプリの中で逸脱を知らせる**
2. **行き先だけを渡し、逸脱は乗車の後の軌跡で見るだけにする**
3. **経由地を 1 つずつ行き先として順に引き継ぐ**
4. **アプリにナビの SDK を組み込む**

## Decision

1 を採用する。

- Google マップ：`https://www.google.com/maps/dir/?api=1&destination=…&waypoints=…|…&travelmode=driving&dir_action=navigate`。有料道路を使わないと乗客が選んだら `avoid=tolls` を付ける。intent は使わない。
- Apple マップ：iOS 18.4 以上で `https://maps.apple.com/directions?destination=…&waypoint=…&waypoint=…&mode=driving`。
- 経由地は最大 8 つ。超えたら有料道路の出入口を先に残し、残りを道のりで等間隔に選ぶ。`fare-distance` に 8 以下を返すよう申し送る。
- 迎車の区間は行き先だけを渡す。
- 引き継ぎ先の一覧（`nav_handoff_targets`）はサーバーの設定で配り、E9 の試験で「経由地を順に通る案内になる」と確かめた先だけ、事前確定の乗車で出す。確かめられない先は外す。
- 事前確定の乗車中、端末で表示用の線からの距離を求め、200 m を超える状態が 30 秒続いたら知らせ、`RouteDeviationObserved` を送る。運賃は変えない。
- 引き継ぎを `NavigationHandedOff` として記録する。
- 2 を採らない理由：通達の「示したルートを逸脱しない」を、運転者が守れる形にしていない。
- 3 を採らない理由：Android では背景から次のナビを起動できず、走行中にドライバーの操作が要る。安全でない。
- 4 を採らない理由：[ADR-0005](0005-maps-and-routing.md) の「アプリ内のナビをしない」に反し、ナビの SDK の料金と、地図の提供者の条件（他の地図との併用）の論点が増える。1 で守れない引き継ぎ先ばかりなら、別の ADR で見直す。

## Consequences

- 良くなること：
  - 乗客に示したルートを、外部のナビで運転者が走れる。
  - 引き継ぎ先の振る舞いが変わっても、アプリの配布なしに外せる。
- 引き受けるコスト：
  - 引き継ぎ先ごとの試験を、ナビのアプリの更新に合わせて続ける。
  - 経由地の間引きで、示したルートと細部が違う案内になりうる。
  - 車載のナビしか使わないドライバーは、アプリの画面を見て走る。

## Confirmation

- 表駆動のテスト：URL の組み立て（間引き、`avoid`、2,048 文字の上限）。
- 端末の試験：引き継ぎ先ごとに東京の 20 のルートで、案内の線が経由地を順に通ること。結果を `nav_handoff_targets` に反映する。
- 監視：事前確定の乗車 1,000 件あたりの逸脱の知らせの件数（引き継ぎ先ごと）。急に増えたら runbook（`nav-handoff-regression.md`）。

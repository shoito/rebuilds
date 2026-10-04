---
status: accepted
date: 2026-09-27
---

# ADR-0040: SLO は都市ごとに、依頼・位置・遷移・支払い・緊急の通報の事象で数える。不変条件（二重の割り当て・二重の請求）は SLO にせず、1 件で呼び出す

詳細は [observability.md](../architecture/observability.md) の 5・6 節。値の正本は Ops の [runbooks/README.md](../runbooks/README.md) に置く。

## Context

非機能要件（[architecture/README.md](../architecture/README.md) の 3 節）は、配車の判断の速さ（NFR-001）、位置の鮮度（NFR-002）、ETA の精度（NFR-003）、都市ごとの配車の可用性（NFR-004）、割り当ての一意（NFR-005）、支払いの正しさ（NFR-006）、乗車の耐久性（NFR-007）、状態の配信（NFR-008）、安全の機能（NFR-010）を置いた。これを計る SLI の定義と、どれを SLO にし、どれを不変条件として扱うかを決める。

- 配車は、近くに空車がいなければ組を作れない。これは基盤の障害ではない。「オファーを送れたか」だけで数えると、供給の不足が SLO を食う。
- 都市ごとに測る（NFR-004）。全体の平均では、1 都市の障害が隠れる。
- 本家は、ドライバーのオファーの配信の確認が取れないことを、SSE から gRPC へ移った理由に挙げている（[notifications-and-realtime-push.md](../architecture/notifications-and-realtime-push.md) の 2 節）。

## Options

1. **事象（依頼、位置の点、遷移、支払いの操作、緊急の通報）ごとの良い・悪いを、サービスが自分で数える SLI**
2. **ALB の 5xx と遅延だけの SLI**
3. **合成の監視だけ**

## Decision

1 を採用し、合成の監視を補助にする。

| SLI | 良い事象 | SLO（月間、都市ごと） | NFR |
| --- | --- | --- | --- |
| `dispatch_decision` | `requested` になった依頼が、5 秒以内に最初の配車の判断（オファーの提案か、「候補なし」の記録）を受けた | 99.9% | NFR-001、NFR-004 |
| `dispatch_intake` | 依頼・見積もりの API が 5xx・タイムアウトなしに答えた（混雑の 429 は除く） | 99.99% | NFR-004 |
| `location_freshness` | 受信した点が 1 秒以内に索引に適用された | 99% | NFR-002 |
| `trip_transition` | アプリの遷移の操作が 5xx・タイムアウトなしにコミットされた（状態の不一致の 409 は良い） | 99.95% | NFR-007 |
| `state_delivery` | 状態の変化が 2 秒以内に相手のアプリに届いた（受信の確認で計る） | 95% | NFR-008 |
| `offer_delivery` | オファーの作成から `OfferDelivered` まで 1.5 秒以内 | 95% | ADR-0015 |
| `payment_auth` | 与信が、PSP の障害・この基盤の誤りなしに結果を得た（カードの拒否は良い） | 99.9% | NFR-006 |
| `payment_capture` | `completed` から 1 時間以内に売上の確定が成功した | 99.9% | NFR-006 |
| `emergency_ack` | `SafetyIncident` の受信から担当が受けるまで 30 秒以内 | 95% | NFR-010 |
| `eta_accuracy` | 1 日の迎車の ETA の誤差が中央値 60 秒・p90 180 秒以内 | 30 日のうち 27 日 | NFR-003（[ADR-0016](0016-valhalla-serving-traffic-and-eta-accuracy.md) の定義） |

- **不変条件は SLO にしない。** 二重の割り当て（[ADR-0003](0003-trip-state-and-single-assignment.md) の 1 分ごとの検査）、二重の請求（[ADR-0023](0023-psp-authorize-at-request-capture-at-end.md) の日次の検査）、台帳の釣り合い、rideshare の台数の超過（[ADR-0027](0027-rideshare-operating-windows.md)）、緯度経度のログへの混入は、1 件で呼び出す。
- **配車の判断の記録**：`DispatchBatchRecord`（[ADR-0015](0015-offer-protocol-decision-log-and-replay.md)）が正本。可観測性の側は、`decision_id` をトレース・ログ・`driver_assignments`（オファーの記録を兼ねる。統合の工程で `trip_offers` から改めた）に付け、乗車の ID から判断の記録を 1 回で引けるようにする。記録の中身をログやメトリクスに写さない。
- メトリクスのラベルは `city`・`zone`・`service`・`version` まで。`trip_id`・`driver_id` はログとトレースの属性にだけ書く。
- バーンレートの警告は Slack・Figma の題材と同じ（1 時間で 14.4 倍は呼び出し、6 時間で 6 倍は起票）。
- 2 を採らない理由：配車の判断はバッチの中で起き、HTTP の応答に現れない。オファーの配信や位置の鮮度も測れない。
- 3 を採らない理由：本物の需給と事象の数の偏りを表さない。

## Consequences

- 良くなること：
  - 供給の不足（候補なし）と基盤の障害を分けて数えられる。
  - 1 都市の障害が、その都市の SLO に現れる。
- 引き受けるコスト：
  - サービスごとに良い・悪いの事象を数える計装が要る（共通の部品で持つ）。
  - `state_delivery` と `offer_delivery` は、アプリの受信の確認に依る。アプリのバージョンの不具合が SLO を食いうる。

## Confirmation

- 計装の共通の部品に、SLI の名前とラベルを定数で持たせ、lint で他の名前を禁じる。
- 障害注入（E1 の後、staging）：索引・ETA・Trips・PSP の模擬を止め、対応する SLI の悪い事象が増え、警告が鳴ることを確かめる。
- 「候補なし」の依頼を合成で流し、`dispatch_decision` が良い事象として数えることを確かめる。

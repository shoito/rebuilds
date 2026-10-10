---
status: accepted
date: 2026-10-10
---

# ADR-0016: 住所の検索と地図は、自前の API の後ろの提供者のアダプターで使う。vault に残す位置はホストが地図で確かめたピンだけで、提供者の座標そのものは残さない。自治体のコード・条例の区域・タイムゾーン・密度の区分は、ピンの確定の時に正確な位置から求めて core に書き、正確な位置は書かない

詳細は [location-and-geo.md](../architecture/location-and-geo.md) の 4 節。

## Context

- 自前の住所の検索のエンジンと地図のタイルは作らない（[intent.md](../intent.md) の Non-goals）。
- 提供者の利用条件（座標の保存の期間、他の地図との併用）は提供者ごとに違う。Uber の題材は、提供者の座標でなく利用者が確かめたピンを残す形にした（[ADR-0034](../../../uber/docs/decisions/0034-geocoding-provider-and-pickup-points.md)）。
- 税の表・自治体の規則・タイムゾーンは位置で決まる（[ADR-0002](0002-availability-representation-and-double-booking.md)、[ADR-0006](0006-regulatory-night-cap-enforcement.md)）。これらを判定するたびに vault の正確な位置を読むと、vault の読み出しの経路が増える。

## Options

1. **自前の API の後ろのアダプター。確かめたピンだけを vault に残し、位置から求める値はピンの確定の時に core に書く**
2. アプリが提供者を直接呼び、提供者の座標を残す
3. 位置から求める値を、使う時に vault から毎回求める

## Decision

1 を採用する。

- アプリは自前の API だけを呼ぶ。提供者に送るのは番地までの住所で、建物名と部屋番号は送らない。地図のタイルは、提供者のアプリ用の制限つきの鍵で端末が取る。
- vault の `exact_locations` には、ホストが確かめたピンと住所の構造の項目を封筒の暗号化で残す。提供者の座標・提供者の ID は残さない。
- ピンと提供者の候補の距離が 300 m を超える、精度が低い、市区町村が食い違う場合は `needs_review`。
- ピンの確定の時に、`municipality_code`・`rule_zone_ids`・`tax_zone_ids`・`time_zone`・`density_class`・`approx_point` をメモリーの中で求めて core に書く。区域が変わったら、vault を読める役割の運用のジョブで求め直す。
- 正確な位置を読む関数は `readExactLocation()` の 1 つで、`exactLocationVisible()` と vault の監査の行を通す。

### 他の案を選ばなかった理由

- **2**：提供者の鍵がアプリに出て、提供者の利用条件に縛られた座標が正本になる。提供者を替えると位置が変わる。
- **3**：見積もり・予約・検索のたびに vault を読むことになり、vault の読み出しの量と経路が増える。

## Consequences

- 良くなること：
  - 提供者を替えても、vault の位置と core の値は変わらない。
  - 税・条例・時刻の判定が core の値だけで済み、vault を読まない。
- 引き受けるコスト：
  - 区域の変更のたびに求め直しのジョブが要る。
  - 提供者の精度の低い地方の住所では、ホストのピンの確かめに頼る。

## Confirmation

- PROP-GEO-004（`readExactLocation()` と監査）。
- 漏れの経路の表（[quality.md](../quality.md) の 2.2.1 節 H）：提供者への要求に建物名・部屋番号が含まれないことを、提供者の模型の記録で確かめる。

---
status: accepted
date: 2026-10-10
---

# ADR-0038: リクエストの期限は「作成から 24 時間」と「チェックインの時刻の 2 時間前」の早いほう。断りは決まった理由のコードで受け、保護される属性に関わる理由を選べない。正確な住所は確定の時、入り方（暗証番号など）はチェックインの 48 時間前から出す。届出住宅は宿泊者名簿の入力の後に入り方を出す（法務の確認待ち：L3）

> 2026-10-10 の注記：統合の工程で、正確な住所を出す期間の終わりを `check_out_at + 14 日` から、ADR-0007 と location-and-geo の領域の `check_out_at + 7 日` に揃えた（狭いほうを取った）。ホストの電話番号は `check_out_at + 14 日` のまま。

## Context

- リクエストへのホストの応答は 24 時間（本家に寄せる。[Reservation requests](https://www.airbnb.com/help/topic/1340)、2026-10-10 に確認）。チェックインが近いリクエストでは、24 時間の前にチェックインの時刻が来る。
- 断りの理由は、差別の禁止（法務の L11）と旅館業法の宿泊の拒否の制限（法務の L2）に関わる。
- 正確な住所は確定した予約のゲストにだけ出す。出す時期は確定の時と決めた（[architecture/README.md](../architecture/README.md) の 6 節。本家は**未検証**）。暗証番号などの入り方は、住所より強く守りたい（漏れると侵入に使える）。
- 届出住宅の宿泊者名簿は本人確認のうえ作る（法務の L3）。

## Options

1. **期限は 24 時間とチェックインの 2 時間前の早いほう。理由のコードは決まった集合。住所は確定、入り方は 48 時間前、届出住宅は名簿の後**
2. 期限は常に 24 時間。理由は自由な文
3. 住所も入り方もチェックインの 48 時間前から出す

## Decision

1 を採用する。詳細は [booking-and-holds.md](../architecture/booking-and-holds.md) の 9・10 節。

- `request_expires_at = min(作成 + 24h, check_in_at − 2h)`。作成から 2 時間を切るリクエストは 422 `request_too_late`。
- 断りの理由のコード：`dates_not_available`・`group_size`・`house_rules_conflict`・`maintenance`・`other`。`other` の自由な文は `request_declines` に持ち（差別の語の辞書で調べる）、メッセージにも書ける。断りの率と理由の分布を属性の代わりの値なしで見る。
- 旅館業・特区の施設は、L2 の結論までリクエストを受けない（即時予約だけ）案を既定にする。
- 住所：`confirmed` から `check_out_at + 7 日`（[ADR-0007](0007-tenancy-host-accounts-and-rls.md) の `exactLocationVisible()`）。入り方：`check_in_at − 48h`（ホストが 0〜7 日で変える）から `check_out_at`。届出住宅は `registry_status = complete` も要る（`legal.registry_gate_arrival_info`。本番の値は L3 の後）。
- 通知の本文に住所・暗証番号を入れない。

### 他の案を選ばなかった理由

- **2**：チェックインの後に承認できるリクエストが生まれる。自由な文の理由は、属性に基づく断りを見つけにくい。
- **3**：確定の後にゲストが場所を確かめられない（README の決定に反する）。

## Consequences

- 良くなること：
  - チェックインの直前のリクエストが宙に浮かない。
  - 入り方の漏れの窓が 48 時間に縮む。
- 引き受けるコスト：
  - 旅館業の施設は L2 の結論までリクエストを使えない。
  - 名簿を入れないゲストは入り方を見られず、CS の問い合わせが増える。

## Confirmation

- 性質ベーステスト PROP-BKG-008（`exactLocationVisible`・`arrivalInfoVisible` が表の通り）。
- 仮想の時計：リクエストの期限（24 時間とチェックインの 2 時間前の境）、入り方の 48 時間前の境。
- 漏れの経路の表の「チェックインの案内」「通知」の行（[quality.md](../quality.md) の 2.2.1 節 H）。

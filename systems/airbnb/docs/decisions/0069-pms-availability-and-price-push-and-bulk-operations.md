---
status: accepted
date: 2026-10-10
---

# ADR-0069: PMS の空室と料金の書き込みは範囲の状態を宣言する `PUT` にし、そのアプリの `api_block` の行だけを差分で足し引きする。リスティングと流れごとの単調な `client_sequence` で古い要求と再送を扱い、POST は `Idempotency-Key` にする。一括の操作は行ごとのトランザクションの非同期のジョブにする

## Context

- PMS は、他の掲載先で売れた夜を本システムで閉じ、料金を毎日まとめて書き換える。自分の待ち行列から再送し、順序が入れ替わる。古い「開ける」が新しい「閉じる」を上書きすると、外部と同じ夜を売る（NFR-005 の外の二重の予約、NFR-003）。
- 同じリスティングに、ホストの画面のブロック、iCal の取り込み、本システムの予約、他の PMS の書き込みが重なる。PMS の書き込みが、それらを消してはならない。
- どの書き込みも `stay_claims` の排他の制約を通る（[ADR-0002](0002-availability-representation-and-double-booking.md)）。届出住宅の外部の予約は `regulated_nights` の外部の申告になりうる（[ADR-0006](0006-regulatory-night-cap-enforcement.md)）。
- ホストの画面の一括の変更（多くのリスティングの料金、年末年始の閉じ）も同じ問題を持つ。

## Options

書き込みの形：

1. **範囲の状態の宣言（`PUT`）。サーバーはそのアプリの行だけを差分で直す。リスティングと流れごとの単調な番号で順序を守る**
2. 操作の列（`POST /blocks`、`DELETE /blocks/{id}`）と `Idempotency-Key`
3. `If-Match` の `calendar_version` による楽観の並行の制御だけ

一括：

- a. **JSONL の非同期のジョブ。各行を別のトランザクションで流す**
- b. 1 つのトランザクションの全部か無か

## Decision

1 と a を採用する。詳細は [host-tools-and-api.md](../architecture/host-tools-and-api.md) の 6 節。

- **宣言**：`PUT /v1/listings/{id}/availability` は `window` の中の、そのアプリの `api_block` の行の集合を、`closed` の範囲の和に揃える。消える区間は `released`、新しい区間は挿入、同じ区間は触れない。他の種類の行と他のアプリの行には触れない。`rates`・`stay-rules` も同じ形で、`calendar_days` と滞在の規則を書く。
- **重なり**：挿入が排他の制約に当たった範囲だけを `conflict` にし、相手の種類を返す。他の範囲は書く。`external_reservation` の理由の重なりは `calendar_conflicts` に記録してホストに知らせ、本システムの予約は自動で取り消さない。
- **順序と冪等**：（アプリ、リスティング、流れ）ごとに最後の `client_sequence` と本文のハッシュと結果を、書き込みと同じトランザクションで持つ。大きい番号は適用、同じ番号と同じ本文は前の結果、同じ番号で違う本文は 409 `idempotency_conflict`、小さい番号は 409 `stale_sequence`。流れは `availability`・`rates`・`stay_rules`・`external_stays`（外部の泊の申告。`stay_claims` に書かない。[calendar-sync.md](../architecture/calendar-sync.md) の 7 節）。
- **POST**：承認・断り・ジョブの作成・購読は `Idempotency-Key`（同意ごと、24 時間）。承認と断りは `If-Match` で予約の `expected_version` を受ける（[ADR-0004](0004-booking-state-machine-and-holds.md)）。
- **大きな解放**：1 要求で 180 泊を超える行を外したら、監査の事象を書き、`owner` に知らせる。止めない。
- **上限**：1 要求 1 MB、範囲 100 件、1 範囲 366 泊、今日から 730 泊先まで。
- **一括**：JSONL のジョブ（5,000 行、10 MB、ホストのアカウントごとに同時 2、6 時間）。`bulk-runner` が 1 行ずつ同じ関数を別のトランザクションで呼び、行ごとの結果を S3 に置く。ホストの画面の一括の変更も同じ仕組み（500 リスティング × 366 日まで）。

### 他の案を選ばなかった理由

- **2（操作の列）**：再送と順序の入れ替えで、削除の後の古い追加が残る。PMS は自分の状態の全体を持つので、差分の操作の列を正しく作るのが難しい。
- **3（`calendar_version` だけ）**：ホストの画面・iCal・予約がリスティングの `calendar_version` を毎回進めるので、PMS の書き込みが絶えず 409 になる。PMS は自分の流れの順序だけを気にすればよい。
- **b（全部か無か）**：数千のリスティング × 数百の泊を 1 つのトランザクションに入れると、熱い日付の予約をロックで待たせる。1 つの重なりで全部が失敗する。

## Consequences

- 良くなること：
  - 再送・順序の入れ替え・重複のどれでも、最後の状態は最大の番号の要求の状態に収束する。
  - PMS の誤りが、ホストのブロック・取り込み・予約・他のアプリの行を消さない。
  - 画面と API の一括の変更が 1 つの仕組みになる。
- 引き受けるコスト：
  - PMS に、リスティングと流れごとの単調な番号の実装を求める（開発者の文書と試験の環境で確かめる）。
  - 一括のジョブは途中で止まると一部だけが効く。行ごとの結果で知らせる。

## Confirmation

- 性質ベーステスト：任意の要求の列の重複・入れ替え・欠けで、最後の状態が最大の番号の要求の適用に等しい（PROP-HST-002）。そのアプリの行の外を変えない（PROP-HST-003）。[quality.md](../quality.md) の 2.2.1 節 A の生成器に PMS の操作を混ぜても、排他の性質が成り立つ。
- 結合：一括のジョブの途中の停止と再開で、各行が 1 回だけ効く。
- 本番：`stale_sequence`・`conflict` の率と、大きな解放の数をアプリごとに見る（[observability.md](../architecture/observability.md)）。

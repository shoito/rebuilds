---
status: accepted
date: 2026-09-26
---

# ADR-0005: リポジトリの中身の正本は Git、メタデータの正本は DB にする

## Context

Pull Request は、Git の ref（ブランチ）と、DB のメタデータ（タイトル、レビュー、状態）の両方にまたがる。push で ref が動くと、Pull Request の状態（新しいコミット、マージ可能か）を更新する必要がある。

## Options

1. **中身の正本は Git、メタデータの正本は DB。** ref の更新を Event として DB 側へ伝え、写しを更新する
2. **ref とコミットを DB にも正本として持つ**

## Decision

1 を採用する。

- ref・コミット・ツリーの正本は、Git のストレージ（3 つの複製）とする。
- Pull Request・Issue・レビュー・権限などは、DB を正本とする。
- **push の ref の更新が成功したら、ストレージの側で、リポジトリごとの順序付きの Event（ref の旧と新）を outbox に書く。** Worker がそれを読み、Pull Request の最新のコミット、マージ可能かの再計算、検索の索引、Webhook、Actions の起動を行う。
- DB に置く ref やコミットの情報は、表示と検索のための写しであり、食い違ったら Git を正とする。定期に照合する。
- 2 は、Git と DB の二重の正本になり、push のたびに分散トランザクションが要る。

## Consequences

- 良くなること：
  - push の経路が DB の障害に巻き込まれにくい。
  - 写しの食い違いを、Git から作り直せる。
- 引き受けるコスト：
  - push の直後、Pull Request の画面に新しいコミットが出るまでに、わずかな遅れがある（p95 数秒を目標にする）。

## Confirmation

- 性質ベーステスト：任意の push の列の後で、DB の写しの ref が、Git の ref と一致する（Worker の処理が追いついた後）。
- 定期の照合：DB の写しと Git の ref の不一致の件数を監視し、0 でなければ作り直す。

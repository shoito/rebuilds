---
status: accepted
date: 2026-09-27
---

# ADR-0052: ジャーナルの表はオンデマンドで事前に温め、1 ファイルの書き込みは予算で抑える。予算を超えそうなファイルは、まとめの間隔を段階的に広げる

## Context

ジャーナルは `file_id` をパーティションキーにし、1 ファイルの書き込みは 1 つのパーティションに集まる（[ADR-0024](0024-journal-items-and-fencing.md)、[multiplayer.md](../architecture/multiplayer.md) の 12.3 節）。

- DynamoDB の 1 つのパーティションは、書き込みを毎秒 1,000 単位（1 単位は 1 KB）まで出す（[Best practices for designing and using partition keys](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)、2026-09-27 に確認）。
- `TransactWriteItems` は、各項目を準備と確定の 2 回ずつ読み書きし、その分の単位を使う。条件で取り消されたときも使う（[Amazon DynamoDB Transactions: How it works](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)、2026-09-27 に確認）。フェンスの `ConditionCheck` が読みと書きのどちらの単位を使うかは、資料から読み取れなかった（**未検証**。ここでは書きの 2 単位として見積もる。E3 の前の `dynamodb-transaction-poc` で `ReturnConsumedCapacity` を見て確かめる）。
- 頻繁に使われる項目は、別のパーティションへ置き直されうるが、ソートキーが単調に増える項目の集まりはソートキーで分けない（[DynamoDB burst and adaptive capacity](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/burst-adaptive-capacity.html)、2026-09-27 に確認）。1 ファイルのジャーナルの末尾の書き込みは、1 つのパーティションの上限に当たる。
- オンデマンドの新しい表は、毎秒 4,000 の書き込みまで出せ、それを超えると過去の最高の 2 倍まですぐに出せる。30 分以内に最高の 2 倍を超えると、スロットリングが起きうる。温めた量（warm throughput）を先に設定できる。表ごとの既定の上限は、アカウントで毎秒 4 万（引き上げを申請できる）（[DynamoDB on-demand capacity mode](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html)、2026-09-27 に確認）。
- 会議の始まりや全社の発表で、1 つのファイルに数百人が集まる（[architecture/README.md](../architecture/README.md) の 7 節）。

## Options

表の容量：

1. **オンデマンド。S1 の最高の 2 倍を warm throughput で先に温め、アカウントの上限を引き上げる**
2. **プロビジョンド（自動スケール）**

1 ファイルの書き込み：

- a. **ファイルごとの予算（毎秒の単位）を file actor が数え、段階的にまとめの間隔を広げる。超えたら確定を遅らせる（背圧）**
- b. **パーティションキーを `file_id#bucket` に分けて書き込みを散らす**
- c. **何もしない（スロットリングの再試行に任せる）**

## Decision

1 と a を採用する。数値は [capacity.md](../architecture/capacity.md) の 4 節。

- **表**：`journal`・`file_leases`・`ds_liveness` はオンデマンド。`journal` は、S1 の見積もりの最高（毎秒約 2.5 万単位）の 2 倍を warm throughput で先に温める。アカウントの表ごとの上限（毎秒 4 万）の引き上げを、S1 の前に申請する。大阪のレプリカも同じ設定になる（グローバルテーブルは容量の設定を同期する）。
- **予算**：file actor は、書いたまとまりの単位（項目の大きさから計算）を 1 秒の窓で数える。1 ファイルの予算は毎秒 400 単位（パーティションの上限の 1,000 のうち、トランザクションの 2 倍と、同じパーティションの読み取りと、見積もりの誤差に余裕を残す）。
  | 使った割合 | 動き |
  | --- | --- |
  | 50% 未満 | 通常（クライアントのまとめ 50ms、group commit 20ms） |
  | 50% 以上 | クライアントのまとめを 100ms に（`RoleChanged` の付属の値で指示する。[multiplayer.md](../architecture/multiplayer.md) の 12.3 節）、group commit を 50ms に |
  | 80% 以上 | クライアントのまとめを 200ms に、在席の配信を 200ms に |
  | 100% | 次のまとまりを、窓が空くまで書かない（確定が遅れる。クライアントは `pending` が伸びる） |
- まとめの間隔を広げると、同じ `(ノード, プロパティ)` の変更がまとまり（[file-storage-and-history.md](../architecture/file-storage-and-history.md) の 4.3 節）、単位が減る。反映の遅延（NFR-001）はそのファイルだけ悪くなる。
- 予算の段は、メトリクス（ファイルの大きさの区分ごとの件数）と、上位のファイルの記録（[observability.md](../architecture/observability.md) の 4.3 節）に出す。
- 2 を採らない理由：S1 の負荷は日中に偏り、夜間の余りに払うことになる。S2 で、日中の底の量をプロビジョンドとリザーブドに移す案を費用で比べる。
- b を採らない理由：回復の読み取りが複数のパーティションになり、`seq` の範囲の連続の確かめ（ADR-0024 の飛びの検知）が複雑になる。a で足りないことを E12 の負荷試験で確かめてから、別の ADR で扱う（[file-storage-and-history.md](../architecture/file-storage-and-history.md) の 16 節の持ち越し）。
- c を採らない理由：スロットリングの再試行が 10 秒続けば、ファイルを手放すことになる（ADR-0024）。人が集まるファイルほど止まる。

## Consequences

- 良くなること：
  - 人が集まるファイルでも、ファイルを手放さずに編集が続く。
  - 1 つのファイルの負荷が、他のファイルのジャーナルの書き込みに響かない（パーティションが分かれるため）。
- 引き受けるコスト：
  - 予算を超えたファイルでは、反映が遅くなる。NFR-001 の対象の外として扱うかは、quality.md で QA が決める。
  - warm throughput の設定の費用。

## Confirmation

- 負荷試験（E12）：1 ファイルに 500 接続（編集 200）で、DynamoDB のスロットリングが起きず、予算の段が働く。
- 計測：`journal` の `ThrottledRequests`（表と GSI）、ファイルの予算の段ごとの件数。

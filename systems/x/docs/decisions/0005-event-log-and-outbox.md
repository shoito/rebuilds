---
status: accepted
date: 2026-10-04
---

# ADR-0005: 確定した変更は outbox から Kinesis Data Streams の出来事のログへ流す。閲覧の数だけは Aurora を通さない

## Context

投稿・フォロー・いいね・措置のような確定した変更を、多くの部品が受け取る。

| 出来事 | 受け取る部品 |
| --- | --- |
| 投稿の作成・削除 | fan-out、作者の最近の投稿、検索の索引、トレンド、通知（メンション・返信・引用）、カウンター（返信・引用の数）、T&S（スパムの規則）、データレイク |
| フォロー・解除・ブロック | 写しの後始末と補充、フォロワーの数、通知、おすすめの特徴、T&S（大量のフォローの検出） |
| いいね・リポスト・ブックマーク | カウンター、通知、おすすめの特徴、トレンド、T&S |
| 措置 | 写しの後始末、検索の索引、CDN の無効化、通知、データレイク |
| 閲覧 | 表示の数、おすすめの特徴、データレイク |

求められることは次のとおり。

- **DB と食い違わない**：確定した変更は必ず流れ、確定しなかった変更は流れない。
- **消費者が独立**：検索の索引が遅れても、fan-out は遅れない。
- **やり直せる**：カウンターや検索の索引を壊したとき、出来事を最初から（保持の範囲で）読み直して作り直せる。
- **量**：S1 で閲覧の出来事が 1 日 5 億件（ピーク 2 万件/秒）、S3 で 1 日 600 億件（[architecture/README.md](../architecture/README.md) の 2 節）。
- 共通の基盤は、transactional outbox → SQS（必要なら SNS で分ける）である。

## Options

出来事のログ：

1. **outbox → Relay → Kinesis Data Streams。** 消費者ごとに読み終わりの位置を持つ。仕事の待ち行列（fan-out の束、メディアの変換、プッシュの送信）は SQS
2. **outbox → SNS → 消費者ごとの SQS**（共通の基盤のまま）
3. **outbox → Amazon MSK（Kafka）**
4. **Aurora の論理レプリケーション（変更の取り出し）を直接消費者が読む**

閲覧の数：

- a. **Aurora を通さず、クライアントの出来事を Ingest で束ねて Kinesis へ入れる。失ってよい出来事として扱う**
- b. 閲覧も、他の出来事と同じく Aurora に書き、outbox から流す

## Decision

1 と a を採用する。

### 出来事のログ

- **outbox**：書き込みのサービス（Post、Graph、Engagement、T&S、Accounts）は、変更と同じ DB のトランザクションで `outbox` の表に出来事を書く。行は `(seq, event_id, stream, partition_key, type, payload, created_at)`。`event_id` は UUIDv7。
- **Relay**：`outbox` を `seq` の順に読み（`FOR UPDATE SKIP LOCKED` で担当を分ける）、Kinesis へ `PutRecords` で束ねて送る。送れた行には `sent_at` を立て、1 時間残してから 1 時間ごとの区画で落とす。DR で大阪の Relay が送り直すため（[ADR-0056](0056-disaster-recovery-osaka.md)）。Relay は少なくとも 1 回届ける。
- **流れ（stream）と分ける鍵**：

  | 流れ | 鍵 | 主な出来事 |
  | --- | --- | --- |
  | `posts` | 作者の ID | 作成、削除、措置の反映 |
  | `graph` | フォローする側の ID | フォロー、解除、申請、承認、ブロック、ミュート |
  | `engagement` | `"{post_id}:{user_id mod 8}"`（[ADR-0023](0023-counter-aggregation-and-reconciliation.md)） | いいね、取り消し、リポスト、ブックマーク、返信・引用の数の出来事 |
  | `moderation` | 対象の ID | 措置、取り消し、異議の結果 |
  | `accounts` | 利用者の ID | 登録、鍵の切り替え、削除、凍結 |
  | `views` | 閲覧者のセッションのハッシュ（[ADR-0024](0024-view-counts-ingest-and-approximation.md)） | 閲覧の束（Ingest から。下の「閲覧の数」） |
  | `dm` | 会話の ID | DM の出来事。ID だけを運び、本文を含めない。Firehose でデータレイクへ写さない（[ADR-0035](0035-dm-conversation-model-and-storage.md)） |
  | `audit` | 対象の ID | 監査の出来事。消費者は log-archive へ写す `audit-sink` だけ（[ADR-0052](0052-audit-and-operator-access.md)） |

  同じ鍵の出来事は、同じシャードの中で順に並ぶ。鍵をまたぐ順序は保証しない。
- **Firehose へ直接書く記録**：確定した変更ではなく、失ってよい分析の記録は、Kinesis Data Streams を通さず、Firehose でデータレイクへ直接書く。ランキングの配信の記録（`ranking-served`、[ADR-0020](0020-ranking-evaluation-experiments-and-transparency.md)）、公開 API の計量（`api-usage`、[ADR-0048](0048-usage-plans-and-metering.md)）、見える範囲の抜き取りの監査（`visibility-audit`、[ADR-0059](0059-guardrail-and-audit-metrics.md)）、RUM（`rum`）が当たる。下の lint は Kinesis Data Streams への直接の書き込みを禁じるもので、これらには当たらない。
- **保持**：Kinesis は 7 日。長く持つ分は Firehose で S3 のデータレイクへ写す（保持の期間は法務の L8 の後に決める）。
- **消費者**：消費者ごとに、シャードごとの読み終わりの位置を持つ。消費者は **冪等** にする。
  - 結果を DB に書く消費者は、`event_id` の一意の制約で重複を落とす。
  - 結果を Valkey に書く消費者（カウンター）は、投稿ごとの写しに、分ける鍵の部分ごとの最後に当てた連番を持ち、連番が新しいときだけ足す（[ADR-0023](0023-counter-aggregation-and-reconciliation.md)）。シャードの読み終わりの位置は、足し終えた後に Aurora の `stream_checkpoints` に書く。再起動で読み直しても、連番の比較で同じ出来事を 2 回足さない。
  - 消費の部品は自前の TypeScript の読み手（`packages/stream-consumer`）にする（[ADR-0055](0055-kinesis-consumers-and-valkey-clusters.md)）。
- **仕事の待ち行列は SQS**：1 つの出来事から多くの仕事が生まれるもの（fan-out のフォロワーのページ、プッシュの送信、メディアの変換）は、消費者が SQS に仕事を作り、Worker が処理する。仕事は再試行と死んだ仕事の行き先（DLQ）を持つ。

### カウンター（いいね・リポスト・返信・引用・ブックマーク）

- **正本は関係の表**（`likes(post_id, user_id)` など。一意の制約で 1 人 1 回）である。
- **数は写し**：Counter Aggregator が `engagement`・`posts` の流れを読み、投稿ごとの数を Valkey に持つ。1 秒ぶんの増減を投稿ごとにまとめてから書く（人気の投稿の書き込みを減らす）。
- **書き戻し**：変わった投稿の数を、60 秒ごとに Aurora の `post_counters` へ書き戻す。Valkey を失ったら、`post_counters` と、その時点からの流れの読み直しで戻す。
- **照合**：照合のジョブが、抜き取りの投稿（と、数の大きい投稿）で関係の表を数え直し、写しとの差を記録して正本の値で上書きする（NFR-006）。
- 方式の細部（投稿ごとの写しの形、殺到する投稿の分割）は engagement-and-counters の領域で決めた（[ADR-0023](0023-counter-aggregation-and-reconciliation.md)）。

### 閲覧の数

- クライアントは、画面に出た投稿の ID を束ねて（既定 10 秒か 50 件ごと）Ingest に送る。何を「閲覧」とするか（画面に出た割合と時間）は engagement-and-counters の領域で決める。
- Ingest はセッションと端末を確かめ、明らかな機械の送信を落とし、Kinesis の `views` の流れへ入れる。**Aurora を通さず、outbox も使わない。**
- 表示の数は **概算** である。Ingest や流れの障害で失った閲覧は戻さない。誤差の目標は、データレイクの集計との差 2% 以内（NFR-006）。表示の数は減らさない（新しい値が古い値より小さければ、古い値を出す）。
- b を採らない理由：S1 でも 1 日 5 億件の行を Aurora に書くことになり、投稿・フォローの書き込みと同じ DB を圧迫する。閲覧は、失っても利用者の資産を失わない出来事である。

### 他の案を選ばなかった理由

- **2（SNS → SQS）**：消費者ごとに待ち行列ができて独立には読めるが、読み終わった出来事は消え、やり直し（カウンターや索引の作り直し）ができない。閲覧の量（S3 で 1 日 600 億件）を、消費者の数だけ複製して運ぶ費用も大きい。
- **3（MSK）**：Kafka は機能が豊かだが、ブローカーの台数・分割・バージョンの運用が重い。Kinesis のオンデマンドで足りる間は、管理の少ないほうを選ぶ。S3 で Kinesis の費用か上限が合わなくなったら、ADR を書いて見直す。
- **4（論理レプリケーションの直接の消費）**：DB の表の形が出来事の形になり、表を変えると全消費者が壊れる。S2 で DB を分けたとき、流れが DB の数だけ分かれる。

## Consequences

- 良くなること：
  - DB と出来事が食い違わない。消費者が独立に遅れ、独立にやり直せる。
  - 閲覧の大量の出来事が、正本の DB を圧迫しない。
- 引き受けるコスト：
  - 共通の基盤に、Kinesis の運用（シャード、消費者の位置、保持）が加わる。
  - 出来事の形（スキーマ）をバージョンで管理する必要がある。消費者は 1 つ前のバージョンを読めるようにする（delivery の領域）。
  - 鍵をまたぐ順序がない。たとえば、投稿の作成（`posts`）と、それへのいいね（`engagement`）が、消費者に逆の順で届きうる。消費者は、知らない投稿への出来事を、短い時間だけ待つか、正本で確かめる。
  - 表示の数は正確でない。利用者と広告主（MVP の後）に、概算であることを示す。

## Confirmation

- 結合テスト：変更のトランザクションを途中で失敗させたとき、出来事が流れない。Relay を途中で止めて再起動したとき、出来事が欠けない（重複はよい）。
- 性質ベーステスト：任意の重複・再起動・順の入れ替えのある出来事の列に対して、カウンターの写しが、関係の表の数え直しと一致する。
- lint：書き込みのサービスから Kinesis Data Streams の `PutRecord(s)` を直接呼ぶことを禁止する（Relay と Ingest だけ）。
- 本番：outbox の最も古い行の年齢、消費者ごとの遅れ（`IteratorAge`）、照合のジョブの差、閲覧の取り込みの欠け（Ingest の受け付けと集計の差）を計測し、アラートにする。

## 注記

> 2026-10-04 の注記：統合の工程で次を直した（[process.md](../../../../docs/process.md) の 9 節の例外）。
>
> - 「結果を Valkey に書く消費者は、結果とシャードの位置を同じ `MULTI` で書く」を取り消した。Valkey のクラスタでは `MULTI` は同じスロットの鍵にしか使えず、投稿ごとの数とシャードの位置は別のスロットにあるため。代わりに、投稿ごとの写しに部分ごとの最後の連番を持つ形にした（[ADR-0023](0023-counter-aggregation-and-reconciliation.md)）。位置は Aurora の `stream_checkpoints` に持つ（[ADR-0055](0055-kinesis-consumers-and-valkey-clusters.md)）。
> - 流れの表を直した。`engagement` の鍵を `"{post_id}:{user_id mod 8}"`（ADR-0023）、`views` の鍵を閲覧者のセッションのハッシュ（[ADR-0024](0024-view-counts-ingest-and-approximation.md)）にした。`dm`（ID だけ、データレイクへ写さない。[ADR-0035](0035-dm-conversation-model-and-storage.md)）と `audit`（[ADR-0052](0052-audit-and-operator-access.md)）の流れを足した。
> - Firehose へ直接書く記録（ランキングの配信の記録、公開 API の計量、見える範囲の抜き取りの監査、RUM）を足した。
> - 「送れたら行を消す」を、送った行を 1 時間残す形に変えた（[ADR-0056](0056-disaster-recovery-osaka.md)）。

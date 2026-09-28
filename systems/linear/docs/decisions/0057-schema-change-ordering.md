---
status: accepted
date: 2026-09-28
---

# ADR-0057: スキーマの変更は、サーバーの DB を広げる → サーバーが古い形と新しい形の両方を受ける → クライアントを移す → 古い `schema_hash` の接続が 1% 未満かつ 30 日の後に縮める → 古い列を単独で消す、の順にする。1 つのデプロイで、DB の破壊の変更とそれを読むコードを一緒に出さない

## Context

この題材には、同時に動く 3 つの版がある（[data-model-and-schema.md](../architecture/data-model-and-schema.md) の 6 節）。

- サーバーの DB の形（マイグレーション）。
- モデルの `schema_hash` とトランザクションの形の `fv`。Gateway は今と 1 つ前の `schema_hash` を 30 日受け、Writer は今と 1 つ前の `fv` を 30 日受ける（[ADR-0005](0005-client-persistence-and-offline.md)、[ADR-0019](0019-schema-definition-and-codegen.md)）。
- クライアントの手元の DB の `schema_version`。

クライアントは 7 日以上オフラインでいられ、古い形の outbox を持ったまま新しいサーバーにつながる（NFR-004）。ADR-0005 は「足す → クライアントを更新する → 古いものを消す」の順を決め、細部を delivery の領域に任せた。サーバーのコードは、いつでも 1 つ前の版に戻せる必要がある。

## Options

1. **広げる・移る・縮める・消すの 4 段。縮めるのは、古い `schema_hash` の接続が 1% 未満、かつ移る段から 30 日、かつ古い `fv` の outbox の報告が 0 に近い時。消すのは、縮めた後のコードが 1 リリース以上動いてから単独で**
2. 広げると移るを 1 つのリリースで行い、30 日で消す
3. 版ごとに API（同期のプロトコル）を分け、古い版の入口を長く残す

## Decision

1 を採用する。詳細は [delivery.md](../architecture/delivery.md) の 7 節。

- 広げる（N）：新しい列・表を足す（`NOT NULL` は既定値つき、索引は `CONCURRENTLY`）。Writer の `derive` で古い操作を新しい列にも写す。既存の行は Worker が枠の中で埋める（[ADR-0054](0054-per-workspace-write-admission.md)）。
- 移る（N+1）：埋めが終わった後に、クライアントが新しい列を使う。`upcast` で古い形の outbox を変換する。手元の DB の版を上げるなら、機能の変更と別のリリースにする（[ADR-0056](0056-flags-client-distribution-and-min-build.md)）。Writer は古い `fv` と新しい `fv` の両方を受ける。
- 縮める（N+2 以降）：条件を満たしたら、互換の一覧から古い `schema_hash` を外し、古い列を読まないコードを出す。
- 消す：縮めたコードが 1 リリース以上動いた後に、列を消すマイグレーションを単独で出す。その後は、その前の版へ戻さない。
- マイグレーションは、1 つ前のサーバーの版が今の DB で動く形だけにする（広げる段）。破壊の変更（消す）は、それを読まないコードの後に単独で出す。
- `sync_actions` の `data` の形が変わるときは、保持の 30 日の間、読む側（Gateway、Sync API、監査、Webhook）が両方の形を読む。
- `groups` の規則の変更は、この手順の外で別の ADR を要する。
- 2 を採らない理由：古いクライアント（オフラインの端末、更新していない Electron）の outbox が新しいサーバーで拒否され、NFR-004 を破る。サーバーのロールバックもできなくなる。
- 3 を採らない理由：同期の入口を版ごとに持つと、Writer の規則と範囲の証明を版ごとに保つ必要があり、収束の試験が版の数だけ増える。

## Consequences

- 良くなること：
  - 古いクライアントの outbox を失わない。
  - サーバーのコードをいつでも 1 つ前に戻せる。
- 引き受けるコスト：
  - 1 つの破壊の変更に最低 3 リリースと 30 日以上かかる。
  - Writer の `derive` と `upcast` に、移る間だけのコードが残る。
  - 古い `schema_hash` の接続の数と、`fv` の報告の計測が要る（[observability.md](../architecture/observability.md)）。

## Confirmation

- 生成の検査：破壊の変更が、同じ PR の中で広げる段を経ていなければ失敗（[data-model-and-schema.md](../architecture/data-model-and-schema.md) の 4.1 節の行 9）。
- マイグレーションの検査：列の削除・型の変更が、他のコードの変更と同じ PR に入っていれば失敗。
- 互換の E2E（夜間）：1 つ前のリリースのクライアントと今のサーバー。
- オフラインの 3 つの場面の 3 つ目（古い版の outbox を新しい版で送る）。

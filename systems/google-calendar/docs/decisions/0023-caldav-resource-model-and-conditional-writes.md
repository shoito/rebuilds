---
status: accepted
date: 2026-10-04
---

# ADR-0023: CalDAV は主体・ホーム・コレクション・リソースの 4 層で出し、共有のカレンダーは見る人のホームに同じ ID で出す。ETag はバージョンと見え方の記号、正規化したら `PUT` に ETag を返さない。`sync-collection` は 1,000 件で切って 507 で続ける。空き時間だけのカレンダーは出さない

## Context

[ADR-0001](0001-platform-and-stack.md) は CalDAV を自前で作り、モバイルを MVP では OS の標準のカレンダーで覆うと決めた。[ADR-0003](0003-recurrence-storage-and-expansion.md) は予定オブジェクト 1 つを CalDAV のリソース 1 つにし、[ADR-0005](0005-change-log-and-sync-tokens.md) は CTag をカレンダーの `change_seq`、`sync-token` を同期のトークン、ETag を `object_version` から作ると決めた。[ADR-0007](0007-interop-standards-scope.md) は対応の範囲を決めた。

残っているのは次である。

- URL の形と、共有されたカレンダーをどこに出すか。
- ETag の作り方。`redact()` の見え方が変わったときに、ETag だけで比べるクライアントが古い全体の形を持ち続ける。
- 保存の時にサーバーが中身を変える（TZID の正規化、RDATE への変換、`SEQUENCE` の付け直し）。RFC 4791 の 5.3.4 節は、そのときに強い ETag を返してはならないとする。
- `sync-collection` の差分が大きいとき（tzdb の再計算、DR の後）の応答の大きさ。
- 空き時間だけ（`free_busy_reader`）の共有。本システムは `free-busy-query` を持たない。

本家の CalDAV は、カレンダーごとの主体とコレクションの 2 つの入口を持ち、OAuth 2.0 だけで認証する（[CalDAV API developer's guide](https://developers.google.com/workspace/calendar/caldav/v2/guide)、2026-10-04 に確認）。リソースの名前と ETag の作り方は公開の資料にない（未検証）。

## Options

URL と共有：

1. **利用者ごとの主体とホームの下に、利用者の一覧の全カレンダー（共有されたものを含む）を同じ `calendar_id` で出す**
2. カレンダーごとに主体を持つ（本家の形）。共有のカレンダーはクライアントで 1 つずつ足す
3. 共有のカレンダーを、代理（proxy）の拡張で出す

ETag：

- a. **`"<object_version>-<見え方の記号>"`**
- b. `"<object_version>"` だけ
- c. 返す本文のハッシュ

空き時間だけのカレンダー：

- x. **出さない**
- y. 区間だけの VEVENT（「予定あり」）として出す

## Decision

1、a、x を採用する。詳細は [sync-and-caldav.md](../architecture/sync-and-caldav.md) の 6 節。

- URL：`/.well-known/caldav` → `/dav/`、主体 `/dav/principals/<user_id>/`、ホーム `/dav/calendars/<user_id>/`、コレクション `/dav/calendars/<user_id>/<calendar_id>/`、リソース `/dav/calendars/<user_id>/<calendar_id>/<href_name>`。DNS の SRV・TXT も出す（RFC 6764）。
- 共有されたカレンダーは、見る人のホームに持ち主と同じ `calendar_id` と同じリソースの名前で出し、持ち主のテナントのコンテキストで読んで `redact()` を通す。
- リソースの名前：クライアントが付けた名前を `caldav_hrefs` に保つ。サーバーが作るときは、UID が安全な文字だけなら `<UID>.ics`、それ以外は `<event_object_id>.ics`。
- ETag は `"<object_version>-<記号>"`（[ADR-0021](0021-effective-role-and-redact-table.md) の段。`f`：`FULL`、`g`：`FULL_NO_GUESTS`、`b`：`BUSY`）。CTag も同じ記号を付ける。`BUSY` の予定のリソースの名前と UID は、見る人ごとの不透明な ID にする。1 つの予定の段が変わったら、`sync-collection` で今の段の名前を `200`、もう一方の段の名前を `404` で返す。
- `PUT` で保存した形が送られた形と正規の形で違えば、応答に ETag を返さない。
- `PUT` の前提の違反は RFC 4791 の前提の要素で返す（判定は DT-DAV-001）。`If-Match`・`If-None-Match` を確かめ、違えば 412。
- `calendar-query` の `text-match` は `redact()` の後の形で当てる。
- `sync-collection` は `Depth: 0`・`sync-level` 1。1 回 1,000 件で切り、要求の URI への 507（`number-of-matches-within-limits`）と途中のトークンで続ける。無効なトークンは `valid-sync-token` の前提の違反。
- 空き時間だけのカレンダーはホームに出さない。
- 認証はアプリ用のパスワードの Basic と OAuth 2.0 の Bearer（[ADR-0035](0035-accounts-auth-library-and-credentials.md)）。

### 他の案を選ばなかった理由

- **2（カレンダーごとの主体）**：OS のカレンダーは 1 つのアカウントの設定でホームの全コレクションを見つける。カレンダーごとに設定させると、共有のカレンダーが多い組織の利用者の手間が大きい。
- **3（代理の拡張）**：委任の意味で、ふつうの共有とは違う。対応がクライアントで揃わず、MVP の後にする（[ADR-0007](0007-interop-standards-scope.md)）。
- **b（バージョンだけ）**：ロールが下がってもバージョンは変わらず、ETag だけで比べるクライアントが全体の形を持ち続ける。
- **c（本文のハッシュ）**：見る人ごとに本文を作って計算する費用が `PROPFIND` のたびにかかる。
- **y（区間だけの VEVENT）**：クライアントが中身のない予定を表示・通知し、書き込みを試みる。区間は空き時間の照会（画面と API）で見られる。

## Consequences

- 良くなること：
  - 1 回の設定で、利用者のすべてのカレンダーが OS のカレンダーに出る。
  - 見え方が変わると ETag・CTag・トークンがそろって変わり、クライアントが古い中身を持ち続けない。
  - 大きな差分でも 1 回の応答の大きさが決まる。
- 引き受けるコスト：
  - 共有のカレンダーの読み出しはテナントを切り替える。ホームの `PROPFIND` で、テナントの数だけ問い合わせる。
  - 507 の続きに対応しないクライアントは、1,000 件を超える差分で全件を取り直す（相互運用の試験で確かめる）。
  - 空き時間だけの共有は、OS のカレンダーでは見えない。
  - 正規化したときに ETag を返さないので、クライアントの `GET` が 1 回増える。

## Confirmation

- 表駆動テスト：DT-DAV-001（`PUT` の判定）、DT-SYNC-001（トークンの検査）。
- 性質ベーステスト：PROP-SYNC-001・002、PROP-DAV-001（見え方）、PROP-DAV-002（`GET` と `PUT` の往復で変わらない）。
- 相互運用の試験：iOS・macOS のカレンダー、Thunderbird、DAVx5 で、発見、共有のカレンダー、507 の続き、`valid-sync-token`、権限の下がったカレンダーの入れ替わり（[quality.md](../quality.md) の 2.2.1 節 H）。

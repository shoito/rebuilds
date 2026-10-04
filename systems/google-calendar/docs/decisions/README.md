# Decisions: Google Calendar

Google Calendar の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤の上に、繰り返しの展開・タイムゾーン・iCalendar・CalDAV・招待の整合を自前で作る。クライアントは Web の SPA で、モバイルは MVP では CalDAV で覆う | accepted |
| [0002](0002-time-representation.md) | 時刻つきの予定は壁時計の時刻＋TZID を正にし、UTC の瞬間は `tzdata_version` つきの派生の値にする。終日は日付、浮動は浮動のまま持つ。tzdb は版を固定してサーバーとクライアントに配る | accepted |
| [0003](0003-recurrence-storage-and-expansion.md) | 予定オブジェクト（マスター＋`RECURRENCE-ID` の上書き）を保存の単位にし、範囲（過去 31 日から未来 548 日）の回を展開の索引に写す。「これ以降」は系列を `UNTIL` で切って新しい UID に分ける | accepted |
| [0004](0004-tenancy-and-rls.md) | 組織と個人をテナントにし、FORCE RLS で分ける。カレンダーの ACL と予定の公開範囲を `can()`・`redact()` の 1 つのモジュールで判定する | accepted |
| [0005](0005-change-log-and-sync-tokens.md) | カレンダーごとに単調な `change_seq` と変更のログを持ち、Web・公開 API・CalDAV・Webhook の差分の同期の背骨にする。トークンは署名つきで、30 日を過ぎたら取り直しを求める | accepted |
| [0006](0006-organizer-and-attendee-copies.md) | 参加者ごとに写しを持ち、主催者の写しを正にする。本システムの中の参加者にも内部の iTIP のメッセージで配り、外部の参加者には同じ意味を iMIP で送る | accepted |
| [0007](0007-interop-standards-scope.md) | iCalendar・iTIP・iMIP・CalDAV・WebDAV の同期の対応の範囲を決める。`free-busy-query`・`MKCALENDAR`・VTODO・`RSCALE`・`COUNTER` は MVP で持たない | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

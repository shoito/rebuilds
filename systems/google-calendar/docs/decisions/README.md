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
| [0008](0008-recurrence-expansion-semantics.md) | `expand()` は規則を壁時計の時刻で求め、無効な日付は捨てる。存在しない時刻は捨てずに RFC 5545 の 3.3.5 節でずらす。DTSTART は最初の回として `COUNT` に数え、長さは DTEND なら正確な長さ、DURATION なら名目の長さで当てる | accepted |
| [0009](0009-series-edit-and-override-rebasing.md) | 上書きは「マスターから切り離した項目」の印を持ち、系列の全体の変更では印のない項目だけを追従させる。開始・規則が変わったら、上書きと EXDATE を同じ日付の回へ付け替え、行き先のないものは捨てて示す | accepted |
| [0010](0010-occurrence-index-maintenance.md) | 展開の索引は予定オブジェクトごとに `indexed_through` を持ち、`expander` が毎日、端を進めた分だけ足す。書き込みでは回の集合の差分だけを書き、行の `object_version` は行が最後に変わった版にする。照合は毎時の抜き取りで、不一致は索引だけを作り直す | accepted |
| [0011](0011-inbound-recurrence-normalization.md) | 対応しない繰り返しの入力は経路で扱いを分ける。API と CalDAV の `PUT` は拒否し、ICS の取り込み・購読と iMIP の受信は `HOURLY` 以下の規則を範囲の中の RDATE に変えて UID を保つ。`RANGE=THISANDFUTURE` は 1 回分の上書きとして当てて利用者に示す | accepted |
| [0012](0012-tzdb-update-recompute-and-propagation.md) | tzdb の版の採用の後、会議室の予約の行を先に、次に施行の近い順に予定を計算し直す。版を上げて変更のログに載せるが `SEQUENCE` は上げない。外部の参加者には施行の後に回がある予定だけ同じ `SEQUENCE` の `REQUEST` を送り、会議室の重なりは「要確認」にする | accepted |
| [0013](0013-external-timezone-definitions.md) | 外から来た TZID は、正規の名前、別名、製品の接頭辞、Windows のゾーン名、VTIMEZONE の遷移の照合の順で IANA のゾーンに解き、解けなければ近いものに寄せて印を付ける。知っている TZID の VTIMEZONE は使わず、書き出す VTIMEZONE は本システムの tzdb から作る | accepted |
| [0014](0014-itip-state-transfer-and-sequence.md) | 内部の iTIP のメッセージは受け手に見せてよい形の予定オブジェクトの全体を運び、新旧を `(SEQUENCE, 主催者の版)` で決める。`SEQUENCE` は RFC 5546 の 2.1.4 節の項目に場所と参加者の削除を足して上げ、日時が変わったら出欠を `needs_action` に戻し、戻す前の `SEQUENCE` への返事は捨てる | accepted |
| [0015](0015-imip-addressing-and-trust.md) | 外部への招待の ORGANIZER は予定ごとの受け口のアドレスにして返事を本システムで受け、人の返事は Reply-To で主催者へ向ける。受信は From と ATTENDEE・ORGANIZER の一致と DKIM か SPF の揃いで確かめ、満たさないものは当てない。外部からの招待は転送の受け口で受け、知らない送信元は保留にする | accepted |
| [0016](0016-group-invitation-expansion.md) | グループの招待は、主催者の写しにグループの項目と展開したメンバーを持ち、メンバーの変化は今より後に回がある予定にだけ 15 分ごとのジョブで当てる。入れ子は 10 段、展開は 1 予定 10,000 人まで。200 人を超える予定の配送はバッチにして p99 60 秒にする | accepted |
| [0017](0017-freebusy-source-and-cache.md) | 空き時間は、人は展開の索引から、会議室は予約の行から求める。キャッシュは Valkey にカレンダーと UTC の週ごとの区間の一覧を、計算した時の `change_seq`（会議室は `booking_seq`）と一緒に置き、読む時に番号を比べて確かめる。テナントをまたぐ照会は相手のテナントの関数 `freebusy_for` を区間だけ返す形で呼ぶ | accepted |
| [0018](0018-find-a-time-algorithm.md) | 候補の計算は区間の一覧を 5 分刻みのビットの列と累積の和に直し、刻みごとの開始を、必須の人の重なり、勤務の時間の外、仮の予定、任意の人の空き、会議室の合い方、早さの辞書の順で並べ、全員が空いた候補 10 件と 1 人だけ重なる候補 3 件までを返す | accepted |
| [0019](0019-room-booking-rows-and-recurring-acceptance.md) | 会議室の予約は範囲の中の回ごとの行にし、`btree_gist` の排他の制約で承諾どうしの重なりを拒む。予約は主催者の書き込みのトランザクションで会議室の行をロックしてから行い、繰り返しは重なる回が半分以下かつ 8 回以下なら系列を承諾してその回だけ辞退し、超えれば全体を辞退する | accepted |
| [0020](0020-room-approval-and-needs-review.md) | 承認の要る会議室の予約は「承認の待ち」の行にして制約の外に置き、管理者の承認で承諾の行に変える。tzdb の計算し直しで承諾どうしが重なったら、後から承諾したほうを「要確認」にして制約の外に出し、主催者と管理者に知らせて自動では辞退しない | accepted |
| [0021](0021-effective-role-and-redact-table.md) | 実際のロールは持ち主、ACL の行と暗黙の行の最大、組織の外への上限の最小の順で求める。`redact()` は「全体・参加者を除く全体・区間だけ・返さない」の 4 段で返し、区間だけの形は時刻の構造と見る人ごとの不透明な ID だけを持つ。公開範囲はマスターだけが持ち、テナントをまたぐ共有のカレンダーへの書き込みはカレンダーのテナントで `packages/writer` を通す | accepted |
| [0022](0022-delegation-and-acting-on-behalf.md) | 代理の人は主のカレンダーに `writer` 以上を持つ人とし、持ち主の名前で予定を作り出欠を返せる。iTIP では `SENT-BY` に代理の人を入れ、監査ログに操作した人と代わりに操作した相手を残す。代理の人は持ち主の `private` の予定の中身も見られる | accepted |
| [0023](0023-caldav-resource-model-and-conditional-writes.md) | CalDAV は主体・ホーム・コレクション・リソースの 4 層で出し、共有のカレンダーは見る人のホームに同じ ID で出す。ETag は版と見え方の記号、正規化したら `PUT` に ETag を返さない。`sync-collection` は 1,000 件で切って 507 で続ける。空き時間だけのカレンダーは出さない | accepted |
| [0024](0024-caldav-implicit-scheduling.md) | CalDAV の `PUT` は、主催者の写しなら暗黙のスケジュールで配り、参加者の写しなら旧と新の差を取って自分の項目だけを受ける。`SCHEDULE-AGENT=CLIENT` は外部の参加者にだけ従う。参加者の写しに `Schedule-Tag` を出し、受信箱・送信箱は空にする | accepted |
| [0025](0025-ics-subscriptions-both-directions.md) | 取り込む ICS の購読は購読ごとの読み出し専用のカレンダーに写し、egress の経路で条件つきに取り、内容のハッシュで差分だけを書く。公開する ICS は持ち主が出す秘密のアドレスで、見え方は全体か空き時間だけ、組織の方針で止められ、作り直すと古いアドレスは 404 になる | accepted |
| [0026](0026-public-rest-api-shape.md) | 公開の REST API は本家の API の振る舞いに寄せた JSON で `/v1` に出し、自社の画面も同じものを使う。予定オブジェクトを単位に、繰り返しは RFC 5545 の行、回は壁時計の `recurrence_id` の ID で表す。`syncToken` は予定オブジェクトの単位で絞りと一緒に使えない。書き込みは `If-Match` と `Idempotency-Key` を受ける | accepted |
| [0027](0027-oauth-apps-scopes-and-rate-limits.md) | OAuth 2.0 は認可コードと PKCE（S256 を必須）で、アクセストークン 1 時間、リフレッシュトークンは使うたびに入れ替えて再利用で一式を取り消す。範囲は 4 つ。組織はアプリの認可を絞れる。レート制限は（アプリ, 利用者）1 分 600・（アプリ, テナント）1 分 10,000・利用者の書き込み 1 分 120 で、超えたら 429 | accepted |
| [0028](0028-push-channels-signed-webhooks.md) | Webhook は `watch` で作る通知の経路で、期限は既定 7 日・最大 30 日、自動の更新はしない。本文のない `POST` に `<Brand>-*` のヘッダーと経路ごとの秘密の HMAC の署名を付け、経路ごとに 1 秒 1 回にまとめ、24 時間失敗し続けたら止める。送る前に権限を確かめ、見られなくなったら `not_exists` を送って止める | accepted |
| [0029](0029-reminder-clock-buckets-and-timer-wheel.md) | リマインダーの時計は、Aurora の分の桶の表（256 のシャード）と、シャードを借りたタスクのメモリーのタイマーホイールの組み合わせにする。発火は計画の行の claim と送信の記録への一意の鍵の挿入で行い、挿入できたものだけを送る。15 分を超えて遅れたものは送らずに数える | accepted |
| [0030](0030-reminder-planning-horizon-and-replan.md) | リマインダーは 7 日先までの回だけを計画し、毎時に端を進める。予定・出欠・設定・タイムゾーン・tzdb の変更は `reminder.replan` で（利用者, 予定オブジェクト）の待ちの行を作り直す。終日と浮動の予定は壁時計で分を引く。送信の記録の鍵は（利用者, 予定オブジェクト, `recurrence_id`, 方法, 分, 回の開始）で、版は鍵に入れない | accepted |
| [0031](0031-notification-channels-and-content.md) | 通知は画面・Web Push・メールの 3 つの経路で、送る時に `redact()` と出欠を確かめ直す。Web Push の本文は通知の ID だけにし、Service Worker が中身を本システムから取る。予定の事象の通知は受け手と予定ごとに 2 分まとめ、毎朝の一覧は利用者のタイムゾーンの 06:00 に計画の表から送る | accepted |
| [0032](0032-booking-slot-computation.md) | 予約ページの枠は、持ち主のタイムゾーンの壁時計の受け付けの時間から、受け付けの期間・最短の予告・1 日の上限で絞り、空き時間の部品の予定あり（仮の予定を含む）と既存の予約の区間を引いて求める。間の時間は 1 つの値で前後に要る。応答は枠の UTC だけ | accepted |
| [0033](0033-booking-creation-and-exclusion.md) | 予約は持ち主の主のカレンダーの行をロックする 1 つのトランザクションで確かめ直して作り、`booking_reservations` の持ち主と区間の排他の制約で予約どうしの重なりを DB で 0 にする。メールの確認は 10 分の仮押さえで塞ぐ。予約者は外部の参加者として ICS つきのメールを受ける。ボットの対策は AWS WAF | accepted |
| [0034](0034-search-pg-bigm-acl-aware.md) | S1 の検索は Aurora の `pg_bigm` で行い、予定オブジェクトのマスターと上書きごとの検索の表に正規化した文字列と `is_private` を持つ。権限は `searchScope(actor)` のカレンダーの 2 つの集合で絞って `redact()` で確かめ直す。索引は outbox から非同期に更新し、件数の合計を返さない | accepted |
| [0035](0035-accounts-auth-library-and-credentials.md) | 認証の部品に Better Auth を使い `packages/auth` で包む。アカウントは RLS の外に置き、1 つのアカウントを 1 つのテナントの利用者に結ぶ。ログインはメールのコードとリンク・パスキー・Google・組織の SSO で、パスワードを持たない。CalDAV は `<brand>_ap_` のアプリ用のパスワードで、CalDAV だけの範囲・最長 1 年 | accepted |
| [0036](0036-org-domains-sso-and-scim.md) | 組織のドメインは DNS の TXT で確かめて毎日確かめ直す。SSO はドメインごとに SAML 2.0 か OIDC の IdP を 1 つ持ち、SP 起点だけ・署名を必須にし、必須にしても特権の管理者はパスキーで入れる。確認したドメインの個人のアカウントは本人の同意で組織へ移す。SCIM 2.0 は SSO の後に足す | accepted |
| [0037](0037-admin-roles-delegation-and-event-access.md) | 管理の役割を 6 つにし、`super_admin` 以外はグループの範囲に委任できる。役割は予定の中身を見る権限を含まない。管理者による従業員の予定の閲覧は、法務の L8 の結論までフラグの裏に置き、理由と期間を書いた閲覧の許可・`can()` の入力・監査ログの記録の仕組みだけを作る | accepted |
| [0038](0038-web-calendar-rendering-and-local-expansion.md) | Web の画面は、予定オブジェクトを窓つきの差分の同期で持ち、回は手元の `expand()` で作る。tzdb はサーバーの版のゾーンのデータを版つきの URL から取る。重なる予定は、日ごとの重なりの塊に貪欲に列を割り当てて右へ広げる決定的な配置で描く | accepted |
| [0039](0039-offline-read-cache-and-local-data.md) | Web の画面のオフラインは読み出しだけにし、アカウントごとの IndexedDB に前後 4 週の予定オブジェクトとトークンとゾーンのデータを持つ。手元の DB は捨ててよい写しとし、版が変われば作り直す。ログアウト・セッションの取り消し・30 日の不使用で消し、共有の端末では保存しない | accepted |
| [0040](0040-untrusted-calendar-input-gate.md) | 外から来る iCalendar・メール・URL は、経路ごとの上限の表を解析の前に当て、時間とメモリーを切った隔離の worker thread で `packages/ical` を動かし、正規化した形だけを `packages/writer` に渡す。外へ出す iCalendar とメールのヘッダーは、利用者の文字を必ずエスケープして作る | accepted |
| [0041](0041-encryption-keys-and-secret-storage.md) | 保存時の暗号化は、データの種類ごとの KMS の鍵（マルチリージョン）で行い、テナントごとの鍵と予定の項目の暗号化は持たない。本システムの秘密は、受け取って照らすだけのもの（アプリ用のパスワード、トークン、ICS の秘密のアドレス）を SHA-256 の照合の値で、平文が要るもの（Webhook の署名の秘密、同期のトークンの鍵、VAPID の鍵）を封筒の暗号化で持ち、平文で DB に置かない | accepted |
| [0042](0042-audit-log-and-data-lifecycle.md) | 監査ログは、テナントの監査（Aurora、既定 1 年）とプラットフォームの監査に分け、どちらも log-archive へハッシュの連鎖つきで写す。変更のログを監査ログの代わりにしない。保持の期間を 1 つの表（`retention_policies`）で持ち、時間で消えるものは分割を落とし、テナントの解約は 30 日の猶予の後に `tenant_id` で消す。値は法務の L5 の後に確定する | accepted |
| [0043](0043-accounts-network-ingress-and-service-placement.md) | AWS のアカウントとネットワークは他の題材の形を引き継ぐ。画面・API・予約ページは CloudFront を通し、CalDAV は WebDAV のメソッドを通すため CloudFront を通さず WAF つきの ALB で受ける。iMIP は東京の SES の受信を主、大阪を副の MX にする。利用者の決める宛先（ICS の購読、Webhook）は egress の経路から、Web Push は配信のサービスの許可リストだけへ出す | accepted |
| [0044](0044-disaster-recovery-and-calendar-side-effects.md) | リージョンの障害は大阪のウォームスタンバイへ人の判断で切り替え、書き込みを止めてから昇格し、`sync_epoch` を上げる。失った範囲の外への副作用は、外部への iMIP の次の送信で `SEQUENCE` を 1 つ余分に上げること、リマインダーの送信の重複を数えて SLO から分けること、で扱う | accepted |
| [0045](0045-stage-up-criteria-tenant-sharding-and-cells.md) | 段階を上げる判断は、ピークの書き込みと読み出し、Aurora の writer の CPU、配送の遅れ、リマインダーの集中の指標で行う。S2 はテナントを単位に Aurora のクラスタへ分け、テナントの外のディレクトリ（テナント → クラスタ、メールアドレス → アカウント）を小さなクラスタに置く。テナントをまたぐ処理は、内部の iTIP を SQS、空き時間を内部の RPC にする。S3 はスタックをセルにし、テナントをセルとリージョンに固定する | accepted |
| [0046](0046-sli-from-ledgers-and-delivery-tracing.md) | 正しさと遅れの SLI は、トレースの抜き取りではなく、業務の記録（リマインダーの送信の記録、配送の記録、iMIP の送信の記録、トークンの使用の記録）から全件で数える。リマインダーの遅れは「回の通知の時刻」から「送信の開始」までにし、送らなかったものと遅れすぎたものを悪いイベントに数える。招待は `msg_id` を主催者のコミットから参加者の写し・iMIP・SES の事象まで運んで結ぶ | accepted |
| [0047](0047-time-shaped-capacity-and-calendar-write-admission.md) | 負荷のモデルは時刻の形（月曜の朝、毎時 0 分・30 分の前後、年度の始め）を持ち、反応のオートスケールに頼らず、時刻で先に広げる。リマインダーは数分前に送る準備を済ませて時刻に放つ。1 カレンダーの書き込みは `origin` ごとの枠で割り当て、利用者の書き込みを最優先にし、tzdb の再計算・配送・取り込みを後にする | accepted |
| [0048](0048-ci-gates-and-caldav-client-compatibility.md) | CI の関門は変更のパスで足し、外すラベルを持たない。展開と参照の性質ベーステスト、tzdb の版の差分、`redact()` の経路の性質、記録した CalDAV・iMIP の通信の再生を PR の必須にする。CalDAV のクライアントとの互換は、PR の再生、夜間の実物のクライアントの試験場（macOS・iOS のシミュレーター・Android のエミュレーター）、リリースの前の手動の表の 3 段で確かめる | accepted |
| [0049](0049-tzdata-rollout-and-schema-change-ordering.md) | tzdb の新しい版は、前の版と一緒にイメージに入れて先にデプロイし、AppConfig の `tzdata.active_version` を全サービスで一度に切り替えて採用する。Web のクライアントは版つきの URL からゾーンのデータを取るので、資産のデプロイを待たない。スキーマの変更は、広げる・移る・縮める・消すの順にし、展開の索引のような作り直せる表は、影の表を作って入れ替える | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

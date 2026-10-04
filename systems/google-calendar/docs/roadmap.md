# Roadmap: Google Calendar

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E3 で、`packages/writer`・変更のログ・展開の索引・`packages/recurrence`・`packages/tz` を端から端まで貫き、繰り返しの予定を API で作って、Web の画面と CalDAV のクライアントの両方で同じ回が同じ時刻に出るところまで作ってから、機能を広げる。参照との性質ベーステスト、tzdb の版の差分の試験、FORCE RLS、変更のログを通らない書き込みの禁止は、E1〜E3 から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E2 の前：展開の索引の行の数と書き込みの量（`occurrence-index-poc`）、1 カレンダーの書き込みの上限（`calendar-write-throughput-poc`。1 秒 50 件）、参照の実装の選定（`recurrence-reference-survey`）。
  - E6 の前：会議室の排他の制約の書き込みの速さ（`room-exclusion-poc`）、空き時間のキャッシュの形と 50 人＋会議室 20 の探索の速さ（`freebusy-poc`）。
  - E9 の前：リマインダーの集中（毎時 0 分）での分の桶とタイマーホイールの速さ（`reminder-burst-poc`）。
- **規則は 1 つのコードに。** 展開は `packages/recurrence`、時刻は `packages/tz`、権限は `packages/policy`、書き込みは `packages/writer`、iTIP の当て方は `packages/itip` にだけ書く。
- **契約を先に固定する。** 予定オブジェクトの形、変更のログとトークンの形、`redact()` の決定表、公開 API の形、Webhook のヘッダーは、人間がレビューして確定する。エージェントは勝手に変えない。
- **法務の確認待ちの Story は、spec を承認しない。** 設計と、法務に依らない Story は進めてよい（[intent.md](intent.md) の「法務の確認待ち」L1〜L10）。下の表で「法務：L*」と書いた Story が当たる。
- **相互運用は早く確かめる。** CalDAV のクライアントと外部のカレンダーとの往復を、E2 の終わりから記録して再生する。E8・E5 の終わりで手動の確認の表を通す。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。各 Epic の品質の重点と合否基準は [quality.md](quality.md) の 5 節にある。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 基盤 | AWS・Terraform・CI（3 つの `TZ`、性質ベーステストの枠）、Aurora と RLS、`packages/writer` と変更のログの骨格、フラグ、可観測性、監査ログ、大阪の骨格 | 設計中 |
| E2 予定と繰り返しの核 | 予定オブジェクト、`packages/ical`、`packages/recurrence`、例外と「これ以降」、展開の索引、参照との性質ベーステスト | 未着手（前に索引・書き込み・参照の PoC） |
| E3 タイムゾーンと祝日 | `packages/tz`・`packages/tzdata`、tzdb の版の更新の流れと再計算、浮動・終日、日本の祝日のカレンダー | 未着手（祝日のカレンダーの公開は法務：L7） |
| E4 アカウント・組織・共有 | 個人と組織、SSO・SCIM、ディレクトリ、カレンダー、ACL と公開範囲、`can()`・`redact()`、組織の共有の方針 | 未着手 |
| E5 招待と出欠 | 参加者の写し、内部の iTIP の配送、出欠、グループの招待、写しの照合、iMIP の送受信 | 未着手（外部への iMIP は法務：L1・L2・L3） |
| E6 空き時間と会議室 | 空き時間の照会と候補の計算、会議室のディレクトリと自動の承諾、排他の制約 | 未着手（前に会議室と空き時間の PoC） |
| E7 Web の画面 | 日・週・月・予定リスト、ドラッグ、タイムゾーンの表示、IME、オフラインの閲覧、PWA | 未着手（画面の寄せ方は法務：L10、分析の計測は法務：L2） |
| E8 同期と API | 変更のログと同期のトークン、Realtime、公開 API、OAuth、Webhook、CalDAV、ICS の購読・公開・取り込み・書き出し | 未着手（変更のログの保持の確定は法務：L5） |
| E9 リマインダーと通知 | リマインダーの時計、送信の記録、画面の通知・Web Push・メール、招待の通知、毎朝の一覧 | 未着手（前に集中の PoC。Web Push とメールは法務：L1・L4） |
| E10 予約ページ | 予約ページの設定、枠の計算、予約と取り消し、予約者の確認、ボットの対策 | 未着手（公開は法務：L3・L6） |
| E11 検索・管理・監査 | 検索の表と `pg_bigm`、管理の画面、監査ログの画面と書き出し | 未着手（管理者の閲覧は法務：L8） |
| E12 本番の準備と GA の判定 | 負荷試験、リマインダーの集中の試験、tzdb の更新の訓練、DR の訓練、相互運用の受け入れ試験、外部のペンテスト、GA の判定 | 未着手（GA の判定は法務：L1・L4・L5・L9） |
| E13 ネイティブのモバイルのアプリ（MVP の後） | iOS・Android、オフラインの書き込み、ネイティブの Push | 未着手（MVP の後） |
| E14 タスク（MVP の後） | タスクのモデル、カレンダーへの表示、CalDAV の VTODO | 未着手（MVP の後） |
| E15 予約の拡張（MVP の後） | 有料の予約、複数の主催者の順番の割り当て | 未着手（MVP の後。法務：L6） |
| E16 会議と日程の提案（MVP の後） | ビデオ会議の発行、時刻の提案（`COUNTER`）、AI の日程の提案 | 未着手（MVP の後） |
| E17 他社との連携と移行（MVP の後） | 他社のカレンダーとの空き時間の相互の照会、一括の移行 | 未着手（MVP の後。法務：L3） |
| E18 海外のリージョン（MVP の後） | テナントをリージョンに固定する、S3 のセル | 未着手（MVP の後。法務：L4） |

E1〜E12 が MVP（S1）。領域の文書の「Story の候補」は、この番号で書く。

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。領域の文書（[architecture/README.md](architecture/README.md) の 7 節）を書くときに、各領域の「Story の候補」で直す。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Google Calendar の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`packages/recurrence`・`tz`・`tzdata`・`policy`・`writer` はテックリード）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント、SCP、VPC、egress の専用の経路（ICS の購読・Webhook の送信）。データの所在の約束は法務：L4 |
| `edge-and-waf` | CloudFront、WAF（API・CalDAV・予約ページで規則を分ける）、ドメイン（`calendar.<brand>.<domain>` など） |
| `ecs-services-skeleton` | API・CalDAV・Realtime・Booking・Auth・Relay・Worker のサービスとロール |
| `terraform-root-modules` | ルートモジュールとポリシーの検査 |
| `aurora-rls-baseline` | テナントの RLS、`SET LOCAL`、RLS の検査、テナントをまたぐ専用のロールと関数の許可リスト（ADR-0004） |
| `writer-and-change-log-skeleton` | `packages/writer`、カレンダーの `change_seq`、`calendar_changes`、outbox、ログを通らない書き込みの DB の権限での禁止（ADR-0005） |
| `ci-pipeline-baseline` | PR の関門、3 つの `TZ` での実行、性質ベーステストの枠、テストの緩和の検出、本番の依存の禁止の一覧（ADR-0001） |
| `flags-appconfig` | `release.*`・`ops.*` のフラグ |
| `otel-baseline` | ADOT、AMP、X-Ray、ログの形、予定の中身をログに出さない規則と走査 |
| `audit-log-table-and-archive` | 監査ログの表と、S3 の Object Lock への写し |
| `osaka-warm-standby` | 大阪の骨格、Aurora Global Database |

### E2 予定と繰り返しの核

| Story | 内容 |
| --- | --- |
| `occurrence-index-poc` | PoC：展開の索引の範囲（過去 31 日から未来 548 日）での行の数、書き込みの量、範囲の端の毎日の維持の時間 |
| `calendar-write-throughput-poc` | PoC：1 カレンダー 1 秒 50 件、ロックの待ちの p99 |
| `recurrence-reference-survey` | 参照の実装の候補の比べと選定、食い違いの許可リストの形 |
| `ical-parser-writer` | `packages/ical`：行の折り返し、エスケープ、VTIMEZONE、知らないプロパティの保存、上限（ADR-0007） |
| `event-object-model` | 予定オブジェクトとマスター・上書き、版、時刻の種類の列（ADR-0002・0003） |
| `recurrence-expand` | `packages/recurrence` の `expand()`（RRULE・RDATE・EXDATE・上書き）と受け付けの検査 |
| `recurrence-reference-prop-tests` | 参照との性質ベーステストの枠、生成器、回帰のシード（quality.md の 2.2.1 節 A） |
| `occurrence-index` | 展開の索引の表、分割、書き込みでの作り直し、範囲の端の維持、本番の照合 |
| `single-instance-exceptions` | 1 回分の変更・取り消し |
| `this-and-following-split` | 「これ以降」の分割、上書きと EXDATE の移動 |
| `events-rest-basic` | 予定の作成・取得・変更・削除・範囲の一覧の API（招待なし） |

### E3 タイムゾーンと祝日

| Story | 内容 |
| --- | --- |
| `tzdata-package` | IANA の tzdb を zic で遷移の表にし、版を固定する。Web のクライアントへのゾーンごとの配布 |
| `tz-resolve` | `packages/tz` の `resolve`・`toLocal`、存在しない時刻・2 回ある時刻（ADR-0002） |
| `floating-and-all-day` | 浮動と終日の派生の値、カレンダーのタイムゾーンの変更での作り直し |
| `tzid-aliases-and-windows-zones` | 別名、Windows のゾーン名、独自の VTIMEZONE の対応付け |
| `tzdata-diff-report` | 版の差分の報告を CI で作る（quality.md の 2.2.1 節 B） |
| `tzdata-recompute-job` | 再計算のジョブ（索引、会議室の予約、リマインダー、変更のログ）、施行の近い順 |
| `tzdata-version-tests` | 過去の改正の集まりと合成の改正の試験 |
| `japanese-holidays-calendar` | 祝日の法の規則からの生成、内閣府の CSV との照合、システムの公開のカレンダー。公開は法務：L7 |
| `wareki-display` | 和暦の表示の書式 |

### E4 アカウント・組織・共有

| Story | 内容 |
| --- | --- |
| `personal-accounts` | 個人のアカウントと個人のテナント、ログイン |
| `orgs-and-domains` | 組織、ドメインの確認、個人から組織への移り |
| `sso-saml-oidc` | SAML・OIDC の SSO |
| `scim-provisioning` | SCIM の利用者とグループの同期 |
| `directory-users-groups` | 組織のディレクトリ（利用者、グループ） |
| `calendars-crud` | 主のカレンダー、追加のカレンダー、共有のカレンダー、既定のタイムゾーン |
| `policy-can-redact` | `packages/policy` の `can()`・`redact()` と決定表（ADR-0004） |
| `calendar-acl` | ACL のロールと主体、共有の画面と API |
| `event-visibility` | 予定の公開範囲、繰り返しの 1 回の公開範囲の扱い |
| `org-sharing-policy` | 組織の外への共有の方針、方針の変更での ACL の無効化 |
| `leak-path-tests` | 漏れの経路の表の結合テスト（quality.md の 2.2.1 節 D） |

### E5 招待と出欠

| Story | 内容 |
| --- | --- |
| `attendee-copies` | 参加者の写しと、共有の項目の書き込みの拒否（ADR-0006） |
| `itip-internal-delivery` | 内部の iTIP のメッセージ、`itip-delivery`、`SEQUENCE`・`DTSTAMP` の判定 |
| `rsvp-and-replies` | 出欠とコメント、`REPLY`、出欠の一覧のまとめた配送 |
| `guest-permissions` | 参加者の権限（他の参加者を見る・招待する・変更する） |
| `group-invites` | グループの招待、展開、グループの変更の未来の予定への反映 |
| `organizer-change` | 主催者の変更 |
| `copy-reconciliation` | 写しの照合のジョブ |
| `itip-delivery-simulator` | 配送のシミュレーター（quality.md の 2.2.1 節 C） |
| `imip-outbound` | iMIP の送信（SES）、送信元のドメインの認証。法務：L1・L2・L3 |
| `imip-inbound` | SES の受信、返事の照合の鍵、送信元の認証、外部からの招待の取り込み |
| `invite-spam-controls` | 迷惑な招待の対策（知らない送信元の招待の扱い、送信の上限） |

### E6 空き時間と会議室

| Story | 内容 |
| --- | --- |
| `freebusy-poc` | PoC：空き時間のキャッシュの形、50 人＋会議室 20 の探索 |
| `room-exclusion-poc` | PoC：排他の制約の書き込みの速さ、繰り返しの予約 |
| `freebusy-query` | 空き時間の照会（人・グループ・会議室）、テナントをまたぐ照会の関数 |
| `find-a-time` | 複数の人と会議室の候補の計算、勤務の時間の考慮 |
| `rooms-directory` | 建物・階・定員・設備の属性、会議室のカレンダー |
| `room-booking-exclusion` | 会議室の予約の行と排他の制約、自動の承諾、繰り返しの一部の辞退 |
| `room-approval` | 管理者の承認の会議室 |
| `room-concurrency-tests` | 並行の予約の試験（quality.md の 2.2.1 節 E） |

### E7 Web の画面

| Story | 内容 |
| --- | --- |
| `web-shell` | 画面の骨格、ルーティング、認証 |
| `calendar-views` | 日・週・月・予定リスト、複数のカレンダーの重ね表示 |
| `drag-create-move` | ドラッグでの作成・移動・長さの変更、楽観的な描画 |
| `event-editor` | 予定の編集（繰り返し、例外、「これ以降」の選び方、タイムゾーン） |
| `timezone-display` | 表示のタイムゾーン、2 つ目のタイムゾーン、移動の予定 |
| `ime-guard` | IME の変換の途中の `Enter` の抑止 |
| `keyboard-shortcuts` | キーボードの操作。画面の寄せ方は法務：L10 |
| `offline-read-cache` | 最近の範囲の IndexedDB のキャッシュとオフラインの閲覧 |
| `pwa-install` | PWA |

### E8 同期と API

| Story | 内容 |
| --- | --- |
| `sync-tokens` | 同期のトークン（署名、`filter_hash`・`view_hash`・`epoch`）、差分の応答、410・400（ADR-0005） |
| `change-log-retention` | ログの日の分割と保持、`floor_seq`。保持の期間は法務：L5 |
| `realtime-gateway` | WebSocket の合図、再接続と取り戻し |
| `public-rest-api` | 公開 API の形、ページング、条件つきの更新、エラー |
| `oauth-apps-and-scopes` | OAuth 2.0 のアプリとスコープ、レート制限 |
| `webhook-channels` | Webhook の通知の経路、期限、署名、まとめ、再試行 |
| `caldav-discovery-and-propfind` | 発見、`PROPFIND`、主体とホームのコレクション |
| `caldav-calendar-resources` | 予定オブジェクトのリソース、`GET`・`PUT`・`DELETE`、ETag、`If-Match` |
| `caldav-reports-and-sync` | `calendar-query`・`calendar-multiget`・`sync-collection`、CTag |
| `caldav-implicit-scheduling` | CalDAV からの暗黙のスケジュール |
| `caldav-app-passwords` | CalDAV のアプリ用のパスワード |
| `ics-subscribe` | ICS の購読（egress、条件つきの取得、上限、SSRF の対策） |
| `ics-publish` | ICS の公開（秘密のアドレス、公開のアドレス） |
| `ics-import-export` | ICS の取り込みと書き出し |
| `interop-replay-harness` | CalDAV・iMIP の記録した通信の再生（quality.md の 2.2.1 節 H） |

### E9 リマインダーと通知

| Story | 内容 |
| --- | --- |
| `reminder-burst-poc` | PoC：毎時 0 分の集中での分の桶とタイマーホイール |
| `reminder-buckets` | 分の桶の表、展開の索引からの作成、予定の変更での付け替えと版 |
| `reminder-timer-wheel` | シャードごとのタイマーホイール、交代 |
| `reminder-delivery-ledger` | 送信の記録と重複の除去、遅れすぎたものの扱い |
| `web-push` | Web Push の登録と送信。法務：L1・L4 |
| `email-notifications` | リマインダー・招待・変更・返事のメール。法務：L1・L3 |
| `in-app-notifications` | 画面の通知 |
| `daily-agenda-email` | 毎朝の予定の一覧 |
| `reminder-fault-tests` | 時計の試験と障害の注入（quality.md の 2.2.1 節 F） |

### E10 予約ページ

| Story | 内容 |
| --- | --- |
| `booking-page-settings` | 長さ、間の時間、1 日の上限、受け付けの期間、場所 |
| `booking-slot-calculation` | 空き時間と規則からの枠の計算 |
| `booking-create-cancel` | 予約の作成（並行での二重の予約の防止）と取り消し |
| `booking-confirmation` | 予約者のメールの確認、確認のメール。法務：L3・L6 |
| `booking-bot-protection` | ボットの対策とレート制限 |

### E11 検索・管理・監査

| Story | 内容 |
| --- | --- |
| `search-table-pg-bigm` | `redact()` の後の検索の表、`pg_bigm` の索引、更新の遅れの計測 |
| `search-api-and-ui` | 検索の API と画面 |
| `admin-console` | 管理の画面（利用者、グループ、会議室、方針） |
| `admin-event-access` | 管理者の予定の閲覧と記録。法務：L8 |
| `audit-log-ui-export` | 監査ログの画面と書き出し |
| `data-lifecycle` | 削除、解約したテナントのデータの削除。保持は法務：L5 |

### E12 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `load-tests` | 書き込み、空き時間の探索、CalDAV のポーリング、配送 |
| `reminder-burst-load` | リマインダーの集中の負荷 |
| `tzdata-update-drill` | tzdb の更新の訓練（合成の改正を本番と同じ構成の環境で） |
| `dr-failover-drill` | 大阪への切り替えの訓練、`sync_epoch` の更新 |
| `interop-acceptance` | 相互運用の手動の確認の表（K9） |
| `pentest-external` | 外部のペンテスト（iMIP、CalDAV、ICS、予約ページ） |
| `slo-dashboards-alerts` | SLO とアラート（[runbooks/README.md](runbooks/README.md)） |
| `runbooks-e12` | 個別の手順の作成と確認 |
| `ga-readiness` | GA の判定。法務：L1・L4・L5・L9 |

## エージェントに任せないこと

- **契約（予定オブジェクトの形、変更のログとトークンの形、`redact()` の決定表、公開 API の形、Webhook のヘッダー）の確定**：クライアントと外部に配った後に変えるコストが最も高い。
- **参照との食い違いの許可リストへの追加**：QA が判断する。
- **tzdb の版の採用の判断**：差分の報告を見て Dev と Ops が判断する。施行の日が近い改正の急ぎの採用も同じ。
- **会議室の重なりや写しの食い違いを直すための、データの直接の書き換え**：Dev のテックリードと Ops が判断し、`packages/writer` を通す。
- **大阪への切り替えの判断、`sync_epoch` の更新**：IC と Ops の責任者。
- **法務の判断**（L1〜L10）。
- **負荷試験・PoC の結果の解釈**：数字は出せるが、上限・範囲・退路の採否は Dev と PM の判断。

## 延期の一覧

MVP の後に検討する。E13〜E18 に入れなかったもの。着手するときに `intent.md` から起票する。

- **勤務の場所、勤務の時間の詳細、「集中の時間」の自動の辞退**（intent.md）。
- **時刻の提案（`COUNTER`）**、`RANGE=THISANDFUTURE` の受け付け（[ADR-0003](decisions/0003-recurrence-storage-and-expansion.md)、[ADR-0007](decisions/0007-interop-standards-scope.md)）。
- **CalDAV の代理（proxy）の拡張、`free-busy-query`**（ADR-0007）。
- **Web の画面のオフラインの書き込み**（[architecture/README.md](architecture/README.md) の 6 節）。
- **S2 の構成**（テナントのシャード、検索の専用の基盤）と **S3 のセル構成**（infrastructure の領域）。

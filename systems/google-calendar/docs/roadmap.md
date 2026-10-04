# Roadmap: Google Calendar

## 進め方の原則

- **最初に walking skeleton を通す。** E1〜E3 で、`packages/writer`・変更のログ・展開の索引・`packages/recurrence`・`packages/tz` を端から端まで貫き、繰り返しの予定を API で作って、Web の画面と CalDAV のクライアントの両方で同じ回が同じ時刻に出るところまで作ってから、機能を広げる。参照との性質ベーステスト、tzdb の版の差分の試験、FORCE RLS、変更のログを通らない書き込みの禁止は、E1〜E3 から本物の形で作る。後から足すと直せないため。
- **PoC を先に済ませる。** 次の PoC は、それぞれの Epic の Story の spec を承認する前に結果を記録する。
  - E2 の前：展開の索引の行の数と書き込みの量（`occurrence-index-poc`）、1 カレンダーの書き込みの上限（`calendar-write-throughput-poc`。1 秒 50 件）、参照の実装の選定（`recurrence-reference-survey`）。
  - E6 の前：会議室の排他の制約の書き込みの速さ（`room-exclusion-poc`）、空き時間のキャッシュの形と 50 人＋会議室 20 の探索の速さ（`freebusy-poc`）。
  - E9 の前：リマインダーの集中（毎時 50 分 00 秒の約 12 万件）での計画の表とタイマーホイールの速さ（`reminder-burst-poc`）。
  - E11 の前：`pg_bigm` の索引の大きさと更新の量（`search-bigm-poc`）。
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
| E4 アカウント・組織・共有 | 個人と組織、SSO、ディレクトリ、カレンダー、ACL と公開範囲、`can()`・`redact()`、組織の共有の方針、委任。最後に SCIM（MVP） | 未着手（個人から組織への移りの同意の文面は法務：L1） |
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

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。統合の工程（2026-10-04）で、各領域の文書の「Story の候補」をここに反映した。「中身」の列の文書が、その Story の設計の正本である。

### E1 基盤

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Google Calendar の再構築の開発リポジトリを作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、CODEOWNERS（`packages/recurrence`・`tz`・`tzdata`・`policy`・`writer`・`itip`・`ingress-limits` はテックリード、`tzdata` は Ops も）を置く（リポジトリ共通の ADR-0005） |
| `aws-accounts-and-network` | アカウント、SCP、VPC、egress のサブネット、Network Firewall、VPC エンドポイント（[infrastructure.md](architecture/infrastructure.md) の 1・2 節）。データの所在の約束は法務：L4 |
| `edge-and-waf` | CloudFront の配信（`calendar`・`api`・`auth`・`book`・`ics`）、WAF、ホスト名、`/tzdata/` の振り分け |
| `caldav-ingress` | `alb-dav` と ALB の WAF（IP の集合）、SRV・TXT、`/.well-known/caldav`（ADR-0043） |
| `ecs-services-skeleton` | API・CalDAV・Realtime・Booking・Auth・Relay・Worker のサービスとロール |
| `terraform-root-modules` | ルートモジュールとポリシーの検査 |
| `aurora-rls-baseline` | テナントの RLS、`SET LOCAL`、RLS の検査、テナントをまたぐ経路の許可リスト（X1〜X9）と RLS の外の表の一覧の CI の照合（ADR-0004） |
| `writer-and-change-log-skeleton` | `packages/writer`、カレンダーの `change_seq`、`calendar_changes`、outbox、ログを通らない書き込みの DB の権限での禁止、番号の欠けの監視（ADR-0005） |
| `ci-pipeline-baseline` | PR の関門、パスでの関門の追加、3 つの `TZ`、性質ベーステストの枠、テストの緩和の検出、本番の依存の禁止の一覧（ADR-0001、ADR-0048） |
| `flags-appconfig` | `release.*`（kebab-case）・`ops.*`（snake_case）、`tzdata.active_version` の検証の関数、東京と大阪、長く残すフラグの週次の検査 |
| `web-cohort-rollout` | CloudFront Functions と KeyValueStore での Web の段階的な切り替え、`<Brand>-Client-Min` |
| `otel-baseline` | ADOT、AMP、X-Ray、ログの形、予定の中身をログに出さない規則と秘密の走査 |
| `slo-aggregator` | 業務の記録からの SLI の集計（ADR-0046） |
| `slo-dashboards-alerts` | SLO、アラート（runbook の URL つき）、ダッシュボード（[runbooks/README.md](runbooks/README.md)、[observability.md](architecture/observability.md) の 5・7 節） |
| `kms-keys-and-policies` | データの種類ごとの KMS の鍵、マルチリージョン（ADR-0041） |
| `secret-storage` | 照合の値と封筒の暗号化、接頭辞とシークレットスキャンの登録（ADR-0041） |
| `audit-log-table-and-archive` | 監査ログの表と、log-archive の Object Lock へのハッシュの連鎖つきの写し（ADR-0042） |
| `osaka-warm-standby` | 大阪の骨格、Aurora Global Database、待機の構成の確認 |

### E2 予定と繰り返しの核

| Story | 内容 |
| --- | --- |
| `occurrence-index-poc` | PoC：展開の索引の範囲（過去 31 日から未来 548 日）での行の数、書き込みの量、範囲の端の毎日の維持の時間 |
| `calendar-write-throughput-poc` | PoC：1 カレンダー 1 秒 50 件、ロックの保持の時間と待ちの p99 |
| `recurrence-reference-survey` | 参照の実装の候補の比べと選定、存在しない時刻・DTSTART の扱いの違い、食い違いの許可リストの形 |
| `ical-parser-writer` | `packages/ical`：行の折り返し、エスケープ、VTIMEZONE、知らないプロパティの保存、上限（ADR-0007） |
| `ingress-limits` | 上限の表、隔離の worker thread、DT-SEC-001（ADR-0040） |
| `ical-escaping` | 書き出しのエスケープとメールのヘッダー（PROP-SEC-001・002） |
| `event-object-model` | 予定オブジェクトとマスター・上書き、版、時刻の種類の列、予定の種類、`detached_fields` |
| `recurrence-validate` | 受け付けの検査と上限（DT-REC-001） |
| `recurrence-expand` | `packages/recurrence` の `expand()`（ADR-0008） |
| `recurrence-reference-prop-tests` | 参照との性質ベーステストの枠、生成器、回帰のシード（PROP-REC-001・005・008） |
| `prop-tests-in-ci` | 性質ベーステストと回帰のシードを PR・夜間の CI に入れる |
| `occurrence-index` | 展開の索引の表、差分の書き込み、範囲の端の維持、本番の照合（ADR-0010。PROP-REC-002） |
| `occurrence-reconciliation-metrics` | 照合の指標（理由のコードごと） |
| `single-instance-exceptions` | 1 回分の変更・取り消し（PROP-REC-004） |
| `this-and-following-split` | 「これ以降」の分割、上書きと EXDATE の移動（PROP-REC-003） |
| `series-edit-rebasing` | 系列の全体の変更と上書きの付け替え（ADR-0009。DT-REC-002、PROP-REC-006） |
| `inbound-recurrence-normalization` | 対応しない繰り返しの入力の正規化（ADR-0011。DT-REC-003） |
| `calendar-write-admission` | `origin` ごとの書き込みの枠と混雑の制御（ADR-0047） |
| `events-rest-basic` | 予定の作成・取得・変更・削除・範囲の一覧の API（招待なし） |

### E3 タイムゾーンと祝日

| Story | 内容 |
| --- | --- |
| `tzdata-package` | IANA の tzdb を zic で遷移の表にし、版を固定する。別名と `windowsZones`。署名の鍵の指紋の固定。Web のクライアントへのゾーンごとの配布 |
| `tz-resolve` | `packages/tz` の `resolve`・`toLocal`、存在しない時刻・2 回ある時刻（PROP-TZ-001） |
| `floating-and-all-day` | 浮動と終日の派生の値、カレンダーのタイムゾーンの変更での作り直し |
| `tzid-aliases-and-windows-zones` | 外から来る TZID の 7 段の解き方（ADR-0013。DT-TZ-001、PROP-TZ-005） |
| `vtimezone-export` | VTIMEZONE の書き出し |
| `tzdata-diff-report` | 版の差分の報告を CI で作る |
| `tzdata-watch-and-rollout` | `tzdata-watch`、署名の確かめ、差分の報告の PR、`/tzdata/<version>/` の配置 |
| `tzdata-runtime-switch` | AppConfig の `tzdata.active_version` の切り替え、`tzdata_active_version` の報告、切り替えの完了の判定（ADR-0049） |
| `tzdata-recompute-job` | 再計算のジョブ（会議室の予約の行を先に、施行の近い順）、切り替えの窓、`conflict_tz_pending` の判定し直し（ADR-0012。DT-TZ-002、PROP-TZ-002〜004） |
| `tzdata-version-telemetry` | 古い版の行、版の不一致、未採用の指標 |
| `tzdata-external-update` | 外部の参加者への同じ `SEQUENCE` の `REQUEST` |
| `room-needs-review` | tzdb の計算し直しでの会議室の要確認（ADR-0020。PROP-ROOM-004） |
| `tzdata-version-tests` | 過去の改正の集まりと合成の改正の試験 |
| `japanese-holidays-calendar` | 祝日の法の規則からの生成、内閣府の CSV との照合、システムの公開のカレンダー（PROP-TZ-006）。公開は法務：L7 |
| `wareki-display` | 和暦の表示の書式 |

### E4 アカウント・組織・共有

| Story | 内容 |
| --- | --- |
| `personal-accounts` | 個人のアカウントと個人のテナント、ログイン、セッション（ADR-0035） |
| `orgs-and-domains` | 組織、ドメインの確認、個人から組織への移り（ADR-0036。DT-ACCT-004、PROP-ACCT-002）。移りの同意の文面は法務：L1 |
| `sso-saml-oidc` | SAML・OIDC の SSO（DT-ACCT-001） |
| `org-auth-policy` | 組織の認証の方針 |
| `directory-users-groups` | 組織のディレクトリ（利用者、グループ）、メールアドレスの解決 |
| `calendars-crud` | 主のカレンダー、追加のカレンダー、共有のカレンダー、既定のタイムゾーン |
| `policy-can-redact` | `packages/policy` の `can()`・`redact()` と決定表（ADR-0021。DT-ACL-001・002、PROP-ACL-001・004） |
| `calendar-acl` | ACL のロールと主体、実際のロールの求め方（DT-ACL-003、PROP-ACL-002） |
| `event-visibility` | 予定の公開範囲、繰り返しの 1 回の公開範囲の扱い（PROP-ACL-005） |
| `org-sharing-policy` | 組織の外への共有の方針、方針の変更での ACL の無効化（PROP-ACL-003） |
| `delegation` | 代理の人と `SENT-BY`（ADR-0022） |
| `cross-tenant-shared-writes` | 共有のカレンダーへのテナントをまたぐ書き込み（ADR-0004 の X4。`release.cross-tenant-shared-writes`。有効にするのはテックリードの確認の後） |
| `leak-path-tests` | 漏れの経路の表の結合テスト（[quality.md](quality.md) の 2.2.1 節 D） |
| `redact-response-audit` | 応答の監査（[observability.md](architecture/observability.md) の 4 節） |
| `scim-provisioning` | **E4 の最後。** SCIM の利用者とグループの同期（SSO の後。`release.scim` の裏で出し、GA の前に消す。ADR-0036） |

### E5 招待と出欠

| Story | 内容 |
| --- | --- |
| `attendee-copies` | 参加者の写しと状態、共有の項目の書き込みの拒否（ADR-0006） |
| `itip-internal-delivery` | 内部の iTIP のメッセージ、`itip-delivery`、状態の転送と新旧の判定（ADR-0014。DT-ITIP-001・002、PROP-ITIP-001・003） |
| `rsvp-and-replies` | 出欠とコメント、回ごとの出欠、出欠を戻す（PROP-ITIP-002） |
| `guest-permissions` | 参加者の権限と `X-MODIFY`（PROP-ITIP-005） |
| `group-invites` | グループの招待、展開、メンバーの変化の未来の予定への反映（ADR-0016） |
| `organizer-change` | 主催者の変更 |
| `copy-reconciliation` | 写しの照合のジョブ |
| `itip-delivery-simulator` | 配送のシミュレーター（PROP-ITIP-001〜004） |
| `itip-delivery-tracing` | `msg_id` の運び、`itip_deliveries`、運用の画面「招待の追跡」 |
| `imip-outbound` | iMIP の送信（SES）、受け口のアドレス、送信元のドメインの認証（ADR-0015）。法務：L1・L2・L3 |
| `imip-inbound` | SES の受信、返事の照合と送信元の確かめ、外部からの招待の取り込み（DT-ITIP-003、PROP-ITIP-006） |
| `ses-inbound-dual-region` | 東京を主・大阪を副の MX、`imip-inbound-relay` |
| `ses-event-ingest` | SES の構成セットの事象の取り込み |
| `invite-intake-policy` | 招待の取り込みの方針（DT-ITIP-004） |
| `invite-spam-controls` | 送信の上限、抑止の一覧、迷惑な招待の報告と自動の停止。法務：L2・L3 |

### E6 空き時間と会議室

| Story | 内容 |
| --- | --- |
| `freebusy-poc` | PoC：空き時間のキャッシュの形、50 人＋会議室 20 の探索、冷たいキャッシュ |
| `room-exclusion-poc` | PoC：排他の制約の書き込みの速さ、繰り返しの予約、会議室の行のロックの時間 |
| `freebusy-query` | 空き時間の照会（DT-FB-001・002、PROP-FB-001・002・004） |
| `freebusy-cross-tenant` | `freebusy_for`（ADR-0017、ADR-0004 の X2） |
| `freebusy-cache` | 番号で確かめるキャッシュ（PROP-FB-003） |
| `find-a-time` | 候補の計算（ADR-0018。PROP-FB-005） |
| `working-hours` | 勤務の時間の設定と祝日 |
| `rooms-directory` | 建物・階・定員・設備の属性、会議室のカレンダー |
| `room-booking-exclusion` | 会議室の予約の行と排他の制約、自動の承諾、繰り返しの一部の辞退（ADR-0019。DT-ROOM-001・002、PROP-ROOM-001〜003） |
| `room-approval` | 管理者の承認の会議室（ADR-0020。DT-ROOM-003） |
| `room-search-and-suggest` | 会議室の検索と提案 |
| `room-concurrency-tests` | 並行の予約の試験 |
| `find-a-time-ui` | 候補と会議室の画面（clients と共同） |

### E7 Web の画面

| Story | 内容 |
| --- | --- |
| `web-shell` | 画面の骨格、ルーティング、殻の Service Worker、CSP |
| `calendar-data-layer` | 窓、差分（`tokensOnly` を含む）、Realtime の合図、tzdata のゾーンの取得（ADR-0038。PROP-CLI-001） |
| `calendar-views` | 日・週・月・予定リスト、重なりの配置（PROP-CLI-002） |
| `timezone-display` | 表示のタイムゾーン、2 つ目のタイムゾーン、夏時間の日、終日（PROP-CLI-004） |
| `drag-create-move` | ドラッグでの作成・移動・長さの変更、楽観的な描画と 412 |
| `event-editor` | 予定の編集（繰り返しの選び方と確かめ、出欠） |
| `ime-guard` | IME の変換の途中の `Enter` の抑止（DT-CLI-001） |
| `keyboard-shortcuts` | キーボードの操作。画面の寄せ方は法務：L10 |
| `offline-read-cache` | 最近の範囲の IndexedDB のキャッシュとオフラインの閲覧（ADR-0039。PROP-CLI-003）。保持は法務：L5 |
| `pwa-install` | PWA |
| `web-rum` | 自前の RUM の収集。外部送信規律は法務：L2 |
| `web-a11y` | アクセシビリティ |
| `latency-bench` | 配置とドラッグのベンチマークを CI に |

### E8 同期と API

| Story | 内容 |
| --- | --- |
| `sync-tokens` | 同期のトークン（署名、`filter_hash`・`view_hash`・`epoch`）、差分の応答、410・400（DT-SYNC-001、PROP-SYNC-001・002） |
| `change-log-retention` | ログの日の分割と保持、`floor_seq`、墓標。保持の期間は法務：L5 |
| `web-sync-batch` | 束ねた差分（`POST /v1/sync`） |
| `realtime-gateway` | WebSocket の合図、再接続と取り戻し |
| `public-rest-api` | 公開 API の形、ページング、条件つきの更新、エラー、`X-Read-After`、OpenAPI（ADR-0026。PROP-API-001〜003） |
| `api-sync-endpoints` | `syncToken` と `POST /v1/sync`（`tokensOnly` を含む。DT-API-002） |
| `api-idempotency` | `Idempotency-Key`（PROP-API-002） |
| `oauth-apps-and-scopes` | OAuth 2.0 のアプリとスコープ（ADR-0027。DT-API-001） |
| `api-rate-limits` | レート制限 |
| `webhook-channels` | Webhook の通知の経路、期限、署名、まとめ、再試行（ADR-0028。DT-HOOK-001、PROP-HOOK-001〜003） |
| `public-sdk` | OpenAPI から公式の SDK を生成 |
| `caldav-discovery-and-propfind` | 発見、`PROPFIND`、主体とホームのコレクション |
| `caldav-calendar-resources` | 予定オブジェクトのリソース、`GET`・`PUT`・`DELETE`、ETag、`If-Match`（ADR-0023。DT-DAV-001、PROP-DAV-002） |
| `caldav-reports-and-sync` | `calendar-query`・`calendar-multiget`・`sync-collection`、CTag（PROP-DAV-001） |
| `caldav-implicit-scheduling` | CalDAV からの暗黙のスケジュール（ADR-0024。DT-DAV-002・003、PROP-DAV-003） |
| `caldav-app-passwords` | CalDAV のアプリ用のパスワード |
| `caldav-credential-hardening` | 認証の失敗の上限（アカウントの全体を止めない形）と知らせ（[sync-and-caldav.md](architecture/sync-and-caldav.md) の 6.7 節） |
| `ics-subscribe` | ICS の購読（egress、条件つきの取得、上限、SSRF の対策）（ADR-0025。DT-ICS-001、PROP-ICS-001） |
| `ics-publish` | ICS の公開（秘密のアドレス、公開のアドレス） |
| `ics-secret-url-logging` | 秘密のアドレスの経路をログに残さない |
| `ics-import-export` | ICS の取り込みと書き出し |
| `egress-ssrf-guard` | `ics-fetcher`・`push-sender`・`notifier` の宛先の検査 |
| `sync-health-metrics` | `sync_token_uses`、410 の理由の指標 |
| `interop-replay-harness` | CalDAV・iMIP の記録した通信の再生 |
| `caldav-client-lab` | 夜間の実物のクライアントの試験場（macOS のランナー、iOS のシミュレーター、Android のエミュレーター） |

### E9 リマインダーと通知

| Story | 内容 |
| --- | --- |
| `reminder-burst-poc` | PoC：毎時 50 分 00 秒の集中（約 12 万件）での時計と notifier |
| `reminder-settings` | リマインダーの設定、VALARM の対応（DT-REM-003） |
| `reminder-buckets` | 計画の表、7 日の範囲、付け替えと版（ADR-0030。DT-REM-001・002、PROP-REM-004） |
| `reminder-timer-wheel` | シャードごとのタイマーホイール、借りと交代（ADR-0029） |
| `reminder-delivery-ledger` | 送信の記録と重複の除去、遅れすぎたものの扱い、送る時の確かめ（PROP-REM-001〜003） |
| `reminder-reconciliation` | 送り漏れの照合 |
| `reminder-sli` | リマインダーの SLI（`due_at`、内訳） |
| `in-app-notifications` | 画面の通知 |
| `web-push` | Web Push の送信（本文は通知の ID だけ。ADR-0031。PROP-REM-005）。法務：L1・L4 |
| `web-push-subscribe` | Web Push の購読の登録（clients と共同）。法務：L1・L4 |
| `email-notifications` | リマインダー・招待・変更・返事のメール（DT-NOTIF-001）。法務：L1・L3 |
| `daily-agenda-email` | 毎朝の予定の一覧 |
| `reminder-fault-tests` | 時計の試験と障害の注入 |

### E10 予約ページ

| Story | 内容 |
| --- | --- |
| `booking-page-settings` | 長さ、間の時間、1 日の上限、受け付けの期間、場所、組織の方針（DT-BOOK-003） |
| `booking-slot-calculation` | 枠の計算（ADR-0032。DT-BOOK-001、PROP-BOOK-002・004・005） |
| `booking-create-cancel` | 予約の作成（排他の制約）と取り消し・変更（ADR-0033。DT-BOOK-002、PROP-BOOK-001・003） |
| `booking-confirmation` | 予約者のメールの確認、確認のメール。法務：L3・L6 |
| `booking-bot-protection` | ボットの対策とレート制限 |
| `booking-privacy-controls` | 同意のチェック、ポリシーのリンク、保持のジョブの枠。法務：L6 |

### E11 検索・管理・監査

| Story | 内容 |
| --- | --- |
| `search-bigm-poc` | PoC：索引の大きさ、更新の量、応答の p99 |
| `search-table-pg-bigm` | `redact()` の後の検索の表、`pg_bigm` の索引、更新の遅れの計測（ADR-0034。DT-SRCH-002、PROP-SRCH-002・003） |
| `search-api-and-ui` | 検索の API と画面（DT-SRCH-001、PROP-SRCH-001・004） |
| `search-reconciliation` | 毎日の索引の照合 |
| `admin-console` | 管理の画面（利用者、グループ、会議室、方針）、役割と委任（ADR-0037。DT-ACCT-002、PROP-ACCT-003） |
| `admin-event-access` | 管理者の予定の閲覧の許可と記録（`release.admin-event-access`。PROP-ACCT-004）。法務：L8 |
| `user-offboarding` | 停止・削除・引き継ぎ（DT-ACCT-003、PROP-ACCT-001）。保持は法務：L5 |
| `audit-log-ui-export` | 監査ログの画面と書き出し |
| `data-lifecycle` | 保持の表、削除、解約したテナントの削除（`tenant-purge`）。保持は法務：L5 |

### E12 本番の準備と GA の判定

| Story | 内容 |
| --- | --- |
| `scheduled-scaling` | 業務の時間の下限、祝日のスケジュールの生成（ADR-0047） |
| `load-tests` | 負荷試験 L1・L2・L4〜L10（[capacity.md](architecture/capacity.md) の 7 節） |
| `reminder-burst-load` | リマインダーの集中の負荷 L3 |
| `ses-quota-increase` | SES の送信の率の引き上げ（東京・大阪） |
| `tzdata-update-drill` | tzdb の更新の訓練（合成の改正を本番と同じ構成の環境で。切り替えの窓の長さ） |
| `dr-failover-workflow` | DR のワークフロー、`dr_epoch_started_at`、iMIP の `SEQUENCE` の余白、リマインダーの DR の窓の計数（ADR-0044） |
| `dr-failover-drill` | 大阪への切り替えの訓練、`sync_epoch` の更新 |
| `tenant-pitr-restore` | テナントの時点への戻し |
| `interop-acceptance` | 相互運用の手動の確認の表（K9） |
| `pentest-external` | 外部のペンテスト（iMIP、CalDAV、ICS、予約ページ、テナントの分離） |
| `synthetics-suite` | 合成監視（[observability.md](architecture/observability.md) の 6 節） |
| `capacity-review-dashboard` | 月次のキャパシティのレビューのダッシュボード |
| `schema-expand-contract-tooling` | スキーマの変更の段の確かめ、影の表の切り替え |
| `cost-baseline` | 費用の見積もりの確定 |
| `runbooks-e12` | 個別の手順の作成と確認（[runbooks/README.md](runbooks/README.md) の 6 節の計画の runbook） |
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
- **`writerWithoutPrivateAccess` のロール**、勤務の時間の複数の範囲、テナントをまたぐ主催者の変更、組織から個人へ戻す移り、組織のドメインでの iMIP の送信、他の組織へ配る公開の OAuth のアプリ、サービスアカウント（各領域の文書の持ち越し）。
- **Web の画面のオフラインの書き込み**（[architecture/README.md](architecture/README.md) の 6 節）。
- **S2 の構成**（テナントのシャード、検索の専用の基盤）と **S3 のセル構成**（infrastructure の領域）。

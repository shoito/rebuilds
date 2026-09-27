# Security: Uber

信頼境界、脅威モデル（STRIDE）、認証、位置のプライバシー、暗号化と鍵、監査ログ、データのライフサイクル、不正（位置の偽装、偽の乗車、共謀、特典の濫用）、法務の確認待ちの論点。

| ADR | 決定 |
| --- | --- |
| [0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md) | 位置と個人の情報は、種類ごとの KMS の鍵と保持の期間で分ける。人が位置を見る操作は、理由・範囲・期限つきの許可を発行して 1 つの窓口で行い、監査ログを操作と同じトランザクションで書き、改ざんできない保管へ送る |
| [0037](../decisions/0037-authentication-device-integrity-and-fraud-response.md) | 乗客・ドライバー・事業者・運用で認証の発行者と鍵を分ける。ドライバーは出庫のたびに端末の完全性を確かめ、その日の最初の出庫と 1 日 1 回の抜き打ちで顔の照合をする（L4 の後）。不正は兆しの点数と人の確認で扱い、自動の処置は配車の候補・特典から外すまでにする |

前提となる決定：位置の保存と保持の既定案（[ADR-0010](../decisions/0010-location-trails-map-matching-and-retention.md)）、依頼の前の地図の丸め（[ADR-0012](../decisions/0012-geo-index-nearby-query-api.md)）、配車の判断の記録の丸め（[ADR-0015](../decisions/0015-offer-protocol-decision-log-and-replay.md)）、署名つきの乗車の要約（[ADR-0022](../decisions/0022-trip-outbox-and-offline-continuation.md)）、PSP のトークンだけを持つ（[ADR-0023](../decisions/0023-psp-authorize-at-request-capture-at-end.md)）、供給は事業者だけが登録する（[ADR-0026](../decisions/0026-supply-registry-and-document-verification.md)）、緊急の通報の流れ（[safety-and-trust.md](safety-and-trust.md)）。

## 1. 目標と前提

- Slack・Figma の題材と同じく、OWASP ASVS 5.0 の Level 2 を目標にする。カード番号は持たない（PSP のトークンだけ）。PCI DSS の範囲の判定（SAQ の種類）は **未検証**（PSP の選定の後に確かめる）。
- 最も重い障害は 4 つ。
  1. **位置の漏洩**：乗車の相手でない人に、正確な位置や軌跡が見える（NFR-009）。ストーカーや、ドライバーの自宅の特定につながる。
  2. **二重の割り当て・二重の請求**（NFR-005・NFR-006）。攻撃でも不具合でも起こりうる。
  3. **偽のドライバー**：事業者に属さない人が出庫する（白タクの経路）、別の人がアカウントを使う。
  4. **緊急の通報が届かない**（NFR-010）。
- **ログ・トレース・メトリクス・エラーの報告に、緯度経度・住所の入力・電話番号・名前を書かない。** 位置は H3 の解像度 8 のセルまで（[ADR-0010](../decisions/0010-location-trails-map-matching-and-retention.md)）。
- **AI エージェント（コーディング・運用）は、本番のデータに触れない。** テストは合成の軌跡か、匿名化して丸めた軌跡だけ（[AGENTS.md](../../AGENTS.md)）。

## 2. 信頼境界

```
┌──────────────── インターネット（信頼しない）───────────────────────────────┐
│ 乗客のアプリ   ドライバーのアプリ（事業者の端末か個人の端末）   攻撃者      │
│ 事業者の管理画面（Web）   乗車の共有のページを開く人                        │
└──┬──────────────┬─────────────────┬─────────────────┬────────────────────────┘
   │ api.<domain>  │ loc.<domain>     │ rt.<domain>      │ share.<domain>・operator.<domain>
 ══╪══ B1：エッジ（WAF、TLS 1.2 以上）═══════════════════════════════════════════
   ▼               ▼                  ▼                  ▼
┌── prod アカウント（VPC）──────────────────────────────────────────────────────┐
│ API ── B2：利用者の種類ごとのトークン（乗客・ドライバー・事業者・運用）       │
│ loc-ingest ── B3：出庫のセッション（端末の完全性つき）── Kinesis（location 鍵）│
│ 各サービス ── B4：サービスのトークン＋セキュリティグループ ── geo-index・dispatch│
│ Trips ── B5：遷移関数と fencing（assignment_epoch）── Aurora core            │
│ Payments ── B6：冪等キーと結果不明の規則 ── PSP・Aurora money                │
│ 位置の閲覧の窓口 ── B7：理由・範囲・期限つきの許可 ── 軌跡のストア            │
└───────────────────────────────────────────────────────────────────────────────┘
 ═══ B8：管理プレーン ═══ CI/CD（OIDC）、運用者（SSO＋MFA、期限つきの役割）、log-archive
 ─ ─ B9：分析のアカウント … HMAC に置き換えた写しだけ ─ ─
 ─ ─ B10：開発環境（AI コーディングエージェント）… 本番への経路なし ─ ─
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | すべての外部の要求、gRPC の常時の接続、位置の POST | WAF（マネージドルール、IP ごとのレート制限）、TLS 1.2 以上、HSTS |
| B2 利用者の種類 | 乗客・ドライバー・事業者・運用の要求 | 種類ごとの発行者と鍵（ADR-0037）。事業者の管理画面の API は RLS で事業者ごとに分ける（[supply-and-operators.md](supply-and-operators.md) の 9 節） |
| B3 出庫のセッション | 位置の送信 | トークンの `driver_session_id` と本体の一致（[location-ingestion.md](location-ingestion.md) の 4.1 節）。出庫のときの端末の完全性と、1 日の最初の出庫と抜き打ちの顔の照合 |
| B4 サービスの間 | 内部の gRPC | Service Connect の TLS、セキュリティグループ、サービスのトークンと RPC ごとの許可の一覧（ADR-0037） |
| B5 遷移 | 割り当て・状態の変更 | 遷移関数だけが書く。`trips.state` を更新できる DB のロールは Trips だけ（[ADR-0021](../decisions/0021-trip-transition-function-and-assignment-fencing.md)） |
| B6 お金 | PSP への操作 | [payments-and-payouts.md](payments-and-payouts.md) の 7・14 節 |
| B7 位置の閲覧 | 人が軌跡を見る | 許可（ADR-0036）と監査ログ |
| B8 管理プレーン | デプロイ、鍵、運用者の操作 | OIDC の短命な認証情報、break-glass の役割、監査 |
| B9 分析 | 位置・乗車の集計 | 別のアカウント。`driver_id` と `rider_id` を HMAC に置き換えた写しだけ（ADR-0010） |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主要な脅威と対策だけを書く。

### 3.1 アプリ（乗客・ドライバー）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | ワンタイムコードの横取り（SIM の乗っ取り）でアカウントを奪う | 新しい端末でのログインで、保存したカードの再確認（3-D セキュア）を求める。ドライバーは出庫のときに顔の照合（[safety-and-trust.md](safety-and-trust.md) の 7.2 節） |
| S | ドライバーのアカウントを別の人が使う（貸し借り） | 1 日の最初の出庫と 1 日 1 回の抜き打ちの顔の照合（`legal.l4.driver_face_check`。記録の前は事業者の点呼）、端末の結びつけ。1 人 1 セッション（部分一意索引、[ADR-0026](../decisions/0026-supply-registry-and-document-verification.md)） |
| T | 改造したアプリで位置を偽る、状態を偽る | 端末の完全性（App Attest・Play Integrity）、位置の検証 V1〜V8（[location-ingestion.md](location-ingestion.md) の 5 節）。遷移の最終の判定はサーバー（ADR-0021） |
| I | 端末に残した journal・軌跡の漏洩（端末の紛失） | journal は暗号化し、確定したら消す。要約の位置は解像度 9 に丸める（[rider-and-driver-apps.md](rider-and-driver-apps.md) の 9 節） |
| I | 依頼の前の地図の車から、特定のドライバーを追う | セルの中心に丸め、ID を付けず、10 秒キャッシュ（ADR-0012） |
| I | 乗車の後に、相手の位置・電話番号を知る | 位置は受諾から降車までだけ配る。番号は中継で隠し、降車の 30 分後で切る（[safety-and-trust.md](safety-and-trust.md) の 6 節） |
| D | ワンタイムコードの大量の送信（SMS の料金の攻撃） | 番号の帯・IP・端末ごとの上限（[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の runbook `sms-pumping.md`） |
| E | 乗客のトークンでドライバーの API を呼ぶ | 種類ごとの発行者と鍵（ADR-0037） |

### 3.2 位置の取り込み（loc-ingest・Kinesis・trail-builder）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 他のドライバーのセッションで位置を送る | トークンの `driver_session_id` と本体の一致。403 |
| T | 模擬の位置で、配車の多い場所にいるように見せる | V6（跳び）・V7（偽装の印）、兆しの点数（9 節） |
| T | 壁時計をずらして、古い点を新しく見せる | 判定はセッションの基準点と単調時計（location-ingestion の 4.3 節） |
| I | 位置の流れ・生の点のストアの読み取り | `location` の鍵。鍵を使えるロールを限る（ADR-0036）。Kinesis は KMS の鍵でサーバーの側の暗号化 |
| D | 大量の送信・送り直しの殺到 | セッションごとの流量の制限、`backlog` の別の制限、`next_interval_ms` の弁（location-ingestion の 4.4・10 節） |
| R | 誰がどこにいたか争いになる | 生の点（30 日）と乗車の軌跡（1 年）。検証の `verdict` を残す |

### 3.3 配車（geo-index・dispatch）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 内部の他のサービスが `FindNearby` で全ドライバーの位置を引く | RPC ごとの許可の一覧（dispatch と eta だけ）、上限（`limit` 50、`k_max` 30） |
| T | 2 つの配車のタスクが同じドライバーを提案する | Trips の epoch と部分一意索引で片方を拒否（[ADR-0003](../decisions/0003-trip-state-and-single-assignment.md)） |
| T | 配車の設定の値の誤り・悪意の変更 | AppConfig の検証の関数、再生の結果の添付、変更の記録と承認（[delivery.md](delivery.md) の 3 節） |
| I | 判断の記録からの位置の漏洩 | 解像度 10 に丸める、乗客の個人の情報を含めない、`location` の鍵、180 日（ADR-0015） |
| I | 索引のメモリのダンプ | コアダンプを無効、本番でヒープのプロファイルを取らない（[geospatial-index.md](geospatial-index.md) の 9 節） |
| D | 大量の依頼で配車のバッチを膨らませる | 都市ごとの受け入れの上限とバッチの大きさの上限（[ADR-0041](../decisions/0041-load-model-admission-control-and-prescaling.md)） |

### 3.4 乗車（Trips）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 他人の乗車を操作する（IDOR） | トークンの `driver_id`・`rider_id` と割り当て・乗車の一致を確かめる（[trips-lifecycle.md](trips-lifecycle.md) の 10 節） |
| T | 古いオファーの受諾、遅れた操作で状態を戻す | `(assignment_id, assignment_epoch)`、終端の不変（ADR-0021）、`trip_conflicts` |
| T | 偽の `TripSnapshot` で乗車を「復元」する | Ed25519 の署名を確かめる。鍵は KMS の外に出さない（ADR-0022） |
| T | 到着の位置を偽って無断キャンセル料を取る | 到着の操作の位置と軌跡を突き合わせ、乗車地から 100 m より遠い到着の無断キャンセルは運用の確認に回す（9 節） |
| R | 乗客・ドライバーが操作を否認する | `trip_events` に発生の時刻・記録の時刻・`command_id`・actor（追記のみ） |
| D | 依頼の連打 | 乗客ごとの有効な乗車は 1 つ（部分一意索引）、`client_request_id` の冪等 |

### 3.5 支払い（Payments）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 盗んだカードの登録 | PSP の 3-D セキュア（登録のとき）、与信（依頼のとき）、カードの指紋ごとのアカウントの数の上限 |
| T | 二重の請求、二重の返金 | 冪等キー、部分一意索引、結果不明の規則（ADR-0023） |
| T | Webhook の偽造・再送 | 署名、時刻と ID の確認、inbox（payments の 14 節） |
| T | 事業者の振込先の乗っ取り | 2 人の承認と、登録済みの連絡先への通知（payments の 14 節） |
| I | カードの情報のログへの混入 | 表示用の情報（ブランド、末尾 4 桁）より多くを持たない |
| E | サポートが上限を超える返金をする | 権限・上限・2 人の承認・監査ログ（[support-and-operations-tools.md](support-and-operations-tools.md)） |

### 3.6 事業者の管理画面

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 管理者のアカウントの乗っ取りで、偽のドライバーを登録する | 多要素の認証を必須、書類の確認はこの基盤の審査の担当（ADR-0026）。新しいドライバーの初回の出庫は顔の照合 |
| I | 他の事業者のドライバー・乗車・運賃を見る | RLS（`operator_id`）。事業者どうしで運賃や稼働を共有する経路を作らない（L9） |
| I | 稼働の地図で自社のドライバーの位置を運行管理の外に使う | 自社の車だけ、アクセスを監査ログに残す（supply の 5.2 節）。乗車の後の履歴は解像度 9 に丸める |
| T | 運行枠・台数を偽って登録する | 通知の写しと 2 人の承認（[ADR-0027](../decisions/0027-rideshare-operating-windows.md)） |
| E | `viewer` が `operator_admin` の操作をする | 役割ごとの許可の一覧を API で確かめる（画面だけで隠さない） |

### 3.7 サポートと運用のツール

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | サポートの担当が、知人・有名人の軌跡を見る | 位置の閲覧の許可（理由・1 乗車・30 分）、監査ログ 100%、毎日の照合（ADR-0036）。有名人などの注意の一覧の閲覧は上長への通知（**未検証**の運用。E11 で決める） |
| I | 警察を装った照会で位置を渡す | 外部への提供は法務の担当と運用の責任者の 2 人の承認。照会の手続きは法務の確認待ち（L7。safety の runbook `law-enforcement-request.md`） |
| T | 返金・運賃の訂正の不正 | 上限、2 人の承認、担当ごとの件数の監視 |
| R | 誰が何をしたか分からない | `audit_events`（操作と同じトランザクション）と log-archive の Object Lock |
| E | 運用者が本番のデータを直接読む | 期限つきの役割（最長 4 時間）、break-glass の役割は 2 人の承認と事後の確認 |

## 4. 認証とセッション

[ADR-0037](../decisions/0037-authentication-device-integrity-and-fraud-response.md) による。

| 利用者 | ログイン | トークン | 特記 |
| --- | --- | --- | --- |
| 乗客 | 電話番号＋ワンタイムコード（SMS）。パスキーは任意 | アクセス 10 分、更新 30 日（使うたびに入れ替え、端末に結びつける） | 新しい端末ではカードの再確認 |
| ドライバー | 事業者が出す招待のコード＋登録した電話番号へのワンタイムコード | アプリのセッション（更新 30 日）。出庫のたびに、`driver_session_id` に結びつけたアクセス 10 分 | 出庫のたびに App Attest か Play Integrity。顔の照合は 1 日の最初の出庫と抜き打ち。入庫で無効 |
| 事業者の管理画面 | メール＋パスキーか TOTP（必須）。大手は SAML の SSO | セッション（アイドル 12 時間、最長 7 日） | 事業者の `operator_owner` が自社の監査ログを見られる |
| 運用（サポート・安全・審査） | IAM Identity Center の SSO＋MFA | 管理画面のセッション 8 時間 | 位置と支払いの操作は許可と 2 人の承認 |
| サービス | — | Service Connect の TLS、サービスのトークン 5 分 | RPC ごとの許可の一覧 |

- 署名の鍵は種類ごとに分ける（Ed25519、90 日ごとに入れ替え、`kid` で 24 時間並べる）。
- トークンの保存：Keychain・Android Keystore（[rider-and-driver-apps.md](rider-and-driver-apps.md) の 9 節）。
- 実装は、Slack の題材の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md) の自前でホストする認証の部品を候補にする。電話番号のワンタイムコードと、ドライバーの出庫のセッションは自前で足す。どの部品を使うかは E1 で決める（持ち越し）。

## 5. 位置のプライバシー

[ADR-0036](../decisions/0036-location-privacy-keys-retention-and-audited-access.md) と [ADR-0010](../decisions/0010-location-trails-map-matching-and-retention.md) による。

### 5.1 誰が何を見られるか

| 見る人 | 見られるもの | いつ |
| --- | --- | --- |
| 乗客 | 割り当てのドライバーの正確な位置 | 受諾から降車まで（[notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 6 節） |
| 乗客（依頼の前） | 近くの車の丸めた点（解像度 9 の中心、ID なし） | 依頼の画面（ADR-0012） |
| ドライバー | 乗客の乗車地（正確） | オファーから乗車まで。降車地は受諾の後（[dispatch-and-matching.md](dispatch-and-matching.md) の 8.4 節） |
| 乗車の共有の相手 | 乗車中の車の位置 | 乗車の終わりまで（[safety-and-trust.md](safety-and-trust.md) の 3 節）。NFR-009 の例外で `legal.l4.share_trip` の裏 |
| 事業者の運行管理 | 自社の車の位置と状態（稼働の地図）、乗車中の乗降の地点 | 出庫中。乗車の後の履歴は解像度 9 に丸める。稼働の地図は NFR-009 の例外で `legal.l4.operator_fleet_map` の裏 |
| サポート・安全の担当 | 1 乗車の軌跡、1 つのインシデントの追記の位置 | 許可（理由・範囲・30 分）の間 |
| 分析 | ID を HMAC に置き換えた写し、ID を持たない集計 | 別のアカウント |
| 外部（警察など） | 法務の確認待ち | 2 人の承認（L4・L7） |

### 5.2 位置の閲覧の窓口

```
担当 ─(理由の ID、対象の乗車・インシデント)─▶ サポートのツール
   ▼
location_access_grants に作成（期限 30 分、範囲、承認者）＋ audit_events（同じトランザクション）
   ▼
trail-viewer（location の鍵を使える唯一の人の窓口）── 範囲の中だけ返す ──▶ 画面（透かしに担当の名前）
```

- 1 つの許可で見られるのは、1 乗車の区間（迎車の開始から降車まで）か、1 つの `SafetyIncident` の追記の位置だけ。
- 画面は、担当の名前と時刻の透かしを入れ、取り出し（CSV など）を持たない。事故の書き出しは、安全の担当の `incident_packets` の手順だけ（[safety-and-trust.md](safety-and-trust.md) の 8.2 節）。
- 毎日、窓口の呼び出しと `audit_events` の件数を照合する。差が 1 件でもあれば SEV2。

### 5.3 保存の場所ごとの守り

| ストア | 中身 | 守り |
| --- | --- | --- |
| Kinesis `loc-<city>` | 検証済みの位置 | `location` の鍵、24 時間 |
| S3 `loc-raw/` | 生の点 | `location` の鍵、30 日、分析は HMAC の写しだけ |
| S3 `trip-trails/`、Aurora `trip_trails` | 乗車の軌跡 | `location` の鍵、1 年、窓口だけ |
| S3 `dispatch-decisions/` | 配車の判断の記録（解像度 10） | `location` の鍵、180 日、配車の担当と再生の仕組みだけ |
| Aurora `safety_incident_locations` | 緊急の通報の後の位置 | 列の暗号化（`location` の鍵）、L7 の結論まで |
| Aurora `trips` の乗降の座標 | 乗客が確かめたピン | Aurora の暗号化。API は相手と乗車の間だけ返す |
| 索引のメモリ | 最新の位置 | 正本ではない。ダンプを取らない |
| 端末 | journal、送り直しの点 | 暗号化、確定したら消す |

## 6. 暗号化と鍵

### 6.1 通信

- 外向き：TLS 1.2 以上（1.3 を優先）、HSTS。gRPC の常時の接続も TLS。
- VPC の中：Service Connect の TLS 1.3（AWS Private CA の短い期限の証明書、5 日ごとに入れ替え）。Service Connect は失効の仕組みを持たない（[Encrypt Amazon ECS Service Connect traffic](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-connect-tls.html)、2026-09-27 に確認）。Service Connect が作る秘密（`ecs-sc!` の接頭辞）の読み取りは、他のロールに IAM で拒む。
- Aurora・Valkey への接続も TLS。

### 6.2 保存

| 置き場所 | 暗号化 | 鍵 |
| --- | --- | --- |
| Kinesis、S3 の位置の接頭辞、`dispatch-decisions/`、`safety_incident_locations` の列 | SSE-KMS・列の暗号化 | `location` |
| Aurora `core`（電話番号の列、免許証の書類の S3 を含む） | ストレージの暗号化。電話番号と保険の番号は列の暗号化（supply の 3 節） | `pii`（列）、`app`（ストレージ） |
| Aurora `money`、精算の明細の S3、振込先の口座 | ストレージと列の暗号化 | `money` |
| `audit_events`、log-archive | SSE-KMS、Object Lock | `audit` |
| Valkey、SQS、DynamoDB、CloudWatch Logs | 保存時の暗号化 | `app` |
| 顔の画像（生体の情報） | SSE-KMS、30 日 | `biometric`（専用。照合のサービスと、安全の担当の監査つきの確認の役割だけが使える） |

- 鍵はすべて東京で作り、大阪にレプリカを置くマルチリージョンの鍵。年 1 回の自動の入れ替え。
- 鍵の削除の予約は、SCP で break-glass の役割以外に禁じる。
- `TripSnapshot` の署名の鍵（Ed25519、KMS の非対称の鍵）は Trips のサービスだけが署名できる。大阪のレプリカで署名を確かめられるようにする。入れ替えは年 1 回、古い公開鍵を 90 日残す（アプリが持つ要約の検証のため）。
- 電話番号を検索に使うときは、鍵つきのハッシュ（HMAC）の列で引く。

## 7. 監査ログとデータのライフサイクル

### 7.1 監査ログ

| 項目 | 決定 |
| --- | --- |
| 書き方 | `audit_events` に、操作と同じトランザクションで書く。outbox で log-archive の S3（Object Lock のコンプライアンスモード）へ送る。Slack の題材の [ADR-0018](../../../slack/docs/decisions/0018-audit-log.md) の形 |
| 中身 | actor（利用者の種類と ID、運用者、サービス）、action、対象の種類と ID、理由の ID、許可の ID、IP、端末の種類、`request_id`。**位置・電話番号・名前の値を書かない** |
| 保持 | Aurora に 1 年、アーカイブに 7 年（既定案、法務の確認待ち） |
| 見る人 | この基盤の監査の担当。事業者は自社の利用者の操作だけ |

記録する操作：

| 分類 | 操作 |
| --- | --- |
| 位置 | 軌跡の閲覧、インシデントの位置の閲覧、外部への提供、事業者の稼働の地図の閲覧（1 時間に 1 回に間引く） |
| 乗車 | `system_cancel`、復元と食い違いの確認、運賃の訂正 |
| お金 | 返金、訂正、償却、仮勘定の解消、振込先の変更、精算の確定 |
| 供給 | ドライバー・車両・事業者の登録、停止と再開、書類の承認、運行枠の承認、雨天・酷暑の拡大の有効化 |
| 規則 | 運賃の規則・区域の多角形・乗降の地点の承認、`legal_gate_records` の作成、legal のフラグの変更 |
| 認証 | ログイン、多要素の設定、セッションの取り消し、招待のコードの発行、端末の完全性の失敗 |
| 安全 | インシデントの受け付けと閉じ、相手の拒否の追加、ドライバーの安全の停止 |
| 運用者 | 期限つきの役割の取得、break-glass の利用 |

### 7.2 データのライフサイクル

期間は既定案で、**法務の確認待ち**（[intent.md](../intent.md) の L4・L7）。値の正本はこの表とし、Terraform のライフサイクル・TTL・削除のジョブの設定を生成する（ADR-0036）。バックアップ（最大 35 日）を、どの削除でも最終の期限にする。

| データ | 保持 | 消し方 | 定義の場所 |
| --- | --- | --- | --- |
| 位置の流れ（Kinesis） | 24 時間 | 保持の期間 | [location-ingestion.md](location-ingestion.md) の 7 節 |
| 生の点（`loc-raw/`） | 30 日 | S3 のライフサイクル（東京・大阪） | 同上 |
| 乗車の軌跡 | 1 年 | 同上、`trip_trails` は削除のジョブ | 同上 |
| 速度の標本・台数の集計（ID なし） | 2 年 | 同上 | 同上 |
| 配車の判断の記録 | 180 日 | 同上 | [dispatch-and-matching.md](dispatch-and-matching.md) の 9.1 節 |
| 乗車の記録（`trips`、`trip_events`、運賃） | 運賃の記録の保存の期間（**未検証**。乗務記録・帳簿の保存の義務と合わせて法務が決める） | 期限の後、乗客の ID を切り離す | [trips-lifecycle.md](trips-lifecycle.md) |
| 台帳・精算・適格請求書 | 10 年（想定。法務） | パーティションの削除 | [payments-and-payouts.md](payments-and-payouts.md) の 17 節 |
| ドライバーの書類の画像 | 登録の解除から 3 年（既定、**未検証**） | 削除のジョブ | [supply-and-operators.md](supply-and-operators.md) の 9 節 |
| 顔の画像 | 30 日 | ライフサイクル | [safety-and-trust.md](safety-and-trust.md) の 12 節 |
| 乗車の中のメッセージ | 乗車の終わりから 30 日 | 削除のジョブ | [notifications-and-realtime-push.md](notifications-and-realtime-push.md) の 11 節 |
| 通話の記録 | 90 日 | 削除のジョブ | [safety-and-trust.md](safety-and-trust.md) の 6 節 |
| 緊急の通報と位置 | L7 の結論まで（既定 3 年、**未検証**） | 削除のジョブ | 同上 |
| ワンタイムコード | 24 時間 | 削除のジョブ | notifications の 15 節 |
| SMS の記録（本文なし） | 90 日 | 同上 | 同上 |
| 位置の閲覧の許可 | 監査ログと同じ | — | 5.2 節 |
| 監査ログ | 1 年（Aurora）、7 年（アーカイブ） | パーティションの削除、Object Lock の期限 | 7.1 節 |
| アプリのログ | 30 日（CloudWatch Logs）、1 年（log-archive） | 保持の期間 | [observability.md](observability.md) の 4 節 |

- **アカウントの削除**：乗客・ドライバーの依頼で、ログインの情報、電話番号、保存した場所、端末のトークンを 30 日の猶予の後に消す。乗車・運賃・台帳の記録は、上の期間まで、ID を切り離した形で残す（帳簿と事業者の記録の義務のため）。軌跡を保持の期間の前に消すかは法務の確認待ち（L4）。
- **削除は東京と大阪の両方で行う。** S3 の版を指定した削除とライフサイクルの動作は、複製で伝わらない（Figma の [security.md](../../../figma/docs/architecture/security.md) の 7 節と同じ事実）。
- **リーガルホールド**：事故・訴訟の対象の乗車・人の削除を止める印を持つ。使う条件は法務の確認待ち。

## 8. 秘密情報・サプライチェーン・運用者のアクセス

- 秘密情報は Secrets Manager。gitleaks を PR の CI で走らせる。
- Go は `govulncheck`、TypeScript は lockfile と `npm audit`、Swift・Kotlin は依存の一覧の検査。コンテナは Inspector で検査する。ビルドの成果物に来歴（SLSA）を付ける（Slack と同じ）。
- 地図・住所・SMS・通話・顔の照合の提供者の鍵は、サーバーだけに置く（アプリに置かない）。
- アプリに入れる外部の SDK は一覧にし、電気通信事業法の外部送信規律の公表の対象にする（[rider-and-driver-apps.md](rider-and-driver-apps.md) の 9 節、L4）。
- 運用者が本番のデータを読む経路は、サポートのツールの窓口（許可と監査つき）だけ。DB への直接の接続は break-glass の役割（2 人の承認、事後の確認）に限る。

## 9. 不正

本家は、払い戻しの要求、支払いの不正、アカウントの乗っ取り、ドライバーと乗客の共謀、特典の濫用、GPS の偽装を扱い、教師なしの異常の検知と、処置の前の人の確認を組み合わせている（[Risk Entity Watch](https://www.uber.com/blog/risk-entity-watch/)、2023-09-28、2026-09-27 に確認）。この設計の S1 は、規則と点数で始め、学習のモデルは ml-platform（S2 以降）で足す。

| 不正 | 兆し | 自動の処置 | 人の確認の後の処置 |
| --- | --- | --- | --- |
| **GPS の偽装**（配車の多い場所にいるように見せる） | 模擬の位置の印、端末の完全性の失敗、跳びの多さ、精度と位置が長く変わらない、ETA の系統的なずれ、時刻のずれ（[location-ingestion.md](location-ingestion.md) の 13 節） | 点を索引に使わない、セッションを候補から外す（`location_untrusted`） | 事業者と運用で利用の停止 |
| **偽の乗車**（乗車の実体がないのに運賃を立てる、キャンセル料を取る） | 軌跡の距離とメーターの距離の食い違い（影の計算、[ADR-0019](../decisions/0019-meter-fare-sources.md)）、乗車中に車が動かない、到着の位置が乗車地から遠いのに無断キャンセル、同じ乗客とドライバーの組の繰り返し | 運賃の確定の保留（DT-FARE-004）、無断キャンセル料の保留 | 運賃の訂正、事業者への連絡 |
| **共謀**（ドライバーと乗客が組んで、特典・キャンセル料・短い乗車を繰り返す） | 同じ端末・同じカードの指紋・同じ電話番号の帯の乗客とドライバー、同じ組の短い乗車の繰り返し、乗車地と降車地が同じ | 組の配車を止める（`safety_pair_blocks` と同じ仕組みで `source=fraud`）、特典の適用を止める | 乗客・ドライバーの停止（事業者と運用） |
| **特典の濫用**（複数のアカウントで初回の特典を取る） | 1 つの端末・カードの指紋・電話番号の帯に多くのアカウント、端末の完全性の失敗 | 特典は端末とカードの指紋ごとに 1 回。超えたら適用しない | アカウントの停止 |
| **支払いの不正**（盗んだカード） | 与信の拒否の連続、1 枚のカードに多くのアカウント、新しい端末と高い額の組 | 3-D セキュアを求める、依頼を受けない（与信の前） | アカウントの停止、PSP への報告 |
| **アカウントの乗っ取り** | 新しい端末からのログインと、振込先・保存したカードの変更の組 | 保存したカードの再確認、振込先の変更は 2 人の承認（事業者） | セッションの取り消し |
| **ワンタイムコードの料金の攻撃（SMS pumping）** | 番号の帯・国からの送信の急増 | 送信の上限、国際の番号へ送らない | 番号の帯の遮断（notifications の runbook） |

- 点数は、主体（ドライバー・乗客・端末・カードの指紋）ごとに 1 日 1 回と、10 分ごとの急な変化で作る。点数と根拠の兆しを、運用の画面に出す。
- 自動の処置は上の表の「自動の処置」の列まで（ADR-0037）。停止は人が決め、事業者のドライバーは事業者と一緒に決める。
- 不正の検知に使う端末の識別子とカードの指紋は、`pii` の鍵で守り、分析には HMAC の写しで渡す。
- インセンティブ（報酬の上乗せ）は範囲外（[intent.md](../intent.md) の Non-goals）なので、インセンティブを狙う不正は S1 で扱わない。

## 10. 法務の確認待ち

結論が出るまで、該当する Story の spec を承認しない（[intent.md](../intent.md) の「法務の確認待ち」）。

| # | この領域の論点 | 関わる節 |
| --- | --- | --- |
| L4 | 位置の履歴が個人情報に当たるか。個人情報保護委員会の FAQ は位置情報を個人関連情報の例とし、個人情報に当たる場合は個人関連情報に当たらないとする（[FAQ Q2-8](https://www.ppc.go.jp/all_faq_index/faq2-q2-8/)、2026-09-27 に確認）。電気通信事業のガイドラインの解説は、連続して蓄積されて特定の個人を識別できる位置情報は個人情報に当たるとする（[解説](https://www.ppc.go.jp/files/pdf/240312_telecom_GLs_description.pdf)、令和 6 年 3 月更新、2026-09-27 に確認） | 5・7 節 |
| L4 | この基盤（乗車の中のメッセージ、番号の中継を持つ）が電気通信事業者に当たるか。当たるなら、同じ解説の第 41 条（位置情報は利用者の同意などがある場合に限り取得・利用・提供する）が及ぶか。届出の要否 | 5 節 |
| L4 | 利用目的の通知と同意の形、保持の期間（7.2 節の既定案）、事業者との関係（委託・共同利用・第三者提供）、外国の提供者（地図・SMS・顔の照合）への提供、アカウントの削除と軌跡の扱い、外部送信規律の公表 | 5・7・8 節 |
| L4 | 漏洩のときの個人情報保護委員会と本人への報告の要否と期限 | [runbooks/incident-response.md](../runbooks/incident-response.md) |
| L7 | 警察などからの照会への位置の提供の手続き、緊急の通報の位置と記録の保持、運用が本人の代わりに 110・119 に通報する扱い | 3.7・5.1 節、[safety-and-trust.md](safety-and-trust.md) |
| L6 | 代金の受け取りの形 A（[ADR-0024](../decisions/0024-fare-collection-model.md)）でこの基盤が加盟店になる場合の、割賦販売法の加盟店の義務（カード番号の適切な管理、非保持化で足りるか）。**未検証**（[intent.md](../intent.md) の L6 に加えた） | 1 節 |
| 追加 | 不正の検知の兆し（端末の識別子、カードの指紋）の利用目的への書き方 | 9 節 |

## 11. セキュリティの試験

| 試験 | 頻度 | 対象 |
| --- | --- | --- |
| 漏洩のテスト（位置） | PR ごと | 5.1 節の表の「見る人 × API」の組をすべて呼び、相手でない人・乗車の外の時刻に正確な位置が返らないこと（PROP-SEC-002） |
| 権限のテスト | PR ごと | 4 種類のトークン × すべての API の組（ADR-0037） |
| ログの検査 | PR ごと・結合試験 | ログ・トレースの全体に緯度経度の形の値が 0 件（location-ingestion の 14.3 節） |
| DAST（OWASP ZAP） | 週に 1 回（staging） | API、事業者の管理画面、共有のページ |
| 外部の侵入試験 | 本番の前に 1 回、以後年 1 回 | アプリ、位置の取り込み、事業者の管理画面、サポートのツール、共有のページ |
| 鍵のポリシー・IAM の検査 | PR ごと（Terraform） | IAM Access Analyzer、`checkov`。`location` の鍵の利用者の一覧の変化 |
| 端末の完全性の回避の試験 | E3・E9 | 模擬の位置のアプリ、改造したアプリ、エミュレーターで出庫できないこと |

## 12. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり。

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `kms-keys-and-policies` | 6.2 節の 6 種類の鍵、鍵のポリシー、大阪のレプリカ |
| E1 | `auth-rider-otp` | 乗客のワンタイムコード、トークン、更新の入れ替え |
| E1 | `auth-token-issuers` | 種類ごとの発行者と鍵、`kid` の入れ替え |
| E1 | `service-identity-tokens` | Service Connect の TLS、サービスのトークン、RPC ごとの許可の一覧 |
| E1 | `audit-events-core` | `audit_events`、outbox、log-archive（Object Lock） |
| E1 | `retention-table-codegen` | 7.2 節の表から Terraform・TTL・削除のジョブの値を生成し、一致をテストする |
| E2 | `driver-invitation-activation` | 招待のコードとドライバーのアプリの有効化 |
| E2 | `operator-console-mfa-sso` | 事業者の管理画面の多要素と SAML |
| E3 | `driver-session-integrity` | 出庫のときの App Attest・Play Integrity の確認と、セッションのトークン |
| E3 | `location-access-grants` | 位置の閲覧の許可、trail-viewer、毎日の照合（ADR-0036） |
| E3 | `analytics-hmac-copy` | 分析のアカウントへの HMAC の写し |
| E10 | `fraud-signal-scoring` | 9 節の兆しと点数、運用の画面（location-ingestion の Story と同じ 1 つ） |
| E10 | `promo-abuse-guards` | 端末・カードの指紋ごとの特典の上限 |
| E11 | `break-glass-and-jit-roles` | 期限つきの役割と break-glass |
| E12 | `data-deletion-both-regions` | アカウントの削除と、東京・大阪の両方の削除のジョブ |
| E12 | `pentest-and-fixes` | 外部の侵入試験と修正 |

## 13. 未解決の問い

### 決定（2026-09-27、既定案）

- 鍵は `location`・`pii`・`biometric`・`money`・`audit`・`app` の 6 種類。マルチリージョン。顔の画像は `biometric`（統合の決定。`pii` とは分ける）。
- 位置の閲覧は、理由・1 乗車・30 分の許可と監査ログ 100%。外部への提供は 2 人の承認。
- 乗客は電話番号とワンタイムコード、ドライバーは招待のコードと出庫ごとの端末の完全性。顔の照合は 1 日の最初の出庫と 1 日 1 回の抜き打ちで、`legal.l4.driver_face_check` の裏（L4）。
- 監査ログは Aurora に 1 年、アーカイブに 7 年。
- 不正の自動の処置は、配車の候補・特典から外すまで。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 認証の部品（Better Auth を使うか、電話番号の部分を自前で書くか） | E1 |
| App Attest の上限と段階的な導入、Play Integrity の 1 日の上限の引き上げ | E3 の前に Apple・Google の資料と申請で確かめる |
| PCI DSS の SAQ の種類、割賦販売法の加盟店の義務 | PSP の選定（E8）と法務 |
| 有名人などの注意の一覧の運用 | E11 |
| 10 節の法務の論点 | 法務 |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 位置の漏洩のテストの組（5.1 節の表）を NFR-009 のリリースの基準にする。API を足したら組も足す。
- 位置の閲覧の件数と監査ログの件数の差（常に 0）。
- 出庫の端末の完全性の失敗の率、顔の照合の失敗の率。
- 不正の候補の件数と、人の確認で不正と判定した割合（誤検知の率）。
- 外部の侵入試験の重大・高の指摘が 0 件で本番。

### runbooks

- `location-access-anomaly.md`：位置の閲覧の件数と監査ログの差、担当ごとの閲覧の急増のときの確かめ方と、許可の停止。
- `account-takeover.md`：乗客・ドライバー・事業者のアカウントの乗っ取りの疑いで、セッションを取り消し、操作を監査ログで調べる手順。
- `token-signing-key-rotation.md`：トークン・`TripSnapshot` の署名の鍵の定期の入れ替えと、漏洩のときの即時の入れ替え。
- `fraud-review.md`：不正の候補の確かめ方と、事業者への連絡、停止の判断。
- `personal-data-breach.md`：個人情報の漏洩の疑い（位置を含む）の影響の範囲の調べ方と、報告の判断（L4）。[runbooks/incident-response.md](../runbooks/incident-response.md) から呼ぶ。

### data-model

| 置き場所 | 中身 |
| --- | --- |
| Aurora `core` `audit_events`（月のパーティション、1 年） | 7.1 節 |
| Aurora `core` `location_access_grants`（`id`、`actor_id`、`reason_kind`、`reason_ref`、`scope_kind`（trip・incident）、`scope_id`、`approved_by`、`expires_at`、`created_at`） | 5.2 節 |
| Aurora `core` `legal_holds`（`scope_kind`、`scope_id`、`reason`、`created_by`、`released_at`） | 7.2 節 |
| Aurora `core` `legal_gate_records` | [delivery.md](delivery.md) の 6 節 |
| Aurora `core` `rider_accounts`・`rider_sessions`・`driver_app_sessions`・`operator_user_sessions`・`passkeys`・`driver_invitations`（`code_hash`、`driver_id`、`expires_at`、`used_at`） | 4 節 |
| Aurora `core` `device_integrity_checks`（`driver_session_id`、`platform`、`verdict`、`checked_at`） | 4 節 |
| Aurora `core` `fraud_scores`（`subject_kind`、`subject_hmac`、`score`、`signals`（理由のコード）、`computed_at`）、`fraud_actions`（`subject`、`action`、`by`、`reason`、`created_at`） | 9 節 |
| S3（log-archive）`audit/{yyyy}/{mm}/…` | Object Lock |

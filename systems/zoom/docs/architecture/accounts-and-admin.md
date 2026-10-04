# Accounts and Admin: Zoom

組織のアカウント、ユーザーとロール、ログインと SSO、会議の既定の設定とその強制（組織・グループ・ユーザーの階層と鍵）、利用状況のレポートの設計。

前提となる決定は、制御の側の基盤（TypeScript、Hono、Aurora PostgreSQL。[ADR-0001](../decisions/0001-platform-and-stack.md)）、待合室かパスコードの不変条件（[ADR-0031](../decisions/0031-waiting-room-and-passcode-rules.md)）。rebuilds の他の題材の決定として、Slack の認証（Better Auth を自前でホストする。Slack の [ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)）と、Auth0 の題材の設計（ID の基盤そのものの再構築。[architecture](../../../auth0/docs/architecture/README.md)）を参照する。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0038](../decisions/0038-organizations-users-roles-and-sso.md) | ユーザーは 1 つの組織だけに属する（メールアドレスごとに 1 人）。ロールは `owner`・`admin`・`member` の 3 つに固定する。ログインと SSO（OIDC・SAML）は Slack の題材と同じく Better Auth を自前でホストし、`identity` のモジュールの境界の外に Better Auth の型を出さない。外部の IdP（Auth0 の題材の成果を含む）へ替える余地を、OIDC の RP としての境界で残す |
| [0039](../decisions/0039-settings-hierarchy-and-locks.md) | 設定は「組織 → グループ → ユーザー → 会議」の順に解決する。上の階層で鍵をかけた項目は、下の階層で変えられない。解決は 1 つの純粋な関数で行い、会議の作成と開催の開始の両方で使う。鍵のかかった安全の項目は、開催の開始のときに解決し直す。どの階層の設定でも、システムの下限（待合室かパスコード）を破れない |
| [0040](../decisions/0040-usage-reports.md) | レポートは Aurora の参加の記録から作る。毎日の集計の表を Worker が作り、画面はそれを読む。S1 ではデータの倉庫（DWH）を持たない。細かい参加の記録は 12 か月、日ごとの集計は 36 か月残す。CSV の書き出しは非同期で S3 に置く |

## 1. 目的と範囲

- 扱う：組織、ユーザー、ロール、招待、ログインの手段、組織の SSO（OIDC・SAML）とドメインの確認、グループ、設定の項目と階層と鍵、会議の設定の解決、利用状況のレポート（利用、会議、参加者、録画の容量）、管理の操作の記録の書き出し。
- 扱わない：ゲスト（アカウントなし）の参加（[signaling-and-meetings.md](signaling-and-meetings.md)、[meeting-security.md](meeting-security.md)）、料金と契約の管理（MVP の外。契約の数は手で管理する）、監査ログの保持と改ざん防止（[security.md](security.md)）、メディアの品質の指標の集め方（[observability.md](observability.md)）、公開 API の OAuth（[api-and-webhooks.md](api-and-webhooks.md)）、SCIM（S2）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 設定の階層 | 組織（Account）・グループ・ユーザーの 3 段で設定し、上で鍵をかけると下で変えられない。組織の鍵はグループでもユーザーでも変えられない。複数のグループに属するときは、鍵をかけた設定が勝つ（[Using tiered settings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0065579)）。複数のグループの鍵がぶつかるときは、グループに加えられた順で決まり、主のグループを選べても他のグループの鍵は効く（同じ文書） | 同じ 3 段＋会議。S1 はユーザーが属するグループを 1 つに限る（ADR-0039） |
| 鍵をかけない設定 | 有効でも鍵をかけていなければ、利用者は自分の設定で無効にできる。パスコードの要件の変更は、既に予定した会議に効かない（[Managing Zoom Meetings passcodes](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063160)） | 鍵のかかった安全の項目は、開催の開始で解決し直す（ADR-0039） |
| 既存のユーザーを組織に加える | 別のアカウントのユーザーを加えるときは、招待のメールを本人が受け入れる必要がある。受け入れると、予定した会議、クラウド録画、チャットの履歴、設定などが移る（個人の連絡先とレポートは移らない）（[Adding existing users](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063217)） | 同じ考え方（4.3 節） |
| 1 つのメールアドレスが属する組織の数 | 公開の一次の資料に明記がない。既存のユーザーを加えると、データが新しいアカウントへ移る（上の行）ので、1 つのアカウントに属する形と読める | 1 つ（ADR-0038） |

いずれも 2026-09-27 に確認。

## 3. 組織とユーザー

ADR-0038。

### 3.1 モデル

```
organizations ─┬─ org_domains（DNS TXT で確かめたドメイン）
               ├─ sso_connections（OIDC・SAML）
               ├─ groups ── group_settings
               ├─ org_settings
               └─ users ─┬─ user_settings
                         ├─ auth_identities・sessions・passkeys（Better Auth。identity のモジュールの中）
                         └─ personal_meeting_ids
```

- **組織**：契約の単位。会議・録画・設定・レポートの持ち主。個人で登録した人にも、1 人だけの組織を作る。
- **ユーザー**：1 つの組織だけに属する。メールアドレス（正規化した小文字）は、有効なユーザーの中で一意。
  - 理由：会議の設定・録画・SSO が組織の単位で決まる。複数の組織に属すると、どの組織の設定と SSO で会議を作るかの判定が、すべての操作に入る。ビデオ会議では「自分の会議」は 1 つの組織の中にあれば足りる。他の組織の会議には、ゲストかその組織の招待で入れる。
- **ゲスト**：アカウントを持たない。会議ごとの `participant_id` と端末の鍵だけ（[meeting-security.md](meeting-security.md) の 6.1 節）。

### 3.2 ロール

| ロール | 人数 | できること |
| --- | --- | --- |
| `owner` | 組織に 1 人 | すべて。`owner` の移転、組織の削除、SSO の必須化の解除 |
| `admin` | 何人でも | ユーザーとグループの管理、設定と鍵、SSO の接続、レポート、録画の管理（保全を含む）、Trust & Safety からの通知の受け取り |
| `member` | 何人でも | 自分の会議・録画・自分の設定（鍵のない項目） |

- 権限の判定は、`authorize(actor, action, resource)` の 1 つの関数に集める（Slack の ADR-0005 と同じ考え方）。ロールと操作の表は E6 の `spec.md` で決定表にする（`DT-ADM-*`）。
- 管理の権限を分けたロール（録画だけの管理者、レポートだけを見る人）は S2 で検討する。

### 3.3 招待とドメイン

- `admin` がメールアドレスで招待する。招待のトークンは 128 ビットの乱数で、7 日で失効する。受けた人がログインすると、組織の `member` になる。
- 既に別の組織に属する人を招待したときは、本人の承諾（元の組織から移ること）を画面で求める。元の組織の会議と録画は、元の組織に残る（持ち主は元の組織の `owner` に移す）。
- **ドメインの確認**：`admin` がドメインを登録し、DNS の TXT レコード（`<brand>-verification=<乱数>`）で確かめる。確かめたドメインは、1 つの組織だけが持てる。
- **確かめたドメインの人**：そのドメインのメールアドレスで新しく登録する人を、その組織に入れる（組織の設定 `domain_capture`：`off`・`invite_only`（承認が要る）・`auto`）。既に別の組織にいる人は動かさない（通知だけ）。

## 4. ログインと SSO

ADR-0038。

### 4.1 手段

| 手段 | S1 | 備考 |
| --- | --- | --- |
| メールの OTP（6 桁、10 分、5 回まで） | ○ | 既定。パスワードは持たない |
| Google（OIDC） | ○ | |
| Microsoft（Entra ID、`common`） | ○ | カレンダーの連携の同意とは別（[scheduling-and-calendar.md](scheduling-and-calendar.md) の 6.2 節） |
| パスキー（WebAuthn） | ○ | |
| 組織の SSO（OIDC） | ○ | |
| 組織の SSO（SAML 2.0） | ○（E6 の後半） | 日本の企業の IdP（Entra ID、Okta、HENNGE One など）で SAML が多いため、S1 に入れる |
| SCIM | S2 | |
| パスワード | × | Slack の題材と同じ理由（漏えい・使い回し・総当たり） |

- 認証の実装は Better Auth（`emailOTP`、ソーシャル、`@better-auth/passkey`、`@better-auth/sso`）。Slack の題材の ADR-0012 の使い方の規則（管理系の操作はサーバーの側で権限を確かめてから `auth.api.*` を呼ぶ、バージョンを固定する、`organization` のプラグインを使わない）を引き継ぐ。SSO のプラグインの権限の脆弱性の前例（Slack の ADR-0012 に記録）があるため、ライブラリの権限の判定に頼らない。
- セッションは Aurora に置き、Cookie は `HttpOnly`・`Secure`・`SameSite=Lax`。アイドル 14 日、絶対 90 日（Slack の題材と同じ値）。

### 4.2 組織の SSO

| 設定 | 値 | 既定 |
| --- | --- | --- |
| `sso_mode` | `off`・`optional`・`required` | `off` |
| 対象 | 確かめたドメインのメールアドレスの人 | — |
| 例外 | `owner` と、指名した 2 人までの `admin`（IdP の障害のときの入口） | `owner` |
| JIT の作成 | IdP でログインした人が組織にいなければ作る（`member`） | 有効 |
| 属性の対応 | IdP の属性（`groups` など）から、組織のグループを決める | なし |

- `required` の組織の人は、メールの OTP・Google・Microsoft・パスキーでログインできない（例外の人を除く）。ログインの画面でメールアドレスのドメインから IdP へ送る。
- IdP 起点の SAML（IdP-initiated）は受けない。`InResponseTo` を検査する。
- 既存のユーザーを SSO の身元に結び付けるのは、メールアドレスのドメインをその組織が確かめている場合だけ（Slack の題材の 2.2 節の 5・6 行目と同じ考え方）。他人のメールアドレスを名乗る IdP で、既存のユーザーを乗っ取らせない。
- SSO でログインした人の会議の参加は、[meeting-security.md](meeting-security.md) の「同じ組織のログインした人」として待合室を省ける。

### 4.3 他の ID の基盤を使う余地

- `identity` のモジュール（`apps/api/src/identity/`）の外には、`user_id`・`org_id`・`auth_context`（手段、SSO の接続、MFA の有無、時刻）だけを出す。Better Auth の型とテーブルを外から参照しない（import の lint）。
- 将来、外部の IdP（Auth0 の題材の成果物、または商用の IdP）に替えるときは、本システムを OIDC の RP にし、`identity` のモジュールの中だけを差し替える。この境界を保つことを ADR-0038 の Confirmation にする。

## 5. 設定と強制

ADR-0039。

### 5.1 項目の定義

設定の項目は、コードの中の 1 つの表（`settingsRegistry`）で定義する。

```ts
// packages/settings/src/registry.ts の形（抜粋）
export const settingsRegistry = {
  "meeting.waiting_room":        { type: "boolean", default: true,  levels: ["org", "group", "user", "meeting"], security: true },
  "meeting.passcode_required":   { type: "boolean", default: true,  levels: ["org", "group", "user", "meeting"], security: true },
  "meeting.passcode_policy":     { type: "object",  default: { charset: "digits", length: 6 }, levels: ["org"], security: true },
  "meeting.join_before_host":    { type: "boolean", default: false, levels: ["org", "group", "user", "meeting"], security: true },
  "meeting.bypass_waiting.org":  { type: "boolean", default: true,  levels: ["org", "group"], security: true },
  "meeting.e2ee_allowed":        { type: "boolean", default: false, levels: ["org", "group"], security: true },
  "chat.mode":                   { type: "enum", values: ["everyone", "hosts_only", "off"], default: "everyone", levels: ["org", "group", "user", "meeting"] },
  "chat.save_after_meeting":     { type: "boolean", default: false, levels: ["org", "group"] },
  "recording.cloud":             { type: "enum", values: ["enabled", "disabled"], default: "enabled", levels: ["org", "group", "user"] },
  "recording.retention_days":    { type: "int", min: 1, max: 3650, nullable: true, default: 365, levels: ["org"] },
  "recording.external_share":    { type: "boolean", default: false, levels: ["org", "group"], security: true },
  "captions.live":               { type: "enum", values: ["enabled", "disabled"], default: "enabled", levels: ["org", "group", "user"] },
  "pmi.allowed":                 { type: "boolean", default: true,  levels: ["org", "group"] },
  // ...
} as const;
```

- `levels` は、その項目を置ける階層。`security: true` の項目は、開催の開始で解決し直す（5.3 節）。
- 項目の名前はこの表の名前を正とする。他の文書の短い呼び名（`save_chat`、`cloud_recording` など）との対応は [data-model.md](data-model.md) の 7 節にある。
- 項目を足す・変える PR は、この表と、解決の関数の性質ベーステストを通す。

### 5.2 解決の規則

項目 K の、ある会議での値を決める。上から順に評価し、最初に一致した行を採る（決定表の草案。`DT-ADM-SET-*`）。

| # | 組織の鍵 | グループの鍵 | 会議の値 | ユーザーの値 | グループの値 | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | あり | - | - | - | - | 組織の値 |
| 2 | なし | あり | - | - | - | グループの値 |
| 3 | なし | なし | あり | - | - | 会議の値 |
| 4 | なし | なし | なし | あり | - | ユーザーの値 |
| 5 | なし | なし | なし | なし | あり | グループの値 |
| 6 | なし | なし | なし | なし | なし | 組織の値（なければ `default`） |

- 鍵は「値を固定する」だけでなく、「この値より弱くできない」の形も持てる（例：パスコードの長さの最小）。S1 は固定だけにし、最小・最大の形は MVP の後（11 節）。
- 解決の後に、システムの下限を当てる。`waiting_room = false` かつ `passcode_required = false` になったら、どちらの階層の組み合わせでも 422 `waiting_room_or_passcode_required`（ADR-0031）。組織の設定の画面では、両方を無効にする組み合わせを保存させない。
- ユーザーが属するグループは S1 では 0 か 1。複数のグループと優先度は S2（本家の形。2 節）。

### 5.3 いつ解決するか

| 時点 | 解決する項目 | 理由 |
| --- | --- | --- |
| 会議の作成・更新 | すべて | 画面と API で、選べない値を示す |
| 開催の開始（Actor の Open） | `security: true` の項目 | 予定の後で管理者が鍵をかけた安全の設定を、既に予定した会議にも効かせる |
| 開催の間 | 変えない | 会議の途中で設定が変わると、参加者に分かりにくい。例外は `meeting.e2ee_allowed` を偽にしたとき（次の開催から） |

- 本家は、パスコードの要件の変更が既に予定した会議に効かない（2 節）。この設計は、鍵のかかった安全の項目については効かせる。既に配った招待のパスコードが組織の新しい規則に合わない場合は、開催の開始のときにパスコードを作り直さず、会議の設定を保つ（招待を壊さない）。作り直しが要るかは、主催者に知らせて任せる。
- 解決した値は、`meeting_instances.effective_settings` に写して残す（後から「この会議はどの設定で開かれたか」を答えるため）。

### 5.4 管理の画面と API

- `GET /v1/orgs/{org}/settings`、`PATCH ...`（値と鍵）、`GET /v1/groups/{g}/settings`、`GET /v1/users/{u}/settings`（解決した値と、どの階層で決まったか）。
- 変更は `admin_audit_events` に、前と後の値と共に書く（security.md の監査ログ）。

## 6. 利用状況のレポート

ADR-0040。

### 6.1 レポートの種類

| レポート | 中身 | もと |
| --- | --- | --- |
| 利用の概要 | 日ごとの会議の数、会議の分、参加者の数、アクティブなユーザーの数 | `usage_daily` |
| ユーザーごと | 主催した会議の数と分、参加した会議の数と分 | `usage_user_daily` |
| 会議の一覧と詳細 | 題名、主催者、開始・終了、参加者の一覧（名前、参加・退出、参加のしかた、端末の種類、品質の要約） | `meeting_instances`、`meeting_participations`、`participant_quality_summaries`（observability.md） |
| 録画の容量 | 組織・ユーザーごとの容量と件数 | `recordings`、`recording_files` |
| 安全 | 待合室・パスコードの状態、報告の件数、`host.suspend` の件数 | `meetings`、`abuse_reports`、`meeting_audit_events` |
| 管理の操作 | 設定の変更、ユーザーの追加・削除、SSO の変更 | `admin_audit_events` |

- 会議の中身（チャットの本文、字幕の文字、録画）は、レポートに入れない。
- ゲストの参加者は、表示の名前と参加の時刻だけを出す。IP は出さない（Trust & Safety の報告の対処だけで使う）。

### 6.2 作り方

- 会議が終わると、Actor が参加の記録を閉じる（`meeting_participations.left_at`）。Worker は毎時、終わった会議を集計して `usage_daily`・`usage_user_daily` に足す（冪等に、`instance_id` ごとに 1 回）。
- 画面は、集計の表と、会議の詳細（1 会議ずつ）だけを読む。期間の指定は最大 1 年（詳細は 1 か月ごと）。
- 大きな書き出し（CSV）は、`POST /v1/orgs/{org}/reports/exports` で受け、Worker が S3 に書き、署名付きの URL（24 時間）を通知する。書き出しのファイルは 7 日で消す。
- 集計の問い合わせは、Aurora のリーダー（読み取りの複製）に向ける。本線の書き込みに影響させない。

### 6.3 保持

| データ | 保持 |
| --- | --- |
| `meeting_participations`（1 人 1 回の参加の行） | 12 か月 |
| `usage_daily`・`usage_user_daily` | 36 か月 |
| 品質の要約 | 12 か月（observability.md） |
| 書き出しのファイル | 7 日 |

- 保持の期間は、L6・L8 の結論で見直す。本家は、会議のチャットを既定で収集から 24 か月、会議の診断のデータを 15 か月残し、クラウド録画は利用者のアカウントがある間残す（[Zoom Meetings, Webinar, and Chat Data Retention Standard](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0074786)、2026-09-27 に確認）。

## 7. 障害のときの振る舞い

| 障害 | 起きること | 対処 |
| --- | --- | --- |
| 組織の IdP が止まった | `required` の組織の人がログインできない | 例外の `admin` が OTP で入り、`sso_mode` を一時的に `optional` にする（runbook）。既に入っている会議と、ゲストとしての参加は影響なし |
| SAML の証明書の期限切れ | 同上 | 期限の 30・7・1 日前に `admin` に知らせる |
| 設定の解決の不具合 | 誤った設定で会議が開かれる | 解決の関数を性質ベーステストで守る。`effective_settings` で影響を受けた会議を洗い出せる |
| 集計の Worker の遅れ | レポートが古い | 画面に「最終の集計の時刻」を出す。会議の詳細は Aurora から直接読むので遅れない |
| Aurora のリーダーの遅れ | レポートが数秒古い | 受け入れる |

## 8. セキュリティとプライバシー

- 管理の操作は、`admin` 以上に限り、`authorize` を通す。操作は `admin_audit_events` に書く。
- SSO の接続の登録と変更は、サーバーの側で権限を確かめてから Better Auth の API を呼ぶ（4.1 節）。
- ドメインの確認のトークンを、ログに出さない。
- 組織の削除：`owner` だけ。30 日の猶予の後、会議・録画・チャット・参加の記録・設定を消す。消したことの記録（組織の ID、日時、実行者）だけを残す。削除の範囲と期間は L6・L8 で見直す。
- ユーザーの削除：`admin` が行う。ユーザーの会議と録画は、指定した別のユーザーに移すか消す。参加の記録の中の名前は「削除されたユーザー」に置き換える。
- レポートに、会議の中身を入れない（6.1 節）。

## 9. テスト

### 9.1 性質ベーステスト

- **PROP-ADM-001（鍵）**：任意の階層の値と鍵の組み合わせで、組織で鍵をかけた項目の解決の値は、常に組織の値と一致する。グループの鍵も同様（組織の鍵がないとき）。
- **PROP-ADM-002（下限）**：任意の組み合わせで、解決した設定が「待合室もパスコードもない」になることはない（保存の時点で拒否される）。
- **PROP-ADM-003（単調）**：鍵のない階層の値を変えても、それより上で鍵のかかった項目の解決の値は変わらない。
- **PROP-ADM-004（集計）**：任意の参加の記録の列で、`usage_daily` の会議の分の合計は、`meeting_participations` から直接計算した値と一致する（冪等な集計）。

### 9.2 決定表

- 5.2 節の解決の表（`DT-ADM-SET-*`）、ロールと操作の表（`DT-ADM-*`）、4.2 節の SSO の結び付けの規則。

### 9.3 結合

- Entra ID と Okta の試験のテナントで、SAML と OIDC のログイン、JIT、`required` の強制、例外の `admin` の入口を確かめる。
- 管理者が鍵をかけた後、既に予定した会議の開催の開始で、安全の項目が解決し直されることを確かめる。

## 10. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E2 | `org-user-model` | 3.1・3.2 節。組織、ユーザー、ロール、`authorize`（E2 のベータの主催者のログインに要るので、E6 から前に出した） |
| E2 | `identity-better-auth` | 4.1 節。OTP、Google、Microsoft、パスキー、セッション（同上） |
| E6 | `invitations-and-domain-capture` | 3.3 節。招待、ドメインの確認、`domain_capture` |
| E6 | `org-sso-oidc` | 4.2 節。OIDC、JIT、`required`、例外 |
| E6 | `org-sso-saml` | 4.2 節。SAML、`InResponseTo`、証明書の期限の通知 |
| E6 | `settings-registry-and-resolver` | 5.1〜5.3 節。解決の関数、性質ベーステスト |
| E6 | `settings-admin-ui-and-api` | 5.4 節 |
| E6 | `groups` | グループと、グループの設定 |
| E6 | `usage-reports` | 6 節。集計、画面、CSV の書き出し |
| E12 | `org-deletion-and-user-offboarding` | 8 節の削除 |
| E12 | `scim-provisioning` | S2 の SCIM（GA の判定に要るなら） |

## 11. 未解決の問い

### 決定

2026-09-27 に推奨案で確定した（[README.md](README.md) の 6 節の「決定（2026-09-27、推奨案で確定）」）。

- **ユーザー**：1 つの組織だけに属する。メールアドレスごとに 1 人。
- **ロール**：`owner`・`admin`・`member` の 3 つに固定。
- **認証**：Better Auth を自前でホスト（Slack の題材と同じ）。SAML も S1 に入れる。SCIM は S2。
- **外部の IdP へ替える余地**：`identity` のモジュールの境界で残す。
- **設定**：組織 → グループ → ユーザー → 会議。鍵は固定だけ。ユーザーのグループは 1 つまで。安全の項目は開催の開始で解決し直す。
- **レポート**：Aurora と毎日の集計。DWH なし。参加の記録は 12 か月、集計は 36 か月。
- **MVP の後に回すもの**：1 人が複数の組織に属すること、鍵の最小・最大の形、複数のグループと優先度、分けた管理のロール、料金と契約の管理（[roadmap.md](../roadmap.md) の延期の一覧）。要るときは新しい ADR にする。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 委託の契約（DPA）、サブプロセッサーの一覧、開示・削除の請求の窓口（L8） | 法務の確認の後。E12 の GA の判定の前 |
| 参加の記録と集計の保持の期間（L6） | 法務の確認の後 |
| Auth0 の題材の成果物を ID の基盤として使うか | Auth0 の題材が実装されてから検討する。今は境界だけ保つ |

## 12. quality.md・runbooks・data-model への項目

### quality.md

- ログインの成功率と時間（手段ごと、SSO の IdP ごと）。
- 設定の解決の性質ベーステストの列の数（PR ごとに 1 万）。
- `effective_settings` と、組織の鍵の設定の不一致の件数（毎日の監査で 0）。
- レポートの集計の遅れ（会議の終了から `usage_daily` に入るまで）。
- CSV の書き出しの時間（1 か月・1 万人の組織で）。

### runbooks

- `sso-idp-outage.md`：組織の IdP が止まったときの、例外の `admin` による `sso_mode` の一時的な変更と、戻す手順。
- `saml-certificate-expiry.md`：SAML の証明書の期限切れの前の連絡と、入れ替えの手順。
- `settings-misresolution.md`：誤った設定で開かれた会議を `effective_settings` で洗い出し、組織に知らせる手順。
- `org-deletion.md`：組織の削除の猶予、実行、確かめ方。
- `usage-rollup-backfill.md`：集計が止まったときの、`instance_id` ごとの冪等な集計のやり直し。

### data-model（索引への追加の提案）

確定した形は [data-model/identity.md](data-model/identity.md) と [data-model/governance.md](data-model/governance.md) にある。

| 置き場所 | 中身 |
| --- | --- |
| Aurora `organizations` | `org_id`、`name`、`owner_user_id`、`sso_mode`、`domain_capture`、`status`、`deleted_at`、`purge_after` |
| Aurora `org_domains` | `org_id`、`domain`（一意）、`verification_token_hash`、`verified_at` |
| Aurora `users` | `user_id`、`org_id`、`email`（正規化、有効なものの中で一意）、`display_name`、`role`（`owner`・`admin`・`member`）、`group_id?`、`status`（`active`・`suspended`・`deleted`）、`timezone`、`created_at` |
| Aurora `invitations` | `org_id`、`email`、`role`、`token_hash`、`expires_at`、`accepted_at`、`revoked_at` |
| Aurora `sso_connections` | `org_id`、`protocol`（`oidc`・`saml`）、Better Auth の `sso_providers` の ID、`jit`、`attribute_map`、`cert_expires_at` |
| Aurora `groups` | `group_id`、`org_id`、`name` |
| Aurora `org_settings`・`group_settings`・`user_settings` | `(org_id, key)`・`(org_id, group_id, key)`・`(org_id, user_id, key)`、`value`（JSON）、`locked`（組織とグループだけ）、`updated_by`、`updated_at` |
| Aurora `meeting_instances`（列の追加） | `effective_settings`（開催の開始で解決した値） |
| Aurora `usage_daily`・`usage_user_daily` | `org_id`（・`user_id`）、`day`、`meetings`、`meeting_minutes`、`participants`、`participant_minutes` |
| Aurora `report_exports` | `export_id`、`org_id`、`kind`、`params`、`status`、`s3_key`、`expires_at` |
| Aurora `admin_audit_events` | 管理の操作（security.md で保持を決める） |
| Better Auth のテーブル（`identity` の中） | `auth_users`（Better Auth の `user`。`users` と同じ ID で 1 対 1。メールアドレスの一意はここで判定する）、`auth_identities`、`sessions`、`verifications`、`passkeys`、`sso_providers`（Slack の題材と同じ改名） |

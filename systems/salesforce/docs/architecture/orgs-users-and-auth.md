# Orgs, users and auth: Salesforce

組織（作成、状態、削除）、エディションとライセンス、利用者（作成、無効化、凍結）、ログイン（パスワード、MFA、SSO）、セッション、API の認証（OAuth）、組織のドメイン、システムの権限の一覧と、権限を渡す規則の設計。土台は [ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)（組織は `org_id` と RLS で分け、ホスト名かトークンから DB を読む前に組織を決める）、[ADR-0013](../decisions/0013-permission-sets-and-field-level-security.md)（権限は権限セットの和、プロファイルは既定値の入れ物）。この文書で決めたことは、次の 3 つの ADR にある。

- 組織は `kind`（`production`・`sandbox`・`trial`・`developer`）と状態を持ち、削除は 30 日の猶予の後に消す。エディションは 5 つで、上限（トランザクション）は変えず、割り当て・機能・Sandbox の数だけを変える。ライセンスは `full`・`platform`・`integration` の 3 つで、ライセンスが権限の上限になる。利用者は消さずに無効にする（[ADR-0043](../decisions/0043-orgs-editions-licenses-and-users.md)）。
- ログインは、他の題材と同じく自前でホストする Better Auth にする。組織ごとに SAML・OIDC の SSO（利用者の IdP）を持てる。rebuilds の Auth0 の題材を本システムの IdP にはしない（組織の IdP の 1 つとしてなら、普通の OIDC でつなげる）。SSO 以外のログインは MFA を必須にする。API は OAuth 2.0（認可コード＋PKCE、クライアントクレデンシャル）で、画面の API はセッションの Cookie だけで通る（[ADR-0044](../decisions/0044-authentication-better-auth-sso-and-mfa.md)）。
- システムの権限の一覧をこの文書の 7 節に置く（25）。他の領域から依頼のあった `convert_leads`・`edit_converted_leads`・`manage_public_list_views`・`view_my_team_dashboards`・`schedule_reports_for_others`・`manage_report_folders` を含む。権限を渡す人は、自分の持たない権限を渡せず、自分より強い利用者を操作できない（部分集合の規則）。最後の管理者を無くせない（[ADR-0045](../decisions/0045-system-permissions-and-delegation.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 組織の作成・状態・削除、組織の設定（言語、時間帯、通貨、会計年度） | Sandbox の組織の作り方（[sandboxes-and-deploy.md](sandboxes-and-deploy.md)） |
| エディション、ライセンス、機能の出し分け | 割り当ての値（[governor-limits.md](governor-limits.md) の 8 節） |
| 利用者の作成・招待・無効化・凍結・匿名化 | 権限セット・プロファイル・ロールの判定（[sharing-and-record-access.md](sharing-and-record-access.md)） |
| ログイン（パスワード、MFA、パスキー、SSO）、セッション、ログインの制限 | ログインの履歴の保存と保持（[audit-and-field-history.md](audit-and-field-history.md)） |
| API の認証（OAuth のクライアント、トークン） | 外向きの呼び出しの認証（[events-and-integrations.md](events-and-integrations.md)） |
| 組織のドメイン、組織の解決 | 独自のドメイン（MVP の後）、証明書の運用（infrastructure の領域） |
| システムの権限の一覧、権限を渡す規則 | 脅威モデルと鍵の階層（security の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| エディションと価格（日本） | Free Suite 0 円、Starter Suite 3,000 円、Pro Suite 12,000 円、Core 23,400 円、Advanced 47,400 円、Max 66,000 円（ユーザーあたり月額、年間契約）。機能の差のうち、API の割り当て、Sandbox の数、カスタムオブジェクト・項目・入力規則の数はエディション（Enterprise・Unlimited など）ごとの表で確かめた。価格の段とエディションの対応は価格のページだけでは読めない | intent に記載（[Sales Cloud の価格](https://www.salesforce.com/jp/sales/pricing/)、[Salesforce Enterprise Edition Allocations](https://help.salesforce.com/s/articleView?id=xcloud.overview_limits_enterprise.htm&type=5)、2026-09-28 に確認） |
| API の割り当て | Enterprise は 100,000＋ライセンス × 1,000。Unlimited は 1 ライセンス 5,000。ライセンスの種類ごとに API の数が違う（連携の外部の利用者の種類など） | [Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)（以下「Limits」） |
| 権限の形 | 権限セットの `userPermissions` に、アプリとシステムの権限（例：「API の有効化」`ApiEnabled`、`ViewSetup`、`ManageUsers`）を持つ | [Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)（Winter '27 版、以下「MDAPI」）の PermissionSet |
| 権限の全体の一覧 | 本家のシステムの権限の全ての一覧は、公開の開発者の資料に見当たらない（未検証。E4 の `system-permissions-and-delegation` の着手の時に、移行の文書のために試用の組織で確かめる）。「リードの変換」「変換済みのリードの参照・編集」「公開のリストビューの管理」「自分のチームのダッシュボードの参照」「他の人のレポートの定期の実行」「レポートのフォルダの管理」は、各領域の文書に書いた本家の振る舞いから読める | 各領域の文書 |
| ログインの履歴 | 組織の全ての成功・失敗のログインの試みを表す | [Object Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/object_reference.pdf)（Winter '27 版）の LoginHistory |
| MFA の必須 | 本番と Sandbox の全ての社内の利用者に MFA を求める。特権を持つ利用者はパスキーだけ。2026 年から SSO のログインにも MFA を強制する（Sandbox は 2026-07-10 から） | [MFA for Direct Salesforce Logins](https://help.salesforce.com/s/articleView?id=xcloud.mfa_direct_logins_overview.htm&type=5)、[Prepare for MFA Enforcement for All Employee Users](https://help.salesforce.com/s/articleView?id=005321561&type=1)（2026-09-28 に確認） |
| 組織のドメイン | 組織ごとの `My Domain` のホスト名を持つ。形の細部は本家の名前を含むので書かない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)） | — |
| 利用者の名前 | 利用者の名前（username）はメールの形で、全ての組織で一意 | [Object Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/object_reference.pdf)（Winter '27 版の User、2026-09-28 に確認） |

## 3. 組織（ADR-0043）

### 3.1 形

```
orgs(org_id, name, kind, edition, status, migrating, shard_no, region, my_domain,
     parent_org_id, sandbox_name, sandbox_kind, copied_at, refresh_available_at,
     locale, timezone, currency, fiscal_year_start_month,
     metadata_version, trial_ends_at, created_at, deletion_requested_at, purge_after)
```

| 列 | 値 |
| --- | --- |
| `kind` | `production`、`sandbox`（`parent_org_id` あり）、`trial`（30 日）、`developer`（無料、小さな割り当て） |
| `status` | `provisioning` → `active` ⇄ `read_only`（未払い・容量の超過）、`suspended`（利用規約の違反。ログイン不可）→ `deleting` → 消去。Sandbox は複製の間 `provisioning`（進みは `sandbox_requests.state`） |
| `migrating` | 補助の状態（真偽）。組織の移動の書き込みの止めの間だけ真にし、書き込みの要求を 503 `ORG_MIGRATING`（`Retry-After`）で断る。読みは続ける。`status` とは別に持ち、どの `status` とも組み合わさる（2026-09-28。infrastructure の領域の依頼、[ADR-0056](../decisions/0056-org-migration-by-row-filtered-logical-replication.md)） |
| `parent_org_id`、`sandbox_name`、`sandbox_kind`、`copied_at`、`refresh_available_at` | Sandbox の組織だけ。元の本番、Sandbox の名前と種類（`developer`・`developer_pro`・`partial`・`full`）、複製の時刻、次に再作成できる時刻（[sandboxes-and-deploy.md](sandboxes-and-deploy.md) の 3・4 節） |
| `locale`・`timezone`・`currency` | 既定 `ja_JP`・`Asia/Tokyo`・`JPY`（intent の MVP は JPY と日本語・英語） |
| `fiscal_year_start_month` | 既定 4。問い合わせの言語の会計年度の関数（[ADR-0018](../decisions/0018-record-query-language.md)）が使う |
| `region` | S1 は `ap-northeast-1` だけ（ADR-0005） |

- `orgs` は、組織の解決のために RLS の外で読む表で、組織の作成・状態の変更は組織をまたぐ管理のサービスだけが書く（ADR-0005）。

### 3.2 作成

```
POST /signup（公開の申し込み）か、社内の営業の操作
  1. メールの確認（6 桁の番号。10 分）
  2. 組織の作成（管理のサービス、1 つのトランザクション）：
       orgs（kind = trial、shard_no を決める。ADR-0010）
       種：標準オブジェクトのデータ辞書、既定のフェーズ・リードの状態、標準のプロファイルと基本の権限セット、
           標準のレポートの型、既定のページレイアウト・リストビュー
       最初の利用者（システム管理者のプロファイル、full のライセンス）
  3. 全ての部品をコンパイルして L2 に置く（metadata-and-runtime.md の 4.5 節。30 秒以内）
  4. my_domain を有効にし、最初の利用者に MFA の登録を求めてログインさせる
```

- 標準のプロファイル：`system_admin`（全てのシステムの権限）、`standard_user`（標準オブジェクトの読み書き、`api_enabled` なし）、`read_only`、`integration`（`integration` のライセンス用。画面のログインなし）。
- intent の K8（1 万件を取り込んでリストビューで見るまで中央値 30 分）のため、作成から最初のログインまでを 2 分以内にする。
- 法務の L1・L7（委託か、DPA の雛形）の結論まで、E2 の組織の作成の利用規約の spec を承認しない（intent）。

### 3.3 削除

- 管理者（`customize_application` と `manage_users` の両方）が削除を申し込むと、`deleting` にし、`deletion_requested_at` から **30 日の猶予**を置く。猶予の間は、管理者だけがログインでき、データの書き出し（一括の問い合わせ、メタデータの書き出し）だけができる。取り消せる。
- 猶予の後、組織の全ての行（主のクラスタの全ての表、`events` のクラスタ、`history` のクラスタの履歴、監査）、S3 のファイル、検索の文書、Valkey の鍵を消し、**最後に組織の DEK（`org_keys`）を破棄する**（security の領域の依頼。[security.md](security.md) の 7.1 節、[ADR-0052](../decisions/0052-key-hierarchy-and-per-org-data-keys.md)）。消し終えるまで 7 日以内にし、消し終えたことを `org_purge_log`（組織の ID のハッシュと日時だけ。RLS の外）に残す。
- 監査のログの外部の保管（[audit-and-field-history.md](audit-and-field-history.md) の 3.4 節）も、保持の期間を待たずに組織の分を消すかは、法務の L5・L7 で決める。既定は「消す」。
- Sandbox は元の本番と一緒に消す（[sandboxes-and-deploy.md](sandboxes-and-deploy.md) の 4.5 節）。
- 猶予と期限は既定案で、法務の L7 の結論で変わりうる。

## 4. エディション（ADR-0043）

| エディション | 本家の近い段（目安） | 画面の機能 | API・一括・変更のイベント | カスタムオブジェクト | Sandbox（developer・developer_pro・partial・full） |
| --- | --- | --- | --- | --- | --- |
| `starter` | Starter Suite | 標準オブジェクト、レイアウト、リストビュー、レポート | なし | 10 | 0・0・0・0 |
| `pro` | Pro Suite | ＋フロー（保存の前後）、承認、ダッシュボード | あり | 50 | 1・0・0・0 |
| `enterprise` | Core・Advanced | ＋全てのフロー、共有ルール、カスタムのレポートの型、Webhook | あり | 200 | 25・5・1・0 |
| `unlimited` | Max | 同じ（割り当てが大きい） | あり | 800 | 100・5・1・1 |
| `developer` | Developer Edition | `enterprise` と同じ機能 | あり | 50 | 0 |

- **トランザクションの上限はエディションで変えない**（ADR-0005）。変えるのは、割り当て（[governor-limits.md](governor-limits.md) の 8.1 節）、機能の出し分け、カスタムオブジェクトの数、Sandbox の数だけ。
- 機能の出し分けは、組織の「機能の組」（`org_features`）で持ち、メタデータの保存と API の入口で確かめる。エディションの上げ下げで組を入れ替える。下げで使えなくなる設定（例：共有ルール）は、下げの前に一覧を見せ、消さずに無効にする。
- 本家の段との対応と、各段の機能と価格は、**E2 の着手前に PM が決める**（intent）。上の表は既定案。

## 5. ライセンスと利用者（ADR-0043）

### 5.1 ライセンス

| ライセンス | 使えるもの | 画面のログイン | 組織の数 |
| --- | --- | --- | --- |
| `full` | 全ての標準オブジェクト（取引先、取引先責任者、リード、商談、活動）とカスタムオブジェクト | あり | 契約の数 |
| `platform` | カスタムオブジェクト、取引先・取引先責任者の読み、活動。リード・商談は使えない | あり | 契約の数 |
| `integration` | API だけ。権限セットで与えた範囲 | なし（OAuth のクライアントクレデンシャルだけ） | 組織 5 まで無料、以後は契約 |

- **ライセンスが権限の上限になる。** 権限セットは、割り当てられるライセンスの種類（`permission_sets.license`、空なら全て）を持つ。`platform` の利用者に、リード・商談の権限を持つ権限セットを割り当てられない（保存の時に検査）。
- 有効な利用者の数がライセンスの数を超える作成・有効化は断る（`LICENSE_LIMIT_EXCEEDED`）。
- 本家のライセンスの種類（Salesforce、Salesforce Platform、連携用）に寄せた（Limits にライセンスの種類ごとの API の数がある）。連携用のライセンスの無料の数は、読めた資料に書かれていない（未検証。E2 の `licenses-and-permset-license` の着手の前に PM がエディションと合わせて決める）。

### 5.2 利用者

```
users(org_id, user_id, auth_subject_id, username, email, email_verified_at,
      last_name, first_name, last_name_kana, first_name_kana, phone,
      profile_id, role_id, manager_id, license, status,
      locale, timezone, federation_id, is_integration, sso_bypass, created_at, deactivated_at, anonymized_at)
```

| 状態 | 意味 |
| --- | --- |
| `invited` | 招待のメールを送った。まだログインしていない |
| `active` | ログインでき、ライセンスを使う |
| `frozen` | 一時的にログインを止める（調査中など）。ライセンスは使ったまま。セッションとトークンを失効する |
| `deactivated` | ログインできない。ライセンスを返す。レコードの所有者・作成者としては残る |

- **利用者は消さない。** レコードの `owner_id`・`created_by` などが指すため。無効にする。
- 無効にする時：全てのセッションと OAuth のトークンを失効する。キューとグループの直接のメンバーから外し、閉包を直す（[sharing-and-record-access.md](sharing-and-record-access.md) の 4.4 節）。所有するレコードはそのまま（所有者の付け替えは管理者の一括の操作）。承認の作業の項目は、プロセスの管理者に付け替えを知らせる。
- **匿名化**（法務の L1 の本人の請求）：無効の利用者の氏名・カナ・メール・電話を `匿名の利用者 <短い ID>` に置き換え、`anonymized_at` を入れる。監査・履歴の利用者の表示もこの名前になる（履歴の行は利用者の ID で持つため）。
- `username` はメールの形で、**全ての組織で一意**にする（共通のログインの画面で、名前から組織を決めるため。6.2 節）。`email` は組織をまたいで同じでもよい（同じ人が複数の組織の利用者になれる）。
- `manager_id` は承認の `manager_of_submitter`（[automation-flows.md](automation-flows.md) の 8.5 節）と、ロール階層とは別の上司の関係に使う。
- 利用者の作成・変更は `manage_users`。7.2 節の渡す規則に従う。
- **サポートのアクセスの許可**：組織の管理者（`manage_users`）は、Setup で本システムの運用者に、期限（1〜7 日）とオブジェクトの範囲を決めてレコードの読みを許せる（`support_access_grants`。security の領域の依頼、[security.md](security.md) の 6 節、[ADR-0053](../decisions/0053-operator-access-and-data-lifecycle.md)）。許可・取り消し・運用者の操作は、組織の監査に残る。

## 6. ログインと認証（ADR-0044）

### 6.1 部品

- **Better Auth を自前でホストする。** Slack・GitHub・Notion の再構築と同じ部品と使い方の規則にする（[slack の ADR-0012](../../../slack/docs/decisions/0012-self-hosted-auth-with-better-auth.md)、[github の ADR-0019](../../../github/docs/decisions/0019-authentication-and-token-model.md)）：Better Auth は「だれか」（認証の手段、セッション、パスキー、MFA、SSO の接続）だけを持つ。組織・利用者・権限は自前の表で持つ。`organization` プラグインは使わない。公開するエンドポイントは許可したものだけ。版を固定する。
- **rebuilds の Auth0 の題材を、本システムの IdP にはしない。** 設計の記録だけで動く製品がまだなく、2 つの作りかけの題材を結ぶと、片方の遅れがもう片方を止める。組織が Auth0（本家）や他の IdP を使うなら、普通の OIDC・SAML の SSO としてつなげる（6.4 節）。
- Better Auth の表（`identity` のスキーマ：`auth_users`、`auth_accounts`、`auth_sessions`、`passkeys`、`two_factors`、`sso_providers`）は、組織の解決の前に使うので RLS の外に置き、認証のサービスのロールだけが読み書きする。各行は `org_id` の列を持ち、組織の利用者（`users.auth_subject_id`）と 1 対 1 に結ぶ。1 人の人が 2 つの組織の利用者なら、認証の主体も 2 つ（別の `username`）。

### 6.2 ログインの画面と組織の解決

| 入口 | 組織の決め方 |
| --- | --- |
| `https://<org>.my.<brand>.<domain>/login` | ホスト名（ADR-0005）。その組織の SSO の設定を出す |
| `https://login.<brand>.<domain>` | 入力した `username` から組織を決める（`username` は全ての組織で一意） |
| `https://<org>--<sandbox>.sandbox.my.<brand>.<domain>` | Sandbox のホスト名（[sandboxes-and-deploy.md](sandboxes-and-deploy.md) の 3 節） |

- 未知のホスト名は、DB を読まずに 404（ADR-0005）。ホスト名から組織への対応は、エッジの近くのキャッシュ（Valkey）と `orgs.my_domain` の索引で引く。

### 6.3 パスワードと MFA

**DT-AUTH-001：ログインの手段と MFA**（上から評価）

| # | 組織の設定 | 利用者 | 手段 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | - | `frozen`・`deactivated` | - | 拒否（失敗の理由を画面で区別しない） |
| 2 | - | `integration` のライセンス | 画面のログイン | 拒否 |
| 3 | SSO を必須 | `sso_bypass` なし | パスワード | 拒否（SSO へ案内） |
| 4 | - | 特権あり | パスワード | パスワードの後にパスキーを求める。未登録なら登録するまで他の画面に進めない。TOTP と回復の番号は受け付けない |
| 5 | SSO の MFA の確かめ：有効（既定） | 特権なし | SSO（SAML・OIDC） | IdP の主張（`amr`・`AuthnContextClassRef`）が接続の受け入れの一覧（MFA）にあれば受け入れる。なければ SSO の後に本システムの 2 つ目の要素（TOTP、パスキー、回復の番号。未登録なら登録）を求める |
| 6 | SSO の MFA の確かめ：有効（既定） | 特権あり | SSO（SAML・OIDC） | 主張が受け入れの一覧（フィッシングに強い）にあれば受け入れる。なければ SSO の後にパスキーを求める |
| 7 | SSO の MFA の確かめ：無効（理由を記録） | 特権なし | SSO（SAML・OIDC） | IdP の認証を受け入れる（主張を記録する） |
| 8 | SSO の MFA の確かめ：無効（理由を記録） | 特権あり | SSO（SAML・OIDC） | 行 6 と同じ（無効の設定は特権を持つ利用者に効かない） |
| 9 | - | MFA の登録なし | パスワード | パスワードの後に MFA の登録を必須にする（登録するまで他の画面に進めない） |
| 10 | - | MFA の登録あり | パスワード | パスワード＋MFA（TOTP、パスキー、回復の番号） |
| 11 | - | パスキーの登録あり | パスキー | 受け入れる（パスキーだけで MFA を満たす） |

「特権あり」は特権を持つ利用者（`modify_all_data`・`manage_users`・`customize_application` のどれかを持つ利用者。管理者はこれに当たる）。`sso_bypass` の非常用の管理者も含む。

- **全ての画面のログインで MFA を確かめる。** パスワードのログインは MFA を必須にし、外せる設定を持たない。SSO は IdP の主張を確かめ、確かめられなければ本システムの 2 つ目の要素を求める（6.4 節）。**特権を持つ利用者はパスキーだけ**にする。本家の 2026 年の方針（SSO を含む MFA の強制、特権を持つ利用者のパスキー）に揃えた（2 節、ADR-0044 の注記）。
- 特権を持つ権限（`modify_all_data`・`manage_users`・`customize_application`）を得た利用者は、既存のセッションを切り、次のログインでパスキーの登録を求める。パスキーを失った時は、別の特権を持つ利用者が MFA を解除し（DT-AUTH-002 の行 5、監査）、登録し直す。
- MFA の手段は TOTP、パスキー（WebAuthn）、回復の番号（10 個、1 回ずつ）。SMS は持たない（なりすましに弱いため。GitHub の再構築と同じ）。
- パスワード：12 文字以上、漏えいした既知のパスワードの一覧（手元に置いた一覧。外部の API に送らない。法務の L2）にあれば拒否。同じ `username` の 10 回の失敗で 30 分止める（`limit_login`）。組織が長さ・期限を強められる。
- **ログインの制限**：プロファイルのログインの時間帯と IP の範囲（[sharing-and-record-access.md](sharing-and-record-access.md) の 3.1 節）を、ログインの時と、セッションの要求ごと（IP だけ）に確かめる。外れたら 403 とログアウト。
- ログインの試み（成功・失敗・MFA・SSO）は全て、ログインの履歴に書く（[audit-and-field-history.md](audit-and-field-history.md) の 4 節）。

### 6.4 SSO

- 組織ごとに、SAML 2.0 と OIDC の接続を持てる（Better Auth の `@better-auth/sso`）。接続の登録・変更は、本システムの管理の API で `manage_auth_settings` を確かめてから、サーバー側で呼ぶ（Better Auth の権限の判定に頼らない。slack の ADR-0012 の規則）。
- 利用者の対応：IdP の `NameID`・`sub` を `users.federation_id` と合わせる。合わない時は拒否する（既定）。組織の設定で「初めての時に作る」（JIT）を有効にでき、その時はプロファイル・権限セットの既定と、IdP の属性からの対応を設定で持つ（渡せる権限は、設定した管理者の権限の部分集合。7.2 節）。
- SAML は IdP 起点のログインを既定で断り、`InResponseTo` を検査する。署名と暗号の鍵は組織ごと。
- **SSO の MFA の確かめ**：SSO の接続ごとに、受け入れの一覧を 2 つ持つ（MFA とみなす値、フィッシングに強いとみなす値）。既定値は、OIDC の `amr` では MFA が `mfa`・`otp`・`hwk`・`swk`・`fpt`・`face`、フィッシングに強いのが `hwk`。SAML の `AuthnContextClassRef` では、MFA が `urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract` などの複数の要素のクラス。フィッシングに強い値は既定で空にし、組織が IdP の値（パスキーを示す独自のクラスなど）を足す。一覧の変更は `manage_auth_settings`。
- 確かめは既定で有効。組織の管理者（`manage_auth_settings`）は、理由（必須の文）を書いた時だけ接続ごとに無効にできる。無効化と理由は監査（`auth`）に残り、組織の管理者全員に知らせる。無効でも、特権を持つ利用者には確かめを当てる（DT-AUTH-001 の行 8）。
- 主張がない・一覧にない時は、SSO の後に本システムの 2 つ目の要素を求める。受け取った主張の値は、合否に関わらずログインの履歴に残す。
- SSO を必須にした組織でも、`sso_bypass` を持つ非常用の管理者（2 人まで）はパスワード＋パスキーでログインできる（IdP の障害に備える）。**非常用の管理者は、1 人あたりハードウェアのセキュリティキー（持ち運ぶ認証器。登録の時に WebAuthn の attestation で確かめる）を 2 つ登録する。** 2 つ目がないと `sso_bypass` を与えられない。
- IdP が海外にある時の扱いは、法務の L2 の結論まで E2 の SSO の spec を承認しない（intent）。

### 6.5 セッション

- セッションは Aurora（`identity`）に持ち、Cookie は組織のホスト名に結ぶ（`Secure`、`HttpOnly`、`SameSite=Lax`）。画面の状態を変える要求は `Origin` の検査と CSRF のトークン。
- 無操作の期限は組織の設定（15 分〜12 時間、既定 2 時間）、絶対の期限は 24 時間（Better Auth は絶対の期限を持たないので自前で検査する。slack の ADR-0012）。
- 利用者は自分のセッションの一覧を見て消せる。管理者は利用者のセッションを消せる（`manage_users`）。
- **画面の API（本システムの SPA の要求）は、セッションの Cookie だけで通る。** OAuth のトークンでは通らない。画面の要求を API の割り当てに数えない代わりに、連携がそれを使えないようにする（[governor-limits.md](governor-limits.md) の 8.1 節）。

### 6.6 API の認証（OAuth）

| 流れ | 使う場面 | トークン |
| --- | --- | --- |
| 認可コード＋PKCE | 利用者の代わりに動く外部のアプリ（名刺管理、MA、CLI） | アクセストークン 2 時間、回転するリフレッシュトークン（90 日の無操作で失効） |
| クライアントクレデンシャル | 連携（`integration` の利用者として動く） | アクセストークン 2 時間 |

- 外部のアプリ（`oauth_clients`）は組織ごとに登録する（`manage_integrations`）。スコープは `api`（REST・一括・イベント）、`refresh`、`metadata`（書き出し・デプロイ）。スコープは権限の上限で、実際の権限は利用者の権限セットで決まる。
- トークンは `<brand>_at_`・`<brand>_rt_` で始まる不透明な文字列（乱数 ＋ CRC32 の確かめ。[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。DB にはハッシュだけを置き、トークンから `org_id` を決める表（`token_routes`、RLS の外）で、DB の組織のデータを読む前に組織を決める（ADR-0005）。
- API は `api_enabled` の権限が要る（`api_enabled` がなければ 403 `API_DISABLED`。[query-language-and-api.md](query-language-and-api.md) の 6.3 節）。
- 利用者の無効化・凍結、パスワードの変更（任意）、アプリの取り消しで、トークンを失効する。

### 6.7 組織のドメイン

- `<org>.my.<brand>.<domain>`。`<org>` は 3〜40 文字の英小文字・数字・ハイフンで、全ての組織で一意。変えると、古い名前は 90 日だけ新しい名前へ転送し、その後は 1 年再利用しない。
- 独自のドメイン（`crm.example.co.jp`）は MVP の後。

## 7. システムの権限（ADR-0045）

### 7.1 一覧

[sharing-and-record-access.md](sharing-and-record-access.md) の 3.2 節の 10 の権限に、他の領域から依頼のあった 6 つと、この文書と他の領域で要る 9 つを足した **25**。オブジェクトの権限（`read`〜`modify_all`）と項目の権限（`read`・`edit`）は、共有の領域の 3.2 節のまま。

| # | 権限 | 分類 | できること | 使う領域 | 追加 |
| --- | --- | --- | --- | --- | --- |
| 1 | `view_all_data` | データ | 全てのオブジェクトの全てのレコードを読む | 共有、イベント、レポート | 既存 |
| 2 | `modify_all_data` | データ | 全てのオブジェクトの全てのレコードを読み書きする | 共有、承認のロック | 既存 |
| 3 | `view_all_users` | データ | 全ての利用者のレコードを読む。利用者の変更のイベントを購読する | イベント | 追加 |
| 4 | `transfer_records` | データ | 所有者を一括で付け替える | 共有 | 既存 |
| 5 | `bulk_hard_delete` | データ | ごみ箱を通さない一括の削除 | 一括、data-storage | 既存 |
| 6 | `import_records` | データ | インポートのウィザード | 一括 | 追加 |
| 7 | `convert_leads` | 営業 | リードを変換する | sales-objects の 5.2 節 | 追加（依頼） |
| 8 | `edit_converted_leads` | 営業 | 変換済みのリードを直す | sales-objects の 3.4 節 | 追加（依頼） |
| 9 | `export_reports` | レポート | レポートの詳細の行を書き出す | レポート | 既存 |
| 10 | `manage_report_folders` | レポート | 公開のレポート・ダッシュボードのフォルダを作り、共有を変える | レポートの 4.2 節 | 追加（依頼） |
| 11 | `schedule_reports_for_others` | レポート | 他の利用者を定期の配信の受け取る人にする | レポートの 8.1 節 | 追加（依頼） |
| 12 | `view_my_team_dashboards` | レポート | ダッシュボードを部下の視点で見る | レポートの 7.2 節 | 追加（依頼） |
| 13 | `manage_public_list_views` | 画面 | 公開・グループのリストビューを作り、変える | ui-layouts の 5.5 節 | 追加（依頼） |
| 14 | `api_enabled` | API | REST・一括・イベントの API を使う | query-language-and-api | 既存 |
| 15 | `view_setup` | 管理 | Setup の設定を読む（変えない） | 全て | 追加 |
| 16 | `customize_application` | 管理 | メタデータ（オブジェクト、項目、レイアウト、フロー、承認、レポートの型など）を変える | metadata-and-runtime ほか | 既存 |
| 17 | `manage_users` | 管理 | 利用者の作成・変更・無効化・凍結、権限セットの割り当て、ロール・グループ | この文書 | 既存 |
| 18 | `manage_sharing` | 管理 | OWD、共有ルールを変える | 共有 | 既存 |
| 19 | `defer_sharing` | 管理 | 共有の計算を保留する | 共有の 7.4 節 | 既存 |
| 20 | `manage_auth_settings` | 管理 | SSO、MFA、パスワードの方針、セッションの期限、ログインの制限 | この文書の 6 節 | 追加 |
| 21 | `manage_integrations` | 管理 | OAuth のクライアント、Webhook、外向きの呼び出し、イベントの型、変更のイベントの対象 | イベント | 追加 |
| 22 | `manage_sandboxes` | 管理 | Sandbox の作成・再作成・削除、マスキングの設定 | sandboxes-and-deploy | 追加 |
| 23 | `deploy_metadata` | 管理 | メタデータのデプロイ・戻し、パッケージの受け取り | sandboxes-and-deploy | 追加 |
| 24 | `view_audit_trail` | 監査 | 設定の変更の履歴、ログインの履歴を読む・書き出す | audit-and-field-history | 追加 |
| 25 | `erase_history_values` | 監査 | 項目の変更の履歴の値を消す（本人の請求） | audit-and-field-history の 5.5 節 | 追加 |

**依存**（保存の時に検査する。共有の領域の 3.2 節の依存に足す）

| 権限 | 要る権限 |
| --- | --- |
| `modify_all_data` | `view_all_data` |
| `view_all_data` | `view_all_users` |
| `customize_application`・`manage_users`・`manage_sharing`・`manage_auth_settings`・`manage_integrations`・`manage_sandboxes`・`view_audit_trail` | `view_setup` |
| `deploy_metadata` | `customize_application` |
| `defer_sharing` | `manage_sharing` |
| `schedule_reports_for_others` | （なし。受け取る人ごとに権限で実行するため。[ADR-0030](../decisions/0030-dashboards-viewer-intersection-and-subscriptions.md)） |
| `edit_converted_leads` | リードの `edit` |
| `convert_leads` | リードの `edit` |
| `bulk_hard_delete` | `api_enabled` |
| `erase_history_values` | `view_audit_trail`、`modify_all_data` |

- 本家の似た権限の名前（「リードの変換」など）は、各領域の文書で確かめた振る舞いから寄せた。本家の全体の一覧は確かめていない（2 節。未検証。E4 の `system-permissions-and-delegation` で確かめる）。本システムの権限は、名前も粒度も本家に合わせない（`api_enabled` のように、意味で名前を付ける）。
- `system_admin` のプロファイルの基本の権限セットは、25 の全てを持つ。

### 7.2 権限を渡す規則

**DT-AUTH-002：管理の操作**（上から評価。`P(x)` は利用者・権限セットの有効な権限の集合。オブジェクト・項目・システムの権限を全て含む）

| # | 操作 | 条件 | 結果 |
| --- | --- | --- | --- |
| 1 | 権限セット・グループの割り当て | 操作する人に `manage_users` がない | 403 |
| 2 | 権限セット・グループの割り当て | `P(権限セット) ⊄ P(操作する人)` | 403 `PERMISSION_ESCALATION` |
| 3 | 権限セットの定義の変更 | `customize_application` がない | 403 |
| 4 | 権限セットの定義の変更 | 変更の後の `P(権限セット) ⊄ P(操作する人)` | 403 `PERMISSION_ESCALATION` |
| 5 | 利用者の操作（パスワードの再設定、MFA の解除、凍結、メール・`username` の変更、プロファイルの変更、無効化） | `P(相手) ⊄ P(操作する人)` | 403 `PERMISSION_ESCALATION` |
| 6 | 無効化・凍結・権限の取り上げ | 相手が「最後の管理者」（`customize_application`・`manage_users`・`modify_all_data` を全て持つ有効な利用者が他にいない） | 400 `LAST_ADMIN` |
| 7 | SSO の JIT の既定の権限セット | 既定の権限セットの `P ⊄ P(設定する人)` | 403 `PERMISSION_ESCALATION` |
| 8 | 上のどれにも当たらない | - | 許可（監査に残す） |

- **部分集合の規則**：自分の持たない権限を、割り当て・定義の変更・JIT のどれでも他の人に渡せない。自分より強い利用者のパスワード・MFA・メールを変えて乗っ取れない（[sharing-and-record-access.md](sharing-and-record-access.md) の 11 節の依頼）。
- `system_admin` は全てを持つので、規則はふつうの管理を妨げない。権限を分けた「利用者の管理だけの人」（`manage_users` と `view_setup` だけ）は、自分と同じか弱い権限しか渡せない。
- 本人の割り当ては、部分集合の規則で自然に「自分の権限を増やせない」になる。
- 管理の操作は、全て設定の変更の履歴に残す（[audit-and-field-history.md](audit-and-field-history.md) の 3 節）。
- 本家の似た規則（委任の管理者など）は確かめていない（未検証。E4 の `system-permissions-and-delegation` で確かめる）。本システムの規則は本家に依らない。

## 8. 上限（S1 の初期値）

値は [governor-limits.md](governor-limits.md) を正とする。

| 上限 | 値 | 本家 |
| --- | --- | --- |
| 組織の利用者 | S1 の最大 5,000（architecture の 2 節） | 未検証 |
| 1 利用者の権限セット（展開の後） | 100 | 未検証 |
| SSO の接続（組織） | 5 | 未検証 |
| `sso_bypass` の管理者 | 2 | — |
| OAuth のクライアント（組織） | 50 | 未検証 |
| 1 利用者の生きているセッション | 20 | 未検証 |
| ログインの失敗での一時の停止 | 10 回で 30 分 | 未検証 |
| 回復の番号 | 10 | — |
| 試用の組織の期間 | 30 日 | 未検証 |
| 削除の猶予 | 30 日（法務の L7） | 未検証 |

本家の列の「未検証」は、本家の値を公開の資料で確かめていないもの。本システムの値は本家に依らず、E12 の `limits-final-values` で決める。

## 9. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| 組織の IdP の障害 | `sso_bypass` の管理者がパスワード＋ハードウェアのセキュリティキーで入る。他の利用者は IdP の復旧を待つ |
| Better Auth の不具合・脆弱性 | 版を固定している。勧告を監視し、PR で上げる。認証の結合テストと DT-AUTH-* を通す |
| セッションの DB の障害 | Aurora の切り替え（RTO 5 分）。短い Cookie のキャッシュで、既にログインした人の読みを続ける（最大 60 秒） |
| 組織の作成の途中の失敗 | 1 つのトランザクションなので巻き戻る。部品のコンパイルは後から作り直せる |
| 削除の消去の遅れ | 7 日を超えたら警告 |
| 最後の管理者を失った（退職） | 本システムのサポートが、契約の確認の後、組織の申し込みの連絡先に一時の管理者を作る（2 人の承認、監査） |

## 10. セキュリティ

- 組織の解決は、DB を読む前にホスト名かトークンの表で行う（ADR-0005）。
- パスワードのログインは MFA を必須にし、外せない。SSO は IdP の MFA の主張を確かめる（既定で有効。無効は理由の記録と監査つき）。特権を持つ利用者と非常用の管理者はパスキーだけ。
- 部分集合の規則で、権限の昇格と、強い利用者の乗っ取りを防ぐ（DT-AUTH-002）。
- トークンはハッシュだけを持ち、接頭辞とチェックサムでシークレットスキャンに登録する（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- ログインの失敗の理由（利用者がいない、パスワードの誤り、凍結）を画面で区別しない。ログインの履歴には理由を残す。
- SSO の接続・MFA の方針（受け入れの一覧、確かめの無効化とその理由）・セッションの期限の変更は、監査に残し、組織の管理者全員に知らせる。
- `security:sensitive` の対象：この領域の全て（AGENTS.md の「アクセス制御」「秘密の保存」）。

## 11. テスト

- 決定表：`DT-AUTH-001`（ログインの手段と MFA）、`DT-AUTH-002`（管理の操作）を表駆動テストにする。
- 性質ベーステスト（fast-check）：
  - `PROP-AUTH-001`（草案）：任意の利用者・権限セット・管理の操作の列で、どの利用者の有効な権限も、その権限を渡した操作の時点の操作した人の権限の部分集合から作られている（昇格がない）。
  - `PROP-AUTH-002`（草案）：任意の操作の列の後で、有効な「管理者」（`customize_application`・`manage_users`・`modify_all_data`）が組織に 1 人以上いる。
  - 権限の依存の表：任意の権限セットの保存で、依存を満たさない組は断られる。
- 結合テスト：未知のホスト名・トークンで DB を読まずに 404（ADR-0005）。無効化でトークンとセッションが即時に失効する。SAML の IdP 起点のログインを断る。画面の API が OAuth のトークンで通らない。
- 結合テスト：Better Auth の版を上げる PR で、ログイン・MFA・SSO・セッションの全ての経路を通す。
- 結合テスト（SSO の MFA）：`amr`・`AuthnContextClassRef` がない・一覧にない・一覧にある SSO の応答で、2 つ目の要素を求める・求めないが DT-AUTH-001 の行 5〜8 どおりになる。理由のない無効化が断られ、無効化が監査に残り管理者に知らされる。
- 結合テスト（特権とパスキー）：特権を持つ利用者の TOTP・回復の番号を断る。特権を得た利用者のセッションが切れ、次のログインでパスキーの登録を求める。`sso_bypass` は、ハードウェアのキーを 2 つ登録するまで与えられない。
- 性質ベーステスト：`PROP-AUTH-003`（草案）：任意の利用者・権限の付与・SSO の設定・主張の列で、特権を持つ利用者のセッションは、パスキーかフィッシングに強い主張でだけ作られる。
- 上限の試験：8 節の値。
- 外部のペンテスト（E12）：ログイン、SSO、トークン、権限の昇格。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0043](../decisions/0043-orgs-editions-licenses-and-users.md) | 組織は種類と状態を持ち、削除は 30 日の猶予の後に消す。エディションはトランザクションの上限を変えず、割り当て・機能・Sandbox の数を変える。ライセンスが権限の上限になる。利用者は消さずに無効にし、匿名化できる |
| [0044](../decisions/0044-authentication-better-auth-sso-and-mfa.md) | ログインは自前でホストする Better Auth。組織ごとの SAML・OIDC の SSO。Auth0 の題材を IdP にしない。SSO を含めて MFA を確かめ（SSO は IdP の主張、なければ 2 つ目の要素）、特権を持つ利用者はパスキーだけ。API は OAuth、画面の API はセッションの Cookie だけ |
| [0045](../decisions/0045-system-permissions-and-delegation.md) | システムの権限を 25 にし、依存を決める。権限を渡す人は自分の権限の部分集合しか渡せず、自分より強い利用者を操作できない。最後の管理者を無くせない |

他の領域への依頼：

- sharing-and-record-access の領域：3.2 節のシステムの権限を、7.1 節の 25 と依存の表に合わせる。`permission_sets.license` を足す。
- query-language-and-api の領域：`/api/v1` の認証（OAuth のトークン）と、画面の API をセッションの Cookie だけにする規則を 5 節に書く。

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：`DT-AUTH-*` の表駆動テストと `PROP-AUTH-*` の枠。Better Auth の版の固定と勧告の監視 |
| E1 | 組織の解決（ホスト名、トークンの表）を DB の前に行う入口 |
| E2 | 申し込みと組織の作成（種、最初の管理者、部品の事前のコンパイル） |
| E2 | エディションと機能の組、エディションの上げ下げ |
| E2 | ライセンスと、権限セットのライセンスの上限 |
| E2 | 利用者の招待・作成・無効化・凍結・匿名化 |
| E2 | Better Auth のログイン（パスワード、MFA、パスキー、回復の番号）、DT-AUTH-001 |
| E2 | 特権を持つ利用者のパスキーの必須と、非常用の管理者のハードウェアのキー 2 つ（DT-AUTH-001 の行 4・6・8、`PROP-AUTH-003`） |
| E2 | セッション（無操作の期限、絶対の期限、一覧と取り消し）とログインの制限（時間帯、IP） |
| E2 | SSO（SAML・OIDC）、`federation_id`、JIT、`sso_bypass`、SSO の MFA の主張の確かめ（受け入れの一覧、理由つきの無効化）。法務の L2 の確認が済むまで spec を承認しない |
| E2 | OAuth のクライアントとトークン（認可コード＋PKCE、クライアントクレデンシャル） |
| E2 | 組織のドメインと名前の変更の転送 |
| E2 | 組織の削除（猶予、書き出し、消去） |
| E4 | システムの権限の 25 と依存、DT-AUTH-002（部分集合の規則、最後の管理者） |
| E11 | 管理の操作・認証の設定の変更の監査と、管理者への知らせ |
| E12 | 外部のペンテスト（認証、権限の昇格） |

## 14. 未解決の問い

- 自前の Better Auth か、Auth0 の題材を IdP にするか（intent の「選定・計測で決めるもの」）。
- エディションの分け方と、本家の価格の段との対応。
- MFA を外せる設定を持つか（SSO を使わない小さな組織の負担）。
- `username` を全ての組織で一意にするか（利用者の手間）。
- 組織の削除の猶予（30 日）と、監査のログの外部の保管の扱い（法務の L5・L7）。
- 代理のログイン（管理者が利用者として入る。本家の似た機能）を MVP に入れるか。
- レポートの作成・実行をシステムの権限で分けるか（本家には似た権限があると読める。未検証。E4 の `system-permissions-and-delegation` で確かめる）。
- SSO のログインでも MFA を確かめるか（IdP の MFA の主張、SAML の `AuthnContextClassRef`・OIDC の `amr` を要るとするか）。管理者（`manage_users` などを持つ利用者）にパスキーを必須にするか。本家は 2026 年から両方を強制する（2 節）。 → 決定を見よ。

### 決定

2026-09-28 の既定案。

- Better Auth を採る（ADR-0044）。Auth0 の題材が製品として動く時期が来ても、IdP の 1 つとして OIDC でつなぐ形にとどめる。
- エディションは 4 節の既定案で作り、E2 の着手前に PM が決める。
- MFA は外せない。パスキーを勧め、登録の手間を下げる。
- `username` は全ての組織で一意にする。組織のドメインのログインでは、`username` の代わりにメールでも入れる（組織の中でメールが一意の時だけ）。
- 猶予は 30 日で作り、値を設定にする。L5・L7 の結論で変える。
- 代理のログインは MVP の後。入れる時は、利用者の許可（期限つき）、`manage_users`、画面の目立つ表示、監査を条件にする。
- SSO のログインでも MFA を確かめる。IdP の `amr`（OIDC）・`AuthnContextClassRef`（SAML）を接続ごとの受け入れの一覧と比べ、確かめは既定で有効にする。組織の管理者は理由を記録した時だけ無効にでき、監査に残る。主張がない・一覧にない時は、SSO の後に本システムの 2 つ目の要素を求める（6.4 節）。
- 特権を持つ利用者（`modify_all_data`・`manage_users`・`customize_application` のどれかを持つ利用者）はパスキーだけにし、TOTP を許さない。`sso_bypass` の非常用の管理者も含め、1 人あたりハードウェアのセキュリティキーを 2 つ登録させる（6.3・6.4 節）。本家の 2026 年の方針に揃えた（利用者の指示による推奨の既定案。ADR-0044 の注記）。
- レポートの作成・実行の権限は持たない。レポートは見る人の権限で実行されるので（ADR-0029）、分けても漏れは減らない。要望が出たら足す。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：認証の誤り（MFA の抜け道、SSO の検証の漏れ、セッションの固定）。DT-AUTH-001、Better Auth の結合テスト、外部のペンテスト。
- リスク：権限の昇格。DT-AUTH-002、`PROP-AUTH-001`。
- リスク：組織の解決の誤り（他の組織への要求）。ADR-0005 の性質ベーステストと入口の結合テスト。
- 本番での検証：ログインの失敗の率、MFA の登録の率、`PERMISSION_ESCALATION` の件数、組織の作成の時間。

**runbooks**

- `org-idp-outage`：組織の IdP の障害で利用者が入れない。`sso_bypass` の案内。
- `login-attack`：1 つの組織・IP でのログインの失敗の急増。WAF のレートの制限と、組織への知らせ。
- `better-auth-advisory`：Better Auth の勧告への対応（版の上げ、影響の確認）。
- `last-admin-recovery`：最後の管理者を失った組織の復旧（2 人の承認）。
- `org-purge-overdue`：組織の消去が 7 日を超えた。
- SLI の追加の依頼（Ops へ）：ログインの p95、ログインの失敗の率、SSO の失敗の率（IdP ごと）、トークンの発行の数、組織の作成の時間。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `orgs` | 3.1 節 | RLS の外（組織の解決）。書くのは管理のサービスだけ |
| `org_features` | `org_id`、`feature`、`enabled` | エディションから作る |
| `org_licenses` | `org_id`、`license`、`purchased`、`used` | |
| `users` | 5.2 節 | RLS |
| `identity.auth_users`・`auth_accounts`・`auth_sessions`・`passkeys`・`two_factors`・`sso_providers` | Better Auth の表＋`org_id` | RLS の外。認証のサービスのロールだけ |
| `oauth_clients` | `org_id`、`client_id`、`secret_hash`、`redirect_uris`、`scopes`、`run_as_user_id`、`created_by` | |
| `oauth_tokens` | `org_id`、`token_hash`、`kind`（`access`・`refresh`）、`client_id`、`user_id`、`scopes`、`expires_at`、`revoked_at` | |
| `token_routes` | `token_hash_prefix`、`org_id` | RLS の外。組織の解決 |
| `org_auth_settings` | `org_id`、`sso_required`、`session_idle_minutes`、`password_min_length`、`jit_enabled`、`jit_defaults` | |
| `permission_sets.license` | ライセンスの種類 | sharing の表への追加 |
| `org_purge_log` | `org_hash`、`requested_at`、`purged_at` | RLS の外 |

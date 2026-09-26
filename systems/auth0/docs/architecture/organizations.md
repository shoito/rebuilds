# Organizations: Auth0（MVP の後）

B2B の組織（テナントの中で、テナントの顧客の会社を表すもの）、メンバー、招待、組織ごとの接続とブランド、トークンの組織のクレームの設計。決定は [ADR-0051](../decisions/0051-organization-model-and-login-flow.md)（組織のモデルとログインの流れ）、[ADR-0052](../decisions/0052-organization-tokens-sessions-and-membership.md)（組織のトークン・セッション・メンバーシップの境界）にある。

**MVP の後（E14）** に作る。intent は、B2B の要件としてエンタープライズ接続と一緒に扱うとした。

本家の振る舞いは、2026-09-27 に auth0.com/docs と Management API の OpenAPI で確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 組織、メンバー、組織のロール、招待 | テナントの RBAC（本システムの MVP にない） |
| 組織ごとの接続の有効化、メンバーシップの自動の付与、組織のサインアップ | エンタープライズ接続そのもの（connections の領域。同じ E14） |
| アプリの `organization_usage`・`organization_require_behavior`、ログインの流れ、組織の選択 | Universal Login の画面の作り（universal-login の領域。ここは画面の要件だけ） |
| ID トークン・アクセストークンの `org_id`・`org_name`、リフレッシュとセッションの組織の境界 | トークンの形の全体（ADR-0003・ADR-0008） |
| 組織ごとのブランド、`{organization_name}` のコールバックの置き換え | 組織ごとのカスタムドメイン（持たない。5 節） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 目的 | テナントの顧客の会社ごとに、接続・ブランド・ロールを分ける B2B の機能。利用者は複数の組織に属しうる | [Organizations Overview](https://auth0.com/docs/manage-users/organizations/organizations-overview) |
| アプリの設定 | `organization_usage`：`deny`（既定）・`allow`・`require`。`organization_require_behavior`：`pre_login_prompt`（先に組織を選ぶ）・`post_login_prompt`（先に資格情報、後で組織を選ぶ）・`no_prompt`。組織の発見の方法：メール・組織の名前 | [Define Organization Behavior](https://auth0.com/docs/manage-users/organizations/configure-organizations/define-organization-behavior) |
| 要求 | `/authorize` に `organization`（ID か、設定で名前）を渡す | [Work with Tokens and Organizations](https://auth0.com/docs/manage-users/organizations/using-tokens) |
| トークン | ID トークンとアクセストークンに `org_id`。設定で `org_name` も。サードパーティのアプリは ID トークンを受けず、アクセストークンに `org_id` | 同上 |
| 検証の指針 | `organization` を渡さなかったのに `org_id` があれば、アプリが検証する。API は `org_id` を既知の値と照合し、データを `org_id` で分ける | 同上 |
| 接続 | 組織ごとに有効にする。メンバーシップの自動の付与（初回の認証で自動でメンバーにする）、組織のサインアップ（データベース接続だけ）、ボタンの表示（エンタープライズ接続） | [Enable Connections](https://auth0.com/docs/manage-users/organizations/configure-organizations/enable-connections) |
| 招待 | メールで送るか、URL だけを作る。招待されたメールアドレスでログイン・登録する。受けるとメールアドレスが確認済みになる。フェデレーションでは IdP が同じメールを返す必要がある。アプリのログインの URL に `invitation`・`organization`・`organization_name` を付けて案内する。組織のロールを事前に付けられる | [Invite Members](https://auth0.com/docs/manage-users/organizations/configure-organizations/invite-members) |
| 招待の期限 | 既定 604,800 秒（7 日）、最大 2,592,000 秒（30 日） | OpenAPI の `CreateOrganizationInvitationRequestContent.ttl_sec` |
| 組織の名前 | 1〜50 文字。表示名は 255 文字 | OpenAPI の `CreateOrganizationRequestContent` |
| 件数 | テナントに 100,000 組織、組織に 100,000 メンバー、組織に 10 接続、メンバーに 50 のロール、組織に 100 の M2M の許可（Enterprise は 200 万まで引き上げ可） | [Entity Limit Policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/entity-limit-policy) |
| 制限 | Universal Login だけ。ROPG・デバイス認可・WS-Fed と併用できない。組織ごとのカスタムドメインはない（別のドメインが要るなら別のテナント） | Organizations Overview |
| アプリへのアクセス | 既定は、組織が有効なアプリに、組織のメンバーなら誰でも入れる（暗黙）。組織ごとに、明示の許可のあるアプリだけにできる | 同上 |
| コールバックの置き換え | `{organization_name}` をコールバックの URL に使える。`organization_usage` が `allow`・`require` で、組織の文脈の要求のときだけ評価する | [Subdomain URL Placeholders](https://auth0.com/docs/get-started/applications/wildcards-for-subdomains) |

## 3. モデル

```
tenant
  └── organizations（name はテナントの中で一意、1〜50 文字、^[a-z0-9][a-z0-9-_]*$）
        ├── organization_members（user_pk。テナントのユーザー）── organization_member_roles
        ├── organization_connections（connection_id、assign_membership_on_login、is_signup_enabled、show_as_button）
        ├── organization_invitations（email、roles、connection_id、ticket_hash、expires_at）
        ├── organization_branding（ロゴ、色。universal-login のテーマの上書き）
        └── organization_client_grants（M2M の許可を組織に結ぶ。E14 の後）
organization_roles（テナントの中の組織のロールの定義。名前と説明と権限の文字列）
```

- 組織のメンバーは、テナントのユーザー（users-and-profiles）である。組織は利用者を「持つ」のではなく、メンバーシップで結ぶ。1 人の利用者が複数の組織に属しうる（本家と同じ）。
- **組織のロールは、組織の中でだけ効く**（本家と同じ）。組織の文脈のトークンにだけ入る。
- テナントの RBAC は、本システムの MVP にない。組織のロールは、組織の文脈のトークンに `org_roles`（本システムのクレームの名前。名前空間つき）として入れる。本家は Actions でロールをクレームに入れる形が多い（未検証）。本システムは、E14 で直接入れる設定を持つ。
- 組織の ID は `org_` ＋ UUIDv7 の base62（`org_` は本家の名前を含まない一般の接頭辞だが、本家と同じ接頭辞なので、シークレットスキャンの対象ではない ID として使ってよい。リポジトリ共通の ADR-0006 は秘密の接頭辞を対象にする）。

### 3.1 件数の上限

| 対象 | 上限 | 本家 |
| --- | --- | --- |
| テナントの組織 | 100,000（上書きで 2,000,000） | 同じ |
| 組織のメンバー | 100,000（上書きで 2,000,000） | 同じ |
| 組織の接続 | 10 | 同じ |
| メンバーの組織のロール | 50 | 同じ |
| 組織のロールの定義 | テナントに 1,000 | テナントのロール 1,000 に合わせる |
| 未処理の招待 | 組織に 1,000 | 未検証。本システムの決定 |

## 4. ログインの流れ

[ADR-0051](../decisions/0051-organization-model-and-login-flow.md)。アプリの設定と要求の組み合わせで、流れが決まる。

| # | `organization_usage` | 要求の `organization` | `organization_require_behavior` | 結果 |
| --- | --- | --- | --- | --- |
| 1 | `deny` | あり | - | `invalid_request`（組織を使えないアプリ） |
| 2 | `deny` | なし | - | 通常のログイン。トークンに `org_id` なし |
| 3 | `allow`・`require` | あり（存在しない、無効） | - | エラーの画面（組織が見つからない。存在の有無で文面を変えない） |
| 4 | `allow`・`require` | あり（存在する） | - | 組織のログインの画面（組織のブランド、組織で有効な接続だけ）。認証の後、メンバーシップを確かめる |
| 5 | `allow` | なし | - | 通常のログイン。トークンに `org_id` なし |
| 6 | `require` | なし | `pre_login_prompt` | 組織の選択の画面（名前かメール）→ 4 |
| 7 | `require` | なし | `post_login_prompt` | テナントのログイン → 利用者の属する組織の一覧から選ぶ → メンバーシップ → 発行 |
| 8 | `require` | なし | `no_prompt` | `invalid_request`（アプリが組織を渡す責任） |

- この表は E14 の spec の決定表（`DT-ORG-001`）の元にする。
- **メンバーシップの確認**（4 と 7）：
  1. 利用者が組織のメンバーなら通す。
  2. メンバーでなく、使った接続が組織で `assign_membership_on_login` なら、メンバーにして通す。
  3. 招待（`invitation`）があり、招待が有効で、利用者の確認済みのメールアドレスが招待のメールアドレスと一致すれば、メンバーにして通す。
  4. それ以外は `access_denied`（「この組織のメンバーではありません」）。
- **接続の制限**：組織の文脈のログインでは、組織で有効な接続だけを出す。`connection` のパラメーターで組織で無効な接続を指定したら拒否する（テナントの接続の有効化の規則、[ADR-0014](../decisions/0014-connection-abstraction.md) に重ねる）。
- **組織の発見**（6）：組織の名前の入力か、メールアドレスのドメインからの推定（エンタープライズ接続のドメインと結び付ける。同じ E14 の接続と合わせる）。名前の入力で存在しない組織は、4 と同じ文面のエラー（組織の名前の列挙を防ぐ）。
- 組織の文脈では、ROPG・デバイス認可を使えない（本家と同じ。本システムは ROPG をそもそも持たない）。デバイス認可の要求に `organization` があれば `invalid_request`。

## 5. トークン

[ADR-0052](../decisions/0052-organization-tokens-sessions-and-membership.md)。

| クレーム | いつ | 値 |
| --- | --- | --- |
| `org_id` | 組織の文脈のログイン・リフレッシュ・M2M（組織の許可） | 組織の ID |
| `org_name` | テナントの設定 `org_name_in_tokens` が真のとき | 組織の名前 |
| `https://<brand>.<domain>/org_roles`（名前は開発リポジトリで決める） | アプリの設定で有効なとき | 組織のロールの名前の配列 |

- ID トークンとアクセストークンの両方に `org_id` を入れる（本家と同じ）。サードパーティのアプリには ID トークンを出さない本家の振る舞いは、本システムの ID トークンの規則（ADR-0008）に従い、ここでは変えない。
- `org_id` は予約のクレーム。Actions（[extensibility.md](extensibility.md)）で変えられない。
- **組織の名前は変えられる**（本家は表示名だけを変える前提。名前の変更の可否は未検証）。`org_name` で API を分ける利用者の事故を避けるため、本システムは **名前を変えられないものにする**。表示名だけを変えられる。
- テナントの API への案内（文書）：`org_id` を既知の値と照合し、データを `org_id` で分ける（本家の指針と同じ）。

### 5.1 リフレッシュとセッション

- **リフレッシュトークンは組織に結ぶ。** 組織の文脈で発行した系列（ADR-0003）は、`org_id` を持つ。リフレッシュのたびに、利用者が今も組織のメンバーであることを確かめる。外れていたら `invalid_grant` で系列を失効させる。本家のリフレッシュでのメンバーシップの確認の有無は未検証。
- **組織を切り替えるには、新しい `/authorize` を要する。** SSO のセッション（sessions-and-sso の領域）は、テナントに 1 つのまま。別の組織への `/authorize` で、既存のセッションを使えるのは、セッションの認証に使った接続が、その組織でも有効で、利用者がそのメンバーであるとき。そうでなければ、その組織の接続で認証し直す。
- メンバーを組織から外すと、その組織に結んだリフレッシュトークンの系列を失効させる（非同期。Worker）。発行済みのアクセストークンは期限まで有効（ADR-0003）。
- 組織を削除すると、メンバーシップ・招待・組織の接続の有効化を消し、その組織の系列を失効させる。ユーザーは消さない。

### 5.2 M2M と組織

- client grant に `organization_usage`（`deny`・`allow`・`require`）を足し、`client_credentials` の要求に `organization` を付けられるようにする。組織に結んだ許可（`organization_client_grants`）があるときだけ、`org_id` を入れたトークンを出す。E14 の後の Story にする（本家は組織に 100 の M2M の許可）。

## 6. 招待

```
管理者（Management API / ダッシュボード）
  POST /organizations/{id}/invitations {inviter, invitee.email, client_id, connection_id?, roles?, ttl_sec?}
  → ticket（256 ビットの乱数）を作り、SHA-256 だけを保存（ADR-0004）
  → メールで送る（または URL だけを返す）
     https://<app の initiate_login_uri>?invitation=<ticket>&organization=<org_id>&organization_name=<name>
アプリ → /authorize?...&organization=<org_id>&invitation=<ticket>
  → 組織のログインの画面（招待のメールアドレスを入れた状態。変えられない）
  → ログインか登録 → 4 節のメンバーシップの確認の 3
  → ticket を使用済みにする（1 回限り）
```

- 期限は既定 7 日、最大 30 日（本家と同じ）。
- 招待を受けると、利用者のメールアドレスを確認済みにする（本家と同じ）。**ただし、データベース接続で新しく登録した利用者だけ。** 既存の利用者のメールの確認の状態は変えない。ソーシャル・エンタープライズの接続では、IdP が返す確認済みのメールアドレスが招待のメールアドレスと一致することを求め、確認の状態は IdP の値のまま（本家と同じ）。
- 招待の URL を、アプリの `initiate_login_uri` に作る。アプリが `initiate_login_uri` を持たなければ、招待を作れない（400）。
- 招待の ticket は、ログに出さない（ADR-0004）。URL に入るので、アプリの側のアクセスログに残りうる。1 回限りと期限で抑える。
- 招待のメールは email-delivery の領域のテンプレートで送る（組織のブランドを使う）。

## 7. ブランドと URL

- 組織ごとのロゴ・色を、Universal Login のテーマの上書きとして持つ（universal-login の領域の [ADR-0012](../decisions/0012-branding-and-templates.md) のテーマの上に重ねる）。
- **組織ごとのカスタムドメインは持たない**（本家も持たない）。複数のカスタムドメイン（S2 以降）の後に、需要を見て決め直す（[custom-domains.md](custom-domains.md) の Story からは外した）。別のドメインが要る顧客は、本家と同じく別のテナントにする。
- コールバックの URL の `{organization_name}` の置き換え（[tenants-and-applications.md](tenants-and-applications.md) の 4.2 節）：
  - `organization_usage` が `allow`・`require` で、組織の文脈の要求のときだけ評価する（本家と同じ）。
  - 置き換えは、組織の名前をそのまま入れた後、**置き換えの後の URL と `redirect_uri` の完全一致**で照合する（ADR-0006）。本家のワイルドカードとの併用の問題（名前のない組織でも通る）は、本システムにワイルドカードがないので起きない。
  - 組織の名前は、ホスト名のラベルに使える文字（`[a-z0-9-]`）だけのとき、ホスト名の部分に置ける。`_` を含む名前は、パスの部分だけに置ける。

## 8. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| DB の読めない間 | 組織とメンバーシップは、テナントの設定のキャッシュ（ADR-0032）に入れない（件数が大きい）。組織の文脈のログインは、メンバーシップの読み込み（reader）を要する。reader・writer とも読めなければ 503。組織を使わないログインは影響なし |
| メンバーシップの自動の付与の書き込み（writer の切り替え） | 503 と再試行の案内（ADR-0005 のログインと同じ） |
| 招待のメールの遅れ | 招待の URL を管理者がダッシュボードで複写できる |

- 組織の定義（名前・接続・ブランド・`organization_usage`）はテナントの設定のキャッシュに入れる。組織が 10 万あるテナントのスナップショットの大きさ（2 MiB の上限）を超えるので、**組織の定義は、テナントのスナップショットとは別の、組織ごとの小さなキャッシュ**（LRU、同じ版の通知で無効化）に持つ。

## 9. セキュリティ

- **組織の境界の破れ**（メンバーでない組織の `org_id` を持つトークンが出る）を最も警戒する。4 節の決定表の全行と、メンバーシップの確認の性質ベーステストで押さえる。
- 組織の名前と存在を、エラーの文面で漏らさない（4 節の 3・6）。
- 招待の ticket は 256 ビット、1 回限り、SHA-256 で保存、期限つき。招待のメールアドレスと、ログインした利用者の確認済みのメールアドレスの一致を必須にする。
- メンバーシップの自動の付与は、接続を完全に信頼できるとき（その顧客の企業の IdP）だけに使うよう、ダッシュボードで警告する。ソーシャル接続に自動の付与を設定すると、誰でもメンバーになれる。
- 組織の名前を変えられないので、`org_name` で分ける API がなりすまされない。
- 組織の操作は `audit_events` に残す（ADR-0054）。ログのイベントに `organization_id` を入れる（[logs-and-streams.md](logs-and-streams.md)）。

## 10. テスト

- 決定表のテスト：4 節の表の全行（`DT-ORG-001`）。
- 性質ベーステスト：任意の組織・メンバーシップ・接続の有効化・要求の組み合わせについて、発行したトークンの `org_id` の組織に、利用者がメンバーである（自動の付与と招待を含めた後で）。
- 性質ベーステスト：任意のメンバーの削除の後、その組織の系列のリフレッシュが失敗する。
- 結合テスト：招待の使い回し、期限切れ、メールアドレスの不一致、確認していない IdP のメールが拒否される。
- 結合テスト：組織で無効な接続を `connection` で指定すると拒否される。
- 結合テスト：`{organization_name}` の置き換えで、存在しない組織の名前の `redirect_uri` が拒否される。
- 適合試験への影響：組織を使わないアプリの振る舞いが変わらない（OIDC の適合試験を回す）。
- 負荷試験：10 万組織・組織に 10 万メンバーのテナントで、組織のログインのメンバーシップの確認が p99 20 ms 以内（索引 `(tenant_id, organization_id, user_pk)`）。

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0051](../decisions/0051-organization-model-and-login-flow.md) | 組織はテナントの中のメンバーシップの単位にし、本家の `organization_usage`・`organization_require_behavior` の流れを決定表で持つ。組織の名前は変えず、組織ごとのカスタムドメインは持たない |
| [0052](../decisions/0052-organization-tokens-sessions-and-membership.md) | 組織の文脈のトークンに `org_id` を入れ、リフレッシュの系列を組織に結んでメンバーシップを毎回確かめる。組織の切り替えは新しい `/authorize` で、セッションの再利用は接続とメンバーシップで決める |

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E14 | 組織・メンバー・組織のロールの表と Management API（`/organizations`、`/organizations/{id}/members`、`/roles`） |
| E14 | 組織ごとの接続の有効化、メンバーシップの自動の付与、組織のサインアップ |
| E14 | アプリの `organization_usage`・`organization_require_behavior` と、ログインの流れ（`DT-ORG-001`） |
| E14 | 組織の選択の画面（名前・メール）と、ログインの後の組織の選択（universal-login と一緒に） |
| E14 | トークンの `org_id`・`org_name`・組織のロール、リフレッシュでのメンバーシップの確認 |
| E14 | 招待（ticket、メール、URL、メールアドレスの一致、確認済みの扱い） |
| E14 | 組織のブランド、`{organization_name}` のコールバックの置き換え |
| E14 | ダッシュボードの組織の画面と `editor_organizations` のロール |
| E14 の後 | 組織に結ぶ M2M の許可、組織ごとのアプリの明示の許可、SCIM の `Groups` |

## 13. 未解決の問い

- 本家は組織の名前を変えられるか（未検証）。変えられるなら、本システムの「変えない」は本家からの移行で差になる。
- 組織のロールをトークンに直接入れる設定を持つか、Actions に任せるか。
- 組織ごとのアプリの明示の許可（本家の新しい機能）を E14 に入れるか。
- 本家のリフレッシュでのメンバーシップの確認の有無（未検証）。
- 組織の文脈で、SSO のセッションを組織ごとに分けるか（本システムはテナントに 1 つのまま）。

### 決定

2026-09-27 の既定案。

- 組織の名前は変えない。表示名だけを変えられる。本家の振る舞いは E14 の着手前に試用のテナントで確かめ、差を移行の文書に書く。
- 組織のロールは、アプリの設定でトークンに直接入れられるようにする（Actions なしで B2B の主な需要を満たすため）。
- 組織ごとのアプリの明示の許可と、組織に結ぶ M2M の許可は、E14 の後にする。
- リフレッシュのたびにメンバーシップを確かめる（本家の振る舞いにかかわらず）。
- SSO のセッションはテナントに 1 つのまま。組織の切り替えで、接続とメンバーシップの条件を満たせばセッションを再利用する。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：組織の境界の破れ（メンバーでない組織の `org_id`）。決定表の全行と性質ベーステスト。
- 本番での検証：合成監視のテナントに 2 つの組織を置き、組織 A のメンバーが組織 B のトークンを得られないことを毎時確かめる。

**runbooks**

- `organization-membership-incident`：誤ったメンバーシップの付与（自動の付与の設定の誤り）の調査。該当の利用者の特定、メンバーシップと系列の失効、テナントへの連絡。
- SLI の追加の依頼（Ops へ）：組織のログインの成功率、メンバーシップの確認の遅延、招待の受け入れの率。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `organizations` | `tenant_id`、`id`、`name`、`display_name`、`metadata`、`branding`、`created_at` | RLS。`(tenant_id, name)` 一意 |
| `organization_members` | `tenant_id`、`organization_id`、`user_pk`、`created_at`、`source`（`manual`・`auto`・`invitation`） | RLS。索引 `(tenant_id, organization_id, user_pk)` と `(tenant_id, user_pk)` |
| `organization_roles` | `tenant_id`、`id`、`name`、`description`、`permissions` | RLS |
| `organization_member_roles` | `tenant_id`、`organization_id`、`user_pk`、`role_id` | RLS |
| `organization_connections` | `tenant_id`、`organization_id`、`connection_id`、`assign_membership_on_login`、`is_signup_enabled`、`show_as_button`、`is_enabled` | RLS |
| `organization_invitations` | `tenant_id`、`id`、`organization_id`、`email`、`roles`、`connection_id`、`client_id`、`ticket_hash`、`expires_at`、`used_at`、`inviter` | RLS |
| `refresh_token_families.organization_id` | 組織の ID（NULL 可） | 列の定義は [data-model.md](data-model.md) の 5.1 節にまとめた |
| `clients.organization_usage`・`organization_require_behavior` | | [tenants-and-applications.md](tenants-and-applications.md) の `clients` に足す列 |

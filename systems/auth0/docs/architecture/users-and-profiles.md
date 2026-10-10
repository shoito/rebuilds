# Users and profiles: Auth0

ユーザーの保存、外部の ID（identity）とリンク、メタデータ、ユーザーの検索、ブロックと削除。MVP の後のインポート・エクスポートと SCIM の受け入れ。

| 関連 | 決定 |
| --- | --- |
| [ADR-0018](../decisions/0018-user-identifier-and-profile-store.md) | ユーザーの ID（`sub`）は接続から独立した不透明な値にし、再利用しない。プロファイル・外部の ID・メタデータを別の列と表に分け、メタデータの大きさに固い上限を置く |
| [ADR-0019](../decisions/0019-account-linking.md) | ID のリンクは、両方の ID で本人が認証したときだけ行う。メールアドレスの一致だけで自動にリンクしない |
| [ADR-0020](../decisions/0020-user-search-and-lifecycle.md) | ユーザーの検索は Aurora の reader の上の限られた問い合わせの言語で行い、結果は 1,000 件まで。ブロックと削除はステートマシンで扱い、削除した `sub` は墓標で再利用を防ぐ |
| [ADR-0002](../decisions/0002-tenancy-and-isolation.md) | ユーザーはテナントに属し、テナントをまたがない。全テーブルに `tenant_id` と RLS |
| [ADR-0004](../decisions/0004-credential-storage.md) | パスワードのハッシュ、取り込んだ bcrypt の照合と作り直し |
| [ADR-0014](../decisions/0014-connection-abstraction.md) | 接続の部品は `VerifiedIdentity` を返すだけで、ユーザーの表を書かない。外部の ID は `(tenant_id, connection_id, provider_user_id)` で特定する |

接続の部品と `user_identities` の一意の制約は [connections.md](connections.md)、セッションとログアウトは [sessions-and-sso.md](sessions-and-sso.md)、MFA の要素は [mfa-and-passkeys.md](mfa-and-passkeys.md)、ブロックと防御の数は [attack-protection.md](attack-protection.md) にある。

## 1. 目的と範囲

- テナントのエンドユーザーを 1 か所に保存し、アプリに安定した識別子（ID トークンの `sub`）を渡す。
- 同じ人がデータベース接続とソーシャル接続の両方で入っても、テナントが望めば 1 人のユーザーにまとめる（ID のリンク）。まとめ方を誤ると、他人のアカウントを乗っ取れる。安全を先にする。
- テナントの管理者が、ダッシュボードと Management API でユーザーを探し、ブロックし、削除できるようにする。
- エンドユーザーの開示・削除の請求（[intent.md](../intent.md) の L7）に、テナントが応えられる操作を持つ。
- 範囲の外：パスワードの照合とポリシー（[connections.md](connections.md)）、MFA の要素の保存（[mfa-and-passkeys.md](mfa-and-passkeys.md)）、ログの保存（logs-and-streams の領域）。

MVP（S1）に含めるもの：ユーザーの作成・取得・更新・削除、メタデータ、ID のリンクと解除、検索、ブロック。MVP の後（[roadmap.md](../roadmap.md) の「後回し」の移行の Epic と、E14 の後）：一括のインポート・エクスポート、SCIM 2.0 の受け入れ。ただし、ハッシュの取り込み（bcrypt）と、インポートで `user_id` を指定できる形は MVP から備える（[intent.md](../intent.md)）。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 項目 | 本家の振る舞い | 出典 |
| --- | --- | --- |
| ユーザーの ID | 主の ID の接続から作った `user_id`（`<接続の種類>\|<ID>` の形）。リンクしても主の `user_id` のまま | [User Account Linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking) |
| リンク | 主（primary）と従（secondary）。従の属性は主の `identities` の中の `profileData` に入る。従の `user_metadata`・`app_metadata` は捨てられる。主を消すと従も消える | 同上 |
| リンクの安全 | リンクの前に両方のアカウントで認証を求めるべき。手動のリンクでは毎回資格情報を入れさせる | 同上 |
| プロファイルの大きさ | プロファイルは 10 KB まで（超える書き込みも今は成功するが、将来失敗しうる）。`app_metadata` と `user_metadata` を合わせて 16 MB まで。検索で索引・返却できるのは 1 ユーザー 1 MB まで | [Metadata Field Names and Data Types](https://auth0.com/docs/manage-users/user-accounts/metadata/metadata-fields-data)、[Support の記事](https://support.auth0.com/center/s/article/What-is-the-maximum-size-of-user-metadata-and-app-metadata-profiles) |
| メタデータの名前 | 名前に `.` と `$` を使えない。`app_metadata` に予約の名前（`user_id`、`email`、`identities`、`blocked` など）を使えない。サインアップの API で渡す `user_metadata` は、500 文字以下の文字列の 10 項目まで | [Metadata Field Names and Data Types](https://auth0.com/docs/manage-users/user-accounts/metadata/metadata-fields-data) |
| メタデータに入れないもの | 秘密や機微な個人情報を入れない | 同上 |
| 検索 | Lucene の問い合わせの文字列。結果は最大 1,000 件。結果整合（書き込みの直後に出ないことがある）。2 秒で時限切れ（503）。認証の処理・リンクには使わないよう求めている。`app_metadata`・`user_metadata` での並べ替えはできない | [User Search Best Practices](https://auth0.com/docs/manage-users/user-search/user-search-best-practices) |
| メタデータの更新 | `PATCH` では最上位の名前だけを併合し、2 段目より下は置き換える。値を `null` にした名前は消える。空のオブジェクトでメタデータ全体を消せる | [Manage Metadata Using the Management API](https://auth0.com/docs/manage-users/user-accounts/metadata/manage-metadata-api) |
| ルートの属性の同期 | 接続の設定 `set_user_root_attributes`。新しい接続の既定は `on_each_login`（ログインのたびに IdP の値で `name`・`nickname`・`given_name`・`family_name`・`picture` を更新）。`on_first_login` にすると、これらを直接編集できる | [Configure Identity Provider Connection for User Profile Updates](https://auth0.com/docs/manage-users/user-accounts/user-profiles/configure-connection-sync-with-auth0) |
| 一括のインポート | ファイルは 500 KB まで（メタデータが少なければ約 1,000 人）。テナントごとに同時 2 ジョブ。upsert はメタデータを併合せず上書きする。インポートした `user_id` には `auth0\|` の接頭辞が付く | [Bulk User Imports](https://auth0.com/docs/manage-users/user-migration/bulk-user-imports) |

未検証：ブロックしたユーザーの発行済みのリフレッシュトークンの扱い、エクスポートのリンクの有効期間。E5 と移行の Epic の着手前に、本家の資料か試用のテナントで確かめる。

## 3. ユーザーの保存

### 3.1 ユーザーの ID（`user_id` と `sub`）

- **`user_id` は接続から独立した不透明な文字列にする**（[ADR-0018](../decisions/0018-user-identifier-and-profile-store.md)）。既定は `usr_` と、128 ビットの乱数の base62（22 文字）。ID トークンとアクセストークンの `sub` は、この値をそのまま使う。
- 本家は `user_id` に接続の種類を含める。本システムはそうしない。接続の種類はアプリが `sub` から推測すべきものではない。接続の名前を変えても `sub` が変わらない。
- 主キーは別に UUIDv7 の `id` を持つ（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。`user_id` を外に出す識別子、`id` を内部の結合に使う。UUIDv7 は作成の時刻を含むので、外には出さない。
- インポートと Management API の作成では、`user_id` を指定できる（他の IdP からの移行で `sub` を保つため）。形は `^[A-Za-z0-9_\-|.:@]{1,255}$`（OIDC Core の `sub` の上限 255 文字の ASCII に合わせる）。
- **本家から移るテナントの `auth0|...` のような `user_id` は、テナントの顧客のデータとして受け取る。** 本家の名前を含むが、本システムが作る識別子・接頭辞ではない（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) の対象外）。値をそのまま保存し、`sub` として返す。本システムは `user_id` を作るときに本家の名前の接頭辞を付けない。文書・サンプル・テストのデータでは `auth0|` の形を使わず、`legacy|...` などの中立の例を使う。
- **`user_id` はテナントの中で再利用しない。** 削除したユーザーの `user_id` は、HMAC の値を墓標（`user_tombstones`）に残し、同じ値での作成を拒否する（7 節）。OIDC Core は、`sub` を発行者の中で再割り当てしないことを求めている。
- 仮名の `sub`（pairwise）は持たない（16 節の決定）。需要が出たら、アプリごとの `sub` の写像を新しい ADR で足す。

### 3.2 スキーマ

```sql
-- all tables: tenant_id first in PK/indexes, FORCE ROW LEVEL SECURITY (ADR-0002)
CREATE TABLE users (
  tenant_id        uuid        NOT NULL,
  id               uuid        NOT NULL,            -- UUIDv7, internal
  user_id          text        NOT NULL,            -- external, = sub
  primary_identity_id uuid     NOT NULL,            -- user_identities.id
  email            text,                             -- as provided; display
  email_normalized text,                             -- lower(NFKC(email)); lookup
  email_verified   boolean     NOT NULL DEFAULT false,
  username         text,                             -- database connections only
  name             text, given_name text, family_name text, nickname text,
  picture          text,                             -- https URL only
  locale           text,
  user_metadata    jsonb       NOT NULL DEFAULT '{}',  -- <= 16 KiB serialized
  app_metadata     jsonb       NOT NULL DEFAULT '{}',  -- <= 16 KiB serialized
  status           text        NOT NULL DEFAULT 'active', -- active | blocked | deleted (tombstone row, ADR-0055)
  deleted_at       timestamptz,
  blocked_at       timestamptz,
  blocked_by       text,                             -- admin | brute_force | scim | breached_password
  webauthn_user_handle bytea   NOT NULL,             -- 64 random bytes (mfa-and-passkeys.md)
  last_login_at    timestamptz,
  last_ip          inet,                             -- PII; see section 11
  logins_count     bigint      NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  version          bigint      NOT NULL DEFAULT 1,   -- optimistic concurrency
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, webauthn_user_handle)
);

CREATE TABLE user_identities (          -- owned jointly with connections.md (ADR-0014)
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL,
  user_pk          uuid NOT NULL,        -- users.id
  connection_id    uuid NOT NULL,
  provider_user_id text NOT NULL,        -- IdP's stable id (e.g. OIDC sub), or generated for database
  profile_data     jsonb NOT NULL DEFAULT '{}', -- attributes from the IdP (<= 16 KiB)
  email_normalized text,
  email_verified   boolean NOT NULL DEFAULT false,
  linked_at        timestamptz,          -- null for the identity the user was created with
  created_at       timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, connection_id, provider_user_id)
);

CREATE TABLE user_tombstones (
  tenant_id      uuid        NOT NULL,
  user_id_hmac   bytea       NOT NULL,   -- HMAC-SHA-256(tenant key, user_id)
  deleted_at     timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id_hmac)
);
```

- 1 人のユーザーは 1 つ以上の `user_identities` を持つ。0 個にはならない（リンクの解除で最後の 1 つは外せない）。
- データベース接続での一意性（同じ接続で同じメールアドレス・ユーザー名を持てない）は、`user_identities` とパスワードの資格情報の表の側で保つ（[connections.md](connections.md)）。**`users.email_normalized` には一意の制約を置かない。** 別の接続（データベースと Google）で同じメールアドレスの別のユーザーがありうる（本家と同じ）。
- パスワードのハッシュ、MFA の要素、パスキー、セッション、リフレッシュトークンは、それぞれの領域の表にあり、`user_pk` で参照する。
- 1 テナントのユーザー数の上限は設けない。S1 の最大のテナントは数百万を想定し、`(tenant_id, …)` の索引で引く。

### 3.3 ルートの属性の出どころ

- `users` のルートの属性（`email`、`name`、`picture` など）は、主の ID（`primary_identity_id`）から作る。
- ソーシャル接続の ID でログインするたびに、IdP から得た属性で `profile_data` を更新する。主の ID なら、ルートの属性も更新する。接続の設定 `sync_user_profile`（`on_each_login`（既定）・`on_first_login`）が `on_first_login` なら、最初の作成のときだけ写す。本家の `set_user_root_attributes` と同じ振る舞い（2 節）。
- データベース接続の ID のルートの属性は、Management API とサインアップの画面でだけ変わる。
- `email_verified` は、IdP が確かめたと言うときだけ真にする。Google の `email_verified`、Apple のメール、LINE・GitHub の扱いは [connections.md](connections.md) の部品が決める。リンクの判断（5 節）はこの値に依存するので、部品が根拠なく真を返さないことを接続の側の試験で確かめる。

### 3.4 メールアドレスの変更

- Management API でメールアドレスを変えると、`email_verified` を偽に戻す（要求で `email_verified: true` を明示したときを除く）。`verify_email: true` なら確認のメールを送る（[email-delivery.md](email-delivery.md)）。
- データベース接続の ID では、同じ接続の中で一意でなければ 409 を返す。
- ソーシャル接続の ID のメールアドレスは、Management API では変えられない（IdP の値で上書きされるため。`sync_user_profile` が `on_first_login` のときだけ変えられる）。
- 変更の前のメールアドレスには、変更の通知を送る（テナントの設定。既定は有効）。乗っ取りの早い発見のため。

## 4. メタデータ

| 種類 | 誰が書けるか | 用途 | 上限 |
| --- | --- | --- | --- |
| `user_metadata` | Management API（管理者）。後に、本人が自分の分だけ（アカウントの画面、MVP の後） | 表示の設定、好み | 直列化して 16 KiB |
| `app_metadata` | Management API（管理者と M2M）だけ。本人は変えられない | ロール、プラン、外部のシステムの ID | 直列化して 16 KiB |

- **上限は固い上限にする。** 超える書き込みは 400（`metadata_too_large`）で拒否する。本家はプロファイルを 10 KB とし、超えても今は成功させる。本システムは、Aurora の行の大きさ、トークン・userinfo への展開、検索の索引の費用を読めるようにするため、最初から拒否する（[ADR-0018](../decisions/0018-user-identifier-and-profile-store.md)）。
- 名前の規則：
  - 名前は 1〜255 文字。`.` と `$` を含めない（本家と同じ）。入れ子は 10 段まで。
  - `app_metadata` の最上位に、予約の名前（`user_id`、`email`、`email_verified`、`identities`、`blocked`、`created_at`、`updated_at`、`last_login`、`logins_count`、`__tenant`）を使えない。
- 更新の規則：
  - `PATCH` は最上位の名前ごとに併合する。値が `null` の名前は消す。2 段目より下は、送った値で置き換える。空のオブジェクトで全体を消す（本家と同じ。2 節）。
  - 同時の更新は `version` で守る。`If-Match` を送った要求は、バージョンが違えば 412 を返す。送らない要求は後勝ちにする。
- **秘密と機微な個人情報を入れないよう、ダッシュボードと文書で示す。** 本システムは中身を検査しない。ただし、既知のトークンの形（`<brand>_rt_` など）を含む書き込みは、秘密の漏れの兆候として 400 で拒否する（[ADR-0004](../decisions/0004-credential-storage.md) のログの走査と同じ検出器）。
- トークンへの載せ方：MVP ではメタデータを ID トークン・アクセストークン・userinfo に自動では載せない。テナントが載せたいものは、Actions に相当する拡張（E13）で名前空間付きのクレームとして足す（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)）。
- 更新の監査：メタデータの変更は、変わった最上位の名前だけをログに残す。値はログに出さない。

## 5. ID のリンク

### 5.1 3 つの経路

| 経路 | いつ | 誰が認証するか | MVP |
| --- | --- | --- | --- |
| 本人のリンク | ログインの途中で、同じ確認済みのメールアドレスを持つ既存のユーザーが見つかったとき、画面で「既存のアカウントにつなぐ」を選ぶ | 新しい ID（今のログイン）と、既存のユーザーの ID の両方で本人が認証する | あり |
| アプリのリンク | アプリが、ログイン中のユーザーに別の接続での認証をさせ、つなぐ | 両方の ID の認証の結果（ID トークン）を本システムが確かめる | あり（Management API の `POST /users/{id}/identities` に、2 つ目の ID の ID トークンを渡す形） |
| 管理者のリンク | 管理者が Management API で 2 人のユーザーをつなぐ | 本人の認証はない。管理者の責任 | あり。ダッシュボードで危険を示す |

- **メールアドレスの一致だけで、黙ってリンクしない**（[ADR-0019](../decisions/0019-account-linking.md)）。本家も、両方で認証してからリンクするよう求めている。
- 自動のリンクをテナントが望む場合でも、MVP では「本人のリンク」の画面を経る。完全に自動のリンクは提供しない（持ち越しに置かない。乗っ取りの経路になるため）。

### 5.2 本人のリンクの手順

```
ユーザー            Universal Login（Auth）                         DB
  │ Google でログイン    │                                             │
  │─────────────────────▶│ VerifiedIdentity（email_verified=true）      │
  │                      │── (connection, provider_user_id) で引く ────▶│ なし
  │                      │── email_normalized が同じで、確認済みの      │
  │                      │   ユーザーを引く（同じテナント、reader でなく writer）▶│ 1 人あり
  │◀── 画面：「このメールアドレスのアカウントがあります。            │
  │     そのアカウントでログインしてつなぐ／別のアカウントとして作る」│
  │ つなぐを選ぶ          │                                             │
  │◀── 既存のユーザーの主の接続でログイン（パスワード＋MFA、またはパスキー）
  │─────────────────────▶│ 既存のユーザーとして認証が済む              │
  │                      │── トランザクション：                          │
  │                      │   user_identities に新しい ID を追加          │
  │                      │   （linked_at を記録、users.version を上げる） ▶│
  │                      │── outbox：user.identity_linked               ▶│
  │◀── ログインを続ける（sub は既存のユーザーのもの）                  │
```

- 画面の文言は、既存のアカウントの存在をメールアドレスの持ち主にだけ伝える形にする。新しい ID の側でメールアドレスが確認済みのときだけこの画面を出すので、他人のメールアドレスで存在を探ることはできない。
- 既存のユーザーの認証には、テナントの MFA の方針をそのまま適用する。リンクの画面で MFA を省かない。
- 新しい ID と既存の認証の間は、同じ Universal Login のトランザクション（[ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md)）の中で持つ。トランザクションの期限が切れたら、リンクせずに最初からやり直す。

### 5.3 決定表：リンクを提案するか

| # | 新しい ID の `email_verified` | 同じメールアドレスの既存のユーザー | 既存のユーザーのメールアドレスが確認済み | 既存のユーザーがブロック中 | テナントの設定 `account_linking` | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 偽 | — | — | — | — | 提案しない。新しいユーザーを作る |
| 2 | 真 | なし | — | — | — | 新しいユーザーを作る |
| 3 | 真 | 1 人 | 偽 | — | — | 提案しない。新しいユーザーを作る（未確認の側を信じない） |
| 4 | 真 | 1 人 | 真 | 偽 | `off` | 新しいユーザーを作る |
| 5 | 真 | 1 人 | 真 | 偽 | `prompt` | 5.2 の画面を出す |
| 6 | 真 | 1 人 | 真 | 真 | `prompt` | 提案しない。新しいユーザーも作らず、ブロックの画面を出す（ブロックの回避を防ぐ） |
| 7 | 真 | 2 人以上 | — | — | `prompt` | 提案しない。新しいユーザーを作り、`user.link_ambiguous` をログに残す |

- `account_linking` の既定は `off`（本家も既定ではリンクしない）。
- 行 6：ブロック中のユーザーと同じ確認済みのメールアドレスで、別のユーザーを作れると、ブロックを回避できる。テナントの設定 `block_signup_for_blocked_email`（既定は真）で、作成を止める。

### 5.4 リンクの効果と解除

- リンクの後も、主のユーザーの `user_id`（`sub`）は変わらない。
- 「アプリのリンク」と「管理者のリンク」で、従のユーザーが既に存在するとき：
  - 従のユーザーの ID を主へ移し、従のユーザーを削除する（7 節の削除の流れ。墓標を残す）。
  - 従の `user_metadata`・`app_metadata` は捨てる（本家と同じ）。捨てる前に、Management API の応答で従のメタデータを 1 回だけ返し、呼び出した側が併合できるようにする。
  - 従のユーザーのセッションとリフレッシュトークンは失効させ、Back-Channel Logout を送る（[sessions-and-sso.md](sessions-and-sso.md)）。従の `sub` を持つアプリの側のデータは、アプリが付け替える。本システムは `user.identity_linked` のログストリームのイベントに、従の `user_id` を含める。
  - 従の MFA の要素とパスキーは移さない。主のものだけが残る（従の要素を移すと、従の側の攻撃者が主へ入れる）。
- 解除（`DELETE /users/{id}/identities/{connection}/{provider_user_id}`）：
  - 外した ID で、新しいユーザーを作る。新しい `user_id` を振る。`profile_data` から、ルートの属性を作る。
  - 主の ID は外せない。外したいときは、先に主を替える（`primary_identity_id` の変更。MVP の後）。
  - 外した ID に紐づくセッションは失効させる。
- 主のユーザーを削除すると、リンクしたすべての ID も消える（本家と同じ）。

## 6. ユーザーの検索

- **Aurora の reader の上で、限られた問い合わせの言語で検索する**（[ADR-0020](../decisions/0020-user-search-and-lifecycle.md)）。本家の Lucene の構文とは互換にしない。
- 管理の経路の DB の接続プールを使い、認証の経路と分ける（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。認証の経路は検索の API を使わない。ユーザーの特定は `user_identities` の一意の組か、`user_id` で行う。

問い合わせの言語：

```
q = term *( " AND " term )
term = field ":" value
     | field ":" "[" value " TO " value "]"      ; range, timestamps only
     | field ":" value "*"                       ; prefix, text fields only, >= 3 chars
field = "user_id" | "email" | "email_verified" | "username" | "name"
      | "connection" | "status" | "created_at" | "last_login_at" | "logins_count"
      | "app_metadata." path | "user_metadata." path   ; exact match on scalar
```

| 項目 | 値 |
| --- | --- |
| 1 ページの件数 | 既定 50、最大 100 |
| 結果の総数の上限 | 1,000 件（本家と同じ）。超える一覧はエクスポート（8 節）を使う |
| 並べ替え | `created_at`、`last_login_at`、`email`、`name`。メタデータでは並べ替えない（本家と同じ） |
| 時間の上限 | 2 秒（`statement_timeout`）。超えたら 503 と `Retry-After`（本家と同じ） |
| 反映 | reader の複製の遅れだけ遅れる（通常 1 秒未満）。書き込みの直後の確認には ID での取得を使うよう示す |
| 索引 | `(tenant_id, email_normalized)`、`(tenant_id, created_at)`、`(tenant_id, last_login_at)`、`(tenant_id, username)`、`name` の `pg_trgm`、メタデータの `jsonb_path_ops` の GIN |
| 大文字小文字 | `email` と `username` は区別しない |

- OR、否定、任意の中間一致は MVP で持たない。索引で答えられない問い合わせを許すと、大きなテナントで reader を占有するため。必要な検索は、エクスポートかログストリームで外に出して行ってもらう。
- メタデータの検索は、スカラーの値の完全一致だけにする。値が 256 文字を超える項目は索引に載らない。
- レート制限は management-api-and-rate-limiting の領域で、検索に別の低い枠を置く。
- S2 で、検索の負荷が reader を圧迫したら、専用の検索の基盤（OpenSearch など）へ outbox から写すかを測って決める（16 節の持ち越し。計測）。

## 7. ブロックと削除

### 7.1 ステートマシン

```
             create
               │
               ▼
  ┌──────── active ◀──────────────┐
  │            │ block             │ unblock
  │            ▼                   │
  │         blocked ───────────────┘
  │            │
  │ delete     │ delete
  ▼            ▼
 deleted（墓石：プロフィールを消し、deleted_at を付ける。資格情報・ID・セッションは同じトランザクションで物理削除）
   │ 30 日
   ▼
 （行なし）＋ user_tombstones（user_id の HMAC。消さない）
```

- `status` は `active`・`blocked`・`deleted` の 3 つ。`deleted` の行（墓石）は、外からは「存在しない」（404）に見える。墓石と 30 日の期限は、security の領域の [ADR-0055](../decisions/0055-data-retention-and-deletion.md) の決定に従う。
- ブルートフォースの防御による「ユーザー × IP のブロック」は、この `status` とは別（[attack-protection.md](attack-protection.md)）。この `status` の `blocked` は、すべての IP・すべての接続でのログインを止める。

### 7.2 ブロック

| 流れ | `blocked` のユーザー |
| --- | --- |
| Universal Login のログイン（どの接続でも） | 資格情報を確かめた後に、ブロックの画面を出す。資格情報の照合の前には判定しない（ブロックの有無で、パスワードの正否を探れないようにする） |
| パスキーのログイン | 同じ |
| 既存のセッションでの SSO | 断る。ブロックの時点でセッションを失効させる |
| リフレッシュトークンの交換 | `invalid_grant`。ブロックの時点で全系列を失効させる |
| パスワードの再設定 | メールは送るが、再設定の後もログインはできない（ブロックの回避にしない） |
| Management API での取得・検索 | 見える（`status: blocked`） |
| 発行済みのアクセストークン | 期限まで有効（JWT。[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)）。すぐに止めたいテナントには短い有効期間を勧める |

- ブロックと解除は Management API（`PATCH /users/{id}` の `blocked`）で行う。`blocked_by` に理由の種類を残す。
- ブロックすると、outbox から `user.blocked` を出し、Back-Channel Logout を送る（[sessions-and-sso.md](sessions-and-sso.md)）。

### 7.3 削除

- Management API の `DELETE /users/{id}`。[ADR-0055](../decisions/0055-data-retention-and-deletion.md) の手順に、`sub` の再利用の禁止を足す。1 つのトランザクションで次を行う。
  1. `user_identities`、パスワードの資格情報、MFA の要素、パスキー、リカバリーコード、同意（grants）、ブルートフォースのブロックの行、セッション、リフレッシュトークンの系列を物理削除する。以後、ログインもトークンの更新もできない。
  2. `users` の行を墓石にする：`status = deleted`、`deleted_at` を付け、`email`・名前・`picture`・メタデータ・`last_ip` を消す。
  3. `user_tombstones` に `user_id` の HMAC を入れる。
  4. outbox に `user.deleted`（`user_id` だけ）を入れる。Worker が Back-Channel Logout とログストリームを送る。
- 墓石の行は 30 日後に Worker が物理削除する。`user_tombstones` は消さない（`sub` を再び割り当てないため。個人データは HMAC の値だけ）。
- 同じメールアドレスでの再登録は、墓石の間も許す（新しい `user_id` になる。ADR-0055）。
- **認証のログ**：ADR-0055 に従い、非同期のジョブでログの中の個人データ（メールアドレス、名前）を仮名に置き換える。`user_id` と IP は、攻撃の調査のため、ログの保持の期間（[intent.md](../intent.md) の L5）まで残す。法務の L1・L5・L7 の結論で変えうる。
- バックアップからは 35 日で消える（ADR-0055）。
- 削除は取り消せない。ダッシュボードでは、`user_id` の入力で確かめる。
- **一括の削除**は MVP で持たない。管理者は検索と 1 件ずつの削除か、Management API をスクリプトで呼ぶ。

### 7.4 本人の情報の開示

- テナントがエンドユーザーからの開示の請求に応えるため、Management API に `GET /users/{id}/export` を置く。プロファイル、メタデータ、ID の一覧（接続の名前と `provider_user_id`）、MFA の要素の種類と登録の日時（秘密は含めない）、直近 30 日のログインの記録を JSON で返す。秘密（ハッシュ、TOTP の種、公開鍵以外の鍵の材料）は返さない。

## 8. インポート・エクスポート（MVP の後）

- 非同期のジョブにする。Worker で動かし、認証の経路と別の DB の接続プールを使う。

| 項目 | インポート | エクスポート |
| --- | --- | --- |
| 形式 | JSON Lines（1 行 1 ユーザー）。gzip 可 | JSON Lines または CSV。gzip |
| 受け渡し | S3 の署名付きの URL にアップロード（最大 500 MiB） | S3 の署名付きの URL（有効 15 分）。ファイルは 7 日で消す |
| 1 ジョブの件数 | 最大 100 万件（本家はファイル 500 KB まで。移行の手間を減らすため大きくする） | テナントの全件。項目を選べる |
| 同時のジョブ | テナントごとに 2 つ（本家と同じ） | テナントごとに 2 つ |
| 重複 | `upsert: false`（既定）なら、既存のユーザー（同じ接続の同じメールアドレス、または同じ `user_id`）は失敗の行として報告する。`true` なら更新する。メタデータは併合せず上書きする（本家と同じ） | — |
| パスワード | `password_hash` を PHC 形式で受け取る。MVP の後の最初のバージョンは bcrypt と Argon2id。PBKDF2 などはこの Epic で足す（[ADR-0004](../decisions/0004-credential-storage.md)） | ハッシュは出さない |
| MFA | TOTP の種を受け取れる（暗号化して保存）。パスキーは受け取らない（RP ID が変わると使えないため） | 出さない |
| 結果 | 行ごとの成功・失敗の要約。失敗の理由（行番号、コード）を別のファイルで返す。個人の値は結果に書かない | — |

- インポートした `user_id` が墓標にあるとき、その行は失敗にする（再利用の禁止）。
- インポートの前に、パスワードのハッシュの形式と件数を調べる「検査だけ」のモードを置く。
- エクスポートのファイルは、テナントの管理者だけが URL を得られる。URL を発行したことを監査ログに残す。

## 9. SCIM 2.0 の受け入れ（MVP の後、エンタープライズ接続と Organizations の後）

- エンタープライズ接続（SAML・OIDC・Entra ID）ごとに、SCIM のエンドポイントを置く。企業の IdP が、ユーザーの作成・更新・無効化を押し込む。
- 準拠する仕様：RFC 7643（スキーマ）、RFC 7644（プロトコル）。
- エンドポイント：`/scim/v2/{connection_id}/Users`、`/ServiceProviderConfig`、`/ResourceTypes`、`/Schemas`。`Groups` は Organizations のロールの設計が決まってから足す。
- 認証：接続ごとの Bearer トークン（`<brand>_scim_` の接頭辞と 256 ビットの乱数。SHA-256 で保存。[ADR-0004](../decisions/0004-credential-storage.md)）。有効期限を必須にし（最長 1 年）、2 つまで並べて持てる（入れ替えのため）。
- 対応：

| SCIM | 本システム |
| --- | --- |
| `id` | `user_id` |
| `externalId` | `user_identities.provider_user_id`（その接続の ID）。一致の判定に使う |
| `userName` | その接続の ID の `profile_data.userName`。SAML・OIDC のログインで届く主体の値と一致させる設定を持つ |
| `emails[primary]` | `email` |
| `name.givenName`・`name.familyName` | `given_name`・`family_name` |
| `active: false` | `status: blocked`（`blocked_by: scim`）。セッションとリフレッシュトークンを失効させる |
| `DELETE` | 7.3 の削除 |
| 企業の拡張（`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User`） | `app_metadata.scim.enterprise` に写す |

- フィルターは `userName eq`、`externalId eq`、`emails.value eq` だけに対応する（`ServiceProviderConfig` で示す）。`PATCH` は `add`・`replace`・`remove` に対応する。一括（Bulk）は持たない。
- SCIM で作ったユーザーは、その接続の ID を持つ。最初のログインの前から存在する。SCIM の外（Management API）での同じ項目の変更は、次の SCIM の更新で上書きされる。

## 10. 障害時の振る舞い

| 事象 | 振る舞い |
| --- | --- |
| 同じ外部の ID で、2 つの要求が同時にユーザーを作ろうとする | `user_identities` の一意の制約で 1 つだけ成功する。負けた側は、作られたユーザーを読み直して、そのユーザーとしてログインを続ける |
| リンクの途中で、既存のユーザーが削除・ブロックされる | リンクのトランザクションで `users.version` と `status` を確かめ、変わっていれば中止して最初からやり直させる |
| 2 つのリンクが同じ従のユーザーを取り合う | 従のユーザーの行を `SELECT … FOR UPDATE` で取り、後の方を 409 にする |
| Aurora の writer のフェイルオーバー | ユーザーの作成・リンク・更新は 503（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。既存のユーザーのログインの読み込みは reader で続く。`last_login_at` と `logins_count` の更新は outbox から遅れて書く |
| reader の遅れ | ログインの直後の Management API の検索に出ない。ID での取得は writer から読む |
| 検索の時限切れ | 503 と `Retry-After`。問い合わせを狭くするよう、エラーの本文で示す |
| メタデータの上限を超える | 400。部分的には書かない |
| インポートの途中で Worker が落ちる | ジョブは行の番号の単位で進み具合を記録し、再開する。行ごとの書き込みは `user_id` か一意の組で冪等にする |
| 削除の outbox が遅れる | 資格情報は消えているので、ログインはできない。Back-Channel Logout だけが遅れる |
| RLS のコンテキストの設定漏れ | ユーザーが見つからない（404）。ログインの失敗に見える。結合テストで全エンドポイントを確かめる（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)） |

- `last_login_at`・`logins_count`・`last_ip` は、ログインのたびに writer に同期で書かない。outbox のイベントから Worker が書く。ログインの経路の writer への書き込みを減らす（[ADR-0005](../decisions/0005-authentication-path-availability.md)）。値は数秒遅れる。

## 11. セキュリティとプライバシー

- **乗っ取りの経路を塞ぐ。** メールアドレスの一致だけでリンクしない（5 節）。従の MFA の要素を主へ移さない。メールアドレスの変更は古いアドレスへ通知する。
- **ユーザーの有無を漏らさない。** サインアップ・ログイン・再設定の画面で、ユーザーが存在するかどうかで応答の文言・時間を変えない（[connections.md](connections.md)）。リンクの提案の画面は、確認済みのメールアドレスの持ち主にだけ出す。
- **Management API の権限を分ける。** 読み取り（`read:users`）、更新（`update:users`）、`app_metadata` の更新（`update:users_app_metadata`）、削除（`delete:users`）、ブロック（`update:users` に含める）、エクスポート（`read:users_export`）をスコープで分ける（management-api-and-rate-limiting の領域）。
- **個人データ**：`email`、`name`、`picture`、`last_ip`、`profile_data`、メタデータは個人データになりうる。
  - `last_ip` は、テナントの設定で記録しないことを選べる。
  - 認証のイベントのログの `user_name` には、本家と同じくログインに使った識別子（メールアドレス）を載せる。ログはテナントのデータで、調査に要るため。保持は `log_retention_days` で切り、ログストリームでは伏せ字を選べ、ユーザーの削除では仮名にする（[logs-and-streams.md](logs-and-streams.md) の 3.1・4.2 節。本家の `user_name` がメールアドレスであることは [Adaptive MFA Log Events](https://auth0.com/docs/secure/multi-factor-authentication/adaptive-mfa/adaptive-mfa-log-events) の例で確認、2026-09-27）。
  - バックアップからの削除は、バックアップの保持の期間（35 日）の後に自然に消える形にする（[ADR-0055](../decisions/0055-data-retention-and-deletion.md)）。
- **`picture` の URL** は `https:` だけを受け付ける。画面に出すときは、Universal Login の CSP の `img-src` の範囲で表示する（[universal-login.md](universal-login.md)）。
- 法務の確認待ち：L1（委託か自らの取得か）、L7（開示・削除の請求の窓口と、ログの扱い）。この領域の Story のうち、7.3 のログの扱いと 7.4 の開示の形は、L7 の結論が出るまで PM・QA が承認しない。

## 12. テスト

### 12.1 決定表

- 5.3 のリンクの提案の表の各行を、Universal Login の結合テストにする。
- 7.2 のブロックの表の各行（流れ × ブロック）を結合テストにする。
- 下のリンクの効果の表を、Management API の結合テストにする。

| # | 経路 | 従のユーザーが存在する | 従にメタデータがある | 期待 |
| --- | --- | --- | --- | --- |
| 1 | 本人のリンク | いいえ（新しい ID） | — | 主に ID が 1 つ増える。`sub` は主のまま |
| 2 | アプリのリンク | はい | はい | 従は削除、墓標あり。応答に従のメタデータを 1 回だけ含む。従のセッション・リフレッシュトークンは失効 |
| 3 | 管理者のリンク | はい | いいえ | 2 と同じ。監査ログに管理者の操作として残る |
| 4 | どれか | 主と従が同じユーザー | — | 400 |
| 5 | どれか | 従がブロック中 | — | 409（先に解除させる。ブロックの回避を防ぐ） |
| 6 | 解除 | 主の ID を指定 | — | 400 |

### 12.2 性質ベーステスト（fast-check）

テスト名には要件 ID を含める（開発リポジトリで採番する）。

- 任意の作成・リンク・解除・削除の操作の列の後で：
  - すべてのユーザーは 1 つ以上の ID を持つ。
  - 1 つの `(tenant_id, connection_id, provider_user_id)` は、高々 1 人のユーザーに属する。
  - 一度使われた `user_id` は、削除の後も、別の人に割り当てられない（墓標）。
  - 主のユーザーの `user_id` は、リンクと解除で変わらない。
- 任意のメタデータの `PATCH` の列で、結果は「最上位の併合、`null` で削除」の参照の実装と一致する。直列化の大きさが上限を超える結果は、どの時点でも保存されない。
- 任意の 2 テナントで、一方のコンテキストの検索・取得・リンクが、他方のユーザーを返さない・触らない（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。
- 任意の問い合わせの文字列で、構文解析が成功したものは、索引を使う SQL に変換される（`EXPLAIN` で逐次走査が出ないことを、代表のデータで確かめる）。構文解析に失敗したものは 400 になり、SQL に届かない。

### 12.3 その他

- 結合テスト：ブロックしたユーザーのリフレッシュトークンが、ブロックの直後から `invalid_grant` になる。
- 結合テスト：削除したユーザーの `user_id` を指定した作成・インポートが失敗する。
- 負荷試験（E12）：100 万ユーザーのテナントで、検索の p99 が 2 秒に収まる代表の問い合わせの集合を決める。

## 13. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0018](../decisions/0018-user-identifier-and-profile-store.md) | ユーザーの ID は接続から独立した不透明な値にし、再利用しない。メタデータに固い上限 | accepted |
| [0019](../decisions/0019-account-linking.md) | ID のリンクは両方の ID での本人の認証を必須にし、メールアドレスの一致だけでは自動にリンクしない | accepted |
| [0020](../decisions/0020-user-search-and-lifecycle.md) | ユーザーの検索は Aurora の reader の上の限られた言語で行う。ブロックと削除はステートマシンで扱い、削除した ID を墓標で守る | accepted |

## 14. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E2 | `users`・`user_identities`・`user_tombstones` の表と RLS、Management API のユーザーの作成・取得・更新・削除（`user_id` の指定を含む） |
| E2 | メタデータの検証（大きさ、名前、予約の名前、秘密の形の拒否）と、最上位の併合の `PATCH`、`If-Match` |
| E4 | データベース接続のサインアップでのユーザーの作成、`last_login_at` などの outbox からの更新 |
| E4 | メールアドレスの変更と、古いアドレスへの通知 |
| E5 | ブロック・削除に伴うセッションとリフレッシュトークンの失効、Back-Channel Logout の送信 |
| E6 | ソーシャルのログインでのユーザーの作成と `profile_data` の同期（`sync_user_profile`） |
| E6 | 本人のリンクの画面（5.2、5.3 の決定表） |
| E6 | アプリのリンク・管理者のリンク・解除の Management API（5.4） |
| E8 | ブロック中のユーザーと同じメールアドレスでのサインアップの停止（5.3 の行 6） |
| E9 | ダッシュボードのユーザーの一覧・検索・詳細・ブロック・削除・リンクの画面 |
| E9 | 検索の問い合わせの言語と索引（6 節）、検索のレート制限の枠 |
| E10 | ユーザーのイベント（`user.created`・`user.updated`・`user.deleted`・`user.blocked`・`user.identity_linked`・`user.identity_unlinked`）のログとログストリーム |
| E12 | 開示の API（7.4）、法務の L7 の結論の反映。100 万ユーザーでの検索の負荷試験 |
| MVP の後（移行。[roadmap.md](../roadmap.md) の後回し） | 一括のインポート（bcrypt・Argon2id、検査だけのモード）とエクスポート |
| MVP の後（E14 の後） | SCIM 2.0 の受け入れ（エンタープライズ接続の後） |

## 15. 品質・運用・データへの引き継ぎ

- [quality.md](../quality.md) に入れる候補：
  - リスク：ID のリンクの誤りによる乗っ取り（上位のリスクに入れる）。5.3・12.1 の決定表と、リンクの性質ベーステストを E6 の必須のテストにする。
  - `sub` の不変と再利用の禁止を、性質ベーステストでリリースの基準にする。
  - 検索の問い合わせの言語のファジング（構文解析の失敗が 400 になり、SQL に届かない）。
  - 本番での検証：リンクの提案・実行・拒否の件数、`user.link_ambiguous` の件数を日次で見る。
- [runbooks/](../runbooks/README.md) に入れる候補：
  - エンドユーザーからの削除・開示の請求を受けたテナントへの案内と、本システムの運用者が代わりに行う場合の手順（L7 の後）。
  - 誤ったリンクの復旧（管理者のリンクの誤り）：解除で ID を分け、新しい `user_id` になることをテナントに伝える。元の `user_id` は戻らない。
  - 大口のテナントの検索が reader を圧迫したときの、検索の枠の一時的な引き下げ。
  - インポートのジョブの停止と再開。
- [data-model.md](data-model.md) の索引に入れる候補：`users`、`user_identities`（connections と共有）、`user_tombstones`、`user_import_jobs`・`user_export_jobs`（MVP の後）、`scim_tokens`（MVP の後）。各表の持ち主は、この領域。

## 16. 未解決の問い

- 仮名の `sub`（pairwise）を提供するか。本家にはない。需要を見て決める。
- 本人のメタデータの更新（アカウントの画面、My Account の API に相当するもの）をいつ入れるか。
- 主の ID の変更（`primary_identity_id` の付け替え）を MVP で持つか。

### 決定（2026-09-27、既定案）

- **`user_id` の形**：接続から独立した `usr_` ＋ 22 文字。インポートでは指定を許し、接頭辞を足さない（本家は `auth0|` を付ける。本家から移るテナントは、本家の `user_id` をそのまま指定すれば `sub` を保てる。その値はテナントの顧客のデータとして扱う。3.1 節）。本家の `<種類>|<ID>` の形とは互換にしない（リポジトリ共通の ADR-0006 と、接続の名前を変えても `sub` が変わらないことを優先）。
- **メタデータの上限**：それぞれ 16 KiB の固い上限。本家（10 KB の緩い上限、合わせて 16 MB）より厳しい。移行で困るテナントが出たら、テナントごとの上限の引き上げ（最大 64 KiB）を Management API の設定で許すかを、移行の Epic（MVP の後）で決める。
- **自動のリンク**：提供しない。本人のリンクの画面を経る。
- **検索の言語**：本家の Lucene と互換にしない。AND・完全一致・前方一致・範囲だけ。
- **ブロックしたユーザーのリフレッシュトークン**：ブロックの時点で失効させる（本家の振る舞いは未検証）。
- **従のメタデータ**：本家と同じく捨てる。ただし応答で 1 回だけ返す。
- **削除とログ**：[ADR-0055](../decisions/0055-data-retention-and-deletion.md) に従う（ログの個人データは仮名化、`user_id` と IP は保持の期間まで）。この領域は、墓石の後も `user_id` の HMAC を消さない点を足す。
- **主の ID の変更**：MVP の後。
- **ログのメールアドレス**（2026-09-27）：認証のイベントのログの `user_name` に載せる（本家と同じ。調査のため）。保持は `log_retention_days`、ストリームでは伏せ字を選べる（[logs-and-streams.md](logs-and-streams.md) の 3.1 節）。

### 決定（2026-09-27、推奨案で確定）

- **仮名の `sub`（pairwise）**：持たない。本家にもない。需要が出たら新しい ADR で足す。
- **本人のメタデータの更新（アカウントの画面、My Account の API）**：MVP の後（[roadmap.md](../roadmap.md) の「後回し」）。
- **SCIM の `Groups`**：SCIM の最初のバージョンは `Users` だけにする。`Groups` は組織のロール（E14）の後に足す。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 検索を専用の基盤へ移すか | S2 の前。E12 の負荷試験と本番の検索の p99 で判断する |
| インポートで受け取るハッシュの形式の一覧 | 移行の Epic（MVP の後）の着手前に、移行元として多い IdP の形式を調べる（調査） |

## References

- Auth0 Docs: [User Account Linking](https://auth0.com/docs/manage-users/user-accounts/user-account-linking)（2026-09-27 に確認）
- Auth0 Docs: [Metadata Field Names and Data Types](https://auth0.com/docs/manage-users/user-accounts/metadata/metadata-fields-data)（2026-09-27 に確認）
- Auth0 Support: [What is the Maximum Size of user_metadata and app_metadata](https://support.auth0.com/center/s/article/What-is-the-maximum-size-of-user-metadata-and-app-metadata-profiles)（2026-09-27 に確認）
- Auth0 Docs: [User Search Best Practices](https://auth0.com/docs/manage-users/user-search/user-search-best-practices)（2026-09-27 に確認）
- Auth0 Docs: [User Profile Structure](https://auth0.com/docs/manage-users/user-accounts/user-profiles/user-profile-structure)（[ADR-0014](../decisions/0014-connection-abstraction.md) の出典）
- OpenID Foundation: [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html)（`sub` は 255 文字以下の ASCII で、再割り当てしない。2 節）
- IETF: [RFC 7643 SCIM Core Schema](https://www.rfc-editor.org/rfc/rfc7643)、[RFC 7644 SCIM Protocol](https://www.rfc-editor.org/rfc/rfc7644)

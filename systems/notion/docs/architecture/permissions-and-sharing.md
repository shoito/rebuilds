# Permissions and sharing: Notion

アカウント、ワークスペースのメンバーとゲスト、チームスペース、ページの権限と継承、共有、公開、連携の主体の設計。権限の継承と判定関数の集約は [ADR-0004](../decisions/0004-inherited-page-permissions.md)、テナントの分離は [ADR-0003](../decisions/0003-workspace-sharding.md) に従う。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0018](../decisions/0018-permission-levels-and-inheritance.md) | 権限の水準を本家に合わせ、ACL は設定したページで継承を置き換える |
| [0019](../decisions/0019-workspace-acl-version-cache.md) | 実効権限は、ワークスペースの権限のバージョン（acl_version）をキーにキャッシュし、権限の変更と同じトランザクションでバージョンを上げる |
| [0020](../decisions/0020-published-pages-isolation.md) | 公開ページは別の登録可能ドメインで、専用の描画サービスから配り、既定で検索エンジンに載せない |
| [0021](../decisions/0021-accounts-members-guests-and-teamspaces.md) | アカウントとメンバーを分け、ゲスト・連携もメンバーの行にし、チームスペースを最上位の暗黙の ACL にする |
| [0022](../decisions/0022-trash-history-and-deletion-retention.md) | ゴミ箱は 30 日、完全に削除した後も 30 日戻せ、ページの履歴はプランの日数で消す。バックアップの期限を削除の最終的な期限にする |
| [0024](../decisions/0024-integration-access-model.md) | 公開 API は本家の形と日付のバージョンに寄せ、連携は明示的に共有されたページだけを読む |
| [0033](../decisions/0033-transfer-private-pages-of-deactivated-members.md) | 無効化したメンバーのプライベートのページを、所有者が監査付きで別のメンバーへ移せるようにする（E10） |

この文書の決定表は設計の草案である。ID（`DT-...`）は、E2 の各変更の `spec.md` に移すときに振る。

本家の振る舞いは、2026-09-26 に Notion のヘルプセンターと開発者向けの文書で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 全体像

```
                ┌──── テナントの外（グローバル）────┐
Browser ───────▶│ accounts, sessions, auth_identities │  認証（Slack の identity-and-access.md に倣う）
                └───────────────┬─────────────────────┘
                                │ account_id
Browser / 連携 ─▶ API ── 主体の解決 ── members（role, kind）＋ workspace_acl_version
                          │            └ 主体の集合：user / group / team / ws / bot
                          ▼
                   can(actor, action, block)
                          │  block → page_id → 最も近い「ACL を持つ祖先（自身を含む）」
                          │  なければ最上位（チームスペース・プライベート）の暗黙の ACL
                          ▼
   画面・API・Sync Gateway の購読・検索・通知・Webhook・公開サイト・エクスポート・リレーション
```

- **認証はテナントの外、認可はテナントの中** で行う（Slack の [identity-and-access.md](../../../slack/docs/architecture/identity-and-access.md) と同じ）。認証の実装（ログインの手段、セッション、MFA、WebSocket のチケット）は Slack の ADR-0012（Better Auth）を先例にし、違いだけをこの文書に書く。
- 判定は `can(actor, action, block)` の 1 つの関数に集める（ADR-0004）。ブロックの権限は、そのブロックが属するページの権限である。
- 存在を漏らさないため、読めないページは 404、読めるが水準が足りないときは 403 を返す。

## 2. 主体

### 2.1 アカウントとメンバー

Slack の [ADR-0010](../../../slack/docs/decisions/0010-accounts-and-workspace-members.md) と同じ形にする（[ADR-0021](../decisions/0021-accounts-members-guests-and-teamspaces.md)）。

| テーブル | テナント | 中身 |
| --- | --- | --- |
| `accounts` | 外 | メールアドレス、確認済みか、作成・削除日時 |
| `members` | 内 | `account_id`（連携は NULL）、`kind`（`human` / `bot`）、`role`、表示名、アイコン、無効化日時 |

- テナントの中のデータ（ブロックの作成者、コメント、メンション、ACL）は、すべて `member_id` を参照する。
- ゲストも `members` の行にし、`role = guest` で分ける。
- 1 つのアカウントは、1 つのワークスペースに最大 1 行（`UNIQUE (workspace_id, account_id)`）。

### 2.2 ワークスペースのロール

本家のロールは、ワークスペースの所有者、メンバーの管理者（Enterprise だけ）、メンバー、ゲストの 4 つ（[Who's who in a workspace](https://www.notion.com/help/whos-who-in-a-workspace)）。

| ロール | 本家の説明の要約 | `role` |
| --- | --- | --- |
| ワークスペースの所有者 | 設定の管理、ワークスペースの削除、所有者・管理者・メンバー・ゲストの管理。1 人以上必要 | `owner` |
| メンバーの管理者 | メンバーの追加・削除だけ。設定は変えられない。Enterprise だけ | `membership_admin` |
| メンバー | 組織の人。読み・編集・コメント | `member` |
| ゲスト | 外部の協力者。ページ単位の招待だけ。ワークスペース全体への権限を持てず、メンバーや連携を追加できず、グループに入れない | `guest` |

- 本家には「制限付きメンバー」のロールもある。チームスペースを作れず、同じチームスペース・ページの人にだけ共有できる。本システムは MVP の後、E10 で `restricted_member` として足す（2026-09-28 の決定。[ADR-0021](../decisions/0021-accounts-members-guests-and-teamspaces.md) の注記）。細部は E10 の Story で本家を観察して揃える。

ワークスペースの操作（「○」は許可、「—」は 403）：

| 操作 | owner | membership_admin | member | guest | bot |
| --- | --- | --- | --- | --- | --- |
| ワークスペースの設定・セキュリティの方針を変える | ○ | — | — | — | — |
| メンバーを招待する・外す | ○ | ○ | 設定で許可されていれば招待だけ | — | — |
| ロールを変える | ○ | member ⇄ guest だけ（未検証） | — | — | — |
| ゲストの追加の申請を承認する（Enterprise） | ○ | — | — | — | — |
| チームスペースを作る | ○ | ○ | 設定で許可されていれば | — | — |
| グループを作る・編集する（Business 以上） | ○ | ○ | — | — | — |
| 内部の連携を作る | ○ | — | — | — | — |
| ワークスペースを削除する | ○ | — | — | — | — |
| 無効化したメンバーのプライベートのページを移す（Enterprise。E10） | ○ | — | — | — | — |

- **所有者も、ページの権限を迂回しない。** 他のメンバーのプライベートのページやゴミ箱のページは、所有者でも読めない。本家とは違う。本家は、所有者がプライベートのページを含むデータにアクセスしうると明記し、Enterprise では離脱から 30 日以内の利用者のプライベートのページを、所有者が別の利用者へ移せる（[Data your workspace owner can access](https://www.notion.com/help/data-accessible-by-your-workspace-owner)、[Transfer content from a deprovisioned user](https://www.notion.com/help/transfer-content-deprovisioned-user)、2026-09-27 に確認）。本システムは、通常の画面では所有者にも読ませない（差異。2026-09-26 の決定）。無効化したメンバーのプライベートのページは、E10（Enterprise）で、所有者が中身を読まずに別のメンバーへ移せるようにする。無効化から 30 日以内に限り、監査ログに残す（[ADR-0033](../decisions/0033-transfer-private-pages-of-deactivated-members.md)。2026-09-28 の決定）。Enterprise の管理者向けの内容の検索は、監査ログに残す別の経路として E10 で扱う。
- 最後の所有者は、降格・無効化できない（409）。

### 2.3 ゲストの上限

| プラン | ゲストの上限 |
| --- | --- |
| Free | 10 |
| Plus・Business・Enterprise | 無制限 |

出典は [Pricing](https://www.notion.com/pricing)（2026-09-26 に確認）。上限を超えたワークスペースでは、ワークスペースのメールドメインに属する人だけを、ゲストではなくメンバーとして追加できる（[Manage members, admins & guests](https://www.notion.com/help/add-members-admins-guests-and-groups)）。Enterprise は、メンバーがゲストの追加を申請し、所有者が承認する運用を選べる（同じ文書）。

- 上限の値はプランの権利（entitlements）として持ち、Slack の ADR-0032 を先例に決める。この文書は「上限を超えたら 409 `guest_limit`」だけを定める。

### 2.4 グループ

- 権限を人の集まりにまとめて付ける。メンバーだけを入れ、ゲストは入れない。
- 本家では Business・Enterprise の機能（[Pricing](https://www.notion.com/pricing) の「Permission groups」）。
- S2 以降で、SCIM の Groups と同期する（6 節）。

### 2.5 連携

連携は `kind = bot` のメンバーとして表し、ログインしない。ACL の主体は `bot:{integration_id}`（[ADR-0024](../decisions/0024-integration-access-model.md)、[api-and-integrations.md](api-and-integrations.md) の 3 節）。9 節に判定の表を置く。

## 3. チームスペースとプライベートの領域

### 3.1 種類

本家の種類（[Intro to teamspaces](https://www.notion.com/help/intro-to-teamspaces)）に合わせる。

| 種類 | 本家の説明 | プラン |
| --- | --- | --- |
| 既定（default） | すべてのメンバーを含む。各ワークスペースに 1 つ以上 | 全プラン |
| 公開（open） | だれでも参加でき、中身を見られる | 全プラン |
| 閉鎖（closed） | 存在は見えるが、所有者かメンバーの招待がないと参加できない | 全プラン |
| 非公開（private） | 追加された人以外には存在も見えない | Business・Enterprise |

- チームスペースのロールは `owner` と `member`。所有者は既定で配下のすべてのページにフルアクセスを持ち、設定（招待できる人、サイドバーを編集できる人）を変えられる（同じ文書）。
- **ゲストはチームスペースに入れない。** ゲストは「ワークスペース全体への権限を持てない」ので、ページ単位で共有する（本家のゲストはページ単位で招待され、ワークスペース全体の権限やグループを持てない。チームスペースのページへもページ単位で共有され、Enterprise ではチームスペースごとにゲストへの共有を禁止できる。[Who's who](https://www.notion.com/help/whos-who-in-a-workspace)、[Intro to teamspaces](https://www.notion.com/help/intro-to-teamspaces)、2026-09-27 に確認。「入れない」と明示した一文はない）。

### 3.2 最上位の暗黙の ACL

チームスペースはブロックではない。チームスペースの直下のページの親はチームスペースで、祖先に ACL を持つページがないとき、チームスペースの設定を暗黙の ACL として使う。

| 最上位 | 暗黙の ACL |
| --- | --- |
| チームスペース（既定・公開） | `team:{id}` → `member_access_level`、`ws:{id}` → `workspace_access_level` |
| チームスペース（閉鎖・非公開） | `team:{id}` → `member_access_level` |
| プライベートの領域（`parent_type = member`、`parent_id` が本人） | 本人の `user:{id}` → `full_access` |

- `member_access_level` と `workspace_access_level` は、チームスペースの所有者が設定する。既定値は `can_edit` と `can_view` にする（本家の既定値は未検証）。
- **チームスペースの所有者は、配下のすべてのページで `full_access` を持つ。** ACL を持つページでも外れない。管理する人がいないページを作らないためである（本家は「既定で」フルアクセスとする。ACL で外せるかは未検証）。
- ページをプライベートの領域へ移すと、ACL を持たない限り、他人の権限はなくなる（本家：「Private」の領域へ移すとアクセスを外せる。[Sharing & permissions](https://www.notion.com/help/sharing-and-permissions)）。

### 3.3 チームスペースの操作

「—」は 403、「404」は存在を見せない。

| # | 種類 | 主体 | 見つける（一覧・名前） | 参加する | 中身を読む | メンバーを招待する | 設定を変える |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | - | ゲスト・bot | 404 | — | ページ単位の共有だけ | — | — |
| 2 | 既定 | メンバー | ○ | 自動で参加 | 暗黙の ACL | 設定に従う | — |
| 3 | 公開 | 非参加のメンバー | ○ | ○ | `workspace_access_level` | — | — |
| 4 | 閉鎖 | 非参加のメンバー | ○（名前と説明だけ） | 招待されたとき | ページ単位の共有だけ | — | — |
| 5 | 非公開 | 非参加のメンバー | 404 | 招待されたとき | ページ単位の共有だけ | — | — |
| 6 | - | チームスペースのメンバー | ○ | - | 暗黙の ACL | 設定（「全員」か「所有者だけ」）に従う | — |
| 7 | - | チームスペースの所有者 | ○ | - | `full_access` | ○ | ○ |
| 8 | 非公開 | ワークスペースの所有者（非参加） | 管理画面でだけ（本家は、所有者が設定の画面ですべてのチームスペースを管理でき、Enterprise では任意のチームスペースに参加し自分を所有者にできる。[Manage teamspaces](https://www.notion.com/help/manage-teamspaces)、2026-09-27 に確認。本システムは参加・所有者の割り当てを通してだけ中身を見る） | — | ページ単位の共有だけ | — | 所有者の割り当てだけ |

## 4. ページの権限

### 4.1 水準

本家の水準（[Sharing & permissions](https://www.notion.com/help/sharing-and-permissions)）に合わせ、全順序を持たせる。

```
none < can_view < can_comment < can_edit_content < can_edit < full_access
```

| 水準 | 本家の説明の要約 | 備考 |
| --- | --- | --- |
| `full_access` | 中身の編集と、だれとでも共有できる | |
| `can_edit` | 編集できるが、共有できない | |
| `can_edit_content` | データベースの行の作成と編集。データベースの構造は変えられない | データベースだけで選べる |
| `can_comment` | コメントだけ | |
| `can_view` | 読むだけ | |
| `can_create` | 行を追加できるが、他人の行は見えない（Business・Enterprise） | 全順序に入らない。データベースの行単位の権限（[databases.md](databases.md)）と一緒に後で扱う |

### 4.2 水準 × 操作

| 操作 | view | comment | edit_content | edit | full |
| --- | --- | --- | --- | --- | --- |
| 中身・コメントを読む、購読する | ○ | ○ | ○ | ○ | ○ |
| コメントする | — | ○ | ○ | ○ | ○ |
| データベースの行を作る・プロパティの値と行のページを編集する | — | — | ○ | ○ | ○ |
| ページの本文を編集する、データベースの構造・ビューを変える | — | — | — | ○ | ○ |
| ページの履歴を見る・バージョンを戻す | — | — | — | ○ | ○ |
| ページを移す（実効の権限が変わらない移動） | — | — | — | ○（移動先の親にも `can_edit`） | ○ |
| ページを移す（実効の権限が変わる移動） | — | — | — | — | ○（移動先の親に `can_edit`） |
| ゴミ箱へ入れる・ゴミ箱から戻す | — | — | — | ○ | ○ |
| 完全に削除する | — | — | — | — | ○ |
| 共有の設定・一般アクセス・公開・連携の追加 | — | — | — | — | ○ |
| エクスポート・複製 | ○（ワークスペースの方針で禁止できる） | ○ | ○ | ○ | ○ |

- 履歴の閲覧と復元に `can_edit` 以上が要るのは本家と同じ（[Duplicate, delete, and restore content](https://www.notion.com/help/duplicate-delete-and-restore-content)）。完全な削除を `full_access` に限るのは [block-model.md](block-model.md) の決定と同じ。
- 「実効の権限が変わる移動」は、移動するページが ACL を持たず、移動の前後で「最も近い ACL を持つ祖先」か最上位が変わる移動である。移動は共有の設定を変えるのと同じ効果を持つので、`full_access` を要る（ADR-0018）。
- ゴミ箱へ入れる操作を `can_edit` に許すことは、本家の振る舞いとしては未検証。

### 4.3 ACL の保存

ACL は、設定をしたページにだけ持つ（ADR-0004、[block-model.md](block-model.md)）。

| テーブル | 中身 |
| --- | --- |
| `page_acls` | `workspace_id`、`page_id`、`version`、作成・更新の人と日時。行があれば、そのページは ACL を持つ（中身が空でもよい） |
| `page_acl_entries` | `workspace_id`、`page_id`、`principal`、`level`、`expires_at`、`granted_by` |
| `page_general_access` | `page_id`、`scope`（`workspace` / `public`）、`level`、`hide_from_search`、`expires_at` |
| `workspace_acl_versions` | `workspace_id`、`acl_version`。権限に影響する変更のたびに増える番号（5 節）。[search.md](search.md) の「ワークスペースの権限のバージョン」と同じもの。権限の変更と同じトランザクションで上げるので、`global` ではなくシャードに置く（[data-model.md](data-model.md)） |

`principal` は、[search.md](search.md) の主体のキーと同じ形にする。

| 主体 | 意味 |
| --- | --- |
| `user:{member_id}` | 1 人のメンバーまたはゲスト |
| `group:{group_id}` | グループ |
| `team:{teamspace_id}` | チームスペースのメンバー（ページの ACL に直接は置かず、暗黙の ACL で使う） |
| `ws:{workspace_id}` | 「{workspace} の全員」。ゲストを含まない（`page_general_access` の `workspace`） |
| `bot:{integration_id}` | 連携 |
| `public` | 「リンクを知っているウェブ上の全員」（`page_general_access` の `public`。8 節） |

ページの共有の画面の操作は、次のように保存する（[ADR-0018](../decisions/0018-permission-levels-and-inheritance.md)）。

| 画面の操作 | 保存 |
| --- | --- |
| ACL を持たないページで、人を追加する・外す・水準を変える | そのページの実効の ACL（継承元の項目）を写して `page_acls` を作り、変更を加える。以後、このページは継承元の変更を受けない |
| ACL を持つページで変える | そのページの `page_acl_entries` を変える |
| 「継承に戻す」 | `page_acls` とその項目を消す |
| 親（ACL を持つページ）で変える | 親の項目を変える。ACL を持たない子孫に届く。ACL を持つ子孫には届かない。画面で、ACL を持つ子孫の数を示し、「同じ変更を子孫にも加える」を選べる。選んだら、同じトランザクションで子孫の項目にも同じ変更を加える（上限 1,000 ページ。超えたら非同期のジョブ） |

- 本家の文書は「子は親の権限を継承する。変えるには子で設定する」までを示す（[Sharing & permissions](https://www.notion.com/help/sharing-and-permissions)）。子で変えた後に親の変更が届くかは未検証で、ここは本システムの決定である（ADR-0018）。
- 画面では、ACL を持つページに「親と異なる」印を付ける。

### 4.4 実効の水準の計算

```
keys(actor):
  人：user:{m} ∪ group:{g ∈ groups(m)} ∪ team:{t ∈ teamspaces(m)} ∪ ws:{w}（role ≠ guest）
  連携：bot:{i}
  ログインしていない閲覧者：public

level(actor, page):
  src = page から祖先へたどり、最初に page_acls を持つページ（なければ最上位）
  lvl = max(src の項目・一般アクセスのうち keys(actor) に当たり、期限内のものの水準)
  if actor が page の属するチームスペースの所有者: lvl = full_access
  return caps(actor, page, lvl)
```

- `src` は、[search.md](search.md) の `acl_source_id` と同じ規則で決まる。
- ブロックは、そのブロックが属するページ（`page_id`）の水準に従う。ブロックをページ間で移すと、次の判定から移動先のページの水準になる。
- データベースの行のページは、行 → `data_source` → `database` ブロック → 親のページ、と祖先をたどって同じ計算をする。行に固有の ACL は、同じ仕組みの `page_acls` である（[databases.md](databases.md) の 2・10 節）。

`caps` で上限を重ねる。上限は権限を広げない。

| 上限 | 内容 |
| --- | --- |
| メンバーの状態 | 無効化済みなら `none` |
| ゴミ箱 | ゴミ箱のページは、`can_edit` 以上の人にだけ見え、読み取り専用（戻す・完全に削除するだけ） |
| 連携 | 能力で絞る。共有の設定を変える操作は連携に出さない（9 節） |
| ワークスペースの方針（Enterprise） | 公開の禁止なら `public` を無視する。ゲストとの共有の禁止なら、ゲストの `user:` の項目を無視する |

### 4.5 判定の決定表

上から評価し、最初に一致した行を採る。

| # | 主体 | メンバーの解決 | ページ | 実効の水準 | 操作に要る水準（4.2） | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | ログインしていない | - | - | - | - | アプリのオリジンでは 401（ログインへ）。公開サイトのオリジンは 8 節 |
| 2 | セッション | メンバーでない | - | - | - | 404 |
| 3 | - | 無効化済み | - | - | - | 403（`member_deactivated`） |
| 4 | - | - | 存在しない、物理削除済み、完全に削除済み | - | - | 404 |
| 5 | - | - | ゴミ箱 | `can_edit` 未満 | - | 404 |
| 6 | - | - | ゴミ箱 | `can_edit` 以上 | 読む・戻す | 許可 |
| 7 | - | - | ゴミ箱 | `full_access` | 完全に削除する | 許可 |
| 8 | - | - | ゴミ箱 | `can_edit` 以上 | それ以外 | 409（`page_in_trash`） |
| 9 | - | - | - | `none` | - | 404 |
| 10 | bot | - | - | `can_view` 以上 | 能力がない | 403（`restricted_resource`） |
| 11 | - | - | - | 要る水準未満 | - | 403（`insufficient_permission`） |
| 12 | - | - | - | 要る水準以上 | - | 許可 |

### 4.6 共有を変える操作の決定表

| # | 操作者の水準 | 操作者のロール | 相手 | ワークスペースの方針 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `full_access` 未満 | - | - | - | 403 |
| 2 | `full_access` | ゲスト | ワークスペースの外のメールアドレス、または連携 | - | 403（ゲストは人や連携を新しく追加できない） |
| 3 | `full_access` | - | ワークスペースの外のメールアドレス | ゲストとの共有を禁止（Enterprise） | 403（`guests_disabled`） |
| 4 | `full_access` | - | ワークスペースの外のメールアドレス | ゲストの追加に申請が要る（Enterprise） | 申請を作る。所有者が承認したら招待する |
| 5 | `full_access` | - | ワークスペースの外、ゲストの上限に達している | - | 相手のメールドメインがワークスペースのドメインならメンバーとして招待、それ以外は 409（`guest_limit`） |
| 6 | `full_access` | - | `public`（リンクの共有・公開） | 公開を禁止（Enterprise） | 403（`publishing_disabled`） |
| 7 | `full_access` | - | その他 | - | 許可。`acl_version` を上げ、監査ログに残す |

- ゲストが新しい人を追加できないのは、本家の「ゲストはメンバーや連携を追加できない」に合わせた（[Who's who](https://www.notion.com/help/whos-who-in-a-workspace)）。フルアクセスのゲストが、既にいるメンバーやゲストへ共有できるかは未検証で、本システムでは許す。

### 4.7 漏洩させない経路

判定関数を通らない経路で、読めないページの中身（タイトルを含む）を出さない（intent.md の「守るべき振る舞い」、NFR-010）。

| 経路 | 規則 |
| --- | --- |
| パンくず・サイドバー | 読めない祖先は、タイトルを出さずに省く |
| ページのメンション・リンク・バックリンク | 読めないページは「アクセスできないページ」とだけ表示する。バックリンクの一覧からは省く |
| 同期ブロック | 元のページが読めなければ、中身を出さず、アクセスできない印を出す |
| リレーション・ロールアップ | 読める行だけで返し、計算する（[ADR-0017](../decisions/0017-rollups-over-readable-rows-only.md)） |
| 検索 | 権限キーと読み直しの二重（[ADR-0023](../decisions/0023-search-engine-and-permission-filtering.md)） |
| 通知・メール | 送る時点で受け手を判定し直す（[comments-and-notifications.md](comments-and-notifications.md)） |
| API・Webhook | 連携の判定（ADR-0024）。Webhook は中身を含めず、配送の時点で判定する（[ADR-0025](../decisions/0025-webhook-delivery.md)） |
| 在席 | 購読と同じ判定を通した接続にだけ配る |
| 公開サイト | `public` で読めないブロック（メンション先・同期ブロック・リンクしたデータベース）を描画しない。コメントは描画しない（8 節） |
| エクスポート | ページごとに判定する |
| クライアントのローカルの保存 | 権限を失ったページを消す（5.4 節） |

## 5. 実効権限のキャッシュと無効化

### 5.1 方式

[ADR-0019](../decisions/0019-workspace-acl-version-cache.md) による。

- ワークスペースに `acl_version`（単調に増える整数）を持つ。権限に影響する変更は、同じトランザクションで `acl_version` を 1 上げる。
- 要求の始めに、メンバーの解決と同じ読み取りで `acl_version` を得る。キャッシュのキーは、すべて `acl_version` を含む。
  - 主体のキー：`(member_id, acl_version) → keys`
  - ページの `src` と項目：`(page_id, acl_version) → (src, [(principal, level)])`
  - 判定の結果：`(member_id, page_id, acl_version) → level`
- キャッシュは API のプロセスの中（LRU）に置く（S1）。ミスのときは、再帰の CTE で祖先の鎖（[block-model.md](block-model.md) と共有する）と `page_acls` を 1 回で読む。
- 要求は、読んだ `acl_version` の時点で線形化される。変更の確定の後に始まった要求が、古い権限で判定されることはない。

### 5.2 `acl_version` を上げる変更

| 変更 | 上げる |
| --- | --- |
| `page_acls`・`page_acl_entries`・`page_general_access` の変更 | ○ |
| ページの親の変更（ページの移動）、ゴミ箱へ入れる・戻す、完全に削除する | ○ |
| グループのメンバーの変更、グループの削除 | ○ |
| チームスペースの参加・退出・ロール・種類・既定の水準の変更 | ○ |
| メンバーのロールの変更・無効化 | ○ |
| 連携の能力の変更、トークンの取り消し | ○ |
| ワークスペースの方針（公開・ゲスト・エクスポートの禁止） | ○ |
| ブロックの作成・編集・ページ内外の移動、ページのタイトル・本文の変更 | —（ブロックの `page_id` は判定のたびに行から読む） |

- `acl_version` の行は、権限の変更をワークスペースの中で直列にする。S1 の見込み（大きなワークスペースで毎分数十件）では問題にならない。S2 で競合が問題になれば、分け方を新しい ADR で決める（ADR-0019）。

### 5.3 移動と共有の反映

```
権限の変更（1 つのトランザクション）
  ├─ page_acls / 親の変更 / メンバー・グループ・チームスペースの変更
  ├─ acl_version += 1
  ├─ 監査ログ（security.md の 6 節）
  └─ outbox: acl.changed { workspace_id, acl_version, root_page_id }
        ├─▶ Sync Gateway：祖先の鎖に root_page_id を含む購読を判定し直し、読めなくなった接続に page.revoked を送る（collaboration.md の 7.2 節）
        ├─▶ 検索：search-acl のキューで access_keys を更新する（search.md の 5.3 節）
        └─▶ 通知・Webhook：送る直前に判定し直すので、ここでは何もしない
```

- メンバー・グループ・チームスペースの変更のように、特定のページに結び付かない変更は、`root_page_id` を持たない `acl.changed` として流し、Gateway はそのワークスペースの全購読を判定し直す。
- Gateway は DB に触れない。取りこぼしに備え、Gateway が送る直前にも確かめる経路と、定期の再検証を持つ（[collaboration.md](collaboration.md)）。

### 5.4 クライアントのローカルの保存

- `page.revoked` を受けたクライアントは、そのページと子孫のブロックを、ローカルの保存（[ADR-0013](../decisions/0013-offline-availability-policy.md)）から消す。
- 再接続時の照合（[collaboration.md](collaboration.md) の 11 節）で、読めなくなったページはサーバーが「revoked」として返し、クライアントは消す。
- オフラインの間に、権限を失ったページへ行った編集は、サーバーが拒否する（403）。クライアントは、本人が入力した未送信の変更だけを「送れなかった変更」として本人に示す。
- オフラインのまま戻らない端末に残ったデータは消せない。引き受ける危険として [security.md](security.md) に書く。

## 6. SSO と SCIM（MVP の後）

intent.md の Non-goals（Enterprise の管理）に従い、MVP では作らない。目標の形だけを書く。

| 機能 | 本家 | 本システム |
| --- | --- | --- |
| SAML SSO | Business・Enterprise。確認済みのドメインが 1 つ以上必要。ログインの方法は「どれでも」か「SAML だけ」。JIT で自動的にメンバーにできる。Business は 1 つ、Enterprise は最大 25 の設定（[SAML SSO configuration](https://www.notion.com/help/saml-sso-configuration)） | Slack の identity-and-access.md の 5 節（DNS TXT での確認、強制、同じメールの紐付けの表）を先例にする |
| SCIM | Enterprise。ユーザーとグループの作成・管理（[Pricing](https://www.notion.com/pricing)） | `active=false` と `DELETE` はメンバーの無効化にし、アカウントは消さない。Groups は 2.4 のグループに対応させる。自前で実装する（Slack の identity-and-access.md の 5.4 節と同じ理由） |
| 監査ログの閲覧 | Enterprise。365 日保持、CSV の出力、SIEM への Webhook（[Audit log](https://www.notion.com/help/audit-log)） | 記録は MVP から行う（[security.md](security.md) の 6 節）。閲覧の画面と出力は後の Epic |
| メンバーの管理者 | Enterprise | 後の Epic |

## 7. 一般アクセスと共有のリンク

本家の「一般アクセス」は 3 つ（[Sharing & permissions](https://www.notion.com/help/sharing-and-permissions)）。

| 本家の選択肢 | 本システムの保存 |
| --- | --- |
| 招待した人だけ | `page_general_access` の行がない |
| {workspace} の全員 | `scope = workspace`。水準を選べる。検索に出さない選択（`hide_from_search`）を持つ |
| リンクを知っているウェブ上の全員（期限を付けられる） | `scope = public`、`expires_at` |

- `page_general_access` も ACL の一部で、ACL を持たない子孫に継承する。
- ページの URL はページの ID（UUIDv7）を含む。リンクの共有は URL を知っていることを前提にするので、UUIDv7 のランダムな部分（74 ビット）と、公開の配信のレート制限で推測を防ぐ。
- **ログインしていない閲覧者には、アプリのオリジンで内容を見せない。** `public` のページへのログインしていない要求は、公開サイトのオリジン（8 節）へ送る。アプリのオリジンで、誰でも作れる内容を匿名に見せない（フィッシングの対策。本家と体験が違いうる。未検証）。
- `public` の水準は、S1 では `can_view` だけにする（決定。[README.md](README.md) の「決定」）。本家は、リンクの閲覧者に編集・コメント・閲覧のいずれかを許せる。コメントと編集にはログインが要る（[Share your Notion pages](https://www.notion.com/help/share-your-work)、2026-09-27 に確認）。S1 で `can_view` だけにするのは本家との差異である。
- 本家は、有料のプランでリンクに期限（Link expires）を付けられる（[リリースノート 2022-10-12](https://www.notion.com/releases/2022-10-12)、2026-09-27 に確認）。

## 8. Web への公開（公開サイト）

[ADR-0020](../decisions/0020-published-pages-isolation.md) による。本家は `notion.site` のドメインで配り、子のページも既定で公開し、「Discoverable on the web」を有効にすると検索エンジンに載る。Enterprise は公開を禁止でき、禁止すると公開中のサイトも取り下げる（[Publish a website with Notion Sites](https://www.notion.com/help/public-pages-and-web-publishing)）。

| 項目 | 本システム |
| --- | --- |
| ドメイン | アプリと別の登録可能ドメイン `<brand>.site`（仮。repo の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。ワークスペースごとのサブドメイン `{slug}.<brand>.site`。Public Suffix List に登録し、サブドメイン同士も別のサイトにする |
| 保存 | `published_sites`（`page_id`、`slug`、`search_indexing`、`allow_duplicate`、公開・取り下げの日時）と、`page_general_access` の `public` |
| 範囲 | 公開したページと、ACL を持たない子孫（`public` を継承する）。ACL を持つ子孫は、その ACL に `public` がなければ公開されない |
| 検索エンジン | 既定は載せない。`X-Robots-Tag: noindex` と `<meta name="robots" content="noindex">` を返す。有効にしたときだけ外す |
| 描画 | 専用の描画サービスが、`public` の主体で判定関数を通し、サーバーで HTML を作る。アプリのスクリプトを読み込まない |
| 範囲外の中身 | メンション・同期ブロック・リンクしたデータベース・埋め込みのうち、`public` で読めないものは描画しない。コメントは描画しない |
| 取り下げ | `public` を消し、CDN のキャッシュを無効にする。反映は 1 分以内 |
| 複製（テンプレートとして） | `allow_duplicate` のときだけ。ログインした人が自分のワークスペースへ複製する。ワークスペースをまたぐので非同期のジョブで行う（ADR-0003） |

公開の可否：

| # | ワークスペースの方針 | 操作者の水準 | ページ・ワークスペースの状態 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 公開を禁止 | - | - | 403（`publishing_disabled`） |
| 2 | - | `full_access` 未満 | - | 403 |
| 3 | - | `full_access` | ゴミ箱 | 409（`page_in_trash`） |
| 4 | - | `full_access` | 濫用で公開を止められている | 403（`publishing_suspended`） |
| 5 | - | `full_access` | - | 公開する。監査ログに残す |

公開サイトのオリジンでの閲覧：

| # | ページ | `public` の水準 | 期限 | 結果 |
| --- | --- | --- | --- | --- |
| 1 | 存在しない・ゴミ箱・完全に削除済み | - | - | 404 |
| 2 | - | なし | - | 404 |
| 3 | - | `can_view` | 切れている | 404 |
| 4 | - | `can_view` | - | 描画する（`search_indexing` でなければ noindex） |

## 9. 連携の主体

連携の種類・トークン・能力は [api-and-integrations.md](api-and-integrations.md) の 3 節と [ADR-0024](../decisions/0024-integration-access-model.md) にある。この文書は判定の側だけを書く。

- 連携は `bot:{integration_id}` の主体で、4.4 節と同じ計算をする。明示的に共有されたページと、ACL を持たない子孫だけを読める。ワークスペースのメンバーの権限（`ws:`・`team:`）は持たない。
- 連携の水準は、共有の水準と能力の小さい方（ADR-0024）。共有の設定・一般アクセス・公開を変える操作は、連携に出さない（`full_access` で共有されても、共有は変えられない）。
- 連携を追加できるのは、ページで `full_access` を持つメンバー（ゲストを除く）。

| # | トークン | ページに `bot:` が届く | 能力を持つ | 共有の水準が操作に足りる | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | 不正・取り消し済み・期限切れ | - | - | - | 401 |
| 2 | 有効 | いいえ | - | - | 404 |
| 3 | 有効 | はい | いいえ | - | 403（`restricted_resource`） |
| 4 | 有効 | はい | はい | いいえ | 403 |
| 5 | 有効 | はい | はい | はい | 許可 |

- 人の権限を借りるエージェントは、MCP（[ADR-0026](../decisions/0026-remote-mcp-server.md)）で扱い、この表ではなく人の判定を通る。

## 10. データモデルへの追加

[data-model.md](data-model.md) に載せる。すべて `workspace_id` を持ち、RLS を有効にする（ADR-0003）。

| テーブル | 中身 |
| --- | --- |
| `members` | `account_id`、`kind`（`human` / `bot`）、`role`（`owner` / `membership_admin` / `member` / `guest`）、無効化日時 |
| `groups`、`group_members` | グループとメンバー |
| `teamspaces` | `type`（`default` / `open` / `closed` / `private`）、`member_access_level`、`workspace_access_level`、招待・サイドバーの設定、アーカイブ日時 |
| `teamspace_members` | `teamspace_id`、`member_id`、`role`（`owner` / `member`） |
| `page_acls`、`page_acl_entries`、`page_general_access` | 4.3 節 |
| `workspace_acl_versions` | 5 節 |
| `workspace_security_policies` | 公開・ゲスト・エクスポート・連携の禁止、ゲストの追加の申請（Enterprise） |
| `guest_requests` | ゲストの追加の申請（Enterprise） |
| `published_sites` | 8 節 |
| `favorites`、`invitations`、`workspace_settings` | お気に入り、招待、ワークスペースの設定（2026-09-28 に足した） |

列・制約・索引の正は [data-model/permissions.md](data-model/permissions.md)。

## 11. 決定と持ち越し

2026-09-26 に、本家に寄せる既定案で次のとおり決めた（[README.md](README.md) の「決定」）。

| 問い | 決定 |
| --- | --- |
| ACL を持つ子孫に、親の変更が届かないことを、画面でどう示すか | ACL を持つページに「親と異なる」印を付け、親の共有の画面に ACL を持つ子孫の数を出す。「同じ変更を子孫にも加える」の既定は、アクセスを外す・下げる変更ではオン、足す・上げる変更ではオフにする（意図しない公開を避ける側に倒す）。本家の振る舞いは未検証 |
| チームスペースの所有者の `full_access` を ACL で外せるか | 外せない（3.2 節、ADR-0018） |
| 管理者はゴミ箱の全ページを扱えるか | 扱えない。所有者・管理者もページの権限を迂回しない。ゴミ箱に出るのは `can_edit` 以上のページだけ。読めないページを含むワークスペース単位の削除・復元は、運用者の経路（所有者の依頼と監査ログ）で行う（[block-model.md](block-model.md) の 9 節） |
| ログインしていない閲覧者を公開サイトのオリジンへ送るか | 送る（7 節、ADR-0020） |
| `public` の水準 | S1 は `can_view` だけ |
| 閲覧だけの人にコメントを見せるか | 見せる（4.2 節。本家と同じ）。公開サイトではコメントを描画しない（8 節） |

2026-09-28 に、推奨案で次のとおり決めた（[README.md](README.md) の「決定（2026-09-28、推奨案で確定）」）。

| 問い | 決定 |
| --- | --- |
| 無効化したメンバーのプライベートのページを移せるか | E10（Enterprise）で移せるようにする。所有者は中身を読まない。無効化から 30 日以内。監査ログに残す（2.2 節、[ADR-0033](../decisions/0033-transfer-private-pages-of-deactivated-members.md)） |
| 「制限付きメンバー」のロール | MVP の後、E10 で `restricted_member` を足す（2.2 節） |
| リンクの閲覧者に編集・コメントを許すか | S1 では許さない。本家との差異として記録する（7 節） |

持ち越し：

- `acl_version` をワークスペースに 1 つにする方式の、S2 での競合の程度（Dev、E9 の前の負荷試験。[capacity.md](capacity.md)）。

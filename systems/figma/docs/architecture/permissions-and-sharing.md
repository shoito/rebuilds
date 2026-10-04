# Permissions and sharing: Figma

組織・チーム・プロジェクト・ファイルの階層、役割とシート、招待、ゲスト、共有のリンク、判定関数とキャッシュ、長く続く接続での取り消しの設計。MVP の後に作る、プロトタイプだけの閲覧と埋め込みの目標の形も書く。

テナントの分離（`org_id` と FORCE RLS）と「ファイルを持つ組織の文脈で読む」規則は [ADR-0005](../decisions/0005-tenancy-and-document-routing.md) に従う。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0029](../decisions/0029-hierarchy-roles-seats-and-link-access.md) | 階層は組織・チーム・プロジェクト・ファイル。水準は全順序で、上位で与えた水準を下位で下げない。一般アクセスはファイルで「招待した人だけ」にすると上位から届かない。シートは水準の上限として重ねる |
| [0030](../decisions/0030-single-policy-engine-and-signed-capabilities.md) | 判定関数は API の TypeScript に 1 つだけ置き、ポリシーは JSON で表せる allow / deny の規則（deny が勝つ）で書く。Gateway は API が発行する署名付きの能力のチケットで判断する |
| [0031](../decisions/0031-org-acl-version-and-connection-revalidation.md) | 実効権限は組織の `acl_version` をキーにキャッシュする。長く続く接続は、`acl.changed` と 5 分ごとの再検証で判定し直し、下げる・切る |

本家の振る舞いは、2026-09-27 に Figma のヘルプセンターと Figma のブログで確かめた。確かめられなかったものは「未検証」と書く。この文書の決定表は設計の草案である。ID（`DT-...`）は、E9 の各変更の `spec.md` に移すときに振る。

## 1. 目的と範囲

| 範囲 | MVP | MVP の後 |
| --- | --- | --- |
| 組織・チーム・プロジェクト・ファイル・下書き | ○ | ワークスペース（本家の Enterprise） |
| 役割（所有者・編集・閲覧）と継承 | ○ | ユーザーグループ |
| シート（Full・View）と、シートの申請・承認 | ○ | Dev・Collab のシート（Dev Mode・ホワイトボードと一緒に） |
| 招待（メール）、ゲスト、アクセスの申請 | ○ | ゲストの禁止・制限の方針（本家の Enterprise） |
| 一般アクセス（招待した人だけ・組織の中・リンクを知っている全員）と水準 | ○ | |
| リンクの期限、閲覧者の複製・共有・書き出しの制限 | ○ | リンクのパスワード |
| プロトタイプだけの閲覧、埋め込み | | ○（プロトタイピングと一緒に） |
| SAML SSO、SCIM | | ○（security.md で扱う） |

守ること（[intent.md](../intent.md) の「守るべき振る舞い」、NFR-010）：

- 組織は、他の組織のファイル・コメント・メタデータを見られない。
- 権限のない人に、ファイルの中身（名前、サムネイル、コメント、画像を含む）を返さない。
- 権限を外したら、開いている接続でも、それ以後の読み書きを止める。

## 2. 本家の振る舞い

| 項目 | 本家の振る舞い | 出典 |
| --- | --- | --- |
| 階層 | 組織 → ワークスペース → チーム → フォルダー → ファイル。Starter と Professional は 1 つのチーム。2026-08-03 から「プロジェクト」を「フォルダー」に改名中（中身と権限は変わらない） | [Guide to sharing and permissions](https://help.figma.com/hc/en-us/articles/1500007609322-Guide-to-sharing-and-permissions) |
| 水準 | 所有者（作った人。すべての権限）、編集（ファイルの編集、フォルダーの中にファイルを作る）、閲覧（見る、コメントする） | [File and folder permissions](https://help.figma.com/hc/en-us/articles/35361119554711-File-and-folder-permissions) |
| 継承 | フォルダーの役割はファイルに届く。チームの役割は最上位のフォルダーに届く（組織のプラン）。個人の役割は上位より上げられるが、下げられない。フォルダーの一般アクセスが「編集」でも、ファイルが「招待した人だけ」なら、一般アクセスで来た人は開けない | 同上 |
| 権限の変更 | 所有者と編集の権限を持つ人。管理者は、自分が持つ権限の範囲で変えられる | 同上 |
| シート | Full（全製品）、Dev（Dev Mode・ホワイトボード・スライド。デザインは閲覧とコメント）、Collab（ホワイトボード・スライド。デザインは閲覧とコメント）、View（無料。閲覧とコメント）。シートは使える製品を決め、ファイルの権限は開けるファイルを決める。編集には「編集の権限」と「その製品を含むシート」の両方が要る | [Manage seats in Figma](https://help.figma.com/hc/en-us/articles/360039960434-Manage-seats-in-Figma)、上の File and folder permissions |
| シートの承認 | 手動、空きがあれば自動、自動の 3 つから管理者が選ぶ | 同上の Manage seats |
| 一般アクセス | 招待した人だけ、組織の中、ワークスペースの中（Enterprise）、リンクを知っている全員。閲覧・編集、プロトタイプだけの共有。有料のプランで「閲覧者に複製・共有・書き出しを許す」を切れる。招待した人にはメールとファイルブラウザの通知が届く | [Share files and prototypes](https://help.figma.com/hc/en-us/articles/360040531773-Share-files-and-prototypes) |
| リンクの期限 | Enterprise。1 時間〜1 年。期限が来ると、最後に使っていた非公開の設定に自動で戻る。管理者は期限を必須にでき、その場合は 1 時間〜31 日 | [Set an expiration on public links in design files](https://help.figma.com/hc/en-us/articles/16142157359255-Set-an-expiration-on-public-links-in-design-files) |
| パスワード | リンクにパスワードを付けられる。本家が作るパスワードは 4 つの単語の組 | [Add password protection to files and prototypes](https://help.figma.com/hc/en-us/articles/5726720100247-Add-password-protection-to-files-and-prototypes)（検索の結果の要約で確認。本文は未読） |
| ゲスト | 組織のドメインに合わないメールアドレスの人。招待された資源だけを使え、組織のチーム・共有のフォント・組織のライブラリを見られない。SAML SSO でログインできない。任意のシートを持てる。ゲストをメンバーに変えられない。Starter と Professional では、ファイル・フォルダーだけに招待された人を「限られたアクセス」のメンバーと呼ぶ | [Members, guests, and limited access](https://help.figma.com/hc/en-us/articles/4420557314967-Members-versus-guests) |
| 判定の実装 | 以前の Ruby の `has_access?` は長く複雑で、同じ規則を LiveGraph（リアルタイムの API）にも別に書いていて食い違った。権限の判定が DB の読み取りの約 20% を占めた。AWS IAM に倣い、allow / deny（deny が勝つ）・資源の種類・権限・条件を持つ JSON のポリシーの DSL を作った。TypeScript で書いて JSON にし、Ruby・TypeScript・Go の評価器で同じに動かす。条件が参照するデータから読み込みを自動で決め、段階に分けて読み、結論が出たら残りを読まない（実行時間が半分以下）。null どうしの比較を lint で禁じる。社員向けにどの規則が真・偽になったかを示すデバッガーを作った。OPA、Zanzibar、Oso も検討した | [How we rolled out our own permissions DSL at Figma](https://www.figma.com/blog/how-we-rolled-out-our-own-permissions-dsl-at-figma/)、2024-03-13 |

- 本システムは、UI と文書で「プロジェクト」と呼ぶ（[architecture/README.md](README.md) と揃える）。S1 はこの呼び名のままにし、利用者の調査で混乱が見えたら見直す（15 節）。

## 3. 階層と主体

### 3.1 階層

```
組織（org。テナント。ADR-0005）
 ├─ メンバー（member）・ゲスト（guest）・シート
 ├─ チーム（team）…… 可視性：open / closed / secret
 │    └─ プロジェクト（project）
 │         └─ ファイル（file）
 └─ 下書き（drafts）…… 所有者ごと。project_id を持たないファイル
```

- Starter・Professional のプランでも、暗黙の組織を 1 つ作り、チームを 1 つ置く（ADR-0005）。ファイル・プロジェクトだけに招待された人は、組織の `guest` の行にする。画面では、本家に合わせ、プランによって「ゲスト」「限られたアクセス」と呼び分ける。
- ファイルは、ちょうど 1 つの組織に属する。組織をまたいでファイルを移すことは MVP で扱わない（複製だけ）。

### 3.2 主体

| 主体 | 意味 | 保存 |
| --- | --- | --- |
| アカウント | 人。組織の外にある（グローバル） | `accounts` |
| 組織のメンバー | 組織のドメインに合うメールアドレスの人。`admin` か `member` | `org_members`（`role`、`seat`、無効化日時） |
| 組織のゲスト | 招待された資源だけを使える人 | `org_members`（`role = guest`） |
| 匿名の閲覧者 | ログインしていない。「リンクを知っている全員」で開いた人 | 行なし |

- 組織への参加：確認済みのドメイン（DNS の TXT で確かめる。security.md）に合うメールアドレスの人は、招待か、open のチームへの参加で `member` になる。合わない人は `guest` になる。本家と同じく、ゲストをメンバーに変える操作は持たない。
- 1 人のアカウントが複数の組織に属せる。画面は組織ごとに切り替える。

### 3.3 チームの可視性

| 可視性 | 組織のメンバー（非参加） | ゲスト（非参加） |
| --- | --- | --- |
| open | 一覧に出る。参加できる。参加して見えるのはチームだけ（中身には届かない） | 見えない |
| closed | 一覧に出る。参加を申請する | 見えない |
| secret | 見えない（招待だけ） | 見えない |

- 本家は、チームの「audience access」（招待した人だけ・ワークスペース・組織。閲覧か編集）と、「招待した人だけ」のときの見え方（Visible・Hidden）で扱い、「audience access はチームの中身に引き継がれない」と書く（[Manage team access and visibility](https://help.figma.com/hc/en-us/articles/360039970673-Manage-team-access-and-visibility)、2026-09-27 に確認）。フォルダー（プロジェクト）を作ったときの既定の一般アクセスは資料にない（**未検証**）。
- 本システムも本家に合わせる（2026-09-27 に決定。15 節）。
  - チームの可視性と参加は、チームを見せるだけに効く。チームの中のプロジェクト・ファイルには引き継がない。
  - open のチームに参加すると、`team_members` の行だけができる。`resource_roles` の行は作らない。中身を開くには、チーム・プロジェクト・ファイルの役割か、プロジェクト・ファイルの一般アクセスが要る。
  - チームの役割（招待で付ける `resource_roles` の `team` の行）は、今までどおり中身に届く（本家の「チームの役割は最上位のフォルダーに届く」。2 節）。
  - 一般アクセスは、プロジェクトとファイルにだけ置く。チームには置かない。新しいプロジェクト・ファイルは行を持たず、「招待した人だけ」と同じになる。
  - > 2026-09-27 の注記：open のチームの一般アクセスを「組織の中・閲覧」にして下位へ引き継ぐ既定を、本家に合わせて取りやめた。

## 4. 水準と役割

### 4.1 水準

全順序を持たせる。

```
none < view_prototype < view < edit < owner
```

| 水準 | 意味 |
| --- | --- |
| `owner` | 所有者。ファイルの削除・所有者の移譲・別のプロジェクトへの移動・すべての共有の変更。ファイルごとに 1 人（作った人。移譲できる）。チーム・プロジェクトの `admin` の役割もこの水準に写す |
| `edit` | 中身の編集、コメント、バージョンの復元、共有の変更（自分の水準まで） |
| `view` | 見る、コメントする、他の人を追う。許されていれば複製・共有・書き出し |
| `view_prototype` | プロトタイプだけを見る（MVP の後） |

### 4.2 水準 × 操作

| 操作 | view_prototype | view | edit | owner |
| --- | --- | --- | --- | --- |
| プロトタイプを見る（MVP の後） | ○ | ○ | ○ | ○ |
| ファイルを開く（読み取りの接続）、他の人の在席を見る | — | ○ | ○ | ○ |
| コメントを読む・書く・返信・解決（[comments-and-notifications.md](comments-and-notifications.md)） | — | ○（ログインが要る） | ○ | ○ |
| バージョンの一覧を見る | — | ○（本家と同じ。[View a file's version history](https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history)、2026-09-27 に確認） | ○ | ○ |
| 書き出し・複製・他の人を閲覧で招待 | — | 「閲覧者に許す」がオンのときだけ | ○ | ○ |
| 中身を編集する（書き込みの接続） | — | — | ○（Full のシートも要る。4.4 節） | ○（同左） |
| バージョンを復元する・名前を付ける | — | — | ○ | ○ |
| ライブラリの更新を受け入れる（MVP の後） | — | — | ○ | ○ |
| 共有を変える（招待・役割・一般アクセス） | — | — | ○（自分の水準まで。6.2 節） | ○ |
| 「閲覧者に許す」の設定、リンクの期限 | — | — | ○ | ○ |
| ゴミ箱へ入れる・戻す、別のプロジェクトへ移す | — | — | — | ○（移動は移動先で `edit` 以上も要る。ゴミ箱は file-storage-and-history.md の 11 節と同じ） |
| 完全に削除する、所有者を移譲する | — | — | — | ○ |

### 4.3 実効の水準の計算

```
level(actor, file):
  org = file.org_id                                  // ファイルを持つ組織の文脈（ADR-0005）
  m   = org_members[org, actor]                      // member / admin / guest / なし
  if m.deactivated: return none

  // 1. 役割（上げるだけ。下位で下げない）
  r = max(role(actor, file), role(actor, file.project), role(actor, file.team))
  if actor == file.owner_account_id: r = owner      // 所有者は files の列だけで表す（下書きに限らない）

  // 2. 一般アクセス（最も近い設定を持つ資源から 1 つだけ）
  ga = file.general_access ?? project.general_access   // チームの一般アクセスはない（3.3 節）
  g  = none
  if ga.scope == anyone and ga 期限内 and org の方針が公開を許す: g = ga.level
  if ga.scope == org and m.role in (member, admin):  g = ga.level
  // ファイルが「招待した人だけ」（scope = invited_only）の行を持てば、上位の一般アクセスは届かない

  lvl = max(r, g)
  return caps(actor, m, file, lvl)
```

| 上限（`caps`） | 内容 |
| --- | --- |
| シート | `edit` 以上でも、組織のシートが Full でなければ、編集の操作は `view` として扱う（4.4 節）。`owner` の他の操作（共有・移動・削除）は、シートに関わらず許す |
| 匿名 | ログインしていなければ、`view` を上限にする。コメントは書けない |
| ゴミ箱 | ゴミ箱のファイルは開けない（接続もしない）。`owner` にだけゴミ箱の一覧に出し、戻す・完全に削除するだけを許す（[file-storage-and-history.md](file-storage-and-history.md) の 11 節） |
| 組織の方針 | 公開を禁止していれば `anyone` を無視する（上の計算の中）。ゲストとの共有の禁止（MVP の後）なら、ゲストの役割を無視する |
| チームの可視性 | 可視性と参加（`team_members`）は、実効の水準に入れない。チームを見せるだけに使う（3.3 節） |

- 役割の保存：`resource_roles (org_id, resource_type, resource_id, account_id, level)`。`resource_type` は `team` / `project` / `file`。ファイルの `owner` は `files.owner_account_id` だけで表し、`resource_roles` のファイルの行には置かない（[data-model.md](data-model.md) の 9.1 節の D-12）。
- 一般アクセスの保存：`general_access (org_id, resource_type, resource_id, scope, level, expires_at, previous_scope, previous_level, viewers_can_copy_share_export)`。`resource_type` は `project` / `file` だけ。ファイルの行がなければ、プロジェクトの行から届く。

### 4.4 シート

| シート | MVP | デザインのファイルでできること |
| --- | --- | --- |
| Full | ○ | 編集、ライブラリの公開（MVP の後） |
| View | ○（無料） | 閲覧、コメント |
| Dev、Collab | MVP の後 | 本家では、デザインは閲覧とコメント。Dev Mode・ホワイトボードと一緒に扱う |

シートの決定表（編集の接続を求めたとき）：

| # | 実効の水準 | シート | 組織の承認の設定 | 空きの Full | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `view` 以下 | - | - | - | 読み取りの接続。「編集を申請」はファイルの所有者へのアクセスの申請（6.4 節） |
| 2 | `edit` 以上 | Full | - | - | 書き込みの接続 |
| 3 | `edit` 以上 | View | 自動 | - | Full を割り当て、監査ログに残し、書き込みの接続 |
| 4 | `edit` 以上 | View | 空きがあれば自動 | あり | 同上 |
| 5 | `edit` 以上 | View | 空きがあれば自動 | なし | 読み取りの接続。管理者へのシートの申請を作る |
| 6 | `edit` 以上 | View | 手動 | - | 同上 |

- シートは組織ごと。ゲストも、ファイルを持つ組織のシートを使う（本家と同じ）。
- シートの変更は課金に関わる。請求の計算は、課金の領域（これから決める）で扱う。

## 5. 判定関数

[ADR-0030](../decisions/0030-single-policy-engine-and-signed-capabilities.md) による。

### 5.1 形

```
can(actor, action, resource) → Allow | Deny(reason, matched_rules)
capabilities(actor, file)    → { level, actions: Set<Action>, acl_version }
```

- 判定関数は、API の TypeScript のパッケージ `authz` に 1 つだけ置く。API・Realtime・Worker は同じパッケージを呼ぶ。
- Rust の Gateway と Document Server は、判定関数を持たない。API が発行する **能力のチケット**（5.4 節）だけを信じる。これで、本家が悩んだ「同じ規則を 2 つの言語に書いて食い違う」を避ける。

### 5.2 ポリシー

本家の DSL に倣い、ポリシーを JSON で表せるデータとして書く。

```ts
// policies/file.ts（TypeScript で書き、JSON に直列化してテストと監査に使う）
{ id: "file.deny.deactivated", effect: "deny",  resource: "file", actions: ["*"],
  when: { eq: ["actor.membership.deactivated", true] } }
{ id: "file.allow.edit",       effect: "allow", resource: "file", actions: ["file.edit"],
  when: { and: [ { gte: ["effective.level", "edit"] }, { eq: ["actor.seat", "full"] } ] } }
```

| 規則 | 内容 |
| --- | --- |
| 評価 | deny が 1 つでも真なら Deny。そうでなく allow が 1 つでも真なら Allow。どれも真でなければ Deny（既定で拒否） |
| 参照できるデータ | `actor.*`（アカウント、組織の行、シート）、`file.*`・`project.*`・`team.*`・`org.*`（行と方針）、`effective.level`（4.3 節の計算の結果） |
| 読み込み | 条件が参照するフィールドから、読み込みを自動で決める。**段階 1**：ファイルの行、組織の方針、主体の組織の行、一般アクセス。**段階 2**：役割（`resource_roles`）。段階 1 で Allow が決まれば、段階 2 を読まない（本家の短絡に倣う） |
| lint | deny の規則は段階 1 のフィールドだけを参照する（段階 2 を読まずに Allow を返しても、後から deny が真になることがない）。null になりうるフィールドの等価の比較には、null の確認を必須にする（本家の lint と同じ） |
| 説明 | Deny のとき、真・偽になった規則の ID を返す。ログには規則の ID と資源の ID だけを書き、名前は書かない。サポート向けの画面（MVP の後）で、規則の木を表示する |

### 5.3 判定の決定表（ファイル）

上から評価し、最初に一致した行を採る。

| # | 主体 | 組織の行 | ファイル | 実効の水準 | 操作に要る水準（4.2 節） | 結果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 匿名 | - | 一般アクセスが `anyone` で期限内 | `view` | `view` 以下で、ログインの要らない操作 | 許可 |
| 2 | 匿名 | - | - | - | - | ログインへ（API は 401） |
| 3 | ログイン | 無効化済み | - | - | - | 403（`member_deactivated`） |
| 4 | - | - | 存在しない・完全に削除済み | - | - | 404 |
| 5 | - | - | ゴミ箱 | `owner` 未満 | - | 404 |
| 6 | - | - | ゴミ箱 | `owner` | 戻す・完全に削除する・ゴミ箱の一覧に出す | 許可 |
| 7 | - | - | ゴミ箱 | `owner` | それ以外（開くを含む） | 409（`file_in_trash`） |
| 8 | - | - | - | `none` | - | 画面は「アクセスを申請」（ファイルの名前・サムネイルを出さない）。API は 404 |
| 9 | - | - | - | 要る水準未満 | - | 403（`insufficient_permission`） |
| 10 | - | - | - | `edit` 以上 | 編集 | 4.4 節のシートの表へ |
| 11 | - | - | - | 要る水準以上 | - | 許可 |

- 8 行目で「アクセスを申請」の画面を出すと、そのファイルの鍵が存在することは分かる。鍵は 128 ビットの乱数（8 節）なので、推測では見つけられない。名前・サムネイル・所有者は出さない。

### 5.4 能力のチケット

```
FileCapabilityTicket（Ed25519 で署名。有効 60 秒。1 回だけ使える）
  { jti, account_id | anonymous_session_id, org_id, file_id,
    level, actions: [read, comment, edit, ...], acl_version, issued_at, expires_at }
```

- クライアントは、ファイルを開く前に API から取る（[architecture/README.md](README.md) の 2.2 節の 1）。
- Gateway は、署名と期限を確かめ、`jti` を Valkey に記録して使い回しを拒む。Gateway は接続に `level` と `acl_version` を覚え、Document Server へ「書き込みの接続か」を伝える。
- Document Server は、読み取りの接続から来た変更を拒否する（[ADR-0002](../decisions/0002-central-authoritative-multiplayer.md) の結合テスト）。
- 署名の鍵は API だけが持ち、Gateway は公開鍵だけを持つ。鍵の入れ替えは `kid` で行う（security.md）。

### 5.5 再開のトークン（再接続の殺到のため）

2026-09-27 に決めた（設計の承認済み）。再接続のたびに API のチケットを取ると、Gateway のタスクの喪失や入口の短い障害で、チケットの発行が律速になる（[capacity.md](capacity.md) の 2.2 節）。開いている接続には、Gateway が短い「再開のトークン」を出し、同じ持ち主への再接続では API を通さない。

```
ResumeToken（Gateway が HMAC-SHA256 で署名。有効 60 秒。1 回だけ使える）
  { rid, kid, session_id, file_id, epoch,
    account_id | anonymous_session_id, auth_session_id, level, acl_version,
    issued_at, expires_at }
```

- **出す**：Gateway は `Welcome` と一緒に出し、接続が生きている間は 30 秒ごとに出し直す（`ResumeToken` のメッセージ。[multiplayer.md](multiplayer.md) の 4.2 節）。`level` と `acl_version` は、接続が今持つ値（9.2 節の再検証の後の値）にする。水準を下げた接続には、下げた水準のトークンだけを出す。切った接続には出さない。
- **束ねるもの**：`session_id`・`file_id`・`epoch`（その時点の Router の割り当ての `epoch`。[ADR-0047](../decisions/0047-router-task-liveness-and-file-assignment.md)）。
- **使う**：クライアントは、再接続の `Hello` にチケットの代わりにトークンを入れる（`resume` と一緒に）。Gateway は次を確かめる。
  1. 署名（`kid`）と期限、`Hello` の `file_id`・`resume.session_id` との一致。
  2. `rid` の使い回し：Valkey に `SET NX`（60 秒）。チケットの `jti` と同じ扱い。
  3. `epoch`：Router が返す今の割り当ての `epoch` と等しいこと。持ち主が変わった後（Document Server の障害、ドレインの渡し）は使えない。
  4. `acl_version`：Valkey の組織の最新の値（`acl.changed` を受けた Gateway が書く）と等しいこと。違えば、その接続を 9.2 節の一括の判定（`/internal/authz/revalidate`。500 件ずつ）に入れ、返った水準で受ける（`none` なら拒む）。
  5. `auth_session_id` が取り消されていないこと（`session.revoked` を受けた Gateway が Valkey に 2 分残す印）。
- **Document Server の確かめ**：トークンでの再接続は、同じ `epoch` の持ち主が、そのセッションを API のチケットで開いたときに確かめた利用者と水準をメモリに持っているときだけ受ける。水準は、そのときの水準以下に限る。Gateway が乗っ取られても、チケットで得たことのない水準では書けない（ADR-0043 の守りを保つ）。持ち主が変わると、この記録がないので、トークンでは入れない。
- **使えないとき**：どれかが外れたら、Gateway は `Kick(ticket_required)` を返す。クライアントは API からチケットを取り、待たずに（0〜1 秒の乱数だけ待って）つなぎ直す。Valkey が止まっているときも、安全側に倒してチケットを求める。
- **効く範囲**：Gateway のタスクの喪失・入れ替え、ネットワークの切断、60 秒より短い入口の障害（持ち主が変わらない再接続）。Document Server の障害とドレインの渡しでは、チケットが要る（capacity.md の 2.2 節の見積もりで、API の発行の範囲に収まる）。60 秒を超える入口の全体の障害も、チケットが要る。
- **鍵**：Gateway だけが持つ共有の鍵（Secrets Manager）。API のチケットの鍵とは分ける。入れ替えは 90 日ごと、`kid` で 24 時間並べる（[security.md](security.md) の 5.2 節）。
- トークンも URL に入れない。ログに書かない。

## 6. 招待・ゲスト・アクセスの申請

### 6.1 招待

| 項目 | 設計 |
| --- | --- |
| 招待先 | チーム・プロジェクト・ファイル。水準を選ぶ |
| 相手 | メールアドレス（複数をカンマで）。組織のメンバーの名前 |
| 相手の種類の判定 | 確認済みのドメインに合えば `member`、合わなければ `guest`（本家と同じ。画面で「ゲスト」と示す） |
| トークン | 256 ビットの乱数。DB にはハッシュだけを置く。有効 30 日（本システムの値）。1 回だけ使える |
| 受け入れ | 招待されたメールアドレスで確認済みのアカウントでログインしたときだけ。別のアドレスのアカウントでは受け入れられない |
| 既存のアカウント | 招待と同時に `resource_roles` を作り、すぐに開ける。メールとアプリ内の通知を送る（本家と同じ） |
| 相手の存在 | 招待の画面・API は、そのメールアドレスにアカウントがあるかを返さない |
| 上限 | 1 人が 1 時間に送れる招待 100 件（本システムの値。濫用の対策） |

### 6.2 共有を変える操作の決定表

| # | 操作者の水準 | 操作 | 相手・値 | 組織の方針 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `view` | 閲覧で招待 | - | 「閲覧者に許す」がオフ | 403 |
| 2 | `view` | 閲覧で招待 | - | 「閲覧者に許す」がオン | 許可（本家の「共有を許す」） |
| 3 | `view` | それ以外 | - | - | 403 |
| 4 | `edit` | 招待・役割の変更 | 自分の水準を超える（`owner`） | - | 403 |
| 5 | `edit` 以上 | ゲストを招待 | 組織の外のメールアドレス | ゲストの禁止（MVP の後） | 403（`guests_disabled`） |
| 6 | `edit` 以上 | 一般アクセスを `anyone` に | - | 公開を禁止 | 403（`public_links_disabled`） |
| 7 | `edit` 以上 | 一般アクセスを `anyone` に | 期限なし | 期限を必須（MVP の後） | 422（`expiration_required`） |
| 8 | `edit` 以上 | 所有者の役割を外す・下げる | 相手が `owner` | - | 403（所有者の移譲は `owner` だけ） |
| 9 | `edit` 以上 | その他 | - | - | 許可。`acl_version` を上げ、監査ログに残す |

### 6.3 ゲスト

- ゲストは、招待された資源だけを使える。組織のチームの一覧・組織のライブラリ・共有のフォントを見られない（本家と同じ）。
- 一般アクセスの `org` は、ゲストに届かない（4.3 節）。
- ゲストは、ファイルを持つ組織の文脈で読む（ADR-0005）。ゲストの所属の組織の行・方針は判定に使わない。
- ゲストが他の人を招待できるのは、6.2 節の表の範囲（本家も「許されていれば招待できる」）。

### 6.4 アクセスの申請

- 5.3 節の 8 行目の画面から、水準（閲覧・編集）を選んで申請する。`access_requests` に行を作り、ファイルの `owner` と `edit` の人に通知する（[comments-and-notifications.md](comments-and-notifications.md)）。
- 通知には、申請者の名前とメールアドレスと、ファイルの名前を出す。受け手はファイルを読めるので、漏洩にならない。
- 同じ人の同じファイルへの申請は、24 時間に 1 回まで。

## 7. 一般アクセスと共有のリンク

| 設定 | 保存 | 届く人 |
| --- | --- | --- |
| 招待した人だけ | `scope = invited_only`（ファイルに行を持てば、上位を遮る） | 役割を持つ人だけ |
| 組織の中 | `scope = org`、`level` | 組織のメンバー（ゲストを除く） |
| リンクを知っている全員 | `scope = anyone`、`level`、`expires_at` | リンクを知っている全員。匿名は `view` まで |

- 一般アクセスは、ファイルの URL を知っていることを前提にする。URL はファイルの鍵（8 節）を含む。
- **期限**：本家は Enterprise だけだが、本システムはすべての有料のプランで付けられる（1 時間〜1 年）。期限を過ぎた設定は、判定の時点で無効として扱う（`expires_at < now()` なら上位の設定か `previous_scope` として計算する）。加えて、1 分ごとのスケジューラーが期限の過ぎた行を `previous_scope`・`previous_level` に戻し、`acl_version` を上げ、`acl.changed` を流す（開いている接続を切るため。9 節）。
- **パスワード**：MVP の後。付けるときは、推測を防ぐレート制限と、生成するパスワードの強さ（本家は 4 単語）を決める。
- **編集のリンク**：`anyone` で `edit` を選べる。編集にはログインと Full のシートが要る（4.3 節の上限）。
- **ライブラリの公開先**（MVP の後）：チーム・組織に公開した資産は、ライブラリのファイルを読めない公開先の人も使える。判定は `library.use` の操作として別の規則にする（[components-and-libraries.md](components-and-libraries.md) の 7 節）。
- 本家の「ワークスペースの中」は、ワークスペースと一緒に MVP の後に扱う。

## 8. 識別子と URL

| 項目 | 規則 |
| --- | --- |
| ファイルの鍵 | 128 ビットの乱数を base62（22 文字）にしたもの。内部の ID（UUIDv7）とは別に持つ。URL・共有のリンク・能力のチケットの外側では、内部の ID を出さない |
| URL | `https://<brand>.<domain>/file/{file_key}`。**ファイルの名前を URL に入れない**（本家は名前を URL に入れるが、Referer・ブラウザの履歴・チャットのプレビューから名前が漏れるため。本家との差異） |
| リンクのプレビュー（OGP） | `anyone` でないファイルには、汎用の題名と画像だけを返す。`anyone` のファイルには、名前とサムネイルを出す（リンクを受け取った人は、どのみち開ける。[export-and-assets.md](export-and-assets.md) の 8 節と同じ） |
| 検索エンジン | すべてのファイルの画面に `X-Robots-Tag: noindex` を返す |

- 本家の名前は、ドメイン・ヘッダー・トークンの接頭辞に使わない（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。

## 9. キャッシュと取り消し

[ADR-0031](../decisions/0031-org-acl-version-and-connection-revalidation.md) による。

### 9.1 `acl_version`

- 組織ごとに、単調に増える `acl_version` を持つ。権限に影響する変更は、同じトランザクションで 1 上げる（rebuilds の Notion の [ADR-0019](../../../notion/docs/decisions/0019-workspace-acl-version-cache.md) と同じ考え方）。
- 要求の始めに、主体の組織の行と同じ読み取りで `acl_version` を得る。キャッシュ（API のプロセスの中の LRU。S1）のキーは、すべて `acl_version` を含む。
  - 主体：`(org_id, account_id, acl_version) → 組織の行・シート・チームの参加`
  - 資源の鎖：`(file_id, acl_version) → (project, team, 一般アクセス, 役割の一覧)`
  - 判定の結果：`(account_id, file_id, acl_version) → capabilities`

| 変更 | `acl_version` を上げる |
| --- | --- |
| `resource_roles`・`general_access` の変更、期限による戻し | ○ |
| ファイル・プロジェクトの移動、ゴミ箱へ入れる・戻す、完全な削除 | ○ |
| チームの参加・退出・可視性の変更 | ○ |
| 組織の行の役割・シート・無効化 | ○ |
| 組織の方針（公開の禁止など） | ○ |
| ファイルの `maintenance` への出入り（[data-model/organization.md](data-model/organization.md) の `files`） | ○ |
| ファイルの名前・中身の変更、コメント | —（判定に使わない） |

### 9.2 長く続く接続

```
権限の変更（1 つのトランザクション）
  ├─ resource_roles / general_access / org_members などの変更
  ├─ orgs.acl_version += 1
  ├─ 監査ログ
  └─ outbox: acl.changed { org_id, acl_version, file_ids?（分かる範囲）}
        ├─▶ Gateway：その組織のファイルの接続を集め、API の一括の判定（/internal/authz/revalidate）に問い合わせる
        │     ├ 水準が下がって編集できない → 読み取りの接続に下げる（Document Server に伝える）
        │     └ none → Kick(forbidden) を送って切る
        ├─▶ Realtime：その組織の購読を判定し直す（comments-and-notifications.md の 5 節）
        └─▶ 検索：MVP では何もしない（問い合わせのたびに判定する。search.md）
```

- 取りこぼしに備え、Gateway は 5 分ごとに、全接続を一括で判定し直す。
- 目標：権限を外してから、開いている接続が切れるまで p99 10 秒（`acl.changed` の経路）。取りこぼしても 5 分以内。
- `acl.changed` に `file_ids` がない変更（組織の行、方針、チーム）は、その組織の全接続を判定し直す。大きな組織（数千の接続）では、一括の判定を 500 件ずつに分ける。

### 9.3 移動と `files.team_id` の書き換え

`files.team_id` は、`projects.team_id` を写した非正規化の列である（[data-model/organization.md](data-model/organization.md) の `files`）。名前の検索の候補の段（[search.md](search.md) の 3.2 節）だけが使う。判定関数は `project_id` から鎖をたどるので、`team_id` がずれても漏洩にはならない（読み直しで落ちる）。ずれると、読めるファイルが検索の候補から欠ける。

移動は、次のものを **1 つのトランザクション**で書く。

| 操作 | 同じトランザクションで書くもの |
| --- | --- |
| ファイルを別のプロジェクトへ移す（下書きとプロジェクトの間を含む） | `files.project_id`、`files.team_id`（移動先の `projects.team_id`。下書きは null）、`orgs.acl_version += 1`、監査ログ、outbox の `acl.changed { org_id, acl_version, file_ids }` と `file.moved { org_id, file_ids }` |
| プロジェクトを別のチームへ移す | `projects.team_id`、`UPDATE files SET team_id = :new_team WHERE org_id = :org AND project_id = :project`、`orgs.acl_version += 1`、監査ログ、outbox の `acl.changed { org_id, acl_version }`（`file_ids` を付けない。全接続を判定し直す）と `file.moved { org_id, project_id }` |
| チームを消す・戻す | `team_id` は書き換えない。配下のファイルはゴミ箱に入り（`state = trashed`。[file-storage-and-history.md](file-storage-and-history.md) の 11 節）、候補の段の `state = 'active'` で外れる。28 日の間に戻せば、そのまま使える |

- ロックの順は `orgs`（`acl_version` の行）→ `projects` → `files` に固定する。権限の変更（9.1 節）と同じ順にして、デッドロックを避ける。
- プロジェクトのファイルが多くても、トランザクションを分けない。分けると、`acl_version` を上げた後に古い鎖のキャッシュが残る隙間ができる。行の数が多いとき（1 万件を超える）は、移動を API の非同期のジョブにし、そのジョブの中で 1 つのトランザクションにする。
- `acl_version` を上げるので、資源の鎖・判定の結果・`readableScopes` のキャッシュ（9.1 節、search.md の 3.3 節）は、次の要求から新しい鎖で作り直される。開いている接続は 9.2 節の経路で判定し直す。
- 中身の検索（MVP の後）の索引は、`file.moved` で連鎖のフィールドを書き換える（search.md の 4.3 節）。
- 見張り：毎日、`files.team_id IS DISTINCT FROM projects.team_id` の行の数を数え、0 でなければ警告にする。
- 組織をまたぐ移動は持たない（3.1 節）。

## 10. 失敗のしかた

| 事象 | 影響 | 対処 |
| --- | --- | --- |
| `acl.changed` を取りこぼす | 外した人の接続が残る | 5 分ごとの再検証。能力のチケットは接続の時だけ使い、60 秒で切れる |
| API の判定が遅い・止まる | ファイルを開けない | 安全側に倒す（開かせない）。開いている接続は続ける。5 分ごとの再検証が失敗したら、次の成功まで今の水準のまま（編集を止めない。利用者への影響を重く見る） |
| Valkey が止まる | チケット・再開のトークンの使い回しを確かめられない | 新しい接続を拒否する（安全側）。再開のトークンでの再接続も拒み、チケットを求める（5.5 節）。開いている接続は続ける |
| 期限のスケジューラーが止まる | 期限を過ぎたリンクの接続が残る | 判定の時点で期限を確かめるので、新しい接続は開けない。開いている接続は 5 分ごとの再検証で切れる |
| 組織の `acl_version` の行の競合 | 権限の変更が詰まる | S1 の見込み（大きな組織で毎分数十件）では問題にならない。S2 で測る |
| 所有者のアカウントの削除 | 所有者のいないファイル | チームの `admin` へ移す。下書きは、組織の管理者へ移す（security.md のデータのライフサイクルで決める） |

## 11. セキュリティ：権限の漏れ

判定関数（または、それが発行したチケット）を通らない経路で、読めないファイルの中身を出さない。

| 経路 | 規則 |
| --- | --- |
| マルチプレイヤーの接続 | 能力のチケットか、同じ持ち主への再接続では Gateway の再開のトークン（5.5 節。`acl_version` と取り消しを確かめ、チケットで得た水準を超えない）だけで入る。書き込みは Document Server が接続の水準で拒否する。取り消しは 9.2 節 |
| ファイルの一覧（最近・プロジェクト・チーム） | Realtime の購読と API の一覧は、行ごとに判定関数を通す。チームの一覧は 3.3 節の可視性に従う |
| サムネイル | サムネイルの URL は、判定の後に発行する短い期限（15 分）の署名付き URL（export-and-assets.md の 8 節）。一覧の応答に URL を入れるときも、行ごとに判定を通した後で作る |
| 画像・フォント・チャンク（ファイルの中） | 同じく、判定の後の短い期限の署名付き URL（ADR-0005、ADR-0025、ADR-0035）。署名は CloudFront の縁で毎回確かめ、**キャッシュのキーに含めない**。キャッシュしたオブジェクトは中身のハッシュで名付けた不変のもので、パスに組織（`images/{org_id}/…`、`fonts/{org_id}/…`）かファイル（`files/{file_id}/…`）を含むので、別の組織・ファイルのパスの URL は署名できない（[export-and-assets.md](export-and-assets.md) の 6.4 節）。キャッシュの当たりで、署名のない要求や期限切れの署名に中身を返さないことを E10 の PoC で確かめる |
| 書き出し・複製 | Worker の job を作るときに判定し、実行の直前にもう一度判定する。「閲覧者に許す」がオフなら、`view` の人の job を作らない |
| バージョンの履歴 | バージョンの一覧と、過去のバージョンを開く接続は、ファイルの判定を通す |
| コメント・メンション・通知・メール | 送る時点で受け手を判定し直す（[comments-and-notifications.md](comments-and-notifications.md)） |
| 検索 | 候補を絞る段と、判定関数での読み直しの二重（[search.md](search.md)） |
| ライブラリ | 資産の一覧と blob は、公開先と判定を通す。取り込んだ写しは、使う側のファイルの一部として読める（設計上の性質。[components-and-libraries.md](components-and-libraries.md) の 8 節） |
| 在席（カーソル・名前） | 同じファイルの接続にだけ配る。匿名の閲覧者は「匿名」とだけ表示し、他の人の名前・メールアドレスは、ログインした人にだけ出す |
| 招待・申請の画面 | アカウントの有無、ファイルの名前（権限のない人に）を出さない |
| URL・OGP・Referer | 8 節 |
| 閲覧者の複製・書き出しの制限 | サーバーの書き出し・複製の API を止める。ただし、ブラウザにはファイルの中身が届いているので、画面の写しや開発者ツールでの取り出しは防げない。**制限は UI とサーバーの API の範囲**だと画面と文書で示す |
| ログ・メトリクス | ファイルの名前・中身を書かない。判定のログは、規則の ID・主体と資源の ID・結果だけ |
| 組織の分離 | Aurora の RLS。ファイルを持つ組織の文脈で読む（ADR-0005） |

## 12. プロトタイプと埋め込み（MVP の後）

- `view_prototype` の水準：プロトタイプの画面だけを見られる。ファイルの編集の画面は開けない。Document Server への接続は、プロトタイプの表示に要るページ・ノードだけを送る形にする（multiplayer.md と合わせる）。
- 埋め込み：アプリと別の登録可能ドメイン `embed.<brand>.<domain>`（仮）の iframe で配る。埋め込みでも判定は同じで、`anyone` でなければログインを求める。`frame-ancestors` の許可の一覧を組織の方針で持つ。
- どちらも、プロトタイピング（intent.md の「MVP の後」）と一緒に作る。

## 13. テスト

### 13.1 決定表

| 表 | 検証 |
| --- | --- |
| 3.3 節（チームの可視性） | 可視性 × 主体（メンバー・ゲスト）× 参加の有無。参加だけの人がチームの中のプロジェクト・ファイルで `none` になること |
| 4.2 節（水準 × 操作） | 全セルを表駆動テストで確かめる |
| 4.3 節の上限 | 上限ごとに、上限の前後の水準 |
| 4.4 節（シート） | 各行 |
| 5.3 節（判定） | 各行。ポリシーの JSON を入力にした表駆動テスト |
| 6.2 節（共有の変更） | 各行 |
| 7 節（一般アクセス） | 範囲 × 主体の種類（メンバー・ゲスト・匿名）× 期限の内外 |

### 13.2 性質ベーステスト

| 性質 | 内容 |
| --- | --- |
| 上げるだけ | 任意の階層と役割で、下位の役割を足しても実効の水準は下がらない |
| 遮り | ファイルが `invited_only` の行を持つとき、上位の一般アクセスをどう変えても、役割のない人の水準は `none` |
| チームは届かない | 任意のチームの可視性と参加で、チーム・プロジェクト・ファイルの役割と、プロジェクト・ファイルの一般アクセスを持たない人の水準は `none` |
| 取り消しの線形化 | 任意の権限の変更と判定の並行の列で、変更の確定の後に始まった判定は、変更後の権限で判定される |
| 組織の分離 | 任意の 2 組織で、一方の主体（ゲストでない）が、共有されていない他方のファイルで `none` |
| 段階の短絡 | 任意の入力で、段階 1 で止めた判定と、全部を読んだ判定の結果が一致する |
| チケット | 任意のチケットの改ざん・期限切れ・再使用で、Gateway が接続を拒否する |
| 期限 | 任意の時刻で、`expires_at` を過ぎた `anyone` は、スケジューラーの前でも後でも届かない |

### 13.3 漏洩のテスト

- 11 節の経路ごとに、「権限のない人」「外された直後の人」「別の組織の人」「匿名」の 4 つの主体で、ファイルの名前・サムネイル・コメント・画像の URL が返らないことを確かめる結合テストを持つ。経路を足したら、この表とテストを足す（quality.md で管理する）。

## 14. Story の候補

Epic の番号と名前は [roadmap.md](../roadmap.md) のとおり（E1〜E12 が MVP。ここの MVP の後の項目は、どれも roadmap.md の延期の一覧に置いた）。

| Epic | Story の候補 |
| --- | --- |
| E1 | 組織・チーム・プロジェクト・ファイルの表と RLS、最小の判定関数（所有者だけ） |
| E1 | 能力のチケットと、Gateway での検証 |
| E3 | 再開のトークン（5.5 節。multiplayer の `reconnect-resume` と組む） |
| E9 | 役割と継承（4.3 節）、ポリシーの形と評価器、段階の読み込み |
| E9 | 招待（トークン、メンバーとゲストの判定）、ゲストの制限 |
| E9 | 一般アクセス（招待した人だけ・組織の中・リンクを知っている全員）、匿名の閲覧 |
| E9 | リンクの期限とスケジューラー |
| E9 | シート（Full・View）、シートの申請と承認の設定 |
| E9 | 「閲覧者に複製・共有・書き出しを許す」 |
| E9 | アクセスの申請 |
| E9 | `acl_version` のキャッシュ、`acl.changed` と接続の再検証 |
| E9 | ファイル・プロジェクトの移動と `files.team_id` の書き換え（9.3 節） |
| E9 | 共有の画面（ファイル・プロジェクト・チーム） |
| E9 | 漏洩のテスト一式（13.3 節） |
| E9 | アクセスの申請・招待の通知（通知の仕組みは E8。comments-and-notifications の同じ Story と 1 つ） |
| E12 | 判定のデバッガー（サポート向け）、監査ログの記録 |
| E12 | 組織の SAML SSO（security.md の `org-saml-sso`。MVP の範囲の外で、GA の判定に含めない） |
| 延期 | ワークスペース、ユーザーグループ、ゲストの禁止・リンクの期限の必須などの方針、SCIM |
| 延期 | プロトタイプだけの閲覧と埋め込み、リンクのパスワード |

## 15. 未解決の問い

1. 「プロジェクト」を本家に合わせて「フォルダー」と呼ぶか。
2. open のチームのファイルを、組織のメンバーがチームへの参加だけで開けるか（3.3 節）。
3. 閲覧の人にバージョンの一覧を見せるか（4.2 節）。
4. リンクの期限を、本家（Enterprise だけ）と違い、すべての有料のプランで出すか。
5. 判定の API が止まったとき、開いている接続の編集を止めるか（10 節）。
6. ファイルの名前を URL に入れない（本家との差異）ことを、利用者が不便に感じるか。

### 決定

2026-09-27 に、次のとおり決めた。1 と 2 は、推奨案で確定した。

| 問い | 決定 |
| --- | --- |
| 1 | S1 は「プロジェクト」のまま。利用者の調査で混乱が見えたら見直す。表とコードの名前は `project` のまま変えない |
| 2 | 開けない。本家に合わせ、チームの可視性と参加は中身に引き継がない。開くには役割か、プロジェクト・ファイルの一般アクセスが要る（3.3 節） |
| 3 | 見せる。復元と名前付けは `edit` 以上 |
| 4 | すべての有料のプランで出す |
| 5 | 止めない。新しい接続だけを止める。再検証の失敗が 15 分続いたら、接続を読み取りに下げる |
| 6 | 入れない。安全側を優先する |

## 16. quality.md・runbooks・data-model への項目

### quality.md

- 13 節の決定表・性質・漏洩のテストを、E9 の `spec.md` の `DT-*`・`PROP-*` に移す。
- 漏洩の経路の一覧（11 節）を、quality.md の「経路ごとのテスト」の表として持ち、経路の追加をレビューで確かめる。
- ポリシーの変更は、判定の結果の差分（本番の要求の標本で、新旧の結果を比べる影の評価）を出してからリリースする。本家の移行に倣う。

### runbooks

- 「共有を外したのに見えている」問い合わせ：`acl_version`、`acl.changed` の配送、Gateway の再検証のメトリクスの見方。
- 権限の漏洩の疑い：影響の範囲（判定のログの規則の ID と資源の ID）の調べ方。報告の要否は法務の確認待ち（[intent.md](../intent.md) の L5）。
- 能力のチケットの署名の鍵の入れ替え。
- 期限のスケジューラーの遅れのアラート。
- 不正な内容の `anyone` のリンクの取り下げ（法務の確認待ち。intent.md の L3）。

### data-model

形の正本は [data-model/organization.md](data-model/organization.md) と [data-model/sharing.md](data-model/sharing.md)。

| テーブル | 中身 |
| --- | --- |
| `orgs` | プラン、方針（公開の禁止、シートの承認の設定）、`acl_version` |
| `org_domains` | `org_id`、`domain`、TXT の値、確認した日時。確認済みのドメインは組織をまたいで一意 |
| `org_members` | `org_id`、`account_id`、`role`（`admin` / `member` / `guest`）、`seat`（`full` / `view`）、無効化日時 |
| `teams` | `org_id`、名前、`visibility`（`open` / `closed` / `secret`） |
| `team_members` | `team_id`、`account_id`、参加日時（役割は `resource_roles`。参加はチームを見せるだけで、中身に届かない） |
| `projects` | `org_id`、`team_id`、名前 |
| `files` | `org_id`、`project_id`（下書きは null）、`owner_account_id`（所有者の唯一の出どころ）、`file_key`（組織をまたいで一意）、名前。状態（`state`・`trashed_at` など）と `checkpoint_seq` は [file-storage-and-history.md](file-storage-and-history.md) の 17 節に合わせる |
| `resource_roles` | `org_id`、`resource_type`、`resource_id`、`account_id`、`level`（ファイルの行に `owner` を置かない）、`granted_by`、作成日時 |
| `general_access` | `org_id`、`resource_type`（`project` / `file`）、`resource_id`、`scope`、`level`、`expires_at`、`previous_scope`、`previous_level`、`viewers_can_copy_share_export` |
| `invitations` | `org_id`、資源、`email_normalized`、`level`、`token_hash`、`expires_at`、`accepted_at`、`invited_by` |
| `access_requests` | `org_id`、`file_id`、`account_id`、`level`、`state`、作成日時 |
| `seat_requests` | `org_id`、`account_id`、`requested_seat`、`state`、処理した人と日時 |

すべて `org_id` を持ち、`FORCE ROW LEVEL SECURITY` を付ける（ADR-0005）。`accounts` はテナントの外。

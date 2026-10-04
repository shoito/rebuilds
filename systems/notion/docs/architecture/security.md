# Security: Notion

信頼境界、脅威モデル、統制、暗号化、監査ログ、データのライフサイクル、濫用対策、セキュリティの試験。Slack の [security.md](../../../slack/docs/architecture/security.md) を先例にし（[ADR-0001](../decisions/0001-platform-and-stack.md)）、同じところは参照にとどめ、Notion に固有のところを書く。

| 関連 | 決定 |
| --- | --- |
| [ADR-0003](../decisions/0003-workspace-sharding.md) | ワークスペースで RLS と論理シャード |
| [ADR-0004](../decisions/0004-inherited-page-permissions.md) | 権限はページの木を継承し、1 つの判定関数で決める |
| [ADR-0018](../decisions/0018-permission-levels-and-inheritance.md) | 権限の水準と、置き換えの継承 |
| [ADR-0019](../decisions/0019-workspace-acl-version-cache.md) | ワークスペースの権限のバージョンによるキャッシュと無効化 |
| [ADR-0020](../decisions/0020-published-pages-isolation.md) | 公開ページを別のドメインで配り、既定で noindex |
| [ADR-0021](../decisions/0021-accounts-members-guests-and-teamspaces.md) | アカウントとメンバー、ゲスト、チームスペース |
| [ADR-0023](../decisions/0023-search-engine-and-permission-filtering.md) | 検索は権限キーと読み直しの二重 |
| [ADR-0024](../decisions/0024-integration-access-model.md)・[ADR-0025](../decisions/0025-webhook-delivery.md) | 連携は明示的に共有されたページだけ。Webhook は中身を含めず、隔離した egress から送る |
| [ADR-0022](../decisions/0022-trash-history-and-deletion-retention.md) | ゴミ箱・履歴・削除の保持 |
| [ADR-0033](../decisions/0033-transfer-private-pages-of-deactivated-members.md) | 無効化したメンバーのプライベートのページを、所有者が監査付きで移す（E10） |
| Slack の ADR-0016・0017・0018 | 隔離した外向きの取得、暗号化と鍵管理、監査ログ。Notion でも同じにする |

## 1. 目標と前提

- 目標水準は Slack と同じく OWASP ASVS 5.0 の Level 2。
- **最も重い障害は、権限のないページの中身が見えること**（NFR-010）。ワークスペースをまたぐ漏洩に加え、同じワークスペースの中で、制限したページ・プライベートのページ・非公開のチームスペースが見えることも同じ重さで扱う。
- ブロックの本文は構造化したデータ（[ADR-0002](../decisions/0002-everything-is-a-block.md)）で、生の HTML を描画しない（[editor.md](editor.md)）。
- AI コーディングエージェントは本番に触れない（Slack の security.md の 7.3 節と同じ）。

## 2. 信頼境界

```
  ┌───────────────── インターネット（信頼しない）─────────────────┐
  │ Browser（メンバー・ゲスト）  匿名の閲覧者  連携  埋め込み先  攻撃者 │
  └──┬───────────────┬──────────────┬─────────────▲──────────────┘
     │ app.<domain>   │ *.<brand>.site │ API         │ 外向き（Webhook・取得）
  ═══╪═══════════════╪══════════════╪═════ B1: エッジ（CloudFront＋WAF）
     │               │              │        ┌────┴──────────────┐
     │               ▼              │        │ Egress（Lambda）   │
     │        公開サイトの描画       │        │ VPC に接続しない   │
     │        （public の主体だけ）   │        └────▲──────────────┘
  ┌──▼──────────────────────────────▼──────────────┼────────────┐
  │ API ── Sync Gateway（WS）   Worker（検索・通知・ファイル・Webhook）│
  │ ═══ B2: テナントのコンテキスト＋判定関数 can() ═══             │
  │ Aurora（RLS、480 論理シャード）  Valkey  SQS  outbox          │
  └──────────────────────────────────────────────────────────────┘
  B3: 管理プレーン（CI/CD、KMS、Secrets Manager、運用者）
  B4: 端末（ローカルの保存：SQLite（WASM、OPFS））… 利用者の管理下
  B5: 利用者のファイル  <brand>usercontent.<domain>（署名付き URL）
  B6: 埋め込み  <brand>embed.<domain>（sandbox の iframe）
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | すべての外部の要求 | TLS、WAF、レート制限。ALB は CloudFront からだけ受ける |
| B2 テナントと権限 | API・Gateway の購読・Worker から DB への全アクセス | `SET LOCAL app.workspace_id`、FORCE RLS（ADR-0003）、`can()`（ADR-0004） |
| B3 管理プレーン | デプロイ、鍵、運用者の操作 | Slack の security.md の 2 節と同じ |
| B4 端末 | 同期したページの写し、未送信の変更 | 権限の取り消しでの消去、ログアウトでの消去（3.3 節） |
| B5 ファイル | アップロードしたファイル | 別の登録可能ドメイン、短命の署名付き URL、スキャン |
| B6 埋め込み | 第三者のページ | 別のドメインの sandbox の iframe、許可した提供元 |
| 公開サイト | 匿名の閲覧者への公開ページ | 別の登録可能ドメイン、アプリのスクリプトなし、`public` の主体での判定（ADR-0020） |
| Egress | Webhook、リンクのプレビュー、URL からのインポート | VPC に接続しない Lambda、名前解決後の IP の検査（Slack の ADR-0016） |

ドメインの名前は repo の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従い、置き換え用の名前で書く。

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。Slack と同じもの（CSRF、セッション、SQL インジェクション、サプライチェーン）は Slack の security.md の 3 節を正とし、ここには Notion に固有のものを書く。

### 3.1 API

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | ページの ID を直接指定して読む（IDOR）。ブロックの ID から親のページを越えて読む | すべての読み取りを `can()` に通す。ブロックは `page_id` の水準で判定する。読めないものは 404 |
| I | 判定関数を通らない経路（パンくず、メンション、バックリンク、ロールアップ、同期ブロック、エクスポート）からのタイトルの漏洩 | [permissions-and-sharing.md](permissions-and-sharing.md) の 4.7 節の規則。経路ごとの漏洩テスト（10 節） |
| E | ページの移動で、共有の設定を迂回して他人のページの権限を変える | 実効の ACL が変わる移動は `full_access` を要求する（ADR-0018） |
| E | 古いキャッシュによる取り消し後の読み取り | キャッシュのキーに `acl_version` を含め、変更と同じトランザクションで上げる（ADR-0019） |
| T | トランザクションで木の不変条件を壊す（循環、別のワークスペースへの移動） | サーバーで拒否する（ADR-0002、ADR-0003）。ワークスペースをまたぐ移動は非同期のジョブで、両側の判定を通す |
| D | 巨大なページ・深い木・大量の子孫を持つページの移動や共有の変更 | 本文・操作数の上限、移動する子孫の数の上限（[block-model.md](block-model.md)）、ステートメントのタイムアウト、レート制限 |
| R | 共有の変更・公開・完全な削除の否認 | 監査ログ（6 節） |

### 3.2 Sync Gateway

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 他人として接続する | Slack と同じく、API が発行する 30 秒・1 回限りのチケットと `Origin` の検査 |
| I | 読めないページを購読する、権限を失った後も変更を受け取る | 購読は `can()` で判定したものだけ。`acl.changed` で購読を判定し直し、読めなくなった接続に `page.revoked` を送る。送る直前の確認と定期の再検証（permissions-and-sharing.md の 5.3 節、[collaboration.md](collaboration.md) の 7.2 節） |
| I | 在席（カーソル・閲覧中の人）から、読めないページの存在や閲覧者が漏れる | 在席は購読と同じ判定を通した接続にだけ配る |
| T | 権限のない変更を WebSocket から送る | Gateway は書き込まない。変更は API のトランザクションの受け付けで `can()` を通す（ADR-0005） |
| D | 購読の大量作成、巨大なフレーム | 接続・購読の数と、フレームのサイズとレートの上限 |

### 3.3 クライアントのローカルの保存

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 共有端末・盗難端末に残ったページの写し | ログアウトでローカルの保存を消す。サーバーからのセッションの取り消しを受けたら消す。MVP のデスクトップアプリは Web と同じ OPFS の SQLite を使い、独自の暗号化はしない（OS のディスク暗号化に頼る。11 節） |
| I | 権限を失ったページが端末に残る | `page.revoked` と再接続時の照合で消す（permissions-and-sharing.md の 5.4 節）。**オフラインのまま戻らない端末に残ったデータは消せない。これは引き受ける危険とし、利用者向けの文書に書く** |
| T | 改ざんしたクライアントが、他人の変更を装う・権限のない変更を送る | サーバーがすべての操作を検証し、作成者をセッションの主体で決める。クライアントの申告を信じない |
| E | 同じオリジンの XSS でローカルの保存を読む | CSP と Trusted Types（Slack の 5 節と同じ）。本文は構造化したデータから描画する |

### 3.4 公開サイト・共有のリンク

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 公開ページを使ったフィッシング（本家のドメインの信用を借りる） | 別の登録可能ドメイン（ADR-0020）。ログインしていない閲覧者をアプリのオリジンで匿名の内容に触れさせない。濫用対策（8 節） |
| I | 公開していない子孫・メンション先・同期ブロック・リンクしたデータベースが公開サイトに出る | 描画サービスは `public` の主体で 1 ブロックずつ `can()` を通す。範囲外は描画しない。性質ベーステスト（10 節） |
| I | 意図せず検索エンジンに載る | 既定は `noindex`。有効にしたときだけ外す |
| I | 取り下げの後も CDN に残る | 取り下げで CDN を無効化する。キャッシュの TTL を短くする（最大 60 秒） |
| E | 公開サイトのドメインからアプリの Cookie・API を使う | 別の登録可能ドメインなので Cookie が送られない。API の CORS は公開サイトのドメインを許可しない。公開サイトはアプリのスクリプトを読み込まない |
| I | ワークスペースのサブドメインどうしで Cookie を共有する | `<brand>.site` を Public Suffix List に登録する |
| D | 人気のページへの大量のアクセス | CDN のキャッシュ、描画サービスのレート制限 |

### 3.5 埋め込み（iframe）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| E | 埋め込んだ第三者のページが、アプリの DOM・Cookie・トークンに触れる | 埋め込みは別ドメイン `<brand>embed.<domain>` の iframe の中にさらに入れ、`sandbox`（`allow-same-origin` は埋め込み用のドメインにだけ効く）を付ける。アプリの CSP の `frame-src` を埋め込み用のドメインに限る |
| S | 埋め込みの中にログイン画面を装う | 埋め込みの枠に提供元のドメインを表示する。任意の URL の埋め込みは、許可した提供元の一覧（oEmbed）を優先し、それ以外は枠の印を強くする |
| I | 埋め込みの読み込みで、閲覧者の IP や閲覧の事実が第三者に漏れる | 公開サイトでは、閲覧者の操作で初めて読み込む（クリックで表示）。アプリでは既定で読み込む（本家に合わせる。未検証） |
| I | リンクのプレビューの取得による SSRF | Egress の Lambda（Slack の ADR-0016） |

### 3.6 ファイルのアップロード

Slack の ADR-0015 を先例にする（[api-and-integrations.md](api-and-integrations.md) と [editor.md](editor.md) で詳細）。

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| T | マルウェア、HTML・SVG による XSS | スキャン。`<brand>usercontent.<domain>` から `X-Content-Type-Options: nosniff`、画像・PDF 以外は `Content-Disposition: attachment`、SVG は画像として再エンコードする |
| I | ファイルの URL の使い回しで、権限を失った後も読める | ファイルは、属するブロックのページで `can()` を通したときだけ、短命（例：1 時間）の署名付き URL を出す。公開サイトのファイルも同じ仕組みで、`public` の主体で判定する |
| D | 巨大なファイル | プランごとの上限、署名付きのアップロードの条件でサイズを縛る |

### 3.7 連携・Webhook・外向きの送信

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| E | 連携が、共有されていないページを読む | `bot:` の ACL の項目と能力の両方で絞る（ADR-0024）。連携に共有の設定を変える操作を出さない |
| I | Webhook で、送った後に権限を失ったページの中身が漏れる | Webhook は ID と種類だけを送り、配送の時点（再試行を含む）で判定する（ADR-0025） |
| I | Webhook の送信先を内部のアドレスにする SSRF | Egress の Lambda、名前解決後の IP の検査、リダイレクトを追わない |
| S・T | Webhook の偽装・再送 | `X-<Brand>-Signature` の HMAC-SHA256 署名（ADR-0025、[api-and-integrations.md](api-and-integrations.md) の 6 節） |
| S | トークンの漏洩 | 接頭辞付きのトークン（`<brand>_int_...` など）をシークレットスキャンに登録する（repo の ADR-0006）。DB にはハッシュだけ |
| E | OAuth の混乱した代理、同意の偽装 | `state` と PKCE、リダイレクト URI の完全一致。同意の画面に連携の名前と能力を示す |
| D | 連携の暴走 | 連携・インストールごとのレート制限（本家の公開 API にも要求数の上限がある） |

### 3.8 Worker（検索・通知・エクスポート・インポート）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 通知・メールに、送る時点では読めないページの中身が入る | 送る直前に受け手で `can()` を通す |
| I | 検索の索引の権限の情報が古い | 結果を必ず `can()` で絞る（[search.md](search.md)） |
| I | エクスポートに読めないページが入る | ページごとに `can()` を通す。エクスポートの成果物は依頼者だけが、短命の URL で取れる |
| T | インポートした Markdown・HTML に含まれるスクリプト | ブロックに変換し、HTML を持ち込まない |

## 4. 統制の一覧

| 領域 | 統制 | 確認方法 |
| --- | --- | --- |
| テナント分離 | FORCE RLS、`workspace_id` の複合キー（ADR-0003） | マイグレーションの lint、性質ベーステスト |
| 権限 | `can()` の集約、決定表、`acl_version` | 表駆動テスト、素朴な実装との一致、経路ごとの漏洩テスト |
| 認証 | Slack の ADR-0012 を先例にする | Slack の identity-and-access.md |
| 公開 | 別ドメイン、noindex の既定、描画での判定 | ヘッダーの結合テスト、公開の範囲の性質ベーステスト |
| 暗号化 | TLS、KMS のカスタマー管理キー（5 節） | Slack の ADR-0017 の Confirmation |
| 監査 | 監査ログ（6 節） | 同じトランザクションで書かれることの結合テスト |
| Web | CSP、Trusted Types、CSRF、クリックジャッキング | Slack の security.md の 5 節と同じ |
| 濫用 | 公開サイトの通報・取り下げ・スキャン（8 節） | 運用の指標 |

## 5. 暗号化

Slack の ADR-0017 と同じにする。

- 転送中：外部は TLS 1.2 以上と HSTS。内部も TLS。
- 保存時：Aurora・S3・ElastiCache・SQS・バックアップを、データの種類ごとの KMS のカスタマー管理キーで暗号化する。本家も保存時は AES-256、転送中は TLS 1.2 以上である（[Security & privacy](https://www.notion.com/help/security-and-privacy)）。
- ワークスペースごとの鍵（顧客が鍵を止められる EKM）は、S2 以降の選択肢として移行の道筋だけを残す（Slack の ADR-0017 と同じ）。
- クライアントのローカルの保存の暗号化は 3.3 節。

## 6. 監査ログ

Slack の ADR-0018 と同じ方式（操作と同じトランザクションで `audit_events` に追記し、Object Lock の S3 にハッシュの連鎖付きで送る）にする。

| 分類 | 例 |
| --- | --- |
| ページ | 共有の変更（追加・水準の変更・制限・継承に戻す）、一般アクセスの変更、公開・取り下げ・検索エンジンへの掲載の変更、チームスペースをまたぐ移動、完全な削除、エクスポート |
| チームスペース | 作成、種類の変更、参加・退出、ロールの変更、アーカイブ |
| ワークスペース | 設定・セキュリティの方針の変更、メンバーの招待・ロールの変更・無効化、ゲストの追加と申請の承認、グループの変更、無効化したメンバーのプライベートのページの移し替え（E10。ADR-0033） |
| 連携 | 作成、インストール、ページへの共有・取り消し、トークンの発行・取り消し |
| アカウント | ログインの成功・失敗、MFA の変更、セッションの取り消し |
| 運用者 | サポートのためのアクセス、濫用による公開の停止、ワークスペースの停止 |

- アカウントの分類（ログイン、MFA、セッションの取り消し）と、ワークスペースに属さない運用者の操作は、ワークスペースを持たないので `global.platform_audit_events` に記録する（2026-09-28。[data-model/global.md](data-model/global.md)）。
- 記録しないもの：ブロックの編集と閲覧（量が多く、ページの履歴が編集の記録になる）。
- 表 `audit_events`：主キー `(workspace_id, id)`。列は `occurred_at`、`actor_member_id`、`actor_kind`（`human` / `bot` / `mcp` / `operator`）、`action`、`target_type`、`target_id`、`ip`、`user_agent`、`details`（ID だけ。本文を含めない）、`prev_hash`、`hash`。索引は `(workspace_id, occurred_at)`、`(workspace_id, target_id)`。時間でパーティションを切り、365 日を過ぎたパーティションを `DROP` する。
- 本家の監査ログは Enterprise の機能で、365 日保持し、CSV で出力でき、SIEM へ Webhook で送れる（[Audit log](https://www.notion.com/help/audit-log)）。本システムは記録を全プランで MVP から行い、DB に 365 日置く。閲覧の画面・CSV・SIEM は Enterprise の機能として E10 で作る。アーカイブ（Object Lock の S3）は 2 年保持する（Slack の ADR-0033 に合わせた既定案）。ワークスペースの削除の後にアーカイブを残す期間は、法務の確認待ち（[intent.md](../intent.md)）。

## 7. データのライフサイクル

方針は [ADR-0022](../decisions/0022-trash-history-and-deletion-retention.md)。

| データ | 保持 | 削除のされ方 |
| --- | --- | --- |
| ゴミ箱のページ | 30 日（本家と同じ。Enterprise は所有者が変えられる） | 30 日で「完全に削除」の状態へ移す |
| 完全に削除したページ（`purged_at`） | 30 日は運用者が所有者の依頼で戻せる | 期限の後に Worker が部分木・ファイル・スナップショット・索引を物理削除する（[block-model.md](block-model.md) の 9 節） |
| ページの履歴（バージョン） | プランで 7 日（Free）・30 日（Plus）・90 日（Business）・無期限（Enterprise）。MVP は 30 日（block-model.md の 8 節） | 期限を過ぎたバージョンを毎日消す。期限は消す時点のプランで決める |
| 検索の索引 | 元のデータに従う | ゴミ箱に入れたら、文書を残したまま `in_trash: true` にし、通常の検索から外す。ゴミ箱の中のページは、ゴミ箱の画面の検索からだけ出し、`can_edit` 以上の人だけが見る（[search.md](search.md) の 1・6.1 節、ADR-0022 の注記）。物理削除で文書を tombstone にし、7 日後に消す |
| ファイル | 属するブロックに従う | ブロックの物理削除で S3 のオブジェクトを消す |
| 公開サイトの CDN のキャッシュ | 最大 60 秒 | 取り下げで無効化 |
| 監査ログ | DB に 365 日、アーカイブ 2 年 | 6 節 |
| エクスポートの成果物 | 7 日 | S3 のライフサイクル |
| アプリのログ | 30 日（本文・トークンを含めない） | 自動 |
| バックアップ | 35 日 | 期限で消える。削除の最終的な期限になる |

- 本家の保持の値：ゴミ箱の 30 日、完全に削除した後の 30 日、履歴のプランごとの日数（[Duplicate, delete, and restore content](https://www.notion.com/help/duplicate-delete-and-restore-content)、[Pricing](https://www.notion.com/pricing)）。
- **ワークスペースの削除**：所有者が再認証して依頼し、30 日の猶予の後に `workspace_id` 単位で消す（Slack の ADR-0019 と同じ）。本家は、ワークスペースの削除をすぐ確定させ、利用者向けの猶予を持たない。サポートが過去 30 日のバックアップから戻せる（[Delete a workspace](https://www.notion.com/help/delete-a-workspace)、[Workspace settings](https://www.notion.com/help/workspace-settings)、2026-09-27 に確認）。30 日の猶予は、本家より手厚い本システムの決定である。
- **アカウントの削除**：アカウントの個人情報を消し、各ワークスペースのメンバーを「削除されたユーザー」として匿名化する。共有したページはワークスペースのデータとして残る。プライベートの領域のページ（本人しか読めないもの）は、ゴミ箱に入れて通常の削除の段階に流す。アカウントの削除では、所有者に引き継ぐ経路は持たない（11 節）。この扱いと保持の期間は法務の確認待ち（[intent.md](../intent.md) の L1・L2）。メンバーの無効化では、E10 で、所有者が中身を読まずに別のメンバーへ移せる（[ADR-0033](../decisions/0033-transfer-private-pages-of-deactivated-members.md)）。
- **削除の完了**：ページはゴミ箱から最長 30＋30＋35＝95 日で、バックアップを含めて消える。
- 表 `deletion_jobs`：主キー `(workspace_id, id)`。列は `kind`（`page_purge`：物理削除 / `workspace_delete`：ワークスペースの削除 / `history_expire`：履歴の期限切れ）、`target_id`、`state`（`scheduled` / `running` / `done` / `failed`）、`scheduled_at`、`attempts`、`last_error`、`completed_at`。索引は `(workspace_id, state, scheduled_at)`。
- 手順は runbook の `data-deletion`（E8）に書く。

## 8. 濫用対策

公開サイトは、本家でもフィッシングやマルウェアの配布に使われやすい（一般的な傾向として。具体的な件数は未検証）。

| 対策 | 内容 |
| --- | --- |
| ドメインの分離 | 公開サイトは `<brand>.site`（ADR-0020）。アプリのドメインの評判を守る |
| 通報 | すべての公開ページに「通報する」リンクを置く。通報は運用者の確認の列に入る |
| 自動の検査 | 公開時と更新時に、外部リンクを URL の評判の API で確かめる。ログインの画面を装う文言・ブランドの名前とパスワードの入力の誘導を、ルールで点数付けする。点数が高ければ、公開を保留して確認に回す |
| 新しいワークスペースの制限 | 作成から一定期間（例：7 日）は、公開できるページ数と、検索エンジンへの掲載を制限する |
| 取り下げ | 運用者は公開を止められる（`publishing_suspended`）。止めた理由を監査ログに残し、所有者に通知する |
| 検索エンジン | 既定は `noindex`。濫用したワークスペースの掲載を止める |
| レート制限 | ワークスペースの作成、招待、公開の操作。値は Slack の ADR-0029 を先例に決める |
| 招待のスパム | ゲストの招待のメールに、送り主のワークスペースとメールアドレスを示す。1 日あたりの招待の上限 |

- 表 `abuse_reports`：主キー `(workspace_id, id)`。列は `site_id`（`published_sites`）、`page_id`、`source`（`user_report` / `auto_scan`）、`reporter_email`（任意）、`reason`、`score`、`state`（`open` / `reviewing` / `actioned` / `dismissed`）、`reviewed_by`（運用者）、`created_at`、`resolved_at`。索引は `(workspace_id, state, created_at)`。運用者の確認の列は、運用の道具が各シャードのこの索引を引いてまとめる。
- 手順は runbook の `abuse-takedown`（E8）に書く。

## 9. AI エージェントと連携

- AI エージェントは、連携（`bot:`）か、MCP での利用者の委任として扱い、人間と同じ `can()` を通る（permissions-and-sharing.md の 9 節、[api-and-integrations.md](api-and-integrations.md) の 8.2 節）。個人のアクセストークンは MVP に入れない。
- 将来の Notion AI 相当の機能（intent.md の Non-goals）は、Slack の security.md の 7.1 節と同じ前提（権限を先に適用、テナントを混ぜない、本文は命令として扱わない）で作る。

## 10. セキュリティの試験

Slack の security.md の 10 節（SAST、シークレットスキャン、依存、IaC、DAST、ペネトレーションテスト）に、次を加える。

| 種類 | 内容 | 実行タイミング | 合否 |
| --- | --- | --- | --- |
| 権限の一致 | 任意の木・共有・制限・移動・グループの変更の列で、`can()`（キャッシュあり）の結果が、祖先をたどる素朴な実装と一致する | PR | 不一致 0 件 |
| エポックの単調性 | 任意の権限の変更の後に始まった要求は、変更後の権限で判定される | PR | 反例 0 件 |
| 経路ごとの漏洩 | 読めないページの中身・タイトルが、検索・通知・API・Webhook・パンくず・メンション・バックリンク・同期ブロック・リレーション・ロールアップ・エクスポート・公開サイト・在席に現れない | PR | 0 件 |
| 取り消しの反映 | 権限を外した後、Gateway の配信とクライアントのローカルの保存から消える | 結合テスト | 期限内に 0 件 |
| 公開の範囲 | 公開サイトの HTML に、`public` で読めないブロックの中身が現れない | PR | 0 件 |
| ヘッダー | 公開サイトの `noindex`・CSP、ファイルのドメインの `nosniff`・`attachment` | PR | 期待値と一致 |
| 埋め込み | 埋め込みの iframe からアプリの DOM・Cookie・`postMessage` に触れられない | E2E | 0 件 |
| SSRF | Egress から内部のアドレスに届かない | 結合テスト | 0 件 |

## 11. 決定と持ち越し

2026-09-26 に、本家に寄せる既定案で次のとおり決めた（[README.md](README.md) の「決定」）。

| 問い | 決定 |
| --- | --- |
| アカウントの削除で、プライベートの領域のページをどうするか | ゴミ箱に入れて通常の削除の段階に流す。所有者への引き継ぎは持たない（7 節）。本家は、自分だけのワークスペースを消し、共有のワークスペースから外す。外れた後は本人もプライベートのページに入れず、Enterprise の所有者は 30 日以内なら別の利用者へ移せる（[Delete your account](https://www.notion.com/help/delete-your-account)、[Transfer content from a deprovisioned user](https://www.notion.com/help/transfer-content-deprovisioned-user)、2026-09-27 に確認）。アカウントの削除で引き継ぎを持たない点は本家との差異。契約・個人情報の扱いに関わる点は法務の確認待ち（L2）。メンバーの無効化で移す機能は、2026-09-28 に E10 で持つと決めた（[ADR-0033](../decisions/0033-transfer-private-pages-of-deactivated-members.md)） |
| 完全に削除したページを 30 日戻す経路 | 運用者への依頼だけ（所有者の画面は作らない。ADR-0022）。手順は runbook の `data-deletion`（E8） |
| 監査ログのアーカイブの保持期間 | 2 年（6 節） |
| デスクトップアプリのローカルの保存の暗号化 | S1 は Web と同じ実装で、独自の暗号化はしない。ネイティブの SQLite に移すとき（S2 の候補。[ADR-0032](../decisions/0032-desktop-uses-wasm-sqlite-in-s1.md)）に OS の資格情報の保管庫の鍵で暗号化する |

持ち越し：

- 公開サイトのフィッシングの自動の検査の、誤検知の許容度（PM、Ops）。E8 の `abuse-reporting-and-takedown` の運用で、保留の件数と誤検知の率を見て決める。

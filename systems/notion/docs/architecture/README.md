# Architecture: Notion

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルにある。

| ファイル | 領域 |
| --- | --- |
| [block-model.md](block-model.md) | ブロックのデータモデル、ページの木、同期ブロック、履歴 |
| [editor.md](editor.md) | エディタ、リッチテキスト、ブロックの種類、クライアントの構成 |
| [collaboration.md](collaboration.md) | 同時編集の方式、変更の配信、在席、オフラインと統合 |
| [databases.md](databases.md) | データベース、プロパティ、ビュー、フィルタ、リレーション、ロールアップ、数式、問い合わせ |
| [permissions-and-sharing.md](permissions-and-sharing.md) | ワークスペース、チームスペース、ページの権限と継承、ゲスト、公開、アカウント |
| [search.md](search.md) | 全文検索、権限の適用 |
| [comments-and-notifications.md](comments-and-notifications.md) | コメント、メンション、通知 |
| [api-and-integrations.md](api-and-integrations.md) | 公開 API、Webhook、インポートとエクスポート |
| [security.md](security.md) | 脅威モデル、暗号化、監査ログ、データのライフサイクル |
| [data-model.md](data-model.md) | データモデルの索引 |
| [infrastructure.md](infrastructure.md) | AWS の構成、シャード、冗長化、災害復旧 |
| [observability.md](observability.md) | ログ、メトリクス、トレース、SLO |
| [capacity.md](capacity.md) | 負荷のモデル、部品ごとの必要量、パラメーター |
| [delivery.md](delivery.md) | CI/CD、リリース、フィーチャーフラグ |

## 1. 全体構成

```
ブラウザ・デスクトップ（ローカルの保存：SQLite（WASM、OPFS））
   │  HTTPS（読み込み・API）         │ WebSocket（変更の送受信・在席）
   ▼                                  ▼
 API ─── 変更の受け付け（操作の検証・権限・順序付け）──▶ Aurora（ワークスペースで論理シャード）
   │                                       │ outbox
   │                                       ▼
   │                         Relay ─▶ 配信のバス ─▶ Sync Gateway（WebSocket）
   │                                       └─▶ Worker（検索の索引、通知、ファイル、Webhook）
   └── ファイル（S3・CloudFront）
```

| コンポーネント | 責務 |
| --- | --- |
| API | 読み込み、検索、データベースの問い合わせ、共有の設定。変更の受け付けと検証 |
| Sync Gateway | WebSocket の接続、ページ単位の購読、変更と在席の配信 |
| Relay | outbox を読み、配信のバスと SQS へ送る。物理クラスタごとに群れを持ち、論理シャードごとのリースで分担する（[collaboration.md](collaboration.md) の 7.3 節） |
| Aurora | ブロック・操作の記録・権限の正本。ワークスペースを単位に論理シャードに分ける |
| Worker | 検索の索引、通知、ファイルの処理、Webhook、エクスポート |
| クライアントのローカルの保存 | 開いたページとブロックの写し、未送信の変更の待ち行列（オフライン） |

原則は 3 つ。

- **すべてはブロック。** ページもデータベースの行も、ブロックの一種として同じ仕組みで保存・同期・権限の判定をする（[ADR-0002](../decisions/0002-everything-is-a-block.md)）。
- **ワークスペースで分け、ワークスペースで閉じる。** テナントの境界はワークスペースで、Slack と同じく RLS で分ける。シャードもワークスペースで決め、1 つの操作が 1 つのシャードで閉じるようにする（[ADR-0003](../decisions/0003-workspace-sharding.md)）。
- **権限はページの木を継承する。** ブロックの権限は、祖先のページの設定から決まる。判定の関数を 1 つにし、検索・通知・API・リレーションのすべてが通る（[ADR-0004](../decisions/0004-inherited-page-permissions.md)）。

## 2. 規模の段階

| 段階 | 利用者 | ブロック | 同時接続 | 構成 |
| --- | --- | --- | --- | --- |
| S1（MVP） | 10 万 | 10 億 | 1 万 | 1 リージョン（東京）。Aurora の 1 クラスタに論理シャード 480 を持つ（物理は 1） |
| S2 | 1,000 万 | 1,000 億 | 100 万 | 論理シャードを複数の物理クラスタに分ける。検索と分析を独立したクラスタに |
| S3 | 1 億 | 数千億 | 1,000 万 | 物理クラスタを増やし、データレイクを分析と AI の基盤にする。複数のリージョン |

論理シャードの数（480）は、本家の値に合わせ、S1 から固定する（[Herding elephants](https://www.notion.com/blog/sharding-postgres-at-notion)）。物理の数だけを段階で増やす。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 同時編集の反映 | 入力から、同じページを開いた他の利用者の画面まで p99 500ms 以内（同一リージョン） | |
| NFR-002 | ページの表示 | 1,000 ブロックのページの表示 p75 1.5 秒以内（キャッシュなし）、300ms 以内（ローカルにあるとき） | |
| NFR-003 | データベースの問い合わせ | 1 万行のデータベースのビューの表示 p95 1 秒以内 | |
| NFR-004 | 耐久性 | 受け付けた変更（サーバーが確定したもの）は失わない | |
| NFR-005 | オフライン | オフラインで行った編集は、再接続時にすべて統合される | |
| NFR-006 | 検索への反映 | 編集から 30 秒以内 | |
| NFR-007 | 可用性 | 月間 99.9% | |
| NFR-008 | 復旧（AZ の障害） | RPO 0、RTO 5 分以内 | |
| NFR-009 | 復旧（リージョンの障害） | RPO 15 分以内、RTO 4 時間以内 | |
| NFR-010 | 権限の分離 | 権限のないページの中身が見える事象は 0 件 | |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| 言語 | TypeScript（クライアント・API・Worker） | 他の題材と同じ（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| クライアント | React、ブロックの層は自前、テキストの編集はブロックごとの ProseMirror。ローカルの保存は SQLite（WASM、`opfs-sahpool`） | [ADR-0007](../decisions/0007-block-editor-with-per-block-prosemirror.md)、[ADR-0008](../decisions/0008-sqlite-wasm-opfs-local-store.md) |
| デスクトップ | Electron で Web のクライアントを包む | [ADR-0009](../decisions/0009-electron-desktop-shell.md) |
| 共同編集 | テキストはブロックごとの CRDT（Fugue＋Peritext、自前の実装）。構造とプロパティはサーバーの順序 | [ADR-0010](../decisions/0010-text-crdt-with-server-ordered-structure.md) |
| 検索 | Amazon OpenSearch Service（S1 から） | [ADR-0023](../decisions/0023-search-engine-and-permission-filtering.md) |
| DB | Aurora PostgreSQL 18。論理シャード 480（PostgreSQL のスキーマ）とアプリの中のルーター | [ADR-0027](../decisions/0027-shard-router.md) |
| 配信 | WebSocket の Gateway と、配信のバス（Slack の設計に倣う） | |
| 実行基盤・IaC・可観測性 | AWS、Terraform、OpenTelemetry | 他の題材と同じ |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 基盤は他の題材の決定を引き継ぐ |
| [0002](../decisions/0002-everything-is-a-block.md) | すべてをブロックとして持つ |
| [0003](../decisions/0003-workspace-sharding.md) | ワークスペースで RLS と論理シャードを決める |
| [0004](../decisions/0004-inherited-page-permissions.md) | 権限はページの木を継承し、1 つの判定関数で決める |
| [0005](../decisions/0005-transactions-as-unit-of-change.md) | 変更は操作をまとめたトランザクションで送り、サーバーで順序を確定する |
| [0006](../decisions/0006-rich-text-as-normalized-spans.md) | リッチテキストを、正規化したスパンの配列で持つ |
| [0007](../decisions/0007-block-editor-with-per-block-prosemirror.md) | ブロックの層は自前で作り、ブロックの中のテキストの編集に ProseMirror を使う |
| [0008](../decisions/0008-sqlite-wasm-opfs-local-store.md) | ローカルの保存に SQLite（WASM）と OPFS を使い、書くタブを 1 つに限る |
| [0009](../decisions/0009-electron-desktop-shell.md) | デスクトップアプリを Electron で包む |
| [0010](../decisions/0010-text-crdt-with-server-ordered-structure.md) | テキストはブロックごとの CRDT（Fugue＋Peritext）で統合し、構造とプロパティはサーバーの順序で決める |
| [0011](../decisions/0011-structural-and-property-conflict-rules.md) | 構造とプロパティの衝突は、サーバーの順序と決まった規則で解き、負けた変更を記録して本人に見せる |
| [0012](../decisions/0012-child-order-by-sibling-anchors.md) | 子の並びは前後の兄弟をアンカーにした操作で表し、分数インデックスは使わない |
| [0013](../decisions/0013-offline-availability-policy.md) | オフラインで使うページを理由ごとに記録して決め、Web とデスクトップで SQLite に保存する |
| [0014](../decisions/0014-database-query-index.md) | データベースの問い合わせは、シャードの中の型付きの索引の表で行う |
| [0015](../decisions/0015-formula-evaluation-model.md) | 数式は共通の評価器で解釈し、サーバーの値を正として実体化する |
| [0016](../decisions/0016-relation-edges-as-single-source.md) | リレーションは 1 本の辺を正本にして、両側の値を導く |
| [0017](../decisions/0017-rollups-over-readable-rows-only.md) | ロールアップとリレーションをたどる数式は、見る人が読める行だけで計算する |
| [0018](../decisions/0018-permission-levels-and-inheritance.md) | 権限の水準を本家に合わせ、ACL は設定したページで継承を置き換える |
| [0019](../decisions/0019-workspace-acl-version-cache.md) | 実効権限は、ワークスペースの権限の版（acl_version）をキーにキャッシュし、権限の変更と同じトランザクションで版を上げる |
| [0020](../decisions/0020-published-pages-isolation.md) | 公開ページは別の登録可能ドメインで、専用の描画サービスから配り、既定で検索エンジンに載せない |
| [0021](../decisions/0021-accounts-members-guests-and-teamspaces.md) | アカウントとメンバーを分け、ゲスト・連携もメンバーの行にし、チームスペースを最上位の暗黙の ACL にする |
| [0022](../decisions/0022-trash-history-and-deletion-retention.md) | ゴミ箱は 30 日、完全に削除した後も 30 日戻せ、ページの履歴はプランの日数で消す。バックアップの期限を削除の最終的な期限にする |
| [0023](../decisions/0023-search-engine-and-permission-filtering.md) | 検索は S1 から OpenSearch でページ単位に索引し、権限キーと読み直しの二重で権限を効かせる |
| [0024](../decisions/0024-integration-access-model.md) | 公開 API は本家の形と日付の版に寄せ、連携は明示的に共有されたページだけを読む |
| [0025](../decisions/0025-webhook-delivery.md) | Webhook は中身を含まない署名付きのイベントを、配送の時点の権限で、隔離した egress から送る |
| [0026](../decisions/0026-remote-mcp-server.md) | AI エージェント向けに、利用者の委任で動くリモートの MCP サーバーを提供する |
| [0027](../decisions/0027-shard-router.md) | 論理シャードを PostgreSQL のスキーマで持ち、アプリの中のルーターで物理クラスタへ振り分ける |
| [0028](../decisions/0028-zero-downtime-resharding.md) | 物理クラスタの分割は、論理レプリケーションと影の読み取りで、無停止で行う |
| [0029](../decisions/0029-disaster-recovery.md) | 災害復旧は、物理クラスタごとの Aurora Global Database と大阪のパイロットライトで行う |
| [0030](../decisions/0030-cdc-data-lake.md) | S2 で、変更データの取り込み（CDC）によるデータレイクを S3 に作る（proposed） |
| [0031](../decisions/0031-migration-rollout-by-shard-groups.md) | スキーマの変更は、論理シャードの群れの順に expand / contract で当てる |
| [0032](../decisions/0032-desktop-uses-wasm-sqlite-in-s1.md) | S1 のデスクトップも Web と同じ WASM の SQLite（OPFS）を使い、ネイティブの SQLite は S2 の候補にする（ADR-0013 の一部を置き換える） |

リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前・接頭辞・ドメインを使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

- **権限の漏洩**：判定関数を通らない経路（検索、メンション、同期ブロック、履歴、ロールアップ、API、MCP、公開サイト、通知、Webhook、在席、エクスポート、ローカルの保存）から、読めないページの中身が出る。経路ごとの漏洩の行列と `acl_version` で守る（[permissions-and-sharing.md](permissions-and-sharing.md) の 4.7 節、[quality.md](../quality.md) の 2.2.2 節）。
- **同時編集とオフラインの収束**：自前の CRDT（Fugue＋Peritext）と text slice の正しさ。性質ベーステストで収束を示せないときは、Loro に切り替える（[ADR-0010](../decisions/0010-text-crdt-with-server-ordered-structure.md)）。構造とプロパティの競合では、到着順で古い値が新しい値を上書きしうる（[ADR-0011](../decisions/0011-structural-and-property-conflict-rules.md)）。
- **巨大なページ・データベース**：10 万ブロックのページ、25 万行のデータソースでの表示と問い合わせ。ブロックごとの ProseMirror の生成の費用は E3 の前の PoC で確かめる（[editor.md](editor.md) の 4 節、[databases.md](databases.md) の 12 節、[capacity.md](capacity.md)）。
- **権限の継承の計算**：深い木と多数の共有の設定で判定が重くなる。`acl_version` をワークスペースに 1 つにする方式は、権限の変更が多い大きなワークスペースでヒット率が落ち、S2 で競合しうる（[ADR-0019](../decisions/0019-workspace-acl-version-cache.md)）。
- **端末のローカルの保存**：Safari の追い出しは OPFS にも及ぶ。プライベートブラウズでは、Chrome は開けるがセッションの終わりに消え、Firefox と Safari は開けない（2026-09-27 に文書で確認。[editor.md](editor.md) の 10 節）。実際の挙動と複数タブの調整は、E4 の前の PoC で確かめる（[ADR-0008](../decisions/0008-sqlite-wasm-opfs-local-store.md)）。
- **物理の分割と 480 の論理シャード**：再シャーディングは手順が長く、Aurora の writer のフェイルオーバーで論理レプリケーションのスロットが失われる（2026-09-27 に確認）。`FOR TABLES IN SCHEMA` を `rds_superuser` で使えるかは未検証。巨大なワークスペース 1 つは 1 つの論理シャードに収まる前提（[ADR-0028](../decisions/0028-zero-downtime-resharding.md)、[capacity.md](capacity.md) の 4 節）。
- **公開サイトの濫用**：フィッシング・マルウェアの配布。ドメインの分離と通報・自動の検査で抑えるが、誤検知の許容度は運用で決める（[security.md](security.md) の 8 節）。
- **法務**：削除までの最長 95 日と監査ログのアーカイブの期間、アカウントの削除でのプライベートのページの扱い、公開サイトの取り下げの手続き、漏洩の報告、管理者の内容の検索は、法務の確認待ち（[intent.md](../intent.md) の「法務の確認待ち」L1〜L5）。結論が出るまで、該当する Story（E8 の `data-deletion-worker`・`workspace-and-account-deletion`・`abuse-reporting-and-takedown`・`security-incident-runbook`、E10 の `admin-content-search`）の spec を承認しない。

### 決定（2026-09-26、既定案）

PM の方針（本家 Notion に寄せる、既定案）により、次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に集めた。計測・PoC で決めるものは、下の「持ち越し」に置いた。

- **本家の名前・接頭辞・ドメインを使わない**（リポジトリ共通の ADR-0006）。ヘッダーは `<Brand>-Version`・`X-<Brand>-Signature`、トークンは `<brand>_int_`、ドメインは `app.<domain>`・`api.<domain>`・`mcp.<domain>`・`<brand>.site`・`<brand>usercontent.<domain>`・`<brand>embed.<domain>`、ディープリンクは `<brand>://`。本家の名前は出典の説明にだけ書く。ADR-0024・0025 と api-and-integrations.md の「ADR-0006」を「リポジトリ共通の ADR-0006」と書き分けた（この題材の ADR-0006 はリッチテキスト）。
- ~~**ブロックの表の名前は `block`（単数）**。~~ 2026-09-27 に、テーブル名を複数形に揃え、`blocks` に改めた（下の「決定（2026-09-27）」、[data-model.md](data-model.md)）。
- **データベースの行とブロックの木**：行は `blocks` の行（`type = page`）で、`parent_type = data_source`、`parent_id` がデータソースの ID。行はどの `content` にも並べず、索引の表（`dbx_rows`）で列挙する（ADR-0014）。不変条件 T1・T3 をこの形に合わせた（[block-model.md](block-model.md) の 2・5 節、[databases.md](databases.md) の 2 節）。
- **Relay**：物理クラスタごとに群れを 1 つ持ち、論理シャードごとのリースで担当を分ける（[infrastructure.md](infrastructure.md) の 2 節の形）。S1 は 2 タスク。再シャーディングでリースは移動先の群れへ移る（[collaboration.md](collaboration.md) の 7.3 節）。
- **ページの `seq`** は `page_seqs` の行で採番し、この行のロックでページの書き込みを直列にする（[collaboration.md](collaboration.md) の 7 節）。
- **所有者・管理者もページの権限を迂回しない。** ゴミ箱に出るのは、自分が `can_edit` 以上を持つページだけで、管理者も同じ。読めないページを含むワークスペース単位の削除・復元（ワークスペースの削除、完全に削除したページの復元）は、所有者の依頼と監査ログを伴う運用者の経路で行う。block-model.md の 9 節を改めた。
- **削除の段階**は ADR-0022 のとおり：ゴミ箱 30 日 → 完全に削除（`purged_at`。運用者だけが 30 日戻せる）→ 物理削除 → バックアップ 35 日。block-model.md の 9 節と `blocks` に `purged_at` を足した。
- **閲覧だけの人もコメントを読める**（本家と同じ）。書く・解決する・リアクションはコメント可以上。公開サイトではコメントを描画しない（[comments-and-notifications.md](comments-and-notifications.md) の 2.2 節）。
- **チームスペースの所有者の `full_access` は、ACL で外せない**（ADR-0018）。
- **Web への公開と「リンクを知っている全員」の共有は、S1 では閲覧だけ**（`public` は `can_view` だけ）。ログインしていない閲覧者は、公開サイトのオリジンで見る（ADR-0020）。
- **同期ブロックの元を削除しても、参照を残す。** 参照には「元のブロックが削除されました」を出し、元を戻せば参照も戻る。本家は参照が 10 を超える元を削除すると参照もすべて消え、元に戻しても戻らない。この点は本家と違う（[block-model.md](block-model.md) の 7 節）。
- **親の共有の変更を ACL を持つ子孫にも加える**選択の既定は、外す・下げる変更ではオン、足す・上げる変更ではオフ（[permissions-and-sharing.md](permissions-and-sharing.md) の 11 節）。
- **検索**：ワークスペースの中で検索から隠した共有のページは、開いたことのないメンバーの検索に出さない。本文は 1 MB で切る。最近開いたページの加点はクライアントから渡す（[search.md](search.md) の 12 節）。
- **API**：個人のアクセストークンは MVP に入れない。公開の連携のリフレッシュトークンは 90 日。Webhook の署名は `verification_token` のまま（[api-and-integrations.md](api-and-integrations.md) の 11 節）。
- **エディタとクライアント**：ブロックをまたぐ部分的なテキストの選択は MVP に入れない。デスクトップも MVP は Web と同じ WASM の SQLite（OPFS）を使い、独自の暗号化はしない。埋め込みは許可した提供元だけを直接埋め込む（[editor.md](editor.md) の 17 節、[security.md](security.md) の 11 節）。collaboration.md の 11.2 節の「デスクトップはネイティブの SQLite」と端末の表の名前を、editor.md の 10 節に揃えた。
- **アカウントの削除**：プライベートの領域のページはゴミ箱に入れて通常の削除の段階に流し、所有者への引き継ぎは持たない（[security.md](security.md) の 7・11 節）。
- **数値の正本**：操作のログ（`page_ops`）は 30 日（block-model.md の 7 日を改めた）。1 トランザクションは操作 1,000・500 KB（capacity.md の 1 MB を改めた）。1 ページのブロックは上限 10 万（5 万で警告）、1 データソースの行は上限 25 万。検索は 1 利用者 1 分に 60 回（capacity.md の 30 回を改めた。MCP の `search` は 30 回）。保持期間は [security.md](security.md) の 7 節、上限は [block-model.md](block-model.md) の 10 節と [databases.md](databases.md) の 11 節、SLO は [runbooks/README.md](../runbooks/README.md) の 1 節。
- **監査ログ**：DB に 365 日、アーカイブ 2 年（Slack の ADR-0033 に合わせた）。閲覧の画面・CSV・SIEM は E10。
- **Epic**：E1〜E10 は [roadmap.md](../roadmap.md)。Enterprise の機能（監査ログの閲覧、ゴミ箱の保持期間の変更、管理者の内容の検索）は E10 とし、ADR-0022・security.md・permissions-and-sharing.md の「E9」を改めた。E9 は S2 への拡張。

### 決定（2026-09-27、既定案）

利用者の指示（問いを返さず既定案で決める）により、次のとおり決めた。

- **デスクトップのローカルの保存**：S1 はデスクトップも Web と同じ WASM の SQLite（OPFS）で、実装を 1 つにする。ネイティブの SQLite は S2 の候補にし、計測で決める（[ADR-0032](../decisions/0032-desktop-uses-wasm-sqlite-in-s1.md)。ADR-0013 の「デスクトップはネイティブ」だけを置き換えた）。
- **ゴミ箱のページと検索の索引**：ゴミ箱のページは索引に `in_trash: true` で残し、通常の検索から外し、ゴミ箱の画面の検索からだけ出す（ADR-0022 の注記、[search.md](search.md) の 1・6.1・10 節、[security.md](security.md) の 7 節）。
- **テーブル名は複数形**：多数派に合わせて全テーブルを複数形に揃えた（`block` → `blocks`、`dbx_row` → `dbx_rows` など）。規約と例外は [data-model.md](data-model.md) の冒頭。accepted の ADR には読み替えの注記を付けた。
- **連携・MCP・ジョブの表**：最小の列の定義を置いた（[api-and-integrations.md](api-and-integrations.md) の 12 節、[security.md](security.md) の 6〜8 節、[capacity.md](capacity.md) の 3.5 節）。公開 API のトークンの `{id}` から `workspace_id` を得てシャードへ振り分け、`global` にトークンの索引を持たない。MCP のトークンは `global` の認可サーバーが持つ。
- **検証による設計の修正**：OpenSearch はレプリカ 2 の Multi-AZ with Standby にし、索引の見積もりを約 3.7 TB、コストの概算に OpenSearch を足した（[search.md](search.md) の 9.1 節、[infrastructure.md](infrastructure.md) の 13 節）。デスクトップの更新の署名の検証を OS のコード署名に改めた（[delivery.md](delivery.md) の 6.2 節）。再シャーディングの初期コピーにクローンを使える（ADR-0028 の注記）。Fugue の性質の記述を改めた（ADR-0010 の注記）。

持ち越し（計測・PoC・運用で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| ブロックごとの ProseMirror と仮想化の閾値が NFR-002 に収まるか | E3 の前の `editor-poc`（ADR-0007） |
| OPFS のプライベートブラウズと追い出しの実際の挙動（対応状況・容量・方針は 2026-09-27 に文書で確認。ADR-0008・0013 の注記） | E4 の前の `opfs-poc`（ADR-0008・0013） |
| ~~Electron の自動更新の仕組み~~ | 2026-09-27 に解消。`electron-updater` の `generic` の提供元を使う（[delivery.md](delivery.md) の 6.2 節）。実装は E4 の `desktop-auto-update` |
| 負荷のモデルと台数、1 物理クラスタの上限、`pg_stat_statements.max`、`fillfactor`、検索のデータノード、`routing_partition_size` | E8 の負荷試験（k6）。[capacity.md](capacity.md) と [infrastructure.md](infrastructure.md) を置き換える |
| 確定済みのトランザクションをクライアントが保持し、リージョンの切り替えの後に再送するか | E8 の DR 訓練（[collaboration.md](collaboration.md) の 14 節） |
| 公開サイトの自動の検査の誤検知の許容度 | E8 の `abuse-reporting-and-takedown` の運用 |
| `acl_version` の S2 での競合 | E9 の前の計測（ADR-0019） |
| 再シャーディングの未検証の点（`FOR TABLES IN SCHEMA` と `rds_superuser`、使う版での `aurora_volume_logical_start_lsn()`）。フェイルオーバーでのスロットとクローンからの初期コピーは 2026-09-27 に解消（ADR-0028 の注記） | E9 の `reshard-drill-staging`（ADR-0028） |
| データレイクの形式（Hudi・Iceberg・zero-ETL） | S2 の前の比較（ADR-0030 は proposed のまま） |
| ~~ADR-0013 の「デスクトップはネイティブの SQLite」と、ADR-0008・0009・editor.md の食い違い~~ | 2026-09-27 に解消。S1 はデスクトップも WASM の SQLite、ネイティブの SQLite は S2 の候補として計測で決める（[ADR-0032](../decisions/0032-desktop-uses-wasm-sqlite-in-s1.md)） |
| ~~テーブル名の単数・複数の統一~~ | 2026-09-27 に解消。複数形に揃えた（[data-model.md](data-model.md) の冒頭の規約） |
| 本家の振る舞いで未検証のもの（購読の既定、ゴミ箱へ入れる水準、子で変えた後の親の変更など。2026-09-27 に公式の文書で確かめられなかったもの） | 各 Epic の Story で本家を観察して揃える |

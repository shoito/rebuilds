# Design log: Notion

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-26：既定案

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

## 2026-09-27：既定案

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
| OpenSearch の単価（コストの概算の 4,500 USD は据え置く） | E8 の `load-test-k6` で確かめる（[infrastructure.md](infrastructure.md) の 13 節） |
| 確定済みのトランザクションをクライアントが保持し、リージョンの切り替えの後に再送するか | E8 の DR 訓練（[collaboration.md](collaboration.md) の 14 節） |
| 公開サイトの自動の検査の誤検知の許容度 | E8 の `abuse-reporting-and-takedown` の運用 |
| `acl_version` の S2 での競合 | E9 の前の計測（ADR-0019） |
| 再シャーディングの未検証の点（`FOR TABLES IN SCHEMA` と `rds_superuser`、使うバージョンでの `aurora_volume_logical_start_lsn()`）。フェイルオーバーでのスロットとクローンからの初期コピーは 2026-09-27 に解消（ADR-0028 の注記） | E9 の `reshard-drill-staging`（ADR-0028） |
| データレイクの形式（Hudi・Iceberg・zero-ETL） | S2 の前の比較（ADR-0030 は proposed のまま） |
| ~~ADR-0013 の「デスクトップはネイティブの SQLite」と、ADR-0008・0009・editor.md の食い違い~~ | 2026-09-27 に解消。S1 はデスクトップも WASM の SQLite、ネイティブの SQLite は S2 の候補として計測で決める（[ADR-0032](../decisions/0032-desktop-uses-wasm-sqlite-in-s1.md)） |
| ~~テーブル名の単数・複数の統一~~ | 2026-09-27 に解消。複数形に揃えた（[data-model.md](data-model.md) の冒頭の規約） |
| 本家の振る舞いで未検証のもの（購読の既定、ゴミ箱へ入れる水準、子で変えた後の親の変更など。2026-09-27 に公式の文書で確かめられなかったもの） | 各 Epic の Story で本家を観察して揃える |

## 2026-09-28：推奨案で確定

利用者の指示（判断が要るところは推奨案で決める）により、次のとおり決めた。法務の判断が要るもの（[intent.md](../intent.md) の L1〜L5）と、それに依存するものは決めていない。計測・PoC で決めるものは、上の「持ち越し」のまま残した。

- **デスクトップは S1 で WASM の SQLite**：ADR-0032 を承認済みとする。実装を 1 つにし、ネイティブの SQLite は S2 の前に計測で決める（[ADR-0032](../decisions/0032-desktop-uses-wasm-sqlite-in-s1.md)）。
- **無効化したメンバーのページの移し替え**：E10（Enterprise）で、所有者が別のメンバーへ移せるようにする。本家に揃え、退職者の記録を組織に残すため。所有者は中身を読まず、無効化から 30 日以内に限り、監査ログに残す。アカウントの削除では移さない決定は変えず、その扱いと保持は法務の確認待ち（L1・L2）のまま（[ADR-0033](../decisions/0033-transfer-private-pages-of-deactivated-members.md)、[permissions-and-sharing.md](permissions-and-sharing.md) の 2.2・11 節、[security.md](security.md) の 7・11 節）。
- **公開 API のトークンの `{id}` に `workspace_id` を埋め込む**：`global` に索引を持たずにシャードへ振り分けられるため（[api-and-integrations.md](api-and-integrations.md) の 3.1・11 節）。
- **リンクの閲覧者への編集・コメントの許可は S1 に入れない**：公開の経路を閲覧だけに絞り、濫用と権限の面を小さくするため。本家との差異として記録した（[permissions-and-sharing.md](permissions-and-sharing.md) の 7・11 節）。
- **ブロックをまたぐ部分的な選択は S1 に入れない**：ブロックごとの ProseMirror（ADR-0007）の上では作る費用が大きいため。本家との差異として記録した（[editor.md](editor.md) の 3.1・17 節）。
- **制限付きメンバーのロール**：MVP の後、E10 で `restricted_member` を足す。本家の Enterprise の運用に揃えるため（[permissions-and-sharing.md](permissions-and-sharing.md) の 2.2 節、[ADR-0021](../decisions/0021-accounts-members-guests-and-teamspaces.md) の注記、[roadmap.md](../roadmap.md) の E10）。
- **データソースのスキーマの上限（API）**：50KB を推奨の上限として文書に書き、1.5MB を超える更新だけを拒む。本家の API の文書の推奨に合わせ、画面と API で拒む基準を 1 つにするため（[databases.md](databases.md) の 11 節、[api-and-integrations.md](api-and-integrations.md) の 11 節）。
- **OpenSearch の単価**：概算（月 4,500 USD）は据え置き、E8 の `load-test-k6` で確かめる。台数と同じ試験で決めるのが確実なため（[infrastructure.md](infrastructure.md) の 13 節、[roadmap.md](../roadmap.md) の E8）。
- **本家の実装を核に使っていないことを確かめた**（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）：ブロックの層・CRDT（Fugue＋Peritext）・権限の判定・データベースの問い合わせ・数式の評価器・シャードのルーターは自前で作る。ProseMirror・SQLite（WASM）・Electron・OpenSearch・Aurora は本家と関係のない第三者の部品である。公開 API は本家の形に寄せるが、プロトコルの互換であり、本家の SDK や MCP サーバーの実装は使わない。直すところはなかった。

## 2026-09-28：データモデル

利用者の指示（データモデルを十分に設計し、ER 図を付ける。判断が要るところは推奨案で決める）により、[data-model.md](data-model.md) をデータモデルの正にし、領域ごとの定義を [data-model/](data-model/) に分けた。食い違いと抜けを、次のとおり決めた。ADR の決定は変えていない。

- **プライベートの領域の親**：最上位のプライベートのページを `parent_type = member`、`parent_id = 持ち主の member_id` にした。`workspace` の親では持ち主が決まらず、暗黙の ACL（ADR-0021）と移し替え（ADR-0033）を表せないため。T3 の終点を `teamspace` / `member` に改めた（[block-model.md](block-model.md) の 2・5 節）。
- **ワークスペースをまたぐ走査**：リマインダー・メールの送信待ち・Webhook の再試行・削除のジョブ・通報を期限で拾うため、DB ロール `sweeper` を足した。対象の表にだけ全行を読むポリシーを付け、中身の処理は拾った `workspace_id` でルーターを通して行う（[data-model.md](data-model.md) の 1.4 節）。
- **所属の目録**：ワークスペースの切り替えの一覧のため、`global.account_workspaces` を `members` の写しとして持ち、outbox の `member.changed` から更新する。認可には使わない。
- **`global` に足した表**：`site_subdomains`（公開サイトのホスト名の解決）、`plans`、`oauth_authorization_codes`、`mcp_tokens`、`account_notification_settings`、`push_subscriptions`、`email_suppressions`、`platform_audit_events`（ワークスペースに属さない監査。Slack と同じ）。
- **シャードに足した表**：`favorites`、`invitations`（トークンに `workspace_id` を埋め、`global` に索引を持たない）、`workspace_settings`、`dbx_view_orders`。クライアントに `recent_pages`。
- **ビューの手動の並び**：databases.md の「分数の索引」を ADR-0012 の形に揃え、アンカーの操作からサーバーが鍵を振る。
- **`relation_edges.from_data_source_id`**：プロパティ ID はデータソースの中でだけ一意なので足した。
- **パーティション**：`page_ops` は週、`outbox` は日、`inbox_items`・監査は月。パーティションの表の主キーは鍵を含め、`(page_id, seq)` の一意は `page_seqs` の採番で保証する。
- **Relay のリース**：物理クラスタごとのスキーマ `cluster_local.relay_leases` に置き、送り終えた `outbox.id` を持たせた。
- **公開の連携の主体のキー**：`bot:{installation_id}`。再インストールで古い共有が生き返らないため。
- **Valkey**：クエリの結果（`query_id`、15 分）を `ws:{w}:q:{query_id}` に置く。行の変更は、データソースを置いたページのチャンネルにも送り、ビューの購読を兼ねる。メールの判定のための最後の操作の時刻 `ws:{w}:ma:{member_id}` を足した。
- **SQS**：`db-recompute`（ロールアップ・行をまたぐ数式）と `directory-sync` を足した（[capacity.md](capacity.md) の 2.6 節）。
- **S3**：スナップショットのキーを `ws/{workspace_id}/...` に揃えた（ワークスペース単位の削除と移動のため）。
- **名前**：`page_seq`・`page_activity`・`block_text_state` の単数の表記、クライアントの `records` のキーの `table`（SQL の予約語）を `record_type` に直した。

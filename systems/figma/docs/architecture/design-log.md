# Design log: Figma

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-27：既定案

PM の方針（本家に寄せる、既定案で進める）により、統合の工程で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」（L1〜L6）に残した。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md を、他の題材と同じく `accepted` にした。先に次を直した。
  - ADR-0002：ノードの ID の名前を ADR-0007 の `(session_id, local_id)` に揃え、鍵の振り直しの長さを ADR-0010（48 バイトで振り直し、上限 64 バイト）に揃えた。
  - ADR-0003：ジャーナルの書き込みの条件にフェンスの `epoch` を足し（ADR-0024）、TTL を「書いた時点から 30 日＋回復のジョブ」（ADR-0024・0047）にし、世代のキー（ADR-0048）を足した。
  - ADR-0004：wgpu#6166 は #6371 で解決、Vello GPU は WebGL2 に対応したが panic と wgpu の外の経路のため採らない、rustybuzz はアーカイブされ HarfRust を使う、サーバーの描画は Fargate に GPU がないので CPU（lavapipe）だけ、起動は WebGPU で始め WebGL2 に戻る（ADR-0014 と本家の記事）。
  - ADR-0005：ファイルごとのリースの延長を、ADR-0047 のタスクの生存＋ファイルの割り当てに置き換え、書き込みの条件にフェンスを足した。
  - 本題材の AGENTS.md のジャーナルの規則にフェンスを足した。
- **読み込みの経路**：チャンクは CloudFront から読み、Document Server は計画と tail だけを送る（ADR-0025。[README.md](README.md) の 2.2 節を直した）。
- **`derived_layout`**：画面はいつも手元の計算。保存された値を書くのは入力を変えた本人と修復の担当。サーバーは型と範囲だけを検証する。`derived` のプロパティは Undo の項目に入れない（ADR-0019、ADR-0012 の注記。document-model.md の 4.4・9.2 節、multiplayer.md の 10 節を直した）。Render Worker は保存されないインスタンスの中身だけを計算する（export-and-assets.md の 5.2 節を直した）。
- **メモリ**：10 万ノードの `Doc` は 200 MiB（document-model.md の 10 節を正とし、rendering-engine.md の 11 節の単位を揃えた）。
- **CDN の署名**：署名はキャッシュの鍵に含めない。署名付き URL は取得を許すもので、キャッシュのオブジェクトは中身のハッシュで名付け、パスに組織（`images/{org_id}/…`）かファイル（`files/{file_id}/…`）を含むので、組織をまたいで共有されない（permissions-and-sharing.md の 11 節を直した）。
- **S3 の削除**：削除とライフサイクルは大阪へ複製されないので、完全な削除・掃除・画像の mark-and-sweep を東京と大阪の両方で行う（ADR-0045。file-storage-and-history.md の 11.2 節、export-and-assets.md の 6.5 節を直した）。
- **バージョンの照合**：`schema_hash` の不一致で再読み込みにする規則を、ADR-0053 の 3 つのバージョンの照合に置き換えた（document-model.md の 8.4 節、multiplayer.md の 4.3 節）。
- **キーの世代**：ジャーナルの `{file_id}#g{n}` とマニフェストの `checkpoints/g{n}/` を file-storage-and-history.md の 4.1・5 節に足した。取り戻したバージョンは `salvage/g{n}/` に置く（[data-model.md](data-model.md) の 9.2 節）。
- **領域の間の提案**：`thumbnail_node`、`cjk_fallback_font`、レイアウトのプロパティ、`component_prop_values` などのコンポーネントのプロパティ、表の列 `public_api`・`api_name`・`api_since`・`public_plugin`、`ChangeSet` の `origin`、マニフェストの `features`、`Hello.protocol_version`、再接続の最初の 0〜5 秒の乱数の待ち、`file_versions.kind = dr_salvaged`、ファイルの `maintenance` の状態を取り込んだ（data-model.md の 9.2 節、[data-model/document.md](data-model/document.md)）。
- **呼び名**：本家は 2026-08-03 から「プロジェクト」を「フォルダー」に改名している。本システムは「プロジェクト」のまま進め、表とコードも `project` にする。画面の呼び名は下の「決定（2026-09-27、推奨案で確定）」で決めた（permissions-and-sharing.md の 15 節）。
- **Epic**：E1〜E12 が MVP、E13 ライブラリ、E14 プラグイン、E15 公開 API と Webhook。それ以外の MVP の後の機能は [roadmap.md](../roadmap.md) の延期の一覧。領域の文書の仮の Epic の番号を roadmap.md に揃えた（rendering-engine.md と editor-and-tools.md の E8・E9 の入れ替わり、「後」「後-P」「後-A」の置き換え）。組織の SAML SSO は ADR-0043 のとおり E12 に作るが、MVP の範囲の外で GA の判定に含めない。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。上限（ファイル・ノード）は document-model.md の 11 節、送受信の上限は multiplayer.md の 4.6 節、メモリの予算は rendering-engine.md の 11 節、容量のパラメーターは capacity.md の 10 節、保持の期間は security.md の 7 節。
- 領域ごとの決定は、各文書の「決定（2026-09-27、既定案）」の節にある。
- **仕上げの工程（2026-09-27）**：公式の資料で「未検証」を確かめ直し、統合の後に残った食い違いを直した。
  - 再接続の殺到：持ち主が変わらない再接続は、Gateway が出す 60 秒・1 回だけの再開のトークン（`session_id`・`file_id`・割り当ての `epoch` に束ねる）で入り、API のチケットを通らない（[permissions-and-sharing.md](permissions-and-sharing.md) の 5.5 節、ADR-0030 の注記）。
  - `files.team_id` の書き換え：ファイル・プロジェクトの移動と同じトランザクションで書き、`acl_version` を上げる（permissions-and-sharing.md の 9.3 節）。
  - 回復のジョブの割り当ての名前を `recover_then_release` に揃えた（ADR-0047、[infrastructure.md](infrastructure.md) の 5.1 節、[observability.md](observability.md)）。`ds-large` の閾値は ADR-0051 の見積もり 1.5 GiB を正とした（圧縮の前のチェックポイントでおよそ 500 MB）。ADR-0024・0026・0046 の「リース」を、タスクの生存とファイルの割り当てに直した。ADR-0034 に、Render Worker がインスタンスの中のレイアウトを計算することを書いた。
  - 資料で確かめて設計を変えたもの：ブレンドモードを 18 種に（本家の `LINEAR_BURN`・`LINEAR_DODGE`。[rendering-engine.md](rendering-engine.md) の 8.3 節）、`strokes_included_in_layout` の既定を true に（[layout.md](layout.md) の 2 節）、Render Worker の子のプロセスの通信の遮断を seccomp だけに（Fargate は `CAP_SYS_ADMIN` を与えない。[export-and-assets.md](export-and-assets.md) の 5.3 節）、CloudFront の WebSocket の経路で Gateway も 20 秒ごとに送る（[infrastructure.md](infrastructure.md) の 4 節）、Fargate の退役は保護を待たない前提に、署名の要る CDN の経路は `GET`・`HEAD` だけに（export-and-assets.md の 6.4 節）、DynamoDB の費用に TTL の削除の大阪への複製を足した（[capacity.md](capacity.md) の 4.3 節）。

持ち越し（計測・PoC で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| DynamoDB のトランザクションの書き込みの p99（40ms の予算）、フェンスの `ConditionCheck` の単位の種類 | E3 の前の PoC |
| 1 つのビルドでの WebGPU と WebGL2 の切り替え、WASM の大きさ、wgpu の WebGL2 の経路での R16F の加算のブレンド | E2 の前の `gpu-backend-poc`（ADR-0014） |
| HAMT をクライアントでも使うか、10 万ノードの `Doc` のメモリ | E2 の前の PoC |
| `textarea` の見えなくし方、ブラウザ・IME ごとのイベントの順序 | E4 の前の PoC（ADR-0017） |
| レイアウトの全体の計算の時間（10 万ノードで 300 ms）、本家との細部の一致 | E5 の前の計測、E5 で 50 の場面を比べる |
| 見積もりの係数（メモリ＝圧縮の前のチェックポイント × 3）、ファイルの大きさの分布 | E7 の計測、試用の期間 |
| lavapipe での書き出しの時間 | E10 の `render-worker-core` の PoC |
| CloudFront の署名とキャッシュの振る舞い | 資料で確かめた（[export-and-assets.md](export-and-assets.md) の 6.4 節）。`image-sign-endpoint` の結合テストで実際の配信でも確かめる |
| CloudFront の応答の期限が WebSocket に効くか、接続の長さの上限 | E3 の `gateway-edge-websocket` の PoC（8 時間）。Fargate の退役は保護を待たない前提にした（資料は保護の対象を縮小とデプロイに限る。[infrastructure.md](infrastructure.md) の 3 節） |
| RTO の内訳、障害中にグローバルテーブルから東京のレプリカを外せるか | E12 の DR の訓練 |
| 費用の単価 | E12 の前に、AWS の料金の計算ツールで置き換える |
| 参照画像のテストの許容の値 | E2 で端末ごとの差を測って決め直す（[rendering-engine.md](rendering-engine.md) の 16.1 節） |

## 2026-09-27：推奨案で確定

PM の方針（「判断が要るところは推奨案でよい」）により、ロールの決定・確認を待っていた項目を、推奨案で確定した。各文書と ADR の「待ち」の書き方を消し、決定として書き直した。ADR を覆した直しには、日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。法務の項目と、法務の結論に依る項目は決めていない（下の「残したもの」）。

| 決定 | 理由 | 文書 |
| --- | --- | --- |
| チームの可視性・参加・一般アクセスは、チームの中身に引き継がない。open のチームへの参加で見えるのはチームだけ。一般アクセスはプロジェクトとファイルにだけ置く | 本家は audience access を中身に引き継がない。本家に寄せる方針に合わせる | [permissions-and-sharing.md](permissions-and-sharing.md) の 3.3・4.3・13・15 節、[ADR-0029](../decisions/0029-hierarchy-roles-seats-and-link-access.md)、[search.md](search.md) の 3.3 節、[ADR-0032](../decisions/0032-name-search-in-aurora.md)、[quality.md](../quality.md) |
| ブレンドモードは 18 種 | 本家の一覧（`LINEAR_BURN`・`LINEAR_DODGE` を含む）に合わせる | [rendering-engine.md](rendering-engine.md) の 8.3 節 |
| `strokes_included_in_layout` の既定は true | 本家が内側の線を既定でレイアウトに含める | [layout.md](layout.md) の 2 節 |
| Gateway の再開のトークンの設計を承認 | 再接続の殺到で API のチケットの発行が律速になるのを避ける | [permissions-and-sharing.md](permissions-and-sharing.md) の 5.5 節、[ADR-0030](../decisions/0030-single-policy-engine-and-signed-capabilities.md) |
| 匿名の閲覧者にコメントを見せない | 「リンクを知っている全員」のファイルで、社内のやり取りを外に出さない | [comments-and-notifications.md](comments-and-notifications.md) の 10 節 |
| アプリで読んだコメントは、メールのまとめから除く | メールの数を減らす | 同上 |
| 無料のプランのバージョンの履歴は 30 日。過ぎたバージョンは消す | 本家の Starter と同じ | [intent.md](../intent.md)、[file-storage-and-history.md](file-storage-and-history.md) の 8.4 節、[ADR-0026](../decisions/0026-version-history-restore-and-deletion.md) |
| 画面の呼び名は、S1 は「プロジェクト」のまま。利用者の調査で混乱が見えたら見直す | 表とコードの名前と揃い、改名の費用がかからない | [permissions-and-sharing.md](permissions-and-sharing.md) の 15 節、[intent.md](../intent.md) |
| NFR-004 を CPU の側 1.5 GB と GPU の側 720 MB に分ける | GPU のメモリがタブのメモリに数えられるかは、ブラウザと OS で違う | [README.md](README.md) の 4 節、[quality.md](../quality.md) の 2.2 節、[rendering-engine.md](rendering-engine.md) の 11 節、[observability.md](observability.md) |
| 書き込みの予算の段に入ったファイルは NFR-001 の対象の外にし、反映の p99 1 秒を別に見る | 予算の段は、わざと反映を遅らせて編集を続ける仕組みだから | [README.md](README.md) の 4 節、[ADR-0052](../decisions/0052-journal-throughput-and-hot-file-budget.md)、[capacity.md](capacity.md) |
| 参照の端末は 3 台（標準 2・下限 1） | Windows と Mac の標準の端末と、WebGL2 だけの下限で NFR を判定する | [quality.md](../quality.md) の 2.4 節 |
| E7 を出す合格は、作り直しの影の検証の連続 10 万回の一致 | 本家の段階的な出し方に倣い、確定の損失を出す前に見つける | [quality.md](../quality.md) の 2.2.1 節 |
| インスタンスの中で、大きさの方式（hug・fill・fixed）を上書きできる | 拒否すると、オートレイアウトのインスタンスの使い勝手が大きく落ちる | [components-and-libraries.md](components-and-libraries.md) の 3.4・11 節、[layout.md](layout.md) の 16 節 |
| 絶対配置の子の制約は、利用者が親の大きさを変えたときだけ当てる。端末のフォントのノードの食い違いは、次にそのテキストを編集した人が直す | 今の振る舞いのままで、収束の規則を増やさない | [layout.md](layout.md) の 16 節 |
| 在席の `selection` は、MVP は `NodeId` だけ。導出したノードはインスタンスの `NodeId` で送る | 送受信の形式を変えない | [editor-and-tools.md](editor-and-tools.md) の 19 節 |
| セッションはアイドル 14 日・最長 30 日。匿名のセッションは 24 時間で、匿名の人数は 1 ファイルの参加の上限（500 人）の中で数える | 別の上限を足さず、既存の上限で抑える | [security.md](security.md) の 4・13 節 |
| プランを上げる前の監査ログは、組織の管理者に見せない | 本家と同じ | [security.md](security.md) の 13 節、[ADR-0045](../decisions/0045-audit-log-and-data-lifecycle.md) |
| 1 組織の画像の合計に、MVP では上限を置かない。合計を計測する | 1 枚の上限とファイルの大きさの上限で足りる。容量は料金の設計（MVP の後）で決める | [export-and-assets.md](export-and-assets.md) の 6.1・15 節 |
| 有料のプラグインは扱わない | 決済の仕組みが要り、範囲の外 | [plugins.md](plugins.md) の 15 節 |
| MCP のサーバーは出さない | intent は AI の生成を範囲の外にする。出すなら別の ADR | [api-and-webhooks.md](api-and-webhooks.md) の 13 節 |
| GPU 付きの VM の CI は、AWS の GPU のインスタンスをジョブごとに立てる自前の runner | GPU の種類を固定でき、計測の揺れを抑えやすい | [delivery.md](delivery.md) の 10 節、[ADR-0054](../decisions/0054-wasm-native-parity-and-bundle-budgets.md) |
| 端末のキャッシュは暗号化せず、組織の方針で止められるようにする。組織ごとの KMS の鍵は MVP で持たない | security.md と ADR-0044 の決定に揃え、file-storage-and-history.md の持ち越しから外した | [file-storage-and-history.md](file-storage-and-history.md) の 16 節、[ADR-0044](../decisions/0044-encryption-keys-and-client-cache.md) |

残したもの：

- 法務の確認待ち（[intent.md](../intent.md) の L1〜L6）と、その結論に依る項目：フォントの配布と埋め込み（L1）、権利侵害の申し立て（L2）、公開のリンクの扱い（L3）、削除とバックアップの期間・監査のアーカイブの 7 年（L4）、漏洩の報告（L5）、本家の UI・ショートカットへの寄せ方（L6）、クライアントの計測の利用規約への書き方。
- 計測・PoC で決めるもの（上の「持ち越し」の表と、各文書の「持ち越し」）。参照画像の許容の値は、E2 で決め直す。
- 利用者の声や将来の条件で見直すもの（未確定の変更の IndexedDB への保存、Undo の履歴のタブをまたぐ保存、500 人を超えるファイル、ShadowRealm など）。どれも今の決定があり、見直しの条件だけを書いている。

## 2026-09-28：データモデルの設計

データモデルを [data-model.md](data-model.md) と [data-model/](data-model/identity.md) の下に、ER 図つきの正本としてまとめた。ADR は変えていない。PM の方針（推奨案でよい）で、次を決めた。一覧と理由は data-model.md の 9.1 節（D-1〜D-23）。

- 形（表・列・キー・プロパティの番号）は data-model を正とし、振る舞いは領域の文書を正とする。
- トークンとグラント（`api_tokens`・`oauth_grants`）は `global` に置く。アカウントに属し、組織が決まる前に引くため（[api-and-webhooks.md](api-and-webhooks.md) の 14 節を直した）。
- `files.file_key` は組織をまたいで一意にし、`resolve_file_key` の関数で組織の文脈を決める。
- `file_leases` に `org_id` を持たせ、Document Server と回復のジョブが Aurora の文脈を得る（[infrastructure.md](infrastructure.md) の 5.1・5.2 節を直した）。
- ファイルの所有者は `files.owner_account_id` だけで表す（[permissions-and-sharing.md](permissions-and-sharing.md) の 4.3 節の計算を直した）。
- プロパティの番号の重なり（12・41）を分け、43〜46 を振った。69 `library_source` を予約した（[document-model.md](document-model.md) の 4.2 節を直した）。`NodeType` の値を振った。
- `outbox`・`global_outbox` と Relay、制御の出来事の Valkey のチャンネル（`ctl:*`）を置いた。
- 確認済みのドメインを `org_domains` にした（[security.md](security.md) の 14 節を直した）。

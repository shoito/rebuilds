# Design log: Dropbox

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-10-09：既定案

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも E1〜E13 の PoC・試験で覆りうる。その後の領域の工程と統合の工程での変更は、下の「統合」の節にある。

- **分割**：内容で区切る（ギアのハッシュの分割、最小 1 MiB・平均 4 MiB・最大 16 MiB）。固定の 4 MiB より実装は増えるが、途中への挿入・削除のある大きなファイル（動画の編集の素材、仮想のディスク、データベースのファイル）で送る量が減る（[ADR-0002](../decisions/0002-chunking-and-block-addressing.md)）。
- **重複排除**：テナントの中だけ。テナントをまたぐと、保存の量は減るが、他人のファイルの有無が漏れる（[ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)）。
- **ファイルの上限**：2 TiB（本家と同じ）。
- **LAN 同期**：MVP では持たない。端末どうしの認証と鍵、チームのネットワークの方針、File Provider との両立を設計する必要があり、まずサーバーとの同期の正しさを確かめる。E14 で扱う（本家は macOS の File Provider 版で使えないとしている。[LAN sync overview](https://help.dropbox.com/sync/lan-sync-overview)、2026-10-09 に確認）。
- **検索の範囲**：MVP は名前（すべてのプラン）と本文（チームのプラン：テキスト、PDF の文字の層、Office の文書）。画像と走査した PDF の日本語の OCR は E15 へ延ばす。精度と費用を測ってから決める（search の領域で ADR にする）。
- **オンラインのみのファイル**：macOS は File Provider（replicated の拡張）、Windows は Cloud Files API に従う。カーネルの拡張は作らない。既定は「新しい端末ではオンラインのみ」で、利用者が「オフラインで使う」を選ぶ（file-system-integration の領域で ADR にする）。
- **選択型の同期**：フォルダーの単位で手元に置かないことを選べる。オンラインのみのファイルと両立し、手元に置かないフォルダーは木にも出さない（sync-engine の領域）。
- **競合のコピーの名前**：`<名前> (<端末の名前> の競合コピー <YYYY-MM-DD>).<拡張子>`。英語の設定では `<name> (conflicted copy from <device> <YYYY-MM-DD>).<ext>`。本家は利用者の名前を入れるが、本システムは端末の名前を入れる（同じ人の 2 台の衝突が多いため）。文言は法務の L10 の後に確定する（[ADR-0006](../decisions/0006-sync-conflict-model.md)）。
- **共有リンク**：閲覧だけ（編集のリンクは持たない）。パスワード・期限・ダウンロードの禁止は有料のプラン（本家の可否のプランは [Link expiration and passwords](https://help.dropbox.com/share/link-expiration) で確かめた。2026-10-09）。チームの方針で「チームの中だけ」「パスワードを必須」を強制できる（shared-links の領域）。
- **バージョンの保持の期間**：本家と同じ区分の既定（無料・個人の有料 30 日、チームの標準 180 日、チームの上位 365 日）。約束の文言は法務の L6・L8 の後（versions-and-recovery の領域）。
- **カメラのアップロード**：写真のライブラリの新しい項目を、OS の写真の ID と内容のハッシュで重ねずに上げる。元の形式（HEIC など）のまま上げ、変換はプレビューだけで行う（mobile-and-camera-upload の領域）。
- **端末への合図**：WebSocket で「名前空間の番号が進んだ」だけを送る。WebSocket が使えない環境では 60 秒ごとの確かめと long-poll に落とす（api-and-webhooks の領域）。
- **暗号化**：S3 は SSE-KMS とバケットキー。顧客の鍵（BYOK）とエンドツーエンドの暗号化は MVP の後（E16）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。

## 2026-10-09：統合

領域の文書の間の食い違いを、統合の工程で次のとおり解いた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。最初の設計の ADR は直接直し、決定を覆したところに日付付きの注記を残した（[process.md](../../../../docs/process.md) の 9 節）。

- **削除の条件**：ファイルの削除は `base_rev` と `base_node_ver`、フォルダーの削除は `base_node_ver` と `base_seq`（その後に子孫が変われば 409 `subtree_changed`）。[ADR-0006](../decisions/0006-sync-conflict-model.md) を [ADR-0021](../decisions/0021-committer-operations-and-conditions.md) に揃えた。
- **ジャーナル**（[ADR-0005](../decisions/0005-namespace-journal-and-cursors.md) の注記）：
  - `op` に利用者に返さない `purge` を足した。
  - 列に `node_ver`・`deleted_reason`・`moved_to_ns`・`moved_to_seq`・`moved_from_ns`・`subtree_listing`・`batch_id`・`job_id` を足した。
  - `epoch` は全体の 1 つの値（`platform_state`）で、DR の切り替えと運用者の DB の時点への戻しでだけ上げる。利用者の復元と巻き戻しでは上げない。
  - 保持は、カーソルの最後の利用から 90 日と、日の分割の 92 日。`floor_seq` は特別な場合（テナントの削除、名前空間の作り直し、手での修復）だけに上げる。
- **macOS の手元の変化**：File Provider の拡張の呼び出しだけを使い、FSEvents は使わない（[ADR-0015](../decisions/0015-local-change-observation-and-move-detection.md)）。1.3 節 A、[intent.md](../intent.md)、[roadmap.md](../roadmap.md)（`fs-watcher-macos` を `fs-observer-macos` に）を直した。
- **commit が受けるブロック**：索引で `live` なだけでは受けず、`have`・`copy`・`granted` のどれかに限る。ハッシュを知るだけで他人の中身を得る穴を塞ぐ（[ADR-0018](../decisions/0018-upload-sessions-and-block-grants.md)。[ADR-0007](../decisions/0007-block-storage-layout-on-s3.md) の注記）。
- **プレビューの隔離**：サムネイルの p95 2 秒と隔離の意図を両方満たす 1 つの形にした（[ADR-0032](../decisions/0032-sandboxed-preview-pipeline.md)・[ADR-0047](../decisions/0047-accounts-network-ingress-and-service-placement.md) の注記、[security.md](security.md) の 3.4 節、[infrastructure.md](infrastructure.md) の 2.1 節）。
  - タスクの SQS の権限は、自分のジョブの待ち行列の受信・削除・見えない時間の変更と、結果の待ち行列 `sandbox-results` への送信だけ。S3・DB・KMS の権限は持たない。
  - タスクは 50 ジョブか 10 分で入れ替える。新しいタスクが受け始めてから古いタスクを止め、20% の余裕の台数を持つ。
  - 出力の検査と作り直しは sandbox の中の監督が行う。オーケストレーターは大きさ・種類・SHA-256 だけを確かめる。
- **ハッシュの照合を逃れる申告**：違法なコンテンツのハッシュの照合は、クライアントの申告の `content_sha256` を使わない。`content-scanner` が sandbox の中で検証済みのブロックをつないで計算した `verified_sha256` を使う。申告と違えば `integrity_mismatch` にし、範囲に入る経路では検査の前に配らない（[ADR-0046](../decisions/0046-content-scanning-framework.md) の注記）。範囲（L1・L2）は法務の確認待ちのまま。
- **マウントのノード**：`nodes.kind`（`file`・`folder`・`mount`）と `mount_ns_id` を、[metadata-and-journal.md](metadata-and-journal.md) のデータモデルに足した（[ADR-0024](../decisions/0024-shared-folder-mounts-and-grants.md)）。
- **`incoming` のキー**：`u/<upload_id>/<n>` のまま、`upload_id` を 128 ビットの乱数にして接頭辞の偏りを避ける（[ADR-0007](../decisions/0007-block-storage-layout-on-s3.md)、[capacity.md](capacity.md) の 4.1 節、[block-storage.md](block-storage.md) の 4.2 節）。
- **サーバーで組み立てるダウンロード**：フォルダーの ZIP（E7 の `web-download`、共有リンク）と 1 つの URL のダウンロードは、Worker の `export-builder` が S3 から S3 の `exports` へ組み立て、`content.<brand>usercontent.<domain>/x/...` の署名つき URL で返す。10,000 ファイル・20 GiB まで。要求を受けるサービスは中身を通さない（[ADR-0054](../decisions/0054-server-assembled-downloads.md)。[ADR-0001](../decisions/0001-platform-and-stack.md)・[ADR-0038](../decisions/0038-public-api-shape-and-change-feeds.md) の注記）。
- **DR の後の取り直し**：「失った commit を見た端末だけ」に絞る改良は採らず、テックリードの判断に残した。失った commit を自分で確定した端末は、カーソルの位置が切り替えの番号以下でも Synced を失った `rev` へ進めており、取り直しをしないと手元の中身を古い中身で置き換えうるため（[capacity.md](capacity.md) の 3.3 節）。それまでは全端末の取り直しを 2 時間の窓に散らす（[ADR-0051](../decisions/0051-load-shaping-uploads-signals-and-reconnects.md)）。
- **本家との意図した違い**：1.4 節に、共有リンクの `members`、Webhook 専用の秘密、Webhook の 24 時間の再試行、すべてのアプリの PKCE、サポートの外の OS での読み出しだけ、巻き戻しのプラン、管理者のアクセスの形（法務の L7 の確認待ち）を足した。
- **署名つき URL の期限**：PUT の 15 分がモバイルの背景の送信に足りるかは持ち越し（`mobile-background-upload-poc`。[ADR-0007](../decisions/0007-block-storage-layout-on-s3.md) の 1 の手順）。
- **費用と規模**：S1 の前提（アカウント 50 万、物理 13 PB、配信 3.9 PB/月）は README・capacity・infrastructure・ADR で同じ。本番の月の費用は約 79 万 USD で、保存と配信が 89%。保存の約 32 USD/TB は 2.1 節の仮の予算（30〜45 USD）の中にある（2.1 節に書き足した）。CRR の RTC の SLA は転送の既定の割り当て 1 Gbps を超える間は当たらないので、引き上げを E1 で申請する（[capacity.md](capacity.md) の 4.1 節）。
- **名前の揃え**：
  - 共有リンクのトークンの接頭辞を `<brand>_sl_` にした（他の `<brand>_at_`・`<brand>_rt_`・`<brand>_whsec_`・`<brand>_inv_`・`<brand>_scim_` と同じ形）。
  - 照合の結果の表を `integrity_audit_runs` にした（block-storage の `blocks_audit_runs` を直した）。ログでブロックを指す `block_id` を `blocks` の列に足した。
  - プランの保持の期間の表を `tenant_retention_settings` にした（versions-and-recovery の `retention_policies` が、security のデータの種類ごとの `retention_policies` と名前がぶつかっていた）。
  - `epoch` は `namespaces` の列にせず、`platform_state` に持つ。
- **数値の揃え**：
  - 消しすぎの止めは「5 分の窓で 1,000 ファイルか木の 10%」（[ADR-0006](../decisions/0006-sync-conflict-model.md)・[security.md](security.md)・[runbooks/README.md](../runbooks/README.md) を [sync-engine.md](sync-engine.md) の 10 節に揃えた）。
  - NFR-010 の取り直しの理由は「期限切れ・`floor_seq` より古い・`epoch`」で、載せた名前空間の変更では取り直しにしない。
  - 名前空間をまたぐバッチは 2,000 ノードずつ（capacity を直した）。
  - DR の中身の確かめの量は 40 万〜160 万個・数十秒〜2 分（infrastructure を直した）。
  - commit は冪等のキーを持たない（infrastructure の 6.2 節の「冪等」を直した）。
- **検証の工程での直し（2026-10-09）**：公式の資料を取得し直して、次を確かめ・直した。
  - 本家のファイルの上限は 2,199,019,061,248 バイト（2 TiB より 4 MiB 少ない）。
  - LAN 同期は暗号化した HTTPS の直接の接続で中身だけを送り、File Provider 版の macOS では使えない。
  - Webhook は 10 分に 35 回を超える失敗かつ失敗の率 4.5% 超で止まる。
  - 共有リンクのパスワード・期限・ダウンロードの禁止の可否のプラン（7 つ）を確かめた（「一部だけ確かめた」を外した）。
  - Rewind は Basic で使えず、チームは既定で管理者だけ。
  - S3 の RTC は 99.9% を 15 分以内に写し、1 Gbps の割り当てを超える間は SLA の外。
  - Intelligent-Tiering は 128 KB 未満を監視せず、常に高頻度の層に置く。
  - CopyObject は 2025-10-29 から `If-None-Match` を受ける（block-storage の未検証を外した）。
  - CloudFront の OAC は SSE-KMS のオブジェクトを読める（鍵の方針で配信に復号を許す）。
  - Aurora PostgreSQL 17.5 以降のクラスタの上限は 256 TiB、表は 32 TiB。
  - Cloud Files API は Windows 10 1709 から、`cldflt.sys` は NTFS だけ、取り出しの方針は「アプリと提供者の大きいほう」。
  - 情報流通プラットフォーム対処法は 2025-04-01 の施行、電気通信事業法の外部送信規律は 2023-06-16 の施行（法務の論点の前提として [intent.md](../intent.md) の出典に足した。結論は出さない）。
  - 事前署名の URL でチェックサムの指定を強制できるかは、AWS の公式の資料で確かめられなかった（**未検証**のまま `presigned-upload-poc`）。
  - 本家のフォルダーの ZIP の上限（20 GB か 250 GB、10,000 ファイル）は公式の頁を取得できず**未検証**。
- **品質と運用**：
  - 各領域の文書の「quality.md・runbooks・data-model への項目」を反映した。
  - [quality.md](../quality.md) に Epic ごとの決定表と性質の一覧（2.2.2 節）、漏れの経路の表の行、DR の訓練の合格基準、互換と端末の群れの試験を足した。
  - runbooks の手順を、作ったもの（[incident-response.md](../runbooks/incident-response.md)、[deploy-and-rollback.md](../runbooks/deploy-and-rollback.md)、[disaster-recovery.md](../runbooks/disaster-recovery.md)、[mass-change-response.md](../runbooks/mass-change-response.md)）と計画のものに分けて一覧にした。
  - 表と置き場所の索引は [data-model.md](data-model.md)。
- **数値の正本**：
  - SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節。
  - 上限は各 ADR と runbooks の 2 節。
  - 保持の期間は [security.md](security.md) の 8.1 節と `retention_policies`。
  - 負荷と費用のモデルは [capacity.md](capacity.md)、単価は [infrastructure.md](infrastructure.md) の 10 節。
  - 表と置き場所は [data-model.md](data-model.md)。
- 領域ごとの決定は、各文書の「未解決の問い」の「決定」の節にある。

## 2026-10-09：データモデル

データモデルの完全版を [data-model.md](data-model.md) と [data-model/](data-model/) に作り、形（表・列・キー・索引・分割・保持）の正本をそこへ移した。領域の文書の「data-model への項目」は提案の記録として残す。名前・列・置き場所の決まっていなかったところは、推奨の案で決めた（[data-model.md](data-model.md) の 7 節の D-1〜D-27）。ADR の決定は変えていない。主なものは次のとおり。

- **スキーマ**：`public`（名前空間の表、テナントの表、RLS の外の登録簿）、`auth`（Better Auth と端末）、`maint`（保守、SLI、照合、テナントの消去の進み）の 3 つ（D-1・D-13）。
- **ノードの種類**：正本は `nodes.kind`。`is_folder` は生成の列にし、ジャーナルと置き場所のバージョンにも `kind`・`mount_ns_id` を持つ。`ns_mounts` は `nodes` のビュー（D-2・D-3。前の索引で持ち越していた 2 つを解いた）。
- **`name_key_next` の埋め**：ジャーナルに載せない。`committer_maint` のロールがこの列だけを書く。ぶつかる名前の解き方は普通の commit で載せる（D-4。[delivery.md](delivery.md) の 6.3 節の持ち越しを解いた）。
- **`node_versions` の分割**：月ではなく `ns_id` のハッシュで 64（今のバージョンが期限で消えないため。D-5）。
- **足した表**：`outbox`（D-10）、`export_jobs`（`files/export/status` のため。D-11）、`block_packs`（S2 の詰め直しの判定。D-12）。Better Auth の表の名前を `external_identities`・`verifications`・`passkeys` に決めた。
- **ジャーナルの列**：`on_behalf_of` を足した（管理者のアクセス。D-9）。
- **テナントをまたぐ読み出しの関数**：ログインの入口のドメインの解決 `auth_resolve_domain()`（ADR-0004 の「メールアドレスからアカウントの解決」に含める）、共有の招待の受け入れの `ns_invite_resolve()`（X5 に含める）、受け手のテナントへの通知の行の作成（X3 に含める）を決めた（D-20〜D-22）。ADR-0004 の一覧に 2026-10-09 の注記として足した（経路は増やしていない）。
- **S2 のディレクトリのクラスタ**：ADR-0049 の一覧に加えて、`oauth_*`・`webhook_deliveries`・`abuse_reports`・`plan_features`・`retention_policies`・`tenants` を置く（D-23）。
- **名前の揃え**：グループは入れ子にしない（namespaces-and-sharing を直した。D-17）。共有フォルダーの招待のトークンも `<brand>_inv_`（D-18）。端末の列は `client_version`（desktop-client を直した。D-19）。テナント・名前空間の表の主キーの先頭に `tenant_id`（`locked_subtrees`・`rewind_skips` を直した。D-14）。
- 直した領域の文書の一覧は [data-model.md](data-model.md) の 7 節にある。

持ち越し（法務、計測・PoC・選定・確認で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L10） | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた Story の spec を承認しない。中身を機械で読む処理（プレビュー、本文の索引、検査、`export-builder`）の範囲は L1、ハッシュの照合の範囲は L2、管理者のアクセスの形は L7 |
| 分割の母数と重複の率 | E2 の前の `chunking-dedupe-poc` |
| 事前署名の URL でのチェックサムの強制、写しの速さと費用、Transfer Acceleration の要否 | E2 の前の `presigned-upload-poc`（**未検証**） |
| モバイルの背景の送信で PUT の URL（15 分）が切れる頻度 | E10 の `mobile-background-upload-poc`。多ければモバイルの背景の URL の期限を延ばす ADR を起票する |
| 1 名前空間の書き込みの上限（1 秒 200 件）、Aurora の writer の大きさ | E3 の前の `namespace-write-throughput-poc` |
| DR の後の取り直しを、失った commit を見た端末だけに絞るか | テックリード。E13 の `dr-reset-slotting` の前に、commit の応答の番号の申告と名前空間ごとの取り直しをシミュレーターで確かめる |
| CRR の転送の割り当て（20 Gbps）、双方向の CRR がループしないこと、`content` のオリジンのフェイルオーバーと SSE-KMS・OAC の組み合わせ | E1 の `s3-buckets-baseline`・`edge-and-waf`（**未検証**） |
| 小さなブロックのパック | S2 の前の `small-block-pack-poc`（[ADR-0020](../decisions/0020-small-block-packing-for-s2.md)） |
| 検索の基盤の大きさ、Kuromoji・ICU の使用、S2 の分け方 | E9 の前の `search-sizing-poc` |
| macOS の File Provider の replicated の拡張の振る舞い、Windows とのプレースホルダーの差 | E5 の前の `placeholder-platform-survey`（**未検証**） |
| sandbox のプロセスの隔離の強さ（Fargate の制約）、ジョブごとの microVM へ移るか | E9 の `preview-sandbox` と E13 の外部のペンテスト（**未検証**） |
| 名前空間をまたぐ移動の間の待ち（最大 30 分）が受け入れられるか | E3 の負荷試験と社内の試用 |
| 層の割合、CloudFront の個別の価格 | E13 の `cost-baseline` |
| 巻き戻しをすべてのプランに出すか（本家は Basic で使えない） | PM（価格と合わせて） |
| S2 のテナントの移し方 | S2 の着手の前に別の ADR |
| データモデルの持ち越し（`node_versions` の量、`delivery_samples` の抜き取りの率、抽出したテキストの 90 日の後、`abuse_reports` の連絡先） | [data-model.md](data-model.md) の 9 節。Dev・Ops・法務（L2・L3） |
| 本家の振る舞いで未確認のもの（重複排除の範囲、共有フォルダーの容量の数え方と入れ子、SLA、API のアップロードのセッションの上限、フォルダーの ZIP の上限、内部のジャーナル） | 公式の資料で確かめられなかった。未検証のまま、本システムの値を使う |

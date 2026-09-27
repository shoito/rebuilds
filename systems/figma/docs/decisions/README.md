# Decisions: Figma

Figma の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 8 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 基盤は他の題材を引き継ぎ、エンジンとマルチプレイヤーのサーバーは Rust で書く | accepted |
| [0002](0002-central-authoritative-multiplayer.md) | 同時編集は、ファイルごとの中央のサーバーが順序を決める。プロパティ単位の LWW、分数インデックス、循環の拒否 | accepted |
| [0003](0003-journal-and-checkpoints.md) | ファイルはメモリに持ち、確定の前にジャーナルへ書き、定期的に S3 へチェックポイントを書く | accepted |
| [0004](0004-gpu-rendering-in-wasm.md) | 描画は WASM の中の自前のエンジンで、WebGL2 を必須、WebGPU を使えるときに使う | accepted |
| [0005](0005-tenancy-and-document-routing.md) | メタデータは共有スキーマと FORCE RLS で組織を分け、ファイルは Router の割り当てで Document Server へ振り分ける | accepted |
| [0006](0006-node-types-and-property-table.md) | ノードの種類とプロパティを 1 つの表で定義し、競合の単位・検証・持ち主の領域を表に書く | accepted |
| [0007](0007-node-ids-and-tree-invariants.md) | ノードの ID は `(session_id, local_id)`。`session_id` はジャーナルに記録してから渡し、木の不変条件は `doc-model` の検証器だけで確かめる | accepted |
| [0008](0008-canonical-binary-serialization.md) | 変更・チェックポイント・通信は、表から生成する自前のスキーマ付きバイナリ（タグ付き・正準形）で表し、ページ単位に分けて zstd で圧縮する | accepted |
| [0009](0009-multiplayer-wire-protocol.md) | 送受信は WebSocket の上の二値のメッセージ。`ChangeSet` ごとの `client_seq` で重複を除き、ジャーナルに書いた後に `Committed` を Gateway ごとに 1 回配る | accepted |
| [0010](0010-ordering-keys-and-cycle-rejection.md) | 並びの鍵は base-62 の可変長の文字列。重なりと長さはサーバーが振り直し、複数のノードの挿入には乱数の接頭辞を付け、循環を作る変更は `ChangeSet` ごと拒否する | accepted |
| [0011](0011-presence-and-fan-out.md) | 在席とカーソルはジャーナルに書かず、Document Server がファイルごとにまとめて Gateway ごとに配る。1 ファイルの参加は 500 人、編集は 200 人まで | accepted |
| [0012](0012-multiplayer-undo-redo.md) | Undo は自分の変更を打ち消す新しい変更として送る。他の人が後から上書きした値は戻さず、Redo の項目は Undo を実行した時点の値で作る | accepted |
| [0013](0013-scene-graph-and-tile-rendering.md) | 描画用のシーングラフを別に持ち、256 px のタイルに描いてキャッシュする。パスは CPU で線分にし、GPU で面積の被覆率を求めてアンチエイリアスする | accepted |
| [0014](0014-gpu-backend-selection-and-fallback.md) | 1 つのビルドに WebGPU と WebGL2 を入れ、WebGPU で始めて、失敗したらキャンバスを作り直して WebGL2 に移る。サーバーは lavapipe の上の wgpu で同じコードを動かす | accepted |
| [0015](0015-text-shaping-and-glyph-rendering.md) | テキストは HarfRust・Skrifa・ICU4X で整形し、48 px 以下はグリフのアトラス、超えたらパスで描く。グリフのないときの和文のフォールバックはファイルの設定で決める | accepted |
| [0016](0016-shell-engine-boundary.md) | エンジンと React は同じメインスレッドで動かし、生成した型のコマンドと、フレームに 1 回の話題ごとのスナップショットでやり取りする | accepted |
| [0017](0017-text-input-via-hidden-textarea.md) | キャンバスの上のテキストの入力は、全ブラウザで隠した textarea で受ける。EditContext は Firefox・Safari の対応を待つ | accepted |
| [0018](0018-vector-networks-and-boolean-operations.md) | ベクターネットワークの編集は編集した人が計算して全体を書く。ブール演算の結果は保存せず、i_overlay の整数の演算で求め、平坦化だけ iCurve で曲線を残す | accepted |
| [0019](0019-auto-layout-engine-and-layout-persistence.md) | オートレイアウトは自前の flexbox に近い計算にし、Taffy を差分のテストの参照にする。結果は derived_layout に保存するが、画面は手元の計算で出し、食い違いは修復の担当が直す。制約は親の大きさを変えた人が当てる | accepted |
| [0020](0020-deterministic-layout-arithmetic.md) | レイアウトとテキストの測定は f64 の四則と min・max だけで、順序を固定して計算する。標準の超越関数・FMA・並列を使わない。結果を変える変更は ADR を要する | accepted |
| [0021](0021-derived-instances-and-override-keys.md) | インスタンスの中身は保存せず導出する。上書きは元のノードの ID の経路 × プロパティをキーにし、1 項目ずつ LWW にする | accepted |
| [0022](0022-component-properties-and-variants-by-id.md) | コンポーネントのプロパティとバリアントは ID で束ねる。名前での対応は、切り替えと入れ替えでの上書きの引き継ぎにだけ使う | accepted |
| [0023](0023-library-snapshots-imported-into-files.md) | ライブラリは公開の時点の不変のスナップショットで配り、使う側のファイルに写しを取り込む。ファイルをまたぐ生の参照はしない | accepted |
| [0024](0024-journal-items-and-fencing.md) | ジャーナルは `seq` の範囲の group commit で、フェンスの `epoch` を確かめる `TransactWriteItems` と `ClientRequestToken` で書く。大きな変更は S3 に置き、TTL の漏れは回復のジョブで拾う | accepted |
| [0025](0025-content-addressed-checkpoints-and-loading.md) | チェックポイントはマニフェストと中身のハッシュで名付けたページのチャンクにし、変わったページだけを書く。クライアントは署名付き URL で CloudFront からチャンクを読んで端末にキャッシュし、その後の変更だけを Document Server から受け取る | accepted |
| [0026](0026-version-history-restore-and-deletion.md) | 版はチェックポイントに印を付けたもので、復元は差分を 1 つの変更として当てて履歴を消さない。削除はゴミ箱と完全な削除の 2 段で、完全な削除はジョブで S3・ジャーナル・版を消す | accepted |
| [0027](0027-comments-anchored-to-nodes-in-metadata.md) | コメントは Aurora に置き、ノードの ID と相対の位置で固定する。通知は送る時点で受け手を判定し直し、メールは受け手とファイルごとにまとめる | accepted |
| [0028](0028-realtime-metadata-subscriptions.md) | メタデータのリアルタイムの更新は、トリガーで書く無効化の outbox と、単純な問い合わせへの分解・再取得の購読層で配る | accepted |
| [0029](0029-hierarchy-roles-seats-and-link-access.md) | 階層は組織・チーム・プロジェクト・ファイル。水準は全順序で、上位で与えた水準を下位で下げない。ファイルの「招待した人だけ」は上位の一般アクセスを遮る。シートは上限として重ねる | accepted |
| [0030](0030-single-policy-engine-and-signed-capabilities.md) | 判定関数は API の TypeScript に 1 つだけ置き、ポリシーは JSON で表せる allow / deny の規則で書く。Gateway は API が発行する署名付きの能力のチケットで判断する | accepted |
| [0031](0031-org-acl-version-and-connection-revalidation.md) | 実効権限は組織の acl_version をキーにキャッシュする。長く続く接続は、acl.changed と 5 分ごとの再検証で判定し直し、下げる・切る | accepted |
| [0032](0032-name-search-in-aurora.md) | MVP の名前の検索は Aurora の中で行う。組織の行を部分一致で絞り、候補を読めうる資源の集合で絞り、判定関数で読み直す | accepted |
| [0033](0033-content-search-from-checkpoints.md) | MVP の後の中身の検索は、Worker がチェックポイントからノードの名前とテキストを取り出し、OpenSearch に索引する。権限は資源の連鎖を文書に持たせて問い合わせの時点で絞り、判定関数で読み直す | accepted |
| [0034](0034-export-rendering-split.md) | 画面からの書き出しはクライアントのエンジンで描き、サムネイル・API・大きな一括の書き出しはネイティブのエンジンの Render Worker で描く | accepted |
| [0035](0035-content-addressed-images.md) | 画像は組織ごとに中身の SHA-256 で重複を除き、クライアントで正規化してから署名付き PUT で上げ、別ドメインの CDN から短命の署名付き URL で配る | accepted |
| [0036](0036-font-sources-and-licensing.md) | フォントの出どころは同梱のオープンなフォント・組織のフォント・端末のフォントの 3 つにし、サーバーの描画と PDF への埋め込みはライセンスの確かなものに限る | accepted |
| [0037](0037-plugin-sandbox-quickjs-wasm.md) | プラグインのコードは QuickJS を WASM にした専用のインスタンスでメインスレッドに動かし、UI と通信は別のオリジンの null origin の iframe に置く | accepted |
| [0038](0038-plugin-api-and-capabilities.md) | プラグインの API は動かした人の権限の中で動き、manifest で宣言した能力と通信先だけを許し、書き込みは通常の変更（ChangeSet）にする | accepted |
| [0039](0039-plugin-distribution-and-review.md) | 組織の中のプラグインは審査なしで配り、公開のプラグインは初回と権限の拡大で人が審査する。版は不変に保存し、停止のスイッチを持つ。ウィジェットは別の ADR にする | accepted |
| [0040](0040-public-rest-api-surface.md) | 公開 API は別のサービスにし、利用者の権限とスコープの積で動かす。ファイルの中身は Rust の読み取り専用のサービスが返し、中身の書き込みは出さない。トークンは PKCE 必須の OAuth 2.1 と期限必須の個人のトークン | accepted |
| [0041](0041-webhook-delivery.md) | Webhook は中身を含まない HMAC で署名したイベントを、配送の時点の権限で判定し、隔離した egress から少なくとも 1 回送る | accepted |
| [0042](0042-api-versioning-and-rate-limits.md) | 公開 API の版は URL の大きな版にし、ノードの JSON はプロパティの表から生成して表の列で公開を決める。レート制限は操作の重さの tier と画素の予算で数える | accepted |
| [0043](0043-authentication-sessions-and-org-sso.md) | 認証とセッションは Slack の ADR-0012 を引き継ぎ、組織の SAML SSO はメンバーにだけかける。長く続く接続は、セッションの取り消しでも切る | accepted |
| [0044](0044-encryption-keys-and-client-cache.md) | 保存時の暗号化はデータの種類ごとの KMS の鍵（マルチリージョン）で行い、組織ごとの鍵は MVP で持たない。端末のキャッシュは暗号化せず、組織の方針で止められるようにする | accepted |
| [0045](0045-audit-log-and-data-lifecycle.md) | 監査ログは操作と同じトランザクションで書いて改ざんできない保管へ送り、組織の管理者に見せる。削除は東京と大阪の両方で、バックアップの期限を最終の期限にする | accepted |
| [0046](0046-multiplayer-compute-on-fargate-with-drain.md) | Gateway と Document Server は ECS Fargate（ARM64）で動かし、Document Server はタスクの保護と自前のドレインでファイルを渡してから止める。WebSocket は CloudFront と ALB で受ける | accepted |
| [0047](0047-router-task-liveness-and-file-assignment.md) | Router は、タスクごとの生存の記録と、ファイルごとの割り当ての記録を分けて持つ。手放しの記録、回復のジョブ、削除済みの割り当てで、ADR-0024 の前提を満たす | accepted |
| [0048](0048-osaka-dr-with-journal-generations.md) | 大阪への災害復旧は、DynamoDB のグローバルテーブル（MREC）・S3 の複製・Aurora の Global Database と縮小したウォームスタンバイで行い、切り替えのたびに「世代」を上げてジャーナルとチェックポイントの置き場所を分ける | accepted |
| [0049](0049-client-telemetry-without-content.md) | クライアントの計測（フレーム時間・メモリ・WASM の異常終了）は、ブラウザの中で集計してから、中身を含まない形で自前の受け口へ送る | accepted |
| [0050](0050-editing-slis-and-slos.md) | 編集の SLO は「開ける」と「確定する」の 2 つのイベントの SLI で数え、反映の遅延は合成のボットで、回復の時間は Router の記録で測る | accepted |
| [0051](0051-document-server-memory-admission.md) | Document Server は、ファイルごとのメモリを見積もって受け入れを決め、タスクのメモリの 75% を上限にする。大きなファイルは別の群れに置く | accepted |
| [0052](0052-journal-throughput-and-hot-file-budget.md) | ジャーナルの表はオンデマンドで事前に温め、1 ファイルの書き込みは予算で抑える。予算を超えそうなファイルは、まとめの間隔を段階的に広げる | accepted |
| [0053](0053-client-server-version-skew.md) | クライアントとサーバーの版は、送受信の形式の版・スキーマの互換の一覧・最低のビルドの 3 つで照合する。再読み込みは、穏やかなものと強いものを分ける | accepted |
| [0054](0054-wasm-native-parity-and-bundle-budgets.md) | WASM とネイティブの一致を、同じ入力の列から作った正準形のバイト列で PR ごとに確かめ、WASM の大きさと描画の性能に予算を置いて CI で止める | accepted |
| [0055](0055-staged-rollout-and-schema-changes.md) | クライアントのビルドは組織の割合で段階的に出し、適用の規則を変えるフラグはファイルごとに Document Server が決めて配る。プロパティの表の変更は「サーバー → クライアント → 書き込みの解禁」の 3 段で出す | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

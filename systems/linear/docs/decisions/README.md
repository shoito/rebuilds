# Decisions: Linear

Linear の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤の上に、同期エンジンを自前で作る。クライアントは TypeScript の SPA と Electron、手元の保存は IndexedDB | accepted |
| [0002](0002-sync-model.md) | ワークスペースごとに、サーバーが全順序を決める変更のログと単調な `sync_id` を持つ。クライアントは楽観的に当て、差分の上に載せ直す。競合はフィールドの型ごとの規則で解く | accepted |
| [0003](0003-bootstrap-and-partial-sync.md) | 小さなワークスペースは全体のブートストラップ、大きなワークスペースは部分のブートストラップと遅延の読み込み。差分は同期グループで絞って配る | accepted |
| [0004](0004-tenancy-and-permissions.md) | ワークスペースをテナントにし、FORCE RLS で分ける。チームを権限の範囲にし、非公開のチームは同期グループで差分から外す | accepted |
| [0005](0005-client-persistence-and-offline.md) | ワークスペースごとの IndexedDB に、モデルと、送る前に保存する outbox を持つ。スキーマの版ごとに移行し、outbox は移行で消さない | accepted |
| [0006](0006-transactions-writer-and-idempotency.md) | トランザクションは意図の操作の列で、全体が確定か拒否。Writer はワークスペースの行を最初にロックし、1 つの DB のトランザクションで書き、結果を 90 日持って再送に同じ結果を返す | accepted |
| [0007](0007-sync-actions-and-range-proof-deltas.md) | `sync_id` は変更ごとに振って欠けなく続け、差分は範囲の証明つきのパケットで送る。Gateway は絞る前の列の連続を確かめてから範囲を名乗り、`update` は変更後の行の全体を運ぶ | accepted |
| [0008](0008-conflict-rules-and-fractional-keys.md) | 競合の規則はスキーマの `conflict` に 1 か所で書く。並びの鍵は範囲ごとに一意な base-62 の分数インデックスで、重なりは Writer が振り直し、長くなったら近くの窓だけを振り直す。上書きはフィールドごとの最後の `sync_id` で見つける | accepted |
| [0009](0009-sync-gateway-protocol.md) | Sync Gateway のプロトコルは WebSocket の上の JSON のテキストフレーム。認証は最初のメッセージのチケット、握手の決定表で続き・取り戻し・やり直しを決め、取り戻しは Sync API の HTTP で行う | accepted |
| [0010](0010-deterministic-sync-simulator.md) | 収束は、本物の同期のコードを 1 つのプロセスで動かす、シードから再現できる決定的なシミュレーターで確かめる。PR ごとに 2,000 の列、夜間に 20 万の列を回し、失敗したシードを回帰テストに残す | accepted |
| [0011](0011-bootstrap-stream-and-chunked-snapshots.md) | ブートストラップは NDJSON のストリームで、ID の範囲のチャンクごとに 1 つの写しで読む。クライアントは最も小さい `as_of` から差分を当て、チャンクの境を先に決めて途中から再開できるようにする | accepted |
| [0012](0012-lazy-loading-coverage-and-tombstones.md) | 遅延の読み込みは被覆の鍵の単位で求め、そろったら部分の索引に記録する。読み込みと差分の順序の揺れは、行の `updated_sync_id` と、15 分持つ削除の墓標で解く | accepted |
| [0013](0013-sync-group-changes-retention-and-reset.md) | 同期グループの参加・脱退は `SyncSubscription` の差分で表し、参加は部分のブートストラップ、脱退は 1 つの IndexedDB のトランザクションでの消去にする。ログは 30 日持ち、DR の切り替えと復元では `sync_epoch` を上げて、直近 15 分に確定した outbox を送り直す | accepted |
| [0014](0014-indexeddb-layout-durability-and-migrations.md) | IndexedDB は outbox だけを `strict`、差分とブートストラップを `relaxed` で書く。outbox の行は確定の後 15 分残し、移行は store と索引を `onupgradeneeded` で、行を再開できる通常のトランザクションで行い、outbox は送る時に今の形へ変換する | accepted |
| [0015](0015-multi-tab-leader-and-broadcast.md) | 書き手のタブを Web Locks で 1 つ選び、どのタブも outbox へ直接書いて BroadcastChannel で知らせる。書き手は保存した差分の ID を配り、他のタブは IndexedDB から読み直し、取りこぼしは `last_sync_id` の食い違いで気づく | accepted |
| [0016](0016-memory-tiers-quota-and-offline-ux.md) | メモリーは 3 層にし、観測可能なモデルは 5 万個まで。保存の上限を見張って遅延のモデルの写しだけを退かし、ブラウザに消された未送信の件数はサーバーのクッキーの端末の ID で本人に示す | accepted |
| [0017](0017-keymap-command-menu-and-ime.md) | 操作は 1 つの Action の登録にまとめ、ショートカット・コマンドメニュー・メニューが同じ登録を使う。キーは入れ子の範囲の順に解決し、組み立て中（`isComposing` か `keyCode === 229`）のキーはどのショートカットにも使わない | accepted |
| [0018](0018-render-path-and-latency-budget.md) | 入力の経路は Action → トランザクション → プールへの適用 → 行ごとの購読の描き直しで、何も待たない。一覧は固定の高さで仮想化し、遅延は自前の印で測って、固定の機械の CI で p99 50ms を超えた PR を失敗させる | accepted |
| [0019](0019-schema-definition-and-codegen.md) | モデルは TypeScript の宣言で 1 か所に書き、DB・共有のパッケージ・クライアントの構成・GraphQL の型を生成する。欠けた規則は生成で失敗させ、破壊の変更は広げてから縮める | accepted |
| [0020](0020-ids-and-human-identifiers.md) | モデルの ID はクライアントが振る UUIDv7。人が読む番号はチームごとの数から Writer が確定の時に振り、再利用しない。チームを移したイシューは番号を振り直し、古い識別子は別名の表で引く | accepted |
| [0021](0021-description-crdt-yjs-in-sync-log.md) | 本文の CRDT は Yjs と y-prosemirror。更新は 250ms ごとにまとめて `append` で送り、同期のログに `sync_id` の順で載せる。Worker がまとめた状態を作り、読み込みは読んだ時点までを合わせて返す | accepted |
| [0022](0022-comments-anchors-mentions-attachments.md) | コメントの本文は ProseMirror の JSON を LWW で持つ。インラインのコメントは Yjs の相対位置の組をコメントの行に持つ。メンションは ID で持ち、本文のメンションは Worker が抜き出す。添付は署名付きの URL で S3 へ直接上げ、別のドメインから配る | accepted |
| [0023](0023-workflow-states-and-lifecycle-automation.md) | ワークフローの状態はチームごとの行で、種類の順は固定、移り変わりは制限しない。自動で閉じる・アーカイブは Worker の日ごとのシステムのトランザクションで行い、削除はアーカイブと `trashed_at` の組で表して 30 日後に消す | accepted |
| [0024](0024-hierarchy-relations-duplicates-and-triage.md) | 親子は `parent_id` の LWW と循環の拒否。関連は向きを正規化した行で両方のグループに属する。重複は `duplicate` の関連の作成で表し、元の 1 件へつなぎ直す。Triage への振り分けは Writer が作成の時に決める | accepted |
| [0025](0025-derived-changes-in-writer.md) | ある変更から決まる別の変更は、共有のコードの `derive` で求める。Writer は同じトランザクションで書き、クライアントは同じコードで予測して画面に重ねる | accepted |
| [0026](0026-cycle-rows-and-rollover.md) | サイクルはチームごとの行で、Worker がチームのタイムゾーンで先の分を作る。クールダウンは行のない隙間で表し、繰り越しは次のサイクルの始まりに Worker のシステムのトランザクションで行う。終わったサイクルへの遅れた割り当ては、派生で繰り越し先へ付け替える | accepted |
| [0027](0027-progress-stats-per-team-via-derive.md) | 進捗は `(対象, チーム)` ごとの `ProgressStat` の行に `counter` で持ち、イシューの変更の `derive` が増減を出す。行はチームの同期グループに属す。イニシアチブの進捗は保存せず画面で足し、1 日 1 回 SQL で数え直す | accepted |
| [0028](0028-filter-language-and-shared-evaluation.md) | フィルターは型の付いた JSON の木で持ち、共有のパッケージの 1 つの定義から、クライアントの評価の関数と SQL の生成を作る。空の値・文字の正規化・並びの比較を言語の側で決め、共有のテストの例の集まりと差分テストで一致を確かめる | accepted |
| [0029](0029-view-coverage-planner-and-server-query.md) | ビューは計画の関数が被覆の鍵から「手元だけ」「手元とサーバー」「サーバー」を決める。サーバーの問い合わせは同期グループで絞った行を返し、クライアントはそれを候補として手元に足して同じ関数で評価する。保存したビューは範囲ごとの同期グループに属し、フィルターが参照する ID はビューの読み手全員が見てよいものに限る | accepted |
| [0030](0030-search-engine-opensearch.md) | 検索は S1 から Amazon OpenSearch Service で、行ごとの文書にする。一致は 1〜2 文字の N-gram、関連度は同梱の kuromoji、正規化はアプリの共有の関数。版は行の `sync_id` で外部の版にする。Aurora の `pg_bigm` は使えることを確かめたうえで代案とする | accepted |
| [0031](0031-search-permission-by-sync-groups.md) | 検索の権限は同期グループで効かせる。文書に行の `sync_groups` を入れ、検索のたびに呼んだ人の購読を条件にし、結果を Aurora で読み直して今の `sync_groups` と削除で落とす。抜粋は版が同じときだけ返す。画面は手元の検索を先に出し、サーバーの結果を後から足す | accepted |
| [0032](0032-single-policy-module-and-group-mapping.md) | 権限は `packages/policy` の純粋な関数 `can()` と `groupsFor()` にまとめ、全部の経路とクライアントが同じコードを使う。読む権限は「行の同期グループと購読が交わる」と同じ意味にし、書く権限と管理の権限は決定表で決める | accepted |
| [0033](0033-team-visibility-changes-and-guests.md) | 同期グループに `members`（ゲストを除くメンバー）を足し、ゲストに届けないワークスペースの行をそこに置く。チームの行は公開なら `workspace`、非公開なら `team:<id>` と `role:admin`。非公開への切り替えは、同期に加えて、担当・購読者・通知・ビューの後始末を行う。管理者は非公開のチームに自分で参加でき、監査に残す | accepted |
| [0034](0034-accounts-with-better-auth.md) | 認証は Better Auth を `packages/auth` で包んで使う。メールの OTP・Google・パスキー・セッション・複数のセッションの部品を使い、組織の部品は使わない。アカウントは RLS の外の `auth` スキーマ、ワークスペースの中の人は同期するモデルにし、`account_id` で結ぶ | accepted |
| [0035](0035-sessions-and-sync-ticket.md) | セッションは HttpOnly のクッキーで、使わないまま 30 日で切れ、絶対の期限は置かない。ワークスペースへの入り口は同期のチケットで、発行の時にメンバーシップ・状態・ログインの制限を確かめる。取り消しと停止は Valkey で Gateway に知らせて 5 秒以内に切り、5 分ごとに確かめ直す。Electron はシステムのブラウザでログインし、PKCE の形でコードを交換する | accepted |
| [0036](0036-notifications-derived-by-notifier.md) | 通知の行は確定の後に Worker（通知係）が作り、Writer のシステムのトランザクションで `Notification`（`user:<id>` のグループ）として書く。受け手は決定表と `can()` で決め、行は中身を持たず、冪等の鍵で 1 つの事象から 1 行だけを作る。既読とスヌーズは行の LWW のフィールドと既読の水位で持ち、同期で端末をまたいで揃える | accepted |
| [0037](0037-notification-delivery-channels.md) | デスクトップの通知は同期で届いた行をクライアントが OS に出し、別の push の基盤を持たない。メールは種類の急ぎの度合いで待ちを決め、送る時に未読でスヌーズでない行だけを 1 通にまとめる。Slack の個人への通知は 30 秒待って未読なら送る。メールと Slack は送る時にもう一度 `can()` で確かめ、中身はそのときに読む | accepted |
| [0038](0038-git-hosting-linking-and-state-automation.md) | GitHub は GitHub App、GitLab は顧客のトークンと署名付きの Webhook で受け、PR ごとの順で照合する。結び付けはブランチ名・タイトル・本文の語で決め、状態は前へだけ、複数の PR はそろってから進める。非公開のチームのイシューは、結び付いた利用者が書ける時だけ動かす | accepted |
| [0039](0039-slack-app-issue-creation-and-channel-notifications.md) | Slack はワークスペースごとに 1 つのインストールで、トークンの入れ替えを有効にする。メッセージからの作成は結び付けた利用者が書けるチームにだけ行い、チャンネルへの通知とリンクの展開は公開のチームに限る。スレッドの同期は MVP の後にする | accepted |
| [0040](0040-integration-installations-and-credential-storage.md) | 連携のインストールは管理者のグループのモデルに秘密なしで持ち、秘密は KMS の専用の鍵で包んだ暗号文をサーバーだけの表に置く。GitHub のインストールのトークンはメモリーだけに持ち、顧客の指定するホストへは egress の経路から送る | accepted |
| [0041](0041-public-graphql-generated-schema-and-writer-mutations.md) | 公開の GraphQL は型を生成し、入口と mutation を手で書く。読み出しは同期グループの重なりで SQL で絞り、mutation は 1 つずつ Writer のトランザクションにする。複雑さは実行の前に数え、主体ごとの 1 時間の枠を超えたら 429 を返す | accepted |
| [0042](0042-api-keys-oauth-apps-and-token-format.md) | API キーは 1 人の利用者に結び、範囲とチームで絞り、期限を 1 年までにする。OAuth のアプリは PKCE（S256）を必須にし、アクセストークン 24 時間、リフレッシュトークンは入れ替えと再利用の検出。トークンは `<brand>_` の接頭辞とチェックサムの形で、ハッシュだけを保存する | accepted |
| [0043](0043-signed-webhooks-from-sync-log.md) | Webhook は `sync_actions` から作り、作った管理者の権限で送る時にも絞る。署名は時刻を含む `<Brand>-Signature`、5 秒で時間切れ、1 分・1 時間・6 時間で再試行し、24 時間失敗し続けたら止める。送信は egress の経路から | accepted |
| [0044](0044-import-pipeline-staging-and-throttled-writer-commits.md) | 取り込みは段置きと対応付けと試しの実行の後に、Writer（`origin = import`）へ 200 変更の束で、ワークスペースの枠（1 秒 100 変更、ロックの待ちで半分）で書く。ID は元の記録から決まる UUIDv7 にし、やり直しを冪等にする。取り消しは 7 日、人が触れていない行だけ | accepted |
| [0045](0045-export-by-permission-to-private-download.md) | 書き出しは頼んだ人の同期グループで絞って Worker が作り、S3 の非公開の場所に 24 時間置く。取り出しはセッションで本人を確かめてから 5 分の署名付きの URL へ転送し、メールには署名付きの URL を入れない | accepted |
| [0046](0046-device-data-no-app-encryption-and-remote-wipe.md) | 手元の DB はアプリの層で暗号化せず、OS のディスクの暗号化に任せる。ログアウト・除外・遠隔の消去の指示で手元を消し、共有の端末には「この端末に保存しない」の入り方を置く。Electron のミニダンプを外へ送らない | accepted |
| [0047](0047-audit-log.md) | 監査ログは、ワークスペースの監査（Aurora、1 年）とプラットフォームの監査に分け、Writer が対象の操作と同じ DB のトランザクションで書く。どちらも log-archive へハッシュの連鎖つきで写し、`sync_actions` を監査ログの代わりにしない | accepted |
| [0048](0048-data-lifecycle-and-workspace-deletion.md) | 保持の期間を 1 つの表で持ち、時間で消える表はパーティションで落とす。ワークスペースの削除は 30 日の猶予の後に Aurora・OpenSearch・S3 から `workspace_id` で消し、バックアップは 35 日で消える。アカウントの削除は人を仮名にし、書いた中身は残す | accepted |
| [0049](0049-accounts-network-and-service-placement.md) | アカウントとネットワークは他の題材の形を引き継ぎ、WebSocket も CloudFront → ALB を通す。Gateway は接続の数でスケールしてスティッキーにせず、Writer は内部だけ、顧客の指定する宛先への送信は egress の専用の経路にする | accepted |
| [0050](0050-disaster-recovery-and-sync-epoch-bump.md) | 大阪にウォームスタンバイを置き、リージョンの切り替えは書き込みを止めてから昇格し、全ワークスペースの `sync_epoch` を上げてから書き込みを受ける。検索は 4 時間で戻し、失った範囲の外への副作用は取り消せないものとして扱う | accepted |
| [0051](0051-workspace-sharding-and-cells.md) | S2 はワークスペースを単位に Aurora のクラスタへ分け、ディレクトリとアカウントを小さな共通のクラスタに置く。移動は `sync_id` を保ち `sync_epoch` を上げない。S3 はワークスペースをセルに固定し、セルごとに主のリージョンを持つ | accepted |
| [0052](0052-rum-and-propagation-measurement.md) | RUM は自前の口に、端末で集めたヒストグラムを送り、中身と識別子を送らない。伝播は Writer のコミットの直前の時刻を差分と一緒に運び、クライアントは ping の往復で見積もった時計の差で「確定から適用まで」を測る | accepted |
| [0053](0053-convergence-audit.md) | 収束の監査は、抜き取った端末が IndexedDB の確定した行のハッシュを桶ごとに `(L, sync_epoch)` と送り、サーバーは今の行と `sync_actions` から `L` の時点の状態を作り直して比べる。合わない桶は 2 段目で行を特定し、説明のつかない不一致を K5 に数える | accepted |
| [0054](0054-per-workspace-write-admission.md) | 1 ワークスペースの書き込みを `origin` ごとの枠で割り当てる。`client` を最優先にして数えず、`api`・`worker`・`notifier`・`import` を Writer がロックの前に数え、ロックの待ちが伸びたら `client` 以外を半分にする | accepted |
| [0055](0055-ci-gates-latency-convergence-ime.md) | PR の必須の関門に、遅延の予算（固定の機械）、収束のシミュレーターと回帰の種、オフラインと再送の 3 つの場面、IME のテスト、生成とマイグレーションの検査を入れ、変更のパスで重さを足す。関門を外すラベルを持たず、シミュレーターの失敗を再実行で緑にしない | accepted |
| [0056](0056-flags-client-distribution-and-min-build.md) | クライアントのフラグはサーバーが評価して握手で配り、同期の意味はフラグにしない。Web は `index.html` を端末の桶ごとに段階的に切り替え、Electron は更新の案内を端末の桶で返す。最低の版は Gateway の `min_build` で殻とレンダラーの組で強制し、手元の読み書きは止めない | accepted |
| [0057](0057-schema-change-ordering.md) | スキーマの変更は、サーバーの DB を広げる → サーバーが古い形と新しい形の両方を受ける → クライアントを移す → 古い `schema_hash` の接続が 1% 未満かつ 30 日の後に縮める → 古い列を単独で消す、の順にする。1 つのデプロイで、DB の破壊の変更とそれを読むコードを一緒に出さない | accepted |
| [0058](0058-dr-permission-narrowing-journal.md) | 権限を狭める操作は、Aurora に加えて、東京の中で同期して複製する追記だけの記録にも書き、大阪へ送る。大阪への昇格では、書き込みを受ける前に、失った範囲の記録をやり直す | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

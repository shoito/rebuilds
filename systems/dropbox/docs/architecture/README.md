# Architecture: Dropbox

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く（一覧は 7 節）。データモデルの正本（規約、ER 図、表の目録、DB の外の置き場所、横断の不変条件）は [data-model.md](data-model.md) と [data-model/](data-model/)。品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

## 1. 全体構成

### 1.1 コンテキスト

```
 個人・チームの利用者
  デスクトップのクライアント（macOS・Windows）、モバイルのアプリ（iOS・Android）、Web のブラウザ
      │ HTTPS（REST、ブロックの送受信）、WebSocket（変わったの合図）
      ▼
┌──────── 本システム（www・api・notify.<brand>.<domain>、content.<brand>usercontent.<domain>）────────┐
│  ファイルの木と同期、ブロックの保存、共有フォルダーと共有リンク、バージョンと復元、プレビュー、検索、管理と監査 │
└─────────────────────────────────────────────────────────────────────────────────┘
   ▲ REST・OAuth 2.0            ▲ 共有リンク（匿名を含む）           │ 外向き
   │ Webhook の登録              │                                    ▼
 公開 API の利用者               リンクを受け取った外部の人           Webhook の通知（利用者のサーバー）
 （バックアップ、業務の          IdP（SAML・OIDC・SCIM）              メール（招待、通知）
 システム、ワークフロー）                                             モバイルの通知の配信のサービス（APNs・FCM）
```

### 1.2 コンテナ

```
 ┌ デスクトップのクライアント ───────────────────────────┐ ┌ モバイルのアプリ ─────────┐ ┌ Web の SPA ───────┐
 │ UI（TypeScript・Tauri）                               │ │ UI（Swift・Kotlin）        │ │ React             │
 │ sync-core（Rust）：監視、ローカルの状態の DB（SQLite）、│ │ sync-core（Rust）：分割、  │ │ 分割（sync-core の │
 │  3 つの木と計画、分割、送受信、ローカルのブロックの索引 │ │  送受信、カメラの取り込み  │ │  WASM）            │
 │ OS の殻：File Provider（Swift）・Cloud Files（Rust）    │ └──────────┬──────────────┘ └────────┬─────────┘
 └──────┬───────────────────────┬──────────────────────┘            │                            │
        │ REST（commit、list）   │ ブロックの PUT・GET（署名つき URL）  │                            │
        ▼                        ▼                                   ▼                            ▼
 ┌──── CloudFront＋WAF（www・api・notify・share、content＝<brand>usercontent。ブロックとプレビューの配信）────┐
 └──┬─────────────┬──────────────┬──────────────┬───────────────────────────────┬────────────────┘
    ▼             ▼              ▼              ▼                               ▼（OAC）
 ┌───────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐                ┌────────────────────────┐
 │ API    │  │ Notify    │  │ Link      │  │ Auth      │                │ S3（東京）               │
 │ 木・   │  │ WebSocket │  │ 共有リンク │  │ ログイン・ │                │ blocks：ブロック（内容の │
 │ commit・│  │ の合図    │  │ の解決    │  │ SSO・SCIM・│  ブロックの PUT │  番地、テナントごと）    │
 │ 共有・ │  └────▲─────┘  └────┬─────┘  │ OAuth     │ ───────────────▶│ blocklists：大きな       │
 │ 管理   │       │             │        └──────────┘  （署名つき URL）  │  ファイルのブロックの一覧│
 └──┬────┘       │             │                                      │ previews：プレビューの   │
    │ packages/committer（条件の確認・name_key・ns_seq・ジャーナル・   │  キャッシュ              │
    │  ブロックの参照・outbox を 1 つの DB のトランザクションで）       │ audit：監査ログの写し    │
    ▼             │             ▼                                      └──────────┬─────────────┘
  Aurora PostgreSQL（ノード、リビジョン、ns_journal、ブロックの索引、       │ CRR
   名前空間と共有、共有リンク、アカウントとチーム、outbox、RLS）           ▼
    │ outbox      │                                              S3（大阪）：blocks の写し
    ▼             │
  Relay ──▶ Valkey（名前空間の合図の pub/sub、レート制限、共有リンクのキャッシュ）
    │
    ▼
  SNS・SQS ──▶ Worker
               ├ block-verifier：S3 のチェックサムを確かめてブロックの索引に入れる
               ├ block-gc：参照が 0 のブロックを猶予の後に消す。block-scrubber：抜き取りの照合
               ├ preview-renderer・text-extractor（隔離したタスク。ネットワークなし）
               ├ indexer：OpenSearch へ名前と本文を入れる
               ├ restore-runner：復元と巻き戻しの大きな操作をバッチで流す
               ├ export-builder：フォルダーの ZIP と 1 つの URL のダウンロードを S3 の中で組み立てる（ADR-0054）
               ├ mass-change-detector：一斉の変更（削除・名前の変更・暗号化らしい変更）を検知する
               ├ webhook-sender（egress）、mailer、mobile-push
               └ quota・auditor・lifecycle・slo-aggregator ほか
 OpenSearch（名前と本文の索引。ACL の判定はしない。返す前に can() で確かめ直す）
```

| コンテナ | 責務 |
| --- | --- |
| デスクトップのクライアント | 手元のフォルダーの監視、ローカルの状態の DB、3 つの木からの計画、分割と送受信、競合のコピー、選択型の同期、オンラインのみのファイル。核は Rust の `sync-core`、OS ごとの殻と UI を薄く持つ（[ADR-0001](../decisions/0001-platform-and-stack.md)、[ADR-0006](../decisions/0006-sync-conflict-model.md)） |
| モバイルのアプリ | 一覧、プレビュー、指定したファイルのオフラインの保存、カメラのアップロード。`sync-core` の分割と送受信を共有する。木の全体の同期はしない |
| Web の SPA | 一覧、アップロード、ダウンロード、プレビュー、共有、復元、検索、管理の画面。アップロードの分割は `sync-core` の WASM で同じ規則にする |
| API | 公開の REST API と、自社のクライアントが使う API を同じものにする。木の読み出し、commit、カーソル、共有、共有リンクの管理、バージョンと復元、管理 |
| `packages/committer` | すべての書き込みの入口のライブラリ。`base_rev` の条件、`name_key` の一意、循環の検査、リビジョン、ブロックの参照、`ns_seq`、`ns_journal`、outbox を 1 つの DB のトランザクションで書く。API・Worker（復元・巻き戻し）が使う（[ADR-0005](../decisions/0005-namespace-journal-and-cursors.md)） |
| Notify | 端末の WebSocket を終端し、端末が載せた名前空間の「`ns_seq` が S になった」の合図だけを送る。中身は送らない。合図が落ちても、カーソルで取り戻す |
| Link | 共有リンクの解決（匿名を含む）。パスワード、期限、方針の確認の後、中身の配信の署名つき URL を返す。WAF とボットの対策を別にする |
| Auth | 個人のログイン、チームの SSO（SAML・OIDC）と SCIM、OAuth 2.0 の認可サーバー、端末の登録と切り離し |
| Relay | outbox を読み、合図を Valkey へ、遅れてよい処理を SNS・SQS へ流す |
| Worker | ブロックの検証・GC・照合、プレビューと本文の抽出、索引、復元と巻き戻し、ダウンロードの組み立て（ADR-0054）、一斉の変更の検知、Webhook、通知、容量の集計、監査 |
| Aurora | メタデータの唯一の正本。テナントと名前空間を RLS で分ける（[ADR-0004](../decisions/0004-tenancy-namespaces-and-rls.md)） |
| S3 | ブロックの中身の正本。内容の番地の不変のオブジェクト。大阪へ複製する（[ADR-0007](../decisions/0007-block-storage-layout-on-s3.md)） |
| Valkey | 合図の配信、レート制限、キャッシュ。失われてもよい |
| OpenSearch | 名前と本文の索引。写しであり、Aurora と S3 から作り直せる |

原則は 6 つ。

- **中身は内容の番地の不変のブロック、木はメタデータ。** ファイルのリビジョンは、ブロックのハッシュの並び（ブロックの一覧）を指す。ブロックは書き換えない。木の変更は、メタデータの行とジャーナルの変更だけで、中身を動かさない（[ADR-0002](../decisions/0002-chunking-and-block-addressing.md)）。
- **送るのは足りないブロックだけ、ただし他人の有無は漏らさない。** commit がブロックの一覧を受け、読める名前空間の参照にないブロックだけを求める。重複排除はテナントの中だけ（[ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)）。
- **名前空間ごとの順序が同期の背骨である。** 利用者のルート、共有フォルダー、チームのフォルダーがそれぞれ名前空間で、`ns_seq` と `ns_journal` を持つ。カーソルは載せた名前空間ごとの位置の組で、Web・API・デスクトップ・モバイル・Webhook が同じジャーナルを読む（[ADR-0005](../decisions/0005-namespace-journal-and-cursors.md)）。
- **ノードは ID で、名前は鍵で。** ノードは UUIDv7 の ID を持ち、移動は親と名前を変えるだけ。一意は `name_key`（NFC＋case folding）で決める（[ADR-0008](../decisions/0008-node-identity-and-names.md)）。
- **サーバーは条件つきの書き込みだけを受け、クライアントは 3 つの木で計画する。** サーバーは `base_rev` が合わなければ拒む。クライアントは Remote・Local・Synced の 3 つの木で、変わった側と衝突を決める。中身が残るほうを選ぶ（[ADR-0006](../decisions/0006-sync-conflict-model.md)）。
- **権限は、返す前に 1 つの関数で。** `can()` で名前空間・ノード・共有リンクへの操作を決める。検索・プレビュー・Webhook も同じ関数を通す（[ADR-0004](../decisions/0004-tenancy-namespaces-and-rls.md)）。

### 1.3 主要な流れ

**A. デスクトップで保存したファイルを上げる**

1. `sync-core` が OS の知らせ（Windows は ReadDirectoryChangesW と Cloud Files API の呼び出し、macOS は File Provider の拡張の呼び出し。macOS では FSEvents を使わない。[ADR-0015](../decisions/0015-local-change-observation-and-move-detection.md)）で変化を受け、大きさと更新の時刻が 2 秒変わらなくなるまで待つ。Local の木を直す。
2. 計画が、Synced と比べて「手元で変わった」と判断し、ファイルを内容で区切って分割し（[ADR-0002](../decisions/0002-chunking-and-block-addressing.md)）、ブロックのハッシュの一覧とファイルのハッシュを作る。
3. `commit`（名前空間、親のノード、名前、`base_rev`、ブロックの一覧）を送る。足りないブロックがあれば、サーバーは確定せず、足りないブロックの一覧と、ブロックごとの署名つきの PUT の URL を返す（[ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)）。
4. クライアントは S3 へブロックを並行に（既定 8 本）PUT する。URL は一時のキー（`incoming` のバケットの `u/<upload_id>/<n>`。`upload_id` は 128 ビットの乱数）を指し、SHA-256 のチェックサムを含む。`block-verifier` が S3 の計算したチェックサムを確かめ、正規のキーへ移して、ブロックの索引に入れる（[ADR-0007](../decisions/0007-block-storage-layout-on-s3.md)）。
5. クライアントが `commit` を `upload_id` つきで送り直す。`packages/committer` は、各ブロックが `have`・`copy`・`granted` のどれかであることを確かめ（[ADR-0018](../decisions/0018-upload-sessions-and-block-grants.md)）、1 つのトランザクションで、名前空間の行をロックし、`base_rev` と `name_key` を確かめ、リビジョン・ノード・ブロックの参照・`ns_seq`・`ns_journal`・outbox を書く。新しいリビジョンを返す。
6. クライアントは Synced の木を新しいリビジョンに進める。

**B. 他の端末へ届ける**

1. Relay が outbox を読み、名前空間の合図を Valkey へ流す。Notify が、その名前空間を載せた端末へ「`ns_seq` が S になった」を送る。
2. 端末は手元のカーソルで `list/continue` を呼び、変更の列（追加・変更・移動・削除）を受ける。Remote の木を直す。
3. 計画が「サーバーで変わった」と判断したファイルは、手元のブロックの索引（ハッシュから手元のファイルと位置）にないブロックだけを、署名つきの URL で `content.<brand>usercontent.<domain>` から取る。
4. 一時のファイルに組み立て、ファイルのハッシュを確かめ、手元のファイルが計画の時から変わっていないことを確かめてから、置き換える（変わっていれば C へ）。Local と Synced を進める。

**C. 2 つの端末の編集がぶつかる**

1. 端末 1 と端末 2 が、同じリビジョン r1 から同じファイルを編集する。端末 1 の `commit`（`base_rev`＝r1）が先に通り、r2 になる。
2. 端末 2 の `commit`（`base_rev`＝r1）は 409 になる。端末 2 は Remote の木を取り直し、自分の編集を `<名前> (<端末の名前> の競合コピー <YYYY-MM-DD>).<拡張子>` の新しいファイルとして commit する（中身が r2 と同じなら競合のコピーを作らない）。
3. 元の名前のファイルには r2 を置く。両方の中身が残る（[ADR-0006](../decisions/0006-sync-conflict-model.md)）。

**D. 共有リンクでダウンロードする**

1. 外部の人が `www.<brand>.<domain>/s/<トークン>` を開く。Link がトークンを引き、期限、無効化、パスワード、チームの方針（チームの外へのリンクの禁止など）を確かめる。
2. 許せば、プレビューの署名つき URL（5 分）か、ブロックの署名つき URL（15 分）を返す。フォルダーの ZIP は `export-builder` が組み立てて署名つき URL で返す（[ADR-0054](../decisions/0054-server-assembled-downloads.md)）。アクセスを記録する。

### 1.4 本家の形（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 同期エンジン | Rust の Nucleus。大部分を 1 つの決定的な制御のスレッドで動かし、疑似乱数のシミュレーションで試す | [Rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine) |
| 同期のモデル | Remote・Local・Synced の 3 つの木。Synced をマージの基準にし、3 つが収束することを目指す | [Testing our new sync engine](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine) |
| ブロック | API の `content_hash` は 4 MB の固定のブロックの SHA-256 の並びの SHA-256。保存の層は最大 4 MB の暗号化したブロックを SHA-256 で名付ける | [Content hash](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/content-hash)、[Inside the Magic Pocket](https://dropbox.tech/infrastructure/inside-the-magic-pocket) |
| 重複排除の範囲 | 公開の資料で確かめられなかった（**未検証**） | — |
| ファイルの上限 | 2 TB（2,199,019,061,248 バイト。2 TiB より 4 MiB 少ない）。ブラウザから 375 GB を超えると時間切れや中断が起きやすい | [Upload limitations](https://help.dropbox.com/sync/upload-limitations) |
| 名前 | パスは大文字小文字を区別しない。名前の大文字小文字はできるだけ保つ | [HTTP API documentation](https://www.dropbox.com/developers/documentation/http/documentation) |
| 競合 | 名前に編集した人、「conflicted copy」、日付を付けたコピーを作る。後に保存されたほうがコピーになる | [Conflicted copy](https://help.dropbox.com/organize/conflicted-copy) |
| バージョンと復元 | プランにより 30 日・180 日・365 日。Rewind はアカウントかフォルダーを時点へ戻す | [Version history overview](https://help.dropbox.com/delete-restore/version-history-overview)、[Rewind](https://help.dropbox.com/delete-restore/rewind) |
| LAN 同期 | UDP のブロードキャストで見つけ、暗号化した HTTPS の直接の接続で中身だけを送る（名前・木・権限は送らない）。File Provider 版の macOS では使えない | [LAN sync overview](https://help.dropbox.com/sync/lan-sync-overview) |
| Webhook | 本文は変更のあったアカウントの一覧だけ。アプリの秘密の HMAC-SHA256 の署名。10 秒で応答、約 10 分の指数の再試行。10 分に 35 回を超えて失敗し、失敗の率が 4.5% を超えると止める | [Webhooks](https://docs.dropboxapi.com/dropbox-api/docs/webhooks) |
| 共有リンク | 見せる相手は「リンクを知っている全員」と「チームのメンバー」。パスワード・期限・ダウンロードの禁止は Professional・Essentials・Standard・Advanced・Business・Business Plus・Enterprise | [Link expiration and passwords](https://help.dropbox.com/share/link-expiration) |
| Rewind | アカウントかフォルダーを、バージョン履歴の範囲の中の時点へ戻す。巻き戻しをさらに巻き戻せる。Basic では使えない。チームは既定で管理者だけ | [Rewind](https://help.dropbox.com/delete-restore/rewind) |
| 管理者のアクセス | 管理者は「メンバーとしてログイン」で、メンバーのフォルダーを見て、開き、削除・復元できる | [Can admins see my account?](https://help.dropbox.com/account-access/admin-control) |
| サポートの外の OS | 同期を止め、ログアウトさせる | [Dropbox no longer supports my operating system](https://help.dropbox.com/installs/computer-os-not-supported) |
| データの所在 | 主に米国。条件を満たすチームは日本などに置ける | [Where is my data stored](https://help.dropbox.com/accounts-billing/security/physical-location-data-storage) |
| 内部のメタデータの形、ジャーナル、カーソルの中身 | 公開の資料にない（**未検証**） | — |

いずれも 2026-10-09 に確認。この設計は振る舞いを参考にするが、本家のコードとプロトコルは使わない（[リポジトリ共通の ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）。

**本家との意図した違い**：

| 項目 | 本家 | 本システム | 理由・根拠 |
| --- | --- | --- | --- |
| ブロックの区切り | 4 MB の固定（API の `content_hash`） | 内容で区切る（最小 1 MiB・平均 4 MiB・最大 16 MiB） | 途中への挿入で後ろのブロックがすべてずれるのを避ける（[ADR-0002](../decisions/0002-chunking-and-block-addressing.md)）。本家の `content_hash` と同じ値は出さない |
| 重複排除 | 範囲は未検証 | テナントの中だけ。読める名前空間の参照にあるときだけ「送らなくてよい」と答える | 他人のファイルの有無を漏らさない（[ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)） |
| 保存の層 | 自社の Magic Pocket（消失訂正符号） | S3 | 耐久性は S3 に任せ、本システムは論理の耐久性を持つ（[ADR-0007](../decisions/0007-block-storage-layout-on-s3.md)） |
| データの所在 | 主に米国、条件つきで日本 | すべて日本（東京、DR は大阪） | 日本を最初の市場にする。CDN のエッジの扱いは法務の L5 |
| LAN 同期 | あり | MVP では持たない | 6 節の決定 |
| 競合のコピーの名前 | 編集した人の名前と日付 | 端末の名前と日付 | 同じ人の 2 台の衝突が多く、人の名前では見分けられない（[ADR-0006](../decisions/0006-sync-conflict-model.md)） |
| Webhook の署名のヘッダー | 本家の名前を含む | `<Brand>-Signature`（HMAC-SHA256） | リポジトリ共通の ADR-0006 |
| Webhook の署名の鍵 | アプリの秘密 | Webhook 専用の秘密（`<brand>_whsec_`、入れ替えられる）。時刻も署名に含める | アプリの秘密を受け口のサーバーに置かせない。再送の攻撃を防ぐ（[ADR-0040](../decisions/0040-signed-webhooks-delivery.md)） |
| Webhook の再試行 | 約 10 分 | 24 時間（10 秒から 1 時間ごとまで延ばす） | 受け手の短い保守の停止で通知を失わない（[ADR-0040](../decisions/0040-signed-webhooks-delivery.md)） |
| PKCE | 勧める（`S256`、`plain` もある） | すべてのアプリに `S256` だけを求める | 秘密を持つアプリでも、認可コードの横取りを PKCE で防ぐ（[ADR-0039](../decisions/0039-oauth-apps-scopes-and-rate-limits.md)） |
| 共有リンクの見せる相手 | 全員、チームのメンバー | 加えて `members`（その名前空間を既に読める人だけ） | リンクを場所の指し示しに使うとき、権限を広げない（[ADR-0027](../decisions/0027-shared-link-model-and-resolution.md)） |
| サポートの外の OS | 同期を止めてログアウトさせる | ログアウトさせず、読み出しだけにする（書き込みを 426） | 手元のファイルと資格を残し、更新を促しやすくする（[ADR-0052](../decisions/0052-client-signing-staged-rollout-and-minimum-version.md)） |
| 巻き戻しのプラン | Basic（無料）では使えない | すべてのプランで、保持の期間の中で使える | ランサムウェアからの回復を無料の利用者にも出す（[ADR-0030](../decisions/0030-restore-and-rewind-as-journaled-batches.md)）。PM が価格と合わせて見直す |
| 管理者のアクセスの形 | メンバーとしてログインする | 期限つきのアクセスの許可（最長 24 時間、`read`・`read_write`）。**法務の確認待ち（L7）** で、結論まで `release.admin-member-access` の裏 | 何を誰がいつ見たかを監査ログで追える形にする（[ADR-0043](../decisions/0043-admin-roles-device-wipe-and-member-access.md)）。L7 の結論で形を確定する |

## 2. 規模の段階

| 段階 | アカウント（個人／チームの席） | 月間の利用者 | 端末 | ノード | 物理の保存（重複排除の後） | commit のピーク | ブロックの送信のピーク | 最大のチーム | 構成 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1（MVP） | 40 万／10 万（チーム 2,000） | 25 万 | 40 万 | 25 億 | 13 PB | 5,000 件/秒 | 2 GB/秒（受信）、4 GB/秒（配信） | 3 万席、共有フォルダー 5 万 | 東京の 1 リージョン・3 AZ。Aurora の writer 1 台＋reader 2 台。S3 は大阪へ CRR。大阪にウォームスタンバイ（Aurora Global Database） |
| S2 | 400 万／100 万（チーム 2 万） | 250 万 | 400 万 | 250 億 | 130 PB | 50,000 件/秒 | 20 GB/秒・40 GB/秒 | 10 万席 | 名前空間の持ち主のテナントを単位に、複数の Aurora のクラスタへ分ける。名前空間からクラスタを引く表を持つ。OpenSearch を分ける |
| S3 | 2,000 万／500 万 | 1,200 万 | 2,000 万 | 1,250 億 | 650 PB | 250,000 件/秒 | 100 GB/秒・200 GB/秒 | 30 万席 | セル構成。テナントをセルに固定する。海外のリージョン（テナントをリージョンに固定し、アカウントの解決だけを全体で持つ） |

- 数値は本システムの想定。本家の利用者の数、ファイルの数、保存の量は、公開の資料で確かめなかった（**未検証**）。
- ノードは 1 アカウントあたり 5,000（ファイルとフォルダー）と見込んだ。共有フォルダーのノードは持ち主の名前空間で 1 回だけ数える。
- 保存は 1 アカウントあたり論理 30 GB（無料の利用者は数 GB、有料の個人とチームは数百 GB の平均）、テナントの中の重複排除で 10% 減ると見込んだ。`chunking-dedupe-poc` で確かめる。
- commit の 1 件は、1 つの名前空間への 1 回の確定（中に最大 1,000 の操作）を数える。1 日の新しいデータは保存の 0.3% と見込み、ピークは平均の 3 倍にした。
- 1 つの名前空間の書き込みは、名前空間の行のロックで直列になる。1 名前空間 1 秒 200 件を上限と見込む。チームのスペースは、チームのフォルダーをそれぞれ別の名前空間にして、ロックを分ける（[ADR-0005](../decisions/0005-namespace-journal-and-cursors.md)）。
- 段階を上げる基準は infrastructure の領域、負荷と費用のモデルは capacity の領域で決める。

### 2.1 保存の費用のモデル

物理 1 TB・月あたりの費用を、次の和で見る。単価は [infrastructure.md](infrastructure.md) の 10 節で、AWS Price List API の東京と大阪の公開の価格から入れた（約 32 USD/TB）。

```
費用/TB・月 = 東京の保存（Intelligent-Tiering の層の割合 × 層の単価 ＋ 128 KiB 未満の Standard）
            ＋ 大阪の写し（Glacier Instant Retrieval、128 KiB 未満は Standard）
            ＋ Intelligent-Tiering の監視の料金（オブジェクトの数 × 単価）
            ＋ 要求（PUT は新しいブロックの数、GET は配信のうち CloudFront で当たらなかった分）
            ＋ 削除の猶予とバージョニング（GC で消した量 × 30 日分）
            ＋ CRR の転送
```

- 平均 4 MiB のブロックでは、1 TB はおよそ 26 万オブジェクトで、オブジェクトの数に比例する料金は小さい。小さなファイル（128 KiB 未満）が多いテナントでは、オブジェクトの数が増える。小さなブロックをまとめて置く形（パック）は、S2 の前に測ってから block-storage の領域で決める。
- 配信の費用（CloudFront の外への転送）は保存とは別に、配信の量で見る。
- S1 の予算の仮の値は、物理 1 TB・月あたり 30〜45 USD（保存と写しの合計。本システムの想定）。infrastructure の領域の見積もりは約 32 USD で、この中にある。層の割合は E13 の `cost-baseline` で実測に置き換える。
- S1 の本番の月の費用は約 79 万 USD（±50%。OpenSearch を除く）で、89% が保存（13 PB × 32 USD）と配信（3.9 PB × 73 USD）である。1 アカウントあたり月 約 1.6 USD（50 万アカウント）。内訳は [capacity.md](capacity.md) の 6 節。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 応答の速さ | メタデータの読み出し（1 フォルダー 1,000 件まで）p99 300ms。`commit`（操作 100 件まで）p99 500ms。Web の一覧の表示 p95 1 秒 | 日本の中の回線 |
| NFR-002 | 伝播 | 確定から、他のオンラインの端末が変更を受けるまで p99 5 秒。1 MiB 以下のファイルが他のオンラインの端末で開けるまで p95 10 秒 | [ADR-0005](../decisions/0005-namespace-journal-and-cursors.md) |
| NFR-003 | 大きなファイル | 2 TiB までのファイル。1 Gbps の回線で送信の速さが回線の 80% 以上。途切れても、確定したブロックを送り直さない。1 ブロックの変更で送るのは、変わったブロックとブロックの一覧だけ | [ADR-0002](../decisions/0002-chunking-and-block-addressing.md) |
| NFR-004 | 同期の正しさ | 静かになった後、全端末の木がサーバーの木と一致する（選択型の同期で外したものを除く）。確定した変更を黙って消す・上書きする場合 0 件。ぶつかった変更は競合のコピーで残す | [ADR-0006](../decisions/0006-sync-conflict-model.md)、[quality.md](../quality.md) |
| NFR-005 | 耐久性 | 確定したバージョンの中身を失わない。S3 の設計の耐久性（99.999999999%）に加え、参照のあるブロックの削除 0 件。AZ の障害で RPO 0。リージョンの障害でメタデータ RPO 1 分以内・RTO 1 時間以内、中身は RPO 15 分以内（欠けたブロックは、まだ持つ端末から送り直しを求める） | [ADR-0007](../decisions/0007-block-storage-layout-on-s3.md) |
| NFR-006 | 可用性 | メタデータの API と同期 月間 99.9%。ダウンロード（ブロックの配信）月間 99.9%。共有リンク 月間 99.9% | 本家の SLA は公式の資料で確かめなかった（**未検証**） |
| NFR-007 | テナントと権限の分離 | 読めない名前空間の名前・中身・有無（重複排除の答えを含む）が、どの経路（API、同期、共有リンク、プレビュー、検索、Webhook、通知）に届いた事象 0 件 | [ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)、[ADR-0004](../decisions/0004-tenancy-namespaces-and-rls.md) |
| NFR-008 | 端末の負荷 | 100 万ファイルを持つ端末で、静かなときの CPU 1% 未満、メモリー 300 MB 以下。最初の走査（SSD、100 万ファイル）10 分以内。保存から送信の開始まで p95 3 秒（2 秒の静けさの待ちを含む） | desktop-client の領域 |
| NFR-009 | 復元 | 10 万ファイルのフォルダーの復元 10 分以内。100 万ファイルの名前空間の巻き戻し 1 時間以内。一斉の変更の検知から利用者への通知まで p95 5 分 | versions-and-recovery の領域 |
| NFR-010 | 差分の取得 | 変更 2,000 件以下の `list/continue` の応答 p99 1 秒。カーソルは最後の利用から 90 日は使える。取り直しの要求は、期限切れ・`floor_seq` より古い・`epoch` の更新のときだけ（載せた名前空間の変更では取り直しにしない） | [ADR-0005](../decisions/0005-namespace-journal-and-cursors.md) |
| NFR-011 | プレビューと検索 | サムネイル p95 2 秒（最初）、キャッシュから p95 200ms。名前の検索 p99 1 秒、変更から名前の検索に出るまで p95 60 秒、本文の検索に出るまで p95 15 分。日本語の部分一致で名前を取りこぼさない | previews-and-thumbnails、search の領域 |
| NFR-012 | Webhook とモバイル | Webhook の最初の送信 p95 30 秒、少なくとも 1 回届ける。カメラのアップロードは、OS がアプリに時間を与えてから p95 5 分で確定する | api-and-webhooks、mobile-and-camera-upload の領域 |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| サーバーの言語 | TypeScript | 他の題材と同じ（[ADR-0001](../decisions/0001-platform-and-stack.md)） |
| HTTP・検証 | Hono＋Zod | 他の題材と同じ |
| クライアントの核 | Rust の `sync-core`（監視の抽象、ローカルの状態の DB、3 つの木と計画、分割、送受信）。デスクトップ・モバイル・Web（WASM）で同じコード | [ADR-0001](../decisions/0001-platform-and-stack.md)。共通の基盤からの追加 |
| デスクトップの UI | TypeScript（React）を Tauri の WebView で。macOS の File Provider の拡張は Swift の薄い殻で `sync-core` を呼ぶ。Windows の Cloud Files API は Rust から呼ぶ | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| モバイル | Swift（iOS）・Kotlin（Android）の UI、`sync-core` を UniFFI で呼ぶ | [ADR-0001](../decisions/0001-platform-and-stack.md) |
| ローカルの状態の DB | SQLite（WAL） | 第三者の汎用の部品 |
| 分割とハッシュ | 自前の内容で区切る分割（ギアのハッシュ）、SHA-256 | [ADR-0002](../decisions/0002-chunking-and-block-addressing.md) |
| 公開 API | REST と JSON。形は本家の API の振る舞いに寄せ、名前は独自にする | api-and-webhooks の領域 |
| DB | Aurora PostgreSQL 18、FORCE RLS と `SET LOCAL`、ID は UUIDv7。`pg_partman`（ジャーナルの分割） | [ADR-0004](../decisions/0004-tenancy-namespaces-and-rls.md)、[ADR-0005](../decisions/0005-namespace-journal-and-cursors.md) |
| 中身の保存 | S3（SSE-KMS とバケットキー、SHA-256 のチェックサム、バージョニング、Intelligent-Tiering、大阪への CRR） | [ADR-0007](../decisions/0007-block-storage-layout-on-s3.md) |
| 配信 | CloudFront（OAC で S3 から、署名つき URL）。利用者の中身は `<brand>usercontent.<domain>` | security の領域 |
| 検索 | Amazon OpenSearch Service（名前は日本語の n-gram、本文は形態素と n-gram） | [ADR-0001](../decisions/0001-platform-and-stack.md)。共通の基盤からの追加 |
| プレビューの変換 | 第三者の汎用の部品（画像の変換、PDF の描画、Office の文書の変換、動画の最初の画面）を、ネットワークのない隔離した Fargate のタスクで | previews-and-thumbnails の領域 |
| キャッシュ・合図 | ElastiCache Valkey | 他の題材と同じ。失ってよい部品 |
| 非同期 | transactional outbox → SNS・SQS | 他の題材と同じ |
| 実行基盤 | AWS（東京、DR は大阪）、ECS Fargate | 他の題材と同じ |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry（ADOT）→ AMP、X-Ray、CloudWatch Logs、Managed Grafana。クライアントは匿名の計測だけ（法務の L1） | 他の題材と同じ |
| フラグ | AWS AppConfig | 他の題材と同じ |
| テスト | Vitest、fast-check（サーバーの性質）、Rust の proptest と自前の決定的な同期のシミュレーター、ファイルシステムの端の場合の試験（実の macOS・Windows の CI の機械）、Testcontainers、Playwright | [quality.md](../quality.md) |

## 5. 主な決定

どれも `accepted`。0001〜0008 は最初の設計の起票で、統合の工程で 0005・0006・0007 に日付付きの注記を足した。領域の ADR（0009〜0053）は 7 節の各領域、統合の工程で足した ADR は 0054。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤の上に、同期エンジン・分割・ブロックの索引・ジャーナルを自前で作る。クライアントの核は Rust の `sync-core` で、デスクトップ・モバイル・Web（WASM）が共有する。UI は TypeScript（Tauri）、OS の殻は Swift・Kotlin。検索に OpenSearch を足す |
| [0002](../decisions/0002-chunking-and-block-addressing.md) | ファイルを内容で区切って分割し（最小 1 MiB・平均 4 MiB・最大 16 MiB、`chunker_version` で固定）、ブロックを SHA-256 で番地付けする。ファイルのハッシュはブロックの一覧から作る。最大 2 TiB、大きな一覧は S3 に置く |
| [0003](../decisions/0003-dedupe-scope-and-privacy.md) | 重複排除はテナントの中だけ。「送らなくてよい」と答えるのは、要求した人が読める名前空間の参照にあるブロックだけで、それ以外は受け取ってから保存を重ねる |
| [0004](../decisions/0004-tenancy-namespaces-and-rls.md) | 個人とチームをテナントにし、名前空間（利用者のルート、共有フォルダー、チームのフォルダー）を持ち主のテナントに置く。名前空間の表は `app.ns_ids` の RLS で絞り、権限は `can()` の 1 つの関数で判定する |
| [0005](../decisions/0005-namespace-journal-and-cursors.md) | 名前空間ごとに単調な `ns_seq` と `ns_journal` を持ち、すべての書き込みを `packages/committer` で載せる。カーソルは載せた名前空間ごとの位置の組を署名した不透明な文字列で、最後の利用から 90 日で取り直しを求める（分割は 92 日）。`epoch` は DR の切り替えと運用者の DB の時点への戻しでだけ上げる |
| [0006](../decisions/0006-sync-conflict-model.md) | クライアントは Remote・Local・Synced の 3 つの木で計画し、サーバーは条件つきの書き込みだけを受ける（ファイルの削除は `base_rev`＋`base_node_ver`、フォルダーの削除は `base_seq`）。衝突は中身が残るほうを選び、編集どうしは競合のコピー、削除と編集は編集を残す |
| [0007](../decisions/0007-block-storage-layout-on-s3.md) | ブロックはテナントの接頭辞を持つ不変の S3 オブジェクトで、クライアントは署名つき URL で `incoming` へ直接送る。commit は `have`・`copy`・`granted` のブロックだけを受ける（ADR-0018）。SSE-KMS とバケットキー、バージョニング（削除から 30 日）、128 KiB 以上は Intelligent-Tiering、大阪へ CRR。GC は参照 0 から 7 日の猶予の後 |
| [0008](../decisions/0008-node-identity-and-names.md) | ノードは UUIDv7 の ID で指し、親と名前を持つ。名前は NFC で持ち、一意は `name_key`（NFC＋case folding）で決める。OS で表せない名前は、サーバーの名前を変えずに端末で「同期できない名前」として示す |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を核に使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **同期の誤りでの消失**：クラッシュの途中、監視の取りこぼし（OS のイベントの溢れ）、移動と削除の取り違え、時計のずれで、手元かサーバーのファイルを消す。3 つの木と意図の記録、監視の溢れでの全体の走査、決定的なシミュレーターで抑える（[ADR-0006](../decisions/0006-sync-conflict-model.md)、[quality.md](../quality.md)）。
- **名前の食い違い**：NFC と NFD、大文字小文字、Windows で表せない名前で、同じファイルが 2 つに見える、消し合う、名前の変更が往復し続ける。サーバーは `name_key` で一意にし、クライアントは手元の名前とサーバーの名前の対応を持つ（[ADR-0008](../decisions/0008-node-identity-and-names.md)）。
- **移動の検出**：OS は移動を「消えた」と「現れた」に分けて通知することがある。誤って削除と作成として扱うと、大きなフォルダーを送り直し、共有の設定とバージョン履歴が切れる。手元のファイルの ID（inode・File ID）とファイルのハッシュで移動として結び、結べなければ作成と削除の間に猶予を置く（file-system-integration の領域）。
- **大きなフォルダーの名前空間をまたぐ移動**：共有フォルダーへの 10 万ファイルの移動は、移動先の名前空間に 10 万のノードを作る。隠した入れ物に写して 1 回で出すバッチにし、その間は元の部分木を待たせる（[ADR-0022](../decisions/0022-cross-namespace-batch-move-and-copy.md)。10 万ファイルで約 8 分）。名前空間の中の移動は 1 行の変更で済む。
- **ブロックの GC の誤り**：参照の数え違い、アップロードの途中のブロックの削除で、確定したファイルの中身を失う。参照 0 から 7 日の猶予、確定の時の索引の確認、S3 のバージョニングの 30 日、毎日の参照の監査で抑える（[ADR-0007](../decisions/0007-block-storage-layout-on-s3.md)）。
- **名前空間の書き込みの集中**：大きなチームのフォルダーや自動の同期の道具で、1 つの名前空間の書き込みがロックの上限に当たる。commit に操作をまとめ、チームのフォルダーを分け、上限を超えたら 429 で待たせる（[ADR-0005](../decisions/0005-namespace-journal-and-cursors.md)）。
- **重複排除の横の漏れ**：ブロックの有無、送信の時間、容量の変化から、他人のファイルの有無を推測される。答えを読める名前空間の参照に限り、容量はテナントの論理の量で数える（[ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)）。
- **利用者のファイルを開く処理の危険**：プレビュー・抽出の部品の脆弱性を、悪意のあるファイルで突かれる。ネットワークと S3・DB・KMS の権限のない隔離したタスク、50 ジョブか 10 分での入れ替え、出力の作り直し、上限、利用者の中身の別のドメインで抑える（[ADR-0032](../decisions/0032-sandboxed-preview-pipeline.md)、[security.md](security.md) の 3.4 節）。
- **申告のハッシュを偽るクライアント**：ファイル全体の `content_sha256` はクライアントの申告で、違法なコンテンツのハッシュの照合を逃れうる。照合にはサーバーが計算した値を使う（[ADR-0046](../decisions/0046-content-scanning-framework.md)）。
- **ランサムウェアと一斉の変更**：端末の暗号化が同期で全端末とサーバーへ広がる。バージョン履歴で戻せることに加え、一斉の変更を検知して知らせ、巻き戻しを 1 回の操作にする（versions-and-recovery の領域）。
- **OS の仕組みの変化**：File Provider と Cloud Files API の振る舞いは OS の更新で変わる。OS ごとの試験の機械を CI に持ち、ベータの OS で先に回す（delivery の領域）。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L10）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-10-09、既定案）

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

### 決定（2026-10-09、統合）

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

### 決定（2026-10-09、データモデル）

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

## 7. 領域の文書

領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。0012 は使っていない（欠番）。統合の工程の ADR は 0054。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| [sync-engine.md](sync-engine.md) | 3 つの木の形、計画（変化の求め方、操作の順序、依存）、衝突の決定表、意図の記録とクラッシュからの再開、選択型の同期、帯域と並行の制御、時計に頼らない判断 | [0009](../decisions/0009-planner-dirty-set-and-ordering.md)、[0010](../decisions/0010-local-state-db-and-intent-log.md)、[0011](../decisions/0011-selective-sync-and-access-loss.md) | QA（同期の性質） | E4 |
| [desktop-client.md](desktop-client.md) | `sync-core` の組み込み、UI、状態の表示、設定、自動の更新と配布の経路、プロキシ、端末の登録と切り離し、資源の使い方の上限、LAN 同期の将来の置き場所 | [0013](../decisions/0013-desktop-process-model-and-resource-budget.md)、[0014](../decisions/0014-desktop-unlink-and-wipe-execution.md) | QA、Ops | E5 |
| [file-system-integration.md](file-system-integration.md) | 手元の変化の観測（Windows の ReadDirectoryChangesW、macOS の File Provider の呼び出し、イベントの溢れ）、移動の検出（inode・File ID）、macOS の File Provider と Windows の Cloud Files API、プレースホルダーと取り出し・追い出し、名前の対応（NFC・NFD、表せない名前）、無視するファイル、拡張属性とパーミッション、シンボリックリンク | [0015](../decisions/0015-local-change-observation-and-move-detection.md)、[0016](../decisions/0016-placeholders-and-hydration-policy.md)、[0017](../decisions/0017-local-names-and-unsyncable-items.md) | QA | E5 |
| [block-storage.md](block-storage.md) | アップロードの流れと再開、署名つき URL、ブロックの検証、ローカルのブロックの索引、ダウンロードの組み立て、大きなファイルの一覧、GC と猶予、照合（スクラブ）、小さなブロックのパック | [0018](../decisions/0018-upload-sessions-and-block-grants.md)、[0019](../decisions/0019-block-refcount-and-gc-protocol.md)、[0020](../decisions/0020-small-block-packing-for-s2.md) | QA、Ops | E2 |
| [metadata-and-journal.md](metadata-and-journal.md) | ノード・リビジョン・ジャーナルの表、`packages/committer`、操作の種類、名前空間をまたぐ移動とコピー、大きな木の一覧のページング、ジャーナルの分割と保持、カーソルの取り直し | [0021](../decisions/0021-committer-operations-and-conditions.md)、[0022](../decisions/0022-cross-namespace-batch-move-and-copy.md)、[0023](../decisions/0023-tree-listing-snapshot-and-journal-retention.md) | QA | E3 |
| [namespaces-and-sharing.md](namespaces-and-sharing.md) | 名前空間の種類、共有フォルダーの招待と参加と退出、載せる場所（マウント）、役割（持ち主・編集・閲覧）、チームのスペースとチームのフォルダー、容量の数え方、持ち主の移し替え、チームの外への共有の方針 | [0024](../decisions/0024-shared-folder-mounts-and-grants.md)、[0025](../decisions/0025-team-space-and-external-sharing-policy.md)、[0026](../decisions/0026-membership-lifecycle-and-quota.md) | セキュリティ、QA | E6 |
| [shared-links.md](shared-links.md) | リンクのトークン、見え方、パスワード、期限、ダウンロードの禁止、チームの方針、アクセスの記録、無効化、悪用の対策、違法なコンテンツの通報の入口 | [0027](../decisions/0027-shared-link-model-and-resolution.md)、[0028](../decisions/0028-shared-link-abuse-controls.md) | セキュリティ | E6 |
| [versions-and-recovery.md](versions-and-recovery.md) | リビジョンの保持、削除したファイル・フォルダーの復元、巻き戻し（時点の選び方、名前空間の単位）、一斉の変更の検知、保持の期間とプラン | [0029](../decisions/0029-revision-and-placement-retention.md)、[0030](../decisions/0030-restore-and-rewind-as-journaled-batches.md)、[0031](../decisions/0031-mass-change-detection.md) | QA、Ops | E8 |
| [previews-and-thumbnails.md](previews-and-thumbnails.md) | 対応する形式、隔離した変換、キャッシュと無効化、大きさの上限、動画の最初の画面、共有リンクのプレビュー | [0032](../decisions/0032-sandboxed-preview-pipeline.md)、[0033](../decisions/0033-preview-cache-and-delivery.md) | セキュリティ、Ops | E9 |
| [search.md](search.md) | 名前と本文の索引、日本語の解析、権限の確かめ直し、更新の遅れ、OCR の将来、S2 の分け方 | [0034](../decisions/0034-search-index-and-permission-filter.md)、[0035](../decisions/0035-ocr-deferred-to-e15.md) | QA、Ops | E9 |
| [mobile-and-camera-upload.md](mobile-and-camera-upload.md) | モバイルのアプリの範囲、カメラのアップロード（重ねない、バックグラウンドの制約、回線の条件）、オフラインの保存、通知 | [0036](../decisions/0036-camera-upload-identity-and-background.md)、[0037](../decisions/0037-mobile-offline-files-and-content-free-push.md) | QA | E10 |
| [api-and-webhooks.md](api-and-webhooks.md) | 公開の REST API、OAuth 2.0 のアプリとスコープ、レート制限、カーソルと long-poll、WebSocket の合図、Webhook（登録の確かめ、署名、再試行、停止）、サーバーで組み立てるダウンロード | [0038](../decisions/0038-public-api-shape-and-change-feeds.md)、[0039](../decisions/0039-oauth-apps-scopes-and-rate-limits.md)、[0040](../decisions/0040-signed-webhooks-delivery.md)、[0054](../decisions/0054-server-assembled-downloads.md)（統合） | QA、Ops | E11 |
| [accounts-and-teams.md](accounts-and-teams.md) | 個人のアカウント、プランと容量、チーム、SSO・SCIM、管理の役割、端末の管理、チームの外への共有の方針の管理、監査ログの画面、管理者のアクセス（法務の L7） | [0041](../decisions/0041-accounts-auth-and-device-credentials.md)、[0042](../decisions/0042-teams-sso-scim-and-plans.md)、[0043](../decisions/0043-admin-roles-device-wipe-and-member-access.md) | セキュリティ | E12 |
| [security.md](security.md) | 脅威モデル、利用者の中身のドメイン、暗号化と鍵、マルウェアと悪用の対策、違法なコンテンツの通報と開示の請求の手順（法務の L1〜L3）、監査ログ、データのライフサイクル（削除、解約） | [0044](../decisions/0044-encryption-keys-and-secrets.md)、[0045](../decisions/0045-audit-log-and-data-lifecycle.md)、[0046](../decisions/0046-content-scanning-framework.md) | セキュリティ | E1、E12、E13 |
| [data-model.md](data-model.md)、[data-model/](data-model/) | データモデルの正本：規約（ID、テナントと RLS、名前と `name_key`、ハッシュ、番号、分割、保持、暗号化、クラスタ）、ER 図、表の目録（列・キー・索引・CHECK・RLS・保持・量）、DB の外の置き場所、端末の SQLite、横断の不変条件 | なし（各領域の ADR を参照する） | QA | 全 Epic |
| [infrastructure.md](infrastructure.md) | AWS のアカウントとネットワーク、サービスの分け方、エッジ（CloudFront の配信とエッジの所在）、egress の経路、DR（大阪、中身の送り直しの依頼、`epoch`）、段階を上げる基準、S2 のシャード、S3 のセル | [0047](../decisions/0047-accounts-network-ingress-and-service-placement.md)、[0048](../decisions/0048-disaster-recovery-and-content-pending.md)、[0049](../decisions/0049-stage-up-criteria-sharding-and-cells.md) | Ops | E1、E13 |
| [observability.md](observability.md) | ログ・メトリクス・トレース、クライアントの匿名の計測、伝播と同期の健全さの計測、ブロックの参照の監査、SLI | [0050](../decisions/0050-sli-from-ledgers-synthetics-and-client-telemetry.md) | Ops | E1、E13 |
| [capacity.md](capacity.md) | 負荷のモデル（commit、合図、ブロックの送受信、プレビュー、索引）、費用のモデル（TB あたり）、部品ごとの必要量、負荷試験 | [0051](../decisions/0051-load-shaping-uploads-signals-and-reconnects.md) | Ops | E13 |
| [delivery.md](delivery.md) | CI/CD、決定的なシミュレーターとファイルシステムの試験を CI に入れる、クライアントの配布（署名、公証、ストアの審査、段階の配布、自動の更新）、フラグ、スキーマの変更の順序 | [0052](../decisions/0052-client-signing-staged-rollout-and-minimum-version.md)、[0053](../decisions/0053-protocol-compatibility-and-schema-change-ordering.md) | QA、Ops | E1、E5、E13 |

- 次に採番する ADR は 0055。

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。E1〜E13 が MVP（S1）。各 Epic の品質の重点と合否基準は [quality.md](../quality.md) の 5 節にある。

| Epic | 目的 |
| --- | --- |
| E1 | 基盤：AWS・Terraform・CI、Aurora と RLS、`packages/committer` の骨格、S3 のバケット、フラグ、可観測性、監査ログ、大阪の骨格 |
| E2 | ブロックの保存：分割、ブロックの索引、署名つき URL、検証、ダウンロードの組み立て、GC と照合 |
| E3 | メタデータとジャーナル：名前空間、ノードとリビジョン、commit、`name_key`、カーソル、Notify |
| E4 | 同期エンジン：`sync-core` の 3 つの木と計画、衝突、意図の記録、決定的なシミュレーター |
| E5 | デスクトップのクライアント：監視、macOS の File Provider、Windows の Cloud Files API、選択型の同期、UI、配布 |
| E6 | 共有：共有フォルダー、チームのスペース、`can()`、共有リンク |
| E7 | Web の画面：一覧、アップロード、ダウンロード、共有、復元 |
| E8 | バージョンと復元：バージョン履歴、削除したファイルの復元、巻き戻し、一斉の変更の検知 |
| E9 | プレビューと検索 |
| E10 | モバイルとカメラのアップロード |
| E11 | 公開 API と Webhook |
| E12 | アカウント・チーム・管理・監査 |
| E13 | 本番の準備と GA の判定：負荷試験、DR の訓練、復元の訓練、外部のペンテスト |
| E14 以降（MVP の後） | LAN 同期、OCR の検索、BYOK とエンドツーエンドの暗号化、Linux のクライアント、他社からの移行、海外のリージョン |

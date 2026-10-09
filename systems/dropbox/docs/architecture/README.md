# Architecture: Dropbox

全体像と横断的な方針。領域ごとの設計は、同じディレクトリに領域ごとのファイルとして置く（まだない。計画は 7 節）。品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO と運用は [runbooks/](../runbooks/README.md) にある。

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
| Worker | ブロックの検証・GC・照合、プレビューと本文の抽出、索引、復元と巻き戻し、一斉の変更の検知、Webhook、通知、容量の集計、監査 |
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

1. `sync-core` が OS の監視（FSEvents・ReadDirectoryChangesW、File Provider・Cloud Files の通知）で変化を受け、大きさと更新の時刻が 2 秒変わらなくなるまで待つ。Local の木を直す。
2. 計画が、Synced と比べて「手元で変わった」と判断し、ファイルを内容で区切って分割し（[ADR-0002](../decisions/0002-chunking-and-block-addressing.md)）、ブロックのハッシュの一覧とファイルのハッシュを作る。
3. `commit`（名前空間、親のノード、名前、`base_rev`、ブロックの一覧）を送る。足りないブロックがあれば、サーバーは確定せず、足りないブロックの一覧と、ブロックごとの署名つきの PUT の URL を返す（[ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)）。
4. クライアントは S3 へブロックを並行に（既定 8 本）PUT する。URL は一時のキー（`incoming/`）を指し、SHA-256 のチェックサムを含む。`block-verifier` が S3 の計算したチェックサムを確かめ、正規のキーへ移して、ブロックの索引に入れる（[ADR-0007](../decisions/0007-block-storage-layout-on-s3.md)）。
5. クライアントが `commit` を送り直す。`packages/committer` が 1 つのトランザクションで、名前空間の行をロックし、`base_rev` と `name_key` を確かめ、リビジョン・ノード・ブロックの参照・`ns_seq`・`ns_journal`・outbox を書く。新しいリビジョンを返す。
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
2. 許せば、プレビューか、ブロックを組み立てて返す配信の署名つきの URL（短い期限）を返す。アクセスを記録する。

### 1.4 本家の形（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 同期エンジン | Rust の Nucleus。大部分を 1 つの決定的な制御のスレッドで動かし、疑似乱数のシミュレーションで試す | [Rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine) |
| 同期のモデル | Remote・Local・Synced の 3 つの木。Synced をマージの基準にし、3 つが収束することを目指す | [Testing our new sync engine](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine) |
| ブロック | API の `content_hash` は 4 MB の固定のブロックの SHA-256 の並びの SHA-256。保存の層は最大 4 MB の暗号化したブロックを SHA-256 で名付ける | [Content hash](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/content-hash)、[Inside the Magic Pocket](https://dropbox.tech/infrastructure/inside-the-magic-pocket) |
| 重複排除の範囲 | 公開の資料で確かめられなかった（**未検証**） | — |
| ファイルの上限 | 2 TB。ブラウザから 375 GB を超えると失敗しやすい | [Upload limitations](https://help.dropbox.com/sync/upload-limitations) |
| 名前 | パスは大文字小文字を区別しない。名前の大文字小文字はできるだけ保つ | [HTTP API documentation](https://www.dropbox.com/developers/documentation/http/documentation) |
| 競合 | 名前に編集した人、「conflicted copy」、日付を付けたコピーを作る。後に保存されたほうがコピーになる | [Conflicted copy](https://help.dropbox.com/organize/conflicted-copy) |
| バージョンと復元 | プランにより 30 日・180 日・365 日。Rewind はアカウントかフォルダーを時点へ戻す | [Version history overview](https://help.dropbox.com/delete-restore/version-history-overview)、[Rewind](https://help.dropbox.com/delete-restore/rewind) |
| LAN 同期 | UDP のブロードキャストで見つけ、HTTPS で中身だけを送る。File Provider 版の macOS では使えない | [LAN sync overview](https://help.dropbox.com/sync/lan-sync-overview) |
| Webhook | 本文は変更のあったアカウントの一覧だけ。HMAC-SHA256 の署名。10 秒で応答、約 10 分の再試行 | [Webhooks](https://docs.dropboxapi.com/dropbox-api/docs/webhooks) |
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

物理 1 TB・月あたりの費用を、次の和で見る。単価は capacity の領域で、AWS の東京と大阪の公開の価格から入れる（S3 の価格の頁は東京の値を本文に示さず、この文書の時点で確かめられなかった。**未検証**）。

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
- S1 の予算の仮の値は、物理 1 TB・月あたり 30〜45 USD（保存と写しの合計。本システムの想定）。capacity の領域で、公開の価格と層の割合の計測で置き換える。

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
| NFR-010 | 差分の取得 | 変更 2,000 件以下の `list/continue` の応答 p99 1 秒。カーソルは最後の利用から 90 日は使える。取り直しの要求は、期限切れ・見え方の変更・`epoch` の更新のときだけ | [ADR-0005](../decisions/0005-namespace-journal-and-cursors.md) |
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

どれも `accepted`。0001〜0008 は最初の設計の起票。状態の一覧は [decisions/README.md](../decisions/README.md)。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-platform-and-stack.md) | 共通の基盤の上に、同期エンジン・分割・ブロックの索引・ジャーナルを自前で作る。クライアントの核は Rust の `sync-core` で、デスクトップ・モバイル・Web（WASM）が共有する。UI は TypeScript（Tauri）、OS の殻は Swift・Kotlin。検索に OpenSearch を足す |
| [0002](../decisions/0002-chunking-and-block-addressing.md) | ファイルを内容で区切って分割し（最小 1 MiB・平均 4 MiB・最大 16 MiB、`chunker_version` で固定）、ブロックを SHA-256 で番地付けする。ファイルのハッシュはブロックの一覧から作る。最大 2 TiB、大きな一覧は S3 に置く |
| [0003](../decisions/0003-dedupe-scope-and-privacy.md) | 重複排除はテナントの中だけ。「送らなくてよい」と答えるのは、要求した人が読める名前空間の参照にあるブロックだけで、それ以外は受け取ってから保存を重ねる |
| [0004](../decisions/0004-tenancy-namespaces-and-rls.md) | 個人とチームをテナントにし、名前空間（利用者のルート、共有フォルダー、チームのフォルダー）を持ち主のテナントに置く。名前空間の表は `app.ns_ids` の RLS で絞り、権限は `can()` の 1 つの関数で判定する |
| [0005](../decisions/0005-namespace-journal-and-cursors.md) | 名前空間ごとに単調な `ns_seq` と `ns_journal` を持ち、すべての書き込みを `packages/committer` で載せる。カーソルは載せた名前空間ごとの位置の組を署名した不透明な文字列で、90 日で取り直しを求める |
| [0006](../decisions/0006-sync-conflict-model.md) | クライアントは Remote・Local・Synced の 3 つの木で計画し、サーバーは `base_rev` つきの条件の書き込みだけを受ける。衝突は中身が残るほうを選び、編集どうしは競合のコピー、削除と編集は編集を残す |
| [0007](../decisions/0007-block-storage-layout-on-s3.md) | ブロックはテナントの接頭辞を持つ不変の S3 オブジェクトで、クライアントは署名つき URL で直接送る。SSE-KMS とバケットキー、バージョニング（削除から 30 日）、128 KiB 以上は Intelligent-Tiering、大阪へ CRR。GC は参照 0 から 7 日の猶予の後 |
| [0008](../decisions/0008-node-identity-and-names.md) | ノードは UUIDv7 の ID で指し、親と名前を持つ。名前は NFC で持ち、一意は `name_key`（NFC＋case folding）で決める。OS で表せない名前は、サーバーの名前を変えずに端末で「同期できない名前」として示す |

領域ごとの ADR は、7 節の番号の範囲で起票する。リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)、本家の実装を核に使わない規則の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **同期の誤りでの消失**：クラッシュの途中、監視の取りこぼし（OS のイベントの溢れ）、移動と削除の取り違え、時計のずれで、手元かサーバーのファイルを消す。3 つの木と意図の記録、監視の溢れでの全体の走査、決定的なシミュレーターで抑える（[ADR-0006](../decisions/0006-sync-conflict-model.md)、[quality.md](../quality.md)）。
- **名前の食い違い**：NFC と NFD、大文字小文字、Windows で表せない名前で、同じファイルが 2 つに見える、消し合う、名前の変更が往復し続ける。サーバーは `name_key` で一意にし、クライアントは手元の名前とサーバーの名前の対応を持つ（[ADR-0008](../decisions/0008-node-identity-and-names.md)）。
- **移動の検出**：OS は移動を「消えた」と「現れた」に分けて通知することがある。誤って削除と作成として扱うと、大きなフォルダーを送り直し、共有の設定とバージョン履歴が切れる。手元のファイルの ID（inode・File ID）とファイルのハッシュで移動として結び、結べなければ作成と削除の間に猶予を置く（file-system-integration の領域）。
- **大きなフォルダーの名前空間をまたぐ移動**：共有フォルダーへの 10 万ファイルの移動は、移動先の名前空間に 10 万のノードを作る。バッチの非同期の操作にし、途中の状態を端末に見せない形を metadata-and-journal の領域で決める。名前空間の中の移動は 1 行の変更で済む。
- **ブロックの GC の誤り**：参照の数え違い、アップロードの途中のブロックの削除で、確定したファイルの中身を失う。参照 0 から 7 日の猶予、確定の時の索引の確認、S3 のバージョニングの 30 日、毎日の参照の監査で抑える（[ADR-0007](../decisions/0007-block-storage-layout-on-s3.md)）。
- **名前空間の書き込みの集中**：大きなチームのフォルダーや自動の同期の道具で、1 つの名前空間の書き込みがロックの上限に当たる。commit に操作をまとめ、チームのフォルダーを分け、上限を超えたら 429 で待たせる（[ADR-0005](../decisions/0005-namespace-journal-and-cursors.md)）。
- **重複排除の横の漏れ**：ブロックの有無、送信の時間、容量の変化から、他人のファイルの有無を推測される。答えを読める名前空間の参照に限り、容量はテナントの論理の量で数える（[ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)）。
- **利用者のファイルを開く処理の危険**：プレビュー・抽出の部品の脆弱性を、悪意のあるファイルで突かれる。ネットワークのない隔離したタスク、上限、利用者の中身の別のドメインで抑える（security の領域）。
- **ランサムウェアと一斉の変更**：端末の暗号化が同期で全端末とサーバーへ広がる。バージョン履歴で戻せることに加え、一斉の変更を検知して知らせ、巻き戻しを 1 回の操作にする（versions-and-recovery の領域）。
- **OS の仕組みの変化**：File Provider と Cloud Files API の振る舞いは OS の更新で変わる。OS ごとの試験の機械を CI に持ち、ベータの OS で先に回す（delivery の領域）。
- **法令**：法務の確認待ちの事項がある（[intent.md](../intent.md) の「法務の確認待ち」の L1〜L10）。結論が出るまで、そこに挙げた Epic の spec を承認しない。

### 決定（2026-10-09、既定案）

PM の方針（本家に寄せ、判断が要るところは推奨の既定案で進める）により、最初の設計で次のとおり決めた。法務の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」に残した。どれも領域の文書の工程と E1〜E13 の PoC・試験で覆りうる。

- **分割**：内容で区切る（ギアのハッシュの分割、最小 1 MiB・平均 4 MiB・最大 16 MiB）。固定の 4 MiB より実装は増えるが、途中への挿入・削除のある大きなファイル（動画の編集の素材、仮想のディスク、データベースのファイル）で送る量が減る（[ADR-0002](../decisions/0002-chunking-and-block-addressing.md)）。
- **重複排除**：テナントの中だけ。テナントをまたぐと、保存の量は減るが、他人のファイルの有無が漏れる（[ADR-0003](../decisions/0003-dedupe-scope-and-privacy.md)）。
- **ファイルの上限**：2 TiB（本家と同じ）。
- **LAN 同期**：MVP では持たない。端末どうしの認証と鍵、チームのネットワークの方針、File Provider との両立を設計する必要があり、まずサーバーとの同期の正しさを確かめる。E14 で扱う（本家は macOS の File Provider 版で使えないとしている。[LAN sync overview](https://help.dropbox.com/sync/lan-sync-overview)、2026-10-09 に確認）。
- **検索の範囲**：MVP は名前（すべてのプラン）と本文（チームのプラン：テキスト、PDF の文字の層、Office の文書）。画像と走査した PDF の日本語の OCR は E15 へ延ばす。精度と費用を測ってから決める（search の領域で ADR にする）。
- **オンラインのみのファイル**：macOS は File Provider（replicated の拡張）、Windows は Cloud Files API に従う。カーネルの拡張は作らない。既定は「新しい端末ではオンラインのみ」で、利用者が「オフラインで使う」を選ぶ（file-system-integration の領域で ADR にする）。
- **選択型の同期**：フォルダーの単位で手元に置かないことを選べる。オンラインのみのファイルと両立し、手元に置かないフォルダーは木にも出さない（sync-engine の領域）。
- **競合のコピーの名前**：`<名前> (<端末の名前> の競合コピー <YYYY-MM-DD>).<拡張子>`。英語の設定では `<name> (conflicted copy from <device> <YYYY-MM-DD>).<ext>`。本家は利用者の名前を入れるが、本システムは端末の名前を入れる（同じ人の 2 台の衝突が多いため）。文言は法務の L10 の後に確定する（[ADR-0006](../decisions/0006-sync-conflict-model.md)）。
- **共有リンク**：閲覧だけ（編集のリンクは持たない）。パスワード・期限・ダウンロードの禁止は有料のプラン。本家のプランごとの可否は、公式の資料で一部しか確かめられなかった（**未検証**）。チームの方針で「チームの中だけ」「パスワードを必須」を強制できる（shared-links の領域）。
- **バージョンの保持の期間**：本家と同じ区分の既定（無料・個人の有料 30 日、チームの標準 180 日、チームの上位 365 日）。約束の文言は法務の L6・L8 の後（versions-and-recovery の領域）。
- **カメラのアップロード**：写真のライブラリの新しい項目を、OS の写真の ID と内容のハッシュで重ねずに上げる。元の形式（HEIC など）のまま上げ、変換はプレビューだけで行う（mobile-and-camera-upload の領域）。
- **端末への合図**：WebSocket で「名前空間の番号が進んだ」だけを送る。WebSocket が使えない環境では 60 秒ごとの確かめと long-poll に落とす（api-and-webhooks の領域）。
- **暗号化**：S3 は SSE-KMS とバケットキー。顧客の鍵（BYOK）とエンドツーエンドの暗号化は MVP の後（E16）。
- **本家の名前**：識別子は `<Brand>`・`<brand>`（リポジトリ共通の ADR-0006）。

持ち越し（法務、計測・PoC・選定で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 法務の確認待ち（L1〜L10） | [intent.md](../intent.md) の「法務の確認待ち」。結論まで、そこに挙げた Story の spec を承認しない |
| 分割の母数と重複の率 | E2 の前の `chunking-dedupe-poc` |
| 事前署名の URL でのチェックサムの強制、一時のキーから正規のキーへ移す速さと費用 | E2 の前の `presigned-upload-poc` |
| 1 名前空間の書き込みの上限（1 秒 200 件） | E3 の前の `namespace-write-throughput-poc` |
| 小さなブロックのパック | S2 の前に、オブジェクトの数と要求の費用を測って block-storage の領域で決める |
| 検索の基盤の大きさ、S2 の分け方 | E9 の前の `search-sizing-poc` |
| macOS・Windows のプレースホルダーの振る舞いの差 | E5 の前の `placeholder-platform-survey` |
| 名前空間をまたぐ大きな移動の見せ方 | metadata-and-journal の領域 |
| 費用の単価（東京・大阪の S3、CloudFront） | capacity の領域。公開の価格で入れる |
| 本家の振る舞いで未確認のもの（重複排除の範囲、共有フォルダーの容量の数え方、共有リンクのプランごとの可否、SLA、API のアップロードのセッションの上限） | 各領域の文書で公式の資料で確かめる。確かめられなければ未検証のまま、本システムの値を使う |

## 7. 領域の文書（計画）

各領域の文書は、まだない。領域の担当は、下の表の番号の範囲の中で ADR を採番する（範囲の外に出るときは、この表を先に更新する）。持ち主は、どれも Dev が書き、下の「レビュー」の列のロールが確認する。

| ファイル | 範囲 | ADR | レビュー | 関わる Epic |
| --- | --- | --- | --- | --- |
| `sync-engine.md` | 3 つの木の形、計画（変化の求め方、操作の順序、依存）、衝突の決定表、意図の記録とクラッシュからの再開、選択型の同期、帯域と並行の制御、時計に頼らない判断 | 0009–0012 | QA（同期の性質） | E4 |
| `desktop-client.md` | `sync-core` の組み込み、UI、状態の表示、設定、自動の更新と配布の経路、プロキシ、端末の登録と切り離し、資源の使い方の上限、LAN 同期の将来の置き場所 | 0013–0014 | QA、Ops | E5 |
| `file-system-integration.md` | 監視（FSEvents、ReadDirectoryChangesW、イベントの溢れ）、移動の検出（inode・File ID）、macOS の File Provider と Windows の Cloud Files API、プレースホルダーと取り出し・追い出し、名前の対応（NFC・NFD、表せない名前）、無視するファイル、拡張属性とパーミッション、シンボリックリンク | 0015–0017 | QA | E5 |
| `block-storage.md` | アップロードの流れと再開、署名つき URL、ブロックの検証、ローカルのブロックの索引、ダウンロードの組み立て、大きなファイルの一覧、GC と猶予、照合（スクラブ）、小さなブロックのパック | 0018–0020 | QA、Ops | E2 |
| `metadata-and-journal.md` | ノード・リビジョン・ジャーナルの表、`packages/committer`、操作の種類、名前空間をまたぐ移動とコピー、大きな木の一覧のページング、ジャーナルの分割と保持、カーソルの取り直し | 0021–0023 | QA | E3 |
| `namespaces-and-sharing.md` | 名前空間の種類、共有フォルダーの招待と参加と退出、載せる場所（マウント）、役割（持ち主・編集・閲覧）、チームのスペースとチームのフォルダー、容量の数え方、持ち主の移し替え、チームの外への共有の方針 | 0024–0026 | セキュリティ、QA | E6 |
| `shared-links.md` | リンクのトークン、見え方、パスワード、期限、ダウンロードの禁止、チームの方針、アクセスの記録、無効化、悪用の対策、違法なコンテンツの通報の入口 | 0027–0028 | セキュリティ | E6 |
| `versions-and-recovery.md` | リビジョンの保持、削除したファイル・フォルダーの復元、巻き戻し（時点の選び方、名前空間の単位）、一斉の変更の検知、保持の期間とプラン | 0029–0031 | QA、Ops | E8 |
| `previews-and-thumbnails.md` | 対応する形式、隔離した変換、キャッシュと無効化、大きさの上限、動画の最初の画面、共有リンクのプレビュー | 0032–0033 | セキュリティ、Ops | E9 |
| `search.md` | 名前と本文の索引、日本語の解析、権限の確かめ直し、更新の遅れ、OCR の将来、S2 の分け方 | 0034–0035 | QA、Ops | E9 |
| `mobile-and-camera-upload.md` | モバイルのアプリの範囲、カメラのアップロード（重ねない、バックグラウンドの制約、回線の条件）、オフラインの保存、通知 | 0036–0037 | QA | E10 |
| `api-and-webhooks.md` | 公開の REST API、OAuth 2.0 のアプリとスコープ、レート制限、カーソルと long-poll、WebSocket の合図、Webhook（登録の確かめ、署名、再試行、停止） | 0038–0040 | QA、Ops | E11 |
| `accounts-and-teams.md` | 個人のアカウント、プランと容量、チーム、SSO・SCIM、管理の役割、端末の管理、チームの外への共有の方針の管理、監査ログの画面、管理者のアクセス（法務の L7） | 0041–0043 | セキュリティ | E12 |
| `security.md` | 脅威モデル、利用者の中身のドメイン、暗号化と鍵、マルウェアと悪用の対策、違法なコンテンツの通報と開示の請求の手順（法務の L1〜L3）、監査ログ、データのライフサイクル（削除、解約） | 0044–0046 | セキュリティ | E1、E12、E13 |
| `data-model.md` | データモデルの索引 | なし（各領域の ADR を参照する） | QA | 全 Epic |
| `infrastructure.md` | AWS のアカウントとネットワーク、サービスの分け方、エッジ（CloudFront の配信とエッジの所在）、egress の経路、DR（大阪、中身の送り直しの依頼、`epoch`）、段階を上げる基準、S2 のシャード、S3 のセル | 0047–0049 | Ops | E1、E13 |
| `observability.md` | ログ・メトリクス・トレース、クライアントの匿名の計測、伝播と同期の健全さの計測、ブロックの参照の監査、SLI | 0050 | Ops | E1、E13 |
| `capacity.md` | 負荷のモデル（commit、合図、ブロックの送受信、プレビュー、索引）、費用のモデル（TB あたり）、部品ごとの必要量、負荷試験 | 0051 | Ops | E13 |
| `delivery.md` | CI/CD、決定的なシミュレーターとファイルシステムの試験を CI に入れる、クライアントの配布（署名、公証、ストアの審査、段階の配布、自動の更新）、フラグ、スキーマの変更の順序 | 0052–0053 | QA、Ops | E1、E5、E13 |

- 次に採番する ADR は 0054。

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

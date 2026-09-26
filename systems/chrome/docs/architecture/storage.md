# Storage: Chrome

サイトの保存領域（localStorage、sessionStorage、IndexedDB、Cache Storage）、割り当てと追い出し、Service Worker、サイトのデータの消去、シークレットモード、破損からの回復。主な決定は [ADR-0017](../decisions/0017-partitioning-by-top-level-site.md)（トップレベルのサイトによる分割）と [ADR-0018](../decisions/0018-indexeddb-on-sqlite.md)（IndexedDB を SQLite の上に作る）にある。Cookie と HTTP キャッシュは [networking.md](networking.md) にある。

## 1. 全体構成

```
Renderer（サイトごと）
   │ IPC（Browser が発行したハンドルだけ。StorageKey は Browser が決める）
   ▼
Browser プロセス ── StorageKey の決定・検査、権限、消去の指示、Service Worker の登録の管理
   │
   ▼
Storage サービス（1 つ。S2 までに別プロセス・サンドボックスへ。プロファイルの Storage/ だけに書ける）
   ├─ QuotaManager（使用量、割り当て、追い出し）
   ├─ BucketManager（StorageKey → バケット）
   ├─ DOM Storage（localStorage・sessionStorage）
   ├─ IndexedDB（SQLite。ADR-0018）
   ├─ Cache Storage（SQLite の索引＋本体のファイル）
   └─ ファイル（Blob、OPFS は MVP の後）
```

- **Renderer は StorageKey を指定しない。** Browser が、そのフレームのオリジンとトップレベルのサイトから StorageKey を決め、そのキーに結び付けたハンドル（IPC の接続）だけを Renderer に渡す。Renderer が侵害されても、別のキーの保存領域を開けない（[ADR-0003](../decisions/0003-multi-process-site-isolation.md)）。
- Storage サービスは、最初は Browser プロセスの中で動かし、S2 までに別のプロセスへ分ける（[process-model.md](process-model.md) の 5 節）。最初から IPC の境界（ハンドルと StorageKey）を別プロセスと同じ形にしておき、分けるときに呼び出しの経路を変えずに済むようにする。分ける理由は、解析の多い処理（IndexedDB のキーの比較、SQLite）を Browser から外すため。本家のデスクトップは別のプロセスで動かしている（Android だけが Browser の中。[storage_partition_impl.cc](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/storage_partition_impl.cc) の `GetStorageServiceRemote()`、2026-09-27 に確認）。

## 2. プロファイルのディスク上の配置

```
<profile>/
├── Preferences                      # 設定（browser-ui.md）
├── Network/                          # Network サービスだけが書く
│   ├── Cookies                       # SQLite
│   ├── TransportSecurity             # HSTS の動的な記録
│   └── Reporting and NEL             # SQLite
├── Cache/                            # HTTP キャッシュ（networking.md の 5.3 節）
└── Storage/                          # Storage サービスだけが書く
    ├── buckets.db                    # SQLite：StorageKey・バケット・使用量・最終利用時刻
    ├── service_workers.db            # SQLite：登録、スクリプトの版
    └── buckets/<bucket_id>/          # バケットごとのディレクトリ。名前は数値の ID
        ├── meta                      # StorageKey とバケット名（buckets.db の回復用）
        ├── local_storage.db          # SQLite
        ├── indexeddb/<db_id>.sqlite  # IndexedDB のデータベースごとに 1 ファイル
        ├── indexeddb/<db_id>.blobs/  # 大きな値・Blob の本体
        ├── cache_storage/index.db    # SQLite
        ├── cache_storage/bodies/     # 応答の本体
        └── sw_scripts/               # Service Worker のスクリプト
```

- **ディレクトリ名にサイト名を使わない。** ファイルの一覧から閲覧の履歴が読めないようにするため。サイトとの対応は `buckets.db` にだけある。
- **バケットを、保存と消去と破損の単位にする。** 1 つのバケットのファイルが壊れても、他のバケットに影響しない（12 節）。
- sessionStorage はディスクに置かない（6 節）。
- データの一覧（エンティティ、保存の期間、消去の経路）は [data-model.md](data-model.md) の索引に載せる。

## 3. 分割：StorageKey とバケット

[ADR-0017](../decisions/0017-partitioning-by-top-level-site.md) で決める。本家の Storage Partitioning（Chrome 115 から段階的に出荷。[Storage Partitioning](https://privacysandbox.google.com/cookies/storage-partitioning)）と同じ考え方にする。

| 項目 | 内容 |
| --- | --- |
| StorageKey | （オリジン、トップレベルのサイト、祖先にクロスサイトがあるかのビット）。ファーストパーティではトップレベルのサイトがオリジンのサイトと同じになる |
| 例外のキー | 匿名の iframe（`credentialless`）・fenced frame は、一時的なノンスを加えて、他と共有しない |
| 分割する API | localStorage、sessionStorage、IndexedDB、Cache Storage、Service Worker、Storage Buckets、BroadcastChannel、SharedWorker、Web Locks、Blob URL |
| バケット | StorageKey ごとに `default` のバケットを 1 つ持つ。Storage Buckets API で名前付きのバケットを足せる（MVP の後。データのモデルだけ最初から持つ） |

- 本家の、分割を一時的に解く deprecation trial（`DisableThirdPartyStoragePartitioning`）には対応しない。代わりに、Storage Access API で許可された埋め込みには、分割されない保存領域へのハンドルを渡す（本家の「Storage Access API の保存領域への拡張」に相当。仕様は Privacy CG の草案で、本家は Chrome 125 で出荷した。`requestStorageAccess({ localStorage: true, indexedDB: true, ... })` の形で求める。[saa-non-cookie-storage](https://privacycg.github.io/saa-non-cookie-storage/)、[New in Chrome 125](https://developer.chrome.com/blog/new-in-chrome-125)、2026-09-27 に確認）。

## 4. 割り当てと追い出し

### 4.1 割り当て

本家の値に揃える（[Storage for the web](https://web.dev/articles/storage-for-the-web)）。

| 項目 | 値 |
| --- | --- |
| プロファイル全体の上限 | ディスクの全容量の 80% |
| 1 つの StorageKey の上限 | ディスクの全容量の 60% |
| シークレット | メモリ上に持つので、物理メモリから決める（10 節） |
| 「終了時に Cookie とサイトデータを消去」を設定したサイト | 300 MB（本家と同じ） |

- 数える対象：IndexedDB、Cache Storage、Service Worker のスクリプト、localStorage。HTTP キャッシュは数えない。
- `navigator.storage.estimate()` は、実際の使用量を丸めて返す（ディスクの空きを正確に見せない。フィンガープリントの対策）。不透明な応答（`no-cors`）の Cache Storage への保存は、本体の大きさでなく、水増しした値で数える（本家と同じ形にする。本家の水増しは、ブラウザの起動ごとに作る乱数の鍵で、URL・応答の時刻・サイト・メソッド・付随データの大きさの HMAC-SHA256 を取り、約 14.1 MiB（14,431 KiB）で割った余り。不透明な応答とリダイレクトに付ける。[padding_key.cc](https://source.chromium.org/chromium/chromium/src/+/main:storage/common/quota/padding_key.cc)、2026-09-27 に確認）。
- 使用量は、書き込みのたびに `buckets.db` の値を増減する。起動時に全体を数え直さない。数え直しは、破損からの回復と定期の検査のときだけ行う。

### 4.2 追い出し

- **ディスクの空きが閾値を下回ったら、最後に使われた時刻が古いバケットから、バケット単位で全部を消す。** 本家も「最も長く使われていないオリジンから、そのデータをすべて」消す（同上）。
- 追い出さないもの：`navigator.storage.persist()` で永続を許されたバケット、今開いているページが使っているバケット。
- 永続の許可は、確認を出さず、条件で与える（[README.md](README.md) の「決定」。本家も確認を出さない。トップレベルのオリジンだけが対象で、Cookie がセッション限りか遮断なら与えない。インストール済みのアプリか、利用の多さ・永続の許可・ブックマーク・ホーム画面・通知の許可から選ぶ「重要なサイト」の上位 10 件なら与える。[persistent_storage_permission_context.cc](https://source.chromium.org/chromium/chromium/src/+/main:chrome/browser/storage/persistent_storage_permission_context.cc)、2026-09-27 に確認）。
- 閾値は、ディスクの全容量の 10% か 数 GB の小さい方から始め、計測で決める。

## 5. localStorage

- StorageKey ごとに 1 つ。バケットの `local_storage.db`（SQLite、1 つの表のキーと値）に保存する。
- 上限は StorageKey あたり 10 MiB（キーと値の文字数を UTF-16 で数える）。本家と同じ値（`kPerStorageAreaQuota = 10 MiB`。1 文字を 2 バイトとして、キーと値を数える。Browser の側は 100 KiB の超過を許す。[storage_area.mojom](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/public/mojom/dom_storage/storage_area.mojom)、[storage_area_map.cc](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/modules/storage/storage_area_map.cc)、2026-09-27 に確認）。
- **Renderer に全体の写しを持たせる。** localStorage は同期の API なので、ページを開いたときに Storage サービスから全件を Renderer に渡し、以後の読み取りは Renderer の中で済ませる。書き込みは非同期に Storage サービスへ送り、同じ StorageKey の他の Renderer に `storage` イベントとして配る（本家も Renderer に写しを持つ）。
- ディスクへの書き込みは、まとめて遅延させる（数秒）。Browser が落ちても、直前の数秒分を失うことを許す（仕様上も保証はない）。

## 6. sessionStorage

- タブ（最上位の閲覧の文脈）×StorageKey ごとに持つ。メモリ上だけに置き、タブを閉じたら消す。
- タブの復元（セッションの復元、閉じたタブを開き直す）のため、セッションの保存（[browser-ui.md](browser-ui.md)）と一緒にディスクへ書く。本家もセッションの復元で sessionStorage を戻す。書く先はプロファイルのセッションのファイルで、シークレットでは書かない。
- タブの複製で、写しを作る。

## 7. Service Worker

仕様は [Service Workers](https://w3c.github.io/ServiceWorker/) に従う。

### 7.1 登録と更新

- 登録は（StorageKey、スコープ）ごと。`service_workers.db` に、登録、有効・待機中の版、スクリプトの一覧を持ち、スクリプトの本体は `sw_scripts/` に置く。
- 更新の確認は、ナビゲーションのたびと、機能的なイベントのたびに行う。前回の確認から 24 時間を過ぎていれば、HTTP キャッシュを通さずに取り直す（仕様どおり）。
- スクリプトは、スコープのオリジンと同じオリジンからだけ取得する。

### 7.2 状態と寿命

```
parsed → installing → installed(waiting) → activating → activated → redundant
```

- Service Worker は、専用の Renderer で動かす。どのプロセスで動かすかは、StorageKey のサイトで決める（サイトの隔離。[process-model.md](process-model.md)）。
- **イベントがなければ、30 秒で止める。1 つのイベントの処理が 5 分を超えたら止める。** 本家と同じ値（`kServiceWorkerDefaultIdleDelayInSeconds = 30`、`kRequestTimeout = base::Minutes(5)`。[service_worker.mojom](https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/public/mojom/service_worker/service_worker.mojom)、[service_worker_version.h](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/service_worker/service_worker_version.h)、2026-09-27 に確認）。止めても登録は残り、次のイベントで起動する。
- 起動の遅さを隠すため、ナビゲーションの横取りでは、Service Worker の起動と並行して、`navigationPreload` が有効ならネットワークへのリクエストも始める。

### 7.3 fetch の横取り

| リクエスト | 経路 |
| --- | --- |
| ナビゲーション | Browser が、ナビゲーションの URL と StorageKey に合う登録を探す。あれば Service Worker を起動して `fetch` イベントを送る。応答がなければ（`respondWith` を呼ばない）ネットワークへ |
| サブリソース（制御されたページから） | Renderer が、制御している Service Worker へ直接送る（Browser を経由しない）。Service Worker からのネットワークへのリクエストは、Service Worker のファクトリ（そのオリジンで焼き込んだもの）で送る |
| 制御されていないページから | 横取りしない |

- Service Worker が返した応答も、CORS・ORB・CORP の検査を受ける（[networking.md](networking.md) の 3 節）。不透明な応答を、それを受け取れない種類のリクエストに返したら、ネットワークのエラーにする（仕様どおり）。
- 本家の Static Routing API（登録時に経路を宣言し、Service Worker の起動を省く）は MVP の後に検討する。
- Service Worker を持つサイトは、Push・Background Sync・通知を使える。これらの権限は [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) にある。

## 8. IndexedDB

[ADR-0018](../decisions/0018-indexeddb-on-sqlite.md) で決める。**SQLite の上に作る。**

- データベースごとに 1 つの SQLite のファイル。オブジェクトストアとインデックスは、SQLite の表と索引に写す。キーは、IndexedDB のキーの順序が保たれる符号化（本家の LevelDB 版と同じ考え方の、バイト列での比較で順序が合う符号化）で持つ。
- 値は、V8 の構造化の複製（structured clone）の直列化をそのまま保存する。一定の大きさ（例：64 KiB）を超える値と Blob は、`.blobs/` のファイルに出し、表には参照だけを置く。
- トランザクション：`readonly` は並行に、`readwrite` はスコープの重なる順に直列にする。SQLite の書き込みは 1 本なので、スコープが重ならない `readwrite` を並行に走らせるかは、SQLite の WAL の上で性能を計って決める。スケジュールの規則は仕様（[Indexed Database API 3.0](https://w3c.github.io/IndexedDB/)）に従う。
- SQL は Storage サービスが固定で持つものだけを実行する。サイトが SQL を書く経路はない（WebSQL とは違う）。
- SQLite は `rusqlite`（SQLite を同梱してビルドする）で使う。WAL モード、`synchronous=NORMAL`。

## 9. Cache Storage

- StorageKey ごとに、名前付きのキャッシュの集まり。索引（要求の URL・メソッド・`Vary` の対象のヘッダー・応答のヘッダー）を `cache_storage/index.db`（SQLite）に、応答の本体を `bodies/` のファイルに置く。
- `match` は `Vary` を仕様どおりに扱う（[Service Workers](https://w3c.github.io/ServiceWorker/) の Cache の節）。
- 本体の書き込みは、一時ファイルに書き終えてから索引に登録する（途中で落ちても、中途半端な応答を返さない）。索引から参照されない本体のファイルは、起動後の空き時間に消す。

## 10. シークレットモード

- 保存領域をすべてメモリの上に置く。ディスクに書かない。
  - IndexedDB：SQLite のメモリ上のデータベース（本家も、SQLite の IndexedDB を最初にシークレットで使い始めた）。
  - Cache Storage・Service Worker：メモリ上。
  - Cookie・HTTP キャッシュ：Network サービスのメモリ上（[networking.md](networking.md)）。
- 割り当ては、物理メモリの一定割合（例：10%）を全体の上限にする。本家は「ディスクの約 5%」とされる（[Storage for the web](https://web.dev/articles/storage-for-the-web)）が、メモリに置く以上、メモリで決める。値は計測で決める。
- 最後のシークレットのウィンドウを閉じたら、プロファイルのメモリ上の保存領域をすべて捨てる。
- 大きな Blob をメモリに置けないときは、書き込みを割り当ての超過（`QuotaExceededError`）として失敗させる。ディスクへの退避はしない（痕跡を残さないため）。

## 11. サイトのデータの消去

| きっかけ | 消すもの |
| --- | --- |
| 利用者の「閲覧履歴データの削除」（期間・種類を選ぶ） | 選んだ種類。期間の指定がある保存領域は、その期間に使われたバケットを丸ごと消す（バケットの中を時刻で選ばない） |
| サイトの設定から、1 つのサイトを消す | そのサイトがオリジンのサイトである StorageKey と、トップレベルのサイトである StorageKey（その下の埋め込みの分）の両方 |
| `Clear-Site-Data` ヘッダー | `cookies`・`storage`・`cache`・`executionContexts` を仕様どおりに。`storage` は、応答のオリジンの、同じ分割の StorageKey に限る |
| 追い出し（4.2 節） | バケット単位 |
| 「終了時に消去」 | ブラウザの終了時に、対象のサイトのデータ |

- 消去は Browser が指示し、Storage サービスと Network サービスがそれぞれ消す。消去の間に書き込まれないよう、対象のバケットの接続を閉じ、使っている Renderer に保存領域の喪失を通知する（ページの再読み込みを促す）。
- ファイルの削除は、まずバケットを `buckets.db` から外し（以後は見えない）、ファイルは後から消す。途中で落ちても、参照されないディレクトリを起動後に掃除する。

## 12. 破損からの回復

| 対象 | 検出 | 回復 |
| --- | --- | --- |
| バケットの SQLite（IndexedDB、localStorage、Cache Storage の索引） | 開くときの失敗、`SQLITE_CORRUPT`・`SQLITE_NOTADB` | そのデータベースだけを消して作り直す。IndexedDB はページに `UnknownError` で開けないことを返し、次に開くときは空のデータベースになる |
| `buckets.db` | 同上 | ディレクトリを走査して作り直す（StorageKey は各バケットに置いた小さなメタデータのファイルから戻す）。戻せないバケットは消す |
| `service_workers.db` | 同上 | 登録をすべて消す（次の訪問で登録し直される） |
| Cookie（`Network/Cookies`） | 同上 | 作り直す（全サイトからログアウトされる）。起動時に 1 回だけ試み、利用者に知らせない |
| HTTP キャッシュ | 索引の失敗 | キャッシュを丸ごと捨てる |

- 回復の件数を、種類ごとに数える（[observability.md](observability.md)。利用者が同意した場合だけ送る）。
- ディスクが満杯のときの書き込みの失敗は、破損と区別し、データを消さない（`QuotaExceededError` を返す）。
- ブラウザの版の間の形式の移行は、SQLite の `user_version` で版を持ち、起動時に前向きにだけ移行する。新しい形式は、1 つ前のマイルストーンの版が読める形に保つ（[data-model.md](data-model.md) の 3 節）。それより古い版のブラウザが新しい形式を見つけたら、開かずに失敗させる（ダウングレード時の破損を防ぐ）。

## 13. リスクと未解決事項

- **IndexedDB の性能**：SQLite の上で、本家の LevelDB 版と同等の性能が出るか。本家も SQLite へ移行中で、E4 で同じベンチマークで比べる（[ADR-0018](../decisions/0018-indexeddb-on-sqlite.md)）。
- **分割とサードパーティ Cookie の遮断の組み合わせ**：分割された保存領域はあるが Cookie は送られない、という状態で動く埋め込みの割合。互換性の検査で追う。
- **永続の許可の条件**：確認を出すか、条件で自動にするか。
- **OPFS（Origin Private File System）**：MVP の後。バケットの中に置く前提で、配置だけ空けておく。

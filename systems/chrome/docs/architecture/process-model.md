# Process model: Chrome

複数プロセスの構成、サイトの定義とプロセスの割り当て、IPC、クロスプロセスの iframe（OOPIF）、クラッシュからの回復。前提は、複数プロセスとサイトの隔離（[ADR-0003](../decisions/0003-multi-process-site-isolation.md)）、Rust（[ADR-0001](../decisions/0001-languages-and-platform.md)）、構造の自作（[ADR-0002](../decisions/0002-engine-build-vs-reuse.md)）。この文書で決めたことは、IPC の方式（[ADR-0006](../decisions/0006-typed-capability-ipc.md)）と、プロセスの割り当ての方針（[ADR-0007](../decisions/0007-process-allocation-policy.md)）。ナビゲーションでのプロセスの選び方は [navigation-and-loading.md](navigation-and-loading.md) にある。

本家の設計の出典：

- [Multi-process Architecture](https://www.chromium.org/developers/design-documents/multi-process-architecture/)
- [Process Model and Site Isolation](https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md)
- [Site Isolation](https://www.chromium.org/developers/design-documents/site-isolation/)
- [Out-of-Process iframes](https://www.chromium.org/developers/design-documents/oop-iframes/)
- [Mojo](https://chromium.googlesource.com/chromium/src/+/main/mojo/README.md)、[Mojo のセキュリティの注意](https://chromium.googlesource.com/chromium/src/+/main/docs/security/mojo.md)
- [侵害された Renderer への防御](https://chromium.googlesource.com/chromium/src/+/main/docs/security/compromised-renderers.md)

## 1. 原則

- **Renderer は侵害されている前提で設計する。** Renderer の中で任意のコードが動き、Spectre の類でプロセスのメモリを全部読めるとみなす（[Site Isolation の脅威モデル](https://www.chromium.org/developers/design-documents/site-isolation/)）。守る境界はプロセスで、Renderer の中の検査は性能や使い勝手のためのものであって、安全の根拠にしない。
- **1 つのプロセスには、1 つのサイトの文書しか置かない。** プロセスの数が上限を超えても、異なるサイトを同じ Renderer に混ぜない（ADR-0007）。
- **Browser は、Renderer の言う「自分は誰か」を聞かない。** 要求の主体（オリジン、サイト）は、Browser が持つ状態（プロセスに割り当てたサイト、その frame に最後にコミットした文書のオリジン）から決める。Renderer が送ってきたオリジンは、照合にだけ使う。
- **権限は、インターフェースの端点として渡す。** Renderer は、渡された端点の範囲のことしかできない。「何でもできる 1 本の IPC」を作らない（ADR-0006）。
- **信頼できない入力の解析は、特権のないプロセスで行う。** 本家の [Rule of 2](https://chromium.googlesource.com/chromium/src/+/main/docs/security/rule-of-2.md)（信頼できない入力・安全でない言語・サンドボックスなし、の 3 つのうち 2 つまで）に従う。Rust で書いた解析器でも、C/C++ の部品（画像・動画の復号器など）を通るものは、サンドボックスの中で動かす。

## 2. プロセスの種類

| プロセス | 数 | 責務 | サンドボックス |
| --- | --- | --- | --- |
| Browser | 1 | UI、タブと frame の木、ナビゲーション、履歴、プロファイル、権限、他のプロセスの起動と監視、IPC の検査 | なし（最も特権が高い） |
| Renderer | サイトごと（上限あり） | DOM、スタイル、レイアウト、JavaScript（V8）、ページの描画の記録 | 最も強い。ファイル・ネットワーク・デバイスへの直接のアクセスなし |
| GPU | 1 | 合成（Renderer と Browser の描画の結果をまとめる）、GPU への命令、ヒットテストのデータ | GPU ドライバに要るだけ緩める（OS ごと。[sandbox-and-security.md](sandbox-and-security.md)） |
| Network サービス | 1 | HTTP・TLS・DNS・キャッシュ・Cookie、ORB（[networking.md](networking.md)） | 中程度。ソケットとキャッシュのディレクトリだけ |
| Storage サービス | 1 | IndexedDB、localStorage、Cache Storage のファイル（[storage.md](storage.md)） | 最初は Browser の中で動かし、S2 までに分ける（5 節） |
| Utility | 用途ごと | 信頼できない形式の解析（画像、JSON、PDF、アーカイブ）、音声、動画の復号 | 強い。用途ごとに許可を絞る |
| 拡張機能の Renderer | 拡張機能ごと | 拡張機能のページ、Service Worker（[extensions.md](extensions.md)） | Renderer と同じ |
| クラッシュの処理 | 1 | 他のプロセスのクラッシュのダンプを取る（Crashpad を使う） | なし（他のプロセスを読むため）。送信は同意に従う（[ADR-0005](../decisions/0005-privacy-first-services.md)） |

- Service Worker、Shared Worker、Dedicated Worker は、そのオリジンのサイトの Renderer で動かす。
- Network サービスは、本家のデスクトップと同じく別のプロセスで動かし、クラッシュしたら作り直す（6 節）。
- 各プロセスの「種類」は、Browser が起動の引数で決め、子のプロセスは自分の種類を変えられない。

## 3. サイトとプロセスの割り当て

### 3.1 用語

| 用語 | 定義 | 本家の名前 |
| --- | --- | --- |
| サイト | スキーム＋登録可能ドメイン（eTLD+1）。例：`https://example.com`。Public Suffix List で決める。IP アドレスやホスト名だけのものは、ホストそのもの | site |
| 閲覧のグループ | 互いに参照を持ちうるタブと frame の集まり（`window.opener`、名前での参照）。COOP で分けられる | BrowsingInstance（HTML の browsing context group） |
| サイトの実体 | 1 つの閲覧のグループの中の、1 つのサイトの文書の集まり。同じ閲覧のグループの同じサイトの文書は、同期的に触れ合えるので、必ず同じプロセスに置く | SiteInstance |
| プロセスの鍵 | そのプロセスに置いてよいサイト（と、隔離の属性）。最初の文書を入れる前に決め、プロセスが終わるまで変えない | ProcessLock |

- プロセスの鍵には、サイトのほかに次を含める。鍵が違えば、同じサイトでも同じプロセスに置かない。
  - クロスオリジン隔離（COOP＋COEP）の有無（[navigation-and-loading.md](navigation-and-loading.md) の 4.3）
  - `Origin-Agent-Cluster: ?1` でオリジン単位の隔離を求めたか（S2。3.4）
  - サンドボックス化した iframe か（本家は 127 から、デスクトップで sandbox 属性の iframe を親と別のプロセスに置く）
  - プロファイル（通常とシークレットは、同じサイトでもプロセスを分ける。Cookie と保存領域が別なので）
- `about:blank`、`data:`、`blob:` の文書は、それを作った文書のサイトのプロセスに置く。`data:` の URL は、不透明なオリジンだが、作ったサイトのプロセスに入れる（本家と同じ）。
- 拡張機能は、拡張機能の ID をサイトとして扱う。内部のページ（`<brand>://settings` など）は、ページごとに専用のプロセスに置く（WebUI は process-per-site）。
- 内部のスキームの名前は、[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従い `<brand>://` と書く。

### 3.2 割り当ての流れ

ナビゲーションの応答を受けた時点で、最終の URL と応答のヘッダーから、行き先のサイトの実体を決める（詳しくは [navigation-and-loading.md](navigation-and-loading.md) の 5 節）。

```
行き先のサイトの実体が決まる
  │
  ├─ そのサイトの実体に、既にプロセスがある ─────────────▶ それを使う（同じグループの同じサイトは必ず同居）
  │
  ├─ 予備の Renderer があり、鍵がまだ無い ───────────────▶ 予備に鍵を掛けて使う（3.3）
  │
  ├─ 同じ鍵の既存のプロセスがあり、次のどれか ──────────▶ 再利用する
  │    ・プロセス数が上限を超えている
  │    ・行き先が iframe（同じサイトの iframe はまとめてメモリを節約する）
  │    ・行き先が process-per-site の内部ページ
  │
  └─ それ以外 ─────────────────────────────────────▶ 新しいプロセスを起動し、鍵を掛ける
```

- **上限は「目安」で、安全のために超える。** 上限を超えた状態で、同じ鍵のプロセスが無いサイトへ行くときは、新しいプロセスを起動する。本家も、上限を超えたら同じサイトのプロセスを無作為に再利用し、違うサイトは混ぜない（[Process Model](https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md)）。
- **上限は、端末のメモリから計算する。** 本家は「利用できるメモリに応じた soft limit」とだけ公開している。式は自分たちで決める：`上限 = clamp(物理メモリ ÷ Renderer の想定の大きさ（初期値 80MB） ÷ 2, 20, 200)`。本家の式は `(物理メモリの MiB ÷ 2) ÷ 85 MB`（64 ビット）で、下限 3、上限 82（[render_process_host_impl.cc](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/renderer_host/render_process_host_impl.cc) の `GetMaxRendererProcessCount()`、2026-09-27 に確認）。本家の上限は、サイトの隔離では超えてよい soft limit である。この設計の式の数値は **未検証**（本家の値に揃えるかを含む）。E3 で NFR-004（タブ 20 枚でメモリが本家の 1.2 倍以内）を測って決め直す。
- **再利用の選び方**：同じ鍵のプロセスのうち、フォアグラウンドのタブを持たず、メモリが少ないものを選ぶ。本家の「無作為」より、偏りを避けやすい。
- 再利用しても、プロセスの鍵が同じなので、侵害されたときの被害は同じサイトに閉じる。

### 3.3 予備の Renderer

- プロセスの起動（数十ミリ秒）をナビゲーションの待ち時間から外すため、鍵を掛けていない Renderer を 1 つ起動しておく（本家の spare RenderProcessHost）。
- 起動の時機：起動後の最初の画面を出した後、予備を使った直後、アドレスバーへの入力を始めたとき。
- メモリの圧迫が「中」以上のとき、または上限を超えているときは、予備を持たない。
- 予備は、鍵を掛けるまで、どのサイトのデータも持たない。鍵を掛けるのは、そのプロセスへ最初の文書を送る前（プロセスの鍵の規則）。

### 3.4 オリジン単位の隔離

- `Origin-Agent-Cluster` は、本家では既定で有効になり（`document.domain` の変更は、明示的に外さない限り効かない）、エージェントクラスタはオリジン単位になる。これは同じプロセスの中の論理的な分離で、プロセスはサイト単位のまま。MVP も同じにする。
- `Origin-Agent-Cluster: ?1` を明示したオリジンに、プロセスを分ける（オリジン単位の鍵にする）のは S2 で入れる。本家は、`Origin-Agent-Cluster: ?1` をオリジン単位のプロセスを使って「よい」という合図として扱い、保証はしない。既定でオリジン単位のプロセスにする機能（`kOriginKeyedProcessesByDefault`）は既定で無効（[process_model_and_site_isolation.md](https://source.chromium.org/chromium/chromium/src/+/main:docs/process_model_and_site_isolation.md)、[content_features.cc](https://source.chromium.org/chromium/chromium/src/+/main:content/public/common/content_features.cc)、2026-09-27 に確認）。この設計も S2 まではプロセスを分けず、S2 の前に費用を測って決める。

### 3.5 メモリの圧迫への対応

| 圧迫の段階（OS の通知） | 対応 |
| --- | --- |
| 中 | 予備の Renderer を止める。bfcache の保持数を減らす（[navigation-and-loading.md](navigation-and-loading.md) の 6 節）。各 Renderer に、キャッシュ（画像の復号済みデータ、フォント）を捨てさせる |
| 高 | bfcache をすべて捨てる。バックグラウンドのタブを、最も長く使われていないものから破棄する（プロセスを止め、履歴の項目だけを残す。タブを開いたら読み直す）。音声の再生、フォームへの未送信の入力、権限の使用中（カメラなど）のタブは破棄しない |

- タブの破棄の UI（破棄したタブの表示、除外の設定）は [browser-ui.md](browser-ui.md) で扱う。
- OS の通知は、Windows は `CreateMemoryResourceNotification`、macOS は `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE`、Linux は PSI（`/proc/pressure/memory`）を使う。Linux の閾値は **未検証**（E3 で測る）。

## 4. IPC

方式は [ADR-0006](../decisions/0006-typed-capability-ipc.md) で決めた。本家の Mojo に寄せ、型付きの IDL と、端点を権限として渡す形にする。

### 4.1 基本の部品

| 部品 | 内容 | 本家の Mojo |
| --- | --- | --- |
| メッセージのパイプ | 双方向。メッセージは順序を保つ。OS のハンドル（ファイル、共有メモリ、他のパイプの端点）を一緒に送れる | message pipe |
| インターフェース | IDL で定義したメソッドの集まり。1 本のパイプに 1 つのインターフェースを結ぶ | mojom interface |
| 送る側・受ける側 | `Remote<T>`（呼ぶ側）、`Receiver<T>`（実装する側）。未接続の端点は `PendingRemote<T>`・`PendingReceiver<T>` として、メッセージの中で送れる | Remote / Receiver |
| 関連付けたインターフェース | 複数のインターフェースのメッセージの順序を、1 本のパイプに載せてそろえる。frame の生成とナビゲーションのように、順序が意味を持つものに使う | associated interface |
| データのパイプ | 一方向のバイト列。応答の本文の流し込みに使う | data pipe |
| 共有メモリ | 読み取りのみ・書き込み可を区別して渡す。描画のデータ、大きなバッファ | shared buffer |
| 仲介 | 子のプロセスが、最初に Browser からインターフェースをもらう入口。frame ごと・Worker ごとに持ち、そこで渡すインターフェースを決める | BrowserInterfaceBroker |

- OS の上の運び方：Linux は Unix ドメインソケット（`SCM_RIGHTS` でハンドルを送る）と memfd、macOS は Mach ポート、Windows は名前付きパイプと、Browser によるハンドルの複製（子のプロセスは、自分でハンドルを他のプロセスへ複製できない）。
- 同じプロセスの中でも同じ API を使う（本家と同じ。テストで、プロセスをまたぐかどうかを差し替えられる）。

### 4.2 IDL とコード生成

- インターフェースは IDL のファイルに書き、Rust の型と、送る側・受ける側のコードを生成する。手で直列化のコードを書かない。
- 直列化は、長さと位置を先頭に持つ、固定の配置のバイナリにする（本家の Mojo の形に近い）。可変長の要素には上限を IDL に書く（例：`string<2048>`、`array<Origin, 64>`）。
- **受け取ったメッセージは、生成したコードで検査してから、実装に渡す。** 境界の外の参照、長さの不一致、未知の列挙値、`null` を許さない場所の `null`、ハンドルの数の不一致は、実装に届く前に「不正なメッセージ」として扱う（6.2）。
- 意味を持つ値には、専用の型を使う（`Origin`、`Url`、`SiteInfo`、`FilePath`、`FrameToken`）。文字列で送らない（[Mojo のセキュリティの注意](https://chromium.googlesource.com/chromium/src/+/main/docs/security/mojo.md)）。
  - 専用の型の復号は、値として正しいか（URL として解析できるか、オリジンが不透明か）まで検査する。
- 版の扱い：Browser と子のプロセスは同じビルドからしか起動しない（Linux の zygote も同じ版を保つ）ので、IDL の版の互換は要らない。版をまたぐ互換が要る IPC（拡張機能のネイティブメッセージングなど）は、この仕組みでなく、その領域で別に決める。
- IDL のファイルを変える PR は、IPC のセキュリティのレビューを必須にする（本家の [IPC Reviews](https://chromium.googlesource.com/chromium/src/+/main/docs/security/ipc-reviews.md) と同じ）。

### 4.3 権限としての端点（capability）

- Renderer が持てるのは、Browser が frame・Worker ごとに渡したインターフェースだけ。例：
  - Cookie：そのサイト用に作った `RestrictedCookieManager` の端点。別のサイトの Cookie を求める方法が、そもそも無い（本家と同じ）。
  - サブリソースの取得：`URLLoaderFactory` の端点。作るときに「要求の発信元」を Browser がコミットしたオリジンで固定し（本家の `request_initiator_origin_lock`）、Network サービスがその範囲を超える要求を拒む。
  - 保存領域：オリジンを結び付けた端点（IndexedDB、localStorage）。
- **Renderer から主体を送らせない。** 端点が主体を知っているので、メソッドの引数にオリジンを入れない。やむを得ず入れる場合（`postMessage` の送り先のオリジンなど）は、Browser がプロセスの鍵と照らす（本家の `ChildProcessSecurityPolicy::CanAccessDataForOrigin` に当たる）。
- 仲介（BrowserInterfaceBroker）は、frame のサイト・権限の状態・機能の有効化を見て、渡すかどうかを決める。試験中の機能を Renderer 側で有効にしても、Browser が渡さなければ使えない。
- 端点は、その frame の文書が変われば閉じる（文書ごとに frame の Browser 側の実体を作り直すので。[ADR-0008](../decisions/0008-browser-driven-navigation-commit.md)）。前の文書の権限が次の文書へ漏れない。

### 4.4 Browser 側での検査の一覧

侵害された Renderer を前提に、Browser 側で次を検査する。本家の [侵害された Renderer への防御](https://chromium.googlesource.com/chromium/src/+/main/docs/security/compromised-renderers.md) を、自分たちの目録として持つ。

| 対象 | 検査 |
| --- | --- |
| Cookie、保存領域、パスワードの自動入力 | 端点のオリジンが、プロセスの鍵のサイトに属すること |
| ナビゲーションのコミット | Renderer が「コミットした」と言う URL・オリジンが、Browser が送ったものと一致し、プロセスの鍵に合うこと（[navigation-and-loading.md](navigation-and-loading.md) の 5.3） |
| Renderer からのナビゲーションの開始 | 行き先が内部のスキーム・`file:` でないこと、発信元の frame が実在し、そのプロセスのものであること |
| `postMessage`、BroadcastChannel | 送り元のオリジンを Browser が付ける。Renderer の申告を使わない |
| 権限（カメラ、位置など） | 要求した frame のオリジンと、表示のオリジン（最上位の frame）を Browser が決める |
| ファイルの読み取り（`<input type=file>`、ドラッグ） | 利用者が選んだファイルだけを、そのプロセスに許可する |
| 別のサイトの応答 | Network サービスの ORB が、Renderer に届く前に止める（[networking.md](networking.md)） |
| 表示の偽装 | アドレスバーの URL・鍵の表示は、Browser が持つ状態から作る |

## 5. プロセスの起動と OS ごとの違い

| OS | 起動 | IPC の運び方 | 補足 |
| --- | --- | --- | --- |
| Windows | `CreateProcess` で、制限したトークン・ジョブ・AppContainer を付けて起動する | 名前付きパイプ。ハンドルは Browser が複製して渡す | 子のプロセスは、ハンドルを直接継承しない（明示的に渡すものだけ） |
| macOS | `posix_spawn`。Renderer・GPU・その他で別の Helper のアプリ（バンドル）を分け、エンタイトルメントを変える（本家の `Helper (Renderer).app` などと同じ構成） | Mach ポート | サンドボックスは Seatbelt。起動の直後に自分で掛ける |
| Linux | zygote から fork する。zygote は起動時に共通のライブラリを読み、名前空間と seccomp-bpf の準備をしておく | Unix ドメインソケット、memfd | zygote は、動いている間にブラウザが更新されても、子の版がずれないことも保つ（[Linux Zygote](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/zygote.md)） |

- サンドボックスの中身は [sandbox-and-security.md](sandbox-and-security.md) で決める。この文書は、プロセスの種類ごとに「どのサンドボックスの型を使うか」の対応だけを持つ。
- 本家のデスクトップは Storage サービスを別のプロセスで動かす（Android だけが Browser の中。[storage_partition_impl.cc](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/storage_partition_impl.cc) の `GetStorageServiceRemote()`、2026-09-27 に確認）。この設計は、IPC の境界を同じ形にしたうえで Browser の中で始め、S2 までに別のプロセスへ分ける（[storage.md](storage.md) の 1 節）。

## 6. クラッシュと回復

### 6.1 プロセスごとの扱い

| 落ちたもの | 利用者に見えること | 回復 |
| --- | --- | --- |
| Renderer（最上位の frame を持つ） | そのプロセスのタブが「このページは表示できません」の画面（本家の sad tab）になる。他のタブは影響なし | 再読み込みで、新しいプロセスと新しい frame の実体で開き直す。履歴は残る |
| Renderer（iframe だけを持つ） | その iframe の領域が、落ちたことを示す表示（sad frame）になる。親のページは動き続ける | 親の再読み込み、または iframe の再ナビゲーションで開き直す |
| バックグラウンドのタブの Renderer | 表示なし。タブを開いたときに sad tab を出す | 同上 |
| GPU | 一瞬画面が止まる | 作り直し、全プロセスの合成の接続を張り直す。短い間に何度も落ちるなら、ソフトウェアの描画に切り替える（本家と同じく、落ちた回数を 5 分ごとに 1 回ずつ許し、数えた回数が 3 回に達したら、次の描画の方式へ 1 段下げる。GPU のモードが変わったら数え直す。[gpu_process_host.cc](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/gpu/gpu_process_host.cc)、[fallback.md](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/gpu/fallback.md)、2026-09-27 に確認） |
| Network サービス | 読み込み中の要求が失敗する | 作り直し、各 Renderer の `URLLoaderFactory` を張り直す。Cookie・キャッシュはディスクから読み直す |
| Utility | その機能（画像の復号など）が失敗する | 次の要求で作り直す |
| Browser | ブラウザが終わる | 次の起動で、セッションの復元を提案する（[navigation-and-loading.md](navigation-and-loading.md) の 6.4） |

- 落ちたことの検知は、IPC のパイプが閉じたことと、OS のプロセスの終了の通知の両方で行う。
- 落ちたプロセスの終了の理由（クラッシュ、OOM、不正なメッセージによる強制終了、利用者による終了）を分けて数える（[observability.md](observability.md)）。
- 同じサイトで短い間にクラッシュが続く場合でも、自動の再読み込みはしない（攻撃のループを避ける）。

### 6.2 不正なメッセージ

- Renderer からの不正なメッセージ（4.2 の検査の失敗、4.4 の照合の失敗）を受けたら、**その Renderer のプロセスを終了させる**（本家の `ReportBadMessage` と同じ）。メッセージを無視して続けない。侵害されたプロセスに試行を重ねさせないため。
- 理由のコード（どの IPC の、どの検査か）を指標に記録する。Stable で特定のコードが増えたら、バグか攻撃の兆しなので調べる（runbook の候補）。
- 信頼できるプロセス（GPU、Network サービス）からの矛盾は、`assert` として扱い、Browser の中のバグとしてクラッシュ報告に載せる。

### 6.3 応答しない Renderer

- 入力イベントへの応答が一定時間（本家はデスクトップで 15 秒。`kHungRendererDelay`。[input_constants.h](https://source.chromium.org/chromium/chromium/src/+/main:components/input/input_constants.h)、2026-09-27 に確認）ないとき、「ページが応答しません」を表示し、待つか終了させるかを選ばせる。
- 同じプロセスの他のタブにも、同じ表示が出る（プロセスを共有しているため）。

## 7. OOPIF の描画と入力

異なるサイトの iframe は、別の Renderer で描画する（[OOPIF](https://www.chromium.org/developers/design-documents/oop-iframes/)）。

### 7.1 frame の木

- Browser は、タブごとに完全な frame の木を持つ。各 frame は、今どのプロセスの、どの文書が担っているかを知っている。
- 各 Renderer は、自分が担う frame（ローカル）と、他のプロセスが担う frame の代理（リモート）を持つ。代理は `window.parent`、`frames[i]`、`postMessage` の宛先として振る舞い、DOM は持たない。
- 代理への操作（`postMessage`、ナビゲーション、フォーカスの移動）は、Browser を経由して担当のプロセスへ届ける。Browser は送り元のオリジンを付ける。
- frame の名前・sandbox の属性・フレームポリシーなど、他のプロセスが知る必要のある値は、Browser が各プロセスの代理へ複製する。

### 7.2 描画

- 各 Renderer は、自分の frame の描画の結果を、GPU プロセスの合成器に「面（surface）」として出す。親の Renderer は、子の iframe の位置に、子の面を埋め込む指示だけを出す（子の中身は見えない）。
- GPU プロセスが面をまとめて 1 つの画面にする。親と子の描画の時機は独立で、子が遅いときは前のフレームか背景色を出す。
- 面の識別子は Browser が発行し、どのプロセスがどの面を埋め込めるかを Browser が決める。Renderer が他のタブの面を埋め込めないようにする。
- 描画の詳細は [rendering.md](rendering.md) で扱う。

### 7.3 入力

- 入力は、Browser がまず受け取る。GPU プロセスの合成器が持つヒットテストのデータ（面ごとの領域と変形）で、どの frame が受けるかを決め、そのプロセスへ送る。
- データだけで決まらない場合（形の複雑な切り抜き、変形）は、親の Renderer に問い合わせて決める（遅いので、上限の時間を置く）。問い合わせの答えは、親の範囲の子にしか当てはめない（親が侵害されても、関係のない frame へ入力を向けられない）。
- ドラッグ・マウスのキャプチャ・タッチの一連の操作は、最初に決めた frame に送り続ける。
- スクロールは、子で端に達したら、親へ渡す（スクロールの連鎖）。
- キーボードの入力は、フォーカスを持つ frame へ送る。フォーカスの frame は Browser が記録する。

### 7.4 frame をまたぐその他の機能

| 機能 | やり方 |
| --- | --- |
| ページ内の検索 | Browser が各プロセスに検索させ、結果を frame の木の順に並べる |
| アクセシビリティ | 各プロセスの木を、Browser が frame の木に沿ってつなぐ（[browser-ui.md](browser-ui.md)） |
| 印刷、ページの保存 | Browser が各プロセスから結果を集める |
| 表示の状態（隠れた、見えた） | Browser が frame の木に沿って各プロセスに伝える |

## 8. 指標

[observability.md](observability.md) に載せる。

- プロセスの数（種類ごと）、上限を超えた時間の割合、再利用された回数
- 予備の Renderer を使えたナビゲーションの割合
- 終了の理由ごとの数（クラッシュ、OOM、不正なメッセージのコードごと、応答なし）
- IPC の往復の遅延（主要なインターフェース）

## 9. リスクと未解決事項

- **プロセスの上限の式**：3.2 の式は仮。NFR-004 と、Renderer の典型の大きさを測って決め直す。
- **IPC の性能**：IDL から生成したコードの直列化の費用が、描画とスクロールの経路で問題になるかは、E3 で測る。
- **IPC の型の境界**：V8 のオブジェクトを IPC に直接載せない。構造化複製（`postMessage` の値）は、バイト列として運び、受け取った側の Renderer で復元する。

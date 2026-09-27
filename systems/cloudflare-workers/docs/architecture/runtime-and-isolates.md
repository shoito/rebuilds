# Runtime and Isolates: Cloudflare Workers

エッジのノードで利用者のコードを動かすランタイムの設計。workerd の取り込みと上流への追従、isolate の作成・再利用・退避、テナントのコードの動的な読み込み、互換の日付とフラグ、バンドルの形式、CPU とメモリの計測と強制を決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0001](../decisions/0001-runtime-build-vs-reuse.md) | ランタイムは workerd を元にし、多数のテナントの層は Rust で作る |
| [ADR-0002](../decisions/0002-isolation-model.md) | 共有のプロセスの V8 isolate に多層の防御を重ねる |
| [ADR-0004](../decisions/0004-config-and-code-distribution.md) | 設定とコードは変更のログとノードの LMDB で配る |
| [ADR-0006](../decisions/0006-workerd-fork-and-upstream-tracking.md) | workerd は下流のフォークにパッチの列で持ち、上流を週 1 回取り込む |
| [ADR-0007](../decisions/0007-isolate-lifecycle-and-dynamic-loading.md) | isolate はリージョンの中のシャードで温め、メモリの圧力で段階的に退避する |
| [ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md) | バンドルは ES モジュールと Wasm だけにし、互換の日付は上流の表に合わせる |
| [ADR-0009](../decisions/0009-cpu-and-memory-metering.md) | CPU 時間とメモリは isolate の単位で測り、監視のスレッドで止める |

隔離の層（seccomp、cordon、Spectre の対策）は [sandbox-and-security.md](sandbox-and-security.md)、Web API と `request.<brand>` は [web-apis-and-compat.md](web-apis-and-compat.md) にある。入口のプロキシ、ノードの間の振り分け、外向きのプロキシは [edge-network-and-routing.md](edge-network-and-routing.md)、版とコードの配布は [deployment-and-config-distribution.md](deployment-and-config-distribution.md)、制限の値と課金は [limits-and-billing.md](limits-and-billing.md) にある。

本家の振る舞い・数値は、2026-09-27 に workerd の GitHub、本家のブログ、Workers の文書で確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| workerd のフォークの方針、パッチの一覧、上流の取り込みの頻度 | V8 のセキュリティの修正の緊急の経路（sandbox-and-security、[ADR-0012](../decisions/0012-v8-24-hour-patch-pipeline.md)） |
| ランタイムのプロセスの中の isolate の作成・再利用・退避 | プロセスのサンドボックスと cordon（sandbox-and-security） |
| テナントのコードの読み込み（ノードのキャッシュから isolate へ） | コードの S3 への置き方とノードへの配布（deployment-and-config-distribution） |
| バンドルの形式、アップロード時の検証、互換の日付とフラグ | CLI のバンドラーの実装（developer-tooling） |
| CPU 時間・メモリの計測と強制、呼び出しの結果の記録 | 制限の値の最終の決定、課金の集計（limits-and-billing） |
| リージョンの中で同じ関数を同じノードへ寄せる方針（ランタイムの側） | 入口のプロキシでのハッシュの実装（edge-network-and-routing） |

## 2. 本家と上流の仕組み（確かめたこと）

| 項目 | 本家・上流 | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| isolate の起動 | 約 5ms。Lambda のコールドスタートは 500ms〜10 秒と比べている。isolate のメモリは約 3MB（Node の Lambda は約 35MB） | [Cloud Computing without Containers](https://blog.cloudflare.com/cloud-computing-without-containers/)（2018-11-09） |
| TLS の握手での先読み | ClientHello の SNI を見て、そのホスト名の Worker を先に読み込む。起動は約 5ms で、利用者との往復の方が長いので、コールドスタートが見えなくなる | [Eliminating cold starts with Cloudflare Workers](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/)（2020-07-30） |
| データセンターの中のシャード | Worker のスクリプトのハッシュを一貫性ハッシュの環に置き、「ホームのサーバー」へ要求を寄せる。転送は Cap'n Proto RPC。ホームが断ったら、元のサーバーで動かす。退避の率が 10 分の 1 になり、温かい要求の割合が 99.9% から 99.99% に上がった。シャードを要したのは Enterprise の通信の 4% | [Eliminating Cold Starts 2: shard and conquer](https://blog.cloudflare.com/eliminating-cold-starts-2-shard-and-conquer/)（2025-09-26） |
| 退避 | isolate は長く生きるとは限らない。機械の資源の不足、怪しいスクリプト、個別の制限の超過で退避する。退避はイベントが解決した後に行う | [How Workers works](https://developers.cloudflare.com/workers/reference/how-workers-works/) |
| 並行 | 1 つの isolate は、単一のスレッドのイベントループで複数の要求を並行に処理しうる | 同上 |
| CPU 時間 | 無料 10ms。有料は既定 30 秒、最大 5 分（300,000ms）。ネットワークの待ちは数えない。平均は 1 要求あたり約 2.2ms。isolate には、ときどきの超過を許す「組み込みの余裕」がある。超えるとエラー 1102（`exceededCpu`） | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| メモリ | isolate あたり 128MB。JavaScript のヒープと Wasm の割り当てを含む。呼び出しごとではなく isolate ごと。超えるとエラー 1102（`exceededMemory`） | 同上 |
| 大きさ | 圧縮前 64MiB。圧縮後の上限はない | 同上 |
| 起動の時間 | グローバルのスコープ（トップレベルのコード）の解析と実行を 1 秒以内。超えるとデプロイを拒否（エラー 10021） | 同上 |
| 大きさと起動の上限の変遷 | 圧縮後 1MB から、有料 10MB・無料 3MB へ。起動の CPU 時間は 200ms から 400ms へ（2025-09 の時点） | shard and conquer の記事 |
| workerd の版 | 版の番号は、対応する互換の日付の最大値。設定は Cap'n Proto の形式。ビルドは Bazel（clang 22 以上）。Apache-2.0 | [workerd の README](https://github.com/cloudflare/workerd) |
| workerd の配布 | ほぼ毎日、`v1.YYYYMMDD.N` の形で公開（2026-09-14〜09-27 の 14 日に 15 版） | [workerd の Releases](https://github.com/cloudflare/workerd/releases) |
| workerd の V8 | V8 15.4.80.5 に、上流が 41 のパッチを当てている（`build/deps/v8.MODULE.bazel`） | [workerd の main](https://github.com/cloudflare/workerd/blob/main/build/deps/v8.MODULE.bazel) |
| V8 の追従 | ランタイムは少なくとも週 1 回、Chrome の Stable と同じ以上の V8 に更新する | [Web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/) |
| 動的な読み込み | workerd に `workerLoader` のバインディングがある。名前で Worker を読み込み、使われない Worker を自動で降ろすキャッシュを兼ねる。本家の `load()` は毎回新しい Worker、`get(id)` は ID で isolate を使い回しうる（保証はない） | [workerd.capnp](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp)、[Dynamic Workers の API](https://developers.cloudflare.com/dynamic-workers/api-reference/) |
| 制限の強制 | 公開版の workerd は `NullIsolateLimitEnforcer`（「制限を強制しない」とコメントされている）を使う。CPU 時間の報告も 0 | [server.c++](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/server.c%2B%2B) |
| 互換の日付 | 古い互換の日付を永久に支える。API で日付を省くと、最も古い 2021-11-02 になる | [Compatibility dates](https://developers.cloudflare.com/workers/configuration/compatibility-dates/) |

**ADR-0001 の未検証の点のうち、2 つがこれで分かった。** 動的な読み込みは上流の `workerLoader` が持つ。テナントごとの CPU・メモリの制限は、上流の公開版にない（`IsolateLimitEnforcer` の差し込み口だけがある）。制限の強制は自前のパッチで作る（6 節、[ADR-0009](../decisions/0009-cpu-and-memory-metering.md)）。

## 3. 原則

- **上流との差分を最小にする。** 差分は、パッチの一覧に理由と「上流に送るか」を書く（[ADR-0006](../decisions/0006-workerd-fork-and-upstream-tracking.md)）。
- **要求の処理の経路で、制御プレーンを呼ばない。** コードと設定は、ノードの手元の写し（LMDB とコードのキャッシュ）からだけ読む（ADR-0004）。
- **制限の超過は、その isolate の中で止める。** 同じプロセスの他のテナントに影響させない（NFR-005）。
- **isolate の再利用は、同じ版の同じ関数の中だけにする。** 別の関数・別の版・別のテナントと isolate を共有しない。

## 4. workerd の取り込みと上流への追従

[ADR-0006](../decisions/0006-workerd-fork-and-upstream-tracking.md)。

### 4.1 リポジトリとパッチの列

```
上流 cloudflare/workerd（main、毎日のタグ v1.YYYYMMDD.N）
   │ 週 1 回（月曜）に最新のタグを取り込む
   ▼
下流の <brand>-workerd（開発リポジトリの中）
   ├─ upstream/          上流のタグをそのまま（サブモジュールではなく、取り込みのコミット）
   ├─ patches/workerd/   0001-*.patch …（git format-patch の形）
   ├─ patches/v8/        上流が当てる 41 に足す、自分たちの V8 のパッチ（原則 0）
   ├─ patches/PATCHES.md パッチの一覧（下の表の形）
   └─ BUILD の上書き    V8 のビルドのフラグ（サンドボックスの有効化の確認など）
```

- パッチは「上流に積んだ差分」として持つ。フォークの枝で直接コミットを重ねない。取り込みのたびに、新しいタグにパッチの列を当て直す（rebase）。
- 1 つのパッチは 1 つの目的にする。パッチの一覧に、次を書く。

| 列 | 内容 |
| --- | --- |
| 番号・名前 | `0003-isolate-limit-enforcer.patch` |
| 分類 | `upstreamable`（上流に送る）、`brand`（名前の置き換え）、`multitenant`（多数のテナントの層との接続）、`security`（上流の修正の先取り） |
| 理由 | なぜ要るか。関係する ADR |
| 上流の状態 | 送った PR の URL、または「送らない」の理由 |
| 持ち主 | Dev のチーム |
| 消す条件 | 上流に入ったら消す、など |

### 4.2 S1 の時点のパッチの見込み

| パッチ | 分類 | 内容 |
| --- | --- | --- |
| isolate の制限の強制 | `multitenant` | `IsolateLimitEnforcer` の実装（CPU 時間・メモリ・起動の時間。6 節）。上流の差し込み口に実装を足すだけにし、上流のコードを変えない |
| テナントのローダー | `multitenant` | `workerLoader` を元に、ノードのコードのキャッシュ（内容のハッシュ）から Worker を読み込む口。スーパーバイザーの指示で読み込み・退避する（5 節） |
| 呼び出しの結果の記録 | `multitenant` | CPU 時間・壁時計の時間・結果・サブリクエストの数を、スーパーバイザーへ Unix ドメインソケットで送る |
| `request.<brand>` | `brand` | 本家の `request.cf` に当たる属性の名前を置き換える（[web-apis-and-compat.md](web-apis-and-compat.md) の 5 節） |
| `navigator.userAgent` などの名前 | `brand` | 本家の名前の値を `<Brand>` の値にする |
| seccomp の適用の順序 | `multitenant` | プロセスの初期化の後、isolate を読み込む前に seccomp を適用できる口（[sandbox-and-security.md](sandbox-and-security.md) の 4 節） |

- 目標：`multitenant` と `brand` のパッチの合計を、S1 で 3,000 行以内に保つ。超えたら、上流への提案か、外側の Rust の部品への移動を検討する。
- `upstreamable` のパッチは、作ってから 30 日以内に上流へ PR を送る。

### 4.3 取り込みの頻度と流れ

| 経路 | 頻度 | 中身 | 本番への届き方 |
| --- | --- | --- | --- |
| 定期の取り込み | 週 1 回（月曜の朝） | 最新の上流のタグ | ステージングで 2 日、本番は段階的に 3 日（[ADR-0006](../decisions/0006-workerd-fork-and-upstream-tracking.md) の段） |
| 緊急の取り込み | V8 の Critical・High の修正の公開のとき | 上流の修正のタグ、または自分たちで V8 に当てた修正 | 24 時間以内（[ADR-0012](../decisions/0012-v8-24-hour-patch-pipeline.md)） |
| 毎日の検査 | 毎日 | 上流の最新のタグにパッチの列が当たるか、テストが通るか | 本番には出さない。当たらなければ、その日のうちにチケット（ADR-0001） |

```
月曜 06:00 JST  取り込みのジョブ：最新のタグ → パッチの列を当てる → ビルド（Bazel、ASan・UBSan の版も）
                 ├─ 当たらない → チケット。前の週の版のまま
                 └─ 当たる → テスト（上流のテスト、WPT の対象、脱出のテスト、性能の比較）
月曜〜水曜      ステージングのフリートで動かす。性能の退行（起動の p99、CPU 時間の中央値）を比べる
水曜〜金曜      本番を段階的に：カナリアのノード 1% → 1 リージョン → 全リージョン
```

- **性能の退行の門**：ステージングで、同じ合成の関数の集まりに対し、isolate の起動の p99 が 10% 以上、CPU 時間の中央値が 5% 以上悪くなったら、本番に出さない。
- **互換の日付の最大値**：ランタイムの版の番号は、上流と同じく対応する互換の日付の最大値にする。フリートに 2 つの版が混ざる間、デプロイで受け付ける互換の日付の最大値は、フリートの中の最も古い版の値にする（[ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md)）。
- 取り込みで上流の API が変わり、自分たちのパッチが大きく壊れたときは、その週の取り込みを飛ばしてよい。**2 週続けて飛ばしたら、Dev のテックリードへ上げる。** V8 のセキュリティの修正は、飛ばした週でも緊急の経路で届ける。

## 5. isolate の作成・再利用・退避

[ADR-0007](../decisions/0007-isolate-lifecycle-and-dynamic-loading.md)。

### 5.1 ノードの中の構成

```
エッジのノード（EC2）
 ├─ 入口のプロキシ（Rust）……TLS の終端、ルートの解決、同じリージョンのホームのノードへの転送
 ├─ スーパーバイザー（Rust）……ランタイムのプロセスの起動・監視、テナントの配置、退避の指示
 │    │ Unix ドメインソケット（制御）
 │    ▼
 ├─ ランタイムのプロセス（workerd を元にしたもの） × cordon ごとに 1 つ以上
 │    ├─ isolate A（関数 f1 の版 v3）
 │    ├─ isolate B（関数 f2 の版 v1）
 │    └─ 空の isolate の予備（プロセスの起動時に作る）
 ├─ 外向きのプロキシ（Rust）
 └─ 設定の写し（LMDB）とコードのキャッシュ（gp3 とページキャッシュ。ADR-0050）
```

- isolate の鍵は `(account_id, script_id, version_id)`。同じ鍵の要求だけが同じ isolate を使う。
- 1 つの isolate は、1 つのスレッドのイベントループで複数の要求を並行に処理する（本家と同じ）。同時に CPU を使うのは 1 つの要求だけ（ADR-0002）。
- 1 つのランタイムのプロセスは、複数のワーカーのスレッドを持つ。isolate は、あるときに 1 つのスレッドだけがロックを持って動かす。スレッドの数は vCPU の数に合わせる（値は capacity の領域で決める）。

### 5.2 要求が来たときの流れ

```
1. 入口のプロキシ：ClientHello の SNI からルートの候補を引く
     → ホームのノードへ「先読み」を送る（本家の TLS の握手の先読みと同じ考え）
2. 入口のプロキシ：HTTP の要求からルートを解決し、関数と版を決める
     → 一貫性ハッシュで、リージョンの中のホームのノードを決め、転送する（5.4 節）
3. ホームのノードのスーパーバイザー：鍵の isolate がどのプロセスにあるかを引く
   ├─ ある（温かい）→ そのプロセスへ要求を渡す
   └─ ない（冷たい）
        a. cordon から、載せるプロセスを選ぶ（sandbox-and-security の 5 節）
        b. コードのキャッシュにバンドルがあるか
             └─ ない → リージョンの S3・中継のキャッシュから取り、SHA-256 を確かめる（ADR-0004）
        c. プロセスに「読み込み」を指示：空の isolate の予備を 1 つ取り、バンドルを読み込む
             - V8 のコードのキャッシュ（後述）があれば使う
             - トップレベルのコードを実行する（起動の CPU 時間の上限 1 秒）
        d. 要求を渡す
4. ランタイム：fetch のハンドラーを呼ぶ。CPU 時間・メモリを測る（6 節）
5. 応答を返し、呼び出しの結果をスーパーバイザーへ送る
```

**冷たい起動の予算**（NFR-001 の 5ms。バンドル 1MiB 以下、コードがノードにあり、トップレベルの実行を除く）：

| 段 | 目標 p99 | 手段 |
| --- | --- | --- |
| スーパーバイザーの判断 | 0.2ms | メモリの中の表を引くだけ |
| バンドルの読み出し | 0.5ms | ページキャッシュ（よく使うバンドル）と gp3。mmap。ノードはローカルの NVMe を持たない（[ADR-0050](../decisions/0050-runtime-fleet-instance-types.md)） |
| isolate の用意 | 1.0ms | 空の isolate の予備（ランタイムの API を組み込んだ V8 のスナップショットから作ったもの）を取る |
| モジュールの解析とコンパイル | 3.0ms | V8 のコードのキャッシュを使う。遅延のコンパイル（関数は呼ばれるまでコンパイルしない） |
| 余裕 | 0.3ms | |

- **空の isolate の予備**：各ランタイムのプロセスは、テナントのコードを読み込む前の isolate を、既定で 8 個持つ。1 つ使ったら、裏で 1 つ作り足す。予備はどのテナントのコードも読んでいない状態で、一度テナントのコードを読んだ isolate は予備に戻さない。予備の数は、冷たい起動の率から自動で 4〜32 の間で調整する。**workerd がこの形（テナントのコードの前に isolate を作っておく）を許すかは未検証。** E2 の PoC で確かめ、許さなければ、V8 のスナップショットからの作成の速さで代える。
- **V8 のコードのキャッシュ**：バンドルを最初に読み込んだノードは、V8 のコードのキャッシュ（バイトコード）を作り、ノードのディスクに `(bundle_sha256, v8_version, v8_flags_hash)` の鍵で置く。同じノードの別のプロセスの次の読み込みで使う。**ノードの間では共有しない**（別のノードが作ったキャッシュを信じる理由がなく、V8 はキャッシュの中身の改ざんに耐える設計ではない）。
- **コードがノードにないとき**（NFR-001 の後半、p99 50ms 以内）：リージョンの中継のキャッシュから取る。デプロイのとき、各リージョンのホームのノードへ先に配る（deployment-and-config-distribution の領域で決める）。

### 5.3 退避

[ADR-0007](../decisions/0007-isolate-lifecycle-and-dynamic-loading.md)。

退避には 4 つの理由がある。

| 理由 | いつ | どう退避するか |
| --- | --- | --- |
| 使われていない | 最後の要求から 15 分、かつプロセスのメモリが予算の 50% を超えている | 処理中の要求がないときに捨てる |
| メモリの圧力 | プロセスのメモリが予算の 70%（soft）を超えた | 下の順で、処理中の要求がない isolate から捨てる。85%（hard）を超えたら、新しい isolate を受け付けず、ほかのプロセス・ノードへ回す |
| 制限の超過 | その isolate が CPU 時間・メモリの上限を超えた | 6 節。処理中の要求をエラーにし、isolate を捨てる |
| 版の切り替え・停止 | 新しい版のデプロイ、関数・アカウントの停止 | 古い版の isolate は新しい要求を受けず、処理中の要求が終わるか 30 秒で捨てる。停止は即時に捨てる |
| 疑わしい振る舞い | 性能カウンターで怪しいと判断した | 専用のプロセスへ移す（[sandbox-and-security.md](sandbox-and-security.md) の 6.3 節） |

**メモリの圧力での退避の順**：スコアの大きいものから捨てる。

```
score = (いまの時刻 − 最後の要求の時刻)[秒] × isolate のメモリ[MiB] ÷ 重み
重み：専用の cordon 4、有料 2、無料 1
```

- 処理中の要求がある isolate は、soft の段では捨てない。hard の段で、他に捨てるものがないときだけ、最も新しく作った isolate の処理中の要求を 503 相当のエラー（`<Brand>` のエラーの番号。limits-and-billing で決める）にして捨てる。
- **プロセスのメモリの予算**：cgroup v2 の `memory.max` を、そのプロセスの予算の 110% にする（[sandbox-and-security.md](sandbox-and-security.md) の 4.3 節）。cgroup の OOM は、プロセスの中の全テナントを落とすので、soft・hard の退避で必ずその前に止める。**プロセスの OOM は重大な事象として数え、runbooks の対象にする。**
- 退避の率（1 分あたりの退避の数 ÷ 温かい isolate の数）と、冷たい起動の率を、ノードとリージョンの指標にする。

### 5.4 リージョンの中のシャード

- 本家の shard and conquer（2 節）に寄せる。リージョンの中で、関数の版の鍵を一貫性ハッシュの環に置き、ホームのノードを決める。入口のプロキシは、ホームのノードへ転送する。**要求の多い関数は、1 つのホームに収まらないので、ホームのノードの負荷（CPU の使用率 70% 以上）で断り、元のノードで動かす。**
- 本家は、断ったときに Cap'n Proto の「元のノードの能力」を返して往復を減らす。この設計では、ホームのノードは 1 往復で「断る」を返し、入口のプロキシが自分のノードで動かす。
- 転送の実装（プロトコル、環の大きさ、ノードの増減での移動）は edge-network-and-routing の領域で決める。ランタイムの側は、転送された要求を、直接の要求と同じに扱う。

### 5.5 ランタイムのプロセスの入れ替え

- 定期の入れ替え（1 日 1 回。Spectre の対策と、メモリの断片化の解消）は [sandbox-and-security.md](sandbox-and-security.md) の 6.4 節。
- 入れ替えは、新しいプロセスを起動し、新しい要求をそちらへ向け、古いプロセスの処理中の要求が終わるのを最大 30 秒待ってから止める。WebSocket と長い要求は、30 秒で切る。Durable Objects に相当するものの実体の移動は durable-objects の領域で決める。

## 6. CPU 時間とメモリの計測と強制

[ADR-0009](../decisions/0009-cpu-and-memory-metering.md)。

### 6.1 CPU 時間

- **測るもの**：isolate のロックを持って JavaScript・Wasm を動かしている間の、そのスレッドの CPU 時間（`CLOCK_THREAD_CPUTIME_ID`）。ロックに入るときと出るときに読み、要求ごとに足す。I/O の待ちは数えない（本家と同じ）。
- **ガーベジコレクション**：その isolate のヒープの GC は、その isolate の CPU 時間に含める（主スレッドで動く分）。並行の GC のスレッドの時間は、要求には数えず、ノードの指標にだけ出す。
- **強制**：プロセスごとに 1 つの監視のスレッドが、1ms ごとに、動いている各要求の CPU 時間を見る。上限を超えたら `v8::Isolate::TerminateExecution()` を呼ぶ。NFR-005（上限＋10ms 以内に止める）を満たす。
- **止めたあと**：その要求はエラー（`exceededCpu`）。同じ isolate の他の要求は続ける。ただし、止めた後に isolate の状態が壊れている恐れがあるので、**同じ isolate で 3 回続けて止めたら、その isolate を捨てる**。
- **余裕**：本家は、ときどきの超過を許す「組み込みの余裕」を持つ（2 節）。S1 は余裕を持たず、上限で止める（テストしやすさを先にする）。値は 12 節の問い。
- **上限**（既定案。値は limits-and-billing で決める）：

| 計画 | 1 要求の CPU 時間 | cron の 1 回 | キューの消費者の 1 回（1 束） | 起動（トップレベル） |
| --- | --- | --- | --- | --- |
| 無料 | 10ms | 10ms | 10ms | 1 秒 |
| 有料 | 既定 30 秒、設定で最大 5 分 | 30 秒（間隔 1 時間未満）、15 分（1 時間以上） | 既定 30 秒、設定で最大 5 分（壁時計は 15 分。本家と同じ。[queues-and-cron.md](queues-and-cron.md) の 4.3 節） | 1 秒 |

- **無料の 10ms の精度**：1ms ごとの検査なので、止めるのは 10〜11ms の間。NFR-005 の「上限＋10ms」を満たす。
- **起動の CPU 時間**：トップレベルのコードの実行を 1 秒で止める。アップロード時の検証（7.3 節）で 1 秒を超えたら、デプロイを拒否する。本番の読み込みで超えたら（ノードの性能の差で）、その要求をエラーにし、関数の指標に出す。

### 6.2 メモリ

- **上限**：isolate あたり 128MiB。JavaScript のヒープと、外のメモリ（`ArrayBuffer` の中身、Wasm の線形メモリ）の合計。本家と同じく isolate の単位で、要求の単位ではない。
- **測り方**：V8 のヒープの大きさと、外のメモリの量（V8 の `AdjustAmountOfExternalAllocatedMemory` に届く量）を足す。上流の workerd の V8 のパッチ（0020・0030。ヒープと外のメモリの大きさを分けて取る API）を使う。
- **強制**：
  - V8 のヒープの上限を 128MiB より少し大きく（144MiB）設定し、`NearHeapLimitCallback` で、上限に近づいたら GC を強く促す。
  - 要求の終わりと、1 秒ごとの検査で、合計が 128MiB を超えていたら、その isolate の処理中の要求をすべてエラー（`exceededMemory`）にし、`TerminateExecution()` の後に isolate を捨てる。
  - Wasm の `memory.grow` と大きな `ArrayBuffer` の割り当ては、割り当ての時点で上限を超えるなら、その割り当てを失敗させる（`RangeError`）。
- **他のテナントへの影響**：1 つの isolate の破棄は、同じプロセスの他の isolate を止めない。退避の処理がスレッドを長く止めないよう、isolate の破棄は処理中の要求がないスレッドで行う。**NFR-005 の「他のテナントの p99 を 1ms 以上悪くしない」は、負荷試験で確かめる**（10 節）。

### 6.3 呼び出しの結果の記録

ランタイムは、呼び出しごとに次の記録をスーパーバイザーへ送る。スーパーバイザーはまとめて、使用量の集計（limits-and-billing）と観測（observability）へ流す。

| 欄 | 内容 |
| --- | --- |
| `account_id`、`script_id`、`version_id` | どの関数のどの版か |
| `invocation_id` | 呼び出しの ID（ULID） |
| `trigger` | `fetch`・`scheduled`・`queue`・`alarm`・`websocket` |
| `outcome` | `ok`・`exception`・`exceededCpu`・`exceededMemory`・`exceededStartup`・`canceled`（利用者が切断）・`evicted`・`internalError` |
| `cpu_us`、`wall_ms` | CPU 時間（マイクロ秒）と壁時計の時間 |
| `subrequests` | サブリクエストの数（外向きのプロキシが数えた値と突き合わせる） |
| `cold` | 冷たい起動だったか。`cold_start_us`（isolate の用意からハンドラーを呼ぶまで） |
| `cordon`、`node_id`、`runtime_version` | どこで動いたか |

- 課金に使う CPU 時間は `cpu_us`。記録が届かなかった呼び出しは課金しない（利用者に不利にしない）。

## 7. テナントのコードの読み込みとバンドル

[ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md)。

### 7.1 バンドルの形式

```
bundle（アップロードの単位。変えられない）
 ├─ manifest.json
 │    { "main_module": "index.js",
 │      "modules": [ {"name":"index.js","type":"esm","sha256":"…"},
 │                   {"name":"lib/argon2.wasm","type":"wasm","sha256":"…"},
 │                   {"name":"schema.json","type":"json","sha256":"…"} ],
 │      "compatibility_date": "2026-09-01",
 │      "compatibility_flags": ["…"],
 │      "bindings": [ … ]（deployment-and-config-distribution で決める） }
 └─ 各モジュールの本体
```

| モジュールの種類 | 受け付けるか | 備考 |
| --- | --- | --- |
| `esm`（ES モジュール） | 受け付ける | 主な形 |
| `cjs`（CommonJS） | 受け付ける | npm の依存のため。上流の workerd の CommonJS のモジュールの扱いに従う |
| `wasm` | 受け付ける | コンパイル済みではなく、Wasm のバイナリ。ランタイムが読み込み時にコンパイルする。`import` で `WebAssembly.Module` を得る |
| `text`・`data`・`json` | 受け付ける | 文字列、`ArrayBuffer`、JSON の値 |
| `py`（Python） | 受け付けない | 本家は Python Workers を持つが、起動が遅い。MVP の後に需要を見る |
| サービスワーカーの形（`addEventListener('fetch')`） | 受け付けない | 本家は古い形として持つ。この基盤は新しく、ES モジュールだけにする |

- **実行時のコードの生成は許さない**（本家と同じ。[web-apis-and-compat.md](web-apis-and-compat.md) の 4.3 節）：`eval()`、`new Function`、`WebAssembly.compile`、バッファからの `WebAssembly.instantiate`、`compileStreaming`、`instantiateStreaming`。Wasm は、バンドルの `wasm` のモジュールとしてだけ受け付ける。**これにより、実行されるすべてのコードは、アップロード時に内容のハッシュで固定され、検査できる。**
- **大きさの上限**（既定案。値は limits-and-billing で決める）：

| 項目 | 無料 | 有料 | 本家（2 節） |
| --- | --- | --- | --- |
| バンドルの圧縮後（gzip） | 3MiB | 10MiB | 上限なし（以前は無料 3MB・有料 10MB） |
| バンドルの圧縮前 | 32MiB | 64MiB | 64MiB |
| モジュールの数 | 1,000 | 1,000 | 資料で確かめられず（未検証） |
| 起動の CPU 時間 | 1 秒 | 1 秒 | 1 秒 |

- 本家は圧縮後の上限をなくしたが、S1 は残す。ノードのコードのキャッシュの容量と、冷たいノードへの転送の時間（NFR-001 の後半）を守るため。圧縮前は本家と同じ 64MiB を上限にする。

### 7.2 読み込みの流れ（ノードの中）

1. スーパーバイザーは、設定の写しから版の `bundle_sha256` を引く。
2. コードのキャッシュ（`/var/lib/<brand>/code/<sha256>`）になければ、取得して SHA-256 を照合し、読み込み専用で置く。
3. ランタイムのプロセスへ「読み込み」を送る：`{isolate_key, bundle_path, manifest, compat_date, flags, bindings, limits}`。
4. ランタイムは、テナントのローダー（4.2 節のパッチ）で、マニフェストのモジュールを 1 つずつ登録する。**モジュールの名前の解決は、マニフェストの中だけで行う**（ファイルシステムを見ない。ランタイムのプロセスはファイルシステムの系のシステムコールを使えない。[sandbox-and-security.md](sandbox-and-security.md) の 4.2 節）。
   - バンドルは、スーパーバイザーが開いたファイルの記述子（読み込み専用の memfd）で渡す。ランタイムはパスを開かない。
5. 互換の日付とフラグから、この isolate の API の形を決める（8 節）。
6. トップレベルのコードを実行する（起動の CPU 時間を測る）。

### 7.3 アップロード時の検証

アップロードは制御プレーンで受けるが、**利用者のコードを制御プレーンのプロセスで動かさない。** 検証は、別の AWS アカウントの、エッジのノードと同じサンドボックスの構成の「検証のフリート」で行う。

| 検証 | 失敗したら |
| --- | --- |
| マニフェストの形（Zod）、モジュールの SHA-256、大きさの上限 | 400 で拒否 |
| 互換の日付が範囲の中か（8 節）、フラグが既知か、実験のフラグを含まないか | 400 で拒否 |
| ES モジュールの解析（構文）、`import` の名前がバンドルの中で解決するか | 400 で拒否 |
| Wasm のモジュールの検証（`WebAssembly.validate` 相当） | 400 で拒否 |
| トップレベルの実行が 1 秒の CPU 時間の中で終わるか | 400 で拒否（本家のエラー 10021 に当たる） |
| 起動の時間の計測（`startup_time_ms` を応答に返す） | 拒否しない。CLI に表示する |

- 検証のフリートは、エッジのノードと同じ版のランタイムを使う。検証の isolate は、1 回ごとに捨てる。
- 検証のフリートは、ネットワークに出られない（外向きのプロキシを持たない）。トップレベルでの `fetch` は、そもそも要求の外なので本番でも許されない（本家はタイマーも要求の文脈の中だけ）。

## 8. 互換の日付とフラグ

[ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md)。

- **上流の互換の日付とフラグの表を、そのまま使う。** 上流のフラグの名前・既定で有効になる日付・意味を変えない。workerd を元にしているので、表は取り込んだ上流の版に含まれる（`compatibility-date.capnp`）。本家の文書のフラグの説明が、この基盤でもそのまま当てはまるようにする。
- 例：2026-08-04 以降の日付では、Node.js の互換（`nodejs_compat`・`nodejs_compat_v2`）が既定で有効になる（[Compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)、2026-09-27 に確認）。この基盤でも同じ日付で同じにする。ただし、MVP で持たない API（TCP のソケット）は別に閉じる（[web-apis-and-compat.md](web-apis-and-compat.md) の 6 節）。
- **自分たちのフラグ**：ブランドの置き換えなど、上流にない振る舞いの切り替えが要るときだけ、`<brand>_` で始まる名前のフラグを足す。上流の名前と重ならないようにする。S1 の時点では 0 個を目標にする。
- **デプロイで受け付ける日付の範囲**：

| 条件 | 扱い |
| --- | --- |
| 日付がない | 拒否する（本家の API は最も古い日付 2021-11-02 を既定にするが、この基盤は明示を求める。CLI は `init` で当日の日付を書く） |
| 2021-11-02 より前 | 拒否する |
| フリートの中の最も古いランタイムの版が支える最大の日付より後 | 拒否する（「この日付はまだ使えない」） |
| 実験のフラグ（上流で `$experimental` の印の付いたもの） | 本番では拒否する。ローカル開発（CLI）だけで使える |

- **古い日付を永久に支える**（本家と同じ）。互換の日付を固定した関数は、ランタイムの版が上がっても、その日付の振る舞いを受け続ける（intent の守るべき振る舞い）。
- **例外**：セキュリティの修正のために古い振る舞いを変えざるを得ないときは、影響する関数の持ち主に事前に連絡する（本家と同じ方針）。変える判断は Dev のテックリードとセキュリティの担当が行い、ADR に残す。
- **試験**：互換の日付ごとの振る舞いは、上流のテスト（フラグごとの有効・無効のテスト）をそのまま回す。加えて、本番で使われている互換の日付の上位 20 個で、合成の関数の集まりを毎週の取り込みのたびに回す（10 節）。

## 9. 障害の型

| 障害 | 検知 | 振る舞い |
| --- | --- | --- |
| ランタイムのプロセスの異常終了（V8 の欠陥、自分たちのパッチの欠陥） | スーパーバイザーがプロセスの終了を受ける | そのプロセスの処理中の要求は 502 相当のエラー。スーパーバイザーは同じ cordon のプロセスを起動し直す。isolate は次の要求で冷たく作り直す。同じ関数の読み込みの直後に 3 回続けて落ちたら、その版をそのノードで隔離し（読み込まない）、セキュリティの担当へ知らせる（脱出の試みの疑い） |
| 落ちては起動する繰り返し | 5 分に 5 回以上の再起動 | ノードの健全性を下げ、入口のプロキシが新しい要求を他のノードへ回す。runbooks |
| プロセスの OOM（cgroup） | cgroup の `memory.events` | 上と同じ。退避の閾値（70%・85%）の見直しの対象。重大な事象として数える |
| 冷たい起動の嵐（デプロイの直後、ノードの追加の直後） | 冷たい起動の率が 5% を超える | ホームのノードへの先読み、空の isolate の予備の増加。runbooks |
| コードのキャッシュにない、取得も失敗 | 取得の失敗 | その要求は 503 相当。リージョンの中継、別のリージョンの S3 の順に取り直す |
| 上流の取り込みでパッチが当たらない | 毎日の検査 | 本番は前の版のまま。チケット。2 週続けて飛ばしたら Dev のテックリードへ |
| 新しいランタイムの版で性能が退行 | ステージングの比較、カナリアの指標 | 本番へ出さない。本番で見つかったら、前の版へ戻す（ランタイムの版はノードに 2 つ置き、切り替えで戻す） |
| 互換の日付の振る舞いが版の更新で変わった（退行） | 毎週の互換の試験、利用者の報告 | 前の版へ戻し、上流へ報告する |
| 監視のスレッドが止まる（CPU 時間の強制が効かない） | 監視のスレッドの生存の心拍 | プロセスを入れ替える。心拍が 100ms 途切れたら、スーパーバイザーがプロセスに SIGKILL を送る |

## 10. セキュリティ

- 利用者のコードは、常に悪意があるものとして扱う（AGENTS.md）。マニフェスト・モジュールの名前・Wasm は、アップロード時と読み込み時の両方で検証する。
- ランタイムのプロセスは、バンドルをファイルの記述子で受け、自分でパスを開かない。seccomp でファイルシステムの系のシステムコールを禁止する前提を崩さない（[sandbox-and-security.md](sandbox-and-security.md)）。
- isolate は、同じ鍵（テナント・関数・版）の中だけで再利用する。空の isolate の予備は、テナントのコードを一度でも読んだら予備に戻さない。
- V8 のコードのキャッシュは、同じノードで自分たちが作ったものだけを使う。ノードの間で共有しない。
- 自分たちの C++ のパッチには、ASan・UBSan のビルドとファズの対象を付ける（ADR-0001）。パッチの一覧の `multitenant` の変更は `security:sensitive` のラベルを付ける。
- 利用者のコードを、制御プレーンのプロセスで動かさない。アップロード時の検証は、別のアカウントの検証のフリートで行う。
- CPU 時間・メモリの強制が効かない状態（監視のスレッドの停止）は、隔離の欠陥として扱う（1 つのテナントがスレッドを占有し、他のテナントを止めうる）。

## 11. テスト

| 種類 | 対象 | 確かめること |
| --- | --- | --- |
| 単体 | 退避のスコア、日付の範囲の判定、マニフェストの検証 | 表駆動。境界（日付の最小・最大、大きさの上限ちょうど） |
| 性質ベース | 退避 | 任意の要求の列とメモリの割り当ての列で、処理中の要求のある isolate を soft の段で捨てない。プロセスのメモリが `memory.max` を超えない |
| 性質ベース | isolate の鍵 | 任意の要求の列で、別の `(account_id, script_id, version_id)` の要求が同じ isolate に渡らない |
| 結合 | CPU 時間 | 無限ループの関数が、無料で 10〜20ms、有料の上限＋10ms 以内で止まり、`exceededCpu` が記録される。同じ isolate の別の要求は続く |
| 結合 | メモリ | 128MiB を超えて確保する関数（JavaScript の配列、`ArrayBuffer`、Wasm の `memory.grow`）が `exceededMemory` で止まり、同じプロセスの他の isolate が続く |
| 結合 | 起動 | トップレベルで 1 秒を超える関数のアップロードが拒否される |
| 結合 | 実行時のコードの生成 | `eval`・`new Function`・`WebAssembly.compile` などが例外になる |
| 負荷 | NFR-001 | 1MiB の合成の関数で、冷たい起動の p99 5ms 未満（コードがノードにある）、50ms 以内（ない） |
| 負荷 | NFR-005 | 同じプロセスで、CPU 時間の上限を超える isolate とメモリの上限を超える isolate を混ぜたとき、他のテナントの p99 の悪化が 1ms 未満 |
| 取り込みの CI | 上流の追従 | 上流の最新のタグにパッチが当たり、上流のテスト・WPT の対象・脱出のテストが通る（毎日） |
| 互換 | 互換の日付 | 本番の上位 20 の互換の日付で、合成の関数の集まりの応答が前の版と同じ（毎週） |
| ファズ | マニフェストとバンドルの解析、テナントのローダー | AGENTS.md の「ファズを止めない」 |

テスト名には要件の ID を含める（開発リポジトリの `specs/` で採番する）。

## 12. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0006](../decisions/0006-workerd-fork-and-upstream-tracking.md) | workerd は下流のリポジトリにパッチの列で持ち、上流の最新のタグを週 1 回取り込む。毎日パッチが当たるかを確かめる |
| [0007](../decisions/0007-isolate-lifecycle-and-dynamic-loading.md) | isolate は `(account, script, version)` の鍵で再利用し、空の isolate の予備・リージョンの中のシャード・SNI の先読みで温め、メモリの圧力で段階的に退避する。テナントのコードは上流の `workerLoader` を元にしたローダーで読み込む |
| [0008](../decisions/0008-bundle-format-and-compatibility-dates.md) | バンドルは ES モジュール・CommonJS・Wasm・データだけにし、実行時のコードの生成を禁じる。互換の日付とフラグは上流の表をそのまま使い、日付の明示を求める |
| [0009](../decisions/0009-cpu-and-memory-metering.md) | CPU 時間はスレッドの CPU 時計で測り、1ms ごとの監視のスレッドで止める。メモリはヒープと外のメモリの合計を isolate ごとに 128MiB で止める。`IsolateLimitEnforcer` を自前で実装する |

## 13. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E2 | PoC：公開版の workerd の `workerLoader` で、テナントのコードを動的に読み込み・降ろせるか、空の isolate を先に作れるかを確かめる（着手の最初） |
| E2 | 下流のリポジトリ、パッチの列、`PATCHES.md`、毎日のパッチの当て直しの CI |
| E2 | 週 1 回の取り込みのジョブと、性能の退行の門 |
| E2 | `IsolateLimitEnforcer` の実装（CPU 時間の監視のスレッド、メモリの計測、起動の時間） |
| E2 | テナントのローダー（memfd でのバンドルの受け渡し、マニフェストの中だけの名前の解決） |
| E2 | スーパーバイザーの isolate の表、退避のスコアと soft・hard の閾値 |
| E2 | 空の isolate の予備と V8 のコードのキャッシュ |
| E2 | 呼び出しの結果の記録と、スーパーバイザーへの送信 |
| E2 | 互換の日付の範囲の判定と、実験のフラグの拒否 |
| E4 | SNI の先読みと、リージョンの中のシャード（ホームのノードへの転送。edge-network-and-routing と合わせて） |
| E5 | アップロード時の検証のフリート（別のアカウント、1 回ごとに捨てる isolate） |
| E6 | CLI の `init` で互換の日付を当日にする。`deploy` で `startup_time_ms` を表示する |
| E11 | 呼び出しの結果の記録を、使用量の集計へ流す（`cpu_us`） |
| E1 | ランタイムのプロセスの cgroup のメモリの予算と、ノードの型ごとの isolate の数の見積もり（capacity と合わせて） |

## 14. 未解決の問い

- 空の isolate の予備を、上流の workerd の構造のまま作れるか（テナントのコードの前に isolate とランタイムの API を用意できるか）。
- CPU 時間の「組み込みの余裕」（本家はときどきの超過を許す）を持つか。持つなら、どの程度か。
- 圧縮後の上限を、本家のようになくすか。ノードのコードのキャッシュの容量と、冷たいノードでの取得の時間の見積もり次第。
- リージョンの中のシャードの環の大きさと、ノードの増減での isolate の移動の費用。edge-network-and-routing と capacity で決める。
- ランタイムの版をノードに 2 つ置く（戻すため）ときのディスクとメモリの費用。
- 上流が大きな構造の変更（設定の形式、`workerLoader` の API）をしたとき、週 1 回の取り込みを保てるか。

### 決定

2026-09-27 の既定案。

- 空の isolate の予備は、E2 の PoC で上流の構造のまま作れなければ、パッチで無理に作らない。V8 のスナップショットとコードのキャッシュで NFR-001 を満たせるかを先に計る。満たせなければ、NFR-001 の見直しを PM・Dev に諮る。
- CPU 時間の余裕は S1 で持たない。上限で止める。利用者の問い合わせと `exceededCpu` の率を見て、S2 の前に見直す。
- 圧縮後の上限（無料 3MiB・有料 10MiB）は S1 で残す。S2 で、キャッシュの容量の実測から外すかを決める。
- ランタイムの版は、ノードに 2 つ（いまの版と前の版）置く。
- 上流の大きな変更で取り込みが 2 週続けて止まったら、Dev のテックリードが、その変更に合わせてパッチを書き直すか、上流への提案で解くかを決める。

## 15. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：制限の強制の欠陥で、1 つのテナントが同じプロセスの他のテナントを止める。CPU 時間・メモリの結合テストと、NFR-005 の負荷試験。
- リスク：上流の取り込みで、互換の日付の振る舞いが変わる。互換の上位 20 の日付の毎週の試験。
- リスク：自分たちの C++ のパッチの欠陥。ASan・UBSan のビルド、ファズ、パッチの行数の目標（3,000 行）。
- 本番での検証：各リージョンの合成の関数で、冷たい起動と温かい起動の遅延を 1 分ごとに計る（NFR-001）。

**runbooks**

- `runtime-crash-loop`：ランタイムのプロセスが 5 分に 5 回以上落ちる。直近の版・関数の特定、版の隔離、ランタイムの版の切り戻し。
- `runtime-process-oom`：cgroup の OOM。退避の閾値の確認、該当のテナントの特定。
- `cold-start-storm`：冷たい起動の率が 5% を超える。予備の数、先読み、シャードの状態の確認。
- `upstream-rebase-blocked`：週 1 回の取り込みが止まった。パッチの書き直しの判断と、V8 の修正の緊急の経路が生きていることの確認。
- `runtime-rollback`：ランタイムの版の切り戻し（ノードの 2 つの版の切り替え）。
- SLI の追加の依頼（Ops へ）：冷たい起動の率と時間（p50・p99）、退避の率（理由ごと）、`exceededCpu`・`exceededMemory` の率、プロセスの再起動の数、監視のスレッドの心拍の途切れ。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `runtime_releases`（制御プレーン） | `version`（`v1.YYYYMMDD.N` の下流の版）、`upstream_tag`、`v8_version`、`max_compat_date`、`patch_set_sha`、`status`（`staging`・`canary`・`rolling`・`active`・`retired`）、`created_at` | テナントの表ではない（RLS なし） |
| `runtime_patches`（下流のリポジトリの `PATCHES.md` を正本とし、表にも写す） | `number`、`name`、`category`、`reason`、`upstream_pr`、`owner`、`remove_when` | 同上 |
| `script_versions` に足す列（deployment-and-config-distribution の表） | `compatibility_date`、`compatibility_flags`、`bundle_sha256`、`bundle_size_compressed`、`bundle_size_uncompressed`、`startup_time_ms` | RLS。表の持ち主は deployment-and-config-distribution |
| 呼び出しの結果（ログの保存。observability と limits-and-billing） | 6.3 節の欄 | `account_id` で分ける |
| ノードのコードのキャッシュ（ノードのディスク） | `/var/lib/<brand>/code/<sha256>`、V8 のコードのキャッシュ `(bundle_sha256, v8_version, v8_flags_hash)` | ノードの中だけ。共有しない |

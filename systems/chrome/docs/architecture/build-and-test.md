# Build and test: Chrome

開発リポジトリの構成、ビルドの仕組み、キャッシュ、CI の段、テストの層、ファズ、不安定なテストの扱い、対応するプラットフォーム、再現できるビルド。

| 対象 | 方針 |
| --- | --- |
| ビルドの仕組み | [ADR-0030](../decisions/0030-build-system.md) |
| CI の段、WPT、リリースのブランチ | [ADR-0031](../decisions/0031-ci-tiers-wpt-and-release-branches.md) |
| リリースと配信 | [update-and-release.md](update-and-release.md) |
| CI の実行環境（AWS） | [infrastructure.md](infrastructure.md) の 6 節 |
| 品質の戦略と判定の基準 | [quality.md](../quality.md)（QA） |

数値のうち「初期見積もり」と書いたものは、実際のビルドの前の仮の値である。

## 1. 開発リポジトリの構成

1 つのリポジトリ（モノレポ）にする。ブラウザとサービスのプロトコル（更新、同期、Safe Browsing、クラッシュ）を、1 つの PR で両側とも変えられるようにするため。

```
browser/
├── Cargo.toml                 # Rust のワークスペース
├── rust-toolchain.toml        # Rust のツールチェーンを固定
├── crates/                    # 自作の Rust（ADR-0002 の「自作する」）
│   ├── browser/               #   Browser プロセス（UI、ナビゲーション、プロファイル）
│   ├── renderer/  layout/  dom/  style_glue/
│   ├── net/  storage/  ipc/  sandbox/
│   ├── extensions/  sync_client/  safe_browsing/
│   ├── updater/               #   アップデータ（別のプログラム）
│   ├── crash/                 #   Crashpad の登録（FFI）
│   └── v8_bindings/ ...       #   部品との境界。unsafe はここに集める
├── third_party/
│   ├── manifest.toml          # 部品の目録（名前、版、ライセンス、上流、成果物のハッシュ）。ADR-0002
│   ├── rust/                  # crates.io の依存を cargo vendor で置く
│   └── native/                # C/C++ の部品のレシピ（v8、crashpad、harfbuzz、skia など）
│       └── <name>/build.toml  #   上流の版、ビルドの方法（GN・CMake）、成果物の名前
├── services/                  # クラウドのサービス（TypeScript。Slack の構成に倣う）
├── proto/                     # ブラウザとサービスの間のプロトコルの定義
├── tests/
│   ├── browser_tests/         # ブラウザ全体を起動する結合テスト
│   ├── wpt/                   # WPT（固定した版の写し）と、期待値のメタデータ
│   ├── pixel/                 # 画面の比較のテスト
│   └── perf/                  # 性能の測定の設定
├── fuzz/                      # cargo-fuzz のターゲット
├── tools/                     # 開発・CI の道具
└── infra/                     # Terraform（Slack の ADR-0020 に倣う）
```

- 自作のコードは Rust だけにする（ADR-0001）。C/C++ は `third_party/native/` のレシピから作る成果物としてだけ持ち、ソースを直接は編集しない。上流への修正が要るときは、パッチをレシピの隣に置き、目録に理由を書く。
- `unsafe` を含んでよいのは、部品との境界のクレート（`*_bindings`、`sandbox`、`crash` など、目録に書いたもの）だけにする。それ以外のクレートは `#![forbid(unsafe_code)]` にし、CI で確かめる（ADR-0001、題材の AGENTS.md）。

## 2. ビルドの仕組み（ADR-0030）

**Cargo を基本にし、C/C++ の部品は、それぞれ上流のビルド（GN・CMake）で別に作った成果物を、内容のハッシュで固定して使う。** コンパイルのキャッシュは sccache に S3 を付けて使う。Bazel と GN（Rust を含めた全体）は採らない。

| 選択肢 | 良い点 | 採らない理由 |
| --- | --- | --- |
| Cargo ＋ 事前ビルドの C++ の成果物（採用） | Rust のエコシステムと道具（rust-analyzer、cargo-fuzz、cargo-deny）がそのまま使える。エージェントが最も扱い慣れている | — |
| GN ＋ Siso（本家と同じ） | 本家は Rust も GN のテンプレートで作り、crates.io の依存を `//third_party/rust` に取り込む（[Chromium の Rust](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/rust/README.md)）。Siso は Ninja と互換で、リモート実行を内蔵する（[Siso の README](https://chromium.googlesource.com/build/+/refs/heads/main/siso/README.md)） | Rust が主で C++ が部品という構成では、Cargo の依存の解決と道具を捨てる代償が大きい。依存ごとに GN の定義を生成・保守する必要がある |
| Bazel ＋ rules_rust ＋ リモート実行 | 密閉（hermetic）なビルドで、リモート実行とキャッシュが強い（[Bazel のリモート実行](https://bazel.build/remote/rbe)） | 規則の保守と、リモート実行の基盤の運用が重い。build.rs を持つクレートの取り込みに手間がかかる。S1 の規模では割に合わない |

### 2.1 C/C++ の部品

- 部品ごとに、上流のビルド（V8・Skia は GN、HarfBuzz・FreeType などは Meson か CMake）で、OS・アーキテクチャ・構成（release、debug、ASan）ごとの静的ライブラリを作る。
- 成果物は、レシピと上流の版とツールチェーンのハッシュを鍵にして、S3 に置く。Cargo の build.rs は、その成果物を取るだけで、ビルドはしない。rusty_v8 が、既定では V8 のビルド済みの静的ライブラリを取り、`V8_FROM_SOURCE` のときだけ GN で作るのと同じ形である（[rusty_v8](https://github.com/denoland/rusty_v8)）。
- 部品の更新は、成果物を作る CI（4.5 節）を通してから、目録のハッシュを変える PR で行う。
- **build.rs はネットワークに出ない。** CI では、ネットワークのない環境でビルドし、破ったら失敗させる。成果物は、ビルドの前の段で取っておく。

### 2.2 キャッシュとリモート実行

- **sccache**（S3 を置き場にする）で、rustc と clang のコンパイルの結果を共有する。sccache は rustc・clang・MSVC に対応し、S3 を置き場にできる。ただし、システムのリンカーを呼ぶクレート（bin、dylib、cdylib、proc-macro）と、インクリメンタルにコンパイルするクレートはキャッシュできない（[sccache](https://github.com/mozilla/sccache)）。
  - 対策：実行ファイルのクレートは薄くし、中身をライブラリのクレートに置く。CI ではインクリメンタルを切る。
- キャッシュは、CI 用（`main` と merge queue だけが書ける）と、開発者・エージェント用（読むだけ）に分ける。PR の CI は読むだけにし、PR からキャッシュを汚させない。
- **リンク**は lld（Windows は lld-link）を使い、デバッグ情報は分割する（Linux は split DWARF、Windows は PDB、macOS は dSYM）。
- **リモート実行は S1 では持たない。** 大きな CI の実行環境（4.1 節）とキャッシュで足りる見込み。次のどれかに当たったら、Bazel ＋ リモート実行（REAPI）か、Siso 型のリモート実行を改めて比べる。
  - merge queue の p50 が 45 分を超え、キャッシュのヒット率を上げても戻らない
  - キャッシュのない全体のビルドが、最大の実行環境で 90 分を超える

## 3. テストの層

| 層 | 対象 | 道具 | どこで回すか |
| --- | --- | --- | --- |
| 単体・性質 | クレートの中の関数、解析器、状態機械 | `cargo test`（nextest）、proptest | PR |
| 結合（プロセスの境界） | IPC、サンドボックス、Browser と Renderer の検査（ADR-0003 の Confirmation） | 独自の結合テストの枠組み | PR（関係するクレート）、merge queue（全件） |
| ブラウザ全体 | ナビゲーション、タブ、プロファイル、更新、同期（サービスはローカルの偽物） | WebDriver BiDi でブラウザを操作する | merge queue |
| Web Platform Tests | Web の互換性（NFR-007） | wptrunner（4.3 節） | merge queue（抜粋）、継続（全件） |
| 画面の比較 | WPT の reftest、ブラウザの UI、描画の回帰 | 独自（参照画像と許容の幅） | 継続 |
| 主要サイト | 主要サイト 1,000 件の表示（NFR-007） | 記録した通信の再生と画面の比較 | 夜間 |
| 性能 | 4.4 節 | 専用の機械 | 継続 |
| ファズ | 5 節 | cargo-fuzz、libFuzzer | PR（短時間）、継続 |
| サービス | 更新・同期などのサービス | Slack の delivery.md と同じ（Vitest、Testcontainers） | PR |

- テスト名には、対応する要件の ID を含める（ルートの AGENTS.md）。
- ブラウザを操作するテストは、WebDriver BiDi を正式な操作の手段にする。WPT も同じ経路で動かす。

## 4. CI の段（ADR-0031）

```
PR ─▶ presubmit（20 分）─▶ レビュー ─▶ merge queue（CQ。45 分）─▶ main
                                                              │
                                     継続（main の先端を 1 時間ごと）◀┘
                                     夜間（1 日 1 回）─▶ Canary の版
```

### 4.1 実行環境

- GitHub Actions のセルフホストの実行環境を、AWS の CI アカウントに置く（[infrastructure.md](infrastructure.md)）。Linux・Windows は EC2 のオートスケール、macOS は EC2 Mac。
- EC2 Mac は Dedicated Host の上でだけ動き、ホストは最低 24 時間確保され、オンデマンドだけで、Spot は使えない（[AWS のドキュメント](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html)）。macOS の台数は常時の分を固定で持ち、Savings Plans で費用を抑える。
- GPU の要るテスト（画面の比較、WebGL・WebGPU）は、GPU のある実行環境（Linux・Windows は GPU の EC2、macOS は EC2 Mac の GPU）で回す。

### 4.2 各段の中身

| 段 | 中身 | 失敗の条件 |
| --- | --- | --- |
| presubmit（PR） | フォーマット、clippy、`forbid(unsafe_code)` の検査と `unsafe` の追加の検出（セキュリティのレビューを要求）、cargo-deny（ライセンス・勧告・重複）、変更のあったクレートとその依存先の単体・結合テスト（Linux）、fuzz のターゲットのビルドと短時間の実行（ClusterFuzzLite の変更のファズ）、追跡（要件 ID） | 1 件でも |
| CQ（merge queue） | 3 OS の Tier 1（6 節）でリリース構成のビルド、単体・結合の全件、ブラウザ全体のテスト、WPT の抜粋（約 5,000 件。変更のあった領域に重み）、ASan のビルドでの結合テスト（Linux） | 1 件でも。WPT は期待値からの悪化 |
| 継続（1 時間ごと） | WPT の全件（3 OS）、画面の比較、Tier 2 の構成、UBSan・ASan での全件、性能の測定、再現性の検査（7 節） | 失敗したら、その範囲のコミットを自動で二分探索し、原因の PR の作成者に Issue を立てる |
| 夜間 | 主要サイト 1,000 件、長時間のファズ、Canary の版の作成と署名と配信 | 夜間の失敗が続く間は、Dev の版を出さない |
| 緊急 | 緊急のセキュリティ修正（[update-and-release.md](update-and-release.md) の 6 節）。ブランチの上で、3 OS のビルド・署名・スモークだけを 2 時間以内で | 1 件でも |

- `main` の継続の段が壊れたら、原因の PR を戻す（revert）を第一にする。直すのは戻した後。
- CQ の所要時間の p50 を 45 分以下に保つ。超えたら、テストの分割（シャード）を増やすか、CQ の中身を継続の段へ移す提案を QA と合意する。

### 4.3 Web Platform Tests

- WPT は、上流のリポジトリの版を固定して写し、ボットが週 1 回更新の PR を出す。
- 実行は wptrunner で、WebDriver でブラウザを操作する（[WPT の実行](https://web-platform-tests.org/running-tests/index.html)、[wptrunner](https://web-platform-tests.org/tools/wptrunner/README.html)）。自分たちのブラウザを wptrunner の product として足す。
- **期待値**：テストごとの期待する結果（PASS・FAIL・TIMEOUT・CRASH）を、wptrunner のメタデータとして、OS ごとに持つ。本家の web tests が TestExpectations と `-expected` のファイルで既知の失敗を記録するのと同じ考え方（[Chromium の web tests](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/testing/web_tests.md)）。
  - 期待値より悪くなったら、CQ・継続の段を失敗させる。
  - 期待値より良くなったら、ボットが期待値を更新する PR を出す（自動でマージしてよいのは「良くなった」ものだけ）。
  - 期待値を悪い方へ変える PR は、QA の承認を必須にする（テストの緩和で通したことにしない。ルートの AGENTS.md）。
- **合格率の計測**：NFR-007 の「対象とした領域」を `tests/wpt/scope.toml` に列挙し、領域ごとの合格率を継続の段で出す。対象の領域の選び方は QA が [quality.md](../quality.md) で決める。
- **外部への公開**：結果を wpt.fyi に載せ、他のブラウザと比べられるようにしたい。新しいブラウザの結果を wpt.fyi に受け付けてもらう手続きは未検証。載せられない間は、同じ形式の結果を自分たちのダッシュボードで出す。
- 自分たちで書いた Web の互換性のテストは、できるだけ WPT の形で書き、上流へ出す。

### 4.4 性能の測定

| 測るもの | 道具 | 対応する NFR |
| --- | --- | --- |
| 起動の時間（ウォーム、最初の画面まで） | 独自（トレースから計算） | NFR-001 |
| ページの表示（LCP・INP・CLS） | 主要サイトの記録を再生し、トレースから計算 | NFR-002 |
| JavaScript・DOM の応答 | Speedometer 3.1。Blink・Gecko・WebKit の 3 つのエンジンの開かれた運営で作られた、Web アプリの応答の測定（[Speedometer 3.1](https://browserbench.org/Speedometer3.1/about.html)） | NFR-003 |
| 描画 | MotionMark 1.3.1。目標のフレームレートを保てる描画の要素の数を測る（[MotionMark](https://browserbench.org/MotionMark1.3.1/about.html)） | NFR-003 |
| メモリ | タブ 20 枚の標準の作業の台本 | NFR-004 |

- 測定は、専用の機械（EC2 の bare metal、EC2 Mac）で、ほかの仕事を同時に動かさずに行う。この機械を、NFR と各文書の性能の予算でいう「基準の端末」とする。同じ機械で、同じ日の本家 Chrome の Stable も測り、比で見る（NFR の目標は本家との比のため）。
- 1 回の測定は 20 回以上の繰り返しにし、前の版との差を統計の検定で判定する。悪化を検出したら、範囲を自動で二分探索する。
- 性能の予算（悪化を許す幅）は QA が [quality.md](../quality.md) で決める。

### 4.5 部品の成果物のビルド

- `third_party/native/` のレシピの変更で動く、別のワークフロー。上流のビルドで各 OS の成果物を作り、ハッシュと SBOM を付けて S3 に置く。
- 部品のソースは上流の署名付きのタグか、固定したコミットから取り、目録に記録する。

## 5. ファズ

- **対象**：信頼できない入力を受ける解析器（HTML、CSS、URL、画像・フォントの復号の境界、HTTP・QUIC のフレーム、拡張機能の manifest）と、FFI・IPC の境界（ADR-0001、題材の AGENTS.md）。IPC のメッセージは、侵害された Renderer を模して、構造を意識したファズ（`arbitrary`）でかける。
- **道具**：Rust は cargo-fuzz（libFuzzer）。OSS-Fuzz の Rust の対応も cargo-fuzz と libFuzzer と ASan を使う（[OSS-Fuzz の Rust](https://google.github.io/oss-fuzz/getting-started/new-project-guide/rust-lang/)）。同じ構成にして、将来 OSS-Fuzz へ移れるようにする。
- **基盤**：
  - PR：ClusterFuzzLite の変更のファズで、変更のあったターゲットを数分かける。ClusterFuzzLite は GitHub Actions で動き、Rust に対応し、変更のファズ・長時間のファズ・カバレッジを持つ（[ClusterFuzzLite](https://google.github.io/clusterfuzzlite/)）。
  - 継続：同じく ClusterFuzzLite の長時間のファズを、CI の実行環境で毎日回す。コーパスは S3 に置く。
  - S2 で、クラッシュの重複の除去・原因のコミットの二分探索・Issue の自動の起票と閉鎖を持つ ClusterFuzz（[ClusterFuzz](https://google.github.io/clusterfuzz/)）を検討する。ClusterFuzz の本番の構成が Google Cloud を前提にするかは未検証。ソースを公開するなら OSS-Fuzz への参加も比べる。
- ファズで見つけたクラッシュは、セキュリティの Issue（非公開）として起票し、再現する入力を回帰テストのコーパスに足す。

## 6. プラットフォームの組み合わせ

| 段 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Tier 1（CQ で必須） | Windows 11 x64 | 最新の macOS、arm64 | Ubuntu 24.04 x64 |
| Tier 2（継続の段） | Windows 10 22H2 x64、Windows 11 arm64 | 1 つ前の macOS arm64、x64 | Ubuntu 22.04 x64、Fedora の最新 x64、Ubuntu arm64 |
| 対応する最小の版（配布の条件） | Windows 10 22H2 | macOS 13 | glibc 2.35 相当 |

- 最小の版は、この設計の選択であり、本家の対応範囲を写したものではない。OS の提供元の保守の終了と、利用者の分布（同意済みのテレメトリ）で、年 1 回見直す。
- GPU は、各 OS で主要な 2 社以上の GPU を継続の段で回す。

## 7. 再現できるビルドと来歴

- 同じコミットからのビルドは、どの機械・どのディレクトリでも、署名の前の成果物が同じになるようにする。本家も、同じリビジョンから同じバイナリが作られることを目標にし、ボットで常に比べている（[deterministic builds](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/deterministic_builds.md)）。
  - `--remap-path-prefix` で絶対パスを消し、`SOURCE_DATE_EPOCH` で時刻を固定し、ツールチェーンを固定する。
  - 継続の段で、別のディレクトリで 2 回ビルドし、成果物を比べる。差が出たら、その範囲のコミットを戻すか直す。
- すべての配布物に、SBOM とビルドの来歴（どのコミット・どの実行環境・どの部品の成果物から作ったか）を付ける。来歴は、リリースの署名（[update-and-release.md](update-and-release.md) の 5 節）と一緒に保存する。
- 署名は、再現性の比較の後に、別の工程（release-signing アカウント）で行う。

## 8. 不安定なテスト

- CQ では、失敗したテストを 1 回だけ再実行する。再実行で通ったものは「不安定」として記録する（通したことにはするが、記録は必ず残す）。
- 7 日間の不安定な率が 1% を超えたテストは、自動で**隔離の候補**にし、持ち主に Issue を立てる。隔離（CQ の判定から外し、継続の段では回し続ける）は、QA の承認で行う。隔離には 14 日の期限を付け、期限までに直すか、QA と延長を合意する。
- 隔離したテストは、要件の Proof として数えない（[process.md](../../../../docs/process.md) の Test 段）。
- セキュリティのテスト（サイトの隔離、サンドボックス）は、隔離しない。不安定なら、直すまで CQ で再実行のたびに記録し、Dev（テックリード）に上げる。
- 週次で、不安定なテストの一覧と、隔離の数を出す（[project-management.md](../../../../docs/project-management.md) の `weekly-report`）。

## 9. エージェントの確認ループ

- エージェントは、ローカルで `cargo nextest` と、変更した領域の WPT の抜粋を回してから PR を出す。
- エージェントの実行環境は、sccache の開発者用のキャッシュ（読むだけ）と、部品の成果物を使う。キャッシュのないビルドをエージェントのたびにしない。
- エージェントは、署名の鍵・配信の設定・本番のクラッシュのデータへの経路を持たない。

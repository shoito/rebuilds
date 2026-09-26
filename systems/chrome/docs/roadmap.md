# Roadmap: Chrome

## 進め方の原則

- **最初に walking skeleton を通す。** E1 で、3 OS の上で「アドレスバー → Browser が主導するナビゲーション → サイトごとの Renderer → 描画 → 画面」を端から端まで貫いてから、機能を広げる。複数プロセス・サイトの隔離・型付きの IPC（[ADR-0003](decisions/0003-multi-process-site-isolation.md)、[ADR-0006](decisions/0006-typed-capability-ipc.md)）は、E1 から本物の形で作る。後から足すと直せないため。
- **部品の賭けを最初に確かめる。** rusty_v8・cppgc・Stylo・skia-safe・HarfRust・weedle2 の未検証の項目は、E1 の PoC で確かめ、合わなければ ADR を改める（[architecture/README.md](architecture/README.md) の「持ち越し」）。
- **境界を先に固定する。** IPC の IDL、ブラウザとサービスのプロトコル（更新、同期、Safe Browsing、クラッシュ）、端末のストアの形式は、人間がレビューして確定する。IDL の変更にはセキュリティのレビューが要る（[process-model.md](architecture/process-model.md) の 4.2 節）。
- **本家と比べて測る。** 互換は WPT と主要サイト、性能は本家の同じ日の Stable との比で判定する（[quality.md](quality.md) の 2.4・2.7 節）。
- **未完成の振る舞いは、機能のフラグの裏に置いてから `main` に入れる**（[update-and-release.md](architecture/update-and-release.md) の 11 節）。
- **法務・事業の確認待ちの Story は、spec を承認しない。** 設計と、確認に依らない Story は進めてよい（[intent.md](intent.md) の「法務・事業の確認待ち」）。
- **1 変更 1 PR を目安に、差分を小さくする。** IDL の変更と実装の変更は、別の PR にしてよい。

## Epic

PM が持つ。変更の一覧はここに書かず、各変更の `spec.md` の frontmatter（`epic`）から集計する（[process.md](../../../docs/process.md) の「粒度」）。E1〜E10 で MVP（S1）の Stable を出す。

| Epic | 目的 | 状態 |
| --- | --- | --- |
| E1 Walking skeleton | 開発の基盤（リポジトリ、ビルド、CI の 3 段、WPT とファズの配線）、複数プロセスと IPC、ナビゲーション、V8 とバインディング、DOM・スタイル・レイアウト・描画の最小の経路、最小の UI | 設計中 |
| E2 Web プラットフォームの互換 | MVP の Web API とレイアウトの範囲、WPT の対象の全領域、主要サイトの検査 | 未着手（主要サイトの記録は法務の確認待ち：L9） |
| E3 性能 | 合成スレッドと GPU プロセスの合成、性能の台本と本家との比較、bfcache の有効化、プロセスの上限、メモリ | 未着手 |
| E4 ネットワークと保存 | HTTP/3、証明書の検証、分割、Cookie の既定、DNS、保存領域、IndexedDB、Service Worker | 未着手（本家の CRLSet の再配布は L4） |
| E5 安全 | OS ごとのサンドボックス、攻撃の緩和、Safe Browsing（クライアントとサービス）、ダウンロードの保護、権限、HTTPS-First、セキュリティの UI | 未着手（OHTTP の中継と商用のフィードの契約が前提。リアルタイムの照会は L6） |
| E6 ブラウザの UI | ウィンドウとタブ、アドレスバー、検索エンジンの選択、設定、企業のポリシー、プロファイルとシークレット、ダウンロード、アクセシビリティ、国際化 | 未着手（ポリシーの名前は L3、検索の候補は L6、選択の画面は L10） |
| E7 拡張機能とストア | MV3 の基盤と API、DNR、ストアの提出・審査・配布、停止の一覧 | 未着手（`chrome.*` は L3、ストアの規約は L7） |
| E8 同期とアカウント | アカウントのサービス、ブラウザのサインイン、同期のプロトコルと E2EE、パスワードマネージャ、パスキー | 未着手 |
| E9 更新と配信 | アップデータ、update-server、署名の工程、差分、段階的な配信と rollout-guard、クラッシュの収集、テレメトリ、フィールドトライアル、部品のリストの配信 | 未着手（同意の画面は L6、配布物のライセンスの表示は L2） |
| E10 本番運用 | SLO とアラート、runbooks、大阪の DR と署名の訓練、鍵の交換、負荷試験、脆弱性の受付、MVP の Stable の受け入れ | 未着手（バグ報奨金の規約は L8） |
| E11 S2 への拡張 | 同期のシャード、CDN の分割、Storage サービスの別プロセス化、先読み、クラウドでのポリシーの管理、周期の見直し | 未着手（S2 の判断の基準を満たしたら。[infrastructure.md](architecture/infrastructure.md) の 9 節） |
| E12 S3 への拡張 | 更新の確認と Safe Browsing の照会の複数のリージョン、同期の本拠のリージョン、緊急の修正の帯域 | 未着手 |

## Story

各 Story は、着手するときに `changes/YYMMDD-<slug>/` として起票する。ここは計画で、進み具合は各変更の `spec.md` の frontmatter で見る。順序は Epic の中での目安で、依存があるものを先に置いた。各領域の文書の「Epic」「未検証」「持ち越し」の記述から集めた。

### E1 Walking skeleton

| Story | 内容 |
| --- | --- |
| `dev-repo-bootstrap` | Chrome の開発リポジトリ（モノレポ）を作り、`changes/`・`specs/`・開発向けの `AGENTS.md`、`crates/`・`services/`・`proto/`・`tests/` の区分を置く（リポジトリ共通の [ADR-0005](../../../docs/decisions/0005-design-record-repository.md)、[build-and-test.md](architecture/build-and-test.md) の 1 節）。E1 の他の Story の前に行う |
| `ci-accounts-and-runners` | ci アカウント、Linux・Windows の EC2 のオートスケール、EC2 Mac の Dedicated Host、sccache の S3、GitHub Actions の OIDC（[infrastructure.md](architecture/infrastructure.md) の 1・6 節） |
| `third-party-artifacts` | 部品の目録（`third_party/manifest.toml`）、C/C++ の部品の成果物のワークフロー、ネットワークに出ない build.rs（[ADR-0030](decisions/0030-build-system.md)） |
| `ci-tiers` | presubmit・CQ（merge queue）・継続・夜間の段、継続の失敗の自動の二分探索、要件 ID の追跡（[ADR-0031](decisions/0031-ci-tiers-wpt-and-release-branches.md)） |
| `unsafe-and-supply-chain` | `forbid(unsafe_code)` の検査、`unsafe` の目録、cargo-deny・cargo-vet（[ADR-0020](decisions/0020-memory-safety-and-unsafe-policy.md)） |
| `feature-flags-client` | ブラウザの機能のフラグ、持ち主と消す予定のマイルストーン、期限切れの CI の検査（[update-and-release.md](architecture/update-and-release.md) の 11 節）。トランクベース開発の前提なので早く作る |
| `ipc-idl-codegen` | IDL と Rust のコード生成、受信時の検査、OS ごとの運び方、BrowserInterfaceBroker（[ADR-0006](decisions/0006-typed-capability-ipc.md)） |
| `process-launch-and-lock` | プロセスの種類と起動、プロセスの鍵、予備の Renderer、クラッシュの検知と不正なメッセージでの終了（[ADR-0007](decisions/0007-process-allocation-policy.md)、[process-model.md](architecture/process-model.md) の 2・3・6 節） |
| `compromised-renderer-harness` | 侵害された Renderer の模擬の仕組み（テストのビルドだけ）と、ADR-0007 の性質テスト（[quality.md](quality.md) の 2.5 節） |
| `v8-embedding` | rusty_v8 を `V8_FROM_SOURCE` で、V8 のサンドボックスとポインタの圧縮を有効にして 3 OS でビルドする（[ADR-0010](decisions/0010-v8-embedding-and-dom-gc.md)。PoC を兼ねる） |
| `webidl-bindgen` | `@webref/idl` の取り込み、weedle2 での解析、実装の trait の生成。全体の解析の失敗を数える（[ADR-0014](decisions/0014-web-idl-bindings-generation.md)） |
| `dom-on-cppgc` | cppgc の上の DOM、html5ever の `TreeSink`、`NodeId`、マイクロベンチマーク（[rendering.md](architecture/rendering.md) の 2・3 節） |
| `stylo-bridge` | `style_bridge` と、`servo` の機能で足りないプロパティの一覧（[ADR-0011](decisions/0011-stylo-style-engine.md)） |
| `layout-minimal` | 箱の木、ブロックとインラインの最小、不変のフラグメントの木（[ADR-0012](decisions/0012-own-layout-engine.md)） |
| `skia-min-path-3os` | 表示リスト → タイル → 画面の最小の経路を 3 OS で（Graphite と ANGLE の確認。[ADR-0013](decisions/0013-skia-raster-and-own-compositor.md)） |
| `text-and-images-poc` | Skrifa・HarfRust・ICU4X の組み込みとシェーピングのベンチマーク、Rust の画像の復号器の互換の確認（[rendering.md](architecture/rendering.md) の 11・12 節） |
| `network-service-basic` | Network サービスのプロセス、`URLLoaderFactory`、HTTP/1.1・HTTP/2、rustls（[networking.md](architecture/networking.md) の 2〜4 節） |
| `navigation-core` | Browser が主導するナビゲーション、応答の検査の順、コミットと完了の検査、文書ごとの frame の実体（[ADR-0008](decisions/0008-browser-driven-navigation-commit.md)） |
| `bfcache-skeleton` | 「凍結中」の状態と入れない条件の 1 か所の一覧だけを作る。有効にするのは E3（[ADR-0009](decisions/0009-back-forward-cache.md)） |
| `browser-ui-shell` | OS の薄い層、ウィンドウ、タブの帯とアドレスバーの最小（[ADR-0024](decisions/0024-ui-toolkit.md)） |
| `wpt-runner-integration` | wptrunner の product、期待値のメタデータの初版、`scope.toml`（[build-and-test.md](architecture/build-and-test.md) の 4.3 節、[quality.md](quality.md) の 2.4 節） |
| `fuzz-baseline` | cargo-fuzz のターゲット（IPC の復号器、HTML の解析器）、ClusterFuzzLite の変更のファズと継続のファズ（[build-and-test.md](architecture/build-and-test.md) の 5 節） |
| `reproducible-builds` | 再現性の検査、SBOM とビルドの来歴（[build-and-test.md](architecture/build-and-test.md) の 7 節） |
| `devtools-subset` | CDP の Runtime・DOM と、DevTools のフロントエンドを部分集合で動かす確認（[javascript-and-web-apis.md](architecture/javascript-and-web-apis.md) の 6 節）。E1 の終わりに行う |

### E2 Web プラットフォームの互換

| Story | 内容 |
| --- | --- |
| `wpt-scope-dashboard` | 領域ごと・OS ごとの合格率の出力と週次の報告（[quality.md](quality.md) の 2.4 節） |
| `html-parser-streaming` | ストリーミングの解析、`document.write`、preload scanner（[rendering.md](architecture/rendering.md) の 2 節） |
| `event-loop-and-timers` | HTML のイベントループ、マイクロタスク、タイマー、精度を落とした時刻（[javascript-and-web-apis.md](architecture/javascript-and-web-apis.md) の 1.4・2 節） |
| `dom-events-and-observers` | イベントの伝播、Shadow DOM、Custom Elements、MutationObserver・IntersectionObserver・ResizeObserver |
| `layout-flex-grid-table-float` | Flexbox、Grid（Taffy）、表、float、位置指定。Taffy の `css/css-grid` の判定（[ADR-0012](decisions/0012-own-layout-engine.md)） |
| `vertical-writing` | 縦書きと論理的な方向（[rendering.md](architecture/rendering.md) の 5.2 節） |
| `css-upstream-gaps` | Stylo に足りないプロパティを servo/stylo へ送る（[ADR-0011](decisions/0011-stylo-style-engine.md)） |
| `fetch-xhr-websocket-streams` | Fetch、XMLHttpRequest、WebSocket、Streams、Blob・File |
| `workers-and-messaging` | Dedicated・Shared Worker、`postMessage`、MessageChannel、BroadcastChannel |
| `forms-and-dialog` | フォームの検証と送信、`<dialog>`、`popover`、`<details>` |
| `history-and-navigation-api` | History API、Navigation API、同じ文書の中のナビゲーション（[navigation-and-loading.md](architecture/navigation-and-loading.md) の 3.6 節） |
| `canvas2d-and-images` | Canvas 2D、`OffscreenCanvas`、`createImageBitmap`、画像の遅延の復号（[rendering.md](architecture/rendering.md) の 12・15 節） |
| `media-basic-playback` | `<video>`・`<audio>` の基本の再生（DRM なし） |
| `crypto-wasm-intl` | Web Crypto、WebAssembly、`Intl`、`TextEncoder` |
| `cross-origin-windowproxy` | cross-origin の `WindowProxy`・`Location`、`document.domain` の既定（[javascript-and-web-apis.md](architecture/javascript-and-web-apis.md) の 4.2 節） |
| `top-sites-harness` | 主要サイト 1,000 件の選定、記録と再生、崩れの分類（法務の確認待ち：L9） |
| `wpt-fyi-submission` | wpt.fyi への結果の掲載（送り手の登録を Issue で頼み、ブラウザの名前を `shared/browsers.go` に足す。[build-and-test.md](architecture/build-and-test.md) の 4.3 節） |
| `webgl` | ANGLE を GPU プロセスに載せ、WebGL・WebGL 2 を足す（MVP の後。[javascript-and-web-apis.md](architecture/javascript-and-web-apis.md) の 5.1 節） |
| `web-audio` | Web Audio（MVP の後。WebGL の次） |

### E3 性能

| Story | 内容 |
| --- | --- |
| `perf-lab` | 基準の端末、性能の台本（起動、主要サイトの読み込み、Speedometer 3.1、MotionMark、タブ 20 枚）、本家の同じ日の Stable との比較（[build-and-test.md](architecture/build-and-test.md) の 4.4 節） |
| `compositor-thread-and-tiles` | 合成スレッド、Layerize、タイル、合成のスクロールとアニメーション（[rendering.md](architecture/rendering.md) の 7.1・9・10 節。ADR-0013 の中心） |
| `display-compositor` | GPU プロセスの表示の合成、surface、OOPIF の埋め込み（[rendering.md](architecture/rendering.md) の 7.2 節） |
| `incremental-layout` | フラグメントの再利用、`content-visibility`、差分テスト（[rendering.md](architecture/rendering.md) の 5.3・5.4 節） |
| `bindings-fast-calls` | V8 の fast API calls、スナップショット（[javascript-and-web-apis.md](architecture/javascript-and-web-apis.md) の 1.2・3.4 節） |
| `startup-path` | NFR-001 の起動の経路の計測と短縮 |
| `process-limit-tuning` | プロセスの上限の式を NFR-004 の計測で決め直す（[process-model.md](architecture/process-model.md) の 3.2 節） |
| `memory-pressure-and-discard` | メモリの圧迫の段階の対応、タブの破棄、Linux の PSI の閾値（[process-model.md](architecture/process-model.md) の 3.5 節） |
| `bfcache-enable` | bfcache の有効化、`notRestoredReasons`（[navigation-and-loading.md](architecture/navigation-and-loading.md) の 6.3 節） |
| `ipc-and-renderdocument-cost` | IPC の直列化と、同じサイトのナビゲーションの実体の作り直しの費用の計測 |
| `os-compositor-delegation` | 動画・全画面の OS の合成器への委譲と消費電力（[rendering.md](architecture/rendering.md) の 7.3 節） |

### E4 ネットワークと保存

| Story | 内容 |
| --- | --- |
| `connection-pool-and-partitioning` | 接続のプール、NetworkAnonymizationKey・NetworkIsolationKey（[ADR-0017](decisions/0017-partitioning-by-top-level-site.md)） |
| `http-cache` | 分割したキャッシュ、1 件 1 ファイル＋ SQLite の索引（[networking.md](architecture/networking.md) の 5.2・5.3 節） |
| `http3-quic` | `quinn`・`h3`、Happy Eyeballs、TCP への戻し、相互接続と負荷の試験（足りなければ `quiche`。[ADR-0015](decisions/0015-tls-and-certificate-verification.md)） |
| `cert-verifier-ct` | 自作の検証器、ルートストア、CT の強制、本家の試験のデータ（[networking.md](architecture/networking.md) の 6 節） |
| `revocation-list-ccadb` | CCADB の CRL から優先度の高い失効のリストを作る（既定案。本家の CRLSet に替える Story は L4 の確認待ち） |
| `dns-doh` | スタブのリゾルバ、同じ提供者の DoH の自動の切り替え、HTTPS レコード（[networking.md](architecture/networking.md) の 7 節） |
| `cookies-3p-blocking` | サードパーティ Cookie の既定の遮断、CHIPS、Storage Access API、3PCD のヒューリスティクスの一時的な許可（[ADR-0016](decisions/0016-third-party-cookies-blocked-by-default.md)） |
| `cors-orb-lna` | CORS、ORB、CORP、Local Network Access（[networking.md](architecture/networking.md) の 3・6.4 節） |
| `proxy-and-pac` | OS のプロキシの設定、PAC の Utility プロセスでの評価、認証（[networking.md](architecture/networking.md) の 9 節） |
| `storage-service-and-quota` | Storage サービス、StorageKey とバケット、割り当てと追い出し（[storage.md](architecture/storage.md) の 1〜4 節） |
| `indexeddb-sqlite` | SQLite の上の IndexedDB とベンチマーク（[ADR-0018](decisions/0018-indexeddb-on-sqlite.md)） |
| `local-and-session-storage` | localStorage の Renderer の写し、sessionStorage とセッションの保存（[storage.md](architecture/storage.md) の 5・6 節） |
| `service-worker-and-cache-storage` | Service Worker の登録・寿命・fetch の横取り、Cache Storage（[storage.md](architecture/storage.md) の 7・9 節） |
| `site-data-clearing` | 閲覧データの削除、`Clear-Site-Data`、破損からの回復（[storage.md](architecture/storage.md) の 11・12 節） |

### E5 安全

| Story | 内容 |
| --- | --- |
| `sandbox-windows` | 制限したトークン、ジョブ、別のデスクトップ、AppContainer・LPAC、win32k の禁止（[sandbox-and-security.md](architecture/sandbox-and-security.md) の 4.2 節） |
| `sandbox-macos` | Seatbelt のプロファイル、Helper のアプリの分け方、JIT の entitlement（同 4.3 節） |
| `sandbox-linux` | 名前空間と seccomp-bpf、ユーザー名前空間を使えない配布版への対応（同 4.4 節） |
| `sandbox-escape-tests` | 3 OS・プロセスの種類ごとの脱出のテスト（[quality.md](quality.md) の 2.5 節） |
| `exploit-mitigations` | CFG、CET、V8 のサンドボックス、整数のあふれの検査の性能（[sandbox-and-security.md](architecture/sandbox-and-security.md) の 6 節） |
| `bad-message-telemetry` | 不正なメッセージの理由のコードの指標と、急増のアラート、runbook の `bad-message-spike.md`（[runbooks/README.md](runbooks/README.md) の 4 節） |
| `safe-browsing-list-service` | フィードの取り込み、保護の一覧、人の確認、リストの版と差分、署名、S3・CloudFront、runbook の `safe-browsing-false-positive.md`・`safe-browsing-feed-outage.md`（[safe-browsing-and-permissions.md](architecture/safe-browsing-and-permissions.md) の 3 節、[runbooks/README.md](runbooks/README.md) の 4 節。フィードの契約が前提） |
| `safe-browsing-client` | 正規化と照合、手元のリスト（15 分）、完全なハッシュの照会、警告の画面（同 2 節） |
| `safe-browsing-realtime-ohttp` | リアルタイムの照会と OHTTP の中継（中継の契約が前提。L6） |
| `download-protection` | ファイルの種類の危険度、URL の連鎖、ハッシュの照会、アーカイブの検査、OS の印（同 4 節） |
| `permissions-model` | 権限の単位と状態、確認の吹き出し、一時の抑止、静かな確認、自動の失効（[ADR-0022](decisions/0022-permission-model.md)） |
| `https-first` | HTTPS-First の既定、警告の画面、混在コンテンツの格上げ（[safe-browsing-and-permissions.md](architecture/safe-browsing-and-permissions.md) の 8 節） |
| `security-ui` | オリジンの表示、警告の画面、死線、全画面（[sandbox-and-security.md](architecture/sandbox-and-security.md) の 9 節） |

### E6 ブラウザの UI

| Story | 内容 |
| --- | --- |
| `windows-and-tab-strip` | ウィンドウ、タブの帯、タブのグループ、閉じたタブ（[browser-ui.md](architecture/browser-ui.md) の 2 節） |
| `ime-and-os-layer` | 3 OS の IME と、winit を使わない判断の確認（同 1.1・9 節） |
| `omnibox-providers` | 手元の提供元、候補の並べ方、IDN の表示（同 3.1 節） |
| `search-engine-choice` | 既定を置かない選択の画面、国ごとの一覧の配信（L10） |
| `search-suggestions` | 検索の候補（既定で無効。L6） |
| `settings-webui` | 設定の内部ページと許可リスト（同 4 節） |
| `enterprise-policy-loader` | 3 OS のポリシーの読み込み、定義ファイルからの ADMX の生成、`<brand>://policy`（同 5 節。ポリシーの名前は L3） |
| `profiles-and-incognito` | プロファイル、ゲスト、シークレット（同 6 節） |
| `downloads-ui` | ダウンロードの吹き出しと一覧、判定の表示（同 7 節） |
| `session-restore` | セッションの保存と復元（[navigation-and-loading.md](architecture/navigation-and-loading.md) の 6.4 節） |
| `accessibility-accesskit` | AccessKit の橋、枠の UI と Web の内容の 1 つの木、支援技術での確認と IA2 の要否（[browser-ui.md](architecture/browser-ui.md) の 8 節） |
| `i18n-fluent` | Fluent の文字列、日本語と英語、左右反転できる配置（同 9 節） |
| `ui-perf-budgets` | UI の性能の予算の CI（同 10 節） |

### E7 拡張機能とストア

| Story | 内容 |
| --- | --- |
| `extension-api-survey` | 本家の上位の拡張機能 500 件のマニフェストの集計と、API の優先度（[extensions.md](architecture/extensions.md) の 1 節） |
| `extension-runtime` | 拡張機能の Renderer、service worker の寿命、CSP（同 2 節） |
| `content-scripts` | isolated world、注入の時点、一致の判定（同 3 節） |
| `extension-permissions` | API・ホストの権限、実行時のサイトへのアクセスの制御、`activeTab`（同 4 節） |
| `dnr-engine` | DNR の検証・索引・照合、上限、予算（同 5 節） |
| `extension-apis-mvp` | MVP の API（`tabs`・`storage`・`scripting` など）と、`browser.*`・`chrome.*` の名前空間（[ADR-0025](decisions/0025-extension-platform-mv3.md)。`chrome.*` は L3） |
| `package-format-and-ids` | CRX3 と同じ構造の独自の形式、拡張機能 ID、署名の検証（[extensions.md](architecture/extensions.md) の 6 節） |
| `store-developer-dashboard` | 開発者のアカウント、2 段階認証、提出（同 7 節） |
| `store-automated-review` | 形式・遠隔のコード・難読化・マルウェア・動的解析・差分の検査、リスクの点数（同 7.1 節） |
| `store-human-review` | 人の審査、判定の記録、措置、異議（同 7.2・7.3 節。規約は L7） |
| `store-update-delivery` | 拡張機能の更新の確認と段階的な配布（同 7.4 節） |
| `extension-blocklist` | 停止の一覧の管理と配信、端末での措置（同 9 節）、runbook の `extension-takedown.md`（[runbooks/README.md](runbooks/README.md) の 4 節） |
| `extension-enterprise-policy` | `ExtensionSettings` と同じ意味のポリシー、強制インストール、`webRequestBlocking` の例外（[extensions.md](architecture/extensions.md) の 5.3・8 節） |

### E8 同期とアカウント

| Story | 内容 |
| --- | --- |
| `account-service` | Better Auth、パスキー・メールの OTP・TOTP、アカウントのページ、ログインの失敗の急増のアラートと runbook の `auth-anomalies.md`（[runbooks/README.md](runbooks/README.md) の 4 節。[ADR-0028](decisions/0028-account-service.md)。OAuth 2.1 Provider の第一者のクライアントの試作を最初に行う） |
| `browser-signin` | OAuth 2.1 と PKCE、`<brand>://oauth-callback` の横取り、トークンの保存と回転（[sync-and-accounts.md](architecture/sync-and-accounts.md) の 2.2 節） |
| `sync-protocol-core` | `GetUpdates`・`Commit`、版の番号、衝突、削除の印、通知の WebSocket（同 5 節） |
| `sync-e2ee-keys` | SRK と鍵の導出、HPKE、回復用のコード、パスフレーズ、Argon2id の引数の計測（同 4 節、[ADR-0027](decisions/0027-sync-protocol-and-e2ee.md)） |
| `device-add-and-rotation` | 既存の端末での承認と確認の数字、端末の削除と鍵の回転、runbook の `sync-key-issues.md`（[runbooks/README.md](runbooks/README.md) の 4 節。[sync-and-accounts.md](architecture/sync-and-accounts.md) の 4.2・4.3・7 節） |
| `sync-data-types` | データ型ごとの橋と衝突の規則（ブックマーク、パスワード、設定、履歴、タブ、リーディングリスト、拡張機能、検索エンジン、自動入力）と初回の合わせ込み（同 3・5.3 節） |
| `password-manager-store` | パスワードの保存と入力、データ鍵と OS の鍵の保管、再認証（[ADR-0023](decisions/0023-password-manager-encryption.md)） |
| `password-leak-check` | Pwned Passwords の範囲 API と OHTTP（自前の写しは L5） |
| `webauthn-passkeys` | WebAuthn、RP ID の検査、セキュリティキーと OS の認証器、条件付きの UI（[safe-browsing-and-permissions.md](architecture/safe-browsing-and-permissions.md) の 7 節） |
| `sync-plaintext-scanner` | 同期の DB の平文の走査（ADR-0005 の Confirmation）、runbook の `sync-data-exposure.md`（[runbooks/README.md](runbooks/README.md) の 4 節） |
| `sync-crypto-review` | 外部の暗号のレビュー（E8 の完了の前） |
| `passkey-provider` | 自前のパスキーの提供者と E2EE の同期（MVP の後） |

### E9 更新と配信

| Story | 内容 |
| --- | --- |
| `release-signing-account` | release-signing アカウント、KMS のリリースの鍵（マルチリージョン）、CloudHSM、署名専用の実行環境（[infrastructure.md](architecture/infrastructure.md) の 1・6 節） |
| `macos-signing-poc` | rcodesign と CloudHSM での署名、CSR、App Store Connect の API キーでの公証とステープル、EC2 Mac での検証、大阪での同じ手順（[ADR-0034](decisions/0034-macos-signing-with-rcodesign-and-cloudhsm.md)、[update-and-release.md](architecture/update-and-release.md) の 5.2 節）。確かめ終えるまで macOS の Stable は出さない |
| `update-server-omaha4` | プロトコル 4 互換の update-server、CUP の署名、配信の区画（[ADR-0029](decisions/0029-updater-protocol-and-staged-rollout.md)） |
| `updater-windows` | サービスとタスクスケジューラ、権限の昇格、自己更新（[update-and-release.md](architecture/update-and-release.md) の 3 節） |
| `updater-macos` | LaunchDaemon・LaunchAgent、特権のヘルパー |
| `linux-packages` | apt・dnf のリポジトリと GPG の署名（CloudHSM から使う方式の選定：`gnupg-pkcs11-scd` か `sq-pkcs11`）、版の古さの表示（[update-and-release.md](architecture/update-and-release.md) の 5.2 節） |
| `differential-updates` | Zucchini・Puffin の差分、全体への戻し（同 7 節） |
| `rollout-guard` | 段階的な配信、自動の停止、リリースのダッシュボード（同 4.3 節、[observability.md](architecture/observability.md) の 3.3 節） |
| `fallback-manifest` | 予備のマニフェストと予備の CloudFront（[update-and-release.md](architecture/update-and-release.md) の 4.4 節） |
| `restart-prompts` | 再起動の促し方と `urgency=critical`（同 3.3 節） |
| `component-delivery` | 部品のリスト（ルートストア、CT のログ、失効のリスト、HSTS の事前読み込み、Public Suffix List、DoH の提供者、検索エンジンの一覧）の配信、配信の遅れのアラートと runbook の `component-list-staleness.md`（[runbooks/README.md](runbooks/README.md) の 4 節） |
| `consent-first-run` | 初回の起動での同意の画面と、公開する範囲（L6） |
| `crashpad-integration` | Crashpad の登録、注釈の許可リスト、同意のないときの 7 日の保持（[update-and-release.md](architecture/update-and-release.md) の 9.1 節） |
| `crash-ingest-symbolicator` | crash-ingest、symbolicator、シグネチャ、Issue の起票、シンボルの欠落のアラート（同 9.2 節）、runbook の `symbolication-gap.md`（[runbooks/README.md](runbooks/README.md) の 4 節） |
| `telemetry-registry-and-ingest` | 指標の登録簿、telemetry-ingest、Parquet と AMP（[update-and-release.md](architecture/update-and-release.md) の 10 節、[observability.md](architecture/observability.md) の 3 節） |
| `field-trials-seed` | seed の署名と配信、端末の中の割り当て、止める手段（[update-and-release.md](architecture/update-and-release.md) の 12 節） |
| `license-notices` | 配布物の部品のライセンスの表示（L2） |

### E10 本番運用

| Story | 内容 |
| --- | --- |
| `slo-and-alerts` | SLO とアラートの実装と、アラートから runbook への URL（[runbooks/README.md](runbooks/README.md) の 1・4 節） |
| `runbooks-e10` | `disaster-recovery.md`・`signing-key-rotation.md` などの runbook（[runbooks/README.md](runbooks/README.md) の 4 節） |
| `dr-osaka` | 大阪の Aurora の二次クラスタ、S3 の複製、CloudFront のオリジングループ、大阪での API の再構築（[infrastructure.md](architecture/infrastructure.md) の 5 節） |
| `signing-drill-osaka` | 大阪の KMS の複製と CloudHSM のバックアップで署名する訓練（[runbooks/README.md](runbooks/README.md) の 5 節） |
| `key-rotation` | CUP の鍵の 90 日の交換、予備のリリースの鍵、コード署名の証明書の更新の手順 |
| `emergency-release-drill` | 緊急の修正の訓練（staging。T0 まで 8 時間以内） |
| `load-tests` | 更新の確認の 1 倍・3 倍、緊急の修正の集中、同期の再接続の殺到（[capacity.md](architecture/capacity.md) の 5 節） |
| `vuln-intake` | 脆弱性の報告の窓口、重大度の付け方、公開の時期（[sandbox-and-security.md](architecture/sandbox-and-security.md) の 7 節） |
| `bug-bounty` | バグ報奨金（規約は L8、金額と運営は事業の判断） |
| `cna-registration` | CNA の登録の申請 |
| `external-security-review` | サンドボックスとサイトの隔離の外部の評価 |
| `stable-launch` | MVP の Stable の受け入れ（[quality.md](quality.md) の 4.3 節を E10 の条件で満たす） |

### E11 S2 への拡張

| Story | 内容 |
| --- | --- |
| `cdn-split-and-quota` | 成果物の CloudFront の分割と帯域の上限の引き上げ（[capacity.md](architecture/capacity.md) の 2.1・4 節） |
| `sync-sharding` | `account_id` のハッシュでの同期のクラスタの分割（[sync-and-accounts.md](architecture/sync-and-accounts.md) の 6 節） |
| `sync-metadata-padding` | 暗号文の大きさの丸め（同 10 節） |
| `ingest-buffering` | クラッシュ・テレメトリの取り込みを Kinesis で緩衝する |
| `storage-service-oop` | Storage サービスを別のプロセス・サンドボックスへ（[process-model.md](architecture/process-model.md) の 5 節） |
| `origin-agent-cluster-process` | `Origin-Agent-Cluster: ?1` のオリジンのプロセスの分離（同 3.4 節） |
| `coop-report-only` | COOP の Report-Only と報告（[navigation-and-loading.md](architecture/navigation-and-loading.md) の 4.3 節） |
| `speculation-rules` | prefetch と prerender（同 10 節） |
| `cloud-policy-management` | クラウドでのポリシーの管理（[browser-ui.md](architecture/browser-ui.md) の 5 節） |
| `clusterfuzz-or-ossfuzz` | ClusterFuzz か OSS-Fuzz への移行の比較（[build-and-test.md](architecture/build-and-test.md) の 5 節） |
| `cadence-review` | 2 週の周期にするかの判断（[update-and-release.md](architecture/update-and-release.md) の 1 節） |

### E12 S3 への拡張

| Story | 内容 |
| --- | --- |
| `multi-region-update-sb` | 更新の確認と Safe Browsing の照会を米国・欧州に置き、レイテンシーで振り分ける（[infrastructure.md](architecture/infrastructure.md) の 4 節） |
| `sync-home-region` | アカウントごとの本拠のリージョン（[sync-and-accounts.md](architecture/sync-and-accounts.md) の 6 節） |
| `emergency-bandwidth` | 緊急の修正の集中（約 200 Gbps）の配信の試験（[capacity.md](architecture/capacity.md) の 2.1 節） |

各 Epic の品質面の重点と合否基準は、[quality.md](quality.md) の 5 節にある。

## エージェントに任せないこと

- **境界の確定**：IPC の IDL、ブラウザとサービスのプロトコル、端末のストアの形式。変えるコストが最も高く、IDL はセキュリティのレビューが要る。
- **隔離とサンドボックスの最終の確認**：テストが通っていても、検査の漏れはエージェント自身では気づきにくい。
- **署名と配信の操作**：署名の鍵、配信の段階の変更、seed で機能を広げること、停止の一覧への追加。エージェントはこれらの経路を持たない。
- **WPT の期待値を悪い方へ変えること、不安定なテストの隔離**：QA が承認する。
- **脆弱性の重大度と公開の判断**：セキュリティの担当が行う。
- **性能・互換の結果の解釈**：数字は出せるが、どの差を許容し、どこに投資するかはプロダクトの判断。
- **法務・事業の判断と、契約の相手の選定**。

## 後回しにしたもの

MVP の後に検討する。着手するときに `intent.md` から起票する（[intent.md](intent.md) の Non-goals）。

- **Android 版、iOS 版、ChromeOS**（intent の Non-goals）。
- **DRM（Widevine）**：提供元のライセンスの申請（外部の手続き）が要る。使うかどうかは法務・事業の確認待ち（[intent.md](intent.md) の L1）。S1 に含めない。
- **Web API**：WebGPU（ADR が要る）、WebRTC、Push API と Background Sync（プッシュのサービスが要る）、WebXR・Web Bluetooth・WebUSB・Web Serial・WebHID・Web MIDI、Payment Request、File System Access、WebTransport、Web Speech、OPFS と Storage Buckets API、Service Worker の Static Routing API（[javascript-and-web-apis.md](architecture/javascript-and-web-apis.md) の 5.1 節、[storage.md](architecture/storage.md)）。WebGL と Web Audio は E2 の Story。
- **描画**：複数段組と印刷（PDF 出力の Epic）、HDR、Windows・Linux の Graphite（[rendering.md](architecture/rendering.md)）。
- **更新と配布**：Extended Stable（8 週）、Flatpak・Snap（[update-and-release.md](architecture/update-and-release.md)）。
- **拡張機能**：MV2、`debugger`・`nativeMessaging` などの MVP の後の API（[extensions.md](architecture/extensions.md) の 1 節）。
- **同期とパスワード**：`themes`・`send_tab`・`payment_cards`、支払いのカードの自動入力、ユーザー名との組での漏洩の確認（秘匿集合演算）、他の端末による認証（hybrid）、パスキーの PRF での鍵の保護（[sync-and-accounts.md](architecture/sync-and-accounts.md)、[safe-browsing-and-permissions.md](architecture/safe-browsing-and-permissions.md)）。
- **Safe Browsing**：自前の巡回、本家（Google）のリストとの契約（ADR-0021）。
- **開発者ツールの全機能**（intent の Non-goals）、QUIC のプロキシ（MASQUE）。
- **翻訳、AI の機能**（要約など。intent の Non-goals）。
- **Privacy Sandbox などの広告の API**（intent の Non-goals）。

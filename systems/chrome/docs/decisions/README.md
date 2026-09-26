# Decisions: Chrome

Chrome の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-languages-and-platform.md) | ブラウザは Rust、クラウドのサービスは TypeScript と AWS で作る | accepted |
| [0002](0002-engine-build-vs-reuse.md) | ブラウザの構造は自作し、成熟した部品を使う | accepted |
| [0003](0003-multi-process-site-isolation.md) | 複数プロセスとサイトの隔離を、最初から前提にする | accepted |
| [0004](0004-release-channels-and-updates.md) | 4 つのチャンネルと 4 週ごとのリリース、段階的な自動更新にする | accepted |
| [0005](0005-privacy-first-services.md) | クラウドのサービスは送るデータを最小にし、同期は暗号化する | accepted |
| [0006](0006-typed-capability-ipc.md) | IPC は、型付きの IDL と、端点を権限として渡す形で自作する | accepted |
| [0007](0007-process-allocation-policy.md) | デスクトップでは常にサイトごとにプロセスを分け、上限を超えても異なるサイトを混ぜない | accepted |
| [0008](0008-browser-driven-navigation-commit.md) | ナビゲーションは Browser が主導し、応答を見てプロセスを決め、文書ごとに frame の実体を作る | accepted |
| [0009](0009-back-forward-cache.md) | bfcache は、ページを同じプロセスに凍結して残し、凍結中に実行が要れば追い出す | accepted |
| [0010](0010-v8-embedding-and-dom-gc.md) | V8 を rusty_v8 で組み込み、DOM を cppgc のヒープに置いて V8 と一緒に追跡する | accepted |
| [0011](0011-stylo-style-engine.md) | スタイルの計算に Stylo を使う | accepted |
| [0012](0012-own-layout-engine.md) | レイアウトは自作し、不変のフラグメントの木を出力する | accepted |
| [0013](0013-skia-raster-and-own-compositor.md) | raster は Skia で行い、合成は自作する（Renderer の合成スレッドと GPU プロセスの表示の合成） | accepted |
| [0014](0014-web-idl-bindings-generation.md) | Web API のバインディングは、Web IDL から Rust のコードを生成する | accepted |
| [0015](0015-tls-and-certificate-verification.md) | TLS は rustls、証明書の検証は自作し、ルートストアは Chrome Root Store に揃える | accepted |
| [0016](0016-third-party-cookies-blocked-by-default.md) | サードパーティ Cookie を既定で遮断し、CHIPS と Storage Access API で補う | accepted |
| [0017](0017-partitioning-by-top-level-site.md) | ネットワークの状態と保存領域を、トップレベルのサイトで分割する | accepted |
| [0018](0018-indexeddb-on-sqlite.md) | IndexedDB を SQLite の上に作る | accepted |
| [0019](0019-os-sandbox-baseline.md) | OS ごとのサンドボックスを Rust で自作し、プロセスの種類ごとの基準を決める | accepted |
| [0020](0020-memory-safety-and-unsafe-policy.md) | Rule of 2 を Rust に当てはめ、`unsafe` と C/C++ の部品の置き場所を決める | accepted |
| [0021](0021-safe-browsing-list-source.md) | Safe Browsing の脅威のリストは自前で作り、第三者のフィードを使う | accepted |
| [0022](0022-permission-model.md) | 権限は、要求したオリジンと最上位のオリジンの組で持ち、端末の中の信号で静かにし、自動で失効させる | accepted |
| [0023](0023-password-manager-encryption.md) | パスワードは OS の鍵ストアで守る鍵で暗号化し、同期は E2EE、漏洩の確認は k-匿名性で行う | accepted |
| [0024](0024-ui-toolkit.md) | 枠の UI は Rust の自前の UI 層で描き、内部ページはエンジンで描く | accepted |
| [0025](0025-extension-platform-mv3.md) | 拡張機能は Manifest V3 に互換とし、`chrome.*` を互換の別名として提供する | accepted |
| [0026](0026-extension-store-review.md) | 拡張機能のストアは自動と人の審査を組み合わせ、停止の一覧で公開後の拡張機能も止められるようにする | accepted |
| [0027](0027-sync-protocol-and-e2ee.md) | 同期は版の番号による楽観的な排他のプロトコルにし、すべてのデータ型を利用者の鍵で暗号化する | accepted |
| [0028](0028-account-service.md) | アカウントは Better Auth で自前でホストし、パスキーを主な手段とし、ブラウザは OAuth 2.1 の公開クライアントにする | accepted |
| [0029](0029-updater-protocol-and-staged-rollout.md) | 更新は Omaha 4 互換のプロトコルと二重の署名で行い、指標で自動に止める | accepted |
| [0030](0030-build-system.md) | ビルドは Cargo を基本にし、C/C++ の部品は事前にビルドした成果物を固定して使う | accepted |
| [0031](0031-ci-tiers-wpt-and-release-branches.md) | CI を presubmit・CQ・継続の 3 段にし、WPT は期待値で回帰を止め、リリースのブランチは cherry-pick だけにする | accepted |
| [0032](0032-crash-and-telemetry-privacy.md) | クラッシュとテレメトリは同意した人だけが送り、利用者の ID を持たせない | accepted |
| [0033](0033-service-infrastructure-and-dr.md) | サービスは配信を静的にして CDN で守り、署名の鍵と診断のデータを専用のアカウントに分ける | accepted |
| [0034](0034-macos-signing-with-rcodesign-and-cloudhsm.md) | macOS の署名は、Linux の署名専用の実行環境で rcodesign を使い、鍵を CloudHSM に置く | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

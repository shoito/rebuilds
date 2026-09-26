# Architecture: Chrome

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルにある。

| ファイル | 領域 |
| --- | --- |
| [process-model.md](process-model.md) | 複数プロセスの構成、IPC、サイトの隔離、プロセスの割り当て |
| [navigation-and-loading.md](navigation-and-loading.md) | ナビゲーション、履歴、読み込みの流れ、bfcache |
| [rendering.md](rendering.md) | DOM、スタイル、レイアウト、描画、合成、GPU |
| [javascript-and-web-apis.md](javascript-and-web-apis.md) | JavaScript エンジンの組み込み、バインディング、Web API の範囲 |
| [networking.md](networking.md) | HTTP、TLS、DNS、キャッシュ、Cookie、CORS、プライバシー |
| [storage.md](storage.md) | サイトの保存領域、割り当て、Service Worker |
| [sandbox-and-security.md](sandbox-and-security.md) | OS ごとのサンドボックス、脅威モデル、脆弱性への対応 |
| [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) | Safe Browsing、権限、パスワードマネージャ |
| [browser-ui.md](browser-ui.md) | タブ、アドレスバー、設定、プロファイル、アクセシビリティ、国際化 |
| [extensions.md](extensions.md) | Manifest V3、拡張機能のストア、審査 |
| [sync-and-accounts.md](sync-and-accounts.md) | アカウント、同期、エンドツーエンドの暗号化 |
| [update-and-release.md](update-and-release.md) | 自動更新、チャンネル、段階的な配信、クラッシュの収集、テレメトリ |
| [build-and-test.md](build-and-test.md) | ビルド、CI、Web Platform Tests、ファズ |
| [infrastructure.md](infrastructure.md) | クラウドのサービスの AWS の構成、冗長化、災害復旧 |
| [observability.md](observability.md) | クライアントとサービスの指標、SLO |
| [capacity.md](capacity.md) | サービスの負荷のモデル |
| [data-model.md](data-model.md) | クライアントの保存データとサービスのデータの索引 |

## 1. 全体構成

```
┌──────────────── ブラウザ（端末の上） ────────────────┐
│ Browser プロセス（UI、ナビゲーション、プロファイル、権限）│
│   ├─ Renderer プロセス（サイトごと。サンドボックス）      │
│   │     DOM・スタイル・レイアウト・JavaScript（V8）       │
│   ├─ GPU プロセス（合成、描画）                          │
│   ├─ Network サービス（HTTP・TLS・キャッシュ・Cookie）    │
│   ├─ Storage サービス（IndexedDB など）                  │
│   └─ Utility プロセス（音声・動画の復号、画像、PDF）      │
└──────────────────────────────────────────────────────┘
          │ HTTPS
┌──────── クラウドのサービス（AWS） ────────┐
│ 更新の配信、同期、アカウント、Safe Browsing のリスト、│
│ クラッシュの収集、テレメトリ、拡張機能のストア        │
└──────────────────────────────────────────┘
```

原則は 3 つ。

- **信頼できないものは、権限の低いプロセスで動かす。** Web のコンテンツを扱う Renderer は、OS のサンドボックスの中で、サイトごとに分ける（[ADR-0003](../decisions/0003-multi-process-site-isolation.md)）。
- **Browser プロセスは、Renderer を信用しない。** Renderer からの要求（保存領域、Cookie、権限）は、Browser 側で、そのプロセスに割り当てたサイトと照らして検査する。
- **修正を速く届ける。** 4 つのチャンネルと段階的な自動更新で、脆弱性の修正を決められた時間で配る（[ADR-0004](../decisions/0004-release-channels-and-updates.md)）。

## 2. 規模の段階

利用者の数は、主にクラウドのサービスの規模を決める。

| 段階 | 利用者（月間） | 構成 |
| --- | --- | --- |
| S1（MVP） | 10 万 | サービスは東京の 1 リージョン。更新の配信は CDN |
| S2 | 1,000 万 | 同期とクラッシュの収集を分割。Safe Browsing のリストの配信を CDN に寄せる |
| S3 | 1 億 | 複数のリージョン。更新の配信を世界の CDN に広げる |

## 3. 非機能要件

| ID | 項目 | 目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 起動の時間（ウォームの起動、最初の画面まで） | p75 1 秒以内 | 基準の端末で |
| NFR-002 | ページの表示 | 主要サイトの Core Web Vitals（LCP・INP・CLS）が、同じ端末の本家 Chrome の 1.2 倍以内 | |
| NFR-003 | JavaScript・描画の性能 | Speedometer 3.1 のスコアが、同じ端末の本家 Chrome の 80% 以上 | |
| NFR-004 | メモリ | タブ 20 枚の標準の作業で、本家 Chrome の 1.2 倍以内 | |
| NFR-005 | 安定性 | Stable のクラッシュ率（Browser プロセス）が 1,000 セッションあたり 0.5 件未満 | |
| NFR-006 | 修正の配信 | 重大な脆弱性の修正を、Stable への配信の開始から 48 時間以内に Stable の 90% の利用者へ届ける | 起点と終点の定義は [update-and-release.md](update-and-release.md) の 6 節。公表から配信の開始までは内部の目標で別に追う |
| NFR-007 | 互換性 | Web Platform Tests の合格率を、対象とした領域で 90% 以上。主要サイト 1,000 件で致命的な表示の崩れ 0 件 | |
| NFR-008 | 同期 | 別の端末への反映 p95 10 秒以内 | |
| NFR-009 | Safe Browsing | 新しい危険なサイトのリストへの反映から、端末での判定まで 30 分以内 | |
| NFR-010 | サービスの可用性 | 更新の配信・Safe Browsing は月間 99.95%、同期は 99.9% | |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| ブラウザ・エンジン | Rust | メモリ安全性。攻撃にさらされるコードで、脆弱性の主な原因を言語で減らす（[ADR-0001](../decisions/0001-languages-and-platform.md)） |
| JavaScript | V8（Rust のバインディングで組み込む） | [ADR-0002](../decisions/0002-engine-build-vs-reuse.md) |
| クラウドのサービス | TypeScript（Hono）、AWS | 他の題材と同じ |
| ビルド | Cargo を基本にし、C/C++ の部品は上流のビルド（GN・CMake）で事前に作った成果物を固定して使う | [ADR-0030](../decisions/0030-build-system.md)、[build-and-test.md](build-and-test.md) |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-languages-and-platform.md) | ブラウザは Rust、サービスは TypeScript と AWS |
| [0002](../decisions/0002-engine-build-vs-reuse.md) | 構造は自作し、成熟した部品を使う |
| [0003](../decisions/0003-multi-process-site-isolation.md) | 複数プロセスとサイトの隔離を、最初から前提にする |
| [0004](../decisions/0004-release-channels-and-updates.md) | 4 つのチャンネルと、4 週ごとのリリース、段階的な自動更新 |
| [0005](../decisions/0005-privacy-first-services.md) | サービスは、送るデータを最小にし、同期は暗号化する |
| [0006](../decisions/0006-typed-capability-ipc.md) | IPC は、型付きの IDL と、端点を権限として渡す形で自作する |
| [0007](../decisions/0007-process-allocation-policy.md) | 常にサイトごとにプロセスを分け、上限を超えても異なるサイトを混ぜない |
| [0008](../decisions/0008-browser-driven-navigation-commit.md) | ナビゲーションは Browser が主導し、応答を見てプロセスを決め、文書ごとに frame の実体を作る |
| [0009](../decisions/0009-back-forward-cache.md) | bfcache は、ページを同じプロセスに凍結して残し、実行が要れば追い出す |
| [0010](../decisions/0010-v8-embedding-and-dom-gc.md) | V8 を rusty_v8 で組み込み、DOM を cppgc のヒープに置いて一緒に追跡する |
| [0011](../decisions/0011-stylo-style-engine.md) | スタイルの計算は Stylo |
| [0012](../decisions/0012-own-layout-engine.md) | レイアウトは自作し、不変のフラグメントの木を出す。Grid は Taffy を下で使う |
| [0013](../decisions/0013-skia-raster-and-own-compositor.md) | raster は Skia、合成は自作 |
| [0014](../decisions/0014-web-idl-bindings-generation.md) | バインディングは Web IDL から Rust のコードを生成する |
| [0015](../decisions/0015-tls-and-certificate-verification.md) | TLS は rustls、証明書の検証は自作、ルートストアは本家の Chrome Root Store に揃える |
| [0016](../decisions/0016-third-party-cookies-blocked-by-default.md) | サードパーティ Cookie を既定で遮断し、CHIPS と Storage Access API で補う |
| [0017](../decisions/0017-partitioning-by-top-level-site.md) | ネットワークの状態と保存領域を、トップレベルのサイトで分割する |
| [0018](../decisions/0018-indexeddb-on-sqlite.md) | IndexedDB を SQLite の上に作る |
| [0019](../decisions/0019-os-sandbox-baseline.md) | OS ごとのサンドボックスを Rust で自作し、プロセスの種類ごとの基準を決める |
| [0020](../decisions/0020-memory-safety-and-unsafe-policy.md) | Rule of 2 を Rust に当てはめ、`unsafe` と C/C++ の部品の置き場所を決める |
| [0021](../decisions/0021-safe-browsing-list-source.md) | Safe Browsing の脅威のリストは自前で作り、第三者のフィードを使う |
| [0022](../decisions/0022-permission-model.md) | 権限は、要求したオリジンと最上位のオリジンの組で持ち、端末の中の信号で静かにし、自動で失効させる |
| [0023](../decisions/0023-password-manager-encryption.md) | パスワードは OS の鍵ストアで守る鍵で暗号化し、同期は E2EE、漏洩の確認は k-匿名性 |
| [0024](../decisions/0024-ui-toolkit.md) | 枠の UI は Rust の自前の UI 層で描き、内部ページはエンジンで描く |
| [0025](../decisions/0025-extension-platform-mv3.md) | 拡張機能は MV3 に互換。`chrome.*` を互換の別名にする（リポジトリ共通の ADR-0006 の例外） |
| [0026](../decisions/0026-extension-store-review.md) | ストアは自動と人の審査を組み合わせ、停止の一覧で公開後も止められる |
| [0027](../decisions/0027-sync-protocol-and-e2ee.md) | 同期は版の番号による楽観的な排他。すべてのデータ型を利用者の鍵で暗号化する |
| [0028](../decisions/0028-account-service.md) | アカウントは Better Auth で自前でホストし、パスキーが主。ブラウザは OAuth 2.1 の公開クライアント |
| [0029](../decisions/0029-updater-protocol-and-staged-rollout.md) | 更新は Omaha 4 互換のプロトコルと二重の署名で行い、指標で自動に止める |
| [0030](../decisions/0030-build-system.md) | ビルドは Cargo を基本にし、C/C++ の部品は事前にビルドした成果物を固定して使う |
| [0031](../decisions/0031-ci-tiers-wpt-and-release-branches.md) | CI は presubmit・CQ・継続の 3 段。WPT は期待値で回帰を止め、リリースのブランチは cherry-pick だけ（リポジトリ共通の ADR-0002 の例外） |
| [0032](../decisions/0032-crash-and-telemetry-privacy.md) | クラッシュとテレメトリは同意した人だけが送り、利用者の ID を持たせない |
| [0033](../decisions/0033-service-infrastructure-and-dr.md) | 配信を静的にして CDN で守り、署名の鍵と診断のデータを専用のアカウントに分ける |
| [0034](../decisions/0034-macos-signing-with-rcodesign-and-cloudhsm.md) | macOS の署名は、Linux の署名専用の実行環境で rcodesign を使い、鍵を CloudHSM に置く |

リポジトリ共通の決定（開発プロセス、トランクベース開発の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)、本家の名前・接頭辞を使わない規則の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）は、ルートの [docs/decisions/](../../../../docs/decisions/) にある。この題材は、そのうち 2 つに例外を持つ（下の「決定」）。

## 6. リスクと未解決事項

品質から見たリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。

- **サイトの隔離とサンドボックスの破れ**：侵害された Renderer を前提にした設計（ADR-0003・0006・0019・0020）でも、Browser 側の検査の漏れ 1 つで破れる。検査を 1 か所に集め、侵害された Renderer を模すテストとファズで確かめる（[sandbox-and-security.md](sandbox-and-security.md)）。
- **互換性の長い尾**：Web の互換性は、少数のサイトの特殊な振る舞いで崩れる。Web Platform Tests と主要サイトの自動検査で追う（[build-and-test.md](build-and-test.md)）。サードパーティ Cookie の遮断（ADR-0016）と、Stylo による Firefox 寄りのスタイルの振る舞い（ADR-0011）が、本家との差の主な出どころになる。
- **自作の量と性能**：レイアウト・合成・ナビゲーション・UI の層は自作で、長年最適化された本家に並ぶには時間がかかる（NFR-002〜004）。E3 で測り、予算を超えた段から直す。
- **部品の更新とパッチの空白**：V8 などの上流の修正の公開から、自分たちの配信までの間に攻撃されうる。上流の事前通知の枠組みに入れるかは未解決（下の「持ち越し」）。
- **更新の経路**：署名の鍵の漏洩、再起動しない利用者、Linux のパッケージ管理の遅れが NFR-006 を崩す（[update-and-release.md](update-and-release.md) の 14 節）。S1 では同意した端末が少なく、自動の停止の標本が足りない。
- **Safe Browsing の検出の質**：自前のリスト（ADR-0021）は、本家のリストより検出が遅く狭い可能性が高い。フィードの選定と、誤検知の運用に依存する。
- **同期の鍵の喪失**：すべての端末と回復用のコードを失うと、データは戻らない（ADR-0027）。
- **拡張機能の互換と審査の人手**：本家の拡張機能の細かな振る舞いへの依存と、人の審査の量（[extensions.md](extensions.md) の 11 節）。
- **法務・事業の確認待ち**：Widevine、ソースの公開とライセンス、失効のリストの再配布などは、[intent.md](../intent.md) の「法務・事業の確認待ち」に集めた。結論が出るまで、そこに挙げた Story の spec を承認しない。

### 決定（2026-09-26、既定案）

PM の方針（追加の質問なしに既定案で進める。本家の Chromium に寄せる）により、各文書の未解決事項を次のとおり決めた。法務・事業の判断が要るものは決めず、[intent.md](../intent.md) の「法務・事業の確認待ち」に集めた。計測・PoC・契約で決めるものは、下の「持ち越し」に置いた。

- **リリースの周期は 4 週のまま**（ADR-0004）。本家は 2026-09-08 の Chrome 153 から Stable と Beta を 2 週ごとにした（[update-and-release.md](update-and-release.md) の 1 節）。S2 の前に見直し、変えるなら ADR-0004 を置き換える ADR を書く。
- **`release/M` のブランチは、リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md) の、配布型のソフトウェアのための例外として認める**（[ADR-0031](../decisions/0031-ci-tiers-wpt-and-release-branches.md)）。この題材に固有の例外であり、範囲は次に限る：`main` のある 1 コミットのスナップショット、先に `main` へ入れた修正の cherry-pick だけ、release owner の承認、保守の期間の後は読み取り専用（[update-and-release.md](update-and-release.md) の 2 節）。リポジトリ共通の文書での扱いは、リポジトリの側で別に記録する。
- **NFR-006 の起点は、修正の版の Stable への配信の開始**とする。終点は、直近 48 時間に活動した Stable の端末の 90% が修正の版で動いた時刻。公表から配信の開始までは内部の目標で追う（悪用が確認されたものは 24 時間以内、上流の部品の Critical・High は上流の公開から 3 日以内に Stable の修正の版）。OS ごとの値も記録する。[update-and-release.md](update-and-release.md) の 6 節、[sandbox-and-security.md](sandbox-and-security.md) の 7.2・11 節、3 節の NFR の表を揃えた。
- **DRM（Widevine）は S1 に含めない。** Widevine を使うには提供元のライセンスが要り、申請は外部の手続きである。[roadmap.md](../roadmap.md) の「後回しにしたもの」と、[intent.md](../intent.md) の「法務・事業の確認待ち」に置いた。使うかどうかは決めない。
- **本家の名前を識別子に使わない**（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。内部のスキームは `<brand>://`、拡張機能は `<brand>-extension://`、ポリシーの置き場所は `<Brand>`・`<brand>`、サービスのドメインは `<service>.<brand>.<domain>`、User-Agent と Client Hints のブランドは自前の名前にする。**例外は [ADR-0025](../decisions/0025-extension-platform-mv3.md) の拡張機能の API の名前空間 `chrome.*` だけ**（既存の拡張機能の互換のため）。出典として本家の名前を書くのはよい。[sandbox-and-security.md](sandbox-and-security.md) の 3 節と [infrastructure.md](infrastructure.md) の 3 節の表記を揃えた。
- **基準の端末**は、[build-and-test.md](build-and-test.md) の 4.4 節の性能の測定の専用の機械（3 OS）とする。NFR-001〜004 と、各文書の性能の予算はこの機械で測る。
- **端末の保存の形式**：LevelDB を使わない。本家が LevelDB に置くもの（localStorage、拡張機能の保存、同期の状態）も SQLite にする（ADR-0018 の「保存の部品を SQLite に揃える」）。設定・ブラウザ全体の状態・ブックマークは JSON（書き込みは一時ファイルからの置き換え）、セッションは追記の記録のファイル。一覧は [data-model.md](data-model.md) の 1 節。
- **プロファイルの形式の互換**：新しい版で書き換えた後も、1 つ前のマイルストーンの版が読める形を保つ（[data-model.md](data-model.md) の 3 節）。[storage.md](storage.md) の 12 節の「古い版は開かずに失敗させる」は、この規則の外（2 つ以上前の版）に限ると改めた。
- **自動入力の暗号化**：本家と同じく、住所などの値は暗号化せず、OS の権限に任せる。支払いのカードは MVP の外。Cookie の値は [networking.md](networking.md) の 8.3 節のとおり暗号化する。
- **Linux のダウンロードの印**：本家と同じく、拡張属性 `user.xdg.origin.url`・`user.xdg.referrer.url` を付ける。[navigation-and-loading.md](navigation-and-loading.md) の 9 節と [browser-ui.md](browser-ui.md) の 7 節を改めた。
- **`document.domain`**：本家と同じく、既定でオリジン単位のエージェントのまとまりにし、`Origin-Agent-Cluster: ?0` で明示的に外した文書だけ書き込みを許す。[javascript-and-web-apis.md](javascript-and-web-apis.md) の 4.2 節を [process-model.md](process-model.md) の 3.4 節に揃えた。
- **Safe Browsing の手元のリストの更新は 15 分ごと**（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 2.3 節）。[capacity.md](capacity.md) の 2.2 節の負荷を揃えた。フィールドトライアルの設定は 30 分ごとのまま。
- **同期の規模の前提**は [capacity.md](capacity.md) の 1 節（月間の利用者の 40%、1 人 1.5 台）を正とし、[sync-and-accounts.md](sync-and-accounts.md) の 9 節を揃えた。
- **失効のリスト**は、CCADB の CRL から自前で作る。本家の CRLSet の再配布は法務の確認待ちで、認められたら替えてよい。
- **漏洩の確認**は、Pwned Passwords の範囲 API を OHTTP の中継で使う。自前の写しは、配布の条件の確認（法務）の後に検討する。
- **ネットワークの既定**：プロキシの自動検出（WPAD）は OS の設定に従い、ブラウザが独自に有効にしない。`Sec-GPC` は既定で送らない（設定で送れる）。どちらも本家と同じ。
- **永続の保存の許可**は、確認を出さず、条件（ブックマーク済み、インストール済みのアプリ、通知の許可、利用の多さ）で与える（本家と同じ）。
- **ログインの互換**：サードパーティ Cookie の一時的な許可は、本家の 3PCD のヒューリスティクス（ポップアップ・リダイレクトの後の期限付きの許可）の形に揃える。値はポップアップの後 30 日、リダイレクトの後 15 分（2026-09-27 に確認。[networking.md](networking.md) の 8.1 節）。
- **WebGL の後に Web Audio**（MVP の後、E2 の Story）。
- **ソースの公開**：本家（Chromium）と同じく公開する前提で設計を進める。ライセンスと公開の時期は法務・事業の確認待ち。OSS-Fuzz への参加は、公開の後に ClusterFuzz と比べる。
- **CVE**：E10 で CNA の登録を申請する（本家も自ら採番する）。それまでは MITRE に採番を依頼する。
- **本家の値**：2026-09-27 に本家のソースで確かめ、各文書に出典を書いた。`beforeunload` の打ち切り（500 ms）、応答のない Renderer（15 秒）、履歴（50 件）、bfcache（6 ページ・10 分）、接続（6・256）、Happy Eyeballs（300 ms）、Service Worker（30 秒・5 分）、localStorage（10 MiB）、一時の抑止（3 回・7 日）、使っていないサイト（60 日）、HTTPS-First（15 日）、GPU の切り替え（5 分ごとに 1 回を許し、3 回で 1 段下げる）、CT のログの一覧の古さ（70 日）、DNR の全体の枠（300,000）。どれも本家と同じ値にした。確かめられなかったもの（`pushState` の大きさの上限など）は、書いた値を初期値として実装し、各領域の Epic の Story で揃える。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・4 節（[observability.md](observability.md) の 4 節の提案をそのまま採った）。性能の予算・WPT の対象・リリースの合否は [quality.md](../quality.md)。段階的な配信の自動の停止の閾値は [update-and-release.md](update-and-release.md) の 4.3 節。負荷の前提は [capacity.md](capacity.md)。

持ち越し（計測・PoC・契約で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| rusty_v8 のサンドボックス・ポインタの圧縮（既定で無効と確認。ソースからビルドする）とアクセス検査の API の追加、cppgc の DOM の速度、weedle2 のフォークか自作か（`ObservableArray` がないと確認）、Stylo の `servo` で足りないプロパティ、`skia-safe` の Graphite と ANGLE、HarfRust の速度とメトリクス、Rust の画像の復号器の互換、DevTools のフロントエンド | E1 の PoC（[rendering.md](rendering.md) の 17 節、[javascript-and-web-apis.md](javascript-and-web-apis.md) の 7 節） |
| Taffy の Grid の合格率、WPT の結果の wpt.fyi への掲載（手続きは確認済み：送り手の登録とブラウザの名前の追加） | E2 |
| プロセスの上限の式、IPC・RenderDocument の費用、V8 の `Intl` と ICU4X の二重持ちのメモリ、OS の合成器への委譲、Linux の PSI の閾値 | E3 の計測 |
| `h3` の成熟度（足りなければ `quiche`）、IndexedDB の性能 | E4 |
| Linux のユーザー名前空間の制限、LPAC・CET の範囲、商用の脅威のフィード、OHTTP の中継の事業者（契約） | E5 の着手前に選ぶ・確かめる |
| winit の IME、IA2 の要否（AccessKit は IA2 を持たないと確認）、AccessKit の性能 | E6 の初め |
| 上位の拡張機能のマニフェストの集計 | E7 の初め |
| Argon2id の引数、OAuth 2.1 Provider の第一者のクライアントの動作（文書では対応を確認）、Linux の hybrid の品質 | E8 の初め |
| macOS の署名：[ADR-0034](../decisions/0034-macos-signing-with-rcodesign-and-cloudhsm.md)（rcodesign と CloudHSM、公証は App Store Connect の API キー）で決めた。rcodesign の PKCS#11 は未リリースの機能なので、公証と Gatekeeper の検査を通ることを確かめる。Linux の GPG の署名を CloudHSM でどう行うか | E9 の PoC（`macos-signing-poc`、`linux-packages`）。確かめ終えるまで macOS の Stable は出さない |
| 上流の部品の事前通知の枠組み、バグ報奨金の金額と運営、CNA | E10 |
| 2 週の周期、Origin-Agent-Cluster のプロセスの分離（本家は既定で分けないと確認）、Storage サービスの別プロセス化、同期のメタデータのパディング、パスキーの PRF での鍵の保護、社内の Canary の広いダンプ | S2 の前 |
| Google との契約（Web Risk など）を出所に足すか | S2 の運用の後（ADR-0021） |

# Architecture: Cloudflare Workers

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルに置く。領域の文書はまだない（統合の工程で作る）。予定のファイルと、各領域に割り当てた ADR の番号の範囲は 7 節にある。

## 1. 全体構成

```
利用者のブラウザ・アプリ
   │ DNS：<worker>.<account>.<brand>.<domain>、または利用者のドメイン（CNAME・A）
   ▼
Global Accelerator の anycast の IP（AWS の edge で TCP を受ける）
   │ AWS のバックボーン
   ▼
┌──────── エッジのリージョン（S1：東京・大阪＋海外 3） ─────────────────┐
│ NLB ──▶ エッジのノード（EC2）                                          │
│   ├─ 入口のプロキシ：TLS の終端、ルートの解決、ノードへの振り分け        │
│   ├─ ランタイム（workerd を元にしたもの）                               │
│   │    プロセスは cordon（信頼の段階）ごと。1 プロセスに多数の isolate    │
│   │    seccomp・名前空間のサンドボックスの中で動く                       │
│   ├─ 外向きのプロキシ：サブリクエスト、バインディングの呼び出し          │
│   └─ 設定の写し（LMDB）とコードのキャッシュ                            │
│ リージョンのサービス：KV のキャッシュ、Durable Objects のホスト、        │
│   キューのブローカー、ログとメトリクスの収集                           │
└─────────────────────────────────────────────────────────────────┘
   ▲ 設定とコードの配信（ADR-0004）         │ 使用量・ログ・ノードの状態
┌──────── 制御プレーン（東京、DR は大阪） ─────────────────────────────┐
│ 管理 API（Hono）・ダッシュボード・CLI の窓口                             │
│ デプロイ（版、段階的な割合）、ルートとドメイン、証明書（ACME）            │
│ 設定の正本（Aurora）──▶ 変更のログ ──▶ 配信の中継（リージョンごと）       │
│ 課金と使用量の集計、不正利用の対応                                       │
│ ストレージの中央：KV の正本、オブジェクトストレージのメタデータ          │
└─────────────────────────────────────────────────────────────────┘
```

| コンポーネント | 責務 |
| --- | --- |
| 入口のプロキシ | TLS の終端（既定のドメインとカスタムドメイン）、HTTP の解析、ホスト名とパスからルートを解決し、関数と版を決める。段階的なデプロイの割合で版を選ぶ |
| ランタイム | workerd を元にしたもの。isolate の作成・再利用・退避、CPU とメモリの制限、互換の日付、Web API（[ADR-0001](../decisions/0001-runtime-build-vs-reuse.md)） |
| スーパーバイザー | ノードの上で、ランタイムのプロセスを cordon ごとに起動・監視・入れ替える。テナントをどのプロセスに載せるかを決める（[ADR-0002](../decisions/0002-isolation-model.md)） |
| 外向きのプロキシ | 利用者のコードからのすべての通信（`fetch`、WebSocket、バインディング）を受け、宛先の制限、サブリクエストの数の制限、内部のアドレスの遮断を行う |
| 設定の写し | 制御プレーンの変更を順序付きで受け、ノードの LMDB に書く。リクエストの処理は、この写しだけを読む（[ADR-0004](../decisions/0004-config-and-code-distribution.md)） |
| ストレージ | KV、オブジェクトストレージ、Durable Objects、キュー。一貫性の約束は製品ごとに違う（[ADR-0005](../decisions/0005-storage-consistency.md)） |
| 制御プレーン | 管理 API、デプロイ、証明書、課金、使用量、不正利用の対応。他の題材と同じ技術で作る |

原則は 3 つ。

- **利用者のコードは、多層で閉じ込める。** isolate は 1 層目にすぎない。プロセスのサンドボックス、信頼の段階ごとのプロセスの分離（cordon）、Spectre の対策、V8 の修正の 24 時間以内の配信を重ねる（[ADR-0002](../decisions/0002-isolation-model.md)）。
- **データプレーンは、制御プレーンなしで動く。** エッジのノードは、手元の設定の写しとコードのキャッシュで処理する。制御プレーンが止まると新しいデプロイは止まるが、デプロイ済みの関数は動き続ける（[ADR-0004](../decisions/0004-config-and-code-distribution.md)）。
- **一貫性の約束は、製品ごとに明示する。** KV は速さのために結果整合、オブジェクトストレージは強い整合、Durable Objects は 1 つの実体で直列に処理する。利用者が用途に合わせて選ぶ（[ADR-0005](../decisions/0005-storage-consistency.md)）。

## 2. 規模の段階

| 段階 | 要求（ピーク） | アカウント・関数 | 計算の拠点 | 構成 |
| --- | --- | --- | --- | --- |
| S1（MVP） | 5 万 件/秒 | 1 万アカウント、5 万関数 | AWS の 5 リージョン（東京・大阪＋海外 3。シンガポール・オレゴン・フランクフルトを第一の候補にする） | Global Accelerator の anycast の IP → 各リージョンの NLB → エッジのノード。制御プレーンは東京（DR は大阪）。KV の正本とオブジェクトストレージの既定のホームは東京 |
| S2 | 50 万 件/秒 | 10 万アカウント、50 万関数 | AWS の 12〜15 リージョン（Local Zones の利用は未検証） | 自前の IP の範囲（BYOIP）を Global Accelerator で広告する。KV のリージョンの読み込みの複製、Smart Placement に相当する配置、オブジェクトストレージのホームのリージョンを選べるようにする |
| S3 | 500 万 件/秒 | 100 万アカウント、500 万関数 | 自前の PoP（国内の主要都市と海外の 50 都市以上）＋ AWS のリージョン | 自前の AS 番号と BGP anycast。拠点の中は L4 の負荷分散で機械に振り分ける。AWS のリージョンは、ストレージの中央と制御プレーン、PoP のない地域の受け皿に使う |

本家の網は 100 か国以上の 348 都市にあり、インターネットの利用者の 95% が 50ms 以内にいるとしている（[Cloudflare Global Network](https://www.cloudflare.com/network/)、2026-09-27 に確認）。S1・S2 はこれに遠く及ばない。日本の利用者を先にし、東京・大阪の 2 リージョンで国内を賄う（[ADR-0003](../decisions/0003-edge-locations.md)）。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 起動（コールドスタート） | isolate の起動 p99 5ms 未満（コードがノードのキャッシュにあり、バンドルが 1MiB 以下のとき。利用者のトップレベルのコードの実行を除く）。コードがノードにないときは、リージョンの中から取得して p99 50ms 以内 | 本家は isolate の起動を約 5ms とする（[Cloud Computing without Containers](https://blog.cloudflare.com/cloud-computing-without-containers/)、2026-09-27 に確認） |
| NFR-002 | プラットフォームが足す遅延 | ノードに要求が届いてから関数に渡すまでと、応答を返すまでの合計 p50 2ms 以内、p99 10ms 以内（TLS の握手、利用者の CPU 時間、サブリクエストの待ちを除く） | 入口のプロキシとランタイムで分けて計測する |
| NFR-003 | 利用者からの近さ | 国内の主要な ISP から最寄りのリージョンまでの RTT p50 15ms 以内。海外は、S1 の 5 リージョンからの距離に応じた値を計測して公開する | 海外の遅延は本家より大きい（[ADR-0003](../decisions/0003-edge-locations.md)） |
| NFR-004 | 可用性 | データプレーン（関数の実行）月間 99.99%。制御プレーン（管理 API・デプロイ）月間 99.9%。ストレージの読み込み 99.99%、書き込み 99.9% | 1 リージョンの障害は、anycast の迂回で吸収する |
| NFR-005 | 制限の強制 | CPU の時間の上限を超えた isolate は、上限＋10ms 以内に止める。メモリの上限（128MiB）を超えた isolate は、同じプロセスの他の isolate を止めずに退避する。制限による停止が、同じプロセスの他のテナントの p99 の遅延を 1ms 以上悪化させない | 本家の上限は、CPU 時間が無料で 10ms、有料で既定 30 秒・最大 5 分、メモリが 128MB（[Limits](https://developers.cloudflare.com/workers/platform/limits/)、2026-09-27 に確認） |
| NFR-006 | テナントの隔離 | 他のテナントのコード・データ・シークレット・メモリに届く事象 0 件。サンドボックスの脱出 0 件。Spectre の対策（止めた時計、スレッドと `SharedArrayBuffer` の禁止、ネイティブのコードの禁止、怪しい振る舞いの isolate のプロセスの分離）を常に有効にする | [ADR-0002](../decisions/0002-isolation-model.md) |
| NFR-007 | V8 のセキュリティの修正 | 上流の Critical・High の修正の公開から、全エッジのノードで修正済みの版が動くまで 24 時間以内 | 本家の目標と同じ（[Security model](https://developers.cloudflare.com/workers/reference/security-model/)、2026-09-27 に確認） |
| NFR-008 | デプロイの伝搬 | デプロイの受付から全ノードへの反映まで p99 30 秒以内。ルート・シークレット・設定の変更は p99 10 秒以内。反映していないノードは、古い版で応答したことを記録する | [ADR-0004](../decisions/0004-config-and-code-distribution.md) |
| NFR-009 | ストレージの一貫性 | KV：書き込みから全リージョンで読めるまで、キャッシュの TTL が既定の 60 秒のとき p99 70 秒以内。オブジェクトストレージ：成功を返した書き込み・削除は、直後のすべての読み込み・一覧に反映する。Durable Objects：1 つの名前に同時に 1 つの実体。書き込みが確定する前に、その結果に依存する応答を外へ出さない | [ADR-0005](../decisions/0005-storage-consistency.md) |
| NFR-010 | 耐久性と復旧 | 成功を返した書き込み（KV、オブジェクト、Durable Objects、キューのメッセージ）を失わない。AZ の障害：RPO 0、RTO 5 分以内。リージョンの障害：関数の実行は anycast の迂回で RTO 5 分以内。ストレージのホームのリージョンの全体の障害は RPO 1 分以内・RTO 1 時間以内（手動の移動。Durable Objects はそれまで使えない。ADR-0005） | オブジェクトの本体は S3 の耐久性に頼る |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| ランタイム | workerd（C++、V8）を元にし、上流との差分を最小にする | [ADR-0001](../decisions/0001-runtime-build-vs-reuse.md) |
| エッジのノードの自前の部品 | Rust（入口のプロキシ、スーパーバイザー、外向きのプロキシ、設定の写しの受け手） | メモリの安全と、遅延の予測のしやすさ。[ADR-0001](../decisions/0001-runtime-build-vs-reuse.md) |
| エッジのノードの OS | Linux（EC2）。seccomp、名前空間、cgroup v2 | [ADR-0002](../decisions/0002-isolation-model.md) |
| 入口 | AWS Global Accelerator（anycast の IP）→ NLB → EC2。S3 で自前の PoP と BGP anycast | [ADR-0003](../decisions/0003-edge-locations.md) |
| 設定とコードの配信 | Aurora の変更のログ → リージョンの中継 → ノードの LMDB。コードは内容のハッシュで S3 に置く | [ADR-0004](../decisions/0004-config-and-code-distribution.md) |
| 制御プレーン | TypeScript（Hono＋Zod）、ECS Fargate、Aurora PostgreSQL 18、SQS | 他の題材と同じ |
| CLI | TypeScript（Node.js で配る）。ローカル開発は workerd のバイナリを同梱して動かす | 開発者の多くが Node.js を持つ。本番と同じランタイムで手元を動かす |
| ストレージ | KV・オブジェクトストレージのメタデータ・Durable Objects の保存の具体は各領域で決める。オブジェクトの本体は S3 | [ADR-0005](../decisions/0005-storage-consistency.md) |
| IaC | Terraform | 他の題材と同じ |
| 可観測性 | OpenTelemetry → AMP、X-Ray、CloudWatch Logs。エッジのノードのログは量が多いので、集約してから S3 に置く | 他の題材と同じ。詳細は observability の領域で決める |

## 5. 主な決定

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-runtime-build-vs-reuse.md) | エッジのランタイムは workerd を元にし、多数のテナントの層は Rust で作る。制御プレーンは共通の技術を使う |
| [0002](../decisions/0002-isolation-model.md) | 多数のテナントの V8 isolate を共有のプロセスで動かし、プロセスのサンドボックス・cordon・Spectre の対策・V8 の修正の 24 時間以内の配信を重ねる |
| [0003](../decisions/0003-edge-locations.md) | S1・S2 は AWS のリージョンのエッジのノードを Global Accelerator の anycast の IP の後ろに置き、S3 で自前の PoP と BGP anycast に移る |
| [0004](../decisions/0004-config-and-code-distribution.md) | 設定とコードは、順序付きの変更のログを全ノードの読み込み用の写しへ押し出して配り、伝搬の SLO と版で管理する |
| [0005](../decisions/0005-storage-consistency.md) | 一貫性は製品ごとに決める。KV は結果整合、オブジェクトストレージはホームのリージョンで強い整合、Durable Objects は 1 つの実体とトランザクションの保存 |

領域ごとの ADR は、7 節の番号の範囲で各文書から起票する。

## 6. リスクと未解決事項

- **workerd を多数のテナントで動かすための不足**：上流の README は、workerd だけでは悪意のあるコードへの多層の防御が足りず、VM などのサンドボックスの中で動かすよう求めている（[workerd](https://github.com/cloudflare/workerd)、2026-09-27 に確認）。本家の本番は、公開されていない層（テナントの動的な読み込み、cordon、プロセスのサンドボックス）を持つ。これを自前で作る量は未検証で、E2・E3 の最大の不確実性である（[ADR-0001](../decisions/0001-runtime-build-vs-reuse.md)）。
- **Spectre と未知のサイドチャネル**：isolate はプロセスの中の境界なので、CPU のサイドチャネルへの耐性は VM より弱い。止めた時計などの対策は攻撃を遅くするが、完全には防がない。高い信頼の要るテナントには、専用のプロセス・専用のホストの cordon を用意する（[ADR-0002](../decisions/0002-isolation-model.md)）。
- **V8 の修正の 24 時間の配信**：V8 の更新は、workerd の API の変更や性能の退行を伴うことがある。24 時間で全ノードに届けながら、退行を防ぐ試験と段階的な配信を両立させる必要がある。
- **拠点の少なさ**：S1 の 5 リージョンでは、日本以外の利用者の遅延は本家より大きい。Global Accelerator は TCP を AWS の edge で受けるが、TLS と関数の実行はリージョンで行う（[ADR-0003](../decisions/0003-edge-locations.md)）。
- **IP のアドレスの移行**：利用者の apex のドメインは A レコードで IP を指す。S3 で自前の PoP に移るとき、IP を変えずに移るには、自前の IP の範囲を早くから持つ必要がある（[ADR-0003](../decisions/0003-edge-locations.md)）。
- **Durable Objects の一意性**：ノードの障害と網の分断の中で、1 つの名前に 2 つの実体を作らないことは、リースとフェンシングの正しさに依存する。性質ベーステストと障害の注入で確かめる（[ADR-0005](../decisions/0005-storage-consistency.md)）。
- **不正利用**：無料の枠と既定のサブドメインは、フィッシング・マルウェアの配布・プロキシとしての悪用に使われやすい。法令の上の扱いは法務の確認待ち（[intent.md](../intent.md) の L1・L2・L4）。

## 7. 領域と ADR の番号の範囲

領域の文書は、統合の工程で作る。各領域の ADR は、下の範囲の中で採番する。範囲を使い切ったら、この表を更新してから次の空き番号を割り当てる。Epic は roadmap の草案（E1〜E12）の番号。

| ファイル（予定） | 領域 | ADR の範囲 | 関係する Epic |
| --- | --- | --- | --- |
| runtime-and-isolates.md | workerd の取り込みと上流の追従、isolate の作成・再利用・退避、テナントのコードの動的な読み込み、互換の日付とフラグ、バンドルの形式（ES モジュール、Wasm）、CPU・メモリの計測 | 0006–0009 | E2 |
| sandbox-and-security.md | 脅威モデル、プロセスのサンドボックス（seccomp、名前空間、cgroup）、cordon、Spectre の対策（止めた時計、スレッドの禁止、動的なプロセスの分離）、V8 の修正の 24 時間の配信、脱出のテスト、ファズ | 0010–0013 | E3 |
| web-apis-and-compat.md | WinterTC の最小の共通 API、`fetch` とサブリクエスト、WebSocket、Web Crypto、Node.js の互換の範囲、`request.<brand>` の属性、WPT での適合の確認 | 0014–0016 | E2 |
| edge-network-and-routing.md | anycast の IP と DNS、Global Accelerator と NLB、TLS の終端と証明書（ACME）、ルートの解決、リージョンの間の迂回、ノードの間の負荷分散、外向きのプロキシ | 0017–0020 | E4 |
| deployment-and-config-distribution.md | 版とデプロイ、段階的なデプロイ、ロールバック、設定の変更のログと配信の中継、ノードの写し、コードの配布とキャッシュ、シークレットとバインディング | 0021–0023 | E5 |
| kv-store.md | KV の API、中央の保存、リージョンとノードのキャッシュ、TTL、書き込みの制限、一覧 | 0024–0025 | E7 |
| object-storage.md | S3 互換の API、バインディング、バケットのホームのリージョン、メタデータと本体、マルチパート、公開の配信とキャッシュ、署名付きの URL | 0026–0028 | E8 |
| durable-objects.md | 名前から実体への対応、配置、リースとフェンシング、入力と出力のゲート、SQLite の保存と複製、アラーム、WebSocket の休止、障害時の移動、データの所在 | 0029–0032 | E9 |
| queues-and-cron.md | キューの保存と配信、少なくとも 1 回、再試行とデッドレター、バッチでの消費、cron の式とスケジューラ | 0033–0034 | E10 |
| developer-tooling.md | CLI、設定ファイル、ローカル開発（workerd と模擬のストレージ）、tail、ログの検索、型の生成 | 0035–0037 | E6 |
| limits-and-billing.md | 制限の値、使用量の計測（要求数、CPU ミリ秒、ストレージの操作）、集計と請求、無料の枠、円の料金 | 0038–0040 | E11 |
| dashboard-and-api.md | 管理 API、ダッシュボード、アカウントとメンバー、API トークン | 0041–0042 | E1、E6 |
| abuse-and-trust-safety.md | フィッシング・マルウェアの検知と停止、採掘などの禁止の用途、通報の窓口、既定のサブドメインの扱い | 0043–0045 | E12 |
| security.md | 制御プレーンの脅威モデル、シークレットの暗号化と鍵、監査ログ、脆弱性の報奨の窓口、データのライフサイクル | 0046–0048 | E3、E12 |
| infrastructure.md | AWS のアカウントとリージョン、エッジのフリート（インスタンスの型、AMI、配置）、制御プレーンの冗長化、災害復旧、S3 の自前の PoP への移行 | 0049–0051 | E1、E4 |
| observability.md | ログ、メトリクス、トレース、SLI・SLO、ノードの健全性、テナント向けの指標の分離 | 0052–0053 | E6、E1 |
| capacity.md | 負荷のモデル、ノードあたりの isolate の数、メモリの予算、リージョンごとの必要量 | 0054 | E1、E4 |
| delivery.md | CI/CD、ランタイムとエッジのノードの段階的な配信、V8 の修正の緊急の経路、フィーチャーフラグ | 0055–0056 | E1、E3、E5 |
| data-model.md | データモデルの索引（ADR は持たない） | — | 全体 |

## 8. 参考にした類似の基盤

| 基盤 | 隔離と実行の単位 | 拠点 | この設計で取り入れること・取り入れないこと |
| --- | --- | --- | --- |
| Cloudflare Workers（本家） | 共有のプロセスの中の V8 isolate。seccomp・名前空間、cordon、Spectre の対策（[Security model](https://developers.cloudflare.com/workers/reference/security-model/)） | 348 都市（[Global Network](https://www.cloudflare.com/network/)） | 隔離の方式を取り入れる。拠点の数は S3 まで追わない |
| Deno Deploy | V8 isolate。2025 年に拠点を 35 から 6 に減らした。多くのアプリが 1 つのリージョンの DB を使い、全拠点での実行が生きなかったため（[Reports of Deno's Demise…](https://deno.com/blog/greatly-exaggerated)、2025-05-20） | 6 リージョン | 拠点を増やす前に、データの近さを考える。S1 を少ないリージョンで始める根拠の 1 つ |
| Vercel Functions（Fluid compute） | 従来は関数ごとの microVM。Fluid compute では 1 つのインスタンスで複数の呼び出しを並行に処理する（[Fluid compute](https://vercel.com/docs/fluid-compute)） | リージョン（既定は 1 つ、Pro で最大 3） | Node.js の完全な互換を取る方式。この設計は isolate の密度を優先して取らない |
| Fastly Compute | Wasm を Wasmtime で動かし、既定では要求ごとに新しいサンドボックス（[Getting started with Compute](https://www.fastly.com/documentation/guides/compute/getting-started-with-compute/)） | Fastly の PoP | 要求ごとの使い捨ては隔離が強いが、JavaScript をそのまま動かせない。[ADR-0001](../decisions/0001-runtime-build-vs-reuse.md) の選択肢として比べた |
| Lambda@Edge・CloudFront Functions | CloudFront Functions は ES 5.1 の JavaScript、2MB・10KB のコード、ネットワークなし。Lambda@Edge は Node.js と Python、リージョンのキャッシュで動く（[Choosing between…](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-choosing.html)） | CloudFront の 750 以上の PoP（[CloudFront features](https://aws.amazon.com/cloudfront/features/)） | 利用者のコードを CloudFront の PoP で動かす手段としては制約が大きい。[ADR-0003](../decisions/0003-edge-locations.md) で比べた |

すべて 2026-09-27 に確認した。

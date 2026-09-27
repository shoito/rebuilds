# Intent: Cloudflare Workers を AI エージェント主体で再構築する

- Author: shoito
- Status: accepted
- Date: 2026-09-27

## Problem

Web のアプリの処理を利用者の近くで動かすと、応答が速くなる。しかし、それを自前で作るのは重い。

- 世界の複数の拠点にサーバーを置き、DNS や anycast で利用者を近い拠点へ導き、TLS の証明書を配り、障害の拠点を外す仕組みが要る。
- 従来のサーバーレス（コンテナや VM を関数ごとに起動する方式）は、起動に数百ミリ秒から数秒かかる。本家は Lambda の起動を 500ms〜10 秒、isolate の起動を約 5ms と比べている（[Cloud Computing without Containers](https://blog.cloudflare.com/cloud-computing-without-containers/)、2018-11-09、2026-09-27 に確認）。
- 拠点の近くで状態（設定、セッション、ファイル、カウンター）を持つには、一貫性と遅延の釣り合いを製品ごとに設計する必要がある。
- 多数のテナントの、信頼できないコードを同じ機械で動かすので、隔離（Spectre のようなサイドチャネルを含む）を作り込む必要がある。

本家 Cloudflare Workers は、これを「V8 の isolate で、数ミリ秒で起動する関数」「標準の Web API」「グローバルに配るデプロイ」「エッジのストレージ（KV、R2、Durable Objects、Queues）」として提供している。その中身を、小さなチームと AI エージェントでどこまで作り直せるかを確かめる。

## Proposed outcome

Web の開発者が、CLI から 1 回のコマンドで関数をデプロイし、利用者の近くで動かせる基盤を作り直す。次の 3 つの価値を満たす。

1. **速い**：isolate の起動は 5ms 未満で、利用者に近い拠点で応答する。日本の利用者には、東京・大阪から応答する。
2. **標準のまま書ける**：`fetch`・`Request`・`Response`・Streams・Web Crypto など、WinterTC の最小の共通 API（ECMA-429）に沿う。WebSocket は ECMA-429 に含まれないので、追加の API として持つ。手元でも本番と同じランタイムで動かせる。
3. **安全で止まらない**：信頼できないコードを、多層の防御で隔離する。制御プレーンが止まっても、デプロイ済みの関数は動き続ける。

### MVP（S1）に含める

- **関数の実行**：JavaScript・TypeScript（ES モジュール）と WebAssembly。HTTP の要求で起動する。isolate で動かし、利用者に近いリージョンで応答する（[ADR-0001](decisions/0001-runtime-build-vs-reuse.md)、[ADR-0002](decisions/0002-isolation-model.md)）
- **標準の Web API**：`fetch`、`Request`・`Response`・`Headers`、Streams、Web Crypto、`URL`・`URLPattern`、`TextEncoder`・`TextDecoder`、`setTimeout`、`structuredClone`。互換の日付と互換のフラグで、振る舞いを固定する（[ADR-0008](decisions/0008-bundle-format-and-compatibility-dates.md)）
  - **ECMA-429 の外の追加の API**：WebSocket（サーバーとクライアント）、`request.<brand>` の属性（[ADR-0016](decisions/0016-request-brand-metadata.md)）
  - **ECMA-429 からの逸脱**（セキュリティのため。[ADR-0014](decisions/0014-wintertc-conformance-and-wpt.md)）：実行中に進まない時計、`WebAssembly.compile`・`compileStreaming`・`instantiateStreaming`・バッファからの `instantiate` の禁止
  - **Node.js の互換**：上流の workerd の組み込みの範囲に従う。`node:net`・`node:tls` の接続と `node:dns` の問い合わせは、MVP では理由の分かるエラーにする（[ADR-0015](decisions/0015-nodejs-compat-scope.md)）
- **CLI とローカル開発**：`<brand> init`・`<brand> dev`・`<brand> deploy`・`<brand> tail`。ローカル開発は、本番と同じランタイム（workerd を元にしたもの）で動かし、ストレージは手元の模擬で動かす
- **ルートとカスタムドメイン**：既定のサブドメイン `<worker>.<account>.<brand>.<domain>`、利用者のドメインのルート（`example.jp/api/*`）、カスタムドメインの TLS の証明書の自動の発行と更新
  - この基盤は DNS の製品（利用者のゾーン）を持たない。ルートに当たらない要求は、ホスト名に設定したオリジンへ転送する（[ADR-0019](decisions/0019-route-matching-and-home-node-forwarding.md)）。つまり、利用者のサーバーの前に立つリバースプロキシになる（キャッシュは持たない）。**PM の確認事項**：この振る舞いを MVP の約束にするか（下の「選定・計測で決めるもの」）
- **KV**：結果整合のキー・値の保存。読み込みの多い用途（設定、フラグ、静的なデータ）向け
- **オブジェクトストレージ**：S3 互換の API とバインディング。ホームのリージョンで、書き込みの直後の読み込みが強く整合する
- **Durable Objects に相当するもの**：名前ごとに 1 つだけの実体（アクター）と、トランザクションのある強い整合の保存。WebSocket の保持、アラーム
- **キューと cron**：少なくとも 1 回の配信のキュー（再試行とデッドレターのキュー）と、cron の式による定期の起動
- **ログ・tail・メトリクス**：`console.log` のリアルタイムの表示（tail）、ログの保存と検索、要求数・エラー・CPU 時間・遅延のメトリクス
- **シークレットと環境のバインディング**：暗号化したシークレット、環境変数、ストレージ・キュー・他の関数へのバインディング
- **段階的なデプロイとロールバック**：版を残し、2 つの版の間で割合を決めて流し、1 回の操作で前の版に戻す
- **制限と課金**：要求の数と CPU の時間（ミリ秒）で数える従量の課金、無料の枠、CPU・メモリ・サブリクエストの制限。料金は円で示す
- **ダッシュボードと管理 API**：アカウント、関数、ルート、ドメイン、ストレージ、ログ、使用量の画面と API

### MVP の後の Epic で扱う

| 機能 | 理由 |
| --- | --- |
| SQL のデータベース（D1 に相当） | Durable Objects の SQLite の保存の上に作れる。MVP の保存の仕組みが固まってから |
| AI の推論（Workers AI に相当） | GPU のフリートと、モデルの配布・課金が別に要る |
| コンテナ（Containers に相当） | 隔離の境界が microVM になる別の基盤。GitHub の題材の Firecracker の設計（[github の ADR-0023](../../github/docs/decisions/0023-firecracker-microvm-runners.md)）を参考にする |
| ワークフロー（Workflows に相当、長時間の耐久の実行） | Durable Objects とキューの上に作れる |
| 自前の PoP の世界的なネットワーク（BGP anycast） | S3 の段階。S1・S2 は AWS のリージョンで動かす（[ADR-0003](decisions/0003-edge-locations.md)） |
| Cache API、CDN としてのキャッシュ、WAF | 本家は CDN が先にあり、Workers はその上にある。この題材は関数とストレージを先にし、キャッシュはオブジェクトストレージの公開の配信の範囲に限る |
| 静的なアセットの配信（Pages に相当）、画像の変換 | 関数とオブジェクトストレージで代替できる。需要を見て扱う |
| TCP のソケット（`connect()`）、メールの受信、ブラウザの実行、ベクトルの索引、分析のエンジン | 個別の製品。MVP の後に需要を見て扱う |
| Smart Placement（関数を依存先の近くで動かす自動の配置） | S1 はリージョンが少なく、効果が小さい。S2 でリージョンが増えてから |
| 自前でホストする版の配布（workerd の上に載せるもの） | 上流の workerd がすでに担う |

### 守るべき振る舞い

- あるテナントのコードは、他のテナントのコード・データ・シークレット・メモリに届かない。
- 利用者のコードは、ファイルシステム・ホストのネットワーク・ほかのプロセスに直接届かない。外への通信は、すべてエッジの外向きのプロキシを通る。
- 実行中のコードから、高い精度の時計と共有メモリのスレッドは使えない（Spectre の対策。ADR-0002）。
- 制限（CPU の時間、メモリ、サブリクエストの数）を超えた要求は止められ、同じプロセスの他のテナントに影響しない。
- デプロイを受け付けたら、その版は定められた時間の中で全ノードに届く。届かないノードは、その版を名乗らない（古い版で応答したことを記録する）。
- 互換の日付を固定した関数は、その日付の振る舞いを受け続ける。
- KV に書いた値は、定められた時間の中で全リージョンから読める。オブジェクトストレージは、成功を返した書き込みを、直後の読み込みで必ず返す。Durable Objects は、1 つの名前に同時に 2 つの実体を持たず、確定していない書き込みの結果を外に出さない。
- 制御プレーンが止まっても、デプロイ済みの関数とストレージの読み書きは動き続ける。

### 成功の基準

| # | 基準 | 目標 | 測り方 |
| --- | --- | --- | --- |
| K1 | データプレーンの可用性 | 月間 99.99%（NFR-004） | 各リージョンの外からの合成監視と、プラットフォームが原因の 5xx の割合 |
| K2 | 起動の速さ | isolate の起動 p99 5ms 未満（NFR-001） | ノードの計測（コードがノードにある場合と、ない場合を分けて出す） |
| K3 | 日本での速さ | 国内の主要な ISP からの最小の関数（固定の応答を返すもの）の TTFB p50 30ms 以内 | 国内の複数の ISP からの合成監視 |
| K4 | 最初のデプロイまでの時間 | CLI の導入から、最初の関数が公開の URL で応答するまで、中央値 5 分以内 | オンボーディングのイベントの計測と、利用者の試験 |
| K5 | デプロイの伝搬 | 全ノードへの反映 p99 30 秒以内（NFR-008） | ノードが報告する適用済みの版と、受付の時刻の差 |
| K6 | 隔離 | テナントをまたぐ到達とサンドボックスの脱出の事象 0 件。V8 の Critical・High の修正の 24 時間以内の配信の遵守率 100%（NFR-006・NFR-007） | 脱出のテスト、外部の侵入試験、脆弱性の報奨の窓口、修正の配信の記録 |
| K7 | 標準への適合 | WinterTC の最小の共通 API（ECMA-429）の対象の Web Platform Tests の通過率が、同じ版の上流の workerd を下回らない | CI で WPT の該当の部分を回す |
| K8 | 採算 | S2 の稼働率で、最小の関数の 100 万要求あたりの基盤の費用が、その料金の 50% 以下 | 費用の配賦と、使用量の集計（limits-and-billing の領域で式を決める） |

## Affected users and systems

- **Web の開発者**（主な利用者）：日本の Web のサービス・スタートアップ・個人の開発者。API の中継、認証の前処理、A/B テスト、軽い API、リアルタイムの機能（チャット、共同編集）を作る人。日本の市場を先にし、ドキュメントと画面は日本語と英語にする。
- **アカウントの管理者**：ダッシュボードで、請求、メンバー、ドメイン、使用量を見る人。
- **関数の利用者（エンドユーザー）**：開発者のサービスを、ブラウザやアプリから使う人。関数が動いていることを意識しない。
- **外部のシステム**：AWS（実行の基盤）、利用者のドメインの DNS、証明書の発行局（ACME）、決済の事業者、開発者の元のサーバー（オリジン）。
- **社内の運用**：エッジのフリートの運用、セキュリティの監視、不正利用の対応、サポート。

## Constraints

- **ランタイムは workerd を元にする。** 本家が公開したランタイム（Apache-2.0）を使い、多数のテナントのための隔離と運用の層を自分たちで作る（[ADR-0001](decisions/0001-runtime-build-vs-reuse.md)）。workerd は単体では信頼できないコードのための十分なサンドボックスではない、と上流が明記している（[workerd の README](https://github.com/cloudflare/workerd)、2026-09-27 に確認）。
- **S1・S2 は AWS のリージョンで動かす。** 自前の PoP は S3 の段階にする。計算の拠点の数は本家より大幅に少ない（[ADR-0003](decisions/0003-edge-locations.md)）。
- 制御プレーンの技術は、rebuilds の他の題材の決定（AWS、TypeScript・Hono、Aurora PostgreSQL 18、Terraform、OpenTelemetry）を引き継ぐ（[ADR-0001](decisions/0001-runtime-build-vs-reuse.md)）。
- 本家の名前は識別子に使わない。既定のドメインは `*.<brand>.<domain>`、ヘッダーは `<Brand>-*`、CLI は `<brand>`、ランタイムの名前空間は `request.<brand>` の形で書く（[リポジトリ共通の ADR-0006](../../../docs/decisions/0006-brand-neutral-identifiers.md)）。本家の CLI・設定ファイルとの互換は目標にしない。ランタイムの Web API で互換にする。
- 日本の法令（電気通信事業法、個人情報保護法、プロバイダの責任に関する法律など）への対応は、法務の確認を前提に設計する（下の「法務の確認待ち」）。
- 規模は段階的に広げる（[architecture/](architecture/README.md) の「規模の段階」）。

## Non-goals

| 機能 | 理由 |
| --- | --- |
| 本家の CLI（wrangler に相当）・設定ファイルとの完全な互換 | リポジトリ共通の ADR-0006。Web API と、主要な設定の概念（互換の日付、バインディング）で寄せる |
| Node.js の全 API の互換 | 本家も一部を実装し、残りは空の実装で補う（[Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)、2026-09-27 に確認）。上流の workerd が持つ範囲に従う |
| ネイティブのコード（共有ライブラリ、任意のバイナリ）の実行 | 隔離の前提が崩れる（ADR-0002）。必要な用途は、MVP の後のコンテナで扱う |
| 利用者が選ぶリージョンへの関数の固定（MVP） | S1 はリージョンが少なく、近いリージョンで動かす。データの所在の要求は、ストレージのリージョンの指定で応える（ADR-0005） |
| 中国本土での提供 | 別の法令と事業者の提携が要る |
| FedRAMP などの海外の認定 | 日本の市場を先にする |

## Open questions

### 法務の確認待ち

設計はどの結論にも対応できる形にするが、結論は出さない。**下の表の「承認を止める spec」は、確認が済むまで PM・QA が承認しない。**

| # | 問い | 関係する設計 | 承認を止める spec |
| --- | --- | --- | --- |
| L1 | 不正な内容のホスティング：既定のサブドメイン（`*.<brand>.<domain>`）とオブジェクトストレージの公開の配信で、フィッシング・マルウェア・著作権の侵害の内容が置かれたときの、削除の義務と手順、発信者の情報の開示の請求への対応。プロバイダの責任を定める法律（2025 年の改正後の名称と義務の範囲は未検証）の上の位置づけ | [abuse-and-trust-safety.md](architecture/abuse-and-trust-safety.md)、[ADR-0043](decisions/0043-hosted-content-abuse-and-takedown.md) | E4 の既定のサブドメインの公開、E8 の公開のバケット |
| L2 | 電気通信事業法：関数のサブリクエストの中継、WebSocket の中継、キューが「他人の通信の媒介」に当たり、届出・登録が要るか。通信の秘密（不正利用の調査、tail・ログでの要求の本文の扱い） | [edge-network-and-routing.md](architecture/edge-network-and-routing.md)、[developer-tooling.md](architecture/developer-tooling.md)、[abuse-and-trust-safety.md](architecture/abuse-and-trust-safety.md)、[security.md](architecture/security.md) の 9 節 | E4 の公開の開始、E6 の tail とログの保存 |
| L3 | データの所在：関数は近いリージョンで動くので、日本の利用者の要求が、障害の迂回で海外のリージョンで処理されうる。個人情報保護法の外国にある第三者への提供（いわゆるクラウドの例外に当たるか）、日本だけで処理する約束をどこまで持つか（ストレージのリージョンの固定、関数の実行のリージョンの制限） | [ADR-0003](decisions/0003-edge-locations.md)、[ADR-0005](decisions/0005-storage-consistency.md)、[ADR-0051](decisions/0051-disaster-recovery-and-honest-rpo.md)、[infrastructure.md](architecture/infrastructure.md) | E4 のリージョンの間の迂回、E9 の Durable Objects の配置、E12 の契約の文書 |
| L4 | 利用規約と許容される利用の方針（AUP）：暗号資産の採掘、大量の送信、スクレイピングの中継、プロキシとしての悪用の禁止と、停止の手順。捜査機関からの照会への対応 | [abuse-and-trust-safety.md](architecture/abuse-and-trust-safety.md)、[ADR-0044](decisions/0044-egress-abuse-controls.md) | E12 の GA の判定 |
| L5 | 課金：前払いのクレジットを売るときの資金決済法の前払式支払手段への該当、海外の利用者への消費税（国外の事業者との取引）の扱い | [limits-and-billing.md](architecture/limits-and-billing.md)、[ADR-0040](decisions/0040-jpy-pricing-invoices-and-spend-controls.md) | E11 の課金 |
| L6 | オープンソースのライセンス：workerd（Apache-2.0）、V8（BSD 系）、ICU などを、CLI に同梱して配るときと、サービスとして動かすときの表示の義務（NOTICE の扱い）。自分たちの差分を公開するか | [developer-tooling.md](architecture/developer-tooling.md)、[runtime-and-isolates.md](architecture/runtime-and-isolates.md) | E6 の CLI の配布 |
| L7 | データの取り扱いの契約：委託の契約（DPA）の雛形、サブプロセッサー（AWS など）の一覧と変更の通知、ログの保持の期間 | [security.md](architecture/security.md)、[observability.md](architecture/observability.md) | E12 の GA の判定 |

### 選定・計測で決めるもの（法務以外）

2026-09-27 の統合の工程で、次のとおり既定案を決めた（[architecture/README.md](architecture/README.md) の 6 節の「決定」）。

- workerd の公開版の機能：テナントの動的な読み込みは上流の `workerLoader` を元にできる。テナントごとの CPU・メモリの制限の強制は上流になく、自前のパッチが要る（[ADR-0001](decisions/0001-runtime-build-vs-reuse.md)、[ADR-0009](decisions/0009-cpu-and-memory-metering.md)）。空の isolate の予備を作れるかと、V8 のサンドボックスが既定で有効かは、E2・E3 の PoC で確かめる。
- S1 の海外のリージョン：シンガポール・オレゴン・フランクフルトを第一の候補にして見積もった。E1 の着手前に、想定の利用者の分布で PM が決める（[infrastructure.md](architecture/infrastructure.md) の 15 節）。
- エッジの入口の HTTP のプロキシ：Pingora の上に、入口と外向きを別のプロセスで作る（[ADR-0020](decisions/0020-pingora-ingress-and-egress-proxies.md)）。
- KV の中央の保存先は東京の DynamoDB（[ADR-0024](decisions/0024-kv-central-store-dynamodb.md)）。Durable Objects の複製は、別の 2 つの AZ のログのノードで 3 台のうち 2 台で確定する（[ADR-0031](decisions/0031-do-sqlite-replication-and-pitr.md)）。
- 料金の値（円）と無料の枠：本家の構造（月額の基本料と、要求数・CPU 時間の従量）に寄せ、各行を原価の 1.3 倍以上にする（[ADR-0040](decisions/0040-jpy-pricing-invoices-and-spend-controls.md)）。本家の料金は、月額 5 ドルに 1,000 万要求と 3,000 万 CPU ミリ秒を含み、超過は 100 万要求あたり 0.30 ドル、100 万 CPU ミリ秒あたり 0.02 ドル（[Pricing](https://developers.cloudflare.com/workers/platform/pricing/)、2026-09-27 に確認）。

**PM の確認事項**（既定案で進めるが、PM の確認で変えうる）：

| # | 問い | 既定案 | 関係する設計 |
| --- | --- | --- | --- |
| P1 | 利用者のオリジンへの転送（ルートに当たらない要求をホスト名のオリジンへ送る）を MVP に含めるか。含めると、この基盤は利用者のサーバーの前に立つリバースプロキシになる（キャッシュ・WAF は持たない） | 含める。キャッシュは持たず、外向きのプロキシと同じ宛先の検査を通す | [ADR-0019](decisions/0019-route-matching-and-home-node-forwarding.md)、[edge-network-and-routing.md](architecture/edge-network-and-routing.md) の 8.3 節 |
| P2 | NFR-010：リージョンの全体の障害の RPO を「1 分」でなく、製品ごとの実際の値で約束する | 製品ごとの表で約束する | [ADR-0051](decisions/0051-disaster-recovery-and-honest-rpo.md)、[architecture/README.md](architecture/README.md) の 3 節 |
| P3 | CPU 時間の単価を、原価（設計点の利用率 50%）の 1.3 倍以上にする。本家の値（100 万 ms 0.02 ドル ≒ 3 円）より高くなる | 100 万 ms あたり 7 円。月額 800 円は変えない | [limits-and-billing.md](architecture/limits-and-billing.md) の 6.3 節 |
| P4 | KV の書き込みとオブジェクトの操作・保存の単価が、本家より高い（原価が本家の料金を上回る） | 原価の 1.3 倍以上（KV の書き込み 100 万 1,120 円） | 同上 |
| P5 | 海外の 3 リージョンの最終の選択 | シンガポール・オレゴン・フランクフルト | [infrastructure.md](architecture/infrastructure.md) の 2 節 |

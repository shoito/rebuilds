# Architecture: Cloudflare Workers

全体像と横断的な方針。領域ごとの設計は、同じディレクトリの各ファイルに置く（7 節）。品質の戦略は [quality.md](../quality.md)、Epic と Story は [roadmap.md](../roadmap.md)、SLO・アラート・リリースは [runbooks/](../runbooks/README.md)、データの置き場所の索引は [data-model.md](data-model.md) にある。

## 1. 全体構成

```
利用者のブラウザ・アプリ
   │ DNS：<worker>.<account>.<brand>.<domain>、または利用者のドメイン（CNAME・A）
   ▼
Global Accelerator の anycast の IP（AWS の edge で TCP を受ける。本番と予備の 2 つ）
   │ AWS のバックボーン
   ▼
┌──────── エッジのリージョン（S1：東京・大阪＋海外 3）───────────────────┐
│ edge-<r> のアカウント                                                  │
│ NLB ──▶ エッジのノード（EC2 c7i）                                        │
│   ├─ 入口のプロキシ：TLS の終端、ルートの解決、ホームのノードへの転送      │
│   ├─ スーパーバイザー：ランタイムのプロセスを cordon ごとに起動・監視       │
│   ├─ ランタイム（workerd を元にしたもの）                                │
│   │    プロセスは cordon（信頼の段階）ごと。1 プロセスに多数の isolate    │
│   │    seccomp・名前空間のサンドボックスの中。LMDB もファイルも開かない   │
│   ├─ 外向きのプロキシ：サブリクエスト、バインディングの呼び出し           │
│   │    ノードの公開の IPv4 で外へ出る（NAT を通さない）                   │
│   └─ 設定の写し（LMDB。受け手だけが書く）とコードのキャッシュ（gp3）      │
│ DO のホスト（m7i）、中継、専用のリゾルバー                               │
│ storage-<r> のアカウント：KV のゲートウェイと L2（Valkey）、               │
│   DO のルーター・配置・ログのノード（i4i）、DynamoDB、S3                   │
└─────────────────────────────────────────────────────────────────┘
   ▲ 設定とコードの配信（ADR-0004・0022）   │ 使用量・利用者のログ・ノードの状態
┌──────── 制御プレーン（cp-prod、東京。DR は大阪）──────────────────────┐
│ 管理 API（Hono）・ダッシュボード・CLI の窓口（<console-domain>）         │
│ デプロイ（版、段階的な割合）、ルートとドメイン、証明書（ACME）            │
│ 設定の正本（Aurora）──▶ outbox ──▶ 採番器 ──▶ 配信の元 ──▶ リージョンの中継 │
│ 課金と使用量の集計、tail のハブ、利用者のログ（ClickHouse）、不正利用の対応 │
│ バケットの設定・KV の名前空間などストレージの「定義」（Aurora）            │
└─────────────────────────────────────────────────────────────────┘
┌──────── ストレージの中央（storage-apne1、東京）────────────────────────┐
│ KV の正本（DynamoDB ＋ 大きな値は S3）、オブジェクトの共有のバケット       │
│ （本体とオブジェクトのメタデータは S3）、DO の名前の台帳、キュー（SQS）、   │
│ ディスパッチャー、cron のスケジューラー                                  │
└─────────────────────────────────────────────────────────────────┘
```

| コンポーネント | 責務 |
| --- | --- |
| 入口のプロキシ | TLS の終端（既定のドメインとカスタムドメイン）、HTTP の解析、ホスト名とパスからルートを解決し、関数と版を決める。段階的なデプロイの割合で版を選ぶ。リージョンの中のホームのノードへ 1 回だけ転送する（[ADR-0019](../decisions/0019-route-matching-and-home-node-forwarding.md)、[ADR-0020](../decisions/0020-pingora-ingress-and-egress-proxies.md)） |
| ランタイム | workerd を元にしたもの。isolate の作成・再利用・退避、CPU とメモリの制限の強制（自前のパッチ）、互換の日付、Web API（[ADR-0001](../decisions/0001-runtime-build-vs-reuse.md)） |
| スーパーバイザー | ノードの上で、ランタイムのプロセスを cordon ごとに起動・監視・入れ替える。テナントをどのプロセスに載せるかを決める。設定とシークレットをランタイムへ渡す（[ADR-0002](../decisions/0002-isolation-model.md)、[ADR-0011](../decisions/0011-cordon-tiers-and-placement.md)） |
| 外向きのプロキシ | 利用者のコードからのすべての通信（`fetch`、WebSocket、バインディング）を受け、宛先の制限、サブリクエストの数の制限、内部のアドレスの遮断を行う（[ADR-0010](../decisions/0010-process-sandbox-and-egress-invariants.md)、[ADR-0044](../decisions/0044-egress-abuse-controls.md)） |
| 設定の写し | 制御プレーンの変更を順序付きで受け、ノードの LMDB に書く。リクエストの処理は、この写しだけを読む。ランタイムは開かない（[ADR-0004](../decisions/0004-config-and-code-distribution.md)、[ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md)） |
| ストレージ | KV、オブジェクトストレージ、Durable Objects、キュー。一貫性の約束は製品ごとに違う（[ADR-0005](../decisions/0005-storage-consistency.md)） |
| 制御プレーン | 管理 API、デプロイ、証明書、課金、使用量、利用者のログ、不正利用の対応。他の題材と同じ技術で作る |

- **ストレージの置き場所**：オブジェクトの本体とメタデータは S3 の共有のバケットにあり、Aurora にはバケットの設定だけを置く（[ADR-0026](../decisions/0026-object-storage-s3-gateway-with-scoped-prefixes.md)）。KV の正本は東京の DynamoDB（[ADR-0024](../decisions/0024-kv-central-store-dynamodb.md)）。全ての保存の一覧は [data-model.md](data-model.md)。

原則は 3 つ。

- **利用者のコードは、多層で閉じ込める。** isolate は 1 層目にすぎない。プロセスのサンドボックス、信頼の段階ごとのプロセスの分離（cordon）、Spectre の対策、V8 の修正の 24 時間以内の配信を重ねる（[ADR-0002](../decisions/0002-isolation-model.md)）。
- **データプレーンは、制御プレーンなしで動く。** エッジのノードは、手元の設定の写しとコードのキャッシュで処理する。制御プレーンが止まると新しいデプロイは止まるが、デプロイ済みの関数は動き続ける（[ADR-0004](../decisions/0004-config-and-code-distribution.md)）。
- **一貫性の約束は、製品ごとに明示する。** KV は速さのために結果整合、オブジェクトストレージは強い整合、Durable Objects は 1 つの実体で直列に処理する。利用者が用途に合わせて選ぶ（[ADR-0005](../decisions/0005-storage-consistency.md)）。

### 名前とドメイン

本家の名前は識別子に使わない（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。実際の名前は開発リポジトリの作成時に決める。

| 置き換え用の名前 | 使う所 | 例 |
| --- | --- | --- |
| `<brand>.<domain>` | 関数の既定のドメイン（Public Suffix List に載せる。[ADR-0018](../decisions/0018-acme-certificates-and-sni.md)） | `<worker>.<account>.<brand>.<domain>`、`edge.<brand>.<domain>`（GA の A・AAAA）、`<hostname-id>.cname.<brand>.<domain>`（カスタムドメインの向き先）、`<account_id>.storage.<brand>.<domain>`（S3 互換の API の口） |
| `<brand>usercontent.<domain>` | オブジェクトストレージの開発用の URL（別の登録可能なドメイン。PSL に載せる。[ADR-0027](../decisions/0027-object-public-access-and-presigned-urls.md)） | `pub-<32 桁の 16 進>.<brand>usercontent.<domain>` |
| `<console-domain>` | 管理 API・ダッシュボード・tail・文書・通報の窓口。関数の既定のドメインと**別の登録可能なドメイン**にする（既定のドメインが遮断の一覧に載っても、管理の画面を止めない。[dashboard-and-api.md](dashboard-and-api.md) の 3 節） | `api.<console-domain>/v1`、`dash.<console-domain>`、`wss://tail.<console-domain>`、`schema.<console-domain>`、`docs.<console-domain>`、`abuse.<console-domain>` |
| `<Brand>-*` | HTTP のヘッダー | `<Brand>-Ray`、`<Brand>-Worker`、`<Brand>-Connecting-IP`、`<Brand>-IPCountry`、`<Brand>-Version-Key`、`<Brand>-Version-Overrides`、`<Brand>-Loop`、`<Brand>-Internal-*`（内部だけ） |
| `<brand>` | CLI、設定ファイル、npm、ランタイムの名前空間、トークンの接頭辞、環境変数 | `<brand> deploy`、`<brand>.jsonc`、`@<brand>/workerd-<os>-<arch>`、`request.<brand>`、`<brand>:workers`、`<brand>_(ut\|at\|oa\|or)_…`、`<BRAND>_API_TOKEN` |

### 用語

| 用語 | 意味 |
| --- | --- |
| cordon | 信頼の段階ごとのランタイムのプロセスの群（`c0-untrusted`・`c1-free`・`c2-paid`・`c3-dedicated`・`cq-quarantine`・`ci-internal`。[ADR-0011](../decisions/0011-cordon-tiers-and-placement.md)） |
| 器（keyspace） | 設定の写しの中のキーの空間。利用者の器と基盤の器がある（[ADR-0056](../decisions/0056-platform-config-staging-and-flags.md)、[data-model.md](data-model.md) の 8 節） |
| ホームのノード | リージョンの中で、ある関数の版を温かく持つノード（ランデブーハッシュで決める） |
| 静的な安定 | 制御プレーンや配信が止まっても、ノードが最後の設定で処理を続けること |
| 波（W0〜W6） | ランタイムの段階的な配信の段（[ADR-0055](../decisions/0055-staged-runtime-rollout-by-cordon-and-region.md)） |
| 隔離の層 L1〜L5 | isolate、プロセスのサンドボックス、cordon、外向きのプロキシ、ホストとアカウント（ADR-0002）。法務の問い L1〜L7（[intent.md](../intent.md)）、KV のキャッシュの L1・L2、負荷試験の T1〜T10（[capacity.md](capacity.md)）とは別 |

## 2. 規模の段階

| 段階 | 要求（ピーク） | アカウント・関数 | 計算の拠点 | 構成 |
| --- | --- | --- | --- | --- |
| S1（MVP） | 5 万 件/秒 | 1 万アカウント、5 万関数 | AWS の 5 リージョン（東京・大阪＋海外 3。シンガポール・オレゴン・フランクフルトを第一の候補にする） | Global Accelerator の anycast の IP → 各リージョンの NLB → エッジのノード。制御プレーンは東京（DR は大阪）。KV の正本とオブジェクトストレージの既定のホームは東京 |
| S2 | 50 万 件/秒 | 10 万アカウント、50 万関数 | AWS の 12〜15 リージョン（Local Zones の利用は未検証） | 自前の IP の範囲（BYOIP）を Global Accelerator で広告する。KV のリージョンの読み込みの複製、Smart Placement に相当する配置、オブジェクトストレージのホームのリージョンを選べるようにする |
| S3 | 500 万 件/秒 | 100 万アカウント、500 万関数 | 自前の PoP（国内の主要都市と海外の 50 都市以上）＋ AWS のリージョン | 自前の AS 番号と BGP anycast。拠点の中は L4 の負荷分散で機械に振り分ける。AWS のリージョンは、ストレージの中央と制御プレーン、PoP のない地域の受け皿に使う。設定の配信は Quicksilver v1.5・v2 に近い形（全データを持つレプリカと、使うものだけを持つノード）へ移る |

本家の網は 100 か国以上の 348 都市にあり、インターネットの利用者の 95% が 50ms 以内にいるとしている（[Cloudflare Global Network](https://www.cloudflare.com/network/)、2026-09-27 に確認）。S1・S2 はこれに遠く及ばない。日本の利用者を先にし、東京・大阪の 2 リージョンで国内を賄う（[ADR-0003](../decisions/0003-edge-locations.md)）。台数と費用は [capacity.md](capacity.md) と [infrastructure.md](infrastructure.md) の 10 節（S1 の本番で月に約 23 万ドルの見積もり）。

## 3. 非機能要件

| ID | 項目 | S1 の目標 | 備考 |
| --- | --- | --- | --- |
| NFR-001 | 起動（コールドスタート） | **(a)** isolate の作成とモジュールの読み込み p99 5ms 未満。条件は、コードがノードのキャッシュにあり、バンドルが圧縮前 1MiB 以下で、利用者のトップレベルのコードの実行を除く。**(b)** コードがノードにないときは、リージョンの中継から取得して p99 50ms 以内（同じ 1MiB）。**(c)** 1MiB を超えるバンドルは、5ms を約束しない。読み込みの時間は大きさに比例し、トップレベルの実行（上限 1 秒）が加わる。バンドルの大きさの帯（1MiB 以下、1〜10MiB、10MiB 超）ごとに冷たい起動の p99 を計測して公開する | 本家は isolate の起動を約 5ms とする（[Cloud Computing without Containers](https://blog.cloudflare.com/cloud-computing-without-containers/)）。一方で本家は、圧縮前 64MiB のバンドルと 1 秒の起動を許す（[Limits](https://developers.cloudflare.com/workers/platform/limits/)）。どちらも 2026-09-27 に確認。この基盤の上限は圧縮前 有料 64MiB・無料 32MiB、起動 1 秒（[ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md)）。大きなバンドルの冷たい起動を減らすのは、温めと V8 のコードのキャッシュ（[ADR-0007](../decisions/0007-isolate-lifecycle-and-dynamic-loading.md)） |
| NFR-002 | プラットフォームが足す遅延 | ノードに要求が届いてから関数に渡すまでと、応答を返すまでの合計 p50 2ms 以内、p99 10ms 以内（TLS の握手、利用者の CPU 時間、サブリクエストの待ちを除く） | 入口のプロキシとランタイムで分けて計測する。ホームのノードへの転送（リージョンの中の 1 往復）を含む |
| NFR-003 | 利用者からの近さ | 国内の主要な ISP から最寄りのリージョンまでの RTT p50 15ms 以内。海外は、S1 の 5 リージョンからの距離に応じた値を計測して公開する | 海外の遅延は本家より大きい（[ADR-0003](../decisions/0003-edge-locations.md)、[edge-network-and-routing.md](edge-network-and-routing.md) の 11 節） |
| NFR-004 | 可用性 | データプレーン（関数の実行）月間 99.99%。制御プレーン（管理 API・デプロイ）月間 99.9%。ストレージの読み込み 99.99%、書き込み 99.9% | 1 リージョンの障害は、anycast の迂回で吸収する。SLI と窓は [runbooks/README.md](../runbooks/README.md) の 1 節 |
| NFR-005 | 制限の強制 | CPU の時間の上限を超えた isolate は、上限＋10ms 以内に止める。メモリの上限（128MiB）を超えた isolate は、同じプロセスの他の isolate を止めずに退避する。制限による停止が、同じプロセスの他のテナントの p99 の遅延を 1ms 以上悪化させない | 本家の上限は、CPU 時間が無料で 10ms、有料で既定 30 秒・最大 5 分、メモリが 128MB（[Limits](https://developers.cloudflare.com/workers/platform/limits/)、2026-09-27 に確認）。上流の workerd は制限を強制しないので、自前のパッチで作る（[ADR-0009](../decisions/0009-cpu-and-memory-metering.md)） |
| NFR-006 | テナントの隔離 | 他のテナントのコード・データ・シークレット・メモリに届く事象 0 件。サンドボックスの脱出 0 件。Spectre の対策（止めた時計、スレッドと `SharedArrayBuffer` の禁止、ネイティブのコードの禁止、怪しい振る舞いの isolate のプロセスの分離）を常に有効にする | [ADR-0002](../decisions/0002-isolation-model.md)、[ADR-0013](../decisions/0013-spectre-mitigations-and-dynamic-isolation.md) |
| NFR-007 | V8 のセキュリティの修正 | 上流の Critical・High の修正の公開から、全エッジのノードで修正済みの版が動くまで 24 時間以内 | 本家の目標と同じ（[Security model](https://developers.cloudflare.com/workers/reference/security-model/)、2026-09-27 に確認）。[ADR-0012](../decisions/0012-v8-24-hour-patch-pipeline.md) |
| NFR-008 | デプロイの伝搬 | デプロイの受付から全ノードへの反映まで p99 30 秒以内。ルート・シークレット・設定の変更は p99 10 秒以内。反映していないノードは、古い版で応答したことを記録する | [ADR-0004](../decisions/0004-config-and-code-distribution.md)、[ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md)。基盤の器は段階的に配るので、この値の対象外（[ADR-0056](../decisions/0056-platform-config-staging-and-flags.md)） |
| NFR-009 | ストレージの一貫性 | KV：書き込みから全リージョンで読めるまで、キャッシュの TTL が既定の 60 秒のとき p99 70 秒以内。オブジェクトストレージ：成功を返した書き込み・削除は、直後のすべての読み込み・一覧に反映する。Durable Objects：1 つの名前に同時に 1 つの実体。書き込みが確定する前に、その結果に依存する応答を外へ出さない | [ADR-0005](../decisions/0005-storage-consistency.md) |
| NFR-010 | 耐久性と復旧 | 成功を返した書き込み（KV、オブジェクト、Durable Objects、キューのメッセージ）を、1 つの AZ の障害では失わない（RPO 0、RTO 5 分以内）。1 つのリージョンの障害：関数の実行は anycast の迂回で RTO 5 分以内。**ストレージのホームのリージョン（東京）の全体の障害**：RTO 1 時間以内（手動の切り替え）、RPO は下の製品ごとの表のとおりで、「1 分」を約束しない | **PM・Ops の確認事項**（[intent.md](../intent.md) の P2）。統合の工程（2026-09-27）で、元の「RPO 1 分」を [ADR-0051](../decisions/0051-disaster-recovery-and-honest-rpo.md) の率直な値に改めた |

**NFR-010 の製品ごとの RPO**（東京の全体の障害。[ADR-0051](../decisions/0051-disaster-recovery-and-honest-rpo.md)、[infrastructure.md](infrastructure.md) の 7.2 節。利用者向けの文書と SLA にこの表を書く）：

| 製品 | 大阪への複製 | RPO（S1 で示す値） | RTO の目標 |
| --- | --- | --- | --- |
| 関数のコード（バンドル）・設定の写し | 5 リージョンへ同期で置く・全ノードが持つ | 0 | 0〜5 分（関数は自動の迂回） |
| 制御プレーン（Aurora） | Global Database | 秒の単位（保証なし。`AuroraGlobalDBRPOLag` を示す） | 1 時間 |
| KV（4 KiB 以下の値） | DynamoDB のグローバルテーブル（MREC） | 秒の単位（保証なし） | 1 時間 |
| KV（4 KiB を超える値）・オブジェクトストレージ | S3 CRR（RTC） | 通常は秒。約束は 99.9% を 15 分以内。それを超える分は失いうる | 1 時間 |
| Durable Objects（東京のホーム） | WAL とスナップショットの CRR | 最大 10 秒＋CRR の遅れ（約束は 99.9% を 15 分以内） | 1 時間 |
| キュー | なし（東京の SQS だけ） | 東京の SQS が回復する限り 0。東京の SQS の永続の喪失では失う | 東京の回復まで |
| cron | `cron_fires` を大阪へ複製 | 2 重の起動がありうる | 1 時間 |
| 保存するログ | 再送用の S3 だけ | 取り込みの遅れの分（ログは約束しない） | 東京の回復まで |
| 使用量 | spool・Kinesis・生の束の CRR | 0（束は冪等に再送） | 1 時間 |

## 4. 技術スタック

| 層 | 選定 | 理由 |
| --- | --- | --- |
| ランタイム | workerd（C++、V8）を元にし、下流のリポジトリにパッチの列で持つ。上流を週 1 回取り込む | [ADR-0001](../decisions/0001-runtime-build-vs-reuse.md)、[ADR-0006](../decisions/0006-workerd-fork-and-upstream-tracking.md) |
| エッジのノードの自前の部品 | Rust（Pingora の上の入口・外向きのプロキシ、スーパーバイザー、設定の写しの受け手、中継、使用量の送り手、DO のルーター・配置・ログのノード、ゲートウェイ） | メモリの安全と、遅延の予測のしやすさ。[ADR-0001](../decisions/0001-runtime-build-vs-reuse.md)、[ADR-0020](../decisions/0020-pingora-ingress-and-egress-proxies.md) |
| エッジのノード | EC2 c7i.24xlarge（東京・大阪）・c7i.12xlarge（海外）、DO のホスト m7i.12xlarge、ログのノード i4i.2xlarge。x86-64、Amazon Linux 2023、seccomp、名前空間、cgroup v2。ディスクは gp3 | 性能カウンターと PKU（[ADR-0010](../decisions/0010-process-sandbox-and-egress-invariants.md)、[ADR-0050](../decisions/0050-runtime-fleet-instance-types.md)） |
| 入口 | AWS Global Accelerator（デュアルスタック、本番と予備）→ リージョンごとの TCP の NLB → EC2。S2 で BYOIP、S3 で自前の PoP と BGP anycast | [ADR-0003](../decisions/0003-edge-locations.md)、[ADR-0017](../decisions/0017-global-accelerator-and-regional-nlb.md) |
| 証明書 | ACME（Let's Encrypt が主、ZeroSSL が予備）、cert-manager | [ADR-0018](../decisions/0018-acme-certificates-and-sni.md) |
| 設定とコードの配信 | Aurora の outbox → 採番器 → 配信の元 → リージョンの中継 → ノードの LMDB。コードは内容のハッシュで 5 リージョンの S3 に置く | [ADR-0004](../decisions/0004-config-and-code-distribution.md)、[ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md)、[ADR-0023](../decisions/0023-code-and-secret-distribution.md) |
| 制御プレーン | TypeScript（Hono＋Zod、`@hono/zod-openapi`）、ECS Fargate、Aurora PostgreSQL 18、SQS | 他の題材と同じ。[ADR-0041](../decisions/0041-management-api-shape.md) |
| CLI | TypeScript（npm で配る）。ローカル開発は下流の workerd のバイナリを任意の依存で入れて動かす | [ADR-0035](../decisions/0035-cli-and-single-jsonc-config.md)、[ADR-0036](../decisions/0036-local-dev-on-downstream-workerd.md) |
| KV | 東京の DynamoDB（4 KiB を超える値は S3）、ノードの L1 とリージョンの L2（ElastiCache for Valkey） | [ADR-0024](../decisions/0024-kv-central-store-dynamodb.md)、[ADR-0025](../decisions/0025-kv-two-tier-cache-and-staleness.md) |
| オブジェクトストレージ | S3 の共有のバケット（本体とメタデータ）と自前の Rust のゲートウェイ（SigV4、接頭辞、STS のセッション） | [ADR-0026](../decisions/0026-object-storage-s3-gateway-with-scoped-prefixes.md) |
| Durable Objects | 手元の SQLite ＋ 自前の VFS、別の 2 つの AZ のログのノード、S3 の WAL（30 日の PITR）、DynamoDB の台帳とリース | [ADR-0029](../decisions/0029-do-placement-and-directory.md)〜[ADR-0032](../decisions/0032-do-alarms-hibernation-and-rpc.md) |
| キューと cron | 東京の SQS の標準のキューと自前のディスパッチャー、シャードごとのリースのスケジューラー | [ADR-0033](../decisions/0033-queues-on-sqs-with-own-dispatcher.md)、[ADR-0034](../decisions/0034-cron-sharded-scheduler.md) |
| 利用者のログ | Kinesis → 東京の ClickHouse（自前かマネージドかは E6 の PoC） | [ADR-0037](../decisions/0037-tail-sessions-and-tenant-logs.md) |
| 基盤の観測 | OpenTelemetry → AMP・Grafana・Alertmanager、X-Ray、Vector → S3・CloudWatch Logs。利用者のログと分ける | [ADR-0052](../decisions/0052-platform-telemetry-and-cardinality.md)、[observability.md](observability.md) の 3 節 |
| 鍵 | KMS の 3 層（制御プレーンのマルチリージョンの鍵、リージョンの鍵、アカウントの鍵）、署名の鍵は `build-release` | [ADR-0047](../decisions/0047-kms-key-hierarchy.md) |
| IaC | Terraform | 他の題材と同じ。[infrastructure.md](infrastructure.md) の 9 節 |

## 5. 主な決定

どれも `accepted`（0001〜0005 と intent.md は、統合の工程の修正を当ててから 2026-09-27 に `proposed`・`draft` から改めた）。状態の一覧は [decisions/README.md](../decisions/README.md)。領域の ADR の番号の範囲は 7 節。

| ADR | 決定 |
| --- | --- |
| [0001](../decisions/0001-runtime-build-vs-reuse.md) | エッジのランタイムは workerd を元にし、多数のテナントの層は Rust で作る |
| [0002](../decisions/0002-isolation-model.md) | 多数のテナントの V8 isolate を共有のプロセスで動かし、多層の防御を重ねる |
| [0003](../decisions/0003-edge-locations.md) | S1・S2 は AWS のリージョンのエッジのノードを anycast の IP の後ろに置き、S3 で自前の PoP に移る |
| [0004](../decisions/0004-config-and-code-distribution.md) | 設定とコードは、順序付きの変更のログを全ノードの読み込み用の写しへ押し出して配る |
| [0005](../decisions/0005-storage-consistency.md) | ストレージの一貫性は製品ごとに決め、利用者に明示する |
| [0006](../decisions/0006-workerd-fork-and-upstream-tracking.md) | workerd は下流のリポジトリにパッチの列で持ち、上流の最新のタグを週 1 回取り込む |
| [0007](../decisions/0007-isolate-lifecycle-and-dynamic-loading.md) | isolate は関数の版の鍵で再利用し、予備・シャード・先読みで温め、メモリの圧力で段階的に退避する |
| [0008](../decisions/0008-bundle-format-and-compatibility-dates.md) | バンドルは ES モジュール・CommonJS・Wasm・データだけにし、互換の日付とフラグは上流の表をそのまま使う |
| [0009](../decisions/0009-cpu-and-memory-metering.md) | CPU 時間はスレッドの CPU 時計と監視のスレッドで、メモリは isolate ごとの合計で測り、止める |
| [0010](../decisions/0010-process-sandbox-and-egress-invariants.md) | ランタイムのプロセスは名前空間・seccomp・cgroup v2 の中で動かし、外への経路は外向きのプロキシだけにする |
| [0011](../decisions/0011-cordon-tiers-and-placement.md) | cordon は 4 つの段階と隔離用・内部用に分け、設定の写しのアカウントの状態から配置する |
| [0012](../decisions/0012-v8-24-hour-patch-pipeline.md) | V8 の Critical・High の修正は、常設の緊急の経路で 24 時間以内に全ノードへ届ける |
| [0013](../decisions/0013-spectre-mitigations-and-dynamic-isolation.md) | 時計を止め、スレッドとネイティブのコードを禁じ、性能カウンターで疑わしい関数を隔離し、プロセスを毎日入れ替える |
| [0014](../decisions/0014-wintertc-conformance-and-wpt.md) | ECMA-429 の全インターフェイスを持ち、セキュリティのための逸脱を一覧にし、WPT の部分集合を取り込みの門にする |
| [0015](../decisions/0015-nodejs-compat-scope.md) | Node.js の互換は上流の組み込みの範囲に従い、TCP と DNS に依る接続は MVP でエラーにする |
| [0016](../decisions/0016-request-brand-metadata.md) | 要求の属性は `request.<brand>` に置き、S1 で正しく出せる欄だけを埋める |
| [0017](../decisions/0017-global-accelerator-and-regional-nlb.md) | 入口はデュアルスタックの Global Accelerator とリージョンごとの TCP の NLB にし、リージョンは健全性の検査で退かせる |
| [0018](../decisions/0018-acme-certificates-and-sni.md) | 証明書は ACME で自前で発行し、リージョンのデータ鍵で包んで全ノードへ配る |
| [0019](../decisions/0019-route-matching-and-home-node-forwarding.md) | ルートはホスト名の表と制限した文法で解決し、リージョンの中はランデブーハッシュでホームのノードへ 1 回だけ転送する |
| [0020](../decisions/0020-pingora-ingress-and-egress-proxies.md) | 入口と外向きのプロキシは Pingora の上に別々のプロセスとして作り、外向きは専用のリゾルバーとアカウントごとの接続で出す |
| [0021](../decisions/0021-versions-deployments-and-gradual-rollout.md) | 版は変えられないものにし、デプロイは 1〜2 の版と万分率の割合で、版の鍵により決定的に振り分ける |
| [0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md) | 変更のログは 1 つの採番器が (エポック, 番号) で採番し、リージョンの中継を経てノードの LMDB へ唯一の書き手が適用する |
| [0023](../decisions/0023-code-and-secret-distribution.md) | バンドルは版の確定の前に全リージョンの S3 へ置き、シークレットはリージョンの鍵で包んだアカウントの鍵で配る |
| [0024](../decisions/0024-kv-central-store-dynamodb.md) | KV の正本は東京の DynamoDB に置き、4 KiB を超える値は S3 に置く。同じキーの書き込みは条件付きの書き込みで 1 秒に 1 回に制限する |
| [0025](../decisions/0025-kv-two-tier-cache-and-staleness.md) | KV の読み込みはノードとリージョンの 2 段のキャッシュで返し、古さは正本から取った時刻で数える |
| [0026](../decisions/0026-object-storage-s3-gateway-with-scoped-prefixes.md) | オブジェクトストレージは、S3 の共有のバケットの上に、バケットごとの接頭辞と要求ごとに絞った権限で S3 互換の層を作る |
| [0027](../decisions/0027-object-public-access-and-presigned-urls.md) | 公開の配信はカスタムドメインと別の登録可能なドメインの開発用の URL で行い、署名付きの URL は S3 互換の口だけで受ける |
| [0028](../decisions/0028-object-egress-pricing.md) | オブジェクトストレージの外向きの転送は無料にせず、原価を下回らない従量で課金する |
| [0029](../decisions/0029-do-placement-and-directory.md) | Durable Objects の実体の場所は作成時に決めて変えない。名前の ID は東京の台帳で調停し、一意の ID は場所を ID に埋め込む |
| [0030](../decisions/0030-do-leases-and-fencing.md) | 実体の持ち主はホストのリースと実体ごとのエポックで決め、複製の側でエポックを検査して古い持ち主の確定を拒む |
| [0031](../decisions/0031-do-sqlite-replication-and-pitr.md) | SQLite の変更は持ち主と別の AZ の複製の 3 台のうち 2 台（2 つの AZ）で確定し、10 秒か 16 MiB ごとに S3 へ置いて 30 日の PITR を持つ |
| [0032](../decisions/0032-do-alarms-hibernation-and-rpc.md) | WebSocket はランタイムの外の接続の保持役で持って休止を支え、アラームはリージョンの索引で起こし、呼び出しは RPC を基本にする |
| [0033](../decisions/0033-queues-on-sqs-with-own-dispatcher.md) | キューの S1 の保存は SQS の標準のキューにし、配送は自前のディスパッチャーで行う |
| [0034](../decisions/0034-cron-sharded-scheduler.md) | cron はシャードごとのリースを持つ東京のスケジューラーで起動し、予定の時刻ごとの記録で 2 重の起動を防ぐ |
| [0035](../decisions/0035-cli-and-single-jsonc-config.md) | CLI は TypeScript で npm に配り、設定ファイルは `<brand>.jsonc` の 1 つの形にする |
| [0036](../decisions/0036-local-dev-on-downstream-workerd.md) | ローカル開発は同梱の下流の workerd で動かし、ストレージは同じ workerd の中の模擬で模す |
| [0037](../decisions/0037-tail-sessions-and-tenant-logs.md) | `tail` はセッションの印を変更のログで配って WebSocket で届け、保存するログは ClickHouse に置く。伏せる処理はノードで行う |
| [0038](../decisions/0038-plan-limits-and-edge-enforcement.md) | 制限は計画ごとの表で持ち、要求ごとの制限はその場で、期間の枠と費用の上限はアカウントの状態で止める |
| [0039](../decisions/0039-usage-metering-pipeline.md) | 使用量は仕事をした部品が数え、冪等の ID の束で東京へ送り、重複を捨てて集計する |
| [0040](../decisions/0040-jpy-pricing-invoices-and-spend-controls.md) | 料金は円で原価を下回らない値にし、転送を課金する。月末締めの後払いで適格請求書を出し、前払いのクレジットは S1 で売らない |
| [0041](../decisions/0041-management-api-shape.md) | 管理 API は `/v1` のパスの版で足す変更だけを入れ、冪等キー・不透明なカーソル・RFC 9457 のエラーを使う |
| [0042](../decisions/0042-api-tokens-roles-and-audit-log.md) | API トークンは接頭辞とチェックサムの形でシークレットスキャンに載せ、ロールは 5 つに固定し、監査ログは変更と同じトランザクションで書く |
| [0043](../decisions/0043-hosted-content-abuse-and-takedown.md) | ホストした内容の不正は複数の起点で見つけ、段にした措置で止め、通報は 1 つの事件の流れで扱う |
| [0044](../decisions/0044-egress-abuse-controls.md) | 外向きの悪用は cordon ごとのアカウントの外向きの方針で抑え、`<Brand>-Worker` で送り元を必ず示す |
| [0045](../decisions/0045-new-account-risk-scoring.md) | 新しいアカウントのリスクの点数を規則で出し、`c0-untrusted` の条件に足す。点数は信頼を下げる方にだけ働く |
| [0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md) | 全ノードへ届く 3 つの権限（ランタイムの配布、設定のログ、鍵の復号）を別の役割とアカウントに分け、人の本番の権限は期限付き・2 人の承認にする |
| [0047](../decisions/0047-kms-key-hierarchy.md) | 鍵は KMS の 3 層（制御プレーンの鍵、リージョンの鍵、アカウントの鍵）にし、制御プレーンの鍵だけをマルチリージョンにする |
| [0048](../decisions/0048-audit-log-integrity-and-data-lifecycle.md) | 監査ログはハッシュの鎖と WORM の写しで改ざんを検知できるようにし、アカウントのデータは削除から 30 日の猶予の後に消し、写しは各保存の保持の期間で消える |
| [0049](../decisions/0049-aws-accounts-and-network.md) | AWS のアカウントは制御プレーン、リージョンごとのエッジとストレージ、検証のフリート、security-lab、quarantine に分け、リージョンの間は Transit Gateway でつなぐ。ノードの外への通信は NAT ゲートウェイを通さない |
| [0050](../decisions/0050-runtime-fleet-instance-types.md) | テナントのコードを動かすノードは、ゲストに性能カウンターを見せる Intel の c7i・m7i の大きさにし、自前の部品はすべて x86-64 で動かす |
| [0051](../decisions/0051-disaster-recovery-and-honest-rpo.md) | 東京の全体の障害は、関数は自動の迂回、制御プレーンは Aurora の管理された切り替え、ストレージは製品ごとの手動の切り替えで大阪へ移す。RPO は製品ごとの実際の値で示す |
| [0052](../decisions/0052-platform-telemetry-and-cardinality.md) | 基盤の運用のメトリクスはノード・リージョン・cordon までのラベルで AMP に置き、関数ごとの値は呼び出しの記録から ClickHouse で集計する |
| [0053](../decisions/0053-slos-probes-and-burn-rate-alerts.md) | SLO は外からの合成監視と実際の要求の両方で測り、リージョンごとのバーンレートで呼び出す。隔離・耐久性・伝搬の取りこぼしは予算を持たず 1 件で呼び出す |
| [0054](../decisions/0054-capacity-design-point-and-region-sizing.md) | エッジのノードの設計点は CPU 50% で 1 台 8,000 件/秒（c7i.24xlarge）とし、東京・大阪はそれぞれ単独で国内の全量を 1 つの AZ を失っても受けられる台数を持つ |
| [0055](../decisions/0055-staged-runtime-rollout-by-cordon-and-region.md) | ランタイムは cordon とリージョンを軸にした波で、指標の関門を自動で判定して配り、ノードに 2 つの版を置いてプロセスの入れ替えで戻す。ノードの部品は AMI の入れ替えで配る |
| [0056](../decisions/0056-platform-config-staging-and-flags.md) | 利用者の変更は速い経路で全ノードへ配り、基盤の設定とフラグはリージョン・cordon の範囲を付けて段階的に配る |
リポジトリ共通の決定（開発プロセス、ブランチモデル、本家の名前を使わない識別子）は、ルートの [docs/decisions/](../../../../docs/decisions/README.md) にある。特に [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)：振る舞いは本家に寄せるが、ドメイン・HTTP のヘッダー・トークンの接頭辞・CLI・ランタイムの名前空間は `<Brand>`・`<brand>` で書く（1 節の「名前とドメイン」）。

## 6. リスクと未解決事項

品質の面のリスクの順位と対策は [quality.md](../quality.md) の 1 節にある。ここは設計の面のリスクを書く。

- **workerd を多数のテナントで動かすための不足**：上流の README は、workerd だけでは悪意のあるコードへの多層の防御が足りず、VM などのサンドボックスの中で動かすよう求めている（[workerd](https://github.com/cloudflare/workerd)、2026-09-27 に確認）。テナントの動的な読み込みは上流の `workerLoader` を元にできるが、テナントごとの制限の強制は上流になく（`NullIsolateLimitEnforcer`）、自前のパッチが要る（[ADR-0001](../decisions/0001-runtime-build-vs-reuse.md)、[ADR-0009](../decisions/0009-cpu-and-memory-metering.md)）。空の isolate の予備、V8 のサンドボックスの既定の有効化、DO の保存の層への確定の約束の差し込みは未検証で、E2・E3・E9 の最初の PoC で確かめる。`multitenant` と `brand` のパッチは 3,000 行以内を目標にする（[ADR-0006](../decisions/0006-workerd-fork-and-upstream-tracking.md)）。
- **Spectre と未知のサイドチャネル**：isolate はプロセスの中の境界なので、CPU のサイドチャネルへの耐性は VM より弱い。止めた時計などの対策は攻撃を遅くするが、完全には防がない。性能カウンターの検知の閾値は E3 の実験で決め、誤検知の目標は有料の関数の 0.1% 未満（[ADR-0013](../decisions/0013-spectre-mitigations-and-dynamic-isolation.md)）。性能カウンターを使える EC2 の型は Intel の資料に頼っており、AWS の公式の一覧は見つけられなかった（E1 で実機で確かめる。[ADR-0050](../decisions/0050-runtime-fleet-instance-types.md)）。高い信頼の要るテナントには `c3-dedicated` を用意する。
- **V8 の修正の 24 時間の配信**：V8 の更新は、workerd の API の変更や性能の退行を伴うことがある。常設の緊急の経路（毎週の空の実行、四半期の訓練）と、波の関門を同じ値で判定することで両立させる（[ADR-0012](../decisions/0012-v8-24-hour-patch-pipeline.md)、[ADR-0055](../decisions/0055-staged-runtime-rollout-by-cordon-and-region.md)）。
- **拠点の少なさ**：S1 の 5 リージョンでは、日本以外の利用者の遅延は本家より大きい。TCP は GA の edge で受けるが、TLS と HTTP はリージョンのノードまで往復するので、新しい接続の TTFB は本家の約 3 × `r_pop` に対して約 3 × `r_edge` ＋ 2 × `r_bb` になる。南米・アフリカ・中東・オセアニアでは本家の 10 倍以上になりうる（未検証。[ADR-0003](../decisions/0003-edge-locations.md)、[edge-network-and-routing.md](edge-network-and-routing.md) の 11 節）。
- **GA の fail open**：GA は近い 3 つのグループに健全なものがなければ、最寄りのグループへ送る。同時に退かせるリージョンを 2 つまでに限る（[ADR-0017](../decisions/0017-global-accelerator-and-regional-nlb.md)）。利用者の IP（とくに IPv6）が GA → NLB → ノードで保たれるかは未検証（E4 の最初）。
- **IP のアドレスの移行**：利用者の apex のドメインは A・AAAA で IP を指す。S3 で自前の PoP に移るとき、IP を変えずに移るには、自前の IP の範囲を S2 で持つ必要がある（[ADR-0003](../decisions/0003-edge-locations.md)、[infrastructure.md](infrastructure.md) の 8 節）。
- **Durable Objects の一意性と可用性**：1 つの名前に 2 つの実体を確定させないことは、リースとフェンシングの正しさに依存する（[ADR-0030](../decisions/0030-do-leases-and-fencing.md)）。性質ベーステストと Jepsen の形の試験で確かめる。リージョンの DynamoDB の障害では、リースを更新できず 7 秒でそのリージョンの全ホストが止まる（既知の制約。S2 の前に見直す）。
- **制御プレーンのシークレットのサービスと包み直しのジョブ**：ADK を包む `cp-adk-wrap` を開けるシークレットのサービスと、毎月 RSK・RDK で包み直すジョブ（`cp-prod` から各リージョンの鍵を `GenerateDataKey`・`Decrypt` できる。[ADR-0047](../decisions/0047-kms-key-hierarchy.md)）は、侵害されれば全リージョンの全アカウントのシークレットに届く（[security.md](security.md) の 3.3 節の C3）。**受け入れて、次で抑える**：
  - 包み直しのジョブを API のサービスと別のタスクの定義・役割にし、入れ替えの時間の窓（毎月）の間だけ動かす。リージョンの鍵のキーのポリシーは、この役割だけに `Decrypt` を許し、暗号化の文脈（`purpose`・`region`）を必須にする。
  - ADK の復号の数を 1 分ごとに監視し、平常の 10 倍で呼び出す。包み直しのジョブの役割が窓の外で使われたら、CloudTrail の事象で呼び出す。
  - 人は常設の `Decrypt` を持たない（[ADR-0046](../decisions/0046-control-plane-privilege-separation-and-operator-access.md)）。ビルド・署名・設定のログの権限と別のアカウント・役割にし、1 つが奪われても全ノードの任意のコードの実行と全シークレットの復号を同時には得られない。
  - アカウントの範囲ごとに役割を分ける案と、`c3-dedicated` のアカウントの単位の RSK は S2 で再評価する。
- **設定の配信の速い経路**：利用者の器（ルート、停止）は速い経路で全ノードへ届く。基盤の器は段階的に配る（[ADR-0056](../decisions/0056-platform-config-staging-and-flags.md)）が、採番器や受け手の欠陥は全体に広がる。本家は設定の配信の誤りで 2 回、網を広く止めた（[Code Orange: Fail Small](https://blog.cloudflare.com/fail-small-resilience-plan/)、2026-09-27 に確認）。性質ベーステストと障害の注入で守る。採番器は 1 本で、S1 の見込みの 10 倍（毎秒 100 の変更）を越えると詰まりうる。全ノードに全データを持つ v1 の形は S2 まで。S3 の前に Quicksilver v1.5・v2 に近い形（レプリカとキャッシュ）へ移る ADR を起こす。
- **原価と料金**：CPU 時間の単価は、本家と同じ 3 円では原価を下回っていた。設計点（利用率 50%）の原価の 1.3 倍の 7 円を既定案にしたが、S1 の東京の平常の利用率（約 23%）ではなお原価を下回る（[capacity.md](capacity.md) の 8 節、[limits-and-billing.md](limits-and-billing.md) の 6.5 節）。K8 も S1 の利用率では満たさない（S2 で測る約束）。KV の書き込み（原価 約 5.7 ドル/100 万）、オブジェクトの保存・操作、外向きの転送は本家の料金より高い。**PM の確認事項**（[intent.md](../intent.md) の P3・P4）。
- **率直な RPO**：東京の全体の障害では、KV の大きな値・オブジェクト・Durable Objects は最大 15 分（99.9%）の書き込みを失いうる。キューは東京の回復まで止まる。NFR-010 を製品ごとの値に改めた（3 節。**PM・Ops の確認事項**）。
- **オリジンへの転送**：この基盤は DNS の製品を持たないので、ルートに当たらない要求をホスト名のオリジンへ転送する。これにより、利用者のサーバーの前に立つリバースプロキシになる（[ADR-0019](../decisions/0019-route-matching-and-home-node-forwarding.md)）。中継が「他人の通信の媒介」に当たるかは法務の L2。MVP に含めるかは **PM の確認事項**（intent の P1）。
- **本家より弱い約束**：オブジェクトのメタデータ 2 KiB（本家 8,192 バイト）とライフサイクルの反映 最大 2 日、キューの遅延の上限（送信 15 分・再試行 12 時間）、KV の同時の書き込みは先に確定した方が勝つ、Durable Objects の複製がリージョンの中の AZ に閉じる。利用者向けの文書に差として書く。
- **不正利用**：無料の枠と既定のサブドメインは、フィッシング・マルウェアの配布・プロキシとしての悪用に使われやすい。新しいアカウントを `c0-untrusted` に閉じ込め、段にした措置で止める（[ADR-0043](../decisions/0043-hosted-content-abuse-and-takedown.md)〜[ADR-0045](../decisions/0045-new-account-risk-scoring.md)）。法令の上の扱いは法務の確認待ち（[intent.md](../intent.md) の L1・L2・L4）。
- **法務・経理**：L1〜L7（不正な内容、電気通信事業法と通信の秘密、データの所在、AUP、前払いと消費税、OSS のライセンス、DPA と保持）は法務の確認待ち。結論が出るまで、該当する Story の spec を承認しない（[roadmap.md](../roadmap.md) の「法務：L*」）。

### 決定（2026-09-27、既定案）

PM の方針（本家に寄せる、既定案で進める）により、統合の工程で次のとおり決めた。法務・経理の判断が要るものは決めず、[intent.md](../intent.md) の「法務の確認待ち」（L1〜L7）に残した。

- **ADR と intent の状態**：基盤の ADR（0001〜0005）と intent.md を、他の題材と同じく `accepted` にした。先に次を直した。
  - ADR-0001・ADR-0002：テナントの動的な読み込みは上流に `workerLoader` がある。テナントごとの制限の強制は上流になく、パッチが必ず要る（ADR-0009）。V8 のサンドボックスが上流の既定のビルドで有効かは E3 で確かめる（ADR-0010）。
  - ADR-0003：遅延の率直な比較（TTFB の往復の式と、地域ごとの見込み）と、同時に 2 リージョンまでしか退かせない GA の fail open の制限（ADR-0017）を書いた。
  - ADR-0004：ランタイムは LMDB を開かず、スーパーバイザーが設定を渡す（ADR-0022、サンドボックス）。全体の古さは警報だけで、局所の遅れだけがノードを不健全にする。本家の Quicksilver v2 は RocksDB とキャッシュに移ったが、この題材は S3 まで v1 の形を保つ。
  - ADR-0005：KV の同時の書き込みを ADR-0024 の「先に確定した方が勝ち、後は 429」に揃えた。オブジェクトのメタデータは S3、バケットの設定だけが Aurora。各製品の保存の ADR を参照した。
  - intent.md：WebSocket は ECMA-429 に含まれないので追加の API として書いた。`WebAssembly.compileStreaming`・`instantiateStreaming` は逸脱。`node:net`・`node:tls` は MVP でエラー。DNS の製品がなく、オリジンへの転送でリバースプロキシになることを **PM の確認事項**（P1）にした。L1〜L7 の「関係する設計」を実在の文書に改めた。
- **NFR-001**：5ms は圧縮前 1MiB 以下のバンドルの isolate の作成と読み込みに限る。本家は 64MiB と 1 秒の起動を許すので、大きなバンドルは大きさの帯ごとに計測して公開する（3 節）。
- **NFR-010**：ADR-0051 の製品ごとの RPO の表に改めた（3 節）。**PM・Ops の確認事項**（intent の P2）。
- **外向きの送信元の IP**：ノードの公開の IPv4（NAT を通さない。ADR-0049）。edge-network-and-routing の 10.2・10.3 節と ADR-0044（注記）を直し、送信元の記録の `nat_ip` を `egress_ip` にした。
- **無料の cordon のポート**：ADR-0044 の狭い既定（`c0` は 80・443、`c1` は 80・443・8080・8443）を採り、edge-network-and-routing の 10.3 節を揃えた。
- **ノードのディスク**：ADR-0050 に従い gp3（DO のログのノードだけ i4i の NVMe）。runtime-and-isolates、durable-objects、deployment-and-config-distribution の「ローカルの NVMe」を直した。
- **CPU 時間の単価**：100 万 ms あたり 3 円 → 7 円（設計点の利用率 50% の原価 約 4.68 円の 1.3 倍を切り上げ。計算は limits-and-billing の 6.5 節）。月額 800 円は変えない。KV の書き込みを 1,120 円、KV の保存を 115 円に上げ、各行を原価の 1.3 倍以上にした。関数の応答も外向きの転送（1GB 25 円）で課金する。**PM の確認事項**（intent の P3・P4、ADR-0040 の注記）。
- **キューの消費者の CPU 時間**：本家に合わせ、1 束あたり既定 30 秒・最大 5 分、壁時計 15 分。runtime-and-isolates の 6.1 節と limits-and-billing の 3.1 節を揃えた（元は cron と同じ「15 分」だった）。
- **監査ログの持ち分**：利用者の監査ログ（記録の中身、形、画面、API、18 か月）は dashboard-and-api が持つ。改ざんの検知（ハッシュの鎖、WORM）、長期の保存、基盤の監査は security（ADR-0048）が持つ。`audit_events` に `prev_hash`・`row_hash` を足した。
- **`c0-untrusted` の条件**：`risk_level` が `high`（計画によらず）と `medium`（支払い手段の確認まで）、`abuse_hold` のあるアカウントを足した。支払いに失敗した有料のアカウントは `c1-free` に下げ、`c0` には下げない（`risk_level` が `high` なら `c0`）。sandbox-and-security の 5.1 節と ADR-0011 の注記。
- **利用者のログと基盤の観測を分けた**：置き場所（ClickHouse と AMP・S3）、見る人、保持、利用者のデータの有無を observability の 3 節の表にした。
- **`<console-domain>`**：管理 API・ダッシュボード・tail・文書・通報の窓口のドメインを、関数の既定のドメインと別の登録可能なドメインとして 1 節の「名前とドメイン」に入れた。
- **器の種類**：`region_key` は基盤の器。`account_egress` はアカウントごとのキーだが、基盤の器と同じ段階と承認で配る。器の表に ADR-0056 の種類の列と、`tail/`・`script_state/`・`account_egress/`・`account_state` の新しい欄を加えた（[data-model.md](data-model.md) の 8 節、deployment-and-config-distribution の 6.3 節）。
- **負荷試験の ID**：capacity の L1〜L10 を T1〜T10 に改めた（法務の L1〜L7、隔離の層の L1〜L5 と重なるため）。
- **数値の正本**：SLO とアラートは [runbooks/README.md](../runbooks/README.md) の 1・5 節。制限の値は [limits-and-billing.md](limits-and-billing.md) の 3 節。料金は同 6 節。設計点と台数は [capacity.md](capacity.md)。RPO は [ADR-0051](../decisions/0051-disaster-recovery-and-honest-rpo.md)。保持は [data-model.md](data-model.md) の 13 節。
- **Epic**：E1〜E12 が MVP（S1）。S2・S3 の Epic は E13〜E17（8 節、[roadmap.md](../roadmap.md)）。それ以外は roadmap.md の延期の一覧。
- 領域ごとの決定は、各文書の「決定」（2026-09-27 の既定案）の節にある。

## 7. 領域の文書と ADR の番号の範囲

各領域の ADR は、下の範囲の中で採番する。範囲を使い切ったら、この表を更新してから 0057 以降の空き番号を割り当てる（既存の範囲をずらさない）。持ち主は、どれも Dev が書き、「レビュー」の列のロールが確認する。

| ファイル | 領域 | ADR | レビュー | 関係する Epic |
| --- | --- | --- | --- | --- |
| [runtime-and-isolates.md](runtime-and-isolates.md) | workerd の取り込みと上流の追従、isolate の作成・再利用・退避、テナントのコードの動的な読み込み、互換の日付とフラグ、バンドルの形式（ES モジュール、Wasm）、CPU・メモリの計測 | 0006–0009 | QA、セキュリティ | E2 |
| [sandbox-and-security.md](sandbox-and-security.md) | 脅威モデル、プロセスのサンドボックス（seccomp、名前空間、cgroup）、cordon、Spectre の対策（止めた時計、スレッドの禁止、動的なプロセスの分離）、V8 の修正の 24 時間の配信、脱出のテスト、ファズ | 0010–0013 | セキュリティ、QA | E3 |
| [web-apis-and-compat.md](web-apis-and-compat.md) | WinterTC の最小の共通 API、`fetch` とサブリクエスト、WebSocket、Web Crypto、Node.js の互換の範囲、`request.<brand>` の属性、WPT での適合の確認 | 0014–0016 | QA | E2 |
| [edge-network-and-routing.md](edge-network-and-routing.md) | anycast の IP と DNS、Global Accelerator と NLB、TLS の終端と証明書（ACME）、ルートの解決、リージョンの間の迂回、ノードの間の負荷分散、外向きのプロキシ | 0017–0020 | Ops、セキュリティ | E4 |
| [deployment-and-config-distribution.md](deployment-and-config-distribution.md) | 版とデプロイ、段階的なデプロイ、ロールバック、設定の変更のログと配信の中継、ノードの写し、コードの配布とキャッシュ、シークレットとバインディング | 0021–0023 | QA、Ops | E5 |
| [kv-store.md](kv-store.md) | KV の API、中央の保存、リージョンとノードのキャッシュ、TTL、書き込みの制限、一覧 | 0024–0025 | QA | E7 |
| [object-storage.md](object-storage.md) | S3 互換の API、バインディング、バケットのホームのリージョン、メタデータと本体、マルチパート、公開の配信とキャッシュ、署名付きの URL | 0026–0028 | QA、セキュリティ | E8 |
| [durable-objects.md](durable-objects.md) | 名前から実体への対応、配置、リースとフェンシング、入力と出力のゲート、SQLite の保存と複製、アラーム、WebSocket の休止、障害時の移動、データの所在 | 0029–0032 | QA | E9 |
| [queues-and-cron.md](queues-and-cron.md) | キューの保存と配信、少なくとも 1 回、再試行とデッドレター、バッチでの消費、cron の式とスケジューラ | 0033–0034 | QA | E10 |
| [developer-tooling.md](developer-tooling.md) | CLI、設定ファイル、ローカル開発（workerd と模擬のストレージ）、tail、利用者のログの保存と検索、型の生成 | 0035–0037 | QA | E6 |
| [limits-and-billing.md](limits-and-billing.md) | 制限の値、使用量の計測（要求数、CPU ミリ秒、ストレージの操作）、集計と請求、無料の枠、円の料金 | 0038–0040 | QA、経理、PM | E11 |
| [dashboard-and-api.md](dashboard-and-api.md) | 管理 API、ダッシュボード、アカウントとメンバー、API トークン、利用者の監査ログ | 0041–0042 | QA、セキュリティ | E1、E6 |
| [abuse-and-trust-safety.md](abuse-and-trust-safety.md) | フィッシング・マルウェアの検知と停止、採掘などの禁止の用途、外向きの悪用、新しいアカウントのリスク、通報の窓口、既定のサブドメインの扱い | 0043–0045 | 法務、セキュリティ | E12 |
| [security.md](security.md) | 制御プレーンの脅威モデル、シークレットの暗号化と鍵、監査ログの改ざんの検知と長期の保存、脆弱性の報奨の窓口、データのライフサイクル | 0046–0048 | セキュリティ | E1、E3、E12 |
| [infrastructure.md](infrastructure.md) | AWS のアカウントとリージョン、エッジのフリート（インスタンスの型、AMI、配置）、制御プレーンの冗長化、災害復旧、S3 の自前の PoP への移行、費用 | 0049–0051 | Ops、セキュリティ | E1、E4、E12 |
| [observability.md](observability.md) | 基盤のログ、メトリクス、トレース、合成監視、SLI・SLO、アラート、利用者のログとの分け方 | 0052–0053 | Ops、QA | E1、E6、E12 |
| [capacity.md](capacity.md) | 負荷のモデル、ノードあたりの isolate の数、メモリの予算、リージョンごとの必要量、原価の単価、負荷試験 T1〜T10 | 0054 | Ops、PM | E1、E2、E4 |
| [delivery.md](delivery.md) | CI/CD、ランタイムとエッジのノードの段階的な配信、V8 の修正の緊急の経路、基盤の設定とフィーチャーフラグ | 0055–0056 | QA、Ops | E1、E3、E5 |
| [data-model.md](data-model.md) | 全ての保存の索引（Aurora、ClickHouse、DynamoDB、S3、Valkey、LMDB の器、DO の SQLite） | なし（各領域の ADR を参照） | QA | 全 Epic |

## 8. Epic

Epic と Story の計画は [roadmap.md](../roadmap.md) にある（PM が持つ）。領域の文書の Story の候補は、この番号で書く。各 Epic の品質の重点と合否基準は [quality.md](../quality.md) の 5 節。

| Epic | 中身 |
| --- | --- |
| E1 基盤と PoC | AWS のアカウントと VPC・TGW・PrivateLink、エッジのフリートと AMI、PMU・PKU の実機の確認、`build-release` と署名、KMS の鍵、`log-archive`、観測の経路と合成監視の枠、管理 API の骨格・アカウント・ログイン・API トークン・監査ログ |
| E2 ランタイムと Web API | workerd の下流のリポジトリとパッチの列、週 1 回の取り込み、`IsolateLimitEnforcer`、テナントのローダー、isolate の予備と退避、互換の日付、ECMA-429 と WPT の門、`request.<brand>`、Node.js の互換、負荷試験 T1〜T4 |
| E3 サンドボックスとセキュリティ | 名前空間・seccomp・cgroup、V8 のサンドボックスの確認、cordon、止めた時計、性能カウンターの検知と閾値の実験、毎日のプロセスの入れ替え、V8 の 24 時間の経路、脱出のテスト、ファズ、シークレットの暗号化（ADK・RSK）、署名の検証 |
| E4 エッジの網とルーティング | GA と NLB、入口のプロキシ、ACME と証明書、カスタムドメイン、ルートの解決、ホームのノードへの転送、外向きのプロキシとアカウントの外向きの方針、`drain`、オリジンへの転送、負荷試験 T5・T6・T9 |
| E5 デプロイと設定の配信 | 版とデプロイ、段階的なデプロイ、ロールバック、outbox と採番器、配信の元と中継、ノードの受け手、スナップショット、伝搬の SLI、配信の制御役、基盤の器の `scope`、フィーチャーフラグ、負荷試験 T7・T8 |
| E6 開発者の道具とログ | CLI、`<brand>.jsonc`、ローカル開発と模擬、tail、利用者のログ（ClickHouse）、関数のメトリクス、型の生成、ダッシュボードの画面、K4 の E2E |
| E7 KV | 正本（DynamoDB）、ゲートウェイ、L1・L2 のキャッシュ、一覧、一貫性の計測と有界の古さの検査器、大阪への複製 |
| E8 オブジェクトストレージ | S3 互換のゲートウェイ、STS のセッション、マルチパート、バインディング、ライフサイクル、公開の配信と署名付きの URL、線形化可能性の検査 |
| E9 Durable Objects | ID と名前の台帳、ルーター、リースとフェンシング、ログのノードと確定、PITR、アラーム、WebSocket の休止、Jepsen の形の試験、管轄 `jp` |
| E10 キューと cron | SQS とディスパッチャー、バッチ・並行・再試行・DLQ、pull の消費者、cron のスケジューラー、失われた `msg_id` の検査、2 重の起動の試験 |
| E11 制限と課金 | 計画の制限の表、期間の枠と費用の上限、使用量の経路と突き合わせ、円の料金、適格請求書、支払いと未払い、予算の警告 |
| E12 不正利用・運用と GA の準備 | Trust & Safety（検知、措置、通報、リスクの点数、法務の窓口）、監査の鎖と WORM、アカウントの削除、報奨金の窓口、外部の侵入試験、DR の訓練、SLO の文書と全アラートの runbook、GA の判定 |
| E13〜E17（S2・S3） | 自前の IP と PoP（BYOIP は S2、PoP と BGP anycast は S3）、SQL のデータベース、AI の推論、コンテナ、ワークフロー |

## 9. 参考にした類似の基盤

| 基盤 | 隔離と実行の単位 | 拠点 | この設計で取り入れること・取り入れないこと |
| --- | --- | --- | --- |
| Cloudflare Workers（本家） | 共有のプロセスの中の V8 isolate。seccomp・名前空間、cordon、Spectre の対策（[Security model](https://developers.cloudflare.com/workers/reference/security-model/)） | 348 都市（[Global Network](https://www.cloudflare.com/network/)） | 隔離の方式を取り入れる。拠点の数は S3 まで追わない |
| Deno Deploy | V8 isolate。2025 年に拠点を 35 から 6 に減らした。多くのアプリが 1 つのリージョンの DB を使い、全拠点での実行が生きなかったため（[Reports of Deno's Demise…](https://deno.com/blog/greatly-exaggerated)、2025-05-20） | 6 リージョン | 拠点を増やす前に、データの近さを考える。S1 を少ないリージョンで始める根拠の 1 つ |
| Vercel Functions（Fluid compute） | 従来は関数ごとの microVM。Fluid compute では 1 つのインスタンスで複数の呼び出しを並行に処理する（[Fluid compute](https://vercel.com/docs/fluid-compute)） | リージョン（既定は 1 つ、Pro で最大 3） | Node.js の完全な互換を取る方式。この設計は isolate の密度を優先して取らない |
| Fastly Compute | Wasm を Wasmtime で動かし、既定では要求ごとに新しいサンドボックス（[Getting started with Compute](https://www.fastly.com/documentation/guides/compute/getting-started-with-compute/)） | Fastly の PoP | 要求ごとの使い捨ては隔離が強いが、JavaScript をそのまま動かせない。[ADR-0001](../decisions/0001-runtime-build-vs-reuse.md) の選択肢として比べた |
| Lambda@Edge・CloudFront Functions | CloudFront Functions は ES 5.1 の JavaScript、2MB・10KB のコード、ネットワークなし。Lambda@Edge は Node.js と Python、リージョンのキャッシュで動く（[Choosing between…](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/edge-functions-choosing.html)） | CloudFront の 750 以上の PoP（[CloudFront features](https://aws.amazon.com/cloudfront/features/)） | 利用者のコードを CloudFront の PoP で動かす手段としては制約が大きい。[ADR-0003](../decisions/0003-edge-locations.md) で比べた |

すべて 2026-09-27 に確認した。

# Deployment and Config Distribution: Cloudflare Workers

関数の版とデプロイ、段階的なデプロイとロールバック、設定の変更のログと、それを全ノードの LMDB へ届ける配信、コードの配布、シークレットとバインディングの配り方、伝搬の SLO と静的な安定を決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0004](../decisions/0004-config-and-code-distribution.md) | 設定とコードは、順序付きの変更のログを全ノードの読み込み用の写し（LMDB）へ押し出して配る。コードは内容のハッシュで S3 に置く |
| [ADR-0008](../decisions/0008-bundle-format-and-compatibility-dates.md) | バンドルは ES モジュール・CommonJS・Wasm・データだけ。互換の日付は上流の表 |
| [ADR-0011](../decisions/0011-cordon-tiers-and-placement.md) | cordon はアカウントの状態から決め、信頼を下げる変更は届いた時点で反映する |
| [ADR-0021](../decisions/0021-versions-deployments-and-gradual-rollout.md) | 版は変えられない（コード・設定・バインディング・シークレットの参照）。デプロイは 1〜2 の版と万分率の割合。版の鍵で決定的に振り分ける。ロールバックは新しいデプロイ |
| [ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md) | outbox を 1 つの採番器が (エポック, 番号) で採番し、配信の元 → リージョンの中継 → ノードの LMDB へ流す。書くのは受け手の 1 プロセスだけ。ランタイムは LMDB を開かない |
| [ADR-0023](../decisions/0023-code-and-secret-distribution.md) | バンドルは版の `ready` の前に全リージョンの S3 へ同期で置く。シークレットはアカウントの鍵で暗号化し、その鍵をリージョンの鍵で包んで配る |

バンドルの形と検証は [runtime-and-isolates.md](runtime-and-isolates.md) の 7 節、証明書・ルート・ホスト名の器の中身は [edge-network-and-routing.md](edge-network-and-routing.md)、cordon の配置は [sandbox-and-security.md](sandbox-and-security.md) の 5 節にある。CLI の `deploy` の体験は [developer-tooling.md](developer-tooling.md)、ランタイムとノードの自前の部品の配信（利用者の関数ではないもの）は [delivery.md](delivery.md)、シークレットの鍵の階層の全体は [security.md](security.md)、ストレージのバインディングの先は各ストレージの文書にある。

本家の振る舞いと数値は、2026-09-27 に本家のブログ（Quicksilver）、Workers の文書、LMDB の文書、AWS の文書で確かめた。

## 1. 目的と範囲

- 目的：デプロイを受け付けたら、p99 30 秒以内に全ノードで新しい版が動く。ルート・シークレット・設定の変更は p99 10 秒以内（NFR-008）。制御プレーンが止まっても、ノードは最後の設定で動き続ける。どのノードがどの変更まで適用したかを、番号で正確に言える。

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 版・デプロイのモデル、段階的なデプロイ、版の鍵、版の上書き、ロールバック | CLI・ダッシュボードの操作の形（developer-tooling、dashboard-and-api） |
| outbox、採番、変更のログ、配信の元・中継・ノードの受け手、LMDB の形 | 各器の中身の意味（ルート・証明書は edge-network-and-routing、cordon は sandbox-and-security） |
| スナップショットと新しいノードの立ち上げ | ノードの AMI・起動の手順（infrastructure） |
| バンドルの S3 への置き方、リージョンへの配り方、先読み、中継のキャッシュ、掃除 | バンドルの形と検証（runtime-and-isolates の 7 節） |
| シークレットの暗号化と配布、バインディングの解決 | KMS の鍵の階層の全体、鍵の入れ替えの方針（security） |
| 伝搬の SLI・SLO、古さの扱い、静的な安定 | SLO の運用（アラートの経路。observability、runbooks） |

## 2. 本家と部品の仕組み（確かめたこと）

| 項目 | 事実 | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| Quicksilver（v1） | 変更は単調に増える番号の付いたログで、500ms ごとにまとめる。番号で抜けを検知する。ノード → 中継 → 最上位の木で広がる。中継の一部は 1 週間分の履歴を持ち、長く離れたノードの追いつきに使う。キーと値に CRC、ログは Snappy で圧縮。複製の遅れを心拍で見る。ソケットの受け渡しで、数ミリ秒で無停止の更新。データベースの ID で取り違えを防ぐ。200 都市に数秒で届き、1 日 2.5 兆の読み込みと 3,000 万の書き込み。LMDB を 3 年以上、9 万以上のデータベースで使い、壊れた事象 0。ログを LMDB の中に持つとディスクが断片化し、ディスクが満ちると大きな値の空きを探すのに分単位かかった | [Introducing Quicksilver](https://blog.cloudflare.com/introducing-quicksilver-configuration-distribution-at-internet-scale/)（2020-03-30） |
| Quicksilver（v1.5・v2） | 全サーバーに全データを持つのは非効率になった（大きなデータセンターで使うキーは約 20%、小さなところで約 1%）。全データを持つ「レプリカ」と、使うものだけ持つ「プロキシ（持続するキャッシュ）」に分けた。v2 はデータセンターの中の中継（relay）と 3 段のキャッシュ。逐次の一貫性（A を B より先に書いたら、A を読まずに B を読めない）を、版の番号で保つ。保存は RocksDB。キーは 50 億以上、1.6TB、毎秒 30 億以上の読み込み。キャッシュの当たりは 1 段目で 99.9% 以上 | [Quicksilver v2 Part 1](https://blog.cloudflare.com/quicksilver-v2-evolution-of-a-globally-distributed-key-value-store-part-1/)（2025-07-10）、[Part 2](https://blog.cloudflare.com/quicksilver-v2-evolution-of-a-globally-distributed-key-value-store-part-2-of-2/)（2025-07-17） |
| 版 | コード、静的なアセット、バインディング、互換の設定を含む、ある時点の関数の全体。一意の ID、作った人・時刻・経路。メッセージとタグを付けられる。KV などのストレージの中身は版に含まれない | [Versions & deployments](https://developers.cloudflare.com/workers/versions-and-deployments/) |
| デプロイ | 1 つの版（100%）か、2 つの版（割合で分ける）を指す。既定の `deploy` は版を作って 100% にする。一覧は直近 100 | 同上 |
| 段階的なデプロイ | 要求ごとに割合で独立に版を選ぶ。直近 100 の版から作れる。Durable Objects は同時に 1 つの版だけ動く | [Gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/) |
| 版の鍵（version affinity） | 要求のヘッダーの鍵をハッシュし、割合と合わせて決定的に版を決める。割合を上げても、新しい版に割り当てられた鍵はそのまま残る。サービスバインディングのサブリクエストにも付けられる | [Version affinity](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/version-affinity/) |
| 版の上書き | RFC 8941 の辞書の形のヘッダーで、関数の名前ごとに版の ID を指す。いまのデプロイに含まれる版（0% を含む）だけに効く。効かなければ割合で選ぶ。直近の変更が全体に届くまで数秒かかりうる | [Version overrides](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/) |
| ロールバック | 前の版を 100% にする新しいデプロイを作る。2 つの版のデプロイからも戻せる。直近 100 の版まで。バインディングの先（KV、R2、キュー）が消えた、Durable Objects のクラスの変更があった場合は戻せない。ストレージの中身は戻らない | [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/) |
| シークレット | 暗号化したテキストのバインディング。`secret put` は新しい版を作ってすぐデプロイする。段階的なデプロイでは版だけを作る形を使う | [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) |
| 環境変数の上限 | 1 関数あたり（シークレットと合わせて）無料 64・有料 128、1 つ 5KB | [Limits](https://developers.cloudflare.com/workers/platform/limits/) |
| LMDB | B 木。全体を memory map で見せ、読み込みでコピーしない。複数のプロセス・スレッドから同時に使える。書き込みは完全に直列（同時に 1 つ）。多版なので、書き込みは読み込みを止めず、読み込みも書き込みを止めない。書き込み先のページはコピーオンライトで、落ちても回復の手順が要らない。空きページを再利用する。長く開いた読み込みのトランザクションは、空いたページの再利用を止め、データベースを急に大きくする。落ちたプロセスの読み込みは `mdb_reader_check` で片付ける。読み込みだけのプロセスもロックのファイルへの書き込みが要る。ネットワークのファイルシステムで使わない。いまの版は 1.0 | [LMDB 1.0 の文書](http://www.lmdb.tech/doc/) |
| S3 の複製 | S3 RTC は、ほとんどのオブジェクトを数秒で、99.9% を 15 分以内に複製する | [S3 Replication Time Control](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication-time-control.html) |
| KMS のマルチリージョンキー | 同じ鍵の素材と鍵の ID を複数のリージョンに持ち、あるリージョンで暗号化したものを別のリージョンで復号できる。各リージョンで独立に管理する | [Multi-Region keys](https://docs.aws.amazon.com/kms/latest/developerguide/multi-region-keys-overview.html) |

**本家との違いを先に書く。** Quicksilver は v2 で「全ノードに全データ」をやめ、保存も LMDB から RocksDB に移った（上の表）。この題材の S1・S2 は、データが小さい（S1 で約 1GB の見込み。6.3 節）ので、v1 と同じく全ノードに全データを LMDB で持つ。S3（関数 500 万）では足りなくなるので、v1.5 のレプリカとプロキシの形へ移る前提にする（15 節）。

## 3. 原則

- **版は変えられない。** デプロイ・ロールバックは、どの版を指すかの変更だけ。
- **正本は Aurora、ノードの写しは番号の時点の正本と同じ。** 任意の遅れ・重複・並べ替えのもとで、ノードの状態は、正本のある番号の時点の状態に等しい（ADR-0004 の性質）。
- **要求の処理は LMDB とコードのキャッシュだけを読む。** 制御プレーン・配信の元・中継・S3 を、要求の処理の経路で同期に待たない。例外はコードのキャッシュの外れ（中継から取る。7 節）。
- **止まっても動き続ける。** 配信が止まったノードは、最後に適用した設定で要求を処理する。古さは記録と警報にし、要求を止める理由にしない（9 節）。
- **ランタイムは LMDB を開かない。** ランタイムのプロセスはファイルシステムを持たない（[sandbox-and-security.md](sandbox-and-security.md) の 4 節）。必要な設定は、スーパーバイザーが読み込みの指示に入れて渡す。

## 4. 版とデプロイ

[ADR-0021](../decisions/0021-versions-deployments-and-gradual-rollout.md)。

### 4.1 モデル

```sql
CREATE TABLE scripts (
  account_id     uuid        NOT NULL,
  id             uuid        NOT NULL,          -- script_id
  name           text        NOT NULL,          -- unique per account; [a-z0-9-]{1,63}
  subdomain_enabled boolean  NOT NULL DEFAULT true,  -- <name>.<account>.<brand>.<domain>
  created_at     timestamptz NOT NULL,
  deleted_at     timestamptz,
  PRIMARY KEY (account_id, id),
  UNIQUE (account_id, name)
);

CREATE TABLE script_versions (
  account_id        uuid        NOT NULL,
  script_id         uuid        NOT NULL,
  id                uuid        NOT NULL,       -- version_id (UUIDv7)
  number            integer     NOT NULL,       -- 1, 2, 3 ... per script
  status            text        NOT NULL,       -- validating | distributing | ready | failed | purged
  bundle_sha256     bytea       NOT NULL,
  bundle_size_compressed   integer NOT NULL,
  bundle_size_uncompressed integer NOT NULL,
  compatibility_date  date      NOT NULL,
  compatibility_flags text[]    NOT NULL,
  startup_time_ms   integer,
  bindings          jsonb       NOT NULL,       -- resolved ids, no secret values (4.1.1)
  secret_refs       jsonb       NOT NULL,       -- [{name, secret_value_id}]
  limits            jsonb       NOT NULL,       -- cpu_ms, subrequests (bounded by plan)
  message           text,                       -- <= 100 chars
  tag               text,                       -- <= 25 chars
  source            text        NOT NULL,       -- cli | api | dashboard | secret_change | rollback
  created_by        uuid        NOT NULL,
  created_at        timestamptz NOT NULL,
  PRIMARY KEY (account_id, script_id, id),
  UNIQUE (account_id, script_id, number)
);

CREATE TABLE deployments (
  account_id     uuid        NOT NULL,
  script_id      uuid        NOT NULL,
  id             uuid        NOT NULL,
  versions       jsonb       NOT NULL,   -- [{version_id, basis_points}] 1..2 items, sum = 10000
  reason         text        NOT NULL,   -- deploy | gradual | rollback | secret_change | suspend_restore
  message        text,
  created_by     uuid        NOT NULL,
  created_at     timestamptz NOT NULL,
  log_seq        bigint,                 -- (epoch, seq) of the change log entry; set by the sequencer
  log_epoch      integer,
  PRIMARY KEY (account_id, script_id, id)
);
-- The current deployment is the one with the largest created_at per script.
-- All tables above have RLS on account_id (AGENTS.md).
```

#### 4.1.1 バインディングの形

版の `bindings` は、名前ではなく解決した ID で持つ。版を作った後に資源の名前が変わっても、版の意味が変わらないようにする。

| 種類 | 版に入れるもの | 作成時の検査 |
| --- | --- | --- |
| `plain_text`・`json`（環境変数） | 名前と値（1 つ 5KB 以下） | 数の上限（無料 64・有料 128。シークレットと合わせて） |
| `secret` | 名前と `secret_value_id`（値は入れない。8 節） | 同上 |
| `kv_namespace`・`r2_bucket`・`queue`・`durable_object_namespace` | 名前と資源の ID | 同じアカウントの資源が存在する |
| `service`（他の関数） | 名前と `script_id`（版ではなく、その関数のいまのデプロイを呼ぶ） | 同じアカウントの関数が存在する |
| `version_metadata` | 名前だけ（実行時に版の ID・タグ・作成の時刻を渡す） | — |

- 版の作成時に資源の存在を確かめるが、後で消えることはある。消えた資源のバインディングは、呼び出し時にエラーになる（本家と同じく、ストレージの中身は版に含まれない）。

### 4.2 版の作成の流れ

```
CLI・API                 制御プレーン                検証のフリート          5 つのリージョンの S3        変更のログ
 │ POST /scripts/{s}/versions（バンドル＋メタデータ）
 │────────────────────▶│ 形・大きさ・資源の検査
 │                      │ status=validating
 │                      │──── バンドル ─────────▶│ 解析・起動の検証（runtime-and-isolates の 7.3 節）
 │                      │◀─── ok, startup_time_ms │
 │                      │ status=distributing
 │                      │──── PUT bundles/sha256/<hex>（5 つ並行、If-None-Match: *）──▶│
 │                      │◀──────────── 全リージョンで成功 ─────────────────────────────│
 │                      │ status=ready（同じトランザクションで outbox に version を書く。6.3 節）
 │◀── version_id, number, startup_time_ms
```

- **バンドルは `ready` の前に、全リージョンのバケットへ同期で置く**（[ADR-0023](../decisions/0023-code-and-secret-distribution.md)）。S3 の複製（RTC で 15 分以内に 99.9%）を待つと、デプロイの 30 秒の SLO に入らないため。
- あるリージョンへの PUT が 30 秒失敗し続けたら、`ready` にして `pending_regions` に記録し、裏で再試行する。そのリージョンのノードは、東京のバケットから取る（遅いが動く。7 節）。
- 同じ内容のバンドル（同じ SHA-256）は、どのアカウントからでも同じ場所に置く。キーは内容のハッシュなので、中身の上書きは起きない（`If-None-Match: *`）。
- CLI の `<brand> deploy` は、版の作成とデプロイ（100%）を続けて行う。デプロイの伝搬の時間は、版が `ready` になった後のデプロイの受付から数える（9.1 節）。

### 4.3 デプロイと段階的なデプロイ

- デプロイは 1 つか 2 つの版と、万分率（`basis_points`、0〜10000、合計 10000）の割合。本家は割合の刻みを公開していない（未検証）ので、0.01% 刻みにする。
- デプロイの作成は、`deployments` の行と、変更のログの `deploy/<script_id>` を同じトランザクションで書く。指す版の `version/<version_id>` がノードに届いていなければ、同じトランザクションで一緒に書く（6.3 節）。

**版の選び方**（入口のプロキシ。ルートの解決の後）：

```
入力：deploy = [(A, bpA), (B, bpB)]（B は number の大きい、新しい版）、要求のヘッダー

1. <Brand>-Version-Overrides に、この関数の名前の鍵があり、その値が A か B → その版
2. <Brand>-Version-Key がある
     bucket = SipHash-2-4(k_platform, script_id ‖ 0x00 ‖ key) mod 10000
     bucket < bpB → B、それ以外 → A
3. それ以外 → 乱数で bucket を作り、2 と同じ
```

- 鍵のハッシュにデプロイの ID を入れない。割合を 10% → 20% → 50% と上げても、B に割り当てられた鍵は B に残る（本家の振る舞い。2 節）。B に割り当てるのは常に bucket の小さい側。
- `<Brand>-Version-Key` と `<Brand>-Version-Overrides` は、サービスバインディングのサブリクエストでも使える。関数から見える要求には、そのまま残す（本家と同じく消さない）。
- 版の上書きの値の形は RFC 8941 の辞書（`my-worker="<version_id>"`）。形が壊れていれば黙って無視し、割合で選ぶ（本家と同じ）。いまのデプロイにない版の ID は無視する。**上書きは、いまのデプロイの中の版にしか届かない**ので、誰でも送れてもよいとする（0% の版で試す使い方のため）。
- 選んだ版は、ホームのノードの鍵（[edge-network-and-routing.md](edge-network-and-routing.md) の 9.1 節）と、呼び出しの記録（`version_id`）に入る。応答の `<Brand>-Ray` と tail で、どの版が処理したかが分かる。
- Durable Objects に相当するもの（同時に 1 つの版）は durable-objects の領域で決める。

### 4.4 ロールバック

- ロールバックは「選んだ版を 100% にする新しいデプロイ」。`reason = rollback`。
- 戻せない条件（本家と同じ。2 節）：
  - 選んだ版が `purged`（4.5 節）。
  - 選んだ版のバインディングの資源が消えている。
  - 選んだ版と、いまの版の間に Durable Objects のクラスの変更がある（durable-objects の領域で詳しく決める）。
  - 選んだ版の `secret_refs` の値が、利用者の明示の削除で消えている（8.3 節）。
- 戻す操作は、ほかのデプロイと同じ経路で配る。伝搬の SLO（p99 10 秒。設定の変更として扱う）は同じ。コードは `ready` の版なので、すでに全リージョンにある。
- ロールバックは、ストレージの中身を戻さない。CLI とダッシュボードで、この点を戻す前に示す。

### 4.5 保持

- 版は、関数ごとに直近 100 と、いまのデプロイが指す版を残す。それより古い版は `purged` にし、行のメタデータは残し（監査のため）、ノードからは消す。
- バンドルの本体は、どの版からも参照されなくなって 30 日で S3 から消す（掃除のジョブ。7.4 節）。
- ノードの LMDB には、いまのデプロイが指す版（関数ごとに 1〜2）だけを持つ。ロールバックの先の版は、ロールバックのデプロイと一緒に配る。

## 5. 変更のログ

[ADR-0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md)。

### 5.1 outbox と採番器

```sql
CREATE TABLE config_outbox (
  id           bigserial   PRIMARY KEY,     -- insertion order (not the global sequence)
  account_id   uuid,                        -- NULL for platform-wide keys
  keyspace     text        NOT NULL,        -- see 6.3
  key          bytea       NOT NULL,
  op           text        NOT NULL,        -- put | delete
  value        bytea,                       -- protobuf-encoded, NULL for delete
  priority     boolean     NOT NULL DEFAULT false,
  change_id    uuid        NOT NULL,        -- groups entries written in one transaction
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE config_log (
  epoch        integer     NOT NULL,
  seq          bigint      NOT NULL,        -- global, strictly increasing, gap-free within an epoch
  outbox_id    bigint      NOT NULL,
  account_id   uuid,
  keyspace     text        NOT NULL,
  key          bytea       NOT NULL,
  op           text        NOT NULL,
  value        bytea,
  value_crc32c integer,
  priority     boolean     NOT NULL,
  change_id    uuid        NOT NULL,
  committed_at timestamptz NOT NULL,        -- commit time of the source transaction (outbox created_at)
  sequenced_at timestamptz NOT NULL,
  PRIMARY KEY (seq)
);
-- config_outbox / config_log are platform tables (no RLS); only the control-plane writer role can insert.
```

- **制御プレーンの書き込み**：デプロイ・ルート・ホスト名・証明書・シークレット・アカウントの状態の変更は、正本の表と `config_outbox` を同じトランザクションで書く。
- **採番器（sequencer）**：東京の制御プレーンで 1 つだけ動く（Aurora の advisory lock のリースでリーダーを決める）。
  1. 100ms ごと（と、`LISTEN/NOTIFY` の知らせ）に、`config_outbox` のまだ採番していない行を `id` の順に最大 5,000 読む。
  2. 読めた順に `seq` を振り、`config_log` に書き、`config_outbox` から消す。これを 1 つのトランザクションで行う。
  3. まだコミットしていない小さい `id` の行は、後の回で、より大きい `seq` を受ける。
- **この順序で正しい理由**：同じ実体（同じ関数、同じホスト名）を変える 2 つのトランザクションは、実体の行のロックで直列になり、先のものがコミットしてから後のものが outbox に書く。よって、後のものが先に見えることはない。別の実体の、同時に走ったトランザクションの間には順序の約束が要らない。前のトランザクションのコミットの後に始まったトランザクション（版を作ってからデプロイする、など）は、必ず後の `seq` になる。
- 採番の後の番号には抜けがない。ノードは番号の抜けで取りこぼしを検知する。
- **まとめ**：配信の元は、200ms ごと、または優先の印の行が来たらすぐに、それまでの行を 1 つの束にして流す（Quicksilver の 500ms より短くする。10 秒の SLO の余裕のため）。

### 5.2 ログの束の形

```
Batch {
  db_id:      bytes16          // identifies the logical database; nodes refuse a different db_id
  epoch:      u32
  first_seq:  u64
  last_seq:   u64
  head_seq:   u64              // origin head at send time (for lag measurement)
  entries:    [Entry]
  crc32c:     u32              // over the encoded entries
}
Entry { seq: u64, keyspace: u16, key: bytes, op: PUT|DELETE, value: bytes, value_crc32c: u32,
        priority: bool, change_id: bytes16, committed_at_ms: u64 }
```

- 形は Protocol Buffers で、zstd で圧縮する。形の解析はファズの対象にする（[AGENTS.md](../../AGENTS.md)）。
- 1 つの値の上限は 1MiB。大きなもの（位置の表など）は S3 に置き、ログには場所とハッシュだけを入れる。

### 5.3 エポックと災害復旧

- Aurora は東京が主で、大阪にグローバルデータベースの副を持つ（制御プレーンの DR。infrastructure の領域）。大阪へ切り替えると、最後の数秒の書き込みを失いうる（RPO は infrastructure で決める）。その中に、すでに中継とノードへ配った `seq` がありうる。
- **切り替えの後、採番器は新しいエポック（`epoch + 1`）で始める。** 始める前に、全リージョンの中継に、持っている最大の `seq` と、失われた範囲の項目を尋ねる。
  1. 新しいエポックの最初の `seq` を、中継が持つ最大の `seq` ＋ 1 にする（番号を巻き戻さない）。
  2. 失われた範囲の項目のキーを集め、新しい正本（大阪）のいまの値で、それらのキーを書き直す項目（補正）を最初に流す。
  3. 失われた変更の持ち主（デプロイした利用者）に、変更が失われたことを知らせる。
- これで、ノードの状態は「新しい正本の、ある番号の時点の状態」に戻る。ノードの側は、エポックが上がった束を受けても、番号が続いていれば普通に適用する。

## 6. 配信

### 6.1 配信の元（origin）

- 東京の制御プレーンの VPC に 3 台（3 つの AZ）。`config_log` を読み、直近 1 時間をメモリに持ち、各リージョンの中継へ gRPC のストリームで押し出す。
- 中継は、最寄りの配信の元へつなぐ。配信の元は、束を複数の中継へ同時に送る。リージョンの間の転送は AWS のバックボーン（VPC のピアリング、または Transit Gateway。infrastructure で決める）で、mTLS。

### 6.2 リージョンの中継（relay）

| 項目 | S1 |
| --- | --- |
| 台数 | リージョンごとに 3 台（AZ ごとに 1）。東京・大阪も同じ |
| 持つもの | 直近 7 日のログ（ディスクの追記のファイル。LMDB の外。Quicksilver の断片化を避ける）、最新のスナップショットの場所、バンドルのキャッシュ（7 節） |
| 上流 | 配信の元。届かなければ、他のリージョンの中継（東京 ↔ 大阪、海外は東京） |
| 下流 | そのリージョンのノード。gRPC のサーバーのストリーム `Subscribe(db_id, from_seq)` |
| 心拍 | 1 秒ごとに、配信の元の先頭の番号（`head_seq`）と自分の先頭をノードへ送る |
| 集計 | ノードの適用の番号の報告を集め、リージョンの最小の適用の番号を配信の元へ返す（9.1 節の SLI） |
| リージョンの中だけの流れ | ノードの一覧（`region_members/`。edge-network-and-routing の 9.1 節）。変更のログに入れない |

- ノードは、同じ AZ の中継を先に使い、切れたら同じリージョンの他の中継、それも切れたら他のリージョンの中継、最後に配信の元へつなぐ。
- 中継は状態を持つが、失っても作り直せる（配信の元とスナップショットから）。

### 6.3 ノードの受け手と LMDB

- 受け手（Rust）はノードに 1 つ。**LMDB に書くのは受け手だけ。** 入口のプロキシ、スーパーバイザー、外向きのプロキシは、読み込みだけで開く（LMDB は読み込みのプロセスにもロックのファイルへの書き込みを求めるので、ロックのファイルはこれらの利用者に書ける権限にする）。
- **ランタイムのプロセスは LMDB を開かない**（3 節）。
- 受け手は、束を受けたら、番号が `applied_seq + 1` から続くことと CRC を確かめ、1 つの書き込みのトランザクションで、全項目と `meta/applied_seq` を書く。適用と番号の更新は同時に見える。
- 抜けがあれば、その束を捨て、`from_seq = applied_seq + 1` で取り直す。重複（すでに適用した番号）は捨てる。
- 読み込みのトランザクションは短く保つ（入口のプロキシは 1 要求の中で 1 回開いて閉じる）。長く開いた読み込みは、空いたページの再利用を止める（2 節）。受け手は 10 秒ごとに `mdb_reader_check` を呼び、落ちたプロセスの読み込みを片付ける。
- `mapsize` は S1 で 16GiB（データの見込み約 1GB の 16 倍。下の表）。使用が 50% を超えたら警報を出す。

**器（keyspace）**：種類は [ADR-0056](../decisions/0056-platform-config-staging-and-flags.md) の分け方（統合の工程の 2026-09-27 に、この表に種類の列と、各領域が足した器を加えた）。**利用者**＝速い経路（設定 p99 10 秒、デプロイ p99 30 秒）。**基盤**＝`scope`（リージョン・cordon・ノードの割合）を付け、段階と 2 人の承認で配る。**障害**＝障害の対応の速い経路。全体の一覧と定義した領域は [data-model.md](data-model.md) の 8 節。

| 器 | 種類 | キー | 値 | 読むもの | 優先 |
| --- | --- | --- | --- | --- | --- |
| `account_state` | 利用者 | `account_id` | 状態（`active`・`suspended`）、プラン、cordon の入力（作成日、確認の状態、専用の契約）、`quota_block`（種類と `until`）・`spend_capped`・`payment_failed`（[limits-and-billing.md](limits-and-billing.md)）、`abuse_hold`・`risk_level`（[abuse-and-trust-safety.md](abuse-and-trust-safety.md)） | スーパーバイザー、入口、ストレージの部品 | 停止・枠・信頼を下げる変更は優先 |
| `script_state` | 利用者 | `script_id` | 措置（`interstitial`・`blocked`）（abuse-and-trust-safety の 6 節） | 入口 | 優先 |
| `host`・`routes`・`routes_wild` | 利用者 | ホスト名 | [edge-network-and-routing.md](edge-network-and-routing.md) の 8.1 節 | 入口 | 停止は優先 |
| `deploy` | 利用者 | `script_id` | `{deployment_id, versions:[{version_id, bp}], script_name, account_id}` | 入口 | 通常 |
| `version` | 利用者 | `version_id` | `bundle_sha256`、互換の日付とフラグ、`bindings`、`secret_refs`、`limits`、`number`、`tag`、`created_at` | スーパーバイザー | 通常 |
| `secret` | 利用者 | `secret_value_id` | 包んだ値（8 節） | スーパーバイザー | 通常 |
| `account_key` | 利用者 | `(account_id, region)` | リージョンの鍵で包んだアカウントの鍵（8 節） | スーパーバイザー | 通常 |
| `certs_by_host`・`acme` | 利用者 | ホスト名 | 証明書と包んだ鍵、ACME のトークン | 入口 | ACME は優先 |
| `tail` | 利用者 | `script_id` | `[{session_id, filters, sampling_rate, expires_at, hub_id}]`（[developer-tooling.md](developer-tooling.md) の 7 節） | スーパーバイザー | 優先 |
| `account_egress` | 基盤（アカウントごとのキー） | `account_id` | cordon の外向きの方針の上書き（abuse-and-trust-safety の 7.1 節） | 外向き | 段階的。厳しくする上書きは段の待ち 5 分 |
| `region_key` | 基盤 | `(purpose, region, version)` | KMS で包んだリージョンの鍵（`edge-tls`・`edge-secrets`） | 入口、スーパーバイザー | 段階的（毎月の入れ替え。前の版を 2 か月残す）。漏洩の疑いの入れ替えは段の待ち 5 分 |
| `region_flags` | 障害 | リージョン | `drain` など（edge-network-and-routing の 18 節） | 入口 | `drain` は優先。同時に 2 リージョンまで |
| `egress_policy` | 基盤 | 版 | 拒否の範囲、自分たちの IP、ポート（edge-network-and-routing の 18 節） | 外向き | 段階的 |
| `geo` | 基盤 | 表の種類 | S3 の場所と SHA-256（位置・AS の表。[web-apis-and-compat.md](web-apis-and-compat.md) の 5.2 節） | 入口 | 段階的 |
| `runtime_release`・`runtime_rollout`・`platform_flags`・`cordon_policy`・`pmu_thresholds` | 基盤 | 各 | [delivery.md](delivery.md) の 5・7 節 | スーパーバイザー、受け手 | 段階的（V8 の緊急の経路は ADR-0012 の予算） |
| `region_members` | —（リージョンの中だけ。変更のログに入れない） | ノードの ID | ホームのノードの一覧（中継が心拍から作る） | 入口 | — |
| `meta` | — | `applied_seq`、`epoch`、`db_id`、`snapshot_id` | — | 全部 | — |

**S1 の大きさの見込み**（未検証。capacity で確かめる）：

| 器 | 件数 | 1 件 | 合計 |
| --- | --- | --- | --- |
| `version`（いまのデプロイの版） | 5 万関数 × 1.2 | 2KB | 約 120MB |
| `deploy` | 5 万 | 0.3KB | 約 15MB |
| `host`・`routes` | 7 万ホスト名、ルート 10 万 | 1KB | 約 170MB |
| `certs_by_host` | 3 万 | 4KB＋包み 5 つ | 約 250MB |
| `secret` | 5 万関数 × 平均 5 | 1KB | 約 250MB |
| その他 | — | — | 約 100MB |
| 合計 | | | 約 0.9GB |

### 6.4 スナップショットと新しいノードの立ち上げ

- 各リージョンの中継の 1 台（リーダー）が、1 時間ごとに自分の LMDB の写し（中継もノードと同じ受け手を持つ）を `mdb_env_copy2` の詰めた形で書き出し、`applied_seq` を付けて、そのリージョンの S3 に置く。
- 新しいノードは、最新のスナップショットを取り、SHA-256 を確かめ、`db_id` を確かめ、その `applied_seq + 1` から中継に購読する。
- 中継の 7 日のログより長く離れたノード（`from_seq` が中継の最古より古い）は、スナップショットから作り直す。
- **ノードは、中継の先頭まで追いつくまで健全にならない**（NLB に入らない）。起動の目標は 2 分以内（スナップショット 1GB の取得と展開を含む。未検証）。

## 7. コードの配布

[ADR-0023](../decisions/0023-code-and-secret-distribution.md)。

### 7.1 置き場所

- バケット：`<brand>-code-<region>`（5 つ）。キー：`bundles/sha256/<64 桁の 16 進>`。オブジェクトはバンドル全体（マニフェストとモジュール。[runtime-and-isolates.md](runtime-and-isolates.md) の 7.1 節）を zstd で圧縮したもの。
- 暗号化は SSE-KMS（リージョンの鍵）。利用者のコードは知的財産として扱う。
- エッジのノードのインスタンスロールは、そのリージョンのバケットの `bundles/` の `GetObject` だけ。一覧・書き込みは持たない。
- バケットは公開しない。バージョニングは有効にし、削除は掃除のジョブのロールだけが行う。

### 7.2 ノードへの届け方

```
ノードのスーパーバイザー（冷たい起動でバンドルがない）
 1. /var/lib/<brand>/code/<sha256> を見る → ない
 2. 同じ AZ の中継の HTTP/2（mTLS）GET /bundles/<sha256>
      中継のキャッシュ（ディスク 200GB、LRU）にあれば返す
      なければ中継がリージョンの S3 から取り、キャッシュに入れて返す（同じ鍵の同時の取得は 1 つにまとめる）
 3. 中継が全部落ちている → ノードが直接リージョンの S3 から取る
 4. リージョンの S3 にない（pending_regions）→ 東京のバケットから取る
 5. 解凍し、マニフェストとモジュールの SHA-256 を確かめ、読み込み専用で置く
```

- NFR-001 の後半（コードがノードにないとき p99 50ms）は、2 の中継のキャッシュに当たる前提の値。S3 からの取得は p99 100ms を超えうる（未検証）ので、先読みで中継のキャッシュに入れておく。

### 7.3 先読み

- デプロイの項目（`deploy/`）が中継に届いたら、中継は、新しいデプロイが指す版のバンドルをリージョンの S3 からキャッシュへ取る。
- ノードの受け手は、`deploy/` を適用したとき、その版の鍵のホームのノード（ランデブーハッシュ）が自分なら、バンドルを先に取る。
- 先読みは、デプロイの伝搬の SLI の一部にする（9.1 節）。

### 7.4 掃除

- ノード：コードのキャッシュ（gp3。ノードはローカルの NVMe を持たない。[ADR-0050](../decisions/0050-runtime-fleet-instance-types.md)）は、LMDB のどの版からも参照されず、7 日使われていないものから消す。使用が 80% を超えたら、参照されていないものを古い順に消す。
- 中継：LRU。
- S3：毎日のジョブが、どの版（`purged` を除く）からも参照されないハッシュに削除の印を付け、30 日後に消す。印の後に同じハッシュが再び参照されたら、印を外す。

## 8. シークレットとバインディング

[ADR-0023](../decisions/0023-code-and-secret-distribution.md)。鍵の階層の全体は security の領域で決める。この節は、配り方と、ノードでの扱いを決める。

### 8.1 暗号化

```
KMS のリージョンの鍵（edge-secrets。各リージョンに 1 つ）
  └─ 包む：リージョンの秘密の鍵 RSK（256 ビット、毎月入れ替え）      … region_key に KMS の暗号文で配る
       └─ 包む：アカウントの鍵 ADK（アカウントごと、256 ビット）      … account_key に RSK で包んで配る（リージョンごとに 5 つ）
            └─ 包む：シークレットの値（AES-256-GCM）                 … secret に配る
                 追加の認証データ = account_id ‖ script_id ‖ name ‖ secret_value_id
```

- 制御プレーンは、シークレットの受付の時点で ADK（制御プレーンの側の KMS で包んで Aurora に持つ）で値を暗号化する。平文は保存しない。管理 API は値を返さない（書き込みだけ）。
- ADK を各リージョンの RSK で包み直したものを `account_key` として配る。RSK の入れ替えのとき、全アカウントの ADK を包み直して配る（S1 の 1 万アカウントで約 1 万項目。帯域は小さい）。

### 8.2 ノードでの扱い

- スーパーバイザーは、起動時に `region_key/edge-secrets/<自分のリージョン>` を KMS で開く（暗号化の文脈 `purpose=edge-secrets, region=<r>` を必須にし、ノードのロールにはこの文脈の `Decrypt` だけを許す）。開いた RSK はスーパーバイザーのメモリにだけ置く。
- isolate の読み込みのとき、スーパーバイザーは `version.secret_refs` の値を `secret` から読み、`account_key` の ADK を RSK で開き、値を開く。平文を、読み込みの指示（Unix ドメインソケット）でランタイムへ渡す。平文はスーパーバイザーの一時のメモリと isolate の中にだけある。ディスク・ログ・コアダンプに出さない。
- 入口のプロキシ、外向きのプロキシは、`secret`・`account_key`・`edge-secrets` の RSK を読めない（LMDB の器ごとの読み込みの制限はないので、復号の鍵を持たないことで守る）。
- **KMS に届かないとき**：動いているスーパーバイザーはメモリの RSK で続ける。新しいノードは RSK を開けるまで健全にならない。静的な安定を、アカウントごとの KMS の呼び出しに依存させないための形（ADR-0023 の比べた案）。

### 8.3 シークレットの変更と版

- シークレットの値は変えられない行（`secret_value_id`）で持つ。値の変更は、新しい行を作り、`secret_refs` だけを差し替えた新しい版を作る（`source = secret_change`）。
- 本家と同じく、既定の操作は新しい版を作ってすぐ 100% にする（伝搬は設定の変更として p99 10 秒）。段階的なデプロイ中の関数には、版だけを作る操作を使ってもらう。
- ロールバックで古い版に戻すと、古いシークレットの値に戻る（版は変えられないので）。古い値を無効にしたいとき（鍵の漏洩）は、利用者が値を「削除」する。削除した値を参照する版には戻せない（4.4 節）。削除した値は、その値を参照するいまのデプロイがない場合にだけ消せる。
- 1 関数あたりの数と大きさは、環境変数と合わせて本家と同じ（無料 64・有料 128、1 つ 5KB）。

### 8.4 バインディングの解決の流れ

- スーパーバイザーは、読み込みの指示に `bindings` を入れる（[runtime-and-isolates.md](runtime-and-isolates.md) の 7.2 節の 3）。
- ストレージ・キュー・サービスのバインディングの呼び出しは、ランタイムから外向きのプロキシの `binding.internal` に届く。外向きのプロキシは、呼び出しの ID から版を引き、その版の `bindings` にある資源 ID だけを通す（[edge-network-and-routing.md](edge-network-and-routing.md) の 10.1 節）。ランタイムが送る資源 ID を信じない。

## 9. 伝搬の SLO と静的な安定

### 9.1 SLI と時間の予算

| SLI | 定義 | SLO（28 日） |
| --- | --- | --- |
| 設定の伝搬 | 変更（`change_id`）ごとに、`committed_at` から、健全な全ノードの適用の番号がその `seq` 以上になるまで | p99 10 秒（NFR-008） |
| デプロイの伝搬 | デプロイごとに、`committed_at` から、健全な全ノードが `deploy/` を適用し、かつ全リージョンの中継のキャッシュにそのバンドルがあるまで | p99 30 秒（NFR-008） |
| 取りこぼし | ノードが検知した番号の抜けのうち、取り直しで 60 秒以内に埋まらなかったもの | 0 件 |

- 「健全な全ノード」は、その時点で NLB に入っているノード。退避中・起動中のノードは除く（起動中のノードは追いつくまで健全にならない。6.4 節）。
- 計測：ノードは 1 秒ごとに `applied_seq` を中継へ送る。中継はリージョンの最小を配信の元へ返す。配信の元は `seq ≤ 全リージョンの最小` になった時刻を、変更ごとに記録する。

**設定の変更の時間の予算**（p99 10 秒に対する見込み。未検証。E5 で実測する）：

| 段 | 予算 |
| --- | --- |
| コミット → 採番器が読む | 0.2 秒（100ms の間隔＋通知） |
| 採番 → 配信の元の束 | 0.2 秒（まとめ） |
| 配信の元 → 5 リージョンの中継 | 0.3 秒（東京 → フランクフルトの往復 約 0.23 秒） |
| 中継 → ノード | 0.1 秒 |
| ノードの適用（LMDB の書き込みのトランザクション） | 0.1 秒 |
| 合計（通常） | 約 1 秒 |
| 余裕（取り直し、中継の切り替え、採番器のリーダーの交代） | 9 秒 |

デプロイは、上に加えて中継のバンドルの先読み（リージョンの S3 から最大 10MiB。1 秒未満の見込み）を含む。

### 9.2 古さの扱い

ノードの古さを 2 つに分ける。

| 古さ | 定義 | 振る舞い |
| --- | --- | --- |
| 局所の遅れ | 中継の先頭 − ノードの `applied_seq` が、60 秒以上続けて 0 でない | そのノードだけの故障。`/healthz` を 503 にし、NLB から外す（[edge-network-and-routing.md](edge-network-and-routing.md) の 9.3 節）。取り直し・スナップショットで回復させる |
| 全体の古さ | 中継の先頭が、配信の元（または他のリージョンの中継）から 5 分以上進まない。または配信の元の心拍が届かない | 要求は処理し続ける（静的な安定）。警報を出す。呼び出しの記録に `config_lag_ms` を付ける |

- **古い設定で応答したことを記録する**（intent の守るべき振る舞い）：すべての呼び出しの記録に、処理したノードの `applied_seq` と、中継の心拍から分かる先頭との差（`config_lag_ms`）を入れる。受けたデプロイより前の版で応答したことは、この値とデプロイの `log_seq` から後で判定できる。
- **ノードは、受けていない版を名乗らない。** `version_metadata` のバインディングと `<Brand>-Ray` の記録に入るのは、実際に動かした版の ID。
- アカウントの停止・`drain`・ACME のトークンは優先の印で配るが、ノードでは番号の順に適用する（番号の抜けを許さない）。優先は、束のまとめを待たずにすぐ送るという意味。

### 9.3 依存が止まったとき

| 止まったもの | 新しいデプロイ・設定の変更 | デプロイ済みの関数 | 備考 |
| --- | --- | --- | --- |
| 制御プレーンの API | 受け付けない | 動く | |
| Aurora（東京） | 受け付けない（DR の切り替えまで） | 動く | 切り替えの後はエポック（5.3 節） |
| 採番器・配信の元 | 届かない | 動く（全体の古さの警報） | リーダーの交代は 10 秒以内（リースの時間） |
| 1 リージョンの中継の全部 | そのリージョンは他のリージョンの中継から受ける | 動く | |
| 1 リージョンの S3 | コードの取得は中継のキャッシュ、東京のバケット | 温かい isolate とキャッシュ済みのコードは動く | |
| KMS（リージョン） | 影響なし | 動く。新しいノードは健全にならない | RSK・RDK はメモリに持つ |
| 全リージョンの中継と配信の元 | 届かない | 動く | 新しいノードは立ち上がれない（スナップショットは S3 から取れるが、先頭が分からない。先頭を確かめられないまま健全にしない） |

- 最後の行の判断：先頭が分からない新しいノードを健全にすると、古い設定のノードが増える。Auto Scaling でノードを入れ替えられない間は、既存のノードで持ちこたえる（台数の余裕は capacity で決める）。

## 10. 障害の型

| 障害 | 検知 | 振る舞い |
| --- | --- | --- |
| 採番器のリーダーが落ちた | リースの切れ | 別の制御プレーンのタスクが 10 秒以内にリースを取る。採番は `config_log` の最大の `seq` から続ける |
| 採番器の二重のリーダー（リースの誤り） | `config_log` の主キー（`seq`）の衝突 | 片方のトランザクションが失敗する。番号の重複は起きない |
| outbox の詰まり | 採番していない行の数と最古の年齢 | 30 秒で警報。まとめの大きさを上げる |
| 束の CRC・`db_id` の不一致 | 受け手 | 束を捨て、取り直す。3 回続けば別の中継へ。`db_id` の不一致は重大（取り違え）として当番を呼ぶ |
| ノードの LMDB の破損・`mapsize` の不足 | 開けない、書き込みの失敗 | ノードを 503 にし、スナップショットから作り直す |
| 長く開いた読み込みでの肥大 | LMDB の大きさと、最古の読み込みの年齢 | 10 秒ごとの `mdb_reader_check`。30 秒を超える読み込みを持つプロセスを警報 |
| 版のバンドルが 1 リージョンに置けない | `pending_regions` | そのリージョンは東京から取る。1 時間続けば当番 |
| 冷たいノードがコードを取れない | 取得の失敗 | その要求は 503 相当（[runtime-and-isolates.md](runtime-and-isolates.md) の 9 節） |
| Aurora の DR の切り替え | 運用の判断 | 新しいエポック、補正の項目、失われた変更の通知（5.3 節） |
| デプロイの伝搬の SLO の逸脱 | 9.1 節の SLI | 遅いリージョン・ノードを特定し、局所の遅れならノードを外す |
| 悪いデプロイ（利用者のコードの誤り） | 利用者の指標 | 利用者がロールバック（p99 10 秒）。基盤は自動で戻さない |

## 11. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| 配信の経路での改ざん・なりすまし | 配信の元・中継・ノードの間は mTLS（内部の CA）。束に CRC と `db_id`。中継・ノードは配信の元の証明書だけを上流として受ける |
| 別のテナントのコードの取り違え | バンドルは内容のハッシュで取り、ノードで SHA-256 を確かめる。版の `bundle_sha256` は Aurora の正本から来る |
| バンドルの S3 の書き換え | 書き込みは制御プレーンの 1 つのロールだけ。ノードは読み込みだけ。`If-None-Match: *` で上書きしない |
| シークレットの平文の漏れ | 平文はスーパーバイザーの一時のメモリと isolate の中だけ。管理 API は値を返さない。ログに出さない（lint で `secret` の値の型をログへ渡すことを禁じる） |
| ノードの侵害 | ノードは、そのリージョンの全アカウントのシークレットを開ける（どのノードもどの関数も動かすので、この前提は避けられない）。被害を、ノードのロールの最小の権限（KMS の `Decrypt` は暗号化の文脈つきだけ、S3 は読み込みだけ）と、エッジのフリートの別のアカウント（ADR-0010）で限る |
| 版の上書きのヘッダーの悪用 | いまのデプロイの版にだけ届く。0% の版に未公開の機能を置く使い方の危険を、文書で示す |
| 制御プレーンの誤った一括の変更 | 1 つの変更（`change_id`）が 1 万項目を超えるものは、採番器が保留にし、運用者の承認を求める（全ホスト名の削除などの事故を防ぐ）。アカウントの停止の一括は除く |

- この領域の変更（採番器、配信、受け手、シークレットの扱い）は `security:sensitive` にする。
- 監査のログ：デプロイ・ロールバック・シークレットの変更は、誰が・いつ・どこから（`source`）を残す（security の領域の監査ログへ）。

## 12. テスト

| 種類 | 対象 | 内容 |
| --- | --- | --- |
| 性質ベース | 配信の正しさ（ADR-0004） | 任意の変更の列と、任意の束の遅れ・重複・並べ替え・中継の切り替えに対し、ノードの最終の状態が、正本の同じ番号の時点の状態と等しい |
| 性質ベース | 採番の順序 | 任意の同時のトランザクションの列（同じ実体を含む）で、同じ実体の変更の `seq` の順が、コミットの順と同じ |
| 性質ベース | エポック | 任意の失われた範囲で、補正の後のノードの状態が、新しい正本の状態と等しく、番号が減らない |
| 性質ベース | 版の鍵 | 任意の鍵と、B の割合の増える列で、一度 B に割り当てられた鍵は A に戻らない。割合 p のとき、鍵の分布の B の割合が p に近い（統計の検定） |
| 表駆動 | 版の選び方 | 上書き（正しい・壊れた・デプロイにない版）、鍵あり・なし、1 版・2 版 |
| 表駆動 | ロールバックの可否 | 4.4 節の各条件 |
| 結合 | 静的な安定 | 配信の元・採番器・Aurora・KMS・S3 をそれぞれ止め、デプロイ済みの関数が応答し続ける。`/healthz` が全体の古さで 503 にならない |
| 結合 | 局所の遅れ | 1 ノードの受け手を止めると、60 秒で 503 になり NLB から外れる |
| 結合 | シークレット | 平文がディスク・ログ・コアダンプに出ない。入口のプロキシのプロセスから `edge-secrets` の RSK を開けない |
| ファズ | 束の形、スナップショットの読み込み | cargo-fuzz |
| 障害の注入 | 中継・配信の元・リージョンの間の網 | 取りこぼしがなく、番号の順に適用される（ADR-0004 の Confirmation） |
| 負荷 | 伝搬 | 毎秒 100 の変更を 1 時間流し、p99 の伝搬が 10 秒以内（S1 の書き込みの見込みの 10 倍以上） |
| 本番の探り | 伝搬の SLI | 1 分ごとに合成の関数へデプロイし、全リージョンで新しい版が応答するまでの時間を測る |

テスト名には要件 ID（開発リポジトリの `REQ-DEPLOY-*`・`PROP-DEPLOY-*`）を含める。

## 13. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0021](../decisions/0021-versions-deployments-and-gradual-rollout.md) | 版は変えられない（コード、互換の設定、解決したバインディング、シークレットの値の参照）。デプロイは 1〜2 の版と万分率。版の鍵は `script_id` と鍵のハッシュで決定的に振り分け、新しい版を小さい側に置く。上書きのヘッダーはいまのデプロイの版だけ。ロールバックは新しいデプロイ。版は直近 100 を残す |
| [0022](../decisions/0022-sequenced-change-log-relays-and-lmdb.md) | outbox を 1 つの採番器が (エポック, 番号) で採番する。配信の元 → リージョンの中継（3 台、7 日）→ ノードの受け手（LMDB の唯一の書き手）。ランタイムは LMDB を開かない。スナップショットで立ち上げる。局所の遅れだけで不健全にし、全体の古さでは止めない。DR の切り替えは新しいエポックと補正 |
| [0023](../decisions/0023-code-and-secret-distribution.md) | バンドルは版の `ready` の前に全リージョンの S3 へ同期で置き、中継のキャッシュと先読みで届ける。シークレットはアカウントの鍵で暗号化し、その鍵をリージョンの鍵（KMS で包む）で包んで配る。ノードはリージョンの鍵を起動時に 1 回開く |

## 14. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | 各リージョンの `<brand>-code-<region>` バケット、KMS の鍵（`edge-secrets`・`edge-tls`）、中継のインスタンス（infrastructure と合わせて） |
| E5 | `scripts`・`script_versions`・`deployments` の表と RLS、版の作成の API（検証のフリートの呼び出しを含む） |
| E5 | バンドルの 5 リージョンへの同期の PUT と `pending_regions` の再試行 |
| E5 | `config_outbox` と採番器（リース、`LISTEN/NOTIFY`、一括の変更の保留） |
| E5 | 配信の元（gRPC のストリーム、直近 1 時間のメモリ） |
| E5 | リージョンの中継（7 日のログ、心拍、集計、バンドルのキャッシュと先読み） |
| E5 | ノードの受け手（番号の検査、取り直し、LMDB の書き込み、`mdb_reader_check`） |
| E5 | スナップショットの作成と、新しいノードの立ち上げ |
| E5 | デプロイと段階的なデプロイ（万分率、版の鍵、上書きのヘッダー）、入口のプロキシでの版の選び方 |
| E5 | ロールバックと、戻せない条件の検査 |
| E5 | 版の保持（直近 100）と、バンドルの掃除のジョブ |
| E5 | 伝搬の SLI の計測（適用の番号の報告と集計）とダッシュボード |
| E5 | 性質ベーステスト（配信の正しさ、採番の順序、エポック）と障害の注入 |
| E5 | 確認：S1 の変更の量と伝搬の時間の実測（着手の中ごろ） |
| E3 | シークレットの暗号化（ADK・RSK）とスーパーバイザーでの復号、平文の漏れのテスト（security と合わせて） |
| E6 | CLI の `deploy`・`versions upload`・`versions deploy`・`rollback`・`secret put`（developer-tooling と合わせて） |
| E1 | 制御プレーンの DR の切り替えの訓練に、エポックと補正を含める（infrastructure と合わせて） |

## 15. 未解決の問い

- S1 の実際の変更の量（1 日あたりの項目の数）と、全体で 1 本の番号の採番器が詰まる点。
- ノードの LMDB の大きさの実測と、S2・S3 でいつ v1.5 の形（全データを持つレプリカと、使うものだけを持つノード）へ移るか。
- 起動の直後のノードが先頭まで追いつく時間（スナップショットの大きさ）と、Auto Scaling の速さの釣り合い。
- 版の上書きのヘッダーを、関数ごとに切れるようにするか（0% の版を外から見られたくない利用者）。
- ロールバックで古いシークレットの値に戻ることを、利用者がどう受け止めるか（本家と同じにしたが、事故の元になりうる）。
- Aurora の DR の切り替えで失う範囲（RPO）と、失われた変更の利用者への伝え方。
- 変更のログの形（Protocol Buffers）の版の上げ方（ノードと中継が混ざる間の互換）。
- シークレットを開く鍵を、ノードの間でどこまで分けられるか（ノードの侵害の影響の範囲）。

### 決定

2026-09-27 の既定案。

- 採番器は 1 本で始める。E5 の負荷試験で毎秒 100 の変更を 10 秒以内に配れることを確かめる。詰まったら、器ごとの番号に分ける前に、束の大きさとまとめの間隔を見直す（ADR-0004 の引き受けたコスト）。
- S1・S2 は全ノードに全データ。ノードの LMDB が 10GB を超える見込みになったら、S3 の前に v1.5 の形の ADR を起こす。
- 新しいノードの立ち上げの目標は 2 分。超えるなら、スナップショットを器ごとに分ける。
- 版の上書きは S1 で常に有効（本家と同じ）。関数ごとの無効化は、要望を見て S2 で足す。
- ロールバックでシークレットが戻る振る舞いは本家と同じにする。CLI とダッシュボードで、戻す前に「シークレットの値も戻る」ことを示す。
- DR の切り替えの RPO は infrastructure で決める。失われた変更は、監査のログから利用者ごとに一覧にし、メールで知らせる。
- 形の版は、フィールドの追加だけを許す（Protocol Buffers の互換の規則）。削除・意味の変更は、新しい器を作って移す。
- シークレットの鍵はリージョンの単位で始める（どのノードもどの関数も動かすので、ノードの単位で分けても効果が小さい）。専用の cordon（`c3-dedicated`）の専用のノードでは、S2 でアカウントの単位の鍵を検討する。

## 16. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：配信の取りこぼし・順序の誤りで、ノードが正本と違う状態になる（誤ったルート・停止の抜け）。配信の正しさ・採番の順序・エポックの性質ベーステストと、障害の注入。
- リスク：静的な安定の破れ（制御プレーンの停止で全ノードが止まる）。依存ごとに止める結合テストと、`/healthz` の条件のレビュー。
- リスク：シークレットの平文の漏れ。ディスク・ログ・コアダンプの検査。
- リスク：伝搬の SLO の逸脱。本番の探り（1 分ごとの合成のデプロイ）と負荷試験。
- 本番での検証：伝搬の SLI（設定・デプロイ）、局所の遅れのノードの数、全体の古さの時間、`pending_regions` の数。

**runbooks**

- `config-propagation-slow`：伝搬の SLO の逸脱。遅いリージョン・ノードの特定、中継の切り替え、ノードの外し方。
- `config-origin-down`：採番器・配信の元の停止。リースの確認、手動のリーダーの交代。デプロイ済みの関数が動いていることの確認。
- `relay-rebuild`：中継の作り直し（スナップショットと配信の元から）。
- `node-lmdb-rebuild`：ノードの LMDB の破損・`mapsize` の不足。スナップショットからの作り直し。
- `control-plane-dr-epoch`：Aurora の DR の切り替えの後のエポックと補正、失われた変更の一覧と通知。
- `bulk-change-approval`：一括の変更の保留の確認と承認。
- `bundle-region-pending`：`pending_regions` が 1 時間続く。
- SLI の追加の依頼（Ops へ）：設定の伝搬とデプロイの伝搬（p50・p99）、取りこぼしの数、局所の遅れのノードの数、全体の古さ、採番していない outbox の数と最古の年齢、LMDB の使用率、中継のキャッシュの当たりの率、コードの取得の遅延（p99）。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `scripts`（制御プレーン） | 4.1 節 | RLS |
| `script_versions`（制御プレーン） | 4.1 節。[runtime-and-isolates.md](runtime-and-isolates.md) の 15 節の列（`compatibility_date`、`bundle_sha256` など）を含む。`pending_regions` を足す | RLS。表の持ち主はこの領域 |
| `deployments`（制御プレーン） | 4.1 節 | RLS |
| `secret_values`（制御プレーン） | `account_id`、`script_id`、`id`、`name`、`ciphertext`、`nonce`、`adk_version`、`created_at`、`deleted_at` | RLS。値の平文を持たない |
| `account_data_keys`（制御プレーン） | `account_id`、`version`、`kms_ciphertext`、`created_at`、`retired_at` | RLS。ADK は制御プレーンの KMS で包む |
| `region_keys`（制御プレーン） | `purpose`（`edge-secrets`・`edge-tls`）、`region`、`version`、`kms_ciphertext`、`created_at`、`retire_after` | テナントの表ではない |
| `config_outbox`・`config_log`（制御プレーン） | 5.1 節 | テナントの表ではない。`config_log` は 7 日分を持ち、それより古いものは S3 へ書き出す |
| `config_epochs`（制御プレーン） | `epoch`、`started_at`、`first_seq`、`reason`、`lost_range`、`reconcile_change_id` | DR の記録 |
| `propagation_events`（計測） | `change_id`、`seq`、`kind`（`config`・`deploy`）、`committed_at`、`region_applied_at`（リージョン → 時刻）、`all_applied_at` | SLI の元 |
| 中継のログ（中継のディスク） | 束の追記のファイル（7 日） | 作り直せる |
| スナップショット（リージョンの S3） | `snapshots/<db_id>/<applied_seq>.lmdb.zst`、SHA-256 | 1 時間ごと、直近 48 を残す |
| バンドル（リージョンの S3） | `bundles/sha256/<hex>` | 内容のハッシュ。30 日の削除の印 |
| ノードの LMDB | 6.3 節の器 | ノードの中だけ |
| 呼び出しの記録に足す欄（observability・limits-and-billing） | `config_applied_seq`、`config_lag_ms`、`deployment_id`、`version_id` | 古い設定での応答の判定に使う |

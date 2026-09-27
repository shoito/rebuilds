# KV Store: Cloudflare Workers

結果整合のキー・値の保存（本家の Workers KV に相当するもの）の設計。API と制限、中央の正本、リージョンとノードのキャッシュ、TTL と負のキャッシュ、同じキーへの書き込みの制限、一貫性の試験を決める。

| 関連 | 決定 |
| --- | --- |
| [ADR-0004](../decisions/0004-config-and-code-distribution.md) | 設定とコードは変更のログとノードの LMDB で配る（バインディングの設定はこの経路で届く） |
| [ADR-0005](../decisions/0005-storage-consistency.md) | KV は結果整合。TTL が既定の 60 秒のとき、全リージョンで読めるまで p99 70 秒以内 |
| [ADR-0010](../decisions/0010-process-sandbox-and-egress-invariants.md) | バインディングの呼び出しは外向きのプロキシの別の口を通り、isolate の鍵で許可を決める |
| [ADR-0024](../decisions/0024-kv-central-store-dynamodb.md) | 正本は東京の DynamoDB。4 KiB を超える値は S3。同じキーの書き込みは条件付きの書き込みで 1 秒に 1 回 |
| [ADR-0025](../decisions/0025-kv-two-tier-cache-and-staleness.md) | 読み込みはノードとリージョンの 2 段のキャッシュ。古さは正本から取った時刻で数え、負の結果もキャッシュする |

関数のランタイムは [runtime-and-isolates.md](runtime-and-isolates.md)、外向きのプロキシの約束は [sandbox-and-security.md](sandbox-and-security.md) の 7 節にある。制限の値の最終の決定と課金は [limits-and-billing.md](limits-and-billing.md)、CLI と REST API の窓口は [developer-tooling.md](developer-tooling.md) と [dashboard-and-api.md](dashboard-and-api.md) にある。

本家の振る舞い・数値は、2026-09-27 に本家の文書とブログ、AWS の文書で確かめた。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| KV のバインディングの API（`get`・`getWithMetadata`・`put`・`delete`・`list`）と制限 | 管理の REST API と CLI の窓口の形（dashboard-and-api、developer-tooling） |
| 名前空間とキーの保存（中央の正本） | 料金の値、無料の枠の数え方（limits-and-billing） |
| リージョンとノードのキャッシュ、`cacheTtl`、負のキャッシュ | 外向きのプロキシの実装（edge-network-and-routing） |
| 同じキーへの書き込みの制限、有効期限（expiration） | ローカル開発での模擬の KV（developer-tooling） |
| 一貫性の計測と試験 | 海外のリージョンへの正本の読み込みの複製（S2。この文書では方針だけ） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典（すべて 2026-09-27 に確認） |
| --- | --- | --- |
| 構成 | 少数の中央のデータセンターに保存し、読まれた拠点でキャッシュする。冷たい読み込みは、リージョンの層を経て中央へ行く | [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/) |
| 一貫性 | 結果整合。書いた拠点では多くの場合すぐ見えるが、他の拠点では 60 秒以上かかりうる。最近読まれた拠点ほど遅れる。存在しないキーの結果（負の結果）も同じ遅れでキャッシュする | 同上 |
| `cacheTtl` | 既定 60 秒、最小 30 秒 | [Read key-value pairs](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)、[Limits](https://developers.cloudflare.com/kv/platform/limits/) |
| 大きさ | キー 512 バイト、メタデータ 1,024 バイト、値 25 MiB | [Limits](https://developers.cloudflare.com/kv/platform/limits/) |
| 書き込みの制限 | 同じキーへは 1 秒に 1 回。超えると 429。同時の書き込みは最後の書き込みが勝つ | [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)、[Limits](https://developers.cloudflare.com/kv/platform/limits/) |
| 有効期限 | `expiration`（エポック秒）か `expirationTtl`（今からの秒。最小 60 秒） | [Write key-value pairs](https://developers.cloudflare.com/kv/api/write-key-value-pairs/) |
| 一括 | 読み込みはバインディングで 100 キーまで（1 操作として数える）。書き込みの一括は REST API だけで、1 回に 10,000 組・100MB まで | [Read](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)、[Write](https://developers.cloudflare.com/kv/api/write-key-value-pairs/) |
| 一覧 | `prefix`・`limit`（既定・最大 1,000）・`cursor`。UTF-8 のバイトの辞書順。期限切れ・削除済みのキーを飛ばすので、`keys` が空でも続きがありうる。`list_complete` で判定する | [List keys](https://developers.cloudflare.com/kv/api/list-keys/) |
| その他の制限 | 1 呼び出しあたり 1,000 操作、アカウントあたり 1,000 名前空間、名前空間あたりのキーの数は無制限 | [Limits](https://developers.cloudflare.com/kv/platform/limits/) |
| 速さ | ローカルのキャッシュ、リージョンの層（ミスの約 30% を解決）、中央の 3 段。最も読まれるキー（全キーの 0.03%）はメモリで 1ms 未満。KV の Worker の p90 は 22ms から 12ms に | [We made Workers KV up to 3x faster](https://blog.cloudflare.com/faster-workers-kv/)（2024-09-26） |
| 中央の保存 | 2 つの外部のクラウドから、自前の分散 DB（3 重の複製）と R2（1KB を超える値）の組み合わせへ移した。書き込みは両方へ競争で送り、先に確認した方で成功を返す。食い違いは非同期に直す | [Redesigning Workers KV for increased availability](https://blog.cloudflare.com/rearchitecting-workers-kv-for-redundancy/)（2025-08-08） |
| 料金 | 有料：読み込み 100 万あたり 0.50 ドル、書き込み・削除・一覧 100 万あたり 5.00 ドル、保存 1GB-月あたり 0.50 ドル。外向きの転送は課金しない。存在しないキーの読み込みも課金する | [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/) |

## 3. 原則

- **書き込みは、正本に確定してから成功を返す**（ADR-0005）。キャッシュだけに書いて成功を返さない。
- **古さの上限は、キャッシュの段の数によらず `cacheTtl` で決まる。** ノードとリージョンの 2 段で TTL を足し合わせない（6 節）。
- **キャッシュは新しい版を古い版で上書きしない。** 同じノード・同じリージョンの中では、読み込みの版が戻らない。
- **要求の処理の経路で制御プレーンを呼ばない**（ADR-0004）。バインディングの名前から名前空間への対応は、ノードの設定の写しから読む。
- **名前空間は、isolate から届いた識別子で決めない。** 外向きのプロキシが isolate の鍵から許されたバインディングを引き、名前空間の ID を付ける（ADR-0010）。

## 4. API と制限

### 4.1 バインディングの API

本家と同じ形にする（Web の API の互換の範囲。`env.<BINDING>` の名前は利用者が決める）。

| メソッド | 振る舞い | 数え方 |
| --- | --- | --- |
| `get(key, {type, cacheTtl})` | 値を返す。ない・期限切れなら `null`。`type` は `text`（既定）・`json`・`arrayBuffer`・`stream` | 読み込み 1 |
| `get([keys], …)` | 最大 100 キー。`Map` で返す | 読み込みはキーの数。呼び出しの操作の数は 1 |
| `getWithMetadata(key, …)` | `{value, metadata, cacheStatus}` | 読み込み 1 |
| `put(key, value, {expiration, expirationTtl, metadata})` | 正本に確定してから解決する。同じキーの 1 秒以内の 2 回目は 429 相当の例外 | 書き込み 1 |
| `delete(key)` | 正本に削除の印（墓石）を確定してから解決する | 削除 1 |
| `list({prefix, limit, cursor})` | `{keys:[{name, expiration, metadata}], list_complete, cursor}`。UTF-8 のバイトの辞書順 | 一覧 1 |

- `cacheStatus` は本家にある欄で、キャッシュの当たり・外れを返す。未検証の細部（値の種類）は本家の型定義に合わせる。
- 一括の書き込み・削除は REST API だけ（1 回に 10,000 組、100MiB まで）。中では 1 キーずつの条件付きの書き込みに分ける（5.3 節）。

### 4.2 制限（S1 の既定。値は limits-and-billing で決める）

| 項目 | 値 | 本家との差 |
| --- | --- | --- |
| キーの長さ | 512 バイト（空、`.`、`..` は不可） | 同じ |
| 値の大きさ | 25 MiB | 同じ |
| メタデータ | JSON にして 1,024 バイト | 同じ |
| `cacheTtl` | 既定 60 秒、最小 30 秒、最大 1 年 | 最大値は本家の文書に見当たらない（未検証）。1 年にする |
| `expirationTtl` | 最小 60 秒 | 同じ |
| 同じキーへの書き込み | 1 秒に 1 回 | 同じ。ただし同時の 2 つは「先に確定した方が勝ち、後は 429」（5.3 節） |
| 1 呼び出しあたりの操作 | 1,000 | 同じ |
| 名前空間 | アカウントあたり 1,000 | 同じ |
| 一覧の `limit` | 既定・最大 1,000 | 同じ |
| 無料の計画 | 1 日に読み込み 10 万、書き込み・削除・一覧 各 1,000、保存 1GiB | 同じ構造（値は limits-and-billing） |

## 5. 中央の正本

[ADR-0024](../decisions/0024-kv-central-store-dynamodb.md)。

### 5.1 置き場所

| 置くもの | 置き場所 |
| --- | --- |
| キーの項目（キー、版、有効期限、メタデータ、4 KiB 以下の値） | 東京の DynamoDB の表 `kv_entries`（オンデマンドの容量、PITR を有効） |
| 4 KiB を超える値の本体 | 東京の S3 のバケット `<brand>-kv-values-apne1`。キーは `{namespace_id}/{key_hash}/{version}` |
| 名前空間の定義（名前、アカウント） | 制御プレーンの Aurora の `kv_namespaces`（RLS）。ノードへは ADR-0004 の配信で届く |
| 災害の復旧の写し | DynamoDB のグローバルテーブルの大阪の複製と、S3 の大阪への複製（S3 CRR）。S1 では大阪の複製から読み書きしない |

**4 KiB の境目の理由**：DynamoDB の書き込みは 1KB ごとに 1 単位（[Constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)）で、東京は 100 万単位あたり 0.715 ドル。S3 の PUT は 100 万あたり 4.7 ドル（AWS の価格表、2026-09-26 の公開分、2026-09-27 に確認）。4 KiB 以下なら DynamoDB に入れた方が安く、読み込みも 1 往復で済む。項目の上限（400 KB）より十分小さい。

### 5.2 項目の形

```
表 kv_entries（東京）
  pk          Binary   = namespace_id (16B) || shard (1B)       -- shard = xxhash64(key) mod 16
  sk          Binary   = key の UTF-8 のバイト（1〜512B）         -- 一覧の順は UTF-8 のバイトの辞書順
  account_id  String                                            -- 監査と誤りの検知のため（RLS はない）
  version     Number   = commit_ms * 2^16 + writer_seq          -- 単調に増える。キャッシュの比較に使う
  last_write_ms Number                                          -- 1 秒に 1 回の制限に使う
  kind        String   = "inline" | "s3" | "tombstone"
  value       Binary   （kind=inline のとき。4 KiB 以下）
  value_ref   String   （kind=s3 のとき。S3 のキー）
  value_size  Number
  metadata    Binary   （1,024B 以下の JSON）
  expires_at  Number   （エポック秒。なければ欠く）
  ttl         Number   （DynamoDB の TTL の属性。expires_at か、墓石は削除の 1 日後）
```

- **1 つの名前空間を 16 の区画に分ける。** DynamoDB の区画は 1 秒に読み込み 3,000 単位・書き込み 1,000 単位が上限（[Partition key design](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html)、2026-09-27 に確認）。LSI のない表では、同じ `pk` の項目の集まりも必要に応じて複数の区画に自動で分けられる（[Partitions and data distribution](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html)、同日に確認）。ただし分けるまでの時間と、その間のスロットリングの程度は未検証なので、書き込みの集中を最初から 16 の `pk` に散らす。
- 区画の数は名前空間の作成時に決め、S1 では 16 で固定する。変える方法は 13 節の問い。
- 期限切れの項目は、DynamoDB の TTL が後で消す。消すまでの遅れがあるので、読み込みと一覧は `expires_at` で必ず除く。

### 5.3 書き込みの流れ

```
関数 ──put──▶ 外向きのプロキシ（ノード）
                 │ isolate の鍵 → バインディング → namespace_id を付ける
                 ▼
             KV のゲートウェイ（そのリージョン。Rust）
                 │ 大きさ・キー・メタデータを検証
                 ▼ リージョンの間の私的な経路
             KV の書き込みサービス（東京）
                 │ 1) 値が 4 KiB を超えるなら、S3 へ {ns}/{key_hash}/{version} を PUT
                 │ 2) DynamoDB へ条件付きの PutItem
                 │      条件：attribute_not_exists(pk)
                 │            OR last_write_ms <= :now_ms - 1000
                 │    失敗 → 429（KV_WRITE_RATE_LIMITED）。1) の S3 のオブジェクトは掃除の対象
                 │ 3) 成功 → {version, commit_ms} を返す
                 ▼
             KV のゲートウェイ（書いたリージョン）
                 │ リージョンのキャッシュ（L2）を新しい版で上書き（fetched_at = commit_ms）
                 ▼
             外向きのプロキシ：そのノードのキャッシュ（L1）を上書き → put が解決する
```

- **1 秒に 1 回の制限は、正本の条件で強制する。** リージョンやノードの数によらず守れる。時刻は東京の書き込みサービスの時計（Amazon Time Sync）で取る。
- 同時の 2 つの書き込みは、先に確定した方が勝ち、後は 429 になる。本家の「最後の書き込みが勝つ」とは違うが、利用者は 429 を受けて再試行するので、最後に再試行した値が残る。黙って値が消えることはない。
- 削除は `kind=tombstone` の書き込みにする（同じ制限を受ける）。墓石は負のキャッシュの元になり、1 日後に TTL で消える。
- 上書き・削除で要らなくなった S3 の本体は、DynamoDB Streams の古い像から掃除のキューへ送り、24 時間後に消す（読み込みの途中の要求を壊さないため）。
- 一括の書き込み（REST API）は、条件を付けられる 1 件ずつの `PutItem` を並列に送る（`BatchWriteItem` は条件を付けられないため。[Constraints](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html)）。

### 5.4 一覧

- 16 の区画に並列に `Query` を送り、結果を併合して辞書順に並べ、`limit` 件で切る。
- 条件は `pk = :p AND sk BETWEEN :start AND :end`。`:start` は `max(prefix, cursor の次)`、`:end` は `prefix` に 0xFF を 512 バイトまで足したもの。
- 墓石と期限切れの項目は `FilterExpression` で除く。除いた結果、`keys` が空でも `list_complete=false` のことがある（本家と同じ）。
- `cursor` は `{namespace_id, prefix, last_key}` を AES-GCM で暗号化した不透明な文字列。別の名前空間・別の接頭辞で使うと拒否する。
- 一覧はキャッシュしない（S1）。常に東京の正本を読む。遠いリージョンから遅いことは 13 節の問い。

### 5.5 耐久性と復旧

- 成功を返した書き込みは、DynamoDB（東京の 3 つの AZ）と、値が大きいときは S3 に確定している。
- DynamoDB の PITR（35 日）と、S3 のバージョニング（上書き・削除から 7 日で古い版を消す）で、運用の誤りから戻せる。
- 東京の全体の障害：書き込みは止まる。読み込みは、各リージョンのキャッシュにある分だけ返せる（`cacheTtl` を過ぎても返す「古くても返す」の段。6.4 節）。大阪への切り替えは手動（runbooks の `kv-region-failover`）。RPO はグローバルテーブルの複製の遅れ（通常は秒の単位。保証の値は未検証）。

## 6. キャッシュ

[ADR-0025](../decisions/0025-kv-two-tier-cache-and-staleness.md)。

### 6.1 段

| 段 | 置き場所 | 大きさ | 役割 |
| --- | --- | --- | --- |
| L1 | 各ノードの外向きのプロキシのメモリ | ノードあたり 1 GiB（値が 1 MiB を超えるものは置かない） | 最も読まれるキーを 1ms 未満で返す |
| L2 | 各リージョンの ElastiCache for Valkey（クラスタのモード、シャードごとに複製 1） | リージョンの需要で決める（capacity） | リージョンの中のノードで共有する。25 MiB までの値を置く |
| 正本 | 東京の DynamoDB と S3 | — | 強い読み込み（`ConsistentRead`）で返す |

- 東京のリージョンも同じ 2 段を持つ。
- L2 のキーは `kv:{namespace_id}:{key}`。値は `{version, fetched_at_ms, expires_at, metadata, value | absent}`。

### 6.2 古さの数え方

- 各項目は、**正本から取った時刻 `fetched_at`** を持つ。L2 から L1 に写すときも、`fetched_at` を引き継ぐ（写した時刻にしない）。
- 読み込みは、`now - fetched_at < cacheTtl` のときだけキャッシュから返す。超えていたら、次の段へ取りに行く。
- こうすると、2 段を経ても古さは `cacheTtl` を超えない。段ごとに TTL を持つと、最悪で 2 倍（120 秒）になる。
- 読み込みごとに `cacheTtl` が違ってよい。キャッシュに置く時間は、そのキーで見た最大の `cacheTtl`（上限 1 年）にする。
- `expires_at` を過ぎた項目は、`cacheTtl` によらず「ない」として扱う。

**NFR-009 の見込み**：他のリージョンで書いた値が見えるまでの時間は、`cacheTtl`（60 秒）＋ L2 から正本への取り直しの時間（東京から遠いリージョンで 100〜300ms。未検証）＋ 時計のずれ。p99 70 秒以内に収まる見込み。8 節の計測で確かめる。

### 6.3 負のキャッシュ

- 正本にない・墓石・期限切れのキーは、`absent` として同じ規則でキャッシュする（本家と同じ）。
- 新しく作ったキーは、そのキーを最近「ない」と読んだリージョンでは、最大 `cacheTtl` の間見えない。文書と CLI の警告で示す。
- 書いたリージョンでは、書き込みの時点で L2 と、書いたノードの L1 を上書きするので、すぐ見える。同じリージョンの他のノードの L1 は、`cacheTtl` まで古い値（または `absent`）を返しうる。

### 6.4 先読みと古くても返す段

- **先読み**：L2 の項目の年齢が `cacheTtl` の半分を超え、そこに読み込みが来たら、キャッシュの値を返しつつ、裏で正本から取り直す（1 キーに 1 本だけ）。よく読まれるキーは、冷たい経路をほとんど通らない。
- **同時のミスの集約**：同じキーの L2 のミスは、ゲートウェイの中で 1 本の正本への読み込みにまとめる。
- **古くても返す段**：正本への取り直しが失敗・時間切れ（2 秒）のとき、`cacheTtl` を過ぎた L2 の値を返し、`cacheStatus` に古いことを示す。正本の障害で読み込みを止めない（NFR-004 の読み込み 99.99%）。古さの上限は守れなくなるので、この段に入った回数を指標にし、警報を出す。

### 6.5 版の比較

- キャッシュに書くときは、手元の版より新しいときだけ上書きする（L1・L2 とも）。L2 は Valkey のスクリプトで比較と書き込みを 1 つにする。
- これで、同じノード・同じリージョンの中では、読み込みの版が戻らない。本家は約束していない性質なので、利用者には約束せず、内部の不変条件として試験する（10 節）。

## 7. 障害の型

| 障害 | 検知 | 振る舞い |
| --- | --- | --- |
| 東京の DynamoDB の遅延・スロットリング | 書き込みサービスの遅延と `ProvisionedThroughputExceeded` | 書き込みは 503 相当で失敗し、利用者の再試行に任せる。読み込みは古くても返す段 |
| 1 つの名前空間の書き込みの集中 | 区画ごとの消費の指標（Contributor Insights） | 区画の数の見直し（13 節）。アカウントの書き込みの制限（limits-and-billing） |
| L2（Valkey）のシャードの障害 | ElastiCache の健全性 | 複製へ切り替わる。切り替えの間は L1 と正本で返す（遅くなる） |
| リージョンの間の経路の障害 | ゲートウェイから東京への失敗の率 | 書き込みは失敗する。読み込みは古くても返す段 |
| 東京の全体の障害 | 合成監視 | 書き込み停止。runbooks の `kv-region-failover` で大阪へ手動で切り替える |
| S3 の本体がない（掃除の誤り、複製の遅れ） | 読み込みで `NoSuchKey` | 500 相当。重大な事象として調べる（耐久性の違反の疑い） |
| 時計のずれ（書き込みサービス） | Time Sync の指標 | 1 秒に 1 回の判定がずれる。ずれが 100ms を超えたらそのインスタンスを外す |
| 古くても返す段が続く | その段に入った回数 | NFR-009 を守れていない。警報 |

## 8. 一貫性の計測

- **合成の書き込み**：各リージョンに合成の名前空間を 1 つずつ持ち、10 秒ごとに `probe/{region}` に時刻と連番を書く。
- **合成の読み込み**：各リージョンの複数のノードの合成の関数が、1 秒ごとに全リージョンの `probe/*` を `cacheTtl=60` で読む。
- 「書き込みの確定の時刻」から「そのノードで新しい連番が見えた時刻」までを、リージョンの組ごとに p50・p99・最大で出す。NFR-009 の SLI にする（observability と合わせる）。
- 連番が戻ったら（同じノードで古い版を読んだら）、6.5 節の不変条件の違反として警報を出す。

## 9. セキュリティ（テナントの分離）

- 名前空間は、外向きのプロキシが isolate の鍵（アカウント・関数・版）とバインディングの設定から決める。isolate から届く名前空間の ID は使わない（ADR-0010）。
- DynamoDB の `pk` の先頭は名前空間の ID で、キャッシュのキーも名前空間の ID を含む。ゲートウェイは、応答の項目の `account_id` が要求のアカウントと一致することを確かめ、違えば捨てて重大な事象にする（二重の検査）。
- `cursor` は暗号化と認証を付け、別の名前空間では使えない。
- エッジのノードのインスタンスロールは、DynamoDB と KV の S3 に直接の権限を持たない。正本に触るのは東京の書き込みサービスとゲートウェイだけ（ADR-0010 の 7.2 節の最小の権限）。
- 値とメタデータは、DynamoDB と S3 の保存時の暗号化（KMS）で守る。アカウントごとの鍵にするかは 13 節の問い。
- ログに値とメタデータを出さない。キーの名前は、利用者のデータを含みうるので、アカウントの外のログに出さない（ハッシュにする）。

## 10. テスト

| 種類 | 対象 | 確かめること |
| --- | --- | --- |
| 単体 | キー・メタデータ・値の検証、`cursor` の暗号化 | 境界（512 バイトちょうど、1,025 バイトのメタデータ、25 MiB ちょうど）。別の名前空間の `cursor` を拒む |
| 性質ベース | 一覧の併合 | 任意のキーの集合と任意の `limit`・`prefix` で、16 の区画の併合が、全キーを 1 か所に置いたときの辞書順と一致し、抜けと重複がない |
| 性質ベース | 古さの数え方 | 任意の書き込みと読み込みの列、任意の `cacheTtl` で、キャッシュが返す値の `fetched_at` が `now - cacheTtl` より新しい（古くても返す段を除く） |
| 性質ベース | 版の比較 | 任意の順で届くキャッシュの更新で、L1・L2 の版が減らない |
| 結合 | 1 秒に 1 回 | 同じキーへの 1 秒以内の 2 回目が 429。1 秒後の書き込みは成功。異なる 1,000 キーへの同時の書き込みは全部成功 |
| 結合 | 大きな値 | 4 KiB ちょうどと 4 KiB＋1 バイト、25 MiB の値の書き込みと読み込み。上書きの後の古い本体が 24 時間後に消える |
| 結合 | 有効期限 | 期限を過ぎたキーが `get` と `list` から消える（DynamoDB の TTL の削除を待たずに） |
| 一貫性（障害の注入） | 有界の古さ | 書き込みと読み込みを全リージョンから混ぜ、L2 の障害・東京への経路の遅延・Valkey の切り替えを注入する。各読み込みの結果が「その時点の `cacheTtl` 前以降に確定した版か、それより新しい版」であることを検査する（Jepsen の形の自前の検査器。古くても返す段に入った読み込みは別に数える） |
| 一貫性（本番） | NFR-009 | 8 節の計測。p99 70 秒以内 |
| 負荷 | 読み込み | ホットなキー（1 キーに 1 万 件/秒）で、L1 の当たりの p99 1ms 未満、正本への読み込みが 1 リージョンあたり 1 秒に数件で済む |
| 分離 | 名前空間 | 別のアカウントのバインディングの名前・名前空間の ID を偽った要求が拒否される（脱出のテストの集まりに入れる） |

テスト名には要件の ID を含める（開発リポジトリの `specs/` で採番する）。

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0024](../decisions/0024-kv-central-store-dynamodb.md) | 正本は東京の DynamoDB（名前空間を 16 の区画に分ける）。4 KiB を超える値は S3。同じキーの書き込みは条件付きの書き込みで 1 秒に 1 回。大阪へグローバルテーブルで複製し、復旧に使う |
| [0025](../decisions/0025-kv-two-tier-cache-and-staleness.md) | ノードの L1 とリージョンの L2（Valkey）の 2 段。古さは正本から取った時刻で数え、負の結果もキャッシュする。先読みと、正本の障害のときの古くても返す段を持つ |

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E7 | `kv_entries` の表と書き込みサービス（条件付きの書き込み、429、大きな値の S3） |
| E7 | KV のゲートウェイ（リージョン）と、外向きのプロキシのバインディングの口 |
| E7 | L1 のキャッシュ（外向きのプロキシのメモリ）と、`fetched_at` を引き継ぐ古さの判定 |
| E7 | L2 のキャッシュ（Valkey）、版の比較のスクリプト、同時のミスの集約、先読み |
| E7 | 一覧（16 区画の併合、暗号化した `cursor`） |
| E7 | 有効期限と墓石、掃除のキュー（S3 の古い本体） |
| E7 | 一貫性の計測（合成の書き込みと読み込み）と、有界の古さの検査器 |
| E7 | グローバルテーブルの大阪の複製と、`kv-region-failover` の訓練 |
| E1 | ElastiCache・DynamoDB・リージョンの間の私的な経路の Terraform |
| E6 | CLI の `kv` の操作（一括の書き込み、一覧）と、ローカルの模擬の KV |
| E11 | 読み込み・書き込み・削除・一覧・保存の量の計測を使用量の集計へ流す |

## 13. 未解決の問い

- 名前空間の区画の数（16 固定）を、大きな名前空間でどう増やすか。区画の数を変えると一覧の併合とキーの置き場所が変わる。
- 一覧をキャッシュするか。遠いリージョンからの一覧は毎回 100ms 以上かかりうる（未検証）。
- 海外のリージョンへの正本の読み込みの複製（ADR-0005 の S2 の方針）を、DynamoDB のグローバルテーブルで作るか。書き込みを東京だけにする約束の守り方。
- アカウントごとの暗号化の鍵を持つか（KMS の要求の数と費用）。
- L2 を ElastiCache から自前のキャッシュ（ノードの NVMe を使う）に移すか。S2 の費用で決める。
- 書き込みの原価：4 KiB の値の書き込みは、DynamoDB の 4 単位と大阪の複製の 4 単位で約 5.7 ドル/100 万になり、本家の料金（5.00 ドル/100 万）を上回る。料金の値は limits-and-billing で決める。

### 決定

2026-09-27 の既定案。

- 区画は S1 で 16 の固定。1 つの名前空間の書き込みが区画あたり 700 単位/秒を超えたら警報を出し、S2 の前に区画の分割（新しい区画の数で二重に書き、移し終えたら切り替える）の設計を ADR にする。
- 一覧は S1 でキャッシュしない。遅さは文書で示す。
- 海外の読み込みの複製は S2 で決める。S1 は東京だけ。
- 暗号化は S1 で AWS の管理の鍵（DynamoDB と S3 の既定）。アカウントごとの鍵は security の領域で決める。
- L2 は S1 で ElastiCache for Valkey。
- 書き込みの料金は原価を下回らないように limits-and-billing で決める。本家と同じ値にすることを目標にしない。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：古さの上限が守れない（2 段の TTL の足し合わせ、時計のずれ）。性質ベーステストと、全リージョンの一貫性の計測（NFR-009）。
- リスク：別の名前空間の値を返す（キャッシュのキーの誤り）。ゲートウェイの `account_id` の二重の検査と、分離のテスト。
- リスク：大きな値の本体を早く消す（掃除の誤り）。24 時間の猶予と、読み込みの `NoSuchKey` の監視。
- 本番での検証：8 節の合成の書き込みと読み込み。リージョンの組ごとの見えるまでの時間の p99。

**runbooks**

- `kv-staleness-slo-breach`：見えるまでの時間の p99 が 70 秒を超えた。古くても返す段の回数、東京への経路、Valkey の状態を確かめる。
- `kv-hot-partition`：1 つの区画の消費が閾値を超えた。名前空間とアカウントの特定、書き込みの制限。
- `kv-region-failover`：東京の全体の障害で、書き込みサービスと正本を大阪へ手動で移す。移した後の RPO の確認と、戻す手順。
- `kv-l2-degraded`：Valkey のシャードの障害。正本への読み込みの増加の見張り。
- SLI の追加の依頼（Ops へ）：見えるまでの時間（リージョンの組ごと）、L1・L2 の当たりの率、古くても返す段の回数、429 の率、書き込みの遅延。

**data-model**

| テーブル・保存 | 主な列 | 備考 |
| --- | --- | --- |
| `kv_namespaces`（制御プレーンの Aurora） | `id`、`account_id`、`title`、`shard_count`（16）、`created_at`、`deleted_at` | RLS。ノードへは設定の配信で届く |
| `kv_entries`（東京の DynamoDB） | 5.2 節 | `pk` の先頭が名前空間の ID。グローバルテーブルで大阪へ複製 |
| `<brand>-kv-values-apne1`（S3） | `{namespace_id}/{key_hash}/{version}` | 4 KiB を超える値。バージョニング 7 日、大阪へ CRR |
| L2（各リージョンの Valkey） | `kv:{namespace_id}:{key}` → `{version, fetched_at_ms, expires_at, metadata, value｜absent}` | キャッシュ。正本ではない |
| 使用量（limits-and-billing） | `account_id`、`namespace_id`、読み込み・書き込み・削除・一覧の数、保存の量 | `account_id` で分ける |

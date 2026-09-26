# Git storage: GitHub

リポジトリの保存、3 つの複製、ルーティング、ref の更新の合意、修復と再配置、fork のネットワーク、保守、バックアップ、削除と復元、大きなリポジトリ。前提となる決定は、Go と Git の本体（[ADR-0001](../decisions/0001-platform-and-stack.md)）、アプリケーションの層での 3 つの複製（[ADR-0003](../decisions/0003-replicated-git-storage.md)）、状態を持たないフロントエンド（[ADR-0004](../decisions/0004-stateless-git-frontend.md)）、Git を正本とすること（[ADR-0005](../decisions/0005-git-as-source-of-truth.md)）。この文書で決めたことは、ref の更新の合意（[ADR-0006](../decisions/0006-ref-update-consensus.md)）、fork のオブジェクトの共有（[ADR-0007](../decisions/0007-fork-network-object-sharing.md)）。SSH・HTTPS の受け口と push・fetch の流れは [git-protocols.md](git-protocols.md) にある。

本家 GitHub の Spokes（旧 DGit）に寄せる。参照した一次情報は次のとおり。

- [Introducing DGit](https://github.blog/engineering/architecture-optimization/introducing-dgit/)：3 つの複製、書き込みは 2 つ以上の確認で確定、読み取りはどの複製からでも
- [Building resilience in Spokes](https://github.blog/engineering/infrastructure/building-resilience-in-spokes/)：厳密な過半数でしか書き込みを受け付けない、実際の要求で失敗を検知する、Git と rsync で修復と再配置
- [Stretching Spokes](https://github.blog/engineering/infrastructure/stretching-spokes/)：3 相コミット、複製を分散ロックとして使って DB の更新の順序を守る、`(refname, value)` のハッシュの XOR によるチェックサム、同期している最も近い複製から読む
- [Counting objects](https://github.blog/2015-09-22-counting-objects/)：fork は `network.git` を alternates で参照する
- [Scaling monorepo maintenance](https://github.blog/open-source/git/scaling-monorepo-maintenance/)、[Scaling Git's garbage collection](https://github.blog/engineering/architecture-optimization/scaling-gits-garbage-collection/)：幾何級数の repack、multi-pack index のビットマップ、cruft pack

## 1. 原則

- **成功を返した push は失われない。** ref の更新は、3 つの複製のうち 2 つ以上で確定し、DB のチェックサムを更新してから成功を返す（NFR-002）。
- **複製は普通の Git のリポジトリ。** 独自の形式を作らない。調査と修復は Git の道具で行う。
- **配置の単位は fork のネットワーク。** 同じネットワークのリポジトリは、alternates で同じファイルシステムを参照するので、必ず同じ 3 つのノードに置く。
- **複製の状態は、チェックサムで判定する。** ハートビートやタイムスタンプではなく、ref の中身の要約が一致しているかで「同期している」を決める。
- **ストレージのノードは使い捨て。** ローカルの NVMe を使い、ノードを失ったら別のノードに複製を作り直す。最後の砦は S3 のバックアップ。

## 2. 全体の構成

```
            Git フロントエンド（git-protocols.md）      Web・API・Worker
                 │ gRPC（mTLS、ストリーム）                │ gRPC（読み取りの RPC）
                 ▼                                          ▼
   ┌─────────── ルーティングの表（Aurora: storage_nodes, networks, network_replicas, repositories）
   │                                  │
   ▼ AZ-a                             ▼ AZ-c                         ▼ AZ-d
 storage node（gitd）             storage node（gitd）            storage node（gitd）
  /data/networks/<shard>/<network_id>/
    network.git          ← ネットワーク共有のオブジェクト
    <repo_id>.git        ← ref と、まだ移していないオブジェクト。objects/info/alternates → network.git
                 │
                 └── バックアップ（incremental bundle）──▶ 大阪の S3 に直接書く（Object Lock。レプリケーションは使わない）
```

| 部品 | 責務 |
| --- | --- |
| `gitd`（ストレージのノードのデーモン、Go） | Git の本体を呼び、`upload-pack`・`receive-pack` のストリーム、読み取りの RPC（ファイル、ツリー、差分、マージ）、ref のトランザクション、チェックサム、保守を行う |
| 合意の調整役（coordinator） | push の ref の更新で 3 相の手順を回す。Git フロントエンドのプロセスの中で動く（状態は DB と複製にしかない） |
| ルーティングの表 | どのネットワークがどのノードにあり、どの複製が同期しているか。Aurora に置く |
| 修復・再配置のワーカー（`spokesd` に相当） | 同期していない複製の修復、足りない複製の作成、ノードの退避と容量の平準化 |
| 保守のスケジューラ | repack、commit-graph、multi-pack index、ビットマップ、ref の pack、ネットワークへのオブジェクトの移動 |

## 3. ノードの構成

### 3.1 インスタンスとディスク

- ストレージのノードは、ローカルの NVMe を持つ EC2（S1 は `i8g.4xlarge`）にする。Git の大量の小さな読み書きと、パックの生成の読み込みに、ネットワーク越しのブロックストレージより向く。型・台数・Auto Scaling グループを使わない理由は [infrastructure.md](infrastructure.md) と [capacity.md](capacity.md) にある。
- インスタンスストアは、停止や基盤の故障で中身を失う。耐久性は 3 つの複製と S3 のバックアップで持ち、ノードの中身には頼らない。
- ファイルシステムは XFS。1 ノードのディスクの使用率の目標は 70% 以下（repack の一時領域と、他のノードの退避の受け入れに余裕を持たせる。[capacity.md](capacity.md) の充填率と合わせる）。
- EBS（`gp3`・`io2`）は、別のリージョンでの復旧で `i8g` が使えない場合の代わりとして扱う（[infrastructure.md](infrastructure.md)）。

### 3.2 AZ への配置

- S1 は東京リージョンの 3 AZ に、ノードを同数ずつ置く。
- 1 つのネットワークの 3 つの複製は、必ず異なる 3 つの AZ に置く。AZ を 1 つ失っても、2 つの複製が残り、読み書きが続く（NFR-008）。
- 本家は「ラック」を AZ に見立てて、異なるラックに置いている（Building resilience in Spokes）。ここでは AWS の AZ がその役目を持つ。
- 複製の間の転送は AZ をまたぐので、転送料金がかかる。push のデータ量に比例し、clone（読み取り）は同じ AZ の複製から返すので、AZ をまたぐ転送は主に書き込みと修復になる。

### 3.3 ディスク上の配置

```
/data/networks/<network_id の下 2 桁>/<network_id>/
  network.git/                  # 共有のオブジェクト。refs/networks/<repo_id>/... に各リポジトリの ref の写し
  <repo_id>.git/                # 各リポジトリ（fork を含む）。bare
    objects/info/alternates     # ../network.git/objects
    spokes/checksum             # ref のチェックサム（5 節）
  tmp/                          # 修復・repack の作業領域
```

- ディレクトリ名に持ち主の名前やリポジトリの名前を使わない。名前の変更・移譲でパスが変わらないようにする。
- fork を持たないリポジトリも、1 つだけのネットワークとして同じ形で置く。fork を作ったときに移動が要らない。

## 4. 配置とルーティングの表

### 4.1 表

| 表 | 主な列 | 意味 |
| --- | --- | --- |
| `storage_nodes` | `node_id`、`az`、`state`（`active`・`draining`・`offline`・`retired`）、`capacity_bytes`、`used_bytes`、`weight` | ストレージのノード |
| `repository_networks` | `network_id`、`root_repo_id`、`visibility_class`、`size_bytes`、`placement_class`（`standard`・`large`） | fork のネットワーク |
| `network_replicas` | `network_id`、`node_id`、`state`（`healthy`・`out_of_sync`・`creating`・`removing`） | ネットワークの複製の場所と状態 |
| `repositories` | `repo_id`、`network_id`、…（メタデータは [data-model.md](data-model.md)） | リポジトリ |
| `repository_checksums` | `repo_id`、`checksum`、`version` | 確定した ref の状態の要約と、更新の通し番号（5 節） |
| `ref_transactions` | `txn_id`、`repo_id`、`base_version`、`state`（`pending`・`committed`・`aborted`）、`updates`、`created_at` | 3 相の手順の途中の記録（5 節） |
| `repair_jobs` | `network_id`、`repo_id`、`reason`、`priority`、`state` | 修復の待ち行列 |

### 4.2 配置の選び方

新しいネットワーク（fork でない新しいリポジトリ）を置くとき：

1. 各 AZ から、`state = active` で、ディスクの使用率が目標未満のノードを候補にする。
2. 候補から、空き容量と負荷（CPU、進行中の `pack-objects` の数）で重み付けして 1 台ずつ選ぶ（完全な最小ではなく重み付きの乱択にし、新しいノードへの集中を避ける）。
3. 3 つの複製を作ってから、リポジトリの作成を成功にする。

fork は、元のネットワークの 3 つのノードに置く（新しい配置の判断をしない）。

### 4.3 ルーティング

- フロントエンドと Web・API は、`network_replicas` を短い TTL（5 秒）でキャッシュする。
- **読み取り**：`healthy` の複製から、同じ AZ、負荷の低い順に選ぶ。要求時に DB の `repository_checksums.checksum` を渡し、ノードは自分のチェックサムと一致しなければ `NOT_IN_SYNC` を返す。フロントエンドは、バイトを 1 つも返す前なら、別の複製で再試行する。これで、キャッシュが古くても、遅れた複製から読まない（本家の「同期している最も近い複製から読む」）。
- **書き込み**：`healthy` の全複製に対して、5 節の手順を回す。`out_of_sync` の複製は投票に入れない。
- **失敗の検知**：本家と同じく、実際の要求の失敗で判定する。フロントエンドの各プロセスが、同じノードへの要求が 3 回続けて失敗したら、そのノードを自分の中で `offline` とみなし、30 秒ごとに試し直す。全体の `storage_nodes.state` は、ヘルスチェックと、複数のフロントエンドの判定の多数で、制御の側が更新する。

## 5. ref の更新の合意

詳細な選択肢と理由は [ADR-0006](../decisions/0006-ref-update-consensus.md)。

### 5.1 チェックサム

- リポジトリのチェックサムは、全 ref の `(refname, value)` のハッシュ（SHA-256）の XOR とする（Stretching Spokes と同じ）。
- 更新は差分で計算できる：`new = old XOR H(ref, old_value) XOR H(ref, new_value)`。作成は `old_value` を、削除は `new_value` を含めない。
- 各複製は `spokes/checksum` に自分の値を持ち、ref の更新と同じ手順で書き換える。検査のときは、ref の一覧から計算し直して突き合わせる。
- `HEAD`（既定のブランチの指し先）や、PR 用の `refs/pull/*` も ref に含める。

### 5.2 手順

push の objects は、ref の更新の前に、全ての複製の検疫（quarantine）の領域に届いている（[git-protocols.md](git-protocols.md) の 5 節）。

```
coordinator                     replica A / B / C（gitd）                  Aurora
    │ 0. version を読む ──────────────────────────────────────────────▶ repository_checksums
    │ 1. PREPARE(updates, base_checksum) ─▶ 検疫の objects を本体へ移す
    │                                       git update-ref --stdin: start / update ... / prepare
    │                                       （ref のロックを取り、旧値を確かめる）
    │◀── vote(ok, before, after) ───────────
    │ 2. 2 票以上が ok で before・after が一致したら
    │    tx: ref_transactions に pending を書く ─────────────────────────▶ （同時に version を CAS で予約）
    │ 3. COMMIT ─────────────────────────▶ commit（ロックを外して反映）、spokes/checksum を更新
    │◀── ack ───────────────────────────────
    │ 4. 2 つ以上の ack で
    │    tx: checksum・version を更新、ref_transactions を committed、
    │        投票しなかった・失敗した複製を out_of_sync、outbox に refs.updated ─▶
    │ 5. クライアントに成功を返す
```

- 1 の `prepare` は、ref のロックを取り、全ての ref の旧値が期待どおりか確かめる。Git の `update-ref --stdin` の `start`・`prepare`・`commit`・`abort` を使う（[git-update-ref](https://git-scm.com/docs/git-update-ref)）。本家が Git に入れた、トランザクションとしての ref の更新と同じもの（Stretching Spokes）。
- 2 の `version` の予約は、`UPDATE repository_checksums SET pending_version = version + 1 WHERE repo_id = ? AND version = ? AND pending_version IS NULL` の形の CAS で行う。同じリポジトリの push は、ここで直列になる。予約に失敗したら、全ての複製に `abort` を送り、クライアントに再試行を促すエラーを返す（Git のクライアントには「更新の競合」として見える）。
- 複製が持つロックは、同じ ref への他の更新を止める。本家が「複製を分散ロックとして使う」と書いている役目。
- 4 の DB のトランザクションで、outbox の Event（`refs.updated`）を書く。Event の順序は `version` で決まる（ADR-0005 の「リポジトリごとの順序付きの Event」）。
- 3 で ack が 2 つ未満なら、成功を返さない。4 を書く前に coordinator が落ちた場合は、5.3 節の回収で決着させる。

### 5.3 途中で止まったときの回収

- `pending` のまま 30 秒を過ぎた `ref_transactions` を、回収のワーカーが拾う。
- 各複製のチェックサムを読み、予約した `after` に達した複製が 2 つ以上あれば、4 を行って `committed` にする（outbox も書く）。そうでなければ、`after` に達した複製を `out_of_sync` にして `aborted` にし、予約を外す。
- どちらの場合も、クライアントには成功を返していない。クライアントは「結果が不明」として再試行する。同じ push をもう一度送っても、ref がすでに新しい値なら「最新」として扱われる。
- `prepare` の途中の `update-ref` の子プロセスは、coordinator との接続が切れると `abort` する。ロックが残り続けない。

### 5.4 性質

- **失われない**：成功を返した更新は、2 つ以上の複製の ref に反映され、DB の `checksum` と一致している。
- **一致する**：修復が追いついた後、3 つの複製のチェックサムは DB の `checksum` と等しい。
- **順序**：outbox の `refs.updated` を `version` の順に適用すると、DB の写しの ref は Git の ref と一致する（ADR-0005）。

これらは [quality.md](../quality.md) の性質として、障害注入で検証する（10 節）。

## 6. 修復と再配置

### 6.1 修復

| 状況 | 検知 | 修復の方法 |
| --- | --- | --- |
| 投票しなかった・遅れた複製（`out_of_sync`） | 5.2 の 4 で印を付ける | 同期している複製から `git fetch`（objects）してから、ref を `update-ref --stdin` で合わせる。チェックサムが DB と一致したら `healthy` に戻す |
| ノードを失った | ヘルスチェック、4.3 の失敗の検知 | そのノードの全ての複製を、別のノード（別の AZ の条件を保つ）に作り直す |
| 複製の中身の破損 | 定期の `git fsck`、読み取りの失敗 | 破損した複製を捨て、作り直す |
| チェックサムの不一致（原因不明） | 定期の照合 | `out_of_sync` にして修復する。3 つとも DB と違えば、ページを出して人が調べる |

- 新しい複製の作成は、まず rsync に相当する一括のコピーでパックファイルを持ってきて、そのあと `git fetch` と ref の合わせで追いつく（本家も Git と rsync を組み合わせる）。コピーの間も元の複製は書き込みを受ける。
- コピー元は、生き残った 2 つの複製のどちらでもよい。多数のノードから多数のノードへ並列にコピーするので、1 台を失ったときの修復は、ノードの台数に比例して速くなる（Introducing DGit）。
- 修復の優先順位：`healthy` が 1 つしかないネットワーク → `healthy` が 2 つで 1 つが `out_of_sync` → 容量の平準化。
- 1 ノードあたりの修復の同時数と帯域に上限を置き、利用者の要求の遅延を守る。上限は [capacity.md](capacity.md) のパラメーターにする。
- `healthy` が 1 つしかないネットワークへの push は、2 票を集められないので失敗する（整合性と分断耐性を優先する。Building resilience in Spokes）。読み取りは続ける。

### 6.2 定期の照合

- 毎日、全てのリポジトリについて、3 つの複製のチェックサムを DB と比べる。ノードは `spokes/checksum` ではなく、ref の一覧から計算し直した値を返す。
- 週に 1 度、ネットワークを順に回って `git fsck --connectivity-only` を行う。1 ノードの 1 日の量に上限を置く。
- 不一致の件数、`out_of_sync` の数、修復の待ち行列の長さと最古の経過時間を監視する（15 節）。

### 6.3 再配置

- ノードの退避（`draining`）：退役・ハードウェアの保守の予定（EC2 の予定されたイベント）を受けたら、そのノードの複製を 1 つずつ別のノードへ移す。移動は「4 つ目の複製を作る → `healthy` を確認 → 古い複製を `removing` にして消す」の順にし、途中で 3 つを下回らないようにする。
- 容量の平準化：ディスクの使用率が 70% を超えたノードから、大きいネットワークを優先して移す。
- 読み取りの静止（quiesce）：複製を消す前に、ルーティングから外して、進行中の読み取りが終わるのを待つ（本家の clean shutdown と同じ考え方）。

## 7. fork のネットワークと共有のオブジェクト

詳細な選択肢と理由は [ADR-0007](../decisions/0007-fork-network-object-sharing.md)。

### 7.1 仕組み

- ネットワークごとに `network.git` を 1 つ持ち、ネットワークの全てのリポジトリの objects を集める。各リポジトリは `objects/info/alternates` で `network.git/objects` を参照する（[gitrepository-layout](https://git-scm.com/docs/gitrepository-layout)、本家の Counting objects と同じ）。
- push で届いた objects は、まずそのリポジトリの `objects/` に入る。保守（8 節）で `network.git` へ移し、各リポジトリには ref だけを残す。
- `network.git` は、各リポジトリの ref を `refs/networks/<repo_id>/...` の形で写して持つ。これが、ネットワーク全体の到達可能性の根になる（保守で objects を消してよいかの判定に使う）。
- fork の作成は、ネットワークの 3 つのノードで `<repo_id>.git` を作り、元の ref を写すだけで済む。objects のコピーはない。

### 7.2 セキュリティへの影響

objects がネットワークで共有されるので、次のことが起きる。本家の振る舞いに合わせて、仕様として受け入れる（[About forks](https://docs.github.com/en/pull-requests/reference/forks)）。

- **ある fork に push したコミットは、ネットワークの他のリポジトリ（元のリポジトリを含む）から、ハッシュを指定すれば見えうる。** Web では、本家と同じく「このリポジトリのどのブランチにも属さないコミット」であることを表示する（[web.md](web.md)）。
- **fork を削除しても、そこから入ったコミットはネットワークに残りうる。**

漏れてはいけない境界は守る。

- **公開と非公開をネットワークで混ぜない。** 非公開のリポジトリの fork は非公開で、同じネットワークにある。公開のリポジトリを非公開にしたら、公開の fork は別のネットワークに分ける。非公開を公開にしたら、非公開の fork は別のネットワークに分ける（本家の About forks と同じ）。分けるときは、新しいネットワークに `network.git` を作り、必要な objects をコピーする。コピーが終わるまで、公開の種類の変更を完了にしない。
- **非公開のネットワークの中の読み取りは、リポジトリごとに判定する。** 同じネットワークでも、あるリポジトリに読み取りの権限がなければ、そのリポジトリの経路からは何も返さない（ADR-0002）。
- **`upload-pack` は、そのリポジトリの ref から到達できる objects だけを返す設定にする**（`uploadpack.allowAnySHA1InWant` を無効にする。[git-config](https://git-scm.com/docs/git-config)）。alternates の先の `network.git` の ref は、そのリポジトリの ref として広告しない。
  - プロトコル v2 の `fetch` で、広告していないハッシュの `want` をどこまで検査するかは **未検証**。E1 で、fork の ref にしかないコミットを元のリポジトリの経路から `want` するテストを作り、Git の版ごとの振る舞いを確かめる。本家は Web でこの種のコミットを表示するので、Git の経路で返すかどうかは本家の振る舞いも合わせて確かめる。
- 秘密情報を push してしまった場合の完全な消去は、本家と同じく運用の手順で行う（11.3 節）。

### 7.3 大きなネットワーク

- 1 つのネットワークは 3 つのノードに収まらなければならない。数万の fork を持つネットワークは、`placement_class = large` として、ディスクの大きい専用のノードの群に置く。
- delta islands（[git-pack-objects](https://git-scm.com/docs/git-pack-objects#_delta_islands)）で、あるリポジトリの clone に、他の fork にしかない objects との差分（delta）を使わないようにする。使うと、clone のたびに delta を解き直す費用がかかる。delta islands は本家の開発者が Git に入れた機能。
- ネットワークから 1 つのリポジトリを切り離す（detach）操作は、ネットワークの分割と同じ手順で行う。

## 8. 保守

### 8.1 何をするか

| 作業 | 方法 | 目的 |
| --- | --- | --- |
| 小さな repack | `git repack --geometric=2 -d --write-midx`（[git-repack](https://git-scm.com/docs/git-repack)） | 新しい小さなパックだけをまとめる。大きなパックに触れない |
| 全体の repack | `git repack -a -d --cruft --cruft-expiration=<猶予> -b`（ネットワークは `network.git` で行う） | 8 回の小さな repack に 1 回、全体を作り直す（本家の Scaling monorepo maintenance と同じ割合）。到達できない objects は cruft pack に入れ、猶予を過ぎたら消す |
| multi-pack index とビットマップ | `git multi-pack-index write --bitmap`（[git-multi-pack-index](https://git-scm.com/docs/git-multi-pack-index)） | 複数のパックにまたがるビットマップで、clone の objects の数え上げを速くする |
| commit-graph | `git commit-graph write --reachable --split`（[git-commit-graph](https://git-scm.com/docs/git-commit-graph)） | 履歴の走査（merge-base、fetch の交渉、PR の差分）を速くする |
| ref の pack | `git pack-refs --all` | ref のファイルの数を減らす |
| ネットワークへの移動 | 各リポジトリの objects を `network.git` へ移し、`network.git` の `refs/networks/<repo_id>/*` を更新する | fork の間の重複をなくす |

- 猶予（cruft の expiration）は 2 週間から始める。push の途中の objects や、進行中の読み取りが参照する objects を消さないため（Scaling Git's garbage collection の「消す前に push が参照すると壊れる」問題）。値は [capacity.md](capacity.md) のパラメーターにする。
- 保守は、ref を変えないので、チェックサムに影響しない。各複製で独立に行う。
- 同じネットワークの 3 つの複製で、同時に全体の repack をしない。常に 2 つ以上が通常の性能で読み取りを返せるようにする。
- 実行の契機は、push の回数、パックの数、loose objects の数、前回からの経過時間で決める。本家の Git の `git maintenance`（[git-maintenance](https://git-scm.com/docs/git-maintenance)）の各作業を、スケジューラから明示的に呼ぶ（ノードの cron に任せない。負荷とタイミングを全体で制御するため）。

### 8.2 reftable

- Git 2.45 から、ref を少数の表のファイルに持つ reftable の形式を選べる（[Highlights from Git 2.45](https://github.blog/open-source/git/highlights-from-git-2-45/)）。ref が非常に多いリポジトリ（`network.git` は、全ての fork の ref を持つ）で、読み書きが速くなる見込みがある。
- S1 は既定の files の形式で始める。reftable は、`network.git` と ref の多いリポジトリで E3 に PoC を行い、`update-ref --stdin` のトランザクション、チェックサムの計算、修復の手順がそのまま動くか、性能がどれだけ変わるかを確かめてから決める（**未検証**）。本家がどちらを使っているかは、公開情報では確かめられていない。

## 9. バックアップ

- 3 つの複製は、ノードや AZ の障害への備え。バックアップは、運用の誤り、ソフトウェアの不具合で 3 つが同時に壊れること、リージョンの障害への備え。
- **増分**：`refs.updated` の Event（outbox）を契機に、バックアップのワーカーが、リポジトリごとに最大 5 分まとめて、`git bundle create`（[git-bundle](https://git-scm.com/docs/git-bundle)）で「前回のバックアップの ref の先端から、今の ref まで」の bundle を作り、S3 に置く。ref の一覧（名前と値）も一緒に置く。
- **全体**：週に 1 度、または増分の鎖が 50 個を超えたら、ネットワークの全体の bundle を作る。
- **保存**：大阪のバケットに直接書く。東京のバケットに書いて S3 のレプリケーションで送る方式は採らない（レプリケーションの遅れが RPO に足されるため。[ADR-0032](../decisions/0032-disaster-recovery-strategy.md) の選択肢 3）。SSE-KMS で暗号化し、バージョニングと Object Lock（ガバナンスモード、35 日）で守る。保持は 35 日。ただし、最新の完全な復元点は期限を過ぎても常に残す（消去したリポジトリを除く。11.1 節）。バケットと災害復旧の手順は [infrastructure.md](infrastructure.md) の 5 節にある。
- **RPO**：まとめる時間（5 分）とワーカーの遅れの和。リージョンの障害の RPO 15 分（NFR-009）を満たすよう、バックアップの遅れ（最古の未処理の `refs.updated` の経過時間）を p99 10 分以内に保ち、12 分でアラートを出す。
- **復元の確認**：毎日、無作為に選んだ 1,000 のリポジトリを、バックアップだけから隔離した環境に復元し、ref のチェックサムが本番と一致することを確かめる（infrastructure.md と同じ）。
- LFS の objects は S3 にあり、別に扱う（[git-protocols.md](git-protocols.md) の 7 節）。
- 本家のバックアップの方式は公開されていない（**未検証**。本家に寄せる対象ではなく、この設計の判断として扱う）。

## 10. 障害注入での検証

[quality.md](../quality.md) に置く項目の候補。

- push の手順の 1〜4 の各時点で、複製のノード・coordinator のプロセスを止める。成功を返した push が失われず、修復の後に 3 つのチェックサムが DB と一致する。
- AZ を 1 つ切り離しても、push と clone が続く。
- 同じリポジトリへの並行な push で、DB の `version` の順と outbox の順と、複製の ref の最終の状態が一致する。
- 修復の途中でさらに 1 台を失っても、`healthy` が 1 つになったネットワークの読み取りが続き、push は失敗を返す（成功を返さない）。

## 11. 削除と復元

### 11.1 リポジトリの削除

- 削除は、まず DB で `deleted_at` を付け、ルーティングから外す（読み書きを止める）。ディスク上の複製は残す。
- 本家と同じく、90 日の間は復元できる。ただし、空でないネットワークに属していたリポジトリは、復元できない（[Restoring a deleted repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/restoring-a-deleted-repository)）。ネットワークの objects を、他のリポジトリと共有しているため。
- fork のリポジトリの削除では、`<repo_id>.git` と `network.git` の `refs/networks/<repo_id>/*` を消す。objects は、他のリポジトリから到達できる限り残る。到達できなくなった objects は、保守の cruft の猶予を経て消える。
- 90 日を過ぎたら、消去のジョブで 3 つの複製を消す（ルーティングの表にある全ての複製と、作り直しの途中の複製を含む）。
- バックアップは「最新の完全な復元点を常に残す」（9 節）が、**消去したリポジトリはこの例外から外す**。消去から 35 日（Object Lock の期間）が過ぎたら、そのリポジトリの復元点ごとライフサイクルで消す。削除の最終的な期限は、削除から最長 125 日（90 日＋35 日）になる（[ADR-0030](../decisions/0030-data-retention-and-deletion.md)）。fork のネットワークの完全なバンドルは、消去したリポジトリの ref を除いて作り直す。

### 11.2 ネットワークの根の削除

- 公開のリポジトリの根を削除したら、本家と同じく、活動中の公開の fork の 1 つを新しい根にする。非公開のリポジトリの根を削除したら、その非公開の fork も削除する（About forks）。

### 11.3 秘密情報の消去

- 利用者は履歴を書き換えて force push するが、objects はネットワーク・PR の ref・キャッシュに残る。本家もサポートへの依頼で消す（[Removing sensitive data](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)）。
- 運用の手順（runbook）で、対象の objects を参照する ref（`refs/pull/*` を含む）を確かめ、ネットワークの全ての複製で `--cruft-expiration=now` の repack を行い、pack のキャッシュ（[git-protocols.md](git-protocols.md) の 6 節）・bundle・バックアップの該当する世代を消す。バックアップの Object Lock を外す権限を、この手順だけに限る。

## 12. 大きなリポジトリとモノレポ

- 上限は本家に寄せる（[Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits)、[About large files](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)）。

| 項目 | 値 | 扱い |
| --- | --- | --- |
| 1 つのファイル（blob） | 50 MiB で警告、100 MiB で拒否 | push の受け付けで検査する |
| 1 回の push | 2 GB | push の受け付けで検査する |
| リポジトリのディスク上の大きさ | 10 GB | 超えたら持ち主に警告し、`placement_class = large` への移動を検討する。拒否はしない |
| ブランチの数 | 5,000 を推奨の上限 | 超えたら警告する |
| 1 ディレクトリの項目 | 3,000 を推奨の上限 | Web の表示で扱う |

- 大きなリポジトリには、multi-pack index のビットマップと commit-graph が欠かせない。これらがないと、clone ごとに全ての objects を数え上げる。
- 幾何級数の repack で、大きなパックを毎回書き直さない（本家が大きなモノレポのために作った方式）。
- 大きなネットワークは専用のノードの群に置き、他の利用者の遅延に影響させない（7.3 節）。
- 利用者の側の工夫（partial clone、sparse checkout）は [git-protocols.md](git-protocols.md) の 6 節。

## 13. 容量の割り当て（クォータ）

- 課金の対象の容量（アカウントごと）と、システムを守る上限（リポジトリ・ネットワークごと）を分ける。
- システムの上限は 12 節の表。課金とプランは MVP の外（LFS の容量と転送量だけは、[git-protocols.md](git-protocols.md) の 7 節で扱う）。
- ネットワークの大きさは、保守のたびに `repository_networks.size_bytes` に書く。1 ノードに占める割合が 10% を超えるネットワークは、アラートを出して人が見る。

## 14. 規模の段階

### S1（100 万リポジトリ、ノード数十台）

- 1 リージョン、3 AZ。配置は 4.2 節の重み付きの乱択。
- 修復と平準化は 1 つのワーカーの群で行う。

### S2（1,000 万、ノード数百台）

- ノードを数百台に増やす。ルーティングの表は Aurora のまま、フロントエンドのキャッシュをリポジトリ単位の変更通知で消す方式にする（TTL の 5 秒だけに頼らない）。
- `large` の専用のノードの群を持つ。
- 平準化を常時動かし、ノードの追加を「追加 → 自動で移す」の流れにする。
- 修復の帯域の上限を、ノードの台数に合わせて広げる。

### S3（1 億、複数のリージョン）

- ネットワークに「本拠のリージョン」を割り当てる。本拠のリージョンの 3 AZ に、投票する 3 つの複製を置く（書き込みの遅延をリージョンの中に留める）。
- 他のリージョンに、投票しない読み取りの複製を置く。ref の更新の後に非同期で追いつく。チェックサムが DB と一致しているときだけ読み取りに使う（4.3 節と同じ規則）。
- 本家の Stretching Spokes は、離れたデータセンターの複製にも同期で投票させ、往復の回数を減らす工夫で遅延を抑えている。ここでは、まずリージョンの中の同期と、リージョンの外の非同期で始め、リージョンをまたぐ同期の投票は、NFR-009 の RPO を 0 にする必要が出たときに検討する。
- ネットワークの本拠の移動は、移動先に 3 つの複製を作る → 追いつく → 書き込みを短時間止めて投票する複製を切り替える、の順で行う。
- ルーティングの表は、リージョンごとに読める写しを持つ。リージョンの割り当てと災害復旧の段階は [infrastructure.md](infrastructure.md) の 5 節で扱う（S2 の大阪の非同期の複製は、この節の「投票しない読み取りの複製」と同じ仕組みで作る）。

## 15. 障害と振る舞い

| 障害 | 起きること | 検知 | 回復 |
| --- | --- | --- | --- |
| ノードが 1 台落ちる | その上の複製が使えない。読み書きは残り 2 つで続く | 実際の要求の 3 回連続の失敗、ヘルスチェック | 全ての複製を別のノードに作り直す（6.1） |
| AZ の障害 | 全てのネットワークで複製が 1 つ使えない | 同上 | 読み書きは続く。AZ が戻らなければ、残りの 2 AZ の中で 3 つ目を作るかは、AZ の分散の条件を一時的に緩めるかの判断（runbook で人が決める） |
| 2 つの複製を同時に失う | そのネットワークの push が失敗する。読み取りは続く | `healthy` が 1 つのネットワークの数 | 最優先で修復する |
| coordinator が手順の途中で落ちる | クライアントに結果が返らない | `pending` の `ref_transactions` の経過時間 | 5.3 の回収 |
| DB（Aurora）のフェイルオーバー | push が失敗する（2・4 で DB に書けない）。読み取りは、キャッシュしたルーティングとチェックサムで続く | DB の接続エラー | クライアントが再試行する |
| 複製の中身の破損 | その複製の読み取りが失敗する | fsck、読み取りの失敗 | 捨てて作り直す |
| 修復の待ち行列が伸びる | 複製が 2 つの状態が長く続く | 待ち行列の長さと最古の経過時間 | 修復の帯域の上限を上げる、ノードを増やす（runbook） |
| ディスクの逼迫 | repack と push が失敗しうる | 使用率 | 平準化、ノードの追加 |
| 保守の不具合で objects を失う | 3 つの複製で同時に起きうる | fsck、読み取りの失敗 | バックアップから復元する。保守の新しい版は、1 つの複製ずつ段階的に出す |

## 16. 監視する指標

指標の定義と閾値は [runbooks](../runbooks/README.md) で持つ。

- push：合意の手順の区間ごとの遅延、投票の不成立の数、CAS の競合の数、`pending` の件数と最古の経過時間
- 複製：`healthy` が 3 未満のネットワークの数（2 つ・1 つ別に）、修復の待ち行列の長さと最古の経過時間、定期の照合の不一致の数
- ノード：ディスクの使用率、IOPS、CPU、進行中の `pack-objects`・`receive-pack` の数、状態ごとの台数
- 保守：遅れているリポジトリの数、パックの数の分布、repack の失敗の数
- バックアップ：最古の未処理の `refs.updated` の経過時間、復元の確認の失敗の数

## 17. 未検証の事項

| 事項 | 確かめ方 | 時期 |
| --- | --- | --- |
| `i8g.4xlarge` での clone・push・repack の性能 | 代表的なリポジトリの負荷試験（[capacity.md](capacity.md)） | E1 |
| v2 の `fetch` で、広告していないハッシュの `want` の検査（fork の objects の漏れ） | 結合テスト。Git の版ごとに確かめる | E1 |
| reftable の採用 | `network.git` と ref の多いリポジトリで PoC | E3 |
| 本家のバックアップと、reftable の利用 | 公開情報では確かめられない。本家に寄せず、この設計の判断として扱う | — |
| cruft の猶予の 2 週間、修復の同時数の上限 | 負荷試験と運用の実績で見直す | E3・E9 |

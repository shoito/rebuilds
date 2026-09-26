# Git protocols: GitHub

SSH と HTTPS の受け口、認証、プロトコル v2、push の受け付け（検査・ref の更新・Event）、fetch と clone の最適化、LFS、濫用対策、タイムアウト。前提となる決定は、状態を持たないフロントエンド（[ADR-0004](../decisions/0004-stateless-git-frontend.md)）、権限の判定関数（[ADR-0002](../decisions/0002-repository-permission-model.md)）、3 つの複製（[ADR-0003](../decisions/0003-replicated-git-storage.md)）、Git を正本とすること（[ADR-0005](../decisions/0005-git-as-source-of-truth.md)）、ref の更新の合意（[ADR-0006](../decisions/0006-ref-update-consensus.md)）。この文書で決めたことは、パックのキャッシュと CDN（[ADR-0008](../decisions/0008-pack-caching-and-bundle-cdn.md)）、LFS の保存（[ADR-0009](../decisions/0009-lfs-storage-on-s3.md)）。保存の側は [git-storage.md](git-storage.md) にある。

## 1. 原則

- **フロントエンドは状態を持たない。** 認証・認可・ルーティング・push の合意の調整だけを行う。Git の中身はストレージのノード（`gitd`）が扱う。
- **Git の本体の実装をそのまま使う。** `upload-pack`・`receive-pack` はストレージのノードで Git の本体が動かす。フロントエンドはバイトを中継し、プロトコルを作り直さない。ただし、push の検査のために pkt-line の先頭（コマンドの一覧）だけは読む。
- **push の成功は、検査と合意の後にだけ返す。** 検査に使う外部のサービス（ルールの評価）が落ちたら、保護された ref への push は拒否する（fail closed）。
- **clone の負荷は、キャッシュとビットマップで下げ、上限で守る。** 1 つのリポジトリへの大量の clone が、同じノードの他のリポジトリを遅くしないようにする。

## 2. 全体の流れ

```
git（SSH :22）  ──▶ NLB（TCP）─────────┐
git（HTTPS :443）──▶ ALB（Git のパスの規則）┤
                                        ▼
                         Git フロントエンド（Go、ECS。複数の AZ）
                           ├─ 認証（SSH の鍵・トークン）── identity（キャッシュ）
                           ├─ 認可 can(actor, action, repo)（ADR-0002）
                           ├─ ルーティング（network_replicas、チェックサム）
                           ├─ push の検査（ルールの評価 ── policy サービス）
                           └─ 合意の調整役（ADR-0006）── Aurora（checksum、outbox）
                                        │ gRPC（mTLS、双方向ストリーム）
                                        ▼
                         gitd（ストレージのノード）── git upload-pack / receive-pack

git-lfs ──▶ ALB ──▶ フロントエンド（batch API）──▶ presigned URL ──▶ S3（直接）
clone（人気のリポジトリ）──▶ bundle-uri ──▶ CloudFront ──▶ S3（bundle）
```

- HTTPS は Web と同じホスト名で受け、ALB の規則で Git の要求をフロントエンドへ振り分ける：`/<owner>/<repo>(.git)?/info/refs`（`service=git-upload-pack|git-receive-pack`）、`/git-upload-pack`、`/git-receive-pack`、`/info/lfs/*`。本家と同じく、`https://<host>/<owner>/<repo>.git` で clone できる。
- SSH は NLB で TCP のまま受け、フロントエンドが SSH を終端する。TLS は ALB で終端する。
- フロントエンドとストレージのノードの間は、Gitaly の `SSHUploadPack`・`PostUploadPack` に相当する、双方向のストリームの gRPC にする。

## 3. 認証と認可

### 3.1 SSH

- 公開鍵の認証だけを受け付ける。パスワードとキーボード対話は無効にする。
- 鍵の指紋から、ユーザーの鍵か、リポジトリに結び付いた deploy key かを引く（[identity-and-permissions.md](identity-and-permissions.md)）。結果は 60 秒キャッシュし、鍵の削除の Event で消す。
- 実行できるコマンドは `git-upload-pack '<path>'`、`git-receive-pack '<path>'`、`git-upload-archive '<path>'`、`git-lfs-authenticate '<path>' <op>` に限る。シェルは与えない。コマンドなしの接続には、本家と同じく「認証できたがシェルは提供しない」旨を返して切る（[Testing your SSH connection](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/testing-your-ssh-connection)）。
- プロトコル v2 は、SSH では環境変数 `GIT_PROTOCOL` で要求される。SSH の `env` の要求のうち `GIT_PROTOCOL` だけを受け付け、`gitd` に渡す（[gitprotocol-v2](https://git-scm.com/docs/gitprotocol-v2)）。
- ホストの鍵は Ed25519、ECDSA、RSA を持ち、指紋を文書で公開する。鍵は AWS の秘密の保管庫に置き、全てのフロントエンドで同じものを使う。鍵の入れ替えの手順は runbook に置く。

### 3.2 HTTPS

- Basic 認証のパスワードの欄で、トークンを受け付ける：個人用アクセストークン（fine-grained と classic）、OAuth のアプリのトークン、App のインストールのトークン、Actions のジョブのトークン。アカウントのパスワードは受け付けない（本家は 2021 年に廃止した。[Token authentication requirements for Git operations](https://github.blog/2020-12-15-token-authentication-requirements-for-git-operations/)）。
- 公開のリポジトリの読み取りは、認証なしで受け付ける。認証なしには、より厳しいレート制限をかける（8 節）。
- 認証が要るのに付いていない要求には 401 と `WWW-Authenticate: Basic` を返す。非公開のリポジトリで権限がない場合は、存在を明かさないよう 404 を返す（本家と同じ）。

### 3.3 認可

- リポジトリの単位の判定は `can(actor, read|write, repo)` で行う（ADR-0002）。トークンのスコープ（`contents:read`・`contents:write`、classic の `repo` など）も判定の材料に含める。
- ref の単位の判定（保護されたブランチ、ルールセット）は、push の受け付けの中で行う（5 節）。
- アーカイブされたリポジトリ、無効化されたリポジトリ、DMCA などで止めたリポジトリは、読み取り・書き込みの可否を判定の関数が返す。

## 4. プロトコル v2

- v2 を既定にし、v0・v1 も受け付ける（古いクライアントのため）。dumb HTTP は受け付けない。
- v2 のコマンドは `ls-refs`、`fetch`、`object-info`、`bundle-uri` を有効にする。`ls-refs` の `ref-prefix` で、クライアントが要る ref だけを返せる（ref の多いリポジトリで効く）。
- 広告しない ref：`refs/pull/*/merge` などの内部の ref のうち、クライアントに見せないものは `uploadpack.hideRefs` で隠す。`refs/pull/<n>/head` は本家と同じく読める。
- HTTPS の v2 は、要求ごとに独立（stateless）なので、`ls-refs` と `fetch` が別の複製に届きうる。フロントエンドは、どちらの要求でも DB のチェックサムと一致する複製だけを選ぶ（[git-storage.md](git-storage.md) の 4.3 節）。`fetch` で `want` した objects がない（`not our ref`）と複製が返したら、応答を返し始める前に、別の同期している複製で再試行する。

## 5. push の受け付け（receive-pack）

### 5.1 流れ

```
client ─ push ─▶ frontend                         gitd × 3（検疫）                 policy / Aurora
  │ 1. 認証・認可（write）
  │ 2. コマンドの一覧（ref, old, new）を読む
  │ 3. パックを 3 つの複製へ同時に流す ─────────▶ index-pack、fsck、接続性の検査
  │    （大きさの上限を流しながら数える）          objects は検疫の領域に置く
  │ 4. 検査（5.2）：1 つの複製の検疫を読む ───────────────────────────────────▶ ルールの評価
  │ 5. ref の更新の合意（ADR-0006）────────────▶ prepare / commit ──────────────▶ checksum、outbox
  │ 6. report-status を返す（ref ごとの ok / ng）
  │    サイドバンドで案内（PR の作成の URL など）
```

- 3 では、パックのバイトを 3 つの複製の `gitd` に同時に流す（本家の DGit も、書き込みを 3 つの複製に同期で流す）。各複製は Git の検疫の環境（[githooks](https://git-scm.com/docs/githooks)、`receive-pack` の quarantine）で objects を受け、`receive.fsckObjects` の相当の検査を行う。2 つ以上の複製で検査が通らなければ、拒否する。
- 4 の検査は、1 つの複製（同じ AZ のもの）の検疫の objects を読んで行う。検査の結果は ref ごとに `ok` か理由付きの `ng` になる。1 つでも `ng` があれば、`atomic` の push は全体を拒否し、そうでなければ `ok` の ref だけを 5 に進める（Git の既定の振る舞いと同じ）。
- 5 は [git-storage.md](git-storage.md) の 5.2 節の 3 相の手順。検疫の objects は、prepare の中で本体へ移す。
- 6 の成功は、合意の手順の 4（DB の確定）の後にだけ返す。

### 5.2 検査の順序

安いものから順に行い、早く落とす。

| 順 | 検査 | 失敗したとき |
| --- | --- | --- |
| 1 | 認可（write）、アーカイブ・無効化の状態 | 接続の時点で拒否（403 / SSH のエラー） |
| 2 | push の大きさ（2 GB）、ref の数（1 回 5,000 まで） | 流している途中で打ち切る |
| 3 | objects の妥当性（fsck）、接続性、blob の大きさ（50 MiB で警告、100 MiB で拒否） | 拒否。警告はサイドバンドで伝える |
| 4 | ref の名前の規則（`refs/pull/*` などの予約した名前空間への書き込みを禁止、不正な名前） | その ref を `ng` |
| 5 | ルールセットとブランチの保護 | その ref を `ng`（理由とルールの名前を返す） |
| 6 | push protection（秘密情報の走査。MVP では枠だけ） | その push を拒否（迂回の手順を案内） |
| 7 | LFS の pointer が指す objects が、LFS の保存先にあるか | 拒否（`git lfs push` を促す） |

- 本家も、100 MB を超える objects の拒否と、LFS の objects が上がっているかの確認を、push の前段のフックで行っている。本家はそのフックを Go で書き直し、中央値を約 880ms から 10ms にした（[Improving Git push times through faster server side hooks](https://github.blog/2022-04-21-improving-git-push-times-through-faster-server-side-hooks/)）。ここでは最初から Go で、フロントエンドの中で行う。
- 5 のルールの評価は、Pull Request の領域が持つ policy のサービスに、ref ごとの `(ref, old, new, pusher)` と、評価に要る Git の事実（fast-forward か、コミットの署名、作者のメール、変更されたパス・拡張子・大きさ）を渡して行う。評価の規則そのものは [pull-requests.md](pull-requests.md) にある。本家のルールセットの push で効く規則（作成・削除・force push の制限、線形の履歴、署名の必須、PR の必須と必須のチェック、コミットのメッセージ・メールの形、ファイルのパス・大きさ・拡張子の制限）を対象にする（[About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)）。
  - Git の事実は、フロントエンドが複製の検疫を読む RPC（`merge-base --is-ancestor`、`rev-list`、差分のパスの一覧）で集める。
  - リポジトリのルールセットは、フロントエンドで 30 秒キャッシュし、変更の Event で消す。ルールを読めないときは、ルールの有無が分からないので、既定のブランチと、ルールの対象になりうる全ての ref への push を拒否する（fail closed）。
  - bypass（ルールを迂回できる主体）の判定も policy のサービスが行う。迂回した push は監査ログに残す（[security.md](security.md)）。
- 6 の push protection は、MVP では「秘密情報の走査のフックの枠」だけを置く。追加された blob を走査のサービスに渡し、見つかったら拒否する、という接点と時間の予算（下の表）を先に決めておく。本家の push protection の振る舞い（拒否と、理由を付けた迂回）に寄せる（[About push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection)）。走査の中身は MVP の後の Epic。

### 5.3 検査の時間の予算

| 区間 | 予算 | 超えたとき |
| --- | --- | --- |
| 4〜7 の検査の合計 | p99 1 秒、上限 10 秒 | 上限で拒否し、再試行を促す |
| ルールの評価の 1 回の RPC | 上限 3 秒 | fail closed |
| push protection の走査 | 上限 5 秒（枠を入れるとき） | 走査できなかったことを記録し、通す（MVP の後に方針を決める） |
| 合意の手順（prepare〜確定） | p99 300ms | 回収の手順（git-storage.md の 5.3 節） |

### 5.4 push の後の Event

- 合意の手順の確定と同じ DB のトランザクションで、outbox に Event を書く（ADR-0005、ADR-0006）。

```json
{
  "type": "repository.refs_updated",
  "repository_id": "…",
  "network_id": "…",
  "version": 1234,
  "pusher": { "type": "user", "id": "…" },
  "via": "ssh",
  "updates": [
    { "ref": "refs/heads/main", "before": "<sha>", "after": "<sha>", "forced": false }
  ],
  "occurred_at": "2026-09-26T09:00:00.000Z"
}
```

- `version` はリポジトリごとの通し番号で、Worker は `version` の順に処理する。飛びがあれば待ち、10 秒待っても来なければ Git から ref を読み直して写しを作り直す。
- Worker が行うこと：PR の最新のコミットとマージ可能かの再計算（[pull-requests.md](pull-requests.md)）、コード検索の索引（[search.md](search.md)）、Webhook の `push`（[api-and-webhooks.md](api-and-webhooks.md)）、Actions の起動（[actions.md](actions.md)）、バックアップ（[git-storage.md](git-storage.md) の 9 節）、bundle の作り直しの判定（6.3 節）。
- 1 つの push で大量の ref が動く場合（ミラーの push）も、Event は 1 つにまとめ、`updates` が 1,000 件を超えたら、本体を S3 に置いて参照だけを入れる。
- post-receive のフックを、利用者が任意に置く仕組みはない（GitHub Enterprise Server の pre-receive のフックに相当するものは MVP の外）。

## 6. fetch と clone（upload-pack）の最適化

詳細な選択肢と理由は [ADR-0008](../decisions/0008-pack-caching-and-bundle-cdn.md)。

### 6.1 複製の選び方

- 同じ AZ の、同期している、進行中の `pack-objects` の少ない複製を選ぶ（[git-storage.md](git-storage.md) の 4.3 節）。
- フロントエンドとストレージのノードの間の帯域は、同じ AZ の中に留める。

### 6.2 ビットマップと commit-graph

- 全てのリポジトリで、multi-pack index のビットマップと commit-graph を保守で作る（[git-storage.md](git-storage.md) の 8 節）。clone で送る objects の集合を、履歴を歩かずに求められる。
- fetch の交渉（`have` と `ack`）は、commit-graph で速くなる。交渉の回数と時間に上限を置く（8 節）。

### 6.3 パックのキャッシュ

- 同じ内容の clone・fetch（同じ `want`・`have`・`filter`・capability）が、短い時間に繰り返される（CI、ボット）。ストレージのノードに、`pack-objects` の出力のキャッシュを置く。キーは、要求の内容と、リポジトリのチェックサムのハッシュ。
- 同時に来た同じ要求は、1 つの `pack-objects` の出力を共有する（1 つが書き、他はそれを読みながら追う）。
- キャッシュはローカルの NVMe に置き、既定で 5 分で捨てる。容量の上限を超えたら古いものから捨てる。
- GitLab の Gitaly の pack-objects cache が同じ考え方（[Gitaly の pack-objects cache](https://docs.gitlab.com/administration/gitaly/configure_gitaly/#pack-objects-cache)）。本家 GitHub が同じ仕組みを持つかは公開情報で確かめられない（**未検証**。docs.github.com と GitHub のブログに記述がない。本家に寄せる対象ではなく、この設計の判断とする）。
- 非公開のリポジトリのキャッシュは、要求ごとの認可を経た後にしか読まない。キーにリポジトリの ID を含め、リポジトリをまたいで共有しない。

### 6.4 bundle-uri と CDN

- clone の数の多い公開のリポジトリ（上位の一定数。基準は [capacity.md](capacity.md)）について、定期に bundle を作り、S3 に置いて CloudFront で配る。v2 の `bundle-uri` のコマンドで、bundle の一覧を広告する（[bundle-uri](https://git-scm.com/docs/bundle-uri)）。
- bundle の一覧は `heuristic = creationToken` にし、週に 1 度の全体の bundle と、日ごとの増分の bundle を並べる。クライアントは新しいものから取り、足りたら止める。残りの差分だけを、ストレージのノードから fetch する。
- クライアントが bundle-uri を使うのは、`transfer.bundleURI` を有効にした場合だけ（Git の既定では無効）。したがって、効果は CI・ボット・大量の clone を行う利用者への案内に依る。一般の clone の負荷は、6.2・6.3 で下げる。
- 非公開のリポジトリには bundle-uri を使わない（CDN の認可の仕組みが別に要る。MVP の外）。
- packfile-uris（パックの一部を CDN から取らせる別の仕組み）は使わない。bundle-uri のほうが、静的なファイルとして扱えて運用が単純。
- 本家は bundle-uri を github.com で広告していない（2026-09-26 に `GIT_TRACE_PACKET=1 git ls-remote` で観測。v2 の capability は `ls-refs=unborn`、`fetch=shallow wait-for-done filter`、`server-option`、`object-format=sha1` で、`bundle-uri` はない。文書での記述はない）。bundle-uri はここでは本家との違いになるが、クライアントの既定で無効のため互換に影響しない。Git の側の仕様は [gitprotocol-v2 の bundle-uri](https://git-scm.com/docs/gitprotocol-v2#_bundle_uri)（サーバーは `uploadpack.advertiseBundleURIs` で広告する）。

### 6.5 partial clone と shallow clone

- partial clone を受け付ける（`uploadpack.allowFilter`）。許す filter は `blob:none`、`blob:limit=<n>`、`tree:0`、`sparse:oid` は受け付けない（任意の objects を sparse の指定として読ませると、費用が読めない）。[partial-clone](https://git-scm.com/docs/partial-clone)。
- partial clone の後で足りない blob を取る要求（promisor の fetch）は、1 回に多数の blob を求めることがある。1 回の要求の objects の数に上限を置く。
- shallow clone も受け付ける。本家は、CI 以外の用途では shallow より partial clone を勧めている。shallow の後の fetch はサーバーの計算が重くなりうるため（[Get up to speed with partial clone and shallow clone](https://github.blog/open-source/git/get-up-to-speed-with-partial-clone-and-shallow-clone/)）。CI（Actions の checkout）は shallow を既定にする。

### 6.6 アーカイブ

- `git-upload-archive` と、Web・API の tarball・zip のダウンロードは、同じ `gitd` の RPC で作る。後者は Web・API の側の経路で、結果を短時間 CDN にキャッシュする（[web.md](web.md)）。

## 7. LFS

詳細な選択肢と理由は [ADR-0009](../decisions/0009-lfs-storage-on-s3.md)。

### 7.1 batch API

- 本家と同じく、`https://<host>/<owner>/<repo>.git/info/lfs/objects/batch` で batch API を受ける（[LFS batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)）。フロントエンドが受け、認証・認可（download は read、upload は write）を行う。
- 転送は `basic` を受け付ける。`hash_algo` は `sha256` だけ。
- 応答の `actions` は S3 の presigned URL にする。
  - `download`：GET の presigned URL。有効期限は 1 時間。
  - `upload`：PUT の presigned URL。`x-amz-checksum-sha256`（oid を base64 にした値）を応答の `header` に入れ、署名に含める。S3 は受け取った中身の SHA-256 を計算し、ヘッダーと違えば拒否する（[Checking object integrity](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html)）。LFS のクライアントは、`actions.upload.header` の全ての項目を PUT に付ける（[batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md)、[tq/adapterbase.go](https://github.com/git-lfs/git-lfs/blob/main/tq/adapterbase.go)。2026-09-26 に確認）。`Content-Type` を署名に含めるなら、クライアントが自分で推定しないよう `header` に入れる。presigned URL の署名にチェックサムのヘッダーを含められることは S3 の文書に明記がないので、E3 の `lfs-batch-api` で結合テストにする。
  - `verify`：アップロードの後に、フロントエンドが S3 の object の存在・大きさ・チェックサムを確かめ、LFS の object の表に登録する。
- すでにある object への `upload` には、`actions` を返さない（クライアントは転送を省く）。
- 1 回の batch の objects の数は 100 までにする。

### 7.2 SSH から使うとき

- `git-lfs-authenticate <path> <download|upload>` に、HTTPS の LFS の URL と、短命（10 分）のトークンを付けたヘッダーを返す（[LFS の認証](https://github.com/git-lfs/git-lfs/blob/main/docs/api/authentication.md)）。トークンは、その 1 つのリポジトリと操作にだけ使える。
- SSH の上で LFS を転送する `git-lfs-transfer` は MVP の外。

### 7.3 保存

- S3 のキーは `lfs/<network_id>/<oid の先頭 2 文字>/<oid>`。同じネットワーク（fork）の中で共有し、ネットワークをまたいで共有しない（非公開の中身が、oid を知っているだけで他のネットワークから読めないように）。
- ネットワークの分割（[git-storage.md](git-storage.md) の 7.2 節）のときは、分けた先のネットワークの LFS の objects もコピーする。
- 暗号化は SSE-KMS。バケットは公開せず、presigned URL でだけ読み書きする。
- 別のリージョンへ複製（CRR）する。

### 7.4 上限と削除

- 1 つの object の大きさの上限は、S3 の 1 回の PUT の上限の 5 GB 以内でプランごとに決める。本家もプランごとに LFS の上限を持つ（[About Git Large File Storage](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)）。本家の 1 ファイルの上限は、Free・Pro 2 GB、Team 4 GB、Enterprise Cloud 5 GB（同上、2026-09-26 に確認）。本システムの値は MVP の後のプランの設計で決め、それまでは 2 GB とする。
- 容量と転送量を、リポジトリの持ち主のアカウントごとに数える。上限を超えたら、upload を 403（理由付き）で拒否する。download の超過の扱いは、プランの設計で決める。
- 使われなくなった LFS の objects を、履歴を走査して消すことはしない。本家と同じく、LFS の objects を消すには、リポジトリを削除する（[Removing files from Git LFS](https://docs.github.com/en/repositories/working-with-files/managing-large-files/removing-files-from-git-large-file-storage)）。ネットワークの全てのリポジトリが消えたら、そのネットワークの LFS の objects を、復元の期間（90 日）の後に消す。
- ファイルのロック（LFS の Locking API）は MVP の外。

## 8. レート制限と濫用対策

横断のレート制限の仕組みは [api-and-webhooks.md](api-and-webhooks.md) と [security.md](security.md) にある。Git の経路に固有のものを挙げる。

| 対象 | 制限 | 超えたとき |
| --- | --- | --- |
| 認証なしの読み取り（IP ごと） | 認証ありより低い上限（本家も 2025 年に認証なしの clone の制限を強めた。[Updated rate limits for unauthenticated requests](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/)） | HTTPS は 429、SSH は認証なしがないので対象外 |
| リポジトリごとの読み取り | 本家の目安（毎秒 15 件）を基準に、同時の `pack-objects` の数で制限する | 待ち行列に入れ、一定時間を超えたら「混雑」として拒否 |
| リポジトリごとの push | 本家の目安（毎分 6 回）を基準にする | 待たせてから拒否 |
| ストレージのノードごと | 同時の `pack-objects` の数と CPU の使用率 | 新しい要求を同じネットワークの他の複製へ回す。全てが上限なら拒否 |
| 交渉 | fetch の交渉の往復と時間に上限 | 打ち切り、クライアントに理由を返す |
| 認証の失敗 | 同じ IP・鍵・トークンの失敗の回数 | 一時的に拒否 |

- 数値は [Repository limits](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits) の本家の目安から始め、[capacity.md](capacity.md) のパラメーターにする。
- clone の嵐（CI の大量の並列 clone、AI の学習のための収集）は、6.3 のキャッシュ、6.4 の bundle-uri、認証なしの制限で吸収する。
- **公開リポジトリの大量の clone への帯域とコストの対策**（intent.md の未解決の問い）は、次の 2 つに決めた（2026-09-26、既定案。[README.md](README.md) の 6 節）。
  - 人気の公開リポジトリは bundle-uri と CDN で配る（6.4 節）。
  - リポジトリごと・IP ごとの clone のレート制限をかける（値は [capacity.md](capacity.md) の 4 節）。
  - 利用者ごとの帯域の課金は MVP に含めない。E9 の負荷試験と外向きの転送の費用の実績を見て、必要なら課金の Epic で扱う。
- 保存を目的とした濫用（巨大なリポジトリをファイルの置き場として使う）は、12 節の上限（[git-storage.md](git-storage.md)）と、容量の監視で見つける。
- 不正な objects（極端に深いツリー、巨大な delta の鎖、zip bomb に相当するもの）は、fsck と、`index-pack` の資源の上限（メモリ、時間）で止める。

## 9. タイムアウト

| 層 | 設定 | 理由 |
| --- | --- | --- |
| NLB（SSH） | TCP のアイドルタイムアウトは既定（350 秒）のままにし、SSH の keepalive を 60 秒で送る（[infrastructure.md](infrastructure.md) の 2.1 節） | 大きなパックの生成の間も、keepalive で接続を保つ。NLB のアイドルタイムアウトは 60〜6,000 秒で変えられるので、足りなければ延ばす |
| ALB（HTTPS） | アイドルタイムアウトを 600 秒 | 同上。ALB の上限は 4,000 秒 |
| `upload-pack` | `uploadpack.keepAlive` を 5 秒（Git の既定） | パックの準備の間も keep-alive のパケットを送り、途中の機器にアイドルとみなされないようにする |
| フロントエンド（読み取り） | 1 つの転送の最大 6 時間。30 分の間に 1 バイトも進まなければ切る | 非常に大きなリポジトリの clone を許しつつ、止まった接続を回収する |
| フロントエンド（push） | パックの受信の最大 1 時間。検査と合意は 5.3 節の予算 | 2 GB の push を遅い回線でも受ける |
| SSH の認証 | 接続から認証の完了まで 30 秒 | 認証しない接続を溜めない |
| フロントエンドとノードの gRPC | ストリームごとの期限を上の値に合わせる。ノードは、フロントエンドが切ったら `git` の子プロセスを止める | 孤児のプロセスを残さない |

### デプロイと長い転送

- フロントエンドの入れ替えで、進行中の長い clone・push が切れうる。登録解除の遅延を 15 分にし、その間は新しい接続を受けず、進行中の転送を続ける。15 分を超える転送は切れ、クライアントの再試行に頼る（ADR-0004 の Confirmation）。
- ECS の EC2 起動タイプの `stopTimeout` には、文書上の上限がない（Fargate は 2〜120 秒。未設定なら ECS エージェントの `ECS_CONTAINER_STOP_TIMEOUT`、どちらもなければ 30 秒。[ContainerDefinition](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html)、2026-09-26 に確認）。NLB は、登録解除した target に新しい接続を送らず、target が健全でアイドルでなければ既存の接続の通信を続ける。登録解除の遅延（既定 300 秒）が過ぎると `unused` になり、`deregistration_delay.connection_termination.enabled` を有効にしたときだけ既存の接続を閉じる（[Deregistration delay](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html#deregistration-delay)、同日に確認）。したがって、登録解除の遅延を 900 秒、`stopTimeout` を 900 秒にし、接続の終了は有効にする。実際に 15 分の転送が切れずに終わるかは、E1 の `frontend-drain-poc`（staging）で確かめる。足りなければ、フロントエンドを EC2 の Auto Scaling グループのライフサイクルフックで入れ替える方式に替える。
- ストレージのノードの `gitd` の入れ替えは、読み取りの静止（[git-storage.md](git-storage.md) の 6.3 節）で、新しい要求を他の複製へ回してから行う。

## 10. 障害と振る舞い

| 障害 | 起きること | 検知 | 回復 |
| --- | --- | --- | --- |
| フロントエンドのタスクが落ちる | そのタスクの転送が切れる | ALB・NLB のヘルスチェック | クライアントが再試行する。push は、合意の途中なら git-storage.md の 5.3 の回収 |
| identity のサービスが遅い・落ちる | 新しい認証が失敗する | 認証の遅延とエラー率 | キャッシュ済みの鍵とトークンで続ける（失効の反映は遅れる。最大 60 秒） |
| policy のサービスが落ちる | ルールの対象になりうる ref への push が拒否される | 評価の RPC のエラー率 | fail closed。ルールのない ref への push は続く |
| 1 つの複製が遅れている | その複製から読まない | チェックサムの不一致 | 他の複製で読む。修復が走る |
| clone の嵐 | ノードの CPU が埋まる | 同時の `pack-objects` の数 | キャッシュ、制限、複製への分散。持続するなら bundle-uri の対象にする |
| S3 の障害（LFS） | LFS の転送が失敗する。LFS の pointer を含む push が 7 の検査で拒否される | S3 のエラー率 | S3 の回復を待つ。検査を一時的に緩めるかは runbook で人が決める |

## 11. 監視する指標

- Git の要求：プロトコル（SSH・HTTPS）・操作（clone・fetch・push）ごとのレート、エラー率、fetch の開始までの時間（NFR-003）
- push：検査の区間ごとの遅延、拒否の理由ごとの件数（大きさ、ルール、fail closed）、合意の遅延
- upload-pack：同時の `pack-objects` の数、パックのキャッシュのヒット率、bundle-uri の配信数、制限による拒否の数
- LFS：batch の遅延、presigned URL の発行数、verify の失敗、容量と転送量
- 接続：タイムアウトで切った数、デプロイで切れた転送の数

## 12. 未検証の事項

| 事項 | 確かめ方 | 時期 |
| --- | --- | --- |
| ~~LFS のクライアントが `x-amz-checksum-sha256` を PUT に付けるか~~ | 2026-09-26 に確認：付ける（7.1 節）。presigned の署名に含める動作は E3 の結合テストで固定する | E3 |
| ~~本家が bundle-uri を広告しているか~~ | 2026-09-26 に観測：広告していない（6.4 節） | — |
| 本家のパックのキャッシュの有無 | 公開情報では確かめられない（**未検証**）。この設計の判断とする | — |
| NLB の登録解除の後の接続の扱い、ECS の EC2 起動タイプの停止猶予（15 分） | 文書は 2026-09-26 に確認（9 節）。15 分の転送が実際に保たれるかを staging の PoC で確かめる | E1 |
| ~~本家の LFS のプランごとの上限~~ | 2026-09-26 に確認（7.4 節）。本システムの値はプランの設計で決める | MVP の後のプランの設計 |
| ~~v2 の `fetch` で広告していないハッシュの `want` の扱い~~ | 2026-09-26 に確認：v2 は検査しない（[git-storage.md](git-storage.md) の 7.2 節）。非公開のネットワークでの検査の費用は E1 の PoC で測る | E1・E3 |

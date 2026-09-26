# Actions: GitHub

CI（本家の GitHub Actions に相当）。ワークフローの解釈、実行とジョブの状態、スケジューリング、実行環境（ランナー）の隔離、シークレット、`<BRAND>_TOKEN`、OIDC、ログ、成果物とキャッシュ、セルフホストのランナー、アクションの解決、濫用対策。

この文書の決定は次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0023](../decisions/0023-firecracker-microvm-runners.md) | ホストされたランナーは、EC2 の metal の上の Firecracker の microVM で、1 ジョブ 1 VM・使い捨てにする |
| [0024](../decisions/0024-job-scheduling-and-fairness.md) | ジョブは持ち主ごとの同時実行の上限と、持ち主の間の公平な順番で配る |
| [0025](../decisions/0025-secrets-and-fork-pr-policy.md) | シークレットはジョブの取得時にだけ復号して渡し、fork の Pull Request には渡さない。`<BRAND>_TOKEN` はジョブごとの最小の権限にする |
| [0026](../decisions/0026-actions-oidc-provider.md) | 自前の OIDC の発行者を持ち、ジョブごとの短命の ID トークンを KMS の鍵で署名する |
| [0027](../decisions/0027-artifact-and-cache-storage.md) | 成果物・キャッシュ・ログは S3 にリポジトリ単位で置き、キャッシュは ref の単位で分ける |

前提となる決定は、権限の判定関数（[ADR-0002](../decisions/0002-repository-permission-model.md)）、ref の更新の Event（[ADR-0005](../decisions/0005-git-as-source-of-truth.md)）、基盤（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 1. 原則

- **本家に寄せる。** ワークフローの構文、イベント、`permissions`、`concurrency`、環境の保護の規則、OIDC の claim、キャッシュの範囲は、本家の仕様と同じ意味にする。利用者が本家のワークフローを、名前の置き換えだけで持ち込めることを目標にする。本家の名前を含む識別子（`.github/` のパス、`GITHUB_*` の環境変数、`github` の文脈、`github-actions[bot]`）は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従い `.<brand>/`・`<BRAND>_*`・`<brand>`・`<brand>-actions[bot]` にする。置き換えは移行の道具で機械的に行う。違えるところは、この文書に理由を書く。
- **ジョブのコードは、常に信頼できない。** 公開リポジトリでは誰でも Pull Request を出せる。ジョブを「悪意のある人が書いたコード」として扱い、隔離・シークレット・トークンを設計する。
- **1 ジョブ 1 VM、再利用しない。** ホストされたランナーの VM は、1 つのジョブを実行したら壊す（ADR-0023）。
- **秘密は、必要なジョブに、必要な間だけ渡す。** シークレットは保存時に暗号化し、ジョブの取得の瞬間にだけ復号する。DB のジョブの記録やログに平文を残さない（ADR-0025）。
- **ランナーから見える資格情報は、ジョブの範囲に閉じる。** ランナーが持つのは、そのジョブにだけ効く短命のトークン（ジョブトークン、`<BRAND>_TOKEN`、OIDC のトークン）だけにする。
- **読み書きは権限の判定関数を通す。** ログ・成果物・キャッシュ・実行の一覧の読み取りは、ADR-0002 の `can()` を通す。非公開のリポジトリのログや成果物が、権限のない人に見えない（NFR-010）。

## 2. 全体の流れ

```
push・PR・Issue・schedule・dispatch
        │ outbox（ADR-0005）→ SQS
        ▼
 ワークフローの評価（Workflow Evaluator）── Git ストレージの RPC で .<brand>/workflows/*.yml を読む
        │ workflow_runs・workflow_jobs を作る（Aurora）
        ▼
 スケジューラ（Scheduler）── 持ち主ごとの同時実行の上限・concurrency グループ・環境の保護
        │ 実行できるジョブを「配れる」状態にする
        ▼
 ブローカー（Broker）◀── long poll（最大 50 秒）── ランナーのエージェント（microVM の中 / セルフホスト）
        │ ジョブのメッセージ（ステップ、解決済みのアクション、シークレット、<BRAND>_TOKEN、ジョブトークン）
        ▼
 ランナー ── ログ ──▶ ログの取り込み ──▶ ライブ表示（Valkey）／S3（確定したログ）
          ── 成果物・キャッシュ ──▶ 署名付き URL で S3 に直接
          ── OIDC の要求 ──▶ OIDC の発行者（KMS で署名）
          ── 状態の更新 ──▶ Broker ──▶ チェック（check run）・Webhook・通知
```

| コンポーネント | 責務 | 実装 |
| --- | --- | --- |
| Workflow Evaluator | イベントを受け、対象のコミットのワークフローを読み、`on` の条件を評価し、実行とジョブを作る | Worker（TypeScript） |
| Scheduler | ジョブの依存（`needs`）、concurrency、環境の保護、持ち主ごとの上限を見て、ジョブを配れる状態にする | Worker（TypeScript）。S2 で持ち主のハッシュで分割 |
| Broker | ランナーとのプロトコルの終端。long poll、ジョブの割り当て、状態・心拍の受け取り | Go（長時間の接続を多数持つ） |
| Fleet Manager | ホストされたランナーの metal のホストと microVM の起動・破棄、待機中の VM の数の調整 | Go。ホストごとのエージェントと、全体の制御 |
| Secrets service | シークレットの保存（暗号文）と、ジョブの取得時の復号 | Go。KMS の復号の権限はこのサービスだけが持つ |
| Token service | `<BRAND>_TOKEN`（インストールのトークン）とジョブトークンの発行・失効 | API の一部（[api-and-webhooks.md](api-and-webhooks.md) の App の仕組み） |
| OIDC issuer | ID トークンの発行、`/.well-known/openid-configuration` と JWKS の公開 | Go。署名は KMS |
| Log service | ログの取り込み、マスクの二重の確認、ライブ配信、S3 への確定 | Go |
| Artifact・Cache service | 成果物・キャッシュのメタデータ、署名付き URL の発行、保持期間の削除 | TypeScript |

## 3. ワークフローの解釈と評価

### 3.1 起動

| イベント | ワークフローを読むコミット | `<BRAND>_SHA` / `<BRAND>_REF` | 備考 |
| --- | --- | --- | --- |
| `push` | push された ref の新しいコミット | 同じ | ref の更新の Event（ADR-0005）から起動する |
| `pull_request` | PR のマージコミット（`refs/pull/N/merge`） | マージコミット / `refs/pull/N/merge` | fork からのときは、シークレットなし・読み取りだけの `<BRAND>_TOKEN`（6 節） |
| `pull_request_target` | ベースのリポジトリのデフォルトブランチ | デフォルトブランチの最新 / デフォルトブランチ | 公開リポジトリでは既定で止める（6.4 節） |
| `schedule` | デフォルトブランチの最新 | 同じ | 最短 5 分間隔。毎時 0 分は混むので、遅れを許す |
| `workflow_dispatch`・`repository_dispatch` | 指定の ref / デフォルトブランチ | 同じ | API から起動 |
| `workflow_run`、`issues`、`issue_comment` など | デフォルトブランチ | 同じ | 秘密を持つ実行なので、PR のコードを取り込むと危ない（6.4 節） |

本家の仕様：[Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。

- **`<BRAND>_TOKEN` で起こしたイベントからは、原則として実行を作らない。** 本家と同じく、`workflow_dispatch` と `repository_dispatch` を除く。PR を `<BRAND>_TOKEN` で作った・更新したときの `pull_request` は、書き込みの権限のある人の承認を待つ実行にする（本家の挙動）。無限の連鎖を防ぐ。
- **受け付けの制限**：本家の制限（リポジトリあたり 10 秒に 1,500 イベント、全体で 10 秒に 500 実行の作成）に倣い、リポジトリごとのトークンバケットで絞る（[Actions limits](https://docs.github.com/en/actions/reference/limits)）。

### 3.2 解釈

1. Evaluator は、Git ストレージの RPC で、対象のコミットの `.<brand>/workflows/*.yml`・`*.yaml` の一覧と中身を読む。1 ファイル 500 KB を超えるものは実行を作らない（本家と同じ）。
2. YAML を構文木にし、スキーマ（本家のワークフローの構文）で検証する。失敗したら、実行を `startup_failure` の結論で作り、画面に理由を出す。
3. `on` の条件（`branches`・`paths`・`types`）を評価する。`paths` はイベントの差分のファイルの一覧で評価する（push は前後の ref、PR はマージベースとの差分）。
4. 呼び出す再利用可能なワークフロー（`jobs.<id>.uses`）を解決する。深さは 10 段まで、1 つのワークフローから呼べる種類は 50 まで（本家の github.com の値。[Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations)）。呼ばれる側の `<BRAND>_TOKEN` の権限は、呼ぶ側と同じか狭いものにする。
5. 解釈の結果（ジョブのグラフ、静的に決まる値）を「実行計画」として `workflow_runs.plan`（JSONB）に保存する。以降の再実行は、この計画を使う（ワークフローのファイルを読み直さない）。

### 3.3 式の評価の段階

| 段階 | 使える文脈 | 評価する場所 |
| --- | --- | --- |
| 実行の作成時 | `<brand>`（本家の `github` の文脈）、`inputs`、`vars` | Evaluator（`run-name`、ワークフローの `concurrency`） |
| ジョブを配る前 | 上に加えて `needs`、`matrix`、`strategy` | Scheduler（`if`、`runs-on`、ジョブの `concurrency`、`environment`、`matrix` の展開） |
| ジョブの中 | 上に加えて `secrets`、`env`、`steps`、`job`、`runner` | ランナー（ステップの `if`、`with`、`run` の埋め込み） |

- **`secrets` をサーバーの側の式で評価しない。** `if` や `runs-on` にシークレットを使うことは、本家と同じく許さない。サーバーの記録に平文が残る経路をなくす。
- `matrix` の展開はジョブあたり 256 まで（本家と同じ）。
- 式の評価器は、TypeScript（サーバー）とランナーの側の 2 つになる。同じテストのコーパス（入力の式と期待の結果）で両方を検査する。

## 4. 実行とジョブの状態

### 4.1 実行（workflow run）

```
requested ──▶ queued ──▶ in_progress ──▶ completed
    │            │  ▲
    │            ▼  │
    │         pending（concurrency の待ち）
    ▼
 action_required（fork の PR の承認待ち） ──承認──▶ queued
```

- 結論（`conclusion`）は `success`・`failure`・`cancelled`・`skipped`・`timed_out`・`action_required`・`startup_failure`・`neutral`。本家の [Checks API](https://docs.github.com/en/rest/checks/runs) の値にそろえる。
- 実行の最長は 35 日（本家と同じ）。超えたら `cancelled` にする。
- 再実行は 1 つの実行につき 50 回まで。再実行は `run_attempt` を増やし、ジョブを作り直す。

### 4.2 ジョブ

```
created ──▶ waiting（環境の保護） ──▶ queued ──▶ assigned ──▶ in_progress ──▶ completed
   │            │ 否認・期限切れ                  │ 受け取り期限切れ │ 心拍の途絶
   │            ▼                                  ▼                ▼
   │         completed(failure)               queued へ戻す     completed(failure, runner_lost)
   ▼
 skipped（needs の失敗・if が偽）
```

| 遷移 | 条件 | 担当 |
| --- | --- | --- |
| created → waiting | `environment` があり、保護の規則がある | Scheduler |
| created/waiting → queued | `needs` がすべて完了し、`if` が真、環境の規則を満たした、concurrency に空きがある | Scheduler |
| queued → assigned | ランナーの long poll に渡した | Broker |
| assigned → in_progress | ランナーが受け取りを確認した（60 秒以内） | Broker。確認がなければ queued に戻す |
| in_progress → completed | ランナーが結果を報告した | Broker |
| in_progress → completed(failure) | 心拍が 5 分途絶えた、実行時間の上限（ホスト 6 時間、セルフホスト 5 日）を超えた | Broker の監視 |

- **状態の遷移は DB の条件付き更新（`UPDATE ... WHERE state = $expected`）で行う。** 同じジョブを 2 つのランナーに渡さない。
- **assigned から queued に戻すのは、ランナーがまだ受け取りを確認していないときだけ。** ホストされたランナーでは、戻す前に該当の VM を壊す（受け取ったのに確認が届かなかった場合に、同じジョブが 2 回動くのを防ぐ）。
- **ジョブの完了は outbox に書く。** チェック（check run）の更新、Webhook（`workflow_job`・`workflow_run`・`check_run`）、通知、`needs` で待つジョブの評価は、outbox から非同期に行う。
- 各ジョブは、対象のコミットのチェック（check run）を 1 つ持つ。ブランチの保護の必須のチェックは、これを見る（[pull-requests.md](pull-requests.md)）。

### 4.3 concurrency

- `concurrency.group` の式を評価した文字列を、リポジトリの範囲のキーにする（`(repo_id, group)`）。本家と同じく、グループはリポジトリの中でだけ効く。
- 同時に `in_progress` は 1 つ。`pending` は既定で 1 つ（新しいものが来たら古い `pending` を `cancelled` にする）。`queue: max` のときは 100 まで待たせる。`cancel-in-progress: true` のときは、実行中のものを取り消す。`queue: max` と `cancel-in-progress: true` の組み合わせは検証の誤りにする（本家の現行の仕様。[Workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)）。
- グループの状態は `concurrency_groups` の 1 行に持ち、行ロックで順序を決める。

## 5. スケジューリングと公平性

決定は [ADR-0024](../decisions/0024-job-scheduling-and-fairness.md)。

### 5.1 持ち主ごとの同時実行の上限

本家のプランごとの上限（[Actions limits](https://docs.github.com/en/actions/reference/limits)）に寄せる。持ち主（ユーザーまたは Organization）単位で数える。

| プラン | 同時に実行するジョブ（標準の Linux） |
| --- | --- |
| Free | 20 |
| Pro | 40 |
| Team | 60 |
| Enterprise | 500 |

- macOS・GPU・大きなランナーは MVP で扱わない（ADR-0023）。
- 上限は `owner_actions_limits` に持ち、サポートの判断で個別に引き上げられる。
- セルフホストのランナーのジョブは、この上限に数えない（本家と同じ）。セルフホストのジョブの待ちは、ランナーの側の数で決まる。キューで 24 時間待ったら取り消す。

### 5.2 キューの形

```
ラベル（ubuntu-latest など）ごとに
  持ち主ごとの FIFO（ジョブの queued の時刻順）
      ↓ 上限に空きのある持ち主だけが候補
  持ち主の間は、重み付きの Deficit Round Robin
      ↓
  Broker が long poll 中のランナー（待機中の VM）に渡す
```

- **持ち主の中は FIFO、持ち主の間は順番に回す。** 1 つの持ち主が大量のジョブ（matrix の 256 本など）を積んでも、他の持ち主のジョブが後ろで待ち続けない。
- 重みは、プランで少し差を付ける（Enterprise を大きく）。ただし Free の持ち主が飢えない下限を持つ。重みの値は負荷試験で決める。
- キューは Aurora の `workflow_jobs` を正本とし、配る順番の計算は Scheduler が Valkey の上の持ち主ごとのリストで行う。Valkey を失っても、DB の `queued` のジョブから作り直せる。
- **全体の過負荷**：待機中の VM が尽き、新しい VM の起動も追いつかないときは、ジョブは queued のまま待つ。NFR-007（開始まで p95 60 秒）を外れる前に、Fleet Manager が metal のホストを増やす（8.5 節）。

### 5.3 環境の保護の規則による待ち

- `environment` を参照するジョブは、規則を満たすまで `waiting` にする（[Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)）。
  - 必須のレビュアー：最大 6 人またはチーム。1 人の承認で進む。レビュアーはリポジトリの読み取りの権限が要る。
  - 待ち時間：1〜43,200 分（30 日）。待ち時間は課金の分に数えない。
  - デプロイできるブランチ・タグ：`<BRAND>_REF` をパターンで照合する。
  - 独自の規則：App（本家の GitHub App に相当）で外部に判断を問う（[api-and-webhooks.md](api-and-webhooks.md)）。
- 環境のシークレットは、規則を満たした後のジョブの取得時にだけ渡す（7 節）。
- 本家では、Free・Pro・Team の非公開のリポジトリで一部の規則が使えない。プランによる機能の制限も本家に合わせる。

## 6. シークレット、`<BRAND>_TOKEN`、fork の Pull Request

決定は [ADR-0025](../decisions/0025-secrets-and-fork-pr-policy.md)。

### 6.1 シークレットの保存

- 置き場所は Organization・リポジトリ・環境の 3 つ。上限は本家と同じ（Organization 1,000、リポジトリ 100、環境 100、1 つ 48 KB。[Secrets reference](https://docs.github.com/en/actions/reference/security/secrets)）。
- **API の利用者は、リポジトリ（または Organization）の公開鍵で暗号化して送る。** 本家の REST API と同じく、libsodium の sealed box を使う。平文は API のサーバーを通らない。
- 公開鍵に対応する秘密鍵は、持ち主ごとのデータ鍵として KMS で暗号化して保存する（エンベロープ暗号化）。復号の権限（`kms:Decrypt`）は Secrets service の IAM ロールだけに与える。
- 画面や API は、シークレットの値を返さない。名前と更新日時だけを返す。

### 6.2 ジョブへの渡し方

```
Broker ── ジョブを渡す直前 ──▶ Secrets service：run_id・job_id・環境 を示して要求
                                 1. 渡してよいかを判定（6.3 節の表）
                                 2. 必要なシークレットだけを復号（ワークフローが参照する名前だけ）
◀── 平文のシークレット（メモリの上だけ）
Broker ── TLS ──▶ ランナー（ジョブのメッセージの中）
```

- ジョブのメッセージに入れるのは、そのジョブのワークフローが `secrets.<name>` で参照するものだけにする（参照の一覧は、実行計画を作るときに抜き出す）。
- 平文を DB・キュー・ログに書かない。Broker はメッセージを送った後にメモリから捨てる。
- Log service がマスクの二重の確認（9.2 節）に使うために、そのジョブのシークレットの値の「ハッシュ（固定長の部分文字列の HMAC）」だけを、ジョブの間 Valkey に置く（**未検証** の設計。本家は方式を公開していないので、E8 の `log-mask-double-check` の PoC で誤検出と漏れの率を測る）。

### 6.3 渡してよいかの表

| 起動 | シークレット | `<BRAND>_TOKEN` | OIDC の ID トークン | 承認 |
| --- | --- | --- | --- | --- |
| 同じリポジトリのブランチからの `push`・`pull_request` | 渡す | ワークフローの `permissions` の範囲 | `id-token: write` があれば出す | 不要 |
| fork からの `pull_request`（公開リポジトリ） | **渡さない** | **読み取りだけ** | **出さない** | 初めての貢献者などは、書き込みの権限のある人の承認（`action_required`） |
| fork からの `pull_request`（非公開のリポジトリ） | 既定では実行しない。設定で許すと、シークレットと書き込みのトークンを渡すかを別々に選べる | 同左 | 同左 | 同左 |
| `pull_request_target` | 渡す（デフォルトブランチのワークフロー） | ワークフローの `permissions` の範囲 | 出す | 公開リポジトリでは既定で止める（6.4 節） |
| Dependabot に相当するもの | MVP の外 | — | — | — |

- 本家の記述：「<BRAND>_TOKEN を除き、fork のリポジトリから起動したワークフローのランナーには、シークレットは渡されない。<BRAND>_TOKEN は fork からの PR では読み取りだけ」（[Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)）。
- fork からの `pull_request` で OIDC のトークンを出さないのは、本家の仕組みからの推論である。本家は、fork の PR では `permissions` で書き込みの権限を通常は付与できない（「Send write tokens to workflows from pull requests」の設定を有効にしたときを除く）とし（[Workflow syntax の `permissions`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)、2026-09-26 に確認）、OIDC は `id-token: write` を要する。「fork の PR では OIDC を出さない」とだけ書いた文は見つからない（**未検証**。推論の前提は確かめた。本システムは、書き込みのトークンを fork の PR に送る設定を持たないので、常に出さない）。
- fork の PR の承認の方針は、本家の 3 つの選択肢（GitHub を使い始めたばかりの初めての貢献者 / 初めての貢献者 / 外部のコラボレーター全員）をリポジトリ・Organization の設定に持つ。既定は本家に合わせ、中間（初めての貢献者）にする（本家の既定も同じ。[Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository)、2026-09-26 に確認）。

### 6.4 `pull_request_target` と、秘密を持つ実行でのコードの取り込み

- `pull_request_target` は、ベースのリポジトリのデフォルトブランチのワークフローを、シークレットと書き込みのトークン付きで実行する。PR のコードをチェックアウトして実行すると、攻撃者のコードが秘密を持って動く（本家のいう pwn request。[Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)）。
- **公開リポジトリでは、`pull_request_target` を既定で止める。** 本家は 2026 年に、公開リポジトリで `pull_request_target` を止める既定のポリシーを導入し、2026-11-02 に強制する予定である（同ページ）。これに合わせ、最初から強制の状態で出す。明示的にポリシーで許したリポジトリだけ実行する。
- 本家と同じく、SHA に似た名前のブランチからは `pull_request_target` を起動しない。
- `pull_request_target`・`workflow_run`・`issue_comment` のような秘密を持つ実行は、デフォルトブランチのキャッシュの範囲を使う（10.2 節）。キャッシュの汚染の経路になるので、PR のコードや fork の成果物を実行することを、ワークフローの静的な検査で警告する（MVP の後。候補）。

### 6.5 `<BRAND>_TOKEN`

- ジョブごとに、そのリポジトリに対する組み込みの App のインストールのトークンを発行する（本家と同じ仕組み。[本家の GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)）。
- 権限は次の最小を取る。
  1. ワークフロー・ジョブの `permissions`（書かなければ、リポジトリ・Organization の既定）
  2. リポジトリ・Organization の既定の上限。**新しい Organization・リポジトリの既定は `contents: read` だけにする**（本家の推奨に沿う。[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)）
  3. fork の PR なら読み取りだけ（6.3 節）
  4. 再利用可能なワークフローなら、呼ぶ側の権限以下
- 期限はジョブの完了まで。最長はホストのジョブの上限の 6 時間。セルフホストでは、本家と同じく 24 時間を超えて延ばさない。ジョブの完了時に Token service が失効させる（期限を待たない）。
- API のレート制限は、本家と同じくリポジトリあたり 1 時間に 1,000 件（Enterprise は 15,000 件）。
- `<BRAND>_TOKEN` で行った push などは、新しいワークフローの実行を作らない（3.1 節）。

### 6.6 ジョブトークン

- ランナーが Broker・Log service・Artifact・Cache service・OIDC issuer を呼ぶための資格情報。`<BRAND>_TOKEN` とは別にする（利用者のステップから見えない場所に置く。**ただし同じ VM の中で動くので、ステップのコードからは読めると想定する**）。
- 中身：`run_id`、`job_id`、`repo_id`、キャッシュの読み書きの範囲、`id-token` の許可、失効の時刻。短命（ジョブの上限＋余裕）で、ジョブの完了時に失効の表に載せる。
- ジョブトークンでできることは、そのジョブの範囲に閉じる。他のジョブのログ・成果物・キャッシュの範囲に触れない（性質ベーステストで確かめる）。

## 7. OIDC の発行者

決定は [ADR-0026](../decisions/0026-actions-oidc-provider.md)。本家の仕様：[OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)。

- 発行者（`iss`）：`https://token.actions.<本番のドメイン>`。`/.well-known/openid-configuration` と JWKS を公開する。
- ワークフローに `id-token: write` があるときだけ、ランナーはジョブトークンで ID トークンを要求できる。`aud` は既定で持ち主の URL、要求時に変えられる（本家と同じ）。
- claim は本家と同じ名前にする：`sub`、`aud`、`repository`、`repository_id`、`repository_owner`、`repository_owner_id`、`ref`、`ref_type`、`sha`、`workflow`、`workflow_ref`、`job_workflow_ref`、`environment`、`event_name`、`run_id`、`run_attempt`、`actor`、`actor_id`、`runner_environment`。
- `sub` の形も本家と同じ：`repo:<owner>/<repo>:environment:<name>`、`repo:<owner>/<repo>:pull_request`、`repo:<owner>/<repo>:ref:refs/heads/<branch>`。Organization・リポジトリの単位で、`sub` に含める claim を変えられる（`include_claim_keys`）。
- **名前の再利用への対策**：リポジトリの名前は、削除・改名のあとに別の人が取れる。クラウドの信頼の条件を名前だけで書くと、別人のリポジトリが通る。`repository_id`・`repository_owner_id` を `sub` に含める設定を、Organization の既定で有効にできるようにし、ドキュメントで推奨する。
- 署名の鍵は KMS の非対称鍵（RSA、`RS256`）。秘密鍵は KMS の外に出ない。鍵は 90 日ごとに入れ替え、JWKS には新旧の 2 つを並べる。
- 有効期限は 5 分（本家は値を明記していないが、文書の例のトークンの `exp − iat` は 300 秒。[OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)、2026-09-26 に確認）。発行の記録（`jti`、claim）を監査ログに残す。

## 8. ランナーの実行基盤（ホスト）

決定は [ADR-0023](../decisions/0023-firecracker-microvm-runners.md)。

### 8.1 構成

```
EC2 metal（例：m7i.metal-48xl。SMT を無効）── actions-runners-prod のアカウント、3 AZ（infrastructure.md の 2.2 節）
  ├─ ホストのエージェント（Fleet Manager の手足）
  ├─ jailer + Firecracker（microVM ごとに 1 プロセス、cgroup・namespace・seccomp）
  │    └─ microVM：ゲストの Linux、ランナーのエージェント、ツール一式（イメージ）
  ├─ tap デバイス（VM ごと）── nftables（外向きの制御）── ホストのパブリック IP で送信元変換 ── インターネット
  │                                                   └─ PrivateLink ── prod（Git フロントエンドの読み取り、制御 API）
  └─ ローカルの NVMe：VM のルートのディスクの書き込み層（使い捨て）
```

- **1 ジョブ 1 microVM。** VM は、ジョブを実行したら壊し、ディスクの書き込み層も消す。VM・ディスク・ネットワークのデバイスを、別のジョブに再利用しない。
- **ゲストは Linux だけ。** Firecracker は Linux の KVM の上で Linux のゲストを動かす（[Firecracker](https://github.com/firecracker-microvm/firecracker)）。Windows・macOS のランナーは MVP の外にする。
- 標準のランナーの大きさは、容量の計画では 2 vCPU・8 GiB・ディスク 14 GB とする（[capacity.md](capacity.md) の 2.9 節）。本家は公開リポジトリと非公開のリポジトリで大きさを変えている（Linux・Windows で、公開は 4 CPU・16 GB・SSD 14 GB、非公開は 2 CPU・8 GB・SSD 14 GB。[GitHub-hosted runners reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)、2026-09-26 に確認）。本システムの標準は、非公開の大きさと同じになる。
- イメージは本家の `ubuntu-latest` に近い中身（言語のランタイム、Docker、主要な道具）を持つ。ルートのディスクは読み取りだけのベースのイメージと、VM ごとの書き込み層に分け、起動を速くする。
- ジョブの中の Docker（コンテナのアクションや `services`）は、VM の中の Docker で動かす。ジョブは VM の中で root になれる（本家と同じく、パスワードなしの `sudo`）。隔離の境界は VM であり、VM の中の権限は問わない。

### 8.2 metal のホストの設定

Firecracker の本番のホストの推奨（[prod-host-setup.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/prod-host-setup.md)）に従う。

- jailer で、VM ごとに cgroup・namespace・chroot を分け、権限を落とす。Firecracker の seccomp のフィルタを有効にする。
- SMT を無効にする。Kernel Samepage Merging を無効にする。スワップを無効にする（サイドチャネルと、別の VM のメモリの残りの読み取りへの対策）。
- VM ごとに CPU・メモリ・ディスクの I/O・ネットワークの帯域の上限を付ける（うるさい隣人への対策）。
- ホストの OS とカーネル、Firecracker の版を固定し、全台に同じものを行き渡らせる。

### 8.3 ネットワークの外向きの方針

| 宛先 | 方針 | 理由 |
| --- | --- | --- |
| インターネット（TCP・UDP） | 許す | 依存の取得、テスト、デプロイに要る |
| `169.254.169.254`（EC2 のインスタンスメタデータ）、`fd00:ec2::254` | **遮断** | ホストの IAM ロールの資格情報を守る。ホストでも IMDSv2 を必須にし、応答のホップの上限を 1 にする |
| Firecracker の MMDS | 使わない（無効） | ゲストに渡すものは、ジョブのメッセージだけにする |
| VPC の CIDR、プライベートの IP の範囲、他の VM、ホスト | **遮断**（PrivateLink のエンドポイントと S3 のゲートウェイエンドポイントを除く） | 横移動を防ぐ。実行環境は prod と別の AWS アカウント・別の VPC で、prod へは PrivateLink（Git フロントエンドの読み取り、制御 API＝Broker・ログ・成果物・キャッシュ・OIDC の入口）だけで届く（[infrastructure.md](infrastructure.md) の 2.2 節） |
| TCP 25（SMTP） | 遮断 | スパムの送信の踏み台を防ぐ |
| 外から VM への入り | 遮断 | — |

- 外向きの送信元の IP（ホストのパブリック IP。NAT ゲートウェイは使わない）は、製品の他の部分（Webhook の送信、Git のフロントエンド）と別の範囲になる。ランナーの IP が他社のブロックリストに載っても、Webhook の配信に影響しない。
- 外向きの通信の量（帯域・接続数・宛先の数）を VM ごとに測り、濫用の検知（12 節）に使う。

### 8.4 待機中の VM（ウォームプール）と起動

- Firecracker は、API の呼び出しから `/sbin/init` の開始まで 125 ms 以下、VMM のメモリのオーバーヘッド 5 MiB 以下を仕様としている（[SPECIFICATION.md](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md)）。ただし、ランナーのエージェントとツールの初期化を含む実際の起動の時間は、イメージの大きさに依存する（**未検証**。イメージに依存し、文書では確かめられない。E8 の `firecracker-host-poc` で測る）。
- ラベルごとに、起動済みで long poll 中の VM を一定数持つ。数は、直近の配り出しの速さから決める（初期値は、直近 5 分のジョブの開始の数の 1.5 倍）。
- 待機中の VM はシークレットを持たない。ジョブのメッセージを受け取って、初めてジョブの資格情報を持つ。
- **スナップショットからの復元（起動の高速化）は S1 で使わない。** 1 つのスナップショットから複数の VM を作ると、乱数の状態などが複製される（[random-for-clones.md](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/random-for-clones.md)）。S2 で、起動の時間が NFR-007 を満たさないときに、再検討する。

### 8.5 容量

- S1 のピークの同時実行は 1,800 ジョブ（[capacity.md](capacity.md) の 2.9 節）。
- **1 ホストあたり約 40 VM とする。** 8.2 節で SMT を無効にすると、m7i.metal-48xl の物理コアは 96 になり、2 vCPU の VM を物理コア 2 つに割り当てると最大 48、ホストの予備を引いて約 40 になる。ピークのホストは 1,800 ÷ 40 ＝ 45 台＋待機 9 台（20%）＝ 54 台になる（概算。`m7i.metal-48xl` が物理 96 コア・192 vCPU・768 GiB であることは [AWS の仕様](https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html) で確かめた（2026-09-26）。1 台に載る VM の数は **未検証** で、E8 の負荷試験で決める）。[capacity.md](capacity.md) の 2.9 節と [infrastructure.md](infrastructure.md) の 4・9 節の台数・費用は、この前提にそろえた（2026-09-26）。
- vCPU を物理コアではなくハイパースレッドの単位で割り当てる（SMT を有効にする）案は、サイドチャネルの危険と引き換えになる。採らない（ADR-0023）。
- 増やすときは、Auto Scaling グループで metal のホストを足す。metal の起動には分の単位の時間がかかる（AWS は起動の開始まで「通常 10 分未満」とだけ書く。[Amazon EC2 FAQs](https://aws.amazon.com/ec2/faqs/)。metal の値は **未検証** で、E8 で測る）ので、待機中の VM の余裕と、ホストの余裕の 2 段で吸収する。
- 需要が読めない分は、S2 で、入れ子の仮想化に対応した仮想のインスタンス（2026-02 に C8i・M8i・R8i から始まり、2026-06 の時点で M7i・C7i・R7i・X8i・I7i なども対応。[AWS の告知](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual)、[対応するインスタンス](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)、2026-09-26 に確認）を、あふれた分の受け皿として評価する。Firecracker は入れ子の仮想化を検証済みの基盤に挙げていない（[README](https://github.com/firecracker-microvm/firecracker/blob/main/README.md)）ので、性能と隔離の性質は **未検証** とし、S2 の前に PoC で確かめる。

## 9. ランナーのプロトコル

### 9.1 やりとり

```
ランナー（エージェント）                          Broker
  │ POST /runner/sessions（登録の資格情報）──────▶│ セッションを作る
  │ GET  /runner/jobs?session=...（long poll）───▶│ 最大 50 秒待つ。ジョブがなければ 204
  │◀── 200 ジョブのメッセージ ─────────────────────│ ジョブを assigned に
  │ POST /jobs/{id}/ack ─────────────────────────▶│ in_progress に
  │ POST /jobs/{id}/heartbeat（30 秒ごと）───────▶│ 取り消しの指示を返す
  │ POST /jobs/{id}/logs（ステップごとの行）───────▶│（Log service へ）
  │ POST /jobs/{id}/steps/{n}（ステップの状態）────▶│
  │ POST /jobs/{id}/complete（結論、出力）─────────▶│ completed に。トークンを失効
```

- **接続は、ランナーからの外向きの HTTPS だけにする。** 本家のセルフホストのランナーと同じく、50 秒の long poll でジョブを待つ（本家の記述：[Communicating with self-hosted runners（GHES 3.16）](https://docs.github.com/en/enterprise-server@3.16/actions/hosting-your-own-runners/managing-self-hosted-runners/communicating-with-self-hosted-runners)）。ホストされたランナーも同じプロトコルを使い、経路を 1 つにする。
- Broker は長時間の接続を多数持つので Go で作り、状態を持たない（long poll の相手は DB と Valkey で探す）。水平に増やせる。
- ジョブのメッセージの中身：ステップ（解決済みのアクションの SHA と、取得のための署名付き URL）、式の評価に要る文脈、シークレット、`<BRAND>_TOKEN`、ジョブトークン、キャッシュ・成果物の範囲、タイムアウト。
- 取り消し（`cancel-in-progress`、利用者の取り消し）は、心拍の応答で伝える。ランナーはすぐに止め始め、猶予（5 分）を過ぎたらホストされたランナーでは VM ごと壊す。本家も、ランナーは SIGINT を送って 7.5 秒、SIGTERM を送って 2.5 秒待ってからプロセスを止め、5 分の取り消しの期限を過ぎたらサーバーが強制的に終える（[Workflow cancellation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-cancellation)、2026-09-26 に確認）。ランナーの側の手順は本家に合わせる。

### 9.2 ランナーのエージェント

- **本家の [actions/runner](https://github.com/actions/runner)（MIT ライセンス）を fork して使うことを第一候補にする。** アクションの実行（JavaScript・Docker・composite）、式、ログのマスクの互換性を、自前で作り直すより確実に得られる。
- サーバーとのプロトコルは、上の自前の API に合わせて fork の側を書き換える。本家のサーバー側のプロトコルは公開の仕様がない（docs.github.com に記述がない。互換を目標にしないので確かめない）ので、互換にすることは目標にしない。
- ランナーの側で、シークレットの値（と、登録された派生の値。`::add-mask::`）を、ログに出す前に `***` に置き換える。

### 9.3 マスクの二重の確認

- ランナーのマスクは、完全一致の置き換えである。本家も、構造を持つ値（JSON など）や、シークレットから作った値（Base64 など）はマスクから漏れうると明記している（[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)）。
- Log service は、取り込んだログをもう一度、そのジョブのシークレットの値（とその Base64・URL エンコードの形）で検査する。見つけたら置き換え、`secret_leak_suspected` の監査のイベントを出す。
- それでも、利用者のコードがシークレットを変形して出すことは防げない。これは本家と同じ限界として、ドキュメントに書く。

## 10. ログ、成果物、キャッシュ

決定は [ADR-0027](../decisions/0027-artifact-and-cache-storage.md)。

### 10.1 ログ

- ランナーはステップごとに行を送る。Log service は、マスクの確認のあと、次の 2 つに書く。
  - **ライブ表示**：Valkey のジョブごとのストリーム（`XADD`、直近 10,000 行、TTL 1 時間）。ブラウザは SSE で購読する。購読の前に `can(actor, read, repo)` を通す。
  - **確定**：ステップごとに 1 MB ごとのブロックにまとめ、S3 に置く。ジョブの完了時に、ステップごとの 1 つのオブジェクトに結合する。
- S3 のキー：`logs/{repo_id}/{run_id}/{job_id}/{attempt}/{step}.log.zst`。
- 1 ジョブのログの上限を置く（初期値 64 MB、超えたら切り詰めて注記する）。本家はジョブのログの上限を公開していない（[Actions limits](https://docs.github.com/en/actions/reference/limits) に記載がない。2026-09-26 に確認。**未検証**）ので、本システムの値とし、E8 の実測で見直す。
- 保持は、成果物と同じ設定（10.3 節）に従う。

### 10.2 キャッシュ

本家の仕様：[Dependency caching](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching)。

- **範囲はリポジトリと ref の組。** 実行は、自分の ref とデフォルトブランチのキャッシュを読める。PR の実行は、加えてベースのブランチのものを読める。PR の実行が作るキャッシュは、マージの ref（`refs/pull/N/merge`）の範囲になり、ベースのブランチや他の PR からは読めない。
- **書き込みは、自分の ref の範囲だけ。** 読める範囲と書ける範囲は、ジョブトークンに入れて Cache service が照合する。ランナーの申告を信じない。
- **エントリは不変。** 同じキー・同じ版のものは作り直せない。版は、`path` と圧縮の方式から作る（本家と同じ）。
- 容量はリポジトリあたり 10 GB。超えたら、最後に使った時刻の古い順に消す。7 日使われないものは消す（本家と同じ）。
- 流量の上限（本家と同じ）：アップロード 200 件/分、ダウンロード 1,500 件/分、削除 400 件/分（リポジトリあたり）。
- **汚染への備え**：デフォルトブランチの範囲に書けるのは、デフォルトブランチの上で動く実行（`push`、`schedule`、`pull_request_target`、`workflow_run` など）である。これらが PR のコードを実行すると、デフォルトブランチのキャッシュが汚染され、後のすべての実行に効く。範囲の規則は本家と同じにし、6.4 節の既定の遮断で経路を減らす。キャッシュのエントリに、書いた実行の `run_id`・イベント・コミットを記録し、汚染の調査で辿れるようにする。

### 10.3 成果物

- 実行の単位で持つ。1 ジョブあたり 500 まで。作ったものは不変（本家の `upload-artifact@v4` と同じ。上書きは新しい ID の作成になる。[actions/upload-artifact](https://github.com/actions/upload-artifact)）。
- 保持の既定は 90 日。公開リポジトリは 1〜90 日、非公開のリポジトリは 1〜400 日の範囲で変えられる（本家と同じ。本家は 2026-10-01 から、この保持を実行・チェックの記録にも広げる）。
- S3 のキー：`artifacts/{repo_id}/{run_id}/{artifact_id}`。
- **成果物は信頼できないデータとして扱う。** fork の PR の実行の成果物を、`workflow_run` の秘密を持つ実行が取り込んで実行すると、pwn request になる。ドキュメントで注意し、画面では fork 由来の成果物に印を付ける。

### 10.4 S3 への読み書き

- ランナーは、S3 に直接アップロード・ダウンロードする（大きな転送をサービスに通さない）。Artifact・Cache service が、ジョブトークンの範囲を確かめたうえで、キーを 1 つに限った署名付き URL（期限 15 分）を出す。
- 利用者のダウンロード（画面・API）は、`can(actor, read, repo)` を通してから署名付き URL を出す。
- バケットは SSE-KMS で暗号化し、パブリックアクセスを遮断する。キーの先頭をリポジトリの ID にし、リポジトリの削除で前方一致の削除ができるようにする。
- 保持期間による削除は、DB の期限から削除のジョブで行う（成果物ごとに期限が違うので、S3 のライフサイクルの規則だけでは表せない）。ライフサイクルの規則は、DB の削除の漏れに備える上限（401 日）として置く。

## 11. セルフホストのランナー

- 登録は、短命の登録のトークン（1 時間）か、JIT の構成（1 回だけ使える、特定のジョブに限らない単発のランナーの構成）で行う。API の形は本家に合わせる（[Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)）。
- 登録の単位はリポジトリ・Organization。Organization ではランナーのグループを持ち、使えるリポジトリ・ワークフローを制限する。
- **エフェメラル（1 ジョブで登録を外す）を推奨する。** 本家も、自動で増減させるなら永続のランナーではなくエフェメラルを推奨している（同ページ）。
- **公開リポジトリでのセルフホストのランナーは既定で使えなくする。** 本家は「公開リポジトリではほぼ使うべきでない」としている（[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)）。ランナーのグループの設定で明示的に許したときだけ使える（本家のグループも、既定では非公開のリポジトリだけが使える。[Managing access to self-hosted runners](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/manage-access)、2026-09-26 に確認）。
- 14 日接続のない永続のランナー、1 日接続のないエフェメラルのランナーは、登録を消す（本家と同じ）。登録の速さの上限は、リポジトリ・Organization あたり 5 分に 1,500 台。
- セルフホストのランナーのジョブにも、シークレットと `<BRAND>_TOKEN` は同じ規則で渡す。ランナーの機械の中のことは、利用者の責任とする。
- 自動で増減させる仕組み（本家の Actions Runner Controller に相当）は MVP の外。`workflow_job` の Webhook と JIT の構成の API で、利用者が作れるようにする。

## 12. アクションの解決と固定

- `uses: owner/repo@ref`（と `owner/repo/path@ref`）は、ジョブを配る直前に Scheduler が、そのリポジトリの ref を SHA に解決する。解決した SHA をジョブの記録（`job_action_resolutions`）に残し、再実行でも同じ SHA を使う（本家の再実行は、同じ `GITHUB_SHA`・`GITHUB_REF` を使う（[Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)、2026-09-26 に確認）が、`uses:` のアクションの ref を解決し直すかは書かれていない（**未検証**）。再現性のためにこちらでは固定する）。
- 取得は、SHA ごとのアーカイブを S3 にキャッシュし（`actions/{repo_id}/{sha}.tar.gz`）、ランナーには署名付き URL で渡す。非公開のリポジトリのアクションは、呼ぶ側のリポジトリに読む権限があるとき（`can()` と、アクセスの設定）だけ解決する。
- ポリシー（本家に合わせる。[2025-08 の変更](https://github.blog/changelog/2025-08-15-github-actions-policy-now-supports-blocking-and-sha-pinning-actions/)）：
  - 使えるアクション：すべて / 持ち主のものだけ / 許可の一覧。遮断の一覧も持てる。
  - **完全な SHA での固定を必須にする設定。** 有効にすると、タグやブランチで参照したアクションのジョブは失敗させる（再利用可能なワークフローはタグで参照してよい）。
- 本家も、完全な SHA での固定だけが、アクションを不変の版として使う方法だとしている（[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)）。ドキュメントと、ワークフローの画面の警告で推奨する。
- Marketplace（アクションの一覧・公開の仕組み）は MVP の外（[intent.md](../intent.md)）。公開リポジトリのアクションは、Marketplace なしで参照できる。
- Docker のコンテナのアクションは、外部のレジストリから取る（Packages は MVP の外）。取得の帯域を抑えるため、レジストリの取得のキャッシュ（pull-through）を S2 で検討する。

## 13. 濫用への対策

利用規約で、Actions での暗号資産の採掘を禁止する（本家も禁止している。[GitHub Terms for Additional Products and Features](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features)）。公開リポジトリのホストされたランナーは無料（本家と同じ。[Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)）なので、無料の計算資源を狙う濫用が主な脅威になる。

| 層 | 対策 |
| --- | --- |
| 入口 | 新しいアカウント（作成から日が浅い、メールの確認がない）の公開リポジトリの同時実行の上限を下げる。fork の PR の承認（6.3 節）で、見知らぬ人の PR から自動では走らせない |
| 実行中 | VM ごとの CPU の使用率の形（長時間の 100% 張り付き）、採掘のプールへの接続（Stratum のプロトコル、既知のプールのドメインの DNS）を検知する |
| 判定 | 検知の点数が閾値を超えたらジョブを止め、持ち主の Actions を一時停止し、Trust & Safety の確認の列に入れる。誤検知の申し立ての窓口を持つ |
| 外向き | SMTP の遮断、VM ごとの帯域と接続数の上限（8.3 節）。DDoS の踏み台を防ぐ |
| 事後 | 同じ持ち主・同じワークフローの内容（ハッシュ）・同じ外向きの宛先で、繰り返しを塞ぐ |

- 検知の規則は Worker で動かし、規則の更新を再デプロイなしで行えるようにする。
- 閾値と規則は運用で調整する（runbook に入れる）。
- 詳細の脅威モデルは [security.md](security.md) に置く。

## 14. 課金の分の記録

- 非公開のリポジトリのホストされたランナーの利用を、ジョブごとに分の単位で記録し、持ち主に課金する（本家と同じく、実行した人ではなく持ち主に付ける）。
- 分の数え方：ジョブの開始から完了まで。1 分未満は、本家と同じくジョブごとに分へ切り上げる（[Actions runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)、2026-09-26 に確認）。環境の待ち時間は数えない。
- 成果物とキャッシュの保存量は、1 時間ごとの GB で積算する（本家の方式。キャッシュは成果物と別の枠で、リポジトリあたり 10 GB）。
- 記録は `actions_usage`（追記だけ）に持ち、月の集計は別のバッチで行う。課金の仕組みそのものは MVP の外の Epic と接続する。

## 15. データモデル

主なテーブル。[data-model.md](data-model.md) の索引に載せる。すべて `repo_id`（または `owner_id`）を持ち、読み取りは ADR-0002 の判定を通す。

```sql
workflow_runs (id, repo_id, workflow_path, head_sha, head_ref, event, actor_id, trigger_actor_id,
               status, conclusion, run_attempt, plan JSONB, concurrency_group, created_at, updated_at)
workflow_jobs (id, run_id, repo_id, owner_id, name, matrix JSONB, labels TEXT[], runner_kind,
               state, conclusion, environment_id, needs BIGINT[], runner_id, assigned_at,
               started_at, completed_at, check_run_id, attempt)
job_steps (job_id, number, name, state, conclusion, started_at, completed_at, log_key)
job_action_resolutions (job_id, uses, resolved_repo_id, resolved_sha)
concurrency_groups (repo_id, group_key, running_job_or_run_id, pending JSONB, updated_at)
owner_actions_limits (owner_id, plan, max_concurrent_jobs, weight, suspended_at)

actions_secrets (id, scope ENUM(org, repo, env), scope_id, name, ciphertext, key_version,
                 visibility, selected_repo_ids BIGINT[], updated_at)
actions_secret_keys (scope, scope_id, key_id, public_key, encrypted_private_key /* KMS */, created_at)
environments (id, repo_id, name, wait_timer_minutes, deployment_branch_policy JSONB)
environment_reviewers (environment_id, reviewer_type, reviewer_id)
deployment_reviews (job_id, environment_id, reviewer_id, decision, comment, decided_at)

runners (id, scope ENUM(repo, org), scope_id, group_id, name, labels TEXT[], kind ENUM(hosted, self_hosted),
         ephemeral, status, last_seen_at)
runner_groups (id, org_id, name, allowed_repo_ids BIGINT[], allow_public_repos, allowed_workflows TEXT[])

artifacts (id, repo_id, run_id, job_id, name, size_bytes, digest, s3_key, expires_at, deleted_at)
cache_entries (id, repo_id, ref, key, version, size_bytes, s3_key, created_by_run_id, created_event,
               last_accessed_at, UNIQUE (repo_id, ref, key, version))
oidc_sub_templates (scope, scope_id, include_claim_keys TEXT[], use_default)
actions_usage (owner_id, repo_id, job_id, runner_sku, billable_ms, recorded_at)
```

- シークレットの平文、`<BRAND>_TOKEN`、ジョブトークン、OIDC のトークンは、どのテーブルにも置かない。トークンは失効の表（`jti` と期限）だけを持つ。
- `workflow_jobs` の `queued` の行が、キューの正本になる（5.2 節）。部分インデックス `(labels, owner_id, created_at) WHERE state = 'queued'` を持つ。

## 16. 規模の段階

| 段階 | 同時実行（ピーク、概算） | 構成 |
| --- | --- | --- |
| S1 | 1,800 ジョブ | 1 リージョン（東京）・3 AZ。metal のホスト約 45 台＋待機。Scheduler は 1 つ（リーダー選出）。Broker は数タスク |
| S2 | 18,000 ジョブ | Scheduler を持ち主のハッシュで分割（1 つの持ち主は 1 つの区画にだけ属する）。Broker をラベルごとに分ける。ログのライブ表示の Valkey をクラスタにする。入れ子の仮想化のインスタンスを、あふれの受け皿として評価する。スナップショットからの起動を再検討する |
| S3 | 180,000 ジョブ | 複数のリージョン。ジョブは、リポジトリが割り当てられたリージョン（[infrastructure.md](infrastructure.md)）のランナーで動かす。成果物・キャッシュ・ログもそのリージョンの S3 に置く。OIDC の発行者は全体で 1 つ（JWKS を全リージョンで同じにする） |

- S1 の値は [capacity.md](capacity.md) の見積もり、S2・S3 は利用者の数に比例させた仮置きである。
- S2 で、持ち主ごとの上限の数え方が区画をまたがないよう、1 つの持ち主のジョブは必ず 1 つの区画で扱う。Enterprise のような大きな持ち主が 1 つの区画を占めるときは、区画を分ける単位を持ち主から (持ち主, ラベル) へ細かくする。

## 17. 可観測性

| 指標 | 目標・閾値 |
| --- | --- |
| ジョブの待ち（queued → in_progress）p95、ラベルごと | 60 秒（NFR-007） |
| 待機中の VM の数、ラベルごと | 0 が 1 分続いたら警報 |
| VM の起動の時間 p95 | PoC の後に決める |
| 基盤が原因のジョブの失敗（`runner_lost`、起動の失敗）の率 | 0.1% 未満 |
| ログの取り込みの遅れ p95 | 5 秒 |
| マスクの二重の確認での検出の件数 | 0 でなければ調査 |
| 濫用の検知の件数、停止した持ち主の数 | 急増で警報 |
| OIDC・`<BRAND>_TOKEN` の発行の失敗の率 | 0.1% 未満 |

トレースは、イベントの受け取り → 実行の作成 → キュー → 割り当て → 完了 → チェックの更新 を 1 つのトレースにつなぐ（[observability.md](observability.md)）。

## 18. 未解決の問い

設計の中で出た問いと、その決定。計測・PoC で決めるものは「持ち越し」に置く。

### 決定（2026-09-26、既定案）

- **ランナーのエージェントは actions/runner（MIT）を fork して使う**（9.2 節の第一候補）。本家の追従は、アクションの実行・式・マスクの部分に限って四半期ごとに取り込む。サーバーとのプロトコルは自前にする。fork でも、環境変数・パスの名前は ADR-0006 で置き換える。
- **標準のランナーの大きさ**は、S1 では公開・非公開とも 2 vCPU・8 GiB にする（本家は公開リポジトリに 4 CPU・16 GB を与えている（8 節、2026-09-26 に確認）が、容量の計画を単純にするため。本家との違い）。
- **課金**：非公開のリポジトリの分の記録（14 節）だけを MVP で持ち、プランと無料の枠は MVP の後の課金の Epic で決める。公開リポジトリのホストされたランナーは無料にする（本家と同じ）。
- 本家の値の確認（2026-09-26）：分の切り上げ、取り消しの猶予、ランナーのグループの公開リポジトリの既定、fork の PR の承認の既定は本家の文書で確かめ、本文の値と一致した。OIDC のトークンの有効期限は文書の例（5 分）と一致した。1 ジョブのログの上限と、再実行でのアクションの SHA の固定は、本家が公開していないので本システムの値のまま作る。

持ち越し（計測・PoC で決めるもの）：

| 項目 | いつ・どう決めるか |
| --- | --- |
| 実際の VM の起動の時間（イメージの大きさ込み）と、NFR-007 に要るウォームプールの大きさ（8.4 節） | E8 の `firecracker-host-poc` で測る |
| metal のホストの 1 台あたりの VM の数（約 40 の仮定）と、ホストの増減の速さ（8.5 節） | E8 の `firecracker-host-poc` と負荷試験で測り、[capacity.md](capacity.md) を直す |
| マスクの二重の確認のための、シークレットの値の扱い（6.2 節、9.3 節） | E8 の `log-mask-double-check` の PoC で、誤検出と漏れの率を測る |
| ジョブの中の Docker の取得の帯域と、pull-through のキャッシュ | E10。E8 の後の実測で、Docker Hub のレート制限に当たる頻度を見て決める |

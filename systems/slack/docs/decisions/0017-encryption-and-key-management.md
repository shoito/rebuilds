---
status: accepted
date: 2026-09-26
---

# ADR-0017: 通信はすべて TLS、保存時は KMS のカスタマー管理キーで暗号化し、秘密情報は Secrets Manager で自動ローテーションする

## Context

チャットの本文とファイルは、顧客の最も機密性の高いデータになる。企業顧客からは、暗号化の範囲、鍵の管理者、鍵の失効（顧客が自分で鍵を止められるか）を問われる。

暗号化の設定のいくつかは、あとから変えられない。

- Aurora の暗号化されていないクラスタを、そのまま暗号化されたクラスタに変えることはできない。スナップショットからの復元か、移行が必要になる。
- ElastiCache Serverless の KMS キーを変えるには、キャッシュの作り直しが必要になる。

したがって、最初のリソースを作る前に決める。

## Options

1. **AWS の既定の暗号化**（AWS 所有のキー、サービスの既定の設定）に任せる
2. **KMS のカスタマー管理キー（CMK）** をデータの種類ごとに作り、全ストレージで使う。アプリ層の暗号化は行わない
3. 2 に加えて、**最初からワークスペースごとの鍵でアプリ層の暗号化**（エンベロープ暗号化）を行う

## Decision

> 2026-09-26 の確認：Better Auth の `secrets`（バージョン付きの秘密）は、**暗号化**については新旧の鍵を並べて持てる（新しい鍵で暗号化し、バージョンで旧い鍵を選んで復号する）。一方、セッションの Cookie の**署名**は先頭の 1 つの鍵（`secrets[0]`）だけで作り、検証する。旧い鍵で署名した Cookie を受け付ける期間は持てず、入れ替えると全員のセッションが無効になる（[`secrets` の文書](https://www.better-auth.com/docs/reference/options#secrets)、[`create-context.ts`](https://github.com/better-auth/better-auth/blob/main/packages/better-auth/src/context/create-context.ts)）。そこで、Better Auth の秘密は 90 日の定期の入れ替えをせず、漏洩の疑いがあるときだけ、全員の再ログインを受け入れて入れ替える。Cookie の値は DB で照合する不透明なランダムなトークンなので、署名の鍵を長く使っても、トークンの推測のしやすさは変わらない。JWT プラグインの鍵（OAuth のアクセストークン）は `jwks.rotationInterval` と `gracePeriod` で重なりを持って入れ替えられる（[JWT の文書](https://www.better-auth.com/docs/plugins/jwt)）ので、下の表のとおり 90 日で入れ替える。

> Terraform の状態ファイル（`tfstate`）の暗号化の鍵は、[260926-terraform-foundation](../changes/260926-terraform-foundation/spec.md) で、データの種類ごとの鍵の 1 つとして定めた。

2 を採用する。3 は、将来の選択肢として移行の道筋だけを決めておく。

### 転送中

- **外部**：CloudFront で TLS 1.2 以上。HSTS（`max-age` 1 年、`includeSubDomains`、`preload`）。
- **内部も TLS にする。**

  | 経路 | 方式 |
  | --- | --- |
  | CloudFront → ALB | HTTPS のみ |
  | ALB → ECS タスク | HTTPS（タスク側の証明書） |
  | アプリ → Aurora | TLS を必須にする（`rds.force_ssl`）。クライアントは証明書を検証する |
  | アプリ → ElastiCache | 転送中の暗号化を有効にする |
  | アプリ → SQS・S3・KMS・Secrets Manager | VPC エンドポイント経由の HTTPS。S3 のバケットポリシーで `aws:SecureTransport` が false の要求を拒否する |

### 保存時

データの種類ごとに CMK を分ける。キーポリシーで使える IAM ロールを限定し、利用は CloudTrail に残る。

| キー | 対象 |
| --- | --- |
| `db` | Aurora のクラスタ、スナップショット、Performance Insights |
| `cache` | ElastiCache（Valkey） |
| `queue` | SQS（SSE-KMS） |
| `files` | ファイルとサムネイルの S3 バケット |
| `exports` | エクスポートの成果物の S3 バケット |
| `audit` | 監査ログのアーカイブ（ADR-0018） |
| `backup` | AWS Backup のボールト（大阪へのコピーを含む） |
| `secrets` | Secrets Manager |
| `logs` | CloudWatch Logs |

> 2026-09-28 の注記：アプリの署名の秘密と、渡す前のボットのトークンを、アプリ層でエンベロープ暗号化する `apps` キーを加える（[apps.md](../architecture/apps.md) の 8 節・14.3 節、[data-model/app-platform.md](../architecture/data-model/app-platform.md)）。HMAC の署名に使うため、ハッシュにできず、復号できる必要がある。本文などのテナントのデータには使わない。

- 自動のキーローテーション（年 1 回）を有効にする。
- キーの削除の待機期間は最長の 30 日にする。削除の予約はアラートにする。
- S3 は SSE-KMS とバケットキーを使い、KMS の呼び出し回数を抑える。
- 大阪リージョン（災害復旧）でも復号できるよう、`db`・`backup`・`files`・`secrets` はマルチリージョンキーにする（[infrastructure.md](../architecture/infrastructure.md) の災害復旧）。

### 秘密情報

- 秘密情報は Secrets Manager に置き、`secrets` キーで暗号化する。
- ECS のタスクロールごとに、読める秘密情報を限定する。
- ローテーション：

  | 秘密情報 | 周期 | 方式 |
  | --- | --- | --- |
  | DB の認証情報（`app`、`relay` など） | 30 日 | Secrets Manager のローテーション（ユーザーを交互に使う方式）。アプリは接続の確立時に秘密情報を取り直す |
  | セッションなどの署名鍵 | 90 日 | 新旧の鍵を並べて持ち、署名は新しい鍵、検証は両方で行う期間を設ける。Better Auth のセッションの署名は重なりを持てない（上の注） |
  | 外部サービスの API キー | 90 日、または提供者の上限 | 手順化して Ops が行う |

- 漏洩の疑いがあれば、周期を待たずにローテーションする。

### 将来：ワークスペースごとの鍵と EKM

企業顧客が「自分の鍵で暗号化し、自分で止められる」ことを求めたときに、次の順で進める。

1. **ワークスペースごとのデータキー（DEK）** を作り、KMS の CMK で包んで（wrap して）DB に保存する。
2. 本文・ファイル名・ファイルの中身など、機密性の高い列とオブジェクトを、アプリ層で DEK によって暗号化する。ファイルは S3 のキーの接頭辞（`ws/{workspace_id}/`）ごとに別の KMS キーを指定できるため、先に移せる。
3. 顧客の鍵を使う（EKM）ときは、DEK を包む CMK を顧客が管理するキー（顧客のアカウントのキー、または KMS の外部キーストア）に置き換える。顧客がキーを無効にすると、そのワークスペースのデータは読めなくなる。
4. ワークスペースの削除時に DEK を破棄すれば、バックアップに残ったデータも読めなくなる（暗号学的な消去）。削除の最終的な期限を、バックアップの期限より短くできる（ADR-0019）。

移るときの課題：

- 本文を暗号化すると、DB 内の全文検索（pg_bigm、ADR-0004）が使えなくなる。検索インデックスも同じ鍵で守る必要があり、OpenSearch への移行（S2）とあわせて設計する。
- 鍵の取得がリクエストの経路に入るため、DEK のキャッシュと、キャッシュの有効期間（失効の反映の遅れ）を決める必要がある。
- 移るときは新しい ADR を書く。

## Consequences

- 良くなること：
  - 鍵の利用が CloudTrail に残り、キーポリシーで利用者を限定できる。スナップショットの持ち出しにも効く。
  - データの種類ごとにキーが分かれているので、漏洩時の影響の範囲と、ローテーションの単位が明確になる。
  - 作成時にしか決められない設定を、最初に固定できる。
  - ワークスペースごとの鍵へ、ストレージを作り直さずに移れる。
- 引き受けるコスト：
  - KMS のキーと API 呼び出しの費用がかかる。
  - 内部の TLS で、証明書の管理と、わずかな遅延が増える。
  - アプリ層の暗号化をしないので、DB へのアクセス権を持つ者（`app` ロール、break-glass の運用者）は平文を読める。ここは RLS・IAM・監査ログで守る。

## Confirmation

- IaC の検査：暗号化されていない、または CMK 以外で暗号化されたストレージ（Aurora、ElastiCache、SQS、S3、Backup のボールト、CloudWatch Logs）があれば失敗させる。
- AWS Config のルールで、本番の逸脱（暗号化なし、`aws:SecureTransport` の条件なし、キーのローテーションなし）を検知する。
- 結合テスト：TLS なしでの DB への接続が拒否される。
- 秘密情報のローテーションを、ステージングで定期的に実行し、アプリが停止しないことを確かめる（runbook の `key-rotation`）。

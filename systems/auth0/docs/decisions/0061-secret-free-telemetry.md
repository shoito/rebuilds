---
status: accepted
date: 2026-09-27
---

# ADR-0061: 計装は許可リストの型を通したものだけを出し、秘密の形をログ・トレース・アクセスログの 4 か所で防ぐ

## Context

このシステムの要求と応答は、秘密だらけである。

| 場所 | 秘密 |
| --- | --- |
| クエリ文字列 | 外部の IdP からのコールバックの `code`・`state`、デバイスフローの `user_code`、`/authorize` の `id_token_hint`、`login_hint`（メール） |
| 応答の `Location` | テナントのアプリへ返す `code`（認可コード）。暗黙フローは提供しないのでトークンは入らない |
| 要求の本文 | パスワード、`client_secret`、`refresh_token`、`code`、`code_verifier`、`client_assertion`、TOTP のコード、メールの OTP |
| ヘッダー | `Authorization`（Basic のクライアントシークレット、Bearer のアクセストークン）、`Cookie`（セッション） |
| 応答の本文 | アクセストークン、ID トークン、リフレッシュトークン |

守るべき振る舞いは「秘密がログ・トレース・エラーの本文に出た件数 0 件」（intent.md の K6、NFR-007）。AGENTS.md は、ログを許可リストのスキーマを通したものだけにすると決めている（[ADR-0004](0004-credential-storage.md)）。

OpenTelemetry の自動計装は、HTTP のスパンに URL（クエリ文字列を含む）やヘッダーを属性として付けうる。AWS のアクセスログにも、アプリのロガーの外で要求の中身が残る。

- ALB のアクセスログは、要求の行（URL とクエリ文字列）を含む。項目を選ぶ設定は、AWS の資料で見つからなかった（未検証）。
- CloudFront の標準のログ（v2）は、出す項目を選べる。`cs-uri-query`（クエリ文字列）と `cs(Cookie)` を外せる。Cookie の記録は配信ごとの設定で、既定は無効（[Configure standard logging (v2)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logging.html)、2026-09-27 に確認）。
- WAF のログは、URI のパス・クエリ文字列・1 つのヘッダー・HTTP のメソッドを `REDACTED` に伏せられる。ただし、伏せるのはその項目を照合に使うルールの記録だけと説明されている。ログに残す要求を、ルールの動作（Block・Count など）で絞れる（[Finding your protection pack (web ACL) records](https://docs.aws.amazon.com/waf/latest/developerguide/logging-management.html)、2026-09-27 に確認）。

## Options

1. **4 か所で防ぐ。** (1) アプリのロガーとスパンの属性を、型付きの許可リストだけにする。(2) OTel Collector で、許可リストにない属性を落とす。(3) AWS のアクセスログからクエリ文字列と秘密のヘッダーを外す。(4) 出てしまったものを走査で見つける
2. アプリのロガーの許可リストだけにする
3. ログは全部出し、CloudWatch Logs のデータ保護ポリシーで伏せる

## Decision

1 を採用する。

### (1) アプリ

- **秘密は `Secret<T>` の型で持つ。** パスワード、コード、トークン、シークレット、OTP、セッションの ID、`code_verifier` は、HTTP の入口で Zod のスキーマが `Secret<T>` に包む。`toString`・`toJSON`・`util.inspect` は `[REDACTED]` を返す。値を取り出すのは `reveal()` だけで、`reveal()` を呼べるパッケージを lint で限る。
- **ロガーは、`packages/telemetry` の型付きのイベントだけを受ける。** 自由な文字列の補間や、要求・応答のオブジェクトをそのまま渡すことを型と lint で禁じる。
- **スパンの属性も、定数で定義した許可リストだけにする。** HTTP の自動計装は、`url.full`・`url.query` を付けない設定にし、`url.path` はルートの型（`/oauth/token`、`/u/login`）に置き換える。ヘッダーは取り込まない。
- **エラーの本文**：OAuth のエラー応答（`error`、`error_description`）は、定型の文だけにし、入力の値を埋め込まない。例外のメッセージとスタックトレースは、ログにだけ出し、応答に出さない。
- **識別子は出してよい。** `tenant_id`、`client_id`、`user_id`、`connection_id`、`kid`、リフレッシュトークンの系列の ID、要求の ID。メールアドレスと IP は、テナントの認証のイベントのログ（logs-and-streams の領域）には入るが、運用のアプリのログには出さない（IP は /24 に丸めた値だけ）。

### (2) Collector

- 各タスクの ADOT Collector のサイドカーに、属性の許可リストの処理（`attributes`・`transform` のプロセッサで、許可リスト外のキーを削除する）を置く。アプリの計装の誤りを、送る前に止める。

### (3) AWS のアクセスログ

- **認証の経路の ALB のアクセスログは無効にする。** クエリ文字列を伏せられない（未検証）ため。代わりに、アプリの要求のログ（許可リスト）と、CloudFront・WAF のログを使う。
- CloudFront の標準のログ（v2）は、`cs-uri-query` と `cs(Cookie)` を項目から外し、Cookie の記録を無効にする。リアルタイムのログ（[ADR-0062](0062-sli-and-synthetic-monitoring.md)）も、クエリ文字列と Cookie の項目を選ばない。
- WAF のログは、クエリ文字列・`Authorization`・`Cookie` を伏せる設定にし、残す要求を Block と Count に絞る。伏せる範囲が照合に使うルールに限られるので、WAF のログ（`httpRequest` の項目）にクエリ文字列が残るかを E1 で確かめる。残るなら、WAF のログの保持を 7 日にし、読み取りを期限つきの権限に限る（未検証）。

### (4) 走査

- 全ロググループに購読のフィルターで走査の Lambda をつなぎ、次の形を探す：JWT（`eyJ` で始まる 3 つの部分）、本システムの接頭辞（`<brand>_rt_` など）、`password`・`client_secret`・`code_verifier` のキー、PHC 形式のハッシュ（`$argon2id$`、`$2b$`）。見つけたら呼び出す（SEV2、[runbooks/incident-response.md](../runbooks/incident-response.md)）。
- CI でも、テストの実行中のログとスナップショットを同じ規則で走査し、1 件でも失敗させる（intent.md の K6）。

### 2・3 を選ばなかった理由

- 2 は、自動計装と AWS のアクセスログが、アプリのロガーを通らずに秘密を残す。
- 3 は、CloudWatch Logs に届いた時点で秘密がすでに AWS の中のログに書かれている（伏せるのは表示だけ）。データ保護ポリシーは補助として使う。

## Consequences

- 良くなること：
  - 秘密の漏れを、書く前（型、Collector）と、書いた後（走査）の両方で止める。
  - 自動計装の既定の振る舞いの変化（ライブラリの更新でクエリ文字列を付け始める）に、Collector で備える。
- 引き受けるコスト：
  - ALB のアクセスログがないので、ALB の手前の問題（TLS、ターゲットの 5xx）の調査は、CloudFront のログと ALB のメトリクスで行う。
  - 許可リストの項目を足すたびに、`packages/telemetry` と Collector の設定の両方を変える。

## Confirmation

- lint：`reveal()` を許可したパッケージの外で呼ぶコード、ロガーに型付きのイベント以外を渡すコード、`url.full` を付ける計装の設定を拒否する。
- 性質ベーステスト：任意の要求（パスワード、コード、トークンを含む）の処理で、出力されたログ・スパンの属性の文字列に、入力の秘密の値が部分文字列として含まれない。
- CI：テストのログとスナップショットの走査で 0 件。
- 本番：走査の Lambda の検出 0 件を、日次で確かめる（検出の仕組みが止まっていないことも、合成の秘密を 1 日 1 回流して確かめる）。

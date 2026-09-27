# Attack protection: Auth0

ブルートフォースの防御、不審な IP の抑制、漏えいしたパスワードの検知、ボットの検知とチャレンジ、利用者と管理者への通知、監視のモード。

| 関連 | 決定 |
| --- | --- |
| [ADR-0024](../decisions/0024-attack-protection-counters-and-enforcement.md) | 防御の判定を、パスワードのハッシュの前の 1 つの段にまとめる。数は Valkey、ブロックは DB に持つ。ユーザー × IP の数は識別子の HMAC で数え、既知の端末の Cookie で正規の利用者を分ける。防御ごとに `off`・`monitor`・`enforce` |
| [ADR-0025](../decisions/0025-breached-password-detection.md) | 漏えいしたパスワードは Pwned Passwords の k-匿名性の照合で調べる。自前のホストは利用条件の確認を条件にし、確認できなければ公式の range API を使う |
| [ADR-0026](../decisions/0026-bot-detection-and-challenge.md) | ボットの検知は、自前のリスクの点数と自前の proof-of-work のチャレンジで行う。WAF の Challenge はエッジの後ろ盾。第三者の CAPTCHA は法務の L2 の後に、テナントの選択で足す |
| [ADR-0004](../decisions/0004-credential-storage.md) | 防御の判定は、ハッシュの計算の前。漏えいしたパスワードの range API の自前のホストは、法務の確認の後（ADR-0025） |
| [ADR-0005](../decisions/0005-authentication-path-availability.md) | Valkey が落ちたら、タスクのメモリーの近似の数で続ける（全部を通さない） |
| [ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) | アカウントの有無を明かさない。再設定の要求でロックしない。要求の速度の上限をこの領域に任せる |

WAF のルールの初期値は [infrastructure.md](infrastructure.md) の 4.3 節、MFA の要素ごとの失敗の上限は [mfa-and-passkeys.md](mfa-and-passkeys.md) の 7 節、ユーザーの `blocked`（管理者のブロック）は [users-and-profiles.md](users-and-profiles.md) の 7 節、脅威モデルは [security.md](security.md) にある。

## 1. 目的と範囲

- クレデンシャルスタッフィング、パスワードの総当たり、サインアップの大量の自動化を、テナントの設定なしで止める。
- **K5**（[intent.md](../intent.md)）：模擬のクレデンシャルスタッフィングで攻撃の試行の 99% 以上を止め、正規のログインの誤ブロックを 0.1% 以下にする。
- 日本の利用者は、携帯の回線の CGNAT と企業の NAT で、多くの人が 1 つの IP を共有する（事実の規模は未検証）。IP だけで止めると正規の利用者を止める。IP と識別子と端末を組み合わせて判断する。
- 判定を Argon2id の前に置き、攻撃が CPU の DoS にならないようにする（[ADR-0004](../decisions/0004-credential-storage.md)）。
- 範囲の外：エッジの一般のレート制限（management-api-and-rate-limiting の領域と [infrastructure.md](infrastructure.md)）、闇市場の情報による早い漏えいの検知（Non-goals）、リスクに応じた MFA（S2 以降）。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 防御 | 本家の振る舞い | 出典 |
| --- | --- | --- |
| ブルートフォース | 1 つの IP から 1 つのユーザーの識別子への失敗が既定 10 回（1〜100 で設定）で、その IP からその識別子へのログインを止める。任意で、そのユーザーへのすべてのログインを止めるロックもある。解除は、最後の失敗から 30 日、通知のメールの解除のリンク、パスワードの変更、管理者の API。通知のメールは一意の IP ごとに 1 時間に 1 通。IP の許可リスト（CIDR）。応答の設定をすべて外すと「監視」のモードになり、ログにだけ残す | [Brute-Force Protection](https://auth0.com/docs/secure/attack-protection/brute-force-protection) |
| 不審な IP の抑制 | 既定で有効。ログインは 1 つの IP から 1 日の失敗の上限と、24 時間で均等に補う速度。サインアップは試行の上限と補う速度。超えると 429。許可リストは 100 件まで。管理者へのメール | [Suspicious IP Throttling](https://auth0.com/docs/secure/attack-protection/suspicious-ip-throttling) |
| 同・既定値 | ログイン：1 IP 1 日 100 回、補う速度 864,000 ms（1 日 100 回）。サインアップ：50 回、補う速度 1,200 ms（下の食い違いを見よ） | Management API の OpenAPI の `SuspiciousIPThrottlingPreLoginStage`（`max_attempts` 既定 100、`rate` 既定 864,000、最小 34,560）、[Custom Token Exchange の攻撃の防御](https://auth0.com/docs/authenticate/custom-token-exchange/cte-attack-protection) の既定の応答の例（サインアップ 50・1,200 ms）、[Support の記事](https://support.auth0.com/center/s/article/Default-values-for-Suspicious-IP-Throttling)。2026-09-27 に確認 |
| 漏えいしたパスワード | サインアップ・ログイン・再設定で働く。サインアップでは組を拒否、ログインではアカウントを止める。利用者と管理者に通知。標準の検知は公開の漏えいを走査し、反映まで 7〜13 か月。上位の版（Credential Guard）は 12〜36 時間。応答を外すと監視のモード。ログのコードは `signup_pwd_leak`・`pwd_leak`・`reset_pwd_leak`。通知は利用者ごと・IP ごとに 1 時間に 1 通 | [Breached Password Detection](https://auth0.com/docs/secure/attack-protection/breached-password-detection) |
| ボットの検知 | 統計のモデルで、ログイン・サインアップ・再設定のボットらしい集中を見つける。CAPTCHA は「なし」「危険なときだけ」「常に」。危険の水準は低・中（既定）・高。提供者は本家の Auth Challenge（既定、JavaScript が要る）、Simple CAPTCHA（JavaScript が要らない）、第三者。応答を外すと監視のモード | [Bot Detection](https://auth0.com/docs/secure/attack-protection/bot-detection) |

- 食い違い：サインアップの補う速度の既定が、OpenAPI の `SuspiciousIPThrottlingPreUserRegistrationStage`（`rate` の既定 1,728,000 ms ＝ 1 日 50 回、最小 1,200 ms）と、資料の既定の応答の例（1,200 ms）で違う（未検証）。以前に食い違いとしていた CLI の 34,560 ms は、ログインの `rate` の最小値だった。上限の単位も、本家の資料（「1 分の試行の上限」）とサポートの記事（「1 日 50 回」）で違う。補う速度 1,200 ms（1 日 72,000 回）と合わせると、資料の「1 分」の読みが合う。本システムは 1 分の単位で読む（4.2 節）。
- 未検証：ブルートフォースの失敗に MFA の失敗・パスワードなしのコードの失敗が含まれるか、不審な IP のブロックが解ける条件（補う速度で自然に戻ると理解している）、各防御のログのコード（漏えいしたパスワード以外）。E8 の着手前に試用のテナントで確かめる。

## 3. 判定の段

### 3.1 流れ

```
要求（POST /u/login/password、/u/signup/*、/u/reset-password/request、/u/mfa/*、パスキーの assertion）
  │
  ├─ エッジ：WAF（IP の評判、IP のレート制限→Challenge/Block、匿名の IP のラベル）  … infrastructure.md 4.3
  │
  ├─ 段 0：テナントの許可リスト（IP・CIDR）に当たれば、段 1〜3 を飛ばす（ログには残す）
  ├─ 段 1：不審な IP の抑制（IP のバケツ）              → 429
  ├─ 段 2：ボットの検知（リスクの点数 → チャレンジの要否）→ チャレンジの画面／検証
  ├─ 段 3：ブルートフォース（識別子 × IP、識別子のロック）→ ブロックの画面（文言は 3.3）
  │
  ├─ 資格情報の照合（Argon2id、同時実行の上限。ADR-0004）
  │
  ├─ 失敗：段 1・3 の数を増やす（識別子の有無によらず同じ）
  └─ 成功：段 3 の識別子 × IP の数を 0 に戻す。既知の端末の Cookie を出す。
          漏えいしたパスワードの照合（5 節）→ ユーザーの blocked の判定（users-and-profiles.md）→ MFA
```

- 段 0〜3 は、Auth のプロセスの中のライブラリ（`packages/attack-protection`）で行う。外への往復は Valkey だけ。
- 判定の結果は `allow`・`challenge`・`block`（とその理由）。`monitor` のモードの防御は、`block`・`challenge` を返す代わりに `would_block` をログに残し、`allow` を返す。
- 段の順序は「安い判定を先に」。段 1 の IP のバケツは Valkey の 1 回の操作。段 3 は識別子の HMAC を計算してから。

### 3.2 数えるもの

| 流れ | 段 1（IP） | 段 3（識別子 × IP） | 失敗とするもの |
| --- | --- | --- | --- |
| パスワードのログイン | ログインのバケツ | あり | パスワードの誤り（ユーザーがない場合を含む） |
| MFA（TOTP、リカバリーコード、メールの OTP） | ログインのバケツ | あり（識別子はユーザーの `user_id`） | コードの誤り。認証器ごとの数は mfa-and-passkeys.md の 7 節で別に数える |
| パスキーのログイン | ログインのバケツ | なし（識別子がない。署名の失敗は攻撃の兆候としてだけ数える） | 署名の検証の失敗 |
| サインアップ | サインアップのバケツ（成功も数える） | なし | すべての試行 |
| 再設定の要求 | 再設定のバケツ | 識別子ごとの要求の数（4.4） | すべての要求 |
| サインアップの確認のコード（ADR-0015） | ログインのバケツ | あり（識別子はメールアドレス） | コードの誤り |

### 3.3 応答

| 判定 | 画面と応答 |
| --- | --- |
| 段 1 の `block` | 429、`Retry-After`。画面は「試行が多すぎます。しばらくしてからお試しください」 |
| 段 2 の `challenge` | 同じ画面にチャレンジを載せて返す（6 節）。資格情報はまだ照合しない |
| 段 3 の `block` | 画面は「このアカウントへのログインは一時的に止めています。メールを確認してください」。**識別子が存在しない場合も同じ文言と時間で返す**（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)）。メールは、ユーザーがいるときだけ outbox に積む |

- `block` の画面は、資格情報の照合の前に返すので、ブロック中にパスワードの正否を探れない。
- 段 3 の `block` の状態は、正しいパスワードでも解けない（本家と同じ）。解除は 4.1 の手段で行う。

## 4. 各防御の設計

### 4.1 ブルートフォースの防御

- **数える単位は「識別子 × IP」**。識別子は、接続・正規化した識別子（メールアドレスは小文字化と NFKC）を、テナントの鍵で HMAC にした値。ユーザーの有無を見ずに数える（列挙を防ぐ）。IPv6 は /64 の接頭辞で数える。
- 既定の上限は 10 回（1〜100 で設定。本家と同じ）。上限に達したら、`brute_force_blocks` に行を書く（DB。Valkey を失ってもブロックが残る）。
- **既知の端末は別に数える。** 過去にそのユーザーとしてログインに成功したブラウザには、既知の端末の Cookie（`__Host-<brand>_did`。`Secure`・`HttpOnly`・`SameSite=Lax`・`Path=/`。Cookie の一覧は [sessions-and-sso.md](sessions-and-sso.md) の 3.1 節）を出す。Cookie を持つ要求の失敗は「識別子 × 端末」で数え、IP のブロックの対象から外す。同じ CGNAT の IP の攻撃者が、正規の利用者を締め出さない（OWASP の device cookie の考え方。出典は References）。Cookie は 256 ビットの乱数の ID と、テナントの鍵の MAC を持ち、ユーザーの識別子の HMAC の一覧（最大 5 件）を中身に含む。有効 180 日。
- アカウントのロック（識別子に対するすべての IP のログインを止める）は、テナントの設定で有効にできる（既定は無効）。攻撃者が被害者を締め出す DoS になるため。有効にしたテナントでも、既知の端末の Cookie を持つ要求は通す。
- 解除：
  - 最後の失敗から 30 日で自動に（本家と同じ）。
  - 通知のメールの解除のリンク（256 ビットの乱数、SHA-256 で保存、1 回限り、有効 24 時間）。
  - パスワードの再設定の完了（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) の再設定の完了の処理で、そのユーザーの識別子のブロックをすべて消す。リンクした ID の識別子を含む）。
  - 管理者の Management API（`DELETE /users/{id}/attack-protection-blocks`、識別子で指定する形も持つ）。
- 通知：ユーザーがいるときだけ、ブロックの通知のメールを送る。一意の IP ごとに 1 時間に 1 通（本家と同じ）。

### 4.2 不審な IP の抑制

- **IP ごとのトークンのバケツ**。バケツの容量が「試行の上限」、補う速度が「24 時間で均等に補う数」。

| バケツ | 数えるもの | 容量の既定 | 補う速度の既定 | 本家 |
| --- | --- | --- | --- | --- |
| ログイン | 失敗 | 100 | 1 日 100（864 秒に 1） | 同じ |
| サインアップ | すべての試行 | 50 | 1 日 72,000（1.2 秒に 1） | 同じ（単位の食い違いは 2 節） |
| 再設定の要求 | すべての要求 | 50 | 1 日 1,440（60 秒に 1） | なし（本システムの追加） |
| ユーザー名の接続のサインアップ | すべての試行 | 10 | 1 日 240（6 分に 1） | なし（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md) の求め） |

- バケツはテナントごと。加えて、**プラットフォームのバケツ**を全テナントの合計で持つ（ログインの失敗、容量 2,000、補う速度 1 日 20,000）。多くのテナントに浅く攻める IP を見つける。プラットフォームのバケツで止まった IP は、どのテナントでも段 1 で 429 にする。テナントの個人データは使わず、IP ごとの数だけを使う。
- テナントは、容量と補う速度を 1〜100 万の範囲で変えられる。許可リストは 100 件まで（本家と同じ）。
- 空になったら 429。補うにつれて自然に戻る。
- 既知の端末の Cookie を持つ要求は、ログインのバケツを減らさない（4.1 と同じ理由）。
- 通知：IP が空になった時点で、テナントの管理者（ロールで選ぶ）にメールを送る。同じ IP について 1 時間に 1 通。

### 4.3 数の置き場所

```
Valkey（クラスタ、キーはテナントでハッシュのスロットをそろえる）
  ap:{t:<tenant>}:bf:<identifier_hmac>:<ip_prefix>     → 失敗の数、最後の失敗の時刻（TTL 30 日）
  ap:{t:<tenant>}:bfd:<identifier_hmac>:<device_id>     → 既知の端末ごとの失敗の数（TTL 30 日）
  ap:{t:<tenant>}:ip:<bucket>:<ip_prefix>               → 残り、最後の補充の時刻（TTL 2 日）
  ap:{p}:ip:login:<ip_prefix>                           → プラットフォームのバケツ
  ap:{t:<tenant>}:ch:<challenge_id>                      → チャレンジの使用済み（TTL 10 分）
```

- 増やす・判定する・TTL を延ばすを 1 つの Lua のスクリプトで原子的に行う。
- バケツは「最後の補充の時刻からの経過で補ってから減らす」形にし、定期のジョブを持たない。

```sql
CREATE TABLE brute_force_blocks (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL,
  connection_id    uuid NOT NULL,
  identifier_hmac  bytea NOT NULL,
  ip_prefix        cidr,                 -- null = account lockout (all IPs)
  user_pk          uuid,                 -- null when the identifier has no user
  blocked_at       timestamptz NOT NULL,
  last_failure_at  timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL, -- last_failure_at + 30 days
  unblock_token_hash bytea,              -- SHA-256, one-time (ADR-0004)
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, connection_id, identifier_hmac, ip_prefix)
);
```

- 段 3 の判定は、まず Valkey の数を見る。数が上限に達していたら、DB のブロックの行を確かめる。行の書き込みは上限に達したときだけ（まれ）なので、writer の負荷は小さい。
- Auth の各タスクは、ブロックの行を短い時間（10 秒）メモリーに持ち、同じ攻撃で DB を繰り返し読まない。

### 4.4 再設定・確認のメールの要求

- 識別子ごと：再設定の要求は 1 時間に 3 回、1 日に 10 回。超えても画面は同じ（「登録があれば送りました」）で、メールを送らない。ロックはしない（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)）。
- IP ごと：4.2 の再設定のバケツ。
- メールの OTP の再送の上限は [mfa-and-passkeys.md](mfa-and-passkeys.md) の 5.3 節。

## 5. 漏えいしたパスワードの検知（[ADR-0025](../decisions/0025-breached-password-detection.md)）

### 5.1 照合の方式

- Have I Been Pwned の Pwned Passwords と同じ k-匿名性の方式で照合する。パスワードの SHA-1 の 16 進の先頭 5 文字で範囲を引き、残りの 35 文字を手元で比べる。
- パスワードは、入力のままの UTF-8 と、NFC で正規化した値（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)）の 2 つが違えば、両方を調べる。漏えいのデータは正規化していない値のハッシュなので。
- SHA-1 の値はメモリーの中だけで扱い、保存・ログ・キューに出さない。範囲の照会に出るのは先頭 5 文字だけ。
- 範囲の中の出現の回数は使わない（1 回でも一覧にあれば「漏えい」とする。NIST SP 800-63B-4 の禁止の一覧の考え方）。

### 5.2 データの置き場所

| 案 | 中身 | 条件 |
| --- | --- | --- |
| 第一（ADR-0004 の決定） | Worker が毎月、公式の downloader と同じ方法で全範囲（16^5 = 1,048,576 個）を取得し、S3 に `pwned/v<版>/<接頭辞>.txt` で置く。Auth は S3 の VPC エンドポイントから範囲を読む。範囲はタスクのメモリーに LRU で持つ（256 MiB） | データセットを自前で保存して、商用のサービスの中で使ってよいことを確かめる（5.3） |
| 予備 | Auth が公式の range API（`Add-Padding: true`）を直接呼ぶ。範囲の応答を 24 時間、Valkey とメモリーに持つ | 5.3 の確認が取れないとき。外部への同期の依存を認証の経路に足すので、[ADR-0005](../decisions/0005-authentication-path-availability.md) の縮退の表に行を足した（2026-09-27） |

- 版の切り替え：新しい版の取り込みを終え、件数と抜き取りの照合を確かめてから、現在の版の番号を切り替える。最新と 1 つ前の版だけを残す（[security.md](security.md) のデータの表）。
- S3 のアクセスのログには、キー（先頭 5 文字）だけが残る。

### 5.3 利用の条件（2026-09-27 に確認）

- range API は、登録も API キーも要らない。「ライセンスと帰属の要件はない」とされ、レート制限もない（[HIBP API v3](https://haveibeenpwned.com/API/v3)）。
- データセットの全体は、公式の downloader で取得できる（[Pwned Passwords](https://haveibeenpwned.com/Passwords)）。ただし、取得したデータの保存・商用の利用の条件は、そのページにも API の資料にも書かれていない。
- 利用規約は、HIBP のデータの複製・配布を禁じ、「実質的に同じ機能の漏えいのデータベース・検索のサービス」を作ることを禁じる条項を持つ（[Terms of Use](https://haveibeenpwned.com/TermsOfUse)）。Pwned Passwords に適用されるかは明記がない。
- よって、**第一の案は、法務の確認（とデータの提供者への問い合わせ）が済むまで有効にしない。** 済むまでは予備の案で E8 を進める。

### 5.4 流れごとの振る舞い

| 流れ | 照合の時点 | 一覧にあったとき | 照合できないとき（データ・API の障害、200 ms の時限切れ） |
| --- | --- | --- | --- |
| サインアップ | パスワードの受け取り時（ハッシュの前） | 拒否。理由を画面に出す（[ADR-0015](../decisions/0015-database-connection-password-and-enumeration.md)） | 503（照合を飛ばさない。ADR-0005） |
| パスワードの変更・再設定 | 同じ | 拒否 | 503 |
| ログイン | 照合の成功の後 | テナントの設定の動作（下） | 照合を飛ばしてログインを続け、次のログインで調べる。飛ばした件数を指標にする |
| インポート（MVP の後） | 照合できない（ハッシュしか持たない） | — | 最初のログインで調べる |

ログインでの動作（テナントの設定、組み合わせられる）：

| 動作 | 振る舞い |
| --- | --- |
| `block` | ログインを完了させず、パスワードの再設定を求める画面を出し、再設定のメールを送る。`password_credentials.breach_detected_at` を記録し、再設定まで同じ状態を保つ |
| `notify_user` | ユーザーにメールで知らせる（利用者ごとに 1 時間に 1 通） |
| `notify_admin` | テナントの管理者に日ごとのまとめを送る |
| `monitor` | ログにだけ残す |

- 既定：新しいテナントは `block`＋`notify_user`。NIST SP 800-63B-4 は、侵害の証拠があればパスワードの変更を強いる（SHALL。3.1.1.2 節）。既存のテナントで有効にするときは、先に `monitor` で件数を見せてから切り替えるよう、ダッシュボードで勧める。
- 本家の標準の検知は、ユーザー名とパスワードの組の漏えいを見る（「組を拒否する」とある）。本システムはパスワードだけを見るので、よく使われるパスワードも「漏えい」になり、本家より多く当たる。組の照合は、組の漏えいのデータの調達が要るので行わない（Non-goals の Credential Guard に近い）。

## 6. ボットの検知とチャレンジ（[ADR-0026](../decisions/0026-bot-detection-and-challenge.md)）

### 6.1 リスクの点数

リクエストごとに 0〜100 の点数を計算する。外部に問い合わせない。

| シグナル | 出どころ | 例 |
| --- | --- | --- |
| IP の評判・匿名の IP | WAF のラベル（[infrastructure.md](infrastructure.md) の 4.3 節のルール 2・4・8）。WAF が付けたラベルを、カスタムの要求ヘッダーで Auth に渡す | ホスティング事業者、Tor |
| IP の速度 | Valkey（4.3） | 10 分に 20 を超える別の識別子、失敗の割合 80% 超 |
| プラットフォームの IP の数 | Valkey（4.2） | 多くのテナントでの失敗 |
| 既知の端末 | `__Host-<brand>_did` | ある → 点数を大きく下げる |
| ブラウザの一貫性 | 要求のヘッダー | `Accept-Language`・`Sec-Fetch-*` の欠落、自動化のツールの UA |
| フォームの時間 | 画面の表示から送信までの時間（トランザクションに記録） | 1 秒未満 |
| JavaScript の実行 | 画面の JavaScript が付けるトークン | ない（6.3） |

- 点数の重みは、E8 の模擬の試験（K5）と本番の監視のモードのログで調整する。初期の重みは表の定数で持ち、コードの変更で直す（学習のモデルは持たない）。
- 水準：点数が `low`（高い確率でボット）＝ 80 以上、`medium`（既定）＝ 60 以上、`high`（少しでも疑わしい）＝ 40 以上 でチャレンジを求める。本家の 3 段階の考え方に合わせる。

### 6.2 モード

| 設定 | 振る舞い |
| --- | --- |
| `never` | チャレンジしない（点数はログに残す） |
| `when_risky`（既定） | 6.1 の水準を超えたときだけ |
| `always` | ログイン・サインアップ・再設定の送信で常に |

- 対象の流れ：ログイン、サインアップ、再設定の要求（本家と同じ）。流れごとに設定できる。
- 監視のモード（`monitor`）では、チャレンジの代わりに `would_challenge` をログに残す。

### 6.3 チャレンジ

- **自前の proof-of-work（PoW）を既定にする。**
  - サーバーは、トランザクションに結び付いたチャレンジ（`challenge_id`、32 バイトの salt、難しさ `d`、期限 5 分）を作り、テナントの鍵で MAC を付けて画面に入れる。
  - ブラウザの JavaScript（Web Worker）が、`SHA-256(salt ‖ nonce)` の先頭 `d` ビットが 0 になる `nonce` を探し、フォームに付けて送る。
  - サーバーは MAC・期限・トランザクション・ハッシュを確かめ、`challenge_id` を使用済みにする（Valkey。落ちているときはタスクのメモリー）。
  - 難しさは点数で変える：`d` = 16（端末で 0.1 秒未満）〜 22（数秒）。値は E8 で中位の Android 端末で測って決める（未検証）。
  - 利用者の操作が要らない。画像のパズルがないので、視覚・聴覚の障害の利用者も通れる。
- **JavaScript がない場合**：Universal Login は JavaScript なしでパスワードのログインを完了できる（[ADR-0011](../decisions/0011-universal-login-rendering-and-transaction.md)）。PoW を解けない要求は、チャレンジを求められた時点で「JavaScript を有効にするか、しばらくしてからお試しください」の画面にし、その IP のバケツを通常の 1/10 の速度で扱う。ボットは JavaScript を切りうるので、JavaScript なしの経路を緩くしない。
- **エッジの後ろ盾**：WAF の Challenge のアクション（IP のレート制限を超えたとき。[infrastructure.md](infrastructure.md) の 4.3 節のルール 5）は、アプリの判定の前に効く。攻撃が大きいとき、テナントの全体を WAF の Challenge に切り替える（runbook）。WAF の CAPTCHA は 1,000 回の試行ごとに 0.40 USD、Challenge は 1,000 回の応答ごとに 0.40 USD（[AWS WAF Pricing](https://aws.amazon.com/waf/pricing/)、2026-09-27 に確認）。
- **第三者の CAPTCHA（MVP の後、テナントの選択）**：法務の L2 の結論の後に足す。

| 提供者 | 条件（2026-09-27 に確認） | 本システムでの論点 |
| --- | --- | --- |
| Cloudflare Turnstile | 無料の版は 20 個のウィジェット、ウィジェットごとに 10 個のホスト名まで。任意のホスト名で使うのは Enterprise の機能。トークンは 300 秒有効で 1 回だけ検証できる。サーバーで siteverify を呼ぶ。WCAG 2.2 に準拠とする（[Plans](https://developers.cloudflare.com/turnstile/plans/)、[Server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)、[Overview](https://developers.cloudflare.com/turnstile/)） | テナントのカスタムドメインの数だけホスト名が要り、無料の版では足りない。テナントが自分のキーを持ち込む形にする |
| Google reCAPTCHA | 組織ごとに月 10,000 回の評価まで無料。Premium は 100,000 回を超えると 1,000 回ごとに 1 USD（[Compare tiers](https://docs.cloud.google.com/recaptcha/docs/compare-tiers)） | 同じ（持ち込み）。データの国外への送信（L1・L2） |
| hCaptcha | Pro は年払いで月 99 USD、月 10 万回の評価、超えると 1,000 回ごとに 0.99 USD。受動のモードは Pro 以上（[hCaptcha Pro](https://www.hcaptcha.com/pro)） | 同じ |

- 第三者の検証（siteverify）は認証の経路への外部の同期の依存になる。足すときは、ADR-0005 の縮退の表に「提供者が落ちたら PoW に切り替える」を先に加える。

## 7. 通知

| 事象 | 宛先 | 間隔の上限 | 中身 |
| --- | --- | --- | --- |
| ブルートフォースのブロック | ユーザー | 一意の IP ごとに 1 時間に 1 通 | 時刻、IP のおおよその地域（国）、解除のリンク、パスワードの再設定の案内 |
| 漏えいしたパスワード（ログイン） | ユーザー | 1 時間に 1 通 | 再設定の案内 |
| 不審な IP の抑制 | テナントの管理者 | IP ごとに 1 時間に 1 通 | IP、バケツ、件数 |
| 漏えいしたパスワード | テナントの管理者 | 1 日 1 通のまとめ | 件数（ユーザーの一覧は含めず、ダッシュボードのログへのリンク） |
| ボットの急増（チャレンジの率が平常の 5 倍） | テナントの管理者 | 1 時間に 1 通 | 流れ、件数 |

- メールは outbox から Worker が送る（[email-delivery.md](email-delivery.md)）。送れなくても判定は変わらない。
- どの事象も、ログとログストリームのイベントにする（8 節）。

## 8. 監視のモードとログ

- 防御ごと（`brute_force`・`suspicious_ip`・`breached_password`・`bot_detection`）に `mode: off | monitor | enforce` を持つ。本家は「応答をすべて外すと監視」と表す。本システムは明示の値にする。
- 新しいテナントの既定：すべて `enforce`（ボットの検知は `when_risky`・`medium`）。
- ログのイベント。種類のコードは [ADR-0042](../decisions/0042-log-event-model-and-type-codes.md) に従い、本家に同じ意味のコードがあればそれを使う（[logs-and-streams.md](logs-and-streams.md) の 3.2 節）。本家にない事象は、本システムの独自のコード（`ap_` の接頭辞。綴りは E10 で確定する）にする。事象の細部は `details` に入れる。

| 事象 | 種類のコード | `details` |
| --- | --- | --- |
| ブルートフォースのブロック | `limit_wc`（本家と同じ） | 識別子の HMAC の先頭 8 バイト、IP |
| ブルートフォースの解除 | `ap_unblocked`（独自） | 識別子の HMAC の先頭 8 バイト、IP、理由（期限、リンク、再設定、管理者） |
| 不審な IP の抑制 | `limit_mu`（本家と同じ） | IP、バケツ、テナントかプラットフォームか |
| 漏えいしたパスワードの検知 | `signup_pwd_leak`・`pwd_leak`・`reset_pwd_leak`（本家と同じ。変更は `reset_pwd_leak` に含める） | 流れ（`signup`・`login`・`reset`・`change`）、動作 |
| ボットのチャレンジ | `ap_bot_challenged`・`ap_bot_challenge_failed`・`ap_bot_challenge_passed`（独自） | 点数、水準、方式 |
| 監視のモードの結果 | `ap_would_block`・`ap_would_challenge`（独自） | 防御の種類、判定 |
| 漏えいしたパスワードの照合を飛ばした | `ap_breached_check_skipped`（独自） | 照合できなかった理由 |

- ログにパスワード・その SHA-1・識別子の平文（メールアドレス）を出さない。IP は出す（調査に要る。保持は L5）。

## 9. テナントの設定

```ts
type AttackProtection = {
  brute_force: {
    mode: "off" | "monitor" | "enforce";
    max_attempts: number;              // 1..100, default 10
    account_lockout: boolean;          // default false
    notify_user: boolean;              // default true
    allowlist: string[];               // CIDR, <= 100
  };
  suspicious_ip: {
    mode: "off" | "monitor" | "enforce";
    login:  { max_attempts: number; per_day: number };   // 100 / 100
    signup: { max_attempts: number; per_day: number };   // 50 / 72000
    reset:  { max_attempts: number; per_day: number };   // 50 / 1440
    notify_admins: boolean;            // default true
    allowlist: string[];               // CIDR, <= 100
  };
  breached_password: {
    mode: "off" | "monitor" | "enforce";
    login_actions: ("block" | "notify_user" | "notify_admin")[]; // default ["block","notify_user"]
    signup_and_reset: "block";         // not configurable in enforce mode
  };
  bot_detection: {
    mode: "off" | "monitor" | "enforce";
    policy: { login: Policy; signup: Policy; reset: Policy };     // Policy = "never" | "when_risky" | "always"
    level: "low" | "medium" | "high";  // default "medium"
    provider: "pow";                   // third-party providers after L2
  };
};
```

- 設定はテナントの設定のキャッシュに載る（[ADR-0032](../decisions/0032-tenant-config-cache.md)）。反映は最大でキャッシュの古さの分遅れる。
- 開発・ステージングのテナント（`environment`）でも既定は同じ。負荷試験は、許可リストでなく、テナントの設定で `monitor` にして行うよう文書で示す。

## 10. 障害時の振る舞い

| 事象 | 振る舞い |
| --- | --- |
| Valkey の障害 | 各タスクのメモリーの近似の数で続ける（ADR-0005）。タスクの数（S1 のピークで 18）だけ上限が実質的に緩む。既存のブロック（DB の行）は効き続ける。チャレンジの使用済みの記録はタスクごとになり、同じ解の再利用を別のタスクで 1 回許しうる（期限 5 分で抑える） |
| Aurora の writer のフェイルオーバー | ブロックの行を書けない。Valkey の数だけで判定し、上限に達した識別子 × IP は、書けるまで 429 にする |
| Aurora の reader の遅れ | ブロックの行の読み込みは writer から（まれなので） |
| 漏えいしたパスワードのデータ（S3）・API の障害 | 5.4 の表。サインアップと変更は 503、ログインは続ける |
| 取り込みのジョブの失敗 | 前の版を使い続ける。版が 45 日を超えて古くなったら呼び出す |
| WAF のラベルが来ない | そのシグナルなしで点数を計算する（点数は下がる方向） |
| 誤検知の大量の発生（CGNAT、イベントの集中） | 監視の指標（11 節）で見つけ、runbook の手順でテナントを `monitor` に切り替える |
| 攻撃による Argon2id の枯渇 | 段 1〜3 がハッシュの前で落とす。それでも同時実行の上限に達したら 503（ADR-0004） |

## 11. 指標

| 指標 | 用途 | アラート |
| --- | --- | --- |
| 防御ごとの `block`・`challenge` の件数（テナント別、プラットフォーム全体） | 攻撃の検知 | 平常の 10 倍 |
| 既知の端末の Cookie を持つ要求の `block` の割合 | 誤ブロック（K5 の 0.1%） | 0.1% 超 |
| チャレンジの成功率・解くまでの時間（p95） | 正規の利用者の負担 | 成功率 95% 未満、p95 3 秒超 |
| 漏えいしたパスワードの照合の時限切れ・飛ばした件数、データの版の古さ | 照合の健全さ | 時限切れ 1% 超、版 45 日超 |
| Valkey の縮退で判定した件数 | fail の頻度 | 1 件でも |
| Argon2id の同時実行の上限による 503 | 防御の漏れ | 1 分に 10 件 |

## 12. セキュリティとプライバシー

- **識別子を平文で持たない。** 数とブロックの行は、テナントの鍵の HMAC の値で持つ。ログには HMAC の先頭だけ。
- **ユーザーの有無を漏らさない**（3.3）。ブロックの画面とメールは、有無で画面の文言・時間を変えない。
- **プラットフォームのバケツ**は、テナントをまたいで IP の数を使う。テナントの個人データは渡らないが、IP は個人データになりうるので、法務の L1 で「プラットフォームの安全のための処理」として整理する（[security.md](security.md) の法務の論点）。
- **PoW は端末の情報を集めない。** 端末の指紋（canvas など）は取らない。電気通信事業法の外部送信規律（L2）の対象になる外部への送信もない。第三者の CAPTCHA を足すときは L2 の結論に従う。
- **WAF の ATP**（パスワードを WAF に検査させる）は、法務の L1 と E8 で使うかを決める（[infrastructure.md](infrastructure.md) の 4.3 節）。この領域の既定は「使わない」。
- 既知の端末の Cookie は `Secure`・`HttpOnly`・`SameSite=Lax`、テナントのホスト名に限る。中身から識別子は読めない（HMAC）。

## 13. テスト

### 13.1 決定表

段 3（ブルートフォース）：

| # | 既知の端末の Cookie | 識別子 × IP の失敗 | アカウントのロック | 識別子 × 端末の失敗 | ユーザーの有無 | 期待 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | なし | 9 | 無効 | — | あり | 照合へ |
| 2 | なし | 10 | 無効 | — | あり | `block`。ユーザーにメール |
| 3 | なし | 10 | 無効 | — | なし | `block`。画面・時間は 2 と同じ。メールなし |
| 4 | あり | 10（同じ IP の他人） | 無効 | 0 | あり | 照合へ（CGNAT の正規の利用者） |
| 5 | あり | — | 無効 | 10 | あり | `block` |
| 6 | なし | 3 | 有効（全 IP で 10 に達した） | — | あり | `block` |
| 7 | あり | — | 有効（全 IP で 10 に達した） | 0 | あり | 照合へ |
| 8 | なし | 10 | 無効 | — | あり、許可リストの IP | 照合へ。ログに残す |
| 9 | なし | 10 | 無効、`mode=monitor` | — | あり | 照合へ。`would_block` |

解除：

| # | 手段 | 期待 |
| --- | --- | --- |
| 1 | 最後の失敗から 30 日 | 解除 |
| 2 | 解除のリンク（1 回目） | 解除。リンクは使用済み |
| 3 | 解除のリンク（2 回目・期限切れ） | 無効の画面。状態は変わらない |
| 4 | パスワードの再設定の完了 | そのユーザーの全識別子（リンクした ID を含む）の全 IP のブロックを解除 |
| 5 | 管理者の API | 解除。監査ログ |

- 5.4 の漏えいしたパスワードの表、6.2 のモードの表を結合テストにする。

### 13.2 性質ベーステスト（fast-check）

- 任意の時刻つきの試行の列で、トークンのバケツの残りは 0 以上・容量以下。任意の 24 時間の窓で通る数は「容量＋補う数」を超えない。
- 任意の失敗・成功の列で、識別子 × IP の失敗が上限に達した後、その組の照合（Argon2id）は一度も呼ばれない（ハッシュの呼び出しを数えるスパイで確かめる）。
- 任意の要求の列で、`monitor` のモードの防御は `block`・`challenge` を返さない。
- 任意の識別子について、ユーザーがある場合とない場合で、段 3 の応答の本文・状態コード・ヘッダーが同じ。
- 任意のパスワードで、範囲の照会に渡る値は 5 文字の 16 進だけ。ログ・キューに SHA-1 の 40 文字の形が出ない。
- 任意のチャレンジで、同じ `challenge_id` の解は 2 回通らない。別のトランザクションの解は通らない。

### 13.3 模擬の試験（K5、E8）

- 合成の正規の利用者（CGNAT を模した共有の IP、既知の端末の Cookie を持つ割合、打ち間違い）と、クレデンシャルスタッフィング（漏えいの一覧の識別子とパスワード、住宅の IP のプロキシを模した多数の IP、低速の分散）を staging で混ぜて流す。
- 合格：攻撃の試行の 99% 以上が `block`・`challenge` で止まる。正規のログインの誤ブロックが 0.1% 以下。
- 攻撃の側の方式（分散の度合い、JavaScript の実行の有無）を変えた組を、少なくとも 5 通り回す。

## 14. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0024](../decisions/0024-attack-protection-counters-and-enforcement.md) | 防御の判定をハッシュの前の 1 つの段にまとめ、数は Valkey、ブロックは DB。識別子の HMAC と既知の端末の Cookie。`off`・`monitor`・`enforce` | accepted |
| [0025](../decisions/0025-breached-password-detection.md) | 漏えいしたパスワードは k-匿名性で照合する。自前のホストは利用条件の確認を条件にし、確認までは公式の range API を使う | accepted |
| [0026](../decisions/0026-bot-detection-and-challenge.md) | ボットの検知は自前の点数と PoW のチャレンジ。WAF はエッジの後ろ盾。第三者の CAPTCHA は L2 の後 | accepted |

## 15. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | `packages/attack-protection` の骨格（段の順序、Valkey の Lua、タスクのメモリーの縮退） |
| E4 | ログイン・サインアップ・再設定の要求の段 1・3 の組み込み（`enforce` の既定）。ブロックの画面の文言（列挙の防止） |
| E4 | サインアップ・変更・再設定での漏えいしたパスワードの拒否（予備の案の range API で先に作る） |
| E7 | MFA の失敗を段 3 に数える |
| E8 | ブルートフォースの防御の全体（既知の端末の Cookie、アカウントのロック、解除のリンク、再設定での解除、管理者の API） |
| E8 | 不審な IP の抑制（テナントとプラットフォームのバケツ、許可リスト、管理者への通知） |
| E8 | ログインでの漏えいしたパスワードの照合と動作（`block`・`notify_*`・`monitor`） |
| E8 | 漏えいしたパスワードのデータの取り込みと自前の範囲の配信（法務の確認の後） |
| E8 | リスクの点数と WAF のラベルの受け渡し、PoW のチャレンジ、JavaScript なしの経路の扱い |
| E8 | 監視のモード、通知、指標とアラート |
| E8 | K5 の模擬の試験 |
| E9 | ダッシュボードの攻撃の防御の設定の画面、ブロックの一覧と解除 |
| E10 | 攻撃の防御のイベント（8 節）のログとログストリーム |
| E12 | 本番の閾値の見直し、WAF の Challenge への切り替えの訓練 |
| MVP の後 | 第三者の CAPTCHA の持ち込み（L2 の後）、リスクに応じた MFA（S2） |

## 16. 品質・運用・データへの引き継ぎ

- [quality.md](../quality.md) に入れる候補：
  - リスク：誤ブロックによるログインの停止と、防御の漏れ（上位のリスク）。K5 の模擬の試験を E8 の合格の基準とリリースの基準にする。
  - 段の順序（ハッシュの前）と列挙の防止の性質ベーステストを、`security:sensitive` の変更の必須のテストにする。
  - 本番での検証：11 節の指標。既知の端末の Cookie を持つ要求の `block` の割合を、誤ブロックの代わりの指標として日次で見る。
- [runbooks/](../runbooks/README.md) に入れる候補：
  - クレデンシャルスタッフィングの波（検知、テナントの `always` への切り替え、WAF の Challenge への切り替え、プラットフォームのバケツの一時の引き締め）。[runbooks/incident-response.md](../runbooks/incident-response.md) の「クレデンシャルスタッフィングの波」から呼ぶ。
  - 誤ブロックの大量の発生（特定の携帯の回線、イベントの集中）：`monitor` への切り替え、一括の解除、閾値の見直し。
  - 漏えいしたパスワードのデータの取り込みの失敗と、古い版での運転。
  - Valkey の障害中の防御の縮退の確認。
  - ユーザーから「ブロックされた」の問い合わせを受けたテナントへの案内（解除の手段）。
- [data-model.md](data-model.md) の索引に入れる候補：`brute_force_blocks`、テナントの設定の `attack_protection`、`breached_password_versions`（プラットフォームの表。版、件数、取り込みの日時、状態）、`password_credentials.breach_detected_at`（connections の表への追加の提案）、Valkey のキー（4.3。正本ではない）、既知の端末の Cookie の形。

## 17. 未解決の問い

- Pwned Passwords のデータセットを自前で保存して商用のサービスの中で使ってよいか（5.3）。法務とデータの提供者への問い合わせ。
- 日本の携帯の回線の CGNAT で、1 つの IP を共有する利用者の数と、既知の端末の Cookie で足りるか。E8 の模擬の試験と本番の監視のモードで確かめる。
- プラットフォームのバケツ（テナントをまたぐ IP の数）の法的な整理（L1）。
- 第三者の CAPTCHA を提供するか、どの提供者か（L2 の後）。
- WAF の ATP を使うか（L1、費用）。

### 決定（2026-09-27、既定案）

- **数の単位**：識別子（HMAC）× IP（IPv6 は /64）。既知の端末の Cookie を持つ要求は識別子 × 端末で数える。本家にない仕組みで、CGNAT の誤ブロックを減らすため。
- **ブルートフォースの既定**：10 回、30 日、解除のリンク 24 時間。アカウントのロックは既定で無効。
- **不審な IP の既定**：本家の値（ログイン 100／1 日 100、サインアップ 50／1 日 72,000）。サインアップの上限は 1 分の単位で読む。再設定とユーザー名の接続のサインアップのバケツを足す。
- **漏えいしたパスワード**：ログインの既定は `block`＋`notify_user`。データの自前のホストは確認の後。確認までは公式の range API を使う。そのための ADR-0005 の縮退の表の行（照合できないときはサインアップ・変更・再設定を 503、ログインは飛ばして次に調べる）を、推奨案で確定した（2026-09-27）。
- **ボットの検知**：自前の PoW を既定。JavaScript なしの経路は緩めない。第三者の CAPTCHA は MVP で提供しない。
- **監視のモード**：防御ごとの明示の値。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| リスクの点数の重みと水準の閾値 | E8 の模擬の試験と、本番の最初の 4 週の監視のモードのログ |
| PoW の難しさ `d` の範囲 | E8。中位の Android 端末と古い iPhone で解くまでの時間を測る |
| 本家の未検証の振る舞い（2 節の未検証の項目） | E8 の着手前に試用のテナントで確かめる |
| WAF のレート制限の値（infrastructure.md の 4.3 節）との重なり | E8 と E12 の負荷試験で、エッジとアプリのどちらが先に効くかを確かめて調整する |

## References

- Auth0 Docs: [Brute-Force Protection](https://auth0.com/docs/secure/attack-protection/brute-force-protection)、[Suspicious IP Throttling](https://auth0.com/docs/secure/attack-protection/suspicious-ip-throttling)、[Breached Password Detection](https://auth0.com/docs/secure/attack-protection/breached-password-detection)、[Bot Detection](https://auth0.com/docs/secure/attack-protection/bot-detection)（2026-09-27 に確認）
- Auth0 Support: [Default Values for Suspicious IP Throttling](https://support.auth0.com/center/s/article/Default-values-for-Suspicious-IP-Throttling)（2026-09-27 に確認）
- NIST: [SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html)（3.1.1.2 節：侵害の証拠での変更の強制。3.2.2 節：試行の制限とボットの検知のチャレンジ。2026-09-27 に確認）
- Have I Been Pwned: [API v3](https://haveibeenpwned.com/API/v3)、[Pwned Passwords](https://haveibeenpwned.com/Passwords)、[Terms of Use](https://haveibeenpwned.com/TermsOfUse)（2026-09-27 に確認）
- Cloudflare: [Turnstile](https://developers.cloudflare.com/turnstile/)、[Turnstile Plans](https://developers.cloudflare.com/turnstile/plans/)、[Server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)（2026-09-27 に確認）
- Google Cloud: [reCAPTCHA Compare tiers](https://docs.cloud.google.com/recaptcha/docs/compare-tiers)（2026-09-27 に確認）
- hCaptcha: [hCaptcha Pro](https://www.hcaptcha.com/pro)（2026-09-27 に確認）
- AWS: [AWS WAF Pricing](https://aws.amazon.com/waf/pricing/)（2026-09-27 に確認）
- OWASP: [Slow Down Online Guessing Attacks with Device Cookies](https://owasp.org/www-community/Slow_Down_Online_Guessing_Attacks_with_Device_Cookies)（ログインの識別子・nonce・HMAC の署名を持つ端末の Cookie で、既知の端末を個別に数え、未知の端末をまとめて締め出す。2026-09-27 に確認）

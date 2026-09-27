# Meeting Security: Zoom

会議に知らない人を入れない仕組みと、入られたときに主催者が 1 回の操作で対処できる仕組みの設計。待合室、パスコード、会議のロック、退出させた人の再入室の禁止、参加者の活動の一時停止、荒らしの報告、会議の ID の推測への対策、参加の流量の制限を決める。

前提となる決定は、会議の ID は秘密ではなく、URL のフラグメントの参加の鍵がパスコードの入力だけを省くこと（[ADR-0006](../decisions/0006-meeting-id-and-join-url.md)）、会議の状態は Meeting Actor が持つこと（[ADR-0005](../decisions/0005-meeting-state-and-signaling.md)）、失ってはならない変更は配る前に Aurora に書くこと（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)）、主催者の操作は Actor が判定して Media Node で強制すること（[ADR-0009](../decisions/0009-host-controls-enforcement.md)）。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0031](../decisions/0031-waiting-room-and-passcode-rules.md) | すべての会議に、待合室かパスコードの少なくとも一方を必ず付ける（既定は両方）。パスコードは既定で 6 桁の数字。待合室を省けるのは、身元で判定する条件（主催者と同じ組織のログインした人、許可したドメイン、招待したアカウント）だけで、参加の鍵やパスコードでは省けない。パスコードは主催者に見せるため KMS で暗号化して持ち、照合には HMAC を使う |
| [0032](../decisions/0032-removal-ban-suspend-and-reports.md) | 退出させた人は、アカウントは `user_id`、ゲストは端末の鍵で ban に入れる。同じ回線（IPv4 の /32、IPv6 の /64）から入るゲストは、待合室に回して主催者に印を見せる。「参加者の活動を止める」は 1 回の操作で、全員のマイク・カメラ・共有・チャット・名前の変更を止め、会議をロックし、録画を一時停止する。報告は会議の中から送れ、報告された人の身元の情報を自動で添える |
| [0033](../decisions/0033-join-rate-limits-and-enumeration-defense.md) | 参加の要求は、IP・会議・パスコードの誤りの 3 つの軸でトークンバケットにかける。存在しない会議とパスコードの誤りは同じ応答と同じ時間にする。1 つの IP が短い時間に多くの会議の番号を試したら、AWS WAF の CAPTCHA を求める。1 つの会議へのパスコードの誤りが多いときは、その会議の鍵のない参加を止め、主催者に知らせる |

## 1. 目的と範囲

- 扱う：参加の許可の判定（待合室・パスコード・ロック・ban・定員）、パスコードの形式と保存、待合室の振る舞い、待合室を省く条件、退出させた人の再入室の禁止、参加者の活動の一時停止、荒らしの報告と運営の対処、会議の ID の推測への対策、参加の流量の制限。
- 扱わない：参加のトークンと参加の鍵の作り方（[signaling-and-meetings.md](signaling-and-meetings.md) の 4 節）、主催者の操作の決定表の全体（同 9 節）、組織の設定の強制の仕組み（[accounts-and-admin.md](accounts-and-admin.md)）、個人の会議の ID（[scheduling-and-calendar.md](scheduling-and-calendar.md)）、E2EE の会議のセキュリティのコード（[e2ee.md](e2ee.md)）、脅威モデルの全体と監査ログの保持（[security.md](security.md)）。

## 2. 本家の形（確かめたこと）

| 項目 | 本家（公開情報） | この設計 |
| --- | --- | --- |
| 待合室かパスコード | 2020-09-27 から、どちらかを必ず有効にする（[May 2020: Passcode and security settings](https://support.zoom.us/hc/en-us/articles/360042647952-May-2020-Passcode-and-security-settings)。intent.md の出典）。どちらもない場合の扱いは、待合室の文書には書かれていない | 同じ。既定は両方（ADR-0031） |
| パスコード | 組織の設定でパスコードの要件を選べる。「招待のリンクにパスコードを埋め込む」設定がある。要件の変更は、既に予定した会議に効かない（[Managing Zoom Meetings passcodes](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0063160)）。長さは最大 10 文字（Meetings API の `password` の `maxLength: 10`。[Meetings API の定義](https://developers.zoom.us/api-hub/meetings/methods/endpoints.json)） | 長さ 6〜10、既定 6 桁の数字。埋め込みはフラグメントの参加の鍵で行う（ADR-0006） |
| 待合室を省く条件 | 同じアカウントのユーザー、許可したドメインでサインインした人、招待を受けた人（カレンダーの連携を含む）、同じ組織につながったアカウントの人、会議の中で主催者が招待した人、許可した SIP・H.323 の機器を選べる（[Enabling and customizing the waiting room](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0059359)） | 身元で判定する条件だけにする（ADR-0031） |
| 活動の一時停止 | 「Suspend participant activities」で、全員の映像・音声・Zoom Apps・画面共有を止め、会議をロックする（[Changing security settings in a Zoom meeting](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0061231)）。チャット・注釈・録画・ブレイクアウトルームは、一次の文書の一覧に無い（大学の IT の解説は含めていた） | 同じ考え方で、チャットも止める。録画は止めずに一時停止にする（ADR-0032） |
| 参加者の報告 | 主催者・共同主催者が、参加者を選び、理由と添付を付けて本家の Trust and Safety に報告できる（[3 New Ways We're Combatting Meeting Disruptions](https://www.zoom.com/en/blog/new-ways-to-combat-zoom-meeting-disruptions/)） | 同じ。参加者も報告できる（6 節） |
| 設定の強制 | 設定に鍵をかけると、下の階層で変えられない（KB0063160） | [accounts-and-admin.md](accounts-and-admin.md) |

いずれも 2026-09-27 に確認。

## 3. 参加の許可の判定

### 3.1 流れ

```
Browser                    API（POST /v1/meetings/{number}/join）                 Actor（hello の後）
  │ number、join_key?、passcode?、display_name、device_key
  │ ───────────────────────▶│ 1. 流量の制限（8 節）
  │                         │ 2. 会議を引く。なければ 5 へ（同じ応答）
  │                         │ 3. パスコード（または参加の鍵）の検査 → passcode_ok
  │                         │ 4. 待合室を省けるか（bypass）の判定 → bypass_waiting
  │                         │ 5. 失敗は 404 meeting_not_found_or_passcode_invalid（同じ時間）
  │◀─ join_token（passcode_ok、bypass_waiting、device_key_hash、ip_prefix_hash を含む）
  │ ── WSS hello{token} ───────────────────────────────────────────────────────────▶│ 6. ban・ロック・定員・E2EE
  │                                                                                  │ 7. 待合室か入室か（3.2 節）
  │◀────────────────────────── welcome{status: waiting | admitted} ─────────────────│
```

- 1〜5 は API で行う。会議の中の状態（ロック、ban、待合室、定員）に依るものは、Actor が 6〜7 で決める（[signaling-and-meetings.md](signaling-and-meetings.md) の 4.4 節）。
- ロックと ban は API でも Aurora を見て先に拒否してよいが、正は Actor の判定とする（競合の結果を Actor の順序で決めるため）。

### 3.2 決定表の草案

上から順に評価し、最初に一致した行を採る。ID は E3 の `spec.md` に移すときに振る（`DT-SEC-*`）。

| # | 役割の資格（トークンの `role_hint`） | ban にある | ロック中 | 同じ回線の ban のゲスト | 定員に達した | 待合室が有効 | `bypass_waiting` | 結果 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `host` | - | - | - | - | - | - | 入室（ロック・定員・待合室を無視。ban は主催者に効かない） |
| 2 | - | はい | - | - | - | - | - | `Rejected(removed)` |
| 3 | - | いいえ | はい | - | - | - | - | `Rejected(locked)` |
| 4 | - | いいえ | いいえ | - | はい | - | - | `Rejected(full)` |
| 5 | - | いいえ | いいえ | はい | いいえ | - | - | 待合室。主催者の一覧に「退出させた人と同じ回線」の印 |
| 6 | - | いいえ | いいえ | いいえ | いいえ | はい | いいえ | 待合室 |
| 7 | - | いいえ | いいえ | いいえ | いいえ | はい | はい | 入室 |
| 8 | - | いいえ | いいえ | いいえ | いいえ | いいえ | - | 入室（API で `passcode_ok` を確かめ済み。ADR-0031 の不変条件により、待合室がなければパスコードがある） |

- `role_hint = cohost`（予定の会議で指名した共同主催者）は、1 行目ではなく 6・7 行目で扱い、`bypass_waiting` を真にする。
- 主催者がまだいない会議（Open）では、6・7・8 行目の「入室」も「主催者を待っています」の画面になる。会議の設定 `join_before_host` が真のときだけ、主催者の前に入室させる。`join_before_host` は、待合室が無効な会議でしか選べない（主催者のいない会議で、待合室の人を入れる人がいないため）。
- 定員（4 行目）は、主催者・共同主催者の資格を持つ人には効かない。

### 3.3 待合室を省く条件（`bypass_waiting`）

API が、トークンを発行するときに決める。どれか 1 つに当たれば真。

| 条件 | 既定 | 判定のもと |
| --- | --- | --- |
| 共同主催者として指名されている | 真 | 会議の設定の `alternative_hosts`（[scheduling-and-calendar.md](scheduling-and-calendar.md)） |
| 主催者と同じ組織のアカウントでログインしている | 組織の設定（既定：省く） | セッションの `org_id` |
| 許可したドメインのメールアドレスでログインしている | 組織の設定（既定：なし） | 確認済みのメールアドレスのドメイン。組織が DNS で確かめたドメインに限らず、他組織のドメインも書ける |
| 招待したアカウント | 会議の設定（既定：省かない） | ログインしたアカウントの確認済みのメールアドレスが、会議の招待の一覧にある |
| 会議の中から主催者が招待した（`host.invite`） | 真 | Actor が発行した 1 回限りの招待のトークン |

- 参加の鍵（URL のフラグメント）とパスコードでは、待合室を省かない（ADR-0031）。URL が漏れても、主催者が待合室で確かめられる。
- ゲスト（アカウントなし）が待合室を省けるのは、`host.invite` のときだけ。
- 個人の会議の ID（PMI）の会議は、組織の設定にかかわらず、同じ組織の人以外は待合室を省けない（[scheduling-and-calendar.md](scheduling-and-calendar.md) の ADR-0034）。

## 4. パスコード

ADR-0031。

### 4.1 形式

| 項目 | 既定 | 組織の設定で選べる範囲 |
| --- | --- | --- |
| 文字 | 数字だけ | 数字だけ、英数字（大文字小文字を区別） |
| 長さ | 6 | 6〜10 |
| 作り方 | CSPRNG から一様に作る | 主催者が変えられるかを選べる。変えるときも組織の規則に合わせる |
| 禁止 | 同じ数字の繰り返し（`000000`）、連番（`123456`・`654321`）、会議の番号の一部 | — |

- 数字だけを既定にするのは、電話からの参加（MVP の後。[telephony.md](telephony.md)）で押しボタンで入力できるようにするため。英数字を選んだ組織の会議は、電話から入るときに別の数字のパスコード（`phone_passcode`、同じ長さ）を使う。
- 6 桁の数字の空間は 10^6 で、それだけでは推測に弱い。8 節の制限（会議ごとに 1 時間 50 回の誤りで鍵のない参加を止める）と合わせて、1 つの会議を当てる確率を 1 時間あたり 1/20,000 以下に抑える。

### 4.2 保存と照合

- 主催者は、招待のためにパスコードを見られる必要がある。そのため、ハッシュだけでは持てない。
  - `passcode_ciphertext`：KMS で守るデータの鍵で暗号化した値（主催者と管理者の API だけが復号する）。
  - `passcode_hmac`：`HMAC-SHA256(pepper, meeting_id || passcode)`。照合はこちらで行い、定数時間で比べる。`pepper` は KMS で守り、参加の API のタスクだけが持つ。
- パスコードをログ・トレース・メトリクスに出さない（本題材の AGENTS.md）。
- パスコードを変えると、古いパスコードはすぐに使えない。既に入っている人は影響を受けない。参加の鍵は別に作り直す（[signaling-and-meetings.md](signaling-and-meetings.md) の 4.1 節）。

## 5. 待合室

### 5.1 振る舞い

- 待合室の人には、会議の参加者の一覧、メディア、チャットを送らない。送るのは、待合室の画面の文言（主催者が決める）、録画中かどうか（[recording-and-transcription.md](recording-and-transcription.md) の 7.1 節）、主催者からの待合室あてのメッセージだけ。
- 待合室の画面に、会議の題名を出すかは組織の設定（既定：組織の外の人には出さない）。題名は会議の存在と中身を漏らしうるため。
- 主催者・共同主催者には、`waiting.joined` で、表示の名前、ログインしているか、確認済みのメールのドメイン、印（5 行目の「同じ回線」、報告された端末の鍵）を送る。
- 主催者の操作：1 人ずつ入れる（`host.admit`）、全員を入れる（`host.admit_all`）、断る（`host.deny`）、待合室へ戻す（`host.to_waiting`）、待合室の全員へのメッセージ。

### 5.2 上限

| 項目 | 上限 | 超えたら |
| --- | --- | --- |
| 1 会議の待合室の人数 | 200 | 新しい人は `Rejected(waiting_full)`。主催者に「待合室が混んでいます」を知らせる |
| 1 つの回線（/32・/64）から同じ会議の待合室 | 3 人 | 4 人目は `Rejected(rate_limited)` |
| 待合室にいられる時間 | 主催者がいる間は無制限。主催者のいない会議（Open）は 2 時間 | 2 時間で切る |
| `host.admit_all` の 1 回で入れる人数 | 定員まで | 残りは待合室に残す |

## 6. 退出・ban・一時停止・報告

ADR-0032。

### 6.1 退出させた人の再入室の禁止

- 主催者・共同主催者の `host.remove` で、Actor が Aurora の `meeting_removals` に書いてから、接続を閉じる（[signaling-and-meetings.md](signaling-and-meetings.md) の 9.2 節）。
- ban の単位：

| 参加のしかた | ban の鍵 | 効く範囲 |
| --- | --- | --- |
| アカウントでログイン | `user_id` | 同じ会議（`meeting_id`。繰り返しの会議の別の回を含む）。主催者が許すまで |
| ゲスト | 端末の鍵（`device_key_hash`） | 同上 |
| ゲスト（同じ回線） | `ip_prefix_hash`（IPv4 の /32、IPv6 の /64） | 同じ会議。拒否はせず、待合室に回して印を付ける（3.2 節の 5 行目） |

- **端末の鍵**：Web クライアントが初めて起動したときに、128 ビットの乱数を作り、ブラウザの保存領域（IndexedDB）に置く。参加の要求で送り、API は `HMAC(pepper, device_key)` だけをトークンに入れる。ブラウザの保存領域を消せば逃れられるので、同じ回線の印と、待合室と、ロックで補う。
- **ban の解除**：主催者が「退出させた人」の一覧から許す（`host.readmit`）。`meeting_removals.readmitted_at` を書く。
- 同じ会議の別の回（繰り返しの会議、PMI）にも ban を効かせるのは、荒らしが次の回に戻ってくるのを防ぐため。ban は最後の開催から 30 日で消す。
- 会議を作り直す（別の `meeting_id`）と、ban は引き継がない。

### 6.2 参加者の活動を止める（`host.suspend`）

1 回の操作で、次をすべて行う。Actor は、1 つの `seq` の差分（`meeting.suspended`）として配る。

| 対象 | 動作 |
| --- | --- |
| 主催者と共同主催者を除く全員のマイク・カメラ・共有 | Media Node で producer を止める（`pause`、共有は `close`）。本人の解除を拒否する（`allow_self_unmute = false` と同じ） |
| チャット | 全員へのメッセージと個別のメッセージを止める（主催者・共同主催者を除く） |
| 名前の変更 | 止める |
| 会議 | ロックする |
| 録画 | 一時停止（`paused`）。止めない（止めると、主催者が再開の操作を忘れやすい） |
| 待合室 | 有効にする（無効だった会議も） |

- 解除は項目ごとに主催者が戻す。一括で戻す操作は作らない（荒らしがいる状態で全部を戻さないため）。
- 解除の画面で、報告（6.3 節）と退出（6.1 節）を続けて行える。

### 6.3 報告

```
POST /v1/meetings/instances/{instance_id}/reports
{ "reported_participant_ids": ["p_7Q"], "category": "harassment", "detail": "…（2,000 文字まで）",
  "attachments": ["upl_01J9..."] }        // 報告した人の端末で撮った画面の画像（3 枚まで、各 5 MB）
202 { "report_id": "rpt_01J9..." }
```

- 報告できる人：会議の参加者の全員（主催者・共同主催者に限らない）。ゲストも報告できる。流量は 1 人 1 会議 5 件。
- `category`：`harassment`・`sexual_content`・`violence`・`spam`・`impersonation`・`other`。
- サーバーが自動で添えるもの：報告された人の表示の名前、`user_id` か `device_key_hash`、参加と退出の時刻、`ip_prefix_hash`、ASN、参加のしかた（Web・電話）。報告した人の同じ項目。
- 自動で添えないもの：会議の音声・映像・チャットの本文。添付は、報告した人が自分の端末で見たものを、自分で選んで付けたものだけにする。通信の当事者が自分の受けた内容を示す形だが、扱いは L2 の結論に従う。
- 報告は運営の Trust & Safety の待ち行列（管理の画面）に入る。対処：
  - アカウントの停止（`users.status = suspended`。組織の管理者にも知らせる）
  - 端末の鍵の全体の ban（`global_device_bans`、90 日）
  - 報告された人の会議の主催の停止（荒らしが自分の会議を開いて誘う場合）
- 報告と添付の保持は 1 年。報告した人・された人の開示の請求の扱いは L8 の結論に従う。

## 7. 会議のロック

- `host.lock` で、Actor は新しい `join` を `Rejected(locked)` にする（3.2 節の 3 行目）。待合室の人は、ロックの後も主催者が入れられる。
- ロックは失ってはならない変更で、Aurora に書いてから配る（[ADR-0007](../decisions/0007-meeting-actor-lease-and-epoch.md)）。持ち主が替わっても、ロックは戻る。
- ロックは、その回の開催（`instance_id`）の間だけ。次の回には持ち越さない。

## 8. 流量の制限と推測への対策

ADR-0033。

### 8.1 推測で当たる確率

- 会議の番号は 11 桁で、空間は 9×10^10。S3 の見込み（予定を含めて有効な番号 1,000 万）で、1 回の推測で当たる確率は約 1/9,000（[ADR-0006](../decisions/0006-meeting-id-and-join-url.md)）。PMI は 10 桁で空間は 9×10^9。ユーザー 200 万人がすべて PMI を持つと、約 1/4,500 になる。
- 当たっても、パスコードか待合室が要る（ADR-0031）。推測への対策の目的は、(1) 当たった会議の待合室を荒らしで埋めさせないこと、(2) パスコードの総当たりをさせないこと、(3) 会議の存在と題名を漏らさないこと、である。

### 8.2 制限の表

| 軸 | 鍵 | 上限 | 超えたら |
| --- | --- | --- | --- |
| IP（参加の要求） | `ip_prefix`（/32・/64） | 毎分 30、瞬間 10 | `429`、`Retry-After` |
| IP（試した会議の番号の種類） | `ip_prefix` × 異なる `number` | 10 分に 20 | AWS WAF の CAPTCHA を求める（8.3 節）。解けなければ 1 時間 `429` |
| IP（存在しない会議） | `ip_prefix` | 1 時間に 50 回の `404` | 同上 |
| 会議 × IP（パスコードの誤り） | `(meeting_id, ip_prefix)` | 10 分に 10 回 | その IP からその会議へ、15 分 `429` |
| 会議（パスコードの誤りの合計） | `meeting_id` | 1 時間に 50 回 | その会議の「参加の鍵のない参加」を 1 時間止める。主催者に「パスコードの総当たりの疑い」を知らせ、パスコードの作り直しを勧める。参加の鍵のある URL と、ログインして待合室を省ける人は入れる |
| ログインしたアカウント | `user_id` | 毎分 60 | `429` |
| 会議の待合室 | 5.2 節 | — | — |

- 数は Valkey のトークンバケット（スライドする窓）で数える。鍵は `rl:{axis}:{value}`。Valkey が止まったときは、各タスクの手元の数だけで数える（上限をタスクの数で割る）。止まっても参加を止めない。
- `number` の種類の数は、HyperLogLog（`PFADD`）で数える。

### 8.3 応答をそろえる

- 存在しない会議と、パスコードの誤りは、同じ本文（`404 meeting_not_found_or_passcode_invalid`）で返す（[signaling-and-meetings.md](signaling-and-meetings.md) の 4.3 節）。
- 時間もそろえる：存在しない番号でも、ダミーの `passcode_hmac` との比較を行い、応答までの時間を最小 150ms にそろえる（p99 の差を 10ms 以内にすることを試験で確かめる）。
- 参加の Web の画面（`/j/<number>`）は、番号が存在するかにかかわらず同じ HTML を返す。題名は、パスコードの照合を通るか、待合室で主催者が見せる設定のときだけ出す。
- 待合室だけの会議（パスコードなし）は、`POST /join` がトークンを返すので、存在が分かる。これを避けるには両方を有効にする必要がある。既定を両方にしているのはこのため（ADR-0031）。
- CAPTCHA は AWS WAF の CAPTCHA のアクションを使う（参加の API の前の CloudFront・ALB）。WAF は Valkey の数を読めないので、次の形にする。
  - API が「この IP は CAPTCHA が要る」と判定したら、`403 challenge_required` を返す。
  - クライアントは、WAF の CAPTCHA の JavaScript の組み込みで画面を出し、解いた印（WAF のトークン）を付けて要求をやり直す。
  - API は、WAF が付けた「CAPTCHA を解いた」の印（WAF のラベルを ALB がヘッダーに写したもの）を見て、制限を 1 時間ゆるめる。
  - WAF は、CAPTCHA のパズルを画面の好きな場所に出す JavaScript の API（`renderCaptcha()`）を持ち、解いた後のトークンを付けて要求できる。使うには、許すドメインを入れた暗号化した API キーが要る（[Using the CAPTCHA JavaScript API](https://docs.aws.amazon.com/waf/latest/developerguide/waf-js-captcha-api.html)、2026-09-27 に確認）。WAF の「解いた」の印を ALB 経由で API に渡す部分は**未検証**で、E3 の `waf-captcha-challenge` で試作する。

## 9. 障害のときの振る舞い

| 障害 | 起きること | 対処 |
| --- | --- | --- |
| Valkey が止まった | 流量の制限が各タスクの手元の数になる | 上限をタスクの数で割って続ける。参加は止めない |
| Aurora が書けない | ban・ロックの記録が書けない | `host.remove`・`host.lock` は `unavailable` で失敗させる（状態を変えない）。ミュートと待合室の入退室は続く（[signaling-and-meetings.md](signaling-and-meetings.md) の 12 節） |
| Actor の持ち主の交代 | 最大 10 秒、主催者の操作が効かない | ban とロックは Aurora から戻る。待合室は突き合わせで戻る（同 10.2 節） |
| KMS が使えない | パスコードの復号（主催者の表示）ができない | 照合は HMAC で続く。`pepper` はタスクの起動時に取り出してメモリに持つ |
| WAF の CAPTCHA が使えない | 推測の疑いのある IP を通せない | 疑いのある IP だけ `429` のまま。他の IP は影響なし |
| 大量の待合室の荒らし | 主催者の画面が埋まる | 5.2 節の上限。主催者は `host.suspend` と「待合室の全員を断る」で対処する |

## 10. セキュリティとプライバシー

- 待合室もパスコードもない会議を作れる経路を作らない。API、組織の設定、カレンダーの連携、公開 API、予定の会議の更新のすべてで、同じ検査関数（`assertJoinGuard(settings)`）を通す（本題材の AGENTS.md、ADR-0031）。
- パスコード、参加の鍵、端末の鍵、IP をそのまま、ログ・トレース・メトリクスに出さない。ログに書くのは、ハッシュ（`device_key_hash`、`ip_prefix_hash`）と ASN だけ。`ip_prefix_hash` の `pepper` は 30 日ごとに替える。
  - **替えた後も、前の pepper を 30 日残す。** 同じ回線の判定は、今と前の両方の pepper で計算して `meeting_removals` と比べる。行には計算に使った pepper の版（`ip_pepper_version`）を残す。これで、同じ回線の印は退出させてから少なくとも 30 日効く（pepper を替えただけで ban の途中で判定が切れることを防ぐ。統合の工程で決めた）。
  - 繰り返しの会議で ban が 30 日より長く続く場合（最後の開催から 30 日）でも、同じ回線の印は 30〜60 日で切れうる。ban の本体（`user_id`・`device_key_hash`）は pepper に依らないので、期限まで効く。
- 報告の生の IP は、Trust & Safety の対処のためだけに、報告の行に暗号化して 90 日持つ。捜査機関への開示は L4 に従う。
- 端末の鍵は、ブラウザの指紋ではない。ブラウザの設定や端末の情報を集めない（外部送信規律。L5）。
- 報告の添付は、[chat-and-reactions.md](chat-and-reactions.md) の 5 節と同じマルウェアの検査を通す。

## 11. テスト

### 11.1 性質ベーステスト

- **PROP-SEC-001（守り）**：任意の設定の操作（作成、更新、組織の設定の変更、カレンダーからの作成、公開 API）の列の後、`waiting_room = false` かつ `passcode = null` の会議は 0 件。
- **PROP-SEC-002（ban）**：`host.remove` に `ack` を返した後、同じ `user_id`・`device_key_hash` の人が、`host.readmit` なしに Admitted になることはない。繰り返しの会議の別の回でも同じ。
- **PROP-SEC-003（待合室）**：`bypass_waiting` が偽の参加者が、主催者・共同主催者の `admit` なしに Admitted になることはない（待合室が有効な間）。
- **PROP-SEC-004（一時停止）**：`meeting.suspended` の `seq` より後、主催者・共同主催者以外の producer が再開することはない（主催者が項目を戻すまで）。

### 11.2 決定表

- 3.2 節の各行、3.3 節の条件の組み合わせ（`DT-SEC-*`）。

### 11.3 結合と攻撃の試験

| 試験 | 期待 |
| --- | --- |
| 1 つの IP から 1,000 個の番号を順に試す | 21 個目から CAPTCHA、解かなければ `429` |
| 1 つの会議に、100 個の IP からパスコードを総当たり | 1 時間 50 回で、鍵のない参加が止まる。主催者に知らせる |
| 存在しない番号と、存在する番号の誤ったパスコード | 本文が同じ。応答の時間の p99 の差が 10ms 以内 |
| ゲストを退出させ、IndexedDB を消して同じ回線から入り直す | 待合室に回り、主催者に印が見える |
| `host.suspend` の後、改造したクライアントが音声を送り続ける | 他の参加者に届かない |
| 参加の鍵のある URL で、待合室の有効な会議に入る | 待合室に入る（鍵で省けない） |

## 12. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E3 | `join-guard-invariant` | ADR-0031 の不変条件と `assertJoinGuard` を、すべての経路に入れる |
| E3 | `passcode-format-storage` | 4 節。暗号化と HMAC、禁止の規則 |
| E3 | `waiting-room-core` | 5 節。待合室の状態、`admit`・`admit_all`・`deny`・`to_waiting`、上限 |
| E3 | `waiting-room-bypass` | 3.3 節。組織・ドメイン・招待・`host.invite` |
| E3 | `removal-ban-guest-device` | 6.1 節。端末の鍵、同じ回線の印、`host.readmit` |
| E3 | `suspend-activities` | 6.2 節 |
| E3 | `participant-report` | 6.3 節。報告の API、添付、Trust & Safety の待ち行列 |
| E3 | `join-rate-limits` | 8.2 節。Valkey のトークンバケット、HyperLogLog |
| E3 | `enumeration-uniform-response` | 8.3 節。応答と時間をそろえる、Web の画面 |
| E3 | `waf-captcha-challenge` | 8.3 節。WAF の CAPTCHA の試作と組み込み |
| E12 | `trust-safety-console` | 報告の対処の画面、全体の端末の ban、アカウントの停止 |

## 13. 未解決の問い

### 決定

2026-09-27 の既定案。承認は Dev（テックリード）が行う。待合室を省く条件は PM の確認を取る。

- **守り**：待合室かパスコードを必ず付ける。既定は両方。
- **パスコード**：既定 6 桁の数字。組織で 6〜10、英数字を選べる。電話用の数字のパスコードを別に持つ。
- **待合室を省く条件**：身元で判定するものだけ。参加の鍵とパスコードでは省かない（[signaling-and-meetings.md](signaling-and-meetings.md) の 16 節の持ち越しの問いへの既定の答え）。
- **ゲストの ban**：端末の鍵。同じ回線は待合室へ回す。
- **一時停止**：録画は一時停止にとどめる。解除は項目ごと。
- **報告**：参加者の全員が送れる。会議の内容は自動で添えない。
- **流量**：8.2 節の表。パスコードの誤りが会議で 1 時間 50 回を超えたら、鍵のない参加を止める。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 参加の鍵を持つ人に待合室も省かせる設定を作るか | PM に確認する。既定は作らない |
| 報告の添付（報告した人の画面の画像）を受けてよいか（L2） | 法務の確認の後。E3 の報告の Story の承認の前 |
| 報告・ban の記録と IP の保持の期間、開示の請求（L4・L8） | 法務の確認の後 |
| WAF の CAPTCHA の結果を API にどう渡すか（SPA に出す JavaScript の API はある。8.3 節） | E3 の `waf-captcha-challenge` で試作する |
| 同じ回線の判定を、携帯の回線（多くの人が同じ IP を共有する）で外すか | E3 で、ASN が携帯の事業者のときの誤判定の率を測って決める |
| 組織の外の人に題名を見せない既定が、利用者に不便か | E3 の利用者の声で見直す |

## 14. quality.md・runbooks・data-model への項目

### quality.md

- 待合室もパスコードもない会議の数（K6。常に 0）。毎日の設定の監査で数える。
- 参加の要求のうち、`429`・CAPTCHA・`404` の割合。IP ごとの試した番号の種類の分布。
- パスコードの総当たりの疑いで、鍵のない参加を止めた会議の数。
- 報告の件数と、報告から Trust & Safety の対処までの時間。
- `host.suspend` から、対象の音声が止まるまでの p95（`host.mute` と同じ 500ms を目標）。
- 存在しない番号と誤ったパスコードの、応答の時間の差（p99 10ms 以内）。

### runbooks

- `meeting-id-enumeration.md`：推測の疑いの IP・ASN が増えたときの確かめ方と、WAF の規則の追加の手順。
- `passcode-bruteforce.md`：会議のパスコードの総当たりの疑いのときの、主催者への連絡と、パスコードの作り直しの案内。
- `trust-safety-report-triage.md`：報告の優先度の付け方、アカウントの停止、全体の端末の ban の手順。
- `waiting-room-flood.md`：待合室の荒らしの問い合わせへの対処（`host.suspend` の案内、上限の一時的な引き下げ）。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `meetings`（列の追加） | `waiting_room`、`passcode_ciphertext`、`passcode_hmac`、`phone_passcode_ciphertext`、`phone_passcode_hmac`、`join_before_host`、`bypass`（`org`・`domains`・`invitees`）、`show_topic_in_waiting_room` |
| Aurora `meeting_removals`（列の追加） | `device_key_hash`、`ip_prefix_hash`、`ip_pepper_version`、`expires_at`（最後の開催から 30 日） |
| Aurora `abuse_reports` | `report_id`、`instance_id`、`reporter`（`user_id` か `device_key_hash`）、`reported`（同）、`category`、`detail`（暗号化）、`attachments`、`ip_ciphertext`、`status`、`action`、`created_at`、`resolved_at` |
| Aurora `global_device_bans` | `device_key_hash`、`reason`、`report_id`、`expires_at` |
| Valkey `rl:{axis}:{value}` | 8.2 節のトークンバケット。`rl:nums:{ip_prefix}` は HyperLogLog |
| Valkey `sec:{m}:pwfail` | 会議のパスコードの誤りの数（1 時間） |

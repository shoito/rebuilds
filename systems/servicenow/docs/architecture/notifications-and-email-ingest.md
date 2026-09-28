# Notifications and email ingest: ServiceNow

通知の規則とテンプレート、受け手の解決、SES での送信、メールの受信とチケットへの紐付け（`Message-ID`・`In-Reply-To`・`References` と参照の印）、差出人の照合と、なりすましへの対策、自動の返信のループの防止、日本語の文字コード（ISO-2022-JP、Shift_JIS）の復号を決める。

前提の決定は、SES を東京で送受信に使うこと（[ADR-0001](../decisions/0001-platform-and-stack.md)）、outbox から Notifier が送ること（[architecture/README.md](README.md) の 1.2 節）、通知の本文を受け手ごとに受け手の主体で ACL を判定して作ること（[access-control.md](access-control.md) の 6.2 節の 11 行）、メールの返信での承認を受けないこと（[ADR-0016](../decisions/0016-approvals.md)）、ヘッダーと参照の印の名前に本家の名前を使わないこと（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）である。この文書で決めたことは次の ADR にある。

| ADR | 決定 |
| --- | --- |
| [0033](../decisions/0033-notification-rules-and-outbound-email.md) | 通知は、事象 → 規則 → 受け手 → 受け手ごとの本文、の順に Notifier で作り、`(事象, 規則, 受け手, 経路)` の一意で 1 回だけ送る。本文は受け手の主体で ACL を判定して差し込む。送るメールは UTF-8 だけにし、推測できない乱数の参照の印を付け、SES が付けた `Message-ID` を記録して返信の照合に使う |
| [0034](../decisions/0034-inbound-email-threading-and-sender-trust.md) | 受信は共有の入口（mail-ingress の SES → 一時の S3 → SQS → `mail-router`）からセルの S3・SQS を経て Ingest へ送り、SES のメッセージの ID で冪等にする。解決できない受け手はバウンスしない。紐付けは、転送の判定、`In-Reply-To`・`References` と送った ID の照合、参照の印、件名の番号（差出人がそのレコードの関係者のときだけ）の順で行う。差出人は認証の結果で信頼の段階を決め、社内のドメインを名乗る認証の通らないメールは保留にする。返信の追記は差出人の主体の ACL を通す |
| [0035](../decisions/0035-mail-loop-prevention-and-japanese-decoding.md) | 自動のメールは、ヘッダー（`Auto-Submitted`、`Precedence`、`List-Id`、空の差出人など）で見分け、自動の応答（受け付けの通知）を返さない。不在の自動の返信はチケットに追記しない。差出人・レコードごとの流量の上限で止める。文字コードは WHATWG の Encoding Standard の対応で復号し、ラベルのない 8 ビットは UTF-8 → Shift_JIS → EUC-JP の順に試す。原本は S3 に残す |

この文書の決定表・性質は設計の草案である。ID は E6 の各変更の `spec.md` に移すときに確定する。**メールの受信と自動の処理は、電気通信事業法の確認（[intent.md](../intent.md) の L2）が済むまで、E6 のメールからのチケットの `spec.md` を承認しない。**

## 1. 目的と範囲

- 扱う：通知の規則・テンプレート・受け手・言語、利用者の通知の設定、送信（SES）とその冪等、送信のドメインの認証、配信の失敗と苦情の抑止、受信の経路、受信の冪等、スレッドの紐付け、差出人の照合と信頼の段階、新しいレコードの作成の規則、返信の追記、本文の取り出し（引用の除去）、添付ファイル、自動のメールの見分けとループの防止、流量の上限、文字コードの復号。
- 扱わない：アプリのプッシュの配信の基盤（`portal-and-ui.md`）、Webhook（`api-and-integrations.md`）、当番の呼び出しの状態機械（[assignment-and-on-call.md](assignment-and-on-call.md) の 6 節。この文書は経路の 1 つとしてメールを送る）、SMS・音声（L8）、添付ファイルのウイルスの検査の仕組みの細部（`security.md`）、メールの本文の検索（`search.md`）。

## 2. 本家と外の資料（確かめたこと）

| 項目 | 中身 | 出典（2026-09-28 に確認） |
| --- | --- | --- |
| 受信のメールの種類 | 返信の接頭辞（既定 `re:`、`aw:`、`r:` など）と転送の接頭辞（`fw:`、`fwd:`）で種類を見分ける。参照の印（watermark）があれば、それを優先して既存のレコードに結ぶ。印がなければ件名の番号の接頭辞（INC など）でレコードを探す | [Inbound email action processing](https://www.servicenow.com/docs/r/platform-administration/inbound-action-processing.html) |
| 差出人の照合 | 差出人のメールアドレスを、有効な利用者のメールアドレスと照合する。メールアドレスは利用者ごとに一意であることが前提 | 同上 |
| 返信・転送・新規の順 | 転送は件名の接頭辞（既定 `fw:`、`fwd:`）、返信は返信の接頭辞か `In-Reply-To` で見分け、どちらの接頭辞もなければ新規。受信のフローは受信の処理より先に動く。転送に本文の `From:` も要ること、転送が返信より先に判定されることは二次の資料（[Inbound Email - New, Reply, and Forward](https://servicenowguru.com/system-definition/inbound-email-new-reply-forward/)）だけで、細部は未検証（本家の振る舞いで、DT-MAIL-001 の前提ではない） | [Inbound email action processing](https://www.servicenow.com/docs/r/platform-administration/inbound-action-processing.html) |
| 参照の印 | 通知の本文の末尾に、`Ref:` で始まる印（既定の接頭辞 `MSG`、自動の番号とランダムな文字列）を入れる。印を省くと、受信の処理が正しく動かないことがある | [Working with watermarks](https://www.servicenow.com/docs/r/platform-administration/c_WorkingWithWatermarks.html) |
| SES の受信 | 受信の規則（受け手の条件と、順に実行する動作：S3 へ、SNS へ、Lambda、ヘッダーの追加、バウンス、停止）。受け手の条件は SMTP の封筒の受け手（`RCPT TO`）で比べる。SPF・DKIM・DMARC で認証し、結果を `Authentication-Results` のヘッダーと通知に入れる。スパムとウイルスの判定を `X-SES-Spam-Verdict`・`X-SES-Virus-Verdict` に入れる。S3 に置くメールは 40 MB まで、SNS で受けるメールは 150 KB まで | [Amazon SES email receiving concepts](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html)、[Deliver to S3 bucket action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html) |
| SES の S3 の暗号化 | SES の暗号化を選ぶと、S3 の暗号化のクライアント（クライアント側の暗号化）で暗号化して置き、SES は復号しない。オブジェクトロックの既定の保持の期間のあるバケットには置けない | [Deliver to S3 bucket action](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-action-s3.html) |
| 返信のヘッダー | 返信は `In-Reply-To` に親の `Message-ID` を、`References` に親の `References` と親の `Message-ID` を入れる | [RFC 5322 3.6.4](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.4) |
| 自動の応答 | 自動の応答は `Auto-Submitted: auto-replied` を付けるべき。`Auto-Submitted` が `no` 以外のメールには自動の応答を返すべきでない | [RFC 3834](https://www.rfc-editor.org/rfc/rfc3834) |
| `Precedence` | 標準ではなく、使うことは勧められない。`bulk`・`list`・`junk` が自動の応答の抑止に使われている | [RFC 2076](https://www.rfc-editor.org/rfc/rfc2076)、RFC 3834 |
| ISO-2022-JP | 行の中に JIS X 0208 の文字があれば、行の終わりの前に ASCII（または JIS X 0201 のローマ字）へ戻す。本文は ASCII で終わる | [RFC 1468](https://www.rfc-editor.org/rfc/rfc1468) |
| 文字コードの対応 | `shift_jis`・`sjis`・`windows-31j`・`ms932` などのラベルは同じ Shift_JIS の復号器に対応し、その表（index jis0208）は IBM と NEC の拡張を含む。`iso-2022-jp`・`csiso2022jp` は ISO-2022-JP の復号器で、同じ index jis0208 を引く。NEC の特殊文字（13 区。丸数字など）と NEC 選定の IBM 拡張（89〜92 区）は 7 ビットの範囲にあり復号できる。IBM 拡張（115〜119 区）は 7 ビットの範囲の外で、ISO-2022-JP では表せない | [WHATWG Encoding Standard](https://encoding.spec.whatwg.org/) の 12.2.1 節、[index-jis0208.txt](https://encoding.spec.whatwg.org/index-jis0208.txt) |
| SES の送信のヘッダー | 送る側が `Message-ID` を付けても、SES が自分の値で上書きする。`Date` も上書きする | [Amazon SES header fields](https://docs.aws.amazon.com/ses/latest/dg/header-fields.html) |
| SES の送信の API | `SendEmail` は冪等のキーを持たない。応答は SES の `MessageId` だけ | [SendEmail（SES API v2）](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html) |

- 本家の参照の印の形（`Ref:MSG…`）、ヘッダー、受信の処理のスクリプトは写さない。
- SES は送る側の `Message-ID` を上書きする（上の表）。3.4・3.5 節は、自前の `Message-ID` を付けず、SES の ID から受け手に届く `Message-ID` を記録して照合する形にした（2026-09-28、検証の工程で直した。ADR-0033 の注記）。
- 日本の携帯のキャリアのメール、古いメールの道具が、ISO-2022-JP のラベルで NEC の特殊文字（丸数字など）を送ったり、Shift_JIS の中身に ISO-2022-JP のラベルを付けたりする実態がある（一般に知られる事情。出典はなく未検証。E6 `japanese-mime-decoding` で集めた実例の試験で確かめる）。前者は WHATWG の ISO-2022-JP の復号器で復号できる（上の表）。後者は 7.2 節の 2 行で救う。

## 3. 通知と送信（[ADR-0033](../decisions/0033-notification-rules-and-outbound-email.md)）

### 3.1 規則

| 列 | 意味 |
| --- | --- |
| `id`、`stable_key` | メタデータの共通の列 |
| `event` | `record.inserted` / `record.updated`（テーブルと条件） / `sla.warning` / `sla.breached` / `approval.requested` / `approval.decided` / `page.notify` / `flow.notify`（フローの `notify` のノード） / `kb.feedback` など |
| `table_id`、`condition` | 式の言語。保存の後の値と、変わったフィールド（`changes.<field>`）を読める |
| `recipients` | `field:<参照のフィールド>`（依頼者、担当者、承認者）、`group_members:<フィールドか固定>`、`group_manager`、`watchers`、`users:[…]`、`groups:[…]`、`emails:[…]`（テナントの外の宛先。上限 10） |
| `exclude_actor` | 真なら、事象を起こした本人に送らない（既定 真） |
| `template_id` | 4 節のテンプレート |
| `channels` | `email` / `push` / `in_app` |
| `mandatory` | 真なら利用者の通知の設定で止められない（承認の依頼、呼び出し、SLA の違反） |
| `active` | |

- 組み込みの規則（コードの版）：インシデントの受け付け（依頼者へ）、担当の割り当て（担当者・グループへ）、コメントの追加（依頼者・担当者へ）、解決（依頼者へ）、承認の依頼（承認者へ）、SLA の警告と違反、メジャーインシデントの状況の更新（[itsm-processes.md](itsm-processes.md) の 6.2 節）、要求の品目の完了。テナントは無効にでき、同じ形の規則を足せる。

### 3.2 流れ

```
Record Service の保存（outbox：record.changed）、Engine（sla.*、approval.*、flow.notify）
      │
      ▼
Notifier：事象ごとに
  1. 合う規則を選ぶ（テーブル・条件を、事象の後の値で評価。値は事象の時点のレコードの版を読む）
  2. 受け手を解く（利用者の ID の集合。無効の利用者、exclude_actor、重複を除く）
  3. 利用者の設定（mandatory でない規則を止めた人）を除く
  4. 受け手ごとに notification_message の行を作る（一意：event_id, rule_id, recipient, channel）
  5. 受け手ごとに本文を作る（4 節。受け手の主体で ACL を判定）
  6. 経路ごとに送る（email：SES、push、in_app）
```

- **レコードの値は、事象の時点の版で読む。** outbox の事象は `record_version` を持ち、Notifier は監査の履歴（`record_change`）からその版の値を組み立てる（今の値ではない）。遅れて送っても、通知の内容が事象と食い違わない。ただし ACL の判定は送る時点の権限で行う（権限を外された人に古い値を送らない）。
- 4 の一意の制約で、outbox の配送の重複（少なくとも 1 回）でも、同じ通知は 1 回だけ作る。6 の送信は `notification_message` の状態（`pending` → `sent` / `failed` / `suppressed`）を版の条件で進め、SES の送信の API の再試行で重複しないよう、`notification_message.id` を冪等のキーとして記録する（SES の送信の API は冪等のキーを持たない（2 節）。送信の直前に状態を `sending` にし、応答を受けたら `sent` にする。応答の前に落ちたら、再開の時に `sending` の行は「送ったかもしれない」として 1 回だけ再送する。重複は高々 1 通）。

### 3.3 送信のドメインと差出人

- 既定の差出人：`<tenant>@notify.<brand>.<domain>`。返信の宛先（`Reply-To`）はテナントの受信のアドレス（5.1 節）。
- テナントの独自のドメイン（例：`servicedesk@example.co.jp`）から送るには、テナントが DNS に DKIM（SES の Easy DKIM の CNAME）と、`MAIL FROM` のサブドメインの SPF を置き、確かめた後に有効にする。DMARC の揃いを満たさない設定は有効にしない。
- 送信の流量：SES のアカウントの上限を、セルのテナントで分け合う。テナントごとのトークンのバケット（既定 毎秒 10 通、毎日 5 万通）で送り、超えたら待たせる（捨てない）。値は E12 の負荷試験で決める。

### 3.4 ヘッダー

| ヘッダー | 値 | 理由 |
| --- | --- | --- |
| `Message-ID` | 付けない（SES が上書きする。2 節） | - |
| `In-Reply-To`・`References` | 同じレコードへの、その受け手への直前の通知の、受け手に届いた `Message-ID`（`email_outbound` にあれば） | メールの道具でスレッドにまとまる |
| `Auto-Submitted` | `auto-generated` | 受け手の自動の応答を抑える（RFC 3834） |
| `X-Auto-Response-Suppress` | `OOF, AutoReply` | Exchange・Microsoft 365 の不在の返信を抑える（標準ではない） |
| `<Brand>-Loop` | セルの ID とテナントの ID のハッシュ | 自分の送ったメールが戻ってきたことを見分ける（6 節） |
| `List-Unsubscribe` | 付けない | 業務の通知で、配信の停止は通知の設定の画面で行う |

### 3.5 送った ID の記録

- `email_outbound(tenant_id, message_id, ses_message_id, notification_message_id, table_id, record_id, recipient_user_id, sent_at)` に、SES が返す ID（`ses_message_id`）と、そこから作った、受け手に届く `Message-ID`（`message_id`）を記録する。
- 返信の `In-Reply-To`・`References` の照合（5.3 節）は `message_id` で引く。SES の ID と受け手に届く `Message-ID` のドメインの部分の対応は公式の文書に書かれていないため、E6 `notifier-outbound-email` で、送ったメールを受け手の側で読んで確かめ、作り方を固定する（未検証）。確かめるまでは、参照の印（5.4 節）が紐付けの主な手がかりである。
- 保持：90 日（返信は通常この中に来る）。その後の返信は参照の印か件名の番号で紐付く。

### 3.6 配信の失敗と苦情

- SES の配信の事象（バウンス・苦情・配信）を、構成のセットの事象の宛先から SQS で受ける。
- 恒久のバウンス（hard bounce）と苦情の宛先は、テナントの抑止のリスト `email_suppression(tenant_id, address, reason, until)` に入れ、以後送らない（`notification_message.state = suppressed`）。一時のバウンスは 3 回続いたら 7 日止める。
- 抑止した宛先への `mandatory` の通知（承認の依頼、呼び出し）は、送らずにアプリの `in_app` の通知と、グループの管理者への知らせで補う。

## 4. テンプレートと本文（[ADR-0033](../decisions/0033-notification-rules-and-outbound-email.md)）

- テンプレートは、件名と本文（制限付きの Markdown。[knowledge.md](knowledge.md) の 3.5 節と同じ）を、言語（`ja`・`en`）ごとに持つ。受け手の `user.language`、なければテナントの既定の言語で選ぶ。
- 差し込みは `{{record.number}}`、`{{record.title}}`、`{{record.requester.name}}`（参照のたどりは 2 段まで）、`{{record.link}}`、`{{comment.latest}}`、`{{approval.link}}` などの決まった形だけで、式の言語の式に限る（任意のコードを書かせない）。
- **差し込みは、受け手の主体で ACL を判定する。** 読めないフィールドは空、読めない参照先は「（表示できないレコード）」にする（[access-control.md](access-control.md) の 6.2 節の 6・11 行）。受け手がレコードそのものを読めなければ、その受け手には送らない（`suppressed`、理由 `no_read_access`）。
- 作業メモ（`work_note`）は、読める受け手（`agent` 以上）にだけ差し込む。依頼者への通知の `{{comment.latest}}` は、コメントだけを見る。
- テナントの外の宛先（`emails:[…]`）は、主体を持たないので、テンプレートの差し込みを「公開の項目」（番号、短い説明、状態）に限る。公開の項目の一覧はテーブルごとに組み込みで決め、テナントが狭められる。
- 本文の末尾に、返信の区切りの行（「この行より上に返信を書いてください」）と、参照の印（5.4 節）を入れる。
- **承認の依頼のメールには、ログインを求める画面へのリンクだけを入れる**（[workflow-engine.md](workflow-engine.md) の 7.5 節）。

## 5. 受信とスレッドの紐付け（[ADR-0034](../decisions/0034-inbound-email-threading-and-sender-trust.md)）

### 5.1 受信の経路

```
顧客のメールサーバー（servicedesk@example.co.jp への転送）
   → SES（mail-ingress のアカウント、東京。受信の規則：受け手 *@in.<brand>.<domain>、スパム・ウイルスの判定を有効）
   → S3（mail-ingress の一時のバケット。SSE-KMS。1 日で消える。SES のクライアント側の暗号化は使わない）
   → SNS（S3 の動作の通知）→ SQS → mail-router
        mail-router：封筒の受け手 → テナント → セル（制御の面の台帳の写し。テナントのデータを読まない）
                     セルの受信のバケット（SSE-KMS、テナントの接頭辞）へ写し、セルの SQS へ送り、一時のオブジェクトを消す
                     解決できない受け手：捨てて記録する。送り主へバウンスしない（後方散乱を避ける）
   → セルの SQS → Ingest
専用のセル：専用の受信のサブドメイン（<cell>.in.<brand>.<domain>）を、専用のセルのアカウントの SES で直接受ける
```

- 経路の正本は [infrastructure.md](infrastructure.md) の 2.3 節と [ADR-0055](../decisions/0055-accounts-cells-and-edge-router.md)。SES の受信の規則は受け手のアドレスで選ぶので、同じドメインの下のテナントを受信の規則の段でセルのバケットへ振り分けられない（テナントごとに規則が要る）。そのため、共有の入口に置いてから `mail-router` がセルへ振り分ける（統合で決めた。[ADR-0034](../decisions/0034-inbound-email-threading-and-sender-trust.md) の注記）。

- テナントの受信のアドレスは `<tenant>@in.<brand>.<domain>`（テナントのホスト名と同じ名前）と、テナントが作る別名（`<tenant>+<alias>@in.<brand>.<domain>`：部署ごとの窓口）。封筒の受け手（SES の通知の `recipients`）でテナントを決める。`To:` のヘッダーでは決めない（2 節。封筒の受け手が正）。
- **テナントの解決の前に、テナントのデータを読まない**（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)）。受け手のアドレス → テナント → セルの対応は、`mail-router` が制御の面の台帳の写し（`inbound_address`）で行い、そのセルの SQS に送る。**解決できない受け手は、捨てて記録する。送り主へバウンスしない。** 差出人は偽れるので、バウンスは無関係の第三者へ届く（後方散乱）。件数は `mail-router` の指標で見る（`mail-ingress-backlog.md`）。
- SES のクライアント側の暗号化を使わないのは、Ingest が S3 の暗号化のクライアントを要ることになり、他の S3 のオブジェクトと扱いが分かれるためである。バケットの既定の暗号化（セルの KMS の鍵）で守る。
- SES の S3 の上限は 40 MB（2 節）。本システムの上限は 1 通 25 MB にし、超えたメールは本文だけを取り込み、添付を捨てて「添付が大きすぎて受け取れなかった」を作業メモとテナントの管理者の一覧に残す。

### 5.2 受信の冪等

- `inbound_email(tenant_id, id, ses_message_id, rfc_message_id, from_address, envelope_from, received_at, s3_key, raw_sha256, classification, sender_trust, status, record_table_id, record_id, error)`。
- **`(tenant_id, ses_message_id)` を一意にする。** SQS の再配送・Ingest の再試行で、同じメールを 2 回処理しない。取り込みの効果（レコードの作成・コメントの追記・添付）と `inbound_email.status = processed` を、1 つのトランザクションで書く。
- 同じメールが 2 つの経路（顧客のサーバーの二重の転送）で届くことがある。`(tenant_id, rfc_message_id, raw_sha256 の先頭)` が 7 日の中で同じなら、2 通目を `duplicate` にして何もしない。

### 5.3 紐付けの決定表（DT-MAIL-001）

| # | 条件（上から評価） | 分類 | 結果 |
| --- | --- | --- | --- |
| 1 | 6 節の自動のメールの判定で `auto_reply`（不在の返信など） | `auto_reply` | 何もしない（記録だけ）。レコードに追記しない |
| 2 | 件名が転送の接頭辞（`fw:`、`fwd:`、`転送:`、大小文字を問わない）で始まり、本文に転送の見出しの塊（`From:`・`差出人:` の行）がある | `forward` | 新しいレコード（5.6 節）。参照の印・`References` で元のレコードが分かれば、関連として結ぶ |
| 3 | `In-Reply-To` または `References` の ID のどれかが `email_outbound` にある | `reply` | その ID のレコードへの返信（5.5 節） |
| 4 | 本文か件名に、有効な参照の印（5.4 節）がある | `reply` | 印のレコードへの返信 |
| 5 | 件名に番号の形（テナントの番号の定義の接頭辞 ＋ 数字）があり、そのレコードの依頼者・見守り・担当のグループのメンバーのどれかが差出人である | `reply` | そのレコードへの返信 |
| 6 | そのほか | `new` | 新しいレコード（5.6 節） |

- 3 と 4 が別のレコードを指すときは 3 を採り、食い違いを `inbound_email` に残す。
- 5 で差出人の条件を付けるのは、件名の番号は誰でも書けるので、無関係の人が他人のチケットへ追記するのを防ぐためである（本家は番号の接頭辞でレコードを探す。2 節。関係者の条件は本システムの追加）。
- 返信の接頭辞（`re:`、`aw:`、`返信:` など）は分類に使わない。返信の接頭辞のない返信（利用者が件名を消した）も、ヘッダーと印で紐付けるためである。

### 5.4 参照の印

- 形：`<Brand>-Ref:` に続く 20 文字の乱数（base32、100 ビット）。例：`<Brand>-Ref:K7Q2M…`。レコードの番号や ID を入れない。
- `email_watermark(tenant_id, token, notification_message_id, table_id, record_id, recipient_user_id, created_at)`。通知の 1 通ごとに 1 つ作る。保持は 1 年。
- **印は紐付けの手がかりで、権限ではない。** 印を知っていても、差出人の主体の ACL で追記できなければ追記しない（5.5 節）。印を推測できない乱数にするのは、番号から他人のチケットへの紐付けを作らせないためである。

### 5.5 返信の追記

DT-MAIL-002（返信の扱い）：

| # | 差出人の信頼（5.7 節） | 差出人の利用者 | レコードの状態 | 差出人の権限 | 結果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `untrusted` | - | - | - | 保留（`quarantined`）。担当者の保留の一覧に出す |
| 2 | - | 見つからない（未登録のアドレス） | - | - | 保留。担当者が「このレコードに追記」「新しいレコード」「捨てる」を選ぶ |
| 3 | `trusted` | あり | 開いている（open・hold） | コメントの書き込みの ACL あり | コメントとして追記（`channel = email`、`source_message_id`）。インシデントで `on_hold` かつ `awaiting_requester` なら、組み込みのルールで再開（[itsm-processes.md](itsm-processes.md) の 4.2 節） |
| 4 | `trusted` | あり | `resolved`、再オープンの期間の中 | 依頼者 | 追記し、`reopen` の遷移（主体は差出人、`actor_kind = email`）。本文が「ありがとう」などの短い感謝だけのとき（テナントの語の一覧に一致、かつ 40 文字以下）は、追記だけで再オープンしない |
| 5 | `trusted` | あり | `resolved`、依頼者でない | コメントの書き込みの ACL あり | 追記だけ |
| 6 | `trusted` | あり | `closed`・`cancelled` | - | 新しいレコード（5.6 節）を作り、`reopened_from` で元に結ぶ |
| 7 | `trusted` | あり | - | 書き込みの ACL なし | 保留（レコードの存在を差出人に知らせない） |

- 追記は、差出人の主体で Record Service の保存を通す（ACL、状態の遷移の表、監査の履歴）。
- **メールでの承認の回答、状態の直接の変更（「解決」と書いたら解決）は受けない。** 変わるのは、4 行の再オープンと、3 行の保留の解除だけ（組み込みの遷移の表で `email` の主体に許したもの）。

### 5.6 新しいレコードの作成

- 受信の規則（`inbound_rule`、メタデータ）：`order`、条件（受け手の別名、差出人のドメイン、件名、信頼の段階の式）、作る先のテーブル（インシデント、または `record_producer` の品目）、フィールドの写し（件名 → `title`、本文 → `description`、差出人 → `requester`、別名 → カテゴリ）。最初に一致した規則を使う。一致がなければテナントの既定（インシデント）。
- 作成は、差出人の利用者の主体で Record Service を通す。差出人が未登録で、テナントが「未登録の差出人からも作る」を選んでいるときは、組み込みの連携の主体 `email_intake`（`kind = integration`）で作り、`requester` を空にし、差出人のアドレスを `external_requester_email` に入れる。既定は保留（DT-MAIL-002 の 2 行と同じ）。
- 受け付けの通知（「受け付けました」）は、6 節の条件で抑える。

### 5.7 差出人の信頼（DT-MAIL-003）

| # | 認証の結果（SES の `Authentication-Results`） | 経路 | `From` のドメイン | 信頼 |
| --- | --- | --- | --- | --- |
| 1 | DMARC `pass` | - | - | `trusted` |
| 2 | DMARC `pass` でない | テナントが登録した転送の元（封筒の差出人のドメインが登録済み、かつ SPF `pass`） | テナントの社内のドメイン | `trusted_via_relay` |
| 3 | DMARC `pass` でない | 登録した転送の元でない | テナントの社内のドメイン（登録済み） | `untrusted`（社内の人を名乗るなりすましの疑い） |
| 4 | DMARC `fail`（`p=reject`・`quarantine` のドメイン） | - | 社外 | `untrusted` |
| 5 | そのほか（DMARC なし・`none`） | - | 社外 | `unverified` |
| 6 | ウイルスの判定が `FAIL` | - | - | メール全体を保留（添付を取り込まない） |

- `trusted_via_relay` は、顧客のメールサーバーが自社の受信の段で認証を済ませ、転送してくる形のためである。転送では元の SPF が通らず、本文の書き換えで DKIM も通らないことがある。顧客の転送の元を登録させ、その経路を信頼する。顧客のサーバーが ARC を付けるときの扱いは持ち越し。
- `unverified` は、返信の追記（DT-MAIL-002 の 3〜5 行）を `trusted` と同じに扱う（社外の取引先の多くは DMARC を持たない）。テナントの設定で `untrusted` に倒せる。
- 差出人の利用者の照合は、`From` のアドレスを小文字にし、`+` の後ろを除かずに、有効な利用者の `email` と完全一致で行う。複数の利用者が同じアドレスを持つときは照合しない（保留）。

### 5.8 本文の取り出しと添付

- `text/plain` の部分があればそれを使う。なければ `text/html` を、許可の一覧のサニタイズの後にテキストへ変換する。
- 返信の引用を除く：本文の区切りの行（4 節）があれば、その行から下を捨てる。なければ、よく知られた形（`On … wrote:`、`-----Original Message-----`、Outlook の日本語の見出しの塊 `差出人:`・`送信日時:`・`宛先:`・`件名:`、`>` で始まる行の連続）から下を捨てる。捨てた本文は原本（S3）に残る。
- 追記の本文は 64 KB まで（作業メモの上限と同じ）。超えたら切り、原本へのリンクを付ける。
- 添付ファイルは、ウイルスの判定が `PASS` のものだけをレコードの添付にする。インラインの画像（`Content-ID`）は添付として取り込む。署名の画像（10 KB 以下、同じ差出人から 5 回以上同じハッシュ）は取り込まない。
- 原本（`.eml`）は S3 に 1 年保持し、担当者がレコードから開ける（ACL は親のレコードに従う）。保持の期間は L2・L4 の結論で見直す。

## 6. ループの防止（[ADR-0035](../decisions/0035-mail-loop-prevention-and-japanese-decoding.md)）

### 6.1 自動のメールの判定（DT-MAIL-004）

| # | 受信のメールの条件（上から評価） | 判定 |
| --- | --- | --- |
| 1 | `<Brand>-Loop` のヘッダーに自分のセルの値がある | `own_loop`：捨てる（記録だけ） |
| 2 | 差出人が本システムの送信のドメイン、またはテナントの受信のアドレス | `own_loop` |
| 3 | 封筒の差出人が空（`<>`）、または `MAILER-DAEMON`・`postmaster` | `bounce`：捨てる（送信の配信の失敗は 3.6 節の SES の事象で扱う） |
| 4 | `Auto-Submitted: auto-replied`、または不在の返信の見分け（`X-Autoreply`、`X-Autorespond`、件名の接頭辞 `自動応答:`・`不在:`・`Automatic reply:`・`Out of Office:`） | `auto_reply`：レコードに追記しない |
| 5 | `Auto-Submitted` が `no` 以外（`auto-generated` など）、`Precedence: bulk`・`list`・`junk`、`List-Id` がある | `auto_generated`：取り込むが、自動の応答を返さない |
| 6 | そのほか | `human` |

- 5（監視の道具からのアラートのメールなど）は、レコードを作ってよい（受信の規則で、差出人ごとに許すかを決める。既定は許す）。ただし、**`auto_generated`・`auto_reply` の差出人へは、組み込みの受け付けの通知と、そのメールをきっかけにしたどの通知も送らない**（RFC 3834）。
- 不在の返信をレコードに追記しないのは、依頼者の不在の返信で `awaiting_requester` の保留が解けたり、担当者への通知が連鎖したりするのを防ぐためである。

### 6.2 流量の上限

| 対象 | 上限（S1 の既定） | 超えたとき |
| --- | --- | --- |
| 同じ差出人から、同じテナントで、新しいレコードの作成 | 10 分に 20 件 | 以後のメールを保留にし、テナントの管理者に知らせる（1 時間） |
| 同じレコードへのメールの追記 | 1 時間に 30 件 | 以後を保留にし、担当に知らせる |
| 同じ受け手への、同じレコードの通知のメール | 10 分に 5 通 | 超えた分をまとめて、10 分後に 1 通の要約にする |
| テナントの受信の全体 | 1 分に 1,000 通 | SQS に溜め、公平に処理する（テナントごとの取り分。[ADR-0018](../decisions/0018-flow-limits-and-tenant-fairness.md) と同じ考え） |

- 流量の上限は、ヘッダーを見ない自動の応答（古い道具）との往復を、有限の回で止めるための最後の守りである（PROP-MAIL-002）。
- 数は Valkey の窓の数で持つ。Valkey が落ちたら DB の `inbound_email` の件数で数える（遅いが正しい）。

## 7. 文字コードの復号（[ADR-0035](../decisions/0035-mail-loop-prevention-and-japanese-decoding.md)）

### 7.1 MIME

- 本文と部分は RFC 2045〜2049 で分け、`Content-Transfer-Encoding`（`7bit`、`8bit`、`quoted-printable`、`base64`）を戻す。ヘッダーの符号化の語（RFC 2047、`=?ISO-2022-JP?B?…?=`）と、添付の名前の RFC 2231 の形を戻す。
- 符号化の語が行の途中で切れて複数の語に分かれていても（ISO-2022-JP の切り替えの途中で切れる、よくある誤り）、隣り合う同じ文字コードの語をバイトの列としてつないでから復号する。

### 7.2 文字コードの決め方（DT-MAIL-005）

| # | 宣言（`charset` のラベル） | 中身 | 復号 |
| --- | --- | --- | --- |
| 1 | WHATWG の Encoding Standard のラベル（`iso-2022-jp`、`shift_jis`・`sjis`・`windows-31j`・`ms932`、`euc-jp`、`utf-8` など） | 宣言の復号器で置き換えの文字（U+FFFD）が出ない | 宣言のとおり |
| 2 | `iso-2022-jp` | 置き換えの文字が出る | 8 ビットのバイトを含むなら（ラベルの誤り）、4 行と同じ順で試す。7 ビットだけなら 5 行 |
| 3 | `shift_jis` などの別名 | - | WHATWG の Shift_JIS の復号器（IBM・NEC の拡張を含む。CP932 と同じ扱い） |
| 4 | なし・`us-ascii`・未知のラベルで、8 ビットの文字がある | - | UTF-8（厳格）→ Shift_JIS → EUC-JP の順に試し、置き換えの文字が出ない最初のもの |
| 5 | どれでも置き換えの文字が出る | - | 宣言（なければ UTF-8）で置き換えの文字を許して復号し、`decode_lossy` の印を付ける。担当者の画面に「文字化けの可能性」と原本へのリンクを出す |

- 復号した文字列は NFC に正規化する（辞書の `string` と同じ。[data-dictionary-and-tables.md](data-dictionary-and-tables.md) の 3.3 節）。半角カタカナ（ISO-2022-JP の `ESC ( I`、Shift_JIS の 1 バイトのカナ）は、半角のまま残す（NFC は半角を全角に変えない。検索の索引の側で正規化する）。
- 拡張の表は持たない。WHATWG の ISO-2022-JP の復号器は、NEC・IBM の拡張を含む index jis0208 を引くためである（2 節。2026-09-28 に確かめ、2 行を直した）。
- **送るメールは UTF-8 だけにする**（本文は `quoted-printable` か `base64`、件名は RFC 2047 の UTF-8 の B の形）。ISO-2022-JP で送る選択肢を持たない。今の主なメールの道具は UTF-8 を読め、送る文字コードを増やすと、丸数字などの表せない文字の扱いが要るためである。古い道具が読めない利用者の報告があれば、持ち越しで扱う。

## 8. 障害のときの振る舞い

| 障害 | 振る舞い |
| --- | --- |
| SES の受信の停止（東京） | 顧客のメールサーバーが再送する（SMTP の一時の失敗）。大阪の受信は DR の手順で切り替える（[infrastructure.md](infrastructure.md) の 6.3 節、[runbooks/disaster-recovery.md](../runbooks/disaster-recovery.md)）。mail-ingress の受信の規則・一時のバケット・`mail-router` は大阪にも用意する |
| `mail-router` の停止・滞留 | mail-ingress の SQS に溜まる。再開の後に古い順に振り分ける。一時のバケットの 1 日の中で処理できないときは SEV2（`mail-ingress-backlog.md`） |
| Ingest の停止 | SQS に溜まる。再開の後に古い順に処理する。`inbound_email` の一意で重複しない |
| 同じメールの再配送 | `(tenant_id, ses_message_id)` の一意で 1 回だけ |
| 処理の途中の失敗（DB） | トランザクションが巻き戻り、SQS の再配送で最初からやり直す。5 回失敗したら DLQ に入れ、`inbound_email.status = failed` にしてテナントの管理者の一覧に出す |
| 復号の失敗 | 7.2 節の 5 行。取り込みは止めない |
| Notifier の停止 | 通知が遅れる。`notification_message` の一意で、再開の後も 1 回だけ作る。送る直前に ACL を判定し直す |
| SES の送信の流量の上限 | テナントのバケットで待たせる。`mandatory` の通知を先に送る（優先度の列） |
| 自動の応答との往復 | 6 節の判定と流量の上限で止まる |

## 9. セキュリティ

- **なりすまし**：社内のドメインを名乗り、認証の通らないメールは保留にする（5.7 節）。返信の追記は差出人の主体の ACL を通す（5.5 節）。参照の印は推測できない乱数で、権限ではない（5.4 節）。
- **承認と状態の変更**：メールでは承認を受けず、状態は再オープンと保留の解除だけを変える（5.5 節）。
- **漏えい**：通知の本文は受け手の主体で ACL を判定する。読めないレコードの通知は送らない。社外の宛先には公開の項目だけ（4 節）。保留の返信は、差出人にレコードの存在を知らせない。
- **添付**：ウイルスの判定が `PASS` のものだけを取り込む。HTML の本文はサニタイズしてテキストにする。本文の中のリンクを、担当者の画面で自動のリンクにするときは `https:` だけ。
- **テナントの分離**：受け手のアドレスからテナントを決めるまで、テナントのデータを読まない。S3 の鍵はセルの KMS、オブジェクトのキーはテナントの接頭辞の下。
- **通信の秘密**：受信のメールの原本と本文は、テナントの ACL の中でだけ読める。運用者の参照は `security.md` の運用者のアクセスの手順に従う。L2 の結論で、保存・解析の範囲を見直す。
- 本家の名前をヘッダー・参照の印に使わない（`<Brand>-Loop`、`<Brand>-Ref:`）。

## 10. テスト

### 10.1 決定表

- DT-MAIL-001（紐付け）、DT-MAIL-002（返信の扱い）、DT-MAIL-003（差出人の信頼）、DT-MAIL-004（自動のメールの判定）、DT-MAIL-005（文字コード）を、`spec.md` から読む表駆動テストにする。各行の入力は、実際の `.eml` のフィクスチャー（架空の人名・アドレス。[AGENTS.md](../../AGENTS.md)）にする。

### 10.2 性質ベーステスト（fast-check）

- **PROP-MAIL-001（受信の冪等）**：任意のメールと任意の再配送の回数・並行度で、取り込みの効果（レコードの作成、コメント、添付）はちょうど 1 回。
- **PROP-MAIL-002（ループの有限）**：本システムと、どのヘッダーも見ずにすべてのメールに自動で返信する相手（最悪の自動の応答）を模擬で結ぶ。任意の最初のメールから、往復するメールの数は、6.2 節の上限から決まる有限の値を超えない。相手が RFC 3834 に従うときは、往復は 1 回で止まる。
- **PROP-MAIL-003（日本語の往復）**：JIS X 0208 の範囲（と、NEC・IBM の拡張）の任意の文字列を、任意の文字コード（ISO-2022-JP、Shift_JIS、EUC-JP、UTF-8）・任意の転送の符号化・任意の行の折り返し・符号化の語の任意の分け方で MIME にしたとき、復号して NFC にした文字列は、元の文字列の NFC と一致する。
- **PROP-MAIL-004（紐付けは権限を広げない）**：任意の差出人・参照の印・ヘッダーの組で、レコードに追記されるのは、差出人の主体がそのレコードにコメントを書ける場合だけ。
- **PROP-NTF-001（通知は 1 回）**：任意の outbox の配送の重複・Notifier の再起動の列で、`(事象, 規則, 受け手, 経路)` ごとの送信は高々 1 回（送信の応答の前の停止で 2 回まで。3.2 節）。
- **PROP-NTF-002（通知は漏らさない）**：任意の受け手と ACL の規則で、送った本文に差し込まれた値は、送る時点で受け手が読めるフィールドの値だけ。

### 10.3 結合テスト

- LocalStack などで SES の受信の通知の形を模し、S3 → SQS → Ingest を通す。実際の SES の受信の規則は、E6 の検証の環境で一度通す（本番と同じ東京）。
- 主なメールの道具（Outlook、Gmail、iPhone のメール、日本の携帯のキャリアのメール）の返信の形のフィクスチャーで、引用の除去を確かめる。

## 11. Story の候補

| Epic | Story | 中身 |
| --- | --- | --- |
| E1 | `ses-inbound-infrastructure` | mail-ingress の SES の受信の規則、一時の S3、SNS、SQS、DR の大阪（infrastructure と一緒に） |
| E1 | `mail-ingress-router` | `mail-router` と、セルの受信のバケット・SQS への振り分け（infrastructure の 2.3 節） |
| E6 | `notification-rules-and-templates` | 3.1・4 節（PROP-NTF-002） |
| E6 | `notifier-outbound-email` | 3.2〜3.5 節（PROP-NTF-001） |
| E6 | `tenant-sending-domain` | 3.3 節の独自のドメインの確認 |
| E6 | `bounce-and-suppression` | 3.6 節 |
| E6 | `inbound-email-pipeline` | 5.1・5.2 節（PROP-MAIL-001）。L2 の確認待ち |
| E6 | `inbound-threading` | 5.3・5.4 節、DT-MAIL-001 |
| E6 | `inbound-reply-and-sender-trust` | 5.5・5.7 節、DT-MAIL-002・003（PROP-MAIL-004） |
| E6 | `inbound-new-record-rules` | 5.6 節 |
| E6 | `inbound-body-extraction` | 5.8 節 |
| E6 | `mail-loop-prevention` | 6 節、DT-MAIL-004（PROP-MAIL-002） |
| E6 | `japanese-mime-decoding` | 7 節、DT-MAIL-005（PROP-MAIL-003） |
| E6 | `inbound-quarantine-ui` | 保留の一覧と、担当者の処理の画面（portal-and-ui と一緒に） |
| E5 | `pager-channel-interface` | 当番の呼び出しのメールの経路（assignment-and-on-call の 6.5 節の差し込み口と一緒に） |
| E3 | `user-notification-preferences` | 利用者の通知の設定 |

## 12. 未解決の問い

### 決定（2026-09-28、既定案）

- **通知は `(事象, 規則, 受け手, 経路)` の一意で 1 回だけ作り、レコードの値は事象の時点の版で読み、ACL は送る時点で判定する**（3.2 節、ADR-0033）。
- **自前の `Message-ID` は付けず、SES の ID から受け手に届く `Message-ID` を記録して照合する**（3.5 節。検証の工程で直した）。
- **参照の印は通知の 1 通ごとの推測できない乱数にする**（5.4 節）。
- **紐付けは、転送 → ヘッダー → 印 → 件名の番号（関係者だけ）の順**（5.3 節、ADR-0034）。
- **テナントは封筒の受け手で決め、`To:` で決めない**（5.1 節）。
- **受信は共有の入口と `mail-router` でセルへ振り分け、解決できない受け手はバウンスしない**（5.1 節。統合で決めた）。
- **SES のクライアント側の暗号化を使わず、バケットの既定の暗号化で守る**（5.1 節）。
- **社内のドメインを名乗る認証の通らないメールは保留にする**（5.7 節）。
- **不在の返信を追記せず、自動のメールに自動の応答を返さない**（6.1 節、ADR-0035）。
- **ラベルのない 8 ビットは UTF-8 → Shift_JIS → EUC-JP の順に試す。送るメールは UTF-8 だけ**（7.2 節）。
- **1 通の上限は 25 MB。超えたら添付を捨てて本文を取り込む**（5.1 節）。

### 持ち越し

| 問い | いつ・どう決めるか |
| --- | --- |
| 電気通信事業法の届出と通信の秘密（L2） | 法務の確認。済むまで E6 のメールからのチケットの `spec.md` を承認しない |
| SES の ID と、受け手に届く `Message-ID` のドメインの部分の対応 | E6 `notifier-outbound-email` で確かめ、3.5 節の作り方を固定する |
| ARC（転送の認証の連鎖）の結果の扱い | E6 の後。顧客の転送のサーバーの実態を見て |
| メールでの承認（署名付きの一回だけのリンクと送信のドメインの認証） | MVP の後（[workflow-engine.md](workflow-engine.md) の 14 節） |
| 原本の保持の期間（1 年） | L2・L4 の結論の後、`security.md` で |
| テナントの通知の送信の流量の既定の値 | E12 の負荷試験 |
| 通知のまとめ（1 日の要約の配信） | E6 の利用者の調査で |

## 13. quality.md・runbooks・data-model への項目

### quality.md

- 受信の処理の遅れ（SES の受信から取り込みの完了まで）の p50・p99。K7（最初のインシデントがメールで起票されるまで）の計測の一部。
- 分類の内訳（`new`・`reply`・`forward`・`auto_reply`・`own_loop`・保留）と、保留の件数と処理の時間。
- 紐付けの食い違い（ヘッダーと印が別のレコード）の件数。
- `decode_lossy` の割合（文字コード別）。
- 通知の送信の遅れ（事象から SES の受け付けまで）の p99、配信の失敗・苦情の割合、抑止のリストの件数。
- 流量の上限に当たった件数（差出人・レコード別）。多ければループの兆し。
- 通知の漏れの試験の結果（K6。`no_read_access` の抑止の件数を含む）。

### runbooks

- `mail-loop-detected.md`：流量の上限に当たったときの確かめ方（相手の自動の応答、テナントの設定）と、差出人の一時の遮断。
- `inbound-email-backlog.md`：SQS の滞留・DLQ の処理と、失敗したメールの再処理。
- `ses-inbound-failover.md`：東京の SES の受信の障害のときの大阪への切り替え（MX の変更）。統合で [disaster-recovery.md](../runbooks/disaster-recovery.md) の B の 4 に含めた。
- `mail-ingress-backlog.md`（infrastructure の提案）：`mail-router` の滞留と、解決できない受け手の急増。
- `sending-reputation.md`：バウンス・苦情の率の上昇（SES の送信の停止の危険）の確かめ方と、抑止のリストの見直し。
- `mojibake-report.md`：文字化けの報告の調べ方（原本、宣言の文字コード、`decode_lossy`）。
- `spoofed-internal-sender.md`：社内のドメインを名乗る保留のメールが増えたときの、テナントへの連絡と SPF・DMARC の設定の案内。

### data-model（索引への追加の提案）

| 置き場所 | 中身 |
| --- | --- |
| Aurora `notification_rule`、`notification_template`（言語ごと） | 3.1・4 節。メタデータ |
| Aurora `notification_message` | 3.2 節。`(tenant_id, event_id, rule_id, recipient, channel)` 一意。30 日 |
| Aurora `email_outbound` | 3.5 節。`(tenant_id, message_id)`、`(tenant_id, ses_message_id)`。90 日 |
| Aurora `email_watermark` | 5.4 節。`(tenant_id, token)` 一意。1 年 |
| Aurora `email_suppression` | 3.6 節 |
| Aurora `inbound_email` | 5.2 節。`(tenant_id, ses_message_id)` 一意、`(tenant_id, rfc_message_id)`。1 年 |
| Aurora `inbound_rule`、`tenant_mail_relay`（登録した転送の元）、`tenant_mail_alias` | 5.6・5.7・5.1 節 |
| Aurora `user_notification_pref` | 3.2 節の 3 |
| S3 受信のバケット（セルごと、SSE-KMS、テナントの接頭辞） | 5.1 節。原本 1 年 |
| mail-ingress の S3 の一時のバケット | 5.1 節。1 日で消える。読めるのは `mail-router` だけ |
| 制御の面 受信のアドレス → テナント → セルの対応 | 5.1 節 |
| Valkey 流量の窓 | 6.2 節 |

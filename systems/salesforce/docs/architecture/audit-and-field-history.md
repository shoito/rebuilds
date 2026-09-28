# Audit and field history: Salesforce

設定の変更の履歴（Setup の監査）、データの大きな操作の監査、ログインの履歴、項目の変更の履歴、保持と削除（法務の L5）、改ざんの防止の設計。土台は [ADR-0003](../decisions/0003-metadata-driven-runtime.md)（メタデータの変更は版ごとの差分 `md_changes` を残す）、[ADR-0008](../decisions/0008-dml-order-of-execution.md)（保存の手順 9 で項目の変更の履歴を書く）、intent の「設定の変更、権限の変更、データの一括の削除は、監査のログに残る」。この文書で決めたことは、次の 2 つの ADR にある。

- 監査のイベントは、変更と同じトランザクションで `audit_events` に書く追記だけの表にする。組織ごとにハッシュの鎖でつなぎ、1 日ごとに鎖の先頭を S3 の Object Lock（改ざんできない置き場所）に書く。画面と API では 180 日を見せ、外部の保管は 1 年（既定案。法務の L5）。ログインの履歴は別の表に書き、180 日保つ（[ADR-0046](../decisions/0046-setup-audit-trail-and-login-history.md)）。
- 項目の変更の履歴は、オブジェクトで有効にし、1 オブジェクト 20 項目まで、保存の手順 9（最上位で 1 回）で同じトランザクションの outbox に書き、Relay が別のクラスタ（`history`）の月ごとの分割へ写す。18 か月で分割ごと消す（2026-09-28 に S1 から別のクラスタに置くと改めた）。読みは、そのレコードを読めて、その項目を読める人にだけ返す。本人の請求では、履歴の値を消せる（[ADR-0047](../decisions/0047-field-history-tracking-and-retention.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| 設定の変更の履歴（メタデータ、権限、利用者、共有、認証、連携、Sandbox、デプロイ） | メタデータの版と差分の本体（[metadata-and-runtime.md](metadata-and-runtime.md) の 4.1 節） |
| データの大きな操作の監査（一括の削除、完全な削除、エクスポート、ロックを越えた更新、重複の規則の `bypass`） | 変更のイベント（[events-and-integrations.md](events-and-integrations.md)。本家も監査に使うことを勧めない） |
| ログインの履歴 | ログインの判定（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 6 節） |
| 項目の変更の履歴（設定、書き方、読み、保持、消し方） | 商談の履歴（`opportunity_history`。[sales-objects.md](sales-objects.md) の 3.5 節）の中身。保持はこの文書で決める |
| 保持と削除、改ざんの防止、書き出し | 本システムの運用のテレメトリー（observability の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| 設定の変更の履歴 | Setup での変更を、少なくとも直近 180 日表す（`SetupAuditTrail`）。集計の問い合わせは一部しかできない | [Object Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/object_reference.pdf)（Winter '27 版、以下「OBJ」） |
| ログインの履歴 | 組織の全ての成功・失敗のログインの試み（`LoginHistory`）。画面は直近 6 か月の最大 2 万件を表す。本人確認の試みは直近 6 か月（`VerificationHistory`） | OBJ、[Monitor Login History](https://help.salesforce.com/s/articleView?id=xcloud.users_login_history.htm&type=5)（2026-09-28 に確認） |
| 項目の変更の履歴 | 1 オブジェクト 20 項目まで。保持は 18〜24 か月。画面と API で見られる。変更はオブジェクトの履歴の表（例：`AccountHistory`）に入る | [Field Audit Trail Implementation Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/field_history_retention.pdf)（Winter '27 版、以下「FAT」） |
| 長い保持（追加の製品） | 200 項目まで、消すまで保つ。本番では 18 か月、Sandbox では 1 か月の後に保管の置き場所へ移す。API だけで読む | FAT |
| 保存の容量 | 項目の変更の履歴は、データの容量に数えない。保持は 18 か月、API では 24 か月まで読める | [Field History Tracking Overview](https://help.salesforce.com/s/articleView?id=xcloud.tracking_field_history.htm&type=5)（2026-09-28 に確認） |
| 長いテキストの履歴 | 255 文字を超える長いテキストは、値を持たず「変わった」だけを記録する | [Field History Tracking Overview](https://help.salesforce.com/s/articleView?id=xcloud.tracking_field_history.htm&type=5)（2026-09-28 に確認） |
| 変更のイベントと監査 | 変更のイベントを、記録と項目の変更の監査に使うことは勧めない | [Change Data Capture Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_change_data_capture.pdf) |

## 3. 設定の変更の履歴と監査のイベント（ADR-0046）

### 3.1 何を記録するか

| 分類 | 出どころ | 例 |
| --- | --- | --- |
| `metadata` | メタデータの版（`md_versions`・`md_changes`） | オブジェクト・項目・レイアウト・フロー・入力規則・承認・レポートの型・イベントの型の追加・変更・削除、フローの有効化。1 つの版に 1 件、部品の一覧を持つ |
| `permission` | 権限セットの割り当て（データの変更で版を上げない） | 割り当て・外し・期限、権限セットのグループの構成 |
| `user` | 利用者の管理 | 作成、招待、無効化、凍結、匿名化、プロファイル・ロールの変更、パスワードの再設定、MFA の解除 |
| `sharing` | 共有 | OWD、共有ルール（版で記録されるものに加えて、ジョブの開始・切り替え・保留） |
| `auth` | 認証の設定 | SSO の接続、MFA の方針、セッションの期限、ログインの制限、`sso_bypass` |
| `integration` | 連携 | OAuth のクライアント、Webhook・外向きの呼び出しの宛先、秘密の入れ替え、カーソルの巻き戻し |
| `deploy` | デプロイと Sandbox | 検証、適用、戻し、Sandbox の作成・再作成・削除、マスキングの設定 |
| `data_bulk` | データの大きな操作 | 一括の削除（1 万行以上）、完全な削除、ごみ箱を空にする、エクスポート（レポート、一括の問い合わせ）、所有者の一括の付け替え |
| `data_override` | 通常の規則を越える操作 | 承認のロックを越えた `system` の自動化の更新（[automation-flows.md](automation-flows.md) の DT-APR-002 の行 2）、重複の規則の `bypass` の選択、`system` の画面のフローの有効化 |
| `org` | 組織 | エディション、機能の組、ドメイン、削除の申し込みと取り消し、割り当ての上書き（Ops） |
| `support` | 本システムの運用 | サポートの一時の管理者、Ops の割り当ての上書き、安全の設定（[sharing-and-record-access.md](sharing-and-record-access.md) の 10 節） |

- **記録しないもの**：レコードの通常の読み書き（項目の変更の履歴は 5 節で、選んだ項目だけ）、問い合わせの内容。
- `data_override` の承認のロックを越えた更新は、1 つのトランザクションで何件でも 1 件のイベントにまとめ、レコードの ID を 200 件まで持つ。

### 3.2 形

```
audit_events(org_id, seq, event_id, at, category, action, actor_user_id, actor_kind,
             via, request_id, ip, target_kind, target_id, target_label,
             summary, details, prev_hash, hash)
```

| 列 | 中身 |
| --- | --- |
| `seq` | 組織の中の連番（1 から、欠番なし） |
| `actor_kind` | `user`、`integration`（OAuth のクライアント）、`system`（自動化・Worker）、`support`（本システムの運用） |
| `via` | `setup`、`api`、`deploy`、`flow`、`bulk`、`support` |
| `summary` | 人が読む 1 行（例：「項目 x_amount（契約）を追加」） |
| `details` | 種類ごとのスキーマで検証した JSON。前後の値は、設定の値だけ（秘密・レコードの値を入れない） |
| `prev_hash`・`hash` | ハッシュの鎖（3.3 節） |

- `details` は、種類ごとの Zod のスキーマの許可リストで作る。秘密（Webhook の秘密、OAuth の秘密、SSO の鍵、パスワード）はスキーマに存在しない。
- メタデータの差分の中身（`md_changes.before`・`after`）は監査に写さず、`md_versions` の版の番号を `details.version` に持つ。版の差分は、メタデータの表から版で読める（保持の間）。
- 記録は、変更と**同じトランザクション**で書く。変更が巻き戻れば記録も消え、記録が書けなければ変更も失敗する（監査の漏れを作らない）。
- `seq` は、組織の行（`audit_heads(org_id, last_seq, last_hash)`）を `FOR UPDATE` で読んで採番する。設定の変更は多くないので、この行の待ちは小さい。ただし、`data_override` のように保存の経路から書くイベントは、`audit_pending`（同じトランザクションで書く）に入れ、Worker が 1 秒ごとに `audit_events` へ採番して移す（保存の経路が組織の 1 行を奪い合わないため）。

### 3.3 改ざんの防止

- **追記だけ**：`audit_events` は、アプリの DB のロールに `INSERT` と `SELECT` だけを許す。`UPDATE`・`DELETE` は、保持の期限の分割の `DROP` を行う保守のロールだけ。
- **ハッシュの鎖**：`hash = SHA-256(prev_hash || 正規化した行)`。組織ごとに鎖を持つ。
- **錨**：Worker が毎日 0 時（JST）に、全ての組織の鎖の先頭（`org_id`、`seq`、`hash`）を 1 つのファイルにし、S3 の Object Lock（コンプライアンスのモード、保持は 3.4 節の外部の保管と同じ）に書く。
- **確かめ**：`POST /api/v1/audit/verify?from=&to=` は、鎖を計算し直して錨と比べる。組織の管理者（`view_audit_trail`）が使える。本システムも毎週全ての組織で確かめ、食い違いはセキュリティの呼び出しにする。
- DB の特権を持つ人が行を書き換えても、錨と合わなくなって気づける。錨の置き場所は、本体の AWS のアカウントとは別の監査のアカウントにする（security・infrastructure の領域）。

### 3.4 保持と書き出し

| 置き場所 | 期間 | 読める人 |
| --- | --- | --- |
| `audit_events`（Aurora、月ごとの分割） | 180 日（画面と API） | `view_audit_trail` |
| 外部の保管（S3、組織ごとの日ごとの JSON Lines、Object Lock） | 1 年 | `view_audit_trail` が書き出しの API で取り出す |

- 180 日は本家の「少なくとも 180 日」に合わせる（OBJ）。外部の保管の 1 年は既定案。**法務の L5 の結論で決める**。L5 の結論まで、E11 の監査の保持と削除の spec を承認しない（intent）。
- 書き出し：`GET /api/v1/audit/events?from=&to=&category=`（180 日の中、キーセットのカーソル）、`POST /api/v1/audit/exports`（外部の保管から、非同期、24 時間の取り出しの URL ではなく API で渡す）。書き出しも `data_bulk` として記録する。
- 組織の削除では、Aurora の行は消す。外部の保管は Object Lock で期限まで消せないので、組織の分を**暗号の鍵の破棄**で読めなくする（組織ごとのデータキーで暗号化して置く）。この扱いは法務の L5・L7 で確かめる。
- Sandbox へは写さない（[sandboxes-and-deploy.md](sandboxes-and-deploy.md) の 4.1 節）。Sandbox の中の変更は、Sandbox の組織の監査に残る。

### 3.5 画面

- Setup の「設定の変更の履歴」：分類・利用者・期間で絞り、`summary` を新しい順に並べる。項目の追加などは、メタデータの版の差分の画面へのリンクを持つ。
- 利用者の画面に、その利用者への管理の操作を並べる。

## 4. ログインの履歴（ADR-0046）

```
login_events(org_id, id, at, user_id, username_hash, result, reason, method, mfa_method,
             sso_provider_id, ip, country, user_agent_short, session_public_id, client_id)
```

| 列 | 値 |
| --- | --- |
| `result` | `success`、`failure`、`mfa_required`、`mfa_failure`、`blocked`（ログインの制限・一時の停止） |
| `reason` | `bad_password`、`no_user`、`frozen`、`deactivated`、`ip_restricted`、`hours_restricted`、`sso_required`、`locked_out`、`sso_assertion_invalid` など |
| `method` | `password`、`passkey`、`sso_saml`、`sso_oidc`、`oauth_code`、`oauth_client_credentials`、`refresh` |

- ログインの画面の全ての試みと、OAuth のトークンの発行（リフレッシュを含む）を書く。API の要求ごとには書かない（トークンの発行だけ）。
- **利用者が決まらない失敗**（無い `username`）は、組織が決まる時（組織のドメインのログイン）だけ書き、`user_id` を空、`username_hash` に組織ごとの鍵の HMAC を入れる。打った文字列（パスワードを誤って打ったものかもしれない）をそのまま残さない。
- 画面の理由は区別しないが（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 10 節）、履歴には理由を残す。
- 保存：`login_events` は、ログインの経路の DB の負担を減らすため、outbox から Worker がまとめて書く（ログインの結果を先に返す）。書けなかった時は、ログインは止めない（数を計測）。
- 保持は **180 日**（本家の画面は直近 6 か月。2 節）。月ごとの分割を `DROP` する。法務の L5 で決める。
- 読み：`view_audit_trail`、または本人（自分のログインの履歴）。書き出しは 3.4 節と同じ。
- 短い時間の失敗の急増（1 つの IP で 1 分 100 回など）は、WAF とログインの一時の停止で守り、履歴は 1 秒ごとにまとめて 1 件（`details.count`）にする。

## 5. 項目の変更の履歴（ADR-0047）

### 5.1 設定

- オブジェクトで有効にする（`md_objects.field_history_enabled`）。項目ごとに `md_fields.track_history` を選ぶ。**1 オブジェクト 20 項目まで**（本家と同じ。FAT）。メタデータの変更として版を上げる。
- 選べる型：`rich_text`・数式・積み上げ集計・自動採番以外の全て。`long_text` は、値を持たず「変わった」だけを記録する（本家も 255 文字を超える長いテキストを同じに扱う。2 節。[ADR-0047](../decisions/0047-field-history-tracking-and-retention.md) と揃えた）。数式は保存しないので選べない。積み上げ集計は親の値の変化として選べる（子の変化の積み重ねで行が多くなるので警告する）。
- 所有者（`owner_id`）とレコードタイプも選べる（システムの列）。作成と削除・戻すは、有効にした全てのオブジェクトで常に 1 行書く（`created`・`deleted`・`restored`）。

### 5.2 書き方（保存の手順 9）

```
field_history(org_id, object_id, record_id, changed_at, source_id, seq, field_no, event, changed_by, tx_id,
              via, old_value, new_value, erased)
  PARTITION BY RANGE (changed_at)       -- 月ごと
  主キー (org_id, record_id, changed_at, source_id, seq)   -- source_id は outbox の行の ID（二重の写しを捨てる）
  索引 (org_id, object_id, changed_at)
```

- **置き場所**（2026-09-28。[ADR-0047](../decisions/0047-field-history-tracking-and-retention.md)・[ADR-0060](../decisions/0060-load-model-and-sizing-review.md) の注記）：`field_history` は、主の Aurora ではなく、`events` と同じ形の別のクラスタ `history` に置く（[infrastructure.md](infrastructure.md) の 4.3 節）。18 か月で約 3.5TB（5.4 節）になり、主のクラスタの残りの全てより大きいため。起票の時は、主のクラスタに同じトランザクションで書き、S2 の前に分けるかを決めるとしていた。
- 保存の手順 9（[ADR-0008](../decisions/0008-dml-order-of-execution.md)）で、塊の中で変わったレコードの、選んだ項目の前後の値を、同じトランザクションの outbox（`kind = field_history`）に 1 回で書く。確定の後に、Relay（論理シャードごとの唯一の書き手）が `history` のクラスタに複数行の `INSERT` で写す。outbox の行の ID から作る一意の鍵で、二重の写しを捨てる。
  - 保存と履歴の原子性は outbox で保つ（巻き戻った保存の履歴は出ず、確定した保存の履歴は必ず出る）。履歴に出るまでの遅れは、変更のイベントと同じく p95 5 秒を目標にする。
  - `history` のクラスタの障害の間は、outbox にたまり、保存は止めない。入れ子の保存（フロー、積み上げ集計）の変更も、同じレコードの同じ項目の変化として、最上位の最後の値との比べで 1 行にまとめる（1 つのトランザクションの中の途中の値を残さない）。
  - 手順 9 は入れ子の保存でも動くが、行は最上位のトランザクションの終わりにまとめて書く（共有の評価の手順 10 と同じく、確定の直前の 1 回）。metadata-and-runtime の領域に、手順 9 を「最上位で 1 回」にする読み替えを依頼する（9 節）。
- 値の形：`records.data` と同じ（10 進の文字列、ISO 8601、選択リストの `value_id`、参照の ID）。読みの時に、表示の値（選択リストのラベル、参照先の名前）に直す。
- `via`：`ui`、`api`、`bulk`、`flow`、`approval`、`system`（型の変換・整合の検査の直しは書かない）。
- 履歴の行は、トランザクションの上限に数えない（[governor-limits.md](governor-limits.md) の 4.1 節の「数えないもの」）。1 トランザクションの行の数は、DML の行（1 万）× 20 項目で上から抑えられる。
- 論理シャードの分割は持たず、`org_id` を主キーの先頭に置いて RLS をかける。月ごとの分割で保持の期限を安く消すため（shard × 月の 2 段の分割は、分割の数が多くなりすぎる）。組織の移動では、`events` と同じく `history` のクラスタの組織の行も写す（[infrastructure.md](infrastructure.md) の 6.1 節）。

### 5.3 読み

- `GET /api/v1/objects/{object}/records/{id}/history?cursor=`：新しい順、1 ページ 200 件。レコードの画面の「項目の履歴」の関連リスト。レコードの読みの判定は主のクラスタのデータ層で行い、読めたら `history` の reader から `(org_id, record_id)` で引く。
- レポートの型 `<object>_field_history`（主は履歴、親はレコード）を、有効にしたオブジェクトごとに作る（[reports-and-dashboards.md](reports-and-dashboards.md) の 3.1 節）。主のクラスタのレコードと SQL で結べないので、親のレコードの条件と共有を主の reader で先に絞って ID の束を作り、`history` の reader を ID の束で引いて結ぶ。
- **権限**：
  - そのレコードを `read` 以上で読めること（共有の判定。ごみ箱のレコードは、ごみ箱を読める人だけ）。
  - 行の項目を、**読みの時の**見る人が読めること（FLS）。読めない項目の行は返さない（件数にも出さない）。[sharing-and-record-access.md](sharing-and-record-access.md) の 3.4 節の「項目の変更の履歴」の行と同じ。
  - 参照の項目の前後の値の名前は、参照先を読める時だけ返す（ID は返す）。
- 履歴のオブジェクトは自分の共有を持たず、親のレコードの判定に従う（活動と同じ考え方）。

### 5.4 保持

| 対象 | 期間 | 消し方 |
| --- | --- | --- |
| `field_history` | 18 か月 | 月ごとの分割を `DROP`（19 か月目の最初の日） |
| `opportunity_history` | 18 か月（既定案） | 同じ。商談の推移のレポートの元なので、延ばす要望は PM が判断する |
| 削除したレコードの履歴 | レコードの消去と同時（ごみ箱の 15 日の後。[ADR-0011](../decisions/0011-recycle-bin-and-purge.md)） | 消去の Worker が消す |
| 項目・オブジェクトの削除 | 項目の値の消去と同時（ADR-0006） | 消去の Worker が消す |

- 18 か月は、本家の 18〜24 か月の短い方（FAT）。長い保持（本家の追加の製品に相当）は MVP の後。**法務の L5 の結論で決める**。
- 容量：履歴は組織のデータの容量に数えない（本家と同じ。2 節）。そのかわり、1 オブジェクト 20 項目の上限で量を抑える。S1 の見積もりは、保存の行の平均 500 行/秒 × 平均 1.5 項目 × 18 か月で約 350 億行（1 行 100B で約 3.5TB）。capacity の領域で見直す。量が見積もりを大きく超える組織には、項目の選び方を案内する。

### 5.5 値の消去（本人の請求）

- `POST /api/v1/objects/{object}/records/{id}/history/erase { "fields": ["email", "phone"] }`：そのレコードの履歴の行のうち、選んだ項目の `old_value`・`new_value` を空にし、`erased = true` にする。行は残す（いつ変わったかは残る）。
- `erase_history_values`（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 7 節）が要る。操作は設定の変更の履歴（`data_override`）に残す。
- 取引先責任者・リードの削除の確定（消去）では、履歴も消える（5.4 節）。本人の請求で、ごみ箱の 15 日を待たずに消す操作（完全な削除）を使える（[ADR-0011](../decisions/0011-recycle-bin-and-purge.md)）。
- 法務の L1・L5 で、本人の請求と監査の履歴の保持の関係を確かめる。

## 6. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| 監査のイベントが書けない | 変更も失敗する（同じトランザクション）。監査の漏れを作らない |
| `audit_pending` の移しの遅れ | 1 分を超えたら警告。行は残るので失われない |
| 錨の書き込みの失敗 | 次の日にまとめて書く。2 日続けて失敗したら警告 |
| 鎖の確かめで食い違い | セキュリティの呼び出し。書き換えの疑いとして調べる |
| ログインの履歴の書き込みの遅れ・失敗 | ログインは止めない。失敗の数を計測し、1 分 100 件を超えたら警告 |
| 項目の変更の履歴の量が見積もりを超える | 組織ごとの行の増え方を計測し、上位の組織に項目の選び方を案内する |
| `history` のクラスタの障害・写しの遅れ | outbox にたまり、保存は止めない。履歴の画面・API・レポートは 503 か「遅れています」。遅れの p95 が 30 秒を超えたら警告（`event-relay-lag` と同じ見方） |
| 分割の `DROP` の遅れ | 期限を 7 日超えたら警告 |

## 7. セキュリティ

- 監査は追記だけ、ハッシュの鎖、別のアカウントの Object Lock の錨で守る（3.3 節）。
- 監査・ログインの履歴に、秘密とレコードの値を入れない。打った `username` の文字列をそのまま残さない。
- 項目の変更の履歴は、読みの時の見る人の共有と FLS で絞る（5.3 節）。FLS で読めない項目の履歴は、件数も出さない。
- 監査・ログインの履歴の読みは `view_audit_trail`。書き出しも記録する。
- 本システムの運用（サポート、Ops）の操作も、`actor_kind = support` として組織の監査に残し、組織の管理者が見られる。
- `security:sensitive` の対象：この領域の全て（AGENTS.md の「監査のログ」）。

## 8. テスト

- 決定表：`DT-AUD-001`（操作 × 分類 → 記録するか、どの `category` か）、`DT-FH-001`（項目の型 × 変化 → 履歴の行と値の持ち方）、`DT-FH-002`（見る人のレコードの読み × 項目の読み × 参照先の読み → 返す行と値）を表駆動テストにする。
- 性質ベーステスト（fast-check）：
  - `PROP-AUD-001`（草案）：任意の管理の操作の列（巻き戻りを含む）で、確定した操作ごとにちょうど 1 件の監査のイベントがあり、`seq` は欠番なく増え、鎖を計算し直すと先頭のハッシュが一致する。
  - `PROP-FH-001`（草案）：任意の保存の列（入れ子の保存を含む）で、履歴の行を順に当てると、選んだ項目の今の値になる（途中の値の行がない）。
  - `PROP-FH-002`（草案）：任意の見る人の権限の形で、返す履歴の行に、読めない項目の行と値がない。
- 否定側のテスト：監査の `details` に秘密がない。ログインの履歴に打った文字列がない。
- 結合テスト：行の書き換え（保守のロールで）を鎖の確かめが見つける。18 か月・180 日の分割の `DROP`。値の消去で `erased` になる。
- 上限の試験：1 オブジェクト 20 項目。

## 9. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0046](../decisions/0046-setup-audit-trail-and-login-history.md) | 監査のイベントは変更と同じトランザクションで追記だけの表に書き、組織ごとのハッシュの鎖と毎日の S3 の Object Lock の錨で改ざんを見つける。画面は 180 日、外部の保管は 1 年（法務の L5）。ログインの履歴は 180 日 |
| [0047](../decisions/0047-field-history-tracking-and-retention.md) | 項目の変更の履歴は 1 オブジェクト 20 項目まで、保存の手順 9 で最上位の最後の値との差だけを同じトランザクションの outbox に書き、`history` のクラスタの月ごとの分割に写す。18 か月。読みは見る人の共有と FLS で絞り、本人の請求で値を消せる |

他の領域への依頼：

- metadata-and-runtime の領域：保存の手順 9 を、手順 10・11 と同じく「最上位の最後に 1 回」と読み替える（途中の値の履歴を書かない）。`md_fields.track_history` を足す。
- reports-and-dashboards の領域：レポートの型 `<object>_field_history` を標準のレポートの型に足す。8.2 節のエクスポートの監査を、この文書の `data_bulk` に合わせる。
- data-storage の領域：消去の Worker の対象に `field_history` を足す。

## 10. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | 監査のアカウントの S3（Object Lock）と錨の書き込み |
| E1 | CI：`DT-AUD-001`・`DT-FH-*` の表駆動テスト、`PROP-AUD-001`・`PROP-FH-*` の枠 |
| E2 | ログインの履歴（outbox から、`username_hash`、まとめ） |
| E3 | 保存の手順 9 の差し込み口（最上位で 1 回） |
| E11 | 監査のイベントの表、同じトランザクションの書き込み、`audit_pending`、`seq` とハッシュの鎖 |
| E11 | 各領域の管理の操作の記録（メタデータ、権限、利用者、共有、認証、連携、デプロイ、データの大きな操作） |
| E11 | 設定の変更の履歴の画面と API、書き出し、鎖の確かめの API |
| E11 | 外部の保管（組織ごとの鍵、Object Lock）と、組織の削除での鍵の破棄 |
| E11 | 項目の変更の履歴の設定（20 項目）と書き込み（outbox → `history` のクラスタ）、読みの API、関連リスト |
| E11 | 履歴の読みの共有と FLS（DT-FH-002） |
| E11 | 保持（月ごとの分割の `DROP`）と値の消去 |
| E7 | 項目の変更の履歴のレポートの型 |
| E12 | 履歴の量の計測と見積もりの見直し、監査の改ざんの訓練 |

## 11. 未解決の問い

- 保持の期間（監査 180 日・外部 1 年、ログイン 180 日、項目の履歴 18 か月）は法務の L5 で決まる。
- 本人の請求で、監査のログの中の個人データ（利用者の名前、IP）をどう扱うか。
- 外部の保管を Object Lock にすると、組織の削除で消せない。鍵の破棄で足りるか（法務の L5・L7）。
- 項目の変更の履歴の長い保持（本家の追加の製品に相当）を持つか。
- 監査の `seq` の採番を組織の 1 行で行うことが、設定の変更の多い組織で待ちにならないか。
- 読みの操作（誰がどのレコードを見たか）を記録するか。

### 決定

2026-09-28 の既定案。

- 3.4 節・4 節・5.4 節の期間で作り、値を設定にする。L5 の結論まで E11 の保持の spec を承認しない。
- 監査のログの利用者は利用者の ID で持ち、名前は読みの時に引く。利用者の匿名化（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 5.2 節）で、表示の名前も匿名になる。IP は 180 日で Aurora から消え、外部の保管の分は L5 で決める。
- 組織の削除では鍵を破棄する。法務の確認を待つ。
- 長い保持は MVP の後。
- 設定の変更は組織の 1 行で採番し、保存の経路から書くものは `audit_pending` から移す。E11 で待ちを測る。
- 読みの操作の記録は MVP の後（量が大きく、保存の経路の外の置き場所が要る）。

## 12. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：監査の漏れ（記録されない管理の操作）。`DT-AUD-001` と、各領域の管理の API の網羅のテスト（全ての管理の API が記録を書くことを、API の一覧から機械的に確かめる）。
- リスク：監査の改ざん。ハッシュの鎖と錨、毎週の確かめ。
- リスク：項目の変更の履歴を通した、読めない項目の漏れ。`PROP-FH-002`、否定側のテスト。
- 本番での検証：鎖の確かめの結果、`audit_pending` の遅れ、履歴の行の増え方、保持の `DROP` の遅れ。

**runbooks**

- `audit-chain-mismatch`：鎖の確かめで食い違いが出た（セキュリティの呼び出し）。
- `audit-anchor-failed`：錨の書き込みが 2 日続けて失敗した。
- `audit-pending-lag`：`audit_pending` の移しが 1 分を超えた。
- `field-history-growth`：履歴の行が見積もりを大きく超える組織への案内。
- `retention-drop-overdue`：保持の期限の分割の `DROP` が遅れた。
- SLI の追加の依頼（Ops へ）：監査のイベントの数（分類ごと）、`audit_pending` の遅れ、ログインの履歴の書き込みの失敗、履歴の行の数と大きさ、錨の書き込みの成否。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `audit_events` | 3.2 節 | 月ごとの分割、RLS、追記だけ。180 日 |
| `audit_heads` | `org_id`、`last_seq`、`last_hash` | 採番 |
| `audit_pending` | `org_id`、`id`、`payload`、`created_at` | 保存の経路からのイベント。1 秒ごとに移す |
| `audit_anchors`（S3、監査のアカウント） | 日付、`org_id`、`seq`、`hash` | Object Lock |
| `audit_exports` | `org_id`、`id`、`from_at`、`to_at`、`state`、`requested_by` | |
| `login_events` | 4 節 | 月ごとの分割、RLS。180 日 |
| `field_history` | 5.2 節 | `history` のクラスタ。月ごとの分割、RLS。18 か月 |
| `md_fields.track_history`、`md_objects.field_history_enabled` | 真偽 | metadata-and-runtime の表（後者は既存） |

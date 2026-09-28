# Sandboxes and deploy: Salesforce

Sandbox の種類と作成・再作成、データの複製とマスキング（法務の L3）、メタデータのパッケージの形式（独自）、デプロイ（検証だけの実行、全部か無しか、破壊的な変更、すばやいデプロイ）、差分と戻しの設計。土台は [ADR-0003](../decisions/0003-metadata-driven-runtime.md)（メタデータの変更は 1 つのトランザクションで版を 1 つ上げる。戻しは差分を逆に当てた新しい版）、[ADR-0005](../decisions/0005-tenancy-and-governor-limits.md)（Sandbox は別の `org_id` の組織。複製は組織をまたぐ管理の処理）、NFR-004（デプロイは全部か無しか、確定の間の書き込みの止まり p99 1 秒、直前の版へ戻すデプロイが 5 分以内）。この文書で決めたことは、次の 3 つの ADR にある。

- Sandbox は 4 種類（`developer`・`developer_pro`・`partial`・`full`）。作成は Worker が元の組織の行を新しい `org_id` へ写す。ID は元の組織と同じものを使う。個人データの項目は、複製の経路の中で、Sandbox ごとの鍵で決まる偽の値に置き換えてから書く（既定で必須。L3 の結論まで外せない）。連携・送信・スケジュールは止めた状態で作る（[ADR-0038](../decisions/0038-sandbox-types-and-masked-copy.md)）。
- メタデータのパッケージは、部品ごとの YAML のファイルと `package.yaml` の目録を zip にした独自の形式にする。参照は全て API の名前で書き、ID を持たない。書き出しは正規化した形にし、書き出してそのまま戻すと差分が 0 になる（[ADR-0039](../decisions/0039-metadata-package-format.md)）。
- デプロイは、計画を作る「検証」と、計画を当てる「適用」に分ける。検証は相手の組織を一切変えない。適用は、ロックの外で計画を行に落としておき、排他のロックの中では版の確かめと書き込みだけを行い、1 つの版で確定する。10 日の中で相手の版が変わっていなければ、検証した計画をそのまま当てられる。戻しは、そのデプロイの差分を逆に当てる新しいデプロイにする（[ADR-0040](../decisions/0040-deploy-validation-and-rollback.md)）。

本家の振る舞いは、2026-09-28 に次の資料で確かめた。確かめられなかったものは「未検証」と書く。本家のメタデータの XML の形式・変更セット・本家の CLI は使わない（[ADR-0001](../decisions/0001-platform-and-stack.md)）。

## 1. 目的と範囲

| 範囲に含む | 範囲に含まない（担当の領域） |
| --- | --- |
| Sandbox の種類、作成、再作成、削除、容量、テンプレート | 組織の作成と削除の本体（[orgs-users-and-auth.md](orgs-users-and-auth.md)） |
| データの複製、マスキング、項目のデータの分類 | 暗号の鍵の階層（security の領域） |
| メタデータのパッケージの形式、書き出し（retrieve） | メタデータの表と版の本体（[metadata-and-runtime.md](metadata-and-runtime.md)） |
| デプロイ（検証、適用、すばやいデプロイ、破壊的な変更、戻し） | 型の変換・索引の作成などの確定の後の処理の中身（各領域） |
| 組織の間のデプロイの接続 | 配布するパッケージ（名前空間、版の管理。MVP の後、extensibility の領域） |

## 2. 本家の仕組み（確かめたこと）

| 項目 | 本家 | 出典 |
| --- | --- | --- |
| Sandbox の種類 | Developer（データ 200MB、メタデータだけ、1 日ごとに再作成）、Developer Pro（1GB、メタデータだけ、1 日）、Partial Copy（データ 5GB、テンプレートで選んだ標本のデータ、5 日）、Full（本番と同じ容量、全てのデータ、29 日）。数は Enterprise で Developer 25・Partial Copy 1、Unlimited で Developer 100・Developer Pro 5・Partial Copy 1・Full 1。Partial Copy のオブジェクトごとの件数の上限（1 万件と広く紹介されている）は本文にない（未検証。E10 の `sandbox-data-copy` で確かめる） | [Sandbox Licenses and Storage Limits by Type](https://help.salesforce.com/s/articleView?id=platform.data_sandbox_environments.htm&type=5)（2026-09-28 に確認） |
| Full の Sandbox の API | テンプレートなしの Full の Sandbox の API の割り当ては 24 時間 500 万 | [Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)（以下「Limits」） |
| デプロイの大きさ | 1 回 10,000 ファイル、zip 39MB（base64 の後 50MB）、展開して 600MB | Limits、[Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)（Winter '27 版、以下「MDAPI」） |
| 検証 | `checkOnly = true` で、変更を保存せずにデプロイを試す | MDAPI の `deploy()` の `DeployOptions` |
| 全部か無しか | `rollbackOnError`：真なら 1 つの失敗で全てを戻す。本番へのデプロイでは真が必須 | MDAPI |
| すばやいデプロイ | 相手の環境で 10 日以内に検証に成功し、テストが通り、網羅の条件を満たした部品の組を、テストを走らせずにデプロイできる | MDAPI の `deployRecentValidation()` |
| 破壊的な変更 | `destructiveChanges.xml` で消す部品を指す。`purgeOnDelete` はごみ箱を通さない（Developer と Sandbox だけ） | MDAPI |
| 戻し | デプロイを戻す専用の操作は資料に書かれていない | [Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)（2026-09-28 に確認） |
| マスキング | 追加の製品（Data Mask の管理パッケージ）が Full・Partial Copy の Sandbox のデータを伏せる。伏せた値は戻せない。この管理パッケージは 2026-12-31 に提供を終え、Data Mask & Seed に移る | [Secure Your Sandbox Data with Salesforce Data Mask (Legacy)](https://help.salesforce.com/s/articleView?id=platform.data_mask_overview.htm&type=5)（2026-09-28 に確認） |
| ID | Sandbox のレコードの ID が本番と同じかは、読めた資料に書かれていない（未検証。本システムの設計はこれに依らない。E10 の `sandbox-data-copy` で確かめる） | — |

## 3. Sandbox の種類（ADR-0038）

| 種類 | 写すもの | データの容量 | ファイルの容量 | 再作成の間隔 | 本番 1 つあたりの数（Enterprise） |
| --- | --- | --- | --- | --- | --- |
| `developer` | メタデータ、利用者（作った人だけ有効） | 200MB | 200MB | 1 日 | 25 |
| `developer_pro` | 同上 | 1GB | 1GB | 1 日 | 5 |
| `partial` | メタデータ、テンプレートで選んだオブジェクトの標本（オブジェクトごとに 1 万件まで）、マスキング | 5GB | 5GB | 5 日 | 1 |
| `full` | メタデータ、全てのデータ（テンプレートで除けるオブジェクトあり）、マスキング | 本番と同じ | 本番と同じ | 29 日 | 0（Unlimited で 1） |

- 種類・容量・間隔は本家に寄せた（2 節）。エディションごとの数は本システムの初期値で、E2 の着手前に PM が決める（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 4 節）。
- Sandbox は `orgs.kind = sandbox` の別の組織で、`parent_org_id` に元の本番の組織を持つ（ADR-0005）。本番の組織のデータを読む経路を持たない。
- ドメイン：`<org>--<sandbox>.sandbox.my.<brand>.<domain>`（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- S1 は本番と同じクラスタに置く。S2 で Sandbox と試用の組織を別のクラスタへ置く（ADR-0005）。
- 割り当て（API など）は、元の本番と同じ式（Full は API 500 万）。[governor-limits.md](governor-limits.md) の 8.1 節。
- 権限：Sandbox の作成・再作成・削除は、本番の組織の `manage_sandboxes`（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 7 節）。監査に残す。

## 4. 作成と複製（ADR-0038）

### 4.1 流れ

```
本番の管理者：POST /api/v1/sandboxes { "name": "uat", "kind": "partial", "template": "<template_id>", "masking_profile": "default" }
  │
  ▼ Worker（class sandbox_copy、組織をまたぐ管理の DB のロール。RLS を外す唯一の経路の 1 つ）
  1. 新しい org_id、shard_no（本番と同じクラスタ）、ドメインを決め、orgs に status = provisioning で作る（進みは sandbox_requests.state = copying）
  2. メタデータの表を写す（org_id を入れ替え、ID はそのまま）。今の版をそのまま 1 つの版として作る（md_versions の履歴は写さない）
  3. 利用者・権限・ロール・グループを写す。利用者のメールを伏せ、作った人以外を無効にする（4.3 節）
  4. データを写す（partial・full）：オブジェクトごとに ID の範囲（1 万件）で読み、マスキングをかけ、records と長いテキストに書く
  5. 写しの表を作り直す：ピボット・一意・関係（derivePivotRows）、照合の鍵（deriveMatchKeys）、共有の行と閉包、積み上げ集計は写した値のまま
  6. 参照の直し：写さなかった親を指す参照を空にし、親のない主従の子を落とす（数を記録する）
  7. 連携を止める（4.4 節）。全ての部品をコンパイルして L2 に置く
  8. orgs.status = active、sandbox_requests.state = ready。作った人にメールで知らせる
```

- **ID はそのまま使う。** レコード・メタデータの ID を付け替えない。全ての表の主キーの先頭は `org_id` なので、同じ ID が別の組織にあっても衝突しない。付け替えると、JSONB の参照の値、フローの `field_id` の束縛、リストビュー・レポートの定義を全て書き換えることになり、誤りの危険が大きい。
  - [ADR-0006](../decisions/0006-data-dictionary-and-field-lifecycle.md) は `field_id` を「全組織で一意の UUIDv7」とした。この ADR で、「組織の中で一意。Sandbox とその元の組織の間では同じ ID を共有する」に読み替える（11 節の依頼）。
- **時点**：データは ID の範囲ごとに読むので、組織の全体の一貫した時点ではない。本番の DB で長いスナップショットを持たないため。参照の食い違いは手順 6 で直し、直した数を作った人に知らせる。
- 部品のキャッシュの鍵は `org_id` を含むので、元の組織と同じハッシュの部品でも別の鍵の空間に置く（[metadata-and-runtime.md](metadata-and-runtime.md) の 4.2 節）。
- 写さないもの：ごみ箱のレコード、項目の変更の履歴、監査のログ、ログインの履歴、変更のイベント、一括のジョブ、レポートの非同期の結果、画面のフローの実行、承認のインスタンス（ロックを含む）、メールの本文と添付（`email_message` は件名だけ）。
- 所要時間の見積もり：`full` で 5,000 万件の組織は、範囲ごとの並行 8 で数時間（E10 で測る）。Worker の公平な順番（class `sandbox_copy`、組織で 1）の中で進める。

### 4.2 テンプレートと標本（`partial`）

- テンプレートは、写すオブジェクトの一覧（`full` では除くオブジェクトの一覧）。
- `partial` の標本は、オブジェクトごとに `created_at` の新しい順に 1 万件。加えて、写したレコードが参照する親を 1 段だけ写す（親は 1 万件の外でもよい）。主従の子は、親を写した時だけ写す。
- 標本の大きさは、容量（5GB）を超えそうなら、オブジェクトごとの件数を比例して減らす。

### 4.3 マスキング（法務の L3）

項目に**データの分類**を持つ（`md_fields.data_class`）。

| `data_class` | 例 | 複製での既定 |
| --- | --- | --- |
| `none` | 商談のフェーズ、金額 | そのまま |
| `personal` | 取引先責任者・リードの氏名・カナ・メール・電話・住所、利用者の氏名 | 偽の値（下の表） |
| `sensitive` | 組織が指定（個人の番号、健康など） | 空にする |

| 型・種類 | 偽の値の作り方 |
| --- | --- |
| 氏名（漢字） | 生成した偽の姓・名の辞書から、`HMAC(sandbox_key, 元の値)` で選ぶ。同じ元の値は同じ偽の値になる |
| 氏名のカナ | 選んだ偽の氏名の読み |
| メール | `u<HMAC の先頭 12 文字>@example.invalid` |
| 電話 | `000-` ＋ HMAC から作った数字（桁の形を保つ） |
| 住所 | 都道府県を保ち、市区町村以下を偽の値に |
| その他の文字列 | 同じ長さの `x` の並び、または空 |
| 長いテキスト・リッチテキスト | `personal`・`sensitive` なら空 |
| 添付・ファイル | 写さない（`full` でも既定で写さない。テンプレートで選べる） |

- **マスキングは Worker の複製の経路の中で行い、伏せる前の値を Sandbox の DB に一度も書かない。**
- 同じ元の値が同じ偽の値になる（Sandbox ごとの鍵）ので、重複の照合・参照の結び付き・レポートの集計の形が保たれる。鍵は Sandbox ごとに作り、作成の後に捨てる（元の値に戻せない）。
- 標準オブジェクトの個人データの項目は、種から `personal` にする。カスタム項目の既定は `none` で、管理者が分類する。項目の作成の画面で分類を必ず選ばせる（既定の `none` を明示の選択にする）。
- **法務の L3 の結論が出るまで、`personal` のマスキングを外す設定を持たない**（intent）。結論の後に、外せる条件（`manage_sandboxes` と `view_all_data` を持つ人の明示の選択、監査）を別の ADR で決める。L3 の結論まで、E10 の「データを含む Sandbox」の spec を承認しない。
- 利用者の複製：作った人だけを有効にし、他の利用者は無効（`status = deactivated`）にして、メールを伏せる。管理者が Sandbox で必要な人を有効にし直す（メールは本人が確かめ直す）。SSO の設定は写すが、無効にする。

### 4.4 止めた状態で作るもの

| もの | Sandbox での状態 |
| --- | --- |
| Webhook・外向きの呼び出しの宛先 | 写すが `disabled`。秘密は写さない。管理者が宛先と秘密を入れ直して有効にする |
| 変更のイベントの対象 | 写す。購読者はいない |
| スケジュールのフロー、予定の経路 | 写すが止める（予定の行は写さない） |
| メールの送信 | システムの通知（パスワードの再設定など）だけ。その他は外へ送らず、Setup の「送信の記録」に残す |
| OAuth のクライアント（連携のアプリ） | 写さない（秘密を持つため） |
| SSO の接続 | 写すが無効 |

- 本番の相手に、Sandbox から誤ってデータを送らないため。

### 4.5 再作成と削除

- 再作成は、新しい組織を作って（4.1 節）、できたらドメインを付け替え、古い Sandbox の組織を削除する。古い組織の `org_id` は再利用しない。
- 再作成の間隔（3 節）の前は断る。
- 削除は、組織を `deleting` にして読み書きを止め、7 日の後に全ての行と S3 のファイルと検索の文書を消す（組織の削除の手順。[orgs-users-and-auth.md](orgs-users-and-auth.md) の 3 節）。
- 本番の組織を削除すると、その Sandbox も全て削除する。

## 5. メタデータのパッケージの形式（ADR-0039）

### 5.1 形

```
package.zip
├─ package.yaml
├─ objects/
│   └─ x_contract/
│       ├─ object.yaml
│       ├─ fields/
│       │   ├─ x_amount.yaml
│       │   └─ x_account.yaml
│       ├─ record_types/…
│       ├─ validation_rules/…
│       ├─ layouts/…
│       └─ list_views/…
├─ standard_objects/account/fields/x_region.yaml      （標準オブジェクトへの追加）
├─ flows/set_region_from_prefecture.yaml
├─ approval_processes/…
├─ permission_sets/…、profiles/…、roles/…、groups/…
├─ sharing/criteria_rules/…、sharing/owner_rules/…、sharing/owd.yaml
├─ duplicate_rules/…、matching_rules/…
├─ report_types/…、reports/…、dashboards/…
├─ event_types/…、channels/…、webhooks/…（秘密なし）、outbound_endpoints/…（秘密なし）
└─ destructive.yaml                                      （任意。消す部品）
```

```yaml
# package.yaml
format: <brand>-md
format_version: 1
source: { org_kind: sandbox, lineage: "<本番の org の ID のハッシュ>", metadata_version: 1043 }
components:
  - { kind: field, name: x_contract.x_amount, hash: "sha256:…" }
  - { kind: flow,  name: set_region_from_prefecture, hash: "sha256:…" }
```

```yaml
# objects/x_contract/fields/x_amount.yaml
api_name: x_amount
label: 契約金額
type: currency
type_params: { precision: 18, scale: 0 }
required: false
data_class: none
searchable: false
track_history: true
help_text: 税抜きの金額
```

- **参照は全て API の名前で書く**（`x_contract.x_amount`、`account.billing_prefecture`）。ID（`field_id`・`object_id`）を持たない。デプロイの時に相手の組織の ID に解決する。組織の間で ID が違っても使える。
- フロー・リストビュー・レポートの定義の中の項目の参照も、書き出しの時に `field_id` から API の名前へ直し、デプロイの時に戻す。
- YAML は YAML 1.2 の部分集合（アンカー・エイリアス・タグ・複数の文書を使わない）。安全な読み込みだけにする。部品の種類ごとに JSON Schema を持ち、`format_version` ごとに公開する。
- **書き出しは正規化した形**（キーの順、既定値を書かない、文字列の引用の規則）にする。書き出したものをそのまま同じ組織へデプロイすると、差分は 0 になる（5.3 節の性質）。git での差分が読みやすく、AI エージェントも人も直しやすい。
- 名前の変更は、新しい名前のファイルに `rename_from: <古い名前>` を書いて明示する。書かないと新しい部品の追加になり、古い部品は残って値は写らない。パッケージに入れない部品は消さない（消すのは `destructive.yaml` だけ）。
- `destructive.yaml` は消す部品の一覧。消す時期（`pre`：追加の前、`post`：追加の後）を選べる。
- データ（レコード）は含めない。選択リストの値、レコードタイプ、既定値は含める。
- 本家の XML の形式・`package.xml`・変更セットは受け付けない（ADR-0001、AGENTS.md）。移行の道具は別の Epic（intent の Non-goals）。

### 5.2 部品の置き換えの規則

- 1 つの部品のデプロイは、その部品の**全体の置き換え**にする。権限セットは、書いた項目・オブジェクト・システムの権限が全てで、書いていないものは外す。本家のプロファイルのデプロイの「書いた部分だけを当て、書いていない標準のオブジェクト・項目の権限は上書きしない」振る舞い（[Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)、Winter '27 版の Profile、2026-09-28 に確認）は採らない。権限の結果が、パッケージだけで決まるようにするため。
- 例外：標準オブジェクト（`standard_objects/`）は、書いた項目・設定だけを足す・変える（標準の項目は消せないため）。

### 5.3 書き出し（retrieve）

```
POST /api/v1/metadata/retrieves { "components": [{ "kind": "object", "name": "x_contract" }], "with_dependencies": true }
→ 202 { "id": "<retrieve_id>" } → GET /api/v1/metadata/retrieves/{id} → zip
```

- `with_dependencies`：数式・フロー・レイアウトが参照する項目・オブジェクト・選択リストを足す（`md_dependencies`）。
- 権限：`customize_application`（または `deploy_metadata`）。

## 6. デプロイ（ADR-0040）

### 6.1 API

```
POST /api/v1/metadata/deploys   （multipart：package.zip と options）
  options: { "mode": "validate" | "deploy", "allow_data_loss": false, "allow_warnings": false }
→ 202 { "id": "<deploy_id>", "state": "queued" }
GET  /api/v1/metadata/deploys/{id}        （state、plan の要約、エラー、警告、post_jobs）
POST /api/v1/metadata/deploys/{id}/quick  （検証した計画を当てる。6.4 節）
POST /api/v1/metadata/deploys/{id}/rollback（6.5 節）
POST /api/v1/metadata/deploys/{id}/cancel （適用の前だけ）
```

- 権限：`deploy_metadata`（本番）。Sandbox の中は `customize_application` でもよい（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 7 節）。
- 組織で同時に動くデプロイは 1 つ（検証は 3 つまで）。

### 6.2 検証（計画を作る）

```
1. 形：zip の大きさ（50MB、展開して 600MB）、部品の数（10,000）、YAML の安全な読み込み、JSON Schema
2. 名前の解決：API の名前を、相手の組織の今の版（V0）とパッケージの中で解決する
3. 差分：部品ごとに、V0 の定義と比べて add / update / delete / no-op を決める（正規化した形のハッシュで比べる）
4. コンパイル：V0 のメタデータに差分を当てた「仮の版」を、変わった部品と依存する部品だけコンパイルする（ADR-0007）
     - 数式・入力規則・フローの型の検査、到達できない要素、禁止の要素
     - 依存：消す項目を参照する数式・フロー・レイアウト・リストビュー・レポートがないか
     - 上限：メタデータの上限（governor-limits.md の 6.2 節）
5. データへの影響：
     - 型の変換：変換できない値の件数（metadata-and-runtime.md の 5.1 節の下見）
     - 項目・オブジェクトの削除：値のある件数（15 日は戻せる）
     - 一意・外部 ID を付ける：今の値の重複の件数（あれば失敗）
     - 必須にする：空の件数（警告。保存の時だけ効く）
     - レコードの条件の共有ルール・照合の規則・積み上げ集計・検索の項目：作成の仕事の見積もり
6. 計画（plan）を保存：V0、差分の一覧、ハッシュ、データへの影響、後の仕事の一覧
```

- **検証は相手の組織を一切変えない**（NFR-004）。コンパイルはメモリーの中で行い、メタデータの表に書かない。データへの影響の件数は reader で数える。
- 誤り（`error`）が 1 つでもあれば、計画は `failed`。警告（`warning`：データの消える削除、空の多い必須、変換できない値）は、`allow_data_loss`・`allow_warnings` がなければ `failed` にする。
- 検証の結果の計画は `mode = deploy` でもそのまま使う（検証と適用で同じ計画）。

### 6.3 適用（1 つの版で確定する）

```
1. 行を作る（ロックの外）：計画の差分から、書き込むメタデータの行（md_objects、md_fields、…）と md_changes を全て作る
2. 排他のロック（pg_advisory_xact_lock。metadata-and-runtime.md の 4.1 節）
3. orgs.metadata_version が V0 のままか確かめる。違えば、ロックを外して 6.2 からやり直す（1 回）。2 回目は failed（METADATA_CHANGED）
4. 行を書き、md_versions に source = deploy で 1 行、orgs.metadata_version = V0 + 1
5. outbox に metadata.version_changed と、後の仕事（型の変換、索引、共有のルールの版、照合の鍵、積み上げ集計、検索の作り直し）
6. 確定
7. 後の仕事は Worker で。デプロイの状態に post_jobs として進みを見せる
```

- **全部か無しか**：手順 4 の 1 つのトランザクションで、全ての部品の変更が 1 つの版になる。途中で失敗すれば何も変わらない。本家の本番の `rollbackOnError = true` と同じ性質（MDAPI）。部分の成功のデプロイは持たない。
- **書き込みの止まり**（NFR-004 の p99 1 秒）：ロックの中は、版の確かめと、作っておいた行の書き込み（`COPY` か複数行の `INSERT`）だけにする。部品 2,000 までは 500ms を目安にし、E10 で測る。それより大きいデプロイは、適用の前に「書き込みが最大 N 秒止まる」と警告する。
- 後の仕事は、それぞれの領域の「作成中」の状態（`building`・`converting`）で動くので、確定の直後から新しい版の定義で読み書きでき、途中の状態は各領域の規則で見える（例：作成中のルールはまだ効かない）。後の仕事が失敗しても、メタデータの版は戻さない。各領域の中止の手順（型の変換の中止は古い値が残る。ADR-0006）で扱い、デプロイの状態に `post_job_failed` を出す。

### 6.4 すばやいデプロイ

- 検証に成功した計画は、**10 日**の間、`/quick` で当てられる（本家の 10 日に寄せる。MDAPI）。
- 相手の組織の版が、検証の時の V0 のままなら、6.3 節の手順 1 から当てる（検証をやり直さない）。版が変わっていたら、自動で 6.2 節の検証をやり直し、差分が同じなら当てる。違えば `failed`（`PLAN_STALE`）。
- 本家のすばやいデプロイは Apex のテストの省略のためのものだが、本システムは利用者のコードがない（MVP）ので、「検証の結果を使って、業務の時間の外にすばやく当てる」ための道具にする。

### 6.5 戻し

```
POST /api/v1/metadata/deploys/{id}/rollback
  1. そのデプロイの版 Vd の md_changes を読み、逆の差分を作る（add → delete、delete → restore、update → before に戻す）
  2. Vd より後の版で、同じ部品を変えていないか確かめる。変えていれば、衝突の一覧を返して止める（force なし）
  3. 逆の差分を計画にして、6.2・6.3 節を通す（新しい版 Vr = 今の版 + 1。版を巻き戻さない。ADR-0003）
```

| 変更 | 戻し方 |
| --- | --- |
| 部品の追加 | 消す（項目は削除の印。15 日は戻せる） |
| 部品の更新 | `md_changes.before` の定義に戻す |
| 項目・オブジェクトの削除 | 戻す（15 日の中なら値も戻る。ADR-0006、ADR-0011） |
| 型の変換 | 変換が終わる前なら中止。終わった後は、古い `field_no` の値が消去の前（15 日）なら古い型へ切り替え直す。消去の後は戻せない（戻しの前の検証で知らせる） |
| 権限セット・共有の設定 | 前の定義に戻す（共有のルールは新しい `rule_id` の作成として再計算が走る） |

- NFR-004 の「直前の版へ戻すデプロイが 5 分以内」：戻しは検証（コンパイルは変わった部品だけ）と適用で、確定までを 5 分以内にする。後の仕事（共有の再計算など）は含まない。
- 型の変換を戻せるよう、変換の後も古い `field_no` の値を 15 日残すことを metadata-and-runtime の領域に依頼する（11 節）。

### 6.6 組織の間のデプロイ

- 基本の流れ：Sandbox から書き出し（5.3 節）→ git で管理 → 本番へデプロイ（6.1 節）。CLI（公式の SDK の一部）が書き出しとデプロイを行う。
- 画面の流れ（本家の変更セットに相当）：同じ系統（`parent_org_id` が同じ本番）の組織の間で、送る側の管理者が部品を選んでパッケージを「送り」、受ける側の管理者が「受け取って」検証とデプロイをする。受ける側の `deploy_metadata` が要る。送ったパッケージは受ける側の組織に 30 日保つ。
- 組織をまたぐ認証：CLI は相手の組織の OAuth のトークン（`deploy_metadata` を持つ利用者）で呼ぶ。画面の送り受けは、同じ系統の組織の間だけで、送る側の組織が受ける側のデータを読む経路を持たない（パッケージの zip を S3 経由で渡すだけ）。

## 7. 上限（S1 の初期値）

値は [governor-limits.md](governor-limits.md) を正とする。

| 上限 | 値 | 本家 |
| --- | --- | --- |
| パッケージの部品 | 10,000 | 10,000 ファイル（Limits） |
| zip・展開の後 | 50MB・600MB | 39MB（base64 の前）・600MB（Limits） |
| 同時のデプロイ・検証 | 1・3 | 未検証 |
| すばやいデプロイの期限 | 10 日 | 10 日（MDAPI） |
| 画面で送ったパッケージの保持 | 30 日 | 未検証 |
| Sandbox の容量・再作成の間隔・数 | 3 節 | 2 節 |
| `partial` の標本 | オブジェクトごとに 1 万件 | 1 万件と広く紹介されている（未検証。2 節） |
| Sandbox の削除から消去 | 7 日 | 未検証 |

本家の列の「未検証」は、本家の値を公開の資料で確かめていないもの。本システムの値は本家に依らず、E12 の `limits-final-values` で決める。

## 8. 障害のとき

| 事象 | 振る舞い |
| --- | --- |
| 複製の途中で Worker が止まる | 範囲ごとに冪等なので再開。`sandbox_requests.state = copying` のまま。24 時間を超えたら警告 |
| 複製で容量を超える | `partial` は件数を減らしてやり直す。`full` は失敗にし、テンプレートで除くオブジェクトを案内する |
| マスキングの誤り（分類の漏れ） | 分類のない `personal` らしい項目（名前・メール・電話の形の値が多い項目）を、作成の前に検出して警告する。L3 の結論まで、疑わしい項目も既定で伏せる選択を出す |
| 検証の後に版が変わる | 適用の時に再検証（6.3 節の 3）。すばやいデプロイでも同じ |
| 適用のロックが長い | 手順 1 をロックの外に置く。止まりの時間を計測し、p99 1 秒を超えたら警告 |
| 後の仕事の失敗 | 版は戻さない。各領域の中止の手順。デプロイに `post_job_failed` |
| 戻しの衝突 | 衝突の一覧を返して止める。管理者が新しいデプロイで直す |

## 9. セキュリティ

- Sandbox へのデータの複製は、組織をまたぐ管理の処理として Worker の専用の DB のロールだけが行う（ADR-0005）。RLS を外す経路なので、複製の Worker のコードは `security:sensitive`（AGENTS.md）。
- 伏せる前の個人データを Sandbox の DB に書かない（4.3 節）。マスキングの鍵は作成の後に捨てる。
- Sandbox から本番の組織のデータを読めない。性質ベーステストで確かめる（ADR-0005 の Confirmation）。
- 連携の秘密（Webhook、外向きの呼び出し、OAuth のクライアント）を Sandbox へ写さない（4.4 節）。
- パッケージに秘密を入れない（Webhook・外向きの呼び出しの宛先は秘密なし）。YAML は安全な読み込みだけ（任意の型の生成を許さない）。
- デプロイ・戻し・Sandbox の作成・再作成・削除・マスキングの設定の変更を、監査に残す（[audit-and-field-history.md](audit-and-field-history.md) の 3 節）。
- テストとテンプレートに本物の個人データを使わない（AGENTS.md）。偽の氏名の辞書は生成したものにする。
- `security:sensitive` の対象：複製の Worker、マスキング、項目の分類の既定、デプロイの権限、組織の間の送り受け。

## 10. テスト

- 決定表：`DT-DEP-001`（検証の結果：誤り・警告 × `allow_data_loss`・`allow_warnings` → 成功・失敗）、`DT-DEP-002`（6.5 節の戻し方の表）を表駆動テストにする。
- 性質ベーステスト（fast-check）：
  - `PROP-DEP-001`（草案）：任意の組織とパッケージで、検証（`validate`）の前後で相手の組織のメタデータ・版・データが変わらない。
  - `PROP-DEP-002`（草案）：任意のパッケージの適用は全部か無しか。途中で失敗を注入しても、版が上がっていないか、全ての部品が新しい定義になっているかのどちらか。
  - `PROP-DEP-003`（草案）：任意の組織で、書き出し → 同じ組織へのデプロイの差分が 0（`no_changes`、版を上げない）。
  - `PROP-DEP-004`（草案）：任意のデプロイ D の直後の戻しで、メタデータのスナップショットが D の前と同じ意味になる（戻せない型の変換を除く）。
  - `PROP-SBX-001`（草案）：任意の本番のデータで、Sandbox の DB のどの行にも、`personal`・`sensitive` の項目の元の値が現れない。同じ元の値は同じ偽の値になる。
  - Sandbox の組織のコンテキストで、元の本番の組織の行が読めない。
- 結合テスト：適用の間の書き込みの止まりの p99 が 1 秒以内（部品 2,000）。戻しが 5 分以内（NFR-004）。
- 結合テスト：10 日を過ぎたすばやいデプロイが断られる。版が変わった後のすばやいデプロイが再検証される。
- 上限の試験：部品 10,000、zip 50MB、同時のデプロイ 1。
- 性能テスト（E10）：`full` の Sandbox の 5,000 万件の複製の時間。

## 11. この領域の ADR

| ADR | 決定 |
| --- | --- |
| [0038](../decisions/0038-sandbox-types-and-masked-copy.md) | Sandbox は 4 種類。ID をそのまま使って新しい `org_id` へ写し、個人データは複製の経路の中で Sandbox ごとの鍵の偽の値に置き換える（L3 の結論まで必須）。連携・送信・スケジュールは止めて作る |
| [0039](../decisions/0039-metadata-package-format.md) | パッケージは部品ごとの YAML と目録の zip。参照は API の名前だけ。書き出しは正規化し、書き出して戻すと差分 0。部品のデプロイは全体の置き換え |
| [0040](../decisions/0040-deploy-validation-and-rollback.md) | デプロイは計画を作る検証と、1 つの版で当てる適用に分ける。ロックの中は版の確かめと書き込みだけ。10 日のすばやいデプロイ。戻しは逆の差分の新しいデプロイ |

他の領域への依頼：

- metadata-and-runtime の領域：`field_id` の一意を「組織の中で一意。Sandbox と元の組織は同じ ID を共有する」に読み替える（ADR-0006 の文言）。`md_fields.data_class` を足す。型の変換の後も古い `field_no` の値を 15 日残す（戻しのため）。
- data-storage の領域：複製の Worker の DB のロールを、RLS を外せる許可リストに足す。
- sharing-and-record-access の領域：システムの権限に `manage_sandboxes`・`deploy_metadata` を足す（[orgs-users-and-auth.md](orgs-users-and-auth.md) の 7 節）。
- reports-and-dashboards の領域：レポート・ダッシュボード・レポートの型をパッケージの部品に入れる（そちらの 15 節の E10 の Story）。

## 12. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | CI：`DT-DEP-*`・`PROP-DEP-*`・`PROP-SBX-001` の枠。パッケージの JSON Schema の公開 |
| E2 | Sandbox の組織（`kind`、`parent_org_id`、ドメイン）と、種類ごとの数と容量 |
| E3 | 項目のデータの分類（`data_class`）と、項目の作成の画面での選択 |
| E10 | Sandbox の作成（メタデータだけ：`developer`・`developer_pro`） |
| E10 | データの複製（`partial` の標本、`full`）と参照の直し |
| E10 | マスキング（偽の氏名の辞書、HMAC、形を保つ値）。L3 の結論まで spec を承認しない |
| E10 | 連携・送信・スケジュールを止めて作る |
| E10 | 再作成と削除 |
| E10 | パッケージの形式（YAML、JSON Schema、正規化）と書き出し |
| E10 | デプロイの検証（名前の解決、差分、仮の版のコンパイル、データへの影響） |
| E10 | デプロイの適用（ロックの外の行の作成、1 つの版、後の仕事） |
| E10 | すばやいデプロイと戻し |
| E10 | 組織の間の送り受け（画面）と CLI |
| E7 | レポート・ダッシュボードをパッケージの部品に入れる |
| E11 | デプロイ・Sandbox の監査 |
| E12 | 書き込みの止まり（NFR-004）と戻しの時間の負荷試験、`full` の複製の時間 |

## 13. 未解決の問い

- Sandbox の ID を元の組織と同じにするか（ADR-0006 の「全組織で一意」との関係）。
- マスキングを外す条件（法務の L3）。
- 項目の分類の既定を `none` にしてよいか（カスタム項目の個人データが漏れうる）。
- パッケージを YAML にするか JSON にするか。
- 大きなデプロイ（部品 2,000 を超える）の書き込みの止まりをどう抑えるか。
- 型の変換の後の戻しのために、古い値を 15 日残す費用。
- 本家から移る組織のための、本家のメタデータからの変換の道具を持つか。

### 決定

2026-09-28 の既定案。

- ID は同じにする（ADR-0038）。全ての表の主キーの先頭が `org_id` なので衝突しない。ADR-0006 の文言の読み替えを metadata-and-runtime の領域に依頼する。
- マスキングは既定で必須にし、外す設定を持たない。L3 の結論の後に別の ADR で決める。
- カスタム項目の分類は、作成の画面で必ず選ばせ、複製の前に「個人データらしい項目」を検出して警告する。
- YAML にする（部分集合と JSON Schema で安全にする）。git の差分と人の読み書きのため。
- 部品 2,000 を超えるデプロイは警告し、E10 で止まりを測る。p99 1 秒を超えるなら、部品の種類ごとに版を分けるデプロイ（全部か無しかを外す）ではなく、ロックの中の書き込みを `COPY` にして縮める。
- 古い値は 15 日残す（削除と同じ期間）。
- 変換の道具は MVP の後（intent の Non-goals）。

## 14. quality.md・runbooks・data-model に載せるもの

**quality.md**

- リスク：Sandbox への個人データの複製（法務の L3）。`PROP-SBX-001`、分類の漏れの検出、E12 の外部のペンテスト。
- リスク：デプロイの部分の適用・検証での本番の変更。`PROP-DEP-001`・`002`。
- リスク：書き込みの止まり（NFR-004）。適用の結合テストと本番の計測。
- リスク：戻しで元に戻らない。`PROP-DEP-004`。
- 上限の試験：7 節。
- 本番での検証：デプロイの失敗の率、適用の止まりの p99、戻しの時間、Sandbox の複製の時間。

**runbooks**

- `sandbox-copy-stuck`：複製が 24 時間を超えた。
- `sandbox-masking-incident`：伏せていない個人データが Sandbox に入った疑い。Sandbox を止めて消し、法務とセキュリティに知らせる。
- `deploy-lock-stall`：適用の止まりが p99 1 秒を超えた。
- `deploy-rollback`：本番のデプロイを戻す手順（戻しの衝突の見方を含む）。
- `deploy-post-job-failed`：後の仕事の失敗。
- SLI の追加の依頼（Ops へ）：デプロイの検証・適用の時間、適用の止まりの p99、戻しの時間、Sandbox の複製の時間と失敗の率、マスキングの警告の件数。

**data-model**

| テーブル | 主な列 | 備考 |
| --- | --- | --- |
| `orgs`（Sandbox の列） | `kind`、`parent_org_id`、`sandbox_name`、`sandbox_kind`、`copied_at`、`refresh_available_at` | [orgs-users-and-auth.md](orgs-users-and-auth.md) |
| `sandbox_requests` | `org_id`（本番）、`id`、`name`、`kind`、`template_id`、`masking_profile_id`、`target_org_id`、`state`、`progress`、`requested_by` | |
| `sandbox_templates` | `org_id`、`id`、`include_objects`、`exclude_objects`、`copy_files` | |
| `md_fields.data_class` | `none`・`personal`・`sensitive` | metadata-and-runtime の表への追加 |
| `masking_profiles` | `org_id`、`id`、`rules`（型・分類ごとの作り方） | |
| `metadata_retrieves` | `org_id`、`id`、`components`、`state`、`s3_key`、`expires_at` | |
| `metadata_deploys` | `org_id`、`id`、`mode`、`state`、`base_version`、`result_version`、`plan_hash`、`plan_s3_key`、`validated_at`、`quick_until`、`rollback_of`、`requested_by`、`errors`、`warnings`、`post_jobs` | |
| `inbound_packages` | `org_id`（受ける側）、`id`、`from_org_id`、`s3_key`、`sent_by`、`expires_at` | 同じ系統の間だけ |

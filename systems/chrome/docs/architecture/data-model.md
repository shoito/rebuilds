# Data model: Chrome

ブラウザの端末に保存するデータと、クラウドのサービスのデータの索引。**各ストア・テーブルの定義の正本は、表の「定義の場所」にある文書** で、ここには一覧と、領域をまたぐ規則だけを書く。実装の変更（`changes/`）で形式やテーブルを変えるときは、ここと定義の場所の文書を同じ PR で更新する。

前提の決定：サイトの隔離（[ADR-0003](../decisions/0003-multi-process-site-isolation.md)）、送るデータの最小化と同期の暗号化（[ADR-0005](../decisions/0005-privacy-first-services.md)）、分割のキー（[ADR-0017](../decisions/0017-partitioning-by-top-level-site.md)）、保存の部品を SQLite に揃えること（[ADR-0018](../decisions/0018-indexeddb-on-sqlite.md)）、同期の暗号化（[ADR-0027](../decisions/0027-sync-protocol-and-e2ee.md)）、クラッシュとテレメトリの識別子（[ADR-0032](../decisions/0032-crash-and-telemetry-privacy.md)）。

## 1. 端末のデータ

### 1.1 置き場所

```
<ユーザーデータのディレクトリ>/
├── Local State                     # JSON。ブラウザ全体の状態
├── Safe Browsing/                  # 手元のリスト（プロファイルで共有）
├── Crashpad/                       # クラッシュのダンプの DB
├── ShaderCache/                    # GPU のシェーダーのキャッシュ
└── <Profile>/                      # プロファイルごと。ゲストは閉じたらディレクトリごと消す
    ├── Preferences                 # JSON：設定、コンテンツ設定（サイトごとの権限）
    ├── Bookmarks                   # JSON（チェックサム付き）＋ 1 世代の予備
    ├── History                     # SQLite：URL、訪問、検索語、ダウンロードの履歴
    ├── Favicons                    # SQLite
    ├── Shortcuts                   # SQLite：アドレスバーの入力と選んだ候補
    ├── Login Data                  # SQLite：パスワード（値は暗号化）
    ├── Web Data                    # SQLite：自動入力、検索エンジン
    ├── Sessions/                   # セッション・タブの追記の記録（sessionStorage を含む）
    ├── Sync Data                   # SQLite：同期の進み具合、未送信の変更、鍵束の写し
    ├── Extensions/<id>/<version>/  # 展開した拡張機能のパッケージ
    ├── Extension State             # SQLite：インストール、有効・無効、権限の承認
    ├── Extension Storage/<id>      # SQLite：`storage.local`
    ├── Extension Rules/<id>/       # DNR の規則の索引
    ├── Code Cache/                 # JavaScript・Wasm のコンパイル結果
    ├── Network/                    # Network サービスだけが書く（storage.md の 2 節）
    │   ├── Cookies                 # SQLite
    │   ├── TransportSecurity       # JSON：HSTS の動的な記録
    │   └── Reporting and NEL       # SQLite
    ├── Cache/                      # HTTP キャッシュ：1 件 1 ファイル＋ SQLite の索引（networking.md の 5.3 節）
    └── Storage/                    # Storage サービスだけが書く（storage.md の 2 節）
（OS の場所）アップデータの状態      # Windows：Program Files と ProgramData、macOS：/Library 以下
（OS の鍵の保管）                    # DPAPI・Keychain・Secret Service の項目（1.3）
```

- ファイル名は本家のプロファイルに倣った機能の名前で、ブランドを含めない。OS の鍵の保管の項目の名前は `<Brand> Safe Storage` の形にする（[リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
- LevelDB は使わない。本家が LevelDB に置くもの（localStorage、拡張機能の保存、同期の状態）も SQLite にする。JSON のファイルは、一時ファイルに書いてから置き換える。

### 1.2 ストアの一覧

| ストア | 範囲 | 形式 | 中身 | 暗号化 | シークレットモード | 同期 | 定義の場所 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ブラウザ全体の状態（Local State） | ブラウザ | JSON | プロファイルの一覧、クラッシュの報告・テレメトリの同意、フィールドトライアルの seed と署名・端末の乱数 | — | 共有（書かない） | しない | [update-and-release.md](update-and-release.md) の 12 節、[browser-ui.md](browser-ui.md) の 6 節 |
| 設定（Preferences） | プロファイル | JSON | 設定、コンテンツ設定（サイトごとの権限、一時の抑止の記録、例外）、拡張機能の設定 | — | 元の値を読み、変更はメモリだけ | 選んだ項目（`preferences`）。権限は同期しない | [browser-ui.md](browser-ui.md) の 4 節、[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 5 節 |
| 履歴 | プロファイル | SQLite | 訪れた URL、訪問、検索語、ダウンロードの履歴と判定の結果 | — | 書かない | 既定でする（`history`、90 日） | [navigation-and-loading.md](navigation-and-loading.md)、[browser-ui.md](browser-ui.md) の 3・7 節 |
| ファビコン、アドレスバーのショートカット | プロファイル | SQLite | サイトのアイコン、入力した語と選んだ候補 | — | 書かない | しない | [browser-ui.md](browser-ui.md) の 3.1 節 |
| ブックマーク | プロファイル | JSON | ブックマークの木 | — | 元のプロファイルのものを読み書きする | する（`bookmarks`） | [browser-ui.md](browser-ui.md) の 6.2 節 |
| セッション・タブ | プロファイル | 追記の記録 | 開いているタブ、ナビゲーションの履歴（POST の本文を除く）、sessionStorage、閉じたタブ（25 件） | — | 書かない | タブはする（`open_tabs`） | [navigation-and-loading.md](navigation-and-loading.md) の 6.4 節、[storage.md](storage.md) の 6 節 |
| パスワード（Login Data） | プロファイル | SQLite | オリジン、ユーザー名、暗号化したパスワード、作成・使用の日時 | 値を AES-256-GCM。データ鍵は OS の鍵の保管で守る | 元のプロファイルのものを読むだけ | する（`passwords`、E2EE） | [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 6 節 |
| 自動入力・検索エンジン（Web Data） | プロファイル | SQLite | 住所、フォームの値、検索エンジンの一覧と既定 | しない（本家と同じ。支払いのカードは MVP の外） | 書かない | する（`autofill_profiles`、`search_engines`） | [browser-ui.md](browser-ui.md) の 3.2 節、[sync-and-accounts.md](sync-and-accounts.md) の 3 節 |
| Cookie | プロファイル | SQLite | Cookie（CHIPS の分割を含む） | 値を暗号化（OS の鍵の保管で包んだ鍵。Windows は実行ファイルに結び付けた鍵） | メモリだけ | しない | [networking.md](networking.md) の 8 節 |
| HSTS・Reporting・NEL | プロファイル | JSON、SQLite | HSTS の動的な記録、報告の設定 | — | メモリだけ | しない | [networking.md](networking.md) の 5・6 節 |
| HTTP のキャッシュ | プロファイル | ファイル＋ SQLite の索引 | 応答の本文とヘッダー。分割のキー付き | — | メモリだけ | しない | [networking.md](networking.md) の 5.2・5.3 節 |
| コードのキャッシュ | プロファイル | ファイル | JavaScript・Wasm のコンパイル結果 | — | メモリだけ | しない | [javascript-and-web-apis.md](javascript-and-web-apis.md) |
| サイトの保存領域 | プロファイル | SQLite ＋ファイル（バケットごと） | localStorage、IndexedDB、Cache Storage、Service Worker の登録とスクリプト（OPFS は MVP の後） | — | メモリだけ | しない | [storage.md](storage.md) の 2 節 |
| Safe Browsing のリスト | ブラウザ | 独自の形式のファイル | 脅威の種類ごとのハッシュの接頭辞の集合、版、チェックサム。拡張機能の停止の一覧 | —（署名を検証する） | 共有 | しない | [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 2 節、[extensions.md](extensions.md) の 9 節 |
| Safe Browsing の照会の結果 | ブラウザ | メモリだけ | 完全なハッシュ・リアルタイムの照会の結果。サービスが指定した時間（5 分以内）だけ | — | 別に持つ | しない | [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 2.3 節 |
| 拡張機能 | プロファイル | ファイル、SQLite | パッケージ、インストールと権限の承認、`storage.local`、DNR の索引 | — | 許可したものだけ動く | 一覧（`extensions`）と `storage.sync`（`extension_settings`） | [extensions.md](extensions.md) の 10 節 |
| 同期の状態（Sync Data） | プロファイル | SQLite | 進み具合の印、未送信の変更、鍵束の写し（SRK で暗号化） | 端末の秘密鍵は OS の鍵の保管 | 同期しない | — | [sync-and-accounts.md](sync-and-accounts.md) の 4・5 節 |
| アカウントのトークン | プロファイル | OS の鍵の保管 | リフレッシュトークン（アクセストークンはメモリだけ） | OS の鍵の保管 | — | — | [sync-and-accounts.md](sync-and-accounts.md) の 2.2 節 |
| クラッシュのダンプ | ブラウザ | Crashpad の DB | minidump と許可リストの注釈。同意がなければ 7 日で消す | — | 共有 | しない | [update-and-release.md](update-and-release.md) の 9 節 |
| テレメトリの未送信のレポート | ブラウザ | ファイル | 同意したときだけ。セッションの集計 | — | 記録しない | しない | [update-and-release.md](update-and-release.md) の 10 節 |
| アップデータの状態 | 端末（OS のユーザーかシステム） | 独自のファイル | 導入済みの版、差分の元の成果物、配信の区画（0〜999）、活動の数え方の日付、前回の結果 | — | — | しない | [update-and-release.md](update-and-release.md) の 3・4.1 節 |
| 描画のキャッシュ | ブラウザ | ファイル | GPU のシェーダーのキャッシュ | — | 共有 | しない | [rendering.md](rendering.md) |
| プロセスの割り当て | ブラウザ | メモリだけ | サイトとプロセスの鍵の対応 | — | — | — | [process-model.md](process-model.md) の 3 節 |

### 1.3 OS の鍵の保管に置くもの

| 項目 | 守るもの | 定義の場所 |
| --- | --- | --- |
| プロファイルのデータ鍵（`<Brand> Safe Storage`） | パスワードの値、Cookie の値 | [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 6.1 節、[networking.md](networking.md) の 8.3 節 |
| 同期の端末の X25519 の秘密鍵 | 端末に包んだ SRK | [sync-and-accounts.md](sync-and-accounts.md) の 4.1 節 |
| リフレッシュトークン | アカウントのサービスへの接続 | [sync-and-accounts.md](sync-and-accounts.md) の 2.2 節 |

- Linux で Secret Service も KWallet も使えないときは、保護が弱いことを設定の画面で示す（[safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 6.1 節）。

### 1.4 ビルドに含める設定と、開発リポジトリの記録

端末の利用者のデータではないが、安全の根拠になるもの（[sandbox-and-security.md](sandbox-and-security.md) の 10 節）。

| 記録 | 置き場所 |
| --- | --- |
| プロセスの種類ごとのサンドボックスのプロファイル（SBPL、seccomp の規則、トークンの設定） | ビルドに含める |
| 埋め込む公開鍵（リリース、CUP、フィールドトライアル、Safe Browsing のリスト）と鍵の番号 | ビルドに含める（本番と開発版で別。[infrastructure.md](infrastructure.md) の 7 節） |
| `unsafe` を許すクレートの目録、部品の目録（`third_party/manifest.toml`）、cargo-vet の監査の記録 | 開発リポジトリ |
| 指標の登録簿 | 開発リポジトリ（公開する。[update-and-release.md](update-and-release.md) の 10 節） |
| 不正な IPC の理由のコード | クラッシュの報告の注釈と、テレメトリの集計（個人のデータを含めない） |

## 2. サービスのデータ

### 2.1 置き場所

| 置き場所 | 中身 |
| --- | --- |
| prod-core の Aurora | 更新（リリース、配信の段階）、フィールドトライアル、Safe Browsing の脅威のデータとリストの版、拡張機能のストア |
| アカウント・同期の Aurora（prod-core、別のクラスタ） | アカウント（Better Auth）と同期の暗号文。S2 で同期を `account_id` のハッシュでシャードする（[sync-and-accounts.md](sync-and-accounts.md) の 6 節） |
| prod-diagnostics の Aurora | クラッシュの集計（シグネチャ、件数）、シンボルの索引 |
| S3（prod-core） | 更新の成果物・予備のマニフェスト、Safe Browsing のリストのスナップショットと差分、フィールドトライアルの seed、拡張機能のパッケージ |
| S3（prod-diagnostics） | 生の minidump（30 日）、テレメトリの Parquet（90 日）、シンボル |
| Valkey | 同期の変更の通知（pub/sub）。失われてもよい |
| AMP | 端末の集計の指標（版・チャンネル・OS ごと）、サービスの指標 |

- どのテーブルも、IP アドレスと、端末・利用者を長く識別する ID を持たない（アカウント・同期のアカウント ID を除く）。

### 2.2 更新・クラッシュ・テレメトリ・フィールドトライアル

定義の場所は [update-and-release.md](update-and-release.md)（4・9・10・12 節）。

```sql
-- 更新（prod-core）
releases        (id, app_id, version, channel, platform, arch,
                 release_signature,               -- KMS の署名（版、ハッシュ、チャンネル）
                 full_artifact_url, full_sha256, full_size,
                 urgency,                          -- normal / critical
                 min_os_version, created_at)
release_diffs   (release_id, from_version, format,  -- zucchini / puffin
                 artifact_url, sha256, size)
rollouts        (release_id, stage_percent,         -- 1 / 10 / 50 / 100
                 state,                             -- active / frozen / halted / completed
                 min_stage_until, updated_by, updated_at)
rollout_events  (id, release_id, kind,              -- advance / freeze / resume / halt / pull
                 reason, actor,                     -- 人か rollout-guard
                 metrics_snapshot JSONB, created_at)
policy_pins     (id, channel, version_prefix, note) -- 企業向けの固定の選択肢

-- クラッシュ（prod-diagnostics）
crash_reports   (id,                                -- レポートごとの乱数
                 received_at, version, channel, platform, process_type,
                 signature_id NULL, dump_key,       -- S3 のキー。30 日で消える
                 symbolication_state)
crash_signatures(id, signature, first_version, first_seen_at, issue_url NULL)
crash_counts    (signature_id, version, channel, platform, day, count)
symbol_files    (build_id, module, platform, s3_key, uploaded_at)

-- テレメトリ（prod-diagnostics）
metric_registry (name, kind, unit, owner, expires_milestone, privacy_class)  -- 開発リポジトリのファイルの写し
telemetry_reports                               -- S3 の Parquet（テーブルではない）。90 日

-- フィールドトライアル（prod-core）
studies         (id, name, feature, channel_filter, platform_filter,
                 groups JSONB, state, owner, created_at)
seeds           (id, channel, serial, s3_key, signature, published_at, published_by)
```

- `crash_reports` と `telemetry_reports` は、利用者・端末・アカウントのどの ID も持たない（ADR-0032）。
- `rollouts` と `rollout_events` は、段階の変更の記録を残す（誰が、なぜ、そのときの指標）。
- 活動中の端末の数は、テーブルに行を持たず、AMP のカウンターとして持つ（[observability.md](observability.md) の 3.1 節）。

### 2.3 アカウントと同期

定義の場所は [sync-and-accounts.md](sync-and-accounts.md) の 2.3・6・8 節。アカウントは Better Auth のモデル名を変えて使う（[ADR-0028](../decisions/0028-account-service.md)）。

```sql
-- アカウント
accounts          (id, email, email_verified, created_at, deletion_scheduled_at NULL)
sessions          (id, account_id, expires_at, ...)       -- アカウントの Web のページ用
passkeys          (id, account_id, credential_id, public_key, ...)
two_factors       (account_id, totp_secret_ciphertext)
verifications     (id, identifier, otp_hash, expires_at)
oauth_clients     (id, kind, redirect_uris)               -- ブラウザ（第一者の公開クライアント）
oauth_tokens      (id, account_id, device_id, refresh_token_hash, rotated_from NULL, expires_at, revoked_at NULL)
devices           (id, account_id, display_name_ciphertext, os, version,
                   registered_at, last_synced_at, revoked_at NULL)
deletion_events   (id, pseudonymous_account_id, operation, created_at)  -- 仮名化して 1 年

-- 同期（中身はすべて暗号文。見えるメタデータは sync-and-accounts.md の 2.4 節）
sync_entities     (account_id, data_type, entity_id,      -- entity_id は乱数か鍵付きハッシュ
                   version, ciphertext, key_version, deleted, updated_at, size)
sync_type_state   (account_id, data_type, next_version, total_size)
sync_key_bags     (account_id, ciphertext, key_version, version)
sync_wrapped_keys (account_id, wrapped_for,               -- device:<id> / recovery_code / passphrase
                   wrapped_srk, kdf_params, salt)
sync_device_keys  (account_id, device_id, public_key, state)
```

- 削除の印は 60 日、Aurora の特定時点への復元は 35 日、アカウントの削除の取り消し期間は 14 日（[sync-and-accounts.md](sync-and-accounts.md) の 5.4・8 節）。

### 2.4 Safe Browsing

定義の場所は [safe-browsing-and-permissions.md](safe-browsing-and-permissions.md) の 3 節（部品）。テーブルの名前はここで付けた。列の確定は E5 の Story で行う。

```sql
sb_sources           (id, kind,                -- commercial_feed / exchange / user_report / crawl
                      name, contract_ref, enabled, last_ingested_at)
sb_threat_entries    (id, threat_type,         -- phishing / malware / unwanted / abusive_notifications
                      url_expression,          -- 正規化した照合の式
                      full_hash,               -- SHA-256
                      source_id, score, state, -- candidate / listed / removed
                      reviewed_by NULL, listed_at, removed_reason NULL)
sb_list_versions     (list_name, version, snapshot_s3_key, checksum, entry_count, signature, published_at)
sb_list_diffs        (list_name, from_version, to_version, s3_key, size)
sb_protected_domains (domain, reason, added_by, added_at)   -- 保護の一覧
sb_user_reports      (id, kind,                -- phishing / false_positive
                      url, received_at, triage_state)       -- 利用者が送ると決めた URL だけ
sb_appeals           (id, domain, state, opened_at, decided_at, decision)
```

- サービスが持つのは、脅威の URL（公開の情報）とハッシュだけ。端末からの照会は記録しない。

### 2.5 拡張機能のストア

定義の場所は [extensions.md](extensions.md) の 6〜9 節。テーブルの名前はここで付けた。列の確定は E7 の Story で行う。

```sql
ext_developers        (id, account_id,          -- アカウントのサービスの ID（ADR-0028）
                       display_name, verified_at, suspended_at NULL)
ext_items             (id,                      -- 拡張機能 ID（公開鍵の SHA-256 の先頭 128 bit）
                       developer_id, public_key, listing JSONB,
                       state,                   -- draft / published / taken_down
                       user_count_estimate, created_at)
ext_versions          (item_id, version, package_s3_key, sha256, manifest JSONB,
                       store_signature, state,  -- pending / approved / rejected
                       rollout_percent, submitted_at, published_at)
ext_reviews           (id, item_id, version, kind,  -- automated / human
                       risk_score, findings JSONB, decision, policy_ref NULL, reviewer NULL, decided_at)
ext_appeals           (id, review_id, state, reviewer, decided_at)   -- 元の審査の担当者と別の人
ext_reports           (id, item_id, reason, received_at)             -- 利用者の通報。端末の ID を持たない
ext_blocklist_entries (item_id, version_range,
                       reason,                  -- malware / policy_violation / potentially_unwanted / unpublished
                       evidence, added_by, confirmed_by, added_at, removed_at NULL)
```

- 停止の一覧は、`ext_blocklist_entries` から Safe Browsing のリストの版（`sb_list_versions` の 1 つのリスト）として作り、同じ経路・同じ署名で配る。

### 2.6 保持の一覧

| データ | 保持 | 定義の場所 |
| --- | --- | --- |
| 生のクラッシュのダンプ | 30 日 | [observability.md](observability.md) の 6 節 |
| クラッシュの集計 | 2 年 | 同上 |
| テレメトリのレポート | 90 日。その後は集計だけ | 同上 |
| シンボル | 配布を終えた版から 2 年 | 同上 |
| サービスのログ | 30 日 | 同上 |
| CloudFront・ALB・WAF のアクセスログ | 7 日（IP を含む） | 同上 |
| 同期の削除の印 | 60 日 | [sync-and-accounts.md](sync-and-accounts.md) の 5.4 節 |
| アカウント・同期のバックアップ | 35 日 | [sync-and-accounts.md](sync-and-accounts.md) の 8 節 |
| 削除の記録（仮名化） | 1 年 | 同上 |
| 配信の記録（`rollout_events`） | 期限なし（リリースの記録） | [update-and-release.md](update-and-release.md) の 4.3 節 |

## 3. 領域をまたぐ規則

- **形式の版と移行。** 端末のストアは、形式の版を持つ（SQLite は `user_version`、JSON は版の項目）。新しい版のブラウザは起動時に前向きに移行し、**1 つ前のマイルストーンの版が読める形を保つ**（[update-and-release.md](update-and-release.md) の 3.4 節）。保てない変更は、2 回のマイルストーンに分ける（読むだけの対応を先に出し、書き換えを次に出す）。この規則の外の古い版（2 つ以上前）が新しい形式を見つけたら、開かずに失敗させる（[storage.md](storage.md) の 12 節）。
- **壊れたときの回復。** ストアが壊れていたら、そのストアだけを退避して作り直し、ブラウザは起動を続ける。退避と作り直しの件数を指標にする（同意したとき）。同期の対象なら、サーバーから取り直す。
- **シークレットモード**は、端末に書かない。表の「メモリだけ」のストアは、最後のシークレットのウィンドウを閉じたら消える。
- **閲覧データの削除**（利用者の操作）は、期間と種類を指定して、表のストアを横断して消す。サイトの保存領域はバケット単位で消す（[storage.md](storage.md) の 11 節）。同期の対象なら、削除も同期する（`history_delete_directives`）。
- **サイトの分離。** サイトごとのデータ（Cookie、保存領域、キャッシュ、パスワード）は、Renderer から直接は触れない。Browser プロセスが、そのプロセスに割り当てたサイトで検査して渡す（ADR-0003）。
- **サービスに平文を置かない。** 同期のデータは暗号文だけ（ADR-0005、ADR-0027）。クラッシュ・テレメトリは、利用者の ID を持たない（ADR-0032）。
- **本家のデータは取り込まない。** 本家のプロファイルの形式（LevelDB の IndexedDB など）と本家の同期のデータは読まない。移行は、書き出したファイル（ブックマークの HTML、パスワードの CSV）から行う（[sync-and-accounts.md](sync-and-accounts.md) の 10 節、ADR-0018）。

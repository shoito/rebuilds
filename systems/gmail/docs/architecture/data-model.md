# Data Model: Gmail

表と置き場所の索引。各表の列・主キー・索引の細部は、各領域の文書の「data-model への項目」の節が正本で、この文書はその一覧と、横断の規約を持つ。列・制約・量まで書いた ER 図の全体は、開発リポジトリを作るときに後で足す（持ち主は Dev、レビューは QA）。

2026-10-10 の統合の工程で、領域の文書の項目から作った。

## 1. 規約

| 対象 | 規約 | 根拠 |
| --- | --- | --- |
| メールボックスのシャードの表 | `tenant_id`・`account_id`（UUIDv7）を主キーと索引の先頭に置き、`FORCE ROW LEVEL SECURITY` と `SET LOCAL app.tenant_id`・`app.account_id` で絞る。書くのは `mailstore` だけで、変更は同じトランザクションで `modseq`・change log・outbox を書く | [ADR-0006](../decisions/0006-sync-protocol-jmap-imap-and-modseq.md)、[ADR-0007](../decisions/0007-tenancy-accounts-orgs-and-rls.md) |
| directory の表 | `tenant_id` で FORCE RLS。RLS の外は ADR-0007 の一覧だけ（`domains`、`address_index`、`sessions`、`oauth_tokens_index`、`oauth_clients`、outbox の読み出しの位置、SLI の集計）で、メールの中身・件名・ローカル部を持たない | [ADR-0007](../decisions/0007-tenancy-accounts-orgs-and-rls.md) |
| blob の目録のシャード | RLS の外（ADR-0007 の X5）。場所・包んだ鍵・参照だけで、中身・件名・アドレスを持たない | [ADR-0003](../decisions/0003-message-storage-layout-and-dedupe.md)、[ADR-0031](../decisions/0031-blob-references-gc-and-quota.md) |
| テナントをまたぐ経路 | X1〜X10 だけ。専用の DB のロールを通す | [ADR-0007](../decisions/0007-tenancy-accounts-orgs-and-rls.md)、[ADR-0061](../decisions/0061-operator-access-cross-tenant-paths-and-audit.md) |
| ID | UUIDv7。JMAP の Email の ID と IMAP の `EMAILID` は `(message_id, object_gen)` から作る | [ADR-0034](../decisions/0034-threading-implementation-and-merge.md) |
| アドレス | 宛先・差出人を記録に残すときは、テナントの鍵の HMAC（`addr_hmac`）とドメインだけ。ローカル部を平文で持つのは、メッセージの行・スプール・blob・`addresses` だけ | [ADR-0008](../decisions/0008-spam-pipeline-boundary-and-secrecy.md)、[security.md](security.md) の 4 節 |
| 暗号 | 4 段の鍵（KMS の用途の鍵 → TRK → 日ごとの KEK → blob・索引の鍵）。blob と索引のセグメントは AES-256-GCM | [ADR-0030](../decisions/0030-blob-format-v1-and-envelope-keys.md)、[ADR-0060](../decisions/0060-key-hierarchy-and-crypto-erasure.md) |
| S3 のキー | アカウントのデータは `account_id` を先頭か、`<shard>`・日付の後に持つ。キーを作る関数は `AccountId`（か `TenantId`）を最初の引数に取る | [ADR-0007](../decisions/0007-tenancy-accounts-orgs-and-rls.md) の Confirmation |
| Valkey の鍵 | 失ってよい（正本にしない）。アカウントの鍵は `{account_id}` を含む | [architecture/README.md](README.md) の 4 節 |
| 形式のバージョン | `spool_version`、blob の `format_version`、`analyzer_version`、`threading_version`、`filter_version`、`schema_version`。読む側を先に出す | [ADR-0070](../decisions/0070-format-versions-and-model-rollout.md) |
| 追記だけの表 | `changes`、`account_risk_events`、`audit_events`、`signin_events`、`delivery_log` などの事象の表は更新しない | 各 ADR |
| フラグ | `release.*` は kebab-case、`ops.*` は snake_case（AppConfig） | [AGENTS.md](../../AGENTS.md) |

## 2. directory（Aurora、リージョンで 1 つ）

| 領域 | 表 | 正本の節 |
| --- | --- | --- |
| テナントとアカウント | `tenants`、`accounts`（`local_canon`、`state`、`risk_state`、`quota_state`、`inbound_rate_multiplier`、`mailbox_shard`）、`reserved_locals`、`retired_locals` | [ADR-0007](../decisions/0007-tenancy-accounts-orgs-and-rls.md)、[accounts-and-security.md](accounts-and-security.md) の 13 節、[inbound-smtp.md](inbound-smtp.md) の 16 節 |
| サインインと OAuth | `credentials`、`sessions`（RLS の外）、`oauth_tokens_index`（RLS の外）、`device_authorizations`、`signin_events`、`recovery_methods`・`recovery_requests`、`send_as_identities`、`account_risk_events` | [accounts-and-security.md](accounts-and-security.md) の 13 節 |
| 第三者のアプリ | `oauth_clients`（RLS の外）、`developers`、`oauth_grants`、`org_app_policies`、`push_subscriptions` | [api-and-integrations.md](api-and-integrations.md) の 12 節 |
| 組織 | `org_units`、`ou_policies`・`effective_policies`、`admin_role_assignments`、`idp_configs`、`routing_rules`、`footers`、`org_usage`（`preserved_bytes`） | [organizations-domains-and-routing.md](organizations-domains-and-routing.md) の 13 節 |
| ドメインとアドレス | `domains`（RLS の外。`state`、`alias_of`、`unknown_rcpt`、`local_part_policy`、`smtp_policy_class`、`catch_all`、`mta_sts_hosted`、`mta_sts_mode`）、`domain_verifications`、`domain_checks`、`addresses`、`address_index`（RLS の外）、`groups`・`group_members`、`system_addresses` | 同上、[inbound-smtp.md](inbound-smtp.md) の 16 節 |
| 送信者の認証 | `dkim_keys`、`dkim_key_events`、`arc_trusted_sealers`、`dmarc_report_rows`、`org_sending_settings` | [sender-authentication.md](sender-authentication.md) の 14 節 |
| 送信と評判 | `ip_pools`、`warmup_daily`、`mx_groups`、`org_reputation`、`fbl_trace`（`tenant_id` で FORCE RLS。X9 で引く）、`complaints_daily`・`bounces_daily`、`dmarc_out_daily`、`tlsrpt_daily` | [outbound-smtp-and-reputation.md](outbound-smtp-and-reputation.md) の 15 節 |
| 選別 | `quarantine_items`、`org_filter_lists`・`org_filter_policy`、`emergency_rules`、`confirmed_phish_urls`、`org_attachment_policy`、`filter_rollouts` | [spam-and-abuse-filtering.md](spam-and-abuse-filtering.md) の 18 節、[attachment-and-url-scanning.md](attachment-and-url-scanning.md) の 11 節、[delivery.md](delivery.md) の 8 節 |
| 保持と eDiscovery | `retention_rules`、`matters`・`matter_members`・`matter_scope`、`holds`、`exports`、`legal_preservations`（X10。法務の L4 まで無効） | [retention-and-ediscovery.md](retention-and-ediscovery.md) の 12 節 |
| 鍵と監査 | `tenant_keys`（TRK）、`tenant_keks`、`account_index_keys`、`audit_events`、`break_glass_sessions` | [security.md](security.md) の 13 節、[message-parsing-and-storage.md](message-parsing-and-storage.md) の 12 節 |
| 基盤 | `ip_ranges`、`ip_assignments`、`mailbox_shards`（`schema_version`）、`account_moves`、`dr_events`、`search_assignments`、`provider_groups` | [infrastructure.md](infrastructure.md) の 12 節、[search.md](search.md) の 13 節、[observability.md](observability.md) の 11 節 |
| 配送の記録 | `delivery_log`（`spool_id`、受け手の `account_id`、結果のコード、`addr_hmac`。日の分割、90 日。保持の期間は法務の L1・L6）。書き込みは受け手ごとに 1 日約 7,200 万行で、量と置き場所は残る未解決事項（[README.md](README.md) の 6 節） | [observability.md](observability.md) の 9・11 節 |
| 形式 | `schema_versions` | [delivery.md](delivery.md) の 8 節 |

## 3. メールボックスのシャード（Aurora、S1 で 8）

| 領域 | 表 | 正本の節 |
| --- | --- | --- |
| メッセージ | `messages`（前置き、`view_edits`、`object_gen`、MIME の構造の索引、`verdict`・`reason_codes`・`p_spam`・`p_phish`・`filter_version`・`feature_id`・`rescan_state`、`url_warn`・`attachment_warn`）、`account_usage` | [message-parsing-and-storage.md](message-parsing-and-storage.md) の 12 節、[spam-and-abuse-filtering.md](spam-and-abuse-filtering.md) の 18 節、[attachment-and-url-scanning.md](attachment-and-url-scanning.md) の 11 節 |
| ラベルとスレッド | `labels`（`uid_jump_floor`）、`message_labels`（`uid`）、`threads`、`thread_nodes`、`thread_senders`、`thread_labels` | [mailbox-model-labels-and-threads.md](mailbox-model-labels-and-threads.md) の 10 節 |
| 同期 | `changes`（change log。`kind` に `preserved_purged`、`flags_changed` に `preserved`）、`accounts_state`、`imap_vanished`、`all_mail_uids`、`message_keywords`、`sent_dedupe` | [client-sync-and-protocols.md](client-sync-and-protocols.md) の 12 節 |
| 送信 | `submissions`（`hold_kind`、`release_at`、`undo_status`、`state`、`gate_state` ほか）、`submission_recipients`、`account_send_risk` | 同上、[outbound-smtp-and-reputation.md](outbound-smtp-and-reputation.md) の 15 節、[filters-forwarding-and-automation.md](filters-forwarding-and-automation.md) の 10 節 |
| フィルターと自動化 | `filters`、`forward_targets`、`account_settings`、`vacation`、`vacation_replies`、`timers` | [filters-forwarding-and-automation.md](filters-forwarding-and-automation.md) の 10 節、[web-client.md](web-client.md) の 14 節 |
| 選別の設定と相手 | `filter_settings`、`sender_affinity`、`image_settings`、`unsubscribe_actions` | [spam-and-abuse-filtering.md](spam-and-abuse-filtering.md) の 18 節、[attachment-and-url-scanning.md](attachment-and-url-scanning.md) の 11 節、[sender-authentication.md](sender-authentication.md) の 14 節（`unsubscribe_actions` の正本。web-client.md の行は同じ表） |
| 保全 | `preserved_messages`（利用者のどの経路にも出さない） | [retention-and-ediscovery.md](retention-and-ediscovery.md) の 4.4 節 |
| 検索 | `search_accounts` | [search.md](search.md) の 13 節 |
| 端末 | `devices` | [mobile-and-push.md](mobile-and-push.md) の 10 節 |
| 共通 | outbox、`schema_versions` | 各領域、[delivery.md](delivery.md) の 8 節 |

## 4. blob の目録のシャード（Aurora、S1 で 4）

| 表 | 中身 | 正本の節 |
| --- | --- | --- |
| `blob_catalog` | 場所（オブジェクト、位置、長さ）、大きさ、SHA-256、`zero_since` | [message-parsing-and-storage.md](message-parsing-and-storage.md) の 12 節 |
| `blob_wrapped_keys` | テナントごとの包んだ blob の鍵 | 同上 |
| `blob_refs` | `lease`・`mailbox`・`hold`（保全の行ごとに 1 つ、`hold:<tenant_id>:<message_id>`）・`outbound` の参照の行 | 同 8.1 節 |
| `packs` | パックの生きている割合 | 同 12 節 |

## 5. S3

| キー | 中身 | 正本の節 |
| --- | --- | --- |
| `spool-tyo`・`spool-osa`：`spool/<yyyy>/<mm>/<dd>/<hh>/<spool_id>` | `SpoolEnvelope` と生のメッセージ（7 日） | [inbound-smtp.md](inbound-smtp.md) の 10 節 |
| 同：`spool-done/…/<task_id>-<seq>`、`spool-rejected/…/<host>-<seq>` | 終わった・拒んだ `spool_id` の束（8 日） | 同 11 節 |
| 同：`expansion/<yyyy>/<mm>/<dd>/<spool_id>` | グループの展開の結果 | [organizations-domains-and-routing.md](organizations-domains-and-routing.md) の 13 節 |
| `blobs-tyo`・`blobs-osa`：`blobs/<shard>/<yyyy>/<mm>/<dd>/<blob_id>`、`packs/<shard>/…/<pack_id>` | blob とパック（パックは 90 日で Glacier Instant Retrieval） | [message-parsing-and-storage.md](message-parsing-and-storage.md) の 12 節、[ADR-0064](../decisions/0064-storage-classes-and-region-replication.md) |
| `search/<account_id>/<segment_id>`、`search/<account_id>/bitmaps/<modseq>` | 合わせたセグメント（1 つのオブジェクト）、状態のビットマップのスナップショット | [search.md](search.md) の 13 節 |
| `quarantine/<tenant_id>/…/<quarantine_id>` | 組織の隔離（30 日） | [spam-and-abuse-filtering.md](spam-and-abuse-filtering.md) の 18 節 |
| `features/…`、`reputation/…`、`models/<filter_version>/` | 特徴の記録、評判のスナップショット、モデルの登録 | 同上、[delivery.md](delivery.md) の 8 節 |
| `scanner/defs/<version>/`、`scanner/malware-hashes/<version>`、`url-lists/…` | 検査の定義と一覧 | [attachment-and-url-scanning.md](attachment-and-url-scanning.md) の 11 節 |
| `reports/tlsrpt/…`、`reports/tlsrpt-out/…`、`reports/dmarc-in/…`、`reports/dmarc-out/…` | TLS-RPT と DMARC の報告 | [inbound-smtp.md](inbound-smtp.md)、[outbound-smtp-and-reputation.md](outbound-smtp-and-reputation.md)、[sender-authentication.md](sender-authentication.md) |
| `ediscovery/<tenant_id>/<matter_id>/results/…`、`ediscovery-exports/<tenant_id>/<export_id>/…` | 検索の結果と書き出し | [retention-and-ediscovery.md](retention-and-ediscovery.md) の 12 節 |
| 別のアカウント：`training/labels/`（学習）、`samples/<submission_id>`（報告のサンプル）、`audit/<stream>/<tenant_id>/…`（監査、Object Lock）、`canary/<経路>/…`（見張り） | 中身から作った特徴と同意のあるサンプル、監査、見張り | [spam-and-abuse-filtering.md](spam-and-abuse-filtering.md)、[security.md](security.md) の 13 節、[observability.md](observability.md) の 11 節 |

## 6. SQS・SNS

| 名前 | 中身 | 正本の節 |
| --- | --- | --- |
| SQS `inbound-delivery`・`inbound-delivery-low`（東京・大阪）と DLQ | 配送の依頼（`spool_id`、宛先、検査の要約、`attempt`） | [inbound-smtp.md](inbound-smtp.md) の 11.2 節 |
| SQS `outbound-<pool>` | `delivery_job` | [outbound-smtp-and-reputation.md](outbound-smtp-and-reputation.md) の 15 節 |
| SQS `filter-events`、`rescan` | 報告と選び直し | [spam-and-abuse-filtering.md](spam-and-abuse-filtering.md) の 18 節 |
| SNS `account-risk` | 乗っ取りの出来事 | [accounts-and-security.md](accounts-and-security.md) の 13 節 |
| outbox の種類 | `account.changed`、`message.delivered`、`message.destroyed`、参照の増減ほか | 各領域の「data-model への項目」 |

## 7. Valkey（失ってよい）

| 鍵 | 用途 | 正本の節 |
| --- | --- | --- |
| `rep:{kind}:{key}`（受信の `rep:ip:{ip}`・`rep:range:{range}` を含む。評判の専用のクラスタ） | 評判の数え | [spam-and-abuse-filtering.md](spam-and-abuse-filtering.md) の 18 節、[inbound-smtp.md](inbound-smtp.md) の 16 節 |
| `rl:{kind}:{key}`、`rcpt:{hmac}`、`rrate:{account_id}:…`、`dup:{account_id}:{hash}` | 受信の上限、宛先、再送の重複の抑え | [inbound-smtp.md](inbound-smtp.md) の 16 節 |
| `orl:{pool}:{group}`、`ogrp:{pool}:{group}`、`slim:{account_id}`、`sburst:{account_id}`、`mtasts:{domain}` | 送信の速さと上限、MTA-STS | [outbound-smtp-and-reputation.md](outbound-smtp-and-reputation.md) の 15 節 |
| `tok:{token_hash}`、`revoked:{session_family}` | トークンと失効 | [accounts-and-security.md](accounts-and-security.md) の 13 節 |
| `apirl:{kind}:{key}`、`imapbw:{account_id}:{hour}`・`{day}` | API と IMAP の量の上限 | [api-and-integrations.md](api-and-integrations.md) の 12 節 |
| `aidx:…`、`uidx:…`、`udidx:…`（専用） | 配った後の手当ての逆引き（72 時間） | [attachment-and-url-scanning.md](attachment-and-url-scanning.md) の 11 節 |
| `render:{account_id}:…`、`pushq:{device_id}`、`pushrate:{device_id}` | 描画のキャッシュ、プッシュのまとめ | [web-client.md](web-client.md) の 14 節、[mobile-and-push.md](mobile-and-push.md) の 10 節 |

## 8. 端末の中

- Web：IndexedDB `acct-<hmac>`、`url_prefixes`（[web-client.md](web-client.md) の 14 節、[ADR-0043](../decisions/0043-web-offline-cache-and-optimistic-updates.md)）。
- モバイル：見出し 30 日・本文 7 日の手元の DB（端末の鍵で暗号化。[mobile-and-push.md](mobile-and-push.md) の 10 節、[ADR-0046](../decisions/0046-mobile-offline-scope-and-device-management.md)）。

## 9. 統合の工程でそろえた名前

- 配送の待ち行列は `inbound-delivery` と `inbound-delivery-low`。終わりの印は `spool-done` の束。
- `hold` の参照の鍵は `hold:<tenant_id>:<message_id>`（保全の行ごとに 1 つ）。
- `fbl_trace` は X9 の `report_lookup` のロールで引く。
- `unsubscribe_actions` の正本は sender-authentication.md。`tenant_keks` の正本は security.md（message-parsing-and-storage.md の行は同じ表）。

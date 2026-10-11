# Design log: GitHub

設計の工程ごとに決めたことの記録。今の結論は [README.md](README.md) と各領域の文書と ADR にあり、ここはその経緯を残す。新しい記録は末尾に足す。

記録は README.md から本文のまま移したもので、本文の中の「1.4 節」「6 節」などの節の番号は、[README.md](README.md) の節を指す。

## 2026-09-26：既定案

PM の方針（本家 GitHub に寄せる、既定案）により、次のとおり決めた。上のリスクのうち、計測・PoC で確かめるものは決定の対象にせず、下の「持ち越し」に置いた。残りの判断は、2026-09-28 に推奨案で確定した（次の節）。

- **NFR-009 の RTO**：Web・API と、直近 7 日に push か fetch のあったリポジトリの読み書きは 4 時間以内、全リポジトリは 24 時間以内（3 節）。30 TB を 4 時間で全部戻すことは見込めないため（[capacity.md](capacity.md) の 2.8 節、ADR-0032）。認められない場合の代案（大阪に活発なリポジトリの非同期の複製を常に置く）は S2 で採る。
- **NFR-011 の追加**：通知を Web の受信箱に p95 30 秒以内、メールを p95 5 分以内（3 節）。本家は数値を公開していないが、「開発の流れをつなぐ」（[intent.md](../intent.md)）の価値を測るために NFR にした。[runbooks](../runbooks/README.md) の SLI と [quality.md](../quality.md) の E5 の合否基準に加えた。
- **Web の画面の言語は英語と日本語。** 利用者の設定、なければ `Accept-Language` で選ぶ。開発者向けの用語は訳さない（[web.md](web.md) の 9 節）。本家の画面は英語だけなので、ここは本家との違い。
- **公開リポジトリの大量の clone の費用の対策**（intent.md の未解決の問い）：人気の公開リポジトリは bundle-uri と CDN で配り（ADR-0008）、リポジトリごと・IP ごとの clone のレート制限をかける（[git-protocols.md](git-protocols.md) の 8 節、[capacity.md](capacity.md) の 4 節）。利用者ごとの帯域の課金は MVP に含めない。
- **Web の描画の方式**を [ADR-0035](../decisions/0035-web-rendering-ssr-streaming.md) にした。
- **Actions のホストの台数と費用**：ADR-0023 の SMT の無効を前提に、1 ホスト約 40 VM、ピーク 54 台、本番の費用 約 30 万ドル/月に直した（[capacity.md](capacity.md) の 2.9 節、[infrastructure.md](infrastructure.md) の 4・9 節）。
- **バックアップ**：大阪の S3 に直接書く（レプリケーションは使わない）。消去したリポジトリは「最新の完全な復元点を常に残す」の例外で、消去から 35 日で消える（[git-storage.md](git-storage.md) の 9・11 節、ADR-0030）。
- **識別子**：リポジトリ共通の ADR-0006 に合わせ、ヘッダー・トークンの接頭辞・ドメイン・環境変数・パスを置き換え用の名前にした。api-and-webhooks.md の「ヘッダーの名前と商標」「トークンの接頭辞」の問いは、これで決着した。
- 領域ごとの問いの決定は、各文書の「決定（2026-09-26、既定案）」にある：[identity-and-permissions.md](identity-and-permissions.md) の 14 節、[notifications.md](notifications.md) の 12 節、[api-and-webhooks.md](api-and-webhooks.md) の 16 節、[issues.md](issues.md) の 16 節、[search.md](search.md) の 9 節、[web.md](web.md) の 12 節、[pull-requests.md](pull-requests.md) の 14 節、[actions.md](actions.md) の 18 節、[security.md](security.md) の 15 節。

## 2026-09-28：推奨案で確定

残っていた判断を、推奨案で確定した。あわせて、リポジトリ共通の [ADR-0007](../../../../docs/decisions/0007-no-reuse-of-original-implementation.md)（本家の実装を核に使わない）に照らして見直した。

- **非公開の fork のネットワークでの SHA の参照**：到達可能性の検査を既定でかける。Go のストレージの層に自前で持ち、Git の v2 の `want` と Web・API の SHA の参照がここを通る。本家より厳しく、本家との違い。費用は E1 で測る（[ADR-0007](../decisions/0007-fork-network-object-sharing.md) の注記、[git-storage.md](git-storage.md) の 7.2 節、[identity-and-permissions.md](identity-and-permissions.md) の 6・14 節）。
- **Actions のランナーのエージェント**：actions/runner の fork をやめ、Go で自前で作る。ADR-0007 に反していたため（[ADR-0036](../decisions/0036-own-runner-agent-and-no-original-components.md)、[actions.md](actions.md) の 9.2・18 節）。
- **本家の公開の部品**：Markdown に cmark-gfm、UI に Primer を使わない。言語の判定の go-enry（第三者）と、開発の道具の CodeQL などは、核から外れ置き換えがきくので使ってよい（[ADR-0036](../decisions/0036-own-runner-agent-and-no-original-components.md)、[web.md](web.md) の 4.1 節）。
- **NFR-009 の RTO の範囲**：2026-09-26 の既定案のまま確定した。大阪に常にノードを置く案は S1 で採らない（[ADR-0032](../decisions/0032-disaster-recovery-strategy.md)）。
- **S3 のルーティングの表**：Aurora Global Database に置く。ADR-0032 で使っており、運用を増やさない（[ADR-0034](../decisions/0034-multi-region-repository-placement.md)。proposed のまま）。
- **S3 のメタデータの置き場所**：PR・Issue などリポジトリに属するものはホームのリージョンに、利用者・Organization などはグローバルに置く。マージと ref の更新を 1 つのリージョンで完結させるため（[ADR-0034](../decisions/0034-multi-region-repository-placement.md)、[infrastructure.md](infrastructure.md) の 10 節）。
- **GraphQL の実装**：Pothos ＋ GraphQL Yoga。第三者の部品で、REST と同じサービス関数を呼べる（[api-and-webhooks.md](api-and-webhooks.md) の 5.1・16 節）。

## 2026-09-28：データモデルの統合

データモデルを [data-model.md](data-model.md) にまとめるときに、文書の間の食い違いを推奨案で決めた。アーキテクチャの決定は変えていない。

- **テーブルの規則**：主キーは `id bigint`（IDENTITY）、外部キーは `<単数形>_id`、リポジトリは必ず `repo_id`。`repositories`・`repository_networks`・`storage_nodes` の主キーも `id` にし、複製の表のノードの列は `storage_node_id` にした（GraphQL の `node_id` と紛れないため）。`node_id` は列に持たず読み取りのときに計算する。列挙は `text` と `CHECK`、SHA は `bytea`。S3 で複数のリージョンが採番するときは、IDENTITY の範囲をリージョンで分ける。
- **ユーザーと Organization の ID**：`owners.id` をそのまま使う。App の bot と ghost も `owners` に行を持つ（リポジトリは持てない）。
- **ref の更新の Event の名前**：`repository.refs_updated` にそろえた（ADR-0006 の Decision と [git-protocols.md](git-protocols.md) の形）。[git-storage.md](git-storage.md) と [roadmap.md](../roadmap.md) の `refs.updated` を直し、ADR-0006 に注記した。
- **複製のチェックサムのファイル**：`spokes/checksum` を `gitd/checksum` にした（本家の内部の名前を使わない。リポジトリ共通の ADR-0006 の趣旨）。
- **Issue の削除**：[ADR-0030](../decisions/0030-data-retention-and-deletion.md) のとおり論理削除と日次の消去にした。[issues.md](issues.md) の「物理削除」を直した。
- **PR の base のリポジトリ**：列は `repo_id` だけにした（`base_repo_id` は持たない。API の `base.repo`）。マージ可能かのキャッシュのキーは `network_id`。
- **ネットワークの単位の表**（`network_replicas`、`pull_request_merge_states`、`commit_verifications`、`lfs_objects`）は `repo_id` を持てないので、リポジトリの `can()` を通った後にだけ読むシステムの表として扱う。
- **足りなかったテーブルを最小の形で定めた**：`accounts`（Better Auth のパスワード）、`ssh_auth_fingerprints`、`owner_redirects`、`enterprises`・`enterprise_memberships`（E10）、`repository_stats`・`repository_topics`・`stars`、`issue_comments`、`notification_threads`・`email_suppressions`・`inbound_email_receipts`、`check_suites`・`check_runs`・`commit_statuses`、`merge_queues`（単一ライターのリース）、`releases`・`release_assets`、`repository_bundles`・`repository_backups`・`network_maintenance`・`lfs_usage`、`actions_policies`・`actions_token_revocations`・`runner_registration_tokens`、`oauth_grants`、`code_index_nodes`、`deletion_records`・`legal_holds`。
- **保持の既定**：`push_events` は 5 週（バックアップの 35 日を覆う）、`ruleset_evaluations` は 180 日、`pull_request_events` は 90 日、`actions_usage` は 13 か月、`notification_deliveries` は 14 日、`deletion_records` は消去から 60 日。

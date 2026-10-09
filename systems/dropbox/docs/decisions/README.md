# Decisions: Dropbox

Dropbox の再構築に関する決定。リポジトリ共通の決定は [docs/decisions/](../../../../docs/decisions/README.md) にある（本家の名前・接頭辞を使わない規則は、その ADR-0006。本家の実装を核に使わない規則は、その ADR-0007）。領域ごとの設計と、領域ごとの ADR の番号の範囲は [architecture/](../architecture/README.md) の 7 節を見る。

<!-- adr-index:start -->
| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0001](0001-platform-and-stack.md) | 共通の基盤の上に、同期エンジン・分割・ブロックの索引・ジャーナルを自前で作る。クライアントの核は Rust の `sync-core` で、デスクトップ・モバイル・Web（WASM）が共有する。UI は TypeScript（Tauri）、OS の殻は Swift・Kotlin。検索に OpenSearch を足す | accepted |
| [0002](0002-chunking-and-block-addressing.md) | ファイルを内容で区切って分割し（最小 1 MiB・平均 4 MiB・最大 16 MiB、`chunker_version` で固定）、ブロックを SHA-256 で番地付けする。ファイルのハッシュはブロックの一覧から作る。最大 2 TiB、大きな一覧は S3 に置く | accepted |
| [0003](0003-dedupe-scope-and-privacy.md) | 重複排除はテナントの中だけ。「送らなくてよい」と答えるのは、要求した人が読める名前空間の参照にあるブロックだけで、それ以外は受け取ってから保存を重ねる | accepted |
| [0004](0004-tenancy-namespaces-and-rls.md) | 個人とチームをテナントにし、名前空間（利用者のルート、共有フォルダー、チームのフォルダー）を持ち主のテナントに置く。名前空間の表は `app.ns_ids` の RLS で絞り、権限は `can()` の 1 つの関数で判定する | accepted |
| [0005](0005-namespace-journal-and-cursors.md) | 名前空間ごとに単調な `ns_seq` と `ns_journal` を持ち、すべての書き込みを `packages/committer` で載せる。カーソルは載せた名前空間ごとの位置の組を署名した不透明な文字列で、90 日で取り直しを求める | accepted |
| [0006](0006-sync-conflict-model.md) | クライアントは Remote・Local・Synced の 3 つの木で計画し、サーバーは `base_rev` つきの条件の書き込みだけを受ける。衝突は中身が残るほうを選び、編集どうしは競合のコピー、削除と編集は編集を残す | accepted |
| [0007](0007-block-storage-layout-on-s3.md) | ブロックはテナントの接頭辞を持つ不変の S3 オブジェクトで、クライアントは署名つき URL で直接送る。SSE-KMS とバケットキー、バージョニング（削除から 30 日）、128 KiB 以上は Intelligent-Tiering、大阪へ CRR。GC は参照 0 から 7 日の猶予の後 | accepted |
| [0008](0008-node-identity-and-names.md) | ノードは UUIDv7 の ID で指し、親と名前を持つ。名前は NFC で持ち、一意は `name_key`（NFC＋case folding）で決める。OS で表せない名前は、サーバーの名前を変えずに端末で「同期できない名前」として示す | accepted |
<!-- adr-index:end -->

この一覧は、各 ADR の frontmatter と見出しから生成したもの。ADR を追加・更新したら生成し直す。

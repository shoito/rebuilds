---
status: accepted
date: 2026-09-27
---

# ADR-0005: メタデータは共有スキーマと FORCE RLS で組織を分け、ファイルは Router の割り当てで Document Server へ振り分ける

## Context

データは 2 種類に分かれる（[architecture/README.md](../architecture/README.md) の 1 節）。

- **メタデータ**：組織、チーム、プロジェクト、ファイルの一覧、権限、共有のリンク、コメント、バージョンの一覧。Aurora PostgreSQL に置く。
- **ファイルの中身**：ノードの木。Document Server のメモリ、ジャーナル、S3 に置く（[ADR-0003](0003-journal-and-checkpoints.md)）。

満たすべきことは次のとおり。

- 組織は、他の組織のデータを一切見られない（NFR-010）。一方で、ファイルは組織の外の人（ゲスト、リンクを知っている人）とも共有できる。
- 1 つのファイルの持ち主の Document Server は、いつも 1 つだけ（[ADR-0002](0002-central-authoritative-multiplayer.md)）。
- 規模が育ったら、メタデータを分割できる。

本家は、Postgres を縦に分けた（テーブルの群れごとに別の DB）後、横に分けた。シャードの鍵は UserID・FileID・OrgID の 3 つで、同じ鍵を持つテーブルの群れ（colo）の中では結合とトランザクションができる。まず論理的に分け（ビュー）、次に物理的に分けた。振り分けは Go で書いた DBProxy が SQL を解析して行う（[How Figma's databases team lived to tell the scale](https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/)、2024-03-14、2026-09-27 に確認）。ファイルと Document Server の対応をどう管理するかは、公開の記事で見つけられなかった（**未検証**）。

## Options

テナントの分け方：

1. **共有スキーマ＋FORCE RLS。テナントは組織（`org_id`）**
2. **組織ごとに DB を分ける（silo）**
3. **アプリのコードの `WHERE` だけで分ける**

ファイルの振り分け：

- a. **Router と割り当て**：ファイルごとの持ち主と世代の番号（`epoch`）を持ち、持ち主の生存を期限で確かめる
- b. **一貫性ハッシュ**：`file_id` のハッシュで持ち主を決める
- c. **Document Server を増やさず、1 台に全ファイル**

## Decision

1 と a を採用する。

### テナント

- **テナントは組織（`org_id`）。** 本家のチームだけのプラン（組織を持たない）でも、暗黙の組織を 1 つ作る。これで全テーブルのテナントの列を 1 つにできる。
- 全テナントテーブルに `org_id` を持たせ、`FORCE ROW LEVEL SECURITY` を設定する。トランザクションごとに `SET LOCAL app.org_id` を設定する（Slack の ADR-0009 に倣う）。
- **組織の外の人の利用**：ゲストやリンクを知っている人がファイルを開くときは、判定関数で権限を確かめた後、**ファイルを持つ組織の文脈**（その `org_id`）で読む。利用者の所属の組織の文脈では読まない。判定関数を 1 つにし、API・Gateway・Worker・書き出しが同じ関数（か、それが発行したチケット）を通る（[permissions-and-sharing.md](../architecture/permissions-and-sharing.md)、[ADR-0030](0030-single-policy-engine-and-signed-capabilities.md)）。
- **ファイルの中身の分離**：Aurora の RLS は、ファイルの中身（S3・ジャーナル）に効かない。中身を読む経路は、次のどれかに限る。
  - Document Server（接続時に Gateway が判定関数で確かめる）
  - Worker（ジョブを作るときに判定関数で確かめ、ジョブに `org_id` と `file_id` を入れる）
  - 利用者のブラウザは、S3 を直接読まない。チェックポイントのチャンクと画像は、判定の後に発行する短い期限の署名付き URL で、CloudFront から読む（[ADR-0025](0025-content-addressed-checkpoints-and-loading.md)、[ADR-0035](0035-content-addressed-images.md)）。
- 2 を採らない理由：組織の数（S1 で数万）に対して運用が重い。大口の組織の分離は、段階 S3 のセル構成で行う。
- 3 を採らない理由：1 つの `WHERE` の書き忘れが、他の組織のデータの漏洩になる。

### ファイルの振り分け

- **Router**：持ち主の記録を 2 つに分けて持つ（[ADR-0047](0047-router-task-liveness-and-file-assignment.md)）。正本は DynamoDB の条件付きの書き込み（ジャーナルと同じ基盤）に置き、Valkey に読み取りのキャッシュ（30 秒）を置く。
  - **タスクの生存**（`ds_liveness`）：Document Server のタスクごとに 1 項目。タスクが自分で 2 秒ごとに延ばし、期限は 10 秒。ファイルごとのリースは延ばさない。
  - **ファイルの割り当て**（`file_leases`）：ファイルごとに `(state, owner_task, owner_incarnation, epoch)`。割り当てと手放し（`released`・`handoff`）と削除（`deleted`）のときだけ書く。
- 持ち主が有効なのは、割り当てが `owned` で、持ち主のタスクの生存の項目が期限の内にあるときだけ。Document Server は、生存を 8 秒延ばせなければ、自分から全ファイルを手放す。
- 持ち主のタスクが落ちると、生存の期限（10 秒）と時計のずれの猶予（2 秒）の後に、Router が別の Document Server に `epoch` を 1 つ上げて割り当てる（NFR-007 の 15 秒以内）。誰も開かないファイルは、回復のジョブが拾う。
- 割り当てだけでは、時計のずれや停止で、古い持ち主が期限の後も書こうとしうる。新しい持ち主が `epoch` で上げるジャーナルのフェンスと、フェンスの `epoch` と `seq` を条件にした書き込み（[ADR-0003](0003-journal-and-checkpoints.md)、[ADR-0024](0024-journal-items-and-fencing.md)）が、最後の防御になる。
- 割り当ては、Document Server の負荷（開いたファイルのメモリ、接続の数）を見て選ぶ。大きなファイルは、メモリに余裕のあるタスク（`ds-large`）へ置く（[ADR-0051](0051-document-server-memory-admission.md)）。
- b を採らない理由：Document Server の増減でファイルが一斉に移り、開いていたファイルの読み直しが集中する。ファイルごとのメモリの大きさの差（数 KB〜数 GB）を、ハッシュでは均せない。
- c は S1 の同時に開いたファイル（1 万）を 1 台で持てない。

### メタデータの分割（S2・S3）

- S2：縦に分ける。コメント・通知・バージョンの一覧など、書き込みの多い群れを別のクラスタへ移す。
- S3：横に分ける。シャードの鍵は、本家に倣い `org_id`（組織の中のメタデータ）と `file_id`（コメント、バージョン）を候補にする。同じ鍵のテーブルの群れの中だけで結合とトランザクションを行う規則を、S1 から守る（1 つのトランザクションで、別の組織の行を書かない）。
- 振り分けの仕組み（アプリの中のルーターか、本家の DBProxy のような中継か）は、S2 の前の ADR で決める（[infrastructure.md](../architecture/infrastructure.md) の 9 節）。rebuilds の Notion は、アプリの中のルーターを選んだ（[Notion の ADR-0027](../../../notion/docs/decisions/0027-shard-router.md)）。

## Consequences

- 良くなること：
  - 組織の分離を、アプリのコードだけに頼らない。
  - ファイルの持ち主が 1 つであることを、割り当ての `epoch` とジャーナルのフェンスの二重で守る。
  - シャードの鍵の規則を S1 から守るので、段階 S3 で横に分けやすい。
- 引き受けるコスト：
  - 組織の外の人の利用では、「ファイルを持つ組織の文脈で読む」経路が要る。判定関数を通らない経路が漏洩になるので、経路の一覧と漏洩のテストを permissions-and-sharing.md と quality.md で持つ。
  - Router の正本（DynamoDB）が止まると、新しくファイルを開けない。開いているファイルは、タスクの生存を延ばせる間は続く。

## Confirmation

- 性質ベーステスト：任意の 2 組織で、一方の文脈で他方の行が読めない。
- 結合テスト：共有していない組織の外の人が、ファイルの中身・サムネイル・画像の署名付き URL を得られない。
- 障害注入のテスト：Document Server を止め、別のタスクへの割り当てと、古い持ち主の書き込みの失敗（フェンス）を確かめる。
- lint：1 つのトランザクションで、複数の `org_id` の行を書くコードを検出する。

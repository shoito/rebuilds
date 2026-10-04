---
status: accepted
date: 2026-09-27
---

# ADR-0053: クライアントとサーバーのバージョンは、送受信の形式のバージョン・スキーマの互換の一覧・最低のビルドの 3 つで照合する。再読み込みは、穏やかなものと強いものを分ける

## Context

エンジン（WASM）はブラウザのタブに何時間も残る。サーバー（Document Server、Render Worker、file-read）は日に何度もデプロイする。両方が同じ `doc-model` のコードで変更を当てる（[ADR-0001](0001-platform-and-stack.md)）ので、バージョンが違うと結果が食い違いうる。

- 今の設計は、接続時に `schema_hash` を比べ、違えば `Kick(version_mismatch)` で再読み込みさせる（[document-model.md](../architecture/document-model.md) の 8.4 節、[multiplayer.md](../architecture/multiplayer.md) の 4.3 節）。このままでは、プロパティを 1 つ足すたびに、全員のタブが再読み込みになる。
- 一方、プロパティの追加は互換を保つ形で決めてある（サーバーを先に出す、知らない `prop_id` は長さで読み飛ばして保つ。document-model.md の 8.4 節）。
- 送受信の形式（メッセージの種類と中身。[ADR-0009](0009-multiplayer-wire-protocol.md)）を変える必要も出る。
- 変更の適用の規則そのもの（検証、LWW、レイアウトの計算の規則。[ADR-0020](0020-deterministic-layout-arithmetic.md)）を変えると、同じ変更の結果が変わる。
- 再読み込みは、確定していない変更があれば失いうる（[multiplayer.md](../architecture/multiplayer.md) の 7.2 節）。

## Options

1. **3 つのバージョンで照合する：送受信の形式のバージョン（`protocol_version`）、スキーマの互換の一覧（`schema_hash` の許可の一覧）、最低のビルド（`min_client_build`）**
2. **今のとおり `schema_hash` の一致だけ**
3. **バージョンを照合せず、互換を保つ変更だけを許す**

## Decision

1 を採用する。詳細は [delivery.md](../architecture/delivery.md) の 4 節。

- **`protocol_version`（u16）**：送受信の形式のバージョン。サーバーは、今のバージョンと 1 つ前のバージョンの両方を話す。形式を変えるときは、サーバーを先に出して 2 つを話せるようにし、クライアントを出し、古いバージョンの接続が 1% を切ってから古いバージョンを外す。
- **スキーマの互換の一覧**：
  - `schema_hash` は、プロパティの表のバージョンごとの値。開発リポジトリは、各リリースの `schema_hash` と、その前のバージョンからの差分の種類（追加だけか、それ以外か）を記録する。
  - サーバーは、「今の表から追加だけでたどれる過去の `schema_hash`」のうち、直近 30 日の分を受け入れる。古いクライアントは、新しいプロパティを送れないだけで、受け取った知らない `prop_id` は長さで読み飛ばして保つ。
  - 追加以外（型の変更、消す、`format_version` を上げる）の変更は、互換の一覧を切る。切ったら、それより前の `schema_hash` のクライアントは強い再読み込み。
- **新しいプロパティの書き込みはフラグの後ろに置く。** 表に足しただけでは、クライアントはそのプロパティを書かない。`schema.<prop>.write` のフラグを、アクティブな接続の 95% 以上が新しい `schema_hash` になってから有効にする。古いクライアントの画面では、新しいプロパティの効果が見えない（描かない）ので、その差を短くするため。
- **`min_client_build`**：適用の規則の不具合など、古いビルドを使わせたくないときに、AppConfig で上げる。これより古いクライアントは強い再読み込み。
- **適用の規則を変える変更**（結果が変わるもの）は、ファイルの中で全員が同じ規則を使うよう、Document Server がファイルごとにフラグを評価し、`Welcome` の `features` で配る（[ADR-0055](0055-staged-rollout-and-schema-changes.md)）。
- **再読み込みの 2 つの強さ**：
  | 強さ | きっかけ | 動き |
  | --- | --- | --- |
  | 穏やか | 新しいビルドがある、互換の一覧の期限が 7 日以内 | 帯で知らせる。`pending` が 0 で 5 分操作がなければ、自動で読み込み直す。次にファイルを開くときは新しいビルドで開く |
  | 強い | `protocol_version` が話せない、互換の一覧の外、`min_client_build` より古い | `Kick(version_mismatch, retry_after_ms)`。`retry_after_ms` を 0〜5 分に散らす。クライアントは `pending` を送れるなら送り切ってから（サーバーが受けないなら捨てて件数を出して）読み込み直す |
- 2 を採らない理由：プロパティの追加のたびに全員が再読み込みになり、デプロイの頻度が下がる。
- 3 を採らない理由：互換を壊す変更（形式の変更、規則の修正）の出口がない。

## Consequences

- 良くなること：
  - 追加だけのスキーマの変更では、再読み込みが要らない。
  - 強い再読み込みの殺到を、散らして避けられる。
- 引き受けるコスト：
  - [document-model.md](../architecture/document-model.md) の 8.4 節と [multiplayer.md](../architecture/multiplayer.md) の 4.3 節の「違えば再読み込み」を、この ADR の規則に読み替える（統合の工程で書き換える）。
  - サーバーは、2 つの `protocol_version` と、30 日分のスキーマの互換を持つ。
  - スキーマの履歴を開発リポジトリで管理する CI が要る。

## Confirmation

- CI：`schema/properties.toml` の変更を分類し（追加だけか）、追加でない変更を含む PR に `schema-breaking` のラベルと Dev のテックリードの承認を求める。
- 結合テスト：1 つ前の `schema_hash` のクライアントが、新しいプロパティを含む `Committed` を受け、そのプロパティを保ったまま自分の変更を送れる。
- 結合テスト：`protocol_version` が 2 つ前のクライアントは、強い再読み込みになる。

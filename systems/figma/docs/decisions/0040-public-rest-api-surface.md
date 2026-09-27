---
status: accepted
date: 2026-09-27
---

# ADR-0040: 公開 API は別のサービスにし、利用者の権限とスコープの積で動かす。ファイルの中身は Rust の読み取り専用のサービスが返し、中身の書き込みは出さない。トークンは PKCE 必須の OAuth 2.1 と期限必須の個人のトークン

## Context

公開の REST API は MVP の後に出す（[intent.md](../intent.md)）。開発の道具・CI・他社の製品が、デザインの中身と画像を読み、コメントを読み書きする。

本家の形（いずれも 2026-09-27 に確認）：

- ファイル・ノード・画像（描画）・画像の塗り・コメント・版・プロジェクト・Webhook などのリソース。中身の書き込みはない（[File endpoints](https://developers.figma.com/docs/rest-api/file-endpoints/)）。
- 認証は OAuth のアプリ（推奨）、組織のトークン（Organization・Enterprise、期限は最大 1 年、資源の許可リスト）、個人のアクセストークン（[Authentication](https://developers.figma.com/docs/rest-api/authentication/)）。
- OAuth は認可コードだけで、PKCE（S256）は任意。認可コードは 30 秒で切れ、アクセストークンは既定で 90 日。アプリは下書き・private（審査なし）・public（審査あり）（[OAuth apps](https://developers.figma.com/docs/rest-api/oauth-apps/)）。
- スコープは細かく分かれ、権限を広げない。利用者が読めるファイルだけを読める（[Scopes](https://developers.figma.com/docs/rest-api/scopes/)）。

この設計の条件：

- ファイルの中身は Aurora になく、チェックポイントとジャーナル（[ADR-0003](0003-journal-and-checkpoints.md)）にある。解釈には `doc-model`（Rust）が要る。
- 中身の変更は、Document Server が順序を決める（[ADR-0002](0002-central-authoritative-multiplayer.md)）。
- 公開 API の負荷が、編集（NFR-001）とメタデータの API に響かないこと。

## Options

面：

1. **別のサービス（`api.<domain>`）で、内部と同じサービス関数と判定関数を通る**（Slack の [ADR-0030](../../../slack/docs/decisions/0030-versioned-public-api.md) と同じ）
2. **内部の API をそのまま公開する**

ファイルの中身の読み方：

- a. **Rust の読み取り専用のサービス（file-read）が、チェックポイントとジャーナルから作る**
- b. **Document Server に問い合わせる**
- c. **API（TypeScript）の中で WASM の `doc-model` を動かす**

中身の書き込み：

- x. **出さない**（本家と同じ）
- y. **REST で `ChangeSet` を受け、Document Server へ送る**

トークン：

- p. **OAuth 2.1（PKCE 必須、アクセス 1 時間、リフレッシュの入れ替え）＋期限必須の個人のトークン**
- q. **本家と同じ期限（アクセス 90 日、PKCE 任意）**

## Decision

1・a・x・p を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 1〜4 節。

- **別のサービスにする。** Bearer トークンだけを受け、Cookie・CORS を許さない。ops フラグで公開 API だけを止められる。2 は、内部の変更のたびに外部の互換を考えることになる。
- **権限は、トークンの利用者の権限とスコープの積。** すべてのハンドラーが判定関数を通る（[ADR-0005](0005-tenancy-and-document-routing.md)）。スコープは本家の細かい区分に寄せ、広い `files:read` は持たない。
- **ファイルの中身は file-read（Rust）が返す。** チェックポイントとジャーナルから要求の時点の最新の `seq` まで作り、プロパティの表から生成した変換で JSON にする（[ADR-0042](0042-api-versioning-and-rate-limits.md)）。Render Worker と同じ読み方で、Document Server に問い合わせない。
  - b を採らない理由：持ち主の Document Server の負荷を、外部の呼び出しが増やす。大きなファイルの全体の直列化が、編集の遅延に響く。
  - c を採らない理由：API のサービスのメモリに、大きなファイルを WASM で抱えることになる。TypeScript のサービスの負荷の性質（多数の小さな要求）と合わない。
- **中身の書き込みは出さない。** 中身の変更はプラグイン（[ADR-0038](0038-plugin-api-and-capabilities.md)）で行う。y は、外部からの大量の変更が Document Server の順序づけに入り、ファイルを開いている人の体験に響く。検証・Undo・競合の扱いも外部の利用者に説明しにくい。需要が強ければ別の ADR で扱う。
- **トークン**：
  - OAuth 2.1：認可コード＋PKCE（S256）必須、`redirect_uri` の完全一致、コード 30 秒、アクセストークン 1 時間、リフレッシュトークン 90 日で使うたびに入れ替え、再利用を検出したら系列を失効。アプリの状態は本家と同じ 3 つ（下書き・private・public。public だけ審査）。
  - 個人のアクセストークン：期限必須で最大 1 年（既定 90 日）、スコープ必須。
  - 組織のトークン：後の Story。
  - 接頭辞は `<brand>pat_` など、チェックサム付き（リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md)）。
  - q を採らない理由：90 日のアクセストークンは、漏れたときの影響が長い。PKCE を任意にすると、公開のクライアントでの横取りを防げない。

## Consequences

- 良くなること：
  - 公開 API の負荷と障害が、編集と内部の API に響かない。
  - 利用者が読めないものを、API でも読めない。
  - トークンの漏れの影響が小さい。
- 引き受けるコスト：
  - file-read という Rust のサービスが 1 つ増える。
  - アプリの開発者は、1 時間ごとにリフレッシュを実装する必要がある（本家からの移行では手間が増える）。
  - 中身を書き換える自動化は、プラグインでしかできない。

## Confirmation

- 性質ベーステスト：任意の利用者・ファイル・共有の設定で、API で読めるファイルの集合が、判定関数が真の集合と一致する。
- 表駆動のテスト：全ルート × 全スコープで、スコープにない操作は 403。
- 結合テスト：PKCE なし・違う `code_verifier`・期限切れのコード・2 回目の交換・一致しない `redirect_uri` を拒否する。リフレッシュトークンの再利用で系列が失効する。
- 結合テスト：file-read が Document Server に接続しない（ネットワークの経路で確かめる）。

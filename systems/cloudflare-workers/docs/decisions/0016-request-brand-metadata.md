---
status: accepted
date: 2026-09-27
---

# ADR-0016: 要求の属性は `request.<brand>` に置き、S1 で正しく出せる欄だけを埋める

詳細は [web-apis-and-compat.md](../architecture/web-apis-and-compat.md) の 5 節。

## Context

本家は、入ってくる要求に `request.cf` の属性（AS、国・都市・緯度経度、処理した拠点 `colo`、TLS の版と暗号、ClientHello の指紋、利用者との TCP の往復 `clientTcpRtt` など）を付ける（[Request](https://developers.cloudflare.com/workers/runtime-apis/request/)、2026-09-27 に確認）。上流のモジュールの名前空間も `cloudflare:workers` などの本家の名前である。

リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) は、本家の名前を識別子に使わず、`<brand>` で書くと決めた。

S1 の入口は、Global Accelerator の edge で TCP を受け、エッジのノードで TLS と HTTP を終端する（[ADR-0003](0003-edge-locations.md)）。利用者の IP は保たれるが、利用者との TCP の往復はノードから見えない。

## Options

1. **`request.<brand>` に本家と同じ形の欄を置き、S1 で正しく出せる欄だけを埋める。出せない欄は `undefined`・`null`。`request.cf` の別名を置かない**
2. **`request.cf` をそのまま使う**（移行のしやすさを優先）
3. **欄をすべて埋める**（`clientTcpRtt` はノードで測った値を入れる）

## Decision

1 を採用する。

- 名前は `request.<brand>`、型は `IncomingRequest<Brand>Properties`。モジュールの名前空間も `<brand>:workers` などに置き換える。置き換えは `brand` の分類のパッチで行う。
- 埋める欄：`asn`・`asOrganization`、位置の欄（`country`・`continent`・`isEUCountry`・`region`・`regionCode`・`city`・`postalCode`・`latitude`・`longitude`・`timezone`）、`colo`（リージョンの 3 文字の記号。東京 `NRT`、大阪 `KIX` など）、`httpProtocol`、`tlsVersion`・`tlsCipher`、ClientHello の欄（`tlsClientHelloLength`・`tlsClientCiphersSha1`・`tlsClientExtensionsSha1`・`tlsClientExtensionsSha1Le`・`tlsClientRandom`）、`clientAcceptEncoding`。
- `undefined`：`clientTcpRtt`・`clientQuicRtt`・`edgeL4`・`hostMetadata`。`null`：`metroCode`・`tlsClientAuth`・`requestPriority`・`botManagement`。
- 値は入口のプロキシが 1 か所で計算し、内部の経路でランタイムに渡す。利用者のヘッダーから作らない。同じ値を付けるヘッダー（`<Brand>-IPCountry` など）とも、この計算を共有する。
- 位置の表・AS の表はノードの手元に置き、週 1 回更新する。提供元は E4 の着手前に、ライセンスを確かめて選ぶ。
- 外へ出す要求の `<brand>` の欄（本家の `cf` のキャッシュの指示など）は S1 で持たず、未知の鍵として黙って無視する。
- 2 を採らない理由：リポジトリ共通の ADR-0006 に反する。
- 3 を採らない理由：ノードで測った往復は Global Accelerator の edge までの往復ではなく、edge とノードの間の往復で、利用者の往復とは違う。誤った値を出すより、ないことを示す方が安全。

## Consequences

- 良くなること：
  - 本家の欄の形に寄せつつ、名前の衝突と誤認を避ける。
  - 値の偽装（利用者のヘッダー）を防ぐ。
- 引き受けるコスト：
  - 本家のコードの `request.cf` は動かない。CLI の lint で警告する（developer-tooling）。
  - 位置の表・AS の表の費用とライセンス。
  - S3 で自前の PoP に移ると、`clientTcpRtt` などを埋められるようになる。そのとき欄の意味を変えずに埋める。

## Confirmation

- 結合テスト：合成の要求で各欄の値、利用者の `<Brand>-*` のヘッダーで上書きできないこと、`clientTcpRtt` が `undefined`。
- 本番の合成監視：発信の場所と `country`・`colo` が合う。
- レビュー：本家の名前（`cf`、`cloudflare:`）が、ランタイムの API の名前に残っていないことを、`brand` のパッチの CI で確かめる。

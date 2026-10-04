---
status: accepted
date: 2026-09-27
---

# ADR-0042: 公開 API のバージョンは URL の大きなバージョンにし、ノードの JSON はプロパティの表から生成して表の列で公開を決める。レート制限は操作の重さの tier と画素の予算で数える

## Context

公開 API（[ADR-0040](0040-public-rest-api-surface.md)）は、外部に互換を約束する。一方、ドキュメントのモデルはプロパティの表（[ADR-0006](0006-node-types-and-property-table.md)）で定義し、表からコードを生成する。プロパティは増え続ける。

- 表にプロパティを足すたびに、手で API の変換を書くと、書き忘れや食い違いが起きる。
- 表のすべてを自動で出すと、内部のプロパティ（`derived_layout` の書き込み、`plugin_data`）や、形の固まっていないプロパティまで外部に約束することになる。

本家は URL のバージョン（`/v1`、Webhook の `/v2`）を使う。レート制限は、操作の重さで 3 つの tier に分け、プランと席の種類で値を変え、OAuth のアプリは利用者×プラン×アプリで数える。429 に `Retry-After` を付ける（[Rate limits](https://developers.figma.com/docs/rest-api/rate-limits/)、2026-09-27 に確認）。

`/images` の描画は、1 回の呼び出しの重さが、ノードの数と画素で大きく変わる（[export-and-assets.md](../architecture/export-and-assets.md) の Render Worker）。

rebuilds の Slack は、URL の大きなバージョン、`Deprecation`・`Sunset` のヘッダー、Valkey のトークンバケットを使う（[Slack の ADR-0030](../../../slack/docs/decisions/0030-versioned-public-api.md)、[Slack の ADR-0029](../../../slack/docs/decisions/0029-rate-limiting.md)）。Notion は、日付のバージョンのヘッダーと変換の層を使う（[Notion の ADR-0024](../../../notion/docs/decisions/0024-integration-access-model.md)）。

## Options

バージョン：

1. **URL の大きなバージョン（`/v1`）。バージョンの中は追加だけ**
2. **日付のバージョンのヘッダーと変換の層**

ノードの JSON：

- a. **表に `public_api`・`api_name`・`api_since` の列を足し、真のものだけを生成で出す**
- b. **表のすべてを生成で出す**
- c. **手で書く**

レート制限：

- x. **tier ごとの回数と、`/images` の画素の予算**
- y. **tier ごとの回数だけ**（本家と同じ）

## Decision

1・a・x を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 4.1・5・7 節。

- **URL の大きなバージョン。** `/v1` の中は追加だけ。壊す変更は `/v2` として出し、古いバージョンを最低 12 か月動かす。廃止は `Deprecation`（RFC 9745）・`Sunset`（RFC 8594）とメールで告知する。本家と Slack の形に合わせる。2 は、多くのバージョンを 1 つのコードで保つ変換の層が要り、公開の初期の規模に合わない。
- **ノードの JSON は表から生成する。** `public_api` が真のプロパティだけを出し、鍵は `api_name`（`camelCase`）、出したバージョンを `api_since` に書く。`derived_layout` は読み取りの `absoluteBoundingBox`・`size` として出す。`plugin_data` は出さない。
  - CI で、参照ファイルの JSON の形のスナップショットを比べる。`public_api` のプロパティを消す・型を変える PR は、`/v2` の計画がなければ落とす。
  - b を採らない理由：内部のプロパティと形の固まらないプロパティを外部に約束してしまう。
  - c を採らない理由：表と API の食い違いと書き忘れが起きる。
- **レート制限**：
  - tier 1（ファイル・ノード・画像）、tier 2（コメント・バージョン・プロジェクト・Webhook・画像の塗り）、tier 3（メタデータ・利用者）。値はプランと席で変える。初期値は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 5 節。
  - 数える単位は本家と同じ（OAuth は利用者×アプリ、個人のトークンは利用者、組織のトークンはトークン）。プランは読むファイルを持つ組織のもの。
  - `/images` は回数に加え、画素の予算（利用者×アプリで 1 分 200 メガピクセル）で数える。y は、1 回で大量のノードを大きく描く呼び出しが、回数の制限をすり抜けて Render Worker を占める。
  - 組織ごとの合計の上限も持つ。
  - 超えたら 429、`Retry-After`、`RateLimit-Policy`・`RateLimit`、`X-<Brand>-Rate-Limit-Tier`。
  - 実装は Slack と同じ Valkey のトークンバケット。

## Consequences

- 良くなること：
  - プロパティを足しても、API が勝手に変わらない。公開する時期を選べる。
  - 表と API の食い違いが起きない。
  - 重い描画が、他の利用者の API と画面からの一括の書き出しを押しのけにくい。
- 引き受けるコスト：
  - 表の列が 3 つ増え、プロパティを公開するたびにレビューが要る。
  - `/v2` を出すときは、2 つのバージョンの生成の設定を並べて持つ。
  - 画素の予算は本家にない制限で、開発者に説明が要る。

## Confirmation

- CI：参照ファイルの JSON のスナップショットが、`/v1` の中で追加以外の変化をしない。
- 生成のテスト：`public_api` が偽のプロパティが JSON に出ない。
- 表駆動のテスト：tier の境界、画素の予算、組織の合計で 429 と正しいヘッダーを返す。
- 計測：バージョンごとの呼び出しの割合（古いバージョンを外す判断に使う）、tier ごとの 429 の数。

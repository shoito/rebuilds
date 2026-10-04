---
status: accepted
date: 2026-09-27
---

# ADR-0038: プラグインの API は動かした人の権限の中で動き、manifest で宣言した能力と通信先だけを許し、書き込みは通常の変更（ChangeSet）にする

## Context

[ADR-0037](0037-plugin-sandbox-quickjs-wasm.md) で、プラグインのコードは membrane の外に何も持たないと決めた。次に、membrane が何を許すかを決める。

- プラグインは、開いたファイルを読み、書く。書いた結果は、他の人の画面にもマルチプレイヤーで届き、同じ不変条件を守る必要がある（[ADR-0002](0002-central-authoritative-multiplayer.md)、[document-model.md](../architecture/document-model.md) の 4.4 節）。
- 開いたファイルの中身を外へ送ることは、読める以上は防げない。宣言させ、見せ、縛ることはできる。
- 本家の manifest は `networkAccess.allowedDomains`（`"*"` とローカルには `reasoning`）、`permissions`（`currentuser`・`activeusers` など）、`documentAccess: "dynamic-page"` を持つ。宛先の外への通信は CSP で止める（[Plugin Manifest](https://developers.figma.com/docs/plugins/manifest/)、[Making Network Requests](https://developers.figma.com/docs/plugins/making-network-requests/)、2026-09-27 に確認）。

## Options

1. **動かした人の権限の中で、いま開いたファイルだけ。能力と通信先は manifest で宣言させる**
2. **プラグインに独自の権限を与える**（ボットのように、共有されたファイルだけ）
3. **動かした人の権限のすべて**（他のファイル・組織の一覧・内部の API）

## Decision

1 を採用する。詳細は [plugins.md](../architecture/plugins.md) の 5〜8 節。

- **権限は、動かした人の役割と、いま開いたファイルに限る。** 閲覧だけの人が動かしたプラグインの書き込みは、`validate` の役割の検証で例外になる。他のファイル・チームのライブラリ・組織の一覧は、MVP の後の後に別の ADR で扱う。
- **書き込みは `ChangeSet` にし、利用者の手の変更と同じ経路・同じ検証を通す。** 1 回の同期の実行を 1 つの Undo の単位にする。`origin: plugin:{plugin_id}@{version_id}` の印を付け、バージョンの履歴に出す。送る速さは、確定を待つ量（32 MiB）で抑える。
- **manifest の `networkAccess` を必須にする。** `["none"]` を勧める。宛先は、UI の iframe の CSP と、ホストでの照合の二重で縛る。`"*"` とローカルの宛先には `reasoning` を求め、組織の管理者は `"*"` のプラグインを禁止できる。
- **利用者の情報は `permissions` で宣言したときだけ。** `currentUser` はメールアドレスを返さない。
- **保存は 2 つ。** `plugin_data`（ファイルのノードのプロパティ 90。自分の `PluginId` の要素だけ）と `clientStorage`（端末。`(user_id, plugin_id)` ごと 5 MiB）。
- **API の型は、プロパティの表（ADR-0006）の `public_plugin` の列から生成する。** 内部のプロパティと `derived_layout` の書き込みを出さない。API のバージョンは semver で、1.x の中は追加だけ。
- 2 を採らない理由：プラグインは、利用者がその場で選んで動かす道具で、利用者と別の主体として共有を管理させると使いにくい。ボットの形は公開 API の OAuth のアプリ（[ADR-0040](0040-public-rest-api-surface.md)）で扱う。
- 3 を採らない理由：1 つのプラグインが、利用者の読める組織全体のファイルを外へ送れるようになる。

## Consequences

- 良くなること：
  - プラグインの書き込みが、木の不変条件と権限を破らない。
  - 被害の範囲が、いま開いたファイルと、宣言した宛先に限られる。
  - 組織の管理者が、宛先の方針で統制できる。
- 引き受けるコスト：
  - 複数のファイルをまたぐプラグイン（一括の置き換えなど）は作れない。
  - 読める以上、宣言した宛先へ中身を送れることは防げない。審査と宣言の表示で補う。
  - `origin` の印を、ジャーナルと `ChangeSet` に足す必要がある（multiplayer.md・document-model.md への提案）。

## Confirmation

- 性質ベーステスト：任意の API の呼び出しの列で、プラグインの書き込みは `validate` を通った `ChangeSet` だけになる。閲覧だけの役割では文書が変わらない。
- 性質ベーステスト：任意の `PluginId` の組で、他のプラグインの `plugin_data` を読めない。
- 結合テスト：`["none"]` のプラグインが、サンドボックスの `fetch`・UI の iframe のどちらからも外部に送れない。
- 生成のテスト：`public_plugin` が偽のプロパティが、`.d.ts` と API の実装に出てこない。

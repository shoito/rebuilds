---
status: accepted
date: 2026-09-26
---

# ADR-0025: 拡張機能は Manifest V3 に互換とし、`chrome.*` を互換の別名として提供する

## Context

MVP に拡張機能と、そのストアを含める（[intent.md](../intent.md)）。どの拡張機能の形式に合わせるか、既存の拡張機能をどこまでそのまま動かすかを決める。

確かめたこと（2026-09-26）：

- 本家 Chrome の拡張機能は Manifest V3（MV3）で、背景の処理は service worker（30 秒の無操作、1 つのイベントが 5 分を超えたときに止める）、要求の遮断は `declarativeNetRequest`、パッケージの外のコードの実行を禁じる（[service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[declarativeNetRequest](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)、[Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)）。
- MV3 でも、企業のポリシーで入れた拡張機能には `webRequestBlocking` が残る（[Replace blocking web request listeners](https://developer.chrome.com/docs/extensions/develop/migrate/blocking-web-requests)）。
- W3C には、ブラウザ間で共通の拡張機能の API を目指す WebExtensions の Community Group（提案の場）と Working Group（仕様の場）がある（[w3c/webextensions](https://github.com/w3c/webextensions)）。Firefox・Safari は `browser.*` の名前空間を持ち、`chrome.*` も互換のために受け付ける。
- [リポジトリ共通の ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) は、本家の名前を識別子に使わないとし、互換の層が必要なら別の ADR で扱うとした。

## Options

1. **MV3 に互換。`browser.*` を正本にし、`chrome.*` を互換の別名にする**
2. **MV3 に互換。`chrome.*` だけを提供する**
3. **MV2 も含めて互換にする**（`webRequestBlocking` と永続する背景ページ）
4. **独自の拡張機能の API を作る**

## Decision

1 を採用する。詳細は [extensions.md](../architecture/extensions.md)。

- MV3 だけを読み込む。API の範囲は extensions.md の 1 節で、本家の上位の拡張機能が使う API から順に実装する。
- `browser.*` と `chrome.*` は同じオブジェクトを指す。`chrome.*` は、既存の拡張機能のコードを変えずに動かすための互換の名前であり、ADR-0006 の例外として認める（`chrome` は拡張機能の API の事実上の標準の名前で、他のブラウザも同じ名前を受け付けている）。製品の名前、スキーム（`<brand>-extension://`）、パッケージの形式の識別子、ポリシーの置き場所には本家の名前を使わない。
- 本家の上限・振る舞いに合わせる：service worker の寿命、DNR の上限、CSP、コンテンツスクリプトの isolated world、ホストの権限の実行時の制御。
- `webRequestBlocking` は、企業のポリシーで強制インストールした拡張機能に限る（本家と同じ）。
- WebExtensions の CG・WG の議論に参加し、本家と他のブラウザで振る舞いが分かれる点は、仕様の方向に合わせる。
- 3 を採らない理由：本家はすでに MV2 を終えており、MV2 の遮断の仕組みは、すべての要求で拡張機能を待つため、性能と安全（要求の中身が拡張機能に渡る）に不利である。
- 4 を採らない理由：既存の拡張機能の資産を使えず、開発者に作り直しを求めることになる。

## Consequences

- 良くなること：
  - 本家の拡張機能の多くを、コードを変えずに動かせる。開発者の文書・道具を流用できる。
  - DNR と service worker により、拡張機能が要求の中身を見ずに遮断でき、常駐しない。
- 悪くなること、引き受けるコスト：
  - 本家の API の細かな振る舞いを追い続ける必要がある。本家の変更（4 週ごと）を監視する。
  - MV2 の遮断に依存していた拡張機能（高度な広告の遮断など）は動かない。
  - `chrome.*` を持つことで、ADR-0006 の原則に例外ができる。例外は拡張機能の API の名前空間だけに限る。

## Confirmation

- 本家の上位の拡張機能（初期値 100 件）をストアの形式に取り込み、代表的な操作を自動で試験し、動いた割合を E7 から記録する。
- DNR の上限と、規則の評価の順序を、本家の文書の値と照らす表駆動のテストにする。
- 拡張機能のページで、外部のスクリプトの読み込みと `eval` が CSP で拒まれることをテストで確かめる。
- 設計のレビューで、`chrome` の名前が拡張機能の API の名前空間の外に使われていないことを確かめる。

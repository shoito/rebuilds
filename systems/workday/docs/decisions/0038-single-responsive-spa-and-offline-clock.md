---
status: accepted
date: 2026-09-28
---

# ADR-0038: 画面を 1 つのレスポンシブな SPA にし、打刻の画面だけをオフラインの待ち行列で持つ

詳細は [self-service-ui.md](../architecture/self-service-ui.md) の 3・4・7 節。

## Context

- 従業員とマネージャーは、PC とスマートフォンのブラウザの両方から使う。打刻・休暇の申請・受信箱の承認は、スマートフォンからが多い見込み（本システムの仮定。E5 の `ui-task-timing` の計測で確かめる）。
- 打刻は通信が落ちていても失ってはならない（NFR-004、[ADR-0021](0021-clock-events-corrections-and-objective-records.md)）。
- 画面・API・レポートの権限は同じでなければならない（[ADR-0005](0005-security-and-my-number.md)）。画面のための別の読み取りの経路は作らない。
- 日本語と英語を出す。法令の用語は誤訳で意味が変わる。
- [architecture/README.md](../architecture/README.md) の 4 節は「React の SPA と、一部をサーバーで描画（明細、帳票）」とし、決定をこの領域に残した。明細の PDF は確定のときに決定的に作ると決まった（[ADR-0036](0036-payslips-wage-ledger-and-e-delivery-consent.md)）。
- 本家は iPhone・iPad・Android のアプリを配り、給与の確認、休暇の申請、打刻、承認を扱う（[Workday Mobile](https://www.workday.com/en-us/products/platform-product-extensions/workday-mobile.html)、2026-09-28 に確認）。

## Options

画面の形：

1. **1 つのレスポンシブな React の SPA。打刻の画面だけを Service Worker と IndexedDB でオフラインに耐えさせる**
2. SPA に加え、打刻と承認のネイティブのアプリ（iOS・Android）を作る
3. サーバーで描画する画面（SSR・MPA）

文言：

- a. **ICU MessageFormat の辞書（日本語・英語）。法令の用語は英語の画面でも日本語を併記する**
- b. 日本語だけ

## Decision

1 と a を採用する。

- SPA は Vite でビルドし、S3＋CloudFront から配る。API は同じホスト名の `/api/*`。API の型は OpenAPI から生成したクライアントだけを使う。
- 打刻の画面は、Service Worker で資産を先に保存し、打刻を IndexedDB の `pending_clock_events` に書いてから送る。ログインの期限が切れても貯める。別の利用者がログインしたら、前の利用者の未送信の打刻を送らない。
- 他の画面の API の応答は端末に保存しない。
- 共有の端末の打刻は、個人のログインではなく打刻機の連携で扱う（[ADR-0044](0044-sso-api-clients-and-clock-terminals.md)）。
- 文言は `packages/i18n` の辞書に持ち、コードへの直書きを lint で禁じる。金額は `packages/money` の表示の関数で出す。
- 2 を採らない理由：2 つのストアの審査、版の配布、端末の鍵の保存が増える。打刻のオフラインは IndexedDB で足りる。承認と申請はブラウザで足りる。需要が出たら ADR で足す。
- 3 を採らない理由：打刻のオフラインを作れない。明細は保存した文書と PDF を出すので、サーバーでの描画の利点が小さい。
- b を採らない理由：外国籍の従業員とグループの海外の拠点の人事が使う。英語は MVP に含める（intent の MVP の範囲の外にある海外の給与とは別）。

## Consequences

- 良くなること：
  - 1 つのコードで全利用者の画面を持ち、権限の出し分けを 1 か所で行える。
  - 打刻を通信の断で失わない。
- 引き受けるコスト：
  - iOS の Safari の保存の期間に依存する。Safari は、サイトとの操作がないまま Safari を 7 日使うと、IndexedDB と Service Worker の登録・キャッシュを消す（ホーム画面に追加した Web アプリは別に数える。[WebKit の blog](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)、2026-09-28 に確認）。未送信の打刻は 72 時間より前に警告するので、7 日の上限の前に気づける。今の版の iOS での振る舞いは E6 の `ui-clock-offline` で実機で確かめる。未送信の件数を画面に出し、72 時間を超えたら警告する。
  - 英語の訳語の保守（法令の用語の一覧）を QA が持つ。
  - README の 4 節の「一部をサーバーで描画」を統合のときに直す。

## Confirmation

- 性質ベーステスト：PROP-UI-001（未送信の打刻が、元の利用者の雇用にだけ結ばれて届く）。
- E2E：通信を切って打刻し、戻して送られる。
- lint：コードへの文言の直書き、`localStorage`・IndexedDB への API の応答の保存を禁じる。
- CI：axe の自動検査で違反 0 件。

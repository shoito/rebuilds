---
status: accepted
date: 2026-09-26
---

# ADR-0009: デスクトップアプリを Electron で包む

## Context

MVP は、Web のクライアントを包んだデスクトップアプリ（macOS、Windows）を出す（[intent.md](../intent.md)）。包み方で、画面を描くエンジン、ローカルの保存、配布物の大きさ、試験の範囲が決まる。

本家のデスクトップアプリは、Electron で Web のアプリを包んでいると広く知られるが、公式の文書は見つからなかった（[3perf の分析](https://3perf.com/blog/notion/)などによる。未検証）。本家のデスクトップは、親のプロセス 1 つがネイティブの SQLite に書く（[How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)）。

Tauri は OS の WebView を使う。Windows は WebView2（Chromium）、macOS は WKWebView で、WebKit の版は OS の版に縛られる。Linux は WebKitGTK で、版はディストリビューションごとに違う（[Tauri の Webview Versions](https://v2.tauri.app/reference/webview-versions/)、2026-09-26 に確認）。

## Options

1. **Electron**（Chromium と Node.js を同梱）
2. **Tauri 2**（OS の WebView と Rust）
3. **デスクトップアプリを作らず、PWA のインストールで代える**

## Decision

1 を採用する。詳細は [editor.md](../architecture/editor.md) の 11 節にある。

- エディタは、IME・選択・`contenteditable` の振る舞いがエンジンごとに違う。Electron は Chromium を固定の版で同梱するので、試験したエンジンと利用者のエンジンが一致する。Tauri では、macOS の WKWebView の版が利用者の OS の版で変わり、Web で試験する範囲（Safari 17 以上）と同じ幅をデスクトップでも試験することになる。
- ローカルの保存（[ADR-0008](0008-sqlite-wasm-opfs-local-store.md)）の OPFS と SharedWorker は、Chromium で動作を確認済みの形をそのまま使える。
- 本家に寄せられる。本家と同じく、後からネイティブの SQLite に移す道も残る（Node.js の側で開く）。
- 2 は、配布物とメモリが小さい利点がある。上の理由で、エディタの品質の試験の幅が広がることを重く見た。
- 3 は、ディープリンク、OS の通知の細かい制御、自動更新、メニューの統合が弱い。PWA はモバイルの代わりとして Web で提供する。

## Consequences

- 良くなること：
  - 1 つの Chromium の版に対してだけ、デスクトップの試験を行えばよい。
  - Web のクライアントの成果物をそのまま使える。
- 引き受けるコスト：
  - 配布物が大きく（100MB 程度）、メモリも多く使う。
  - Chromium の脆弱性の修正に追随するため、Electron の新しいメジャーに出てから 8 週以内に上げる運用を持つ（[delivery.md](../architecture/delivery.md)）。
  - `contextIsolation`・`sandbox`・ナビゲーションの制限などの Electron に固有のセキュリティの設定を守り続ける。

## Confirmation

- CI：Electron の設定（`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`）を検査する。`preload` が出す API の一覧を、許可したものと比べる。
- Playwright の Electron のサポートで、主な E2E（ページの編集、オフライン、複数のウィンドウ）を実行する。
- Electron のサポート期間の切れた版で配布していないことを、リリースの手順で確かめる。

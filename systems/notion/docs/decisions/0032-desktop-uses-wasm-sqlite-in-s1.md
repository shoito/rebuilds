---
status: accepted
date: 2026-09-27
---

# ADR-0032: S1 のデスクトップも Web と同じ WASM の SQLite（OPFS）を使い、ネイティブの SQLite は S2 の候補にする

この ADR は、[ADR-0013](0013-offline-availability-policy.md) の保存の選択肢 B のうち「デスクトップはネイティブ」の部分だけを置き換える。ADR-0013 のほかの決定（オフラインの対象、理由ごとの記録、上限、鮮度の照合）は変えない。

## Context

設計の文書の間で、デスクトップのローカルの保存が食い違っていた。

- [ADR-0013](0013-offline-availability-policy.md)（accepted）は、保存を「SQLite。Web は WASM＋OPFS、デスクトップはネイティブ」とした。
- [ADR-0008](0008-sqlite-wasm-opfs-local-store.md)・[ADR-0009](0009-electron-desktop-shell.md)、[editor.md](../architecture/editor.md) の 11・17 節、[collaboration.md](../architecture/collaboration.md) の 11.2 節は、「MVP のデスクトップは Web と同じ WASM の SQLite（OPFS）」としていた。

本家のデスクトップは、親のプロセス 1 つがネイティブの SQLite に書く（[How we sped up Notion in the browser with WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)）。本家は、デスクトップの形を先に持ち、Web に WASM の SQLite を後から足した。この再構築は、Web を主のクライアントにし、デスクトップは Web を Electron で包む（ADR-0009）。

## Options

1. **S1 はデスクトップも WASM の SQLite（OPFS）。ネイティブの SQLite は S2 の候補にし、計測で決める**
2. S1 からデスクトップはネイティブの SQLite（Electron のメインのプロセスで開き、IPC でレンダラーへ出す）
3. Web もデスクトップも、最初から 2 つの実装を持ち、抽象の層で切り替える

## Decision

1 を採用する。

- S1 のデスクトップは、Web と同じ `opfs-sahpool` の実装（[editor.md](../architecture/editor.md) の 10 節）を使う。書くのは Web Locks で選んだ 1 つのウィンドウの専用ワーカーだけで、複数のウィンドウは Web の複数のタブと同じに扱う。
- 実装が 1 つなので、ローカルの保存・オフライン・タブ間の調整の試験は、Web の試験でデスクトップも覆える（Electron の Chromium でも同じ E2E を回す）。
- ネイティブの SQLite は S2 の候補にする。S1 の運用で、デスクトップの起動の時間、ページの表示（NFR-002 の 300ms）、書き込みの遅れ、メモリを計測し、WASM で目標を外すときに移す。移すときは新しい ADR を起票する。
- デスクトップのローカルの保存の暗号化は、ネイティブの SQLite に移すときに OS の資格情報の保管庫の鍵で行う（[security.md](../architecture/security.md) の 11 節）。S1 は Web と同じく独自の暗号化をしない。
- 2 は、本家に近いが、メインのプロセスと IPC の層、ネイティブのモジュールの配布（OS・CPU ごとのビルド）、別の試験を S1 から持つことになる。
- 3 は、使わない抽象と 2 つ目の実装を先に持つことになる。

## Consequences

- 良くなること：
  - クライアントのローカルの保存が 1 つの実装になり、Web とデスクトップで同じ不具合・同じ修正になる。
  - ADR-0013 と ADR-0008・0009・設計の文書の食い違いが消える。
- 引き受けるコスト：
  - デスクトップも OPFS の容量と WASM の SQLite の性能に縛られる。本家のデスクトップより遅い可能性がある。
  - デスクトップのファイルは Chromium のプロファイルの中の OPFS に置かれ、利用者が直接扱えない。

## Confirmation

- Playwright の Electron のサポートで、Web と同じオフライン・複数ウィンドウの E2E を通す（[quality.md](../quality.md)）。
- S1 の運用で、デスクトップの起動の時間、ページの表示、書き込みの遅れ、メモリを計測し、S2 の前に見直す（[roadmap.md](../roadmap.md) の「後回しにしたもの」）。

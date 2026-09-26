---
status: accepted
date: 2026-09-26
---

# ADR-0009: bfcache は、ページを同じプロセスに凍結して残し、凍結中に実行が要れば追い出す

## Context

戻る・進むは、本家のデスクトップのナビゲーションの約 1 割を占める（[web.dev](https://web.dev/articles/bfcache)）。ページ全体（JavaScript のヒープを含む）を残しておけば、戻る・進むを即座に表示でき、NFR-002（Core Web Vitals）に効く。

一方、残したページが凍結中に動いたり、残したプロセスが他のサイトの文書を受け入れたりすると、仕様の振る舞いや隔離を壊す。frame の実体と履歴の設計（[ADR-0008](0008-browser-driven-navigation-commit.md)）に影響するので、MVP で有効にしない場合でも、形を先に決める。

## Options

1. **ページを同じプロセスに凍結して残す。凍結中に JavaScript の実行が要る事態が起きたら、実行せずに追い出す。入れない条件を持つ**（本家と同じ）
2. **ページの状態を直列化して保存し、戻るときに作り直す**
3. **bfcache を持たない**

## Decision

> 2026-09-27 の注記：本家の保持の上限は、タブあたり 6 ページ（`kBackForwardCacheSize` の `cache_size` の既定）、10 分（`kDefaultTimeToLiveInBackForwardCacheInSeconds = 600`）である（[back_forward_cache_impl.cc](https://source.chromium.org/chromium/chromium/src/+/main:content/browser/back_forward_cache/back_forward_cache_impl.cc)、2026-09-27 に確認）。下の「6 ページは未検証」は解消した。

1 を採用する。詳細は [navigation-and-loading.md](../architecture/navigation-and-loading.md) の 6.3。

- 最上位のクロスドキュメントのナビゲーションで離れるとき、条件を満たすページの frame の木を丸ごと凍結する（`pagehide` の `persisted: true`、タイマー・Promise・読み込みの停止）。
- 凍結中のページのプロセスは、プロセスの鍵を保ったまま残す（[ADR-0007](0007-process-allocation-policy.md)）。
- 凍結中に実行が要る事態が起きたら追い出す。入れない条件（`unload` の処理器、opener、進行中の通信、`Cache-Control: no-store` など）は 1 か所で持ち、理由のコードを付け、`notRestoredReasons` で公開する。
- 保持はタブあたり 6 ページ、10 分を初期値とする（本家の既定に寄せる。6 ページは未検証）。メモリの圧迫で減らす。
- 骨格（frame の実体の状態としての「凍結中」）は E1 で作り、有効にするのは E3 とする。
- 2 は、JavaScript のヒープを直列化できず、実現できない。
- 3 は、実装は簡単だが、戻る・進むの体感の速さで本家に大きく劣る。

## Consequences

- 良くなること：
  - 戻る・進むで、ネットワークと描画をやり直さずに表示できる。
- 引き受けるコスト：
  - 凍結中のページがメモリとプロセスを持ち続ける。メモリの圧迫の対応と、上限の計算に組み込む必要がある。
  - 入れない条件と追い出しの規則を、Web の機能を足すたびに見直す必要がある（新しい API ごとの確認項目）。

## Confirmation

- Web Platform Tests の `html/browsers/browsing-the-web/back-forward-cache/` の合格率を追う。
- 性質のテスト：凍結中のページで、JavaScript のタスクが 1 つも実行されない。
- 指標：戻る・進むのうち復元できた割合と、理由の分布を、本家の公開値と比べる。

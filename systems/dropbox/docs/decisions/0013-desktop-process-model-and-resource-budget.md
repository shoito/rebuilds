---
status: accepted
date: 2026-10-09
---

# ADR-0013: デスクトップのクライアントは、`sync-core` を持つ 1 つの常駐のプロセス（Tauri のホスト）と、開いたときだけ作る UI の WebView と、macOS の File Provider の拡張（薄い中継）に分ける。核の判断はホストのプロセスだけが持つ。資源の予算（メモリー 300 MB の内訳、静かなときの起き方）を部品ごとに決め、リリースごとに測る

## Context

[ADR-0001](0001-platform-and-stack.md) は、核を Rust の `sync-core`、UI を TypeScript（Tauri）、macOS の File Provider の拡張を Swift の殻、Windows の Cloud Files API を Rust から呼ぶと決めた。プロセスの分け方は desktop-client の領域に残した。

- NFR-008：100 万ファイルの端末で、静かなときの CPU 1% 未満、メモリー 300 MB 以下。
- File Provider の拡張は OS が起動と終了を決める。メモリーの上限は厳しいとされるが、Apple の文書の本文で確かめられなかった（**未検証**）。
- 同期の判断が 2 つのプロセスにあると、DB の書き手が 2 つになり、意図の記録の順序（[ADR-0010](0010-local-state-db-and-intent-log.md)）が崩れる。
- 本家のプロセスの形は確かめなかった（**未検証**）。

## Options

1. **ホスト 1 つに `sync-core`。UI は開いたときだけ。File Provider の拡張は中継**
2. `sync-core` を File Provider の拡張の中で動かす（macOS）
3. 同期のデーモンと UI のアプリを別の常駐のプロセスにする（UI も常駐）

## Decision

1 を採用する。詳細は [desktop-client.md](../architecture/desktop-client.md) の 4・6 節。

- ホストのプロセス（Tauri、Rust）が、`sync-core`、Windows の殻、トレイ・メニューバー、資格、更新の確かめを持つ。ローカルの状態の DB の書き手はホストだけ。
- UI の WebView は窓を開いたときだけ作り、閉じたら捨てる。UI は計画・衝突・名前の比べを持たない（lint）。設定の変更はホストのコマンドを通す。
- macOS の File Provider の拡張は、OS の呼び出しを XPC でホストへ渡す中継だけを持つ。ホストが動いていなければ起動する。
- メモリーの予算：実行系 50、SQLite 64、計画 64、キャッシュ 32、転送 32、分割 16、余裕 42（MB）。転送はブロックの全体を溜めず、1 MiB ずつ流す。
- 静かなときに起きるのは、WebSocket の心拍（60 秒）、合図の後の差分、合図が使えないときの 60 秒ごとの確かめ、更新の確かめ（6 時間）だけ。
- 予算をリリースごとに測り、10% 以上悪くなったら止める。

### 他の案を選ばなかった理由

- **2（拡張の中）**：拡張の起動と終了を OS が決めるので、常駐の WebSocket と転送を持てない。メモリーの上限に 100 万ファイルの計画が収まらないおそれがある。Windows と形が分かれる。
- **3（UI も常駐）**：WebView の常駐で数十〜百 MB を使い、NFR-008 の予算を圧迫する。

## Consequences

- 良くなること：
  - DB の書き手が 1 つで、意図の記録の順序が守れる。
  - macOS と Windows で核の動きが同じ。
  - UI を閉じれば、資源は核だけになる。
- 引き受けるコスト：
  - macOS では、OS → 拡張 → ホストの中継の分だけ、取り出しの応答が遅れる。
  - ホストが止まると、File Provider の呼び出しに答えられない。拡張がホストを起動する。
  - 窓を開くたびに WebView を作る時間（1 秒前後）がかかる。

## Confirmation

- lint：UI と拡張のコードで、計画・衝突・名前の比べを禁止する（[ADR-0001](0001-platform-and-stack.md)）。
- 計測：PROP-DESK-001（100 万ファイル、静かな 1 時間の CPU とメモリー）を部品ごとの内訳つきでリリースごとに測る（[quality.md](../quality.md) の 2.2.1 節 J）。
- 実機の試験：ホストを止めた状態で、File Provider の取り出しがホストの起動で成功する（`placeholder-platform-survey` の後に場面を足す）。

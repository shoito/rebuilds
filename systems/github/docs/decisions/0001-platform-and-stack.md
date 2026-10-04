---
status: accepted
date: 2026-09-26
---

# ADR-0001: 基盤は他の題材を引き継ぎ、Git の層だけ Go と Git の本体で作る

## Context

rebuilds の他の題材（Slack・Stripe）では、次の基盤を決めている。

- AWS
- TypeScript（Hono＋Zod）
- Terraform、OpenTelemetry

GitHub には、それらにない処理がある。

- Git のパックファイルの生成
- 差分とマージの計算
- 長時間の大きな転送（clone）

これらは、Git の本体の実装に強く依存する。

## Options

1. **Web・API・Worker は TypeScript、Git のストレージとフロントエンドは Go と Git の本体**
2. **すべて TypeScript（Git の操作は `git` のコマンドを子プロセスで呼ぶ）**
3. **すべて Go**

## Decision

1 を採用する。

- Web・API・Worker は、他の題材と同じ TypeScript で作る。
- Git のストレージのサービス（RPC）と、SSH・HTTPS のフロントエンドは Go で作る。
  - Git の操作は、Git の本体（`git upload-pack`・`receive-pack`・`merge-tree` など）を呼ぶことを基本にする。
  - 性能が要る読み取り（ファイルの取得、ツリーの一覧）は、Go の Git のライブラリで行う。
- 本家の Spokes と、GitLab の Gitaly も、Git の層を独立したサービスにしている。
- 2 は、大量の子プロセスと長時間の転送のストリームの扱いが、Node.js の実行の形に合わない。
- 3 は、Web・API で他の題材の道具と型の共有を失う。

## Consequences

- 良くなること：
  - Git の本体の正しさと性能をそのまま使える。
  - Git の層を、アプリ層と独立してスケールできる。
- 引き受けるコスト：
  - 言語が 2 つになる。Git の層の RPC の契約（Protocol Buffers）を、両方の言語の型の正本にする。
  - Git の本体のバージョンの更新（脆弱性の修正を含む）を、ストレージのノードの全台に行き渡らせる運用が要る。

## Confirmation

- Git の層の RPC の契約を、`.proto` の 1 か所に置き、CI で両言語のコードを生成する。
- Git の本体のバージョンを CI で固定し、ノードごとのバージョンを監視する。

---
status: accepted
date: 2026-09-26
---

# ADR-0006: IPC は、型付きの IDL と、端点を権限として渡す形で自作する

## Context

複数プロセスの構成（[ADR-0003](0003-multi-process-site-isolation.md)）では、Browser と Renderer・GPU・Network サービスなどが、IPC で絶えずやり取りする。Renderer は侵害されている前提なので、IPC は攻撃面の中心になる。本家は Mojo（IDL の mojom、メッセージのパイプ、Remote / Receiver、ハンドルの受け渡し、受信時の検査）で、これを扱う（[Mojo](https://chromium.googlesource.com/chromium/src/+/main/mojo/README.md)、[Mojo のセキュリティの注意](https://chromium.googlesource.com/chromium/src/+/main/docs/security/mojo.md)）。

IPC の形は、後から変えると全プロセスのコードに及ぶので、最初に決める。ADR-0002 で、IPC は自作する側に入れた。

## Options

1. **本家の Mojo に寄せた形を Rust で自作する**：IDL からの Rust のコード生成、メッセージのパイプ、ハンドルの受け渡し、インターフェースの端点を権限として渡す、受信時の自動の検査
2. **本家の Mojo をそのまま使う**（C++ の実装を FFI で包む）
3. **汎用の直列化（serde と bincode など）と、Servo の ipc-channel のような型付きのチャンネル**
4. **gRPC・Protocol Buffers**

## Decision

1 を採用する。詳細は [process-model.md](../architecture/process-model.md) の 4 節。

- インターフェースは IDL で書き、Rust の型と送受信のコードを生成する。直列化・検査のコードを手で書かない。
- 受け取ったメッセージは、生成したコードで形（長さ、境界、列挙値、`null`、ハンドルの数）を検査してから実装に渡す。意味の検査（オリジンがプロセスの鍵に属するか）は、実装の入口で行う。どちらかに失敗したら、送り元の Renderer を終了させる。
- 意味を持つ値（`Origin`、`Url`、`FilePath`）には専用の型を使い、復号で値の正しさまで検査する。
- 権限は、インターフェースの端点として渡す。Renderer は、Browser が frame・Worker ごとに渡した端点の範囲のことしかできず、主体（オリジン）を引数で名乗らない。
- Browser と子のプロセスは同じビルドだけを組み合わせるので、IDL の版の互換は持たない。
- 2 は、Mojo が Chromium の `base` と C++ のビルドに深く結び付いており、ADR-0002 で自作とした構造の中心を C++ に委ねることになる。
- 3 は、手軽だが、インターフェースと権限の単位がなく、受信時の検査と「不正なメッセージで終了させる」規則を、各所で手で書くことになる。
- 4 は、OS のハンドル（ファイル、共有メモリ、パイプの端点）を送れない（Mojo の README が Protocol Buffers を採らない理由と同じ）。

## Consequences

- 良くなること：
  - 権限の範囲が、型と端点の有無で決まり、レビューで追いやすい。侵害された Renderer が、渡されていない権限を求める方法がない。
  - 検査のコードが生成されるので、抜けが起きにくい。生成した復号器を一律にファズにかけられる。
- 引き受けるコスト：
  - IDL の言語、コード生成、OS ごとの運び方（Unix ドメインソケット、Mach ポート、名前付きパイプ）を自分たちで作り、保守する。
  - 描画・入力の経路で、直列化の費用が性能に効きうる。E3 で測る。

## Confirmation

- IDL のファイルを変える PR には、IPC のセキュリティのレビューを必須にする（CODEOWNERS。本家の [IPC Reviews](https://chromium.googlesource.com/chromium/src/+/main/docs/security/ipc-reviews.md) と同じ）。
- 生成した全インターフェースの復号器を、ファズの対象に自動で加える。
- 侵害された Renderer を模すテスト（Renderer 側から任意のメッセージを送る試験用の仕組み）で、4.4 の検査の一覧の各項目が拒否され、プロセスが終了することを確かめる。
- IPC のメソッドの引数にオリジンを含むものは、lint で検出し、レビューで理由を確かめる。

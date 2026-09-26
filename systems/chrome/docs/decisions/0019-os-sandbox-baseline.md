---
status: accepted
date: 2026-09-26
---

# ADR-0019: OS ごとのサンドボックスを Rust で自作し、プロセスの種類ごとの基準を決める

## Context

ADR-0003 で、Renderer を OS のサンドボックスの中で動かすと決めた。OS ごとに使える仕組みが違い、どの部品で実装するか、どのプロセスをどの強さで閉じ込めるかを決める必要がある。

本家 Chromium は、次の仕組みを使う（出典は References）。

| OS | 仕組み |
| --- | --- |
| Windows | 制限したトークン（Renderer は整合性レベル untrusted）、ジョブ オブジェクト、別のデスクトップ、AppContainer（LPAC）、win32k の禁止などの緩和策。サンドボックスの中からのファイルへのアクセスは、NT の API の横取りで仲介する |
| macOS | Seatbelt（`sandbox(7)`）のプロファイル（SBPL）をプロセスの種類ごとに持ち、既定は拒否 |
| Linux | 名前空間（ユーザー・PID・ネットワーク）と setuid の補助、seccomp-bpf の 2 層 |

## Options

1. **本家の設計に寄せ、Rust で自作する。API の横取りは作らない**
2. **本家のサンドボックスのライブラリ（C++）を FFI で組み込む**
3. **OS のアプリのサンドボックス（App Sandbox、MSIX の AppContainer、Flatpak など）に任せる**

## Decision

1 を採用する。詳細は [sandbox-and-security.md](../architecture/sandbox-and-security.md) の 4 節。

- 仲介者（Browser）と対象（他のプロセス）の形にし、対象は初期化の後に、元に戻せない形で権限を落とす。
- プロセスの種類ごとの基準：Renderer と Utility は最も強く、Network・Storage サービスは中、GPU は弱い。Browser はサンドボックスなし。
- Windows の API の横取りは作らない。Renderer は最初からファイルを開かない設計にし、必要なものは IPC で受け取る。
- Stable で、サンドボックスなしの対象プロセスを動かさない。サンドボックスを外す引数は開発版と CI でだけ効く。
- 2 は、サンドボックスが、C++ のまま Browser プロセスとの境界に入り、ADR-0001 のメモリ安全性の方針と、ADR-0002 の「構造は自作」に反する。
- 3 は、ブラウザのように種類の違う多数のプロセスを、個別の強さで閉じ込められない。

## Consequences

- 良くなること：
  - サンドボックスの仲介の部分も、安全な Rust で書ける。
  - 横取りをしないため、OS の更新による壊れ方が少ない。
- 引き受けるコスト：
  - OS ごとの低い層の実装（トークン、seccomp の規則、SBPL）を自分たちで持ち、OS の更新に追従する。
  - 横取りがない分、部品（フォント、OS の API）がサンドボックスの中でファイルを開こうとする箇所を、個別に仲介する必要がある。

## Confirmation

- 各 OS の CI で、サンドボックスの脱出のテスト（ファイルの読み書き、ソケット、子プロセスの生成、禁止したシステムコール）を、プロセスの種類ごとに回す。
- リリースの前の検査で、Stable のビルドにサンドボックスを外す経路が無いことを確かめる。

## References

- Chromium: [Sandbox（Windows）](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/design/sandbox.md)
- Chromium: [Mac Sandbox](https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/mac/README.md)
- Chromium: [Linux Sandboxing](https://chromium.googlesource.com/chromium/src/+/HEAD/sandbox/linux/README.md)

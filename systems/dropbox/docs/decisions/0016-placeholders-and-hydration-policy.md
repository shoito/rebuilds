---
status: accepted
date: 2026-10-09
---

# ADR-0016: macOS は File Provider の replicated の拡張、Windows は Cloud Files API のプレースホルダーを使う。新しい端末の既定はオンラインのみ。取り出しはファイルの全体（部分の取り出しはしない）。「オフラインで使う」は固定で、OS の追い出しの対象にしない。本システムからは自動で追い出さない

## Context

[architecture/README.md](../architecture/README.md) の 6 節は、オンラインのみのファイルを OS の仕組み（macOS の File Provider、Windows の Cloud Files API）に従って作り、カーネルの拡張は作らないと決め、詳細を file-system-integration の領域の ADR に残した。

- Windows の Cloud Files API は、プレースホルダー・完全なファイル（OS が中身を捨てうる）・固定した完全なファイル（オフラインで使える保証）の 3 つの状態を持つ。取り出しの方針は、アプリとエンジンの方針の大きいほうになる。中核のフィルターは NTFS だけ（[Build a Cloud Sync Engine](https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine)、2026-10-09 に確認）。
- 本家は File Provider を使うバージョンに macOS 12.5 以降を求める（[Dropbox on File Provider](https://help.dropbox.com/installs/dropbox-for-macos-support)、同日に確認）。File Provider の API の詳細は、Apple の文書の本文を取得できず**未検証**。
- 中身はブロックで持ち、ファイルのハッシュはブロックの一覧から確かめる（[ADR-0002](0002-chunking-and-block-addressing.md)）。

## Options

既定：

1. **新しい端末ではオンラインのみ。利用者が「オフラインで使う」を選ぶ**
2. 既定ですべて取り出す

取り出し：

- a. **ファイルの全体を取り出してから渡す**
- b. 求められた範囲だけを取り出す（部分の取り出し）

追い出し：

- x. **本システムからは自動で追い出さない。OS と利用者の操作だけ**
- y. 一定の日数開かれないファイルを自動で追い出す

## Decision

1・a・x を採用する。詳細は [file-system-integration.md](../architecture/file-system-integration.md) の 6 節。

- 状態は `online_only`・`hydrating`・`local`・`pinned`。Windows ではプレースホルダー・完全なファイル・固定した完全なファイルに当てる。
- 手元のフォルダーを持つ端末から移るときは、手元の中身を `local` として扱い、ハッシュで結び付けて送らずに済ませる。
- 取り出しは、block-storage の領域の組み立てで一時のファイルを作り、`content_sha256` を確かめてから OS に渡す。Windows はエンジンの方針を全体にする。
- オフラインの取り出しは、すぐに失敗を返す。
- 手元で変えてまだ上げていないファイルの追い出しを拒む。
- macOS の最低のバージョンは 13。

### 他の案を選ばなかった理由

- **2（すべて取り出す）**：数百 GB のチームのフォルダーで、新しい端末のディスクと回線を使い切る。
- **b（部分）**：ファイルのハッシュを確かめずに中身を渡すことになる。ブロックの境界（内容で区切る）とアプリの読む範囲が合わず、効果が小さい。動画などで要るかは MVP の後に測る。
- **y（自動の追い出し）**：開かれないが要るファイル（オフラインで使う予定）を利用者の知らないうちに消す。OS の空き容量の追い出しで足りる。

## Consequences

- 良くなること：
  - 新しい端末の最初の同期が、木のメタデータだけで済む。
  - 渡す中身は必ずハッシュで確かめてある。
- 引き受けるコスト：
  - 大きなファイルを開くとき、全体を受けるまで待つ。
  - オフラインのときに開けないファイルが増える。利用者に「オフラインで使う」を知らせる。
  - macOS の振る舞いは `placeholder-platform-survey` で確かめる。

## Confirmation

- 実機の試験：6.1 節の状態の遷移、取り出しの途中の切断と再開、空き容量の不足での OS の追い出し、未送信の変更の追い出しの拒否（[quality.md](../quality.md) の 2.2.1 節 B の「プレースホルダー」）。
- 結合テスト：ハッシュの合わない組み立ては OS に渡さず、`online_only` に戻る。

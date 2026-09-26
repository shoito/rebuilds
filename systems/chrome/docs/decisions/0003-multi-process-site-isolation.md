---
status: accepted
date: 2026-09-26
---

# ADR-0003: 複数プロセスとサイトの隔離を、最初から前提にする

## Context

本家 Chrome は、Web のコンテンツを扱う Renderer をサンドボックスの中で動かし、2018 年の Spectre への対策として、サイトごとにプロセスを分ける（Site Isolation）。Renderer の侵害を前提にして、被害を 1 つのサイトに閉じ込める考え方である。

## Options

1. **最初から、サイトごとのプロセスとサンドボックスを前提にする**
2. **最初は 1 プロセスで作り、後から分ける**

## Decision

1 を採用する。詳細は [process-model.md](../architecture/process-model.md) と [sandbox-and-security.md](../architecture/sandbox-and-security.md) にある。

- Renderer は、サイト（スキーム＋登録可能ドメイン）ごとに分ける。異なるサイトの iframe は、別のプロセスで描画する（Out-of-Process iframe）。
- Renderer は OS のサンドボックスの中で動かし、ファイル・ネットワーク・デバイスへ直接触れない。必要なものは IPC で Browser やサービスに頼む。
- Browser プロセスは、Renderer からの要求を、そのプロセスに割り当てたサイトで検査する（Renderer を信用しない）。
- 2 は、後から分けるときに、プロセスの境界をまたぐ前提のない設計（共有メモリの前提、同期的な呼び出し）を作り直すことになる。

## Consequences

- 良くなること：
  - Renderer の侵害や Spectre の類の攻撃で、他のサイトのデータが読まれにくい。
- 引き受けるコスト：
  - プロセスの数が増え、メモリが増える。プロセスの上限と共有の方針（同じサイトのタブをまとめる）で抑える。
  - IPC の設計と、クロスプロセスの iframe の描画・入力の処理が複雑になる。

## Confirmation

- セキュリティのテスト：侵害された Renderer を模して、他のサイトの Cookie・保存領域・描画の内容を要求し、Browser 側で拒否されることを確かめる。

---
status: accepted
date: 2026-09-28
---

# ADR-0039: メタデータのパッケージは部品ごとの YAML と目録の zip にし、参照は API の名前だけで書き、書き出しを正規化する

詳細は [sandboxes-and-deploy.md](../architecture/sandboxes-and-deploy.md) の 5 節。

## Context

intent は、組織の間のメタデータのデプロイを MVP に含め、メタデータの形式を独自のものにするとした（本家の XML の形式を受け付けない。[ADR-0001](0001-platform-and-stack.md)、AGENTS.md）。管理者と連携の開発者は、Sandbox で作った設定を git で管理し、レビューして本番へ当てたい。AI エージェントも設定の差分を読み書きする。

組織ごとに ID は違いうる（Sandbox は同じ ID を持つが、別の系統の組織や、作り直した部品は違う）。項目の名前は変わりうる。

本家のメタデータの API は、1 回 10,000 ファイル、zip 39MB（base64 の後 50MB）、展開して 600MB まで（[Developer Limits and Allocations Quick Reference](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/salesforce_app_limits_cheatsheet.pdf)、[Metadata API Developer Guide](https://resources.docs.salesforce.com/latest/latest/en-us/sfdc/pdf/api_meta.pdf)、Winter '27 版、2026-09-28 に確認）。本家のプロファイルのデプロイの合わせ方の細部は確かめられなかった（未検証）。

## Options

形：

1. **部品ごとの YAML（1.2 の部分集合）のファイルと `package.yaml` の目録の zip。種類ごとに JSON Schema**
2. 部品ごとの JSON のファイルの zip
3. 組織の全体を 1 つの JSON の文書にする

参照：

- a. **API の名前だけで書き、デプロイの時に相手の ID に解決する**
- b. ID で書く

部品の当て方：

- x. **部品の全体の置き換え（標準オブジェクトの追加だけは足し算）**
- y. 書いた部分だけを足す

## Decision

1、a、x を採用する。

- `package.yaml` は `format`、`format_version`、元の組織の種類と系統と版、部品の一覧（種類、名前、正規化した内容のハッシュ）を持つ。`destructive.yaml` で消す部品と時期（`pre`・`post`）を指す。
- 部品のファイルは `objects/<object>/fields/<field>.yaml` のような木に置く。フロー・リストビュー・レポートの中の項目の参照も、書き出しの時に API の名前へ直し、デプロイの時に戻す。
- YAML はアンカー・エイリアス・タグ・複数の文書を使わない部分集合にし、安全な読み込みだけにする。種類ごとの JSON Schema を `format_version` ごとに公開する。
- 書き出しは正規化した形（キーの順、既定値を書かない、引用の規則）にし、書き出したものを同じ組織へデプロイすると差分が 0 になる。
- 部品のデプロイは全体の置き換え。権限セットは、書いた権限が全てになる。標準オブジェクトへの追加（`standard_objects/`）だけは、書いた項目・設定を足す・変える。
- 秘密（Webhook の秘密、外向きの呼び出しの認証、OAuth のクライアントの秘密）とデータ（レコード）は入れない。
- 上限は部品 10,000、zip 50MB、展開して 600MB。
- 2 は、コメントが書けず、人の読み書きと git の差分が読みにくい。3 は、1 つの部品の変更で大きな 1 つのファイルが変わり、並行の作業がぶつかる。
- b は、組織ごとに ID が違うと当てられない。名前の変更に強い点は ID の良さだが、デプロイは名前で意図を表す方が読みやすく、名前の変更は `rename_from` で明示する。
- y は、権限の結果がパッケージと相手の組織の今の状態の両方で決まり、レビューで結果が読めない。

## Consequences

- 良くなること：
  - 設定を git で管理し、差分をレビューできる。エージェントも直せる。
  - 別の系統の組織へも当てられる。
  - 権限の結果が、パッケージだけで決まる。
- 引き受けるコスト：
  - 名前の変更は、`rename_from` を書かないと新しい部品の追加になり、値が写らない。検証で「古い部品と同じ形の新しい部品」を警告にする。パッケージに入れない部品は消さず、消すのは `destructive.yaml` だけにする。
  - 全体の置き換えなので、権限セットの一部だけを変えたい時も全体を書き出す必要がある。
  - YAML の部分集合と JSON Schema を保守する。

## Confirmation

- 性質ベーステスト：任意の組織で、書き出し → 同じ組織へのデプロイの差分が 0。
- 性質ベーステスト：任意の部品で、書き出し → 読み込み → 書き出しが同じバイト列になる（正規化）。
- 契約テスト：公開の JSON Schema で、書き出した全ての部品が通る。
- セキュリティのテスト：アンカー・タグ・巨大な入れ子の YAML を断る。書き出しに秘密が入らない。

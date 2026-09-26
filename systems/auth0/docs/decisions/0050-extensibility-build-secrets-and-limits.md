---
status: accepted
date: 2026-09-27
---

# ADR-0050: npm の依存は隔離したビルドで束ね、秘密は呼び出しの本文でだけ渡し、上限は本家に寄せる

詳細は [extensibility.md](../architecture/extensibility.md) の 6・8 節。MVP の後（E13）。

## Context

本家の Actions は、公開の npm のレジストリのパッケージを 1 つの Action に 10 個まで使え、秘密を 30 個まで持て、保存の後は秘密を平文で読めない（[Manage Dependencies](https://auth0.com/docs/customize/actions/manage-dependencies)、[Entity Limit Policy](https://auth0.com/docs/troubleshoot/customer-support/operational-policies/entity-limit-policy)、[Actions Limitations](https://auth0.com/docs/customize/actions/limitations)、2026-09-27 に確認）。

npm のパッケージは、インストールの時にスクリプトを動かせる。悪性のパッケージの混入は、実際に起きている供給網の攻撃である。実行の基盤（[ADR-0049](0049-extensibility-execution-isolation.md)）は全テナントで共通の実行ロールを持つので、秘密をビルドの成果物や環境変数に置くと、隔離の前提が崩れる。

## Options

ビルド：

1. **隔離したビルド（使い捨ての CodeBuild、網は npm のプロキシだけ）で、`--ignore-scripts`、ネイティブのアドオンの拒否、悪性・脆弱性の照合、esbuild で 1 つの束に**
2. 実行の時に npm からインストールする
3. 依存を許さない

秘密：

- a. **呼び出しのたびに Auth が復号し、本文で渡す。束・環境変数・ディスクに書かない**
- b. 実行器が KMS・Secrets Manager から読む

## Decision

1 と a を採用する。

- 依存は版の作成の時点に解決して記録し、同じ版の再ビルドで変わらないようにする。
- 束は 10 MiB まで。`sha256` を付けて S3 に置く。
- 悪性のパッケージは拒否し、既知の脆弱性は警告する（照合のデータは OSV。選定は E13）。悪性が後から分かったら、その版を使うテナントを特定して配備を止める（runbook）。
- 秘密はエンベロープ暗号化（[ADR-0004](0004-credential-storage.md)）。呼び出しのたびに Auth が復号して本文で渡し、保存するログから値を伏せる。
- 上限は本家に寄せる：Action はテナントに 100・トリガーに 20、版 50、コード 100 kB、依存 10、秘密 30（キー 128 文字、値 4,096 文字）、`console.log` 256 文字・10 日。時限だけ本家と違う（同期 10 秒。[ADR-0048](0048-extensibility-triggers-and-failure-policy.md)）。テナントの同時実行は本番 100、本番以外 10。
- 2 は、ログインの途中に npm への依存と、インストールのスクリプトの実行が入る。
- 3 は、本家の Action の多く（HTTP のクライアント、JWT の処理など）が動かない。
- b は、実行ロールに秘密の読み取りの権限が要り、全テナントで共通のロールなので、あるテナントのコードが他のテナントの秘密を読める。

## Consequences

- 良くなること：
  - ビルドでテナントのコードを動かさず、実行でインストールをしない。
  - 実行ロールに権限を持たせない前提（ADR-0049）が守られる。
- 引き受けるコスト：
  - ネイティブのアドオンを使うパッケージ（一部の暗号のライブラリなど）が使えない。文書に書く。
  - `postinstall` で必要なファイルを作るパッケージが動かないことがある。
  - 呼び出しのたびに秘密の復号が入る（データキーはメモリーに持つので KMS は呼ばない）。
  - 悪性のパッケージの照合のデータの鮮度に依る。

## Confirmation

- 結合テスト：`postinstall` を持つパッケージ、ネイティブのアドオンを持つパッケージ、照合で悪性と分かったパッケージのビルドが失敗する。
- 結合テスト：同じ版の再ビルドで、束の `sha256` が変わらない。
- 結合テスト：秘密を `console.log` した Action の保存されたログに、値が出ない。束・関数の環境変数に秘密が現れない。
- 表駆動テスト：8 節の上限の境界（100・20・50・10・30、100 kB、10 MiB）。

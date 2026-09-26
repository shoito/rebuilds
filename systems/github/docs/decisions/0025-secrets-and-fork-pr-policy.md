---
status: accepted
date: 2026-09-26
---

# ADR-0025: シークレットはジョブの取得時にだけ復号して渡し、fork の Pull Request には渡さない。`<BRAND>_TOKEN` はジョブごとの最小の権限にする

> 識別子（ヘッダー・接頭辞・ドメイン・環境変数・パスの名前）は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に合わせて `<Brand>`・`<brand>`・`<BRAND>` の置き換え用の名前にした（2026-09-26）。本家の名前は、出典の説明としてだけ書く。

詳細は [actions.md](../architecture/actions.md) の 6 節と 9.3 節。

## Context

Actions のシークレット（クラウドの鍵、レジストリの資格情報など）は、漏れると利用者の本番に届く。漏れの経路は主に次の 4 つ。

- **保存**：DB・バックアップからの漏洩
- **配送**：ジョブへ渡す途中、サーバーのログ・キュー
- **ジョブの中**：ログへの出力、攻撃者のコードによる持ち出し
- **起動の条件**：信頼できないコード（fork の Pull Request）が、秘密を持つ実行で動くこと

本家は、fork からの `pull_request` にはシークレットを渡さず、`GITHUB_TOKEN` を読み取りだけにする（[Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)）。`pull_request_target` は、デフォルトブランチのワークフローを秘密付きで動かすので、PR のコードを実行すると「pwn request」になる。本家は 2026 年に、公開リポジトリで `pull_request_target` を止める既定のポリシーを導入し、2026-11-02 に強制する予定である（[Securely using pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)）。

## Options

### 保存と配送

1. **平文を KMS で暗号化して DB に置き、ランナーが API で取りに来る**
2. **利用者が公開鍵で暗号化して送り、ジョブの取得時にだけ Secrets service が復号して、ジョブのメッセージに入れる**

### `pull_request_target`

A. 本家の現行（2026-09）と同じく、公開リポジトリでも既定で動かし、警告だけ出す
B. **公開リポジトリでは既定で止め、ポリシーで明示的に許したときだけ動かす**

## Decision

保存と配送は 2、`pull_request_target` は B を採用する。

- **保存**：本家の REST API と同じく、利用者はリポジトリ・Organization の公開鍵（libsodium の sealed box）で暗号化して送る。秘密鍵は KMS でエンベロープ暗号化する。`kms:Decrypt` は Secrets service だけが持つ。画面・API は値を返さない。
- **配送**：Broker がジョブを渡す直前に、Secrets service が「渡してよいか」を判定し、ワークフローが参照する名前のシークレットだけを復号する。平文はジョブのメッセージ（TLS）の中にだけ入れ、DB・キュー・ログに書かない。
- **渡してよいかの規則**：

  | 起動 | シークレット | `<BRAND>_TOKEN` | OIDC |
  | --- | --- | --- | --- |
  | 同じリポジトリからの実行 | 参照するものを渡す | `permissions` の範囲 | `id-token: write` のとき |
  | fork からの `pull_request`（公開） | 渡さない | 読み取りだけ | 出さない |
  | fork からの `pull_request`（非公開） | 既定では実行しない。設定で許したときも、シークレットと書き込みのトークンは別の設定 | 同左 | 同左 |
  | `pull_request_target` | 渡す | `permissions` の範囲 | 出す。ただし公開リポジトリでは既定で起動しない |

- **環境のシークレット**は、環境の保護の規則（必須のレビュアー、待ち時間、デプロイできるブランチ）を満たしたジョブにだけ渡す。
- **fork の PR の承認**：公開リポジトリでは、初めての貢献者などの PR の実行を、書き込みの権限のある人が承認するまで `action_required` で止める（本家と同じ 3 段階の設定）。
- **`<BRAND>_TOKEN`**：ジョブごとに、組み込みの App のインストールのトークンを発行する（[本家の GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)）。権限は「ワークフローの `permissions`」「リポジトリ・Organization の既定の上限（新規は `contents: read` だけ）」「fork なら読み取りだけ」「再利用可能なワークフローは呼ぶ側以下」の最小。ジョブの完了で失効させる。
- **ログのマスク**：ランナーで完全一致の置き換えを行い、Log service でもう一度、そのジョブのシークレット（と Base64・URL エンコードの形）で検査する。本家も、構造を持つ値や派生の値は漏れうるとしている（[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)）。
- **公開リポジトリのセルフホストのランナー**は、ランナーのグループで明示的に許したときだけ使える。
- 1 を採らない理由：平文がサーバーの API を通る。ランナーが任意の名前のシークレットを取りに来られる API は、攻撃者のコードからも呼べる。
- A を採らない理由：本家自身が既定で止める方向へ移っている。後から既定を変えると利用者のワークフローを壊すので、最初から止めた状態で出す。

## Consequences

- 良くなること：
  - シークレットの平文が存在する場所が、Secrets service のメモリ、配送中の TLS、ランナーの VM の中だけになる。
  - fork の PR から秘密に届く経路が、既定の設定では閉じる。
  - `<BRAND>_TOKEN` の既定が読み取りだけなので、漏れても書き込みに使われにくい。
- 引き受けるコスト：
  - 本家のワークフローのうち、公開リポジトリで `pull_request_target` に頼るもの（ラベル付け、fork の PR へのコメント）は、ポリシーを変えないと動かない。移行の案内が要る。
  - ジョブの中の攻撃者のコードが、自分に渡されたシークレットを持ち出すことは防げない。守れるのは「渡す相手を絞ること」まで。
  - マスクの二重の確認は、Log service がシークレットの値（またはその派生）を扱うことになる。平文を持たせない方式は PoC で決める（**未検証**）。

## Confirmation

- 性質ベーステスト：任意の起動（イベント、fork か否か、公開か否か、環境、設定）の組で、ジョブのメッセージに入るシークレットと `<BRAND>_TOKEN` の権限が、上の表と一致する（表駆動テストと合わせる）。
- 漏洩のテスト：
  - fork の PR の実行のジョブのメッセージ・環境変数・ファイルに、どのシークレットの値も現れない。
  - DB・キュー・サーバーのログ・トレースの全体を、テスト用のシークレットの値（とその Base64 の形）で検索して、見つからない。
- ログのマスクのテスト：シークレットをそのまま、行をまたいで、Base64 にして出力したとき、前 2 つは確定したログに現れない。Base64 は `::add-mask::` で登録したときに現れない。
- lint：Secrets service 以外のサービスの IAM ロールに `kms:Decrypt`（シークレットの鍵）がないこと。

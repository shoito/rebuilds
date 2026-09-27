---
status: accepted
date: 2026-09-27
---

# ADR-0064: OpenID Foundation の適合試験を CI の中で自前で動かし、認証の経路の PR の必須のチェックにする

## Context

[ADR-0001](0001-platform-and-stack.md) は、OpenID Foundation の適合試験（conformance suite）を CI で回し、対象のプロファイル（OP の Basic・Config・Form Post・RP-Initiated Logout・Back-Channel Logout。Form Post は [authentication-flows.md](../architecture/authentication-flows.md) の 14 節の決定で加えた）がすべて通ることを、認証の経路のパッケージを変える PR の必須のチェックにすると決めた。GA の前に OpenID Certification を受ける（K2、NFR-009）。

適合試験の実行の形は、次の 2 つがある。

- OpenID Foundation がホストする試験のサーバーに、公開の URL の OP を登録して走らせる。
- 試験のスイート（オープンソース。Java のサーバーと MongoDB を Docker Compose で起こす）を、自分の環境で動かす。OpenID Foundation は、CI で使うための Python のスクリプト（`scripts/run-test-plan.py`）を用意し、認可サーバーの開発者に CI への組み込みを強く勧めている（[OpenID Conformance Suite](https://openid.net/certification/about-conformance-suite/)、2026-09-27 に確認）。

試験には、ブラウザの操作（ログインの画面への入力）を要するものがある。試験の設定の JSON の `browser` に、URL の `match` ごとの `tasks`（`text`・`click` の `commands`）を書くと、スイートの中の Selenium が自動で行う（[BrowserControl](https://gitlab.com/openid/conformance-suite/-/wikis/Design/BrowserControl)、2026-09-27 に確認）。

## Options

1. **スイートを CI のランナーの中でコンテナとして動かし、本システムも同じネットワークで Testcontainers で起こす。PR では変更に関わるプロファイルを、`main` と夜間ではすべてのプロファイルを走らせる**
2. OpenID Foundation のホストする試験のサーバーを、CI から API で呼ぶ
3. 適合試験は GA の前に手で走らせ、CI では node-oidc-provider との差分テストだけにする

## Decision

1 を採用する。

- **スイートの版を固定する。** コンテナのイメージを digest で固定し、Renovate で更新する。更新の PR では、全プロファイルを走らせる。
- **試験の設定（テストプランの JSON、ブラウザの操作）を開発リポジトリの `conformance/` に置く。** 試験用のテナント、クライアント、ユーザーは、試験の開始時に Management API で作る（シードの秘密は試験の中で生成する）。
- **PR の CI**：`packages/oidc`・`services/auth`・`services/signer`・`packages/jose-*` など認証の経路のパッケージを変える PR で、Basic・Config・Form Post のプロファイルを走らせる。セッション・ログアウトを変える PR では、RP-Initiated Logout と Back-Channel Logout も走らせる。対応は `conformance/plans.yaml` の表で持つ。目標は 15 分以内。
- **`main` へのマージの後と夜間**：対象のすべてのプロファイルと、将来の対象（FAPI 2.0 などの候補）を「参考」として走らせる。参考の失敗は、必須のチェックにしない。
- **結果の判定**：スイートの結果の `FAILED` は失敗。`WARNING` は、`conformance/allowed-warnings.yaml` に理由と承認者（QA）を書いたものだけを許す。許可のない `WARNING` は失敗。`REVIEW`（人の確認が要るもの）は、夜間の結果で QA が確かめる。
- **差分テスト**：node-oidc-provider との差分テスト（ADR-0001）を、同じ CI の段で走らせる。
- **認証の申請**：E12 で、`main` の CI と同じ設定で、公開の staging に対してホストされた試験のサーバーで走らせ、結果を申請する。対象のプロファイルは上の 5 つ（Dynamic は持たない）。認証の費用は、OpenID Connect の 1 つのデプロイメントに、会員 700 USD・非会員 3,500 USD。同じ暦年の中なら、プロファイルを後から足しても追加の費用はない（[OpenID Certification Fees](https://openid.net/certification/fees/)、2026-09-27 に確認）。E12 の前に OpenID Foundation の会員になり、会員の費用で申請する（2026-09-27 に確定）。
- 2 は、PR ごとに本システムを公開の URL に置く必要があり、外部のサービスの可用性に CI が依存する。3 は、回帰が GA の直前まで見つからない。

## Consequences

- 良くなること：
  - プロトコルの回帰を PR の時点で見つける。
  - 外部のサービスに依存せずに、CI が決まった時間で終わる。
- 引き受けるコスト：
  - スイートのコンテナ（Java、MongoDB）を CI で動かす費用と時間。
  - スイートの更新で試験が変わると、本システムの変更なしに CI が失敗しうる。スイートの更新は専用の PR で行う。
  - ホストされた試験のサーバーとの結果の違い（ネットワーク、TLS）がありうる。申請の前に staging で確かめる。

## Confirmation

- GitHub のルールセット：認証の経路のパッケージを変える PR で、`conformance` のチェックが必須になっている。
- 週次：`main` の夜間の結果で、対象のプロファイルが 7 日続けて通っている（GA の判定の条件。[quality.md](../quality.md)）。
- レビュー：`allowed-warnings.yaml` の変更は QA の承認を要する（CODEOWNERS）。

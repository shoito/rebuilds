---
status: accepted
date: 2026-09-27
---

# ADR-0037: 非常用の経路はテナントの M2M と KMS で署名した運用者の短いトークンにし、ロールは本家に寄せる

詳細は [dashboard.md](../architecture/dashboard.md) の 4.4 節と 5 節。

## Context

管理者のログインは、本システムの管理用のテナントで行う（[ADR-0036](0036-dashboard-login-via-admin-tenant.md)）。管理用のテナントの設定の誤り、その接続・MFA の障害、認証の経路の全体の障害で、管理者がダッシュボードに入れなくなる。そのときに、障害を直すための設定の操作ができなければならない。

一方で、非常用の経路は、なりすましと内部の不正の入口になりうる。[ADR-0056](0056-operator-access.md) は、運用者がエンドユーザーのトークンを作る機能と、運用者が Signer を直接呼ぶ経路を作らないとした。

ロールは、本家のダッシュボードのロール（Admin、Editor - Connections・Key Management・Organizations・Specific Apps・Users、Viewer - Users・Config Settings など）がある（[Dashboard Access by Role](https://auth0.com/docs/get-started/manage-dashboard-access/feature-access-by-role)、2026-09-27 に確認）。

## Options

非常用の経路：

1. **テナントの管理者は、テナント自身の M2M で Management API を使う。本システムの運用者は、KMS の専用の非対称鍵で署名した、テナントと操作を限った 1 時間以内のトークンを、2 人の承認の break-glass のロールで発行する**
2. 管理用のテナントに、封をした非常用の管理者のアカウントを置く
3. 運用者が DB を直接書き換える（ADR-0056 の期限つきの DB の書き込みの権限）

ロール：

- a. **本家に寄せた固定のロール（7 つ、E14 で 8 つ）**
- b. テナントが自由にロールを作る

## Decision

1 と a を採用する。

- テナントの管理者の逃げ道は、テナント自身の M2M の資格情報（CLI・Terraform）。管理用のテナントに依存しない。文書とダッシュボードのオンボーディングで、本番のテナントに M2M の管理用のアプリを作っておくよう勧める。
- 運用者の非常用のトークン：
  - IAM Identity Center の break-glass のロール（2 人の承認）を引き受けた運用者だけが、専用の CLI で KMS の `Sign` を呼んで作る。
  - `iss` は非常用の発行者、`aud` は `https://manage.<brand>.<domain>/api/`、`tenant` は 1 つ、`scope` は対象の操作、`incident` はインシデントの ID、有効 1 時間以内。
  - Signer とテナントの署名鍵を使わない。認証の経路にも依存しない。
  - Management API の操作だけができる。エンドユーザーのトークン・セッションは作れない。ユーザーのデータの読み取りは、テナントの許可（ADR-0056）がない限り付けない。
  - 使用はすべてプラットフォームの監査に残し、対象のテナントに事後に知らせる。
- ロールは `admin`、`editor_connections`、`editor_keys`、`editor_apps`、`editor_users`、`viewer_users`、`viewer_config`（E14 で `editor_organizations`）。ロールからスコープの対応はコードの表に持つ。最後の `admin` は外せない。
- 2 は、管理用のテナントそのものが壊れたときに使えない。封をしたアカウントの資格情報の保管と、定期の確認の運用も要る。
- 3 は、設定の検証・版の更新（[ADR-0032](0032-tenant-config-cache.md)）・監査を通らない変更になり、反映の漏れや不整合を生む。
- b は、ロールの組み合わせが無限になり、秘密やログの権限の誤りを表駆動テストで押さえられない。本家も固定のロールである。

## Consequences

- 良くなること：
  - 管理用のテナントと認証の経路のどちらが壊れても、設定を直す経路が残る。
  - 非常用の経路も、Management API の検証・版・監査を通る。
- 引き受けるコスト：
  - 非常用の専用の KMS の鍵と CLI を保守し、年 2 回の訓練をする。
  - テナントの管理者の逃げ道は、テナントが M2M を用意していることが前提。用意していないテナントは、サポートを通して運用者の経路に頼ることになる。
  - テナントが自分のロールを作れない。細かな権限の需要は、E14 以降で見直す。

## Confirmation

- 結合テスト：非常用のトークンで、対象でないテナント、スコープにない操作、期限切れ、`incident` のないトークンを拒否する。使用がプラットフォームの監査に残る。
- IAM：非常用の KMS の鍵の `kms:Sign` を持つのが break-glass のロールだけであることを、Terraform の検査と週次の監査で確かめる。
- 表駆動テスト：ロール × スコープ。`viewer_config` と `viewer_users` に秘密の読み取りのスコープがない。
- 訓練：staging で年 2 回、管理用のテナントの接続を壊した状態から、非常用のトークンで直す。

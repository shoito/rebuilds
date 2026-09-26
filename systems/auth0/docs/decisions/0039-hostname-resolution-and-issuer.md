---
status: accepted
date: 2026-09-27
---

# ADR-0039: ホスト名からテナントを、DB を読まずにプロセスの中の対応表で解決し、リンクとリダイレクトは要求のヘッダーではなく登録したホスト名から作る

## Context

本システムは、要求のホスト名（`<tenant>.jp.<brand>.<domain>` か、カスタムドメイン）からテナントを決めてから DB を読む（[ADR-0002](0002-tenancy-and-isolation.md)）。カスタムドメインで受けた要求では、`issuer` もカスタムドメインになる（本家と同じ。[authentication-flows.md](../architecture/authentication-flows.md) の 4 節）。

危険は 2 つある。

- **解決の誤り**：オリジンに直接届いた要求や、偽の `Host` のヘッダーで、別のテナントとして扱われる。
- **ホストのヘッダーの注入**：再設定のメールのリンク、リダイレクト、discovery の URL を要求のヘッダーから作ると、攻撃者のドメインのリンクを正規のメールで送らせられる（[Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)、2026-09-27 に確認）。

本家 Auth0 は、複数のカスタムドメインのとき、メールを送る Management API の呼び出しで `auth0-custom-domain` のヘッダーでドメインを選び、なければ「既定のドメイン」を使う（[Multiple Custom Domains](https://auth0.com/docs/customize/custom-domains/multiple-custom-domains)、2026-09-27 に確認）。

## Options

1. **`tenant_hostnames` の表を正本にし、各タスクのメモリーに版付きの対応表として持つ。解決は対応表だけで行い、外へ出す URL は、解決したホスト名の行から作る**
2. 要求ごとに DB（か Valkey）でホスト名を引く
3. CloudFront の関数でテナントの ID をヘッダーに付けて、オリジンはそれを信じる

## Decision

1 を採用する。

- **表**：`tenant_hostnames`（`hostname` を主キー、`tenant_id`、`kind`（`canonical`・`custom`）、`custom_domain_id`、`status`、`is_default_for_email`、`version`）。RLS の外の、テナントをまたぐ表（参照は解決のためだけ。書き込みは管理の経路の別のロール）。
- **解決**：各タスクは、起動時に表の全件を読み、変更の通知（outbox → SQS → 各タスク）で差分を反映する。S1 の 1 万テナント（カスタムドメインを含めて 2 万行程度）はメモリーに収まる。S3（100 万テナント）ではセルごとに分ける。
  - 対応表にないホスト名は、DB に問い合わせず 404 にする。
  - DB が読めない間は、最後の版で動く（[ADR-0005](0005-authentication-path-availability.md)）。通知が遅れたとき、新しいドメインが最大 60 秒使えないことを許す（有効化の前に、全タスクの版の反映を確かめる）。
  - ホスト名は、小文字にし、末尾のドットとポートを除いてから引く。IDN は Punycode の形で持つ。
- **オリジンが信じるホスト名**：CloudFront が付ける元の `Host`（配信のテナントのドメイン）を使う。オリジンは CloudFront からの要求だけを受ける（[ADR-0058](0058-edge-and-custom-domains.md)）。`X-Forwarded-Host` などの他のヘッダーは読まない。
- **外へ出す URL の作り方**：
  - 画面と、リダイレクトと、discovery は、**解決したホスト名の行**から `https://<hostname>` を作る。値は要求のヘッダーの文字列ではなく、表の値を使う。
  - メールのリンクは、ログインの途中（トランザクションがある）なら、そのトランザクションのホスト名。Management API からの送信（管理者が送る確認のメールなど）は、`is_default_for_email` の行（カスタムドメインがあればそれ、なければ標準のホスト名）。S2 の複数のカスタムドメインでは、要求の `<Brand>-Custom-Domain` のヘッダーで、テナントの `ready` のドメインから選ばせる（本家の `auth0-custom-domain` に相当。リポジトリ共通の ADR-0006）。
- **`issuer`**：[authentication-flows.md](../architecture/authentication-flows.md) の決定のとおり、解決したホスト名ごとに `https://<hostname>/`。カスタムドメインを消したら、そのドメインの `issuer` のトークンは新たに出ない。発行済みのトークンは期限まで有効（テナントの API が古い `issuer` を受け付け続けるかはテナントの判断）。
- **セッションの Cookie** はホスト名ごと（`__Host-` の接頭辞）。標準のホスト名とカスタムドメインの間で SSO はしない（本家と同じく、カスタムドメインへの切り替えで再ログインになる）。
- 2 は、すべての要求の前に DB か Valkey を引くことになり、ADR-0005 の縮退と合わない。3 は、エッジの設定の誤りがそのままテナントの取り違えになり、オリジンで確かめる手段がない。

## Consequences

- 良くなること：
  - テナントの解決が DB の障害の影響を受けない。
  - ホストのヘッダーの注入で、他のドメインのリンクを作らせられない。
- 引き受けるコスト：
  - ホスト名の変更（ドメインの追加・削除）の反映に、通知の遅れがある。
  - テナントをまたぐ表を 1 つ持ち、RLS の外で扱う。書き込みのロールと、読み取りの経路を限る。

## Confirmation

- 結合テスト：対応表にないホスト名の要求が、DB への問い合わせなしに 404 になる（DB のクエリの数を数える）。
- 結合テスト：`Host` と `X-Forwarded-Host` を偽った再設定の要求で、メールのリンクのホスト名が表の値になる。
- 性質ベーステスト：任意のホスト名の文字列（大文字、末尾のドット、ポート、Unicode）で、正規化の後に同じ行に解決するか、どの行にも解決しないかのどちらかで、別のテナントの行には解決しない。

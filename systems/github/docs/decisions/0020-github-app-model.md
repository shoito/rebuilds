---
status: accepted
date: 2026-09-26
---

# ADR-0020: 外部との連携の主な形を、本家と同じ GitHub App（インストールと 1 時間のトークン）にする

> 識別子（ヘッダー・接頭辞・ドメイン・環境変数・パスの名前）は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に合わせて `<Brand>`・`<brand>`・`<BRAND>` の置き換え用の名前にした（2026-09-26）。本家の名前は、出典の説明としてだけ書く。

## Context

CI、ボット、外部のサービス、AI エージェントが、リポジトリを読み書きし、事象を受け取る。その主体と資格情報の形を決める。

本家には 2 つの形がある（[Differences between GitHub Apps and OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)、2026-09-26 に確認）。

- OAuth アプリ：ユーザーの代わりに、粗いスコープの長命のトークンで動く。Webhook は別に作る。
- GitHub App：アカウントに「インストール」し、細粒度の権限と選んだリポジトリの範囲で、bot として動く。インストールのトークンは 1 時間で失効する。Webhook を App に 1 つ持つ。本家は GitHub App を推奨している。

## Options

1. **GitHub App を主な形にし、OAuth アプリは互換のために残す**
2. OAuth アプリだけ
3. 独自の連携のモデル（Slack のアプリの形など）

## Decision

1 を採用する。詳細は [api-and-webhooks.md](../architecture/api-and-webhooks.md) の 7・8 節にある。

- App は、権限（細粒度の PAT と同じ語彙）と購読する事象を宣言する。インストールは、アカウント × リポジトリの選択（すべて / 選んだもの）× 承認済みの権限。
- **インストールのトークンは 1 時間で失効する。** App は秘密鍵で署名した JWT（最長 10 分）で、`POST /app/installations/{id}/access_tokens` を呼んで得る。リポジトリ（最大 500）と権限を、インストールの範囲の部分集合に絞れる（[Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)、2026-09-26 に確認）。
- **App はロールを持たない主体（bot）。** `can()` では、インストールの権限 × インストールのリポジトリだけで決まる。ユーザーの代わりに動くときは、ユーザーのトークン（8 時間、リフレッシュ 6 か月）で、ユーザーの権限と App の権限の積になる。ユーザーのトークンの期限は外せない（本家は外せる。本家との違い）。
- 本システムは App の秘密鍵を保存しない（公開鍵だけ）。
- App が権限を増やすには、インストールの持ち主の承認が要る。
- マニフェストの流れ（1 時間以内の 3 段）で、人の確認 1 回で App を作れるようにし、AI エージェントの主体を作る標準の経路にする。
- Actions のジョブのトークンも、組み込みの App のインストールのトークンとして発行する（[ADR-0025](0025-secrets-and-fork-pr-policy.md)）。
- 2 は、粗いスコープの長命のトークンが連携の主な形になり、漏洩の被害が大きい。
- 3 は、本家の App を前提にした既存の道具とエージェントの知識が使えない。

## Consequences

- 良くなること：
  - 連携の資格情報が、既定で短命・最小の権限・選んだリポジトリだけになる。
  - 連携の主体が人のアカウントから切り離され、人の異動で止まらない。席も消費しない。
  - Actions の `<BRAND>_TOKEN` と外部の App が、同じ判定の経路を通る。
- 引き受けるコスト：
  - JWT の検証、インストールのトークンの大量の発行（1 時間ごと × インストールの数）、権限の変更の承認の流れを、自分たちで作って保つ。
  - OAuth アプリも残すので、スコープの写しの表と、Organization の OAuth アプリの承認の方針を合わせて保つ。
  - インストールのトークンの表が大きくなる。時間のパーティションで消す。

## Confirmation

- 表駆動テスト：identity-and-permissions.md の 5.5 節の行 19〜21（インストールの範囲の外は 404、権限の外は 403、ユーザーのトークンは積）。
- 結合テスト：期限切れの JWT（10 分超、`iat` が 60 秒より未来）を拒否する。1 時間を過ぎたインストールのトークンを拒否する。部分集合に絞ったトークンが、絞った外のリポジトリで 404 になる。インストールの停止・削除で、発行済みのトークンが 30 秒以内に拒否される。
- 性質ベーステスト：任意のインストールと絞り込みで、トークンの許可 ⊆ インストールの権限 × リポジトリ。

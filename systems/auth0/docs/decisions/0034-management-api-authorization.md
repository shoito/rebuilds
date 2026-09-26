---
status: accepted
date: 2026-09-27
---

# ADR-0034: Management API は 3 種のトークンを受け、M2M は要求ごとに今の許可を確かめ、自分より広い許可を作らせない

詳細は [management-api-and-rate-limiting.md](../architecture/management-api-and-rate-limiting.md) の 4 節。

## Context

Management API のトークンは、テナントのすべての設定とユーザーを変えられる。本家では、テナント自身が `client_credentials` で出す M2M のトークン（`aud` は `https://<tenant>/api/v2/`）を使い、スコープで操作を許す。発行したトークンは失効できず、有効期間の既定は 86,400 秒である（[Management API Access Tokens](https://auth0.com/docs/secure/tokens/access-tokens/management-api-access-tokens)、2026-09-27 に確認）。

本システムでは、次も要る。

- ダッシュボードの管理者は、テナントのユーザーではなく、管理用のテナントのユーザーである（[ADR-0036](0036-dashboard-login-via-admin-tenant.md)）。
- 管理用のテナントが使えないときの非常用の経路（[ADR-0037](0037-break-glass-and-admin-roles.md)）。
- JWT のアクセストークンは期限まで有効（[ADR-0003](0003-token-formats-and-signing-keys.md)）。M2M の資格情報の漏えいのとき、24 時間止められないのは管理の経路では長すぎる。

## Options

1. **3 種のトークン（テナントの M2M、管理用のテナント、非常用）を受ける。M2M は要求ごとに client grant を DB で確かめる。ダッシュボードはメンバーのロールを要求ごとに読む**
2. 本家と同じく、トークンのスコープだけで判定する
3. Management API のトークンだけを不透明にし、イントロスペクションで確かめる

## Decision

1 を採用する。

- テナントの M2M のトークン：`iss` は要求のホスト名のテナントの `issuer`、`aud` は `https://<tenant host>/api/v2/`。**要求ごとに `(client_id, audience)` の許可が今もあり、要求の操作のスコープが今の許可に含まれることを確かめる。** 外れていたら 403 `grant_revoked`。
- 管理用のテナントのトークン：`aud` は `https://manage.<brand>.<domain>/api/`。対象のテナントは要求のパス（`/api/tenants/{tenant}/v2/*`）。要求ごとに `tenant_members` のロールを読み、ロールから得たスコープで判定する。
- 非常用のトークン：KMS の非対称鍵で署名した、対象のテナントと操作を限った短いトークン（ADR-0037）。
- スコープは本家と同じ `<action>:<resource>` の形。秘密に触れる操作は別のスコープにする。エンドポイントとスコープの対応は OpenAPI の `security` に書き、対応のないエンドポイントは起動時に失敗させる。
- **Management API への client grant を作る・広げる操作では、新しい許可のスコープが、呼び出し元のトークンのスコープの部分集合でなければならない。** ダッシュボードでは `admin` のロールだけに許す。
- 管理の経路は ADR-0005 の縮退の対象ではない（認証の経路ではない）ので、要求ごとの DB の読み込みを許す。
- 2 は、漏えいしたトークンを最大 24 時間止められない。
- 3 は、Management API のトークンだけが別の形になり、テナントの他の API（JWT）と扱いが分かれる。本家の利用者の道具（トークンを JWT として読む）とも合わない。

## Consequences

- 良くなること：
  - 許可を消せば、発行済みの M2M のトークンも次の要求から止まる。本家より早く止められる。
  - M2M のトークンからの権限の昇格を防ぐ。
- 引き受けるコスト：
  - Management API の要求ごとに、許可かメンバーのロールの DB の読み込みが 1 回増える（reader。NFR-004 の予算に含める）。
  - 3 種の発行者の検証の経路を持つ。どの経路も同じルーターの判定を通す。

## Confirmation

- 表駆動テスト：スコープ × エンドポイント（OpenAPI から生成）。3 種のトークンのそれぞれで。
- 結合テスト：client grant を消すと、発行済みの M2M のトークンで 403 `grant_revoked`。スコープを狭めると、外したスコープの操作だけが 403。
- 結合テスト：`read:client_grants create:client_grants` だけの M2M のトークンで、`delete:users` を含む Management API の許可を作ると 403。
- 結合テスト：テナント A の M2M のトークンで、テナント B のホスト名を呼ぶと 401。
- CI：スコープの対応のないエンドポイントがあると起動のテストが失敗する。

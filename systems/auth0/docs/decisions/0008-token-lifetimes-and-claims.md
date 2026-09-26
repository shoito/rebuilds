---
status: accepted
date: 2026-09-27
---

# ADR-0008: トークンの有効期間の既定と上限を決め、アクセストークンは 1 つの API に宛てる

詳細は [authentication-flows.md](../architecture/authentication-flows.md) の 8 節。

## Context

[ADR-0003](0003-token-formats-and-signing-keys.md) で、トークンの形式（ID トークンとアクセストークンは JWT、リフレッシュトークンは不透明）と、アクセストークンの既定・最大の有効期間（本家と同じ 86,400 秒・2,592,000 秒）を決めた。ブラウザのフローの既定と、ID トークン・クレームの規則は、この領域に任されている。

本家 Auth0（2026-09-27 に確認）：

- ID トークンの既定は 36,000 秒（[Update ID Token Lifetime](https://auth0.com/docs/secure/tokens/id-tokens/update-id-token-lifetime)）。最大は資料になかった（未検証）。
- アクセストークンには、暗黙・ハイブリッドのフロー向けの別の値がある。ブラウザの PKCE のフローは一般の値を使う（[Update Access Token Lifetime](https://auth0.com/docs/secure/tokens/access-tokens/update-access-token-lifetime)）。
- リフレッシュトークンの使われない期間の既定は 2,592,000 秒、最大 1 年（[Configure Refresh Token Expiration](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration)）。

JWT のアクセストークンは期限まで止められない（[ADR-0003](0003-token-formats-and-signing-keys.md)）。ブラウザやモバイルに置いたトークンが漏れたときの害は、有効期間に比例する。RFC 9700 の 2.3 節は、アクセストークンの宛先（audience）を限ることを勧める。

## Options

1. **公開のアプリ（SPA・Native・デバイス）のアクセストークンは既定 3,600 秒・最大 86,400 秒。機密のアプリと M2M は本家と同じ。1 つのトークンの宛先は 1 つの API（と userinfo）**
2. すべてのアプリで本家と同じ（既定 86,400 秒）
3. 公開のアプリはさらに短く（既定 300 秒）

## Decision

1 を採用する。

| トークン | 既定 | 範囲 |
| --- | --- | --- |
| アクセストークン（機密・M2M） | 86,400 秒 | 60〜2,592,000 秒 |
| アクセストークン（公開） | 3,600 秒 | 60〜86,400 秒 |
| ID トークン | 36,000 秒 | 60〜86,400 秒 |
| リフレッシュトークン（最終） | 30 日 | 1 日〜1 年 |
| リフレッシュトークン（使われない期間） | 15 日 | 1 時間〜最終の期限 |
| 認可コード | 60 秒 | 固定 |

- アクセストークンの有効期間は API に設定し、公開のアプリへ出すときは公開の範囲の上限で切る。
- アクセストークンの `aud` は、1 つの API の識別子（`openid` を含む要求では userinfo の URL を足した配列）。`sid` を入れない。M2M の `sub` は `<client_id>@clients`。
- ID トークンの `aud` は `client_id` だけ。`auth_time` を常に入れる。プロフィールのクレームは、スコープに応じて ID トークンにも入れる（本家と同じ）。
- JWT の大きさが 8 KiB を超えるなら発行しない。
- 2 は、SPA に 24 時間のトークンを置くことになる。3 は、リフレッシュの要求が 12 倍になり（S1 のトークンの発行のピークの見積もりを超える）、得る安全の割に費用が大きい。

## Consequences

- 良くなること：
  - ブラウザ・モバイルでのトークンの漏えいの害が、既定で 1 時間に収まる。
  - トークンを別の API に使い回せない。
- 引き受けるコスト：
  - 本家から移る SPA は、リフレッシュの回数が増える。
  - 複数の API を呼ぶアプリは、API ごとにトークンを得る必要がある。

## Confirmation

- 表駆動テスト：アプリの種類 × API の設定 × 要求ごとの `exp − iat`。
- 性質ベーステスト：任意の要求で、アクセストークンの `aud` の API は 1 つ。スコープは許可の部分集合。
- 適合試験：OIDC Basic の OP のプロファイルの ID トークンの検証が通る。

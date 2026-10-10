---
status: accepted
date: 2026-10-10
---

# ADR-0062: ADR-0001 の汎用の部品の一覧に、HTML5 の構文解析（WHATWG の手順に従うもの）、XML の解析と XML 署名（SAML。外部の実体と DTD を止める）、JOSE・JWT、WebAuthn の検証、Argon2id、地理の DB の読み出しを足す。どれも自前の上限の層で包み、依存の許可の一覧と SBOM・署名の検査を CI で行う

詳細は [security.md](../architecture/security.md) の 10 節。

## Context

- 汎用の部品は [ADR-0001](0001-platform-and-stack.md) の一覧の範囲で使う。一覧にない部品を使うには ADR が要る。
- group B の領域から、次の求めが出た。
  - HTML のメールの浄化（[ADR-0044](0044-safe-html-rendering.md)）は、HTML の構文解析を WHATWG の手順に従う汎用のライブラリで行う。一覧に足すまで `thread-view-and-safe-html` の spec を承認しない（[web-client.md](../architecture/web-client.md) の 17 節）。
- group C の領域で、次の部品が要る。
  - SSO の SAML の応答の XML の解析と XML 署名の検証、OIDC の JWT（[organizations-domains-and-routing.md](../architecture/organizations-domains-and-routing.md) の 4.4 節）。
  - パスキーの WebAuthn の表明の検証、パスワードの Argon2id（[ADR-0055](0055-sign-in-methods-sessions-and-protocol-auth.md)）。
  - サインインの危険度の IP の地理と ASN（[ADR-0056](0056-sign-in-risk-and-account-recovery.md)）。
  - 送信のフッターの HTML の位置（[ADR-0052](0052-org-routing-rules-evaluation.md)）。
- どれも題材の核（MTA、選別、保存、スレッド、索引、同期）の外の汎用の処理で、自前で書くと誤りの危険が大きい（XML 署名の包み替え、HTML の構文解析の差による浄化のすり抜け）。
- 依存が増えるほど、供給網の危険が増える（[security.md](../architecture/security.md) の 3 節の T12）。

## Options

1. **一覧に 6 つの部品を足し、上限の層・設定の固定・供給網の検査を条件にする**
2. 自前で書く
3. 外部のサービス（IdP の仲介、パスワードの照合の API）に任せる

## Decision

1 を採用する。

| 部品 | 範囲 | 条件 |
| --- | --- | --- |
| HTML5 の構文解析 | HTML を木にすること | 浄化・CSS・書き換えは自前。入力 2 MiB、深さ 256、要素 5 万で包む |
| XML の解析と XML 署名 | SAML の応答 | 外部の実体・DTD・XInclude を止める。署名の参照を 1 つに限り、署名した要素だけを読む |
| JOSE・JWT | OIDC の ID トークン、`private_key_jwt` | `alg` を `RS256`・`ES256`・`EdDSA` に限り、`none` を拒む |
| WebAuthn の検証 | 表明の形と署名 | 方式の判断は自前 |
| Argon2id | パスワードのハッシュ | 値を行に持つ |
| 地理の DB の読み出し | IP → 国・都道府県・ASN | 手元の DB だけ。外部に照会しない |

- ADR-0001 の本文を書き換えず、この ADR を一覧の補いとする。ADR-0001 の Confirmation の依存の検査は、この ADR の一覧も読む。
- 供給網：`cargo-deny` と lockfile の検査で一覧の外の種類を拒む。基のイメージと依存のダイジェストを固定し、更新は週 1 回のまとめた PR。CycloneDX の SBOM をビルドごとに作り、High は 7 日・Critical は 48 時間で直す。イメージは署名し、署名を確かめたダイジェストだけを動かす。
- これで [ADR-0044](0044-safe-html-rendering.md) の持ち越しが済み、`thread-view-and-safe-html` の spec の承認の止めが外れる。

### 他の案を選ばなかった理由

- **2**：HTML5 の構文解析と XML 署名は仕様が大きく、自前の実装の差が浄化のすり抜けと署名の迂回になる。核でもない。
- **3**：利用者の IP・パスワードの断片・SAML の表明を外部に送ることになり、法務の L3・L5 に当たる。

## Consequences

- 良くなること：
  - group B の持ち越し（HTML5 の構文解析）が閉じる。SSO とパスキーを標準の実装で作れる。
  - 依存の種類とバージョンが CI で縛られる。
- 引き受けるコスト：
  - 部品ごとの脆弱性の追跡と更新。
  - 上限の層と設定の固定（XXE、`alg`）の試験を保守する。

## Confirmation

- 依存の検査（CI）：一覧の外の依存を拒む。
- 試験：SAML の署名の包み替え・XXE、`alg=none` の JWT、WebAuthn の偽の表明を拒む。HTML の差分のファジング（2 つの構文解析の比べ）。
- SBOM の照合（PR と毎日）。

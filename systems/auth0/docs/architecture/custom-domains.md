# Custom domains: Auth0

テナントのカスタムドメイン（`login.example.co.jp` など）の登録、所有の確認、証明書の発行と更新、ホスト名からテナントの解決、エッジの構成。MVP の後の複数のカスタムドメイン。

| 関連 | 決定 |
| --- | --- |
| [ADR-0038](../decisions/0038-custom-domain-verification-and-certificates.md) | TXT で所有を確かめてから配信のテナントを作る。証明書は CloudFront の管理（HTTP の検証）。定期の再確認と停止 |
| [ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md) | ホスト名からテナントを、プロセスの中のバージョン付きの対応表で解決する。外へ出す URL は登録したホスト名から作る |
| [ADR-0058](../decisions/0058-edge-and-custom-domains.md) | エッジは CloudFront＋WAF。カスタムドメインは CloudFront のマルチテナントの配信の、配信のテナントとして受ける |
| [ADR-0002](../decisions/0002-tenancy-and-isolation.md) | テナントの解決を DB を読む前に行う。S1 はカスタムドメインを 1 テナントに 1 つ |
| [ADR-0005](../decisions/0005-authentication-path-availability.md) | テナントの設定（ホスト名の対応表を含む）は、DB が読めない間も最後のバージョンで動く |

`issuer` の決め方は [authentication-flows.md](authentication-flows.md) の 4 節、パスキーの RP ID とカスタムドメインは [mfa-and-passkeys.md](mfa-and-passkeys.md) の 5.2.1 節、セッションの Cookie は [sessions-and-sso.md](sessions-and-sso.md)、エッジの WAF と DR は [security.md](security.md) と [ADR-0060](../decisions/0060-disaster-recovery-and-stages.md) にある。

## 1. 目的と範囲

- 目的：テナントの利用者が、テナントのドメインでログインできるようにする。他のテナントのドメインを奪えないこと、証明書の期限切れでログインが止まらないことを保つ。
- 範囲：ドメインの登録と状態、TXT の所有の確認、配信のテナントと証明書、ホスト名の対応表と解決、外へ出す URL の作り方、ドメインの削除と停止、MVP の後の複数のドメイン。
- 範囲の外：エッジの WAF のルールの値（infrastructure の領域）、テナントの送信ドメイン（[email-delivery.md](email-delivery.md)。同じドメインの別のレコードだが、状態は別に持つ）、エンタープライズ接続の振り分けのドメイン（[connections.md](connections.md) の 6 節）。

## 2. 本家の振る舞い（2026-09-27 に確認）

| 項目 | 本家 | 本システム |
| --- | --- | --- |
| 証明書 | Auth0 が管理（CNAME で確認、3 か月ごとに自動更新）か、自分で管理（Enterprise、TXT で確認、リバースプロキシが `cname-api-key` を付ける）（[Auth0-Managed Certificates](https://auth0.com/docs/customize/custom-domains/auth0-managed-certificates)、[Self-Managed Certificates](https://auth0.com/docs/customize/custom-domains/self-managed-certificates)） | CloudFront の管理だけ（MVP）。自分で管理は MVP の後 |
| 所有の確認 | CNAME（Auth0 の管理）。確認に失敗したら 4 時間以上あけて再試行 | TXT で先に確認し、その後に CNAME |
| CNAME の維持 | 更新のために常に要る。フラット化は非対応。DNS のプロキシが有効だと保留のまま | 同じ。apex は条件付き |
| 数 | 1 テナント 1 つ。Enterprise の複数のカスタムドメインは基本 20 まで（[Multiple Custom Domains](https://auth0.com/docs/customize/custom-domains/multiple-custom-domains)） | S1 は 1 つ、S2 から複数 |
| `iss` | 要求に使ったドメインになる（[Custom Domains](https://auth0.com/docs/customize/custom-domains)） | 同じ（authentication-flows） |
| 既存のテナントへの追加 | 既存のセッションは無効になり、再ログインが要る（同上） | 同じ |
| メールのリンク | カスタムドメインを使う。複数のときは Management API のヘッダーで選び、なければ既定のドメイン（同上） | 同じ。ヘッダーは `<Brand>-Custom-Domain` |
| パスキー | RP ID はドメインに結び付き、カスタムドメインの間で持ち越せない（同上） | mfa-and-passkeys の 5.2.1 節 |

## 3. ドメインの状態

### 3.1 表

```sql
CREATE TABLE custom_domains (
  tenant_id           uuid        NOT NULL,
  id                  uuid        NOT NULL,
  hostname            text        NOT NULL,   -- lower-case, Punycode, no trailing dot
  status              text        NOT NULL,   -- pending_verification | verified | provisioning | ready | failed | suspended | deleting
  status_reason       text,                   -- e.g. txt_not_found, caa_forbidden, cname_mismatch, cert_failed
  txt_token_hash      bytea       NOT NULL,   -- SHA-256 of the 128-bit value in _<brand>-challenge.<hostname>
  cname_target        text        NOT NULL,   -- <tenant-id>.edge.jp.<brand>.<domain>
  cf_tenant_id        text,                   -- CloudFront distribution tenant id
  cert_status         text,                   -- pending | issued | renewing | failed
  cert_not_after      timestamptz,
  last_checked_at     timestamptz,
  txt_missing_since   timestamptz,
  is_default          boolean     NOT NULL DEFAULT true,  -- default for emails (S2: one per tenant)
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  deleted_at          timestamptz,
  PRIMARY KEY (tenant_id, id)
);

-- Global uniqueness across tenants (outside RLS; written only by the management role).
CREATE UNIQUE INDEX custom_domains_active_hostname
  ON custom_domains (hostname) WHERE status IN ('verified','provisioning','ready','suspended');
```

- `tenant_hostnames`（[ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md)）は、`ready` のドメインと標準のホスト名だけを持つ、解決用の表。`custom_domains` の遷移で書く。
- 同じホスト名を、`pending_verification` の間は複数のテナントが登録できる。先に TXT の確認を通したほうだけが `verified` になる（一意の索引で保つ）。

### 3.2 状態機械

```
             POST /api/v2/custom-domains
                        │
                        ▼
              ┌──────────────────────┐  TXT を確認（Worker、5 分ごと、72 時間まで）
              │ pending_verification │───────────────────────────┐
              └─────────┬────────────┘                            │ 72 時間で未確認
                        │ TXT が一致（複数の DNS の問い合わせ先で）  ▼
                        ▼                                   ┌──────────┐
              ┌──────────────────────┐                      │ failed   │ ← 再確認の要求で pending へ
              │ verified             │                      └──────────┘
              └─────────┬────────────┘
                        │ 配信のテナントの作成、証明書の要求（CNAME が向いた後）
                        ▼
              ┌──────────────────────┐  証明書の失敗（CAA など） ──▶ failed
              │ provisioning         │
              └─────────┬────────────┘
                        │ 証明書の発行、/.well-known の確認、全タスクへの反映
                        ▼
              ┌──────────────────────┐  TXT が 30 日見えない、CNAME が別へ、テナントの停止
              │ ready                │─────────────────────────────▶ suspended ──(回復)──▶ ready
              └─────────┬────────────┘
                        │ DELETE（テナント）／テナントの削除
                        ▼
              ┌──────────────────────┐
              │ deleting             │ → tenant_hostnames から削除 → 配信のテナントを削除 → deleted_at
              └──────────────────────┘
```

| 遷移 | 誰が | 条件 | 副作用 |
| --- | --- | --- | --- |
| 登録 → `pending_verification` | テナントの管理者（Management API） | ドメインの制約（4.3 節）を満たす。1 テナントの上限（S1 は 1） | TXT の値を 1 回だけ応答で示す |
| → `verified` | Worker | TXT が 2 つ以上の独立した問い合わせ先で一致 | 監査ログ |
| → `provisioning` | Worker | CNAME が `cname_target` に向いている | 配信のテナントの作成、証明書の要求（`ValidationTokenHost=cloudfront`） |
| → `ready` | Worker | 証明書が発行、`https://<hostname>/.well-known/<brand>-domain-check` がテナントの ID を返す | `tenant_hostnames` に書き、通知。discovery をホスト名ごとに書き出す（authentication-flows） |
| → `suspended` | Worker・運用者 | TXT が 30 日見えない、CNAME が別の向き先、テナントの停止 | `tenant_hostnames` から外す（要求は 404）。配信のテナントは無効にして残す |
| → `deleting` | テナントの管理者・テナントの削除 | — | 解決から外した後、配信のテナントを消す |

- TXT が見えなくなって 7 日で、ダッシュボードとメールで警告する。
- 証明書の期限の 30 日前に `cert_status` が `issued` のまま更新されていなければ警告する（CloudFront の自動更新の失敗の検知）。

### 3.3 全体の流れ

```
管理者            Management API       Worker                        DNS（テナント）      CloudFront（edge アカウント）
  │ POST custom-domains │                 │                              │                     │
  │────────────────────▶│ 行を作る         │                              │                     │
  │◀─ TXT の値、CNAME の向き先            │                              │                     │
  │ TXT と CNAME を設定 ─────────────────────────────────────────────────▶│                     │
  │                     │                  │ TXT を問い合わせ（複数の先）─▶│                     │
  │                     │                  │ verified                      │                     │
  │                     │                  │ CNAME を確認 ────────────────▶│                     │
  │                     │                  │ CreateDistributionTenant ─────────────────────────▶│
  │                     │                  │ 証明書の要求（HTTP の検証）────────────────────────▶│ ACM（us-east-1）
  │                     │                  │ 発行を待つ（最大 72 時間）◀────────────────────────│
  │                     │                  │ /.well-known の確認 → ready → tenant_hostnames      │
  │◀─ Webhook・ダッシュボード「使えます」   │                              │                     │
```

- CloudFront の操作は、edge のアカウントのロールを引き受けた Worker だけが行う（[ADR-0058](../decisions/0058-edge-and-custom-domains.md)）。管理の経路のサービスは、CloudFront の API の権限を持たない。

## 4. 詳細

### 4.1 所有の確認

- レコード：`_<brand>-challenge.<hostname>  TXT  "<brand>-domain-verification=<128 ビットの値の base32>"`。
- 問い合わせ：本システムが運用する再帰のリゾルバーではなく、異なる事業者の 2 つ以上の公開のリゾルバー（DNS over HTTPS）で同じ値を得たときに確認とする。DNSSEC で検証できるゾーンは、検証の結果も使う。
- 同じホスト名を以前に別のテナントが使っていた場合でも、新しい TXT の値で確認する。削除から 30 日は、元のテナントだけが同じ値で復活できる（[ADR-0038](../decisions/0038-custom-domain-verification-and-certificates.md)）。

### 4.2 証明書

- CloudFront が管理する証明書（ACM、us-east-1、秘密鍵は取り出せない）。検証は HTTP（`ValidationTokenHost=cloudfront`）。1 テナントに保留の要求は 1 つだけ（[Request certificates for your CloudFront distribution tenant](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/managed-cloudfront-certificates.html)、2026-09-27 に確認）。
- ドメインがすでに別の CloudFront の配信を向いているとき（他の CDN からの移行）は、`_cf-challenge.<hostname>` の TXT が要る（同上）。テナントに追加の案内を出す。
- CAA のレコードがあり、Amazon の CA を許していないと発行に失敗する。`failed`（`caa_forbidden`）と、足すべきレコードを示す。
- TLS の方針は、本システムのドメインと同じ（TLS 1.2 以上。[security.md](security.md) の SEC-024）。HSTS はカスタムドメインにも付けるが、`preload` と `includeSubDomains` は付けない（テナントの他のサブドメインに影響するため）。

### 4.3 ドメインの制約

| 規則 | 理由 |
| --- | --- |
| 公開のサフィックス（Public Suffix List）そのものは不可 | 他の組織のドメインの上に立てない |
| `<brand>.<domain>` とその下は不可 | 本システムのドメインの横取り |
| ワイルドカードは不可 | 1 つのドメインに 1 つの証明書と確認 |
| IDN は Punycode で持ち、異なる文字体系の混在（ラテン文字とキリル文字など）は不可 | 見分けにくいドメインでのフィッシング |
| 長さ 253 文字以内、ラベルは 63 文字以内 | DNS の制約 |
| apex は、ALIAS・CNAME のフラット化に対応した DNS に限って許し、危険を示す | CNAME を置けない。本家はフラット化を支援しない |

### 4.4 ホスト名の解決

[ADR-0039](../decisions/0039-hostname-resolution-and-issuer.md) のとおり。要点：

- 各タスクのメモリーに、`tenant_hostnames` の全件をバージョン付きで持つ。変更は outbox → SQS の通知で反映する。
- 解決の順：`Host` を小文字にし、末尾のドットとポートを除く → 表を引く → なければ 404（DB を読まない）。
- `ready` の直前に、全タスクのバージョンがその変更を含むことを確かめる（最大 60 秒待つ）。これで「使えます」の通知の直後に 404 が出ない。
- オリジンは CloudFront からの要求だけを受ける。`X-Forwarded-Host` は読まない。

### 4.5 既存のテナントがドメインを足すとき

- 既存のアプリは標準のホスト名のまま動く。アプリがカスタムドメインに切り替えると、`issuer` が変わり、SSO のセッションは別になる（再ログイン）。
- パスキーの RP ID は、テナントで最初にパスキーを有効にした時点のホスト名に固定される（[mfa-and-passkeys.md](mfa-and-passkeys.md) の 5.2.1 節）。カスタムドメインを後から足すテナントには、ドメインの登録の画面で、パスキーへの影響（Related Origin Requests での継続か、再登録）を示す。
- ソーシャル IdP のコールバックの URL（`https://<hostname>/login/callback`）を、テナントが各 IdP に登録し直す必要がある。ドメインの登録の画面で、接続ごとの新しい URL を示す。
- メールのリンクは、`is_default` のドメインに切り替わる。

### 4.6 複数のカスタムドメイン（S2 以降）

- 1 テナントの上限を、プランで 1〜20 にする（本家の基本の 20 に寄せる）。配信のテナント 1 つに、ドメイン 1 つ（テナントごとの証明書と停止を独立に保つため）。
- `is_default` はテナントに 1 つ。Management API のメールを送る操作は、`<Brand>-Custom-Domain` のヘッダーで、テナントの `ready` のドメインから選べる。ヘッダーの値がテナントのドメインでなければ 400。
- `issuer` はドメインごと。アプリごとに「このアプリが使うドメイン」は登録させない（12 節の決定）。
- 配信のテナントの上限（アカウントに 1 万）に対し、S2 の本番 3 万テナント×複数のドメインでは足りない。S2 の前に、まず上限の引き上げを申請し、足りなければ edge のアカウントを分ける（12 節の決定。[ADR-0058](../decisions/0058-edge-and-custom-domains.md)）。

## 5. 障害時の振る舞い

| 障害 | 振る舞い |
| --- | --- |
| CloudFront の API の障害 | 新しいドメインの `provisioning` が止まる。既存のドメインは影響なし。Worker が再試行 |
| 証明書の発行の遅れ | `provisioning` のまま最大 72 時間。24 時間で警告 |
| 証明書の自動更新の失敗 | 期限の 30 日前から警告。テナントの DNS の変更（CNAME の削除）が原因なら、テナントに通知 |
| DB が読めない | 解決は最後のバージョンで続く。ドメインの追加・削除は止まる |
| 通知（SQS）の遅れ | 新しいドメインの反映が遅れる。`ready` の前の全タスクのバージョンの確認で、「使えます」の通知を遅らせる |
| テナントの DNS の誤り（CNAME の削除） | そのドメインの要求が届かない（本システムの側では検知だけ）。日次の確認で警告 |
| 東京のリージョンの障害 | 配信のテナントのオリジンを大阪へ切り替える（[ADR-0060](../decisions/0060-disaster-recovery-and-stages.md)）。証明書は CloudFront にあるので影響なし |

## 6. セキュリティ

| 脅威 | 対策 |
| --- | --- |
| 他人のドメインの登録（乗っ取り） | TXT の所有の確認を先に行う。複数の問い合わせ先での一致 |
| dangling CNAME（テナントが解約した後の CNAME の残り） | 削除の後は新しい TXT の確認が要る。CNAME の向き先はテナントの ID を含む名前で、削除したテナントの向き先は解決しない |
| 所有の喪失（ドメインの売却・失効） | 24 時間ごとの TXT の確認、30 日で停止 |
| ホストのヘッダーの偽装 | オリジンは CloudFront からだけ。表にないホスト名は 404。外へ出す URL は表の値から |
| 見分けにくいドメインでのフィッシング | 文字体系の混在の拒否 |
| テナント間の取り違え | 一意の索引、解決の性質ベーステスト（8 節） |
| 証明書の秘密鍵の漏えい | 秘密鍵を本システムが持たない（CloudFront の管理） |
| 管理者のアカウントの乗っ取りでのドメインの付け替え | ドメインの追加・削除を監査ログに残し、全管理者にメールで知らせる。削除は再認証を求める |

## 7. 性能と上限

| 項目 | S1 | 備考 |
| --- | --- | --- |
| 1 テナントのカスタムドメイン | 1 | S2 から 1〜20 |
| 配信のテナント | 本番 3,000 ＋ 開発・ステージング（カスタムドメインは本番のテナントに限るかは 9 節） | アカウントの既定の上限は 1 万（[Quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)） |
| 登録から `ready` まで | DNS の設定の後、p50 15 分以内 | 証明書の発行の時間に依る |
| ホスト名の反映 | 60 秒以内 | 4.4 節 |

## 8. テスト

### 8.1 決定表：遷移

| # | 今の状態 | TXT | CNAME | 証明書 | `/.well-known` | 期待 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `pending_verification` | 一致（2 つの先） | — | — | — | `verified` |
| 2 | `pending_verification` | 1 つの先でだけ一致 | — | — | — | そのまま |
| 3 | `pending_verification` | 72 時間なし | — | — | — | `failed`（`txt_not_found`） |
| 4 | `verified` | 一致 | 別の向き先 | — | — | そのまま、案内 |
| 5 | `provisioning` | 一致 | 一致 | CAA で拒否 | — | `failed`（`caa_forbidden`） |
| 6 | `provisioning` | 一致 | 一致 | 発行 | 別のテナントの ID | そのまま、運用者へ警報 |
| 7 | `provisioning` | 一致 | 一致 | 発行 | 一致 | `ready` |
| 8 | `ready` | 30 日なし | 一致 | 有効 | — | `suspended` |
| 9 | 別のテナントが同じホスト名で `ready` | 一致 | — | — | — | `verified` にならない |

### 8.2 性質ベーステスト（fast-check）

テスト名には要件 ID を含める（開発リポジトリで採番する）。

- 任意のテナント・ホスト名の登録・確認・削除の操作の列で、どの時点でも、1 つのホスト名が `ready` のテナントは高々 1 つ。
- 任意のホスト名の文字列（大文字、末尾のドット、ポート、Unicode、Punycode）で、解決の結果は「正規化の後に一致する行」か「なし」のどちらかで、別のテナントには解決しない。
- 任意の要求のヘッダーの組（`Host`、`X-Forwarded-Host`、`Forwarded`）で、外へ出す URL のホスト名は、解決した表の値。
- 任意の状態の列で、`suspended`・`deleting` のドメインは `tenant_hostnames` にない。

### 8.3 その他

- 結合テスト（staging の実際の CloudFront）：[ADR-0058](../decisions/0058-edge-and-custom-domains.md) の Confirmation（作成、証明書、ログインからトークンまで、削除で届かない）。
- DNS の模擬（複数のリゾルバーの応答を変える）で、4.1 の確認の規則を確かめる。
- 合成監視：本番の監視用のテナントのカスタムドメインで、1 分ごとにログインとトークンの発行（[ADR-0062](../decisions/0062-sli-and-synthetic-monitoring.md)）。

## 9. ADR

| ADR | 決定 | 状態 |
| --- | --- | --- |
| [0038](../decisions/0038-custom-domain-verification-and-certificates.md) | カスタムドメインは TXT で所有を確かめてから配信のテナントを作り、証明書は CloudFront の管理に任せる | accepted |
| [0039](../decisions/0039-hostname-resolution-and-issuer.md) | ホスト名からテナントを、DB を読まずにプロセスの中の対応表で解決し、リンクとリダイレクトは要求のヘッダーではなく登録したホスト名から作る | accepted |

## 10. Story の候補

| Epic | Story の候補 |
| --- | --- |
| E1 | edge のアカウント、マルチテナントの配信の雛形、Worker のロールの引き受け（infrastructure と一緒に） |
| E2 | `tenant_hostnames` と、プロセスの中の対応表、変更の通知、標準のホスト名の解決（DB を読まない 404） |
| E3 | ホスト名ごとの `issuer` と discovery の書き出し（authentication-flows と一緒に） |
| E4 | メール・再設定のリンクのホスト名を表から作る（ホストのヘッダーの注入の否定側のテスト） |
| E7 | カスタムドメインの登録の画面での、パスキーの RP ID への影響の表示（mfa-and-passkeys と一緒に） |
| E9 | ダッシュボードのカスタムドメインの画面（TXT・CNAME の案内、状態、再確認） |
| E10 | ドメインの状態の変化のログとログストリーム |
| E11 | `custom_domains` の表と状態機械、TXT の確認（複数のリゾルバー）、配信のテナントと証明書、`/.well-known` の確認、`ready` の反映の待ち |
| E11 | 定期の確認（TXT・CNAME・証明書の期限）、警告、`suspended`、削除と 30 日の復活 |
| E11 | ドメインの制約（4.3 節）と、IDN の混在の拒否 |
| E12 | カスタムドメインの合成監視、配信のテナントの上限の見直し、DR の訓練でのオリジンの切り替え |

E5・E6・E8・E13・E14 には、この領域の Story はない（E6 のコールバックの URL の案内は E11 の画面に含める）。組織ごとのカスタムドメインは持たない（[organizations.md](organizations.md) の 7 節、[ADR-0051](../decisions/0051-organization-model-and-login-flow.md)）。

## 11. 品質・運用・データへの引き継ぎ

- [quality.md](../quality.md) に入れる候補：
  - リスク：他のテナントのドメインの乗っ取りと、解決の取り違え（NFR-008 に直結）。8.2 の性質ベーステストを E11 のリリースの基準にする。
  - staging の実際の CloudFront での結合テスト（作成から削除まで）を、エッジの設定の変更ごとに回す。
  - 本番での検証：`ready` までの時間の分布、`failed` の理由の内訳、`suspended` の件数、証明書の期限の最小値を日次で見る。
- [runbooks/](../runbooks/README.md) に入れる候補：
  - 証明書の更新の失敗（期限の 30 日前の警告）：原因（CNAME、CAA、CloudFront）の切り分けと、テナントへの連絡。
  - ドメインの所有の争い（別の組織が「自分のドメインだ」と申し立てる）：TXT の確認の記録の提示、停止の判断、法務への連絡。
  - テナントのドメインが `suspended` になったときの問い合わせと、回復の手順。
  - 配信のテナントの上限への接近（8 割で警報）と、上限の引き上げの申請。
  - 6 節の 8.1 の行 6（`/.well-known` が別のテナントを返す）の警報：取り違えの疑いとして、そのドメインを止めて調べる。
- [data-model.md](data-model.md) の索引に入れる候補：`custom_domains`（この領域が持つ）、`tenant_hostnames`（この領域が持つ。テナントをまたぐ表で RLS の外）。

## 12. 未解決の問い

- 開発・ステージングのテナントにカスタムドメインを許すか。配信のテナントの上限を消費する。
- 自分で管理する証明書（テナントのリバースプロキシ）を、MVP の後に提供するか。Enterprise の需要と、プロキシの誤りの危険の比較。
- 複数のカスタムドメインで、アプリごとに使うドメインを縛るか（`issuer` の取り違えを減らす）。
- `<brand>.<domain>` の Public Suffix List への登録（[universal-login.md](universal-login.md) の 17 節と同じ問い）。

### 決定（2026-09-27、既定案）

- **所有の確認**：TXT を先に（本家の CNAME だけと違う）。
- **証明書**：CloudFront の管理だけ。持ち込みの証明書と自分で管理は MVP の後。
- **再確認**：24 時間ごと。TXT が 7 日見えなければ警告、30 日で停止。
- **削除の後の復活**：30 日、同じテナントだけ。
- **apex**：条件付きで許す。
- **開発・ステージングのテナント**：S1 は 1 つまで許す（上限に余裕がある）。S2 の前に見直す。

### 決定（2026-09-27、推奨案で確定）

- **自分で管理する証明書**：MVP の後の「後回し」に置く（[roadmap.md](../roadmap.md)）。MVP は CloudFront の管理だけ。
- **複数のカスタムドメインでアプリごとにドメインを縛るか**：縛らない。`iss` は要求のホスト名で決まり、`/oauth/token` を認可の要求と別のホスト名で呼ぶと `invalid_grant` になる（[authentication-flows.md](authentication-flows.md) の 4 節）ので、取り違えはそこで止まる。複数のカスタムドメインは S2。
- **Public Suffix List**：`jp.<brand>.<domain>` を登録する（[universal-login.md](universal-login.md) の 17 節）。
- **配信のテナントの上限**：S2 の前に、まず AWS に上限の引き上げを申請する。足りなければ edge のアカウントを分ける（[ADR-0058](../decisions/0058-edge-and-custom-domains.md)）。
- **複数のリゾルバー**：DNS over HTTPS の公開のリゾルバーを 2 つ（Google Public DNS と Cloudflare の 1.1.1.1）使い、両方で同じ値が見えたときに確認とする（4.1 節）。問い合わせるのはテナントが登録したドメイン名と TXT の値だけで、個人データを含まない。

持ち越し：

| 項目 | いつ・どう決めるか |
| --- | --- |
| CloudFront の管理する証明書の発行の時間の実測（p50 15 分の目標の妥当性） | E11 の staging |

## References

- Auth0 Docs: [Custom Domains](https://auth0.com/docs/customize/custom-domains)、[Configure Custom Domains with Auth0-Managed Certificates](https://auth0.com/docs/customize/custom-domains/auth0-managed-certificates)、[Self-Managed Certificates](https://auth0.com/docs/customize/custom-domains/self-managed-certificates)、[Multiple Custom Domains](https://auth0.com/docs/customize/custom-domains/multiple-custom-domains)（2026-09-27 に確認）
- AWS: [Request certificates for your CloudFront distribution tenant](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/managed-cloudfront-certificates.html)、[CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html)、[Amazon CloudFront SaaS Manager の発表（2025-04-28）](https://aws.amazon.com/blogs/aws/reduce-your-operational-overhead-today-with-amazon-cloudfront-saas-manager/)（2026-09-27 に確認）
- AWS: [ACM DNS validation](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)、[ACM quotas](https://docs.aws.amazon.com/acm/latest/userguide/acm-limits.html)、[CloudFront の証明書の要件（us-east-1）](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)（2026-09-27 に確認）
- OWASP: [Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)（ホストのヘッダーの注入。2026-09-27 に確認）
- Mozilla: [Public Suffix List](https://publicsuffix.org/)

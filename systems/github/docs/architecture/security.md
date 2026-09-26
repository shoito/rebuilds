# Security: GitHub

脅威モデル、セキュリティの統制、暗号化と鍵、秘密情報、監査ログ、濫用対策、脆弱性の管理、インシデント対応、コンプライアンス、データのライフサイクル。

| 関連 | 決定 |
| --- | --- |
| [ADR-0002](../decisions/0002-repository-permission-model.md) | 権限はリポジトリの単位の判定関数 `can(actor, action, resource)` に集約する |
| [ADR-0003](../decisions/0003-replicated-git-storage.md) | リポジトリは 3 つのノードに複製する |
| [ADR-0004](../decisions/0004-stateless-git-frontend.md) | Git の要求は状態を持たないフロントエンドで受け、ストレージのノードを外部から隔離する |
| [ADR-0005](../decisions/0005-git-as-source-of-truth.md) | 中身の正本は Git、メタデータの正本は DB。ref の更新は outbox の Event になる |
| [ADR-0028](../decisions/0028-encryption-and-key-management.md) | 暗号化と鍵管理 |
| [ADR-0029](../decisions/0029-audit-log.md) | 監査ログ |
| [ADR-0030](../decisions/0030-data-retention-and-deletion.md) | データの保持と削除、リポジトリの復元 |

本家の数字と方針は、2026-09-26 に docs.github.com と GitHub のブログで確かめた。確かめられなかったものは「未検証」と書く。

## 1. 目標と前提

- **目標水準は OWASP ASVS 5.0 の Level 2**。Slack の題材と同じ。認可・鍵・監査ログに関わる Level 3 の要件は個別に取り込む。
- **最も重い障害は 2 つ。**
  1. 非公開のリポジトリの中身が、権限のない人に見える（NFR-010）。
  2. 受け付けた push が失われる、または改ざんされる（NFR-002）。
  どの統制も、まずこの 2 つを防ぐことを優先する。
- **信頼できない入力が本質である。** 任意の Git のオブジェクト、Markdown・SVG・ノートブック、CI のジョブのコードを、毎秒大量に受け取る。これらを解釈・描画・実行する部分は、それぞれ決めた隔離の環境でだけ扱う（[AGENTS.md](../../AGENTS.md)）。
- **トークンは主要な攻撃面である。** 人・OAuth のアプリ・App・CI・AI エージェントが、トークンでリポジトリを読み書きする。漏洩を前提に、検知と一斉の失効を設計に含める（12 節）。
- **AI エージェント（コーディング）は本番に一切アクセスしない。** Slack の security.md の 7.3 節と同じ。
- 本番の変更は、すべて PR・CI・IaC（Terraform）を通す。

## 2. 信頼境界

```
  ┌───────────────────────── インターネット（信頼しない）──────────────────────────┐
  │ git クライアント  ブラウザ  API の利用者・AI エージェント  攻撃者  Webhook の受信先 │
  └───┬──────────────┬───────────────┬─────────────────────────────▲──────────────┘
      │ SSH・HTTPS    │ HTTPS          │ HTTPS                        │ 外向きのみ
  ════╪══════════════╪═══ B1: エッジ（NLB / CloudFront＋WAF＋Shield）══╪══════════════
      │              │                │                        ┌────┴──────────────┐
      │         ┌────▼─────────┐ ┌────▼──────────┐             │ Webhook の送信器  │
      │         │ github 相当の │ │ usercontent   │             │ （VPC の外・     │
      │         │ アプリの      │ │ 相当の別ドメイン│             │  内部へ経路なし） │
      │         │ ドメイン      │ │ raw・添付・    │             └────▲──────────────┘
      │         └────┬─────────┘ │ 画像のプロキシ │                  │
      │              │           └────┬──────────┘                  │
  ┌───▼──────────────▼────────────────▼── VPC：アプリ層 ─────────────┼──────────────┐
  │ Git フロントエンド    Web・API        Worker（通知・検索・Webhook・Actions の配置）│
  │    │  ═══ B2: 認可（判定関数 can）═══   │                                        │
  │    ▼                                   ▼                                        │
  │ ═══ B3: ストレージのプレーン（mTLS。フロントエンド・API・Worker からの RPC だけ）═══ │
  │ Git ストレージのノード（3 複製）  Aurora  検索のクラスタ  SQS  S3                   │
  └──────────────────────────────────────────────────────────────────────────────┘
  ═══ B4: Actions の実行環境（別の AWS アカウント・別の VPC。内部への経路なし）═══════
  ═══ B5: 管理プレーン（CI/CD の OIDC、運用者の SSO＋MFA、KMS、Secrets Manager）═════
  ─ ─ B6: 開発環境（AI コーディングエージェント）… 本番への経路なし ─ ─ ─ ─ ─ ─ ─ ─ ─
```

| 境界 | 越えるもの | 主な統制 |
| --- | --- | --- |
| B1 エッジ | すべての外部の要求 | TLS、WAF（HTTP の経路）、Shield。SSH は NLB で受け、接続数と認証の失敗をフロントエンドで制限する |
| B2 認可 | 利用者のあらゆる読み書き | 判定関数（ADR-0002）。存在しないものと権限がないものは同じ 404 を返す |
| B3 ストレージ | Git の中身の読み書き | ストレージのノードはインターネットにも Actions にも経路を持たない。RPC は mTLS で、呼び出し元のサービスを証明書で限定する。RPC は認可済みの要求だけを受ける前提で、リポジトリの ID を必須にする |
| B4 Actions | 利用者のコードの実行 | 別の AWS アカウント。ジョブごとの使い捨ての VM。内部への経路を持たず、API へはインターネット側から入る（[actions.md](actions.md)） |
| B5 管理 | デプロイ、鍵、運用者の操作 | OIDC による短命な認証情報、最小権限、人の承認、監査ログ |
| B6 開発環境 | コード（PR としてのみ） | 本番の認証情報を置かない |
| Webhook の送信 | 利用者が指定した URL への送信 | VPC に接続しない送信器。名前解決後の IP の検査（[api-and-webhooks.md](api-and-webhooks.md)） |

### ドメインの分離

本家は、信頼できない内容を `*.githubusercontent.com` という別の登録可能ドメインから配り、`github.com` の Cookie とセッションに届かないようにしている（[GitHub Bug Bounty: *.githubusercontent.com](https://bounty.github.com/targets/githubusercontent-com.html)）。これに倣う。ドメインの名前は、リポジトリ共通の [ADR-0006](../../../../docs/decisions/0006-brand-neutral-identifiers.md) に従い `<brand>usercontent.<domain>` の形にし、サブドメインの分け方は [web.md](web.md) の 5.1 節に合わせる。

| ドメイン（仮） | 配るもの | 条件 |
| --- | --- | --- |
| アプリのドメイン | 画面、API | 利用者の内容を HTML として直接返さない |
| `raw.<brand>usercontent.<domain>` | ファイルの生の中身 | `Content-Type: text/plain`（画像などの既知の型を除く）、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: default-src 'none'; sandbox`。非公開のリポジトリは短命なトークン付きの URL だけで配る |
| `media.<brand>usercontent.<domain>` | Issue・PR の添付、アバター、LFS の画像 | 同上。添付は S3 から CloudFront の署名付き URL |
| `camo.<brand>usercontent.<domain>` | Markdown の外部画像のプロキシ | 閲覧者の IP を外部に出さない。画像以外の型は返さない。内部のアドレスへの取得を禁止する（SSRF） |
| `render.<brand>usercontent.<domain>` | ノートブック・Mermaid などの描画 | sandbox 付きの iframe の中でだけ描画する（[web.md](web.md)） |

## 3. 脅威モデル（STRIDE）

S＝なりすまし、T＝改ざん、R＝否認、I＝情報漏洩、D＝サービス妨害、E＝権限昇格。主要な脅威と対策だけを書く。

### 3.1 Git フロントエンド（SSH・HTTPS）

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | 盗んだ SSH の鍵・トークンでの接続 | 鍵・トークンの失効を数秒で反映する（12 節）。弱い鍵の登録を拒否する（RSA 2048 bit 未満、DSA）。トークンは DB にハッシュだけを置く（ADR-0028） |
| S | SSH のホスト鍵のなりすまし・漏洩 | ホスト鍵は Secrets Manager に置き、フロントエンドのメモリにだけ展開する。フィンガープリントを API（meta 相当）と文書で公開する。種類（Ed25519・ECDSA・RSA）ごとに独立して入れ替えられるようにする。本家は 2023-03-24 に RSA のホスト鍵が公開のリポジトリに一時露出し、RSA だけを入れ替えた（[We updated our RSA SSH host key](https://github.blog/news-insights/company-news/we-updated-our-rsa-ssh-host-key/)） |
| I | 権限のないリポジトリの `upload-pack` | 判定関数を通してからストレージにつなぐ（ADR-0004）。fork のネットワークでオブジェクトを共有していても、要求したリポジトリから到達できるオブジェクトだけを返す（[git-storage.md](git-storage.md)） |
| T | 保護されたブランチへの不正な ref の更新 | `receive-pack` の前に ruleset を評価する（[pull-requests.md](pull-requests.md)）。push は ADR-0003 の合意の後にだけ成功を返す |
| D | 巨大な clone の大量実行、遅い接続の占有 | 接続の数・時間・転送量の上限。アカウント・IP・リポジトリごとの同時実行の上限（[git-protocols.md](git-protocols.md)） |
| R | push・clone を誰がしたか追えない | push は監査ログ（ADR-0029）。clone・fetch は内部のアクセスログ（トークンの ID を含む） |

### 3.2 Git ストレージ

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| T | 悪意あるオブジェクト（壊れたツリー、`.gitmodules` による攻撃、深すぎる差分の連鎖、巨大なパック） | `receive.fsckObjects` を有効にし、`.gitmodules` の検査を含む fsck を push で行う。パックとオブジェクトのサイズ、差分の深さの上限（[git-protocols.md](git-protocols.md)） |
| E | Git の本体の脆弱性（パックの解析、`upload-pack` の不具合） | Git の本体の版を固定し、脆弱性の修正を 11 節の期限で全ノードに入れる（ADR-0001）。Git のプロセスは専用の非特権ユーザーで、seccomp とリソースの上限をかけて動かす |
| I | パスの取り違え（名前の変更・移譲の直後に、別のリポジトリを読む） | ディスク上のパスは名前ではなくリポジトリの ID から作る。RPC はリポジトリの ID を必須にする |
| T・R | 運用者によるディスクの直接の改ざん | ノードへの人のログインは break-glass に限り、セッションを記録する。3 つの複製のチェックサムの定期の照合（ADR-0003）で食い違いを検知する |
| I | ディスク・バックアップの持ち出し | 保存時の暗号化（ADR-0028）。ノードの廃棄時は、インスタンスストアの鍵が消える（ADR-0028） |
| D | 1 つのリポジトリがノードの CPU・I/O を占有 | リポジトリごとの同時実行の上限、重い RPC（blame、巨大な差分）のタイムアウト（[capacity.md](capacity.md)） |

### 3.3 Web・信頼できない内容の描画

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| T | Markdown・SVG・ノートブック・ファイル名・コミットのメッセージによる XSS | Markdown は許可リストで無害化した HTML を描画する。SVG とノートブックは別ドメインの sandbox で描画する。厳格な CSP（nonce 付き、`frame-ancestors 'none'`）。[web.md](web.md) |
| I | 外部画像による閲覧者の IP・閲覧の事実の漏洩、非公開の URL の露出 | 画像のプロキシ（camo 相当）を通す。CSP の `img-src` に外部を許さない |
| S | セッションの窃取・固定、CSRF、クリックジャッキング | `__Host-` の Cookie（`HttpOnly`、`Secure`、`SameSite=Lax`）。状態を変える要求は CSRF トークンと `Origin` の検査。`X-Frame-Options: DENY` |
| E | 高い影響の操作（トークンの作成、Webhook の編集、Organization のセキュリティ設定、リポジトリの削除・公開への変更）の乗っ取り | 再認証（sudo モード）を求める。本家も、Entra ID を IdP にする EMU の Enterprise で、これらの操作に再認証・MFA を求める「proof of presence」を 2026-09-24 に公開した（[Changelog](https://github.blog/changelog/2026-09-24-require-proof-of-presence-for-high-impact-actions/)） |
| I | 非公開のリポジトリの存在の推測 | 権限がなければ 404。名前の変更後のリダイレクトも判定関数を通す |

### 3.4 API・トークン

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| S | トークンの漏洩・推測 | 本家と同じく、種類を示す接頭辞とチェックサムを持つ形式にする（`<brand>p_` など。本家の `ghp_` に相当。名前は ADR-0006。本家は CRC32 を Base62 で末尾 6 桁に置き、DB を引かずに誤検知を減らす。[Behind GitHub's new authentication token formats](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/)）。DB には SHA-256 のハッシュだけを置く |
| S | 公開のリポジトリへのトークンの push | 自社のトークンの形式を push の経路で走査し、公開のリポジトリ・gist 相当に入った有効なトークンは自動で失効する。本家も同じ（[Token expiration and revocation](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation)） |
| E | スコープの越権、App のインストールの範囲外への読み取り | トークンのスコープは判定関数の材料の 1 つで、権限を広げない（ADR-0002）。App のインストールのトークンは 1 時間で失効する（本家と同じ。[identity-and-permissions.md](identity-and-permissions.md)） |
| E | 長期のトークンの放置 | 1 年使われていない OAuth のトークン・PAT は自動で失効する（本家と同じ）。有効期限の設定を既定にする |
| D | 重い GraphQL のクエリ、大量の呼び出し | クエリの費用の上限、レート制限（[api-and-webhooks.md](api-and-webhooks.md)） |
| R | どのトークンが何をしたか追えない | 認証済みの要求はすべて、トークンの ID を内部のアクセスログに残す（ADR-0029） |

### 3.5 Actions の実行環境

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| E | ジョブから他のジョブ・他のリポジトリのシークレットへ到達 | ジョブごとの使い捨ての VM（コンテナではなく VM の境界）。実行環境は別の AWS アカウントで、本番の VPC・メタデータのエンドポイントへ経路を持たない（[actions.md](actions.md)） |
| I | fork からの PR のワークフローによるシークレットの持ち出し | fork からの PR では、`<BRAND>_TOKEN`（読み取り）以外のシークレットを渡さない（本家と同じ）。`pull_request_target` の危険を文書で示す |
| I | ログへのシークレットの出力 | 登録されたシークレットの値をログで伏せる。ただし変換された値は伏せられない（本家も「保証しない」と明記。[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)） |
| S | `<BRAND>_TOKEN` の横流し | ジョブの終了で失効し、最長 24 時間。対象は 1 つのリポジトリで、権限はワークフローで絞れる（既定は読み取り） |
| T | キャッシュの汚染（別のブランチのジョブが書いたキャッシュを保護されたブランチが読む） | キャッシュを ref の単位で分け、既定のブランチからだけ他のブランチへ読ませる |
| D | 暗号資産の採掘、攻撃の踏み台 | 6 節 |

### 3.6 Webhook の送信

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | SSRF（内部のアドレス、メタデータのエンドポイント） | VPC に接続しない送信器。名前解決後の IP の検査、リダイレクトを追わない |
| I | 権限を失った後の配信、非公開のリポジトリの中身の配信 | 配信の直前に、Webhook の持ち主（リポジトリ・Organization・App）の権限を判定関数で確かめ直す |
| S・T | 配信の偽装・改ざん | HMAC-SHA256 の署名（`X-<Brand>-Signature-256`。本家の `X-Hub-Signature-256` と同じ方式）。送信元の IP の範囲を meta 相当の API で公開する |
| D | 遅い受信先による送信の詰まり | タイムアウト（10 秒）、受信先ごとの同時実行の上限、失敗が続く受信先の無効化 |

### 3.7 検索

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 非公開のリポジトリのコード・Issue が検索の結果・件数・スニペットから漏れる | 索引の文書にリポジトリの ID と公開の種類を持たせ、クエリの前段で絞る（ADR-0002）。件数・ファセットも絞った後の値にする |
| I | 権限の剥奪・公開から非公開への変更・削除の後に、古い索引が返る | 権限はクエリ時に判定し、索引の中身は変更の Event で消す（NFR-005 と同じ速さ） |
| D | 高価な正規表現 | 正規表現のエンジンを線形時間のものに限り、クエリのタイムアウトを持つ（[search.md](search.md)） |

### 3.8 通知・メール

| 種類 | 脅威 | 対策 |
| --- | --- | --- |
| I | 権限を失った人へ、非公開のリポジトリの内容をメールで送る | 送信の直前に判定関数で確かめ直す（[notifications.md](notifications.md)） |
| S | メールへの返信によるなりすましの投稿 | 返信用のアドレスに、受信者とスレッドに束縛した推測できないトークンを入れる。DKIM・SPF の検査 |
| I | メールの本文が組織の外に転送される | Organization が、通知のメールを確認済み・承認済みのドメインのアドレスだけに送るよう制限できる。本家は Enterprise Cloud の機能で、外部のコラボレーターは対象外（[Restricting email notifications for your organization](https://docs.github.com/en/enterprise-cloud@latest/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/restricting-email-notifications-for-your-organization)） |

## 4. 統制の一覧

| 領域 | 統制 | 確認方法 |
| --- | --- | --- |
| 認可 | 判定関数の集約、経路ごとの前段の絞り込み | 性質ベーステスト、経路ごとの漏洩テスト（ADR-0002） |
| 認証 | パスワード＋2FA、パスキー、SSH の鍵、トークン、SAML SSO（[identity-and-permissions.md](identity-and-permissions.md)） | 同左 |
| 2FA の必須化 | コードを書く利用者に 2FA を求める（5 節） | 必須化の対象の登録率を監視 |
| 暗号化 | TLS、KMS の CMK、機密性の高い列のアプリ層の暗号化 | ADR-0028 の Confirmation |
| 秘密情報 | Secrets Manager、Actions のシークレットのエンベロープ暗号化 | 9 節 |
| 監査 | Organization・Enterprise の監査ログ、個人のセキュリティログ、内部のアクセスログ | ADR-0029 の Confirmation |
| 秘密情報の走査 | 自社のトークンの自動失効（MVP）、push protection（後の Epic） | 10 節 |
| 描画の隔離 | 別ドメイン、CSP、sandbox | DAST、ヘッダーの結合テスト |
| 実行の隔離 | Actions の VM、別アカウント | 脱出の演習、ペネトレーションテスト |
| 濫用 | レート制限、新規アカウントの制限、Actions の採掘の検知、通報 | 6 節 |
| サプライチェーン | Slack の security.md の 8 節と同じ（ロックファイル、SHA 固定の Actions、SBOM、SLSA の来歴） | 同左 |
| 検知 | GuardDuty、Security Hub、AWS Config、アプリのセキュリティイベント | [observability.md](observability.md) |
| 運用者のアクセス | SSO＋MFA、最小権限、break-glass、四半期のアクセスレビュー | アクセスレビューの記録 |

## 5. 認証の強さ

- **2FA の必須化**：本家は 2023 年 3 月から、GitHub.com でコードに貢献する利用者に 2FA を求めている。対象は、リリースの作成、Action・App の公開、Organization の owner・Enterprise の管理者などで、45 日の登録期間と 7 日の猶予の後、有効にしないとアクセスを止める（[About mandatory two-factor authentication](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa/about-mandatory-two-factor-authentication)）。
  - 本システムも本家の条件に寄せ、Organization の owner、リポジトリの admin、App・OAuth アプリの持ち主、リリースの作成者に、45 日の登録期間と 7 日の猶予で 2FA を求める（[ADR-0019](../decisions/0019-authentication-and-token-model.md)、[identity-and-permissions.md](identity-and-permissions.md) の 3.1 節）。方式は TOTP、パスキー・セキュリティキー。SMS は提供しない。
  - Organization は、メンバーに 2FA を必須にできる（本家と同じ。外れる対象は identity-and-permissions.md の 3.1 節）。
- **高い影響の操作は再認証を求める**（sudo モード。[identity-and-permissions.md](identity-and-permissions.md) の 3.1 節）。
- パスワードの漏洩の検査（既知の漏洩したパスワードの拒否）を登録と変更の時に行う。

## 6. 濫用・スパム・マルウェアの配布への対策

| 対象 | 脅威 | 対策 |
| --- | --- | --- |
| アカウント | スパムのアカウントの大量作成 | 作成時のレート制限（IP・メールのドメイン）、メールの確認、WAF の Challenge。作成直後のアカウントの操作（Issue・コメント・リポジトリの作成）の上限を低く始め、実績で上げる |
| Issue・PR・コメント | スパム、嫌がらせ | 利用者のブロック、リポジトリの操作の制限（interaction limits）、会話のロック、通報。スパムの判定で非表示にする |
| リポジトリ・リリース | マルウェアの配布、攻撃の基盤（C2） | 本家の方針に倣う：研究目的の二重用途の内容（エクスプロイト、マルウェアの解析）は認める。能動的な攻撃の配布・基盤としての利用は禁止し、認証の後ろに隠すか、削除する（[Active malware or exploits](https://docs.github.com/en/site-policy/acceptable-use-policies/github-active-malware-or-exploits)）。リリースの成果物を既知のマルウェアのハッシュと照合する |
| Actions | 暗号資産の採掘、攻撃の踏み台、無料の実行時間の濫用 | 新規アカウント・公開のリポジトリのジョブの同時実行の上限、採掘のプロセスと通信の検知、外向きの通信量の監視、検知時のアカウントの停止（[actions.md](actions.md)） |
| 公開のリポジトリ | 大量の clone（収集） | 人気のリポジトリの bundle-uri と CDN、リポジトリごと・IP ごとの clone のレート制限（[git-protocols.md](git-protocols.md) の 8 節、[capacity.md](capacity.md) の 4 節。2026-09-26 の決定） |

### 運用者による措置

本家の Community Guidelines は、内容の削除、無効化、公開範囲の引き下げ、アカウントの非表示、停止を挙げる（[GitHub Community Guidelines](https://docs.github.com/en/site-policy/github-terms/github-community-guidelines)）。これを、リポジトリとアカウントの状態として持つ。

| 状態 | 対象 | 見え方 |
| --- | --- | --- |
| `disabled`（濫用） | リポジトリ | 持ち主にも読めない。API・Git は拒否する |
| `disabled`（法的な理由） | リポジトリ | HTTP 451 を返す（本家が 451 を返すという公式の記述は見つからない。2026-09-26 に docs.github.com の DMCA と政府の削除の方針を確認。**未検証**。451 は RFC 7725 の意味に合うので本システムの判断とする） |
| `hidden` | アカウント | 他人からはプロフィール・内容が見えない。本人は操作できる |
| `suspended` | アカウント | ログインと、すべてのトークン・SSH の鍵の利用を止める |

- 措置は、理由とケースの ID を付けて内部の監査ログ（`platform_audit_events`）に残す。
- 措置の判定の関数は、判定関数（ADR-0002）の材料に加える。経路ごとに別の実装をしない。
- 異議の申し立ての窓口を持つ。

### DMCA と法的な削除の要求

本家の DMCA の手順に倣う（[DMCA Takedown Policy](https://docs.github.com/en/site-policy/content-removal-policies/dmca-takedown-policy)）。

- 通知を受けたら、持ち主に約 1 営業日の猶予を与えて修正を求め、直らなければリポジトリを無効にする。
- fork は自動では無効にしない。通知が特定したものだけを対象にする。
- 反論の通知を受けて、権利者が 10〜14 営業日の間に訴訟の提起を示さなければ、再び有効にする。
- 本家は通知を編集した上で公開のリポジトリ（`github/dmca`）に公開している。本システムで公開するかは、法務と PM が決める（15 節）。
- 日本では、発信者情報開示の請求（プロバイダ責任制限法、現・情報流通プラットフォーム対処法）にも対応する窓口と手順が要る（手順は未作成）。

## 7. AI エージェントに固有のリスク

- API とトークンで操作する AI エージェントは、人と同じ判定関数を通る。特別な抜け道を作らない。
- エージェントのトークンは、fine-grained（リポジトリと権限を指定）を既定にし、有効期限を必須にする。
- Issue・PR・コードの中の命令は、エージェントにとってデータである。本システムが将来 AI の機能を持つときは、Slack の security.md の 7.1 節と同じ前提（権限を先に適用する、ツールの呼び出しは依頼者の権限の範囲）に従う。
- コーディングエージェントは本番に経路を持たない（1 節）。

## 8. 暗号化と鍵の管理

詳細は [ADR-0028](../decisions/0028-encryption-and-key-management.md)。

| 対象 | 保存時の暗号化 | 鍵 |
| --- | --- | --- |
| Git ストレージ（インスタンスストアの NVMe。ADR-0031） | ハードウェアの XTS-AES-256（無効にできない）。インスタンスの停止・終了で鍵が消える（[AWS: SSD instance store volumes](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ssd-instance-store.html)） | AWS の Nitro が管理。顧客の鍵を使えない |
| Git ストレージ（EBS を使う場合） | EBS の暗号化 | KMS の CMK `git` |
| Git のバックアップ、LFS、リリースの成果物、添付 | S3 の SSE-KMS、バケットキー | CMK をデータの種類ごとに分ける |
| Aurora | クラスタとスナップショット | CMK `db` |
| 検索のクラスタ | 保存時の暗号化 | CMK `search` |
| SQS・ログ・監査ログのアーカイブ | SSE-KMS | CMK `queue`・`logs`・`audit` |
| Actions のシークレット、Webhook の秘密、OAuth のクライアントの秘密、TOTP の種、SSH のホスト鍵 | 上に加えて、アプリ層のエンベロープ暗号化 | CMK `app-secrets` で包んだデータキー |
| トークン・パスワード | 暗号化ではなくハッシュ（トークンは SHA-256、パスワードは Argon2id） | — |

- 本家も、GitHub.com のソースコードを暗号化されたディスクに保存している（[Git data encryption at rest](https://github.blog/changelog/2019-05-22-git-data-encryption-at-rest/)、2019 年）。鍵の管理の詳細は公開されていない（2026-09-26 に docs.github.com と GitHub のブログを確認。**未検証**。本家に寄せる対象ではなく、ADR-0028 の判断とする）。
- 転送中はすべて TLS 1.2 以上。内部の RPC（Git ストレージ）は mTLS。
- 顧客の鍵（BYOK・EKM）は MVP に含めない。移行の道筋を ADR-0028 に書く。

## 9. 秘密情報の管理

- サービスの秘密情報（DB の認証情報、署名鍵、外部サービスの鍵）は Secrets Manager に置き、サービスのロールごとに読めるものを限定する。ローテーションは Slack の ADR-0017 と同じ周期（DB は 30 日、署名鍵は 90 日）。
- **Actions のシークレット**：
  - API では、本家と同じく、リポジトリ・Organization ごとの公開鍵で libsodium の sealed box で暗号化した値を受ける（[Encrypting secrets for the REST API](https://docs.github.com/en/rest/guides/encrypting-secrets-for-the-rest-api)）。対の秘密鍵は `app-secrets` で包んで保存する。
  - 復号は、ジョブの配置の時に、Actions の Secrets service だけが行う（[actions.md](actions.md) の 6 節、ADR-0025）。Web・API のプロセスは平文を持たない。
  - ジョブに渡すのは、そのジョブが参照し、判定を通ったものだけ（環境の保護の規則を含む。[actions.md](actions.md)）。
- **SSH のホスト鍵・Web の操作によるコミットの署名鍵**：漏洩時に単独で入れ替えられるよう、種類ごとに分けて持つ。入れ替えの手順は runbook の `host-key-rotation` に書く。

## 10. 秘密情報の走査と Advanced Security との関係

- **MVP**：自社のトークンの形式（接頭辞とチェックサム）を、公開のリポジトリへの push、公開の Issue・コメントで走査し、有効なトークンは自動で失効し、持ち主にメールで知らせる（本家と同じ）。
- **本家は、失効の API を誰にでも開いている**：認証なしで、見つけたトークンを送ると失効し、持ち主の監査ログに記録してメールで通知する（1 時間 60 回、1 回に 1,000 件まで。[Changelog 2025-04-29](https://github.blog/changelog/2025-04-29-credential-revocation-api-to-revoke-exposed-pats-is-now-generally-available/)）。E7 で同じものを提供する。
- **後の Epic**：他社の秘密情報の形式の走査、partner program（見つけた秘密情報を提供者へ通知する。本家は失効するかどうかを提供者に委ねる。[About secret scanning for partners](https://docs.github.com/en/code-security/secret-scanning/introduction/about-secret-scanning-for-partners)）、push protection。本家の push protection は、利用者の公開のリポジトリへの push で既定で有効で、理由を付けたバイパスを記録・通知する（[About push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection)）。
- **依存の脆弱性（Dependabot・GHSA 相当）**は intent.md の Non-goals（Advanced Security）。ただし、利用者のリポジトリの脆弱性を非公開で受け付け、修正する仕組み（リポジトリのセキュリティアドバイザリ、非公開の脆弱性の報告、一時的な非公開の fork）は、S2 以降の候補として記録する。本家は CNA として CVE を採番し、公開したアドバイザリを Advisory Database と Dependabot の通知に流す（[About repository security advisories](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/about-repository-security-advisories)）。

## 11. セキュリティの試験と脆弱性の管理

| 種類 | 道具（候補） | 実行タイミング | 合否 |
| --- | --- | --- | --- |
| SAST | CodeQL（TypeScript・Go） | PR | High 以上の新規検出が 0 件 |
| シークレットスキャン | push protection、gitleaks | push、PR | 検出 0 件 |
| 依存・イメージの脆弱性 | Dependabot alerts / osv-scanner、Inspector | PR、毎日 | 下の期限内に対応 |
| IaC | tflint、Checkov | PR | High 以上 0 件 |
| 認可 | 性質ベーステスト、経路ごとの漏洩テスト（Web・API・Git・検索・通知・Webhook・Actions のログ） | PR | [quality.md](../quality.md) のとおり |
| 描画 | Markdown の無害化のファズ、別ドメインの配信ヘッダーの結合テスト | PR | 実行可能な要素 0 件 |
| Git の入力 | 悪意あるパック・オブジェクトのファズ（Go の fuzzing） | 夜間 | クラッシュ 0 件 |
| DAST | OWASP ZAP（ステージング） | 夜間、リリース前 | High 以上 0 件 |
| Actions の隔離 | VM からの脱出・内部への到達の演習 | 四半期、実行環境の変更時 | 到達 0 件 |
| ペネトレーションテスト | 外部の専門業者 | 一般公開の前、以後は年 1 回 | Critical・High がすべて修正済み |
| 報告窓口 | `security.txt`、バグバウンティ（公開後。本家も持つ） | 常時 | — |

深刻度と期限は Slack の security.md の 11 節と同じ（Critical は緩和 24 時間・修正 7 日、High は 7 日・30 日、Medium は 90 日、Low は 180 日）。**非公開のリポジトリの中身を権限のない人に見せる脆弱性と、Actions の隔離を破る脆弱性は、CVSS にかかわらず Critical とする。** Git の本体の脆弱性は、Git の上流の公開と同時に修正を入れられるよう、版の更新の経路を常に使える状態に保つ。

## 12. セキュリティインシデントへの対応

- 手順は runbook の `security-incident` に書く。検知・封じ込め・根絶・復旧・振り返り、連絡先、証拠の保全を含む。
- 検知の源：GuardDuty、Security Hub、アプリのセキュリティイベント（認証の失敗・権限の拒否の急増、異常な clone の量）、複製のチェックサムの不一致、監査ログのハッシュの連鎖の検証の失敗、外部からの報告。

### トークンの漏洩と一斉の失効

本家は 2022 年 4 月、Heroku と Travis CI が保持していた OAuth のトークンが盗まれ、数十の Organization の非公開のリポジトリがダウンロードされた事件で、被害者を特定して通知した（[Security alert: stolen OAuth user tokens](https://github.blog/news-insights/company-news/security-alert-stolen-oauth-user-tokens/)）。同じ種類の事件に備え、次を持つ。

| 能力 | 方式 | 目標 |
| --- | --- | --- |
| 一斉の失効 | 条件（トークンの ID の一覧、OAuth のアプリ・App の ID、発行の期間、利用者）でトークンを失効する運用者の操作。失効は DB の状態を変え、認証のキャッシュを Event で消す | 100 万件を 15 分以内に失効し、失効した後の要求が 60 秒以内に拒否される |
| 影響の範囲の特定 | 内部のアクセスログ（トークンの ID、操作、リポジトリの ID、IP、時刻）を 90 日保持し、トークンの集合で絞り込む（ADR-0029） | 1 時間以内に、影響を受けたリポジトリと持ち主の一覧を出す |
| 通知 | 影響を受けた持ち主へのメールと、Organization の監査ログへの記録 | 特定から 24 時間以内 |
| 鍵の入れ替え | SSH のホスト鍵、署名鍵、Webhook の送信の鍵を、種類ごとに独立して入れ替える | runbook の `host-key-rotation`・`key-rotation` |

- 認証のキャッシュ（トークンのハッシュから利用者・スコープへの対応）は、TTL を 60 秒以下にし、失効の Event で即座に消す。Git フロントエンド・API・Actions の全てが同じキャッシュの規則に従う。
- 失効の操作自体は、二人の承認（4-eyes）を要し、内部の監査ログに残す。

## 13. コンプライアンス

| 対象 | 立場 | 主な対応 |
| --- | --- | --- |
| 個人情報保護法（日本） | アカウントの情報は自ら取得する。非公開のリポジトリの中身は利用者の管理下のデータとして扱う | データは日本国内（東京、災害復旧は大阪）に置く。漏えい等の報告（速報は概ね 3〜5 日、確報は 30 日、不正の目的によるものは 60 日）を手順に組み込む |
| GDPR | Organization のデータは処理者、アカウントの情報は管理者 | DPA、データ主体の権利への対応。本家のプライバシーステートメントは、アカウントが有効な間と、契約・法令・紛争の解決に必要な間だけ保持するとし、日数を示していない（[GitHub General Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)） |
| SOC 2 | — | Type I を企業向けの機能の提供までに、その後 Type II。本家は SOC 2・ISO の報告を Trust Center で示す（[github.com/security](https://github.com/security)） |
| 輸出管理・制裁 | — | 本家は米国の EAR・OFAC・ITAR に従う（[GitHub and trade controls](https://docs.github.com/en/site-policy/other-site-policies/github-and-trade-controls)、2026-09-26 に確認）。日本の外為法での扱いは **法務の確認待ち**（15 節） |
| DMCA・日本の発信者情報開示 | — | 6 節 |

## 14. データのライフサイクル

方針は [ADR-0030](../decisions/0030-data-retention-and-deletion.md)、監査ログは [ADR-0029](../decisions/0029-audit-log.md)。

| データ | 保持 | 削除のされ方 |
| --- | --- | --- |
| リポジトリ（削除後） | 90 日は復元できる（本家と同じ） | 期限後に 3 つの複製とバックアップの対象から消す。fork のネットワークの共有オブジェクトは、ネットワークに残る他のリポジトリから到達できる限り残る |
| Issue・PR・コメント | リポジトリと同じ | リポジトリの消去で消える |
| アカウント（削除後） | 復元しない（本家と同じ） | 持つリポジトリは直ちに消去の対象になる。他人のリポジトリへの Issue・コメントは残り、ghost 相当の利用者に付け替える。名前は 90 日使えない |
| Organization（削除後） | 復元しない（本家と同じ） | リポジトリなどを消す。名前は 90 日使えない |
| 監査ログ（Organization・Enterprise） | 利用者が見られるのは 180 日（本家と同じ）。アーカイブは 400 日 | ADR-0029 |
| Git のイベント（clone・fetch・push） | Enterprise の監査ログで 7 日（本家と同じ） | ADR-0029 |
| 個人のセキュリティログ | 90 日（本家と同じ） | ADR-0029 |
| 内部のアクセスログ | 90 日（本文・トークンの値を含めない） | 期限で自動削除 |
| Actions のログ・成果物 | [actions.md](actions.md) に従う | 同左 |
| 検索の索引 | 元のデータに従う | 削除の Event で消す |
| バックアップ（Aurora、Git のバックアップ） | 35 日 | 期限で消える。**これが削除の最終的な期限になる** |

- **削除の完了**：リポジトリは削除から最長 90 日＋35 日＝125 日、アカウント・Organization は削除から最長 35 日（＋消去のジョブの時間）で、バックアップを含めて消える。例外は監査ログのアーカイブ。
- **無効化（DMCA・濫用）は削除ではない。** データは残し、見えなくする。
- Git のバックアップ（[infrastructure.md](infrastructure.md) の 5 節）は「最新の完全な復元点を常に残す」が、消去したリポジトリはこの例外から外し、消去から 35 日で復元点ごと消す（ADR-0030）。
- 手順は runbook の `repository-restore`・`data-deletion` に書く。

## 15. 未解決の問い

設計の中で出た問いと、その決定。

### 決定（2026-09-26、既定案）

PM の方針（本家に寄せる、既定案）で次のとおり決めた。法務の確認が要るものは、E9 の一般公開の前に確認を受ける（`legal-review-before-launch`）。

- **DMCA の通知の公開**：本家に合わせ、個人情報を編集したうえで公開のリポジトリで公開する。**法務の確認待ち**。
- **日本の発信者情報開示と、外為法・制裁への対応**：手順を E9 の `legal-takedown-and-disclosure` で作る。中身は法務が決める。
- **通知のメールのドメインの制限**：本家と同じく企業向けの機能とし、MVP に含めない（E10）。
- **内部のアクセスログの保持**：90 日のままにする。本家の 2022 年の事件（発覚まで約 1 週間）にも足りる。
- **push protection（他社の秘密情報の形式を含む）**：MVP の後の Advanced Security の Epic の最初の Story にする。MVP では、自社のトークンの走査と、push の検査の枠（[git-protocols.md](git-protocols.md) の 5.2 節の 6）だけを持つ。
- **監査ログのアーカイブの延長**：MVP の後の候補（企業向けの契約で扱う）。

### 未検証の事項

- 本家が DMCA で無効にしたリポジトリに HTTP 451 を返すか（2026-09-26 に公式の記述を探したが見つからない。一般公開の前に、公開のリポジトリで観測できる無効化の事例で確かめる）。
- 本家の保存時の暗号化の鍵の管理の方式（2019 年の Changelog 以上の公開の情報はない。2026-09-26 に確認。本家に寄せる対象ではない）。

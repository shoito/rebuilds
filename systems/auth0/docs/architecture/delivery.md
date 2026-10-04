# Delivery: Auth0

ブランチ、CI、適合試験の CI、デプロイ、リリースとフラグ、`security:sensitive` の変更の流れ。Slack の [delivery.md](../../../slack/docs/architecture/delivery.md) を引き継ぎ、IdP に固有の 3 つを足す：**プロトコルの適合試験**、**セキュリティに関わる変更の 2 人の承認**、**テナントを単位にしたリリース**。

| 対象 | 方針 |
| --- | --- |
| ブランチモデル | リポジトリ共通の [ADR-0002](../../../../docs/decisions/0002-trunk-based-development.md)（トランクベース開発） |
| デプロイとマイグレーション、フラグ | Slack の ADR-0022・0026 を引き継ぐ |
| 適合試験の CI | [ADR-0064](../decisions/0064-conformance-suite-in-ci.md) |
| `security:sensitive` の変更の流れ | [ADR-0065](../decisions/0065-security-sensitive-change-flow.md) |
| テナントを単位にしたリリース | [ADR-0066](../decisions/0066-tenant-canary-release.md) |
| RFC 9700 のチェックリストと拒否の側のテスト | [ADR-0053](../decisions/0053-rfc9700-checklist-and-negative-tests.md) |
| AWS の CI/CD と Terraform の構成 | [infrastructure.md](infrastructure.md) の 7 節 |
| 手順 | [runbooks/deploy-and-rollback.md](../runbooks/deploy-and-rollback.md) |

原則は 3 つ。

- **`main` は常にデプロイできる状態に保つ。**
- **デプロイ（コードを置くこと）とリリース（振る舞いを有効にすること）を分ける。** デプロイは Ops が承認し、リリースは PM が判断する。
- **プロトコルと秘密に触れる変更は、標準の試験と 2 人の人の目を通してから入れる。**

## 1. 変更からマージまで

```
changes/YYMMDD-<slug>/ の spec・plan が承認済み
   ▼
ブランチ auth0/YYMMDD-<slug>（エージェントは worktree ごとに 1 本）
   ▼
PR ─▶ パスで security:sensitive のラベルを自動で付ける（3 節）
   ▼
PR の CI（2 節）─▶ レビュー（CODEOWNERS、作成者と別の人。security:sensitive は 2 人）
   ▼
merge queue ─▶ squash で main へ
```

- 未完成の振る舞いは release フラグの裏に置く。
- PR の説明には、変更フォルダ、規模、使うフラグに加えて、**`security:sensitive` に当たるか**、**プロトコルの振る舞いを変えるか**、**`security.md` の `SEC-` の行の追加・変更**を書く。

### 1.1 リポジトリの中の区分

開発リポジトリは 1 つ（モノレポ）。

| パス | 中身 | コードオーナー |
| --- | --- | --- |
| `services/signer/`、`packages/crypto/`、`packages/jose-*/` | Signer、暗号の部品 | Dev のテックリード＋セキュリティの担当（2 人） |
| `services/auth/src/oauth/`、`services/auth/src/session/`、`services/auth/src/attack-protection/`、`packages/credentials/` | 認可のエンドポイント、セッション、攻撃の防御、資格情報 | 同上 |
| `services/auth/`（その他）、`packages/oidc/` | Universal Login、接続、MFA | 領域のオーナー＋QA（プロトコル） |
| `services/mgmt/` | Management API | 領域のオーナー |
| `conformance/` | 適合試験の設定、許可した警告 | QA |
| `infra/` の `regional/keys`、WAF、IAM、Signer のネットワーク | 鍵と境界の IaC | Ops＋セキュリティの担当 |
| `infra/`（その他） | IaC | Ops |

## 2. CI

### 2.1 PR の CI

Slack の delivery.md の 2.1 節の段をすべて持ち、次を足す。目標は 20 分以内。

| 段 | 内容 | 失敗の条件 |
| --- | --- | --- |
| 適合試験 | OpenID Foundation の conformance suite を CI の中のコンテナで動かし、変更に関わるプロファイル（Basic、Config、Form Post、RP-Initiated Logout、Back-Channel Logout）を走らせる（4 節） | `FAILED`、許可のない `WARNING` |
| 差分テスト | node-oidc-provider と同じ要求を送り、応答を比べる（[ADR-0001](../decisions/0001-platform-and-stack.md)） | 説明のない違い |
| 拒否の側のテスト | `SEC-NNN` のテスト（[security.md](security.md) の 4 節）。表のすべての行がテストから参照されている | 1 件でも、または参照の漏れ |
| テナントの分離 | 性質ベーステスト（任意の 2 テナントで他方の行が読めない、他のテナントの `kid` で署名できない）（[ADR-0002](../decisions/0002-tenancy-and-isolation.md)） | 1 件でも |
| トークンの性質 | 性質ベーステスト（リフレッシュの任意の列で、再利用が系列を失効させる。コードの 2 回目の交換が失敗する）（[ADR-0003](../decisions/0003-token-formats-and-signing-keys.md)） | 1 件でも |
| 秘密の出力 | テストの実行中のログ・スパン・スナップショット・エラーの本文を走査（[ADR-0061](../decisions/0061-secret-free-telemetry.md)） | 1 件でも |
| 暗号の API の lint | `jose` 以外の JWT のライブラリ、Signer の外の秘密鍵の API、`reveal()` の許可の外の呼び出し、ロガーへの型のないイベント | 1 件でも |
| マイグレーション | 新しいテーブルに `tenant_id` と RLS のポリシー（ADR-0002）。資格情報の列の型（ハッシュか暗号文） | 規則の違反 |
| ファジング（`security:sensitive` のとき） | `/authorize`・`/oauth/token` のパーサー、JWT の検証に fast-check の生成した入力を 2 分 | 500、秘密の出力 |
| 依存の追加（`security:sensitive` のとき） | 新しい依存の検出 | セキュリティの担当の承認がない |
| テストの資格情報 | テスト・フィクスチャー・シードに、本物のメールアドレス（許可したテスト用のドメイン以外）、既知の IdP のシークレットの形 | 1 件でも |
| インフラ（`infra/` の変更時） | `fmt`、`validate`、tflint、Checkov、`plan`、plan のポリシー検査（[infrastructure.md](infrastructure.md) の 7.2 節） | 違反、状態を持つリソースの削除・置き換え |

### 2.2 夜間の CI

- 適合試験の全プロファイルと、将来の対象（FAPI 2.0 などの候補）を参考として走らせる（4 節）。
- E2E の全件（3 つのブラウザエンジン、仮想の WebAuthn の認証器）。
- ファジングの長いバージョン（30 分）。
- 障害の注入（ADR-0005 の縮退の表：Aurora の writer、Valkey、SQS、KMS への到達不能）。
- staging に対する DAST と負荷試験の短いバージョン。

夜間の CI が 2 日続けて失敗している間は、release フラグを広げない。

## 3. `security:sensitive` の変更

[ADR-0065](../decisions/0065-security-sensitive-change-flow.md) の要点。

| 項目 | 規則 |
| --- | --- |
| ラベル | `.github/security-sensitive-paths.yml` のパスに当たる PR に、Actions が自動で付ける。作成者は外せない（外せるのは Dev のテックリードだけ） |
| 承認 | Dev のテックリードとセキュリティの担当の 2 人。どちらも作成者と別。エージェントの PR でも同じ |
| 事後の確認の例外 | 使わない（リポジトリ共通の [ADR-0004](../../../../docs/decisions/0004-agent-prs-via-github-app.md) の例外を、このラベルの PR には当てない）。2 人がそろわない間はマージしない |
| 追加の CI | 2.1 節のファジングと依存の追加の検査 |
| PR の説明 | STRIDE のどれに関わるか、`SEC-` の行、ロールバックの方法 |
| リリース | release フラグの裏に置き、テナントのカナリア（5 節）で広げる。認証を弱める方向の変更は、フラグの既定を旧い振る舞いにし、PM とセキュリティの担当が広げる |
| Signer | Signer のイメージの変更は、他のサービスと同じ日に本番へ出さない |

## 4. 適合試験の CI

[ADR-0064](../decisions/0064-conformance-suite-in-ci.md) の要点。

```
PR の CI のランナー
 ├─ conformance suite（コンテナ、digest で固定）＋ MongoDB
 ├─ 本システム（Testcontainers：auth、signer、mgmt、PostgreSQL、Valkey）
 └─ run-test-plan.py 相当のスクリプト
      1. Management API で試験用のテナント・クライアント・ユーザーを作る（秘密はその場で生成）
      2. conformance/plans.yaml から、変更に関わるテストプランを選ぶ
      3. スイートの API でプランを走らせ、ブラウザの操作は設定の JSON で自動で行う
      4. 結果を判定する（FAILED は失敗。WARNING は allowed-warnings.yaml にあるものだけ許す）
```

| 実行 | プロファイル | 必須か |
| --- | --- | --- |
| PR（認証の経路のパッケージの変更） | Basic、Config、Form Post。セッション・ログアウトの変更なら RP-Initiated Logout、Back-Channel Logout も | 必須 |
| `main` へのマージの後 | 対象のすべて | 失敗したら `main` を赤にし、次のデプロイを止める |
| 夜間 | 対象のすべてと、将来の対象（参考） | 参考の失敗は必須にしない。`REVIEW` の項目は QA が確かめる |
| スイートのバージョンの更新の PR | 対象のすべて | 必須 |
| E12 の認証の申請 | 公開の staging に対して、OpenID Foundation のホストする試験のサーバーで | GA の判定の条件 |

- `conformance/allowed-warnings.yaml` の変更は、QA の承認を要する（CODEOWNERS）。
- GA の判定の条件：`main` の夜間の結果で、対象のプロファイルが 7 日続けて通っている（[quality.md](../quality.md) で QA が決める）。

## 5. デプロイ

### 5.1 環境の昇格

```
main ─▶ dev（自動）─▶ staging（自動。適合試験・E2E・スモーク・k6）─▶ prod（Ops の承認）
```

- prod のデプロイは平日の 10〜17 時。金曜の 15 時以降と年末年始は、修正以外のデプロイをしない。テナントから事前に知らされた大きなイベント（チケットの発売、テレビの放送）の時間帯を避ける。
- エラーバジェットを使い切っている間は、修正以外のデプロイをしない。

### 5.2 デプロイの順序

auth と signer の間の API、auth と mgmt の間で共有する DB のスキーマは、**新旧の両方と互換を保つ**。どちらを先に入れても壊れないようにする。

| 順 | 対象 | 方式 |
| --- | --- | --- |
| 1 | マイグレーション（expand） | 1 回だけ実行する ECS タスク（`migrator`）。Slack の ADR-0022 |
| 2 | relay、worker、worker-egress | ローリング（`minimumHealthyPercent` 100%） |
| 3 | mgmt | blue/green |
| 4 | auth | ECS のネイティブな blue/green のカナリア（要求の 10% → 100%）。アラームで自動のロールバック |
| 5 | signer（変更があるとき。auth と別の日） | 1 AZ ずつのローリング。KMS の読み込みの速さを守る（[capacity.md](capacity.md) の 2.7 節） |

- auth の blue/green の自動のロールバックのアラームには、5xx の率に加えて、**ログインの成功率、`invalid_grant` の率、Signer の呼び出しの失敗の率**を入れる。新しいコードが照合やトークンを壊したとき、5xx が出なくても止められる。
- auth の登録解除の遅延を 30 秒にし、処理中のログインを終えてから止める（[capacity.md](capacity.md) の 3.2 節）。
- **セッション・Cookie・ログインのトランザクションの形を変えるときは、新旧の両方を読めるコードを先にデプロイし、書く形の切り替えは次のリリースでフラグで行う。** blue/green の途中で、新旧のタスクに同じ利用者の要求が行き来するため。

## 6. リリース（テナントのカナリア）

[ADR-0066](../decisions/0066-tenant-canary-release.md) の要点。

```
デプロイ済み（フラグ無効）
   │ QA：staging でフラグを有効にし、Proof と適合試験を満たすことを確認
   ▼
社内のテナント（管理用のテナント、合成監視のテナント）
   ▼
開発・ステージングの環境のテナントの 100%（最低 7 日。テナントの開発者が先に気づく期間）
   ▼
本番のテナントの 1% ─▶ 10% ─▶ 50% ─▶ 100%（各段で最低 24 時間）
   ▼
100% で 2 週間 ─▶ 古いコードとフラグを消す
```

- 判定は `hash(flag_name + tenant_id) mod 100`。同じテナントの要求は、常に同じ側になる。
- 許可リスト（社内・同意を得たテナント）と除外リスト（大口のテナントは最後）を持つ。
- **ガード**（フラグの有効なテナントと無効なテナントを比べ、差が続いたら AppConfig のアラームでフラグを自動で切る）：

| ガード | 条件 |
| --- | --- |
| ログインの成功率 | 無効な側より 2 ポイント以上低く、15 分続く |
| トークンの交換の失敗 | `invalid_grant` の率が無効な側の 2 倍 |
| リフレッシュトークンの再利用の検知 | 系列の失効の件数が無効な側の 3 倍 |
| 可用性 | フラグの有効なテナントの 5xx が 0.05% を超える |
| 秘密の出力 | 走査の検出 1 件（フラグによらず即時） |

| 判断 | 誰が |
| --- | --- |
| staging での受け入れ | QA |
| 社内 → 開発の環境 → 本番の 1% | PM |
| 10% → 100% | PM と Ops |
| 認証を弱める方向の変更の各段 | PM とセキュリティの担当 |
| 止める・戻す | 誰でもよい |

- プロトコルの形を変える変更（クレーム、エラーの形、discovery の値）は、フラグで全テナントに広げず、テナントが選べる互換のバージョンにするかを各領域で決める。

## 7. ホットフィックス

他の題材と同じく、まずフラグで止め、修正は `main` への PR で入れる（forward fix）。フラグで止められず修正も間に合わないときは、1 つ前のイメージで再デプロイする。マイグレーションは戻さない。

- **脆弱性の修正**（[security.md](security.md) の 11 節の Critical）は、時間帯の制限を受けない。ただし、2 人の承認と適合試験・拒否の側のテストは省かない。
- 脆弱性の修正は、公開の前に、PR の説明とコミットメッセージに攻撃の詳細を書かない（修正の公開と、詳細の公開を分ける）。

## 8. 指標

DORA の 4 指標（他の題材と同じ目標）に加えて、次を見る。

| 指標 | 目標 |
| --- | --- |
| `main` の適合試験の成功の連続日数 | GA の前は 7 日以上を保つ |
| `security:sensitive` の PR のうち、2 人の承認なしにマージされたもの | 0 件 |
| `security:sensitive` の PR のレビューの待ち | 中央値 1 営業日以内 |
| 6 節のガードで自動で止まった回数 | 記録し、振り返る |
| `SEC-` の行のうち、テストのないもの | 0 件 |

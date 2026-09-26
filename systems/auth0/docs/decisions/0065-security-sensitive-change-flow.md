---
status: accepted
date: 2026-09-27
---

# ADR-0065: `security:sensitive` の変更は、パスで自動にラベルを付け、作成者と別の 2 人の人の承認と、追加の CI の段を必須にする

## Context

[AGENTS.md](../../AGENTS.md) は、認可のエンドポイント、トークン、署名鍵、パスワード・MFA・パスキー、セッション、攻撃の防御、テナントの分離、暗号、秘密の保存に触れる PR に `security:sensitive` のラベルを付け、Dev のテックリードに加えてセキュリティの担当の承認を必須にすると決めた。エージェントは承認しない。

リポジトリ共通の [ADR-0004](../../../../docs/decisions/0004-agent-prs-via-github-app.md) は、人間のメンバーが 1 人のとき、人が自分で作った PR を管理者のバイパスでマージし、事後に確認する運用を許している。Stripe は、CDE の変更でこの事後の確認を使わないと決めた（Stripe の ADR-0033）。

決めることは次の 3 つ。

- ラベルを誰がどう付けるか（付け忘れを防ぐ）
- 承認とマージの条件
- 追加の CI とリリースの条件

## Options

1. **パスの表で自動にラベルを付け、GitHub のルールセットで 2 人の承認を強制する。事後の確認の例外を使わない。追加の CI の段を持つ**
2. 作成者がラベルを付け、レビューで確かめる
3. すべての PR に、セキュリティの担当の承認を求める

## Decision

1 を採用する。

- **自動のラベル**：開発リポジトリの `.github/security-sensitive-paths.yml` に、対象のパスを書く（`services/auth/src/oauth/**`、`services/auth/src/session/**`、`services/signer/**`、`packages/crypto/**`、`packages/jose-*/**`、`packages/credentials/**`、`services/auth/src/attack-protection/**`、`db/migrations/**` のうち RLS・資格情報の表、`infra/**` のうち KMS・IAM・WAF・Signer のネットワーク）。Actions がパスに当たる PR にラベルを付ける。**作成者はラベルを外せない**（外す操作をルールセットで Dev のテックリードに限る）。パスに当たらなくても、作成者やレビュー担当はラベルを付けられる。
- **承認**：CODEOWNERS で、対象のパスの持ち主を「Dev のテックリード」と「セキュリティの担当」の 2 つのチームにし、両方の承認を必須にする。どちらも作成者と別の人。エージェントが作った PR（GitHub App の PR）でも同じ。**事後の確認の例外（リポジトリ共通の ADR-0004）は使わない。** 2 人がそろわない間は、マージしない。
- **追加の CI の段**：
  | 段 | 内容 |
  | --- | --- |
  | 適合試験 | 変更に関わるプロファイル（[ADR-0064](0064-conformance-suite-in-ci.md)） |
  | 拒否の側のテスト | `SEC-NNN` のテストの全件（[ADR-0053](0053-rfc9700-checklist-and-negative-tests.md)） |
  | ファジング | `/authorize`・`/oauth/token` のパラメーターのパーサーに、fast-check で生成した不正な入力を一定時間（PR で 2 分、夜間で 30 分）流す。500 と、秘密の出力で失敗 |
  | 秘密の出力の走査 | テストのログとスナップショット（[ADR-0061](0061-secret-free-telemetry.md)） |
  | 暗号の API の lint | `jose` 以外の JWT のライブラリ、Signer の外の秘密鍵の API（ADR-0001・0003） |
  | 依存の検査 | 新しい依存の追加は、セキュリティの担当が別に承認する（`package.json` の差分を検出） |
- **PR の説明**：変更の脅威（STRIDE のどれに関わるか）、`security.md` の `SEC-` の行の追加・変更、ロールバックの方法を書く（PR テンプレートの必須の欄）。
- **リリース**：`security:sensitive` の振る舞いの変更は、release フラグの裏に置き、[ADR-0066](0066-tenant-canary-release.md) のテナント単位のカナリアで広げる。認証を弱める方向の変更（検証の緩和、既定値の変更）は、フラグの既定を「旧い振る舞い」にし、PM とセキュリティの担当の両方が広げる判断をする。
- **Signer のデプロイ**：Signer のイメージの変更は、他のサービスと同じ日に本番へ出さない（原因の切り分けのため。[delivery.md](../architecture/delivery.md) の 5.2 節）。
- 2 は、付け忘れで審査を通らない変更が入る。3 は、セキュリティの担当が詰まり、速さを失う。

## Consequences

- 良くなること：
  - 認証の中核の変更が、必ず 2 人の人の目を通る。
  - エージェントが書いた変更も、同じ基準で審査される。
- 引き受けるコスト：
  - セキュリティの担当が、レビューの待ちの原因になりうる。担当を 2 人以上にし、SLA（営業日の 1 日以内）を置く。
  - 人間のメンバーが 1 人の期間は、`security:sensitive` の変更をマージできない。これを受け入れる（事後の確認では、脆弱性が本番に出る）。

## Confirmation

- GitHub のルールセットの設定の検査（週次、Actions）：対象のパスで 2 チームの承認が必須、ラベルの削除の権限、管理者のバイパスの無効。
- 監査：月次で、`security:sensitive` の PR のうち、2 人の承認なしにマージされたものが 0 件。
- `security-sensitive-paths.yml` の変更も、セキュリティの担当の承認を要する。

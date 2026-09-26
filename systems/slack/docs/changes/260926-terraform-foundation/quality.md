# Quality: Terraform の基盤（アカウント、状態、ネットワーク、CI の認証）

- Change: 260926-terraform-foundation
- Spec: [spec.md](spec.md) / Plan: [plan.md](plan.md)
- 題材の品質戦略: [quality.md](../../quality.md)
- 作成の理由: 新しいテスト基盤が必要（plan の JSON のジェネレーター、Rego の表駆動テスト、IAM Policy Simulator による権限の検査、実際の AWS に対する apply 後の検証）。本番の認証情報の経路（OIDC の信頼）を決める、セキュリティ上の境界の変更

## 1. リスク

題材の quality.md のリスク表は、アプリの振る舞いを扱う。この変更は、そのすべての前提になる「管理プレーン」（[security.md](../../architecture/security.md) の B3）を作る。

| リスク | 当たる題材のリスク | 起きると |
| --- | --- | --- |
| PR のブランチから、prod の apply のロールを引き受けられる | 1 位（データの漏洩）、2 位（データの喪失） | レビューを経ないコードが本番を変える |
| plan のロールで、本番のデータ（S3 のオブジェクト、秘密情報）を読める | 1 位 | PR を出せる人やエージェントが、顧客のデータを読める |
| ポリシー検査をすり抜けて、状態を持つリソースが消える | 2 位 | 状態・証跡・（後の）DB の喪失 |
| 状態ファイルの競合・破損 | 2 位（間接） | インフラの管理ができなくなる |
| 大阪の操作が東京に依存している | 2 位（災害時） | RTO 4 時間（NFR-008）を守れない |

## 2. テスト設計

### 2.1 PROP-INFRA-003（ポリシーの完全性）のジェネレーター

- 1 件の plan の JSON は、`resource_changes` を 0〜30 件持つ。
- 各 `resource_change` の生成：
  - 型：`stateful_types.json` の型から 50%、それ以外（`aws_security_group`、`aws_route`、`aws_iam_role` など 20 種）から 50%
  - 動作：`["no-op"]`、`["create"]`、`["read"]`、`["update"]`、`["delete"]`、`["delete","create"]`、`["create","delete"]`、`["forget"]` を等確率
  - アドレス：モジュールの入れ子（0〜3 段）、`for_each` のキー（日本語・記号を含む文字列）、`count` の添字を含める
  - 対象のアカウント：7 つから等確率（DT-INFRA-007 の 4 行のため）
- 例外の一覧：0〜5 件。生成した `resource_change` のアドレスと一致するもの、1 文字違うもの、期限切れ、承認者が 1 ロールだけのものを混ぜる。
- 期待値は、TypeScript で DT-INFRA-007 を素直に書いた参照の実装で計算し、`opa eval` の結果と比べる。参照の実装は、`spec.md` の表を読み込む表駆動テストでも検査する。
- 試行回数：PR で 1,000 回、夜間に 20,000 回。失敗したら、縮小された反例をフィクスチャとして残す。

### 2.2 PROP-INFRA-001（状態の直列性）

- dev の使い捨てのルートモジュール（`null_resource` と `terraform_data` だけを持ち、AWS の資源を作らない）を使う。
- 1 回の試行で、並行度 2〜5 のジョブを同時に始める。各ジョブは `plan`・`apply`・`apply -refresh-only` のどれかをランダムに選び、入力の変数をランダムに変える。
- 終了後、状態のバケットのバージョンの一覧を取り、`serial` が狭義単調増加で、各バージョンの `lineage` が同じであることを確かめる。ロックの取得に失敗したジョブは、状態を書いていないこと（バージョンの数 = 成功した apply の数）も確かめる。
- 試行回数：PR では実行しない（実際の AWS を使うため）。`infra/` の `bootstrap`・backend の設定・`.terraform-version` を変えたときと、週次で 50 回。

### 2.3 PROP-INFRA-004（plan のロールの権限）

- IAM Policy Simulator（`SimulatePrincipalPolicy`）は、SCP と権限の境界も評価に含められる（リソースポリシーは別途渡す）。
- 操作は、PROP-INFRA-004 の一覧から全件と、`Create*`・`Put*`・`Update*`・`Delete*`・`Attach*`・`Modify*` で始まる操作を、AWS のサービスの権限の一覧から 200 件ランダムに選ぶ。
- リソースの ARN は、状態のバケットの中の `.tflock` のキー、状態ファイルのキー、ほかのバケットのオブジェクトを混ぜる。期待値：`.tflock` への `PutObject`・`DeleteObject` と、状態ファイルの `GetObject` だけが許可。
- 全アカウントの `tf-plan` について実行する。Simulator の API の呼び出しの上限があるため、1 アカウント 1 回の実行で 500 件まで。

### 2.4 DT-INFRA-005（OIDC の信頼）の表駆動テスト

- 各行を 1 ケースにし、`sub`・`aud`・`repository` の値を与えて、信頼ポリシーを Simulator で評価する（`sts:AssumeRoleWithWebIdentity`、条件のキーに `token.actions.githubusercontent.com:sub` などを渡す）。
- `sub` の文字列は、plan.md の 5 で確かめた実際の形から作る。**形が未検証の間は、このテストの期待値を確定しない**。
- 境界：`refs/heads/main-2`、`refs/heads/main/x`、`refs/tags/main`、大文字小文字の違う環境名（`Prod`）、`shoito/rebuilds-fork`。いずれも拒否されること。

### 2.5 apply 後の検証

| ID | 観点 | 条件 | 期待結果 | 要件 / 性質 |
| --- | --- | --- | --- | --- |
| V1 | アカウント | 全アカウントの一覧 | spec の OU の対応と一致 | REQ-INFRA-001 |
| V2 | IAM ユーザー | 7 アカウント | 0 件 | REQ-INFRA-003 |
| V3 | 状態のバケット | 全バケット | バージョニング、KMS、パブリックアクセスのブロック、TLS の強制 | REQ-INFRA-006 |
| V4 | 証跡のバケット | log-archive | Object Lock がコンプライアンスモード 1 年 | REQ-INFRA-005 |
| V5 | 経路 | 4 つの VPC の全サブネット | DT-INFRA-004 と一致 | REQ-INFRA-010 |
| V6 | CIDR | 4 つの VPC | 重なりがない | REQ-INFRA-010 |
| V7 | エンドポイント | 稼働中の 3 つの VPC | spec の一覧がすべてあり、SG が VPC の CIDR の 443 だけ | REQ-INFRA-011 |
| V8 | フローログ | 4 つの VPC | `ALL` を log-archive へ | REQ-INFRA-012 |

prod は、`tf-plan` のロール（読み取り）で V1〜V8 を実行する。

## 3. テスト環境とテストデータ

- ポリシー・ツールのテスト：ローカルと CI。AWS に接続しない。plan の JSON のフィクスチャは、dev で実際に作った plan から、アカウント ID を置き換えて作る。
- 権限のテスト：dev・staging・prod の IAM Policy Simulator。読み取りの API だけを使う。
- 実際の AWS を使うテスト（ロック、直列性、フローログ、エンドポイント）：dev と staging だけ。使い捨てのルートモジュールの状態は、`infra/live/dev/ap-northeast-1/_test-*` に置き、テストの後に消す。
- 東京を遮断した plan：CI のジョブの中で、`/etc/hosts` か、ランナーの DNS の設定で `*.ap-northeast-1.amazonaws.com` を解決できなくする。GitHub のホスト型ランナーでこれができるかは **未検証**。できなければ、ランナーのコンテナの中で DNS を差し替える。

## 4. 合否の判定基準

- Proof の表のすべてが満たされている。
- PROP-INFRA-003 が、PR で 1,000 回、夜間で 20,000 回、反例なく通る。
- PROP-INFRA-004 が、全アカウントで違反 0 件。
- DT-INFRA-005 の全行と 2.4 節の境界のケースが通る。`sub` の形が未検証のままなら、この変更は Test 段を通過しない。
- apply 後の検証（V1〜V8）が、dev・staging・prod のすべてで通る。
- 受け入れ試験（break-glass の通知、古い plan、ドリフトの検知、東京を遮断した plan）の記録が PR にある。

## 5. リリース後の品質の確認

| 指標 | 許容できる範囲 | 備考 |
| --- | --- | --- |
| ドリフトの検知で開いている Issue（`drift: <root>`） | 週次の確認で 0 件（ADR-0020 の Confirmation） | 対応の手順は Ops の `terraform-drift.md`（E1。この変更の完了までに作る）。それまでは Issue の一覧で見る |
| `drift-error: <root>` の Issue | 3 日続けて出ない | ロックの競合か、ロールの権限の不足を疑う |
| break-glass の利用 | 月 0〜2 回。利用ごとに 24 時間以内に理由が記録されている | 手の変更は 24 時間以内にコードへ反映する（ADR-0020） |
| ポリシーの例外 | 期限切れのまま残るものが 0 件 | |

Ops に、ドリフトと break-glass の手順（runbook）の追加を依頼する。E7 を待たず、この変更の完了までに最小限の手順が要る。

## 6. 題材の quality.md へ反映する知見

- IaC のテストのレベル：Rego の単体・表駆動、plan の JSON の性質ベーステスト、IAM Policy Simulator による権限の性質、実際の AWS に対する apply 後の検証。2.2 節の表に「IaC」の行として足す。
- plan の JSON のジェネレーターと、DT の参照の実装を Rego と比べる方法は、後の Story（Aurora、ECS）のポリシーの追加でも使う。

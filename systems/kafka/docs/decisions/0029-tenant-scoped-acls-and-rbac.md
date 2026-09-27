---
status: accepted
date: 2026-09-27
---

# ADR-0029: ACL は本家の StandardAuthorizer を包んで使い、論理クラスタの境界を二重に確かめる。データの権限は ACL だけで与える

## Context

テナントは、本家と同じ ACL の API（CreateAcls・DescribeAcls・DeleteAcls）と、コンソール・管理 API・Terraform で権限を管理する。共有の物理クラスタの上では、次が問題になる。

- 本家の ACL の `*`（LITERAL のワイルドカード）は、すべての名前に合う。名前空間のパッチで資源の名前に接頭辞を付けても、`*` をそのまま保存すると、他のテナントの資源に合う。
- CLUSTER の資源は物理クラスタに 1 つしかない。CreateAcls は本家では CLUSTER の ALTER を求める。
- 名前空間のパッチ（[ADR-0004](0004-logical-clusters-on-shared-physical-clusters.md)）に漏れがあると、他のテナントの資源に届く。

事実（2026-09-27 に確認）：

- KRaft では StandardAuthorizer を使い、資源のパターンは LITERAL と PREFIXED。ACL のない資源は super.users だけが使える（[Authorization and ACLs](https://kafka.apache.org/43/security/authorization-and-acls/)）。
- Confluent Cloud は、組織とクラスタの管理を RBAC で、Kafka の資源の権限を ACL で行う（[Predefined RBAC roles](https://docs.confluent.io/cloud/current/security/access-control/rbac/predefined-rbac-roles.html)）。
- [ADR-0001](0001-upstream-brokers-and-stack.md) は、StandardAuthorizer を基本にし、必要なら包むとした。[protocol-and-compatibility.md](../architecture/protocol-and-compatibility.md) は、テナントの ACL の資源の種類を TOPIC・GROUP・TRANSACTIONAL_ID に絞るとした。

## Options

1. **StandardAuthorizer を TenantAuthorizer で包む。境界の確かめと CLUSTER の判定を包みで行い、ACL の保存と評価は本家に任せる。データの権限は ACL だけ**
2. 自前の Authorizer を書き、ACL を制御面に持つ
3. 1 と同じだが、制御面のロール（DeveloperRead・DeveloperWrite など）からも Kafka のデータの権限を与える

## Decision

1 を採用する。詳細は [security-and-acls.md](../architecture/security-and-acls.md) の 5 節にある。

- **判定の順**：内部の主体 → API の表（ADR-0006）→ 主体の論理クラスタと資源の論理クラスタの一致 → CLUSTER の表 → StandardAuthorizer。
- **境界の二重の守り**：名前空間のパッチが正しければ、境界の確かめは常に通る。拒否したら `tenant_boundary_violation` のアラートを最高の重大度で上げる。
- **ACL の変換**：LITERAL `*` は PREFIXED `lc-<id>_`（内部の接頭辞の形。正本は multi-tenancy-and-quotas の領域）として保存し、DescribeAcls では `*` に戻す。他の組織の主体を含む ACL は拒否する。CLUSTER・DELEGATION_TOKEN・USER の資源の ACL は拒否する。
- **CLUSTER の権限**：テナントに CLUSTER の ACL を作らせず、制御面のロール（ClusterAdmin なら `cluster_role=admin`）で決める。admin は Create・Alter（ACL の作成・削除だけ）・Describe・DescribeConfigs、それ以外は Describe・DescribeConfigs・IdempotentWrite だけ。AlterConfigs・ClusterAction は誰にも与えない。
- **制御面のロール**：OrganizationAdmin、BillingAdmin、AccountAdmin、ClusterAdmin、Operator、MetricsViewer。名前は Confluent に寄せる。データの読み書きはロールで与えず、ACL だけで与える。
- **既定は拒否**：`allow.everyone.if.no.acl.found=false`。super.users は内部の主体だけ。
- **上限**：ACL は論理クラスタごとに Basic 1,000、Standard 10,000（本システムの値）。

2 を選ばない理由：本家の ACL の意味（パターンの合い方、DENY の優先、エラーコード）を作り直すことになり、互換の差分が増える。ACL の正本を KRaft とした ADR-0003 にも反する。

3 を選ばない理由：同じ権限を 2 か所（ロールと ACL）で与えると、どちらで許されたのか分かりにくく、ACL を消しても読めるといった誤解を生む。Kafka の既存の道具（DescribeAcls）で権限の全体が見えなくなる。

## Consequences

- 良くなること：
  - ACL の意味とエラーコードは本家のまま。本家の道具（`kafka-acls` の CLI など）がそのまま使える。
  - 名前空間のパッチの不具合があっても、Authorizer で止まり、検知できる。
- 引き受けるコスト：
  - ACL の変換（`*` の書き換えと戻し）を、名前空間のパッチの ACL の行で保つ。
  - CLUSTER の権限が本家の ACL ではなくロールで決まる。テナントが CLUSTER の ACL を作ろうとすると拒否される。文書に書く。
  - データの権限を付けるたびに ACL を作る必要があり、Confluent の DeveloperRead のような一括の付与はない。コンソールに「読み取り用」「書き込み用」の ACL のひな形を置く。

## Confirmation

- 性質ベーステスト：任意の 2 テナントと任意の ACL の列（`*`、PREFIXED、`User:*` を含む）で、一方の主体が他方の資源に許可されない。
- 性質ベーステスト：ACL の作成と DescribeAcls の往復で、形が変わらない。
- 表駆動テスト：CLUSTER の操作とロールの表。
- 差分テスト：ACL の API のエラーコードが、本家（パッチなし）と同じ。違いは許された違いの表にあるものだけ。
- 本番：`tenant_boundary_violation` の件数が 0。

---
status: accepted
date: 2026-09-27
---

# ADR-0006: API ごとの扱いを 1 つの表で持ち、拒否は Authorizer で本家と同じエラーを返す

詳細は [protocol-and-compatibility.md](../architecture/protocol-and-compatibility.md) の 3・4 節。

## Context

[ADR-0005](0005-compatibility-policy.md) は、本家の ApiVersions をそのまま広告し、クラスタ全体の管理の API だけをテナントに拒否すると決めた。拒否の正確な一覧と、拒否の作り方は、この領域に任された。

事実（2026-09-27 に確認）：

- 4.3 のクライアント向けの API は約 70 ある（[Protocol Guide](https://kafka.apache.org/43/design/protocol/)）。コントローラーの間の API は、クライアント向けのリスナーの ApiVersions に出ない。
- 本家の API の多くは、Authorizer で CLUSTER の資源の権限（ALTER、CLUSTER_ACTION、DESCRIBE など）を確かめ、なければ `CLUSTER_AUTHORIZATION_FAILED` を返す。委任トークンは、無効なら `DELEGATION_TOKEN_AUTH_DISABLED` を返す。
- 名前空間のパッチは、API ごとの資源の名前の場所の表を持つ（[ADR-0004](0004-logical-clusters-on-shared-physical-clusters.md)）。

## Options

1. **拒否をパッチの中で API ごとに書く。** 要求の入口で API のキーを見て、決めたエラーを返す
2. **拒否を Authorizer（差し込み口）で行う。** テナントに CLUSTER の権限を与えないことで、本家の処理の中で本家のエラーを返させる。本家の権限の検査がない場面だけ、ポリシーか本家の無効の設定で拒否する
3. **拒否する API を ApiVersions から外す**

## Decision

2 を採用する。

- API ごとの扱いを「通す・絞る・拒否・フラグ」の 4 つに分けた 1 つの表で持つ。表は名前空間の表と同じ行を持ち、開発リポジトリの spec の正本にする。
- 「拒否」は、Authorizer がテナントの主体に CLUSTER の資源の該当する権限を与えないことで作る。本家の処理が、本家のエラーコードを返す。
- CreateAcls などで本家が CLUSTER の権限を求める API のうち、テナントに使わせるものは、論理クラスタの範囲の中だけで権限を与え、資源の種類を絞る。
- 委任トークンは本家の設定で無効にし、本家の無効の応答を返す。
- 「フラグ」の API（共有のグループ、Streams のグループ）は、本家の機能の無効の設定で閉じる。
- 本家が表にない API・版を広告したら、CI を失敗にする。本番に届いたときは、パッチが `UNSUPPORTED_VERSION` を返してアラートを出す（最後の守り）。
- 1 は、エラーコードを API ごとに手で合わせることになり、本家の版の更新で食い違いやすい。パッチも大きくなる（[ADR-0001](0001-upstream-brokers-and-stack.md) の最小のパッチに反する）。
- 3 は、ADR-0005 が理由を挙げて退けた（起動時に ApiVersions を検査する道具が失敗する）。

## Consequences

- 良くなること：
  - エラーコードが本家と構造的に一致し、差分テストで「許された違い」を少なく保てる。
  - 拒否の大部分がパッチの外（差し込み口）にあり、本家の版の更新の手間が小さい。
- 引き受けるコスト：
  - Authorizer の権限の与え方の誤りが、そのまま管理の API の開放になる。Authorizer の変更は `security:sensitive` にする。
  - 本家が権限の検査の場所を変えると、拒否の振る舞いも変わる。差分テストで検出する。

## Confirmation

- 表駆動テスト：表の各行 × 各版で、テナントの主体からの要求の応答が、表の扱いとエラーコードに一致する。
- CI：本家の ApiVersions の (API, 版) の全てが表にある。
- 差分テスト：拒否した API の応答が、本家で権限のない主体が送ったときの応答と一致する。

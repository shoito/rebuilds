---
status: accepted
date: 2026-09-27
---

# ADR-0030: 判定関数は API の TypeScript に 1 つだけ置き、ポリシーは JSON で表せる allow / deny の規則で書く。Gateway は API が発行する署名付きの能力のチケットで判断する

## Context

権限の判定は、API（TypeScript）、Realtime（TypeScript）、Worker（TypeScript）、Multiplayer Gateway と Document Server（Rust）で要る。[ADR-0005](0005-tenancy-and-document-routing.md) は「判定関数を 1 つにし、API・Gateway・Worker・書き出しが同じ関数を通る」と決めた。

本家は、Ruby の `has_access?` が長く複雑になり、同じ規則をリアルタイムの API（LiveGraph）に別に書いて食い違い、事故と不具合を招いた。権限の判定は DB の読み取りの約 20% を占めた。そこで、AWS IAM に倣った JSON のポリシーの DSL（allow / deny、deny が勝つ、資源の種類、権限、条件）を作り、TypeScript で書いたポリシーを Ruby・TypeScript・Go の評価器で動かした。条件が参照するデータから読み込みを自動で決め、段階に分けて読み、結論が出たら残りを読まないことで、実行時間を半分以下にした。OPA、Zanzibar、Oso も検討した（[How we rolled out our own permissions DSL at Figma](https://www.figma.com/blog/how-we-rolled-out-our-own-permissions-dsl-at-figma/)、2024-03-13、2026-09-27 に確認）。

## Options

判定の置き場所：

1. **API の TypeScript に 1 つだけ置く。Rust の側は、API が発行した署名付きの能力のチケットを使う**
2. **TypeScript と Rust の両方に評価器を置き、同じポリシーを評価する**（本家の形）

ポリシーの書き方：

- a. **JSON で表せる allow / deny の規則と、小さな評価器（本家の形）**
- b. **Cedar**（AWS のポリシー言語。Rust の実装と、npm の WASM の束縛 `@cedar-policy/cedar-wasm` がある。forbid が permit に勝ち、既定で拒否。[Cedar の文書](https://docs.cedarpolicy.com/auth/authorization.html)、2026-09-27 に確認）
- c. **TypeScript の関数（if 文）と決定表のテスト**

## Decision

1 と a を採用する。詳細は [permissions-and-sharing.md](../architecture/permissions-and-sharing.md) の 5 節。

- 判定関数は、`authz` のパッケージに 1 つだけ置く。API・Realtime・Worker は、同じパッケージを呼ぶ。
- ポリシーは TypeScript のデータとして書き、JSON に直列化できる形にする。評価は「deny が 1 つでも真なら Deny、そうでなく allow が 1 つでも真なら Allow、どれも真でなければ Deny」。
- 読み込みは、条件が参照するフィールドから決める。段階 1（ファイル、組織の方針、主体の組織の行、一般アクセス）で Allow が決まれば、段階 2（役割）を読まない。deny の規則は段階 1 のフィールドだけを参照する（lint で強制する）。
- Deny には、真・偽になった規則の ID を付ける。サポート向けのデバッガーに使う。
- Gateway は、API が発行する能力のチケット（Ed25519、60 秒、1 回だけ）で接続を受け入れる。取り消しは [ADR-0031](0031-org-acl-version-and-connection-revalidation.md) の再検証で、API の一括の判定に問い合わせる。Document Server は、Gateway から伝わった接続の水準で書き込みを拒否する。
- 2 を採らない理由：本家が苦しんだ「2 つの言語での食い違い」の危険を、自分から持ち込む。Rust の側で要る判定は「この接続は読めるか、書けるか」だけで、チケットで足りる。
- b を採らない理由：1 を採れば評価する言語は TypeScript だけで、Cedar の利点（言語をまたぐ同じ評価）が効かない。WASM の束縛を Node.js で動かす依存と、Cedar のエンティティの形への変換が増える。段階の読み込みは、Cedar でも自前で作る必要がある。ポリシーが大きく複雑になり、形式的な検証が要るようになったら、b へ移る ADR を書く。
- c を採らない理由：規則ごとの説明（どの規則で拒否したか）と、読み込みの自動の決定と、deny の規則の lint ができない。

## Consequences

- 良くなること：
  - 規則が 1 か所にあり、経路ごとの食い違いが起きない。
  - Rust の側に DB の読み取りと権限の知識を持ち込まない。
  - 拒否の理由を規則の ID で説明できる。
- 引き受けるコスト：
  - 評価器（小さな真偽の論理）と、読み込みの段階の仕組みを自前で持つ。
  - Gateway の接続と取り消しが、API の可用性に依存する。API が止まると新しい接続を開けない。
  - チケットの署名の鍵の管理と入れ替えが要る。

## Confirmation

- 表駆動テスト：permissions-and-sharing.md の 5.3 節の決定表を、ポリシーの JSON を入力にして確かめる。
- 性質ベーステスト：段階 1 で止めた判定と、全部を読んだ判定の結果が一致する。
- lint：deny の規則が段階 2 のフィールドを参照しない。null になりうるフィールドの等価の比較に null の確認がある。`authz` の外で、`resource_roles`・`general_access` を読んで権限を決めるコードを禁止する。
- 結合テスト：改ざん・期限切れ・再使用のチケットで、Gateway が接続を拒否する。

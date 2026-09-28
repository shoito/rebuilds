---
status: accepted
date: 2026-09-28
---

# ADR-0011: ACL は許可の条件と拒否の条件の 2 種の規則で書き、拒否は階層のすべての段で、許可は最も近いクラスの段で評価する。一致する許可がなければ拒否する

詳細は [access-control.md](../architecture/access-control.md) の 3・4・5 節。

## Context

[AGENTS.md](../../AGENTS.md) は、ACL を決定表で書き、既定を拒否にし、判定を 1 つの関数に集めることを求める。条件の列に「継承したクラスの規則」を含める。

本家の ACL は、対象（テーブル・フィールド・レコード）、操作、ロール・条件・スクリプトを持ち、テーブルの規則とフィールドの規則の両方を満たす必要がある。規則の種類は「条件を満たさない限り拒否」と「条件を満たせば許可」の 2 つ。一致する規則がなければ許可する（[Access control list rules](https://www.servicenow.com/docs/bundle/zurich-platform-security/page/administer/contextual-security/concept/exploring-access-control-list.html)、2026-09-28 に確認）。既定の拒否は設定で有効にし、一度変えると戻せない（[Deny by default with empty ACLs](https://www.servicenow.com/docs/bundle/xanadu-platform-security/page/administer/security-center/reference/sc-security-manager-default-deny.html)、2026-09-28 に確認）。規則は、テーブル名、親のテーブル名、`*` の順（フィールドは `テーブル.フィールド`、`親.フィールド`、`*.フィールド`、`テーブル.*`、`親.*`、`*.*` の順）に探す（[ACL rule types](https://www.servicenow.com/docs/bundle/xanadu-platform-security/page/administer/contextual-security/concept/acl-rule-types.html)、2026-09-28 に確認）。

テナントは組み込みのクラス（`task`）を継承した子のクラスを作る（[ADR-0003](0003-table-hierarchy-and-extensible-schema.md)）。親で決めた制限（例：承認の記録は本人だけが書ける）が、子のクラスで外れてはいけない。

## Options

### 既定

1. **常に拒否。設定で変えられない**
2. 本家と同じく既定は許可、設定で拒否に変える

### 階層の扱い

- a. **拒否の条件はすべての段、許可の条件は最も近い段の集合**
- b. すべての段の規則を合わせて、どれか 1 つの許可で通す
- c. 最も近い段の規則だけを使う（拒否も許可も）

### ロールの継承

- x. **ロールは含む関係とグループのロールで継承する。親のグループのロールは子のグループに継承しない**
- y. 親のグループのロールも継承する

## Decision

1、a、x を採用する。

- 規則は `effect`（`allow_if` / `deny_unless`）、`roles`（どれか 1 つ）、`condition`（式の言語）、`admin_override` を持つ。
- 行の判定：全段の `deny_unless` をすべて満たし、かつ最も近い `allow_if` の段の規則のどれかを満たすと許可。`allow_if` がどの段にもなければ拒否。
- フィールドの判定：行の判定が許可で、フィールド（f と `*`）の `deny_unless` をすべて満たし、最も近い段の f の `allow_if`（なければ `*` の `allow_if`）のどれかを満たすと許可。フィールドの `allow_if` がなければ行に従う。
- 条件の評価の失敗は「満たさない」。
- 組み込みの `deny_unless` の規則は無効にできず、`admin_override` も効かない。
- `tenant_admin` は `acl_admin` を含まない。`acl_admin` と `impersonator` は昇格が要る。

2 を採らない理由：テナントが作ったテーブルが、規則を足し忘れると全員に読める。3 万テナントの設定の誤りを、既定で安全な側に倒す。

b を採らない理由：子のクラスで狭めたい許可（例：施設の依頼は施設のグループだけ）が、親の広い許可（`task` は担当者なら読める）で通ってしまう。

c を採らない理由：子のクラスを作るだけで、親の拒否の条件（承認・監査の保護）から逃げられる。

y を採らない理由：組織の付け替えで、権限が黙って広がる。

## Consequences

- 良くなること：
  - 規則の足し忘れは「見えない」で現れ、「漏れる」では現れない。
  - 親の保護は子のクラスでも効く。
- 引き受けるコスト：
  - テナントのテーブルを作った直後は、規則を足すまで管理者以外が読めない。作成の画面で、既定の規則（作成者のグループが読み書きできる）を一緒に作る選択肢を出す。
  - 本家に慣れた管理者は、既定の許可を前提に規則を書く。移行の資料で違いを示す。

## Confirmation

- 決定表 DT-ACL-001・002 の全組み合わせのテスト（最後の行の既定の拒否を含む）。
- 性質ベーステスト PROP-ACL-001（既定の拒否）、PROP-ACL-002（拒否の単調）。
- ロールの含む関係の循環と深さの検査（保存の時）。

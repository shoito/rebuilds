---
status: accepted
date: 2026-09-28
---

# ADR-0024: 変更は種類ごとの状態のモデルで扱い、リスクは規則と質問票の高いほうにする。承認の方針は種類 × リスクの決定表で決め、CAB の決定も各承認者の回答として反映する。緊急の変更も承認なしに実施へ進めない

詳細は [itsm-processes.md](../architecture/itsm-processes.md) の 8 節。

## Context

[intent.md](../intent.md) は、変更の記録が承認のないまま「実施」に進まないこと、緊急の変更は事後の承認の記録を必須にすることを求める。顧客は変更の承認を J-SOX の証跡として使う。

本家の変更は、通常・標準・緊急の種類ごとに状態の進みが違う。通常は評価と承認、緊急は承認、標準は承認なしで予定済みへ進む（[State progression for change models](https://www.servicenow.com/docs/r/it-service-management/change-management/normal-standard-emergency-states.html)、2026-09-28 に確認）。標準の変更は、変更管理のチームが承認した雛形から作る（[Propose a standard change template](https://www.servicenow.com/docs/bundle/xanadu-it-service-management/page/product/change-management/task/propose-standard-chg-template.html)、検索の結果の抜粋で確認）。リスクは質問票と規則の条件で求め、両方があると条件が優先するとされる（コミュニティの記事と KB0825522 の抜粋。未検証）。CAB の作業台は、議題・時間・出席者・決定の記録を扱う（[CAB meeting management using the CAB workbench](https://www.servicenow.com/docs/r/it-service-management/change-management/manage-cab-meeting-using-cab-workbench.html)、2026-09-28 に確認）。ITIL 4 は、変更の実現のプラクティスで同じ 3 種を示す（[Change Enablement in ITIL 4](https://itsm.tools/change-enablement/)、二次の資料。原典は未検証）。

## Options

### リスク

1. **規則と質問票の高いほう**
2. 規則が優先（本家に寄せる）
3. 質問票だけ

### CAB の決定の反映

- a. **各承認者が自分の承認の行に回答する。会議はその場と記録**
- b. CAB の管理者が会議の決定として、まとめて承認済みにする

### 緊急の変更

- x. **ECAB の 1 人以上の承認で実施へ進め、事後の CAB の承認を完了の条件にする**
- y. 承認なしで実施へ進め、事後の承認だけを求める

## Decision

1、a、x を採用する。

- 状態：通常 `new → assess → authorize → scheduled → implement → review → closed`、標準 `new → scheduled → …`、緊急 `new → authorize → scheduled → …`。`review` と `closed` からは取り消せない。
- どの種類も、承認のまとまりが `approved` にならないと `scheduled` を通れない。標準は、雛形の版の承認をその変更の承認とみなす。承認の後に予定・CI を変えるときは `reschedule` で承認を取り直す。
- 承認の方針は DT-CHG-002（種類 × リスク → 段、承認者、規則、期限切れの動作）で決め、組み込みのフロー `change_approval_policy` で依頼する。段を「なし」にできるのは標準だけ。依頼者・担当者は承認者から除く。
- 標準の変更の雛形は版を持ち、版の承認を `change_manager` のグループで行う。承認済みの版は変えない。
- CAB の会議（定義、会議、議題）は、議題の作成と議事の記録を担う。承認の反映は、各承認者の回答（`channel = cab_meeting`）で行う。
- 緊急の変更は、ECAB の 1 人の承認で `scheduled` へ進み、`review` から `closed` へは事後の CAB の承認を要る。
- 機械学習によるリスクの予測は MVP に入れない。

2 を採らない理由：規則が「低」、質問票が「高」のとき、低い側を採ると承認の段が軽くなる。どちらかが高いと言えば高く扱うほうが、監査で説明しやすい。

3 を採らない理由：CI の重要度や過去の失敗など、回答者の判断に頼らない材料を使えない。

b を採らない理由：承認の証跡が「管理者がまとめて押した」になり、誰が承認したかを示せない。代理・成り代わり・本人の承認の禁止の規則（[ADR-0016](0016-approvals.md)）も効かなくなる。

y を採らない理由：[intent.md](../intent.md) の「承認のないまま実施に進まない」に反する。緊急でも 1 人の承認は数分で取れる（ECAB は当番の呼び出しで集める）。

## Consequences

- 良くなること：
  - 「承認なしに実施しない」を遷移の表の上の性質として確かめられる。
  - CAB の決定の証跡が、承認者本人の回答として残る。
- 引き受けるコスト：
  - 会議の場で各承認者が回答する手間がある。会議の画面から自分の承認に 1 回の操作で答えられるようにする。
  - 夜中の緊急の変更で ECAB の 1 人を呼ぶ運用が要る（[assignment-and-on-call.md](../architecture/assignment-and-on-call.md) の当番）。

## Confirmation

- 決定表 DT-CHG-001、DT-CHG-002、DT-RISK-001。
- 性質ベーステスト PROP-CHG-001（承認なしに実施しない）、PROP-CHG-002（予定の固定）。
- 本番の突き合わせのジョブ：承認の決着のない `implement` への遷移を日次に数え、0 件でなければ SEV2。

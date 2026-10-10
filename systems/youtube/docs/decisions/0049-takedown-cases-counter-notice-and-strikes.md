---
status: accepted
date: 2026-10-10
---

# ADR-0049: 削除の申出は `copyright_cases` で受け、期限・基準・通知の文は AppConfig の `legal.copyright.*` に置く。反論の通知と復元は設定で切り替えられる形で作って既定は無効にし、著作権の strike は削除した動画ごとに 1 つ出すよう accounts-and-safety の領域に頼む

## Context

- 削除の申出への対応（情報流通プラットフォーム対処法）、異議と復元（米国の DMCA の反論の通知に当たる手続きを日本で持つか）、繰り返しの侵害への措置は、**法務の確認待ち：L1・L2**（[intent.md](../intent.md)）。
- 本家は、削除した動画ごとに違反の記録を 1 つ付け、学びの課程を済ませると 90 日で消え、90 日に 3 つでチャンネルが停止されうる。予定の削除は 7 日の間に自分で消せば記録が付かない（[Copyright strike basics](https://support.google.com/youtube/answer/2814000)、2026-10-10 に確認）。米国の反論の通知は 10 営業日（[Submit a copyright counter notification](https://support.google.com/youtube/answer/2807684)、同）。
- strike の記録・数え方・効き目とアカウントの状態は accounts-and-safety の領域で決める（ADR-0061、[accounts-and-safety.md](../architecture/accounts-and-safety.md) の 9 節）。
- X の題材は、法令の案件を通報と別の表で持ち、期限・基準・通知の文を AppConfig に置いた（[X の ADR-0041](../../../x/docs/decisions/0041-legal-requests-and-transparency.md)）。

## Options

1. **案件の表と設定の値で枠組みを作り、法務の確認の後に値を入れる。反論の通知は既定で無効**
2. 本家の米国の手続きをそのまま作る
3. 法務の確認まで作らない

## Decision

1 を採用する。詳細は [copyright-claims-and-disputes.md](../architecture/copyright-claims-and-disputes.md) の 8 節。

- 削除の申出：権利者の画面と誰でも使える窓口から `copyright_cases` を作る。状態 `received → validating → reviewing → decided（removed・rejected）`、`withdrawn`。期限を受け付けの時刻から計算して持ち、48 時間前・24 時間前に警告する。審査は侵害情報調査専門員の役割。削除は措置の記録を書いてから効かせる。
- 反論の通知：`counter_notices` と `legal.copyright.counter.enabled`（既定 `false`）、`legal.copyright.counter.wait_business_days`。
- 著作権の strike：削除の申出で動画を削除したとき、動画ごとに 1 つ出すよう outbox の `copyright_strike_requested` で accounts-and-safety の領域に頼む。予定の削除は 7 日の間に創作者が消せば出さない。取り下げ・復元は `copyright_strike_retracted`。照合の申し立てでは出さない。研修と 90 日の失効、効き目、3 つの扱いはその領域（ADR-0061）。
- 確認が済むまで E8 の `takedown-requests`・`counter-notices-and-strikes` の spec を承認しない。

### 他の案を選ばなかった理由

- **2（米国の手続きをそのまま）**：日本の法令の上の位置づけが決まっておらず、法令の判断を設計に書くことになる。
- **3（作らない）**：権利者の削除の申出を受ける口がなく、GA（E15）の前に作る時間が足りなくなる。

## Consequences

- 良くなること：
  - 法務の結論がどうであっても、値と有効の切り替えで合わせられる。
  - 期限の管理と監査が、X の題材と同じ形になる。
- 引き受けるコスト：
  - 使わないかもしれない反論の通知の経路を作り、試験する。

## Confirmation

- PROP-CLM-006。
- 表駆動テスト：`legal.copyright.*` の値を変えても、期限と警告が値どおりに計算される。

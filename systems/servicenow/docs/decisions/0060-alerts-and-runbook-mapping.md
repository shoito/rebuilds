---
status: accepted
date: 2026-09-28
---

# ADR-0060: 呼び出しのアラートは SLO のバーンレート、正しさの監視の違反、セキュリティの症状に限り、すべてのアラートに runbook を注釈で持たせて CI で確かめる。個別の runbook ができるまでは incident-response の場面を指す

詳細は [observability.md](../architecture/observability.md) の 7 節。

## Context

各領域の文書は、quality・runbooks の項目として、合わせて 40 近い個別の runbook の名前を挙げた（`timer-lag.md`、`mail-loop-detected.md`、`cmdb-wrong-merge.md` など）。runbook は Ops の持ち物で、各 Epic で作る（[process.md](../../../../docs/process.md) の 11 節）。MVP の初めには、ほとんどがまだない。

他の題材は、すべてのアラートが runbook の URL を注釈に持つことを CI で確かめ、呼び出しを SLO とセキュリティの症状に限っている（Auth0 の observability.md の 5 節）。

## Options

### 呼び出しの範囲

1. **SLO のバーンレート、正しさの監視（0 件の約束）の違反、セキュリティの症状**
2. 原因の指標（CPU、接続数、キュー）も呼び出す

### runbook の対応

- a. **すべてのアラートに runbook の注釈を必須にし、個別のものがなければ incident-response の場面を指す**
- b. 個別の runbook ができたアラートだけを有効にする

## Decision

1 と a を採用する。

- 呼び出し：可用性の速いバーンレート（セル別）、合成監視の連続失敗、タイマーの遅れ（優先度 0 の p99 60 秒、期限を過ぎた未発火の違反）、承認なしの実施、監査の鎖の食い違い、本番の漏れの合成監視、ACL の規則のコンパイルの失敗、メールの取り込みの遅れ・DLQ、送信の評判、outbox の遅れ、DR の複製の遅れ、デプロイ中のロールバックとフラグのガード、秘密の形のログ、セキュリティの仕組みの停止。
- チケット：原因の指標、止まった実行の 1 件、重複の CI、索引の遅れ（5 分未満）、レポートの reader の飽和など。
- incident-response の runbook に、個別の runbook がまだない重い場面（タイマーの遅れ、ACL の漏れの疑い、メールのループ、CMDB の誤った統合）の手順を持たせる。個別の runbook ができたら、アラートの注釈をそちらに替える。
- アラートの一覧の正本は `runbooks/README.md`（Ops、統合で作る）。この ADR と observability の表は案。

2 を採らない理由：原因の指標は、利用者への影響がなくても鳴り、夜中の呼び出しを増やす。タイマーの遅れのように影響に近い指標で呼び出せば足りる。

b を採らない理由：MVP の初めに、大事なアラート（承認なしの実施、漏れの合成監視）が、runbook がないという理由で無効になる。

## Consequences

- 良くなること：
  - どのアラートにも、最初に開く手順がある。
  - incident-response が、個別の runbook ができるまでの受け皿になる。
- 引き受けるコスト：
  - incident-response が大きくなる。個別の runbook ができたら、場面を移して短くする。
  - アラートの値は案で、運用の最初の 3 か月で調整する。

## Confirmation

- CI：アラートのルールのファイルで、すべてのルールが `runbook_url` の注釈を持ち、その URL の runbook がリポジトリにある。
- 四半期：アラートごとの鳴った回数と、対応が要らなかった割合を見直す。

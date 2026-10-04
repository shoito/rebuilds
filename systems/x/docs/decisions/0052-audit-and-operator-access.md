---
status: accepted
date: 2026-10-04
---

# ADR-0052: 監査ログは DB の追記だけの表と log-archive の Object Lock の 2 か所に書く。本番のデータへの人の常時のアクセスを置かず、読み出しは理由を必須にしたロールと 2 人の承認の break-glass だけにする

## Context

- T&S の担当（社員と委託先）は、通報・措置・申出・開示の請求で、利用者のデータを読む。運用と T&S の読み出しは RLS を通さない代わりに、理由（案件の ID）を必ず記録する（[ADR-0004](0004-single-tenant-and-visibility.md)）。
- 開示・保全の手続き（法務の L2・L7）では、誰が、いつ、何を、なぜ読んだかを後で示す必要がある。
- DM の中身を人が読む手順は、法務の L3 が済むまで作らない（AGENTS.md）。

## Options

1. **追記だけの DB の表に書き、同じ内容を outbox から Firehose で log-archive の S3（Object Lock）へ写す。人の常時のアクセスなし、理由の必須のロールと break-glass**
2. アプリのログ（CloudWatch Logs）に監査の行を書く
3. DB の監査の拡張（pgAudit）だけ

## Decision

1 を採用する。詳細は [security.md](../architecture/security.md) の 6 節。

- `audit_events` は UPDATE・DELETE をトリガーで拒む。中身（本文、連絡先）は入れず、主体・操作・対象・理由の案件の ID・結果を持つ。
- 同じ行を outbox の `audit` の流れから `audit-sink` が Firehose で log-archive のアカウントの S3（Object Lock のコンプライアンスの形）へ送る（[infrastructure.md](../architecture/infrastructure.md) の 6.1 節）。
- 人の AWS の権限は Identity Center の一時のロールだけ。本番の DB・Valkey・OpenSearch に人の常時のアクセスを置かない。
- T&S のコンソールの読み出しは `ts_reader` のロールで、案件の ID のない読み出しの API を作らない。読める範囲は案件の種類で決める。
- break-glass：2 人の承認、4 時間、セッションの記録、24 時間以内の振り返り。
- DM の中身を人が読む画面は作らない（L3 の確認待ち）。
- 週ごとに、T&S の読み出しの 1% をセキュリティの担当が点検する。
- 2 を採らない理由：ログは 30 日で消え、書き換えへの備えもない。中身を出さない規則（ログ）と、監査の記録の目的が混ざる。
- 3 を採らない理由：DB の命令の単位で、案件の理由と結び付かない。DB の外の操作（コンソール、鍵、設定）を残せない。

## Consequences

- 良くなること：
  - 読み出しの理由を後から示せる。DB の行が消されても log-archive に残る。
- 引き受けるコスト：
  - 調査の手間（DB を直接見られない）。中身を出さないメトリクスとトレースでの調査に慣れる必要がある。
  - `audit` の流れの運用。

## Confirmation

- 性質ベーステスト：PROP-SEC-002（`audit_events` の行は消えず、変わらない）。
- 結合テスト：案件の ID のない `ts_reader` の読み出しが失敗する。
- 本番：break-glass の使用を呼び出しにし、振り返りの有無を確かめる。四半期に、IAM の常時の権限が人にないことを確かめる。

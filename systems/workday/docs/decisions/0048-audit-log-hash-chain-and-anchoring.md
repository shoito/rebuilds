---
status: accepted
date: 2026-09-28
---

# ADR-0048: 監査ログを同じトランザクションで追記し、安定の境界の後にテナントごとの連鎖のセグメントにして Object Lock に置き、日ごとに署名する

詳細は [audit-and-retention.md](../architecture/audit-and-retention.md) の 3・4 節。

## Context

- NFR-010 は、人事・給与・権限のすべての変更に変更者・時刻・前後の値・案件を残し、監査ログの改ざんを検知できることを求める。
- 変更の前後の値は、有効日付の差分と版（[ADR-0002](0002-effective-dated-data-model.md)）と業務プロセスのイベント（[ADR-0003](0003-business-process-engine.md)）に残る。権限・閲覧・出力・認証の事象は、それとは別に記録が要る（[ADR-0020](0020-sensitive-read-audit-and-access-explanations.md)）。
- 他の題材（Slack、Stripe、Auth0 の ADR-0054）は、操作と同じトランザクションで監査の表に書き、log-archive の Object Lock へハッシュの連鎖で送る。
- 連鎖を書き込みの時点で作ると、テナントの全書き込みが 1 つの直列の点を通る（[ADR-0008](0008-point-in-time-queries-and-activation-timers.md) の 2 を採らなかった理由と同じ）。
- 改ざんの検知の専用の台帳のサービス（Amazon QLDB）は、2025 年 7 月 31 日にサポートが終わった（[AWS のブログ](https://aws.amazon.com/jp/blogs/news/migration-from-amazon-qldb/)、2026-09-28 に検索の要約で確認）。
- S3 Object Lock のコンプライアンスモードは、根のユーザーを含め、期間の間は消せず、期間を短くできない（[S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)、2026-09-28 に確認）。

## Options

1. **同じトランザクションで Aurora の追記のみの表に書き、書き出しの処理が安定の境界（10 秒）の後に、テナントごとに id の順でセグメントにして連鎖を作り、log-archive のコンプライアンスモードの Object Lock に置く。日ごとに連鎖の頭の Merkle 根を KMS の非対称の鍵で署名する**
2. 書き込みの時点で、テナントごとの前の行のハッシュを取って連鎖にする
3. 台帳の専用のデータベース（QLDB は終了済み。他の製品）を使う
4. CloudTrail とアプリのログだけで追う

## Decision

1 を採用する。

- `audit_events`（テナント）と `platform_audit_events`（RLS の外）は、アプリのロールに `INSERT` だけを与える。閲覧の記録は、応答を返す前に書き、書けなければ返さない。
- 記録に個人情報の値を入れない。ID と理由のコードと許可リストの `details` だけ。
- 書き出しは 1 分ごと。書き込みのトランザクションは 5 秒で打ち切るので、10 秒の境界の後に古い行は現れない。境界の後に見つかった行は「遅れの行」として次のセグメントに入れる。
- 日次の検証：セグメントの連鎖、日の署名、Aurora の行とセグメントの突き合わせ。失敗は SEV2。
- 保管庫の `mn_access_log`（[ADR-0046](0046-purpose-bound-vault-api-and-access-log.md)）も同じ形。
- テナントは自分の日の連鎖の頭を取り出して手元に残せる。
- 2 を採らない理由：テナントのすべての監査の書き込みが 1 行のロックで直列になり、閲覧の記録（S1 で 1 日数百万件）で詰まる。
- 3 を採らない理由：QLDB は終了した。他の台帳の製品は、正本の Aurora と別の書き込みの経路（2 相の整合）を持つことになる。
- 4 を採らない理由：テナントの中の操作（誰がどの従業員の給与を見たか）が CloudTrail に出ない。

## Consequences

- 良くなること：
  - 監査の記録の欠けがない（操作と同じトランザクション）。
  - DB の行の書き換え・削除を、保管との突き合わせで検知できる。保管の書き換えは Object Lock で防ぎ、連鎖と署名で検知できる。
- 引き受けるコスト：
  - 書き出しの前の 10 秒〜数分の間の行は、DB の中にだけある。この間の DB の改ざんは、書き出しの時点で連鎖に取り込まれてしまう。DB の書き込みの権限を絞ることで抑える。
  - セグメントの物体が多い。単位（1 分か 1 時間か）は E11 で測って決める。
  - `audit-anchor` の鍵の管理が要る（[ADR-0052](0052-kms-key-hierarchy.md)）。

## Confirmation

- 性質ベーステスト：PROP-AUD-001（同じトランザクション）、PROP-AUD-002（連鎖と集合の一致）、PROP-AUD-003（1 行の改ざんの検出）、PROP-AUD-004（値を入れない）。
- DB の権限の検査：アプリのロールで `audit_events` への `UPDATE`・`DELETE` が失敗する。
- 本番：日次の検証の失敗 0 件。四半期ごとに、別の道具で任意の日を検証する訓練。

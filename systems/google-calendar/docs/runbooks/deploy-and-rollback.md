# Runbook: デプロイとロールバック

- Owner: Ops
- 対応するアラート: デプロイ中の自動ロールバック、Web のクライアントの段階の止める条件（[README.md](README.md) の 4 節）
- 最終確認日: 2026-10-04

方針の正本は [README.md](README.md) の 3 節、仕組みは [delivery.md](../architecture/delivery.md) の 4・5 節にある。

## 症状

- ECS のデプロイのサーキットブレーカー、またはアラーム（5xx、書き込みの p99、4xx の率、展開の索引の照合の不一致、CalDAV の 4xx の急な上がり）で、自動のロールバックが起きた。
- Web のクライアントの段階の止める条件（JavaScript のエラーの率 2 倍など）に当たった。
- デプロイの後に、照合・応答の監査・合成監視で異常が出た。

## 影響

デプロイの途中の新旧の版の混在。予定の読み書きの SLO、展開の正しさ、権限の分離を消費しうる。

## 確認

1. どのサービスのどの版か。デプロイの順（マイグレーション → api・caldav・booking・auth → relay → worker-* → realtime → Web の資産）のどこで止まったか。
2. 自動のロールバックの理由のアラームと、新旧の版での指標の比べ。
3. 同じリリースに、マイグレーションの縮める・消す段が入っていないか（入っていれば、前の版へ戻せない。CI で 1 つの PR に入らないことを確かめているが、リリースの束で確かめる）。
4. 展開・時刻・権限のパッケージ（`packages/recurrence`・`tz`・`tzdata`・`policy`・`writer`）の変更が入っているか。

## 対処

### サーバー

1. 未完成の振る舞いが原因なら、`release.*` のフラグを戻す。
2. それ以外は 1 つ前のイメージへ戻す。マイグレーションは広げる段だけなので、前の版が今の DB で動く。
3. **展開・時刻・権限の規則の不具合**はフラグで戻さない。前のイメージへ戻し、次を行う：
   - 展開（`expand()`）：新しい版で書いた期間の展開の索引を、`expander` が前の版の `expand()` で作り直す（照合の不一致が 0 に戻るまで見る）。
   - 権限（`redact()`・`can()`）：戻す前に、漏れている経路を `ops.*` で止める（検索、ICS の公開、Webhook など）。漏れの範囲は `access-leak-response.md`（予定）と [incident-response.md](incident-response.md)。
   - 時刻（`resolve()`）：AppConfig の `tzdata.active_version` が原因なら [tzdb-update.md](tzdb-update.md) の戻し。
4. `worker-reminder-scheduler`・`worker-notifier` の戻しも、毎時 05〜15 分・35〜45 分に始める。集中の時間帯に入ったら待つ。

### Web のクライアント

1. CloudFront KeyValueStore の版ごとの割合で、新しい版を 0% にする。開いたままのタブは、次の起動で前の版の殻を使う。
2. 最低の版（`<Brand>-Client-Min`）を上げていたら、前の値に戻す。
3. 手元の DB の版（`cache_schema`）を変えていた版は、戻すと手元の DB を作り直す（捨ててよい写し。失うものはない）。

### マイグレーション

- 縮める段の後は前の版へ戻さない。前へ進めて直す。
- 展開の索引の形の変更は影の表で行うので、読み出しの切り替えを戻すだけで済む（[ADR-0049](../decisions/0049-tzdata-rollout-and-schema-change-ordering.md)）。

## リリースの前

- CalDAV・招待に触れたリリースは、相互運用の手動の確認の表（K9。[delivery.md](../architecture/delivery.md) の 2.3 節の段 3）を通す。
- エラーバジェットの残りと、凍結の時間帯（[README.md](README.md) の 3.1 節）を確かめる。

## エスカレーション

- 自動のロールバックが 2 回続いた、または戻しても指標が戻らない：テックリードと Ops の責任者。
- 権限の漏れの疑い：SEV1 として [incident-response.md](incident-response.md)。

## 事後

- 調査結果を `changes/` の新しい `intent.md` として起票する（Maintain 段）。
- 自動のロールバックの条件に足りないものがあれば、[delivery.md](../architecture/delivery.md) の 4 節への変更を起票する。
